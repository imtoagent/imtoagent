// ================================================================
// OpenCode Agent Adapter — 实现 SDK AgentAdapter 接口
// ================================================================
// 职责：对接 opencode serve HTTP API，将 AgentInput 转换为 AgentOutput
// 多轮循环：OpenCode serve 的 /message 是单轮 API，每次返回可能含
//   tool_call（服务端已执行），需要客户端发 "继续" 推进直到纯文本响应。
// ================================================================

import type { AgentAdapter, AgentInput, AgentOutput } from '../core/types';
import { buildAttachmentHint } from '../core/types';

import { getDataDir } from '../utils/paths';
import { getNpmGlobalBin } from '../utils/backend-check';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// ================================================================
// OpenCodeAdapter 上下文
// ================================================================

export interface OpenCodeAdapterContext {
  imModule?: { getCapabilities(): IMCapabilities } | null;
  botName: string;
  /** OpenCode Server URL，默认 http://localhost:4096 */
  serverUrl?: string;
  /** 默认模型 */
  defaultModel?: { providerID: string; modelID: string };
}

// ================================================================
// OpenCode Server HTTP 客户端
// ================================================================

interface OcMessagePart {
  type: string;
  text?: string;
  tool_call?: { name: string; arguments: Record<string, unknown> };
  tool_result?: { content: string };
}

interface OcMessage {
  info: { id: string; role: string; model?: string };
  parts: OcMessagePart[];
}

async function ocCreateSession(serverUrl: string, title: string): Promise<string> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 300_000);
  const res = await fetch(`${serverUrl}/session`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title }),
    signal: ac.signal,
  }).finally(() => clearTimeout(timer));
  if (!res.ok) throw new Error(`oc create session: ${res.status} ${await res.text()}`);
  const data = await res.json();
  return data.id;
}

async function ocSendPrompt(
  serverUrl: string,
  sessionId: string,
  initialText: string,
  system: string,
  defaultModel: { providerID: string; modelID: string },
  onProgress?: (text: string) => void,
  cancelSignal?: AbortSignal
): Promise<{ response: string; toolCalls: Array<{ name: string; summary: string }> }> {
  const MAX_TURNS = 50;
  const TURN_TIMEOUT = 900_000;  // 15 min per turn
  const MAX_DURATION = 3_600_000;  // total timeout 60 min
  const startTime = Date.now();

  let promptText = initialText;
  let accumulatedResponse = '';
  let turn = 0;
  const allToolCalls: Array<{ name: string; summary: string }> = [];

  while (turn < MAX_TURNS) {
    if (Date.now() - startTime > MAX_DURATION) {
      console.error(`[OpenCodeAdapter] Task timed out (${MAX_DURATION / 60000}min)`);
      if (onProgress) onProgress('⚠️ Task timed out, stopped');
      break;
    }
    turn++;

    // 构建请求体：首轮带 system prompt，后续轮只带纯文本推进
    const body: Record<string, unknown> = {
      model: defaultModel,
      parts: [{ type: 'text', text: promptText }],
    };
    if (turn === 1 && system) body.system = system;

    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), TURN_TIMEOUT);
    // 组合外部取消信号（/stop）+ 本层超时
    const signal = cancelSignal ? AbortSignal.any([ac.signal, cancelSignal]) : ac.signal;
    let data: OcMessage;
    try {
      const res = await fetch(`${serverUrl}/session/${sessionId}/message`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal,
      }).finally(() => clearTimeout(timer));
      if (!res.ok) throw new Error(`oc send prompt (turn ${turn}): ${res.status} ${await res.text()}`);
      data = await res.json();
    } catch (err: unknown) {
      if (err?.name === 'AbortError') {
        // 外部取消（/stop）优先于超时
        if (cancelSignal?.aborted) {
          console.log('[OpenCodeAdapter] ⏹️ Task cancelled by user (/stop)');
          return { response: '⏹️ 任务已取消', toolCalls: allToolCalls };
        }
        throw err; // 超时等其它 AbortError 继续抛出
      }
      throw err;
    }
    let hasToolCall = false;
    let hasText = false;

    for (const part of data.parts || []) {
      if (part.type === 'text' && part.text) {
        hasText = true;
        accumulatedResponse += (accumulatedResponse ? '\n' : '') + part.text;
      } else if (part.type === 'tool_call' && part.tool_call) {
        hasToolCall = true;
        const name = part.tool_call.name;
        const args = part.tool_call.arguments || {};
        const summary = args.command || args.cmd || args.file_path || args.query
          || JSON.stringify(args).slice(0, 80);
        allToolCalls.push({ name, summary });
        if (onProgress) onProgress(`🔧 Executing: ${name} — ${summary.slice(0, 60)}`);
        console.log(`[OpenCodeAdapter] 🔧 turn ${turn}: ${name} ${summary.slice(0, 60)}`);
      }
    }

    // 有文本回复 → 任务完成（OpenCode 内部已完成多轮 agent loop）
    if (hasText) {
      console.log(`[OpenCodeAdapter] ✅ completed at turn ${turn}/${MAX_TURNS}`);
      if (onProgress) onProgress(`✅ Turn ${turn} completed`);
      break;
    }

    // 无文本且无 tool_call → 空响应，结束
    if (!hasToolCall) {
      console.log(`[OpenCodeAdapter] ⚠️ empty response, ending at turn ${turn}/${MAX_TURNS}`);
      break;
    }

    // 仅有 tool_call 无文本 → 推进下一轮
    if (onProgress) onProgress(`⏳ Turn ${turn}/${MAX_TURNS}, continuing...`);
    promptText = 'Continue executing, complete remaining tasks';
  }

  if (turn >= MAX_TURNS) {
    console.warn(`[OpenCodeAdapter] ⚠️ reached max turns ${MAX_TURNS}`);
  }

  return { response: accumulatedResponse, toolCalls: allToolCalls };
}

