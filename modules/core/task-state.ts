// ================================================================
// TaskState — 任务状态独立持久化
// ================================================================
// Phase 1 重构：将 heartbeatTaskState 从 session 中解耦，
// 持久化到独立的 JSON 文件，不依赖心跳 session。
// ================================================================

import * as fs from 'fs';
import * as path from 'path';
import type { TaskRunState } from './types';

const TASK_STATE_FILE = 'task_state.json';

export interface TaskStateEntry {
  lastRunAt: number;
  runCount: number;
  createdAt: number;
  elapsedMs?: number;
  startedAt?: number;
  lastResult?: 'success' | 'timeout' | 'error';
  lastError?: string;
  /** P1-3: 进程重启时标记，表示任务可能在重启前正在执行 */
  interrupted?: boolean;
  /** Task Observability: 最近 N 条执行历史 */
  history?: Array<{
    runAt: string;
    durationMs?: number;
    result?: string;
    error?: string;
    deliveryChatId?: string;
    [key: string]: unknown;
  }>;
}

export class TaskState {
  private states: Map<string, TaskStateEntry> = new Map();
  private filePath: string;

  constructor(filePath?: string) {
    this.filePath = filePath ?? path.join(process.env.HOME ?? '~', '.imtoagent', TASK_STATE_FILE);
    this.load();
  }

  /**
   * 获取任务状态
   */
  get(name: string): TaskStateEntry | undefined {
    return this.states.get(name);
  }

  /**
   * 设置任务状态
   */
  set(name: string, state: TaskStateEntry): void {
    this.states.set(name, state);
    this.persist();
  }

  /**
   * 删除任务状态
   */
  delete(name: string): boolean {
    const removed = this.states.delete(name);
    if (removed) this.persist();
    return removed;
  }

  /**
   * 获取所有状态
   */
  getAll(): ReadonlyMap<string, TaskStateEntry> {
    return this.states;
  }

  /**
   * 兼容旧版 number 类型状态
   */
  getCompatible(name: string): TaskRunState {
    const entry = this.states.get(name);
    if (!entry) {
      return { lastRunAt: 0, runCount: 0, createdAt: Date.now() };
    }
    return { ...entry, createdAt: entry.createdAt || Date.now() };
  }

  /**
   * Task Observability: 追加执行历史（最多保留 20 条）
   */
  appendHistory(name: string, entry: {
    runAt: string;
    durationMs?: number;
    result?: string;
    error?: string;
    deliveryChatId?: string;
    [key: string]: unknown;
  }): void {
    const state = this.states.get(name);
    if (!state) return;
    if (!state.history) state.history = [];
    state.history.push(entry);
    // 保留最近 20 条
    if (state.history.length > 20) {
      state.history = state.history.slice(-20);
    }
    this.persist();
  }

  // ================================================================
  // 私有方法
  // ================================================================

  private load(): void {
    try {
      if (!fs.existsSync(this.filePath)) {
        const dir = path.dirname(this.filePath);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        this.persist();
        return;
      }

      const raw = fs.readFileSync(this.filePath, 'utf-8');
      const data = JSON.parse(raw);
      this.states = new Map(Object.entries(data.states ?? {}));
    } catch (err) {
      console.error('[TaskState] Failed to load, starting fresh:', err);
      this.states = new Map();
    }
  }

  private persist(): void {
    try {
      const dir = path.dirname(this.filePath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

      const data = {
        version: 2,
        updatedAt: new Date().toISOString(),
        states: Object.fromEntries(this.states),
      };

      const tmpPath = `${this.filePath}.tmp`;
      fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), 'utf-8');
      fs.renameSync(tmpPath, this.filePath);
    } catch (err) {
      console.error('[TaskState] Failed to persist:', err);
    }
  }
}
