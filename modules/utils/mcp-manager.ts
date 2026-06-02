// ================================================================
// MCP Manager — Unified MCP server management
// ================================================================
// Storage:
//   System-level: ~/.imtoagent/mcp.json
//   Bot-level:    ~/.imtoagent/bots/<botId>/mcp.json
// No sync to backend configs — MCP is injected via system prompt.
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

  /**
   * @param botId - If provided, MCP config is stored at bot-level.
   *                If omitted, MCP config is stored at system-level.
   */
  constructor(botId?: string) {
    const base = getDataDir();
    if (botId) {
      this.mcpPath = path.join(base, 'bots', botId, 'mcp.json');
    } else {
      this.mcpPath = path.join(base, 'mcp.json');
    }
    const dir = path.dirname(this.mcpPath);
    fs.mkdirSync(dir, { recursive: true });
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
    const dir = path.dirname(this.mcpPath);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(this.mcpPath, JSON.stringify(this.data, null, 2));
  }

  // ================================================================
  // CRUD
  // ================================================================

  list(): Record<string, McpServerConfig> {
    return { ...this.data.servers };
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
  // Import from JSON
  // ================================================================

  import(source: string): { imported: number; errors: string[] } {
    const result = { imported: 0, errors: [] };
    let parsed: Record<string, unknown> | McpData | null;

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
      } catch (err: unknown) {
        result.errors.push(`${name}: ${err.message}`);
      }
    }

    return result;
  }

  private normalizeImportConfig(cfg: unknown): Omit<McpServerConfig, 'source'> | null {
    const c = cfg as Record<string, unknown>;
    if (c.command) {
      return {
        command: c.command as string,
        args: (c.args as string[]) || [],
        env: (c.env as Record<string, string>) || {},
        enabled: c.enabled !== false,
      };
    }
    // OpenAI MCP format (url-based)
    if (c.url || c.baseUrl) {
      return {
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/client', (c.url || c.baseUrl) as string],
        env: {},
        enabled: true,
      };
    }
    return null;
  }
}
