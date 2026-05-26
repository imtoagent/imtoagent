# IMtoAgent — IM ↔ Agent Unified Gateway

Connect Feishu, Telegram, personal WeChat, and WeCom to AI coding agents like Claude Code, Codex (GPT), OpenCode, and more.

One gateway, multiple IMs, multiple agents, unified port proxy.

## 🚀 Quick Start (5 Minutes)

### Step 1: Install (One Command)

```bash
curl -fsSL https://imtoagent.pages.dev/install.sh | bash
```

This script detects your environment, installs bun if needed, installs imtoagent, and guides you through setup.

### Step 2: Start

```bash
imtoagent setup
```

The interactive wizard guides you through:
1. Select IM platform (Feishu/Telegram/WeChat/WeCom)
2. Enter Bot credentials
3. Choose Agent backend (Claude Code/Codex/OpenCode)
4. Configure model providers (API keys)
5. Generate soul files for personality injection

### Step 2: Verify

```bash
imtoagent status    # check it's running
```

That's it! Send `/help` to your Bot in the IM to see available commands.

---

**Alternative install methods:** See [Installation Methods](#installation-methods) below for npm global install or source install.

---

## Architecture

```
IM Platform (Feishu/Telegram/WeChat/WeCom)
    → IM Registry Factory → Bot Instance
        → AgentRuntime SDK → Agent Adapter
            → Unified Proxy (:18899) → Upstream Models
```

### Supported IM Adapters

| IM | Connection | Capabilities |
|----|----------|------|
| **Feishu** | WebSocket persistent connection + auto-reconnect | Text, code blocks, cards, files, images, voice, buttons |
| **Telegram** | Long polling + HTTP proxy | Text, files, images, voice |
| **Personal WeChat** | iLink HTTP long-poll + QR scan | Text, images, files, voice (AES-128-ECB encrypted) |
| **WeCom** | HTTP Webhook callback + REST API | Text, files, images |

### Supported Agent Backends

| Backend | Integration Method |
|------|----------|
| **Claude Code** | Claude Agent SDK spawn subprocess |
| **Codex** | app-server v2 (stdio JSON-RPC) |
| **OpenCode** | HTTP API client |

## Quick Start

### Prerequisites

- **Bun** runtime (≥1.0.0): `brew install oven-sh/bun/bun`
- **macOS / Linux**
- **At least one Agent backend** (see table below; can be installed before or after imtoagent)

| Backend | Install Command |
|------|----------|
| Claude Code | `npm install -g @anthropic-ai/claude-agent-sdk` |
| Codex | `npm install -g @openai/codex` |
| OpenCode | `npm install -g opencode` |

## Installation Methods

### Method 1: One-Click Install (Recommended)

```bash
curl -fsSL https://imtoagent.pages.dev/install.sh | bash
```

This script does everything automatically:
- Detects your OS and environment
- Installs bun if missing
- Installs or upgrades imtoagent
- Runs the setup wizard if no configuration exists
- Starts the gateway and verifies it's running

**Flags:**
- `--non-interactive` — Skip all prompts, auto-install and auto-start
- `--skip-bun` — Skip bun installation check
- `--skip-start` — Don't start the gateway after install

### Method 2: npm Global Install

```bash
npm install -g imtoagent
```

This is the simplest approach. After installation, the post-install script checks if you need initial configuration.

### Method 3: Source Install

```bash
git clone https://github.com/imtoagent/imtoagent.git
cd imtoagent
bun install
bun run bin/imtoagent setup
```

Use this for development or if you want to modify the source code.

### Prerequisites

- **Bun** runtime (≥1.0.0): `brew install oven-sh/bun/bun`
- **macOS or Linux**
- **At least one Agent backend** installed (see below)

### Agent Backend Installation

| Backend | Install Command |
|---------|----------------|
| Claude Code | `npm install -g @anthropic-ai/claude-agent-sdk` |
| Codex | `npm install -g @openai/codex` |
| OpenCode | `npm install -g opencode` |

You can install backends before or after installing imtoagent.

## Configuration

### First-Time Setup

```bash
imtoagent setup
```

The interactive wizard will guide you through:

1. **Configure Bot** — Select IM platform + Agent backend combination
2. **Configure Model Providers** — Add API credentials (DeepSeek, Dashscope, etc.)
3. **Generate Soul Files** — Create personality files (rules.md, identity.md, etc.)
4. **Write Config Files** — Auto-generate `~/.imtoagent/config.json`

### Platform-Specific Requirements

#### Feishu
- **App ID** (`cli_...`) and **App Secret**
- Enable in Feishu app console: Bot, Event Subscription, Message Send/Receive permissions

#### Telegram
- **Bot Token** from @BotFather
- Optional: HTTP proxy (e.g., `http://127.0.0.1:7890`)

#### Personal WeChat
- QR code automatically appears on first `imtoagent start`
- Scan with WeChat on your phone to complete binding

#### WeCom (Enterprise WeChat)
- Webhook callback URL configuration
- REST API credentials

## Running the Gateway

### Basic Commands

| Command | Description |
|---------|-------------|
| `imtoagent start` | Start gateway in background |
| `imtoagent stop` | Stop the gateway |
| `imtoagent status` | Check running status |
| `imtoagent restore` | Hot reload recovery |
| `imtoagent daemon` | Foreground daemon mode (crash auto-restart) |

### Running Modes

- **`start`** — Background mode, terminal returns immediately
- **`run`** — Foreground mode, real-time logs, Ctrl+C to stop
- **`daemon`** — Foreground with auto-restart on crash

### Auto-Start on Boot

#### macOS (launchd)

```bash
# Create launchd configuration
cat > ~/Library/LaunchAgents/com.imtoagent.plist << 'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.imtoagent</string>
    <key>ProgramArguments</key>
    <array>
        <string>/opt/homebrew/bin/bun</string>
        <string>run</string>
        <string>/usr/local/lib/node_modules/imtoagent/index.ts</string>
        <string>daemon</string>
    </array>
    <key>WorkingDirectory</key>
    <string>/Users/$USER/.imtoagent</string>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <dict>
        <key>SuccessfulExit</key>
        <false/>
    </dict>
    <key>StandardOutPath</key>
    <string>/Users/$USER/.imtoagent/logs/launchd.out.log</string>
    <key>StandardErrorPath</key>
    <string>/Users/$USER/.imtoagent/logs/launchd.err.log</string>
</dict>
</plist>
EOF

# Load the service
launchctl load ~/Library/LaunchAgents/com.imtoagent.plist
```

#### Linux (systemd)

Create `/etc/systemd/system/imtoagent.service`:

```ini
[Unit]
Description=IMtoAgent Gateway
After=network.target

[Service]
Type=simple
User=youruser
WorkingDirectory=/home/youruser/.imtoagent
ExecStart=/usr/bin/bun run /usr/lib/node_modules/imtoagent/index.ts daemon
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```

```bash
systemctl daemon-reload
systemctl enable imtoagent
systemctl start imtoagent
```

## Using the Gateway

### Built-In Commands

Send these to your Bot in the IM chat:

| Command | Description |
|---------|-------------|
| `/help` | Show available commands |
| `/status` | Gateway status |
| `/stats` | Usage statistics |
| `/model` | Switch AI model |
| `/providers` | View model providers |
| `/memory` | View memory status |
| `/soul` | Soul management |
| `/reload` | Reload configuration |
| `/clear` | Clear conversation session |
| `/mode` | Switch mode (permission/auto/plan) |
| `/dir` | Switch working directory |

## Project Structure

```
imtoagent/
├── index.ts                    # Entry — IM Registry + Bot construction + Proxy startup
├── bin/imtoagent               # CLI command entry point
├── modules/
│   ├── core/                   # SDK Core
│   │   ├── AgentRuntime.ts     # Message processing hub
│   │   ├── AgentAdapter.ts     # Unified Agent backend abstraction
│   │   ├── SessionManager.ts   # Session persistence
│   │   └── types.ts            # Type definitions
│   ├── im/                     # IM adapters
│   │   ├── feishu.ts           # Feishu
│   │   ├── telegram.ts         # Telegram
│   │   ├── wechat.ts           # Personal WeChat
│   │   └── wecom.ts            # WeCom
│   ├── agent/                  # Agent backends
│   │   ├── claude-adapter.ts   # Claude Code
│   │   ├── codex-adapter.ts    # Codex
│   │   └── opencode-adapter.ts # OpenCode
│   ├── proxy/                  # Unified proxy
│   │   └── anthropic-proxy.ts  # :18899 Anthropic format proxy
│   ├── cli/                    # CLI
│   │   └── setup.ts            # Interactive setup wizard
│   └── utils/
│       └── paths.ts            # Path resolution + auto-init
├── scripts/
│   └── postinstall.ts          # Post-npm-install guidance
├── templates/                  # Config templates
│   ├── config.template.json
│   ├── providers.template.json
│   ├── opencode.template.json
│   └── soul.template/
└── README.md
```

## Data Directory

All runtime data is stored in `~/.imtoagent/`:

```
~/.imtoagent/
├── config.json          # Main config (Bot + providers + system)
├── providers.json       # Model provider configurations
├── opencode.json        # OpenCode-specific config
├── sessions/            # Conversation persistence
├── logs/                # Runtime logs
└── soul/                # Bot personality files
    ├── ClaudeBot/
    ├── CodexBot/
    └── ...              # One directory per Bot
```

## Troubleshooting

### Common Issues

**Gateway won't start**
- Check `imtoagent status` for details
- Verify config with `cat ~/.imtoagent/config.json`
- Check logs: `cat ~/.imtoagent/logs/*.log`

**Setup wizard stuck**
- Ensure terminal supports interactive input
- Try running in a standard terminal (not IDE integrated)

**Bot not responding in IM**
- Verify credentials in config.json
- Check IM platform permissions (Feishu events, Telegram webhook, etc.)
- Ensure the gateway is running: `imtoagent status`

**Port 18899 already in use**
- Another service is using the proxy port
- Kill the existing process or change port in config

### Getting Help

- Check logs: `~/.imtoagent/logs/`
- Run `imtoagent status` for runtime information
- Open an issue on GitHub with logs attached
```

## Development

```bash
# Clone and setup development environment
git clone https://github.com/imtoagent/imtoagent.git
cd imtoagent
bun install

# Run directly
bun run index.ts

# Run setup wizard
bun run bin/imtoagent setup

# Run CLI from source
bun run bin/imtoagent status
```

## License

MIT
