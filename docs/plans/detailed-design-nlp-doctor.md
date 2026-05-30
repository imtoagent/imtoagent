# 详细设计：自然语言配置 + Bot 权限 + Doctor

> 2026-05-30 修订 v2

---

## 一、自然语言配置管理

### 1.1 用户场景

用户通过 IM 对话直接管理网关配置，无需 SSH 到服务器改 JSON：

```
用户: 帮我加一个飞书 Bot，名字叫客服Bot，用 OpenCode 后端
系统: 好的，我需要飞书的 App ID 和 App Secret。
      你可以直接发给我，格式如：cli_a6exxxxx 和 对应的 secret

用户: cli_a6eXXXXXXXXXX, secret 是 ABCDEF123456
系统: ✅ Bot "客服Bot" 已添加，正在热重载...
      重载完成，客服Bot 已上线。
```

其他场景：
```
用户: 把 TelegramBot 的后端从 OpenCode 改成 Codex
系统: 已将 TelegramBot 的后端改为 codex ✅

用户: 删掉 WeComBot
系统: 确认要删除 Bot "WeComBot" 吗？回复"确认"删除。

用户: 显示当前所有 Bot
系统: 当前 4 个 Bot：
      🟢 ClaudeBot (feishu + claude)
      🟢 CodexBot (feishu + codex)
      🟢 OpenCodeBot (feishu + opencode)
      🟢 TelegramBot (telegram + opencode)

用户: 给 ClaudeBot 换个模型
系统: 当前使用: claude-opus-4-20250514
      你想换到哪个？

用户: config.json 有问题吗
系统: 检查完毕，发现 1 个问题：
      ⚠️ Bot "TestBot" 的 app_secret 为空
      要我帮你修复吗？
```

### 1.2 触发方式

**规则匹配识别管理意图**（无需 LLM，零性能影响）：

```typescript
const adminPatterns = [
  /^(添加|增加|新建|create|add)\s*(bot|机器人)?/i,
  /^(删除|移除|删|delete|remove)\s*(bot|机器人)?/i,
  /^(修改|改|换|update|change|switch)\s*(bot|后端|backend|模型|model)/i,
  /^(显示|查看|list|show|status)/i,
  /^(配置|设置|config|setup)/i,
  /^(诊断|doctor|health|检查)/i,
];
```

匹配到 → 走管理流程；没匹配 → 正常 Agent 对话。

### 1.3 流程

```
消息 → 规则匹配检测意图 → 权限校验
  → LLM 解析意图生成 JSON Patch
  → 缺字段追问收集
  → 确认 → 原子写入 → SIGHUP 热重载 → 反馈
```

### 1.4 LLM Prompt

```
你是一个配置管理助手。用户会用自然语言描述对 IMtoAgent 网关配置的修改。

当前配置：
${JSON.stringify(currentConfig, null, 2)}

可用操作：add_bot / remove_bot / update_bot / show_status

返回 JSON 格式的操作指令：
{"action": "add_bot", "bot_name": "xxx", "im": "feishu", "backend": "opencode"}

如果信息不足，标出缺失字段：
{"action": "add_bot", "missing_fields": ["appId", "appSecret"]}
```

### 1.5 多轮对话收集

LLM 返回 missing_fields → 逐个追问收集 → 收集完毕进入确认 → 执行。

状态存内存 Map，5 分钟超时自动失效。

### 1.6 操作审计日志

```jsonc
// ~/.imtoagent/logs/audit.jsonl
{"ts":"2026-05-30T10:30:00Z","action":"add_bot","bot":"客服Bot","by":"ou_7c29b49...","result":"success"}
{"ts":"2026-05-30T10:35:00Z","action":"update_bot","bot":"TelegramBot","by":"ou_7c29b49...","result":"success","diff":{"backend":{"from":"opencode","to":"codex"}}}
```

---

## 二、Bot 权限模型（简化版）

### 2.1 规则

