# Tool 注入方案 — 分析与规划

> 更新于 2026-06-08 · 核心目标：让 IMtoAgent 的各 Agent 后端能统一调用本地注册的工具

---

## 1. 问题定义

IMtoAgent 在 `ToolRegistry` 中注册了工具（如 `get_weather`、`imtoagent_create_task` 等），这些工具的 handler 运行在 **imtoagent 进程内**。但消息最终交由外部 Agent 后端（Codex、Claude Code、OpenClaw 等）处理，这些后端需要**感知并执行**这些工具。

核心矛盾：**handler 在 imtoagent，执行权在 Agent 后端。**

```
IMtoAgent 进程
┌──────────────────────────────┐
│  ToolRegistry                │
│  ┌────────────────────────┐  │
│  │ get_weather (handler)  │  │  ← handler 在这里
│  │ imtoagent_create_task  │  │
│  └────────────────────────┘  │
└──────────┬───────────────────┘
           │ 消息转发
           ↓
┌──────────────────────────────┐
│  Agent 后端 (Codex/Claude)   │  ← 执行权在这里
│  内置工具: exec_command ...  │
│  不认识 get_weather          │
└──────────────────────────────┘
```

---

## 2. 可选方案

### 方案 A：MCP Server（推荐）

**思路**：在 imtoagent 中启动一个 MCP Server，读取 `ToolRegistry` 的所有工具并暴露为 MCP tools。各 Agent 后端通过 MCP Client 协议自动发现和调用。

```
┌─────────────────────────────────────────────────┐
│                   IMtoAgent                      │
│                                                   │
│   ┌─────────────────────────────────────────┐    │
│   │  ToolRegistry                            │    │
│   │  ┌──────────┐ ┌───────────┐ ┌────────┐ │    │
│   │  │get_weather││imtoagent_*││future_* │ │    │
│   │  └─────┬────┘ └─────┬─────┘ └───┬────┘ │    │
│   │        └────────────┼───────────┘       │    │
│   │                     ↓                    │    │
│   │  ┌──────────────────────────────┐        │    │
│   │  │        MCP Server            │        │    │
│   │  │  stdio:// or tcp://          │        │    │
│   │  └──────────────┬───────────────┘        │    │
│   └─────────────────┼────────────────────────┘    │
│                     │                              │
└─────────────────────┼──────────────────────────────┘
                      │ MCP 协议
         ┌────────────┼────────────┬───────────┐
         ↓            ↓            ↓           ↓
     ┌────────┐ ┌────────┐ ┌────────┐ ┌──────────┐
     │ Codex  │ │Claude  │ │OpenClaw│ │ Gemini   │
     │ --mcp  │ │ --mcp  │ │ MCP    │ │ CLI MCP  │
     └────────┘ └────────┘ └────────┘ └──────────┘
```

**机制**：
1. imtoagent 启动 MCP Server（监听 stdio 或 TCP）
2. MCP Server 将 `ToolRegistry` 的每个工具注册为 MCP tool（name + description + inputSchema + handler）
3. 各 Agent 后端启动时，通过 `--mcp-servers` 或配置指向该 MCP Server
4. Agent 自动发现工具列表，LLM 调用时 → MCP 请求发到 imtoagent → handler 执行 → 结果返回 Agent

**优点**：
- 各 Agent 后端的通用交集（Codex、Claude Code、OpenClaw、Gemini CLI 都支持 MCP）
- 工具自动发现，零配置注入
- 结构化输入输出，handler 在 imtoagent 进程执行，不丢类型
- 新增工具只需注册到 `ToolRegistry`，MCP Server 自动暴露
- 与 Agent 后端增加解耦：新后端只要能连 MCP 就能用

**缺点**：
- 需额外维护一个 MCP Server 进程/通道
- 首次接入需引入 MCP SDK 并编写 Server 层
- 旧版本 Agent 后端的 MCP 支持成熟度需验证

**适用性评估**：

| 后端 | MCP 支持 | 验证状态 |
|------|---------|---------|
| Codex | `--mcp-servers` 原生支持 | 待验证 |
| Claude Code | `--mcp-servers` 原生支持 | 已知支持 |
| OpenClaw | 支持 MCP | 待验证 |
| Gemini CLI | 支持 MCP | 待验证 |

---

### 方案 B：Function Calling + 本地 Loop（各后端独立适配）

