// ================================================================
// SessionManager — 会话生命周期管理
// ================================================================
// 从 index.ts 和 anthropic-proxy.ts 迁移 session 逻辑
// 路径: ~/Desktop/imtoagent/sessions/{botName}/{chatId}.memory.json
// ================================================================

const fs = require('fs');
const path = require('path');

import type { Session, SessionManager, CallStats } from './types';
import { HEARTBEAT_ROUNDS_MAX } from './heartbeat';
import { getSessionsDir } from '../utils/paths';

const SESSIONS_BASE = getSessionsDir();

/** 默认统计值 */
const EMPTY_STATS: CallStats = {
  calls: 0,
  totalTurns: 0,
  totalInputTokens: 0,
  totalOutputTokens: 0,
  totalCostUSD: 0,
  totalDurationMs: 0,
};

// ================================================================
// 旧格式兼容
// ================================================================

/** 旧版 SessionData 格式（modules/types.ts 中的定义） */
interface LegacySessionData {
  chatId?: string;
  userId: string;
  sdkSessionId?: string;
  codexThreadId?: string;
  ocSessionId?: string;
  cwd?: string;
  permissionMode?: string;
  codexMode?: string;
  startFresh?: boolean;
  stats: CallStats;
  recentMessages: string[];
  lastUsed: number;
  activeModel?: string;
  modelAliases?: Record<string, string>;
}

/**
 * 从旧版 .memory.json 迁移为新版 Session 格式
 * 保持向后兼容，不影响现有会话文件
 */
function migrateFromLegacy(data: LegacySessionData, chatId: string): Session {
  const metadata: Record<string, unknown> = {};

  // 迁移旧版特有 ID 到 metadata
  if (data.sdkSessionId) metadata.sdkSessionId = data.sdkSessionId;
  if (data.codexThreadId) metadata.codexThreadId = data.codexThreadId;
  if (data.ocSessionId) metadata.ocSessionId = data.ocSessionId;

  // 通用 backendSessionId 优先使用旧版中的值
  const backendSessionId = data.sdkSessionId || data.codexThreadId || data.ocSessionId;

  return {
    chatId: data.chatId || chatId,
    userId: data.userId,
    cwd: data.cwd,
    startFresh: data.startFresh || false,
    backendSessionId,
    metadata,
    stats: data.stats || { ...EMPTY_STATS },
    lastUsed: data.lastUsed || Date.now(),
    running: false,
    permissionMode: data.permissionMode,
    codexMode: data.codexMode,
    recentMessages: data.recentMessages || [],
  };
}

// ================================================================
// FileSessionManager
// ================================================================

export class FileSessionManager implements SessionManager {
  /** 内存缓存: botName -> chatId -> Session */
  private cache = new Map<string, Map<string, Session>>();

  /** 获取 Session 文件路径 */
  private sessionPath(botKey: string, chatId: string): string {
    const sessionsBase = getSessionsDir();
    const botDir = path.join(sessionsBase, botKey);
    return path.join(botDir, `${chatId}.memory.json`);
  }

  /** 确保目录存在 */
  private ensureDir(botKey: string): void {
    const sessionsBase = getSessionsDir();
    const botDir = path.join(sessionsBase, botKey);
    if (!fs.existsSync(botDir)) {
      fs.mkdirSync(botDir, { recursive: true });
    }
  }

  async getOrCreate(botKey: string, chatId: string, userId: string): Promise<Session> {
    // 先查缓存
    const botCache = this.cache.get(botKey);
    if (botCache) {
      const cached = botCache.get(chatId);
      if (cached) {
        cached.lastUsed = Date.now();
        return cached;
      }
    }

    // 从文件加载
    const filePath = this.sessionPath(botKey, chatId);
    this.ensureDir(botKey);

    let session: Session;

    if (fs.existsSync(filePath)) {
      try {
        const raw = fs.readFileSync(filePath, 'utf-8');
        const data = JSON.parse(raw);

        // 检测是否为旧格式（有 sdkSessionId/codexThreadId/ocSessionId 顶层字段）
        if ('sdkSessionId' in data || 'codexThreadId' in data || 'ocSessionId' in data) {
          session = migrateFromLegacy(data as LegacySessionData, chatId);
        } else if ('metadata' in data && 'stats' in data && 'chatId' in data) {
          // 新格式
          session = {
            ...data,
            startFresh: data.startFresh || false,
            running: data.running || false,
            recentMessages: data.recentMessages || [],
            stats: data.stats || { ...EMPTY_STATS },
          };
        } else {
          // 未知格式，新建
          session = this.createNewSession(chatId, userId);
        }
      } catch (e: unknown) {
        console.error(`[Session] Failed to load ${chatId}: ${e.message}, creating new session`);
        session = this.createNewSession(chatId, userId);
      }
    } else {
      session = this.createNewSession(chatId, userId);
    }

    // 缓存
    if (!this.cache.has(botKey)) {
      this.cache.set(botKey, new Map());
    }
    this.cache.get(botKey)!.set(chatId, session);

    return session;
  }

  private createNewSession(chatId: string, userId: string): Session {
    return {
      chatId,
      userId,
      cwd: undefined,
      startFresh: false,
      backendSessionId: undefined,
      metadata: {},
      stats: { ...EMPTY_STATS },
      lastUsed: Date.now(),
      running: false,
      recentMessages: [],
    };
  }

