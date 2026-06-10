# IMtoAgent 技术债清单

> 整理时间：2026-06-10

---

## T0 — 架构级（影响可扩展性，必须修）

### 1. `isLocalTool` 硬编码 6 处

**问题：** 本地工具判断硬编码前缀匹配（`imtoagent_`、`goal_`、`get_weather`），散落在 6 个文件中。新工具不满足前缀约定的话，能被 discovery 注册但不会被拦截执行。

**位置：**
- `proxy/tool-interceptor.ts` — 导出，被 codex-proxy 使用
- `proxy/tool-call-loop.ts` — 本地函数
- `proxy/codex-proxy.ts` — 从 tool-interceptor 导入
- `agent/agent-loop.ts` — 本地函数
- `agent/claude-adapter.ts` — 本地函数
- `agent/gemini-adapter.ts` — 本地函数

**根因：** 两套 tool_call 处理链路（OpenAI 链路 + Agent 链路），各自写了自己的判断；历史分叉没有收敛。

**方案：** 统一用 `ToolRegistry.isRegistered(name)` 判断。OpenAI 链路传 registry 实例；Agent 链路改 `AgentToolSupport.extractToolCalls` 接口签名，注入 registry。

**影响：** 改动不到 20 行，6 处 → 1 处。修复后新工具零配置自动拦截。

**设计文档：** `docs/plans/tool-discovery-refactor-design.md`

---

### 2. `AgentToolSupport.extractToolCalls` 接口缺失 registry 注入

**问题：** `AgentToolSupport` 接口（agent-loop.ts）定义了 `extractToolCalls(output)` 和 `appendToolResults(...)`，但没有传入 `toolRegistry` 的能力。导致 adapter 的闭包里访问不到 registry，只能硬编码。

**位置：** `agent/agent-loop.ts` + `agent/claude-adapter.ts` + `agent/gemini-adapter.ts`

**方案：** 接口升级为 `extractToolCalls(output, registry: ToolRegistry)`。

**关联：** 与 #1 同步修复。

---

### 3. `isRegistered` 不处理别名

**问题：** `tool-registry.ts` 有别名表（`imtoagent_remove_goal` → `imtoagent_delete_goal`），但 `isRegistered()` 只做精确匹配，别名工具无法被识别。

**位置：** `agent/tool-registry.ts`

**方案：** `isRegistered(name)` 内部先 `resolveToolName(name)`，再判断。

**关联：** 与 #1 同步修复。

---

## T1 — 设计级（影响可维护性，应该修）

### 4. tool-interceptor 和 tool-call-loop 功能重叠 ✅ 已修复

**问题：** ~~两个文件都做 tool_call 拦截 + 本地/远端分类 + 执行。~~

**修复（2026-06-10）：** `tool-call-loop.ts` 已改为复用 `tool-interceptor.ts` 的 `parseToolCalls` / `executeLocalTools` / `generateRemotePlaceholders` / `buildToolMessages`，消除了重复的分类/执行/超时逻辑。

**剩余职责划分：**
- `tool-interceptor.ts` — 工具解析、分类判断、执行、Hook 触发（纯函数库）
- `tool-call-loop.ts` — HTTP 循环调用上游 LLM + 调用 interceptor 函数（loop 编排）
- `codex-proxy.ts` — SSE 流解析 + 多轮递归处理（独立场景，不宜合并）

---

### 5. 模块边界不清 ✅ 部分修复

**问题：** Hook 触发只在 tool-interceptor 的 executeLocalTools，Agent Loop 不触发 Hook。

**修复（2026-06-10）：** Agent Loop 现在也触发 before_tool_call / after_tool_call hook，两条链路 Hook 行为一致。

---

### 6. 配置管理双系统并存 ✅ 已确认安全

**状态：** providers.json 已废弃，残留引用仅限于迁移代码（正确行为：旧用户首次启动时自动迁移）。
- `config-migration.ts` — 迁移逻辑，迁移后重命名为 `.migrated`
- `paths.ts` — `getProvidersPath()` 已标记 `@deprecated`
- 运行时不再读写 providers.json，无功能影响

---

## T2 — 代码质量（应该改善，不阻塞功能）

### 7. injectNeeded 注释不准确 ✅ 非问题

**状态：** `injectNeeded()` 不是临时方案，是有意的 token 优化设计——按需注入避免每次聊天都带所有工具定义（节省 ~500-1000 token/轮）。无需修复。

---

### 8. 代理层 TODO（混合工具场景）✅ 已记录

**TODO 位置：** `proxy/codex-proxy.ts` 第 1550 行

**内容：** 当本地+远端工具同时存在时，当前只返回远端 tool_calls 给客户端，本地工具未执行。

**评估：** 这是一个边界场景优化，实现需要异步协调（本地执行 + 等待远端结果 + 合并返回）。当前行为不会崩溃，只是多一轮往返。标记为已知限制，暂不修复。

---

### 9. 魔法数字散落

**问题：** `TOOL_EXEC_TIMEOUT_MS = 30_000`、`MAX_LOOPS = 10`、`ERROR_COOLDOWN_MS = 30_000` 等硬编码数字散落在多个文件中，没有统一管理。

**位置：** 多个文件

---

### 10. 错误处理不统一

**问题：** 各模块的错误处理策略不同：有的 try/catch 返回错误字符串，有的 throw，有的静默吞掉。没有统一的错误码/错误级别体系。

**位置：** 全局问题

---

## T3 — 优化级（可缓）

### 11. 上下文压缩（context-manager）逻辑复杂

**问题：** Layer 1 精简 + Layer 2 MicroCompact + 去重 + 过期清理，逻辑耦合在一起。新工具加字段类型时需要理解整条链路。

**位置：** `proxy/context-manager.ts`（1000+ 行）

---

### 12. 心跳调度器状态机复杂

**问题：** `heartbeat-scheduler.ts` 和 `heartbeat-scheduler.ts` 的状态管理（状态机 + 文件原子读写 + 任务解析）耦合在一起，调试困难。

**位置：** `core/heartbeat-scheduler.ts`

---

### 13. 日志系统无统一格式

**问题：** 有的用 `console.log`，有的用 `console.error`，格式不统一。`usage-logger.ts` 是独立的，但 tool 执行日志没有统一结构。

---

## 优先级建议

| 优先级 | 项目 | 工作量 | 收益 |
|---|---|---|---|
| **P0** | #1 #2 #3 isLocalTool 统一 | 小（<20行） | ✅ 完成 |
| **P1** | #4 tool-interceptor 统一 | 中 | ✅ 完成 |
| **P1** | #5 模块边界清理 | 中 | ✅ 完成（Hook 统一） |
| **P2** | #6 配置管理清理 | 小 | ✅ 已确认安全 |
| **P2** | #7 #8 临时方案清理 | 小 | 中：减少技术债积累 |
| **P3** | #9-#13 代码质量 | 中-大 | 长期收益 |
