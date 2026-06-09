// ================================================================
// Codex Agent Adapter — 实现 SDK AgentAdapter 接口
// ================================================================
// 职责：对接 Codex CLI，将 AgentInput 转换为 AgentOutput
// 支持两条路径：
//   1. App-Server（优先）：进程内 HTTP 流式，长记忆，崩溃不丢上下文
//   2. CLI 子进程（fallback）：codex exec/resume
// ================================================================

import type { AgentAdapter, AgentInput, AgentOutput, Session } from '../core/types';
import type { ParsedToolCall, AgentToolSupport } from './agent-loop';
import { buildAttachmentHint } from '../core/types';

import { getAppServerManager, type AgentEvent } from './codex-exec-server';
import { saveActiveModel } from '../proxy/anthropic-proxy';
import { loadConfig } from '../core/config';
import * as path from 'path';
import * as fs from 'fs';
import { getDataDir, getBotConfigPath } from '../utils/paths';

// ================================================================
// CodexAdapter 上下文
// ================================================================

export interface CodexAdapterContext {
  imModule?: { getCapabilities(): IMCapabilities } | null;
  botName: string;
}

// ================================================================
// Codex CLI 调用
// ================================================================

interface CodexJsonEvent {
  type: string;
  thread_id?: string;
  item?: { type: string; text?: string; name?: string; arguments?: string; output?: string };
  text?: string;
  delta?: string;
  message?: { content?: { type: string; text?: string }[] };
  error?: string;
}

function processCodexStream(stdout: string): { threadId: string; response: string } {
  let threadId = '', response = '';
  for (const line of stdout.split('\n')) {
    if (!line.trim()) continue;
    try {
      const evt: CodexJsonEvent = JSON.parse(line);
      if (evt.type === 'thread.started' && evt.thread_id) {
        threadId = evt.thread_id;
      } else if (evt.type === 'item.completed') {
        if (evt.item?.type === 'agent_message') {
          response = (response ? response + '\n' : '') + (evt.item.text || '');
        }
      } else if (evt.type === 'error' || evt.type === 'thread.error') {
        const evtRec = evt as Record<string, unknown>;
        console.error(`[CodexAdapter] event error: ${(evtRec.message as string) || (evtRec.error as string) || JSON.stringify(evt)}`);
      }
    } catch {}
  }
  return { threadId, response };
}

async function spawnCodexExec(cwd: string, prompt: string, cancelSignal?: AbortSignal): Promise<{ threadId: string; response: string }> {
  const child = Bun.spawn(['codex', 'exec', '-p', 'imtoagent', '-s', 'danger-full-access',
    '--skip-git-repo-check', '--json', prompt], {
    cwd, stdout: 'pipe', stderr: 'pipe',
  });

  // P4-2: 超时取消
  if (cancelSignal) {
    cancelSignal.addEventListener('abort', () => {
      try { child.kill('SIGKILL'); } catch {}
    }, { once: true });
  }

  let stdout = '', stderr = '';
  try {
    [stdout, stderr] = await Promise.all([
      new Response(child.stdout).text().catch((e: unknown) => { throw new Error(`stdout read failed: ${e?.message || e}`); }),
      new Response(child.stderr).text().catch((e: unknown) => { throw new Error(`stderr read failed: ${e?.message || e}`); }),
    ]);
  } catch (ioErr: unknown) {
    try { child.kill('SIGKILL'); } catch {}
    throw new Error(`codex exec I/O error: ${ioErr.message}`);
  }

  const code = await child.exited.catch(() => -1);
  const { threadId, response } = processCodexStream(stdout);
  if (code !== 0 || !threadId) throw new Error(`codex exec exit ${code}: ${stderr.slice(0, 300)}`);
  return { threadId, response };
}

