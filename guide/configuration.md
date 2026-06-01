# Configuration

## Data Directory

All runtime data lives in `~/.imtoagent/`:

```
~/.imtoagent/
├── config.json       # Main config (Bots + providers + system)
├── providers.json    # Model provider credentials
├── opencode.json     # OpenCode-specific config
├── sessions/         # Conversation persistence
├── logs/             # Runtime logs
└── soul/             # Bot personality files
```

## config.json

```json
{
  "bots": [
    {
      "name": "ClaudeBot",
      "im": "feishu",
      "agent": "claude",
      "feishuAppId": "cli_xxx",
      "feishuAppSecret": "xxx",
      "activeModel": "claude-sonnet-4-20250514",
      "modelAliases": ["sonnet", "claude"],
      "modelPresets": {}
    }
  ],
  "providers": [
    {
      "name": "Dashscope",
      "baseUrl": "https://dashscope.aliyuncs.com/compatible-mode/v1",
      "apiKey": "sk-xxx",
      "models": ["qwen-max", "qwen-plus"]
    }
  ]
}
```

## Soul Files

Each bot gets a `soul/<BotName>/` directory:

| File | Purpose |
|------|---------|
| `rules.md` | Behavioral rules and constraints |
| `identity.md` | Bot identity and role |
| `profile.md` | Skills and capabilities |
| `workspace.md` | Working directory context |
| `skills.md` | Available skills documentation |

Soul files are injected into the Agent system prompt along with IM capabilities.

## Hot Reload

After editing config or soul files:

```bash
imtoagent restore
```

No full restart needed. Or use `/reload` in the IM chat.
