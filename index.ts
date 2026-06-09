// ============================================================
// CC 路由 v4 — 多 Bot 架构（SDK 完整接入版）
// ============================================================

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// ===== 重启信号文件路径（统一固定，不依赖 getDataDir） =====
const RESTART_SIGNAL_PATH = path.join(process.env.HOME!, '.imtoagent', '.restart_requested');

// ===== 启动时日志轮转 =====
function rotateStartupLogs(): void {
  const MAX_LOG_SIZE = 10 * 1024 * 1024; // 10MB
  const MAX_ROTATED = 5;
  const logsDir = path.join(process.env.HOME!, '.imtoagent', 'logs');
  const candidates = [
    path.join(logsDir, 'stdout.log'),
    path.join(logsDir, 'imtoagent.log'),
    path.join(process.cwd(), 'logs', 'stdout.log'),
  ];
  // 也清理 /tmp/imtoagent.log（nohup 输出）
  const tmpLog = '/tmp/imtoagent.log';
  if (fs.existsSync(tmpLog)) {
    try {
      const stats = fs.statSync(tmpLog);
      if (stats.size > MAX_LOG_SIZE) {
        // 轮转: .5 删除, .4→.5, ..., 无后缀→.1
        for (let i = MAX_ROTATED - 1; i >= 1; i--) {
          const src = `${tmpLog}.${i}`;
          const dst = `${tmpLog}.${i + 1}`;
          if (fs.existsSync(src)) {
            if (i + 1 > MAX_ROTATED) fs.unlinkSync(src);
            else fs.renameSync(src, dst);
          }
        }
        fs.renameSync(tmpLog, `${tmpLog}.1`);
        console.error(`[Startup] Rotated /tmp/imtoagent.log (${(stats.size / 1024).toFixed(0)}KB)`);
      }
    } catch {}
  }
  // 清理超过 24 小时未更新的死 stdout.log
  for (const logPath of candidates) {
    try {
      if (!fs.existsSync(logPath)) continue;
      const stats = fs.statSync(logPath);
      const ageHours = (Date.now() - stats.mtimeMs) / 3600000;
      if (ageHours > 24) {
        fs.unlinkSync(logPath);
        console.error(`[Startup] Deleted stale log: ${logPath} (${Math.round(ageHours)}h old)`);
      }
    } catch {}
  }
}

import * as Lark from '@larksuiteoapi/node-sdk';
import {
  sharedState, loadProviders, getProviderConfig, saveActiveModel,
  loadSessionConfig, saveSessionConfig,
  saveSessionMemory, loadSessionMemory, deleteSessionMemory, listPersistedSessions,
  resolveModel, ModelAliases, SessionMemoryData
} from './modules/proxy/anthropic-proxy';
import { parseToBlocks } from './modules/capabilities';
import { resolveCapabilities } from './modules/prompt-builder';
import { WorkspaceManager, createWorkspaceManager } from './modules/utils/workspace-manager';
import { migrateWorkspaces } from './modules/utils/migrate-workspaces';
import { migrateConfigs, migrateBotJsonConfigs } from './modules/utils/config-migration';
import { McpManager, McpServerConfig } from './modules/utils/mcp-manager';
import { SkillsManager } from './modules/utils/skills-manager';
import { PromptsManager } from './modules/utils/prompts-manager';
import { FeishuIMModule } from './modules/im/feishu';
import { TelegramAdapter } from './modules/im/telegram';
import { WeComIMModule } from './modules/im/wecom';
import { WeChatIMModule } from './modules/im/wechat';
import type { IMModule } from './modules/types';

// ================================================================
// IM 注册表 — 新增 IM 只需加一行注册，不改 Bot 构造函数
// ================================================================
interface IMFactory {
  create(cfg: BotConfig): IMModule;
}

const IM_REGISTRY = new Map<string, IMFactory>();

function registerIM(type: string, factory: IMFactory) {
  IM_REGISTRY.set(type, factory);
}

// 注册飞书
registerIM('feishu', {
  create(cfg: BotConfig) {
    return new FeishuIMModule({ appId: cfg.appId, appSecret: cfg.appSecret });
  },
});

// 注册 Telegram
registerIM('telegram', {
  create(cfg: BotConfig) {
    return new TelegramAdapter({ token: cfg.appId, proxy: (cfg as any).proxy });
  },
});

// 注册企业微信（扫码绑定，无需预填凭证）
registerIM('wecom', {
  create(cfg: BotConfig) {
    return new WeComIMModule({
      botId: (cfg as any).botId,
      secret: (cfg as any).secret,
    });
  },
});

// 注册个人微信
registerIM('wechat', {
  create(cfg: BotConfig) {
    return new WeChatIMModule({
      botId: (cfg as any).botId,
      botToken: (cfg as any).botToken,
      ilinkUserId: (cfg as any).ilinkUserId,
    });
  },
});
import { startAnthropicProxy, stopAnthropicProxy } from './modules/proxy/anthropic-proxy';
import { initCodexProxyConfig, resolveSupportedInputTypes, updateCodexConfig } from './modules/proxy/codex-proxy';
import { checkRateLimit, setRateLimitConfig } from './modules/rate-limiter';
import { setCurrentBot } from './modules/bot-context';
import { getDataDir, getSessionsDir, getBotsDir, getSoulDir, getBotKey, getRestoreMarkerPath } from './modules/utils/paths';
import { TimezoneManager, formatShanghaiTimeShort } from './modules/core/timezone';

// ===== SDK 核心 =====
import { AgentRuntime, FileSessionManager, DefaultErrorHandler, DefaultStatsTracker } from './modules/core';
import { HeartbeatScheduler } from './modules/core/heartbeat-scheduler';
import { TaskManager } from './modules/core/task-manager';
import { Watchdog } from './modules/core/watchdog';
import { ClaudeAdapter } from './modules/agent/claude-adapter';
import { CodexAdapter } from './modules/agent/codex-adapter';
import { OpenCodeAdapter } from './modules/agent/opencode-adapter';
import { GeminiAdapter } from './modules/agent/gemini-adapter';
import type { CallStats, Session, AgentAdapter, MessageAttachment } from './modules/core/types';
import { startOpenCodeServer, stopOpenCodeServer } from './modules/agent/opencode-adapter';

// ===== 全局活跃请求计数 =====
let activeRequests = 0;
let isShuttingDown = false;

// ================================================================
// 解析飞书消息内容
// ================================================================
function parseMessage(content: string): string {
  try { return (JSON.parse(content).text || '').trim(); }
  catch { return content.trim(); }
}

// ================================================================
// 工具函数
// ================================================================
/**
 * 解析任务命令参数: name=xxx type=interval interval=5m prompt='任务描述'
 */
