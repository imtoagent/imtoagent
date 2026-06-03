// CC 代理本地 HTTP 代理 — 实现 Claude Code 运行时模型热切换
//
// 架构：
//   Claude Code subprocess → http://localhost:18899/v1/messages (Anthropic 格式)
//                            → 读 sharedState.activeConfig
//                            → 格式转换（Anthropic ↔ OpenAI）
//                            → 转发到真实供应商 API
//                            → 返回 Anthropic 兼容响应
//
// 支持：
//   - Anthropic 格式供应商（小米、DeepSeek）：直接透传
//   - OpenAI 格式供应商（百炼、极速）：自动双向转换

import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import { getCurrentBot } from '../bot-context';
import { buildSystemPrompt } from '../prompt-builder';
import { handleCodexRequest } from './codex-proxy';
import { getDataDir, getSessionsDir } from '../utils/paths';
import { CircuitBreaker, CircuitBreakerManager } from './circuit-breaker';
import { logEvent } from '../utils/logger';
import type {
  AnthropicRequestBody,
  OpenAIRequestBody,
  AnthropicMessage,
  AnthropicContentBlock,
  AnthropicTextBlock,
  AnthropicImageBlock,
  AnthropicToolUseBlock,
  AnthropicToolResultBlock,
  AnthropicTool,
  OpenAIMessage,
  OpenAIContentBlock,
  OpenAIToolCall,
  OpenAITool,
  AnthropicStreamEvent,
  AnthropicResponseUsage,
  AnthropicToolChoice,
} from './proxy-types';

// ===== 共享状态 =====
export interface ModelAliases {
  default: string;
  sonnet: string;
  opus: string;
  haiku: string;
  best: string;
  opencode?: string;
}

export interface ProxyConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  providerName: string;
  format: 'anthropic' | 'openai';
}

export const sharedState = {
  activeConfig: null as ProxyConfig | null,
  modelAliases: null as ModelAliases | null,
};

// ===== 供应商配置 =====
interface ProviderConfig {
  baseUrl: string;
  apiKey: string;
  models: string[];
  format?: 'anthropic' | 'openai';
}

let providers = new Map<string, ProviderConfig>();

const CONFIG_PATH = path.join(getDataDir(), 'providers.json');

// ===== Circuit Breaker Manager =====
let circuitManager: CircuitBreakerManager | null = null;

function getCircuitManager(): CircuitBreakerManager {
  if (!circuitManager) {
    circuitManager = new CircuitBreakerManager();
    // Create breakers for all loaded providers
    for (const [name] of providers) {
      circuitManager.create(name, {
        failureThreshold: 3,
        recoveryTimeout: 60_000,
        halfOpenMaxRequests: 1,
      });
    }
  }
  return circuitManager;
}

export function loadProviders(): { providers: Map<string, ProviderConfig>; defaultModel: string } {
  providers = new Map<string, ProviderConfig>();
  let defaultModel = 'xiaomi/mimo-v2.5-pro';
  try {
    const raw = fs.readFileSync(CONFIG_PATH, 'utf-8');
    const cfg = JSON.parse(raw);
    // activeModel 优先于 defaultModel（持久化的用户选择）
    if (cfg.activeModel) defaultModel = cfg.activeModel;
    else if (cfg.defaultModel) defaultModel = cfg.defaultModel;
    const provs = cfg.providers || {};
    for (const [name, p] of Object.entries(provs) as [string, Record<string, unknown>][]) {
      providers.set(name, {
        baseUrl: (p.baseUrl as string) || '',
        apiKey: (p.apiKey as string) || '',
        models: (p.models as string[]) || [],
        format: (p.format as string) || 'anthropic',
      });
    }
    console.log(`[Proxy] Loaded ${providers.size} provider(s): ${[...providers.keys()].join(', ')}`);
  } catch (e: unknown) {
    console.error(`[Proxy] Failed to read providers.json: ${e.message}`);
  }
  return { providers, defaultModel };
}

/** 持久化当前模型选择到 providers.json */
export function saveActiveModel(modelSpec: string): void {
  try {
    const raw = fs.readFileSync(CONFIG_PATH, 'utf-8');
    const cfg = JSON.parse(raw);
    cfg.activeModel = modelSpec;
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2) + '\n');
    console.log(`[Proxy] activeModel persisted: ${modelSpec}`);
  } catch (e: unknown) {
    console.error(`[Proxy] Failed to save activeModel: ${e.message}`);
  }
}

// ===== 会话级模型映射 =====
const SESSIONS_DIR = () => getSessionsDir();

// ===== reasoning_content 缓存（跨请求持久化，用于下游 client 丢失 thinking 块时注入） =====
const reasoningCache = new Map<string, string>();

/** 根据消息历史生成简单会话指纹（用第一条 user 消息，避免 tool_result 污染） */
function conversationFingerprint(messages: (AnthropicMessage | OpenAIMessage)[]): string {
  // OpenCode 在工具执行后，消息列表中最后一条 "user" 是 tool_result，
  // 会导致指纹变化、reasoning cache miss。改为用第一条 user 消息。
  for (let i = 0; i < messages.length; i++) {
    if (messages[i].role === 'user') {
      const content = typeof messages[i].content === 'string'
        ? messages[i].content
        : JSON.stringify(messages[i].content);
      return content.slice(0, 200);
    }
  }
  return '';
}

