// ================================================================
// Tool-Call Loop — 拦截上游 tool_call，本地执行 imtoagent_* 工具
// ================================================================
// 职责：
//   1. 调用上游 LLM（非流式），检测 tool_calls
//   2. 识别 imtoagent_* / get_weather 等本地工具 → ToolRegistry.execute
//   3. 拼 tool 消息追加到 messages，循环直到无本地工具
//   4. 返回最终 messages（用于重新 fetch stream:true 获取最终文本）
//
// 设计约束：
//   - 只拦截本地工具（imtoagent_* / goal_* / get_weather 前缀）
//   - 非本地工具原样保留，由上游/客户端处理
//   - 最大循环次数保护（MAX_LOOPS）
//   - 单工具执行超时（TOOL_EXEC_TIMEOUT_MS）
// ================================================================

import type { ToolRegistry } from '../agent/tool-registry';

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
const TOOL_EXEC_TIMEOUT_MS = 30_000;

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
 * 判断 tool name 是否为本地工具
 *
 * 本地工具约定：
 *   - imtoagent_* 前缀（IMtoAgent 内置工具）
 *   - goal_* 前缀（Goal 引擎工具）
 *   - get_weather（内置天气工具）
 */
function isLocalTool(name: string): boolean {
  return (
    name.startsWith('imtoagent_') ||
    name.startsWith('goal_') ||
    name === 'get_weather'
  );
}

/**
 * 检查工具列表中是否包含本地工具
 */
export function hasLocalTools(tools: OpenAITool[] | undefined): boolean {
  if (!tools || tools.length === 0) return false;
  return tools.some(t => isLocalTool(t.function?.name || ''));
}

