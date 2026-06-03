# Goal Engine 技术方案

> 状态: V2.3 — 评审修订版 | 日期: 2026-06-03

---

## 〇、与现有 TaskSystem 的复用关系

> 评审意见 C1：不能只有概念图，必须有代码级复用决策。

现有 TaskSystem（HEARTBEAT.md cron 任务）已完成 Phase 0-4，以下组件**直接 import 复用**，不重新实现：

| 现有组件 | 文件 | 复用方式 | 用途 |
|---------|------|---------|------|
| 到期检测 | `heartbeat.ts:isTaskDue()` | 直接 import，适配 Goal 的 `nextRunAt` 字段 | Goal 到期判断 |
| 任务链执行 | `task-poller.ts:executeChain()` | 直接 import，最多 5 层链 | Goal `tool_chain` 复用相同链框架 |
| 执行计时 | `types.ts:TaskRunState.elapsedMs` | 直接 import 类型 | Goal 执行时间追踪 |
| 历史持久化 | `task-manager.ts:writeHistory()` | 直接 import，写入 `goals_history.json` | Goal 执行历史记录 |
| 超时 abort | `codex-adapter.ts:cancelSignal` | 直接 import | Agent 执行超时控制 |
| DJB2 相位分散 | `heartbeat.ts:djb2Phase()` | 直接 import | 避免多 Goal 同时执行 |

**唯一必须新建的核心模块**：`GoalStore`（Goal 数据结构与 `ScheduledTask` 不同，无法复用 `TaskManager` 的存储层）。

### goal-engine.ts 的 import 关系

```typescript
// ---- 复用现有 TaskSystem 组件（不重新实现） ----
import { isTaskDue } from './heartbeat';              // 到期检测
import { executeChain } from './task-poller';          // 任务链
import { writeHistory } from './task-manager';          // 历史持久化
import { cancelSignal } from '../agent/codex-adapter'; // 超时控制
import { djb2Phase } from './heartbeat';               // 相位分散

// ---- 新建：Goal 专属数据结构与持久化 ----
import { GoalStore } from './goal-store';
import { Goal, GoalCondition } from './goal-types';
import { ToolRegistry } from '../agent/tool-registry';
```

### 复用决策原则

- ✅ **复用**：到期检测逻辑、链执行框架、历史写入、超时控制（通用基础能力，Goal 和 ScheduledTask 共享）
- 🆕 **新建**：GoalStore（数据结构差异）、ToolRegistry（新能力）、Goal 解析（新能力）
- ❌ **不修改**：TaskSystem 内部不添加 Goal 特定逻辑（Goal Engine 作为叠加层）

---

## 一、问题定义

### 1.1 场景

用户通过 IM 发来包含**条件 + 时间 + 动作**的意图，例如：

| 用户输入 | 意图模式 |
|---------|---------|
| "1点下雨提醒我带伞" | time + external_condition → action |
| "每天早上9点发今日待办" | cron → action |
| "CPU 超过 80% 告警" | event_condition → action |
| "每周五下午整理本周会议纪要" | cron + tool_chain → action |
| "磁盘快满了告诉我" | threshold_condition → action |

### 1.2 核心问题

IMtoAgent 目前是**被动响应**系统：用户发消息 → Agent 回复。缺少以下通用能力：

1. **意图理解** — 从自然语言中提取结构化目标
2. **目标持久化** — 目标跨会话存活，不因重启丢失
3. **条件触发** — 在条件满足时自动唤醒执行（不限于 cron）
4. **外部工具** — 框架级 Tool 扩展机制，支持天气/监控/API 等
5. **主动推送** — 执行结果主动发送到 IM
6. **生命周期** — 一次性/周期性任务的自动管理

### 1.3 这不是功能需求，是框架能力

不绑定任何具体场景。Goal Engine 是通用基础设施，具体意图由 Agent + Tools 实现。

---

## 二、架构总览

```
                        ┌──────────────────┐
  用户 IM 消息          │   意图解析层      │
  "1点下雨提醒带伞" ──▶ │  (Agent 自解析)   │
                        └────────┬─────────┘
                                 │ Goal JSON
                                 ▼
                        ┌──────────────────┐
                        │   Goal Store      │
                        │   (goals.json)    │
                        │   持久化目标库     │
                        └────────┬─────────┘
                                 │ 心跳读取到期 Goal
                                 ▼
                        ┌──────────────────┐
                        │  Heartbeat Engine │
                        │  + Condition Eval │
                        │  + Tool Dispatch  │
                        └────────┬─────────┘
                                 │ 条件满足
                                 ▼
                        ┌──────────────────┐
                        │  Agent + Tools    │
                        │  (天气/监控/API)  │
                        └────────┬─────────┘
                                 │ 执行结果
                                 ▼
                        ┌──────────────────┐
                        │  IM Output        │
                        │  (主动推送消息)    │
                        └──────────────────┘
```

### 模块关系

```
goal-engine/
├── goal-store.ts          # Goal CRUD + 持久化
├── goal-engine.ts         # 引擎核心：到期检测 + 条件评估 + 分发
├── goal-types.ts          # Goal 类型定义
└── goal-parser.ts         # 意图解析 prompt 模板
```

---

## 三、核心数据结构

### 3.1 Goal 类型定义

