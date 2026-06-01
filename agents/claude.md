# Claude Code

## Installation

```bash
npm install -g @anthropic-ai/claude-agent-sdk
```

## Integration

IMtoAgent integrates Claude Code via the **Claude Agent SDK**. Each bot message spawns a query to the SDK with the configured model and system prompt.

## Features

- **Multi-turn agent loop** — Claude SDK handles tool use internally
- **Session persistence** — `sdkSessionId` saved to disk for conversation continuity
- **Model aliases** — Configure `sonnet`, `opus`, `haiku` aliases per bot
- **Permission modes** — `bypassPermissions` or interactive approval

## How it works

```
User message → ClaudeAdapter → Claude SDK query() → streaming assistant messages
  ├── assistant: tool_use blocks → extract tool names for progress display
  ├── assistant: text blocks → accumulate response text
  └── result: final outcome → return to user
```

The adapter streams SDK messages, extracts tool calls and text in real-time, and sends progress updates back to the user via `sendProgress`.
