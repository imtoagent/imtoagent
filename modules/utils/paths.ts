// ================================================================
// 路径解析模块 — 首次部署自动初始化的核心地基
// ================================================================
// 职责：
//   1. 统一解析数据目录（~/.imtoagent/ 或开发时的 cwd）
//   2. 统一解析 npm 包安装目录（读取模板用）
//   3. 兼容旧开发模式（bun run index.ts 在旧项目目录）
//   4. 首次部署自动初始化数据目录 + 配置文件
// ================================================================

import * as fs from 'fs';
import * as path from 'path';

// ===== 缓存 =====
let _dataDir: string | null = null;
let _pkgDir: string | null = null;

// ===== 数据目录解析 =====
/**
 * 返回 imtoagent 的用户数据目录（读写）。
 *
 * 优先级：
 *   1. IMTOAGENT_HOME 环境变量 → 如果有 config.json 则直接用
 *   2. ~/.imtoagent/ 存在且有 config.json → 用
 *   3. cwd 有 config.json → 开发模式（从 cwd 初始化 ~/.imtoagent）
 *   4. 从包目录模板初始化 ~/.imtoagent（npm 全局安装首次运行）
 *   5. 包目录 fallback（极端情况）
 *
 * 关键改进：IMTOAGENT_HOME 不再是"强制覆盖"——如果目录为空，
 * 会继续尝试从其他来源找到配置文件，并自动初始化。
 */
export function getDataDir(): string {
  if (_dataDir) return _dataDir;

  const home = process.env.HOME || process.env.USERPROFILE?.replace(/\\/g, '/') || '';
  const dotDir = path.join(home, '.imtoagent');
  const envHome = process.env.IMTOAGENT_HOME || '';

  // ====== 第 1 步：查找已有的配置文件 ======
  const candidates: { dir: string; label: string }[] = [];

  // IMTOAGENT_HOME（优先检查，但不强制；目录不存在则忽略）
  if (envHome && fs.existsSync(envHome) && fs.existsSync(path.join(envHome, 'config.json'))) {
    candidates.push({ dir: envHome, label: 'IMTOAGENT_HOME' });
  }

  // ~/.imtoagent/
  if (fs.existsSync(path.join(dotDir, 'config.json'))) {
    candidates.push({ dir: dotDir, label: '~/.imtoagent' });
  }

  // cwd（开发模式）
  const cwd = process.cwd();
  if (fs.existsSync(path.join(cwd, 'config.json'))) {
    candidates.push({ dir: cwd, label: 'cwd development mode' });
  }

  if (candidates.length > 0) {
    // 有现成配置，直接用最优先的那个
    const chosen = candidates[0];
    _dataDir = chosen.dir;
    console.error(`[Paths] Data directory: ${_dataDir} (${chosen.label})`);
    return _dataDir;
  }

  // ====== 第 2 步：没有配置文件 → 仅在 ~/.imtoagent 不存在时才初始化 ======
  // Bug fix: 如果目录已存在但无 config.json，绝不自动用模板覆盖。
  // 这可能是用户误删或手动维护的配置丢失，应该报错而非静默覆盖。
  if (!fs.existsSync(dotDir)) {
    _dataDir = initDataDir(dotDir, envHome);
    return _dataDir;
  }

  // 目录已存在但无 config.json — 报错退出，防止静默覆盖
  console.error(`[Paths] ⚠️  Data directory ${dotDir} exists but config.json is missing`);
  console.error(`[Paths] Please restore config.json or run 'imtoagent setup' to reconfigure`);
  process.exit(1);
}

/**
 * 首次部署：自动创建 ~/.imtoagent/ 并初始化配置文件。
 *
 * 配置文件来源（按优先级）：
 *   1. IMTOAGENT_HOME 下的 config.json（目录存在但没文件）
 *   2. cwd 下的 config.json / providers.json（手动部署/git clone）
 *   3. 包安装目录的 templates/（npm 全局安装）
 */
