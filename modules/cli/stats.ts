// ================================================================
// imtoagent stats — Usage statistics CLI
// ================================================================
// Reads from ~/.imtoagent/stats/usage.jsonl
// Commands: (default), --today, --week, --bot, --history
// ================================================================

import * as path from 'path';
import { StatsPersist } from '../core/stats-persist';
import { getDataDir } from '../utils/paths';

// ================================================================
// Main entry
// ================================================================

export async function cmdStats(...args: string[]): Promise<void> {
  const stats = new StatsPersist(getDataDir());

  // Parse flags
  let mode: 'default' | 'today' | 'week' | 'history' = 'default';
  let botFilter: string | undefined;
  let historyLimit = 20;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--today') mode = 'today';
    else if (arg === '--week') mode = 'week';
    else if (arg === '--bot' && i + 1 < args.length) {
      botFilter = args[++i];
    } else if (arg === '--history') {
      mode = 'history';
      if (i + 1 < args.length && args[i + 1].match(/^\d+$/)) {
        historyLimit = parseInt(args[++i]);
      }
    }
  }

  const now = new Date();

  switch (mode) {
    case 'today': {
      const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      const records = stats.query({ since: startOfDay, until: now, bot: botFilter });
      printAggregate('Today', records, botFilter);
      break;
    }
    case 'week': {
      const startOfWeek = new Date(now);
      startOfWeek.setDate(startOfWeek.getDate() - startOfWeek.getDay());
      startOfWeek.setHours(0, 0, 0, 0);
      const records = stats.query({ since: startOfWeek, until: now, bot: botFilter });
      printAggregate('This Week', records, botFilter);
      break;
    }
    case 'history': {
      const records = stats.query({ bot: botFilter, limit: historyLimit, reverse: true });
      printHistory(records, botFilter);
      break;
    }
    default: {
      // Show per-bot summary (all time)
      const perBot = stats.perBotStats();
      if (Object.keys(perBot).length === 0) {
        console.log('No usage data yet. Usage records are created when the gateway processes messages.');
        return;
      }
      console.log('\n📊 IMtoAgent Usage — All Time\n');
      printTable(perBot);
      break;
    }
  }
}

// ================================================================
// Output formatters
// ================================================================

function printAggregate(label: string, records: any[], botFilter?: string) {
  const agg = aggregate(records);

  const filterLabel = botFilter ? ` (${botFilter})` : '';
  console.log(`\n📊 IMtoAgent Usage — ${label}${filterLabel}\n`);

  if (agg.calls === 0) {
    console.log('  No records found.');
    return;
  }

  console.log(`  Calls:        ${agg.calls}`);
  console.log(`  Input tokens: ${formatTokens(agg.inputTokens)}`);
  console.log(`  Output tokens: ${formatTokens(agg.outputTokens)}`);
  console.log(`  Total tokens:  ${formatTokens(agg.totalTokens)}`);
  console.log(`  Cost:         $${agg.costUsd.toFixed(4)}`);
  console.log(`  Avg duration:  ${formatDuration(agg.avgDurationMs)}`);
  console.log(`  Total duration: ${formatDuration(agg.totalDurationMs)}`);
  console.log();
}

function printHistory(records: any[], botFilter?: string) {
  const filterLabel = botFilter ? ` (${botFilter})` : '';
  console.log(`\n📊 Recent Calls — Last ${records.length}${filterLabel}\n`);

  if (records.length === 0) {
    console.log('  No records found.');
    return;
  }

  // Header
  console.log(pad('Time', 20) + pad('Bot', 16) + pad('Backend', 10) + pad('In', 8) + pad('Out', 8) + pad('Cost', 10) + pad('Duration', 10));
  console.log('─'.repeat(82));

  for (const r of records) {
    const time = r.ts.substring(5, 19).replace('T', ' ');
    console.log(
      pad(time, 20) +
      pad(truncate(r.bot, 15), 16) +
      pad(r.backend, 10) +
      pad(formatTokens(r.inputTokens), 8) +
      pad(formatTokens(r.outputTokens), 8) +
      pad('$' + r.costUsd.toFixed(3), 10) +
      pad(formatDuration(r.durationMs), 10)
    );
  }
  console.log();
}

function printTable(perBot: Record<string, any>) {
  console.log(pad('Bot', 20) + pad('Calls', 8) + pad('Tokens', 12) + pad('Cost', 12) + pad('Avg Time', 12));
  console.log('─'.repeat(64));

  let totalCalls = 0, totalTokens = 0, totalCost = 0;

  for (const [bot, s] of Object.entries(perBot)) {
    totalCalls += s.calls;
    totalTokens += s.totalTokens;
    totalCost += s.costUsd;

    console.log(
      pad(truncate(bot, 19), 20) +
      pad(String(s.calls), 8) +
      pad(formatTokens(s.totalTokens), 12) +
      pad('$' + s.costUsd.toFixed(4), 12) +
      pad(formatDuration(s.avgDurationMs), 12)
    );
  }

  console.log('─'.repeat(64));
  console.log(
    pad('TOTAL', 20) +
    pad(String(totalCalls), 8) +
    pad(formatTokens(totalTokens), 12) +
    pad('$' + totalCost.toFixed(4), 12) +
    ''
  );
  console.log();
}

// ================================================================
// Helpers
// ================================================================

function aggregate(records: any[]) {
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
    result.inputTokens += r.inputTokens || 0;
    result.outputTokens += r.outputTokens || 0;
    result.costUsd += r.costUsd || 0;
    result.totalDurationMs += r.durationMs || 0;
  }

  result.totalTokens = result.inputTokens + result.outputTokens;
  result.avgDurationMs = result.calls > 0 ? Math.round(result.totalDurationMs / result.calls) : 0;

  return result;
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K';
  return String(n);
}

function formatDuration(ms: number): string {
  if (ms >= 3_600_000) return (ms / 3_600_000).toFixed(1) + 'h';
  if (ms >= 60_000) return (ms / 60_000).toFixed(1) + 'm';
  if (ms >= 1_000) return (ms / 1_000).toFixed(1) + 's';
  return ms + 'ms';
}

function pad(s: string, width: number): string {
  return s.padEnd(width);
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.substring(0, max - 1) + '…' : s;
}
