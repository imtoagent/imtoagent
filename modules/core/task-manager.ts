// ================================================================
// TaskManager — 任务 CRUD 接口（Phase 3）
// ================================================================
// 提供标准化的任务增删改查 API，Agent 可通过对话调用。
// 所有操作通过解析 → 修改 → 序列化 HEARTBEAT.md 完成。
// ================================================================

import * as fs from 'fs';
import type { ScheduledTask, TaskType, OnFailureStrategy } from './types';
import { parseHeartbeatTasks, parseInterval } from './heartbeat';

export interface TaskOpResult {
  success: boolean;
  error?: string;
}

export class TaskManager {
  constructor(private heartbeatFilePath: string) {}

  /**
   * 列出所有任务
   */
  listTasks(): ScheduledTask[] {
    const md = this.read();
    return parseHeartbeatTasks(md);
  }

  /**
   * 按名称查找任务
   */
  getTask(name: string): ScheduledTask | undefined {
    return this.listTasks().find(t => t.name === name);
  }

  /**
   * 添加任务到 HEARTBEAT.md
   */
  addTask(task: ScheduledTask): TaskOpResult {
    // 校验
    const existing = this.getTask(task.name);
    if (existing) {
      return { success: false, error: `任务 "${task.name}" 已存在` };
    }

    const type = task.type ?? 'interval';
    if (type === 'interval' || type === 'countdown') {
      if (!task.interval) return { success: false, error: `${type} 类型需要 interval 字段` };
      if (!parseInterval(task.interval)) return { success: false, error: `interval "${task.interval}" 格式无效（如 5m, 1h, 30s）` };
    }
    if (type === 'once' && !task.at && !task.after) {
      return { success: false, error: `once 类型需要 at 或 after 字段` };
    }
    if (type === 'scheduled' && !task.at) {
      return { success: false, error: `scheduled 类型需要 at 字段` };
    }
    if (!task.prompt) {
      return { success: false, error: `任务 "${task.name}" 缺少 prompt` };
    }

    const md = this.read();
    const taskBlock = this.taskToYaml(task);

    // 插入到 tasks: 块末尾
    const newContent = this.insertTaskIntoContent(md, taskBlock);
    this.write(newContent);

    return { success: true };
  }

  /**
   * 按名称删除任务
   */
  removeTask(name: string): TaskOpResult {
    const existing = this.getTask(name);
    if (!existing) {
      return { success: false, error: `任务 "${name}" 不存在` };
    }

    const md = this.read();
    const lines = md.split('\n');
    const result: string[] = [];
    let inTasksBlock = false;
    let inTargetTask = false;
    let removed = false;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const trimmed = line.trim();

      // 检测 tasks: 块开始
      if (!inTasksBlock && /^(tasks:|##\s+tasks|#\s+tasks)$/i.test(trimmed)) {
        inTasksBlock = true;
        result.push(line);
        continue;
      }

      // tasks 块内，遇到新 ## 标题则退出
      if (inTasksBlock && /^##\s/.test(trimmed)) {
        inTasksBlock = false;
        inTargetTask = false;
        result.push(line);
        continue;
      }

      // tasks 块内，检测目标任务
      if (inTasksBlock && !inTargetTask) {
        const nameMatch = trimmed.match(/^-\s+name:\s*(.+?)\s*$/);
        if (nameMatch && nameMatch[1].trim() === name) {
          inTargetTask = true;
          removed = true;
          continue;
        }
        result.push(line);
        continue;
      }

      // 正在删除目标任务，跳过所有缩进行
      if (inTargetTask) {
        if (line === '' || (!line.startsWith('  ') && !line.startsWith('\t'))) {
          inTargetTask = false;
          result.push(line);
          continue;
        }
        continue;
      }

      result.push(line);
    }

    if (!removed) {
      return { success: false, error: `任务 "${name}" 未找到` };
    }

    this.write(result.join('\n'));
    return { success: true };
  }

