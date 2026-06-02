// ================================================================
// HeartbeatScheduler — 心跳调度器（L1 最小可心跳）
// ================================================================
// 职责：
//   1. 按 interval 定时触发心跳
//   2. 读取 HEARTBEAT.md 生成 prompt
//   3. 通过 AgentRuntime.processMessage 发送
//   4. 使用 OutputRouter 过滤回复（拦截 HEARTBEAT_OK）
// ================================================================

import * as fs from 'fs';
import * as path from 'path';
import type { AgentRuntime, SessionManager, MessageContext, Session } from './types';
import type { AgentAdapter } from './types';
import {
  isHeartbeatContentEffectivelyEmpty,
  stripHeartbeatTasksBlock,
  parseHeartbeatTasks,
  parseInterval,
  getPhaseOffset,
  HEARTBEAT_ROUNDS_MAX,
} from './heartbeat';
import { filterAndSend, isHeartbeatOk } from './output-router';
import { SessionResolver } from './session-resolver';

export interface HeartbeatSchedulerConfig {
  /** Bot 名称 */
  botName: string;
  /** Bot ID */
  botId: string;
  /** 心跳间隔（如 "5m"） */
  interval: string;
  /** HEARTBEAT.md 文件路径 */
  heartbeatFilePath: string;
  /** 默认工作目录 */
  defaultCwd: string;
  /** 当前模型 */
  model: string;
  /** 系统 prompt */
  systemPrompt?: string;
  /** 是否发送正常指示器 */
  showOk?: boolean;
  /** 是否有内容时发送告警 */
  showAlerts?: boolean;
  /** 发送消息到 IM 的回调（由 Bot 构造时传入） */
  sendMessage: (chatId: string, text: string) => Promise<void>;
}

export interface TaskRunner {
  name: string;
  intervalMs: number;
  timer: ReturnType<typeof setTimeout> | null;
}

export class HeartbeatScheduler {
  private config: HeartbeatSchedulerConfig;
  private runtime: AgentRuntime;
  private adapter: AgentAdapter;
  private sessionManager: SessionManager;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private lastHeartbeatText: string | undefined;
  private _resolver: SessionResolver;
  /** 连续心跳失败计数（用于告警） */
  private consecutiveFailures = 0;
  /** L2: 独立运行的定时任务 */
  private taskRunners: Map<string, TaskRunner> = new Map();

  constructor(
    config: HeartbeatSchedulerConfig,
    runtime: AgentRuntime,
    adapter: AgentAdapter,
    sessionManager: SessionManager,
  ) {
    this.config = config;
    this.runtime = runtime;
    this.adapter = adapter;
    this.sessionManager = sessionManager;
    this._resolver = new SessionResolver(sessionManager, config.botId);
  }

  /** Expose SessionResolver for Bot to update lastActiveChatId */
  get resolver(): SessionResolver {
    return this._resolver;
  }

  /**
   * 启动心跳调度器
   */
  start(): void {
    const intervalMs = parseInterval(this.config.interval);
    if (!intervalMs) {
      console.error(`[Heartbeat] Invalid interval: ${this.config.interval}`);
      return;
    }

    const phaseOffset = getPhaseOffset(this.config.botName, intervalMs);
    console.log(
      `[Heartbeat] Started for ${this.config.botName} ` +
      `interval=${this.config.interval} phaseOffset=${Math.round(phaseOffset / 1000)}s`,
    );

    this.running = true;
    // 首次心跳延迟 phaseOffset，后续按 interval 循环
    this.scheduleNext(intervalMs, phaseOffset);
  }

  /**
   * 停止心跳调度器
   */
  stop(): void {
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    // L2: 停止所有定时任务
    for (const runner of this.taskRunners.values()) {
      if (runner.timer) clearTimeout(runner.timer);
    }
    this.taskRunners.clear();
    console.log(`[Heartbeat] Stopped for ${this.config.botName}`);
  }

  /**
   * L2: 刷新定时任务列表
   * 每次心跳执行时调用，同步 HEARTBEAT.md 中的 tasks 变化
   */
  private syncTasks(): void {
    try { require('fs').appendFileSync('/tmp/cron_debug.log', `[syncTasks] called at ${new Date().toISOString()}\n`); } catch {}
    const heartbeatContent = this.readHeartbeatFile();
    const tasks = parseHeartbeatTasks(heartbeatContent);
    const currentNames = new Set(this.taskRunners.keys());
    const desiredNames = new Set(tasks.map(t => t.name));

    // 移除不再存在的任务
    for (const name of currentNames) {
      if (!desiredNames.has(name)) {
        const runner = this.taskRunners.get(name)!;
        if (runner.timer) clearTimeout(runner.timer);
        this.taskRunners.delete(name);
        console.log(`[Cron] Removed task: ${name}`);
      }
    }

    // 启动新任务或更新 interval
    for (const task of tasks) {
      const intervalMs = parseInterval(task.interval);
      if (!intervalMs) {
        console.warn(`[Cron] Invalid interval for task ${task.name}: ${task.interval}`);
        continue;
      }

      const existing = this.taskRunners.get(task.name);
      if (existing && existing.intervalMs === intervalMs) {
        // 任务已存在且 interval 未变，跳过
        continue;
      }

      // 存在但 interval 变了，或全新任务
      if (existing && existing.timer) clearTimeout(existing.timer);

      const phaseOffset = getPhaseOffset(`${this.config.botName}::${task.name}`, intervalMs);
      const runner: TaskRunner = {
        name: task.name,
        intervalMs,
        timer: null,
      };
      this.taskRunners.set(task.name, runner);

      console.log(
        `[Cron] Task started: ${task.name} interval=${task.interval} phaseOffset=${Math.round(phaseOffset / 1000)}s`,
      );
      this.scheduleTask(runner, task, intervalMs, phaseOffset);
    }
  }

