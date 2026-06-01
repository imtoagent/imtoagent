// IM 能力 → Agent Prompt + 输出解析
// Agent 产出文本 → 网关解析为结构化块 → IM 原生渲染

import type { IMCapabilities } from './types';

export type UnifiedBlock =
  | { type: 'text'; content: string }
  | { type: 'code_block'; code: string; language: string; title?: string }
  | { type: 'image'; url: string; alt?: string }
  | { type: 'card'; title: string; content: string; color?: string; buttons?: { label: string; url?: string }[] }
  | { type: 'table'; headers: string[]; rows: string[][]; caption?: string }
  | { type: 'file'; url: string; filename: string }
  | { type: 'audio'; url: string; filename: string; duration?: number }
  | { type: 'divider' };

// ================================================================
// System Prompt：告诉 Agent 可用的输出格式
// ================================================================
// 设计原则：
//   只告诉 Agent 它能通过 markdown 语法表达的能力。
//   IMCapabilities 里 capability=true 但 parseToBlocks 没有对应语法
//   → 不生成提示词，避免 Agent 误以为能输出。
// ================================================================

export function buildCapabilityPrompt(caps: IMCapabilities): string {
  const lines: string[] = [];

  // Overview
  lines.push('## IM Client Environment');
  lines.push('You communicate with users through Feishu (Lark) instant messaging. Your responses are parsed by the gateway into native Feishu message formats.');
  lines.push('');

  // Text limit
  lines.push(`**Text limit**: Maximum ${caps.maxTextLength} characters per message. Longer messages are automatically truncated.`);

  // ========== Only generate capabilities supported by parseToBlocks ==========

  // Code — ``` syntax
  if (caps.codeBlock) {
    lines.push('**Code output**: When outputting code, use standard markdown code blocks (\\```language\\ncode\\n\\```).');
    lines.push('⚠️ Note: Feishu has limited code block rendering. For long code, consider collapsible panels or splitting output to avoid overly long messages.');
  }

  // Image — ![]() syntax
  if (caps.imageSend) {
    lines.push('**Images**: You can send images using markdown syntax `![alt](URL)`. Supports local file:// paths (e.g., chart screenshots) and remote URLs. The gateway handles rendering automatically, no extra upload steps needed.');
  }

  // Tables + Cards — | syntax (requires cardMessage container to render)
  if (caps.cardMessage) {
    lines.push('**Tables**: You can use standard markdown table syntax to display structured data.');
    lines.push('```');
    lines.push('| ColA | ColB |');
    lines.push('| ---- | ---- |');
    lines.push('| Data1 | Data2 |');
    lines.push('```');
    lines.push('**Card messages**: Rich-text cards are supported (multiple blocks are automatically combined into a single card message).');
  }

  // File sending — fileSend + local path syntax
  if (caps.fileSend) {
    lines.push('**Sending files**: If you generate files (charts, CSVs, code files, etc.), use the following syntax in your reply and the gateway will handle upload and delivery automatically — no extra tools needed:');
    lines.push('`📎 [filename](file:///absolute/local/path)`');
    lines.push('Example: `📎 [analysis.csv](file:///tmp/result.csv)`');
  }


  // Audio sending — audioSend + local path syntax
  if (caps.audioSend) {
    lines.push('**Audio**: If you generate audio files (TTS, recordings, etc.), use the following syntax and the gateway will handle it:');
    lines.push('`🎙️ [filename](file:///absolute/local/path)`');
    lines.push('Example: `🎙️ [announcement.mp3](file:///tmp/tts-output.mp3)`');
  }

  // Button — custom markdown to trigger card action buttons
  if (caps.buttonAction) {
    lines.push('**Buttons**: You can add action buttons to a message using this syntax on its own line:');
    lines.push('`[BUTTON: Label](action_url)`');
    lines.push('Each button line is rendered as an interactive card button. Multiple lines = multiple buttons.');
    lines.push('');
  }

  // Divider — available when cardMessage is supported
  if (caps.cardMessage) {
    lines.push('**Divider**: Use `---` on a line by itself to insert a horizontal divider between sections.');
    lines.push('');
  }

  lines.push('');
  lines.push('### Behavior Rules');
    lines.push('- Do not mention or attempt to invoke third-party upload tools like lark-cli, feishu, etc. — the gateway automatically parses 📎 and ![image]() syntax and handles sending');
  lines.push('- **After each file modification/creation/deletion, briefly report the result** (e.g., "Modified xxx.ts, fixed the YYY issue"), don\'t silently finish');
  lines.push('- Summarize what you did in one or two sentences after completing a task');
  lines.push('');
  lines.push('### Format Conversion Rules');
  lines.push('- Your reply is parsed as markdown into multiple blocks (text, code, images, cards, etc.)');
  lines.push('- Each block is rendered as the corresponding native Feishu element');
  lines.push('- Do not mention these technical details, just use the appropriate format directly');

  return lines.join('\n');
}

