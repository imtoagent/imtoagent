/**
 * core-error.test.ts
 *
 * Tests for DefaultErrorHandler (modules/core/error.ts):
 * - rate limit (429) → retry
 * - backend unavailable → fallback/reply
 * - bad input → reply
 * - unknown error → reply
 * - timeout → retry
 * - 5xx → retry
 * - 401/403 → reply (auth error)
 * - attempt >= 2 → reply (no retry)
 */

import { describe, it, expect, mock, afterEach } from "bun:test";
import { DefaultErrorHandler } from "../modules/core/error";
import type { ErrorContext } from "../modules/core/types";

// ================================================================
// Helpers
// ================================================================

function ctx(attempt: number = 1, backend: string = "test-backend"): ErrorContext {
  return {
    chatId: "chat-1",
    backend,
    attempt,
  };
}

function makeError(message: string): Error {
  const err = new Error(message);
  return err;
}

// ================================================================
// 1. rate limit (429) → retry
// ================================================================

describe("DefaultErrorHandler rate limit (429)", () => {
  afterEach(() => {
    // no-op: bun mocks are per-test
  });

  it("should retry on 429 at attempt 1 (with sleep)", async () => {
    const handler = new DefaultErrorHandler();

    // Mock sleep to resolve immediately
    const sleepSpy = mock(async (_ms: number) => {});
    (handler as any).sleep = sleepSpy;

    const error = makeError("status: 429 Rate limit exceeded");
    const action = await handler.handle("chat-1", error, ctx(1));

    expect(action.type).toBe("retry");
    expect(sleepSpy).toHaveBeenCalled();
  });

  it("should return reply on 429 at attempt 2 (no more retries)", async () => {
    const handler = new DefaultErrorHandler();

    const error = makeError("status: 429 Too many requests");
    const action = await handler.handle("chat-1", error, ctx(2));

    expect(action.type).toBe("reply");
    expect(action.message).toContain("Too many requests");
  });
});

// ================================================================
// 2. backend unavailable (5xx) → retry
// ================================================================

describe("DefaultErrorHandler backend unavailable (5xx)", () => {
  it("should retry on 500 at attempt 1", async () => {
    const handler = new DefaultErrorHandler();

    const error = makeError("status: 500 Internal Server Error");
    const action = await handler.handle("chat-1", error, ctx(1));

    expect(action.type).toBe("retry");
  });

  it("should retry on 503 at attempt 1", async () => {
    const handler = new DefaultErrorHandler();

    const error = makeError("status: 503 Service Unavailable");
    const action = await handler.handle("chat-1", error, ctx(1));

    expect(action.type).toBe("retry");
  });

  it("should return reply on 500 at attempt 2", async () => {
    const handler = new DefaultErrorHandler();

    const error = makeError("status: 500 Internal Server Error");
    const action = await handler.handle("chat-1", error, ctx(2));

    expect(action.type).toBe("reply");
    expect(action.message).toContain("unavailable");
  });
});

// ================================================================
// 3. timeout → retry
// ================================================================

describe("DefaultErrorHandler timeout", () => {
  it("should retry on timeout error at attempt 1", async () => {
    const handler = new DefaultErrorHandler();

    const error = makeError("Request timeout: ESOCKETTIMEDOUT");
    const action = await handler.handle("chat-1", error, ctx(1));

    expect(action.type).toBe("retry");
  });

  it("should retry on 'socket hang up' at attempt 1", async () => {
    const handler = new DefaultErrorHandler();

    const error = makeError("socket hang up");
    const action = await handler.handle("chat-1", error, ctx(1));

    expect(action.type).toBe("retry");
  });

  it("should reply on timeout at attempt 2", async () => {
    const handler = new DefaultErrorHandler();

    const error = makeError("Request timeout");
    const action = await handler.handle("chat-1", error, ctx(2));

    expect(action.type).toBe("reply");
    expect(action.message).toContain("timed out");
  });
});

// ================================================================
// 4. bad input / auth → reply
// ================================================================

