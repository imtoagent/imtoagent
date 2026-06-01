# Phase 8-13 Implementation Details (Archived)

> All phases implemented in v0.3.26. This file preserves the original design specs for reference.
> Archived: 2026-05-31

---

## Phase 8: Observability — 5 sub-tasks

| # | Sub-task | Files | Est. lines | Details |
|---|----------|-------|------------|---------|
| 8.1 | **Structured Logger** | `modules/utils/logger.ts` (new) | ~150 | JSON-lines logger with levels (info/warn/error), component tags, timestamp. Gateway startup logs go here instead of bare `console.log`. |
| 8.2 | **Usage Stats Persistence** | `modules/core/stats-persist.ts` (new) | ~180 | Append JSONL to `~/.imtoagent/stats/usage.jsonl`. Each call writes: `{ botKey, chatId, timestamp, inputTokens, outputTokens, costUSD, durationMs, model, turns, success }`. Read by `imtoagent stats` CLI. |
| 8.3 | **`imtoagent stats` CLI** | `bin/imtoagent-real` (edit) | ~200 | Subcommand dispatch. `stats` (today summary), `stats --history` (last 7 days table), `stats --today`, `stats --bot <name>`, `stats --raw` (last 20 JSONL lines). Reuses `DefaultStatsTracker` + new persistence layer. |
| 8.4 | **Session Management CLI** | `bin/imtoagent-real` (edit) | ~150 | `imtoagent sessions list [--bot NAME]` — list active sessions with idle time. `imtoagent sessions clear [--bot NAME]` — clear idle sessions. Reads from `sessions/` directory + `.memory.json` files. |
| 8.5 | **Integrate stats persistence into runtime** | `modules/core/runtime.ts` (edit) | ~30 | After `statsTracker.accumulate()`, also call `statsPersist.record()`. One-line hook in the success path. |

---

## Phase 9: MCP Management — 4 sub-tasks

| # | Sub-task | Files | Est. lines | Details |
|---|----------|-------|------------|---------|
| 9.1 | **MCP Config Store** | `modules/utils/mcp-manager.ts` (new) | ~200 | CRUD for `~/.imtoagent/mcp.json`. Each entry: `{ name, command, args, env, backends: string[], enabled }`. Supports add/remove/enable/disable/list. Atomic writes. |
| 9.2 | **Backend Sync** | `modules/utils/mcp-manager.ts` (continued) | ~150 | `syncToBackends()` reads mcp.json and writes to: Claude Code `~/.claude/settings.json` (mcpServers), Codex `~/.codex/settings.json` (mcpServers), OpenCode `~/.imtoagent/opencode.json` (mcpServers). Bidirectional: can also read from backends on first import. |
| 9.3 | **`imtoagent mcp` CLI** | `bin/imtoagent-real` (edit) | ~200 | `mcp list [--backend NAME]`, `mcp add <name> [--command CMD --arg A --env K=V --backend claude]`, `mcp remove <name>`, `mcp enable <name>`, `mcp disable <name>`, `mcp sync`. |
| 9.4 | **Auto-sync on restore** | `modules/core/runtime.ts` (edit) | ~20 | On SIGHUP (restore), call `mcpManager.syncToBackends()` if MCP config changed. |

---

## Phase 10: Skills & Prompts — 4 sub-tasks

| # | Sub-task | Files | Est. lines | Details |
|---|----------|-------|------------|---------|
| 10.1 | **Skills Manager** | `modules/utils/skills-manager.ts` (new) | ~200 | `~/.imtoagent/skills/` storage. `install(url|path)` — clones git repo or copies directory, validates SKILL.md exists. `list()`, `remove(name)`. Symlink or copy to backend skill dirs on sync. |
| 10.2 | **Prompts Manager** | `modules/utils/prompts-manager.ts` (new) | ~150 | `~/.imtoagent/prompts/` storage. `list()`, `edit(name)` (opens $EDITOR), `sync()` — writes to backend-specific prompt locations. Backfill protection: don't overwrite existing non-empty files. |
| 10.3 | **`imtoagent skills` CLI** | `bin/imtoagent-real` (edit) | ~100 | `skills list`, `skills install <url>`, `skills remove <name>`, `skills sync`. |
| 10.4 | **`imtoagent prompts` CLI** | `bin/imtoagent-real` (edit) | ~50 | `prompts list`, `prompts edit <name>`, `prompts sync`. |

