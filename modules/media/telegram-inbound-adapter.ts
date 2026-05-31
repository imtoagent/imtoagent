// ================================================================
// TelegramInboundAdapter — Telegram 平台媒体下载适配器
// ================================================================
// 实现 InboundMediaAdapter 接口，负责从 Telegram Bot API 下载消息附件 buffer
// 不负责：存储、MIME sniff、扩展名处理（由 MediaStore 处理）
//
// Telegram Bot API 文件下载流程：
//   1. 调用 /getFile 传入 file_id → 获取 file_path
//   2. 通过 https://api.telegram.org/file/bot<token>/<file_path> 下载
// ================================================================

import type { InboundMediaAdapter, DownloadedMedia, MediaResourceType } from './types';

export interface TelegramInboundAdapterOptions {
  token: string;
  proxy?: string;
  /** 可选：复用父类的代理感知 fetch，避免重复初始化 dispatcher */
  fetchFn?: (url: string, init?: RequestInit) => Promise<Response>;
}

export class TelegramInboundAdapter implements InboundMediaAdapter {
  readonly platform = 'telegram';
  private token: string;
  private apiUrl: string;
  private fileUrl: string;
  private proxy?: string;
  private dispatcher?: unknown; // undici Dispatcher
  private fetchFn?: (url: string, init?: RequestInit) => Promise<Response>;

  constructor(options: TelegramInboundAdapterOptions) {
    this.token = options.token;
    this.proxy = options.proxy;
    this.fetchFn = options.fetchFn;
    this.apiUrl = `https://api.telegram.org/bot${this.token}`;
    this.fileUrl = `https://api.telegram.org/file/bot${this.token}/`;

    // 仅在没有外部 fetchFn 时，自己初始化代理 dispatcher（undici 风格）
    if (!this.fetchFn && this.proxy) {
      try {
        const ProxyAgent = (globalThis as Record<string, unknown>).ProxyAgent;
        if (ProxyAgent) {
          this.dispatcher = new ProxyAgent(this.proxy);
          console.log(`[TelegramInbound] Proxy dispatcher configured: ${this.proxy}`);
        } else {
          console.log(`[TelegramInbound] ⚠️ Proxy configured but ProxyAgent unavailable, will try direct connection`);
        }
      } catch (e: unknown) {
        console.log(`[TelegramInbound] ⚠️ Proxy dispatcher init failed: ${e.message}`);
      }
    }
  }

  async downloadResource(
    messageId: string,
    resourceKey: string,
    type: MediaResourceType,
    fileName?: string
  ): Promise<DownloadedMedia | null> {
    try {
      // Step 1: 调用 getFile 获取 file_path
      const fileResp = await this._fetch(`${this.apiUrl}/getFile`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ file_id: resourceKey }),
      });

      if (!fileResp.ok) {
        console.error(`[TelegramInbound] getFile failed: HTTP ${fileResp.status} (file_id=${resourceKey.slice(-10)})`);
        return null;
      }

      const fileData = await fileResp.json();
      if (!fileData.ok || !fileData.result?.file_path) {
        console.error(`[TelegramInbound] getFile returned invalid: ${JSON.stringify(fileData).slice(0, 200)}`);
        return null;
      }

      const filePath = fileData.result.file_path;
      const fileSize = fileData.result.file_size;

      if (fileSize && fileSize > 20 * 1024 * 1024) {
        console.log(`[TelegramInbound] File too large (${fileSize} bytes), skipping download`);
        return null;
      }

      // Step 2: 下载文件内容
      const downloadUrl = this.fileUrl + filePath;
      const contentResp = await this._fetch(downloadUrl);

      if (!contentResp.ok) {
        console.error(`[TelegramInbound] Download failed: HTTP ${contentResp.status} (path=${filePath})`);
        return null;
      }

      const buffer = Buffer.from(await contentResp.arrayBuffer());
      const contentType = contentResp.headers.get('content-type')?.split(';')[0].trim().toLowerCase() || undefined;

      // 如果 Telegram 没有提供文件名，尝试从 file_path 提取
      const finalFileName = fileName || filePath.split('/').pop() || 'unknown';

      return {
        buffer,
        fileName: finalFileName,
        contentType,
        sourceKey: resourceKey,
      };
    } catch (e: unknown) {
      console.error(`[TelegramInbound] download resource exception: ${e.message}`);
      return null;
    }
  }

  private async _fetch(url: string, init?: RequestInit): Promise<Response> {
    // 优先使用外部注入的 fetchFn（复用父类的代理感知 fetch）
    if (this.fetchFn) {
      return this.fetchFn(url, init);
    }
    // 否则使用自己的 dispatcher
    if (this.dispatcher) {
      return fetch(url, { ...init, dispatcher: this.dispatcher } as RequestInit);
    }
    return fetch(url, init);
  }
}
