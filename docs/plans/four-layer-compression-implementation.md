# 四层渐进式上下文压缩 — 落地规划

> 2026-06-06 · 基于参考文章 + 现有 context-optimization-plan.md + 当前代码状态

---

## 一、现状诊断

### 当前问题
1. `codex-proxy.ts` 调用 `processAsync`（不存在）→ 已修复为 `process`
2. `compressToolOutputs` 只做简单 head+tail 截断，**不区分工具类型**
3. `simplifySuccessOutputs` 只覆盖 `Process exited with code 0` 这一个模式
4. `enforceTokenBudget` 超限时**直接丢弃整轮对话**，不做摘要
5. 没有 Layer 2（MicroCompact）和 Layer 3（Context Collapse）
6. 配置字段太少，无法控制各层开关

### 当前压缩效果
```
🔧 ContextManager: 10→10 msgs, ~39,707→~38,913 chars (saved 794)  ← 仅 2%
```

### Codex 实际工具集（从日志提取）
```
exec_command, write_stdin, update_plan, get_goal, create_goal, 
update_goal, request_user_input, apply_patch, view_image
```

### DeepSeek 上游 context window
- `maxInputTokens: 48000`（codex-proxy 配置）
- 实际可用输入 ≈ 48K，保留 8K 响应 = 40K 安全线

---

## 二、四层架构

```
process()
  │
  ├── Layer 1: HISTORY_SNIP          ← 纯规则，零额外 token
  │     按工具类型差异化裁剪 tool output
  │
  ├── Layer 2: MicroCompact          ← 纯规则，零额外 token
  │     清理过期/冗余结果
  │
  ├── Layer 3: Context Collapse      ← 纯规则，零额外 token
  │     折叠连续工具调用段
  │
  └── Layer 4: Auto-Compact          ← 需要调 LLM，仅 95% 触发
        全对话摘要（最后防线）

  → enforceTokenBudget()            ← 兜底裁剪
        预算仍不够时按轮次丢弃
```

**触发策略：按顺序，每层检查一次预算，够了就停。**

```typescript
applyTransformations(messages) {
  if (estimateTokens(messages) < budget * 0.7) return messages;  // 安全区

  // Layer 1 — 总是执行（成本为零）
  messages = this.historySnip(messages);

  if (estimateTokens(messages) < budget * 0.8) return messages;

  // Layer 2 — 预算 > 80% 执行
  messages = this.microCompact(messages);

  if (estimateTokens(messages) < budget * 0.85) return messages;

  // Layer 3 — 预算 > 85% 执行
  messages = this.contextCollapse(messages);

  if (estimateTokens(messages) < budget * 0.95) return messages;

  // Layer 4 — 预算 > 95% 执行（LLM 摘要）
  messages = await this.autoCompact(messages);

  return messages;
}
```

> **注意：** `process()` 当前是同步方法，Layer 4 需要异步。
> 方案：新增 `processAsync()` 方法，内部四层全跑；`process()` 只跑 Layer 1-3 + enforceTokenBudget。
> codex-proxy 的调用改为 `processAsync`。

---

## 三、各层详细设计

### Layer 1: HISTORY_SNIP（工具输出语义裁剪）

**核心思想：按工具类型差异化压缩，保留关键信息。**

#### 3.1.1 工具分类矩阵

