# IMtoAgent 定时任务系统 — 全面审计报告 + 改进方案

> 审计范围：`heartbeat-scheduler.ts` · `task-poller.ts` · `heartbeat.ts` · `goal-engine.ts` · `goal-store.ts` · `goal-manager.ts` · `goal-types.ts` · `task-state.ts` · `tool-registry.ts`
> 审计时间：2026-06-04
> 版本基线：v0.4.6

---

## 一、架构总览

```
HEARTBEAT.md (人读文件)
    │
    ▼ parseHeartbeatTasks()
HeartbeatScheduler ── syncTasks() ──► TaskPoller (1s tick, 内存状态)
    │                                     │ fireTask → runTask → Agent → IM
    │
    ▼ processDueGoals()
GoalEngine ── GoalStore (JSON 持久化) ──► executeAgent → IM
    │
    ▼ precise triggers (setTimeout ≤ 30min)
```

---

## 二、问题清单（逐行核对后的真实问题）

### P0 — 必须修复

#### P0-1: 失败任务的告警缺失

**文件：** `task-poller.ts` `tick()` + `fireTask()` + `heartbeat-scheduler.ts` `runTask()`

**实际代码链路（经逐行确认）：**

`fireTask()` 在 try 之前就写了 `newState.lastRunAt = now` 并 `this.taskState.set(name, newState)`：
```typescript
const newState: TaskRunState = {
  lastRunAt: now,         // ← 在 try 之前就赋值了
  runCount: runState.runCount + 1,
  ...
};
this.taskState.set(name, newState);  // ← 立即持久化

try {
  await this.config.onTaskFire(task);  // ← runTask() 在这里执行
} catch (err: unknown) {
  result = 'error';
  throw err;
} finally {
  this.taskState.set(name, newState);  // ← finally 再次保存，lastRunAt 不变
  this.handleTaskCompletion(...);
  this.appendHistory(...);
}
```

**因此：失败任务不会在下一个 1s tick 立即重试。** `lastRunAt` 已更新为 `now`，`isTaskDue` 判断 `now - lastRunAt >= intervalMs` 会返回 false。interval 任务的下次执行会等够完整间隔。

**但存在真正的问题：**

`runTask()` 内部有自己的重试+退避+告警逻辑（maxRetries 轮重试，失败后 sendAlert）。但如果 `onTaskFire` 回调本身抛出**未捕获异常**（不是 `executeTaskWithTimeout` 返回的 'timeout'，而是 `Promise.race` 外的崩溃），异常会冒泡出 `fireTask` → `tick()` 的 `.catch` 只打了 log：
```typescript
promise.catch(err => {
  console.error(`[TaskPoller] Error firing task ${name}:`, err.message);
  this.taskLocks.delete(name);
});
```

这意味着：**TaskPoller 层面的回调崩溃不会触发任何告警**，也不会触发 `runTask()` 里的 retry/backoff 循环。告警逻辑完全在 `runTask()` 内部，但 `runTask()` 如果本身崩溃了，告警就不会执行。

**影响：** 任务静默失败，用户无感知

**修复：** `tick()` 的 `.catch` 应调用一个 `onTaskError` 回调，让 scheduler 有机会做告警和重试决策：
```typescript
promise.catch(err => {
  console.error(`[TaskPoller] Error firing task ${name}:`, err.message);
  this.taskLocks.delete(name);
  // 新增：通知调度层
  if (this.config.onTaskError) {
    this.config.onTaskError(task, err);
  }
});
```

---

### P1 — 应该修复

#### P1-1: 双引擎高度冗余（TaskPoller + GoalEngine）

两套系统做的事本质相同：到期检测 → 调 Agent → 发 IM → 写历史。代码量合计约 2000 行，重复逻辑包括：

| 能力 | TaskPoller | GoalEngine | 重复度 |
|------|-----------|------------|--------|
| 到期检测 | `isTaskDue()` | `isGoalDue()` + `getDue()` | 高 |
| 执行锁 | `taskLocks` Map | `GoalStore` 锁 | 中 |
| 状态持久化 | `TaskState` (JSON) | `GoalStore` (JSON) | 高 |
| 历史记录 | `appendHistory()` | `writeGoalHistory()` | 高 |
| 超时控制 | `Promise.race` + AbortController | `Promise.race` + AbortController | 完全一致 |
| 结果解析 | 无（依赖 Agent 回复） | `parseGoalResult()` | - |

**影响：** 维护成本高，加新功能要改两处，行为可能不一致

**方案：** 合并为统一的 `Scheduler` 抽象，Task 和 Goal 作为两种"调度条目"共享执行引擎

---

#### P1-2: 状态全在内存，进程重启丢失

**文件：** `task-poller.ts` `tasks: Map` · `taskLocks: Map` · `inFlight: Set`

