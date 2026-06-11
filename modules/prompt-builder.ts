// ================================================================
// Prompt Builder — 统一的 Agent 系统提示词构建层
// ================================================================
// 职责：
//   1. 加载 Soul（用户自定义指令）
//   2. 构建 IM 能力说明
//   3. 组合成完整 system prompt
//
// 设计原则：
//   - 单一入口：所有 Agent 路径都调用 buildSystemPrompt()
//   - 与 Agent 类型无关：Claude / Codex / 未来任何 Agent 都用同一套
//   - 与 IM 类型无关：通过 IMCapabilities 接口抽象，飞书/微信/Telegram 都行
//   - 无重复：loadSoul、fallback caps、构建逻辑只有一份
// ================================================================

import type { IMCapabilities } from './types';
import { buildCapabilityPrompt } from './capabilities';
import { getSoulDir, getDataDir } from './utils/paths';
import { getCurrentBot } from './bot-context';
import * as path from 'path';

// ================================================================
// 默认终端能力（无 IM 模块时的 fallback）
// 唯一数据源 — 所有模块都用这个
// ================================================================
export const DEFAULT_TERMINAL_CAPS: IMCapabilities = {
  text: true,
  codeBlock: true,
  cardMessage: false,
  fileSend: false,
  imageSend: false,
  buttonAction: false,
  maxTextLength: 50000,
};

// ================================================================
// Soul 加载
// ================================================================
// 从 ~/Desktop/imtoagent/soul/{botName}/ 按顺序加载
// 加载顺序：rules → identity → profile → workspace → skills
// ================================================================
export function loadSoul(botKey: string): string {
  const soulOrder = ['rules.md', 'identity.md', 'profile.md', 'workspace.md', 'skills.md'];
  const parts: string[] = [];
  try {
    if (!botKey) return '';
    const soulDir = getSoulDir(botKey);
    const fs = require('fs');
    if (!fs.existsSync(soulDir)) return '';
    for (const file of soulOrder) {
      const fp = soulDir + '/' + file;
      if (fs.existsSync(fp)) {
        const content = fs.readFileSync(fp, 'utf-8').trim();
        if (content) parts.push(content);
      }
    }
  } catch {}
  return parts.join('\n\n');
}

// ================================================================
// 上下文接口
// ================================================================
export interface PromptBuilderContext {
  /** IM 模块实例，用于动态获取当前能力 */
  imModule?: { getCapabilities(): IMCapabilities } | null;
  /** 当 imModule 不可用时，手动指定的能力 */
  caps?: IMCapabilities | null;
  /** Bot 名称，用于加载 Soul */
  botKey: string;
  /** Bot ID (workspace directory name), used to resolve HEARTBEAT.md path */
  botId?: string;
  /** Agent 特有的额外系统提示（如工具使用指南、工作目录约束等） */
  agentInstructions?: string;
  /** Optional: Available MCP servers summary */
  mcpInfo?: { servers: Array<{ name: string; enabled: boolean; command: string }> };
  /** Optional: Installed skills summary */
  skillsInfo?: { skills: Array<{ name: string; description?: string }> };
  /** Optional: Custom prompts summary */
  promptsInfo?: { prompts: Array<{ name: string }> };
  /** Optional: Current model identity (e.g. "deepseek/deepseek-v4-flash") — injected so model knows its own identity */
  modelInfo?: string;
  /** Optional: Dynamic runtime context (time, working directory, trigger source, chat type) */
  runtimeContext?: {
    /** Current local time string, e.g. "2026-06-07 18:30 (Asia/Shanghai, Saturday)" */
    currentTime?: string;
    /** Current working directory for this message */
    workingDir?: string;
    /** How this message was triggered: "user_message" | "heartbeat" | "scheduled_task" | "goal_reminder" */
    trigger?: string;
    /** Chat type context if available: "direct" | "group" | "topic" */
    chatType?: string;
  };
}

