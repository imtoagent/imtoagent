// ================================================================
// imtoagent providers — Provider management CLI
// ================================================================
// Commands: list, presets, presets show <name>, add, remove, set
// 统一读写 config.json.providers（不再使用 providers.json）
// ================================================================

import * as fs from 'fs';
import * as path from 'path';
import { getDataDir } from '../utils/paths';
import { loadPresets, findPreset, listPresets, presetToProvider } from '../utils/provider-presets';

// ================================================================
// Config structure
// ================================================================

interface ConfigFile {
  providers?: Record<string, {
    baseUrl: string;
    apiKey: string;
    models?: string[] | Array<{ id: string }>;
    format?: string;
  }>;
  defaultModel?: string;
  activeModel?: string;
  modelAliases?: Record<string, string>;
}

function getConfigPath(): string {
  return path.join(getDataDir(), 'config.json');
}

function loadConfig(): ConfigFile {
  const configPath = getConfigPath();
  if (!fs.existsSync(configPath)) {
    return { providers: {} };
  }
  try {
    return JSON.parse(fs.readFileSync(configPath, 'utf-8'));
  } catch {
    return { providers: {} };
  }
}

function saveConfig(config: ConfigFile): void {
  const configPath = getConfigPath();
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n');
}

// ================================================================
// Main entry
// ================================================================

export async function cmdProviders(...args: string[]): Promise<void> {
  const subCmd = args[0] || 'list';

  switch (subCmd) {
    case 'list':
      await cmdProvidersList();
      break;
    case 'presets':
      await cmdPresets(args.slice(1));
      break;
    case 'add':
      await cmdProvidersAdd(args.slice(1));
      break;
    case 'remove':
      await cmdProvidersRemove(args.slice(1));
      break;
    case 'set':
      await cmdProvidersSet(args.slice(1));
      break;
    default:
      printProvidersHelp();
      break;
  }
}

// ================================================================
// list — Show configured providers
// ================================================================

async function cmdProvidersList(): Promise<void> {
  const config = loadConfig();
  const entries = Object.entries(config.providers || {});

  if (entries.length === 0) {
    console.log('No providers configured. Use "imtoagent providers presets" to see available templates.');
    return;
  }

  console.log('\n🔌 Configured Providers\n');
  if (config.activeModel) {
    console.log(`  Active Model: ${config.activeModel}\n`);
  }

  for (const [name, p] of entries) {
    const modelList = (p.models || [])
      .map((m: any) => typeof m === 'string' ? m : m.id)
      .join(', ');
    console.log(`  ${name}`);
    console.log(`    Base URL: ${p.baseUrl || ''}`);
    console.log(`    Models:   ${modelList || '(none)'}`);
    console.log(`    Format:   ${p.format || 'anthropic'}`);
    console.log(`    API Key:  ${maskKey(p.apiKey || '')}`);
    console.log();
  }
}

// ================================================================
// presets — List or show preset details
// ================================================================

async function cmdPresets(args: string[]): Promise<void> {
  if (args[0] === 'show' && args[1]) {
    const preset = findPreset(args[1]);
    if (!preset) {
      console.log(`Preset not found: ${args[1]}`);
      console.log('Use "imtoagent providers presets" to list all presets.');
      return;
    }
    console.log(`\n📋 Preset: ${preset.name}\n`);
    console.log(`  Base URL: ${preset.baseUrl}`);
    console.log(`  Format:   ${preset.format}`);
    console.log(`  Models:   ${preset.models.join(', ')}`);
    console.log(`  Notes:    ${preset.notes}`);
    console.log(`\nUsage:`);
    console.log(`  imtoagent providers add --preset "${preset.name}" --key YOUR_API_KEY`);
    console.log();
    return;
  }

  const presets = listPresets(args[0] || undefined);
  if (presets.length === 0) {
    console.log(`No presets found matching "${args[0]}".`);
    return;
  }

  console.log(`\n📋 Available Provider Presets — ${presets.length} total\n`);
  console.log(pad('Name', 30) + pad('Format', 12) + 'Notes');
  console.log('─'.repeat(80));

  for (const p of presets) {
    console.log(pad(p.name, 30) + pad(p.format, 12) + p.notes);
  }
  console.log(`\nShow details: imtoagent providers presets show <name>`);
  console.log(`Add from preset: imtoagent providers add --preset <name> --key <api-key>`);
  console.log();
}

// ================================================================
// add — Add a provider
// ================================================================

