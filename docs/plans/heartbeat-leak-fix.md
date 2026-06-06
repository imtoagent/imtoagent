# Heartbeat 协议误触发修复方案

## 问题描述

用户发送"你好"等普通消息时，回复被 `{"status": "ok"}` 污染。

**时间线（2026-06-05 10:29）：**
```
[10:29:49] MSG IN "你好"
[10:29:50] → 调用 exec_command, get_goal
[10:29:56] → 连续 12 轮 tool_call / tool_output
[10:30:35] MSG OUT → 用户收到 {"status": "ok"}
```

**对话流（来自 `/tmp/codex-body.json`）：**
| # | Role | 内容 |
|---|------|------|
| [2] | user | "你好" |
| [3] | function_call | exec_command |
| [6] | function_call_output | {"goal": null, ...} |
| [7] | **assistant** | `{"status": "ok"}` ← 误触发 |
| [8] | user | "你好"（用户重发） |

## 架构梳理

### 当前架构（重构后）

```
HeartbeatScheduler (纯定时器，不调 LLM)
  ├── runHeartbeat()
  │     ├── syncTasks()          → 解析 HEARTBEAT.md，同步到 TaskPoller
  │     ├── goalEngine.processDueGoals()  → Goal 到期时调 Agent
  │     └── schedulePreciseTriggers()     → 精确 setTimeout 触发
  │
  ├── TaskPoller (定时任务执行)
  │     └── executeTaskWithTimeout() → runtime.processMessage() → 调 LLM
  │
  └── GoalEngine (Goal 执行)
        └── executeAgent() → runtime.processMessage() → 调 LLM
```

**关键事实：**
- **心跳本身不调 LLM** — `runHeartbeat()` 是纯定时器，只同步任务、检查 Goal 到期
- **定时任务调 LLM** — TaskPoller 到期时调 `runtime.processMessage()` 执行任务
- **Goal 调 LLM** — GoalEngine 到期时调 `runtime.processMessage()` 执行 Goal
- **普通消息调 LLM** — 用户消息走 Codex Proxy → `runtime.processMessage()`

三条路径（任务/Goal/普通消息）最终都走 `runtime.processMessage()` + `buildSystemPrompt()`，共享同一个系统提示词。

### `{"status": "ok"}` 的来源

`prompt-builder.ts` 中残留了旧版心跳协议指令：

```
## Heartbeat Protocol
When you receive a heartbeat prompt, you MUST reply with exactly one JSON object.
{"status": "ok"}
```

问题在于：
1. 心跳已重构为纯定时器，**不再走 LLM**
2. 但这段指令**仍然存在于系统提示词中**
3. 所有走 LLM 的路径（普通消息/任务/Goal）都会看到这段指令
4. 模型在处理"你好"时，经过多轮工具调用后，可能误把当前对话当作心跳检测，输出了 `{"status": "ok"}`

### 排除项
- ❌ 不是 context-manager 截断（上下文完整传递）
- ❌ 不是 proxy 路由错误
- ❌ 不是飞书消息格式问题（MSG OUT len=910）
- ❌ 不是心跳流程调了 LLM（心跳已不依赖 LLM）

## 修复方案

**直接删除 `prompt-builder.ts` 中的心跳协议段落。**

心跳已重构为纯定时器，不再需要 LLM 理解或响应心跳协议。这段残留指令不仅无用，还会混淆模型。

### 修改内容

```diff
- // 3.5. Heartbeat & Scheduled Tasks Protocol
- sections.push(`# Heartbeat & Scheduled Tasks
- 
- The gateway periodically sends you heartbeat prompts...
- ## Heartbeat Protocol
- When you receive a heartbeat prompt, you MUST reply with...
- ... (约 25 行)
- Do NOT edit HEARTBEAT.md directly — always use the CLI.`);

+ // 3.5. Scheduled Tasks
+ sections.push(`# Scheduled Tasks
+ 
+ - Scheduled tasks are managed via the \`imtoagent task\` CLI.
+ - Use **Bash** tool to run...
+ - Tasks run independently and can perform periodic checks.`);
```

### 实施步骤
1. 修改 `prompt-builder.ts` — 删除心跳协议段落 ✅
2. 同步到生产环境 ✅
3. 重启 IMtoAgent ✅

### 验证
- 发"你好" → 正常回复，不输出 `{"status": "ok"}`
- 定时任务正常执行（TaskPoller 独立运行）
- Goal 正常执行（GoalEngine 独立运行）

---

**日期：** 2026-06-05
**状态：** 已实施
