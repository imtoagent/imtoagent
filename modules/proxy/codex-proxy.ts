// Codex Proxy — Responses API ↔ Chat Completions 双向转换
// Codex 请求处理器（已合并到 18899） · 可作为模块导入或被 Bun 直接运行

import { getCurrentBot } from '../bot-context';
import { buildSystemPrompt, buildPromptContext, resolveCapabilities, DEFAULT_TERMINAL_CAPS } from '../prompt-builder';
import * as path from 'path';
import * as fs from 'fs';
import { getDataDir, getBotConfigPath } from '../utils/paths';
import { logUsage } from './usage-logger';
import { ContextManager } from './context-manager';
import type { OpenAIRequestBody, OpenAITool, OpenAIStreamChunk, AnthropicResponseUsage } from './proxy-types';
import { hasLocalTool, isLocalTool, parseToolCalls, executeLocalTools, generateRemotePlaceholders, buildToolMessages, type ToolExecutionResult } from './tool-interceptor';
import type { ToolRegistry } from '../agent/tool-registry';

/** Map HTTP status code to user-friendly error message */
function statusToUserMessage(status: number): string {
  switch (status) {
    case 401: return '⚠️ API 认证失败，请检查密钥配置';
    case 402: return '⚠️ API 余额不足，请充值后重试';
    case 403: return '⚠️ API 权限不足，请检查配置';
    case 429: return '⚠️ 请求过于频繁，请稍后重试';
    default:
      if (status >= 500) return '⚠️ 服务暂时不可用，请稍后重试';
      return '⚠️ 处理消息时出错，请稍后重试';
  }
}

/** Cooldown tracker: prevents spamming the user with repeated error messages */
const errorCooldowns = new Map<string, number>();
const ERROR_COOLDOWN_MS = 30_000; // 30 秒

/** Notify user of proxy-layer error via IM (if notifyUser is available) */
function notifyUserError(status: number) {
  const bot = getCurrentBot();
  if (!bot?.notifyUser) return;
  const msg = statusToUserMessage(status);
  const key = `${status}:${msg}`;
  const now = Date.now();
  const last = errorCooldowns.get(key) || 0;
  if (now - last < ERROR_COOLDOWN_MS) return; // still in cooldown
  errorCooldowns.set(key, now);
  bot.notifyUser(msg).catch(e => console.error(`[Codex] notifyUser failed: ${e.message}`));
}

// ================================================================
// 配置（从 config.json 读取，不再硬编码）
// ================================================================
interface CodexProxyConfig {
  model: string;
  reportedModel: string;
  upstream: string;
  apiKey: string;
  activeModelProvider?: string;  // 当前 activeModel 对应的 provider 名称
  supportedInputTypes?: string[];  // e.g. ["text"], ["text","image_url"]
}

let _codexConfig: CodexProxyConfig | null = null;

// ================================================================
// P2: ContextManager singleton — token budget + tool output compression + semantic compression
// 延迟初始化：首次请求时从 getConfig() 拿当前 provider 的 apiKey，跟随 bot 切换
let _codexContextManager: ContextManager | null = null;
let _codexContextManagerProvider: string | null = null;  // 追踪创建时的 provider

function getCodexContextManager(): ContextManager {
  const cfg = getConfig();
  const currentProvider = cfg.activeModelProvider || 'deepseek';
  const apiKey = cfg.apiKey || '';

  // provider 变了或第一次创建 → 重建
  if (!_codexContextManager || _codexContextManagerProvider !== currentProvider) {
    // 🔧 从 config.json 动态读取当前 provider 的 baseUrl，不再硬编码
    let providerBaseUrl = '';
    try {
      const configPath = path.join(getDataDir(), 'config.json');
      const raw = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      const providers = raw.providers || {};
      providerBaseUrl = (providers[currentProvider] as Record<string, unknown>)?.baseUrl as string || '';
    } catch { /* fallback: leave providerBaseUrl empty */ }

    _codexContextManager = new ContextManager({
      backend: 'openai',
      budget: {
        maxTokens: 64000,
        reservedForResponse: 8000,
        maxInputTokens: 48000,
      },
      keepRecentRounds: 2,
      maxToolOutputChars: 5000,
      truncateToolOutput: true,
      simplifySuccessOutputs: true,
      preserveSystemPrompt: true,
      preserveReasoning: true,
      debugLog: true,
      ...(apiKey && providerBaseUrl
        ? { semanticCompression: {
            model: cfg.model || 'default-model',
            apiBase: providerBaseUrl,
            apiKey,
            thresholdRatio: 0.5,
            maxOutputTokens: 4096,
            timeoutMs: 10000,
            enableCache: true,
            cacheSize: 200,
          }}
        : {}),
    });
    _codexContextManagerProvider = currentProvider;
    console.log(`[ContextManager] Initialized (provider=${currentProvider}, baseUrl=${providerBaseUrl ? 'configured' : 'none'}, apiKey=${apiKey ? 'yes' : 'no'})`);
  }

  return _codexContextManager;
}

export function initCodexProxyConfig(cfg: CodexProxyConfig) {
  _codexConfig = cfg;
  console.log(`[Codex Proxy] Config loaded: model=${cfg.model}, upstream=${cfg.upstream}`);
}

/**
 * 热切换模型：在 /model 命令中调用，更新内存中的 _codexConfig。
 * 现在 activeModel 已统一到 config.json，实时解析即可。
 */
export function updateCodexConfig(modelSpec: string) {
  if (_codexConfig) {
    const parts = modelSpec.split('/');
    const modelName = parts[parts.length - 1] || modelSpec;
    _codexConfig.model = modelName;
    console.log(`[Codex Proxy] Model hot-switched to: ${modelName}`);
  }
}

/**
 * 解析 activeModel 规格为 provider + model 纯名
 * 例如 "deepseek/deepseek-v4-flash" → { provider: "deepseek", model: "deepseek-v4-flash" }
 */
function parseActiveModel(activeModel: string): { provider: string; model: string } {
  const parts = activeModel.split('/');
  if (parts.length >= 2) {
    return { provider: parts[0], model: parts.slice(1).join('/') };
  }
  return { provider: '', model: activeModel };
}

/** 从配置构建 CodexProxyConfig（可复用） */
function _buildConfig(overrides?: Partial<CodexProxyConfig>): CodexProxyConfig {
  const configPath = path.join(getDataDir(), 'config.json');
  const raw = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
  const codex = raw.codex || {};
  const providers = raw.providers || {};

  // 优先从 activeModel 解析（统一模型选择），fallback 到 codex.model（旧版兼容）
  // 🔧 不再硬编码默认模型，从已配置的 providers 中动态获取
  let modelId = codex.model || '';
  let providerName = '';
  if (raw.activeModel) {
    const parsed = parseActiveModel(raw.activeModel);
    if (parsed.model) {
      modelId = parsed.model;
      providerName = parsed.provider;
    }
  }

  let apiKey = '';
  // 优先用解析出的 provider 名称找 apiKey
  if (providerName && providers[providerName]) {
    apiKey = (providers[providerName] as Record<string, unknown>).apiKey as string || '';
  }
  // fallback：取第一个有 apiKey 的 provider
  if (!apiKey) {
    for (const name of Object.keys(providers)) {
      apiKey = (providers[name] as Record<string, unknown>).apiKey as string || '';
      if (apiKey) break;
    }
  }

  const base: CodexProxyConfig = {
    model: modelId,
    reportedModel: codex.reportedModel || 'gpt-5.5',
    upstream: codex.upstream || 'https://api.deepseek.com/v1/chat/completions',
    apiKey,
    activeModelProvider: providerName || undefined,
    supportedInputTypes: resolveSupportedInputTypes(providers, modelId),
  };
  return overrides ? { ...base, ...overrides } : base;
}

