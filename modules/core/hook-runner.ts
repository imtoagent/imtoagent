import type { DiscoveredHook } from './hook-discovery';

export class HookRunner {
  private hooksByWhen = new Map<string, DiscoveredHook[]>();

  register(hooks: DiscoveredHook[]): void {
    for (const hook of hooks) {
      const list = this.hooksByWhen.get(hook.when) || [];
      list.push(hook);
      this.hooksByWhen.set(hook.when, list);
    }
  }

  /** 按挂载点列出已注册的钩子（用于 hook-info 命令） */
  list(): Array<{ name: string; when: string; sourceFile: string }> {
    const result: Array<{ name: string; when: string; sourceFile: string }> = [];
    for (const [when, hooks] of this.hooksByWhen) {
      for (const hook of hooks) {
        result.push({ name: hook.name, when, sourceFile: hook.sourceFile });
      }
    }
    return result;
  }

  async run(when: string, ctx: any): Promise<void> {
    const hooks = this.hooksByWhen.get(when) || [];
    for (const hook of hooks) {
      try {
        await hook.handler(ctx);
      } catch (err) {
        console.error(`[HookRunner] ${hook.name} error: ${(err as Error).message}`);
      }
    }
  }

  async runBeforeToolCall(ctx: { toolName: string; args: Record<string, unknown>; chatId: string }): Promise<{ blocked: boolean; error?: string }> {
    let blocked = false;
    let errorMsg: string | undefined;

    const interceptCtx = {
      ...ctx,
      hookName: '',
      timestamp: Date.now(),
      intercept: () => {
        blocked = true;
        errorMsg = 'Hook blocked this tool call';
        return { blocked: true };
      },
    };

    await this.run('before_tool_call', interceptCtx);
    return { blocked, error: errorMsg };
  }

  async runAfterToolCall(ctx: { toolName: string; args: Record<string, unknown>; result: string; success: boolean; chatId: string }): Promise<string> {
    let modifiedResult = ctx.result;

    const hookCtx = {
      ...ctx,
      hookName: '',
      timestamp: Date.now(),
      modifyResult: (newResult: string) => {
        modifiedResult = newResult;
      },
    };

    await this.run('after_tool_call', hookCtx);
    return modifiedResult;
  }

  async runBeforeReply(ctx: { text: string; chatId: string }): Promise<string> {
    let modifiedText = ctx.text;

    const hookCtx = {
      ...ctx,
      hookName: '',
      timestamp: Date.now(),
      modifyText: (newText: string) => {
        modifiedText = newText;
      },
    };

    await this.run('before_reply', hookCtx);
    return modifiedText;
  }

  async runOnError(ctx: { error: string; stack?: string; chatId?: string; toolName?: string }): Promise<void> {
    const hookCtx = {
      ...ctx,
      hookName: '',
      timestamp: Date.now(),
    };

    await this.run('on_error', hookCtx);
  }
}
