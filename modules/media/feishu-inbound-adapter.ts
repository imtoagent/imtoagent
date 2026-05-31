// ================================================================
// FeishuInboundAdapter — 飞书平台媒体下载适配器
// ================================================================
// 实现 InboundMediaAdapter 接口，负责从飞书 API 下载消息附件 buffer
// 不负责：存储、MIME sniff、扩展名处理（由 MediaStore 处理）
// ================================================================

import type { InboundMediaAdapter, DownloadedMedia, MediaResourceType } from '../media/types';
import * as Lark from '@larksuiteoapi/node-sdk';

export interface FeishuInboundAdapterOptions {
  appId: string;
  appSecret: string;
}

export class FeishuInboundAdapter implements InboundMediaAdapter {
  readonly platform = 'feishu';
  private appId: string;
  private appSecret: string;
  private client: Lark.Client;
  private _appToken: string | null = null;
  private _appTokenExpiresAt = 0;  // 飞书 tenant_token 约 2 小时有效，提前 5 分钟刷新

  constructor(options: FeishuInboundAdapterOptions) {
    this.appId = options.appId;
    this.appSecret = options.appSecret;
    this.client = new Lark.Client({ appId: options.appId, appSecret: options.appSecret });
  }

  async downloadResource(
    messageId: string,
    resourceKey: string,
    type: MediaResourceType,
    fileName?: string
  ): Promise<DownloadedMedia | null> {
    try {
      const token = await this.getAppToken();
      const url = `https://open.feishu.cn/open-apis/im/v1/messages/${messageId}/resources/${resourceKey}?type=${type}`;

      const resp = await fetch(url, {
        headers: { Authorization: `Bearer ${token}` },
      });

      if (!resp.ok) {
        // 容错：文件类型 502 时尝试用 media 类型重试
        if (resp.status === 502 && type === 'file') {
          console.log(`[FeishuInbound] file type returned 502, retrying with media type`);
          const retryUrl = `https://open.feishu.cn/open-apis/im/v1/messages/${messageId}/resources/${resourceKey}?type=media`;
          const retryResp = await fetch(retryUrl, {
            headers: { Authorization: `Bearer ${token}` },
          });
          if (retryResp.ok) {
            const retryBuffer = Buffer.from(await retryResp.arrayBuffer());
            const retryContentType = retryResp.headers.get('content-type')?.split(';')[0].trim().toLowerCase() || undefined;
            return {
              buffer: retryBuffer,
              fileName,
              contentType: retryContentType,
              sourceKey: resourceKey,
            };
          }
        }
        console.error(`[FeishuInbound] download message resource failed: HTTP ${resp.status} (key=${resourceKey})`);
        return null;
      }

      const buffer = Buffer.from(await resp.arrayBuffer());
      const contentType = resp.headers.get('content-type')?.split(';')[0].trim().toLowerCase() || undefined;

      return {
        buffer,
        fileName,
        contentType,
        sourceKey: resourceKey,
      };
    } catch (e: unknown) {
      console.error(`[FeishuInbound] download message resource exception: ${e.message}`);
      return null;
    }
  }

  private async getAppToken(): Promise<string> {
    const now = Date.now();
    // 提前 5 分钟刷新，避免刚好过期
    if (this._appToken && this._appTokenExpiresAt > now + 5 * 60 * 1000) {
      return this._appToken;
    }

    const resp = await fetch('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        app_id: this.appId,
        app_secret: this.appSecret,
      }),
    });

    const data = await resp.json();
    if (data.code !== 0 || !data.tenant_access_token) {
      throw new Error(`Failed to get Feishu tenant_access_token: ${JSON.stringify(data)}`);
    }

    this._appToken = data.tenant_access_token;
    // 飞书 tenant_token 有效期约 2 小时
    this._appTokenExpiresAt = now + 2 * 60 * 60 * 1000;
    return this._appToken;
  }
}
