# Tool Intercept Phase 3 — 远端工具透传

> 创建时间：2026-06-09
> 状态：待实施
> 作者：Keyi + 义一

## 1. 问题背景

### 1.1 Phase 2 的局限

当前 Phase 2 实现了流式拦截，但对远端工具的处理是：
- 回填占位文本 `[Remote tool managed by upstream runtime]`
- 模型看到占位文本后困惑，继续调用工具
- 最终 suppress 掉 tool_calls，输出很短的回复

### 1.2 设计目标

- **本地工具**（`imtoagent_*`, `goal_*`）→ IMtoAgent 拦截执行 → 对后端 agentic **无感**
- **远端工具**（`exec_command` 等 Codex 原生工具）→ 直接转发给客户端 → 客户端自己执行

## 2. 正确的设计原理

### 2.1 核心概念

**本地工具对后端 agentic 完全无感**：
- LLM 返回 tool_calls
- IMtoAgent 拦截本地工具，执行，回填结果
- 后端 agentic 只看到 tool 结果，不知道（也不关心）是谁执行的

**远端工具由客户端自己执行**：
- tool_calls 直接转发给客户端
- 客户端（Codex）执行 exec_command 等
- 执行结果由客户端传回（下一次请求的 messages 里）

### 2.2 完整流程

```
Codex 客户端 → IMtoAgent proxy → LLM
                ↓
          流式返回 tool_calls
                ↓
          ┌─────┴─────┐
          ↓           ↓
      本地工具      远端工具
    IMtoAgent执行   转发给客户端
          ↓           ↓
      结果缓存    客户端执行后传回结果
          ↓           ↓
          └─────┬─────┘
                ↓
        合并所有结果 → 第二次请求（带本地工具结果）
```

## 3. 实现方案

### 3.1 流式阶段：边收边转发

当前问题：第一次流被完全消费（不转发给客户端）。

**改为**：
- 边收边转发所有内容（包括 text_delta 和 tool_calls）
- 同时收集 tool_calls 用于判断是否有本地工具

```typescript
// streamResponse 改造
for await (const chunk of upstreamRes.body) {
  // 始终转发给客户端（不阻塞）
  res.write(chunk);
  
  // 同时收集 tool_calls
  if (delta.tool_calls) {
    collectedToolCalls.push(...delta.tool_calls);
  }
}
```

### 3.2 流结束后：判断是否有本地工具

```typescript
const localCalls = collectedToolCalls.filter(tc => isLocalTool(tc.function.name));
const hasLocal = localCalls.length > 0;

if (hasLocal) {
  // 有本地工具 → 执行 → 等客户端传回远端工具结果 → 第二次请求
  const localResults = await executeLocalTools(localCalls, interceptRegistry);
  // 缓存本地工具结果，等待下一次请求时合并
  pendingLocalResults = localResults;
}
// 无本地工具 → 什么都不做，让流正常传完
```

### 3.3 下一次请求：合并本地工具结果

当客户端执行完远端工具后，会发起新请求（messages 里包含远端工具结果）。

此时 IMtoAgent 需要：
1. 检测 messages 里是否有 pending 的本地工具结果
2. 如果有，合并到 messages 里
3. 继续正常流程

```typescript
// handleCodexRequest 入口
if (pendingLocalResults) {
  // 合并本地工具结果到 messages
  chatReq.messages = mergeLocalResults(chatReq.messages, pendingLocalResults);
  pendingLocalResults = null;
}
```

## 4. 关键设计决策

### 4.1 如何关联本地工具结果和请求？

**方案 A：全局缓存（简单）**
- 用 sessionKey 或 threadId 作为 key
- 缓存 pending 的本地工具结果
- 下一次请求时检查并合并

**方案 B：请求头传递（显式）**
- 客户端在请求头里带 `X-Pending-Local-Tools: true`
- IMtoAgent 检测到后合并结果

**选择方案 A**：更简单，不需要客户端改动。

### 4.2 本地工具执行时机

**选项 A：流式阶段立即执行**
- 优点：不阻塞后续流程
- 缺点：客户端可能还没传回远端工具结果

**选项 B：下一次请求时执行**
- 优点：可以一次性合并所有结果
- 缺点：延迟执行

**选择选项 A**：本地工具立即执行，结果缓存。下一次请求时合并。

### 4.3 超时处理

如果客户端一直不传回远端工具结果（比如 Codex 崩溃了），本地工具结果会一直 pending。

**方案**：设置超时（如 5 分钟），超时后清除 pending 结果。

## 5. 实施步骤

### Step 1: 改造 streamResponse
- 边收边转发（不阻塞）
- 同时收集 tool_calls

### Step 2: 流结束后判断
- 有本地工具 → 执行 → 缓存结果
- 无本地工具 → 什么都不做

### Step 3: 下一次请求合并
- 检测 pending 结果
- 合并到 messages

### Step 4: 超时清理
- 定时清除过期的 pending 结果

## 6. 风险评估

| 风险 | 影响 | 缓解 |
|---|---|---|
| 客户端不传回远端工具结果 | 本地工具结果一直 pending | 超时清理（5 分钟） |
| 多个并发请求混淆 | 结果合并到错误的请求 | 用 sessionKey 隔离 |
| 本地工具执行失败 | 结果缺失 | 注入错误文本，让 LLM 知道 |

## 7. 状态

- 📋 待实施
- 预计工作量：1-2 天
