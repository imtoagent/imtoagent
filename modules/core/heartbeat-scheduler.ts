// ================================================================
// HeartbeatScheduler — 心跳 + 定时任务调度器（Phase 1 重构）
// ================================================================
// 职责：
//   1. 按 interval 定时触发 tick
//   2. tick 时触发 GoalEngine.processDueGoals()
//   3. HEARTBEAT.md 变更时同步 tasks 到 TaskPoller
//   4. 精确触发（precise triggers）优化
//
// 重构后：心跳不再调 Agent，不再读取 prompt，不再过滤回复。
// Task/Goal 到期时各自调 Agent 执行。
// ================================================================

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import type { AgentRuntime, SessionManager, MessageContext, Session, ScheduledTask, AgentInput } from './types';
import type { AgentAdapter } from './types';
import { parseInterval, getPhaseOffset, removeTaskFromHeartbeatFile } from './heartbeat';
import { formatShanghaiTimeShort } from './timezone';
import { SessionResolver } from './session-resolver';
import { TaskPoller } from './task-poller';
import { GoalEngine } from './goal-engine';
import { GoalStore } from './goal-store';
import { GoalManager } from './goal-manager';
import { ToolRegistry } from '../agent/tool-registry';
import { discoverTools, type ToolLoadContext } from './tool-discovery';
import { weatherTool } from '../tools/weather';
import { createGoalTools } from '../tools/goal-task-tools';
import { createTaskTools } from '../tools/task-tools';
import { TaskManager } from './task-manager';
import { TaskLogger } from './task-logger';
import { AgentLoop } from '../agent/agent-loop';

