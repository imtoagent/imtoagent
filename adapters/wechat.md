# WeChat Adapter

## Connection

iLink HTTP long-poll with QR code authentication.

## Setup

1. Start the gateway for the first time
2. A QR code appears in the terminal/logs
3. Scan with your personal WeChat on phone
4. Complete the binding

## Capabilities

| Feature | Supported |
|---------|-----------|
| Text | ✅ |
| Image send | ✅ |
| File send | ✅ |
| Voice send | ✅ |

> Media is encrypted with AES-128-ECB.

## WeCom Adapter

Enterprise WeChat uses HTTP Webhook callback + REST API. Supports text, files, and images.