function getConfig(): CodexProxyConfig {
  // Bot 独立配置文件作为唯一真相源 — 每次实时读取
  const botCtx = getCurrentBot();
  const botId = botCtx?.botId || 'CodexBot';
  const botConfigPath = getBotConfigPath(botId);

  let activeModel: string | undefined;

  // 优先读 bot-config.json（唯一真相源）
  try {
    if (fs.existsSync(botConfigPath)) {
      const botCfg = JSON.parse(fs.readFileSync(botConfigPath, 'utf-8'));
      activeModel = botCfg.activeModel;
    }
  } catch (e: unknown) {
    console.error(`[Codex Proxy] Failed to read bot-config.json: ${(e as Error).message}`);
  }

  // Fallback: 用 botCtx.activeModel（内存变量）或 config.json.activeModel
  if (!activeModel) {
    if (botCtx?.activeModel) {
      activeModel = botCtx.activeModel;
    } else {
      try {
        const configPath = path.join(getDataDir(), 'config.json');
        const raw = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
        activeModel = raw.activeModel;
      } catch {
        // 最终 fallback 到 _codexConfig
        if (!_codexConfig) _codexConfig = _buildConfig();
        return _codexConfig!;
      }
    }
  }

  // 用 activeModel 构建配置
  if (activeModel) {
    const parsed = parseActiveModel(activeModel);
    const providersPath = path.join(getDataDir(), 'config.json');
    try {
      const raw = JSON.parse(fs.readFileSync(providersPath, 'utf-8'));
      const providers = raw.providers || {};
      const codex = raw.codex || {};

      let apiKey = '';
      if (parsed.provider && providers[parsed.provider]) {
        apiKey = (providers[parsed.provider] as Record<string, unknown>).apiKey as string || '';
      }
      if (!apiKey) {
        for (const name of Object.keys(providers)) {
          apiKey = (providers[name] as Record<string, unknown>).apiKey as string || '';
          if (apiKey) break;
        }
      }

      return {
        model: parsed.model,
        reportedModel: codex.reportedModel || 'gpt-5.5',
        upstream: codex.upstream || 'https://api.deepseek.com/v1/chat/completions',
        apiKey,
        activeModelProvider: parsed.provider || undefined,
        supportedInputTypes: resolveSupportedInputTypes(providers, parsed.model),
      };
    } catch (e: unknown) {
      console.error(`[Codex Proxy] Failed to build Bot-level config: ${(e as Error).message}`);
    }
  }

  // fallback：用 _codexConfig（启动时 initCodexProxyConfig 设置的全局配置）
  if (!_codexConfig) {
    try {
      _codexConfig = _buildConfig();
      console.log(`[Codex Proxy] Loaded config from config.json (activeModel → model=${_codexConfig.model})`);
    } catch (e: unknown) {
      console.error(`[Codex Proxy] Unable to load config: ${(e as Error).message}`);
    }
  }
  return _codexConfig!;
}

const MODEL = () => getConfig().model;
const REPORTED_MODEL = () => getConfig().reportedModel;
const UPSTREAM = () => getConfig().upstream;
const API_KEY = () => getConfig().apiKey;
const SUPPORTED_INPUT_TYPES = () => getConfig().supportedInputTypes || ["text"];  // default: text-only

/**
 * Resolve supportedInputTypes from providers.models configuration.
 * Handles both string format (old: ["model-id"]) and object format (new: [{id, supportedInputTypes}]).
 * Missing capability declaration defaults to text-only.
 */
export function resolveSupportedInputTypes(providers: Record<string, unknown>, modelId: string): string[] {
  for (const name of Object.keys(providers)) {
    const p = providers[name] as Record<string, unknown>;
    const models = (p.models as unknown[]) || [];
    for (const m of models) {
      if (typeof m === 'string' && m === modelId) return ['text'];  // old string format → text-only
      if (typeof m === 'object' && m !== null && (m as Record<string, unknown>).id === modelId) {
        const types = (m as Record<string, unknown>).supportedInputTypes as string[] | undefined;
        return types && types.length > 0 ? types : ['text'];  // missing/empty → text-only
      }
    }
  }
  return ['text'];  // model not found → text-only
}

// ================================================================
// 类型
// ================================================================

interface ChatMessage {
  role: string;
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  reasoning_content?: string;
}

interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

interface PendingToolCall {
  id: string;
  name: string;
  arguments: string;
  outputIndex: number;
  itemId: string;
  started: boolean;
}

interface ResponseItem {
  id: string;
  type: string;
  role?: string;
  [key: string]: unknown;
}

// ================================================================
// 1. 请求翻译: Responses → Chat Completions
// ================================================================
function responsesToChat(body: OpenAIRequestBody): { model: string; messages: ChatMessage[]; stream: boolean; max_tokens?: number; tools?: OpenAITool[] } {
  const chat: { model: string; messages: ChatMessage[]; stream: boolean; max_tokens?: number; tools?: OpenAITool[]; thinking?: { type: string } } = {
    model: MODEL(),
    messages: [],
    stream: true,
    thinking: { type: 'disabled' },  // Codex doesn't support thinking mode; content is all null causing stream disconnect
  };
  chat.max_tokens = body.max_output_tokens || 8192;

  // 工具转换
  if (body.tools?.length) {
    const allNames = body.tools.map((t) => (t as OpenAITool).function?.name || (t as { name?: string }).name || '').filter((n) => n && n.length > 0).join(', ');
    console.log(`[Codex] tools: ${allNames}`);
    chat.tools = body.tools
      .map((t) => {
        if ((t as OpenAITool).function) return t as OpenAITool;
        const params = (t as { parameters?: Record<string, unknown> }).parameters || {};
        const p = JSON.parse(JSON.stringify(params, (_: string, v) => v === null ? undefined : v));
        if (!p.type) p.type = 'object';
        return { type: 'function', function: { name: t.name || '', description: t.description || '', parameters: p } };
      })
      .filter((t) => (t as OpenAITool).function?.name && (t as OpenAITool).function!.name.length > 0);
  }

  // 消息转换
  let input: ResponseItem[] = ((body as OpenAIRequestBody).input as ResponseItem[]) || [];
  if (input.length > 0) {
    // 防护：输入历史过长时截断，防止 tool call loop 导致 OOM
    const MAX_INPUT_ITEMS = 120;
    if (input.length > MAX_INPUT_ITEMS) {
      const truncated = input.length - MAX_INPUT_ITEMS;
      // 保留 system 消息（如果有）+ 最近 MAX_INPUT_ITEMS 条
      const systemItems = input.filter((m) => m.role === 'system' || m.role === 'developer');
      const nonSystem = input.filter((m) => m.role !== 'system' && m.role !== 'developer');
      const kept = nonSystem.slice(-(MAX_INPUT_ITEMS - systemItems.length));
      input = [...systemItems, ...kept];
      console.log(`[Codex] ⚠️ Truncated input: ${input.length + truncated} → ${input.length} items (discarded oldest ${truncated})`);
    }
    const types = input.map((m) => m.type || ('msg:' + m.role)).join(',');
    console.log(`[Codex] input types: [${types}]`);
    console.log(`[Codex] input items: ${input.length}`);
  }
  let pendingReasoning = '';
  let i = 0;

  while (i < input.length) {
    const msg = input[i];

    if (msg.type === 'reasoning') {
      const summary = msg.summary || [];
      pendingReasoning = summary.map((s) => (s as { text?: string; summary_text?: string }).text || (s as { text?: string; summary_text?: string }).summary_text || '').join('').trim();
      i++;
      continue;
    }

    if (msg.type === 'function_call') {
      const tc: ToolCall = {
        id: msg.call_id || '',
        type: 'function',
        function: { name: msg.name || '', arguments: msg.arguments || '{}' },
      };
      const lastMsg = chat.messages[chat.messages.length - 1];
      // Only append to previous assistant if it already has tool_calls (multi-call in one turn)
      // Do NOT append to assistant that has text content — that breaks tool_call/tool pairing
      if (lastMsg && lastMsg.role === 'assistant' && lastMsg.tool_calls?.length) {
        lastMsg.tool_calls.push(tc);
      } else {
        const asstMsg: ChatMessage = { role: 'assistant', content: null, tool_calls: [tc] };
        if (pendingReasoning) { asstMsg.reasoning_content = pendingReasoning; pendingReasoning = ''; }
        chat.messages.push(asstMsg);
      }
      i++;
      continue;
    }

    if (msg.type === 'function_call_output') {
      // CRITICAL: tool_call_id must exactly match the tool_call.id from the assistant message
      // Some upstreams send call_id without 'call_' prefix, some with — keep it exactly as-is
      chat.messages.push({ role: 'tool', tool_call_id: msg.call_id || '', content: msg.output || '' });
      i++;
      continue;
    }

    // Unsupported standalone types — degrade to text
    if (msg.type === 'input_image') {
      const mime = msg.media_type || msg.mime_type || 'image/png';
      console.log(`[Codex] ⚠️ Degrading standalone input_image to text hint (mime=${mime})`);
      const reasonText = `[Image received (${mime}), current model does not support image input]`;
      const role: string = msg.role === 'developer' ? 'system' : (msg.role || 'user');
      const last = chat.messages[chat.messages.length - 1];
      if (last && last.role === role && role === 'user') {
        last.content = (last.content || '') + '\n' + reasonText;
      } else {
        chat.messages.push({ role, content: reasonText });
      }
      i++;
      continue;
    }
    if (msg.type === 'input_file') {
      const name = msg.filename || msg.file_name || 'unknown file';
      const textContent = msg.text || msg.content || '';
      const fileText = textContent || `[File received: ${name}, current model does not support file input]`;
      console.log(`[Codex] ⚠️ Degrading standalone input_file to text hint (${name})`);
      const role: string = msg.role === 'developer' ? 'system' : (msg.role || 'user');
      const last = chat.messages[chat.messages.length - 1];
      if (last && last.role === role && role === 'user') {
        last.content = (last.content || '') + '\n' + fileText;
      } else {
        chat.messages.push({ role, content: fileText });
      }
      i++;
      continue;
    }

    // 普通消息
    let content: string | Array<Record<string, unknown>>;
    let embeddedToolCalls: ToolCall[] | undefined;
    if (typeof msg.content === 'string') {
      content = msg.content;
    } else if (Array.isArray(msg.content)) {
      const textParts: string[] = [];
      const calls: ToolCall[] = [];

      for (const b of msg.content) {
        if (b.type === 'function_call') {
          calls.push({ id: b.call_id || '', type: 'function', function: { name: b.name || '', arguments: b.arguments || '{}' } });
        } else if (b.type === 'input_image') {
          const mime = b.media_type || b.mime_type || 'image/png';
          if (!SUPPORTED_INPUT_TYPES().includes('image_url')) {
            textParts.push(`[Image received (${mime}), current model doesn't support image input]`);
          } else {
            textParts.push(`[Image received (${mime}), format: image_url]`);
          }
        } else if (b.type === 'input_file') {
          if (b.text || b.content) {
            textParts.push(b.text || b.content || '');
          } else {
            const name = b.filename || b.file_name || 'unknown file';
            if (!SUPPORTED_INPUT_TYPES().includes('file')) {
              textParts.push(`[File received: ${name}, current model doesn't support file input]`);
            } else {
              textParts.push(`[File received: ${name}]`);
            }
          }
        } else {
          const t = b.text || b.input_text || b.output_text || '';
          if (t) textParts.push(t);
        }
      }

      content = textParts.join('');
      if (calls.length > 0) embeddedToolCalls = calls;
    } else {
      content = '';
    }
    const role: string = msg.role === 'developer' ? 'system' : (msg.role || 'user');

    const last = chat.messages[chat.messages.length - 1];
    if (last && last.role === role && role === 'user') {
      last.content = (last.content || '') + '\n' + content;
    } else {
      const chatMsg: ChatMessage = { role, content };
      if (role === 'assistant') {
        if (pendingReasoning) { chatMsg.reasoning_content = pendingReasoning; pendingReasoning = ''; }
        if (embeddedToolCalls) chatMsg.tool_calls = embeddedToolCalls;
        // If previous message is assistant(tool_calls) with no content (from function_call),
        // merge its tool_calls into this text-bearing assistant to keep tool_call/tool pairing
        if (last?.role === 'assistant' && last?.tool_calls?.length) {
          chatMsg.tool_calls = [...(last.tool_calls), ...(chatMsg.tool_calls || [])];
          // Preserve reasoning_content from the merged function_call assistant
          if (last.reasoning_content && !chatMsg.reasoning_content) chatMsg.reasoning_content = last.reasoning_content;
          chat.messages.pop(); // remove empty-shell assistant(tool_calls)
        }
      }
      chat.messages.push(chatMsg);
    }
    i++;
  }

  // Clean up orphaned tool messages (from truncation)
  chat.messages = cleanOrphanTools(chat.messages);
  // Validate tool_call/tool pairing before returning
  chat.messages = validateToolPairing(chat.messages);
  // DEBUG: log converted messages
  console.log(`[Codex] converted ${chat.messages.length} messages:`);
  chat.messages.forEach((m: ChatMessage, idx: number) => {
    const tcs = m.tool_calls?.map(tc => tc.id.slice(0,16)).join(',') || '';
    const tci = m.tool_call_id?.slice(0,16) || '';
    console.log(`[Codex]   [${idx}] ${m.role}${tcs ? ' tool_calls=['+tcs+']' : ''}${tci ? ' tool_call_id='+tci : ''}`);
  });
  return chat;
}

