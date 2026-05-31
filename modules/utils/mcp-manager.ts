// ================================================================
// MCP Manager — Unified MCP server management across backends
// ================================================================
// Storage: ~/.imtoagent/mcp.json
// Sync targets: ~/.claude.json, ~/.codex/config.json, ~/.imtoagent/opencode.json
// ================================================================

import * as fs from 'fs';
import * as path from 'path';
import { getDataDir } from './paths';

// ================================================================
// MCP server definition
// ================================================================

export interface McpServerConfig {
  command: string;
  args: string[];
  env?: Record<string, string>;
  enabled: boolean;
  backends: string[]; // which backends to sync to: claude, codex, opencode
  source: 'cli' | 'import';
}

export interface McpData {
  servers: Record<string, McpServerConfig>;
}

// ================================================================
// McpManager class
// ================================================================

export class McpManager {
  private mcpPath: string;
  private data: McpData;

  constructor(dataDir?: string) {
    const base = dataDir || getDataDir();
    this.mcpPath = path.join(base, 'mcp.json');
    this.data = this.load();
  }

  // ================================================================
  // Load / Save
  // ================================================================

  private load(): McpData {
    if (!fs.existsSync(this.mcpPath)) {
      return { servers: {} };
    }
    try {
      const raw = fs.readFileSync(this.mcpPath, 'utf-8');
      return JSON.parse(raw);
    } catch {
      return { servers: {} };
    }
  }

  save(): void {
    fs.writeFileSync(this.mcpPath, JSON.stringify(this.data, null, 2));
  }

  // ================================================================
  // CRUD
  // ================================================================

  list(backend?: string): Record<string, McpServerConfig> {
    if (!backend) return { ...this.data.servers };

    const filtered: Record<string, McpServerConfig> = {};
    for (const [name, cfg] of Object.entries(this.data.servers)) {
      if (cfg.backends.includes(backend)) {
        filtered[name] = cfg;
      }
    }
    return filtered;
  }

  add(name: string, config: Omit<McpServerConfig, 'source'>): void {
    this.data.servers[name] = {
      ...config,
      source: 'cli',
    };
    this.save();
  }

  remove(name: string): boolean {
    if (!this.data.servers[name]) return false;
    delete this.data.servers[name];
    this.save();
    return true;
  }

  enable(name: string): boolean {
    if (!this.data.servers[name]) return false;
    this.data.servers[name].enabled = true;
    this.save();
    return true;
  }

  disable(name: string): boolean {
    if (!this.data.servers[name]) return false;
    this.data.servers[name].enabled = false;
    this.save();
    return true;
  }

  get(name: string): McpServerConfig | undefined {
    return this.data.servers[name];
  }

  // ================================================================
  // Sync to backend configs
  // ================================================================

  sync(backend?: string): SyncResult {
    const result: SyncResult = { synced: [], errors: [] };
    const backends = backend ? [backend] : ['claude', 'codex', 'opencode'];

    for (const b of backends) {
      try {
        const servers = this.list(b);
        const enabledServers = Object.entries(servers)
          .filter(([, cfg]) => cfg.enabled)
          .reduce<Record<string, any>>((acc, [name, cfg]) => {
            acc[name] = this.toBackendFormat(name, cfg, b);
            return acc;
          }, {});

        switch (b) {
          case 'claude':
            this.syncToClaude(enabledServers);
            result.synced.push('claude');
            break;
          case 'codex':
            this.syncToCodex(enabledServers);
            result.synced.push('codex');
            break;
          case 'opencode':
            this.syncToOpenCode(enabledServers);
            result.synced.push('opencode');
            break;
        }
      } catch (err: any) {
        result.errors.push({ backend: b, error: err.message });
      }
    }

    return result;
  }

  // ================================================================
  // Import from JSON
  // ================================================================

