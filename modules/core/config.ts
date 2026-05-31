// ================================================================
// ConfigManager — 配置管理
// ================================================================
// 从 config.json 和 providers.json 读取，支持 bot 级别配置持久化
// ================================================================

const fs = require('fs');
const path = require('path');

import type { ConfigManager, BotConfig, ProviderConfig } from './types';
import { getDataDir, getSessionsDir } from '../utils/paths';

/** 全局 config.json 结构 */
interface RawConfig {
  system?: {
    defaultProjectDir?: string;
    idleTimeoutMinutes?: number;
    maxReplyLength?: number;
  };
  providers?: Record<string, {
    baseUrl: string;
    apiKey: string;
    models?: string[];
    format?: string;
    pricing?: { inputPerMillion: number; outputPerMillion: number; currency?: string };
  }>;
  defaultModel?: string;
  activeModel?: string;
  modelAliases?: Record<string, string>;
  bots?: Array<{
    name: string;
    appId: string;
    appSecret: string;
    backend: string;
    cwd?: string;
  }>;
  execServer?: { enabled: boolean; startupTimeoutMs: number; fallbackToExec: boolean };
  codex?: any;
  opencode?: any;
  rateLimit?: any;
  shutdown?: any;
}

/** Bot 级别配置（持久化在 sessions 目录） */
interface BotLevelConfig {
  activeModel?: string;
  modelAliases?: Record<string, string>;
}

// ================================================================
// FileConfigManager
// ================================================================

export class FileConfigManager implements ConfigManager {
  private rawConfig: RawConfig | null = null;
  private providerConfigs: Map<string, ProviderConfig> = new Map();
  private botConfigs = new Map<string, BotLevelConfig>();

  constructor() {
    this.loadAll();
  }

  /** 加载所有配置文件 */
  private loadAll(): void {
    // 加载主配置
    try {
      const configPath = path.join(getDataDir(), 'config.json');
      const raw = fs.readFileSync(configPath, 'utf-8');
      this.rawConfig = JSON.parse(raw);
    } catch (e: any) {
      console.error(`[Config] Failed to load config.json: ${e.message}`);
      this.rawConfig = {} as RawConfig;
    }

    // 加载 providers.json
    try {
      const provPath = path.join(getDataDir(), 'providers.json');
      const raw = fs.readFileSync(provPath, 'utf-8');
      const provData = JSON.parse(raw);

      for (const [name, p] of Object.entries(provData.providers || {}) as [string, any][]) {
        this.providerConfigs.set(name, {
          baseUrl: p.baseUrl || '',
          apiKey: p.apiKey || '',
          model: (p.models && p.models[0]) || '',
          format: (p.format as 'anthropic' | 'openai') || 'anthropic',
        });
      }
    } catch (e: any) {
      console.error(`[Config] Failed to load providers.json: ${e.message}`);
    }

    // 加载默认 providers
    this._loadDefaultProviders();

    // 加载各 bot 的模型配置
    if (this.rawConfig?.bots) {
      for (const bot of this.rawConfig.bots) {
        this._loadBotConfig(bot.name);
      }
    }
  }

  /** 从 config.json 中的 providers 加载默认 provider */
  private _loadDefaultProviders(): void {
    if (!this.rawConfig?.providers) return;

    for (const [name, p] of Object.entries(this.rawConfig.providers)) {
      if (!this.providerConfigs.has(name)) {
        this.providerConfigs.set(name, {
          baseUrl: p.baseUrl || '',
          apiKey: p.apiKey || '',
          model: (p.models && p.models[0]) || '',
          format: (p.format as 'anthropic' | 'openai') || 'anthropic',
        });
      }
    }
  }

  /** 加载 Bot 级别配置 */
  private _loadBotConfig(botKey: string): void {
    const sessionsDir = getSessionsDir();
    const configPath = path.join(sessionsDir, `${botKey}_config.json`);

    try {
      if (fs.existsSync(configPath)) {
        const raw = fs.readFileSync(configPath, 'utf-8');
        this.botConfigs.set(botKey, JSON.parse(raw));
      } else {
        this.botConfigs.set(botKey, {});
      }
    } catch (e: any) {
      console.error(`[Config] Failed to load bot ${botKey} config: ${e.message}`);
      this.botConfigs.set(botKey, {});
    }
  }

