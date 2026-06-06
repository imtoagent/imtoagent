// ================================================================
// ToolRegistry 单元测试
// ================================================================

import { describe, test, expect, beforeEach } from 'vitest';
import { ToolRegistry, type ToolDefinition } from '../modules/agent/tool-registry';

// ================================================================
// 测试辅助
// ================================================================

function makeTool(name: string, handlerOverride?: (params: Record<string, unknown>) => Promise<unknown>): ToolDefinition {
  return {
    name,
    description: `Test tool: ${name}`,
    parameters: {
      type: 'object',
      properties: {
        input: { type: 'string', description: 'Input value' },
      },
      required: [],
    },
    handler: handlerOverride || (async (params) => ({ tool: name, params })),
  };
}

describe('ToolRegistry - 注册/注销', () => {
  let registry: ToolRegistry;

  beforeEach(() => {
    registry = new ToolRegistry();
  });

  test('注册单个工具', () => {
    registry.register(makeTool('weather'));
    expect(registry.list()).toEqual(['weather']);
  });

  test('注册多个工具', () => {
    registry.register(makeTool('weather'));
    registry.register(makeTool('calendar'));
    registry.register(makeTool('email'));
    expect(registry.list().sort()).toEqual(['calendar', 'email', 'weather'].sort());
  });

  test('重复注册覆盖', () => {
    registry.register(makeTool('test'));
    registry.register(makeTool('test')); // 覆盖
    expect(registry.list()).toEqual(['test']);
  });

  test('注销存在的工具', () => {
    registry.register(makeTool('weather'));
    const removed = registry.unregister('weather');
    expect(removed).toBe(true);
    expect(registry.list()).toEqual([]);
  });

  test('注销不存在的工具返回 false', () => {
    const removed = registry.unregister('nonexistent');
    expect(removed).toBe(false);
  });

  test('注销同时移除注入状态', () => {
    registry.register(makeTool('weather'));
    registry.injectNeeded(['weather']);
    expect(registry.isInjected('weather')).toBe(true);
    registry.unregister('weather');
    expect(registry.isInjected('weather')).toBe(false);
  });
});

describe('ToolRegistry - 注入/移除', () => {
  let registry: ToolRegistry;

  beforeEach(() => {
    registry = new ToolRegistry();
    registry.register(makeTool('weather'));
    registry.register(makeTool('calendar'));
    registry.register(makeTool('email'));
  });

  test('注入单个工具', () => {
    const injected = registry.injectNeeded(['weather']);
    expect(injected).toEqual(['weather']);
    expect(registry.listInjected()).toEqual(['weather']);
  });

  test('注入多个工具', () => {
    const injected = registry.injectNeeded(['weather', 'calendar']);
    expect(injected.sort()).toEqual(['calendar', 'weather'].sort());
    expect(registry.listInjected().sort()).toEqual(['calendar', 'weather'].sort());
  });

  test('注入不存在的工具被忽略', () => {
    const injected = registry.injectNeeded(['weather', 'nonexistent']);
    expect(injected).toEqual(['weather']);
  });

  test('重复注入返回空列表', () => {
    registry.injectNeeded(['weather']);
    const second = registry.injectNeeded(['weather']);
    expect(second).toEqual([]);
  });

  test('移除单个注入', () => {
    registry.injectNeeded(['weather', 'calendar']);
    registry.removeInjected(['weather']);
    expect(registry.listInjected()).toEqual(['calendar']);
  });

  test('移除所有注入', () => {
    registry.injectNeeded(['weather', 'calendar', 'email']);
    registry.clearInjected();
    expect(registry.listInjected()).toEqual([]);
    // 但注册表不变
    expect(registry.list().sort()).toEqual(['calendar', 'email', 'weather'].sort());
  });

  test('注册 ≠ 注入：新注册工具不会自动注入', () => {
    registry = new ToolRegistry();
    registry.register(makeTool('weather'));
    expect(registry.list()).toEqual(['weather']);
    expect(registry.listInjected()).toEqual([]);
    expect(registry.getOpenAIFormat()).toEqual([]);
  });
});

