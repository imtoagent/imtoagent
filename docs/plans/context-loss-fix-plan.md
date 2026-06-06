# Context Loss 修复计划

> **问题：** 用户在对话中发现 LLM 响应"失忆"——忘记前几轮的关键信息。
> **根因：** ContextManager 的 `enforceTokenBudget` 配置 `keepRecentRounds: 2` + `maxInputTokens: 16000`，当最新 round（含大量 tool output）超过 16000 tokens 时，**整轮被丢弃**。
> **影响范围：** Codex 后端（responses API），Anthropic 后端同理。

---

## 一、完整链路分析

### 数据流

```
用户发消息
  → Codex App-Server (thread 历史完整)
    → POST /v1/responses → imtoagent proxy
      → ContextManager.process()        ← 🔴 主要截断点
        → enforceTokenBudget()           ← 🔴 按 round 裁剪
        → compressToolOutputs()          ← 🔴 单 tool output > 2000 字符截断
        → simplifySuccessOutputs()       ← 🟡 成功输出简化
      → responsesToChat()               ← 格式转换
        → cleanOrphanTools()             ← 🟡 清理孤儿 tool 消息
        → validateToolPairing()          ← 🟡 验证 tool_call 配对
      → fetch(UPSTREAM) → DeepSeek
```

### 截断点汇总

| # | 函数 | 文件 | 触发条件 | 影响 |
|---|------|------|----------|------|
| 1 | `enforceTokenBudget` | context-manager.ts | 最近 2 轮 > 16000 tokens | 🔴 **整轮丢弃** |
| 2 | `compressToolOutputs` | context-manager.ts | 单 tool output > 2000 字符 | 🔴 截断为头尾片段 |
| 3 | `simplifySuccessOutputs` | context-manager.ts | `Process exited with code 0` 且 <300 字符 | 🟡 替换为简化消息 |
| 4 | `cleanOrphanTools` | codex-proxy.ts | tool 消息无对应 tool_call_id | 🟡 丢弃孤儿 tool |
| 5 | `validateToolPairing` | codex-proxy.ts | tool_call 无对应 tool 响应 | 🟡 保留原文 + 警告 |

### 最高风险场景

**场景：** 用户发一条消息 → LLM 返回 80 个 tool_call → 80 个 tool output（每个 500 字符）
- 80 × 500 = 40,000 字符 ≈ 10,000 tokens
- 加上用户消息 + assistant 原文 + system prompt，**轻松超过 16000 tokens**
- 结果：**整轮被丢弃，用户消息 + LLM 回复全部丢失**

---

## 二、修复方案

### 方案 A：智能 Round 裁剪（推荐）

**核心思路：** 不再粗暴丢弃整轮，而是保留 user 消息，裁剪 tool output。

#### 修改 `enforceTokenBudget()`

```typescript
// 当前逻辑（有问题）：
// 如果最新轮 > maxInputTokens，整轮丢弃
if (roundTokenEstimate > maxTokens) {
  // 丢弃整轮 ❌
  continue;
}

// 修复后逻辑：
if (roundTokenEstimate > maxTokens) {
  // 保留 user 消息，裁剪 tool output ✅
  const kept = [];
  for (const msg of round) {
    if (msg.role === 'user') {
      kept.push(msg); // 必须保留用户输入
    } else if (msg.role === 'assistant') {
      kept.push(msg); // 保留 assistant 原文
    } else if (msg.role === 'tool') {
      // 裁剪 tool output 而非丢弃整条消息
      if (msg.content.length > 1000) {
        kept.push({
          ...msg,
          content: msg.content.slice(0, 600) + '\n...[truncated]...\n' + msg.content.slice(-400)
        });
      } else {
        kept.push(msg);
      }
    }
  }
  keptRounds.push(kept);
}
```

#### 修改优先级：P0

- 确保用户消息永远不会被丢弃
- 确保 assistant 原文（含 reasoning）不会被丢弃
- tool output 可以裁剪，但不能整条删除

