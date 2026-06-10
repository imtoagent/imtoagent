// ================================================================
// Skills Manager — Install and manage skills
// ================================================================
// Storage:
//   System-level: ~/.imtoagent/skills/<name>/SKILL.md
//   Bot-level:    ~/.imtoagent/bots/<botId>/skills/<name>/SKILL.md
//   Built-in:     <npm-package>/skills/<name>/SKILL.md (fallback)
// No metadata file — skills are discovered by scanning directories.
// No sync to backend directories — skills are injected via system prompt.
// ================================================================

import * as fs from 'fs';
import * as path from 'path';
import { getDataDir } from './paths';
import { execSync } from 'child_process';

// ================================================================
// Types
// ================================================================

export interface SkillInfo {
  name: string;
  description: string;
  level: 'system' | 'bot';
  path: string;
}

// ================================================================
// SkillsManager class
// ================================================================

export class SkillsManager {
  private skillsDir: string;
  private level: 'system' | 'bot';
  private builtInSkillsDir: string | null = null;

  /**
   * @param botId - If provided, skills are stored at bot-level.
   *                If omitted, skills are stored at system-level.
   */
  constructor(botId?: string) {
    const base = getDataDir();
    if (botId) {
      this.level = 'bot';
      this.skillsDir = path.join(base, 'bots', botId, 'skills');
    } else {
      this.level = 'system';
      this.skillsDir = path.join(base, 'skills');
    }
    fs.mkdirSync(this.skillsDir, { recursive: true });

    // Built-in skills: <npm-package>/skills/
    try {
      const packageDir = path.resolve(__dirname, '..', '..');
      const candidate = path.join(packageDir, 'skills');
      if (fs.existsSync(candidate)) {
        this.builtInSkillsDir = candidate;
      }
    } catch {}
  }

  // ================================================================
  // List — scan runtime directory + built-in fallback
  // ================================================================
  // 运行时目录优先（用户安装的覆盖内置同名 skill），
  // 内置目录作为 fallback（新安装时自动可用）。
  // ================================================================

  list(): SkillInfo[] {
    const builtIn = this.scanDir(this.builtInSkillsDir, 'system');
    const runtime = this.scanDir(this.skillsDir, this.level);

    // 运行时覆盖内置（同名以 runtime 为准）
    const runtimeNames = new Set(runtime.map(s => s.name));
    return [...runtime, ...builtIn.filter(s => !runtimeNames.has(s.name))];
  }

  private scanDir(dir: string | null, level: 'system' | 'bot'): SkillInfo[] {
    if (!dir || !fs.existsSync(dir)) return [];

    const entries = fs.readdirSync(dir);
    const result: SkillInfo[] = [];

    for (const entry of entries) {
      if (entry.startsWith('_')) continue;
      const skillDir = path.join(dir, entry);
      if (!fs.statSync(skillDir).isDirectory()) continue;

      const skillMdPath = path.join(skillDir, 'SKILL.md');
      if (!fs.existsSync(skillMdPath)) continue;

      const description = this.extractDescription(skillMdPath);
      result.push({
        name: entry,
        description,
        level,
        path: skillDir,
      });
    }

    return result;
  }

  // ================================================================
  // Install
  // ================================================================

  install(source: string, options: { name?: string } = {}): { name: string; path: string } {
    let skillName = options.name || '';
    let skillPath = '';

    if (source.startsWith('http://') || source.startsWith('https://')) {
      const result = this.installFromGitHub(source);
      skillName = result.name;
      skillPath = result.path;
    } else if (source.endsWith('.zip')) {
      const result = this.installFromZip(source);
      skillName = result.name;
      skillPath = result.path;
    } else if (fs.existsSync(source)) {
      const result = this.installFromLocal(source);
      skillName = result.name;
      skillPath = result.path;
    } else {
      throw new Error(`Source not found: ${source}`);
    }

    return { name: skillName, path: skillPath };
  }

