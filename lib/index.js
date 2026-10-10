// dsh-main-session —— DSH Web 主会话宿主插件
//
// 功能:
//   1) 固定一个长期「主会话」(id 固定为 session-dsh-main, 状态落盘
//      ~/.dsh/dsh-main-session.json)。
//   2) 每次打开/刷新 DSH web 页面: 前端注入脚本把 localStorage
//      'dsh.sessions.current' 预置为主会话 id → app 原生恢复路径自动进入。
//   3) 页面确认进入主会话后 beacon 到宿主 → 宿主按「进入时段」触发一次
//      真实模型回合(大肥鱼生成问候), 以 assistant 消息出现在主会话里。
//
// 宿主侧服务均经 ctx.get() 按需弱引用(与 headless 相同风格), 只在
// 确保已就绪后使用, 缺服务时功能优雅降级, 不炸插件树。

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')

// ---- 大肥鱼表情包图库 ----
// 与 dsh-meme 的 dafeiyu-001 图库对齐(内置包内 memes/dafeiyu-001)。
// 图库索引是 SQLite(index.db), 表 memes(path/tag/file_name/caption/keywords)。
// 前端渲染器会把模型回复里的 [表情: 描述] 按 caption 原文匹配成图,
// 因此宿主只需把"库内真实 caption"附进问候指令, 模型抄原文即必然配图。
const DAFEIYU_DB_CANDIDATES = [
  path.join(DSH_HOME, 'meme-packs', 'dafeiyu-001', 'index.db'),
  path.join(DSH_HOME, 'profiles', 'web', 'node_modules', 'dsh-meme', 'memes', 'dafeiyu-001', 'index.db'),
  path.join(PACKAGE_ROOT, '..', 'dsh-meme', 'memes', 'dafeiyu-001', 'index.db'),
]

// 时段 → 候选细 tag 池 + 语境关键词(打分用, 让抽样更贴题)
const PERIOD_POOLS = {
  清晨: { tags: ['morning', 'daily'], words: ['早', '好', '哈', '睡'] },
  上午: { tags: ['happy', 'morning', 'like'], words: ['开心', '好耶', '比心', '得意', '哈'] },
  中午: { tags: ['daily', 'happy'], words: ['饭', '吃', '干', '香'] },
  下午: { tags: ['happy', 'daily', 'like'], words: ['开心', '好', '比心', '得意'] },
  傍晚: { tags: ['daily', 'happy', 'shy'], words: ['好', '吃', '哈', '开心', '羞'] },
  晚上: { tags: ['shy', 'daily', 'happy', 'sleep'], words: ['羞', '软', '好', '比心', '摸头', '睡', '晚安'] },
  深夜: { tags: ['sleep', 'daily', 'shy'], words: ['睡', '觉', '困', '躺', 'zzz', '抱', '晚安', '夜'] },
  凌晨: { tags: ['sleep', 'daily'], words: ['睡', '觉', '困', '躺', 'zzz', '抱', '晚安', '夜'] },
}

const ME_MOODS = ['happy', 'angry', 'sad', 'shy', 'confused', 'daily', 'sleep', 'like', 'surprised', 'morning', 'work', 'sigh', 'baka', 'cpu', 'see', 'fool', 'meow', 'givemoney', 'color']

/** 只读打开第一个可用的大肥鱼图库 db; 失败返回 null。 */
function openDafeiyuDb() {
  for (const p of DAFEIYU_DB_CANDIDATES) {
    try {
      if (!fs.existsSync(p)) continue
      const db = new DatabaseSync(p, { readOnly: true })
      // 冒烟: 确认表结构
      db.prepare('SELECT COUNT(*) AS n FROM memes').get()
      return { db, file: p }
    } catch (err) { /* try next */ }
  }
  return null
}

/**
 * 按时段情绪从大肥鱼图库抽 n 张候选, 返回 [{tag, caption}]。
 * 打分策略: 候选细 tag 池内优先; caption/keywords 命中语境词再加分;
 * 从高分集合随机抽, 保证贴题又不至于每次同一张。
 * 取不到图库时返回 [] —— 问候仍可纯文字降级。
 */
