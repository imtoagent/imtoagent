# 上下文膨胀问题：完整解决方案

**日期**: 2026-06-04  
**状态**: 待审核  
**作者**: CX (Codex Agent)

---

## 1. 问题全景

### 1.1 调用链路

定时任务和 Goal 的执行经过 4 层调用：

```
Heartbeat/Task 触发
  → heartbeat-scheduler.ts  (TaskPoller / GoalEngine)
    → runtime.ts             (AgentRuntime.processMessage)
      → adapter               (Codex / Claude / OpenCode / Gemini)
        → proxy               (anthropic-proxy / codex-proxy)
          → 上游 API           (DeepSeek / 百炼 / 小米 etc.)
```

每一层理论上都可能累积上下文，需要逐层分析。

### 1.2 两条执行路径

| | **TaskPoller 路径** | **GoalEngine 路径** |
|---|---|---|
| 触发来源 | `HEARTBEAT.md` 中的定时任务 | `goals.json` 中的 Goal（通过 `create_goal` 工具） |
| session 键 | `botKey:cron:taskName`（每个任务独立） | `botKey:heartbeat`（所有 Goal 共享一个） |
| 上下文清理 | 有 `MAX_CRON_ROUNDS=10` | **无** |

### 1.3 上下文累积矩阵

以下矩阵表示「某条执行路径 + 某个 adapter」是否会产生上下文累积，以及是否有清理机制：

| 路径 | Codex | Claude | OpenCode | Gemini |
|------|:-----:|:------:|:--------:|:-----:|
| **TaskPoller** | ✅ 累积<br>⚠️ `MAX_CRON_ROUNDS=10` | ✅ 累积<br>🔴 无清理 | ✅ 累积<br>🔴 无清理 | ✅ 无累积<br>🟢 天然隔离 |
| **GoalEngine** | ✅ 累积<br>🔴 无清理 | ✅ 累积<br>🔴 无清理 | ✅ 累积<br>🔴 无清理 | ✅ 无累积<br>🟢 天然隔离 |

**严重程度**:
- 🟢 安全：2/8 组合
- ⚠️ 有防护但不够彻底：1/8（TaskPoller + Codex，10轮后才清理）
- 🔴 完全无防护：5/8 组合

### 1.4 为什么会累积

各 adapter 的「复用 session」机制：

| Adapter | Session 标识 | 存储位置 | 复用逻辑 |
|---------|-------------|---------|---------|
| Codex | `codexThreadId` | `sessionAny.codexThreadId` + `session.metadata.codexThreadId` | app-server `turn/start` 往同一个 thread 追加，自动带全部历史 |
| Claude | `sdkSessionId` | `sessionAny.sdkSessionId` + `session.metadata.sdkSessionId` | `query({ resume: sdkSessionId })` SDK 内部全量历史 |
| OpenCode | `ocSessionId` | `sessionAny.ocSessionId` + `session.metadata.ocSessionId` | `/session/{id}/message` HTTP API 全量历史 |
| Gemini | `geminiSessionId` | `session.metadata.geminiSessionId` | **不复用**，每次 `spawn('gemini', ...)` 独立进程 |

**Gemini 除外，其余三个 adapter 只要 session 不清除，就会把历史 tool-calls 和回复全部带入下次执行。**

### 1.5 GoalEngine 的特殊问题

GoalEngine 的 `executeGoalAgent()` 所有 Goal 共享 `botKey:heartbeat` 这个 session。这导致：

1. Goal A（天气检查）执行 → session 中累积 A 的全部 tool-calls
2. Goal B（磁盘检查）执行 → 模型看到 A 的历史 + B 的 prompt
3. Goal C（日报生成）执行 → 模型看到 A+B 的历史 + C 的 prompt
4. 无限增长，直到进程重启

而 TaskPoller 路径至少每个任务有独立的 `botKey:cron:taskName` session，不会跨任务污染。

### 1.6 Proxy 层视角

Proxy 层（`codex-proxy.ts` / `anthropic-proxy.ts`）收到的是 **adapter 已构造好的完整 messages 数组**。这个 messages 已经包含了全部累积历史。Proxy 只做格式转换（Anthropic ↔ OpenAI）和透传，不做任何裁剪。Proxy 层不是问题的根源，但可以作为兜底防护层。

### 1.7 Runtime `startFresh` 的局限

`runtime.ts` 的 `startFresh` 清理逻辑（第 181-189 行）当前只清理了 Codex 的字段：

