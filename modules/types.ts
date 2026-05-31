// IMtoAgent 模块接口定义
// Agent 模块和 IM 模块之间的标准合同

// ================================================================
// Session 数据结构
// ================================================================

/** 调用统计 */
export interface CallStats {
  calls: number;
  totalTurns: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCostUSD: number;
  totalDurationMs: number;
}

/** 会话数据（替代 any） */
export interface SessionData {
  userId: string;
  sdkSessionId?: string;
  codexThreadId?: string;
  ocSessionId?: string;
  cwd?: string;
  permissionMode?: 'bypassPermissions' | 'default';
  codexMode?: string;
  startFresh?: boolean;
  stats: CallStats;
  recentMessages: string[];
  lastUsed: number;
}

// ================================================================
// Agent 模块接口
// ================================================================

/** Bot 提供给 Agent 模块的上下文 */
export interface AgentContext {
  readonly name: string;
  readonly backend: 'claude' | 'codex' | 'opencode';
  readonly activeModel: string;
  readonly modelAliases: Record<string, string>;
  readonly defaultCwd: string;
  /** IM 模块实例 */
  readonly imModule?: IMModule;

  // 发送回复给 IM
  reply(chatId: string, text: string): Promise<void>;

  // 推送进度消息
  sendProgress(chatId: string, text: string): Promise<void>;

  // 工具日志
  addToolLog(chatId: string, info: { name: string; summary: string }): void;
  flushToolLog(chatId: string): Promise<void>;

  // 格式化发送（parseToBlocks → sendBlocks/reply 统一入口）
  sendFormattedReply(chatId: string, response: string): Promise<void>;

  // 统计累加（统一 token/cost 统计）
  accumulateStats(session: SessionData, usage: { inputTokens: number; outputTokens: number; costUSD?: number; durationMs?: number; numTurns?: number }): void;

  // 会话持久化
  persistSession(chatId: string, session: SessionData): void;
  loadSession(chatId: string): SessionData | null;
  deleteSession(chatId: string): void;

  // 模型配置持久化
  saveModelConfig(config: { activeModel: string; modelAliases: Record<string, string> }): void;
  loadModelConfig(): { activeModel: string; modelAliases: Record<string, string> };
}

/** Agent 模块必须实现的接口 */
export interface AgentModule {
  /** 收到用户消息，处理并回复 */
  handleMessage(chatId: string, text: string, session: SessionData): Promise<void>;
}

// ================================================================
// IM 模块接口
// ================================================================

/** IM 模块提供给 Bot 的消息回调 */
export type MessageHandler = (chatId: string, text: string, userId: string, attachments?: import('./core/types').MessageAttachment[]) => Promise<void>;

/** IM 模块声明的输出能力 */
export interface IMCapabilities {
  text: boolean;
  codeBlock: boolean;
  cardMessage: boolean;
  fileSend: boolean;
  imageSend: boolean;
  audioSend: boolean;
  buttonAction: boolean;
  maxTextLength: number;
}

/** Agent 可调用的输出工具定义 */
export interface OutputToolDef {
  name: string;
  description: string;
  parameters: Record<string, { type: string; description: string; required?: boolean }>;
}

/** IM 模块必须实现的接口 */
export interface IMModule {
  /** 发送文本回复 */
  reply(chatId: string, text: string, maxLen?: number): Promise<void>;

  /** 推送进度/工具日志 */
  sendProgress(chatId: string, text: string): Promise<void>;

  /** 获取 IM 输出能力 */
  getCapabilities(): IMCapabilities;

  /** 发送富文本块（代码块、卡片、图片等） */
  sendBlocks(chatId: string, blocks: Array<Record<string, unknown>>): Promise<void>;

  /** 发送图片 */
  sendImage(chatId: string, imageKey: string, alt?: string): Promise<void>;

  /** 发送文件 */
  sendFile(chatId: string, fileKey: string, fileName: string): Promise<void>;

  /** 启动消息监听 */
  start(handler: MessageHandler): void;

  /** 停止 */
  stop(): void;
}

// ================================================================
// Bot 配置
// ================================================================

export interface BotConfig {
  /** 唯一标识（UUID，用于目录隔离，改名不影响） */
  id?: string;
  name: string;
  backend: 'claude' | 'codex' | 'opencode';
  appId: string;
  appSecret: string;
  cwd?: string;
  /** IM 平台类型（默认 feishu） */
  im?: 'feishu' | 'telegram' | 'wecom' | 'wechat';
}
