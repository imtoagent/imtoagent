// ================================================================
// Tool Discovery — 自动发现并注册工具
// ================================================================

import * as fs from 'fs';
import * as path from 'path';
import type { ToolDefinition } from '../agent/tool-registry';



export interface DiscoveredTool {
  name: string;
  definition: ToolDefinition;
  sourceFile: string;
  sourceType: 'single' | 'factory' | 'directory';
}

export interface ToolLoadContext {
  deps?: Record<string, unknown>;
}

export async function discoverTools(
  dirs: string[],
  context?: ToolLoadContext,
): Promise<DiscoveredTool[]> {
  const discovered: DiscoveredTool[] = [];

  for (const dir of dirs) {
    if (!fs.existsSync(dir)) continue;

    const entries = fs.readdirSync(dir, { withFileTypes: true });

    for (const entry of entries) {
      const entryPath = path.join(dir, entry.name);

      // 目录工厂（形态 3）
      if (entry.isDirectory()) {
        const indexPath = path.join(entryPath, 'index.ts');
        if (fs.existsSync(indexPath)) {
          const tools = await loadDirectoryFactory(entryPath, indexPath, entry.name, context);
          discovered.push(...tools);
        }
        continue;
      }

      // 跳过非 .ts 和辅助文件
      if (!entry.name.endsWith('.ts')) continue;
      if (entry.name.startsWith('_') || entry.name.includes('.test.') || entry.name === 'EXAMPLE.ts') continue;

      try {
        const mod = await import(`file://${entryPath}`);
        const tools = classifyAndLoad(entry.name, mod, entryPath, context);
        discovered.push(...tools);
      } catch (err) {
        console.error(`[ToolDiscovery] ❌ ${entry.name}: ${(err as Error).message}`);
      }
    }
  }

  return discovered;
}

function classifyAndLoad(
  fileName: string,
  mod: Record<string, unknown>,
  filePath: string,
  context?: ToolLoadContext,
): DiscoveredTool[] {
  const factoryFn = findFactoryFunction(mod);
  if (factoryFn) {
    const tools = callFactory(factoryFn, context?.deps, fileName);
    return tools.map(t => ({
      name: t.name,
      definition: t,
      sourceFile: filePath,
      sourceType: 'factory' as const,
    }));
  }

  const def = findToolDefinition(mod);
  if (def) {
    return [{
      name: def.name,
      definition: def,
      sourceFile: filePath,
      sourceType: 'single' as const,
    }];
  }

  console.warn(`[ToolDiscovery] ⚠️  ${fileName}: 未识别的工具形态`);
  return [];
}

function findFactoryFunction(mod: Record<string, unknown>): Function | null {
  if (typeof mod.default === 'function') return mod.default;

  for (const [key, val] of Object.entries(mod)) {
    if (key === 'default') continue;
    if (typeof val === 'function' && (
      key.startsWith('create') || key.startsWith('init') || key.startsWith('register')
    )) {
      return val;
    }
  }

  return null;
}

function findToolDefinition(mod: Record<string, unknown>): ToolDefinition | null {
  if (isToolDefinition(mod.default)) return mod.default;

  for (const [key, val] of Object.entries(mod)) {
    if (key === 'default') continue;
    if (isToolDefinition(val)) return val;
  }

  return null;
}

function callFactory(
  fn: Function,
  deps?: Record<string, unknown>,
  fileName?: string,
): ToolDefinition[] {
  const paramCount = fn.length;
  let result: unknown;

  if (paramCount > 0 && deps) {
    const args = buildFactoryArgs(fn, deps, fileName);
    result = fn(...args);
  } else {
    result = fn();
  }

  if (!Array.isArray(result)) {
    console.warn(`[ToolDiscovery] ⚠️  工厂函数返回值不是数组`);
    return [];
  }

  return result.filter(isToolDefinition);
}

async function loadDirectoryFactory(
  dirPath: string,
  indexPath: string,
  dirName: string,
  context?: ToolLoadContext,
): Promise<DiscoveredTool[]> {
  try {
    const mod = await import(`file://${indexPath}`);
    const factoryFn = findFactoryFunction(mod);

    if (factoryFn) {
      const tools = callFactory(factoryFn, context?.deps, dirName);
      return tools.map(t => ({
        name: t.name,
        definition: t,
        sourceFile: indexPath,
        sourceType: 'directory' as const,
      }));
    }

    const tools: DiscoveredTool[] = [];
    for (const file of fs.readdirSync(dirPath).filter(f => f.endsWith('.ts') && f !== 'index.ts' && f !== 'EXAMPLE.ts')) {
      const fileMod = await import(`file://${path.join(dirPath, file)}`);
      const def = findToolDefinition(fileMod);
      if (def) {
        tools.push({
          name: def.name,
          definition: def,
          sourceFile: path.join(dirPath, file),
          sourceType: 'directory' as const,
        });
      }
    }
    return tools;
  } catch (err) {
    console.error(`[ToolDiscovery] ❌ 目录工厂 ${dirName}: ${(err as Error).message}`);
    return [];
  }
}

function buildFactoryArgs(fn: Function, deps: Record<string, unknown>, fileName?: string): unknown[] {
  const paramNames = getParamNames(fn);
  return paramNames.map(name => {
    if (deps[name]) return deps[name];
    console.warn(`[ToolDiscovery] ⚠️  ${fileName}: 依赖 "${name}" 未注入`);
    return undefined;
  });
}

function getParamNames(fn: Function): string[] {
  const str = fn.toString();
  const match = str.match(/\(([^)]*)\)/);
  if (!match || !match[1].trim()) return [];
  return match[1].split(',').map(p => {
    const cleaned = p.trim().replace(/:.*$/, '').replace(/[{}]/g, '').trim();
    return cleaned;
  }).filter(Boolean);
}

function isToolDefinition(obj: unknown): obj is ToolDefinition {
  if (!obj || typeof obj !== 'object') return false;
  const t = obj as Record<string, unknown>;
  return typeof t.name === 'string' && typeof t.handler === 'function';
}
