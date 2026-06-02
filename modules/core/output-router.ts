// ================================================================
// OutputRouter — 输出路由：channel 选择、去重、HEARTBEAT_OK 拦截
// ================================================================
// L0 范围：纯函数 + 简单路由逻辑，不直接依赖 IM 层
// L1 扩展：集成到 HeartbeatScheduler 的 reply 回调中，自动调用 filterAndSend
// ================================================================

/** HEARTBEAT_OK 匹配正则 */
const HEARTBEAT_OK_PATTERN = /^HEARTBEAT[_\s]?OK$/i;

/**
 * 判断回复是否为 HEARTBEAT_OK（心跳正常，无需打扰用户）
 */
export function isHeartbeatOk(text: string): boolean {
  return HEARTBEAT_OK_PATTERN.test(text.trim()) && text.trim().length <= 300;
}

/**
 * 判断心跳回复是否与上一轮重复（简单文本相似度）
 * L0 版本：精确匹配
 * L1 版本：可加入语义相似度或关键字段提取
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
 * L0 版本：纯函数判断，由调用方决定是否发送
 * L1 版本：直接集成 MessageContext.reply 回调
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

  // 心跳/定时任务：应用过滤
  if (isHeartbeatOk(text)) {
    return { shouldSend: false, reason: 'heartbeat_ok_filtered' };
  }

  if (isHeartbeatDuplicate(text, ctx.lastHeartbeatText)) {
    return { shouldSend: false, reason: 'duplicate_filtered' };
  }

  if (!text || text.trim().length === 0) {
    return { shouldSend: false, reason: 'empty' };
  }

  ctx.reply(text);
  return { shouldSend: true, reason: 'normal' };
}
