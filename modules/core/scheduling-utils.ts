// ================================================================
// Scheduling Utils — TaskPoller 和 GoalEngine 共享工具函数
// ================================================================
// P2-1: 提取双引擎重复代码到独立模块
// ================================================================

import * as fs from 'fs';
import * as path from 'path';

// ================================================================
// 过期检测
// ================================================================

/**
 * 检查任务是否过期（基于 expiresAt 字段）
 */
export function isExpired(
  expiresAt: string | undefined,
  now?: Date,
): boolean {
  if (!expiresAt) return false;
  const ref = now ?? new Date();
  return new Date(expiresAt) <= ref;
}

// ================================================================
// 超时包装
// ================================================================

/**
 * 为异步函数添加超时保护
 * @param fn 异步函数
 * @param timeoutMs 超时时间（毫秒）
 * @returns 函数执行结果
 * @throws 超时错误
 */
export async function withTimeout<T>(
  fn: () => Promise<T>,
  timeoutMs: number,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      reject(new Error(`Operation timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    fn()
      .then(resolve)
      .catch(reject)
      .finally(() => clearTimeout(timeoutId));
  });
}

// ================================================================
// 历史持久化（通用版）
// ================================================================

export interface HistoryEntry {
  runAt: string;
  durationMs?: number;
  result?: string;
  error?: string;
  [key: string]: unknown;
}

/**
 * 追加执行历史到 JSON 文件（原子写入）
 * @param filePath 历史文件路径
 * @param entry 新条目
 * @param maxEntries 最大保留条数（默认 50）
 */
export function appendHistory<T extends HistoryEntry>(
  filePath: string,
  entry: T,
  maxEntries: number = 50,
): void {
  let entries: T[] = [];

  try {
    if (fs.existsSync(filePath)) {
      const raw = fs.readFileSync(filePath, 'utf-8');
      if (raw.trim().length > 0) {
        entries = JSON.parse(raw);
      }
    }
  } catch {
    // 文件损坏，从头开始
  }

  entries.push(entry);

  // 保留最近 N 条
  if (entries.length > maxEntries) {
    entries = entries.slice(-maxEntries);
  }

  try {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    // 原子写入：先写临时文件再重命名
    const tmpPath = `${filePath}.tmp`;
    fs.writeFileSync(tmpPath, JSON.stringify(entries, null, 2), 'utf-8');
    fs.renameSync(tmpPath, filePath);
  } catch (err) {
    console.error('[appendHistory] Failed to write:', err);
  }
}