async function spawnCodexResume(cwd: string, threadId: string, prompt: string, model?: string, cancelSignal?: AbortSignal): Promise<{ response: string }> {
  const child = Bun.spawn(['codex', 'exec', 'resume', threadId,
    '--dangerously-bypass-approvals-and-sandbox', '-c', 'model_provider=imtoagent', '-c', `model=${model || 'gpt-5.5'}`, '--json', '--skip-git-repo-check', prompt], {
    cwd, stdout: 'pipe', stderr: 'pipe',
  });

  // P4-2: 超时取消
  if (cancelSignal) {
    cancelSignal.addEventListener('abort', () => {
      try { child.kill('SIGKILL'); } catch {}
    }, { once: true });
  }

  let stdout = '', stderr = '';
  try {
    [stdout, stderr] = await Promise.all([
      new Response(child.stdout).text().catch((e: unknown) => { throw new Error(`stdout read failed: ${e?.message || e}`); }),
      new Response(child.stderr).text().catch((e: unknown) => { throw new Error(`stderr read failed: ${e?.message || e}`); }),
    ]);
  } catch (ioErr: unknown) {
    try { child.kill('SIGKILL'); } catch {}
    throw new Error(`codex exec resume I/O error: ${ioErr.message}`);
  }

  const code = await child.exited.catch(() => -1);
  if (code !== 0) throw new Error(`codex exec resume exit ${code}: ${stderr.slice(0, 300)}`);
  return { response: processCodexStream(stdout).response };
}

// ================================================================
// App-Server 路径（优先）
// ================================================================

async function runViaAppServer(
  cwd: string, prompt: string, chatId: string, session: Session,
  isFresh: boolean, systemPrompt?: string, onProgress?: (text: string) => Promise<void>,
  cancelSignal?: AbortSignal,
  toolResults?: Array<{ toolCallId: string; result: string; isError?: boolean }>
): Promise<{ threadId: string; response: string; usage: { inputTokens: number; outputTokens: number } }> {
  let turnCount = 0;
  const manager = getAppServerManager();
  const client = await manager.getClient(chatId);
  const currentGen = manager.generation;
  const sessionAny = session as Record<string, unknown>;
  const threadExpired = (sessionAny._appServerGen as number) !== currentGen;

  // ================================================================
  // Thread Rotation + Context Memory
  // ================================================================
  const MAX_THREAD_ROUNDS = 10;
  const _turnCount = (sessionAny._turnCount as number) ?? 0;

  if (isFresh || !sessionAny.codexThreadId || threadExpired) {
    const oldThreadId = sessionAny.codexThreadId as string | undefined;

    // 非首次、有旧 thread、超过轮次上限 → 提取上下文摘要
    if (oldThreadId && !isFresh && !threadExpired && _turnCount >= MAX_THREAD_ROUNDS) {
      try {
        const rounds = (session.heartbeatRounds || []).slice(-3);
        if (rounds.length > 0) {
          const summaryParts = rounds.map((r, i) =>
            `[轮${i + 1}] 用户: ${r.prompt || "(无)"}\n回复: ${r.response || "(无)"}`
          );
          const summary = "以下是之前对话的关键上下文（自动轮转保留）：\n" + summaryParts.join("\n---\n");
          session.contextMemory = {
            summary,
            fromThreadId: oldThreadId,
            rotatedAt: Date.now(),
            rotationCount: ((session.contextMemory?.rotationCount) || 0) + 1,
          };
          console.log(`[CodexAdapter] context memory saved (${summary.length} chars, rotation #${session.contextMemory.rotationCount})`);
        }
      } catch (e: unknown) {
        console.error(`[CodexAdapter] failed to extract context memory: ${(e as Error).message}`);
      }
    }

    sessionAny.codexThreadId = await client.startThread(cwd);
    sessionAny._appServerGen = currentGen;
    sessionAny._turnCount = 0;
    session.metadata.codexThreadId = sessionAny.codexThreadId;
    console.log(`[CodexAdapter] app-server new thread=${sessionAny.codexThreadId.slice(-8)}${threadExpired ? " (process restarted)" : ""}${_turnCount >= MAX_THREAD_ROUNDS ? ` (rotation after ${_turnCount} turns)` : ""}`);
  }

  // 注入 context memory 到新 thread 的首条消息
  let effectivePrompt = prompt;
  if (session.contextMemory?.summary && _turnCount === 0) {
    effectivePrompt = `<previous-context>\n${session.contextMemory.summary}\n</previous-context>\n\n${prompt}`;
    console.log(`[CodexAdapter] injected context memory (${session.contextMemory.summary.length} chars)`);
  }

  sessionAny._turnCount = _turnCount + 1;

  await client.sendPrompt(sessionAny.codexThreadId, effectivePrompt, cwd, systemPrompt, toolResults);

  let response = '';
  let totalUsage = { inputTokens: 0, outputTokens: 0 };
  const startTime = Date.now();
  const MAX_DURATION = 600_000; // 10 分钟

  for await (const event of client.receiveEvents()) {
    if (cancelSignal?.aborted) {
      console.log('[CodexAdapter] Task cancelled via abort signal');
      throw new Error('Task cancelled');
    }
    if (Date.now() - startTime > MAX_DURATION) {
      console.error('[CodexAdapter] app-server task timed out (10min)');
      break;
    }

    switch (event.type) {
      case 'text_delta':
        response += event.textDelta || '';
        break;
      case 'tool_call': {
        const evtRec = event as Record<string, unknown>;
        const toolCall = evtRec.toolCall as Record<string, unknown> | undefined;
        const tool = evtRec.tool as Record<string, unknown> | undefined;
        const name = (toolCall?.name as string) || (tool?.name as string) || 'Tool';
        onProgress?.(`🔧 Executing: ${name}`);
        break;
      }
      case 'turn_result':
        turnCount++;
        onProgress?.(`✅ Turn ${turnCount} completed`);
        totalUsage.inputTokens += event.usage?.inputTokens || 0;
        totalUsage.outputTokens += event.usage?.outputTokens || 0;
        break;
      case 'error':
        throw new Error(`app-server error: ${event.error}`);
    }
  }

  return { threadId: sessionAny.codexThreadId, response, usage: totalUsage };
}

