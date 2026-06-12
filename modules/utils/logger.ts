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
  | 'log_rotate'
  | 'proxy_request'
  | 'proxy_upstream_request'
  | 'proxy_upstream_response'
  | 'proxy_upstream_error'
  | 'proxy_sse_start'
  | 'proxy_sse_end'
  | 'proxy_circuit_open'
  | 'proxy_codex_request'
  | 'im_message_received'
  | 'im_message_sent'
  | 'im_send_error';

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

// ================================================================
// Plain-text human-readable log (imtoagent.log)
// ================================================================

let _textLogStream: fs.WriteStream | null = null;
let _textLogPath: string | null = null;

export type LogLevel = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';

/**
 * Get or create the write stream for events.jsonl.
 * Lazily initialized on first call.
 */
/**
 * Get or create the write stream for imtoagent.log.
 * Lazily initialized on first call.
 */
function getTextLogStream(): fs.WriteStream {
  if (_textLogStream) return _textLogStream;

  try {
    const logsDir = getLogsDir();
    _textLogPath = path.join(logsDir, 'imtoagent.log');
    fs.mkdirSync(logsDir, { recursive: true });

    rotateTextLogIfNeeded();

    _textLogStream = fs.createWriteStream(_textLogPath, { flags: 'a' });
  } catch (err) {
    _textLogStream = null as NodeJS.WriteStream | null;
  }

  return _textLogStream;
}

function getLogStream(): fs.WriteStream {
  if (_logStream) return _logStream;

  try {
    const logsDir = getLogsDir();
    _logPath = path.join(logsDir, 'events.jsonl');
    fs.mkdirSync(logsDir, { recursive: true });

    // Check rotation on startup
    rotateLogIfNeeded();
    rotateTextLogIfNeeded();

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
 * Covers both events.jsonl.* and imtoagent.log.*.
 */
function cleanOldLogs(): void {
  const candidates: string[] = [];
  if (_logPath) candidates.push(path.basename(_logPath));
  if (_textLogPath) candidates.push(path.basename(_textLogPath));
  if (candidates.length === 0) return;

  const logsDirs = new Set<string>();
  if (_logPath) logsDirs.add(path.dirname(_logPath));
  if (_textLogPath) logsDirs.add(path.dirname(_textLogPath));

  const cutoff = Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000;

  for (const dir of logsDirs) {
    try {
      const files = fs.readdirSync(dir);
      for (const file of files) {
        if (!candidates.some((b) => file.startsWith(b))) continue;
        const filePath = path.join(dir, file);
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
    case 'proxy_request':
      return `[${ts}] 🌐 PROXY${bot} ${event.method || ''} ${event.path || ''}`;
    case 'proxy_upstream_request':
      return `[${ts}] 📤 PROXY OUT${bot} ${event.provider || ''}/${event.model || ''} stream=${event.stream}`;
    case 'proxy_upstream_response':
      return `[${ts}] 📥 PROXY IN${bot} ${event.provider || ''} status=${event.status || '?'}`;
    case 'proxy_upstream_error':
      return `[${ts}] ❌ PROXY ERR${bot} ${event.provider || ''} ${event.error || ''}`;
    case 'proxy_circuit_open':
      return `[${ts}] ⚡ PROXY CB${bot} ${event.provider || ''} circuit open`;
    case 'proxy_codex_request':
      return `[${ts}] 🤖 CODEX${bot} ${event.path || ''}`;
    case 'im_message_received':
      return `[${ts}] 📥 IM IN${bot} ${event.adapter || ''} chat=${(event.chatId || '').substring(0, 12)}`;
    case 'im_message_sent':
      return `[${ts}] 📤 IM OUT${bot} ${event.adapter || ''} chat=${(event.chatId || '').substring(0, 12)}`;
    case 'im_send_error':
      return `[${ts}] ❌ IM ERR${bot} ${event.adapter || ''} ${event.error || ''}`;
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

// ================================================================
// Log rotation for plain-text log
// ================================================================

/**
 * Check if the plain-text log needs rotation.
 */
function rotateTextLogIfNeeded(): void {
  if (!_textLogPath) return;

  try {
    if (!fs.existsSync(_textLogPath)) return;
    const stats = fs.statSync(_textLogPath);
    if (stats.size < MAX_LOG_SIZE) return;

    const logsDir = path.dirname(_textLogPath);
    const baseName = path.basename(_textLogPath);

    for (let i = MAX_ROTATED_FILES - 1; i >= 1; i--) {
      const src = path.join(logsDir, `${baseName}.${i}`);
      const dst = path.join(logsDir, `${baseName}.${i + 1}`);
      if (fs.existsSync(src)) {
        if (i + 1 > MAX_ROTATED_FILES) {
          fs.unlinkSync(src);
        } else {
          fs.renameSync(src, dst);
        }
      }
    }

    fs.renameSync(_textLogPath, path.join(logsDir, `${baseName}.1`));

    // Close old stream so next call creates a fresh one
    if (_textLogStream) {
      _textLogStream.end();
      _textLogStream = null;
    }
    _textLogPath = path.join(logsDir, baseName);
  } catch (err) {
    console.error(`[Logger] Text log rotation failed: ${(err as Error).message}`);
  }
}

// ================================================================
// Level-based logger API
// ================================================================

/**
 * Format a line for imtoagent.log:
 * [2026-06-12T06:00:00.000Z] [INFO] [module] msg
 */
function formatTextLogLine(level: LogLevel, module: string, msg: string): string {
  const ts = new Date().toISOString();
  return `[${ts}] [${level}] [${module}] ${msg}`;
}

function writeTextLog(level: LogLevel, module: string, msg: string, meta?: Record<string, unknown>): void {
  const line = formatTextLogLine(level, module, msg) +
    (meta ? ` ${JSON.stringify(meta)}` : '');
  const stream = getTextLogStream();
  if (stream && !stream.destroyed) {
    try {
      stream.write(line + '\n');
    } catch {
      // Silently drop
    }
  }
}

export const logger = {
  debug(module: string, msg: string, meta?: Record<string, unknown>): void {
    writeTextLog('DEBUG', module, msg, meta);
    const ts = new Date().toISOString().substring(11, 19);
    console.error(`[${ts}] [DEBUG] [${module}] ${msg}`);
  },

  info(module: string, msg: string, meta?: Record<string, unknown>): void {
    writeTextLog('INFO', module, msg, meta);
    const ts = new Date().toISOString().substring(11, 19);
    console.error(`[${ts}] [INFO] [${module}] ${msg}`);
  },

  warn(module: string, msg: string, meta?: Record<string, unknown>): void {
    writeTextLog('WARN', module, msg, meta);
    const ts = new Date().toISOString().substring(11, 19);
    console.error(`[${ts}] [WARN] [${module}] ${msg}`);
  },

  error(module: string, msg: string, meta?: Record<string, unknown>, err?: Error): void {
    const fullMsg = err ? `${msg} — ${err.message}` : msg;
    writeTextLog('ERROR', module, fullMsg, meta);
    const ts = new Date().toISOString().substring(11, 19);
    console.error(`[${ts}] [ERROR] [${module}] ${fullMsg}`);
    if (err?.stack) {
      const stream = getTextLogStream();
      if (stream && !stream.destroyed) {
        try {
          stream.write(err.stack + '\n');
        } catch {
          // Silently drop
        }
      }
      console.error(err.stack);
    }
  },
};
