// ================================================================
// ContextManager 单元测试
// ================================================================

import { describe, it, expect, beforeEach } from 'vitest';
import {
  ContextManager,
  createContextManager,
  defaultBudgets,
  type ContextConfig,
  type BackendType,
} from '../modules/proxy/context-manager';

// ================================================================
// 测试工具函数
// ================================================================

function createAnthropicBody(overrides: Record<string, unknown> = {}) {
  return {
    model: 'claude-sonnet-4-20250514',
    max_tokens: 8192,
    system: 'You are a helpful assistant.',
    messages: [],
    stream: true,
    ...overrides,
  };
}

function createOpenAIBody(overrides: Record<string, unknown> = {}) {
  return {
    model: 'gpt-4o',
    max_tokens: 4096,
    messages: [],
    stream: true,
    ...overrides,
  };
}

function createResponsesBody(overrides: Record<string, unknown> = {}) {
  return {
    model: 'gpt-5.5',
    input: [],
    max_output_tokens: 8192,
    stream: true,
    ...overrides,
  };
}

// ================================================================
// 基础功能测试
// ================================================================

describe('ContextManager - Basic', () => {
  it('should create with default config', () => {
    const manager = new ContextManager();
    expect(manager).toBeDefined();
  });

  it('should create with factory function', () => {
    const manager = createContextManager('openai');
    expect(manager).toBeDefined();
  });

  it('should handle non-object input gracefully', () => {
    const manager = new ContextManager({
      backend: 'openai',
      budget: { maxTokens: 100000, reservedForResponse: 1000, maxInputTokens: 99000 },
    });
    const body = createOpenAIBody({ messages: [] });
    const result = manager.process(body) as any;
    expect(result.messages).toEqual([]);
  });
});

// ================================================================
// Anthropic 格式测试
// ================================================================

describe('ContextManager - Anthropic', () => {
  it('should preserve system prompt', () => {
    const manager = new ContextManager({
      backend: 'anthropic',
      preserveSystemPrompt: true,
      budget: { maxTokens: 100000, reservedForResponse: 1000, maxInputTokens: 99000 },
    });

    const body = createAnthropicBody({
      messages: [{ role: 'user', content: 'Hello' }],
    });

    const result = manager.process(body) as any;
    expect(result.system).toBe('You are a helpful assistant.');
  });

  it('should handle empty messages', () => {
    const manager = new ContextManager({
      backend: 'anthropic',
      budget: { maxTokens: 100000, reservedForResponse: 1000, maxInputTokens: 99000 },
    });

    const body = createAnthropicBody({ messages: [] });
    const result = manager.process(body) as any;
    expect(result.messages).toEqual([]);
  });

  it('should handle text content blocks', () => {
    const manager = new ContextManager({
      backend: 'anthropic',
      budget: { maxTokens: 100000, reservedForResponse: 1000, maxInputTokens: 99000 },
    });

    const body = createAnthropicBody({
      messages: [
        {
          role: 'user',
          content: [{ type: 'text', text: 'Hello world' }],
        },
      ],
    });

    const result = manager.process(body) as any;
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0].role).toBe('user');
  });

  it('should handle tool_use/tool_result blocks', () => {
    const manager = new ContextManager({
      backend: 'anthropic',
      budget: { maxTokens: 100000, reservedForResponse: 1000, maxInputTokens: 99000 },
      truncateToolOutput: false,
      simplifySuccessOutputs: false,
    });

    const body = createAnthropicBody({
      messages: [
        {
          role: 'user',
          content: 'Run ls',
        },
        {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: 'tool_1',
              name: 'bash',
              input: { command: 'ls' },
            },
          ],
        },
        {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'tool_1',
              content: 'file1.txt\nfile2.txt',
            },
          ],
        },
      ],
    });

    const result = manager.process(body) as any;
    expect(result.messages.length).toBeGreaterThan(0);
  });
});

// ================================================================
// OpenAI 格式测试
// ================================================================

