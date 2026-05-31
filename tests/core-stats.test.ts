/**
 * core-stats.test.ts
 *
 * Tests for StatsTracker (modules/core/stats.ts):
 * - resetForCall 重置
 * - accumulate 累加 tokens/cost/duration
 * - formatSummary 格式化输出
 * - 多轮次累加准确
 */

import { describe, it, expect } from "bun:test";
import { DefaultStatsTracker } from "../modules/core/stats";
import type { Session } from "../modules/core/types";

// ================================================================
// Helpers
// ================================================================

function createSession(overrides: Partial<Session> = {}): Session {
  return {
    chatId: "chat-1",
    userId: "user-1",
    startFresh: false,
    metadata: {},
    stats: {
      calls: 0,
      totalTurns: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalCostUSD: 0,
      totalDurationMs: 0,
    },
    lastUsed: Date.now(),
    running: false,
    recentMessages: [],
    ...overrides,
  };
}

// ================================================================
// 1. resetForCall — 重置
// ================================================================

describe("StatsTracker resetForCall", () => {
  it("should increment calls count", () => {
    const tracker = new DefaultStatsTracker();
    const session = createSession();

    tracker.resetForCall(session);
    expect(session.stats.calls).toBe(1);

    tracker.resetForCall(session);
    expect(session.stats.calls).toBe(2);
  });

  it("should not reset accumulated totals", () => {
    const tracker = new DefaultStatsTracker();
    const session = createSession();
    session.stats.totalInputTokens = 500;
    session.stats.totalCostUSD = 0.05;

    tracker.resetForCall(session);

    expect(session.stats.calls).toBe(1);
    expect(session.stats.totalInputTokens).toBe(500);
    expect(session.stats.totalCostUSD).toBe(0.05);
  });
});

// ================================================================
// 2. accumulate — 累加
// ================================================================

describe("StatsTracker accumulate", () => {
  it("should accumulate tokens correctly", () => {
    const tracker = new DefaultStatsTracker();
    const session = createSession();

    tracker.accumulate(session, {
      inputTokens: 100,
      outputTokens: 200,
      costUSD: 0.01,
      durationMs: 500,
      numTurns: 2,
    });

    expect(session.stats.totalInputTokens).toBe(100);
    expect(session.stats.totalOutputTokens).toBe(200);
    expect(session.stats.totalCostUSD).toBe(0.01);
    expect(session.stats.totalDurationMs).toBe(500);
    expect(session.stats.totalTurns).toBe(2);
  });

  it("should handle undefined optional fields", () => {
    const tracker = new DefaultStatsTracker();
    const session = createSession();

    tracker.accumulate(session, {
      inputTokens: 50,
      outputTokens: 75,
    });

    expect(session.stats.totalInputTokens).toBe(50);
    expect(session.stats.totalOutputTokens).toBe(75);
    expect(session.stats.totalCostUSD).toBe(0);
    expect(session.stats.totalDurationMs).toBe(0);
    expect(session.stats.totalTurns).toBe(0);
  });

  it("should update lastUsed timestamp", () => {
    const tracker = new DefaultStatsTracker();
    const session = createSession();
    const beforeLastUsed = session.lastUsed;

    // Simulate time passing
    session.lastUsed = beforeLastUsed - 10_000;

    tracker.accumulate(session, {
      inputTokens: 10,
      outputTokens: 20,
    });

    expect(session.lastUsed).toBeGreaterThanOrEqual(beforeLastUsed);
  });
});

// ================================================================
// 3. formatSummary — 格式化输出
// ================================================================

