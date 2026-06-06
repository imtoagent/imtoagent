# 智能上下文压缩方案

> 2026-06-06 v2 · 基于 Claude Code 消息语义的自适应压缩

---

## 一、核心思路

**不是"砍掉旧消息"，而是"理解消息内容后决定怎么压"**。

Claude Code 与模型的对话中，不同消息的信息密度天差地别：

```
用户: "帮我改这个 bug"              ← 10 tokens, 核心意图
助手: 读文件                         ← 工具调用
工具: 完整文件内容 500 行            ← 3000 tokens, 但助手已经"看过了"
助手: 分析后决定修改方案              ← 200 tokens, 决策逻辑
工具: ✓ Success (exit code 0)        ← 50 tokens, 但信号重要
工具: ✗ Error: 编译失败 + 堆栈       ← 2000 tokens, 错误信息必须保留
```

**智能压缩 = 按语义分类 + 按信息价值压缩**，不是按时间远近一刀切。

---

## 二、消息分类体系

### 2.1 Tool Output 分类（核心压缩对象）

| 类别 | 特征 | 压缩策略 | 保留比例 |
|------|------|---------|---------|
| **Error/Fail** | 包含 `Error:`、`stderr`、非零退出码 | **完整保留** | 100% |
| **Success/Empty** | `exit code 0`、空输出、极短确认 | **信号化** | 压缩到 1 行 |
| **Verbose Success** | 长文件读取、git status、ls -la | **结构摘要** | ~10% |
| **Code Output** | 编译输出、测试报告 | **结果摘要 + 错误保留** | ~20% |
| **User-facing Output** | cat 文件内容、配置展示 | **按需保留**（最新的全保留，旧的摘要） | 0-100% |

### 2.2 消息重要性分级

| 级别 | 消息类型 | 处理 |
|------|---------|------|
| **Critical** | 最新一轮的 user 消息、最后 assistant 回复 | 永远完整保留 |
| **High** | 错误信息、失败的工具调用、用户的明确指令 | 完整保留 |
| **Medium** | 成功但冗长的工具输出、旧轮次的决策逻辑 | 可压缩 |
| **Low** | 已"消费"的文件内容、空的/极短的成功输出 | 激进压缩或丢弃 |

---

## 三、压缩策略

### 3.1 Tool Output 语义压缩

不截断字符，而是**理解内容后重写**：

#### 3.1.1 文件读取类（Read tool）
```
原: [完整的 500 行文件内容]
压: [Read: /path/to/file.ts (500 lines)]  ← 只保留元信息
```
**原理**：助手已经"读过"这个文件并做出了决策，后续只需要知道"读过什么文件"，不需要重复内容。如果助手需要再次查看，它会重新调用 Read 工具。

#### 3.1.2 命令执行类（Bash tool）

```
# Success 且输出很长
原: [git status 的完整输出 200 行]
压: [Exec: git status — 200 lines, exit 0, 3 modified files]

# 有错误
原: [编译错误的完整堆栈 100 行]
压: [完整保留，不做任何压缩]

# 空输出
原: [Process exited with code 0\n\n\n]
压: ✓ exit 0
```

#### 3.1.3 写入/编辑类（Write/Edit tool）
```
原: [写入成功的完整确认 + 文件内容回显]
压: [Write: /path/to/file.ts (1200 bytes) — success]
```

### 3.2 轮次级压缩（当语义压缩后仍超限）

如果语义压缩后仍超出预算，按重要性分级丢弃：

```
最新轮 (Critical)     ██████████  永远保留
上一轮 (High)         ████████    保留
上两轮 (Medium)       ████        压缩保留
更早轮 (Low)          ██          仅保留 user 消息，tool output 丢弃
最旧轮 (Low)          ░░          整轮丢弃
```

**关键约束**：
- 同一轮内的 tool_use + tool_result 配对不拆散
- User 消息永远至少保留文本（即使丢弃了对应的 tool output）
- Assistant 的 reasoning/决策逻辑优先保留

### 3.3 重复内容合并

识别 Claude Code 的重复操作模式：

```
# 场景：多次读取同一文件（调试循环）
Read file.ts → 修改 → 执行 → 失败 → Read file.ts → 再修改 → ...

压缩：只保留最后一次读取的完整内容，之前的替换为
[Read: file.ts — previously read, see latest version]
```

