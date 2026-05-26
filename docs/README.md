# IMtoAgent

> **IM ↔ Agent Unified Gateway**
>  — Connect IM platforms to AI coding agents

[![npm version](https://img.shields.io/npm/v/imtoagent.svg)](https://www.npmjs.com/package/imtoagent)
[![npm downloads](https://img.shields.io/npm/dt/imtoagent.svg)](https://www.npmjs.com/package/imtoagent)
[![license](https://img.shields.io/npm/l/imtoagent.svg)](https://github.com/imtoagent/imtoagent)

## What is it?

IMtoAgent bridges **IM platforms** (Feishu, Telegram, WeChat, WeCom) with **AI coding agents** (Claude Code, Codex, OpenCode) through a unified gateway. Send messages to your bot in any IM, and it routes to the appropriate AI agent — all through a single proxy port (`:18899`).

## Quick Install

```bash
# One-line install (macOS/Linux)
curl -fsSL https://imtoagent.pages.dev/install.sh | bash

# Or via npm
npm install -g imtoagent
imtoagent setup
imtoagent start
```

## Architecture

```
IM Platform (Feishu / Telegram / WeChat / WeCom)
         │
         ▼
   ┌─────────────┐
   │  IMtoAgent  │  ← Unified Gateway
   │   :18899    │
   └─────────────┘
         │
         ▼
AI Agent (Claude Code / Codex / OpenCode)
```

## Supported Platforms

| IM Platform | Agent Backend |
|-------------|---------------|
| Feishu | Claude Code |
| Telegram | Codex |
| Enterprise WeChat | OpenCode |
| Personal WeChat | |

## Key Features

- **Unified Proxy** — All agent requests through one port (`:18899`)
- **Multi-Bot** — Run multiple bots with different IM + agent combinations
- **Hot Reload** — `imtoagent restore` without restarting
- **Soul System** — Per-bot identity/rules injection (`soul/<BotName>/`)
- **Session Persistence** — Disk-based session state
- **Capability-aware** — Agents adapt output format based on IM capabilities

## Links

- [GitHub Repository](https://github.com/imtoagent/imtoagent)
- [npm Package](https://www.npmjs.com/package/imtoagent)
- [Report Issues](https://github.com/imtoagent/imtoagent/issues)
