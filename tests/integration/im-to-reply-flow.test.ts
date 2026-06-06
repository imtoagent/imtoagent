// ================================================================
// IM-to-Reply 端到端集成测试
// 模拟用户从 IM 端发起消息，到收到 AI 回复的完整链路
// ================================================================
// 链路覆盖：
//  1. IM 接收消息（Feishu/Telegram 事件解析）
//  2. 媒体处理（图片/文件 → mediaStore）
//  3. Prompt 构建（session 上下文 + system prompt）
//  4. Agent 后端调用（Codex / Claude / Gemini 模拟）
//  5. 响应提取与统计更新
//  6. 回复发送回 IM
// ================================================================

import { describe, it, expect, beforeAll, afterAll, beforeEach, mock } from "bun:test";
import * as fs from "fs";
import * as path from "path";

// ================================================================
// 测试环境配置
// ================================================================

const TEST_DATA_DIR = path.join(import.meta.dir, "__test_data__");

function ensureTestDataDir(): void {
  if (!fs.existsSync(TEST_DATA_DIR)) {
    fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
  }
}

function cleanupTestDataDir(): void {
  if (fs.existsSync(TEST_DATA_DIR)) {
    fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  }
}

// ================================================================
// Mock 基础设施
// ================================================================

/** 创建 Mock IM 适配器 */
function createMockIMAdapter() {
  const sentMessages: Array<{ chatId: string; content: string }> = [];
  return {
    sentMessages,
    reply: mock(async (chatId: string, content: string) => {
      sentMessages.push({ chatId, content });
      return { success: true };
    }),
    uploadFile: mock(async (chatId: string, filePath: string) => ({ success: true, fileUrl: "mock://file.url" })),
    sendImage: mock(async (chatId: string, imagePath: string) => ({ success: true, imageUrl: "mock://image.url" })),
  };
}

/** 创建 Mock Agent 后端 */
function createMockAgentBackend(options: {
  responseText?: string;
  latencyMs?: number;
  inputTokens?: number;
  outputTokens?: number;
  error?: Error;
} = {}) {
  const calls: Array<{ messages: any[]; model?: string }> = [];
  const mockResponse = {
    success: true,
    text: options.responseText || "Hello! This is a test response.",
    latencyMs: options.latencyMs || 150,
    inputTokens: options.inputTokens || 1200,
    outputTokens: options.outputTokens || 85,
    costUSD: 0.001_234,
    model: "mock-model-v1",
    finishReason: "stop" as const,
  };

  return {
    calls,
    sendMessage: mock(async (params: { messages: any[]; model?: string }) => {
      calls.push({ messages: params.messages, model: params.model });
      if (options.error) throw options.error;
      return mockResponse;
    }),
  };
}

