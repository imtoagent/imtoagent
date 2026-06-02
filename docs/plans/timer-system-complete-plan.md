# 时间系统完善计划

> 创建日期：2026-06-02 | 版本：v1.0 | 状态：讨论中

---

## 一、现状盘点

### 1.1 已实现的能力

| 编号 | 能力 | 描述 | 实现位置 |
|------|------|------|----------|
| T1 | **心跳 (Heartbeat)** | 周期性存活检查，可配置 interval | `heartbeat-scheduler.ts` |
| T2 | **定时任务 (Cron Tasks)** | 多任务循环执行，通过 HEARTBEAT.md 配置 | `heartbeat-scheduler.ts` + `heartbeat.ts` |
| T3 | **Phase 分散** | 多 bot 错峰执行，避免惊群效应 | `heartbeat.ts` → `getPhaseOffset()` |
| T4 | **失败告警** | 连续失败 3 次发送 IM 告警 | `heartbeat-scheduler.ts` |
| T5 | **输出路由** | HEARTBEAT_OK 静默过滤、去重、空值拦截 | `output-router.ts` |
| T6 | **Session 隔离** | heartbeat/cron/main 三类 session 完全隔离 | `session-resolver.ts` |

### 1.2 缺失的能力（按优先级排序）

---

## 二、能力清单（完整矩阵）

### P0 - 核心补充（本次优先实现）

| 编号 | 类型 | 描述 | 场景 |
|------|------|------|------|
| **O1** | **一次性延迟任务** | N 分钟后执行一次，自动清理 | "5 分钟后提醒我吃饭"、"30 分钟后检查部署状态" |
| **O2** | **定点时间任务** | 指定具体时刻执行，不循环 | "下午 3:00 提醒我开会"、"明天 9:00 发早安消息" |
| **O3** | **Agent 可创建任务** | Agent 在对话中动态创建/取消定时任务，无需手动编辑 HEARTBEAT.md | "每天中午 12 点提醒我吃饭" → Agent 自动写 HEARTBEAT.md |

### P1 - 交互增强

| 编号 | 类型 | 描述 | 场景 |
|------|------|------|------|
| **O4** | **计时器 / 正计时** | 从 0 开始计时，可按需查询已用时间 | "帮我计时"、"这个任务花了多久？" |
| **O5** | **倒计时** | 从指定时长倒数，到时触发通知 | "会议还有 10 分钟结束，提醒我"、"番茄钟 25 分钟" |
| **O6** | **暂停/恢复/取消** | 控制运行中的计时器 | "暂停番茄钟"、"取消 3 点的提醒" |
| **O7** | **任务列表查询** | 查看当前所有活跃的定时任务和计时器 | "我现在有哪些定时任务？" |

### P2 - 高级调度

| 编号 | 类型 | 描述 | 场景 |
|------|------|------|------|
| **O8** | **Cron 表达式** | 支持标准 5/6 位 cron 表达式 | "每周三 15:00"、"每月 1 号 9:00" |
| **O9** | **链式触发** | 任务 A 完成后延迟 N 秒执行 B | "部署完成后 30 秒做健康检查" |
| **O10** | **条件触发** | 满足条件 + 时间双约束才触发 | "每天第一次上线时打招呼"、"磁盘>80%且超过1小时" |
| **O11** | **超时告警** | 某个操作超过 N 分钟没完成则告警 | "如果 30 分钟没收到回复，提醒我" |
| **O12** | **工作日/节假日感知** | 跳过周末和节假日 | "每个工作日 9:00 发站会提醒" |

### P3 - 体验优化

| 编号 | 类型 | 描述 | 场景 |
|------|------|------|------|
| **O13** | **自然语言解析** | "三分钟后"、"半小时后"、"下周三" → 自动解析为时间 | 无需用户手动计算 |
| **O14** | **时区感知** | 自动识别用户时区（当前 Asia/Shanghai） | 跨时区协作场景 |
| **O15** | **持久化恢复** | 网关重启后恢复所有未完成的任务和计时器 | 服务重启不丢任务 |
| **O16** | **速率限制** | 防止 Agent 创建过多任务导致资源耗尽 | 安全防护 |
| **O17** | **任务确认回执** | 任务创建后给用户一个确认卡片（含取消按钮） | UX 反馈 |

---

## 三、P0 详细设计

### 3.1 O1：一次性延迟任务

#### 数据模型

