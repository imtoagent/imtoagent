# System Prompt 注入补全 — 实现方案

## 你在问什么

用户问题：「我想要用户使用任何后端任何代理路径任何 IM 时都应该实现注入」

## 现状：哪些路径缺了注入

| 路径 | 状态 |
|------|------|
| SDK 路径（Claude/Codex CLI/OpenCode/Gemini）| ✅ `index.ts → buildSystemPromptWithSoul()` 统一注入 |
| Codex Proxy 路径（/v1/responses）| ✅ `codex-proxy.ts handleCodexRequest()` 注入 |
| **Anthropic Proxy 路径**（/v1/messages，Claude SDK 走这条）| ❌ **没注入，直接转发** |

Anthropic Proxy 路径的 system prompt 来源只有 Claude SDK 自己生成的（包含 SDK 自带的 skills/tools 描述），没有 imtoagent 层的任何内容（IM 能力、心跳协议、MCP/Skills/Prompts 列表、Soul）。

## 修复：只需要改一个地方

**文件**：`modules/proxy/anthropic-proxy.ts`

**原因**：三条路径汇合到两个处理函数里：

```
Claude SDK → POST localhost:18899/v1/messages ─┐
                                                ├→ anthropic-proxy.ts handleRequest()
Codex app-server → POST localhost:18899/v1/responses ─→ codex-proxy.ts handleCodexRequest()
                                                               ↑ 已注入
```

Codex proxy 路径已经注入了，缺的只是 `handleRequest()` 里处理 `/v1/messages` 的那条。

### 具体修改

改 1：文件头部加两行 import
```typescript
import { getCurrentBot } from '../bot-context';           // 约第 20 行
import { buildSystemPrompt } from '../prompt-builder';    // 约第 21 行
```

改 2：在 `handleRequest` 函数内，`req.on('end')` 回调里，解析完 `parsedBody` 之后、构建 upstream request 之前，插入 ~18 行注入逻辑：
```typescript
    // 🧠 动态注入 imtoagent system prompt（skills/mcp/prompts/IM能力/心跳/Soul）
    const ctx = getCurrentBot();
    if (ctx) {
      const injected = buildSystemPrompt({
        caps: ctx.caps || null,
        botName: ctx.botName,
        mcpInfo: ctx.mcpInfo,
        skillsInfo: ctx.skillsInfo,
        promptsInfo: ctx.promptsInfo,
      });
      const existing = parsedBody.system;
      if (typeof existing === 'string') {
        parsedBody.system = existing + '\n\n---\n\n' + injected;
      } else if (Array.isArray(existing)) {
        parsedBody.system = [...existing, { type: 'text', text: '\n\n---\n\n' + injected } as any];
      } else {
        parsedBody.system = injected;
      }
      bodyStr = JSON.stringify(parsedBody);
    }
```

合计：1 个文件，+20 行。

---

## 本次修复的范围 vs 不在范围内

### ✅ 本次修复覆盖的（system prompt 层面）

做完后，**所有路径**的 Agent 都能在 system prompt 里看到：

- IM 能力说明（文件/图片/按钮/卡片等）
- Gateway 日志查询指引
- 心跳协议（JSON 回复格式）
- MCP Servers 列表（名字 + 命令）
- Skills 列表（名字 + 描述）
- Prompts 列表
- Soul（用户自定义身份、规则、偏好）

### ❌ 不在本次修复范围内的（需要架构层面的改动）

这些是我之前分析中提到，但和用户此次请求「实现 system prompt 注入」不直接相关的更深层问题：

| 问题 | 说明 |
|------|------|
| **MCP 只是"名字列表"，没有真正启动 MCP server** | `buildSystemPrompt()` 把 MCP 名字和命令写进 system prompt，Agent 能看到但无法调用。要真正运行 MCP，需要 imtoagent 启动 MCP server 进程，把 MCP 工具注入到 Agent 的 tool list 里 |
| **Skills 只是"名字列表"，没有加载 SKILL.md 内容** | system prompt 里只有 `\| skill 名字 \| 描述 \|` 的表格，Agent 不知道 skill 的实际指令内容。真正启用 skill 需要把 `SKILL.md` 内容加载进 system prompt 或 tool definition |
| **Tool Registry 设计好了但没接入 Adapter 层** | `modules/agent/tool-registry.ts` 只在 heartbeat 和 goal-engine 里使用，普通聊天流程没走。如果要做"imtoagent 统一注入工具到所有后端"，这才是正确的架构入口 |
| **Adapter 层完全没有消费 ToolRegistry** | `claude-adapter.ts`、`codex-exec-server.ts`、`opencode-adapter.ts` 里搜不到任何 `toolRegistry` 引用 |
| **跨后端统一的 tool/skill 执行层** | 各后端的 tool call 完全是原生的（Codex function call、Claude tool_use 等），imtoagent 没有中间层来拦截和路由 |

---

## 总结

用户这次要的「所有路径都注入」——**就是差 anthropic-proxy.ts 这一个文件，修完就全了**。

至于 MCP 真正可调用、Skills 真正可执行、Tool Registry 接入 Adapter 层——这些是后续的架构演进方向，需要单独评估和设计。
