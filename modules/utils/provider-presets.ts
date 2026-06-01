// ================================================================
// Provider Presets — built-in provider templates
// ================================================================
// Bundled with npm package, read from templates/providers-presets.json
// ================================================================

import * as fs from 'fs';
import * as path from 'path';
import { getPkgDir } from './paths';

export interface ProviderPreset {
  name: string;
  baseUrl: string;
  format: 'openai' | 'anthropic' | 'azure';
  models: string[] | Array<{id: string; supportedInputTypes?: string[]}>;
  notes: string;
}

// Cache loaded presets
let _presets: ProviderPreset[] | null = null;

/**
 * Load all provider presets from the bundled JSON file.
 */
export function loadPresets(): ProviderPreset[] {
  if (_presets) return _presets;

  try {
    const pkgDir = getPkgDir();
    const presetsPath = path.join(pkgDir, 'templates', 'providers-presets.json');
    const raw = fs.readFileSync(presetsPath, 'utf-8');
    const data = JSON.parse(raw);
    _presets = data.presets as ProviderPreset[];
    return _presets;
  } catch (err) {
    console.error(`[ProviderPresets] Failed to load presets: ${err}`);
    return [];
  }
}

/**
 * Find a preset by name (case-insensitive).
 */
export function findPreset(name: string): ProviderPreset | undefined {
  const presets = loadPresets();
  const lower = name.toLowerCase();
  return presets.find((p) => p.name.toLowerCase().includes(lower) || lower.includes(p.name.toLowerCase()));
}

/**
 * List presets by category (simple keyword grouping).
 */
export function listPresets(filter?: string): ProviderPreset[] {
  const presets = loadPresets();
  if (!filter) return presets;

  const lower = filter.toLowerCase();
  return presets.filter(
    (p) =>
      p.name.toLowerCase().includes(lower) ||
      p.notes.toLowerCase().includes(lower)
  );
}

/**
 * Format a preset as a provider config entry for providers.json.
 */
export function presetToProvider(preset: ProviderPreset, apiKey: string): {
  baseUrl: string;
  apiKey: string;
  model: string;
  format: string;
} {
  return {
    baseUrl: preset.baseUrl,
    apiKey,
    model: (typeof preset.models[0] === 'string' ? preset.models[0] : (preset.models[0] as {id: string}).id) || '',
    format: preset.format,
  };
}

/**
 * Reset cache (for testing).
 */
export function resetPresetCache(): void {
  _presets = null;
}
