// ================================================================
// Phase 0 测试：类型系统、解析器、isTaskDue
// ================================================================

// ================================================================
// removeTaskFromHeartbeatFile
// ================================================================

describe('removeTaskFromHeartbeatFile', () => {
  const tmpDir = path.join(process.env.HOME!, '.imtoagent', 'test-tmp');
  const testFile = path.join(tmpDir, 'test-heartbeat.md');

  beforeAll(() => {
    fs.mkdirSync(tmpDir, { recursive: true });
  });

  afterAll(() => {
    try { fs.unlinkSync(testFile); } catch {}
  });

  it('removes a single task from the tasks block', () => {
    const content = `Check system health.

tasks:

- name: disk-check
  interval: 1h
  prompt: "Check disk"

- name: morning-brief
  interval: 24h
  prompt: "Morning brief"
`;
    fs.writeFileSync(testFile, content);
    const result = removeTaskFromHeartbeatFile(testFile, 'disk-check');
    expect(result).toBe(true);

    const updated = fs.readFileSync(testFile, 'utf-8');
    expect(updated).not.toContain('disk-check');
    expect(updated).toContain('morning-brief');
    expect(updated).toContain('Check system health');
  });

  it('returns false for non-existent task', () => {
    const content = `tasks:

- name: disk-check
  interval: 1h
  prompt: "Check disk"
`;
    fs.writeFileSync(testFile, content);
    const result = removeTaskFromHeartbeatFile(testFile, 'non-existent');
    expect(result).toBe(false);
  });

  it('removes the last task, leaving empty tasks block', () => {
    const content = `tasks:

- name: only-task
  interval: 1h
  prompt: "Only task"
`;
    fs.writeFileSync(testFile, content);
    const result = removeTaskFromHeartbeatFile(testFile, 'only-task');
    expect(result).toBe(true);

    const updated = fs.readFileSync(testFile, 'utf-8');
    expect(updated).not.toContain('only-task');
    expect(updated).toContain('tasks:');
  });

  it('removes once task with all fields', () => {
    const content = `defaults:
  on_failure: ignore

tasks:

- name: remind-meeting
  type: once
  at: "2026-06-03 15:00"
  prompt: "提醒开会"

- name: disk-check
  interval: 1h
  prompt: "Check disk"
`;
    fs.writeFileSync(testFile, content);
    const result = removeTaskFromHeartbeatFile(testFile, 'remind-meeting');
    expect(result).toBe(true);

    const updated = fs.readFileSync(testFile, 'utf-8');
    expect(updated).not.toContain('remind-meeting');
    expect(updated).toContain('disk-check');
    expect(updated).toContain('defaults:');
  });

  it('handles file with no tasks block', () => {
    const content = `# HEARTBEAT.md
Check system health.
`;
    fs.writeFileSync(testFile, content);
    const result = removeTaskFromHeartbeatFile(testFile, 'any-task');
    expect(result).toBe(false);
  });
});

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import {
  parseHeartbeatDefaults,
  parseHeartbeatTasks,
  parseInterval,
  isTaskDue,
  parseDateTime,
  parseTimeToday,
  getTaskRunState,
  updateTaskRunState,
  stripHeartbeatTasksBlock,
  isHeartbeatContentEffectivelyEmpty,
  removeTaskFromHeartbeatFile,
} from '../modules/core/heartbeat';

// ================================================================
// parseHeartbeatDefaults
// ================================================================

describe('parseHeartbeatDefaults', () => {
  it('returns defaults when no defaults block', () => {
    const md = `
tasks:
- name: disk-check
  interval: 1h
  prompt: "Check disk"
`;
    const defaults = parseHeartbeatDefaults(md);
    expect(defaults.on_failure).toBe('ignore');
    expect(defaults.max_retries).toBe(3);
    expect(defaults.timeout).toBe('60s');
  });

  it('parses custom defaults block', () => {
    const md = `
defaults:
  on_failure: retry
  max_retries: 5
  timeout: 120s

tasks:
- name: disk-check
  interval: 1h
  prompt: "Check disk"
`;
    const defaults = parseHeartbeatDefaults(md);
    expect(defaults.on_failure).toBe('retry');
    expect(defaults.max_retries).toBe(5);
    expect(defaults.timeout).toBe('120s');
  });

  it('parses partial defaults', () => {
    const md = `
defaults:
  on_failure: alert

tasks:
- name: disk-check
  interval: 1h
  prompt: "Check disk"
`;
    const defaults = parseHeartbeatDefaults(md);
    expect(defaults.on_failure).toBe('alert');
    expect(defaults.max_retries).toBe(3); // default
    expect(defaults.timeout).toBe('60s'); // default
  });
});

