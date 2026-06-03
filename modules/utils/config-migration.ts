// ================================================================
// Config Migration — 配置结构平滑升级
// ================================================================
// 职责：
//   1. 检测 config.json 版本（通过 `_meta.version` 或内容推断）
//   2. 按版本号逐步执行迁移脚本
//   3. 迁移前备份原文件（安全优先）
//   4. 迁移后写入版本标记
// ================================================================
// 使用方式：
//   - 启动时调用一次：migrateConfig()
//   - 需要变更结构时：在 MIGRATIONS 数组末尾追加新条目
//   - 每条迁移都是幂等的，可安全重试
// ================================================================

import * as fs from 'fs';
import * as path from 'path';
import { getDataDir, getConfigPath } from './paths';

/** config.json 顶层元数据 */
interface ConfigMeta {
  version: number;
  migratedAt?: string;
  lastVersion?: number;
}

interface RawConfig {
  _meta?: ConfigMeta;
  [key: string]: unknown;
}

interface MigrationStep {
  fromVersion: number;
  toVersion: number;
  description: string;
  migrate: (config: RawConfig) => RawConfig;
}

// ================================================================
// 迁移定义
// ================================================================
// 规则：
//   - fromVersion 必须是上一个版本号
//   - 第一条迁移的 fromVersion 应为 0（无版本标记 = 版本 0）
//   - 每条迁移只做一件事，方便回滚和调试
// ================================================================

const CURRENT_VERSION = 2;

const MIGRATIONS: MigrationStep[] = [
  // ─── v0 → v1: 添加 _meta 版本标记 + bots[].im 字段规范化 ───
  // 适用：0.4.5 之前的老用户，config.json 没有 _meta 字段
  {
    fromVersion: 0,
    toVersion: 1,
    description: 'Add config version marker + normalize bot IM/backend fields',
    migrate: (config: RawConfig): RawConfig => {
      const c = { ...config };

      // 确保 bots 数组存在
      if (!c.bots) {
        c.bots = [];
      }

      // 规范化 bots[].im 字段（如果之前不存在，设为空字符串）
      if (Array.isArray(c.bots)) {
        c.bots = (c.bots as unknown[]).map((bot: unknown) => {
          const b = bot as Record<string, unknown>;
          return {
            ...b,
            im: b.im || '',
            isAdmin: b.isAdmin || false,
          };
        });
      }

      // 添加 system 默认值
      if (!c.system) {
        c.system = {};
      }

      return c;
    },
  },

  // ─── v1 → v2: 添加 providers 结构迁移 ───
  // 适用：未来 providers 结构变化时的迁移
  {
    fromVersion: 1,
    toVersion: 2,
    description: 'Migrate providers structure (if needed)',
    migrate: (config: RawConfig): RawConfig => {
      // 当前版本无需变更，占位用
      // 未来 providers 结构变化时在这里添加逻辑
      return config;
    },
  },

  // ─── 添加新迁移示例 ───
  // {
  //   fromVersion: 2,
  //   toVersion: 3,
  //   description: 'Rename bots[].appId to bots[].clientId',
  //   migrate: (config) => {
  //     const c = { ...config };
  //     if (Array.isArray(c.bots)) {
  //       c.bots = (c.bots as any[]).map(b => ({
  //         ...b,
  //         clientId: b.appId,
  //       }));
  //       delete (c.bots as any)[0]?.appId; // 逐个清理
  //     }
  //     return c;
  //   },
  // },
];

// ================================================================
// 核心逻辑
// ================================================================

/**
 * 获取当前配置版本。
 * 无 _meta.version = 版本 0（老用户首次升级）。
 */
function detectVersion(config: RawConfig): number {
  return config._meta?.version ?? 0;
}

/**
 * 主入口：检测并执行配置迁移。
 * 应在应用启动时调用一次（早于 config 加载）。
 * 返回迁移摘要，可用于日志输出。
 */
export function migrateConfig(): {
  migrated: boolean;
  fromVersion: number;
  toVersion: number;
  steps: string[];
  backupPath?: string;
  error?: string;
} {
  const configPath = getConfigPath();

  // config 不存在 → 无需迁移
  if (!fs.existsSync(configPath)) {
    return { migrated: false, fromVersion: 0, toVersion: CURRENT_VERSION, steps: [] };
  }

  let config: RawConfig;
  try {
    const raw = fs.readFileSync(configPath, 'utf-8');
    config = JSON.parse(raw);
  } catch (e: unknown) {
    return {
      migrated: false,
      fromVersion: 0,
      toVersion: CURRENT_VERSION,
      steps: [],
      error: `Failed to parse config.json: ${e.message}`,
    };
  }

  const fromVersion = detectVersion(config);

  // 已是最新版本 → 跳过
  if (fromVersion >= CURRENT_VERSION) {
    return { migrated: false, fromVersion, toVersion: CURRENT_VERSION, steps: [] };
  }

  // 需要迁移 → 先备份
  const backupPath = backupConfig(configPath);

  const steps: string[] = [];
  let currentConfig = config;
  let currentVersion = fromVersion;

  // 逐步执行迁移
  for (const migration of MIGRATIONS) {
    if (currentVersion < migration.fromVersion) continue;
    if (currentVersion >= migration.toVersion) continue;

    try {
      currentConfig = migration.migrate(currentConfig);
      currentConfig._meta = {
        ...((currentConfig._meta as ConfigMeta) || {}),
        version: migration.toVersion,
        migratedAt: new Date().toISOString(),
        lastVersion: migration.fromVersion,
      };
      currentVersion = migration.toVersion;
      steps.push(`v${migration.fromVersion} → v${migration.toVersion}: ${migration.description}`);
    } catch (e: unknown) {
      // 迁移失败 → 恢复备份并报错
      restoreBackup(configPath, backupPath);
      return {
        migrated: false,
        fromVersion,
        toVersion: currentVersion,
        steps,
        backupPath,
        error: `Migration failed at v${migration.fromVersion}→v${migration.toVersion}: ${e.message}`,
      };
    }
  }

  // 写入迁移后的配置
  try {
    fs.writeFileSync(configPath, JSON.stringify(currentConfig, null, 2) + '\n');
  } catch (e: unknown) {
    restoreBackup(configPath, backupPath);
    return {
      migrated: false,
      fromVersion,
      toVersion: currentVersion,
      steps,
      backupPath,
      error: `Failed to write migrated config: ${e.message}`,
    };
  }

  return { migrated: true, fromVersion, toVersion: CURRENT_VERSION, steps, backupPath };
}

// ================================================================
// 备份/恢复
// ================================================================

/** 备份当前配置文件，返回备份路径 */
function backupConfig(configPath: string): string {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = `${configPath}.backup.${timestamp}`;
  try {
    fs.copyFileSync(configPath, backupPath);
    console.error(`[ConfigMigration] Backup created: ${backupPath}`);
  } catch {
    // 备份失败不阻塞迁移，但记录日志
    console.error(`[ConfigMigration] Failed to create backup`);
  }
  return backupPath;
}

/** 从备份恢复配置文件 */
function restoreBackup(configPath: string, backupPath: string): void {
  if (!backupPath || !fs.existsSync(backupPath)) return;
  try {
    fs.copyFileSync(backupPath, configPath);
    console.error(`[ConfigMigration] Config restored from backup`);
  } catch (e) {
    console.error(`[ConfigMigration] CRITICAL: Failed to restore backup: ${e.message}`);
  }
}
