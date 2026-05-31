// ================================================================
// imtoagent providers — Provider management CLI
// ================================================================
// Commands: list, presets, presets show <name>, add, remove, set
// Reads/writes ~/.imtoagent/providers.json
// ================================================================

import * as fs from 'fs';
import * as path from 'path';
import { getProvidersPath } from '../utils/paths';
import { loadPresets, findPreset, listPresets, presetToProvider } from '../utils/provider-presets';

// ================================================================
// Providers.json structure
// ================================================================

interface ProvidersFile {
  providers: Record<string, {
    baseUrl: string;
    apiKey: string;
    model: string;
    format: 'openai' | 'anthropic' | 'azure';
  }>;
  active?: string;
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
  const data = loadProviders();
  const entries = Object.entries(data.providers);

  if (entries.length === 0) {
    console.log('No providers configured. Use "imtoagent providers presets" to see available templates.');
    return;
  }

  console.log('\n🔌 Configured Providers\n');
  if (data.active) {
    console.log(`  Active: ${data.active}\n`);
  }

  for (const [name, p] of entries) {
    const activeTag = data.active === name ? ' ← active' : '';
    console.log(`  ${name}${activeTag}`);
    console.log(`    Base URL: ${p.baseUrl}`);
    console.log(`    Model:    ${p.model}`);
    console.log(`    Format:   ${p.format}`);
    console.log(`    API Key:  ${maskKey(p.apiKey)}`);
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
    saveProvider(name, provider);
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
    model: model || '',
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

  const data = loadProviders();
  if (!data.providers[name]) {
    console.log(`Provider "${name}" not found.`);
    return;
  }

  delete data.providers[name];
  if (data.active === name) data.active = undefined;

  fs.writeFileSync(getProvidersPath(), JSON.stringify(data, null, 2));
  console.log(`✅ Provider "${name}" removed.`);
}

// ================================================================
// set — Switch active provider
// ================================================================

async function cmdProvidersSet(args: string[]): Promise<void> {
  const name = args[0];
  if (!name) {
    console.log('Usage: imtoagent providers set <name>');
    return;
  }

  const data = loadProviders();
  if (!data.providers[name]) {
    console.log(`Provider "${name}" not found. Use "imtoagent providers list" to see configured providers.`);
    return;
  }

  data.active = name;
  fs.writeFileSync(getProvidersPath(), JSON.stringify(data, null, 2));
  console.log(`✅ Active provider set to "${name}".`);
}

// ================================================================
// Helpers
// ================================================================

function loadProviders(): ProvidersFile {
  const providersPath = getProvidersPath();
  if (!fs.existsSync(providersPath)) {
    return { providers: {} };
  }
  try {
    return JSON.parse(fs.readFileSync(providersPath, 'utf-8'));
  } catch {
    return { providers: {} };
  }
}

function saveProvider(name: string, config: { baseUrl: string; apiKey: string; model: string; format: string }): void {
  const data = loadProviders();
  data.providers[name] = config as Record<string, unknown>;
  if (!data.active) data.active = name;
  fs.writeFileSync(getProvidersPath(), JSON.stringify(data, null, 2));
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
  imtoagent providers set <name>            Switch active provider
`);
}
