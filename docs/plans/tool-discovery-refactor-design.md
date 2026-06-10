# Tool Discovery Refactor — 消除 isLocalTool 硬编码

> 状态：草稿  
> 日期：2026-06-10

## 问题

当前系统通过硬编码的 `isLocalTool()` 函数判断一个 tool_call 是否应该本地执行：

```typescript
function isLocalTool(name: string): boolean {
  return (
    name.startsWith('imtoagent_') ||
    name.startsWith('goal_') ||
    name === 'get_weather'
  );
}
```

**硬编码位置：6 个文件**

- `modules/proxy/tool-interceptor.ts` — 导出，被 codex-proxy 使用
- `modules/proxy/tool-call-loop.ts` — 本地函数
- `modules/agent/agent-loop.ts` — 本地函数
- `modules/agent/claude-adapter.ts` — 本地函数
- `modules/agent/gemini-adapter.ts` — 本地函数

**后果：**

1. 新工具如果名字不以 `imtoagent_` / `goal_` 开头，能被 discovery 注册，但不会被任何拦截器识别，当成远端工具生成占位结果
2. 每次加一个不满足前缀约定的工具，都要改 6 个文件
3. 与 tool-discovery.ts 的"自动发现"设计原则矛盾——发现是动态的，拦截是静态的

## 现状调用链路

```
LLM 响应 → tool_calls[]
         → 各处 isLocalTool(name) 硬编码判断
            → 本地：ToolRegistry.execute(name, args)
            → 远端：生成占位结果，不执行
```

Hook 在 `tool-interceptor.ts` 的 `executeLocalTools()` 中触发，意味着**只有被 isLocalTool 命中的工具才会触发 Hook**。

## 目标

```
LLM 响应 → tool_calls[]
         → toolRegistry.isRegistered(name) 动态判断
            → 已注册：ToolRegistry.execute(name, args) → 触发 Hook
            → 未注册：生成占位结果，不执行
```

所有硬编码的 `isLocalTool` 统一改为查 `ToolRegistry`。

## 方案

### 核心：在 ToolRegistry 增加 isRegistered() 公开方法

已经存在，不需要新增：

```typescript
// tool-registry.ts — 已有
isRegistered(name: string): boolean {
  return this.registry.has(name);
}
```

### 修改清单

#### 1. proxy/tool-interceptor.ts

删除硬编码函数，改为接受 `ToolRegistry` 实例：

```typescript
// 删除：
// export function isLocalTool(name: string): boolean { ... }

// 改为：
export function isLocalTool(name: string, registry?: ToolRegistry): boolean {
  if (registry) return registry.isRegistered(name);
  // fallback: 旧逻辑，保证向下兼容
  return name.startsWith('imtoagent_') || name.startsWith('goal_') || name === 'get_weather';
}

export function hasLocalTool(toolDefs: Array<{ function?: { name?: string } }>, registry?: ToolRegistry): boolean {
  if (!toolDefs || toolDefs.length === 0) return false;
  if (registry) return toolDefs.some(t => registry.isRegistered(t.function?.name || ''));
  return toolDefs.some(t => isLocalTool(t.function?.name || ''));
}
```

`executeLocalTools()` 已经接受 `toolRegistry` 参数，它内部的执行逻辑可以直接用 `toolRegistry.execute()`，不需要改。

#### 2. proxy/tool-call-loop.ts

`executeToolCallLoop()` 已经接受 `toolRegistry: ToolRegistry` 参数：

```typescript
// 替换内部的 isLocalTool(name) 调用：
if (toolRegistry.isRegistered(name)) {  // 本地
} else {                                  // 远端
}
```

同时删除文件内的 `function isLocalTool()` 和 `hasLocalTools()`。

#### 3. proxy/codex-proxy.ts

已经导入 `isLocalTool` 和 `hasLocalTool` 从 tool-interceptor。

修改点：
- `codex-proxy` 持有 `toolRegistry` 实例（构造函数传入）
- 所有 `isLocalTool(call.name)` 改为 `isLocalTool(call.name, toolRegistry)`
- `hasLocalTool(chatReq.tools)` 改为 `hasLocalTool(chatReq.tools, toolRegistry)`

#### 4. agent/agent-loop.ts

`isLocalTool` 是本地函数，需要让主循环能访问 `toolRegistry`：

```typescript
// 在 executeAgentLoop 或调用处传入 toolRegistry
// 替换：
const localCalls = parsedCalls.filter(tc => toolRegistry.isRegistered(tc.name));
```

#### 5. agent/claude-adapter.ts + gemini-adapter.ts

两个 adapter 里的 `isLocalTool` 都是内联函数。它们在被 `agent-loop.ts` 调用时已经能拿到 `toolRegistry`，把判断逻辑外移或在 adapter 函数签名中加 `toolRegistry` 参数即可。

### 兼容性

保留 fallback 逻辑：如果 `registry` 参数未传入，`isLocalTool` 回退到旧的前缀匹配。确保：
- 旧插件/旧版本不会因为缺少 registry 而崩溃
- 新工具必须注册到 registry 才能被识别

### 别名处理

`ToolRegistry` 已经有 `resolveToolName()` 处理别名（如 `imtoagent_remove_goal` → `imtoagent_delete_goal`）。改为查 registry 后，别名也能自动解析：

```typescript
// 判断前可以 resolve：
const resolved = toolRegistry.resolveToolName(name) ?? name;
if (toolRegistry.isRegistered(resolved)) { /* 本地 */ }
```

但实际不需要额外 resolve —— `isRegistered` 内部就是 `registry.has(name)`，如果别名工具在注册表里就是按原名存的，精确匹配即可。如果别名映射是运行时的，那需要在判断前先 resolve。

查看当前实现：别名表是 `imtoagent_remove_goal` → `imtoagent_delete_goal`，但注册时只注册了 `imtoagent_delete_goal`。所以如果 LLM 用别名调用，`isRegistered('imtoagent_remove_goal')` 会返回 false。

**解决：** 在 `isRegistered` 中集成 `resolveToolName`：

```typescript
isRegistered(name: string): boolean {
  return this.resolveToolName(name) !== null;
}
```

这样别名也能被正确识别。

## 影响范围

| 模块 | 改动类型 | 风险 |
|---|---|---|
| `tool-registry.ts` | 小改 isRegistered | 低 |
| `tool-interceptor.ts` | 改签名，保留 fallback | 低 |
| `tool-call-loop.ts` | 删除函数，改判断 | 低 |
| `codex-proxy.ts` | 传 registry 参数 | 低 |
| `agent-loop.ts` | 传 registry 参数 | 中 |
| `claude-adapter.ts` | 传 registry 参数 | 中 |
| `gemini-adapter.ts` | 传 registry 参数 | 中 |

## 验证

1. 现有工具（imtoagent_* / goal_* / get_weather）行为不变
2. 新工具（无前缀，但已注册）能被正确拦截执行
3. 未注册的工具仍被当作远端工具处理
4. Hook 在新工具执行前后正常触发

## 后续

修复后，创建新工具只需要：
1. 放 `.ts` 文件到 `~/.imtoagent/tools/`
2. 重启
3. 自动注册 + 自动拦截 + 自动触发 Hook

零配置，不需要改任何源码。
