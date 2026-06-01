# IMtoAgent

> **Your IM is the new terminal.**

Connect any messaging platform to powerful AI coding agents — through a single, unified gateway. No new apps. No new UIs. Just chat.

[![npm version](https://img.shields.io/npm/v/imtoagent.svg)](https://www.npmjs.com/package/imtoagent)
[![npm downloads](https://img.shields.io/npm/dt/imtoagent.svg)](https://www.npmjs.com/package/imtoagent)
[![license](https://img.shields.io/npm/l/imtoagent.svg)](https://github.com/imtoagent/imtoagent)

---

## ✨ Why IMtoAgent?

You already live in your IM app. Why switch to a browser or terminal to talk to AI?

IMtoAgent bridges **messaging platforms** with **AI coding agents** so you can:

- 💬 Chat with Claude Code from **Feishu**
- 🚀 Kick off Codex sessions from **Telegram**
- 🔧 Debug with OpenCode from **WeChat**
- 🏢 Run enterprise bots from **WeCom**

All through **one gateway** on port `:18899`. All with **persistent sessions**, **soul injection**, and **capability-aware formatting**.

---

## 🏗 Architecture

```
IM Platform (Feishu / Telegram / WeChat / WeCom)
         │
         ▼
   ┌─────────────┐
   │  IMtoAgent  │  ← Unified Gateway :18899
   └─────────────┘
         │
         ▼
AI Agent (Claude Code / Codex / OpenCode / Gemini CLI)
```

### Supported Platforms

| IM Platform | Connection | Features |
|-------------|-----------|----------|
| **Feishu** | WebSocket | Text, Cards, Files, Images, Audio, Buttons |
| **Telegram** | Long Polling | Text, Files, Images, Audio |
| **WeChat** | HTTP Long Poll | Text, Images, Files, Voice |
| **WeCom** | Webhook | Text, Files, Images |

### Supported Backends

| Agent Backend | Protocol | Resource Injection |
|---------------|----------|-------------------|
| **Claude Code** | Agent SDK (stdio) | MCP / Skills / Prompts |
| **Codex** | App Server v2 | MCP / Skills / Prompts |
| **OpenCode** | HTTP API | MCP / Skills / Prompts |
| **Gemini CLI** | Exec fallback | — |

---

## 🚀 Quick Start

```bash
# One-line install
curl -fsSL https://imtoagent.pages.dev/install.sh | bash

# Or via npm
npm install -g imtoagent
imtoagent setup
imtoagent start
```

That's it. Your bot is alive.

---

## 🔑 Key Features

- **🔌 Unified Proxy** — All agent requests through a single port (`:18899`)
- **🤖 Multi-Bot** — Run multiple bots with different IM + agent combos
- **⚡ Hot Reload** — `imtoagent restore` without downtime
- **🧠 Soul System** — Per-bot identity, rules, and personality injection
- **💾 Session Persistence** — Disk-based state, survives restarts
- **🎯 Capability-Aware** — Agents adapt output based on IM capabilities
- **📦 Resource Managers** — MCP, Skills, Prompts injected into system prompts
- **🛠 26 CLI Commands** — Full lifecycle management from setup to diagnostics

---

## 📖 Explore

- [📦 Installation Guide](guide/installation.md) — Install and get running
- [⚙️ Configuration](guide/configuration.md) — Bot setup and tuning
- [🔌 IM Adapters](adapters/) — Platform-specific details
- [🧑‍💻 Agent Backends](agents/) — Claude Code, Codex, OpenCode
- [🏗 Architecture](architecture/) — How it all fits together
- [🖥 CLI Reference](cli/) — All 26 commands

---

## 🔗 Links

- [GitHub Repository](https://github.com/imtoagent/imtoagent)
- [npm Package](https://www.npmjs.com/package/imtoagent)
- [Report Issues](https://github.com/imtoagent/imtoagent/issues)