/**
 * Tool-Call Loop 主入口
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
 *
 * 返回值说明：
 *   - hadLocalTools = false：无本地工具被调用，可直接 streamResponse 原始上游响应
 *   - hadLocalTools = true：本地工具已执行完，需要用返回的 messages 重新 fetch(stream:true) 获取最终文本
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
    // 保留原始请求中的额外字段（如 thinking、reasoning 等）
    // 🔧 DeepSeek thinking 模式约束：只有 messages 里有 reasoning_content 时才传 thinking，否则 400
    const hasReasoningContent = messages.some(
      (m: any) => m.reasoning_content !== undefined && m.reasoning_content !== null && m.reasoning_content !== ''
    );
    if (extraBodyFields) {
      for (const [k, v] of Object.entries(extraBodyFields)) {
        // 跳过 thinking 除非 messages 已有 reasoning_content
        if (k === 'thinking' && !hasReasoningContent) continue;
        if (v !== undefined) body[k] = v;
      }
    }
    if (hasReasoningContent) {
      body.thinking = { type: 'enabled' };
      console.log(`[ToolCallLoop] 🔧 Messages contain reasoning_content, forcing thinking to enabled`);
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
      console.error(`[ToolCallLoop] ❌ request failed (loop ${loops}): ${msg}`);
      // 网络错误 → 返回空结果，让上层处理
      return { messages, hadLocalTools: false, loops: 0 };
    }

    if (!upstreamRes.ok) {
      const errText = await upstreamRes.text().catch(() => '');
      console.error(`[ToolCallLoop] ❌ upstream ${upstreamRes.status} (loop ${loops}): ${errText.slice(0, 200)}`);
      return { messages, hadLocalTools: false, loops: 0 };
    }

    // ---- 第 2 步：解析响应 ----
    let data: Record<string, unknown>;
    try {
      data = await upstreamRes.json();
    } catch {
      console.error('[ToolCallLoop] ❌ failed to parse upstream JSON');
      return { messages, hadLocalTools, loops };
    }

    const choice = (data as any)?.choices?.[0];
    if (!choice) {
      console.warn('[ToolCallLoop] ⚠️ no choices in upstream response');
      return { messages, hadLocalTools, loops };
    }

    const assistantMsg: ChatMessage = choice.message || {};
    const toolCalls: NonNullable<ChatMessage['tool_calls']> = assistantMsg.tool_calls || [];
    const finishReason: string = choice.finish_reason || '';
    const assistantText: string | null = assistantMsg.content || null;
    const reasoningContent: string | undefined = assistantMsg.reasoning_content;

    // 没有 tool_call → 循环结束
    if (toolCalls.length === 0) {
      console.log(`[ToolCallLoop] ✅ no tool_calls (loop ${loops}), finish_reason=${finishReason}`);
      return { messages, hadLocalTools, loops };
    }

    // ---- 第 3 步：分类 tool_calls ----
    const localCalls: typeof toolCalls = [];
    const remoteCalls: typeof toolCalls = [];

    for (const tc of toolCalls) {
      const name = tc.function?.name || '';
      if (isLocalTool(name)) {
        localCalls.push(tc);
      } else {
        remoteCalls.push(tc);
      }
    }

    console.log(`[ToolCallLoop] loop ${loops}: ${localCalls.length} local, ${remoteCalls.length} remote tool_calls`);

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

    // 没有本地工具：为远端工具追加占位 tool 消息，返回给 upstream 处理
    if (localCalls.length === 0) {
      for (const tc of remoteCalls) {
        messages.push({
          role: 'tool',
          tool_call_id: tc.id,
          content: `[Remote tool "${tc.function?.name}" managed by upstream runtime — no local action needed]`,
        });
      }
      console.log(`[ToolCallLoop] ℹ️ only remote tool_calls, returning to upstream: ${remoteCalls.map(tc => tc.function?.name || '').join(', ')}`);
      return { messages, hadLocalTools, loops };
    }

    // ---- 第 4 步：执行本地工具 ----
    for (const tc of localCalls) {
      const name = tc.function?.name || '';
      let args: Record<string, unknown> = {};
      try {
        args = typeof tc.function?.arguments === 'string'
          ? JSON.parse(tc.function.arguments)
          : {};
      } catch {
        args = {};
      }

      const argsPreview = JSON.stringify(args).slice(0, 200);
      console.log(`[ToolCallLoop] 🔧 executing: ${name}(${argsPreview})`);

      let result: string;
      try {
        const execPromise = toolRegistry.execute(name, args);
        const timeoutPromise = new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('tool execution timeout')), TOOL_EXEC_TIMEOUT_MS),
        );
        const rawResult = await Promise.race([execPromise, timeoutPromise]);
        result = typeof rawResult === 'string' ? rawResult : JSON.stringify(rawResult);
      } catch (e: unknown) {
        result = `Error executing ${name}: ${(e as Error).message}`;
        console.error(`[ToolCallLoop] ❌ tool failed: ${name} → ${result}`);
      }

      // 追加 tool result
      messages.push({
        role: 'tool',
        tool_call_id: tc.id,
        content: result,
      });

      hadLocalTools = true;
      console.log(`[ToolCallLoop] ✅ ${name} done (${result.length} chars)`);
    }

    // ---- 第 5 步：处理远端工具 ----
    if (remoteCalls.length > 0) {
      // 远端工具没有本地 handler
      // 注入占位结果（不报错），避免 LLM 等待
      const names = remoteCalls.map(tc => tc.function?.name || '').join(', ');
      console.log(`[ToolCallLoop] ℹ️ ${remoteCalls.length} remote tool_calls (pass-through): ${names}`);

      for (const tc of remoteCalls) {
        messages.push({
          role: 'tool',
          tool_call_id: tc.id,
          content: `[Remote tool "${tc.function?.name}" managed by upstream runtime — no local action needed]`,
        });
      }
    }

    // ---- 第 6 步：继续循环 ----
    console.log(`[ToolCallLoop] 🔄 loop ${loops} done, continuing...`);
  }

  console.warn(`[ToolCallLoop] ⚠️ max loops (${MAX_LOOPS}) reached`);
  return { messages, hadLocalTools, loops };
}