  /**
   * L2: 调度单个定时任务
   */
  private scheduleTask(
    runner: TaskRunner,
    task: { name: string; interval: string; prompt: string },
    intervalMs: number,
    delayMs: number,
  ): void {
    if (!this.running) return;

    // DEBUG: file log
    try { require('fs').appendFileSync('/tmp/cron_debug.log', `[scheduleTask] name=${task.name} delay=${Math.round(delayMs/1000)}s at ${new Date().toISOString()}\n`); } catch {}
    // DEBUG: also log target chatId
    const _dbgTarget = this._resolver.resolveCron(task.name);
    try { require('fs').appendFileSync('/tmp/cron_debug.log', `[scheduleTask target] chatId=${_dbgTarget.chatId} sessionKey=${_dbgTarget.sessionKey} at ${new Date().toISOString()}\n`); } catch {}

    runner.timer = setTimeout(async () => {
      try {
        try { require('fs').appendFileSync('/tmp/cron_debug.log', `[runTask FIRED] name=${task.name} at ${new Date().toISOString()}\n`); } catch {}
        await this.runTask(task);
      } catch (e: any) {
        try { require('fs').appendFileSync('/tmp/cron_debug.log', `[runTask ERROR] name=${task.name} err=${e.message}\n`); } catch {}
        console.error(`[Cron] Error for task ${task.name}:`, e.message);
      }
      // 循环执行
      this.scheduleTask(runner, task, intervalMs, intervalMs);
    }, delayMs);
  }

  /**
   * L2: 执行单个定时任务
   */
  private async runTask(task: { name: string; interval: string; prompt: string }): Promise<void> {
    const target = this._resolver.resolveCron(task.name);
    const session = await this._resolver.getOrCreateSession(target);

    const ctx: MessageContext = {
      chatId: target.chatId,
      text: task.prompt,
      userId: 'system', // P1-4: 避免空字符串触发校验
      workingDir: this.config.defaultCwd,
      model: this.config.model,
      systemPrompt: this.config.systemPrompt,
      reply: async (text: string) => {
        // 任务回复也经过 OutputRouter 过滤
        const result = filterAndSend(text, {
          sessionType: target.sessionType,
          lastHeartbeatText: undefined, // 任务不跟踪 lastHeartbeatText
          reply: async (filteredText: string) => {
            console.log(`[Cron] Task ${task.name} → IM: ${filteredText.slice(0, 200)}`);
            await this.sendToIM(filteredText, target.chatId);
          },
        });
        if (!result.shouldSend) {
          console.log(`[Cron] Task ${task.name} reply filtered (${result.reason})`);
        }
      },
      sendProgress: async (text: string) => {
        console.log(`[Cron] Task ${task.name} progress: ${text}`);
      },
    };

    console.log(`[Cron] Running task: ${task.name} prompt=${task.prompt.slice(0, 80)}`);
    await this.runtime.processMessage(ctx, this.adapter, this.config.botName);
    this.sessionManager.persist(this.config.botId, session);
  }

  /**
   * 调度下一次心跳
   */
  private scheduleNext(intervalMs: number, delayMs: number): void {
    if (!this.running) return;

    this.timer = setTimeout(async () => {
      try {
        await this.runHeartbeat();
      } catch (e: any) {
        console.error(`[Heartbeat] Error for ${this.config.botName}:`, e.message);
      }
      // 下一次按固定 interval
      this.scheduleNext(intervalMs, intervalMs);
    }, delayMs);
  }

