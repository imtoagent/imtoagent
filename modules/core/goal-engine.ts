// ================================================================
// Goal Engine — 到期检测 + Prompt 构造 + Agent 调用 + 结果解析
// ================================================================
// Phase 1 Step 3：引擎核心模块
//
// 职责：
//   1. 到期检测（复用 GoalStore.getDue / isGoalDue）
//   2. 构造执行 Prompt
//   3. 调用 Agent 执行
//   4. 解析 GOAL_DONE / GOAL_SKIP / GOAL_FAILED
//   5. 更新状态 + 重新调度 + 写历史
//
// 复用现有 TaskSystem 组件：
//   - isGoalDue（goal-types.ts，内建）
//   - writeHistory 模式（参照 task-poller.ts 的 appendHistory）
// ================================================================

import * as fs from 'fs';
import * as path from 'path';
import type { Goal, GoalStatus } from './goal-types';
import { isGoalDue } from './goal-types';
import { GoalStore } from './goal-store';
import type { ToolRegistry } from '../agent/tool-registry';
import { appendHistory as appendHistoryUtil } from './scheduling-utils';

// ================================================================
// Prompt 构造
// ================================================================

/**
 * 为到期 Goal 构造 Agent 执行 Prompt
 */
export function buildGoalPrompt(goal: Goal): string {
  const lines: string[] = [];

  lines.push('⚠️ 条件目标触发');
  lines.push('');
  lines.push(`目标 ID: ${goal.id}`);
  lines.push(`目标类型: ${goal.type}`);
  lines.push(`触发条件: ${describeTrigger(goal)}`);

  if (goal.condition && goal.condition.type !== 'none') {
    lines.push(`判断条件: ${describeCondition(goal.condition)}`);
  }

  lines.push(`执行动作: ${describeAction(goal.action)}`);
  lines.push(`原始输入: ${goal.metadata.rawInput}`);
  lines.push('');
  lines.push('请执行:');

  if (goal.condition && goal.condition.type !== 'none') {
    lines.push('1. 判断条件是否满足');
    lines.push('2. 如果条件满足，执行动作');
    lines.push('3. 如果条件不满足，跳过本次');
  } else {
    lines.push('1. 执行动作');
  }

  lines.push('');
  lines.push('完成后回复：');
  lines.push(`- GOAL_DONE: ${goal.id}（执行成功）`);
  lines.push(`- GOAL_SKIP: ${goal.id}（条件不满足）`);
  lines.push(`- GOAL_FAILED: ${goal.id} <错误原因>（执行失败）`);

  return lines.join('\n');
}

function describeTrigger(goal: Goal): string {
  const t = goal.trigger;
  switch (t.type) {
    case 'time':
      return `每天 ${t.time}${t.leadMinutes ? `（提前 ${t.leadMinutes} 分钟）` : ''}`;
    case 'cron':
      return `Cron: ${t.cron}`;
    case 'interval':
      return `每 ${t.intervalSeconds} 秒`;
    case 'event':
      return '事件触发';
    default:
      return t.type;
  }
}

function describeCondition(c: NonNullable<Goal['condition']>): string {
  const op = c.operator || 'eq';
  return `${c.type}: ${JSON.stringify(c.params)} ${op} ${JSON.stringify(c.expected)}`;
}

function describeAction(a: Goal['action']): string {
  switch (a.type) {
    case 'send_message':
      return `发送消息: "${a.content}"`;
    case 'run_tool':
      return `运行工具: ${a.tool}${a.toolParams ? ' ' + JSON.stringify(a.toolParams) : ''}`;
    case 'tool_chain':
      return `工具链: ${(a.chain || []).length} 步`;
    default:
      return a.type;
  }
}

// ================================================================
// 结果解析
// ================================================================

export type GoalResultAction = 'done' | 'skip' | 'failed' | 'unknown';

export interface GoalResult {
  goalId: string;
  action: GoalResultAction;
  error?: string;
}

/**
 * 解析 Agent 回复中的 Goal 状态标记
 *
 * 优先级（v1）：
 * 1. 精确匹配 GOAL_DONE/SKIP/FAILED: <id>
 * 2. 无任何标记 → unknown（等下次重试）
 */
