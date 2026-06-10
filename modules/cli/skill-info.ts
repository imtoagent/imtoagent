// ================================================================
// imtoagent skill-info — 查看已安装的技能
// ================================================================

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

export async function cmdSkillInfo(...args: string[]) {
  const subCommand = args[0] || 'list';

  if (subCommand === 'list' || subCommand === 'ls') {
    await listSkills();
  } else if (subCommand === 'help') {
    printHelp();
  } else {
    console.error(`❌ Unknown sub-command: ${subCommand}`);
    printHelp();
  }
}

async function listSkills() {
  const home = os.homedir();
  const skillsDir = path.join(home, '.imtoagent', 'skills');

  console.log('🧠 IMtoAgent Skills\n');

  if (!fs.existsSync(skillsDir)) {
    console.log(`  技能目录: ${skillsDir} (不存在)`);
    console.log(`  创建模板: mkdir -p ${skillsDir}/EXAMPLE`);
    console.log('');
    return;
  }

  const entries = fs.readdirSync(skillsDir, { withFileTypes: true });
  const skillDirs = entries.filter(e => e.isDirectory() && !e.name.startsWith('_'));

  if (skillDirs.length === 0) {
    console.log('  (没有已安装的技能)');
    console.log('');
    console.log('💡 提示: 在 ~/.imtoagent/skills/ 下创建目录并放入 SKILL.md 即可添加技能');
    return;
  }

  for (const entry of skillDirs) {
    const skillDir = path.join(skillsDir, entry.name);
    const skillFile = path.join(skillDir, 'SKILL.md');

    if (fs.existsSync(skillFile)) {
      const info = await parseSkillInfo(skillFile);
      console.log(`  ✅ ${entry.name}`);
      if (info.name) console.log(`     名称: ${info.name}`);
      if (info.description) console.log(`     描述: ${info.description}`);
      if (info.version) console.log(`     版本: ${info.version}`);
      if (info.requires_tools && info.requires_tools.length > 0) {
        console.log(`     依赖工具: ${info.requires_tools.join(', ')}`);
      }
      console.log(`     文件: ${skillFile}`);
      console.log('');
    } else {
      console.log(`  ⚠️  ${entry.name} (缺少 SKILL.md)`);
    }
  }
}

async function parseSkillInfo(skillPath: string): Promise<{
  name?: string;
  description?: string;
  version?: string;
  requires_tools?: string[];
}> {
  try {
    const content = fs.readFileSync(skillPath, 'utf-8');
    const result: {
      name?: string;
      description?: string;
      version?: string;
      requires_tools?: string[];
    } = {};

    // 解析 YAML frontmatter
    const fmMatch = content.match(/^---\s*\n([\s\S]*?)\n---/);
    if (fmMatch) {
      const yaml = fmMatch[1];
      const nameMatch = yaml.match(/^name:\s*(.+)$/m);
      if (nameMatch) result.name = nameMatch[1].trim();

      const descMatch = yaml.match(/^description:\s*(.+)$/m);
      if (descMatch) result.description = descMatch[1].trim();

      const verMatch = yaml.match(/^version:\s*(.+)$/m);
      if (verMatch) result.version = verMatch[1].trim();

      const reqMatch = yaml.match(/requires_tools:\s*\n((?:\s+- .+\n?)+)/);
      if (reqMatch) {
        result.requires_tools = reqMatch[1]
          .split('\n')
          .map(l => l.trim().replace(/^- /, ''))
          .filter(Boolean);
      }
    }

    return result;
  } catch {
    return {};
  }
}

function printHelp() {
  console.log(`
imtoagent skill-info — 查看已安装的技能

用法:
  imtoagent skill-info list    列出所有已安装的技能
  imtoagent skill-info help    显示此帮助
`);
}