// ================================================================
// 1.5 工具消息配对验证
// 确保每个 assistant(tool_calls) 后面紧跟对应数量的 tool 消息，
// 且 tool_call_id 一一对应。严格 API 需要此验证。
// ================================================================
function cleanOrphanTools(messages: ChatMessage[]): ChatMessage[] {
  // Build set of all tool_call ids from assistant messages with tool_calls
  const allToolCallIds = new Set<string>();
  for (const m of messages) {
    if (m.role === 'assistant' && m.tool_calls?.length) {
      for (const tc of m.tool_calls) {
        allToolCallIds.add(tc.id);
      }
    }
  }
  // Remove tool messages whose tool_call_id doesn't match any existing tool_call
  const filtered = messages.filter(m => {
    if (m.role !== 'tool') return true;
    if (allToolCallIds.has(m.tool_call_id || '')) return true;
    console.warn(`[Codex] 🗑️ Discarded orphan tool message: call_id=${(m.tool_call_id || '').slice(0,16)}`);
    return false;
  });
  return filtered.length === messages.length ? messages : filtered;
}

function validateToolPairing(messages: ChatMessage[]): ChatMessage[] {
  const result: ChatMessage[] = [];
  let i = 0;

  while (i < messages.length) {
    const msg = messages[i];

    if (msg.role === 'assistant' && msg.tool_calls?.length) {
      // Collect this assistant's tool_call ids
      const expectedIds = new Set(msg.tool_calls.map(tc => tc.id));
      const collectedTools: ChatMessage[] = [];
      const seenIds = new Set<string>();
      let j = i + 1;

      // Collect following tool messages
      while (j < messages.length && messages[j].role === 'tool') {
        collectedTools.push(messages[j]);
        seenIds.add(messages[j].tool_call_id || '');
        j++;
      }

      // Check for exact match
      const unmatchedCalls = msg.tool_calls.filter(tc => !seenIds.has(tc.id));
      const unmatchedTools = collectedTools.filter(t => !expectedIds.has(t.tool_call_id || ''));

      if (unmatchedCalls.length > 0 || unmatchedTools.length > 0) {
        console.warn(`[Codex] ⚠️ Tool pairing mismatch:`);
        console.warn(`[Codex]   expected: [${[...expectedIds].map(id=>id.slice(0,16)).join(', ')}]`);
        console.warn(`[Codex]   found:    [${[...seenIds].map(id=>id.slice(0,16)).join(', ')}]`);
        if (unmatchedCalls.length > 0) console.warn(`[Codex]   unmatched calls: [${unmatchedCalls.map(tc=>tc.id.slice(0,16)).join(', ')}]`);
        if (unmatchedTools.length > 0) console.warn(`[Codex]   unmatched tools: [${unmatchedTools.map(t=>t.tool_call_id?.slice(0,16)).join(', ')}]`);
        const matchingTools = collectedTools.filter(t => expectedIds.has(t.tool_call_id || ''));
        if (matchingTools.length > 0) {
          // Strip unmatched tool_calls from assistant, keep only those with matching tools
          msg.tool_calls = msg.tool_calls!.filter(tc => seenIds.has(tc.id));
          if (msg.tool_calls.length > 0) {
            result.push(msg);
            result.push(...matchingTools);
          }
        } else {
          // P1 fix: don't discard entire assistant message, preserve original content with warning
          // So downstream context isn't completely lost
          const warning = '[⚠️ IMtoAgent WARNING: tool_call has no matching tool response, preserving original message to prevent context loss]';
          console.warn(`[Codex] ⚠️ Keeping original assistant message (with warning), not discarding`);
          const preserved: ChatMessage = {
            role: 'assistant',
            content: warning + '\n' + (msg.content || ''),
            tool_calls: undefined, // Remove invalid tool_calls
          };
          if (msg.reasoning_content) preserved.reasoning_content = msg.reasoning_content;
          result.push(preserved);
        }
        i = j;
        continue;
      }

      // Perfect match — keep as-is
      result.push(msg);
      result.push(...collectedTools);
      i = j;
      continue;
    }

    // Not an assistant with tool_calls — keep as-is
    result.push(msg);
    i++;
  }

  return result;
}

// ================================================================
// 1.5 DSML XML 解析 — DeepSeek 模型的工具调用格式
// 模型在 content 里输出 <｜DSML｜tool_calls>...</｜DSML｜tool_calls>，需要解析执行
// ================================================================
interface DSMLToolCall {
  name: string;
  arguments: Record<string, unknown>;
}

