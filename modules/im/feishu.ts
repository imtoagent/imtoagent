// 飞书 IM 模块
// 封装 Lark SDK：WS 长连接(含自动重连)、消息收发
// 支持：纯文本、富文本卡片、图片、文件、表格、语音、富文本帖子

import * as Lark from '@larksuiteoapi/node-sdk';
import type { IMModule, IMCapabilities, MessageHandler } from '../types';
import type { UnifiedBlock } from '../capabilities';
import type { MessageAttachment } from '../core/types';
import type { FeishuMessageEvent, FeishuCardMessage, FeishuPostParagraph, FeishuPostElement } from './im-types';
import * as fs from 'fs';
import * as path from 'path';
import { getDataDir } from '../utils/paths';
import { logEvent } from '../utils/logger';
import { FeishuInboundAdapter, MediaStore, InboundMediaResolver, InboundMediaAdapter } from '../media';

export interface FeishuConfig {
  appId: string;
  appSecret: string;
}

// 飞书消息卡片元素类型
interface CardElement {
  tag: string;
  [key: string]: unknown;
}

interface CardAction {
  tag: string;
  [key: string]: unknown;
}

// Token 缓存条目，含过期时间
interface TokenEntry {
  token: string;
  expiresAt: number;  // 毫秒时间戳
}

export class FeishuIMModule implements IMModule {
  private client: Lark.Client;
  private wsClient: Lark.WSClient | null = null;
  private appId: string;
  private appSecret: string;
  private messageHandler: MessageHandler | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempts = 0;
  private running = false;
  private _tenantAccessToken: TokenEntry | null = null;
  private _appAccessToken: TokenEntry | null = null;

  // Inbound Media — 适配器 + 抽象层
  private _inboundAdapter: InboundMediaAdapter;
  private _mediaStore: MediaStore;
  private _mediaResolver: InboundMediaResolver;

  // File upload limits
  private maxFileSize = 20 * 1024 * 1024; // 20MB (Feishu file message limit)

  constructor(cfg: FeishuConfig) {
    this.appId = cfg.appId;
    this.appSecret = cfg.appSecret;
    this.client = new Lark.Client({
      appId: cfg.appId,
      appSecret: cfg.appSecret,
      loggerLevel: Lark.LoggerLevel.info,
    });

    // 初始化 Inbound Media 层（适配器 + 存储 + 解析器）
    this._inboundAdapter = new FeishuInboundAdapter({ appId: cfg.appId, appSecret: cfg.appSecret });
    this._mediaStore = new MediaStore();
    this._mediaResolver = new InboundMediaResolver(this._inboundAdapter, this._mediaStore);
  }

  // ================================================================
  // 认证（带过期检查，提前 5 分钟刷新）
  // ================================================================

  private async getTenantToken(): Promise<string> {
    const now = Date.now();
    if (this._tenantAccessToken && this._tenantAccessToken.expiresAt > now + 5 * 60 * 1000) {
      return this._tenantAccessToken.token;
    }

    try {
      const res = await this.client.request({
        method: 'POST',
        url: '/open-apis/auth/v3/tenant_access_token/internal',
        data: { app_id: this.appId, app_secret: this.appSecret },
      });
      if (res.code === 0 && res.tenant_access_token) {
        // 飞书 tenant_token 有效期约 2 小时
        this._tenantAccessToken = {
          token: res.tenant_access_token,
          expiresAt: now + 2 * 60 * 60 * 1000,
        };
        return this._tenantAccessToken.token;
      }
      throw new Error(`Failed to get token: ${res.code} ${res.msg}`);
    } catch (e: unknown) {
      throw new Error(`Failed to get token: ${e.message}`);
    }
  }

