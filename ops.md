# IMtoAgent 运维手册

## 启动方式

### 推荐：CLI 内置命令

| 命令 | 说明 |
|---|---|
| `imtoagent start` | 后台启动（spawn 子进程 + 写 PID 文件 + 父进程退出） |
| `imtoagent run` | 前台运行（调试用） |
| `imtoagent daemon` | 守护进程模式（自带健康检查 + 自动重启） |
| `imtoagent stop` | 停止运行中的实例 |

### daemon 模式（生产推荐）

```bash
imtoagent daemon
```

- 自动写 PID 文件到 `~/.imtoagent/daemon.pid`
- 自带健康检查：每 30s 探测 HTTP 端口，连续 3 次失败自动重启
- 崩溃自动重启（最多连续重启 5 次）
- 日志输出到 `~/.imtoagent/logs/daemon.log`

### 旧方式（不推荐）

```bash
# 旧写法，已废弃
nohup bun src/index.ts > /dev/null 2>&1 &
echo $! > ~/.imtoagent/imtoagent.pid
```

## 优雅重启

### 方式一：imtoagent reload（推荐）

```bash
imtoagent reload
```

- 发送 `SIGHUP` 信号给当前进程
- 等待旧进程优雅关闭（最长 5s）
- 自动启动新实例
- 零停机：旧实例先接受完正在处理的请求再退出

### 方式二：手动 SIGHUP

```bash
kill -HUP $(cat ~/.imtoagent/daemon.pid)
```

效果同上，适合 reload 命令不可用时。

### 旧方式（不推荐）

```bash
# 旧写法：写信号文件 + 轮询检测
echo "restart" > ~/.imtoagent/signal
# 需要进程轮询检测文件变化，已废弃
```

## Exit Code 含义

| Exit Code | 含义 |
|---|---|
| 0 | 正常退出 |
| 1 | 通用错误（配置错误、端口占用等） |
| 42 | 热重载退出——旧实例收到 SIGHUP 后，新实例已启动，旧实例安全退出 |

> **注意**：daemon 模式看到 exit code 42 **不是崩溃**，是正常的优雅重载流程。daemon 不会将其计入重启失败次数。

## 常用运维命令

```bash
# 查看运行状态
imtoagent status

# 查看日志（daemon 模式）
tail -f ~/.imtoagent/logs/daemon.log

# 查看 PID
cat ~/.imtoagent/daemon.pid

# 检查端口
lsof -i :18899

# 强制停止（优雅重启失败时）
kill $(cat ~/.imtoagent/daemon.pid)
rm -f ~/.imtoagent/daemon.pid
```

## 版本升级流程

```bash
# 1. 更新
npm install -g imtoagent

# 2. 确认版本
imtoagent --version

# 3. 优雅重启
imtoagent reload
```

## 端口

- 统一端口：`:18899`（Anthropic Proxy）
- Claude 和 Codex 均走此端口
