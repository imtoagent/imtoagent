# 定时提醒未执行 — Bug 分析报告

> 2026-06-04 | 排查范围：Goal Engine / Heartbeat / GoalStore / 数据持久化

---

## 用户报告

> “之前让你 X 点提醒我，为什么没提醒？”

---

## 排查过程

### 第一步：查数据

```
~/.imtoagent/goals.json → {"version":1, "goals":{}}
~/.imtoagent/task_state.json → {"version":1, "states":{}}
```
**空。** Goal 和 Task 都不存在。

### 第二步：查 HEARTBEAT.md

全盘搜索 `HEARTBEAT.md` → **不存在。**

按代码逻辑，`_initHeartbeat()` 应在 workspace 目录下自动建模板，但 workspace 目录（`~/.imtoagent/workspaces/<UUID>/`）从未被创建。`ensureWorkspace()` 被调用过但目录不存在——可能因权限或首次启动时的异常路径被跳过。

### 第三步：查 Gateway 进程

```
bun run index.ts  →  PID 52692，10:22 启动
codex app-server  →  PID 52707，stdio 模式
```
Gateway 正常运行，HeartbeatScheduler 每 5 分钟 tick 一次 Goal Engine。

### 第四步：查 Goal Engine 执行路径

Heartbeat tick → `GoalStore.getDue()` → 查 `goals.json` → 空 → 无事发生。

Goal Engine **执行端完整**（1450 行代码），但没有目标可执行。

### 第五步：查创建端

用户对话 → Agent 回复 → **没有 Goal 创建入口。**

`goal-manager.ts` 定义了 `parseGoalManagement(text)`，支持 GOAL_LIST / GOAL_CANCEL / GOAL_PAUSE 等命令，但它：
- 只在 Goal Engine 内部被调用（解析 Agent 执行结果）
- 不会在主对话 `handleMessage()` 中被触发
- 没有 `parseNaturalGoal(text)` 能把“X 点提醒我”翻译成 Goal 对象

---

## 根因

| 层 | 状态 |
|----|------|
| Goal Engine（执行） | ✅ 完成 |
| GoalStore（持久化） | ✅ 完成 |
| Heartbeat 集成 | ✅ 完成 |
| GoalManager（管理协议） | ✅ 完成 |
| **自然语言 → Goal 创建** | ❌ 缺失 |
| **IM 对话 Goal 指令路由** | ❌ 缺失 |

**用户说“X 点提醒我”，Agent 口头回复了，但没有任何代码把这句话变成 Goal 对象。** Heartbeat 每 5 分钟查一次空库，永远没有目标可执行。

---

## 附带发现

| # | 问题 | 文件 | 严重度 |
|---|------|------|--------|
| 1 | `executeGoal` 和 `executeGoalWithResult` 120 行重复代码，`executeGoal` 已是死代码 | goal-engine.ts | 低 |
| 2 | 并发 semaphore race condition，`Promise.race` + `indexOf` 组合在并发下可能找错槽位 | goal-engine.ts | 中 |
| 3 | `showOk`/`showAlerts` 传入 HeartbeatScheduler 构造参数但从未被读取 | index.ts → heartbeat-scheduler.ts | 低 |
| 4 | `TaskManager` 在 L738 被实例化但从未使用 | index.ts | 低 |

---

## 修复方向

**核心缺失**（让定时提醒可用）：
1. `parseNaturalGoal(text)` — 把自然语言转成 Goal
2. `handleMessage` 中检测 Goal 创建/管理指令
3. 创建后回复确认

附带问题可顺手清理，不改行为。