| 工具类别 | 判断依据 | 压缩策略 | 示例 |
|---------|---------|---------|------|
| **读取类** | `cat`, `head`, `less`, `grep`, `find`, `ls -la` | 保留结构骨架（文件名、行数、关键行） | `ls -la` → 前 5 行 + 后 3 行 + 统计 |
| **文件内容** | 输出 > 50 行，像代码/配置文件 | 保留文件头（imports/class/signature）+ 文件尾 | 500 行 → ~50 行 |
| **编译/构建** | `make`, `gcc`, `cargo build`, `npm run build` | **成功→1行**，**失败→完整** | ✓ Build OK / ✗ Error: ... |
| **测试** | `pytest`, `jest`, `cargo test` | 保留失败用例 + 统计行，跳过通过列表 | `3 passed, 1 failed` → 只保留 failed 详情 |
| **Git** | `git diff`, `git log`, `git status` | diff 保留 hunk header + 变更行；log 保留 commit msg | 200 行 diff → ~30 行 |
| **写入/编辑** | `exec_command` + write/patch 语义 | 只保留结果确认（文件名、行数） | `✓ Wrote main.ts (1200 bytes)` |
| **浏览器/视觉** | `view_image`, screenshot | 只保留元信息 | `✓ Screenshot: 1920x1080` |
| **空/极短输出** | content < 50 chars | 信号化 | `✓ exit 0` |
| **错误/失败** | 包含 `Error:`, `error:`, `FAILED`, `stderr`, 非零退出码 | **完整保留，不压缩** | 原样 |

#### 3.1.2 实现入口

```typescript
// 新增方法，替换现有的 compressToolOutputs + simplifySuccessOutputs
private historySnip(messages: NormalizedMessage[]): NormalizedMessage[] {
  return messages.map(m => {
    if (m.role !== 'tool' || !m.content) return m;
    if (m.metadata.simplified || m.metadata.snipped) return m;

    // 优先级 1: 错误 → 不压缩
    if (this.isErrorOutput(m.content)) return m;

    // 优先级 2: 按工具名分类
    const toolName = this.inferToolName(m);
    const strategy = this.getSnipStrategy(toolName, m.content);
    
    if (strategy) {
      const result = strategy(m.content);
      if (result !== m.content) {
        m.content = result;
        m.metadata.snipped = true;
        m.metadata.snipStrategy = strategy.name;
      }
    }

    // 优先级 3: 兜底 — 超长文本通用压缩
    if (!m.metadata.snipped && m.content.length > this.config.maxToolOutputChars) {
      m.content = this.genericSnip(m.content, this.config.maxToolOutputChars);
      m.metadata.snipped = true;
      m.metadata.snipStrategy = 'generic';
    }

    return m;
  });
}
```

#### 3.1.3 工具名推断

Codex 的 tool messages 没有直接的 `name` 字段，需要从内容推断：

```typescript
private inferToolName(msg: NormalizedMessage): string {
  // 从对应的 assistant toolCall 推断（通过 toolCallId 关联）
  // 如果无法关联，从输出内容模式推断
  const content = msg.content;
  
  if (content.includes('exit code: 0') && content.length < 300) return 'empty_success';
  if (/^(File|Directory) listing/i.test(content)) return 'ls';
  if (content.includes('diff --git')) return 'git_diff';
  if (/^\d+ (passed|failed|skipped)/m.test(content)) return 'test';
  if (/error:|Error:|stderr:/i.test(content)) return 'error';
  if (content.split('\n').length > 50) return 'file_content';
  
  // 尝试从 toolCallId 关联 assistant 的 tool_calls
  const callName = this.findToolCallName(msg.toolCallId);
  if (callName) return callName;
  
  return 'unknown';
}
```

#### 3.1.4 保留预期

| 场景 | 原始 | Layer 1 后 | 节省 |
|------|------|-----------|------|
| 长 ls 输出（200 行） | ~8000 chars | ~800 chars | 90% |
| 编译成功（冗长日志） | ~5000 chars | ~50 chars | 99% |
| 测试通过 50 个 | ~3000 chars | ~50 chars | 98% |
| git diff（200 行） | ~12000 chars | ~3000 chars | 75% |
| 错误输出 | ~5000 chars | ~5000 chars | 0%（保护） |

---

### Layer 2: MicroCompact（清理冗余）

**核心思想：清理过期、重复、可再生的结果。**

#### 3.2.1 清理规则

