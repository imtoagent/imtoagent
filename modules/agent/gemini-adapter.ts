// ================================================================
// Gemini CLI Adapter — implements AgentAdapter interface
// ================================================================
// 职责：对接 Gemini CLI (google/gemini-cli)，将 AgentInput 转换为 AgentOutput
// 不负责：session 管理、统计、格式化、错误处理（由 SDK Runtime 接管）
// ================================================================

import { spawn, ChildProcess } from 'child_process';
import type { AgentAdapter, AgentInput, AgentOutput } from '../core/types';
import { buildAttachmentHint } from '../core/types';
import type { ParsedToolCall, AgentToolSupport } from './agent-loop';
import type { ToolRegistry } from './tool-registry';


// ================================================================
// GeminiAdapter 上下文
// ================================================================

export interface GeminiAdapterContext {
  imModule?: { getCapabilities(): IMCapabilities } | null;
  botName: string;
  modelAliases: Record<string, string>;
}

// ================================================================
// 工具函数
// ================================================================

function resolveAlias(modelSpec: string): string {
  const i = modelSpec.indexOf('/');
  return i >= 0 ? modelSpec.slice(i + 1) : modelSpec;
}

/**
 * Extract tool calls from Gemini CLI output.
 * Gemini CLI outputs tool executions as structured text blocks.
 */
function extractToolCalls(text: string): Array<{ name: string; summary: string }> {
  const results: Array<{ name: string; summary: string }> = [];
  // Match shell code blocks (bash/sh commands)
  const codeBlockRe = /```(?:bash|sh|shell)?\n([\s\S]*?)```/g;
  let match;
  while ((match = codeBlockRe.exec(text)) !== null) {
    const cmd = match[1].trim().split('\n')[0].slice(0, 60);
    if (cmd.length > 0 && !cmd.startsWith('#')) {
      results.push({ name: 'Bash', summary: cmd });
    }
  }
  return results;
}

// ================================================================
// GeminiClient — 管理 gemini 子进程
// ================================================================

interface GeminiRunOptions {
  args: string[];
  cwd: string;
  env: Record<string, string>;
}

interface GeminiRunResult {
  stdout: string;
  stderr: string;
  code: number | null;
  error: Error | null;
}

/**
 * Run gemini CLI subprocess with proper lifecycle management.
 */
function runGeminiProcess(options: GeminiRunOptions, cancelSignal?: AbortSignal): Promise<GeminiRunResult> {
  return new Promise((resolve) => {
    let resolved = false;
    let stdout = '';
    let stderr = '';

    const child: ChildProcess = spawn('gemini', options.args, {
      cwd: options.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: options.env,
    });

    child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });

    child.on('close', (code) => {
      if (resolved) return;
      resolved = true;
      resolve({ stdout, stderr, code, error: null });
    });

    child.on('error', (err) => {
      if (resolved) return;
      resolved = true;
      resolve({ stdout, stderr, code: null, error: err });
    });

    if (cancelSignal) {
      cancelSignal.addEventListener('abort', () => {
        if (!resolved) {
          child.kill('SIGTERM');
          resolved = true;
          resolve({ stdout, stderr, code: -1, error: new Error('Cancelled by user') });
        }
      });
    }
  });
}

// ================================================================
// GeminiAdapter — 实现 AgentAdapter
// ================================================================

export class GeminiAdapter implements AgentAdapter {
  readonly name = 'gemini';
  private ctx: GeminiAdapterContext;
  private activeControllers: AbortController[] = [];
  /** 单次调用最大超时（毫秒），0 = 不限制 */
  static MAX_CALL_TIMEOUT_MS = 15 * 60 * 1000; // 15 分钟

  constructor(ctx: GeminiAdapterContext) {
    this.ctx = ctx;
  }

  /**
   * 清理所有活跃的子进程。
   * 在 gracefulShutdown 时由 index.ts 调用。
   */
  cleanup(): void {
    const count = this.activeControllers.length;
    if (count > 0) {
      console.log(`[GeminiAdapter] cleanup: aborting ${count} active request(s)`);
      for (const ctrl of this.activeControllers) {
        try { ctrl.abort(); } catch {}
      }
      this.activeControllers = [];
    }
  }

