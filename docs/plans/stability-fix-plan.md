# 稳定性修复计划

> 创建时间: 2026-06-04
> 范围: Goal Engine + TaskPoller + Heartbeat Scheduler
> 原则: 先修资源泄漏和状态卡死，再做防御性优化

---

## 风险总览

| # | 风险 | 级别 | 影响 | 涉及文件 |
|---|------|------|------|----------|
| 1 | `once` 任务失败也被删除 | 🔴 P0 | 临时故障 → 永久丢失 | `task-poller.ts` |
| 2 | Goal 超时不取消 Agent（资源泄漏） | 🔴 P0 | 每次超时留一个孤儿进程 | `goal-engine.ts` |
| 3 | `unknown` 结果 → 可重复 Goal 卡死 | 🔴 P0 | 重复 Goal 永久停止 | `goal-engine.ts` |
| 4 | TaskState persist 错误被静默吞掉 | 🟡 P1 | 状态丢失无告警 | `task-poller.ts` |
| 5 | 锁超时不取消底层任务 | 🟡 P1 | 孤儿进程等 shutdown 才清理 | `task-poller.ts` |
| 6 | 串行 Goal 阻塞心跳 | 🟡 P1 | 10 Goal × 60s = 心跳停 10 分钟 | `goal-engine.ts` |
| 7 | 三条路径无全局并发控制 | 🟡 P2 | 用户消息与后台任务争抢 | 全局 |

---

## 修复 1: `once` 任务失败不应自动删除

### 问题

`task-poller.ts:290` — `fireTask()` 的 `finally` 块无条件调用 `handleTaskCompletion()`：

```
try {
  await this.config.onTaskFire(task);   // ← 可能抛异常
} finally {
  // ... 统计 ...
  this.handleTaskCompletion(entry, name, newState);  // ← 异常时也执行！
}
```

`handleTaskCompletion` (line 323) 对 `once` 类型直接 `this.tasks.delete()`，**不管成功还是失败**。

### 修复方案

**判断依据**: `fireTask` 已经维护了 `result` 变量（`'success' | 'timeout' | 'error'`），只需在 `handleTaskCompletion` 中检查它。

```diff
  // fireTask — finally 块，把 result 传入
- this.handleTaskCompletion(entry, name, newState);
+ this.handleTaskCompletion(entry, name, newState, result);

  // handleTaskCompletion 签名
- private handleTaskCompletion(entry, name, runState): void
+ private handleTaskCompletion(entry, name, runState, result: 'success' | 'timeout' | 'error'): void

  // 仅在成功时删除
- if (task.type === 'once') {
+ if (task.type === 'once' && result === 'success') {
    this.tasks.delete(entry.task.name);
    ...
  }
```

**失败行为**: `once` 任务失败后不删除，下次心跳重新尝试。用 `lastError` + `lastResult` 记录失败原因，用户可以通过状态查询看到。

### 影响范围

- `task-poller.ts`: `fireTask()` (L268-310), `handleTaskCompletion()` (L323+)
- 新增参数 `result` 传递到 `handleTaskCompletion`
- 现有测试需更新：验证 `once` 任务失败后仍存在

---

## 修复 2: Goal 超时必须真正取消 Agent

### 问题

`goal-engine.ts:349-360` — 使用 `Promise.race` 实现超时：

```typescript
const agentPromise = this.ctx.executeAgent(prompt, { timeoutMs });
reply = await Promise.race([
  agentPromise,
  new Promise<string>((_, reject) =>
    setTimeout(() => reject(new Error('execution_timeout')), timeoutMs),
  ),
]);
```

**问题**: `Promise.race` 只是"谁先完成取谁"，超时 reject 后 `agentPromise` 仍在后台运行——没有 `cancelSignal` 传递给 `executeAgent`。

**对比 Cron 路径** (`heartbeat-scheduler.ts:443-468`):

```typescript
const abortController = new AbortController();
// ...
const ctx = { cancelSignal: abortController.signal, ... };
```

Cron 的 `AbortController.signal` 通过 `MessageContext.cancelSignal` 传到底层 adapter（claude-adapter / gemini-adapter 都有 `AbortController` 管理），能真正中断 HTTP 请求。