  /**
   * 执行一次心跳
   */
  private async runHeartbeat(): Promise<void> {
    // 1. 读取 HEARTBEAT.md
    const heartbeatContent = this.readHeartbeatFile();

    // 2. 判断内容是否为空（即使为空也同步定时任务，P1-1）
    if (isHeartbeatContentEffectivelyEmpty(heartbeatContent)) {
      console.log(`[Heartbeat] ${this.config.botName}: HEARTBEAT.md is empty, syncing tasks then skipping`);
      this.syncTasks();
      return;
    }

    // L2: 同步定时任务列表（每次心跳都检查是否有新任务/修改）
    this.syncTasks();

    // 3. 提取非 tasks 部分作为 prompt
    const prompt = stripHeartbeatTasksBlock(heartbeatContent);
    if (!prompt || prompt.trim().length === 0) {
      console.log(`[Heartbeat] ${this.config.botName}: no heartbeat prompt (only tasks), skipping`);
      return;
    }

    // 4. 解析 session 目标
    const target = this._resolver.resolveHeartbeat();
    const session = await this._resolver.getOrCreateSession(target);

    // P0-2: 心跳轮次硬截断 — 截断到最近 N 轮
    if (session.heartbeatRounds && session.heartbeatRounds.length >= HEARTBEAT_ROUNDS_MAX) {
      session.heartbeatRounds = session.heartbeatRounds.slice(-HEARTBEAT_ROUNDS_MAX);
      console.log(`[Heartbeat] ${this.config.botName}: truncated heartbeat rounds to ${HEARTBEAT_ROUNDS_MAX}`);
    }

    // 5. 构建 MessageContext
    const ctx: MessageContext = {
      chatId: target.chatId,
      text: prompt,
      userId: 'system', // P1-4: 避免空字符串触发校验
      workingDir: this.config.defaultCwd,
      model: this.config.model,
      systemPrompt: this.config.systemPrompt,
      reply: async (text: string) => {
        // 通过 OutputRouter 过滤
        const result = filterAndSend(text, {
          sessionType: target.sessionType,
          lastHeartbeatText: this.lastHeartbeatText,
          reply: async (filteredText: string) => {
            // 实际发送到 IM
            await this.sendToIM(filteredText, target.chatId);
            console.log(`[Heartbeat] ${this.config.botName} → IM sent (${filteredText.length} chars)`);

            // P0-2: 记录本轮心跳
            const round = {
              timestamp: Date.now(),
              prompt: prompt.slice(0, 500),
              response: text.slice(0, 500),
              tokensUsed: 0, // 后续可从 stats 中获取
            };
            if (!session.heartbeatRounds) session.heartbeatRounds = [];
            session.heartbeatRounds.push(round);

            // 立即截断，防止内存泄漏
            if (session.heartbeatRounds.length > HEARTBEAT_ROUNDS_MAX) {
              session.heartbeatRounds = session.heartbeatRounds.slice(-HEARTBEAT_ROUNDS_MAX);
            }
          },
        });
        if (result.shouldSend) {
          this.lastHeartbeatText = text;
          this.consecutiveFailures = 0; // 成功，重置失败计数
        } else if (result.reason === 'heartbeat_ok_filtered') {
          console.log(`[Heartbeat] ${this.config.botName}: HEARTBEAT_OK filtered`);
          this.consecutiveFailures = 0; // HEARTBEAT_OK 也算成功
        } else if (result.reason === 'duplicate_filtered') {
          console.log(`[Heartbeat] ${this.config.botName}: duplicate heartbeat filtered`);
          this.consecutiveFailures = 0;
        }
      },
      sendProgress: async (text: string) => {
        console.log(`[Heartbeat] ${this.config.botName} progress: ${text}`);
      },
    };

    // 6. 通过 AgentRuntime 发送
    console.log(`[Heartbeat] ${this.config.botName}: running heartbeat`);
    try {
      await this.runtime.processMessage(ctx, this.adapter, this.config.botName);
      // 7. 持久化 session
      this.sessionManager.persist(this.config.botId, session);
      console.log(`[Heartbeat] ${this.config.botName}: heartbeat completed`);
    } catch (e: any) {
      this.consecutiveFailures++;
      console.error(`[Heartbeat] Error for ${this.config.botName}:`, e.message);
      console.log(`[Heartbeat] ${this.config.botName}: consecutiveFailures=${this.consecutiveFailures}`);

      // P0-3: 连续失败告警
      if (this.consecutiveFailures >= 3 && this.config.showAlerts) {
        const alertMsg = `⚠️ 心跳连续失败 ${this.consecutiveFailures} 次，请检查配置和连接。`;
        console.log(`[Heartbeat] ALERT: ${alertMsg}`);
        await this.sendToIM(alertMsg, target.chatId).catch(err => {
          console.error(`[Heartbeat] Failed to send alert:`, err.message);
        });
      }
    }
  }

  /**
   * 读取 HEARTBEAT.md 文件内容
   */
  private readHeartbeatFile(): string {
    try {
      if (fs.existsSync(this.config.heartbeatFilePath)) {
        return fs.readFileSync(this.config.heartbeatFilePath, 'utf-8');
      }
    } catch (e: any) {
      console.error(`[Heartbeat] Failed to read HEARTBEAT.md:`, e.message);
    }
    return '';
  }

  /**
   * 发送到 IM（L1 简化版：直接通过 adapter 的 IM 模块）
   */
  private async sendToIM(text: string, chatId: string): Promise<void> {
    await this.config.sendMessage(chatId, text);
  }
}
