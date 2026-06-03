# 任务系统完善计划

> 基于 2026-06-03 代码审计，Phase 1 调度引擎已落地，本文档列出后续完善事项。

---

## 现状概览

### 已完成
| 能力 | 状态 |
|------|------|
| 5 种任务类型（interval/once/scheduled/countdown/conditional） | ✅ |
| TaskPoller 统一轮询调度 | ✅ |
| 任务互斥锁 + 2分钟超时释放 | ✅ |
| 失败策略三级（ignore/alert/retry）+ 指数退避 | ✅ |
| once/after 相对延迟 + at 绝对时间 | ✅ |
| scheduled 的 on 约束（weekday/每月第N天） | ✅ |
| countdown max_runs + deadline | ✅ |
| 任务完成自动从 HEARTBEAT.md 删除 | ✅ |
| defaults 全局配置 | ✅ |
| 每个 cron 任务独立 session（botKey:cron:taskName） | ✅ |
| 心跳/任务回复路由到最后活跃 chatId | ✅ |

### 设计层面缺口
| 缺口 | 严重度 |
|------|--------|
| 没有任务状态查询接口（用户不知道任务运行情况） | 🔴 高 |
| 没有 CRUD 入口（全靠手改 HEARTBEAT.md） | 🔴 高 |
| conditional 是"假条件"（condition 字段只预留，未解析未注入） | 🔴 高 |
| bot 字段未解析（多 Bot 环境下所有任务对全部 Bot 可见） | 🟡 中 |
| isTaskDue 中 countdown max_runs 判断简化了 | 🟡 中 |
| 没有任务链/依赖/级联（上次路线图 P1） | 🟡 中 |
| 超时后无 cancel 机制（可能僵尸任务） | 🟢 低 |
| 缺少正计时（stopwatch） | 🟢 低 |

---

## Phase 2：补齐基础闭环（2-3 天）

### P2-1: conditional 真条件支持

**文件**: `modules/core/heartbeat.ts`

**目标**: 让 `condition` 字段真正工作，Agent 执行前先评估条件表达式。

**做法**:
- 在 `parseHeartbeatTasks` 中解析 `condition` 字段（当前已定义但未解析）
- 在 `runTask` 中：构建 prompt 时，把 `task.condition` 拼接到 prompt 前，格式如下：
  ```
  [条件检查] 如果当前不满足以下条件，请回复 SKIP_TASK：${task.condition}
  
  ${task.prompt}
  ```
- 在 `filterAndSend` 或 `runTask` 中：如果 Agent 回复 `SKIP_TASK`，不发送到 IM，视为本轮跳过

**HEARTBEAT.md 示例**:
```yaml
- name: weekend-backup-reminder
  type: conditional
  interval: 1h
  condition: "今天是周六或周日"
  prompt: "提醒老板做数据备份"
```

### P2-2: bot 字段解析 + 过滤

**文件**: `modules/core/heartbeat.ts`, `modules/core/task-poller.ts`

**目标**: 多 Bot 环境中，任务只对匹配的 Bot 生效。

**做法**:
- `parseHeartbeatTasks` 中解析 `bot` 字段，存入 `ScheduledTask.bot`
- `TaskPoller.syncTasks` 新增 `botName` 参数，同步时过滤：如果 `task.bot` 存在且不等于当前 `botName`，跳过
- `HeartbeatScheduler.syncTasks` 传入 `this.config.botName`

### P2-3: isTaskDue 中 countdown max_runs 修复

**文件**: `modules/core/heartbeat.ts`

**目标**: `isTaskDue` 中 countdown 的 `max_runs` 判断目前是空壳（注释说"这里简化"），改为从 session 状态读取。

**做法**:
- `isTaskDue` 的 countdown 分支新增参数 `runCount: number`
- 如果 `max_runs !== undefined` 且 `runCount >= max_runs`，返回 `{ due: false, reason: 'max_runs reached' }`
- TaskPoller 调用 `isTaskDue` 时从 `session.heartbeatTaskState` 读取 runCount 传入

### P2-4: 任务状态查询接口

**文件**: `modules/core/task-poller.ts`（新增方法），`modules/core/heartbeat-scheduler.ts`（暴露）

**目标**: 用户可通过飞书消息查询所有任务状态。

**做法**:
- `TaskPoller` 新增方法 `getTaskStatus(): TaskStatus[]`，返回：
  - 任务名
  - 类型
  - 上次执行时间
  - 累计执行次数
  - 当前是否被锁
  - 下次预计触发时间（interval/countdown/scheduled 可推算）
- `HeartbeatScheduler` 暴露 `getTaskPoller()` 或 `getTaskStatus()` 方法
- 在 `handleMessage` 或 Agent prompt 中注入：当用户说"查看任务状态"/"任务列表"时，调用此方法返回格式化结果

**返回格式示例**:
```
📋 当前任务状态（3个）

| 任务 | 类型 | 上次运行 | 次数 | 下次触发 |
|------|------|----------|------|----------|
| disk-check | scheduled | 今天 09:00 | 12 | 明天 09:00 |
| health-ping | interval(5m) | 2分钟前 | 288 | ~3分钟后 |
| weekend-backup | conditional(1h) | 昨天 17:00 | 5 | ~55分钟后 |
```

