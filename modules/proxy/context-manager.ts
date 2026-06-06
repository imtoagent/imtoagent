// ================================================================
// ContextManager — 多后端上下文管理
// ================================================================
// 为 IMtoAgent 的所有后端（Anthropic/Responses/OpenAI）提供统一的
// 上下文管理：token 预算控制、tool output 压缩、智能截断。
// ================================================================

import type {
  AnthropicRequestBody,
  AnthropicMessage,
  AnthropicContentBlock,
  OpenAIRequestBody,
  OpenAIMessage,
  OpenAIToolCall,
} from './proxy-types';

// ================================================================
// 类型定义
// ================================================================

/** 后端类型 */
export type BackendType = 'anthropic' | 'responses' | 'openai';

/** 上下文预算配置 */
export interface ContextBudget {
  maxTokens: number;
  reservedForResponse: number;
  maxInputTokens: number;
}

/** ContextManager 配置 */
export interface ContextConfig {
  backend: BackendType;
  budget: ContextBudget;
  keepRecentRounds: number;
  maxToolOutputChars: number;
  truncateToolOutput: boolean;
  simplifySuccessOutputs: boolean;
  preserveSystemPrompt: boolean;
  preserveReasoning: boolean;
  debugLog?: boolean;
}

/** 统一的消息表示（内部使用） */
interface NormalizedMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  toolCalls?: Array<{ id: string; name: string; arguments: string }>;
  toolCallId?: string;
  reasoning?: string;
  metadata: Record<string, unknown>;
}

/** Responses API input item */
interface ResponsesItem {
  type: string;
  role?: string;
  call_id?: string;
  name?: string;
  arguments?: string;
  output?: string;
  content?: unknown;
  summary?: Array<{ text?: string; summary_text?: string }>;
  [key: string]: unknown;
}

// ================================================================
// 默认配置
// ================================================================

const DEFAULT_BUDGET: ContextBudget = {
  maxTokens: 64000,
  reservedForResponse: 8000,
  maxInputTokens: 48000,
};

const DEFAULT_CONFIG: ContextConfig = {
  backend: 'openai',
  budget: DEFAULT_BUDGET,
  keepRecentRounds: 2,
  maxToolOutputChars: 2000,
  truncateToolOutput: true,
  simplifySuccessOutputs: true,
  preserveSystemPrompt: true,
  preserveReasoning: false,
  debugLog: false,
};

// ================================================================
// ContextManager 类
// ================================================================

export class ContextManager {
  private config: ContextConfig;

  constructor(config?: Partial<ContextConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    if (config?.budget) {
      this.config.budget = { ...DEFAULT_BUDGET, ...config.budget };
    }
  }

  /**
   * 处理上下文（主入口）
   */
  process(input: unknown): unknown {
    switch (this.config.backend) {
      case 'anthropic':
        return this.processAnthropic(input as AnthropicRequestBody);
      case 'responses':
        return this.processResponses(input as Record<string, unknown>);
      case 'openai':
        return this.processOpenAI(input as OpenAIRequestBody);
      default:
        return input;
    }
  }

  // ============================================================
  // Anthropic 格式处理
  // ============================================================
  private processAnthropic(body: AnthropicRequestBody): AnthropicRequestBody {
    const systemPrompt = body.system;
    let messages = this.normalizeAnthropicMessages(body.messages || []);

    messages = this.applyTransformations(messages);
    messages = this.enforceTokenBudget(messages);

    const result: AnthropicRequestBody = {
      ...body,
      messages: this.denormalizeToAnthropic(messages),
    };

    if (this.config.preserveSystemPrompt) {
      result.system = systemPrompt;
    }

    this.logStats('Anthropic', body.messages?.length || 0, messages.length);
    return result;
  }

