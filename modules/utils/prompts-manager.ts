// ================================================================
// Prompts Manager — Manage prompt files
// ================================================================
// Storage:
//   System-level: ~/.imtoagent/prompts/<name>.md
//   Bot-level:    ~/.imtoagent/bots/<botId>/prompts/<name>.md
// No sync to backend directories — prompts are injected via system prompt.
// ================================================================

import * as fs from 'fs';
import * as path from 'path';
import { getDataDir } from './paths';

// ================================================================
// PromptsManager class
// ================================================================

export class PromptsManager {
  private prompts_dir: string;

  /**
   * @param botId - If provided, prompts are stored at bot-level.
   *                If omitted, prompts are stored at system-level.
   */
  constructor(botId?: string) {
    const base = getDataDir();
    if (botId) {
      this.prompts_dir = path.join(base, 'bots', botId, 'prompts');
    } else {
      this.prompts_dir = path.join(base, 'prompts');
    }
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
}
