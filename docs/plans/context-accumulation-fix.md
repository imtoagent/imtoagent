# Context Accumulation Fix — 规划与实施

> 日期: 2026-06-04 | 状态: 执行中

---

## 一、问题分析

### 当前架构

| 路径 | Session Key | Thread 策略 | 问题 |
|------|------------|------------|------|
| 用户聊天 | 主 session | 复用同一 thread，永不旋转 | ❌ 持续累积，16→120 items |
| Goal 执行 | `${bot}:heartbeat` | `startFresh=true`，每次新 thread | ✅ goal 间已隔离 |
| Cron 任务 | `${bot}:cron:${name}` | `MAX_CRON_ROUNDS=10` 后旋转 | ✅ 已有保护 |

### 日志证据

```
input items: 16 → 21 → 26 → 33 → 41 → ... → 89 → ... → 120
```

每轮用户消息增长 2-5 items（message + function_call × N + function_call_output × N）。
没有上限，没有剪枝，没有摘要。

### 根因

- `runViaAppServer` 复用同一 `codexThreadId`，每轮 `sendPrompt` 追加新消息
- Codex thread 保留全部历史，无法删除旧项
- `startFresh` 只在 session 初始化时为 true，之后永远 false
- 用户聊天路径没有 `_chatRounds` 计数器

### 关键发现（代码审查后）

Goal 执行已经通过 `resolveHeartbeat()` 使用独立 session，且 `session.startFresh = true` 确保每次 goal 执行创建新 thread。**Goal 执行不会污染用户聊天上下文。** 问题纯粹在用户聊天 thread 的无限增长。

---

## 二、解决方案

### 方案选择：Thread Rotation（自动）

| 方案 | 复杂度 | 效果 | 副作用 |
|------|--------|------|--------|
| Thread Rotation | 低 | 防崩溃，用户无感知 | 丢失历史（但 Agent 记忆可弥补） |
| Thread Rotation + 摘要 | 中 | 防崩溃 + 保上下文 | 多一轮 LLM 调用 |
| Context Pruning | 高 | 理论上最优 | Codex 不支持删除 items |

**最终方案**: 自动 Thread Rotation（对标 `MAX_CRON_ROUNDS` 机制）
- 阈值：`MAX_CHAT_ROUNDS = 40`（约 80-120 items 时触发）
- 静默旋转，不通知用户
- 不依赖摘要（Codex 有 memories 功能可弥补）

---

## 三、实施步骤

### Step 1: 用户聊天 Thread Rotation

**文件**: `modules/agent/codex-adapter.ts`

在 `handleMessage` 中：
1. 每次用户消息后 `_chatRounds++`
2. `_chatRounds >= MAX_CHAT_ROUNDS` 时清除 `codexThreadId` 并重置计数器
3. 下一轮自动触发 `startFresh` 创建新 thread

---

## 四、改动文件清单

| 文件 | 改动 |
|------|------|
| `modules/agent/codex-adapter.ts` | 添加 `_chatRounds` 计数 + rotation 逻辑 |

---

## 五、风险控制

- **回滚方案**: 设 `MAX_CHAT_ROUNDS = Infinity` 即可关闭 rotation
- **用户体验**: 对用户完全透明
- **Codex Memories**: app-server 已启用 `--enable memories`，旋转后 Codex 可自动检索历史记忆
