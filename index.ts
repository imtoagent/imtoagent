// ============================================================
// CC 路由 v4 — 多 Bot 架构（SDK 完整接入版）
// ============================================================

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// ===== 重启信号文件路径（统一固定，不依赖 getDataDir） =====
const RESTART_SIGNAL_PATH = path.join(process.env.HOME!, '.imtoagent', '.restart_requested');

import * as Lark from '@larksuiteoapi/node-sdk';
import {
  sharedState, loadProviders, getProviderConfig, saveActiveModel,
  loadSessionConfig, saveSessionConfig,
  saveSessionMemory, loadSessionMemory, deleteSessionMemory, listPersistedSessions,
  resolveModel, ModelAliases, SessionMemoryData
} from './modules/proxy/anthropic-proxy';
import { parseToBlocks } from './modules/capabilities';
import { resolveCapabilities } from './modules/prompt-builder';
import { getDataDir } from './modules/utils/paths';
import { WorkspaceManager, createWorkspaceManager } from './modules/utils/workspace-manager';
import { migrateWorkspaces } from './modules/utils/migrate-workspaces';
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
import { initCodexProxyConfig } from './modules/proxy/codex-proxy';
import { checkRateLimit, setRateLimitConfig } from './modules/rate-limiter';
import { setCurrentBot } from './modules/bot-context';
import { getDataDir, getSessionsDir, getSoulDir, getBotKey, getRestoreMarkerPath } from './modules/utils/paths';

// ===== SDK 核心 =====
import { AgentRuntime, FileSessionManager, DefaultErrorHandler, DefaultStatsTracker } from './modules/core';
import { ClaudeAdapter } from './modules/agent/claude-adapter';
import { CodexAdapter } from './modules/agent/codex-adapter';
import { OpenCodeAdapter } from './modules/agent/opencode-adapter';
import { GeminiAdapter } from './modules/agent/gemini-adapter';
import type { CallStats, Session, AgentAdapter, MessageAttachment } from './modules/core/types';
import { startOpenCodeServer, stopOpenCodeServer } from './modules/agent/opencode-adapter';

// ===== 全局活跃请求计数 =====
let activeRequests = 0;

// ================================================================
// 解析飞书消息内容
// ================================================================
function parseMessage(content: string): string {
  try { return (JSON.parse(content).text || '').trim(); }
  catch { return content.trim(); }
}

// ================================================================
// ChatSession — 继承 SDK Session，兼容旧命令
// ================================================================
interface ChatSession extends Session {
  _raw?: any; // 保留原始加载数据
}

// ================================================================
// 自定义 SessionManager — 桥接 Bot.sessions 和 SDK
// ================================================================
class CustomSessionManager {
  sessions: Map<string, ChatSession>;
  botKey: string;
  sessionsDir: string;

  constructor(botKey: string, workspacePath: string, sessions: Map<string, ChatSession>) {
    this.botKey = botKey;
    this.sessions = sessions;
    this.sessionsDir = path.join(workspacePath, 'sessions');
  }

  private _sessionPath(chatId: string): string {
    return path.join(this.sessionsDir, `${chatId}.memory.json`);
  }

  async getOrCreate(chatId: string, userId: string): Promise<ChatSession> {
    const existing = this.sessions.get(chatId);
    if (existing) {
      existing.lastUsed = Date.now();
      return existing;
    }

    // 从文件加载（兼容旧格式）
    // 确保 sessions 目录存在
    if (!fs.existsSync(this.sessionsDir)) {
      fs.mkdirSync(this.sessionsDir, { recursive: true });
    }
    const fp = this._sessionPath(chatId);
    let session: ChatSession;

    if (fs.existsSync(fp)) {
      try {
        const raw = fs.readFileSync(fp, 'utf-8');
        const data = JSON.parse(raw);
        const EMPTY_STATS: CallStats = {
          calls: 0, totalTurns: 0, totalInputTokens: 0,
          totalOutputTokens: 0, totalCostUSD: 0, totalDurationMs: 0,
        };
        session = {
          chatId: data.chatId || chatId,
          userId: data.userId || userId,
          cwd: data.cwd,
          startFresh: data.startFresh || false,
          backendSessionId: data.sdkSessionId || data.codexThreadId || data.ocSessionId || data.backendSessionId,
          metadata: {
            sdkSessionId: data.sdkSessionId,
            codexThreadId: data.codexThreadId,
            ocSessionId: data.ocSessionId,
            ...(data.metadata || {}),
          },
          stats: data.stats || { ...EMPTY_STATS },
          lastUsed: data.lastUsed || Date.now(),
          running: false,
          permissionMode: data.permissionMode,
          codexMode: data.codexMode,
          recentMessages: data.recentMessages || [],
        };
      } catch (e: any) {
        console.error(`[Session] Failed to load ${chatId}: ${e.message}`);
        session = this._newSession(chatId, userId);
      }
    } else {
      session = this._newSession(chatId, userId);
    }

    this.sessions.set(chatId, session);
    return session;
  }