  import(source: string): { imported: number; errors: string[] } {
    const result = { imported: 0, errors: [] };
    let parsed: any;

    // Try parse as JSON string
    try {
      parsed = JSON.parse(source);
    } catch {
      // Try as file path
      try {
        if (fs.existsSync(source)) {
          parsed = JSON.parse(fs.readFileSync(source, 'utf-8'));
        } else {
          result.errors.push(`File not found: ${source}`);
          return result;
        }
      } catch {
        result.errors.push(`Invalid JSON: ${source.substring(0, 100)}`);
        return result;
      }
    }

    // Support multiple formats
    const servers = parsed.servers || parsed.mcpServers || parsed;

    for (const [name, cfg] of Object.entries(servers)) {
      try {
        const serverCfg = this.normalizeImportConfig(cfg);
        if (serverCfg) {
          this.add(name, serverCfg);
          result.imported++;
        }
      } catch (err: any) {
        result.errors.push(`${name}: ${err.message}`);
      }
    }

    return result;
  }

  private normalizeImportConfig(cfg: any): Omit<McpServerConfig, 'source'> | null {
    if (cfg.command) {
      return {
        command: cfg.command,
        args: cfg.args || [],
        env: cfg.env || {},
        enabled: cfg.enabled !== false,
        backends: cfg.backends || ['claude', 'codex', 'opencode'],
      };
    }
    // OpenAI MCP format (url-based)
    if (cfg.url || cfg.baseUrl) {
      return {
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/client', cfg.url || cfg.baseUrl],
        env: {},
        enabled: true,
        backends: ['claude', 'codex', 'opencode'],
      };
    }
    return null;
  }

  // ================================================================
  // Backend-specific sync
  // ================================================================

  private toBackendFormat(name: string, cfg: McpServerConfig, backend: string): any {
    switch (backend) {
      case 'claude':
      case 'codex':
        // Both use the same stdio format
        return {
          command: cfg.command,
          args: cfg.args,
          env: cfg.env || {},
        };
      case 'opencode':
        return {
          command: `${cfg.command} ${cfg.args.join(' ')}`.trim(),
          env: cfg.env || {},
        };
      default:
        return { command: cfg.command, args: cfg.args, env: cfg.env || {} };
    }
  }

  private syncToClaude(servers: Record<string, any>): void {
    const home = process.env.HOME || '';
    const claudeConfigPath = path.join(home, '.claude', 'settings.json');
    const claudeJsonPath = path.join(home, '.claude.json');

    // Try ~/.claude/settings.json first (Claude Code standard location)
    let configPath = claudeConfigPath;
    let config: any = {};

    if (fs.existsSync(claudeConfigPath)) {
      try {
        config = JSON.parse(fs.readFileSync(claudeConfigPath, 'utf-8'));
      } catch {
        config = {};
      }
    } else if (fs.existsSync(claudeJsonPath)) {
      configPath = claudeJsonPath;
      try {
        config = JSON.parse(fs.readFileSync(claudeJsonPath, 'utf-8'));
      } catch {
        config = {};
      }
    } else {
      // Create default
      fs.mkdirSync(path.dirname(claudeConfigPath), { recursive: true });
    }

    config.mcpServers = servers;
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
  }

  private syncToCodex(servers: Record<string, any>): void {
    const home = process.env.HOME || '';
    const codexConfigPath = path.join(home, '.codex', 'config.json');

    let config: any = {};
    if (fs.existsSync(codexConfigPath)) {
      try {
        config = JSON.parse(fs.readFileSync(codexConfigPath, 'utf-8'));
      } catch {
        config = {};
      }
    } else {
      fs.mkdirSync(path.dirname(codexConfigPath), { recursive: true });
    }

    config.mcpServers = servers;
    fs.writeFileSync(codexConfigPath, JSON.stringify(config, null, 2));
  }

  private syncToOpenCode(servers: Record<string, any>): void {
    const { getOpencodeConfigPath } = require('./paths');
    const opencodeConfigPath = getOpencodeConfigPath();

    let config: any = {};
    if (fs.existsSync(opencodeConfigPath)) {
      try {
        config = JSON.parse(fs.readFileSync(opencodeConfigPath, 'utf-8'));
      } catch {
        config = {};
      }
    }

    config.mcpServers = servers;
    fs.writeFileSync(opencodeConfigPath, JSON.stringify(config, null, 2));
  }
}

export interface SyncResult {
  synced: string[];
  errors: { backend: string; error: string }[];
}
