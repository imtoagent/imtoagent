// ================================================================
// imtoagent session — Session management CLI
// ================================================================
// Commands: list, list --all, info <chatId>, clear <chatId>, clear --all
// Operates on ~/.imtoagent/sessions/ directory
// ================================================================

import * as fs from 'fs';
import * as path from 'path';
import { getSessionsDir } from '../utils/paths';

// ================================================================
// Main entry
// ================================================================

export async function cmdSession(...args: string[]): Promise<void> {
  const subCmd = args[0];
  const sessionsDir = getSessionsDir();

  if (!fs.existsSync(sessionsDir)) {
    console.log('No sessions directory found. Run the gateway first to create sessions.');
    return;
  }

  switch (subCmd) {
    case 'list':
      await cmdSessionList(args.slice(1), sessionsDir);
      break;
    case 'info':
      await cmdSessionInfo(args.slice(1), sessionsDir);
      break;
    case 'clear':
      await cmdSessionClear(args.slice(1), sessionsDir);
      break;
    default:
      printSessionHelp();
      break;
  }
}

// ================================================================
// list — Show active sessions
// ================================================================

async function cmdSessionList(args: string[], sessionsDir: string): Promise<void> {
  const showAll = args.includes('--all');
  const botFilter = args.includes('--bot') ? args[args.indexOf('--bot') + 1] : undefined;

  // Scan bot directories
  const botDirs = fs.readdirSync(sessionsDir).filter((d) =>
    fs.statSync(path.join(sessionsDir, d)).isDirectory()
  );

  const sessions: SessionSummary[] = [];

  for (const botDir of botDirs) {
    if (botFilter && botDir !== botFilter) continue;

    const botPath = path.join(sessionsDir, botDir);
    const files = fs.readdirSync(botPath).filter((f) => f.endsWith('.memory.json'));

    for (const file of files) {
      try {
        const filePath = path.join(botPath, file);
        const raw = fs.readFileSync(filePath, 'utf-8');
        const data = JSON.parse(raw);
        const chatId = data.chatId || file.replace('.memory.json', '');
        const lastUsed = data.lastUsed ? new Date(data.lastUsed) : null;
        const stats = data.stats || {};
        const running = data.running || false;

        sessions.push({
          bot: botDir,
          chatId,
          lastUsed,
          calls: stats.calls || 0,
          inputTokens: stats.totalInputTokens || 0,
          outputTokens: stats.totalOutputTokens || 0,
          costUsd: stats.totalCostUSD || 0,
          running,
          backendSessionId: data.backendSessionId || data.metadata?.sdkSessionId || data.metadata?.codexThreadId || data.metadata?.ocSessionId || '',
          file,
        });
      } catch {
        // Skip corrupted files
      }
    }
  }

  // Sort by lastUsed (most recent first)
  sessions.sort((a, b) => {
    if (!a.lastUsed && !b.lastUsed) return 0;
    if (!a.lastUsed) return 1;
    if (!b.lastUsed) return -1;
    return b.lastUsed.getTime() - a.lastUsed.getTime();
  });

  // Filter: by default only show sessions used in last 24h
  const oneDayAgo = Date.now() - 24 * 60 * 60 * 1000;
  const filtered = showAll
    ? sessions
    : sessions.filter((s) => s.lastUsed && s.lastUsed.getTime() > oneDayAgo);

  if (filtered.length === 0) {
    console.log(`No ${showAll ? '' : 'recent '}sessions found.${!showAll ? ' Use --all to show all.' : ''}`);
    return;
  }

  const modeLabel = showAll ? 'All Sessions' : 'Recent Sessions (24h)';
  console.log(`\n📋 ${modeLabel} — ${filtered.length} session(s)\n`);
  console.log(
    pad('Bot', 18) +
    pad('Chat ID', 32) +
    pad('Last Used', 20) +
    pad('Calls', 7) +
    pad('Tokens', 10) +
    pad('Cost', 10) +
    pad('Status', 8)
  );
  console.log('─'.repeat(105));

  for (const s of filtered) {
    const lastUsed = s.lastUsed
      ? s.lastUsed.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
      : 'never';
    const totalTokens = s.inputTokens + s.outputTokens;
    console.log(
      pad(truncate(s.bot, 17), 18) +
      pad(truncate(s.chatId, 31), 32) +
      pad(lastUsed, 20) +
      pad(String(s.calls), 7) +
      pad(formatTokens(totalTokens), 10) +
      pad('$' + s.costUsd.toFixed(2), 10) +
      pad(s.running ? '● running' : '○ idle', 8)
    );
  }
  console.log();
}

// ================================================================
// info — Show session details
// ================================================================

async function cmdSessionInfo(args: string[], sessionsDir: string): Promise<void> {
  const chatId = args[0];
  if (!chatId) {
    console.log('Usage: imtoagent session info <chatId>');
    console.log('  Find chatId with: imtoagent session list');
    return;
  }

  // Search across all bot directories
  const botDirs = fs.readdirSync(sessionsDir).filter((d) =>
    fs.statSync(path.join(sessionsDir, d)).isDirectory()
  );

  for (const botDir of botDirs) {
    const botPath = path.join(sessionsDir, botDir);
    const files = fs.readdirSync(botPath).filter((f) => f.endsWith('.memory.json'));

    for (const file of files) {
      try {
        const filePath = path.join(botPath, file);
        const raw = fs.readFileSync(filePath, 'utf-8');
        const data = JSON.parse(raw);
        const sessionChatId = data.chatId || file.replace('.memory.json', '');

        if (sessionChatId === chatId || file.replace('.memory.json', '') === chatId) {
          printSessionDetail(botDir, data);
          return;
        }
      } catch {
        // Skip corrupted
      }
    }
  }

  console.log(`Session not found: ${chatId}`);
}