  private _newSession(chatId: string, userId: string): ChatSession {
    const EMPTY_STATS: CallStats = {
      calls: 0, totalTurns: 0, totalInputTokens: 0,
      totalOutputTokens: 0, totalCostUSD: 0, totalDurationMs: 0,
    };
    return {
      chatId, userId, startFresh: false,
      backendSessionId: undefined, metadata: {},
      stats: { ...EMPTY_STATS },
      lastUsed: Date.now(), running: false, recentMessages: [],
    };
  }

  persist(_botName: string, session: Session): void {
    const cs = session as ChatSession;
    const fp = this._sessionPath(session.chatId);
    const dir = path.dirname(fp);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    const output: Record<string, any> = {
      chatId: session.chatId,
      userId: session.userId,
      cwd: session.cwd,
      startFresh: session.startFresh,
      stats: session.stats,
      lastUsed: session.lastUsed,
      recentMessages: session.recentMessages || [],
      running: session.running,
    };

    if (session.backendSessionId) output.backendSessionId = session.backendSessionId;
    if (session.metadata) {
      if (session.metadata.sdkSessionId) output.sdkSessionId = session.metadata.sdkSessionId;
      if (session.metadata.codexThreadId) output.codexThreadId = session.metadata.codexThreadId;
      if (session.metadata.ocSessionId) output.ocSessionId = session.metadata.ocSessionId;
      if (session.permissionMode) output.permissionMode = session.permissionMode;
      if (session.codexMode) output.codexMode = session.codexMode;
    }
    output.metadata = session.metadata;

    try {
      fs.writeFileSync(fp, JSON.stringify(output, null, 2));
    } catch (e: any) {
      console.error(`[Session] Failed to persist ${session.chatId}: ${e.message}`);
    }
  }

  delete(_botName: string, chatId: string): void {
    this.sessions.delete(chatId);
    try {
      const fp = this._sessionPath(chatId);
      if (fs.existsSync(fp)) fs.unlinkSync(fp);
    } catch {}
  }

  cleanupIdle(timeoutMs: number): void {
    const now = Date.now();
    const toRemove: string[] = [];
    for (const [chatId, session] of this.sessions.entries()) {
      if (now - session.lastUsed > timeoutMs && !session.running) {
        toRemove.push(chatId);
      }
    }
    for (const chatId of toRemove) {
      this.sessions.delete(chatId);
      console.log(`[Session] Cleaning up idle ${chatId.slice(-8)}`);
    }
  }

  listActive(): Session[] {
    return Array.from(this.sessions.values());
  }
}

