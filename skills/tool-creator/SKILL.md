---
name: tool-creator
description: 创建/编写 IMtoAgent 自定义工具（ToolDefinition），支持独立工具、工厂函数、目录工厂三种形态
version: 1.0.0
requires_tools: []
---

# Tool Creator

当需要为 IMtoAgent 创建新工具时使用。

## 触发条件

- 用户要求添加新工具/新功能
- 需要封装外部 API（天气、HTTP 检查等）
- 需要系统操作（文件检查、指标获取等）

## ToolDefinition 接口

所有工具必须符合以下接口（位于 `modules/agent/tool-registry.ts`）：

```typescript
interface ToolDefinition {
  name: string;          // 工具名，建议小写+下划线，如 get_weather
  description: string;   // 工具描述，模型用此决定是否调用
  parameters: {          // JSON Schema 格式参数定义
    type: 'object';
    properties: Record<string, {
      type: string;       // 'string' | 'number' | 'boolean' | 'array' | 'object'
      description: string;
      enum?: string[];    // 可选枚举值
    }>;
    required: string[];  // 必填参数名列表
  };
  handler: (params: Record<string, unknown>) => Promise<unknown>;  // 执行函数
}
```

## 三种工具形态

### 形态 1：独立工具（单文件，单个工具）

适用于：一个文件只提供一个工具。

```typescript
// ~/.imtoagent/tools/my-tool.ts
import type { ToolDefinition } from '../agent/tool-registry';

export const myTool: ToolDefinition = {
  name: 'my_tool_name',
  description: '工具描述',
  parameters: {
    type: 'object',
    properties: {
      param1: { type: 'string', description: '参数说明' },
    },
    required: ['param1'],
  },
  handler: async (params) => {
    const param1 = params.param1 as string;
    // 实现逻辑...
    return { success: true, result: 'xxx' };
  },
};

// 必须 export default，框架才能自动发现
export default myTool;
```

### 形态 2：工厂函数（单文件，多个工具）

适用于：一组相关工具放在一个文件里，需要共享依赖。

```typescript
// ~/.imtoagent/tools/my-tools.ts
import type { ToolDefinition } from '../agent/tool-registry';

export function createMyTools(deps: { someDep: SomeType }): ToolDefinition[] {
  return [
    {
      name: 'tool_one',
      description: '...',
      parameters: { type: 'object', properties: {}, required: [] },
      handler: async (params) => { /* ... */ },
    },
    {
      name: 'tool_two',
      description: '...',
      parameters: { type: 'object', properties: {}, required: [] },
      handler: async (params) => { /* ... */ },
    },
  ];
}
```

框架识别规则：导出包含一个 `createXxx`/`initXxx`/`registerXxx` 命名的函数，或 `export default` 是函数。

### 形态 3：目录工厂（子目录，多文件）

适用于：工具组较大，需要拆成多个文件。

```
~/.imtoagent/tools/my-tools/
├── index.ts    ← 导出 createMyTools() 函数
├── one.ts      ← export const toolOne = { name: 'tool_one', ... }
├── two.ts      ← export const toolTwo = { name: 'tool_two', ... }
```

```typescript
// index.ts
import { toolOne } from './one';
import { toolTwo } from './two';

export function createMyTools(deps: { someDep: SomeType }): ToolDefinition[] {
  return [toolOne, toolTwo].map(tool => ({
    ...tool,
    handler: (...args) => tool.handler(deps.someDep, ...args),
  }));
}
```

框架识别规则：目录中存在 `index.ts` 则视为目录工厂。

## 创建步骤

1. **确定形态**：单个工具 → 形态 1；相关工具组 → 形态 2/3
2. **写文件**：放到 `~/.imtoagent/tools/` 目录
3. **同步**：如果同时在开发目录（`~/.openclaw/workspace/imtoagent/`）修改了 `modules/tools/`，需同步到生产环境 `/usr/local/lib/nodejs/lib/node_modules/imtoagent/modules/tools/`
4. **重启**：`imtoagent restart` 或重启进程，框架自动发现并注册
5. **验证**：检查日志中 `[ToolDiscovery]` 输出，确认工具已注册

## 编写规范

### 命名
- 工具名：小写字母 + 下划线，如 `get_weather`、`check_file`
- 文件名：kebab-case，如 `weather.ts`、`condition-tools.ts`
- 目录名：kebab-case + `-tools` 后缀，如 `task-tools/`

### 参数设计
- 必填参数放 `required` 数组
- 每个参数必须有 `description`
- 有固定选项的用 `enum`
- 可选参数不设 required，handler 里给默认值

### 返回值
- 成功返回对象，包含关键结果字段
- 失败返回 `{ success: false, error: '...' }` 而非 throw
- 保持返回值结构稳定，下游可能依赖

### 错误处理
- 所有外部调用（fetch、exec）必须 try/catch
- 超时设置合理值（网络 8-10s，本地命令 5s）
- 错误信息要具体，帮助模型理解失败原因

### 安全性
- 不执行危险命令（rm、sudo 等），除非工具设计目的就是系统运维
- 文件操作注意路径遍历攻击防护
- 敏感信息（API key 等）从配置读取，不硬编码

## 常用参考

### 网络请求模板
```typescript
const controller = new AbortController();
const timeout = setTimeout(() => controller.abort(), 8000);
try {
  const response = await fetch(url, { signal: controller.signal });
  // ...
} finally {
  clearTimeout(timeout);
}
```

### 子进程执行模板
```typescript
const { execSync } = await import("child_process");
const result = execSync("command", { encoding: "utf-8", timeout: 5000 }).trim();
```

### 文件操作模板
```typescript
const fs = await import("fs");
const path = await import("path");
if (fs.existsSync(filePath)) { /* ... */ }
```

## 已有工具参考

| 文件 | 形态 | 说明 |
|------|------|------|
| `weather.ts` | 独立工具 | HTTP 查询天气 |
| `condition-tools.ts` | 工厂函数 | HTTP/系统/文件/URL 检查 |
| `skill-tools.ts` | 工厂函数 | 技能读取/列表/创建 |
| `task-tools.ts` | 工厂函数 | 任务管理 |
| `goal-task-tools.ts` | 工厂函数 | 目标管理 |

## Shell 脚本约定

如果工具需要调用 shell 脚本，脚本放在 `scripts/shared/` 目录，统一路径格式：

```typescript
const scriptPath = path.join(__dirname, '..', '..', 'scripts', 'shared', 'my-script.sh');
const result = execSync(`bash "${scriptPath}" arg1 arg2`, { encoding: 'utf-8', timeout: 10000 });
```

## 注意事项

- 工具描述要准确但简洁，模型靠它决定是否调用
- 不要重复造轮子，先检查 `~/.imtoagent/tools/` 和 `modules/tools/` 是否已有类似工具
- 新建工具后不需要手动注册，框架的 `tool-discovery.ts` 会自动扫描注册
- 如果工具需要依赖注入（如 taskManager、goalManager），用形态 2/3，框架会自动注入
