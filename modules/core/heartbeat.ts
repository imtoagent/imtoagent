// ================================================================
// 心跳与定时任务 — HEARTBEAT.md 解析 + Phase 分散算法
// ================================================================

import type { ScheduledTask } from './types';

/** 心跳轮次硬上限 */
export const HEARTBEAT_ROUNDS_MAX = 5;

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
 * 返回 true 当：
 * - 去除代码块后，剩余内容只有空白字符
 * - 或只有注释行（以 # 开头）
 * - 或 tasks 块存在但无任何 `- name:` 条目
 */
export function isHeartbeatContentEffectivelyEmpty(md: string): boolean {
  const stripped = stripCodeBlocks(md);
  const lines = stripped.split('\n');

  for (const line of lines) {
    const trimmed = line.trim();
    // 跳过空行和注释行
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    // 找到任何非注释的实质内容
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

    // 检测 tasks 块起始：`tasks:` 或 `## Tasks` 等
    if (!inTasksBlock && /^(tasks:|##\s+tasks|#\s+tasks)$/i.test(trimmed)) {
      inTasksBlock = true;
      continue;
    }

    // 检测 tasks 块结束（遇到新的 ## 标题）
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
 * 解析 HEARTBEAT.md 中的定时任务列表
 * 支持格式：
 *   tasks:
 *     - name: disk-check
 *       interval: 1h
 *       prompt: "Check disk usage."
 *
 * 或使用 Markdown 标题：
 *   ## Tasks
 *   - name: disk-check
 *     interval: 1h
 *     prompt: "Check disk usage."
 */
export function parseHeartbeatTasks(md: string): ScheduledTask[] {
  const stripped = stripCodeBlocks(md);
  const lines = stripped.split('\n');
  const tasks: ScheduledTask[] = [];

  // 找到 tasks 块的起始行
  let taskStartIndex = -1;
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (/^(tasks:|##\s+tasks|#\s+tasks)$/i.test(trimmed)) {
      taskStartIndex = i;
      break;
    }
  }

  if (taskStartIndex === -1) return [];

  // 从 taskStartIndex 开始解析任务
  // 支持两种格式：
  // 1. YAML 风格（tasks: 后跟缩进列表）
  // 2. Markdown 列表风格（## Tasks 后跟 - name: ...）

  let i = taskStartIndex + 1;
  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();

    // 遇到新标题行，任务块结束
    if (/^##\s/.test(trimmed)) break;

    // 匹配 `- name: xxx`
    const nameMatch = trimmed.match(/^-\s+name:\s*(.+?)\s*$/);
    if (nameMatch) {
      const task: ScheduledTask = {
        name: nameMatch[1].trim(),
        interval: '',
        prompt: '',
      };

      // 读取后续缩进行（interval 和 prompt）
      i++;
      while (i < lines.length) {
        const nextLine = lines[i];
        const nextTrimmed = nextLine.trim();

        // 非缩进行或新任务，结束当前任务解析
        if (!nextLine.startsWith('  ') && !nextLine.startsWith('\t')) break;
        // 新任务开始
        if (/^-\s+name:/.test(nextTrimmed)) break;

        const intervalMatch = nextTrimmed.match(/^interval:\s*(.+?)\s*$/);
        const promptMatch = nextTrimmed.match(/^prompt:\s*["']?(.+?)["']?\s*$/);

        if (intervalMatch) {
          task.interval = intervalMatch[1].trim();
        } else if (promptMatch) {
          task.prompt = promptMatch[1].trim().replace(/["']$/, '');
        }

        i++;
      }

      if (task.name && task.interval) {
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

/**
 * 字符串哈希（DJB2）
 */
export function hashCode(s: string): number {
  let hash = 5381;
  for (let i = 0; i < s.length; i++) {
    hash = ((hash << 5) + hash) + s.charCodeAt(i);
    hash = hash | 0; // 保持 32 位整数
  }
  return hash;
}

/**
 * 计算 phase 偏移量
 * 确保同一 bot + 同一 interval 每次计算结果一致，不同 bot 结果分散
 */
export function getPhaseOffset(botName: string, intervalMs: number): number {
  const hash = hashCode(botName + '::' + intervalMs);
  return Math.abs(hash) % intervalMs;
}

/**
 * 解析间隔字符串为毫秒数
 * 支持格式: "5m", "300s", "1h", "24h", "30m"
 */
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