// ================================================================
// 工具函数
// ================================================================
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
  session: ChatSession | undefined;
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
  workspaceManager: WorkspaceManager;

  // SDK
  runtime: AgentRuntime;
  sessionManager: CustomSessionManager;
  sessions: Map<string, ChatSession> = new Map();
  commands: Map<string, CommandHandler> = new Map();
  adapter: AgentAdapter;
  /** 正在执行的任务的取消信号（chatId → AbortController） */
  activeControllers: Map<string, AbortController> = new Map();

  constructor(cfg: BotConfig, globalConfig: any, workspaceManager: WorkspaceManager) {
    this.id = cfg.id || cfg.name; // 后向兼容：无 id 时用 name
    this.name = cfg.name;
    this.backend = cfg.backend;
    this.appId = cfg.appId;
    this.appSecret = cfg.appSecret;
    this.defaultCwd = cfg.cwd || globalConfig.system?.defaultProjectDir || path.join(os.homedir(), 'Projects');
    this.config = globalConfig;
    this.isAdmin = cfg.isAdmin !== undefined ? cfg.isAdmin : true; // 默认 true（后向兼容老用户）
    this.workspaceManager = workspaceManager;

    // 确保工作空间目录存在
    const botKey = this.id;
    this.workspaceManager.ensureWorkspace(botKey);

    // Bot 级模型配置
    const botCfg = this._loadBotConfig();
    this.activeModel = botCfg.activeModel || globalConfig.defaultModel || 'deepseek/deepseek-v4-pro';
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
    this.sessionManager = new CustomSessionManager(this.id, workspacePath, this.sessions);

    const adapterCtx = {
      imModule: this.im,
      botName: this.name,
      modelAliases: this.modelAliases,
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
  _botConfigPath() { return path.join(getSessionsDir(), this.id, '_bot.json'); }

  _loadBotConfig() {
    try {
      const p = this._botConfigPath();
      if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf-8'));
    } catch {}
    return {};
  }

  _saveBotConfig() {
    try {
      const dir = path.dirname(this._botConfigPath());
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(this._botConfigPath(), JSON.stringify({
        activeModel: this.activeModel,
        modelAliases: this.modelAliases,
        modelPresets: this.modelPresets,
      }, null, 2));
    } catch (e: any) {
      console.error(`[${this.name}] Failed to save config:`, e.message);
    }
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
      out += '/memory — Overview\n/soul — Soul\n/reload — Reload';
      return out;
    });

    cmd('/status', ({ session }) =>
      session?.running
        ? `✅ ${this.backend} running | ${this.activeModel} | ${session.stats.calls} calls`
        : `⏸ ${this.backend} idle | ${this.activeModel}`);

    cmd('/info', ({ session }) =>
      `🤖 ${this.name} (${this.backend})${this.isAdmin ? ' ⭐' : ''}\nModel: ${this.activeModel}\nDirectory: ${session?.cwd || this.defaultCwd}\nSessions: ${this.sessions.size}`);

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
            if (role === 'default') this.activeModel = spec;
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
      return `🤖 Switched: ${raw}`;
    });

    cmd('/providers', () => {
      const providers = loadProviders();
      const list = Object.entries(providers).map(([name, p]: [string, any]) =>
        `• **${name}**: ${(p.models || []).join(', ')}`
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
  }

  async tryHandleCommand(chatId: string, text: string, session: ChatSession | undefined): Promise<string | null> {
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
    activeRequests++;
    const controller = new AbortController();
    this.activeControllers.set(chatId, controller);
    try {
      // 限流
      const rlResult = checkRateLimit(chatId);
      if (!rlResult.allowed) {
        await this.reply(chatId, `⚠️ Rate limited, please wait ${rlResult.retryAfter} seconds before trying again`);
        return;
      }

      // 获取/创建会话
      const session = await this.sessionManager.getOrCreate(chatId, userId);
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

      // 构建系统提示词
      const systemPrompt = this.soul ? buildSystemPromptWithSoul(this.soul, this.name, this.im) : undefined;

      // SDK Runtime 处理
      const result = await this.runtime.processMessage({
        chatId, text, userId, attachments,
        workingDir: session.cwd || this.defaultCwd,
        model: this.activeModel,
        systemPrompt,
        reply: async (t: string) => this.reply(chatId, t),
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
import { buildSystemPrompt } from './modules/prompt-builder';

function buildSystemPromptWithSoul(soul: string, botName: string, imModule: IMModule | null): string {
  const base = buildSystemPrompt({ imModule, botName });

  // 注入 Agent 自主重启能力说明（信号文件路径固定）
  const restartInstruction = `\n\n## Gateway Restart Capability\n\nIf you determine that the IMtoAgent gateway needs to be restarted (e.g., config changes, abnormal state detected that requires reset), execute the following command:\n\n\`\`\`bash\necho '{"reason": "<brief reason>", "timestamp": '"$(date +%s)"'}' > ${process.env.HOME}/.imtoagent/.restart_requested\n\`\`\`\n\nRules:\n- This signal file is automatically detected and consumed by the Runtime, the user will not see it\n- Your reply will be sent to the user normally before the gateway restarts\n- Only use when truly needed, do not trigger arbitrarily\n- If you don't need a restart, ignore this instruction`;

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
    bot.sessionManager.cleanupIdle(IDLE);
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

  // 4. 退出，daemon.sh 会自动拉起新进程
  console.log('[Reload] Cleanup complete, exiting...');
  process.exit(0);
}

process.on('SIGHUP', () => gracefulReload('SIGHUP'));

// ================================================================
// 主入口
// ================================================================
async function main() {
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
      let apiKey = '';
      for (const name of Object.keys(config.providers || {})) {
        apiKey = config.providers[name].apiKey || '';
        if (apiKey) break;
      }
      initCodexProxyConfig({
        model: codexCfg.model || 'deepseek-v4-pro',
        reportedModel: codexCfg.reportedModel || 'gpt-5.5',
        upstream: codexCfg.upstream || 'https://api.deepseek.com/v1/chat/completions',
        apiKey,
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
      setCurrentBot({ botName: bot.name, caps: bot.im.getCapabilities(), modelAliases: bot.modelAliases });
      bot.handleMessage(chatId, text, userId, attachments).catch((e: Error) =>
        console.error(`[${bot.name}] handleMessage unhandled:`, e.message)
      );
    });
    console.log(`   - ${bot.name}: ${bot.backend} ✅ (appId=${bot.appId.slice(-8)}…) [SDK]`);
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
        gitBranch = require('child_process').execSync('git branch --show-current', { cwd, timeout: 3000 }).toString().trim();
        gitStatus = require('child_process').execSync('git status --short', { cwd, timeout: 3000 }).toString().trim();
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
    // 先 abort 所有适配器的活跃子进程（如 Claude CLI）
    for (const bot of bots) {
      try { if (bot.adapter && typeof (bot.adapter as any).cleanup === 'function') (bot.adapter as any).cleanup(); } catch {}
    }
    for (const bot of bots) bot.im.stop();

    // 立即关闭代理，让正在等待上游响应的请求快速失败
    // 这样 handleMessage 的 catch/finally 才能执行，activeRequests 才能递减
    await stopAnthropicProxy();
    await stopOpenCodeServer();

    console.log('[Shutdown] Persisting all sessions...');
    for (const bot of bots) {
      for (const [chatId, session] of bot.sessions.entries()) {
        try { bot.sessionManager.persist(bot.id, session); } catch {}
      }
    }
    const DRAIN_TIMEOUT = 10_000;
    const start = Date.now();
    while (activeRequests > 0 && Date.now() - start < DRAIN_TIMEOUT) {
      console.log(`[Shutdown] Waiting for ${activeRequests} active request(s)...`);
      await new Promise(r => setTimeout(r, 500));
    }
    if (activeRequests > 0) {
      console.warn(`[Shutdown] ⚠️ Timeout, ${activeRequests} request(s) still pending, force exit`);
    } else {
      console.log('[Shutdown] All requests completed');
    }
    console.log('[Shutdown] All services closed');
    process.exit(0);
  }

  process.on('SIGINT', () => gracefulShutdown('SIGINT'));
  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
}

process.on('uncaughtException', (err) => { console.error(`[uncaught] ${err.message}`); console.error(err.stack); });

let _rejectionCount = 0;
let _rejectionLastMinute = 0;
process.on('unhandledRejection', (reason, promise) => {
  const now = Date.now();
  if (now - _rejectionLastMinute > 60000) { _rejectionCount = 0; _rejectionLastMinute = now; }
  _rejectionCount++;
  if (_rejectionCount > 5) return;
  if (reason instanceof Error) {
    console.error(`[unhandled #${_rejectionCount}] ${reason.message}`);
    console.error(reason.stack?.split('\n').slice(0, 4).join('\n'));
  } else {
    console.error(`[unhandled #${_rejectionCount}] ${String(reason)} (type=${typeof reason})`);
  }
});

main().catch((err) => { console.error(`[Startup failed] ${err.message}`); process.exit(1); });