// ================================================================
// parseHeartbeatTasks
// ================================================================

describe('parseHeartbeatTasks', () => {
  it('parses v2.2 format (backward compat)', () => {
    const md = `
tasks:
- name: disk-check
  interval: 1h
  prompt: "Check disk usage."
`;
    const result = parseHeartbeatTasks(md);
    expect(result.tasks).toHaveLength(1);
    expect(result.tasks[0].name).toBe('disk-check');
    expect(result.tasks[0].type).toBe('interval');
    expect(result.tasks[0].interval).toBe('1h');
    expect(result.tasks[0].prompt).toBe('Check disk usage.');
  });

  it('parses once task with at', () => {
    const md = `
tasks:
- name: remind-meeting
  type: once
  at: "2026-06-03 15:00"
  prompt: "提醒开会"
`;
    const result = parseHeartbeatTasks(md);
    expect(result.tasks).toHaveLength(1);
    expect(result.tasks[0].type).toBe('once');
    expect(result.tasks[0].at).toBe('2026-06-03 15:00');
  });

  it('parses once task with after', () => {
    const md = `
tasks:
- name: remind-water
  type: once
  after: "30m"
  prompt: "喝水"
`;
    const result = parseHeartbeatTasks(md);
    expect(result.tasks[0].type).toBe('once');
    expect(result.tasks[0].after).toBe('30m');
  });

  it('parses scheduled task', () => {
    const md = `
tasks:
- name: morning-brief
  type: scheduled
  at: "09:00"
  prompt: "Morning brief"

- name: weekly-report
  type: scheduled
  at: "09:00"
  on: "monday"
  prompt: "Weekly report"
`;
    const result = parseHeartbeatTasks(md);
    expect(result.tasks).toHaveLength(2);
    expect(result.tasks[0].type).toBe('scheduled');
    expect(result.tasks[0].at).toBe('09:00');
    expect(result.tasks[1].on).toBe('monday');
  });

  it('parses countdown task', () => {
    const md = `
tasks:
- name: retry-deploy
  type: countdown
  interval: 30m
  max_runs: 5
  prompt: "Check deploy"
`;
    const result = parseHeartbeatTasks(md);
    expect(result.tasks).toHaveLength(1);
    expect(result.tasks[0].type).toBe('countdown');
    expect(result.tasks[0].max_runs).toBe(5);
  });

  it('skips once task missing at/after', () => {
    const md = `
tasks:
- name: broken-once
  type: once
  prompt: "This should be skipped"
`;
    const result = parseHeartbeatTasks(md);
    expect(result.tasks).toHaveLength(0);
  });

  it('skips scheduled task missing at', () => {
    const md = `
tasks:
- name: broken-scheduled
  type: scheduled
  prompt: "This should be skipped"
`;
    const result = parseHeartbeatTasks(md);
    expect(result.tasks).toHaveLength(0);
  });

  it('merges defaults into tasks', () => {
    const md = `
defaults:
  on_failure: retry
  max_retries: 5
  timeout: 30s

tasks:
- name: disk-check
  interval: 1h
  prompt: "Check disk"

- name: critical
  interval: 30m
  on_failure: alert
  prompt: "Critical check"
`;
    const result = parseHeartbeatTasks(md);
    expect(result.tasks).toHaveLength(2);
    // disk-check inherits defaults
    expect(result.tasks[0].on_failure).toBe('retry');
    expect(result.tasks[0].max_retries).toBe(5);
    expect(result.tasks[0].timeout).toBe('30s');
    // critical overrides on_failure
    expect(result.tasks[1].on_failure).toBe('alert');
    expect(result.tasks[1].max_retries).toBe(5); // still inherited
  });

  it('parses multiple tasks of different types', () => {
    const md = `
tasks:
- name: interval-task
  interval: 30m
  prompt: "Interval task"

- name: once-task
  type: once
  after: "10m"
  prompt: "Once task"

- name: scheduled-task
  type: scheduled
  at: "09:00"
  prompt: "Scheduled task"

- name: countdown-task
  type: countdown
  interval: 30m
  deadline: "2026-06-03 18:00"
  prompt: "Countdown task"
`;
    const result = parseHeartbeatTasks(md);
    expect(result.tasks).toHaveLength(4);
    expect(result.tasks.map(t => t.type)).toEqual([
      'interval',
      'once',
      'scheduled',
      'countdown',
    ]);
  });
});