| 类型 | 权限 |
|------|------|
| **首个 Bot** | 全部权限（包含管理配置） |
| **后续 Bot** | 完整对话能力，但**不能修改配置** |

就这么简单，不需要路径白名单、速率限制、并发控制等复杂维度。

### 2.2 配置结构

```typescript
interface BotConfig {
  name: string;
  im: string;
  backend: string;
  appId?: string;
  appSecret?: string;
  botToken?: string;
  // ... 其他配置字段

  /**
   * 是否为管理 Bot（首个 Bot 自动设为 true）
   * true  = 可以通过自然语言命令修改网关配置
   * false = 只能对话，不能改配置
   */
  isAdmin?: boolean;
}
```

### 2.3 权限判断逻辑

```typescript
// AgentRuntime.handleMessage() 入口
async function handleMessage(bot: BotConfig, message: string, senderId: string) {
  
  // 1. 先判断是否为管理意图
  if (isAdminIntent(message)) {
    if (!bot.isAdmin) {
      return "❌ 此 Bot 不能修改配置。请通过管理员 Bot 操作。";
    }
    return handleAdminCommand(bot, message, senderId);
  }
  
  // 2. 正常对话流程
  return await agent.sendMessage(bot, message);
}
```

### 2.4 首个 Bot 的识别

```typescript
// setup 向导或自然语言添加 Bot 时：
const config = loadConfig();
const isFirstBot = (config.bots || []).length === 0;

const newBot = {
  name: '...',
  im: '...',
  backend: '...',
  isAdmin: isFirstBot  // 首个 = true，后续 = false
};
```

### 2.5 权限变更

如果用户想让某个后续 Bot 也获得管理权限，只能通过已有的管理 Bot 来操作：

```
用户(通过AdminBot): 让 TelegramBot 也能管理配置
系统: 已将 TelegramBot 设为管理 Bot ✅
```

这本质上也是一个配置修改操作，需要管理权限才能执行。

---

## 三、imtoagent doctor — 配置纠错

### 3.1 定位

日常运维时跑一下，自动检测配置健康度。启动失败时跑一下，直接定位问题。

### 3.2 检测项

| 检测项 | 严重级别 | 检测方法 |
|--------|----------|----------|
| config.json 语法 | ERROR | JSON.parse() |
| 缺少必要字段 | ERROR | bots 数组存在且非空，每个 bot 有 name/im/backend |
| API Key 格式明显错误 | WARNING | 检查前缀/长度（claude sk-ant-、openai sk-、飞书 cli_） |
| 后端安装状态 | WARNING | checkBackend() |
| 端口 18899 冲突 | ERROR | net 模块检测 |
| 数据目录权限 | ERROR | 检查 ~/.imtoagent/ 可读写 |
| Bot 名称重复 | WARNING | 检查 name 唯一性 |

### 3.3 交互示例

```bash
$ imtoagent doctor

🔍 IMtoAgent Configuration Doctor

  [1/7] Checking config.json syntax...
  ✅ OK — Valid JSON

  [2/7] Checking required fields...
  ⚠️  WARNING — Bot "TestBot" is missing "appSecret"
      → This Bot will fail to start.
      Fix? [y/N]

  [3/7] Checking backend installations...
  ✅ OK — claude: installed
  ✅ OK — codex: installed

  [4/7] Checking port 18899...
  ❌ ERROR — Port 18899 is in use by PID 12345
      → Another instance may be running.
      Fix? (kill process) [y/N]

  [5/7] Checking data directory...
  ✅ OK — ~/.imtoagent/ exists and is writable

  [6/7] Checking for duplicate bot names...
  ✅ OK — No duplicates

  [7/7] Checking API key formats...
  ⚠️  WARNING — Provider "openai" key looks suspicious
      → Starts with "sk-test-" (commonly a placeholder)

  Summary: 1 error, 2 warnings
  Auto-fixed: 0 issue(s)
```

### 3.4 实现骨架

