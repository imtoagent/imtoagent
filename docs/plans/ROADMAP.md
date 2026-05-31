# IMtoAgent Status & Maintenance

> Last updated: 2026-05-31 | All Phases 1-13 complete ✅ | Current version: 0.3.26
> This document replaces the development ROADMAP. All planned phases are implemented.

---

## System Overview

IMtoAgent bridges **IM platforms** (Feishu, Telegram, WeChat, WeCom) with **AI coding agents** (Claude Code, Codex, OpenCode, Gemini CLI) via a unified gateway on port `:18899`.

```
IM Platform → IM Registry → Bot Instance → AgentRuntime → Agent Adapter → Proxy :18899 → Upstream
```

See [ARCHITECTURE.md](../../.codex-docs/ARCHITECTURE.md) for full architecture.

## Current Status (v0.3.26)

| Area | Details |
|------|---------|
| **IM Adapters** | Feishu (731L), Telegram (639L), WeChat (1094L), WeCom (603L) |
| **Agent Backends** | Claude Code, Codex (app-server v2), OpenCode, Gemini CLI |
| **Unified Proxy** | Port `:18899` only — Anthropic Proxy handles all routing |
| **CLI Commands** | 26 commands + subcommands |
| **Tests** | 188 tests across 10 files, 0 failures |
| **Code Size** | ~16,000+ lines across 50+ .ts files |
| **npm Package** | Published at `imtoagent` (npm + GitHub) |

## Completed Phases

| Phase | Content | Version |
|-------|---------|---------|
| 1: Core | Feishu ↔ Claude/Codex, unified proxy, session continuity | 0.1.x–0.2.x |
| 2: Modular | IM Registry, capability system, extracted modules | 0.2.x–0.3.0 |
| 3: Multi-IM | Telegram + WeChat + WeCom, i18n | 0.3.0–0.3.4 |
| 4: Install Flow | Setup wizard, start/run/daemon, health, uninstall | 0.3.5–0.3.23 |
| 5: Ops | autostart, version check, doctor, config CRUD | 0.3.24 |
| 6: Isolation + NLP | Workspace isolation, isAdmin, config protection, NLP config | 0.3.25 |
| 7: Quality | bun:test (188 tests), `logs` command, `validate` CLI | 0.3.26 |
| 8: Observability | Session management, health endpoint, provider health | 0.3.26 |
| 9: MCP | MCP config store, backend sync, `imtoagent mcp` CLI | 0.3.26 |
| 10: Skills & Prompts | Skills/prompts managers, CLI commands | 0.3.26 |
| 11: Provider Presets | 20+ presets, `imtoagent providers` CLI | 0.3.26 |
| 12: Proxy Hardening | Circuit breaker, auto-failover, health check | 0.3.26 |
| 13: Gemini CLI | Gemini adapter + client + backend registration | 0.3.26 |

Detailed sub-task specs archived at [archive/phase-8-13-implementation.md](archive/phase-8-13-implementation.md).

---

## CLI Quick Reference

See [CLI Reference](../cli/README.md) for full details. Key commands:

| Command | Description |
|---------|-------------|
| `imtoagent setup` | Interactive configuration wizard |
| `imtoagent start` | Background start (returns immediately) |
| `imtoagent run` | Foreground start (Ctrl+C to stop) |
| `imtoagent stop` | Stop gateway |
| `imtoagent status` | Running status (process + config + logs) |
| `imtoagent restore` | Hot reload (SIGHUP) |
| `imtoagent health` | Comprehensive health check |
| `imtoagent doctor` | Diagnose & fix config issues |
| `imtoagent config` | Bot CRUD (list/show/add/remove/modify) |
| `imtoagent mcp` | MCP server management |
| `imtoagent providers` | Provider presets & configuration |
| `imtoagent sessions` | Session list/clear |
| `imtoagent logs` | Gateway logs (`-n N`, `-f` for tail) |
| `imtoagent validate` | Validate config.json |

---

## Key Architecture Decisions

| Decision | Rationale | Date |
|----------|-----------|------|
| Single port `:18899` | All proxy requests through one Anthropic Proxy, simpler routing | Phase 2 |
| IM Registry factory | Add IM with one line, no Bot constructor changes | Phase 2 |
| Bot permission: admin vs non-admin | Only control config modification + workspace boundary, not OS-level sandbox | Phase 6 |
| NLP config via soul injection | No extra code — Agent already has shell access, just needs command reference | Phase 6 |
| Test strategy: bun:test + tests/ | Fast, native to Bun runtime, excluded from npm publish | Phase 7 |
| Workspace isolation: sandbox vs global | Two modes — global (default) for shared dir, sandbox for per-Bot isolation | Phase 6 |

See [Key Decisions Archive](archive/decisions-archive.md) for the full decision log.

---

## Version History

| Version | Key Changes | Status |
|---------|-------------|--------|
| 0.3.26 | Phase 7-13: tests, observability, MCP/skills/prompts/providers, proxy hardening, Gemini | ✅ Current |
| 0.3.25 | Workspace isolation, isAdmin, config protection, NLP config | ✅ |
| 0.3.24 | autostart, version check, doctor, config CRUD | ✅ |
| 0.3.23 | uninstall + setup fixes + health | ✅ |
| 0.1.x–0.2.x | Core gateway, Feishu ↔ Claude/Codex | ✅ |

---

## Competitive Positioning

IMtoAgent is a **CLI gateway** for IM → AI Agent communication. Not a desktop config manager.

**Unique advantages:**
- 4 IM adapters (Feishu, Telegram, WeChat, WeCom)
- Soul injection system (per-Bot identity/rules/skills)
- NLP command dispatch (natural language → CLI commands)
- No GUI dependency — terminal-native, scriptable, headless-ready
- Multi-Bot with different IM + agent combinations

**vs CC Switch:**
- CC Switch = desktop config manager for local AI CLI users
- IMtoAgent = IM-connected gateway for team/multi-Bot deployment
- They overlap in backend management (MCP, skills, presets) but diverge on IM bridging

---

## What's Next

No planned phases. Future work depends on user feedback and new feature requests.

Potential directions:
- Phase 14: Testing expansion (IM adapter + Agent backend mock tests)
- Phase 15: More IM adapters (Discord, Slack, WhatsApp)
- Phase 16: More Agent backends
- Documentation site improvements

---

*This document is the successor to the original development ROADMAP. All planned phases (1-13) have been implemented and released in v0.3.26.*
