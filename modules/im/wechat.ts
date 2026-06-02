// 微信（个人微信）IM 模块 — iLink 协议 HTTP long-poll 版
// 参考: @tencent-weixin/openclaw-weixin@2.4.3 官方插件逆向研究
//
// 协议：iLink（Tencent 内部 Bot 协议）
// 连接模式：HTTP long-poll（非 WebSocket）
// API Base：https://ilinkai.weixin.qq.com
// CDN Base：https://novac2c.cdn.weixin.qq.com/c2c
//
// 认证流程：QR 扫码 → get_bot_qrcode → get_qrcode_status → 获取 bot_token
// 收消息：ilink/bot/getupdates（35s 长轮询，带续传 buf）
// 发消息：ilink/bot/sendmessage（需携带 context_token）
// 媒体：AES-128-ECB 加密，CDN 上传/下载

import * as https from 'node:https';
import * as http from 'node:http';
import * as os from 'node:os';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import * as qrcode from 'qrcode';
import type { IMModule, IMCapabilities, MessageHandler } from '../types';
import type { UnifiedBlock } from '../capabilities';
import type { MessageAttachment } from '../core/types';
import type { ILinkResponse } from './im-types';
import { logEvent } from '../utils/logger';

// ================================================================
// 常量
// ================================================================

const API_BASE = 'https://ilinkai.weixin.qq.com';
const CDN_BASE = 'https://novac2c.cdn.weixin.qq.com/c2c';
const ILINK_APP_ID = 'bot';
const CHANNEL_VERSION = '2.4.3';

// 认证
const QR_POLL_INTERVAL_MS = 3000;
const QR_POLL_TIMEOUT_MS = 300_000; // 5 分钟
const MAX_QR_REFRESH = 3;

// Long-poll
const LONGPOLL_TIMEOUT_MS = 35000;
const LONGPOLL_RETRY_DELAY_MS = 2000;

// 流式
const STREAM_PIECE_MAX = 50; // 单次 syncStream 最多上传 50 个 piece

// 文本限制
const TEXT_MAX = 4000;

// Session
const SESSION_PAUSE_MS = 60 * 60 * 1000; // 过期后暂停 1 小时

// 凭证 & context_token 存储
const DATA_DIR = path.join(os.homedir(), '.imtoagent');
const CREDS_FILE = path.join(DATA_DIR, 'wechat-creds.json');
const CONTEXT_TOKENS_FILE = path.join(DATA_DIR, 'wechat-context-tokens.json');
const MEDIA_DIR = path.join(DATA_DIR, 'wechat-media');

// ================================================================
// 类型定义
// ================================================================

// MessageItemType — 消息项类型
enum MessageItemType {
  NONE = 0,
  TEXT = 1,
  IMAGE = 2,
  VOICE = 3,
  FILE = 4,
  VIDEO = 5,
}

// QR 扫码状态
type QrStatus = 'wait' | 'scaned' | 'need_verifycode' | 'confirmed' | 'binded_redirect' | 'scaned_but_redirect' | 'expired' | 'verify_code_blocked';

// iLink 消息 item
interface ILinkItem {
  type: number;
  text_item?: { text: string };
  image_item?: { media: ILinkMedia; aeskey?: string };
  voice_item?: { media: ILinkMedia; aeskey?: string };
  file_item?: { media: ILinkMedia; aeskey?: string };
  video_item?: { media: ILinkMedia; aeskey?: string };
}

interface ILinkMedia {
  encrypt_query_param?: string;
  full_url?: string;
  aes_key?: string;
}

// iLink 消息
interface ILinkMessage {
  from_user_id: string;
  message_id: string;
  session_id: string;
  context_token: string;
  create_time_ms: number;
  item_list: ILinkItem[];
}

// getUpdates 响应
interface GetUpdatesResponse {
  ret: number;
  msgs?: ILinkMessage[];
  get_updates_buf?: string;
  longpolling_timeout_ms?: number;
  errmsg?: string;
}

// Stored credentials
interface StoredCreds {
  botId: string;
  botToken: string;
  ilinkUserId: string;
  boundAt: string;
}

// Context token 持久化
interface StoredContextTokens {
  [accountUser: string]: string;
}

// ================================================================
// 工具函数
// ================================================================

/**
 * 通用 HTTPS POST 请求（iLink API）
 */
