# imtoagent — Agent 操作手册

当需要操作 imtoagent 网关、管理定时任务、查看系统健康状态、使用 Goal 系统或了解 IM 消息能力时，按需加载对应子模块。

## 快速索引

| 需求 | 加载文件 |
|------|---------|
| 添加/删除/查看定时任务 | `references/cron.md` |
| 创建/管理 Goal | `references/goal.md` |
| 检查网关健康、看日志、重启 | `references/health.md` |
| 发文件/图片/按钮/卡片 | `references/im-capabilities.md` |

## 环境速查

- HEARTBEAT.md 路径：`~/.openclaw/workspace/HEARTBEAT.md`
- 网关端口：18899
- 日志路径：`~/.imtoagent/logs/imtoagent.log`
- 项目源码：`/Users/keyi/Desktop/imtoagent`（开发机）

## 脚本

| 脚本 | 用途 |
|------|------|
| `bash scripts/task.sh list` | 列出所有定时任务 |
| `bash scripts/task.sh add <name> --type once --at ... --prompt ...` | 添加定时任务 |
| `bash scripts/task.sh remove <name>` | 删除定时任务 |
| `bash scripts/health-check.sh` | 一键健康检查 |
| `bash scripts/restart.sh` | 安全重启（含警告） |
