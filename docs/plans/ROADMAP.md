# IMtoAgent Development Roadmap

> Last updated: 2026-05-30 | Phase 1-13 complete ✅ | Current version: 0.3.26 | Next: v0.4.0 (TBD)

---

## 1. Project Vision

Connect Feishu, Telegram, WeChat, WeCom to AI coding agents (Claude Code, Codex, OpenCode) via a unified gateway on port `:18899`.

One gateway → multiple IMs → multiple agents → unified proxy.

See [ARCHITECTURE.md](../../.codex-docs/ARCHITECTURE.md) for full architecture.

---

## 2. Current Status (v0.3.26)

### ✅ What's Done

| Area | Details |
|------|---------|
| **IM Adapters** | Feishu (731L), Telegram (639L), WeChat (1094L), WeCom (603L) |
| **Agent Backends** | Claude Code (SDK), Codex (app-server v2 + exec fallback), OpenCode (HTTP API) |
| **Unified Proxy** | Port `:18899` only — Anthropic Proxy handles all routing |
| **CLI Commands** | 26 commands + subcommands (see `imtoagent --help`) |
| **Tests** | 188 tests across 10 files, 0 failures |
| **Code Size** | ~16,000+ lines across 50+ .ts files |
| **Bot Config** | Configured via `~/.imtoagent/config.json` |
| **Soul Injection** | Per-Bot identity/profile/rules/skills/workspace files + CLI reference |
| **i18n** | Full English translation across all modules |
| **IM Registry** | Factory pattern — add IM with one line, no Bot constructor changes |

### ✅ Completed Phases

| Phase | Content | Version |
|-------|---------|---------|
| Phase 1: Core ✅ | Feishu ↔ Claude/Codex, unified proxy, session continuity, stats | 0.1.x–0.2.x |
| Phase 2: Modular ✅ | Extracted modules (agent/proxy/im), IM Registry, capability system | 0.2.x–0.3.0 |
| Phase 3: Multi-IM ✅ | Telegram + WeChat + WeCom adapters, i18n | 0.3.0–0.3.4 |
| Phase 4: Install Flow ✅ | Setup wizard (raw mode), start/run/daemon, health, uninstall | 0.3.5–0.3.23 |
| Phase 5: Ops ✅ | autostart (launchd), version check, doctor, config CRUD, WeChat sandbox fix | 0.3.24 |
| Phase 6: Isolation + NLP Config ✅ | Workspace isolation, isAdmin permission, config protection, NLP config via soul CLI injection | 0.3.25 |
| Phase 7: Quality ✅ | Test framework (bun:test, 188 tests 0 fail, 10 files), `logs` command, `validate` CLI | 0.3.26 |
| Phase 8: Observability ✅ | `session list/info/clear`, `healthz`, `/health` endpoint, provider health checker | 0.3.26 |
| Phase 9: MCP Management ✅ | MCP config store, backend sync, `imtoagent mcp` CLI | 0.3.26 |
| Phase 10: Skills & Prompts ✅ | Skills/prompts managers, `imtoagent skills/prompts` CLI | 0.3.26 |
| Phase 11: Provider Presets ✅ | 20+ presets, `imtoagent providers` CLI | 0.3.26 |
| Phase 12: Proxy Hardening ✅ | Circuit breaker, auto-failover, health check/endpoint | 0.3.26 |
| Phase 13: Gemini CLI ✅ | Gemini adapter + client + backend registration | 0.3.26 |

### ✅ All Planned Phases Complete (Phase 1-13)

Phase 8-13 were all implemented in v0.3.26. No further planned phases — next version depends on user feedback and new feature requests.

---

## 3. CLI Command Reference

