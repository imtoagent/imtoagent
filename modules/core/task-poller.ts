// ================================================================
// TaskPoller — 统一调度层（Phase 1）
// ================================================================
// 用 isTaskDue() 驱动所有任务类型，替代 setTimeout 单任务计时器。
// - 单一 setInterval 轮询（默认 1s）
// - 到期判断统一走 isTaskDue()
// - 任务状态持久化在 session.heartbeatTaskState
// - 支持 interval / once / scheduled / countdown / conditional
// ================================================================

import type { ScheduledTask, TaskRunState, Session } from './types';
import { isTaskDue, parseHeartbeatTasks, parseInterval } from './heartbeat';

export interface TaskPollerConfig {
  /** 轮询间隔（毫秒），默认 1000 */
  tickMs?: number;
  /** 任务执行回调 */
  onTaskFire: (task: ScheduledTask, session: Session) => Promise<void>;
  /** 任务完成回调（once 执行完毕 / countdown 达限后，由调度器触发文件删除） */
  onTaskComplete?: (task: ScheduledTask, session: Session) => void;
  /** 获取当前 session（用于读写 heartbeatTaskState） */
  getSession: () => Session | undefined;
  /** 锁超时时间（毫秒），默认 120000（2 分钟） */
  lockTimeoutMs?: number;
  /** 锁超时回调（任务持有锁超过 lockTimeoutMs 时触发） */
  onTaskTimeout?: (task: ScheduledTask, session: Session) => void;
  /** 工作目录（用于 history_file 路径） */
  workspaceDir?: string;
}

export interface TaskPollerEntry {
  task: ScheduledTask;
  /** 任务创建时间戳（once/after 需要） */
  createdAt: number;
}

export interface TaskStatus {
  name: string;
  type: string;
  lastRunAt: number;
  runCount: number;
  locked: boolean;
  nextTriggerEstimate?: string;
}

export class TaskPoller {
  private config: TaskPollerConfig;
  private tasks: Map<string, TaskPollerEntry> = new Map();
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  /** 等待完成的异步任务，stop() 时等待 */
  private inFlight = new Set<Promise<void>>();

  // === Phase 2: 任务级互斥锁 ===
  private taskLocks: Map<string, { acquiredAt: number }> = new Map();

  constructor(config: TaskPollerConfig) {
    this.config = config;
  }

  /**
   * 启动轮询器
   */
  start(): void {
    if (this.running) return;
    this.running = true;

    const tickMs = this.config.tickMs ?? 1000;
    console.log(`[TaskPoller] Started (tick=${tickMs}ms)`);

    this.timer = setInterval(() => this.tick(), tickMs);
  }

  /**
   * 停止轮询器（等待所有 in-flight 任务完成）
   */
  async stop(): Promise<void> {
    this.running = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    // 等待所有正在执行的任务完成
    if (this.inFlight.size > 0) {
      console.log(`[TaskPoller] Waiting for ${this.inFlight.size} in-flight task(s) to complete...`);
      await Promise.allSettled(this.inFlight);
    }
    this.taskLocks.clear();
    console.log('[TaskPoller] Stopped');
  }

  /**
   * Phase 2: 获取锁状态（供外部调试/监控）
   */
  getLockStatus(): ReadonlyMap<string, { acquiredAt: number }> {
    return this.taskLocks;
  }

  /**
   * P2-4: 获取所有任务状态
   */
  getTaskStatus(): TaskStatus[] {
    const session = this.config.getSession();
    const now = Date.now();
    const results: TaskStatus[] = [];

    for (const [name, entry] of this.tasks) {
      const task = entry.task;
      const state = session?.heartbeatTaskState?.[name];
      const runState = this.normalizeState(state, entry.createdAt);

      const status: TaskStatus = {
        name,
        type: task.type ?? 'interval',
        lastRunAt: runState.lastRunAt,
        runCount: runState.runCount,
        locked: this.taskLocks.has(name),
      };

      // 估算下次触发时间
      if (task.type === 'interval' && task.interval) {
        const intervalMs = parseInterval(task.interval);
        if (intervalMs && runState.lastRunAt > 0) {
          const nextAt = runState.lastRunAt + intervalMs;
          status.nextTriggerEstimate = this.formatRelative(nextAt, now);
        } else if (intervalMs) {
          status.nextTriggerEstimate = `~${task.interval}`;
        }
      } else if (task.type === 'countdown' && task.interval) {
        const intervalMs = parseInterval(task.interval);
        if (intervalMs && runState.lastRunAt > 0) {
          status.nextTriggerEstimate = this.formatRelative(runState.lastRunAt + intervalMs, now);
        }
      } else if (task.type === 'conditional' && task.interval) {
        const intervalMs = parseInterval(task.interval);
        if (intervalMs && runState.lastRunAt > 0) {
          status.nextTriggerEstimate = this.formatRelative(runState.lastRunAt + intervalMs, now);
        }
      } else if (task.type === 'scheduled' && task.at) {
        status.nextTriggerEstimate = `每天 ${task.at}`;
        if (task.on) status.nextTriggerEstimate += ` (${task.on})`;
      }

      results.push(status);
    }

    return results;
  }

