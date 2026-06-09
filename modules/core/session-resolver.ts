// ================================================================
// SessionResolver — 按消息来源选择 session（L0 骨架）
// ================================================================
// L0 范围：仅实现固定路由（heartbeat → heartbeat session，cron → cron session）
// L1 扩展：加入 lastActiveChatId 映射、target.chatId 配置覆盖、无活跃对话时的 fallback 策略
// ================================================================

import type { SessionManager, Session } from './types';

export interface ResolveTargetResult {
  chatId: string;
  userId?: string;
  sessionKey: string;
  sessionType: 'main' | 'heartbeat' | 'cron';
}

/**
 * 解析心跳/定时任务的目标 session
 */
export class SessionResolver {
  private sessionManager: SessionManager;
  private botKey: string;
  /** Maps botKey → last active real IM chatId, updated on each real user message */
  private lastActiveChatIds = new Map<string, string>();

  constructor(sessionManager: SessionManager, botKey: string) {
    this.sessionManager = sessionManager;
    this.botKey = botKey;
  }

  /**
   * Called by Bot.handleMessage() when a real user message arrives.
   * Tracks the chatId so heartbeat/cron can deliver to the last active chat.
   */
  updateLastActiveChatId(botKey: string, chatId: string): void {
    this.lastActiveChatIds.set(botKey, chatId);
  }

  /**
   * Get the last active IM chatId for this bot.
   * Returns undefined if no real conversation has happened yet.
   */
  getLastActiveChatId(): string | undefined {
    return this.lastActiveChatIds.get(this.botKey);
  }

  /**
   * 解析心跳 session 的目标
   * L1: 优先使用追踪的真实 IM chatId
   */
  resolveHeartbeat(): ResolveTargetResult {
    const sessionKey = `${this.botKey}:heartbeat`;
    const deliveryChatId = this.lastActiveChatIds.get(this.botKey);
    return {
      chatId: deliveryChatId ?? sessionKey,
      userId: undefined,
      sessionKey,
      sessionType: 'heartbeat',
    };
  }

  /**
   * 解析定时任务 session 的目标
   * L1: 优先使用追踪的真实 IM chatId
   */
  resolveCron(taskName: string): ResolveTargetResult {
    const sessionKey = `${this.botKey}:cron:${taskName}`;
    const deliveryChatId = this.lastActiveChatIds.get(this.botKey);
    return {
      chatId: deliveryChatId ?? sessionKey,
      userId: undefined,
      sessionKey,
      sessionType: 'cron',
    };
  }

  /**
   * 获取或创建对应的 session
   */
  async getOrCreateSession(target: ResolveTargetResult): Promise<Session> {
    return this.sessionManager.getOrCreateByKey(
      this.botKey,
      target.sessionKey,
      { sessionType: target.sessionType } // P1-5: 确保新建 session 有正确的 sessionType
    );
  }
}
