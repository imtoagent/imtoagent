# Logger Phase 1 落地规划

## 现状

- `modules/utils/logger.ts` 已存在，有 JSONL + 轮转能力
- **缺失**：日志分级（debug/info/warn/error）、人类可读日志文件、统一 console 替换
- 全项目 962 处 `console.log/error/warn`，分散在 50+ 文件

## 改动

### 1. 升级 `modules/utils/logger.ts`

现有 `logEvent()` 只写 JSONL，需要加：

```ts
// 新增分级 API
export const logger = {
  debug(module: string, msg: string, meta?: object): void
  info(module: string, msg: string, meta?: object): void
  warn(module: string, msg: string, meta?: object): void
  error(module: string, msg: string, meta?: object, err?: Error): void
}

// 输出目标
//   ~/.imtoagent/logs/events.jsonl     — JSONL（已有）
//   ~/.imtoagent/logs/imtoagent.log    — 纯文本分级日志（新增）
//   stdout/stderr                      — 保持兼容
```

### 2. 替换策略

**不一次性替换全部 962 处**。按影响范围分批：

**Batch A（核心运行时，最高优先）**
- `modules/proxy/codex-proxy.ts` (59)
- `modules/proxy/anthropic-proxy.ts` (42)
- `modules/core/heartbeat-scheduler.ts` (36)
- `modules/core/heartbeat.ts` (10)
- `modules/proxy/context-manager.ts` (9)
- `modules/proxy/tool-call-loop.ts` (12)

**Batch B（IM 适配器）**
- `modules/im/feishu.ts` (36)
- `modules/im/telegram.ts` (11)

**Batch C（CLI 工具，可后续）**
- `modules/cli/*.ts` (~400+，不影响运行时）

### 3. 不改动
- CLI 模块暂不替换（不影响运行时行为）
- 不改现有 JSONL 格式（向下兼容）
- 不改 `usage-logger.ts`（独立功能）

## 子 Agent 分工

| Agent | 任务 | 文件 |
|---|---|---|
| Agent 1 | 升级 logger.ts | `modules/utils/logger.ts` |
| Agent 2 | Batch A: proxy 模块 | codex-proxy, anthropic-proxy, context-manager, tool-call-loop |
| Agent 3 | Batch A: core + IM | heartbeat-scheduler, heartbeat, feishu, telegram |

每个 Agent 完成后同步 DEV→PROD 并验证 md5。
