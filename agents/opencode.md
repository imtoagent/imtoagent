# OpenCode

## Installation

```bash
npm install -g opencode
```

## Integration

IMtoAgent starts and manages `opencode serve` on port `4096`. The adapter communicates via HTTP API.

## Features

- **Auto server management** — Starts/stops opencode serve automatically
- **Multi-turn loop** — Client-side turn loop for tool_call → text response cycle
- **Session management** — `ocSessionId` persisted per conversation
- **Progress streaming** — Real-time tool execution and turn completion updates

## How it works

```
User message → OpenCodeAdapter → opencode serve :4096
  └── POST /session/{id}/message (single-turn API)
      ├── tool_call parts → send progress, auto-advance next turn
      └── text part → return to user

Adapter manages multi-turn loop:
  1. Send user message
  2. Check for tool_call → send progress → send "continue" prompt
  3. Repeat until text response received
  4. Max 50 turns, 60 min total timeout
```
