// WeCom (企业微信) IM 模块 — 扫码绑定 + WebSocket 长连接版
// 参考: @wecom/wecom-openclaw-plugin (v2026.5.14) 官方架构
//
// 不再需要: corpId / agentId / HTTP 回调 / 公网 IP / AES 加解密
// 扫码即可获得 botId + secret，通过 @wecom/aibot-node-sdk 建立 WebSocket 长连接

import * as https from 'node:https';
import * as os from 'node:os';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import * as http from 'node:http';
import { URL } from 'node:url';
import { WSClient } from '@wecom/aibot-node-sdk';
import type { WeComMediaType } from '@wecom/aibot-node-sdk';
import * as qrcode from 'qrcode';
import type { IMModule, IMCapabilities, MessageHandler } from '../types';
import type { UnifiedBlock } from '../capabilities';
import type { MessageAttachment } from '../core/types';
import type { WeComMessageFrame, WeComSelectedItem } from './im-types';

// ================================================================
// 常量
// ================================================================

const QR_GENERATE_URL = 'https://work.weixin.qq.com/ai/qc/generate';
const QR_QUERY_URL = 'https://work.weixin.qq.com/ai/qc/query_result';
const POLL_INTERVAL_MS = 3000;
const POLL_TIMEOUT_MS = 300_000; // 5 分钟
const WS_HEARTBEAT_MS = 30_000;
const WS_MAX_RECONNECT = 10;
const WS_MAX_AUTH_FAIL = 5;
const TEXT_MAX = 4000;

function getPlatCode(): number {
  switch (os.platform()) {
    case 'darwin': return 1;
    case 'win32':  return 2;
    case 'linux':  return 3;
    default:       return 0;
  }
}

// ================================================================
// 凭证本地存储
// ================================================================

interface StoredCreds {
  botId: string;
  secret: string;
  boundAt: string;
}

const CREDS_FILE = path.join(os.homedir(), '.imtoagent', 'wecom-creds.json');

function loadCreds(): StoredCreds | null {
  try {
    if (!fs.existsSync(CREDS_FILE)) return null;
    return JSON.parse(fs.readFileSync(CREDS_FILE, 'utf8')) as StoredCreds;
  } catch {
    return null;
  }
}

function saveCreds(creds: StoredCreds): void {
  fs.mkdirSync(path.dirname(CREDS_FILE), { recursive: true });
  fs.writeFileSync(CREDS_FILE, JSON.stringify(creds, null, 2), { mode: 0o600 });
}

// ================================================================
// QR 扫码流程
// ================================================================

function httpsGet(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    https.get(url, res => {
      let data = '';
      res.on('data', c => (data += c));
      res.on('end', () => resolve(data));
    }).on('error', reject);
  });
}

async function fetchQRCode(): Promise<{ scode: string; authUrl: string }> {
  const plat = getPlatCode();
  const url = `${QR_GENERATE_URL}?source=wecom-cli&plat=${plat}`;
  const raw = await httpsGet(url);
  const resp = JSON.parse(raw);
  if (!resp?.data?.scode || !resp?.data?.auth_url) {
    throw new Error(`Failed to get QR code: ${raw.slice(0, 200)}`);
  }
  return { scode: resp.data.scode, authUrl: resp.data.auth_url };
}

async function renderQR(authUrl: string): Promise<void> {
  const qr = await qrcode.toString(authUrl, { type: 'terminal', small: true });
  console.log('');
  console.log(qr);
  console.log('');
}

async function pollResult(scode: string): Promise<{ botId: string; secret: string }> {
  const start = Date.now();
  const url = `${QR_QUERY_URL}?scode=${encodeURIComponent(scode)}`;

  while (Date.now() - start < POLL_TIMEOUT_MS) {
    const raw = await httpsGet(url);
    const resp = JSON.parse(raw);
    const status = resp?.data?.status;

    if (status === 'success') {
      const bi = resp.data.bot_info;
      if (!bi?.botid || !bi?.secret) {
        throw new Error('QR scan successful but Bot info not received');
      }
      return { botId: bi.botid, secret: bi.secret };
    }
    process.stdout.write('.');
    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
  }

  console.log('\n⏱ QR scan timed out (5 min), please retry');
  process.exit(1);
}

/**
 * 执行 QR 扫码绑定流程
 * 调用后会在终端显示二维码，用户扫码后自动获取 botId 和 secret 并保存到本地
 */
