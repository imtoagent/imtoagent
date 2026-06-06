// Codex Proxy — Responses API ↔ Chat Completions 双向转换
// Codex 请求处理器（已合并到 18899） · 可作为模块导入或被 Bun 直接运行

import { getCurrentBot } from '../bot-context';
import { buildSystemPrompt, resolveCapabilities, DEFAULT_TERMINAL_CAPS } from '../prompt-builder';
import * as path from 'path';
import * as fs from 'fs';
import { getDataDir } from '../utils/paths';
import { logUsage } from './usage-logger';
import { ContextManager } from './context-manager';
import type { OpenAIRequestBody, OpenAITool, OpenAIStreamChunk, AnthropicResponseUsage } from './proxy-types';

// ================================================================
// 配置（从 config.json 读取，不再硬编码）
// ================================================================
interface CodexProxyConfig {
  model: string;
  reportedModel: string;
  upstream: string;
  apiKey: string;
  supportedInputTypes?: string[];  // e.g. ["text"], ["text","image_url"]
}

let _codexConfig: CodexProxyConfig | null = null;

// ================================================================
// P2: ContextManager singleton — token budget + tool output compression + semantic compression
// ================================================================
const codexContextManager = new ContextManager({
  backend: 'openai',
  budget: {
    maxTokens: 64000,
    reservedForResponse: 8000,
    maxInputTokens: 48000,
  },
  keepRecentRounds: 2,
  maxToolOutputChars: 2000,
  truncateToolOutput: true,
  simplifySuccessOutputs: true,
  preserveSystemPrompt: true,
  preserveReasoning: true,
  debugLog: true,
  semanticCompression: {
    model: 'deepseek-ai/DeepSeek-V3',
    apiBase: 'https://api.siliconflow.cn/v1',
    apiKey: process.env.SILICONFLOW_API_KEY || '',
    thresholdRatio: 0.5,
    maxOutputTokens: 4096,
    timeoutMs: 10000,
    enableCache: true,
    cacheSize: 200,
  },
});

export function initCodexProxyConfig(cfg: CodexProxyConfig) {
  _codexConfig = cfg;
  console.log(`[Codex Proxy] Config loaded: model=${cfg.model}, upstream=${cfg.upstream}`);
}

/**
 * 热切换模型：在 /model 命令中调用，更新内存中的 _codexConfig。
 * 需同时持久化到 config.json（调用方负责），确保重启后不丢失。
 */
export function updateCodexConfig(modelSpec: string) {
  if (_codexConfig) {
    const parts = modelSpec.split('/');
    const modelName = parts[parts.length - 1] || modelSpec;
    _codexConfig.model = modelName;
    console.log(`[Codex Proxy] Model hot-switched to: ${modelName}`);
  }
}