/** 加载用户会话配置 */
export function loadSessionConfig(customPath?: string): { activeModel: string; modelAliases: ModelAliases } {
  const sessionPath = customPath || `${SESSIONS_DIR()}/_default.json`;
  const defaultAliases: ModelAliases = {
    default: 'deepseek/deepseek-v4-pro[1m]',
    sonnet: 'deepseek/deepseek-v4-flash[1m]',
    opus: 'deepseek/deepseek-v4-pro[1m]',
    haiku: 'deepseek/deepseek-v4-flash[1m]',
    best: 'deepseek/deepseek-v4-pro[1m]',
  };

  try {
    if (!fs.existsSync(sessionPath)) {
      return { activeModel: defaultAliases.default, modelAliases: defaultAliases };
    }
    const raw = fs.readFileSync(sessionPath, 'utf-8');
    const cfg = JSON.parse(raw);
    return {
      activeModel: cfg.activeModel || defaultAliases.default,
      modelAliases: cfg.modelAliases || defaultAliases,
    };
  } catch (e: unknown) {
    console.error(`[Proxy] Failed to load session config (${customPath || '_default.json'}): ${e.message}`);
    return { activeModel: defaultAliases.default, modelAliases: defaultAliases };
  }
}

/** 保存用户会话配置 */
export function saveSessionConfig(userId: string, activeModel: string, modelAliases: ModelAliases): void {
  const sessionsBase = SESSIONS_DIR();
  try {
    if (!fs.existsSync(sessionsBase)) {
      fs.mkdirSync(sessionsBase, { recursive: true });
    }
    const sessionPath = `${sessionsBase}/${userId}.json`;
    const cfg = {
      userId,
      activeModel,
      modelAliases,
      lastActive: new Date().toISOString(),
    };
    fs.writeFileSync(sessionPath, JSON.stringify(cfg, null, 2) + '\n');
  } catch (e: unknown) {
    console.error(`[Proxy] Failed to save session config (${userId}): ${e.message}`);
  }
}

/** 解析模型名：如果是角色别名，替换为实际模型 */
export function resolveModel(requestedModel: string, modelAliases: ModelAliases): string {
  const aliasMap: Record<string, keyof ModelAliases> = {
    'default': 'default',
    'sonnet': 'sonnet',
    'opus': 'opus',
    'haiku': 'haiku',
    'best': 'best',
  };

  const normalized = requestedModel.toLowerCase();
  if (normalized in aliasMap) {
    return modelAliases[aliasMap[normalized]];
  }
  return requestedModel;
}

/** 根据 Claude Code 传的模型名前缀，自动识别角色并替换，返回完整规格 */
export function resolveModelByPrefix(modelName: string): string {
  // 优先使用当前 bot 级别的别名（支持 /model 热切换），回退到全局配置
  const botCtx = getCurrentBot();
  const aliases = botCtx?.modelAliases || sharedState.modelAliases;
  if (!aliases) return modelName;

  const lower = modelName.toLowerCase();

  // Claude Code 模型名模式识别
  if (lower.startsWith('claude-haiku')) {
    return aliases.haiku;
  }
  if (lower.startsWith('claude-sonnet')) {
    return aliases.sonnet;
  }
  if (lower.startsWith('claude-opus')) {
    return aliases.opus;
  }

  // OpenCode 独立模型标识（通过 opencode.json 的 models.id 覆盖注入）
  if (lower.startsWith('opencode-')) {
    return (aliases as Record<string, string>).opencode || aliases.sonnet;
  }

  // 其他情况：返回当前 activeConfig 的完整规格
  if (sharedState.activeConfig) {
    return `${sharedState.activeConfig.providerName}/${sharedState.activeConfig.model}`;
  }

  return modelName;
}

export function getProviderConfig(modelSpec: string): ProxyConfig | null {
  const slashIdx = modelSpec.indexOf('/');
  if (slashIdx < 0) return null;
  const provName = modelSpec.slice(0, slashIdx);
  const modelName = modelSpec.slice(slashIdx + 1);
  const p = providers.get(provName);
  if (!p) return null;
  // 校验模型名是否在供应商的模型列表中
  if (!p.models.includes(modelName)) return null;
  return {
    baseUrl: p.baseUrl,
    apiKey: p.apiKey,
    model: modelName,
    providerName: provName,
    format: (p.format as string) || 'anthropic',
  };
}

// ===== 格式转换工具 =====

