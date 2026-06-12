// ================================================================
// Thread Rotation + Context Memory — 公共逻辑
// ================================================================
// 为所有支持 session resume 的后端提供统一的轮转和上下文记忆机制。
// 解决长周期运行（heartbeat/cron）导致的上下文无限膨胀问题。
// ================================================================

import type { Session } from './types';

/** 轮转配置 */
export interface RotationConfig {
  /** 触发轮转的轮次上限 */
  maxTurns: number;
  /** 摘要保留的最近轮次数 */
  summaryRoundCount: number;
}

const DEFAULT_CONFIG: RotationConfig = {
  maxTurns: 10,
  summaryRoundCount: 3,
};

/**
 * 检查是否需要轮转，如果需要则：
 * 1. 从旧 session 提取上下文摘要
 * 2. 存入 session.contextMemory
 * 3. 清除后端 session ID（触发新建）
 * 4. 重置轮次计数
 *
 * 返回 true 表示执行了轮转
 */
export function checkAndRotate(
  session: Session,
  sessionAny: Record<string, unknown>,
  backendSessionIdKey: string,
  config?: Partial<RotationConfig>,
): boolean {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  const turnCount = (sessionAny._turnCount as number) ?? 0;

  if (turnCount < cfg.maxTurns) return false;

  const oldSessionId = sessionAny[backendSessionIdKey] as string | undefined;
  if (!oldSessionId) return false;

  // 提取上下文摘要
  try {
    const rounds = (session.heartbeatRounds || []).slice(-cfg.summaryRoundCount);
    if (rounds.length > 0) {
      const summaryParts = rounds.map((r, i) =>
        `[轮${i + 1}] 用户: ${r.prompt || "(无)"}\n回复: ${r.response || "(无)"}`
      );
      const summary = "以下是之前对话的关键上下文（自动轮转保留）：\n" + summaryParts.join("\n---\n");
      session.contextMemory = {
        summary,
        fromThreadId: oldSessionId,
        rotatedAt: Date.now(),
        rotationCount: ((session.contextMemory?.rotationCount) || 0) + 1,
      };
      console.log(`[Rotation] context memory saved (${summary.length} chars, rotation #${session.contextMemory.rotationCount})`);
    }
  } catch (e: unknown) {
    console.error(`[Rotation] failed to extract context memory: ${(e as Error).message}`);
  }

  // 清除所有后端 session ID
  delete sessionAny[backendSessionIdKey];
  delete sessionAny._appServerGen;
  session.startFresh = true;
  sessionAny._turnCount = 0;

  console.log(`[Rotation] rotated after ${turnCount} turns, cleared ${backendSessionIdKey}`);
  return true;
}

/**
 * 注入 context memory 到首条消息
 * 返回带上下文的消息（如果有 memory 且是首条消息）
 */
export function injectContextMemory(
  session: Session,
  turnCount: number,
  prompt: string,
): string {
  if (turnCount > 0 || !session.contextMemory?.summary) return prompt;
  const injected = `<previous-context>\n${session.contextMemory.summary}\n</previous-context>\n\n${prompt}`;
  console.log(`[Rotation] injected context memory (${session.contextMemory.summary.length} chars)`);
  return injected;
}

/**
 * 递增轮次计数
 */
export function incrementTurnCount(sessionAny: Record<string, unknown>): void {
  sessionAny._turnCount = ((sessionAny._turnCount as number) ?? 0) + 1;
}
