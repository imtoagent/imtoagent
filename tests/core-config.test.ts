// ================================================================
// core-config.test.ts — FileConfigManager 核心测试
// 测试: get嵌套, getBotConfig, getProviderConfig, getActiveModel, resolveModel
// ================================================================
import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import * as fs from "fs";
import * as path from "path";
import { FileConfigManager } from "../modules/core/config";
import { getDataDir, getSessionsDir, resetPathCache } from "../modules/utils/paths";

// ===================== Setup: isolated temp dir =====================

const TEMP_BASE = path.join(
  process.env.TMPDIR || "/tmp",
  `imtoagent-config-test-${Date.now()}`
);
const TEMP_SESSIONS = path.join(TEMP_BASE, "sessions");

beforeAll(() => {
  process.env.IMTOAGENT_HOME = TEMP_BASE;
  resetPathCache();
  fs.mkdirSync(TEMP_BASE, { recursive: true });
  fs.mkdirSync(TEMP_SESSIONS, { recursive: true });

  // Create config.json with full test data
  const configJson = {
    system: {
      defaultProjectDir: "/tmp/projects",
      idleTimeoutMinutes: 30,
      maxReplyLength: 4000,
    },
    providers: {
      anthropic: {
        baseUrl: "https://api.anthropic.com",
        apiKey: "sk-test-anthropic",
        models: ["claude-sonnet-4-20250514"],
        format: "anthropic",
        pricing: { inputPerMillion: 3, outputPerMillion: 15, currency: "USD" },
      },
      openai: {
        baseUrl: "https://api.openai.com",
        apiKey: "sk-test-openai",
        models: ["gpt-4o"],
        format: "openai",
      },
    },
    defaultModel: "claude-sonnet-4-20250514",
    activeModel: "claude-sonnet-4-20250514",
    modelAliases: {
      fast: "gpt-4o",
      smart: "claude-sonnet-4-20250514",
    },
    bots: [
      {
        name: "dev-bot",
        appId: "app_dev_123",
        appSecret: "secret_dev",
        backend: "claude",
        cwd: "/tmp/dev",
      },
      {
        name: "qa-bot",
        appId: "app_qa_456",
        appSecret: "secret_qa",
        backend: "codex",
      },
    ],
    execServer: {
      enabled: true,
      startupTimeoutMs: 30000,
      fallbackToExec: false,
    },
  };

  fs.writeFileSync(
    path.join(TEMP_BASE, "config.json"),
    JSON.stringify(configJson, null, 2)
  );

  // Create providers.json
  const providersJson = {
    providers: {
      deepseek: {
        baseUrl: "https://api.deepseek.com",
        apiKey: "sk-deepseek",
        models: ["deepseek-chat"],
        format: "openai",
      },
    },
  };

  fs.writeFileSync(
    path.join(TEMP_BASE, "providers.json"),
    JSON.stringify(providersJson, null, 2)
  );
});

afterAll(() => {
  try {
    fs.rmSync(TEMP_BASE, { recursive: true, force: true });
  } catch {}
  resetPathCache();
});

// Verify the data dir is correct
const DATA_DIR = getDataDir();
console.log(`[Test] Data dir: ${DATA_DIR}`);

// ===================== Tests =====================

