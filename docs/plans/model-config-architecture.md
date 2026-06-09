# 模型配置架构：重构方案

> 基于 `imtoagent` 源码审计 + OpenClaw 配置模式参考
> 2026-06-07 V2

---

## 一、背景

从 `/model` 热切换对 Codex 后端不生效的问题切入，走读了模型配置的完整数据流。发现配置系统存在多处冗余和职责不清的问题。本文档分析现状并提出重构方案。

---

## 二、当前架构问题

### 2.1 数据分布图

```
安装阶段
  templates/providers-presets.json    ← 26 个供应商预设（仅 setup 向导使用）
       ↓ 用户选择
启动/运行时
  config.json                         ← 供应商 + 默认模型 + activeModel + codex/opencode 配置
  providers.json                      ← config.json.providers 的冗余副本 + activeModel
  sessions/<name>_config.json         ← Bot 级 activeModel/modelAliases（存错地方）
  bots/<name>.json                    ← 不存在（预期位置）
```

### 2.2 写入链路（/model 切换为例）

```
index.ts cmd('/model')
  ├─ 1. this.activeModel = spec                          ← 内存
  ├─ 2. this._saveBotConfig()                            → sessions/<name>_config.json
  ├─ 3. saveActiveModel(spec)                            → providers.json.activeModel
  ├─ 4. sharedState.activeConfig = cfg                   ← proxy 内存
  ├─ 5a. updateCodexConfig(spec)                         → codex-proxy 内存
  └─ 5b. _syncCodexModelToConfigJson(spec)               → config.json (codex.model + activeModel)
```

**6 步操作，写 3 个文件，5 个字段。**

### 2.3 具体问题

| 问题 | 代码位置 | 严重程度 |
|------|----------|----------|
| providers.json 与 config.json.providers 双源 | anthropic-proxy.ts:119,168 | 中 |
| sessions/ 目录存放 Bot 配置 | config.ts:125,143 | 低 |
| codex.model 与 activeModel 格式重复 | index.ts:463-474, codex-proxy.ts:82 | 中 |
| /model 写入路径过多（6 步 5 字段） | index.ts:523-640 | 中 |

### 2.4 Q3 修正说明

原文档 Q3 提到"还有一套写入 `bots/<name>.json`"——经核实，`index.ts._saveBotConfig()` 写入的路径由 `_botConfigPath()` 决定，实际也是 `sessions/<name>_config.json`。**不存在两套不同存储**，只有 `FileConfigManager` 和 `BotRuntime` 各自读写同一个文件。

---

## 三、OpenClaw 参考

OpenClaw 的配置模式（`~/.openclaw/openclaw.json`）：

```json
{
  "agents.defaults": {
    "model": { "primary": "provider/model-id" },
    "models": { "deepseek/deepseek-v4-pro": {} }
  },
  "models.providers": {
    "deepseek": {
      "baseUrl": "...",
      "apiKey": "...",
      "models": [{ "id": "deepseek-v4-pro", "contextWindow": ... }]
    }
  }
}
```

三层关注点清晰：
1. **providers** — 供应商定义（baseUrl, apiKey, 模型元数据）
2. **model.primary** — 当前选中的模型（运行时选择）
3. **models** — 可用模型列表（轻量占位）

**没有 providers.json，没有 sessions/ 目录存配置，没有 codex.model 冗余。**

---

## 四、重构方案

### 4.1 目标架构

```
config.json（唯一配置文件）
├── providers                          ← 供应商定义（唯一来源）
│   └── deepseek: { baseUrl, apiKey, models[], format }
├── defaultModel                       ← 全局默认（新 Bot 初始值，不被动修改）
├── activeModel                        ← 全局当前模型（/model 切换写入）
├── modelAliases                       ← 角色映射（Claude/OpenCode）
├── modelPresets                       ← 快捷预设（从 Bot 级提到全局）
├── bots[]                             ← Bot 定义列表
│   └── { name, appId, appSecret, backend, cwd, activeModel, modelAliases }
├── codex                              ← 仅 Codex 特有配置
│   ├── reportedModel                  ← Codex CLI 透传的假模型名
│   └── upstream                       ← 上游 API 地址
└── opencode                           ← 仅 OpenCode 特有配置
    └── defaultModel: { providerID, modelID }

templates/providers-presets.json       ← 不变，仅安装向导使用
sessions/                              ← 仅运行时数据（心跳、会话状态等）
```

