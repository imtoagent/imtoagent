// ================================================================
// 时区工具 — 配置驱动的时区管理
// ================================================================
// 原则：
//   1. 内部存储：始终使用 UTC 毫秒时间戳（Date.now() / ISO 8601）
//   2. 用户输入解析：显式指定配置的时区，不依赖服务器本地时区
//   3. 用户展示：显式指定配置的时区
// ================================================================

// ================================================================
// 时区管理器 — 单例，启动时初始化
// ================================================================

let _timezone = 'Asia/Shanghai';

export const TimezoneManager = {
  /**
   * 初始化时区（启动时调用一次）
   * @param tz IANA 时区标识符，如 'Asia/Shanghai'、'America/New_York'
   *           默认 'Asia/Shanghai'
   */
  init(tz?: string) {
    if (tz) {
      _timezone = tz;
    }
    console.log(`[Timezone] Using timezone: ${_timezone}`);
  },

  /** 获取当前时区 */
  getTimezone(): string {
    return _timezone;
  },

  /** 运行时切换时区 */
  setTimezone(tz: string) {
    _timezone = tz;
    console.log(`[Timezone] Changed to: ${_timezone}`);
  },
};

/** 兼容导出：旧代码可直接使用 */
export const TZ = 'Asia/Shanghai' as const;

/** 内部获取当前时区 */
function tz(): string {
  return _timezone;
}

// ================================================================
// 时间解析
// ================================================================

/**
 * 解析 "YYYY-MM-DD HH:MM" 为 UTC 毫秒时间戳（显式配置的时区）
 * 替代 new Date(y, m, d, h, min) 这种依赖本地时区的写法
 */
export function parseShanghaiTime(str: string): number {
  const match = str.match(/^(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2})$/);
  if (!match) return NaN;
  const [, y, mo, d, h, mi] = match.map(Number);

  // 构造该时区的 ISO 字符串，带正确的 UTC 偏移
  const iso = `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}T${String(h).padStart(2, '0')}:${String(mi).padStart(2, '0')}:00`;
  const offset = getOffsetMinutes(tz(), new Date());
  const sign = offset >= 0 ? '+' : '-';
  const absOffset = Math.abs(offset);
  const oh = Math.floor(absOffset / 60);
  const om = absOffset % 60;
  const isoWithOffset = `${iso}${sign}${String(oh).padStart(2, '0')}:${String(om).padStart(2, '0')}`;
  return new Date(isoWithOffset).getTime();
}

/**
 * 解析 "HH:MM" 为今天（配置时区）的 UTC 毫秒时间戳
 */
export function parseTimeTodayShanghai(timeStr: string): number {
  const match = timeStr.match(/^(\d{2}):(\d{2})$/);
  if (!match) return NaN;
  const [, h, m] = match.map(Number);

  const now = new Date();
  const parts = getShanghaiDateParts(now.getTime());
  const iso = `${parts.year}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00`;
  const offset = getOffsetMinutes(tz(), now);
  const sign = offset >= 0 ? '+' : '-';
  const absOffset = Math.abs(offset);
  const oh = Math.floor(absOffset / 60);
  const om = absOffset % 60;
  const isoWithOffset = `${iso}${sign}${String(oh).padStart(2, '0')}:${String(om).padStart(2, '0')}`;
  return new Date(isoWithOffset).getTime();
}

// ================================================================
// UTC 偏移计算
// ================================================================

/**
 * 获取某时区在某时刻的 UTC 偏移（分钟），正值表示时区在 UTC 后面（如 Asia/Shanghai = +480）
 */
function getOffsetMinutes(timezone: string, date: Date): number {
  const utcStr = date.toLocaleString('en-US', { timeZone: 'UTC' });
  const tzStr = date.toLocaleString('en-US', { timeZone: timezone });
  const utcMs = new Date(utcStr).getTime();
  const tzMs = new Date(tzStr).getTime();
  return (tzMs - utcMs) / 60000;
}

// ================================================================
// 日期部件提取
// ================================================================

/**
 * 获取配置时区的 DateParts（年/月/日/时/分/星期）
 * 替代 new Date(ts).getDay() / getDate() 等依赖本地时区的方法
 */
export function getShanghaiDateParts(ts: number = Date.now()) {
  const d = new Date(ts);
  const t = tz();
  const str = d.toLocaleString('en-CA', {
    timeZone: t,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  const [datePart, timePart] = str.split(', ');
  const [year, month, day] = datePart.split('-').map(Number);
  const [hour, minute] = timePart.split(':').map(Number);

  const weekdayStr = d.toLocaleString('en-US', { timeZone: t, weekday: 'short' });
  const weekdayMap: Record<string, number> = {
    Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6,
  };
  const weekday = weekdayMap[weekdayStr] ?? d.getDay();

  return { year, month, day, hour, minute, weekday };
}

// ================================================================
// 格式化
// ================================================================

/**
 * 格式化时间戳为配置时区的可读字符串
 * 替代 toLocaleString('zh-CN') 这种依赖本地时区的写法
 */
export function formatShanghaiTime(ts: number, options?: Intl.DateTimeFormatOptions): string {
  const d = new Date(ts);
  const t = tz();
  const defaultOptions: Intl.DateTimeFormatOptions = {
    timeZone: t,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  };
  return d.toLocaleString('zh-CN', { ...defaultOptions, ...options });
}

/**
 * 格式化时间戳为配置时区的简短时间（月/日 时:分）
 */
export function formatShanghaiTimeShort(ts: number): string {
  return formatShanghaiTime(ts, {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/**
 * 格式化时间戳为配置时区的纯时间（时:分）
 */
export function formatShanghaiTimeOnly(ts: number): string {
  return formatShanghaiTime(ts, {
    hour: '2-digit',
    minute: '2-digit',
  });
}