### 修复方案

#### Step 1: 扩展 `GoalExecuteContext.executeAgent` 接口

```diff
  executeAgent: (
    prompt: string,
-   options?: { systemPrompt?: string; model?: string; timeoutMs?: number; tools?: object[] },
+   options?: {
+     systemPrompt?: string;
+     model?: string;
+     timeoutMs?: number;
+     tools?: object[];
+     cancelSignal?: AbortSignal;  // 新增
+   },
  ) => Promise<string>;
```

#### Step 2: `executeGoal` 中创建 AbortController

```diff
  private async executeGoal(goal: Goal, stats: GoalEngineStats): Promise<void> {
+   const abortController = new AbortController();
    const timeoutMs = this.ctx.timeoutMs || 60_000;
    try {
      // ... tool injection ...
      const agentPromise = this.ctx.executeAgent(prompt, {
        timeoutMs,
+       cancelSignal: abortController.signal,
        ...(tools && tools.length > 0 ? { tools } : {}),
      });
      reply = await Promise.race([
        agentPromise,
        new Promise<string>((_, reject) =>
          setTimeout(() => {
+           abortController.abort();  // 真正取消
            reject(new Error('execution_timeout'));
          }, timeoutMs),
        ),
      ]);
```

#### Step 3: 确保 finally 中清理

```diff
    } finally {
      if (this.ctx.toolRegistry && injectedTools.length > 0) {
        this.ctx.toolRegistry.removeInjected(injectedTools);
      }
+     if (!abortController.signal.aborted) {
+       abortController.abort();  // 确保清理
+     }
      this.store.releaseLock(goal.id);
    }
```

#### Step 4: 调用方适配

`goal-engine.ts` 的调用方（heartbeat.ts 或 runtime）在构造 `GoalExecuteContext` 时，需要让 `executeAgent` 能接收 `cancelSignal` 并传递到 adapter。

**实现方式**: 复用现有的 `MessageContext.cancelSignal` 模式。调用方（如 heartbeat scheduler 调用 GoalEngine 时）应使用已有的 cancelSignal 传递链路。

### 影响范围

- `goal-engine.ts`: `GoalExecuteContext` 接口 (L200-221), `executeGoal()` (L313-395)
- 调用方: 构造 `GoalExecuteContext` 的地方需要传递 `cancelSignal`
- 底层 adapter: claude-adapter / gemini-adapter 已支持 AbortController，无需修改
- 测试: 验证 Goal 超时后 adapter 的 activeControllers 被清理

---

## 修复 3: `unknown` 结果不应卡死可重复 Goal

### 问题

`goal-engine.ts:432-440` — `handleGoalResult` 对 `unknown` 的处理：

```typescript
case 'unknown':
default:
  this.store.markFailed(goal.id, 'no GOAL_DONE/SKIP/FAILED marker in reply');
  writeGoalHistory(goal.id, 'unknown', durationMs, 'no status marker', ...);
  // ← 没有 reschedule()！可重复 Goal 卡在 failed 状态
```

**对比 `done` 和 `skip`** (L409-422):

```typescript
case 'done':
  this.store.markDone(goal.id);
  if (goal.lifecycle.repeat !== 'once') {
    this.store.reschedule(goal.id);  // ← 有 reschedule
  }
```

### 修复方案

`unknown` 表示 Agent 回复格式不对（不是 Agent 执行失败），应当 **reschedule 下次重试**，而不是永久标记 failed：

```diff
  case 'unknown':
  default:
-   this.store.markFailed(goal.id, 'no GOAL_DONE/SKIP/FAILED marker in reply');
+   // unknown = Agent 回复格式不匹配，不视为永久失败
+   // 可重复 Goal 应当 reschedule 下次重试
+   if (goal.lifecycle.repeat !== 'once') {
+     this.store.reschedule(goal.id);
+     console.warn(`[GoalEngine] Goal ${goal.id} unknown reply, rescheduled for retry`);
+   } else {
+     // once 类型，unknown 也标记 failed（没有下次机会）
+     this.store.markFailed(goal.id, 'no GOAL_DONE/SKIP/FAILED marker in reply');
+   }
    writeGoalHistory(goal.id, 'unknown', durationMs, 'no status marker', ...);
```