  /**
   * 处理单条用户消息
   */
  async handleMessage(input: AgentInput): Promise<AgentOutput> {
    const { text, session, workingDir, model, systemPrompt: overrideSystemPrompt } = input;
    const sessionAny = session as any; // 向后兼容

    // 创建 AbortController 并注册（用于超时 + shutdown 清理）
    const abortCtrl = new AbortController();
    this.activeControllers.push(abortCtrl);

    // 超时保护
    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    if (GeminiAdapter.MAX_CALL_TIMEOUT_MS > 0) {
      timeoutId = setTimeout(() => {
        console.log(`[GeminiAdapter] ⏰ Timeout (${GeminiAdapter.MAX_CALL_TIMEOUT_MS / 1000}s), aborting request`);
        abortCtrl.abort();
      }, GeminiAdapter.MAX_CALL_TIMEOUT_MS);
    }

    // 确定模型名
    const modelName = model.includes('/') ? model.slice(model.indexOf('/') + 1) : model;
    const aliases = this.ctx.modelAliases;

    // 附件信息注入：让 Agent 知道用户发送了附件及本地路径
    let effectiveText = text;
    if (input.attachments && input.attachments.length > 0) {
      effectiveText = buildAttachmentHint(input.attachments) + '\n\n---\n\n' + effectiveText;
    }

    // Gemini CLI 环境变量
    const customEnv: Record<string, string> = {
      ...process.env,
      GOOGLE_GENERATIVE_AI_API_KEY: process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || '',
      GEMINI_MODEL: resolveAlias(aliases.gemini || modelName),
    };

    // 构建 Gemini CLI 参数
    const args = ['--model', resolveAlias(aliases.gemini || modelName), '--prompt', effectiveText];

    // System Prompt（统一由 index.ts 注入）
    if (overrideSystemPrompt) {
      args.unshift('--system-instruction', overrideSystemPrompt);
    }

    // Session 管理（gemini CLI 不支持 session resume，但记录 ID 供外部参考）
    const shouldClear = session.startFresh;
    session.startFresh = false;
    if (shouldClear || !session.metadata?.geminiSessionId) {
      const newId = `gemini-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
      session.metadata.geminiSessionId = newId;
      sessionAny.geminiSessionId = newId;
      console.log(`[GeminiAdapter] new session=${newId}`);
    } else {
      console.log(`[GeminiAdapter] resuming session=${session.metadata.geminiSessionId}`);
    }

    console.log(`[GeminiAdapter] run model=${modelName} cwd=${workingDir}`);

    try {
      // 发送进度提示
      if (input.sendProgress) {
        await input.sendProgress('💭 Gemini is thinking...').catch(() => {});
      }

      // 执行 Gemini CLI
      const result = await runGeminiProcess({
        args,
        cwd: workingDir,
        env: customEnv,
      }, abortCtrl.signal);

      if (result.error) {
        if (abortCtrl.signal.aborted) {
          return { text: '⚠️ Request timed out or cancelled, please try again.' };
        }
        return { error: `gemini failed: ${result.error.message}` };
      }

      if (result.code !== 0) {
        const errorMsg = result.stderr.trim() || `gemini exited with code ${result.code}`;
        return { error: errorMsg };
      }

      const outputText = result.stdout.trim();
      const toolCalls = extractToolCalls(outputText);

      if (input.sendProgress && toolCalls.length > 0) {
        const names = toolCalls.map(t => t.name).join(', ');
        await input.sendProgress(`🔧 Detected: ${names}`).catch(() => {});
      }

      return {
        text: outputText || '✅ Done',
        toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
        usage: {
          inputTokens: 0, // Gemini CLI doesn't expose token counts
          outputTokens: 0,
        },
      };

    } catch (err: unknown) {
      if (abortCtrl.signal.aborted) {
        return { text: '⚠️ Request timed out or cancelled, please try again.' };
      }
      return { error: err.message || 'Gemini adapter failed' };
    } finally {
      if (timeoutId) clearTimeout(timeoutId);
      const idx = this.activeControllers.indexOf(abortCtrl);
      if (idx >= 0) this.activeControllers.splice(idx, 1);
    }
  }

  healthCheck(): Promise<boolean> {
    return new Promise((resolve) => {
      const { execSync } = require('child_process');
      try {
        execSync('gemini --version', { stdio: 'pipe', timeout: 5000 });
        resolve(true);
      } catch {
        resolve(false);
      }
    });
  }

  cancel(): void {
    for (const ctrl of this.activeControllers) {
      try { ctrl.abort(); } catch {}
    }
  }

  /**
   * Tool support for AgentLoop — 从 Gemini CLI 文本输出中提取工具调用并注入结果。
   * Gemini CLI 是纯文本协议，工具调用以代码块/结构化文本出现。
   */
  getToolSupport(): AgentToolSupport | null {
    return {
      extractToolCalls: (output: AgentOutput, registry: ToolRegistry): ParsedToolCall[] => {
        if (!output.text) return [];
        const calls: ParsedToolCall[] = [];
        // 匹配 JSON 格式的工具调用
        const jsonRe = /\{\s*"name"\s*:\s*"([^"]+)"\s*,\s*"args"\s*:\s*(\{[^}]*\})\s*\}/g;
        let m: RegExpExecArray | null;
        while ((m = jsonRe.exec(output.text)) !== null) {
          const name = m[1];
          if (!registry.isRegistered(name)) continue;
          try {
            calls.push({ name, args: JSON.parse(m[2]) });
          } catch {}
        }
        // 也匹配 Gemini CLI 的代码块模式（bash/sh 等）
        const codeBlockRe = /```(?:bash|sh|shell)?\n([\s\S]*?)```/g;
        while ((m = codeBlockRe.exec(output.text)) !== null) {
          const cmd = m[1].trim().split('\n')[0].slice(0, 60);
          if (cmd.length > 0 && !cmd.startsWith('#')) {
            // 检查是否是本地工具命令
            const cmdName = cmd.split(/[ (]/)[0];
            if (registry.isRegistered(cmdName)) {
              calls.push({ name: cmdName, args: {} });
            }
          }
        }
        return calls;
      },
      appendToolResults: (input: AgentInput, toolCalls: ParsedToolCall[], results: string[]): AgentInput => {
        let toolSection = '\n\n<tool_results>\n';
        for (let i = 0; i < toolCalls.length; i++) {
          toolSection += `[Tool: ${toolCalls[i].name}]\nResult: ${results[i]}\n\n`;
        }
        toolSection += '</tool_results>\n\nPlease continue with the above tool results.';
        return {
          ...input,
          text: input.text + toolSection,
          session: { ...input.session, startFresh: false },
        };
      },
    };
  }
}
