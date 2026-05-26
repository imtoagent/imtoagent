# Installation

## Prerequisites

- **macOS** (Apple Silicon / Intel) or **Linux**
- **Node.js** ≥ 18 (will be auto-installed if missing)
- **Bun** runtime (will be auto-installed if missing)
- At least one **Agent backend** installed

### Agent Backends

| Backend | Install Command |
|---------|----------------|
| Claude Code | `npm install -g @anthropic-ai/claude-agent-sdk` |
| Codex | `npm install -g @openai/codex` |
| OpenCode | `npm install -g opencode` |

You can install backends before or after IMtoAgent.

## Method 1: One-Click Install (Recommended)

```bash
curl -fsSL https://imtoagent.pages.dev/install.sh | bash
```

The script:
1. Detects your OS and environment
2. Installs Bun if missing
3. Installs Node.js if missing (Homebrew / nvm fallback)
4. Installs or upgrades IMtoAgent
5. Runs the setup wizard if no config exists
6. Starts the gateway

**Flags:** `--non-interactive`, `--skip-bun`, `--skip-start`

## Method 2: npm Global Install

```bash
npm install -g imtoagent
imtoagent setup
```

## Method 3: Source Install

```bash
git clone https://github.com/imtoagent/imtoagent.git
cd imtoagent
bun install
bun run bin/imtoagent setup
```

Use this for development or if you want to modify the source code.
