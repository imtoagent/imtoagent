/**
 * proxy-circuit-breaker.test.ts
 *
 * Tests for CircuitBreaker and CircuitBreakerManager:
 * - Initial state closed
 * - Consecutive failures → open
 * - Recovery timeout → half-open
 * - Half-open success → closed
 * - Half-open failure → open
 * - Open state rejects requests
 * - Manual reset
 * - Manager findAvailable / healthStatus
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  CircuitBreaker,
  CircuitBreakerManager,
  type CircuitState,
} from "../modules/proxy/circuit-breaker";

// ================================================================
// Helpers
// ================================================================

function makeBreaker(
  name = "test",
  opts?: { failureThreshold?: number; recoveryTimeout?: number },
) {
  return new CircuitBreaker(name, opts);
}

// ================================================================
// 1. Initial state
// ================================================================

describe("CircuitBreaker initial state", () => {
  it("should start in CLOSED state", () => {
    const cb = makeBreaker();
    expect(cb.state).toBe("CLOSED");
  });

  it("should allow requests when closed", () => {
    const cb = makeBreaker();
    expect(cb.canRequest()).toBe(true);
  });

  it("should have zero failures initially", () => {
    const cb = makeBreaker();
    const stats = cb.getStats();
    expect(stats.failures).toBe(0);
    expect(stats.totalTrips).toBe(0);
    expect(stats.state).toBe("CLOSED");
  });
});

// ================================================================
// 2. Consecutive failures → OPEN
// ================================================================

describe("CircuitBreaker CLOSED → OPEN", () => {
  it("should open after reaching failure threshold (default 3)", () => {
    const cb = makeBreaker();
    cb.recordFailure();
    expect(cb.state).toBe("CLOSED");
    cb.recordFailure();
    expect(cb.state).toBe("CLOSED");
    cb.recordFailure();
    expect(cb.state).toBe("OPEN");
  });

  it("should reject requests when open", () => {
    const cb = makeBreaker();
    cb.recordFailure();
    cb.recordFailure();
    cb.recordFailure();
    expect(cb.canRequest()).toBe(false);
  });

  it("should use custom failureThreshold", () => {
    const cb = makeBreaker("test", { failureThreshold: 2 });
    cb.recordFailure();
    expect(cb.state).toBe("CLOSED");
    cb.recordFailure();
    expect(cb.state).toBe("OPEN");
  });

  it("should increment totalTrips when opening", () => {
    const cb = makeBreaker();
    cb.recordFailure();
    cb.recordFailure();
    cb.recordFailure();
    expect(cb.getStats().totalTrips).toBe(1);
  });

  it("should not trip again until recovered", () => {
    const cb = makeBreaker("test", { failureThreshold: 2 });
    cb.recordFailure();
    cb.recordFailure();
    const trips1 = cb.getStats().totalTrips;
    // Still open, more failures don't trip again
    cb.recordFailure();
    cb.recordFailure();
    expect(cb.getStats().totalTrips).toBe(trips1);
  });
});

// ================================================================
// 3. OPEN → HALF_OPEN after recovery timeout
// ================================================================

describe("CircuitBreaker OPEN → HALF_OPEN", () => {
  it("should transition to HALF_OPEN after recoveryTimeout", () => {
    const cb = makeBreaker("test", {
      failureThreshold: 2,
      recoveryTimeout: 50, // 50ms for fast test
    });
    cb.recordFailure();
    cb.recordFailure();
    expect(cb.state).toBe("OPEN");

    // Wait for recovery timeout
    const start = Date.now();
    while (Date.now() - start < 60) {
      // busy wait
    }

    expect(cb.state).toBe("HALF_OPEN");
  });

  it("should not transition before recoveryTimeout", () => {
    const cb = makeBreaker("test", {
      failureThreshold: 2,
      recoveryTimeout: 10000, // 10s — won't expire during test
    });
    cb.recordFailure();
    cb.recordFailure();
    expect(cb.state).toBe("OPEN");
  });
});

// ================================================================
// 4. HALF_OPEN success → CLOSED
// ================================================================

describe("CircuitBreaker HALF_OPEN → CLOSED", () => {
  it("should close on success in half-open", () => {
    const cb = makeBreaker("test", {
      failureThreshold: 2,
      recoveryTimeout: 50,
    });
    cb.recordFailure();
    cb.recordFailure();

    // Trigger transition
    const start = Date.now();
    while (Date.now() - start < 60) {}

    expect(cb.state).toBe("HALF_OPEN");
    cb.recordSuccess();
    expect(cb.state).toBe("CLOSED");
  });

  it("should reset failure count on recovery", () => {
    const cb = makeBreaker("test", {
      failureThreshold: 2,
      recoveryTimeout: 50,
    });
    cb.recordFailure();
    cb.recordFailure();
    const start = Date.now();
    while (Date.now() - start < 60) {}
    // Access state getter to trigger OPEN → HALF_OPEN auto-transition
    expect(cb.state).toBe("HALF_OPEN");
    cb.recordSuccess();
    expect(cb.getStats().failures).toBe(0);
  });

  it("should allow requests again after recovery", () => {
    const cb = makeBreaker("test", {
      failureThreshold: 2,
      recoveryTimeout: 50,
    });
    cb.recordFailure();
    cb.recordFailure();
    const start = Date.now();
    while (Date.now() - start < 60) {}
    cb.recordSuccess();
    expect(cb.canRequest()).toBe(true);
  });
});

// ================================================================
// 5. HALF_OPEN failure → OPEN
// ================================================================

describe("CircuitBreaker HALF_OPEN → OPEN", () => {
  it("should reopen on failure in half-open", () => {
    const cb = makeBreaker("test", {
      failureThreshold: 2,
      recoveryTimeout: 50,
    });
    cb.recordFailure();
    cb.recordFailure();

    const start = Date.now();
    while (Date.now() - start < 60) {}

    expect(cb.state).toBe("HALF_OPEN");
    cb.recordFailure();
    expect(cb.state).toBe("OPEN");
  });

  it("should increment totalTrips when reopening", () => {
    const cb = makeBreaker("test", {
      failureThreshold: 2,
      recoveryTimeout: 50,
    });
    cb.recordFailure();
    cb.recordFailure();
    const start = Date.now();
    while (Date.now() - start < 60) {}
    // Access state getter to trigger OPEN → HALF_OPEN auto-transition
    expect(cb.state).toBe("HALF_OPEN");
    cb.recordFailure();
    expect(cb.getStats().totalTrips).toBe(2);
  });
});

// ================================================================
// 6. Success in CLOSED resets failures
// ================================================================

describe("CircuitBreaker success in CLOSED", () => {
  it("should reset failure count on success", () => {
    const cb = makeBreaker();
    cb.recordFailure();
    cb.recordFailure();
    expect(cb.getStats().failures).toBe(2);
    cb.recordSuccess();
    expect(cb.getStats().failures).toBe(0);
  });

  it("should not trip after success resets counter", () => {
    const cb = makeBreaker("test", { failureThreshold: 3 });
    cb.recordFailure();
    cb.recordFailure();
    cb.recordSuccess(); // resets to 0
    cb.recordFailure();
    cb.recordFailure();
    expect(cb.state).toBe("CLOSED"); // only 2 failures since reset
  });
});

// ================================================================
// 7. Manual reset
// ================================================================

describe("CircuitBreaker manual reset", () => {
  it("should reset to CLOSED from any state", () => {
    const cb = makeBreaker();
    cb.recordFailure();
    cb.recordFailure();
    cb.recordFailure();
    expect(cb.state).toBe("OPEN");
    cb.reset();
    expect(cb.state).toBe("CLOSED");
    expect(cb.getStats().failures).toBe(0);
  });

  it("should allow requests after reset", () => {
    const cb = makeBreaker();
    cb.recordFailure();
    cb.recordFailure();
    cb.recordFailure();
    cb.reset();
    expect(cb.canRequest()).toBe(true);
  });
});

// ================================================================
// 8. HALF_OPEN request limiting
// ================================================================

describe("CircuitBreaker halfOpenMaxRequests", () => {
  it("should limit requests in half-open", () => {
    const cb = makeBreaker("test", {
      failureThreshold: 2,
      recoveryTimeout: 50,
      halfOpenMaxRequests: 1,
    });
    cb.recordFailure();
    cb.recordFailure();

    const start = Date.now();
    while (Date.now() - start < 60) {}

    expect(cb.state).toBe("HALF_OPEN");
    expect(cb.canRequest()).toBe(true); // first allowed
    // After using the one allowed request
    cb.recordSuccess();
    expect(cb.state).toBe("CLOSED");
  });
});

// ================================================================
// 9. CircuitBreakerManager
// ================================================================

describe("CircuitBreakerManager", () => {
  it("should create and retrieve breakers", () => {
    const mgr = new CircuitBreakerManager();
    const cb = mgr.create("provider-a", { failureThreshold: 2 });
    expect(cb).toBeDefined();
    expect(mgr.get("provider-a")).toBe(cb);
  });

  it("should return undefined for unknown breaker", () => {
    const mgr = new CircuitBreakerManager();
    expect(mgr.get("nonexistent")).toBeUndefined();
  });

  it("findAvailable should return first non-open breaker", () => {
    const mgr = new CircuitBreakerManager();
    mgr.create("a");
    mgr.create("b");
    mgr.create("c");

    // Trip breaker "a"
    const ba = mgr.get("a")!;
    ba.recordFailure();
    ba.recordFailure();
    ba.recordFailure();

    expect(mgr.findAvailable(["a", "b", "c"])).toBe("b");
  });

  it("findAvailable should return null when all open", () => {
    const mgr = new CircuitBreakerManager();
    mgr.create("a");
    mgr.create("b");

    mgr.get("a")!.recordFailure();
    mgr.get("a")!.recordFailure();
    mgr.get("a")!.recordFailure();

    mgr.get("b")!.recordFailure();
    mgr.get("b")!.recordFailure();
    mgr.get("b")!.recordFailure();

    expect(mgr.findAvailable(["a", "b"])).toBeNull();
  });

  it("healthStatus should return stats for all breakers", () => {
    const mgr = new CircuitBreakerManager();
    mgr.create("a");
    mgr.create("b");

    mgr.get("a")!.recordFailure();

    const status = mgr.healthStatus();
    expect(status["a"]).toBeDefined();
    expect(status["b"]).toBeDefined();
    expect(status["a"].failures).toBe(1);
    expect(status["b"].failures).toBe(0);
  });
});
