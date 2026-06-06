// ================================================================
// ContextManager — 多后端上下文管理（四层渐进式压缩）
// ================================================================
// 为 IMtoAgent 的所有后端（Anthropic/Responses/OpenAI）提供统一的
// 上下文管理：token 预算控制、四层渐进式压缩、智能截断。
//
// 四层策略（参考 Claude Code 设计）：
//   Layer 1: HISTORY_SNIP     — 按工具类型语义裁剪 tool output（零成本，40% 触发）
//   Layer 2: MicroCompact     — 去重 + 清理过期/冗余结果（零成本，60% 触发）
//   Layer 3: Context Collapse — 折叠连续工具调用段（零成本，75% 触发）
//   Layer 4: Auto-Compact     — 全对话 LLM 摘要（高成本，85% 触发，提前留出 token 余量）
// ================================================================

import type {
  AnthropicRequestBody,
  AnthropicMessage,
  AnthropicContentBlock,
  OpenAIRequestBody,
  OpenAIMessage,
  OpenAIToolCall,
} from './proxy-types';

// ================================================================
// 类型定义
// ================================================================

/** 后端类型 */
export type BackendType = 'anthropic' | 'responses' | 'openai';

/** 上下文预算配置 */
export interface ContextBudget {
  maxTokens: number;
  reservedForResponse: number;
  maxInputTokens: number;
}

/** 工具分类（跨 Agentic 框架统一） */
export enum ToolCategory {
  // 执行类
  COMMAND_EXEC = 'command_exec',    // bash/shell/exec
  COMMAND_LIST = 'command_list',    // ls/dir/tree
  COMMAND_FIND = 'command_find',    // find/grep/locate

  // 文件操作
  FILE_READ = 'file_read',          // 读取文件内容
  FILE_WRITE = 'file_write',        // 写入/创建文件
  FILE_EDIT = 'file_edit',          // 编辑/patch 文件
  FILE_GLOB = 'file_glob',          // glob/match

  // 版本控制
  GIT_STATUS = 'git_status',
  GIT_DIFF = 'git_diff',
  GIT_LOG = 'git_log',
  GIT_OTHER = 'git_other',

  // 开发工具
  TEST_RESULT = 'test_result',      // 测试输出
  BUILD_RESULT = 'build_result',    // 编译/构建输出
  LINT_RESULT = 'lint_result',      // lint 输出

  // Web/网络
  WEB_FETCH = 'web_fetch',          // 网页抓取
  WEB_SEARCH = 'web_search',        // 搜索

  // 视觉/图片
  SCREENSHOT = 'screenshot',        // 截图/图片

  // 搜索/编辑
  SEARCH_REPLACE = 'search_replace', // 搜索替换
  TASK_DELEGATE = 'task_delegate',   // 任务委派
  TODO_WRITE = 'todo_write',         // TODO 管理

  // 特殊
  ERROR_OUTPUT = 'error_output',     // 错误输出（不压缩）
  EMPTY_SUCCESS = 'empty_success',   // 空/极短成功（信号化）
  UNKNOWN = 'unknown',
}

/** 工具名称 → 分类 映射注册表
 * 覆盖主流 Agentic 框架：Codex, Claude Code, Anthropic, OpenAI, MCP 等
 */
const TOOL_NAME_REGISTRY: Record<string, ToolCategory> = {
  // ---- Codex ----
  exec_command: ToolCategory.COMMAND_EXEC,
  write_stdin: ToolCategory.COMMAND_EXEC,
  apply_patch: ToolCategory.FILE_EDIT,
  view_image: ToolCategory.SCREENSHOT,
  request_user_input: ToolCategory.UNKNOWN,
  update_plan: ToolCategory.UNKNOWN,
  create_goal: ToolCategory.UNKNOWN,
  get_goal: ToolCategory.UNKNOWN,
  update_goal: ToolCategory.UNKNOWN,

  // ---- Claude Code ----
  Bash: ToolCategory.COMMAND_EXEC,
  Read: ToolCategory.FILE_READ,
  Write: ToolCategory.FILE_WRITE,
  Edit: ToolCategory.FILE_EDIT,
  MultiEdit: ToolCategory.FILE_EDIT,
  NotebookEdit: ToolCategory.FILE_EDIT,
  Grep: ToolCategory.COMMAND_FIND,
  LS: ToolCategory.COMMAND_LIST,
  Glob: ToolCategory.FILE_GLOB,
  WebFetch: ToolCategory.WEB_FETCH,
  WebSearch: ToolCategory.WEB_SEARCH,
  Task: ToolCategory.TASK_DELEGATE,
  TodoWrite: ToolCategory.TODO_WRITE,
  Skill: ToolCategory.COMMAND_EXEC,

  // ---- 通用 shell 类 ----
  bash: ToolCategory.COMMAND_EXEC,
  shell: ToolCategory.COMMAND_EXEC,
  exec: ToolCategory.COMMAND_EXEC,
  execute: ToolCategory.COMMAND_EXEC,
  run: ToolCategory.COMMAND_EXEC,
  run_command: ToolCategory.COMMAND_EXEC,
  run_shell: ToolCategory.COMMAND_EXEC,
  run_script: ToolCategory.COMMAND_EXEC,
  execute_command: ToolCategory.COMMAND_EXEC,
  execute_shell: ToolCategory.COMMAND_EXEC,

  // ---- 通用读取类 ----
  read_file: ToolCategory.FILE_READ,
  read: ToolCategory.FILE_READ,
  view_file: ToolCategory.FILE_READ,
  view: ToolCategory.FILE_READ,
  cat: ToolCategory.FILE_READ,
  open_file: ToolCategory.FILE_READ,
  file_read: ToolCategory.FILE_READ,
  get_file: ToolCategory.FILE_READ,

  // ---- 通用写入类 ----
  write_file: ToolCategory.FILE_WRITE,
  write: ToolCategory.FILE_WRITE,
  create_file: ToolCategory.FILE_WRITE,
  save_file: ToolCategory.FILE_WRITE,
  file_write: ToolCategory.FILE_WRITE,
  save: ToolCategory.FILE_WRITE,

  // ---- 通用编辑类 ----
  edit: ToolCategory.FILE_EDIT,
  edit_file: ToolCategory.FILE_EDIT,
  modify: ToolCategory.FILE_EDIT,
  modify_file: ToolCategory.FILE_EDIT,
  str_replace: ToolCategory.SEARCH_REPLACE,
  str_replace_editor: ToolCategory.SEARCH_REPLACE,
  search_replace: ToolCategory.SEARCH_REPLACE,
  apply_edit: ToolCategory.FILE_EDIT,
  patch: ToolCategory.FILE_EDIT,

  // ---- 目录列表类 ----
  ls: ToolCategory.COMMAND_LIST,
  dir: ToolCategory.COMMAND_LIST,
  list_directory: ToolCategory.COMMAND_LIST,
  list_dir: ToolCategory.COMMAND_LIST,
  list_files: ToolCategory.COMMAND_LIST,
  list: ToolCategory.COMMAND_LIST,
  tree: ToolCategory.COMMAND_LIST,

  // ---- 搜索类 ----
  grep: ToolCategory.COMMAND_FIND,
  find: ToolCategory.COMMAND_FIND,
  search: ToolCategory.COMMAND_FIND,
  search_files: ToolCategory.COMMAND_FIND,
  search_codebase: ToolCategory.COMMAND_FIND,
  locate: ToolCategory.COMMAND_FIND,
  rg: ToolCategory.COMMAND_FIND,
  ag: ToolCategory.COMMAND_FIND,

  // ---- Git 类 ----
  git: ToolCategory.GIT_OTHER,
  git_status: ToolCategory.GIT_STATUS,
  git_diff: ToolCategory.GIT_DIFF,
  git_log: ToolCategory.GIT_LOG,

  // ---- 测试类 ----
  test: ToolCategory.TEST_RESULT,
  run_test: ToolCategory.TEST_RESULT,
  run_tests: ToolCategory.TEST_RESULT,
  pytest: ToolCategory.TEST_RESULT,
  jest: ToolCategory.TEST_RESULT,
  mocha: ToolCategory.TEST_RESULT,
  vitest: ToolCategory.TEST_RESULT,
  cargo_test: ToolCategory.TEST_RESULT,
  go_test: ToolCategory.TEST_RESULT,

  // ---- 构建类 ----
  build: ToolCategory.BUILD_RESULT,
  compile: ToolCategory.BUILD_RESULT,
  make: ToolCategory.BUILD_RESULT,
  cmake: ToolCategory.BUILD_RESULT,
  cargo_build: ToolCategory.BUILD_RESULT,
  go_build: ToolCategory.BUILD_RESULT,

  // ---- Lint 类 ----
  lint: ToolCategory.LINT_RESULT,
  eslint: ToolCategory.LINT_RESULT,
  rubocop: ToolCategory.LINT_RESULT,
  flake8: ToolCategory.LINT_RESULT,
  pylint: ToolCategory.LINT_RESULT,

  // ---- 网络类 ----
  fetch: ToolCategory.WEB_FETCH,
  curl: ToolCategory.WEB_FETCH,
  wget: ToolCategory.WEB_FETCH,
  http: ToolCategory.WEB_FETCH,
  web_fetch: ToolCategory.WEB_FETCH,
  scrape: ToolCategory.WEB_FETCH,

  // ---- 搜索/网页 ----
  search_web: ToolCategory.WEB_SEARCH,
  web_search: ToolCategory.WEB_SEARCH,
  duckduckgo: ToolCategory.WEB_SEARCH,
  google_search: ToolCategory.WEB_SEARCH,

  // ---- 截图/图片 ----
  screenshot: ToolCategory.SCREENSHOT,
  capture: ToolCategory.SCREENSHOT,
  take_screenshot: ToolCategory.SCREENSHOT,

  // ---- 任务委派 ----
  delegate: ToolCategory.TASK_DELEGATE,
  task: ToolCategory.TASK_DELEGATE,
  subagent: ToolCategory.TASK_DELEGATE,

  // ---- TODO ----
  todo: ToolCategory.TODO_WRITE,
  todo_write: ToolCategory.TODO_WRITE,
  task_list: ToolCategory.TODO_WRITE,

  // ---- 通用 glob ----
  glob: ToolCategory.FILE_GLOB,
};

