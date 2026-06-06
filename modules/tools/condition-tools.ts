// ================================================================
// Condition Evaluation Tools
// ================================================================
// 供 GoalEngine 按 condition.type 自动注入的工具集。
// Agent 收集数据后自行判断条件是否满足。
// ================================================================

import type { ToolDefinition } from "../agent/tool-registry";

// ================================================================
// http_check — HTTP 状态检查
// ================================================================
export const httpCheckTool: ToolDefinition = {
  name: "http_check",
  description: "Check HTTP endpoint status. Returns status code, response time, and optional body snippet.",
  parameters: {
    type: "object",
    properties: {
      url: { type: "string", description: "URL to check" },
      method: { type: "string", description: "HTTP method: GET, POST, HEAD (default GET)" },
      timeout: { type: "number", description: "Timeout in seconds (default 10)" },
      expectStatus: { type: "number", description: "Expected status code (default 200)" },
    },
    required: ["url"],
  },
  handler: async (params) => {
    const url = params.url as string;
    const method = (params.method as string) || "GET";
    const timeout = ((params.timeout as number) || 10) * 1000;
    const expectStatus = (params.expectStatus as number) || 200;

    try {
      const start = Date.now();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeout);

      const resp = await fetch(url, { method, signal: controller.signal });
      clearTimeout(timer);
      const duration = Date.now() - start;

      const bodySnippet = await resp.text().then(t => t.slice(0, 500)).catch(() => "");

      return {
        success: true,
        url,
        status: resp.status,
        statusText: resp.statusText,
        expected: expectStatus,
        matched: resp.status === expectStatus,
        durationMs: duration,
        bodySnippet,
      };
    } catch (e: unknown) {
      return { success: false, url, error: (e as Error).message };
    }
  },
};

// ================================================================
// get_system_metrics — 系统指标检查
// ================================================================
export const systemMetricsTool: ToolDefinition = {
  name: "get_system_metrics",
  description: "Get system metrics: CPU usage, memory, disk space, load average.",
  parameters: {
    type: "object",
    properties: {
      metrics: {
        type: "string",
        description: "Comma-separated metrics to check: cpu, memory, disk, load (default: all)",
      },
    },
    required: [],
  },
  handler: async (params) => {
    const metrics = ((params.metrics as string) || "cpu,memory,disk,load").split(",").map(s => s.trim());
    const result: Record<string, unknown> = {};

    try {
      const { execSync } = await import("child_process");

      if (metrics.includes("cpu")) {
        const cpuInfo = execSync("top -l 1 -n 0 | grep 'CPU usage'", { encoding: "utf-8", timeout: 5000 }).trim();
        result.cpu = cpuInfo;
      }

      if (metrics.includes("memory")) {
        const memInfo = execSync("vm_stat | head -5", { encoding: "utf-8", timeout: 5000 }).trim();
        result.memory = memInfo;
      }

      if (metrics.includes("disk")) {
        const diskInfo = execSync("df -h / | tail -1", { encoding: "utf-8", timeout: 5000 }).trim();
        result.disk = diskInfo;
      }

      if (metrics.includes("load")) {
        const loadInfo = execSync("sysctl -n vm.loadavg", { encoding: "utf-8", timeout: 5000 }).trim();
        result.load = loadInfo;
      }

      return { success: true, ...result };
    } catch (e: unknown) {
      return { success: false, error: (e as Error).message };
    }
  },
};

// ================================================================
// check_file — 文件存在检查
// ================================================================
export const checkFileTool: ToolDefinition = {
  name: "check_file",
  description: "Check if a file exists and get its metadata (size, modified time).",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "File path to check" },
      maxAgeMinutes: { type: "number", description: "Max age in minutes (file must be modified within this time)" },
    },
    required: ["path"],
  },
  handler: async (params) => {
    try {
      const fs = await import("fs");
      const filePath = params.path as string;

      if (!fs.existsSync(filePath)) {
        return { success: true, exists: false, path: filePath };
      }

      const stat = fs.statSync(filePath);
      const ageMinutes = (Date.now() - stat.mtimeMs) / 60000;
      const maxAge = params.maxAgeMinutes as number | undefined;

      return {
        success: true,
        exists: true,
        path: filePath,
        size: stat.size,
        modified: stat.mtime.toISOString(),
        ageMinutes: Math.round(ageMinutes),
        withinMaxAge: maxAge ? ageMinutes <= maxAge : undefined,
      };
    } catch (e: unknown) {
      return { success: false, error: (e as Error).message };
    }
  },
};

// ================================================================
// check_url — URL 可达性检查
// ================================================================
export const checkUrlTool: ToolDefinition = {
  name: "check_url",
  description: "Check if a URL is reachable. Returns status code and response time.",
  parameters: {
    type: "object",
    properties: {
      url: { type: "string", description: "URL to check" },
      timeout: { type: "number", description: "Timeout in seconds (default 10)" },
    },
    required: ["url"],
  },
  handler: async (params) => {
    const url = params.url as string;
    const timeout = ((params.timeout as number) || 10) * 1000;

    try {
      const start = Date.now();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeout);

      const resp = await fetch(url, { method: "HEAD", signal: controller.signal });
      clearTimeout(timer);
      const duration = Date.now() - start;

      return {
        success: true,
        url,
        reachable: resp.ok,
        status: resp.status,
        durationMs: duration,
      };
    } catch (e: unknown) {
      return { success: false, url, reachable: false, error: (e as Error).message };
    }
  },
};

// ================================================================
// 工具映射表 — condition.type → 所需工具
// ================================================================
export const CONDITION_TOOLS: ToolDefinition[] = [
  httpCheckTool,
  systemMetricsTool,
  checkFileTool,
  checkUrlTool,
];

export const CONDITION_TOOL_MAP: Record<string, string[]> = {
  weather: ["get_weather"],
  system_metric: ["get_system_metrics"],
  api_check: ["http_check"],
  external_state: ["check_file", "check_url"],
  none: [],
};