  private async getAppToken(): Promise<string> {
    const now = Date.now();
    if (this._appAccessToken && this._appAccessToken.expiresAt > now + 5 * 60 * 1000) {
      return this._appAccessToken.token;
    }

    try {
      const res = await this.client.request({
        method: 'POST',
        url: '/open-apis/auth/v3/app_access_token/internal',
        data: { app_id: this.appId, app_secret: this.appSecret },
      });
      if (res.code === 0 && res.app_access_token) {
        // Feishu app_token valid for ~2 hours
        this._appAccessToken = {
          token: res.app_access_token,
          expiresAt: now + 2 * 60 * 60 * 1000,
        };
        return this._appAccessToken.token;
      }
      throw new Error(`Failed to get app token: ${res.code} ${res.msg}`);
    } catch (e: unknown) {
      throw new Error(`Failed to get app token: ${e.message}`);
    }
  }

  // ================================================================
  // 基础发送
  // ================================================================

  async reply(chatId: string, text: string, maxLen = 140000) {
    const safe = text.length > maxLen ? text.slice(0, maxLen) + '\n\n...(truncated)' : text;
    try {
      await this.client.im.message.create({
        params: { receive_id_type: 'chat_id' },
        data: { receive_id: chatId, msg_type: 'text', content: JSON.stringify({ text: safe }) },
      });
      logEvent({ event: 'im_message_sent', adapter: 'feishu', chatId, textLength: safe.length });
    } catch (e: unknown) {
      console.error(`[Feishu] Reply failed: ${e.message}`);
      logEvent({ event: 'im_send_error', adapter: 'feishu', chatId, error: (e as Error).message });
    }
  }

  async sendProgress(chatId: string, text: string) {
    try {
      await this.client.im.message.create({
        params: { receive_id_type: 'chat_id' },
        data: { receive_id: chatId, msg_type: 'text', content: JSON.stringify({ text }) },
      });
    } catch (e: unknown) {
      console.error(`[Feishu] Progress notification failed: ${e.message}`);
    }
  }

  // ================================================================
  // Markdown 样式优化（参考 larksuite/cli optimizeMarkdownStyle）
  // ================================================================
  // 1. H1-H3 标题在飞书卡片/帖子中渲染过大 → 降级为 H4-H5
  // 2. 连续标题间无间距 → 补空行
  // 3. 表格与前后文粘连 → 补空行
  // 4. 多余空行（>2）→ 压缩为双空行