**思路**：对每个 Agent 后端分别适配其工具扩展机制：
- Codex：在 `codex-proxy.ts` 中注入 tools 定义到请求体，拦截 tool_call 事件本地执行 handler
- OpenAI Adapter：原生 Function Calling（tools 参数 → tool_call → 本地执行 → 返回结果）
- Gemini Adapter：原生 Function Declarations（同上）

```
                    ┌───────────────────────────┐
                    │       ToolRegistry         │
                    │  get_weather / imtoagent_* │
                    └────┬──────┬───────┬───────┘
                         │      │       │
              ┌──────────┘      │       └──────────┐
              ↓                 ↓                  ↓
     ┌────────────────┐ ┌────────────┐ ┌──────────────┐
     │ CodexAdapter   │ │OpenAIAdapt │ │GeminiAdapter │
     │                │ │            │ │              │
     │ inject tools   │ │ tools params│ │ func_decl    │
     │ to HTTP body   │ │ → tool_call│ │ → tool_call  │
     │                │ │ 本地loop   │ │ 本地loop     │
     │ ❌ tool_call   │ │ ✅ 执行    │ │ ✅ 执行      │
     │ 只是通知       │ │            │ │              │
     └────────────────┘ └────────────┘ └──────────────┘
```

**Codex 双路径分析**：

Codex 后端实际有两条完全不同的路径，方案 B 对它们可行性不同：

| 路径 | 机制 | 方案 B 可行性 |
|------|------|-------------|
| **App-Server**（`codex-exec-server.ts`）| 启动 `codex app-server` 子进程，stdio JSON-RPC | ❌ 不可行 |
| **HTTP Proxy**（`codex-proxy.ts`）| 代理 upstream LLM，做 Responses ↔ Chat Completions 转换 | ⚠️ 可行但有代价 |

- **App-Server 路径（不可行）**：`_handleNotification` 中 `tool_call` / `function_call` 事件只是进度通知（`item/started`、`item/completed`），不是「暂停并等 handler 返回」的 RPC 模式。Codex 二进制内嵌的工具执行器不可扩展。
- **HTTP Proxy 路径（可行）**：`codex-proxy.ts` 已有 `pendingToolCalls` 处理逻辑，理论上可以在收到 `function_call` 后不转发给 upstream，而是调用 `ToolRegistry.execute(name, args)` 本地执行，再将结果包装成 `function_call_output` 继续循环。代价是需要在 proxy 层加一个完整的执行循环，改动量大，且只适用于 HTTP Proxy 路径。

**OpenAI/Gemini 原生路径（可行）**：原生 Function Calling 就是「LLM 返回 tool_call → 宿主执行 → 返回 tool result」的标准模式，本地 loop 天然适配。

**优点**：
- OpenAI/Gemini 原生支持，天然适配
- HTTP Proxy 路径可实现但不推荐（维护成本高）

**缺点**：
- Codex App-Server 路径架构性不可行（不是实现细节问题）
- 每个后端单独适配，新后端就要写一套新逻辑
- 后端越多，工具注入代码越碎片化
- HTTP Proxy 路径的执行循环与 Codex 自身的 tool call 机制可能冲突

---

### 方案 C：Bash CLI 封装（当前现状）

**思路**：把所有工具封装成 CLI 子命令，通过 system prompt 告诉 Agent 用 bash 调用。

```
# Agent 视角
$ imtoagent tools call get_weather '{"city":"北京"}'
> {"city":"北京","temperature":28,"weather":"晴"}

$ imtoagent task add name=X ...
```

**优点**：
- 零架构改动
- 所有 Agent 后端都会 bash

**缺点**：
- 每个工具都要写 CLI 封装 + 参数序列化/反序列化
- 结构化结果通过 stdout 文本传回，丢失类型
- 每轮消耗额外 token（system prompt 中用法说明）
- 工具多了 system prompt 严重膨胀
- 不适用纯逻辑工具（没有天然 CLI 语义的如 `get_weather` 也得硬封装）
- `imtoagent task` 已有 CLI，但 `get_weather` 没有 → 需要额外开发

---

## 3. 方案对比

