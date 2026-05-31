// ================================================================
// imtoagent prompts — Prompts management CLI
// ================================================================
// Commands: list, show, save, remove, sync
// ================================================================

import * as fs from 'fs';
import { PromptsManager } from '../utils/prompts-manager';

export async function cmdPrompts(...args: string[]): Promise<void> {
  const subCmd = args[0] || 'list';

  switch (subCmd) {
    case 'list':
      await cmdPromptsList();
      break;
    case 'show':
      await cmdPromptsShow(args.slice(1));
      break;
    case 'save':
      await cmdPromptsSave(args.slice(1));
      break;
    case 'remove':
      await cmdPromptsRemove(args.slice(1));
      break;
    case 'sync':
      await cmdPromptsSync(args.slice(1));
      break;
    default:
      printPromptsHelp();
      break;
  }
}

async function cmdPromptsList(): Promise<void> {
  const mgr = new PromptsManager();
  const prompts = mgr.list();

  if (prompts.length === 0) {
    console.log('No prompts saved.');
    console.log('\nSave: imtoagent prompts save <name> <content>');
    return;
  }

  console.log(`\n📝 Saved Prompts — ${prompts.length} total\n`);
  console.log(pad('Name', 24) + pad('Size', 10) + 'Modified');
  console.log('─'.repeat(60));

  for (const p of prompts) {
    const mtime = p.mtime.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
    console.log(pad(p.name, 24) + pad(formatSize(p.size), 10) + mtime);
  }
  console.log();
}

async function cmdPromptsShow(args: string[]): Promise<void> {
  const name = args[0];
  if (!name) { console.log('Usage: imtoagent prompts show <name>'); return; }

  const mgr = new PromptsManager();
  const content = mgr.get(name);
  if (!content) { console.log(`Prompt "${name}" not found.`); return; }

  console.log(`\n📝 ${name}.md\n`);
  console.log(content);
  console.log();
}

async function cmdPromptsSave(args: string[]): Promise<void> {
  const name = args[0];
  if (!name) { console.log('Usage: imtoagent prompts save <name> <content>'); return; }

  const content = args.slice(1).join(' ');
  if (!content) {
    // Read from stdin if available
    console.log('Usage: imtoagent prompts save <name> <content>');
    console.log('  Or pipe content: cat CLAUDE.md | imtoagent prompts save <name>');
    return;
  }

  const mgr = new PromptsManager();
  mgr.save(name, content);
  console.log(`✅ Prompt "${name}" saved.`);
}

async function cmdPromptsRemove(args: string[]): Promise<void> {
  const name = args[0];
  if (!name) { console.log('Usage: imtoagent prompts remove <name>'); return; }

  const mgr = new PromptsManager();
  if (!mgr.remove(name)) { console.log(`Prompt "${name}" not found.`); return; }
  console.log(`✅ Prompt "${name}" removed.`);
}

async function cmdPromptsSync(args: string[]): Promise<void> {
  const backend = args.includes('--backend') ? args[args.indexOf('--backend') + 1] : undefined;

  const mgr = new PromptsManager();
  const result = mgr.sync(backend);

  if (result.synced.length > 0) console.log(`✅ Synced to: ${result.synced.join(', ')}`);
  for (const e of result.errors) console.error(`❌ ${e}`);
  if (result.synced.length === 0 && result.errors.length === 0) {
    console.log('Nothing to sync (no prompts saved).');
  }
}

function pad(s: string, width: number): string { return s.padEnd(width); }
function formatSize(bytes: number): string {
  if (bytes >= 1024) return (bytes / 1024).toFixed(1) + 'KB';
  return bytes + 'B';
}

function printPromptsHelp(): void {
  console.log(`
imtoagent prompts — Prompts management

Usage:
  imtoagent prompts list               List saved prompts
  imtoagent prompts show <name>        Show prompt content
  imtoagent prompts save <name> <text> Save prompt
  imtoagent prompts remove <name>      Remove a prompt
  imtoagent prompts sync [--backend claude]  Sync to backend configs
`);
}
