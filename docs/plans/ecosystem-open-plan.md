# 生态开放计划 — Tools / Skills / Hooks

> 状态：✅ 已实施（2026-06-10）
> 日期：2026-06-10  
> 目标：让第三方开发者无需修改 imtoagent 源码即可扩展能力  
> 核心原则：**放文件即生效，零额外依赖，不引入 npm 包**

---

## 整体架构

```
~/.imtoagent/
├── tools/          ← 工具（模型能操作什么）
├── skills/         ← 技能（模型知道怎么做）
├── hooks/          ← 钩子（系统在关键节点做什么）
└── config.json
```

三者分工：
- **Tools** 扩展模型的能力边界
- **Skills** 扩展模型的行为知识
- **Hooks** 扩展运行时链路的处理逻辑

完整链路：
```
Skills 写入 system prompt → 影响模型决策
                            ↓
模型决定调用 Tools → Hooks 拦截 tool_calls
                            ↓
                    before_tool_call → 执行工具 → after_tool_call
                            ↓
                    before_reply → 发送给用户
```

---

## 1. Tools（已有基础，待完善）

### 1.1 现状

已完成 `discoverTools()` 发现引擎，支持三种形态：

| 形态 | 文件结构 | 导出格式 |
|------|----------|----------|
| 独立工具 | `~/.imtoagent/tools/weather.ts` | `export default { name, handler }` |
| 工厂函数 | `~/.imtoagent/tools/condition-tools.ts` | `export function createXxx(): ToolDefinition[]` |
| 目录工厂 | `~/.imtoagent/tools/task-tools/index.ts` | `export function createTaskTools(deps): ToolDefinition[]` |

### 1.2 待优化

**问题**：开发者不知道 `handler` 签名、`context` 里有什么、可用依赖有哪些。

**方案**：文件系统约定代替类型声明

#### 1.2.1 创建 `~/.imtoagent/tools/EXAMPLE.ts` 模板

```typescript
/**
 * imtoagent 工具模板
 * 
 * 将此文件复制到 ~/.imtoagent/tools/ 目录下，
 * 修改 name、description 和 handler 即可创建自定义工具。
 * 
 * 框架启动时会自动扫描 ~/.imtoagent/tools/ 并注册。
 */

export default {
  /** 工具名称（唯一标识，建议用下划线分隔） */
  name: 'my_custom_tool',

  /** 工具描述（会发送给 LLM，决定何时调用） */
  description: '这个工具的作用描述',

  /** 参数定义（JSON Schema 格式，可选） */
  parameters: {
    type: 'object',
    properties: {
      message: {
        type: 'string',
        description: '要处理的消息内容',
      },
    },
    required: ['message'],
  },

  /**
   * 处理函数
   * @param params - LLM 传入的参数（按上面的 properties 定义）
   * @param context - 运行时上下文，包含：
   *   - taskManager: TaskManager 实例
   *   - goalManager: GoalManager 实例  
   *   - goalStore: GoalStore 实例
   *   - resolveChatId: () => string  获取当前活跃聊天 ID
   */
  handler: async (params: Record<string, unknown>, context: any) => {
    const { message } = params;
    
    // 示例：访问任务管理器
    // const tasks = context.taskManager.listTasks();
    
    return `收到消息: ${message}`;
  },
};
```

#### 1.2.2 创建 `imtoagent tool-info` 命令

```bash
imtoagent tool-info          # 列出所有已注册工具 + 参数签名
imtoagent tool-info <name>   # 查看单个工具详情
```

输出示例：
```
Registered Tools (13):
  imtoagent_create_task     - 创建任务
  imtoagent_list_tasks      - 列出任务
  imtoagent_get_task        - 获取任务详情
  imtoagent_update_task     - 更新任务
  imtoagent_delete_task     - 删除任务
  imtoagent_create_goal     - 创建目标
  imtoagent_list_goals      - 列出目标
  imtoagent_pause_goal      - 暂停目标
  imtoagent_resume_goal     - 恢复目标
  imtoagent_update_goal     - 更新目标
  imtoagent_delete_goal     - 删除目标
  check_file                - 检查文件状态
  get_weather               - 查询天气

Context 可用依赖:
  taskManager     - TaskManager 实例
  goalManager     - GoalManager 实例
  goalStore       - GoalStore 实例
  resolveChatId   - () => string  获取活跃聊天 ID
```

