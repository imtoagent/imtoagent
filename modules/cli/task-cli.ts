// ================================================================
// Task CLI — 定时任务管理命令
// ================================================================
// imtoagent task list                     — 列出所有任务
// imtoagent task add name=xxx type=interval interval=5m prompt='...'
// imtoagent task remove name=xxx
// imtoagent task update name=xxx interval=10m
//
// 设计目标：Agent 通过 Bash 工具调用此命令管理定时任务，
// 无需知道 HEARTBEAT.md 文件路径。
// ================================================================

import * as fs from 'fs';
import * as path from 'path';
import { getDataDir } from '../utils/paths';
import { TaskManager } from '../core/task-manager';
import type { ScheduledTask, TaskType, OnFailureStrategy } from '../core/types';

// ================================================================
// 解析 Bot ID（从 bot-ids.json）
// ================================================================

function resolveBotId(botName: string): string | null {
  const botIdsFile = path.join(getDataDir(), 'bot-ids.json');
  if (!fs.existsSync(botIdsFile)) return null;

  try {
    const botIds: Record<string, string> = JSON.parse(fs.readFileSync(botIdsFile, 'utf-8'));
    return botIds[botName] || null;
  } catch {
    return null;
  }
}

// ================================================================
// 解析 HEARTBEAT.md 路径
// ================================================================

function resolveHeartbeatPath(botName?: string): string | null {
  const dataDir = getDataDir();
  const workspacesDir = path.join(dataDir, 'workspaces');

  // 方法 1: 指定 bot 名 → 查 UUID → 拼路径
  if (botName) {
    const botId = resolveBotId(botName);
    if (botId) {
      const hbPath = path.join(workspacesDir, botId, 'HEARTBEAT.md');
      if (fs.existsSync(hbPath)) return hbPath;
    }
  }

  // 方法 2: 遍历 workspaces 找第一个 HEARTBEAT.md
  if (fs.existsSync(workspacesDir)) {
    const entries = fs.readdirSync(workspacesDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        const hbPath = path.join(workspacesDir, entry.name, 'HEARTBEAT.md');
        if (fs.existsSync(hbPath)) return hbPath;
      }
    }
  }

  // 方法 3: 回退到 dataDir 根目录
  const fallback = path.join(dataDir, 'HEARTBEAT.md');
  if (fs.existsSync(fallback)) return fallback;

  return null;
}

// ================================================================
// 解析 key=value 参数
// ================================================================