function parseDSMLXML(text: string): DSMLToolCall[] {
  const calls: DSMLToolCall[] = [];
  // 匹配 <｜｜DSML｜｜invoke name="xxx">...</｜｜DSML｜｜invoke>
  const invokeRe = /<｜｜DSML｜｜invoke\s+name="([^"]+)"[^>]*>([\s\S]*?)<\/｜｜DSML｜｜invoke>/g;
  let m: RegExpExecArray | null;
  while ((m = invokeRe.exec(text)) !== null) {
    const name = m[1];
    const paramsStr = m[2];
    const args: Record<string, unknown> = {};
    // 解析参数: <｜｜DSML｜｜parameter name="xxx" string="true">value</｜｜DSML｜｜parameter>
    const paramRe = /<｜｜DSML｜｜parameter\s+name="([^"]+)"[^>]*>([\s\S]*?)<\/｜｜DSML｜｜parameter>/g;
    let pm: RegExpExecArray | null;
    while ((pm = paramRe.exec(paramsStr)) !== null) {
      const paramName = pm[1];
      const paramValue = pm[2].trim();
      // 尝试解析 JSON，否则作为字符串
      try {
        args[paramName] = JSON.parse(paramValue);
      } catch {
        args[paramName] = paramValue;
      }
    }
    calls.push({ name, arguments: args });
  }
  return calls;
}

function stripDSMLXML(text: string): string {
  // Strip complete tool_call XML blocks (double pipe format)
  let result = text.replace(/<[^>]*DSML[^>]*tool_calls[^>]*>[\s\S]*?<\/[^>]*tool_calls[^>]*>/g, '');
  // Strip trailing partial fragments (accumulate across chunks)
  result = result.replace(/<[^>]*DSML[\s\S]*$/g, '');
  // Strip leading close tags that lost their open tag
  result = result.replace(/^[\s\S]*?<\/[^>]*tool_calls[^>]*>/g, '');
  return result;
}

// ================================================================
// 1.6 流式工具调用解析（用于拦截模式）
// 解析第一次流式响应，收集 tool_calls 但不输出给用户
// ================================================================
interface StreamToolCallInfo {
  toolCalls: Array<{ id: string; type: string; function: { name: string; arguments: string } }>;
  assistantText: string;
  reasoningContent: string;
}

async function parseStreamToolCalls(upstreamRes: Response): Promise<StreamToolCallInfo> {
  const result: StreamToolCallInfo = { toolCalls: [], assistantText: '', reasoningContent: '' };

  if (!upstreamRes.body) return result;

  const reader = upstreamRes.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  let rawContentAccum = '';  // 累积原始 content，用于流结束后解析 DSML XML

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop() || '';

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const data = line.slice(6);
        if (data === '[DONE]') continue;

        let chunk: OpenAIStreamChunk;
        try { chunk = JSON.parse(data); } catch { continue; }

        const delta = chunk.choices?.[0]?.delta || {};

        if (delta.reasoning_content) {
          result.reasoningContent += delta.reasoning_content;
        }
        if (delta.content) {
          // 累积原始 content，用于流结束后解析 DSML XML
          rawContentAccum += delta.content;
          // 先过滤 DSML XML 标记，防止泄漏给 Codex（临时方案：先全部过滤，流结束后再解析）
          const cleaned = stripDSMLXML(delta.content); // already handles both formats
          result.assistantText += cleaned;
        }
        if (delta.tool_calls) {
          for (const tc of delta.tool_calls) {
            const idx: number = tc.index ?? result.toolCalls.length;
            // 确保数组连续，避免稀疏数组
            while (result.toolCalls.length <= idx) {
              result.toolCalls.push({
                id: `call_placeholder_${Date.now()}_${result.toolCalls.length}`,
                type: 'function',
                function: { name: '', arguments: '' },
              });
            }
            if (tc.id) result.toolCalls[idx].id = tc.id;
            if (tc.function?.name) result.toolCalls[idx].function.name = tc.function.name;
            if (tc.function?.arguments) result.toolCalls[idx].function.arguments += tc.function.arguments;
          }
        }
      }
    }
  } catch {
    // stream broken — return what we have
  } finally {
    reader.releaseLock();
  }

  // 流结束后解析 DSML XML 中的所有工具调用（本地 + 远程）
  if (rawContentAccum) {
    const dsmlCalls = parseDSMLXML(rawContentAccum);
    // 去重：只添加标准 tool_calls 中不存在的 DSML 调用
    const existingNames = new Set(result.toolCalls.map(tc => tc.function.name));
    for (const call of dsmlCalls) {
      if (!existingNames.has(call.name)) {
        result.toolCalls.push({
          id: `call_${call.name}_${Date.now()}_${result.toolCalls.length}`,
          type: 'function',
          function: { name: call.name, arguments: JSON.stringify(call.arguments) },
        });
        console.log(`[Codex] 📦 Parsed DSML XML tool call: ${call.name} (${isLocalTool(call.name) ? 'local' : 'remote'})`);
      } else {
        console.log(`[Codex] ⏭️ DSML XML tool ${call.name} already in standard tool_calls, skipping`);
      }
    }
    // 从 assistantText 中移除 DSML XML 内容
    if (dsmlCalls.length > 0) {
      result.assistantText = stripDSMLXML(rawContentAccum);
    }
  }

  return result;
}

// ================================================================
// Phase 3: StreamResponseResult — what streamResponse returns after finishing
// ================================================================
interface StreamResponseResult {
  collectedToolCalls: Array<{ id: string; type: string; function: { name: string; arguments: string } }>;
}

