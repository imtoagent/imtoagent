/**
 * output-router.test.ts
 *
 * Tests for modules/core/output-router.ts:
 * - isHeartbeatOk 识别 HEARTBEAT_OK
 * - isHeartbeatDuplicate 检测重复回复
 * - filterAndSend 路由逻辑（main/heartbeat/cron）
 */

import { describe, it, expect } from "bun:test";
import { isHeartbeatOk, isHeartbeatDuplicate, filterAndSend } from "../modules/core/output-router";

// ================================================================
// 1. isHeartbeatOk
// ================================================================

describe("isHeartbeatOk", () => {
  it("should match standalone HEARTBEAT_OK", () => {
    expect(isHeartbeatOk("HEARTBEAT_OK")).toBe(true);
  });

  it("should match HEARTBEAT OK (space separator)", () => {
    expect(isHeartbeatOk("HEARTBEAT OK")).toBe(true);
  });

  it("should match lowercase", () => {
    expect(isHeartbeatOk("heartbeat_ok")).toBe(true);
  });

  it("should match with leading/trailing whitespace", () => {
    expect(isHeartbeatOk("\n  HEARTBEAT_OK  \n")).toBe(true);
  });

  it("should match HEARTBEAT_OK in multi-line text", () => {
    expect(isHeartbeatOk("some context\nHEARTBEAT_OK\n")).toBe(true);
  });

  it("should reject text > 300 chars even if it contains HEARTBEAT_OK", () => {
    const longText = "x".repeat(301) + "\nHEARTBEAT_OK";
    expect(isHeartbeatOk(longText)).toBe(false);
  });

  it("should reject when HEARTBEAT_OK is part of a sentence", () => {
    // HEARTBEAT_OK not on its own line
    expect(isHeartbeatOk("The HEARTBEAT_OK status is fine")).toBe(false);
  });

  it("should reject empty string", () => {
    expect(isHeartbeatOk("")).toBe(false);
  });

  it("should reject when content is HEARTBEAT_OK plus too much other text", () => {
    const text = "HEARTBEAT_OK\n" + "important update: ".repeat(20);
    expect(isHeartbeatOk(text)).toBe(false);
  });

  it("should accept HEARTBEAT_OK with small prefix", () => {
    expect(isHeartbeatOk("OK\nHEARTBEAT_OK")).toBe(true);
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

  it("should send normal text in heartbeat session", async () => {
    let sent = "";
    const result = filterAndSend("Something is wrong", {
      sessionType: "heartbeat",
      reply: async (t: string) => { sent = t; },
    });

    expect(result.shouldSend).toBe(true);
    expect(result.reason).toBe("normal");
    expect(sent).toBe("Something is wrong");
  });

  it("should filter duplicate heartbeat replies", async () => {
    let sent = false;
    const result = filterAndSend("All good", {
      sessionType: "heartbeat",
      lastHeartbeatText: "All good",
      reply: async () => { sent = true; },
    });

    expect(result.shouldSend).toBe(false);
    expect(result.reason).toBe("duplicate_filtered");
    expect(sent).toBe(false);
  });

  it("should not filter HEARTBEAT_OK in cron session", async () => {
    let sent = "";
    const result = filterAndSend("HEARTBEAT_OK", {
      sessionType: "cron",
      reply: async (t: string) => { sent = t; },
    });

    expect(result.shouldSend).toBe(true);
    expect(sent).toBe("HEARTBEAT_OK");
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
