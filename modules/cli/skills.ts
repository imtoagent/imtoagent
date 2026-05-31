// ================================================================
// imtoagent skills — Skills management CLI
// ================================================================
// Commands: list, install, remove, sync
// ================================================================

import { SkillsManager } from '../utils/skills-manager';

export async function cmdSkills(...args: string[]): Promise<void> {
  const subCmd = args[0] || 'list';

  switch (subCmd) {
    case 'list':
      await cmdSkillsList(args.slice(1));
      break;
    case 'install':
      await cmdSkillsInstall(args.slice(1));
      break;
    case 'remove':
      await cmdSkillsRemove(args.slice(1));
      break;
    case 'sync':
      await cmdSkillsSync(args.slice(1));
      break;
    default:
      printSkillsHelp();
      break;
  }
}

async function cmdSkillsList(args: string[]): Promise<void> {
  const backend = args.includes('--backend') ? args[args.indexOf('--backend') + 1] : undefined;
  const mgr = new SkillsManager();
  const skills = mgr.list(backend);

  if (skills.length === 0) {
    console.log(backend ? `No skills installed for backend: ${backend}` : 'No skills installed.');
    console.log('\nInstall: imtoagent skills install <github-url | zip | local-path>');
    return;
  }

  console.log(`\n🧩 Installed Skills — ${skills.length} total\n`);
  console.log(pad('Name', 24) + pad('Source', 50) + 'Backends');
  console.log('─'.repeat(82));

  for (const { name, meta } of skills) {
    const source = meta.source.substring(0, 49);
    console.log(pad(name, 24) + pad(source, 50) + meta.backends.join(', '));
  }
  console.log();
}

async function cmdSkillsInstall(args: string[]): Promise<void> {
  const source = args[0];
  if (!source) {
    console.log('Usage: imtoagent skills install <github-url | zip-path | local-path>');
    console.log('  --name <name>           Override skill name');
    console.log('  --backend claude,codex  Target backends');
    return;
  }

  let name: string | undefined;
  let backends: string[] = ['claude', 'codex', 'opencode'];

  for (let i = 1; i < args.length; i++) {
    if (args[i] === '--name' && i + 1 < args.length) {
      name = args[++i];
    } else if (args[i] === '--backend') {
      backends = args[++i].split(',').map((b) => b.trim());
    }
  }

  try {
    const mgr = new SkillsManager();
    const result = mgr.install(source, { name, backends });
    console.log(`✅ Skill "${result.name}" installed to: ${result.path}`);
    console.log(`\nRun "imtoagent skills sync" to push to backend configs.`);
  } catch (err: any) {
    console.error(`❌ Failed to install skill: ${err.message}`);
  }
}

async function cmdSkillsRemove(args: string[]): Promise<void> {
  const name = args[0];
  if (!name) { console.log('Usage: imtoagent skills remove <name>'); return; }

  const mgr = new SkillsManager();
  if (!mgr.remove(name)) { console.log(`Skill "${name}" not found.`); return; }
  console.log(`✅ Skill "${name}" removed.`);
}

async function cmdSkillsSync(args: string[]): Promise<void> {
  const backend = args.includes('--backend') ? args[args.indexOf('--backend') + 1] : undefined;

  const mgr = new SkillsManager();
  const result = mgr.sync(backend);

  if (result.synced.length > 0) console.log(`✅ Synced to: ${result.synced.join(', ')}`);
  for (const e of result.errors) console.error(`❌ ${e}`);
  if (result.synced.length === 0 && result.errors.length === 0) {
    console.log('Nothing to sync.');
  }
}

function pad(s: string, width: number): string { return s.padEnd(width); }

function printSkillsHelp(): void {
  console.log(`
imtoagent skills — Skills management

Usage:
  imtoagent skills list [--backend claude]  List installed skills
  imtoagent skills install <source>         Install from GitHub/ZIP/local
  imtoagent skills remove <name>            Remove a skill
  imtoagent skills sync [--backend claude]  Sync to backend configs

Sources:
  GitHub URL:  https://github.com/user/repo
  ZIP file:    /path/to/skill.zip
  Local dir:   /path/to/skill-dir/
`);
}
