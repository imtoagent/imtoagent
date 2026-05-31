// Telegram IM 适配器
// 实现 IMModule 接口，对接 Telegram Bot API（长轮询模式）
//
// 使用方式：config.json bot 配置 "im": "telegram"
//   appId    = Bot Token（从 @BotFather 获取）
//   appSecret = 留空即可

import type { IMModule, IMCapabilities, MessageHandler } from '../types';
import type { UnifiedBlock } from '../capabilities';
import type { MessageAttachment } from '../core/types';
import { TelegramInboundAdapter, MediaStore, InboundMediaResolver } from '../media';

export interface TelegramConfig {
  /** Bot Token（从 @BotFather 获取） */
  token: string;
  /** HTTP 代理地址（直连被墙时使用，如 http://127.0.0.1:7890） */
  proxy?: string;
}

// ================================================================
// Telegram 消息类型（长轮询 getUpdates 返回的 message 结构）
// ================================================================

interface TelegramPhoto {
  file_id: string;
  file_unique_id: string;
  file_size?: number;
  width: number;
  height: number;
}

interface TelegramFile {
  file_id: string;
  file_unique_id: string;
  file_size?: number;
  file_name?: string;
  mime_type?: string;
}

interface TelegramAudio {
  file_id: string;
  file_unique_id: string;
  file_size?: number;
  duration: number;
  mime_type?: string;
  file_name?: string;
}

interface TelegramVoice {
  file_id: string;
  file_unique_id: string;
  file_size?: number;
  duration: number;
  mime_type?: string;
}

interface TelegramVideo {
  file_id: string;
  file_unique_id: string;
  file_size?: number;
  width: number;
  height: number;
  duration: number;
  mime_type?: string;
  file_name?: string;
}

interface TelegramMessage {
  message_id: number;
  date: number;
  chat: { id: number; type: string; title?: string; username?: string };
  from?: { id: number; is_bot: boolean; first_name: string; username?: string };
  text?: string;
  caption?: string;
  photo?: TelegramPhoto[];       // 照片数组（按尺寸排列，取最后一个最大）
  document?: TelegramFile;
  audio?: TelegramAudio;
  voice?: TelegramVoice;
  video?: TelegramVideo;
  sticker?: TelegramFile;
}

interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  edited_message?: TelegramMessage;
}

export class TelegramAdapter implements IMModule {
  private token: string;
  private apiUrl: string;
  private proxy?: string;
  private handler: MessageHandler | null = null;
  private running = false;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private lastUpdateId = 0;

  // ================================================================
  // Inbound Media — 适配器 + 抽象层
  // ================================================================
  private _inboundAdapter: TelegramInboundAdapter | null = null;
  private _mediaStore: MediaStore | null = null;
  private _mediaResolver: InboundMediaResolver | null = null;

  // ================================================================
  // 熔断 + 指数退避：网络受限时避免刷屏和拖垮进程
  // ================================================================
  private consecutiveFailures = 0;    // 连续失败次数
  private circuitOpen = false;        // 熔断器状态
  private backoffMs = 100;            // 当前退避间隔
  private readonly maxBackoffMs = 60_000;   // 最大退避 60s
  private readonly failureThreshold = 5;    // 连续 N 次失败后进入熔断
  private readonly recoveryInterval = 30_000; // 熔断后每 30s 试探一次
  private warnedCircuitOpen = false;  // 避免重复打印熔断日志
  private warnedPollError = false;    // 避免重复打印轮询错误日志

  constructor(cfg: TelegramConfig) {
    this.token = cfg.token;
    this.proxy = cfg.proxy;
    this.apiUrl = `https://api.telegram.org/bot${this.token}`;

    if (cfg.proxy) {
      console.log(`[Telegram] Proxy configured: ${cfg.proxy} (local only, does not affect other modules)`);
    }
  }

  // ================================================================
  // 入站媒体层初始化（延迟创建，需要 token）
  // ================================================================

  private ensureMediaResolver(): InboundMediaResolver {
    if (!this._mediaResolver) {
      this._inboundAdapter = new TelegramInboundAdapter({
        token: this.token,
        // Share parent's proxy-aware fetch to avoid duplicating proxy logic
        fetchFn: (url, init) => this._fetch(url, init),
      });
      this._mediaStore = new MediaStore();
      this._mediaResolver = new InboundMediaResolver(this._inboundAdapter, this._mediaStore);
    }
    return this._mediaResolver;
  }

  // ================================================================
  // 代理感知的 fetch
  // ================================================================