### 方案 B：提高 token 预算

**核心思路：** 将 `maxInputTokens` 从 16000 提高到 32000 或更高。

#### 修改位置

```typescript
// config 或硬编码
const defaultConfig: ContextConfig = {
  backend: 'responses',
  budget: {
    maxTokens: 64000,        // 16000 → 64000
    reservedForResponse: 8000,
    maxInputTokens: 48000,   // 16000 → 48000
  },
  keepRecentRounds: 2,
  maxToolOutputChars: 2000,
  // ...
};
```

#### 修改优先级：P1

- 治标不治本：如果 tool output 更多，仍然会触发
- 但作为方案 A 的补充，提供更大的安全边际

### 方案 C：动态压缩 tool output

**核心思路：** 在 `compressToolOutputs` 之前，检测 token 预算，动态调整压缩阈值。

```typescript
function compressToolOutputs(messages: NormalizedMessage[], config: ContextConfig): NormalizedMessage[] {
  // 当前：固定 2000 字符
  const maxChars = config.maxToolOutputChars; // 2000

  // 修复后：根据当前 token 使用率动态调整
  const totalEstimate = estimateTotalTokens(messages);
  const budgetRatio = totalEstimate / config.budget.maxInputTokens;

  let dynamicMaxChars = maxChars;
  if (budgetRatio > 0.8) {
    // 预算使用率 > 80%，进一步压缩
    dynamicMaxChars = Math.max(500, maxChars * (1 - budgetRatio));
  }

  // 使用 dynamicMaxChars 替代固定 maxChars
  // ...
}
```

#### 修改优先级：P2

- 优化型改进，不是必须
- 配合方案 A 使用效果更佳

---

## 三、实施步骤

### Phase 1：紧急修复（P0）

1. **修改 `enforceTokenBudget()`**
   - 文件：`modules/proxy/context-manager.ts`
   - 改动：约 30 行
   - 确保 user 消息和 assistant 原文不被丢弃

2. **测试验证**
   - 构造 80 tool_call 的测试场景
   - 验证用户消息保留
   - 验证 assistant 原文保留
   - 验证 tool output 被正确裁剪

### Phase 2：预算调优（P1）

3. **提高 `maxInputTokens` 默认值**
   - 文件：`modules/proxy/context-manager.ts`
   - 改动：约 5 行
   - 从 16000 → 48000

4. **测试验证**
   - 验证正常对话不受影响
   - 验证大 round 对话不再触发截断

### Phase 3：动态压缩（P2，可选）

5. **实现 `compressToolOutputs` 动态阈值**
   - 文件：`modules/proxy/context-manager.ts`
   - 改动：约 20 行

---

## 四、回滚方案

- 修改前备份 `context-manager.ts` 为 `context-manager.ts.bak`
- 如发现问题，立即恢复备份
- 所有修改在开发环境测试通过后再同步到生产环境

---

## 五、影响评估

| 修改 | 风险 | 影响范围 |
|------|------|----------|
| enforceTokenBudget 修复 | 低 | 仅影响 token 裁剪逻辑 |
| 提高 maxInputTokens | 极低 | 仅影响 token 上限 |
| 动态压缩 | 低 | 仅影响 tool output 压缩阈值 |

**不会影响的模块：**
- `codex-proxy.ts`（格式转换）
- `anthropic-proxy.ts`（Anthropic 代理）
- `codex-exec-server.ts`（app-server 逻辑）
- 任何 IM 相关模块

---

## 六、时间预估

| 阶段 | 工作内容 | 预估时间 |
|------|----------|----------|
| Phase 1 | enforceTokenBudget 修复 + 测试 | 30 分钟 |
| Phase 2 | 预算调优 + 测试 | 15 分钟 |
| Phase 3 | 动态压缩（可选） | 20 分钟 |
| 总计 | | **约 65 分钟** |

---

*创建时间：2025-06-05*
*状态：待审核*
