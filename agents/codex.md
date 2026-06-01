# Codex

## Installation

```bash
npm install -g @openai/codex
```

## Integration

IMtoAgent supports Codex via two paths:

1. **App-Server (preferred)** — Process-local HTTP streaming with persistent threads
2. **CLI fallback** — `codex exec` / `codex exec resume` subprocess

## Features

- **Thread persistence** — `codexThreadId` saved per session, survives restarts
- **Plan mode** — Toggle `codexMode: "plan"` for planning before execution
- **Auto thread recovery** — Rebuilds thread if process restarted
- **Graceful fallback** — Falls back to CLI if app-server is unavailable

## How it works

```
User message → CodexAdapter → App-Server client
  ├── text_delta → stream response text
  ├── tool_call → send progress to user
  └── turn_result → accumulate usage stats, mark complete

If app-server unavailable → spawn codex exec/resume subprocess
```
