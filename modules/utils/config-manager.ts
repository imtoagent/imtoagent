// ================================================================
// config-manager.ts — 配置管理 CRUD
// ================================================================
// imtoagent config list       — 列出所有 Bot
// imtoagent config show NAME  — 显示某个 Bot 的完整配置
// imtoagent config add        — 交互式添加 Bot
// imtoagent config remove NAME — 删除 Bot
// imtoagent config modify NAME — 修改 Bot 配置
// ================================================================

import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';
import { getDataDir, getConfigPath } from './paths';
import crypto from 'crypto';

// ================================================================
// 类型
// ================================================================

const VALID_BACKENDS = ['claude', 'codex', 'opencode'] as const;
const VALID_IMS = ['feishu', 'telegram', 'wecom', 'wechat'] as const;

export type BackendType = typeof VALID_BACKENDS[number];
export type IMType = typeof VALID_IMS[number];

export interface BotEntry {
  id?: string;
  name: string;
  im: string;
  appId: string;
  appSecret: string;
  backend: string;
  cwd?: string;
}

interface RawConfig {
  system?: Record<string, unknown>;
  providers?: Record<string, unknown>;
  defaultModel?: string;
  activeModel?: string;
  modelAliases?: Record<string, string>;
  bots?: BotEntry[];
  execServer?: Record<string, unknown>;
  codex?: Record<string, unknown>;
  opencode?: Record<string, unknown>;
  rateLimit?: Record<string, unknown>;
  shutdown?: Record<string, unknown>;
  [key: string]: unknown;
}

// ================================================================
// 加载/保存
// ================================================================

function loadConfig(): { config: RawConfig; configPath: string } {
  const configPath = getConfigPath();
  if (!fs.existsSync(configPath)) {
    throw new Error(`config.json not found at ${configPath} — run "imtoagent setup" first`);
  }
  const raw = fs.readFileSync(configPath, 'utf-8');
  const config = JSON.parse(raw) as RawConfig;
  return { config, configPath };
}

function saveConfig(config: RawConfig, configPath: string): void {
  const tmpPath = configPath + '.tmp';
  try {
    fs.writeFileSync(tmpPath, JSON.stringify(config, null, 2) + '\n');
    fs.renameSync(tmpPath, configPath);
  } catch (e) {
    // Clean up tmp on failure
    try { fs.unlinkSync(tmpPath); } catch {}
    throw e;
  }
}

// ================================================================
// 交互式 prompt（复用 setup 的风格）
// ================================================================

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

function prompt(question: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(question, (answer) => resolve(answer.trim()));
  });
}

async function confirm(question: string): Promise<boolean> {
  const answer = await prompt(`${question} [y/N] `);
  return answer.toLowerCase() === 'y' || answer.toLowerCase() === 'yes';
}

// ================================================================
// config list
// ================================================================

export async function cmdConfigList(): Promise<void> {
  const { config } = loadConfig();
  const bots = config.bots || [];

  if (bots.length === 0) {
    console.log('   No Bots configured. Run "imtoagent config add" to add one.');
    return;
  }

  console.log(`\n📋 Configured Bots (${bots.length}):\n`);
  for (const bot of bots) {
    const botId = bot.id ? ` [${bot.id.slice(0, 8)}]` : '';
    const adminTag = bot.isAdmin ? ' ⭐' : '';
    const cwd = bot.cwd ? ` (cwd: ${bot.cwd})` : '';
    console.log(`   • ${bot.name}${adminTag}${botId}`);
    console.log(`     IM: ${bot.im || "(not set)"} | Backend: ${bot.backend}${cwd}`);
  }
  console.log();
}

// ================================================================
// config show NAME
// ================================================================

export async function cmdConfigShow(name: string): Promise<void> {
  const { config } = loadConfig();
  const bots = config.bots || [];
  const bot = bots.find(b => b.name === name);

  if (!bot) {
    console.error(`❌ Bot "${name}" not found`);
    process.exit(1);
  }

  console.log(`\n📋 Bot: ${bot.name}\n`);
  console.log(`   ID:        ${bot.id || '(auto-generated)'}`);
  console.log(`   IM:        ${bot.im || "(not set)"}`);
  console.log(`   Backend:   ${bot.backend}`);
  console.log(`   App ID:    ${maskSecret(bot.appId)}`);
  console.log(`   App Secret: ${maskSecret(bot.appSecret)}`);
  console.log(`   Admin:     ${bot.isAdmin ? '✅ Yes' : '❌ No'}`);
  if (bot.cwd) console.log(`   CWD:       ${bot.cwd}`);
  console.log();
}