/** ContextManager 配置 */
export interface ContextConfig {
  backend: BackendType;
  budget: ContextBudget;
  keepRecentRounds: number;
  maxToolOutputChars: number;
  truncateToolOutput: boolean;
  simplifySuccessOutputs: boolean;
  preserveSystemPrompt: boolean;
  preserveReasoning: boolean;
  debugLog?: boolean;

  // 四层压缩控制
  compressionLayers?: {
    historySnip?: boolean;       // Layer 1: 工具语义裁剪
    microCompact?: boolean;      // Layer 2: 去重/清理
    contextCollapse?: boolean;   // Layer 3: 折叠连续工具段
    autoCompact?: boolean;       // Layer 4: LLM 摘要
  };

  // 触发阈值（预算使用率）
  compressionThresholds?: {
    layer1Start?: number;  // 默认 0.40
    layer2Start?: number;  // 默认 0.60
    layer3Start?: number;  // 默认 0.75
    layer4Start?: number;  // 默认 0.85
  };

  // Layer 4 配置
  autoCompactConfig?: {
    maxSummaryTokens?: number;  // 摘要最大 tokens（默认 500）
    keepLastRounds?: number;    // 保留最近几轮不摘要（默认 2）
    callback?: (messages: string) => Promise<string>;  // 外部 LLM 摘要回调
  };
}

/** 统一的消息表示（内部使用） */
interface NormalizedMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  toolCalls?: Array<{ id: string; name: string; arguments: string }>;
  toolCallId?: string;
  reasoning?: string;
  metadata: Record<string, unknown>;
}

/** Responses API input item */
interface ResponsesItem {
  type: string;
  role?: string;
  call_id?: string;
  name?: string;
  arguments?: string;
  output?: string;
  content?: unknown;
  summary?: Array<{ text?: string; summary_text?: string }>;
  [key: string]: unknown;
}

// ================================================================
// 默认配置
// ================================================================

const DEFAULT_BUDGET: ContextBudget = {
  maxTokens: 64000,
  reservedForResponse: 8000,
  maxInputTokens: 48000,
};

const DEFAULT_CONFIG: ContextConfig = {
  backend: 'openai',
  budget: DEFAULT_BUDGET,
  keepRecentRounds: 2,
  maxToolOutputChars: 2000,
  truncateToolOutput: true,
  simplifySuccessOutputs: true,
  preserveSystemPrompt: true,
  preserveReasoning: false,
  debugLog: false,
  compressionLayers: {
    historySnip: true,
    microCompact: true,
    contextCollapse: true,
    autoCompact: true,
  },
  compressionThresholds: {
    layer1Start: 0.40,  // HISTORY_SNIP: 零成本规则裁剪，40% 开始
    layer2Start: 0.60,  // MicroCompact: 去重+清理，60% 开始
    layer3Start: 0.75,  // Context Collapse: 合并批量调用，75% 开始
    layer4Start: 0.85,  // Auto-Compact: LLM 摘要，85% 开始（留足 token 给摘要本身）
  },
};

// ================================================================
// ContextManager 类
// ================================================================

export class ContextManager {
  private config: ContextConfig;

  /** tool_call_id → tool_name 映射（每轮 process 重建） */
  private toolNameMap: Map<string, string> = new Map();

  constructor(config?: Partial<ContextConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    if (config?.budget) {
      this.config.budget = { ...DEFAULT_BUDGET, ...config.budget };
    }
    // 深层合并嵌套配置
    if (config?.compressionLayers) {
      this.config.compressionLayers = {
        ...DEFAULT_CONFIG.compressionLayers,
        ...config.compressionLayers,
      };
    }
    if (config?.compressionThresholds) {
      this.config.compressionThresholds = {
        ...DEFAULT_CONFIG.compressionThresholds,
        ...config.compressionThresholds,
      };
    }
    if (config?.autoCompactConfig) {
      this.config.autoCompactConfig = {
        ...DEFAULT_CONFIG.autoCompactConfig,
        ...config.autoCompactConfig,
      };
    }
  }

  // ============================================================
  // 主入口：同步版本（Layer 1-3 + budget 兜底）
  // ============================================================
  process(input: unknown): unknown {
    switch (this.config.backend) {
      case 'anthropic':
        return this.processAnthropic(input as AnthropicRequestBody);
      case 'responses':
        return this.processResponses(input as Record<string, unknown>);
      case 'openai':
        return this.processOpenAI(input as OpenAIRequestBody);
      default:
        return input;
    }
  }