// ================================================================
// parseInterval
// ================================================================

describe('parseInterval', () => {
  it('parses seconds', () => {
    expect(parseInterval('30s')).toBe(30_000);
    expect(parseInterval('1s')).toBe(1_000);
  });

  it('parses minutes', () => {
    expect(parseInterval('5m')).toBe(5 * 60 * 1_000);
    expect(parseInterval('30m')).toBe(30 * 60 * 1_000);
  });

  it('parses hours', () => {
    expect(parseInterval('1h')).toBe(60 * 60 * 1_000);
    expect(parseInterval('24h')).toBe(24 * 60 * 60 * 1_000);
  });

  it('parses days', () => {
    expect(parseInterval('1d')).toBe(24 * 60 * 60 * 1_000);
  });

  it('returns null for invalid format', () => {
    expect(parseInterval('abc')).toBeNull();
    expect(parseInterval('5')).toBeNull();
    expect(parseInterval('')).toBeNull();
  });
});

// ================================================================
// isTaskDue
// ================================================================

describe('isTaskDue', () => {
  const now = Date.now();

  describe('interval type', () => {
    it('first run is due', () => {
      const task = { name: 'test', type: 'interval' as const, interval: '1h', prompt: 'test' };
      expect(isTaskDue(task, undefined, now, undefined).due).toBe(true);
    });

    it('not due if interval not elapsed', () => {
      const task = { name: 'test', type: 'interval' as const, interval: '1h', prompt: 'test' };
      const lastRunAt = now - 30 * 60 * 1_000; // 30 min ago
      expect(isTaskDue(task, lastRunAt, now, undefined).due).toBe(false);
    });

    it('due if interval elapsed', () => {
      const task = { name: 'test', type: 'interval' as const, interval: '1h', prompt: 'test' };
      const lastRunAt = now - 2 * 60 * 60 * 1_000; // 2 hours ago
      expect(isTaskDue(task, lastRunAt, now, undefined).due).toBe(true);
    });
  });

  describe('once type (at)', () => {
    it('due when past target time', () => {
      const past = new Date(now - 60 * 1_000); // 1 min ago
      const at = `${past.getFullYear()}-${String(past.getMonth() + 1).padStart(2, '0')}-${String(past.getDate()).padStart(2, '0')} ${String(past.getHours()).padStart(2, '0')}:${String(past.getMinutes()).padStart(2, '0')}`;
      const task = { name: 'test', type: 'once' as const, at, prompt: 'test' };
      expect(isTaskDue(task, undefined, now, undefined).due).toBe(true);
    });

    it('not due when future target time', () => {
      // Build 'at' string from a future timestamp, converting to Shanghai time for parseDateTime
      const futureTs = now + 2 * 60 * 60 * 1_000; // 2 hours from now
      const futureShanghai = new Date(futureTs + 8 * 60 * 60 * 1_000);
      const at = `${futureShanghai.getUTCFullYear()}-${String(futureShanghai.getUTCMonth() + 1).padStart(2, '0')}-${String(futureShanghai.getUTCDate()).padStart(2, '0')} ${String(futureShanghai.getUTCHours()).padStart(2, '0')}:${String(futureShanghai.getUTCMinutes()).padStart(2, '0')}`;
      const task = { name: 'test', type: 'once' as const, at, prompt: 'test' };
      expect(isTaskDue(task, undefined, now, undefined).due).toBe(false);
    });

    it('not due if already executed', () => {
      const past = new Date(now - 60 * 1_000);
      const at = `${past.getFullYear()}-${String(past.getMonth() + 1).padStart(2, '0')}-${String(past.getDate()).padStart(2, '0')} ${String(past.getHours()).padStart(2, '0')}:${String(past.getMinutes()).padStart(2, '0')}`;
      const task = { name: 'test', type: 'once' as const, at, prompt: 'test' };
      expect(isTaskDue(task, now - 30_000, now, undefined).due).toBe(false);
    });
  });

  describe('once type (after)', () => {
    it('due after delay elapsed', () => {
      const task = { name: 'test', type: 'once' as const, after: '1m', prompt: 'test' };
      const createdAt = now - 2 * 60 * 1_000; // created 2 min ago
      expect(isTaskDue(task, undefined, now, createdAt).due).toBe(true);
    });

    it('not due if delay not elapsed', () => {
      const task = { name: 'test', type: 'once' as const, after: '5m', prompt: 'test' };
      const createdAt = now - 1 * 60 * 1_000; // created 1 min ago
      expect(isTaskDue(task, undefined, now, createdAt).due).toBe(false);
    });

    it('not due if no createdAt', () => {
      const task = { name: 'test', type: 'once' as const, after: '1m', prompt: 'test' };
      expect(isTaskDue(task, undefined, now, undefined).due).toBe(false);
    });
  });

  describe('scheduled type', () => {
    it('first run due when time passed today', () => {
      // Compute Shanghai time from UTC now, then use a past Shanghai time
      // Shanghai = UTC+8, so Shanghai ms = now + 8*60*60*1000
      const shanghaiNow = now + 8 * 60 * 60 * 1_000;
      const shanghaiDate = new Date(shanghaiNow);
      // 1 hour ago in Shanghai time
      const pastShanghai = new Date(shanghaiNow - 60 * 60 * 1_000);
      const at = `${String(pastShanghai.getUTCHours()).padStart(2, '0')}:${String(pastShanghai.getUTCMinutes()).padStart(2, '0')}`;
      const task = { name: 'test', type: 'scheduled' as const, at, prompt: 'test' };
      expect(isTaskDue(task, undefined, now, undefined).due).toBe(true);
    });

    it('not due if already executed today', () => {
      const task = { name: 'test', type: 'scheduled' as const, at: '08:00', prompt: 'test' };
      const lastRunAt = now - 30 * 60 * 1_000; // 30 min ago (same day)
      expect(isTaskDue(task, lastRunAt, now, undefined).due).toBe(false);
    });

    it('not due on wrong weekday', () => {
      const weekdays = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
      const today = weekdays[new Date().getDay()];
      // Pick a different day
      const otherDay = weekdays[(new Date().getDay() + 1) % 7];
      const past = new Date(now - 60 * 60 * 1_000);
      const at = `${String(past.getHours()).padStart(2, '0')}:${String(past.getMinutes()).padStart(2, '0')}`;
      const task = { name: 'test', type: 'scheduled' as const, at, on: otherDay, prompt: 'test' };
      expect(isTaskDue(task, undefined, now, undefined).due).toBe(false);
    });
  });

  describe('countdown type', () => {
    it('not due after deadline passed', () => {
      const past = new Date(now - 60 * 60 * 1_000);
      const deadline = `${past.getFullYear()}-${String(past.getMonth() + 1).padStart(2, '0')}-${String(past.getDate()).padStart(2, '0')} ${String(past.getHours()).padStart(2, '0')}:${String(past.getMinutes()).padStart(2, '0')}`;
      const task = { name: 'test', type: 'countdown' as const, interval: '1m', deadline, prompt: 'test' };
      expect(isTaskDue(task, undefined, now, undefined).due).toBe(false);
    });

    it('due when interval elapsed and deadline not passed', () => {
      // Build deadline string in Shanghai time since parseDateTime interprets it as such
      const futureShanghai = new Date(now + 60 * 60 * 1_000 + 8 * 60 * 60 * 1_000);
      const deadline = `${futureShanghai.getUTCFullYear()}-${String(futureShanghai.getUTCMonth() + 1).padStart(2, '0')}-${String(futureShanghai.getUTCDate()).padStart(2, '0')} ${String(futureShanghai.getUTCHours()).padStart(2, '0')}:${String(futureShanghai.getUTCMinutes()).padStart(2, '0')}`;
      const task = { name: 'test', type: 'countdown' as const, interval: '30m', deadline, prompt: 'test' };
      // first run
      expect(isTaskDue(task, undefined, now, undefined).due).toBe(true);
      // after interval elapsed
      const lastRunAt = now - 35 * 60 * 1_000;
      expect(isTaskDue(task, lastRunAt, now, undefined).due).toBe(true);
    });
  });
});

