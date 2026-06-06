// ================================================================
// Goal Manager — Goal 管理协议
// ================================================================
// Phase 2：解析用户对 Goal 的管理意图，执行管理操作
//
// Agent 回复格式（在 system prompt 中定义）：
//   GOAL_CREATE: <自然语言描述> → 创建 Goal
//   GOAL_LIST              → 列出所有活跃 Goal
//   GOAL_CANCEL: <id>      → 取消 Goal
//   GOAL_PAUSE: <id>       → 暂停
//   GOAL_RESUME: <id>      → 恢复
//   GOAL_UPDATE: <id> <json> → 修改
// ================================================================

import type { Goal, GoalTrigger, GoalAction, RepeatStrategy, GoalType } from './goal-types';
import { createGoal, generateGoalId } from './goal-types';
import type { GoalStore } from './goal-store';
import { getShanghaiDateParts, formatShanghaiTimeShort } from './timezone';

// ================================================================
// 解析函数
// ================================================================

export interface GoalManagementAction {
  action: 'create' | 'list' | 'cancel' | 'pause' | 'resume' | 'update';
  rawInput?: string;
  goalId?: string;
  chatId?: string;
  patch?: Record<string, unknown>;
}

/**
 * 从文本中解析 Goal 管理意图
 * @param text Agent 回复文本
 * @param chatId 当前会话 chatId（用于 GOAL_CREATE 时写入 sourceChatId）
 */
export function parseGoalManagement(text: string, chatId?: string): GoalManagementAction | null {
  const patterns = [
    { regex: /GOAL_CREATE\s*:\s*([\s\S]+)/i, action: 'create' as const, capture: 1 },
    { regex: /GOAL_LIST/i, action: 'list' as const },
    { regex: /GOAL_CANCEL:\s*([a-zA-Z0-9_-]+)/i, action: 'cancel' as const, capture: 1 },
    { regex: /GOAL_PAUSE:\s*([a-zA-Z0-9_-]+)/i, action: 'pause' as const, capture: 1 },
    { regex: /GOAL_RESUME:\s*([a-zA-Z0-9_-]+)/i, action: 'resume' as const, capture: 1 },
    { regex: /GOAL_UPDATE:\s*([a-zA-Z0-9_-]+)\s+([\s\S]+)/i, action: 'update' as const, capture: 1 },
  ];

  for (const p of patterns) {
    const match = text.match(p.regex);
    if (match) {
      const result: GoalManagementAction = { action: p.action };
      if ('capture' in p && p.capture) {
        if (p.action === 'create') {
          result.rawInput = match[p.capture].trim();
          result.chatId = chatId;
        } else if (p.action === 'update') {
          result.goalId = match[1];
          try {
            result.patch = JSON.parse(match[2].trim());
          } catch {
            result.patch = { _raw: match[2].trim() };
          }
        } else {
          result.goalId = match[p.capture];
        }
      }
      return result;
    }
  }

  return null;
}

// ================================================================
// GOAL_CREATE 自然语言解析
// ================================================================

interface ParsedGoalInput {
  description: string;
  trigger: Partial<GoalTrigger>;
  action: Partial<GoalAction>;
  repeat: RepeatStrategy;
  goalType: GoalType;
}

/**
 * 从自然语言中解析 Goal 创建参数
 * 支持格式示例：
 *   "每天 9:00 提醒我站会"
 *   "每 30 分钟检查一次磁盘"
 *   "10 分钟后提醒我打电话给老板"
 *   "工作日每天 18:00 提醒下班"
 */
