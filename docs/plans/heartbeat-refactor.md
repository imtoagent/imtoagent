# 心跳系统重构方案

> 状态：V1.0 草稿 | 日期：2026-06-04
> 核心原则：心跳 = 定时器，只提供时间维度。Task/Goal 才是执行主体。

---

## 〇、设计原理

### 当前问题

IMtoAgent 目前是**被动响应**系统：用户发消息 → Agent 回复。心跳机制被设计成了"心跳问答"：

```
心跳 tick
  │
  ├─ 读取 HEARTBEAT.md
  ├─ 提取非 tasks prompt（"规则"段落等）
  ├─ 调 Agent 执行这段 prompt
  ├─ output-router 过滤回复（HEARTBEAT_OK/重复/短噪音）
  ├─ 同步 tasks 到 TaskPoller
  └─ 执行 Goal Engine
```

**问题**：
1. 心跳 tick 耦合了"HEARTBEAT.md prompt 问答"和"Task/Goal 时间维度"两件事
2. 每次心跳都调 Agent 执行一段可能无意义的 prompt，浪费 token
3. Task 和 Goal 的到期检测被嵌套在心跳的 Agent 调用流程之后
4. 输出路由（output-router）在 Agent 生成回复**之后**过滤，token 已经消耗了
5. 过度依赖后端 agentic 对接，把简单的心跳做复杂了

### 正确的设计

```
心跳 tick（固定间隔，纯定时器）
  │
  ├─ Task 系统：TaskPoller.tick() → isTaskDue() → 到期 → 执行
  │
  └─ Goal 系统：GoalStore.getDue() → isGoalDue() → 到期 → 执行
```

**心跳不管具体执行逻辑，只负责定期"敲钟"。**

---

## 一、目标

| 维度 | 当前 | 重构后 |
|---|---|---|
| 心跳职责 | 读 HEARTBEAT.md → 调 Agent → 过滤回复 + 同步 Task + 执行 Goal | 固定间隔 tick → 触发 Task/Goal 到期检测 |
| Token 消耗 | 每次心跳都调 Agent（可能无意义 prompt） | 只有 Task/Goal 到期时才调 Agent |
| 架构层次 | 心跳 + 问答 + Task + Goal 耦合 | 心跳（定时）→ Task/Goal（执行），层次清晰 |
| HEARTBEAT.md 角色 | prompt 来源 + 任务定义文件 | 纯任务定义文件 |

---

## 二、重构方案

### 2.1 模块职责重定义

```
┌─────────────────────────────────────────────────┐
│ HeartbeatScheduler                               │
│  职责：固定间隔 tick，提供时间维度                  │
│  - setTimeout 循环，不依赖 Agent                   │
│  - 不读取 HEARTBEAT.md 的 prompt 部分              │
│  - tick 时调用 TaskPoller 和 GoalEngine            │
└──────────────┬──────────────────────────────────┘
               │ tick()
    ┌──────────┴──────────┐
    ▼                     ▼
┌────────────┐      ┌────────────┐
│ TaskPoller │      │ GoalEngine │
│  到期检测   │      │  到期检测   │
│  执行任务   │      │ 执行目标    │
│  (调 Agent) │      │ (调 Agent) │
└────────────┘      └────────────┘
```

### 2.2 HeartbeatScheduler 重构

**删除/简化**：
1. ❌ 删除 `readHeartbeatFile()` — 不再读取 HEARTBEAT.md 内容作为 prompt
2. ❌ 删除 `stripHeartbeatTasksBlock()` 调用 — 不再有"非 tasks prompt"
3. ❌ 删除心跳 prompt 构建和 Agent 调用（`processMessage` 在心跳层面不再调用）
4. ❌ 删除心跳 session 的 `reply` 回调（不再需要过滤回复）
5. ❌ 删除 `lastHeartbeatText` 去重逻辑（不再发送心跳回复）
6. ❌ 删除 HEARTBEAT.md 空内容判断（`isHeartbeatContentEffectivelyEmpty`）
7. ❌ 删除连续失败计数和告警（不再有心跳层面的 Agent 调用失败）

**保留**：
1. ✅ `syncTasks()` — 从 HEARTBEAT.md 读取任务定义，同步到 TaskPoller
2. ✅ TaskPoller 和 GoalEngine 的初始化
3. ✅ 固定间隔 `setTimeout` 循环
4. ✅ 精确触发（precise triggers）优化