  persist(botKey: string, session: Session): void {
    this.ensureDir(botKey);

    // 写入时保持旧格式兼容：将 metadata 中的旧 ID 也写入顶层
    const output: Record<string, unknown> = {
      chatId: session.chatId,
      userId: session.userId,
      cwd: session.cwd,
      startFresh: session.startFresh,
      stats: session.stats,
      lastUsed: session.lastUsed,
      recentMessages: session.recentMessages || [],
      running: session.running,
    };

    // 通用 backendSessionId
    if (session.backendSessionId) {
      output.backendSessionId = session.backendSessionId;
    }

    // 向后兼容：将 metadata 中的旧 ID 也写入顶层
    if (session.metadata) {
      if (session.metadata.sdkSessionId) output.sdkSessionId = session.metadata.sdkSessionId;
      if (session.metadata.codexThreadId) output.codexThreadId = session.metadata.codexThreadId;
      if (session.metadata.ocSessionId) output.ocSessionId = session.metadata.ocSessionId;
      // permissionMode / codexMode 也放在顶层
      if (session.permissionMode) output.permissionMode = session.permissionMode;
      if (session.codexMode) output.codexMode = session.codexMode;
    }

    // metadata 完整保存
    output.metadata = session.metadata;

    // 心跳/定时任务新字段（L0 新增）
    if (session.sessionType) output.sessionType = session.sessionType;
    if (session.sessionKey) output.sessionKey = session.sessionKey;
    if (session.lastHeartbeatText !== undefined) output.lastHeartbeatText = session.lastHeartbeatText;
    if (session.lastHeartbeatSentAt !== undefined) output.lastHeartbeatSentAt = session.lastHeartbeatSentAt;
    if (session.heartbeatTaskState) output.heartbeatTaskState = session.heartbeatTaskState;
    if (session.heartbeatRounds) output.heartbeatRounds = session.heartbeatRounds;

    // 文件路径：优先用 sessionKey，否则用 chatId
    const fileKey = session.sessionKey || session.chatId;
    const filePath = this.sessionPath(botKey, fileKey);
    try {
      fs.writeFileSync(filePath, JSON.stringify(output, null, 2));
    } catch (e: unknown) {
      console.error(`[Session] Failed to persist ${session.chatId}: ${e.message}`);
    }
  }

  delete(botKey: string, chatId: string): void {
    // 清除缓存
    const botCache = this.cache.get(botKey);
    if (botCache) {
      botCache.delete(chatId);
    }

    // 删除文件
    const filePath = this.sessionPath(botKey, chatId);
    try {
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
    } catch (e: unknown) {
      console.error(`[Session] Failed to delete ${chatId}: ${e.message}`);
    }
  }

  /**
   * 按 sessionKey 获取或创建 Session（L0 新增，心跳/定时任务专用）
   * 与 getOrCreate 的区别：以 sessionKey 作为文件键（而非 chatId）
   * 支持 defaults 预设（如 sessionType: 'heartbeat'）
   */
  async getOrCreateByKey(botKey: string, sessionKey: string, defaults?: Partial<Session>): Promise<Session> {
    // 先查缓存
    const botCache = this.cache.get(botKey);
    if (botCache) {
      const cached = botCache.get(sessionKey);
      if (cached) {
        cached.lastUsed = Date.now();
        return cached;
      }
    }

    // 从文件加载（用 sessionKey 作为文件名）
    const filePath = this.sessionPath(botKey, sessionKey);
    this.ensureDir(botKey);

    let session: Session;

    if (fs.existsSync(filePath)) {
      try {
        const raw = fs.readFileSync(filePath, 'utf-8');
        const data = JSON.parse(raw);
        session = {
          ...data,
          startFresh: data.startFresh || false,
          running: data.running || false,
          recentMessages: data.recentMessages || [],
          stats: data.stats || { ...EMPTY_STATS },
          sessionType: data.sessionType || defaults?.sessionType || 'main',
          sessionKey: data.sessionKey || sessionKey,
        };
      } catch (e: unknown) {
        console.error(`[Session] Failed to load ${sessionKey}: ${(e as Error).message}, creating new session`);
        session = this.createNewSessionByKey(sessionKey, defaults);
      }
    } else {
      session = this.createNewSessionByKey(sessionKey, defaults);
    }

    // 缓存
    if (!this.cache.has(botKey)) {
      this.cache.set(botKey, new Map());
    }
    this.cache.get(botKey)!.set(sessionKey, session);

    return session;
  }

  private createNewSessionByKey(sessionKey: string, defaults?: Partial<Session>): Session {
    return {
      chatId: sessionKey,
      userId: 'system',
      cwd: undefined,
      startFresh: false,
      backendSessionId: undefined,
      metadata: {},
      stats: { ...EMPTY_STATS },
      lastUsed: Date.now(),
      running: false,
      recentMessages: [],
      sessionType: defaults?.sessionType || 'main',
      sessionKey: sessionKey,
      ...defaults,
    };
  }

  cleanupIdle(botKey: string, timeoutMs: number): void {
    const botCache = this.cache.get(botKey);
    if (!botCache) return;

    const now = Date.now();
    const toRemove: string[] = [];

    for (const [chatId, session] of botCache) {
      // 豁免心跳和定时任务 session（P1-3：改用 sessionType 判断，更精确）
      if (session.sessionType === 'heartbeat') continue;
      if (session.sessionType === 'cron') continue;
      if (now - session.lastUsed > timeoutMs && !session.running) {
        toRemove.push(chatId);
      }
    }

    for (const chatId of toRemove) {
      botCache.delete(chatId);
      console.log(`[Session] Cleaning up idle session: ${chatId}`);
    }
  }

  listActive(botKey: string): Session[] {
    const botCache = this.cache.get(botKey);
    if (!botCache) return [];
    return Array.from(botCache.values());
  }
}