---

## Phase 11: Provider Presets — 3 sub-tasks

| # | Sub-task | Files | Est. lines | Details |
|---|----------|-------|------------|---------|
| 11.1 | **Presets Data File** | `templates/presets.json` (new) | ~250 | JSON array of provider presets. Each: `{ name, baseUrl, format, models[], notes, region?, pricing? }`. Start with ~20 presets covering major domestic relays (SiliconFlow, Compshare, DMXAPI, etc.) + cloud providers (AWS Bedrock, GCP Vertex). |
| 11.2 | **`imtoagent providers` CLI** | `bin/imtoagent-real` (edit) | ~100 | `providers list` (configured), `providers presets` (available presets), `providers add --preset NAME --key KEY`, `providers set <name>` (switch active + restart proxy). |
| 11.3 | **Proxy reload on provider change** | `modules/proxy/anthropic-proxy.ts` (edit) | ~20 | Export `reloadProviders()` function. CLI calls it after adding/switching provider. Or use existing SIGHUP mechanism. |

---

## Phase 12: Proxy Hardening — 4 sub-tasks

| # | Sub-task | Files | Est. lines | Details |
|---|----------|-------|------------|---------|
| 12.1 | **Health Checker** | `modules/proxy/health-check.ts` (new) | ~100 | Periodic lightweight requests to each provider (every N seconds). Tracks latency, success rate, last-checked time. Updates provider status in sharedState. |
| 12.2 | **Circuit Breaker** | `modules/proxy/circuit-breaker.ts` (new) | ~120 | Per-provider circuit breaker: failure count → open state → skip provider for recoveryTimeout. States: closed (healthy) → open (unhealthy) → half-open (testing). Configurable threshold + recovery timeout. |
| 12.3 | **Auto-Failover in Proxy** | `modules/proxy/anthropic-proxy.ts` (edit) | ~100 | On request failure, try next healthy provider in priority order. Only retry idempotent requests (POST /v1/messages with same body). Log failover event. |
| 12.4 | **Health Endpoint** | `modules/proxy/anthropic-proxy.ts` (edit) | ~30 | `GET /health` → returns `{ providers: [{ name, status, latency, lastChecked }], uptime }`. Machine-readable JSON. |

---

## Phase 13: Gemini CLI Adapter — 3 sub-tasks

| # | Sub-task | Files | Est. lines | Details |
|---|----------|-------|------------|---------|
| 13.1 | **Gemini CLI HTTP Client** | `modules/agent/gemini-client.ts` (new) | ~120 | Gemini CLI runs `gemini serve` on a local port (similar to OpenCode). HTTP client for `/session` create, `/message` send (streaming SSE), multi-turn loop until text-only response. Follows `opencode-adapter.ts` pattern. |
| 13.2 | **GeminiAdapter** | `modules/agent/gemini-adapter.ts` (new) | ~200 | Implements `AgentAdapter`. `handleMessage()` builds system prompt, calls Gemini client, extracts response + usage stats. `cancel()` aborts active requests. System prompt injection via `buildSystemPrompt()`. |
| 13.3 | **Backend Registration** | `bin/imtoagent-real` (edit), `modules/utils/backend-check.ts` (edit) | ~50 | Add `gemini` to backend check (`which gemini`), add to setup wizard backend selector, add to `update-backend` command. Register in Bot constructor (IM Registry already supports this — just needs the adapter import). |
