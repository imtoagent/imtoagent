// ================================================================
// 心跳与定时任务 — HEARTBEAT.md 解析 + Phase 分散算法
// ================================================================

import type { ScheduledTask, TaskRunState, OnFailureStrategy, TaskType } from './types';

/** 心跳轮次硬上限 */
export const HEARTBEAT_ROUNDS_MAX = 5;

// ================================================================
// L0.6a: defaults 块解析（v3 新增）
// ================================================================

export interface HeartbeatDefaults {
  on_failure: OnFailureStrategy;
  max_retries: number;
  timeout: string;
}

const DEFAULT_DEFAULTS: HeartbeatDefaults = {
  on_failure: 'ignore',
  max_retries: 3,
  timeout: '60s',
};

/**
 * 解析 HEARTBEAT.md 中的 defaults: 块
 * 扫描 tasks: 之前的 defaults: 区域，提取全局默认值
 */
export function parseHeartbeatDefaults(md: string): HeartbeatDefaults {
  const stripped = stripCodeBlocks(md);
  const lines = stripped.split('\n');
  const defaults: Partial<HeartbeatDefaults> = {};
  let inDefaultsBlock = false;

  for (const line of lines) {
    const trimmed = line.trim();

    // 遇到 defaults: 开始
    if (/^defaults:\s*$/i.test(trimmed)) {
      inDefaultsBlock = true;
      continue;
    }

    // 遇到 tasks: 或其他顶级 key，defaults 块结束
    if (inDefaultsBlock && !/^\s/.test(line) && trimmed !== '' && !trimmed.startsWith('#')) {
      inDefaultsBlock = false;
    }

    // 遇到新标题，defaults 块结束
    if (inDefaultsBlock && /^##\s/.test(trimmed)) {
      inDefaultsBlock = false;
      continue;
    }

    if (inDefaultsBlock) {
      const onFailMatch = trimmed.match(/^on_failure:\s*(\S+)/);
      const retriesMatch = trimmed.match(/^max_retries:\s*(\d+)/);
      const timeoutMatch = trimmed.match(/^timeout:\s*(\S+)/);

      if (onFailMatch) {
        const val = onFailMatch[1] as OnFailureStrategy;
        if (['ignore', 'alert', 'retry'].includes(val)) defaults.on_failure = val;
      }
      if (retriesMatch) defaults.max_retries = parseInt(retriesMatch[1], 10);
      if (timeoutMatch) defaults.timeout = timeoutMatch[1];
    }
  }

  return { ...DEFAULT_DEFAULTS, ...defaults };
}

// ================================================================
// L0.6: HEARTBEAT.md 解析器
// ================================================================

/**
 * 移除 Markdown 代码块，只保留纯文本
 */
function stripCodeBlocks(md: string): string {
  return md.replace(/```[\s\S]*?```/g, '');
}

/**
 * 判断 HEARTBEAT.md 内容是否"实际上为空"
 */
export function isHeartbeatContentEffectivelyEmpty(md: string): boolean {
  const stripped = stripCodeBlocks(md);
  const lines = stripped.split('\n');

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    return false;
  }
  return true;
}

/**
 * 提取 tasks 块之外的文本（作为附加上下文）
 */
