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
// 历史持久化（复用 task-poller.ts 的 appendHistory 模式）
// ================================================================

interface HistoryEntry {
  goalId: string;
  runAt: string;
  action: string;
  durationMs: number;
  error?: string;
}

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

  let entries: HistoryEntry[] = [];
  try {
    if (fs.existsSync(historyPath)) {
      entries = JSON.parse(fs.readFileSync(historyPath, 'utf-8'));
    }
  } catch {
    // 文件损坏，从头开始
  }

  entries.push({
    goalId,
    runAt: new Date().toISOString(),
    action,
    durationMs,
    ...(error ? { error } : {}),
  });

  // 保留最近 N 条
  if (entries.length > MAX_HISTORY) {
    entries = entries.slice(-MAX_HISTORY);
  }

  try {
    const dir = path.dirname(historyPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const tmpPath = `${historyPath}.tmp`;
    fs.writeFileSync(tmpPath, JSON.stringify(entries, null, 2), 'utf-8');
    fs.renameSync(tmpPath, historyPath);
  } catch (e: any) {
    console.error('[GoalEngine] Failed to write history:', e.message);
  }
}

// ================================================================
// GoalEngine — 执行引擎
// ================================================================

export interface GoalExecuteContext {
  /** Agent 执行接口（由调用方注入） */
  executeAgent: (
    prompt: string,
    options?: { systemPrompt?: string; model?: string; timeoutMs?: number; tools?: object[] },
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

    // v1 串行执行（Q7 决策）
    for (const goal of dueGoals) {
      // 检查锁
      if (this.store.isLocked(goal.id)) {
        console.log(`[GoalEngine] Goal ${goal.id} is locked, skipping`);
        continue;
      }

      try {
        await this.executeGoal(goal, stats);
      } catch (e: any) {
        console.error(`[GoalEngine] Unhandled error executing ${goal.id}:`, e.message);
        this.store.markFailed(goal.id, e.message);
        writeGoalHistory(goal.id, 'failed', 0, e.message, this.ctx.workspaceDir);
        stats.failedCount++;
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
   * 执行单个 Goal
   */
  private async executeGoal(goal: Goal, stats: GoalEngineStats): Promise<void> {
    const timeoutMs = this.ctx.timeoutMs || 60_000;
    const startMs = Date.now();

    // 获取执行锁
    const lock = this.store.acquireLock(goal.id);
    if (!lock) {
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

      // 调 Agent（带超时保护）
      let reply: string;
      try {
        const agentPromise = this.ctx.executeAgent(prompt, {
          timeoutMs,
          ...(tools && tools.length > 0 ? { tools } : {}),
        });
        reply = await Promise.race([
          agentPromise,
          new Promise<string>((_, reject) =>
            setTimeout(() => reject(new Error('execution_timeout')), timeoutMs),
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
        this.store.markDone(goal.id);
        if (goal.lifecycle.repeat !== 'once') {
          this.store.reschedule(goal.id);
        }
        writeGoalHistory(goal.id, 'done', durationMs, undefined, this.ctx.workspaceDir);
        console.log(`[GoalEngine] Goal ${goal.id} done (${durationMs}ms)`);
        break;

      case 'skip':
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
        this.store.markFailed(goal.id, error || 'unknown');
        writeGoalHistory(goal.id, 'failed', durationMs, error, this.ctx.workspaceDir);
        console.error(`[GoalEngine] Goal ${goal.id} failed: ${error}`);
        break;

      case 'unknown':
      default:
        // 无明确标记，视为异常（Q13: v1 只精确匹配）
        this.store.markFailed(goal.id, 'no GOAL_DONE/SKIP/FAILED marker in reply');
        writeGoalHistory(
          goal.id,
          'unknown',
          durationMs,
          'no status marker',
          this.ctx.workspaceDir,
        );
        console.warn(`[GoalEngine] Goal ${goal.id}: no status marker in reply`);
        break;
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
