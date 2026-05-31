// ================================================================
// Proxy 类型定义
// ================================================================
// 为 Anthropic Proxy 和 Codex Proxy 提供统一的类型，
// 减少 `any` 使用，提高请求/响应转换的类型安全。
// ================================================================

// ===== Content Blocks =====

export interface AnthropicTextBlock {
  type: 'text';
  text: string;
}

export interface AnthropicImageBlock {
  type: 'image';
  source: {
    type: 'base64' | 'url';
    media_type?: string;
    data?: string;
    url?: string;
  };
}

export interface AnthropicToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface AnthropicToolResultBlock {
  type: 'tool_result';
  tool_use_id: string;
  content?: string | AnthropicTextBlock[];
  is_error?: boolean;
}

export interface AnthropicThinkingBlock {
  type: 'thinking' | 'redacted_thinking';
  thinking?: string;
  signature?: string;
}

export type AnthropicContentBlock =
  | AnthropicTextBlock
  | AnthropicImageBlock
  | AnthropicToolUseBlock
  | AnthropicToolResultBlock
  | AnthropicThinkingBlock;

// ===== OpenAI Content Blocks =====

export interface OpenAIImageBlock {
  type: 'image_url';
  image_url: { url: string };
}

export type OpenAIContentBlock = AnthropicTextBlock | OpenAIImageBlock;

// ===== Messages =====

export interface AnthropicMessage {
  role: 'user' | 'assistant';
  content: string | AnthropicContentBlock[];
}

export interface OpenAIMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content?: string | OpenAIContentBlock[];
  tool_calls?: OpenAIToolCall[];
  tool_call_id?: string;
}

// ===== Tool Definitions =====

export interface AnthropicTool {
  name: string;
  description?: string;
  input_schema?: Record<string, unknown>;
  cache_control?: { type: string };
}

export interface OpenAITool {
  type: 'function';
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
    strict?: boolean;
  };
}

// ===== Tool Calls =====

export interface OpenAIToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

// ===== Request Bodies =====

export interface AnthropicRequestBody {
  model?: string;
  max_tokens?: number;
  system?: string | AnthropicContentBlock[];
  messages: AnthropicMessage[];
  tools?: AnthropicTool[];
  tool_choice?: { type: string; name?: string };
  temperature?: number;
  top_p?: number;
  top_k?: number;
  stop_sequences?: string[];
  stream?: boolean;
  thinking?: { type: string; budget_tokens?: number };
  [key: string]: unknown;
}

export interface OpenAIRequestBody {
  model?: string;
  max_tokens?: number;
  messages: OpenAIMessage[];
  tools?: OpenAITool[];
  tool_choice?: string | { type: string; function?: { name: string } };
  temperature?: number;
  top_p?: number;
  stop?: string | string[];
  stream?: boolean;
  stream_options?: { include_usage: boolean };
  [key: string]: unknown;
}

// ===== Response Bodies =====

export interface AnthropicResponseUsage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

export interface AnthropicStreamEvent {
  type: string;
  message?: {
    id?: string;
    model?: string;
    usage?: AnthropicResponseUsage;
  };
  index?: number;
  delta?: {
    type?: string;
    text?: string;
    thinking?: string;
    signature?: string;
    partial_json?: string;
    usage?: AnthropicResponseUsage;
  };
  usage?: AnthropicResponseUsage;
  content_block?: {
    type?: string;
    text?: string;
    id?: string;
    name?: string;
    input?: Record<string, unknown>;
  };
}

export interface OpenAIStreamChunk {
  id?: string;
  object?: string;
  created?: number;
  model?: string;
  choices: Array<{
    index: number;
    delta: {
      role?: string;
      content?: string;
      tool_calls?: Array<{
        index: number;
        id?: string;
        type?: string;
        function?: { name?: string; arguments?: string };
      }>;
    };
    finish_reason?: string | null;
  }>;
  usage?: AnthropicResponseUsage;
}

// ===== Tool Choice =====

export type AnthropicToolChoice =
  | { type: 'auto' }
  | { type: 'any' }
  | { type: 'tool'; name: string };
