# IMtoAgent 资源注入框架修复方案

> 2026-06-02 | 完整框架级重构方案
>
> **核心原则：**
> 1. IMtoAgent 有自己的目录体系，不依赖 `.codex` 等后端特有目录
> 2. 系统级资源 (system) 和 Bot 级资源 (bot) 严格隔离
> 3. Skill/MCP/Prompt 统一通过 system prompt 注入，不依赖后端文件系统

---

## 一、现状问题清单

| # | 问题 | 严重程度 |
|---|------|----------|
| 1 | Skills/MCP 存储是全局的，无 Bot 级隔离 — Bot A 的私有 API skill 会被 Bot B 看到 | 🔴 隐私泄露 |
| 2 | Skills/MCP 管理器实例化时传入的是 `workspacePath`（Bot 沙盒目录），但底层存储用的是全局 `~/.imtoagent/skills/` 和 `~/.imtoagent/mcp.json` — 参数语义错误 | 🟡 架构不一致 |
| 3 | SkillsManager.sync() 把 skill 复制到 `~/.codex/skills/` 和 `~/.claude/skills/` — 把 IMtoAgent 的 skill 混入后端全局 skill 池，污染且不安全 | 🔴 后端污染 |
| 4 | Proxy 路径 (`codex-proxy.ts`) 的 system prompt 未注入 mcpInfo/skillsInfo/promptsInfo | 🟡 功能缺失 |
| 5 | 心跳/定时任务协议完全未注入 system prompt — Agent 不知道心跳机制 | 🟡 功能缺失 |
| 6 | Codex app-server 未加载 `--skills`（即使给了也没有意义，因为 skill 应该走 system prompt 注入） | 🟡 功能缺失 |

---

## 二、目标架构

### 2.1 目录体系（IMtoAgent 自有，不碰后端目录）

```
~/.imtoagent/
├── config.json
├── providers.json
├── mcp.json                          ← 系统级 MCP（所有 Bot 共享）
├── prompts.json                      ← 系统级 Prompts
│
├── skills/                           ← 系统级 Skills（所有 Bot 共享）
│   └── heartbeat/                    ← 心跳定时任务 skill
│       ├── SKILL.md
│       └── agents/
│           └── openai.yaml
│
├── bots/
│   └── <bot-id>/                     ← Bot 级隔离（UUID）
│       ├── config.json               ← 已有
│       ├── HEARTBEAT.md              ← 已有
│       ├── mcp.json                  ← 新增：Bot 级 MCP
│       ├── prompts.json              ← 新增：Bot 级 Prompts
│       └── skills/                   ← 新增：Bot 级 Skills
│           └── internal-api/         ← 仅该 Bot 可见
│               ├── SKILL.md
│               └── agents/
│                   └── openai.yaml
│
├── workspaces/                       ← 已有：Bot 工作沙盒
│   └── <uuid>/
│
├── sessions/                         ← 已有
├── logs/                             ← 已有
└── bot-ids.json                      ← 已有
```

### 2.2 系统级 vs Bot 级隔离规则

| 维度 | 系统级 (system) | Bot 级 (bot) |
|------|----------------|-------------|
| **存储位置** | `~/.imtoagent/skills/`, `~/.imtoagent/mcp.json` | `~/.imtoagent/bots/<id>/skills/`, `~/.imtoagent/bots/<id>/mcp.json` |
| **可见范围** | 所有 Bot | 仅该 Bot |
| **管理方式** | `imtoagent skills|mcp [cmd]`（无 --bot） | `imtoagent skills|mcp [cmd] --bot <id>` |
| **注入方式** | system prompt 文本注入 | system prompt 文本注入 |
| **典型内容** | heartbeat、通用工具 skill、公共 MCP | 团队内部 API、数据库 schema、私有 MCP |
| **从不做的事** | ❌ 复制到 `~/.codex/skills/` | ❌ 复制到 `~/.codex/skills/` |

### 2.3 注入架构（纯 system prompt 文本注入）

```
                    ┌────────────────────────────────────┐
                    │     buildSystemPromptWithSoul()     │
                    │                                     │
  系统级 skills ────┤  skillsInfo: { skills: [...] }     │
  系统级 MCP    ────┤  mcpInfo: { servers: [...] }       │
  系统级 prompts ──┤  promptsInfo: { prompts: [...] }   │
                    │                                     │
  Bot 级 skills  ───┤  + (合并到以上字段)                │──→ Agent
  Bot 级 MCP     ───┤  + (合并到以上字段)                │
  Bot 级 prompts ──┤  + (合并到以上字段)                 │
                    │                                     │
  心跳协议      ────┤  直接写入 system prompt 文本        │
                    └────────────────────────────────────┘
```