  /** 保存 Bot 级别配置 */
  private _saveBotConfig(botKey: string, config: BotLevelConfig): void {
    const sessionsDir = getSessionsDir();
    const configPath = path.join(sessionsDir, `${botKey}_config.json`);

    try {
      if (!fs.existsSync(sessionsDir)) {
        fs.mkdirSync(sessionsDir, { recursive: true });
      }
      this.botConfigs.set(botKey, config);
      fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
    } catch (e: any) {
      console.error(`[Config] Failed to save bot ${botKey} config: ${e.message}`);
    }
  }

  // ================================================================
  // 接口实现
  // ================================================================

  /**
   * 通过路径获取配置值，如 "system.defaultProjectDir"
   */
  get<T>(configPath: string): T {
    if (!this.rawConfig) return undefined as T;

    const keys = configPath.split('.');
    let current: any = this.rawConfig;

    for (const key of keys) {
      if (current == null) return undefined as T;
      current = current[key];
    }

    return current as T;
  }

  /**
   * 获取 Bot 配置
   */
  getBotConfig(name: string): BotConfig | null {
    if (!this.rawConfig?.bots) return null;

    const bot = this.rawConfig.bots.find(b => b.name === name);
    if (!bot) return null;

    const botLevel = this.botConfigs.get(name) || {};

    return {
      name: bot.name,
      backend: bot.backend,
      appId: bot.appId,
      appSecret: bot.appSecret,
      cwd: bot.cwd,
      activeModel: botLevel.activeModel || this.getActiveModel(),
      modelAliases: botLevel.modelAliases || this.getActiveModelAliases(),
    };
  }

  /**
   * 获取 Provider 配置
   */
  getProviderConfig(providerId: string): ProviderConfig | null {
    return this.providerConfigs.get(providerId) || null;
  }

  /**
   * 获取当前活跃模型
   */
  getActiveModel(): string {
    const cfg = this.rawConfig;
    return cfg?.activeModel || cfg?.defaultModel || 'deepseek/deepseek-v4-pro';
  }

  /**
   * 解析模型规格（处理 alias 和 provider/model 格式）
   */
  resolveModel(modelSpec: string): string {
    const aliases = this.getActiveModelAliases();

    // 检查是否为 alias
    if (aliases[modelSpec]) {
      return aliases[modelSpec];
    }

    // 已经是 provider/model 格式，直接返回
    if (modelSpec.includes('/')) {
      return modelSpec;
    }

    // 尝试从 provider 中匹配
    for (const [provName, provCfg] of this.providerConfigs) {
      if (provCfg.model === modelSpec) {
        return `${provName}/${modelSpec}`;
      }
      if (provCfg.models?.includes(modelSpec)) {
        return `${provName}/${modelSpec}`;
      }
    }

    // 返回默认模型
    return this.getActiveModel();
  }

  // ================================================================
  // Bot 级别模型配置持久化
  // ================================================================

  /** 获取当前模型别名 */
  private getActiveModelAliases(): Record<string, string> {
    return this.rawConfig?.modelAliases || {};
  }

  /** 保存 Bot 活跃模型 */
  saveActiveModel(botKey: string, modelSpec: string): void {
    const botLevel = this.botConfigs.get(botKey) || {};
    botLevel.activeModel = modelSpec;
    this._saveBotConfig(botKey, botLevel);

    // 同时更新全局配置
    if (this.rawConfig) {
      this.rawConfig.activeModel = modelSpec;
      try {
        const configPath = path.join(getDataDir(), 'config.json');
        fs.writeFileSync(configPath, JSON.stringify(this.rawConfig, null, 2) + '\n');
      } catch (e: any) {
        console.error(`[Config] Failed to save global activeModel: ${e.message}`);
      }
    }
  }

  /** 保存 Bot 模型别名 */
  saveModelAliases(botKey: string, aliases: Record<string, string>): void {
    const botLevel = this.botConfigs.get(botKey) || {};
    botLevel.modelAliases = aliases;
    this._saveBotConfig(botKey, botLevel);
  }
}
