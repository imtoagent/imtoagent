// ================================================================
// Claude Agent SDK Adapter — 实现 SDK AgentAdapter 接口
// ================================================================
// 职责：对接 Claude Agent SDK，将 AgentInput 转换为 AgentOutput
// 不负责：session 管理、统计、格式化、错误处理（由 SDK Runtime 接管）
// ================================================================

import { query } from '@anthropic-ai/claude-agent-sdk';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { AgentAdapter, AgentInput, AgentOutput, Session } from '../core/types';
import { buildAttachmentHint } from '../core/types';
import type { ParsedToolCall, AgentToolSupport } from './agent-loop';
import type { ToolRegistry } from './tool-registry';
import { injectContextMemory, incrementTurnCount, checkAndRotate } from '../core/rotation';


// ================================================================
// ClaudeAdapter 上下文
// ================================================================

export interface ClaudeAdapterContext {
  imModule?: { getCapabilities(): IMCapabilities } | null;
  botName: string;
  modelAliases: Record<string, string>;
  workspacePath: string;
}

// ================================================================
// 工具函数
// ================================================================

function resolveAlias(modelSpec: string): string {
  const i = modelSpec.indexOf('/');
  return i >= 0 ? modelSpec.slice(i + 1) : modelSpec;
}

function extractText(msg: SDKMessage): string | null {
  if (msg.type !== 'assistant') return null;
  const msgRec = msg as Record<string, unknown>;
  const content = (msgRec.message as Record<string, unknown>)?.content;
  if (!Array.isArray(content)) return null;
  return (content as Array<Record<string, unknown>>).filter((b) => b.type === 'text').map((b) => b.text as string).join('') || null;
}

function extractToolCalls(msg: SDKMessage): Array<{ name: string; summary: string }> {
  if (msg.type !== 'assistant') return [];
  const msgRec = msg as Record<string, unknown>;
  const content = (msgRec.message as Record<string, unknown>)?.content;
  if (!Array.isArray(content)) return [];
  const results: Array<{ name: string; summary: string }> = [];
  for (const block of content) {
    if (block.type === 'tool_use' && block.name) {
      const input = block.input || {};
      let summary = '';
      if (['Read', 'Edit', 'Write'].includes(block.name) && input.file_path) {
        const p = String(input.file_path);
        summary = p.includes('/') ? p.split('/').pop()! : p;
      } else if (block.name === 'Bash' && input.command) {
        summary = String(input.command).trim().slice(0, 60);
      }
      results.push({ name: block.name, summary });
    }
  }
  return results;
}

// ================================================================
// ClaudeAdapter — 实现 AgentAdapter
// ================================================================

export class ClaudeAdapter implements AgentAdapter {
  readonly name = 'Claude Agent SDK';
  private ctx: ClaudeAdapterContext;
  private activeControllers: AbortController[] = [];
  /** 单次调用最大超时（毫秒），0 = 不限制 */
  static MAX_CALL_TIMEOUT_MS = 15 * 60 * 1000; // 15 分钟

  constructor(ctx: ClaudeAdapterContext) {
    this.ctx = ctx;
  }

  /**
   * 清理所有活跃的子进程和请求。
   * 在 gracefulShutdown 时由 index.ts 调用。
   */
  cleanup(): void {
    const count = this.activeControllers.length;
    if (count > 0) {
      console.log(`[ClaudeAdapter] cleanup: aborting ${count} active request(s)`);
      for (const ctrl of this.activeControllers) {
        try { ctrl.abort(); } catch {}
      }
      this.activeControllers = [];
    }
  }

