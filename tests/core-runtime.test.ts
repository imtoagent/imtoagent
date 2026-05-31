// ================================================================
// core-runtime.test.ts — AgentRuntime 单元测试
// ================================================================
// 测试 registerAdapter, getAdapter, processMessage 成功/失败/重试/fallback/stats/persist/sendProgress
// ================================================================

import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import * as fs from "fs";
import * as path from "path";
import os from "os";

import { AgentRuntime } from "../modules/core/runtime";
import type {
  AgentAdapter,
  AgentInput,
  AgentOutput,
  MessageContext,
  RuntimeConfig,
  Session,
  SessionManager,
  ErrorHandler,
  ErrorAction,
  ErrorContext,
  ConfigManager,
  StatsTracker,
} from "../modules/core/types";

// ================================================================
// 测试工具
// ================================================================

let testDir: string;

function setupTestEnv() {
  testDir = path.join(os.tmpdir(), `imto-test-runtime-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`);
  fs.mkdirSync(path.join(testDir, "sessions"), { recursive: true });
  fs.mkdirSync(path.join(testDir, "logs"), { recursive: true });
  fs.mkdirSync(path.join(testDir, "stats"), { recursive: true });
  fs.writeFileSync(
    path.join(testDir, "config.json"),
    JSON.stringify({ activeModel: "test/model" })
  );
  fs.writeFileSync(
    path.join(testDir, "providers.json"),
    JSON.stringify({ providers: {} })
  );
  process.env.IMTOAGENT_HOME = testDir;
}

function cleanupTestEnv() {
  delete process.env.IMTOAGENT_HOME;
  try { fs.rmSync(testDir, { recursive: true, force: true }); } catch {}
}

// ================================================================
// Mock 工厂函数
// ================================================================

function createMockAdapter(opts: {
  name?: string;
  handleResult?: AgentOutput;
  handleError?: Error;
} = {}): AgentAdapter & { callCount: number } {
  const callCount = { value: 0 };
  const obj = {
    callCount: 0,
    name: opts.name || "mock-adapter",
    handleMessage: async (_input: AgentInput): Promise<AgentOutput> => {
      obj.callCount++;
      if (opts.handleError) throw opts.handleError;
      return opts.handleResult || { text: "OK" };
    },
  };
  // Use a Proxy so we can track callCount properly
  return {
    get name() { return opts.name || "mock-adapter"; },
    callCount: 0,
    handleMessage: async (_input: AgentInput): Promise<AgentOutput> => {
      // We can't easily mutate callCount on interface, use a closure instead
      if (opts.handleError) throw opts.handleError;
      return opts.handleResult || { text: "OK" };
    },
  };
}

function createTrackedAdapter(
  opts: { name?: string; result?: AgentOutput; error?: Error } = {}
): { adapter: AgentAdapter; callCount: () => number } {
  let count = 0;
  const adapter: AgentAdapter = {
    get name() { return opts.name || "mock-adapter"; },
    handleMessage: async (_input: AgentInput): Promise<AgentOutput> => {
      count++;
      if (opts.error) throw opts.error;
      return opts.result || { text: "Hello from adapter" };
    },
  };
  return { adapter, callCount: () => count };
}

function createMockSessionManager(): {
  manager: SessionManager;
  getOrCreateCalls: Array<{ botKey: string; chatId: string; userId: string }>;
  persistCalls: Array<{ botKey: string; session: Session }>;
  sessions: Map<string, Session>;
} {
  const getOrCreateCalls: Array<{ botKey: string; chatId: string; userId: string }> = [];
  const persistCalls: Array<{ botKey: string; session: Session }> = [];
  const sessions = new Map<string, Session>();

  const manager: SessionManager = {
    getOrCreate: async (botKey: string, chatId: string, userId: string) => {
      getOrCreateCalls.push({ botKey, chatId, userId });
      const key = `${botKey}:${chatId}`;
      if (!sessions.has(key)) {
        sessions.set(key, {
          chatId,
          userId,
          startFresh: false,
          backendSessionId: undefined,
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
        });
      }
      return sessions.get(key)!;
    },
    persist: (botKey: string, session: Session) => {
      persistCalls.push({ botKey, session });
    },
    delete: () => {},
    cleanupIdle: () => {},
    listActive: () => [],
  };

  return { manager, getOrCreateCalls, persistCalls, sessions };
}