```typescript
// types/goal.ts

/** 触发器类型 */
type TriggerType = 'time' | 'cron' | 'interval' | 'event';

/** 条件类型 */
type ConditionType = 'weather' | 'system_metric' | 'api_check' | 'external_state' | 'none';

/** 动作类型 */
type ActionType = 'send_message' | 'run_tool' | 'tool_chain';

/** 生命周期状态 */
type GoalStatus = 'pending' | 'active' | 'done' | 'failed' | 'cancelled';

/** 重复策略 */
type RepeatStrategy = 'once' | 'hourly' | 'daily' | 'weekly' | 'custom';

interface Goal {
  /** 唯一标识 */
  id: string;

  /** 目标类型 */
  type: 'reminder' | 'conditional_reminder' | 'periodic_report' | 'monitor_alert' | 'one_shot';

  /** 触发器配置 */
  trigger: GoalTrigger;

  /** 条件配置（可选，无条件时为 none） */
  condition?: GoalCondition;

  /** 动作配置 */
  action: GoalAction;

  /** 生命周期 */
  lifecycle: GoalLifecycle;

  /** 元数据 */
  metadata: GoalMetadata;
}

interface GoalTrigger {
  type: TriggerType;
  /** 触发时间（time 类型）: "12:50" */
  time?: string;
  /** Cron 表达式（cron 类型）: "0 9 * * *" */
  cron?: string;
  /** 间隔秒数（interval 类型） */
  intervalSeconds?: number;
  /** 提前量（分钟），默认 10 */
  leadMinutes?: number;
}

interface GoalCondition {
  type: ConditionType;
  /** 条件参数，依类型不同 */
  params: Record<string, unknown>;
  /** 期望值 */
  expected: unknown;
  /** 比较运算符: eq / ne / gt / lt / gte / lte / contains */
  operator?: 'eq' | 'ne' | 'gt' | 'lt' | 'gte' | 'lte' | 'contains';
}

interface GoalAction {
  type: ActionType;
  /** send_message 时：消息内容 */
  content?: string;
  /** run_tool 时：工具名 + 参数 */
  tool?: string;
  toolParams?: Record<string, unknown>;
  /** tool_chain 时：工具调用链 */
  chain?: GoalAction[];
  /** 目标 chatId（默认最后活跃聊天） */
  target?: string;
}

interface GoalLifecycle {
  status: GoalStatus;
  repeat: RepeatStrategy;
  /** 自定义 cron（repeat=custom 时使用） */
  customCron?: string;
  /** 最大执行次数（once 时 =1，无限制时省略） */
  maxRuns?: number;
  /** 已执行次数 */
  runCount: number;
  createdAt: string;      // ISO 8601
  nextRunAt?: string;     // 下次执行时间
  lastRunAt?: string;     // 上次执行时间
  lastError?: string;     // 上次失败原因
  expiresAt?: string;     // 过期时间
}

interface GoalMetadata {
  createdBy: string;      // 用户 open_id 或 chat_id
  sourceChatId: string;   // 创建 Goal 时的聊天 ID
  rawInput: string;       // 用户原始输入
  tags?: string[];        // 标签，用于分类
  priority?: 'low' | 'normal' | 'high';
}
```

### 3.2 示例：带伞提醒

```json
{
  "id": "goal_a1b2c3d4",
  "type": "conditional_reminder",
  "trigger": {
    "type": "time",
    "time": "12:50",
    "leadMinutes": 10
  },
  "condition": {
    "type": "weather",
    "params": { "field": "rain", "location": "auto" },
    "expected": true,
    "operator": "eq"
  },
  "action": {
    "type": "send_message",
    "content": "老板，外面下雨了，出门记得带伞！☔"
  },
  "lifecycle": {
    "status": "pending",
    "repeat": "daily",
    "runCount": 0,
    "createdAt": "2026-06-03T10:00:00+08:00",
    "nextRunAt": "2026-06-03T12:50:00+08:00"
  },
  "metadata": {
    "createdBy": "user_open_id",
    "sourceChatId": "oc_xxx",
    "rawInput": "1点如果下雨提醒我带伞"
  }
}
```


### 3.3 冲突检测与去重

> 评审意见 C5：Goal 创建时检测重复，避免用户重复创建相同提醒。

```typescript
// GoalStore.add() 内
add(goal: Goal): { status: 'created'; id: string } | { status: 'duplicate'; existingId: string; existing: Goal } {
  // 检查是否有高度相似的活跃 goal（同 trigger + 同 condition + 同 action + 同创建者）
  const duplicate = Array.from(this.goals.values()).find(g =>
    g.lifecycle.status !== 'done' &&
    g.lifecycle.status !== 'cancelled' &&
    g.trigger.type === goal.trigger.type &&
    g.trigger.time === goal.trigger.time &&
    g.trigger.cron === goal.trigger.cron &&
    JSON.stringify(g.condition) === JSON.stringify(goal.condition) &&
    JSON.stringify(g.action) === JSON.stringify(goal.action) &&
    g.metadata.createdBy === goal.metadata.createdBy
  );

  if (duplicate) {
    return { status: 'duplicate', existingId: duplicate.id, existing: duplicate };
  }

  // 正常创建
  this.goals.set(goal.id, goal);
  this.persist();
  return { status: 'created', id: goal.id };
}
```

用户会收到回复：*"你已经有这个提醒了，不需要重复创建 ☔"*

---

## 四、模块设计

### 4.1 Goal Store — 持久化层

```
文件: modules/core/goal-store.ts
路径: ~/.imtoagent/goals.json
```

**选型理由**: JSON 文件 — Goal 数量小（<100），实现简单，可直接 cat 调试。

**接口**:

```typescript
interface IGoalStore {
  // 基础 CRUD
  add(goal: Goal): { status: 'created'; id: string } | { status: 'duplicate'; existingId: string; existing: Goal };
  get(id: string): Goal | null;
  update(id: string, patch: Partial<Goal>): void;
  delete(id: string): void;

  // 查询
  list(filter?: GoalFilter): Goal[];
  getActive(): Goal[];                           // status != done/cancelled
  getDue(now: Date): Goal[];                    // nextRunAt <= now && status=pending/active
  getByTag(tag: string): Goal[];

  // 状态迁移
  markActive(id: string): void;
  markDone(id: string): void;
  markFailed(id: string, error: string): void;
  cancel(id: string): void;
  reschedule(id: string): void;                  // 计算 nextRunAt
}

interface GoalFilter {
  status?: GoalStatus | GoalStatus[];
  type?: string;
  tags?: string[];
  createdBy?: string;
}
```

**持久化格式**:

```json
{
  "version": 1,
  "updatedAt": "2026-06-03T12:00:00+08:00",
  "goals": {
    "goal_a1b2c3d4": { /* Goal 对象 */ },
    "goal_e5f6g7h8": { /* Goal 对象 */ }
  }
}
```

---

### 4.2 Heartbeat Engine 扩展 — 条件触发核心

```
文件: modules/core/heartbeat.ts（修改现有文件）
新增: modules/core/goal-engine.ts
```

**现有流程**:
```
HEARTBEAT.md cron tasks → Agent turn → HEARTBEAT_OK
```

**扩展后流程**:
```
心跳触发
  │
  ├─ 1. 读取 HEARTBEAT.md（现有，不变）
  │
  ├─ 2. NEW: 读取 Goal Store → getDue(now)
  │     │
  │     ├─ 无条件 goal → 直接构造 prompt 发给 Agent 执行
  │     │
  │     └─ 有条件 goal → 构造 prompt（含条件上下文）→ Agent 调 tool 判断
  │           │
  │           ├─ 条件满足 → 执行 action → markDone/Cancel
  │           └─ 条件不满足 → 跳过 → reschedule（如果是 periodic）
  │
  ├─ 3. 没有到期 goal → 现有 HEARTBEAT_OK 逻辑
  │
  └─ 4. 清理过期 goal（每 N 次心跳执行一次）
```

**Goal 执行 Prompt 模板**:

```
⚠️ 条件目标触发

目标 ID: {goal.id}
目标类型: {goal.type}
触发条件: {trigger 描述}
判断条件: {condition 描述}
执行动作: {action 描述}
原始输入: {metadata.rawInput}

请执行:
1. 如果需要判断条件，调用相应工具
2. 如果条件满足，执行动作
3. 完成后回复 GOAL_DONE: {goal.id} 或 GOAL_SKIP: {goal.id}（条件不满足时）
```

---

### 4.2.1 Tool 注入时机与生命周期

> 评审意见 C2：ToolRegistry 只定义了 tool 结构，没说清楚什么时候注入到 Agent、什么时候移除。

**设计原则**：按需注入，不常驻。用户正常聊天时不应该看到天气/监控等 Goal 专用 tool（节省每轮 ~500-1000 token）。

```
心跳触发
  │
  ├─ getDueGoals() → 无到期 goal → HEARTBEAT_OK（不注入任何 tool）
  │
  └─ getDueGoals() → 有到期 goal
        │
        ├─ 1. 收集到期 goal 所需的 tool 列表
        │      （如 goal1 需要 get_weather, goal2 需要 get_cpu_usage）
        │
        ├─ 2. 临时注入到本次执行的 Agent session
        │      toolRegistry.injectNeeded(neededToolNames)
        │
        ├─ 3. 调 Agent 执行（Agent 只看到本次需要的 tool）
        │      → 用户正常聊天 session 不受影响（不同 session，tool list 独立）
        │
        ├─ 4. 执行完成 → 解析 GOAL_DONE/GOAL_SKIP
        │
        └─ 5. 移除所有临时注入的 tool
               toolRegistry.removeInjected(neededToolNames)
               （finally 块确保清理，即使 Agent 执行出错）
```

**代码级实现**（在 `goal-engine.ts` 的执行流程中）：

```typescript
import { ToolRegistry } from '../agent/tool-registry';

async function executeDueGoals(now: Date): Promise<void> {
  const dueGoals = goalStore.getDue(now);
  if (dueGoals.length === 0) return;

  // 1. 收集所需 tool
  const neededToolNames = new Set<string>();
  for (const goal of dueGoals) {
    if (goal.condition?.type === 'weather') neededToolNames.add('get_weather');
    if (goal.condition?.type === 'system_metric') neededToolNames.add('get_system_metric');
    if (goal.action.type === 'run_tool' && goal.action.tool) {
      neededToolNames.add(goal.action.tool);
    }
    // tool_chain 中逐个收集
    if (goal.action.type === 'tool_chain' && goal.action.chain) {
      for (const step of goal.action.chain) {
        if (step.tool) neededToolNames.add(step.tool);
      }
    }
  }

  // 2. 临时注入
  const injected = toolRegistry.injectNeeded([...neededToolNames]);

  try {
    // 3. 逐个执行（v1 串行）
    for (const goal of dueGoals) {
      const result = await executeSingleGoal(goal);
      handleGoalResult(goal, result);
    }
  } finally {
    // 4. 确保清理
    toolRegistry.removeInjected(injected);
  }
}
```

---

### 4.3 意图解析 — Agent 自解析

```
文件: 不独立成模块，作为 prompt 模板嵌入 Soul 或 HEARTBEAT.md
```

**方案**: Agent 收到"创建提醒"类意图时，按模板输出 JSON。

```markdown
## Goal Creation Rules

当用户表达以下意图时，需要解析为 Goal JSON：
- 定时提醒（含条件判断）
- 周期性报告
- 监控告警
- 一次性任务

### 输出格式

回复中包含 JSON code block:

\`\`\`goal
{
  "type": "conditional_reminder",
  "trigger": { "type": "time", "time": "12:50", "leadMinutes": 10 },
  "condition": { "type": "weather", "params": {...}, "expected": true },
  "action": { "type": "send_message", "content": "..." },
  "lifecycle": { "repeat": "daily" }
}
\`\`\`

### 解析规则

| 用户表达 | trigger.type | 示例 |
|---------|-------------|------|
| "X点"、"X点钟" | time | "1点" → time: "13:00" |
| "每天早上/下午" | cron | "每天早上9点" → cron: "0 9 * * *" |
| "每N分钟/小时" | interval | "每30分钟" → intervalSeconds: 1800 |
| "如果/要是" | 带 condition | 提取条件类型和期望值 |

### 时间推断规则

- 如果用户说"1点"且当前是上午 → 推断为今天 13:00
- 如果用户说"1点"且当前是下午 → 推断为明天 01:00（问用户确认）
- trigger.time 永远用 24 小时制
- leadMinutes 默认 10 分钟
```