function parseTaskArgs(args: string): Record<string, string> {
  const params: Record<string, string> = {};
  const regex = /(\w+)=('[^']*'|"[^"]*"|\S+)/g;
  let match;
  while ((match = regex.exec(args)) !== null) {
    params[match[1]] = match[2].replace(/^['"]|['"]$/g, '');
  }
  return params;
}

function levenshteinDistance(a: string, b: string): number {
  const m = Array(b.length + 1).fill(null).map(() => Array(a.length + 1).fill(null));
  for (let i = 0; i <= a.length; i++) m[0][i] = i;
  for (let j = 0; j <= b.length; j++) m[j][0] = j;
  for (let j = 1; j <= b.length; j++)
    for (let i = 1; i <= a.length; i++)
      m[j][i] = Math.min(m[j][i-1]+1, m[j-1][i]+1, m[j-1][i-1]+(a[i-1]===b[j-1]?0:1));
  return m[b.length][a.length];
}

function findSimilarCommand(input: string, cmds: Map<string, any>): string[] {
  return [...cmds.keys()].filter(c => levenshteinDistance(input, c) <= 2 && levenshteinDistance(input, c) > 0).slice(0, 3);
}

// ================================================================
// 命令类型
// ================================================================
interface CommandCtx {
  chatId: string;
  args: string;
  session: Session | undefined;
}
type CommandHandler = (ctx: CommandCtx) => Promise<string> | string;

// ================================================================
// BotConfig
// ================================================================
interface BotConfig {
  id?: string;
  name: string;
  appId: string;
  appSecret: string;
  backend: 'claude' | 'codex' | 'opencode' | 'gemini';
  cwd?: string;
  isAdmin?: boolean;  // true = 可以修改网关配置，默认第一个 Bot 为 true
  /** 心跳配置（L1 新增） */
  heartbeat?: {
    interval?: string;
    target?: { channel?: string; chatId?: string };
    visibility?: { showAlerts?: boolean; showOk?: boolean };
    prompt?: string;
    maxHeartbeatRounds?: number;
  };
}

// ================================================================
// Bot 类 — SDK 完整接入版
// ================================================================
class Bot {
  id: string;
  name: string;
  backend: 'claude' | 'codex' | 'opencode' | 'gemini';
  appId: string;
  appSecret: string;
  defaultCwd: string;
  activeModel: string;
  modelAliases: ModelAliases;
  modelPresets: Record<string, string>;
  soul: string;
  client: Lark.Client;
  im: IMModule;
  isAdmin: boolean;
  config: any;
  /** 原始 Bot 级配置（L1 新增：用于访问 heartbeat 等 Bot 级配置） */
  botConfig: BotConfig;
  workspaceManager: WorkspaceManager;

  // SDK
  runtime: AgentRuntime;
  sessionManager: FileSessionManager;
  commands: Map<string, CommandHandler> = new Map();
  adapter: AgentAdapter;
  /** 正在执行的任务的取消信号（chatId → AbortController） */
  activeControllers: Map<string, AbortController> = new Map();
  /** Resource managers — system-level (shared) */
  systemMcp: McpManager;
  systemSkills: SkillsManager;
  systemPrompts: PromptsManager;
  /** Resource managers — bot-level (per-bot) */
  botMcp: McpManager;
  botSkills: SkillsManager;
  botPrompts: PromptsManager;
  /** 心跳调度器（L1 新增） */
  heartbeatScheduler: HeartbeatScheduler | null = null;
  /** 任务管理器（Phase 3） */
  taskManager: TaskManager | null = null;
  /** 健康检查（L2） */
  watchdog: Watchdog | null = null;

  constructor(cfg: BotConfig, globalConfig: any, workspaceManager: WorkspaceManager) {
    this.id = cfg.id || cfg.name; // 后向兼容：无 id 时用 name
    this.name = cfg.name;
    this.backend = cfg.backend;
    this.appId = cfg.appId;
    this.appSecret = cfg.appSecret;
    this.defaultCwd = cfg.cwd || globalConfig.system?.defaultProjectDir || path.join(os.homedir(), 'Projects');
    this.config = globalConfig;
    this.botConfig = cfg;
    this.isAdmin = cfg.isAdmin !== undefined ? cfg.isAdmin : true; // 默认 true（后向兼容老用户）
    this.workspaceManager = workspaceManager;

    // 确保工作空间目录存在
    const botKey = this.id;
    this.workspaceManager.ensureWorkspace(botKey);

    // Bot 级模型配置
    const botCfg = this._loadBotConfig();
    this.activeModel = botCfg.activeModel
      || (globalConfig as any).activeModel
      || globalConfig.defaultModel
      || 'deepseek/deepseek-v4-pro';
    this.modelAliases = botCfg.modelAliases || globalConfig.modelAliases || {};
    this.modelPresets = botCfg.modelPresets || {
      fast: 'deepseek/deepseek-v4-flash',
      pro: 'deepseek/deepseek-v4-pro',
    };

    // 灵魂
    this._initSoul();
    this.soul = this._loadSoul();

    // IM 适配器工厂
    const imType = cfg.im || 'feishu';

    // Lark.Client 仅飞书需要
    if (imType === 'feishu') {
      this.client = new Lark.Client({
        appId: this.appId,
        appSecret: this.appSecret,
        loggerLevel: Lark.LoggerLevel.info,
      });
    }

    const imFactory = IM_REGISTRY.get(imType);
    if (!imFactory) {
      const known = [...IM_REGISTRY.keys()].join(', ');
      throw new Error(`Unsupported IM type: ${imType} (registered: ${known})`);
    }
    this.im = imFactory.create(cfg);

    // ===== SDK 集成 =====
    const workspacePath = this.workspaceManager.getWorkspacePath(this.id);
    this.sessionManager = new FileSessionManager();

    // Resource managers — system-level (shared across all bots)
    this.systemMcp = new McpManager();
    this.systemSkills = new SkillsManager();
    this.systemPrompts = new PromptsManager();
    // Resource managers — bot-level (isolated per bot)
    this.botMcp = new McpManager(this.id);
    this.botSkills = new SkillsManager(this.id);
    this.botPrompts = new PromptsManager(this.id);

    const adapterCtx = {
      imModule: this.im,
      botName: this.name,
      modelAliases: this.modelAliases,
      workspacePath,
    };

    if (this.backend === 'claude') {
      this.adapter = new ClaudeAdapter(adapterCtx);
    } else if (this.backend === 'codex') {
      this.adapter = new CodexAdapter(adapterCtx);
    } else if (this.backend === 'opencode') {
      const ocCfg = globalConfig.opencode || {};
      this.adapter = new OpenCodeAdapter({
        ...adapterCtx,
        serverUrl: ocCfg.serverUrl,
        defaultModel: ocCfg.defaultModel,
      });
    } else if (this.backend === 'gemini') {
      this.adapter = new GeminiAdapter(adapterCtx);
    } else {
      throw new Error(`Unknown backend: ${this.backend}`);
    }

    this.runtime = new AgentRuntime({
      sessionManager: this.sessionManager,
      errorHandler: new DefaultErrorHandler(),
      configManager: undefined as any,
      statsTracker: new DefaultStatsTracker(),
    });

    this.runtime.registerAdapter(this.backend, this.adapter);

    // 注册命令
    this._registerCommands();

    // L1: 初始化心跳调度器（如果配置了 interval）
    this._initHeartbeat();
  }

  // ===== 灵魂管理 =====
  _soulDir() {
    return this.workspaceManager.getSoulPath(this.id);
  }

  _initSoul() {
    const dir = this._soulDir();
    try {
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const hasFiles = fs.readdirSync(dir).some((f: string) => f.endsWith('.md'));
      if (hasFiles) return;
      // 根据 isAdmin 生成不同的 rules.md
      const rulesMd = this.isAdmin
        ? '# Bot Rules\n\nYou are an **admin Bot** with full gateway management privileges.\n\n- You can modify IMtoAgent configuration (config.json, providers, Bot management)\n- You have access to any directory (global workspace mode)\n- Sensitive information such as project keys, tokens, and passwords must not be leaked\n- Destructive commands must not be executed without explicit confirmation'
        : '# Bot Rules\n\nYou are a **non-admin Bot** with restricted privileges.\n\n- ⛔ NEVER modify any files under ~/.imtoagent/ (config.json, providers.json, etc.)\n- ⛔ NEVER read or expose gateway configuration contents\n- ⛔ NEVER attempt to add, remove, or modify Bot configurations\n- Your working directory is limited to your assigned workspace\n- All file operations must stay within your workspace boundary\n- Sensitive information such as project keys, tokens, and passwords must not be leaked\n- Destructive commands must not be executed without explicit confirmation';

      const defaults: Record<string, string> = {
        'rules.md': rulesMd,
        'identity.md': `# Identity\n\n- I am an AI programming assistant connected via IMtoAgent\n- I run on the ${this.backend === 'codex' ? 'Codex' : 'Claude Code'} backend\n- Reply in Chinese`,
        'profile.md': '# User Profile\n\nThis file can be modified by the Agent. When the user says "remember xxx" or "I prefer xxx", the Agent should update this file.\n\n## Modification Guide (Agent Only)\n\nRead this file → Add/delete/modify entries based on user requests → Save',
        'workspace.md': '# Project Environment\n\nAuto-generated by IMtoAgent.',
        'skills.md': '# Skill Injection\n\nFuture feature.',
      };
      for (const [name, content] of Object.entries(defaults)) {
        fs.writeFileSync(dir + '/' + name, content);
      }
      console.log(`[${this.name}] Soul files initialized: ${dir}`);
    } catch (e: any) {
      console.error(`[${this.name}] Failed to initialize soul: ${e.message}`);
    }
  }

  _loadSoul(): string {
    const order = ['rules.md', 'identity.md', 'profile.md', 'workspace.md', 'skills.md'];
    const parts: string[] = [];
    try {
      const dir = this._soulDir();
      if (!fs.existsSync(dir)) return '';
      for (const file of order) {
        const fp = dir + '/' + file;
        if (fs.existsSync(fp)) {
          const c = fs.readFileSync(fp, 'utf-8').trim();
          if (c) parts.push(c);
        }
      }
    } catch {}

    // Inject config CLI reference — so the Agent knows how to manage Bots via natural language
    const adminTag = this.isAdmin ? '' : ' (you are a non-admin Bot — you cannot use these commands, tell the user to use an admin Bot)';
    const bt = String.fromCharCode(96);  // backtick
    const fence = bt + bt + bt;
    const cliRef = '## IMtoAgent Config CLI' +
      '\n\nYou can manage Bot configurations via these CLI commands:' + adminTag +
      '\n\n' + fence + 'bash' +
      '\nimtoagent config list              # List all Bots' +
      '\nimtoagent config show <BotName>    # Show a Bot\'s details' +
      '\nimtoagent config add               # Add a new Bot (interactive)' +
      '\nimtoagent config remove <BotName>  # Remove a Bot' +
      '\nimtoagent config modify <BotName>  # Modify a Bot\'s settings' +
      '\nimtoagent restore                  # Hot-reload after config changes' +
      '\nimtoagent doctor                   # Diagnose config issues' +
      '\n' + fence +
      '\n\nWhen the user asks to manage Bots, use these commands. After changes, run ' + bt + 'imtoagent restore' + bt + '.';
    parts.push(cliRef);

    return parts.join('\n\n');
  }

  _soulFiles(): string[] {
    try {
      const dir = this._soulDir();
      if (!fs.existsSync(dir)) return [];
      return fs.readdirSync(dir).filter((f: string) => f.endsWith('.md')).sort();
    } catch { return []; }
  }

  // ===== Bot 配置 =====
  /** Bot 级配置路径：统一在 ~/.imtoagent/bots/<Bot>/bot-config.json */
  _botConfigPath() { return path.join(getDataDir(), 'bots', this.id, 'bot-config.json'); }

  _loadBotConfig() {
    const botsPath = this._botConfigPath();
    const fallbackPath = path.join(getSessionsDir(), this.id, '_bot.json');

    // 优先读新版路径
    try {
      if (fs.existsSync(botsPath)) return JSON.parse(fs.readFileSync(botsPath, 'utf-8'));
    } catch {}

    // 后向兼容旧路径
    try {
      if (fs.existsSync(fallbackPath)) return JSON.parse(fs.readFileSync(fallbackPath, 'utf-8'));
    } catch {}

    return {};
  }

  _saveBotConfig() {
    try {
      const botsPath = this._botConfigPath();
      const dir = path.dirname(botsPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(botsPath, JSON.stringify({
        activeModel: this.activeModel,
        modelAliases: this.modelAliases,
        modelPresets: this.modelPresets,
      }, null, 2));
    } catch (e: any) {
      console.error(`[${this.name}] Failed to save config:`, e.message);
    }
  }

  /** 同步模型到 config.json，确保重启后不丢失（已简化：只写 activeModel） */
  _syncCodexModelToConfigJson(modelSpec: string) {
    // activeModel 已统一在 config.json 根级，saveActiveModel() 已处理持久化
    // 保留 codex.model 字段用于旧版兼容（不再主动写入）
    // 重启时 codex-proxy 的 getConfig() 会优先解析 activeModel
  }

  // ===== 命令注册 =====
  _registerCommands() {
    const cmd = (name: string, handler: CommandHandler) => this.commands.set(name, handler);

    cmd('/help', () => {
      let out = '📋 **CC Quick Commands**\n\n';
      out += '/status — Status\n/info — Config\n/stats — Stats\n';
      out += '/model — Model Switch\n/providers — Providers\n';
      out += '/dir — Directory\n/clear — Clear\n/stop — Stop current task\n';
      if (this.backend === 'claude') out += '/mode — Permission\n';
      else if (this.backend === 'codex') out += '/mode — Mode(auto/plan)\n';
      out += '/memory — Overview\n/soul — Soul\n/reload — Reload\n';
      out += '/tasks — List tasks\n/task-add — Add task\n/task-remove — Remove task\n/task-update — Update task';
      return out;
    });

    cmd('/status', ({ session }) =>
      session?.running
        ? `✅ ${this.backend} running | ${this.activeModel} | ${session.stats.calls} calls`
        : `⏸ ${this.backend} idle | ${this.activeModel}`);

    cmd('/info', ({ session }) =>
      `🤖 ${this.name} (${this.backend})${this.isAdmin ? ' ⭐' : ''}\nModel: ${this.activeModel}\nDirectory: ${session?.cwd || this.defaultCwd}\nSessions: ${this.sessionManager.listActive(this.id).length}`);

    cmd('/stats', ({ session }) => {
      if (!session || session.stats.calls === 0) return '📊 No calls yet';
      const s = session.stats;
      return `📊 ${s.calls} calls | ${s.totalTurns} turns\nTokens: ${s.totalInputTokens.toLocaleString()} in + ${s.totalOutputTokens.toLocaleString()} out\nCost: $${s.totalCostUSD.toFixed(4)} | Duration ${(s.totalDurationMs/1000).toFixed(0)}s`;
    });

    cmd('/clear', ({ session }) => {
      if (session) {
        session.startFresh = true;
        return '🗑 Conversation cleared (next message will start a fresh session)';
      }
      return '✅ No active conversation';
    });

    cmd('/stop', ({ chatId }) => {
      const ctrl = this.activeControllers.get(chatId);
      if (!ctrl) return '✅ 没有正在执行的任务';
      ctrl.abort();
      return '⏹️ 任务已取消';
    });

    cmd('/model', ({ args }) => {
      const raw = args.trim();
      if (!raw) {
        let out = `🤖 Current: ${this.activeModel}`;
        if ((this.backend === 'claude' || this.backend === 'opencode') && this.modelAliases) {
          if (this.backend === 'claude') {
            out += '\n\n🎭 Role Mapping (Claude internal role → model):';
            for (const role of ['default', 'sonnet', 'opus', 'haiku', 'best']) {
              const spec = this.modelAliases[role as keyof ModelAliases];
              if (spec) out += `\n• ${role} → ${spec}`;
            }
            out += '\n💡 /model sonnet provider/model to modify role mapping';
          } else if (this.backend === 'opencode') {
            out += '\n\n🎭 Role Mapping:';
            const spec = (this.modelAliases as any).opencode;
            if (spec) out += `\n• opencode → ${spec}`;
            out += '\n💡 /model opencode provider/model to modify mapping';
          }
        }
        const presets = Object.entries(this.modelPresets || {});
        if (presets.length > 0) {
          out += '\n\n⚡ Quick Switch:';
          for (const [alias, spec] of presets) {
            const mark = spec === this.activeModel ? ' ✅' : '';
            out += `\n• /model ${alias} → ${spec}${mark}`;
          }
        }
        out += '\n\n📋 /model add <alias> <model> — Add preset';
        out += '\n🗑  /model del <alias> — Delete preset';
        out += '\n🔀 /model provider/model — Direct switch';
        return out;
      }

      if (raw.startsWith('add ')) {
        const rest = raw.slice(4).trim();
        const space = rest.indexOf(' ');
        if (space < 0) return '❌ Usage: /model add <alias> <provider/model>';
        const alias = rest.slice(0, space).trim();
        const spec = rest.slice(space + 1).trim();
        if (!this.modelPresets) this.modelPresets = {};
        this.modelPresets[alias] = spec;
        this._saveBotConfig();
        return `✅ Preset added: ${alias} → ${spec}`;
      }

      if (raw.startsWith('del ')) {
        const alias = raw.slice(4).trim();
        if (!this.modelPresets || !this.modelPresets[alias]) return `❌ Preset not found: ${alias}`;
        delete this.modelPresets[alias];
        this._saveBotConfig();
        return `🗑 Preset deleted: ${alias}`;
      }

      // 角色别名
      if ((this.backend === 'claude' && ['default', 'sonnet', 'opus', 'haiku', 'best'].includes(raw)) ||
          (this.backend === 'opencode' && raw === 'opencode')) {
        const spec = (this.modelAliases as any)[raw] || this.modelAliases[raw as keyof typeof this.modelAliases];
        if (spec) return `🎭 ${raw} → ${spec}\n💡 Modify: /model ${raw} provider/model`;
        return `❌ Role not set: ${raw}`;
      }

      // 预设
      if (this.modelPresets && this.modelPresets[raw]) {
        const spec = this.modelPresets[raw];
        const cfg = getProviderConfig(spec);
        if (!cfg) return `❌ Preset target invalid: ${spec}`;
        this.activeModel = spec;
        this.modelAliases.default = spec;
        this._saveBotConfig();
        // 持久化到 config.json.activeModel（唯一持久化位置）
        saveActiveModel(spec);
        // 更新全局代理配置（无匹配前缀时的回退目标）
        sharedState.activeConfig = cfg;
        if (this.backend === 'codex') {
          updateCodexConfig(spec);
        }
        return `🤖 Switched: ${spec} (${raw})`;
      }

      // 角色映射修改 (Claude/OpenCode)
      if (this.backend === 'claude' || this.backend === 'opencode') {
        const space = raw.indexOf(' ');
        if (space > 0) {
          const role = raw.slice(0, space).trim();
          const spec = raw.slice(space + 1).trim();
          const validRoles = this.backend === 'opencode' ? ['opencode'] : ['default', 'sonnet', 'opus', 'haiku', 'best'];
          if (validRoles.includes(role)) {
            const cfg = getProviderConfig(spec);
            if (!cfg) return `❌ Unknown model: ${spec}`;
            (this.modelAliases as any)[role] = spec;
            if (role === 'default') {
              this.activeModel = spec;
              saveActiveModel(spec);
              sharedState.activeConfig = cfg;
            }
            this._saveBotConfig();
            return `🎭 ${role} → ${spec} (updated)`;
          }
        }
      }

      // 直接切换
      const cfg = getProviderConfig(raw);
      if (!cfg) return `❌ Unknown model: ${raw}\n💡 Use /model to see presets`;
      this.activeModel = raw;
      this.modelAliases.default = raw;
      this._saveBotConfig();
      // 持久化到 config.json.activeModel（唯一持久化位置）
      saveActiveModel(raw);
      // 更新全局代理配置（无匹配前缀时的回退目标）
      sharedState.activeConfig = cfg;
      if (this.backend === 'codex') {
        updateCodexConfig(raw);
      }
      return `🤖 Switched: ${raw}`;
    });

    cmd('/providers', () => {
      const providers = loadProviders();
      const list = Object.entries(providers).map(([name, p]: [string, any]) =>
        `• **${name}**: ${(p.models || []).map((m: any) => typeof m === 'string' ? m : m.id).join(', ')}`
      ).join('\n');
      return `📡 **Available Providers**\n\n${list}\n\nCurrent: ${this.activeModel}`;
    });

    cmd('/dir', ({ args, session }) => {
      const dir = args.trim();
      const currentCwd = session?.cwd || this.defaultCwd;
      if (!dir) {
        const mode = this.workspaceManager.getMode();
        return `📁 ${currentCwd}\n🏷 Workspace mode: ${mode}`;
      }

      const resolved = this.workspaceManager.resolveAndValidatePath(this.id, dir, currentCwd);
      if (resolved === null) {
        return `❌ Path not allowed: ${dir}\n💡 In sandbox mode, you can only access paths within your workspace`;
      }

      if (session) session.cwd = resolved;
      return `📁 Switched: ${resolved}`;
    });

    cmd('/mode', ({ args, session }) => {
      const mode = args.trim();
      if (this.backend === 'claude') {
        if (!mode) return `🔐 Current permission: ${session?.permissionMode || 'bypassPermissions'}\nOptions: bypassPermissions | default | plan`;
        if (!['bypassPermissions', 'default', 'plan'].includes(mode))
          return `❌ Invalid: ${mode}\nOptions: bypassPermissions | default | plan`;
        if (session) { session.permissionMode = mode; return `🔐 Switched: ${mode}`; }
        return '❌ No active session';
      }
      if (!mode) {
        const current = session?.codexMode || 'auto';
        return `🔧 Current mode: ${current}\nOptions: auto (execute directly) | plan (plan then execute)`;
      }
      if (!['auto', 'plan'].includes(mode))
        return `❌ Invalid: ${mode}\nOptions: auto | plan`;
      if (session) { session.codexMode = mode; return `🔧 Switched: ${mode}`; }
      return '❌ No active session';
    });

    cmd('/memory', ({ session }) => {
      if (!session) return '📦 No active session';
      const s = session.stats;
      return `🧠 ${this.name} (${this.backend})\nstartFresh: ${session.startFresh || false}\nsdkSession: ${session.metadata?.sdkSessionId?.slice(-8) || session.backendSessionId?.slice(-8) || 'none'}\nCalls: ${s.calls} | Turns: ${s.totalTurns}\nTokens: ${s.totalInputTokens.toLocaleString()} in + ${s.totalOutputTokens.toLocaleString()} out\nCost: $${s.totalCostUSD.toFixed(4)}`;
    });

    cmd('/soul', ({ args }) => {
      if (args.trim() === 'reload') {
        this._initSoul();
        this.soul = this._loadSoul();
        return `🧠 Soul reloaded (${this.soul.length} chars)`;
      }
      const files = this._soulFiles();
      if (files.length === 0) return `🧠 No soul configured\n💡 Create .md files in ${this._soulDir()}/`;
      let out = `🧠 Soul files (${this.soul.length} chars):\n`;
      for (const f of files) {
        const fp = this._soulDir() + '/' + f;
        try {
          const s = fs.statSync(fp);
          const tag = f === 'rules.md' ? ' 🔒' : f === 'profile.md' ? ' ✏️' : '';
          out += `\n• ${f} (${s.size}B)${tag}`;
        } catch { out += `\n• ${f}`; }
      }
      out += '\n\n💡 /soul reload — Reload';
      out += '\n🔒 rules=readonly | ✏️ profile=Agent-writable';
      return out;
    });

    cmd('/reload', async () => {
      await gracefulReload('/reload');
      return '🔄 Reloading...';
    });

    // === P3: 任务管理命令 ===
    cmd('/tasks', ({ args }) => {
      if (!this.taskManager) return '⚠️ 任务系统未初始化';
      const tasks = this.taskManager.listTasks();
      if (tasks.length === 0) return '📋 暂无定时任务';
      const lines = tasks.map(t => {
        const type = t.type ?? 'interval';
        const interval = t.interval ? ` (${t.interval})` : '';
        const prompt = t.prompt ? ` — ${t.prompt.slice(0, 40)}${t.prompt.length > 40 ? '...' : ''}` : '';
        return `• **${t.name}** | ${type}${interval}${prompt}`;
      });
      return `📋 定时任务列表（${tasks.length}个）\n\n${lines.join('\n')}`;
    });

    cmd('/task-add', ({ args }) => {
      if (!this.taskManager) return '⚠️ 任务系统未初始化';
      // 解析参数: /task-add name=xxx type=interval interval=5m prompt='任务描述'
      const params = parseTaskArgs(args);
      if (!params.name || !params.prompt) {
        return '❌ 用法: /task-add name=名称 type=类型 interval=间隔 prompt=描述\n例: /task-add name=disk-check interval=1h prompt="检查磁盘使用率"';
      }
      const task: any = { name: params.name, prompt: params.prompt };
      if (params.type) task.type = params.type;
      if (params.interval) task.interval = params.interval;
      if (params.at) task.at = params.at;
      if (params.after) task.after = params.after;
      if (params.on) task.on = params.on;
      if (params.max_runs) task.max_runs = parseInt(params.max_runs);
      if (params.deadline) task.deadline = params.deadline;
      if (params.on_failure) task.on_failure = params.on_failure;
      if (params.condition) task.condition = params.condition;
      if (params.bot) task.bot = params.bot;

      const result = this.taskManager.addTask(task);
      return result.success ? `✅ 任务 "${params.name}" 已创建` : `❌ ${result.error}`;
    });

    cmd('/task-remove', ({ args }) => {
      if (!this.taskManager) return '⚠️ 任务系统未初始化';
      const name = args.trim();
      if (!name) return '❌ 用法: /task-remove 任务名';
      const result = this.taskManager.removeTask(name);
      return result.success ? `✅ 任务 "${name}" 已删除` : `❌ ${result.error}`;
    });

    cmd('/task-update', ({ args }) => {
      if (!this.taskManager) return '⚠️ 任务系统未初始化';
      // 解析参数: /task-update name=xxx field=value ...
      const params = parseTaskArgs(args);
      if (!params.name) return '❌ 用法: /task-update name=任务名 字段=新值';
      const updates: any = {};
      const allowedFields = ['type', 'interval', 'prompt', 'at', 'after', 'on', 'max_runs', 'deadline', 'on_failure', 'max_retries', 'timeout', 'condition', 'bot'];
      for (const key of Object.keys(params)) {
        if (key !== 'name' && allowedFields.includes(key)) {
          updates[key] = key === 'max_runs' || key === 'max_retries' ? parseInt(params[key]) : params[key];
        }
      }
      if (Object.keys(updates).length === 0) return '❌ 没有要更新的字段';
      const result = this.taskManager.updateTask(params.name, updates);
      return result.success ? `✅ 任务 "${params.name}" 已更新` : `❌ ${result.error}`;
    });
  }

  // ===== 心跳初始化（L1 新增） =====
  _initHeartbeat(): void {
    // Resolve heartbeat config: bot-level → system-level → built-in defaults
    const botHb = (this as any).botConfig?.heartbeat;
    const sysHb = (this as any).config?.system?.heartbeat;
    const hbConfig = botHb || sysHb;
    const interval = hbConfig?.interval || hbConfig?.defaultInterval || "30m";
    const enabled = hbConfig?.enabled !== false && hbConfig?.enabled !== "false";
    if (!enabled) return;

    const workspacePath = this.workspaceManager.getWorkspacePath(this.id);
    const heartbeatFilePath = path.join(workspacePath, 'HEARTBEAT.md');

    // Auto-create HEARTBEAT.md template if it doesn't exist
    try {
      if (!fs.existsSync(heartbeatFilePath)) {
        const defaultTemplate = `# HEARTBEAT.md — 心跳检查清单
# Bot 会按间隔（默认 30 分钟）自动唤醒，读取此文件并执行其中的任务。
# 所有任务完成后，如果一切正常请回复 HEARTBEAT_OK（会被静默拦截）。

## 示例任务（取消注释即可启用）

# - [ ] 检查邮箱是否有未读邮件
# - [ ] 查看今天日程安排
# - [ ] 检查服务器磁盘使用率是否超过 80%

## 规则
# 每次心跳触发时，Bot 会：
# 1. 读取此文件中的任务列表
# 2. 逐项执行或检查
# 3. 汇总结果后回复
# 4. 如果一切正常且无任务需要报告，回复 HEARTBEAT_OK
`;
        fs.writeFileSync(heartbeatFilePath, defaultTemplate, 'utf-8');
        console.log(`[Heartbeat] Created default HEARTBEAT.md: ${heartbeatFilePath}`);
      }
    } catch (e: any) {
      console.error(`[Heartbeat] Failed to create HEARTBEAT.md: ${e.message}`);
    }

    console.log(`[Heartbeat] Init: bot=${this.name}, interval=${interval}, file=${heartbeatFilePath}`);

    // P3: 初始化任务管理器
    this.taskManager = new TaskManager(heartbeatFilePath);

    this.heartbeatScheduler = new HeartbeatScheduler(
      {
        botName: this.name,
        botId: this.id,
        interval,
        heartbeatFilePath,
        defaultCwd: this.defaultCwd,
        model: this.activeModel,
        systemPrompt: this.soul,
        showOk: hbConfig?.visibility?.showOk ?? hbConfig?.showOk ?? false,
        showAlerts: hbConfig?.visibility?.showAlerts ?? hbConfig?.showAlerts ?? true,
        sendMessage: async (chatId: string, text: string) => this.reply(chatId, text),
      },
      this.runtime,
      this.adapter,
      this.sessionManager,
    );

    // Phase 3: 将 GoalManager 注入到 runtime，使 Agent 回复可被拦截
    const gm = this.heartbeatScheduler.getGoalManager();
    if (gm) {
      (this.runtime as any).config.goalManager = gm;
    }
  }

  async tryHandleCommand(chatId: string, text: string, session: Session | undefined): Promise<string | null> {
    if (!text.startsWith('/')) return null;
    const space = text.indexOf(' ');
    const cmdName = space >= 0 ? text.slice(0, space).toLowerCase() : text.toLowerCase();
    const args = space >= 0 ? text.slice(space + 1) : '';
    const handler = this.commands.get(cmdName);
    if (handler) return handler({ chatId, args, session });
    const similar = findSimilarCommand(cmdName, this.commands);
    if (similar.length > 0)
      return `❌ Unknown command: ${cmdName}\n💡 ${similar.map(s => `\`${s}\``).join(', ')}?\nType /help to see all commands`;
    return null;
  }

  // ===== 消息处理 — SDK 完整接入 =====
  async handleMessage(chatId: string, text: string, userId: string, attachments?: MessageAttachment[]) {
    if (isShuttingDown) {
      console.log(`[Shutdown] Rejecting new message during shutdown: ${text.slice(0, 50)}`);
      return;
    }
    activeRequests++;
    const controller = new AbortController();
    this.activeControllers.set(chatId, controller);

    // L2 防护：LLM 调用超时控制（默认 5 分钟）
    const llmTimeoutMs = (this.config as any).llmTimeoutMs ?? 300_000;
    const timeoutTimer = setTimeout(() => {
      console.warn(`[${this.name}] LLM call timeout (${llmTimeoutMs}ms), aborting request`);
      controller.abort(new Error(`LLM call timeout (${Math.round(llmTimeoutMs / 1000)}s)`));
    }, llmTimeoutMs);
    // Track real IM chatId for heartbeat/cron delivery
    this.heartbeatScheduler?.resolver.updateLastActiveChatId(this.id, chatId);
    try {
      // 限流
      const rlResult = checkRateLimit(chatId);
      if (!rlResult.allowed) {
        await this.reply(chatId, `⚠️ Rate limited, please wait ${rlResult.retryAfter} seconds before trying again`);
        return;
      }

      // 获取/创建会话
      const session = await this.sessionManager.getOrCreate(this.id, chatId, userId);
      session.lastUsed = Date.now();

      // 命令处理
      const cmdResp = await this.tryHandleCommand(chatId, text, session);
      if (cmdResp !== null) {
        await this.reply(chatId, cmdResp);
        this.sessionManager.persist(this.id, session);
        return;
      }

      // 最近消息
      session.recentMessages.push(text);
      if (session.recentMessages.length > 5) session.recentMessages = session.recentMessages.slice(-5);

      // P2-4: 动态注入任务状态到系统提示词
      let taskStatusInjection = '';
      const taskStatus = this.heartbeatScheduler?.getTaskStatus();
      if (taskStatus && taskStatus.length > 0) {
        const lines = taskStatus.map(t => {
          const lastRun = t.lastRunAt > 0 ? formatShanghaiTimeShort(t.lastRunAt) : '未执行';
          const locked = t.locked ? '🔒运行中' : '';
          const next = t.nextTriggerEstimate ? ` 下次: ${t.nextTriggerEstimate}` : '';
          return `  ${t.name} | ${t.type} | 运行${t.runCount}次 | 上次: ${lastRun}${locked}${next}`;
        });
        taskStatusInjection = `\n\n## 当前定时任务状态\n${lines.join('\n')}\n如果用户询问任务/任务列表/任务状态，请直接引用上方数据回答，不要调用工具。`;
      }

      // 构建动态运行时上下文
      const tz = require('./modules/core/timezone');
      const parts = tz.getShanghaiDateParts();
      const weekdays = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
      const runtimeContext = {
        currentTime: `${parts.year}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')} ${String(parts.hour).padStart(2, '0')}:${String(parts.minute).padStart(2, '0')} (${tz.TZ}, ${weekdays[parts.weekday]})`,
        workingDir: session.cwd || this.defaultCwd,
        trigger: 'user_message',
        chatType: 'direct',
      };

      // 构建系统提示词（统一入口：资源 + soul + restart instruction）
      let systemPrompt = buildSystemPromptWithSoul(this.soul || undefined, this.name, this.im,
        this.systemMcp, this.systemSkills, this.systemPrompts,
        this.botMcp, this.botSkills, this.botPrompts,
        runtimeContext);
      systemPrompt += taskStatusInjection;

      // P3-2: 注入任务管理指引（高优先级）
      if (this.taskManager) {
        systemPrompt += `\n\n## 任务管理（高优先级）\n当用户说「提醒我」「定时」「X分钟后」「每隔X」「多久后」「到X点」「重复提醒」等与定时/延迟任务相关的自然语言时，**你必须通过 \`imtoagent task\` CLI 操作定时任务**，而不是手写 YAML 文件或调用系统工具（如 at、crontab、sleep 等）。\n\n可用命令（通过 Bash 工具执行）：\n- \`imtoagent task list\` — 列出所有任务\n- \`imtoagent task add name=X type=T prompt=P [interval=5m|at=HH:MM|after=10m|cron=\"...\"]\` — 创建任务\n- \`imtoagent task remove name=X\` — 删除任务\n- \`imtoagent task update name=X 字段=新值\` — 更新任务\n- \`imtoagent task help\` — 查看完整用法\n\ntype 可选值: interval(默认) | once | scheduled | countdown | conditional | cron\n- interval: 如 30s / 5m / 1h / 1d\n- after: once 专用，相对延迟，如 10m / 1h\n- at: once/scheduled 专用，如 "14:30" 或 "2026-06-03 14:30"\n- on: scheduled 专用，如 monday / weekday\n- cron: cron 表达式\n- on_failure: ignore | alert | retry\n\n**创建任务后，必须在回复中包含确认信息**：任务名称、类型、触发时间/条件，让用户知道任务已安排妥当。\n\n示例：\n用户：「10分钟后提醒我回家」\n执行：\`imtoagent task add name=remind-home type=once after=10m prompt="发送消息提醒：该回家了！"\`\n回复：「⏰ 已创建 remind-home 任务，10 分钟后提醒你回家。」\n\n示例：\n用户：「每天早上9点提醒我站会」\n执行：\`imtoagent task add name=standup-reminder type=scheduled at=09:00 prompt="提醒今天有站会"\`\n回复：「⏰ 已创建 standup-reminder 任务，每天早上 09:00 提醒站会。」\n\n示例：\n用户：「每隔1小时帮我检查磁盘」\n执行：\`imtoagent task add name=disk-check type=interval interval=1h prompt="执行 df -h 检查磁盘使用率，超过80%报警"\`\n回复：「⏰ 已创建 disk-check 间隔任务，每 1h 检查一次磁盘。」`;
      }

      // P2: Goal 协议拦截 — 在 Agent 回复发送到用户之前，检查是否包含 GOAL_* 管理指令
      const goalReplyInterceptor = async (t: string) => {
        if (this.heartbeatScheduler) {
          const gm = this.heartbeatScheduler.getGoalManager();
          if (gm) {
            const processed = gm.processManagementCommand(t, chatId);
            if (processed) {
              // Agent 回复中包含 GOAL_* 协议，拦截并发送处理结果
              console.log(`[${this.name}] Goal protocol intercepted: ${t.slice(0, 80)}`);
              await this.reply(chatId, processed);
              return;
            }
          }
        }
        // 无 Goal 协议，正常发送
        await this.reply(chatId, t);
      };

      // SDK Runtime 处理
      const result = await this.runtime.processMessage({
        chatId, text, userId, attachments,
        workingDir: session.cwd || this.defaultCwd,
        model: this.activeModel,
        systemPrompt,
        reply: goalReplyInterceptor,
        sendProgress: async (t: string) => this.sendProgress(chatId, t),
        sendBlocks: async (blocks) => this.sendFormattedReplyDirect(chatId, blocks),
        imCaps: this.im.getCapabilities(),
        cancelSignal: controller.signal,
      }, this.adapter, this.id);

      // Agent 自主重启信号检测
      if (result?.restart) {
        setTimeout(async () => {
          await gracefulReload(`Agent requested restart: ${result.reason}`);
        }, 200);
      }

    } catch (e: any) {
      console.error(`[${this.name}] handleMessage error: ${e.message}`);
      await this.reply(chatId, `❌ ${e.message}`);
    } finally {
      clearTimeout(timeoutTimer);
      this.activeControllers.delete(chatId);
      activeRequests--;
    }
  }

  async reply(chatId: string, text: string) {
    const maxLen = this.config.system?.maxReplyLength || 140000;
    await this.im.reply(chatId, text, maxLen);
    console.log(`[${this.name}] Reply chat=${chatId.slice(-8)} len=${Math.min(text.length, maxLen)}`);
  }

  async sendProgress(chatId: string, text: string) {
    await this.im.sendProgress(chatId, text);
  }

  async sendFormattedReplyDirect(chatId: string, blocks: any[]) {
    if (this.im?.sendBlocks) {
      await this.im.sendBlocks(chatId, blocks);
    }
  }
}

