// ================================================================
// Structured Logger — JSONL event logging
// ================================================================
// Writes append-only JSONL to ~/.imtoagent/logs/events.jsonl
// Events: message_received, message_sent, error, stats_flush, session_create, session_destroy
// ================================================================

import * as fs from 'fs';
import * as path from 'path';
import { getLogsDir } from './paths';

// ================================================================
// Log rotation config
// ================================================================
const MAX_LOG_SIZE = 10 * 1024 * 1024; // 10 MB
const MAX_ROTATED_FILES = 7;
const RETENTION_DAYS = 30;

// ================================================================
// Event types
// ================================================================

export type LogEventType =
  | 'message_received'
  | 'message_sent'
  | 'error'
  | 'stats_flush'
  | 'session_create'
  | 'session_destroy'
  | 'gateway_start'
  | 'gateway_stop'
  | 'config_change'
  | 'log_rotate';

export interface LogEvent {
  ts: string;
  event: LogEventType;
  bot?: string;
  chatId?: string;
  backend?: string;
  model?: string;
  [key: string]: unknown;
}

// ================================================================
// Append-only JSONL writer
// ================================================================

let _logStream: fs.WriteStream | null = null;
let _logPath: string | null = null;

/**
 * Get or create the write stream for events.jsonl.
 * Lazily initialized on first call.
 */
function getLogStream(): fs.WriteStream {
  if (_logStream) return _logStream;

  try {
    const logsDir = getLogsDir();
    _logPath = path.join(logsDir, 'events.jsonl');
    fs.mkdirSync(logsDir, { recursive: true });

    // Check rotation on startup
    rotateLogIfNeeded();

    _logStream = fs.createWriteStream(_logPath, { flags: 'a' });
  } catch (err) {
    // If we can't write to the log file, fall back to silent no-op
    // (console.error would create infinite loops if called from logging code)
    _logStream = null as NodeJS.WriteStream | null;
  }

  return _logStream;
}

// ================================================================
// Log rotation
// ================================================================

/**
 * Check if log rotation is needed and perform it.
 * Rules:
 *  - Rotate if file exceeds MAX_LOG_SIZE (10 MB)
 *  - Keep at most MAX_ROTATED_FILES rotated files
 *  - Clean files older than RETENTION_DAYS (30 days)
 */
function rotateLogIfNeeded(): void {
  if (!_logPath) return;

  try {
    // Clean old files first
    cleanOldLogs();

    // Check if current file needs rotation
    if (!fs.existsSync(_logPath)) return;
    const stats = fs.statSync(_logPath);
    if (stats.size < MAX_LOG_SIZE) return;

    // Rotate: events.jsonl → events.jsonl.1 → .2 → ...
    const logsDir = path.dirname(_logPath);
    const baseName = path.basename(_logPath); // events.jsonl

    // Shift existing rotated files
    for (let i = MAX_ROTATED_FILES - 1; i >= 1; i--) {
      const src = path.join(logsDir, `${baseName}.${i}`);
      const dst = path.join(logsDir, `${baseName}.${i + 1}`);
      if (fs.existsSync(src)) {
        if (i + 1 > MAX_ROTATED_FILES) {
          fs.unlinkSync(src); // Delete if exceeds max
        } else {
          fs.renameSync(src, dst);
        }
      }
    }

    // Move current to .1
    fs.renameSync(_logPath, path.join(logsDir, `${baseName}.1`));

    // Update internal path and stream references
    // The caller will create a new stream after this
    _logPath = path.join(logsDir, baseName);
  } catch (err) {
    console.error(`[Logger] Log rotation failed: ${(err as Error).message}`);
  }
}

/**
 * Delete rotated log files older than RETENTION_DAYS.
 */
function cleanOldLogs(): void {
  if (!_logPath) return;
  const logsDir = path.dirname(_logPath);
  const baseName = path.basename(_logPath);
  const cutoff = Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000;

  try {
    const files = fs.readdirSync(logsDir);
    for (const file of files) {
      if (!file.startsWith(baseName)) continue;
      const filePath = path.join(logsDir, file);
      try {
        const stats = fs.statSync(filePath);
        if (stats.mtimeMs < cutoff) {
          fs.unlinkSync(filePath);
        }
      } catch {
        // Skip files we can't stat
      }
    }
  } catch {
    // Directory may not exist yet
  }
}

/**
 * Log an event to the JSONL file.
 * Also echoes to console.error for development/debugging.
 */
export function logEvent(event: LogEvent): void {
  // Always set timestamp
  event.ts = event.ts || new Date().toISOString();

  // Echo to stderr (visible in gateway logs)
  const summary = formatEventSummary(event);
  if (summary) {
    console.error(summary);
  }

  // Check rotation before writing (handles daily rotation + size-based)
  rotateLogIfNeeded();

  // Append to JSONL file
  const stream = getLogStream();
  if (stream && !stream.destroyed) {
    try {
      stream.write(JSON.stringify(event) + '\n');
    } catch {
      // Silently drop if write fails (disk full, etc.)
    }
  }
}

/**
 * Format a one-line summary for console.error output.
 */
function formatEventSummary(event: LogEvent): string {
  const ts = event.ts.substring(11, 19); // HH:MM:SS
  const bot = event.bot ? ` [${event.bot}]` : '';
  const chat = event.chatId ? ` ${event.chatId.substring(0, 12)}...` : '';

  switch (event.event) {
    case 'message_received':
      return `[${ts}] 📥 MSG IN${bot}${chat} text=${String(event.textLength || '?')} chars`;
    case 'message_sent':
      return `[${ts}] 📤 MSG OUT${bot}${chat} tokens=${event.outputTokens || '?'} cost=$${event.costUsd || '0'}`;
    case 'error':
      return `[${ts}] ❌ ERROR${bot}${chat} ${event.message || 'unknown'}`;
    case 'stats_flush':
      return `[${ts}] 📊 STATS${bot} calls=${event.calls || 0} tokens=${event.totalTokens || 0}`;
    case 'session_create':
      return `[${ts}] 🆕 SESSION${bot}${chat}`;
    case 'session_destroy':
      return `[${ts}] 🗑️ SESSION${bot}${chat}`;
    case 'gateway_start':
      return `[${ts}] 🚀 Gateway started (pid=${process.pid})`;
    case 'gateway_stop':
      return `[${ts}] 🛑 Gateway stopped`;
    case 'config_change':
      return `[${ts}] ⚙️  CONFIG${bot} ${event.action || 'modified'}`;
    default:
      return `[${ts}] 📝 ${event.event}${bot}${chat}`;
  }
}

/**
 * Flush and close the log stream (for graceful shutdown).
 */
export function flushLogs(): Promise<void> {
  return new Promise((resolve) => {
    if (_logStream && !_logStream.destroyed) {
      _logStream.end(() => {
        _logStream = null;
        _logPath = null;
        resolve();
      });
    } else {
      resolve();
    }
  });
}

/**
 * Read recent log entries (for CLI display or debugging).
 */
export function readRecentLogs(maxLines: number = 50): LogEvent[] {
  if (!_logPath || !fs.existsSync(_logPath)) {
    return [];
  }

  try {
    const content = fs.readFileSync(_logPath, 'utf-8');
    const lines = content.trim().split('\n').filter(Boolean);
    const recent = lines.slice(-maxLines);
    return recent.map((line) => {
      try {
        return JSON.parse(line) as LogEvent;
      } catch {
        return null;
      }
    }).filter(Boolean) as LogEvent[];
  } catch {
    return [];
  }
}
