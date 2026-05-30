// ================================================================
// setup.ts — Interactive Setup Wizard (v2)
// ================================================================
// Interaction:
//   ↑↓ or Space — navigate options
//   Enter — confirm selection
//   ESC — go back
//
// Supported IM platforms: Feishu / Telegram / WeCom / WeChat
// ================================================================

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { getDataDir, getPkgDir, getTemplatePath, getSoulDir } from '../utils/paths';
import { randomUUID } from 'crypto';
import { checkAllBackends, formatBackendStatus } from '../utils/backend-check';

// ================================================================
// Keyboard input (raw mode)
// ================================================================

const KEY = {
  UP: '\x1b[A',
  DOWN: '\x1b[B',
  ENTER: '\r',
  SPACE: ' ',
  ESC: '\x1b',
  BACKSPACE: '\x7f',
};

/** Read a single keypress */
function readKey(): Promise<string> {
  return new Promise((resolve) => {
    const onData = (data: Buffer) => {
      process.stdin.removeListener('data', onData);
      const s = data.toString();
      if (s === '\x03') process.exit(130); // Ctrl+C
      resolve(s);
    };
    process.stdin.once('data', onData);
  });
}

// ================================================================
// Menu selection (↑↓/Space navigate, Enter confirm)
// ================================================================

async function selectMenu(title: string, options: string[]): Promise<number> {
  let idx = 0;

  function render() {
    // Clear previous output
    process.stdout.write('\x1B[0G'); // Return to line start
    options.forEach((opt, i) => {
      const prefix = i === idx ? '▸ ' : '  ';
      process.stdout.write(`\x1B[0G${prefix}${opt}\x1B[0K\n`);
    });
  }

  // Show title
  console.log(title);
  render();

  process.stdin.setRawMode(true);
  process.stdin.resume();

  try {
    while (true) {
      const key = await readKey();

      if (key === KEY.UP || key === KEY.DOWN || key === KEY.SPACE) {
        // Move cursor
        idx = (idx + (key === KEY.UP ? -1 : 1) + options.length) % options.length;
        // Redraw all options
        process.stdout.write(`\x1B[${options.length}A`); // Move up N lines
        render();
      } else if (key === KEY.ENTER) {
        break;
      } else if (key === KEY.ESC) {
        return -1; // ESC = go back
      }
    }
  } finally {
    process.stdin.setRawMode(false);
    process.stdin.pause();
  }

  console.log(`\x1B[0G▸ ${options[idx]} ✓\n`);
  return idx;
}

// ================================================================
// Text input (Enter confirm, ESC returns null)
// ================================================================

/**
 * Prompt the user for text input.
 * @returns The entered string, or `null` if user pressed ESC.
 */
async function promptText(label: string, defaultValue = ''): Promise<string | null> {
  const buf: string[] = [];
  const defaultHint = defaultValue ? ` [${defaultValue}]` : '';

  process.stdout.write(`${label}${defaultHint}: `);
  process.stdin.setRawMode(true);
  process.stdin.resume();

  try {
    while (true) {
      const key = await readKey();

      if (key === KEY.ENTER || key === '\n') {
        break;
      } else if (key === KEY.ESC) {
        process.stdout.write('\x1B[0K\n');
        return null;
      } else if (key === KEY.BACKSPACE) {
        if (buf.length > 0) {
          buf.pop();
          process.stdout.write('\x1B[1D \x1B[1D'); // Backspace delete
        }
      } else if (key === KEY.UP || key === KEY.DOWN) {
        // Ignore arrow keys
      } else if (key === KEY.SPACE) {
        buf.push(' ');
        process.stdout.write(' ');
      } else if (key.length >= 1 && !key.startsWith('\x1b')) {
        // Normal characters / pasted multi-char blocks (text without escape sequences)
        buf.push(key);
        process.stdout.write(key);
      }
    }
  } finally {
    process.stdin.setRawMode(false);
    process.stdin.pause();
  }

  process.stdout.write('\n');
  const result = buf.join('').trim();
  return result || defaultValue;
}

// ================================================================
// Confirmation (Y/N, Enter confirm, ESC returns -1)
// ================================================================

