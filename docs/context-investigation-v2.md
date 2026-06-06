# IMtoAgent 上下文问题排查报告（v2 — 基于真实代码）

> 2026-06-05 11:55 — 修正版

---

## 一、代码地图

### 1.1 四份代码，三份不同步

| 位置 | 路径 | 状态 | 有 context-manager.ts？ |
|------|------|------|----------------------|
| **OpenClaw 工作区（git 仓库，v0.4.7）** | `~/.openclaw/workspace/imtoagent/` | 今天所有改动都在这里，25+ 已修改文件，3+ 未跟踪文件 | ✅ **有**（未跟踪，新文件） |
| **npm 全局安装（正在运行的）** | `/usr/local/lib/nodejs/lib/node_modules/imtoagent/` | 昨天 `npm install -g` 后手动改过，但**没有 context-manager** | ❌ **没有** |
| **桌面开发副本** | `~/Desktop/imtoagent/` | git 仓库，落后于工作区 | ❌ **没有** |
| **桌面备份** | `~/Desktop/imtoagent-backup-20260604-225323/` | 6月4日 22:53 快照 | ❌ **没有** |

### 1.2 正在运行的进程

```
bun run /usr/local/lib/nodejs/lib/node_modules/imtoagent/index.ts
codex app-server (IMtoAgent 后端)
```

### 1.3 关键结论

**`context-manager.ts` 是今天在工作区里新建的（未跟踪），还没有部署到运行环境中。**

当前运行的代码**没有** ContextManager，上下文管理完全靠上游 Agent（Codex/Claude）自己维护。

---

## 二、context-manager.ts 设计分析

### 2.1 文件概览

- 位置：`~/.openclaw/workspace/imtoagent/modules/proxy/context-manager.ts`
- 642 行，未跟踪
- 已被 `anthropic-proxy.ts` 和 `codex-proxy.ts`（工作区版本）import，但**未部署**

### 2.2 架构

```
normalize（Anthropic/Responses/OpenAI → 统一 NormalizedMessage）
  ↓
applyTransformations
  ├─ compressToolOutputs    ← tool output 截断
  └─ simplifySuccessOutputs ← 成功输出简化
  ↓
enforceTokenBudget          ← token 预算控制 + 按轮次截断
  ↓
denormalize（Unified → Anthropic/Responses/OpenAI）
```

### 2.3 配置

| 参数 | 值 | 说明 |
|------|-----|------|
| `maxInputTokens` | 16000 | 最大输入 token |
| `keepRecentRounds` | 2 | 保留最近 2 轮对话 |
| `maxToolOutputChars` | 2000 | tool output 最大字符数 |
| `truncateToolOutput` | true | 启用截断 |
| `simplifySuccessOutputs` | true | 简化成功输出 |

---

## 三、真实 Bug 分析

### Bug 1（严重）：`compressToolOutputs` 的 `originalLength` 赋值错误

```typescript
// context-manager.ts:223-242
const head = m.content.slice(0, headLen);
const tail = m.content.slice(-tailLen);
const truncated = m.content.length - headLen - tailLen;

m.content = `${head}\n\n... [${truncated} chars truncated] ...\n\n${tail}`;
m.metadata.truncated = true;
m.metadata.originalLength = m.content.length;  // ❌ BUG！赋值的是截断后的长度
```

`originalLength` 应该在截断**前**保存：

```typescript
// 修复
m.metadata.originalLength = m.content.length;  // ← 放在截断前
const head = m.content.slice(0, headLen);
// ...
```

### Bug 2（中等）：`enforceTokenBudget` 不检查孤儿 tool_result

```typescript
// context-manager.ts:282-325
for (let i = rest.length - 1; i >= 0; i--) {
  const msg = rest[i];
  if (msg.role === 'user') {
    rounds++;
    if (rounds > maxRounds) break;
  }
  // ...
  kept.unshift(msg);
}
```

**问题**：从后往前遍历时，只以 `user` 消息计数轮次。但 Anthropic 格式中，tool_result 嵌入在 user 消息里，而 tool_use 在 assistant 消息里。当截断发生在 tool_use/tool_result 对话中间时：

```
消息序列：
1. user: "帮我查文件"
2. assistant: tool_use(ReadFile)     ← 可能被丢弃
3. user: tool_result(ReadFile) + "继续"  ← 被保留（因为这是最后一轮 user）
```

tool_result 的 `tool_use_id` 指向一个已不存在的 tool_use → **违反 Anthropic API 的消息序列规则** → 请求被拒绝 → Agent 崩溃。

