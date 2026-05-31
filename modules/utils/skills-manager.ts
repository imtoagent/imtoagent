// ================================================================
// Skills Manager — Install, remove, and sync skills across backends
// ================================================================
// Storage: ~/.imtoagent/skills/<name>/ (skill files)
// Metadata: ~/.imtoagent/skills.json
// Sync targets: backend-specific skill directories
// ================================================================

import * as fs from 'fs';
import * as path from 'path';
import { getDataDir } from './paths';
import { execSync } from 'child_process';

// ================================================================
// Types
// ================================================================

export interface SkillMeta {
  name: string;
  source: string; // GitHub URL, local path, or ZIP path
  installedAt: string; // ISO timestamp
  backends: string[]; // claude, codex, opencode
}

export interface SkillsData {
  skills: Record<string, SkillMeta>;
}

// ================================================================
// SkillsManager class
// ================================================================

export class SkillsManager {
  private skillsDir: string;
  private metaPath: string;
  private data: SkillsData;

  constructor(dataDir?: string) {
    const base = dataDir || getDataDir();
    this.skills_dir = path.join(base, 'skills');
    this.metaPath = path.join(base, 'skills.json');
    this.data = this.load();
    fs.mkdirSync(this.skills_dir, { recursive: true });
  }

  private load(): SkillsData {
    if (!fs.existsSync(this.metaPath)) {
      return { skills: {} };
    }
    try {
      return JSON.parse(fs.readFileSync(this.metaPath, 'utf-8'));
    } catch {
      return { skills: {} };
    }
  }

  private save(): void {
    fs.writeFileSync(this.metaPath, JSON.stringify(this.data, null, 2));
  }

  // ================================================================
  // List
  // ================================================================

  list(backend?: string): { name: string; meta: SkillMeta }[] {
    const entries = Object.entries(this.data.skills);
    if (!backend) {
      return entries.map(([name, meta]) => ({ name, meta }));
    }
    return entries
      .filter(([, meta]) => meta.backends.includes(backend))
      .map(([name, meta]) => ({ name, meta }));
  }

  // ================================================================
  // Install
  // ================================================================

  install(source: string, options: { name?: string; backends?: string[] } = {}): { name: string; path: string } {
    let skillName = options.name || '';
    let skillPath = '';

    // Determine source type and extract/copy
    if (source.startsWith('http://') || source.startsWith('https://')) {
      // GitHub URL — clone
      const result = this.installFromGitHub(source);
      skillName = result.name;
      skillPath = result.path;
    } else if (source.endsWith('.zip')) {
      // ZIP file — extract
      const result = this.installFromZip(source);
      skillName = result.name;
      skillPath = result.path;
    } else if (fs.existsSync(source)) {
      // Local directory — copy
      const result = this.installFromLocal(source);
      skillName = result.name;
      skillPath = result.path;
    } else {
      throw new Error(`Source not found: ${source}`);
    }

    // Save metadata
    this.data.skills[skillName] = {
      name: skillName,
      source,
      installedAt: new Date().toISOString(),
      backends: options.backends || ['claude', 'codex', 'opencode'],
    };
    this.save();

    return { name: skillName, path: skillPath };
  }

  private installFromGitHub(url: string): { name: string; path: string } {
    // Extract repo name from URL
    const match = url.match(/github\.com\/[^/]+\/([^/]+)/);
    if (!match) throw new Error(`Invalid GitHub URL: ${url}`);

    let name = match[1].replace(/[-_](skill|skills|agent)$/, '');
    // Sanitize name
    name = name.toLowerCase().replace(/[^a-z0-9-]/g, '-');

    const destDir = path.join(this.skills_dir, name);
    if (fs.existsSync(destDir)) {
      throw new Error(`Skill "${name}" already installed. Remove it first.`);
    }

    // Clone repo
    execSync(`git clone --depth 1 ${url} ${destDir}`, { stdio: 'pipe' });

    // Remove .git to save space
    try { fs.rmSync(path.join(destDir, '.git'), { recursive: true, force: true }); } catch {}

    return { name, path: destDir };
  }

  private installFromZip(zipPath: string): { name: string; path: string } {
    if (!fs.existsSync(zipPath)) {
      throw new Error(`ZIP file not found: ${zipPath}`);
    }

    const name = path.basename(zipPath, '.zip').toLowerCase().replace(/[^a-z0-9-]/g, '-');
    const destDir = path.join(this.skills_dir, name);

    if (fs.existsSync(destDir)) {
      throw new Error(`Skill "${name}" already installed. Remove it first.`);
    }

    // Extract using unzip
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
    const destDir = path.join(this.skills_dir, name);

    if (fs.existsSync(destDir)) {
      throw new Error(`Skill "${name}" already installed. Remove it first.`);
    }

    // Copy directory
    this.copyDirSync(localPath, destDir);

    return { name, path: destDir };
  }

  // ================================================================
  // Remove
  // ================================================================

  remove(name: string): boolean {
    if (!this.data.skills[name]) return false;

    const skillDir = path.join(this.skills_dir, name);
    if (fs.existsSync(skillDir)) {
      fs.rmSync(skillDir, { recursive: true, force: true });
    }

    delete this.data.skills[name];
    this.save();
    return true;
  }

  // ================================================================
  // Sync to backends
  // ================================================================

  sync(backend?: string): { synced: string[]; errors: string[] } {
    const result = { synced: [] as string[], errors: [] as string[] };
    const backends = backend ? [backend] : ['claude', 'codex', 'opencode'];

    for (const b of backends) {
      try {
        const skills = this.list(b);
        const targetDir = this.getBackendSkillDir(b);

        if (!targetDir) {
          result.errors.push(`${b}: backend not configured, skipping`);
          continue;
        }

        fs.mkdirSync(targetDir, { recursive: true });

        // Clear existing skills for this backend
        if (fs.existsSync(targetDir)) {
          for (const entry of fs.readdirSync(targetDir)) {
            fs.rmSync(path.join(targetDir, entry), { recursive: true, force: true });
          }
        }

        // Copy skills
        for (const { name, meta } of skills) {
          const srcDir = path.join(this.skills_dir, name);
          if (fs.existsSync(srcDir)) {
            this.copyDirSync(srcDir, path.join(targetDir, name));
          }
        }

        result.synced.push(b);
      } catch (err: unknown) {
        result.errors.push(`${b}: ${err.message}`);
      }
    }

    return result;
  }

  private getBackendSkillDir(backend: string): string | null {
    const home = process.env.HOME || '';
    switch (backend) {
      case 'claude':
        return path.join(home, '.claude', 'skills');
      case 'codex':
        return path.join(home, '.codex', 'skills');
      case 'opencode':
        // OpenCode skills are managed via config, not directory
        return null;
      default:
        return null;
    }
  }

  // ================================================================
  // Helpers
  // ================================================================

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