describe("FileConfigManager", () => {
  describe("get — nested path access", () => {
    test("gets top-level field", () => {
      const config = new FileConfigManager();
      const defaultModel = config.get<string>("defaultModel");
      expect(defaultModel).toBe("claude-sonnet-4-20250514");
    });

    test("gets nested field: system.defaultProjectDir", () => {
      const config = new FileConfigManager();
      const dir = config.get<string>("system.defaultProjectDir");
      expect(dir).toBe("/tmp/projects");
    });

    test("gets nested field: system.idleTimeoutMinutes", () => {
      const config = new FileConfigManager();
      const timeout = config.get<number>("system.idleTimeoutMinutes");
      expect(timeout).toBe(30);
    });

    test("gets deeply nested field: execServer.enabled", () => {
      const config = new FileConfigManager();
      const enabled = config.get<boolean>("execServer.enabled");
      expect(enabled).toBe(true);
    });

    test("returns undefined for non-existent path", () => {
      const config = new FileConfigManager();
      const val = config.get<any>("nonexistent.field");
      expect(val).toBeUndefined();
    });

    test("returns undefined for partial non-existent path", () => {
      const config = new FileConfigManager();
      const val = config.get<any>("system.nonexistentField");
      expect(val).toBeUndefined();
    });

    test("gets provider config via path", () => {
      const config = new FileConfigManager();
      const baseUrl = config.get<string>("providers.anthropic.baseUrl");
      expect(baseUrl).toBe("https://api.anthropic.com");
    });

    test("gets array items via path", () => {
      const config = new FileConfigManager();
      const bots = config.get<any[]>("bots");
      expect(bots).toHaveLength(2);
      expect(bots[0].name).toBe("dev-bot");
    });
  });

  describe("getBotConfig", () => {
    test("returns full config for known bot", () => {
      const config = new FileConfigManager();
      const botConfig = config.getBotConfig("dev-bot");

      expect(botConfig).not.toBeNull();
      expect(botConfig!.name).toBe("dev-bot");
      expect(botConfig!.appId).toBe("app_dev_123");
      expect(botConfig!.appSecret).toBe("secret_dev");
      expect(botConfig!.backend).toBe("claude");
      expect(botConfig!.cwd).toBe("/tmp/dev");
    });

    test("returns null for unknown bot", () => {
      const config = new FileConfigManager();
      const botConfig = config.getBotConfig("unknown-bot");
      expect(botConfig).toBeNull();
    });

    test("returns bot with activeModel from global config", () => {
      const config = new FileConfigManager();
      const botConfig = config.getBotConfig("dev-bot");
      expect(botConfig!.activeModel).toBe("claude-sonnet-4-20250514");
    });

    test("returns bot with modelAliases from global config", () => {
      const config = new FileConfigManager();
      const botConfig = config.getBotConfig("qa-bot");
      expect(botConfig!.modelAliases).toEqual({
        fast: "gpt-4o",
        smart: "claude-sonnet-4-20250514",
      });
    });

    test("bot without cwd has undefined cwd", () => {
      const config = new FileConfigManager();
      const botConfig = config.getBotConfig("qa-bot");
      expect(botConfig!.cwd).toBeUndefined();
    });
  });

  describe("getProviderConfig", () => {
    test("returns provider config for known provider", () => {
      const config = new FileConfigManager();
      const prov = config.getProviderConfig("anthropic");

      expect(prov).not.toBeNull();
      expect(prov!.baseUrl).toBe("https://api.anthropic.com");
      expect(prov!.format).toBe("anthropic");
    });

    test("returns provider config from providers.json", () => {
      const config = new FileConfigManager();
      const prov = config.getProviderConfig("deepseek");

      expect(prov).not.toBeNull();
      expect(prov!.baseUrl).toBe("https://api.deepseek.com");
      expect(prov!.format).toBe("openai");
    });

    test("returns null for unknown provider", () => {
      const config = new FileConfigManager();
      const prov = config.getProviderConfig("nonexistent");
      expect(prov).toBeNull();
    });
  });

  describe("getActiveModel", () => {
    test("returns activeModel when set", () => {
      const config = new FileConfigManager();
      expect(config.getActiveModel()).toBe("claude-sonnet-4-20250514");
    });

    test("falls back to defaultModel when activeModel is not set", () => {
      // Create a config without activeModel
      const tempDir2 = path.join(TEMP_BASE, "config-fallback");
      fs.mkdirSync(tempDir2, { recursive: true });
      fs.writeFileSync(
        path.join(tempDir2, "config.json"),
        JSON.stringify({ defaultModel: "gpt-4o" })
      );

      const origHome = process.env.IMTOAGENT_HOME;
      process.env.IMTOAGENT_HOME = tempDir2;
      resetPathCache();

      const config = new FileConfigManager();
      expect(config.getActiveModel()).toBe("gpt-4o");

      process.env.IMTOAGENT_HOME = origHome;
      resetPathCache();
    });

    test("falls back to hardcoded default when nothing is set", () => {
      const tempDir3 = path.join(TEMP_BASE, "config-default");
      fs.mkdirSync(tempDir3, { recursive: true });
      fs.writeFileSync(path.join(tempDir3, "config.json"), JSON.stringify({}));

      const origHome = process.env.IMTOAGENT_HOME;
      process.env.IMTOAGENT_HOME = tempDir3;
      resetPathCache();

      const config = new FileConfigManager();
      expect(config.getActiveModel()).toBe("deepseek/deepseek-v4-pro");

      process.env.IMTOAGENT_HOME = origHome;
      resetPathCache();
    });
  });

  describe("resolveModel", () => {
    test("resolves alias to actual model", () => {
      const config = new FileConfigManager();
      expect(config.resolveModel("fast")).toBe("gpt-4o");
      expect(config.resolveModel("smart")).toBe("claude-sonnet-4-20250514");
    });

    test("returns provider/model format as-is", () => {
      const config = new FileConfigManager();
      expect(config.resolveModel("openai/gpt-4o")).toBe("openai/gpt-4o");
      expect(config.resolveModel("anthropic/claude-3-opus")).toBe(
        "anthropic/claude-3-opus"
      );
    });

    test("resolves bare model name from provider config", () => {
      const config = new FileConfigManager();
      // "gpt-4o" matches openai provider's model
      const resolved = config.resolveModel("gpt-4o");
      expect(resolved).toContain("gpt-4o");
      // Should either be "openai/gpt-4o" or the original if not aliased
      // Actually since gpt-4o is not an alias, and it matches openai models,
      // it should return "openai/gpt-4o"
      expect(resolved).toBe("openai/gpt-4o");
    });

    test("falls back to activeModel for unknown bare model", () => {
      const config = new FileConfigManager();
      const resolved = config.resolveModel("totally-unknown-model");
      expect(resolved).toBe("claude-sonnet-4-20250514");
    });

    test("alias takes priority over provider matching", () => {
      const config = new FileConfigManager();
      // "fast" is aliased to gpt-4o, which also matches openai
      // alias should win
      expect(config.resolveModel("fast")).toBe("gpt-4o");
    });
  });
});
