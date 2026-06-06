/**
 * core-session.test.ts
 *
 * Tests for FileSessionManager (modules/core/session.ts):
 * - getOrCreate 创建新 session（默认值正确）
 * - getOrCreate 返回已有 session
 * - persist 写入磁盘（JSON valid）
 * - delete 删除
 * - cleanupIdle 清理空闲
 * - listActive 列出活跃
 * - 兼容旧 .memory.json 格式
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from "fs";
import * as path from "path";
import { FileSessionManager } from "../modules/core/session";
import { resetPathCache } from "../modules/utils/paths";

// ================================================================
// Helpers
// ================================================================

function createTempDir(): string {
  return fs.mkdtempSync(path.join(fs.realpathSync("/tmp"), "imto-test-"));
}

function cleanupDir(dir: string) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {}
}

/**
 * Set up a temp dir that will be picked up by getDataDir().
 * We must place a config.json so the path resolver selects this dir
 * over ~/.imtoagent.
 */
function setupTempHome(): { tmpDir: string } {
  const tmpDir = createTempDir();
  // Place a config.json so getDataDir() picks this directory
  fs.writeFileSync(
    path.join(tmpDir, "config.json"),
    JSON.stringify({ bots: [] }),
  );
  process.env.IMTOAGENT_HOME = tmpDir;
  resetPathCache();
  return { tmpDir };
}

function teardown(tmpDir: string) {
  cleanupDir(tmpDir);
  delete process.env.IMTOAGENT_HOME;
  resetPathCache();
}

// ================================================================
// 1. getOrCreate — 创建新 session
// ================================================================

describe("FileSessionManager getOrCreate — create new", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = setupTempHome().tmpDir;
  });

  afterEach(() => teardown(tmpDir));

  it("should create new session with correct defaults", async () => {
    const manager = new FileSessionManager();
    const session = await manager.getOrCreate("testbot", "chat-1", "user-1");

    expect(session.chatId).toBe("chat-1");
    expect(session.userId).toBe("user-1");
    expect(session.startFresh).toBe(false);
    expect(session.backendSessionId).toBeUndefined();
    expect(session.metadata).toEqual({});
    expect(session.running).toBe(false);
    expect(session.recentMessages).toEqual([]);
    expect(session.stats.calls).toBe(0);
    expect(session.stats.totalInputTokens).toBe(0);
    expect(session.stats.totalOutputTokens).toBe(0);
    expect(session.stats.totalCostUSD).toBe(0);
    expect(session.stats.totalDurationMs).toBe(0);
    expect(session.stats.totalTurns).toBe(0);
    expect(session.lastUsed).toBeGreaterThan(0);
  });

  it("should create separate sessions for different chatIds", async () => {
    const manager = new FileSessionManager();
    const s1 = await manager.getOrCreate("testbot", "chat-1", "user-1");
    const s2 = await manager.getOrCreate("testbot", "chat-2", "user-1");

    expect(s1.chatId).toBe("chat-1");
    expect(s2.chatId).toBe("chat-2");
    expect(s1).not.toBe(s2);
  });
});

// ================================================================
// 2. getOrCreate — 返回已有 session
// ================================================================

describe("FileSessionManager getOrCreate — return existing", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = setupTempHome().tmpDir;
  });

  afterEach(() => teardown(tmpDir));

  it("should return cached session on second call", async () => {
    const manager = new FileSessionManager();
    const s1 = await manager.getOrCreate("testbot", "chat-1", "user-1");
    const s2 = await manager.getOrCreate("testbot", "chat-1", "user-1");

    expect(s1).toBe(s2);
  });

  it("should update lastUsed on each call", async () => {
    const manager = new FileSessionManager();
    const s1 = await manager.getOrCreate("testbot", "chat-1", "user-1");
    const beforeLastUsed = s1.lastUsed;

    await new Promise((r) => setTimeout(r, 10));

    const s2 = await manager.getOrCreate("testbot", "chat-1", "user-1");
    expect(s2.lastUsed).toBeGreaterThanOrEqual(beforeLastUsed);
  });
});

// ================================================================
// 3. persist — 写入磁盘
// ================================================================

