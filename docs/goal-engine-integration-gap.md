# Goal Engine 集成缺口分析与修复方案

> 2026-06-04 | CX 测试发现

## 一、背景

Goal Engine 核心代码（GoalStore、GoalEngine、GoalManager）已完整实现并在 `heartbeat-scheduler.ts` 中接入，但存在关键集成缺口导致功能不可用。以下列出所有已发现问题及修复方案。

---

## 二、已确认的问题

### 问题 1：GOAL_CREATE 协议未实现

**位置**：`modules/core/goal-manager.ts`

**现象**：`GOAL_*` 解析正则只匹配 `GOAL_LIST`、`GOAL_CANCEL`、`GOAL_PAUSE`、`GOAL_RESUME`、`GOAL_UPDATE`，**不包含 `GOAL_CREATE`**。Agent 无法创建 Goal。

**相关代码**（第 32-36 行）：
```ts
{ regex: /GOAL_LIST/i, action: 'list' as const },
{ regex: /GOAL_CANCEL:\s*([a-zA-Z0-9_-]+)/i, action: 'cancel' as const },
{ regex: /GOAL_PAUSE:\s*([a-zA-Z0-9_-]+)/i, action: 'pause' as const },
{ regex: /GOAL_RESUME:\s*([a-zA-Z0-9_-]+)/i, action: 'resume' as const },
{ regex: /GOAL_UPDATE:\s*([a-zA-Z0-9_-]+)\s+([\s\S]+)/i, action: 'update' as const },
```

**缺失项**：缺少 `create` action 及其解析器，无法从用户自然语言中提取 trigger 类型、时间、action 内容。

---

### 问题 2：Agent 回复链路未接入 Goal 协议拦截

**位置**：`modules/core/index.ts` 已导出 `parseGoalManagement`，但整个项目中**无人调用此函数**。

**现象**：Agent 回复中包含 `GOAL_DONE: xxx`、`GOAL_CREATE ...` 等协议标记时，这些文本被当作普通消息直接发送给用户，不会被网关拦截和解析。

**需要接入的位置**（推测）：
- `output-router.ts` 或
- `modules/core/chat-router.ts` 或
- `index.ts` 中 Agent 回复的处理流

**接入逻辑**：
```
Agent 回复 → 检查是否包含 GOAL_* 协议 →
  是 → GoalManager.processManagementCommand() → 返回格式化结果给用户
  否 → 正常发送
```

---

### 问题 3：GoalStore 无运行时外部入口

**位置**：`modules/core/goal-store.ts`

**现象**：
- `GoalStore.load()` 仅在构造函数中调用一次（第 25 行）
- 手动编辑 `~/.imtoagent/goals.json` 后，运行中的 gateway 不感知变更
- 没有 `reload()` 方法，没有 file watch，没有 HTTP API

**影响**：无法在运行时动态添加/修改 goal，只能重启 gateway。

**解决方案（三选一，推荐 a）**：

a) **添加 `reload()` 方法**（最简单）— 暴露 HTTP 端点 `/goals/reload`，或每次 tick 前自动 reload
b) **添加 file watch**（`fs.watch`）— 文件变更时自动 reload，但需处理 debounce
c) **暴露 HTTP CRUD** — `POST/GET/DELETE /goals` 端点，直接操作内存中 GoalStore

---

### 问题 4：Goal 执行结果无法回发到 IM（缺少 sourceChatId）

**位置**：`modules/core/goal-engine.ts` 第 410-420 行

**现象**：
```ts
if (goal.action.type === 'send_message' && action === 'done') {
  const targetChatId = goal.action.target || goal.metadata.sourceChatId;
  // ↑ 如果两者都为空，sendIM 会失败
}
```

**测试验证**：创建的测试 goal 没有设置 `metadata.sourceChatId` 和 `action.target`，导致 Goal 即使执行成功也无法通知用户。

**修复**：
- `GOAL_CREATE` 解析时必须从当前消息上下文中提取 `chatId`，写入 `goal.metadata.sourceChatId`
- HeartbeatScheduler 创建 Goal 时注入当前 session 的 chatId

---

## 三、修复优先级

| 序号 | 问题 | 难度 | 重要性 | 建议顺序 |
|------|------|------|--------|----------|
| 1 | GOAL_CREATE 协议 | 中 | 🔴 关键 | 先做 |
| 3 | GoalStore runtime 入口 | 低 | 🔴 关键 | 先做（reload 即可） |
| 2 | Agent 回复链路拦截 | 中 | 🔴 关键 | 后做 |
| 4 | sourceChatId 缺失 | 低 | 🟡 重要 | 与 #1 一起做 |

---

## 四、详细修复方案

