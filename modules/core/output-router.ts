// ================================================================
// OutputRouter — 输出路由：channel 选择、去重、心跳回复拦截
// ================================================================
// L0 范围：纯函数 + 简单路由逻辑，不直接依赖 IM 层
// L1 扩展：集成到 HeartbeatScheduler 的 reply 回调中，自动调用 filterAndSend
// ================================================================

/** HEARTBEAT_OK 独占一行匹配正则（向后兼容） */
const HEARTBEAT_OK_LINE_PATTERN = /(^|\n)\s*HEARTBEAT[_\s]?OK\s*(\n|$)/i;

/** HEARTBEAT_OK 任意位置匹配（兜底，防止混在正文中泄露） */
const HEARTBEAT_OK_ANYWHERE = /HEARTBEAT[_\s]?OK/i;

/** JSON 心跳 OK 匹配：{"status":"ok"} 及其变体 */
const HEARTBEAT_JSON_OK_PATTERN = /^\s*\{\s*"status"\s*:\s*"ok"\s*\}\s*$/i;

/** 心跳 session 下短回复阈值（≤ 此长度且无告警关键字视为无效废话，拦截） */
const SHORT_REPLY_THRESHOLD = 10;

/**
 * 判断回复是否为 HEARTBEAT_OK（心跳正常，无需打扰用户）
 * 全文 ≤300 字符 且 HEARTBEAT_OK 独占一行（允许前后有其他行）
 * 向后兼容：旧版 HEARTBEAT_OK 字符串
 */
export function isHeartbeatOk(text: string): boolean {
  return text.length <= 300 && HEARTBEAT_OK_LINE_PATTERN.test(text);
}

/**
 * 判断文本中是否包含 HEARTBEAT_OK（任意位置）
 */
function hasHeartbeatOk(text: string): boolean {
  return HEARTBEAT_OK_ANYWHERE.test(text);
}

/**
 * 判断回复是否为 JSON 格式的心跳 OK：{"status": "ok"}
 * 支持前后空白、大小写不敏感
 */
export function isHeartbeatOkJson(text: string): boolean {
  return HEARTBEAT_JSON_OK_PATTERN.test(text);
}

/**
 * 判断是否为心跳 session 下的短回复噪音（疑似无意义废话，应拦截）
 * 条件：≤10 字符 且不含典型告警关键字（error/fail/wrong/alert/问题/异常/失败/错误/警告）
 * 这样 "Something is wrong" 能通过（含 wrong），但 "全部正常。" "好的" "OK" 被拦截
 */
function isShortNoise(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length > SHORT_REPLY_THRESHOLD) return false;
  // 如果是 alert JSON，不算噪音
  try {
    const parsed = JSON.parse(trimmed);
    if (parsed.status === 'alert' && parsed.message) return false;
  } catch {}
  // 包含告警关键字的短文本视为有效信息，不拦截
  const alertKeywords = /error|fail|wrong|alert|issue|problem|warning|问题|异常|失败|错误|警告|注意|urgent|down|offline|crash|broken|timeout/i;
  if (alertKeywords.test(trimmed)) return false;
  return true;
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

  // ===== 心跳 session 专用过滤 =====
  if (ctx.sessionType === 'heartbeat') {
    // 1. 空文本（优先）
    if (!text || text.trim().length === 0) {
      return { shouldSend: false, reason: 'empty' };
    }

    // 2. 重复检测
    if (isHeartbeatDuplicate(text, ctx.lastHeartbeatText)) {
      return { shouldSend: false, reason: 'duplicate_filtered' };
    }

    // 3. JSON 格式心跳 OK（新版优先匹配）
    if (isHeartbeatOkJson(text)) {
      return { shouldSend: false, reason: 'heartbeat_ok_filtered' };
    }

    // 4. HEARTBEAT_OK 字符串（向后兼容）
    if (isHeartbeatOk(text)) {
      return { shouldSend: false, reason: 'heartbeat_ok_filtered' };
    }

    // 5. 兜底：HEARTBEAT_OK 出现在任意位置，一律拦截
    if (hasHeartbeatOk(text)) {
      return { shouldSend: false, reason: 'heartbeat_ok_filtered' };
    }

    // 6. 短回复噪音（≤10 字符且无告警关键字，如 "全部正常。" "好的" "OK" 等）
    if (isShortNoise(text)) {
      return { shouldSend: false, reason: 'heartbeat_ok_filtered' };
    }
  }

  // ===== Cron session：HEARTBEAT_OK 兜底拦截 =====
  if (ctx.sessionType === 'cron' && hasHeartbeatOk(text)) {
    return { shouldSend: false, reason: 'heartbeat_ok_filtered' };
  }

  // 重复检测
  if (isHeartbeatDuplicate(text, ctx.lastHeartbeatText)) {
    return { shouldSend: false, reason: 'duplicate_filtered' };
  }

  // 空文本
  if (!text || text.trim().length === 0) {
    return { shouldSend: false, reason: 'empty' };
  }

  ctx.reply(text);
  return { shouldSend: true, reason: 'normal' };
}