  // ============================================================
  // Responses API 格式处理
  // ============================================================
  private processResponses(body: Record<string, unknown>): Record<string, unknown> {
    const input = (body.input as ResponsesItem[]) || [];

    const systemItems = input.filter(
      (m) => m.type === 'system' || m.role === 'system'
    );
    const reasoningItems = this.config.preserveReasoning
      ? input.filter((m) => m.type === 'reasoning')
      : [];
    const conversationItems = input.filter(
      (m) =>
        m.type !== 'system' &&
        m.type !== 'reasoning' &&
        m.role !== 'system'
    );

    let messages = this.normalizeResponsesMessages(conversationItems);
    messages = this.applyTransformations(messages);
    messages = this.enforceTokenBudget(messages);

    const processedInput: ResponsesItem[] = [
      ...(this.config.preserveSystemPrompt ? systemItems : []),
      ...reasoningItems,
      ...this.denormalizeToResponses(messages),
    ];

    this.logStats('Responses', input.length, processedInput.length);

    return {
      ...body,
      input: processedInput,
    };
  }

  // ============================================================
  // OpenAI 格式处理
  // ============================================================
  private processOpenAI(body: OpenAIRequestBody): OpenAIRequestBody {
    const messages = body.messages || [];
    const systemMessages = messages.filter((m) => m.role === 'system');
    const conversationMessages = messages.filter((m) => m.role !== 'system');

    let normalized = this.normalizeOpenAIMessages(conversationMessages);
    normalized = this.applyTransformations(normalized);
    normalized = this.enforceTokenBudget(normalized);

    const result: OpenAIRequestBody = {
      ...body,
      messages: [
        ...(this.config.preserveSystemPrompt ? systemMessages : []),
        ...this.denormalizeToOpenAI(normalized),
      ],
    };

    this.logStats('OpenAI', messages.length, result.messages.length);
    return result;
  }

  // ============================================================
  // 通用转换管道
  // ============================================================
  private applyTransformations(messages: NormalizedMessage[]): NormalizedMessage[] {
    let result = messages;

    if (this.config.truncateToolOutput) {
      result = this.compressToolOutputs(result);
    }

    if (this.config.simplifySuccessOutputs) {
      result = this.simplifySuccessOutputs(result);
    }

    return result;
  }

  // ============================================================
  // Tool Output 压缩（Phase 3: 动态阈值）
  // ============================================================
  private compressToolOutputs(
    messages: NormalizedMessage[]
  ): NormalizedMessage[] {
    const baseMax = this.config.maxToolOutputChars;
    if (baseMax <= 0) return messages;

    // Phase 3: 根据当前 token 使用率动态调整压缩阈值
    let max = baseMax;
    const totalEstimate = this.estimateTokens(messages);
    const budgetRatio = totalEstimate / this.config.budget.maxInputTokens;
    if (budgetRatio > 0.8) {
      // 预算使用率 > 80%，进一步压缩
      max = Math.max(500, Math.floor(baseMax * (1 - (budgetRatio - 0.8) * 5)));
    }

    return messages.map((m) => {
      if (m.role !== 'tool' || !m.content || m.content.length <= max) return m;

      const originalLen = m.content.length;
      const headLen = Math.floor(max * 0.6);
      const tailLen = Math.floor(max * 0.3);
      const head = m.content.slice(0, headLen);
      const tail = m.content.slice(-tailLen);
      const truncated = originalLen - headLen - tailLen;

      m.content = `${head}\n\n... [${truncated} chars truncated] ...\n\n${tail}`;
      m.metadata.truncated = true;
      m.metadata.originalLength = originalLen;
      return m;
    });
  }

  // ============================================================
  // 成功输出简化
  // ============================================================
  private simplifySuccessOutputs(
    messages: NormalizedMessage[]
  ): NormalizedMessage[] {
    return messages.map((m) => {
      if (m.role !== 'tool' || !m.content) return m;
      // 已经被截断或简化过的不再处理，避免叠加副作用
      if (m.metadata.truncated || m.metadata.simplified) return m;

      const originalContent = m.content;

      // 检测成功的进程退出
      if (
        originalContent.includes('Process exited with code 0') &&
        originalContent.length < 300
      ) {
        const chunk = originalContent.match(/Chunk ID: (\w+)/)?.[1] || '';
        const time = originalContent.match(/Wall time: ([\d.]+)s/)?.[1] || '';
        const exitCode = originalContent.match(/exit code: (\d+)/)?.[1] || '0';

        m.content = `✓ Success (exit code: ${exitCode})${
          chunk ? `, chunk: ${chunk}` : ''
        }${time ? `, ${time}s` : ''}`;
        m.metadata.simplified = true;
        return m;
      }

      // 检测空输出或极短输出
      if (originalContent.trim().length < 10 && originalContent.length > 0) {
        m.content = `✓ Empty output (${originalContent.trim().length} chars)`;
        m.metadata.simplified = true;
      }

      return m;
    });
  }

