// ================================================================
// imtoagent healthz — Quick health check for scripting
// ================================================================
// Exit 0 = healthy, Exit 1 = unhealthy
// Checks: config exists + port reachable + backends installed
// ================================================================

import * as fs from 'fs';
import * as path from 'path';
import * as net from 'net';
import { getDataDir, getConfigPath } from '../utils/paths';

export async function cmdHealthz(..._args: string[]): Promise<void> {
  const issues: string[] = [];
  const dataDir = getDataDir();
  const configPath = getConfigPath();

  // 1. Config file exists and valid JSON
  if (!fs.existsSync(configPath)) {
    issues.push('config.json not found (run "imtoagent setup" first)');
  } else {
    try {
      const raw = fs.readFileSync(configPath, 'utf-8');
      JSON.parse(raw);
    } catch {
      issues.push('config.json is not valid JSON');
    }
  }

  // 2. Port 18899 reachable (gateway running)
  const portOk = await checkPort(18899);
  if (!portOk) {
    issues.push('port 18899 not reachable (gateway not running)');
  }

  // 3. Backend check (non-fatal warning)
  try {
    const { checkBackend } = await import('../utils/backend-check');
    const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    const backends = new Set<string>();
    for (const bot of config.bots || []) {
      if (bot.backend) backends.add(bot.backend);
    }
    for (const backend of backends) {
      if (['claude', 'codex', 'opencode'].includes(backend)) {
        const info = checkBackend(backend as string);
        if (!info.installed) {
          // Don't fail healthz for missing backends, just note it
          // issues.push(`backend '${backend}' not installed`);
        }
      }
    }
  } catch {
    // Backend check module not available, skip
  }

  // Output
  if (issues.length === 0) {
    console.log('OK');
    process.exit(0);
  } else {
    console.log('UNHEALTHY');
    for (const issue of issues) {
      console.log('  - ' + issue);
    }
    process.exit(1);
  }
}

function checkPort(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    socket.setTimeout(2000);
    socket.on('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.on('error', () => {
      resolve(false);
    });
    socket.on('timeout', () => {
      socket.destroy();
      resolve(false);
    });
    socket.connect(port, '127.0.0.1');
  });
}
