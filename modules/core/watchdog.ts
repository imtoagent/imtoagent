// ================================================================
// Watchdog — 自我健康检查
// ================================================================
// L2 防护：检测卡死/失活/OOM，主动退出触发 monitor mode 重启
// ================================================================

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

export interface WatchdogConfig {
  /** 检查间隔（ms），默认 300000（5 分钟） */
  checkIntervalMs?: number;
  /** 无消息超时（分钟），超过则判定卡死，默认 30 */
  idleTimeoutMin?: number;
  /** 系统内存告警阈值（%），仅作参考，不触发退出，默认 80 */
  memoryWarnPercent?: number;
  /** @deprecated 已废弃，改用进程 RSS 硬阈值（3GB） */
  memoryKillPercent?: number;
  /** 最大活跃 session 数，超过则清理最旧的，默认 100 */
  maxSessions?: number;
}

export interface WatchdogOptions {
  /** 获取上次处理消息的时间（由 Bot 层注入） */
  getLastMessageTime: () => number;
  /** 获取活跃 session 数量（由 Bot 层注入） */
  getSessionCount: () => number;
  /** 清理最旧的 N 个 session（由 Bot 层注入） */
  cleanupOldestSessions: (count: number) => void;
  /** 内存感知驱逐空闲 session（由 Bot 层注入） */
  cleanupSessionsByMemory?: () => void;
}

const DEFAULT_CONFIG: Required<WatchdogConfig> = {
  checkIntervalMs: 300_000,    // 5 分钟
  idleTimeoutMin: 30,
  memoryWarnPercent: 80,
  memoryKillPercent: 95,
  maxSessions: 100,
};

export class Watchdog {
  private config: Required<WatchdogConfig>;
  private options: WatchdogOptions;
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private consecutiveIdleAlerts = 0;

  constructor(config: WatchdogConfig = {}, options: WatchdogOptions) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.options = options;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    console.log(`[Watchdog] Started (check every ${this.config.checkIntervalMs / 1000}s, idle timeout ${this.config.idleTimeoutMin}min)`);
    this.timer = setInterval(() => this.check(), this.config.checkIntervalMs);
  }

  stop(): void {
    this.running = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    console.log('[Watchdog] Stopped');
  }

  /**
   * 执行一次健康检查
   */
  private check(): void {
    try {
      this.checkIdle();
      this.checkMemory();
      this.checkSessionCount();
    } catch (e: any) {
      console.error(`[Watchdog] check error: ${e.message}`);
    }
  }

  /**
   * 检查是否卡死：超过 idleTimeoutMin 没有处理消息
   */
  private checkIdle(): void {
    const lastMsgTime = this.options.getLastMessageTime();
    if (lastMsgTime === 0) return; // 从未处理过消息，跳过

    const idleMinutes = (Date.now() - lastMsgTime) / 60_000;
    if (idleMinutes > this.config.idleTimeoutMin) {
      this.consecutiveIdleAlerts++;
      console.warn(
        `[Watchdog] Idle for ${Math.round(idleMinutes)}min (threshold: ${this.config.idleTimeoutMin}min), ` +
        `alert #${this.consecutiveIdleAlerts}`
      );
      if (this.consecutiveIdleAlerts >= 2) {
        // 连续 2 次检查（即空闲超过 2 倍 checkInterval）才退出，避免误判
        console.error(`[Watchdog] Idle timeout confirmed, exiting to trigger restart`);
        process.exit(1);
      }
    } else {
      // 重置计数器
      this.consecutiveIdleAlerts = 0;
    }
  }

  /**
   * 检查内存使用
   * P0 修复：改用进程 RSS 而非系统总内存，避免误杀
   */
  private checkMemory(): void {
    const rssMB = process.memoryUsage().rss / (1024 * 1024);

    // 系统内存作为辅助参考（判断整体压力）
    const totalMemMB = os.totalmem() / (1024 * 1024);
    const freeMemMB = os.freemem() / (1024 * 1024);
    const systemUsedPercent = ((totalMemMB - freeMemMB) / totalMemMB) * 100;

    // 进程 RSS 硬阈值
    const rssWarnMB = 2048;   // 2 GB 告警
    const rssKillMB = 3072;   // 3 GB 退出

    if (rssMB > rssKillMB) {
      console.error(`[Watchdog] Process RSS ${Math.round(rssMB)}MB > kill threshold ${rssKillMB}MB, exiting`);
      process.exit(1);
    }

    if (rssMB > rssWarnMB) {
      console.warn(`[Watchdog] Process RSS ${Math.round(rssMB)}MB > warning threshold ${rssWarnMB}MB`);
      // P0.5: 尝试内存感知驱逐
      if (this.options.cleanupSessionsByMemory) {
        this.options.cleanupSessionsByMemory();
      }
      // P1: 主动 GC
      this.triggerGC();
    }

    // 系统内存作为辅助（仅告警，不退出）
    if (systemUsedPercent > this.config.memoryWarnPercent) {
      console.warn(`[Watchdog] System memory ${Math.round(systemUsedPercent)}% > warning threshold (reference only)`);
    }
  }

  /**
   * P1: 主动 GC 触发
   * 如果 Node.js 启动时加了 --expose-gc，调用 global.gc()
   * 否则跳过，不强制要求启动参数
   */
  private triggerGC(): void {
    const globalObj = global as typeof global & { gc?: () => void };
    if (typeof globalObj.gc === 'function') {
      const beforeMB = Math.round(process.memoryUsage().rss / (1024 * 1024));
      globalObj.gc();
      const afterMB = Math.round(process.memoryUsage().rss / (1024 * 1024));
      const freed = beforeMB - afterMB;
      console.log(`[Watchdog] GC triggered: ${beforeMB}MB → ${afterMB}MB (freed ${freed}MB)`);
    } else {
      console.log('[Watchdog] GC not available (start Node with --expose-gc to enable)');
    }
  }

  /**
   * 检查活跃 session 数量，超限则清理最旧的
   */
  private checkSessionCount(): void {
    const count = this.options.getSessionCount();
    if (count > this.config.maxSessions) {
      const toClean = count - this.config.maxSessions + 10; // 多清 10 个留余量
      console.warn(`[Watchdog] Session count ${count} > max ${this.config.maxSessions}, cleaning ${toClean} oldest`);
      this.options.cleanupOldestSessions(toClean);
    }
  }
}