### 网关侧解析

Goal JSON 由 Agent 输出后，网关从回复中提取 ` ```goal ``` ` 代码块，调用 `GoalStore.add()`。

```typescript
// modules/core/goal-engine.ts
function extractGoalFromResponse(text: string): Goal | null {
  const match = text.match(/```goal\n([\s\S]*?)\n```/);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[1]);
    return {
      ...parsed,
      id: crypto.randomUUID(),
      lifecycle: {
        status: 'pending',
        repeat: parsed.lifecycle?.repeat ?? 'once',
        runCount: 0,
        createdAt: new Date().toISOString(),
      },
    };
  } catch {
    return null;
  }
}
```

---

### 4.4 Tool 注册机制 — 框架级扩展

> 注：与之前讨论的 Toolkit/MCP Injection Layer 是同一件事。

**当前状态**: Agent 有 9 个内置 tool，无扩展机制。

**目标**: 允许为 Goal Engine 动态注入外部 tool。

**最小可行方案**（不需要完整 Tool Registry）:

```typescript
// modules/agent/tool-registry.ts

interface ToolDefinition {
  name: string;
  description: string;
  parameters: {
    type: 'object';
    properties: Record<string, { type: string; description: string }>;
    required: string[];
  };
  handler: (params: Record<string, unknown>) => Promise<unknown>;
}

class ToolRegistry {
  private tools: Map<string, ToolDefinition> = new Map();

  register(tool: ToolDefinition): void {
    this.tools.set(tool.name, tool);
  }

  getOpenAIFormat(): object[] {
    return Array.from(this.tools.values()).map(t => ({
      type: 'function',
      function: {
        name: t.name,
        description: t.description,
        parameters: t.parameters,
      },
    }));
  }

  async execute(name: string, params: Record<string, unknown>): Promise<unknown> {
    const tool = this.tools.get(name);
    if (!tool) throw new Error(`Tool not found: ${name}`);
    return tool.handler(params);
  }

  list(): string[] {
    return Array.from(this.tools.keys());
  }
}
```

**内置工具示例（天气）**:

```typescript
// modules/tools/weather.ts
import type { ToolDefinition } from '../agent/tool-registry';

export const weatherTool: ToolDefinition = {
  name: 'get_weather',
  description: '查询指定城市的当前天气，返回温度、天气状况、是否下雨等信息',
  parameters: {
    type: 'object',
    properties: {
      city: { type: 'string', description: '城市名（中文或英文），默认自动检测位置' },
    },
    required: [],
  },
  handler: async (params) => {
    const city = (params.city as string) || 'auto:ip';
    const resp = await fetch(`https://wttr.in/${encodeURIComponent(city)}?format=j1`);
    const data = await resp.json() as any;
    const current = data.current_condition?.[0];
    return {
      city: data.nearest_area?.[0]?.areaName?.[0]?.value,
      temperature: current?.temp_C,
      weather: current?.weatherDesc?.[0]?.value,
      humidity: current?.humidity,
      rain: current?.weatherDesc?.[0]?.value?.toLowerCase().includes('rain'),
      wind: current?.winddir16Point,
    };
  },
};
```

---

### 4.4.1 天气 Tool — 中国网络可用性

> 评审意见 C3：`wttr.in` 在中国网络环境下经常不可用或极慢。必须考虑国内可用方案。

**降级链设计**（handler 内自动切换）：

```typescript
// modules/tools/weather.ts
async function getWeather(city: string) {
  // Layer 1: 国内 API 降级链
  const apis = [
    { name: '高德天气', fn: () => fetchFromGaoDe(city, API_KEYS.gaode) },
    { name: '和风天气', fn: () => fetchFromQWeather(city, API_KEYS.qweather) },
    { name: '心知天气', fn: () => fetchFromSeniverse(city, API_KEYS.seniverse) },
  ];

  for (const api of apis) {
    try {
      return await withTimeout(api.fn(), 5000);
    } catch (e) {
      console.warn(`[weather] ${api.name} 失败:`, e);
    }
  }

  // Layer 2: 最后的兜底
  try {
    return await withTimeout(fetchFromWttrIn(city), 5000);
  } catch {
    throw new Error('所有天气 API 不可用，请手动检查天气');
  }
}
```

**v1 实际建议**：直接用 Agent 的联网搜索能力判断天气（不依赖专门的 weather tool handler），这是最省事且可靠的方案。weather tool 作为可选增强保留。

| 方案 | 优点 | 缺点 | v1 采用？ |
|------|------|------|----------|
| Agent 联网搜索 | 零依赖，天然可用 | 搜索解析偶尔不准 | ✅ 默认 |
| 高德天气 API | 国内最稳定 | 需要 API key | 可选增强 |
| 和风天气 | 免费版 3000 次/天 | 需要 API key | 可选增强 |

---

## 五、完整执行时序（修订版）

以"1点下雨提醒带伞"为例，包含去重、Tool 注入/释放、降级链、锁管理：

```
T+0: 用户发送 "1点如果下雨提醒我带伞"
  │
T+0: Agent 解析 → 输出 ```goal { trigger: "12:50", condition: weather.rain, ... } ```
  │
T+0: 网关提取 goal JSON → GoalStore.add()
  │     ├─ 冲突检测：同 trigger + condition 的活跃 goal 已存在？
  │     │   └─ 是 → 返回 duplicate，Agent 回复"你已经有这个提醒了 ☔"
  │     └─ 否 → 创建 + 持久化到 goals.json
  │
T+0: Agent 回复: "好的，我会在 12:50 检查天气，如果下雨就提醒你带伞 ☔"
  │
  ├─ ... 时间流逝 ...
  │
T+10min (12:50): 心跳触发
  │
T+10min: getDueGoals() → 找到 goal_a1b2c3d4 (nextRunAt <= now)
  │