/** @internal — exported for testing via __TEST_MASK_SECRET */
function maskSecret(s: string): string {
  if (s.length <= 8) return '***';
  return s.slice(0, 4) + '...' + s.slice(-4);
}

// ================================================================
// config add
// ================================================================

export async function cmdConfigAdd(): Promise<void> {
  console.log('\n➕ Add a new Bot\n');

  // 1. Bot name
  let name: string;
  while (true) {
    name = await prompt('Bot name (e.g. MyAssistantBot): ');
    if (!name) { console.log('   ⚠️  Name is required'); continue; }
    if (!/^[a-zA-Z0-9_-]+$/.test(name)) { console.log('   ⚠️  Name can only contain letters, numbers, hyphens, underscores'); continue; }

    const { config } = loadConfig();
    if (config.bots?.find(b => b.name === name)) {
      console.log(`   ⚠️  Bot "${name}" already exists`);
      continue;
    }
    break;
  }

  // 2. IM platform
  console.log('\n   IM platforms:');
  console.log('   1. feishu     (飞书/Lark)');
  console.log('   2. telegram   (Telegram)');
  console.log('   3. wecom      (企业微信)');
  console.log('   4. wechat     (个人微信)');
  let im: string;
  while (true) {
    im = await prompt('\n   IM platform (1-4 or name): ');
    const numMap: Record<string, string> = { '1': 'feishu', '2': 'telegram', '3': 'wecom', '4': 'wechat' };
    im = numMap[im] || im.toLowerCase();
    if (VALID_IMS.includes(im as IMType)) break;
    console.log('   ⚠️  Valid options: feishu, telegram, wecom, wechat');
  }

  // 3. IM credentials
  let appId = await prompt(`\n   App ID (飞书 App ID / Telegram Bot Token / etc): `);
  if (!appId) { console.log('   ⚠️  App ID is required'); process.exit(1); }

  let appSecret = await prompt(`   App Secret (飞书 App Secret / leave blank for Telegram): `);

  // 4. Backend
  console.log('\n   Backends:');
  console.log('   1. claude   (Claude Code)');
  console.log('   2. codex    (OpenAI Codex)');
  console.log('   3. opencode (OpenCode)');
  let backend: string;
  while (true) {
    backend = await prompt('\n   Backend (1-3 or name): ');
    const numMap: Record<string, string> = { '1': 'claude', '2': 'codex', '3': 'opencode' };
    backend = numMap[backend] || backend.toLowerCase();
    if (VALID_BACKENDS.includes(backend as BackendType)) break;
    console.log('   ⚠️  Valid options: claude, codex, opencode');
  }

  // 5. Working directory (optional)
  const cwd = await prompt('\n   Working directory (leave blank for default): ');

  // Summary
  console.log('\n── Summary ──');
  console.log(`   Name:      ${name}`);
  console.log(`   IM:        ${im}`);
  console.log(`   App ID:    ${maskSecret(appId)}`);
  console.log(`   App Secret: ${appSecret ? maskSecret(appSecret) : '(not set)'}`);
  console.log(`   Backend:   ${backend}`);
  if (cwd) console.log(`   CWD:       ${cwd}`);
  console.log();

  const ok = await confirm('Create this Bot?');
  if (!ok) { console.log('   Cancelled.'); rl.close(); return; }

  // Apply
  const { config, configPath } = loadConfig();
  if (!config.bots) config.bots = [];

  const newBot: BotEntry = {
    id: crypto.randomUUID(),
    name,
    im,
    appId,
    appSecret: appSecret || '',
    backend,
    isAdmin: false,  // 通过 CLI 添加的 Bot 默认非 admin
    ...(cwd ? { cwd } : {}),
  };

  config.bots.push(newBot);
  saveConfig(config, configPath);

  console.log(`\n✅ Bot "${name}" created!`);
  console.log(`   Run "imtoagent restore" to hot-reload the gateway.\n`);
  rl.close();
}

// ================================================================
// config remove NAME
// ================================================================

