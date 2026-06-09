# Tool Intercept 重构设计文档

> 创建时间：2026-06-09
> 状态：待评审
> 作者：Keyi + 义一

## 1. 当前架构与问题

### 1.1 当前流程（有问题）

```
用户消息 → codex-proxy 检测本地工具 → 进入 tool-call loop
    ↓
[Loop 1] 非流式调 LLM → 拿到 tool_calls
    ├─ 本地工具 → ToolRegistry.execute → 结果写回 messages
    └─ 远端工具 → 占位文本写回 messages
    ↓
[Loop 2] 再非流式调 LLM → 再拿 tool_calls → 再执行 → ...
    ↓
[Loop N] 直到没有 tool_calls
    ↓
用最终 messages 重新 fetch（stream: true）→ 生成回复
```

### 1.2 核心问题

| 问题 | 原因 | 影响 |
|---|---|---|
| 每次循环独立调 LLM | loop 内 `fetch(stream: false)` 独立请求 | 浪费时间、token、API 调用次数 |
| thinking 模式 400 | 第一轮 messages 无 `reasoning_content`，但 body 带了 `thinking: enabled` | loop 第一步就失败，fallback 到 direct streaming |
| fallback 泄漏 DSML | 降级后 DeepSeek 返回原始 tool_calls，streamResponse 未过滤 | 用户看到 `<｜｜DSML｜｜tool_calls>` 原始文本 |
| 远端工具占位文本 | 本地无法处理远端工具，注入 `[Remote tool managed by upstream]` | LLM 收到无意义文本，可能影响推理质量 |

### 1.3 问题根因

**tool-call loop 的设计前提本身就是弯路**：它假设需要"反复独立调 LLM 来问下一步调什么工具"。但实际上 tool_calls 在**一次请求的上下文**中就能处理完，不需要循环里独立调用 LLM。

---

## 2. 正确的设计原理

### 2.1 核心概念

**IMtoAgent 完全模拟后端 Agentic 的行为**：

```
LLM 返回 tool_calls → IMtoAgent 拦截本地工具 → 本地执行 → 结果回填 messages → 再次提交 LLM
```

对 LLM 来说：
- 不在乎执行者是后端 Agentic 还是 IMtoAgent
- 只看 `tool_call_id` 和 `content` 字段
- 本地和远端工具结果格式完全一致，可以混在一个 messages 数组里

### 2.2 工具执行时机

**关键点**：IMtoAgent 执行结果需要**等待后端 Agentic 的执行结果出来**，合并成一个完整请求体提交给 LLM。

```
LLM 返回 [本地工具 A, 远端工具 B, 本地工具 C]
    ↓
IMtoAgent 并行执行 A 和 C，同时让后端执行 B
    ↓
【等全部执行完】
    ↓
合并所有 tool 结果 → 一次性提交给 LLM
    ↓
LLM 看到完整结果，决定下一步或生成回复
```

### 2.3 正确流程图

```
┌──────────────────────────────────────────────────────┐
│  一次完整请求（不需要循环里独立调 LLM）                  │
│                                                      │
│  1. 流式调 LLM（stream: true）                        │
│     ↓                                                 │
│  2. streamResponse 解析 SSE                           │
│     ↓                                                 │
│  3. 检测到 tool_calls                                │
│     ├─ 本地工具 → IMtoAgent 拦截执行                   │
│     └─ 远端工具 → 等待后端 Agentic 结果                │
│     ↓                                                 │
│  4. 所有工具执行完，合并结果                            │
│     ↓                                                 │
│  5. 带完整结果的 messages 再次调 LLM（stream: true）   │
│     ↓                                                 │
│  6. LLM 生成最终回复 → streamResponse 输出给客户端     │
└──────────────────────────────────────────────────────┘
```

---

## 3. 重构方案

### 3.1 废弃 `tool-call-loop.ts`

