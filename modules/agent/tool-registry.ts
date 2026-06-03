// ================================================================
// Tool Registry — 动态注入/移除工具的注册中心
// ================================================================
// Phase 2：为 Goal Engine 提供按需工具注入能力
//
// 关键设计：
//   - register() 注册到全局注册表，但不会自动注入到 Agent 的 tool list
//   - injectNeeded() 临时将工具注入到当前执行 session 的 tool list
//   - removeInjected() 清理（在 finally 块中确保执行）
//   - 正常聊天 session 不看到天气/监控等 Goal 专用工具，节省 ~500-1000 token/轮
// ================================================================

export interface ToolParameter {
  type: string;
  description: string;
}

export interface ToolParameters {
  type: 'object';
  properties: Record<string, ToolParameter>;
  required: string[];
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: ToolParameters;
  handler: (params: Record<string, unknown>) => Promise<unknown>;
}

export class ToolRegistry {
  private registry: Map<string, ToolDefinition> = new Map();
  private injected: Set<string> = new Set();

  // ================================================================
  // 注册/注销（全局）
  // ================================================================

  /**
   * 注册工具到全局注册表
   * 注册 ≠ 注入：工具不会自动出现在 Agent 的 tool list 中
   */
  register(tool: ToolDefinition): void {
    if (this.registry.has(tool.name)) {
      console.warn(`[ToolRegistry] Tool "${tool.name}" already registered, overwriting`);
    }
    this.registry.set(tool.name, tool);
  }

  /**
   * 从全局注册表中注销工具
   */
  unregister(name: string): boolean {
    const existed = this.registry.delete(name);
    this.injected.delete(name);
    return existed;
  }

  // ================================================================
  // 注入/移除（当前 session 级别）
  // ================================================================

  /**
   * 临时注入工具到当前执行 session 的 tool list
   * @param toolNames 需要注入的工具名列表
   * @returns 实际注入的工具名列表（忽略不存在的）
   */
  injectNeeded(toolNames: string[]): string[] {
    const injected: string[] = [];
    for (const name of toolNames) {
      if (this.registry.has(name) && !this.injected.has(name)) {
        this.injected.add(name);
        injected.push(name);
      }
    }
    if (injected.length > 0) {
      console.log(`[ToolRegistry] Injected: ${injected.join(', ')}`);
    }
    return injected;
  }

  /**
   * 移除已注入的工具
   */
  removeInjected(toolNames: string[]): void {
    for (const name of toolNames) {
      this.injected.delete(name);
    }
  }

  /**
   * 移除所有已注入的工具（快捷方式，用于 finally 清理）
   */
  clearInjected(): void {
    this.injected.clear();
  }

  // ================================================================
  // 查询
  // ================================================================

  /**
   * 获取 OpenAI 格式的工具列表（供 Agent 调用）
   * 只返回已注入的工具
   */
  getOpenAIFormat(): object[] {
    const tools: object[] = [];
    for (const name of this.injected) {
      const tool = this.registry.get(name);
      if (tool) {
        tools.push({
          type: 'function',
          function: {
            name: tool.name,
            description: tool.description,
            parameters: tool.parameters,
          },
        });
      }
    }
    return tools;
  }

  /**
   * 获取所有已注入的工具定义（含 handler）
   */
  getInjected(): ToolDefinition[] {
    const tools: ToolDefinition[] = [];
    for (const name of this.injected) {
      const tool = this.registry.get(name);
      if (tool) tools.push(tool);
    }
    return tools;
  }

  /**
   * 列出所有已注册的工具名（不管是否注入）
   */
  list(): string[] {
    return Array.from(this.registry.keys());
  }

  /**
   * 列出当前已注入的工具名
   */
  listInjected(): string[] {
    return Array.from(this.injected);
  }

  // ================================================================
  // 执行
  // ================================================================

  /**
   * 执行已注入的工具
   */
  async execute(name: string, params: Record<string, unknown>): Promise<unknown> {
    const tool = this.registry.get(name);
    if (!tool) {
      throw new Error(`Tool "${name}" not found in registry`);
    }
    if (!this.injected.has(name)) {
      throw new Error(`Tool "${name}" is not injected into current session`);
    }
    return tool.handler(params);
  }

  /**
   * 检查工具是否已注册
   */
  isRegistered(name: string): boolean {
    return this.registry.has(name);
  }

  /**
   * 检查工具是否已注入
   */
  isInjected(name: string): boolean {
    return this.injected.has(name);
  }
}