```typescript
// modules/doctor/index.ts

interface DoctorCheck {
  name: string;
  severity: 'error' | 'warning';
  run(): Promise<{ ok: boolean; message: string; fixable?: boolean; fix?: () => Promise<any> }>;
}

const checks: DoctorCheck[] = [
  // config 语法
  {
    name: 'Config JSON syntax',
    severity: 'error',
    async run() {
      try {
        JSON.parse(fs.readFileSync(configPath, 'utf-8'));
        return { ok: true, message: 'Valid JSON' };
      } catch (e: any) {
        return { ok: false, message: `Syntax error: ${e.message}`, fixable: false };
      }
    }
  },
  // 端口冲突
  {
    name: 'Port 18899',
    severity: 'error',
    async run() {
      return new Promise((resolve) => {
        const server = net.createServer();
        server.once('error', (err: any) => {
          if (err.code === 'EADDRINUSE') {
            resolve({ ok: false, message: 'Port in use', fixable: true });
          } else {
            resolve({ ok: true, message: 'Port available' });
          }
        });
        server.once('listening', () => { server.close(); resolve({ ok: true, message: 'Port available' }); });
        server.listen(18899, '127.0.0.1');
      });
    }
  },
  // ... 其他检测项
];

export async function runDoctor(): Promise<void> {
  let errors = 0, warnings = 0, fixed = 0;
  for (const check of checks) {
    const result = await check.run();
    if (result.ok) {
      console.log(`  ✅ ${check.name}`);
    } else {
      const prefix = check.severity === 'error' ? '❌' : '⚠️ ';
      console.log(`  ${prefix} ${check.name}: ${result.message}`);
      if (check.severity === 'error') errors++;
      else warnings++;
      if (result.fixable && result.fix) {
        // 询问用户是否修复
      }
    }
  }
  console.log(`\n  Summary: ${errors} error(s), ${warnings} warning(s)`);
}
```

---

## 四、与 setup/doctor 的分工

| | setup | doctor | 自然语言配置 |
|---|---|---|---|
| **时机** | 初次安装 | 日常运维 | 运行时管理 |
| **目标** | 从零生成配置 | 检查配置健康度 | 通过对话修改配置 |
| **交互** | 引导式问答 | 检测 → 报告 → 修复 | 自然语言对话 |
| **频率** | 一次 | 随时 | 随时 |

---

## 五、完整工作流

```
新用户:
  npm install -g imtoagent
  imtoagent setup        ← 首个 Bot 自动获得管理权限
  imtoagent doctor       ← 验证配置没问题
  imtoagent start

老用户日常:
  imtoagent doctor       ← 健康检查
  imtoagent status       ← 快速状态

运行时管理（通过 IM 发消息给管理 Bot）:
  "帮我加一个飞书 Bot"    ← 新 Bot 默认无管理权限
  "显示当前所有 Bot"
  "给 ClaudeBot 换模型"
  "删掉 WeComBot"

出问题:
  imtoagent doctor       ← 自动诊断
  imtoagent logs --follow ← 实时日志
```


---

## 五、工作空间模式设计（沙盒 vs 全局）

### 5.1 两种模式

**全局模式（默认，当前行为）：**
- Bot 可以访问任意目录
- 用户通过 `/dir` 随时切换工作目录
- 多个 Bot 可以指向同一路径
- 适合：个人使用、信任的环境

**沙盒模式：**
- Bot 被限制在自己的独立子目录内
- 路径：`~/.imtoagent/workspaces/<bot-id>/`
- 不能访问沙盒外的文件系统
- 多个 Bot 天然隔离，互不干扰
- 适合：多 Bot 场景、生产环境、不信任的内容

### 5.2 配置项