export function parseGoalResult(text: string, goalId: string): GoalResult {
  // 精确匹配（忽略大小写）
  const doneMatch = text.match(new RegExp(`GOAL_DONE:\\s*(${goalId})`, 'i'));
  if (doneMatch) return { goalId, action: 'done' };

  const skipMatch = text.match(new RegExp(`GOAL_SKIP:\\s*(${goalId})`, 'i'));
  if (skipMatch) return { goalId, action: 'skip' };

  const failedMatch = text.match(new RegExp(`GOAL_FAILED:\\s*(${goalId})\\s*(.*)`, 'i'));
  if (failedMatch) {
    return { goalId, action: 'failed', error: failedMatch[2]?.trim() || 'unknown' };
  }

  return { goalId, action: 'unknown' };
}

// ================================================================
// 历史持久化（P2-1: 使用共享工具函数）
// ================================================================

const GOALS_HISTORY_FILE = 'goals_history.json';
const MAX_HISTORY = 100;

/**
 * 追加 Goal 执行历史
 */
export function writeGoalHistory(
  goalId: string,
  action: string,
  durationMs: number,
  error?: string,
  workspaceDir?: string,
): void {
  // workspaceDir 可能已经是完整路径（如测试用的 TEST_DIR），直接在其下写文件
  const historyPath = workspaceDir
    ? path.join(workspaceDir, GOALS_HISTORY_FILE)
    : path.join(process.env.HOME || '.', '.imtoagent', GOALS_HISTORY_FILE);

  const entry = {
    goalId,
    runAt: new Date().toISOString(),
    action,
    durationMs,
    ...(error ? { error } : {}),
  };

  appendHistoryUtil(historyPath, entry, MAX_HISTORY);
}

// ================================================================
// GoalEngine — 执行引擎
// ================================================================

export interface GoalExecuteContext {
  /** Agent 执行接口（由调用方注入） */
  executeAgent: (
    prompt: string,
    options?: {
      systemPrompt?: string;
      model?: string;
      timeoutMs?: number;
      tools?: object[];
      cancelSignal?: AbortSignal;
    },
  ) => Promise<string>;

  /** 发送 IM 消息 */
  sendIM: (chatId: string, text: string) => Promise<void>;

  /** 工作目录（历史文件路径） */
  workspaceDir?: string;

  /** 默认超时（毫秒） */
  timeoutMs?: number;

  /** Phase 2: 工具注册中心（可选） */
  toolRegistry?: ToolRegistry;
}

export interface GoalEngineStats {
  /** 到期 Goal 数量 */
  dueCount: number;
  /** 实际执行数量 */
  executedCount: number;
  /** 成功数量 */
  doneCount: number;
  /** 跳过数量 */
  skipCount: number;
  /** 失败数量 */
  failedCount: number;
  /** 无标记数量 */
  unknownCount: number;
  /** 总耗时（毫秒） */
  totalDurationMs: number;
}

export class GoalEngine {
  private store: GoalStore;
  private ctx: GoalExecuteContext;

  constructor(store: GoalStore, ctx: GoalExecuteContext) {
    this.store = store;
    this.ctx = ctx;
  }