### 4.2 写入链路（重构后）

```
/model deepseek/deepseek-v4-flash:
  ├─ 1. this.activeModel = spec                          ← 内存
  └─ 2. saveActiveModel(spec)                            → config.json.activeModel（唯一持久化）

proxy/codex 层在需要时实时解析 activeModel:
  └─ activeModel = "deepseek/deepseek-v4-flash"
     → provider = "deepseek"
     → model    = "deepseek-v4-flash"
```

### 4.3 具体改动

#### 改动 1：统一 providers 到 config.json，废弃 providers.json

| 文件 | 改动 |
|------|------|
| `modules/proxy/anthropic-proxy.ts` | `loadProviders()` 改为只读 `config.json.providers` |
| `modules/proxy/anthropic-proxy.ts` | `saveActiveModel()` 改为只写 `config.json.activeModel` |
| `modules/proxy/anthropic-proxy.ts` | 删除 `providers.json` 相关逻辑（CONFIG_PATH, loadFallbackProviders） |
| `modules/core/config.ts` | 删除 `providers.json` 加载逻辑 |

#### 改动 2：统一 Bot 配置到 bots/ 目录

| 文件 | 改动 |
|------|------|
| `modules/core/config.ts` | `_loadBotConfig()` / `_saveBotConfig()` 改为 `bots/<name>.json` |
| 迁移脚本 | `sessions/<name>_config.json` → `bots/<name>.json` |

#### 改动 3：codex-proxy 实时解析 activeModel

| 文件 | 改动 |
|------|------|
| `modules/proxy/codex-proxy.ts` | `getConfig()` 从 `config.json.activeModel` 实时解析 provider/model |
| `modules/proxy/codex-proxy.ts` | 删除 `codex.model` 字段的读取 |
| `index.ts` | 删除 `_syncCodexModelToConfigJson()` 调用 |
| `index.ts` | 删除 `updateCodexConfig()` 调用（改用实时解析） |

#### 改动 4：简化 /model 切换逻辑

| 文件 | 改动 |
|------|------|
| `index.ts` cmd('/model') | 直接切换时：this.activeModel + saveActiveModel + sharedState.activeConfig |
| `index.ts` | Codex backend 不再需要 _syncCodexModelToConfigJson + updateCodexConfig |
| `index.ts` | Claude/OpenCode 角色映射：this.activeModel + saveActiveModel + _saveBotConfig |

---

## 五、保持不变的

| 组件 | 原因 |
|------|------|
| `modelAliases` | Claude/OpenCode 后端需要角色映射，不能删 |
| `modelPresets` | 用户自定义快捷切换，保留 |
| `codex.reportedModel` | Codex CLI 透传假模型名，保留但只放 codex 区块 |
| `opencode` 配置 | OpenCode 特有，保留 |
| `templates/providers-presets.json` | 安装向导模板，不参与运行时 |

---

## 六、风险与迁移

| 风险 | 缓解措施 |
|------|----------|
| 已有 users 手动编辑 providers.json | 首次启动时迁移：若 providers.json 存在，合并到 config.json 后删除 |
| 旧版本 sessions/*.json 残留 | 首次启动时迁移到 bots/*.json，旧文件保留但不再使用 |
| codex.model 字段丢失 | getConfig() 优先读 activeModel，若 codex.model 存在则作为 fallback |

### 迁移逻辑

```typescript
// 首次启动时执行
function migrateConfigs(): void {
  // 1. providers.json → config.json（如果 providers.json 更新）
  // 2. sessions/<name>_config.json → bots/<name>.json
  // 3. 完成后重命名旧文件为 .migrated
}
```

---

## 七、实施顺序

1. 写迁移工具（`modules/utils/config-migration.ts`）
2. 重构 `config.ts`（统一配置读取）
3. 重构 `anthropic-proxy.ts`（统一 providers 来源）
4. 重构 `codex-proxy.ts`（实时解析）
5. 简化 `index.ts` /model 逻辑
6. 测试验证 + 同步生产