// ================================================================
// parseDateTime / parseTimeToday
// ================================================================

describe('parseDateTime', () => {
  it('parses YYYY-MM-DD HH:MM', () => {
    const ts = parseDateTime('2026-06-03 15:00');
    expect(typeof ts).toBe('number');
    expect(isNaN(ts)).toBe(false);
  });

  it('returns NaN for invalid format', () => {
    expect(isNaN(parseDateTime('invalid'))).toBe(true);
    expect(isNaN(parseDateTime('2026-06-03'))).toBe(true);
  });
});

describe('parseTimeToday', () => {
  it('parses HH:MM as today', () => {
    const ts = parseTimeToday('09:00');
    expect(isNaN(ts)).toBe(false);
    // parseTimeToday builds a local-date + HH:MM timestamp; verify the UTC hour matches Asia/Shanghai offset
    // At Asia/Shanghai (UTC+8), 09:00 local = 01:00 UTC
    const d = new Date(ts);
    expect(d.getUTCHours()).toBe(1); // 09:00 CST = 01:00 UTC
    expect(d.getMinutes()).toBe(0);
  });
});

// ================================================================
// TaskRunState helpers
// ================================================================

describe('getTaskRunState', () => {
  it('returns default for undefined', () => {
    const state = getTaskRunState(undefined);
    expect(state.lastRunAt).toBe(0);
    expect(state.runCount).toBe(0);
    expect(state.createdAt).toBe(0);
  });

  it('converts v2.2 number to TaskRunState', () => {
    const ts = Date.now();
    const state = getTaskRunState(ts);
    expect(state.lastRunAt).toBe(ts);
    expect(state.runCount).toBe(1);
    expect(state.createdAt).toBe(ts);
  });

  it('passes through v3 TaskRunState', () => {
    const input = { lastRunAt: 100, runCount: 5, createdAt: 50 };
    const state = getTaskRunState(input);
    expect(state).toEqual(input);
  });
});

