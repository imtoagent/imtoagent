# IMtoAgent Consolidation Plan — Phase 14

> Created: 2026-05-31 | Version target: 0.4.2+
> 核心方针：停止堆功能，消化已有代码。

---

## 指导原则

Phase 8-13 交付了大量功能（Gemini、MCP/Skills/Prompts CLI、preset、熔断器、可观测性），但没有经过生产环境压力测试。**先消化，再扩展。**

---

## Task 1: 类型收紧 🔒

**问题**：254 个 `any` + 91 个 `catch(e: any)` — proxy 和 IM 模块的类型安全形同虚设。

### 1a. 全局 catch 类型替换（91 处 `any` → `unknown`）

- 29 个文件，纯机械替换
- 风险极低，catch 块内已经防御性处理
- **状态:** ✅ 已完成 (188 tests, 0 fail)

### 1b. Proxy 层接口定义

- 新建 `proxy/proxy-types.ts`，定义 20+ 接口：
  - Content Blocks: `AnthropicTextBlock`, `AnthropicImageBlock`, `AnthropicToolUseBlock`, `AnthropicToolResultBlock`, `AnthropicThinkingBlock`, `OpenAIImageBlock`
  - Messages: `AnthropicMessage`, `OpenAIMessage`
  - Tools: `AnthropicTool`, `OpenAITool`, `OpenAIToolCall`
  - Request/Response: `AnthropicRequestBody`, `OpenAIRequestBody`, `AnthropicStreamEvent`, `OpenAIStreamChunk`
  - 其他: `AnthropicResponseUsage`, `AnthropicToolChoice`
- `anthropic-proxy.ts`: 27 → **0** `any`
- `codex-proxy.ts`: 16 → **0** `any`
- **状态:** ✅ 已完成 (188 tests, 0 fail)

### 1c. IM 适配器事件类型

新建 `im/im-types.ts`（FeishuMessageEvent、WeComMessageFrame、ILinkResponse 等），3 个 IM 文件全部替换。

| 文件 | 替换前 | 替换后 |
|------|--------|--------|
| `im/feishu.ts` | 12 | 2（Lark SDK 类型不完整） |
| `im/wecom.ts` | 6 | 0 ✅ |
| `im/wechat.ts` | 4 | 0 ✅ |

---

### 1d. 全局剩余 `any` 清零

- `mcp-manager.ts`: 10 → 0 ✅
- `config-manager.ts`: 8 → 0 ✅
- `cli/setup.ts`: 8 → 0 ✅
- `core/config.ts`: 6 → 0 ✅
- `core/error.ts`: 5 → 0 ✅
- `codex-exec-server.ts`: 5 → 0 ✅
- `claude-adapter.ts`: 6 → 0 ✅
- `codex-adapter.ts`: 5 → 0 ✅
- `opencode-adapter.ts`: 7 → 0 ✅
- `cli/doctor.ts`: 4 → 0 ✅
- `cli/stats.ts`: 4 → 0 ✅
- `cli/session-cli.ts`: 1 → 0 ✅
- `cli/providers.ts`: 1 → 0 ✅
- `cli/healthz.ts`: 1 → 0 ✅
- `telegram.ts`: 4 → 0 ✅
- `telegram-inbound-adapter.ts`: 2 → 0 ✅
- `workspace-manager.ts`: 2 → 0 ✅
- `logger.ts`: 1 → 0 ✅
- `health-check.ts`: 1 → 0 ✅
- `types.ts`: 1 → 0 ✅
- `gemini-adapter.ts`: 1 → 0 ✅
- `core/session.ts`: 2 → 0 ✅
- `core/types.ts`: 1 → 0 ✅
- **总计：254 → 2**（仅保留 2 个 Lark SDK 类型不完整的 `as any`）
- **状态:** ✅ 已完成 (188 tests, 0 fail)

---

## Task 2: 真实环境运行 🧪

当前 0.4.1 已经在飞书 Bot 上跑了。观察 3-5 天：

- [ ] 并发队列是否生效
- [ ] 日志轮转是否触发
- [ ] 飞书重连计数器是否正常重置
- [ ] 有没有 `any` 导致的运行时错误

---

## Task 3: MCP/Skills/Prompts 集成 📦

三个管理器已接入消息流程，资源数据自动注入 system prompt。✅ 已完成

### 数据流

```
index.ts Bot 构造函数
  ├─ new McpManager(workspacePath)
  ├─ new SkillsManager(workspacePath)  
  ├─ new PromptsManager(workspacePath)
  └─ adapterCtx = { mcpManager, skillsManager, promptsManager, ... }
       ↓
各 Agent Adapter (claude/codex/opencode/gemini)
  ├─ this.ctx.mcpManager.list() → { servers: [...] }
  ├─ this.ctx.skillsManager.list() → { skills: [...] }
  ├─ this.ctx.promptsManager.list() → { prompts: [...] }
  └─ buildSystemPrompt({ mcpInfo, skillsInfo, promptsInfo })
       ↓
prompt-builder.ts
  └─ # Available Resources → MCP Servers / Installed Skills / Custom Prompts
```

### 改动文件（6 个）

| 文件 | 改动 |
|------|------|
| `index.ts` | 创建 3 个 manager 实例，注入 adapterCtx |
| `modules/agent/claude-adapter.ts` | 更新 ClaudeAdapterContext，读取 manager 数据传给 buildSystemPrompt |
| `modules/agent/codex-adapter.ts` | 同上 |
| `modules/agent/opencode-adapter.ts` | 同上 |
| `modules/agent/gemini-adapter.ts` | 同上 |
| `modules/prompt-builder.ts` | 已支持 mcpInfo/skillsInfo/promptsInfo（此前已完成，无需改） |

---

## Task 4: 收尾 + 归档 📝

- 完成 8.1.2（升级安全备份）
- 验证 8.2.3（优雅关闭时序）
- ROADMAP 归档
- logger 迁移（653 处 console → logEvent）

---

## 明确不做的

- ❌ 新 IM 适配器
- ❌ 新 Agent 后端
- ❌ 新 CLI 子命令
- ❌ P3 架构扩展

---

## 版本目标

| 版本 | 内容 |
|------|------|
| 0.4.2 | Task 1a + 8.1.2 + 8.2.3 |
| 0.4.3 | Task 1b（proxy 接口） |
| 0.4.4 | Task 1c + Task 3a/b |
| 0.4.5 | Task 3c + Task 4 + 生产运行反馈 |
