// ================================================================
// Workspace Migration — 老用户平滑迁移
// ================================================================
// 职责：
//   1. 检测旧目录结构（sessions/ + soul/）
//   2. 迁移到新 workspace 结构
//   3. 保留旧目录作为 .backup（不删除，安全优先）
//   4. 标记迁移完成，避免重复执行
// ================================================================

import * as fs from 'fs';
import * as path from 'path';
import { getDataDir } from './paths';

const MIGRATION_MARKER = '.workspace-migrated';

interface MigrationResult {
  migrated: boolean;
  botsMigrated: string[];
  errors: string[];
}

// ================================================================
// 公共入口
// ================================================================

/**
 * 检测并执行 workspace 迁移。
 *
 * 启动时调用一次。如果已经迁移过，直接返回。
 * 返回迁移结果摘要，可用于日志输出。
 */
export function migrateWorkspaces(): MigrationResult {
  const dataDir = getDataDir();
  const markerPath = path.join(dataDir, MIGRATION_MARKER);

  // 已经迁移过，跳过
  if (fs.existsSync(markerPath)) {
    return { migrated: false, botsMigrated: [], errors: [] };
  }

  const result: MigrationResult = { migrated: true, botsMigrated: [], errors: [] };

  // 加载 bot-ids.json（UUID 映射）
  const botIds = loadBotIds(dataDir);

  // 旧目录
  const oldSessionsDir = path.join(dataDir, 'sessions');
  const oldSoulDir = path.join(dataDir, 'soul');

  // 发现需要迁移的 Bot（从旧 sessions 目录扫描）
  const botKeys = discoverBotKeys(oldSessionsDir, oldSoulDir);
  if (botKeys.length === 0) {
    // 没有旧数据，直接标记
    markMigrated(markerPath);
    return result;
  }

  console.error(`[Migration] Found ${botKeys.length} bot(s) to migrate: ${botKeys.join(', ')}`);

  for (const botKey of botKeys) {
    try {
      const botUuid = ensureBotUuid(botKey, botIds, dataDir);
      migrateBotData(botKey, botUuid, dataDir, oldSessionsDir, oldSoulDir);
      result.botsMigrated.push(botKey);
    } catch (e: unknown) {
      const msg = `[${botKey}] ${e.message}`;
      result.errors.push(msg);
      console.error(`[Migration] ERROR: ${msg}`);
    }
  }

  // 迁移完成后创建标记
  markMigrated(markerPath);

  // 打印摘要
  if (result.botsMigrated.length > 0) {
    console.error(`[Migration] ✅ ${result.botsMigrated.length} bot(s) migrated successfully`);
  }
  if (result.errors.length > 0) {
    console.error(`[Migration] ⚠️ ${result.errors.length} error(s): ${result.errors.join('; ')}`);
  }

  return result;
}

// ================================================================
// 内部函数
// ================================================================

/** 加载 bot-ids.json */
function loadBotIds(dataDir: string): Record<string, string> {
  const botIdsFile = path.join(dataDir, 'bot-ids.json');
  try {
    if (fs.existsSync(botIdsFile)) {
      return JSON.parse(fs.readFileSync(botIdsFile, 'utf8'));
    }
  } catch {
    // 文件损坏，重新开始
  }
  return {};
}

/** 确保 Bot 有 UUID */
function ensureBotUuid(
  botKey: string,
  botIds: Record<string, string>,
  dataDir: string,
): string {
  if (botIds[botKey]) return botIds[botKey];

  const uuid = crypto.randomUUID();
  botIds[botKey] = uuid;

  try {
    fs.writeFileSync(path.join(dataDir, 'bot-ids.json'), JSON.stringify(botIds, null, 2));
  } catch {
    // 写入失败不影响迁移流程
  }

  return uuid;
}

/** 发现需要迁移的 Bot keys */
function discoverBotKeys(sessionsDir: string, soulDir: string): string[] {
  const botKeys = new Set<string>();

  // 从 sessions 目录扫描
  if (fs.existsSync(sessionsDir)) {
    try {
      for (const entry of fs.readdirSync(sessionsDir)) {
        if (entry.startsWith('.')) continue; // 跳过 .restore 等隐藏文件
        const entryPath = path.join(sessionsDir, entry);
        if (fs.statSync(entryPath).isDirectory()) {
          botKeys.add(entry);
        }
      }
    } catch {
      // 忽略读取失败
    }
  }

  // 从 soul 目录扫描（补充）
  if (fs.existsSync(soulDir)) {
    try {
      for (const entry of fs.readdirSync(soulDir)) {
        if (entry.startsWith('.')) continue;
        const entryPath = path.join(soulDir, entry);
        if (fs.statSync(entryPath).isDirectory()) {
          botKeys.add(entry);
        }
      }
    } catch {
      // 忽略读取失败
    }
  }

  return Array.from(botKeys);
}

/** 迁移单个 Bot 的数据 */
function migrateBotData(
  botKey: string,
  botUuid: string,
  dataDir: string,
  oldSessionsDir: string,
  oldSoulDir: string,
): void {
  const workspacesDir = path.join(dataDir, 'workspaces');
  const newWorkspacePath = path.join(workspacesDir, botUuid);
  const newSessionsPath = path.join(newWorkspacePath, 'sessions');
  const newSoulPath = path.join(newWorkspacePath, 'soul');

  console.error(`[Migration] Migrating [${botKey}] → workspace/${botUuid}/`);

  // 确保新目录存在
  fs.mkdirSync(newSessionsPath, { recursive: true });
  fs.mkdirSync(newSoulPath, { recursive: true });

  // 1. 迁移 session 文件
  const oldBotSessionsDir = path.join(oldSessionsDir, botKey);
  if (fs.existsSync(oldBotSessionsDir)) {
    const sessionFiles = fs.readdirSync(oldBotSessionsDir).filter((f) => f.endsWith('.memory.json'));
    for (const file of sessionFiles) {
      const src = path.join(oldBotSessionsDir, file);
      const dst = path.join(newSessionsPath, file);
      if (!fs.existsSync(dst)) {
        fs.copyFileSync(src, dst);
        console.error(`[Migration]   session: ${file}`);
      }
    }
  }

  // 2. 迁移 soul 文件
  const oldBotSoulDir = path.join(oldSoulDir, botKey);
  if (fs.existsSync(oldBotSoulDir)) {
    const soulFiles = fs.readdirSync(oldBotSoulDir);
    for (const file of soulFiles) {
      const src = path.join(oldBotSoulDir, file);
      const dst = path.join(newSoulPath, file);
      if (!fs.existsSync(dst) && fs.statSync(src).isFile()) {
        fs.copyFileSync(src, dst);
        console.error(`[Migration]   soul: ${file}`);
      }
    }
  }

  // 3. 迁移 .restore 文件到数据目录根（全局 marker）
  const oldRestore = path.join(oldSessionsDir, '.restore');
  if (fs.existsSync(oldRestore)) {
    const newRestore = path.join(dataDir, '.restore');
    if (!fs.existsSync(newRestore)) {
      fs.copyFileSync(oldRestore, newRestore);
    }
  }
}

/** 标记迁移已完成 */
function markMigrated(markerPath: string): void {
  const marker = {
    version: 1,
    migratedAt: new Date().toISOString(),
    note: 'Workspace migration completed. Old sessions/ and soul/ directories preserved as backup.',
  };
  try {
    fs.writeFileSync(markerPath, JSON.stringify(marker, null, 2));
  } catch {
    console.error('[Migration] Failed to write migration marker');
  }
}
