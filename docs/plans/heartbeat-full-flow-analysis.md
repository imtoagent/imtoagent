# Heartbeat + Scheduled Tasks — 全链路逻辑分析

> Date: 2026-06-02
> Scope: 首次安装 → 正式运行的完整逻辑链路

---

## 1. 完整流程：首次安装 → 心跳运行

```
┌──────────────────────────────────────────────────────────────────┐
│ Step 1: imtoagent setup（首次安装）                               │
│ - 创建 config.json（含 bots）                                     │
│ - 创建工作空间目录                                                │
│ - 创建 soul 文件（rules.md, identity.md 等）                      │
│ ❌ 不创建 HEARTBEAT.md                                            │
│ ❌ 不配置 heartbeat（setup 向导里完全没有这一步）                   │
│ ❌ config.template.json 里没有 heartbeat 配置                     │
└──────────────────────────┬───────────────────────────────────────┘
                           ▼
┌──────────────────────────────────────────────────────────────────┐
│ Step 2: imtoagent start（首次启动，无心跳配置）                    │
│ - Bot 构造函数调用 _initHeartbeat()                               │
│ - botConfig.heartbeat 为 undefined → 直接 return                   │
│ - 不创建 HeartbeatScheduler                                      │
│ ✅ 对普通新用户零影响                                              │
└──────────────────────────┬───────────────────────────────────────┘
                           ▼
┌──────────────────────────────────────────────────────────────────┐
│ Step 3: 用户手动添加 heartbeat 配置                                │
│   config.json 中添加: "heartbeat": { "interval": "5m", ... }     │
│ - 重启 gateway                                                    │
│ - _initHeartbeat() 找到配置 → 创建 HeartbeatScheduler             │
│ - HEARTBEAT.md 路径 = workspace/UUID/HEARTBEAT.md                │
│ ❌ HEARTBEAT.md 文件不存在 → readHeartbeatFile() 返回 ""          │
│ - isHeartbeatContentEffectivelyEmpty("") → true                   │
│ - 心跳运行但跳过（只 syncTasks）                                   │
└──────────────────────────┬───────────────────────────────────────┘
                           ▼
┌──────────────────────────────────────────────────────────────────┐
│ Step 4: 用户创建 HEARTBEAT.md（有内容）                            │
│ - 下次心跳：读到内容 → 不是空的                                     │
│ - stripHeartbeatTasksBlock() → 提取 prompt                        │
│ - 通过 AgentRuntime.processMessage() 发给 Agent                   │
│ - Agent 回复                                                      │
│ - OutputRouter 过滤：HEARTBEAT_OK → 拦截                          │
│ - 实际内容 → 发到 IM（via target.chatId）                          │
└──────────────────────────────────────────────────────────────────┘
```

---

## 2. 当前架构

### 2.1 配置结构（BotConfig.heartbeat）

```typescript
heartbeat?: {
  interval?: string;       // "5m", "300s", "1h"
  target?: {               // ⚠️ 已定义但从未使用
    channel?: string;
    chatId?: string;       // 目标 IM 对话 ID
  };
  visibility?: {
    showAlerts?: boolean;  // 默认: true
    showOk?: boolean;      // 默认: false
  };
  prompt?: string;
  maxHeartbeatRounds?: number;
}
```

### 2.2 模块关系

```
index.ts (Bot._initHeartbeat)
  └── HeartbeatScheduler
        ├── SessionResolver → resolveHeartbeat() → { chatId, sessionKey, sessionType }
        ├── parseHeartbeatTasks()     // 解析 HEARTBEAT.md 中的定时任务
        ├── filterAndSend()           // OutputRouter：HEARTBEAT_OK 拦截 + 去重
        └── AgentRuntime.processMessage() → Agent → reply 回调
```

### 2.3 Session 隔离

| Session 类型 | sessionKey | chatId | 用途 |
|-------------|------------|--------|------|
| main | 真实 chatId | 真实 IM chatId | 用户对话 |
| heartbeat | `Bot名:heartbeat` | `Bot名:heartbeat` | 心跳轮次 |
| cron | `Bot名:cron:任务名` | `Bot名:cron:任务名` | 定时任务 |

---

## 3. 🔴 发现的逻辑问题

### 问题 1：心跳的 `chatId` 不是真实的 IM chat ID（核心缺陷）

**位置：** `session-resolver.ts` → `resolveHeartbeat()`

```typescript
// 当前代码：
resolveHeartbeat(): ResolveTargetResult {
  const sessionKey = `${this.botKey}:heartbeat`;
  return {
    chatId: sessionKey,  // ❌ "CodexBot:heartbeat" 不是飞书 chat_id
    ...
  };
}
```

**后果：**
- Agent 回复 HEARTBEAT_OK → OutputRouter 拦截 → 不发到 IM → ✅ 不报错（问题被掩盖）
- Agent 回复实际内容 → `sendToIM(target.chatId)` → 飞书 API 收到 `receive_id: "CodexBot:heartbeat"` → **API 报错**（这不是有效的 chat_id）

