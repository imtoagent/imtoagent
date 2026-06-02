# Heartbeat — 心跳与定时任务

## 概述

心跳（Heartbeat）是 IMtoAgent 内置的自动检查机制。配置后，Bot 会按固定间隔自动唤醒，读取 `HEARTBEAT.md` 中的任务清单，逐项执行或检查，然后汇报结果。

所有任务完成后如果一切正常，Bot 回复 `HEARTBEAT_OK`——这条回复会被网关静默拦截，不会打扰你。只有发现问题或需要你关注时，才会真正发消息。

## 开箱即用

安装 IMtoAgent 并完成 setup 后，心跳**默认自动启用**：

- **间隔**：30 分钟
- **HEARTBEAT.md**：首次启动时自动创建在 Bot workspace 下
- **默认行为**：空任务清单 → Bot 回复 HEARTBEAT_OK → 静默拦截 → 不打扰

## 配置

### 全局默认（config.json system 级）

```json
{
  "system": {
    "heartbeat": {
      "enabled": true,
      "interval": "30m",
      "showAlerts": true,
      "showOk": false
    }
  }
}
```

| 字段 | 说明 | 默认值 |
|------|------|--------|
| `enabled` | 是否启用 | `true` |
| `interval` | 心跳间隔 | `"30m"` |
| `showAlerts` | 连续失败时是否发告警 | `true` |
| `showOk` | 是否显示 HEARTBEAT_OK（通常保持 false） | `false` |

### Bot 级覆盖（config.json bots 级）

每个 Bot 可以覆盖全局默认：

```json
{
  "bots": [
    {
      "name": "CodexBot",
      "heartbeat": {
        "interval": "15m",
        "visibility": { "showAlerts": true, "showOk": false }
      }
    }
  ]
}
```

Bot 级配置优先于 system 级配置。

### 禁用心跳

```json
// 全局禁用
{ "system": { "heartbeat": { "enabled": false } } }

// 单个 Bot 禁用
{ "bots": [{ "name": "BotA", "heartbeat": { "enabled": false } }] }
```

## HEARTBEAT.md 格式

每次心跳触发时，Bot 会读取 workspace 下的 `HEARTBEAT.md` 文件。

### 基本结构

```markdown
# HEARTBEAT.md — 心跳检查清单

## 任务

- [ ] 检查邮箱是否有未读邮件
- [ ] 查看今天日程安排
- [ ] 检查服务器磁盘使用率

## 规则

如果一切正常，回复 HEARTBEAT_OK
```

### 示例：邮箱检查

```markdown
## 任务

- 检查我的未读邮件，如果有重要邮件请摘要
```

### 示例：系统监控

```markdown
## 任务

- 检查 /var/log 目录占用是否超过 5GB
- 如果超过，列出最大的 5 个文件
```

## 工作原理

```
定时器触发（每 30 分钟）
  → 读取 HEARTBEAT.md
  → 发送给 Agent 执行
  → Agent 回复结果
    → HEARTBEAT_OK → 静默拦截 ✅
    → 其他内容 → 发送到 IM 💬
```

### Session 隔离

心跳消息使用独立的 session key（`BotName:heartbeat`），不会污染主对话上下文。你的日常对话和心跳检查完全隔离。

### 投递目标

心跳消息默认发送到**最后一次与 Bot 对话的聊天**。如果 Bot 从未收到过消息，则消息会被静默处理（session 内循环）。

### 告警机制

如果心跳连续失败（Agent 后端不可用等），默认超过 3 次会发送一次告警消息，告知你心跳异常。

## 间隔格式

支持以下格式：

| 格式 | 说明 |
|------|------|
| `5m` | 5 分钟 |
| `30m` | 30 分钟 |
| `1h` | 1 小时 |
| `2h30m` | 2 小时 30 分钟 |
| `15s` | 15 秒 |

## FAQ

**Q: 心跳会消耗 API 配额吗？**

会。每次心跳触发都会调用一次 Agent 后端。默认 30 分钟间隔下，每天约 48 次调用。建议根据实际需求和 API 配额调整间隔。

**Q: 如何让心跳完全不消耗配额？**

在 config.json 中设置 `"heartbeat": { "enabled": false }`。

**Q: HEARTBEAT.md 不存在怎么办？**

首次启动时会自动创建默认模板。如果误删，重启网关即可重新生成。

**Q: 心跳消息发到哪个聊天？**

最后一次与该 Bot 对话的聊天。如果 Bot 从未收到过消息，心跳会在后台静默运行（你收不到消息）。