  // ============================================================
  // 主入口：异步版本（含 Layer 4 LLM 摘要）
  // ============================================================
  async processAsync(input: unknown): Promise<unknown> {
    switch (this.config.backend) {
      case 'anthropic':
        return this.processAnthropicAsync(input as AnthropicRequestBody);
      case 'responses':
        return this.processResponsesAsync(input as Record<string, unknown>);
      case 'openai':
        return this.processOpenAIAsync(input as OpenAIRequestBody);
      default:
        return input;
    }
  }

  // ============================================================
  // Anthropic 格式处理
  // ============================================================
  private processAnthropic(body: AnthropicRequestBody): AnthropicRequestBody {
    const systemPrompt = body.system;
    let messages = this.normalizeAnthropicMessages(body.messages || []);
    this.buildToolNameMap(messages);
    messages = this.applyTransformations(messages);
    messages = this.enforceTokenBudget(messages);
    const result: AnthropicRequestBody = {
      ...body,
      messages: this.denormalizeToAnthropic(messages),
    };
    if (this.config.preserveSystemPrompt) {
      result.system = systemPrompt;
    }
    this.logStats('Anthropic', body.messages?.length || 0, messages.length);
    return result;
  }

  private async processAnthropicAsync(body: AnthropicRequestBody): Promise<AnthropicRequestBody> {
    const systemPrompt = body.system;
    let messages = this.normalizeAnthropicMessages(body.messages || []);
    this.buildToolNameMap(messages);
    // Step 0: Unconditional pre-normalization (always runs, independent of budget)
    messages = this.normalizeToolOutputs(messages);
    messages = await this.applyTransformationsAsync(messages);
    messages = this.enforceTokenBudget(messages);
    const result: AnthropicRequestBody = {
      ...body,
      messages: this.denormalizeToAnthropic(messages),
    };
    if (this.config.preserveSystemPrompt) {
      result.system = systemPrompt;
    }
    this.logStats('Anthropic', body.messages?.length || 0, messages.length);
    return result;
  }

  // ============================================================
  // Responses API 格式处理
  // ============================================================
  private processResponses(body: Record<string, unknown>): Record<string, unknown> {
    const input = (body.input as ResponsesItem[]) || [];
    const systemItems = input.filter((m) => m.type === 'system' || m.role === 'system');
    const reasoningItems = this.config.preserveReasoning
      ? input.filter((m) => m.type === 'reasoning')
      : [];
    const conversationItems = input.filter(
      (m) => m.type !== 'system' && m.type !== 'reasoning' && m.role !== 'system'
    );
    let messages = this.normalizeResponsesMessages(conversationItems);
    this.buildToolNameMap(messages);
    messages = this.applyTransformations(messages);
    messages = this.enforceTokenBudget(messages);
    const processedInput: ResponsesItem[] = [
      ...(this.config.preserveSystemPrompt ? systemItems : []),
      ...reasoningItems,
      ...this.denormalizeToResponses(messages),
    ];
    this.logStats('Responses', input.length, processedInput.length);
    return { ...body, input: processedInput };
  }

  private async processResponsesAsync(body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const input = (body.input as ResponsesItem[]) || [];
    const systemItems = input.filter((m) => m.type === 'system' || m.role === 'system');
    const reasoningItems = this.config.preserveReasoning
      ? input.filter((m) => m.type === 'reasoning')
      : [];
    const conversationItems = input.filter(
      (m) => m.type !== 'system' && m.type !== 'reasoning' && m.role !== 'system'
    );
    let messages = this.normalizeResponsesMessages(conversationItems);
    this.buildToolNameMap(messages);
    // Step 0: Unconditional pre-normalization (always runs, independent of budget)
    messages = this.normalizeToolOutputs(messages);
    messages = await this.applyTransformationsAsync(messages);
    messages = this.enforceTokenBudget(messages);
    const processedInput: ResponsesItem[] = [
      ...(this.config.preserveSystemPrompt ? systemItems : []),
      ...reasoningItems,
      ...this.denormalizeToResponses(messages),
    ];
    this.logStats('Responses', input.length, processedInput.length);
    return { ...body, input: processedInput };
  }

  // ============================================================
  // OpenAI 格式处理
  // ============================================================
  private processOpenAI(body: OpenAIRequestBody): OpenAIRequestBody {
    const messages = body.messages || [];
    const systemMessages = messages.filter((m) => m.role === 'system');
    const conversationMessages = messages.filter((m) => m.role !== 'system');
    let normalized = this.normalizeOpenAIMessages(conversationMessages);
    this.buildToolNameMap(normalized);
    normalized = this.applyTransformations(normalized);
    normalized = this.enforceTokenBudget(normalized);
    const result: OpenAIRequestBody = {
      ...body,
      messages: [
        ...(this.config.preserveSystemPrompt ? systemMessages : []),
        ...this.denormalizeToOpenAI(normalized),
      ],
    };
    this.logStats('OpenAI', messages.length, result.messages.length);
    return result;
  }

  private async processOpenAIAsync(body: OpenAIRequestBody): Promise<OpenAIRequestBody> {
    const messages = body.messages || [];
    const systemMessages = messages.filter((m) => m.role === 'system');
    const conversationMessages = messages.filter((m) => m.role !== 'system');
    let normalized = this.normalizeOpenAIMessages(conversationMessages);
    this.buildToolNameMap(normalized);
    // Step 0: Unconditional pre-normalization (always runs, independent of budget)
    normalized = this.normalizeToolOutputs(normalized);
    normalized = await this.applyTransformationsAsync(normalized);
    normalized = this.enforceTokenBudget(normalized);
    const result: OpenAIRequestBody = {
      ...body,
      messages: [
        ...(this.config.preserveSystemPrompt ? systemMessages : []),
        ...this.denormalizeToOpenAI(normalized),
      ],
    };
    this.logStats('OpenAI', messages.length, result.messages.length);
    return result;
  }

  // ============================================================
  // 工具名映射：从 assistant tool_calls 建立 tool_call_id → name 映射
  // ============================================================
  private buildToolNameMap(messages: NormalizedMessage[]): void {
    this.toolNameMap.clear();
    for (const m of messages) {
      if (m.role === 'assistant' && m.toolCalls) {
        for (const tc of m.toolCalls) {
          if (tc.id) this.toolNameMap.set(tc.id, tc.name);
        }
      }
    }
  }

  private getToolName(toolCallId?: string): string | undefined {
    if (!toolCallId) return undefined;
    return this.toolNameMap.get(toolCallId);
  }

  // ============================================================
  // 工具分类器（核心：跨 Agentic 框架统一识别）
  // ============================================================

  /**
   * 推断 tool 的分类：
   * 1. 先查 registry（tool_name 匹配）
   * 2. 再按内容模式推断（文件内容/命令输出/测试等）
   */
  private categorizeToolOutput(msg: NormalizedMessage): ToolCategory {
    const toolName = this.getToolName(msg.toolCallId);

    // 优先：tool_name 查 registry
    if (toolName) {
      // 精确匹配
      if (TOOL_NAME_REGISTRY[toolName]) return TOOL_NAME_REGISTRY[toolName];
      // 前缀匹配（处理 mcp__filesystem__read_file 等）
      for (const [key, cat] of Object.entries(TOOL_NAME_REGISTRY)) {
        if (toolName.includes(key)) return cat;
      }
      // MCP 工具：mcp__<server>__<tool_name>
      const mcpMatch = toolName.match(/^mcp__\w+__(\w+)$/);
      if (mcpMatch) {
        const baseName = mcpMatch[1];
        if (TOOL_NAME_REGISTRY[baseName]) return TOOL_NAME_REGISTRY[baseName];
      }
    }

    // 兜底：按内容模式推断
    return this.inferCategoryFromContent(msg.content);
  }