  private async _fetch(url: string, init?: RequestInit): Promise<Response> {
    // Node.js 原生 fetch 不支持 proxy 选项
    // 如果有代理配置，使用环境变量或 dispatcher（undici/Bun）
    if (this.proxy) {
      try {
        // Bun 原生支持 proxy 选项
        if ((globalThis as Record<string, unknown>).Bun) {
          return fetch(url, { ...init, proxy: this.proxy } as RequestInit);
        }
        // Node.js: 尝试使用 undici 的 ProxyAgent
        const { ProxyAgent } = await import('undici');
        if (ProxyAgent) {
          const dispatcher = new ProxyAgent(this.proxy);
          return fetch(url, { ...init, dispatcher } as RequestInit);
        }
      } catch (e: unknown) {
        // 降级：设置环境变量（影响全局，但总比没有好）
        if (!process.env.HTTPS_PROXY && !process.env.https_proxy) {
          process.env.HTTPS_PROXY = this.proxy;
          console.log(`[Telegram] Set HTTPS_PROXY=${this.proxy}`);
        }
      }
    }
    return fetch(url, init);
  }

  // ================================================================
  // 能力声明
  // ================================================================

  getCapabilities(): IMCapabilities {
    return {
      text: true,
      codeBlock: true,       // MarkdownV2 supports ``` code blocks
      cardMessage: false,    // Telegram has no native cards, sendBlocks falls back to text
      fileSend: true,
      imageSend: true,
      audioSend: true,
      buttonAction: true,    // Inline keyboard
      maxTextLength: 4096,
    };
  }

  // ================================================================
  // 生命周期
  // ================================================================

  start(handler: MessageHandler): void {
    this.handler = handler;
    this.running = true;
    this._poll();
    console.log('[Telegram] Long polling started');
  }

  stop(): void {
    this.running = false;
    if (this.pollTimer) { clearTimeout(this.pollTimer); this.pollTimer = null; }
    console.log('[Telegram] Stopped');
  }

  // ================================================================
  // 长轮询
  // ================================================================

  private async _poll(): Promise<void> {
    if (!this.running) return;

    let success = false;

    try {
      const url = `${this.apiUrl}/getUpdates?timeout=${this.circuitOpen ? 5 : 30}&offset=${this.lastUpdateId + 1}`;
      const res = await this._fetch(url);
      const data = await res.json();

      if (data.ok && data.result) {
        for (const update of data.result as TelegramUpdate[]) {
          this.lastUpdateId = update.update_id;
          const msg = update.message || update.edited_message;
          if (!msg) continue;

          // 解析消息文本和媒体附件
          const { text, attachments } = await this._parseMessage(msg);
          if (!text && attachments.length === 0) continue;

          const chatId = String(msg.chat.id);
          const userId = String(msg.from?.id || msg.chat.id);

          if (this.handler) {
            this.handler(chatId, text, userId, attachments.length > 0 ? attachments : undefined).catch(e =>
              console.error('[Telegram] Message processing error:', e.message)
            );
          }
        }
        success = true;
      }
    } catch (e: unknown) {
      if (!this.warnedPollError) {
        console.error('[Telegram] Long poll error:', e.message);
        this.warnedPollError = true;
      }
    }

    if (success) {
      this._onSuccess();
    } else {
      this._onFailure();
    }

    this.pollTimer = setTimeout(() => this._poll(), this.backoffMs);
  }

  // ================================================================
  // 解析 Telegram 消息 — 提取文本 + 媒体附件
  // ================================================================

  private async _parseMessage(msg: TelegramMessage): Promise<{ text: string; attachments: MessageAttachment[] }> {
    const attachments: MessageAttachment[] = [];
    let text = msg.text || '';

    // 收集所有媒体字段
    const mediaItems: Array<{ fileId: string; type: 'image' | 'file' | 'media'; fileName?: string }> = [];

    // 照片（取最大尺寸）
    if (msg.photo && msg.photo.length > 0) {
      const largest = msg.photo[msg.photo.length - 1];
      mediaItems.push({ fileId: largest.file_id, type: 'image' });
    }

    // 文档/文件
    if (msg.document) {
      mediaItems.push({
        fileId: msg.document.file_id,
        type: 'file',
        fileName: msg.document.file_name,
      });
    }

    // 音频
    if (msg.audio) {
      mediaItems.push({
        fileId: msg.audio.file_id,
        type: 'media',
        fileName: msg.audio.file_name,
      });
    }

    // 语音
    if (msg.voice) {
      mediaItems.push({
        fileId: msg.voice.file_id,
        type: 'media',
        fileName: 'voice.ogg',
      });
    }

    // 视频
    if (msg.video) {
      mediaItems.push({
        fileId: msg.video.file_id,
        type: 'media',
        fileName: msg.video.file_name || 'video.mp4',
      });
    }

    // 贴纸
    if (msg.sticker) {
      mediaItems.push({
        fileId: msg.sticker.file_id,
        type: 'image',
        fileName: 'sticker.webp',
      });
    }

    // 下载媒体附件
    if (mediaItems.length > 0) {
      try {
        const resolver = this.ensureMediaResolver();
        const requests = mediaItems.map(item => ({
          messageId: String(msg.message_id),
          resourceKey: item.fileId,
          type: item.type,
          fileName: item.fileName,
        }));

        const result = await resolver.resolveAll(requests);
        attachments.push(...result.attachments);

        // 补充 Telegram 特有的字段
        if (msg.audio) {
          const audioAtt = attachments.find(a => a.type === 'audio');
          if (audioAtt) audioAtt.durationMs = msg.audio.duration * 1000;
        }
        if (msg.voice) {
          const voiceAtt = attachments.find(a => a.type === 'audio');
          if (voiceAtt) voiceAtt.durationMs = msg.voice.duration * 1000;
        }
      } catch (e: unknown) {
        console.error('[Telegram] Media resolution error:', e.message);
      }
    }

    // 如果媒体有 caption，拼接到文本
    if (msg.caption) {
      text = text ? `${text}\n${msg.caption}` : msg.caption;
    }

    // 纯媒体消息（无文本无caption），生成占位文本
    if (!text && attachments.length > 0) {
      const types = attachments.map(a => {
        if (a.type === 'image') return 'image';
        if (a.type === 'audio') return 'voice';
        return 'file';
      });
      text = `[User sent ${types.join(', ')}]`;
    }

    return { text: text.trim(), attachments };
  }