describe("DefaultErrorHandler auth errors", () => {
  it("should reply on 401 auth error", async () => {
    const handler = new DefaultErrorHandler();

    const error = makeError("status: 401 Unauthorized");
    const action = await handler.handle("chat-1", error, ctx(1));

    expect(action.type).toBe("reply");
    expect(action.message).toContain("authentication failed");
  });

  it("should reply on 403 forbidden", async () => {
    const handler = new DefaultErrorHandler();

    const error = makeError("status: 403 Forbidden");
    const action = await handler.handle("chat-1", error, ctx(1));

    expect(action.type).toBe("reply");
    expect(action.message).toContain("authentication failed");
  });
});

// ================================================================
// 5. unknown error → reply
// ================================================================

describe("DefaultErrorHandler unknown error", () => {
  it("should reply with error message for unknown errors", async () => {
    const handler = new DefaultErrorHandler();

    const error = makeError("Something went completely wrong");
    const action = await handler.handle("chat-1", error, ctx(1));

    expect(action.type).toBe("reply");
    expect(action.message).toContain("Error processing message");
  });

  it("should truncate long error messages", async () => {
    const handler = new DefaultErrorHandler();

    const longMsg = "A".repeat(200);
    const error = makeError(longMsg);
    const action = await handler.handle("chat-1", error, ctx(1));

    expect(action.type).toBe("reply");
    expect(action.message.length).toBeLessThanOrEqual(150);
  });

  it("should handle empty error message", async () => {
    const handler = new DefaultErrorHandler();

    const error = makeError("");
    const action = await handler.handle("chat-1", error, ctx(1));

    expect(action.type).toBe("reply");
  });
});

// ================================================================
// 6. extractStatusCode tests
// ================================================================

describe("DefaultErrorHandler extractStatusCode", () => {
  it("should extract status from 'status: 429' format", async () => {
    const handler = new DefaultErrorHandler();
    const error = makeError("Request failed: status: 429 Rate limited");
    const action = await handler.handle("chat-1", error, ctx(1));

    // 429 at attempt 1 → retry
    expect(action.type).toBe("retry");
  });

  it("should extract status from '403 ' format", async () => {
    const handler = new DefaultErrorHandler();
    const error = makeError("403 Forbidden access");
    const action = await handler.handle("chat-1", error, ctx(1));

    expect(action.type).toBe("reply");
  });

  it("should use error.status property", async () => {
    const handler = new DefaultErrorHandler();
    const error = new Error("API error");
    (error as any).status = 502;
    const action = await handler.handle("chat-1", error, ctx(1));

    expect(action.type).toBe("retry");
  });

  it("should return 0 when no status code found", async () => {
    const handler = new DefaultErrorHandler();
    const error = makeError("Some random error with no status");
    const action = await handler.handle("chat-1", error, ctx(1));

    // No status → not a retry condition → reply
    expect(action.type).toBe("reply");
  });
});

// ================================================================
// 7. extractRetryAfter tests
// ================================================================

describe("DefaultErrorHandler extractRetryAfter", () => {
  it("should extract retry-after from message", async () => {
    const handler = new DefaultErrorHandler();
    const sleepSpy = mock(async (_ms: number) => {});
    (handler as any).sleep = sleepSpy;

    const error = makeError("status: 429 Retry-After: 5");
    const action = await handler.handle("chat-1", error, ctx(1));

    expect(action.type).toBe("retry");
    expect(sleepSpy).toHaveBeenCalledWith(5000);
  });

  it("should use default 2000ms when no retry-after found", async () => {
    const handler = new DefaultErrorHandler();
    const sleepSpy = mock(async (_ms: number) => {});
    (handler as any).sleep = sleepSpy;

    const error = makeError("status: 429 Rate limited");
    const action = await handler.handle("chat-1", error, ctx(1));

    expect(action.type).toBe("retry");
    expect(sleepSpy).toHaveBeenCalledWith(2000);
  });
});