**新增**：
1. ✅ HEARTBEAT.md 文件监听（chokidar/fsevents）— 文件变更时自动同步 tasks，替代每次心跳都读文件
2. ✅ tick() 纯函数：`taskPoller.tick()` + `goalEngine.processDueGoals()`

### 2.3 新的 runHeartbeat() 流程

```typescript
private async runHeartbeat(): Promise<void> {
  const now = new Date();

  // 1. Task 系统：驱动到期检测和执
  // TaskPoller 内部是 1s tick，不需要心跳驱动
  // 但心跳可以作为"兜底检查"的时机
  // 实际上 TaskPoller 已经在独立运行，这里不需要额外调用

  // 2. Goal 系统：检查并执行到期 Goal
  try {
    const goalStats = await this.goalEngine.processDueGoals(now);
    if (goalStats.dueCount > 0) {
      console.log(
        `[Heartbeat] Goal Engine: due=${goalStats.dueCount} ` +
        `done=${goalStats.doneCount} skip=${goalStats.skipCount} ` +
        `fail=${goalStats.failedCount} (${goalStats.totalDurationMs}ms)`,
      );
    }
  } catch (e: any) {
    console.error(`[Heartbeat] Goal Engine error:`, e.message);
  }

  // 3. 清理已处理 Goal 的精确触发器
  this.syncPreciseTriggers();

  // 4. 同步 HEARTBEAT.md tasks（仅在文件变更时）
  // 由文件监听器触发，不需要每次心跳都读
}
```

### 2.4 TaskPoller 独立运行

**当前**：TaskPoller 已经在 `start()` 后独立 1s tick，但依赖 `getSession()` 返回心跳 session 来读写状态。

**重构**：
- TaskPoller 完全独立，不依赖心跳 session
- 状态持久化到自己的 JSON 文件（`~/.imtoagent/task_state.json`），而不是 session 中
- HEARTBEAT.md 文件变更时通过监听器触发 `syncTasks()`

### 2.5 文件监听替代轮询读取

```typescript
import * as fs from 'fs';

// HEARTBEAT.md 文件监听
private startHeartbeatFileWatcher(): void {
  const watcher = fs.watch(this.config.heartbeatFilePath, (event) => {
    if (event === 'change') {
      console.log('[Heartbeat] HEARTBEAT.md changed, syncing tasks');
      const content = fs.readFileSync(this.config.heartbeatFilePath, 'utf-8');
      this.syncTasks(content);
    }
  });
  this.fileWatcher = watcher;
}
```

### 2.6 HEARTBEAT.md 格式简化

**当前**：
```markdown
## 规则
# 每次心跳触发时，Bot 会：
# 1. 读取此文件检查任务
# 2. 执行检查任务
# 3. 如果一切正常且无任务需要报告，回复 HEARTBEAT_OK

## tasks
- name: 出门提醒
  type: once
  at: 2026-06-03T18:12:00+08:00
  prompt: 提醒用户该出门了！
```

**重构后**（去掉"规则"段落，纯任务定义）：
```markdown
## tasks
- name: 出门提醒
  type: once
  at: 2026-06-03T18:12:00+08:00
  prompt: 提醒用户该出门了！
```

---

## 三、改动清单

### Phase 1: 核心重构（必须）

| # | 文件 | 改动 | 说明 |
|---|---|---|---|
| 1 | `heartbeat-scheduler.ts` | 重构 `runHeartbeat()` | 删除 prompt 读取/Agent 调用/过滤逻辑，只保留 Task/Goal 触发 |
| 2 | `heartbeat-scheduler.ts` | 删除 `executeGoalAgent()` 方法 | Goal Engine 自己注入 executeAgent，不需要心跳调度器包装 |
| 3 | `heartbeat-scheduler.ts` | 删除 `lastHeartbeatText` 字段 | 不再有心跳回复去重 |
| 4 | `heartbeat-scheduler.ts` | 删除 `consecutiveFailures` 字段 | 不再有心跳层面的 Agent 调用失败 |
| 5 | `heartbeat-scheduler.ts` | 删除 `heartbeatSession` 字段 | TaskPoller 不依赖心跳 session |
| 6 | `heartbeat-scheduler.ts` | 简化 `start()` | 只启动 TaskPoller + GoalEngine，不设置 phaseOffset |
| 7 | `heartbeat-scheduler.ts` | 删除 `syncTasks()` 的每次调用 | 改用文件监听 |
| 8 | `heartbeat-scheduler.ts` | 新增文件监听器 | HEARTBEAT.md 变更时自动 syncTasks |
| 9 | `heartbeat.ts` | 保留 `parseHeartbeatTasks()` | 任务解析逻辑不变 |
| 10 | `heartbeat.ts` | 删除 `stripHeartbeatTasksBlock()` | 不再有"非 tasks prompt"需求 |
| 11 | `heartbeat.ts` | 删除 `isHeartbeatContentEffectivelyEmpty()` | 不再判断内容是否为空 |
| 12 | `task-poller.ts` | 状态持久化独立 | 从 session 迁移到 `task_state.json` |
| 13 | `session-resolver.ts` | 删除 `resolveHeartbeat()` | 不再需要心跳 session |
| 14 | `output-router.ts` | 保留但简化 | 只保留 main/cron 过滤，删除 heartbeat 专用过滤 |