export async function bindWeComQR(): Promise<{ botId: string; secret: string }> {
  console.log('\n📱 WeCom QR Code Binding');
  console.log('Fetching QR code...');

  const { scode, authUrl } = await fetchQRCode();

  console.log('Please scan the following QR code with WeCom:');
  await renderQR(authUrl);
  console.log('Waiting for scan...');

  const result = await pollResult(scode);
  console.log('\n✅ QR scan successful! Bot ID and Secret saved');

  const creds: StoredCreds = {
    botId: result.botId,
    secret: result.secret,
    boundAt: new Date().toISOString(),
  };
  saveCreds(creds);
  return result;
}

// ================================================================
// WeCom 配置
// ================================================================

export interface WeComConfig {
  /** Bot ID（可选，无凭证时自动触发扫码绑定） */
  botId?: string;
  /** Secret（可选，无凭证时自动触发扫码绑定） */
  secret?: string;
}

// ================================================================
// WeCom IM 模块
// ================================================================

/**
 * 企业微信 IM 模块 — 扫码绑定 + WebSocket 长连接版
 *
 * 架构说明:
 * - 首次启动无凭证时，显示二维码引导用户扫码
 * - 扫码后自动获取 botId + secret 并保存到 ~/.imtoagent/wecom-creds.json
 * - 使用 @wecom/aibot-node-sdk 建立 WebSocket 长连接
 * - 无需公网 IP、无需 HTTP 回调
 *
 * 消息收发:
 * - 接收: WSClient.on('message', frame) → 解析 body → 回调 handler
 * - 发送: WSClient.sendMessage(chatId, { msgtype, ... })
 */
export class WeComIMModule implements IMModule {
  private ws: WSClient | null = null;
  private handler: MessageHandler | null = null;
  private running = false;
  private cfg: WeComConfig;

  // 被动回复：保存最近收到的 message frame（按 chatId），reply() 优先走被动回复通道
  private pendingFrames = new Map<string, WeComMessageFrame>();

  constructor(cfg: WeComConfig = {}) {
    this.cfg = cfg;
  }

  getCapabilities(): IMCapabilities {
    return {
      text: true,
      codeBlock: false,        // WeCom doesn't support code blocks
      cardMessage: true,       // Template card messages
      fileSend: true,
      imageSend: true,
      audioSend: false,
      buttonAction: true,      // Template card button callbacks
      maxTextLength: TEXT_MAX,
    };
  }

  // ── 启动 / 停止 ──

  start(handler: MessageHandler): void {
    if (this.running) {
      console.warn('[WeCom] Already running');
      return;
    }
    this.handler = handler;
    this.running = true;
    this._connect();
  }

  stop(): void {
    this.running = false;
    if (this.ws) {
      this.ws.disconnect();
      this.ws = null;
    }
    this.handler = null;
    console.log('[WeCom] Disconnected');
  }

  // ── WebSocket 连接 ──