TaskPoller 的任务列表完全内存管理。进程重启后：
- `runCount` 从 `task_state.json` 恢复 → ✅ 可以恢复
- `tasks` 列表从 HEARTBEAT.md 重新解析 → ✅ 可以恢复
- `taskLocks` → ❌ 全部丢失 → 重启后所有任务立即触发
- `inFlight` → ❌ 全部丢失 → 正在执行的任务状态不明

**真正有风险的场景：** once 任务执行到一半进程挂了。`task_state.json` 的 `lastRunAt` 已更新（`fireTask` 在 try 之前设的），但 Agent 执行被中断。重启后 once 任务因为 `lastRunAt` 已更新，不会再次触发 → **用户收到不完整的执行结果但不知道**。

**修复：** 引入 `running` 状态标记，进程启动时扫描 `task_state.json`，标记 `lastResult` 未完成的任务为 interrupted 并重置。

---

#### P1-3: 1s 轮询 × 全量遍历，效率随任务数线性退化

当前实现：
```typescript
for (const [name, entry] of this.tasks) {
    const due = isTaskDue(task, lastRunAt, now, entry.createdAt, runState.runCount);
    if (due.due) { /* fire */ }
}
```

每秒遍历全部任务，每个都调 `isTaskDue`（含字符串解析和时间计算）。任务少时没问题，但 50+ 任务时浪费明显。

**修复：** 引入优先队列（按 nextRunAt 排序），tick 时只检查队首是否到期。O(1) vs O(n)。

---

#### P1-4: pauseGoal 复用 cancelled 状态（语义混用）

**文件：** `goal-manager.ts` `pauseGoal()`

```typescript
goal.lifecycle.status = 'cancelled';   // 复用 cancelled 表示暂停
goal.lifecycle.lastError = '_paused';  // 用 lastError 存暂停标记
```

**实际问题：**
1. `cancelled` 和 `paused` 语义完全不同，查询时无法区分
2. `lastError` 存特殊标记 `_paused` 是 hack
3. 恢复时靠 `goal.lifecycle.lastError === '_paused'` 判断，脆弱

**之前误报：cleanup 不会误删。** `cleanup()` 逻辑：
```typescript
if (goal.lifecycle.status === 'done' || goal.lifecycle.status === 'cancelled') {
  if (goal.lifecycle.expiresAt && new Date(goal.lifecycle.expiresAt) <= now) {
    this.goals.delete(id);
  }
}
```
暂停的 Goal 通常没有 `expiresAt`，所以不会被清理。但语义混用本身是真问题。

**修复：** 新增 `paused` 状态

---

### P2 — 设计改进

#### P2-1: `parseGoalManagement` 正则边界

**文件：** `goal-manager.ts`

```typescript
{ regex: /GOAL_CANCEL:\s*([\w-]+)/i, action: 'cancel' as const },
```

当前 Goal ID 格式 `goal_xxxxxxxxxxxxxxxx`（16 位 hex），`\w` 可以匹配。但未来如果 ID 格式变化（如 UUID 带 `-`）就会部分失败。

**修复：** 用 `([a-zA-Z0-9_-]+)` 或 `(.+?)$` 更宽容

---

#### P2-2: GoalEngine 串行执行

**文件：** `goal-engine.ts` `processDueGoals()`

```typescript
for (const goal of dueGoals) {
    await this.executeGoal(goal, stats);
}
```

3 个 Goal 同时到期，每个 30 秒 → 总共 90 秒。后面的可能错过最佳执行窗口。

**修复：** 引入并发度控制（信号量），至少支持 2-3 个 Goal 并行

---

#### P2-3: `appendHistory` 使用 Bun API

**文件：** `task-poller.ts` `appendHistory()`

```typescript
const existing = Bun.file(historyPath);
entries = JSON.parse(Bun.readFileSync(existing, 'utf8'));
Bun.write(historyPath, JSON.stringify(entries, null, 2));
```

`Bun.file()` / `Bun.readFileSync()` / `Bun.write()` 是 Bun 专属。项目**当前运行在 Bun 上**，所以这不是 bug，但如果未来要迁移到 Node.js（如部署到服务器），这些调用全部失败。

**建议：** 统一用 `fs.readFileSync` / `fs.writeFileSync`，与 `writeGoalHistory()` 保持一致。改动量小，收益是代码风格统一。

---

#### P2-4: `parseDateTime` 时区假设隐式

**文件：** `heartbeat.ts` `parseDateTime()`

```typescript
return new Date(y, mo - 1, d, h, mi).getTime();  // 使用本地时区
```

在 Mac 本地跑没问题（Asia/Shanghai）。但如果部署到 UTC 服务器，用户填的 "2026-06-04 09:00" 会被当成 UTC 09:00，差 8 小时。