### Phase 2: 优化（可选）

| # | 改动 | 说明 |
|---|---|---|
| 1 | 心跳间隔可配置化 | 从"固定 5m"改为可配置，或直接用 node-cron |
| 2 | TaskPoller tick 优化 | 从 1s 轮询改为精确 setTimeout（已有 precise triggers 模式） |
| 3 | HEARTBEAT.md 格式校验 | 启动时校验文件格式，给出友好错误 |
| 4 | 任务状态查询 API | 暴露 `/tasks` HTTP 端点，方便调试 |

---

## 四、风险评估

### 4.1 破坏性变更

| 风险 | 影响 | 缓解 |
|---|---|---|
| `heartbeatSession` 删除 | TaskPoller 无法读写 session 状态 | Phase 1 中迁移到独立 JSON 文件 |
| `resolveHeartbeat()` 删除 | 依赖此方法的代码报错 | 同步删除所有引用 |
| output-router 简化 | 可能影响 cron session 过滤 | 保留 cron 过滤逻辑 |

### 4.2 测试策略

1. 修改 `heartbeat-scheduler.test.ts`：测试新 `runHeartbeat()` 只触发 Task/Goal
2. 修改 `task-poller.test.ts`：测试独立状态持久化
3. 新增 `heartbeat-file-watcher.test.ts`：测试文件监听自动同步
4. 所有现有测试应通过（不改变 Task/Goal 的公开 API）

---

## 五、实施步骤

```
Step 1: 新建 task-state-persist.ts（状态持久化独立）
Step 2: 修改 TaskPoller 使用新的持久化
Step 3: 重构 HeartbeatScheduler.runHeartbeat()
Step 4: 删除不需要的字段和方法
Step 5: 新增 HEARTBEAT.md 文件监听
Step 6: 简化 output-router
Step 7: 更新测试
Step 8: 更新 HEARTBEAT.md 模板
Step 9: 更新文档
```

预计工作量：**2-3 小时**（代码改动约 200 行，主要是删除和简化）

---

## 六、重构后的架构全景

```
用户对话 ──► AgentRuntime ──► 被动回复
                    ▲
                    │（注入 executeAgent）
                    │
┌───────────────────┤
│ HeartbeatScheduler│
│  固定间隔 tick     │
├────────┬──────────┤
│        │          │
│  TaskPoller    GoalEngine
│  (1s tick)    (到期检测)
│     │             │
│  isTaskDue     isGoalDue
│     │             │
│  到期 → 调 Agent  到期 → 调 Agent
│     │             │
│  执行 → IM 发送   执行 → IM 发送
│                     │
│                  GoalManager（用户对话管理 Goal）
└─────────────────────┘

HEARTBEAT.md ──► 文件监听 ──► syncTasks ──► TaskPoller
```

**关键区别**：
- 心跳不再调 Agent
- Task/Goal 到期时才调 Agent
- 层次清晰：心跳（定时）→ Task/Goal（执行）→ Agent（落地）

---

## 七、验收标准

- [ ] `runHeartbeat()` 不调用 `runtime.processMessage`
- [ ] Task 到期时正常执行（Agent 调用在 TaskPoller 内部）
- [ ] Goal 到期时正常执行（Agent 调用在 GoalEngine 内部）
- [ ] HEARTBEAT.md 变更后自动同步（文件监听）
- [ ] 不再有心跳回复过滤逻辑
- [ ] 所有测试通过
- [ ] HEARTBEAT.md 模板只包含 tasks 段落
