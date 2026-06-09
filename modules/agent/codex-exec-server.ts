// Codex App-Server 模块（v2 协议）
// 管理 codex app-server 持久进程 + stdio JSON-RPC 通信
// app-server 与 TUI 交互模式共享底层协议 → 自动触发记忆整合

import type { Subprocess } from 'bun';

// ================================================================
// 配置
// ================================================================
export interface ExecServerConfig {
  enabled: boolean;
  startupTimeoutMs: number;
  fallbackToExec: boolean;
  /** 单 turn 最大 tool-call 次数，超限强制终止（防 loop 导致 OOM） */
  maxToolCallsPerTurn: number;
}

let _config: ExecServerConfig = {
  enabled: true,
  startupTimeoutMs: 15000,
  fallbackToExec: true,
  maxToolCallsPerTurn: 20,
};


// ================================================================
// 事件类型
// ================================================================
export interface AgentEvent {
  type: 'text_delta' | 'tool_call' | 'turn_result' | 'error';
  textDelta?: string;
  toolName?: string;
  toolCallId?: string;
  toolInput?: Record<string, unknown>;
  threadId?: string;
  usage?: { inputTokens: number; outputTokens: number };
  costUSD?: number;
  durationMs?: number;
  terminal?: boolean;  // true = 任务真正完成，receiveEvents 停止
  error?: string;
}