### Bug 3（中等）：`simplifySuccessOutputs` 原地修改

```typescript
// context-manager.ts:249-275
return messages.map((m) => {
  // 直接修改 m.content，但 messages 数组是 normalize 后的引用
  m.content = `✓ Success (exit code: ${exitCode})`;
  m.metadata.simplified = true;
  return m;
});
```

**问题**：`map` 创建了新数组但元素引用不变。如果同一消息列表被多次处理，简化会叠加。

### Bug 4（低）：token 估算基于截断后的内容

```typescript
// context-manager.ts:325
const finalTokens = this.estimateTokens(result);
```

`result` 已经经过 `compressToolOutputs` 和 `simplifySuccessOutputs` 的修改，token 估算反映的是截断后的长度，不是原始长度。

---

## 四、运行环境的真实情况

### 4.1 当前运行代码没有 context-manager

| 组件 | 有上下文管理？ | 管理方 |
|------|--------------|--------|
| Codex 后端 | ❌ | Codex 自己（通过 codexThreadId） |
| Claude 后端 | ❌ | Claude Code 自己（通过 sdkSessionId） |
| Anthropic Proxy | ❌ | 纯透传，只做格式转换 |

### 4.2 Codex 的旧截断逻辑（已被 ContextManager 替换，但尚未部署）

```typescript
// codex-proxy.ts（运行版本）
const MAX_INPUT_ITEMS = 120;
if (input.length > MAX_INPUT_ITEMS) {
  // 保留 system + 最近 120 条
}
```

这个逻辑在**工作区的 git diff 中已被删除**（被 ContextManager 替代），但尚未部署到运行环境。

---

## 五、git 状态（工作区）

### 5.1 已修改文件（25 个，904 行增，403 行删）

| 文件 | 改动规模 | 说明 |
|------|---------|------|
| `modules/core/goal-manager.ts` | +257 -21 | Goal 管理器大幅扩展 |
| `modules/core/heartbeat-scheduler.ts` | +52 -4 | Goal Engine 集成 |
| `modules/core/goal-store.ts` | +89 -7 | Goal 存储改进 |
| `modules/core/task-poller.ts` | +91 -1 | TaskPoller 扩展 |
| `modules/core/task-state.ts` | +33 -0 | 任务状态 |
| `modules/core/heartbeat.ts` | +105 -... | 心跳解析重构 |
| `modules/proxy/anthropic-proxy.ts` | +23 | ContextManager 集成 |
| `modules/proxy/codex-proxy.ts` | +38 -16 | ContextManager 替换旧截断 |
| `index.ts` | +73 -6 | 入口扩展 |

### 5.2 未跟踪文件（新文件）

| 文件 | 行数 | 说明 |
|------|------|------|
| `modules/proxy/context-manager.ts` | 642 | **上下文管理核心** |
| `modules/core/task-logger.ts` | — | 任务日志 |
| `modules/core/timezone.ts` | — | 时区工具 |
| `modules/cli/task-cli.ts` | — | Task CLI |
| `docs/context-explosion-solution.md` | — | 上下文爆炸方案文档 |
| `docs/plans/context-accumulation-fix.md` | — | 上下文累积修复计划 |
| `scripts/log-rotate.sh` | — | 日志轮转脚本 |

---

## 六、修复优先级

| 优先级 | 修复内容 | 影响 |
|--------|---------|------|
| **P0** | 部署 context-manager.ts 到运行环境 | 让上下文管理生效 |
| **P1** | 修复 `originalLength` 赋值顺序（Bug 1） | 数据正确性 |
| **P1** | 在 `enforceTokenBudget` 后加 `removeOrphanToolResults`（Bug 2） | 防止 API 错误 |
| **P2** | `simplifySuccessOutputs` 改为纯函数（Bug 3） | 避免副作用 |
| **P2** | 工作区代码同步回 git 并 commit | 版本管理 |

---

## 七、排查方法

| 步骤 | 命令 | 发现 |
|------|------|------|
| 确认运行进程 | `ps aux \| grep imtoagent` | bun run npm 全局安装 |
| 对比文件存在性 | `ls` 两目录的 context-manager.ts | 只有工作区有 |
| 检查引用关系 | `grep -rn ContextManager` proxy 目录 | 工作区已集成，运行代码没有 |
| 检查 git 状态 | `git status` | 25 个已修改，多个未跟踪 |
| 阅读代码逻辑 | `read` context-manager.ts | 发现 4 个 bug |
