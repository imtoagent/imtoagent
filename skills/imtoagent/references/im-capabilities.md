# IM Capabilities — IM 消息能力速查

## 概述

Agent 通过 Feishu (Lark) 即时通讯与用户交互。回复会被 gateway 自动解析为原生飞书消息格式。

---

## 文本

- **限制**：最大 30000 字符/条，超长自动截断
- **格式**：Markdown 渲染
- ⚠️ 建议：长内容分段，避免一条消息过长

---

## 代码块

```
```language
code here
```
```

⚠️ 注意：飞书代码块渲染能力有限。长代码建议用文件附件方式发送。

---

## 图片

```
![alt text](URL)
```

支持：
- 本地文件路径：`![chart](file:///tmp/chart.png)`
- 远程 URL：`![logo](https://example.com/logo.png)`

Gateway 自动处理上传和渲染，无需手动调 upload 工具。

---

## 文件

```
📎 [filename](file:///absolute/local/path)
```

示例：
```
📎 [report.csv](file:///tmp/report.csv)
📎 [分析结果.json](file:///tmp/result.json)
```

Gateway 自动上传并发送为文件消息。

---

## 音频

```
🎙️ [filename](file:///absolute/local/path)
```

示例：
```
🎙️ [播报.mp3](file:///tmp/tts-output.mp3)
```

---

## 表格

标准 Markdown 表格：

```
| ColA | ColB | ColC |
|------|------|------|
| D1   | D2   | D3   |
```

自动渲染为飞书表格组件。

---

## 按钮

```
[BUTTON: Label](action_url)
```

每行一个按钮，多行 = 多个按钮。示例：
```
[BUTTON: 确认部署](https://deploy.example.com/approve)
[BUTTON: 查看日志](file:///tmp/deploy.log)
```

渲染为交互式卡片按钮。

---

## 分隔线

```
---
```

---

## 卡片消息

多 block 内容（文本 + 表格 + 图片 + 按钮）会自动合并为一张富文本卡片消息。

---

## ⚠️ 行为规则

- **不要**手动调用 upload 工具（lark-cli、feishu 等）。Gateway 自动解析 `![image]()` 和 `📎 [file]()` 语法并处理上传。
- 图片和文件路径使用绝对路径。
- 回复被解析为 Markdown → 多个 block（文本、代码、图片、卡片等）→ 每个 block 渲染为原生飞书元素。
