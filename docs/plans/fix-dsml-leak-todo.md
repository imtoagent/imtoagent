# 修复 DSML XML 标记泄漏到 Codex

## 问题描述

某些模型（如 deepseek）在决定调用工具时，会在 `content` 字段里输出 DSML XML 标记（如 `<｜｜DSML｜｜tool_calls>`）。

当前 `streamResponse` 有过滤逻辑，但 `parseStreamToolCalls`（用于 Phase 3 V2 缓存模式）没有过滤，导致这些标记泄漏给 Codex，最终显示给用户。

## 修复方案

在 `parseStreamToolCalls` 函数中，收集 `assistantText` 时过滤掉 DSML XML 标记。

### 修改文件

`modules/proxy/codex-proxy.ts`

### 修改位置

`parseStreamToolCalls` 函数，约第 661 行：

```javascript
// 当前代码
if (delta.content) {
  result.assistantText += delta.content;
}

// 修改为
if (delta.content) {
  // 过滤 DSML XML 标记，不传给 Codex
  const cleaned = delta.content.replace(/<\|[^|]*\|>/g, '');
  result.assistantText += cleaned;
}
```

### 复用现有过滤逻辑

`streamResponse` 里已有更完善的过滤逻辑（约 833 行），可以提取为公共函数：

```javascript
function stripDSMLXML(text: string): string {
  return text.replace(/<\|[^|]*\|>/g, '');
}
```

然后在两处都调用这个函数。

## 影响范围

- **本地工具**：不受影响，`toolCalls` 从 `delta.tool_calls` 收集
- **远端工具**：不受影响，同样从 `delta.tool_calls` 收集
- **纯文本响应**：会过滤掉 DSML XML 标记，返回干净内容

## 测试计划

1. **纯本地工具调用**：验证不再泄漏 DSML XML 标记
2. **远端工具调用**：验证工具调用正常传递
3. **纯文本响应**：验证正常对话不受影响
4. **混合场景**：验证本地 + 远端工具同时存在时的行为

## TODO

- [ ] 提取 `stripDSMLXML` 公共函数
- [ ] 修改 `parseStreamToolCalls` 使用过滤函数
- [ ] 确认 `streamResponse` 也使用同一个函数
- [ ] 同步到生产目录
- [ ] 重启服务
- [ ] 测试纯本地工具调用
- [ ] 测试远端工具调用
- [ ] 测试纯文本响应

## 优先级

**高** — 直接影响用户体验，用户看到原始工具调用标记。