### 防御增强（可选）: 连续 unknown 计数器

在 Goal metadata 中加 `consecutiveUnknowns`，连续 N 次 unknown 后标记 failed 防止无限循环：

```typescript
// GoalMetadata 新增字段
consecutiveUnknowns?: number;

// handleGoalResult 中
if (goal.lifecycle.repeat !== 'once') {
  const maxUnknowns = goal.lifecycle.maxUnknowns ?? 3;
  const currentUnknowns = (goal.metadata.consecutiveUnknowns ?? 0) + 1;
  if (currentUnknowns >= maxUnknowns) {
    this.store.markFailed(goal.id, `consecutive unknown replies (${currentUnknowns})`);
  } else {
    goal.metadata.consecutiveUnknowns = currentUnknowns;
    this.store.reschedule(goal.id);
  }
}
// done/skip 时重置
case 'done':
case 'skip':
  if (goal.metadata.consecutiveUnknowns) {
    delete goal.metadata.consecutiveUnknowns;
  }
  // ...
```

### 影响范围

- `goal-engine.ts`: `handleGoalResult()` (L397-440)
- `goal-types.ts`: 可选新增 `maxUnknowns` 字段到 GoalLifecycle
- 测试: 验证 unknown 结果后 Goal 状态正确更新

---

## 修复 4: TaskState persist 错误需要告警

### 问题

`task-poller.ts` — `TaskState.persist()` catch 块只 `console.error`，系统带着过期状态继续运行。

### 修复方案

```diff
  } catch (e) {
-   console.error('Failed to persist task state:', e);
+   const errMsg = `TaskState persist failed: ${e instanceof Error ? e.message : String(e)}`;
+   console.error(`[TaskPoller] ${errMsg}`);
+   // 尝试写入紧急状态文件
+   try {
+     const emergencyPath = path.join(this.config.workspaceDir || '.', 'task-state-emergency.json');
+     fs.writeFileSync(emergencyPath + '.tmp', JSON.stringify([...this.taskState.entries()], null, 2));
+     fs.renameSync(emergencyPath + '.tmp', emergencyPath);
+     console.error(`[TaskPoller] Emergency state saved: ${emergencyPath}`);
+   } catch (e2) {
+     console.error(`[TaskPoller] Emergency save also failed: ${e2}`);
+   }
  }
```

### 影响范围

- `task-poller.ts`: `TaskState.persist()` 方法
- 小幅增加磁盘写入（仅在异常时触发）

---

## 修复 5: 锁超时应取消底层任务

### 问题

`task-poller.ts:tick()` — 锁超时 120s 后 force-release + 更新 `lastRunAt`，但正在跑的 `onTaskFire` 不会被取消。

### 修复方案

锁超时机制需要与 `onTaskFire` 的执行关联起来。最简洁的做法是让 `fireTask` 返回一个带 cancel 能力的 promise，tick 中的锁超时逻辑可以调用 cancel。

**方案 A（轻量）**: 锁超时时不强制取消，但在日志中标注。`inFlight` Set 已经在 shutdown 时 `Promise.allSettled`，不会泄漏进程。此风险当前实际影响有限。→ **降级为 P2**

**方案 B（完整）**: 给 `fireTask` 加 AbortController，锁超时时 abort。改动较大，需要重构 `onTaskFire` 回调签名。→ **暂不实施**

**结论**: 降级为 P2，后续统一考虑。

---

## 修复 6: 并行化 Goal 执行

### 问题

`goal-engine.ts:278-286` — 串行执行：

```typescript
for (const goal of dueGoals) {
  await this.executeGoal(goal, stats);
}
```

10 个到期 × 60s = 600s 心跳阻塞。

### 修复方案

```diff
  for (const goal of dueGoals) {
-   await this.executeGoal(goal, stats);
+   promises.push(this.executeGoal(goal, stats).catch(err => {
+     console.error(`[GoalEngine] Unhandled error in ${goal.id}:`, err);
+   }));
  }
+ await Promise.allSettled(promises);
```