---

## 四、实现架构

### 4.1 压缩层位置

```
Claude Code → [压缩层] → anthropic-proxy → 上游 API
                          ↑ 在 format 转换前处理
                          ↑ 直接操作 Anthropic 格式消息
                          ↑ 不破坏消息结构
```

**为什么在 Anthropic 格式上操作？**
- Claude Code 发送的就是 Anthropic 格式
- 不需要 normalize/denormalize（避免之前的格式破坏问题）
- 直接修改 `content` 数组中的 text 块，不碰 tool_use/tool_result 块结构

### 4.2 数据结构

```typescript
interface CompressionConfig {
  enabled: boolean;
  // 触发压缩的阈值（估算 tokens）
  threshold: number;       // 默认 16000
  // 压缩后的目标（估算 tokens）
  target: number;          // 默认 12000
  // 保留最近 N 轮不压缩
  preserveRounds: number;  // 默认 2
  // 日志
  debugLog: boolean;
}

interface CompressionResult {
  compressed: boolean;     // 是否执行了压缩
  originalTokens: number;
  compressedTokens: number;
  roundsRemoved: number;
  outputsCompressed: number;
}
```

### 4.3 压缩流程

```typescript
function smartCompress(
  messages: AnthropicMessage[],
  config: CompressionConfig
): { messages: AnthropicMessage[]; result: CompressionResult } {

  // 1. 估算当前 token 量
  const estimated = estimateTokens(messages);
  if (estimated <= config.threshold) return { messages, result: { compressed: false, ... } };

  // 2. 识别并压缩 Low 价值 tool output
  let compressed = compressLowValueToolOutputs(messages, config);

  // 3. 合并重复内容
  compressed = mergeDuplicateContent(compressed);

  // 4. 如果仍超限，按轮次丢弃（从最旧开始）
  if (estimateTokens(compressed) > config.target) {
    compressed = dropOldRounds(compressed, config);
  }

  return {
    messages: compressed,
    result: {
      compressed: true,
      originalTokens: estimated,
      compressedTokens: estimateTokens(compressed),
      ...
    }
  };
}
```

### 4.4 关键实现细节

#### 4.4.1 直接操作 Anthropic 格式

```typescript
// 不破坏消息结构，只修改 content 数组中的 text 块长度
function compressToolOutputText(content: Array<AnthropicContentBlock>): Array<AnthropicContentBlock> {
  return content.map(block => {
    if (block.type !== 'tool_result') return block;
    
    const text = typeof block.content === 'string' ? block.content : '';
    
    // 检测错误 → 不压缩
    if (text.includes('Error:') || text.includes('stderr:')) return block;
    if (text.includes('exit code') && !text.includes('exit code: 0')) return block;
    
    // 检测成功但冗长 → 压缩
    if (text.length > 2000 && text.includes('exit code: 0')) {
      const summary = summarizeVerboseSuccess(text);
      if (typeof block.content === 'string') {
        block.content = summary;
      } else if (Array.isArray(block.content)) {
        // content 是数组时，修改其中的 text 块
        block.content = block.content.map(cb => 
          cb.type === 'text' ? { ...cb, text: summary } : cb
        );
      }
    }
    
    return block;
  });
}
```

#### 4.4.2 文件读取检测

```typescript
// 识别 Read 工具的文件内容输出
function isFileReadOutput(text: string): boolean {
  // Claude Code 读取文件的特征模式
  return /^[\w./~-]+\s*\(\d+ lines?\)|^=== .* ===$/m.test(text) 
    || text.split('\n').length > 100;  // 100+ 行大概率是文件内容
}

function summarizeFileRead(text: string, path?: string): string {
  const lines = text.split('\n');
  const lang = detectLanguage(path || '');
  return `[Read: ${path || 'unknown'} — ${lines.length} lines, ${lang}]`;
}
```

#### 4.4.3 成功输出信号化

