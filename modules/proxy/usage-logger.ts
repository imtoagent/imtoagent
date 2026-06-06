// ================================================================
// Usage Logger — 记录每次请求的真实 token 用量
// ================================================================
// P1: 纯观测，不改变任何消息结构
// 输出到独立日志文件，供后续压缩策略分析
// ================================================================

import * as fs from 'fs';
import * as path from 'path';
import { getSessionsDir } from '../utils/paths';

export interface UsageRecord {
  timestamp: string;
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  messageCount?: number;
  hasTools?: boolean;
  isStream?: boolean;
  costUSD?: number;
}

const USAGE_LOG_PATH = path.join(getSessionsDir(), 'usage-log.jsonl');

/** 追加一条 usage 记录到日志文件 */
export function logUsage(record: UsageRecord): void {
  try {
    const line = JSON.stringify(record);
    fs.appendFileSync(USAGE_LOG_PATH, line + '\n');
    console.log(
      `[Usage] ${record.provider}/${record.model} ` +
        `in=${record.inputTokens} out=${record.outputTokens} total=${record.totalTokens}` +
        (record.messageCount ? ` msgs=${record.messageCount}` : '') +
        (record.hasTools ? ' tools=yes' : '')
    );
  } catch (e) {
    // 日志写入失败不影响主流程
    console.error(`[Usage] Failed to log usage: ${e.message}`);
  }
}

/** 读取最近的 N 条 usage 记录 */
export function getRecentUsage(n = 50): UsageRecord[] {
  try {
    if (!fs.existsSync(USAGE_LOG_PATH)) return [];
    const lines = fs.readFileSync(USAGE_LOG_PATH, 'utf-8').trim().split('\n').filter(Boolean);
    return lines
      .slice(-n)
      .map((line) => JSON.parse(line) as UsageRecord)
      .reverse();
  } catch {
    return [];
  }
}

/** 统计摘要 */
export function getUsageSummary(records?: UsageRecord[]): {
  totalRequests: number;
  avgInputTokens: number;
  avgOutputTokens: number;
  avgTotalTokens: number;
  maxTotalTokens: number;
  toolRequestRatio: number;
} {
  const data = records || getRecentUsage(500);
  if (data.length === 0) {
    return { totalRequests: 0, avgInputTokens: 0, avgOutputTokens: 0, avgTotalTokens: 0, maxTotalTokens: 0, toolRequestRatio: 0 };
  }

  const totalInput = data.reduce((s, r) => s + r.inputTokens, 0);
  const totalOutput = data.reduce((s, r) => s + r.outputTokens, 0);
  const totalAll = data.reduce((s, r) => s + r.totalTokens, 0);
  const maxTotal = Math.max(...data.map((r) => r.totalTokens));
  const withTools = data.filter((r) => r.hasTools).length;

  return {
    totalRequests: data.length,
    avgInputTokens: Math.round(totalInput / data.length),
    avgOutputTokens: Math.round(totalOutput / data.length),
    avgTotalTokens: Math.round(totalAll / data.length),
    maxTotalTokens: maxTotal,
    toolRequestRatio: Math.round((withTools / data.length) * 100),
  };
}
