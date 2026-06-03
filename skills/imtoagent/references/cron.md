# Cron — 定时任务管理

## HEARTBEAT.md

定时任务通过 `HEARTBEAT.md` 文件中的 `tasks:` 块定义。

```
路径：~/.openclaw/workspace/HEARTBEAT.md
格式：YAML 列表，每个任务以 `- name:` 开头
```

Gateway 每次心跳同步时会读取此文件并注册任务。

---

## 任务类型

| 类型 | 触发方式 | 关键字段 |
|------|---------|---------|
| `interval` | 周期性间隔 | `interval: <数字><单位>` (s/m/h/d) |
| `once` | 一次性延时提醒 | `at: <ISO时间戳>` 或 `after: <时长>` |
| `scheduled` | 定时触发 | `at: "HH:MM"`，可选 `on: mon-fri` |
| `countdown` | 倒计时 | （待实现） |
| `conditional` | 条件触发 | （待实现） |
| `stopwatch` | 计时器 | （待实现） |

---

## 全部字段

```yaml
- name: <string>         # 唯一名称，英文+连字符，如 disk-check
  type: <type>           # interval | once | scheduled | countdown | conditional | stopwatch
  interval: <duration>   # [interval] 间隔: 30m / 1h / 24h
  at: <datetime|time>    # [once] ISO时间戳；[scheduled] "HH:MM"
  after: <duration>      # [once] 相对延时（与 at 二选一）
  on: <day-range>        # [scheduled] 可选，如 mon-fri / mon,wed,fri
  prompt: "<text>"       # 触发时发送给 Agent 的提示词，⚠️ 必须单行
  max_runs: <int>        # 最大执行次数，once 默认为 1
  deadline: <ISO>        # 截止时间
  disabled: true         # 设为 true 暂停任务
  on_failure: <policy>   # ignore | retry | alert
```

---

## 脚本用法

所有操作通过 `scripts/task.sh` 完成，**不要手动编辑 HEARTBEAT.md**。

```bash
# 列出所有任务
bash scripts/task.sh list [workspace路径]

# 添加任务
bash scripts/task.sh add <name> \
  --type once \
  --at "2026-06-03T18:00:00+08:00" \
  --prompt "提醒用户开会"

# 按间隔
bash scripts/task.sh add <name> \
  --type interval \
  --interval 30m \
  --prompt "检查磁盘使用率"

# 定时
bash scripts/task.sh add <name> \
  --type scheduled \
  --at "09:00" \
  --on mon-fri \
  --prompt "发送今日日程摘要"

# 删除
bash scripts/task.sh remove <name>

# 查看详情
bash scripts/task.sh show <name>

# 暂停/恢复
bash scripts/task.sh disable <name>
bash scripts/task.sh enable <name>
```

### 参数说明

| 参数 | 说明 |
|------|------|
| `--type` | 必须：once / interval / scheduled |
| `--at` | once 时需要 ISO 时间戳；scheduled 时需要 "HH:MM" |
| `--interval` | interval 时需要，格式 `<数字><单位>`：s / m / h / d |
| `--on` | scheduled 可选，星期范围：mon-fri / mon,wed,fri |
| `--prompt` | 必须，触发词，⚠️ 必须是单行 |
| `--on-failure` | 失败策略，默认 ignore |
| `--max-runs` | 最大执行次数 |

---

## 常用模板

### 一次性提醒 (once)

```bash
bash scripts/task.sh add go-out-reminder \
  --type once \
  --at "2026-06-03T18:12:00+08:00" \
  --prompt "提醒用户该出门了"
```

### 周期性报告 (interval)

```bash
bash scripts/task.sh add disk-check \
  --type interval \
  --interval 30m \
  --prompt "检查磁盘使用率，超过80%就告警"
```

### 每天定时 (scheduled)

```bash
bash scripts/task.sh add morning-brief \
  --type scheduled \
  --at "09:00" \
  --on mon-fri \
  --prompt "汇总今天的日程安排和待办事项"
```

---

## ⚠️ 注意事项

1. **prompt 必须单行**，不能有多行文本
2. interval 格式严格：数字+单位，中间不能有空格
3. 同名任务已存在时，先 `remove` 再 `add`
4. 添加成功后，gateway 在下一次心跳同步时自动加载
5. 删除后该任务立即停止触发
6. 修改任务：先 `show` 确认 → `remove` → 重新 `add`