// ================================================================
// 2. 响应翻译: Chat SSE → Responses SSE
// ================================================================
async function streamResponse(upstreamRes: Response, resWriter: WritableStreamDefaultWriter<Uint8Array>, reqBody?: OpenAIRequestBody, opts?: { suppressToolCalls?: boolean }): Promise<StreamResponseResult> {
  const suppressToolCalls = opts?.suppressToolCalls ?? false;
  if (suppressToolCalls) console.log('[Codex] 🔇 streamResponse: suppressing tool_call emission (post-intercept mode)');
  const collectedToolCalls: Array<{ id: string; type: string; function: { name: string; arguments: string } }> = [];
  const enc = new TextEncoder();
  let accumulatedText = '';
  let accumulatedReasoning = '';
  let outputIndex = 0;
  const items: ResponseItem[] = [];
  let msgId = '';
  let msgIdx = -1;
  let rsnIdx = -1;
  let rsnActive = false, msgActive = false;
  let hasStarted = false;
  let finalUsage: AnthropicResponseUsage | Record<string, unknown> = {};
  const pendingToolCalls = new Map<number, PendingToolCall>();

  let streamBroken = false;
  let rawContentAccum = '';  // 累积原始 content，用于流结束后解析 DSML XML
  function emit(event: string, data: unknown): void {
    if (streamBroken) return;
    try {
      resWriter.write(enc.encode(`event: ${event}\ndata: ${JSON.stringify({ type: event, ...data })}\n\n`));
    } catch {
      streamBroken = true;
    }
  }

  function ensureStarted(): void {
    if (hasStarted) return;
    hasStarted = true;
    emit('response.created', { response: { id: 'resp_' + Date.now(), object: 'response', model: REPORTED_MODEL(), status: 'in_progress', output: [] } });
    emit('response.in_progress', { response: { id: 'resp_' + Date.now(), object: 'response', model: REPORTED_MODEL(), status: 'in_progress' } });
  }

  const reader = upstreamRes.body!.getReader();
  try {
    const dec = new TextDecoder();
    let buf = '';

    while (true) {
      let done: boolean, value: Uint8Array;
      try {
        ({ done, value } = await reader.read());
      } catch {
        break;
      }
      if (done || streamBroken) break;
      buf += dec.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop() || '';

      for (const line of lines) {
        if (streamBroken) break;
        if (!line.startsWith('data: ')) continue;
        const data = line.slice(6);
        if (data === '[DONE]') continue;

        let chunk: OpenAIStreamChunk;
        try { chunk = JSON.parse(data); } catch { continue; }

        const delta = chunk.choices?.[0]?.delta || {};
        const finish = chunk.choices?.[0]?.finish_reason;

        if (chunk.usage) finalUsage = chunk.usage;

        if (delta.reasoning_content) {
          ensureStarted();
          if (!rsnActive) {
            rsnIdx = outputIndex++;
            emit('response.output_item.added', { output_index: rsnIdx, item: { id: 'rsn_0', type: 'reasoning', summary: [], status: 'in_progress' } });
            rsnActive = true;
            items.push({ id: 'rsn_0', type: 'reasoning', summary: [], status: 'completed' });
          }
          accumulatedReasoning += delta.reasoning_content;
          emit('response.reasoning_text.delta', { item_id: 'rsn_0', output_index: rsnIdx, delta: delta.reasoning_content });
        }

        if (delta.tool_calls) {
          if (suppressToolCalls) {
            // Post-intercept re-fetch: model may still emit tool_calls due to history context.
            // Silently discard them — we already handled all tools in the intercept phase.
            console.log(`[Codex] 🔇 Suppressed ${delta.tool_calls.length} tool_call(s) from re-fetch response`);
          } else {
            ensureStarted();
            for (const tc of delta.tool_calls) {
              const idx: number = tc.index ?? 0;
              let pending = pendingToolCalls.get(idx);
              if (!pending) {
                pending = {
                  id: tc.id || ('call_' + Date.now() + '_' + idx),
                  name: '',
                  arguments: '',
                  outputIndex: outputIndex++,
                  itemId: 'fcal_' + Date.now() + '_' + idx,
                  started: false,
                };
                pendingToolCalls.set(idx, pending);
              }
              if (tc.id) pending.id = tc.id;
              if (tc.function?.name) {
                // Reverse translation: map DeepSeek response tool names back to upstream names
                pending.name = tc.function.name;
              }
              if (tc.function?.arguments) {
                pending.arguments += tc.function.arguments;
                if (!pending.started) {
                  pending.started = true;
                  emit('response.output_item.added', {
                    output_index: pending.outputIndex,
                    item: { id: pending.itemId, type: 'function_call', call_id: pending.id, name: pending.name, arguments: '', status: 'in_progress' }
                  });
                  items.push({ id: pending.itemId, type: 'function_call', call_id: pending.id, name: pending.name, arguments: '', status: 'completed' });
                }
                emit('response.function_call_arguments.delta', {
                  item_id: pending.itemId, output_index: pending.outputIndex, delta: tc.function.arguments
                });
              }
            }
          }
          // Always collect tool_calls for Phase 3 analysis (even when suppressed)
          for (const tc of delta.tool_calls) {
            const idx: number = tc.index ?? 0;
            while (collectedToolCalls.length <= idx) {
              collectedToolCalls.push({ id: '', type: 'function', function: { name: '', arguments: '' } });
            }
            if (tc.id) collectedToolCalls[idx].id = tc.id;
            if (tc.function?.name) collectedToolCalls[idx].function.name = tc.function.name;
            if (tc.function?.arguments) collectedToolCalls[idx].function.arguments += tc.function.arguments;
          }
        }

        if (delta.content) {
          // 累积原始 content，用于流结束后解析 DSML XML（兼容 Qwen/DeepSeek 等模型的 DSML 格式输出）
          rawContentAccum += delta.content;
          // 过滤 DSML XML 后转发给客户端
          let contentToEmit = stripDSMLXML(delta.content);
          if (contentToEmit !== delta.content) {
            console.log(`[Codex] 🔇 Filtered DSML XML from content delta (${delta.content.length} → ${contentToEmit.length} chars)`);
          }
          
          if (contentToEmit) {
            ensureStarted();
            if (!msgActive) {
              if (rsnActive) {
                emit('response.output_item.done', { output_index: rsnIdx, item: { id: 'rsn_0', type: 'reasoning', summary: [{ type: 'summary_text', text: accumulatedReasoning }], status: 'completed' } });
                rsnActive = false;
              }
              msgIdx = outputIndex++;
              msgId = 'msg_' + Date.now();
              emit('response.output_item.added', { output_index: msgIdx, item: { id: msgId, type: 'message', role: 'assistant', content: [], status: 'in_progress' } });
              emit('response.content_part.added', { item_id: msgId, output_index: msgIdx, content_index: 0, part: { type: 'output_text', text: '' } });
              msgActive = true;
              items.push({ id: msgId, type: 'message', role: 'assistant', content: [], status: 'completed' });
            }
            accumulatedText += contentToEmit;
            emit('response.output_text.delta', { item_id: msgId, output_index: msgIdx, content_index: 0, delta: contentToEmit });
          }
        }

        if (finish) {
          if (rsnActive) {
            if (accumulatedReasoning) {
              const rsnItem: ResponseItem = { id: 'rsn_0', type: 'reasoning', summary: [{ type: 'summary_text', text: accumulatedReasoning }], status: 'completed' };
              items[rsnIdx] = rsnItem;
              emit('response.output_item.done', { output_index: rsnIdx, item: rsnItem });
            }
            rsnActive = false;
          }
          for (const [, pending] of pendingToolCalls) {
            if (pending.started) {
              const fcItem: ResponseItem = { id: pending.itemId, type: 'function_call', call_id: pending.id, name: pending.name, arguments: pending.arguments, status: 'completed' };
              items[pending.outputIndex] = fcItem;
              emit('response.output_item.done', { output_index: pending.outputIndex, item: fcItem });
            }
          }
          pendingToolCalls.clear();
          if (msgActive) {
            const msgItem: ResponseItem = { id: msgId, type: 'message', role: 'assistant', content: [{ type: 'output_text', text: accumulatedText }], status: 'completed' };
            items[msgIdx] = msgItem;
            emit('response.output_text.done', { item_id: msgId, output_index: msgIdx, content_index: 0, text: accumulatedText });
            emit('response.content_part.done', { item_id: msgId, output_index: msgIdx, content_index: 0, part: { type: 'output_text', text: accumulatedText } });
            emit('response.output_item.done', { output_index: msgIdx, item: msgItem });
            msgActive = false;
          }

          // 流结束后解析 DSML XML 中的工具调用（兼容 Qwen/DeepSeek 等模型）
          // 将 DSML 解析的工具合并到 collectedToolCalls，去重后供 Phase 3 V2 分析
          if (rawContentAccum) {
            const dsmlCalls = parseDSMLXML(rawContentAccum);
            const existingNames = new Set(collectedToolCalls.map(tc => tc.function.name));
            for (const call of dsmlCalls) {
              if (!existingNames.has(call.name)) {
                const rawArgs = JSON.stringify(call.arguments);
                collectedToolCalls.push({
                  id: `call_${call.name}_${Date.now()}_${collectedToolCalls.length}`,
                  type: 'function',
                  function: { name: call.name, arguments: rawArgs },
                });
                console.log(`[Codex] 📦 streamResponse: parsed DSML XML tool call from content: ${call.name}`);
              }
            }
            // 从 accumulatedText 中彻底移除 DSML XML
            if (dsmlCalls.length > 0 && accumulatedText !== rawContentAccum) {
              const cleanedFull = stripDSMLXML(rawContentAccum);
              if (cleanedFull !== accumulatedText) {
                accumulatedText = cleanedFull;
                // 更新已发出的 message 内容（msgIdx 已在 msgActive 时赋值）
                if (msgIdx >= 0 && items[msgIdx]) {
                  const existingItem = items[msgIdx];
                  items[msgIdx] = { ...existingItem, content: [{ type: 'output_text', text: accumulatedText }] };
                }
              }
            }
          }

          emit('response.completed', {
            response: {
              id: 'resp_' + Date.now(), object: 'response', model: REPORTED_MODEL(), status: 'completed',
              output: items,
              usage: {
                input_tokens: finalUsage.prompt_tokens || 0,
                output_tokens: finalUsage.completion_tokens || 0,
                total_tokens: finalUsage.total_tokens || 0,
              },
            }
          });
          accumulateProxyUsage(finalUsage.prompt_tokens || 0, finalUsage.completion_tokens || 0);

          // P1: 记录 Codex 请求的 usage
          const inT = finalUsage.prompt_tokens || 0;
          const outT = finalUsage.completion_tokens || 0;
          if (inT > 0 || outT > 0) {
            logUsage({
              timestamp: new Date().toISOString(),
              provider: 'codex',
              model: MODEL(),
              inputTokens: inT,
              outputTokens: outT,
              totalTokens: inT + outT,
              isStream: true,
              messageCount: Array.isArray(reqBody?.messages) ? reqBody.messages.length : Array.isArray((reqBody as any)?.input) ? (reqBody as any).input.length : undefined,
              hasTools: !!(Array.isArray(reqBody?.tools) && (reqBody.tools as any[]).length > 0),
            });
          }
        }
      }
    }
  } catch {
    // 静默处理
  } finally {
    try { reader.cancel(); } catch {}
  }
  return { collectedToolCalls };
}

// ================================================================
// usage 累加器 — 内部统计，供 accumulateProxyUsage 记录
// ================================================================
let _proxyUsage = { inputTokens: 0, outputTokens: 0 };

export function accumulateProxyUsage(inputTokens: number, outputTokens: number) {
  _proxyUsage.inputTokens += inputTokens;
  _proxyUsage.outputTokens += outputTokens;
}

// ================================================================
// Phase 3 V2: SSE 流构造器 — 缓存优先模式
// 第一轮完全缓存，根据 tool_calls 类型决定输出方式
// ================================================================

/**
 * 构造纯文本响应的 SSE 流（无 tool_calls 时使用）
 * 事件序列与 streamResponse 保持一致
 */
