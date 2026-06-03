# Health — 健康检查 & 调试

## 快速健康检查

### 端口状态
```bash
lsof -i :18899    # imtoagent 网关（必须在线）
lsof -i :4096     # OpenCode 后端（仅当 OpenCode backend 启用时需要）
```

### 进程状态
```bash
ps aux | grep imtoagent   # 网关进程
ps aux | grep codex       # Codex CLI app-server（stdio 模式）
```

### CLI 版本
```bash
codex --version
```

### 一键检查
```bash
bash scripts/health-check.sh
```

输出示例：
```
=== imtoagent Health Check ===
[OK]   Port 18899: LISTEN (PID 84304, imtoagent)
[OK]   Port 4096:  not listening (OpenCode not running)
[OK]   imtoagent process: 1 running
[OK]   Codex CLI: v0.135.0
[OK]   Gateway log: exists, 12 total errors, 0 recent
[OK]   Bot: last online found, no disconnect detected
```

---

## 日志查看

网关日志路径：`~/.imtoagent/logs/imtoagent.log`

### 常用 grep

| 模式 | 命令 | 用途 |
|------|------|------|
| 重启/关停 | `grep -i "restart\|shutdown\|SIGTERM" ~/.imtoagent/logs/imtoagent.log \| tail -10` | 查服务重启记录 |
| 错误 | `grep -i "error\|fail\|crash" ~/.imtoagent/logs/imtoagent.log \| tail -10` | 查异常 |
| 上线/断线 | `grep -i "online\|connected\|disconnected" ~/.imtoagent/logs/imtoagent.log \| tail -10` | 查 Bot 连接状态 |
| 最近日志 | `tail -30 ~/.imtoagent/logs/imtoagent.log` | 快速扫一眼 |

---

## 安全重启

### ⚠️ 重启前必须确认

1. **识别服务**：是 imtoagent 网关？还是 Codex app-server？
2. **断连警告**：重启会断开当前 IM 会话
3. **确认后再执行**

### 手动流程

```bash
# 1. 查看状态
bash scripts/health-check.sh

# 2. 找到进程
ps aux | grep imtoagent | grep -v grep

# 3. SIGTERM（优雅退出）
kill <PID>

# 4. 等 3 秒
sleep 3

# 5. 验证释放
lsof -i :18899   # 应无输出

# 6. 重新启动
# cd /Users/keyi/Desktop/imtoagent && bun run start

# 7. 验证恢复
lsof -i :18899   # 应重新 LISTEN
```

### 一键重启

```bash
bash scripts/restart.sh
```

会显示当前状态 → 警告断连 → 等待确认 → 执行重启 → 验证恢复。

`--force` 跳过确认：
```bash
bash scripts/restart.sh --force
```

---

## 常见问题

| 问题 | 症状 | 排查 | 解决 |
|------|------|------|------|
| 端口占用 | EADDRINUSE | `lsof -i :18899` | `kill <PID>` |
| CLI 版本不匹配 | agent 异常/缺工具 | `codex --version` | `npm install -g @openai/codex@latest` |
| 模型不可达 | 超时/报错 | `tail -20 log \| grep model` | 检查 provider 配置 |
| Circuit Breaker OPEN | 全部 503 | `grep CIRCUIT log \| tail -5` | 等 30 秒自动恢复 |

### Codex CLI 升级

```bash
npm install -g @openai/codex@latest
```

⚠️ 升级后需重启 imtoagent 网关（会断当前连接！）。

---

## 环境速查

| 项目 | 值 |
|------|----|
| 网关端口 | 18899 |
| OpenCode 端口 | 4096（按需） |
| 日志路径 | `~/.imtoagent/logs/imtoagent.log` |
| HEARTBEAT.md | `~/.openclaw/workspace/HEARTBEAT.md` |
| 项目源码 | `/Users/keyi/Desktop/imtoagent` |
| Codex CLI 安装 | `npm install -g @openai/codex@latest`（不是 Homebrew） |
