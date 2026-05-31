// ================================================================
// AgentRuntime — 消息处理中枢
// ================================================================
// 协调 Session / Stats / Error / Config，调用 Agent 适配器处理消息
// 
// processMessage 流程：
//   1. 获取 session（通过 sessionManager.getOrCreate）
//   2. 检查 startFresh → 清除旧 backendSessionId
//   3. statsTracker.resetForCall()
//   4. ctx.sendProgress("💭 思考中...")
//   5. adapter.handleMessage(input) ← Agent 适配器
//   6. 成功 → statsTracker.accumulate() + ctx.reply() 或 ctx.sendBlocks()
//   7. 失败 → errorHandler.handle() → 可能 retry/fallback/reply
//   8. sessionManager.persist()
// ================================================================

import * as fs from 'fs';
import * as path from 'path';
import type {
  AgentAdapter,
  AgentInput,
  AgentOutput,
  MessageContext,
  RuntimeConfig,
  Session,
  ErrorAction,
  ErrorContext,
} from './types';
import { parseToBlocks } from '../capabilities';
import { DEFAULT_TERMINAL_CAPS } from '../prompt-builder';
import { logEvent } from '../utils/logger';
import { StatsPersist } from './stats-persist';

// ================================================================
// Agent 自主重启 — 文件信号（固定路径，不依赖 dataDir 参数）
// ================================================================
const RESTART_SIGNAL_PATH = path.join(process.env.HOME!, '.imtoagent', '.restart_requested');
const RESTART_COOLDOWN_MS = 5 * 60 * 1000; // 5 分钟
let lastRestartTime = 0;

interface RestartSignal {
  reason: string;
  timestamp: number;
  botName?: string;
}

/**
 * 检测重启信号文件是否存在且包含有效内容。
 */
function checkRestartSignal(): { triggered: boolean; reason: string } {
  try {
    if (!fs.existsSync(RESTART_SIGNAL_PATH)) return { triggered: false, reason: '' };
    const raw = fs.readFileSync(RESTART_SIGNAL_PATH, 'utf-8').trim();
    let signal: RestartSignal;
    try {
      signal = JSON.parse(raw);
    } catch {
      // 兼容纯文本格式
      signal = { reason: raw, timestamp: Date.now() };
    }
    return { triggered: true, reason: signal.reason || 'Unknown reason' };
  } catch {
    return { triggered: false, reason: '' };
  }
}

/**
 * 消费重启信号：读取后删除文件，确保每次信号只触发一次重启。
 */
function consumeRestartSignal(): { triggered: boolean; reason: string } {
  const result = checkRestartSignal();
  if (result.triggered) {
    try { fs.unlinkSync(RESTART_SIGNAL_PATH); } catch {}
  }
  return result;
}

// ================================================================
// AgentRuntime
// ================================================================

export class AgentRuntime {
  private adapters = new Map<string, AgentAdapter>();
  private config: RuntimeConfig;
  private statsPersist: StatsPersist | null = null;

  // Per-chatId concurrency queue — prevents race conditions on session state
  private queues = new Map<string, Promise<void>>();

  constructor(config: RuntimeConfig) {
    this.config = config;
    // Initialize stats persistence (lazy, on first use)
    try {
      const { StatsPersist } = require('./stats-persist');
      this.statsPersist = new StatsPersist();
    } catch {
      // Stats persistence is optional; don't fail if it can't initialize
    }
  }

  /**
   * Get the StatsPersist instance (for CLI access).
   */
  getStatsPersist(): StatsPersist | null {
    return this.statsPersist;
  }

  /**
   * 注册 Agent 适配器
   * @param backend 后端标识 ('claude' | 'codex' | 'opencode' 等)
   * @param adapter Agent 适配器实例
   */
  registerAdapter(backend: string, adapter: AgentAdapter): void {
    this.adapters.set(backend, adapter);
    console.log(`[Runtime] Registered adapter: ${backend} → ${adapter.name}`);
  }

