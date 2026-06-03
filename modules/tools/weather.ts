// ================================================================
// Weather Tool — 查询城市天气
// ================================================================
// Phase 2：为 Goal Engine 提供天气查询能力
//
// v1 简化实现：
//   - 用 web_fetch / fetch 调用 wttr.in API
//   - 返回结构化天气结果
//   - 后续可加国内 API（高德等）
// ================================================================

import type { ToolDefinition } from '../agent/tool-registry';

export interface WeatherResult {
  city: string;
  temperature: number;
  weather: string;
  rain: boolean;
  humidity: number;
}

/**
 * 从 wttr.in 响应中提取天气数据
 */
function parseWttrIn(data: any): WeatherResult | null {
  if (!data?.current_condition?.[0]) return null;

  const current = data.current_condition[0];
  const temp = parseInt(current.temp_C, 10) || 0;
  const desc = current.weatherDesc?.[0]?.value || current.weatherCode || '未知';
  const humidity = parseInt(current.humidity, 10) || 0;
  const rain = (current.precipMM ? parseFloat(current.precipMM) : 0) > 0;

  // 中文天气描述映射
  const weatherMap: Record<string, string> = {
    'Sunny': '晴', 'Clear': '晴', 'Partly cloudy': '多云',
    'Cloudy': '多云', 'Overcast': '阴', 'Mist': '雾',
    'Patchy rain possible': '可能有雨', 'Patchy light rain': '小雨',
    'Light rain': '小雨', 'Moderate rain': '中雨', 'Heavy rain': '大雨',
    'Patchy snow possible': '可能有雪', 'Light snow': '小雪',
    'Heavy snow': '大雪', 'Thundery outbreaks possible': '雷阵雨',
    'Fog': '雾', 'Blizzard': '暴雪',
  };

  // 尝试匹配英文描述
  const enDesc = current.weatherDesc?.[0]?.value || '';
  let weather = weatherMap[enDesc] || enDesc || desc;

  // 如果英文描述无法匹配，尝试从中文城市名推断
  if (!weather || weather === '未知') {
    weather = desc;
  }

  return {
    city: data.nearest_area?.[0]?.areaName?.[0]?.value || '未知',
    temperature: temp,
    weather,
    rain,
    humidity,
  };
}

export const weatherTool: ToolDefinition = {
  name: 'get_weather',
  description: '查询指定城市的当前天气',
  parameters: {
    type: 'object',
    properties: {
      city: { type: 'string', description: '城市名（中文或拼音）' },
    },
    required: [],
  },
  handler: async (params: Record<string, unknown>): Promise<WeatherResult> => {
    const city = (params.city as string) || 'auto';

    // v1: 用 wttr.in API（免费、无需 key）
    // 中文城市名直接拼 URL，wttr.in 支持拼音/英文名
    const cityParam = city === 'auto' ? '' : encodeURIComponent(city);
    const url = `https://wttr.in/${cityParam}?format=j1`;

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 8000);

      const response = await fetch(url, {
        signal: controller.signal,
        headers: { 'Accept-Language': 'zh-CN' },
      });

      clearTimeout(timeout);

      if (!response.ok) {
        throw new Error(`wttr.in responded ${response.status}`);
      }

      const data = await response.json();
      const result = parseWttrIn(data);

      if (!result) {
        return {
          city: city === 'auto' ? 'auto' : city,
          temperature: 0,
          weather: '解析失败',
          rain: false,
          humidity: 0,
        };
      }

      // 如果用户指定了中文名，覆盖城市名
      if (city !== 'auto') {
        result.city = city;
      }

      return result;
    } catch (e: any) {
      // 降级：返回错误信息
      if (e.name === 'AbortError') {
        return {
          city: city === 'auto' ? 'auto' : city,
          temperature: 0,
          weather: '超时',
          rain: false,
          humidity: 0,
        };
      }
      return {
        city: city === 'auto' ? 'auto' : city,
        temperature: 0,
        weather: `错误: ${e.message}`,
        rain: false,
        humidity: 0,
      };
    }
  },
};

/**
 * 根据条件判断天气是否满足条件
 * 用于 Goal Engine 的 condition 检查
 */
export async function checkWeatherCondition(
  city: string,
  field: string,
  expected: unknown,
  operator: string = 'eq',
): Promise<boolean> {
  const weather = await weatherTool.handler({ city });

  const actual = (weather as any)[field];
  if (actual === undefined) return false;

  switch (operator) {
    case 'eq': return actual === expected;
    case 'ne': return actual !== expected;
    case 'gt': return Number(actual) > Number(expected);
    case 'lt': return Number(actual) < Number(expected);
    case 'gte': return Number(actual) >= Number(expected);
    case 'lte': return Number(actual) <= Number(expected);
    case 'contains': return String(actual).includes(String(expected));
    default: return actual === expected;
  }
}