### 修复 1：新增 GOAL_CREATE 解析

**文件**：`modules/core/goal-manager.ts`

**改动点 A**：在 `GoalManagementAction` 类型中新增 `create` action：
```ts
type GoalManagementAction =
  | { action: 'create'; rawInput: string; chatId?: string }
  | { action: 'list'; ... }
  // ... 其他已有 action
```

**改动点 B**：新增解析规则到 `PARSE_RULES` 数组（放在最前面）：
```ts
{ regex: /GOAL_CREATE\s*:\s*([\s\S]+)/i, action: 'create' as const },
```

**改动点 C**：在 `processManagementCommand` 中处理 `create` case：
```ts
case 'create': {
  // 从 rawInput 中解析 goal 参数（自然语言）
  // 提取 trigger 类型、时间、动作内容
  const goalInput = parseGoalCreateInput(action.rawInput);
  const goal = createGoalFromInput(goalInput, action.chatId);
  const result = this.store.add(goal);
  return `Goal 已创建: ${goal.id}\n描述: ${goal.description}\n触发: ${describeTrigger(goal)}`;
}
```

**改动点 D**：新增辅助函数 `parseGoalCreateInput`，从自然语言中提取：
- `trigger.type`（`time` / `interval` / `event` / `cron`）
- `trigger.time`（如 `14:30`）
- `trigger.leadMinutes`（可选，提前提醒）
- `action.type`（`send_message`）
- `action.content`（动作描述）
- `lifecycle.repeat`（`once` / `daily` / `weekly` / `hourly`）

---

### 修复 2：Agent 回复链路接入 Goal 协议

**文件**：需先确认是 `output-router.ts` 还是其他中间件负责过滤 Agent 回复。

**核心逻辑**：
```ts
// 在 Agent 回复通过网关发送给用户之前
const goalAction = parseGoalManagement(agentReply);
if (goalAction) {
  // 拦截：不发送原始回复给用户，改为发送处理结果
  const result = goalManager.processManagementCommand(agentReply);
  await sendIM(chatId, result);
  return;
}
// 正常发送
await sendIM(chatId, agentReply);
```

**注意**：`GOAL_DONE` / `GOAL_SKIP` / `GOAL_FAILED` 是 GoalEngine 内部解析的，不需要在这里拦截（它们会由 `executeGoalWithResult` 中的 `parseGoalResult` 处理）。这里只需要拦截管理命令：`GOAL_CREATE`、`GOAL_LIST`、`GOAL_CANCEL`、`GOAL_PAUSE`、`GOAL_RESUME`、`GOAL_UPDATE`。

---

### 修复 3：GoalStore 添加运行时入口

**方案 A（推荐）：添加 `reload()` 方法**
```ts
// goal-store.ts
reload(): void {
  this.goals.clear();
  this.load();
}

// 也可在 GoalEngine.processDueGoals 开头自动调用：
// this.store.reload();  // 每次 tick 前同步文件
```

**方案 B：HeartbeatScheduler 暴露 HTTP 端点**

在 `index.ts` 或路由中注册：
```ts
app.post('/goals', (req, res) => {
  const goalData = req.body;
  const result = store.add(goalData);
  res.json(result);
});
app.delete('/goals/:id', (req, res) => { ... });
```

---

### 修复 4：sourceChatId 传递链

**修复点 A**：`parseGoalManagement` 新增 `chatId` 参数：
```ts
export function parseGoalManagement(text: string, chatId?: string): GoalManagementAction | null {
  // ...
  if (action === 'create') {
    return { action: 'create', rawInput: capture[1].trim(), chatId };
  }
}
```

**修复点 B**：`processManagementCommand` 创建 goal 时写入：
```ts
const goal = createGoalFromInput(goalInput, action.chatId);
// createGoalFromInput 内部：
// goal.metadata.sourceChatId = chatId;
```

---

## 五、参考文件

| 文件 | 用途 |
|------|------|
| `modules/core/goal-store.ts` | Goal CRUD + 持久化 + 执行锁 |
| `modules/core/goal-engine.ts` | 到期检测 + Prompt 构造 + Agent 调用 + 结果解析 |
| `modules/core/goal-manager.ts` | GOAL_* 协议解析 + Goal 管理指令处理 |
| `modules/core/goal-types.ts` | Goal 类型定义 + `generateGoalId` |
| `modules/core/heartbeat-scheduler.ts` | Heartbeat tick 调度 + GoalEngine 接入 |
| `modules/core/output-router.ts` | Agent 回复过滤（需确认是否在此接入） |
| `tests/goal-manager.test.ts` | Goal 管理单元测试 |
| `docs/goal-engine-design.md` | Goal Engine V2.3 设计文档 |
