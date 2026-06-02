// ================================================================
// imtoagent mcp — MCP server management CLI
// ================================================================
// Commands: list, add, remove, enable, disable, import
// Storage:
//   System-level: ~/.imtoagent/mcp.json
//   Bot-level:    ~/.imtoagent/bots/<botId>/mcp.json
// All MCP config is injected via system prompt — no backend sync.
// ================================================================

import * as fs from 'fs';
import { McpManager } from '../utils/mcp-manager';

// ================================================================
// Main entry
// ================================================================

export async function cmdMcp(...args: string[]): Promise<void> {
  const subCmd = args[0] || 'list';

  switch (subCmd) {
    case 'list':
      await cmdMcpList(args.slice(1));
      break;
    case 'add':
      await cmdMcpAdd(args.slice(1));
      break;
    case 'remove':
      await cmdMcpRemove(args.slice(1));
      break;
    case 'enable':
      await cmdMcpEnable(args.slice(1));
      break;
    case 'disable':
      await cmdMcpDisable(args.slice(1));
      break;
    case 'import':
      await cmdMcpImport(args.slice(1));
      break;
    default:
      printMcpHelp();
      break;
  }
}

// ================================================================
// list — Show MCP servers
// ================================================================

async function cmdMcpList(args: string[]): Promise<void> {
  const botId = extractBotId(args);
  const mcp = new McpManager(botId || undefined);
  const servers = mcp.list();
  const entries = Object.entries(servers);

  if (entries.length === 0) {
    const label = botId ? `Bot "${botId}"` : 'System';
    console.log(`No MCP servers configured (${label}-level).`);
    console.log('\nAdd one: imtoagent mcp add <name> --command "npx -y @xxx"');
    return;
  }

  const label = botId ? `Bot "${botId}"` : 'System';
  console.log(`\n🔌 MCP Servers (${label}-level) — ${entries.length} server(s)\n`);
  console.log(pad('Name', 22) + pad('Command', 40) + 'Status');
  console.log('─'.repeat(70));

  for (const [name, cfg] of entries) {
    const cmdStr = `${cfg.command} ${cfg.args.slice(0, 3).join(' ')}`.substring(0, 39);
    const status = cfg.enabled ? '✅ enabled' : '⏸️ disabled';
    console.log(pad(name, 22) + pad(cmdStr, 40) + status);
  }
  console.log();
}

// ================================================================
// add — Add MCP server
// ================================================================

async function cmdMcpAdd(args: string[]): Promise<void> {
  const name = args[0];
  if (!name) {
    console.log('Usage: imtoagent mcp add <name> --command "npx -y @xxx/mcp" [--env KEY=val]');
    return;
  }

  let command = '';
  const cmdArgs: string[] = [];
  const env: Record<string, string> = {};

  for (let i = 1; i < args.length; i++) {
    switch (args[i]) {
      case '--command':
        command = args[++i];
        break;
      case '--args':
        cmdArgs.push(...args[++i].split(','));
        break;
      case '--env': {
        const kv = args[++i].split('=');
        if (kv.length >= 2) env[kv[0]] = kv.slice(1).join('=');
        break;
      }
    }
  }

  if (!command) {
    console.log('Error: --command is required.');
    console.log('Example: imtoagent mcp add filesystem --command "npx" --args "-y,@modelcontextprotocol/server-filesystem,/path"');
    return;
  }

  const botId = extractBotId(args);
  const mcp = new McpManager(botId || undefined);
  mcp.add(name, {
    command,
    args: cmdArgs,
    env,
    enabled: true,
  });

  const label = botId ? `bot "${botId}"` : 'system';
  console.log(`✅ MCP server "${name}" added (${label}-level).`);
  console.log(`   Command: ${command} ${cmdArgs.join(' ')}`);
}

// ================================================================
// remove — Remove MCP server
// ================================================================

async function cmdMcpRemove(args: string[]): Promise<void> {
  const name = args[0];
  if (!name) {
    console.log('Usage: imtoagent mcp remove <name>');
    return;
  }

  const botId = extractBotId(args);
  const mcp = new McpManager(botId || undefined);
  if (!mcp.remove(name)) {
    const label = botId ? `bot "${botId}"` : 'system';
    console.log(`MCP server "${name}" not found (${label}-level).`);
    return;
  }

  const label = botId ? `bot "${botId}"` : 'system';
  console.log(`✅ MCP server "${name}" removed (${label}-level).`);
}

// ================================================================
// enable / disable
// ================================================================

async function cmdMcpEnable(args: string[]): Promise<void> {
  const name = args[0];
  if (!name) { console.log('Usage: imtoagent mcp enable <name>'); return; }

  const botId = extractBotId(args);
  const mcp = new McpManager(botId || undefined);
  if (!mcp.enable(name)) {
    const label = botId ? `bot "${botId}"` : 'system';
    console.log(`MCP server "${name}" not found (${label}-level).`);
    return;
  }
  console.log(`✅ MCP server "${name}" enabled.`);
}

async function cmdMcpDisable(args: string[]): Promise<void> {
  const name = args[0];
  if (!name) { console.log('Usage: imtoagent mcp disable <name>'); return; }

  const botId = extractBotId(args);
  const mcp = new McpManager(botId || undefined);
  if (!mcp.disable(name)) {
    const label = botId ? `bot "${botId}"` : 'system';
    console.log(`MCP server "${name}" not found (${label}-level).`);
    return;
  }
  console.log(`✅ MCP server "${name}" disabled.`);
}

// ================================================================
// import — Import from JSON file or string
// ================================================================

async function cmdMcpImport(args: string[]): Promise<void> {
  const source = args[0];
  if (!source) {
    console.log('Usage: imtoagent mcp import <file.json | JSON string>');
    return;
  }

  const botId = extractBotId(args);
  const mcp = new McpManager(botId || undefined);
  const result = mcp.import(source);

  if (result.imported > 0) {
    const label = botId ? `bot "${botId}"` : 'system';
    console.log(`✅ Imported ${result.imported} MCP server(s) (${label}-level).`);
  }
  if (result.errors.length > 0) {
    for (const e of result.errors) {
      console.error(`❌ ${e}`);
    }
  }
}

// ================================================================
// Helpers
// ================================================================

function extractBotId(args: string[]): string | undefined {
  const idx = args.indexOf('--bot');
  if (idx >= 0 && idx + 1 < args.length) {
    return args[idx + 1];
  }
  return undefined;
}

function pad(s: string, width: number): string {
  return s.padEnd(width);
}

function printMcpHelp(): void {
  console.log(`
imtoagent mcp — MCP server management

Usage:
  imtoagent mcp list                          List system-level MCP servers
  imtoagent mcp list --bot <botId>            List bot-level MCP servers
  imtoagent mcp add <name> --command "cmd"    Add MCP server (system-level)
  imtoagent mcp add <name> --command "cmd" --bot <botId>  Add to bot-level
  imtoagent mcp remove <name>                 Remove MCP server (system-level)
  imtoagent mcp enable <name>                 Enable MCP server
  imtoagent mcp disable <name>                Disable MCP server
  imtoagent mcp import <file.json>            Import from JSON

Note: All MCP config is injected via system prompt. No backend sync needed.
`);
}