async function ocDeleteSession(serverUrl: string, sessionId: string): Promise<void> {
  await fetch(`${serverUrl}/session/${sessionId}`, { method: 'DELETE' }).catch(() => {});
}

// ================================================================
// OpenCodeAdapter — 实现 AgentAdapter
// ================================================================

export class OpenCodeAdapter implements AgentAdapter {
  readonly name = 'OpenCode';
  private ctx: OpenCodeAdapterContext;

  constructor(ctx: OpenCodeAdapterContext) {
    this.ctx = ctx;
  }

  async handleMessage(input: AgentInput): Promise<AgentOutput> {
    const { text, session, systemPrompt: overrideSystemPrompt } = input;

    const serverUrl = this.ctx.serverUrl || 'http://localhost:4096';
    const defaultModel = this.ctx.defaultModel || { providerID: 'anthropic', modelID: 'claude-sonnet-4-5' };
    const sessionAny = session as Record<string, unknown>;

    let effectiveText = text;

    // 附件信息注入：让 Agent 知道用户发送了附件（图片/文件/语音）及本地路径
    if (input.attachments && input.attachments.length > 0) {
      effectiveText = buildAttachmentHint(input.attachments) + '\n\n---\n\n' + effectiveText;
    }

    if (session.codexMode === 'plan') {
      effectiveText = `[Mode: Plan then execute] Please create a clear plan first, wait for my confirmation before executing. User request: ${effectiveText}`;
    }

    // 清理标记
    const shouldClear = session.startFresh;
    session.startFresh = false;

    // 获取或创建 OpenCode session
    if (shouldClear || !sessionAny.ocSessionId) {
      if (sessionAny.ocSessionId) {
        await ocDeleteSession(serverUrl, sessionAny.ocSessionId);
        console.log(`[OpenCodeAdapter] Cleared oc session=${sessionAny.ocSessionId.slice(-8)}`);
      }
      sessionAny.ocSessionId = await ocCreateSession(serverUrl, input.chatId);
      session.metadata.ocSessionId = sessionAny.ocSessionId;
      console.log(`[OpenCodeAdapter] Created oc session=${sessionAny.ocSessionId.slice(-8)}`);
    }

    // 系统提示词（统一由 index.ts 注入）
    const systemPrompt = overrideSystemPrompt;
    if (systemPrompt) {
      console.log(`[OpenCodeAdapter] 📝 system prompt (${systemPrompt.length} chars)`);
    }

    // 发送 prompt（多轮循环：自动推进 tool_call → 纯文本响应）
    // 注意：ocSendPrompt 不直接依赖 ctx，由 handleMessage 传入 onProgress 回调
    const onProgress = async (text: string) => {
      try { await input.sendProgress?.(text); } catch {}
    };

    const { response, toolCalls } = await ocSendPrompt(
      serverUrl,
      sessionAny.ocSessionId,
      effectiveText,
      systemPrompt,
      defaultModel,
      onProgress,
      input.cancelSignal
    );

    return {
      text: response || '✅ Completed',
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
    };
  }

  async healthCheck(): Promise<boolean> {
    try {
      const serverUrl = this.ctx.serverUrl || 'http://localhost:4096';
      const res = await fetch(`${serverUrl}/global/health`);
      return res.ok;
    } catch {
      return false;
    }
  }
}

