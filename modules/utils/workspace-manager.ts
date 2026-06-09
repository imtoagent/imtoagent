// ================================================================
// WorkspaceManager — 工作空间管理
// ================================================================
// 职责：
//   1. 根据模式（sandbox/global）解析每个 Bot 的工作空间路径
//   2. 确保工作空间目录存在（含 soul/ 子目录）
//   3. 路径边界检查（沙盒模式下防止路径穿越）
// ================================================================

import * as fs from 'fs';
import * as path from 'path';
import { getDataDir } from './paths';

// ================================================================
// 类型定义
// ================================================================

export type WorkspaceMode = 'sandbox' | 'global';

export interface WorkspaceConfig {
  mode: WorkspaceMode;
  globalPath: string | null;
  botOverrides: Record<string, string>;
}

/**
 * 从 config.json 中提取 workspace 配置。
 * 老用户无 workspace 配置时，默认 sandbox 模式。
 */
export function parseWorkspaceConfig(raw: unknown): WorkspaceConfig {
  const ws = raw?.workspace || {};
  const mode: WorkspaceMode = ws.mode === 'global' ? 'global' : 'sandbox';
  const globalPath: string | null = ws.globalPath || null;
  const botOverrides: Record<string, string> = {};

  if (ws.botOverrides && typeof ws.botOverrides === 'object') {
    for (const [k, v] of Object.entries(ws.botOverrides)) {
      if (typeof v === 'string') botOverrides[k] = v;
    }
  }

  return { mode, globalPath, botOverrides };
}

// ================================================================
// WorkspaceManager
// ================================================================

export class WorkspaceManager {
  private config: WorkspaceConfig;
  private workspacesDir: string;

  constructor(config: WorkspaceConfig) {
    this.config = config;
    this.workspacesDir = path.join(getDataDir(), 'workspaces');
  }

  /**
   * 解析 Bot 的工作空间路径。
   *
   * 规则：
   *   - 沙盒模式：~/.imtoagent/workspaces/<UUID>/（UUID 保证唯一，可被 botOverrides 覆盖）
   *   - 全局模式：直接使用 <globalPath>/（所有 Bot 共享同一入口）
   */
  getWorkspacePath(botKey: string): string {
    // 优先级：botOverrides > 模式默认路径
    const override = this.config.botOverrides[botKey];
    if (override) return path.resolve(override);

    // 全局模式：所有 Bot 共享 globalPath，不加 botKey
    if (this.config.mode === 'global' && this.config.globalPath) {
      return path.resolve(this.config.globalPath);
    }

    // 沙盒模式：每个 Bot 独立目录（UUID 保证唯一性，无需日期后缀）
    const botId = this._getBotId(botKey);
    return path.resolve(this.workspacesDir, botId);
  }

  /**
   * 生成或获取 Bot 的 UUID。
   * 首次调用时创建 UUID 并持久化到数据目录。
   */
  private _getBotId(botKey: string): string {
    const botIdsFile = path.join(getDataDir(), 'bot-ids.json');
    let botIds: Record<string, string> = {};

    try {
      if (fs.existsSync(botIdsFile)) {
        botIds = JSON.parse(fs.readFileSync(botIdsFile, 'utf8'));
      }
    } catch {
      // 文件损坏或不可读，重新开始
    }

    if (!botIds[botKey]) {
      // 生成 UUID v4
      botIds[botKey] = crypto.randomUUID();
      try {
        fs.writeFileSync(botIdsFile, JSON.stringify(botIds, null, 2));
      } catch (e) {
        console.error(`[Workspace] Failed to persist bot ID for ${botKey}: ${e}`);
      }
    }

    return botIds[botKey];
  }