function parseGoalCreateInput(rawInput: string): ParsedGoalInput {
  const input = rawInput.trim();

  const result: ParsedGoalInput = {
    description: input,
    trigger: {},
    action: { type: 'send_message', content: input },
    repeat: 'once',
    goalType: 'reminder',
  };

  // 解析 cron 表达式（显式指定）
  const cronMatch = input.match(/cron[:：]\s*([\d\s*,*/-]+)/i);
  if (cronMatch) {
    result.trigger.type = 'cron';
    result.trigger.cron = cronMatch[1].trim();
    result.repeat = 'custom';
    result.goalType = 'one_shot';
    return result;
  }

  // 解析 "每 X 分钟/小时/天" → interval
  const intervalMatch = input.match(/每\s*(\d+)\s*(秒|分钟|小时|天|周)/);
  if (intervalMatch) {
    const value = parseInt(intervalMatch[1], 10);
    const unit = intervalMatch[2];
    const seconds =
      unit === '秒' ? value :
      unit === '分钟' ? value * 60 :
      unit === '小时' ? value * 3600 :
      unit === '天' ? value * 86400 :
      value * 604800;
    result.trigger.type = 'interval';
    result.trigger.intervalSeconds = seconds;
    result.repeat = 'custom';
    result.goalType = 'periodic_report';
    return result;
  }

  // 解析 "每天/每周/工作日 HH:MM" → time trigger
  const timeMatch = input.match(/(每天|每周|工作日|每周[一二三四五六日])\s*(\d{1,2}):(\d{2})/);
  if (timeMatch) {
    const period = timeMatch[1];
    const hour = parseInt(timeMatch[2], 10);
    const minute = parseInt(timeMatch[3], 10);
    result.trigger.type = 'time';
    result.trigger.time = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;

    if (period === '每天') {
      result.repeat = 'daily';
    } else if (period === '每周') {
      result.repeat = 'weekly';
    } else {
      result.repeat = 'daily'; // 工作日也按 daily 处理，条件过滤由 Agent 判断
    }
    result.goalType = 'reminder';
    return result;
  }

  // 解析 "X 分钟后/小时后" → 一次性定时
  const relativeMatch = input.match(/(\d+)\s*(分钟|小时|秒)后?/);
  if (relativeMatch) {
    const value = parseInt(relativeMatch[1], 10);
    const unit = relativeMatch[2];
    const seconds = unit === '分钟' ? value * 60 : unit === '小时' ? value * 3600 : value;
    const targetTime = new Date(Date.now() + seconds * 1000);
    // 获取上海时间的小时和分钟
    const parts = getShanghaiDateParts(targetTime.getTime());
    result.trigger.type = 'time';
    result.trigger.time = `${String(parts.hour).padStart(2, '0')}:${String(parts.minute).padStart(2, '0')}`;
    result.repeat = 'once';
    result.goalType = 'reminder';
    return result;
  }

  // 解析纯时间 "HH:MM" → 今天该时间的一次性提醒
  const pureTimeMatch = input.match(/^(\d{1,2}):(\d{2})/);
  if (pureTimeMatch) {
    result.trigger.type = 'time';
    result.trigger.time = `${String(parseInt(pureTimeMatch[1], 10)).padStart(2, '0')}:${pureTimeMatch[2]}`;
    result.repeat = 'once';
    result.goalType = 'reminder';
    return result;
  }

  // 默认：一次性 Goal，立即执行
  result.trigger.type = 'time';
  const parts = getShanghaiDateParts();
  result.trigger.time = `${String(parts.hour).padStart(2, '0')}:${String(parts.minute).padStart(2, '0')}`;
  result.repeat = 'once';
  return result;
}

/**
 * 从解析结果创建 Goal 对象
 */
function createGoalFromInput(parsed: ParsedGoalInput, rawInput: string, chatId?: string): Goal {
  const now = new Date();
  const trigger: GoalTrigger = {
    type: parsed.trigger.type || 'time',
    time: parsed.trigger.time,
    cron: parsed.trigger.cron,
    intervalSeconds: parsed.trigger.intervalSeconds,
    leadMinutes: parsed.trigger.leadMinutes ?? 10,
  };

  const action: GoalAction = {
    type: parsed.action.type || 'send_message',
    content: parsed.action.content || parsed.description,
    target: parsed.action.target,
  };

  // 计算 nextRunAt
  let nextRunAt: string | undefined;
  if (trigger.type === 'time' && trigger.time) {
    const [h, m] = trigger.time.split(':').map(Number);
    const nowParts = getShanghaiDateParts();
    // 构造今天上海时间的目标时间
    const isoToday = `${nowParts.year}-${String(nowParts.month).padStart(2, '0')}-${String(nowParts.day).padStart(2, '0')}T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00+08:00`;
    const target = new Date(isoToday);
    const now = new Date();
    // 如果今天的时间已过，推到明天
    if (target <= now && parsed.repeat === 'once') {
      const tomorrowMs = now.getTime() + 24 * 60 * 60 * 1000;
      const tParts = getShanghaiDateParts(tomorrowMs);
      const isoTomorrow = `${tParts.year}-${String(tParts.month).padStart(2, '0')}-${String(tParts.day).padStart(2, '0')}T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00+08:00`;
      nextRunAt = new Date(isoTomorrow).toISOString();
    } else {
      nextRunAt = target.toISOString();
    }
  } else if (trigger.type === 'interval' && trigger.intervalSeconds) {
    nextRunAt = new Date(now.getTime() + trigger.intervalSeconds * 1000).toISOString();
  }

  return createGoal({
    id: generateGoalId(),
    type: parsed.goalType,
    trigger,
    action,
    lifecycle: {
      status: 'pending',
      repeat: parsed.repeat,
      runCount: 0,
      createdAt: now.toISOString(),
      nextRunAt,
    },
    metadata: {
      createdBy: 'user',
      sourceChatId: chatId || '',
      rawInput,
    },
  });
}