// ================================================================
// 客户端（每个 chat 一个实例）
// ================================================================
export class CodexAppServerClient {
  private chatId: string;
  private nextId = 1;
  private pendingRequests: Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }> = new Map();
  private eventQueue: AgentEvent[] = [];
  private resolveNext: ((v: IteratorResult<AgentEvent>) => void) | null = null;
  private _active = false;

  // 单 turn tool-call 计数（循环保护）
  private _turnToolCallCount = 0;
  private _turnActive = false;

  constructor(chatId: string) {
    this.chatId = chatId;
  }

  get connected(): boolean { return this._active; }
  get turnToolCallCount(): number { return this._turnToolCallCount; }
  setActive(active: boolean): void { this._active = active; }

  /** 通知 client turn 已启动，重置计数器 */
  notifyTurnStart(): void {
    this._turnToolCallCount = 0;
    this._turnActive = true;
  }

  /** 通知 turn 结束 */
  notifyTurnEnd(): void {
    this._turnActive = false;
  }

  /** 记录一次 tool-call，返回 true 表示未超限 */
  recordToolCall(name: string): boolean {
    if (!this._turnActive) return true;
    this._turnToolCallCount++;
    if (this._turnToolCallCount > _config.maxToolCallsPerTurn) {
      console.error(`[app-server] ⚠️ tool-call loop detected! chat=${this.chatId.slice(-8)}: ${this._turnToolCallCount} times > limit ${_config.maxToolCallsPerTurn}`);
      return false;
    }
    return true;
  }

  // ================================================================
  // 初始化 & 线程管理
  // ================================================================

  async initialize(): Promise<void> {
    await this._sendRequest('initialize', {
      clientInfo: { name: 'imtoagent', version: '1.0' },
    });
    console.log(`[app-server] initialized chat=${this.chatId.slice(-8)}`);
  }

  async startThread(cwd: string): Promise<string> {
    const result: Record<string, unknown> = await this._sendRequest('thread/start', {
      cwd,
      model: 'gpt-5.5',
      modelProvider: 'imtoagent',
      sandbox: 'danger-full-access',
      approvalPolicy: 'never',
    });
    const threadId = result?.thread?.id || '';
    if (!threadId) throw new Error('thread/start did not return thread.id');
    getAppServerManager().registerThread(threadId, this.chatId);
    console.log(`[app-server] thread started=${threadId.slice(-8)} chat=${this.chatId.slice(-8)}`);
    return threadId;
  }

  async resumeThread(threadId: string): Promise<void> {
    // app-server v2: thread/resume 用于跨进程恢复
    const result: Record<string, unknown> = await this._sendRequest('thread/resume', { threadId });
    getAppServerManager().registerThread(threadId, this.chatId);
    console.log(`[app-server] thread resumed=${threadId.slice(-8)} chat=${this.chatId.slice(-8)}`);
  }

  // ================================================================
  // 发送消息
  // ================================================================

  async sendPrompt(
    threadId: string,
    prompt: string,
    cwd: string,
    systemPrompt?: string,
    toolResults?: Array<{ toolCallId: string; result: string; isError?: boolean }>
  ): Promise<void> {
    this.notifyTurnStart();
    
    // 构造 input items：文本 + 工具结果
    const input: Array<Record<string, unknown>> = [];
    
    // 如果有文本内容，添加文本消息
    if (prompt.trim()) {
      input.push({ type: 'text', text: prompt });
    }
    
    // 添加工具执行结果（OpenAI function_call_output 格式）
    if (toolResults && toolResults.length > 0) {
      for (const tr of toolResults) {
        input.push({
          type: 'function_call_output',
          call_id: tr.toolCallId,
          output: tr.result,
        });
      }
    }
    
    const req: Record<string, unknown> = {
      threadId,
      input,
      cwd,
      model: 'gpt-5.5',
      effort: 'medium',
    };
    if (systemPrompt) {
      req.systemInstructions = systemPrompt;
    }
    await this._sendRequest('turn/start', req);
  }

  async *receiveEvents(): AsyncGenerator<AgentEvent> {
    while (this._active) {
      const event = await new Promise<AgentEvent>((resolve) => {
        if (this.eventQueue.length > 0) {
          resolve(this.eventQueue.shift()!);
        } else {
          this.resolveNext = (v: IteratorResult<AgentEvent>) => {
            this.resolveNext = null;
            if (v.done) resolve({ type: 'error', error: 'closed' });
            else resolve(v.value);
          };
        }
      });

      yield event;

      // 只在 agent 空闲（terminal）或出错时停止
      if (event.type === 'error') break;
      if (event.type === 'turn_result' && event.terminal) break;
    }
  }

  close(): void {
    this._active = false;
    for (const [, p] of this.pendingRequests) {
      p.reject(new Error('client closed'));
    }
    this.pendingRequests.clear();
    if (this.resolveNext) {
      this.resolveNext({ done: true, value: undefined });
      this.resolveNext = null;
    }
  }

  // ================================================================
  // Manager 调用接口
  // ================================================================

  dispatchEvent(event: AgentEvent): void {
    if (!this._active) return;
    if (this.resolveNext) {
      this.resolveNext({ done: false, value: event });
    } else {
      this.eventQueue.push(event);
    }
  }

  dispatchResponse(id: number, result: unknown, error?: { code: number; message: string }): void {
    const pending = this.pendingRequests.get(id);
    if (pending) {
      this.pendingRequests.delete(id);
      if (error) {
        pending.reject(new Error(`app-server error: ${error.message} (code=${error.code})`));
      } else {
        pending.resolve(result);
      }
    }
  }

  // ================================================================
  // 内部
  // ================================================================

  _sendRequest(method: string, params: Record<string, unknown>): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      const req = JSON.stringify({ jsonrpc: '2.0', id, method, params });
      const timer = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`app-server request timeout: ${method}`));
      }, 300000);
      this.pendingRequests.set(id, { resolve, reject });

      const ok = getAppServerManager()._writeStdin(req + '\n');
      if (!ok) {
        clearTimeout(timer);
        this.pendingRequests.delete(id);
        reject(new Error(`app-server stdin write failed: ${method}`));
      }
    });
  }
}

// ================================================================
// 进程管理器（单例）
// ================================================================
class CodexAppServerManager {
  private process: Subprocess | null = null;
  private clients: Map<string, CodexAppServerClient> = new Map();
  private activeChatId: string | null = null;
  private _shuttingDown = false;
  private _startPromise: Promise<void> | null = null;
  private stdoutBuffer = '';
  private readLoopRunning = false;
  private _initialized = false;  // app-server 只接受一次 initialize
  private _generation = 0;       // 每次进程重启递增，用于判断 thread 是否过期
  private _threadChatMap: Map<string, string> = new Map(); // threadId → chatId 路由映射

