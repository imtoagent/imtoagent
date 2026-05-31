/**
 * utils-provider-presets.test.ts
 *
 * Tests for provider preset utilities:
 * - Load all presets (at least 27)
 * - Find preset by name (case-insensitive)
 * - Preset contains baseUrl/model/format
 * - List presets with filter
 * - presetToProvider conversion
 * - Cache and reset
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import {
  loadPresets,
  findPreset,
  listPresets,
  presetToProvider,
  resetPresetCache,
} from "../modules/utils/provider-presets";

// ================================================================
// 1. Load all presets
// ================================================================

describe("loadPresets", () => {
  beforeEach(() => resetPresetCache());
  afterEach(() => resetPresetCache());

  it("should return at least 27 presets", () => {
    const presets = loadPresets();
    expect(presets.length).toBeGreaterThanOrEqual(27);
  });

  it("should cache the result", () => {
    const p1 = loadPresets();
    const p2 = loadPresets();
    expect(p1).toBe(p2); // same reference
  });

  it("each preset should have required fields", () => {
    const presets = loadPresets();
    for (const p of presets) {
      expect(typeof p.name).toBe("string");
      expect(typeof p.baseUrl).toBe("string");
      expect(typeof p.format).toBe("string");
      expect(Array.isArray(p.models)).toBe(true);
      expect(p.models.length).toBeGreaterThan(0);
    }
  });

  it("format should be openai, anthropic, or azure", () => {
    const presets = loadPresets();
    const validFormats = new Set(["openai", "anthropic", "azure"]);
    for (const p of presets) {
      expect(validFormats.has(p.format)).toBe(true);
    }
  });
});

// ================================================================
// 2. Find preset by name
// ================================================================

describe("findPreset", () => {
  beforeEach(() => resetPresetCache());
  afterEach(() => resetPresetCache());

  it("should find preset by exact name", () => {
    const p = findPreset("OpenRouter");
    expect(p).toBeDefined();
    expect(p!.name).toBe("OpenRouter");
  });

  it("should find preset case-insensitively", () => {
    const p1 = findPreset("openrouter");
    const p2 = findPreset("OPENROUTER");
    expect(p1).toBeDefined();
    expect(p2).toBeDefined();
    expect(p1!.name).toBe(p2!.name);
  });

  it("should find preset by partial name", () => {
    const p = findPreset("silicon");
    expect(p).toBeDefined();
    expect(p!.name.toLowerCase()).toContain("silicon");
  });

  it("should find Chinese provider presets", () => {
    const moonshot = findPreset("moonshot");
    expect(moonshot).toBeDefined();

    const zhipu = findPreset("智谱");
    expect(zhipu).toBeDefined();
  });

  it("should return undefined for unknown name", () => {
    const p = findPreset("nonexistent-provider-xyz-123");
    expect(p).toBeUndefined();
  });
});

// ================================================================
// 3. Preset content validation
// ================================================================

describe("preset content validation", () => {
  beforeEach(() => resetPresetCache());
  afterEach(() => resetPresetCache());

  it("preset should include baseUrl", () => {
    const p = findPreset("OpenRouter");
    expect(p!.baseUrl).toMatch(/^https?:\/\//);
  });

  it("preset should include at least one model", () => {
    const p = findPreset("OpenAI");
    expect(p!.models.length).toBeGreaterThan(0);
    expect(p!.models[0].length).toBeGreaterThan(0);
  });

  it("preset should include notes", () => {
    const presets = loadPresets();
    for (const p of presets) {
      expect(typeof p.notes).toBe("string");
    }
  });

  it("official providers should have correct baseUrls", () => {
    const openai = findPreset("OpenAI 官方");
    expect(openai).toBeDefined();
    expect(openai!.baseUrl).toContain("openai.com");

    const anthropic = findPreset("Anthropic");
    expect(anthropic).toBeDefined();
    expect(anthropic!.baseUrl).toContain("anthropic.com");
  });
});

// ================================================================
// 4. List presets with filter
// ================================================================

describe("listPresets", () => {
  beforeEach(() => resetPresetCache());
  afterEach(() => resetPresetCache());

  it("should return all presets without filter", () => {
    const all = loadPresets();
    const listed = listPresets();
    expect(listed.length).toBe(all.length);
  });

  it("should filter by name keyword", () => {
    const results = listPresets("openai");
    expect(results.length).toBeGreaterThan(0);
    for (const p of results) {
      expect(p.name.toLowerCase().includes("openai") ||
             p.notes.toLowerCase().includes("openai")).toBe(true);
    }
  });

  it("should filter by notes keyword", () => {
    const results = listPresets("api");
    expect(results.length).toBeGreaterThan(0);
  });

  it("should return empty array for non-matching filter", () => {
    const results = listPresets("xyznonexistent123");
    expect(results.length).toBe(0);
  });
});

// ================================================================
// 5. presetToProvider
// ================================================================

describe("presetToProvider", () => {
  beforeEach(() => resetPresetCache());
  afterEach(() => resetPresetCache());

  it("should convert preset to provider config", () => {
    const preset = findPreset("OpenRouter")!;
    const provider = presetToProvider(preset, "test-api-key-123");

    expect(provider.baseUrl).toBe(preset.baseUrl);
    expect(provider.apiKey).toBe("test-api-key-123");
    expect(provider.model).toBe(preset.models[0]);
    expect(provider.format).toBe(preset.format);
  });

  it("should use first model as default", () => {
    const preset = findPreset("Groq")!;
    const provider = presetToProvider(preset, "key");
    expect(provider.model).toBe(preset.models[0]);
  });
});

// ================================================================
// 6. Cache reset
// ================================================================

describe("resetPresetCache", () => {
  it("should allow reloading after reset", () => {
    const p1 = loadPresets();
    resetPresetCache();
    const p2 = loadPresets();
    // After reset, loadPresets re-reads the file
    expect(p2.length).toBe(p1.length);
  });
});