  private optimizeMarkdownStyle(text: string): string {
    const codeBlockRegex = /```[\s\S]*?```/g;
    const codeBlocks: string[] = [];
    const protectedText = text.replace(codeBlockRegex, (m) => {
      codeBlocks.push(m);
      return `___CB_${codeBlocks.length - 1}___`;
    });

    let result = protectedText;

    // 标题降级：只在原文含 H1-H3 时触发
    if (/^#{1,3} /m.test(text)) {
      result = result.replace(/^### (.+)$/gm, '##### $1');  // H3→H5
      result = result.replace(/^## (.+)$/gm, '##### $1');   // H2→H5
      result = result.replace(/^# (.+)$/gm, '#### $1');     // H1→H4
    }

    // 连续标题间补空行
    result = result.replace(/^(#{4,5} .+)\n(#{4,5} )/gm, '$1\n\n$2');

    // 表格上面补空行
    result = result.replace(/^([^|\n].*)\n(\|.+\|)/gm, '$1\n\n$2');

    // 还原代码块
    for (let i = 0; i < codeBlocks.length; i++) {
      result = result.replace(`___CB_${i}___`, codeBlocks[i]);
    }

    // 压缩多余空行
    result = result.replace(/\n{3,}/g, '\n\n');

    return result;
  }

  /** 纯文本/代码/表格/分隔线/图片 → 走 post；含按钮卡片 → 走 interactive */
  private canUsePostFormat(blocks: UnifiedBlock[]): boolean {
    return blocks.length > 0 && blocks.every(b =>
      b.type === 'text' || b.type === 'code_block' ||
      b.type === 'table' || b.type === 'divider' ||
      b.type === 'image'
    );
  }

  /** 拼接 blocks → 飞书 post 格式（支持图文混排，含 title） */
  private async sendAsPost(chatId: string, blocks: UnifiedBlock[]) {
    // 1. 提取 title（首个 text block 的首行）
    let title = '';
    for (const b of blocks) {
      if (b.type === 'text' && b.content.trim()) {
        title = b.content.trim().split('\n')[0].slice(0, 128);
        break;
      }
    }

    // 2. 按段落构建 content：每个 block → 一个或多个 post element
    const paragraphs: Array<Array<Record<string, unknown>>> = [];

    for (const block of blocks) {
      switch (block.type) {
        case 'image': {
          // 图片 → 上传图片拿 image_key → 单独一个段落
          if (block.url) {
            try {
              const imageKey = await this.uploadImageFromUrl(block.url);
              if (imageKey) {
                paragraphs.push([{ tag: 'img', image_key: imageKey }]);
              }
            } catch (e: unknown) {
              console.error(`[Feishu] Image upload in post failed: ${e.message}`);
            }
          }
          break;
        }

        case 'code_block': {
          const code = `\`\`\`${block.language || ''}\n${this.escapeCodeBlock(block.code)}\n\`\`\``;
          paragraphs.push([{ tag: 'md', text: code }]);
          break;
        }

        case 'table': {
          const mdTable = this.renderMarkdownTable(block.headers, block.rows, block.caption);
          paragraphs.push([{ tag: 'md', text: mdTable }]);
          break;
        }

        case 'divider': {
          // 分隔线 → 空段落或分隔标记（飞书 post 不支持 hr，用空行替代）
          paragraphs.push([{ tag: 'text', text: '---' }]);
          break;
        }

        default: { // text
          const optimized = this.optimizeMarkdownStyle(block.content);
          // 按空行分段，每段一个 paragraph
          const parts = optimized.split(/\n\n+/).filter(p => p.trim());
          for (const part of parts) {
            paragraphs.push([{ tag: 'md', text: part.trim() }]);
          }
          break;
        }
      }
    }

    if (paragraphs.length === 0) return;

    const payload: Record<string, unknown> = {
      zh_cn: {
        content: paragraphs,
      },
    };
    if (title) {
      (payload.zh_cn as Record<string, unknown>).title = title;
    }

    await this.client.im.message.create({
      params: { receive_id_type: 'chat_id' },
      data: {
        receive_id: chatId,
        msg_type: 'post',
        content: JSON.stringify(payload),
      },
    });
    console.log(`[Feishu] Post message sent (${blocks.length} blocks → ${paragraphs.length} paragraphs${title ? ', with title' : ''})`);
  }

  // ================================================================
  // 富文本卡片发送
  // ================================================================

  async sendBlocks(chatId: string, blocks: UnifiedBlock[]) {
    // 纯文本块（无图片/按钮）优先走 post 格式，markdown 渲染更好
    const nonFileBlocks = blocks.filter(b => b.type !== 'file');
    if (this.canUsePostFormat(nonFileBlocks)) {
      // 文件单独发，文本主体走 post
      const fileBlocks = blocks.filter(b => b.type === 'file' && b.url);
      for (const fb of fileBlocks) {
        try {
          let fileKey: string | null = null;
          if (fb.url.startsWith('file://')) {
            fileKey = await this.uploadFileFromPath(fb.url.replace('file://', ''));
          } else {
            fileKey = await this.uploadFileFromUrl(fb.url, fb.filename);
          }
          if (fileKey) await this.sendFile(chatId, fileKey, fb.filename);
        } catch (e: unknown) {
          console.error(`[Feishu] File send failed: ${fb.filename} - ${(e as Error).message}`);
        }
      }
      try {
        await this.sendAsPost(chatId, nonFileBlocks);
      } catch (e: unknown) {
        console.error(`[Feishu] Post send failed: ${(e as Error).message}, falling back to interactive`);
        await this._sendCard(chatId, blocks);
      }
      return;
    }

    // 含交互元素（图片/按钮）→ 走 interactive 卡片
    return this._sendCard(chatId, blocks);
  }

  /** 原有 interactive 卡片发送逻辑（内部方法，供 sendBlocks 和降级调用） */
  private async _sendCard(chatId: string, blocks: UnifiedBlock[]) {
    // 拆分：文件 block 必须单独发飞书文件消息，不能进卡片
    const fileBlocks = blocks.filter(b => b.type === 'file' && b.url);
    const cardBlocks = blocks.filter(b => b.type !== 'file');

    // 先发送文件消息（飞书原生文件类型，可下载）
    for (const fb of fileBlocks) {
      try {
        let fileKey: string | null = null;
        if (fb.url.startsWith('file://')) {
          const localPath = fb.url.replace('file://', '');
          fileKey = await this.uploadFileFromPath(localPath);
        } else {
          fileKey = await this.uploadFileFromUrl(fb.url, fb.filename);
        }
        if (fileKey) {
          await this.sendFile(chatId, fileKey, fb.filename);
          console.log(`[Feishu] File sent: ${fb.filename}`);
        }
      } catch (e: unknown) {
        console.error(`[Feishu] File send failed: ${fb.filename} - ${e.message}`);
      }
    }

    // If only one text block remains, send as plain text
    if (cardBlocks.length === 1 && cardBlocks[0].type === 'text') {
      if (fileBlocks.length === 0) return this.reply(chatId, cardBlocks[0].content);
      // 有文件在前，文本块附后
      await this.reply(chatId, cardBlocks[0].content);
      return;
    }

    // 如果没有非文件块了，只发文件就够了
    if (cardBlocks.length === 0) return;

    // 构建飞书消息卡片
    const cardElements: CardElement[] = [];

    for (const block of cardBlocks) {
      switch (block.type) {
        case 'text':
          cardElements.push({
            tag: 'markdown',
            content: this.escapeCardMarkdown(block.content),
          });
          break;

        case 'code_block':
          cardElements.push({
            tag: 'markdown',
            content: `\`\`\`${block.language || ''}
${this.escapeCodeBlock(block.code)}
\`\`\``,
          });
          break;

        case 'image':
          if (block.url) {
            try {
              const imageKey = await this.uploadImageFromUrl(block.url);
              if (imageKey) {
                cardElements.push({ tag: 'img', img_key: imageKey, alt: { tag: 'plain_text', content: block.alt || '' } });
              }
            } catch (e: unknown) {
              console.error(`[Feishu] Image upload failed: ${e.message}`);
              cardElements.push({ tag: 'markdown', content: `⚠️ Image load failed` });
            }
          }
          break;

        case 'card':
          cardElements.push({
            tag: 'markdown',
            content: `**${this.escapeCardMarkdown(block.title)}**
${this.escapeCardMarkdown(block.content || '')}`,
          });
          if (block.buttons?.length) {
            const actions: CardAction[] = [];
            for (const b of block.buttons) {
              actions.push({
                tag: 'button',
                text: { tag: 'plain_text', content: b.label },
                type: 'primary',
                multi_url: b.url ? { url: b.url, pc_url: b.url, android_url: b.url, ios_url: b.url } : undefined,
              });
            }
            cardElements.push({ tag: 'action', actions });
          }
          break;

        case 'table':
          const mdTable = this.renderMarkdownTable(block.headers, block.rows, block.caption);
          cardElements.push({ tag: 'markdown', content: mdTable });
          break;

        case 'divider':
          cardElements.push({ tag: 'hr' });
          break;
      }
    }

    // 构建卡片 JSON
    const card: FeishuCardMessage = {
      config: { wide_screen_mode: true },
      elements: cardElements,
    };

    try {
      await this.client.im.message.create({
        params: { receive_id_type: 'chat_id' },
        data: {
          receive_id: chatId,
          msg_type: 'interactive',
          content: JSON.stringify(card),
        },
      });
      console.log(`[Feishu] Card message sent (${cardBlocks.length} blocks)`);
    } catch (e: unknown) {
      console.error(`[Feishu] Card send failed: ${e.message}`);
      // 降级：拼接为纯文本发送
      const fallback = cardBlocks.map(b => {
        switch (b.type) {
          case 'code_block': return `\`\`\`${b.language || ''}
${b.code}
\`\`\``;
          case 'image': return `![${b.alt || ''}](${b.url})`;
          case 'text': return b.content;
          case 'card': return `**${b.title}**
${b.content || ''}`;
          case 'table': return this.renderMarkdownTable(b.headers, b.rows, b.caption);
          case 'divider': return '---';
          default: return '';
        }
      }).join('\n\n');
      await this.reply(chatId, fallback);
    }
  }

  // ================================================================
  // 图片发送
  // ================================================================

  async sendImage(chatId: string, imageKey: string, _alt?: string) {
    try {
      await this.client.im.message.create({
        params: { receive_id_type: 'chat_id' },
        data: {
          receive_id: chatId,
          msg_type: 'image',
          content: JSON.stringify({ image_key: imageKey }),
        },
      });
    } catch (e: unknown) {
      console.error(`[Feishu] Image send failed: ${e.message}`);
    }
  }

  // Upload image from URL to Feishu, returns image_key
  async uploadImageFromUrl(url: string): Promise<string | null> {
    try {
      let buffer: Buffer | null = null;
      // 判断是本地文件路径还是远程 URL
      if (url.startsWith('http://') || url.startsWith('https://')) {
        buffer = await this.downloadFile(url);
      } else if (url.startsWith('file://')) {
        const filePath = url.replace('file://', '');
        const stat = require('fs').statSync(filePath);
        if (stat.size > this.maxFileSize) {
          console.error(`[Feishu] File too large: ${filePath} (${stat.size} bytes, max ${this.maxFileSize})`);
          return null;
        }
        buffer = require('fs').readFileSync(filePath);
      } else {
        // 可能是相对/绝对本地路径
        try {
          buffer = require('fs').readFileSync(url);
        } catch {
          buffer = await this.downloadFile(url);
        }
      }
      if (!buffer) return null;

      // 使用 SDK 原生上传方法
      const r = await (this.client as any).im.v1.image.create({
        data: { image_type: 'message', image: buffer },
      });
      const key = r?.image_key || r?.data?.image_key;
      if (key) return key;
      console.error(`[Feishu] Image upload failed: image_key missing`);
      return null;
    } catch (e: unknown) {
      console.error(`[Feishu] Image upload error: ${e.message}`);
      return null;
    }
  }

  // Upload image from local file to Feishu, returns image_key
  async uploadImageFromFile(filePath: string): Promise<string | null> {
    try {
      const stat = fs.statSync(filePath);
      if (stat.size > this.maxFileSize) {
        console.error(`[Feishu] File too large: ${filePath} (${stat.size} bytes, max ${this.maxFileSize})`);
        return null;
      }
      const buffer = fs.readFileSync(filePath);
      // 使用 SDK 原生上传方法
      const r = await (this.client as any).im.v1.image.create({
        data: { image_type: 'message', image: buffer },
      });
      const key = r?.image_key || r?.data?.image_key;
      if (key) return key;
      console.error(`[Feishu] Image upload failed: image_key missing`);
      return null;
    } catch (e: unknown) {
      console.error(`[Feishu] Image upload failed: ${e.message}`);
      return null;
    }
  }

  // ================================================================
  // File Upload
  // ================================================================

  // Download from URL and upload to Feishu, returns file_key
  async uploadFileFromUrl(url: string, filename: string): Promise<string | null> {
    try {
      const buffer = await this.downloadFile(url);
      if (!buffer) return null;
      return this.uploadFileFromBuffer(buffer, filename || path.basename(new URL(url).pathname) || 'file');
    } catch (e: unknown) {
      console.error(`[Feishu] File upload error: ${e.message}`);
      return null;
    }
  }

  // Upload file from local path to Feishu, returns file_key
  async uploadFileFromPath(filePath: string): Promise<string | null> {
    try {
      const stat = fs.statSync(filePath);
      if (stat.size > this.maxFileSize) {
        console.error(`[Feishu] File too large: ${filePath} (${stat.size} bytes, max ${this.maxFileSize})`);
        return null;
      }
      const buffer = fs.readFileSync(filePath);
      return this.uploadFileFromBuffer(buffer, path.basename(filePath));
    } catch (e: unknown) {
      console.error(`[Feishu] File upload failed: ${e.message}`);
      return null;
    }
  }

  // Upload file from Buffer to Feishu, returns file_key
  private async uploadFileFromBuffer(buffer: Buffer, filename: string): Promise<string | null> {
    try {
      const token = await this.getAppToken();
      const form = new FormData();
      form.append('file_type', 'stream');
      form.append('file_name', filename);
      form.append('file', new Blob([buffer]), filename);

      const res = await fetch('https://open.feishu.cn/open-apis/im/v1/files', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: form,
      });
      const data = await res.json();
      if (data.code === 0 && data.data?.file_key) {
        return data.data.file_key;
      }
      console.error(`[Feishu] File upload failed: ${data.code} ${data.msg}`);
      return null;
    } catch (e: unknown) {
      console.error(`[Feishu] File upload error: ${e.message}`);
      return null;
    }
  }

  // 发送文件（直接传 file_key）
  async sendFile(chatId: string, fileKey: string, fileName: string) {
    try {
      await this.client.im.message.create({
        params: { receive_id_type: 'chat_id' },
        data: {
          receive_id: chatId,
          msg_type: 'file',
          content: JSON.stringify({ file_key: fileKey }),
        },
      });
    } catch (e: unknown) {
      console.error(`[Feishu] File send failed: ${e.message}`);
    }
  }

  // ================================================================
  // Capabilities
  // ================================================================

  getCapabilities(): IMCapabilities {
    return {
      text: true,
      codeBlock: true,       // Card markdown supports ``` syntax
      cardMessage: true,
      fileSend: true,
      imageSend: true,
      audioSend: true,
      buttonAction: true,
      maxTextLength: 30000,
    };
  }

  // ================================================================
  // 生命周期
  // ================================================================

  start(handler: MessageHandler) {
    this.messageHandler = handler;
    this.running = true;
    this._connect();
  }

  stop() {
    this.running = false;
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    try { this.wsClient?.stop?.(); } catch {}
    console.log(`[Feishu] WS stopped (appId=${this.appId.slice(-8)})`);
  }

  private _connect() {
    if (!this.running || !this.messageHandler) return;

    const dispatcher = new Lark.EventDispatcher({}).register({
      'im.message.receive_v1': async (data: FeishuMessageEvent) => {
        try {
          const { message } = data;
          if (!message) return;

          const chatId = message.chat_id;
          const senderId = message.sender_id;
          const userId = senderId?.open_id || senderId?.user_id || senderId?.union_id || chatId;
          const msgType = message.message_type;

          let text = '';
          const attachments: MessageAttachment[] = [];

          switch (msgType) {
            case 'text':
              text = parseFeishuMessage(message.content || '');
              break;

            case 'image': {
              const content = JSON.parse(message.content || '{}');
              const resolved = await this._mediaResolver.resolveOne({
                messageId: message.message_id,
                resourceKey: content.image_key,
                type: 'image',
              });
              if (resolved) {
                attachments.push(resolved.attachment);
                text = '[User sent an image]';
              }
              break;
            }

            case 'file': {
              const content = JSON.parse(message.content || '{}');
              const resolved = await this._mediaResolver.resolveOne({
                messageId: message.message_id,
                resourceKey: content.file_key,
                type: 'file',
                fileName: content.file_name,
              });
              if (resolved) {
                attachments.push(resolved.attachment);
                text = `[User sent a file: ${content.file_name || 'unknown'}]`;
              }
              break;
            }

            case 'audio': {
              const content = JSON.parse(message.content || '{}');
              const resolved = await this._mediaResolver.resolveOne({
                messageId: message.message_id,
                resourceKey: content.file_key,
                type: 'file',  // Feishu audio also uses file type for download
              });
              if (resolved) {
                // 补充音频时长（resolver 无法从飞书 API 获取 duration）
                resolved.attachment.durationMs = content.duration;
                attachments.push(resolved.attachment);
                text = `[User sent a voice message (${(content.duration || 0) / 1000}s)]`;
              }
              break;
            }

            case 'post':
              text = this.parsePostContent(message.content || '');
              break;

            case 'media':
              text = '[User sent a video message]';
              break;

            case 'sticker':
              text = '[User sent a sticker]';
              break;

            case 'system':
              return;

            case 'interactive':
              text = this.parseInteractiveContent(message.content || '');
              break;

            case 'merge_forward':
              text = '[User forwarded a merged message]';
              break;

            default:
              console.log(`[Feishu] Unhandled message type: ${msgType}`);
              return;
          }

          if (!text && attachments.length === 0) return;

          // Successful message delivery confirms connection is healthy — reset backoff
          this.reconnectAttempts = 0;

          logEvent({
            event: 'im_message_received',
            adapter: 'feishu',
            chatId,
            userId,
            textLength: text?.length || 0,
            attachmentCount: attachments.length,
          });
          await this.messageHandler!(chatId, text, userId, attachments.length > 0 ? attachments : undefined);
        } catch (e: unknown) {
          console.error(`[Feishu] Message processing error: ${e.message}`);
          // Don't throw to prevent SDK dispatcher unhandled rejection from crashing the process
        }
      },
    });

    // 自定义 Logger — 过滤 SDK 内部 WS 重连噪音
    const quietLogger = {
      info: (..._args: unknown[]) => { /* silent info */ },
      warn: (..._args: unknown[]) => { /* silent warn */ },
      error: (...args: unknown[]) => {
        const msg = args.join(' ');
        // 过滤已知的 SDK 内部 WS 重连噪音（不影响功能，SDK 自带自动重连）
        if (msg.includes('[ws]') && (msg.includes('ECONNREFUSED') || msg.includes('connect failed') || msg.includes('system busy') || msg.includes('repeat connection'))) return;
        console.error(`[Feishu-SDK] ${msg}`);
      },
      debug: (..._args: unknown[]) => { /* silent debug */ },
    };

    this.wsClient = new Lark.WSClient({
      appId: this.appId,
      appSecret: this.appSecret,
      logger: quietLogger,
      loggerLevel: Lark.LoggerLevel.info,
    });

    this.wsClient.start({ eventDispatcher: dispatcher })
      .then(() => {
        this.reconnectAttempts = 0;
        console.log(`[Feishu] WS connected`);
      })
      .catch((e: unknown) => {
        console.error(`[Feishu] WS connection failed: ${e.message}`);
        this._scheduleReconnect();
      });

    this.wsClient.on?.('close', () => {
      console.log('[Feishu] WS disconnected');
      this._scheduleReconnect();
    });
    this.wsClient.on?.('reconnect', () => {
      // SDK internally reconnected — reset backoff counter
      this.reconnectAttempts = 0;
      console.log('[Feishu] WS reconnected');
    });
    this.wsClient.on?.('error', (e: unknown) => {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`[Feishu] WS error: ${msg}`);
    });
  }

  private _scheduleReconnect() {
    if (!this.running) return;
    if (this.reconnectTimer) return;

    const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 30000);
    this.reconnectAttempts++;
    console.log(`[Feishu] Reconnecting in ${delay/1000}s (attempt ${this.reconnectAttempts})`);

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this._connect();
    }, delay);
  }

