# imtoagent Skill 规划

**Status**: ✅ DONE (2026-06-03)

## 概述

创建系统级 Skill `imtoagent`，随项目分发。Agent 加载后即可丝滑使用全部能力，无需阅读源码或积累经验。

## 实现内容

| 模块 | 文件 | 状态 |
|------|------|------|
| 入口 | `skills/imtoagent/SKILL.md` | ✅ |
| 定时任务 | `references/cron.md` + `scripts/task.sh` | ✅ |
| Goal 系统 | `references/goal.md` | ✅ |
| 健康检查 | `references/health.md` + `scripts/health-check.sh` | ✅ |
| IM 能力 | `references/im-capabilities.md` | ✅ |
| 安全重启 | `scripts/restart.sh` | ✅ |
| 自动分发 | `scripts/distribute.sh` | ✅ |

## 与旧 Skill 的关系

- `imtoagent-cron` → 已废弃并移除（`npx skills remove imtoagent-cron -g`）

## 分发机制

方案 A：gateway 启动时自动安装到 `~/.agents/skills/imtoagent/`（已实现于 `distribute.sh`）