| 维度 | A: MCP Server | B: FC + Loop | C: Bash CLI |
|------|:------------:|:------------:|:-----------:|
| Codex App-Server | ✅ 通过 --mcp | ❌ 不可行 | ⚠️ 需额外封装 |
| Codex HTTP Proxy | ✅ 通过 --mcp | ⚠️ 可行但代价大 | ⚠️ 需额外封装 |
| Claude Code | ✅ | ❌ | ⚠️ |
| OpenClaw | ✅ | ❌ | ⚠️ |
| Gemini CLI | ✅ | ❌ | ⚠️ |
| 多后端扩展性 | ✅ 加后端不加注入层 | ❌ 每个后端单独写 | ⚠️ 所有工具都要有 CLI |
| 结构化数据保留 | ✅ JSON Schema | ✅ | ❌ 文本丢失类型 |
| token 消耗 | ✅ 零额外 | ✅ 零额外 | ❌ system prompt 膨胀 |
| 实现复杂度 | ⚠️ 中等（需 MCP SDK） | ⚠️ 中等（各路径不同） | ✅ 低（CLI 易写） |
| 现有代码改动 | ⚠️ 新增模块 | ⚠️ 改动各 Adapter/Proxy | ✅ 基本不改 |

---

## 4. 推荐方案：MCP Server

### 理由

1. **MCP 是各 Agent 后端的通用交集** — Codex、Claude Code、OpenClaw、Gemini CLI 都支持 MCP，不依赖任何后端的私有扩展机制
2. **与多后端扩展目标一致** — 未来每增加一个 Agent 后端，只要它支持 MCP Client，就自动获得所有工具能力，无需改注入层代码
3. **handler 留在 imtoagent 进程** — 不丢结构化数据，不需要序列化/反序列化
4. **与 ToolRegistry 解耦** — 新增工具只需注册到 `ToolRegistry`，MCP Server 自动暴露

### 与当前架构的集成

```
AgentRuntime
├── ToolRegistry          ← 已有，注册所有工具（全局单例）
├── MCP Server            ← 新增，读取 ToolRegistry → 注册为 MCP tools
│   └── 生命周期：imtoagent 启动时启动，关闭时退出
├── CodexAdapter          ← 现有，启动 Codex 时自动配置 --mcp-servers
│   ├── App-Server 路径    ← 启动 codex app-server 时注入 --mcp-servers
│   └── HTTP Proxy 路径    ← 不需要 MCP（走 HTTP，不改此路径）
├── ClaudeAdapter         ← 未来，启动 Claude 时自动配置 --mcp-servers
├── OpenClawAdapter       ← 未来，自动配置 MCP 连接
└── ...
```

### 现有 MCP 基础设施说明

项目中已有 `modules/utils/mcp-manager.ts` 和 `modules/cli/mcp.ts`，它们的功能是 **MCP 客户端配置管理**：
- `McpManager`：管理外部 MCP server 的配置（增删查启停，存储到 `~/.imtoagent/mcp.json` 或 bot-level）
- `mcp` CLI：用户通过命令行操作 MCP 配置
- 这些配置通过 system prompt 注入，**不是** MCP Server 本身

**本规划要新建的**是 imtoagent 自己当 MCP Server，将 `ToolRegistry` 中的工具暴露为 MCP tools。两者关系：
- `McpManager`：imtoagent 作为 MCP Client，连接**外部** MCP server
- 新建 `McpServer`：imtoagent 作为 MCP Server，让**外部 Agent** 连过来调工具

---

### 实施步骤

#### 4.1 依赖引入

```json
// package.json 或 bun 依赖
"@modelcontextprotocol/sdk": "^1.x"
```

> 注意：需验证 `@modelcontextprotocol/sdk` 在 Bun 环境下的兼容性（特别是 stdio 传输层）。如不兼容，考虑使用 `@anthropic-ai/sdk` 内置的 MCP 支持或纯 stdio 手动实现 JSON-RPC。

#### 4.2 模块结构

```
modules/mcp/
├── server.ts           ← MCP Server 主类（McpServer）
├── transport.ts        ← stdio / TCP 传输层抽象
└── adapter.ts          ← ToolRegistry → MCP tools 转换器
```

#### 4.3 MCP Server 核心实现