async function ilinkPost(endpoint: string, body: Record<string, unknown>, token?: string): Promise<ILinkResponse> {
  const url = `${API_BASE}/${endpoint}`;
  const bodyStr = JSON.stringify(body);
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'Content-Length': String(Buffer.byteLength(bodyStr)),
    'iLink-App-Id': ILINK_APP_ID,
    'iLink-App-ClientVersion': encodeClientVersion(),
    'AuthorizationType': 'ilink_bot_token',
    'X-WECHAT-UIN': base64RandomUin(),
  };
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  return new Promise((resolve, reject) => {
    const req = https.request(url, {
      method: 'POST',
      headers,
      timeout: 60000,
    }, res => {
      let data = '';
      res.on('data', c => (data += c));
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch {
          reject(new Error(`Failed to parse response: ${data.slice(0, 200)}`));
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('request timeout')); });
    req.write(bodyStr);
    req.end();
  });
}

/**
 * 通用 HTTPS GET 请求
 */
async function ilinkGet(endpoint: string, token?: string): Promise<ILinkResponse> {
  const url = `${API_BASE}/${endpoint}`;
  const headers: Record<string, string> = {
    'iLink-App-Id': ILINK_APP_ID,
    'iLink-App-ClientVersion': encodeClientVersion(),
    'AuthorizationType': 'ilink_bot_token',
    'X-WECHAT-UIN': base64RandomUin(),
  };
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  return new Promise((resolve, reject) => {
    https.get(url, { headers, timeout: 60000 }, res => {
      let data = '';
      res.on('data', c => (data += c));
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch {
          reject(new Error(`Failed to parse response: ${data.slice(0, 200)}`));
        }
      });
    }).on('error', reject).on('timeout', reject);
  });
}

/**
 * 版本号编码：0x00MMNNPP → "M.N.P"
 * 硬编码 2.4.3 → 0x00020403
 */
function encodeClientVersion(): string {
  return '2.4.3';
}

/**
 * 生成随机 UIN 并 base64 编码
 */
function base64RandomUin(): string {
  const val = Math.floor(Math.random() * 0xFFFFFFFF);
  return Buffer.from(String(val)).toString('base64');
}

/**
 * AES-128-ECB 解密
 */
function aesDecrypt(encrypted: Buffer, keyHex: string): Buffer {
  const key = Buffer.from(keyHex, 'hex'); // hex → 16 bytes
  const decipher = crypto.createDecipheriv('aes-128-ecb', key, null);
  decipher.setAutoPadding(true);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]);
}

/**
 * AES-128-ECB 加密
 */
function aesEncrypt(plain: Buffer, keyHex: string): Buffer {
  const key = Buffer.from(keyHex, 'hex');
  const cipher = crypto.createCipheriv('aes-128-ecb', key, null);
  cipher.setAutoPadding(true);
  return Buffer.concat([cipher.update(plain), cipher.final()]);
}

/**
 * 生成随机 hex key（16 bytes → 32 hex chars）
 */
function generateAesKeyHex(): string {
  return crypto.randomBytes(16).toString('hex');
}

/**
 * 计算文件 MD5（hex）
 */
function md5Hex(buffer: Buffer): string {
  return crypto.createHash('md5').update(buffer).digest('hex');
}

// ================================================================
// 凭证 & Context Token 管理
// ================================================================

function loadCreds(): StoredCreds | null {
  try {
    if (!fs.existsSync(CREDS_FILE)) return null;
    return JSON.parse(fs.readFileSync(CREDS_FILE, 'utf8')) as StoredCreds;
  } catch {
    return null;
  }
}

function saveCreds(creds: StoredCreds): void {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(CREDS_FILE, JSON.stringify(creds, null, 2), { mode: 0o600 });
}

function loadContextTokens(): StoredContextTokens {
  try {
    if (!fs.existsSync(CONTEXT_TOKENS_FILE)) return {};
    return JSON.parse(fs.readFileSync(CONTEXT_TOKENS_FILE, 'utf8')) as StoredContextTokens;
  } catch {
    return {};
  }
}

function saveContextTokens(tokens: StoredContextTokens): void {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(CONTEXT_TOKENS_FILE, JSON.stringify(tokens, null, 2), { mode: 0o600 });
}

// ================================================================
// QR 扫码认证
// ================================================================

