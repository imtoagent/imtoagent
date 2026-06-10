# Phase 3 Tool Intercept 完整实施方案

**版本：** V1.0  
**日期：** 2026-06-10  
**目标：** 修复本地工具调用报 "unsupported call" 的问题

---

## 一、问题背景

### 1.1 当前问题
- 调用 `imtoagent_create_goal` 等本地工具时，Codex 报 `unsupported call`
- 原因：a295585 的"边收边转发"模式把本地工具的 tool_calls 也转给了 Codex
- Codex 不认识 `imtoagent_*` 工具，所以报错

### 1.2 历史版本
- **a295585（当前回滚版本）**：边收边转发，简单但会把本地 tool_calls 误转给 Codex
- **f25bb87（问题版本）**：完全缓存 + 重建 SSE，思路对但实现有 bug

---

## 二、设计目标

### 2.1 核心原则
1. **本地工具的 tool_calls 不能转发给 Codex**
2. **本地工具在代理层自闭环执行**，执行后发第二轮请求给 LLM
3. **远端工具的 tool_calls 正常转发**给 Codex
4. **SSE 格式必须正确**，不能丢失数据

### 2.2 行为矩阵

| 场景 | 处理方式 |
|:-----|:---------|
| 无 tool_calls | 直接转发 text 给 Codex |
| 纯本地工具 | 代理层执行 → 发第二轮 → 转发结果 |
| 纯远端工具 | 转发 tool_calls 给 Codex |
| 混合工具 | 执行本地 + 转发远端 → 发第二轮（含本地结果）→ 转发结果 |

---

## 三、实现方案

### 3.1 整体流程

```
┌─────────────────────────────────────────────────────────────────┐
│ 第一轮：缓存 SSE，不转发                                          │
├─────────────────────────────────────────────────────────────────┤
│ 1. 发请求给 LLM（stream=true）                                   │
│ 2. 完全缓存 SSE 流（parseStreamToolCalls）                        │
│ 3. 解析出 tool_calls、text、reasoning                            │
└─────────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────────┐
│ 分析 tool_calls 类型                                              │
├─────────────────────────────────────────────────────────────────┤
│ - 无 tool_calls → 直接返回缓存的 text                            │
│ - 有 tool_calls → 分类本地/远端                                   │
└─────────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────────┐
│ 分支处理                                                          │
├─────────────────────────────────────────────────────────────────┤
│ A. 纯本地工具：                                                    │
│    1. 执行本地工具                                                 │
│    2. 构造第二轮 messages（assistant + tool results）              │
│    3. 发第二轮请求给 LLM                                           │
│    4. 流式转发第二轮 SSE 给 Codex                                  │
│                                                                   │
│ B. 有远端工具：                                                    │
│    1. 执行本地工具（如有），缓存结果                                │
│    2. 构造 SSE 流（text + 远端 tool_calls）返回给 Codex           │
│    3. Codex 执行远端工具后，发第二轮                                │
│    4. 合并缓存的本地结果 + Codex 的远端结果                        │
└─────────────────────────────────────────────────────────────────┘
```

### 3.2 关键函数设计

#### 3.2.1 `parseStreamToolCalls(upstreamRes)`
**职责：** 解析上游 SSE 流，收集 tool_calls、text、reasoning

**输入：** Response 对象（stream=true）  
**输出：** `{ toolCalls, assistantText, reasoningContent }`

**实现要点：**
- 逐行读取 SSE，解析 `data:` 行
- 收集 `delta.tool_calls` → 合并为完整 tool_calls
- 收集 `delta.content` → 合并为 assistantText
- 收集 `delta.reasoning_content` → 合并为 reasoningContent
- **不转发任何内容给客户端**，纯缓存

#### 3.2.2 `buildSyntheticStream(text, reasoning, model)`
**职责：** 构造纯文本响应的 SSE 流（无 tool_calls 时使用）

**SSE 事件序列：**
```
event: response.created
event: response.in_progress
event: response.output_item.added (reasoning)  [如果有]
event: response.reasoning_text.delta (多次)    [如果有]
event: response.output_item.done (reasoning)   [如果有]
event: response.output_item.added (message)
event: response.content_part.added
event: response.output_text.delta
event: response.output_text.done
event: response.content_part.done
event: response.output_item.done (message)
event: response.completed
```

**关键：** 事件格式必须和 `streamResponse` 函数输出一致

#### 3.2.3 `buildToolCallsResponseStream(toolCalls, text, reasoning, model)`
**职责：** 构造包含 tool_calls 的 SSE 流（有远端工具时使用）

**SSE 事件序列：**
```
event: response.created
event: response.in_progress
[reasoning 部分，如果有]
[message 部分，如果有]
event: response.output_item.added (function_call)  [每个 tool_call]
event: response.function_call_arguments.delta
event: response.output_item.done (function_call)
event: response.completed
```