  // ============================================================
  // Token 预算控制（Phase 1: 智能 Round 裁剪）
  // ============================================================
  private enforceTokenBudget(
    messages: NormalizedMessage[]
  ): NormalizedMessage[] {
    const maxInputTokens = this.config.budget.maxInputTokens;
    if (maxInputTokens <= 0) return messages;

    const estimated = this.estimateTokens(messages);
    if (estimated <= maxInputTokens) return messages;

    const system = messages.filter((m) => m.role === 'system');
    const rest = messages.filter((m) => m.role !== 'system');

    // 按轮次（user 消息为边界）从后往前保留，避免拆散 tool_use/tool_result 对
    const rounds: NormalizedMessage[][] = [];
    let currentRound: NormalizedMessage[] = [];
    for (const msg of rest) {
      if (msg.role === 'user' && currentRound.length > 0) {
        rounds.push(currentRound);
        currentRound = [];
      }
      currentRound.push(msg);
    }
    if (currentRound.length > 0) rounds.push(currentRound);

    const keptRounds: NormalizedMessage[][] = [];
    let tokens = 0;
    const maxRounds = this.config.keepRecentRounds;

    for (let i = rounds.length - 1; i >= 0; i--) {
      if (keptRounds.length >= maxRounds) break;

      const round = rounds[i];
      const roundTokens = round.reduce((s, m) => s + this.estimateMessageTokens(m), 0);

      // Phase 1: 如果整轮超预算，不再丢弃整轮，而是保留 user 消息和 assistant 原文
      // 只裁剪 tool output，确保用户输入永远不会丢失
      if (tokens + roundTokens > maxInputTokens) {
        // 只保留当前轮（最新轮），裁剪其中的 tool output
        const trimmedRound = this.trimRoundToBudget(round, maxInputTokens - tokens);
        if (trimmedRound.length > 0) {
          keptRounds.unshift(trimmedRound);
        }
        break; // 最新轮已处理，不再继续往前找
      }

      keptRounds.unshift(round);
      tokens += roundTokens;
    }

    const kept = keptRounds.flat();
    const result = [...system, ...kept];
    const finalTokens = this.estimateTokens(result);

    if (this.config.debugLog) {
      console.log(
        `[ContextManager] Truncated: ${messages.length} → ${result.length} messages, ` +
          `~${estimated} → ~${finalTokens} tokens`
      );
    }

    return result;
  }

  /**
   * Phase 1: 裁剪单个 round 到预算内
   * 规则：
   * 1. user 消息必须保留（不可裁剪）
   * 2. assistant 原文（含 reasoning）必须保留
   * 3. tool output 可以裁剪（>1000 字符时保留头尾）
   */
  private trimRoundToBudget(
    round: NormalizedMessage[],
    budgetTokens: number
  ): NormalizedMessage[] {
    const result: NormalizedMessage[] = [];

    for (const msg of round) {
      if (msg.role === 'user') {
        // 用户消息必须保留
        result.push(msg);
      } else if (msg.role === 'assistant') {
        // assistant 原文（含 reasoning）必须保留
        result.push(msg);
      } else if (msg.role === 'tool') {
        // tool output 可以裁剪
        const msgTokens = this.estimateMessageTokens(msg);
        const currentTokens = result.reduce((s, m) => s + this.estimateMessageTokens(m), 0);

        if (currentTokens + msgTokens <= budgetTokens) {
          // 不超预算，保留完整
          result.push(msg);
        } else {
          // 超预算，裁剪到剩余预算内
          const remainingTokens = Math.max(0, budgetTokens - currentTokens);
          const remainingChars = remainingTokens * 4; // 4 chars ≈ 1 token

          if (remainingChars > 100 && msg.content.length > remainingChars) {
            // 有足够空间保留头尾片段
            const headLen = Math.floor(remainingChars * 0.6);
            const tailLen = Math.floor(remainingChars * 0.3);
            const head = msg.content.slice(0, headLen);
            const tail = msg.content.slice(-tailLen);
            const truncated = msg.content.length - headLen - tailLen;

            result.push({
              ...msg,
              content: `${head}\n\n... [${truncated} chars truncated due to budget] ...\n\n${tail}`,
              metadata: { ...msg.metadata, truncated: true, budgetTrimmed: true },
            });
          } else if (remainingChars > 50) {
            // 空间很小，只保留头部
            result.push({
              ...msg,
              content: msg.content.slice(0, remainingChars) + '... [truncated due to budget]',
              metadata: { ...msg.metadata, truncated: true, budgetTrimmed: true },
            });
          }
          // 如果剩余空间 < 50 字符，直接丢弃这条 tool 消息
        }
      }
    }

    return result;
  }

