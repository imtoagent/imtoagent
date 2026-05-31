// ================================================================
// imtoagent mcp — MCP server management CLI
// ================================================================
// Commands: list, add, remove, enable, disable, sync, import
// Storage: ~/.imtoagent/mcp.json
// Sync targets: ~/.claude.json, ~/.codex/config.json, opencode.json
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
    case 'sync':
      await cmdMcpSync(args.slice(1));
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
  const mcp = new McpManager();
  const backend = args.includes('--backend') ? args[args.indexOf('--backend') + 1] : undefined;

  const servers = mcp.list(backend);
  const entries = Object.entries(servers);

  if (entries.length === 0) {
    console.log(backend ? `No MCP servers configured for backend: ${backend}` : 'No MCP servers configured.');
    console.log('\nAdd one: imtoagent mcp add <name> --command "npx -y @xxx"');
    return;
  }

  const label = backend ? `MCP Servers (${backend})` : 'MCP Servers';
  console.log(`\n🔌 ${label} — ${entries.length} server(s)\n`);
  console.log(pad('Name', 22) + pad('Command', 35) + pad('Backends', 20) + 'Status');
  console.log('─'.repeat(85));

  for (const [name, cfg] of entries) {
    const cmdStr = `${cfg.command} ${cfg.args.slice(0, 3).join(' ')}`.substring(0, 34);
    const backends = cfg.backends.join(', ');
    const status = cfg.enabled ? '✅' : '⏸️ ';
    console.log(pad(name, 22) + pad(cmdStr, 35) + pad(backends, 20) + status);
  }
  console.log();
}

// ================================================================
// add — Add MCP server
// ================================================================

async function cmdMcpAdd(args: string[]): Promise<void> {
  const name = args[0];
  if (!name) {
    console.log('Usage: imtoagent mcp add <name> --command "npx -y @xxx/mcp" [--env KEY=val] [--backend claude,codex]');
    return;
  }

  let command = '';
  const cmdArgs: string[] = [];
  const env: Record<string, string> = {};
  const backends = ['claude', 'codex', 'opencode'];

  for (let i = 1; i < args.length; i++) {
    switch (args[i]) {
      case '--command':
        command = args[++i];
        break;
      case '--args':
        // Parse comma-separated args
        cmdArgs.push(...args[++i].split(','));
        break;
      case '--env': {
        const kv = args[++i].split('=');
        if (kv.length >= 2) env[kv[0]] = kv.slice(1).join('=');
        break;
      }
      case '--backend':
        backends.length = 0;
        backends.push(...args[++i].split(',').map((b) => b.trim()));
        break;
    }
  }

  if (!command) {
    console.log('Error: --command is required.');
    console.log('Example: imtoagent mcp add filesystem --command "npx" --args "-y,@modelcontextprotocol/server-filesystem,/path"');
    return;
  }

  const mcp = new McpManager();
  mcp.add(name, {
    command,
    args: cmdArgs,
    env,
    enabled: true,
    backends,
  });

  console.log(`✅ MCP server "${name}" added.`);
  console.log(`   Command: ${command} ${cmdArgs.join(' ')}`);
  console.log(`   Backends: ${backends.join(', ')}`);
  console.log(`\nRun "imtoagent mcp sync" to push to backend configs.`);
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

  const mcp = new McpManager();
  if (!mcp.remove(name)) {
    console.log(`MCP server "${name}" not found.`);
    return;
  }

  console.log(`✅ MCP server "${name}" removed.`);
  console.log(`Run "imtoagent mcp sync" to update backend configs.`);
}

// ================================================================
// enable / disable
// ================================================================

async function cmdMcpEnable(args: string[]): Promise<void> {
  const name = args[0];
  if (!name) { console.log('Usage: imtoagent mcp enable <name>'); return; }

  const mcp = new McpManager();
  if (!mcp.enable(name)) { console.log(`MCP server "${name}" not found.`); return; }
  console.log(`✅ MCP server "${name}" enabled.`);
}

async function cmdMcpDisable(args: string[]): Promise<void> {
  const name = args[0];
  if (!name) { console.log('Usage: imtoagent mcp disable <name>'); return; }

  const mcp = new McpManager();
  if (!mcp.disable(name)) { console.log(`MCP server "${name}" not found.`); return; }
  console.log(`✅ MCP server "${name}" disabled.`);
}

// ================================================================
// sync — Push to backend configs
// ================================================================

async function cmdMcpSync(args: string[]): Promise<void> {
  const backend = args.includes('--backend') ? args[args.indexOf('--backend') + 1] : undefined;

  const mcp = new McpManager();
  const result = mcp.sync(backend);

  if (result.synced.length > 0) {
    console.log(`✅ Synced to: ${result.synced.join(', ')}`);
  }
  if (result.errors.length > 0) {
    for (const e of result.errors) {
      console.error(`❌ ${e.backend}: ${e.error}`);
    }
  }
  if (result.synced.length === 0 && result.errors.length === 0) {
    console.log('Nothing to sync (no MCP servers configured).');
  }
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

  const mcp = new McpManager();
  const result = mcp.import(source);

  if (result.imported > 0) {
    console.log(`✅ Imported ${result.imported} MCP server(s).`);
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

function pad(s: string, width: number): string {
  return s.padEnd(width);
}

function printMcpHelp(): void {
  console.log(`
imtoagent mcp — MCP server management

Usage:
  imtoagent mcp list [--backend claude]     List MCP servers
  imtoagent mcp add <name> --command "cmd"  Add MCP server
  imtoagent mcp add <name> --command "npx" --args "-y,@xxx" --env KEY=val
  imtoagent mcp remove <name>               Remove MCP server
  imtoagent mcp enable <name>               Enable MCP server
  imtoagent mcp disable <name>              Disable MCP server
  imtoagent mcp sync [--backend claude]     Sync to backend configs
  imtoagent mcp import <file.json>          Import from JSON file
`);
}
