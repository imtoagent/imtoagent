// ================================================================
// Prompts Manager — Manage shared prompt files (CLAUDE.md, AGENTS.md, etc.)
// ================================================================
// Storage: ~/.imtoagent/prompts/<name>.md
// Sync targets: backend-specific prompt locations
// ================================================================

import * as fs from 'fs';
import * as path from 'path';
import { getDataDir } from './paths';

// ================================================================
// PromptsManager class
// ================================================================

export class PromptsManager {
  private prompts_dir: string;

  constructor(dataDir?: string) {
    const base = dataDir || getDataDir();
    this.prompts_dir = path.join(base, 'prompts');
    fs.mkdirSync(this.prompts_dir, { recursive: true });
  }

  // ================================================================
  // List
  // ================================================================

  list(): { name: string; size: number; mtime: Date }[] {
    if (!fs.existsSync(this.prompts_dir)) return [];

    const files = fs.readdirSync(this.prompts_dir).filter((f) => f.endsWith('.md'));
    return files.map((f) => {
      const stat = fs.statSync(path.join(this.prompts_dir, f));
      return {
        name: f.replace('.md', ''),
        size: stat.size,
        mtime: stat.mtime,
      };
    });
  }

  // ================================================================
  // Get / Save
  // ================================================================

  get(name: string): string | null {
    const filePath = path.join(this.prompts_dir, `${name}.md`);
    if (!fs.existsSync(filePath)) return null;
    return fs.readFileSync(filePath, 'utf-8');
  }

  save(name: string, content: string): void {
    const filePath = path.join(this.prompts_dir, `${name}.md`);
    fs.writeFileSync(filePath, content);
  }

  remove(name: string): boolean {
    const filePath = path.join(this.prompts_dir, `${name}.md`);
    if (!fs.existsSync(filePath)) return false;
    fs.unlinkSync(filePath);
    return true;
  }

  // ================================================================
  // Sync to backends
  // ================================================================

  sync(backend?: string): { synced: string[]; errors: string[] } {
    const result = { synced: [] as string[], errors: [] as string[] };
    const backends = backend ? [backend] : ['claude', 'codex', 'opencode'];

    // Get all prompts
    const prompts = this.list();
    if (prompts.length === 0) {
      return result;
    }

    for (const b of backends) {
      try {
        const targets = this.getBackendTargets(b);

        for (const prompt of prompts) {
          const content = this.get(prompt.name);
          if (!content) continue;

          // Determine target file name based on backend
          const targetName = this.mapPromptName(prompt.name, b);

          for (const targetDir of targets) {
            if (!fs.existsSync(targetDir)) {
              fs.mkdirSync(targetDir, { recursive: true });
            }
            const targetPath = path.join(targetDir, targetName);
            fs.writeFileSync(targetPath, content);
          }
        }

        result.synced.push(b);
      } catch (err: unknown) {
        result.errors.push(`${b}: ${err.message}`);
      }
    }

    return result;
  }

  /**
   * Map a prompt name to backend-specific filename.
   * E.g., "claude" → CLAUDE.md, "agents" → AGENTS.md
   */
  private mapPromptName(name: string, backend: string): string {
    // Common mappings
    const mappings: Record<string, Record<string, string>> = {
      claude: { 'claude': 'CLAUDE.md', 'agents': 'AGENTS.md', 'system': 'CLAUDE.md' },
      codex: { 'claude': 'CLAUDE.md', 'agents': 'AGENTS.md', 'system': 'AGENTS.md' },
      opencode: { 'claude': 'CLAUDE.md', 'agents': 'AGENTS.md', 'system': 'prompts.md' },
    };

    const backendMap = mappings[backend] || mappings.claude;
    return backendMap[name.toLowerCase()] || `${name.toUpperCase()}.md`;
  }

  /**
   * Get backend-specific target directories.
   */
  private getBackendTargets(backend: string): string[] {
    const home = process.env.HOME || '';
    switch (backend) {
      case 'claude':
        return [path.join(home, '.claude'), home];
      case 'codex':
        return [path.join(home, '.codex'), home];
      case 'opencode':
        return [path.join(home, '.opencode')];
      default:
        return [home];
    }
  }
}