  private formatRelative(ts: number, now: number): string {
    const diff = ts - now;
    if (diff < 0) return '已过';
    const mins = Math.round(diff / 60000);
    if (mins < 1) return '< 1分钟';
    if (mins < 60) return `~${mins}分钟后`;
    const hours = Math.round(mins / 60);
    if (hours < 24) return `~${hours}小时后`;
    return `~${Math.round(hours / 24)}天后`;
  }

  /**
   * 同步任务列表（从 HEARTBEAT.md 内容解析）
   * - 新增任务加入
   * - 消失任务移除
   * - 已存在任务跳过（保留 createdAt）
   * @param botName 当前 Bot 名称，用于 bot 字段过滤
   */
  syncTasks(heartbeatMd: string, botName?: string): void {
    let parsed = parseHeartbeatTasks(heartbeatMd);
    // P2-2: bot 字段过滤
    if (botName) {
      parsed = parsed.filter(t => !t.bot || t.bot === botName);
    }
    const currentNames = new Set(this.tasks.keys());
    const desiredNames = new Set(parsed.map(t => t.name));

    // 移除已消失的任务
    for (const name of currentNames) {
      if (!desiredNames.has(name)) {
        this.tasks.delete(name);
        console.log(`[TaskPoller] Removed task: ${name}`);
      }
    }

    // 加入新任务
    const session = this.config.getSession();
    for (const task of parsed) {
      if (!this.tasks.has(task.name)) {
        // 先从 session 恢复 createdAt（如果存在），否则用当前时间
        let createdAt = Date.now();
        if (session?.heartbeatTaskState?.[task.name]) {
          const existing = session.heartbeatTaskState[task.name];
          const runState = this.normalizeState(existing, createdAt);
          if (runState.createdAt > 0) createdAt = runState.createdAt;
        }
        this.tasks.set(task.name, {
          task,
          createdAt,
        });
        console.log(`[TaskPoller] Added task: ${task.name} (${task.type || 'interval'}, createdAt=${createdAt})`);
      } else {
        // 更新任务定义（保留 createdAt）
        const entry = this.tasks.get(task.name)!;
        entry.task = task;
      }
    }

    // 将新任务的 createdAt 持久化到 session
    if (session?.heartbeatTaskState) {
      for (const task of parsed) {
        const entry = this.tasks.get(task.name);
        if (entry) {
          const existing = session.heartbeatTaskState[task.name];
          if (!existing) {
            session.heartbeatTaskState[task.name] = {
              lastRunAt: 0,
              runCount: 0,
              createdAt: entry.createdAt,
            };
          }
        }
      }
    }
  }

