// ================================================================
// TaskLogger — 定时任务可观测日志系统
// ================================================================
// 写入 NDJSON 事件流到 task_events.jsonl
// 提供查询和汇总能力
// ================================================================

import * as fs from 'fs';
import * as path from 'path';

export type TaskEventType =
  | 'task.created'
  | 'task.scheduled'
  | 'task.started'
  | 'task.completed'
  | 'task.failed'
  | 'task.skipped'
  | 'task.timeout'
  | 'task.retry'
  | 'task.deleted'
  | 'task.interrupted'
  | 'task.delivered';

export interface TaskEvent {
  ts: string;
  event: TaskEventType;
  name: string;
  [key: string]: unknown;
}

export interface QueryOptions {
  name?: string;
  event?: TaskEventType;
  since?: string; // ISO 8601
  until?: string; // ISO 8601
  last?: number; // 最近 N 条
}

export interface TaskSummary {
  totalTasks: number;
  todaySuccess: number;
  todayFailed: number;
  todaySkipped: number;
  todayDelivered: number;
  taskDetails: {
    name: string;
    lastEvent: TaskEventType;
    lastEventAt: string;
  }[];
}

const TASK_EVENTS_FILE = 'task_events.jsonl';
const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB 软上限

export class TaskLogger {
  private static filePath: string | null = null;

  static init(dataDir?: string): void {
    const resolved = dataDir ?? path.join(process.env.HOME ?? '', '.imtoagent');
    const logsDir = path.join(resolved, 'logs');
    if (!fs.existsSync(logsDir)) {
      fs.mkdirSync(logsDir, { recursive: true });
    }
    this.filePath = path.join(logsDir, TASK_EVENTS_FILE);
  }

  static log(event: TaskEvent): void {
    if (!this.filePath) {
      // 尝试从默认路径推断
      this.filePath = path.join(
        process.env.HOME ?? '~',
        '.imtoagent',
        'logs',
        TASK_EVENTS_FILE,
      );
      const logsDir = path.dirname(this.filePath);
      if (!fs.existsSync(logsDir)) {
        try {
          fs.mkdirSync(logsDir, { recursive: true });
        } catch {
          console.error('[TaskLogger] Failed to create logs directory');
          return;
        }
      }
    }

    if (!event.ts) {
      event.ts = new Date().toISOString();
    }

    const line = JSON.stringify(event) + '\n';

    try {
      // 检查文件大小，超过上限时截断
      if (fs.existsSync(this.filePath)) {
        const stat = fs.statSync(this.filePath);
        if (stat.size > MAX_FILE_SIZE) {
          this.truncateOldest();
        }
      }

      // 追加写入
      fs.appendFileSync(this.filePath, line, 'utf-8');
    } catch (err) {
      console.error('[TaskLogger] Failed to write event:', err);
    }
  }

  static query(options: QueryOptions = {}): TaskEvent[] {
    if (!this.filePath || !fs.existsSync(this.filePath)) {
      return [];
    }

    try {
      const raw = fs.readFileSync(this.filePath, 'utf-8');
      const lines = raw.trim().split('\n').filter(l => l.trim().length > 0);
      let events: TaskEvent[] = lines.map(l => JSON.parse(l));

      if (options.name) {
        events = events.filter(e => e.name === options.name);
      }
      if (options.event) {
        events = events.filter(e => e.event === options.event);
      }
      if (options.since) {
        const sinceTs = new Date(options.since).getTime();
        events = events.filter(e => new Date(e.ts).getTime() >= sinceTs);
      }
      if (options.until) {
        const untilTs = new Date(options.until).getTime();
        events = events.filter(e => new Date(e.ts).getTime() <= untilTs);
      }
      if (options.last) {
        events = events.slice(-options.last);
      }

      return events;
    } catch (err) {
      console.error('[TaskLogger] Query failed:', err);
      return [];
    }
  }

  static summary(since?: string): TaskSummary {
    const events = this.query(since ? { since } : {});
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const todayTs = todayStart.getTime();

    const todayEvents = events.filter(e => new Date(e.ts).getTime() >= todayTs);
    const taskNames = new Set(events.map(e => e.name));

    const taskDetails: { name: string; lastEvent: TaskEventType; lastEventAt: string }[] = [];
    for (const name of taskNames) {
      const taskEvents = events.filter(e => e.name === name);
      const last = taskEvents[taskEvents.length - 1];
      if (last) {
        taskDetails.push({
          name: last.name,
          lastEvent: last.event,
          lastEventAt: last.ts,
        });
      }
    }

    return {
      totalTasks: taskNames.size,
      todaySuccess: todayEvents.filter(e => e.event === 'task.completed').length,
      todayFailed: todayEvents.filter(e => e.event === 'task.failed').length,
      todaySkipped: todayEvents.filter(e => e.event === 'task.skipped').length,
      todayDelivered: todayEvents.filter(e => e.event === 'task.delivered').length,
      taskDetails,
    };
  }

  /**
   * 截断最老的 50% 事件（文件大小超限时调用）
   */
  private static truncateOldest(): void {
    if (!this.filePath || !fs.existsSync(this.filePath)) return;
    try {
      const raw = fs.readFileSync(this.filePath, 'utf-8');
      const lines = raw.trim().split('\n').filter(l => l.trim().length > 0);
      const keep = Math.ceil(lines.length / 2);
      const kept = lines.slice(-keep);
      const tmpPath = `${this.filePath}.tmp`;
      fs.writeFileSync(tmpPath, kept.join('\n') + '\n', 'utf-8');
      fs.renameSync(tmpPath, this.filePath);
    } catch (err) {
      console.error('[TaskLogger] Truncate failed:', err);
    }
  }
}