**根本原因：** 心跳是定时器触发的，不是由用户消息触发的。没有 IM 对话上下文可以"回复"。

**影响范围：**
- HEARTBEAT_OK 场景下问题被掩盖（最常见情况）
- 真正有内容要报告时，发送会失败
- 告警发送（`consecutiveFailures >= 3`）也会失败（同一个 chatId 问题）
- 定时任务（cron）的回复也有同样的问题

**修复方案：** 需要 `lastActiveChatId` 追踪或使用 `heartbeat.target.chatId` 配置。

---

### 问题 2：Setup 向导完全不知道心跳的存在

**位置：** `modules/cli/setup.ts`

- 没有配置心跳的步骤
- 没有提到 HEARTBEAT.md
- 新用户完全无法发现这个功能
- `config.template.json` 里没有心跳默认值

**影响：** 用户必须手动编辑 config.json + 创建 HEARTBEAT.md — 零可发现性。

---

### 问题 3：没有 HEARTBEAT.md 模板

- `setup.ts` 不创建 HEARTBEAT.md
- `templates/` 目录下没有 HEARTBEAT.md 模板
- `workspaceManager.ensureWorkspace()` 也不创建它

**影响：** 即使用户在配置中启用心跳，文件不存在 → 心跳静默跳过，用户不知道为什么。

---

### 问题 4：告警发送是断裂的

```typescript
// runHeartbeat() catch 块中：
if (this.consecutiveFailures >= 3 && this.config.showAlerts) {
  await this.sendToIM(alertMsg, target.chatId); // ❌ 同样是无效的 chatId
}
```

**后果：** 心跳连续失败 3 次以上时，告警本身也发不出去。用户永远不会知道心跳出了问题。

---

### 问题 5：HEARTBEAT.md 在任何文档中都没有提到

- `docs/` 下没有心跳相关文档
- config template 中没有注释
- CLI help 没有提到（`imtoagent --help`）

---

## 4. 当前状态（你的环境）

| 组件 | 状态 |
|------|------|
| CodexBot heartbeat 配置 | ✅ `interval: "5m"` |
| HEARTBEAT.md | ✅ 已创建（带指引内容） |
| HeartbeatScheduler | ✅ 运行中，5 分钟间隔 |
| HEARTBEAT_OK 拦截 | ✅ 正常工作 |
| 实际内容发送到 IM | 🔴 会失败（chatId 无效） |
| 定时任务 | 🟡 配置支持就绪，未定义任务 |
| 告警发送 | 🔴 会失败（同样的 chatId 问题） |

---

## 5. 修复建议（优先级排序）

### P0：修复心跳/定时任务的 chatId 路由

**方案 A：** 使用 `heartbeat.target.chatId` 配置（最简单）
```typescript
resolveHeartbeat(): ResolveTargetResult {
  const hbConfig = this.botConfig?.heartbeat;
  const realChatId = hbConfig?.target?.chatId;
  const sessionKey = `${this.botKey}:heartbeat`;
  return {
    chatId: realChatId || sessionKey,  // 有配置用配置，否则 fallback
    ...
  };
}
```

**方案 B：** 追踪每个 Bot 的 `lastActiveChatId`（更灵活）
- 记录用户最后发消息的 IM chatId
- 心跳投递到该 chatId
- 无活跃对话时 fallback 到 sessionKey

### P1：添加 HEARTBEAT.md 模板

- 创建 `templates/HEARTBEAT.md`（带基础指引）
- `setup.ts` 在 Bot 配置时复制到工作空间
- 或：`workspaceManager.ensureWorkspace()` 创建默认文件

### P2：Setup 向导添加心跳配置步骤（可选）

- Bot 配置后询问："是否启用定时心跳检查？"
- 如选是：设置 interval、创建 HEARTBEAT.md

### P3：添加文档

- `docs/heartbeat.md` — 使用指南
- `imtoagent --help` 中添加心跳说明
- config.template.json 中添加注释示例

---

## 6. 总结

| 问题 | 回答 |
|------|------|
| 新安装会有问题吗？ | ❌ 不会 — 没配置就没心跳，零影响 |
| 默认心跳间隔是 5 分钟吗？ | ❌ 默认无心跳，必须手动配置 |
| 后端（Agent）知道怎么用吗？ | ✅ 知道 — Agent 通过 AgentRuntime 接收心跳消息，和普通消息一样处理 |
| HEARTBEAT_OK 能被正确拦截吗？ | ✅ 能 — OutputRouter 正确拦截 |
| 心跳内容能发给用户吗？ | 🔴 不能 — chatId 不是真实的 IM chat ID |
| 告警能发给用户吗？ | 🔴 不能 — 同样的 chatId 问题 |
| 定时任务能用吗？ | 🟡 架构支持，但同样有 chatId 路由问题 |

**核心结论：** 基础设施和 Agent 交互逻辑没问题，但 `chatId` 路由是关键缺陷。
HEARTBEAT_OK 场景下问题被掩盖（因为不发送到 IM），但真正有内容要报告时会失败。
定时任务（cron）有同样的问题。
