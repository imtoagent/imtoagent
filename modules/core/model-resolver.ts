/**
 * model-resolver.ts — 统一模型解析层
 *
 * 兜底链（bot 级优先，零硬编码）：
 *   ① modelAliases[alias]     bot 级别别名映射
 *     ↓ 不存在
 *   ② bot.activeModel          bot 级别热切换值
 *     ↓ 不存在
 *   ③ global.activeModel       全局热切换值
 *     ↓ 不存在
 *   ④ modelAliases.default     bot 级别默认别名
 *     ↓ 不存在
 *   ⑤ codex.model              config.json 段兜底值
 *     ↓ 不存在
 *   ❌ 报错：No model configured
 */

import * as fs from 'fs';
import * as path from 'path';

// ================================================================
// 类型
// ================================================================

export interface ModelResolveContext {
  /** bot 级别 modelAliases */
  botAliases?: Record<string, string>;
  /** bot 级别 activeModel */
  botActiveModel?: string;
  /** 全局 activeModel */
  globalActiveModel?: string;
  /** codex.model 兜底值 */
  codexModel?: string;
}

export interface ResolvedModel {
  /** 完整模型规格，如 "deepseek/deepseek-v4-flash" */
  spec: string;
  /** provider 名称（spec 中 / 之前的部分） */
  provider: string;
  /** 模型纯名（spec 中 / 之后的部分） */
  model: string;
}

// ================================================================
// 核心解析
// ================================================================

/**
 * 解析模型规格。
 * @param aliasOrSpec 用户请求的别名（如 "sonnet"）或完整规格（如 "deepseek/deepseek-v4-flash"）
 * @param ctx 解析上下文（由调用方从配置构建）
 * @returns ResolvedModel
 * @throws 当所有兜底层都没有配置时
 */
export function resolveModel(
  aliasOrSpec: string,
  ctx: ModelResolveContext,
): ResolvedModel {
  const candidates = buildCandidateChain(aliasOrSpec, ctx);

  for (const candidate of candidates) {
    if (candidate && candidate.trim()) {
      return parseSpec(candidate);
    }
  }

  throw new Error(
    `No model configured. ` +
    `Set modelAliases, activeModel, or codex.model in config.json. ` +
    `Requested: "${aliasOrSpec}"`,
  );
}

// ================================================================
// 兜底链构建
// ================================================================

/** 按优先级构建候选列表 */
function buildCandidateChain(
  aliasOrSpec: string,
  ctx: ModelResolveContext,
): (string | null)[] {
  const normalized = aliasOrSpec.toLowerCase();

  // ① modelAliases[alias] — bot 级别优先
  if (ctx.botAliases && ctx.botAliases[normalized]) {
    return [ctx.botAliases[normalized]];
  }

  // ② bot.activeModel
  if (ctx.botActiveModel) {
    return [ctx.botActiveModel];
  }

  // ③ global.activeModel
  if (ctx.globalActiveModel) {
    return [ctx.globalActiveModel];
  }

  // ④ modelAliases.default — bot 级别
  if (ctx.botAliases && ctx.botAliases['default']) {
    return [ctx.botAliases['default']];
  }

  // ⑤ codex.model 兜底值
  if (ctx.codexModel) {
    return [ctx.codexModel];
  }

  // 全空
  return [null];
}

// ================================================================
// 规格解析
// ================================================================

/**
 * 解析 "provider/model" 格式。
 * 如果没有 / 前缀，provider 为空。
 */
export function parseSpec(spec: string): ResolvedModel {
  const slashIdx = spec.indexOf('/');
  if (slashIdx > 0) {
    return {
      spec,
      provider: spec.slice(0, slashIdx),
      model: spec.slice(slashIdx + 1),
    };
  }
  return {
    spec,
    provider: '',
    model: spec,
  };
}

// ================================================================
// 上下文构建（Codex Proxy 专用）
// ================================================================

/**
 * 从配置文件构建 ModelResolveContext。
 * 实时读取，不缓存。
 */
export function buildCodexResolveContext(
  botId: string,
  dataDir: string,
): ModelResolveContext {
  const ctx: ModelResolveContext = {};

  // 读 config.json
  const configPath = path.join(dataDir, 'config.json');
  let globalRaw: Record<string, unknown> | null = null;
  let codexSection: Record<string, unknown> | null = null;

  try {
    globalRaw = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    codexSection = (globalRaw.codex as Record<string, unknown>) || null;
  } catch {
    // 配置文件读不到，后续兜底层会处理
  }

  // ① bot 级别 modelAliases
  const botAliases = buildBotAliases(botId, dataDir, globalRaw);
  if (botAliases && Object.keys(botAliases).length > 0) {
    ctx.botAliases = botAliases;
  }

  // ② bot 级别 activeModel
  const botActiveModel = buildBotActiveModel(botId, dataDir, globalRaw);
  if (botActiveModel) {
    ctx.botActiveModel = botActiveModel;
  }

  // ③ global activeModel
  const globalActiveModel = globalRaw?.activeModel as string | undefined;
  if (globalActiveModel) {
    ctx.globalActiveModel = globalActiveModel;
  }

  // ⑤ codex.model 兜底值
  const codexModel = codexSection?.model as string | undefined;
  if (codexModel) {
    ctx.codexModel = codexModel;
  }

  return ctx;
}

/**
 * 构建 bot 级别 modelAliases。
 * 优先读 bot.json，回退到 config.json 中对应 bot 的 modelAliases。
 */
function buildBotAliases(
  botId: string,
  dataDir: string,
  globalRaw: Record<string, unknown> | null,
): Record<string, string> | null {
  // 1. bot.json
  const botConfigPath = path.join(dataDir, 'bots', botId, 'bot.json');
  try {
    if (fs.existsSync(botConfigPath)) {
      const botCfg = JSON.parse(fs.readFileSync(botConfigPath, 'utf-8'));
      if (botCfg.modelAliases && typeof botCfg.modelAliases === 'object') {
        return botCfg.modelAliases as Record<string, string>;
      }
    }
  } catch {
    // ignore
  }

  // 2. config.json 中对应 bot 的 modelAliases
  if (globalRaw) {
    const bots = globalRaw.bots as Array<Record<string, unknown>> | undefined;
    if (Array.isArray(bots)) {
      for (const bot of bots) {
        if (bot.name === botId && bot.modelAliases && typeof bot.modelAliases === 'object') {
          return bot.modelAliases as Record<string, string>;
        }
      }
    }
  }

  return null;
}

/**
 * 构建 bot 级别 activeModel。
 * 优先读 bot.json，回退到内存中的 botCtx（由调用方传入）。
 */
function buildBotActiveModel(
  botId: string,
  dataDir: string,
  globalRaw: Record<string, unknown> | null,
): string | null {
  // 1. bot.json
  const botConfigPath = path.join(dataDir, 'bots', botId, 'bot.json');
  try {
    if (fs.existsSync(botConfigPath)) {
      const botCfg = JSON.parse(fs.readFileSync(botConfigPath, 'utf-8'));
      if (botCfg.activeModel && typeof botCfg.activeModel === 'string') {
        return botCfg.activeModel;
      }
    }
  } catch {
    // ignore
  }

  // 2. config.json 中对应 bot 的 activeModel
  if (globalRaw) {
    const bots = globalRaw.bots as Array<Record<string, unknown>> | undefined;
    if (Array.isArray(bots)) {
      for (const bot of bots) {
        if (bot.name === botId && bot.activeModel && typeof bot.activeModel === 'string') {
          return bot.activeModel;
        }
      }
    }
  }

  return null;
}