  // ================================================================
  // 熔断/退避
  // ================================================================

  /** 成功后重置所有状态 */
  private _onSuccess(): void {
    if (this.circuitOpen) {
      console.log('[Telegram] Network recovered, long polling restored');
    }
    this.circuitOpen = false;
    this.consecutiveFailures = 0;
    this.backoffMs = 100;
    this.warnedCircuitOpen = false;
    this.warnedPollError = false;
  }

  /** 失败后指数退避，超过阈值进入熔断 */
  private _onFailure(): void {
    this.consecutiveFailures++;

    if (this.consecutiveFailures >= this.failureThreshold && !this.circuitOpen) {
      this.circuitOpen = true;
      this.backoffMs = this.recoveryInterval;
      if (!this.warnedCircuitOpen) {
        console.error('[Telegram] ⚠️ Consecutive failures, circuit breaker activated (probing recovery every 30s)');
        this.warnedCircuitOpen = true;
      }
    } else if (!this.circuitOpen) {
      // 指数退避: 100 → 200 → 400 → 800 → 1600 → ...
      this.backoffMs = Math.min(this.backoffMs * 2, this.maxBackoffMs);
    }
    // 熔断中保持 recoveryInterval 间隔
  }

  // ================================================================
  // 文本发送
  // ================================================================

  async reply(chatId: string, text: string, maxLen = 4096): Promise<void> {
    const safe = text.length > maxLen ? text.slice(0, maxLen) + '\n\n…(truncated)' : text;
    await this._api('sendMessage', {
      chat_id: chatId,
      text: safe,
      parse_mode: 'MarkdownV2',
      link_preview_options: { is_disabled: true },
    }).catch(() =>
      // MarkdownV2 解析失败时降级为纯文本
      this._api('sendMessage', {
        chat_id: chatId,
        text: safe,
        link_preview_options: { is_disabled: true },
      })
    );
  }

  async sendProgress(chatId: string, text: string): Promise<void> {
    // Telegram 用"正在输入..."状态 + 临时消息
    await this._api('sendChatAction', { chat_id: chatId, action: 'typing' }).catch(() => {});
    await this.reply(chatId, text);
  }

  // ================================================================
  // 富文本块发送（降级为 MarkdownV2 文本）
  // ================================================================

  async sendBlocks(chatId: string, blocks: UnifiedBlock[]): Promise<void> {
    const lines: string[] = [];

    for (const block of blocks) {
      switch (block.type) {
        case 'text':
          lines.push(block.content);
          break;

        case 'code_block': {
          const lang = block.language || '';
          lines.push(`\`\`\`${lang}\n${block.code}\n\`\`\``);
          break;
        }

        case 'image':
          if (block.url) {
            try {
              await this.sendImageByUrl(chatId, block.url, block.alt);
            } catch (e: unknown) {
              lines.push(`⚠️ Image load failed`);
            }
          }
          break;

        case 'file':
          if (block.url) {
            try {
              await this.sendFileByUrl(chatId, block.url, block.filename);
            } catch (e: unknown) {
              lines.push(`⚠️ File send failed: ${block.filename}`);
            }
          }
          break;

        case 'card':
          lines.push(`*${this._escape(block.title)}*`);
          if (block.content) lines.push(block.content);
          if (block.buttons?.length) {
            await this._sendInlineButtons(chatId, lines.join('\n'), block.buttons);
            return; // Button message already sent, don't continue concatenating
          }
          break;

        case 'table': {
          const tableLines: string[] = [];
          tableLines.push('| ' + block.headers.join(' | ') + ' |');
          tableLines.push('| ' + block.headers.map(() => '---').join(' | ') + ' |');
          for (const row of block.rows) {
            tableLines.push('| ' + row.join(' | ') + ' |');
          }
          if (block.caption) lines.push(`*${this._escape(block.caption)}*`);
          lines.push(tableLines.join('\n'));
          break;
        }

        case 'audio':
          if (block.url) {
            try {
              await this._sendAudio(chatId, block.url, block.filename);
            } catch (e: unknown) {
              lines.push(`⚠️ Audio send failed`);
            }
          }
          break;

        case 'divider':
          lines.push('---');
          break;
      }
    }

    const text = lines.join('\n\n').trim();
    if (text) await this.reply(chatId, text);
  }

