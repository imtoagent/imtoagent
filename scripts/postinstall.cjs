#!/usr/bin/env node
// ================================================================
// postinstall.cjs — npm 安装后引导
// ================================================================
// 参考 OpenClaw 的设计：postinstall 只做技术性维护，不做交互。
// 交互式配置由用户运行 `imtoagent setup` 或 `imtoagent` 触发。
// ================================================================

"use strict";

const fs = require("fs");
const path = require("path");

const HOME = process.env.HOME || process.env.USERPROFILE || "";
const DATA_DIR = path.join(HOME, ".imtoagent");

try {
  const configExists = fs.existsSync(path.join(DATA_DIR, "config.json"));

  if (configExists) {
    console.log("");
    console.log("✅  imtoagent upgraded successfully!");
    console.log("");
    console.log("   Data directory: " + DATA_DIR);
    console.log("   Configuration file kept as-is, no need to reconfigure.");
    console.log('   Run "imtoagent start" to start the gateway.');
    console.log("");
  } else {
    console.log("");
    console.log("🎉  imtoagent installed successfully!");
    console.log("");
    console.log("   For first-time use, run the following commands to complete initial setup:");
    console.log("");
    console.log('     imtoagent setup      # Interactive configuration wizard');
    console.log('     imtoagent            # Auto-detects when run with no command; enters wizard if not configured');
    console.log("");
    console.log("   After configuration, start the gateway:");
    console.log("");
    console.log("     imtoagent start");
    console.log("");
    console.log("   Tip: configure your API provider:");
    console.log("");
    console.log("     imtoagent providers presets   # List available provider presets");
    console.log("     imtoagent providers add --preset <name> --key <api-key>");
    console.log("");
  }
} catch (e) {
  // Silently fail, do not affect installation
}

// ================================================================
// Install Agent Skills to ~/.agents/skills/imtoagent/
// ================================================================

try {
  const SKILLS_DIR = path.join(__dirname, "..", "skills", "imtoagent");
  const AGENTS_SKILLS = path.join(HOME, ".agents", "skills");
  const DEST = path.join(AGENTS_SKILLS, "imtoagent");

  if (fs.existsSync(SKILLS_DIR)) {
    if (!fs.existsSync(AGENTS_SKILLS)) {
      fs.mkdirSync(AGENTS_SKILLS, { recursive: true });
    }

    function copyRecursive(src, dest) {
      const stat = fs.statSync(src);
      if (stat.isDirectory()) {
        if (!fs.existsSync(dest)) fs.mkdirSync(dest, { recursive: true });
        for (const entry of fs.readdirSync(src)) {
          copyRecursive(path.join(src, entry), path.join(dest, entry));
        }
      } else {
        fs.copyFileSync(src, dest);
      }
    }

    copyRecursive(SKILLS_DIR, DEST);
    console.log("   Agent skills installed to: " + DEST);
  }
} catch (e) {
  // Silently fail — skill install is best-effort
}

// ================================================================
// Copy Example Templates to ~/.imtoagent/ (first install only)
// ================================================================

try {
  const PKG_DIR = path.join(__dirname, "..");

  function copyRecursive(src, dest) {
    const stat = fs.statSync(src);
    if (stat.isDirectory()) {
      if (!fs.existsSync(dest)) fs.mkdirSync(dest, { recursive: true });
      for (const entry of fs.readdirSync(src)) {
        copyRecursive(path.join(src, entry), path.join(dest, entry));
      }
    } else {
      fs.copyFileSync(src, dest);
    }
  }

  // tools/EXAMPLE.ts → ~/.imtoagent/tools/EXAMPLE.ts
  const toolTemplate = path.join(PKG_DIR, "tools", "EXAMPLE.ts");
  if (fs.existsSync(toolTemplate)) {
    const destDir = path.join(DATA_DIR, "tools");
    const dest = path.join(destDir, "EXAMPLE.ts");
    if (!fs.existsSync(dest)) {
      fs.mkdirSync(destDir, { recursive: true });
      copyRecursive(toolTemplate, dest);
    }
  }

  // skills/_TEMPLATE/ → ~/.imtoagent/skills/EXAMPLE/
  const skillTemplateDir = path.join(PKG_DIR, "skills", "_TEMPLATE");
  if (fs.existsSync(skillTemplateDir)) {
    const destDir = path.join(DATA_DIR, "skills", "EXAMPLE");
    if (!fs.existsSync(destDir)) {
      copyRecursive(skillTemplateDir, destDir);
    }
  }

  // hooks/EXAMPLE.ts → ~/.imtoagent/hooks/EXAMPLE.ts
  const hookTemplate = path.join(PKG_DIR, "hooks", "EXAMPLE.ts");
  if (fs.existsSync(hookTemplate)) {
    const destDir = path.join(DATA_DIR, "hooks");
    const dest = path.join(destDir, "EXAMPLE.ts");
    if (!fs.existsSync(dest)) {
      fs.mkdirSync(destDir, { recursive: true });
      copyRecursive(hookTemplate, dest);
    }
  }
} catch (e) {
  // Silently fail — template copy is best-effort
}
