// ================================================================
// ErrorHandler — 错误处理策略
// ================================================================
// 统一管理后端调用错误，提供重试、降级、用户友好提示
// ================================================================

import type { ErrorAction, ErrorContext, ErrorHandler } from './types';

// ================================================================
// DefaultErrorHandler
// ================================================================

export class DefaultErrorHandler implements ErrorHandler {
  /**
   * 处理错误，返回处理动作
   * 
   * 策略：
   * - 网络超时 → 自动重试 (最多 2 次)
   * - 429 限流 → 等待后重试
   * - 401 认证失败 → 直接返回用户提示
   * - 5xx 服务端错误 → 重试
   * - 其他 → 返回用户友好消息
   */
  async handle(chatId: string, error: Error, ctx: ErrorContext): Promise<ErrorAction> {
    const errMsg = error.message || String(error);
    const backend = ctx.backend;

    console.error(`[Error] ${backend} call failed (attempt ${ctx.attempt}): ${errMsg}`);

    // 提取 HTTP 状态码
    const statusCode = this.extractStatusCode(error);
    const isTimeout = this.isTimeoutError(error);

    // 重试策略
    if (ctx.attempt < 2) {
      // 网络超时、5xx → 重试
      if (isTimeout || statusCode >= 500) {
        console.log(`[Error] Will retry ${backend} call (${ctx.attempt + 1}/2)`);
        return { type: 'retry', maxAttempts: 2 };
      }

      // 429 限流 → 重试
      if (statusCode === 429) {
        const retryAfter = this.extractRetryAfter(error);
        if (retryAfter > 0) {
          console.log(`[Error] 429 rate limited, waiting ${retryAfter}ms before retry`);
          await this.sleep(retryAfter);
        }
        return { type: 'retry', maxAttempts: 2 };
      }
    }

    // 超过重试次数或不满足重试条件 → 返回用户提示
    const userMessage = this.getUserMessage(error, backend, ctx.attempt);
    return { type: 'reply', message: userMessage };
  }

  /** 从错误中提取 HTTP 状态码 */
  private extractStatusCode(error: Error): number {
    const msg = error.message || '';
    const match = msg.match(/status[:\s]+(\d+)/i) || msg.match(/(\d{3})\s/);
    if (match) return parseInt(match[1]);

    // 尝试从 error 对象中获取
    const err = error as Record<string, unknown>;
    if (typeof err.status === 'number') return err.status;
    const resp = err.response as Record<string, unknown> | undefined;
    if (resp && typeof resp.status === 'number') return resp.status;
    if (typeof err.statusCode === 'number') return err.statusCode;

    return 0;
  }

  /** 判断是否为超时错误 */
  private isTimeoutError(error: Error): boolean {
    const msg = error.message.toLowerCase();
    return msg.includes('timeout') || msg.includes('timed out') || msg.includes('etimedout')
      || msg.includes('econnreset') || msg.includes('econnrefused')
      || msg.includes('socket hang up') || msg.includes('network error');
  }

  /** 提取 Retry-After 毫秒数 */
  private extractRetryAfter(error: Error): number {
    const msg = error.message;
    const match = msg.match(/retry[-_\s]?after[:\s]*(\d+)/i);
    if (match) return parseInt(match[1]) * 1000;

    const err = error as Record<string, unknown>;
    const resp = err.response as Record<string, unknown> | undefined;
    const headers = resp?.headers as Record<string, unknown> | undefined;
    if (headers?.['retry-after']) {
      return parseInt(String(headers['retry-after'])) * 1000;
    }

    // 默认等待 2 秒
    return 2000;
  }

  /** 生成用户友好的错误消息 */
  private getUserMessage(error: Error, backend: string, attempt: number): string {
    const statusCode = this.extractStatusCode(error);

    if (statusCode === 401 || statusCode === 403) {
      return `⚠️ ${backend} backend authentication failed. Please ask an admin to check the configuration.`;
    }

    if (statusCode === 429) {
      return `⚠️ Too many requests. Please try again later.`;
    }

    if (statusCode >= 500) {
      return `⚠️ ${backend} server is temporarily unavailable. Please try again later.`;
    }

    if (this.isTimeoutError(error)) {
      return `⚠️ Request timed out. The backend may be processing a complex task. Please try again later.`;
    }

    // 通用错误
    const shortMsg = error.message.slice(0, 100);
    return `⚠️ Error processing message: ${shortMsg}`;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