  /**
   * 处理所有到期 Goal
   *
   * 流程：
   * 1. getDue(now) 找到到期 Goal
   * 2. 逐个检查执行锁
   * 3. 获取锁 → markActive → 构造 Prompt → 调 Agent
   * 4. 解析回复 → 更新状态 → reschedule
   * 5. 释放锁 → 写历史
   *
   * P2-4: 并发执行（带信号量控制并发数，默认 3）
   */
  async processDueGoals(now?: Date): Promise<GoalEngineStats> {
    const dueGoals = this.store.getDue(now);
    const stats: GoalEngineStats = {
      dueCount: dueGoals.length,
      executedCount: 0,
      doneCount: 0,
      skipCount: 0,
      failedCount: 0,
      unknownCount: 0,
      totalDurationMs: 0,
    };

    if (dueGoals.length === 0) {
      return stats;
    }

    const overallStart = Date.now();

    // P2-4: 并发执行，带信号量控制并发数
    const CONCURRENCY_LIMIT = 3;
    const semaphore: Promise<void>[] = Array.from(
      { length: CONCURRENCY_LIMIT },
      () => Promise.resolve(),
    );

    // 每个 Goal 执行后返回局部统计结果
    const results = await Promise.allSettled(
      dueGoals.map(async (goal) => {
        // 检查锁
        if (this.store.isLocked(goal.id)) {
          console.log(`[GoalEngine] Goal ${goal.id} is locked, skipping`);
          return { action: 'skipped' as const };
        }

        // 信号量：等待可用槽位
        const slot = await Promise.race(semaphore);
        const slotIndex = semaphore.indexOf(slot);

        try {
          const result = await this.executeGoalWithResult(goal);
          return result;
        } catch (e: any) {
          console.error(`[GoalEngine] Unhandled error executing ${goal.id}:`, e.message);
          this.store.markFailed(goal.id, e.message);
          writeGoalHistory(goal.id, 'failed', 0, e.message, this.ctx.workspaceDir);
          return { action: 'failed' as const };
        } finally {
          // 释放槽位
          semaphore[slotIndex] = Promise.resolve();
        }
      }),
    );

    // 聚合统计结果
    for (const result of results) {
      if (result.status === 'fulfilled') {
        const { action } = result.value;
        stats.executedCount++;
        switch (action) {
          case 'done': stats.doneCount++; break;
          case 'skip': stats.skipCount++; break;
          case 'failed': stats.failedCount++; break;
          case 'unknown': stats.unknownCount++; break;
          case 'skipped': break;
        }
      } else {
        stats.failedCount++;
        stats.executedCount++;
      }
    }

    stats.totalDurationMs = Date.now() - overallStart;
    return stats;
  }

  /**
   * 根据 Goal 条件确定需要注入哪些工具
   */
  private resolveNeededTools(goal: Goal): string[] {
    const needed: string[] = [];
    if (goal.condition?.type === 'weather') {
      needed.push('get_weather');
    }
    return needed;
  }

  /**
   * P2-4: 执行单个 Goal 并返回结果（用于并发聚合）
   */
  private async executeGoalWithResult(goal: Goal): Promise<{ action: GoalResultAction | 'skipped' }> {
    const timeoutMs = this.ctx.timeoutMs || 60_000;
    const startMs = Date.now();
    const abortController = new AbortController();

    // 获取执行锁
    const lock = this.store.acquireLock(goal.id);
    if (!lock) {
      abortController.abort();
      console.log(`[GoalEngine] Goal ${goal.id} lock acquire failed`);
      return { action: 'skipped' };
    }

    // Phase 2: 按需注入工具
    const injectedTools: string[] = [];
    try {
      // 标记执行中
      this.store.markActive(goal.id);

      // Phase 2: 根据 Goal 条件注入所需工具
      if (this.ctx.toolRegistry) {
        const needed = this.resolveNeededTools(goal);
        if (needed.length > 0) {
          const actuallyInjected = this.ctx.toolRegistry.injectNeeded(needed);
          injectedTools.push(...actuallyInjected);
        }
      }

      // 构造 Prompt
      const prompt = buildGoalPrompt(goal);
      console.log(`[GoalEngine] Executing ${goal.id} (${goal.type}): ${goal.metadata.rawInput}`);

      // Phase 2: 获取已注入的工具列表（OpenAI 格式）
      const tools = this.ctx.toolRegistry?.getOpenAIFormat();

      // 调 Agent（带超时保护 + 真正取消）
      let reply: string;
      try {
        const agentPromise = this.ctx.executeAgent(prompt, {
          timeoutMs,
          cancelSignal: abortController.signal,
          ...(tools && tools.length > 0 ? { tools } : {}),
        });
        reply = await Promise.race([
          agentPromise,
          new Promise<string>((_, reject) =>
            setTimeout(() => {
              abortController.abort();
              reject(new Error('execution_timeout'));
            }, timeoutMs),
          ),
        ]);
      } catch (e: any) {
        const duration = Date.now() - startMs;
        console.error(`[GoalEngine] Agent execution failed for ${goal.id}:`, e.message);
        this.store.markFailed(goal.id, e.message);
        writeGoalHistory(goal.id, 'failed', duration, e.message, this.ctx.workspaceDir);
        return { action: 'failed' };
      }

      // 解析结果
      const result = parseGoalResult(reply, goal.id);
      const duration = Date.now() - startMs;

      // 处理结果
      await this.handleGoalResult(goal, result, reply, duration);

      return { action: result.action };
    } finally {
      // Phase 2: 清理注入的工具
      if (this.ctx.toolRegistry && injectedTools.length > 0) {
        this.ctx.toolRegistry.removeInjected(injectedTools);
      }
      // 确保清理 AbortController（防止孤儿进程）
      if (!abortController.signal.aborted) {
        abortController.abort();
      }
      // finally 确保释放锁
      this.store.releaseLock(goal.id);
    }
  }