async function getBotQrcode(localTokenList: string[], token?: string): Promise<{ qrcode: string; qrcode_img_content: string }> {
  const result = await ilinkPost('ilink/bot/get_bot_qrcode', {
    bot_type: 3,
    local_token_list: localTokenList,
  }, token);
  if (result.ret !== 0 || !result.qrcode) {
    throw new Error(`Failed to get QR code: ${JSON.stringify(result).slice(0, 200)}`);
  }
  return { qrcode: result.qrcode, qrcode_img_content: result.qrcode_img_content };
}

async function getQrcodeStatus(qrcode: string, token?: string): Promise<{ status: QrStatus; ilink_bot_id?: string; bot_token?: string; ilink_user_id?: string; baseurl?: string }> {
  const result = await ilinkGet(`ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`, token);
  return {
    status: result.status as QrStatus,
    ilink_bot_id: result.ilink_bot_id,
    bot_token: result.bot_token,
    ilink_user_id: result.ilink_user_id,
    baseurl: result.baseurl,
  };
}

async function renderQR(qrContent: string): Promise<void> {
  let qrUrl = qrContent;
  // qrcode_img_content 可能是 URL 或 base64
  if (qrContent.startsWith('http')) {
    // URL 类型，下载到终端渲染
    try {
      const qr = await qrcode.toString(qrContent, { type: 'terminal', small: true });
      console.log('\n' + qr + '\n');
      return;
    } catch {
      // 降级：尝试直接作为文本内容生成二维码
    }
  }
  // 尝试用扫码内容本身生成二维码
  const qr = await qrcode.toString(qrContent, { type: 'terminal', small: true });
  console.log('\n' + qr + '\n');
}

/**
 * 执行 QR 扫码绑定流程
 * 返回 ilink_bot_id, bot_token, ilink_user_id
 */
export async function bindWechatQR(): Promise<{ botId: string; botToken: string; ilinkUserId: string }> {
  console.log('\n📱 WeChat QR Code Binding');
  console.log('Fetching QR code...');

  let refreshCount = 0;
  let currentToken: string | undefined;

  while (refreshCount < MAX_QR_REFRESH) {
    const { qrcode, qrcode_img_content } = await getBotQrcode([], currentToken);

    console.log('Please scan the following QR code with WeChat:');
    await renderQR(qrcode_img_content || qrcode);
    console.log('Waiting for scan...');

    const start = Date.now();
    while (Date.now() - start < QR_POLL_TIMEOUT_MS) {
      const statusResult = await getQrcodeStatus(qrcode, currentToken);

      switch (statusResult.status) {
        case 'confirmed':
          console.log('\n✅ QR scan successful!');
          const creds: StoredCreds = {
            botId: statusResult.ilink_bot_id!,
            botToken: statusResult.bot_token!,
            ilinkUserId: statusResult.ilink_user_id!,
            boundAt: new Date().toISOString(),
          };
          saveCreds(creds);
          return { botId: creds.botId, botToken: creds.botToken, ilinkUserId: creds.ilinkUserId };

        case 'binded_redirect':
          // 已绑定过，需要用 token 重新获取
          if (statusResult.bot_token) {
            currentToken = statusResult.bot_token;
            // 继续用 token 刷新二维码
          }
          break;

        case 'scaned_but_redirect':
          // IDC 重定向，刷新二维码
          break;

        case 'scaned':
          process.stdout.write('.');
          break;

        case 'need_verifycode':
          console.log('\n⚠️ Pairing code required (number shown on phone WeChat)');
          console.log('This feature does not support automatic handling yet, please verify on phone and retry');
          throw new Error('Pairing code verification required');

        case 'verify_code_blocked':
          throw new Error('Pairing code entered incorrectly too many times, please re-scan');

        case 'expired':
          console.log('\n⏱ QR code expired, refreshing...');
          refreshCount++;
          break;

        case 'wait':
        default:
          break;
      }

      await new Promise(r => setTimeout(r, QR_POLL_INTERVAL_MS));
    }

    refreshCount++;
    console.log('\n⏱ QR scan timed out, refreshing QR code...');
  }

  console.log('\n❌ QR code refresh limit exceeded, please retry');
  process.exit(1);
}

// ================================================================
// WeChat 配置
// ================================================================

export interface WeChatConfig {
  /** Bot ID（可选，无凭证时自动触发扫码绑定） */
  botId?: string;
  /** Bot Token（可选，无凭证时自动触发扫码绑定） */
  botToken?: string;
  /** iLink User ID（可选） */
  ilinkUserId?: string;
}

// ================================================================
// Stream 管理
// ================================================================