/** Cron/heartbeat session 会话轮次上限，超过后自动新建 thread 防止上下文爆炸 */
const MAX_CRON_ROUNDS = 10;

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
  /** 发送消息到 IM 的回调（由 Bot 构造时传入） */
  sendMessage: (chatId: string, text: string) => Promise<void>;
  /** 任务级默认值（从 HEARTBEAT.md defaults: 块或 BotConfig 读取） */
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
  /** AgentLoop 包装 — 为定时任务/Goal 执行提供本地工具循环 */
  private agentLoop: AgentLoop;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private _resolver: SessionResolver;
  /** Phase 1: 统一任务轮询器 */
  private taskPoller: TaskPoller;
  /** Phase 1 Goal Engine: 到期检测 + Agent 执行 + IM 发送 */
  private goalEngine: GoalEngine;
  private goalStore: GoalStore;
  /** Phase 2: Goal 管理协议 */
  private goalManager: GoalManager;
  /** Phase 2: 工具注册中心 */
  private toolRegistry: ToolRegistry;
  /** Phase 1 精确触发：setTimeout 精确触发 + 心跳兜底 */
  private preciseTimers: Map<string, NodeJS.Timeout> = new Map();
  private readonly PRECISE_WINDOW_MS = 30 * 60 * 1000; // 30 分钟内注册 setTimeout

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

    // 构造 AgentLoop（adapter 级工具支持）
    const toolSupport = (adapter as any).getToolSupport?.() ?? null;
    this.agentLoop = new AgentLoop(adapter, this.toolRegistry, toolSupport);

    this.taskPoller = new TaskPoller({
      tickMs: 1000,
      onTaskFire: async (task) => this.runTask(task),
      onTaskComplete: (task) => {
        // once/countdown 任务完成后，自动从 HEARTBEAT.md 中删除
        removeTaskFromHeartbeatFile(this.config.heartbeatFilePath, task.name);
      },
      // P1-2: 任务错误回调，不再静默失败
      onTaskError: (task, error) => {
        console.error(`[Cron] Task ${task.name} error:`, error.message);
        const strategy = task.on_failure ?? this.config.defaults?.on_failure ?? 'ignore';
        if (strategy === 'alert') {
          this.sendAlert(task, error.message).catch(() => {});
        }
      },
      lockTimeoutMs: 120_000, // 默认 2 分钟锁超时
      onTaskTimeout: (task) => {
        // 锁超时：按 on_failure 策略处理
        const strategy = task.on_failure ?? this.config.defaults?.on_failure ?? 'ignore';
        console.warn(`[Cron] Task ${task.name} lock timed out, strategy=${strategy}`);
        if (strategy === 'alert') {
          this.sendAlert(task, 'Lock timeout after 120s').catch(() => {});
        }
      },
      workspaceDir: this.config.defaultCwd, // P4-4: 历史文件路径基准
    });

    // Phase 1: 初始化 Goal Engine
    this.goalStore = new GoalStore();
    // Phase 2: 初始化工具注册中心
    this.toolRegistry = new ToolRegistry();
    // Phase 2: 初始化 Goal 管理协议
    this.goalManager = new GoalManager(this.goalStore);
    // Phase 3: 初始化 Task 管理器
    const heartbeatPath = path.join(
      this.config.workspaceDir || path.join(os.homedir(), '.imtoagent', 'workspaces', this.config.botId || 'default'),
      'HEARTBEAT.md',
    );
    this.taskManager = new TaskManager(heartbeatPath);

    // Phase 4: 自动发现并注册工具
    this.autoRegisterTools();

    // 向后兼容：手动注册内置工具（autoRegisterTools 会覆盖同名的）
    this.toolRegistry.register(weatherTool);
    const taskTools = createTaskTools(this.taskManager);
    const goalTools = createGoalTools(this.goalManager, this.goalStore, () => this._resolver.getLastActiveChatId());
    this.toolRegistry.register(...taskTools, ...goalTools);

    // 显式注入所有工具到当前 session
    this.toolRegistry.injectNeeded(this.toolRegistry.list());
    this.goalEngine = new GoalEngine(this.goalStore, {
      executeAgent: async (prompt, options) => {
        return this.executeGoalAgent(prompt, options);
      },
      sendIM: async (chatId, text) => {
        await this.config.sendMessage(chatId, text);
      },
      resolveChatId: () => this._resolver.getLastActiveChatId(),
      workspaceDir: this.config.defaultCwd,
      timeoutMs: this.config.defaults?.timeout
        ? this.parseTimeout(this.config.defaults.timeout)
        : 60_000,
      toolRegistry: this.toolRegistry,
    });
  }

  /** Expose SessionResolver for Bot to update lastActiveChatId */
  get resolver(): SessionResolver {
    return this._resolver;
  }

  /** P2-4: 暴露任务状态查询 */
  getTaskStatus() {
    return this.taskPoller.getTaskStatus();
  }

  /** Phase 2: 暴露 Goal 管理器（供外部调用） */
  getGoalManager() {
    return this.goalManager;
  }

  /** Phase 2: 暴露工具注册中心 */
  getToolRegistry() {
    return this.toolRegistry;
  }

  /**
   * Phase 4: 自动发现并注册工具
   *
   * 扫描规则：
   * 1. 用户工具目录 ~/.imtoagent/tools/
   * 2. 内置工具目录 modules/tools/
   * 同名工具用户版本覆盖内置版本
   *
   * 依赖注入：taskManager, goalManager, goalStore, resolveChatId
   */
  private autoRegisterTools(): void {
    const dataDir = path.join(os.homedir(), '.imtoagent');
    const userToolsDir = path.join(dataDir, 'tools');
    // 内置工具目录（相对于模块路径）
    const builtInToolsDir = path.join(__dirname, '..', 'tools');

    // 构建依赖注入上下文
    const context: ToolLoadContext = {
      deps: {
        taskManager: this.taskManager,
        goalManager: this.goalManager,
        goalStore: this.goalStore,
        resolveChatId: () => this._resolver.getLastActiveChatId(),
      },
    };

    // 扫描：先内置，后用户（用户覆盖内置）
    discoverTools([builtInToolsDir, userToolsDir], context)
      .then(discovered => {
        for (const tool of discovered) {
          this.toolRegistry.register(tool.definition);
          console.log(
            `[ToolDiscovery] Registered: ${tool.name} (${tool.sourceType}) ` +
            `[${tool.sourceFile.replace(dataDir, '~/.imtoagent')}]`,
          );
        }
        console.log(`[ToolDiscovery] Total discovered: ${discovered.length}`);
      })
      .catch(err => {
        console.error(`[ToolDiscovery] Discovery failed: ${(err as Error).message}`);
      });
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
    // 启动任务轮询器（独立 1s tick）
    this.taskPoller.start();
    // 启动时同步一次 tasks
    this.syncTasks();
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
    // Phase 1: 取消所有精确触发
    this.cancelAllPreciseTriggers();
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
   * 执行一次心跳（Phase 1 重构：纯定时器，不调 Agent）
   */
  private async runHeartbeat(): Promise<void> {
    // 1. 同步 HEARTBEAT.md 任务（文件变更驱动，心跳作为兜底定期检查）
    this.syncTasks();

    // 2. Goal 系统：清理过期 + 重新加载 + 检查并执行到期 Goal
    try {
      const cleaned = this.goalStore.cleanup(); // 清理过期/已完成的 Goal
      if (cleaned > 0) {
        console.log(`[Heartbeat] ${this.config.botName}: cleaned up ${cleaned} expired goal(s)`);
      }
      this.goalStore.reload(); // P3: 每次 tick 前同步文件变更
      const now = new Date();
      const goalStats = await this.goalEngine.processDueGoals(now);
      if (goalStats.dueCount > 0) {
        console.log(
          `[Heartbeat] ${this.config.botName}: Goal Engine done=${goalStats.doneCount} ` +
          `skip=${goalStats.skipCount} fail=${goalStats.failedCount} unknown=${goalStats.unknownCount}` +
          ` (${goalStats.totalDurationMs}ms)`,
        );
      } else {
        console.log(`[Heartbeat] ${this.config.botName}: Goal Engine 0 due, ${goalStats.totalDurationMs}ms`);
      }

      // 精确触发：为 30 分钟内的活跃 Goal 注册 setTimeout
      this.schedulePreciseTriggers();
    } catch (e: any) {
      console.error(`[Heartbeat] ${this.config.botName}: Goal Engine error:`, e.message);
    }
  }

  /**
   * 同步 HEARTBEAT.md 任务到 TaskPoller
   */
  private syncTasks(): void {
    try {
      const content = this.readHeartbeatFile();
      if (content) {
        this.taskPoller.syncTasks(content, this.config.botName);
        // 治本：检查解析错误并告警
        const parseErrors = this.taskPoller.getLastParseErrors();
        if (parseErrors.length > 0) {
          const errorMsg = parseErrors.map(e => `• ${e.reason}`).join('\n');
          console.error(`[Heartbeat] ${this.config.botName}: HEARTBEAT.md 解析失败 (${parseErrors.length} 个任务被丢弃):\n${errorMsg}`);
        }
      }
    } catch (e: any) {
      console.error(`[Heartbeat] Failed to sync tasks:`, e.message);
    }
  }

  /**
   * 构建 AgentInput，从 MessageContext 转换
   */
  private _buildAgentInput(ctx: MessageContext, session: Session): AgentInput {
    return {
      chatId: ctx.chatId,
      text: ctx.text,
      attachments: ctx.attachments,
      session,
      workingDir: ctx.workingDir,
      systemPrompt: ctx.systemPrompt,
      model: ctx.model,
      cancelSignal: ctx.cancelSignal,
      sendProgress: ctx.sendProgress,
    };
  }

  /**
   * Phase 1 精确触发：为 30 分钟内的活跃 Goal 注册 setTimeout
   * 心跳作为兜底：即使 setTimeout 丢失（进程重启），心跳也会检查 getDue() 并执行
   */
  private schedulePreciseTriggers(): void {
    const now = new Date();
    const cutoff = new Date(now.getTime() + this.PRECISE_WINDOW_MS);
    const activeGoals = this.goalStore.getActive();

    for (const goal of activeGoals) {
      if (!goal.lifecycle.nextRunAt) continue;
      const nextRun = new Date(goal.lifecycle.nextRunAt);

      // 跳过已过期的
      if (nextRun <= now) continue;
      // 只注册 30 分钟内的
      if (nextRun > cutoff) continue;
      // 已经注册过的跳过
      if (this.preciseTimers.has(goal.id)) continue;

      const delayMs = nextRun.getTime() - now.getTime();
      const scheduledTime = nextRun.getTime();
      const leadMinutes = goal.trigger.leadMinutes ?? 10;

      console.log(
        `[GoalEngine] Scheduling precise trigger for ${goal.id} ` +
        `in ${Math.round(delayMs / 1000)}s (at ${formatShanghaiTimeShort(nextRun.getTime())})`,
      );

      const timer = setTimeout(() => {
        // macOS 休眠处理：如果过期超过 leadMinutes，跳过，等心跳兜底
        if (Date.now() > scheduledTime + leadMinutes * 60 * 1000) {
          console.log(
            `[GoalEngine] Precise trigger for ${goal.id} expired (macOS sleep?), ` +
            `skipping, heartbeat will handle`,
          );
          this.preciseTimers.delete(goal.id);
          return;
        }

        console.log(`[GoalEngine] Precise trigger firing for ${goal.id}`);
        this.goalEngine.processDueGoals(now).catch(e => {
          console.error(`[GoalEngine] Precise trigger error for ${goal.id}:`, e.message);
        }).finally(() => {
          this.preciseTimers.delete(goal.id);
        });
      }, delayMs);

      this.preciseTimers.set(goal.id, timer);
    }
  }

  /**
   * 取消指定 Goal 的精确触发
   */
  cancelPreciseTrigger(goalId: string): void {
    const timer = this.preciseTimers.get(goalId);
    if (timer) {
      clearTimeout(timer);
      this.preciseTimers.delete(goalId);
    }
  }

  /**
   * 取消所有精确触发
   */
  private cancelAllPreciseTriggers(): void {
    for (const [, timer] of this.preciseTimers) {
      clearTimeout(timer);
    }
    this.preciseTimers.clear();
  }

  /**
   * Phase 1 Goal Engine: 用 Agent 执行 Goal prompt
   * 走 AgentLoop 包装路径，支持本地工具循环
   */
  private async executeGoalAgent(
    prompt: string,
    options?: { systemPrompt?: string; model?: string; timeoutMs?: number; tools?: object[]; cancelSignal?: AbortSignal },
  ): Promise<string> {
    const target = this._resolver.resolveHeartbeat();
    const session = await this._resolver.getOrCreateSession(target);

    // 每次 Goal 执行都使用全新上下文，防止跨 Goal 上下文膨胀
    session.startFresh = true;

    let reply = '';
    const ctx: MessageContext = {
      chatId: target.chatId,
      text: prompt,
      userId: 'system',
      workingDir: this.config.defaultCwd,
      model: options?.model ?? this.config.model,
      systemPrompt: options?.systemPrompt ?? this.config.systemPrompt,
      cancelSignal: options?.cancelSignal,
      reply: async (text: string) => {
        reply = text;
      },
      sendProgress: async (text: string) => {
        console.log(`[GoalEngine] progress: ${text}`);
      },
      // Phase 2: 传递工具列表
      tools: options?.tools,
    };

    try {
      // 走 AgentLoop：adapter 带本地工具循环
      const input = this._buildAgentInput(ctx, session);
      // 通过 runtime 共享队列入队，防止与用户消息竞争同一 chatId
      const chatId = target.chatId;
      const output = await this.runtime.enqueueForTask(chatId, async () => {
        return this.agentLoop.execute(input);
      });
      if (output.error) throw new Error(output.error);
      reply = output.text || '✅ Goal completed';
      this.sessionManager.persist(this.config.botId, session);
    } catch (e: any) {
      throw new Error(`Goal agent execution failed: ${e.message}`);
    }

    return reply;
  }

  /**
   * Phase 1/2: 执行单个定时任务（由 TaskPoller 回调触发）
   * 包含超时检测 + 失败策略（ignore/alert/retry）
   */
  private async runTask(task: ScheduledTask): Promise<void> {
    const timeoutMs = this.parseTimeout(task.timeout ?? this.config.defaults?.timeout ?? '60s');
    const maxRetries = task.max_retries ?? this.config.defaults?.max_retries ?? 3;
    const strategy = task.on_failure ?? this.config.defaults?.on_failure ?? 'ignore';

    let attempt = 0;
    let lastError = '';

    while (attempt <= maxRetries) {
      attempt++;

      // 重试退避：1s → 2s → 4s → ...
      if (attempt > 1) {
        const backoffMs = Math.pow(2, attempt - 2) * 1000;
        console.log(`[Cron] Task ${task.name} retry attempt ${attempt}/${maxRetries}, waiting ${backoffMs}ms`);
        TaskLogger.log({
          event: 'task.retry',
          taskName: task.name,
          taskType: task.type,
          attempt,
          maxRetries,
          backoffMs,
          error: lastError,
        });
        await this.sleep(backoffMs);
      }

      try {
        await this.executeTaskWithTimeout(task, timeoutMs);
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
            await this.sendAlert(task, lastError).catch(() => {});
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
          await this.sendAlert(task, lastError).catch(() => {});
          return;
        }
        // on_failure=retry 时继续循环
      }
    }
  }

  /**
   * 执行任务，带超时包装
   */
  private async executeTaskWithTimeout(task: ScheduledTask, timeoutMs: number): Promise<'success' | 'timeout'> {
    const target = this._resolver.resolveCron(task.name);
    const taskSession = await this._resolver.getOrCreateSession(target);
    // 获取真实 IM chatId 用于告警和回复投递
    const deliveryChatId = this._resolver.getLastActiveChatId();

    // 上下文爆炸防护：cron session 超过 MAX_CRON_ROUNDS 后自动新建 thread
    const sessionAny = taskSession as Record<string, unknown>;
    const cronRounds = (sessionAny._cronRounds as number) ?? 0;
    if (cronRounds >= MAX_CRON_ROUNDS) {
      console.log(`[Cron] Task ${task.name} session rotation (${cronRounds} >= ${MAX_CRON_ROUNDS}), starting fresh thread`);
      // 清除所有 adapter 特定的 session/thread ID
      delete sessionAny.codexThreadId;
      delete sessionAny._appServerGen;
      delete sessionAny.sdkSessionId;
      delete sessionAny.ocSessionId;
      delete sessionAny.geminiSessionId;
      sessionAny._cronRounds = 0;
      taskSession.startFresh = true;
    }
    sessionAny._cronRounds = cronRounds + 1;

    // P4-2: 超时取消 — 使用 AbortController 真正取消底层 Agent 调用
    const abortController = new AbortController();
    let settled = false;
    const timeoutPromise = new Promise<'timeout'>((resolve) =>
      setTimeout(() => {
        if (settled) return; // processMessage already won the race
        settled = true;
        abortController.abort();
        console.log(`[Cron] Task ${task.name} timed out, cancelled`);
        TaskLogger.log({
          event: 'task.timeout',
          taskName: task.name,
          taskType: task.type,
          timeoutMs,
        });
        resolve('timeout');
      }, timeoutMs)
    );

    // P4-3: stopwatch auto_stop — 检查是否超过自动停止时间
    if (task.type === 'stopwatch' && task.auto_stop) {
      const state = this.taskPoller.getTaskState().get(task.name);
      if (state?.startedAt && state.elapsedMs !== undefined) {
        const autoStopMs = this.parseDuration(task.auto_stop);
        if (autoStopMs > 0 && state.elapsedMs >= autoStopMs) {
          console.log(`[Cron] Task ${task.name} auto_stop reached (elapsed ${state.elapsedMs}ms >= ${autoStopMs}ms), stopping`);
          return 'success'; // 正常结束，不触发错误
        }
      }
    }

    // P2-1: conditional 真条件 — 在 prompt 前注入条件检查指令
    let taskText = task.prompt;
    if (task.type === 'conditional' && task.condition) {
      taskText = `[条件检查] 如果当前不满足以下条件，请只回复 "SKIP_TASK"，否则正常执行任务：\n条件：${task.condition}\n\n---\n\n${task.prompt}`;
    }

    // countdown 类型 — 注入当前执行次数，让模型知道是第几次
    if (task.type === 'countdown' && task.max_runs !== undefined) {
      const state = this.taskPoller.getTaskState().get(task.name);
      const currentRun = state?.runCount ?? 1;
      taskText = `[第 ${currentRun} 次 / 共 ${task.max_runs} 次]\n\n${taskText}`;
    }

    const ctx: MessageContext = {
      chatId: target.chatId,
      text: taskText,
      userId: 'system',
      workingDir: this.config.defaultCwd,
      model: this.config.model,
      systemPrompt: this.config.systemPrompt,
      cancelSignal: abortController.signal,  // P4-2
      reply: async (text: string) => {
        // P2-1: 识别 SKIP_TASK，不发送到 IM
        if (text.trim() === 'SKIP_TASK') {
          console.log(`[Cron] Task ${task.name} condition not met, skipped`);
          TaskLogger.log({
            event: 'task.skipped',
            taskName: task.name,
            taskType: task.type,
            reason: 'condition_not_met',
          });
          return;
        }
        console.log(`[Cron] Task ${task.name} → IM: ${text.slice(0, 200)}`);
        const sendTarget = deliveryChatId ?? target.chatId;
        await this.sendToIM(text, sendTarget);
        TaskLogger.log({
          event: 'task.delivered',
          taskName: task.name,
          taskType: task.type,
          deliveryChatId: sendTarget,
          replyLength: text.length,
        });
      },
      sendProgress: async (text: string) => {
        console.log(`[Cron] Task ${task.name} progress: ${text}`);
      },
    };

    console.log(`[Cron] Running task: ${task.name} prompt=${task.prompt.slice(0, 80)} timeout=${task.timeout ?? this.config.defaults?.timeout ?? '60s'}`);
    // 走 AgentLoop：adapter 带本地工具循环
    const taskInput = this._buildAgentInput(ctx, taskSession);
    // 通过 runtime 共享队列入队，防止与用户消息竞争同一 chatId
    const chatId = target.chatId;
    const result = await this.runtime.enqueueForTask(chatId, async () => {
      const raceResult = await Promise.race([this.agentLoop.execute(taskInput), timeoutPromise]);
      return raceResult;
    });
    settled = true; // prevent late timeout callback from firing
    this.sessionManager.persist(this.config.botId, taskSession);

    return result === 'timeout' ? 'timeout' : 'success';
  }

  /**
   * 发送任务失败告警
   */
  private async sendAlert(task: ScheduledTask, lastError: string): Promise<void> {
    const taskState = this.taskPoller.getTaskState().get(task.name);
    const runCount = taskState?.runCount ?? 0;

    const taskType = task.type ?? 'interval';
    const maxRetries = task.max_retries ?? this.config.defaults?.max_retries ?? 3;

    const alertMsg = [
      '⚠️ 定时任务失败',
      `任务: ${task.name}`,
      `类型: ${taskType}${task.interval ? ` (${task.interval})` : ''}`,
      `失败次数: ${maxRetries}/${maxRetries}`,
      `最后错误: ${lastError}`,
      `时间: ${formatShanghaiTimeShort(Date.now())}`,
    ].join('\n');

    console.warn(`[Cron] ALERT: ${alertMsg.replace(/\n/g, ' | ')}`);

    // 发送到 IM（使用最后活跃的真实 IM chatId）
    try {
      const deliveryChatId = this._resolver.getLastActiveChatId();
      if (deliveryChatId) {
        await this.sendToIM(alertMsg, deliveryChatId);
      } else {
        console.warn(`[Cron] No active IM chatId for alert, skipping delivery`);
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
   * P2-2: 原子读取防御 - 先复制到临时文件再读取，避免读到不完整内容
   */
  private readHeartbeatFile(): string {
    try {
      if (!fs.existsSync(this.config.heartbeatFilePath)) {
        return '';
      }

      // 原子读取：先复制到临时文件，再从临时文件读取
      const tmpPath = path.join(os.tmpdir(), `heartbeat_${Date.now()}.tmp`);
      fs.copyFileSync(this.config.heartbeatFilePath, tmpPath);

      try {
        const content = fs.readFileSync(tmpPath, 'utf-8');
        return content;
      } finally {
        // 清理临时文件
        try {
          fs.unlinkSync(tmpPath);
        } catch {}
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

  /**
   * P4-3: 解析时长字符串 → 毫秒
   * 支持格式："30m" / "2h" / "1h30m" / "3600"（秒）
   */
  private parseDuration(str: string): number {
    const match = str.match(/^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/);
    if (!match) {
      // 纯数字视为秒
      const secs = parseInt(str, 10);
      return isNaN(secs) ? 0 : secs * 1000;
    }
    const h = parseInt(match[1] || '0', 10);
    const m = parseInt(match[2] || '0', 10);
    const s = parseInt(match[3] || '0', 10);
    return (h * 3600 + m * 60 + s) * 1000;
  }
}