describe("FileSessionManager persist", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = setupTempHome().tmpDir;
  });

  afterEach(() => teardown(tmpDir));

  it("should write valid JSON to disk", async () => {
    const manager = new FileSessionManager();
    const session = await manager.getOrCreate("testbot", "chat-1", "user-1");
    session.metadata.customKey = "customValue";

    manager.persist("testbot", session);

    const sessionsDir = path.join(tmpDir, "sessions", "testbot");
    const filePath = path.join(sessionsDir, "chat-1.memory.json");
    expect(fs.existsSync(filePath)).toBe(true);

    const raw = fs.readFileSync(filePath, "utf-8");
    const data = JSON.parse(raw);
    expect(data.chatId).toBe("chat-1");
    expect(data.userId).toBe("user-1");
    expect(data.metadata.customKey).toBe("customValue");
  });

  it("should include backward-compatible top-level fields", async () => {
    const manager = new FileSessionManager();
    const session = await manager.getOrCreate("testbot", "chat-1", "user-1");
    session.metadata.sdkSessionId = "sdk-123";
    session.metadata.codexThreadId = "codex-456";

    manager.persist("testbot", session);

    const filePath = path.join(
      tmpDir,
      "sessions",
      "testbot",
      "chat-1.memory.json",
    );
    const data = JSON.parse(fs.readFileSync(filePath, "utf-8"));

    expect(data.sdkSessionId).toBe("sdk-123");
    expect(data.codexThreadId).toBe("codex-456");
    expect(data.metadata.sdkSessionId).toBe("sdk-123");
  });
});

// ================================================================
// 4. delete — 删除
// ================================================================

describe("FileSessionManager delete", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = setupTempHome().tmpDir;
  });

  afterEach(() => teardown(tmpDir));

  it("should remove from cache and delete file", async () => {
    const manager = new FileSessionManager();
    const session = await manager.getOrCreate("testbot", "chat-1", "user-1");
    manager.persist("testbot", session);

    const filePath = path.join(
      tmpDir,
      "sessions",
      "testbot",
      "chat-1.memory.json",
    );
    expect(fs.existsSync(filePath)).toBe(true);

    manager.delete("testbot", "chat-1");

    expect(fs.existsSync(filePath)).toBe(false);

    // After delete, getOrCreate should create a new session
    const newSession = await manager.getOrCreate("testbot", "chat-1", "user-1");
    expect(newSession.stats.calls).toBe(0);
  });

  it("should not crash when deleting non-existent session", () => {
    const manager = new FileSessionManager();
    manager.delete("testbot", "non-existent");
    // no crash
  });
});

// ================================================================
// 5. cleanupIdle — 清理空闲
// ================================================================

describe("FileSessionManager cleanupIdle", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = setupTempHome().tmpDir;
  });

  afterEach(() => teardown(tmpDir));

  it("should remove sessions idle longer than timeout", async () => {
    const manager = new FileSessionManager();
    await manager.getOrCreate("testbot", "chat-1", "user-1");
    await manager.getOrCreate("testbot", "chat-2", "user-1");

    const activeBefore = manager.listActive("testbot");
    expect(activeBefore.length).toBe(2);

    // Manually set lastUsed to 10 seconds ago so they appear idle
    for (const s of activeBefore) {
      s.lastUsed = Date.now() - 10_000;
    }

    // cleanupIdle with 5 second timeout → should remove both
    manager.cleanupIdle("testbot", 5_000);

    const activeAfter = manager.listActive("testbot");
    expect(activeAfter.length).toBe(0);
  });

  it("should not remove running sessions", async () => {
    const manager = new FileSessionManager();
    const s1 = await manager.getOrCreate("testbot", "chat-1", "user-1");
    s1.running = true; // mark as running

    // Set lastUsed to 10 seconds ago
    s1.lastUsed = Date.now() - 10_000;

    manager.cleanupIdle("testbot", 0); // 0 timeout = remove all idle

    const active = manager.listActive("testbot");
    expect(active.length).toBe(1);
    expect(active[0].chatId).toBe("chat-1");
  });

  it("should do nothing for unknown botKey", () => {
    const manager = new FileSessionManager();
    manager.cleanupIdle("unknown-bot", 1000);
    // no crash
  });
});

// ================================================================
// 6. listActive — 列出活跃
// ================================================================

