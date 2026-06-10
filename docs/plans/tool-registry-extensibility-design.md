# Tool Auto-Discovery 设计

> 状态：提案  
> 日期：2026-06-10  
> 目标：开发者加新工具不碰任何源码，框架自动注册  
> 核心原则：兼容现有全部三种工具形态

---

## 开发者视角

### 加一个独立工具：1 个文件
```
~/.imtoagent/tools/weather.ts  →  export default ToolDefinition
```

### 加一组相关工具（工厂）：1 个子目录
```
~/.imtoagent/tools/task-tools/
├── index.ts        →  export function createTaskTools(): ToolDefinition[]
├── list.ts         →  具体实现
├── update.ts
├── history.ts
└── run.ts
```

### 加多个无关工具在一个文件里：1 个文件
```
~/.imtoagent/tools/condition-tools.ts  →  export function createConditionTools(): ToolDefinition[]
```

开发者按需选形态，框架都能识别。

---

## 三种工具形态

### 形态 1：独立工具（单文件，单个工具）

```typescript
// weather.ts
export const weatherTool: ToolDefinition = {
  name: 'get_weather',
  description: '查询城市天气',
  parameters: { ... },
  handler: async (params) => { ... },
};
export default weatherTool;
```

**框架识别规则**：模块导出包含 `ToolDefinition` 对象（有 `name` 和 `handler`）

### 形态 2：工厂函数（单文件，多个工具）

```typescript
// condition-tools.ts
export function createConditionTools(deps: { goalManager: GoalManager }): ToolDefinition[] {
  return [
    { name: 'imtoagent_check_condition', handler: () => ..., ... },
    { name: 'imtoagent_wait_until', handler: () => ..., ... },
  ];
}
```

**框架识别规则**：模块导出包含一个函数（typeof === 'function'），调用后返回 `ToolDefinition[]`

### 形态 3：目录工厂（子目录，多个工具拆分）

```
tools/task-tools/
├── index.ts     →  export function createTaskTools(taskManager): ToolDefinition[]
├── list.ts      →  export const listTask = { name: 'imtoagent_list_tasks', ... }
├── update.ts    →  export const updateTask = { name: 'imtoagent_update_task', ... }
├── history.ts   →  ...
└── run.ts       →  ...
```

```typescript
// task-tools/index.ts
import { listTask } from './list';
import { updateTask } from './update';
import { historyTask } from './history';
import { runTask } from './run';

export function createTaskTools(taskManager: TaskManager): ToolDefinition[] {
  return [listTask, updateTask, historyTask, runTask].map(tool => ({
    ...tool,
    handler: (...args) => tool.handler(taskManager, ...args),
  }));
}
```

**框架识别规则**：目录中存在 `index.ts` → 当作目录工厂加载

---

## 框架侧实现

### 1. 发现引擎：`modules/core/tool-discovery.ts`（新建）

