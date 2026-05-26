# WeCom (企业微信) Adapter

## Connection

WebSocket persistent connection via `@wecom/aibot-node-sdk` with automatic reconnection and QR code scanning for binding.

No corpId, agentId, HTTP callback, or public IP required.

## Setup

1. Run `imtoagent setup` and select **企业微信**
2. A QR code will be displayed in the terminal (or saved to `~/.imtoagent/wecom-qr.png`)
3. Scan with your enterprise WeChat app to bind the bot
4. Credentials are saved locally at `~/.imtoagent/wecom-creds.json`
5. The bot connects via WebSocket automatically

## Capabilities

| Feature | Supported |
|---------|-----------|
| Text | ✅ |
| File send | ✅ |
| Image send | ✅ |