describe("FileSessionManager listActive", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = setupTempHome().tmpDir;
  });

  afterEach(() => teardown(tmpDir));

  it("should return all active sessions for a bot", async () => {
    const manager = new FileSessionManager();
    await manager.getOrCreate("testbot", "chat-1", "user-1");
    await manager.getOrCreate("testbot", "chat-2", "user-1");
    await manager.getOrCreate("testbot", "chat-3", "user-2");

    const active = manager.listActive("testbot");
    expect(active.length).toBe(3);

    const chatIds = active.map((s) => s.chatId).sort();
    expect(chatIds).toEqual(["chat-1", "chat-2", "chat-3"]);
  });

  it("should return empty array for unknown botKey", () => {
    const manager = new FileSessionManager();
    expect(manager.listActive("unknown-bot")).toEqual([]);
  });
});

// ================================================================
// 7. 兼容旧 .memory.json 格式
// ================================================================

describe("FileSessionManager legacy format compatibility", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = setupTempHome().tmpDir;
  });

  afterEach(() => teardown(tmpDir));

  it("should migrate legacy format with sdkSessionId", async () => {
    // Write a legacy format file directly
    const botDir = path.join(tmpDir, "sessions", "testbot");
    fs.mkdirSync(botDir, { recursive: true });

    const legacyData = {
      chatId: "chat-1",
      userId: "user-1",
      sdkSessionId: "sdk-old-123",
      stats: {
        calls: 5,
        totalTurns: 10,
        totalInputTokens: 1000,
        totalOutputTokens: 2000,
        totalCostUSD: 0.05,
        totalDurationMs: 30000,
      },
      recentMessages: ["hello", "world"],
      lastUsed: Date.now(),
      permissionMode: "ask",
      codexMode: "plan",
    };

    fs.writeFileSync(
      path.join(botDir, "chat-1.memory.json"),
      JSON.stringify(legacyData, null, 2),
    );

    const manager = new FileSessionManager();
    const session = await manager.getOrCreate("testbot", "chat-1", "user-1");

    expect(session.chatId).toBe("chat-1");
    // migrateFromLegacy: backendSessionId = sdkSessionId || codexThreadId || ocSessionId
    expect(session.backendSessionId).toBe("sdk-old-123");
    expect(session.metadata.sdkSessionId).toBe("sdk-old-123");
    expect(session.stats.calls).toBe(5);
    expect(session.recentMessages).toEqual(["hello", "world"]);
    expect(session.permissionMode).toBe("ask");
    expect(session.codexMode).toBe("plan");
  });

  it("should migrate legacy format with codexThreadId", async () => {
    const botDir = path.join(tmpDir, "sessions", "testbot");
    fs.mkdirSync(botDir, { recursive: true });

    const legacyData = {
      chatId: "chat-2",
      userId: "user-1",
      codexThreadId: "thread-abc",
      stats: {
        calls: 0,
        totalTurns: 0,
        totalInputTokens: 0,
        totalOutputTokens: 0,
        totalCostUSD: 0,
        totalDurationMs: 0,
      },
      recentMessages: [],
      lastUsed: Date.now(),
    };

    fs.writeFileSync(
      path.join(botDir, "chat-2.memory.json"),
      JSON.stringify(legacyData, null, 2),
    );

    const manager = new FileSessionManager();
    const session = await manager.getOrCreate("testbot", "chat-2", "user-1");

    expect(session.backendSessionId).toBe("thread-abc");
    expect(session.metadata.codexThreadId).toBe("thread-abc");
  });

  it("should handle new format correctly", async () => {
    const botDir = path.join(tmpDir, "sessions", "testbot");
    fs.mkdirSync(botDir, { recursive: true });

    const newData = {
      chatId: "chat-3",
      userId: "user-1",
      backendSessionId: "new-session-xyz",
      metadata: { customField: "value" },
      stats: {
        calls: 2,
        totalTurns: 4,
        totalInputTokens: 500,
        totalOutputTokens: 1000,
        totalCostUSD: 0.02,
        totalDurationMs: 15000,
      },
      recentMessages: ["msg1"],
      lastUsed: Date.now(),
      running: false,
      startFresh: false,
    };

    fs.writeFileSync(
      path.join(botDir, "chat-3.memory.json"),
      JSON.stringify(newData, null, 2),
    );

    const manager = new FileSessionManager();
    const session = await manager.getOrCreate("testbot", "chat-3", "user-1");

    expect(session.chatId).toBe("chat-3");
    expect(session.backendSessionId).toBe("new-session-xyz");
    expect(session.metadata.customField).toBe("value");
    expect(session.stats.calls).toBe(2);
  });
});