describe('updateTaskRunState', () => {
  it('increments runCount from v2.2 number', () => {
    const ts = 1000;
    const now = 2000;
    const state = updateTaskRunState(ts, now);
    expect(state.lastRunAt).toBe(2000);
    expect(state.runCount).toBe(2);
    expect(state.createdAt).toBe(1000);
  });

  it('increments from undefined (first run)', () => {
    const now = 1500;
    const state = updateTaskRunState(undefined, now);
    expect(state.lastRunAt).toBe(1500);
    expect(state.runCount).toBe(1);
    expect(state.createdAt).toBe(1500);
  });
});

// ================================================================
// stripHeartbeatTasksBlock
// ================================================================

describe('stripHeartbeatTasksBlock', () => {
  it('removes tasks block', () => {
    const md = `
Check system health.

tasks:
- name: disk-check
  interval: 1h
  prompt: "Check disk"
`;
    const result = stripHeartbeatTasksBlock(md);
    expect(result).toContain('Check system health');
    expect(result).not.toContain('disk-check');
  });

  it('removes ## Tasks markdown block', () => {
    const md = `
Check system health.

## Tasks
- name: disk-check
  interval: 1h
  prompt: "Check disk"
`;
    const result = stripHeartbeatTasksBlock(md);
    expect(result).toContain('Check system health');
    expect(result).not.toContain('disk-check');
  });
});

describe('isHeartbeatContentEffectivelyEmpty', () => {
  it('returns true for empty content', () => {
    expect(isHeartbeatContentEffectivelyEmpty('')).toBe(true);
    expect(isHeartbeatContentEffectivelyEmpty('   \n\n  ')).toBe(true);
    expect(isHeartbeatContentEffectivelyEmpty('# comment only')).toBe(true);
  });

  it('returns true for only tasks block', () => {
    const md = `
tasks:
- name: disk-check
  interval: 1h
  prompt: "Check disk"
`;
    // The tasks block IS content, but after stripping tasks, the non-tasks part is empty
    // isHeartbeatContentEffectivelyEmpty checks the full content
    expect(isHeartbeatContentEffectivelyEmpty(md)).toBe(false);
  });

  it('returns false for content with tasks', () => {
    const md = `
Check system health.

tasks:
- name: disk-check
  interval: 1h
  prompt: "Check disk"
`;
    expect(isHeartbeatContentEffectivelyEmpty(md)).toBe(false);
  });
});
