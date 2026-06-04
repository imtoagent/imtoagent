// ================================================================
// OutputRouter — 输出路由：channel 选择、去重
// ================================================================
// Phase 1 重构：删除心跳专用过滤逻辑（HEARTBEAT_OK/短噪音等）。
// 心跳不再调 Agent，不再需要输出过滤。
// 保留：主对话 session 和 cron session 的基础路由。
// ================================================================

/**
 * 判断心跳回复是否与上一轮重复（简单文本相似度）
 */
export function isHeartbeatDuplicate(currentText: string, previousText?: string): boolean {
  if (!previousText) return false;
  return currentText.trim() === previousText.trim();
}

/**
 * 输出路由结果
 */
export interface OutputRouteResult {
  shouldSend: boolean;
  reason: 'normal' | 'heartbeat_ok_filtered' | 'duplicate_filtered' | 'empty';
}

/**
 * 输出路由：过滤 + 发送
 *
 * Phase 1 重构后：
 * - main session：直接发送
 * - cron session：基础去重
 * - heartbeat session：已不存在（心跳不再调 Agent）
 */
export function filterAndSend(
  text: string,
  ctx: {
    sessionType: 'main' | 'heartbeat' | 'cron';
    lastHeartbeatText?: string;
    reply: (text: string) => Promise<void>;
  }
): OutputRouteResult {
  // 主对话 session：不过滤，直接发送
  if (ctx.sessionType === 'main') {
    ctx.reply(text);
    return { shouldSend: true, reason: 'normal' };
  }

  // Cron session：基础去重
  if (ctx.sessionType === 'cron') {
    if (!text || text.trim().length === 0) {
      return { shouldSend: false, reason: 'empty' };
    }
    if (isHeartbeatDuplicate(text, ctx.lastHeartbeatText)) {
      return { shouldSend: false, reason: 'duplicate_filtered' };
    }
    ctx.reply(text);
    return { shouldSend: true, reason: 'normal' };
  }

  // Heartbeat session（Phase 1 重构后不再使用，但保留向后兼容）
  // 直接发送，不做过滤
  if (!text || text.trim().length === 0) {
    return { shouldSend: false, reason: 'empty' };
  }
  if (isHeartbeatDuplicate(text, ctx.lastHeartbeatText)) {
    return { shouldSend: false, reason: 'duplicate_filtered' };
  }
  ctx.reply(text);
  return { shouldSend: true, reason: 'normal' };
}

/**
 * 向后兼容：导出 isHeartbeatOk 但始终返回 false
 * （旧代码可能调用此函数，重构后心跳不再产生 HEARTBEAT_OK）
 */
export function isHeartbeatOk(_text: string): boolean {
  return false;
}
