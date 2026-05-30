// ================================================================
// doctor.ts — 配置诊断与自动修复
// ================================================================
// imtoagent doctor
//   检查 config.json, providers.json, 数据目录, 后端, 端口, API Key 格式等
//   对可修复问题，用户确认后自动修复
// ================================================================

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execSync } from 'child_process';
import { getDataDir, getConfigPath, getProvidersPath, getSessionsDir, getLogsDir, getOpencodeConfigPath } from './paths';
import { checkBackend, checkAllBackends } from './backend-check';

// ================================================================
// Issue 类型
// ================================================================

export type IssueSeverity = 'error' | 'warning' | 'info';

export interface DoctorIssue {
  severity: IssueSeverity;
  category: string;
  message: string;
  fixable: boolean;
  fixDescription?: string;
  fix?: () => Promise<boolean> | boolean;
}

// ================================================================
// API Key 格式验证
// ================================================================

const API_KEY_PATTERNS: Record<string, { prefix: string; minLength: number }> = {
  // OpenAI 格式
  'openai': { prefix: 'sk-proj-', minLength: 20 },
  // Anthropic 格式
  'anthropic': { prefix: 'sk-ant-', minLength: 20 },
  // 百炼/DashScope 格式
  'dashscope': { prefix: 'sk-', minLength: 20 },
  // 通用 sk- 格式
  'generic-sk': { prefix: 'sk-', minLength: 10 },
};

function validateApiKey(key: string): { valid: boolean; reason?: string } {
  if (!key) return { valid: false, reason: 'empty' };
  if (key.includes('YOUR_') || key.includes('xxx') || key.includes('PLACEHOLDER') || key.includes('placeholder')) {
    return { valid: false, reason: 'placeholder value' };
  }
  // 太短的 key 大概率是无效的
  if (key.length < 8) return { valid: false, reason: `too short (${key.length} chars)` };
  return { valid: true };
}

// ================================================================
// 诊断检查
// ================================================================

