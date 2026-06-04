// ================================================================
// SDK 核心类型 — IMtoAgent 新模块只需实现 AgentAdapter
// ================================================================

import type { UnifiedBlock, IMCapabilities } from '../capabilities';

// ================================================================
// 统计
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

// ================================================================
// Session
// ================================================================

/**
 * 统一 Session — 替代各 Agent 特有的 session 字段
 * 
 * 与现有 .memory.json 格式保持向后兼容：
 * - metadata 中存放 sdkSessionId / codexThreadId / ocSessionId 等
 * - 直接字段存放通用属性
 */
export interface Session {
  chatId: string;
  userId: string;
  cwd?: string;
  startFresh: boolean;

  // 后端会话 ID（通用，替代 sdkSessionId/codexThreadId/ocSessionId）
  backendSessionId?: string;

  // 各 Agent 特有的元数据（扩展用）
  // 向后兼容：从旧 .memory.json 迁移时，sdkSessionId/codexThreadId/ocSessionId 存在这里
  metadata: Record<string, unknown>;

  // 统计
  stats: CallStats;

  // 元数据
  lastUsed: number;
  running: boolean;
  permissionMode?: string;
  codexMode?: string; // plan/auto

  // 最近消息（向后兼容）
  recentMessages: string[];

  // === 心跳/定时任务扩展字段（L0 新增，全部可选，向后兼容）===

  /** Session 类型（'cron' 为 v2 预留；v1 定时任务跑在 heartbeat session 内） */
  sessionType?: 'main' | 'heartbeat' | 'cron';

  /** Session 键（替代 chatId 作为唯一标识）
   *  - main:      = chatId (如 "oc_xxx")
   *  - heartbeat: = chatId:heartbeat  或 global:heartbeat
   *  - cron:      = chatId:cron:taskName
   */
  sessionKey?: string;

  /** 心跳专用：上次心跳发送的文本（用于去重） */
  lastHeartbeatText?: string;
  /** 心跳专用：上次心跳发送时间戳 */
  lastHeartbeatSentAt?: number;
  /** 定时任务专用：任务状态追踪
   *  - v2.2: 值为 number（上次执行时间戳）
   *  - v3: 值升级为对象，向后兼容 number 类型
   */
  heartbeatTaskState?: Record<string, number | TaskRunState>;
  /** 心跳轮数控制：最近 N 轮（硬截断） */
  heartbeatRounds?: HeartbeatRound[];
}

/** 心跳轮次记录 */
export interface HeartbeatRound {
  timestamp: number;
  prompt: string;
  response: string;
  tokensUsed: number;
}

/** 单个任务的运行状态（v3 新增） */
export interface TaskRunState {
  lastRunAt: number;       // 上次执行时间戳
  runCount: number;        // 累计执行次数（countdown 需要）
  createdAt: number;       // 任务创建时间戳（once/after 需要）
  // P4-3: stopwatch
  elapsedMs?: number;      // 累计运行时间（毫秒）
  startedAt?: number;      // 当前会话开始时间戳
  // P4-4: 最近执行结果
  lastResult?: 'success' | 'timeout' | 'error';
  lastError?: string;      // 最近一次错误信息
}

/** 任务类型 */
export type TaskType = 'interval' | 'once' | 'scheduled' | 'countdown' | 'conditional' | 'stopwatch' | 'cron';

/** 失败策略 */
export type OnFailureStrategy = 'ignore' | 'alert' | 'retry';

/** 定时任务定义（HEARTBEAT.md 中解析） */
export interface ScheduledTask {
  name: string;
  type?: TaskType;                  // 省略时默认 'interval'
  interval?: string;                // interval, countdown, conditional 需要
  prompt: string;
  // once / scheduled
  at?: string;                      // once: "YYYY-MM-DD HH:MM", scheduled: "HH:MM"
  after?: string;                   // once 专用：相对延迟
  on?: string;                      // scheduled 专用："monday" / "1st"
  // countdown
  max_runs?: number;
  deadline?: string;                // "YYYY-MM-DD HH:MM"
  // cron 表达式（P2-7 新增）
  cron?: string;                    // cron 专用："0 9 * * *"
  // 失败策略覆盖
  on_failure?: OnFailureStrategy;
  max_retries?: number;
  timeout?: string;
  // v3.1（预留）
  condition?: string;               // conditional 专用
  bot?: string;                     // bot 过滤
  // P4-1: 任务链（依赖触发）
  on_complete?: string;             // 完成后触发的下游任务名
  // P4-3: stopwatch
  auto_stop?: string;               // 自动停止时间 "HH:MM" 或相对时长 "30m"
  // P4-4: 历史持久化
  history_file?: string;            // 历史记录文件路径（相对 workspace）
  max_history?: number;             // 最大保留条数（默认 50）
}