interface StreamState {
  streamTicket: string;
  pieceSeq: number;
  pieces: Array<{ seq: number; piece_data: string }>;
  phase: 'thinking' | 'result';
}

// ================================================================
// WeChat IM 模块
// ================================================================

export class WeChatIMModule implements IMModule {
  private handler: MessageHandler | null = null;
  private running = false;
  private cfg: WeChatConfig;

  // 认证状态
  private botId = '';
  private botToken = '';
  private ilinkUserId = '';

  // Long-poll
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private getUpdatesBuf = '';
  private sessionPausedUntil = 0;

  // 被动回复：保存最近收到的消息 frame（按 chatId）
  private pendingFrames = new Map<string, ILinkMessage>();

  // context_token 管理
  private contextTokens = new Map<string, string>(); // key: userId@chatId → token

  // Stream 管理
  private streams = new Map<string, StreamState>();

  constructor(cfg: WeChatConfig = {}) {
    this.cfg = cfg;
  }

  getCapabilities(): IMCapabilities {
    return {
      text: true,
      codeBlock: false,       // WeChat doesn't support code blocks
      cardMessage: false,
      fileSend: true,
      imageSend: true,
      audioSend: false,
      buttonAction: false,
      maxTextLength: TEXT_MAX,
    };
  }

  // ── 启动 / 停止 ──

  start(handler: MessageHandler): void {
    if (this.running) {
      console.warn('[WeChat] Already running');
      return;
    }
    this.handler = handler;
    this.running = true;
    this._connect();
  }

  stop(): void {
    this.running = false;
    if (this.pollTimer) { clearTimeout(this.pollTimer); this.pollTimer = null; }
    this._notifyStop().catch(() => {});
    this.handler = null;
    console.log('[WeChat] Disconnected');
  }

  // ── 连接 & 认证 ──

  private async _connect(): Promise<void> {
    // 1. 获取凭证：配置 → 本地存储 → 扫码绑定
    this.botId = this.cfg.botId || '';
    this.botToken = this.cfg.botToken || '';
    this.ilinkUserId = this.cfg.ilinkUserId || '';

    if (!this.botId || !this.botToken) {
      const stored = loadCreds();
      if (stored) {
        this.botId = stored.botId;
        this.botToken = stored.botToken;
        this.ilinkUserId = stored.ilinkUserId;
        console.log('[WeChat] Loaded local credentials');
      }
    }

    if (!this.botId || !this.botToken) {
      console.log('[WeChat] No credentials found, starting QR binding...');
      const bound = await bindWechatQR();
      this.botId = bound.botId;
      this.botToken = bound.botToken;
      this.ilinkUserId = bound.ilinkUserId;
    }

    // 2. 加载 context_token
    this.contextTokens = new Map(Object.entries(loadContextTokens()));

    console.log(`[WeChat] Authenticated (bot: ${this.botId.slice(0, 8)}...)`);

    // 3. Notify online
    await this._notifyStart();

    // 4. 启动 long-poll
    this._pollLoop();
  }

  // ── 上线/下线通知 ──

  private async _notifyStart(): Promise<void> {
    try {
      await ilinkPost('ilink/bot/msg/notifystart', {
        base_info: { channel_version: CHANNEL_VERSION, bot_agent: 'IMtoAgent' },
      }, this.botToken);
      console.log('[WeChat] Notified online');
    } catch (e: unknown) {
      console.warn(`[WeChat] Failed to notify online: ${e.message}`);
    }
  }

  private async _notifyStop(): Promise<void> {
    if (!this.botToken) return;
    try {
      await ilinkPost('ilink/bot/msg/notifystop', {
        base_info: { channel_version: CHANNEL_VERSION, bot_agent: 'IMtoAgent' },
      }, this.botToken);
    } catch {}
  }

  // ── Long-Poll 收消息 ──

  private _pollLoop(): void {
    if (!this.running) return;

    // 检查 session 是否暂停（过期冷却）
    if (Date.now() < this.sessionPausedUntil) {
      const remaining = Math.ceil((this.sessionPausedUntil - Date.now()) / 1000);
      console.log(`[WeChat] Session cooling down, ${remaining}s remaining`);
      this.pollTimer = setTimeout(() => this._pollLoop(), Math.min(remaining * 1000, 60000));
      return;
    }

    this._pollOnce().catch(e => {
      console.error(`[WeChat] Poll error: ${e.message}`);
      if (this.running) {
        this.pollTimer = setTimeout(() => this._pollLoop(), LONGPOLL_RETRY_DELAY_MS);
      }
    });
  }