// ================================================================
// 主入口：构建完整 system prompt
// ================================================================
// 组合顺序（从上到下，优先级递减）：
//   1. Agent 特有指令（最高优先级，Agent 最关心）
//   2. IM 能力说明（告诉 Agent 输出格式约束）
//   3. Soul / 用户自定义指令（长期人格和规则）
// ================================================================
export function buildSystemPrompt(ctx: PromptBuilderContext): string {
  const sections: string[] = [];

  // 0. Soul（用户定义的身份/人格/规则）— 最高优先级
  const soul = loadSoul(ctx.botKey);
  if (soul) {
    sections.push('# User-Defined Instructions (IMtoAgent Soul)\n\n' + soul);
  }

  // 0.5. 模型/后端技术标识 — 让模型知道自身技术上下文
  if (ctx.modelInfo) {
    const parts = ctx.modelInfo.split('/');
    const provider = parts.length >= 2 ? parts[0] : '';
    const model = parts.length >= 2 ? parts.slice(1).join('/') : parts[0];
    sections.push(`# Technical Context\n\n- Backend model: ${model}` + (provider ? ` (${provider})` : '') + `\n- This is your underlying reasoning engine. Your identity and behavior are defined by the Soul section above.`);
  }

  // 1. 动态运行时上下文 — 让模型知道当前时间、工作目录、触发来源等
  if (ctx.runtimeContext) {
    const rc = ctx.runtimeContext;
    const lines: string[] = [];
    if (rc.currentTime) lines.push(`- Current time: ${rc.currentTime}`);
    if (rc.workingDir) lines.push(`- Working directory: ${rc.workingDir}\n  All file operations should be relative to this directory unless otherwise specified.`);
    if (rc.trigger) lines.push(`- Trigger: ${rc.trigger}`);
    if (rc.chatType) lines.push(`- Chat type: ${rc.chatType}`);
    if (lines.length > 0) {
      sections.push(`# Runtime Context\n\n${lines.join('\n')}`);
    }
  }

  // 1. Agent 特有指令
  if (ctx.agentInstructions) {
    sections.push(ctx.agentInstructions.trim());
  }

  // 2. IM 能力
  const caps = ctx.imModule?.getCapabilities() ?? ctx.caps ?? DEFAULT_TERMINAL_CAPS;
  const capSection = buildCapabilityPrompt(caps);
  sections.push('# Current IM Capabilities\n\n' + capSection);

  // 3. Gateway logs (Agent can proactively query)
  sections.push(`# Gateway Runtime Logs

Gateway runtime logs: ~/.imtoagent/logs/imtoagent.log

You can check logs to understand gateway status, troubleshoot issues, and detect restart events:
- \`tail -n 30 ~/.imtoagent/logs/imtoagent.log\` — Last 30 lines
- \`grep -i "restart\|reload\|shutdown\|SIGTERM" ~/.imtoagent/logs/imtoagent.log | tail -n 10\` — Restart/shutdown records
- \`grep -i "error\|fail\|crash" ~/.imtoagent/logs/imtoagent.log | tail -n 10\` — Error records
- \`grep -i "online\|connected\|disconnected" ~/.imtoagent/logs/imtoagent.log | tail -n 10\` — Bot connection status

Note: Your first message after startup may have lost conversation memory (if the gateway restarted). Check logs first to understand the context.`);

  // 3.2. Self-Query (Agent can introspect IMtoAgent status/config)
  sections.push(`# IMtoAgent Self-Query

You can use the \`imtoagent\` CLI to introspect your own runtime:
- \`imtoagent status\` — Gateway running status (PID, config, bots)
- \`imtoagent config list\` — List all configured Bots
- \`imtoagent config show <name>\` — Show Bot details (IM, backend, heartbeat, etc.)
- \`imtoagent stats\` / \`imtoagent stats --today\` / \`imtoagent stats --week\` — Usage statistics
- \`imtoagent logs -n N\` — Last N log lines (equivalent to \`tail -n N ~/.imtoagent/logs/imtoagent.log\`)
- \`imtoagent doctor\` — Diagnose & fix configuration issues
- \`imtoagent health\` — Run comprehensive health check

These commands let you answer user questions like "what model am I using?" or "show me recent activity" without guessing.`);

  // 3.5. Scheduled Tasks
  const botId = (ctx as Record<string, unknown>).botId as string | undefined;
  const heartbeatPath = botId ? `~/.imtoagent/workspaces/${botId}/HEARTBEAT.md` : `~/.imtoagent/workspaces/<botId>/HEARTBEAT.md`;
  sections.push(`# Scheduled Tasks

- Scheduled tasks are managed by the **TaskPoller** — an independent scheduler that detects due tasks and invokes the Agent (LLM) to execute them.
- The **HeartbeatScheduler** schedules Goal/Task reminders (does not directly invoke the LLM).
- Your heartbeat/task file: \`${heartbeatPath}\`
- Use the \`imtoagent task\` CLI to manage: \`imtoagent task list\` / \`imtoagent task add name=X type=interval interval=5m prompt='...'\` / \`imtoagent task remove name=X\` / \`imtoagent task update name=X 字段=值\`
- Run \`imtoagent task help\` for full usage.
- Do NOT edit HEARTBEAT.md directly; always use the CLI.

For operational procedures (startup, restart, upgrade, troubleshooting), refer to the operations manual at:
\`~/.imtoagent/ops.md\`.`);

  // 4. Available Resources (MCP / Skills / Prompts)
  const resourceSections: string[] = [];

  if (ctx.mcpInfo?.servers.length) {
    const rows = ctx.mcpInfo.servers
      .map(s => `| ${s.name} | ${s.enabled ? '✅ enabled' : '❌ disabled'} | ${s.command} |`)
      .join('\n');
    resourceSections.push(`## MCP Servers\n\n| Server | Status | Command |\n|--------|--------|----------|\n${rows}`);
  }

  if (ctx.skillsInfo?.skills.length) {
    const rows = ctx.skillsInfo.skills
      .map(s => `| ${s.name} | ${s.description?.slice(0, 80) || ''} |`)
      .join('\n');
    resourceSections.push(`## Installed Skills\n\n| Skill | Description |\n|-------|-------------|\n${rows}`);
  }

  if (ctx.promptsInfo?.prompts.length) {
    const rows = ctx.promptsInfo.prompts.map(p => `| ${p.name} |`).join('\n');
    resourceSections.push(`## Custom Prompts\n\n| Prompt |\n|--------|\n${rows}`);
  }

  if (resourceSections.length > 0) {
    sections.push('# Available Resources\n\n' + resourceSections.join('\n\n'));
  }

  return sections.join('\n\n---\n\n');
}