function parseArgs(args: string[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (const arg of args) {
    const eqIndex = arg.indexOf('=');
    if (eqIndex > 0) {
      const key = arg.slice(0, eqIndex);
      const value = arg.slice(eqIndex + 1);
      result[key] = value;
    }
  }
  return result;
}

// ================================================================
// 获取 TaskManager 实例（统一路径解析 + 错误处理）
// ================================================================

function getTaskManager(botName?: string): TaskManager | null {
  const hbPath = resolveHeartbeatPath(botName);
  if (!hbPath) {
    console.error('❌ 未找到 HEARTBEAT.md 文件。请先创建至少一个定时任务，或指定正确的 bot 名。');
    return null;
  }
  return new TaskManager(hbPath);
}

// ================================================================
// 子命令实现
// ================================================================

async function cmdTaskList(params: Record<string, string>): Promise<void> {
  const tm = getTaskManager(params.bot);
  if (!tm) process.exit(1);

  const tasks = tm.listTasks();

  if (tasks.length === 0) {
    console.log('📋 没有定时任务');
    return;
  }

  console.log(`📋 定时任务 (${tasks.length} 个):\n`);
  for (const t of tasks) {
    const type = t.type || 'interval';
    const timing = t.interval || t.at || t.after || t.cron || '-';
    console.log(`  • ${t.name}`);
    console.log(`    类型: ${type} | 触发: ${timing}`);
    console.log(`    动作: ${t.prompt}`);
    if (t.on_failure) console.log(`    失败策略: ${t.on_failure}`);
    console.log();
  }
}

async function cmdTaskAdd(args: string[]): Promise<void> {
  const params = parseArgs(args);

  if (!params.name) {
    console.error('❌ 缺少 name 参数: imtoagent task add name=xxx type=interval interval=5m prompt="..."');
    process.exit(1);
  }
  if (!params.prompt) {
    console.error('❌ 缺少 prompt 参数');
    process.exit(1);
  }

  const tm = getTaskManager(params.bot);
  if (!tm) process.exit(1);

  const task: ScheduledTask = {
    name: params.name,
    type: (params.type as TaskType) || 'interval',
    prompt: params.prompt,
  };

  if (params.interval) task.interval = params.interval;
  if (params.at) task.at = params.at;
  if (params.after) task.after = params.after;
  if (params.on) task.on = params.on;
  if (params.cron) task.cron = params.cron;
  if (params.max_runs) task.max_runs = parseInt(params.max_runs, 10);
  if (params.deadline) task.deadline = params.deadline;
  if (params.on_failure) task.on_failure = params.on_failure as OnFailureStrategy;
  if (params.max_retries) task.max_retries = parseInt(params.max_retries, 10);
  if (params.timeout) task.timeout = params.timeout;
  if (params.condition) task.condition = params.condition;
  if (params.bot_ref) task.bot = params.bot_ref;
  if (params.on_complete) task.on_complete = params.on_complete;
  if (params.auto_stop) task.auto_stop = params.auto_stop;

  const result = tm.addTask(task);
  if (result.success) {
    const type = task.type || 'interval';
    const timing = task.interval || task.at || task.after || task.cron || '-';
    console.log(`✅ 已创建任务: ${task.name} (${type}, ${timing})`);
  } else {
    console.error(`❌ 创建失败: ${result.error}`);
    process.exit(1);
  }
}

async function cmdTaskRemove(params: Record<string, string>): Promise<void> {
  if (!params.name) {
    console.error('❌ 缺少 name 参数: imtoagent task remove name=xxx');
    process.exit(1);
  }

  const tm = getTaskManager(params.bot);
  if (!tm) process.exit(1);

  const result = tm.removeTask(params.name);

  if (result.success) {
    console.log(`✅ 已删除任务: ${params.name}`);
  } else {
    console.error(`❌ 删除失败: ${result.error}`);
    process.exit(1);
  }
}

async function cmdTaskUpdate(args: string[]): Promise<void> {
  const params = parseArgs(args);

  if (!params.name) {
    console.error('❌ 缺少 name 参数: imtoagent task update name=xxx interval=10m');
    process.exit(1);
  }

  const tm = getTaskManager(params.bot);
  if (!tm) process.exit(1);

  // 构建更新对象（排除 name 和 bot，因为它们用于查找）
  const updates: Partial<ScheduledTask> = {};
  for (const [key, value] of Object.entries(params)) {
    if (key === 'name' || key === 'bot') continue;

    // 数字字段转换
    if (key === 'max_runs' || key === 'max_retries') {
      (updates as Record<string, unknown>)[key] = parseInt(value, 10);
    } else {
      (updates as Record<string, unknown>)[key] = value;
    }
  }

  const result = tm.updateTask(params.name, updates);
  if (result.success) {
    console.log(`✅ 已更新任务: ${params.name}`);
  } else {
    console.error(`❌ 更新失败: ${result.error}`);
    process.exit(1);
  }
}

// ================================================================
// 入口
// ================================================================

export async function cmdTask(...args: string[]): Promise<void> {
  const subcommand = args[0];

  switch (subcommand) {
    case 'list':
    case 'ls':
      await cmdTaskList(parseArgs(args.slice(1)));
      break;

    case 'add':
      await cmdTaskAdd(args.slice(1));
      break;

    case 'remove':
    case 'rm':
    case 'delete':
      await cmdTaskRemove(parseArgs(args.slice(1)));
      break;

    case 'update':
    case 'edit':
      await cmdTaskUpdate(args.slice(1));
      break;

    case 'help':
    case '--help':
    case '-h':
      console.log(`用法: imtoagent task <子命令> [参数]

子命令:
  list                          列出所有定时任务
  add name=X type=T prompt=P    创建任务
  remove name=X                 删除任务
  update name=X 字段=值          更新任务

参数:
  bot=<name>                    指定 Bot 名（可选，默认第一个）
  name=<name>                   任务名（必填）
  type=<type>                   类型: interval(默认) | once | scheduled | countdown | conditional | cron
  prompt=<text>                 任务触发动作（必填）
  interval=<dur>                间隔: 30s / 5m / 1h / 1d
  at=<time>                     指定时间: "14:30" 或 "2026-06-03 14:30"
  after=<dur>                   相对延迟: 10m / 1h
  on=<day>                      星期: monday / weekday 等
  cron=<expr>                   Cron 表达式
  max_runs=<n>                  最大运行次数
  deadline=<time>               截止时间
  on_failure=<str>              失败策略: ignore | alert | retry
  max_retries=<n>               最大重试次数
  timeout=<dur>                 超时时间

示例:
  imtoagent task list
  imtoagent task add name=standup type=scheduled at=09:00 prompt="提醒站会"
  imtoagent task add name=check-disk type=interval interval=1h prompt="检查磁盘"
  imtoagent task add name=remind type=once after=10m prompt="提醒我"
  imtoagent task remove name=standup
  imtoagent task update name=check-disk interval=2h`);
      break;

    default:
      console.error(`❌ 未知子命令: ${subcommand}`);
      console.error('运行 imtoagent task help 查看用法');
      process.exit(1);
  }
}