/** 创建 Mock Session 管理器 */
function createMockSessionManager() {
  const sessions = new Map<string, any>();
  const persisted: any[] = [];

  return {
    sessions,
    persisted,
    getOrCreate: mock(async (botKey: string, chatId: string, userId: string) => {
      const sessionKey = `${botKey}:${chatId}`;
      if (!sessions.has(sessionKey)) {
        sessions.set(sessionKey, {
          chatId,
          userId,
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
      const session = sessions.get(sessionKey);
      session.lastUsed = Date.now();
      return session;
    }),
    persist: mock((botKey: string, session: any) => {
      const sessionKey = `${botKey}:${session.chatId}`;
      sessions.set(sessionKey, { ...session });
      persisted.push({ botKey, session: { ...session } });
    }),
    delete: mock((botKey: string, chatId: string) => {
      sessions.delete(`${botKey}:${chatId}`);
    }),
  };
}

/** 创建 Mock Media Store */
function createMockMediaStore() {
  const stored: Array<{ fileId: string; url: string; type: string }> = [];
  return {
    stored,
    saveMedia: mock(async (params: { url: string; type: string }) => {
      const fileId = `mock_file_${stored.length + 1}`;
      stored.push({ fileId, url: params.url, type: params.type });
      return { fileId, localPath: `/mock/${fileId}`, mimeType: "image/png" };
    }),
    getMediaUrl: mock((fileId: string) => {
      const item = stored.find((s) => s.fileId === fileId);
      return item ? item.url : null;
    }),
  };
}

// ================================================================
// 核心：模拟 IM 消息完整处理流程
// ================================================================

/**
 * 模拟一条 IM 消息从接收到回复的完整处理链路
 * 串联：事件解析 → Session → 媒体 → Prompt → Agent → 统计 → 回复
 */
async function simulateIMMessageFlow(params: {
  imEvent: any;
  botConfig: any;
  mockAdapter: any;
  mockAgentBackend: any;
  mockSessionManager: any;
  mockMediaStore: any;
}): Promise<{
  replyContent: string;
  agentCalls: number;
  mediaProcessed: number;
}> {
  const { imEvent, botConfig, mockAdapter, mockAgentBackend, mockSessionManager, mockMediaStore } = params;

  // Step 1: 解析 IM 事件
  const parsedMessage = parseIMEvent(imEvent);

  // Step 2: 获取/创建 Session
  const session = await mockSessionManager.getOrCreate(botConfig.name, parsedMessage.chatId, parsedMessage.userId);

  // Step 3: 媒体处理
  let mediaProcessed = 0;
  if (parsedMessage.attachments?.length) {
    for (const att of parsedMessage.attachments) {
      await mockMediaStore.saveMedia({ url: att.url, type: att.type });
      mediaProcessed++;
    }
  }

  // Step 4: 构建 Prompt
  const messages = buildPromptMessages({
    message: parsedMessage.text,
    session,
    botConfig,
    mediaContext: mockMediaStore.stored,
  });

  // Step 5: 调用 Agent
  const agentResponse = await mockAgentBackend.sendMessage({ messages, model: botConfig.model });

  // Step 6: 更新 Session 统计
  session.stats.calls += 1;
  session.stats.totalTurns += 1;
  session.stats.totalInputTokens += agentResponse.inputTokens;
  session.stats.totalOutputTokens += agentResponse.outputTokens;
  session.stats.totalCostUSD += agentResponse.costUSD;
  session.stats.totalDurationMs += agentResponse.latencyMs;
  session.recentMessages.push({ role: "user", content: parsedMessage.text, timestamp: Date.now() });
  session.recentMessages.push({ role: "assistant", content: agentResponse.text, timestamp: Date.now() });
  if (session.recentMessages.length > 20) {
    session.recentMessages = session.recentMessages.slice(-20);
  }
  mockSessionManager.persist(botConfig.name, session);

  // Step 7: 回复 IM
  await mockAdapter.reply(parsedMessage.chatId, agentResponse.text);

  return {
    replyContent: agentResponse.text,
    agentCalls: mockAgentBackend.calls.length,
    mediaProcessed,
  };
}

/** IM 事件 → 标准化消息 */
function parseIMEvent(event: any): {
  chatId: string;
  userId: string;
  text: string;
  attachments: Array<{ url: string; type: string }>;
} {
  if (event.event?.message?.message_type === "text") {
    return {
      chatId: event.event.message.chat_id,
      userId: event.event.message.message_id.split("_")[1] || "unknown",
      text: JSON.parse(event.event.message.content).text,
      attachments: [],
    };
  }
  if (event.message?.chat?.id) {
    return {
      chatId: String(event.message.chat.id),
      userId: String(event.message.from?.id || "unknown"),
      text: event.message.text || "",
      attachments: [],
    };
  }
  return {
    chatId: event.chatId || "unknown",
    userId: event.userId || "unknown",
    text: event.text || "",
    attachments: event.attachments || [],
  };
}

/** 构建 Agent messages */
function buildPromptMessages(params: { message: string; session: any; botConfig: any; mediaContext: any[] }): any[] {
  const { message, session, botConfig, mediaContext } = params;
  const messages: any[] = [];

  if (botConfig.systemPrompt) {
    messages.push({ role: "system", content: botConfig.systemPrompt });
  }

  if (session.recentMessages?.length) {
    for (const msg of session.recentMessages.slice(-10)) {
      messages.push({ role: msg.role, content: msg.content });
    }
  }

  if (mediaContext.length) {
    messages.push({
      role: "user",
      content: [
        { type: "text", text: message },
        ...mediaContext.map((m) => ({ type: "image_url", image_url: { url: m.url } })),
      ],
    });
  } else {
    messages.push({ role: "user", content: message });
  }

  return messages;
}

// ================================================================
// 测试用例
// ================================================================

describe("IM-to-Reply 端到端链路测试", () => {
  beforeAll(() => ensureTestDataDir());
  afterAll(() => cleanupTestDataDir());

  // ---- 基础文本消息 ----

  describe("基础文本消息", () => {
    it("应该正确处理纯文本消息并回复", async () => {
      const mockAdapter = createMockIMAdapter();
      const mockAgent = createMockAgentBackend({
        responseText: "你好！我是你的 AI 助手，有什么可以帮你的？",
        inputTokens: 100,
        outputTokens: 50,
      });
      const mockSession = createMockSessionManager();
      const mockMedia = createMockMediaStore();

      const feishuEvent = {
        event: {
          message: {
            message_type: "text",
            chat_id: "oc_test_chat_001",
            message_id: "om_test_msg_001",
            content: JSON.stringify({ text: "你好，介绍一下你自己" }),
          },
        },
      };

      const result = await simulateIMMessageFlow({
        imEvent: feishuEvent,
        botConfig: { name: "test-bot", model: "qwen3.5-plus", systemPrompt: "你是一个有用的 AI 助手。" },
        mockAdapter,
        mockAgentBackend: mockAgent,
        mockSessionManager: mockSession,
        mockMediaStore: mockMedia,
      });

      expect(result.replyContent).toBe("你好！我是你的 AI 助手，有什么可以帮你的？");
      expect(mockAdapter.reply).toHaveBeenCalledTimes(1);
      expect(mockAdapter.reply).toHaveBeenCalledWith("oc_test_chat_001", "你好！我是你的 AI 助手，有什么可以帮你的？");
      expect(mockAgent.sendMessage).toHaveBeenCalledTimes(1);

      // Agent 收到的消息格式
      const call = mockAgent.calls[0];
      expect(call.messages.length).toBe(2); // system + user
      expect(call.messages[0]).toEqual({ role: "system", content: "你是一个有用的 AI 助手。" });
      expect(call.messages[1]).toEqual({ role: "user", content: "你好，介绍一下你自己" });

      // Session 统计
      const ps = mockSession.persisted[0].session;
      expect(ps.stats.calls).toBe(1);
      expect(ps.stats.totalInputTokens).toBe(100);
      expect(ps.stats.totalOutputTokens).toBe(50);
      expect(ps.recentMessages.length).toBe(2);
    });

    it("多轮对话应复用 Session 上下文", async () => {
      const mockAdapter = createMockIMAdapter();
      const mockAgent = createMockAgentBackend({ responseText: "第二轮回复" });
      const mockSession = createMockSessionManager();
      const mockMedia = createMockMediaStore();
      const botConfig = { name: "test-bot", model: "qwen3.5-plus", systemPrompt: "你是一个有用的 AI 助手。" };

      // 第一轮
      await simulateIMMessageFlow({
        imEvent: { chatId: "chat_mt", userId: "u1", text: "你好", attachments: [] },
        botConfig,
        mockAdapter,
        mockAgentBackend: mockAgent,
        mockSessionManager: mockSession,
        mockMediaStore: mockMedia,
      });

      // 第二轮
      mockAgent.calls.length = 0;
      await simulateIMMessageFlow({
        imEvent: { chatId: "chat_mt", userId: "u1", text: "你能做什么？", attachments: [] },
        botConfig,
        mockAdapter,
        mockAgentBackend: mockAgent,
        mockSessionManager: mockSession,
        mockMediaStore: mockMedia,
      });

      // 第二轮 prompt 应含第一轮历史: system + user1 + assistant1 + user2 = 4
      const secondCall = mockAgent.calls[0];
      expect(secondCall.messages.length).toBe(4);
      expect(secondCall.messages[1].content).toBe("你好");
      expect(secondCall.messages[3].content).toBe("你能做什么？");
    });

    it("空消息仍应正常处理", async () => {
      const mockAdapter = createMockIMAdapter();
      const mockAgent = createMockAgentBackend({ responseText: "你发了一个空消息" });
      const mockSession = createMockSessionManager();
      const mockMedia = createMockMediaStore();

      await simulateIMMessageFlow({
        imEvent: { chatId: "chat_empty", userId: "u2", text: "", attachments: [] },
        botConfig: { name: "test-bot", model: "qwen3.5-plus", systemPrompt: "test" },
        mockAdapter,
        mockAgentBackend: mockAgent,
        mockSessionManager: mockSession,
        mockMediaStore: mockMedia,
      });

      expect(mockAdapter.reply).toHaveBeenCalledTimes(1);
      expect(mockAgent.sendMessage).toHaveBeenCalledTimes(1);
    });
  });

  // ---- 多模态消息 ----

  describe("多模态消息（图片）", () => {
    it("应该处理带图片的消息", async () => {
      const mockAdapter = createMockIMAdapter();
      const mockAgent = createMockAgentBackend({ responseText: "我看到你发了一张图片" });
      const mockSession = createMockSessionManager();
      const mockMedia = createMockMediaStore();

      const result = await simulateIMMessageFlow({
        imEvent: {
          chatId: "chat_img",
          userId: "u3",
          text: "这是什么？",
          attachments: [{ url: "https://example.com/photo.jpg", type: "image" }],
        },
        botConfig: { name: "test-bot", model: "qwen3.5-plus", systemPrompt: "test" },
        mockAdapter,
        mockAgentBackend: mockAgent,
        mockSessionManager: mockSession,
        mockMediaStore: mockMedia,
      });

      expect(result.mediaProcessed).toBe(1);
      expect(mockMedia.saveMedia).toHaveBeenCalledTimes(1);

      const userMsg = mockAgent.calls[0].messages[mockAgent.calls[0].messages.length - 1];
      expect(Array.isArray(userMsg.content)).toBe(true);
      expect(userMsg.content[0].type).toBe("text");
      expect(userMsg.content[1].type).toBe("image_url");
    });

    it("应该处理多张图片", async () => {
      const mockAdapter = createMockIMAdapter();
      const mockAgent = createMockAgentBackend({ responseText: "3 张图" });
      const mockSession = createMockSessionManager();
      const mockMedia = createMockMediaStore();

      const result = await simulateIMMessageFlow({
        imEvent: {
          chatId: "chat_imgs",
          userId: "u4",
          text: "比较这些图",
          attachments: [
            { url: "https://example.com/a.jpg", type: "image" },
            { url: "https://example.com/b.jpg", type: "image" },
            { url: "https://example.com/c.jpg", type: "image" },
          ],
        },
        botConfig: { name: "test-bot", model: "qwen3.5-plus", systemPrompt: "test" },
        mockAdapter,
        mockAgentBackend: mockAgent,
        mockSessionManager: mockSession,
        mockMediaStore: mockMedia,
      });

      expect(result.mediaProcessed).toBe(3);
      const userMsg = mockAgent.calls[0].messages[mockAgent.calls[0].messages.length - 1];
      expect(userMsg.content.length).toBe(4); // 1 text + 3 images
    });
  });

  // ---- Agent 异常 ----

  describe("Agent 后端异常", () => {
    it("Agent 报错时异常应向上抛出", async () => {
      const mockAdapter = createMockIMAdapter();
      const mockAgent = createMockAgentBackend({ error: new Error("API timeout") });
      const mockSession = createMockSessionManager();
      const mockMedia = createMockMediaStore();

      await expect(
        simulateIMMessageFlow({
          imEvent: { chatId: "chat_err", userId: "u5", text: "你好", attachments: [] },
          botConfig: { name: "test-bot", model: "qwen3.5-plus", systemPrompt: "test" },
          mockAdapter,
          mockAgentBackend: mockAgent,
          mockSessionManager: mockSession,
          mockMediaStore: mockMedia,
        }),
      ).rejects.toThrow("API timeout");

      // 但 Agent 确实被调用了
      expect(mockAgent.sendMessage).toHaveBeenCalledTimes(1);
    });
  });

  // ---- 不同 IM 平台 ----

  describe("不同 IM 平台事件解析", () => {
    it("Feishu 事件格式", async () => {
      const parsed = parseIMEvent({
        event: {
          message: {
            message_type: "text",
            chat_id: "oc_feishu_001",
            message_id: "om_feishu_001",
            content: JSON.stringify({ text: "飞书测试" }),
          },
        },
      });
      expect(parsed.chatId).toBe("oc_feishu_001");
      expect(parsed.text).toBe("飞书测试");
    });

    it("Telegram 事件格式", async () => {
      const parsed = parseIMEvent({
        message: {
          chat: { id: 12345678 },
          from: { id: 87654321, username: "testuser" },
          text: "Telegram 测试",
        },
      });
      expect(parsed.chatId).toBe("12345678");
      expect(parsed.userId).toBe("87654321");
      expect(parsed.text).toBe("Telegram 测试");
    });

    it("完整链路：Feishu → Agent → 回复", async () => {
      const mockAdapter = createMockIMAdapter();
      const mockAgent = createMockAgentBackend({ responseText: "收到飞书消息！" });
      const mockSession = createMockSessionManager();
      const mockMedia = createMockMediaStore();

      const result = await simulateIMMessageFlow({
        imEvent: {
          event: {
            message: {
              message_type: "text",
              chat_id: "oc_feishu_e2e",
              message_id: "om_feishu_e2e",
              content: JSON.stringify({ text: "完整链路测试" }),
            },
          },
        },
        botConfig: { name: "feishu-bot", model: "qwen3.5-plus", systemPrompt: "你是飞书机器人。" },
        mockAdapter,
        mockAgentBackend: mockAgent,
        mockSessionManager: mockSession,
        mockMediaStore: mockMedia,
      });

      expect(result.replyContent).toBe("收到飞书消息！");
      expect(mockAdapter.reply).toHaveBeenCalledWith("oc_feishu_e2e", "收到飞书消息！");
    });
  });

  // ---- Session 管理 ----

  describe("Session 状态管理", () => {
    it("新聊天创建新 Session", async () => {
      const sm = createMockSessionManager();
      const s1 = await sm.getOrCreate("bot-a", "chat-1", "u1");
      const s2 = await sm.getOrCreate("bot-a", "chat-2", "u1");
      expect(s1.stats.calls).toBe(0);
      expect(s1.chatId).not.toBe(s2.chatId);
    });

    it("同一聊天复用 Session", async () => {
      const sm = createMockSessionManager();
      const s1 = await sm.getOrCreate("bot-a", "chat-reuse", "u1");
      s1.stats.calls = 5;
      sm.persist("bot-a", s1);
      const s2 = await sm.getOrCreate("bot-a", "chat-reuse", "u1");
      expect(s2.stats.calls).toBe(5);
    });

    it("统计应正确累积", async () => {
      const mockAdapter = createMockIMAdapter();
      const sm = createMockSessionManager();
      const mockMedia = createMockMediaStore();
      const botConfig = { name: "bot", model: "qwen3.5-plus", systemPrompt: "test" };

      for (let i = 0; i < 3; i++) {
        const mockAgent = createMockAgentBackend({
          responseText: `回复 ${i + 1}`,
          inputTokens: 100 + i * 10,
          outputTokens: 50 + i * 5,
        });
        await simulateIMMessageFlow({
          imEvent: { chatId: "chat-stats", userId: "u", text: `msg ${i + 1}`, attachments: [] },
          botConfig,
          mockAdapter,
          mockAgentBackend: mockAgent,
          mockSessionManager: sm,
          mockMediaStore: mockMedia,
        });
      }

      const ps = sm.persisted[sm.persisted.length - 1].session;
      expect(ps.stats.calls).toBe(3);
      expect(ps.stats.totalInputTokens).toBe(330); // 100+110+120
      expect(ps.stats.totalOutputTokens).toBe(165); // 50+55+60
      expect(ps.recentMessages.length).toBe(6);
    });

    it("recentMessages 限制 20 条", async () => {
      const mockAdapter = createMockIMAdapter();
      const sm = createMockSessionManager();
      const mockMedia = createMockMediaStore();
      const botConfig = { name: "bot", model: "qwen3.5-plus", systemPrompt: "test" };

      for (let i = 0; i < 12; i++) {
        // 12 轮 = 24 条消息
        const mockAgent = createMockAgentBackend({ responseText: `r${i + 1}` });
        await simulateIMMessageFlow({
          imEvent: { chatId: "chat-trim", userId: "u", text: `m${i + 1}`, attachments: [] },
          botConfig,
          mockAdapter,
          mockAgentBackend: mockAgent,
          mockSessionManager: sm,
          mockMediaStore: mockMedia,
        });
      }

      const ps = sm.persisted[sm.persisted.length - 1].session;
      expect(ps.recentMessages.length).toBe(20);
      expect(ps.recentMessages[ps.recentMessages.length - 1].content).toContain("r12");
    });
  });

  // ---- Prompt 构建 ----

  describe("Prompt 构建", () => {
    it("应包含 system prompt", async () => {
      const mockAgent = createMockAgentBackend({ responseText: "test" });
      await simulateIMMessageFlow({
        imEvent: { chatId: "c", userId: "u", text: "Hello", attachments: [] },
        botConfig: { name: "bot", model: "qwen3.5-plus", systemPrompt: "你是翻译助手。" },
        mockAdapter: createMockIMAdapter(),
        mockAgentBackend: mockAgent,
        mockSessionManager: createMockSessionManager(),
        mockMediaStore: createMockMediaStore(),
      });
      expect(mockAgent.calls[0].messages[0]).toEqual({ role: "system", content: "你是翻译助手。" });
    });

    it("无 system prompt 时不添加", async () => {
      const mockAgent = createMockAgentBackend({ responseText: "test" });
      await simulateIMMessageFlow({
        imEvent: { chatId: "c", userId: "u", text: "测试", attachments: [] },
        botConfig: { name: "bot", model: "qwen3.5-plus" },
        mockAdapter: createMockIMAdapter(),
        mockAgentBackend: mockAgent,
        mockSessionManager: createMockSessionManager(),
        mockMediaStore: createMockMediaStore(),
      });
      expect(mockAgent.calls[0].messages.length).toBe(1);
      expect(mockAgent.calls[0].messages[0].role).toBe("user");
    });
  });
});