| Command | Description |
|---------|-------------|
| `imtoagent setup` | Interactive setup wizard |
| `imtoagent setup --quick` | Quick mode (sandbox workspace, skip workspace step) |
| `imtoagent start` | Start gateway in background (returns immediately) |
| `imtoagent run` | Start gateway in foreground (Ctrl+C to stop) |
| `imtoagent stop` | Stop gateway |
| `imtoagent status` | Check running status (process + config + log size) |
| `imtoagent restore` | Hot reload (SIGHUP) |
| `imtoagent daemon` | Foreground daemon with auto-restart (for launchd/systemd) |
| `imtoagent update-system` | Upgrade imtoagent itself (npm/brew/manual auto-detect) |
| `imtoagent update-backend` | Upgrade current Bot's backend |
| `imtoagent update-backend TYPE` | Upgrade specific backend (codex\|claude\|opencode) |
| `imtoagent uninstall` | Uninstall (keep data by default) |
| `imtoagent uninstall --purge` | Uninstall and delete all data |
| `imtoagent health` | Run comprehensive health check |
| `imtoagent doctor` | Diagnose & fix configuration issues |
| `imtoagent config` | Manage Bot configuration |
| `imtoagent config list` | List all Bots |
| `imtoagent config show NAME` | Show Bot details |
| `imtoagent config add` | Add a new Bot (interactive) |
| `imtoagent config remove NAME` | Remove a Bot |
| `imtoagent config modify NAME` | Modify Bot settings |
| `imtoagent autostart enable` | Enable auto-start on login (launchd) |
| `imtoagent autostart disable` | Disable auto-start |
| `imtoagent autostart status` | Check auto-start status |
| `imtoagent logs` | View gateway logs (default: last 50 lines) |
| `imtoagent logs -n N` | View last N lines |
| `imtoagent logs -f` | Tail -f mode (real-time follow) |
| `imtoagent validate` | Validate config.json (JSON + fields + workspace checks) |

---

## 4. Detailed Designs

### 4.1 Natural Language Configuration Management

**Approach:** No code needed. Inject a CLI reference guide into each Bot's soul context. The Agent already has shell access — it just needs to know which commands to use.

The guide is appended at the end of `_loadSoul()` in `index.ts`, so every Bot automatically receives it. Admin Bots get the full guide; non-admin Bots are told they cannot use these commands.

```typescript
// Injected into every Bot's soul context
imtoagent config list              # List all Bots
imtoagent config show <BotName>    # Show details
imtoagent config add               # Add a new Bot
imtoagent config remove <BotName>  # Remove a Bot
imtoagent config modify <BotName>  # Modify settings
imtoagent restore                  # Hot-reload after changes
imtoagent doctor                   # Diagnose issues
```

**User experience:** Just talk to an admin Bot naturally — "add a Feishu Bot called SupportBot" — and the Agent runs the CLI commands for you.

---

### 4.2 Bot Permission Model

IMtoAgent 是网关，不是操作系统。权限控制只需要管两件事：

1. **Bot 能不能改 IMtoAgent 自身配置**（`~/.imtoagent/` 下的 config.json、providers 等）
2. **Bot 能不能读写工作目录以外的文件**（workspace 边界）

命令白名单、进程隔离、网络限制等属于 **Agent 后端自己的职责**（Claude Code 有 permission mode，Codex 有自己的沙盒），网关层不做重复控制。

**Admin Bot：**
- 可以修改网关配置（通过 NLP config 或 CLI）
- 不受 workspace 边界限制（global 模式）

**Non-admin Bot：**
- 不能修改网关配置
- 受 workspace 边界限制（sandbox 模式下只能访问自己的工作目录）

```typescript
interface BotConfig {
  // ... existing fields
  isAdmin?: boolean;  // true = 可以修改网关配置
}
```

**Two dimensions:**

| | isAdmin: true | isAdmin: false |
|---|---|---|
| workspaceMode: global | Config changes + any directory | Chat only + any directory |
| workspaceMode: sandbox | Config changes + own workspace | Chat only + own workspace |

---

### 4.3 imtoagent doctor — Configuration Diagnostics

**Purpose:** Run anytime for config health checks, or auto-run on startup failure.

**Checks:**

