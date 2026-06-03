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
   * 解析心跳 session 的目标
   *
   * 心跳 session 始终使用独立的 sessionKey 作为 chatId，
   * 不与主 session 共享 chatId 命名空间，防止 Codex goal continuation
   * 跨 session 泄漏上下文。
   *
   * 需要投递告警到真实 IM 时，使用 getLastActiveChatId()。
   */
  resolveHeartbeat(): ResolveTargetResult {
    const sessionKey = `${this.botKey}:heartbeat`;
    return {
      chatId: sessionKey,
      userId: undefined,
      sessionKey,
      sessionType: 'heartbeat',
    };
  }

  /**
   * 解析定时任务 session 的目标
   *
   * 与心跳 session 同理，使用独立的 sessionKey，不 fallback。
   */
  resolveCron(taskName: string): ResolveTargetResult {
    const sessionKey = `${this.botKey}:cron:${taskName}`;
    return {
      chatId: sessionKey,
      userId: undefined,
      sessionKey,
      sessionType: 'cron',
    };
  }

  /**
   * 获取最后活跃的真实 IM chatId，用于告警投递。
   * 无活跃记录时返回 null。
   */
  getLastActiveChatId(): string | null {
    return this.lastActiveChatIds.get(this.botKey) ?? null;
  }

  /**
   * 获取或创建对应的 session
   */
  async getOrCreateSession(target: ResolveTargetResult): Promise<Session> {
    return this.sessionManager.getOrCreateByKey(
      this.botKey,
      target.sessionKey,
      { sessionType: target.sessionType },
    );
  }
}