// ================================================================
// Agent 输入 / 输出
// ================================================================

/** 消息附件（图片/文件/语音等） */
export interface MessageAttachment {
  /** 类型：image | file | audio */
  type: 'image' | 'file' | 'audio';
  /** 本地下载后的文件路径 */
  localPath: string;
  /** 原始文件名（如有） */
  filename?: string;
  /** 飞书 image_key / file_key（调试用） */
  sourceKey?: string;
  /** MIME 类型 */
  mimeType?: string;
  /** 语音时长（毫秒） */
  durationMs?: number;
  /** 预计算的 Agent 提示文本（由 MediaResolver 按文件类型生成，优先级高于 buildAttachmentHint 自动生成的） */
  hint?: string;
}

/** 构建附件提示文本，注入到 Agent 输入消息中 */
export function buildAttachmentHint(attachments: MessageAttachment[]): string {
  return attachments.map((att, i) => {
    const icon = att.type === 'image' ? '🖼️' : att.type === 'audio' ? '🎵' : '📎';
    const typeLabel = att.type === 'image' ? 'Image' : att.type === 'audio' ? 'Voice' : 'File';
    const detail = att.filename ? ` (${att.filename})` : '';
    const dur = att.durationMs ? ` [Duration: ${Math.round(att.durationMs / 1000)}s]` : '';
    const mimeInfo = att.mimeType ? ` [${att.mimeType}]` : '';

    // 优先使用预计算的提示（由 MediaResolver 按文件类型生成）
    let hint: string;
    if (att.hint) {
      hint = `\n> 💡 ${att.hint}`;
    } else if (att.type === 'image') {
      hint = `\n> 💡 Image saved locally at: \`${att.localPath}\`, format: ${att.mimeType || 'unknown'}, use the image viewer tool to open`;
    } else if (att.type === 'audio') {
      hint = `\n> 💡 Voice file path: \`${att.localPath}\`, use speech-to-text tool to process`;
    } else {
      const ext = att.filename ? `, extension: ${att.filename.split('.').pop()}` : '';
      hint = `\n> 💡 File path: \`${att.localPath}\`, readable with file reading tool${ext}`;
    }

    return `${icon} [User message with ${typeLabel} #${i + 1}]${detail}${mimeInfo}${dur}${hint}`;
  }).join('\n\n');
}

/** Agent 输入 */
export interface AgentInput {
  chatId: string;
  text: string;
  /** 消息附带的附件/媒体（图片、文件、语音等，已下载到本地） */
  attachments?: MessageAttachment[];
  session: Session;
  workingDir: string;
  systemPrompt?: string;
  model: string;
  /** 外部取消信号（用于 /stop 等中断命令） */
  cancelSignal?: AbortSignal;
  /** 进度回调（适配器向用户发送中间状态，如工具调用、思考进度） */
  sendProgress?: (text: string) => Promise<void>;
}

/** Agent 输出 */
export interface AgentOutput {
  text?: string;
  toolCalls?: Array<{ name: string; summary: string }>;
  usage?: {
    inputTokens: number;
    outputTokens: number;
    costUSD?: number;
    durationMs?: number;
    numTurns?: number;
  };
  error?: string;
}

// ================================================================
// AgentAdapter — 新 Agent 模块只需实现这个接口
// ================================================================

/**
 * AgentAdapter — 新 Agent 模块只需实现这个接口
 * 
 * 职责：接收用户消息，调用后端 API，返回响应
 * SDK Runtime 负责：session 管理、统计、格式化、错误处理、配置
 */
export interface AgentAdapter {
  readonly name: string;
  handleMessage(input: AgentInput): Promise<AgentOutput>;
  healthCheck?(): Promise<boolean>;
  cancel?(sessionId: string): Promise<void>;
}