**关键：** 
- tool_calls 的 `call_id`、`name`、`arguments` 必须完整
- 只包含远端工具的 tool_calls

#### 3.2.4 `executeLocalToolsAndBuildRound2(...)`
**职责：** 执行本地工具，构造第二轮请求的 messages

**输入：** 
- `localCalls` — 本地 tool_calls
- `collectedToolCalls` — 原始 tool_calls（用于构造 assistant 消息）
- `chatReq.messages` — 原始 messages

**输出：** 第二轮 messages 数组

**关键：**
- assistant 消息必须包含 `tool_calls` 字段（OpenAI 格式要求）
- tool results 作为 `role: tool` 消息追加

### 3.3 主流程代码结构

```typescript
// 1. 缓存第一轮
const parsed = await parseStreamToolCalls(upstreamRes);
const { toolCalls, assistantText, reasoningContent } = parsed;

// 2. 无 tool_calls → 直接返回
if (toolCalls.length === 0) {
  res.writeHead(200, SSE_HEADERS);
  res.end(buildSyntheticStream(assistantText, reasoningContent, model));
  return;
}

// 3. 分类 tool_calls
const allParsed = parseToolCalls(toolCalls);
const localCalls = allParsed.filter(tc => isLocalTool(tc.name));
const remoteCalls = allParsed.filter(tc => !isLocalTool(tc.name));

// 4. 分支处理
if (localCalls.length > 0 && remoteCalls.length === 0) {
  // 纯本地工具 → 自闭环
  await handlePureLocalTools(...);
} else if (remoteCalls.length > 0) {
  // 有远端工具 → 返回 tool_calls 给 Codex
  await handleRemoteTools(...);
}
```

### 3.4 边界情况处理

| 场景 | 处理方式 |
|:-----|:---------|
| LLM 返回空响应 | 返回空 text 的 synthetic stream |
| 本地工具执行失败 | 返回错误信息作为 tool result |
| 第二轮请求失败 | 返回 502 错误给 Codex |
| SSE 解析中断 | 返回已收集的部分数据 |
| tool_calls 参数解析失败 | 使用空对象 `{}` |

---

## 四、实施步骤

### Step 1: 实现 `parseStreamToolCalls`
- [ ] 新建函数，解析 SSE 流
- [ ] 收集 tool_calls、text、reasoning
- [ ] 单元测试：模拟 SSE 流，验证解析结果

### Step 2: 实现 `buildSyntheticStream`
- [ ] 新建函数，构造纯文本 SSE 流
- [ ] 事件序列必须和 `streamResponse` 一致
- [ ] 单元测试：验证输出格式

### Step 3: 实现 `buildToolCallsResponseStream`
- [ ] 新建函数，构造 tool_calls SSE 流
- [ ] 只包含远端工具的 tool_calls
- [ ] 单元测试：验证输出格式

### Step 4: 重构主流程
- [ ] 替换当前的"边收边转发"逻辑
- [ ] 使用 `parseStreamToolCalls` 缓存第一轮
- [ ] 根据 tool_calls 类型分支处理

### Step 5: 实现自闭环逻辑
- [ ] 执行本地工具
- [ ] 构造第二轮 messages
- [ ] 发第二轮请求并流式转发

### Step 6: 测试验证
- [ ] 测试纯本地工具场景
- [ ] 测试纯远端工具场景
- [ ] 测试混合工具场景
- [ ] 测试无 tool_calls 场景

---

## 五、风险与缓解

| 风险 | 缓解措施 |
|:-----|:---------|
| SSE 格式不正确 | 对比 `streamResponse` 输出，确保一致 |
| 延迟增加 | 第一轮缓存会增加延迟，但可接受 |
| 内存占用 | 大响应可能占用内存，设置合理限制 |
| 工具执行超时 | 设置 30s 超时，返回错误信息 |

---

## 六、验收标准

1. ✅ `imtoagent_create_goal` 等本地工具调用成功，无 "unsupported call" 错误
2. ✅ 本地工具执行结果正确返回给 LLM
3. ✅ 远端工具正常转发给 Codex
4. ✅ 无 tool_calls 场景正常工作
5. ✅ 日志清晰，便于排查问题

---

## 七、参考代码

### 7.1 f25bb87 的问题实现
- `buildSyntheticStream` 和 `buildToolCallsResponseStream` 事件序列不完整
- `parseStreamToolCalls` 解析逻辑可能有遗漏

### 7.2 streamResponse 函数
- 位于 `codex-proxy.ts:700`
- 事件序列的权威参考

---

**实施人：** Keyi  
**预计耗时：** 2-3 小时  
**优先级：** 高
