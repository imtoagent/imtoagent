// ================================================================
// GoalStore 单元测试
// ================================================================

import { describe, test, expect, beforeEach } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';
import { GoalStore } from '../modules/core/goal-store';
import type { Goal } from '../modules/core/goal-types';
import { createGoal } from '../modules/core/goal-types';

const TEST_DIR = path.join(process.env.HOME ?? '~', '.imtoagent', 'test-goals');
const TEST_FILE = path.join(TEST_DIR, 'goals-test.json');

function makeGoal(overrides: Partial<Goal> = {}): Goal {
  const id = `goal_test_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  return createGoal({
    ...overrides,
    id: overrides.id ?? id,
    type: overrides.type ?? 'reminder',
    trigger: overrides.trigger ?? { type: 'time', time: '13:00' },
    action: overrides.action ?? { type: 'send_message', content: 'test' },
    metadata: overrides.metadata ?? {
      createdBy: 'user_test',
      sourceChatId: 'oc_test',
      rawInput: '测试提醒',
    },
  }) as Goal;
}

describe('GoalStore - CRUD', () => {
  let store: GoalStore;

  beforeEach(() => {
    if (fs.existsSync(TEST_FILE)) fs.unlinkSync(TEST_FILE);
    store = new GoalStore(TEST_FILE);
  });

  test('add 创建 Goal', () => {
    const goal = makeGoal();
    const result = store.add(goal);
    expect(result.status).toBe('created');

    const retrieved = store.get(goal.id);
    expect(retrieved).not.toBeNull();
    expect(retrieved!.id).toBe(goal.id);
  });

  test('add 检测重复', () => {
    const now = Date.now();
    const base = {
      type: 'reminder' as const,
      trigger: { type: 'time' as const, time: '13:00' },
      action: { type: 'send_message' as const, content: '带伞' },
      metadata: { createdBy: 'user1', sourceChatId: 'oc_xxx', rawInput: '1点提醒带伞' },
    };

    const goal1 = makeGoal({ id: `goal_a_${now}`, ...base });
    const result1 = store.add(goal1);
    expect(result1.status).toBe('created');

    const goal2 = makeGoal({ id: `goal_b_${now}`, ...base });
    const result2 = store.add(goal2);
    expect(result2.status).toBe('duplicate');
    if (result2.status === 'duplicate') {
      expect(result2.existingId).toBe(goal1.id);
    }
  });

  test('update 修改字段', () => {
    const goal = makeGoal();
    store.add(goal);

    store.update(goal.id, { metadata: { ...goal.metadata, priority: 'high' } });
    const updated = store.get(goal.id);
    expect(updated!.metadata.priority).toBe('high');
  });

  test('update 不存在的 Goal', () => {
    const result = store.update('nonexistent', { type: 'reminder' });
    expect(result).toBe(false);
  });

  test('delete 删除 Goal', () => {
    const goal = makeGoal();
    store.add(goal);
    expect(store.get(goal.id)).not.toBeNull();

    const removed = store.delete(goal.id);
    expect(removed).toBe(true);
    expect(store.get(goal.id)).toBeNull();
  });

  test('delete 不存在的 Goal', () => {
    expect(store.delete('nonexistent')).toBe(false);
  });
});

describe('GoalStore - 查询', () => {
  let store: GoalStore;

  beforeEach(() => {
    if (fs.existsSync(TEST_FILE)) fs.unlinkSync(TEST_FILE);
    store = new GoalStore(TEST_FILE);
  });

  test('getActive 只返回活跃 Goal', () => {
    const g1 = makeGoal({ id: 'g1' });
    const g2 = makeGoal({ id: 'g2' });
    g2.lifecycle.status = 'done';
    const g3 = makeGoal({ id: 'g3' });
    g3.lifecycle.status = 'cancelled';

    store.add(g1);
    store.add(g2);
    store.add(g3);

    const active = store.getActive();
    expect(active.length).toBe(1);
    expect(active[0].id).toBe('g1');
  });

  test('getDue 返回到期 Goal', () => {
    const now = new Date();
    const g1 = makeGoal({ id: 'g1' });
    g1.lifecycle.nextRunAt = new Date(now.getTime() - 60_000).toISOString(); // 1 分钟前

    const g2 = makeGoal({ id: 'g2' });
    g2.lifecycle.nextRunAt = new Date(now.getTime() + 60_000).toISOString(); // 1 分钟后

    store.add(g1);
    store.add(g2);

    const due = store.getDue(now);
    expect(due.length).toBe(1);
    expect(due[0].id).toBe('g1');
  });

  test('list 按标签过滤', () => {
    const g1 = makeGoal({ id: 'g1' });
    g1.metadata.tags = ['weather', 'morning'];
    const g2 = makeGoal({ id: 'g2' });
    g2.metadata.tags = ['system'];

    store.add(g1);
    store.add(g2);

    const weatherGoals = store.getByTag('weather');
    expect(weatherGoals.length).toBe(1);
    expect(weatherGoals[0].id).toBe('g1');
  });
});

describe('GoalStore - 状态迁移', () => {
  let store: GoalStore;

  beforeEach(() => {
    if (fs.existsSync(TEST_FILE)) fs.unlinkSync(TEST_FILE);
    store = new GoalStore(TEST_FILE);
  });

  test('markDone 标记完成', () => {
    const goal = makeGoal();
    store.add(goal);
    store.markDone(goal.id);
    expect(store.get(goal.id)!.lifecycle.status).toBe('done');
  });

  test('markFailed 标记失败', () => {
    const goal = makeGoal();
    store.add(goal);
    store.markFailed(goal.id, 'timeout');
    const g = store.get(goal.id)!;
    expect(g.lifecycle.status).toBe('failed');
    expect(g.lifecycle.lastError).toBe('timeout');
  });

  test('cancel 取消', () => {
    const goal = makeGoal();
    store.add(goal);
    store.cancel(goal.id);
    expect(store.get(goal.id)!.lifecycle.status).toBe('cancelled');
  });

  test('reschedule - once 类型标记 done', () => {
    const goal = makeGoal();
    goal.lifecycle.repeat = 'once';
    store.add(goal);
    store.reschedule(goal.id);
    expect(store.get(goal.id)!.lifecycle.status).toBe('done');
    expect(store.get(goal.id)!.lifecycle.runCount).toBe(1);
  });

  test('reschedule - daily 类型计算下次时间', () => {
    const goal = makeGoal();
    goal.lifecycle.repeat = 'daily';
    goal.trigger.time = '09:00';
    store.add(goal);

    const now = new Date('2026-06-03T09:00:00+08:00');
    store.reschedule(goal.id);

    const g = store.get(goal.id)!;
    expect(g.lifecycle.runCount).toBe(1);
    expect(g.lifecycle.status).toBe('pending');
    expect(g.lifecycle.nextRunAt).toContain('2026-06-05');
  });
});

describe('GoalStore - 执行锁', () => {
  let store: GoalStore;

  beforeEach(() => {
    if (fs.existsSync(TEST_FILE)) fs.unlinkSync(TEST_FILE);
    store = new GoalStore(TEST_FILE);
  });

  test('acquireLock 获取锁', () => {
    const lock = store.acquireLock('goal_x');
    expect(lock).not.toBeNull();
    expect(lock!.goalId).toBe('goal_x');
  });

  test('acquireLock 重复获取失败', () => {
    store.acquireLock('goal_x');
    const lock2 = store.acquireLock('goal_x');
    expect(lock2).toBeNull();
  });

  test('releaseLock 释放后可重新获取', () => {
    store.acquireLock('goal_x');
    store.releaseLock('goal_x');
    const lock2 = store.acquireLock('goal_x');
    expect(lock2).not.toBeNull();
  });

  test('isLocked 检查锁状态', () => {
    store.acquireLock('goal_x');
    expect(store.isLocked('goal_x')).toBe(true);
    store.releaseLock('goal_x');
    expect(store.isLocked('goal_x')).toBe(false);
  });
});

describe('GoalStore - 持久化', () => {
  beforeEach(() => {
    if (fs.existsSync(TEST_FILE)) fs.unlinkSync(TEST_FILE);
  });

  test('重启后数据不丢失', () => {
    const store1 = new GoalStore(TEST_FILE);
    const goal = makeGoal({ id: 'persist_test' });
    store1.add(goal);

    const store2 = new GoalStore(TEST_FILE);
    const retrieved = store2.get('persist_test');
    expect(retrieved).not.toBeNull();
    expect(retrieved!.id).toBe('persist_test');
  });

  test('空文件正常初始化', () => {
    const dir = path.dirname(TEST_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    // 不创建文件
    const store = new GoalStore(TEST_FILE);
    expect(fs.existsSync(TEST_FILE)).toBe(true); // 自动创建
    expect(store.getActive()).toEqual([]);
  });
});