**顾虑**: 并发 Goal 可能互相干扰（比如都操作文件系统）。但这是用户自己定义的 Goal 的问题，引擎层不应限制——用户可以用条件或依赖来控制顺序。

**可选**: 加 `maxConcurrent` 配置项，默认 3，用 `p-limit` 风格的信号量控制。

### 影响范围

- `goal-engine.ts`: `processDueGoals()` (L259-305)
- 可选新增 `maxConcurrent` 到 GoalEngine 配置

---

## 修复 7: 全局并发控制（P2，后续）

### 问题

用户聊天、Goal 执行、Cron 任务三条路径都走 `runtime.processMessage` → Codex adapter，无优先级、无速率限制。

### 建议方向

- **用户消息优先**: 后台任务执行前检查是否有用户消息在等待
- **速率限制**: 同一时间最多 N 个并发 agent 调用
- **负载感知**: adapter 响应时间 > 阈值时自动降级并发度

**当前不实施**: 需要改动 runtime 核心调度逻辑，风险较高。建议先完成 P0 修复，观察系统表现后再决定。

---

## 实施顺序

### Phase 1: P0 紧急修复（本次）

1. **修复 2** — Goal 超时真正取消（资源泄漏，影响持续增长）
2. **修复 3** — unknown 结果 reschedule（Goal 卡死，功能缺陷）
3. **修复 1** — once 任务失败保留（数据丢失风险）

### Phase 2: P1 防御性优化（下次）

4. **修复 4** — TaskState persist 告警
6. **修复 6** — 并行 Goal 执行

### Phase 3: P2 架构优化（未来）

5. **修复 5** — 锁超时取消（降级）
7. **修复 7** — 全局并发控制

---

## 测试计划

每个修复都需要：

| 测试 | 修复 1 | 修复 2 | 修复 3 |
|------|--------|--------|--------|
| 正常路径不受影响 | ✅ | ✅ | ✅ |
| 异常路径正确行为 | ✅ once 失败保留 | ✅ 超时后进程终止 | ✅ unknown 后 reschedule |
| 边界条件 | 连续失败 | 连续超时 | 连续 unknown |
| 回归测试 | 全量 | 全量 | 全量 |

---

## 风险评估

| 修复 | 改动行数 | 风险 | 回滚策略 |
|------|----------|------|----------|
| 1 | ~15 行 | 低 — 仅增加一个参数传递 | 恢复旧逻辑 |
| 2 | ~25 行 | 中 — 接口变更，需调用方适配 | 保留 cancelSignal 可选 |
| 3 | ~20 行 | 低 — 仅修改状态机分支 | 恢复旧逻辑 |

---

## 实施记录（2026-06-04）

### ✅ Phase 1 全部完成

| 修复 | 状态 | 文件变更 |
|------|------|----------|
| Fix 1: once 失败保留 | ✅ 已合并 | `task-poller.ts` — `handleTaskCompletion` 增加 `result` 参数，仅 success 时删除 |
| Fix 2: Goal 超时真正取消 | ✅ 已合并 | `goal-engine.ts` — 新增 `cancelSignal` 传递到 `executeAgent`；`heartbeat-scheduler.ts` — `executeGoalAgent` 接收并注入 `cancelSignal` 到 `MessageContext` |
| Fix 3: unknown reschedule + 连续计数 | ✅ 已合并 | `goal-engine.ts` — unknown 分支改为 reschedule + `consecutiveUnknowns` 计数器；`goal-types.ts` — 新增 `maxUnknowns`（GoalLifecycle）和 `consecutiveUnknowns`（GoalMetadata）|

**测试结果**: 441 pass / 1 fail（pre-existing GoalStore reschedule-daily bug，与本次无关）

### 待实施

| 修复 | 计划 |
|------|------|
| Fix 4: TaskState persist 告警 | Phase 2 |
| Fix 6: 并行 Goal 执行 | Phase 2 |
| Fix 5/7: 锁超时取消 + 全局并发 | Phase 3 |