---

## 2. Skills（标准化，待实施）

### 2.1 现状

`SkillsManager` 支持安装/删除，SKILL.md 纯文本注入 system prompt。

### 2.2 待优化

**问题**：
- 没有标准模板，开发者不知道怎么写
- 无法声明依赖的工具
- 无法指定挂载的 hook 点
- 安装后不会验证依赖是否满足

### 2.3 方案

#### 2.3.1 标准化 SKILL.md 模板

```markdown
---
name: code-review
description: 代码审查技能，按最佳实践检查代码质量
version: 1.0.0
requires_tools:
  - check_file
triggers:
  - before_reply
---

# Code Review 技能

当用户提供代码或要求审查代码时，按以下步骤执行：

1. 检查代码风格和规范
2. 检查潜在 bug 和安全问题
3. 检查性能和可维护性
4. 给出具体改进建议

## 输出格式

使用以下格式输出审查结果：

### ✅ 优点
- ...

### ⚠️ 需要改进
- ...

### 💡 建议
- ...
```

#### 2.3.2 启动时验证依赖

在 `index.ts` 的启动流程中，加载 Skills 后检查 `requires_tools`：

```typescript
// 验证 skills 依赖的工具是否已注册
for (const skill of mergedSkills) {
  const requires = parseSkillRequires(skill.path);
  if (requires.tools) {
    for (const toolName of requires.tools) {
      if (!toolRegistry.isKnown(toolName)) {
        console.warn(
          `[Skills] ⚠️ Skill "${skill.name}" requires tool "${toolName}" but it is not registered`,
        );
      }
    }
  }
}
```

#### 2.3.3 创建 `~/.imtoagent/skills/EXAMPLE/SKILL.md` 模板

同上，放在 skills 目录下作为参考。

---

## 3. Hooks（全新，核心改动）

### 3.1 现状

**完全硬编码**，外部开发者无法扩展：
- `tool-interceptor.ts` 拦截 tool_calls
- `runtime.ts` 拦截 Goal 命令
- `index.ts` 拦截回复

### 3.2 目标

让开发者往 `~/.imtoagent/hooks/` 放文件，系统自动加载并在关键链路执行。

### 3.3 挂载点定义

系统提供以下挂载点（硬编码在运行时，开发者选择使用）：

| 挂载点 | 触发时机 | 可操作内容 |
|--------|----------|------------|
| `before_tool_call` | 工具执行前 | 可拦截（返回 error）、修改参数 |
| `after_tool_call` | 工具执行后 | 可审计、修改结果、记录日志 |
| `before_reply` | 回复发送前 | 可过滤敏感信息、格式化、追加内容 |
| `on_error` | 错误发生时 | 可自定义降级策略、告警 |

### 3.4 Hook 文件格式

```
~/.imtoagent/hooks/
  audit.ts        # 审计所有工具调用
  filter.ts       # 过滤敏感输出
  guard.ts        # 权限校验
```

每个 hook 文件导出：

```typescript
export default {
  /** 钩子名称（唯一标识） */
  name: 'audit',

  /** 挂载点（见上方表格） */
  when: 'after_tool_call',

  /**
   * 处理函数
   * @param ctx - 上下文，根据挂载点不同而不同
   */
  handler: async (ctx: HookContext) => {
    console.log(`[Audit] Tool: ${ctx.toolName}, Result: ${ctx.result.slice(0, 100)}`);
  },
};
```

### 3.5 HookContext 定义

不同挂载点的上下文：

```typescript
interface HookContext {
  // 所有挂载点共有
  hookName: string;
  timestamp: number;
}

interface BeforeToolCallContext extends HookContext {
  toolName: string;
  args: Record<string, unknown>;
  chatId: string;
  /** 返回 { blocked: true, error: "..." } 可拦截执行 */
  intercept?: () => { blocked: boolean; error?: string };
}

interface AfterToolCallContext extends HookContext {
  toolName: string;
  args: Record<string, unknown>;
  result: string;
  success: boolean;
  chatId: string;
  /** 修改结果：返回新结果字符串 */
  modifyResult?: (newResult: string) => void;
}

interface BeforeReplyContext extends HookContext {
  text: string;
  chatId: string;
  /** 修改回复内容 */
  modifyText?: (newText: string) => void;
}

interface OnErrorContext extends HookContext {
  error: Error;
  context: string;  // 发生错误的上下文描述
  chatId?: string;
}
```

