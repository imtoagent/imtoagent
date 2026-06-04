// ================================================================
// TaskPoller — 统一调度层（Phase 1 重构）
// ================================================================
// 用 isTaskDue() 驱动所有任务类型，替代 setTimeout 单任务计时器。
// - 单一 setInterval 轮询（默认 1s）
// - 到期判断统一走 isTaskDue()
// - 任务状态持久化到独立 JSON 文件（task_state.json）
// - 支持 interval / once / scheduled / countdown / conditional
// ================================================================

import * as fs from 'fs';
import * as path from 'path';
import type { ScheduledTask, TaskRunState } from './types';
import { isTaskDue, parseHeartbeatTasks, parseInterval } from './heartbeat';
import { TaskState } from './task-state';
import { appendHistory as appendHistoryUtil } from './scheduling-utils';

export interface TaskPollerConfig {
  /** 轮询间隔（毫秒），默认 1000 */
  tickMs?: number;
  /** 任务执行回调 */
  onTaskFire: (task: ScheduledTask) => Promise<void>;
  /** 任务完成回调（once 执行完毕 / countdown 达限后，由调度器触发文件删除） */
  onTaskComplete?: (task: ScheduledTask) => void;
  /** 任务错误回调（fireTask catch 分支调用） */
  onTaskError?: (task: ScheduledTask, error: Error) => void;
  /** 锁超时时间（毫秒），默认 120000（2 分钟） */
  lockTimeoutMs?: number;
  /** 锁超时回调（任务持有锁超过 lockTimeoutMs 时触发） */
  onTaskTimeout?: (task: ScheduledTask) => void;
  /** 工作目录（用于 history_file 路径） */
  workspaceDir?: string;
  /** 任务状态文件路径（可选，默认 ~/.imtoagent/task_state.json） */
  stateFilePath?: string;
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
  // === Phase 1 重构：独立任务状态持久化 ===
  private taskState: TaskState;
  // === Phase 2: 任务级互斥锁 ===
  private taskLocks: Map<string, { acquiredAt: number }> = new Map();

  constructor(config: TaskPollerConfig) {
    this.config = config;
    this.taskState = new TaskState(config.stateFilePath);
  }

  /**
   * 启动轮询器
   */
  start(): void {
    if (this.running) return;
    this.running = true;

    // P1-3: 检测进程重启前正在执行的任务
    this.detectInterruptedTasks();

    const tickMs = this.config.tickMs ?? 1000;
    console.log(`[TaskPoller] Started (tick=${tickMs}ms)`);

    this.timer = setInterval(() => this.tick(), tickMs);
  }