```typescript
import * as fs from 'fs';
import * as path from 'path';
import type { ToolDefinition } from '../agent/tool-registry';

export interface DiscoveredTool {
  name: string;
  definition: ToolDefinition;
  sourceFile: string;
  sourceType: 'single' | 'factory' | 'directory';
}

interface ToolLoadContext {
  /** 框架启动时传入的依赖注入 */
  deps: Record<string, unknown>;
}

/**
 * 统一工具发现入口
 * 
 * 扫描规则（优先级从高到低）：
 * 1. 用户自定义工具目录 ~/.imtoagent/tools/
 * 2. 内置工具目录 modules/tools/
 * 
 * 每个目录下：
 * - 有 index.ts 的子目录 → 目录工厂（形态 3）
 * - 导出函数的 .ts 文件 → 工厂函数（形态 2）
 * - 导出 ToolDefinition 的 .ts 文件 → 独立工具（形态 1）
 */
export async function discoverTools(
  dirs: string[],
  context?: ToolLoadContext,
): Promise<DiscoveredTool[]> {
  const discovered: DiscoveredTool[] = [];

  for (const dir of dirs) {
    if (!fs.existsSync(dir)) continue;

    const entries = fs.readdirSync(dir, { withFileTypes: true });

    for (const entry of entries) {
      const entryPath = path.join(dir, entry.name);

      // ---- 形态 3：目录工厂 ----
      if (entry.isDirectory()) {
        const indexPath = path.join(entryPath, 'index.ts');
        if (fs.existsSync(indexPath)) {
          const tools = await loadDirectoryFactory(entryPath, indexPath, entry.name, context);
          discovered.push(...tools);
        }
        continue;
      }

      // ---- 跳过非 .ts 文件 ----
      if (!entry.name.endsWith('.ts')) continue;
      // 跳过辅助文件（非入口）
      if (entry.name.startsWith('_') || entry.name.includes('.test.')) continue;

      try {
        const mod = await import(indexPath);

        const tools = classifyAndLoad(entry.name, mod, entryPath, context);
        discovered.push(...tools);
      } catch (err) {
        console.error(`[ToolDiscovery] ❌ ${entry.name}: ${(err as Error).message}`);
      }
    }
  }

  return discovered;
}

/**
 * 分类模块导出，判断属于哪种形态
 */
function classifyAndLoad(
  fileName: string,
  mod: Record<string, unknown>,
  filePath: string,
  context?: ToolLoadContext,
): DiscoveredTool[] {
  // ---- 形态 2：工厂函数 ----
  const factoryFn = findFactoryFunction(mod);
  if (factoryFn) {
    const tools = callFactory(factoryFn, context, fileName);
    return tools.map(t => ({
      name: t.name,
      definition: t,
      sourceFile: filePath,
      sourceType: 'factory' as const,
    }));
  }

  // ---- 形态 1：独立工具 ----
  const def = findToolDefinition(mod);
  if (def) {
    return [{
      name: def.name,
      definition: def,
      sourceFile: filePath,
      sourceType: 'single' as const,
    }];
  }

  console.warn(`[ToolDiscovery] ⚠️  ${fileName}: 未识别的工具形态`);
  return [];
}

/**
 * 在模块导出中查找工厂函数
 * 优先级：export default function → export function createXxx() → 第一个函数
 */
function findFactoryFunction(mod: Record<string, unknown>): Function | null {
  // 优先：export default 是函数
  if (typeof mod.default === 'function') return mod.default;

  // 其次：查找命名工厂函数（createXxx / initXxx / registerXxx）
  for (const [key, val] of Object.entries(mod)) {
    if (key === 'default') continue;
    if (typeof val === 'function' && (
      key.startsWith('create') || key.startsWith('init') || key.startsWith('register')
    )) {
      return val;
    }
  }

  return null;
}

/**
 * 在模块导出中查找 ToolDefinition
 * 优先级：export default → export const tool / xxxTool / xxxToolDef
 */
function findToolDefinition(mod: Record<string, unknown>): ToolDefinition | null {
  if (isToolDefinition(mod.default)) return mod.default;

  for (const [key, val] of Object.entries(mod)) {
    if (key === 'default') continue;
    if (isToolDefinition(val)) return val;
  }

  return null;
}

/**
 * 调用工厂函数，自动注入依赖
 */
function callFactory(
  fn: Function,
  context?: ToolLoadContext,
  fileName?: string,
): ToolDefinition[] {
  // 工厂函数如果声明参数，尝试从 context.deps 注入
  const paramCount = fn.length; // 函数声明的参数个数
  const deps = context?.deps || {};

  let result: unknown;
  if (paramCount > 0) {
    // 有参数 → 需要依赖注入
    const args = buildFactoryArgs(fn, deps, fileName);
    result = fn(...args);
  } else {
    result = fn();
  }

  if (!Array.isArray(result)) {
    console.warn(`[ToolDiscovery] ⚠️  工厂函数返回值不是数组`);
    return [];
  }

  return result.filter(isToolDefinition);
}

/**
 * 加载目录工厂
 */
async function loadDirectoryFactory(
  dirPath: string,
  indexPath: string,
  dirName: string,
  context?: ToolLoadContext,
): Promise<DiscoveredTool[]> {
  try {
    const mod = await import(indexPath);
    const factoryFn = findFactoryFunction(mod);

    if (factoryFn) {
      const tools = callFactory(factoryFn, context, dirName);
      return tools.map(t => ({
        name: t.name,
        definition: t,
        sourceFile: indexPath,
        sourceType: 'directory' as const,
      }));
    }

    // 目录中没有工厂函数，尝试收集所有 ToolDefinition
    const tools: DiscoveredTool[] = [];
    for (const file of fs.readdirSync(dirPath).filter(f => f.endsWith('.ts') && f !== 'index.ts')) {
      const fileMod = await import(path.join(dirPath, file));
      const def = findToolDefinition(fileMod);
      if (def) {
        tools.push({
          name: def.name,
          definition: def,
          sourceFile: path.join(dirPath, file),
          sourceType: 'directory' as const,
        });
      }
    }
    return tools;
  } catch (err) {
    console.error(`[ToolDiscovery] ❌ 目录工厂 ${dirName}: ${(err as Error).message}`);
    return [];
  }
}

/**
 * 根据工厂函数的参数签名，从 deps 中构建参数
 */
function buildFactoryArgs(fn: Function, deps: Record<string, unknown>, fileName?: string): unknown[] {
  // v1 简化：按参数名匹配 deps（需要函数参数有明确命名）
  // v2 可以改用参数类型推断或显式 deps 声明
  const paramNames = getParamNames(fn);
  return paramNames.map(name => {
    if (deps[name]) return deps[name];
    console.warn(`[ToolDiscovery] ⚠️  ${fileName}: 依赖 "${name}" 未注入，传 undefined`);
    return undefined;
  });
}

/**
 * 获取函数参数名（通过 toString）
 */
function getParamNames(fn: Function): string[] {
  const str = fn.toString();
  const match = str.match(/\(([^)]*)\)/);
  if (!match || !match[1].trim()) return [];
  return match[1].split(',').map(p => {
    // 处理解构参数、类型注解：{ taskManager }: { taskManager: TaskManager }
    const cleaned = p.trim().replace(/:.*$/, '').replace(/[{}]/g, '').trim();
    return cleaned;
  }).filter(Boolean);
}

function isToolDefinition(obj: unknown): obj is ToolDefinition {
  if (!obj || typeof obj !== 'object') return false;
  const t = obj as Record<string, unknown>;
  return typeof t.name === 'string' && typeof t.handler === 'function';
}
```