function createMockErrorHandler(): {
  handler: ErrorHandler;
  handleCalls: Array<{ chatId: string; error: Error; ctx: ErrorContext }>;
  setAction: (action: ErrorAction) => void;
} {
  const handleCalls: Array<{ chatId: string; error: Error; ctx: ErrorContext }> = [];
  let nextAction: ErrorAction = { type: "reply", message: "Error occurred" };

  const handler: ErrorHandler = {
    handle: async (chatId: string, error: Error, ctx: ErrorContext) => {
      handleCalls.push({ chatId, error, ctx });
      return nextAction;
    },
  };

  return {
    handler,
    handleCalls,
    setAction: (action: ErrorAction) => { nextAction = action; },
  };
}

function createMockStatsTracker(): {
  tracker: StatsTracker;
  resetCalls: Session[];
  accumulateCalls: Array<{ session: Session; usage: any }>;
} {
  const resetCalls: Session[] = [];
  const accumulateCalls: Array<{ session: Session; usage: any }> = [];

  const tracker: StatsTracker = {
    resetForCall: (session: Session) => {
      resetCalls.push(session);
      session.stats.calls += 1;
    },
    accumulate: (session: Session, usage: any) => {
      accumulateCalls.push({ session, usage });
    },
    formatSummary: () => "📊 0 calls",
  };

  return { tracker, resetCalls, accumulateCalls };
}

function createMockConfigManager(): ConfigManager {
  return {
    get: () => undefined as any,
    getBotConfig: () => null,
    getProviderConfig: () => null,
    getActiveModel: () => "test/model",
    resolveModel: (spec: string) => spec,
  };
}

function createMockContext(): {
  ctx: MessageContext;
  replyCalls: string[];
  progressCalls: string[];
  blocksCalls: any[];
} {
  const replyCalls: string[] = [];
  const progressCalls: string[] = [];
  const blocksCalls: any[] = [];

  const ctx: MessageContext = {
    chatId: "test-chat-1",
    userId: "test-user-1",
    text: "Hello",
    workingDir: "/tmp/test",
    model: "test/model",
    reply: async (text: string) => { replyCalls.push(text); },
    sendProgress: async (text: string) => { progressCalls.push(text); },
    sendBlocks: async (blocks: any) => { blocksCalls.push(blocks); },
  };

  return { ctx, replyCalls, progressCalls, blocksCalls };
}

function buildRuntime(
  sessionManager: SessionManager,
  errorHandler: ErrorHandler,
  statsTracker: StatsTracker,
  configManager: ConfigManager = createMockConfigManager()
): AgentRuntime {
  return new AgentRuntime({
    sessionManager,
    errorHandler,
    statsTracker,
    configManager,
  });
}

// ================================================================
// Tests
// ================================================================

describe("AgentRuntime — registerAdapter / getAdapter", () => {
  beforeEach(setupTestEnv);
  afterEach(cleanupTestEnv);

  it("registerAdapter 注册适配器", () => {
    const sm = createMockSessionManager();
    const eh = createMockErrorHandler();
    const st = createMockStatsTracker();
    const runtime = buildRuntime(sm.manager, eh.handler, st.tracker);

    const adapter = createTrackedAdapter({ name: "test-backend" });
    runtime.registerAdapter("test-backend", adapter.adapter);

    expect(runtime.getAdapter("test-backend")).toBe(adapter.adapter);
    expect(adapter.callCount()).toBe(0);
  });

  it("getAdapter 获取不存在的适配器返回 undefined", () => {
    const sm = createMockSessionManager();
    const eh = createMockErrorHandler();
    const st = createMockStatsTracker();
    const runtime = buildRuntime(sm.manager, eh.handler, st.tracker);

    expect(runtime.getAdapter("nonexistent")).toBeUndefined();
  });

  it("registerAdapter 覆盖同名适配器", () => {
    const sm = createMockSessionManager();
    const eh = createMockErrorHandler();
    const st = createMockStatsTracker();
    const runtime = buildRuntime(sm.manager, eh.handler, st.tracker);

    const adapter1 = createTrackedAdapter({ name: "first" });
    const adapter2 = createTrackedAdapter({ name: "second" });

    runtime.registerAdapter("backend", adapter1.adapter);
    runtime.registerAdapter("backend", adapter2.adapter);

    expect(runtime.getAdapter("backend")).toBe(adapter2.adapter);
  });
});

