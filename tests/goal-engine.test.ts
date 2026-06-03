// ================================================================
// GoalEngine 单元测试
// ================================================================

import { describe, test, expect, beforeEach, afterAll } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';
import {
  buildGoalPrompt,
  parseGoalResult,
  writeGoalHistory,
  GoalEngine,
} from '../modules/core/goal-engine';
import { GoalStore } from '../modules/core/goal-store';
import { createGoal, type Goal } from '../modules/core/goal-types';

// ================================================================
// 测试辅助
// ================================================================

const TEST_DIR = path.join(process.env.HOME ?? '~', '.imtoagent', 'test-engine');
const TEST_FILE = path.join(TEST_DIR, 'goals-engine-test.json');
const TEST_HISTORY = path.join(TEST_DIR, 'goals_history.json');

function makeGoal(overrides: Partial<Goal> = {}): Goal {
  const id = `goal_eng_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  return createGoal({
    ...overrides,
    id: overrides.id ?? id,
    type: overrides.type ?? 'reminder',
    trigger: overrides.trigger ?? { type: 'time', time: '13:00' },
    action: overrides.action ?? { type: 'send_message', content: 'test' },
    metadata: overrides.metadata ?? {
      createdBy: 'user_test',
      sourceChatId: 'oc_test',
      rawInput: '测试',
    },
  }) as Goal;
}

function mockAgent(reply: string, delayMs = 10) {
  return async (prompt: string) => {
    await new Promise(r => setTimeout(r, delayMs));
    return reply;
  };
}

function mockSendIM() {
  const messages: { chatId: string; text: string }[] = [];
  return {
    sendIM: async (chatId: string, text: string) => {
      messages.push({ chatId, text });
    },
    getMessages: () => [...messages],
  };
}

// ================================================================
// buildGoalPrompt
// ================================================================

describe('buildGoalPrompt', () => {
  test('无条件提醒的 prompt', () => {
    const goal = makeGoal({
      id: 'g1',
      type: 'reminder',
      trigger: { type: 'time', time: '09:00' },
      action: { type: 'send_message', content: '早上好！' },
      metadata: { createdBy: 'u1', sourceChatId: 'oc1', rawInput: '每天早上9点问好' },
    });

    const prompt = buildGoalPrompt(goal);

    expect(prompt).toContain('目标 ID: g1');
    expect(prompt).toContain('目标类型: reminder');
    expect(prompt).toContain('每天早上9点问好');
    expect(prompt).toContain('GOAL_DONE: g1');
    expect(prompt).toContain('GOAL_SKIP: g1');
    expect(prompt).toContain('GOAL_FAILED: g1');
    expect(prompt).toContain('发送消息: "早上好！"');
    expect(prompt).toContain('每天 09:00');
  });

  test('带天气条件的 prompt', () => {
    const goal = makeGoal({
      id: 'g2',
      type: 'conditional_reminder',
      trigger: { type: 'time', time: '12:50', leadMinutes: 10 },
      condition: {
        type: 'weather',
        params: { field: 'rain', location: '上海' },
        expected: true,
        operator: 'eq',
      },
      action: { type: 'send_message', content: '下雨了带伞！' },
      metadata: { createdBy: 'u1', sourceChatId: 'oc1', rawInput: '1点下雨提醒带伞' },
    });

    const prompt = buildGoalPrompt(goal);

    expect(prompt).toContain('判断条件');
    expect(prompt).toContain('weather');
    expect(prompt).toContain('下雨了带伞！');
    expect(prompt).toContain('提前 10 分钟');
  });

  test('Cron 触发器的 prompt', () => {
    const goal = makeGoal({
      id: 'g3',
      type: 'periodic_report',
      trigger: { type: 'cron', cron: '0 9 * * 1-5' },
      action: { type: 'send_message', content: '今日待办' },
      metadata: { createdBy: 'u1', sourceChatId: 'oc1', rawInput: '工作日9点发待办' },
    });

    const prompt = buildGoalPrompt(goal);
    expect(prompt).toContain('Cron: 0 9 * * 1-5');
  });

  test('工具链动作的 prompt', () => {
    const goal = makeGoal({
      id: 'g4',
      type: 'one_shot',
      trigger: { type: 'time', time: '15:00' },
      action: {
        type: 'tool_chain',
        chain: [
          { type: 'run_tool', tool: 'fetch_url', toolParams: { url: 'http://example.com' } },
          { type: 'send_message', content: '摘要' },
        ],
      },
      metadata: { createdBy: 'u1', sourceChatId: 'oc1', rawInput: '3点抓网页发摘要' },
    });

    const prompt = buildGoalPrompt(goal);
    expect(prompt).toContain('工具链: 2 步');
  });
});

// ================================================================
// parseGoalResult
// ================================================================

describe('parseGoalResult', () => {
  test('精确匹配 GOAL_DONE', () => {
    const r = parseGoalResult('任务已完成 GOAL_DONE: goal_abc123', 'goal_abc123');
    expect(r.action).toBe('done');
    expect(r.goalId).toBe('goal_abc123');
  });

  test('精确匹配 GOAL_SKIP', () => {
    const r = parseGoalResult('GOAL_SKIP: goal_abc123', 'goal_abc123');
    expect(r.action).toBe('skip');
  });

  test('精确匹配 GOAL_FAILED 带原因', () => {
    const r = parseGoalResult('出错了 GOAL_FAILED: goal_abc123 API超时', 'goal_abc123');
    expect(r.action).toBe('failed');
    expect(r.error).toBe('API超时');
  });

  test('精确匹配 GOAL_FAILED 无原因', () => {
    const r = parseGoalResult('GOAL_FAILED: goal_abc123', 'goal_abc123');
    expect(r.action).toBe('failed');
    expect(r.error).toBe('unknown');
  });

  test('忽略大小写', () => {
    const r = parseGoalResult('goal_done: goal_abc123', 'goal_abc123');
    expect(r.action).toBe('done');
  });

  test('无关回复返回 unknown', () => {
    const r = parseGoalResult('好的，我处理了', 'goal_abc123');
    expect(r.action).toBe('unknown');
  });

  test('回复中混有其他文字', () => {
    const r = parseGoalResult('天气检查完成，没下雨\nGOAL_SKIP: goal_x7', 'goal_x7');
    expect(r.action).toBe('skip');
  });

  test('多个 goal ID 只匹配目标', () => {
    const r = parseGoalResult('GOAL_DONE: goal_other\nGOAL_SKIP: goal_target', 'goal_target');
    expect(r.action).toBe('skip');
    expect(r.goalId).toBe('goal_target');
  });
});

// ================================================================
// writeGoalHistory
// ================================================================

describe('writeGoalHistory', () => {
  beforeEach(() => {
    if (fs.existsSync(TEST_HISTORY)) fs.unlinkSync(TEST_HISTORY);
    if (!fs.existsSync(TEST_DIR)) fs.mkdirSync(TEST_DIR, { recursive: true });
  });

  test('写入单条历史', () => {
    writeGoalHistory('goal_h1', 'done', 1500, undefined, TEST_DIR);

    expect(fs.existsSync(TEST_HISTORY)).toBe(true);
    const entries = JSON.parse(fs.readFileSync(TEST_HISTORY, 'utf-8'));
    expect(entries.length).toBe(1);
    expect(entries[0].goalId).toBe('goal_h1');
    expect(entries[0].action).toBe('done');
    expect(entries[0].durationMs).toBe(1500);
    expect(entries[0].runAt).toBeDefined();
  });

  test('写入错误记录', () => {
    writeGoalHistory('goal_h2', 'failed', 3000, 'timeout', TEST_DIR);

    const entries = JSON.parse(fs.readFileSync(TEST_HISTORY, 'utf-8'));
    expect(entries[0].error).toBe('timeout');
  });

  test('追加多条历史', () => {
    writeGoalHistory('goal_h3', 'done', 100, undefined, TEST_DIR);
    writeGoalHistory('goal_h4', 'skip', 200, undefined, TEST_DIR);
    writeGoalHistory('goal_h5', 'failed', 300, 'err', TEST_DIR);

    const entries = JSON.parse(fs.readFileSync(TEST_HISTORY, 'utf-8'));
    expect(entries.length).toBe(3);
  });

  test('超过 MAX_HISTORY 自动截断', () => {
    for (let i = 0; i < 110; i++) {
      writeGoalHistory(`goal_h_${i}`, 'done', 100, undefined, TEST_DIR);
    }

    const entries = JSON.parse(fs.readFileSync(TEST_HISTORY, 'utf-8'));
    expect(entries.length).toBe(100); // MAX_HISTORY
    // 保留最新的
    expect(entries[0].goalId).toBe('goal_h_10'); // 前10条被丢弃
  });
});

// ================================================================
// GoalEngine 集成测试
// ================================================================

describe('GoalEngine - 执行', () => {
  let store: GoalStore;
  let sentMessages: { chatId: string; text: string }[];

  function createEngine(agentReply: string, delayMs = 10) {
    const { sendIM, getMessages } = mockSendIM();
    sentMessages = getMessages();

    return new GoalEngine(store, {
      executeAgent: mockAgent(agentReply, delayMs),
      sendIM,
      workspaceDir: TEST_DIR,
      timeoutMs: 5000,
    });
  }

  beforeEach(() => {
    if (fs.existsSync(TEST_FILE)) fs.unlinkSync(TEST_FILE);
    store = new GoalStore(TEST_FILE);
  });

  afterAll(() => {
    try {
      if (fs.existsSync(TEST_FILE)) fs.unlinkSync(TEST_FILE);
      if (fs.existsSync(TEST_HISTORY)) fs.unlinkSync(TEST_HISTORY);
    } catch {}
  });

  test('无到期 Goal 返回空统计', async () => {
    const engine = createEngine('GOAL_DONE: g1');
    const stats = await engine.processDueGoals();
    expect(stats.dueCount).toBe(0);
    expect(stats.executedCount).toBe(0);
  });

  test('到期 Goal 成功执行', async () => {
    const now = new Date();
    const goal = makeGoal({ id: 'g_success' });
    goal.lifecycle.nextRunAt = new Date(now.getTime() - 60_000).toISOString();
    store.add(goal);

    const engine = createEngine(`任务完成 GOAL_DONE: g_success`);
    const stats = await engine.processDueGoals(now);

    expect(stats.dueCount).toBe(1);
    expect(stats.executedCount).toBe(1);
    expect(stats.doneCount).toBe(1);

    const updated = store.get('g_success')!;
    expect(updated.lifecycle.status).toBe('done');
  });

  test('到期 Goal 条件不满足被跳过', async () => {
    const now = new Date();
    const goal = makeGoal({ id: 'g_skip' });
    goal.lifecycle.nextRunAt = new Date(now.getTime() - 60_000).toISOString();
    store.add(goal);

    const engine = createEngine(`天气检查完成，没下雨 GOAL_SKIP: g_skip`);
    const stats = await engine.processDueGoals(now);

    expect(stats.skipCount).toBe(1);
    const updated = store.get('g_skip')!;
    // once 类型 skip 也视为 done
    expect(updated.lifecycle.status).toBe('done');
  });

  test('执行失败的 Goal 标记 failed', async () => {
    const now = new Date();
    const goal = makeGoal({ id: 'g_fail' });
    goal.lifecycle.nextRunAt = new Date(now.getTime() - 60_000).toISOString();
    store.add(goal);

    const engine = createEngine(`出错了 GOAL_FAILED: g_fail 网络异常`);
    const stats = await engine.processDueGoals(now);

    expect(stats.failedCount).toBe(1);
    const updated = store.get('g_fail')!;
    expect(updated.lifecycle.status).toBe('failed');
    expect(updated.lifecycle.lastError).toBe('网络异常');
  });

  test('无状态标记的回复标记为 failed', async () => {
    const now = new Date();
    const goal = makeGoal({ id: 'g_unknown' });
    goal.lifecycle.nextRunAt = new Date(now.getTime() - 60_000).toISOString();
    store.add(goal);

    const engine = createEngine(`好的，我处理了这个任务`);
    const stats = await engine.processDueGoals(now);

    expect(stats.unknownCount).toBe(1);
    const updated = store.get('g_unknown')!;
    expect(updated.lifecycle.status).toBe('failed');
  });

  test('send_message 类型 Goal 执行后发送 IM', async () => {
    const now = new Date();
    const goal = makeGoal({
      id: 'g_im',
      action: { type: 'send_message', content: '下雨了，带伞！☔', target: 'oc_target' },
    });
    goal.lifecycle.nextRunAt = new Date(now.getTime() - 60_000).toISOString();
    store.add(goal);

    const { sendIM, getMessages } = mockSendIM();
    const engine2 = new GoalEngine(store, {
      executeAgent: mockAgent('GOAL_DONE: g_im'),
      sendIM,
      workspaceDir: TEST_DIR,
    });
    await engine2.processDueGoals(now);

    const sent = getMessages();
    expect(sent.length).toBe(1);
    expect(sent[0].chatId).toBe('oc_target');
    expect(sent[0].text).toBe('下雨了，带伞！☔');
  });

  test('周期性 Goal 执行后 reschedule', async () => {
    const now = new Date();
    const goal = makeGoal({ id: 'g_repeat' });
    goal.lifecycle.repeat = 'daily';
    goal.trigger.time = '09:00';
    goal.lifecycle.nextRunAt = new Date(now.getTime() - 60_000).toISOString();
    store.add(goal);

    const engine = createEngine(`GOAL_DONE: g_repeat`);
    await engine.processDueGoals(now);

    const updated = store.get('g_repeat')!;
    expect(updated.lifecycle.status).toBe('pending');
    expect(updated.lifecycle.runCount).toBe(1);
    expect(updated.lifecycle.nextRunAt).toBeDefined();
    // 下次应该在明天
    const nextRun = new Date(updated.lifecycle.nextRunAt!);
    expect(nextRun.getDate()).toBe(now.getDate() + 1);
  });

  test('锁冲突时跳过', async () => {
    const now = new Date();
    const goal = makeGoal({ id: 'g_locked' });
    goal.lifecycle.nextRunAt = new Date(now.getTime() - 60_000).toISOString();
    store.add(goal);

    // 预先获取锁
    store.acquireLock('g_locked');

    const engine = createEngine('GOAL_DONE: g_locked');
    const stats = await engine.processDueGoals(now);

    expect(stats.dueCount).toBe(1);
    expect(stats.executedCount).toBe(0); // 被锁跳过

    store.releaseLock('g_locked');
  });

  test('多个 Goal 串行执行', async () => {
    const now = new Date();
    const g1 = makeGoal({
      id: 'g_multi_1',
      trigger: { type: 'time', time: '09:00' },
      action: { type: 'send_message', content: 'morning' },
    });
    g1.lifecycle.nextRunAt = new Date(now.getTime() - 60_000).toISOString();
    const g2 = makeGoal({
      id: 'g_multi_2',
      trigger: { type: 'time', time: '18:00' },
      action: { type: 'send_message', content: 'evening' },
    });
    g2.lifecycle.nextRunAt = new Date(now.getTime() - 60_000).toISOString();

    store.add(g1);
    store.add(g2);

    // 确认两个 goal 都到且不同（不同触发时间/动作，不会被去重）
    expect(store.getDue(now).length).toBe(2);

    // Agent 依次回复
    let callCount = 0;
    const engine = new GoalEngine(store, {
      executeAgent: async () => {
        callCount++;
        return callCount === 1 ? 'GOAL_DONE: g_multi_1' : 'GOAL_SKIP: g_multi_2';
      },
      sendIM: async () => {},
      workspaceDir: TEST_DIR,
    });

    const stats = await engine.processDueGoals(now);

    expect(stats.dueCount).toBe(2);
    expect(stats.executedCount).toBe(2);
    expect(stats.doneCount).toBe(1);
    expect(stats.skipCount).toBe(1);
  });

  test('Agent 超时返回 failed', async () => {
    const now = new Date();
    const goal = makeGoal({ id: 'g_timeout' });
    goal.lifecycle.nextRunAt = new Date(now.getTime() - 60_000).toISOString();
    store.add(goal);

    let agentStarted = false;
    const engine = new GoalEngine(store, {
      executeAgent: async () => {
        agentStarted = true;
        await new Promise(r => setTimeout(r, 10000));
        return 'GOAL_DONE: g_timeout';
      },
      sendIM: async () => {},
      workspaceDir: TEST_DIR,
      timeoutMs: 100, // 100ms 超时
    });

    const stats = await engine.processDueGoals(now);

    expect(stats.failedCount).toBe(1);
    expect(agentStarted).toBe(true); // Agent 确实被调用了
    const updated = store.get('g_timeout')!;
    expect(updated.lifecycle.status).toBe('failed');
  });

  test('processDueGoals 返回总耗时', async () => {
    const now = new Date();
    const goal = makeGoal({ id: 'g_timing' });
    goal.lifecycle.nextRunAt = new Date(now.getTime() - 60_000).toISOString();
    store.add(goal);

    const engine = createEngine('GOAL_DONE: g_timing', 50);
    const stats = await engine.processDueGoals(now);

    expect(stats.totalDurationMs).toBeGreaterThanOrEqual(50);
  });
});

describe('GoalEngine - 查询', () => {
  let store: GoalStore;

  beforeEach(() => {
    if (fs.existsSync(TEST_FILE)) fs.unlinkSync(TEST_FILE);
    store = new GoalStore(TEST_FILE);
  });

  test('getActiveGoals 返回活跃列表', () => {
    const g1 = makeGoal({ id: 'qa1' });
    const g2 = makeGoal({ id: 'qa2' });
    g2.lifecycle.status = 'done';
    store.add(g1);
    store.add(g2);

    const engine = new GoalEngine(store, {
      executeAgent: async () => '',
      sendIM: async () => {},
    });

    const active = engine.getActiveGoals();
    expect(active.length).toBe(1);
    expect(active[0].id).toBe('qa1');
  });

  test('getDueGoals 返回到期列表', () => {
    const now = new Date();
    const g1 = makeGoal({ id: 'qd1' });
    g1.lifecycle.nextRunAt = new Date(now.getTime() - 60_000).toISOString();
    const g2 = makeGoal({ id: 'qd2' });
    g2.lifecycle.nextRunAt = new Date(now.getTime() + 60_000).toISOString();
    store.add(g1);
    store.add(g2);

    const engine = new GoalEngine(store, {
      executeAgent: async () => '',
      sendIM: async () => {},
    });

    const due = engine.getDueGoals(now);
    expect(due.length).toBe(1);
    expect(due[0].id).toBe('qd1');
  });
});
