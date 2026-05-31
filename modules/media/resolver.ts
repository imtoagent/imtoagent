// ================================================================
// InboundMediaResolver — 媒体下载 → 存储 → Agent 提示 的编排层
// ================================================================
// 职责：
//   1. 使用 InboundMediaAdapter 下载原始 buffer
//   2. 使用 MediaStore 存储并获取标准化 MediaEntry
//   3. 构建 MessageAttachment 列表
//   4. 生成给 Agent 的差异化提示（按文件类型）
//
// 参考 OpenClaw 的 parseMessageWithAttachments 设计
// ================================================================

import type { InboundMediaAdapter, DownloadedMedia, MediaResourceType } from './types';
import type { MediaEntry } from './types';
import type { MessageAttachment } from '../core/types';
import { MediaStore } from './media-store';

/** 单个附件的下载请求描述 */
export interface MediaDownloadRequest {
  /** 消息 ID */
  messageId: string;
  /** 平台资源 key（image_key / file_key 等） */
  resourceKey: string;
  /** 资源类型 */
  type: MediaResourceType;
  /** 原始文件名（如有） */
  fileName?: string;
}

/** Resolver 返回结果 */
export interface ResolveMediaResult {
  /** 标准化附件列表（供 Agent 使用） */
  attachments: MessageAttachment[];
  /** 存储的媒体条目（含分类信息） */
  entries: MediaEntry[];
}

/**
 * 按媒体分类生成差异化的 Agent 提示
 *
 * 相比旧版 buildAttachmentHint，这里根据文件类型给 Agent 不同的操作引导：
 * - PDF → 提示用 PDF 工具
 * - Excel → 提示用表格解析
 * - 纯文本 → 提示可直接 read
 * - 压缩包 → 提示先解压
 * - 未知二进制 → 提示用 file 命令或 sniff
 */
function buildHintForCategory(entry: MediaEntry): string {
  const { localPath, mimeType, category, fileName } = entry;

  switch (category) {
    case 'image':
      return `Image saved locally, path: \`${localPath}\`, format: ${mimeType}, can be opened with an image viewer`;

    case 'audio':
      return `Audio file path: \`${localPath}\`, format: ${mimeType}, can be processed with speech recognition tools`;

    case 'video':
      return `Video file path: \`${localPath}\`, format: ${mimeType}`;

    case 'document':
      return `Document file path: \`${localPath}\`, type: ${mimeType}, can be read directly (if text/PDF) or processed with appropriate tools`;

    case 'text':
      return `Text file path: \`${localPath}\`, can be read directly with a file reading tool`;

    case 'spreadsheet':
      return `Spreadsheet file path: \`${localPath}\`, type: ${mimeType}, can be processed with spreadsheet tools (e.g. Python pandas/openpyxl)`;

    case 'presentation':
      return `Presentation file path: \`${localPath}\`, type: ${mimeType}`;

    case 'archive':
      return `Archive file path: \`${localPath}\`, type: ${mimeType}, needs to be extracted before processing`;

    default:
      return `File path: \`${localPath}\`, format: ${mimeType}, can be analyzed with file tools or read directly`;
  }
}

/**
 * InboundMediaResolver
 *
 * 编排 IM 适配器的下载 + MediaStore 的存储，产出标准 MessageAttachment
 */
export class InboundMediaResolver {
  private readonly adapter: InboundMediaAdapter;
  private readonly store: MediaStore;

  constructor(adapter: InboundMediaAdapter, store?: MediaStore) {
    this.adapter = adapter;
    this.store = store ?? new MediaStore();
  }

  /**
   * 解析单个媒体附件
   */
  async resolveOne(request: MediaDownloadRequest): Promise<{
    attachment: MessageAttachment;
    entry: MediaEntry;
  } | null> {
    try {
      // 1. 通过适配器下载
      const downloaded = await this.adapter.downloadResource(
        request.messageId,
        request.resourceKey,
        request.type,
        request.fileName
      );

      if (!downloaded) {
        console.log(`[${this.adapter.platform}] Failed to download resource: ${request.resourceKey}`);
        return null;
      }

      // 2. 存入 MediaStore
      const entry = this.store.save(
        downloaded.buffer,
        downloaded.contentType,
        downloaded.fileName || request.fileName,
        this.adapter.platform
      );

      // 3. 构建 MessageAttachment（向后兼容旧格式）
      const attachment = this.buildAttachment(entry, downloaded, request);

      return { attachment, entry };
    } catch (e: unknown) {
      console.error(`[${this.adapter.platform}] Media resolution error: ${e.message}`);
      return null;
    }
  }

  /**
   * 批量解析多个媒体附件
   */
  async resolveAll(requests: MediaDownloadRequest[]): Promise<ResolveMediaResult> {
    const results = await Promise.all(
      requests.map(req => this.resolveOne(req))
    );

    const attachments: MessageAttachment[] = [];
    const entries: MediaEntry[] = [];

    for (const r of results) {
      if (r) {
        attachments.push(r.attachment);
        entries.push(r.entry);
      }
    }

    return { attachments, entries };
  }

  // ================================================================
  // Private
  // ================================================================

  private buildAttachment(
    entry: MediaEntry,
    downloaded: DownloadedMedia,
    request: MediaDownloadRequest
  ): MessageAttachment {
    const type = entry.category === 'image' ? 'image'
      : entry.category === 'audio' ? 'audio'
      : 'file';

    return {
      type,
      localPath: entry.localPath,
      filename: entry.fileName,
      sourceKey: downloaded.sourceKey || request.resourceKey,
      mimeType: entry.mimeType,
      durationMs: undefined, // 音频需要的话由调用方补充
      hint: buildHintForCategory(entry), // 预计算的差异化提示
    };
  }
}
