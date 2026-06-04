// ================================================================
// GoalStore — Goal CRUD + JSON 持久化 + 冲突检测 + 执行锁
// ================================================================

import * as fs from 'fs';
import * as path from 'path';
import type {
  Goal,
  GoalFilter,
  GoalAddResult,
  GoalExecutionLock,
  GoalPersisted,
} from './goal-types';
import { generateGoalId } from './goal-types';

const DEFAULT_LOCK_TIMEOUT_MS = 5 * 60 * 1000; // 5 分钟

export class GoalStore {
  private goals: Map<string, Goal> = new Map();
  private locks: Map<string, GoalExecutionLock> = new Map();
  private filePath: string;

  constructor(filePath?: string) {
    this.filePath = filePath ?? path.join(process.env.HOME ?? '~', '.imtoagent', 'goals.json');
    this.load();
  }

  // ================================================================
  // 基础 CRUD
  // ================================================================

  /**
   * 添加 Goal，自动检测重复
   */
  add(goal: Goal): GoalAddResult {
    const duplicate = this.findDuplicate(goal);
    if (duplicate) {
      return { status: 'duplicate', existingId: duplicate.id, existing: duplicate };
    }
    this.goals.set(goal.id, goal);
    this.persist();
    return { status: 'created', id: goal.id };
  }

  /**
   * 按 ID 获取 Goal
   */
  get(id: string): Goal | null {
    return this.goals.get(id) ?? null;
  }

  /**
   * 更新 Goal 字段
   */
  update(id: string, patch: Partial<Goal>): boolean {
    const existing = this.goals.get(id);
    if (!existing) return false;
    this.goals.set(id, { ...existing, ...patch });
    this.persist();
    return true;
  }

  /**
   * 删除 Goal
   */
  delete(id: string): boolean {
    const removed = this.goals.delete(id);
    if (removed) this.persist();
    return removed;
  }

  // ================================================================
  // 查询
  // ================================================================

  /**
   * 按过滤条件查询
   */
  list(filter?: GoalFilter): Goal[] {
    let results = Array.from(this.goals.values());
    if (!filter) return results;

    if (filter.status) {
      const statuses = Array.isArray(filter.status) ? filter.status : [filter.status];
      results = results.filter(g => statuses.includes(g.lifecycle.status));
    }
    if (filter.type) {
      results = results.filter(g => g.type === filter.type);
    }
    if (filter.tags && filter.tags.length > 0) {
      results = results.filter(g => g.metadata.tags?.some(t => filter.tags!.includes(t)));
    }
    if (filter.createdBy) {
      results = results.filter(g => g.metadata.createdBy === filter.createdBy);
    }
    return results;
  }

  /**
   * 获取所有活跃 Goal（非 done/cancelled）
   */
  getActive(): Goal[] {
    return this.list({ status: ['pending', 'active', 'failed'] });
  }

  /**
   * 获取暂停的 Goal（status = paused）
   */
  getPaused(): Goal[] {
    return this.list({ status: ['paused'] });
  }

  /**
   * 获取到期的 Goal（nextRunAt <= now 且状态为 pending/active）
   */
  getDue(now?: Date): Goal[] {
    const ref = now ?? new Date();
    return this.getActive().filter(g => {
      if (!g.lifecycle.nextRunAt) return false;
      return new Date(g.lifecycle.nextRunAt) <= ref;
    });
  }

  /**
   * 按标签查询
   */
  getByTag(tag: string): Goal[] {
    return this.list({ tags: [tag] });
  }

  // ================================================================
  // 状态迁移
  // ================================================================

  markActive(id: string): boolean {
    const goal = this.goals.get(id);
    if (!goal) return false;
    goal.lifecycle.status = 'active';
    goal.lifecycle.lastRunAt = new Date().toISOString();
    this.persist();
    return true;
  }

  markDone(id: string): boolean {
    const goal = this.goals.get(id);
    if (!goal) return false;
    goal.lifecycle.status = 'done';
    this.persist();
    return true;
  }

  markFailed(id: string, error: string): boolean {
    const goal = this.goals.get(id);
    if (!goal) return false;
    goal.lifecycle.status = 'failed';
    goal.lifecycle.lastError = error;
    this.persist();
    return true;
  }

  cancel(id: string): boolean {
    const goal = this.goals.get(id);
    if (!goal) return false;
    goal.lifecycle.status = 'cancelled';
    this.persist();
    return true;
  }

  /**
   * 重新计算 nextRunAt（根据 repeat 策略）
   */
  reschedule(id: string): boolean {
    const goal = this.goals.get(id);
    if (!goal) return false;

    const now = new Date();
    goal.lifecycle.runCount++;
    goal.lifecycle.lastRunAt = now.toISOString();

    if (goal.lifecycle.repeat === 'once') {
      goal.lifecycle.status = 'done';
    } else {
      const next = this.computeNextRun(goal, now);
      goal.lifecycle.nextRunAt = next?.toISOString();
      goal.lifecycle.status = 'pending';
    }

    this.persist();
    return true;
  }

  // ================================================================
  // 执行锁
  // ================================================================

