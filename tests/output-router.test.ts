/**
 * output-router.test.ts
 *
 * Tests for modules/core/output-router.ts:
 * - isHeartbeatOk 识别 HEARTBEAT_OK
 * - isHeartbeatDuplicate 检测重复回复
 * - filterAndSend 路由逻辑（main/heartbeat/cron）
 */

import { describe, it, expect } from "bun:test";
import { isHeartbeatOk, isHeartbeatOkJson, isHeartbeatDuplicate, filterAndSend } from "../modules/core/output-router";

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
// 1b. isHeartbeatOkJson
// ================================================================

describe("isHeartbeatOkJson", () => {
  it("should match {\"status\": \"ok\"}", () => {
    expect(isHeartbeatOkJson('{"status": "ok"}')).toBe(true);
  });

  it("should match with whitespace", () => {
    expect(isHeartbeatOkJson('  { "status": "ok" }  ')).toBe(true);
  });

  it("should match case-insensitive", () => {
    expect(isHeartbeatOkJson('{"STATUS": "OK"}')).toBe(true);
  });

  it("should reject status: alert", () => {
    expect(isHeartbeatOkJson('{"status": "alert", "message": "error"}')).toBe(false);
  });

  it("should reject extra text", () => {
    expect(isHeartbeatOkJson('{"status": "ok"}\nAll good!')).toBe(false);
  });

  it("should reject plain text", () => {
    expect(isHeartbeatOkJson('全部正常。')).toBe(false);
  });

  it("should reject empty string", () => {
    expect(isHeartbeatOkJson('')).toBe(false);
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

  it("should filter JSON status ok with whitespace", async () => {
    let sent = false;
    const result = filterAndSend('  { "status": "ok" }  ', {
      sessionType: "heartbeat",
      reply: async () => { sent = true; },
    });

    expect(result.shouldSend).toBe(false);
    expect(result.reason).toBe("heartbeat_ok_filtered");
    expect(sent).toBe(false);
  });

  it("should send JSON status alert in heartbeat session", async () => {
    let sent = "";
    const result = filterAndSend('{"status": "alert", "message": "disk full"}', {
      sessionType: "heartbeat",
      reply: async (t: string) => { sent = t; },
    });

    expect(result.shouldSend).toBe(true);
    expect(result.reason).toBe("normal");
    expect(sent).toBe('{"status": "alert", "message": "disk full"}');
  });

  it("should filter short natural language noise (全部正常)", async () => {
    let sent = false;
    const result = filterAndSend("全部正常。", {
      sessionType: "heartbeat",
      reply: async () => { sent = true; },
    });

    expect(result.shouldSend).toBe(false);
    expect(result.reason).toBe("heartbeat_ok_filtered");
    expect(sent).toBe(false);
  });

  it("should filter short noise like OK", async () => {
    let sent = false;
    const result = filterAndSend("OK", {
      sessionType: "heartbeat",
      reply: async () => { sent = true; },
    });

    expect(result.shouldSend).toBe(false);
    expect(result.reason).toBe("heartbeat_ok_filtered");
    expect(sent).toBe(false);
  });

  it("should send longer meaningful text in heartbeat session", async () => {
    let sent = "";
    const result = filterAndSend("Something is wrong with the server, need to check logs", {
      sessionType: "heartbeat",
      reply: async (t: string) => { sent = t; },
    });

    expect(result.shouldSend).toBe(true);
    expect(result.reason).toBe("normal");
    expect(sent).toBe("Something is wrong with the server, need to check logs");
  });

  it("should filter duplicate heartbeat replies", async () => {
    let sent = false;
    const result = filterAndSend("Something unusual here, checking", {
      sessionType: "heartbeat",
      lastHeartbeatText: "Something unusual here, checking",
      reply: async () => { sent = true; },
    });

    expect(result.shouldSend).toBe(false);
    expect(result.reason).toBe("duplicate_filtered");
    expect(sent).toBe(false);
  });

  it("should filter HEARTBEAT_OK in cron session (prevents leak)", async () => {
    let sent = "";
    const result = filterAndSend("HEARTBEAT_OK", {
      sessionType: "cron",
      reply: async (t: string) => { sent = t; },
    });

    expect(result.shouldSend).toBe(false);
    expect(result.reason).toBe("heartbeat_ok_filtered");
    expect(sent).toBe("");
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
