/**
 * workspace-manager.test.ts
 *
 * Tests for:
 *   - parseWorkspaceConfig defaults (no config → sandbox)
 *   - parseWorkspaceConfig global mode
 *   - WorkspaceManager.getWorkspacePath sandbox mode
 *   - WorkspaceManager.isPathAllowed
 */

import { describe, it, expect } from 'vitest';
import { parseWorkspaceConfig, WorkspaceManager } from "../modules/utils/workspace-manager";
import { getDataDir } from "../modules/utils/paths";
import * as path from "path";

// ================================================================
// 1. parseWorkspaceConfig — defaults
// ================================================================

describe("parseWorkspaceConfig defaults", () => {
  it("should default to sandbox mode when no workspace config", () => {
    const result = parseWorkspaceConfig({});
    expect(result.mode).toBe("sandbox");
    expect(result.globalPath).toBeNull();
    expect(result.botOverrides).toEqual({});
  });

  it("should default to sandbox when workspace key missing", () => {
    const result = parseWorkspaceConfig({ bots: [] });
    expect(result.mode).toBe("sandbox");
    expect(result.globalPath).toBeNull();
  });

  it("should default to sandbox when workspace.mode is not 'global'", () => {
    const result = parseWorkspaceConfig({
      workspace: { mode: "sandbox" },
    });
    expect(result.mode).toBe("sandbox");
  });

  it("should handle null/undefined input", () => {
    const result = parseWorkspaceConfig(null);
    expect(result.mode).toBe("sandbox");
    expect(result.globalPath).toBeNull();
  });

  it("should handle undefined input", () => {
    const result = parseWorkspaceConfig(undefined);
    expect(result.mode).toBe("sandbox");
    expect(result.globalPath).toBeNull();
  });
});

// ================================================================
// 2. parseWorkspaceConfig — global mode
// ================================================================

describe("parseWorkspaceConfig global mode", () => {
  it("should parse global mode with globalPath", () => {
    const result = parseWorkspaceConfig({
      workspace: {
        mode: "global",
        globalPath: "/shared/workspace",
      },
    });
    expect(result.mode).toBe("global");
    expect(result.globalPath).toBe("/shared/workspace");
  });

  it("should parse global mode without globalPath", () => {
    const result = parseWorkspaceConfig({
      workspace: { mode: "global" },
    });
    expect(result.mode).toBe("global");
    expect(result.globalPath).toBeNull();
  });

  it("should parse botOverrides", () => {
    const result = parseWorkspaceConfig({
      workspace: {
        mode: "sandbox",
        botOverrides: {
          BotA: "/custom/path/a",
          BotB: "/custom/path/b",
        },
      },
    });
    expect(result.botOverrides["BotA"]).toBe("/custom/path/a");
    expect(result.botOverrides["BotB"]).toBe("/custom/path/b");
  });

  it("should ignore non-string values in botOverrides", () => {
    const result = parseWorkspaceConfig({
      workspace: {
        botOverrides: {
          BotA: "/valid",
          BotB: 123,
          BotC: null,
        },
      },
    });
    expect(result.botOverrides["BotA"]).toBe("/valid");
    expect(result.botOverrides["BotB"]).toBeUndefined();
    expect(result.botOverrides["BotC"]).toBeUndefined();
  });
});

// ================================================================
// 3. WorkspaceManager.getWorkspacePath — sandbox mode
// ================================================================