function getConfig(): CodexProxyConfig {
  if (!_codexConfig) {
    // Fallback: 尝试从 config.json 读取
    try {
      
      const configPath = path.join(getDataDir(), 'config.json');
      const raw = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      const codex = raw.codex || {};
      const providers = raw.providers || {};
      const modelId = codex.model || 'deepseek-v4-pro';
      let apiKey = '';
      for (const name of Object.keys(providers)) {
        apiKey = providers[name].apiKey || '';
        if (apiKey) break;
      }
      _codexConfig = {
        model: modelId,
        reportedModel: codex.reportedModel || 'gpt-5.5',
        upstream: codex.upstream || 'https://api.deepseek.com/v1/chat/completions',
        apiKey,
        supportedInputTypes: resolveSupportedInputTypes(providers, modelId),
      };
      console.log('[Codex Proxy] Loaded config from config.json');
    } catch (e: unknown) {
      console.error(`[Codex Proxy] Unable to load config: ${e.message}`);
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
// 且 tool_call_id 一一对应。deepseek-v4-pro 等严格 API 需要此验证。
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
// 2. 响应翻译: Chat SSE → Responses SSE
// ================================================================
async function streamResponse(upstreamRes: Response, resWriter: WritableStreamDefaultWriter<Uint8Array>, reqBody?: OpenAIRequestBody): Promise<void> {
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

        if (delta.content) {
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
          accumulatedText += delta.content;
          emit('response.output_text.delta', { item_id: msgId, output_index: msgIdx, content_index: 0, delta: delta.content });
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
}

// ================================================================
// usage 累加器 — 内部统计，供 accumulateProxyUsage 记录
// ================================================================
let _proxyUsage = { inputTokens: 0, outputTokens: 0 };

export function accumulateProxyUsage(inputTokens: number, outputTokens: number) {
  _proxyUsage.inputTokens += inputTokens;
  _proxyUsage.outputTokens += outputTokens;
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

      const systemPrompt = buildSystemPrompt({
        caps: ctx?.caps || null,
        botName,
        mcpInfo: ctx?.mcpInfo,
        skillsInfo: ctx?.skillsInfo,
        promptsInfo: ctx?.promptsInfo,
      });
      console.log(`[Codex] 📝 System prompt built (${systemPrompt.length} chars, bot=${botName})`);

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
      const processed = await codexContextManager.processAsync(chatReq) as typeof chatReq;
      const postMsgs = processed.messages.length;
      const postEst = processed.messages.reduce((s, m) => s + (typeof m.content === 'string' ? m.content.length : 0), 0);
      const savings = preEst - postEst;
      // Always log to verify processAsync is running
      console.log(`[Codex] 🔧 ContextManager: ${preMsgs}→${postMsgs} msgs, ~${preEst.toLocaleString()}→~${postEst.toLocaleString()} chars (saved ${savings.toLocaleString()})`);
      if (savings > 0) {
        Object.assign(chatReq, processed);
      }

      const roles = chatReq.messages?.map((m: ChatMessage) => m.role).join(',');
      console.log(`[Codex] → ${chatReq.model} [${roles}] tools:${chatReq.tools?.length || 0}`);

      const ac = new AbortController();
      const timeout = setTimeout(() => ac.abort(), 180_000);

      let upstreamRes: Response;
      try {
        upstreamRes = await fetch(UPSTREAM(), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${API_KEY()}` },
          body: JSON.stringify(chatReq),
          signal: ac.signal,
        });
      } catch (e: unknown) {
        console.error(`[Codex] ❌ fetch failed: ${e.message}`);
        res.writeHead(502, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'upstream unavailable' })); return;
      } finally {
        clearTimeout(timeout);
      }

      if (!upstreamRes.ok) {
        const errText = await upstreamRes.text();
        console.error(`[Codex] ❌ ${upstreamRes.status}: ${errText.slice(0, 200)}`);
        // 400 with unknown variant — retry with filtered content (strip unsupported types)
        if (upstreamRes.status === 400 && errText.includes('unknown variant')) {
          console.log('[Codex] ⚠️ Upstream rejected unknown variant, retrying with filtered content...');
          const filteredChat = filterUnsupportedTypes(chatReq, SUPPORTED_INPUT_TYPES());
          const retryBody = JSON.stringify(filteredChat);
          fs.writeFileSync('/tmp/codex-body-retry.json', retryBody);
          const retryRes = await fetch(UPSTREAM(), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${API_KEY()}` },
            body: retryBody,
            signal: ac.signal,
          });
          if (!retryRes.ok) {
            const retryErrText = await retryRes.text();
            console.error(`[Codex] ❌ Retry also failed ${retryRes.status}: ${retryErrText.slice(0, 200)}`);
            res.writeHead(retryRes.status, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: `Upstream rejected request twice: ${retryErrText.slice(0, 500)}` }));
            return;
          }
          console.log('[Codex] ✅ Retry succeeded with filtered content');
          res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
          const writable = new WritableStream({
            write(chunk: Uint8Array) { res.write(Buffer.from(chunk)); },
            close() { res.end(); },
            abort(_err: unknown) { res.end(); },
          });
          const writer = writable.getWriter();
          await streamResponse(retryRes, writer, body).catch((e: unknown) => {
            console.error(`[Codex] streamResponse error: ${e?.message || e}`);
          }).finally(() => { try { writer.close(); } catch {} });
          return;
        }
        res.writeHead(upstreamRes.status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: errText.slice(0, 500) })); return;
      }

      // 流式：streamResponse 转换格式后写入 Node response
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });

      // 创建 WritableStream 桥接到 Node res
      const writable = new WritableStream({
        write(chunk: Uint8Array) {
          res.write(Buffer.from(chunk));
        },
        close() {
          res.end();
        },
        abort(_err: unknown) {
          res.end();
        },
      });
      const writer = writable.getWriter();
      await streamResponse(upstreamRes, writer, body).catch((e: unknown) => {
        console.error(`[Codex] streamResponse error: ${e?.message || e}`);
      }).finally(() => {
        try { writer.close(); } catch {}
      });
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'not found' })); return;
  } catch (e: unknown) {
    console.error(`[Codex] 💥 unhandled: ${e.message}`);
    res.writeHead(500, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'internal error' })); return;
  }
}