**不再通过文件系统 sync 到 Codex/Claude 的目录。** 所有 skill 内容通过 system prompt 注入为文本（渐进披露：先列名字和 description，Agent 需要时读取 SKILL.md 内容）。

---

## 三、修复清单

### 修复 1：重构 SkillsManager — 支持系统级/Bot 级隔离

**文件：** `modules/utils/skills-manager.ts`

**变更：**

1. 存储路径改为两级：
   - 系统级：`~/.imtoagent/skills/`（默认）
   - Bot 级：`~/.imtoagent/bots/<botId>/skills/`（传 `botId` 参数时）

2. 删除 `sync()` 方法（不再复制到后端目录）

3. 新增 `getSkillContent(name, botId?)` 方法，返回 SKILL.md 完整内容（用于 Agent 按需查阅）

4. 新增 `getSkillDescription(name, botId?)` 方法，解析 YAML frontmatter 返回 description

5. `list(botId?)` 方法返回 `{ name: string; description: string; level: 'system' | 'bot' }[]`

6. `install()` / `remove()` 支持 `botId` 参数

```typescript
// 新接口示意
export interface SkillEntry {
  name: string;
  description: string;    // 从 SKILL.md YAML frontmatter 解析
  level: 'system' | 'bot';
  path: string;           // 实际存储路径
}

export class SkillsManager {
  constructor(private botId?: string) {
    // botId 决定存储位置：
    //   有 botId → ~/.imtoagent/bots/<botId>/skills/
    //   无 botId → ~/.imtoagent/skills/
  }

  list(): SkillEntry[];
  install(source: string, options?: { name?: string }): SkillEntry;
  remove(name: string): boolean;
  getSkillContent(name: string): string | null;  // 返回 SKILL.md 全文
}
```

---

### 修复 2：重构 McpManager — 支持系统级/Bot 级隔离

**文件：** `modules/utils/mcp-manager.ts`

**变更：**

1. 存储路径改为两级：
   - 系统级：`~/.imtoagent/mcp.json`
   - Bot 级：`~/.imtoagent/bots/<botId>/mcp.json`

2. 删除 `sync()` 方法及所有 `syncToCodex/syncToClaude/syncToOpenCode` 方法

3. Constructor 接受 `botId?: string`

4. `list()` 返回带 `level` 标记的结果

---

### 修复 3：重构 PromptsManager — 同理

**文件：** `modules/utils/prompts-manager.ts`

**变更：** 与 SkillsManager/McpManager 一致的两级隔离改造，删除 sync 逻辑。

---

### 修复 4：更新 index.ts — Bot 初始化使用 Bot 级 Manager

**文件：** `index.ts`

**变更：**

```typescript
// 旧代码（约第 244-246 行）：
this.mcpManager = new McpManager(workspacePath);
this.skillsManager = new SkillsManager(workspacePath);
this.promptsManager = new PromptsManager(workspacePath);

// 新代码：
this.systemMcp = new McpManager();                          // 系统级
this.systemSkills = new SkillsManager();                    // 系统级
this.systemPrompts = new PromptsManager();                  // 系统级
this.botMcp = new McpManager(this.id);                     // Bot 级
this.botSkills = new SkillsManager(this.id);               // Bot 级
this.botPrompts = new PromptsManager(this.id);             // Bot 级
```

---

### 修复 5：更新 buildSystemPromptWithSoul — 合并系统级+Bot 级资源

**文件：** `index.ts` 中 `buildSystemPromptWithSoul` 函数（约第 774 行）

**变更：**

```typescript
function buildSystemPromptWithSoul(
  soul: string,
  botName: string,
  imModule: IMModule | null,
  systemMcp: McpManager,
  systemSkills: SkillsManager,
  systemPrompts: PromptsManager,
  botMcp: McpManager,
  botSkills: SkillsManager,
  botPrompts: PromptsManager,
): string {
  // 合并系统级 + Bot 级 skills
  const allSkills = [
    ...systemSkills.list().map(s => ({ name: s.name, description: s.description })),
    ...botSkills.list().map(s => ({ name: s.name, description: s.description })),
  ];

  // 合并系统级 + Bot 级 MCP
  const allMcp = {
    servers: [
      ...Object.entries(systemMcp.list()).map(([k, v]) => ({ name: k, ...v })),
      ...Object.entries(botMcp.list()).map(([k, v]) => ({ name: k, ...v })),
    ]
  };

  // 合并系统级 + Bot 级 prompts
  const allPrompts = [
    ...systemPrompts.list(),
    ...botPrompts.list(),
  ];

  const base = buildSystemPrompt({
    imModule,
    botName,
    mcpInfo: allMcp,
    skillsInfo: { skills: allSkills },
    promptsInfo: { prompts: allPrompts },
  });
  // ...
}
```