export function stripHeartbeatTasksBlock(md: string): string {
  const stripped = stripCodeBlocks(md);
  const lines = stripped.split('\n');
  const result: string[] = [];
  let inTasksBlock = false;

  for (const line of lines) {
    const trimmed = line.trim();

    if (!inTasksBlock && /^(tasks:|##\s+tasks|#\s+tasks)$/i.test(trimmed)) {
      inTasksBlock = true;
      continue;
    }

    if (inTasksBlock && /^##\s/.test(trimmed)) {
      inTasksBlock = false;
    }

    if (!inTasksBlock) {
      result.push(line);
    }
  }

  return result.join('\n').trim();
}

/**
 * 解析 HEARTBEAT.md 中的定时任务列表（v3 升级）
 * 支持所有 v3 任务类型和字段
 */
export function parseHeartbeatTasks(
  md: string,
  defaults?: HeartbeatDefaults,
): ScheduledTask[] {
  const resolvedDefaults = defaults ?? parseHeartbeatDefaults(md);
  const stripped = stripCodeBlocks(md);
  const lines = stripped.split('\n');
  const tasks: ScheduledTask[] = [];

  let taskStartIndex = -1;
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (/^(tasks:|##\s+tasks|#\s+tasks)$/i.test(trimmed)) {
      taskStartIndex = i;
      break;
    }
  }

  if (taskStartIndex === -1) return [];

  let i = taskStartIndex + 1;
  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();

    if (/^##\s/.test(trimmed)) break;

    const nameMatch = trimmed.match(/^-\s+name:\s*(.+?)\s*$/);
    if (nameMatch) {
      const task: ScheduledTask = {
        name: nameMatch[1].trim(),
        type: 'interval',
        interval: '',
        prompt: '',
      };

      i++;
      while (i < lines.length) {
        const nextLine = lines[i];
        const nextTrimmed = nextLine.trim();

        if (!nextLine.startsWith('  ') && !nextLine.startsWith('\t')) break;
        if (/^-\s+name:/.test(nextTrimmed)) break;

        const typeMatch = nextTrimmed.match(/^type:\s*(\S+)/);
        const intervalMatch = nextTrimmed.match(/^interval:\s*(.+?)\s*$/);
        const promptMatch = nextTrimmed.match(/^prompt:\s*["']?(.+?)["']?\s*$/);
        const atMatch = nextTrimmed.match(/^at:\s*["']?(.+?)["']?\s*$/);
        const afterMatch = nextTrimmed.match(/^after:\s*(.+?)\s*$/);
        const onMatch = nextTrimmed.match(/^on:\s*["']?(.+?)["']?\s*$/);
        const maxRunsMatch = nextTrimmed.match(/^max_runs:\s*(\d+)/);
        const deadlineMatch = nextTrimmed.match(/^deadline:\s*["']?(.+?)["']?\s*$/);
        const onFailMatch = nextTrimmed.match(/^on_failure:\s*(\S+)/);
        const retriesMatch = nextTrimmed.match(/^max_retries:\s*(\d+)/);
        const timeoutMatch = nextTrimmed.match(/^timeout:\s*(\S+)/);

        if (typeMatch) {
          const val = typeMatch[1] as TaskType;
          if (['interval', 'once', 'scheduled', 'countdown', 'conditional'].includes(val)) {
            task.type = val;
          }
        }
        if (intervalMatch) task.interval = intervalMatch[1].trim();
        if (promptMatch) task.prompt = promptMatch[1].trim().replace(/["']$/, '');
        if (atMatch) task.at = atMatch[1].trim().replace(/["']/g, '');
        if (afterMatch) task.after = afterMatch[1].trim().replace(/["']/g, '');
        if (onMatch) task.on = onMatch[1].trim().replace(/["']/g, '');
        if (maxRunsMatch) task.max_runs = parseInt(maxRunsMatch[1], 10);
        if (deadlineMatch) task.deadline = deadlineMatch[1].trim().replace(/["']$/, '');
        if (onFailMatch) {
          const val = onFailMatch[1] as OnFailureStrategy;
          if (['ignore', 'alert', 'retry'].includes(val)) task.on_failure = val;
        }
        if (retriesMatch) task.max_retries = parseInt(retriesMatch[1], 10);
        if (timeoutMatch) task.timeout = timeoutMatch[1];

        i++;
      }

      // 合并 defaults
      if (task.on_failure === undefined) task.on_failure = resolvedDefaults.on_failure;
      if (task.max_retries === undefined) task.max_retries = resolvedDefaults.max_retries;
      if (task.timeout === undefined) task.timeout = resolvedDefaults.timeout;

      // 校验
      if ((task.type === 'interval' || task.type === 'countdown') && !task.interval) {
        console.warn(`[parseHeartbeatTasks] Task "${task.name}" (${task.type}) missing interval, skipping`);
        continue;
      }
      if (task.type === 'once' && !task.at && !task.after) {
        console.warn(`[parseHeartbeatTasks] Task "${task.name}" (once) missing at/after, skipping`);
        continue;
      }
      if (task.type === 'scheduled' && !task.at) {
        console.warn(`[parseHeartbeatTasks] Task "${task.name}" (scheduled) missing at, skipping`);
        continue;
      }

      if (task.name && task.prompt) {
        tasks.push(task);
      }
    } else {
      i++;
    }
  }

  return tasks;
}

// ================================================================
// L0.7: Phase 分散算法
// ================================================================

export function hashCode(s: string): number {
  let hash = 5381;
  for (let i = 0; i < s.length; i++) {
    hash = ((hash << 5) + hash) + s.charCodeAt(i);
    hash = hash | 0;
  }
  return hash;
}

export function getPhaseOffset(botName: string, intervalMs: number): number {
  const hash = hashCode(botName + '::' + intervalMs);
  return Math.abs(hash) % intervalMs;
}

export function parseInterval(interval: string): number | null {
  const match = interval.match(/^(\d+)\s*(s|m|h|d)$/i);
  if (!match) return null;

  const value = parseInt(match[1], 10);
  const unit = match[2].toLowerCase();

  switch (unit) {
    case 's': return value * 1000;
    case 'm': return value * 60 * 1000;
    case 'h': return value * 60 * 60 * 1000;
    case 'd': return value * 24 * 60 * 60 * 1000;
    default: return null;
  }
}

// ================================================================
// L0.8: 到期判断（v3 新增 — isTaskDue）
// ================================================================

/** 解析 YYYY-MM-DD HH:MM 为本地时间戳 */
export function parseDateTime(str: string): number {
  // 假设本地时区（Asia/Shanghai）
  const match = str.match(/^(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2})$/);
  if (!match) return NaN;
  const [, y, mo, d, h, mi] = match.map(Number);
  return new Date(y, mo - 1, d, h, mi).getTime();
}

/** 解析 HH:MM 为今天的时间戳 */
export function parseTimeToday(timeStr: string): number {
  const match = timeStr.match(/^(\d{2}):(\d{2})$/);
  if (!match) return NaN;
  const [, h, m] = match.map(Number);
  const now = new Date();
  now.setHours(h, m, 0, 0);
  return now.getTime();
}

export interface TaskDueResult {
  due: boolean;
  reason?: string;
}

/**
 * 判断任务是否到期
 * @param task 任务定义
 * @param lastRunAt 上次执行时间戳（undefined = 从未执行）
 * @param now 当前时间戳
 * @param createdAt 任务创建时间戳（once/after 需要）
 */
export function isTaskDue(
  task: ScheduledTask,
  lastRunAt: number | undefined,
  now: number,
  createdAt: number | undefined,
): TaskDueResult {
  const type = task.type ?? 'interval';

  switch (type) {
    case 'interval': {
      if (!task.interval) return { due: false, reason: 'missing interval' };
      const intervalMs = parseInterval(task.interval);
      if (!intervalMs) return { due: false, reason: 'invalid interval' };
      if (lastRunAt === undefined) return { due: true, reason: 'first run' };
      return {
        due: now - lastRunAt >= intervalMs,
        reason: now - lastRunAt >= intervalMs ? 'interval elapsed' : 'interval not yet elapsed',
      };
    }

    case 'once': {
      if (task.at) {
        const targetTime = parseDateTime(task.at);
        if (isNaN(targetTime)) return { due: false, reason: 'invalid at time' };
        if (lastRunAt !== undefined) return { due: false, reason: 'already executed' };
        return {
          due: now >= targetTime,
          reason: now >= targetTime ? 'target time reached' : 'waiting for target time',
        };
      }
      if (task.after) {
        const afterMs = parseInterval(task.after);
        if (!afterMs) return { due: false, reason: 'invalid after duration' };
        if (lastRunAt !== undefined) return { due: false, reason: 'already executed' };
        if (!createdAt) return { due: false, reason: 'no createdAt timestamp' };
        return {
          due: now - createdAt >= afterMs,
          reason: now - createdAt >= afterMs ? 'delay elapsed' : 'delay not yet elapsed',
        };
      }
      return { due: false, reason: 'missing at/after' };
    }

    case 'scheduled': {
      if (!task.at) return { due: false, reason: 'missing at time' };

      // 先检查 on 约束（星期/日期），即使是首次执行
      if (task.on) {
        const onLower = task.on.toLowerCase();
        const weekdays = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
        const nowDate = new Date(now);
        if (weekdays.includes(onLower)) {
          const targetDay = weekdays.indexOf(onLower);
          if (nowDate.getDay() !== targetDay) {
            return { due: false, reason: `not ${onLower} (today is ${weekdays[nowDate.getDay()]})` };
          }
        } else {
          const dayMatch = onLower.match(/^(\d{1,2})(st|nd|rd|th)?$/);
          if (dayMatch) {
            const targetDay = parseInt(dayMatch[1], 10);
            if (nowDate.getDate() !== targetDay) {
              return { due: false, reason: `not day ${targetDay} (today is ${nowDate.getDate()})` };
            }
          }
        }
      }

      if (lastRunAt === undefined) {
        const targetToday = parseTimeToday(task.at);
        if (isNaN(targetToday)) return { due: false, reason: 'invalid at format' };
        return {
          due: now >= targetToday,
          reason: now >= targetToday ? 'first run, time reached' : 'waiting for first trigger',
        };
      }
      // 非首次：检查本周期是否已执行过
      const lastDate = new Date(lastRunAt);
      const nowDate = new Date(now);

      // 检查是否同一天已执行
      if (
        lastDate.getFullYear() === nowDate.getFullYear() &&
        lastDate.getMonth() === nowDate.getMonth() &&
        lastDate.getDate() === nowDate.getDate()
      ) {
        return { due: false, reason: 'already executed today' };
      }

      const targetToday = parseTimeToday(task.at);
      if (isNaN(targetToday)) return { due: false, reason: 'invalid at format' };
      return {
        due: now >= targetToday,
        reason: now >= targetToday ? 'new day, time reached' : 'time not yet reached today',
      };
    }

    case 'countdown': {
      if (!task.interval) return { due: false, reason: 'missing interval' };
      const intervalMs = parseInterval(task.interval);
      if (!intervalMs) return { due: false, reason: 'invalid interval' };

      // 检查 max_runs
      if (task.max_runs !== undefined) {
        const runCount = typeof lastRunAt === 'number' ? 0 : 0; // 需要从 TaskRunState 获取，这里简化
        // 实际 runCount 从 session.heartbeatTaskState 中读取，调度器负责传入
        // 这里只判断 interval
      }

      // 检查 deadline
      if (task.deadline) {
        const deadlineTime = parseDateTime(task.deadline);
        if (!isNaN(deadlineTime) && now >= deadlineTime) {
          return { due: false, reason: 'deadline passed' };
        }
      }

      if (lastRunAt === undefined) return { due: true, reason: 'first run' };
      return {
        due: now - lastRunAt >= intervalMs,
        reason: now - lastRunAt >= intervalMs ? 'interval elapsed' : 'interval not yet elapsed',
      };
    }

    case 'conditional': {
      // v3.1: condition 由 Agent 自行判断，调度器只按 interval 触发
      if (!task.interval) return { due: false, reason: 'missing interval' };
      const intervalMs = parseInterval(task.interval);
      if (!intervalMs) return { due: false, reason: 'invalid interval' };
      if (lastRunAt === undefined) return { due: true, reason: 'first run' };
      return {
        due: now - lastRunAt >= intervalMs,
        reason: now - lastRunAt >= intervalMs ? 'interval elapsed' : 'interval not yet elapsed',
      };
    }

    default:
      return { due: false, reason: `unknown type: ${type}` };
  }
}

/**
 * 获取任务运行状态（兼容 v2.2 的 number 类型和 v3 的 TaskRunState 类型）
 */
export function getTaskRunState(
  state: number | TaskRunState | undefined,
): TaskRunState {
  if (state === undefined) {
    return { lastRunAt: 0, runCount: 0, createdAt: 0 };
  }
  if (typeof state === 'number') {
    return { lastRunAt: state, runCount: 1, createdAt: state };
  }
  return state;
}

/**
 * 更新任务运行状态
 */
export function updateTaskRunState(
  state: number | TaskRunState | undefined,
  now: number,
): TaskRunState {
  const current = getTaskRunState(state);
  return {
    lastRunAt: now,
    runCount: current.runCount + 1,
    createdAt: current.createdAt || now,
  };
}

// ================================================================
// L0.9: 任务完成后自动删除（v3 新增）
// ================================================================

import * as fs from 'fs';

/**
 * 从 HEARTBEAT.md 中删除指定任务块
 *
 * 按任务名精确匹配，删除 `- name: <taskName>` 及其所有缩进子行。
 * 保留 tasks: 块之外的所有内容。
 *
 * @returns 是否成功删除
 */
export function removeTaskFromHeartbeatFile(filePath: string, taskName: string): boolean {
  try {
    if (!fs.existsSync(filePath)) {
      console.warn(`[removeTask] HEARTBEAT.md not found: ${filePath}`);
      return false;
    }

    const content = fs.readFileSync(filePath, 'utf-8');
    const lines = content.split('\n');
    const result: string[] = [];
    let inTasksBlock = false;
    let inTargetTask = false;
    let removed = false;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const trimmed = line.trim();

      // 检测 tasks: 块开始
      if (!inTasksBlock && /^(tasks:|##\s+tasks|#\s+tasks)$/i.test(trimmed)) {
        inTasksBlock = true;
        result.push(line);
        continue;
      }

      // tasks 块内，遇到新 ## 标题则退出
      if (inTasksBlock && /^##\s/.test(trimmed)) {
        inTasksBlock = false;
        inTargetTask = false;
        result.push(line);
        continue;
      }

      // tasks 块内，检测目标任务
      if (inTasksBlock && !inTargetTask) {
        const nameMatch = trimmed.match(/^-\s+name:\s*(.+?)\s*$/);
        if (nameMatch && nameMatch[1].trim() === taskName) {
          inTargetTask = true;
          removed = true;
          continue; // 跳过此行
        }
        result.push(line);
        continue;
      }

      // 正在删除目标任务，跳过所有缩进行
      if (inTargetTask) {
        // 下一行没有缩进或遇到新任务名 → 目标任务结束
        if (line === '' || (!line.startsWith('  ') && !line.startsWith('\t'))) {
          inTargetTask = false;
          // 保留空行/非缩进行
          result.push(line);
          continue;
        }
        // 跳过缩进子行
        continue;
      }

      result.push(line);
    }

    if (!removed) {
      console.warn(`[removeTask] Task "${taskName}" not found in ${filePath}`);
      return false;
    }

    // 写回文件（原子写：先写临时文件再重命名）
    const tmpPath = `${filePath}.tmp`;
    fs.writeFileSync(tmpPath, result.join('\n'), 'utf-8');
    fs.renameSync(tmpPath, filePath);

    console.log(`[removeTask] Task "${taskName}" removed from ${filePath}`);
    return true;
  } catch (e: any) {
    console.error(`[removeTask] Failed to remove task "${taskName}":`, e.message);
    return false;
  }
}