  /**
   * 确保工作空间目录存在，并初始化 soul/ 子目录。
   *
   * 沙盒模式：创建 <workspace>/soul/
   * 全局模式：创建 <globalPath>/.imtoagent/soul/<botId>/（按 Bot 隔离）
   */
  ensureWorkspace(botKey: string): void {
    const wsPath = this.getWorkspacePath(botKey);
    const soulPath = this.getSoulPath(botKey);

    try {
      if (!fs.existsSync(wsPath)) {
        fs.mkdirSync(wsPath, { recursive: true });
      }
      if (!fs.existsSync(soulPath)) {
        fs.mkdirSync(soulPath, { recursive: true });
      }
    } catch (e: unknown) {
      console.error(`[Workspace] Failed to ensure workspace for ${botKey}: ${e.message}`);
      throw e;
    }
  }

  /**
   * 获取 soul 目录路径。
   * 沙盒模式：<workspacePath>/soul/
   * 全局模式：<globalPath>/.imtoagent/soul/<botId>/
   */
  getSoulPath(botKey: string): string {
    if (this.config.mode === 'global' && this.config.globalPath) {
      return path.resolve(this.config.globalPath, '.imtoagent', 'soul', botKey);
    }
    // 沙盒模式
    return path.join(this.getWorkspacePath(botKey), 'soul');
  }

  /**
   * 检查路径是否允许该 Bot 访问。
   *
   * 所有模式：禁止访问 ~/.imtoagent/ 下的配置敏感文件（配置保护）。
   * 沙盒模式：路径必须在 Bot 的工作空间范围内（或子目录）。
   * 全局模式：不做其他限制，允许访问任意路径（信任用户配置的全局目录）。
   *
   * 返回 true 表示允许，false 表示拒绝。
   */
  isPathAllowed(botKey: string, targetPath: string): boolean {
    const resolved = path.resolve(targetPath);

    // ⛔ 配置保护：禁止访问 ~/.imtoagent/ 下的敏感配置文件
    // 白名单：允许访问 workspaces/ 和 soul/ 目录
    const dataDir = path.resolve(getDataDir());
    if (resolved === dataDir || resolved.startsWith(dataDir + path.sep)) {
      const wsDir = path.resolve(this.workspacesDir);
      const soulGlob = path.resolve(dataDir, 'soul');
      // 允许：workspaces/ 下的内容、全局模式下的 soul/
      if (resolved === wsDir || resolved.startsWith(wsDir + path.sep)) {
        // OK — workspace 路径在工作空间范围内（沙盒模式下还需额外检查）
      } else if (this.config.mode === 'global' &&
                 (resolved === soulGlob || resolved.startsWith(soulGlob + path.sep))) {
        // OK — 全局模式下的 soul 目录
      } else {
        // 其他 ~/.imtoagent/ 路径一律禁止（config.json、bots/ 等）
        return false;
      }
    }

    // 全局模式：配置保护已通过，不做其他边界限制
    if (this.config.mode === 'global') {
      return true;
    }

    // 沙盒模式：路径必须在工作空间内
    const wsPath = this.getWorkspacePath(botKey);
    const resolvedWs = path.resolve(wsPath);

    if (resolved === resolvedWs || resolved.startsWith(resolvedWs + path.sep)) {
      return true;
    }

    return false;
  }

  /**
   * 获取工作空间模式。
   */
  getMode(): WorkspaceMode {
    return this.config.mode;
  }

  /**
   * 规范化路径（解析 '..'、'.' 等），用于 /dir 命令。
   * 如果规范化后的路径超出边界，返回 null。
   */
  resolveAndValidatePath(botKey: string, inputPath: string, currentCwd: string): string | null {
    // 先相对于当前 cwd 解析
    const resolved = path.resolve(currentCwd, inputPath);
    if (this.isPathAllowed(botKey, resolved)) {
      return resolved;
    }
    return null;
  }

  /**
   * 获取工作空间配置摘要（用于状态展示）。
   */
  getConfigSummary(): string {
    if (this.config.mode === 'sandbox') {
      return `sandbox (default: ${this.workspacesDir}/<UUID>/)`;
    }
    return `global (${path.resolve(this.config.globalPath || '.')})`;
  }
}

// ================================================================
// 便捷函数：从原始配置创建 WorkspaceManager
// ================================================================

export function createWorkspaceManager(rawConfig: unknown): WorkspaceManager {
  const config = parseWorkspaceConfig(rawConfig);
  return new WorkspaceManager(config);
}