describe("WorkspaceManager.getWorkspacePath (sandbox)", () => {
  it("should return workspaces/<UUID> path for a bot", () => {
    const config = parseWorkspaceConfig({});
    const manager = new WorkspaceManager(config);
    const wsPath = manager.getWorkspacePath("TestBot");

    // Should be under workspaces directory
    expect(wsPath).toContain("workspaces");
    expect(wsPath).not.toContain("TestBot"); // uses UUID, not name
  });

  it("should return same path for same bot key (UUID persists)", () => {
    const config = parseWorkspaceConfig({});
    const manager = new WorkspaceManager(config);
    const path1 = manager.getWorkspacePath("Bot1");
    const path2 = manager.getWorkspacePath("Bot1");
    expect(path1).toBe(path2);
  });

  it("should return different paths for different bot keys", () => {
    const config = parseWorkspaceConfig({});
    const manager = new WorkspaceManager(config);
    const pathA = manager.getWorkspacePath("BotA");
    const pathB = manager.getWorkspacePath("BotB");
    expect(pathA).not.toBe(pathB);
  });

  it("should use botOverride when set", () => {
    const config = parseWorkspaceConfig({
      workspace: {
        botOverrides: { MyBot: "/custom/ws" },
      },
    });
    const manager = new WorkspaceManager(config);
    const wsPath = manager.getWorkspacePath("MyBot");
    expect(wsPath).toBe(path.resolve("/custom/ws"));
  });
});

// ================================================================
// 4. WorkspaceManager.isPathAllowed
// ================================================================

describe("WorkspaceManager.isPathAllowed", () => {
  it("should allow paths within workspace (sandbox mode)", () => {
    const config = parseWorkspaceConfig({});
    const manager = new WorkspaceManager(config);
    const wsPath = manager.getWorkspacePath("TestBot");

    // Workspace root itself
    expect(manager.isPathAllowed("TestBot", wsPath)).toBe(true);
    // File inside workspace
    expect(manager.isPathAllowed("TestBot", path.join(wsPath, "notes.md"))).toBe(true);
    // Deep subdirectory
    expect(
      manager.isPathAllowed("TestBot", path.join(wsPath, "projects", "src", "index.ts")),
    ).toBe(true);
  });

  it("should reject paths outside workspace (sandbox mode)", () => {
    const config = parseWorkspaceConfig({});
    const manager = new WorkspaceManager(config);

    // Home directory
    expect(manager.isPathAllowed("TestBot", process.env.HOME!)).toBe(false);
    // Another workspace
    expect(manager.isPathAllowed("TestBot", manager.getWorkspacePath("OtherBot"))).toBe(false);
    // System paths
    expect(manager.isPathAllowed("TestBot", "/etc/passwd")).toBe(false);
  });

  it("should reject ~/.imtoagent/ config paths (sandbox mode)", () => {
    const config = parseWorkspaceConfig({});
    const manager = new WorkspaceManager(config);

    // Config file itself
    const home = process.env.HOME!;
    expect(manager.isPathAllowed("TestBot", path.join(home, ".imtoagent", "config.json"))).toBe(
      false,
    );
    expect(manager.isPathAllowed("TestBot", path.join(home, ".imtoagent", "providers.json"))).toBe(
      false,
    );
  });

  it("should allow all paths in global mode", () => {
    const config = parseWorkspaceConfig({
      workspace: {
        mode: "global",
        globalPath: "/shared/workspace",
      },
    });
    const manager = new WorkspaceManager(config);

    // Even outside the global path — global mode trusts user config
    expect(manager.isPathAllowed("AnyBot", "/some/other/path")).toBe(true);
    expect(manager.isPathAllowed("AnyBot", process.env.HOME!)).toBe(true);
  });

  it("should still reject ~/.imtoagent/ config paths in global mode", () => {
    const config = parseWorkspaceConfig({
      workspace: {
        mode: "global",
        globalPath: "/shared/workspace",
      },
    });
    const manager = new WorkspaceManager(config);

    // Use getDataDir() to get the actual data directory (respects IMTOAGENT_HOME in tests)
    const dataDir = getDataDir();
    expect(manager.isPathAllowed("AnyBot", path.join(dataDir, "config.json"))).toBe(
      false,
    );
    expect(manager.isPathAllowed("AnyBot", path.join(dataDir, "providers.json"))).toBe(
      false,
    );

    // But soul/ under data dir should be allowed in global mode
    expect(manager.isPathAllowed("AnyBot", path.join(dataDir, "soul"))).toBe(true);
  });
});