```typescript
if (session.startFresh) {
  session.backendSessionId = undefined;
  session.metadata = {};    // ← 清空了整个 metadata！
  const s = session as Record<string, unknown>;
  delete s.codexThreadId;   // ← 只删了 Codex 的
  delete s._appServerGen;   // ← 只删了 Codex 的
}
```

注意：`session.metadata = {}` 已经清空了 metadata，所以 `metadata.sdkSessionId`、`metadata.ocSessionId`、`metadata.geminiSessionId` 都会被清掉。**但**各 adapter 读取 session ID 时用的是 `sessionAny.xxxId || session.metadata?.xxxId` 的双路径模式——`metadata` 清空了，但 `sessionAny.sdkSessionId` 等顶层字段**不在清理范围内**。

---

## 2. 解决方案

### 2.1 设计原则

1. **定时任务不需要上下文**：每次任务执行是独立的，应使用全新 session
2. **Goal 执行也不需要上下文**：不同 Goal 之间不应互相污染
3. **防护要跨 adapter 统一**：不能只针对 Codex，Claude/OpenCode 同等对待
4. **兜底防护在 Runtime 层**：无论哪条路径触发，Runtime 层统一检查并清理

### 2.2 修改计划（4 个步骤）

#### 步骤 1：Runtime `startFresh` 完整清理（兜底层）

**文件**: `modules/core/runtime.ts`  
**位置**: `_processMessageInternal` 中 startFresh 处理块（~181-189行）

**现状**:
```typescript
if (session.startFresh) {
  session.backendSessionId = undefined;
  session.metadata = {};
  session.startFresh = false;
  session.running = false;
  const s = session as Record<string, unknown>;
  delete s.codexThreadId;
  delete s._appServerGen;
}
```

**改为**:
```typescript
if (session.startFresh) {
  session.backendSessionId = undefined;
  session.metadata = {};
  session.startFresh = false;
  session.running = false;
  // 清除所有 adapter 特定的 session/thread ID
  const s = session as Record<string, unknown>;
  delete s.codexThreadId;
  delete s._appServerGen;
  delete s.sdkSessionId;        // Claude
  delete s.ocSessionId;          // OpenCode
  delete s.geminiSessionId;      // Gemini
}
```

**影响**: 当 `session.startFresh = true` 时，所有 adapter 都会重建 session。这是兜底——如果上层忘了设 `startFresh`，这里不会触发。

---

#### 步骤 2：GoalEngine 每次执行前设置 `startFresh`（核心修复）

**文件**: `modules/core/heartbeat-scheduler.ts`  
**位置**: `executeGoalAgent` 方法（~322-370行）

**现状**: 所有 Goal 共享 `botKey:heartbeat` session，每次复用，不设 `startFresh`。

**改为**: 每次执行 Goal 前，对 session 设 `startFresh = true`。或更彻底——每个 Goal 使用独立 session。

**方案 A（推荐）**: 每次执行前设 `startFresh`：

```typescript
private async executeGoalAgent(prompt: string, options?: {...}): Promise<string> {
  const target = this._resolver.resolveHeartbeat();
  const session = await this._resolver.getOrCreateSession(target);
  
  // 新增：每次 Goal 执行都使用全新上下文
  session.startFresh = true;
  
  // ... 其余不变
}
```

优点：改动最小，一行代码。
缺点：仍然所有 Goal 共享同一个 session 键，只是每次重建 thread。session 文件中的 stats 仍会累积（但这不是上下文膨胀问题，是统计问题）。

**方案 B（更彻底）**: 按 Goal ID 分配独立 session：

```typescript
// 修改 resolveHeartbeat → resolveGoal(goalId)
resolveGoal(goalId: string): ResolveTargetResult {
  const sessionKey = `${this.botKey}:goal:${goalId}`;
  return { chatId: sessionKey, sessionKey, sessionType: 'cron' };
}
```

优点：不同 Goal 完全隔离，便于调试和独立管理。
缺点：改动稍大，需要新增 `resolveGoal` 方法。

**推荐先实施方案 A，后续按需升级到方案 B。**

---

#### 步骤 3：TaskPoller 跨 adapter 清理 `MAX_CRON_ROUNDS`（统一防护）

**文件**: `modules/core/heartbeat-scheduler.ts`  
**位置**: `executeTaskWithTimeout` 方法（~397-405行）