  /** 从内容推断工具类别 */
  private inferCategoryFromContent(content: string): ToolCategory {
    const lines = content.split('\n');
    const lineCount = lines.length;
    const trimmed = content.trim();

    // 错误输出（优先级最高）
    if (this.isErrorOutput(content)) return ToolCategory.ERROR_OUTPUT;

    // 空/极短成功
    if (trimmed.length < 50 && (trimmed.includes('exit code: 0') || trimmed.includes('Process exited')))
      return ToolCategory.EMPTY_SUCCESS;

    // Git 输出
    if (content.startsWith('diff --git') || content.includes('diff --git ')) return ToolCategory.GIT_DIFF;
    if (/^commit [0-9a-f]{7,}/m.test(content)) return ToolCategory.GIT_LOG;
    if (/^(On branch|Your branch is|nothing to commit|Changes to be)/m.test(content))
      return ToolCategory.GIT_STATUS;

    // 测试输出
    if (/^\d+ (passed|failed|skipped|pending)/m.test(content) ||
        /^(PASS|FAIL|✓|✗|✔|✘)\s/m.test(content) ||
        /Test Suites?: \d+ (passed|failed)/.test(content) ||
        /\d+ test(s)?,? \d+ (passed|failed|assertions?)/.test(content) ||
        /running \d+ test(s)?/m.test(content))
      return ToolCategory.TEST_RESULT;

    // 构建输出
    if (/(Compiling|Finished|error\[E\d+\]|warning:|build failed|Build failed)/.test(content))
      return ToolCategory.BUILD_RESULT;

    // 文件内容（>20 行，像代码或配置）
    if (lineCount > 20 && this.looksLikeFileContent(content)) return ToolCategory.FILE_READ;

    // 目录列表
    if (/^(total \d+|drwx|rwxr[-w]|[-r][-w][-w][-xr][-w][-r])\s/m.test(content) ||
        /^(Directory listing|file:|dir:)/m.test(content))
      return ToolCategory.COMMAND_LIST;

    // Web 内容
    if (/<html|<!DOCTYPE|<\?xml/m.test(content) && content.length > 500)
      return ToolCategory.WEB_FETCH;

    // 命令输出（有 exit code）
    if (content.includes('exit code:') || content.includes('Process exited'))
      return ToolCategory.COMMAND_EXEC;

    return ToolCategory.UNKNOWN;
  }