describe("StatsTracker formatSummary", () => {
  it("should show calls count", () => {
    const tracker = new DefaultStatsTracker();
    const session = createSession();
    session.stats.calls = 5;

    const summary = tracker.formatSummary(session);
    expect(summary).toContain("5 calls");
  });

  it("should show token count in K format", () => {
    const tracker = new DefaultStatsTracker();
    const session = createSession();
    session.stats.totalInputTokens = 5_000;
    session.stats.totalOutputTokens = 3_000;

    const summary = tracker.formatSummary(session);
    expect(summary).toContain("Token");
    expect(summary).toContain("8.0K");
  });

  it("should show token count in M format", () => {
    const tracker = new DefaultStatsTracker();
    const session = createSession();
    session.stats.totalInputTokens = 500_000;
    session.stats.totalOutputTokens = 600_000;

    const summary = tracker.formatSummary(session);
    expect(summary).toContain("1.1M");
  });

  it("should show cost when > 0", () => {
    const tracker = new DefaultStatsTracker();
    const session = createSession();
    session.stats.totalCostUSD = 0.1234;

    const summary = tracker.formatSummary(session);
    expect(summary).toContain("$0.1234");
  });

  it("should not show cost when 0", () => {
    const tracker = new DefaultStatsTracker();
    const session = createSession();

    const summary = tracker.formatSummary(session);
    expect(summary).not.toContain("Cost");
  });

  it("should format duration in seconds", () => {
    const tracker = new DefaultStatsTracker();
    const session = createSession();
    session.stats.totalDurationMs = 5000;

    const summary = tracker.formatSummary(session);
    expect(summary).toContain("5s");
  });

  it("should format duration in minutes", () => {
    const tracker = new DefaultStatsTracker();
    const session = createSession();
    session.stats.totalDurationMs = 120_000;

    const summary = tracker.formatSummary(session);
    expect(summary).toContain("2.0m");
  });

  it("should format duration in hours", () => {
    const tracker = new DefaultStatsTracker();
    const session = createSession();
    session.stats.totalDurationMs = 7_200_000;

    const summary = tracker.formatSummary(session);
    expect(summary).toContain("2.0h");
  });

  it("should omit tokens/cost/duration when zero", () => {
    const tracker = new DefaultStatsTracker();
    const session = createSession();
    session.stats.calls = 1;

    const summary = tracker.formatSummary(session);
    expect(summary).toBe("📊 1 calls");
  });
});

// ================================================================
// 4. 多轮次累加准确
// ================================================================

describe("StatsTracker multi-round accumulation", () => {
  it("should accurately accumulate across multiple rounds", () => {
    const tracker = new DefaultStatsTracker();
    const session = createSession();

    // Round 1
    tracker.resetForCall(session);
    tracker.accumulate(session, {
      inputTokens: 100,
      outputTokens: 200,
      costUSD: 0.01,
      durationMs: 500,
      numTurns: 2,
    });

    // Round 2
    tracker.resetForCall(session);
    tracker.accumulate(session, {
      inputTokens: 150,
      outputTokens: 300,
      costUSD: 0.02,
      durationMs: 800,
      numTurns: 3,
    });

    // Round 3
    tracker.resetForCall(session);
    tracker.accumulate(session, {
      inputTokens: 50,
      outputTokens: 100,
      costUSD: 0.005,
      durationMs: 300,
      numTurns: 1,
    });

    expect(session.stats.calls).toBe(3);
    expect(session.stats.totalInputTokens).toBe(300);
    expect(session.stats.totalOutputTokens).toBe(600);
    expect(session.stats.totalCostUSD).toBeCloseTo(0.035, 10);
    expect(session.stats.totalDurationMs).toBe(1600);
    expect(session.stats.totalTurns).toBe(6);
  });

  it("should handle zero tokens gracefully", () => {
    const tracker = new DefaultStatsTracker();
    const session = createSession();

    tracker.resetForCall(session);
    tracker.accumulate(session, {
      inputTokens: 0,
      outputTokens: 0,
    });

    expect(session.stats.totalInputTokens).toBe(0);
    expect(session.stats.totalOutputTokens).toBe(0);
    expect(session.stats.calls).toBe(1);
  });
});