  /**
   * 处理单条用户消息
   * 
   * 接收 AgentInput，调用 Claude SDK，返回 AgentOutput
   * Session 管理、统计、格式化由 SDK Runtime 负责
   */
  async handleMessage(input: AgentInput): Promise<AgentOutput> {
    const { text, session, workingDir, model, systemPrompt: overrideSystemPrompt } = input;
    const sessionAny = session as any; // 向后兼容：访问旧字段

    // 进度回调
    const onProgress = async (t: string) => { try { await input.sendProgress?.(t); } catch {} };
    let turnCount = 0;

    // 创建 AbortController 并注册（用于超时 + shutdown 清理）
    const abortCtrl = new AbortController();
    this.activeControllers.push(abortCtrl);

    // 确定模型名
    const modelName = model.includes('/') ? model.slice(model.indexOf('/') + 1) : model;
    const aliases = this.ctx.modelAliases;

    // 附件信息注入：让 Agent 知道用户发送了附件（图片/文件/语音）及本地路径
    let effectiveText = text;
    if (input.attachments && input.attachments.length > 0) {
      effectiveText = buildAttachmentHint(input.attachments) + '\n\n---\n\n' + effectiveText;
    }

    // Inject context memory
    effectiveText = injectContextMemory(session, turnCount, effectiveText);
    incrementTurnCount(sessionAny);

    // Claude SDK 环境变量（走本地 :18899 代理）
    const customEnv: Record<string, string> = {
      ...process.env,
      ANTHROPIC_BASE_URL: 'http://localhost:18899',
      ANTHROPIC_API_KEY: '',
      ANTHROPIC_AUTH_TOKEN: '',
      ANTHROPIC_MODEL: '',
      ANTHROPIC_DEFAULT_SONNET_MODEL: resolveAlias(aliases.sonnet || ''),
      ANTHROPIC_DEFAULT_OPUS_MODEL: resolveAlias(aliases.opus || ''),
      ANTHROPIC_DEFAULT_HAIKU_MODEL: resolveAlias(aliases.haiku || ''),
    };

    // 构建查询选项
    const queryOptions: Record<string, unknown> = {
      cwd: workingDir,
      maxTurns: 50,
      model: modelName,
      permissionMode: sessionAny.permissionMode || 'bypassPermissions',
      persistSession: true,
      abortController: abortCtrl,
    };

    // 超时保护：防止 Claude CLI 子进程无限运行
    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    if (ClaudeAdapter.MAX_CALL_TIMEOUT_MS > 0) {
      timeoutId = setTimeout(() => {
        console.log(`[ClaudeAdapter] ⏰ Timeout (${ClaudeAdapter.MAX_CALL_TIMEOUT_MS / 1000}s), aborting request`);
        abortCtrl.abort();
      }, ClaudeAdapter.MAX_CALL_TIMEOUT_MS);
    }

    // System Prompt（统一由 index.ts 注入，adapter 不再 fallback 自建）
    if (overrideSystemPrompt) {
      queryOptions.systemPrompt = overrideSystemPrompt;
    }

    // Thread Rotation
    const sessionAny2 = session as Record<string, unknown>;
    checkAndRotate(session, sessionAny2, "sdkSessionId", { maxTurns: 10 });
    const _turnCount = (sessionAny2._turnCount as number) ?? 0;

    // 恢复/创建 SDK 会话 ID
    const shouldClear = session.startFresh;
    session.startFresh = false;
    const sdkSessionId = shouldClear ? undefined : (session.metadata?.sdkSessionId || sessionAny.sdkSessionId);
    if (sdkSessionId) {
      queryOptions.resume = sdkSessionId;
      console.log(`[ClaudeAdapter] resuming sdkSessionId=${sdkSessionId}`);
    } else {
      const newId = crypto.randomUUID();
      queryOptions.sessionId = newId;
      // 立即写入 metadata，避免流中丢失
      session.metadata.sdkSessionId = newId;
      sessionAny.sdkSessionId = newId;
      console.log(`[ClaudeAdapter] new sessionId=${newId}`);
    }

    console.log(`[ClaudeAdapter] query model=${modelName} cwd=${workingDir} resume=${!!sdkSessionId}`);

    try {
    // 执行 Claude SDK 查询（流式）
    const q = query({
      prompt: [{
        type: 'user',
        message: { role: 'user', content: [{ type: 'text', text: effectiveText }] },
      }],
      options: queryOptions,
      env: customEnv,
    });

    let fullResponse = '';
    const toolCalls: Array<{ name: string; summary: string }> = [];

    for await (const msg of q) {
      const msgRec = msg as Record<string, unknown>;

      // 捕获 SDK session ID（存入 metadata 供 SDK Runtime 持久化）
      if (msgRec.session_id && !session.metadata?.sdkSessionId) {
        session.metadata.sdkSessionId = msgRec.session_id as string;
        // 向后兼容：也写回旧字段
        sessionAny.sdkSessionId = msgAny.session_id;
      }

      // 提取文本
      const extractedText = extractText(msg);
      if (extractedText) fullResponse += extractedText;

      // 提取工具调用
      const calls = extractToolCalls(msg);
      toolCalls.push(...calls);

      // 进度输出（仅 assistant 消息）
      if (msg.type === 'assistant') {
        turnCount++;
        if (calls.length > 0) {
          const names = calls.map(c => c.name).join(', ');
          const summary = calls[0].summary.slice(0, 60);
          onProgress(`🔧 Executing: ${names} — ${summary}`);
        }
      }

      // 处理最终结果
      if (msg.type === 'result') {
        const result = msgAny;

        if (result.subtype === 'error' || result.subtype === 'cancelled') {
          throw new Error(result.error || result.result || 'Unknown error');
        }

        const usage = {
          inputTokens: result.usage?.input_tokens || 0,
          outputTokens: result.usage?.output_tokens || 0,
          costUSD: result.total_cost_usd || 0,
          durationMs: result.duration_ms || 0,
          numTurns: result.num_turns || 0,
        };

        if (timeoutId) clearTimeout(timeoutId);
        if (turnCount > 0) onProgress(`✅ Turn ${turnCount} completed`);
        const responseText = fullResponse || `✅ Completed (${toolCalls.length} steps)`;

        return {
          text: responseText,
          toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
          usage,
        };
      }
    }

    // 流结束但没有 result 消息
    return {
      text: fullResponse || '✅ Done',
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
    };

    } catch (err: unknown) {
      if (timeoutId) clearTimeout(timeoutId);
      // 如果是被 abort（超时或手动清理），提供有意义的消息
      if (abortCtrl.signal.aborted) {
        console.log(`[ClaudeAdapter] Request aborted (${err.message || 'aborted'})`);
        return {
          text: '⚠️ Request timed out or cancelled, please try again.',
        };
      }
      throw err;
    } finally {
      // 清理当前 AbortController
      const idx = this.activeControllers.indexOf(abortCtrl);
      if (idx >= 0) this.activeControllers.splice(idx, 1);
      if (timeoutId) clearTimeout(timeoutId);
    }
  }