// ===== 系统提示词构建（不依赖 prompt-builder 的旧接口） =====
import { buildSystemPrompt, buildPromptContext } from './modules/prompt-builder';

/**
 * Merge system-level and bot-level MCP servers.
 * Bot-level servers with the same name override system-level ones.
 */
function mergeMcpServers(
  systemServers: Record<string, McpServerConfig>,
  botServers: Record<string, McpServerConfig>,
): Array<{ name: string; enabled: boolean; command: string }> {
  const merged = new Map<string, McpServerConfig>();
  for (const [k, v] of Object.entries(systemServers)) merged.set(k, v);
  for (const [k, v] of Object.entries(botServers)) merged.set(k, v); // bot overrides system
  return [...merged.entries()].map(([name, cfg]) => ({
    name,
    enabled: cfg.enabled ?? true,
    command: cfg.command,
  }));
}

function buildSystemPromptWithSoul(
  soul: string,
  botName: string,
  imModule: IMModule | null,
  systemMcp: McpManager,
  systemSkills: SkillsManager,
  systemPrompts: PromptsManager,
  botMcp: McpManager,
  botSkills: SkillsManager,
  botPrompts: PromptsManager,
  runtimeContext?: {
    currentTime?: string;
    workingDir?: string;
    trigger?: string;
    chatType?: string;
  },
): string {
  // Merge system + bot resources
  const mergedMcp = mergeMcpServers(systemMcp.list(), botMcp.list());
  const mergedSkills = [...systemSkills.list(), ...botSkills.list()];
  const mergedPrompts = [...systemPrompts.list(), ...botPrompts.list()];

  const ctx = buildPromptContext({
    imModule,
    botName,
    mcpInfo: mergedMcp.length ? { servers: mergedMcp } : undefined,
    skillsInfo: mergedSkills.length ? { skills: mergedSkills.map(s => ({ name: s.name, description: s.description })) } : undefined,
    promptsInfo: mergedPrompts.length ? { prompts: mergedPrompts.map(p => ({ name: p.name })) } : undefined,
  }, {
    ...(runtimeContext?.workingDir ? { workingDir: runtimeContext.workingDir } : {}),
    trigger: runtimeContext?.trigger,
    chatType: runtimeContext?.chatType,
  });
  const base = buildSystemPrompt(ctx);

  // 注入 Agent 自主重启能力说明（信号文件路径固定）
  const gatewayPid = process.pid;
  const restartInstruction = `\n\n## ⛔ GATEWAY RESTART — ONLY ONE METHOD EXISTS (MANDATORY)\n\nYou are running INSIDE the Gateway process (PID ${gatewayPid}). The Gateway is a **single-process** architecture.\n\n### The ONLY valid restart method: write a signal file\n\n\`\`\`bash\necho '{"reason": "<brief reason>", "timestamp": '"$(date +%s)"'}' > ${process.env.HOME}/.imtoagent/.restart_requested\n\`\`\`\n\n**Flow:**\n1. You write the signal file → your reply goes out first\n2. Runtime detects the file after your turn ends\n3. gracefulReload() cleans up and exits with code 42\n4. Monitor detects code 42 → immediately respawns\n\n### 🚫 ABSOLUTELY FORBIDDEN (will permanently kill the Gateway)\n\n| Forbidden action | Why it fails |\n|---|---|\n| \`kill ${gatewayPid}\`, \`kill -9 ${gatewayPid}\` | Kills yourself, no respawn (exit code ≠ 42) |\n| \`pkill -f imtoagent\` | Kills yourself + monitor, no respawn |\n| \`imtoagent restart\` / \`imtoagent stop\` | Stops the monitor too, no respawn |\n| SIGTERM / SIGKILL on PID ${gatewayPid} | Exit code 143/137 ≠ 42, monitor treats as crash |\n| \`sudo reboot\` | System-level, out of scope |\n\n**There is NO other restart method. These are not warnings — they are hard constraints. Violating them permanently kills the Gateway.**\n\n### When to restart\n- Only when truly needed (config change, critical bug)\n- Otherwise: ignore this instruction`;


  let combined = `${base}${restartInstruction}`;
  if (soul) {
    combined += `\n\n---\n\n# User Custom Instructions (IMtoAgent Soul)\n\n${soul}`;
  }
  return combined;
}

