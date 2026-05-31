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
