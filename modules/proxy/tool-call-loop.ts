// ================================================================
// Tool-Call Loop — 拦截上游 tool_call，本地执行已注册工具
// ================================================================
// 职责：
//   1. 调用上游 LLM（非流式），检测 tool_calls
//   2. 通过 ToolRegistry.isRegistered() 识别已注册工具
//   3. 拼 tool 消息追加到 messages，循环直到无本地工具
//   4. 返回最终 messages（用于重新 fetch stream:true 获取最终文本）
//
// 复用 tool-interceptor.ts 的 parseToolCalls / executeLocalTools / buildToolMessages
// ================================================================

import type { ToolRegistry } from '../agent/tool-registry';
import { logger } from '../utils/logger';
import { parseToolCalls, executeLocalTools, generateRemotePlaceholders, buildToolMessages, isLocalTool } from './tool-interceptor';
import { getCurrentBot } from '../bot-context';

// OpenAI 格式子集（不依赖 codex-proxy 内部类型）
interface ChatMessage {
  role: string;
  content: string | null;
  tool_calls?: Array<{
    id: string;
    type: string;
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
  reasoning_content?: string;
}

interface OpenAITool {
  type: string;
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

const MAX_LOOPS = 10;

/**
 * 通用 HTTP 请求函数签名
 * Codex Proxy 传 fetch，Anthropic Proxy 传 http.request 包装函数
 */
export interface HttpRequestFn {
  (url: string, options: {
    method: string;
    headers: Record<string, string>;
    body: string;
    signal?: AbortSignal;
  }): Promise<{
    ok: boolean;
    status: number;
    statusText: string;
    text(): Promise<string>;
    json(): Promise<Record<string, unknown>>;
  }>;
}

/**
 * 默认的 fetch 包装函数（Codex Proxy 使用）
 */
export function defaultFetchAdapter(
  url: string,
  options: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal },
): Promise<{
  ok: boolean;
  status: number;
  statusText: string;
  text(): Promise<string>;
  json(): Promise<Record<string, unknown>>;
}> {
  return fetch(url, options as RequestInit).then(async (res) => ({
    ok: res.ok,
    status: res.status,
    statusText: res.statusText,
    text: () => res.text(),
    json: () => res.json(),
  }));
}

export interface ToolCallLoopResult {
  /** 最终 messages（含所有 tool 交互），可直接用于最终流式请求 */
  messages: ChatMessage[];
  /** 是否有本地工具被调用过 */
  hadLocalTools: boolean;
  /** 循环次数 */
  loops: number;
}



/**
 * Tool-Call Loop 主入口
 *
 * 复用 tool-interceptor.ts 的 parseToolCalls / executeLocalTools / generateRemotePlaceholders
 *
 * @param messages — 已注入 system prompt 的消息列表（会被修改）
 * @param upstream — 上游 URL
 * @param apiKey — 上游 API key
 * @param model — 模型名称
 * @param tools — 工具定义列表（OpenAI 格式）
 * @param toolRegistry — 工具注册中心
 * @param signal — 取消信号
 * @param maxTokens — 最大 token 数（可选）
 * @param httpRequest — 通用 HTTP 请求函数（Codex Proxy 传 fetch 包装，Anthropic Proxy 传 http.request 包装）
 * @returns loop 结果，含最终 messages
 */
export async function executeToolCallLoop(
  messages: ChatMessage[],
  upstream: string,
  apiKey: string,
  model: string,
  tools: OpenAITool[] | undefined,
  toolRegistry: ToolRegistry,
  signal: AbortSignal,
  maxTokens?: number,
  httpRequest?: HttpRequestFn,
  extraBodyFields?: Record<string, unknown>,
): Promise<ToolCallLoopResult> {
  let hadLocalTools = false;
  let loops = 0;

  while (loops < MAX_LOOPS) {
    loops++;

    // ---- 第 1 步：非流式调用上游 ----
    const body: Record<string, unknown> = {
      model,
      messages,
      max_tokens: maxTokens ?? 4096,
      stream: false,
    };
    const hasReasoningContent = messages.some(
      (m: any) => m.reasoning_content !== undefined && m.reasoning_content !== null && m.reasoning_content !== ''
    );
    if (extraBodyFields) {
      for (const [k, v] of Object.entries(extraBodyFields)) {
        if (k === 'thinking' && !hasReasoningContent) continue;
        if (v !== undefined) body[k] = v;
      }
    }
    if (hasReasoningContent) {
      body.thinking = { type: 'enabled' };
      logger.debug('proxy/tool-call-loop', '🔧 Messages contain reasoning_content, forcing thinking to enabled)';
    }
    if (tools && tools.length > 0) {
      body.tools = tools;
    }

    let upstreamRes: Awaited<ReturnType<NonNullable<HttpRequestFn>>>;
    try {
      const doRequest = httpRequest ?? defaultFetchAdapter;
      upstreamRes = await doRequest(upstream, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
        signal,
      });
    } catch (e: unknown) {
      const msg = (e as Error).message || String(e);
      logger.error('proxy/tool-call-loop', `❌ request failed (loop ${loops}): ${msg})`;
      return { messages, hadLocalTools: false, loops: 0 };
    }

    if (!upstreamRes.ok) {
      const errText = await upstreamRes.text().catch(() => '');
      logger.error('proxy/tool-call-loop', `❌ upstream ${upstreamRes.status} (loop ${loops}): ${errText.slice(0, 200)})`;
      return { messages, hadLocalTools: false, loops: 0 };
    }

    // ---- 第 2 步：解析响应 ----
    let data: Record<string, unknown>;
    try {
      data = await upstreamRes.json();
    } catch {
      logger.error('proxy/tool-call-loop', 'failed to parse upstream JSON');
      return { messages, hadLocalTools, loops };
    }

    const choice = (data as any)?.choices?.[0];
    if (!choice) {
      logger.warn('proxy/tool-call-loop', '⚠️ no choices in upstream response');
      return { messages, hadLocalTools, loops };
    }

    const assistantMsg: ChatMessage = choice.message || {};
    const toolCalls: NonNullable<ChatMessage['tool_calls']> = assistantMsg.tool_calls || [];
    const finishReason: string = choice.finish_reason || '';
    const assistantText: string | null = assistantMsg.content || null;
    const reasoningContent: string | undefined = assistantMsg.reasoning_content;

    if (toolCalls.length === 0) {
      logger.info('proxy/tool-call-loop', `✅ no tool_calls (loop ${loops}), finish_reason=${finishReason})`;
      return { messages, hadLocalTools, loops };
    }

    // ---- 第 3 步：分类（复用 isLocalTool 函数） ----
    const localCalls: typeof toolCalls = [];
    const remoteCalls: typeof toolCalls = [];

    for (const tc of toolCalls) {
      const name = tc.function?.name || '';
      if (isLocalTool(name, toolRegistry)) {
        localCalls.push(tc);
      } else {
        remoteCalls.push(tc);
      }
    }

    logger.info('proxy/tool-call-loop', `loop ${loops}: ${localCalls.length} local, ${remoteCalls.length} remote tool_calls)`;

    // ---- 追加 assistant 消息（保留 reasoning_content） ----
    const assistantMessageToPush: ChatMessage = {
      role: 'assistant',
      content: assistantText,
      tool_calls: toolCalls,
    };
    if (reasoningContent) {
      assistantMessageToPush.reasoning_content = reasoningContent;
    }
    messages.push(assistantMessageToPush);

    // 没有本地工具：为远端工具追加占位
    if (localCalls.length === 0) {
      const placeholders = generateRemotePlaceholders(
        remoteCalls.map(tc => ({ id: tc.id, name: tc.function?.name || '', args: {}, rawArgs: tc.function?.arguments || '{}' })),
      );
      for (const msg of buildToolMessages(placeholders)) {
        messages.push(msg);
      }
      logger.info('proxy/tool-call-loop', `ℹ️ only remote tool_calls, returning to upstream: ${remoteCalls.map(tc => tc.function?.name || '').join(', ')})`;
      return { messages, hadLocalTools, loops };
    }

    // ---- 第 4 步：执行本地工具（复用 executeLocalTools） ----
    const parsedLocalCalls = localCalls.map(tc => ({
      id: tc.id,
      name: tc.function?.name || '',
      args: (() => {
        try { return JSON.parse(tc.function?.arguments || '{}'); } catch { return {}; }
      })(),
      rawArgs: tc.function?.arguments || '{}',
    }));

    const hookRunner = getCurrentBot()?.hookRunner;
    const localResults = await executeLocalTools(parsedLocalCalls, toolRegistry, hookRunner);

    for (const msg of buildToolMessages(localResults)) {
      messages.push(msg);
    }
    hadLocalTools = true;
    logger.info('proxy/tool-call-loop', `✅ executed ${localResults.length} local tool(s))`;

    // ---- 第 5 步：处理远端工具 ----
    if (remoteCalls.length > 0) {
      const placeholders = generateRemotePlaceholders(
        remoteCalls.map(tc => ({ id: tc.id, name: tc.function?.name || '', args: {}, rawArgs: tc.function?.arguments || '{}' })),
      );
      for (const msg of buildToolMessages(placeholders)) {
        messages.push(msg);
      }
      logger.debug('proxy/tool-call-loop', `ℹ️ ${remoteCalls.length} remote tool_calls (pass-through))`;
    }

    logger.debug('proxy/tool-call-loop', `🔄 loop ${loops} done, continuing...)`;
  }

  logger.warn('proxy/tool-call-loop', `⚠️ max loops (${MAX_LOOPS}) reached)`;
  return { messages, hadLocalTools, loops };
}
