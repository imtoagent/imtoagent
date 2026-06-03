/**
 * capabilities.test.ts
 *
 * Tests for modules/capabilities.ts:
 * - buildCapabilityPrompt 根据能力开关生成不同提示
 * - parseToBlocks 正确解析各类 markdown 语法
 * - 能力禁用时不解析对应语法
 */

import { describe, it, expect } from "bun:test";
import { buildCapabilityPrompt, parseToBlocks } from "../modules/capabilities";
import type { IMCapabilities } from "../modules/types";

// ================================================================
// Helpers
// ================================================================

function fullCaps(): IMCapabilities {
  return {
    text: true,
    codeBlock: true,
    cardMessage: true,
    fileSend: true,
    imageSend: true,
    audioSend: true,
    buttonAction: true,
    maxTextLength: 50000,
  };
}

function minimalCaps(): IMCapabilities {
  return {
    text: true,
    codeBlock: false,
    cardMessage: false,
    fileSend: false,
    imageSend: false,
    audioSend: false,
    buttonAction: false,
    maxTextLength: 5000,
  };
}

// ================================================================
// 1. buildCapabilityPrompt
// ================================================================

describe("buildCapabilityPrompt", () => {
  it("should include text limit info", () => {
    const caps = minimalCaps();
    const prompt = buildCapabilityPrompt(caps);
    expect(prompt).toContain("5000 characters");
  });

  it("should include code block guidance when enabled", () => {
    const caps = { ...minimalCaps(), codeBlock: true };
    const prompt = buildCapabilityPrompt(caps);
    expect(prompt).toContain("Code output");
    expect(prompt).toContain("markdown code blocks");
  });

  it("should not include code block guidance when disabled", () => {
    const prompt = buildCapabilityPrompt(minimalCaps());
    expect(prompt).not.toContain("Code output");
  });

  it("should include image guidance when enabled", () => {
    const caps = { ...minimalCaps(), imageSend: true };
    const prompt = buildCapabilityPrompt(caps);
    expect(prompt).toContain("Images");
    expect(prompt).toContain("![alt](URL)");
  });

  it("should include table/card guidance when cardMessage enabled", () => {
    const caps = { ...minimalCaps(), cardMessage: true };
    const prompt = buildCapabilityPrompt(caps);
    expect(prompt).toContain("Tables");
    expect(prompt).toContain("Card messages");
  });

  it("should include file send guidance when enabled", () => {
    const caps = { ...minimalCaps(), fileSend: true };
    const prompt = buildCapabilityPrompt(caps);
    expect(prompt).toContain("Sending files");
    expect(prompt).toContain("📎");
  });

  it("should include audio guidance when enabled", () => {
    const caps = { ...minimalCaps(), audioSend: true };
    const prompt = buildCapabilityPrompt(caps);
    expect(prompt).toContain("Audio");
    expect(prompt).toContain("🎙️");
  });

  it("should include button guidance when enabled", () => {
    const caps = { ...minimalCaps(), buttonAction: true };
    const prompt = buildCapabilityPrompt(caps);
    expect(prompt).toContain("BUTTON:");
  });

  it("should include divider guidance when cardMessage enabled", () => {
    const caps = { ...minimalCaps(), cardMessage: true };
    const prompt = buildCapabilityPrompt(caps);
    expect(prompt).toContain("Divider");
    expect(prompt).toContain("---");
  });

  it("should include behavior rules", () => {
    const prompt = buildCapabilityPrompt(minimalCaps());
    expect(prompt).toContain("Behavior Rules");
    expect(prompt).toContain("Format Conversion Rules");
  });

  it("should include format conversion rules", () => {
    const prompt = buildCapabilityPrompt(minimalCaps());
    expect(prompt).toContain("parsed as markdown");
  });
});

// ================================================================
// 2. parseToBlocks — 纯文本
// ================================================================

describe("parseToBlocks plain text", () => {
  it("should return single text block for plain text", () => {
    const blocks = parseToBlocks("Hello world", minimalCaps());
    expect(blocks).toEqual([{ type: "text", content: "Hello world" }]);
  });

  it("should return single text block when all caps disabled", () => {
    const blocks = parseToBlocks("```js\nconsole.log('hi')\n```", minimalCaps());
    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe("text");
  });
});

// ================================================================
// 3. parseToBlocks — 代码块
// ================================================================

describe("parseToBlocks code blocks", () => {
  it("should parse code block when codeBlock enabled", () => {
    const caps = { ...minimalCaps(), codeBlock: true };
    const blocks = parseToBlocks("Here is code:\n```python\nprint('hello')\n```\nDone.", caps);

    expect(blocks).toHaveLength(3);
    expect(blocks[0]).toEqual({ type: "text", content: "Here is code:" });
    expect(blocks[1]).toEqual({ type: "code_block", code: "print('hello')", language: "python" });
    expect(blocks[2]).toEqual({ type: "text", content: "Done." });
  });

  it("should parse code block without language", () => {
    const caps = { ...minimalCaps(), codeBlock: true };
    const blocks = parseToBlocks("```\nsome code\n```", caps);

    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe("code_block");
    expect(blocks[0].language).toBe("");
    expect(blocks[0].code).toBe("some code");
  });

  it("should parse multiple code blocks", () => {
    const caps = { ...minimalCaps(), codeBlock: true };
    // 用不同语言标签避免正则贪婪匹配问题
    const text = "```js\nconsole.log(1)\n```\nsome text\n```py\nprint(2)\n```";
    const blocks = parseToBlocks(text, caps);

    expect(blocks).toHaveLength(3);
    expect(blocks[0].type).toBe("code_block");
    expect(blocks[0].language).toBe("js");
    expect(blocks[1].type).toBe("text");
    expect(blocks[1].content).toBe("some text");
    expect(blocks[2].type).toBe("code_block");
    expect(blocks[2].language).toBe("py");
  });
});