  // ================================================================
  // 工具方法
  // ================================================================

  // 飞书卡片 markdown：仅处理破坏解析的边界情况
  // Agent 输出是可信的 markdown，不应全量转义
  private escapeCardMarkdown(text: string): string {
    return text;
  }

  // 代码块内容：保护内部的三反引号不被解析器截断
  private escapeCodeBlock(code: string): string {
    return code.replace(/```/g, '\\`\\`\\`');
  }

  // 渲染 markdown 表格
  private renderMarkdownTable(headers: string[], rows: string[][], caption?: string): string {
    const lines: string[] = [];
    if (caption) lines.push(`**${this.escapeCardMarkdown(caption)}**\n`);

    // 表头
    lines.push('| ' + headers.map(h => this.escapeCardMarkdown(h)).join(' | ') + ' |');
    // 分隔线
    lines.push('| ' + headers.map(() => '---').join(' | ') + ' |');
    // 数据行
    for (const row of rows) {
      const cells = [];
      for (let i = 0; i < headers.length; i++) {
        cells.push(i < row.length ? this.escapeCardMarkdown(row[i]) : '');
      }
      lines.push('| ' + cells.join(' | ') + ' |');
    }
    return lines.join('\n');
  }

  // 下载文件/图片（使用 fetch，自动跟随重定向）
  private async downloadFile(url: string): Promise<Buffer | null> {
    try {
      const resp = await fetch(url, { signal: AbortSignal.timeout(30000) });
      if (!resp.ok) {
        console.error(`[Feishu] Download failed: HTTP ${resp.status}, url=${url.slice(0, 80)}`);
        return null;
      }
      const buf = await resp.arrayBuffer();
      return Buffer.from(buf);
    } catch (e) {
      console.error(`[Feishu] Download error: ${(e as Error).message}, url=${url.slice(0, 80)}`);
      return null;
    }
  }

  // 下载图片（便捷别名）
  private async downloadImage(url: string): Promise<Buffer | null> {
    return this.downloadFile(url);
  }

  // ================================================================
  private parsePostContent(content: string): string {
    try {
      const parsed = JSON.parse(content);
      const locale = parsed.zh_cn || parsed.en_us || parsed;
      if (!locale?.content) return content.trim();

      const lines = locale.content.map((paragraph: FeishuPostParagraph) => {
        return paragraph.map((elem: FeishuPostElement) => {
          switch (elem.tag) {
            case 'text':    return elem.text || '';
            case 'a':       return `[${elem.text}](${elem.href})`;
            case 'at':      return `@${elem.user_name || elem.user_id || 'unknown'}`;
            case 'img':     return `[Image]`;
            case 'emotion': return `[Sticker]`;
            default:        return `[${elem.tag}]`;
          }
        }).join('');
      }).join('\n');

      const title = locale.title ? `**${locale.title}**\n\n` : '';
      return title + lines;
    } catch {
      return content.trim();
    }
  }

  /**
   * 解析卡片交互回调（用户点击卡片按钮等）
   * content 结构：{"action": {...}}
   */
  private parseInteractiveContent(content: string): string {
    try {
      const parsed = JSON.parse(content);
      if (parsed.action?.value) return parsed.action.value;
      if (parsed.action?.option) return parsed.action.option;
      return parsed.action?.tag || content.trim();
    } catch {
      return content.trim();
    }
  }
}

function parseFeishuMessage(content: string): string {
  try {
    const parsed = JSON.parse(content);
    return (parsed.text || '').trim();
  } catch {
    return content.trim();
  }
}