---

### 修复 6：Prompt Builder 注入心跳协议 + 改进 Skill 注入（含 description）

**文件：** `modules/prompt-builder.ts`

**变更 6a：** 在 Gateway logs 之后、Available Resources 之前，新增心跳协议章节：

```typescript
// 3.5. Heartbeat & Scheduled Tasks Protocol
sections.push(`# Heartbeat & Scheduled Tasks

The gateway periodically sends you heartbeat prompts to check system health.

## Heartbeat Protocol
- When you receive a heartbeat prompt and everything is normal, reply with a single line: \`HEARTBEAT_OK\`
- This reply is silently intercepted by the gateway — the user will NOT see it.
- Only respond with content if you detect issues or have useful information.

## Scheduled Tasks
- Scheduled tasks are defined in the bot's \`HEARTBEAT.md\` file.
- Tasks run independently and can perform periodic checks.
- Use the \`heartbeat\` skill for full configuration documentation.`);
```

**变更 6b：** Skills 注入改为带 description（便于 Agent 判断何时加载）：

```typescript
// 旧：
if (ctx.skillsInfo?.skills.length) {
  const rows = ctx.skillsInfo.skills.map(s => `| ${s.name} |`).join('\n');
  resourceSections.push(`## Installed Skills\n\n| Skill |\n|-------|\n${rows}`);
}

// 新：
if (ctx.skillsInfo?.skills.length) {
  const rows = ctx.skillsInfo.skills
    .map(s => `| ${s.name} | ${s.description.slice(0, 80)} |`)
    .join('\n');
  resourceSections.push(`## Installed Skills\n\n| Skill | Description |\n|-------|-------------|\n${rows}`);
}
```

---

### 修复 7：Proxy 路径补齐资源注入

**文件：** `modules/proxy/codex-proxy.ts` + `modules/bot-context.ts`

**变更 7a：** 扩展 `BotContextData`：

```typescript
// modules/bot-context.ts
export interface BotContextData {
  botName: string;
  caps: IMCapabilities | null;
  modelAliases?: ModelAliases;
  // 新增
  systemMcp?: McpManager;
  systemSkills?: SkillsManager;
  systemPrompts?: PromptsManager;
  botMcp?: McpManager;
  botSkills?: SkillsManager;
  botPrompts?: PromptsManager;
}
```

**变更 7b：** Proxy 层使用完整参数（`codex-proxy.ts` 约第 676 行）：

```typescript
const ctx = getCurrentBot();
const botName = ctx?.botName || 'CodexBot';

const systemPrompt = buildSystemPrompt({
  caps: ctx?.caps || null,
  botName,
  // 合并系统级 + Bot 级
  mcpInfo: {
    servers: [
      ...(ctx?.systemMcp ? Object.entries(ctx.systemMcp.list()).map(...) : []),
      ...(ctx?.botMcp ? Object.entries(ctx.botMcp.list()).map(...) : []),
    ]
  },
  skillsInfo: ctx?.systemSkills || ctx?.botSkills ? {
    skills: [
      ...(ctx?.systemSkills?.list().map(s => ({ name: s.name, description: s.description })) || []),
      ...(ctx?.botSkills?.list().map(s => ({ name: s.name, description: s.description })) || []),
    ]
  } : undefined,
  promptsInfo: /* 同理 */,
});
```

**变更 7c：** `setCurrentBot` 调用处传入所有 Manager 引用（`index.ts` 约第 690 行）：

```typescript
setCurrentBot({
  botName: this.name,
  caps: this.im.getCapabilities(),
  modelAliases: this.activeModelAliases,
  systemMcp: this.systemMcp,
  systemSkills: this.systemSkills,
  systemPrompts: this.systemPrompts,
  botMcp: this.botMcp,
  botSkills: this.botSkills,
  botPrompts: this.botPrompts,
});
```

---

### 修复 8：移除 Codex app-server 不需要的 `--skills` 参数

**文件：** `modules/agent/codex-exec-server.ts`

**变更：** 不需要加 `--skills`。因为所有 skill 内容已通过 system prompt 文本注入，不依赖 Codex 的文件系统加载。

---

### 修复 9：创建系统级 heartbeat skill

**操作：** 创建 `~/.imtoagent/skills/heartbeat/` 目录，写入符合 Codex skill 格式的 SKILL.md 和 agents 元数据。

**`~/.imtoagent/skills/heartbeat/SKILL.md`：**

```markdown
---
name: heartbeat
description: Configure periodic heartbeat checks and cron-like scheduled tasks for IMtoAgent bots. Use when the user asks about heartbeat configuration, scheduled tasks, HEARTBEAT.md format, task intervals, or adding periodic checks.
---