```typescript
function summarizeVerboseSuccess(text: string): string {
  const exitCode = text.match(/exit code: (\d+)/)?.[1] || '0';
  const chunk = text.match(/Chunk ID: (\w+)/)?.[1];
  const time = text.match(/Wall time: ([\d.]+)s/)?.[1];
  const lineCount = text.split('\n').length;
  
  // 提取前几行和最后几行作为上下文线索
  const firstLine = text.split('\n').slice(0, 2).join('\n');
  const lastLine = text.split('\n').slice(-1).join('');
  
  let summary = `✓ Success (exit ${exitCode}, ${lineCount} lines)`;
  if (chunk) summary += `, chunk: ${chunk}`;
  if (time) summary += `, ${time}s`;
  if (firstLine) summary += `\n  └─ ${firstLine.substring(0, 80)}`;
  
  return summary;
}
```

---

## 五、与上游协同

### 5.1 上游 token 预算感知

Claude Code SDK 本身有 context management，但它不知道 IMtoAgent 的上游 API（DeepSeek 等）的 context window 限制。

```
Claude Code SDK: 认为 context window = 200K (Claude 的)
实际上游 API:    context window = 32K (DeepSeek 的)
              ↑ 这个 gap 就是压缩的触发条件
```

压缩层需要知道上游的 context window，动态调整：

```json
"compression": {
  "upstreamContextWindow": 32000,
  "reserveForResponse": 8000,
  "threshold": 20000,
  "target": 16000
}
```

### 5.2 不干扰 Claude Code 的 session 管理

- Claude Code SDK 维护自己的 `sdkSessionId` 和完整历史
- 压缩层**只影响发送给上游 API 的消息**
- 不影响 Claude Code 本地保存的历史
- 如果 Claude Code 需要回顾旧消息，它会自己在 SDK 层面管理

---

## 六、渐进实施

| Phase | 内容 | 风险 | 验证 |
|-------|------|------|------|
| **P1: 统计** | 从上游响应解析真实 token usage | 无 | 日志确认 |
| **P2: 语义压缩** | Tool output 分类 + 压缩 | 低 | 对比压缩前后响应质量 |
| **P3: 重复合并** | 识别重复读取/操作 | 低 | 日志确认命中次数 |
| **P4: 轮次级** | 语义压缩后仍超限时的兜底 | 中 | 观察回复质量 |

### P1（立即）
- 解析上游 API 响应中的 `usage` 字段
- 写入 `usage.jsonl`
- 建立基线：当前平均 input tokens 是多少

### P2（核心）
- 实现 `smartCompress()` 函数
- 接入 anthropic-proxy 的请求处理流程
- 只在超过阈值时触发
- 压缩日志：`[SmartCompress] 28000 → 14500 tokens (48% saved), 3 outputs compressed`

### P3（优化）
- 检测重复文件读取、重复命令执行
- 合并为引用

### P4（兜底）
- 语义压缩后仍超限时，按轮次丢弃
- 保证 user 消息不丢失

---

## 七、风险控制

### 7.1 安全网

```typescript
// 压缩前做 sanity check
function validateCompressedMessages(original: AnthropicMessage[], compressed: AnthropicMessage[]): boolean {
  // 1. 消息顺序不能变
  // 2. tool_use/tool_result 配对不能断
  // 3. 最新 N 轮必须完整
  // 4. 至少保留一条 user 消息
  return checkOrder(compressed) 
    && checkToolPairing(compressed)
    && checkLatestRounds(compressed)
    && hasUserMessage(compressed);
}
```

### 7.2 开关

```json
"compression": {
  "enabled": true,
  "mode": "smart"  // "smart" | "simple" | "off"
  // smart: 语义压缩
  // simple: 简单截断（fallback）
  // off: 纯透传
}
```

### 7.3 回退策略

- 如果压缩后上游返回异常（格式错误），自动降级到 `simple` 模式
- `simple` 模式也有问题，降级到 `off`（纯透传）
- 每次压缩结果写入日志，便于事后分析

---

## 八、预期效果

基于典型 Claude Code 对话模式：

| 场景 | 原始 tokens | 压缩后 | 节省 |
|------|-----------|--------|------|
| 短对话 (< 5 轮) | 8000 | 8000 | 0%（不触发） |
| 中对话 (10 轮, 有文件读取) | 25000 | 12000 | 52% |
| 长对话 (20 轮, 多次 Read/Bash) | 45000 | 15000 | 67% |
| 超长工具输出 (测试报告 500 行) | 单条 3000 | 200 | 93% |
