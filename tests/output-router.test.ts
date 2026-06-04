/**
 * output-router.test.ts
 *
 * Tests for modules/core/output-router.ts:
 * - isHeartbeatDuplicate 检测重复回复
 * - filterAndSend 路由逻辑（main/heartbeat/cron）
 */

import { describe, it, expect } from "bun:test";
import { isHeartbeatOk, isHeartbeatDuplicate, filterAndSend } from "../modules/core/output-router";

// ================================================================
// 1. isHeartbeatOk (Phase 1 重构后始终返回 false)
// ================================================================

describe("isHeartbeatOk", () => {
  it("should always return false after Phase 1 refactoring", () => {
    expect(isHeartbeatOk("HEARTBEAT_OK")).toBe(false);
    expect(isHeartbeatOk("HEARTBEAT OK")).toBe(false);
    expect(isHeartbeatOk("heartbeat_ok")).toBe(false);
    expect(isHeartbeatOk("\n  HEARTBEAT_OK  \n")).toBe(false);
    expect(isHeartbeatOk("")).toBe(false);
    expect(isHeartbeatOk("some text")).toBe(false);
  });
});

// ================================================================
// 2. isHeartbeatDuplicate
// ================================================================

describe("isHeartbeatDuplicate", () => {
  it("should detect exact duplicate", () => {
    expect(isHeartbeatDuplicate("Hello world", "Hello world")).toBe(true);
  });

  it("should ignore whitespace differences", () => {
    expect(isHeartbeatDuplicate("  Hello  ", "Hello")).toBe(true);
  });

  it("should return false for different text", () => {
    expect(isHeartbeatDuplicate("Hello", "World")).toBe(false);
  });

  it("should return false when previous is undefined", () => {
    expect(isHeartbeatDuplicate("Hello", undefined)).toBe(false);
  });

  it("should return false when previous is empty string", () => {
    expect(isHeartbeatDuplicate("Hello", "")).toBe(false);
  });
});

// ================================================================
// 3. filterAndSend
// ================================================================

describe("filterAndSend main session", () => {
  it("should always send in main session", async () => {
    let sent = "";
    const result = filterAndSend("Hello", {
      sessionType: "main",
      reply: async (t: string) => { sent = t; },
    });

    expect(result.shouldSend).toBe(true);
    expect(result.reason).toBe("normal");
    expect(sent).toBe("Hello");
  });

  it("should send even HEARTBEAT_OK in main session", async () => {
    let sent = "";
    const result = filterAndSend("HEARTBEAT_OK", {
      sessionType: "main",
      reply: async (t: string) => { sent = t; },
    });

    expect(result.shouldSend).toBe(true);
    expect(sent).toBe("HEARTBEAT_OK");
  });
});

describe("filterAndSend heartbeat session", () => {
  // Phase 1 重构后：heartbeat session 不再过滤 HEARTBEAT_OK，直接发送

  it("should send HEARTBEAT_OK in heartbeat session (no longer filtered)", async () => {
    let sent = "";
    const result = filterAndSend("HEARTBEAT_OK", {
      sessionType: "heartbeat",
      reply: async (t: string) => { sent = t; },
    });

    expect(result.shouldSend).toBe(true);
    expect(result.reason).toBe("normal");
    expect(sent).toBe("HEARTBEAT_OK");
  });

  it("should send JSON status ok in heartbeat session (no longer filtered)", async () => {
    let sent = "";
    const result = filterAndSend('{"status": "ok"}', {
      sessionType: "heartbeat",
      reply: async (t: string) => { sent = t; },
    });

    expect(result.shouldSend).toBe(true);
    expect(result.reason).toBe("normal");
    expect(sent).toBe('{"status": "ok"}');
  });

  it("should send short text like 全部正常 (no longer filtered)", async () => {
    let sent = "";
    const result = filterAndSend("全部正常。", {
      sessionType: "heartbeat",
      reply: async (t: string) => { sent = t; },
    });

    expect(result.shouldSend).toBe(true);
    expect(result.reason).toBe("normal");
    expect(sent).toBe("全部正常。");
  });

  it("should filter duplicates in heartbeat session", async () => {
    let sent = false;
    const result = filterAndSend("Same message", {
      sessionType: "heartbeat",
      lastHeartbeatText: "Same message",
      reply: async () => { sent = true; },
    });

    expect(result.shouldSend).toBe(false);
    expect(result.reason).toBe("duplicate_filtered");
    expect(sent).toBe(false);
  });

  it("should filter empty string in heartbeat session", async () => {
    let sent = false;
    const result = filterAndSend("", {
      sessionType: "heartbeat",
      reply: async () => { sent = true; },
    });

    expect(result.shouldSend).toBe(false);
    expect(result.reason).toBe("empty");
    expect(sent).toBe(false);
  });

  it("should filter whitespace-only text in heartbeat session", async () => {
    let sent = false;
    const result = filterAndSend("   \n  ", {
      sessionType: "heartbeat",
      reply: async () => { sent = true; },
    });

    expect(result.shouldSend).toBe(false);
    expect(result.reason).toBe("empty");
  });
});

describe("filterAndSend empty text", () => {
  it("should filter empty string", async () => {
    let sent = false;
    const result = filterAndSend("", {
      sessionType: "cron",
      reply: async () => { sent = true; },
    });

    expect(result.shouldSend).toBe(false);
    expect(result.reason).toBe("empty");
    expect(sent).toBe(false);
  });

  it("should filter whitespace-only text", async () => {
    let sent = false;
    const result = filterAndSend("   \n  ", {
      sessionType: "cron",
      reply: async () => { sent = true; },
    });

    expect(result.shouldSend).toBe(false);
    expect(result.reason).toBe("empty");
  });
});

describe("filterAndSend cron session", () => {
  it("should send normal text in cron session", async () => {
    let sent = "";
    const result = filterAndSend("Task completed", {
      sessionType: "cron",
      reply: async (t: string) => { sent = t; },
    });

    expect(result.shouldSend).toBe(true);
    expect(result.reason).toBe("normal");
    expect(sent).toBe("Task completed");
  });

  it("should filter duplicates in cron session", async () => {
    let sent = false;
    const result = filterAndSend("Status update", {
      sessionType: "cron",
      lastHeartbeatText: "Status update",
      reply: async () => { sent = true; },
    });

    expect(result.shouldSend).toBe(false);
    expect(result.reason).toBe("duplicate_filtered");
  });
});
