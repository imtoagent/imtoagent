// ================================================================
// Goal Engine — 类型定义
// ================================================================

/** 触发器类型 */
export type TriggerType = 'time' | 'cron' | 'interval' | 'event';

/** 条件类型 */
export type ConditionType = 'weather' | 'system_metric' | 'api_check' | 'external_state' | 'none';

/** 动作类型 */
export type ActionType = 'send_message' | 'run_tool' | 'tool_chain';

/** 生命周期状态 */
export type GoalStatus = 'pending' | 'active' | 'done' | 'failed' | 'cancelled' | 'paused';

/** 重复策略 */
export type RepeatStrategy = 'once' | 'hourly' | 'daily' | 'weekly' | 'custom';

/** 比较运算符 */
export type CompareOperator = 'eq' | 'ne' | 'gt' | 'lt' | 'gte' | 'lte' | 'contains';

/** 目标类型 */
export type GoalType = 'reminder' | 'conditional_reminder' | 'periodic_report' | 'monitor_alert' | 'one_shot';

// ================================================================
// Goal 核心接口
// ================================================================

export interface GoalTrigger {
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

export interface GoalCondition {
  type: ConditionType;
  /** 条件参数，依类型不同 */
  params: Record<string, unknown>;
  /** 期望值 */
  expected: unknown;
  /** 比较运算符 */
  operator?: CompareOperator;
}

export interface GoalAction {
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

export interface GoalLifecycle {
  status: GoalStatus;
  repeat: RepeatStrategy;
  /** 自定义 cron（repeat=custom 时使用） */
  customCron?: string;
  /** 最大执行次数（once 时 =1，无限制时省略） */
  maxRuns?: number;
  /** 连续 unknown 回复的最大容忍次数，超限后永久失败（默认 3） */
  maxUnknowns?: number;
  /** 已执行次数 */
  runCount: number;
  createdAt: string;
  nextRunAt?: string;
  lastRunAt?: string;
  lastError?: string;
  expiresAt?: string;
}

export interface GoalMetadata {
  createdBy: string;
  sourceChatId: string;
  rawInput: string;
  tags?: string[];
  priority?: 'low' | 'normal' | 'high';
  /** 连续 unknown 回复计数器（每次 done/skip 时重置） */
  consecutiveUnknowns?: number;
}

export interface Goal {
  id: string;
  type: GoalType;
  trigger: GoalTrigger;
  condition?: GoalCondition;
  action: GoalAction;
  lifecycle: GoalLifecycle;
  metadata: GoalMetadata;
}

// ================================================================
// Store 相关类型
// ================================================================

export interface GoalFilter {
  status?: GoalStatus | GoalStatus[];
  type?: GoalType;
  tags?: string[];
  createdBy?: string;
}

export type GoalAddResult =
  | { status: 'created'; id: string }
  | { status: 'duplicate'; existingId: string; existing: Goal };

export interface GoalExecutionLock {
  goalId: string;
  lockedAt: string;
  expiresAt: string;
  runId: string;
}

/** Goal 持久化文件格式 */
export interface GoalPersisted {
  version: number;
  updatedAt: string;
  goals: Record<string, Goal>;
}

// ================================================================
// 工具函数
// ================================================================

/** 生成 Goal ID */
export function generateGoalId(): string {
  return `goal_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
}

/** 创建默认 Goal（供解析器使用） */
export function createGoal(partial: Partial<Goal> & { type: GoalType; trigger: GoalTrigger; action: GoalAction; metadata: { createdBy: string; sourceChatId: string; rawInput: string } }): Goal {
  return {
    id: partial.id ?? generateGoalId(),
    type: partial.type,
    trigger: partial.trigger,
    condition: partial.condition,
    action: partial.action,
    lifecycle: {
      status: 'pending',
      repeat: partial.lifecycle?.repeat ?? 'once',
      customCron: partial.lifecycle?.customCron,
      maxRuns: partial.lifecycle?.maxRuns,
      runCount: 0,
      createdAt: new Date().toISOString(),
      nextRunAt: partial.lifecycle?.nextRunAt,
      expiresAt: partial.lifecycle?.expiresAt,
    },
    metadata: partial.metadata,
  };
}

/** 检查 Goal 是否到期 */
export function isGoalDue(goal: Goal, now?: Date): boolean {
  if (goal.lifecycle.status !== 'pending' && goal.lifecycle.status !== 'active') return false;
  if (!goal.lifecycle.nextRunAt) return false;
  const ref = now ?? new Date();
  return new Date(goal.lifecycle.nextRunAt) <= ref;
}