T+10min: 收集所需 tool → 临时注入 get_weather tool
  │
T+10min: 获取执行锁 → 构造 context prompt → 调 Agent
  │
T+10min: Agent 调用 get_weather
  │     └─ 降级链: 高德→和风→心知→wttr.in → 返回 { rain: true }
  │
T+10min: Agent 判断: rain == true → 执行 action.send_message
  │
T+10min: 网关发送 IM 消息到 sourceChatId → "老板，外面下雨了，记得带伞！☔"
  │
T+10min: Agent 回复 GOAL_DONE: goal_a1b2c3d4
  │
T+10min: 网关解析 GOAL_DONE → markDone(id) → reschedule
  │     └─ repeat=daily → nextRunAt = 明天 12:50
  │
T+10min: 释放执行锁
  │
T+10min: 移除临时注入的 get_weather tool
  │
T+10min: 写入执行历史 → goals_history.json（复用 writeHistory）
```

## 六、改动范围

### 新建文件

| 文件 | 说明 | 预估行数 |
|------|------|---------|
| `modules/core/goal-store.ts` | Goal CRUD + JSON 持久化 + 冲突检测 | ~250 |
| `modules/core/goal-engine.ts` | 到期检测 + 条件评估 + prompt 构造 + Tool 按需注入 | ~200 |
| `modules/core/goal-types.ts` | Goal 类型定义 | ~80 |
| `modules/agent/tool-registry.ts` | Tool 注册中心 + inject/remove 生命周期 | ~100 |
| `modules/tools/weather.ts` | 天气 tool 示例（降级链） | ~70 |
| `~/.imtoagent/goals.json` | Goal 持久化文件（运行时生成） | — |
| `~/.imtoagent/goals_history.json` | Goal 执行历史（运行时生成，复用 writeHistory） | — |

### 修改文件

| 文件 | 改动 | 预估行数 |
|------|------|---------|
| `modules/core/heartbeat-scheduler.ts` | Goal 执行入口 + Tool 按需注入 + 锁管理 | +60 |
| `modules/agent/codex-exec-server.ts` | 支持动态 tool list（injectNeeded/removeInjected） | +30 |
| `modules/bot/codex-bot.ts` | 消息回复中提取 goal JSON + GOAL_DONE/SKIP | +40 |
| `Soul 文件 / system prompt` | 意图解析规则 + Goal 管理协议 | +60 |

### 复用（不修改）

| 文件 | 复用内容 |
|------|---------|
| `modules/core/heartbeat.ts` | `isTaskDue()`, `djb2Phase()` |
| `modules/core/task-poller.ts` | `executeChain()` |
| `modules/core/task-manager.ts` | `writeHistory()` |
| `modules/agent/codex-adapter.ts` | `cancelSignal` |
| `modules/core/types.ts` | `TaskRunState.elapsedMs` |

### 总计

| 类型 | 文件数 | 预估总行数 |
|------|--------|-----------|
| 新建 | 5 (+2 运行时) | ~700 |
| 修改 | 4 | ~190 |
| 复用（不修改） | 5 | — |
| **合计** | **14** | **~890** |

## 七、与现有系统的关系（复用对照）

```
┌────────────────────────────────────────┐
│               IMtoAgent                 │
│                                         │
│  ┌──────────┐  ┌──────────────────┐    │
│  │ 现有系统  │  │   Goal Engine     │    │
│  │          │  │   (新增)           │    │
│  │ HEARTBEAT│  │                    │    │
│  │  .md     │  │ goal-store.ts     │    │
│  │  cron    │  │ goal-engine.ts    │    │
│  │  任务    │  │ tool-registry.ts  │    │
│  │          │  │                    │    │
│  │ 独立运行 │◀│ 共存，不替代       │    │
│  └──────────┘  └──────────────────┘    │
│                                         │
│  HEARTBEAT.md cron → 简单定时检查      │
│  Goal Engine     → 条件式智能目标      │
│                                         │
│  两者互补，不是替代关系                 │
└────────────────────────────────────────┘
```

- **HEARTBEAT.md cron**: 服务器运维级定时检查（磁盘/进程/日志）
- **Goal Engine**: 用户意图级智能目标（提醒/条件/报告）

---

### 设计决策记录

> 以下记录已做出的关键设计决策，避免后续反复讨论。

| # | 决策 | 选择 | 替代方案 | 理由 |
|---|------|------|---------|------|
| D1 | 持久化方案 | JSON 文件 | SQLite / Redis | Goal 数量 <100，JSON 可直接 cat 调试，无额外依赖 |
| D2 | Goal 执行顺序 | v1 串行 | 并发执行 | 并发复杂度远高于收益，v1 单进程串行足够 |
| D3 | 条件评估 | v1 全走 Agent | 部分直接评估 | 减少初期复杂度，预留 `ConditionEvaluator` 接口 |
| D4 | 存储复用 | 不复用 TaskManager | 尝试兼容 ScheduledTask | Goal 数据结构差异大，强行复用会增加两边复杂度 |
| D5 | Tool 注入 | 按需注入/移除 | 常驻 tool list | 节省正常聊天每轮 ~500-1000 token |
| D6 | 触发精度 | setTimeout + 心跳兜底 | 纯心跳 | 30 分钟心跳间隔对精确定时不够，混合模式平衡精度与成本 |
| D7 | 回复解析 | v1 精确匹配 + 超时 | v1 加模糊匹配 | 模糊匹配实现复杂，v1 先跑通流程 |

---

## 八、开放问题

以下需要进一步讨论和决策：

### Q1: Goal 执行时是新开 Agent Session 还是复用现有？
- **新 Session**: 隔离性好，不污染用户对话上下文
- **复用**: 可以访问历史对话，但可能 token 消耗大
- **建议**: 新 Session，但注入 goal 创建时的上下文摘要

### Q2: 条件评估失败时如何处理？
- 重试？多少次？
- 通知用户失败？
- 静默跳过？
- **建议**: 失败 3 次后 markFailed，下次心跳通知用户

### Q3: Goal 数量上限和存储迁移
- JSON 文件方案现阶段够用
- 何时迁 SQLite？阈值是什么？
- **建议**: Goal > 500 或读写性能成为瓶颈时迁移

### Q4: Goal 创建是否需要用户确认？
- 自动创建 vs 回复确认消息让用户点按钮确认？
- **建议**: 先自动创建 + 回复告知；可选加"取消"按钮

### Q5: Tool 注册的完整架构
- 是否现在就做完整 Tool Registry + MCP？
- 还是先最小可行，后续扩展？
- **建议**: 先最小可行，但接口预留扩展点

### Q6: 多条件组合
- AND / OR 条件是否需要支持？
- 如"如果下雨 AND 温度低于10度"
- **建议**: v1 只支持单条件，v2 扩展

### Q7: 多 Goal 同时到期的并发控制

**问题**: 如果 5 个 goal 同时到期，心跳 session 串行执行会阻塞，并行执行可能互相干扰。

**建议方案**:
- 串行执行（v1 默认）：逐个调 Agent，完成后才处理下一个。优点：简单、无并发问题。缺点：3 个 goal × 10s/个 = 30s，心跳可能超时
- 有限并行（v2）：最多 2 个并发，用 Semaphore 控制

**心跳超时兜底**: 单次心跳总执行时间不超过 `interval × 0.8`，超时则剩余 goal 标记为 `pending` 等下次。

### Q8: Goal 幂等性 — 防止重复执行

**问题**: Agent 回复 `GOAL_DONE: goal_a1b2c3d4` 但网关没收到（网络断开），下次心跳又触发同一个 goal。

**解决方案**:
```typescript
// Goal 执行前加锁
interface GoalExecutionLock {
  goalId: string;
  lockedAt: string;      // ISO 8601
  expiresAt: string;     // 默认 5 分钟后过期
  runId: string;         // 本次执行的唯一 ID
}

