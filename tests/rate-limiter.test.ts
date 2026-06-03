/**
 * rate-limiter.test.ts
 *
 * Tests for modules/rate-limiter.ts:
 * - 默认配置下正常放行
 * - 超过限制后拒绝并返回 retryAfter
 * - remaining 计数准确
 * - 不同 chatId 独立隔离
 * - 自定义配置生效
 *
 * ⚠️ 注意：rate-limiter 使用模块级全局状态 (windows Map)，
 * 所以每个测试使用唯一的 chatId 避免互相干扰。
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { checkRateLimit, setRateLimitConfig } from "../modules/rate-limiter";

let idCounter = 0;
function uniqueId(prefix = "rl"): string {
  return `${prefix}-${++idCounter}-${Date.now()}`;
}

beforeEach(() => {
  setRateLimitConfig({ maxRequests: 30, windowMs: 60_000 });
});

// ================================================================
// 1. 默认配置 — 正常放行
// ================================================================

describe("checkRateLimit default behavior", () => {
  it("should allow first request", () => {
    const id = uniqueId();
    const result = checkRateLimit(id);
    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(29); // 30 - 1
  });

  it("should decrement remaining on each request", () => {
    const id = uniqueId();
    const r1 = checkRateLimit(id);
    expect(r1.remaining).toBe(29);

    const r2 = checkRateLimit(id);
    expect(r2.remaining).toBe(28);

    const r3 = checkRateLimit(id);
    expect(r3.remaining).toBe(27);
  });
});

// ================================================================
// 2. 不同 chatId 隔离
// ================================================================

describe("checkRateLimit per-chatId isolation", () => {
  it("should track different chatIds independently", () => {
    const id1 = uniqueId();
    const id2 = uniqueId();

    const r1 = checkRateLimit(id1);
    const r2 = checkRateLimit(id2);

    expect(r1.allowed).toBe(true);
    expect(r2.allowed).toBe(true);
    // Both should have same remaining since they're independent
    expect(r1.remaining).toBe(29);
    expect(r2.remaining).toBe(29);
  });

  it("should not mix up counts between chatIds", () => {
    const idA = uniqueId();
    const idB = uniqueId();

    // Make 5 requests for A
    for (let i = 0; i < 5; i++) {
      checkRateLimit(idA);
    }

    // First request for B should still have 29 remaining
    const resultB = checkRateLimit(idB);
    expect(resultB.remaining).toBe(29);

    // chat-a should now have 24 remaining (30 - 6)
    const resultA = checkRateLimit(idA);
    expect(resultA.remaining).toBe(24);
  });
});

// ================================================================
// 3. 超过限制后拒绝
// ================================================================

describe("checkRateLimit rate limit enforcement", () => {
  it("should reject after maxRequests", () => {
    const id = uniqueId();
    setRateLimitConfig({ maxRequests: 3, windowMs: 60_000 });

    // 3 allowed requests
    expect(checkRateLimit(id).allowed).toBe(true);
    expect(checkRateLimit(id).allowed).toBe(true);
    expect(checkRateLimit(id).allowed).toBe(true);

    // 4th should be rejected
    const result = checkRateLimit(id);
    expect(result.allowed).toBe(false);
    expect(result.remaining).toBe(0);
    expect(result.retryAfter).toBeDefined();
    expect(result.retryAfter!).toBeGreaterThan(0);
  });

  it("should return retryAfter in seconds", () => {
    const id = uniqueId();
    setRateLimitConfig({ maxRequests: 2, windowMs: 10_000 });

    checkRateLimit(id);
    checkRateLimit(id);
    const result = checkRateLimit(id);

    expect(result.allowed).toBe(false);
    expect(result.retryAfter).toBeGreaterThan(0);
    expect(result.retryAfter).toBeLessThanOrEqual(10); // within window
  });
});

// ================================================================
// 4. 自定义配置
// ================================================================

describe("setRateLimitConfig", () => {
  it("should apply custom maxRequests", () => {
    const id = uniqueId();
    setRateLimitConfig({ maxRequests: 5, windowMs: 60_000 });

    for (let i = 0; i < 5; i++) {
      expect(checkRateLimit(id).allowed).toBe(true);
    }
    expect(checkRateLimit(id).allowed).toBe(false);
  });

  it("should apply custom windowMs", () => {
    const id = uniqueId();
    setRateLimitConfig({ maxRequests: 2, windowMs: 1000 });

    checkRateLimit(id);
    checkRateLimit(id);
    expect(checkRateLimit(id).allowed).toBe(false);
  });

  it("should allow configuring high limits", () => {
    const id = uniqueId();
    setRateLimitConfig({ maxRequests: 100, windowMs: 60_000 });

    for (let i = 0; i < 50; i++) {
      checkRateLimit(id);
    }
    const result = checkRateLimit(id);
    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(49);
  });
});

// ================================================================
// 5. remaining 边界值
// ================================================================

describe("checkRateLimit remaining edge cases", () => {
  it("should return remaining=0 when limit reached", () => {
    const id = uniqueId();
    setRateLimitConfig({ maxRequests: 1, windowMs: 60_000 });
    checkRateLimit(id);
    const result = checkRateLimit(id);
    expect(result.remaining).toBe(0);
  });

  it("should return correct remaining after many requests", () => {
    const id = uniqueId();
    setRateLimitConfig({ maxRequests: 100, windowMs: 60_000 });

    for (let i = 0; i < 50; i++) {
      checkRateLimit(id);
    }
    // 51st request
    const result = checkRateLimit(id);
    expect(result.remaining).toBe(49); // 100 - 51
  });
});