describe("AgentRuntime — processMessage 成功路径", () => {
  beforeEach(setupTestEnv);
  afterEach(cleanupTestEnv);

  it("processMessage 成功返回 { restart: false }", async () => {
    const sm = createMockSessionManager();
    const eh = createMockErrorHandler();
    const st = createMockStatsTracker();
    const ctx = createMockContext();
    const runtime = buildRuntime(sm.manager, eh.handler, st.tracker);

    const adapter = createTrackedAdapter({
      result: { text: "Response text" },
    });
    runtime.registerAdapter("test", adapter.adapter);

    const result = await runtime.processMessage(ctx.ctx, adapter.adapter, "test-bot");

    expect(result.restart).toBe(false);
    expect(adapter.callCount()).toBe(1);
  });

  it("processMessage 调用 sendProgress", async () => {
    const sm = createMockSessionManager();
    const eh = createMockErrorHandler();
    const st = createMockStatsTracker();
    const ctx = createMockContext();
    const runtime = buildRuntime(sm.manager, eh.handler, st.tracker);

    const adapter = createTrackedAdapter({ result: { text: "OK" } });

    await runtime.processMessage(ctx.ctx, adapter.adapter, "test-bot");

    expect(ctx.progressCalls).toContain("💭 Thinking...");
  });

  it("processMessage 调用 statsTracker.resetForCall", async () => {
    const sm = createMockSessionManager();
    const eh = createMockErrorHandler();
    const st = createMockStatsTracker();
    const ctx = createMockContext();
    const runtime = buildRuntime(sm.manager, eh.handler, st.tracker);

    const adapter = createTrackedAdapter({ result: { text: "OK" } });

    await runtime.processMessage(ctx.ctx, adapter.adapter, "test-bot");

    expect(st.resetCalls.length).toBe(1);
    // resetForCall increments calls
    expect(st.resetCalls[0].stats.calls).toBe(1);
  });

  it("processMessage 调用 statsTracker.accumulate (有 usage)", async () => {
    const sm = createMockSessionManager();
    const eh = createMockErrorHandler();
    const st = createMockStatsTracker();
    const ctx = createMockContext();
    const runtime = buildRuntime(sm.manager, eh.handler, st.tracker);

    const adapter = createTrackedAdapter({
      result: {
        text: "OK",
        usage: {
          inputTokens: 100,
          outputTokens: 200,
          costUSD: 0.005,
          durationMs: 1500,
          numTurns: 1,
        },
      },
    });

    await runtime.processMessage(ctx.ctx, adapter.adapter, "test-bot");

    expect(st.accumulateCalls.length).toBe(1);
    expect(st.accumulateCalls[0].usage.inputTokens).toBe(100);
    expect(st.accumulateCalls[0].usage.outputTokens).toBe(200);
  });

  it("processMessage 调用 sessionManager.persist", async () => {
    const sm = createMockSessionManager();
    const eh = createMockErrorHandler();
    const st = createMockStatsTracker();
    const ctx = createMockContext();
    const runtime = buildRuntime(sm.manager, eh.handler, st.tracker);

    const adapter = createTrackedAdapter({ result: { text: "OK" } });

    await runtime.processMessage(ctx.ctx, adapter.adapter, "test-bot");

    expect(sm.persistCalls.length).toBe(1);
    expect(sm.persistCalls[0].botKey).toBe("test-bot");
  });

  it("processMessage 回复文本 (sendBlocks 为 undefined)", async () => {
    const sm = createMockSessionManager();
    const eh = createMockErrorHandler();
    const st = createMockStatsTracker();
    const ctx = createMockContext();
    ctx.ctx.sendBlocks = undefined; // No sendBlocks capability
    const runtime = buildRuntime(sm.manager, eh.handler, st.tracker);

    const adapter = createTrackedAdapter({ result: { text: "Hello reply" } });

    await runtime.processMessage(ctx.ctx, adapter.adapter, "test-bot");

    expect(ctx.replyCalls).toContain("Hello reply");
  });
});