export async function cmdConfigRemove(name: string): Promise<void> {
  const { config, configPath } = loadConfig();
  const bots = config.bots || [];
  const idx = bots.findIndex(b => b.name === name);

  if (idx === -1) {
    console.error(`❌ Bot "${name}" not found`);
    process.exit(1);
  }

  const bot = bots[idx];
  console.log(`\n🗑️  Remove Bot: ${name}`);
  console.log(`   IM: ${bot.im || "(not set)"} | Backend: ${bot.backend}\n`);

  const ok = await confirm('Are you sure? This cannot be undone');
  if (!ok) { console.log('   Cancelled.'); rl.close(); return; }

  config.bots = bots.filter((_, i) => i !== idx);
  saveConfig(config, configPath);

  console.log(`\n✅ Bot "${name}" removed`);
  console.log(`   Run "imtoagent restore" to hot-reload the gateway.\n`);
  rl.close();
}

// ================================================================
// config modify NAME
// ================================================================

export async function cmdConfigModify(name: string): Promise<void> {
  const { config, configPath } = loadConfig();
  const bot = config.bots?.find(b => b.name === name);

  if (!bot) {
    console.error(`❌ Bot "${name}" not found`);
    process.exit(1);
  }

  console.log(`\n✏️  Modify Bot: ${name}\n`);
  console.log(`   Current settings:`);
  console.log(`   IM:        ${bot.im || "(not set)"}`);
  console.log(`   App ID:    ${maskSecret(bot.appId)}`);
  console.log(`   App Secret: ${bot.appSecret ? maskSecret(bot.appSecret) : '(not set)'}`);
  console.log(`   Backend:   ${bot.backend}`);
  console.log(`   CWD:       ${bot.cwd || '(default)'}`);
  console.log();

  console.log('   What do you want to change?');
  console.log('   1. IM platform');
  console.log('   2. App ID');
  console.log('   3. App Secret');
  console.log('   4. Backend');
  console.log('   5. Working directory');
  console.log(`   6. Admin status (${bot.isAdmin ? 'ON' : 'OFF'})`);
  console.log('   7. Quit');

  const choice = await prompt('\n   Choice (1-7): ');

  switch (choice) {
    case '1': {
      console.log('\n   Valid: feishu, telegram, wecom, wechat');
      const newIm = await prompt(`   New IM platform (current: ${bot.im}): `);
      if (newIm && VALID_IMS.includes(newIm as IMType)) bot.im = newIm;
      break;
    }
    case '2': {
      const newAppId = await prompt(`   New App ID (current: ${maskSecret(bot.appId)}): `);
      if (newAppId) bot.appId = newAppId;
      break;
    }
    case '3': {
      const newSecret = await prompt(`   New App Secret: `);
      if (newSecret) bot.appSecret = newSecret;
      break;
    }
    case '4': {
      console.log('\n   Valid: claude, codex, opencode');
      const newBackend = await prompt(`   New backend (current: ${bot.backend}): `);
      if (newBackend && VALID_BACKENDS.includes(newBackend as BackendType)) bot.backend = newBackend;
      break;
    }
    case '5': {
      const newCwd = await prompt(`   New working directory (current: ${bot.cwd || 'default'}): `);
      if (newCwd) bot.cwd = newCwd;
      else if (newCwd === '') delete bot.cwd;
      break;
    }
    case '6': {
      const current = bot.isAdmin ? 'ON' : 'OFF';
      const newVal = await prompt(`   Toggle admin status (current: ${current}, yes/no): `);
      if (newVal && (newVal.toLowerCase() === 'yes' || newVal.toLowerCase() === 'y')) {
        bot.isAdmin = !bot.isAdmin;
        console.log(`   Admin status → ${bot.isAdmin ? 'ON' : 'OFF'}`);
      }
      break;
    }
    case '7':
      console.log('   No changes.');
      rl.close();
      return;
    default:
      console.log('   Invalid choice.');
      rl.close();
      return;
  }

  saveConfig(config, configPath);
  console.log(`\n✅ Bot "${name}" updated`);
  console.log(`   Run "imtoagent restore" to hot-reload the gateway.\n`);
  rl.close();
}

// ================================================================
// Test exports (NOT for production use)
// ================================================================

/**
 * Export maskSecret for testing only.
 */
export const __test_maskSecret = maskSecret;

/**
 * Export constants for validate command / testing.
 */
export { VALID_BACKENDS, VALID_IMS };