// ================================================================
// CodexAdapter — 实现 AgentAdapter
// ================================================================

export class CodexAdapter implements AgentAdapter {
  readonly name = 'Codex CLI';
  private ctx: CodexAdapterContext;

  constructor(ctx: CodexAdapterContext) {
    this.ctx = ctx;
  }

  async handleMessage(input: AgentInput): Promise<AgentOutput> {
    const { text, session, workingDir, systemPrompt: overrideSystemPrompt } = input;
    const sessionAny = session as Record<string, unknown>;
    const cwd = workingDir;

    // ═══════════════════════════════════════════════════════════
    // 🚫 拦截 /model 命令 — IMtoAgent 原生处理，不传给 Codex
    // ═══════════════════════════════════════════════════════════
    const modelCmdResult = this.handleModelCommand(text);
    if (modelCmdResult) {
      return { text: modelCmdResult };
    }

    let effectiveText = text;

    // 附件信息注入：让 Agent 知道用户发送了附件（图片/文件/语音）及本地路径
    if (input.attachments && input.attachments.length > 0) {
      effectiveText = buildAttachmentHint(input.attachments) + '\n\n---\n\n' + effectiveText;
    }

    if (session.codexMode === 'plan') {
      effectiveText = `[Mode: Plan then execute] Please create a clear plan first, wait for my confirmation before executing. User request: ${effectiveText}`;
    }

    const isFresh = session.startFresh || !sessionAny.codexThreadId;
    session.startFresh = false;

    // 优先尝试 app-server
    let useExecFallback = false;
    let response: string;
    let execServerUsage: { inputTokens: number; outputTokens: number } | null = null;

    try {
      const r = await runViaAppServer(cwd, effectiveText, input.chatId, session, isFresh, overrideSystemPrompt,
        async (t: string) => { try { await input.sendProgress?.(t); } catch {} }, input.cancelSignal, input.toolResults);
      response = r.response;
      execServerUsage = r.usage;
    } catch (appErr: unknown) {
      const errMsg = appErr.message || '';
      console.error(`[CodexAdapter] app-server failed: ${errMsg}`);

      if (errMsg.includes('thread not found') || errMsg.includes('Thread not found')) {
        try {
          sessionAny.codexThreadId = undefined;
          const r2 = await runViaAppServer(cwd, effectiveText, input.chatId, session, true, overrideSystemPrompt,
            async (t: string) => { try { await input.sendProgress?.(t); } catch {} }, input.cancelSignal, input.toolResults);
          response = r2.response;
          execServerUsage = r2.usage;
          console.error(`[CodexAdapter] app-server thread rebuilt successfully`);
        } catch {
          useExecFallback = true;
        }
      } else {
        useExecFallback = true;
      }
    }

    if (useExecFallback) {
      getAppServerManager().removeClient(input.chatId);
      input.sendProgress?.('⚙️ Processing... (CLI mode, no streaming progress)').catch(() => {});
      if (isFresh || !sessionAny.codexThreadId) {
        const r = await spawnCodexExec(cwd, effectiveText, input.cancelSignal);
        sessionAny.codexThreadId = r.threadId;
        session.metadata.codexThreadId = r.threadId;
        response = r.response;
      } else {
        const r = await spawnCodexResume(cwd, sessionAny.codexThreadId, effectiveText, input.model, input.cancelSignal);
        response = r.response;
      }
    }

    return {
      text: response || '✅ Completed',
      usage: execServerUsage || undefined,
    };
  }

