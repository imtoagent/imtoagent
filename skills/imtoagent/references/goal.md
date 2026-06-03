# Goal — 目标系统

## 概述

Goal 是 imtoagent 的任务目标系统，用于创建、追踪和管理各种类型的自动化任务。Agent 可通过内置工具或文本命令来操作 Goal。

## 系统架构

```
GoalManager（入口，解析文本命令）
  → GoalStore（持久化到 ~/.imtoagent/goals.json）
  → GoalEngine（触发调度 + 条件评估 + 动作执行）
```

---

## Goal 类型

| 类型 | 说明 | 典型场景 |
|------|------|---------|
| `reminder` | 简单提醒 | "5 分钟后提醒我开会" |
| `conditional_reminder` | 条件提醒 | "如果明天下雨就提醒我带伞" |
| `periodic_report` | 周期报告 | "每天早上 9 点汇报日程" |
| `monitor_alert` | 监控告警 | "CPU > 80% 超过 5 分钟就告警" |
| `one_shot` | 一次性任务 | "帮我查一下这个 API 的文档并汇总" |

---

## 触发类型

| 类型 | 参数 | 示例 |
|------|------|------|
| `time` | `time: "HH:MM"` | `time: "12:50"` |
| `cron` | `cron: "<表达式>"` | `cron: "0 9 * * *"` |
| `interval` | `intervalSeconds: N` | `intervalSeconds: 3600` |
| `event` | 事件驱动 | （待实现） |

---

## 动作类型

| 类型 | 说明 |
|------|------|
| `send_message` | 发送消息到指定 chat |
| `run_tool` | 调用单个工具 |
| `tool_chain` | 工具调用链（顺序执行） |

---

## Agent 工具（内置）

Agent 有以下内置工具可以操作 Goal：

### `create_goal`
创建新 Goal。参数：`objective`（目标描述）、`token_budget`（可选，token 预算）。

### `get_goal`
查看当前 Goal 状态，包括 token 用量、耗时等。

### `update_goal`
更新 Goal 状态。参数：`status` = `complete`（已完成）或 `blocked`（已阻塞）。

---

## 文本命令（Agent 回复协议）

Agent 在消息中输出以下命令字符串即可触发 Goal 管理操作：

| 命令 | 作用 |
|------|------|
| `GOAL_LIST` | 列出所有活跃 Goal |
| `GOAL_CANCEL: <id>` | 取消指定 Goal |
| `GOAL_PAUSE: <id>` | 暂停指定 Goal |
| `GOAL_RESUME: <id>` | 恢复暂停的 Goal |
| `GOAL_UPDATE: <id> {json}` | 更新 Goal 属性（JSON patch） |

### 执行结果标记

Agent 执行完 Goal 后应输出以下标记之一：

| 标记 | 含义 |
|------|------|
| `GOAL_DONE: <id>` | Goal 执行成功 |
| `GOAL_SKIP: <id>` | Goal 被跳过（条件不满足等） |
| `GOAL_FAILED: <id> <reason>` | Goal 执行失败 |

---

## 生命周期

```
pending → active → done
                  → failed
                  → cancelled
```

- **pending**：已创建，等待首次触发
- **active**：已触发，正在执行
- **done**：执行成功完成
- **failed**：执行失败（含 `lastError` 信息）
- **cancelled**：被用户取消

---

## 条件表达式

支持的条件运算符（CompareOperator）：

| 运算符 | 含义 |
|--------|------|
| `eq` | 等于 |
| `ne` | 不等于 |
| `gt` | 大于 |
| `lt` | 小于 |
| `gte` | 大于等于 |
| `lte` | 小于等于 |
| `contains` | 包含 |

条件类型（ConditionType）：`weather` / `system_metric` / `api_check` / `external_state` / `none`

---

## 重复策略

| 策略 | 说明 |
|------|------|
| `once` | 只执行一次 |
| `hourly` | 每小时 |
| `daily` | 每天 |
| `weekly` | 每周 |
| `custom` | 自定义 cron 表达式 |

---

## 执行锁 & 历史

- 同一 Goal 不会并发执行（有执行锁）
- 执行记录持久化在 `~/.imtoagent/goals.json`
- `runCount` 追踪执行次数
- `maxRuns` 控制最大执行次数
- `lastError` 记录最后一次失败原因