**修复：** 显式指定时区，或加注释声明假设

---

#### P2-5: 无 cron 表达式支持

当前 TaskPoller 只支持 `interval`（"5m"），不能表达"工作日每天早上 9 点"。GoalEngine 的 `goal-types.ts` 定义了 `cron` 触发器，但 TaskPoller 的任务系统完全不支持。两套系统能力不统一。

**修复：** 为 TaskPoller 引入 cron 表达式（可用 `cron-parser` 库）

---

### ✅ 已确认不存在的问题

| 编号 | 描述 | 结论 |
|------|------|------|
| ~~once 失败被误删~~ | `handleTaskCompletion` 只在 `result === 'success'` 时删除 | ✅ 代码正确 |
| ~~失败后立即重试~~ | `fireTask` 在 try 前就设置了 `lastRunAt = now`，`isTaskDue` 会等够 interval | ✅ 代码正确 |
| ~~syncTasks 读到中间态~~ | `fs.readFileSync` 是同步操作，OS 保证读到一致快照 | ⚠️ 风险极低 |
| ~~pauseGoal 被 cleanup 误删~~ | cleanup 只在 `expiresAt` 到期时才删除，暂停 Goal 通常无 expiresAt | ✅ 不会误删 |
| ~~Bun API 不可移植~~ | 项目明确用 Bun 运行时，这是设计选择 | ⚠️ 不是 bug，是技术债 |

---

## 三、改进方案（优先级排序）

### Phase A：修 Bug（1 天）

| 优先级 | 项目 | 改动范围 | 风险 |
|--------|------|---------|------|
| P0-1 | TaskPoller 增加 `onTaskError` 回调 | `task-poller.ts` + `heartbeat-scheduler.ts` | 低 |
| P1-4 | Goal 新增 `paused` 状态 | `goal-types.ts` + `goal-store.ts` + `goal-manager.ts` | 中 |

### Phase B：状态持久化（2-3 天）

| 优先级 | 项目 | 改动范围 | 风险 |
|--------|------|---------|------|
| P1-2 | 任务状态启动时恢复 + interrupted 检测 | `task-poller.ts` + `task-state.ts` | 中 |
| P2-4 | parseDateTime 时区显式化 | `heartbeat.ts` | 低 |

### Phase C：架构优化（5-7 天）

| 优先级 | 项目 | 改动范围 | 风险 |
|--------|------|---------|------|
| P1-1 | 合并 TaskPoller + GoalEngine 为统一 Scheduler | 大面积重构 | 高 |
| P1-3 | 优先队列替代全量遍历 | `task-poller.ts` | 中 |
| P2-2 | GoalEngine 并发执行 | `goal-engine.ts` | 中 |
| P2-5 | cron 表达式支持 | `heartbeat.ts` + `task-poller.ts` | 中 |

### Phase D：锦上添花（按需）

| 优先级 | 项目 | 说明 |
|--------|------|------|
| P2-1 | 完善 parseGoalManagement 正则 | 1 行改动 |
| P2-3 | appendHistory 改 fs API | 风格统一，非必须 |
| - | 精确触发窗口改为可配置 | 30min 硬编码改配置 |
| - | 任务执行超时动态调整 | 根据历史自适应 |
| - | 任务执行仪表盘 | Web UI 或 CLI 实时状态 |

---

## 四、当前评分

| 维度 | 评分 | 说明 |
|------|------|------|
| 架构分层 | 8/10 | 调度→轮询→执行，边界清晰 |
| 功能完整性 | 6/10 | 缺少 cron、状态恢复、并发 |
| 代码质量 | 7/10 | 注释好，但有重复代码和 Bun API 不一致 |
| 可靠性 | 7/10 | 失败任务不会立即重试（之前误报），但告警缺失是真问题 |
| 可维护性 | 6/10 | 双引擎冗余，2000 行同类逻辑 |

**总评：6.8/10 — 能跑，比初版评估好一些（修正了几个误报），但架构债务在累积**

---

## 五、修订说明（vs 初版）

| 初版描述 | 修正后 | 原因 |
|----------|--------|------|
| P0-1: once 失败被误删 | ✅ 不存在，代码正确 | 调用链追踪确认 |
| P0-2: 失败后立即重试无退避 | ✅ 不存在，代码正确 | `fireTask` try 前已设 `lastRunAt` |
| P0-2: 新增告警缺失 | 🆕 真问题 | TaskPoller catch 只 log 不告警 |
| P1-4: syncTasks 原子读风险 | ⚠️ 降级 | `fs.readFileSync` 是同步操作 |
| P2-1: pauseGoal 被 cleanup 误删 | ✅ 不会误删 | cleanup 检查 expiresAt |
| P2-4: Bun API 不可移植 | ⚠️ 降级为建议 | 项目明确用 Bun |