  // ═══════════════════════════════════════════════════════════
  // /model 命令拦截器
  // 用法：/model              — 查看当前模型
  //       /model provider/model  — 切换模型
  //       /model list           — 列出可用模型
  // ═══════════════════════════════════════════════════════════
  private handleModelCommand(text: string): string | null {
    const trimmed = text.trim();
    // 匹配 /model 命令（不区分大小写，允许前后空格）
    const modelMatch = trimmed.match(/^\/model\b(.*)$/i);
    if (!modelMatch) return null;

    const args = modelMatch[1].trim();

    try {
      // 读取 config.json 获取当前配置
      const configPath = path.join(getDataDir(), 'config.json');
      const raw = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      const currentActiveModel = raw.activeModel || '(未设置)';
      const providers = raw.providers || {};
      const modelAliases = raw.modelAliases || {};

      if (!args) {
        // /model — 显示当前模型
        return `🤖 当前模型：${currentActiveModel}`;
      }

      if (args.toLowerCase() === 'list' || args.toLowerCase() === 'ls') {
        // /model list — 列出所有可用模型
        const lines: string[] = [`📋 可用模型：`, `\n当前：${currentActiveModel}`];
        for (const [provName, provCfg] of Object.entries(providers)) {
          const cfg = provCfg as Record<string, unknown>;
          const models = (cfg.models as string[]) || [];
          const apiKey = (cfg.apiKey as string) || '';
          if (models.length > 0) {
            lines.push(`\n${provName}:`);
            for (const m of models) {
              lines.push(`  - ${m}${apiKey ? ' ✅' : ' ❌ (无 key)'}`);
            }
          } else {
            lines.push(`\n${provName}: (未配置模型列表)${apiKey ? ' ✅' : ' ❌ (无 key)'}`);
          }
        }
        if (Object.keys(modelAliases).length > 0) {
          lines.push('\n🏷️ 别名：');
          for (const [alias, target] of Object.entries(modelAliases)) {
            lines.push(`  ${alias} → ${target}`);
          }
        }
        return lines.join('\n');
      }

      // /model provider/model 或 /model alias — 切换模型
      const targetSpec = args;

      // 先检查是否是 alias
      let resolvedSpec = targetSpec;
      if (modelAliases[targetSpec]) {
        resolvedSpec = modelAliases[targetSpec];
      }

      // 验证 provider 是否存在
      const slashIdx = resolvedSpec.indexOf('/');
      if (slashIdx < 0) {
        // 没有 provider 前缀，尝试从 provider 中匹配
        let found = false;
        for (const [provName, provCfg] of Object.entries(providers)) {
          const cfg = provCfg as Record<string, unknown>;
          const provModels = (cfg.models as string[]) || [];
          if (provModels.includes(targetSpec) || (cfg.model as string) === targetSpec) {
            resolvedSpec = `${provName}/${targetSpec}`;
            found = true;
            break;
          }
        }
        if (!found) {
          return `❌ 未知模型：${targetSpec}\n使用 /model list 查看可用模型`;
        }
      }

      const providerName = resolvedSpec.slice(0, slashIdx);
      if (!providers[providerName]) {
        return `❌ 未知供应商：${providerName}\n使用 /model list 查看可用供应商`;
      }

      // 持久化到 bot-config.json（唯一真相源）
      const botCfgPath = getBotConfigPath(this.ctx.botName);
      const botDir = path.dirname(botCfgPath);
      if (!fs.existsSync(botDir)) {
        fs.mkdirSync(botDir, { recursive: true });
      }
      let botCfg: Record<string, unknown> = {};
      if (fs.existsSync(botCfgPath)) {
        botCfg = JSON.parse(fs.readFileSync(botCfgPath, 'utf-8'));
      }
      botCfg.activeModel = resolvedSpec;
      fs.writeFileSync(botCfgPath, JSON.stringify(botCfg, null, 2));

      console.log(`[CodexAdapter] /model command: ${currentActiveModel} → ${resolvedSpec}`);
      console.log(`[CodexAdapter] 已写入 bot-config.json: ${botCfgPath}`);

      return `✅ 模型已切换：${resolvedSpec}`;
    } catch (e: unknown) {
      console.error(`[CodexAdapter] /model command failed: ${(e as Error).message}`);
      return `❌ 切换模型失败：${(e as Error).message}`;
    }
  }

