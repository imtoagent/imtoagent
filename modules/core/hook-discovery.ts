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

export async function discoverHooks(): Promise<DiscoveredHook[]> {
  const hooksDir = path.join(os.homedir(), '.imtoagent', 'hooks');
  if (!fs.existsSync(hooksDir)) return [];

  const discovered: DiscoveredHook[] = [];
  const entries = fs.readdirSync(hooksDir, { withFileTypes: true }).filter(e => e.isFile() && e.name.endsWith('.ts') && e.name !== 'EXAMPLE.ts');

  for (const entry of entries) {
    if (!entry.name.endsWith('.ts')) continue;
    if (entry.name.startsWith('_') || entry.name.includes('.test.')) continue;

    const entryPath = path.join(hooksDir, entry.name);
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

  console.log(`[HookDiscovery] Total hooks discovered: ${discovered.length}`);
  return discovered;
}