### 2. 内置工具目录结构

```
modules/tools/
├── weather.ts                    ← 形态 1：独立工具
├── condition-tools.ts            ← 形态 2：工厂函数（多工具单文件）
├── task-tools/                   ← 形态 3：目录工厂
│   ├── index.ts                  ←   createTaskTools(taskManager)
│   ├── list.ts
│   ├── update.ts
│   ├── history.ts
│   └── run.ts
└── goal-task-tools/              ← 形态 3：目录工厂
    ├── index.ts                  ←   createGoalTools(goalManager, goalStore, resolveChatId)
    ├── create.ts
    ├── update.ts
    ├── delete.ts
    └── list.ts
```

> 注意：现有的 `task-tools.ts` 和 `goal-task-tools.ts` 保持原样（形态 2），逐步迁移到形态 3 不需要改框架代码。

### 3. `heartbeat-scheduler.ts` 集成

```typescript
import { discoverTools } from './tool-discovery';

async function autoRegisterTools(toolRegistry: ToolRegistry): Promise<void> {
  // 准备依赖注入上下文
  const deps = {
    taskManager: this.taskManager,
    goalManager: this.goalManager,
    goalStore: this.goalStore,
    resolveChatId: () => this._resolver.getLastActiveChatId(),
  };

  const toolDirs = [
    path.join(__dirname, '../tools'),                    // 内置
    path.join(os.homedir(), '.imtoagent', 'tools'),     // 用户自定义
  ];

  const discovered = await discoverTools(toolDirs, { deps });

  // 去重：用户工具覆盖内置工具
  const byName = new Map<string, DiscoveredTool>();
  for (const t of discovered) {
    byName.set(t.name, t);
  }

  const allTools = Array.from(byName.values()).map(d => d.definition);
  toolRegistry.register(...allTools);
  toolRegistry.injectNeeded(allTools.map(t => t.name));

  console.log(`[ToolDiscovery] ✅ ${allTools.length} 个工具已注册`);
  if (process.env.DEBUG) {
    for (const t of allTools) {
      console.log(`  → ${t.name} (${t.sourceType})`);
    }
  }
}
```