  // ============================================================
  // Token 估算
  // ============================================================
  private estimateTokens(messages: NormalizedMessage[]): number {
    return messages.reduce((sum, m) => sum + this.estimateMessageTokens(m), 0);
  }

  private estimateMessageTokens(m: NormalizedMessage): number {
    let chars = m.content?.length || 0;

    if (m.toolCalls) {
      for (const tc of m.toolCalls) {
        chars += tc.name.length + (tc.arguments?.length || 0) + 20;
      }
    }

    if (m.reasoning) {
      chars += m.reasoning.length;
    }

    // 粗略估算：4 chars ≈ 1 token
    return Math.ceil(chars / 4);
  }

  // ============================================================
  // 格式规范化
  // ============================================================
  private normalizeAnthropicMessages(
    messages: AnthropicMessage[]
  ): NormalizedMessage[] {
    return messages.map((m) => {
      const normalized: NormalizedMessage = {
        role: m.role as 'user' | 'assistant',
        content: '',
        metadata: { originalRole: m.role },
      };

      if (typeof m.content === 'string') {
        normalized.content = m.content;
      } else if (Array.isArray(m.content)) {
        const textParts: string[] = [];
        for (const block of m.content) {
          if (block.type === 'text') {
            textParts.push(block.text);
          } else if (block.type === 'tool_use' && m.role === 'assistant') {
            if (!normalized.toolCalls) normalized.toolCalls = [];
            normalized.toolCalls.push({
              id: block.id,
              name: block.name,
              arguments: JSON.stringify(block.input || {}),
            });
          } else if (block.type === 'tool_result') {
            normalized.role = 'tool';
            normalized.toolCallId = block.tool_use_id;
            normalized.content =
              typeof block.content === 'string'
                ? block.content
                : this.extractTextContent(block.content);
          }
        }
        if (!normalized.toolCallId) {
          normalized.content = textParts.join('');
        }
      }

      return normalized;
    });
  }

  private normalizeResponsesMessages(
    items: ResponsesItem[]
  ): NormalizedMessage[] {
    const messages: NormalizedMessage[] = [];

    for (const item of items) {
      switch (item.type) {
        case 'message':
          messages.push({
            role: (item.role as 'user' | 'assistant') || 'user',
            content: this.extractTextContent(item.content),
            metadata: { originalType: 'message' },
          });
          break;

        case 'function_call':
          messages.push({
            role: 'assistant',
            content: '',
            toolCalls: [
              {
                id: item.call_id || '',
                name: item.name || '',
                arguments: item.arguments || '{}',
              },
            ],
            metadata: { originalType: 'function_call' },
          });
          break;

        case 'function_call_output':
          messages.push({
            role: 'tool',
            content: item.output || '',
            toolCallId: item.call_id,
            metadata: { originalType: 'function_call_output' },
          });
          break;

        case 'text': {
          // Defensive: handle non-standard type: 'text' items from sendPrompt
          messages.push({
            role: 'user',
            content: (item as any).text || '',
            metadata: { originalType: 'text' },
          });
          break;
        }

        default:
          if (item.role) {
            messages.push({
              role: item.role as NormalizedMessage['role'],
              content: this.extractTextContent(item.content) || '',
              metadata: { originalType: item.type },
            });
          } else {
            // Silently skip items we can't normalize (with role and no recognized type)
          }
          break;
      }
    }

    return messages;
  }

  private normalizeOpenAIMessages(
    messages: OpenAIMessage[]
  ): NormalizedMessage[] {
    return messages.map((m) => ({
      role: m.role,
      content: typeof m.content === 'string' ? m.content : '',
      toolCalls: m.tool_calls?.map((tc) => ({
        id: tc.id,
        name: tc.function.name,
        arguments: tc.function.arguments,
      })),
      toolCallId: m.tool_call_id,
      metadata: { originalRole: m.role },
    }));
  }

