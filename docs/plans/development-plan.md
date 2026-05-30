# IMtoAgent 开发计划

> 基于 v0.3.22 代码审查，2026-05-30 修订

---

## 📋 现状核实

### ✅ 已完成项

| # | 优化项 | 状态 |
|---|--------|------|
| 1 | README 占位符替换 | ✅ 已替换，无 YOUR_USERNAME |
| 2 | postinstall 改进 | ✅ 清洁，分已安装/首次安装两种提示 |
| — | 无命令自动检测 | ✅ 未配置→进 setup，已配置→打印帮助 |
| — | start 阻塞修复 | ✅ execSync shell 后台启动（0.3.6） |
| — | update-system/update-backend | ✅ v0.3.22 已实现 |
| — | 文档站点 | ✅ docsify 已部署（docs/） |

### 🔴 未完成项

| # | 优化项 | 现状 |
|---|--------|------|
| ~~3~~ | ~~setup 向导 7 步太长~~ | ⏸️ 不精简，重点是无 bug |
| ~~4~~ | ~~无快速模式~~ | ⏸️ 非刚需（API Key 必须手动配） |
| 5 | 后端安装错误处理 | ⚠️ 有警告但不阻塞启动
| 9 | `imtoagent doctor` | ✅ 已实现 |
| 6 | 无 uninstall/cleanup | ❌ 无此命令 |
| 7 | 无 autostart enable | ✅ 已实现 (v0.3.24) |
| 8 | 版本升级提示 | ✅ 已实现 (v0.3.24)
| 9 | `imtoagent doctor` | ✅ 已实现 |

### 🆕 新增需求

| # | 需求 | 说明 |
|---|------|------|
| 9 | 自然语言配置管理 | 用户用对话方式添加/修改 Bot、改配置 |
| 10 | Bot 权限与能力边界 | 设计 Bot 的能力范围和限制 |
| 11 | 配置纠错命令 | 类似 OpenClaw gateway config 的自动纠错逻辑 |

---

### ✅ Phase 1：稳定性与基础运维（P0）— 已完成

| # | 任务 | Commit |
|---|------|--------|
| 1.1 | `imtoagent uninstall` | `6ac20b5` |
| 1.2 | Setup 向导修复 | `0220edc` |
| 1.3 | `imtoagent health` | `f003f88` |

#### 1.1 `imtoagent uninstall` ✅

- `--keep-data`（默认）：保留 ~/.imtoagent/
- `--purge`：删除数据 + npm 包
- 自动停止 gateway + 清理 launchd plist
- 二次确认

#### 1.2 Setup 向导修复 ✅

- `promptText` 返回 `null`（替代危险的 `-1 as unknown as string` hack）
- Bot 名/Provider 名输入 sanitize（去除特殊字符）
- 工作目录黑名单（/dev/null、/etc、/System 等）
- 配置写入原子化（tmp + rename），partial failure 回滚

#### 1.3 `imtoagent health` ✅

- 网关进程 / 配置 JSON / 后端 / 端口 / 日志 errors
- 一键诊断报告

### Phase 2：运维自动化（P1）

#### 2.1 `imtoagent autostart enable/disable`

macOS launchd 集成：
- `imtoagent autostart enable` → 生成 `~/Library/LaunchAgents/com.imtoagent.gateway.plist`
- 自动配置 `IMTOAGENT_HOME` 环境变量
- 日志输出到 `~/.imtoagent/logs/launchd.log`
- `imtoagent autostart disable` → 卸载并删除 plist
- `imtoagent autostart status` → 检查是否已加载

#### 2.2 版本检查机制

- `imtoagent start/status` 时后台检查 npm registry（非阻塞）
- 有新版本时提示：`⬆️ New version X.Y.Z available`
- 检查频率：每 24 小时最多一次（缓存到 `~/.imtoagent/.last-version-check`）
- 超时 3s 自动跳过，不阻塞启动（适配中国网络环境）

### Phase 3：自然语言配置管理（P2，核心新功能）

#### 3.1 设计理念

用户通过对话方式管理配置，而非手动编辑 JSON：

```
> 帮我加一个飞书 Bot，App ID 是 cli_xxx，用 Claude 后端
> 把 TelegramBot 的后端改成 OpenCode
> 删掉 WeComBot
> 给 ClaudeBot 换个模型，用 claude-sonnet-4-20250514
> 显示当前所有 Bot 的配置
```

#### 3.2 Bot 权限与能力边界设计

每个 Bot 的能力由配置决定，需要明确的权限模型：