  private async _pollOnce(): Promise<void> {
    if (!this.running) return;

    const result: GetUpdatesResponse = await ilinkPost('ilink/bot/getupdates', {
      get_updates_buf: this.getUpdatesBuf,
      base_info: { channel_version: CHANNEL_VERSION, bot_agent: 'IMtoAgent' },
    }, this.botToken);

    if (result.ret === -14) {
      // Session expired, pause for 1 hour
      console.error('[WeChat] ⚠️ Session expired, pausing for 1 hour');
      this.sessionPausedUntil = Date.now() + SESSION_PAUSE_MS;
      this.pollTimer = setTimeout(() => this._pollLoop(), SESSION_PAUSE_MS);
      return;
    }

    if (result.ret !== 0) {
      throw new Error(`getupdates error: ret=${result.ret} ${result.errmsg || ''}`);
    }

    // 保存续传 buf
    if (result.get_updates_buf) {
      this.getUpdatesBuf = result.get_updates_buf;
    }

    // 处理消息
    if (result.msgs && result.msgs.length > 0) {
      for (const msg of result.msgs) {
        try {
          await this._handleMessage(msg);
        } catch (e: unknown) {
          console.error(`[WeChat] Message processing error: ${e.message}`);
        }
      }
    }

    // 继续下一轮
    if (this.running) {
      this._pollLoop();
    }
  }

  // ── 消息解析 ──

  private async _handleMessage(msg: ILinkMessage): Promise<void> {
    const fromUser = msg.from_user_id;
    if (!fromUser) return;

    // 标准化 chatId：去掉 @im.wechat 后缀用于内部标识
    const chatId = fromUser;
    const userId = fromUser;

    // 保存 context_token
    this.contextTokens.set(`${userId}`, msg.context_token);
    saveContextTokens(Object.fromEntries(this.contextTokens));

    let text = '';
    const attachments: MessageAttachment[] = [];

    for (const item of msg.item_list) {
      switch (item.type) {
        case MessageItemType.TEXT:
          if (item.text_item) {
            text += item.text_item.text;
          }
          break;

        case MessageItemType.IMAGE:
          text += text ? ' [Image]' : '[Image]';
          if (item.image_item?.media) {
            const localPath = await this._downloadMedia(item.image_item.media, item.image_item.aeskey, 'image.png');
            if (localPath) {
              attachments.push({ type: 'image', localPath, sourceKey: msg.message_id, mimeType: 'image/png' });
            }
          }
          break;

        case MessageItemType.VOICE:
          text += text ? ' [Voice]' : '[Voice]';
          if (item.voice_item?.media) {
            const localPath = await this._downloadMedia(item.voice_item.media, item.voice_item.aeskey, 'voice.silk');
            if (localPath) {
              attachments.push({ type: 'audio', localPath, filename: 'voice.silk', sourceKey: msg.message_id });
            }
          }
          break;

        case MessageItemType.FILE:
          text += text ? ' [File]' : '[File]';
          if (item.file_item?.media) {
            const localPath = await this._downloadMedia(item.file_item.media, item.file_item.aeskey, 'file');
            if (localPath) {
              attachments.push({ type: 'file', localPath, filename: 'file', sourceKey: msg.message_id });
            }
          }
          break;

        case MessageItemType.VIDEO:
          text += text ? ' [Video]' : '[Video]';
          if (item.video_item?.media) {
            const localPath = await this._downloadMedia(item.video_item.media, item.video_item.aeskey, 'video.mp4');
            if (localPath) {
              attachments.push({ type: 'file', localPath, filename: 'video.mp4', sourceKey: msg.message_id });
            }
          }
          break;
      }
    }

    const preview = text.length > 80 ? text.slice(0, 80) + '...' : text;
    console.log(`[WeChat] DM ${userId.slice(0, 12)}...: ${preview}`);

    // 保存 frame 用于被动回复
    this.pendingFrames.set(chatId, msg);
    // 限制 pendingFrames 大小
    if (this.pendingFrames.size > 100) {
      const firstKey = this.pendingFrames.keys().next().value;
      if (firstKey) this.pendingFrames.delete(firstKey);
    }

    logEvent({
      event: 'im_message_received',
      adapter: 'wechat',
      chatId,
      userId,
      textLength: text?.length || 0,
      attachmentCount: attachments.length,
    });
    if (this.handler) {
      await this.handler(chatId, text.trim(), userId, attachments.length ? attachments : undefined);
    }
  }