  /**
   * 轮询：检查所有任务是否到期
   */
  private tick(): void {
    if (!this.running || this.tasks.size === 0) return;

    const session = this.config.getSession();
    if (!session) return;

    // 确保 heartbeatTaskState 存在
    if (!session.heartbeatTaskState) {
      session.heartbeatTaskState = {};
    }

    const now = Date.now();

    for (const [name, entry] of this.tasks) {
      const task = entry.task;
      const stateKey = name;
      const existingState = session.heartbeatTaskState![stateKey];
      const runState = this.normalizeState(existingState, entry.createdAt);
      const lastRunAt = runState.lastRunAt > 0 ? runState.lastRunAt : undefined;

      // Phase 2: 检查任务锁 + 超时
      const lock = this.taskLocks.get(name);
      if (lock) {
        const lockTimeoutMs = this.config.lockTimeoutMs ?? 120_000;
        const lockDuration = now - lock.acquiredAt;
        if (lockDuration > lockTimeoutMs) {
          // 锁超时：强制释放
          console.warn(`[TaskPoller] Task ${name} lock timed out (${Math.round(lockDuration / 1000)}s > ${Math.round(lockTimeoutMs / 1000)}s), force-releasing`);
          this.taskLocks.delete(name);
          // 更新 lastRunAt 防止下次 tick 立即重复触发
          session.heartbeatTaskState![stateKey] = { ...runState, lastRunAt: now };
          // 通知调度器处理超时
          if (this.config.onTaskTimeout) {
            this.config.onTaskTimeout(task, session);
          }
        }
        continue;
      }

      const due = isTaskDue(task, lastRunAt, now, entry.createdAt, runState.runCount);

      if (due.due) {
        // 获取锁
        this.taskLocks.set(name, { acquiredAt: now });

        // 跟踪 in-flight 任务
        const promise = this.fireTask(entry, session, stateKey, runState).finally(() => {
          this.inFlight.delete(promise);
          this.taskLocks.delete(name); // 释放锁
        });
        this.inFlight.add(promise);
        promise.catch(err => {
          console.error(`[TaskPoller] Error firing task ${name}:`, err.message);
          this.taskLocks.delete(name); // 异常时也要释放锁
        });
      }
    }
  }

  /**
   * 触发单个任务执行
   */
  private async fireTask(
    entry: TaskPollerEntry,
    session: Session,
    stateKey: string,
    runState: TaskRunState,
  ): Promise<void> {
    const task = entry.task;
    const now = Date.now();

    // P4-3: stopwatch 开始计时
    const isStopwatch = task.type === 'stopwatch';
    const newState: TaskRunState = {
      lastRunAt: now,
      runCount: runState.runCount + 1,
      createdAt: runState.createdAt || now,
      startedAt: isStopwatch ? now : runState.startedAt,
      elapsedMs: isStopwatch ? (runState.elapsedMs || 0) : runState.elapsedMs,
    };
    session.heartbeatTaskState![stateKey] = newState;

    const fireStart = Date.now();
    let result: 'success' | 'timeout' | 'error' = 'success';
    let lastError: string | undefined;

    try {
      // 执行回调
      await this.config.onTaskFire(task, session);
    } catch (err: unknown) {
      result = 'error';
      lastError = err.message || String(err);
      throw err;
    } finally {
      const fireDuration = Date.now() - fireStart;
      // P4-3: 累加 stopwatch 时间
      if (isStopwatch) {
        newState.elapsedMs = (newState.elapsedMs || 0) + fireDuration;
        session.heartbeatTaskState![stateKey] = newState;
      }
      // P4-4: 记录执行结果
      newState.lastResult = result;
      newState.lastError = lastError;
      session.heartbeatTaskState![stateKey] = newState;

      // 执行完成后，检查是否需要自动删除
      this.handleTaskCompletion(entry, session, stateKey, newState);

      // P4-4: 持久化历史记录
      if (task.history_file) {
        this.appendHistory(task, now, fireDuration, result, lastError);
      }
    }
  }

  /**
   * 任务执行完毕后，判断是否需要自动删除（once 完成后 / countdown 达限后）
   */
  private handleTaskCompletion(
    entry: TaskPollerEntry,
    session: Session,
    stateKey: string,
    runState: TaskRunState,
  ): void {
    const task = entry.task;

    // once 任务：执行一次后标记为待删除
    if (task.type === 'once') {
      this.tasks.delete(entry.task.name);
      if (this.config.onTaskComplete) {
        this.config.onTaskComplete(task, session);
      }
      console.log(`[TaskPoller] once task completed, removed from poller: ${task.name}`);
      return;
    }

    // countdown 任务：达到 max_runs 后标记为待删除
    if (task.type === 'countdown' && task.max_runs !== undefined) {
      if (runState.runCount >= task.max_runs) {
        this.tasks.delete(entry.task.name);
        if (this.config.onTaskComplete) {
          this.config.onTaskComplete(task, session);
        }
        console.log(`[TaskPoller] countdown task reached max_runs (${task.max_runs}), removed: ${task.name}`);
        return;
      }
    }

    // countdown 任务：已过 deadline 后标记为待删除
    if (task.type === 'countdown' && task.deadline) {
      const deadlineTime = this.parseDateTime(task.deadline);
      if (!isNaN(deadlineTime) && Date.now() >= deadlineTime) {
        this.tasks.delete(entry.task.name);
        if (this.config.onTaskComplete) {
          this.config.onTaskComplete(task, session);
        }
        console.log(`[TaskPoller] countdown task passed deadline, removed: ${task.name}`);
        return;
      }
    }

    // P4-1: 任务链 — 完成后触发下游任务
    if (task.on_complete) {
      this.triggerDownstream(task.on_complete, session, new Set([task.name]), 1);
    }
  }