// ================================================================
// GoalManager 类
// ================================================================

export class GoalManager {
  constructor(private goalStore: GoalStore) {}

  // ================================================================
  // 列出活跃 Goal
  // ================================================================

  /**
   * 列出所有活跃 Goal
   */
  listGoals(filter?: { createdBy?: string; tag?: string }): string {
    const goals = this.goalStore.getActive();
    let filtered = goals;

    if (filter?.createdBy) {
      filtered = filtered.filter(g => g.metadata.createdBy === filter.createdBy);
    }
    if (filter?.tag) {
      filtered = filtered.filter(g => g.metadata.tags?.includes(filter.tag!));
    }

    if (filtered.length === 0) {
      return '📋 暂无活跃目标';
    }

    const lines = filtered.map(g => {
      const status = g.lifecycle.status;
      const nextRun = g.lifecycle.nextRunAt
        ? formatShanghaiTimeShort(g.lifecycle.nextRunAt)
        : '未调度';
      const type = g.type;
      const rawInput = g.metadata.rawInput.length > 30
        ? g.metadata.rawInput.slice(0, 30) + '...'
        : g.metadata.rawInput;
      return `• **${g.id}** | ${status} | ${type} | 下次: ${nextRun}\n  ${rawInput}`;
    });

    return `📋 活跃目标（${filtered.length}个）\n\n${lines.join('\n\n')}`;
  }

  // ================================================================
  // 取消 Goal
  // ================================================================

  /**
   * 取消 Goal
   */
  cancelGoal(goalId: string): { success: boolean; message: string } {
    const goal = this.goalStore.get(goalId);
    if (!goal) {
      return { success: false, message: `❌ Goal ${goalId} 不存在` };
    }
    if (goal.lifecycle.status === 'done' || goal.lifecycle.status === 'cancelled') {
      return { success: false, message: `❌ Goal ${goalId} 已结束（${goal.lifecycle.status}）` };
    }

    this.goalStore.cancel(goalId);
    return { success: true, message: `✅ 已取消 Goal ${goalId}` };
  }

  // ================================================================
  // 暂停/恢复 Goal
  // ================================================================

  /**
   * 暂停 Goal（将状态设为 paused，不再调度）
   */
  pauseGoal(goalId: string): { success: boolean; message: string } {
    const goal = this.goalStore.get(goalId);
    if (!goal) {
      return { success: false, message: `❌ Goal ${goalId} 不存在` };
    }
    if (goal.lifecycle.status === 'done' || goal.lifecycle.status === 'cancelled' || goal.lifecycle.status === 'paused') {
      return { success: false, message: `❌ Goal ${goalId} 已结束或已暂停（${goal.lifecycle.status}）` };
    }

    goal.lifecycle.status = 'paused';
    this.goalStore.update(goalId, { lifecycle: goal.lifecycle });
    return { success: true, message: `⏸ 已暂停 Goal ${goalId}` };
  }

  /**
   * 恢复 Goal（将状态恢复为 pending，重新计算 nextRunAt）
   */
  resumeGoal(goalId: string): { success: boolean; message: string } {
    const goal = this.goalStore.get(goalId);
    if (!goal) {
      return { success: false, message: `❌ Goal ${goalId} 不存在` };
    }
    if (goal.lifecycle.status !== 'paused') {
      return { success: false, message: `❌ Goal ${goalId} 不是暂停状态（当前: ${goal.lifecycle.status}）` };
    }

    // 恢复状态为 pending
    goal.lifecycle.status = 'pending';
    // 重新计算 nextRunAt
    const now = new Date();
    goal.lifecycle.nextRunAt = now.toISOString();
    this.goalStore.update(goalId, { lifecycle: goal.lifecycle });
    return { success: true, message: `▶️ 已恢复 Goal ${goalId}` };
  }

