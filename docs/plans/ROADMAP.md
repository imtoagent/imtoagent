# IMtoAgent Development Roadmap

> Last updated: 2026-05-30 | Phase 7 complete | Current version: 0.3.26

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
| **Tests** | 27 tests across 2 test suites (config-manager, workspace-manager), 0 failures |
| **Code Size** | 14,315 lines across 35 .ts files |
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
| Phase 7: Quality ✅ | Test framework (bun:test), `logs` command, `validate` CLI | 0.3.26 |

### 🔴 What's Next

| Phase | Priority | Content | Status |
|-------|----------|---------|--------|
| Phase 8: Observability | TBD | Structured logging, lightweight dashboard, session management CLI | ❌ Not started |

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
| 0.3.26 | Test framework + logs + validate CLI | ✅ Released (Current) |

## 7. Key Decisions

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
