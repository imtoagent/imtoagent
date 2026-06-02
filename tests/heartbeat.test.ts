/**
 * heartbeat.test.ts
 *
 * Tests for heartbeat & cron modules:
 * - isHeartbeatContentEffectivelyEmpty
 * - stripHeartbeatTasksBlock
 * - parseHeartbeatTasks
 * - parseInterval
 * - getPhaseOffset / hashCode
 * - isHeartbeatOk
 * - filterAndSend (output-router)
 */

import { describe, it, expect } from "bun:test";
import {
  isHeartbeatContentEffectivelyEmpty,
  stripHeartbeatTasksBlock,
  parseHeartbeatTasks,
  parseInterval,
  getPhaseOffset,
  hashCode,
  HEARTBEAT_ROUNDS_MAX,
} from "../modules/core/heartbeat";
import { isHeartbeatOk, filterAndSend } from "../modules/core/output-router";

// ================================================================
// isHeartbeatContentEffectivelyEmpty
// ================================================================

describe("isHeartbeatContentEffectivelyEmpty", () => {
  it("returns true for empty string", () => {
    expect(isHeartbeatContentEffectivelyEmpty("")).toBe(true);
  });

  it("returns true for whitespace only", () => {
    expect(isHeartbeatContentEffectivelyEmpty("   \n\n  ")).toBe(true);
  });

  it("returns true for comments only", () => {
    expect(isHeartbeatContentEffectivelyEmpty("# comment\n# another")).toBe(true);
  });

  it("returns false for content with header", () => {
    expect(isHeartbeatContentEffectivelyEmpty("# Heartbeat\n\nCheck system status.")).toBe(false);
  });

  it("returns false for content with tasks", () => {
    const md = `# Heartbeat

## Tasks
- name: disk-check
  interval: 1h
  prompt: "Check disk."`;
    expect(isHeartbeatContentEffectivelyEmpty(md)).toBe(false);
  });

  it("ignores code blocks", () => {
    const md = `# Heartbeat

\`\`\`bash
echo hello
\`\`\``;
    expect(isHeartbeatContentEffectivelyEmpty(md)).toBe(true);
  });

  it("content + code blocks is not empty", () => {
    const md = `# Heartbeat

Check system.

\`\`\`bash
echo hello
\`\`\``;
    expect(isHeartbeatContentEffectivelyEmpty(md)).toBe(false);
  });
});

// ================================================================
// stripHeartbeatTasksBlock
// ================================================================

describe("stripHeartbeatTasksBlock", () => {
  it("removes ## Tasks section", () => {
    const md = `# Heartbeat

Check system status.

## Tasks
- name: disk-check
  interval: 1h
  prompt: "Check disk."

## Other
more content`;
    const result = stripHeartbeatTasksBlock(md);
    expect(result).toContain("Check system status.");
    expect(result).not.toContain("disk-check");
    expect(result).toContain("## Other");
    expect(result).toContain("more content");
  });

  it("removes tasks: YAML style", () => {
    const md = `# Heartbeat

tasks:
- name: disk-check
  interval: 1h
  prompt: "Check disk."`;
    const result = stripHeartbeatTasksBlock(md);
    expect(result).toBe("# Heartbeat");
  });

  it("returns full content when no tasks section", () => {
    const md = `# Heartbeat

Just a heartbeat prompt.`;
    expect(stripHeartbeatTasksBlock(md)).toBe(md);
  });
});

// ================================================================
// parseHeartbeatTasks
// ================================================================

describe("parseHeartbeatTasks", () => {
  it("parses Markdown list style tasks", () => {
    const md = `# Heartbeat

## Tasks
- name: disk-check
  interval: 1h
  prompt: "Check disk usage."
- name: memory-check
  interval: 30m
  prompt: "Check memory."`;
    const tasks = parseHeartbeatTasks(md);
    expect(tasks).toHaveLength(2);
    expect(tasks[0].name).toBe("disk-check");
    expect(tasks[0].interval).toBe("1h");
    expect(tasks[0].prompt).toBe("Check disk usage.");
    expect(tasks[1].name).toBe("memory-check");
    expect(tasks[1].interval).toBe("30m");
  });

  it("parses YAML style tasks", () => {
    const md = `# Heartbeat

tasks:
- name: disk-check
  interval: 1h
  prompt: "Check disk."`;
    const tasks = parseHeartbeatTasks(md);
    expect(tasks).toHaveLength(1);
    expect(tasks[0].name).toBe("disk-check");
  });

  it("returns empty array when no tasks section", () => {
    expect(parseHeartbeatTasks("# Heartbeat\n\nNo tasks here.")).toEqual([]);
  });

  it("skips tasks without interval", () => {
    const md = `## Tasks
- name: no-interval
  prompt: "No interval."`;
    expect(parseHeartbeatTasks(md)).toEqual([]);
  });
});

// ================================================================
// parseInterval
// ================================================================

describe("parseInterval", () => {
  it("parses seconds", () => {
    expect(parseInterval("30s")).toBe(30_000);
    expect(parseInterval("5s")).toBe(5_000);
  });

  it("parses minutes", () => {
    expect(parseInterval("5m")).toBe(5 * 60_000);
    expect(parseInterval("30m")).toBe(30 * 60_000);
  });

  it("parses hours", () => {
    expect(parseInterval("1h")).toBe(3_600_000);
    expect(parseInterval("24h")).toBe(24 * 3_600_000);
  });

  it("parses days", () => {
    expect(parseInterval("1d")).toBe(24 * 3_600_000);
  });

  it("returns null for invalid format", () => {
    expect(parseInterval("invalid")).toBeNull();
    expect(parseInterval("")).toBeNull();
    expect(parseInterval("5")).toBeNull();
    expect(parseInterval("xyz")).toBeNull();
  });
});

