# Phase 8: 可观测性 — 补完计划

> 创建时间: 2026-06-02
> 状态: 模块已存在，集成待补完

---

## 现状审计（2026-06-02）

### ✅ 已有模块（1465 行，全部完成）

| 模块 | 文件 | 行数 | 状态 |
|------|------|------|------|
| 结构化日志 | `modules/utils/logger.ts` | 255L | ✅ 完成 |
| 统计持久化 | `modules/core/stats-persist.ts` | 201L | ✅ 完成 |
| 统计 CLI | `modules/cli/stats.ts` | 205L | ✅ 完成 |
| 健康检查 CLI | `modules/cli/healthz.ts` | 87L | ✅ 完成 |
| 会话管理 CLI | `modules/cli/session-cli.ts` | 333L | ✅ 完成 |
| 断路器 | `modules/proxy/circuit-breaker.ts` | 177L | ✅ 完成 |
| 代理健康检查 | `modules/proxy/health-check.ts` | 207L | ✅ 完成 |

### ❌ 集成缺口

| 缺口 | 影响 | 优先级 |
|------|------|--------|
| Proxy 层无 logEvent | 代理请求/响应/错误无法追踪 | P0 |
| IM 适配器无 logEvent | 消息收发无法审计 | P0 |
| runtime.ts 仅 2 处 logEvent | 事件覆盖率太低 | P1 |

### ✅ 已集成

- runtime.ts: logEvent 调用 2 处（message_received, message_sent）
- runtime.ts: StatsPersist 集成（record 调用）
- anthropic-proxy.ts: **断路器 canRequest() 已调用**（~880 行），failover 已实现
- CLI: stats/session/healthz 命令已注册

---

## 补完任务

### P0-1: Proxy 层结构化日志 ✅ 已完成

已在 `anthropic-proxy.ts` 添加 8 个 logEvent 事件点：
- ✅ proxy_request（handleRequest 入口）
- ✅ proxy_upstream_request（fetch 前）
- ✅ proxy_upstream_response（响应完成）
- ✅ proxy_upstream_error（上游错误 + timeout）
- ✅ proxy_sse_start / proxy_sse_end（SSE 流）
- ✅ proxy_circuit_open（断路器拦截）
- ✅ proxy_codex_request（Codex 请求）

**改动**: anthropic-proxy.ts +8 行 import + 8 处 logEvent，logger.ts +12 事件类型

### P0-2: IM 适配器结构化日志 ✅ 已完成

4 个 IM 适配器全部添加 logEvent：
- ✅ feishu.ts: im_message_received + im_message_sent + im_send_error
- ✅ telegram.ts: im_message_received + im_message_sent + im_send_error
- ✅ wecom.ts: im_message_received + im_message_sent + im_send_error
- ✅ wechat.ts: im_message_received + im_message_sent + im_send_error

### P1-1: runtime.ts 事件扩大（~15 行）

补充 session_create、session_destroy、error、config_change 事件。

---

## 验收标准

1. `events.jsonl` 包含 proxy 请求/响应/错误事件
2. IM 消息收发可审计
3. 断路器开路时被拦截并记录
4. 所有现有测试通过