function printSessionDetail(bot: string, data: any): void {
  console.log(`\n📋 Session Details — ${data.chatId || 'unknown'}\n`);
  console.log(`  Bot:          ${bot}`);
  console.log(`  Chat ID:      ${data.chatId || 'unknown'}`);
  console.log(`  User ID:      ${data.userId || 'unknown'}`);
  console.log(`  Backend:      ${data.metadata?.backend || 'unknown'}`);
  console.log(`  CWD:          ${data.cwd || '(default)'}`);
  console.log(`  Running:      ${data.running ? 'Yes' : 'No'}`);
  console.log(`  Start Fresh:  ${data.startFresh ? 'Yes' : 'No'}`);

  const lastUsed = data.lastUsed ? new Date(data.lastUsed).toLocaleString('zh-CN') : 'never';
  console.log(`  Last Used:    ${lastUsed}`);

  if (data.backendSessionId || data.metadata?.sdkSessionId || data.metadata?.codexThreadId) {
    console.log(`  Session ID:   ${data.backendSessionId || data.metadata.sdkSessionId || data.metadata.codexThreadId}`);
  }

  const stats = data.stats || {};
  console.log(`\n  Statistics:`);
  console.log(`    Calls:        ${stats.calls || 0}`);
  console.log(`    Turns:        ${stats.totalTurns || 0}`);
  console.log(`    Input tokens:  ${formatTokens(stats.totalInputTokens || 0)}`);
  console.log(`    Output tokens: ${formatTokens(stats.totalOutputTokens || 0)}`);
  console.log(`    Cost:         $${(stats.totalCostUSD || 0).toFixed(4)}`);
  console.log(`    Duration:     ${formatDuration(stats.totalDurationMs || 0)}`);

  if (data.recentMessages && data.recentMessages.length > 0) {
    console.log(`\n  Recent Messages: ${data.recentMessages.length}`);
  }
  console.log();
}

// ================================================================
// clear — Delete sessions
// ================================================================

async function cmdSessionClear(args: string[], sessionsDir: string): Promise<void> {
  const clearAll = args.includes('--all');
  const botFilter = args.includes('--bot') ? args[args.indexOf('--bot') + 1] : undefined;

  if (clearAll) {
    const botDirs = fs.readdirSync(sessionsDir).filter((d) =>
      fs.statSync(path.join(sessionsDir, d)).isDirectory()
    );

    let count = 0;
    for (const botDir of botDirs) {
      if (botFilter && botDir !== botFilter) continue;
      const botPath = path.join(sessionsDir, botDir);
      const files = fs.readdirSync(botPath).filter((f) => f.endsWith('.memory.json'));
      for (const file of files) {
        fs.unlinkSync(path.join(botPath, file));
        count++;
      }
    }

    console.log(`Cleared ${count} session(s).${botFilter ? ` (Bot: ${botFilter})` : ''}`);
    return;
  }

  const chatId = args.find((a) => !a.startsWith('--'));
  if (!chatId) {
    console.log('Usage: imtoagent session clear <chatId>');
    console.log('   or: imtoagent session clear --all');
    return;
  }

  // Find and delete specific session
  const botDirs = fs.readdirSync(sessionsDir).filter((d) =>
    fs.statSync(path.join(sessionsDir, d)).isDirectory()
  );

  for (const botDir of botDirs) {
    if (botFilter && botDir !== botFilter) continue;
    const botPath = path.join(sessionsDir, botDir);
    const files = fs.readdirSync(botPath).filter((f) => f.endsWith('.memory.json'));

    for (const file of files) {
      try {
        const filePath = path.join(botPath, file);
        const raw = fs.readFileSync(filePath, 'utf-8');
        const data = JSON.parse(raw);
        const sessionChatId = data.chatId || file.replace('.memory.json', '');

        if (sessionChatId === chatId || file.replace('.memory.json', '') === chatId) {
          fs.unlinkSync(filePath);
          console.log(`Session cleared: ${chatId} (Bot: ${botDir})`);
          return;
        }
      } catch {
        // Skip corrupted
      }
    }
  }

  console.log(`Session not found: ${chatId}`);
}

// ================================================================
// Helpers
// ================================================================

interface SessionSummary {
  bot: string;
  chatId: string;
  lastUsed: Date | null;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  running: boolean;
  backendSessionId: string;
  file: string;
}

function pad(s: string, width: number): string {
  return s.padEnd(width);
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.substring(0, max - 1) + '…' : s;
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

// ================================================================
// Help
// ================================================================

function printSessionHelp(): void {
  console.log(`
imtoagent session — Session management

Usage:
  imtoagent session list              List recent sessions (last 24h)
  imtoagent session list --all        List all sessions
  imtoagent session list --bot NAME   Filter by bot
  imtoagent session info <chatId>     Show session details
  imtoagent session clear <chatId>    Delete a session
  imtoagent session clear --all       Delete all sessions
`);
}