```typescript
interface BotConfig {
  // ... 现有字段

  /**
   * 工作空间模式
   * "global"  — 全局模式，可访问任意路径（默认）
   * "sandbox" — 沙盒模式，限制在 ~/.imtoagent/workspaces/<bot-id>/
   */
  workspaceMode?: 'global' | 'sandbox';

  /**
   * 沙盒根目录（可选，默认 ~/.imtoagent/workspaces）
   * 仅 workspaceMode = "sandbox" 时生效
   */
  sandboxRoot?: string;
}
```

### 5.3 setup 向导中的选择

在现有流程中增加一步（放在 Agent 后端选择之后、工作目录设置之前）：

```
📌 Step X: Workspace Mode

Choose how this Bot accesses files:

  1. 🌐 Global mode (default)
     Bot can access any directory on the system.
     You can switch directories with /dir during conversation.
     Multiple Bots can share the same directory.

  2. 🔒 Sandbox mode
     Bot is restricted to its own isolated directory.
     Path: ~/.imtoagent/workspaces/<bot-id>/
     Other Bots cannot access this directory.

Selection: [1/2] 

→ 选择 1: 接着询问 Working directory（现有逻辑）
→ 选择 2: 自动生成沙盒目录，跳过 Working directory 询问
```

### 5.4 执行层限制

```typescript
// index.ts — 传递给 Adapter 前检查
async function handleMessage(input) {
  let workingDir = session.cwd || this.defaultCwd;
  
  if (this.workspaceMode === 'sandbox') {
    const sandboxPath = path.join(this.sandboxRoot || getDefaultSandboxRoot(), this.id);
    // 强制限制在沙盒内
    workingDir = sandboxPath;
    // 确保沙盒目录存在
    fs.mkdirSync(workingDir, { recursive: true });
    // 忽略用户 /dir 命令，始终用沙盒路径
  }
  
  return await this.adapter.handleMessage({
    ...input,
    workingDir,
  });
}
```

### 5.5 /dir 命令的行为差异

```
全局模式:
  /dir /Users/keyi/projects/myapp  → ✅ 切换到指定目录
  /dir /etc                        → ✅ 可以切（但 Agent 自身权限限制）

沙盒模式:
  /dir /Users/keyi/projects/myapp  → ❌ 不允许访问沙盒外的目录
  /dir ./subdir                    → ✅ 允许沙盒内的相对路径
  /dir                             → 显示当前沙盒路径
```

### 5.6 自然语言配置时的处理

```
用户: 帮我加一个飞书 Bot
系统: 选择工作空间模式：
      1. 全局模式 — 可访问任意目录
      2. 沙盒模式 — 限制在独立目录
      
用户: 2
系统: 已选择沙盒模式，沙盒路径：~/.imtoagent/workspaces/xxxxx/
      接下来需要飞书的 App ID 和 App Secret...
```

### 5.7 模式切换

全局 → 沙盒：安全，只是限制了访问范围
沙盒 → 全局：开放限制，但沙盒内已生成的文件不受影响

```
用户(通过管理Bot): 把客服Bot改成全局模式
系统: 已将 客服Bot 的工作空间模式改为 global ✅
      现在可以使用 /dir 切换工作目录了。
```

### 5.8 迁移路径

如果已有 Bot 想从全局模式迁移到沙盒模式：

```bash
imtoagent sandbox init <bot-name>    # 创建沙盒，迁移常用文件
imtoagent sandbox status <bot-name>  # 查看沙盒状态
imtoagent sandbox export <bot-name>  # 导出沙盒内容到指定目录
imtoagent sandbox import <bot-name>  # 从指定目录导入到沙盒
```

### 5.9 与权限模型的关系

工作空间模式和 `isAdmin` 是独立的两个维度：

| | isAdmin: true | isAdmin: false |
|---|---|---|
| workspaceMode: global | 能改配置 + 能访问任意目录 | 只能对话 + 能访问任意目录 |
| workspaceMode: sandbox | 能改配置 + 只能访问沙盒 | 只能对话 + 只能访问沙盒 |

管理员 Bot 通常用全局模式（需要灵活操作），对话 Bot 可以用沙盒模式（安全隔离）。

