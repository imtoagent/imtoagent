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

const MAX_LOOPS = 10;
const TOOL_EXEC_TIMEOUT_MS = 30_000;

function isLocalTool(name: string): boolean {
  return (
    name.startsWith('imtoagent_') ||
    name.startsWith('goal_') ||
    name === 'get_weather'
  );
}

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
  extractToolCalls(output: AgentOutput): ParsedToolCall[];
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

      const parsedCalls = this.toolSupport.extractToolCalls(output);
      if (parsedCalls.length === 0) {
        return output;
      }

      const localCalls = parsedCalls.filter(tc => isLocalTool(tc.name));
      const remoteCalls = parsedCalls.filter(tc => !isLocalTool(tc.name));

      if (localCalls.length === 0) {
        // 只有远端工具，adapter/后端已自行处理
        return output;
      }

      console.log(`[AgentLoop] loop ${loops}: ${localCalls.length} local tool call(s)`);

      // 执行本地工具
      const results: string[] = [];
      for (const tc of localCalls) {
        const argsPreview = JSON.stringify(tc.args).slice(0, 200);
        console.log(`[AgentLoop] 🔧 executing: ${tc.name}(${argsPreview})`);

        let result: string;
        try {
          const execPromise = this.toolRegistry.execute(tc.name, tc.args);
          const timeoutPromise = new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error('tool execution timeout')), TOOL_EXEC_TIMEOUT_MS),
          );
          const rawResult = await Promise.race([execPromise, timeoutPromise]);
          result = typeof rawResult === 'string' ? rawResult : JSON.stringify(rawResult);
        } catch (e: unknown) {
          result = `Error executing ${tc.name}: ${(e as Error).message}`;
          console.error(`[AgentLoop] ❌ tool failed: ${tc.name} → ${result}`);
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
