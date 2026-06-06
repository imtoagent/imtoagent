/**
 * output-router.test.ts
 *
 * Tests for modules/core/output-router.ts:
 * - isHeartbeatDuplicate 检测重复回复
 * - filterAndSend 路由逻辑（main/heartbeat/cron）
 */

import { describe, it, expect } from 'vitest';
import { isHeartbeatOk, isHeartbeatDuplicate, filterAndSend } from "../modules/core/output-router";

// ================================================================
// 1. isHeartbeatOk (实际行为：≤300 字符且 HEARTBEAT_OK 独占一行时返回 true)
// ================================================================

describe("isHeartbeatOk", () => {
  it("should return true for HEARTBEAT_OK standalone", () => {
    expect(isHeartbeatOk("HEARTBEAT_OK")).toBe(true);
    expect(isHeartbeatOk("HEARTBEAT OK")).toBe(true);
    expect(isHeartbeatOk("heartbeat_ok")).toBe(true);
    expect(isHeartbeatOk("\n  HEARTBEAT_OK  \n")).toBe(true);
  });
  it("should return false for empty or long text", () => {
    expect(isHeartbeatOk("")).toBe(false);
    expect(isHeartbeatOk("some text")).toBe(false);
    expect(isHeartbeatOk("a".repeat(301))).toBe(false);
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
  // 实际行为：heartbeat session 会过滤 HEARTBEAT_OK 和短噪音

  it("should filter HEARTBEAT_OK in heartbeat session", async () => {
    let sent = false;
    const result = filterAndSend("HEARTBEAT_OK", {
      sessionType: "heartbeat",
      reply: async () => { sent = true; },
    });

    expect(result.shouldSend).toBe(false);
    expect(result.reason).toBe("heartbeat_ok_filtered");
    expect(sent).toBe(false);
  });

  it("should filter JSON status ok in heartbeat session", async () => {
    let sent = false;
    const result = filterAndSend('{"status": "ok"}', {
      sessionType: "heartbeat",
      reply: async () => { sent = true; },
    });

    expect(result.shouldSend).toBe(false);
    expect(result.reason).toBe("heartbeat_ok_filtered");
    expect(sent).toBe(false);
  });

  it("should filter short noise like 全部正常 in heartbeat session", async () => {
    let sent = false;
    const result = filterAndSend("全部正常。", {
      sessionType: "heartbeat",
      reply: async () => { sent = true; },
    });

    expect(result.shouldSend).toBe(false);
    expect(result.reason).toBe("heartbeat_ok_filtered");
    expect(sent).toBe(false);
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