// ================================================================
// 空闲清理
// ================================================================
function cleanupIdleSessions(bots: Bot[]) {
  const IDLE = 30 * 60 * 1000;
  for (const bot of bots) {
    bot.sessionManager.cleanupIdle(bot.id, IDLE);
  }
}

// ================================================================
// 全局引用
// ================================================================
let _allBots: Bot[] = [];

// ================================================================
// 热重载
// ================================================================
async function gracefulReload(reason: string) {
  console.log(`[Reload] 🔄 ${reason}`);

  // 1. 保存 session 快照（用于重启后通知）
  const sessionsDir = getSessionsDir();
  const botSnapshots: Record<string, { chats: { chatId: string; lastUsed: number }[] }> = {};
  try {
    if (fs.existsSync(sessionsDir)) {
      for (const botDir of fs.readdirSync(sessionsDir)) {
        const botPath = sessionsDir + '/' + botDir;
        if (!fs.statSync(botPath).isDirectory()) continue;
        const chats: { chatId: string; lastUsed: number }[] = [];
        for (const f of fs.readdirSync(botPath)) {
          if (!f.endsWith('.memory.json')) continue;
          try {
            const m = JSON.parse(fs.readFileSync(botPath + '/' + f, 'utf-8'));
            chats.push({ chatId: m.chatId, lastUsed: m.lastUsed || 0 });
          } catch {}
        }
        chats.sort((a, b) => b.lastUsed - a.lastUsed);
        botSnapshots[botDir] = { chats: chats.slice(0, 3) };
      }
    }
  } catch {}

  // 2. 写 restore marker（新进程启动后读取并通知用户）
  const marker = getRestoreMarkerPath();
  try { fs.writeFileSync(marker, JSON.stringify({ timestamp: Date.now(), reason, bots: botSnapshots })); } catch {}

  // 3. 优雅清理
  await stopAnthropicProxy();
  await stopOpenCodeServer();
  for (const bot of _allBots) bot.im.stop();
  await new Promise(r => setTimeout(r, 500));

  // 4. 退出，daemon 检测到 code=42 会立即拉起（不退避）
  console.log('[Reload] Cleanup complete, exiting...');
  process.exit(42);
}