### 3.6 系统侧实现

#### 3.6.1 新建 `modules/core/hook-discovery.ts`

```typescript
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

export interface DiscoveredHook {
  name: string;
  when: 'before_tool_call' | 'after_tool_call' | 'before_reply' | 'on_error';
  handler: (ctx: any) => Promise<void>;
  sourceFile: string;
}

/**
 * 扫描 ~/.imtoagent/hooks/ 加载所有钩子
 */
export async function discoverHooks(): Promise<DiscoveredHook[]> {
  const hooksDir = path.join(os.homedir(), '.imtoagent', 'hooks');
  if (!fs.existsSync(hooksDir)) return [];

  const discovered: DiscoveredHook[] = [];
  const entries = fs.readdirSync(hooksDir, { withFileTypes: true });

  for (const entry of entries) {
    if (!entry.name.endsWith('.ts')) continue;
    if (entry.name.startsWith('_') || entry.name.includes('.test.')) continue;

    const entryPath = path.join(hooksDir, entry.name);
    try {
      const mod = await import(`file://${entryPath}`);
      const hook = mod.default;

      if (hook && typeof hook.name === 'string' && typeof hook.when === 'string' && typeof hook.handler === 'function') {
        discovered.push({
          name: hook.name,
          when: hook.when,
          handler: hook.handler,
          sourceFile: entryPath,
        });
        console.log(`[HookDiscovery] Registered: ${hook.name} (${hook.when})`);
      } else {
        console.warn(`[HookDiscovery] ⚠️ ${entry.name}: 导出格式不正确，需要 { name, when, handler }`);
      }
    } catch (err) {
      console.error(`[HookDiscovery] ❌ ${entry.name}: ${(err as Error).message}`);
    }
  }

  console.log(`[HookDiscovery] Total hooks discovered: ${discovered.length}`);
  return discovered;
}
```

#### 3.6.2 新建 `modules/core/hook-runner.ts`

```typescript
import type { DiscoveredHook } from './hook-discovery';

/**
 * 钩子执行器
 * 按挂载点组织钩子，顺序执行
 */
export class HookRunner {
  private hooksByWhen = new Map<string, DiscoveredHook[]>();

  register(hooks: DiscoveredHook[]): void {
    for (const hook of hooks) {
      const list = this.hooksByWhen.get(hook.when) || [];
      list.push(hook);
      this.hooksByWhen.set(hook.when, list);
    }
  }

  /**
   * 执行指定挂载点的所有钩子
   */
  async run(when: string, ctx: any): Promise<void> {
    const hooks = this.hooksByWhen.get(when) || [];
    for (const hook of hooks) {
      try {
        await hook.handler(ctx);
      } catch (err) {
        console.error(`[HookRunner] ${hook.name} error: ${(err as Error).message}`);
      }
    }
  }

  /**
   * 执行 before_tool_call 钩子，支持拦截
   * @returns { blocked: true, error: "..." } 表示被拦截
   */
  async runBeforeToolCall(ctx: { toolName: string; args: Record<string, unknown>; chatId: string }): Promise<{ blocked: boolean; error?: string }> {
    let blocked = false;
    let errorMsg: string | undefined;

    const interceptCtx = {
      ...ctx,
      hookName: '',
      timestamp: Date.now(),
      intercept: () => {
        blocked = true;
        errorMsg = 'Hook blocked this tool call';
        return { blocked: true };
      },
    };

    await this.run('before_tool_call', interceptCtx);

    return { blocked, error: errorMsg };
  }

  /**
   * 执行 after_tool_call 钩子，支持修改结果
   */
  async runAfterToolCall(ctx: { toolName: string; args: Record<string, unknown>; result: string; success: boolean; chatId: string }): Promise<string> {
    let modifiedResult = ctx.result;

    const hookCtx = {
      ...ctx,
      hookName: '',
      timestamp: Date.now(),
      modifyResult: (newResult: string) => {
        modifiedResult = newResult;
      },
    };

    await this.run('after_tool_call', hookCtx);
    return modifiedResult;
  }

