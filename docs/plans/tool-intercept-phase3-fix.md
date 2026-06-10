# Tool Intercept Phase 3 Fix — 本地工具完全透明化

> 创建时间：2026-06-09
> 状态：待实施
> 作者：Keyi + 义一

## 1. 问题描述

### 1.1 现象

用户在 Codex 中调用 `imtoagent_create_goal`，工具实际执行成功（goal 写入了 goals.json），但 Codex 回复类似：

> "虽然工具调用报了个 unsupported call 的错误标记，但实际上已经写入了 goals.json 文件中"

### 1.2 根因

当前 Phase 3 实现**边收边转发** tool_calls 给 Codex 客户端：

1. LLM 返回 `tool_calls`（含 `imtoagent_create_goal`）
2. IMtoAgent 边收边转发 → Codex 收到了 tool_calls
3. IMtoAgent 拦截执行本地工具 → 结果缓存到 `pendingLocalResults`
4. Codex 收到 tool_calls 后，等待客户端执行或发起下一次请求
5. 但 Codex 不知道怎么执行 `imtoagent_create_goal`，卡住
6. `mergePendingLocalResults` 的合并条件要求 `incomingToolCallIds.size > 0`（即客户端传回远端工具结果），但 Codex 根本没传回任何结果 → 合并永远不触发

### 1.3 核心矛盾

- **流式阶段已转发 tool_calls** → Codex 知道有工具调用发生
- **本地工具 Codex 无法执行** → 状态机卡住
- **合并条件依赖远端工具结果** → 纯本地工具场景永远无法合并

## 2. 设计方案

### 2.1 核心原则

**本地工具对后端 agentic 完全透明**：Codex 不知道也不关心本地工具的存在，只看到最终回复。

### 2.2 流程改造

```
流式阶段（第一轮）：
  - 完全缓存（text_delta + tool_calls），不转发给客户端
  - 同时收集 tool_calls 用于判断

流结束后分流：
  ├─ 无 tool_calls
  │    → 把缓存的 text 作为 response 返回（正常结束）
  │
  ├─ 只有本地工具（无远端工具）
  │    → 执行本地工具
  │    → 构造第二轮请求：
  │        messages = [原 messages] + [assistant: 第一轮 text] + [tool results]
  │    → 发给 LLM
  │    → 把第二轮 response 作为 response 返回
  │    → Codex 只看到 final response，完全无感
  │
  └─ 有远端工具（可能同时有本地工具）
       → 把缓存的 tool_calls 作为 response 返回
       → 缓存本地工具结果（等下次请求合并）
       → Codex 执行远端工具 → 传回结果 → 合并本地结果 → 继续
```

### 2.3 与当前实现的差异

| 方面 | 当前（有 bug） | 修复后 |
|---|---|---|
| 流式转发 | 边收边转发 tool_calls | 完全缓存，不转发 |
| 纯本地工具 | 转发 tool_calls → Codex 困惑 | 自己闭环 → Codex 无感 |
| 合并条件 | 依赖远端工具结果存在 | 纯本地工具不需要合并 |
| 用户等待 | 卡住无响应 | 多等几秒但能拿到最终回复 |

## 3. 实施步骤

### Step 1: 改造流式阶段 — 完全缓存不转发

- 移除 `WritableStream` 直接 `res.write(chunk)` 的转发逻辑
- 改为：缓存所有 SSE data（text_delta + tool_calls）到内存
- 流结束后才决定如何处理

### Step 2: 实现分流逻辑

- `collectedToolCalls` 分析：
  - `localCalls.length === 0 && remoteCalls.length === 0` → 无工具，直接返回缓存的 text
  - `localCalls.length > 0 && remoteCalls.length === 0` → 纯本地工具，走自闭环
  - `remoteCalls.length > 0` → 有远端工具，返回 tool_calls 给客户端

### Step 3: 实现纯本地工具自闭环

```typescript
// 伪代码
if (hasLocal && !hasRemote) {
  // 1. 执行本地工具
  const localResults = await executeLocalTools(localCalls, interceptRegistry);
  
  // 2. 构造第二轮请求的 messages
  const round2Messages = [...chatReq.messages];
  
  // 3. 如果有第一轮 text，加 assistant 消息
  if (collectedText) {
    round2Messages.push({ role: 'assistant', content: collectedText });
  }
  
  // 4. 加 tool results
  for (const r of localResults) {
    round2Messages.push({ role: 'tool', tool_call_id: r.toolCallId, content: r.content });
  }
  
  // 5. 发第二轮请求给 LLM（流式转发给客户端）
  res.writeHead(200, { 'Content-Type': 'text/event-stream', ... });
  const round2Res = await fetch(UPSTREAM(), {
    body: JSON.stringify({ ...chatReq, messages: round2Messages, stream: true }),
  });
  // 流式转发 round2 的 response 给客户端
}
```

### Step 4: 有远端工具时的处理

- 把缓存的 tool_calls 构造为 OpenAI response 格式返回给客户端
- 本地工具结果照常缓存到 `pendingLocalResults`
- 等客户端传回远端工具结果后合并

### Step 5: 清理旧逻辑

- 移除 `alreadyStreamed` 标记（不再需要）
- 移除 `cameFromIntercept` 标记
- 简化 `mergePendingLocalResults`（只在有远端工具场景下使用）

## 4. 关键设计决策

### 4.1 第一轮 text 是否传给第二轮？

**选择：传**。第一轮 text 是 LLM 的中间思考（如"我来帮你创建一个提醒"），传给第二轮可以让 LLM 保持上下文连贯。

### 4.2 第二轮是否也缓存？

**选择：不缓存，直接流式转发**。第二轮是最终回复，直接转发给客户端即可。如果第二轮又出现 tool_calls（LLM 继续调用工具），走正常流程。

### 4.3 超时保护

- 第一轮缓存阶段：保持现有 180s 超时
- 本地工具执行：保持现有 30s 超时
- 第二轮请求：180s 超时

## 5. 风险评估

| 风险 | 影响 | 缓解 |
|---|---|---|
| 纯本地工具场景等待时间变长 | 用户体验 | 可接受，比卡住无响应好 |
| 第二轮又出现 tool_calls | 需要递归处理 | 先不递归，走正常流程（最多两轮） |
| 缓存内存占用 | 大 text 场景 | 可接受，与当前流式缓存相当 |

## 6. 状态

- 📋 待实施
- 预计工作量：半天
