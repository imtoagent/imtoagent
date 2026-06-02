// ================================================================
// imtoagent skills — Skills management CLI
// ================================================================
// Commands: list, install, remove
// Storage:
//   System-level: ~/.imtoagent/skills/<name>/SKILL.md
//   Bot-level:    ~/.imtoagent/bots/<botId>/skills/<name>/SKILL.md
// All skills are injected via system prompt — no backend sync.
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
    default:
      printSkillsHelp();
      break;
  }
}

async function cmdSkillsList(args: string[]): Promise<void> {
  const botId = extractBotId(args);
  const mgr = new SkillsManager(botId || undefined);
  const skills = mgr.list();

  if (skills.length === 0) {
    const label = botId ? `Bot "${botId}"` : 'System';
    console.log(`No skills installed (${label}-level).`);
    console.log('\nInstall: imtoagent skills install <local-path>');
    return;
  }

  const label = botId ? `Bot "${botId}"` : 'System';
  console.log(`\n🧩 Installed Skills (${label}-level) — ${skills.length} total\n`);
  console.log(pad('Name', 24) + 'Description');
  console.log('─'.repeat(82));

  for (const s of skills) {
    const desc = s.description.substring(0, 58);
    console.log(pad(s.name, 24) + desc);
  }
  console.log();
}

async function cmdSkillsInstall(args: string[]): Promise<void> {
  const source = args[0];
  if (!source) {
    console.log('Usage: imtoagent skills install <local-path>');
    console.log('  --name <name>   Override skill name');
    console.log('  --bot <botId>   Install to bot-level (instead of system-level)');
    return;
  }

  let name: string | undefined;
  const botId = extractBotId(args);

  for (let i = 1; i < args.length; i++) {
    if (args[i] === '--name' && i + 1 < args.length) {
      name = args[++i];
    }
  }

  try {
    const mgr = new SkillsManager(botId || undefined);
    const result = mgr.install(source, { name });
    const label = botId ? `bot "${botId}"` : 'system';
    console.log(`✅ Skill "${result.name}" installed to ${label}-level: ${result.path}`);
  } catch (err: unknown) {
    console.error(`❌ Failed to install skill: ${(err as Error).message}`);
  }
}

async function cmdSkillsRemove(args: string[]): Promise<void> {
  const name = args[0];
  if (!name) { console.log('Usage: imtoagent skills remove <name>'); return; }

  const botId = extractBotId(args);
  const mgr = new SkillsManager(botId || undefined);
  if (!mgr.remove(name)) {
    const label = botId ? `bot "${botId}"` : 'system';
    console.log(`Skill "${name}" not found (${label}-level).`);
    return;
  }
  const label = botId ? `bot "${botId}"` : 'system';
  console.log(`✅ Skill "${name}" removed (${label}-level).`);
}

function extractBotId(args: string[]): string | undefined {
  const idx = args.indexOf('--bot');
  if (idx >= 0 && idx + 1 < args.length) {
    return args[idx + 1];
  }
  return undefined;
}

function pad(s: string, width: number): string { return s.padEnd(width); }

function printSkillsHelp(): void {
  console.log(`
imtoagent skills — Skills management

Usage:
  imtoagent skills list                   List system-level skills
  imtoagent skills list --bot <botId>     List bot-level skills
  imtoagent skills install <local-path>   Install a skill (system-level)
  imtoagent skills install <path> --bot <botId>  Install to bot-level
  imtoagent skills install <path> --name <name>  Override skill name
  imtoagent skills remove <name>          Remove a skill (system-level)
  imtoagent skills remove <name> --bot <botId>   Remove from bot-level

Note: All skills are injected via system prompt. No backend sync needed.
`);
}