  private installFromGitHub(url: string): { name: string; path: string } {
    const match = url.match(/github\.com\/[^/]+\/([^/]+)/);
    if (!match) throw new Error(`Invalid GitHub URL: ${url}`);

    let name = match[1].replace(/[-_](skill|skills|agent)$/, '');
    name = name.toLowerCase().replace(/[^a-z0-9-]/g, '-');

    const destDir = path.join(this.skillsDir, name);
    if (fs.existsSync(destDir)) {
      throw new Error(`Skill "${name}" already installed. Remove it first.`);
    }

    execSync(`git clone --depth 1 ${url} ${destDir}`, { stdio: 'pipe' });

    try { fs.rmSync(path.join(destDir, '.git'), { recursive: true, force: true }); } catch {}

    return { name, path: destDir };
  }

  private installFromZip(zipPath: string): { name: string; path: string } {
    if (!fs.existsSync(zipPath)) {
      throw new Error(`ZIP file not found: ${zipPath}`);
    }

    const name = path.basename(zipPath, '.zip').toLowerCase().replace(/[^a-z0-9-]/g, '-');
    const destDir = path.join(this.skillsDir, name);

    if (fs.existsSync(destDir)) {
      throw new Error(`Skill "${name}" already installed. Remove it first.`);
    }

    fs.mkdirSync(destDir, { recursive: true });
    execSync(`unzip -o "${zipPath}" -d "${destDir}"`, { stdio: 'pipe' });

    // If ZIP extracts to a subdirectory, move contents up
    const entries = fs.readdirSync(destDir);
    if (entries.length === 1 && fs.statSync(path.join(destDir, entries[0])).isDirectory()) {
      const innerDir = path.join(destDir, entries[0]);
      for (const item of fs.readdirSync(innerDir)) {
        fs.renameSync(path.join(innerDir, item), path.join(destDir, item));
      }
      fs.rmdirSync(innerDir);
    }

    return { name, path: destDir };
  }

  private installFromLocal(localPath: string): { name: string; path: string } {
    if (!fs.statSync(localPath).isDirectory()) {
      throw new Error(`Local source is not a directory: ${localPath}`);
    }

    const name = path.basename(localPath).toLowerCase().replace(/[^a-z0-9-]/g, '-');
    const destDir = path.join(this.skillsDir, name);

    if (fs.existsSync(destDir)) {
      throw new Error(`Skill "${name}" already installed. Remove it first.`);
    }

    this.copyDirSync(localPath, destDir);

    return { name, path: destDir };
  }

  // ================================================================
  // Remove
  // ================================================================

  remove(name: string): boolean {
    const skillDir = path.join(this.skillsDir, name);
    if (!fs.existsSync(skillDir)) return false;

    fs.rmSync(skillDir, { recursive: true, force: true });
    return true;
  }

  // ================================================================
  // Get skill description (from YAML frontmatter)
  // ================================================================

  getSkillDescription(name: string): string | null {
    const skillMdPath = path.join(this.skillsDir, name, 'SKILL.md');
    if (!fs.existsSync(skillMdPath)) return null;
    return this.extractDescription(skillMdPath);
  }

  // ================================================================
  // Get full skill content
  // ================================================================

  getSkillContent(name: string): string | null {
    const skillMdPath = path.join(this.skillsDir, name, 'SKILL.md');
    if (!fs.existsSync(skillMdPath)) return null;
    return fs.readFileSync(skillMdPath, 'utf-8');
  }

  // ================================================================
  // Helpers
  // ================================================================

  private extractDescription(skillMdPath: string): string {
    try {
      const content = fs.readFileSync(skillMdPath, 'utf-8');
      // Extract YAML frontmatter description
      const match = content.match(/^---\s*\n([\s\S]*?)\n---/);
      if (match) {
        const frontmatter = match[1];
        const descMatch = frontmatter.match(/^description:\s*(.+)$/m);
        if (descMatch) {
          return descMatch[1].trim().replace(/^["']|["']$/g, '');
        }
      }
    } catch {
      // Ignore parse errors
    }
    return '';
  }

  private copyDirSync(src: string, dst: string): void {
    if (!fs.existsSync(dst)) fs.mkdirSync(dst, { recursive: true });
    for (const entry of fs.readdirSync(src)) {
      const srcPath = path.join(src, entry);
      const dstPath = path.join(dst, entry);
      if (fs.statSync(srcPath).isDirectory()) {
        this.copyDirSync(srcPath, dstPath);
      } else {
        fs.copyFileSync(srcPath, dstPath);
      }
    }
  }
}