  /**
   * 执行 before_reply 钩子，支持修改回复
   */
  async runBeforeReply(ctx: { text: string; chatId: string }): Promise<string> {
    let modifiedText = ctx.text;

    const hookCtx = {
      ...ctx,
      hookName: '',
      timestamp: Date.now(),
      modifyText: (newText: string) => {
        modifiedText = newText;
      },
    };

    await this.run('before_reply', hookCtx);
    return modifiedText;
  }
}
```

#### 3.6.3 集成到现有链路

**Step 1：扩展 bot-context**

`bot-context.ts` 新增 `hookRunner` 字段：

```typescript
import type { HookRunner } from './core/hook-runner';

export interface BotContextData {
  // ... 现有字段 ...
  toolRegistry?: ToolRegistry;
  hookRunner?: HookRunner;  // ← 新增
}
```

**Step 2：heartbeat-scheduler.ts 创建 HookRunner 并注册**

```typescript
import { discoverHooks } from './hook-discovery';
import { HookRunner } from './hook-runner';

// HeartbeatScheduler 新增字段
hookRunner: HookRunner = new HookRunner();

// 在 static async create() 中加载 hooks
static async create(...): Promise<HeartbeatScheduler> {
  const scheduler = new HeartbeatScheduler(...);

  await scheduler.autoRegisterTools();
  scheduler.toolRegistry.injectNeeded(scheduler.toolRegistry.list());

  // 加载 hooks
  const hooks = await discoverHooks();
  scheduler.hookRunner.register(hooks);

  scheduler._initGoalEngine();
  return scheduler;
}
```

**Step 3：index.ts — 将 hookRunner 传入 bot-context**

在 `im.start()` 回调中，`setCurrentBot` 时一起传入：

```typescript
bot.im.start({
  ...
  toolRegistry: bot.heartbeatScheduler?.getToolRegistry(),
  hookRunner: bot.heartbeatScheduler?.hookRunner,  // ← 新增
  ...
});
```

**Step 4：codex-proxy.ts — executeLocalTools 集成 hooks**

注意：tool interception 实际在 `codex-proxy.ts`，不是 `anthropic-proxy.ts`。

修改 `executeLocalTools` 签名，接收 `hookRunner`：

```typescript
import { HookRunner } from '../core/hook-runner';

async function executeLocalTools(
  calls: ParsedToolCall[],
  toolRegistry: ToolRegistry,
  hookRunner: HookRunner | undefined,  // ← 新增，可选
): Promise<ToolExecutionResult[]> {
  return Promise.all(calls.map(async (call): Promise<ToolExecutionResult> => {
    // before_tool_call hook
    if (hookRunner) {
      const beforeResult = await hookRunner.runBeforeToolCall({
        toolName: call.name,
        args: call.args,
        chatId: getCurrentBot()?.lastChatId || '',
      });
      if (beforeResult.blocked) {
        return {
          toolCallId: call.id,
          name: call.name,
          isLocal: true,
          content: `Blocked by hook: ${beforeResult.error}`,
          success: false,
        };
      }
    }

    // 执行工具
    const rawResult = await toolRegistry.execute(call.name, call.args);
    const result = typeof rawResult === 'string' ? rawResult : JSON.stringify(rawResult);

    // after_tool_call hook
    let finalResult = result;
    if (hookRunner) {
      finalResult = await hookRunner.runAfterToolCall({
        toolName: call.name,
        args: call.args,
        result: result,
        success: true,
        chatId: getCurrentBot()?.lastChatId || '',
      });
    }

    return {
      toolCallId: call.id,
      name: call.name,
      isLocal: true,
      content: finalResult,
      success: true,
    };
  }));
}
```

调用点（`handleParsedResponse` 和 `handleParsedResponseRecursive`）修改：

```typescript
const hookRunner = getCurrentBot()?.hookRunner;
const localResults = await executeLocalTools(localCalls, interceptRegistry, hookRunner);
```

**Step 5：index.ts — reply() 方法集成 before_reply**

在 `Heartbot.reply()` 方法里加 hook，而不是 `handleMessage`（因为所有回复最终都走 `reply()`）：

```typescript
async reply(chatId: string, text: string) {
  const maxLen = this.config.system?.maxReplyLength || 140000;

  // before_reply hook
  if (this.heartbeatScheduler?.hookRunner) {
    text = await this.heartbeatScheduler.hookRunner.runBeforeReply({
      text,
      chatId,
    });
  }

  await this.im.reply(chatId, text, maxLen);
  console.log(`[${this.name}] Reply chat=${chatId.slice(-8)} len=${Math.min(text.length, maxLen)}`);
}
```

### 3.7 创建 `~/.imtoagent/hooks/EXAMPLE.ts` 模板

```typescript
/**
 * imtoagent 钩子模板
 * 
 * 将此文件复制到 ~/.imtoagent/hooks/ 目录下，
 * 修改 name、when 和 handler 即可创建自定义钩子。
 * 
 * 可用挂载点（when）：
 *   before_tool_call  - 工具执行前（可拦截）
 *   after_tool_call   - 工具执行后（可审计/修改结果）
 *   before_reply      - 回复发送前（可过滤/格式化）
 *   on_error          - 错误发生时（可自定义处理）
 * 
 * 框架启动时会自动扫描 ~/.imtoagent/hooks/ 并注册。
 */

