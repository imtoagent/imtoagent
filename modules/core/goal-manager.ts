// ================================================================
// Goal Manager — Goal 管理协议
// ================================================================
// Phase 2：解析用户对 Goal 的管理意图，执行管理操作
//
// Agent 回复格式（在 system prompt 中定义）：
//   GOAL_LIST              → 列出所有活跃 Goal
//   GOAL_CANCEL: <id>      → 取消 Goal
//   GOAL_PAUSE: <id>       → 暂停
//   GOAL_RESUME: <id>      → 恢复
//   GOAL_UPDATE: <id> <json> → 修改
// ================================================================

import type { Goal } from './goal-types';
import type { GoalStore } from './goal-store';

// ================================================================
// 解析函数
// ================================================================

export interface GoalManagementAction {
  action: 'list' | 'cancel' | 'pause' | 'resume' | 'update';
  goalId?: string;
  patch?: Record<string, unknown>;
}

/**
 * 从文本中解析 Goal 管理意图
 */
export function parseGoalManagement(text: string): GoalManagementAction | null {
  const patterns = [
    { regex: /GOAL_LIST/i, action: 'list' as const },
    { regex: /GOAL_CANCEL:\s*([\w-]+)/i, action: 'cancel' as const },
    { regex: /GOAL_PAUSE:\s*([\w-]+)/i, action: 'pause' as const },
    { regex: /GOAL_RESUME:\s*([\w-]+)/i, action: 'resume' as const },
    { regex: /GOAL_UPDATE:\s*([\w-]+)\s+([\s\S]+)/i, action: 'update' as const },
  ];

  for (const p of patterns) {
    const match = text.match(p.regex);
    if (match) {
      const result: GoalManagementAction = { action: p.action };
      if (p.action !== 'list') {
        result.goalId = match[1];
      }
      if (p.action === 'update' && match[2]) {
        try {
          // 尝试解析 JSON patch
          result.patch = JSON.parse(match[2].trim());
        } catch {
          // 如果 JSON 解析失败，尝试将整个剩余文本作为简单字符串
          result.patch = { _raw: match[2].trim() };
        }
      }
      return result;
    }
  }

  return null;
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
        ? new Date(g.lifecycle.nextRunAt).toLocaleString('zh-CN', {
            timeZone: 'Asia/Shanghai',
            month: 'numeric',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
          })
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
   * 暂停 Goal（将状态设为 failed 但保留，不再调度）
   */
  pauseGoal(goalId: string): { success: boolean; message: string } {
    const goal = this.goalStore.get(goalId);
    if (!goal) {
      return { success: false, message: `❌ Goal ${goalId} 不存在` };
    }
    if (goal.lifecycle.status === 'done' || goal.lifecycle.status === 'cancelled') {
      return { success: false, message: `❌ Goal ${goalId} 已结束（${goal.lifecycle.status}）` };
    }

    // 使用 update 来设置状态
    goal.lifecycle.status = 'cancelled';
    // 保存 paused 标记到 lastError 字段（v1 简化方案）
    goal.lifecycle.lastError = '_paused';
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
    if (goal.lifecycle.lastError !== '_paused') {
      return { success: false, message: `❌ Goal ${goalId} 不是暂停状态` };
    }

    // 恢复状态
    goal.lifecycle.status = 'pending';
    goal.lifecycle.lastError = undefined;
    // 重新计算 nextRunAt
    const now = new Date();
    if (goal.lifecycle.repeat === 'once') {
      goal.lifecycle.nextRunAt = now.toISOString();
    } else {
      goal.lifecycle.nextRunAt = now.toISOString();
    }
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
   * @returns 执行结果字符串，如果无管理指令则返回 null
   */
  processManagementCommand(text: string): string | null {
    const action = parseGoalManagement(text);
    if (!action) return null;

    switch (action.action) {
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
