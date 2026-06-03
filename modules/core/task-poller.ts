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
import { isTaskDue, parseHeartbeatTasks } from './heartbeat';

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
}

export interface TaskPollerEntry {
  task: ScheduledTask;
  /** 任务创建时间戳（once/after 需要） */
  createdAt: number;
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
   * 同步任务列表（从 HEARTBEAT.md 内容解析）
   * - 新增任务加入
   * - 消失任务移除
   * - 已存在任务跳过（保留 createdAt）
   */
  syncTasks(heartbeatMd: string): void {
    const parsed = parseHeartbeatTasks(heartbeatMd);
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

      const due = isTaskDue(task, lastRunAt, now, entry.createdAt);

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

    // 更新状态
    const newState: TaskRunState = {
      lastRunAt: now,
      runCount: runState.runCount + 1,
      createdAt: runState.createdAt || now,
    };
    session.heartbeatTaskState![stateKey] = newState;

    try {
      // 执行回调
      await this.config.onTaskFire(task, session);
    } finally {
      // 执行完成后，检查是否需要自动删除
      this.handleTaskCompletion(entry, session, stateKey, newState);
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
}