// ================================================================
// hashCode & getPhaseOffset
// ================================================================

describe("hashCode & getPhaseOffset", () => {
  it("hashCode returns consistent values", () => {
    const h1 = hashCode("test");
    const h2 = hashCode("test");
    expect(h1).toBe(h2);
  });

  it("hashCode returns different values for different strings", () => {
    expect(hashCode("bot1")).not.toBe(hashCode("bot2"));
  });

  it("getPhaseOffset is consistent for same bot + interval", () => {
    const p1 = getPhaseOffset("CodexBot", 300_000);
    const p2 = getPhaseOffset("CodexBot", 300_000);
    expect(p1).toBe(p2);
  });

  it("getPhaseOffset is within interval range", () => {
    const offset = getPhaseOffset("TestBot", 60_000);
    expect(offset).toBeGreaterThanOrEqual(0);
    expect(offset).toBeLessThan(60_000);
  });

  it("getPhaseOffset differs for different bots", () => {
    const o1 = getPhaseOffset("BotA", 300_000);
    const o2 = getPhaseOffset("BotB", 300_000);
    // They could theoretically collide, but unlikely
    expect(o1).not.toBe(o2);
  });
});

// ================================================================
// HEARTBEAT_ROUNDS_MAX
// ================================================================

describe("HEARTBEAT_ROUNDS_MAX", () => {
  it("is 5", () => {
    expect(HEARTBEAT_ROUNDS_MAX).toBe(5);
  });
});

// ================================================================
// isHeartbeatOk (output-router)
// ================================================================

describe("isHeartbeatOk", () => {
  it("matches exact HEARTBEAT_OK", () => {
    expect(isHeartbeatOk("HEARTBEAT_OK")).toBe(true);
  });

  it("matches case variations", () => {
    expect(isHeartbeatOk("heartbeat_ok")).toBe(true);
    expect(isHeartbeatOk("Heartbeat_OK")).toBe(true);
    expect(isHeartbeatOk("heartbeat ok")).toBe(true);
    expect(isHeartbeatOk("HEARTBEAT OK")).toBe(true);
  });

  it("matches with underscore or space", () => {
    expect(isHeartbeatOk("HEARTBEAT_OK")).toBe(true);
    expect(isHeartbeatOk("HEARTBEAT OK")).toBe(true);
    expect(isHeartbeatOk("HEARTBEAT_OK")).toBe(true);
  });

  it("does not match partial", () => {
    expect(isHeartbeatOk("I said HEARTBEAT_OK already")).toBe(false);
    expect(isHeartbeatOk("HEARTBEAT_OKAY")).toBe(false);
    expect(isHeartbeatOk("All good! HEARTBEAT_OK\nNow continuing...")).toBe(false);
    expect(isHeartbeatOk("prefix\nHEARTBEAT_OK suffix")).toBe(false);
  });

  it("matches HEARTBEAT_OK on its own line", () => {
    expect(isHeartbeatOk("HEARTBEAT_OK")).toBe(true);
    expect(isHeartbeatOk("  heartbeat_ok  ")).toBe(true);
    expect(isHeartbeatOk("HEARTBEAT_OK\n")).toBe(true);
    expect(isHeartbeatOk("prefix\nHEARTBEAT_OK")).toBe(true);
    expect(isHeartbeatOk("HEARTBEAT_OK\nsuffix")).toBe(true);
    expect(isHeartbeatOk("line1\nHEARTBEAT_OK\nline3")).toBe(true);
  });

  it("matches when it is the only content (with whitespace)", () => {
    expect(isHeartbeatOk("  HEARTBEAT_OK  \n")).toBe(true);
  });
});

// ================================================================
// filterAndSend (output-router)
// ================================================================

describe("filterAndSend", () => {
  it("main session always sends", () => {
    let sent = false;
    const result = filterAndSend("Hello", {
      sessionType: "main",
      reply: async () => { sent = true; },
    });
    expect(result.shouldSend).toBe(true);
    expect(result.reason).toBe("normal");
    expect(sent).toBe(true);
  });

  it("heartbeat session filters HEARTBEAT_OK", () => {
    let sent = false;
    const result = filterAndSend("HEARTBEAT_OK", {
      sessionType: "heartbeat",
      reply: async () => { sent = true; },
    });
    expect(result.shouldSend).toBe(false);
    expect(result.reason).toBe("heartbeat_ok_filtered");
    expect(sent).toBe(false);
  });

  it("cron session does NOT filter HEARTBEAT_OK (semantic isolation)", () => {
    let sent = false;
    const result = filterAndSend("heartbeat_ok", {
      sessionType: "cron",
      reply: async () => { sent = true; },
    });
    expect(result.shouldSend).toBe(true);
    expect(result.reason).toBe("normal");
    expect(sent).toBe(true);
  });

  it("heartbeat session sends normal content", () => {
    let sentText = "";
    const result = filterAndSend("System status: all good", {
      sessionType: "heartbeat",
      reply: async (text) => { sentText = text; },
    });
    expect(result.shouldSend).toBe(true);
    expect(result.reason).toBe("normal");
    expect(sentText).toBe("System status: all good");
  });

  it("filters empty text", () => {
    let sent = false;
    const result = filterAndSend("", {
      sessionType: "heartbeat",
      reply: async () => { sent = true; },
    });
    expect(result.shouldSend).toBe(false);
    expect(result.reason).toBe("empty");
  });
});