async function cmdProvidersAdd(args: string[]): Promise<void> {
  let presetName: string | undefined;
  let apiKey: string | undefined;
  let customName: string | undefined;
  let baseUrl: string | undefined;
  let model: string | undefined;
  let format: 'openai' | 'anthropic' | 'azure' = 'openai';

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--preset':
        presetName = args[++i];
        break;
      case '--key':
        apiKey = args[++i];
        break;
      case '--name':
        customName = args[++i];
        break;
      case '--base-url':
        baseUrl = args[++i];
        break;
      case '--model':
        model = args[++i];
        break;
      case '--format':
        format = args[++i] as 'openai' | 'anthropic' | 'azure';
        break;
    }
  }

  if (presetName) {
    // Add from preset
    const preset = findPreset(presetName);
    if (!preset) {
      console.log(`Preset not found: ${presetName}`);
      return;
    }
    if (!apiKey) {
      console.log(`Error: --key is required when adding from preset.`);
      console.log(`Usage: imtoagent providers add --preset "${preset.name}" --key sk-xxx`);
      return;
    }
    const provider = presetToProvider(preset, apiKey);
    const name = customName || preset.name.toLowerCase().replace(/\s+/g, '-');
    saveProvider(name, {
      baseUrl: provider.baseUrl,
      apiKey: provider.apiKey,
      models: preset.models,
      format: provider.format,
    });
    console.log(`✅ Provider "${name}" added from preset "${preset.name}".`);
    return;
  }

  // Manual add
  if (!customName || !baseUrl || !apiKey) {
    console.log('Error: --name, --base-url, and --key are required for manual add.');
    console.log('Usage: imtoagent providers add --name myprovider --base-url https://... --key sk-xxx');
    return;
  }

  saveProvider(customName, {
    baseUrl,
    apiKey,
    models: model ? [model] : [],
    format,
  });
  console.log(`✅ Provider "${customName}" added.`);
}

// ================================================================
// remove — Remove a provider
// ================================================================

async function cmdProvidersRemove(args: string[]): Promise<void> {
  const name = args[0];
  if (!name) {
    console.log('Usage: imtoagent providers remove <name>');
    return;
  }

  const config = loadConfig();
  if (!config.providers || !config.providers[name]) {
    console.log(`Provider "${name}" not found.`);
    return;
  }

  delete config.providers[name];
  saveConfig(config);
  console.log(`✅ Provider "${name}" removed.`);
}

// ================================================================
// set — Switch active model
// ================================================================

async function cmdProvidersSet(args: string[]): Promise<void> {
  // "set <provider/model>" — sets activeModel
  const modelSpec = args[0];
  if (!modelSpec) {
    console.log('Usage: imtoagent providers set <provider/model>');
    return;
  }

  const config = loadConfig();
  const parts = modelSpec.split('/');
  const providerName = parts[0];

  if (!config.providers || !config.providers[providerName]) {
    console.log(`Provider "${providerName}" not found. Use "imtoagent providers list" to see configured providers.`);
    return;
  }

  config.activeModel = modelSpec;
  saveConfig(config);
  console.log(`✅ Active model set to "${modelSpec}".`);
}

// ================================================================
// Helpers
// ================================================================

function saveProvider(name: string, provider: { baseUrl: string; apiKey: string; models: string[]; format: string }): void {
  const config = loadConfig();
  if (!config.providers) config.providers = {};
  config.providers[name] = {
    baseUrl: provider.baseUrl,
    apiKey: provider.apiKey,
    models: provider.models,
    format: provider.format,
  };
  if (!config.activeModel) {
    config.activeModel = `${name}/${provider.models[0] || ''}`;
  }
  saveConfig(config);
}

function maskKey(key: string): string {
  if (key.length <= 8) return '****';
  return key.substring(0, 6) + '...' + key.substring(key.length - 4);
}

function pad(s: string, width: number): string {
  return s.padEnd(width);
}

function printProvidersHelp(): void {
  console.log(`
imtoagent providers — Provider management

Usage:
  imtoagent providers list                  List configured providers
  imtoagent providers presets               List available presets
  imtoagent providers presets show <name>   Show preset details
  imtoagent providers add --preset <name> --key <api-key>
  imtoagent providers add --name <name> --base-url <url> --key <api-key>
  imtoagent providers remove <name>         Remove a provider
  imtoagent providers set <provider/model>  Switch active model
`);
}