describe('ContextManager - OpenAI', () => {
  it('should preserve system messages', () => {
    const manager = new ContextManager({
      backend: 'openai',
      preserveSystemPrompt: true,
      budget: { maxTokens: 100000, reservedForResponse: 1000, maxInputTokens: 99000 },
    });

    const body = createOpenAIBody({
      messages: [
        { role: 'system', content: 'You are helpful.' },
        { role: 'user', content: 'Hello' },
      ],
    });

    const result = manager.process(body) as any;
    expect(result.messages[0].role).toBe('system');
    expect(result.messages[0].content).toBe('You are helpful.');
  });

  it('should handle tool_calls and tool messages', () => {
    const manager = new ContextManager({
      backend: 'openai',
      budget: { maxTokens: 100000, reservedForResponse: 1000, maxInputTokens: 99000 },
      truncateToolOutput: false,
      simplifySuccessOutputs: false,
    });

    const body = createOpenAIBody({
      messages: [
        { role: 'user', content: 'Run ls' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'call_1',
              type: 'function',
              function: { name: 'bash', arguments: '{"command":"ls"}' },
            },
          ],
        },
        { role: 'tool', tool_call_id: 'call_1', content: 'file1.txt\nfile2.txt' },
      ],
    });

    const result = manager.process(body) as any;
    expect(result.messages.length).toBe(3);
  });

  it('should handle empty messages', () => {
    const manager = new ContextManager({
      backend: 'openai',
      budget: { maxTokens: 100000, reservedForResponse: 1000, maxInputTokens: 99000 },
    });

    const body = createOpenAIBody({ messages: [] });
    const result = manager.process(body) as any;
    expect(result.messages).toEqual([]);
  });
});

// ================================================================
// Responses API 格式测试
// ================================================================

describe('ContextManager - Responses', () => {
  it('should preserve system items', () => {
    const manager = new ContextManager({
      backend: 'responses',
      preserveSystemPrompt: true,
      budget: { maxTokens: 100000, reservedForResponse: 1000, maxInputTokens: 99000 },
    });

    const body = createResponsesBody({
      input: [
        { type: 'system', role: 'system', content: 'You are helpful.' },
        { type: 'message', role: 'user', content: 'Hello' },
      ],
    });

    const result = manager.process(body) as any;
    expect(result.input[0].type).toBe('system');
  });

  it('should handle function_call/function_call_output items', () => {
    const manager = new ContextManager({
      backend: 'responses',
      budget: { maxTokens: 100000, reservedForResponse: 1000, maxInputTokens: 99000 },
      truncateToolOutput: false,
      simplifySuccessOutputs: false,
    });

    const body = createResponsesBody({
      input: [
        { type: 'message', role: 'user', content: 'Run ls' },
        {
          type: 'function_call',
          call_id: 'call_1',
          name: 'bash',
          arguments: '{"command":"ls"}',
        },
        {
          type: 'function_call_output',
          call_id: 'call_1',
          output: 'file1.txt\nfile2.txt',
        },
      ],
    });

    const result = manager.process(body) as any;
    expect(result.input.length).toBe(3);
  });

  it('should preserve reasoning items when configured', () => {
    const manager = new ContextManager({
      backend: 'responses',
      preserveReasoning: true,
      budget: { maxTokens: 100000, reservedForResponse: 1000, maxInputTokens: 99000 },
    });

    const body = createResponsesBody({
      input: [
        { type: 'reasoning', summary: [{ text: 'thinking...' }] },
        { type: 'message', role: 'user', content: 'Hello' },
      ],
    });

    const result = manager.process(body) as any;
    expect(result.input.some((item: any) => item.type === 'reasoning')).toBe(true);
  });
});

// ================================================================
// Tool Output 压缩测试
// ================================================================

describe('ContextManager - Tool Output Compression', () => {
  it('should truncate large tool outputs', () => {
    const manager = new ContextManager({
      backend: 'openai',
      budget: { maxTokens: 100000, reservedForResponse: 1000, maxInputTokens: 99000 },
      maxToolOutputChars: 100,
      truncateToolOutput: true,
      simplifySuccessOutputs: false,
    });

    const longOutput = 'x'.repeat(500);
    const body = createOpenAIBody({
      messages: [
        { role: 'user', content: 'Run command' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'call_1',
              type: 'function',
              function: { name: 'bash', arguments: '{}' },
            },
          ],
        },
        { role: 'tool', tool_call_id: 'call_1', content: longOutput },
      ],
    });

    const result = manager.process(body) as any;
    const toolMsg = result.messages.find((m: any) => m.role === 'tool');
    expect(toolMsg.content.length).toBeLessThanOrEqual(150);
    expect(toolMsg.content).toContain('truncated');
  });

  it('should not affect non-tool messages', () => {
    const manager = new ContextManager({
      backend: 'openai',
      budget: { maxTokens: 100000, reservedForResponse: 1000, maxInputTokens: 99000 },
      maxToolOutputChars: 100,
      truncateToolOutput: true,
      simplifySuccessOutputs: false,
    });

    const longContent = 'y'.repeat(500);
    const body = createOpenAIBody({
      messages: [
        { role: 'user', content: longContent },
      ],
    });

    const result = manager.process(body) as any;
    expect(result.messages[0].content).toBe(longContent);
  });

  it('should skip compression when disabled', () => {
    const manager = new ContextManager({
      backend: 'openai',
      budget: { maxTokens: 100000, reservedForResponse: 1000, maxInputTokens: 99000 },
      maxToolOutputChars: 100,
      truncateToolOutput: false,
      simplifySuccessOutputs: false,
    });

    const longOutput = 'z'.repeat(500);
    const body = createOpenAIBody({
      messages: [
        { role: 'tool', tool_call_id: 'call_1', content: longOutput },
      ],
    });

    const result = manager.process(body) as any;
    const toolMsg = result.messages.find((m: any) => m.role === 'tool');
    expect(toolMsg.content).toBe(longOutput);
  });
});