  // ================================================================
  // 修改 Goal
  // ================================================================

  /**
   * 修改 Goal（修改 trigger/action/condition）
   */
  updateGoal(goalId: string, patch: Partial<Goal>): { success: boolean; message: string } {
    const goal = this.goalStore.get(goalId);
    if (!goal) {
      return { success: false, message: `❌ Goal ${goalId} 不存在` };
    }
    if (goal.lifecycle.status === 'done' || goal.lifecycle.status === 'cancelled') {
      return { success: false, message: `❌ Goal ${goalId} 已结束（${goal.lifecycle.status}），无法修改` };
    }

    // 合并 patch
    const updated = { ...goal };

    if (patch.trigger) {
      updated.trigger = { ...goal.trigger, ...patch.trigger };
    }
    if (patch.action) {
      updated.action = { ...goal.action, ...patch.action };
    }
    if (patch.condition !== undefined) {
      updated.condition = patch.condition;
    }
    if (patch.lifecycle) {
      updated.lifecycle = { ...goal.lifecycle, ...patch.lifecycle };
    }
    if (patch.metadata) {
      updated.metadata = { ...goal.metadata, ...patch.metadata };
    }

    const success = this.goalStore.update(goalId, updated);
    if (success) {
      return { success: true, message: `✏️ 已更新 Goal ${goalId}` };
    }
    return { success: false, message: `❌ 更新 Goal ${goalId} 失败` };
  }

  // ================================================================
  // 处理管理指令（从 Agent 回复中解析并执行）
  // ================================================================

  /**
   * 从 Agent 回复中解析管理指令并执行
   * @param text Agent 回复文本
   * @param chatId 当前会话 chatId（GOAL_CREATE 时用于写入 sourceChatId）
   * @returns 执行结果字符串，如果无管理指令则返回 null
   */
  processManagementCommand(text: string, chatId?: string): string | null {
    const action = parseGoalManagement(text, chatId);
    if (!action) return null;

    switch (action.action) {
      case 'create': {
        if (!action.rawInput) {
          return '❌ 缺少 Goal 描述';
        }
        const parsed = parseGoalCreateInput(action.rawInput);
        const goal = createGoalFromInput(parsed, action.rawInput, action.chatId);
        const result = this.goalStore.add(goal);
        if (result.status === 'duplicate') {
          return `⚠️ 该 Goal 已存在（ID: ${result.existingId}）`;
        }
        const triggerDesc = describeTriggerSummary(goal);
        return `✅ Goal 已创建\nID: ${goal.id}\n描述: ${goal.metadata.rawInput}\n触发: ${triggerDesc}`;
      }
      case 'list':
        return this.listGoals();
      case 'cancel':
        return action.goalId ? this.cancelGoal(action.goalId).message : '❌ 缺少 Goal ID';
      case 'pause':
        return action.goalId ? this.pauseGoal(action.goalId).message : '❌ 缺少 Goal ID';
      case 'resume':
        return action.goalId ? this.resumeGoal(action.goalId).message : '❌ 缺少 Goal ID';
      case 'update':
        if (!action.goalId || !action.patch) {
          return '❌ 缺少 Goal ID 或更新内容';
        }
        return this.updateGoal(action.goalId, action.patch as Partial<Goal>).message;
      default:
        return null;
    }
  }
}

/**
 * 简洁的触发方式描述（用于创建确认）
 */
function describeTriggerSummary(goal: Goal): string {
  const t = goal.trigger;
  switch (t.type) {
    case 'time':
      return `${t.time}${goal.lifecycle.repeat !== 'once' ? ` (${goal.lifecycle.repeat})` : '（一次）'}`;
    case 'interval':
      return `每 ${t.intervalSeconds}s`;
    case 'cron':
      return `Cron: ${t.cron}`;
    case 'event':
      return '事件触发';
    default:
      return t.type;
  }
}