  /** 判断内容是否像文件/代码 */
  private looksLikeFileContent(content: string): boolean {
    const codePatterns = [
      /^(import |from |require\(|const |let |var |def |class |function |func |fn )/m,
      /^[\s]*(export |module |package |namespace )/m,
      /^\s*(if |for |while |switch |match |case )/m,
      /^[\s]*[{};]$/,
      /^\s*\/\/|#|\/\*|\*\/|--|<\?|--\[/m,
    ];
    return codePatterns.some(p => p.test(content));
  }

  /** 判断是否为错误输出 */
  private isErrorOutput(content: string): boolean {
    const errorPatterns = [
      /(?:^|\n)(?:Error|ERROR|error|ERR|err):?\s/m,
      /(?:^|\n)(?:stderr|STDERR):/m,
      /(?:^|\n)(?:fatal|FATAL|panic|PANIC):/m,
      /(?:^|\n)(?:Exception|EXCEPTION):/m,
      /(?:^|\n)(?:Traceback|traceback)/m,
      /(?:^|\n)\s+at \S+ \(/m,           // JS/Java stack trace
      /(?:^|\n)\werror\[E\d+\]/m,         // Rust
      /(?:exit code: [1-9])/m,            // 非零退出码
      /(?:^|\n)(?:✗|✘|FAIL|failed|FAILED)/m,
      /(?:ModuleNotFoundError|ImportError|SyntaxError|TypeError)/m,
      /(?:ENOENT|EACCES|ECONNREFUSED)/m,
    ];
    return errorPatterns.some(p => p.test(content));
  }

  // ============================================================
  // 四层压缩管道
  // ============================================================

  /** 同步：Layer 1-3（纯规则，零额外 token） */
  private applyTransformations(messages: NormalizedMessage[]): NormalizedMessage[] {
    const budgetRatio = this.estimateTokens(messages) / this.config.budget.maxInputTokens;
    const thresholds = this.config.compressionThresholds || {};
    const layers = this.config.compressionLayers || {};
    let result = messages;

    console.log(`[ContextManager] Budget: ${(budgetRatio * 100).toFixed(1)}% (${this.estimateTokens(messages)}/${this.config.budget.maxInputTokens} tokens)`);

    // Layer 1: HISTORY_SNIP（>40% 预算时触发，零成本规则裁剪）
    if ((layers.historySnip !== false) && budgetRatio >= (thresholds.layer1Start ?? 0.40)) {
      result = this.historySnip(result);
    }

    // Layer 2: MicroCompact（>60% 预算时触发，去重+清理）
    if ((layers.microCompact !== false) && this.estimateTokens(result) / this.config.budget.maxInputTokens >= (thresholds.layer2Start ?? 0.60)) {
      result = this.microCompact(result);
    }

    // Layer 3: Context Collapse（>75% 预算时触发，合并批量调用）
    if ((layers.contextCollapse !== false) && this.estimateTokens(result) / this.config.budget.maxInputTokens >= (thresholds.layer3Start ?? 0.75)) {
      result = this.contextCollapse(result);
    }

    return result;
  }

  /** 异步：Layer 1-4（Layer 4 需要 LLM 调用） */
  private async applyTransformationsAsync(messages: NormalizedMessage[]): Promise<NormalizedMessage[]> {
    const thresholds = this.config.compressionThresholds || {};
    const layers = this.config.compressionLayers || {};
    let result = await this.applyTransformations(messages);

    // Layer 4: Auto-Compact（>85% 预算时触发，LLM 摘要，提前触发留出 token 余量）
    if ((layers.autoCompact !== false) && this.estimateTokens(result) / this.config.budget.maxInputTokens >= (thresholds.layer4Start ?? 0.85)) {
      result = await this.autoCompact(result);
    }

    return result;
  }

  // ============================================================
  // Layer 1: HISTORY_SNIP — 按工具类型语义裁剪
  // ============================================================
  private historySnip(messages: NormalizedMessage[]): NormalizedMessage[] {
    const stats = { total: 0, compressed: 0, saved: 0, categories: {} as Record<string, number> };

    const result = messages.map((m) => {
      if (m.role !== 'tool' || !m.content) return m;
      if (m.metadata.snipped || m.metadata.simplified) return m;

      const category = this.categorizeToolOutput(m);
      const originalLen = m.content.length;
      stats.total++;
      stats.categories[category] = (stats.categories[category] || 0) + 1;

      const compressed = this.snipByCategory(category, m.content, m.toolCallId);
      if (compressed !== m.content) {
        m.content = compressed;
        m.metadata.snipped = true;
        m.metadata.snipCategory = category;
        stats.compressed++;
        stats.saved += originalLen - m.content.length;
      }

      return m;
    }).filter(m => {
      // 如果压缩后内容为空（极罕见），保留一个标记
      if (m.role === 'tool' && !m.content) {
        m.content = '[output suppressed]';
      }
      return true;
    });

    if (stats.total > 0) {
      const catStr = Object.entries(stats.categories).map(([k, v]) => `${k}:${v}`).join(', ');
      console.log(`[ContextManager] Layer 1: ${stats.total} tool outputs scanned, ${stats.compressed} compressed, saved ${stats.saved} chars [${catStr}]`);
    }

    return result;
  }

  /** 按分类执行压缩策略 */
  private snipByCategory(category: ToolCategory, content: string, toolCallId?: string): string {
    const toolName = this.getToolName(toolCallId);
    const toolLabel = toolName ? `[${toolName}]` : '';

    switch (category) {
      case ToolCategory.EMPTY_SUCCESS: {
        const exitCode = content.match(/exit code: (\d+)/)?.[1] || '0';
        const time = content.match(/Wall time: ([\d.]+)s/)?.[1];
        return `✓ ${toolLabel}success (exit ${exitCode})${time ? `, ${time}s` : ''}`;
      }

      case ToolCategory.FILE_READ: {
        const lines = content.split('\n');
        const lineCount = lines.length;
        if (lineCount <= 30) return content;  // 短文件不压缩
        // 保留前 10 行 + 后 5 行
        const head = lines.slice(0, 10).join('\n');
        const tail = lines.slice(-5).join('\n');
        return `${head}\n\n... [${lineCount - 15} lines omitted] ...\n\n${tail}`;
      }

      case ToolCategory.COMMAND_LIST: {
        const lines = content.split('\n');
        const lineCount = lines.length;
        if (lineCount <= 30) return content;
        const head = lines.slice(0, 10).join('\n');
        const tail = lines.slice(-3).join('\n');
        const fileCount = content.match(/\n/g)?.length || lineCount;
        return `${head}\n\n... [${fileCount - 13} more entries] ...\n\n${tail}`;
      }

      case ToolCategory.GIT_DIFF: {
        const lines = content.split('\n');
        const lineCount = lines.length;
        if (lineCount <= 60) return content;
        // 保留 diff header + 变更行（+/-），去掉上下文
        const kept: string[] = [];
        let changes = 0;
        const maxChanges = 40;
        for (const line of lines) {
          if (line.startsWith('diff --git') || line.startsWith('index ') ||
              line.startsWith('--- ') || line.startsWith('+++ ') ||
              line.startsWith('@@ ') || line.startsWith('+') || line.startsWith('-')) {
            if (line.startsWith('+') || line.startsWith('-')) {
              changes++;
              if (changes > maxChanges) continue;
            }
            kept.push(line);
          } else if (kept.length < 15) {
            kept.push(line);  // 保留开头的上下文行
          }
        }
        if (changes > maxChanges) {
          kept.push(`\n... [${changes - maxChanges} more change lines omitted] ...`);
        }
        return kept.join('\n');
      }

      case ToolCategory.GIT_STATUS: {
        // git status 通常不很长，超限才压缩
        if (content.length > 1000) {
          const modified = (content.match(/^ {2}modified:/gm) || []).length;
          const added = (content.match(/^ {2}(new file|added):/gm) || []).length;
          const deleted = (content.match(/^ {2}deleted:/gm) || []).length;
          const untracked = (content.match(/^ {2}Untracked files:/gm) || []).length;
          return `${toolLabel}git status: ${modified} modified, ${added} added, ${deleted} deleted, ${untracked ? untracked + ' untracked' : 'clean'}`;
        }
        return content;
      }

      case ToolCategory.TEST_RESULT: {
        const summary = content.match(/(\d+) (passed|failed|skipped|pending)/g)?.join(', ');
        const failures = content.match(/(?:✗|✘|FAIL|failed):?\s*(.*)/g);
        if (content.includes('FAIL') || content.includes('failed')) {
          // 失败：保留失败用例详情，压缩通过的
          const head = content.split('\n').slice(0, 5).join('\n');
          const failDetails = failures ? failures.slice(0, 5).join('\n') : '';
          return `${head}\n${failDetails}\n\n... [passing tests omitted] ...${summary ? `\nSummary: ${summary}` : ''}`;
        }
        // 全通过：只保留摘要
        return summary ? `${toolLabel}${summary}` : content.slice(0, 200);
      }

      case ToolCategory.BUILD_RESULT: {
        if (content.includes('error[') || content.includes('Build failed') || content.includes('build failed')) {
          return content;  // 构建失败 → 完整保留
        }
        // 构建成功 → 摘要
        const warnings = (content.match(/warning:/gi) || []).length;
        const errors = (content.match(/error:/gi) || []).length;
        const time = content.match(/([\d.]+)s(?:$|\s)/)?.[1];
        return `${toolLabel}build OK${warnings ? `, ${warnings} warning(s)` : ''}${time ? `, ${time}s` : ''}`;
      }

      case ToolCategory.ERROR_OUTPUT:
        return content;  // 错误输出 → 完整保留

      case ToolCategory.COMMAND_EXEC: {
        // 通用命令输出：成功长输出 → 保留头尾
        if (content.includes('exit code: 0') && content.length > 2000) {
          const lines = content.split('\n');
          const lineCount = lines.length;
          const head = lines.slice(0, 8).join('\n');
          const tail = lines.slice(-3).join('\n');
          return `${head}\n\n... [${lineCount - 11} lines omitted, exit 0] ...\n\n${tail}`;
        }
        // 非零退出码但内容很长 → 保留关键部分
        if (content.length > 3000) {
          return content.slice(0, 1500) + '\n\n... [truncated] ...\n\n' + content.slice(-500);
        }
        return content;
      }

      case ToolCategory.COMMAND_FIND: {
        const lines = content.split('\n');
        if (lines.length <= 30) return content;
        const head = lines.slice(0, 15).join('\n');
        const tail = lines.slice(-5).join('\n');
        return `${head}\n\n... [${lines.length - 20} more matches] ...\n\n${tail}`;
      }

      case ToolCategory.WEB_FETCH: {
        if (content.length <= 2000) return content;
        // 保留前 500 字符
        return content.slice(0, 500) + '\n\n... [web content truncated] ...';
      }

      case ToolCategory.SCREENSHOT:
        return `${toolLabel}screenshot captured`;

      default:
        // 兜底：超长通用截断
        if (content.length > this.config.maxToolOutputChars) {
          const max = this.config.maxToolOutputChars;
          const head = content.slice(0, Math.floor(max * 0.7));
          const tail = content.slice(-Math.floor(max * 0.2));
          return `${head}\n\n... [${content.length - head.length - tail.length} chars omitted] ...\n\n${tail}`;
        }
        return content;
    }
  }

  // ============================================================
  // Layer 2: MicroCompact — 去重 + 清理冗余
  // ============================================================
  private microCompact(messages: NormalizedMessage[]): NormalizedMessage[] {
    // 1. 重复读取去重：同一 tool_name 读取同一文件，只保留最新
    messages = this.deduplicateReads(messages);

    // 2. 连续相同命令去重
    messages = this.deduplicateCommands(messages);

    // 3. 清理空输出
    messages = this.cleanEmptyOutputs(messages);

    return messages;
  }

  /** 重复读取去重 */
  private deduplicateReads(messages: NormalizedMessage[]): NormalizedMessage[] {
    const seen = new Map<string, number>();  // tool_name → last index
    const result: NormalizedMessage[] = [];

    for (let i = 0; i < messages.length; i++) {
      const m = messages[i];
      if (m.role === 'tool' && m.metadata.snipCategory === ToolCategory.FILE_READ) {
        const key = this.getToolName(m.toolCallId) || 'unknown_read';
        const prevIndex = seen.get(key);
        if (prevIndex !== undefined && prevIndex >= 0) {
          // 有重复，标记旧的为"已被新版本替代"
          const oldMsg = result.find((_, ri) => {
            // 找到 result 中对应 prevIndex 的消息
            let count = 0;
            for (let j = 0; j < messages.length; j++) {
              if (result.includes(result.find(r => r === messages[j])!)) count++;
              if (count - 1 === prevIndex) return result.includes(messages[j]);
            }
            return false;
          });
          // 简化：直接在旧位置放一个引用
          if (prevIndex < result.length) {
            const old = result[prevIndex];
            if (old && old.role === 'tool' && !old.metadata.replaced) {
              old.content = `[superseded by newer version of same file]`;
              old.metadata.replaced = true;
            }
          }
        }
        seen.set(key, result.length);
      }
      result.push(m);
    }
    return result;
  }

  /** 连续相同命令去重 */
  private deduplicateCommands(messages: NormalizedMessage[]): NormalizedMessage[] {
    const result: NormalizedMessage[] = [];
    let i = 0;
    while (i < messages.length) {
      const m = messages[i];
      result.push(m);

      // 如果当前是 assistant + tool_calls，后面紧跟 tool results
      if (m.role === 'assistant' && m.toolCalls?.length) {
        const toolNames = m.toolCalls.map(tc => tc.name).join(',');
        let skipCount = 0;

        // 往前看：是否有相同的 assistant toolCalls + tool results 序列
        for (let j = result.length - 2; j >= 0; j--) {
          const prev = result[j];
          if (prev.role === 'assistant' && prev.toolCalls) {
            const prevNames = prev.toolCalls.map(tc => tc.name).join(',');
            if (prevNames === toolNames && prev.toolCalls.length === m.toolCalls.length) {
              // 相同工具调用序列，检查 tool results 是否也相同
              let allSame = true;
              for (let k = 0; k < m.toolCalls.length; k++) {
                const nextMsg = messages[i + 1 + k];
                if (!nextMsg || nextMsg.role !== 'tool') { allSame = false; break; }
              }
              if (allSame) {
                skipCount = m.toolCalls.length;  // 跳过 tool results，但保留 assistant
              }
            }
            break;  // 只检查最近的一次
          }
        }

        // 添加 tool results（可能需要标记为重复）
        for (let k = 0; k < m.toolCalls.length; k++) {
          const nextMsg = messages[i + 1 + k];
          if (nextMsg && nextMsg.role === 'tool') {
            if (skipCount > 0 && !nextMsg.metadata.duplicate) {
              result.push({
                ...nextMsg,
                content: `[duplicate of previous ${this.getToolName(nextMsg.toolCallId) || 'tool'} output]`,
                metadata: { ...nextMsg.metadata, duplicate: true },
              });
              skipCount--;
            } else {
              result.push(nextMsg);
            }
          }
        }
        i += m.toolCalls.length + 1;
      } else {
        i++;
      }
    }
    return result;
  }

  /**
   * Step 0: 无条件规范化 tool outputs（不依赖预算阈值）
   * 处理最常见的压缩场景：空输出、极短成功信号等
   * 这是 savings 的主要来源，必须在 applyTransformations 之前运行
   */
  private normalizeToolOutputs(messages: NormalizedMessage[]): NormalizedMessage[] {
    let savings = 0;
    let normalized = 0;
    const result = messages.map(m => {
      if (m.role !== 'tool' || !m.content) return m;
      const category = this.categorizeToolOutput(m);
      const originalLen = m.content.length;
      const compressed = this.snipByCategory(category, m.content, m.toolCallId);
      if (compressed !== m.content) {
        m.content = compressed;
        m.metadata.snipped = true;
        m.metadata.snipCategory = category;
        normalized++;
        savings += originalLen - m.content.length;
      }
      return m;
    });
    if (normalized > 0) {
      console.log(`[ContextManager] Step 0: ${normalized} tool outputs normalized, saved ${savings} chars`);
    }
    return result;
  }

  /** 清理空输出 */
  private cleanEmptyOutputs(messages: NormalizedMessage[]): NormalizedMessage[] {
    return messages.map(m => {
      if (m.role !== 'tool' || !m.content) return m;
      if (m.content.trim().length === 0 && !m.metadata.simplified) {
        m.content = '[empty output]';
        m.metadata.emptyCleaned = true;
      }
      return m;
    });
  }

  // ============================================================
  // Layer 3: Context Collapse — 折叠连续工具调用段
  // ============================================================
  private contextCollapse(messages: NormalizedMessage[]): NormalizedMessage[] {
    const result: NormalizedMessage[] = [];
    let i = 0;

    while (i < messages.length) {
      const msg = messages[i];

      // 检测: assistant(tool_calls × N) → tool × N（N >= 2）
      if (msg.role === 'assistant' && msg.toolCalls && msg.toolCalls.length >= 2) {
        const toolCallCount = msg.toolCalls.length;
        const toolResults: NormalizedMessage[] = [];

        // 收集紧跟的 tool results
        for (let k = 0; k < toolCallCount; k++) {
          const next = messages[i + 1 + k];
          if (next && next.role === 'tool') {
            toolResults.push(next);
          }
        }

        if (toolResults.length === toolCallCount) {
          // 可以折叠
          const allReads = toolCallCount >= 2 &&
            toolResults.every(t => t.metadata.snipCategory === ToolCategory.FILE_READ);
          const allList = toolCallCount >= 2 &&
            toolResults.every(t => t.metadata.snipCategory === ToolCategory.COMMAND_LIST);

          if (allReads || allList) {
            // 合并多条读取/列表为一条摘要
            const summaries = toolResults.map(t => {
              const name = this.getToolName(t.toolCallId) || 'file';
              const cat = t.metadata.snipCategory as string;
              const len = t.content.length;
              const lines = t.content.split('\n').length;
              return `${name} (${cat}, ${lines}L)`;
            });

            result.push({
              ...msg,
              toolCalls: [msg.toolCalls[0]],  // 只保留第一个 tool_call
              content: msg.content || `[Batch: ${toolCallCount} ${allReads ? 'reads' : 'listings'}]`,
            });

            result.push({
              role: 'tool',
              content: `[Collapsed: ${summaries.join('; ')}]`,
              toolCallId: msg.toolCalls[0].id,
              metadata: { collapsed: true, originalCount: toolCallCount },
            });

            i += toolCallCount + 1;
            continue;
          }
        }
      }

      result.push(msg);
      i++;
    }

    return result;
  }

  // ============================================================
  // Layer 4: Auto-Compact — 全对话 LLM 摘要
  // ============================================================
  private async autoCompact(messages: NormalizedMessage[]): Promise<NormalizedMessage[]> {
    const callback = this.config.autoCompactConfig?.callback;
    const keepRounds = this.config.autoCompactConfig?.keepLastRounds ?? 2;

    if (!callback) {
      // 没有 LLM 回调 → 降级为简单截断
      console.log('[ContextManager] Layer 4: No LLM callback, falling back to simple truncation');
      return this.simpleTruncateToBudget(messages, keepRounds);
    }

    const systemMsgs = messages.filter(m => m.role === 'system');
    const nonSystem = messages.filter(m => m.role !== 'system');

    // 按轮次分组
    const rounds: NormalizedMessage[][] = [];
    let currentRound: NormalizedMessage[] = [];
    for (const msg of nonSystem) {
      if (msg.role === 'user' && currentRound.length > 0) {
        rounds.push(currentRound);
        currentRound = [];
      }
      currentRound.push(msg);
    }
    if (currentRound.length > 0) rounds.push(currentRound);

    if (rounds.length <= keepRounds + 1) return messages;  // 轮次太少，不摘要

    // 保留最近 N 轮 + system
    const recentRounds = rounds.slice(-keepRounds);
    const oldRounds = rounds.slice(0, -keepRounds);

    // 生成旧轮次的文本表示
    const oldText = oldRounds.map(round =>
      round.map(m => {
        const role = m.role.toUpperCase();
        const toolInfo = m.toolCalls ? ` [tools: ${m.toolCalls.map(tc => tc.name).join(', ')}]` : '';
        const toolRef = m.toolCallId ? ` [ref: ${m.toolCallId.slice(0, 8)}]` : '';
        const contentPreview = m.content.slice(0, 300);
        return `${role}${toolInfo}${toolRef}: ${contentPreview}`;
      }).join('\n')
    ).join('\n\n---\n\n');

    // 调用 LLM 生成摘要
    try {
      const summary = await callback(oldText);
      const summaryMsg: NormalizedMessage = {
        role: 'user',
        content: `[Auto-Compact: Previous conversation summary]\n${summary}`,
        metadata: { autoCompacted: true, originalRounds: oldRounds.length },
      };

      const recentFlat = recentRounds.flat();
      return [...systemMsgs, summaryMsg, ...recentFlat];
    } catch (err) {
      console.error(`[ContextManager] Layer 4: Auto-compact failed: ${err}`);
      return this.simpleTruncateToBudget(messages, keepRounds);
    }
  }

  /** 简单截断兜底（无 LLM 时） */
  private simpleTruncateToBudget(messages: NormalizedMessage[], keepRounds: number): NormalizedMessage[] {
    const systemMsgs = messages.filter(m => m.role === 'system');
    const nonSystem = messages.filter(m => m.role !== 'system');

    const rounds: NormalizedMessage[][] = [];
    let currentRound: NormalizedMessage[] = [];
    for (const msg of nonSystem) {
      if (msg.role === 'user' && currentRound.length > 0) {
        rounds.push(currentRound);
        currentRound = [];
      }
      currentRound.push(msg);
    }
    if (currentRound.length > 0) rounds.push(currentRound);

    if (rounds.length <= keepRounds) return messages;

    const keptRounds = rounds.slice(-keepRounds);
    const droppedCount = rounds.length - keepRounds;

    const summaryMsg: NormalizedMessage = {
      role: 'user',
      content: `[${droppedCount} conversation rounds truncated for budget — ${droppedCount * 4}+ tokens saved]`,
      metadata: { simpleTruncated: true, droppedRounds: droppedCount },
    };

    return [...systemMsgs, summaryMsg, ...keptRounds.flat()];
  }

  // ============================================================
  // Token 预算控制（兜底裁剪）
  // ============================================================
  private enforceTokenBudget(
    messages: NormalizedMessage[]
  ): NormalizedMessage[] {
    const maxInputTokens = this.config.budget.maxInputTokens;
    if (maxInputTokens <= 0) return messages;

    const estimated = this.estimateTokens(messages);
    if (estimated <= maxInputTokens) return messages;

    const system = messages.filter((m) => m.role === 'system');
    const rest = messages.filter((m) => m.role !== 'system');

    // 按轮次（user 消息为边界）从后往前保留
    const rounds: NormalizedMessage[][] = [];
    let currentRound: NormalizedMessage[] = [];
    for (const msg of rest) {
      if (msg.role === 'user' && currentRound.length > 0) {
        rounds.push(currentRound);
        currentRound = [];
      }
      currentRound.push(msg);
    }
    if (currentRound.length > 0) rounds.push(currentRound);

    const keptRounds: NormalizedMessage[][] = [];
    let tokens = 0;
    const maxRounds = this.config.keepRecentRounds;

    for (let i = rounds.length - 1; i >= 0; i--) {
      if (keptRounds.length >= maxRounds) break;

      const round = rounds[i];
      const roundTokens = round.reduce((s, m) => s + this.estimateMessageTokens(m), 0);

      if (tokens + roundTokens > maxInputTokens) {
        const trimmedRound = this.trimRoundToBudget(round, maxInputTokens - tokens);
        if (trimmedRound.length > 0) {
          keptRounds.unshift(trimmedRound);
        }
        break;
      }

      keptRounds.unshift(round);
      tokens += roundTokens;
    }

    const kept = keptRounds.flat();
    const result = [...system, ...kept];

    if (this.config.debugLog) {
      console.log(
        `[ContextManager] Budget trunc: ${messages.length} → ${result.length} msgs, ` +
          `~${estimated} → ~${this.estimateTokens(result)} tokens`
      );
    }

    return result;
  }

  private trimRoundToBudget(
    round: NormalizedMessage[],
    budgetTokens: number
  ): NormalizedMessage[] {
    const result: NormalizedMessage[] = [];

    for (const msg of round) {
      if (msg.role === 'user') {
        result.push(msg);
      } else if (msg.role === 'assistant') {
        result.push(msg);
      } else if (msg.role === 'tool') {
        const msgTokens = this.estimateMessageTokens(msg);
        const currentTokens = result.reduce((s, m) => s + this.estimateMessageTokens(m), 0);

        if (currentTokens + msgTokens <= budgetTokens) {
          result.push(msg);
        } else {
          const remainingTokens = Math.max(0, budgetTokens - currentTokens);
          const remainingChars = remainingTokens * 4;

          if (remainingChars > 100 && msg.content.length > remainingChars) {
            const headLen = Math.floor(remainingChars * 0.6);
            const tailLen = Math.floor(remainingChars * 0.3);
            const head = msg.content.slice(0, headLen);
            const tail = msg.content.slice(-tailLen);
            const truncated = msg.content.length - headLen - tailLen;

            result.push({
              ...msg,
              content: `${head}\n\n... [${truncated} chars truncated due to budget] ...\n\n${tail}`,
              metadata: { ...msg.metadata, truncated: true, budgetTrimmed: true },
            });
          } else if (remainingChars > 50) {
            result.push({
              ...msg,
              content: msg.content.slice(0, remainingChars) + '... [truncated due to budget]',
              metadata: { ...msg.metadata, truncated: true, budgetTrimmed: true },
            });
          }
        }
      }
    }

    return result;
  }

  // ============================================================
  // Token 估算
  // ============================================================
  private estimateTokens(messages: NormalizedMessage[]): number {
    return messages.reduce((sum, m) => sum + this.estimateMessageTokens(m), 0);
  }

  private estimateMessageTokens(m: NormalizedMessage): number {
    let chars = m.content?.length || 0;
    if (m.toolCalls) {
      for (const tc of m.toolCalls) {
        chars += tc.name.length + (tc.arguments?.length || 0) + 20;
      }
    }
    if (m.reasoning) {
      chars += m.reasoning.length;
    }
    return Math.ceil(chars / 4);
  }

  // ============================================================
  // 格式规范化
  // ============================================================
  private normalizeAnthropicMessages(
    messages: AnthropicMessage[]
  ): NormalizedMessage[] {
    const result: NormalizedMessage[] = [];

    for (const m of messages) {
      if (typeof m.content === 'string') {
        result.push({
          role: m.role as 'user' | 'assistant',
          content: m.content,
          metadata: { originalRole: m.role },
        });
        continue;
      }

      if (!Array.isArray(m.content)) continue;

      if (m.role === 'assistant') {
        const normalized: NormalizedMessage = {
          role: 'assistant',
          content: '',
          metadata: { originalRole: m.role },
        };
        const textParts: string[] = [];
        for (const block of m.content) {
          if (block.type === 'text') {
            textParts.push(block.text);
          } else if (block.type === 'tool_use') {
            if (!normalized.toolCalls) normalized.toolCalls = [];
            normalized.toolCalls.push({
              id: block.id,
              name: block.name,
              arguments: JSON.stringify(block.input || {}),
            });
          } else if (block.type === 'thinking') {
            normalized.reasoning = (normalized.reasoning || '') + (block as any).thinking;
          }
        }
        normalized.content = textParts.join('');
        result.push(normalized);
        continue;
      }

      for (const block of m.content) {
        if (block.type === 'text') {
          result.push({
            role: 'user',
            content: block.text,
            metadata: { originalRole: m.role, blockType: 'text' },
          });
        } else if (block.type === 'tool_result') {
          result.push({
            role: 'tool',
            content:
              typeof block.content === 'string'
                ? block.content
                : this.extractTextContent(block.content),
            toolCallId: block.tool_use_id,
            metadata: { originalRole: m.role, blockType: 'tool_result' },
          });
        }
      }
    }

    return result;
  }

  private normalizeResponsesMessages(
    items: ResponsesItem[]
  ): NormalizedMessage[] {
    const messages: NormalizedMessage[] = [];

    for (const item of items) {
      switch (item.type) {
        case 'message':
          messages.push({
            role: (item.role as 'user' | 'assistant') || 'user',
            content: this.extractTextContent(item.content),
            metadata: { originalType: 'message' },
          });
          break;

        case 'function_call':
          messages.push({
            role: 'assistant',
            content: '',
            toolCalls: [
              {
                id: item.call_id || '',
                name: item.name || '',
                arguments: item.arguments || '{}',
              },
            ],
            metadata: { originalType: 'function_call' },
          });
          break;

        case 'function_call_output':
          messages.push({
            role: 'tool',
            content: item.output || '',
            toolCallId: item.call_id,
            metadata: { originalType: 'function_call_output' },
          });
          break;

        case 'text': {
          messages.push({
            role: 'user',
            content: (item as any).text || '',
            metadata: { originalType: 'text' },
          });
          break;
        }

        default:
          if (item.role) {
            messages.push({
              role: item.role as NormalizedMessage['role'],
              content: this.extractTextContent(item.content) || '',
              metadata: { originalType: item.type },
            });
          }
          break;
      }
    }

    return messages;
  }

  private normalizeOpenAIMessages(
    messages: OpenAIMessage[]
  ): NormalizedMessage[] {
    return messages.map((m) => ({
      role: m.role,
      content: typeof m.content === 'string' ? m.content : '',
      toolCalls: m.tool_calls?.map((tc) => ({
        id: tc.id,
        name: tc.function.name,
        arguments: tc.function.arguments,
      })),
      toolCallId: m.tool_call_id,
      metadata: { originalRole: m.role },
    }));
  }

  // ============================================================
  // 格式还原
  // ============================================================
  private denormalizeToAnthropic(
    messages: NormalizedMessage[]
  ): AnthropicMessage[] {
    const groups: NormalizedMessage[][] = [];
    let i = 0;
    while (i < messages.length) {
      const m = messages[i];
      if (m.role === 'user' && m.content) {
        const group: NormalizedMessage[] = [m];
        let j = i + 1;
        while (j < messages.length && messages[j].role === 'tool') {
          group.push(messages[j]);
          j++;
        }
        groups.push(group);
        i = j;
      } else if (m.role === 'tool' && !m.content) {
        groups.push([m]);
        i++;
      } else {
        groups.push([m]);
        i++;
      }
    }

    return groups.map((group) => {
      const content: AnthropicContentBlock[] = [];

      for (const m of group) {
        if (m.role === 'tool' && m.toolCallId) {
          content.push({
            type: 'tool_result',
            tool_use_id: m.toolCallId,
            content: m.content || '',
          });
        } else if (m.content) {
          content.push({ type: 'text', text: m.content });
        }

        if (m.toolCalls) {
          for (const tc of m.toolCalls) {
            content.push({
              type: 'tool_use',
              id: tc.id,
              name: tc.name,
              input: this.safeParseJSON(tc.arguments),
            });
          }
        }
      }

      return {
        role: group[0].role as 'user' | 'assistant',
        content: content.length > 0 ? content : [{ type: 'text', text: '' }],
      };
    });
  }

  private denormalizeToResponses(
    messages: NormalizedMessage[]
  ): ResponsesItem[] {
    const items: ResponsesItem[] = [];

    for (const m of messages) {
      if (m.role === 'tool' && m.toolCallId) {
        items.push({
          type: 'function_call_output',
          call_id: m.toolCallId,
          output: m.content,
        });
      } else if (m.toolCalls?.length) {
        for (const tc of m.toolCalls) {
          items.push({
            type: 'function_call',
            call_id: tc.id,
            name: tc.name,
            arguments: tc.arguments,
          });
        }
      } else if (m.content || m.role) {
        items.push({
          type: 'message',
          role: m.role,
          content: [
            { type: 'input_text', text: m.content || '' },
          ],
        });
      }
    }

    return items;
  }

  private denormalizeToOpenAI(
    messages: NormalizedMessage[]
  ): OpenAIMessage[] {
    return messages.map((m) => {
      const msg: OpenAIMessage = {
        role: m.role,
        content: m.content || null,
      };

      if (m.toolCalls) {
        msg.tool_calls = m.toolCalls.map((tc) => ({
          id: tc.id,
          type: 'function',
          function: { name: tc.name, arguments: tc.arguments },
        }));
      }

      if (m.toolCallId) {
        msg.tool_call_id = m.toolCallId;
      }

      return msg;
    });
  }

  // ============================================================
  // 工具方法
  // ============================================================
  private extractTextContent(content: unknown): string {
    if (typeof content === 'string') return content;
    if (!content) return '';

    if (Array.isArray(content)) {
      return content
        .filter((b: any) => b?.type === 'text' && b?.text)
        .map((b: any) => b.text)
        .join('');
    }

    if (typeof content === 'object' && content !== null) {
      return JSON.stringify(content);
    }

    return String(content);
  }

  private safeParseJSON(str: string): Record<string, unknown> {
    try {
      return JSON.parse(str);
    } catch {
      return {};
    }
  }

  private logStats(
    backend: string,
    inputCount: number,
    outputCount: number
  ): void {
    if (this.config.debugLog && inputCount !== outputCount) {
      console.log(
        `[ContextManager][${backend}] Items: ${inputCount} → ${outputCount} ` +
          `(${inputCount - outputCount} removed)`
      );
    }
  }
}

// ================================================================
// 工厂函数
// ================================================================

export function createContextManager(
  backend: BackendType,
  config?: Partial<ContextConfig>
): ContextManager {
  return new ContextManager({ backend, ...config });
}

// ================================================================
// 默认预算配置
// ================================================================

export const defaultBudgets: Record<BackendType, ContextBudget> = {
  anthropic: {
    maxTokens: 64000,
    reservedForResponse: 8000,
    maxInputTokens: 48000,
  },
  responses: {
    maxTokens: 64000,
    reservedForResponse: 8000,
    maxInputTokens: 48000,
  },
  openai: {
    maxTokens: 48000,
    reservedForResponse: 8000,
    maxInputTokens: 32000,
  },
};