  /**
   * 规范化状态（兼容 number 类型和 undefined）
   */
  private normalizeState(
    state: number | TaskRunState | undefined,
    createdAt: number,
  ): TaskRunState {
    if (state === undefined) {
      return { lastRunAt: 0, runCount: 0, createdAt };
    }
    if (typeof state === 'number') {
      return { lastRunAt: state, runCount: 1, createdAt: state || createdAt };
    }
    return { ...state, createdAt: state.createdAt || createdAt };
  }

  /**
   * 解析 YYYY-MM-DD HH:MM 为本地时间戳
   */
  private parseDateTime(str: string): number {
    const match = str.match(/^(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2})$/);
    if (!match) return NaN;
    const [, y, mo, d, h, mi] = match.map(Number);
    return new Date(y, mo - 1, d, h, mi).getTime();
  }

  /**
   * P4-1: 触发下游任务（任务链）
   * 最多 5 层链式触发，防止循环依赖
   */
  private triggerDownstream(
    downstreamName: string,
    session: Session,
    chain: Set<string>,
    depth: number,
  ): void {
    const MAX_DEPTH = 5;
    if (depth > MAX_DEPTH) {
      console.warn(`[TaskPoller] Task chain exceeded max depth (${MAX_DEPTH}), stopping at ${downstreamName}`);
      return;
    }
    if (chain.has(downstreamName)) {
      console.warn(`[TaskPoller] Circular task chain detected: ${downstreamName} already in chain [${[...chain].join(' → ')}]`);
      return;
    }

    const entry = this.tasks.get(downstreamName);
    if (!entry) {
      console.warn(`[TaskPoller] Downstream task "${downstreamName}" not found, skipping`);
      return;
    }

    const newChain = new Set([...chain, downstreamName]);
    console.log(`[TaskPoller] Chain trigger: ${[...chain].join(' → ')} → ${downstreamName} (depth ${depth})`);

    const now = Date.now();
    const stateKey = downstreamName;
    const existingState = session.heartbeatTaskState?.[stateKey];
    const runState = this.normalizeState(existingState, entry.createdAt);
    const newState: TaskRunState = {
      lastRunAt: now,
      runCount: runState.runCount + 1,
      createdAt: runState.createdAt || now,
    };
    if (session.heartbeatTaskState) session.heartbeatTaskState[stateKey] = newState;

    // 异步触发，不阻塞当前 tick
    this.fireTask(entry, session, stateKey, runState).finally(() => {
      this.taskLocks.delete(downstreamName);
      // 递归触发下游
      if (entry.task.on_complete) {
        this.triggerDownstream(entry.task.on_complete, session, newChain, depth + 1);
      }
    }).catch(err => {
      console.error(`[TaskPoller] Chain trigger error for ${downstreamName}:`, err.message);
    });
  }

  /**
   * P4-4: 持久化任务执行历史到 JSON 文件
   */
  private appendHistory(
    task: ScheduledTask,
    runAt: number,
    durationMs: number,
    result: 'success' | 'timeout' | 'error',
    error?: string,
  ): void {
    const workspaceDir = this.config.workspaceDir || '.';
    const historyPath = `${workspaceDir}/${task.history_file}`;
    const maxHistory = task.max_history || 50;

    let entries: Array<{
      runAt: string;
      durationMs: number;
      result: string;
      error?: string;
    }> = [];

    try {
      const existing = Bun.file(historyPath);
      if (existing.size > 0) {
        entries = JSON.parse(Bun.readFileSync(existing, 'utf8'));
      }
    } catch {}

    entries.push({
      runAt: new Date(runAt).toISOString(),
      durationMs,
      result,
      ...(error ? { error } : {}),
    });

    // 保留最近 N 条
    if (entries.length > maxHistory) {
      entries = entries.slice(-maxHistory);
    }

    try {
      Bun.write(historyPath, JSON.stringify(entries, null, 2));
    } catch (err) {
      console.error(`[TaskPoller] Failed to write history for ${task.name}:`, err.message);
    }
  }
}
