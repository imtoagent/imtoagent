// ================================================================
// imtoagent hook-info — 查看已注册的钩子
// ================================================================

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

export async function cmdHookInfo(...args: string[]) {
  const subCommand = args[0] || 'list';

  if (subCommand === 'list' || subCommand === 'ls') {
    await listHooks();
  } else if (subCommand === 'help') {
    printHelp();
  } else {
    console.error(`❌ Unknown sub-command: ${subCommand}`);
    printHelp();
  }
}

async function listHooks() {
  const home = os.homedir();
  const hooksDir = path.join(home, '.imtoagent', 'hooks');

  console.log('🪝 IMtoAgent Hooks\n');

  if (!fs.existsSync(hooksDir)) {
    console.log(`  钩子目录: ${hooksDir} (不存在)`);
    console.log(`  创建模板: mkdir -p ${hooksDir}`);
    console.log('');
    return;
  }

  const entries = fs.readdirSync(hooksDir, { withFileTypes: true });
  const hookFiles = entries.filter(e =>
    e.name.endsWith('.ts') && !e.name.startsWith('_') && !e.name.includes('.test.')
  );

  if (hookFiles.length === 0) {
    console.log('  (没有已注册的钩子)');
    console.log('');
    console.log('💡 提示: 在 ~/.imtoagent/hooks/ 下放入 .ts 文件即可添加钩子');
    return;
  }

  const byWhen: Record<string, Array<{ name: string; file: string }>> = {};

  for (const entry of hookFiles) {
    const hookPath = path.join(hooksDir, entry.name);
    const info = await extractHookInfo(hookPath);
    const when = info.when || 'unknown';
    if (!byWhen[when]) byWhen[when] = [];
    byWhen[when].push({ name: info.name || entry.name, file: entry.name });
  }

  const mountPoints = ['before_tool_call', 'after_tool_call', 'before_reply', 'on_error'];
  for (const mp of mountPoints) {
    const hooks = byWhen[mp] || [];
    if (hooks.length > 0) {
      console.log(`  ${mp} (${hooks.length}):`);
      for (const hook of hooks) {
        console.log(`    ✅ ${hook.name}  (${hook.file})`);
      }
      console.log('');
    }
  }

  // 未知挂载点的钩子
  const unknownHooks = byWhen['unknown'] || [];
  if (unknownHooks.length > 0) {
    console.log(`  未知挂载点 (${unknownHooks.length}):`);
    for (const hook of unknownHooks) {
      console.log(`    ⚠️  ${hook.name}  (${hook.file})`);
    }
    console.log('');
  }

  console.log('💡 可用挂载点: before_tool_call / after_tool_call / before_reply / on_error');
  console.log('   钩子在启动时自动发现并注册，放文件到 ~/.imtoagent/hooks/ 即可生效');
}

async function extractHookInfo(filePath: string): Promise<{ name?: string; when?: string }> {
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const result: { name?: string; when?: string } = {};

    const nameMatch = content.match(/name\s*:\s*['"]([^'"]+)['"]/);
    if (nameMatch) result.name = nameMatch[1];

    const whenMatch = content.match(/when\s*:\s*['"]([^'"]+)['"]/);
    if (whenMatch) result.when = whenMatch[1];

    return result;
  } catch {
    return {};
  }
}

function printHelp() {
  console.log(`
imtoagent hook-info — 查看已注册的钩子

用法:
  imtoagent hook-info list    列出所有已注册的钩子
  imtoagent hook-info help    显示此帮助
`);
}
