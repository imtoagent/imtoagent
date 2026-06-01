# CLI Reference

## Gateway Commands

| Command | Description |
|---------|-------------|
| `imtoagent start` | Start gateway in background (terminal returns immediately) |
| `imtoagent stop` | Stop gateway (SIGTERM → wait → SIGKILL fallback) |
| `imtoagent status` | Check running status (process + config + log size) |
| `imtoagent restore` | Hot reload recovery (send SIGHUP) |
| `imtoagent setup` | Interactive configuration wizard |
| `imtoagent daemon` | Foreground daemon (auto-restart on crash) |

## Running Modes

| Mode | Behavior |
|------|----------|
| `start` | Background, terminal returns, execSync + 3s verify |
| `run` | Foreground, real-time logs via Bun.spawn, Ctrl+C to stop |
| `daemon` | Foreground with auto-restart on crash, normal exit doesn't restart |

## Bot Commands (in IM chat)

Send these to your bot in the IM:

| Command | Description |
|---------|-------------|
| `/help` | Show available commands |
| `/status` | Gateway status |
| `/info` | Bot information |
| `/stats` | Usage statistics |
| `/model` | Switch AI model |
| `/providers` | View model providers |
| `/clear` | Clear conversation session |
| `/mode` | Switch mode (permission/auto/plan) |
| `/dir` | Switch working directory |
| `/memory` | Memory status |
| `/soul` | Soul management |
| `/reload` | Reload configuration |

Unknown commands are matched with fuzzy matching (Levenshtein ≤ 2).