  // ================================================================
  // 图片
  // ================================================================

  async sendImage(chatId: string, imageKey: string, alt?: string): Promise<void> {
    // imageKey 可能是 file_id 或 URL
    await this._api('sendPhoto', {
      chat_id: chatId,
      photo: imageKey,
      caption: alt || '',
    }).catch(async () => {
      console.error(`[Telegram] Image send failed`);
    });
  }

  private async sendImageByUrl(chatId: string, url: string, alt?: string): Promise<void> {
    let imageSource: string;

    if (url.startsWith('file://')) {
      const filePath = url.replace('file://', '');
      const blob = new Blob([require('fs').readFileSync(filePath)]);
      const form = new FormData();
      form.append('chat_id', chatId);
      form.append('photo', blob, 'image.png');
      if (alt) form.append('caption', alt);
      await this._fetch(`${this.apiUrl}/sendPhoto`, { method: 'POST', body: form });
    } else {
      await this._api('sendPhoto', {
        chat_id: chatId,
        photo: url,
        caption: alt || '',
      });
    }
  }

  // ================================================================
  // 文件
  // ================================================================

  async sendFile(chatId: string, fileKey: string, fileName: string): Promise<void> {
    await this._api('sendDocument', {
      chat_id: chatId,
      document: fileKey,
      caption: fileName,
    }).catch(() => {
      console.error(`[Telegram] File send failed: ${fileName}`);
    });
  }

  private async sendFileByUrl(chatId: string, url: string, filename: string): Promise<void> {
    if (url.startsWith('file://')) {
      const filePath = url.replace('file://', '');
      const buffer = require('fs').readFileSync(filePath);
      const blob = new Blob([buffer]);
      const form = new FormData();
      form.append('chat_id', chatId);
      form.append('document', blob, filename);
      form.append('caption', filename);
      await this._fetch(`${this.apiUrl}/sendDocument`, { method: 'POST', body: form });
    } else {
      await this._api('sendDocument', {
        chat_id: chatId,
        document: url,
        caption: filename,
      });
    }
  }

  // ================================================================
  // 音频
  // ================================================================

  private async _sendAudio(chatId: string, url: string, filename: string): Promise<void> {
    if (url.startsWith('file://')) {
      const filePath = url.replace('file://', '');
      const buffer = require('fs').readFileSync(filePath);
      const blob = new Blob([buffer]);
      const form = new FormData();
      form.append('chat_id', chatId);
      form.append('audio', blob, filename);
      await this._fetch(`${this.apiUrl}/sendAudio`, { method: 'POST', body: form });
    } else {
      await this._api('sendAudio', { chat_id: chatId, audio: url });
    }
  }

  // ================================================================
  // 内联按钮
  // ================================================================

  private async _sendInlineButtons(chatId: string, text: string, buttons: { label: string; url?: string }[]): Promise<void> {
    const keyboard = {
      inline_keyboard: [buttons.map(b => ({
        text: b.label,
        url: b.url || 'https://t.me',
      }))],
    };

    await this._api('sendMessage', {
      chat_id: chatId,
      text,
      parse_mode: 'MarkdownV2',
      reply_markup: keyboard,
      link_preview_options: { is_disabled: true },
    }).catch(() =>
      this._api('sendMessage', {
        chat_id: chatId,
        text,
        reply_markup: keyboard,
        link_preview_options: { is_disabled: true },
      })
    );
  }

  // ================================================================
  // 工具方法
  // ================================================================

  private async _api(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    const res = await this._fetch(`${this.apiUrl}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
    });
    return res.json();
  }

  /** MarkdownV2 转义（Telegram 要求转义特殊字符） */
  private _escape(text: string): string {
    return text.replace(/[_*[\]()~`>#+\-=|{}.!]/g, '\\$&');
  }
}