```typescript
// 新增类型：一次性任务
interface OnceTask {
  id: string;            // UUID
  name: string;          // 可读名称
  type: 'delay' | 'deadline';  // delay=相对延迟, deadline=绝对时间
  triggerAt: number;     // 触发时间戳 (ms)
  prompt: string;        // 给 Agent 的提示
  chatId: string;        // 投递目标
  createdBy: 'agent' | 'user';  // 创建来源
  createdAt: number;
  status: 'pending' | 'fired' | 'cancelled';
}
```

#### 存储

- 路径：`sessions/{BotId}/once-tasks.json`
- 格式：`OnceTask[]`
- 启动时加载，运行时维护在内存 `Map<string, OnceTask>`

#### 调度器

在 `HeartbeatScheduler` 中新增 `OnceTaskScheduler` 子模块：

```
scheduleOnce(task)     → 计算 delay = triggerAt - now，setTimeout
cancelOnce(taskId)     → clearTimeout + 标记 cancelled
listOnce()             → 返回所有 pending 任务
```

#### 用户交互

用户说："5 分钟后提醒我吃饭"

```
Agent → 解析意图 → 调用内部 createOnceTask({ delay: '5m', prompt: '提醒老板吃饭' })
      → 返回确认："✅ 已设置 5 分钟后提醒吃饭 (18:32)"
      → setTimeout(fire, 5min)
      → 触发时 → Agent 回复 "🍚 老板，该吃饭了！"
      → 任务自动标记为 fired，从内存移除
```

### 3.2 O2：定点时间任务

与 O1 共享 `OnceTask` 数据模型，区别仅在于 `type: 'deadline'` 和 `triggerAt` 的计算方式：

```typescript
// delay 型：triggerAt = Date.now() + 5 * 60 * 1000
// deadline 型：triggerAt = parseNaturalTime("下午3:00") → 时间戳
```

自然语言时间解析需要新增一个轻量工具函数 `parseNaturalTime()`：

| 输入 | 解析结果 |
|------|----------|
| "下午3:00" | 今天 15:00（如果已过则为明天） |
| "明天 9:00" | 明天 09:00 |
| "下周三 14:00" | 下周对应日期的 14:00 |
| "3分钟后" | now + 3min（本质是 delay） |
| "半小时后" | now + 30min（本质是 delay） |

### 3.3 O3：Agent 可创建任务

这是关键的用户体验提升——目前用户必须手动编辑 `HEARTBEAT.md` 才能配置定时任务。O3 让 Agent 在对话中直接完成。

#### 实现方式

新增一个 **内部工具** 注册到 Agent 的 tools 列表中：

```typescript
// 工具名: create_scheduled_task
{
  name: 'create_scheduled_task',
  description: 'Create a recurring scheduled task that triggers on an interval',
  parameters: {
    name: string,      // 任务名
    interval: string,  // "30m", "1h", "24h"
    prompt: string,    // 触发时给 Agent 的指令
  }
}

// 工具名: cancel_scheduled_task
{
  name: 'cancel_scheduled_task',
  description: 'Cancel a recurring scheduled task',
  parameters: {
    name: string,      // 任务名
  }
}

// 工具名: list_scheduled_tasks
{
  name: 'list_scheduled_tasks',
  description: 'List all active scheduled tasks',
  parameters: {}
}
```

Agent 调用这些工具 → 网关写到 `HEARTBEAT.md` → `HeartbeatScheduler.syncTasks()` 自动感知变化。

#### 与 HEARTBEAT.md 的关系

- HEARTBEAT.md 仍然是**持久化来源**（网关重启后恢复）
- Agent tools 是**写入接口**（运行时修改 HEARTBEAT.md）
- `syncTasks()` 在每次心跳时 diff 内存与文件，自动增删任务

---

## 四、架构演进路径

### 当前架构

```
config.json → HeartbeatScheduler
                ├── Heartbeat 循环 (setTimeout)
                ├── Cron Tasks 循环 (setTimeout × N)
                └── HEARTBEAT.md (静态配置)

Agent 对话 ──→ 用户手动编辑 HEARTBEAT.md ──→ syncTasks()
```

### 目标架构 (P0 完成后)

```
config.json → TimerSystem (统一入口)
                ├── HeartbeatScheduler (周期性心跳)
                ├── CronTaskScheduler (周期性任务)
                │     ├── HEARTBEAT.md (持久化)
                │     └── syncTasks() (热加载)
                └── OnceTaskScheduler (一次性/定点任务)
                      └── once-tasks.json (持久化)

Agent 对话 ──→ create_scheduled_task / create_once_task (内部工具)
                └── 自动写 HEARTBEAT.md / once-tasks.json
```