process.on('SIGHUP', () => gracefulReload('SIGHUP'));

// ================================================================
// 主入口
// ================================================================
async function main() {
  // 启动时清理旧日志（防无限增长）
  rotateStartupLogs();

  const CONFIG_PATH = path.join(getDataDir(), 'config.json');

  // 首次部署：配置文件不存在或未初始化
  if (!fs.existsSync(CONFIG_PATH)) {
    console.log('');
    console.log('⚠️  First-time deployment: please configure imtoagent first');
    console.log('');
    console.log(`   Config file: ${CONFIG_PATH}`);
    console.log('');
    console.log('   1. Edit config.json and fill in your API credentials');
    console.log('   2. Re-run imtoagent');
    console.log('');
    console.log('   Reference template: templates/config.template.json');
    console.log('');
    process.exit(0);
  }

  const raw = fs.readFileSync(CONFIG_PATH, 'utf-8');
  const config = JSON.parse(raw);

  // 初始化时区（默认 Asia/Shanghai，可从 config.system.timeZone 覆盖）
  TimezoneManager.init(config.system?.timeZone);

  // 检测是否是未编辑的模板（凭证还是占位符）
  const hasPlaceholder = Object.values(config.providers || {}).some((p: any) =>
    p.apiKey?.startsWith('YOUR_') || !p.apiKey
  );
  if (hasPlaceholder) {
    console.log('');
    console.log('⚠️  Incomplete config: please replace YOUR_* in config.json with real API credentials');
    console.log(`   Config file: ${CONFIG_PATH}`);
    console.log('');
    process.exit(0);
  }

  const DEFAULT_PROJECT_DIR = config.system?.defaultProjectDir || path.join(os.homedir(), 'Projects');

  // Bot-level modelAliases: each Bot gets its own aliases, not shared globally
  const globalAliases = config.modelAliases || {};
  const { providers: _providers, defaultModel: DEFAULT_MODEL_SPEC } = loadProviders();
  const defaultCfg = getProviderConfig(DEFAULT_MODEL_SPEC);
  if (defaultCfg) sharedState.activeConfig = defaultCfg;

  process.env.ANTHROPIC_BASE_URL = 'http://localhost:18899';
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_AUTH_TOKEN;
  delete process.env.ANTHROPIC_MODEL;

  // 清理残留的重启信号（上次崩溃遗留的旧信号，超过 1 分钟视为残留）
  try {
    if (fs.existsSync(RESTART_SIGNAL_PATH)) {
      const old = JSON.parse(fs.readFileSync(RESTART_SIGNAL_PATH, 'utf-8'));
      const age = Date.now() - (old.timestamp || 0);
      if (age > 60000) {
        console.log(`[Startup] Cleaned up stale restart signal: ${old.reason} (${Math.floor(age / 1000)}s ago)`);
        fs.unlinkSync(RESTART_SIGNAL_PATH);
      }
    }
  } catch {}

  let proxyPort = 0;
  try { proxyPort = await startAnthropicProxy(18899); } catch (e: any) {
    console.error(`❌ Anthropic Proxy :18899 failed to start: ${e.message}`);
  }

    try {
      const codexCfg = config.codex || {};
      const modelId = codexCfg.model || 'deepseek-v4-pro';
      let apiKey = '';
      for (const name of Object.keys(config.providers || {})) {
        apiKey = config.providers[name].apiKey || '';
        if (apiKey) break;
      }
      initCodexProxyConfig({
        model: modelId,
        reportedModel: codexCfg.reportedModel || 'gpt-5.5',
        upstream: codexCfg.upstream || 'https://api.deepseek.com/v1/chat/completions',
        apiKey,
        supportedInputTypes: resolveSupportedInputTypes(config.providers || {}, modelId),
      });
      const rlCfg = config.rateLimit || {};
      if (rlCfg.enabled !== false) {
        setRateLimitConfig({
          maxRequests: rlCfg.maxRequests || 30,
          windowMs: rlCfg.windowMs || 60000,
        });
      }
    } catch (e: any) {
      console.error(`[Config] Failed to initialize sub-module config: ${e.message}`);
    }


  // 自动启动 OpenCode 服务（如果配置了 OpenCode bot）
  const hasOpenCodeBot = (config.bots || []).some((b: any) => b.backend === 'opencode');
  if (hasOpenCodeBot) {
    try {
      await startOpenCodeServer();
    } catch (e: any) {
      console.error(`[OpenCode] Failed to start: ${e.message}`);
    }
  }

  if (!proxyPort) {
    console.error('❌ All proxies failed to start, cannot continue');
    process.exit(1);
  }

  const botCfgs: any[] = config.bots || [];
  if (botCfgs.length === 0) {
    console.log('💡 No bots configured in config.json, starting proxy only');
    return;
  }

  // ===== Config Migration =====
  // 老用户升级：自动迁移 config.json 结构变化
  migrateConfigs();
  // 老用户升级：迁移 sessions/<name>/_bot.json → bots/<name>.json
  migrateBotJsonConfigs();

  // ===== Workspace Migration =====
  // 老用户升级：自动迁移旧 sessions/ + soul/ 到新的 workspace 结构
  const migrationResult = migrateWorkspaces();
  if (migrationResult.botsMigrated.length > 0) {
    console.log(`   🔄 Workspace migration: ${migrationResult.botsMigrated.length} bot(s) migrated`);
  }

  // 创建 WorkspaceManager（所有 Bot 共享）
  const workspaceManager = createWorkspaceManager(config);

  const bots: Bot[] = [];
  for (const c of botCfgs) {
    const appId = c.appId || c.feishu?.appId || '';
    const appSecret = c.appSecret || c.feishu?.appSecret || '';
    const imType = c.im || 'feishu';

    // wechat 不需要 appId/appSecret，首次启动会触发 QR 扫码绑定
    if (imType === 'wechat') {
      bots.push(new Bot({ ...c, appId: appId || 'wechat-bot', appSecret }, config, workspaceManager));
      continue;
    }

    // Telegram/其他非飞书 IM 只需要 appId，不需要 appSecret
    const needsSecret = imType === 'feishu';
    if (!appId || (needsSecret && !appSecret) || appId.startsWith('YOUR_') || appSecret.startsWith('YOUR_')) {
      console.log(`[Config] ⚠️  Bot "${c.name}" has placeholder credentials, skipping`);
      continue;
    }
    bots.push(new Bot({ ...c, appId, appSecret }, config, workspaceManager));
  }

  if (bots.length === 0) {
    console.log('⚠️  No bots with valid credentials, starting proxy only');
    return;
  }

  console.log(`   Workspace: ${workspaceManager.getConfigSummary()}`);
  _allBots = bots;
  console.log(`\n🚀 CC Routing v4 — Multi-Bot Architecture (Full SDK Integration)`);
  console.log(`   Anthropic: http://localhost:${proxyPort}`);
  console.log(`   Bots:`);

  for (const bot of bots) {
    bot.im.start(async (chatId, text, userId, attachments) => {
      const attDesc = attachments?.length
        ? ` +${attachments.length} attachments(${attachments.map(a => a.type).join(',')})`
        : '';
      console.log(`[${bot.name}] Received chat=${chatId.slice(-8)} "${text.slice(0, 80)}"${attDesc}`);
      // Merge system + bot resources for proxy path
      const capturedChatId = chatId;
      setCurrentBot({
        botName: bot.name,
        caps: bot.im.getCapabilities(),
        activeModel: bot.activeModel,
        modelAliases: bot.modelAliases,
        mcpInfo: { servers: mergeMcpServers(bot.systemMcp.list(), bot.botMcp.list()) },
        skillsInfo: { skills: [...bot.systemSkills.list(), ...bot.botSkills.list()].map(s => ({ name: s.name, description: s.description })) },
        promptsInfo: { prompts: [...bot.systemPrompts.list(), ...bot.botPrompts.list()].map(p => ({ name: p.name })) },
        notifyUser: (msg: string) => bot.im.reply(capturedChatId, msg),
        toolRegistry: bot.heartbeatScheduler?.getToolRegistry(),
      });
      bot.handleMessage(chatId, text, userId, attachments).catch((e: Error) =>
        console.error(`[${bot.name}] handleMessage unhandled:`, e.message)
      );
    });
    console.log(`   - ${bot.name}: ${bot.backend} ✅ (appId=${bot.appId.slice(-8)}…) [SDK]`);

    // L1: 启动心跳调度器（如果已初始化）
    if (bot.heartbeatScheduler) {
      bot.heartbeatScheduler.start();
    }

    // L2: 启动健康检查 Watchdog（默认启用）
    const wdConfig = (bot.config as any).watchdog || {};
    if (wdConfig.enabled !== false) {
      bot.watchdog = new Watchdog(
        {
          idleTimeoutMin: wdConfig.idleTimeoutMin ?? 30,
          memoryWarnPercent: wdConfig.memoryWarnPercent ?? 80,
          memoryKillPercent: wdConfig.memoryKillPercent ?? 95,
          maxSessions: wdConfig.maxSessions ?? 100,
        },
        {
          getLastMessageTime: () => bot.sessionManager.getLastMessageTime(bot.id),
          getSessionCount: () => bot.sessionManager.getActiveCount(bot.id),
          cleanupOldestSessions: (n: number) => bot.sessionManager.cleanupOldest(bot.id, n),
          cleanupSessionsByMemory: () => bot.sessionManager.cleanupByMemory(bot.id),
        }
      );
      bot.watchdog.start();
    }
  }
  console.log('');

  // 自动生成 workspace.md
  const updateWorkspace = (bot: Bot) => {
    try {
      const dir = bot._soulDir();
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const cwd = bot.defaultCwd;
      let gitBranch = '', gitStatus = '';
      try {
        gitBranch = require('child_process').execSync('git branch --show-current', { cwd, timeout: 3000, stdio: ['pipe', 'pipe', 'ignore'] }).toString().trim();
        gitStatus = require('child_process').execSync('git status --short', { cwd, timeout: 3000, stdio: ['pipe', 'pipe', 'ignore'] }).toString().trim();
      } catch {}
      const content = [
        '# Project Environment', '', `- Working Directory: ${cwd}`,
        gitBranch ? `- Git Branch: ${gitBranch}` : '',
        gitStatus ? `- Uncommitted Changes:\n\`\`\`\n${gitStatus.slice(0, 500)}\n\`\`\`` : '',
        '', '> This file is auto-generated by IMtoAgent on startup and directory changes.',
      ].filter(Boolean).join('\n');
      fs.writeFileSync(dir + '/workspace.md', content);
    } catch {}
  };
  for (const bot of bots) updateWorkspace(bot);

  // 启动时清除 Claude 后端 Bot 的旧 SDK session ID
  // 避免 --resume 恢复重启前残留的 Claude CLI 子进程 session
  for (const bot of bots) {
    if (bot.backend !== 'claude') continue;
    const botDir = path.join(getSessionsDir(), bot.id);
    try {
      if (fs.existsSync(botDir)) {
        for (const file of fs.readdirSync(botDir)) {
          if (!file.endsWith('.memory.json')) continue;
          const fp = path.join(botDir, file);
          try {
            const data = JSON.parse(fs.readFileSync(fp, 'utf-8'));
            let changed = false;
            if (data.sdkSessionId) { delete data.sdkSessionId; changed = true; }
            if (data.backendSessionId) { delete data.backendSessionId; changed = true; }
            if (data.metadata?.sdkSessionId) { delete data.metadata.sdkSessionId; changed = true; }
            if (changed) {
              fs.writeFileSync(fp, JSON.stringify(data, null, 2));
              console.log(`[Startup] Cleared old SDK session ID for ${bot.name}/${file}`);
            }
          } catch {}
        }
      }
    } catch (e: any) { console.error(`[Startup] Clear ${bot.name} session: ${e.message}`); }
  }

  // 重启后汇报
  if (process.env.CC_RESTORE === '1') {
    const marker = getRestoreMarkerPath();
    const tryRestore = async () => {
      for (let attempt = 0; attempt < 5; attempt++) {
        try {
          if (!fs.existsSync(marker)) return;
          const data = JSON.parse(fs.readFileSync(marker, 'utf-8'));
          const reason = data.reason || 'Unknown';
          const uptime = Date.now() - (data.timestamp || Date.now());
          const summary = `🔄 IMtoAgent restarted\nReason: ${reason}\nDowntime: ${(uptime / 1000).toFixed(1)}s`;
          let sent = 0;
          for (const bot of bots) {
            const snap = data.bots?.[bot.id];
            if (!snap?.chats?.length) continue;
            for (const { chatId } of snap.chats) {
              try { await bot.reply(chatId, summary); sent++; break; }
              catch (e: any) { console.error(`[Restore] ${bot.name} send failed (attempt ${attempt}): ${e.message}`); }
            }
          }
          if (sent > 0 || attempt >= 4) { try { fs.unlinkSync(marker); } catch {} return; }
        } catch {}
        await new Promise(r => setTimeout(r, 2000));
      }
    };
    setTimeout(tryRestore, 4000);
  }

  // 空闲清理
  setInterval(() => cleanupIdleSessions(bots), 5 * 60 * 1000);

  // 优雅关闭
  async function gracefulShutdown(signal: string) {
    console.log(`[Shutdown] Received ${signal}, shutting down gracefully...`);
    isShuttingDown = true;

    // 先 abort 所有适配器的活跃子进程（如 Claude CLI）
    for (const bot of bots) {
      try { if (bot.adapter && typeof (bot.adapter as any).cleanup === 'function') (bot.adapter as any).cleanup(); } catch {}
    }

    // 让活跃请求先完成/失败，再关 IM——避免回复石沉大海
    const DRAIN_TIMEOUT = 10_000;
    const drainStart = Date.now();
    while (activeRequests > 0 && Date.now() - drainStart < DRAIN_TIMEOUT) {
      console.log(`[Shutdown] Waiting for ${activeRequests} active request(s)...`);
      await new Promise(r => setTimeout(r, 500));
    }
    if (activeRequests > 0) {
      console.warn(`[Shutdown] ⚠️ Timeout, ${activeRequests} request(s) still pending`);
    } else {
      console.log('[Shutdown] All requests completed');
    }

    // 现在关闭 IM 和代理
    for (const bot of bots) {
      // L1: 停止心跳调度器
      if (bot.heartbeatScheduler) {
        bot.heartbeatScheduler.stop();
      }
      bot.im.stop();
    }
    await stopAnthropicProxy();
    await stopOpenCodeServer();

    console.log('[Shutdown] Persisting all sessions...');
    for (const bot of bots) {
      for (const session of bot.sessionManager.listActive(bot.id)) {
        try { bot.sessionManager.persist(bot.id, session); } catch {}
      }
    }
    console.log('[Shutdown] All services closed');
    process.exit(0);
  }

  process.on('SIGINT', () => gracefulShutdown('SIGINT'));

  // SIGTERM 硬拦截：Agent 若执行 kill/pkill 自杀，捕获后写重启信号 + exit(42)
  // 确保 monitor 自动拉起，而不是当作正常退出（exit 0）
  process.on('SIGTERM', () => {
    if (isShuttingDown) {
      // gracefulShutdown 已触发，按原流程走
      return;
    }
    console.error('[SIGTERM Trap] Unexpected SIGTERM detected (Agent kill attempt or external signal)');
    console.error('[SIGTERM Trap] Writing restart signal and exiting with code 42 for monitor respawn...');
    try {
      const signal = JSON.stringify({ reason: 'SIGTERM trap: gateway killed unexpectedly', timestamp: Math.floor(Date.now() / 1000) });
      fs.writeFileSync(RESTART_SIGNAL_PATH, signal);
      console.error(`[SIGTERM Trap] Restart signal written to ${RESTART_SIGNAL_PATH}`);
    } catch (e: unknown) {
      console.error(`[SIGTERM Trap] Failed to write restart signal: ${(e as Error).message}`);
    }
    // 不等 gracefulShutdown，直接 42 让 monitor 拉起
    process.exit(42);
  });
}