| 规则 | 触发条件 | 操作 |
|------|---------|------|
| **重复读取** | 同一文件被读取多次 | 只保留最新的完整内容，旧的替换为引用 |
| **重复命令** | 相同命令连续执行且输出一致 | 只保留最后一次 |
| **过期结果** | 文件读取后已被写入/编辑 | 丢弃旧读取结果 |
| **空操作** | 工具返回空/纯空白 | 压缩为 `✓ No output` |
| **已消费输出** | tool output 之后 assistant 已基于它做了决策 | 可安全压缩（助手已经"看过了"） |

#### 3.2.2 实现

```typescript
private microCompact(messages: NormalizedMessage[]): NormalizedMessage[] {
  // 规则 1: 去重 — 相同 toolCallId 只保留最新
  messages = this.deduplicateToolResults(messages);
  
  // 规则 2: 过期检测 — 写入后失效的读取结果
  messages = this.invalidateStaleReads(messages);
  
  // 规则 3: 清理空输出
  messages = this.cleanEmptyOutputs(messages);
  
  return messages;
}
```

#### 3.2.3 保留预期

| 场景 | 节省 |
|------|------|
| 调试循环（反复读同一文件 5 次） | 节省 4 次的完整内容 |
| 编辑文件后之前的旧读取 | 自动失效 |
| 连续 `ls` 无变化 | 合并为 1 次 |

---

### Layer 3: Context Collapse（折叠对话段）

**核心思想：把连续的工具调用-结果对压缩成紧凑格式。**

#### 3.3.1 折叠规则

```
原结构（4 条消息）:
  assistant: tool_calls=[read_file, read_file]
  tool: 文件 A 内容（500 行）
  tool: 文件 B 内容（300 行）

折叠后（3 条消息）:
  assistant: [Summary] Read 2 files: A (500 lines), B (300 lines)
  tool: [Compressed] A: [Read: A — 500 lines], B: [Read: B — 300 lines]
```

#### 3.3.2 折叠模式

| 模式 | 触发条件 | 折叠方式 |
|------|---------|---------|
| **连续读取** | assistant 连续调 read ≥ 2 次 | 合并 tool results，每条替换为元信息摘要 |
| **连续写入** | assistant 连续调 write/patch ≥ 2 次 | 保留最后一次结果，前面的替换为确认 |
| **思考链** | assistant text 很短 + 单个工具调用 | 合并为一条（去掉中间 text） |

#### 3.3.3 实现

```typescript
private contextCollapse(messages: NormalizedMessage[]): NormalizedMessage[] {
  // 扫描消息序列，识别可折叠的段
  const collapsed: NormalizedMessage[] = [];
  let i = 0;
  
  while (i < messages.length) {
    // 检测: assistant(tool_calls) → tool → tool → ...
    if (this.isAssistantWithTools(messages[i]) && i + 1 < messages.length) {
      const toolCalls = messages[i].toolCalls || [];
      const toolResults = this.collectToolResults(messages, i + 1, toolCalls.length);
      
      if (toolResults.length >= 2 && this.isCollapsible(toolCalls, toolResults)) {
        collapsed.push(this.collapseSegment(messages[i], toolResults));
        i += toolResults.length + 1;
        continue;
      }
    }
    
    collapsed.push(messages[i]);
    i++;
  }
  
  return collapsed;
}
```

#### 3.3.4 保留预期

| 场景 | 节省 |
|------|------|
| 批量读取 5 个文件 | 消息数 11→3，tokens ~60% |
| 连续写入 3 个文件 | 消息数 7→3，tokens ~50% |

---

### Layer 4: Auto-Compact（全量摘要）

**核心思想：token 接近窗口上限时，调 LLM 对老轮次生成摘要。**

#### 3.4.1 触发条件

```
当前 tokens > maxInputTokens * 0.95 → 触发
```

#### 3.4.2 摘要策略