### TimerSystem 统一入口

```typescript
interface TimerSystem {
  // 周期性
  createCronTask(task: ScheduledTask): void;
  cancelCronTask(name: string): void;
  listCronTasks(): ScheduledTask[];

  // 一次性/定点
  createOnceTask(task: OnceTaskInput): OnceTask;
  cancelOnceTask(id: string): void;
  listOnceTasks(): OnceTask[];

  // 生命周期
  start(): void;
  stop(): void;
}
```

---

## 五、实施步骤

### Phase 1：OnceTask 基础 (P0-O1)

- [ ] 1.1 定义 `OnceTask` 类型 (`types.ts`)
- [ ] 1.2 实现 `OnceTaskScheduler` 类 (`once-task-scheduler.ts`)
  - `schedule()` / `cancel()` / `list()` 
  - `setTimeout` 调度 + 触发回调
- [ ] 1.3 持久化：`once-tasks.json` 读写
- [ ] 1.4 集成到 `HeartbeatScheduler` 或新建 `TimerSystem`
- [ ] 1.5 网关启动时恢复 pending 任务

### Phase 2：定点时间 (P0-O2)

- [ ] 2.1 实现 `parseNaturalTime()` 工具函数
  - 支持相对时间："N分钟后"、"N小时后"
  - 支持绝对时间："下午3:00"、"明天9:00"
- [ ] 2.2 `OnceTaskScheduler` 支持 `type: 'deadline'`

### Phase 3：Agent 工具注册 (P0-O3)

- [ ] 3.1 定义工具 schema (`create_scheduled_task`, `cancel_scheduled_task`, `list_scheduled_tasks`)
- [ ] 3.2 实现工具 handler（写 HEARTBEAT.md）
- [ ] 3.3 注入到 Agent 适配器的 tools 列表
- [ ] 3.4 一键创建 + 确认卡片（含取消按钮）

### Phase 4：交互增强 (P1)

- [ ] 4.1 计时器/正计时能力
- [ ] 4.2 倒计时 + 通知
- [ ] 4.3 暂停/恢复/取消控制
- [ ] 4.4 任务列表查询命令

### Phase 5：高级调度 (P2)

- [ ] 5.1 Cron 表达式解析
- [ ] 5.2 链式触发
- [ ] 5.3 条件触发
- [ ] 5.4 超时告警
- [ ] 5.5 工作日/节假日感知

### Phase 6：体验优化 (P3)

- [ ] 6.1 更丰富的自然语言解析
- [ ] 6.2 时区感知增强
- [ ] 6.3 持久化恢复完善
- [ ] 6.4 速率限制
- [ ] 6.5 任务确认 UI 卡片

---

## 六、讨论要点（待老板确认）

1. **P0 三合一还是分步？** O1+O2+O3 可以一起做（共享 OnceTask 基础设施），也可以先做 O1 验证再扩展

2. **Cron 表达式 vs 自然语言**：P0 阶段用简单 interval（5m/1h/24h），P2 再加 cron 表达式？还是 P0 就支持？

3. **工具注入方式**：O3 的内部工具是注入到系统 prompt 让 LLM 看到，还是通过网关层面的 tool registry 统一管理？（参考之前讨论的 MCP/Toolkit 注入层）

4. **HEARTBEAT.md 编辑方式**：Agent 直接修改 vs 通过 API 修改？直接修改更简单但可能引入格式错误

5. **一次任务 vs 周期任务命名**：OnceTask 叫 "一次性任务"、"延迟任务" 还是 "提醒"？对用户暴露什么名称？

---

## 七、相关文件索引

| 文件 | 作用 |
|------|------|
| `modules/core/heartbeat-scheduler.ts` | 当前心跳 + cron 调度器 |
| `modules/core/heartbeat.ts` | HEARTBEAT.md 解析 + Phase 分散 |
| `modules/core/session-resolver.ts` | Session 路由（heartbeat/cron/main） |
| `modules/core/output-router.ts` | 输出过滤 |
| `modules/core/types.ts` | 类型定义 |
| `modules/core/session.ts` | Session 持久化 |
| `config.json` | Bot 配置（心跳 interval 等） |
| `sessions/{BotId}/*.memory.json` | Session 持久化文件 |