  // ── 发送消息 ──

  async reply(chatId: string, text: string, maxLen?: number): Promise<void> {
    const max = maxLen || TEXT_MAX;
    const safe = text.length > max ? text.slice(0, max) + '\n…truncated' : text;
    try {
      await this._sendMessage(chatId, [
        { type: MessageItemType.TEXT, text_item: { text: safe } },
      ]);
      logEvent({ event: 'im_message_sent', adapter: 'wechat', chatId, textLength: safe.length });
    } catch (e: unknown) {
      logEvent({ event: 'im_send_error', adapter: 'wechat', chatId, error: (e as Error).message });
      throw e;
    }
  }

  async sendProgress(chatId: string, text: string): Promise<void> {
    await this.reply(chatId, text);
  }

  /**
   * 流式回复（token-by-token）
   */
  async replyStream(chatId: string, streamId: string, content: string, finish: boolean): Promise<void> {
    let state = this.streams.get(streamId);

    if (!state) {
      // 初始化流式通道
      try {
        const ticket = await this._initStream();
        state = { streamTicket: ticket, pieceSeq: 0, pieces: [], phase: 'result' };
        this.streams.set(streamId, state);
        // 发送 thinking 阶段结束信号
        await this._sendStreamSignal(state.streamTicket, 'thinking', true);
      } catch (e: unknown) {
        console.error(`[WeChat] Stream init failed, falling back to normal reply: ${e.message}`);
        await this.reply(chatId, content);
        return;
      }
    }

    // 添加 piece
    const pieceData = JSON.stringify({ type: 'text', text: content });
    state.pieces.push({
      seq: state.pieceSeq++,
      piece_data: Buffer.from(pieceData).toString('base64'),
    });

    // 达到批量上传阈值或结束，上传
    if (state.pieces.length >= STREAM_PIECE_MAX || finish) {
      await this._syncStream(state.streamTicket, state.pieces, finish ? state.pieceSeq - 1 : undefined);
      state.pieces = [];
    }

    if (finish) {
      this.streams.delete(streamId);
    }
  }

  /**
   * 非阻塞流式回复
   */
  async replyStreamNonBlocking(chatId: string, streamId: string, content: string, finish: boolean): Promise<void> {
    if (finish) {
      // 最终帧始终发送
      await this.replyStream(chatId, streamId, content, true);
      return;
    }
    // 非阻塞模式：跳过中间帧（简化实现，微信流式本身就有排队机制）
    await this.replyStream(chatId, streamId, content, false);
  }

  async sendBlocks(chatId: string, blocks: UnifiedBlock[]): Promise<void> {
    const texts: string[] = [];
    for (const b of blocks) {
      switch (b.type) {
        case 'text':
          texts.push(b.content);
          break;
        case 'code_block':
          texts.push(`\`${b.language || 'code'}\`\n${b.code}`);
          break;
        case 'card':
          texts.push(`**${b.title}**\n${b.content || ''}`);
          break;
        case 'divider':
          texts.push('---');
          break;
        case 'table':
          texts.push('| ' + b.headers.join(' | ') + ' |\n' + b.rows.map(r => '| ' + r.join(' | ') + ' |').join('\n'));
          break;
        case 'image':
          if (b.url) {
            try {
              await this._sendImageFromSource(chatId, b.url, b.title || 'image.png');
            } catch (e: unknown) {
              console.error(`[WeChat] Image send failed: ${e.message}`);
            }
          }
          break;
        case 'file':
          if (b.url) {
            try {
              await this._sendFileFromSource(chatId, b.url, b.title || b.filename || 'file');
            } catch (e: unknown) {
              console.error(`[WeChat] File send failed: ${e.message}`);
            }
          }
          break;
      }
    }
    if (texts.length) await this.reply(chatId, texts.join('\n\n'));
  }

  async sendImage(chatId: string, imageKey: string, _alt?: string): Promise<void> {
    try {
      await this._sendImageFromSource(chatId, imageKey, this._basename(imageKey));
    } catch (e: unknown) {
      console.error(`[WeChat] Image send failed: ${e.message}`);
    }
  }

