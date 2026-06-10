# Tool Registration Fix — 构造函数异步竞态

## 问题

### 现状

`heartbeat-scheduler.ts` 构造函数中：

```typescript
// Phase 4: 自动发现并注册工具（唯一工具注册入口）
this.autoRegisterTools();

// 显式注入所有已发现工具到当前 session
this.toolRegistry.injectNeeded(this.toolRegistry.list());
```

`autoRegisterTools()` 内部调用 `discoverTools()` 返回 Promise，但 **constructor 里没有 await**，紧接着 `injectNeeded(list())` 执行时 registry 还是空的，注入 0 个工具。

### 时序

```
constructor 执行：
  1. autoRegisterTools()        → 发起 discoverTools 异步请求，不等待
  2. injectNeeded(list())       → registry 为空，注入 0 个工具
  3. new GoalEngine(...)         → GoalEngine 创建，工具列表为空
  4. 构造函数返回

几毫秒后（异步完成）：
  discoverTools resolve          → 工具注册到 registry
  但没有人再调用 injectNeeded    → 工具永远不会注入到 AgentLoop
```

### 影响

- 内置工具（`modules/tools/`）注册成功但**未注入**
- 用户工具（`~/.imtoagent/tools/`）同理
- Agent 在正常聊天和 Goal 执行中都看不到这些工具

### 开发环境额外问题

开发环境 `tool-discovery.ts` 第 51 行引用了不存在的 `importWithModuleRootFallback()`，生产环境是 `import(\`file://${entryPath}\`)`。这是未完成的改动，会导致编译/运行失败。

## 改动方案

### 核心思路

Constructor 不能直接 async，改为 **static factory pattern**：`static async create()` 内部 new 实例 → await 工具发现 → 注入 → 初始化 GoalEngine → 返回。

### 文件清单

| 文件 | 改动 |
|------|------|
| `modules/core/heartbeat-scheduler.ts` | constructor → private, 新增 `static async create()`, 拆分 `_initGoalEngine()` |
| `modules/core/tool-discovery.ts` | revert `importWithModuleRootFallback` 回 `import(\`file://\`)` |
| `index.ts` | `new HeartbeatScheduler()` → `await HeartbeatScheduler.create()` |

## 详细改动

### 1. `modules/core/heartbeat-scheduler.ts`

#### 1.1 Constructor 改为 private

```typescript
private constructor(
  config: HeartbeatSchedulerConfig,
  runtime: AgentRuntime,
  adapter: AgentAdapter,
  sessionManager: SessionManager,
) {
  // 保留所有同步初始化逻辑：
  // - this.config, this.runtime, this.adapter, this.sessionManager
  // - this.agentLoop, this.taskPoller
  // - this.goalStore, this.toolRegistry, this.goalManager, this.taskManager
  // 删除：autoRegisterTools() 及之后的 GoalEngine 构造
}
```

#### 1.2 新增 static async create()

```typescript
static async create(
  config: HeartbeatSchedulerConfig,
  runtime: AgentRuntime,
  adapter: AgentAdapter,
  sessionManager: SessionManager,
): Promise<HeartbeatScheduler> {
  const scheduler = new HeartbeatScheduler(config, runtime, adapter, sessionManager);

  // 等待工具发现完成
  await scheduler.autoRegisterTools();

  // 注入所有已发现工具
  scheduler.toolRegistry.injectNeeded(scheduler.toolRegistry.list());

  // 初始化 Goal Engine（工具就绪后）
  scheduler._initGoalEngine();

  return scheduler;
}
```

#### 1.3 拆分 GoalEngine 构造到独立方法

```typescript
private _initGoalEngine(): void {
  this.goalEngine = new GoalEngine(this.goalStore, {
    executeAgent: async (prompt, options) => {
      return this.executeGoalAgent(prompt, options);
    },
    sendIM: async (chatId, text) => {
      await this.config.sendMessage(chatId, text);
    },
    resolveChatId: () => this._resolver.getLastActiveChatId(),
    workspaceDir: this.config.defaultCwd,
    timeoutMs: this.config.defaults?.timeout
      ? this.parseTimeout(this.config.defaults.timeout)
      : 60_000,
    toolRegistry: this.toolRegistry,
  });
}
```

#### 1.4 autoRegisterTools 改为 async

```typescript
private async autoRegisterTools(): Promise<void> {
  const dataDir = path.join(os.homedir(), '.imtoagent');
  const userToolsDir = path.join(dataDir, 'tools');
  const builtInToolsDir = path.join(__dirname, '..', 'tools');

  const context: ToolLoadContext = {
    deps: {
      taskManager: this.taskManager,
      goalManager: this.goalManager,
      goalStore: this.goalStore,
      resolveChatId: () => this._resolver.getLastActiveChatId(),
    },
  };

  const discovered = await discoverTools([builtInToolsDir, userToolsDir], context);
  for (const tool of discovered) {
    this.toolRegistry.register(tool.definition);
    console.log(
      `[ToolDiscovery] Registered: ${tool.name} (${tool.sourceType}) ` +
      `[${tool.sourceFile.replace(dataDir, '~/.imtoagent')}]`,
    );
  }
  console.log(`[ToolDiscovery] Total discovered: ${discovered.length}`);
}
```

### 2. `modules/core/tool-discovery.ts`

Revert 开发环境独有的改动：

```diff
-        const mod = await importWithModuleRootFallback(entryPath, dir);
-        if (!mod) continue;
+        const mod = await import(`file://${entryPath}`);
```

与生产环境保持一致。

### 3. `index.ts`

找到创建 HeartbeatScheduler 的位置（约第 830 行）：

```diff
-    this.heartbeatScheduler = new HeartbeatScheduler(
+    this.heartbeatScheduler = await HeartbeatScheduler.create(
       {
         botName: this.name,
         // ... 参数不变
       },
       this.runtime,
       this.adapter,
       this.sessionManager,
     );
```

确认 `initHeartbeat()` 或所在函数已标记 `async`（内部有 `await this.reply` 等调用，应该已经是 async）。

## 验证

1. **编译检查**：`npx tsc --noEmit` 或项目构建命令
2. **启动日志**：确认 `[ToolDiscovery] Total discovered: N`（N > 0）
3. **工具可用性**：正常聊天 + Goal 执行中工具列表包含预期工具
4. **同步验证**：开发目录和生产环境 `modules/` 下文件 md5 一致

## 风险与回退

- 改动集中在构造函数拆分，不改变任何工具定义或发现逻辑
- 如果 `create()` 中某个 await 失败，会 throw 到调用方（`index.ts`），Bot 启动会报错退出，不会静默失败
- 回退： revert 三个文件的改动即可

## 后续（本 PR 之外）

- 外部工具（`~/.imtoagent/tools/`）的 TypeScript import 路径问题：用户写工具时如果 `import type { ToolDefinition }`，路径从 `~/.imtoagent/tools/` 计算会找不到。解决方式是用户不写 import 直接 export，或提供 `@imtoagent/types` 声明包。暂不处理。