function buildSyntheticStream(text: string, reasoning: string, model: string): string {
  const respId = 'resp_' + Date.now();
  const events: string[] = [];
  const output: unknown[] = [];
  let outputIndex = 0;

  function emit(event: string, data: unknown) {
    events.push(`event: ${event}\ndata: ${JSON.stringify({ type: event, ...data })}\n\n`);
  }

  // response.created + response.in_progress
  emit('response.created', { response: { id: respId, object: 'response', model, status: 'in_progress', output: [] } });
  emit('response.in_progress', { response: { id: respId, object: 'response', model, status: 'in_progress' } });

  // reasoning 部分（如果有）
  if (reasoning) {
    const rsnIdx = outputIndex++;
    const rsnId = 'rsn_0';
    emit('response.output_item.added', { output_index: rsnIdx, item: { id: rsnId, type: 'reasoning', summary: [], status: 'in_progress' } });
    // 分块发送 reasoning text（模拟流式）
    const CHUNK_SIZE = 200;
    for (let i = 0; i < reasoning.length; i += CHUNK_SIZE) {
      const chunk = reasoning.slice(i, i + CHUNK_SIZE);
      emit('response.reasoning_text.delta', { item_id: rsnId, output_index: rsnIdx, delta: chunk });
    }
    const rsnItem = { id: rsnId, type: 'reasoning', summary: [{ type: 'summary_text', text: reasoning }], status: 'completed' };
    output.push(rsnItem);
    emit('response.output_item.done', { output_index: rsnIdx, item: rsnItem });
  }

  // message 部分（如果有 text）
  if (text) {
    const msgIdx = outputIndex++;
    const msgId = 'msg_' + Date.now();
    emit('response.output_item.added', { output_index: msgIdx, item: { id: msgId, type: 'message', role: 'assistant', content: [], status: 'in_progress' } });
    emit('response.content_part.added', { item_id: msgId, output_index: msgIdx, content_index: 0, part: { type: 'output_text', text: '' } });
    // 分块发送 text（模拟流式）
    const CHUNK_SIZE = 200;
    for (let i = 0; i < text.length; i += CHUNK_SIZE) {
      const chunk = text.slice(i, i + CHUNK_SIZE);
      emit('response.output_text.delta', { item_id: msgId, output_index: msgIdx, content_index: 0, delta: chunk });
    }
    emit('response.output_text.done', { item_id: msgId, output_index: msgIdx, content_index: 0, text });
    emit('response.content_part.done', { item_id: msgId, output_index: msgIdx, content_index: 0, part: { type: 'output_text', text } });
    const msgItem = { id: msgId, type: 'message', role: 'assistant', content: [{ type: 'output_text', text }], status: 'completed' };
    output.push(msgItem);
    emit('response.output_item.done', { output_index: msgIdx, item: msgItem });
  }

  // response.completed
  emit('response.completed', {
    response: {
      id: respId, object: 'response', model, status: 'completed',
      output,
    }
  });

  return events.join('');
}

/**
 * 构造包含 tool_calls 的 SSE 流（有远端工具时使用）
 * 只包含远端工具的 tool_calls，不包含本地工具
 */
function buildToolCallsResponseStream(
  remoteToolCalls: Array<{ id: string; type: string; function: { name: string; arguments: string } }>,
  text: string,
  reasoning: string,
  model: string,
): string {
  const respId = 'resp_' + Date.now();
  const events: string[] = [];
  const output: unknown[] = [];
  let outputIndex = 0;

  function emit(event: string, data: unknown) {
    events.push(`event: ${event}\ndata: ${JSON.stringify({ type: event, ...data })}\n\n`);
  }

  // response.created + response.in_progress
  emit('response.created', { response: { id: respId, object: 'response', model, status: 'in_progress', output: [] } });
  emit('response.in_progress', { response: { id: respId, object: 'response', model, status: 'in_progress' } });

  // reasoning 部分（如果有）
  if (reasoning) {
    const rsnIdx = outputIndex++;
    const rsnId = 'rsn_0';
    emit('response.output_item.added', { output_index: rsnIdx, item: { id: rsnId, type: 'reasoning', summary: [], status: 'in_progress' } });
    const CHUNK_SIZE = 200;
    for (let i = 0; i < reasoning.length; i += CHUNK_SIZE) {
      const chunk = reasoning.slice(i, i + CHUNK_SIZE);
      emit('response.reasoning_text.delta', { item_id: rsnId, output_index: rsnIdx, delta: chunk });
    }
    const rsnItem = { id: rsnId, type: 'reasoning', summary: [{ type: 'summary_text', text: reasoning }], status: 'completed' };
    output.push(rsnItem);
    emit('response.output_item.done', { output_index: rsnIdx, item: rsnItem });
  }

  // message 部分（如果有 text）
  if (text) {
    const msgIdx = outputIndex++;
    const msgId = 'msg_' + Date.now();
    emit('response.output_item.added', { output_index: msgIdx, item: { id: msgId, type: 'message', role: 'assistant', content: [], status: 'in_progress' } });
    emit('response.content_part.added', { item_id: msgId, output_index: msgIdx, content_index: 0, part: { type: 'output_text', text: '' } });
    const CHUNK_SIZE = 200;
    for (let i = 0; i < text.length; i += CHUNK_SIZE) {
      const chunk = text.slice(i, i + CHUNK_SIZE);
      emit('response.output_text.delta', { item_id: msgId, output_index: msgIdx, content_index: 0, delta: chunk });
    }
    emit('response.output_text.done', { item_id: msgId, output_index: msgIdx, content_index: 0, text });
    emit('response.content_part.done', { item_id: msgId, output_index: msgIdx, content_index: 0, part: { type: 'output_text', text } });
    const msgItem = { id: msgId, type: 'message', role: 'assistant', content: [{ type: 'output_text', text }], status: 'completed' };
    output.push(msgItem);
    emit('response.output_item.done', { output_index: msgIdx, item: msgItem });
  }

  // function_call 部分（远端 tool_calls）
  for (const tc of remoteToolCalls) {
    const fcIdx = outputIndex++;
    const fcId = 'fcal_' + Date.now() + '_' + fcIdx;
    emit('response.output_item.added', {
      output_index: fcIdx,
      item: { id: fcId, type: 'function_call', call_id: tc.id, name: tc.function.name, arguments: '', status: 'in_progress' }
    });
    // 分块发送 arguments
    const args = tc.function.arguments || '{}';
    const CHUNK_SIZE = 200;
    for (let i = 0; i < args.length; i += CHUNK_SIZE) {
      const chunk = args.slice(i, i + CHUNK_SIZE);
      emit('response.function_call_arguments.delta', { item_id: fcId, output_index: fcIdx, delta: chunk });
    }
    const fcItem = { id: fcId, type: 'function_call', call_id: tc.id, name: tc.function.name, arguments: args, status: 'completed' };
    output.push(fcItem);
    emit('response.output_item.done', { output_index: fcIdx, item: fcItem });
  }

  // response.completed
  emit('response.completed', {
    response: {
      id: respId, object: 'response', model, status: 'completed',
      output,
    }
  });

  return events.join('');
}

// 3. 请求处理器（供主代理端口 18899 按路径分发调用）
// ================================================================

import type * as http from 'http';

// ================================================================
// Content filter — strip/convert unsupported types based on declared capabilities
// ================================================================
function filterUnsupportedTypes(chatReq: { messages: ChatMessage[]; [key: string]: unknown }, supportedTypes: string[]): { messages: ChatMessage[]; [key: string]: unknown } {
  const supportsImage = supportedTypes.includes('image_url');
  const supportsFile = supportedTypes.includes('file');
  const filtered: ChatMessage[] = [];

  for (const msg of chatReq.messages) {
    if (typeof msg.content === 'string') {
      filtered.push(msg);
      continue;
    }
    if (Array.isArray(msg.content)) {
      const cleaned: Array<Record<string, unknown>> = [];
      for (const part of msg.content) {
        if (part.type === 'input_image' || part.type === 'image_url') {
          if (supportsImage) {
            cleaned.push(part);
          } else {
            const mime = part.media_type || part.mime_type || 'image/png';
            cleaned.push({ type: 'text', text: `[Image received (${mime}), stripped — model does not support image input]` });
          }
        } else if (part.type === 'input_file') {
          if (supportsFile) {
            cleaned.push(part);
          } else {
            const name = part.filename || part.file_name || 'unknown file';
            cleaned.push({ type: 'text', text: `[File received: ${name}, stripped — model does not support file input]` });
          }
        } else {
          cleaned.push(part);
        }
      }
      filtered.push({ ...msg, content: cleaned });
    } else {
      filtered.push(msg);
    }
  }

  return { ...chatReq, messages: filtered };
}