  // ============================================================
  // 格式还原
  // ============================================================
  private denormalizeToAnthropic(
    messages: NormalizedMessage[]
  ): AnthropicMessage[] {
    return messages.map((m) => {
      const content: AnthropicContentBlock[] = [];

      // Tool result → user message with tool_result block
      if (m.role === 'tool' && m.toolCallId) {
        content.push({
          type: 'tool_result',
          tool_use_id: m.toolCallId,
          content: m.content || '',
        });
        return {
          role: 'user',
          content: content,
        };
      }

      if (m.content) {
        content.push({ type: 'text', text: m.content });
      }

      if (m.toolCalls) {
        for (const tc of m.toolCalls) {
          content.push({
            type: 'tool_use',
            id: tc.id,
            name: tc.name,
            input: this.safeParseJSON(tc.arguments),
          });
        }
      }

      return {
        role: m.role as 'user' | 'assistant',
        content: content.length > 0 ? content : [{ type: 'text', text: '' }],
      };
    });
  }

  private denormalizeToResponses(
    messages: NormalizedMessage[]
  ): ResponsesItem[] {
    const items: ResponsesItem[] = [];

    for (const m of messages) {
      if (m.role === 'tool' && m.toolCallId) {
        items.push({
          type: 'function_call_output',
          call_id: m.toolCallId,
          output: m.content,
        });
      } else if (m.toolCalls?.length) {
        for (const tc of m.toolCalls) {
          items.push({
            type: 'function_call',
            call_id: tc.id,
            name: tc.name,
            arguments: tc.arguments,
          });
        }
      } else if (m.content || m.role) {
        items.push({
          type: 'message',
          role: m.role,
          content: [
            {
              type: 'input_text',
              text: m.content || '',
            },
          ],
        });
      }
    }

    return items;
  }

  private denormalizeToOpenAI(
    messages: NormalizedMessage[]
  ): OpenAIMessage[] {
    return messages.map((m) => {
      const msg: OpenAIMessage = {
        role: m.role,
        content: m.content || null,
      };

      if (m.toolCalls) {
        msg.tool_calls = m.toolCalls.map((tc) => ({
          id: tc.id,
          type: 'function',
          function: { name: tc.name, arguments: tc.arguments },
        }));
      }

      if (m.toolCallId) {
        msg.tool_call_id = m.toolCallId;
      }

      return msg;
    });
  }

  // ============================================================
  // 工具方法
  // ============================================================
  private extractTextContent(content: unknown): string {
    if (typeof content === 'string') return content;
    if (!content) return '';

    if (Array.isArray(content)) {
      return content
        .filter((b: any) => b?.type === 'text' && b?.text)
        .map((b: any) => b.text)
        .join('');
    }

    if (typeof content === 'object' && content !== null) {
      return JSON.stringify(content);
    }

    return String(content);
  }

  private safeParseJSON(str: string): Record<string, unknown> {
    try {
      return JSON.parse(str);
    } catch {
      return {};
    }
  }

  private logStats(
    backend: string,
    inputCount: number,
    outputCount: number
  ): void {
    if (this.config.debugLog && inputCount !== outputCount) {
      console.log(
        `[ContextManager][${backend}] Items: ${inputCount} → ${outputCount} ` +
          `(${inputCount - outputCount} removed)`
      );
    }
  }
}

// ================================================================
// 工厂函数
// ================================================================

export function createContextManager(
  backend: BackendType,
  config?: Partial<ContextConfig>
): ContextManager {
  return new ContextManager({ backend, ...config });
}

// ================================================================
// 默认预算配置
// ================================================================

export const defaultBudgets: Record<BackendType, ContextBudget> = {
  anthropic: {
    maxTokens: 64000,
    reservedForResponse: 8000,
    maxInputTokens: 48000,
  },
  responses: {
    maxTokens: 64000,
    reservedForResponse: 8000,
    maxInputTokens: 48000,
  },
  openai: {
    maxTokens: 48000,
    reservedForResponse: 8000,
    maxInputTokens: 32000,
  },
};