  async ensureRunning(): Promise<void> {
    if (this._shuttingDown) throw new Error('app-server is shutting down');
    if (this.process && !this.process.killed) return;
    if (this._startPromise) { await this._startPromise; return; }
    this._startPromise = this._spawn();
    try { await this._startPromise; } finally { this._startPromise = null; }
  }

  async getClient(chatId: string): Promise<CodexAppServerClient> {
    await this.ensureRunning();

    // 回收之前的活跃客户端
    const prev = this.clients.get(this.activeChatId || '');
    if (prev && this.activeChatId !== chatId) prev.setActive(false);

    let client = this.clients.get(chatId);
    if (!client) {
      client = new CodexAppServerClient(chatId);
      this.clients.set(chatId, client);
    }

    // 先设置 activeChatId，再发请求——防止 readLoop 先收到响应但找不到 client
    this.activeChatId = chatId;

    if (!this._initialized) {
      client.setActive(true);
      await client.initialize();
      this._initialized = true;
    } else {
      client.setActive(true);
    }

    return client;
  }

  /** 记录 threadId → chatId 映射（供 _processLine 路由用） */
  registerThread(threadId: string, chatId: string): void {
    this._threadChatMap.set(threadId, chatId);
  }

  removeClient(chatId: string): void {
    const client = this.clients.get(chatId);
    if (client) { client.close(); this.clients.delete(chatId); }
    if (this.activeChatId === chatId) this.activeChatId = null;
    // 清理该 chat 的所有 thread 映射
    for (const [tid, cid] of this._threadChatMap) {
      if (cid === chatId) this._threadChatMap.delete(tid);
    }
  }

  async shutdown(): Promise<void> {
    this._shuttingDown = true;
    for (const [, c] of this.clients) c.close();
    this.clients.clear();
    this.activeChatId = null;
    if (this.process && !this.process.killed) {
      try {
        this.process.kill('SIGTERM');
        await new Promise<void>((resolve) => {
          const t = setTimeout(() => { try { this.process?.kill('SIGKILL'); } catch {} resolve(); }, 3000);
          this.process!.exited.then(() => { clearTimeout(t); resolve(); });
        });
      } catch {}
    }
    this.process = null;
    console.log('[app-server] shut down');
  }
  /** 健康检查：进程存活但 readLoop 已停止 */
  needsRestart(): boolean {
    return this.process !== null && !this.process.killed && !this.readLoopRunning;
  }

  /** 强制重启 app-server（用于健康检查自动恢复） */
  async forceRestart(): Promise<void> {
    console.warn('[app-server] Health check triggered forced restart...');
    await this.shutdown();
    this._shuttingDown = false;
    this._initialized = false;
  }

  _writeStdin(data: string): boolean {
    if (!this.process || this.process.killed) return false;
    try { this.process.stdin!.write(data); return true; } catch { return false; }
  }