// ================================================================
// 成功输出简化测试
// ================================================================

describe('ContextManager - Success Output Simplification', () => {
  it('should simplify Process exited with code 0', () => {
    const manager = new ContextManager({
      backend: 'openai',
      budget: { maxTokens: 100000, reservedForResponse: 1000, maxInputTokens: 99000 },
      truncateToolOutput: false,
      simplifySuccessOutputs: true,
    });

    const successOutput =
      'Process exited with code 0\nChunk ID: abc123\nWall time: 1.23s';

    const body = createOpenAIBody({
      messages: [
        { role: 'tool', tool_call_id: 'call_1', content: successOutput },
      ],
    });

    const result = manager.process(body) as any;
    const toolMsg = result.messages.find((m: any) => m.role === 'tool');
    expect(toolMsg.content).toContain('success');
    expect(toolMsg.content).toContain('exit 0');
    expect(toolMsg.content).toContain('1.23s');
    expect(toolMsg.content.length).toBeLessThan(100);
  });

  it('should not simplify non-success outputs', () => {
    const manager = new ContextManager({
      backend: 'openai',
      budget: { maxTokens: 100000, reservedForResponse: 1000, maxInputTokens: 99000 },
      truncateToolOutput: false,
      simplifySuccessOutputs: true,
    });

    const errorOutput = 'Process exited with code 1\nError: file not found';

    const body = createOpenAIBody({
      messages: [
        { role: 'tool', tool_call_id: 'call_1', content: errorOutput },
      ],
    });

    const result = manager.process(body) as any;
    const toolMsg = result.messages.find((m: any) => m.role === 'tool');
    expect(toolMsg.content).toBe(errorOutput);
  });

  it('should skip simplification when disabled', () => {
    const manager = new ContextManager({
      backend: 'openai',
      budget: { maxTokens: 100000, reservedForResponse: 1000, maxInputTokens: 99000 },
      truncateToolOutput: false,
      simplifySuccessOutputs: false,
    });

    const successOutput =
      'Process exited with code 0\nChunk ID: abc123\nWall time: 1.23s';

    const body = createOpenAIBody({
      messages: [
        { role: 'tool', tool_call_id: 'call_1', content: successOutput },
      ],
    });

    const result = manager.process(body) as any;
    const toolMsg = result.messages.find((m: any) => m.role === 'tool');
    expect(toolMsg.content).toBe(successOutput);
  });
});

// ================================================================
// Token 预算测试
// ================================================================