export async function runDoctorChecks(): Promise<DoctorIssue[]> {
  const issues: DoctorIssue[] = [];
  const dataDir = getDataDir();
  const configPath = getConfigPath();
  const providersPath = getProvidersPath();
  const sessionsDir = getSessionsDir();
  const logsDir = getLogsDir();

  // ---- 1. 数据目录结构 ----
  const requiredDirs = [
    { path: dataDir, name: 'Data directory (~/.imtoagent/)' },
    { path: sessionsDir, name: 'Sessions directory' },
    { path: logsDir, name: 'Logs directory' },
  ];
  for (const dir of requiredDirs) {
    if (!fs.existsSync(dir.path)) {
      const dirPath = dir.path;
      issues.push({
        severity: 'error',
        category: 'Directory',
        message: `${dir.name} not found: ${dirPath}`,
        fixable: true,
        fixDescription: `Create directory: ${dirPath}`,
        fix: () => { fs.mkdirSync(dirPath, { recursive: true }); return true; },
      });
    }
  }

  // ---- 2. config.json ----
  let configRaw: string | null = null;
  let config: any = null;

  if (!fs.existsSync(configPath)) {
    issues.push({
      severity: 'error',
      category: 'Config',
      message: 'config.json not found — run "imtoagent setup" to create it',
      fixable: false,
    });
    return issues; // 没有配置文件，后续检查无意义
  }

  try {
    configRaw = fs.readFileSync(configPath, 'utf-8');
    config = JSON.parse(configRaw);
    issues.push({ severity: 'info', category: 'Config', message: 'config.json parse OK', fixable: false });
  } catch (e: any) {
    // 尝试修复常见 JSON 语法错误
    const fixed = tryFixJSON(configRaw);
    if (fixed !== null) {
      issues.push({
        severity: 'error',
        category: 'Config',
        message: `config.json has syntax errors: ${e.message}`,
        fixable: true,
        fixDescription: 'Auto-fix common JSON syntax issues (trailing commas, comments)',
        fix: () => {
          fs.writeFileSync(configPath, fixed + '\n');
          return true;
        },
      });
      config = JSON.parse(fixed);
    } else {
      issues.push({
        severity: 'error',
        category: 'Config',
        message: `config.json parse error: ${e.message}`,
        fixable: false,
      });
      return issues;
    }
  }

  // 检查必要字段
  if (!config.bots || !Array.isArray(config.bots)) {
    issues.push({
      severity: 'error',
      category: 'Config',
      message: 'No "bots" array in config.json — no Bots configured',
      fixable: false,
    });
  } else if (config.bots.length === 0) {
    issues.push({
      severity: 'warning',
      category: 'Config',
      message: '"bots" array is empty — no Bots configured',
      fixable: false,
    });
  } else {
    for (let i = 0; i < config.bots.length; i++) {
      const bot = config.bots[i];
      const botLabel = bot.name || `bots[${i}]`;
      const botIssues: string[] = [];

      if (!bot.name) botIssues.push('missing "name"');
      if (!bot.appId) botIssues.push('missing "appId"');
      if (!bot.appSecret) botIssues.push('missing "appSecret"');
      if (!bot.backend) botIssues.push('missing "backend"');
      if (bot.backend && !['claude', 'codex', 'opencode'].includes(bot.backend)) {
        botIssues.push(`unknown backend "${bot.backend}" (expected: claude/codex/opencode)`);
      }

      if (botIssues.length > 0) {
        issues.push({
          severity: 'error',
          category: 'Config',
          message: `Bot "${botLabel}": ${botIssues.join(', ')}`,
          fixable: false,
        });
      } else {
        issues.push({ severity: 'info', category: 'Config', message: `Bot "${bot.name}" OK (${bot.backend})`, fixable: false });
      }
    }
  }

  // 检查 system 配置
  if (!config.system) {
    const systemPath = 'system';
    issues.push({
      severity: 'warning',
      category: 'Config',
      message: 'Missing "system" section in config.json',
      fixable: true,
      fixDescription: 'Add default system config (idleTimeoutMinutes: 30, etc.)',
      fix: () => {
        config.system = { defaultProjectDir: os.homedir(), idleTimeoutMinutes: 30 };
        fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n');
        return true;
      },
    });
  }

  // ---- 3. providers.json ----
  let providers: any = null;

  if (!fs.existsSync(providersPath)) {
    issues.push({
      severity: 'warning',
      category: 'Providers',
      message: 'providers.json not found',
      fixable: false,
    });
  } else {
    try {
      const provRaw = fs.readFileSync(providersPath, 'utf-8');
      providers = JSON.parse(provRaw);
      issues.push({ severity: 'info', category: 'Providers', message: 'providers.json parse OK', fixable: false });

      // 检查 placeholder API keys
      const provStr = JSON.stringify(providers);
      if (provStr.includes('YOUR_') || provStr.includes('sk-xxx') || provStr.includes('PLACEHOLDER')) {
        issues.push({
          severity: 'warning',
          category: 'Providers',
          message: 'providers.json may contain placeholder API keys',
          fixable: false,
        });
      }

      // 验证每个 provider 的 API key
      if (providers.providers) {
        for (const [provName, provCfg] of Object.entries(providers.providers) as [string, any][]) {
          if (provCfg.apiKey) {
            const result = validateApiKey(provCfg.apiKey);
            if (!result.valid) {
              issues.push({
                severity: 'warning',
                category: 'Providers',
                message: `Provider "${provName}" API key looks invalid (${result.reason})`,
                fixable: false,
              });
            } else {
              issues.push({ severity: 'info', category: 'Providers', message: `Provider "${provName}" API key format OK`, fixable: false });
            }
          }
        }
      }
    } catch (e: any) {
      const fixed = tryFixJSON(fs.readFileSync(providersPath, 'utf-8'));
      if (fixed !== null) {
        issues.push({
          severity: 'error',
          category: 'Providers',
          message: `providers.json has syntax errors: ${e.message}`,
          fixable: true,
          fixDescription: 'Auto-fix common JSON syntax issues',
          fix: () => {
            fs.writeFileSync(providersPath, fixed + '\n');
            return true;
          },
        });
      } else {
        issues.push({
          severity: 'error',
          category: 'Providers',
          message: `providers.json parse error: ${e.message}`,
          fixable: false,
        });
      }
    }
  }

  // ---- 4. 后端检查 ----
  if (config.bots && config.bots.length > 0) {
    const checkedTypes = new Set<string>();
    for (const bot of config.bots) {
      if (bot.backend && ['claude', 'codex', 'opencode'].includes(bot.backend) && !checkedTypes.has(bot.backend)) {
        checkedTypes.add(bot.backend);
        const info = checkBackend(bot.backend as any);
        if (info.installed) {
          issues.push({ severity: 'info', category: 'Backend', message: `${info.label} v${info.version} (${info.installSource})`, fixable: false });
        } else {
          issues.push({
            severity: 'error',
            category: 'Backend',
            message: `${info.label} not installed — Bot "${bot.name}" requires it`,
            fixable: false,
          });
        }
      }
    }
  }

  // ---- 5. 端口检查 ----
  try {
    const net = await import('net');
    const checkPort = (port: number): Promise<boolean> => {
      return new Promise((resolve) => {
        const socket = new net.Socket();
        socket.setTimeout(2000);
        socket.on('connect', () => { socket.destroy(); resolve(true); });
        socket.on('error', () => resolve(false));
        socket.on('timeout', () => { socket.destroy(); resolve(false); });
        socket.connect(port, '127.0.0.1');
      });
    };
    const reachable = await checkPort(18899);
    if (reachable) {
      // 检查是否是 imtoagent 自己的进程
      try {
        const lsofOut = execSync(`lsof -i :18899 2>/dev/null`, { encoding: 'utf-8', timeout: 3000 }).trim();
        if (lsofOut && lsofOut.includes('imtoagent') || lsofOut.includes('bun') || lsofOut.includes('node')) {
          issues.push({ severity: 'info', category: 'Port', message: 'Port 18899 in use by imtoagent gateway', fixable: false });
        } else {
          issues.push({
            severity: 'error',
            category: 'Port',
            message: `Port 18899 occupied by another process:\n${lsofOut.split('\n').slice(0, 3).join('\n')}`,
            fixable: false,
          });
        }
      } catch {
        issues.push({ severity: 'info', category: 'Port', message: 'Port 18899 in use', fixable: false });
      }
    } else {
      issues.push({ severity: 'info', category: 'Port', message: 'Port 18899 is free', fixable: false });
    }
  } catch {
    issues.push({ severity: 'warning', category: 'Port', message: 'Port check failed (skipped)', fixable: false });
  }

  // ---- 6. Bot appId/appSecret 格式 ----
  if (config.bots) {
    for (const bot of config.bots) {
      if (bot.appId && bot.appId.includes('YOUR_')) {
        issues.push({
          severity: 'warning',
          category: 'Credentials',
          message: `Bot "${bot.name}" appId is placeholder: ${bot.appId}`,
          fixable: false,
        });
      }
      if (bot.appSecret && bot.appSecret.includes('YOUR_')) {
        issues.push({
          severity: 'warning',
          category: 'Credentials',
          message: `Bot "${bot.name}" appSecret is placeholder`,
          fixable: false,
        });
      }
    }
  }

  // ---- 7. Soul 目录检查 ----
  if (config.bots) {
    for (const bot of config.bots) {
      const botKey = bot.id || bot.name;
      const soulDir = path.join(dataDir, 'soul', botKey);
      if (fs.existsSync(soulDir)) {
        const soulFiles = fs.readdirSync(soulDir);
        if (soulFiles.length === 0) {
          issues.push({
            severity: 'warning',
            category: 'Soul',
            message: `Bot "${bot.name}" soul directory is empty: ${soulDir}`,
            fixable: false,
          });
        } else {
          issues.push({ severity: 'info', category: 'Soul', message: `Bot "${bot.name}" soul: ${soulFiles.length} file(s)`, fixable: false });
        }
      }
    }
  }

  // ---- 8. opencode.json 检查 ----
  const opencodePath = getOpencodeConfigPath();
  if (fs.existsSync(opencodePath)) {
    try {
      const ocRaw = fs.readFileSync(opencodePath, 'utf-8');
      JSON.parse(ocRaw);
      issues.push({ severity: 'info', category: 'Config', message: 'opencode.json parse OK', fixable: false });
    } catch (e: any) {
      const fixed = tryFixJSON(fs.readFileSync(opencodePath, 'utf-8'));
      if (fixed !== null) {
        issues.push({
          severity: 'error',
          category: 'Config',
          message: `opencode.json has syntax errors: ${e.message}`,
          fixable: true,
          fixDescription: 'Auto-fix common JSON syntax issues',
          fix: () => {
            fs.writeFileSync(opencodePath, fixed + '\n');
            return true;
          },
        });
      } else {
        issues.push({
          severity: 'error',
          category: 'Config',
          message: `opencode.json parse error: ${e.message}`,
          fixable: false,
        });
      }
    }
  }

  return issues;
}