async function confirm(label: string, defaultYes = true): Promise<boolean | -1> {
  const hint = defaultYes ? '[Y/n]' : '[y/N]';
  process.stdout.write(`${label} ${hint}: `);
  process.stdin.setRawMode(true);
  process.stdin.resume();

  try {
    while (true) {
      const key = await readKey();
      if (key === KEY.ENTER) {
        process.stdout.write('\n');
        return defaultYes;
      } else if (key === KEY.ESC) {
        process.stdout.write('\x1B[0K\n');
        return -1;
      } else if (key.toLowerCase() === 'y') {
        process.stdout.write('Y\n');
        return true;
      } else if (key.toLowerCase() === 'n') {
        process.stdout.write('N\n');
        return false;
      }
    }
  } finally {
    process.stdin.setRawMode(false);
    process.stdin.pause();
  }
}

// ================================================================
// Provider presets
// ================================================================

interface ProviderPreset {
  name: string;
  baseUrl: string;
  format: 'openai' | 'anthropic';
  models: string[];
  hint?: string; // Additional note
}

const PROVIDER_PRESETS: ProviderPreset[] = [
  {
    name: 'DashScope (Alibaba Bailian)',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    format: 'openai',
    models: ['qwen3.7-max', 'qwen3.6-plus', 'qwen3.6-flash', 'qwen3.5-omni-plus'],
  },
  {
    name: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/v1',
    format: 'openai',
    models: ['deepseek-v4-pro', 'deepseek-v4-flash'],
  },
  {
    name: 'Zhipu AI (Zhipu)',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    format: 'openai',
    models: ['glm-5.1', 'glm-5', 'glm-5-turbo', 'glm-4.7', 'glm-4.7-flashx', 'glm-4.6', 'glm-4.5-air', 'glm-4.5-airx', 'glm-4-long'],
  },
  {
    name: 'MiniMax',
    baseUrl: 'https://api.minimaxi.com/v1',
    format: 'openai',
    models: ['MiniMax-M2.7', 'MiniMax-M2.5'],
  },
  {
    name: 'SiliconFlow',
    baseUrl: 'https://api.siliconflow.cn/v1',
    format: 'openai',
    models: ['Qwen/Qwen3-235B-A22B', 'deepseek-ai/DeepSeek-V4', 'Qwen/Qwen3-32B'],
  },
  {
    name: 'Moonshot (Moonshot AI)',
    baseUrl: 'https://api.moonshot.cn/v1',
    format: 'openai',
    models: ['kimi-k2.6', 'kimi-k2.5', 'kimi-k2-thinking', 'kimi-k2', 'moonshot-v1-8k', 'moonshot-v1-32k', 'moonshot-v1-128k'],
  },
  {
    name: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    format: 'openai',
    models: ['gpt-5', 'gpt-5-mini', 'o3', 'o4-mini'],
    hint: 'Proxy required to access',
  },
  {
    name: 'Anthropic',
    baseUrl: 'https://api.anthropic.com',
    format: 'anthropic',
    models: ['claude-sonnet-4-5-20251101', 'claude-opus-4-6-20260416', 'claude-haiku-4-20250514'],
    hint: 'Proxy required to access',
  },
  {
    name: 'Gemini (Google)',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    format: 'openai',
    models: ['gemini-3-pro', 'gemini-3-flash', 'gemini-2.5-pro'],
    hint: 'Proxy required to access',
  },
  {
    name: 'xAI (Grok)',
    baseUrl: 'https://api.x.ai/v1',
    format: 'openai',
    models: ['grok-4', 'grok-4-fast', 'grok-3'],
    hint: 'Requires proxy to access',
  },
  {
    name: 'Ollama (Local)',
    baseUrl: 'http://localhost:11434/v1',
    format: 'openai',
    models: ['qwen3', 'qwen2.5', 'llama3.3', 'deepseek-r1'],
  },
];

// ================================================================
// IM platform configuration
// ================================================================

const IM_PLATFORMS = [
  { value: 'feishu', label: 'Feishu', desc: 'WebSocket long-lived connection' },
  { value: 'telegram', label: 'Telegram', desc: 'Long polling' },
  { value: 'wecom', label: 'WeCom', desc: 'QR scan binding + WebSocket' },
  { value: 'wechat', label: 'WeChat', desc: 'iLink + QR scan' },
];