// ─── L1: 全局异常防护 ───────────────────────────────────────
// uncaughtException: 记录日志后主动退出，由 monitor mode (exit 42) 自动重启
// 继续跑在损坏状态比重启更危险
process.on('uncaughtException', (err) => {
  console.error(`[uncaughtException] ${err.message}`);
  console.error(err.stack);
  console.error('[uncaughtException] Exiting to trigger monitor-mode restart');
  process.exit(1);
});

// unhandledRejection: 全部记录到日志，不丢弃
// 1 分钟内超过 10 次 → 视为异常状态，触发重启
let _rejectionTotal = 0;
let _rejectionCount = 0;
let _rejectionLastMinute = 0;
process.on('unhandledRejection', (reason, promise) => {
  const now = Date.now();
  if (now - _rejectionLastMinute > 60000) { _rejectionCount = 0; _rejectionLastMinute = now; }
  _rejectionCount++;
  _rejectionTotal++;
  const msg = reason instanceof Error ? reason.message : String(reason);
  console.error(`[unhandledRejection #${_rejectionTotal}] ${msg}`);
  if (reason instanceof Error && reason.stack) {
    console.error(reason.stack.split('\n').slice(0, 3).join('\n'));
  }
  if (_rejectionCount > 10) {
    console.error(`[unhandledRejection] ${_rejectionCount} rejections in 1 minute, exiting to trigger restart`);
    process.exit(1);
  }
});

main().catch((err) => { console.error(`[Startup failed] ${err.message}`); process.exit(1); });