当前文件的问题：
- 独立非流式调 LLM（多余）
- thinking 模式兼容复杂（400 bug 根源）
- 循环里每次只处理一种工具

### 3.2 新架构：流式拦截

在 `streamResponse` 中实现拦截逻辑，边解析边执行：

```
streamResponse 解析 SSE
    ↓
遇到 tool_calls delta → 收集完整 tool_call
    ↓
分类：本地 or 远端
    ↓
┌─ 本地工具 ──────────────────────────────┐
│  IMtoAgent.ToolRegistry.execute()       │
│  结果缓存                                 │
└─────────────────────────────────────────┘
┌─ 远端工具 ──────────────────────────────┐
│  保留给 LLM 后续处理                      │
│  （或注入占位结果）                       │
└─────────────────────────────────────────┘
    ↓
所有工具结果收集完 → 构建完整 messages
    ↓
发起第二次流式请求（带完整 tool 结果）
    ↓
streamResponse 输出最终回复
```

### 3.3 工具结果格式（保持不变）

本地和远端工具使用统一的 tool 消息格式：

```json
{
  "role": "tool",
  "tool_call_id": "call_xxx",
  "content": "执行结果文本"
}
```

LLM 只看 `tool_call_id` 匹配原始 tool_call 的 `id`，不关心执行来源。

---

## 4. 实施步骤

### Phase 1: 最小修复（先让当前能跑）

1. **修复 thinking 400**：tool-call loop 第一轮跳过 `thinking`
   - ✅ 已完成（`hasReasoningContent` 检查）
   - 状态：已部署，等待验证

### Phase 2: 流式拦截重构（正确方向）

1. **废弃 `executeToolCallLoop`**
   - 删除 `tool-call-loop.ts` 中的独立 LLM 调用
   - 保留工具分类（`isLocalTool`）和执行（`toolRegistry.execute`）逻辑

2. **改造 `streamResponse`**
   - 解析到 `tool_calls` 时判断是否为本地工具
   - 本地工具立即执行，结果缓存
   - 流结束后判断：有本地工具 → 发起第二次请求

3. **改造 `codex-proxy.ts`**
   - 移除 tool-call loop 入口逻辑
   - 所有请求统一走流式路径
   - 第二次请求带完整 tool 结果

### Phase 3: 并行执行优化

1. 同一次 tool_calls 中多个本地工具**并行执行**（`Promise.all`）
2. 远端工具占位文本改为等待后端实际结果（如果需要）

---

## 5. 约束与边界

### 5.1 本地工具列表

```typescript
function isLocalTool(name: string): boolean {
  return (
    name.startsWith('imtoagent_') ||  // IMtoAgent 内置工具
    name.startsWith('goal_') ||        // Goal 引擎工具
    name === 'get_weather'             // 内置天气工具
  );
}
```

### 5.2 工具格式

- 入参：OpenAI 兼容格式（`tool_calls[].function.name` + `tool_calls[].function.arguments`）
- 出参：`role: tool` + `tool_call_id` + `content`

### 5.3 不需要做的事

- ❌ 不需要在 loop 里独立调 LLM
- ❌ 不需要维护 thinking 模式的兼容性
- ❌ 不需要 fallback 到 direct streaming
- ❌ 不需要担心 LLM 感知执行来源

---

## 6. 风险评估

| 风险 | 影响 | 缓解 |
|---|---|---|
| streamResponse 中执行阻塞 SSE 流 | 用户体验卡顿 | 工具执行改为异步，不阻塞流解析 |
| 远端工具结果不可用 | LLM 收到占位文本 | 占位文本明确标注 "managed by upstream" |
| 并行执行超时 | 某个工具卡住 | 单工具超时（30s），超时后注入错误文本 |

---

## 7. 当前状态

- ✅ Phase 1（thinking 400 修复）已部署
- 📋 Phase 2（流式拦截）待评审
- Phase 3（并行优化）待 Phase 2 完成后实施