```jsonc
{
  "name": "ClaudeBot",
  "im": "feishu",           // IM 平台类型
  "capabilities": {
    "max_message_length": 150000,     // 消息长度限制
    "allowed_backends": ["claude"],   // 允许的后端（可限制）
    "allowed_models": ["*"],          // 允许的模型（可白名单）
    "file_upload": true,              // 是否允许文件上传
    "code_execution": true,           // 是否允许代码执行
    "network_access": true,           // 是否允许网络访问
    "system_write_paths": [],         // 允许写入的路径白名单
    "max_concurrent_sessions": 10     // 最大并发会话数
  }
}
```

**安全原则：**
- 默认最小权限（新 Bot 默认关闭危险能力）
- 能力降级而非直接报错（如后端不可用时回退到提示用户）
- 敏感操作需要确认（删除 Bot、修改 API Key）
- 操作审计日志（记录谁在什么时候改了什么）

#### 3.3 实现方案

**方案 A：LLM 辅助配置（推荐）**

```
用户自然语言 → LLM 解析意图 → 生成 JSON Patch → 校验 → 应用 → SIGHUP 热重载
```

- 用户消息通过当前已运行的某个 Bot 转发（或专用 admin Bot）
- LLM 解析用户意图，生成对 config.json 的修改
- 校验层：检查语法、权限边界、冲突检测
- 确认后写入 + SIGHUP 触发热重载
- 返回操作结果给用户

**方案 B：规则引擎解析**

```
用户自然语言 → 关键词/正则匹配 → 预定义操作模板 → 应用
```

- 无需 LLM，纯本地规则匹配
- 支持常见操作模式（add/remove/change/list）
- 局限：复杂意图无法理解

**方案 C：CLI 子命令 + 自然语言参数**

```
imtoagent bot add "飞书 Bot 用 Claude"     # 半自然语言
imtoagent bot "把 TelegramBot 改成 OpenCode"  # 纯自然语言
```

**推荐：方案 A**，因为用户已经在用 IM 对话交互，通过 Bot 发消息改配置最自然。

#### 3.4 配置纠错命令

类似 OpenClaw 的 gateway config 逻辑：

```bash
imtoagent doctor
```

自动检测并修复：
- config.json 格式错误（JSON 语法修复）
- 缺失必要字段（补充默认值）
- 路径不存在（创建目录）
- 端口冲突检测（18899 是否被占用）
- API Key 格式明显错误（长度、前缀检查）
- IM 凭据格式验证
- 提供修复建议，确认后自动修复

输出示例：
```
🔍 Checking configuration...

⚠️  [WARN] Bot "TelegramBot" has invalid bot_token format (too short)
   → Expected: 10+ digits:alphanumeric
   → Fix? [y/N]

❌ [ERROR] Proxy port 18899 is in use by another process (PID 12345)
   → Suggestion: Change port or kill conflicting process

✅ [OK] config.json syntax valid
✅ [OK] Data directory exists
✅ [OK] Claude Code backend found (v2025.x.x)
✅ [OK] 4 bots configured

Summary: 1 error, 1 warning
```

### Phase 4：质量保障（P3，持续）

#### 4.1 测试框架
- Bun test 单元测试（backend-check, paths）
- CLI 集成测试
- CI 集成（GitHub Actions）

#### 4.2 日志改进
```bash
imtoagent logs [--follow] [--lines N] [--bot NAME]
```

#### 4.3 配置验证命令
```bash
imtoagent validate
```
- 纯检查，不修复（doctor 才负责修复）
- 可用于 CI/CD 预检

---

## 📊 优先级排序

```
P0（立刻做）: 1.1 uninstall → 1.2 setup 审查修复 → 1.3 health
P1（已完成）: 2.1 autostart → 2.2 版本检查
P2（进行中）: 3.4 doctor ✅ → 3.1 config CRUD ✅ → 3.2 Bot 权限
P2（核心）  : 3.1 自然语言配置管理 + 3.2 Bot 权限（3.4 doctor ✅ 已完成）
P3（持续）  : 4.1 测试 → 4.2 日志 → 4.3 validate
```

## 📦 预期版本节奏

| 版本 | 内容 |
|------|------|
| 0.3.23 | uninstall + setup 审查修复 + health |
| 0.3.24 | autostart + 版本检查 |
| 0.4.0 | 自然语言配置管理 + Bot 权限 + doctor |
| 0.4.1 | 测试框架 + 日志改进 |

## 🎯 核心决策记录

| 决策 | 结论 | 日期 |
|------|------|------|
| setup 向导是否精简 | ❌ 不精简，重点是无 bug | 2026-05-30 |
| 快速模式是否必要 | ❌ 非刚需（API Key 必须手动配） | 2026-05-30 |
| 自然语言配置方案 | ✅ 方案 A：LLM 辅助配置 | 2026-05-30 |
| Bot 权限模型 | ✅ 最小权限默认，能力白名单 | 2026-05-30 |
