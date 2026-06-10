import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

export type HookWhen = 'before_tool_call' | 'after_tool_call' | 'before_reply' | 'on_error';

export interface DiscoveredHook {
  name: string;
  when: HookWhen;
  handler: (ctx: any) => Promise<void>;
  sourceFile: string;
}

export async function discoverHooks(builtinDir?: string): Promise<DiscoveredHook[]> {
  const discovered: DiscoveredHook[] = [];
  const userHooksDir = path.join(os.homedir(), '.imtoagent', 'hooks');

  // 先扫内置目录，再扫用户目录（用户覆盖内置同名钩子）
  const scanDirs: string[] = [];
  if (builtinDir && fs.existsSync(builtinDir)) {
    scanDirs.push(builtinDir);
  }
  if (fs.existsSync(userHooksDir)) {
    scanDirs.push(userHooksDir);
  }

  if (scanDirs.length === 0) {
    console.log('[HookDiscovery] No hooks directories found');
    return [];
  }

  for (const scanDir of scanDirs) {
    const entries = fs.readdirSync(scanDir, { withFileTypes: true })
      .filter(e => e.isFile() && e.name.endsWith('.ts') && e.name !== 'EXAMPLE.ts');

    for (const entry of entries) {
      if (entry.name.startsWith('_') || entry.name.includes('.test.')) continue;

      const entryPath = path.join(scanDir, entry.name);
      try {
        const mod = await import(`file://${entryPath}`);
        const hook = mod.default;

        if (hook && typeof hook.name === 'string' && typeof hook.when === 'string' && typeof hook.handler === 'function') {
          discovered.push({
            name: hook.name,
            when: hook.when,
            handler: hook.handler,
            sourceFile: entryPath,
          });
          console.log(`[HookDiscovery] Registered: ${hook.name} (${hook.when})`);
        } else {
          console.warn(`[HookDiscovery] ⚠️ ${entry.name}: 导出格式不正确，需要 { name, when, handler }`);
        }
      } catch (err) {
        console.error(`[HookDiscovery] ❌ ${entry.name}: ${(err as Error).message}`);
      }
    }
  }

  console.log(`[HookDiscovery] Total hooks discovered: ${discovered.length}`);
  return discovered;
}
