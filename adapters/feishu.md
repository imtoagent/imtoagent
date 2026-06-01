# Feishu Adapter

## Connection

WebSocket persistent connection with automatic reconnection.

## Setup

1. Create a Feishu app in [Feishu Open Platform](https://open.feishu.cn/)
2. Enable **Bot** capability
3. Enable **Event Subscription**
4. Grant permissions: `im:message:send_as_bot`, `im:message`, `im:chat`
5. Get **App ID** (`cli_...`) and **App Secret**

## Capabilities

| Feature | Supported |
|---------|-----------|
| Text | ✅ |
| Code blocks | ✅ |
| Interactive cards | ✅ |
| File send | ✅ |
| Image send | ✅ |
| Audio/Voice | ✅ |
| Buttons | ✅ |
