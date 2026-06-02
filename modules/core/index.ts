// ================================================================
// IMtoAgent SDK Core — 入口
// ================================================================
// SDK 核心模块统一导出
// ================================================================

// 类型
export type {
  CallStats,
  Session,
  AgentInput,
  AgentOutput,
  AgentAdapter,
  MessageContext,
  SessionManager,
  ErrorHandler,
  ConfigManager,
  StatsTracker,
  RuntimeConfig,
  ErrorAction,
  ErrorContext,
  BotConfig,
  ProviderConfig,
  HeartbeatRound,
  ScheduledTask,
} from './types';

// Session 管理
export { FileSessionManager } from './session';

// 心跳/定时任务
export {
  HEARTBEAT_ROUNDS_MAX,
  parseHeartbeatTasks,
  stripHeartbeatTasksBlock,
  isHeartbeatContentEffectivelyEmpty,
  hashCode,
  getPhaseOffset,
  parseInterval,
} from './heartbeat';

// Session 解析
export { SessionResolver } from './session-resolver';
export type { ResolveTargetResult } from './session-resolver';

// 输出路由
export {
  isHeartbeatOk,
  isHeartbeatDuplicate,
  filterAndSend,
} from './output-router';
export type { OutputRouteResult } from './output-router';

// 错误处理
export { DefaultErrorHandler } from './error';

// 统计追踪
export { DefaultStatsTracker } from './stats';

// 配置管理
export { FileConfigManager } from './config';

// 运行时
export { AgentRuntime } from './runtime';