describe("AgentRuntime — processMessage startFresh", () => {
  beforeEach(setupTestEnv);
  afterEach(cleanupTestEnv);

  it("startFresh 清除 backendSessionId", async () => {
    const sm = createMockSessionManager();
    const eh = createMockErrorHandler();
    const st = createMockStatsTracker();
    const ctx = createMockContext();
    const runtime = buildRuntime(sm.manager, eh.handler, st.tracker);

    // Pre-create a session with startFresh=true and a backendSessionId
    const key = `test-bot:${ctx.ctx.chatId}`;
    sm.sessions.set(key, {
      chatId: ctx.ctx.chatId,
      userId: ctx.ctx.userId,
      startFresh: true,
      backendSessionId: "old-session-id",
      metadata: { foo: "bar" },
      stats: {
        calls: 5,
        totalTurns: 10,
        totalInputTokens: 1000,
        totalOutputTokens: 2000,
        totalCostUSD: 0.1,
        totalDurationMs: 5000,
      },
      lastUsed: Date.now(),
      running: false,
      recentMessages: ["old message"],
    });

    const adapter = createTrackedAdapter({ result: { text: "OK" } });

    await runtime.processMessage(ctx.ctx, adapter.adapter, "test-bot");

    // backendSessionId should be cleared
    expect(sm.sessions.get(key)!.backendSessionId).toBeUndefined();
    expect(sm.sessions.get(key)!.startFresh).toBe(false);
    expect(sm.sessions.get(key)!.metadata).toEqual({});
  });
});

