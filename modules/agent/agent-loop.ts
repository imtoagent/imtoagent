// ================================================================
// Agent Loop — 在 AgentAdapter 之上实现本地工具循环
// ================================================================
// 设计原则：
//   - AgentAdapter 只管后端通信，不改内部逻辑
//   - 每个 adapter 只需实现 extractToolCalls + appendToolResults
//   - loop 逻辑集中在一处
// ================================================================

import type { ToolRegistry } from './tool-registry';
import type { AgentAdapter, AgentInput, AgentOutput, Session } from '../core/types';
import type { HookRunner } from '../core/hook-runner';
import { getCurrentBot } from '../bot-context';

const MAX_LOOPS = 10;
const TOOL_EXEC_TIMEOUT_MS = 30_000;

export interface ParsedToolCall {
  name: string;
  args: Record<string, unknown>;
  rawId?: string;
}

/**
 * Agent 后端可选实现的 tool support 接口。
 * 实现了才能参与本地工具循环；不实现则直接透传。
 */
export interface AgentToolSupport {
  extractToolCalls(output: AgentOutput, registry: ToolRegistry): ParsedToolCall[];
  appendToolResults(
    input: AgentInput,
    toolCalls: ParsedToolCall[],
    results: string[],
  ): AgentInput;
}

export class AgentLoop {
  private adapter: AgentAdapter;
  private toolRegistry: ToolRegistry;
  private toolSupport: AgentToolSupport | null;

  constructor(
    adapter: AgentAdapter,
    toolRegistry: ToolRegistry,
    toolSupport?: AgentToolSupport | null,
  ) {
    this.adapter = adapter;
    this.toolRegistry = toolRegistry;
    this.toolSupport = toolSupport ?? null;
  }

  async execute(input: AgentInput): Promise<AgentOutput> {
    if (!this.toolSupport) {
      return this.adapter.handleMessage(input);
    }

    let effectiveInput: AgentInput = { ...input };
    let hadLocalTools = false;
    let loops = 0;
    let lastOutput: AgentOutput | undefined;

    while (loops < MAX_LOOPS) {
      loops++;

      let output: AgentOutput;
      try {
        output = await this.adapter.handleMessage(effectiveInput);
      } catch (e: unknown) {
        const msg = (e as Error).message || String(e);
        console.error(`[AgentLoop] ❌ adapter call failed (loop ${loops}): ${msg}`);
        if (!hadLocalTools) throw e;
        return lastOutput || { text: `⚠️ Agent loop error: ${msg}` };
      }

      lastOutput = output;

      const parsedCalls = this.toolSupport.extractToolCalls(output, this.toolRegistry);
      if (parsedCalls.length === 0) {
        return output;
      }

      const localCalls = parsedCalls.filter(tc => this.toolRegistry.isRegistered(tc.name));
      const remoteCalls = parsedCalls.filter(tc => !this.toolRegistry.isRegistered(tc.name));

      if (localCalls.length === 0) {
        // 只有远端工具，adapter/后端已自行处理
        return output;
      }

      console.log(`[AgentLoop] loop ${loops}: ${localCalls.length} local tool call(s)`);

      // 执行本地工具（带 Hook 支持）
      const hookRunner = getCurrentBot()?.hookRunner;
      const results: string[] = [];
      for (const tc of localCalls) {
        const argsPreview = JSON.stringify(tc.args).slice(0, 200);
        console.log(`[AgentLoop] 🔧 executing: ${tc.name}(${argsPreview})`);

        // before_tool_call hook
        if (hookRunner) {
          const beforeResult = await hookRunner.runBeforeToolCall({
            toolName: tc.name,
            args: tc.args,
            chatId: getCurrentBot()?.lastChatId || '',
          });
          if (beforeResult.blocked) {
            results.push(`Blocked by hook: ${beforeResult.error}`);
            hadLocalTools = true;
            continue;
          }
        }

        let result: string;
        let success = true;
        try {
          const execPromise = this.toolRegistry.execute(tc.name, tc.args);
          const timeoutPromise = new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error('tool execution timeout')), TOOL_EXEC_TIMEOUT_MS),
          );
          const rawResult = await Promise.race([execPromise, timeoutPromise]);
          result = typeof rawResult === 'string' ? rawResult : JSON.stringify(rawResult);
        } catch (e: unknown) {
          result = `Error executing ${tc.name}: ${(e as Error).message}`;
          success = false;
          console.error(`[AgentLoop] ❌ tool failed: ${tc.name} → ${result}`);
        }

        // after_tool_call hook
        if (hookRunner) {
          result = await hookRunner.runAfterToolCall({
            toolName: tc.name,
            args: tc.args,
            result,
            success,
            chatId: getCurrentBot()?.lastChatId || '',
          });
        }

        results.push(result);
        hadLocalTools = true;
      }

      // 注入结果到下一轮输入
      effectiveInput = this.toolSupport.appendToolResults(effectiveInput, localCalls, results);
      effectiveInput.session.startFresh = false;

      console.log(`[AgentLoop] 🔄 loop ${loops} done, continuing...`);
    }

    console.warn(`[AgentLoop] ⚠️ max loops (${MAX_LOOPS}) reached`);
    return lastOutput || { text: '⚠️ Agent loop exceeded maximum iterations' };
  }
}