  /**
   * P1-3: 检测进程重启前可能正在执行的任务
   * 判断条件：lastResult === undefined && startedAt 存在（任务曾开始但未记录结果）
   */
  private detectInterruptedTasks(): void {
    for (const [name, entry] of this.tasks) {
      const runState = this.taskState.get(name);
      if (runState && runState.startedAt && !runState.lastResult) {
        // 任务曾开始执行但没有最终结果，标记为 interrupted
        runState.interrupted = true;
        this.taskState.set(name, runState);
        console.warn(`[TaskPoller] Detected interrupted task: ${name} (started at ${new Date(runState.startedAt).toISOString()}, no result recorded)`);
      }
    }
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

  /** P2-4: 暴露任务状态供调试 */
  getTaskState(): ReadonlyMap<string, TaskRunState> {
    return this.taskState.getAll();
  }

  /** P2-4: 获取所有任务状态 */
  getTaskStatus(): TaskStatus[] {
    const now = Date.now();
    const results: TaskStatus[] = [];

    for (const [name, entry] of this.tasks) {
      const task = entry.task;
      const runState = this.taskState.getCompatible(name);

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
   * P2-2: 原子读取防御（先复制再解析，避免读到不完整内容）
   * @param botName 当前 Bot 名称，用于 bot 字段过滤
   */
  syncTasks(heartbeatMd: string, botName?: string): void {
    // P2-2: 防御性编码 - 如果内容过长或包含不完整的 YAML 标记，跳过
    const content = heartbeatMd.trim();
    if (!content || content.length < 10) {
      // 空文件或内容过短，跳过
      return;
    }

    let parsed = parseHeartbeatTasks(content);
    // bot 字段过滤
    if (botName) {
      parsed = parsed.filter(t => !t.bot || t.bot === botName);
    }
    const currentNames = new Set(this.tasks.keys());
    const desiredNames = new Set(parsed.map(t => t.name));

    // 移除已消失的任务
    for (const name of currentNames) {
      if (!desiredNames.has(name)) {
        this.tasks.delete(name);
        this.taskState.delete(name);
        console.log(`[TaskPoller] Removed task: ${name}`);
      }
    }

    // 加入新任务
    for (const task of parsed) {
      if (!this.tasks.has(task.name)) {
        // 从独立状态文件恢复 createdAt（如果存在），否则用当前时间
        let createdAt = Date.now();
        const existingState = this.taskState.get(task.name);
        if (existingState && existingState.createdAt > 0) {
          createdAt = existingState.createdAt;
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
  }

  /**
   * 轮询：检查所有任务是否到期
   */
  private tick(): void {
    if (!this.running || this.tasks.size === 0) return;

    const now = Date.now();

    for (const [name, entry] of this.tasks) {
      const task = entry.task;
      const runState = this.taskState.getCompatible(name);
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
          this.taskState.set(name, { ...runState, lastRunAt: now });
          // 通知调度器处理超时
          if (this.config.onTaskTimeout) {
            this.config.onTaskTimeout(task);
          }
        }
        continue;
      }

      const due = isTaskDue(task, lastRunAt, now, entry.createdAt, runState.runCount);

      if (due.due) {
        // 获取锁
        this.taskLocks.set(name, { acquiredAt: now });

        // 跟踪 in-flight 任务
        const promise = this.fireTask(entry, name, runState).finally(() => {
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
    name: string,
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
    this.taskState.set(name, newState);

    const fireStart = Date.now();
    let result: 'success' | 'timeout' | 'error' = 'success';
    let lastError: string | undefined;

    try {
      // 执行回调
      await this.config.onTaskFire(task);
    } catch (err: unknown) {
      result = 'error';
      lastError = err instanceof Error ? err.message : String(err);
      // P1-2: 调用错误回调，不再静默失败
      const error = err instanceof Error ? err : new Error(String(err));
      if (this.config.onTaskError) {
        this.config.onTaskError(task, error);
      }
    } finally {
      const fireDuration = Date.now() - fireStart;
      // P4-3: 累加 stopwatch 时间
      if (isStopwatch) {
        newState.elapsedMs = (newState.elapsedMs || 0) + fireDuration;
        this.taskState.set(name, newState);
      }
      // P4-4: 记录执行结果
      newState.lastResult = result;
      newState.lastError = lastError;
      this.taskState.set(name, newState);

      // 执行完成后，检查是否需要自动删除
      this.handleTaskCompletion(entry, name, newState, result);

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
    name: string,
    runState: TaskRunState,
    result: 'success' | 'timeout' | 'error',
  ): void {
    const task = entry.task;

    // once 任务：仅在执行成功时删除，失败保留以便下次重试
    if (task.type === 'once' && result === 'success') {
      this.tasks.delete(entry.task.name);
      this.taskState.delete(name);
      if (this.config.onTaskComplete) {
        this.config.onTaskComplete(task);
      }
      console.log(`[TaskPoller] once task completed, removed from poller: ${task.name}`);
      return;
    }

    // once 任务失败：保留，下次心跳重试
    if (task.type === 'once' && result === 'error') {
      console.warn(`[TaskPoller] once task ${task.name} failed (${runState.lastError}), kept for retry`);
    }

    // countdown 任务：达到 max_runs 后标记为待删除
    if (task.type === 'countdown' && task.max_runs !== undefined) {
      if (runState.runCount >= task.max_runs) {
        this.tasks.delete(entry.task.name);
        this.taskState.delete(name);
        if (this.config.onTaskComplete) {
          this.config.onTaskComplete(task);
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
        this.taskState.delete(name);
        if (this.config.onTaskComplete) {
          this.config.onTaskComplete(task);
        }
        console.log(`[TaskPoller] countdown task passed deadline, removed: ${task.name}`);
        return;
      }
    }

    // P4-1: 任务链 — 完成后触发下游任务
    if (task.on_complete) {
      this.triggerDownstream(task.on_complete, new Set([task.name]), 1);
    }
  }

  /**
   * P4-1: 触发下游任务（任务链）
   * 最多 5 层链式触发，防止循环依赖
   */
  private triggerDownstream(
    downstreamName: string,
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
    const runState = this.taskState.getCompatible(downstreamName);
    const newState: TaskRunState = {
      lastRunAt: now,
      runCount: runState.runCount + 1,
      createdAt: runState.createdAt || now,
    };
    this.taskState.set(downstreamName, newState);

    // 异步触发，不阻塞当前 tick
    this.fireTask(entry, downstreamName, runState).finally(() => {
      this.taskLocks.delete(downstreamName);
      // 递归触发下游
      if (entry.task.on_complete) {
        this.triggerDownstream(entry.task.on_complete, newChain, depth + 1);
      }
    }).catch(err => {
      console.error(`[TaskPoller] Chain trigger error for ${downstreamName}:`, err.message);
    });
  }

  /**
   * 解析 YYYY-MM-DD HH:MM 为时间戳（显式使用 Asia/Shanghai 时区）
   * P2-6: 避免依赖本地时区，确保跨环境一致性
   */
  private parseDateTime(str: string): number {
    const match = str.match(/^(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2})$/);
    if (!match) return NaN;
    const [, y, mo, d, h, mi] = match.map(Number);
    // 构造 ISO 字符串并显式指定 Asia/Shanghai 时区
    const isoStr = `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}T${String(h).padStart(2, '0')}:${String(mi).padStart(2, '0')}:00+08:00`;
    return new Date(isoStr).getTime();
  }

  /**
   * P4-4: 持久化任务执行历史到 JSON 文件
   * P2-1/P2-5: 使用共享工具函数 + fs 模块
   */
  private appendHistory(
    task: ScheduledTask,
    runAt: number,
    durationMs: number,
    result: 'success' | 'timeout' | 'error',
    error?: string,
  ): void {
    const workspaceDir = this.config.workspaceDir || '.';
    const historyPath = path.resolve(workspaceDir, task.history_file || '');
    const maxHistory = task.max_history || 50;

    const entry = {
      runAt: new Date(runAt).toISOString(),
      durationMs,
      result,
      ...(error ? { error } : {}),
    };

    appendHistoryUtil(historyPath, entry, maxHistory);
  }
}