```typescript
// modules/mcp/server.ts 骨架
import { ToolRegistry } from '../agent/tool-registry';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { TcpServerTransport } from '@modelcontextprotocol/sdk/server/streamable-http.js';

export class IMtoAgentMcpServer {
  private server: McpServer;
  private toolRegistry: ToolRegistry;
  private transport: 'stdio' | 'tcp';
  private port: number;

  constructor(toolRegistry: ToolRegistry, options?: { transport?: 'stdio' | 'tcp'; port?: number }) {
    this.toolRegistry = toolRegistry;
    this.transport = options?.transport || 'tcp'; // 默认 TCP，适用性更广
    this.port = options?.port || 18900;
  }

  async start(): Promise<void> {
    this.server = new McpServer({
      name: 'imtoagent',
      version: '1.0.0',
    });

    // 将 ToolRegistry 中所有工具注册为 MCP tools
    for (const tool of this.toolRegistry.list()) {
      this.server.tool(
        tool.name,
        tool.description,
        tool.inputSchema,  // JSON Schema
        async (args) => {
          try {
            const result = await tool.handler(args);
            return { content: [{ type: 'text', text: JSON.stringify(result) }] };
          } catch (err) {
            return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
          }
        },
      );
    }

    // 启动传输层
    if (this.transport === 'stdio') {
      await this.server.connect(new StdioServerTransport());
    } else {
      await this.server.connect(new TcpServerTransport({ port: this.port }));
    }

    console.log(`[MCP Server] started (${this.transport}://...)`);
  }

  async stop(): Promise<void> {
    await this.server.close();
  }
}
```

#### 4.4 生命周期管理

在 `BotManager` 或 `AgentRuntime` 初始化时启动 MCP Server：

```typescript
// 在 bot 启动流程中
const mcpServer = new IMtoAgentMcpServer(toolRegistry, {
  transport: 'tcp',
  port: 18900,
});
await mcpServer.start();
```

在 bot 关闭时同步停止：

```typescript
// 在 bot 关闭流程中
await mcpServer.stop();
```

#### 4.5 各 Adapter 接入点

**Codex App-Server 路径（`codex-exec-server.ts`）**：

启动 `codex app-server` 子进程时，注入 `--mcp-servers` 参数：

```typescript
// codex-exec-server.ts _spawn() 修改
const mcpConfig = JSON.stringify({
  mcpServers: {
    imtoagent: {
      command: 'node',  // 或 bun
      args: ['path/to/mcp-stdio-bridge.js'],  // 或用 tcp 直连
    },
  },
});