  /**
   * 获取已注册的适配器
   */
  getAdapter(backend: string): AgentAdapter | undefined {
    return this.adapters.get(backend);
  }

  /**
   * Enqueue a message handler for a given chatId.
   * Ensures messages from the same chat are processed sequentially,
   * preventing race conditions on session state.
   */
  private enqueue(chatId: string, fn: () => Promise<{ restart: boolean; reason?: string }>): Promise<{ restart: boolean; reason?: string }> {
    const prev = this.queues.get(chatId) || Promise.resolve();
    let result: { restart: boolean; reason?: string } = { restart: false };
    const next = prev.then(
      () => fn().then((r) => { result = r; }),
      () => fn().then((r) => { result = r; }), // even if prev failed, run current
    );
    this.queues.set(chatId, next);
    next.finally(() => {
      if (this.queues.get(chatId) === next) this.queues.delete(chatId);
    });
    return next.then(() => result);
  }

  /**
   * 处理用户消息
   * 
   * @param ctx 消息处理上下文
   * @param adapter Agent 适配器
   * @param botName Bot 名称（用于 session 隔离）
   * @returns 如果 Agent 请求重启，返回 { restart: true, reason }；否则返回 { restart: false }
   */
  async processMessage(
    ctx: MessageContext,
    adapter: AgentAdapter,
    botName: string
  ): Promise<{ restart: boolean; reason?: string }> {
    return this.enqueue(ctx.chatId, () => this._processMessageInternal(ctx, adapter, botName));
  }