  async sendFile(chatId: string, fileKey: string, fileName: string): Promise<void> {
    try {
      await this._sendFileFromSource(chatId, fileKey, fileName);
    } catch (e: unknown) {
      console.error(`[WeChat] File send failed: ${e.message}`);
    }
  }

  // ── 核心：发送消息到 iLink ──

  private async _sendMessage(toUserId: string, itemList: ILinkItem[]): Promise<void> {
    const contextToken = this.contextTokens.get(toUserId) || '';

    const body = {
      msg: {
        from_user_id: '',
        to_user_id: toUserId,
        client_id: `imtoagent-${this.botId}`,
        message_type: 2,  // BOT
        message_state: 2, // FINISH
        item_list: itemList,
        context_token: contextToken,
      },
    };

    try {
      await ilinkPost('ilink/bot/sendmessage', body, this.botToken);
    } catch (e: unknown) {
      console.error(`[WeChat] Send failed: ${e.message}`);
    }
  }

  // ── Streaming ──

  private async _initStream(): Promise<string> {
    const result = await ilinkPost('ilink/bot/init_stream', {
      base_info: { channel_version: CHANNEL_VERSION, bot_agent: 'IMtoAgent' },
    }, this.botToken);
    if (result.ret !== 0 || !result.stream_ticket) {
      throw new Error(`initStream failed: ${JSON.stringify(result).slice(0, 200)}`);
    }
    return result.stream_ticket;
  }

  private async _sendStreamSignal(streamTicket: string, phase: 'thinking' | 'result', isEnd: boolean): Promise<void> {
    await ilinkPost('ilink/bot/sync_stream', {
      stream_ticket: streamTicket,
      phase,
      is_end: isEnd,
      pieces: [],
    }, this.botToken);
  }

  private async _syncStream(streamTicket: string, pieces: Array<{ seq: number; piece_data: string }>, endUpPieceSeq?: number): Promise<void> {
    if (pieces.length === 0) return;
    await ilinkPost('ilink/bot/sync_stream', {
      stream_ticket: streamTicket,
      phase: 'result',
      is_end: false,
      pieces,
      ...(endUpPieceSeq !== undefined ? { end_up_piece_seq: endUpPieceSeq } : {}),
    }, this.botToken);
  }

  // ── 媒体下载（CDN + AES 解密） ──

  private async _downloadMedia(media: ILinkMedia, aesKeyHex: string | undefined, fallbackName: string): Promise<string | null> {
    try {
      // 1. 构造下载 URL
      let downloadUrl = '';
      if (media.full_url) {
        downloadUrl = media.full_url;
      } else if (media.encrypt_query_param) {
        downloadUrl = `${CDN_BASE}?${media.encrypt_query_param}`;
      } else {
        console.error('[WeChat] Media download: no URL available');
        return null;
      }

      // 2. 下载加密文件
      const encrypted = await this._fetchUrlBuffer(downloadUrl);
      if (!encrypted || encrypted.length === 0) return null;

      // 3. AES 解密
      let decrypted: Buffer;
      if (aesKeyHex) {
        decrypted = aesDecrypt(encrypted, aesKeyHex);
      } else if (media.aes_key) {
        // aes_key 可能是 base64(raw 16 bytes) 或 hex
        let keyHex: string;
        try {
          keyHex = Buffer.from(media.aes_key, 'base64').toString('hex');
        } catch {
          keyHex = media.aes_key;
        }
        decrypted = aesDecrypt(encrypted, keyHex);
      } else {
        // 无密钥，可能是未加密内容
        decrypted = encrypted;
      }

      // 4. 保存到本地
      fs.mkdirSync(MEDIA_DIR, { recursive: true });
      const filePath = path.join(MEDIA_DIR, `${Date.now()}_${fallbackName}`);
      fs.writeFileSync(filePath, decrypted);
      console.log(`[WeChat] Media downloaded: ${filePath}`);
      return filePath;
    } catch (e: unknown) {
      console.error(`[WeChat] Media download failed: ${e.message}`);
      return null;
    }
  }

  // ── 媒体上传（AES 加密 + CDN 上传） ──

