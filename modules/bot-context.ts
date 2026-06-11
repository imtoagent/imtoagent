// Bot 上下文 — 网关与代理之间的动态上下文传递
// 同一进程内共享，网关在 spawn CLI 前设置当前 bot，代理在处理请求时读取

import type { IMCapabilities } from './types';
import type { ModelAliases } from './proxy/anthropic-proxy';
import type { ToolRegistry } from './agent/tool-registry';
import type { HookRunner } from './core/hook-runner';

export type { ModelAliases };

export interface BotContextData {
  botName: string;
  /** Bot ID (used in workspace directory path: ~/.imtoagent/workspaces/<botId>/) */
  botId?: string;
  caps: IMCapabilities | null;
  /** 当前 Bot 正在使用的模型（如 "deepseek/deepseek-v4-flash"） */
  activeModel?: string;
  /** Bot 级别的模型别名（/model 命令修改后传入，优先级高于全局 config.json） */
  modelAliases?: ModelAliases;
  /** Serialized MCP servers (system + bot merged) */
  mcpInfo?: { servers: Array<{ name: string; enabled: boolean; command: string }> };
  /** Installed skills (system + bot merged) */
  skillsInfo?: { skills: Array<{ name: string; description?: string }> };
  /** Custom prompts (system + bot merged) */
  promptsInfo?: { prompts: Array<{ name: string }> };
  /** Notify the IM user directly (for proxy-layer errors, slash commands, etc.) */
  notifyUser?: (msg: string) => Promise<void>;
  /** Tool registry for local tool execution */
  toolRegistry?: ToolRegistry;
  /** Hook runner for before/after lifecycle hooks */
  hookRunner?: HookRunner;
}

let _currentBot: BotContextData | null = null;

/** 网关调用：在 handleMessage 前设置当前 bot */
export function setCurrentBot(ctx: BotContextData | null) {
  _currentBot = ctx;
}

/** 代理调用：读取当前 bot 上下文 */
export function getCurrentBot(): BotContextData | null {
  return _currentBot;
}
