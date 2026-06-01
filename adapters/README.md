# IM Adapters

IMtoAgent supports 4 IM platforms out of the box.

| Adapter | Connection | Capabilities |
|---------|------------|--------------|
| **Feishu** | WebSocket persistent + auto-reconnect | Text, code blocks, cards, files, images, voice, buttons |
| **Telegram** | Long polling + HTTP proxy | Text, files, images, voice |
| **Personal WeChat** | iLink HTTP long-poll + QR scan | Text, images, files, voice (AES-128-ECB) |
| **WeCom** | HTTP Webhook callback + REST API | Text, files, images |

## Registry Pattern

New IM adapters are registered with one line, no changes to the Bot constructor:

```typescript
registerIM("feishu", feishuFactory);
registerIM("telegram", telegramFactory);
```

## Capability Declaration

Each adapter declares what it supports via `getCapabilities()`. The Agent automatically adjusts output format.

```typescript
interface IMCapabilities {
  supportsCodeBlock: boolean;
  supportsCardMessage: boolean;
  supportsFileSend: boolean;
  supportsImageSend: boolean;
  supportsAudioSend: boolean;
  supportsButtonAction: boolean;
}
```