// ================================================================
// 输出解析：Agent 文本 → UnifiedBlock[]
// ================================================================

export function parseToBlocks(text: string, caps: IMCapabilities): UnifiedBlock[] {
  const blocks: UnifiedBlock[] = [];

  // 构建所有匹配模式
  type MatchDef = { regex: RegExp; make: (m: RegExpExecArray) => UnifiedBlock };
  const patterns: MatchDef[] = [];
  if (caps.codeBlock) {
    patterns.push({
      regex: /```(\w*)\n([\s\S]*?)```/g,
      make: (m) => ({ type: 'code_block', code: m[2].trim(), language: m[1] || '' }),
    });
  }
  if (caps.audioSend) {
    patterns.push({
      regex: /🎙️\s*\[([^\]]*)\]\((file:\/\/[^\s]+?)\)/g,
      make: (m) => ({ type: 'audio', url: m[2], filename: m[1] }),
    });
  }
  if (caps.imageSend) {
    patterns.push({
      regex: /!\[([^\]]*)\]\(([^)]+)\)/g,
      make: (m) => ({ type: 'image', alt: m[1], url: m[2] }),
    });
  }
  if (caps.fileSend) {
    patterns.push({
      regex: /📎\s*\[([^\]]*)\]\((file:\/\/[^\s]+?)\)/g,
      make: (m) => ({ type: 'file', url: m[2], filename: m[1] }),
    });
  }

  // Button syntax: [BUTTON: Label](url) — only when buttonAction enabled
  if (caps.buttonAction) {
    patterns.push({
      regex: /\[BUTTON:\s*([^\]]+)\]\(([^)]+)\)/g,
      make: (m) => ({ type: 'card', title: '', content: '', buttons: [{ label: m[1].trim(), url: m[2].trim() }] }),
    });
  }

  // Divider: standalone --- line — only when cardMessage enabled
  if (caps.cardMessage) {
    patterns.push({
      regex: /(?:^|\n)\s*---\s*(?:\n|$)/gm,
      make: () => ({ type: 'divider' }),
    });
  }

  // 表格：仅在有 cardMessage 能力时解析
  // 匹配 markdown 表格：表头行 | 分隔行 | 数据行...
  const tableRegex = caps.cardMessage
    ? /(?:^[^\n]*\n)?\|[^|\n]+\|[^|\n]*\|\n\|[-: |]+\|\n(?:\|[^|\n]+\|[^|\n]*\|\n?)+/gm
    : null;

  // 第一遍：收集表格匹配位置（标记为"占位"，避免被其他正则误匹配）
  type TableMatch = { index: number; end: number; block: UnifiedBlock };
  const tableMatches: TableMatch[] = [];
  const tableMasked = text; // 保存原文本用于表格内容提取
  if (tableRegex) {
    tableRegex.lastIndex = 0;
    let tm: RegExpExecArray | null;
    while ((tm = tableRegex.exec(text)) !== null) {
      const lines = tm[0].split('\n').filter(l => l.startsWith('|'));
      if (lines.length < 3) continue; // 至少需要 header + separator + 1 row
      const headerCells = lines[0].split('|').map(c => c.trim()).filter(Boolean);
      const rows = lines.slice(2).map(l =>
        l.split('|').map(c => c.trim()).filter(Boolean)
      );
      if (headerCells.length === 0 || rows.length === 0) continue;
      tableMatches.push({
        index: tm.index,
        end: tm.index + tm[0].length,
        block: { type: 'table', headers: headerCells, rows },
      });
    }
  }

  if (patterns.length === 0 && tableMatches.length === 0) return [{ type: 'text', content: text }];

  // 收集所有匹配，按位置排序
  const hits: { index: number; end: number; block: UnifiedBlock }[] = [];
  for (const p of patterns) {
    p.regex.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = p.regex.exec(text)) !== null) {
      hits.push({ index: m.index, end: m.index + m[0].length, block: p.make(m) });
    }
  }
  hits.push(...tableMatches);
  hits.sort((a, b) => a.index - b.index);

  // 去重（重叠匹配只保留第一个，表格优先因为可能更长）
  const deduped: typeof hits = [];
  for (const h of hits) {
    if (deduped.length > 0 && h.index < deduped[deduped.length - 1].end) continue;
    deduped.push(h);
  }

  // 按位置切分
  let lastIndex = 0;
  for (const h of deduped) {
    const before = text.slice(lastIndex, h.index).trim();
    if (before) blocks.push({ type: 'text', content: before });
    blocks.push(h.block);
    lastIndex = h.end;
  }
  const after = text.slice(lastIndex).trim();
  if (after) blocks.push({ type: 'text', content: after });
  if (blocks.length === 0) blocks.push({ type: 'text', content: text });

  return blocks;
}