| Check | Severity | Method |
|-------|----------|--------|
| config.json syntax | ERROR | `JSON.parse()` |
| Required fields | ERROR | bots array exists + non-empty, each bot has name/im/backend |
| API Key format | WARNING | Prefix/length check (claude sk-ant-, openai sk-, feishu cli_) |
| Backend installed | WARNING | `checkBackend()` |
| Port 18899 conflict | ERROR | net module test |
| Data directory writable | ERROR | fs.access `~/.imtoagent/` |
| Duplicate Bot names | WARNING | name uniqueness check |

**Output example:**
```
🔍 IMtoAgent Configuration Doctor

  [1/7] Checking config.json syntax...
  ✅ OK — Valid JSON

  [2/7] Checking required fields...
  ⚠️  WARNING — Bot "TestBot" is missing "appSecret"
      → This Bot will fail to start.
      Fix? [y/N]

  [3/7] Checking backend installations...
  ✅ OK — claude: installed
  ✅ OK — codex: installed

  [4/7] Checking port 18899...
  ❌ ERROR — Port 18899 is in use by PID 12345
      → Another instance may be running.
      Fix? (kill process) [y/N]

  Summary: 1 error, 2 warnings
  Auto-fixed: 0 issue(s)
```

---

### 4.4 Workspace Isolation (工作空间隔离)

> 不用"沙盒"这个词——容易误解成系统级隔离。实际是 **工作空间边界控制**。

**Two modes:**

| Mode | Behavior |
|------|----------|
| **Global** (默认) | 所有 Bot 共享同一工作目录，`/dir` 可自由切换 |
| **Sandbox** | 每个 Bot 独立工作空间 `~/.imtoagent/workspaces/<uuid>/`，不能访问外部文件 |

**Config:**
```json
{
  "workspace": {
    "mode": "sandbox",           // sandbox | global
    "globalPath": null,          // global 模式下的共享目录
    "botOverrides": {}           // 按 Bot 覆盖工作目录路径
  }
}
```

**`/dir` behavior difference:**
```
Global mode:
  /dir /Users/keyi/projects/myapp  → ✅ switch
  /dir /etc                        → ✅ allowed (OS permissions still apply)

Sandbox mode:
  /dir /Users/keyi/projects/myapp  → ❌ outside workspace
  /dir ./subdir                    → ✅ inside workspace
  /dir                             → show workspace path
```

**已实现的框架：**
- `WorkspaceManager` — 沙盒/全局模式切换、UUID Bot 隔离、`isPathAllowed` 路径检查
- `/dir` 命令已接入路径校验
- soul 目录自动创建

**已完成的接入：**
- `isPathAllowed` 已保护 `~/.imtoagent/` 配置目录（白名单 workspaces/ 和 soul/）
- `isAdmin` 权限注入 rules.md 和 soul CLI reference

**可选项（非必须）：**
- Agent adapter 在执行文件操作时调用 `isPathAllowed` — 网关层做不到的事（Agent 进程直接操作文件系统），靠 rules.md 软限制

---

## 5. Tool Comparison

| Tool | When | Purpose |
|------|------|---------|
| `setup` | First install | Generate config from scratch |
| `doctor` | Anytime | Check config health, auto-fix |
| NLP config | Runtime | Modify config via IM chat |

## 6. Version History

| Version | Content | Status |
|---------|---------|--------|
| 0.3.23 | uninstall + setup fixes + health | ✅ Released |
| 0.3.24 | autostart + version check + doctor + config CRUD | ✅ Released |
| 0.3.25 | Workspace isolation + isAdmin + config protection + NLP config | ✅ Released |
| 0.3.26 | Phase 7-13: Test framework (188 tests), observability, MCP/skills/prompts/providers CLI, proxy hardening (circuit breaker + auto-failover), Gemini adapter | ✅ Released (Current) |

## 7. Competitive Landscape

### IMtoAgent vs CC Switch