```
保留（不摘要）:
  - system prompt（完整）
  - 最新 2 轮（完整）
  - 用户的明确指令（提取保留）

摘要（调 LLM）:
  - 中间的对话轮次 → 压缩为结构化摘要
  - 格式: "[对话摘要] 用户请求X，助手做了Y，结果Z"

丢弃:
  - 最早的、与当前任务无关的轮次
```

#### 3.4.3 实现

```typescript
private async autoCompact(messages: NormalizedMessage[]): Promise<NormalizedMessage[]> {
  // 分离：system + 保留轮次 + 待摘要轮次
  const { system, recent, old } = this.splitForCompaction(messages);
  
  if (old.length === 0) return messages;
  
  // 调 LLM 生成摘要
  const summary = await this.generateSummary(old);
  
  // 重组：system + 摘要 + recent
  return [
    ...system,
    this.createSummaryMessage(summary),
    ...recent,
  ];
}
```

#### 3.4.4 摘要 prompt 设计

```
你是一个对话摘要助手。请将以下对话轮次压缩为结构化摘要。

要求：
1. 保留用户的核心需求和指令
2. 保留助手的关键决策和代码变更
3. 保留最终达成的结论
4. 丢弃中间的工具调用细节、试错过程
5. 输出格式: [摘要] 一段话，不超过 200 字

待摘要的对话：
{old_conversation_text}
```

#### 3.4.5 成本考量

- Layer 4 本身消耗约 500-1000 tokens
- 但能将 30K+ tokens 的旧对话压缩到 ~500 tokens
- 净节省 95%+
- **风险：** 摘要可能丢失细节 → 所以只在 95% 窗口时触发

---

## 四、配置扩展

### 4.1 新增配置字段

```typescript
interface ContextConfig {
  // 现有
  backend: BackendType;
  budget: ContextBudget;
  keepRecentRounds: number;
  maxToolOutputChars: number;
  truncateToolOutput: boolean;
  simplifySuccessOutputs: boolean;
  preserveSystemPrompt: boolean;
  preserveReasoning: boolean;
  debugLog?: boolean;
  
  // 新增 — 四层压缩控制
  compressionLayers: {
    historySnip: boolean;      // Layer 1, 默认 true
    microCompact: boolean;     // Layer 2, 默认 true
    contextCollapse: boolean;  // Layer 3, 默认 true
    autoCompact: boolean;      // Layer 4, 默认 true
  };
  
  // 新增 — 触发阈值
  compressionThresholds: {
    layer1Start: number;       // 0.7 (70% 预算)
    layer2Start: number;       // 0.8 (80% 预算)
    layer3Start: number;       // 0.85 (85% 预算)
    layer4Start: number;       // 0.95 (95% 预算)
  };
  
  // 新增 — Layer 4 配置
  autoCompact: {
    model?: string;            // 用哪个模型做摘要（默认用当前模型）
    maxSummaryTokens: number;  // 摘要最大 tokens（默认 500）
    keepLastRounds: number;    // 保留最近几轮不摘要（默认 2）
  };
}
```

### 4.2 codex-proxy 配置更新

```typescript
const codexContextManager = new ContextManager({
  backend: 'openai',
  budget: {
    maxTokens: 64000,
    reservedForResponse: 8000,
    maxInputTokens: 48000,
  },
  keepRecentRounds: 2,
  maxToolOutputChars: 2000,
  truncateToolOutput: true,
  simplifySuccessOutputs: true,
  preserveSystemPrompt: true,
  preserveReasoning: false,
  
  // 新增
  compressionLayers: {
    historySnip: true,
    microCompact: true,
    contextCollapse: true,
    autoCompact: true,
  },
  compressionThresholds: {
    layer1Start: 0.7,
    layer2Start: 0.8,
    layer3Start: 0.85,
    layer4Start: 0.95,
  },
});
```

---

## 五、实施顺序（5 个 Commit）

