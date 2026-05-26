# Quick Start

Get IMtoAgent running in 5 minutes.

## Step 1: Install

```bash
curl -fsSL https://imtoagent.pages.dev/install.sh | bash
```

Or via npm:

```bash
npm install -g imtoagent
```

## Step 2: Setup

```bash
imtoagent setup
```

The wizard guides you through:

1. **Select IM platform** — Feishu / Telegram / WeChat / WeCom
2. **Enter Bot credentials** — App ID/Secret, Token, etc.
3. **Choose Agent backend** — Claude Code / Codex / OpenCode
4. **Configure model providers** — API keys
5. **Generate soul files** — Bot personality

## Step 3: Start

```bash
imtoagent start
```

Verify:

```bash
imtoagent status
```

## Step 4: Test

Send `/help` to your bot in the IM. You should see the command list.

## What Just Happened?

```
~/.imtoagent/
├── config.json       ← Your Bot + provider settings
├── providers.json    ← API keys for model providers
└── soul/<BotName>/   ← Personality files
    ├── rules.md
    ├── identity.md
    └── profile.md
```

## Next

- [Configuration](guide/configuration.md) — Detailed config options
- [CLI Reference](cli/README.md) — All commands
- [Architecture](architecture/README.md) — How it works inside
