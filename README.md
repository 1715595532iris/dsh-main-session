# dsh-main-session

> 给 [DeepSeek Harness](https://github.com/deepseek-ai) Web 界面用的插件：**固定一个长期「主会话」，每次打开/刷新页面自动进入它**，并在进入时按当前时段触发一次真实的模型问候。

中文文档（本文件） | English summary: [English](#english-summary)

---

## 它解决什么问题

DSH Web 默认的会话行为是「哪个会话最后用过就开哪个」，而新建会话、切换工作区、刷新页面都可能把你带到别处。如果你希望**所有日常对话都沉淀在同一个长期会话里**（上下文连续、历史可追溯、打开即续上），这个插件就是干这个的。

顺便的副作用是：既然每次进入都是同一个会话，就可以在「进入」这个时刻做点有温度的事——**让模型按当前时段（清晨/上午/中午/下午/傍晚/晚上/深夜/凌晨）说一句问候**，并从表情包图库里挑一张贴题的配图。

## 功能

| 功能 | 说明 |
|---|---|
| **固定主会话** | 主会话 id 固定为 `session-dsh-main`，首次启动按需创建，之后每次 resume；不重复建、不丢历史 |
| **自动进入** | 在页面 HTML 最前面注入一段**同步内联脚本**，早于前端框架 rehydrate 就把"当前会话"指向主会话 —— 打开即进，**不需要任何点击** |
| **进入时问候** | 页面确认已进入主会话后 beacon 到宿主，宿主触发**一次真实模型回合**生成问候，作为普通 assistant 消息出现在对话里 |
| **贴题配图** | 宿主只读打开表情包图库的 SQLite 索引，按时段情绪打分抽 4 张候选，把「`[表情: 原文]`」附进问候指令；前端按 caption 原文匹配配图，模型抄哪条就出哪张 |
| **没图也能用** | 图库不存在时自动降级为纯文字问候，不报错、不阻塞 |
| **归档自愈** | 启动时把主会话从"已归档"集合里摘掉（见下方踩坑记录），避免"页面无限自动刷新" |

## 兼容性（重要，安装前必读）

| 项目 | 要求 |
|---|---|
| **目标 DSH 版本** | **`0.1.5-rc.1`**（本插件的开发与验证版本） |
| DSH 0.2.x 支持 | ⚠️ **未适配、未测试**。0.2.0 起插件契约有变动（部分服务改名/移除，设置类插件还需要 `schemastery >= 3.18.4`）。直接装在 0.2.0 上可能导致插件一直 `pending` 或触发 `boot: N entry did not activate`。**想跑 0.2.x 请先自行适配** |
| 更早版本 | 未测试（0.1.2 及更早的插件面板机制不同） |
| Node.js | **`>= 22.19` 或 `>= 24`**（依赖内置 `node:sqlite`） |
| 平台 | 跨平台（宿主侧只用 Node 内置模块；路径用 `path.join` 拼装） |
| 运行依赖 | **零 npm 依赖**（只用 `node:fs` / `node:path` / `node:crypto` / `node:sqlite` / `node:os` / `node:url`） |
| 可选依赖 | `dsh-meme` 的 `dafeiyu-001` 表情包图库（**可选**，缺失则纯文字问候） |

## 快速开始

```powershell
# 1) 把本仓库放到任意目录, 例如 D:\plugins\dsh-main-session
# 2) 用官方 CLI 以「本地路径」形式装进 web profile
dsh plugin --profile web add link:<你的插件目录>\dsh-main-session

# 3) 重启 dsh web(bundle 插件不支持热加载)
# 4) 浏览器 F5 刷新 —— 应直接进入主会话
```

安装后主会话状态文件位于 `$DSH_HOME/dsh-main-session.json`（记录会话 id / cwd / agentPreset）。

**卸载**：

```powershell
dsh plugin --profile web remove dsh-main-session
# 需要连状态一起清: 删除 $DSH_HOME/dsh-main-session.json
```

## 工作原理

```
浏览器                          宿主(Node)                         DSH 内核
  │                                │                                  │
  │ ① index.html 注入同步脚本       │                                  │
  │   localStorage['dsh.sessions.current'] = session-dsh-main         │
  │ ───────────────────────────────┼──── 早于前端框架启动, 打开即进 ───→ │
  │                                │                                  │
  │ ② 轮询 GET /dsh-main-session/status.json 直到 ready(agent 已 live) │
  │ ──────────────────────────────→ │                                  │
  │                                │                                  │
  │ ③ POST /dsh-main-session/entered (每页面一次)                     │
  │ ──────────────────────────────→ │                                  │
  │                                │ ④ resume-or-create → followup     │
  │                                │    → whenIdle → flush            │
  │                                │ ────────────────────────────────→ │ 真实模型回合
  │ ⑤ 问候以 assistant 消息出现     │                                  │
  │ ←──────────────────────────────┼──────────────────────────────────│
```

关键设计：

- **注入用 `ctx.webServer.tapIndex`**：分两段——段 A 同步内联（抢在框架启动前 seed 当前会话），段 B 是问候 beacon（轮询就绪状态、每页面只发一次进入通知）。
- **问候触发用真实回合**：宿主走 `resume-or-create → agent.followup(message) → whenIdle → flush`。触发消息的 source 标为 `{kind:'plugin', plugin:'dsh-main-session', form:'notice'}`，前端会把非 user 来源渲染成不显眼的上下文注入标记——**不会假装是你说的话**，你看到的只是那条 assistant 问候。
- **宿主侧服务全部按需弱引用**（`ctx.get()`），服务缺失时功能优雅降级，**不会炸插件树**。
- **本地复刻 `createUserMessage`**：作为独立 bundle 插件，模块解析链上看不到 DSH 安装树里的 `@deepseek-ai/dsh-llm`，因此按该模块的确切语义在本地实现（`{id, role, content, source}` + 深冻结克隆 + `randomUUID`）。

## 配置

在 profile 的 `cordis.patch.yml` 里给插件行加 `config`：

```yaml
- insert:
    - id: dsh-main-session
      name: dsh-main-session
      config:
        greetCooldownMs: 3000   # 两次问候的最小间隔(毫秒), 防多标签/连点重复触发
```

## 调试

| 接口 | 用途 |
|---|---|
| `GET  /dsh-main-session/status.json` | 返回 `{sessionId, ready, cwd}`；`ready=true` 表示 agent 已 live |
| `POST /dsh-main-session/entered` | 手动触发一次问候（走真实模型回合） |
| `POST /dsh-main-session/entered?hour=21` | 模拟指定小时（0–23）的时段，用于预览各时段问候效果 |

手工调用 `/entered` 时若 agent 尚未 live（例如刚重启 web、浏览器还没打开主会话），会返回 `agent-unavailable` —— **这是预期行为**，正常页面流程不会遇到。

## 实现要点 / 踩坑记录

- **主会话绝不能进「归档」集合（实测会导致无限刷屏）**
  DSH 会把 `storages/workspace.json` 里 `global.archivedSessionIds` 中的会话从所有列表隐藏；而 app 启动时若发现"当前会话"指向的会话不在列表里，就会把它清掉、改选一个新的空会话。此时注入的 beacon 发现"当前会话 ≠ 主会话"→ 重新 seed + `location.reload()` → 刷新后计数清零 → **页面永久自动刷新，永远进不去**。
  两道防线：
  1. 宿主启动时 `repairMainSessionArchive()` 在会话列表枚举**之前**把主会话从 `archivedSessionIds` 摘掉（无 BOM 写回）；
  2. beacon 用 `sessionStorage` 记住"本标签页已强制跳转过"，同一标签页只强制一次；若 app 仍把它改走，说明 app 不接受该会话，此时只补 seed、**不再 reload**，页面安静停在 app 选的会话上。
- **`ready` 语义 = agent 已 live**：beacon 等到 `ready` 才发问候请求，因此问候只在主会话确实活着时触发。
- **写 JSON 配置一律无 BOM**：PowerShell 的 `Set-Content -Encoding UTF8` 会写入 BOM，导致 DSH 的 JSON 存储解析崩溃（实测把 `workspace.json` 写坏过一次，web 直接起不来）。改配置请用 `[System.IO.File]::WriteAllText($p, $s, (New-Object System.Text.UTF8Encoding($false)))`。
- **改插件代码后必须重启 dsh web**：base 组合里 HMR 是关闭的，bundle 插件不会热加载。
- **重启脚本别挂在自己的进程树里**：从工具/agent 里 `Start-Process` 拉起的重启脚本是 dsh web 的孙进程，杀掉 web 时会被一起带走；要用 `([wmiclass]'Win32_Process').Create(...)` 创建完全独立的进程。

## 已知边界

- 「固定主会话」= **每次整页刷新都回到主会话**（会覆盖你在页面里手动切到别的会话的状态，但仅发生在刷新/重新打开时）。如果你想要的是"记住最后使用的会话"，本插件不适合。
- 主会话不能在别处被归档/删除；否则 localStorage 指向不存在的会话会被 app 静默清空（beacon 会尽力重 seed + reload）。
- 问候触发是一次**真实模型回合**，每次进入都有 token 成本；`greetCooldownMs` 默认 3 秒只挡毫秒级连发，想更省可以调大。
- 表情包图库是**可选**的：只认 `dsh-meme` 的 `dafeiyu-001` 图库索引（SQLite，表 `memes(path/tag/file_name/caption/keywords)`）。用自己的图库需要按同样表结构准备。

## 目录结构

```text
dsh-main-session/
├── package.json          # DSH bundle 插件元数据
├── cordis.patch.yml      # 挂载声明(insert)
├── LICENSE               # MIT
├── README.md
└── lib/
    └── index.js          # 宿主侧插件本体(webServer 路由 + tapIndex + 回合触发)
```

## 致谢

- 表情包图库来自 [`dsh-meme`](https://github.com/yyh-001/dsh-meme) 的 `dafeiyu-001` 包（本插件只**只读**它的 SQLite 索引）。
- 本项目为个人自用工具开源，路由/接口命名（`/dsh-main-session/*`）与 DSH 内部存储名（`dsh.sessions.current`）**跟随上游实现**，上游变动时需要同步适配。

## License

[MIT](LICENSE)

---

## English summary

**dsh-main-session** is a [DeepSeek Harness](https://github.com/deepseek-ai) Web plugin that pins a single long-lived "main session": every page load/reload lands you back in it automatically, and the host then triggers one real model turn to greet you according to the time of day (optionally attaching a matching sticker from a meme pack).

- **Target DSH version: `0.1.5-rc.1`.** DSH 0.2.x is **not** supported/tested (the plugin contract changed; on 0.2.x it may hang as `pending` or fail with `boot: N entry did not activate`).
- Zero npm dependencies; requires Node `>=22.19` or `>=24` (uses the built-in `node:sqlite`).
- Install: `dsh plugin --profile web add link:<your-checkout-path>\dsh-main-session`, then restart `dsh web` and refresh the browser.
- Debug endpoints: `GET /dsh-main-session/status.json`, `POST /dsh-main-session/entered[?hour=0..23]`.
- The memepack (`dsh-meme` → `dafeiyu-001`) is optional; without it the greeting degrades to text only.
- License: MIT.
