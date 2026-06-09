// ================================================================
// Config Migration — 从旧配置结构迁移到统一 config.json
// ================================================================
// 迁移逻辑（首次启动时执行一次）：
//   1. providers.json → 合并到 config.json.providers（若 providers.json 更新）
//   2. sessions/<name>_config.json → bots/<name>.json
//   3. 完成后重命名旧文件为 .migrated
// ================================================================

import * as fs from 'fs';
import * as path from 'path';
import { getDataDir, getConfigPath, getSessionsDir, getBotsDir, getBotConfigPath } from './paths';

const BOTS_DIR_NAME = 'bots';

/** 执行配置迁移（幂等，已迁移则跳过） */
export function migrateConfigs(): void {
  const dataDir = getDataDir();
  let migrated = false;

  // 1. providers.json → config.json
  if (migrateProviders(dataDir)) migrated = true;

  // 2. sessions/*_config.json → bots/*.json
  if (migrateBotConfigs(dataDir)) migrated = true;

  if (migrated) {
    console.log('[Config Migration] Configs migrated to unified structure');
  }
}

/**
 * 迁移 providers.json 到 config.json
 * - 如果 providers.json 存在且 config.json 也存在
 * - 将 providers.json 的 providers 合并到 config.json（优先 providers.json 的数据）
 * - 将 providers.json.activeModel 合并到 config.json.activeModel（如果 config.json 没有）
 * - 完成后重命名 providers.json 为 providers.json.migrated
 */
function migrateProviders(dataDir: string): boolean {
  const providersPath = path.join(dataDir, 'providers.json');
  const configPath = getConfigPath();

  if (!fs.existsSync(providersPath)) return false;
  if (!fs.existsSync(configPath)) return false;

  const migratedMarker = providersPath + '.migrated';
  if (fs.existsSync(migratedMarker)) return false;

  try {
    const providersRaw = fs.readFileSync(providersPath, 'utf-8');
    const configRaw = fs.readFileSync(configPath, 'utf-8');
    const providersJson = JSON.parse(providersRaw);
    const configJson = JSON.parse(configRaw);

    let changed = false;

    // 合并 providers（providers.json 优先）
    if (providersJson.providers) {
      configJson.providers = { ...configJson.providers, ...providersJson.providers };
      changed = true;
    }

    // 合并 activeModel（config.json 优先，保留用户选择）
    if (!configJson.activeModel && providersJson.activeModel) {
      configJson.activeModel = providersJson.activeModel;
      changed = true;
    }

    if (changed) {
      fs.writeFileSync(configPath, JSON.stringify(configJson, null, 2) + '\n');
      console.log('[Config Migration] providers.json merged into config.json');
    }

    // 重命名旧文件
    fs.renameSync(providersPath, migratedMarker);
    console.log('[Config Migration] providers.json → providers.json.migrated');
    return true;
  } catch (e: unknown) {
    console.error(`[Config Migration] Failed to migrate providers: ${(e as Error).message}`);
    return false;
  }
}

/**
 * 迁移 sessions/<name>_config.json → bots/<name>.json
 * - 扫描 sessions/ 目录下所有 *_config.json
 * - 拷贝到 bots/ 目录
 * - 完成后重命名旧文件为 *_config.json.migrated
 */
function migrateBotConfigs(dataDir: string): boolean {
  const sessionsDir = path.join(dataDir, 'sessions');
  const botsDir = path.join(dataDir, BOTS_DIR_NAME);

  if (!fs.existsSync(sessionsDir)) return false;

  let migrated = false;

  try {
    const files = fs.readdirSync(sessionsDir);
    const botConfigFiles = files.filter(f => f.endsWith('_config.json') && !f.endsWith('.migrated'));

    if (botConfigFiles.length === 0) return false;

    if (!fs.existsSync(botsDir)) {
      fs.mkdirSync(botsDir, { recursive: true });
    }

    for (const file of botConfigFiles) {
      const srcPath = path.join(sessionsDir, file);
      const botName = file.replace('_config.json', '');
      const dstPath = path.join(botsDir, `${botName}.json`);
      const migratedMarker = srcPath + '.migrated';

      // 目标已存在则跳过
      if (fs.existsSync(dstPath)) continue;
      if (fs.existsSync(migratedMarker)) continue;

      fs.copyFileSync(srcPath, dstPath);
      fs.renameSync(srcPath, migratedMarker);
      console.log(`[Config Migration] sessions/${file} → bots/${botName}.json`);
      migrated = true;
    }
  } catch (e: unknown) {
    console.error(`[Config Migration] Failed to migrate bot configs: ${(e as Error).message}`);
  }

  return migrated;
}

/**
 * 迁移 sessions/<name>/_bot.json → bots/<name>.json
 * - 扫描 sessions/ 下的所有子目录，查找 _bot.json
 * - 合并到 bots/<name>.json（目标已存在时，保留已有字段，新字段追加）
 * - 完成后重命名旧文件为 _bot.json.migrated
 */
export function migrateBotJsonConfigs(): void {
  const sessionsDir = getSessionsDir();
  const botsDir = getBotsDir();

  if (!fs.existsSync(sessionsDir)) return;

  let migrated = false;

  try {
    const dirs = fs.readdirSync(sessionsDir);

    for (const dirName of dirs) {
      const srcPath = path.join(sessionsDir, dirName, '_bot.json');
      if (!fs.existsSync(srcPath)) continue;

      const migratedMarker = srcPath + '.migrated';
      if (fs.existsSync(migratedMarker)) continue;

      if (!fs.existsSync(botsDir)) {
        fs.mkdirSync(botsDir, { recursive: true });
      }

      const dstPath = getBotConfigPath(dirName);
      const dstDir = path.dirname(dstPath);

      try {
        if (fs.existsSync(dstPath)) {
          // 目标已存在：合并（目标优先，保留已有字段）
          const existing = JSON.parse(fs.readFileSync(dstPath, 'utf-8'));
          const incoming = JSON.parse(fs.readFileSync(srcPath, 'utf-8'));
          const merged = { ...incoming, ...existing };
          if (!fs.existsSync(dstDir)) fs.mkdirSync(dstDir, { recursive: true });
          fs.writeFileSync(dstPath, JSON.stringify(merged, null, 2));
          console.log(`[Config Migration] sessions/${dirName}/_bot.json merged into bots/${dirName}/bot-config.json`);
        } else {
          if (!fs.existsSync(dstDir)) fs.mkdirSync(dstDir, { recursive: true });
          fs.copyFileSync(srcPath, dstPath);
          console.log(`[Config Migration] sessions/${dirName}/_bot.json → bots/${dirName}/bot-config.json`);
        }

        fs.renameSync(srcPath, migratedMarker);
        migrated = true;
      } catch (e: unknown) {
        console.error(`[Config Migration] Failed to migrate ${dirName}/_bot.json: ${(e as Error).message}`);
      }
    }
  } catch (e: unknown) {
    console.error(`[Config Migration] Failed to scan sessions dir: ${(e as Error).message}`);
  }

  if (migrated) {
    console.log('[Config Migration] Bot configs (_bot.json) migrated');
  }
}
