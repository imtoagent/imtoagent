# HEARTBEAT.md 路径说明

## 正确路径

HEARTBEAT.md 位于每个 bot 的 **workspace 目录下**：

```
<workspace-root>/workspaces/<bot-id>/HEARTBEAT.md
```

其中 `<workspace-root>` 通过 `workspaceManager.getWorkspacePath()` 解析（生产环境通常是 `~/.imtoagent/` 或项目下的 `workspaces/` 目录）。

## ⚠️ 常见误区

- `~/.imtoagent/tasks/HEARTBEAT.md` — **错误路径**，不存在
- `~/.imtoagent/HEARTBEAT.md` — **错误路径**，不存在
- 不要手动在 `~/.imtoagent/` 下创建 `tasks/` 目录或 HEARTBEAT.md

## 如何正确读写

1. 通过 `workspaceManager.getWorkspacePath()` 获取 bot 的 workspace 路径
2. 拼接 `workspaces/<bot-id>/HEARTBEAT.md`
3. 或直接查看已存在的 workspace 目录

## 创建时机

HEARTBEAT.md 由 bot 初始化时通过 `workspaceManager.ensureWorkspace()` 自动创建。正常情况下无需手动创建。
