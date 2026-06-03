// ================================================================
// HeartbeatScheduler — 心跳 + 定时任务调度器（Phase 1 重构）
// ================================================================
// 职责：
//   1. 按 interval 定时触发心跳
//   2. 读取 HEARTBEAT.md 生成 prompt
//   3. 通过 AgentRuntime.processMessage 发送
//   4. 使用 OutputRouter 过滤回复（拦截 HEARTBEAT_OK）
//   5. TaskPoller 统一管理所有定时任务（Phase 1）
// ================================================================

import * as fs from 'fs';
import * as path from 'path';
import type { AgentRuntime, SessionManager, MessageContext, Session, ScheduledTask, TaskRunState } from './types';
import type { AgentAdapter } from './types';
import {
  isHeartbeatContentEffectivelyEmpty,
  stripHeartbeatTasksBlock,
  parseHeartbeatTasks,
  parseInterval,
  getPhaseOffset,
  HEARTBEAT_ROUNDS_MAX,
  removeTaskFromHeartbeatFile,
  updateTaskRunState,
  getTaskRunState,
} from './heartbeat';
import { filterAndSend, isHeartbeatOk } from './output-router';
import { SessionResolver } from './session-resolver';
import { TaskPoller } from './task-poller';

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
  /** 任务级默认值（v3，从 HEARTBEAT.md defaults: 块或 BotConfig 读取） */
  defaults?: {
    on_failure?: 'ignore' | 'alert' | 'retry';
    max_retries?: number;
    timeout?: string;
  };
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
  /** Phase 1: 统一任务轮询器 */
  private taskPoller: TaskPoller;
  /** Phase 1: 当前心跳 session（供 TaskPoller 读写状态） */
  private heartbeatSession: Session | undefined;

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

    this.taskPoller = new TaskPoller({
      tickMs: 1000,
      onTaskFire: (task, session) => this.runTask(task, session),
      onTaskComplete: (task, _session) => {
        // once/countdown 任务完成后，自动从 HEARTBEAT.md 中删除
        removeTaskFromHeartbeatFile(this.config.heartbeatFilePath, task.name);
      },
      lockTimeoutMs: 120_000, // 默认 2 分钟锁超时
      onTaskTimeout: (task, session) => {
        // 锁超时：按 on_failure 策略处理
        const strategy = task.on_failure ?? this.config.defaults?.on_failure ?? 'ignore';
        console.warn(`[Cron] Task ${task.name} lock timed out, strategy=${strategy}`);
        if (strategy === 'alert') {
          this.sendAlert(task, 'Lock timeout after 120s', session).catch(() => {});
        }
      },
      getSession: () => this.heartbeatSession,
    });
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
    // 启动任务轮询器
    this.taskPoller.start();
    // 首次心跳延迟 phaseOffset，后续按 interval 循环
    this.scheduleNext(intervalMs, phaseOffset);
  }

  /**
   * 停止心跳调度器
   */
  async stop(): Promise<void> {
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    await this.taskPoller.stop();
    console.log(`[Heartbeat] Stopped for ${this.config.botName}`);
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

    // 2. 判断内容是否为空（即使为空也同步定时任务）
    if (isHeartbeatContentEffectivelyEmpty(heartbeatContent)) {
      console.log(`[Heartbeat] ${this.config.botName}: HEARTBEAT.md is empty, syncing tasks then skipping`);
      this.syncTasks(heartbeatContent);
      return;
    }

    // Phase 1: 同步定时任务到 TaskPoller
    this.syncTasks(heartbeatContent);

    // 3. 提取非 tasks 部分作为 prompt
    const prompt = stripHeartbeatTasksBlock(heartbeatContent);
    if (!prompt || prompt.trim().length === 0) {
      console.log(`[Heartbeat] ${this.config.botName}: no heartbeat prompt (only tasks), skipping`);
      return;
    }

    // 4. 解析 session 目标
    const target = this._resolver.resolveHeartbeat();
    const session = await this._resolver.getOrCreateSession(target);

    // 记录心跳 session 供 TaskPoller 使用
    this.heartbeatSession = session;

    // P0-2: 心跳轮次硬截断
    if (session.heartbeatRounds && session.heartbeatRounds.length >= HEARTBEAT_ROUNDS_MAX) {
      session.heartbeatRounds = session.heartbeatRounds.slice(-HEARTBEAT_ROUNDS_MAX);
      console.log(`[Heartbeat] ${this.config.botName}: truncated heartbeat rounds to ${HEARTBEAT_ROUNDS_MAX}`);
    }

    // 5. 构建 MessageContext
    const ctx: MessageContext = {
      chatId: target.chatId,
      text: prompt,
      userId: 'system',
      workingDir: this.config.defaultCwd,
      model: this.config.model,
      systemPrompt: this.config.systemPrompt,
      reply: async (text: string) => {
        const result = filterAndSend(text, {
          sessionType: target.sessionType,
          lastHeartbeatText: this.lastHeartbeatText,
          reply: async (filteredText: string) => {
            await this.sendToIM(filteredText, target.chatId);
            console.log(`[Heartbeat] ${this.config.botName} → IM sent (${filteredText.length} chars)`);

            const round = {
              timestamp: Date.now(),
              prompt: prompt.slice(0, 500),
              response: text.slice(0, 500),
              tokensUsed: 0,
            };
            if (!session.heartbeatRounds) session.heartbeatRounds = [];
            session.heartbeatRounds.push(round);

            if (session.heartbeatRounds.length > HEARTBEAT_ROUNDS_MAX) {
              session.heartbeatRounds = session.heartbeatRounds.slice(-HEARTBEAT_ROUNDS_MAX);
            }
          },
        });
        if (result.shouldSend) {
          this.lastHeartbeatText = text;
          this.consecutiveFailures = 0;
        } else if (result.reason === 'heartbeat_ok_filtered') {
          console.log(`[Heartbeat] ${this.config.botName}: HEARTBEAT_OK filtered`);
          this.consecutiveFailures = 0;
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
   * 同步任务到 TaskPoller
   */
  private syncTasks(heartbeatContent: string): void {
    this.taskPoller.syncTasks(heartbeatContent);
  }

  /**
   * Phase 1/2: 执行单个定时任务（由 TaskPoller 回调触发）
   * 包含超时检测 + 失败策略（ignore/alert/retry）
   */
  private async runTask(task: ScheduledTask, session: Session): Promise<void> {
    const timeoutMs = this.parseTimeout(task.timeout ?? this.config.defaults?.timeout ?? '60s');
    const maxRetries = task.max_retries ?? this.config.defaults?.max_retries ?? 3;
    const strategy = task.on_failure ?? this.config.defaults?.on_failure ?? 'ignore';

    let attempt = 0;
    let lastError: string = '';

    while (attempt <= maxRetries) {
      attempt++;

      // 重试退避：1s → 2s → 4s → ...
      if (attempt > 1) {
        const backoffMs = Math.pow(2, attempt - 2) * 1000;
        console.log(`[Cron] Task ${task.name} retry attempt ${attempt}/${maxRetries}, waiting ${backoffMs}ms`);
        await this.sleep(backoffMs);
      }

      try {
        await this.executeTaskWithTimeout(task, session, timeoutMs);
        // 成功
        if (attempt > 1) {
          console.log(`[Cron] Task ${task.name} succeeded on attempt ${attempt}`);
        }
        return;
      } catch (e: any) {
        lastError = e.message || String(e);
        console.error(`[Cron] Task ${task.name} attempt ${attempt} failed: ${lastError}`);

        if (attempt > maxRetries) {
          // 所有重试耗尽
          console.error(`[Cron] Task ${task.name} all ${maxRetries} retries exhausted`);
          if (strategy === 'alert') {
            await this.sendAlert(task, lastError, session).catch(() => {});
          }
          return;
        }
        // on_failure=ignore 时不再重试
        if (strategy === 'ignore') {
          console.log(`[Cron] Task ${task.name} failed, strategy=ignore, skipping`);
          return;
        }
        // on_failure=alert 时，第一次失败就告警，不重试
        if (strategy === 'alert') {
          console.log(`[Cron] Task ${task.name} failed, strategy=alert, sending alert`);
          await this.sendAlert(task, lastError, session).catch(() => {});
          return;
        }
        // on_failure=retry 时继续循环
      }
    }
  }

  /**
   * 执行任务，带超时包装
   */
  private async executeTaskWithTimeout(task: ScheduledTask, session: Session, timeoutMs: number): Promise<void> {
    const target = this._resolver.resolveCron(task.name);
    const taskSession = await this._resolver.getOrCreateSession(target);

    const timeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`Task timeout after ${task.timeout ?? this.config.defaults?.timeout ?? '60s'}`)), timeoutMs)
    );

    const ctx: MessageContext = {
      chatId: target.chatId,
      text: task.prompt,
      userId: 'system',
      workingDir: this.config.defaultCwd,
      model: this.config.model,
      systemPrompt: this.config.systemPrompt,
      reply: async (text: string) => {
        const result = filterAndSend(text, {
          sessionType: target.sessionType,
          lastHeartbeatText: undefined,
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

    console.log(`[Cron] Running task: ${task.name} prompt=${task.prompt.slice(0, 80)} timeout=${task.timeout ?? this.config.defaults?.timeout ?? '60s'}`);
    await Promise.race([this.runtime.processMessage(ctx, this.adapter, this.config.botName), timeoutPromise]);
    this.sessionManager.persist(this.config.botId, taskSession);
  }

  /**
   * 发送任务失败告警
   */
  private async sendAlert(task: ScheduledTask, lastError: string, session: Session): Promise<void> {
    const runState = session.heartbeatTaskState?.[task.name];
    const state = runState ? getTaskRunState(runState) : { runCount: 0 };

    const taskType = task.type ?? 'interval';
    const maxRetries = task.max_retries ?? this.config.defaults?.max_retries ?? 3;

    const alertMsg = [
      '⚠️ 定时任务失败',
      `任务: ${task.name}`,
      `类型: ${taskType}${task.interval ? ` (${task.interval})` : ''}`,
      `失败次数: ${maxRetries}/${maxRetries}`,
      `最后错误: ${lastError}`,
      `时间: ${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`,
    ].join('\n');

    console.warn(`[Cron] ALERT: ${alertMsg.replace(/\n/g, ' | ')}`);

    // 发送到 IM（尝试获取最后活跃的 chatId）
    try {
      const target = this._resolver.resolveHeartbeat();
      if (target?.chatId) {
        await this.sendToIM(alertMsg, target.chatId);
      }
    } catch (e: any) {
      console.error(`[Cron] Failed to send alert:`, e.message);
    }
  }

  /**
   * 解析超时时间
   */
  private parseTimeout(timeout: string): number {
    const ms = parseInterval(timeout);
    return ms ?? 60_000; // 默认 60 秒
  }

  /**
   * 延迟（用于重试退避）
   */
  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
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
   * 发送到 IM
   */
  private async sendToIM(text: string, chatId: string): Promise<void> {
    await this.config.sendMessage(chatId, text);
  }
}