  // Tool support for AgentLoop — 从 Codex 响应中提取工具调用并注入结果。
  // Codex (OpenAI 兼容格式) 返回的 response 文本中包含结构化信息。
  // 当前实现：文本模式解析，识别本地工具调用（imtoagent_ 和 goal_ 前缀、get_weather）。
  getToolSupport(): AgentToolSupport | null {
    return {
      extractToolCalls: (output: AgentOutput): ParsedToolCall[] => {
        if (!output.text) return [];
        const calls: ParsedToolCall[] = [];
        // Codex 响应中工具调用通常以 JSON 或特定格式出现
        // 匹配 {"name": "imtoagent_xxx", "arguments": {...}} 模式
        const jsonRe = /\{\s*"name"\s*:\s*"(imtoagent_\w+|goal_\w+|get_weather)"\s*,\s*"arguments"\s*:\s*(\{[^}]*\})\s*\}/g;
        let m: RegExpExecArray | null;
        while ((m = jsonRe.exec(output.text!)) !== null) {
          try {
            calls.push({ name: m[1], args: JSON.parse(m[2]) });
          } catch {}
        }
        // 也匹配 tool_call 事件格式的残留文本
        const toolCallRe = /(?:tool_call|function_call)[^{]*name["':\s]+(imtoagent_\w+|goal_\w+|get_weather)[^\n]*arguments?["':\s]+(\{[^\n]*\})/gi;
        while ((m = toolCallRe.exec(output.text!)) !== null) {
          try {
            calls.push({ name: m[1], args: JSON.parse(m[2]) });
          } catch {}
        }
        return calls;
      },
      appendToolResults: (input: AgentInput, toolCalls: ParsedToolCall[], results: string[]): AgentInput => {
        // 构造结构化 toolResults，由 sendPrompt 以 function_call_output 格式发送
        const toolResults = toolCalls.map((tc, i) => ({
          toolCallId: tc.rawId || `call_${tc.name}_${Date.now()}_${i}`,
          name: tc.name,
          result: results[i],
        }));
        return {
          ...input,
          text: '', // 不拼接文本，工具结果通过 toolResults 字段传递
          toolResults,
          session: { ...input.session, startFresh: false },
        };
      },
    };
  }
}