  private async _uploadMedia(buffer: Buffer, mediaType: 'image' | 'file' | 'video'): Promise<{ encryptQuery: string; aesKey: string; fileKey: string } | null> {
    try {
      const fileMd5 = md5Hex(buffer);
      const fileKey = crypto.randomBytes(16).toString('hex');
      const aesKey = generateAesKeyHex();

      // 1. 加密
      const encrypted = aesEncrypt(buffer, aesKey);

      // 2. 获取上传 URL
      const uploadResult = await ilinkPost('ilink/bot/getuploadurl', {
        file_md5: fileMd5,
        file_size: encrypted.length,
        file_type: mediaType,
        file_key: fileKey,
        base_info: { channel_version: CHANNEL_VERSION, bot_agent: 'IMtoAgent' },
      }, this.botToken);

      if (uploadResult.ret !== 0) {
        throw new Error(`getUploadUrl failed: ${JSON.stringify(uploadResult).slice(0, 200)}`);
      }

      const uploadUrl = uploadResult.upload_full_url || uploadResult.upload_url;
      if (!uploadUrl) {
        throw new Error('Failed to get upload URL');
      }

      // 3. 上传加密文件到 CDN
      await this._uploadToCdn(uploadUrl, encrypted);

      // 4. 返回上传结果
      const encryptQuery = uploadResult.encrypt_query_param || uploadResult.encrypt_query;
      return { encryptQuery, aesKey, fileKey };
    } catch (e: unknown) {
      console.error(`[WeChat] Media upload failed: ${e.message}`);
      return null;
    }
  }

  private _uploadToCdn(url: string, buffer: Buffer): Promise<void> {
    return new Promise((resolve, reject) => {
      const parsed = new URL(url);
      const lib = parsed.protocol === 'https:' ? https : http;
      // CDN 上传默认 POST（Tencent CDN 标准）
      const req = lib.request(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/octet-stream',
          'Content-Length': String(buffer.length),
        },
        timeout: 60000,
      }, res => {
        let data = '';
        res.on('data', c => (data += c));
        res.on('end', () => {
          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
            resolve();
          } else {
            reject(new Error(`CDN upload failed: HTTP ${res.statusCode} ${data.slice(0, 100)}`));
          }
        });
      });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('CDN upload timed out')); });
      req.write(buffer);
      req.end();
    });
  }

  // ── 从来源发送图片 ──

  private async _sendImageFromSource(chatId: string, source: string, fileName: string): Promise<void> {
    const buffer = await this._readSource(source);
    if (!buffer) return;

    const upload = await this._uploadMedia(buffer, 'image');
    if (!upload) return;

    await this._sendMessage(chatId, [
      {
        type: MessageItemType.IMAGE,
        image_item: {
          media: {
            encrypt_query_param: upload.encryptQuery,
            aes_key: upload.aesKey,
          },
          aeskey: upload.aesKey,
        },
      },
    ]);
  }

  // ── 从来源发送文件 ──

  private async _sendFileFromSource(chatId: string, source: string, fileName: string): Promise<void> {
    const buffer = await this._readSource(source);
    if (!buffer) return;

    const upload = await this._uploadMedia(buffer, 'file');
    if (!upload) return;

    await this._sendMessage(chatId, [
      {
        type: MessageItemType.FILE,
        file_item: {
          media: {
            encrypt_query_param: upload.encryptQuery,
            aes_key: upload.aesKey,
          },
          aeskey: upload.aesKey,
        },
      },
    ]);
  }

  // ── 读取来源（本地路径 / URL / data URI） ──

  private async _readSource(source: string): Promise<Buffer | null> {
    if (source.startsWith('data:')) {
      const commaIdx = source.indexOf(',');
      const b64 = source.substring(commaIdx + 1);
      return Buffer.from(b64, 'base64');
    }

    if (source.startsWith('http://') || source.startsWith('https://')) {
      return this._fetchUrlBuffer(source);
    }

    if (fs.existsSync(source)) {
      return fs.readFileSync(source);
    }

    console.error(`[WeChat] File not found: ${source}`);
    return null;
  }

  // ── HTTP 下载 ──

  private _fetchUrlBuffer(url: string): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const parsed = new URL(url);
      const lib = parsed.protocol === 'https:' ? https : http;
      lib.get(url, { timeout: 30000 }, res => {
        if (res.statusCode === 301 || res.statusCode === 302) {
          const location = res.headers.location;
          if (location) {
            this._fetchUrlBuffer(location).then(resolve).catch(reject);
            return;
          }
        }
        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode}`));
          return;
        }
        const chunks: Buffer[] = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => resolve(Buffer.concat(chunks)));
        res.on('error', reject);
      }).on('error', reject).on('timeout', reject);
    });
  }

  private _basename(p: string): string {
    return path.basename(p.split('?')[0]);
  }
}