# Heartbeat & Scheduled Tasks

Configure periodic heartbeat checks and cron-like scheduled tasks.

## HEARTBEAT.md Format

The file lives in the bot's workspace. It has two sections:

### Heartbeat Prompt (free-form markdown above the tasks block)

This is sent to the agent on each heartbeat cycle.

### Scheduled Tasks (tasks block)

```yaml
tasks:
  - name: check-disk
    interval: 1h
    prompt: "Check disk usage. Alert if over 80%."

  - name: check-logs
    interval: 30m
    prompt: "Check ~/.imtoagent/logs/imtoagent.log for errors in the last 30 minutes."
```

### Task Fields

| Field | Required | Description |
|-------|----------|-------------|
| `name` | Yes | Unique task identifier |
| `interval` | Yes | Format: `<number><unit>` where unit = `s`, `m`, `h`, `d` |
| `prompt` | Yes | Prompt sent to the agent when the task triggers |

### Behavior

- Tasks run independently of user conversations
- Task replies are filtered (HEARTBEAT_OK is not sent to user)
- Adding/removing tasks takes effect on next heartbeat cycle
- Phase offset is automatic — tasks spread out to avoid thundering herd
- Heartbeat rounds are capped at 5 to prevent memory leaks
```

**`~/.imtoagent/skills/heartbeat/agents/openai.yaml`：**

```yaml
display_name: Heartbeat & Tasks
short_description: Configure periodic heartbeat checks and cron-like scheduled tasks for bots.
default_prompt: Explain how to configure scheduled tasks in HEARTBEAT.md.
```

---

### 修复 10：更新 CLI 命令支持 `--bot` 参数

**文件：** `modules/cli/skills.ts`, `modules/cli/mcp.ts`

**变更：** `list`/`install`/`remove` 命令支持 `--bot <bot-id>` 参数，指定操作 Bot 级资源。

```bash
# 系统级
imtoagent skills install <source>
imtoagent skills list

# Bot 级
imtoagent skills install <source> --bot feishu-prod
imtoagent skills list --bot feishu-prod
imtoagent skills remove my-skill --bot feishu-prod
```

同时删除 `sync` 子命令。

---

## 四、修复顺序

| 顺序 | 修复 | 依赖 | 是否需要重启 |
|------|------|------|-------------|
| 1 | 修复 1：SkillsManager 重构 | 无 | 否（新代码，旧逻辑不动） |
| 2 | 修复 2：McpManager 重构 | 无 | 否 |
| 3 | 修复 3：PromptsManager 重构 | 无 | 否 |
| 4 | 修复 9：创建 heartbeat skill | 无 | 否 |
| 5 | 修复 4：index.ts Bot 初始化 | 修复 1-3 | 是 |
| 6 | 修复 5：buildSystemPromptWithSoul | 修复 1-4 | 是 |
| 7 | 修复 6：prompt-builder 心跳协议 + description | 无（独立） | 是 |
| 8 | 修复 7：Proxy 路径补齐 | 修复 1-5 | 是 |
| 9 | 修复 8：移除 `--skills` | 无 | 是 |
| 10 | 修复 10：CLI 更新 | 修复 1-3 | 否 |

建议 1-4 可以一起做，5-9 可以一起做（都需要重启），10 最后。

---

## 五、验证检查清单

修复完成后验证：

- [ ] `imtoagent skills list` 列出系统级 skills（含 heartbeat）
- [ ] `imtoagent skills list --bot <id>` 列出 Bot 级 skills
- [ ] system prompt 中包含 "Heartbeat & Scheduled Tasks" 章节
- [ ] system prompt 中 skills 表格包含 description
- [ ] system prompt 中 MCP 表格来自系统级+Bot 级合并
- [ ] `~/.codex/skills/` 不会被 IMtoAgent 写入任何内容
- [ ] `~/.claude/skills/` 不会被 IMtoAgent 写入任何内容
- [ ] Agent 收到心跳时能正确回复 HEARTBEAT_OK
