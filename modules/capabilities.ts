// IM 能力 → Agent Prompt + 输出解析
// Agent 产出文本 → 网关解析为结构化块 → IM 原生渲染

import type { IMCapabilities } from './types';
import MarkdownIt from 'markdown-it';

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

type RangeMatch = { index: number; end: number; block: UnifiedBlock };

/**
 * 从 markdown-it inline token 提取纯文本内容
 */
function extractInlineText(token: { children?: Array<{ content?: string }> }): string {
  if (!token.children) return '';
  return token.children.map(c => c.content || '').join('');
}

/**
 * 使用 markdown-it AST 解析文本中的表格
 * 返回表格匹配的位置和结构化数据（headers 和 rows 均保留空单元格）
 */
/** Convert line number to character offset in text */
function lineToOffset(text: string, line: number): number {
  const lines = text.split('\n');
  let offset = 0;
  for (let i = 0; i < Math.min(line, lines.length); i++) {
    offset += lines[i].length + 1; // +1 for the newline char
  }
  return offset;
}

function extractTablesAST(text: string, enabled: boolean): RangeMatch[] {
  if (!enabled) return [];

  const md = new MarkdownIt();
  const tokens = md.parse(text, {});

  const matches: RangeMatch[] = [];
  let i = 0;
  while (i < tokens.length) {
    const tok = tokens[i];
    if (tok.type === 'table_open') {
      // 找到对应的 table_close
      let j = i + 1;
      while (j < tokens.length && tokens[j].type !== 'table_close') j++;
      if (j >= tokens.length) { i++; continue; }

      // 解析表格结构
      const headers: string[] = [];
      const rows: string[][] = [];

      let k = i + 1;
      while (k < j) {
        const inner = tokens[k];
        if (inner.type === 'tr_open') {
          // 找到 tr_close
          let trEnd = k + 1;
          while (trEnd < j && tokens[trEnd].type !== 'tr_close') trEnd++;

          // 提取 tr 内的所有单元格内容（th 或 td）
          const cells: string[] = [];
          let cell = k + 1;
          while (cell < trEnd) {
            const cellTok = tokens[cell];
            if (cellTok.type === 'th_open' || cellTok.type === 'td_open') {
              // 找到 cell_close
              let cellEnd = cell + 1;
              const closeType = cellTok.type.replace('_open', '_close');
              while (cellEnd < trEnd && tokens[cellEnd].type !== closeType) cellEnd++;
              // inline token 在 open/close 之间
              const inlineTok = tokens.slice(cell + 1, cellEnd).find((t: { type: string }) => t.type === 'inline');
              cells.push(inlineTok ? extractInlineText(inlineTok) : '');
              cell = cellEnd + 1;
            } else {
              cell++;
            }
          }

          // 第一行是 header，后续是 data rows
          if (headers.length === 0) {
            headers.push(...cells);
          } else {
            rows.push(cells);
          }

          k = trEnd + 1;
        } else {
          k++;
        }
      }

      if (headers.length > 0 && rows.length > 0) {
        // 对齐所有行的列数
        const colCount = headers.length;
        const paddedRows = rows.map(r => {
          if (r.length < colCount) {
            const padded = [...r];
            while (padded.length < colCount) padded.push('');
            return padded;
          }
          return r.slice(0, colCount);
        });

        // 使用 table token 的 map 属性（行号范围）定位原文中的起止位置
        const tableMap = tok.map;
        let startIdx = 0;
        let endOffset = text.length;
        if (tableMap && tableMap[0] !== undefined) {
          startIdx = lineToOffset(text, tableMap[0]);
          // 结束位置在 tableMap[1] 行的开头（map[1] 是结束行的下一行）
          if (tableMap[1] !== undefined) {
            endOffset = lineToOffset(text, tableMap[1]);
          }
        }
        if (endOffset <= startIdx) {
          // fallback: 用文本搜索
          const headerText = headers[0];
          const found = text.indexOf(headerText);
          startIdx = found >= 0 ? found : 0;
          endOffset = text.length;
        }

        matches.push({
          index: startIdx,
          end: Math.min(endOffset, text.length),
          block: { type: 'table', headers, rows: paddedRows },
        });
      }

      i = j + 1;
    } else {
      i++;
    }
  }
  return matches;
}

export function parseToBlocks(text: string, caps: IMCapabilities): UnifiedBlock[] {
  const blocks: UnifiedBlock[] = [];

  // Step 1: 使用 markdown-it AST 解析表格（优先，不丢失空单元格）
  const tableMatches: RangeMatch[] = extractTablesAST(text, caps.cardMessage);

  // Step 2: 构建正则匹配模式（按钮、图片、文件、代码块、分割线等）
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

  if (patterns.length === 0 && tableMatches.length === 0) return [{ type: 'text', content: text }];

  // Step 3: 收集所有匹配，按位置排序
  const hits: RangeMatch[] = [];
  for (const p of patterns) {
    p.regex.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = p.regex.exec(text)) !== null) {
      hits.push({ index: m.index, end: m.index + m[0].length, block: p.make(m) });
    }
  }
  hits.push(...tableMatches);
  hits.sort((a, b) => a.index - b.index);

  // 去重（重叠匹配只保留第一个）
  const deduped: RangeMatch[] = [];
  for (const h of hits) {
    if (deduped.length > 0 && h.index < deduped[deduped.length - 1].end) continue;
    deduped.push(h);
  }

  // Step 4: 按位置切分文本
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