  /**
   * 更新任务字段（name 不变）
   */
  updateTask(name: string, updates: Partial<ScheduledTask>): TaskOpResult {
    const existing = this.getTask(name);
    if (!existing) {
      return { success: false, error: `任务 "${name}" 不存在` };
    }

    // 如果要改 interval，校验格式
    if (updates.interval && !parseInterval(updates.interval)) {
      return { success: false, error: `interval "${updates.interval}" 格式无效` };
    }
    if (updates.on_failure && !['ignore', 'alert', 'retry'].includes(updates.on_failure)) {
      return { success: false, error: `on_failure 值无效，必须是 ignore/alert/retry` };
    }

    const md = this.read();
    const lines = md.split('\n');
    const result: string[] = [];
    let inTasksBlock = false;
    let inTargetTask = false;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const trimmed = line.trim();

      if (!inTasksBlock && /^(tasks:|##\s+tasks|#\s+tasks)$/i.test(trimmed)) {
        inTasksBlock = true;
        result.push(line);
        continue;
      }

      if (inTasksBlock && /^##\s/.test(trimmed)) {
        inTasksBlock = false;
        inTargetTask = false;
        result.push(line);
        continue;
      }

      if (inTasksBlock && !inTargetTask) {
        const nameMatch = trimmed.match(/^-\s+name:\s*(.+?)\s*$/);
        if (nameMatch && nameMatch[1].trim() === name) {
          inTargetTask = true;
          result.push(line);
          continue;
        }
        result.push(line);
        continue;
      }

      // 正在处理目标任务，替换对应的行
      if (inTargetTask) {
        // 遇到非缩进行，目标任务结束
        if (line === '' || (!line.startsWith('  ') && !line.startsWith('\t'))) {
          inTargetTask = false;
          result.push(line);
          continue;
        }

        // 检查是否匹配要更新的字段
        let replaced = false;
        const fieldMap: Array<[string, (line: string) => string | null]> = [
          ['type', l => { const m = l.trim().match(/^type:\s*(.+)/); return m && updates.type ? `  type: ${updates.type}` : null; }],
          ['interval', l => { const m = l.trim().match(/^interval:\s*(.+)/); return m && updates.interval ? `  interval: ${updates.interval}` : null; }],
          ['prompt', l => { const m = l.trim().match(/^prompt:\s*["']?(.+?)["']?\s*$/); return m && updates.prompt ? `  prompt: '${updates.prompt}'` : null; }],
          ['at', l => { const m = l.trim().match(/^at:\s*(.+)/); return m && updates.at ? `  at: '${updates.at}'` : null; }],
          ['after', l => { const m = l.trim().match(/^after:\s*(.+)/); return m && updates.after ? `  after: '${updates.after}'` : null; }],
          ['on', l => { const m = l.trim().match(/^on:\s*(.+)/); return m && updates.on ? `  on: '${updates.on}'` : null; }],
          ['max_runs', l => { const m = l.trim().match(/^max_runs:\s*(.+)/); return m && updates.max_runs !== undefined ? `  max_runs: ${updates.max_runs}` : null; }],
          ['deadline', l => { const m = l.trim().match(/^deadline:\s*(.+)/); return m && updates.deadline ? `  deadline: '${updates.deadline}'` : null; }],
          ['on_failure', l => { const m = l.trim().match(/^on_failure:\s*(.+)/); return m && updates.on_failure ? `  on_failure: ${updates.on_failure}` : null; }],
          ['max_retries', l => { const m = l.trim().match(/^max_retries:\s*(.+)/); return m && updates.max_retries !== undefined ? `  max_retries: ${updates.max_retries}` : null; }],
          ['timeout', l => { const m = l.trim().match(/^timeout:\s*(.+)/); return m && updates.timeout ? `  timeout: ${updates.timeout}` : null; }],
          ['condition', l => { const m = l.trim().match(/^condition:\s*(.+)/); return m && updates.condition ? `  condition: '${updates.condition}'` : null; }],
          ['bot', l => { const m = l.trim().match(/^bot:\s*(.+)/); return m && updates.bot ? `  bot: ${updates.bot}` : null; }],
          ['on_complete', l => { const m = l.trim().match(/^on_complete:\s*(.+)/); return m && updates.on_complete ? `  on_complete: ${updates.on_complete}` : null; }],
          ['auto_stop', l => { const m = l.trim().match(/^auto_stop:\s*(.+)/); return m && updates.auto_stop ? `  auto_stop: ${updates.auto_stop}` : null; }],
          ['history_file', l => { const m = l.trim().match(/^history_file:\s*(.+)/); return m && updates.history_file ? `  history_file: ${updates.history_file}` : null; }],
          ['max_history', l => { const m = l.trim().match(/^max_history:\s*(.+)/); return m && updates.max_history ? `  max_history: ${updates.max_history}` : null; }],
        ];

        for (const [_, transformer] of fieldMap) {
          const replacement = transformer(line);
          if (replacement) {
            result.push(replacement);
            replaced = true;
            break;
          }
        }

        if (!replaced) {
          result.push(line);
        }
        continue;
      }

      result.push(line);
    }

    this.write(result.join('\n'));
    return { success: true };
  }

  // === 私有方法 ===

  private read(): string {
    if (!fs.existsSync(this.heartbeatFilePath)) {
      return '';
    }
    return fs.readFileSync(this.heartbeatFilePath, 'utf-8');
  }

  private write(content: string): void {
    const tmpPath = `${this.heartbeatFilePath}.tmp`;
    fs.writeFileSync(tmpPath, content, 'utf-8');
    fs.renameSync(tmpPath, this.heartbeatFilePath);
  }

  private taskToYaml(task: ScheduledTask): string {
    const lines: string[] = [`- name: ${task.name}`];

    const type = task.type ?? 'interval';
    if (type !== 'interval') lines.push(`  type: ${type}`);

    if (task.interval) lines.push(`  interval: ${task.interval}`);
    if (task.prompt) lines.push(`  prompt: '${task.prompt.replace(/'/g, "\\'")}'`);
    if (task.at) lines.push(`  at: '${task.at}'`);
    if (task.after) lines.push(`  after: '${task.after}'`);
    if (task.on) lines.push(`  on: '${task.on}'`);
    if (task.max_runs !== undefined) lines.push(`  max_runs: ${task.max_runs}`);
    if (task.deadline) lines.push(`  deadline: '${task.deadline}'`);
    if (task.on_failure) lines.push(`  on_failure: ${task.on_failure}`);
    if (task.max_retries !== undefined) lines.push(`  max_retries: ${task.max_retries}`);
    if (task.timeout) lines.push(`  timeout: ${task.timeout}`);
    if (task.condition) lines.push(`  condition: '${task.condition.replace(/'/g, "\\'")}'`);
    if (task.bot) lines.push(`  bot: ${task.bot}`);
    if (task.on_complete) lines.push(`  on_complete: ${task.on_complete}`);
    if (task.auto_stop) lines.push(`  auto_stop: ${task.auto_stop}`);
    if (task.history_file) lines.push(`  history_file: ${task.history_file}`);
    if (task.max_history !== undefined) lines.push(`  max_history: ${task.max_history}`);

    return lines.join('\n');
  }

  private insertTaskIntoContent(md: string, taskBlock: string): string {
    const lines = md.split('\n');
    let tasksEndIndex = -1;
    let inTasksBlock = false;

    for (let i = 0; i < lines.length; i++) {
      const trimmed = lines[i].trim();

      if (!inTasksBlock && /^(tasks:|##\s+tasks|#\s+tasks)$/i.test(trimmed)) {
        inTasksBlock = true;
        continue;
      }

      if (inTasksBlock && /^##\s/.test(trimmed)) {
        tasksEndIndex = i;
        break;
      }

      if (inTasksBlock && i === lines.length - 1) {
        tasksEndIndex = i + 1; // 文件末尾
      }
    }

    // 没找到 tasks: 块，追加到末尾
    if (tasksEndIndex === -1) {
      return md + (md.endsWith('\n') ? '' : '\n') + '\n## Tasks\n' + taskBlock + '\n';
    }

    // 插入到 tasks 块末尾
    const before = lines.slice(0, tasksEndIndex);
    const after = lines.slice(tasksEndIndex);

    // 确保 taskBlock 前有适当换行
    const insert = [taskBlock];

    return [...before, ...insert, ...after].join('\n');
  }
}