// ================================================================
// JSON 修复 — 处理常见语法错误
// ================================================================

function tryFixJSON(raw: string): string | null {
  // 尝试 1: 直接解析
  try { JSON.parse(raw); return raw; } catch {}

  // 尝试 2: 移除行尾逗号 (trailing commas)
  let fixed = raw.replace(/,\s*([}\]])/g, '$1');
  try { JSON.parse(fixed); return fixed; } catch {}

  // 尝试 3: 移除单行注释 (// ...)
  fixed = fixed.replace(/\/\/.*$/gm, '');
  try { JSON.parse(fixed); return fixed; } catch {}

  // 尝试 4: 移除多行注释 (/* ... */)
  fixed = fixed.replace(/\/\*[\s\S]*?\*\//g, '');
  try { JSON.parse(fixed); return fixed; } catch {}

  // 尝试 5: 移除尾随逗号 + 注释组合
  fixed = raw.replace(/\/\/.*$/gm, '').replace(/,\s*([}\]])/g, '$1');
  try { JSON.parse(fixed); return fixed; } catch {}

  return null;
}

// ================================================================
// 格式化输出
// ================================================================

export function formatIssues(issues: DoctorIssue[]): string {
  const errors = issues.filter(i => i.severity === 'error');
  const warnings = issues.filter(i => i.severity === 'warning');
  const infos = issues.filter(i => i.severity === 'info');

  let output = '';

  if (errors.length > 0) {
    output += `\n❌ Errors (${errors.length}):\n`;
    for (const e of errors) {
      output += `   ${e.message}\n`;
      if (e.fixable && e.fixDescription) {
        output += `   → Fix: ${e.fixDescription}\n`;
      }
    }
  }

  if (warnings.length > 0) {
    output += `\n⚠️  Warnings (${warnings.length}):\n`;
    for (const w of warnings) {
      output += `   ${w.message}\n`;
    }
  }

  if (infos.length > 0) {
    output += `\n✅ OK (${infos.length}):\n`;
    for (const i of infos) {
      output += `   ${i.message}\n`;
    }
  }

  return output;
}