// ================================================================
// Convenience: resolve capabilities directly (eliminate inline fallbacks)
// ================================================================
export function resolveCapabilities(
  imModule?: { getCapabilities(): IMCapabilities } | null,
  fallback?: IMCapabilities | null
): IMCapabilities {
  return imModule?.getCapabilities() ?? fallback ?? DEFAULT_TERMINAL_CAPS;
}

// ================================================================
// 统一上下文构建 — 消除 index.ts 和 codex-proxy.ts 的参数组装重复
// ================================================================

const _WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** 获取当前模型标识（config.json activeModel） */
function _getActiveModel(): string | undefined {
  try {
    const fs = require('fs');
    const configPath = path.join(getDataDir(), 'config.json');
    const cfg = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    return cfg.activeModel;
  } catch {
    return undefined;
  }
}

/** 格式化当前时间为 "YYYY-MM-DD HH:MM (Asia/Shanghai, DayOfWeek)" */
function _formatShanghaiTime(): string {
  const tz = require('./core/timezone');
  const parts = tz.getShanghaiDateParts();
  return `${parts.year}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')} ${String(parts.hour).padStart(2, '0')}:${String(parts.minute).padStart(2, '0')} (${tz.TZ}, ${_WEEKDAYS[parts.weekday]})`;
}

/** 从原始请求文本中提取工作目录（Codex 代理的 <cwd> 标记） */
function _extractCwdFromRawText(rawText?: string): string | undefined {
  if (!rawText) return undefined;
  const m = rawText.match(/<cwd>(.*?)<\/cwd>/s);
  return m?.[1];
}

export interface UnifiedPromptOptions {
  /** 工作目录 */
  workingDir?: string;
  /** 触发来源：user_message | heartbeat | scheduled_task | goal_reminder */
  trigger?: string;
  /** 聊天类型：direct | group | topic */
  chatType?: string;
  /** 原始请求文本（用于提取 cwd，仅 Codex 路径） */
  rawText?: string;
}

/**
 * 统一构建 PromptBuilderContext。
 * 两条路径（index.ts / codex-proxy.ts）都调用此函数，不再各自拼参数。
 */
export function buildPromptContext(
  base: Omit<PromptBuilderContext, 'modelInfo' | 'runtimeContext'>,
  opts: UnifiedPromptOptions = {},
): PromptBuilderContext {
  // modelInfo 统一从 Bot 上下文内部获取，调用方无需关心
  const currentBot = getCurrentBot();
  const modelInfo = currentBot?.activeModel || _getActiveModel();
  const workingDir = opts.workingDir || _extractCwdFromRawText(opts.rawText);
  const botId = (base as any).botId || currentBot?.botId;
  return {
    ...base,
    botId,
    modelInfo,
    runtimeContext: {
      currentTime: _formatShanghaiTime(),
      ...(workingDir ? { workingDir } : {}),
      trigger: opts.trigger || 'user_message',
      chatType: opts.chatType || 'direct',
    },
  };
}