### Commit 1: 基础设施 + 工具分类

**范围：**
- 扩展 `ContextConfig` 接口（新增字段）
- 新增 `ToolCategory` 枚举和分类函数
- 新增 `historySnip()` 方法 + 策略注册表
- 替换旧的 `compressToolOutputs` + `simplifySuccessOutputs`
- 添加日志统计

**文件：** `context-manager.ts`

**验证：** 日志中出现分层统计，`historySnip` 命中常见工具类型

---

### Commit 2: MicroCompact

**范围：**
- 新增 `microCompact()` 方法
- 去重检测（相同文件/命令的重复结果）
- 过期检测（写入后失效的读取）
- 空输出清理

**文件：** `context-manager.ts`

**验证：** 调试循环场景日志显示去重命中

---

### Commit 3: Context Collapse

**范围：**
- 新增 `contextCollapse()` 方法
- 连续工具调用段识别
- 折叠压缩逻辑

**文件：** `context-manager.ts`

**验证：** 多工具调用场景消息数减少

---

### Commit 4: Auto-Compact + processAsync

**范围：**
- 新增 `processAsync()` 方法（支持 Layer 4 的异步 LLM 调用）
- 新增 `autoCompact()` 方法
- 摘要 prompt + LLM 调用
- `codex-proxy.ts` 改回 `processAsync`

**文件：** `context-manager.ts`, `codex-proxy.ts`

**验证：** 超长对话触发摘要，日志显示 Layer 4 生效

---

### Commit 5: 集成测试 + 日志优化

**范围：**
- 统一的压缩统计日志格式
- 各层命中次数/节省 tokens 统计
- 开关测试（逐层关闭验证独立性）
- 同步到开发目录

**文件：** `context-manager.ts`, `codex-proxy.ts`

**验证：** 四层可以独立开关，日志清晰

---

## 六、风险与回退

### 6.1 安全网

```typescript
// 压缩后校验
validateCompressedMessages(original, compressed): boolean {
  return (
    this.checkMessageOrder(compressed) &&           // 顺序不变
    this.checkToolPairing(compressed) &&            // tool_use/tool_result 配对完整
    this.checkLatestRoundsIntact(compressed) &&     // 最近 N 轮完整
    this.hasUserMessage(compressed)                 // 至少一条 user 消息
  );
}
```

### 6.2 降级路径

```
Layer 1-3: 纯规则，无外部依赖，不回退
Layer 4: LLM 调用失败 → 跳过 Layer 4，走 enforceTokenBudget 兜底
```

### 6.3 开关

- 每层可独立关闭
- `compressionLayers: { historySnip: false, ... }` → 该层不执行
- 全部关闭 → 退回纯透传（仅 enforceTokenBudget）

---

## 七、预期效果

| 对话阶段 | 原始 tokens | Layer 1 | Layer 2 | Layer 3 | Layer 4 | 最终 | 总节省 |
|---------|------------|---------|---------|---------|---------|------|--------|
| 短对话 (5 轮) | 12K | 11K | 11K | 11K | — | 11K | 8% |
| 中对话 (15 轮) | 35K | 18K | 15K | 12K | — | 12K | 66% |
| 长对话 (25 轮) | 55K | 25K | 20K | 15K | 5K | 5K | 91% |
| 超长 (40 轮) | 80K | 35K | 28K | 20K | 8K | 8K | 90% |

> 注：Layer 4 后仍超预算 → `enforceTokenBudget` 兜底裁剪

---

## 八、同步规则

每次修改后：
1. 更新开发目录 `~/.openclaw/workspace/imtoagent/modules/proxy/context-manager.ts`
2. 直接覆盖生产环境 `/usr/local/lib/nodejs/lib/node_modules/imtoagent/modules/proxy/context-manager.ts`
3. `diff` 或 `md5` 验证一致性
4. 重启 `imtoagent` 生效
