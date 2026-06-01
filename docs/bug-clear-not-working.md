# Bug Report: `/clear` 命令无效

**严重程度**：P1 — 功能缺陷

**影响范围**：所有后端（Codex、Claude、OpenCode）

**状态**：未修复

---

## 现象

发送 `/clear` 后收到确认消息 `🗑 Conversation cleared (next message will start a fresh session)`，但下一条消息：

- **Codex**：继续使用旧 `codexThreadId`，input items 持续累积（如 102 → 104），不会创建新 thread
- **Claude**：`sdkSessionId` 未被清理，继续 resume 旧 session
- **OpenCode**：`ocSessionId` 未被清理，继续使用旧 session

结果：AI 上下文无限膨胀，token 消耗持续增长，对话质量下降。

---

## 根因：Session 双键分裂

imtoagent 的 `CustomSessionManager` 使用同一个 `Map<string, ChatSession>`，但 `handleMessage` 和 `runtime` 使用不同的 key 访问：

| 调用位置 | 文件:行号 | session key | 持久化文件 |
|---------|----------|------------|-----------|
| `Bot.handleMessage()` | `index.ts:778` | `chatId`（Feishu openChatId，如 `oc_fb1fcf3d...`） | `sessions/CodexBot/oc_fb1fcf3d....json` |
| `AgentRuntime._processMessageInternal()` | `modules/core/runtime.ts:174` | `botName`（如 `"CodexBot"`） | `sessions/CodexBot/CodexBot.memory.json` |

内存中 `Map` 存有两个互不关联的 session 对象：

```
Map {
  "oc_fb1fcf3d..."  → Session A  (chatId-session)
  "CodexBot"         → Session B  (botName-session)
}
```

### 完整 BUG 链路

```
1. 用户发送 /clear
   └─ Bot.handleMessage()
       └─ getOrCreate(chatId="oc_fb...")  → Session A
       └─ cmd('/clear'): Session A.startFresh = true
       └─ persist: 写入 oc_fb....json ✅

2. 用户发送下一条消息
   └─ Bot.handleMessage()
       └─ getOrCreate(chatId="oc_fb...")  → Session A (startFresh = true)
       └─ tryHandleCommand → null（非命令）
       └─ 进入 runtime.processMessage()
           └─ getOrCreate(botName="CodexBot") → Session B (startFresh = false) ❌
           └─ if (session.startFresh) → false → 跳过清理
           └─ adapter.handleMessage(input.session = Session B)
               ├─ Codex:   isFresh = false, 旧 threadId 仍在 → 续用旧 thread
               ├─ Claude:  shouldClear = false → resume 旧 sdkSessionId
               └─ OpenCode: shouldClear = false → 续用旧 ocSessionId
```

**关键点**：`/clear` 设置的是 Session A 的 `startFresh`，但 runtime 实际使用的是 Session B。两个 session 互不相通，清理永远不会触发。

### 证据

1. 日志中无 `[Runtime] startFresh: cleared old session` 行，证明 runtime 的清理逻辑从未执行。
2. Session 文件对比：

```json
// oc_fb1fcf3d...json — ChatId-session，startFresh: true（被 /clear 正确设置）
{
  "chatId": "oc_fb1fcf3d...",
  "startFresh": true,
  "codexThreadId": "019e2fb2..."
}

// CodexBot.memory.json — botName-session，startFresh: false（runtime 实际使用）
{
  "chatId": "CodexBot",
  "startFresh": false,
  "codexThreadId": "019e3dae..."
}
```

---

## 修复方案

### 方案 A：统一使用 `chatId` 作为 session key（推荐）

**思路**：runtime 不再传入 `botName` 作为 session key，改为使用 `ctx.chatId`。一个 Feishu 对话对应一个 session，语义正确。

**文件**：`modules/core/runtime.ts`

**改动**（共 2 处，第 174 行和第 339 行）：

```diff
  // 第 1 处：消息处理前获取 session
- const session = await this.config.sessionManager.getOrCreate(
-   botName,
-   ctx.chatId,
-   ctx.userId
- );
+ const session = await this.config.sessionManager.getOrCreate(
+   ctx.chatId,
+   ctx.userId
+ );

  // 第 2 处：错误恢复 / 重试时获取 session
- const session = await this.config.sessionManager.getOrCreate(
-   botName,
-   ctx.chatId,
-   ctx.userId
- );
+ const session = await this.config.sessionManager.getOrCreate(
+   ctx.chatId,
+   ctx.userId
+ );
```

**修复后流程**：

```
/clear → handleMessage → getOrCreate(chatId) → Session.startFresh = true ✅
下一条  → handleMessage → getOrCreate(chatId) → 同一 Session → startFresh = true
        → runtime → getOrCreate(chatId) → 同一 Session → startFresh = true → 清理 ✅
                                                  ↓
                     adapter.handleMessage(input.session)
                     → session.startFresh = true
                     → 所有后端正确重置上下文
```

**风险评估**：低

- `chatId` 是 Feishu openChatId，全局唯一，session 隔离性不损失
- `botName` 原仅作 session key，移除不影响任何功能
- 需要确认 `_appServerGen` 等 per-bot 状态未写入 session；如已写入，需额外处理

**附加操作**：

- 删除旧僵尸文件 `sessions/CodexBot/CodexBot.memory.json`，避免后续混淆
- 如有多 bot 共享场景，可保留 `sessions/<BotName>/` 子目录结构，仅将文件名从 `CodexBot.memory.json` 改为 `<chatId>.memory.json`

---

### 方案 B：`/clear` 时双键清除（不推荐）

**改动**：`index.ts` `/clear` handler 中同时设置两个 session 的 `startFresh`。

```typescript
cmd('/clear', async ({ session, chatId }) => {
  if (session) {
    session.startFresh = true;
    // 同时查找并清除 botName-session
    const botSession = this.sessions.get(this.id);
    if (botSession) botSession.startFresh = true;
    return '🗑 Conversation cleared';
  }
  return '✅ No active conversation';
});
```

**风险**：高

- 治标不治本——其他依赖 session 状态的功能（统计、metadata）可能仍有键不一致问题
- 新增耦合：`/clear` handler 需要知道 runtime 内部使用的 session key 策略
- 如果未来有其他路径访问 botName-session（如 `/restart`、`/stats`），需要同步修改

---

### 方案 C：SessionManager 内部做键映射（不推荐）

**改动**：在 `CustomSessionManager.getOrCreate` 内，如果传入 botName 且找不到对应 key，自动 fallback 到 chatId-session。

**风险**：中

- 引入隐式迁移逻辑，增加调试困难
- 不解决双 session 文件并存的问题
- 后续维护者难以理解为什么一个方法接受两种不同类型的 key

---

## 建议

**推荐方案 A**。原因：

1. 改动最小（2 行），语义最清晰
2. 一次性彻底解决双键分裂问题
3. 无向后兼容风险——`chatId` 是天然的唯一标识
4. 所有后端统一受益，无需分别修改

执行后重启网关即可生效。
