# System Prompt 优化方案

> 日期：2025-06-05
> 状态：✅ 已完成（2025-06-05 23:10）
> 参考：OpenClaw 设计哲学 — 能力清单 ≠ 行为指令

## 问题诊断

### 核心问题：运维指令污染用户对话

`prompt-builder.ts` 在每个用户消息的 system prompt 中硬编码运维指令：

```typescript
// 第 96-110 行（永远注入）
# Gateway Runtime Logs
You can check logs to understand gateway status...
Note: Your first message after startup may have lost conversation memory.
Check logs first to understand the context.

# Scheduled Tasks
Scheduled tasks are managed via the `imtoagent task` CLI...
```

**后果**：Agent 收到用户简单消息时，把系统运维指令和用户意图混在一起处理。
用户说"你好"，Agent 可能去检查日志 + 检查任务 + 回复"你好"。

### 问题根因

| 维度 | 问题 | 正确做法 |
|------|------|----------|
| **语义** | 告诉 Agent"你应该做"（运维指令） | 告诉 Agent"你可以用"（能力清单） |
| **注入时机** | 运维指令永远注入每个用户消息 | 只在心跳/任务场景注入 |
| **优先级** | Soul 文件平铺，没有优先级标注 | 规则 > 身份 > 背景，分层标注 |
| **上下文隔离** | 心跳任务和用户对话共享同一 system prompt | 心跳/任务使用独立 system prompt |

### OpenClaw 对照

OpenClaw 的做法：
- `Tooling` section: "你可以用这些工具"（能力清单）
- `Execution Bias`: 执行偏好，不是具体任务
- `Skills`: 按需加载，不存在就不注入
- `Heartbeats`: **只在 enabled 时注入**
- **没有**硬编码运维指令

## 优化方案

### 原则

> **把运维指令从日常对话的 system prompt 里移出去，让 Agent 在用户消息面前只做用户要求的事。**

### 改动清单

#### Step 1: `prompt-builder.ts` — 删除硬编码运维指令

**删除**：
- `# Gateway Runtime Logs` 整段（约 15 行）
- `# Scheduled Tasks` 整段（约 7 行）

**改为**：一段简短的能力清单（3-4 行）

```
# Available Capabilities

When needed, you can:
- Check gateway logs at `~/.imtoagent/logs/imtoagent.log` for troubleshooting
- Manage scheduled tasks via `imtoagent task` CLI
```

从"你应该做"改为"你可以用"。

#### Step 2: `prompt-builder.ts` — Soul 文件分层注入

当前 `loadSoul()` 按顺序拼接文件，但不标注优先级。改为：

```
# Rules (MUST follow)
<rules.md content>

---

# Identity
<identity.md content>

---

# Profile
<profile.md content>

---

# Skills (use when relevant)
<skills.md content>

---

# Workspace
<workspace.md content>
```

每个 section 加标题和优先级标注。

#### Step 3: `heartbeat-scheduler.ts` — 心跳/任务使用独立 system prompt

`executeGoalAgent()` 和 `executeTaskWithTimeout()` 目前使用 `this.config.systemPrompt`（即日常对话的 system prompt）。

改为构建专用的运维 system prompt：

```typescript
function buildOperationalSystemPrompt(botKey: string): string {
  return [
    '# System Task',
    '',
    'You are executing a scheduled background task.',
    'Check gateway status, process goals/tasks, and report results.',
    '',
    '# Gateway Logs',
    '~/.imtoagent/logs/imtoagent.log',
    '',
    '# Task Management',
    'Use `imtoagent task` CLI to manage scheduled tasks.',
    '',
    loadSoul(botKey),  // Soul 文件仍然加载，但作为背景知识
  ].join('\n');
}
```

#### Step 4: Soul 文件清理

检查所有 bot 的 `identity.md`，移除"主动汇报进度"类指令。
这类指令应该放在任务的 prompt 里，不是身份定义里。

当前受影响：
- `soul/CodexBot/identity.md`: "主动汇报进度，不闷头做事"
- `soul/OpenCodeBot/identity.md`: "主动汇报进度，不闷头做事"

## 实施顺序

1. ✅ 写设计文档（本文件）
2. ⬜ Step 1: prompt-builder.ts 删除硬编码运维指令
3. ⬜ Step 2: prompt-builder.ts Soul 分层注入
4. ⬜ Step 3: heartbeat-scheduler.ts 独立运维 prompt
5. ⬜ Step 4: Soul 文件清理
6. ⬜ 同步到生产环境 + 验证
7. ⬜ 重启 Bot 测试

## 预期效果

| 场景 | 优化前 | 优化后 |
|------|--------|--------|
| 用户说"你好" | Agent 检查日志 + 检查任务 + 回复 | Agent 只回复"你好" |
| 用户问"帮我看看代码" | Agent 可能先去查日志 | Agent 直接看代码 |
| 心跳触发 | 使用日常对话 prompt（含用户画像等噪音） | 使用专用运维 prompt |
| 定时任务执行 | 使用日常对话 prompt | 使用专用运维 prompt |
