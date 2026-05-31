// ================================================================
// Stats Persistence — append-only JSONL usage tracking
// ================================================================
// Writes to ~/.imtoagent/stats/usage.jsonl
// Each successful call appends one record
// CLI (stats.ts) reads and aggregates this data
// ================================================================

import * as fs from 'fs';
import * as path from 'path';
import { getDataDir } from '../utils/paths';

// ================================================================
// Usage record format
// ================================================================

export interface UsageRecord {
  ts: string;             // ISO timestamp
  bot: string;            // Bot name
  chatId: string;         // Chat ID (group or user)
  backend: string;        // claude | codex | opencode
  model?: string;         // Model used (sonnet, opus, etc.)
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  durationMs: number;
  turns?: number;
  status: 'ok' | 'error' | 'cancelled';
  errorMessage?: string;
}

// ================================================================
// StatsPersist — append-only writer
// ================================================================

export class StatsPersist {
  private statsDir: string;
  private filePath: string;
  private writeQueue: string[] = [];
  private writing = false;

  constructor(dataDir?: string) {
    const base = dataDir || getDataDir();
    this.statsDir = path.join(base, 'stats');
    this.filePath = path.join(this.statsDir, 'usage.jsonl');
    fs.mkdirSync(this.statsDir, { recursive: true });
  }

  /**
   * Append a usage record. Queued for batched writes.
   */
  record(record: UsageRecord): void {
    if (!record.ts) {
      record.ts = new Date().toISOString();
    }
    this.writeQueue.push(JSON.stringify(record));
    this.flushIfNeeded();
  }

  /**
   * Flush pending writes to disk.
   */
  async flush(): Promise<void> {
    if (this.writeQueue.length === 0) return;
    if (this.writing) return;
    this.writing = true;

    const batch = this.writeQueue.splice(0);
    try {
      const data = batch.map((line) => line + '\n').join('');
      fs.appendFileSync(this.filePath, data);
    } catch (err) {
      console.error(`[StatsPersist] Failed to write usage: ${err}`);
      // Put back in queue for next flush attempt
      this.writeQueue.unshift(...batch);
    } finally {
      this.writing = false;
    }
  }

  /**
   * Flush when queue reaches threshold.
   */
  private flushIfNeeded(): void {
    if (this.writeQueue.length >= 10) {
      this.flush().catch(() => {});
    }
  }

  /**
   * Read all records (for CLI queries).
   */
  readAll(): UsageRecord[] {
    if (!fs.existsSync(this.filePath)) return [];

    try {
      const content = fs.readFileSync(this.filePath, 'utf-8');
      const lines = content.trim().split('\n').filter(Boolean);
      const records: UsageRecord[] = [];
      for (const line of lines) {
        try {
          records.push(JSON.parse(line) as UsageRecord);
        } catch {
          // Skip malformed lines
        }
      }
      return records;
    } catch {
      return [];
    }
  }

  /**
   * Query records with filters.
   */
  query(options: {
    bot?: string;
    since?: Date;
    until?: Date;
    limit?: number;
    reverse?: boolean;
  }): UsageRecord[] {
    let records = this.readAll();

    if (options.bot) {
      records = records.filter((r) => r.bot === options.bot);
    }
    if (options.since) {
      const sinceTs = options.since.toISOString();
      records = records.filter((r) => r.ts >= sinceTs);
    }
    if (options.until) {
      const untilTs = options.until.toISOString();
      records = records.filter((r) => r.ts <= untilTs);
    }

    if (options.reverse) {
      records.reverse();
    }
    if (options.limit) {
      records = records.slice(0, options.limit);
    }

    return records;
  }

  /**
   * Get aggregate stats for a filtered set of records.
   */
  aggregate(records: UsageRecord[]): {
    calls: number;
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    costUsd: number;
    avgDurationMs: number;
    totalDurationMs: number;
  } {
    const result = {
      calls: records.length,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      costUsd: 0,
      avgDurationMs: 0,
      totalDurationMs: 0,
    };

    for (const r of records) {
      result.inputTokens += r.inputTokens;
      result.outputTokens += r.outputTokens;
      result.costUsd += r.costUsd;
      result.totalDurationMs += r.durationMs;
    }

    result.totalTokens = result.inputTokens + result.outputTokens;
    result.avgDurationMs = result.calls > 0 ? Math.round(result.totalDurationMs / result.calls) : 0;

    return result;
  }

  /**
   * Get per-bot aggregate stats.
   */
  perBotStats(since?: Date, until?: Date): Record<string, ReturnType<typeof this.aggregate>> {
    const records = this.query({ since, until });
    const byBot: Record<string, UsageRecord[]> = {};

    for (const r of records) {
      if (!byBot[r.bot]) byBot[r.bot] = [];
      byBot[r.bot].push(r);
    }

    const result: Record<string, ReturnType<typeof this.aggregate>> = {};
    for (const [bot, botRecords] of Object.entries(byBot)) {
      result[bot] = this.aggregate(botRecords);
    }

    return result;
  }
}