  /**
   * 尝试获取执行锁
   */
  acquireLock(goalId: string): GoalExecutionLock | null {
    // 检查已有锁
    const existing = this.locks.get(goalId);
    if (existing) {
      // 锁未过期，拒绝
      if (new Date(existing.expiresAt) > new Date()) {
        return null;
      }
      // 锁已过期，自动释放
      this.locks.delete(goalId);
    }

    const lock: GoalExecutionLock = {
      goalId,
      lockedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + DEFAULT_LOCK_TIMEOUT_MS).toISOString(),
      runId: crypto.randomUUID(),
    };
    this.locks.set(goalId, lock);
    return lock;
  }

  /**
   * 释放执行锁
   */
  releaseLock(goalId: string): void {
    this.locks.delete(goalId);
  }

  /**
   * 检查 Goal 是否正在执行
   */
  isLocked(goalId: string): boolean {
    const lock = this.locks.get(goalId);
    if (!lock) return false;
    if (new Date(lock.expiresAt) <= new Date()) {
      this.locks.delete(goalId);
      return false;
    }
    return true;
  }

  // ================================================================
  // 清理
  // ================================================================

  /**
   * 清理过期/已完成的 Goal
   */
  cleanup(): number {
    const now = new Date();
    let removed = 0;
    for (const [id, goal] of this.goals) {
      if (goal.lifecycle.status === 'done' || goal.lifecycle.status === 'cancelled') {
        if (goal.lifecycle.expiresAt && new Date(goal.lifecycle.expiresAt) <= now) {
          this.goals.delete(id);
          removed++;
        }
      }
    }
    if (removed > 0) this.persist();
    return removed;
  }

  // ================================================================
  // 私有方法
  // ================================================================

  /**
   * 检测重复 Goal
   */
  private findDuplicate(goal: Goal): Goal | undefined {
    for (const g of this.goals.values()) {
      if (g.lifecycle.status === 'done' || g.lifecycle.status === 'cancelled') continue;
      if (g.trigger.type !== goal.trigger.type) continue;
      if (g.trigger.time !== goal.trigger.time) continue;
      if (g.trigger.cron !== goal.trigger.cron) continue;
      if (g.trigger.intervalSeconds !== goal.trigger.intervalSeconds) continue;
      if (JSON.stringify(g.condition) !== JSON.stringify(goal.condition)) continue;
      if (JSON.stringify(g.action) !== JSON.stringify(goal.action)) continue;
      if (g.metadata.createdBy !== goal.metadata.createdBy) continue;
      return g;
    }
    return undefined;
  }

  /**
   * 计算下次执行时间
   */
  private computeNextRun(goal: Goal, from: Date): Date | null {
    const repeat = goal.lifecycle.repeat;

    if (repeat === 'once') return null;

    if (repeat === 'hourly') {
      return new Date(from.getTime() + 60 * 60 * 1000);
    }

    if (repeat === 'daily') {
      const next = new Date(from);
      next.setDate(next.getDate() + 1);
      if (goal.trigger.time) {
        const [h, m] = goal.trigger.time.split(':').map(Number);
        next.setHours(h, m, 0, 0);
      }
      return next;
    }

    if (repeat === 'weekly') {
      const next = new Date(from);
      next.setDate(next.getDate() + 7);
      if (goal.trigger.time) {
        const [h, m] = goal.trigger.time.split(':').map(Number);
        next.setHours(h, m, 0, 0);
      }
      return next;
    }

    if (repeat === 'custom' && goal.lifecycle.customCron) {
      return this.parseCustomCron(goal.lifecycle.customCron, from);
    }

    return null;
  }

  /**
   * 简单 cron 解析（支持分 时 * * *）
   * 完整版建议用 cron-parser 库，v1 用简化实现
   */
  private parseCustomCron(cron: string, from: Date): Date | null {
    // v1 简化：只支持 "分 时 * * *" 格式
    const parts = cron.trim().split(/\s+/);
    if (parts.length !== 5) return null;

    const [minute, hour] = parts;
    const next = new Date(from);
    const m = parseInt(minute, 10);
    const h = parseInt(hour, 10);

    if (isNaN(m) || isNaN(h)) return null;

    next.setHours(h, m, 0, 0);
    if (next <= from) {
      next.setDate(next.getDate() + 1);
    }
    return next;
  }

  /**
   * 从文件加载
   */
  private load(): void {
    try {
      if (!fs.existsSync(this.filePath)) {
        // 首次使用，创建空文件
        const dir = path.dirname(this.filePath);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        this.persist();
        return;
      }

      const raw = fs.readFileSync(this.filePath, 'utf-8');
      const data: GoalPersisted = JSON.parse(raw);
      this.goals = new Map(Object.entries(data.goals ?? {}));
    } catch (err) {
      // 文件损坏，从空状态开始
      console.error('[GoalStore] Failed to load goals.json, starting fresh:', err);
      this.goals = new Map();
    }
  }

  /**
   * 持久化到文件（原子写入）
   */
  private persist(): void {
    const dir = path.dirname(this.filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    const data: GoalPersisted = {
      version: 1,
      updatedAt: new Date().toISOString(),
      goals: Object.fromEntries(this.goals),
    };

    const tmpPath = `${this.filePath}.tmp`;
    fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), 'utf-8');
    fs.renameSync(tmpPath, this.filePath);
  }
}