CC Switch (https://ccswitch.io) is a Tauri 2 desktop app for managing AI coding CLIs. IMtoAgent is a CLI gateway for IM → AI Agent communication. They overlap in backend management but diverge fundamentally.

**IMtoAgent unique advantages (CC Switch cannot do these):**
- 4 IM adapters (Feishu, Telegram, WeChat, WeCom) — IMtoAgent is a gateway, not just a config manager
- Soul injection system (rules/identity/profile/skills per Bot)
- NLP command dispatch — talk to the gateway naturally, it runs CLI commands for you
- Bot-level model config persistence with aliases and presets
- Daemon mode with crash recovery and hot reload (SIGHUP)
- No GUI dependency — terminal-native, scriptable, works on headless servers

**CC Switch features IMtoAgent needs to match:**
- MCP management across backends
- Skills installation and management
- Prompts management (CLAUDE.md / AGENTS.md cross-backend sync)
- Provider presets library (50+ built-in)
- Usage statistics dashboard
- Circuit breaker + health monitoring in proxy

**Features we intentionally skip:**
- GUI desktop interface — CLI is the right abstraction for developers
- Cloud sync — local config is sufficient for gateway use case
- System tray — not relevant for CLI tool

**Strategic positioning:**
- CC Switch = desktop config manager for local AI CLI users
- IMtoAgent = IM-connected gateway for team/multi-Bot AI agent deployment
- IMtoAgent covers CC Switch's backend management features AND does IM bridging
- CC Switch cannot touch IMtoAgent's core (IM adapters, soul injection, NLP dispatch)

---

## 8. Detailed Designs: Phase 8+

### 8.1 MCP Management (`imtoagent mcp`)

**Goal:** Manage MCP servers across all backends from one CLI, similar to CC Switch's unified MCP panel but terminal-native.

**Commands:**
```
imtoagent mcp list                    # List all MCP servers across backends
imtoagent mcp list --backend claude   # Filter by backend
imtoagent mcp add <name>              # Add MCP server (interactive or flags)
imtoagent mcp add <name> --command "npx -y @some/mcp" --env KEY=val --backend claude
imtoagent mcp remove <name>           # Remove MCP server
imtoagent mcp enable <name>           # Enable (without removing)
imtoagent mcp disable <name>          # Disable (without removing)
imtoagent mcp import <deep-link>      # Import via ccswitch:// or JSON
imtoagent mcp sync                    # Sync MCP config to all backends
```

**Backend config targets:**
- Claude Code: `~/.claude.json` (mcpServers)
- Codex: `~/.codex/config.json` (mcpServers)
- OpenCode: `~/.imtoagent/opencode.json` (mcpServers)

**Storage:** MCP definitions stored in `~/.imtoagent/mcp.json`, synced to backend-specific configs on `mcp sync` or Bot restart.

### 8.2 Skills Management (`imtoagent skills`)

**Goal:** Install, list, and remove Skills across backends. Support GitHub repos, ZIP files, and local paths.

**Commands:**
```
imtoagent skills list                 # List installed skills
imtoagent skills list --backend claude
imtoagent skills install <github-url> # Install from GitHub repo
imtoagent skills install <zip-path>   # Install from ZIP file
imtoagent skills install <local-path> # Install from local directory
imtoagent skills remove <name>        # Remove a skill
imtoagent skills sync                 # Sync skills to all backends
```

**Storage:** `~/.imtoagent/skills/<name>/` — symlink or copy to backend-specific skill directories on sync.

### 8.3 Prompts Management (`imtoagent prompts`)

**Goal:** Manage shared prompt files (CLAUDE.md, AGENTS.md, GEMINI.md) with cross-backend sync.

**Commands:**
```
imtoagent prompts list                # List prompt files
imtoagent prompts edit <name>         # Edit in $EDITOR
imtoagent prompts sync                # Sync to all backend config dirs
```

**Storage:** `~/.imtoagent/prompts/<name>.md` — synced to:
- Claude Code: `.claude/CLAUDE.md` or project `CLAUDE.md`
- Codex: project `AGENTS.md`
- OpenCode: project `.opencode/prompts.md`

### 8.4 Provider Presets Library

**Goal:** Built-in provider templates so users don't need to manually configure API endpoints.

**Approach:** JSON presets file bundled with npm package:
```json
{
  "presets": [
    {
      "name": "SiliconFlow",
      "baseUrl": "https://api.siliconflow.cn/v1",
      "models": ["claude-sonnet-4", "gpt-4o", "gemini-2.5-pro"],
      "notes": "国内镜像，支持 Claude Code"
    },
    {
      "name": "Compshare Coding Plan",
      "baseUrl": "https://api.compshare.cn/v1",
      "models": ["claude-sonnet-4", "gpt-4o"],
      "notes": "月卡套餐，国内可用"
    }
  ]
}
```

**Commands:**
```
imtoagent providers list              # List configured providers
imtoagent providers presets           # List available presets
imtoagent providers add --preset siliconflow --key sk-xxx
imtoagent providers set <name>        # Switch active provider
```

### 8.5 Proxy Hardening (Circuit Breaker + Health)

**Goal:** Make :18899 proxy production-ready with automatic failover.

**Features:**
- Provider health checks (periodic lightweight requests)
- Circuit breaker (3 failures → mark unhealthy → skip for 60s)
- Auto-failover (try next provider in chain)
- Request retry (idempotent requests only)
- Health endpoint: `curl http://localhost:18899/health`

**Config in `providers.json`:**
```json
{
  "providers": [
    {
      "name": "primary",
      "baseUrl": "...",
      "apiKey": "...",
      "priority": 1,
      "healthCheck": { "enabled": true, "interval": 300 }
    },
    {
      "name": "fallback",
      "baseUrl": "...",
      "apiKey": "...",
      "priority": 2
    }
  ],
  "circuitBreaker": {
    "threshold": 3,
    "recoveryTimeout": 60
  }
}
```

### 8.6 Usage Statistics Enhancement

**Goal:** Better tracking and CLI access to usage data.

**Commands:**
```
imtoagent stats                       # Show current session stats
imtoagent stats --history             # Show historical stats
imtoagent stats --today               # Today's usage
imtoagent stats --bot ClaudeBot       # Per-Bot stats
```

**Storage:** Append-only JSONL in `~/.imtoagent/stats/usage.jsonl`

---

## 9. Implementation Plan (Detailed Sub-tasks)

### Phase 8: Observability — 5 sub-tasks

**Dependencies:** None (foundation for all other phases)
**Estimated new files:** ~600 lines across 4 files

| # | Sub-task | Files | Est. lines | Details |
|---|----------|-------|------------|---------|
| 8.1 | **Structured Logger** | `modules/utils/logger.ts` (new) | ~150 | JSON-lines logger with levels (info/warn/error), component tags, timestamp. Gateway startup logs go here instead of bare `console.log`. |
| 8.2 | **Usage Stats Persistence** | `modules/core/stats-persist.ts` (new) | ~180 | Append JSONL to `~/.imtoagent/stats/usage.jsonl`. Each call writes: `{ botKey, chatId, timestamp, inputTokens, outputTokens, costUSD, durationMs, model, turns, success }`. Read by `imtoagent stats` CLI. |
| 8.3 | **`imtoagent stats` CLI** | `bin/imtoagent-real` (edit) | ~200 | Subcommand dispatch. `stats` (today summary), `stats --history` (last 7 days table), `stats --today`, `stats --bot <name>`, `stats --raw` (last 20 JSONL lines). Reuses `DefaultStatsTracker` + new persistence layer. |
| 8.4 | **Session Management CLI** | `bin/imtoagent-real` (edit) | ~150 | `imtoagent sessions list [--bot NAME]` — list active sessions with idle time. `imtoagent sessions clear [--bot NAME]` — clear idle sessions. Reads from `sessions/` directory + `.memory.json` files. |
| 8.5 | **Integrate stats persistence into runtime** | `modules/core/runtime.ts` (edit) | ~30 | After `statsTracker.accumulate()`, also call `statsPersist.record()`. One-line hook in the success path. |

---

### Phase 9: MCP Management — 4 sub-tasks

**Dependencies:** None (can be done in parallel with Phase 8)
**Estimated new files:** ~500 lines across 3 files

| # | Sub-task | Files | Est. lines | Details |
|---|----------|-------|------------|---------|
| 9.1 | **MCP Config Store** | `modules/utils/mcp-manager.ts` (new) | ~200 | CRUD for `~/.imtoagent/mcp.json`. Each entry: `{ name, command, args, env, backends: string[], enabled }`. Supports add/remove/enable/disable/list. Atomic writes. |
| 9.2 | **Backend Sync** | `modules/utils/mcp-manager.ts` (continued) | ~150 | `syncToBackends()` reads mcp.json and writes to: Claude Code `~/.claude/settings.json` (mcpServers), Codex `~/.codex/settings.json` (mcpServers), OpenCode `~/.imtoagent/opencode.json` (mcpServers). Bidirectional: can also read from backends on first import. |
| 9.3 | **`imtoagent mcp` CLI** | `bin/imtoagent-real` (edit) | ~200 | `mcp list [--backend NAME]`, `mcp add <name> [--command CMD --arg A --env K=V --backend claude]`, `mcp remove <name>`, `mcp enable <name>`, `mcp disable <name>`, `mcp sync`. |
| 9.4 | **Auto-sync on restore** | `modules/core/runtime.ts` (edit) | ~20 | On SIGHUP (restore), call `mcpManager.syncToBackends()` if MCP config changed. |

---

### Phase 10: Skills & Prompts — 4 sub-tasks

**Dependencies:** None
**Estimated new files:** ~450 lines across 3 files

| # | Sub-task | Files | Est. lines | Details |
|---|----------|-------|------------|---------|
| 10.1 | **Skills Manager** | `modules/utils/skills-manager.ts` (new) | ~200 | `~/.imtoagent/skills/` storage. `install(url|path)` — clones git repo or copies directory, validates SKILL.md exists. `list()`, `remove(name)`. Symlink or copy to backend skill dirs on sync. |
| 10.2 | **Prompts Manager** | `modules/utils/prompts-manager.ts` (new) | ~150 | `~/.imtoagent/prompts/` storage. `list()`, `edit(name)` (opens $EDITOR), `sync()` — writes to backend-specific prompt locations. Backfill protection: don't overwrite existing non-empty files. |
| 10.3 | **`imtoagent skills` CLI** | `bin/imtoagent-real` (edit) | ~100 | `skills list`, `skills install <url>`, `skills remove <name>`, `skills sync`. |
| 10.4 | **`imtoagent prompts` CLI** | `bin/imtoagent-real` (edit) | ~50 | `prompts list`, `prompts edit <name>`, `prompts sync`. |

---

### Phase 11: Provider Presets — 3 sub-tasks

**Dependencies:** None (small, quick win)
**Estimated new files:** ~350 lines across 2 files

| # | Sub-task | Files | Est. lines | Details |
|---|----------|-------|------------|---------|
| 11.1 | **Presets Data File** | `templates/presets.json` (new) | ~250 | JSON array of provider presets. Each: `{ name, baseUrl, format, models[], notes, region?, pricing? }`. Start with ~20 presets covering major domestic relays (SiliconFlow, Compshare, DMXAPI, etc.) + cloud providers (AWS Bedrock, GCP Vertex). |
| 11.2 | **`imtoagent providers` CLI** | `bin/imtoagent-real` (edit) | ~100 | `providers list` (configured), `providers presets` (available presets), `providers add --preset NAME --key KEY`, `providers set <name>` (switch active + restart proxy). |
| 11.3 | **Proxy reload on provider change** | `modules/proxy/anthropic-proxy.ts` (edit) | ~20 | Export `reloadProviders()` function. CLI calls it after adding/switching provider. Or use existing SIGHUP mechanism. |

---

### Phase 12: Proxy Hardening — 4 sub-tasks

**Dependencies:** Phase 8 (needs structured logging for health check logs)
**Estimated new files:** ~300 lines + edits to existing proxy

| # | Sub-task | Files | Est. lines | Details |
|---|----------|-------|------------|---------|
| 12.1 | **Health Checker** | `modules/proxy/health-check.ts` (new) | ~100 | Periodic lightweight requests to each provider (every N seconds). Tracks latency, success rate, last-checked time. Updates provider status in sharedState. |
| 12.2 | **Circuit Breaker** | `modules/proxy/circuit-breaker.ts` (new) | ~120 | Per-provider circuit breaker: failure count → open state → skip provider for recoveryTimeout. States: closed (healthy) → open (unhealthy) → half-open (testing). Configurable threshold + recovery timeout. |
| 12.3 | **Auto-Failover in Proxy** | `modules/proxy/anthropic-proxy.ts` (edit) | ~100 | On request failure, try next healthy provider in priority order. Only retry idempotent requests (POST /v1/messages with same body). Log failover event. |
| 12.4 | **Health Endpoint** | `modules/proxy/anthropic-proxy.ts` (edit) | ~30 | `GET /health` → returns `{ providers: [{ name, status, latency, lastChecked }], uptime }`. Machine-readable JSON. |

---

### Phase 13: Gemini CLI Adapter — 3 sub-tasks

**Dependencies:** None (can be done in parallel)
**Estimated new files:** ~350 lines across 2 files

| # | Sub-task | Files | Est. lines | Details |
|---|----------|-------|------------|---------|
| 13.1 | **Gemini CLI HTTP Client** | `modules/agent/gemini-client.ts` (new) | ~120 | Gemini CLI runs `gemini serve` on a local port (similar to OpenCode). HTTP client for `/session` create, `/message` send (streaming SSE), multi-turn loop until text-only response. Follows `opencode-adapter.ts` pattern. |
| 13.2 | **GeminiAdapter** | `modules/agent/gemini-adapter.ts` (new) | ~200 | Implements `AgentAdapter`. `handleMessage()` builds system prompt, calls Gemini client, extracts response + usage stats. `cancel()` aborts active requests. System prompt injection via `buildSystemPrompt()`. |
| 13.3 | **Backend Registration** | `bin/imtoagent-real` (edit), `modules/utils/backend-check.ts` (edit) | ~50 | Add `gemini` to backend check (`which gemini`), add to setup wizard backend selector, add to `update-backend` command. Register in Bot constructor (IM Registry already supports this — just needs the adapter import). |

---

### ~~Recommended Execution Order~~ — All Phases 8-13 Complete ✅

All planned phases through Phase 13 have been implemented in v0.3.26. The gateway now supports:
- Session management, health checks, structured logging
- MCP server management across backends
- Skills and prompts installation/management
- 20+ provider presets for quick setup
- Proxy hardening with circuit breaker and automatic failover
- Gemini CLI backend adapter

---

## 9. Key Decisions

| Decision | Conclusion | Date |
|----------|------------|------|
| Setup wizard simplified? | ❌ No, focus on bug-free instead | 2026-05-30 |
| Quick mode needed? | ❌ Not essential (API keys require manual entry) | 2026-05-30 |
| NLP config approach | ✅ Soul CLI injection — no code needed, just inject command reference into Agent context | 2026-05-30 |
| Bot permission scope | ✅ 只控制配置修改权限 + workspace 边界，不做 OS 级沙盒 | 2026-05-30 |
| Test strategy | ✅ bun:test + tests/ directory (excluded from npm publish) | 2026-05-30 |
| GitHub push over HTTPS | ⚠️ 本机 HTTPS 认证到 GitHub 有间歇性超时，SSH (ssh.github.com:443) 更可靠 | 2026-05-30 |

---

*This document replaces `development-plan.md` and `detailed-design-nlp-doctor.md`. Old files deleted.*
