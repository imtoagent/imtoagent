// ================================================================
// Tool Interceptor — 拦截上游 tool_calls，执行本地工具
// ================================================================
// 职责：
//   1. 从 LLM 响应中解析完整 tool_calls
//   2. 分类本地/远端工具
//   3. 并行执行本地工具
//   4. 返回完整 tool 结果消息（供 caller 注入 messages）
// ================================================================

import type { ToolRegistry } from '../agent/tool-registry';

export interface ParsedToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
  rawArgs: string;
}

export interface ToolExecutionResult {
  toolCallId: string;
  name: string;
  isLocal: boolean;
  content: string;
  success: boolean;
}

const TOOL_EXEC_TIMEOUT_MS = 30_000;

/**
 * 判断 tool name 是否为本地工具
 */
export function isLocalTool(name: string): boolean {
  return (
    name.startsWith('imtoagent_') ||
    name.startsWith('goal_') ||
    name === 'get_weather'
  );
}

/**
 * 检查工具定义列表中是否包含本地工具
 */
export function hasLocalTool(toolDefs: Array<{ function?: { name?: string } }> | undefined): boolean {
  if (!toolDefs || toolDefs.length === 0) return false;
  return toolDefs.some(t => isLocalTool(t.function?.name || ''));
}

/**
 * 从 OpenAI 格式 tool_calls 数组中解析出完整调用
 */
export function parseToolCalls(toolCalls: Array<{
  id?: string;
  type?: string;
  function?: { name: string; arguments: string };
}> | undefined): ParsedToolCall[] {
  if (!toolCalls || toolCalls.length === 0) return [];

  return toolCalls.map(tc => {
    let args: Record<string, unknown> = {};
    try {
      args = typeof tc.function?.arguments === 'string'
        ? JSON.parse(tc.function.arguments)
        : {};
    } catch {
      args = {};
    }
    return {
      id: tc.id || `call_${Date.now()}`,
      name: tc.function?.name || '',
      args,
      rawArgs: tc.function?.arguments || '{}',
    };
  });
}

/**
 * 并行执行本地工具调用
 */
export async function executeLocalTools(
  calls: ParsedToolCall[],
  toolRegistry: ToolRegistry,
): Promise<ToolExecutionResult[]> {
  return Promise.all(calls.map(async (call): Promise<ToolExecutionResult> => {
    console.log(`[ToolInterceptor] 🔧 executing: ${call.name}(${JSON.stringify(call.args).slice(0, 200)})`);

    try {
      const execPromise = toolRegistry.execute(call.name, call.args);
      const timeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('tool execution timeout')), TOOL_EXEC_TIMEOUT_MS),
      );
      const rawResult = await Promise.race([execPromise, timeoutPromise]);
      const result = typeof rawResult === 'string' ? rawResult : JSON.stringify(rawResult);
      console.log(`[ToolInterceptor] ✅ ${call.name} done (${result.length} chars)`);
      return { toolCallId: call.id, name: call.name, isLocal: true, content: result, success: true };
    } catch (e: unknown) {
      const errMsg = `Error executing ${call.name}: ${(e as Error).message}`;
      console.error(`[ToolInterceptor] ❌ ${call.name} failed → ${errMsg}`);
      return { toolCallId: call.id, name: call.name, isLocal: true, content: errMsg, success: false };
    }
  }));
}

/**
 * 为远端工具生成占位结果
 */
export function generateRemotePlaceholders(calls: ParsedToolCall[]): ToolExecutionResult[] {
  return calls.map(call => ({
    toolCallId: call.id,
    name: call.name,
    isLocal: false,
    content: `[Remote tool "${call.name}" managed by upstream runtime — no local action needed]`,
    success: true,
  }));
}

/**
 * 将执行结果转换为 OpenAI tool 消息格式
 */
export function buildToolMessages(results: ToolExecutionResult[]): Array<{
  role: 'tool';
  tool_call_id: string;
  content: string;
}> {
  return results.map(r => ({
    role: 'tool' as const,
    tool_call_id: r.toolCallId,
    content: r.content,
  }));
}