function sampleMemeCandidates(now, n = 4) {
  const opened = openDafeiyuDb()
  if (!opened) return []
  try {
    const period = periodOfChina(now)
    const poolCfg = PERIOD_POOLS[period] || { tags: ['happy', 'daily'], words: [] }
    const rows = opened.db.prepare(
      "SELECT path, tag, file_name, caption, COALESCE(keywords, '') AS keywords FROM memes"
    ).all()
    const words = poolCfg.words || []
    // 打分: 语境词命中是主信号(2/词), tag 属主池弱加分(1),
    // 情绪正向词半点。轻微随机抖动让同分段之间不总同一张,
    // 但 2+ 分差距足以保证最贴题的那张几乎总是进榜。
    const scored = rows.map((m) => {
      const t = String(m.tag || '').trim().toLowerCase()
      const caption = String(m.caption || m.file_name || '').slice(0, 80)
      const hay = (t + ' ' + caption + ' ' + String(m.keywords || '')).toLowerCase()
      let score = 0
      for (const w of words) {
        if (hay.includes(w)) score += 2
      }
      if (poolCfg.tags.includes(t)) score += 1
      if (/好耶|比心|得意|害羞|可爱|开心|满意|超有信心/.test(caption)) score += 0.5
      return { tag: t, caption, score: score + Math.random() * 0.4 }
    }).filter((m) => m.caption)
    scored.sort((a, b) => b.score - a.score)
    return scored.slice(0, n).map(({ tag, caption }) => ({ tag, caption }))
  } catch (err) {
    return []
  } finally {
    try { opened.db.close() } catch (err) { /* ignore */ }
  }
}

/** 渲染候选行: 每行一条 [表情: 原文], 模型抄哪条前端就配哪张。 */
function renderMemeCandidateLines(cands) {
  const seen = new Set()
  const lines = []
  for (const c of cands) {
    if (!c.caption || seen.has(c.caption)) continue
    seen.add(c.caption)
    lines.push('[表情: ' + c.caption + ']')
  }
  return lines
}

// ---- 本地 createUserMessage 复刻 ----
// 说明: 作为独立 bundle 插件, 模块解析链上不可见 dsh 安装树里的
// @deepseek-ai/dsh-llm (pnpm 只让真正安装的依赖可解析), 因此这里按
// dsh-llm lib/types/message.js 的确切语义本地实现: 消息 = {id, role,
// content, source}, 经 deepFreeze(structuredClone(...)), id 用 randomUUID。
// brandString 是恒等函数(仅编译期类型), 运行时无需区分。
function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const key of Object.keys(value)) deepFreeze(value[key])
  }
  return value
}

function localCreateUserMessage(input) {
  const base = { ...input, role: 'user', id: `msg-${randomUUID()}` }
  const cloned = typeof structuredClone === 'function' ? structuredClone(base) : base
  return deepFreeze(cloned)
}

// ---- 状态文件候选(优先 DSH_HOME) ----
const STATE_FILE_CANDIDATES = [
  path.join(DSH_HOME, 'dsh-main-session.json'),
  path.join(DSH_HOME, 'profiles', 'web', 'dsh-main-session.json'),
]

// 主会话固定 id: 不用随机后缀, 文件丢失也能靠固定名找回语义。
const MAIN_SESSION_ID = 'session-dsh-main'

// 问候冷却: 距上次成功问候不足此毫秒数则跳过(防同一页面/多标签重复触发)。
const GREET_COOLDOWN_MS = 3000

const JSON_HEADERS = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }

// ---------------------------------------------------------------------------
// 状态读写
// ---------------------------------------------------------------------------

function readState() {
  for (const p of STATE_FILE_CANDIDATES) {
    try {
      const parsed = JSON.parse(fs.readFileSync(p, 'utf8'))
      if (parsed && typeof parsed.sessionId === 'string') return { ...parsed, file: p }
    } catch (err) { /* next candidate */ }
  }
  return { sessionId: MAIN_SESSION_ID, cwd: null, file: null, createdAt: null }
}

function writeState(next) {
  const body = JSON.stringify({
    sessionId: next.sessionId,
    cwd: next.cwd || null,
    agentPreset: next.agentPreset || null,
    createdAt: next.createdAt || new Date().toISOString(),
  })
  for (const p of STATE_FILE_CANDIDATES) {
    try {
      fs.writeFileSync(p, body, 'utf8')
      return p
    } catch (err) { /* try next */ }
  }
  return null
}