  private async _spawn(): Promise<void> {
    console.log('[app-server] starting codex app-server (stdio)...');
    this.process = Bun.spawn(
      ['codex', 'app-server',
        '--listen', 'stdio://',
        '-c', 'model_provider=imtoagent',
        '-c', 'sandbox.mode=danger-full-access',
        '--enable', 'memories',
      ],
      { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' },
    );
    this._readStderr().catch((err) => {
      console.error(`[app-server] stderr reader error: ${err.message}`);
    });
    this.process.exited
      .then(async (code: number | null) => {
        console.error(`[app-server] process exited code=${code}`);
        this.process = null;
        this.readLoopRunning = false;
        this._initialized = false;
        this._generation++;

        // 先等待启动 promise 完成，避免 _spawn 还在等 _startReadLoop
        if (this._startPromise) {
          try { await this._startPromise; } catch {}
          this._startPromise = null;
        }

        // 通知崩溃，然后清理
        this._notifyCrash();
        for (const [, c] of this.clients) {
          try { c.close(); } catch {}
        }
        this.clients.clear();
        this.activeChatId = null;
        this._threadChatMap.clear();
      })
      .catch((err) => {
        console.error(`[app-server] process.exited handler error: ${err.message}`);
      });
    // 给 app-server 短暂时间完成内部初始化
    await new Promise(r => setTimeout(r, 500));
    this._startReadLoop();
    console.log('[app-server] ready (stdio)');
  }

  private _startReadLoop(): void {
    if (this.readLoopRunning) return;
    this.readLoopRunning = true;
    this._readLoop();
  }

  private async _readLoop(): Promise<void> {
    if (!this.process?.stdout) return;
    const reader = this.process.stdout.getReader();
    const decoder = new TextDecoder();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        this.stdoutBuffer += decoder.decode(value, { stream: true });
        let nl: number;
        while ((nl = this.stdoutBuffer.indexOf('\n')) !== -1) {
          const line = this.stdoutBuffer.slice(0, nl).trim();
          this.stdoutBuffer = this.stdoutBuffer.slice(nl + 1);
          if (line) this._processLine(line);
        }
      }
    } catch (e: unknown) {
      if (!this._shuttingDown) console.error(`[app-server] read error: ${e.message}`);
    } finally {
      try { reader.releaseLock(); } catch {}
      this.readLoopRunning = false;
    }
  }

  private _processLine(line: string): void {
    let msg: Record<string, unknown>;
    try { msg = JSON.parse(line); } catch { return; }

    if ('id' in msg && msg.id != null) {
      const active = this.clients.get(this.activeChatId || '');
      if (active) active.dispatchResponse(msg.id, msg.result, msg.error);
    } else if (msg.method) {
      // 优先用 params.threadId 路由到正确的 chat，fallback activeChatId
      const params = (msg.params || {}) as Record<string, unknown>;
      const threadId = params.threadId as string | undefined;
      const chatId = (threadId && this._threadChatMap.get(threadId)) || this.activeChatId || '';
      const target = this.clients.get(chatId);
      if (target) this._handleNotification(target, msg.method as string, params);
    }
  }

  private _handleNotification(client: CodexAppServerClient, method: string, params: Record<string, unknown>): void {
    try {
      switch (method) {
        case 'thread/started':
        client.notifyTurnStart();
        break;

      case 'turn/started':
        client.notifyTurnStart();
        break;

      case 'thread/status/changed':
        // params: { threadId, status: { type: "idle" | "active" } }
        if (params.status?.type === 'idle') {
          // agent 真正停下来等用户输入 → 任务完成
          client.notifyTurnEnd();
          client.dispatchEvent({ type: 'turn_result', terminal: true, usage: { inputTokens: 0, outputTokens: 0 } });
        }
        break;

        case 'item/started':
        case 'item/completed': {
          // 统计 tool-use / function_call 类型
          const itemType = params.item?.type;
          if (itemType === 'tool_use' || itemType === 'function_call') {
            const toolName = params.item?.name || params.item?.function_name || 'unknown';
            const toolCallId = params.item?.call_id || params.item?.id || '';
            
            // 派发 tool_call 事件，带上 call_id
            if (method === 'item/completed') {
              client.dispatchEvent({
                type: 'tool_call',
                toolName,
                toolCallId,
              });
              
              const ok = client.recordToolCall(toolName);
              if (!ok) {
                // 超限，发送 error 事件强制终止本轮
                client.dispatchEvent({
                  type: 'error',
                  error: `⚠️ Tool-call loop detected: this turn has reached ${client.turnToolCallCount} tool calls (limit ${_config.maxToolCallsPerTurn}), forcefully terminated. Consider breaking into smaller tasks.`,
                });
              }
            }
          }
          break;
        }

        case 'remoteControl/status/changed':
        case 'account/rateLimits/updated':
        case 'thread/tokenUsage/updated':
          // 元数据通知，暂不处理
          break;

        case 'item/agentMessage/delta':
          if (params.delta) client.dispatchEvent({ type: 'text_delta', textDelta: params.delta });
          break;

        case 'item/toolCallOutput/delta': {
          // 工具执行 stdout 增量 — 通过 text_delta 回传
          const delta = (params as Record<string, unknown>).delta as string | undefined;
          if (delta) {
            console.log(`[app-server] tool output delta: ${delta.slice(0, 120)}`);
            client.dispatchEvent({ type: 'text_delta', textDelta: delta });
          }
          break;
        }

        case 'item/toolCallOutput/completed': {
          // 工具执行 stdout 完成
          const output = (params as Record<string, unknown>).output as string | undefined;
          if (output !== undefined && output.length > 0) {
            console.log(`[app-server] tool output completed: ${output.slice(0, 200)}`);
            client.dispatchEvent({ type: 'text_delta', textDelta: output });
          }
          break;
        }

        case 'item/toolCallOutput/stderrDelta': {
          // stderr 增量 → 回传给 client（和 stdout 一样）
          const delta = (params as Record<string, unknown>).delta as string | undefined;
          if (delta) {
            console.log(`[app-server] tool stderr: ${delta.slice(0, 200)}`);
            client.dispatchEvent({ type: 'text_delta', textDelta: delta });
          }
          break;
        }

        case 'item/commandExecution/outputDelta': {
          // 命令执行输出流（exec_command 的实际 stdout）
          const delta = (params as Record<string, unknown>).delta as string | undefined;
          if (delta) {
            console.log(`[app-server] cmd output delta: ${delta.slice(0, 200)}`);
            client.dispatchEvent({ type: 'text_delta', textDelta: delta });
          }
          break;
        }

        case 'item/commandExecution/terminalInteraction': {
          // 需要终端交互（如 sudo 密码提示），暂忽略（sandbox 模式通常不需要）
          const stdin = (params as Record<string, unknown>).stdin as string | undefined;
          if (stdin !== undefined) console.log(`[app-server] cmd terminal interaction, stdin=${stdin.length} chars`);
          break;
        }

        case 'turn/completed':
          client.notifyTurnEnd();
          client.dispatchEvent({
            type: 'turn_result',
            terminal: false, // 非终点，agent 可能自动继续
            usage: {
              inputTokens: params.turn?.usage?.inputTokens || 0,
              outputTokens: params.turn?.usage?.outputTokens || 0,
            },
            costUSD: params.turn?.usage?.costUSD || 0,
            durationMs: params.turn?.durationMs || 0,
          });
          break;

        case 'item/reasoning/textDelta':
        case 'item/reasoning/summaryTextDelta':
          break;

        case 'turn/plan/updated':
        case 'turn/diff/updated':
          break;

        case 'warning':
        case 'deprecationNotice':
          console.warn(`[app-server] ${method}:`, params);
          break;

        default: { console.log(`[app-server] UNKNOWN notification: method=${method}, params=${JSON.stringify(params).slice(0,200)}`);
          // 静默忽略未知通知
          break;
        }
      }
    } catch (err) {
      console.error(`[app-server] Error handling notification ${method}:`, err);
    }
  }

  private async _readStderr(): Promise<void> {
    if (!this.process) return;
    try {
      const stderr = await new Response(this.process.stderr).text();
      if (stderr.trim()) console.error(`[app-server] stderr:`, stderr.slice(0, 500));
    } catch {}
  }

  /** 进程异常退出时通知所有活跃 client */
  private _notifyCrash(): void {
    for (const [, c] of this.clients) {
      try {
        c.dispatchEvent({
          type: 'error',
          error: 'app-server process crashed unexpectedly',
        });
        c.close();
      } catch {}
    }
  }

  // 暴露当前进程代际，codex.ts 用于判断 thread 是否过期
  get generation(): number { return this._generation; }
}

// 单例
let _manager: CodexAppServerManager | null = null;

export function getAppServerManager(): CodexAppServerManager {
  if (!_manager) _manager = new CodexAppServerManager();
  return _manager;
}

// 向后兼容别名
export const getExecServerManager = getAppServerManager;

export async function shutdownAppServer(): Promise<void> {
  if (_manager) { await _manager.shutdown(); _manager = null; }
}

// 向后兼容别名
export const shutdownExecServer = shutdownAppServer;

// 向后兼容的类型别名