  // Tool support for AgentLoop — 从 Claude SDK 响应中提取 tool_use 并注入 tool_result。
  // Claude SDK 使用 Anthropic 原生格式：tool_use 和 tool_result 内容块。
  // 这个方法给 AgentLoop 用，只关心本地工具（imtoagent_ 和 goal_ 前缀、get_weather）。
  getToolSupport(): AgentToolSupport | null {
    return {
      extractToolCalls: (output: AgentOutput, registry: ToolRegistry): ParsedToolCall[] => {
        if (!output.text) return [];
        const calls: ParsedToolCall[] = [];
        const jsonRe = /\{\s*"name"\s*:\s*"([^"]+)"\s*,\s*"input"\s*:\s*(\{[\s\S]*?\})\s*\}/g;
        let m: RegExpExecArray | null;
        while ((m = jsonRe.exec(output.text)) !== null) {
          const name = m[1];
          if (!registry.isRegistered(name)) continue;
          try {
            calls.push({ name, args: JSON.parse(m[2]) });
          } catch {}
        }
        // 也检查 output.toolCalls（adapter 内部提取过的）
        // 但那里只有 summary，没有 args，这里不重复
        return calls;
      },
      appendToolResults: (input: AgentInput, toolCalls: ParsedToolCall[], results: string[]): AgentInput => {
        // Anthropic 格式：追加 user 消息，内容是 tool_result 块
        let toolResults = '\n\n<tool_results>\n';
        for (let i = 0; i < toolCalls.length; i++) {
          toolResults += `[Tool: ${toolCalls[i].name}]\nResult: ${results[i]}\n\n`;
        }
        toolResults += '</tool_results>\n\nPlease continue with the above tool results.';
        return {
          ...input,
          text: input.text + toolResults,
          session: { ...input.session, startFresh: false },
        };
      },
    };
  }
}