**现状**: 只清理了 Codex 的 `codexThreadId` 和 `_appServerGen`：

```typescript
if (cronRounds >= MAX_CRON_ROUNDS) {
  delete sessionAny.codexThreadId;
  delete sessionAny._appServerGen;
  sessionAny._cronRounds = 0;
  session.startFresh = true;
}
```

**改为**: 清理所有 adapter 的 session ID，统一走 `startFresh`：

```typescript
if (cronRounds >= MAX_CRON_ROUNDS) {
  // 清除所有 adapter 特定的 session/thread ID
  delete sessionAny.codexThreadId;
  delete sessionAny._appServerGen;
  delete sessionAny.sdkSessionId;
  delete sessionAny.ocSessionId;
  delete sessionAny.geminiSessionId;
  sessionAny._cronRounds = 0;
  session.startFresh = true;
}
```

**影响**: 当 TaskPoller 任务的 session 达到 10 轮后，无论使用哪个 adapter 都会重建上下文。

---

#### 步骤 4（可选）：Proxy 层 Token 预算兜底

**文件**: `modules/proxy/anthropic-proxy.ts`（Anthropic 格式）和 `modules/proxy/codex-proxy.ts`（OpenAI 格式）  
**位置**: 转发请求到上游 API 之前

**方案**: 在转发前检查 messages 数组总 token 估算，超过阈值（如 50K tokens）时裁剪历史：

- 保留 `system` message
- 保留最后 N 轮 user/assistant/tool 交互（如 3 轮）
- 丢弃中间的旧历史

**优先级**: 低。这是最后兜底，前三个步骤已能覆盖主要场景。如果上游 API 有 context window 限制（如 DeepSeek 的 128K），这层可以作为安全网。

---

### 2.3 修改总结

| 步骤 | 文件 | 改动量 | 优先级 | 说明 |
|------|------|:---:|:---:|------|
| 1 | `runtime.ts` | 3 行 | 🔴 高 | startFresh 清理补全 |
| 2 | `heartbeat-scheduler.ts` | 1-5 行 | 🔴 高 | GoalEngine 每次 fresh |
| 3 | `heartbeat-scheduler.ts` | 3 行 | 🟡 中 | TaskPoller 跨 adapter 清理 |
| 4 | proxy 层 | ~30 行 | 🟢 低 | Token 预算兜底 |

---

## 3. 不影响的功能

以下功能不受影响：

- **IM 对话上下文**: 用户正常 IM 对话的 session（`botKey:chatId`）不在此修改范围内，继续保留多轮记忆
- **TaskPoller 的 once 任务**: 只执行一次后自动删除，不受 MAX_CRON_ROUNDS 影响
- **TaskPoller 的 scheduled 任务**: 每天触发一次，10 轮 = 10 天后才清理，不会在当天内丢失上下文
- **Gemini adapter**: Gemini 每次独立进程，天然不累积，修改对它无副作用
- **TaskPoller 任务状态（task_state.json）**: 这是独立的持久化文件，不受 session 清理影响

## 4. 需要讨论的点

1. **MAX_CRON_ROUNDS 的值**: 当前是 10，是否合适？
   - 对于 interval=5m 的任务，10 轮 = 50 分钟后清理
   - 对于 interval=1h 的任务，10 轮 = 10 小时后清理
   - 建议保持 10，或可配置为 `BotConfig.heartbeat.maxCronRounds`

2. **GoalEngine 方案选择**: 方案 A（每次 startFresh）还是方案 B（独立 session）？
   - 方案 A 更简单，一步到位
   - 方案 B 更干净但改动多，可能引入新 bug
   - 建议先用 A，观察效果

3. **日志文件膨胀**: 上次清空后，`imtoagent.log` 等日志是否会随任务执行而快速增长？是否需要日志轮转？

---

## 5. 实施检查清单

- [ ] 步骤 1: `runtime.ts` startFresh 补全（含单元测试？）
- [ ] 步骤 2: `heartbeat-scheduler.ts` executeGoalAgent 设 startFresh
- [ ] 步骤 3: `heartbeat-scheduler.ts` executeTaskWithTimeout MAX_CRON_ROUNDS 补全
- [ ] 重启 gateway 验证
- [ ] 创建测试 Goal 观察是否每次用新 thread
- [ ] 创建间隔任务观察 10 轮后是否重建
- [ ] 检查 `imtoagent.log` 确认无异常
