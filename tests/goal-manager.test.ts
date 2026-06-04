// ================================================================
// GoalManager 单元测试
// ================================================================

import { describe, test, expect, beforeEach, afterAll } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';
import { GoalManager, parseGoalManagement } from '../modules/core/goal-manager';
import { GoalStore } from '../modules/core/goal-store';
import { createGoal, type Goal } from '../modules/core/goal-types';

// ================================================================
// 测试辅助
// ================================================================

const TEST_DIR = path.join(process.env.HOME ?? '~', '.imtoagent', 'test-gm');
const TEST_FILE = path.join(TEST_DIR, 'goals-gm-test.json');

function makeGoal(overrides: Partial<Goal> = {}): Goal {
  const id = `goal_gm_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
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

// ================================================================
// parseGoalManagement
// ================================================================

describe('parseGoalManagement', () => {
  test('解析 GOAL_LIST', () => {
    const result = parseGoalManagement('GOAL_LIST');
    expect(result).not.toBeNull();
    expect(result!.action).toBe('list');
  });

  test('解析 GOAL_CANCEL', () => {
    const result = parseGoalManagement('GOAL_CANCEL: goal_abc123');
    expect(result).not.toBeNull();
    expect(result!.action).toBe('cancel');
    expect(result!.goalId).toBe('goal_abc123');
  });

  test('解析 GOAL_PAUSE', () => {
    const result = parseGoalManagement('任务已暂停 GOAL_PAUSE: goal_x7');
    expect(result!.action).toBe('pause');
    expect(result!.goalId).toBe('goal_x7');
  });

  test('解析 GOAL_RESUME', () => {
    const result = parseGoalManagement('GOAL_RESUME: goal_abc123');
    expect(result!.action).toBe('resume');
    expect(result!.goalId).toBe('goal_abc123');
  });

  test('解析 GOAL_UPDATE 带 JSON', () => {
    const result = parseGoalManagement('GOAL_UPDATE: goal_abc123 {"trigger":{"time":"14:00"}}');
    expect(result!.action).toBe('update');
    expect(result!.goalId).toBe('goal_abc123');
    expect(result!.patch).toEqual({ trigger: { time: '14:00' } });
  });

  test('解析 GOAL_UPDATE JSON 无效时返回 _raw', () => {
    const result = parseGoalManagement('GOAL_UPDATE: goal_abc123 改成每天下午两点');
    expect(result!.action).toBe('update');
    expect(result!.goalId).toBe('goal_abc123');
    expect(result!.patch).toEqual({ _raw: '改成每天下午两点' });
  });

  test('无关文本返回 null', () => {
    const result = parseGoalManagement('好的，任务已完成');
    expect(result).toBeNull();
  });

  test('忽略大小写', () => {
    const result = parseGoalManagement('goal_list');
    expect(result!.action).toBe('list');

    const result2 = parseGoalManagement('Goal_Cancel: goal_x');
    expect(result2!.action).toBe('cancel');
  });

  test('混在其他文字中仍能解析', () => {
    const result = parseGoalManagement(
      '所有活跃目标如下：\nGOAL_LIST\n\n以上是当前列表',
    );
    expect(result!.action).toBe('list');
  });
});

// ================================================================
// GoalManager - 列出 Goal
// ================================================================

describe('GoalManager - listGoals', () => {
  let store: GoalStore;
  let manager: GoalManager;

  beforeEach(() => {
    if (fs.existsSync(TEST_FILE)) fs.unlinkSync(TEST_FILE);
    store = new GoalStore(TEST_FILE);
    manager = new GoalManager(store);
  });

  afterAll(() => {
    try {
      if (fs.existsSync(TEST_FILE)) fs.unlinkSync(TEST_FILE);
    } catch {}
  });

  test('无活跃 Goal 返回提示', () => {
    const output = manager.listGoals();
    expect(output).toContain('暂无活跃目标');
  });

  test('列出所有活跃 Goal', () => {
    const g1 = makeGoal({ id: 'g1', trigger: { type: 'time', time: '09:00' }, metadata: { createdBy: 'u1', sourceChatId: 'oc1', rawInput: '提醒开会' } });
    const g2 = makeGoal({ id: 'g2', trigger: { type: 'time', time: '18:00' }, metadata: { createdBy: 'u1', sourceChatId: 'oc1', rawInput: '天气检查' } });
    g1.lifecycle.nextRunAt = new Date().toISOString();
    g2.lifecycle.nextRunAt = new Date().toISOString();
    store.add(g1);
    store.add(g2);

    const output = manager.listGoals();
    expect(output).toContain('2个');
    expect(output).toContain('g1');
    expect(output).toContain('g2');
  });

  test('按 createdBy 过滤', () => {
    const g1 = makeGoal({ id: 'g1', metadata: { createdBy: 'alice', sourceChatId: 'oc1', rawInput: 'a' } });
    const g2 = makeGoal({ id: 'g2', metadata: { createdBy: 'bob', sourceChatId: 'oc1', rawInput: 'b' } });
    g1.lifecycle.nextRunAt = new Date().toISOString();
    g2.lifecycle.nextRunAt = new Date().toISOString();
    store.add(g1);
    store.add(g2);

    const output = manager.listGoals({ createdBy: 'alice' });
    expect(output).toContain('1个');
    expect(output).toContain('g1');
    expect(output).not.toContain('g2');
  });

  test('按 tag 过滤', () => {
    const g1 = makeGoal({ id: 'g1', metadata: { createdBy: 'u1', sourceChatId: 'oc1', rawInput: 'a', tags: ['work'] } });
    const g2 = makeGoal({ id: 'g2', metadata: { createdBy: 'u1', sourceChatId: 'oc1', rawInput: 'b', tags: ['personal'] } });
    g1.lifecycle.nextRunAt = new Date().toISOString();
    g2.lifecycle.nextRunAt = new Date().toISOString();
    store.add(g1);
    store.add(g2);

    const output = manager.listGoals({ tag: 'work' });
    expect(output).toContain('1个');
    expect(output).toContain('g1');
  });

  test('不显示已完成的 Goal', () => {
    const g1 = makeGoal({ id: 'g1' });
    g1.lifecycle.nextRunAt = new Date().toISOString();
    const g2 = makeGoal({ id: 'g2' });
    g2.lifecycle.nextRunAt = new Date().toISOString();
    g2.lifecycle.status = 'done';
    store.add(g1);
    store.add(g2);

    const output = manager.listGoals();
    expect(output).toContain('1个');
    expect(output).toContain('g1');
  });
});

// ================================================================
// GoalManager - 取消 Goal
// ================================================================

describe('GoalManager - cancelGoal', () => {
  let store: GoalStore;
  let manager: GoalManager;

  beforeEach(() => {
    if (fs.existsSync(TEST_FILE)) fs.unlinkSync(TEST_FILE);
    store = new GoalStore(TEST_FILE);
    manager = new GoalManager(store);
  });

  afterAll(() => {
    try {
      if (fs.existsSync(TEST_FILE)) fs.unlinkSync(TEST_FILE);
    } catch {}
  });

  test('成功取消 Goal', () => {
    const goal = makeGoal({ id: 'cancel_me' });
    store.add(goal);

    const result = manager.cancelGoal('cancel_me');
    expect(result.success).toBe(true);
    expect(result.message).toContain('已取消');

    const updated = store.get('cancel_me')!;
    expect(updated.lifecycle.status).toBe("cancelled");
  });

  test('取消不存在的 Goal', () => {
    const result = manager.cancelGoal('nonexistent');
    expect(result.success).toBe(false);
    expect(result.message).toContain('不存在');
  });

  test('取消已完成的 Goal 失败', () => {
    const goal = makeGoal({ id: 'done_goal' });
    goal.lifecycle.status = 'done';
    store.add(goal);

    const result = manager.cancelGoal('done_goal');
    expect(result.success).toBe(false);
    expect(result.message).toContain('已结束');
  });
});

// ================================================================
// GoalManager - 暂停/恢复
// ================================================================

describe('GoalManager - pauseGoal / resumeGoal', () => {
  let store: GoalStore;
  let manager: GoalManager;

  beforeEach(() => {
    if (fs.existsSync(TEST_FILE)) fs.unlinkSync(TEST_FILE);
    store = new GoalStore(TEST_FILE);
    manager = new GoalManager(store);
  });

  afterAll(() => {
    try {
      if (fs.existsSync(TEST_FILE)) fs.unlinkSync(TEST_FILE);
    } catch {}
  });

  test('暂停 Goal', () => {
    const goal = makeGoal({ id: 'pause_me' });
    store.add(goal);

    const result = manager.pauseGoal('pause_me');
    expect(result.success).toBe(true);
    expect(result.message).toContain('已暂停');

    const updated = store.get('pause_me')!;
    expect(updated.lifecycle.status).toBe("paused");
  });

  test('恢复暂停的 Goal', () => {
    const goal = makeGoal({ id: 'resume_me' });
    store.add(goal);

    manager.pauseGoal('resume_me');
    const result = manager.resumeGoal('resume_me');

    expect(result.success).toBe(true);
    expect(result.message).toContain('已恢复');

    const updated = store.get('resume_me')!;
    expect(updated.lifecycle.status).toBe('pending');
    expect(updated.lifecycle.lastError).toBeUndefined();
  });

  test('恢复未暂停的 Goal 失败', () => {
    const goal = makeGoal({ id: 'not_paused' });
    store.add(goal);

    const result = manager.resumeGoal('not_paused');
    expect(result.success).toBe(false);
    expect(result.message).toContain('不是暂停状态');
  });

  test('暂停不存在的 Goal 失败', () => {
    const result = manager.pauseGoal('nonexistent');
    expect(result.success).toBe(false);
  });
});

// ================================================================
// GoalManager - 修改 Goal
// ================================================================

describe('GoalManager - updateGoal', () => {
  let store: GoalStore;
  let manager: GoalManager;

  beforeEach(() => {
    if (fs.existsSync(TEST_FILE)) fs.unlinkSync(TEST_FILE);
    store = new GoalStore(TEST_FILE);
    manager = new GoalManager(store);
  });

  afterAll(() => {
    try {
      if (fs.existsSync(TEST_FILE)) fs.unlinkSync(TEST_FILE);
    } catch {}
  });

  test('修改 trigger 时间', () => {
    const goal = makeGoal({ id: 'update_me', trigger: { type: 'time', time: '09:00' } });
    store.add(goal);

    const result = manager.updateGoal('update_me', {
      trigger: { type: 'time', time: '14:00' },
    });

    expect(result.success).toBe(true);
    const updated = store.get('update_me')!;
    expect(updated.trigger.time).toBe('14:00');
  });

  test('修改 action 内容', () => {
    const goal = makeGoal({ id: 'update_action', action: { type: 'send_message', content: '旧消息' } });
    store.add(goal);

    manager.updateGoal('update_action', {
      action: { type: 'send_message', content: '新消息' },
    });

    const updated = store.get('update_action')!;
    expect(updated.action.content).toBe('新消息');
  });

  test('修改不存在的 Goal 失败', () => {
    const result = manager.updateGoal('nonexistent', { trigger: { type: 'time', time: '10:00' } });
    expect(result.success).toBe(false);
  });

  test('修改已完成的 Goal 失败', () => {
    const goal = makeGoal({ id: 'done_update' });
    goal.lifecycle.status = 'done';
    store.add(goal);

    const result = manager.updateGoal('done_update', {
      trigger: { type: 'time', time: '10:00' },
    });
    expect(result.success).toBe(false);
    expect(result.message).toContain('已结束');
  });
});

// ================================================================
// GoalManager - processManagementCommand
// ================================================================

describe('GoalManager - processManagementCommand', () => {
  let store: GoalStore;
  let manager: GoalManager;

  beforeEach(() => {
    if (fs.existsSync(TEST_FILE)) fs.unlinkSync(TEST_FILE);
    store = new GoalStore(TEST_FILE);
    manager = new GoalManager(store);
  });

  afterAll(() => {
    try {
      if (fs.existsSync(TEST_FILE)) fs.unlinkSync(TEST_FILE);
    } catch {}
  });

  test('处理 GOAL_LIST 命令', () => {
    const g1 = makeGoal({ id: 'cmd_g1', metadata: { createdBy: 'u1', sourceChatId: 'oc1', rawInput: '测试1' } });
    g1.lifecycle.nextRunAt = new Date().toISOString();
    store.add(g1);

    const result = manager.processManagementCommand('GOAL_LIST');
    expect(result).not.toBeNull();
    expect(result!).toContain('1个');
    expect(result!).toContain('cmd_g1');
  });

  test('处理 GOAL_CANCEL 命令', () => {
    const goal = makeGoal({ id: 'cmd_cancel' });
    store.add(goal);

    const result = manager.processManagementCommand('GOAL_CANCEL: cmd_cancel');
    expect(result).not.toBeNull();
    expect(result!).toContain('已取消');

    expect(store.get('cmd_cancel')!.lifecycle.status).toBe('cancelled');
  });

  test('处理 GOAL_UPDATE 命令', () => {
    const goal = makeGoal({ id: 'cmd_update', trigger: { type: 'time', time: '09:00' } });
    store.add(goal);

    const result = manager.processManagementCommand('GOAL_UPDATE: cmd_update {"trigger":{"time":"15:00"}}');
    expect(result).not.toBeNull();
    expect(result!).toContain('已更新');

    expect(store.get('cmd_update')!.trigger.time).toBe('15:00');
  });

  test('非管理指令返回 null', () => {
    const result = manager.processManagementCommand('好的，任务已完成');
    expect(result).toBeNull();
  });

  test('处理 GOAL_PAUSE 和 GOAL_RESUME 命令', () => {
    const goal = makeGoal({ id: 'cmd_pause' });
    store.add(goal);

    const pauseResult = manager.processManagementCommand('GOAL_PAUSE: cmd_pause');
    expect(pauseResult).toContain('已暂停');

    const resumeResult = manager.processManagementCommand('GOAL_RESUME: cmd_pause');
    expect(resumeResult).toContain('已恢复');
  });
});