/** 清理 CC system_reminder，提取用户实际查询 */
function cleanCCUserContent(text: string): string {
  // 去掉 system-reminder 标签
  let cleaned = text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '');
  // 去掉技能列表等 CC 元信息
  cleaned = cleaned.replace(/The following skills are available[\s\S]*?(?=\n#{1,3} |\nIMPORTANT|\n作为一名|\nYou are|$)/g, '');
  // 提取 IMPORTANT 之后到 "currentDa" / "currentDate" 之前的实际任务
  const importantMatch = cleaned.match(/IMPORTANT:[\s\S]*?should not respond to this context unless it is highly relevant to your task\.\s*\n\s*([^#]*?)(?:\s*# currentDate|\s*#{1,3} |$)/);
  if (importantMatch) {
    cleaned = importantMatch[1].trim();
  }
  // 去掉 CC billing header 等
  cleaned = cleaned.replace(/x-anthropic-billing-header[^\n]*\n?/g, '');
  cleaned = cleaned.trim();
  return cleaned || text;
}

/** Anthropic content → OpenAI 字符串 */
function normalizeAnthropicContent(content: string | AnthropicContentBlock[]): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((block) => {
        if (block.type === 'text') return (block as AnthropicTextBlock).text;
        if (block.type === 'tool_use') return `[tool:${(block as AnthropicToolUseBlock).name}]`;
        if (block.type === 'tool_result') {
          const c = (block as AnthropicToolResultBlock).content;
          if (typeof c === 'string') return c;
          if (Array.isArray(c)) return c.map((b) => (b as AnthropicTextBlock).text || '').join('');
          return '';
        }
        return (block as AnthropicTextBlock).text || '';
      })
      .join('\n');
  }
  return String(content || '');
}

/** Anthropic 请求体 → OpenAI 请求体 */
function anthropicToOpenAI(anthropicBody: AnthropicRequestBody, modelName: string, originalModelName?: string): OpenAIRequestBody {
  const messages: OpenAIMessage[] = [];

  // system 是 Anthropic 顶层字段，转为 OpenAI messages 第一条
  // 必须 normalize，否则 cache_control、billing header 等 Anthropic 特有字段会泄漏
  if (anthropicBody.system) {
    const sysContent = normalizeAnthropicContent(anthropicBody.system);
    if (sysContent) {
      messages.push({ role: 'system', content: sysContent });
    }
  }

  for (const msg of anthropicBody.messages || []) {
    if (msg.role === 'user') {
      // 如果是数组 content，拆分为 text / tool_result / image
      if (Array.isArray(msg.content)) {
        const textParts: string[] = [];
        const imageBlocks: OpenAIImageBlock[] = [];  // OpenAI vision 格式的图片块
        for (const block of msg.content) {
          if (block.type === 'tool_result') {
            const tc = (block as AnthropicToolResultBlock).content;
            const resultText = typeof tc === 'string' ? tc
              : Array.isArray(tc) ? tc.map((b) => (b as AnthropicTextBlock).text || '').join('') : String(tc || '');
            messages.push({
              role: 'tool',
              content: resultText,
              tool_call_id: block.tool_use_id || '',
            });
          } else if (block.type === 'text') {
            textParts.push(block.text);
          } else if (block.type === 'image') {
            // 转换 Anthropic 图片块 → OpenAI vision 格式
            if (block.source?.type === 'base64') {
              const mediaType = block.source.media_type || 'image/png';
              imageBlocks.push({
                type: 'image_url',
                image_url: { url: `data:${mediaType};base64,${block.source.data}` },
              });
            }
          }
        }
        // 构建 user 消息（文本 + 可能有的图片）
        if (textParts.length > 0 || imageBlocks.length > 0) {
          let content: string | OpenAIContentBlock[];
          if (imageBlocks.length > 0) {
            // 有图片 → 用数组格式
            content = [];
            if (textParts.length > 0) {
              let textContent = textParts.join('\n');
              if (textContent.includes('<system-reminder>') || textContent.includes('x-anthropic-billing-header')) {
                textContent = cleanCCUserContent(textContent);
              }
              content.push({ type: 'text', text: textContent });
            }
            content.push(...imageBlocks);
          } else {
            // 无图片 → 纯字符串
            content = textParts.join('\n');
            if (content.includes('<system-reminder>') || content.includes('x-anthropic-billing-header')) {
              content = cleanCCUserContent(content);
            }
          }
          messages.push({ role: 'user', content });
        }
      } else {
        let content = normalizeAnthropicContent(msg.content);
        if (content.includes('<system-reminder>') || content.includes('x-anthropic-billing-header')) {
          content = cleanCCUserContent(content);
        }
        messages.push({ role: 'user', content });
      }
    } else if (msg.role === 'assistant') {
      if (Array.isArray(msg.content)) {
        // 混合内容：文本 + 工具调用 + 思考
        const textParts: string[] = [];
        const toolCalls: OpenAIToolCall[] = [];
        const reasoningParts: string[] = [];
        for (const block of msg.content) {
          if (block.type === 'text') {
            textParts.push(block.text);
          } else if (block.type === 'tool_use') {
            toolCalls.push({
              id: block.id,
              type: 'function',
              function: {
                name: block.name,
                arguments: typeof block.input === 'string' ? block.input : JSON.stringify(block.input),
              },
            });
          }
          // thinking 块 → reasoning_content（DeepSeek 要求传回）
          else if (block.type === 'thinking') {
            reasoningParts.push(block.thinking || '');
          }
          // redacted_thinking 块：忽略
        }
        const msgObj: OpenAIMessage & { reasoning_content?: string } = { role: 'assistant' };
        // 只有文本时用文本，只有工具调用时 content 为 null（部分 API 要求显式 null）
        if (textParts.length > 0) {
          msgObj.content = textParts.join('\n');
        } else if (toolCalls.length > 0) {
          msgObj.content = null;
        } else {
          msgObj.content = '';
        }
        if (toolCalls.length > 0) msgObj.tool_calls = toolCalls;
        // DeepSeek thinking 模式要求传回 reasoning_content
        if (reasoningParts.length > 0) {
          msgObj.reasoning_content = reasoningParts.join('');
        }
        messages.push(msgObj);
      } else {
        messages.push({ role: 'assistant', content: msg.content || '' });
      }
    } else if (msg.role === 'tool') {
      const toolContent = (() => {
        if (typeof msg.content === 'string') return msg.content;
        if (Array.isArray(msg.content)) return msg.content.map((b) => (b as AnthropicTextBlock).text || '').join('');
        return String(msg.content || '');
      })();
      messages.push({
        role: 'tool',
        content: toolContent,
        tool_call_id: msg.tool_use_id || '',
      });
    }
  }

  // tool_choice 转换
  let toolChoice: OpenAIRequestBody['tool_choice'] = undefined;
  if (anthropicBody.tool_choice) {
    const tc = anthropicBody.tool_choice;
    if (tc.type === 'any') toolChoice = 'required';
    else if (tc.type === 'auto') toolChoice = 'auto';
    else if (tc.type === 'tool' && tc.name) toolChoice = { type: 'function', function: { name: tc.name } };
  }

  // 根据 Claude Code 传的模型名前缀，自动识别角色并替换
  // 注意：modelName 参数在此上下文中是已解析的纯模型名（如 mimo-v2.5-pro）
  // resolveModelByPrefix 仅用于首次路由，此处不二次调用
  const resolvedModel = modelName;

  // OpenCode 不保留 thinking 块，第二轮请求会因 reasoning_content 缺失被 DeepSeek 拒绝。
  // 仅对 opencode-default 模型禁用 thinking。Claude Code 正常保留 thinking 不受影响。
  const isOpenCodeModel = originalModelName === 'opencode-default';
  const extraParams: Record<string, unknown> = {};
  if (isOpenCodeModel) extraParams.thinking = { type: 'disabled' };

  return {
    model: resolvedModel,
    messages,
    max_tokens: anthropicBody.max_tokens || 4096,
    temperature: anthropicBody.temperature,
    stream: anthropicBody.stream !== false,
    ...extraParams,
    tools: anthropicBody.tools?.map((t: AnthropicTool) => {
      // 修复 null/undefined input_schema，DeepSeek 等供应商不接受 type:null
      let params: Record<string, unknown> = {};
      if (t.input_schema && typeof t.input_schema === 'object') {
        params = JSON.parse(JSON.stringify(t.input_schema, (k, v) => v === null ? undefined : v));
      }
      if (!params.type) params.type = 'object';
      // web_search → web_search_20250305 (DeepSeek 版本化工具名)
      const toolName = t.name === 'web_search' ? 'web_search_20250305' : t.name;
      return {
        type: 'function',
        function: {
          name: toolName,
          description: t.description || '',
          parameters: params,
        },
      };
    }),
    ...(toolChoice !== undefined ? { tool_choice: toolChoice } : {}),
  };
}

/** OpenAI 非流式响应 → Anthropic 格式 */
function openAIToAnthropic(openAIBody: OpenAIRequestBody, modelName: string): AnthropicRequestBody {
  const choice = openAIBody.choices?.[0];
  if (!choice) return { id: 'msg_err', type: 'message', role: 'assistant', content: [], model: modelName };

  const content: AnthropicContentBlock[] = [];
  // DeepSeek reasoning_content → Anthropic thinking 块
  if (choice.message?.reasoning_content) {
    content.push({
      type: 'thinking',
      thinking: choice.message.reasoning_content,
      signature: Buffer.from('cc-gw').toString('base64'),
    });
  }
  if (choice.message?.content) {
    content.push({ type: 'text', text: choice.message.content });
  }
  if (choice.message?.tool_calls?.length > 0) {
    for (const tc of choice.message.tool_calls) {
      let input: Record<string, unknown> = {};
      try { input = JSON.parse(tc.function?.arguments || '{}'); } catch { input = {}; }
      content.push({
        type: 'tool_use',
        id: tc.id || `tool_${Date.now()}`,
        name: tc.function?.name || '',
        // 反向重命名 web_search_20250305 → WebSearch
        ...(tc.function?.name === 'web_search_20250305' ? { name: 'WebSearch' } : {}),
        input,
      });
    }
  }

  const stopReason = choice.finish_reason === 'stop' ? 'end_turn'
    : choice.finish_reason === 'tool_calls' ? 'tool_use'
    : choice.finish_reason || 'end_turn';

  return {
    id: `msg_${Date.now().toString(36)}`,
    type: 'message',
    role: 'assistant',
    content,
    model: modelName,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: openAIBody.usage || { input_tokens: 0, output_tokens: 0 },
  };
}

/** OpenAI SSE 流 → Anthropic SSE 流 */
function openAIStreamToAnthropic(openAIStream: NodeJS.ReadableStream, res: http.ServerResponse, modelName: string, _reqBody?: OpenAIRequestBody, providerName?: string): void {
  let buffer = '';
  const messageId = `msg_${Date.now().toString(36)}`;
  let sentMessageStart = false;
  let currentBlockIndex = -1;
  let currentBlockType: 'text' | 'tool_use' | null = null;
  let toolUseId = '';
  let toolUseName = '';
  let textStarted = false;
  let toolUseStarted = false;
  let lastFinishReason = 'end_turn';
  let cachedReasoningContent = '';

  function sendEvent(eventType: string, data: AnthropicStreamEvent) {
    res.write(`event: ${eventType}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  }

  function sendMessageStart() {
    if (sentMessageStart) return;
    sentMessageStart = true;
    sendEvent('message_start', {
      type: 'message_start',
      message: {
        id: messageId, type: 'message', role: 'assistant',
        content: [], model: modelName, stop_reason: null,
        stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 },
      },
    });
  }

  function startTextBlock() {
    if (textStarted) return;
    // 如果之前在 tool_use，先结束它
    if (toolUseStarted) {
      sendEvent('content_block_stop', { type: 'content_block_stop', index: currentBlockIndex });
      toolUseStarted = false;
    }
    sendMessageStart();
    currentBlockIndex++;
    currentBlockType = 'text';
    textStarted = true;
    sendEvent('content_block_start', {
      type: 'content_block_start',
      index: currentBlockIndex,
      content_block: { type: 'text', text: '' },
    });
  }

  function startToolUseBlock(id: string, name: string) {
    if (toolUseStarted && toolUseId === id) return;
    if (textStarted) {
      sendEvent('content_block_stop', { type: 'content_block_stop', index: currentBlockIndex });
      textStarted = false;
    }
    if (toolUseStarted) {
      sendEvent('content_block_stop', { type: 'content_block_stop', index: currentBlockIndex });
    }
    sendMessageStart();
    currentBlockIndex++;
    currentBlockType = 'tool_use';
    toolUseStarted = true;
    toolUseId = id;
    toolUseName = name;
    sendEvent('content_block_start', {
      type: 'content_block_start',
      index: currentBlockIndex,
      content_block: { type: 'tool_use', id, name },
    });
  }

  function finishStream() {
    if (textStarted || toolUseStarted) {
      sendEvent('content_block_stop', { type: 'content_block_stop', index: currentBlockIndex });
    }
    // 缓存 reasoning_content 到全局（供下游第二轮请求使用）
    if (cachedReasoningContent && _reqBody?.messages) {
      const fp = conversationFingerprint(_reqBody.messages);
      if (fp) {
        reasoningCache.set(fp, cachedReasoningContent);
        console.log(`[Proxy] 🧠 reasoning_content cached (fingerprint: ${fp.slice(0, 50)}...)`);
      }
    }
    sendEvent('message_delta', {
      type: 'message_delta',
      delta: { stop_reason: lastFinishReason, stop_sequence: null },
      usage: { output_tokens: 0 },
    });
    sendEvent('message_stop', { type: 'message_stop' });
    if (providerName) logEvent({ event: 'proxy_sse_end', provider: providerName });
    res.end();
  }

  openAIStream.on('data', (chunk: Buffer) => {
    buffer += chunk.toString();
    while (buffer.includes('\n')) {
      const lineEnd = buffer.indexOf('\n');
      const line = buffer.slice(0, lineEnd).trim();
      buffer = buffer.slice(lineEnd + 1);

      if (!line.startsWith('data:')) continue;
      const dataStr = line.slice(5).trim();
      if (dataStr === '[DONE]') {
        finishStream();
        return;
      }

      let json: OpenAIStreamChunk;
      try { json = JSON.parse(dataStr); } catch { continue; }

      const delta = json.choices?.[0]?.delta;
      // 跟踪 finish_reason — 移到 delta 判断外面，因为最终 chunk 可能有 finish_reason 但无 delta
      const fr = json.choices?.[0]?.finish_reason;
      if (fr === 'tool_calls') lastFinishReason = 'tool_use';
      else if (fr === 'stop') lastFinishReason = 'end_turn';
      if (!delta) continue;

      // reasoning_content → Anthropic thinking 块 + 缓存（用于下游第二轮请求）
      if (delta.reasoning_content) {
        cachedReasoningContent += delta.reasoning_content;
        // 结束当前块再开 thinking 块
        if (textStarted) {
          sendEvent('content_block_stop', { type: 'content_block_stop', index: currentBlockIndex });
          textStarted = false;
        }
        if (toolUseStarted) {
          sendEvent('content_block_stop', { type: 'content_block_stop', index: currentBlockIndex });
          toolUseStarted = false;
        }
        sendMessageStart();
        currentBlockIndex++;
        sendEvent('content_block_start', {
          type: 'content_block_start',
          index: currentBlockIndex,
          content_block: { type: 'thinking', thinking: '', signature: Buffer.from('cc-gw').toString('base64') },
        });
        sendEvent('content_block_delta', {
          type: 'content_block_delta',
          index: currentBlockIndex,
          delta: { type: 'thinking_delta', thinking: delta.reasoning_content },
        });
        // thinking 块立即结束（非流式累积）
        sendEvent('content_block_stop', { type: 'content_block_stop', index: currentBlockIndex });
        continue;
      }

      // 文本增量
      if (delta.content) {
        startTextBlock();
        sendEvent('content_block_delta', {
          type: 'content_block_delta',
          index: currentBlockIndex,
          delta: { type: 'text_delta', text: delta.content },
        });
      }

      // 工具调用增量
      if (delta.tool_calls?.length > 0) {
        for (const tc of delta.tool_calls) {
          const tcId = tc.id || `tool_${Date.now()}`;
          const tcName = tc.function?.name || '';
          // 反向重命名 web_search_20250305 → WebSearch（恢复 Claude Code 原名）
          const resolvedName = tcName === 'web_search_20250305' ? 'WebSearch' : tcName;
          if (resolvedName !== tcName) tc.function.name = resolvedName;
          if (resolvedName) {
            startToolUseBlock(tcId, resolvedName);
          }
          if (tc.function?.arguments) {
            sendEvent('content_block_delta', {
              type: 'content_block_delta',
              index: currentBlockIndex,
              delta: { type: 'input_json_delta', partial_json: tc.function.arguments },
            });
          }
        }
      }
    }
  });

  openAIStream.on('end', () => {
    if (!res.writableEnded) {
      finishStream();
    }
  });

  openAIStream.on('error', (err) => {
    console.error(`[Proxy] OpenAI stream error: ${err.message}`);
    if (!res.writableEnded) {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: `Stream error: ${err.message}`, type: 'api_error' }));
    }
  });
}

// ===== 费用计算 =====
export function calculateCost(modelSpec: string, inputTokens: number, outputTokens: number): number {
  try {
    const provider = modelSpec.split('/')[0];
    const providers = loadProviders().providers;
    const cfg = providers.get(provider);
    if (cfg?.pricing) {
      const p = cfg.pricing;
      return (inputTokens * p.inputPerMillion + outputTokens * p.outputPerMillion) / 1_000_000;
    }
    // 未知供应商 — 输出警告日志
    console.warn(`[calculateCost] ⚠️ Unknown provider "${provider}", using default pricing ($0.55/M input, $2.19/M output)`);
  } catch {}
  return (inputTokens * 0.55 + outputTokens * 2.19) / 1_000_000;
}

// ===== HTTP 代理服务器 =====
let server: http.Server | null = null;
const REQUEST_TIMEOUT = 120_000; // 120 秒

function handleRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
  const reqUrl = new URL(req.url || '/', 'http://localhost');
  const reqPath = reqUrl.pathname;

  logEvent({
    event: 'proxy_request',
    method: req.method,
    path: reqPath,
  });
  if (reqPath.includes('response') || reqPath.includes('/v1/')) {
    require('fs').appendFileSync('/tmp/imtoagent-paths.log', req.method + ' ' + reqPath + '\n');
  }

  // Codex 路径 → 转发到 codex handler
  if (reqPath === '/v1/responses' || reqPath.startsWith('/v1/responses')) {
    handleCodexDispatch(req, res);
    return;
  }

  const cfg = sharedState.activeConfig;
  if (!cfg) {
    res.writeHead(503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'No active provider configured. Use /model to set one.' }));
    return;
  }

  const isAnthropicFormat = cfg.format === 'anthropic';
  const urlObj = new URL(cfg.baseUrl);
  const upstreamHost = urlObj.host;
  const upstreamProto = urlObj.protocol.replace(':', '');
  const basePath = urlObj.pathname.replace(/\/+$/, ''); // 去掉尾部斜杠

  // 处理 /v1/models 请求：返回当前供应商的模型列表（Claude Code SDK 会调用）
  if (reqPath === '/v1/models' && req.method === 'GET') {
    const modelList = providers.get(cfg.providerName)?.models || [cfg.model];
    const response = {
      object: 'list',
      data: modelList.map((m: string) => ({
        id: m,
        object: 'model',
        created: Date.now(),
        owned_by: cfg.providerName,
      })),
    };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(response));
    console.log(`[Proxy] → ${cfg.providerName}/${cfg.model} GET /v1/models (simulated, returning ${modelList.length} models)`);
    return;
  }

  // 处理 /health 请求
  if (reqPath === '/health' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    const modelSpec = cfg ? `${cfg.providerName}/${cfg.model}` : 'none';
    const healthResp: { status: string; model: string | null; providers: string[] } = { status: 'ok', model: modelSpec, providers: [...providers.keys()] };
    
    // Add circuit breaker status
    if (circuitManager) {
      healthResp.circuitBreakers = circuitManager.healthStatus();
    }
    
    res.end(JSON.stringify(healthResp));
    return;
  }

  // 拦截 HEAD 请求，避免转发到不支持 HEAD 的上游（mimo2api 等只接受 POST）
  if (req.method === 'HEAD') {
    res.writeHead(200);
    res.end();
    return;
  }

  // 根据供应商格式决定上游路径（仅限 /v1/messages）
  const upstreamPath = isAnthropicFormat
    ? `${basePath}/v1/messages`
    : `${basePath}/chat/completions`;

  // 收集请求体
  const chunks: Buffer[] = [];
  req.on('data', (chunk: Buffer) => chunks.push(chunk));
  req.on('end', () => {
    let bodyStr = Buffer.concat(chunks).toString('utf-8');
    let originalModel = '';
    let parsedBody: AnthropicRequestBody | OpenAIRequestBody = {} as AnthropicRequestBody;

    try {
      parsedBody = JSON.parse(bodyStr);
      originalModel = parsedBody.model || '';
    } catch { /* 非 JSON */ }

    // 🧠 动态注入 imtoagent system prompt（IM能力/心跳/Soul/MCP/Skills/Prompts）
    const ctx = getCurrentBot();
    if (ctx) {
      const injected = buildSystemPrompt({
        caps: ctx.caps || null,
        botKey: ctx.botName || 'CodexBot',
        mcpInfo: ctx.mcpInfo,
        skillsInfo: ctx.skillsInfo,
        promptsInfo: ctx.promptsInfo,
      });
      const existing = parsedBody.system;
      if (typeof existing === 'string') {
        parsedBody.system = existing + '\n\n---\n\n' + injected;
      } else if (Array.isArray(existing)) {
        (parsedBody as any).system = [...existing, { type: 'text', text: '\n\n---\n\n' + injected }];
      } else {
        parsedBody.system = injected as any;
      }
      bodyStr = JSON.stringify(parsedBody);
      console.log(`[Proxy] 🧠 System prompt injected (${injected.length} chars)`);
    }

    // 根据 Claude Code 传的模型名前缀，识别角色并替换为完整规格
    const resolvedSpec = resolveModelByPrefix(originalModel);
    console.log(`[Proxy] Model resolved: ${originalModel} → ${resolvedSpec}`);

    // 🌐 Web Search：DeepSeek 使用版本化工具名 web_search_20250305，Claude Code 发的是 web_search
    if (parsedBody.tools) {
      for (const t of parsedBody.tools) {
        const tn = (t.name || t.type || '').toLowerCase();
        // 调试：WebSearch 工具的完整定义
        if ((t.name || '').toLowerCase().includes('search')) {
          console.log(`[Proxy] 🔍 WebSearch original definition: ${JSON.stringify(t)}`);
        }
        if (tn === 'web_search' || tn === 'websearch') {
          t.name = 'web_search_20250305';
          console.log(`[Proxy] 🔍 web_search → web_search_20250305 ✅`);
        }
      }
    }
    if (parsedBody.tools && parsedBody.tools.length > 0) {
      console.log(`[Proxy] 🔍 tools definition: ${(parsedBody.tools as AnthropicTool[]).map((t) => t.name || (t as AnthropicTool).type).join(', ')}`);
    }

    // 解析供应商和模型名
    const slashIdx = resolvedSpec.indexOf('/');
    let targetProviderName: string;
    let targetModelName: string;
    
    if (slashIdx >= 0) {
      targetProviderName = resolvedSpec.slice(0, slashIdx);
      targetModelName = resolvedSpec.slice(slashIdx + 1);
    } else {
      // 无供应商前缀，使用当前配置
      targetProviderName = cfg.providerName;
      targetModelName = resolvedSpec;
    }

    // 根据目标供应商获取配置
    let targetProvider = providers.get(targetProviderName);
    if (!targetProvider) {
      console.error(`[Proxy] Unknown provider: ${targetProviderName}`);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: `Unknown provider: ${targetProviderName}` }));
      return;
    }

    // Circuit breaker check + auto-failover
    const cm = getCircuitManager();
    let breaker = cm.get(targetProviderName);
    if (breaker && !breaker.canRequest()) {
      console.log(`[Proxy] ⚡ Circuit breaker OPEN for ${targetProviderName}, trying failover...`);
      logEvent({
        event: 'proxy_circuit_open',
        provider: targetProviderName,
      });
      const allProviderNames = [...providers.keys()];
      const fallbackName = cm.findAvailable(allProviderNames.filter((n) => n !== targetProviderName));
      if (fallbackName) {
        const fallbackProvider = providers.get(fallbackName)!;
        console.log(`[Proxy] 🔄 Failing over: ${targetProviderName} → ${fallbackName}`);
        // Switch all target variables to the fallback provider
        targetProviderName = fallbackName;
        targetProvider = fallbackProvider;
        // Use fallback provider's first model
        targetModelName = fallbackProvider.models?.[0] || targetModelName;
        // Update breaker to track the fallback provider
        const fbBreaker = cm.get(fallbackName);
        if (fbBreaker) breaker = fbBreaker;
      } else {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: `Provider ${targetProviderName} is temporarily unavailable (circuit breaker open, no fallback)` }));
        return;
      }
    }

    const targetIsAnthropic = targetProvider.format === 'anthropic';
    const targetUrlObj = new URL(targetProvider.baseUrl);
    const targetUpstreamHost = targetUrlObj.host;
    const targetUpstreamProto = targetUrlObj.protocol.replace(':', '');
    const targetBasePath = targetUrlObj.pathname.replace(/\/+$/, '');
    const targetUpstreamPath = targetIsAnthropic
      ? `${targetBasePath}/v1/messages`
      : `${targetBasePath}/chat/completions`;

    // 格式转换
    let finalBody: string;
    if (targetIsAnthropic) {
      parsedBody.model = targetModelName;
      finalBody = JSON.stringify(parsedBody);
    } else {
      // Bug 3 修复：检查 assistant 消息是否缺少 thinking 块，从缓存注入
      if (parsedBody.messages && Array.isArray(parsedBody.messages)) {
        const fp = conversationFingerprint(parsedBody.messages);
        const cached = fp ? reasoningCache.get(fp) : null;
        if (cached) {
          for (const msg of parsedBody.messages) {
            if (msg.role === 'assistant' && Array.isArray(msg.content)) {
              const hasThinking = (msg.content as AnthropicContentBlock[]).some((b) => b.type === 'thinking' || b.type === 'redacted_thinking');
              if (!hasThinking) {
                msg.content.unshift({
                  type: 'thinking',
                  thinking: cached,
                  signature: Buffer.from('cc-gw').toString('base64'),
                });
                console.log(`[Proxy] 🧠 Injected thinking block (cache hit, length: ${cached.length})`);
              }
            }
          }
        }
      }
      parsedBody = anthropicToOpenAI(parsedBody, targetModelName, originalModel);
      finalBody = JSON.stringify(parsedBody);
    }

    const options: http.RequestOptions = {
      hostname: targetUrlObj.hostname,
      port: targetUrlObj.port || (targetUpstreamProto === 'https' ? 443 : 80),
      path: targetUpstreamPath,
      method: req.method,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(finalBody),
        ...(targetIsAnthropic
          ? { 'x-api-key': targetProvider.apiKey, 'anthropic-version': '2023-06-01' }
          : { Authorization: `Bearer ${targetProvider.apiKey}` }),
      },
      timeout: REQUEST_TIMEOUT,
    };

    const isStream = parsedBody.stream !== false;

    console.log(`[Proxy] → ${targetProviderName}/${targetModelName} (${targetProvider.format}) ${req.method} ${req.url}${originalModel ? ` (original: ${originalModel})` : ''}`);

    logEvent({
      event: 'proxy_upstream_request',
      provider: targetProviderName,
      model: targetModelName,
      format: targetProvider.format,
      stream: isStream,
    });

    const upstreamReq = (targetUpstreamProto === 'https' ? require('https') : http).request(options, (upstreamRes) => {
      // 流式响应
      if (isStream && upstreamRes.headers['content-type']?.includes('text/event-stream')) {
        logEvent({ event: 'proxy_sse_start', provider: targetProviderName, model: targetModelName });
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        });

        if (targetIsAnthropic) {
          // Anthropic 供应商：透传 SSE 流，但重写 message_start 中的 model 名
          let streamBuffer = '';
          const modelNameForStream = originalModel || targetModelName;
          upstreamRes.on('data', (chunk: Buffer) => {
            if (!res.writableEnded) {
              streamBuffer += chunk.toString();
              // 重写 message_start 事件中的 model 字段
              while (streamBuffer.includes('\n')) {
                const idx = streamBuffer.indexOf('\n');
                const line = streamBuffer.slice(0, idx).trim();
                streamBuffer = streamBuffer.slice(idx + 1);
                if (line.startsWith('data:') && line.includes('"message_start"') && line.includes('"model"')) {
                  try {
                    const jsonStr = line.slice(5).trim();
                    const evt = JSON.parse(jsonStr);
                    if (evt.message) evt.message.model = modelNameForStream;
                    res.write(`data: ${JSON.stringify(evt)}\n\n`);
                  } catch { res.write(line + '\n'); }
                } else {
                  res.write(line + '\n');
                }
              }
            }
          });
          upstreamRes.on('end', () => {
            logEvent({ event: 'proxy_sse_end', provider: targetProviderName });
            if (!res.writableEnded) res.end();
          });
          upstreamRes.on('error', (err) => { if (!res.writableEnded) { res.writeHead(502); res.end(); } });
        } else {
          // OpenAI 供应商：转换为 Anthropic 格式
          openAIStreamToAnthropic(upstreamRes, res, originalModel || targetModelName, targetProviderName);
        }
      } else {
        // 非流式响应
        const respChunks: Buffer[] = [];
        upstreamRes.on('data', (chunk: Buffer) => respChunks.push(chunk));
        upstreamRes.on('end', () => {
          const respStr = Buffer.concat(respChunks).toString('utf-8');

          if (upstreamRes.statusCode !== 200) {
            console.error(`[Proxy] Upstream error ${upstreamRes.statusCode}: ${respStr.slice(0, 500)}`);
            if (breaker) breaker.recordFailure();
            res.writeHead(upstreamRes.statusCode || 500, { 'Content-Type': 'application/json' });
            res.end(respStr);
            return;
          }

          // Success — record for circuit breaker
          if (breaker) breaker.recordSuccess();
          logEvent({ event: 'proxy_upstream_response', provider: targetProviderName, status: upstreamRes.statusCode });

          if (targetIsAnthropic) {
            // 重写 model 名为 CC 原始名（上游返回 mimo-v2.5-pro，CC 不认识）
            try {
              let uj = JSON.parse(respStr);
              uj.model = originalModel || uj.model;
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify(uj));
            } catch {
              res.writeHead(upstreamRes.statusCode || 200, upstreamRes.headers);
              res.end(respStr);
            }
          } else {
            let openAIJson: OpenAIRequestBody;
            try { openAIJson = JSON.parse(respStr); } catch {
              console.error(`[Proxy] OpenAI JSON parse failed: ${respStr.slice(0, 200)}`);
              res.writeHead(502, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'Invalid upstream response', type: 'api_error' }));
              return;
            }
            const anthropicResp = openAIToAnthropic(openAIJson, originalModel || targetModelName);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(anthropicResp));
          }
        });
      }
    });

    upstreamReq.on('timeout', () => {
      upstreamReq.destroy();
      console.error(`[Proxy] Request timeout (${REQUEST_TIMEOUT}ms)`);
      logEvent({ event: 'proxy_upstream_error', provider: targetProviderName, error: 'timeout' });
      if (breaker) breaker.recordFailure();
      if (!res.writableEnded) {
        res.writeHead(504, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Upstream request timeout', type: 'api_error' }));
      }
    });

    upstreamReq.on('error', (err) => {
      console.error(`[Proxy] Upstream request failed: ${err.message}`);
      logEvent({ event: 'proxy_upstream_error', provider: targetProviderName, error: err.message });
      if (breaker) breaker.recordFailure();
      if (!res.writableEnded) {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: `Upstream error: ${err.message}`, type: 'api_error' }));
      }
    });

    upstreamReq.end(finalBody);
  });
}

/** 将 Node req/res 桥接到 codex handler */
async function handleCodexDispatch(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  logEvent({
    event: 'proxy_codex_request',
    method: req.method,
    path: req.url,
  });
  const chunks: Buffer[] = [];
  req.on('data', (chunk: Buffer) => chunks.push(chunk));
  req.on('end', async () => {
    const body = Buffer.concat(chunks).toString('utf-8');
    const reqUrl = new URL(req.url || '/', 'http://localhost');
    await handleCodexRequest(body, reqUrl.pathname, req.method || 'GET', res);
  });
}
export function startAnthropicProxy(port = 18899): Promise<number> {
/** 将 Node req 桥接到 codex handler（handler 直接操作 res） */
  return new Promise((resolve) => {
    server = http.createServer(handleRequest);
    server.listen(port, () => {
      console.log(`[Proxy] Local proxy started at http://localhost:${port}/v1/messages`);
      console.log(`[Proxy] Current model: ${sharedState.activeConfig ? `${sharedState.activeConfig.providerName}/${sharedState.activeConfig.model} (${sharedState.activeConfig.format})` : 'not set'}`);
      console.log(`[Proxy] Provider: ${sharedState.activeConfig?.baseUrl || 'none'}`);

      // Check for providers with empty API keys
      const emptyKeyProviders: string[] = [];
      providers.forEach((cfg, name) => {
        if (!cfg.apiKey) emptyKeyProviders.push(name);
      });
      if (emptyKeyProviders.length > 0) {
        console.log(`⚠️  The following providers have empty API Keys and may not work properly: ${emptyKeyProviders.join(', ')}`);
        console.log('   Suggestion: run "imtoagent setup" to configure required parameters\n');
      }

      resolve(port);
    });
  });
}