  /**
   * 执行单个 Goal（保留向后兼容）
   */
  private async executeGoal(goal: Goal, _stats: GoalEngineStats): Promise<void> {
    await this.executeGoalWithResult(goal);
  }
    const timeoutMs = this.ctx.timeoutMs || 60_000;
    const startMs = Date.now();
    const abortController = new AbortController();

    // 获取执行锁
    const lock = this.store.acquireLock(goal.id);
    if (!lock) {
      abortController.abort();
      console.log(`[GoalEngine] Goal ${goal.id} lock acquire failed`);
      return;
    }

    // Phase 2: 按需注入工具
    const injectedTools: string[] = [];
    try {
      // 标记执行中
      this.store.markActive(goal.id);

      // Phase 2: 根据 Goal 条件注入所需工具
      if (this.ctx.toolRegistry) {
        const needed = this.resolveNeededTools(goal);
        if (needed.length > 0) {
          const actuallyInjected = this.ctx.toolRegistry.injectNeeded(needed);
          injectedTools.push(...actuallyInjected);
        }
      }

      // 构造 Prompt
      const prompt = buildGoalPrompt(goal);
      console.log(`[GoalEngine] Executing ${goal.id} (${goal.type}): ${goal.metadata.rawInput}`);

      // Phase 2: 获取已注入的工具列表（OpenAI 格式）
      const tools = this.ctx.toolRegistry?.getOpenAIFormat();

      // 调 Agent（带超时保护 + 真正取消）
      let reply: string;
      try {
        const agentPromise = this.ctx.executeAgent(prompt, {
          timeoutMs,
          cancelSignal: abortController.signal,
          ...(tools && tools.length > 0 ? { tools } : {}),
        });
        reply = await Promise.race([
          agentPromise,
          new Promise<string>((_, reject) =>
            setTimeout(() => {
              abortController.abort();
              reject(new Error('execution_timeout'));
            }, timeoutMs),
          ),
        ]);
      } catch (e: any) {
        const duration = Date.now() - startMs;
        console.error(`[GoalEngine] Agent execution failed for ${goal.id}:`, e.message);
        this.store.markFailed(goal.id, e.message);
        writeGoalHistory(goal.id, 'failed', duration, e.message, this.ctx.workspaceDir);
        stats.failedCount++;
        stats.executedCount++;
        return;
      }

      // 解析结果
      const result = parseGoalResult(reply, goal.id);
      const duration = Date.now() - startMs;
      stats.executedCount++;

      // 处理结果
      await this.handleGoalResult(goal, result, reply, duration);

      // 统计
      switch (result.action) {
        case 'done': stats.doneCount++; break;
        case 'skip': stats.skipCount++; break;
        case 'failed': stats.failedCount++; break;
        case 'unknown': stats.unknownCount++; break;
      }
    } finally {
      // Phase 2: 清理注入的工具
      if (this.ctx.toolRegistry && injectedTools.length > 0) {
        this.ctx.toolRegistry.removeInjected(injectedTools);
      }
      // 确保清理 AbortController（防止孤儿进程）
      if (!abortController.signal.aborted) {
        abortController.abort();
      }
      // finally 确保释放锁
      this.store.releaseLock(goal.id);
    }
  }

  /**
   * 处理 Goal 执行结果
   */
  private async handleGoalResult(
    goal: Goal,
    result: { goalId: string; action: GoalResultAction; error?: string },
    reply: string,
    durationMs: number,
  ): Promise<void> {
    const { action, error } = result;

    switch (action) {
      case 'done':
        // 重置 unknown 计数器
        if (goal.metadata.consecutiveUnknowns) {
          delete goal.metadata.consecutiveUnknowns;
        }
        this.store.markDone(goal.id);
        if (goal.lifecycle.repeat !== 'once') {
          this.store.reschedule(goal.id);
        }
        writeGoalHistory(goal.id, 'done', durationMs, undefined, this.ctx.workspaceDir);
        console.log(`[GoalEngine] Goal ${goal.id} done (${durationMs}ms)`);
        break;

      case 'skip':
        // 重置 unknown 计数器
        if (goal.metadata.consecutiveUnknowns) {
          delete goal.metadata.consecutiveUnknowns;
        }
        if (goal.lifecycle.repeat !== 'once') {
          this.store.reschedule(goal.id);
        } else {
          // once 类型，skip 也视为 done
          this.store.markDone(goal.id);
        }
        writeGoalHistory(goal.id, 'skip', durationMs, undefined, this.ctx.workspaceDir);
        console.log(`[GoalEngine] Goal ${goal.id} skipped (${durationMs}ms)`);
        break;

      case 'failed':
        // 显式失败（Agent 正确回复了 GOAL_FAILED），重置 unknown 计数器
        if (goal.metadata.consecutiveUnknowns) {
          delete goal.metadata.consecutiveUnknowns;
        }
        this.store.markFailed(goal.id, error || 'unknown');
        writeGoalHistory(goal.id, 'failed', durationMs, error, this.ctx.workspaceDir);
        console.error(`[GoalEngine] Goal ${goal.id} failed: ${error}`);
        break;

      case 'unknown':
      default: {
        // 无明确标记 — Agent 回复格式不匹配
        // 可重复 Goal 应当 reschedule 下次重试，不永久卡死
        const consecutiveUnknowns = (goal.metadata.consecutiveUnknowns ?? 0) + 1;
        const maxUnknowns = goal.lifecycle.maxUnknowns ?? 3;

        if (goal.lifecycle.repeat !== 'once' && consecutiveUnknowns < maxUnknowns) {
          goal.metadata.consecutiveUnknowns = consecutiveUnknowns;
          this.store.reschedule(goal.id);
          console.warn(
            `[GoalEngine] Goal ${goal.id}: unknown reply (${consecutiveUnknowns}/${maxUnknowns}), rescheduled for retry`,
          );
        } else {
          // once 类型或连续 unknown 超限，标记永久失败
          this.store.markFailed(
            goal.id,
            consecutiveUnknowns >= maxUnknowns
              ? `consecutive unknown replies (${consecutiveUnknowns})`
              : 'no GOAL_DONE/SKIP/FAILED marker in reply',
          );
          console.error(`[GoalEngine] Goal ${goal.id}: permanently failed after unknown reply`);
        }
        writeGoalHistory(
          goal.id,
          'unknown',
          durationMs,
          `no status marker (${consecutiveUnknowns}/${maxUnknowns})`,
          this.ctx.workspaceDir,
        );
        break;
      }
    }

    // 如果 action 是 send_message，需要将消息发送到 IM
    // Agent 可能已经在回复中包含了消息内容，也可能没有
    if (goal.action.type === 'send_message' && action === 'done') {
      const targetChatId = goal.action.target || goal.metadata.sourceChatId;
      const content = goal.action.content || '';
      if (content) {
        try {
          await this.ctx.sendIM(targetChatId, content);
        } catch (e: any) {
          console.error(`[GoalEngine] Failed to send IM for ${goal.id}:`, e.message);
        }
      }
    }
  }

  // ================================================================
  // 查询接口（供调试/管理协议使用）
  // ================================================================

  /** 获取所有活跃 Goal */
  getActiveGoals() {
    return this.store.getActive();
  }

  /** 获取到期 Goal 列表（不执行） */
  getDueGoals(now?: Date) {
    return this.store.getDue(now);
  }
}