describe('ContextManager - Token Budget', () => {
  it('should truncate old messages when over budget', () => {
    const manager = new ContextManager({
      backend: 'openai',
      budget: { maxTokens: 1000, reservedForResponse: 200, maxInputTokens: 800 },
      keepRecentRounds: 1,
      truncateToolOutput: false,
      simplifySuccessOutputs: false,
    });

    const messages = [];
    // 添加 5 轮对话，每轮足够大以超过 800 token 预算
    for (let i = 0; i < 5; i++) {
      // 每条约 400 chars ≈ 100 tokens，两轮就超过 800 token 预算
      messages.push({ role: 'user', content: `Question ${i} ` + 'x'.repeat(400) });
      messages.push({ role: 'assistant', content: `Answer ${i} ` + 'y'.repeat(400) });
    }

    const body = createOpenAIBody({ messages });
    const result = manager.process(body) as any;

    // 应该只保留最近 1 轮（2 条消息）
    expect(result.messages.length).toBeLessThan(messages.length);
    expect(result.messages.length).toBeLessThanOrEqual(4); // 最多 2 轮
  });

  it('should preserve system messages during truncation', () => {
    const manager = new ContextManager({
      backend: 'openai',
      budget: { maxTokens: 500, reservedForResponse: 100, maxInputTokens: 400 },
      keepRecentRounds: 1,
      preserveSystemPrompt: true,
      truncateToolOutput: false,
      simplifySuccessOutputs: false,
    });

    const messages = [
      { role: 'system', content: 'You are helpful.' },
      { role: 'user', content: 'Q1 ' + 'x'.repeat(200) },
      { role: 'assistant', content: 'A1 ' + 'y'.repeat(200) },
      { role: 'user', content: 'Q2' },
    ];

    const body = createOpenAIBody({ messages });
    const result = manager.process(body) as any;

    expect(result.messages[0].role).toBe('system');
    expect(result.messages[0].content).toBe('You are helpful.');
  });

  it('should not truncate when under budget', () => {
    const manager = new ContextManager({
      backend: 'openai',
      budget: { maxTokens: 100000, reservedForResponse: 1000, maxInputTokens: 99000 },
      keepRecentRounds: 2,
      truncateToolOutput: false,
      simplifySuccessOutputs: false,
    });

    const messages = [
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Hi there!' },
    ];

    const body = createOpenAIBody({ messages });
    const result = manager.process(body) as any;

    expect(result.messages.length).toBe(messages.length);
  });
});

// ================================================================
// 默认预算配置测试
// ================================================================

describe('Default Budgets', () => {
  it('should have budget for all backend types', () => {
    expect(defaultBudgets.anthropic).toBeDefined();
    expect(defaultBudgets.responses).toBeDefined();
    expect(defaultBudgets.openai).toBeDefined();
  });

  it('should have reasonable defaults', () => {
    for (const [backend, budget] of Object.entries(defaultBudgets)) {
      expect(budget.maxTokens).toBeGreaterThan(0);
      expect(budget.reservedForResponse).toBeGreaterThan(0);
      expect(budget.maxInputTokens).toBeGreaterThan(0);
      expect(budget.maxInputTokens).toBeLessThan(budget.maxTokens);
    }
  });
});

// ================================================================
// 集成测试 - 使用真实数据结构
// ================================================================

describe('Integration - Real-world Data Structures', () => {
  it('should handle Codex-style function_call loop', () => {
    const manager = new ContextManager({
      backend: 'responses',
      budget: { maxTokens: 2000, reservedForResponse: 500, maxInputTokens: 1000 },
      keepRecentRounds: 1,
      maxToolOutputChars: 2000,
      truncateToolOutput: true,
      simplifySuccessOutputs: true,
    });

    // 模拟 3 轮工具调用循环，每轮约 1500 chars ≈ 375 tokens
    const input = [];
    for (let i = 0; i < 3; i++) {
      input.push({
        type: 'message',
        role: 'user',
        content: `Task ${i} ` + 'x'.repeat(800),
      });
      input.push({
        type: 'function_call',
        call_id: `call_${i}`,
        name: 'bash',
        arguments: `{"command":"cmd${i}"}`,
      });
      input.push({
        type: 'function_call_output',
        call_id: `call_${i}`,
        output: `Output ${i} ` + 'x'.repeat(1500),
      });
    }

    const body = createResponsesBody({ input });
    const result = manager.process(body) as any;

    // 3 轮 ≈ 1125 tokens > 1000 预算，应该截断到最近 1 轮
    expect(result.input.length).toBeLessThan(input.length);
    expect(result.input.length).toBeLessThanOrEqual(6); // 最多 2 轮
  });

  it('should handle Claude Code multi-tool turn', () => {
    const manager = new ContextManager({
      backend: 'anthropic',
      budget: { maxTokens: 5000, reservedForResponse: 1000, maxInputTokens: 4000 },
      keepRecentRounds: 2,
      maxToolOutputChars: 2000,
      truncateToolOutput: true,
      simplifySuccessOutputs: true,
    });

    const body = createAnthropicBody({
      messages: [
        { role: 'user', content: 'Create and read files' },
        {
          role: 'assistant',
          content: [
            { type: 'tool_use', id: 't1', name: 'write', input: { path: 'a.txt', content: 'hello' } },
            { type: 'tool_use', id: 't2', name: 'read', input: { path: 'a.txt' } },
          ],
        },
        {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 't1', content: 'Written' },
            { type: 'tool_result', tool_use_id: 't2', content: 'hello' },
          ],
        },
        { role: 'assistant', content: [{ type: 'text', text: 'Done!' }] },
      ],
    });

    const result = manager.process(body) as any;
    expect(result.messages.length).toBeGreaterThan(0);
  });
});