/** Credential fields required by each IM type */
const IM_FIELDS: Record<string, { key: string; label: string; required: boolean }[]> = {
  feishu: [
    { key: 'appId', label: 'Feishu App ID (cli_...)', required: true },
    { key: 'appSecret', label: 'Feishu App Secret', required: true },
  ],
  telegram: [
    { key: 'appId', label: 'Bot Token', required: true },
    { key: 'proxy', label: 'Proxy URL (leave blank to skip)', required: false },
  ],
  wecom: [
    // WeCom uses QR scan binding, no pre-filled credentials needed, QR scan triggered automatically on startup
  ],
  wechat: [
    // WeChat authenticates via iLink + QR scan, no pre-filled credentials needed
    { key: 'botId', label: 'iLink Bot ID (leave blank for QR scan)', required: false },
    { key: 'botToken', label: 'iLink Bot Token (leave blank for QR scan)', required: false },
  ],
};

// ================================================================
// Main flow
// ================================================================

export interface SetupOptions {
  quick?: boolean;
}

export async function runSetupWizard(options?: SetupOptions): Promise<void> {
  // Guard: refuse to run in non-TTY environment
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.error('');
    console.error('❌ Setup wizard requires an interactive terminal (TTY).');
    console.error('   If you installed via "curl | bash", run these commands manually:');
    console.error('');
    console.error('   imtoagent setup');
    console.error('');
    process.exit(1);
  }

  const dataDir = getDataDir();
  const configPath = path.join(dataDir, 'config.json');

  console.log('\n╔══════════════════════════════════════════════╗');
  console.log('║   🚀  imtoagent Setup Wizard                 ║');
  console.log('╚══════════════════════════════════════════════╝');
  console.log(`\nData directory: ${dataDir}`);
  console.log(`Controls: ↑↓/Space navigate  |  Enter confirm  |  ESC go back\n`);

  const isQuick = options?.quick || false;
  if (isQuick) {
    console.log('⚡ Quick mode: workspace defaults to sandbox, skip workspace step\n');
  }

  // ===== Step 1: Detect existing configuration =====
  let existingConfig: any = null;
  let mergeMode = false;

  if (fs.existsSync(configPath)) {
    console.log('📋 Existing configuration detected\n');
    const idx = await selectMenu('Choose action', ['Overwrite existing config', 'Merge (keep existing Bots)', 'Exit']);
    if (idx === -1) return; // ESC
    if (idx === 2) { console.log('👋 Cancelled'); process.exit(0); }
    if (idx === 1) mergeMode = true;

    try {
      existingConfig = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    } catch {
      console.log('⚠️  Failed to parse existing config, will regenerate');
      existingConfig = null;
      mergeMode = false;
    }
  }

  // ===== Step 2: Detect backends =====
  console.log('\n📌 Detecting backend agents...\n');
  const backendStatus = checkAllBackends();
  console.log(formatBackendStatus(backendStatus));

  const installedBackends = backendStatus.filter(b => b.installed);
  if (installedBackends.length === 0) {
    console.log('\n⚠️  No backend agents detected.');
    console.log('Recommended installs:');
    console.log('  npm install -g @anthropic-ai/claude-agent-sdk   # Claude Code');
    console.log('  npm install -g @openai/codex                    # Codex');
    console.log('  npm install -g opencode                         # OpenCode');
    const r = await confirm('Continue configuring? (Messaging will fail until backends are installed)', false);
    if (r === false || r === -1) { console.log('\n👋 Run "imtoagent setup" again after installing backends'); process.exit(0); }
    console.log('\n⚠️  Skipped, you can install backends later.\n');
  } else {
    console.log(`\n✅ Installed: ${installedBackends.map(b => b.label).join(', ')}\n`);
  }

  // ===== Step 3: Configure Bots =====
  console.log('📌 Step 3: Configure Bots\n');

  const bots: any[] = (mergeMode && existingConfig?.bots) ? [...existingConfig.bots] : [];

  let addingBots = true;
  while (addingBots) {
    console.log(`\n--- Add New Bot (${bots.length} existing) ---\n`);

    // 3a: Select IM platform
    const imLabels = IM_PLATFORMS.map(p => `${p.label}  ${p.desc}`);
    const imIdx = await selectMenu('Select IM platform', imLabels);
    if (imIdx === -1) { if (bots.length === 0) return; break; } // ESC
    const imType = IM_PLATFORMS[imIdx].value;

    // 3b: Auto-generate Bot name, customizable
    const defaultName = IM_PLATFORMS[imIdx].label + 'Bot';
    const nameInput = await promptText('Bot name', defaultName);
    if (nameInput === null) { if (bots.length === 0) return; break; } // ESC
    const botName = nameInput || defaultName;

    // Validate Bot name — no whitespace-only, no dangerous characters
    if (!botName || !/^\S/.test(botName)) {
      console.log('⚠️  Bot name must not be empty or whitespace-only. Using default.');
    }
    // Sanitize: remove characters that would break directory names
    const sanitized = botName.replace(/[^\w\s.-]/g, '');
    if (sanitized !== botName) {
      console.log(`⚠️  Bot name sanitized: "${botName}" → "${sanitized}"`);
    }

    // 3c: Select backend
    const backendLabels = backendStatus.map(b =>
      b.installed ? `${b.label} (v${b.version})` : `${b.label} ⚠️  Not installed`
    );
    const backendIdx = await selectMenu('Select backend', backendLabels);
    if (backendIdx === -1) continue; // ESC go back to IM selection
    const backend = backendStatus[backendIdx].type;
    const isBackendInstalled = backendStatus[backendIdx].installed;

    // Backend not installed → prompt for auto-install
    if (!isBackendInstalled) {
      const installCmd = backendStatus[backendIdx].installHint || '';
      console.log(`\n⚠️  ${backend} not installed`);
      console.log(`   ${installCmd}\n`);
      const r = await confirm('Auto-install now?');
      if (r === true) {
        const { installBackend } = await import('../utils/backend-check');
        const ok = await installBackend(backend as 'claude' | 'codex' | 'opencode');
        if (ok) {
          console.log(`✅ ${backend} installed\n`);
        } else {
          console.log(`⚠️  Installation failed, run manually later: ${installCmd}\n`);
          const r2 = await confirm('Continue configuring this Bot anyway?');
          if (r2 === false) continue;
        }
      } else if (r === -1) {
        continue; // ESC go back
      } else {
        console.log('Skipping installation\n');
      }
    }

    // 3d: Collect credentials based on IM type
    console.log(`\n--- ${IM_PLATFORMS.find(p => p.value === imType)?.label} credentials ---`);
    const fields = IM_FIELDS[imType] || [];
    const credentials: Record<string, string> = {};

    for (const field of fields) {
      const val = await promptText(field.label + (field.required ? '' : ' (optional)'));
      if (val === null) { credentials._escaped = 'true'; break; } // ESC
      credentials[field.key] = val;
    }
    if (credentials._escaped) continue; // ESC go back and re-select backend

    // 3e: Working directory (validated)
    let cwd = await promptText('Working directory', os.homedir());
    if (cwd === null) continue;
    cwd = cwd.trim() || os.homedir();

    // Validate path — reject obviously invalid / dangerous paths
    const badPaths = ['/dev/null', '/dev/zero', '/dev/random', '/etc/passwd', '/etc/shadow', '/System'];
    if (badPaths.some(bp => cwd === bp || cwd.startsWith(bp + '/'))) {
      console.log(`⚠️  Invalid path "${cwd}". Using home directory instead.`);
      cwd = os.homedir();
    }
    // Resolve to absolute path
    cwd = path.resolve(cwd);

    // Generate unique ID (UUID, for directory isolation, renaming doesn't affect it)
    const botId = randomUUID();

    // Build Bot configuration (different IM types need different fields)
    const bot: any = {
      id: botId,
      name: botName,
      backend,
      cwd: cwd || os.homedir(),
    };

    // Feishu needs appId + appSecret
    if (imType === 'feishu') {
      bot.appId = credentials.appId || '';
      bot.appSecret = credentials.appSecret || '';
    }
    // Telegram needs appId (Bot Token), optional proxy
    else if (imType === 'telegram') {
      bot.appId = credentials.appId || '';
      if (credentials.proxy) bot.proxy = credentials.proxy;
    }
    // WeCom: QR scan binding, no pre-filled credentials (optional botId/secret)
    else if (imType === 'wecom') {
      bot.im = 'wecom';
      if (credentials.botId) bot.botId = credentials.botId;
      if (credentials.secret) bot.secret = credentials.secret;
    }
    // WeChat: optional botId/botToken, QR scan if left blank
    else if (imType === 'wechat') {
      bot.im = 'wechat';
      if (credentials.botId) bot.botId = credentials.botId;
      if (credentials.botToken) bot.botToken = credentials.botToken;
      if (credentials.ilinkUserId) bot.ilinkUserId = credentials.ilinkUserId;
    }
    // Default: non-Feishu platforms add im field
    else {
      bot.im = imType;
    }

    // Check for duplicate name — auto-rename with counter
    let finalName = botName;
    let counter = 1;
    while (bots.find(b => b.name === finalName)) {
      finalName = `${botName} (${counter})`;
      counter++;
    }
    bot.name = finalName;

    if (finalName !== botName) {
      console.log(`⚠️  "${botName}" already exists, renamed to "${finalName}"`);
    }
    bots.push(bot);
    console.log(`✅ Added: ${finalName}`);

    // Whether to continue adding
    const r = await confirm('Add another Bot?', true);
    if (r === -1) addingBots = false; // ESC = done adding, proceed to next step
    else addingBots = (r === true);
  }

  if (bots.length === 0) {
    console.log('\n⚠️  No Bots configured.');
    const r = await confirm('Configure at least one Bot?');
    if (r === true) return runSetupWizard();
    console.log('\n⚠️  At least one Bot required, configuration cancelled');
    return;
  }

  // ===== Step 4: Configure workspace =====
  let workspaceMode: 'sandbox' | 'global' = 'sandbox';
  let workspaceGlobalPath: string | null = null;

  if (!isQuick) {
    console.log('\n📌 Step 4: Configure workspace\n');
    console.log('Each Bot gets its own isolated file workspace:');
    console.log('  sandbox  — isolated per Bot, no cross-Bot file access (recommended)');
    console.log('  global   — shared root directory, multiple Bots collaborate on same codebase');
    console.log('');

    const wsLabels = ['Sandbox mode (isolated per Bot)', 'Global mode (shared root path)'];
    const wsIdx = await selectMenu('Select workspace mode', wsLabels);
      if (wsIdx === -1) { console.log('\n👋 Cancelled'); process.exit(0); }
    workspaceMode = wsIdx === 1 ? 'global' : 'sandbox';

    if (workspaceMode === 'global') {
      const defaultGlobal = os.homedir() + '/imtoagent-workspace';
      const gpInput = await promptText('Global workspace root path', defaultGlobal);
      if (gpInput === null) { console.log('\n👋 Cancelled'); process.exit(0); }
      let resolved = (gpInput || defaultGlobal).trim();

      // Validate path
      const badPaths = ['/dev/null', '/dev/zero', '/dev/random', '/etc', '/System', '/usr'];
      if (badPaths.some(bp => resolved === bp || resolved.startsWith(bp + '/'))) {
        console.log(`⚠️  Invalid path "${resolved}". Using default instead.`);
        resolved = defaultGlobal;
      }
      workspaceGlobalPath = path.resolve(resolved);
    }

    const home = process.env.HOME || process.env.USERPROFILE?.replace(/\\/g, '/') || '';
    console.log('');
    console.log('Workspace layout:');
    if (workspaceMode === 'sandbox') {
      console.log(`  ${home}/.imtoagent/workspaces/<UUID>/  (each Bot gets a unique directory)`);
    } else {
      console.log(`  ${workspaceGlobalPath}/  (all Bots share this root)`);
      console.log(`  soul files in ${workspaceGlobalPath}/.imtoagent/soul/<botId>/`);
    }
    console.log('');
  }

  // ===== Step 5: Configure model providers =====
  console.log('\n📌 Step 5: Configure model providers\n');

  const providers: Record<string, any> = {};
  if (mergeMode && existingConfig?.providers) {
    Object.assign(providers, existingConfig.providers);
    console.log(`✅ Kept ${Object.keys(providers).length} existing provider(s)\n`);
  }

  // Step 4 outer loop: ensure at least one provider (exit when user explicitly skips)
  let step4Loop = true;
  while (step4Loop) {
    let addingProviders = true;
    while (addingProviders) {
    console.log('--- Add new provider ---\n');

    // Choose preset or custom
    const presetOptions = PROVIDER_PRESETS.map(p => {
      const tag = p.hint ? ` ${p.hint}` : '';
      return `${p.name}${tag}`;
    });
    presetOptions.push('Custom...');

    const presetIdx = await selectMenu('Select provider', presetOptions);
    if (presetIdx === -1) { addingProviders = false; continue; }

    let provName: string, baseUrl: string, format: 'openai' | 'anthropic', models: string[];

    if (presetIdx < PROVIDER_PRESETS.length) {
      // Use preset
      const preset = PROVIDER_PRESETS[presetIdx];
      provName = preset.name.split('(')[0].trim().toLowerCase(); // Take short name
      baseUrl = preset.baseUrl;
      format = preset.format;
      models = [...preset.models];

      console.log(`\n✅ Preset loaded:`);
      console.log(`   Name: ${provName}`);
      console.log(`   URL:  ${preset.baseUrl}`);
      console.log(`   Format: ${preset.format}`);
      console.log(`   Models: ${preset.models.join(', ')}\n`);

      // Confirm/edit short name (validate — must be safe JSON key)
      const nameEdit = await promptText('Provider name (leave blank to confirm)', provName);
      if (nameEdit === null) continue;
      provName = nameEdit || provName;
      // Sanitize provider name: only alphanumeric, hyphens, underscores
      const sanitizedProv = provName.replace(/[^a-zA-Z0-9_-]/g, '');
      if (!sanitizedProv) {
        console.log('⚠️  Invalid provider name. Using original.');
      } else if (sanitizedProv !== provName) {
        console.log(`⚠️  Provider name sanitized: "${provName}" → "${sanitizedProv}"`);
        provName = sanitizedProv;
      }

      // Confirm/edit Base URL
      const urlEdit = await promptText('Base URL', baseUrl);
      if (urlEdit === null) continue;
      baseUrl = urlEdit || baseUrl;

      // Confirm/edit model list
      const modelsEdit = await promptText('Model list (comma-separated)', models.join(', '));
      if (modelsEdit === null) continue;
      if (modelsEdit) models = modelsEdit.split(',').map(s => s.trim()).filter(Boolean);

      if (providers[provName]) {
        console.log(`⚠️  Provider "${provName}" already exists, will overwrite\n`);
      }
    } else {
      // Custom
      let customName = await promptText('Provider name (e.g. deepseek, dashscope)');
      if (customName === null) { addingProviders = false; continue; }
      provName = customName.trim().toLowerCase().replace(/[^a-zA-Z0-9_-]/g, '');
      if (!provName) { addingProviders = false; continue; }
      if (providers[provName]) {
        console.log(`⚠️  Provider "${provName}" already exists, will overwrite\n`);
      }

      baseUrl = await promptText('Base URL (e.g. https://api.deepseek.com/v1)');
      if (baseUrl === null) continue;
      const modelsStr = await promptText('Model list (comma-separated)');
      if (modelsStr === null) continue;
      models = (modelsStr || '').split(',').map(s => s.trim()).filter(Boolean);

      const formatIdx = await selectMenu('API format', ['openai', 'anthropic']);
      if (formatIdx === -1) continue;
      format = ['openai', 'anthropic'][formatIdx];
    }

    // API Key (required for all providers)
    const apiKey = await promptText('API Key');
    if (apiKey === null) continue;
    if (!apiKey) {
      console.log('⚠️  API Key is empty, this provider will be temporarily unavailable\n');
    }

    // Pricing (optional)
    const priceInput = await promptText('Pricing (in/out per million tokens, e.g. 0.55,2.19, leave blank to skip)');
    if (priceInput === null) continue;

    const pricing: any = {};
    if (priceInput) {
      const parts = priceInput.split(',').map(s => parseFloat(s.trim()));
      if (parts.length === 2 && !isNaN(parts[0]) && !isNaN(parts[1])) {
        pricing.inputPerMillion = parts[0];
        pricing.outputPerMillion = parts[1];
        pricing.currency = 'USD';
      }
    }

    providers[provName] = { baseUrl, apiKey, models, format, ...(Object.keys(pricing).length ? { pricing } : {}) };
    console.log(`✅ Added: ${provName}\n`);

    const r = await confirm('Continue adding providers?', false);
    if (r === -1) addingProviders = false;
    else addingProviders = (r === true);
  }

  if (Object.keys(providers).length === 0) {
    console.log('\n⚠️  No providers configured.');
    const r = await confirm('Configure at least one provider?');
    if (r === true) continue; // Re-enter step4Loop
    if (r === -1) { console.log('\n⚠️  Skipped, you can configure this later.\n'); }
  }
  step4Loop = false; // Has providers or user explicitly skipped
}

  // ===== Step 6: Select default model =====
  console.log('\n📌 Step 6: Select default model\n');

  const allModels: string[] = [];
  for (const [provName, prov] of Object.entries(providers)) {
    for (const m of (prov as any).models || []) {
      allModels.push(`${provName}/${m}`);
    }
  }

  let defaultModel = '';
  if (allModels.length > 0) {
    const existingDefault = existingConfig?.defaultModel || allModels[0];
    const val = await promptText('Default model', existingDefault);
    defaultModel = val === null ? existingDefault : (val || existingDefault);
  } else {
    const val = await promptText('Default model (provider/model)');
    defaultModel = val === null ? 'deepseek/deepseek-v4-pro' : (val || 'deepseek/deepseek-v4-pro');
  }

  // ===== Step 7: Generate soul files =====
  console.log('\n📌 Step 7: Generate soul files\n');

  // Compute workspace soul dirs based on configured workspace mode
  const home = process.env.HOME || process.env.USERPROFILE?.replace(/\\/g, '/') || '';

  for (const bot of bots) {
    let botSoulDir: string;

    if (workspaceMode === 'sandbox') {
      // Sandbox: soul in workspaces/<UUID>/soul/
      botSoulDir = path.join(home, '.imtoagent', 'workspaces', bot.id, 'soul');
    } else {
      // Global: soul in <globalPath>/.imtoagent/soul/<botId>/
      botSoulDir = path.join(workspaceGlobalPath || path.join(home, 'imtoagent-workspace'), '.imtoagent', 'soul', bot.id);
    }

    const templateSoulDir = path.join(getPkgDir(), 'templates', 'soul.template');

    if (fs.existsSync(botSoulDir)) {
      const r = await confirm(`Soul files for ${bot.name} already exist, regenerate?`, false);
      if (r === -1 || r === false) {
        console.log(`⏭  Skipped: ${bot.name}`);
        continue;
      }
    }

    fs.mkdirSync(botSoulDir, { recursive: true });

    const soulFiles = ['rules.md', 'identity.md', 'profile.md', 'workspace.md', 'skills.md'];
    for (const sf of soulFiles) {
      const tmplPath = path.join(templateSoulDir, sf);
      const destPath = path.join(botSoulDir, sf);

      if (fs.existsSync(destPath) && !fs.existsSync(tmplPath)) continue;

      if (fs.existsSync(tmplPath)) {
        let content = fs.readFileSync(tmplPath, 'utf-8');
        content = content.replace(/\{\{backend\}\}/g, bot.backend);
        content = content.replace(/\{\{cwd\}\}/g, bot.cwd || os.homedir());
        content = content.replace(/\{\{botName\}\}/g, bot.name);
        fs.writeFileSync(destPath, content);
      }
    }
    console.log(`✅ ${bot.name}: soul files → ${botSoulDir}`);
  }
  console.log('\n📌 Step 8: Write configuration files\n');

  fs.mkdirSync(dataDir, { recursive: true });

  // Atomic config write: write to temp file first, then rename.
  // If the write fails, the original config (if any) is preserved.
  const config: any = {
    system: existingConfig?.system || {
      defaultProjectDir: os.homedir(),
      idleTimeoutMinutes: 30,
      maxReplyLength: 140000,
    },
    workspace: {
      mode: workspaceMode,
      globalPath: workspaceGlobalPath,
      botOverrides: {},
    },
    providers,
    defaultModel,
    modelAliases: existingConfig?.modelAliases || buildDefaultAliases(defaultModel),
    execServer: existingConfig?.execServer || {
      enabled: true,
      startupTimeoutMs: 15000,
      fallbackToExec: true,
    },
    codex: existingConfig?.codex || {
      reportedModel: 'gpt-5.5',
      model: defaultModel.split('/')[1] || 'deepseek-v4-pro',
      upstream: (providers[defaultModel.split('/')[0]]?.baseUrl || 'https://api.deepseek.com/v1') + '/chat/completions',
    },
    opencode: existingConfig?.opencode || {
      serverUrl: 'http://localhost:4096',
      defaultModel: { providerID: 'anthropic', modelID: 'claude-sonnet-4-5' },
    },
    rateLimit: existingConfig?.rateLimit || {
      enabled: true,
      maxRequests: 30,
      windowMs: 60000,
    },
    shutdown: existingConfig?.shutdown || {
      gracePeriodMs: 5000,
    },
    bots,
  };

  // Write to temp file first for atomicity
  const configTmpPath = configPath + '.tmp';
  const providersTmpPath = path.join(dataDir, 'providers.json.tmp');
  let writeOk = true;

  try {
    fs.writeFileSync(configTmpPath, JSON.stringify(config, null, 2) + '\n');
    fs.renameSync(configTmpPath, configPath);
    console.log(`✅ ${configPath}`);
  } catch (e: any) {
    console.error(`❌ Failed to write config.json: ${e.message}`);
    writeOk = false;
  }

  if (writeOk) {
    try {
      const providersFile: any = { providers, defaultModel, modelAliases: config.modelAliases };
      const providersPath = path.join(dataDir, 'providers.json');
      fs.writeFileSync(providersTmpPath, JSON.stringify(providersFile, null, 2) + '\n');
      fs.renameSync(providersTmpPath, providersPath);
      console.log(`✅ ${providersPath}`);
    } catch (e: any) {
      console.error(`❌ Failed to write providers.json: ${e.message}`);
      console.error('⚠️  config.json was written successfully, but providers.json failed.');
      console.error('   Please re-run "imtoagent setup" to fix.');
      writeOk = false;
    }
  }

  if (writeOk) {
    const opencodePath = path.join(dataDir, 'opencode.json');
    const opencodeTemplate = getTemplatePath('opencode.template.json');
    if (fs.existsSync(opencodeTemplate)) {
      fs.writeFileSync(opencodePath, fs.readFileSync(opencodeTemplate, 'utf-8'));
      console.log(`✅ ${opencodePath}`);
    }
  }

  fs.mkdirSync(path.join(dataDir, 'sessions'), { recursive: true });
  fs.mkdirSync(path.join(dataDir, 'logs'), { recursive: true });
  console.log('✅ Sub-directories created (sessions/, logs/)');

  // ===== Done =====
  console.log('\n╔══════════════════════════════════════════════╗');
  console.log('║   ✅ Configuration complete!                 ║');
  console.log('╚══════════════════════════════════════════════╝\n');
  console.log(`Bots: ${bots.map(b => b.name).join(', ')}`);
  console.log(`Default model: ${defaultModel}`);
  console.log(`Providers: ${Object.keys(providers).join(', ') || 'None'}`);
  console.log(`Workspace: ${workspaceMode === 'sandbox' ? 'sandbox (isolated)' : `global (${workspaceGlobalPath})`}`);
  console.log(`\nNext steps:`);
  console.log(`  imtoagent start    Start the gateway`);
  console.log(`  imtoagent status   Check status\n`);
}

// ================================================================
// Utility functions
// ================================================================

function buildDefaultAliases(defaultModel: string): Record<string, string> {
  return {
    default: defaultModel,
    sonnet: defaultModel,
    opus: defaultModel,
    haiku: defaultModel,
    best: defaultModel,
    opencode: defaultModel,
  };
}