function initDataDir(dotDir: string, envHome: string): string {
  const target = dotDir; // 统一使用 ~/.imtoagent/

  // 确定配置文件来源
  let sourceDir: string | null = null;
  let sourceLabel = '';

  if (envHome && fs.existsSync(envHome) && fs.existsSync(path.join(envHome, 'config.json'))) {
    sourceDir = envHome;
    sourceLabel = 'IMTOAGENT_HOME';
  } else if (fs.existsSync(path.join(process.cwd(), 'config.json'))) {
    sourceDir = process.cwd();
    sourceLabel = 'cwd';
  } else {
    const pkgDir = getPkgDir();
    if (fs.existsSync(path.join(pkgDir, 'templates', 'config.template.json'))) {
      sourceDir = path.join(pkgDir, 'templates');
      sourceLabel = 'package template';
    }
  }

  // 创建目录结构
  fs.mkdirSync(target, { recursive: true });
  fs.mkdirSync(path.join(target, 'logs'), { recursive: true });
  fs.mkdirSync(path.join(target, 'sessions'), { recursive: true });

  if (sourceDir && sourceLabel === 'cwd') {
    // 开发模式：直接拷贝项目目录下的配置
    copyIfExists(sourceDir, target, 'config.json');
    copyIfExists(sourceDir, target, 'providers.json');
    copyIfExists(sourceDir, target, 'opencode.json');
  } else if (sourceDir && sourceLabel === 'package template') {
    // npm 安装：从模板拷贝（去掉 .template 后缀）
    copyTemplateIfExists(sourceDir, target, 'config.template.json', 'config.json');
    copyTemplateIfExists(sourceDir, target, 'providers.template.json', 'providers.json');
    copyTemplateIfExists(sourceDir, target, 'opencode.template.json', 'opencode.json');
    // 拷贝 soul 模板
    const soulSrc = path.join(sourceDir, 'soul.template');
    if (fs.existsSync(soulSrc)) {
      copyDirSync(soulSrc, path.join(target, 'soul'));
    }
  }

  console.error(`[Paths] ✨ First-time data directory initialized: ${target} (source: ${sourceLabel || 'default template'})`);
  console.error(`[Paths] Please edit ${path.join(target, 'config.json')} to configure your credentials`);

  return target;
}

function copyIfExists(src: string, dst: string, filename: string) {
  const srcPath = path.join(src, filename);
  const dstPath = path.join(dst, filename);
  if (fs.existsSync(srcPath) && !fs.existsSync(dstPath)) {
    fs.copyFileSync(srcPath, dstPath);
  }
}

function copyTemplateIfExists(src: string, dst: string, templateName: string, outName: string) {
  const srcPath = path.join(src, templateName);
  const dstPath = path.join(dst, outName);
  if (fs.existsSync(srcPath) && !fs.existsSync(dstPath)) {
    fs.copyFileSync(srcPath, dstPath);
  }
}

function copyDirSync(src: string, dst: string) {
  if (!fs.existsSync(dst)) fs.mkdirSync(dst, { recursive: true });
  for (const entry of fs.readdirSync(src)) {
    const srcPath = path.join(src, entry);
    const dstPath = path.join(dst, entry);
    if (fs.statSync(srcPath).isDirectory()) {
      copyDirSync(srcPath, dstPath);
    } else {
      fs.copyFileSync(srcPath, dstPath);
    }
  }
}

/**
 * 返回 npm 包安装目录（只读，模板读取用）。
 *
 * import.meta.dirname 在 Bun/Node ESM 中返回当前文件所在目录。
 * 对于全局安装的包，这就是 /usr/local/lib/node_modules/imtoagent/。
 */
export function getPkgDir(): string {
  if (_pkgDir) return _pkgDir;

  // import.meta.dirname 是当前文件（paths.ts）所在目录 → modules/utils/
  // 向上两级就是包根目录
  _pkgDir = path.resolve(import.meta.dirname, '../..');
  return _pkgDir;
}

// ===== 便捷路径函数 =====

export function getConfigPath(): string {
  return path.join(getDataDir(), 'config.json');
}

export function getProvidersPath(): string {
  return path.join(getDataDir(), 'providers.json');
}

export function getOpencodeConfigPath(): string {
  return path.join(getDataDir(), 'opencode.json');
}

export function getSessionsDir(): string {
  return path.join(getDataDir(), 'sessions');
}

export function getLogsDir(): string {
  return path.join(getDataDir(), 'logs');
}

/** 解析 Bot 唯一 key：优先用 id（UUID），后向兼容用 name */
export function getBotKey(bot: { id?: string; name: string }): string {
  return bot.id || bot.name;
}

export function getSoulDir(botKey: string): string {
  return path.join(getDataDir(), 'soul', botKey);
}

export function getRestoreMarkerPath(): string {
  return path.join(getDataDir(), '.restore');
}

export function getTemplatePath(relativePath: string): string {
  const tplPath = path.join(getPkgDir(), 'templates', relativePath);
  if (!fs.existsSync(tplPath)) console.warn(`⚠️  Template not found: ${tplPath}`);
  return tplPath;
}

export function getTemplateSoulPath(filename: string): string {
  const tplPath = path.join(getPkgDir(), 'templates', 'soul.template', filename);
  if (!fs.existsSync(tplPath)) console.warn(`⚠️  Soul template not found: ${tplPath}`);
  return tplPath;
}

// ===== 重置缓存（测试用） =====
export function resetPathCache(): void {
  _dataDir = null;
  _pkgDir = null;
}
