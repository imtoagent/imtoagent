# Agent Backends

| Backend | Integration |
|---------|-------------|
| **Claude Code** | Claude Agent SDK spawn subprocess |
| **Codex** | app-server v2 (stdio JSON-RPC) + exec CLI fallback |
| **OpenCode** | HTTP API client + turn loop |

## Claude Code

```bash
npm install -g @anthropic-ai/claude-agent-sdk
```

Integrated via Claude Agent SDK spawn subprocess.

## Codex

```bash
npm install -g @openai/codex
```

Uses app-server v2 (stdio JSON-RPC) as primary, exec CLI as fallback.

## OpenCode

```bash
npm install -g opencode
```

Connects via HTTP API client with turn loop.

## Unified Proxy

All agent backends route through a single proxy port (`:18899`) in Anthropic-compatible format. This means:

- Claude requests → direct OpenAI format conversion → upstream
- Codex requests → handled internally via `handleCodexRequest()`
- No need for separate proxy ports

```bash
export ANTHROPIC_BASE_URL='http://localhost:18899'
```