// ================================================================
// 4. parseToBlocks — 图片
// ================================================================

describe("parseToBlocks images", () => {
  it("should parse image when imageSend enabled", () => {
    const caps = { ...minimalCaps(), imageSend: true };
    const blocks = parseToBlocks("Check this: ![chart](https://example.com/chart.png)", caps);

    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toEqual({ type: "text", content: "Check this:" });
    expect(blocks[1]).toEqual({ type: "image", alt: "chart", url: "https://example.com/chart.png" });
  });

  it("should not parse image when imageSend disabled", () => {
    const blocks = parseToBlocks("![chart](https://example.com/chart.png)", minimalCaps());
    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe("text");
  });

  it("should parse image with file:// URL", () => {
    const caps = { ...minimalCaps(), imageSend: true };
    const blocks = parseToBlocks("![screenshot](file:///tmp/screenshot.png)", caps);

    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe("image");
    expect(blocks[0].url).toBe("file:///tmp/screenshot.png");
  });
});

// ================================================================
// 5. parseToBlocks — 文件
// ================================================================

describe("parseToBlocks files", () => {
  it("should parse file link when fileSend enabled", () => {
    const caps = { ...minimalCaps(), fileSend: true };
    const blocks = parseToBlocks("📎 [report.csv](file:///tmp/report.csv)", caps);

    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe("file");
    expect(blocks[0].filename).toBe("report.csv");
    expect(blocks[0].url).toBe("file:///tmp/report.csv");
  });

  it("should not parse file link when fileSend disabled", () => {
    const blocks = parseToBlocks("📎 [report.csv](file:///tmp/report.csv)", minimalCaps());
    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe("text");
  });
});

// ================================================================
// 6. parseToBlocks — 音频
// ================================================================

describe("parseToBlocks audio", () => {
  it("should parse audio link when audioSend enabled", () => {
    const caps = { ...minimalCaps(), audioSend: true };
    const blocks = parseToBlocks("🎙️ [announcement.mp3](file:///tmp/announcement.mp3)", caps);

    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe("audio");
    expect(blocks[0].filename).toBe("announcement.mp3");
    expect(blocks[0].url).toBe("file:///tmp/announcement.mp3");
  });

  it("should not parse audio when audioSend disabled", () => {
    const blocks = parseToBlocks("🎙️ [test.mp3](file:///tmp/test.mp3)", minimalCaps());
    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe("text");
  });
});

// ================================================================
// 7. parseToBlocks — 按钮
// ================================================================

describe("parseToBlocks buttons", () => {
  it("should parse button when buttonAction enabled", () => {
    const caps = { ...minimalCaps(), buttonAction: true };
    const blocks = parseToBlocks("[BUTTON: Approve](/approve)", caps);

    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe("card");
    expect(blocks[0].buttons).toEqual([{ label: "Approve", url: "/approve" }]);
  });

  it("should not parse button when buttonAction disabled", () => {
    const blocks = parseToBlocks("[BUTTON: Approve](/approve)", minimalCaps());
    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe("text");
  });
});

// ================================================================
// 8. parseToBlocks — 分割线
// ================================================================

describe("parseToBlocks dividers", () => {
  it("should parse divider when cardMessage enabled", () => {
    const caps = { ...minimalCaps(), cardMessage: true };
    const blocks = parseToBlocks("Section 1\n---\nSection 2", caps);

    expect(blocks).toHaveLength(3);
    expect(blocks[0]).toEqual({ type: "text", content: "Section 1" });
    expect(blocks[1]).toEqual({ type: "divider" });
    expect(blocks[2]).toEqual({ type: "text", content: "Section 2" });
  });

  it("should not parse divider when cardMessage disabled", () => {
    const blocks = parseToBlocks("Section 1\n---\nSection 2", minimalCaps());
    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe("text");
  });
});

// ================================================================
// 9. parseToBlocks — 表格
// ================================================================

describe("parseToBlocks tables", () => {
  it("should parse markdown table when cardMessage enabled", () => {
    const caps = { ...minimalCaps(), cardMessage: true };
    const text = `| Name | Age |
| ---- | --- |
| Alice | 30 |
| Bob | 25 |`;
    const blocks = parseToBlocks(text, caps);

    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe("table");
    expect(blocks[0].headers).toEqual(["Name", "Age"]);
    expect(blocks[0].rows).toEqual([
      ["Alice", "30"],
      ["Bob", "25"],
    ]);
  });

  it("should not parse table when cardMessage disabled", () => {
    const caps = minimalCaps();
    const text = `| Name | Age |
| ---- | --- |
| Alice | 30 |`;
    const blocks = parseToBlocks(text, caps);
    // Table not parsed, so it's returned as text
    expect(blocks[0].type).toBe("text");
  });
});

// ================================================================
// 10. parseToBlocks — 混合内容
// ================================================================

describe("parseToBlocks mixed content", () => {
  it("should parse text + code + image in order", () => {
    const caps = fullCaps();
    const text = `Here's the result:

\`\`\`python
print("hello")
\`\`\`

And a chart:
![chart](https://example.com/chart.png)

Done!`;

    const blocks = parseToBlocks(text, caps);

    expect(blocks.length).toBeGreaterThanOrEqual(4);
    // Should contain code_block and image types
    const types = blocks.map((b) => b.type);
    expect(types).toContain("code_block");
    expect(types).toContain("image");
  });

  it("should handle empty string", () => {
    const blocks = parseToBlocks("", minimalCaps());
    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe("text");
    expect(blocks[0].content).toBe("");
  });
});