// ================================================================
// Runtime 接口
// ================================================================

/** 消息处理上下文 */
export interface MessageContext {
  chatId: string;
  text: string;
  /** 消息附带的附件/媒体 */
  attachments?: MessageAttachment[];
  userId: string;
  workingDir: string;
  model: string;
  systemPrompt?: string;
  reply: (text: string) => Promise<void>;
  sendProgress: (text: string) => Promise<void>;
  sendBlocks?: (blocks: UnifiedBlock[]) => Promise<void>;
  /** IM 能力声明，用于 parseToBlocks 正确解析 */
  imCaps?: IMCapabilities;
  /** 外部取消信号（用于 /stop 等中断命令） */
  cancelSignal?: AbortSignal;
  /** Phase 2: 工具列表（OpenAI 格式，供 Agent function calling） */
  tools?: object[];
}

/** Session 管理器 */
export interface SessionManager {
  /** 获取或创建 Session */
  getOrCreate(botKey: string, chatId: string, userId: string): Promise<Session>;
  /** 持久化 Session */
  persist(botKey: string, session: Session): void;
  /** 删除 Session */
  delete(botKey: string, chatId: string): void;
  /** 清理空闲 Session */
  cleanupIdle(botKey: string, timeoutMs: number): void;
  /** 列出所有活跃 Session */
  listActive(botKey: string): Session[];
}

/** 错误处理器 */
export interface ErrorHandler {
  handle(chatId: string, error: Error, ctx: ErrorContext): Promise<ErrorAction>;
}

/** 配置管理器 */
export interface ConfigManager {
  get<T>(path: string): T;
  getBotConfig(name: string): BotConfig | null;
  getProviderConfig(providerId: string): ProviderConfig | null;
  getActiveModel(): string;
  resolveModel(modelSpec: string): string;
}

/** 统计追踪器 */
export interface StatsTracker {
  resetForCall(session: Session): void;
  accumulate(session: Session, usage: { inputTokens: number; outputTokens: number; costUSD?: number; durationMs?: number; numTurns?: number }): void;
  formatSummary(session: Session): string;
}

// ================================================================
// Runtime 配置
// ================================================================

export interface RuntimeConfig {
  sessionManager: SessionManager;
  errorHandler: ErrorHandler;
  configManager: ConfigManager;
  statsTracker: StatsTracker;
}

// ================================================================
// 错误处理
// ================================================================

export type ErrorAction =
  | { type: 'reply'; message: string }
  | { type: 'retry'; maxAttempts: number }
  | { type: 'fallback'; adapter: string };

export interface ErrorContext {
  chatId: string;
  backend: string;
  attempt: number;
}

// ================================================================
// 配置类型
// ================================================================

export interface BotConfig {
  /** 唯一标识（UUID，用于目录/文件隔离，改名不影响） */
  id?: string;
  name: string;
  im: string; // 'feishu' | 'telegram' | 'wecom' | 'wechat'
  backend: string; // 'claude' | 'codex' | 'opencode'
  appId: string;
  appSecret: string;
  cwd?: string;
  activeModel?: string;
  modelAliases?: Record<string, string>;

  /** 心跳配置（L0 新增） */
  heartbeat?: {
    /** 心跳间隔（如 "5m"、"300s"、"1h"）默认：无心跳 */
    interval?: string;
    /** 心跳输出目标 */
    target?: {
      /** IM 平台 */
      channel?: 'feishu' | 'telegram' | 'wecom' | 'wechat';
      /** 目标 chatId（不填 = 最后活跃的对话） */
      chatId?: string;
    };
    /** 可见性控制 */
    visibility?: {
      /** 有内容时是否发送（默认 true） */
      showAlerts?: boolean;
      /** 一切正常时是否发送 OK 指示器（默认 false） */
      showOk?: boolean;
    };
    /** 心跳 prompt（可覆盖默认值） */
    prompt?: string;
    /** 心跳轮数上限（默认 3） */
    maxHeartbeatRounds?: number;
    /** 任务级默认值（v3 新增） */
    taskDefaults?: {
      on_failure?: OnFailureStrategy;
      max_retries?: number;
      timeout?: string;
    };
  };
}

export interface ProviderConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  format: 'anthropic' | 'openai';
}
