# Getting Started

## Overview

IMtoAgent is a unified gateway that connects **IM platforms** (Feishu, Telegram, WeChat, WeCom) to **AI coding agents** (Claude Code, Codex, OpenCode). Send messages to your bot in any IM, and it routes to the appropriate AI agent.

## Architecture

```
IM Platform (Feishu/Telegram/WeChat/WeCom)
         │
         ▼
   ┌─────────────┐
   │  IMtoAgent  │  ← Unified Gateway
   │   :18899    │
   └─────────────┘
         │
         ▼
AI Agent (Claude Code / Codex / OpenCode)
         │
         ▼
   Model Provider (DeepSeek, Dashscope, etc.)
```

## Key Features

- **One port for everything** — All agent requests through `:18899`
- **Multi-bot support** — Run multiple bots with different IM + agent combos
- **Hot reload** — `imtoagent restore` without full restart
- **Soul system** — Per-bot personality injection
- **Session persistence** — Conversation state saved to disk
- **Capability-aware** — Agents adapt output format per IM platform

## Next Steps

- [Installation](guide/installation.md) — Get it running
- [Quick Start](guide/quick-start.md) — 5-minute setup
- [Configuration](guide/configuration.md) — Detailed config guide