describe('ToolRegistry - OpenAI 格式', () => {
  let registry: ToolRegistry;

  beforeEach(() => {
    registry = new ToolRegistry();
  });

  test('空注入返回空数组', () => {
    registry.register(makeTool('weather'));
    expect(registry.getOpenAIFormat()).toEqual([]);
  });

  test('只返回已注入的工具', () => {
    registry.register(makeTool('weather'));
    registry.register(makeTool('calendar'));
    registry.injectNeeded(['weather']);

    const tools = registry.getOpenAIFormat();
    expect(tools.length).toBe(1);
    expect((tools[0] as any).function.name).toBe('weather');
  });

  test('注入后正确生成 OpenAI 格式', () => {
    registry.register(makeTool('weather'));
    registry.injectNeeded(['weather']);

    const tools = registry.getOpenAIFormat();
    expect(tools).toEqual([
      {
        type: 'function',
        function: {
          name: 'weather',
          description: 'Test tool: weather',
          parameters: {
            type: 'object',
            properties: { input: { type: 'string', description: 'Input value' } },
            required: [],
          },
        },
      },
    ]);
  });
});

describe('ToolRegistry - 执行', () => {
  let registry: ToolRegistry;

  beforeEach(() => {
    registry = new ToolRegistry();
  });

  test('执行已注入的工具', async () => {
    registry.register(makeTool('weather'));
    registry.injectNeeded(['weather']);

    const result = await registry.execute('weather', { input: '北京' });
    expect(result).toEqual({ tool: 'weather', params: { input: '北京' } });
  });

  test('执行未注册的工具抛错', async () => {
    await expect(registry.execute('nonexistent', {})).rejects.toThrow(
      'Tool "nonexistent" not found in registry',
    );
  });

  test('执行未注入的工具抛错', async () => {
    registry.register(makeTool('weather'));
    await expect(registry.execute('weather', {})).rejects.toThrow(
      'Tool "weather" is not injected into current session',
    );
  });

  test('handler 返回自定义结果', async () => {
    registry.register(makeTool('custom', async () => ({ custom: true, value: 42 })));
    registry.injectNeeded(['custom']);

    const result = await registry.execute('custom', {});
    expect(result).toEqual({ custom: true, value: 42 });
  });
});

describe('ToolRegistry - 查询', () => {
  let registry: ToolRegistry;

  beforeEach(() => {
    registry = new ToolRegistry();
    registry.register(makeTool('weather'));
    registry.register(makeTool('calendar'));
  });

  test('isRegistered 正确判断', () => {
    expect(registry.isRegistered('weather')).toBe(true);
    expect(registry.isRegistered('nonexistent')).toBe(false);
  });

  test('isInjected 正确判断', () => {
    expect(registry.isInjected('weather')).toBe(false);
    registry.injectNeeded(['weather']);
    expect(registry.isInjected('weather')).toBe(true);
    expect(registry.isInjected('calendar')).toBe(false);
  });

  test('getInjected 返回已注入的工具定义', () => {
    registry.injectNeeded(['weather']);
    const injected = registry.getInjected();
    expect(injected.length).toBe(1);
    expect(injected[0].name).toBe('weather');
  });
});

describe('ToolRegistry - 典型使用场景', () => {
  test('注入 → 执行 → 清理 的完整流程', async () => {
    const registry = new ToolRegistry();
    registry.register(makeTool('weather'));
    registry.register(makeTool('calendar'));

    // 正常聊天：无工具注入
    expect(registry.getOpenAIFormat()).toEqual([]);

    // Goal 执行：临时注入天气工具
    const injected = registry.injectNeeded(['weather']);
    expect(injected).toEqual(['weather']);
    expect(registry.getOpenAIFormat().length).toBe(1);

    // 执行工具
    const result = await registry.execute('weather', { input: '北京' });
    expect(result).toBeDefined();

    // finally 清理
    registry.removeInjected(injected);
    expect(registry.listInjected()).toEqual([]);
    expect(registry.getOpenAIFormat()).toEqual([]);

    // 注册表仍然存在
    expect(registry.list().sort()).toEqual(['calendar', 'weather'].sort());
  });
});
