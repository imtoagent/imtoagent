// ================================================================
// HTTP Request Adapter — 为 Anthropic Proxy 提供 tool-call-loop 兼容的 fetch 接口
// ================================================================
// Anthropic Proxy 使用 http.request，tool-call-loop 使用 fetch 接口
// 此模块将 http.request 包装为 HttpRequestFn，使两个 Proxy 共享同一套 Loop 逻辑
// ================================================================

import * as http from 'http';
import * as https from 'https';
import type { HttpRequestFn } from './tool-call-loop';

/**
 * 创建 http.request 包装函数
 *
 * 注意：这个 adapter 用于 Tool-Call Loop 内部的非流式探测请求。
 * 它使用与 Anthropic Proxy 相同的主机/协议/API Key。
 *
 * @param proto - 'http' 或 'https'
 * @param baseUrl - 完整上游 URL（含 hostname + path）
 * @param apiKey - API Key
 * @param isAnthropicFormat - 是否为 Anthropic 格式
 */
export function createHttpRequestAdapter(
  proto: string,
  baseUrl: URL,
  apiKey: string,
  isAnthropicFormat: boolean,
): HttpRequestFn {
  return (url: string, options) => {
    return new Promise((resolve, reject) => {
      const requestProto = proto === 'https' ? https : http;

      const reqOptions: http.RequestOptions = {
        hostname: baseUrl.hostname,
        port: baseUrl.port || (proto === 'https' ? 443 : 80),
        path: baseUrl.pathname,
        method: options.method,
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(options.body),
          ...(isAnthropicFormat
            ? { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' }
            : { Authorization: `Bearer ${apiKey}` }),
        },
        timeout: 60_000,
      };

      const req = requestProto.request(reqOptions, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          const body = Buffer.concat(chunks);
          resolve({
            ok: (res.statusCode || 500) >= 200 && (res.statusCode || 500) < 300,
            status: res.statusCode || 500,
            statusText: res.statusMessage || '',
            text: () => Promise.resolve(body.toString('utf-8')),
            json: () => Promise.resolve(JSON.parse(body.toString('utf-8'))),
          });
        });
        res.on('error', reject);
      });

      req.on('error', reject);
      req.on('timeout', () => {
        req.destroy();
        reject(new Error('http request timeout'));
      });

      req.write(options.body);
      req.end();
    });
  };
}