// 执行前：检查锁
// 执行后：释放锁 + 更新 runCount
// 锁过期：自动释放（防止僵尸锁）
```

### Q9: 用户管理 Goal 的交互协议

用户需要能**查看、取消、修改**已有的 goal，通过自然语言 IM 消息：

| 用户输入 | 解析意图 |
|---------|---------|
| "我有哪些提醒？" | list_goals |
| "取消下雨提醒" | cancel_goal（模糊匹配） |
| "把带伞提醒改成 2 点" | update_goal（修改 trigger） |
| "暂停周报" | pause_goal |
| "恢复周报" | resume_goal |

**实现**: 在 system prompt 中增加 Goal Management 能力，Agent 识别到管理意图时：

```typescript
// 网关侧解析管理意图
function extractGoalManagement(text: string): GoalManagementAction | null {
  const patterns = [
    { regex: /GOAL_LIST/, action: 'list_goals' },
    { regex: /GOAL_CANCEL:\s*([\w-]+)/, action: 'cancel_goal' },
    { regex: /GOAL_UPDATE:\s*([\w-]+)\s+(.*)/, action: 'update_goal' },
    { regex: /GOAL_PAUSE:\s*([\w-]+)/, action: 'pause_goal' },
    { regex: /GOAL_RESUME:\s*([\w-]+)/, action: 'resume_goal' },
  ];
  for (const p of patterns) {
    const match = text.match(p.regex);
    if (match) return { action: p.action, goalId: match[1], extra: match[2] };
  }
  return null;
}
```

Agent 回复中包含 `GOAL_LIST` / `GOAL_CANCEL: <id>` 等标记，网关解析后直接操作 GoalStore。

### Q10: GOAL_DONE / GOAL_SKIP 的网关处理

Agent 执行 goal 后，回复中需要包含状态标记：

```typescript
function parseGoalResult(text: string): { goalId: string; action: 'done' | 'skip' | 'failed' | null } {
  // 兼容大小写，支持多个 goal ID
  const doneMatch = text.match(/GOAL_DONE:\s*([\w-]+)/i);
  const skipMatch = text.match(/GOAL_SKIP:\s*([\w-]+)/i);
  const failedMatch = text.match(/GOAL_FAILED:\s*([\w-]+)/i);
  if (doneMatch) return { goalId: doneMatch[1].toLowerCase(), action: 'done' };
  if (skipMatch) return { goalId: skipMatch[1].toLowerCase(), action: 'skip' };
  if (failedMatch) return { goalId: failedMatch[1].toLowerCase(), action: 'failed' };
  return { goalId: '', action: null };
}
```

**处理流程**：
1. `GOAL_DONE: <id>` → markDone(id) → reschedule（如果是 periodic）
2. `GOAL_SKIP: <id>` → 跳过本次 → reschedule（如果是 periodic）
3. `GOAL_FAILED: <id>` → 记录错误 → 下次心跳重试（最多 3 次）
4. 无任何标记 → 视为异常 → markFailed + 记录原始回复 → 下次重试

**锁释放**：无论结果如何，执行锁必须在 finally 块释放：
```typescript
finally { goalStore.releaseLock(goal.id); }
```

### Q11: 条件评估优化 — 不一定每次都要调 Agent

**问题**: 每次心跳都调 Agent 判断条件（如天气），token 消耗大。

**优化方案**:
- **Layer 1: 简单条件直接评估**（不调 Agent）
  - `system_metric`: 直接读本地数据（CPU/磁盘）
  - `api_check`: 直接 HTTP 请求 + JSON path 提取
- **Layer 2: 复杂条件调 Agent**
  - `weather`: 需要自然语言理解（"下雨" vs "小雨" vs "阵雨"）
  - `external_state`: 需要多步推理

```typescript
// 条件评估器接口
interface ConditionEvaluator {
  canEvaluateDirectly(condition: GoalCondition): boolean;
  evaluateDirectly(condition: GoalCondition): Promise<boolean>;
  // 不能直接评估时，构造 prompt 交给 Agent
  buildAgentPrompt(condition: GoalCondition): string;
}
```

**v1 简化**: 所有条件都走 Agent，但预留 `ConditionEvaluator` 接口。

### Q12: 目标 ChatId 的确定

**问题**: goal 执行结果发到哪个聊天？

**优先级**:
1. `action.target` 显式指定 → 用这个
2. `metadata.sourceChatId` → 创建 goal 时的聊天
3. `lastActiveChatId` → 最后活跃的聊天（可能不是用户想要的）
4. 全部没有 → 不发送，只记录日志

**注意**: `sourceChatId` 可能是群聊，用户私聊创建的 goal 不应该发到群里。需要在 `metadata` 中记录 `isGroup` 标记。

### Q13: Goal 执行幂等性 — Agent 回复解析的容错

**问题**: Agent 回复不一定严格遵循 `GOAL_DONE: <id>` 格式，尤其在使用不同模型时。

**容错策略**:
```
优先级:
1. 精确匹配: GOAL_DONE: goal_xxx / GOAL_SKIP: goal_xxx
2. 模糊匹配: "goal_xxx 已完成" / "跳过了 goal_xxx"
3. 语义推断: 如果只有一条到期 goal 且 Agent 回复了执行结果 → 推断为 done
4. 超时兜底: 30s 无明确标记 → 视为异常，记录日志，等下次重试
```

**建议**: v1 只支持精确匹配 + 超时兜底，v2 加模糊匹配。

### Q14: 心跳间隔与 Goal 精度的权衡

**问题**: 当前心跳间隔是 ~30 分钟，但用户说"1点提醒"，如果 12:30 检查错过，1:00 才触发，会有 30 分钟偏差。

**方案**:
- 方案 A: 缩短心跳间隔到 5 分钟（增加 API 调用频率）
- 方案 B: 引入 `setTimeout` 精确触发（进程内，重启丢失）
- 方案 C: 混合模式 — 心跳做兜底 + setTimeout 做精确触发

**建议**: v1 用方案 C（混合模式），心跳作为重启后的兜底。`leadMinutes` 字段已经为这个场景预留。

**macOS 休眠处理**：
- macOS 休眠/合盖时，进程内 `setTimeout` 会延迟到唤醒后才触发（不是丢失）
- 唤醒后：检查 `now - setTimeoutTargetTime`，如果已超过 `leadMinutes` → 视为已过期，由心跳兜底重新触发
- 关键逻辑：setTimeout 回调中判断 `if (Date.now() > scheduledTime + leadMinutes * 60 * 1000) return` — 过期则跳过，等心跳兜底
- 心跳每次执行都会 `getDue(now)`，天然覆盖休眠期间遗漏的 Goal

### Q15: Goal 执行的上下文隔离

**问题**: Goal 执行时的 Agent session 需要知道什么上下文？

**注入的上下文**:
```
- goal.metadata.rawInput（用户原始意图）
- goal.metadata.createdBy（创建者身份，用于个性化称呼）
- goal 创建时的时间/天气/位置快照（可选，用于对比）
- 最近的对话摘要（可选，最多 3 条相关消息）
```

**不注入的上下文**:
```
- 完整对话历史（token 浪费）
- 其他 goal 的信息（隔离性）
- 系统内部状态（CPU/内存等，除非 goal 需要）
```

**建议**: v1 只注入 rawInput + createdBy + goal 自身信息，后续按需扩展。

### Q16: 安全边界 — Goal 执行权限

**问题**: Goal 自动执行时，Agent 能做什么、不能做什么？

**限制**:
```
✅ 允许: 发消息、查询天气/系统状态、读取只读数据
❌ 禁止: 删除文件、修改系统配置、发消息给非目标用户、执行不可逆操作
⚠️ 需要确认: 涉及金钱/外部 API 写操作 → 先通知用户，等待确认
```

**实现**: 在 Tool Registry 的 `injectNeeded` 中过滤掉危险 tool，只在 goal 的 `allowed_tools` 白名单内注入。

---

## 九、Phase 拆分建议

> 当前文档改动量 ~900 行，建议拆分为两个 Phase，每步可独立验证。

### Phase 1：核心引擎（可独立验证的最小可用版本）

| 模块 | 文件 | 说明 |
|------|------|------|
| Goal 类型定义 | `goal-types.ts` | Goal 接口 + Trigger/Condition/Action 子类型 |
| Goal Store | `goal-store.ts` | CRUD + 持久化 + 去重 + 执行锁 |
| Goal Engine | `goal-engine.ts` | 到期检测 + prompt 构造 + Agent 调用 + 结果解析 |
| 意图解析 prompt | 嵌入 system prompt | Agent 自解析 Goal JSON |
| 心跳集成 | `heartbeat.ts` 扩展 | 心跳流程中读取到期 Goal |
| 精确触发 | `setTimeout` + 心跳兜底 | Q14 方案 C，精确到分钟级 |

**验证标准**：用户说"1点下雨提醒我带伞"→ 自动创建 Goal → 到期检查天气 → 发消息。

**不包含**：Tool Registry、条件直接评估、多条件组合、管理协议。

### Phase 2：Tool Registry + 管理协议

| 模块 | 文件 | 说明 |
|------|------|------|
| Tool Registry | `tool-registry.ts` | 动态注入/移除工具，token 节省 |
| 天气 Tool | `weather.ts` | 降级链实现（高德→和风→心知） |
| Goal 管理协议 | prompt + 网关解析 | 查看/取消/修改/暂停/恢复 |
| 条件直接评估 | `condition-evaluator.ts` | system_metric / api_check 不调 Agent |
| 模糊回复解析 | `parseGoalResult` 增强 | Q13 的 4 级容错 |

**验证标准**：用户说"我有哪些提醒"→ 列表展示 → "取消带伞提醒"→ 正确删除。

---

## 十、测试策略

> 每个 Phase 完成后需要对应测试，不裸上线。

### Phase 1 测试（集成测试为主）

| # | 测试场景 | 验证点 | 类型 |
|---|---------|-------|------|
| T1 | "1点下雨提醒我带伞" | Goal 正确解析 + 持久化 + 到期触发 | 集成 |
| T2 | "每天早上9点发今日待办" | cron 解析 + nextRunAt 计算正确 | 单元 |
| T3 | 重复创建相同提醒 | 去重检测返回 duplicate | 单元 |
| T4 | Goal 执行后 markDone | lifecycle.status 正确迁移 | 单元 |
| T5 | 进程重启后 Goal 不丢失 | goals.json 正确加载 | 集成 |
| T6 | setTimeout 精确触发 | 在目标时间 ±1 分钟内触发 | 集成 |
| T7 | setTimeout 丢失（进程崩溃）| 心跳在下次检查时兜底触发 | 集成 |
| T8 | Agent 回复不含 GOAL_DONE | 超时兜底，标记异常 | 集成 |

### Phase 2 测试

| # | 测试场景 | 验证点 | 类型 |
|---|---------|-------|------|
| T9 | "我有哪些提醒？" | 正确列出活跃 Goal | 集成 |
| T10 | "取消下雨提醒" | 正确标记 cancelled | 集成 |
| T11 | 天气 Tool 注入 | 正常聊天 session 不看到天气 Tool | 单元 |
| T12 | 天气 Tool 降级链 | 高德不通时自动切和风 | 集成 |
| T13 | system_metric 直接评估 | 不调 Agent，直接读 CPU/磁盘 | 单元 |
| T14 | 并发心跳重复执行 | 执行锁防止同一 Goal 跑两次 | 集成 |

### 自动化建议

```
tests/goal-engine/
├── unit/
│   ├── goal-store.test.ts        # T3, T4, T5
│   ├── goal-types.test.ts        # 类型校验
│   ├── trigger-parser.test.ts    # T2
│   └── condition-evaluator.test.ts # T13
├── integration/
│   ├── goal-lifecycle.test.ts    # T1, T6, T7, T8
│   ├── goal-management.test.ts   # T9, T10
│   ├── tool-injection.test.ts    # T11, T12
│   └── lock-concurrency.test.ts  # T14
└── fixtures/
    └── sample-goals.json         # 测试用 Goal 样本