export default {
  /** 钩子名称 */
  name: 'my_custom_hook',

  /** 挂载点 */
  when: 'after_tool_call',

  /**
   * 处理函数
   * 根据挂载点不同，上下文包含不同字段：
   * 
   * before_tool_call:
   *   { toolName, args, chatId, intercept }
   *   调用 intercept() 可拦截工具执行
   * 
   * after_tool_call:
   *   { toolName, args, result, success, chatId, modifyResult }
   *   调用 modifyResult(newResult) 可修改工具结果
   * 
   * before_reply:
   *   { text, chatId, modifyText }
   *   调用 modifyText(newText) 可修改回复
   * 
   * on_error:
   *   { error, context, chatId }
   */
  handler: async (ctx) => {
    console.log(`[MyHook] Tool: ${ctx.toolName}, Success: ${ctx.success}`);
  },
};
```

### 3.8 新增 `imtoagent hook-info` 命令

```bash
imtoagent hook-info          # 列出所有已注册钩子 + 挂载点
```

输出示例：
```
Registered Hooks (2):
  audit         → after_tool_call   [~/.imtoagent/hooks/audit.ts]
  sensitive_filter → before_reply   [~/.imtoagent/hooks/filter.ts]
```

---

## 4. 实施步骤

### Phase 1：Skills 标准化（低改动）
- [ ] 创建 `~/.imtoagent/skills/EXAMPLE/SKILL.md` 模板
- [ ] 更新 `SkillsManager` 解析 `requires_tools` 和 `triggers`
- [ ] 启动时验证 skill 依赖的工具是否已注册

### Phase 2：Tools 体验完善（低改动）
- [ ] 创建 `~/.imtoagent/tools/EXAMPLE.ts` 模板
- [ ] 新增 `imtoagent tool-info` 命令
- [ ] 更新文档

### Phase 3：Hooks 核心实现（中改动）
- [ ] 创建 `modules/core/hook-discovery.ts`
- [ ] 创建 `modules/core/hook-runner.ts`
- [ ] 扩展 `bot-context.ts` 新增 `hookRunner` 字段
- [ ] `HeartbeatScheduler` 创建 `HookRunner` 实例，`create()` 中加载 hooks
- [ ] `index.ts` — `setCurrentBot` 时传入 `hookRunner`
- [ ] `index.ts` — `reply()` 方法集成 `before_reply` hook
- [ ] `codex-proxy.ts` — `executeLocalTools` 集成 before/after_tool_call
- [ ] 更新 `tool-interceptor.ts` 导出签名
- [ ] 新增 `imtoagent hook-info` 命令
- [ ] 创建 `~/.imtoagent/hooks/EXAMPLE.ts` 模板

### Phase 4：验证和文档
- [ ] 端到端测试：放一个 hook 文件 → 重启 → 验证执行
- [ ] 更新 README 和 docs.imtoagent.com

---

## 5. 风险与回退

- **Phase 1-2**：纯新增文件和命令，不影响现有逻辑
- **Phase 3**：hook 系统是新模块，如果 `~/.imtoagent/hooks/` 目录不存在或为空，完全无影响
- **回退**：删除 hooks 目录或文件即可禁用钩子系统

---

## 6. 未来扩展（不在本次范围内）

- Hook 执行顺序管理（优先级/依赖）
- Hook 热加载（不重启生效）
- Skills 可以声明要注册的自定义工具
- 技能市场 / registry（远程安装）