describe("AgentRuntime — processMessage 失败处理", () => {
  beforeEach(setupTestEnv);
  afterEach(cleanupTestEnv);

  it("processMessage 失败 → error handler 返回 reply", async () => {
    const sm = createMockSessionManager();
    const eh = createMockErrorHandler();
    const st = createMockStatsTracker();
    const ctx = createMockContext();
    const runtime = buildRuntime(sm.manager, eh.handler, st.tracker);

    eh.setAction({ type: "reply", message: "Sorry, something went wrong" });

    const adapter = createTrackedAdapter({
      error: new Error("Backend timeout"),
    });

    const result = await runtime.processMessage(ctx.ctx, adapter.adapter, "test-bot");

    expect(result.restart).toBe(false);
    expect(ctx.replyCalls).toContain("Sorry, something went wrong");
    expect(eh.handleCalls.length).toBe(1);
  });

  it("processMessage 失败 → retry", async () => {
    const sm = createMockSessionManager();
    const eh = createMockErrorHandler();
    const st = createMockStatsTracker();
    const ctx = createMockContext();
    const runtime = buildRuntime(sm.manager, eh.handler, st.tracker);

    // First attempt fails, retry succeeds
    let attempt = 0;
    const adapter: AgentAdapter = {
      get name() { return "flaky"; },
      handleMessage: async () => {
        attempt++;
        if (attempt === 1) {
          // On first attempt, error handler says retry
          eh.setAction({ type: "retry", maxAttempts: 2 });
          throw new Error("Network timeout");
        }
        return { text: "Recovered on retry" };
      },
    };

    const result = await runtime.processMessage(ctx.ctx, adapter, "test-bot");

    expect(result.restart).toBe(false);
    expect(attempt).toBe(2);
    expect(ctx.replyCalls).toContain("Recovered on retry");
  });

  it("processMessage 失败 → fallback 到另一个 adapter", async () => {
    const sm = createMockSessionManager();
    const eh = createMockErrorHandler();
    const st = createMockStatsTracker();
    const ctx = createMockContext();
    const runtime = buildRuntime(sm.manager, eh.handler, st.tracker);

    // Primary adapter always fails
    const primary: AgentAdapter = {
      get name() { return "primary"; },
      handleMessage: async () => {
        eh.setAction({ type: "fallback", adapter: "secondary" });
        throw new Error("500 Internal Server Error");
      },
    };

    // Secondary adapter succeeds
    const secondary: AgentAdapter = {
      get name() { return "secondary"; },
      handleMessage: async () => ({ text: "Fallback response" }),
    };

    runtime.registerAdapter("primary", primary);
    runtime.registerAdapter("secondary", secondary);

    const result = await runtime.processMessage(ctx.ctx, primary, "test-bot");

    expect(result.restart).toBe(false);
    expect(ctx.replyCalls).toContain("Fallback response");
  });

  it("processMessage 失败 → fallback 适配器不存在时直接返回", async () => {
    const sm = createMockSessionManager();
    const eh = createMockErrorHandler();
    const st = createMockStatsTracker();
    const ctx = createMockContext();
    const runtime = buildRuntime(sm.manager, eh.handler, st.tracker);

    const adapter: AgentAdapter = {
      get name() { return "only"; },
      handleMessage: async () => {
        eh.setAction({ type: "fallback", adapter: "nonexistent" });
        throw new Error("500 error");
      },
    };

    const result = await runtime.processMessage(ctx.ctx, adapter, "test-bot");

    expect(result.restart).toBe(false);
    // Should not have replied (fallback adapter doesn't exist, falls through)
    expect(ctx.replyCalls.length).toBe(0);
  });

  it("processMessage 失败后仍然调用 persist", async () => {
    const sm = createMockSessionManager();
    const eh = createMockErrorHandler();
    const st = createMockStatsTracker();
    const ctx = createMockContext();
    const runtime = buildRuntime(sm.manager, eh.handler, st.tracker);

    eh.setAction({ type: "reply", message: "Error" });

    const adapter = createTrackedAdapter({
      error: new Error("Always fails"),
    });

    await runtime.processMessage(ctx.ctx, adapter, "test-bot");

    // persist should still be called even on failure
    expect(sm.persistCalls.length).toBe(1);
  });

  it("processMessage 返回 output.error 作为错误处理", async () => {
    const sm = createMockSessionManager();
    const eh = createMockErrorHandler();
    const st = createMockStatsTracker();
    const ctx = createMockContext();
    const runtime = buildRuntime(sm.manager, eh.handler, st.tracker);

    eh.setAction({ type: "reply", message: "Adapter error" });

    const adapter: AgentAdapter = {
      get name() { return "error-adapter"; },
      handleMessage: async () => ({ error: "Something went wrong in adapter" }),
    };

    const result = await runtime.processMessage(ctx.ctx, adapter, "test-bot");

    expect(result.restart).toBe(false);
    expect(ctx.replyCalls).toContain("Adapter error");
  });
});

describe("AgentRuntime — healthCheck / cancelSession", () => {
  beforeEach(setupTestEnv);
  afterEach(cleanupTestEnv);

  it("healthCheck 对未注册的 backend 返回 true", async () => {
    const sm = createMockSessionManager();
    const eh = createMockErrorHandler();
    const st = createMockStatsTracker();
    const runtime = buildRuntime(sm.manager, eh.handler, st.tracker);

    expect(await runtime.healthCheck("unknown")).toBe(true);
  });

  it("cancelSession 对没有 cancel 方法的适配器不报错", async () => {
    const sm = createMockSessionManager();
    const eh = createMockErrorHandler();
    const st = createMockStatsTracker();
    const runtime = buildRuntime(sm.manager, eh.handler, st.tracker);

    const adapter: AgentAdapter = {
      get name() { return "no-cancel"; },
      handleMessage: async () => ({ text: "OK" }),
    };

    runtime.registerAdapter("no-cancel", adapter);
    await expect(runtime.cancelSession("no-cancel", "session-1")).resolves.toBeUndefined();
  });
});
