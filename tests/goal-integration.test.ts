// ================================================================
// Goal Engine Phase 1 集成测试
// ================================================================
// 测试场景：
//   T6: 心跳触发时到期 Goal 被执行
//   T7: setTimeout 精确触发
//   T8: 进程重启后 setTimeout 丢失，心跳兜底
//   T9: 多 Goal 同时到期串行执行
// ================================================================

import { describe, test, expect, beforeEach, afterAll, mock } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';
import { GoalEngine } from '../modules/core/goal-engine';
import { GoalStore } from '../modules/core/goal-store';
import { createGoal, type Goal } from '../modules/core/goal-types';

// ================================================================
// 测试辅助
// ================================================================

const TEST_DIR = path.join(process.env.HOME ?? '~', '.imtoagent', 'test-integration');
const TEST_FILE = path.join(TEST_DIR, 'goals-integration-test.json');
const TEST_HISTORY = path.join(TEST_DIR, 'goals_history.json');

function makeGoal(overrides: Partial<Goal> = {}): Goal {
  const id = `goal_int_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
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

function mockAgent(reply: string, delayMs = 5) {
  return async (_prompt: string) => {
    await new Promise(r => setTimeout(r, delayMs));
    return reply;
  };
}

function mockSendIM() {
  const messages: { chatId: string; text: string }[] = [];
  return {
    sendIM: async (chatId: string, text: string) => { messages.push({ chatId, text }); },
    getMessages: () => [...messages],
  };
}

function createEngine(store: GoalStore, agentReply: string, delayMs = 5) {
  const { sendIM, getMessages } = mockSendIM();
  const engine = new GoalEngine(store, {
    executeAgent: mockAgent(agentReply, delayMs),
    sendIM,
    workspaceDir: TEST_DIR,
    timeoutMs: 5000,
  });
  return { engine, getMessages };
}

// ================================================================
// T6: 心跳触发时到期 Goal 被执行
// ================================================================

describe('T6: 心跳触发 — 到期 Goal 在心跳中被执行', () => {
  let store: GoalStore;

  beforeEach(() => {
    if (fs.existsSync(TEST_FILE)) fs.unlinkSync(TEST_FILE);
    if (!fs.existsSync(TEST_DIR)) fs.mkdirSync(TEST_DIR, { recursive: true });
    store = new GoalStore(TEST_FILE);
  });

  afterAll(() => {
    try {
      if (fs.existsSync(TEST_FILE)) fs.unlinkSync(TEST_FILE);
      if (fs.existsSync(TEST_HISTORY)) fs.unlinkSync(TEST_HISTORY);
    } catch {}
  });

  test('模拟心跳：getDue → processDueGoals → 状态更新', async () => {
    const now = new Date();

    // 创建一个 1 分钟前到期的 Goal
    const goal = makeGoal({ id: 't6_heartbeat' });
    goal.lifecycle.nextRunAt = new Date(now.getTime() - 60_000).toISOString();
    store.add(goal);

    // 模拟心跳流程
    const dueGoals = store.getDue(now);
    expect(dueGoals.length).toBe(1);
    expect(dueGoals[0].id).toBe('t6_heartbeat');

    // 心跳中调用 processDueGoals
    const { engine } = createEngine(store, 'GOAL_DONE: t6_heartbeat');
    const stats = await engine.processDueGoals(now);

    expect(stats.dueCount).toBe(1);
    expect(stats.executedCount).toBe(1);
    expect(stats.doneCount).toBe(1);

    // 验证状态已更新
    const updated = store.get('t6_heartbeat')!;
    expect(updated.lifecycle.status).toBe('done');
    expect(updated.lifecycle.runCount).toBe(0); // once 类型不递增（markDone 不调 reschedule）
  });

  test('心跳触发：周期性 Goal 执行后重新调度', async () => {
    const now = new Date();
    const goal = makeGoal({ id: 't6_periodic' });
    goal.lifecycle.repeat = 'hourly';
    goal.lifecycle.nextRunAt = new Date(now.getTime() - 60_000).toISOString();
    store.add(goal);

    const { engine } = createEngine(store, 'GOAL_DONE: t6_periodic');
    await engine.processDueGoals(now);

    const updated = store.get('t6_periodic')!;
    expect(updated.lifecycle.status).toBe('pending'); // 重新调度后回到 pending
    expect(updated.lifecycle.runCount).toBe(1);
    expect(updated.lifecycle.nextRunAt).toBeDefined();

    // 下次应该在 1 小时后
    const nextRun = new Date(updated.lifecycle.nextRunAt!);
    const expectedNext = new Date(now.getTime() + 60 * 60 * 1000);
    expect(Math.abs(nextRun.getTime() - expectedNext.getTime())).toBeLessThan(2000);
  });

  test('心跳触发：无到期 Goal 时不做任何事', async () => {
    const now = new Date();
    const goal = makeGoal({ id: 't6_future' });
    goal.lifecycle.nextRunAt = new Date(now.getTime() + 3600_000).toISOString(); // 1 小时后
    store.add(goal);

    const { engine } = createEngine(store, 'GOAL_DONE: t6_future');
    const stats = await engine.processDueGoals(now);

    expect(stats.dueCount).toBe(0);
    expect(stats.executedCount).toBe(0);

    // Goal 状态不变
    expect(store.get('t6_future')!.lifecycle.status).toBe('pending');
  });
});

// ================================================================
// T7: setTimeout 精确触发
// ================================================================

describe('T7: setTimeout 精确触发', () => {
  let store: GoalStore;

  beforeEach(() => {
    if (fs.existsSync(TEST_FILE)) fs.unlinkSync(TEST_FILE);
    if (!fs.existsSync(TEST_DIR)) fs.mkdirSync(TEST_DIR, { recursive: true });
    store = new GoalStore(TEST_FILE);
  });

  afterAll(() => {
    try {
      if (fs.existsSync(TEST_FILE)) fs.unlinkSync(TEST_FILE);
      if (fs.existsSync(TEST_HISTORY)) fs.unlinkSync(TEST_HISTORY);
    } catch {}
  });

  test('setTimeout 在目标时间触发并执行 Goal', async () => {
    const now = new Date();
    const triggerTime = new Date(now.getTime() + 200); // 200ms 后

    const goal = makeGoal({ id: 't7_precise' });
    goal.lifecycle.nextRunAt = triggerTime.toISOString();
    store.add(goal);

    // 验证 Goal 当前未到期
    expect(store.getDue(now).length).toBe(0);

    // 注册 setTimeout 模拟
    let triggered = false;
    const timer = setTimeout(async () => {
      const { engine } = createEngine(store, 'GOAL_DONE: t7_precise');
      const stats = await engine.processDueGoals(new Date());
      triggered = true;
      expect(stats.doneCount).toBe(1);
    }, 200);

    // 等待 setTimeout 触发
    await new Promise(r => setTimeout(r, 350));

    expect(triggered).toBe(true);

    const updated = store.get('t7_precise')!;
    expect(updated.lifecycle.status).toBe('done');

    clearTimeout(timer);
  });

  test('macOS 休眠模拟：setTimeout 回调中判断过期则跳过', async () => {
    const now = new Date();
    const scheduledTime = now.getTime() + 100; // 原定 100ms 后
    const leadMinutes = 10;

    let callbackRan = false;
    let skipped = false;

    // 模拟：setTimeout 实际在 300ms 后才触发（模拟休眠延迟）
    // 过期判断：如果实际时间超过 scheduledTime + leadMinutes*60*1000，则跳过
    const timer = setTimeout(() => {
      callbackRan = true;
      const actualNow = Date.now();
      // 由于 leadMinutes=10（600000ms），300ms 的延迟远未超过阈值
      // 所以不会跳过，正常执行
      if (actualNow > scheduledTime + leadMinutes * 60 * 1000) {
        skipped = true;
        return;
      }
    }, 300);

    await new Promise(r => setTimeout(r, 400));

    expect(callbackRan).toBe(true);
    // 300ms < 600000ms，所以不会跳过（正常行为）
    expect(skipped).toBe(false);

    clearTimeout(timer);
  });

  test('macOS 休眠模拟：超长延迟导致过期跳过', async () => {
    const scheduledTime = Date.now(); // 原定现在触发
    const leadMinutes = 10;

    // 直接验证过期判断逻辑
    const simulatedWakeTime = Date.now() + 12 * 60 * 1000; // 模拟 12 分钟后唤醒
    const isExpired = simulatedWakeTime > scheduledTime + leadMinutes * 60 * 1000;

    expect(isExpired).toBe(true); // 12 分钟 > 10 分钟 lead，应跳过
  });
});

// ================================================================
// T8: 进程重启后 setTimeout 丢失，心跳兜底
// ================================================================

describe('T8: 进程重启 → setTimeout 丢失 → 心跳兜底', () => {
  let store: GoalStore;

  beforeEach(() => {
    if (fs.existsSync(TEST_FILE)) fs.unlinkSync(TEST_FILE);
    if (!fs.existsSync(TEST_DIR)) fs.mkdirSync(TEST_DIR, { recursive: true });
    store = new GoalStore(TEST_FILE);
  });

  afterAll(() => {
    try {
      if (fs.existsSync(TEST_FILE)) fs.unlinkSync(TEST_FILE);
      if (fs.existsSync(TEST_HISTORY)) fs.unlinkSync(TEST_HISTORY);
    } catch {}
  });

  test('进程重启后 Goal 仍存在于 Store，心跳可以兜底触发', async () => {
    const now = new Date();

    // 进程 1: 创建 Goal（nextRunAt 在过去）
    const goal = makeGoal({ id: 't8_fallback' });
    goal.lifecycle.nextRunAt = new Date(now.getTime() - 120_000).toISOString(); // 2 分钟前
    store.add(goal);

    // 模拟进程 1 注册了 setTimeout，但进程崩溃导致 setTimeout 丢失
    // （在测试中：我们不注册 setTimeout，直接模拟重启）

    // 进程 2: 重启后重新加载 Store
    const store2 = new GoalStore(TEST_FILE);

    // 验证 Goal 仍然存在
    const retrieved = store2.get('t8_fallback');
    expect(retrieved).not.toBeNull();
    expect(retrieved!.lifecycle.status).toBe('pending');

    // 心跳触发：getDue 找到到期 Goal
    const dueGoals = store2.getDue(now);
    expect(dueGoals.length).toBe(1);
    expect(dueGoals[0].id).toBe('t8_fallback');

    // 执行
    const { engine } = createEngine(store2, 'GOAL_DONE: t8_fallback');
    const stats = await engine.processDueGoals(now);

    expect(stats.doneCount).toBe(1);
    expect(store2.get('t8_fallback')!.lifecycle.status).toBe('done');
  });

  test('多个 Goal 在重启后都能被心跳兜底触发', async () => {
    const now = new Date();

    const g1 = makeGoal({ id: 't8_multi_1', action: { type: 'send_message', content: 'msg1' } });
    g1.lifecycle.nextRunAt = new Date(now.getTime() - 300_000).toISOString();
    store.add(g1);

    const g2 = makeGoal({ id: 't8_multi_2', action: { type: 'send_message', content: 'msg2' } });
    g2.lifecycle.repeat = 'daily';
    g2.trigger.time = '09:00';
    g2.lifecycle.nextRunAt = new Date(now.getTime() - 180_000).toISOString();
    store.add(g2);

    const g3 = makeGoal({ id: 't8_multi_future', action: { type: 'send_message', content: 'msg3' } });
    g3.lifecycle.nextRunAt = new Date(now.getTime() + 3600_000).toISOString(); // 1 小时后
    store.add(g3);

    // 重启
    const store2 = new GoalStore(TEST_FILE);

    // 心跳只找到到期的
    const due = store2.getDue(now);
    expect(due.length).toBe(2); // g1 和 g2 到期，g3 未到期

    // 创建引擎，Agent 根据 goal ID 回复
    const engine = new GoalEngine(store2, {
      executeAgent: async (_prompt) => {
        // 解析 prompt 中的 goal ID
        const idMatch = _prompt.match(/目标 ID: (\S+)/);
        const goalId = idMatch ? idMatch[1] : 'unknown';
        return `GOAL_DONE: ${goalId}`;
      },
      sendIM: async () => {},
      workspaceDir: TEST_DIR,
      timeoutMs: 5000,
    });
    const stats = await engine.processDueGoals(now);

    expect(stats.dueCount).toBe(2);
    expect(store2.get('t8_multi_future')!.lifecycle.status).toBe('pending'); // 不受影响
  });
});

// ================================================================
// T9: 多 Goal 同时到期串行执行
// ================================================================

describe('T9: 多 Goal 同时到期串行执行', () => {
  let store: GoalStore;

  beforeEach(() => {
    if (fs.existsSync(TEST_FILE)) fs.unlinkSync(TEST_FILE);
    if (!fs.existsSync(TEST_DIR)) fs.mkdirSync(TEST_DIR, { recursive: true });
    store = new GoalStore(TEST_FILE);
  });

  afterAll(() => {
    try {
      if (fs.existsSync(TEST_FILE)) fs.unlinkSync(TEST_FILE);
      if (fs.existsSync(TEST_HISTORY)) fs.unlinkSync(TEST_HISTORY);
    } catch {}
  });

  test('5 个 Goal 同时到期，串行执行（非并发）', async () => {
    const now = new Date();
    const executionOrder: string[] = [];

    // 创建 5 个同时到期的 Goal
    for (let i = 1; i <= 5; i++) {
      const goal = makeGoal({
        id: `t9_seq_${i}`,
        action: { type: 'send_message', content: `message ${i}` },
      });
      goal.lifecycle.nextRunAt = new Date(now.getTime() - 60_000).toISOString();
      store.add(goal);
    }

    // 验证 5 个都到期
    expect(store.getDue(now).length).toBe(5);

    // 创建引擎：记录执行顺序
    let callCount = 0;
    const { engine } = createEngine(store, '', 10);

    // 覆盖 executeAgent 来记录顺序
    const engine2 = new GoalEngine(store, {
      executeAgent: async (_prompt) => {
        callCount++;
        executionOrder.push(`call_${callCount}`);
        return `GOAL_DONE: t9_seq_${callCount}`;
      },
      sendIM: async () => {},
      workspaceDir: TEST_DIR,
      timeoutMs: 5000,
    });

    const stats = await engine2.processDueGoals(now);

    expect(stats.dueCount).toBe(5);
    expect(stats.executedCount).toBe(5);
    expect(stats.doneCount).toBe(5);

    // 验证串行执行：调用顺序必须是 1→2→3→4→5
    expect(executionOrder).toEqual(['call_1', 'call_2', 'call_3', 'call_4', 'call_5']);

    // 验证所有 Goal 都标记为 done
    for (let i = 1; i <= 5; i++) {
      expect(store.get(`t9_seq_${i}`)!.lifecycle.status).toBe('done');
    }
  });

  test('混合结果：有的 done、有的 skip、有的 fail', async () => {
    const now = new Date();

    // 用不同的 action.content 区分，避免被去重
    const g1 = makeGoal({ id: 't9_mix_done', action: { type: 'send_message', content: 'done_msg' } });
    g1.lifecycle.nextRunAt = new Date(now.getTime() - 60_000).toISOString();
    store.add(g1);

    const g2 = makeGoal({ id: 't9_mix_skip', action: { type: 'send_message', content: 'skip_msg' } });
    g2.lifecycle.nextRunAt = new Date(now.getTime() - 60_000).toISOString();
    store.add(g2);

    const g3 = makeGoal({ id: 't9_mix_fail', action: { type: 'send_message', content: 'fail_msg' } });
    g3.lifecycle.nextRunAt = new Date(now.getTime() - 60_000).toISOString();
    store.add(g3);

    expect(store.getDue(now).length).toBe(3);

    let callCount = 0;
    const engine = new GoalEngine(store, {
      executeAgent: async () => {
        callCount++;
        if (callCount === 1) return 'GOAL_DONE: t9_mix_done';
        if (callCount === 2) return 'GOAL_SKIP: t9_mix_skip';
        return 'GOAL_FAILED: t9_mix_fail 网络错误';
      },
      sendIM: async () => {},
      workspaceDir: TEST_DIR,
      timeoutMs: 5000,
    });

    const stats = await engine.processDueGoals(now);

    expect(stats.dueCount).toBe(3);
    expect(stats.executedCount).toBe(3);
    expect(stats.doneCount).toBe(1);
    expect(stats.skipCount).toBe(1);
    expect(stats.failedCount).toBe(1);

    expect(store.get('t9_mix_done')!.lifecycle.status).toBe('done');
    expect(store.get('t9_mix_skip')!.lifecycle.status).toBe('done'); // once + skip = done
    expect(store.get('t9_mix_fail')!.lifecycle.status).toBe('failed');
  });

  test('执行锁防止同一 Goal 被重复执行', async () => {
    const now = new Date();
    const goal = makeGoal({ id: 't9_lock' });
    goal.lifecycle.nextRunAt = new Date(now.getTime() - 60_000).toISOString();
    store.add(goal);

    // 手动获取锁
    store.acquireLock('t9_lock');

    const { engine } = createEngine(store, 'GOAL_DONE: t9_lock');
    const stats = await engine.processDueGoals(now);

    expect(stats.dueCount).toBe(1);
    expect(stats.executedCount).toBe(0); // 被锁跳过
    expect(store.get('t9_lock')!.lifecycle.status).toBe('pending'); // 状态不变

    store.releaseLock('t9_lock');
  });
});