export async function stopAnthropicProxy(): Promise<void> {
  return new Promise((resolve) => {
    if (server) {
      server.close(() => {
        console.log('[Proxy] Proxy server closed');
        server = null;
        resolve();
      });
    } else {
      resolve();
    }
  });
}

// ===== 会话持久化 =====
export interface SessionMemoryData {
  chatId: string;
  userId: string;
  sdkSessionId?: string;
  cwd?: string;
  permissionMode?: string;
  recentMessages: string[];
  stats: { calls: number; totalTurns: number; totalInputTokens: number; totalOutputTokens: number; totalCostUSD: number; totalDurationMs: number };
  activeModel: string;
  modelAliases: ModelAliases;
  lastUsed: number;
}

export function saveSessionMemory(memoryPath: string, data: SessionMemoryData): void {
  const dir = path.dirname(memoryPath);
  try { if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true }); } catch {}
  try {
    fs.writeFileSync(memoryPath, JSON.stringify(data, null, 2));
  } catch (e: unknown) {
    console.error(`[Memory] Failed to save session: ${e.message}`);
  }
}

export function loadSessionMemory(memoryPath: string): SessionMemoryData | null {
  try {
    if (!fs.existsSync(memoryPath)) return null;
    return JSON.parse(fs.readFileSync(memoryPath, 'utf-8'));
  } catch (e: unknown) {
    console.error(`[Memory] Failed to load session: ${e.message}`);
    return null;
  }
}

export function deleteSessionMemory(chatId: string): void {
  const filePath = `${SESSIONS_DIR()}/${chatId}.memory.json`;
  try {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch (e: unknown) {
    console.error(`[Memory] Failed to delete session ${chatId}: ${e.message}`);
  }
}

export function listPersistedSessions(): string[] {
  try {
    const sessionsBase = SESSIONS_DIR();
    if (!fs.existsSync(sessionsBase)) return [];
    return fs.readdirSync(sessionsBase)
      .filter(f => f.endsWith('.memory.json'))
      .map(f => f.replace('.memory.json', ''));
  } catch (e: unknown) {
    console.error(`[Memory] Failed to scan session directory: ${e.message}`);
    return [];
  }
}