export async function handleCodexRequest(
  reqBody: string,
  reqPath: string,
  reqMethod: string,
  res: http.ServerResponse
): Promise<void> {
  try {
    // GET /health
    if (reqMethod === 'GET' && reqPath === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ status: 'ok', model: REPORTED_MODEL() })); return;
    }

    // GET /v1/models
    if (reqMethod === 'GET' && reqPath.includes('/models')) {
      res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ object: 'list', data: [{ id: REPORTED_MODEL(), object: 'model', created: Date.now(), owned_by: 'openai' }] })); return;
    }

    // POST /v1/responses → Chat Completions
    if (reqMethod === 'POST' && (reqPath === '/v1/responses' || reqPath.includes('/responses'))) {
      const body = JSON.parse(reqBody);
      const chatReq = responsesToChat(body);
      fs.writeFileSync('/tmp/codex-body.json', JSON.stringify(body, null, 2));

      // 🧠 动态注入灵魂 + IM 能力到系统 Prompt
      const ctx = getCurrentBot();
      const botName = ctx?.botName || 'CodexBot';

      const rawText = body?.input?.[0]?.content?.[0]?.text;
      const systemPromptCtx = buildPromptContext({
        caps: ctx?.caps || null,
        botName,
        mcpInfo: ctx?.mcpInfo,
        skillsInfo: ctx?.skillsInfo,
        promptsInfo: ctx?.promptsInfo,
      }, {
        rawText,
      });
      const systemPrompt = buildSystemPrompt(systemPromptCtx);
      console.log(`[Codex] 📝 System prompt built (${systemPrompt.length} chars, bot=${botName}, model=${systemPromptCtx.modelInfo})`);

      let sysMsg = chatReq.messages.find((m: ChatMessage) => m.role === 'system');
      if (!sysMsg) {
        sysMsg = { role: 'system', content: '' };
        chatReq.messages.unshift(sysMsg);
      }
      if (typeof sysMsg.content !== 'string') sysMsg.content = '';
      sysMsg.content = sysMsg.content + '\n\n---\n\n' + systemPrompt;

      // P2: ContextManager — four-layer progressive compression
      const preMsgs = chatReq.messages.length;
      const preEst = chatReq.messages.reduce((s, m) => s + (typeof m.content === 'string' ? m.content.length : 0), 0);
      const processed = await getCodexContextManager().processAsync(chatReq) as typeof chatReq;
      const postMsgs = processed.messages.length;
      const postEst = processed.messages.reduce((s, m) => s + (typeof m.content === 'string' ? m.content.length : 0), 0);
      const savings = preEst - postEst;
      // Always log and always apply — processAsync may restructure messages (normalizeToolOutputs,
      // enforceMessageCap) even when char savings are zero.
      console.log(`[Codex] 🔧 ContextManager: ${preMsgs}→${postMsgs} msgs, ~${preEst.toLocaleString()}→~${postEst.toLocaleString()} chars (saved ${savings.toLocaleString()})`);
      Object.assign(chatReq, processed);

      // 🔧 Inject IMtoAgent local tools into the request
      const toolRegistry = getCurrentBot()?.toolRegistry;
      if (toolRegistry) {
        const localTools = toolRegistry.getOpenAIFormat();
        if (localTools.length > 0) {
          const existingNames = new Set((chatReq.tools || []).map((t: any) => t.function?.name));
          let added = 0;
          for (const lt of localTools) {
            const name = (lt as any).function?.name;
            if (name && !existingNames.has(name)) {
              chatReq.tools = chatReq.tools || [];
              chatReq.tools.push(lt as any);
              added++;
            }
          }
          if (added > 0) {
            console.log(`[Codex] 🔧 Injected ${added} IMtoAgent local tools: ${localTools.map((t: any) => t.function?.name).join(', ')}`);
          }
        }
      }

      const roles = chatReq.messages?.map((m: ChatMessage) => m.role).join(',');
      console.log(`[Codex] → ${chatReq.model} [${roles}] tools:${chatReq.tools?.length || 0}`);

      // ---- Phase 3 V2: Cache-First Tool Intercept ----
      // 核心思路：第一轮完全缓存 SSE，不转发给客户端
      // 解析出 tool_calls 后分类本地/远端，按类型分支处理
      const hasAnyTools = !!(chatReq.tools && chatReq.tools.length > 0);
      const hasLocal = hasLocalTool(chatReq.tools);
      const interceptRegistry = hasLocal ? getCurrentBot()?.toolRegistry : undefined;

      const ac = new AbortController();
      const timeout = setTimeout(() => ac.abort(), 180_000);

      try {
        if (hasAnyTools) {
          // 有工具定义 → 完全缓存第一轮 SSE，分析 tool_calls 后再决定输出
          console.log(`[Codex] 🔧 Phase 3 V2: tools detected (${chatReq.tools!.length} defined, ${hasLocal ? 'has local' : 'remote only'}), cache-first mode`);

          // Step 1: 发请求给 LLM，完全缓存 SSE 流
          const upstreamRes = await fetch(UPSTREAM(), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${API_KEY()}` },
            body: JSON.stringify({ ...chatReq, stream: true }),
            signal: ac.signal,
          });

          if (!upstreamRes.ok) {
            const errText = await upstreamRes.text();
            console.error(`[Codex] ❌ ${upstreamRes.status}: ${errText.slice(0, 200)}`);
            // 400 with unknown variant — retry with filtered content
            if (upstreamRes.status === 400 && errText.includes('unknown variant')) {
              console.log('[Codex] ⚠️ Upstream rejected unknown variant, retrying with filtered content...');
              const filteredChat = filterUnsupportedTypes(chatReq, SUPPORTED_INPUT_TYPES());
              const retryRes = await fetch(UPSTREAM(), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${API_KEY()}` },
                body: JSON.stringify(filteredChat),
                signal: ac.signal,
              });
              if (!retryRes.ok) {
                const retryErrText = await retryRes.text();
                console.error(`[Codex] ❌ Retry also failed ${retryRes.status}: ${retryErrText.slice(0, 200)}`);
                notifyUserError(retryRes.status);
                res.writeHead(retryRes.status, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: `Upstream rejected request twice: ${retryErrText.slice(0, 500)}` }));
                return;
              }
              // Retry succeeded — parse the retry response
              const retryParsed = await parseStreamToolCalls(retryRes);
              return handleParsedResponse(retryParsed, chatReq, body, interceptRegistry, res);
            }
            notifyUserError(upstreamRes.status);
            res.writeHead(upstreamRes.status, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: errText.slice(0, 500) }));
            return;
          }

          // Step 2: 解析缓存的 SSE 流
          const parsed = await parseStreamToolCalls(upstreamRes);
          console.log(`[Codex] 📦 Phase 3 V2: cached ${parsed.toolCalls.length} tool_calls, ${parsed.assistantText.length} chars text, ${parsed.reasoningContent.length} chars reasoning`);

          // Step 3: 根据 tool_calls 类型分支处理
          return handleParsedResponse(parsed, chatReq, body, interceptRegistry, res);

        } else {
          // 无工具定义 → 简单转发
          const upstreamRes = await fetch(UPSTREAM(), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${API_KEY()}` },
            body: JSON.stringify({ ...chatReq, stream: true }),
            signal: ac.signal,
          });

          if (!upstreamRes.ok) {
            const errText = await upstreamRes.text();
            console.error(`[Codex] ❌ ${upstreamRes.status}: ${errText.slice(0, 200)}`);
            notifyUserError(upstreamRes.status);
            res.writeHead(upstreamRes.status, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: errText.slice(0, 500) }));
            return;
          }

          // 直接流式转发
          res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
          const writable = new WritableStream({
            write(chunk: Uint8Array) { res.write(Buffer.from(chunk)); },
            close() { res.end(); },
            abort(_err: unknown) { res.end(); },
          });
          const writer = writable.getWriter();
          await streamResponse(upstreamRes, writer, body).catch((e: unknown) => {
            console.error(`[Codex] streamResponse error: ${e?.message || e}`);
          }).finally(() => { try { writer.close(); } catch {} });
          return;
        }
      } catch (e: unknown) {
        console.error(`[Codex] ❌ fetch failed: ${(e as Error).message}`);
        notifyUserError(502);
        res.writeHead(502, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'upstream unavailable' })); return;
      } finally {
        clearTimeout(timeout);
      }
    }

    res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'not found' })); return;
  } catch (e: unknown) {
    console.error(`[Codex] 💥 unhandled: ${e.message}`);
    res.writeHead(500, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'internal error' })); return;
  }
}

// ================================================================
// Phase 3 V2: handleParsedResponse — 根据解析结果分支处理
// ================================================================
async function handleParsedResponse(
  parsed: StreamToolCallInfo,
  chatReq: { model: string; messages: ChatMessage[]; stream: boolean; max_tokens?: number; tools?: OpenAITool[] },
  originalBody: OpenAIRequestBody,
  interceptRegistry: ToolRegistry | undefined,
  res: http.ServerResponse,
): Promise<void> {
  const { toolCalls, assistantText, reasoningContent } = parsed;
  const model = REPORTED_MODEL();

  // 无 tool_calls → 直接返回缓存的 text
  if (toolCalls.length === 0) {
    console.log(`[Codex] ✅ Phase 3 V2: no tool_calls, returning synthetic stream (${assistantText.length} chars)`);
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.end(buildSyntheticStream(assistantText, reasoningContent, model));
    return;
  }

  // 分类 tool_calls
  const allParsed = parseToolCalls(toolCalls);
  const localCalls = allParsed.filter(tc => isLocalTool(tc.name));
  const remoteCalls = allParsed.filter(tc => !isLocalTool(tc.name));

  console.log(`[Codex] 🔧 Phase 3 V2: ${localCalls.length} local, ${remoteCalls.length} remote tool_calls`);

  // 纯本地工具 → 代理层自闭环执行
  if (localCalls.length > 0 && remoteCalls.length === 0) {
    console.log(`[Codex] 🔄 Phase 3 V2: pure local tools, executing and re-fetching`);

    if (!interceptRegistry) {
      console.error(`[Codex] ❌ Phase 3 V2: no toolRegistry for local tools`);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'no tool registry available' }));
      return;
    }

    // 执行本地工具
    const localResults = await executeLocalTools(localCalls, interceptRegistry);
    console.log(`[Codex] ✅ Phase 3 V2: executed ${localResults.length} local tool(s)`);

    // 构造第二轮 messages
    const round2Messages = [...chatReq.messages];
    // 添加 assistant 消息（包含 tool_calls）
    const assistantMsg: ChatMessage = {
      role: 'assistant',
      content: assistantText || null,
      tool_calls: toolCalls.map(tc => ({
        id: tc.id,
        type: 'function' as const,
        function: { name: tc.function.name, arguments: tc.function.arguments },
      })),
    };
    if (reasoningContent) assistantMsg.reasoning_content = reasoningContent;
    round2Messages.push(assistantMsg);
    // 添加工具结果消息
    for (const result of localResults) {
      round2Messages.push({
        role: 'tool',
        tool_call_id: result.toolCallId,
        content: result.content,
      });
    }

    // 发第二轮请求（不再包含工具定义，避免模型再次调用本地工具）
    const ac2 = new AbortController();
    const timeout2 = setTimeout(() => ac2.abort(), 180_000);

    try {
      const round2Res = await fetch(UPSTREAM(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${API_KEY()}` },
        body: JSON.stringify({
          ...chatReq,
          messages: round2Messages,
          tools: undefined,  // 移除工具定义，防止循环
          stream: true,
        }),
        signal: ac2.signal,
      });

      if (!round2Res.ok) {
        const errText = await round2Res.text();
        console.error(`[Codex] ❌ Round 2 failed ${round2Res.status}: ${errText.slice(0, 200)}`);
        notifyUserError(round2Res.status);
        res.writeHead(round2Res.status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: errText.slice(0, 500) }));
        return;
      }

      // 第二轮响应：完全缓存，解析后再判断
      const round2Parsed = await parseStreamToolCalls(round2Res);
      console.log(`[Codex] 📦 Phase 3 V2: round 2 cached ${round2Parsed.toolCalls.length} tool_calls, ${round2Parsed.assistantText.length} chars text`);

      // 递归处理（可能还有更多工具调用）
      // 但为了防止无限循环，最多递归 3 次
      return handleParsedResponseRecursive(round2Parsed, chatReq, originalBody, interceptRegistry, res, 1);
    } catch (e: unknown) {
      console.error(`[Codex] ❌ Round 2 fetch failed: ${(e as Error).message}`);
      notifyUserError(502);
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'upstream unavailable' }));
      return;
    } finally {
      clearTimeout(timeout2);
    }
  }

  // 有远端工具（可能混合本地工具）→ 返回远端 tool_calls 给客户端
  // TODO: 混合场景下，本地工具也执行并缓存，等客户端返回远端工具结果时再合并
  if (remoteCalls.length > 0) {
    console.log(`[Codex] 📤 Phase 3 V2: returning ${remoteCalls.length} remote tool_calls to client`);
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.end(buildToolCallsResponseStream(
      remoteCalls.map(tc => ({ id: tc.id, type: 'function', function: { name: tc.name, arguments: tc.rawArgs } })),
      assistantText,
      reasoningContent,
      model,
    ));
    return;
  }

  // 兜底：不应该到这里
  console.error(`[Codex] ❌ Phase 3 V2: unexpected state, falling back to synthetic stream`);
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  res.end(buildSyntheticStream(assistantText, reasoningContent, model));
}