  private async _connect(): Promise<void> {
    // 1. 尝试获取凭证：配置 → 本地存储 → 扫码绑定
    let botId = this.cfg.botId;
    let secret = this.cfg.secret;

    if (!botId || !secret) {
      const stored = loadCreds();
      if (stored) {
        botId = stored.botId;
        secret = stored.secret;
        console.log('[WeCom] Loaded local credentials');
      }
    }

    if (!botId || !secret) {
      console.log('[WeCom] No credentials found, starting QR binding...');
      const bound = await bindWeComQR();
      botId = bound.botId;
      secret = bound.secret;
    }

    console.log(`[WeCom] Connecting WebSocket (bot: ${botId.slice(0, 6)}...)`);

    // 2. 创建 WSClient
    this.ws = new WSClient({
      botId,
      secret,
      logger: {
        info:  m => console.log(`[WeCom-SDK] ${m}`),
        warn:  m => console.warn(`[WeCom-SDK] ${m}`),
        error: m => console.error(`[WeCom-SDK] ${m}`),
        debug: m => console.debug(`[WeCom-SDK] ${m}`),
      },
      heartbeatInterval: WS_HEARTBEAT_MS,
      maxReconnectAttempts: WS_MAX_RECONNECT,
      maxAuthFailureAttempts: WS_MAX_AUTH_FAIL,
    });

    // 3. 事件监听
    this.ws.on('connected', () => {
      console.log('[WeCom] WebSocket connected');
    });

    this.ws.on('authenticated', () => {
      console.log('[WeCom] Authenticated');
    });

    this.ws.on('disconnected', (reason: string) => {
      console.log(`[WeCom] Disconnected: ${reason}`);
      if (this.running) {
        console.log('[WeCom] Reconnecting in 5s...');
        setTimeout(() => { if (this.running) this._connect(); }, 5000);
      }
    });

    this.ws.on('error', (err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[WeCom] Error: ${msg}`);
    });

    // 4. 接收消息
    this.ws.on('message', async (frame: WeComMessageFrame) => {
      try {
        await this._handleMessage(frame);
      } catch (e: unknown) {
        console.error(`[WeCom] Message processing error: ${e.message}`);
      }
    });
  }

  // ── Message Parsing ──

  private async _handleMessage(frame: WeComMessageFrame): Promise<void> {
    const body = frame.body || {};
    const msgType = (body.msgtype || '').toLowerCase();

    // 事件消息（模板卡片回调等）
    if (msgType === 'event') {
      const evt = body.event;
      if (evt?.eventtype === 'template_card_event') {
        // 模板卡片按钮点击 → 转为文本
        const items = evt.selected_items?.selected_item ?? [];
        const lines = items.map((it: WeComSelectedItem) => {
          const ids = it.option_ids?.option_id?.filter(Boolean) ?? [];
          return `- ${it.question_key || '?'}: ${ids.join(', ') || '(not selected)'}`;
        });
        const text = [
          '[Template card callback]',
          `card_type: ${evt.card_type || '?'}`,
          `event_key: ${evt.event_key || '?'}`,
          ...lines,
        ].join('\n');
        const chatId = body.chatid || body.from?.userid || '';
        const userId = body.from?.userid || '';
        if (this.handler && chatId) {
          await this.handler(chatId, text, userId);
        }
      }
      return;
    }

    const fromUser = body.from?.userid || '';
    const chatId = body.chatid || fromUser;
    const chatType = (body.chattype || 'single').toLowerCase();
    if (!chatId || !fromUser) return;

    let text = '';
    const attachments: MessageAttachment[] = [];

    switch (msgType) {
      case 'text':
        text = body.content?.text || body.text?.content || body.content || '';
        break;
      case 'image':
        text = '[Image]';
        if (body.image?.mediaid) {
          const localPath = await this._downloadMedia(body.image.mediaid, body.image.aeskey, 'image.png');
          attachments.push({ type: 'image', localPath: localPath || '', sourceKey: body.image.mediaid, mimeType: 'image/png' });
        }
        break;
      case 'voice':
        text = body.voice?.recognition || body.recognition || '[Voice]';
        if (body.voice?.mediaid) {
          const localPath = await this._downloadMedia(body.voice.mediaid, body.voice.aeskey, 'voice.amr');
          attachments.push({ type: 'file', localPath: localPath || '', filename: 'voice.amr', sourceKey: body.voice.mediaid });
        }
        break;
      case 'video':
        text = '[Video]';
        if (body.video?.mediaid) {
          const localPath = await this._downloadMedia(body.video.mediaid, body.video.aeskey, 'video.mp4');
          attachments.push({ type: 'file', localPath: localPath || '', filename: 'video.mp4', sourceKey: body.video.mediaid });
        }
        break;
      case 'file':
        text = `[File: ${body.file?.title || body.title || 'unknown'}]`;
        if (body.file?.mediaid) {
          const localPath = await this._downloadMedia(body.file.mediaid, body.file.aeskey, body.file.title || 'file');
          attachments.push({ type: 'file', localPath: localPath || '', filename: body.file.title || 'file', sourceKey: body.file.mediaid });
        }
        break;
      case 'markdown':
        text = body.markdown?.content || '';
        break;
      default:
        text = `[${msgType} message]`;
    }

    const preview = text.length > 80 ? text.slice(0, 80) + '...' : text;
    console.log(`[WeCom] ${chatType === 'group' ? 'Group' : 'DM'} ${fromUser}@${chatId}: ${preview}`);

    // 保存 frame 用于被动回复
    this.pendingFrames.set(chatId, frame);

    if (this.handler) {
      await this.handler(chatId, text.trim(), fromUser, attachments.length ? attachments : undefined);
    }
  }

  // ── 发送消息 ──

  async reply(chatId: string, text: string): Promise<void> {
    if (!this.ws?.isConnected) {
      console.error('[WeCom] WS not connected');
      return;
    }
    const safe = text.length > TEXT_MAX ? text.slice(0, TEXT_MAX) + '\n…truncated' : text;
    const body = {
      msgtype: 'markdown',
      markdown: { content: safe },
    };

    // 优先被动回复（挂在用户消息下方，形成对话线程）
    const frame = this.pendingFrames.get(chatId);
    if (frame) {
      try {
        await this.ws.reply(frame, body);
        return;
      } catch (e: unknown) {
        console.warn(`[WeCom] Passive reply failed, falling back to push: ${e.message}`);
      }
    }

    // fallback: 主动推送
    try {
      await this.ws.sendMessage(chatId, body);
    } catch (e: unknown) {
      console.error(`[WeCom] Send failed: ${e.message}`);
    }
  }

  /**
   * 流式回复（token-by-token）
   * 需要 Agent 层支持流式输出回调才能发挥效果
   *
   * @param chatId 会话 ID
   * @param streamId 流式消息 ID（同一流内保持一致）
   * @param content 当前 token 内容
   * @param finish 是否结束
   */
  async replyStream(chatId: string, streamId: string, content: string, finish: boolean): Promise<void> {
    if (!this.ws?.isConnected) return;
    const frame = this.pendingFrames.get(chatId);
    if (!frame) {
      // 无 frame 时降级为主动推送（用 sendMessage 不支持流式）
      if (finish) await this.reply(chatId, content);
      return;
    }
    try {
      await this.ws.replyStream(frame, streamId, content, finish);
    } catch (e: unknown) {
      console.error(`[WeCom] Stream send failed: ${e.message}`);
    }
  }

  /**
   * Non-blocking streaming reply
   * 当上一条消息还未收到 ACK 时跳过中间帧，避免慢连接下排队积压
   * finish=true 的最终帧不受限制，始终发送
   */
  async replyStreamNonBlocking(chatId: string, streamId: string, content: string, finish: boolean): Promise<void> {
    if (!this.ws?.isConnected) return;
    const frame = this.pendingFrames.get(chatId);
    if (!frame) {
      if (finish) await this.reply(chatId, content);
      return;
    }
    try {
      const result = await this.ws.replyStreamNonBlocking(frame, streamId, content, finish);
      if (result === 'skipped' && !finish) {
        // 静默跳过中间帧（非阻塞保护生效）
      }
    } catch (e: unknown) {
      console.error(`[WeCom] Non-blocking stream send failed: ${e.message}`);
    }
  }

  async sendProgress(chatId: string, text: string): Promise<void> {
    await this.reply(chatId, text);
  }

  async sendBlocks(chatId: string, blocks: UnifiedBlock[]): Promise<void> {
    const texts: string[] = [];
    for (const b of blocks) {
      switch (b.type) {
        case 'text':       texts.push(b.content); break;
        case 'code_block': texts.push(`\`${b.language || 'code'}\`\n${b.code}`); break;
        case 'card':       texts.push(`**${b.title}**\n${b.content || ''}`); break;
        case 'divider':    texts.push('---'); break;
        case 'table':
          texts.push('| ' + b.headers.join(' | ') + ' |\n' + b.rows.map(r => '| ' + r.join(' | ') + ' |').join('\n'));
          break;
        case 'image':
          if (b.url) {
            try {
              const mediaId = await this._uploadMediaFromSource(b.url, 'image', b.title || 'image.png');
              if (mediaId) await this.ws!.sendMediaMessage(chatId, 'image', mediaId);
            } catch (e: unknown) { console.error(`[WeCom] Image upload failed: ${e.message}`); }
          }
          break;
        case 'file':
          if (b.url) {
            try {
              const mediaId = await this._uploadMediaFromSource(b.url, 'file', b.title || 'file');
              if (mediaId) await this.ws!.sendMediaMessage(chatId, 'file', mediaId);
            } catch (e: unknown) { console.error(`[WeCom] File upload failed: ${e.message}`); }
          }
          break;
      }
    }
    if (texts.length) await this.reply(chatId, texts.join('\n\n'));
  }

  async sendImage(chatId: string, imageKey: string, _alt?: string): Promise<void> {
    if (!this.ws?.isConnected) { console.error('[WeCom] WS not connected'); return; }
    try {
      const mediaId = await this._uploadMediaFromSource(imageKey, 'image', this._basename(imageKey));
      if (mediaId) await this.ws.sendMediaMessage(chatId, 'image', mediaId);
    } catch (e: unknown) { console.error(`[WeCom] Image send failed: ${e.message}`); }
  }

  async sendFile(chatId: string, fileKey: string, fileName: string): Promise<void> {
    if (!this.ws?.isConnected) { console.error('[WeCom] WS not connected'); return; }
    try {
      const mediaId = await this._uploadMediaFromSource(fileKey, 'file', fileName);
      if (mediaId) await this.ws.sendMediaMessage(chatId, 'file', mediaId);
    } catch (e: unknown) { console.error(`[WeCom] File send failed: ${e.message}`); }
  }

  // ── 媒体上传 ──

  /**
   * 从本地路径或 URL 读取文件，上传到企微获取 media_id
   */
  private async _uploadMediaFromSource(source: string, mediaType: WeComMediaType, fileName: string): Promise<string | null> {
    let buffer: Buffer;
    if (source.startsWith('http://') || source.startsWith('https://')) {
      buffer = await this._fetchUrlBuffer(source);
    } else if (source.startsWith('data:')) {
      // data URI
      const commaIdx = source.indexOf(',');
      const b64 = source.substring(commaIdx + 1);
      buffer = Buffer.from(b64, 'base64');
    } else {
      // local file path
      if (!fs.existsSync(source)) {
        throw new Error(`File not found: ${source}`);
      }
      buffer = fs.readFileSync(source);
    }

    if (buffer.length === 0) throw new Error('File is empty');

    const result = await this.ws!.uploadMedia(buffer, { type: mediaType, filename: fileName });
    console.log(`[WeCom] Media uploaded: ${fileName} → ${result.media_id}`);
    return result.media_id;
  }

  /** 从 HTTP(S) URL 下载文件为 Buffer */
  private _fetchUrlBuffer(url: string): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const parsed = new URL(url);
      const lib = parsed.protocol === 'https:' ? https : http;
      lib.get(url, res => {
        // 处理重定向
        if (res.statusCode === 301 || res.statusCode === 302) {
          const location = res.headers.location;
          if (location) {
            this._fetchUrlBuffer(location).then(resolve).catch(reject);
            return;
          }
        }
        if (res.statusCode !== 200) { reject(new Error(`HTTP ${res.statusCode}`)); return; }
        const chunks: Buffer[] = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => resolve(Buffer.concat(chunks)));
        res.on('error', reject);
      }).on('error', reject);
    });
  }

  /** 从路径提取文件名 */
  private _basename(p: string): string {
    return path.basename(p.split('?')[0]); // 去掉 query string
  }

  // ── 媒体下载 ──

  /**
   * 下载企微媒体文件（需要 AES 解密）
   * @param mediaId 媒体 ID
   * @param aesKey AES 密钥（Base64），来自消息体 image.aeskey / file.aeskey 等
   * @param fallbackName 默认文件名
   * @returns 下载后的本地文件路径
   */
  private async _downloadMedia(mediaId: string, aesKey: string | undefined, fallbackName: string): Promise<string | null> {
    try {
      // SDK 的 downloadFile 需要完整 URL，企微媒体下载地址格式：
      // https://qyapi.weixin.qq.com/cgi-bin/media/get?access_token=TOKEN&media_id=MEDIA_ID
      // 但 SDK 内部封装了下载 + AES 解密，直接用 mediaId 和 aesKey 即可
      const { buffer, filename } = await this.ws!.downloadFile(mediaId, aesKey);
      if (!buffer || buffer.length === 0) return null;

      const finalName = filename || fallbackName;
      const tempDir = path.join(os.homedir(), '.imtoagent', 'wecom-media');
      fs.mkdirSync(tempDir, { recursive: true });
      const filePath = path.join(tempDir, `${Date.now()}_${finalName}`);
      fs.writeFileSync(filePath, buffer);
      console.log(`[WeCom] Media downloaded: ${mediaId} → ${filePath}`);
      return filePath;
    } catch (e: unknown) {
      console.error(`[WeCom] Media download failed (${mediaId}): ${e.message}`);
      return null;
    }
  }
}
