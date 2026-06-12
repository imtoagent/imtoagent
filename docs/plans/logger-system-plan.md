# Logger 体系重构规划

> 模仿 OpenClaw / Claude Code 的先进经验，为 imtoagent 建立结构化日志系统。

## 现状问题

- 单一 `~/.imtoagent/logs/imtoagent.log`（276KB+，纯文本）
- 没有日志分级（全是 `console.log` / `console.error`）
- 没有结构化（无法用工具分析）
- 没有日志轮转（无限增长）
- 没有错误快照（崩溃后无现场）
- 没有配置审计（配置变更不可追溯）

## CC 参考架构

| CC 文件 | 用途 | imtoagent 对应 |
|---|---|---|
| `gateway.log` | 正常运行日志 | `imtoagent.log` |
| `gateway.err.log` | 错误日志 | `imtoagent.err.log` |
| `config-audit.jsonl` | 配置变更审计 | `config-audit.jsonl` |
| `stability/*.json` | 启动失败快照 | `stability/crash-*.json` |
| `config-health.json` | 配置健康检查 | `config-health.json` |

## Phase 1：Logger 核心（新建）

**文件：** `modules/core/logger.ts`

### API
```ts
interface Logger {
  debug(module: string, msg: string, meta?: object): void
  info(module: string, msg: string, meta?: object): void
  warn(module: string, msg: string, meta?: object): void
  error(module: string, msg: string, meta?: object, err?: Error): void
}
```

### 输出目标
| 文件 | 格式 | 内容 |
|---|---|---|
| `~/.imtoagent/logs/imtoagent.log` | 纯文本 | info + warn + error（人类可读） |
| `~/.imtoagent/logs/imtoagent.err.log` | 纯文本 | error 专用（快速排查） |
| `~/.imtoagent/logs/events.jsonl` | JSONL 每行 | 全部级别（机器可分析） |

### JSONL 格式
```json
{
  "ts": "2026-06-12T06:00:00.000Z",
  "level": "info",
  "module": "proxy/codex-proxy",
  "msg": "Gateway started",
  "pid": 47445,
  "bot": "CodexBot"
}
```

### 日志分级
| Level | 用途 | 示例 |
|---|---|---|
| debug | 调试信息，生产默认关闭 | API 请求体、响应头 |
| info | 正常运行事件 | Bot 启动、心跳执行、配置重载 |
| warn | 可恢复的异常 | API 限流、配置字段缺失用默认值 |
| error | 不可恢复的错误 | 启动失败、API 401、数据库损坏 |

## Phase 2：日志轮转

- `imtoagent.log` ≤ 10MB，超限后压缩归档
- `imtoagent.log.1.gz`, `imtoagent.log.2.gz`（保留 5 个）
- `events.jsonl` 按日切（`events-2026-06-12.jsonl`）

## Phase 3：错误快照 + 配置审计

### 错误快照
`~/.imtoagent/stability/crash-<ISO-timestamp>.json`
- 进程信息（PID、Node 版本、uptime）
- 错误堆栈
- 最后 50 条日志
- 当前配置摘要

### 配置审计
`~/.imtoagent/logs/config-audit.jsonl`
- 配置写入事件（`config.write`）
- 配置读取事件（`config.read`）
- 包含变更前后 hash、修改者

### 配置健康检查
`~/.imtoagent/logs/config-health.json`
- 最后一次正常启动的配置 hash
- 用于检测配置是否被破坏

## 改动范围

| 文件 | 动作 |
|---|---|
| `modules/core/logger.ts` | **新建** |
| `modules/core/types.ts` | 导出 Logger 类型 |
| `modules/index.ts` | 初始化 logger |
| `modules/proxy/codex-proxy.ts` | 替换 console.* |
| `modules/proxy/anthropic-proxy.ts` | 替换 console.* |
| `modules/proxy/context-manager.ts` | 替换 console.* |
| `modules/proxy/usage-logger.ts` | 复用 logger |
| `modules/core/heartbeat.ts` | 替换 console.* |
| `modules/core/heartbeat-scheduler.ts` | 替换 console.* |
| `modules/im/feishu.ts` | 替换 console.* |
| `modules/bot-context.ts` | 替换 console.* |

## 不改的

- stdout 仍然输出（`npm run start` 可见）
- 不引入外部依赖（纯 fs 实现）
- 不改变 `imtoagent.log` 路径
- 不影响现有 `usage-logger` 独立功能

## 执行顺序

1. `modules/core/logger.ts` 新建 + 单元测试
2. `modules/index.ts` 初始化
3. 逐步替换各模块的 `console.*`
4. 同步生产环境 + 重启验证
5. Phase 2 + Phase 3 后续实施