this.process = Bun.spawn(
  ['codex', 'app-server',
    '--listen', 'stdio://',
    '-c', `mcp_servers=${mcpConfig}`,
    '-c', 'model_provider=imtoagent',
    '-c', 'sandbox.mode=danger-full-access',
    '--enable', 'memories',
  ],
  { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' },
);
```

> 具体参数格式需验证 Codex app-server 的 MCP 接入方式（`-c mcp_servers=...` 或 `--mcp-servers` 或配置文件）。

**Codex HTTP Proxy 路径（`codex-proxy.ts`）**：

不需要改动。此路径走 HTTP 代理，不走 MCP，tool 注入由 upstream LLM 原生 Function Calling 处理（如果 upstream 支持）。

**通用 Agent 接入**：

每个 Adapter 在构造启动命令时，统一注入 MCP 连接配置：

```typescript
// 伪代码：各 Adapter 的启动逻辑中
const mcpFlag = `--mcp-servers '${JSON.stringify({
  imtoagent: { transport: 'tcp', url: 'tcp://localhost:18900' }
})}'`;
```

#### 4.6 ToolRegistry 改造建议

当前 `ToolRegistry` 是全局单例，`register()` 同时写入了 `registry`（定义）和 `injected`（已注入）两个 Set，"session 级别注入"的语义有误导性。

**建议改造方向**（不阻塞 MCP Server 首期）：

```typescript
// 当前（v1）
class ToolRegistry {
  private registry: Map<string, Tool> = new Map();    // 所有已注册工具
  private injected: Set<string> = new Set();           // 全局已注入
}

// 目标（v2）— per-session injected set
class ToolRegistry {
  private registry: Map<string, Tool> = new Map();    // 所有已注册工具（不变）
  private sessionInjected: Map<string, Set<string>> = new Map();  // sessionId → 已注入工具

  getOpenAIFormat(sessionId: string): object[] {
    const injected = this.sessionInjected.get(sessionId) || new Set();
    // 只返回该 session 已注入的工具
  }

  injectNeeded(sessionId: string, needed: string[]): string[] {
    let set = this.sessionInjected.get(sessionId);
    if (!set) { set = new Set(); this.sessionInjected.set(sessionId, set); }
    // ...
  }
}
```

**过渡方案**：首期 MCP Server 直接读取 `ToolRegistry` 的 `registry`（全部工具），不做 per-session 过滤。MCP Server 端由 Agent 后端的 session 隔离自然保证安全性。

#### 4.7 传输方式选择

| 传输方式 | 适用场景 | 优点 | 缺点 |
|---------|---------|------|------|
| **stdio** | Agent 是 imtoagent 的子进程 | 零端口管理，进程生命周期即 MCP 生命周期 | 仅适用于父子进程 |
| **TCP** | Agent 是独立进程（OpenClaw、Codex App-Server） | 适用性广，任何进程都可连 | 需管理端口、防火墙 |

**决策**：**默认 TCP**，端口 18900。原因：
- Codex App-Server 是子进程但通过 `--mcp-servers` 配置连接，通常用 TCP URL
- OpenClaw 是独立进程，必须 TCP
- 保留 stdio 选项供未来特殊场景使用

#### 4.8 回退策略

MCP Server 启动失败时的降级路径：

1. **MCP Server 启动失败** → 降级到 Bash CLI 模式（方案 C），将可用工具通过 system prompt 注入
2. **Agent 不支持 MCP** → 同降级到 Bash CLI
3. **MCP Server 运行中崩溃** → 自动重启 + 发送事件通知（Agent 可能需重新建立 MCP 连接）

---

## 5. 架构细节补充

### 5.1 Codex 双路径全景

```
Codex 后端
├── App-Server 路径（默认）
│   codex-exec-server.ts
│   ├── 启动 codex app-server 子进程
│   ├── stdio JSON-RPC 双向通信
│   ├── tool_call 事件仅通知，不可拦截
│   └── → 需通过 --mcp-servers 参数接入 MCP
│
└── HTTP Proxy 路径（fallback）
    codex-proxy.ts
    ├── 代理 upstream LLM（如 deepseek）
    ├── Responses API ↔ Chat Completions 双向翻译
    ├── 可注入 tools 定义到请求体
    ├── 收到 tool_call 后可本地执行（需加循环）
    └── → 不走 MCP，走本地 Function Calling loop
```

### 5.2 ToolRegistry 当前行为与文档对照

| 文档描述 | 实际代码行为 | 偏差 |
|---------|-------------|------|
| `register()` 只注册定义 | `register()` 同时写入 `registry` + `injected` | ⚠️ |
| `injectNeeded()` 按 session 注入 | 注入到全局 `injected` Set，无 session 隔离 | ⚠️ |
| `removeInjected()` 清理 session | 清理全局 `injected` Set，影响所有 session | ⚠️ |
| `getOpenAIFormat()` 返回已注入 | 正确，但"已注入"是全局概念 | ✅ |

### 5.3 Goal Engine 中的工具注入流程

```
HeartbeatScheduler
  └── GoalEngine.executeGoalWithResult()
       ├── Phase 1: 锁获取（lock acquire）
       ├── Phase 2: resolveNeededTools(goal) → 计算需要哪些工具
       ├── Phase 2: toolRegistry.injectNeeded(needed) → 全局注入
       ├── Phase 2: toolRegistry.getOpenAIFormat() → 获取注入的工具列表
       ├── Phase 2: executeAgent(prompt, { tools }) → 调 Agent
       ├── Phase 3: 解析结果
       └── finally: toolRegistry.removeInjected(injectedTools) → 清理全局注入
```

当前 Goal Engine 的执行流程在 `finally` 块中清理注入，保证了单次 Goal 执行后的状态回滚。但在并发 Goal 场景下（多个 Goal 同时执行），全局 `injected` Set 的 race condition 需要注意。

---

## 6. 结论

| 当前状态 | 目标状态 |
|---------|---------|
| tools 注入到 HTTP 请求体，LLM 调用但 Codex 无法执行 | ✅ MCP Server 统一暴露，各后端自动发现并调用 |
| handler 定义在 imtoagent 但执行权在各后端 | ✅ handler 在 imtoagent 进程执行，结果通过 MCP 返回 |
| 每个新后端需单独适配工具机制 | ✅ 新后端只要支持 MCP Client，自动获得所有工具 |
| ToolRegistry 全局单例，无 session 隔离 | ⏳ 首期不改（MCP 端由 Agent 隔离），v2 改造 per-session injected |

### 优先级排序

1. **P0**：实现 MCP Server 基础框架（`modules/mcp/server.ts`）
2. **P0**：Codex App-Server 路径接入 `--mcp-servers`
3. **P1**：传输层（TCP 默认 + stdio 可选）
4. **P1**：回退策略（MCP 失败降级到 Bash CLI）
5. **P2**：ToolRegistry per-session 改造
6. **P2**：其他 Agent 后端（Claude、OpenClaw、Gemini）MCP 接入