### 4. 拦截层修复

```typescript
// ToolRegistry 新增
isKnown(name: string): boolean {
  return this.registry.has(name) || this.aliases.has(name);
}

// tool-interceptor.ts
export function isLocalTool(name: string, registry?: ToolRegistry): boolean {
  if (registry?.isKnown(name)) return true;
  return name.startsWith('imtoagent_') || name.startsWith('goal_');  // 兜底
}

// 所有调用点改为传入 registry
const hasLocal = hasLocalTool(chatReq.tools, interceptRegistry);
```

---

## 开发者体验对比

### 现在
```
1. 写 modules/tools/foo.ts
2. 改 heartbeat-scheduler.ts → import
3. 改 heartbeat-scheduler.ts → register()
4. 改 heartbeat-scheduler.ts → injectNeeded()
5. 可能需要改 tool-interceptor.ts
6. 重新编译/构建
```

### 改后

**独立工具**：
```
1. 写 ~/.imtoagent/tools/foo.ts（export default ToolDefinition）
2. 重启 imtoagent
完成。
```

**一组相关工具（工厂）**：
```
1. mkdir ~/.imtoagent/tools/foo-tools/
2. 写 foo-tools/index.ts（export function createFooTools(deps)）
3. 重启 imtoagent
完成。
```

---

## 实施步骤

### Phase 1：发现引擎（不破坏现有逻辑）
- [ ] 创建 `modules/core/tool-discovery.ts`
- [ ] `ToolRegistry` 新增 `isKnown(name)`
- [ ] `heartbeat-scheduler.ts` 添加 `autoRegisterTools()`，但保留原有注册逻辑作为 fallback
- [ ] 双轨运行：新发现引擎 + 原有注册同时生效（验证结果一致后移除旧的）

### Phase 2：拦截层修复
- [ ] `tool-interceptor.ts` 改为查 registry
- [ ] 移除硬编码前缀判断
- [ ] 验证：所有工具正常拦截执行

### Phase 3：用户工具目录
- [ ] 创建 `~/.imtoagent/tools/`（如不存在）
- [ ] 扫描用户目录，用户工具覆盖内置
- [ ] 文档：如何添加自定义工具

### Phase 4：内置工具迁移（可选，渐进式）
- [ ] task-tools.ts 拆为 task-tools/ 目录（形态 2 → 形态 3）
- [ ] goal-task-tools.ts 拆为 goal-task-tools/ 目录
- [ ] weather.ts 改为 `export default` 格式
- [ ] 原有单文件格式保持兼容

---

## 向后兼容保证

- ✅ 现有的 `task-tools.ts`（形态 2）无需修改即可被新发现引擎识别
- ✅ 现有的 `weather.ts`（形态 1）无需修改（既导出 `weatherTool` 又导出 `default`）
- ✅ 如果新发现引擎有问题，保留原有注册逻辑作为 fallback
- ✅ 拦截层的硬编码前缀判断作为兜底保留
