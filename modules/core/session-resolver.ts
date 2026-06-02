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

  constructor(sessionManager: SessionManager, botKey: string) {
    this.sessionManager = sessionManager;
    this.botKey = botKey;
  }

  /**
   * 解析心跳 session 的目标
   * L0 版本：固定返回 heartbeat session
   */
  resolveHeartbeat(): ResolveTargetResult {
    const sessionKey = `${this.botKey}:heartbeat`;
    return {
      chatId: sessionKey,  // L0 用 sessionKey 作为 chatId
      userId: undefined,
      sessionKey,
      sessionType: 'heartbeat',
    };
  }

  /**
   * 解析定时任务 session 的目标
   * L0 版本：用任务名作为 sessionKey
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
   * 获取或创建对应的 session
   */
  async getOrCreateSession(target: ResolveTargetResult, defaults?: Partial<Session>): Promise<Session> {
    return this.sessionManager.getOrCreateByKey(
      this.botKey,
      target.sessionKey,
      defaults
    );
  }
}