// ================================================================
// OpenCode Server 生命周期管理（模块级，单例）
// ================================================================
// IMtoAgent 作为多 Agent 网关，在适配器层管理后端服务进程
// 未来 ClaudeAdapter / CodexAdapter 也可按需实现各自的 start/stop

let _ocProcess: ReturnType<typeof Bun.spawn> | null = null;

const OC_PORT = 4096;
const OC_URL = `http://127.0.0.1:${OC_PORT}`;

/** 启动 OpenCode serve 进程（幂等：已有运行中的服务则复用） */
export async function startOpenCodeServer(): Promise<void> {
  // 先检查是否已有服务（可能是外部启动的）
  try {
    const res = await fetch(`${OC_URL}/global/health`, { signal: AbortSignal.timeout(3000) });
    if (res.ok) {
      console.log(`[OpenCodeAdapter] Detected existing service running at ${OC_URL}, reusing`);
      return;
    }
  } catch {}

  console.log('[OpenCodeAdapter] starting opencode serve...');

  // Resolve opencode binary with fallbacks (matches checkOne() logic)
  const home = os.homedir();
  const customPath = path.join(home, '.opencode', 'bin', 'opencode');
  const npmBin = getNpmGlobalBin();
  const npmBinPath = npmBin ? path.join(npmBin, 'opencode') : null;
  const ocBinPath =
    (npmBinPath && fs.existsSync(npmBinPath)) ? npmBinPath :
    fs.existsSync(customPath) ? customPath :
    'opencode'; // fallback to PATH lookup

  console.log(`[OpenCodeAdapter] Using opencode binary: ${ocBinPath}`);

  const dataDir = getDataDir();
  if (!fs.existsSync(dataDir)) {
    console.log(`[OpenCodeAdapter] Creating data directory: ${dataDir}`);
    fs.mkdirSync(dataDir, { recursive: true });
  }
  console.log(`[OpenCodeAdapter] Working directory: ${dataDir}`);

  let child;
  try {
    child = Bun.spawn(
      [ocBinPath, 'serve', '--port', String(OC_PORT), '--hostname', '127.0.0.1'],
      {
        cwd: dataDir,
        env: {
          ...process.env,
          // 环形通信无需真实 key，但 OpenCode 的 Anthropic provider 要求此变量存在
          ANTHROPIC_API_KEY: 'imtoagent-local',
        },
        stdout: 'pipe',
        stderr: 'pipe',
      },
    );
  } catch (err: unknown) {
    console.error(`[OpenCodeAdapter] Failed to start opencode serve: ${err.message}`);
    console.error(`  Binary: ${ocBinPath}`);
    console.error(`  Work dir: ${dataDir} (exists: ${fs.existsSync(dataDir)})`);
    throw new Error(`opencode serve failed: ${err.message}`);
  }

  // 后台收集日志
  (async () => {
    for await (const line of child.stdout as NodeJS.AsyncIterable<Uint8Array>) {
      console.log(`[OpenCodeAdapter] ${new TextDecoder().decode(line).trim()}`);
    }
  })().catch(() => {});
  (async () => {
    for await (const line of child.stderr as NodeJS.AsyncIterable<Uint8Array>) {
      console.log(`[OpenCodeAdapter:err] ${new TextDecoder().decode(line).trim()}`);
    }
  })().catch(() => {});

  // 等待健康检查通过（最多 15 秒）
  const start = Date.now();
  const timeout = 15000;
  while (Date.now() - start < timeout) {
    if (child.exitCode !== undefined && child.exitCode !== null) {
      throw new Error(`OpenCode process exited unexpectedly, exitCode=${child.exitCode}`);
    }
    try {
      const res = await fetch(`${OC_URL}/global/health`, { signal: AbortSignal.timeout(2000) });
      if (res.ok) {
        _ocProcess = child;
        console.log(`[OpenCodeAdapter] Service started successfully (PID=${child.pid}, ${OC_URL})`);
        return;
      }
    } catch {}
    await new Promise(r => setTimeout(r, 500));
  }

  // 超时
  child.kill('SIGTERM');
  throw new Error(`OpenCode service startup timed out (${timeout}ms)`);
}

/** 停止 OpenCode serve 进程 */
export async function stopOpenCodeServer(): Promise<void> {
  if (_ocProcess) {
    console.log('[OpenCodeAdapter] stopping OpenCode service...');
    _ocProcess.kill('SIGTERM');
    await new Promise(r => setTimeout(r, 1000));
    _ocProcess = null;
  }
}