  private async _processMessageInternal(
    ctx: MessageContext,
    adapter: AgentAdapter,
    botName: string
  ): Promise<{ restart: boolean; reason?: string }> {
    const startTime = Date.now();
    let attempt = 0;
    const maxRetries = 2;

    while (attempt <= maxRetries) {
      attempt++;

      try {
        // 1. 获取 session
        const session = await this.config.sessionManager.getOrCreate(
          ctx.chatId,
          ctx.userId
        );

        // 2. 检查 startFresh → 清除旧 backendSessionId
        if (session.startFresh) {
          session.backendSessionId = undefined;
          session.metadata = {};
          session.startFresh = false;
          session.running = false;
          console.log(`[Runtime] startFresh: cleared old session for ${ctx.chatId}`);
        }

        // 3. 重置统计
        this.config.statsTracker.resetForCall(session);

        // Log message received
        logEvent({
          event: 'message_received',
          bot: botName,
          chatId: ctx.chatId,
          backend: adapter.name,
          textLength: ctx.text?.length || 0,
        });

        // 4. 发送进度提示
        await ctx.sendProgress('💭 Thinking...');

        session.running = true;

        // 5. 调用 Agent 适配器
        const input: AgentInput = {
          chatId: ctx.chatId,
          text: ctx.text,
          attachments: ctx.attachments,
          session,
          workingDir: ctx.workingDir,
          systemPrompt: ctx.systemPrompt,
          model: ctx.model,
          cancelSignal: ctx.cancelSignal,
          sendProgress: (t: string) => ctx.sendProgress(t),
        };

        const output = await adapter.handleMessage(input);

        // 6. 处理成功结果
        session.running = false;

        if (output.error) {
          throw new Error(output.error);
        }

        // 累加统计
        if (output.usage) {
          const duration = Date.now() - startTime;
          this.config.statsTracker.accumulate(session, {
            inputTokens: output.usage.inputTokens,
            outputTokens: output.usage.outputTokens,
            costUSD: output.usage.costUSD,
            durationMs: output.usage.durationMs || duration,
            numTurns: output.usage.numTurns,
          });

          // Persist usage to JSONL
          if (this.statsPersist) {
            this.statsPersist.record({
              ts: new Date().toISOString(),
              bot: botName,
              chatId: ctx.chatId,
              backend: adapter.name,
              model: ctx.model,
              inputTokens: output.usage.inputTokens,
              outputTokens: output.usage.outputTokens,
              costUsd: output.usage.costUSD || 0,
              durationMs: output.usage.durationMs || duration,
              turns: output.usage.numTurns,
              status: 'ok',
            });
          }

          // Log message sent
          logEvent({
            event: 'message_sent',
            bot: botName,
            chatId: ctx.chatId,
            backend: adapter.name,
            model: ctx.model,
            inputTokens: output.usage.inputTokens,
            outputTokens: output.usage.outputTokens,
            costUsd: output.usage.costUSD || 0,
            durationMs: output.usage.durationMs || duration,
            turns: output.usage.numTurns,
          });
        }

        // 发送回复 — 优先用 sendBlocks（parseToBlocks → 富文本渲染）
        if (output.text) {
          if (ctx.sendBlocks) {
            const caps = ctx.imCaps || DEFAULT_TERMINAL_CAPS;
            const blocks = parseToBlocks(output.text, caps);
            if (blocks.length === 1 && blocks[0].type === 'text') {
              await ctx.reply(output.text);
            } else {
              await ctx.sendBlocks(blocks);
            }
          } else {
            await ctx.reply(output.text);
          }
        }

        // 持久化 session
        this.config.sessionManager.persist(session.chatId, session);

        // 检查 Agent 自主重启信号（在 reply 之后检测，确保消息已发送）
        const signal = consumeRestartSignal();
        if (signal.triggered) {
          const now = Date.now();
          if (now - lastRestartTime < RESTART_COOLDOWN_MS) {
            const remaining = Math.ceil((RESTART_COOLDOWN_MS - (now - lastRestartTime)) / 1000);
            console.log(`[Runtime] ⏳ Agent restart request ignored (cooldown, retry in ${remaining}s): ${signal.reason}`);
          } else {
            lastRestartTime = now;
            console.log(`[Runtime] 🔄 Agent requested restart: ${signal.reason}`);
            return { restart: true, reason: signal.reason };
          }
        }

        return { restart: false };

      } catch (error: unknown) {
        console.error(`[Runtime] Failed to process message (attempt ${attempt}): ${error.message}`);

        // 7. 错误处理
        const errorCtx: ErrorContext = {
          chatId: ctx.chatId,
          backend: adapter.name,
          attempt,
        };

        const action = await this.config.errorHandler.handle(ctx.chatId, error, errorCtx);

        if (action.type === 'retry') {
          console.log(`[Runtime] Retrying ${adapter.name} call`);
          continue;
        }

        if (action.type === 'fallback') {
          console.log(`[Runtime] Fallback to ${action.adapter}`);
          // Call _processMessageInternal directly to avoid enqueue deadlock:
          // the outer processMessage already holds the chatId queue lock,
          // so re-entering processMessage would deadlock on same chatId.
          const fallbackAdapter = this.adapters.get(action.adapter);
          if (fallbackAdapter) {
            return this._processMessageInternal(ctx, fallbackAdapter, botName);
          }
        }

        if (action.type === 'reply') {
          await ctx.reply(action.message);
        }

        // 持久化 session（即使失败也要保存统计）
        try {
          const session = await this.config.sessionManager.getOrCreate(
            ctx.chatId,
            ctx.userId
          );
          session.running = false;
          this.config.sessionManager.persist(session.chatId, session);
        } catch {}

        return { restart: false }; // 不再重试
      }
    }
  }

  /**
   * 取消正在进行的会话
   */
  async cancelSession(adapterName: string, sessionId: string): Promise<void> {
    const adapter = this.adapters.get(adapterName);
    if (adapter?.cancel) {
      await adapter.cancel(sessionId);
    }
  }

  /**
   * 健康检查
   */
  async healthCheck(backend: string): Promise<boolean> {
    const adapter = this.adapters.get(backend);
    if (adapter?.healthCheck) {
      return adapter.healthCheck();
    }
    return true; // Assume healthy by default
  }
}