/**
 * 递归处理多轮工具调用（最多 MAX_ROUNDS 次）
 */
async function handleParsedResponseRecursive(
  parsed: StreamToolCallInfo,
  chatReq: { model: string; messages: ChatMessage[]; stream: boolean; max_tokens?: number; tools?: OpenAITool[] },
  originalBody: OpenAIRequestBody,
  interceptRegistry: ToolRegistry | undefined,
  res: http.ServerResponse,
  round: number,
): Promise<void> {
  const MAX_ROUNDS = 3;
  const { toolCalls, assistantText, reasoningContent } = parsed;
  const model = REPORTED_MODEL();

  // 无 tool_calls → 返回最终文本
  if (toolCalls.length === 0) {
    console.log(`[Codex] ✅ Phase 3 V2: round ${round} no tool_calls, returning final stream`);
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.end(buildSyntheticStream(assistantText, reasoningContent, model));
    return;
  }

  // 超过最大轮次 → 强制返回当前文本
  if (round >= MAX_ROUNDS) {
    console.warn(`[Codex] ⚠️ Phase 3 V2: exceeded max rounds (${MAX_ROUNDS}), forcing return`);
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.end(buildSyntheticStream(assistantText, reasoningContent, model));
    return;
  }

  // 分类并处理
  const allParsed = parseToolCalls(toolCalls);
  const localCalls = allParsed.filter(tc => isLocalTool(tc.name));
  const remoteCalls = allParsed.filter(tc => !isLocalTool(tc.name));

  // 纯本地工具 → 继续执行
  if (localCalls.length > 0 && remoteCalls.length === 0) {
    if (!interceptRegistry) {
      console.error(`[Codex] ❌ Phase 3 V2: no toolRegistry for local tools`);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'no tool registry available' }));
      return;
    }

    const localResults = await executeLocalTools(localCalls, interceptRegistry);
    console.log(`[Codex] ✅ Phase 3 V2: round ${round} executed ${localResults.length} local tool(s)`);

    // 构造下一轮 messages
    const nextMessages = [...chatReq.messages];
    const assistantMsg: ChatMessage = {
      role: 'assistant',
      content: assistantText || null,
      tool_calls: toolCalls.map(tc => ({
        id: tc.id,
        type: 'function' as const,
        function: { name: tc.function.name, arguments: tc.function.arguments },
      })),
    };
    if (reasoningContent) assistantMsg.reasoning_content = reasoningContent;
    nextMessages.push(assistantMsg);
    for (const result of localResults) {
      nextMessages.push({
        role: 'tool',
        tool_call_id: result.toolCallId,
        content: result.content,
      });
    }

    // 发下一轮请求
    const ac = new AbortController();
    const timeout = setTimeout(() => ac.abort(), 180_000);

    try {
      const nextRes = await fetch(UPSTREAM(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${API_KEY()}` },
        body: JSON.stringify({
          ...chatReq,
          messages: nextMessages,
          tools: undefined,
          stream: true,
        }),
        signal: ac.signal,
      });

      if (!nextRes.ok) {
        const errText = await nextRes.text();
        console.error(`[Codex] ❌ Round ${round + 1} failed ${nextRes.status}: ${errText.slice(0, 200)}`);
        notifyUserError(nextRes.status);
        res.writeHead(nextRes.status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: errText.slice(0, 500) }));
        return;
      }

      const nextParsed = await parseStreamToolCalls(nextRes);
      console.log(`[Codex] 📦 Phase 3 V2: round ${round + 1} cached ${nextParsed.toolCalls.length} tool_calls`);

      return handleParsedResponseRecursive(nextParsed, chatReq, originalBody, interceptRegistry, res, round + 1);
    } catch (e: unknown) {
      console.error(`[Codex] ❌ Round ${round + 1} fetch failed: ${(e as Error).message}`);
      notifyUserError(502);
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'upstream unavailable' }));
      return;
    } finally {
      clearTimeout(timeout);
    }
  }

  // 有远端工具 → 返回远端 tool_calls
  if (remoteCalls.length > 0) {
    console.log(`[Codex] 📤 Phase 3 V2: round ${round} returning ${remoteCalls.length} remote tool_calls to client`);
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.end(buildToolCallsResponseStream(
      remoteCalls.map(tc => ({ id: tc.id, type: 'function', function: { name: tc.name, arguments: tc.rawArgs } })),
      assistantText,
      reasoningContent,
      model,
    ));
    return;
  }

  // 兜底
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  res.end(buildSyntheticStream(assistantText, reasoningContent, model));
}
