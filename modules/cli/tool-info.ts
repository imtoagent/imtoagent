// ================================================================
// imtoagent tool-info — 列出已发现和注册的工具
// ================================================================

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

export async function cmdToolInfo(...args: string[]) {
  const subCommand = args[0] || 'list';

  if (subCommand === 'list' || subCommand === 'ls') {
    await listTools();
  } else if (subCommand === 'help') {
    printHelp();
  } else {
    console.error(`❌ Unknown sub-command: ${subCommand}`);
    printHelp();
  }
}

async function listTools() {
  const home = os.homedir();
  const toolsDir = path.join(home, '.imtoagent', 'tools');

  console.log('📦 IMtoAgent Tools\n');

  // 用户目录工具
  if (fs.existsSync(toolsDir)) {
    const entries = fs.readdirSync(toolsDir, { withFileTypes: true });
    const userTools = entries.filter(e =>
      e.name.endsWith('.ts') && !e.name.startsWith('_') && !e.name.includes('.test.')
    );

    if (userTools.length > 0) {
      console.log(`  用户工具 (${toolsDir}):`);
      for (const entry of userTools) {
        const toolPath = path.join(toolsDir, entry.name);
        const name = await extractToolName(toolPath);
        console.log(`    ✅ ${name || entry.name}  (${entry.name})`);
      }
      console.log('');
    }
  } else {
    console.log(`  用户工具目录: ${toolsDir} (不存在)`);
    console.log(`  创建模板: mkdir -p ${toolsDir} && cp EXAMPLE.ts ${toolsDir}/`);
    console.log('');
  }

  // 内置工具
  const builtInDir = path.resolve(import.meta.dirname, '../tools');
  if (fs.existsSync(builtInDir)) {
    const builtInEntries = fs.readdirSync(builtInDir, { withFileTypes: true });
    const builtInTools = builtInEntries.filter(e =>
      e.name.endsWith('.ts') && !e.name.startsWith('_')
    );

    if (builtInTools.length > 0) {
      console.log(`  内置工具:`);
      for (const entry of builtInTools) {
        const toolPath = path.join(builtInDir, entry.name);
        const name = await extractToolName(toolPath);
        console.log(`    📦 ${name || entry.name}  (${entry.name})`);
      }
      console.log('');
    }
  }

  console.log('💡 提示: 工具在启动时自动发现并注册，放文件到 ~/.imtoagent/tools/ 即可生效');
}

async function extractToolName(filePath: string): Promise<string | null> {
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    // 匹配 name: 'xxx' 或 name: "xxx"
    const match = content.match(/name\s*:\s*['"]([^'"]+)['"]/);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

function printHelp() {
  console.log(`
imtoagent tool-info — 查看已发现和注册的工具

用法:
  imtoagent tool-info list    列出所有工具（用户 + 内置）
  imtoagent tool-info help    显示此帮助
`);
}