---

## Phase 3：任务管理接口（3-4 天）

### P3-1: 任务 CRUD 工具集

**新文件**: `modules/core/task-manager.ts`

**目标**: 提供标准化的任务增删改查 API，Agent 可以可靠调用。

**做法**:
```typescript
export class TaskManager {
  constructor(private heartbeatFilePath: string) {}

  /** 添加任务到 HEARTBEAT.md */
  addTask(task: ScheduledTask): boolean;

  /** 按名称删除任务 */
  removeTask(name: string): boolean;

  /** 更新任务字段（name 不变） */
  updateTask(name: string, updates: Partial<ScheduledTask>): boolean;

  /** 列出所有任务 */
  listTasks(): ScheduledTask[];

  /** 按名称查找 */
  getTask(name: string): ScheduledTask | undefined;
}
```

**实现要点**:
- 所有操作通过解析→修改→序列化 HEARTBEAT.md 完成
- 原子写（先写 `.tmp` 再 `rename`），沿用现有 `removeTaskFromHeartbeatFile` 的模式
- 保持 YAML 风格的缩进格式（2空格）
- 在 `heartbeat-scheduler.ts` 中集成，调用 `syncTasks` 刷新 TaskPoller

### P3-2: 任务操作注入 Agent prompt

**文件**: `modules/core/heartbeat-scheduler.ts` + Agent system prompt

**目标**: Agent 能在对话中理解用户意图并调用 TaskManager。

**做法**:
- 在 Agent system prompt 中加入任务管理指引：
  ```
  ## 任务管理
  
  当用户要求创建/修改/删除定时任务时，按以下规则：
  - 创建任务："每天早上9点检查磁盘" → 调用 TaskManager 添加 scheduled 任务
  - 修改任务："把 disk-check 改成每小时" → 更新 interval
  - 删除任务："删除 weekend-backup" → 调用 removeTask
  - 查看任务："我的任务" / "任务状态" → 调用 listTasks
  ```
- Agent 通过修改 HEARTBEAT.md 文件来操作任务（TaskManager 封装了文件操作）

### P3-3: 任务操作安全校验

**文件**: `modules/core/task-manager.ts`

**目标**: 防止误操作（如删除不存在的任务、interval 格式错误等）。

**做法**:
- 添加前校验：`name` 唯一、`interval` 合法（parseInterval 不返回 null）、`type` 与必填字段匹配
- 更新前校验：`name` 存在
- 删除前校验：`name` 存在
- 所有操作返回 `{ success: boolean, error?: string }`，让 Agent 能向用户反馈具体错误

---

## Phase 4：高级特性（待定）

### P4-1: 任务链（依赖触发）

**目标**: 任务 A 完成后自动触发任务 B。

**做法**:
- `ScheduledTask` 新增 `on_complete: string` 字段（填下游任务名）
- `TaskPoller.handleTaskCompletion` 中：检查 `on_complete`，如果存在，手动触发下游任务的下一次轮询或直接 fire
- 防止循环依赖（最多 5 层链式触发）

### P4-2: 超时取消机制

**目标**: 任务执行超时后 cancel 底层 Agent 调用，而非仅告警。

**做法**:
- `executeTaskWithTimeout` 中使用 `AbortController`
- 如果 Agent adapter 支持 abort，超时后 cancel 请求而非仅 reject promise
- 状态标记为 `aborted` 而非 `failed`

### P4-3: 正计时（stopwatch）

**目标**: 支持"从现在开始计时，每隔 5 分钟汇报一次进度"。

**做法**:
- 新增 `type: 'stopwatch'`，类似 countdown 但方向相反
- 从 createdAt 开始计时，每次 interval 到期时报告"已运行 X 分钟"
- 不设 max_runs，手动停止（通过 `removeTask`）

### P4-4: 任务历史持久化

**目标**: 任务执行记录不丢失（当前 session 重启后 runCount 从 0 开始）。

**做法**:
- Session 持久化已包含 `heartbeatTaskState`，正常重启不丢失
- 但 session 文件被手动删除后会丢失历史
- 可选：在 HEARTBEAT.md 同级目录写入 `HEARTBEAT.state.json` 作为冗余备份

---

## 实施优先级建议

| 优先级 | 编号 | 内容 | 理由 |
|--------|------|------|------|
| 🔴 立即 | P2-1 | conditional 真条件 | 是"假功能"，补上才算真正支持 5 种类型 |
| 🔴 立即 | P2-2 | bot 字段过滤 | 当前没有就永远不会出 bug，但加了就一劳永逸 |
| 🔴 立即 | P2-3 | countdown max_runs 修复 | 代码空壳，不改可能导致 countdown 无限执行 |
| 🔴 本周 | P2-4 | 任务状态查询 | 用户最大痛点：任务跑了不知道 |
| 🟡 下周 | P3-1~3 | 任务 CRUD + Agent 注入 | 解放双手，不用改文件 |
| 🟢 未来 | P4-1~4 | 高级特性 | 锦上添花 |