/** 取主会话应挂靠的工作区目录: 状态里存的 → 已注册的第一个工作区 → 进程 cwd。 */
function resolveMainCwd(ctx, state) {
  if (state.cwd) return state.cwd
  try {
    const workspaceRegistry = ctx.get('workspaceRegistry')
    if (workspaceRegistry && typeof workspaceRegistry.list === 'function') {
      const list = workspaceRegistry.list()
      if (Array.isArray(list)) {
        for (const ws of list) {
          if (ws && typeof ws.path === 'string' && ws.path) return ws.path
        }
      }
    }
  } catch (err) { /* fall through */ }
  return process.cwd()
}

let lastGreetAt = 0 // 进程内冷却

// ---------------------------------------------------------------------------
// 前端注入脚本(tapIndex 进入 index.html)
// ---------------------------------------------------------------------------

// 段 A —— 同步内联 seed: 页面 parse 到即执行, 必然早于 deferred module
// boot, 早于客户端 session-controller 的 rehydrate。把当前会话指到主会话。
function seedScript(sessionId) {
  const safeId = String(sessionId || MAIN_SESSION_ID).replace(/[<>&'"]/g, '')
  return `<script>(function(){try{var K='dsh.sessions.current';var cur=JSON.parse(localStorage.getItem(K)||'null');if(!cur||cur.sessionId!=='${safeId}'){localStorage.setItem(K,JSON.stringify({sessionId:'${safeId}'}));}}catch(e){}})()</script>`
}

// 段 B —— 问候 beacon(独立 IIFE, 幂等守卫):
//   1) 若宿主尚未就绪(主会话刚重启/首建), 轮询 /status 直到 ready;
//   2) 确认当前会话就是主会话后, 每页面只 POST 一次 /entered 触发问候。
//
// 死循环防护(2026-09-10, 实测踩坑):
//   dsh 0.1.5 的 app 会在启动时用「列表校验过的当前会话」覆写
//   localStorage['dsh.sessions.current']。若主会话不在 app 的会话列表里
//   (例如它被归档 / 未出现在本工作区列表 / 格式迁移被拒), app 会改选自己
//   新建的空会话 → 本 beacon 发现"当前会话≠主会话"→ 再 seed + reload →
//   刷新后计数清零 → 永久刷屏, 页面永远进不去。
//   修法: 用 sessionStorage 记住"本标签页已强制跳转过的主会话", 同一个
//   标签页只强制一次; 若一轮之后 app 仍把它改回去, 说明 app 不接受这个
//   会话, 此时只补 seed 不 reload, 让页面安静地留在 app 选中的会话上。
const FORCE_FLAG_KEY = 'dsh-ms-force-target';

function beaconScript() {
  return `<script>(function(){
if(window.__dshMainSessionBeacon)return;window.__dshMainSessionBeacon=true;
try{
  var KEY='dsh.sessions.current';
  var FLAG='${FORCE_FLAG_KEY}';
  var WANT=null;
  function cur(){try{var p=JSON.parse(localStorage.getItem(KEY)||'null');return (p&&p.sessionId)||null}catch(e){return null}}
  function seed(id){try{localStorage.setItem(KEY,JSON.stringify({sessionId:id}))}catch(e){}}
  function forced(){try{return sessionStorage.getItem(FLAG)||null}catch(e){return null}}
  function markForced(id){try{sessionStorage.setItem(FLAG,id)}catch(e){}}
  function tick(){
    try{
      fetch('/dsh-main-session/status.json',{cache:'no-store'}).then(function(r){return r.json()}).then(function(s){
        if(!s||!s.ok)return setTimeout(tick,600);
        WANT=s.sessionId;
        if(s.ready!==true)return setTimeout(tick,600);
        if(cur()!==WANT){
          // app 已经强制跳转过一次却仍被改走 → app 不接受该会话, 不再刷新(只补 seed 一次)
          if(forced()===WANT){seed(WANT);return;}
          markForced(WANT);
          seed(WANT);
          try{location.reload()}catch(e){}
          return;
        }
        if(!sessionStorage.getItem('dsh-ms-greeted')){
          sessionStorage.setItem('dsh-ms-greeted','1');
          try{fetch('/dsh-main-session/entered',{method:'POST',cache:'no-store'})}catch(e){}
        }
      }).catch(function(){setTimeout(tick,600)});
    }catch(e){}
  }
  setTimeout(tick,900);
}catch(e){}
})()</script>`
}

// ---------------------------------------------------------------------------
// 问候回合
// ---------------------------------------------------------------------------

// 按北京时间划分时段
function periodOfChina(now) {
  const h = new Date(now.getTime() + 8 * 3600 * 1000).getUTCHours()
  if (h >= 5 && h < 8) return '清晨'
  if (h >= 8 && h < 11) return '上午'
  if (h >= 11 && h < 13) return '中午'
  if (h >= 13 && h < 17) return '下午'
  if (h >= 17 && h < 19) return '傍晚'
  if (h >= 19 && h < 23) return '晚上'
  if (h >= 23 || h < 1) return '深夜'
  return '凌晨'
}

function greetingInstruction(now, memeLines) {
  const period = periodOfChina(now)
  let memePart = ''
  if (memeLines && memeLines.length > 0) {
    memePart =
      '\n\n(配图要求)输出必须是:一段1~2句的文字问候 + 换行后附一张表情。先写足文字问候,再从下方候选表情包中挑一张与当前语境最搭的,把它的 [表情: ...] 原文整行原样附在问候语之后(直接抄,不要改写描述、不要带网址)。若只发图不发文字不算完成。候选:\n' +
      memeLines.map((l) => '- ' + l).join('\n')
  }
  return `(自动问候请求)现在是${period}。请以「大肥鱼」——主人专属的蓝色小鲸鱼助手——的身份,用一句(偶尔两句)自然的、可爱的中文向主人打招呼。要求:贴合当前时段(${period}),每次措辞尽量不同、随机,不要使用任何工具,不要多余的解释或标点堆砌,必须输出文字问候,称呼主人为「主人」。${memePart}`
}

// 读取最近一条助理消息文本(用于校验问候确已落进会话)
function latestAssistantText(session) {
  try {
    const len = session.seq
    for (let seq = len - 1; seq >= 0; seq--) {
      const ev = session.eventAt(seq)
      if (!ev) continue
      if (ev.type === 'assistant/message') {
        const content = ev.data && ev.data.message && ev.data.message.content
        if (Array.isArray(content)) {
          const text = content.filter((b) => b && b.type === 'text').map((b) => b.text).join('')
          if (text && text.trim()) return text.trim()
        }
      }
    }
  } catch (err) { /* ignore */ }
  return null
}

/**
 * 确保主会话 live: 已 attach → 直接返回; 磁盘已存在 → resume;
 * 否则在默认工作区 create + attach。
 */
async function ensureMainAgent(ctx, state, sessionsFlush) {
  const sessionId = state.sessionId || MAIN_SESSION_ID
  const agents = ctx.get('agents')
  if (!agents) return { ok: false, agent: null, reason: 'no-agents' }

  const existing = agents.get(sessionId)
  if (existing) return { ok: true, agent: existing, reason: 'live' }

  const agentDefaultModel = ctx.get('agentDefaultModel')
  const agentPresets = ctx.get('agentPresets')
  const workspaceRegistry = ctx.get('workspaceRegistry')
  const sessionQuery = ctx.get('sessionQuery')
  const sessionDefaultModel = agentDefaultModel
    ? agentDefaultModel.currentSelection()
    : { provider: 'deepseek-official', model: 'deepseek-v4-flash' }
  const agentOptions = { provider: sessionDefaultModel.provider, model: sessionDefaultModel.model }
  const presetId = state.agentPreset || 'standard'

  const setup = async (agentCtx) => {
    if (agentPresets && typeof agentPresets.mount === 'function') {
      try {
        // 与 dsh-webhook createWebhookSession 相同: resolve preset 并取
        // standing key, 让 preset 的 standing scope(工具/AGENTS.md 记忆)
        // 先组合就绪, 再 mount 到 agent 的 scoped ctx。
        if (typeof agentPresets.resolve === 'function' && typeof agentPresets.standingKeyFor === 'function') {
          const preset = await agentPresets.resolve(presetId)
          if (preset && preset.id) await agentPresets.standingKeyFor(preset.id)
        }
        await agentPresets.mount(agentCtx, presetId)
      } catch (err) { /* preset 缺省可降级 */ }
    }
  }

  let persisted = false
  if (sessionQuery && typeof sessionQuery.observeSession === 'function') {
    try {
      const obs = await sessionQuery.observeSession(sessionId)
      persisted = !!(obs && obs.header)
    } catch (err) { persisted = false }
  }

  if (persisted) {
    const resumed = await agents.resume({ resumeSessionId: sessionId, agentOptions, setup })
    const agent = resumed && resumed.agent ? resumed.agent : resumed
    return { ok: !!agent, agent, reason: persisted ? 'resumed' : 'created' }
  }

  let workspace = null
  if (workspaceRegistry && typeof workspaceRegistry.create === 'function') {
    try {
      workspace = await workspaceRegistry.create(resolveMainCwd(ctx, state))
    } catch (err) { workspace = null }
  }
  const created = await agents.create({
    sessionId,
    agentOptions,
    meta: { cwd: workspace ? workspace.path : resolveMainCwd(ctx, state), agentPreset: presetId },
    setup,
  })
  const agent = created && created.agent ? created.agent : created
  if (workspace && typeof workspace.attachSession === 'function' && agent) {
    try { await workspace.attachSession(sessionId) } catch (err) { /* 可见性尽力而为 */ }
  }
  if (agent && sessionsFlush && typeof sessionsFlush === 'function') {
    try { await sessionsFlush(agent.session) } catch (err) { /* best effort */ }
  }
  return { ok: !!agent, agent, reason: 'created' }
}

/**
 * 在主会话上触发一次真实模型回合。
 * 调用链照 headless(/dsh-headless lib/index.js:126-167) + webhook
 * (/dsh-webhook lib/types/session.js:92-149): resume-or-create → followup →
 * whenIdle → flush。消息 source 用生产者归属的 kind
 * {kind:'plugin:dsh-main-session', form:'notice'} —— 前端 Chat 把非 user
 * source 归为 context(inject 小标), 不会渲染成「用户说的一句话」。
 *
 * ⚠️ DSH 0.2.0(会话格式 v4)起, `kind:'plugin'` 是**被拒收**的退休写法:
 * @deepseek-ai/dsh-session-format-v3-to-v4 的 source() 校验里
 * `value['kind'] === 'plugin'` 直接抛
 * "format v4 message requires a producer-owned source kind"
 * —— 症状是整个问候回合「处理失败」、主会话每开页都留下一次失败轮次。
 * v4 的规范写法见同包 producerKind(): 非保留名单的插件 → `plugin:<插件名>`,
 * 同时丢掉 plugin 字段(rewritePluginSource 就是做这个改写的)。
 * 所以这里必须写 'plugin:dsh-main-session'。
 */
async function runGreeting(ctx, state, cooldownMs, hourOverride) {
  const sessionId = state.sessionId || MAIN_SESSION_ID

  // 目标时刻: hourOverride 仅演示/测试用——构造本地当天该小时的时刻
  // (分/秒沿用当前), 否则用真实 now。periodOfChina 按它判定时段。
  const realNow = new Date()
  const target = (typeof hourOverride === 'number' && isFinite(hourOverride) && hourOverride >= 0 && hourOverride <= 23)
    ? new Date(realNow.getFullYear(), realNow.getMonth(), realNow.getDate(), Math.floor(hourOverride), realNow.getMinutes(), realNow.getSeconds(), realNow.getMilliseconds())
    : realNow
  const isTest = target !== realNow

  const nowMs = Date.now()
  if (nowMs - lastGreetAt < cooldownMs && !isTest) return { greeted: false, reason: 'cooldown' }
  lastGreetAt = nowMs

  const loader = ctx.get('loader')
  if (loader) { try { await loader.await() } catch (err) { /* settle best effort */ } }

  const agents = ctx.get('agents')
  const sessions = ctx.get('sessions')
  if (!agents) return { greeted: false, reason: 'service-unavailable' }

  const flush = sessions && typeof sessions.flush === 'function'
    ? (session) => sessions.flush(session)
    : null

  let result
  try {
    result = await ensureMainAgent(ctx, state, flush)
  } catch (err) {
    return { greeted: false, reason: 'agent-unavailable', error: String((err && err.message) || err).slice(0, 200) }
  }
  const agent = result.agent
  if (!result.ok || !agent) return { greeted: false, reason: result.reason || 'no-agent' }

  try {
    await agent.whenIdle()
    const candidates = sampleMemeCandidates(target, 4)
    const memeLines = renderMemeCandidateLines(candidates)
    const message = localCreateUserMessage({
      content: [{ type: 'text', text: greetingInstruction(target, memeLines) }],
      // source.summary 必须是字符串: 会话格式迁移(v0→v1)会校验
      // agent/inbox/spliced 里插入消息的 source.summary, 缺失会让整个会话
      // 文件被判为非法而无法 resume(实测踩过: 主会话因此彻底加载不了)。
      // 官方 webhook 范例同样带 form + summary。
      //
      // ⚠️ kind 必须是「生产者归属」的: v4 拒收 {kind:'plugin', plugin:…}
      // (见文件头说明), 规范形式是 'plugin:<插件名>'。
      source: {
        kind: 'plugin:dsh-main-session',
        form: 'notice',
        summary: '自动问候(主会话)',
      },
    })
    agent.followup(message)
    await agent.whenIdle()
    if (flush) { try { await flush(agent.session) } catch (err) { /* best effort */ } }
    const text = latestAssistantText(agent.session)
    const usedMeme = memeLines.length > 0
      ? memeLines.find((l) => text && text.includes(l))
      : null
    return {
      greeted: true,
      period: periodOfChina(target),
      ...(isTest ? { testHour: hourOverride } : {}),
      text: text || '',
      memeCandidates: memeLines.length,
      memeUsed: usedMeme || '',
    }
  } catch (err) {
    return { greeted: false, reason: 'turn-failed', error: String((err && err.message) || err).slice(0, 200) }
  }
}

// ---------------------------------------------------------------------------
// 插件本体
// ---------------------------------------------------------------------------

const name = 'dsh-main-session'
const inject = ['webServer']

/**
 * 自愈: 主会话绝不能停留在「归档」集合里。
 *
 * dsh 的 workspace 注册表把归档会话从所有列表里隐藏(app 的
 * `dsh.sessions.current` 会被清掉/改写), 而本插件又要求页面固定进入主会话
 * —— 两者相撞就出现「无限自动刷新」(2026-09-10 实测踩坑)。
 * 这里在启动时同步把主会话从 `storages/workspace.json` 的
 * archivedSessionIds 里摘掉(无 BOM 写回), 必须在会话列表枚举之前完成,
 * 否则 app 首帧仍然看不到主会话。
 *
 * @returns {{status:'ok'|'noop'|'error', file?:string, before?:string[], message?:string}}
 */
function repairMainSessionArchive(sessionId) {
  const file = path.join(DSH_HOME, 'storages', 'workspace.json')
  try {
    if (!fs.existsSync(file)) return { status: 'noop', message: 'workspace.json not found' }
    const doc = JSON.parse(fs.readFileSync(file, 'utf8'))
    const list = doc && doc.global && Array.isArray(doc.global.archivedSessionIds)
      ? doc.global.archivedSessionIds
      : null
    if (!list || !list.includes(sessionId)) return { status: 'noop', file }
    const before = list.slice()
    doc.global.archivedSessionIds = list.filter((id) => id !== sessionId)
    fs.writeFileSync(file, JSON.stringify(doc, null, 2), 'utf8') // 无 BOM
    return { status: 'ok', file, before }
  } catch (err) {
    return { status: 'error', file, message: String((err && err.message) || err).slice(0, 200) }
  }
}

function apply(ctx, config) {
  const disposers = []
  const cfg = config || {}
  const cooldownMs = typeof cfg.greetCooldownMs === 'number' ? cfg.greetCooldownMs : GREET_COOLDOWN_MS

  // 状态先落盘(幂等), 便于 tapIndex 同步读取。
  const state = readState()
  if (!state.createdAt) writeState({ ...state, createdAt: new Date().toISOString() })

  // 自愈: 启动即把主会话从归档集合里摘出来(必须在会话列表枚举之前,
  // 否则 app 首帧仍看不到主会话)。
  try {
    const repaired = repairMainSessionArchive(state.sessionId || MAIN_SESSION_ID)
    if (repaired.status === 'ok') {
      const msg = `[dsh-main-session] repaired archive set: main session "${state.sessionId || MAIN_SESSION_ID}" was archived; now ${JSON.stringify(repaired.before)} -> unarchived`
      if (ctx.logger && typeof ctx.logger.warn === 'function') ctx.logger.warn(msg)
      else console.warn(msg)
    } else if (repaired.status === 'error') {
      const msg = `[dsh-main-session] archive repair failed: ${repaired.message}`
      if (ctx.logger && typeof ctx.logger.warn === 'function') ctx.logger.warn(msg)
      else console.warn(msg)
    }
  } catch (err) { /* 自愈失败不影响插件树 */ }

  // ---- 状态路由: 供前端 seed/beacon 判断主会话是否可用 ----
  disposers.push(ctx.webServer.register({
    kind: 'exact',
    path: '/dsh-main-session/status.json',
    handler: (req, res) => {
      try {
        const st = readState()
        const agents = ctx.get('agents')
        const ready = !!(agents && agents.get(st.sessionId))
        res.writeHead(200, JSON_HEADERS)
        res.end(JSON.stringify({ ok: true, sessionId: st.sessionId, ready, cwd: st.cwd || null }))
      } catch (err) {
        res.writeHead(200, JSON_HEADERS)
        res.end(JSON.stringify({ ok: false, error: String((err && err.message) || err).slice(0, 160) }))
      }
    },
  }))

  // ---- 问候触发路由: 页面 beacon → 真实模型回合 ----
  disposers.push(ctx.webServer.register({
    kind: 'exact',
    path: '/dsh-main-session/entered',
    handler: async (req, res) => {
      try {
        // 支持 ?hour=0..23 测试参数: 模拟该小时的问候(不影响真实自动问候)
        let hourOverride = undefined
        try {
          const u = new URL(req.url, 'http://localhost')
          const h = u.searchParams.get('hour')
          if (h !== null && h !== '') {
            const n = Number(h)
            if (isFinite(n)) hourOverride = n
          }
        } catch (err) { /* ignore */ }
        const st = readState()
        const outcome = await runGreeting(ctx, st, cooldownMs, hourOverride)
        res.writeHead(200, JSON_HEADERS)
        res.end(JSON.stringify({ ok: outcome.greeted, ...outcome }))
      } catch (err) {
        res.writeHead(200, JSON_HEADERS)
        res.end(JSON.stringify({ ok: false, error: String((err && err.message) || err).slice(0, 200) }))
      }
    },
  }))

  // ---- index.html 注入: 同步 seed + 问候 beacon ----
  disposers.push(ctx.webServer.tapIndex((html) => {
    const st = readState()
    const sessionId = st.sessionId || MAIN_SESSION_ID
    let out = html
    if (out.indexOf('dsh.sessions.current') === -1) {
      const headTag = seedScript(sessionId)
      if (out.indexOf('</head>') !== -1) out = out.replace('</head>', headTag + '</head>')
      else out = headTag + out
    }
    if (out.indexOf('dsh-main-session/status.json') === -1) {
      const bodyTag = beaconScript()
      if (out.indexOf('</body>') !== -1) out = out.replace('</body>', bodyTag + '</body>')
      else out = out + bodyTag
    }
    return out
  }))

  // 首次安装/启动: 后台尽快 ensure 主会话(不阻塞 webServer)
  ;(async () => {
    try {
      const loader = ctx.get('loader')
      if (loader) { try { await loader.await() } catch (err) { /* best effort */ } }
      const st = readState()
      const sessions = ctx.get('sessions')
      const flush = sessions && typeof sessions.flush === 'function'
        ? (session) => sessions.flush(session)
        : null
      await ensureMainAgent(ctx, st, flush)
      // ensure 后补写状态(cwd/agentPreset 可能已被 create 决定)
      writeState(readState())
    } catch (err) {
      const msg = String((err && err.message) || err)
      if (ctx.logger && typeof ctx.logger.warn === 'function') ctx.logger.warn('[dsh-main-session] ensure failed: ' + msg)
      else console.warn('[dsh-main-session] ensure failed: ' + msg)
    }
  })()

  ctx.effect(() => () => {
    for (const d of disposers) {
      try { d() } catch (err) { /* ignore */ }
    }
  })
}

export { name, inject, apply }