```

**Bun 测试命令**：`bun test tests/goal-engine/`

---

## 十一、后续扩展方向

- [ ] Goal 模板库（常用 goal 一键创建）
- [ ] Goal 共享（跨 chat/跨用户）
- [ ] Goal 链（goal 执行结果触发另一个 goal）
- [ ] Webhook 触发（外部系统事件触发 goal）
- [ ] 完整 MCP Tool Registry（标准化 tool 注册协议）
- [ ] 多条件组合（AND/OR，Q6 的后续）
- [ ] 条件直接评估（Q11 的后续，减少 Agent 调用）
- [ ] Goal 执行历史可视化（统计面板）

---

## 十二、评审修订记录

### 2026-06-03 V2 修订（义一评审）

| 编号 | 位置 | 变更内容 |
|------|------|---------|
| C1 | 新增 §〇 | 补充代码级复用决策：明确 TaskSystem 组件 import 关系，列出复用/新建/不修改边界 |
| C2 | 新增 §4.2.1 | 补充 Tool 注入时机与生命周期：按需注入流程 + `executeDueGoals()` 代码级实现 |
| C3 | 新增 §4.4.1 | 替换天气 API 为中国可用方案：降级链（高德→和风→心知→wttr.in），v1 建议 Agent 搜索 |
| C4 | 结构调整 | 合并 Q1-Q12 为统一 §九、开放问题；修正重复"## 七"章节编号 |
| C5 | 新增 §3.3 | 补充 Goal 创建冲突检测：`GoalStore.add()` 去重逻辑 + duplicate 返回值 |
| — | 增强 §五 | 更新执行时序图，加入 Tool 注入/释放、降级链、去重、锁释放、历史写入 |
| — | 增强 §六 | 改动范围增加复用对照表，明确不修改的现有文件 |

### 2026-06-03 V2.1 补充完善

| 编号 | 位置 | 变更内容 |
|------|------|---------|
| — | 新增 Q13 | Goal 执行幂等性容错：精确匹配 → 模糊匹配 → 语义推断 → 超时兜底 |
| — | 新增 Q14 | 心跳间隔与 Goal 精度权衡：setTimeout 精确触发 + 心跳兜底混合模式 |
| — | 新增 Q15 | Goal 执行上下文隔离：明确注入什么、不注入什么 |
| — | 新增 Q16 | 安全边界：Goal 自动执行的权限白名单与限制 |
| — | 增强 §十 | 扩展方向增加 Q6/Q11 后续条目 |

### 2026-06-03 V2.2 结构优化

| 编号 | 位置 | 变更内容 |
|------|------|---------|
| — | 新增 §十 | Phase 拆分建议：Phase 1（核心引擎）+ Phase 2（Tool Registry + 管理协议） |
| — | 新增 §十一 | 测试策略：14 个测试场景（T1-T14），覆盖单元 + 集成，目录结构建议 |
| — | 修复 | 删除重复的"## 十、后续扩展方向"，章节重新编号为 §十-§十三 |

### 2026-06-03 V2.3 细节修正

| 编号 | 位置 | 变更内容 |
|------|------|---------|
| — | 修复 | 章节编号跳跃（六→八→九），重新连贯编号为 〇~十二 |
| — | 修复 | Phase 2 表格重复行（"条件直接评估"出现两次） |
| — | 修复 | `GoalStore.add()` 接口不一致（§3.3 返回结果 vs §4.1 返回 void），统一为带去重返回值 |
| — | 增强 Q14 | 补充 macOS 休眠对 `setTimeout` 的影响及处理方案 |
| — | 新增 设计决策记录 | 7 条已做决策集中记录（D1-D7），避免后续反复 |

### 原评审意见（存档，原文见 git history）

