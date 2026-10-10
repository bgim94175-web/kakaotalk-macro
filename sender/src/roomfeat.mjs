// 방 설치형 봇(K bot 계정)의 방별 기능 — 순수 함수만 둔다(docs/ACCOUNTS_V1.md 5.5·5.7·7장).
// 네트워크·DB·타이머를 쓰지 않는다. 시각은 늘 인자로 받는다. botpool.mjs 가 이 함수들의 결과를 실행한다.
// 이 파일은 features.mjs 를 가져오지 않는다(features.mjs 가 이 파일의 profileObserve 를 쓴다).

const SEP = '\u0001'
const MIN = 60 * 1000
const HOUR = 60 * MIN
const DAY = 24 * HOUR

// ── 7.1 방 설정 ────────────────────────────────────────────────────────────
// lib/room-config.js 가 단일 소스다. sender 는 쓸 때 같은 범위로 다시 자른다(틀린 칸은 기본값).
export const MAX_WORDS = 300
export const MAX_WORD_LEN = 30
export const MAX_EXEMPT = 50
const MAX_EXEMPT_NAME = 40
const PREFIXES = ['!', '/', '.', '#']
const USER_ID_RE = /^[1-9][0-9]{0,19}$/

export const DEFAULTS = Object.freeze({
  v: 1,
  cmdPrefix: '!',
  exempt: [],
  visit: { enabled: false },
  churn: { enabled: false, joins: 3, windowMin: 10, action: 'warn', notice: true },
  leaveKick: { enabled: false, notice: false },
  profile: { enabled: false, name: true, photo: true, status: true, lookup: 'staff' },
  promo: { enabled: false, links: true, cards: true, media: false, hide: true, kickAt: 3, resetHours: 24, notice: true },
  cover: { enabled: false, words: [], links: true },
  hide: { command: true },
  guard: { enabled: false, secs: 30, count: 5 },
  games: { enabled: true, word: true, baseball: true, dice: true, rps: true, quiz: true, cooldownSec: 3, dailyLimit: 0 },
})

const B = { t: 'bool' }
const I = (lo, hi) => ({ t: 'int', lo, hi })
const E = (list) => ({ t: 'enum', list })
const SPEC = {
  visit: { enabled: B },
  churn: { enabled: B, joins: I(2, 20), windowMin: I(1, 1440), action: E(['warn', 'kick']), notice: B },
  leaveKick: { enabled: B, notice: B },
  profile: { enabled: B, name: B, photo: B, status: B, lookup: E(['staff', 'all', 'off']) },
  promo: { enabled: B, links: B, cards: B, media: B, hide: B, kickAt: I(0, 10), resetHours: I(1, 720), notice: B },
  cover: { enabled: B, links: B },
  hide: { command: B },
  guard: { enabled: B, secs: I(5, 300), count: I(3, 30) },
  games: { enabled: B, word: B, baseball: B, dice: B, rps: B, quiz: B, cooldownSec: I(1, 60), dailyLimit: I(0, 5000) },
}

function isObj(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}

function toInt(v) {
  if (typeof v === 'number') return Number.isInteger(v) ? v : null
  if (typeof v === 'string' && /^\s*-?\d{1,9}\s*$/.test(v)) return parseInt(v, 10)
  return null
}

function field(spec, v, dflt) {
  if (spec.t === 'bool') return typeof v === 'boolean' ? v : dflt
  if (spec.t === 'enum') return spec.list.includes(v) ? v : dflt
  const n = toInt(v)
  return n !== null && n >= spec.lo && n <= spec.hi ? n : dflt
}

function cleanWord(v) {
  if (typeof v !== 'string' && typeof v !== 'number') return ''
  return String(v).replace(/[\u0000-\u001f\u007f]/g, ' ').trim()
}

// 금지어: 30자 넘는 단어는 버리고, 대소문자 무시 중복 제거, 300개에서 자른다.
function wordsOf(src) {
  const list = Array.isArray(src) ? src : []
  const out = []
  const seen = new Set()
  for (const raw of list) {
    const w = cleanWord(raw)
    if (!w || w.length > MAX_WORD_LEN) continue
    const k = w.toLowerCase()
    if (seen.has(k)) continue
    seen.add(k)
    out.push(w)
    if (out.length >= MAX_WORDS) break
  }
  return out
}

function exemptOf(src) {
  const list = Array.isArray(src) ? src : []
  const out = []
  const seen = new Set()
  for (const it of list) {
    const uid = isObj(it) && (typeof it.user_id === 'string' || typeof it.user_id === 'number') ? String(it.user_id).trim() : ''
    if (!USER_ID_RE.test(uid) || seen.has(uid)) continue
    seen.add(uid)
    out.push({ user_id: uid, name: cleanWord(it.name).slice(0, MAX_EXEMPT_NAME) })
    if (out.length >= MAX_EXEMPT) break
  }
  return out
}

/** room_installs.config → 7.1 의 모든 칸을 채운 설정. 틀린 칸은 기본값, 목록은 상한에서 자른다. */
export function normRoomConfig(cfg) {
  const src = isObj(cfg) ? cfg : {}
  const out = { v: 1 }
  out.cmdPrefix = PREFIXES.includes(src.cmdPrefix) ? src.cmdPrefix : DEFAULTS.cmdPrefix
  out.exempt = exemptOf(src.exempt)
  for (const sec of Object.keys(SPEC)) {
    const from = isObj(src[sec]) ? src[sec] : {}
    const d = DEFAULTS[sec]
    const one = {}
    for (const k of Object.keys(d)) {
      if (sec === 'cover' && k === 'words') {
        one.words = wordsOf(from.words)
        continue
      }
      one[k] = SPEC[sec][k] ? field(SPEC[sec][k], from[k], d[k]) : d[k]
    }
    out[sec] = one
  }
  return out
}

/** 저장 요청을 엄격하게 볼 때(selfcheck 7.7 #11): 300개·50명을 넘으면 거절한다. */
export function checkRoomConfig(cfg) {
  const src = isObj(cfg) ? cfg : {}
  const words = src.cover && Array.isArray(src.cover.words) ? src.cover.words : []
  const distinct = new Set(words.map((w) => cleanWord(w).toLowerCase()).filter(Boolean))
  if (distinct.size > MAX_WORDS) return { ok: false, reason: 'bad_cover.words', error: '금지어는 300개까지 등록할 수 있습니다.' }
  if (words.some((w) => cleanWord(w).length > MAX_WORD_LEN)) {
    return { ok: false, reason: 'bad_cover.words', error: '금지어는 한 개에 30자까지 입력할 수 있습니다.' }
  }
  if (Array.isArray(src.exempt) && src.exempt.length > MAX_EXEMPT) {
    return { ok: false, reason: 'bad_exempt', error: '제외 대상은 50명까지 등록할 수 있습니다.' }
  }
  return { ok: true, config: normRoomConfig(src) }
}

// ── 공통 판정 ─────────────────────────────────────────────────────────────
export function isBotId(id) {
  return /^bot\.[0-9a-f]{16}$/.test(String(id || ''))
}

/** LOCO 응답 성공: 패킷 statusCode 0 이고 본문 status 가 없거나 0. */
export function locoOk(res) {
  return !!res && res.statusCode === 0 && (typeof (res.body && res.body.status) !== 'number' || res.body.status === 0)
}

/** 응답의 실패 status(본문 status 우선, 없으면 패킷 statusCode). 성공이면 0. */
export function locoStatus(res) {
  if (!res) return -1
  if (res.statusCode !== 0) return Number(res.statusCode)
  const s = res.body && res.body.status
  return typeof s === 'number' ? s : 0
}

/** 방 관리 기능이 동작하는가(5.7). 한 함수로만 판정한다. */
export function roombotLive(v) {
  return !!(v && v.products && v.products.roombot && (Number(v.perm) & 5) && v.state === 'active')
}

/** 미니게임이 동작하는가(5.7): 상품이 있고 켜져 있으면 사용 중·부방장 대기 어느 쪽이든. */
export function gamesLive(v) {
  return !!(v && v.products && v.products.minigame && v.cfg && v.cfg.games && v.cfg.games.enabled &&
    (v.state === 'active' || v.state === 'waiting_host'))
}

/** 방장(1)·부방장(4)·봇(8). */
export function staffPerm(p) {
  const n = Number(p)
  return Number.isFinite(n) && ((n & 1) !== 0 || (n & 4) !== 0 || (n & 8) !== 0)
}

export function idText(v) {
  if (v == null || v === '') return ''
  if (typeof v === 'string') return /^[1-9][0-9]*$/.test(v.trim()) ? v.trim() : ''
  if (typeof v === 'number') return Number.isSafeInteger(v) && v > 0 ? String(v) : ''
  if (typeof v === 'bigint') return v > 0n ? v.toString() : ''
  if (typeof v === 'object' && typeof v.toString === 'function') {
    const s = v.toString()
    if (/^[1-9][0-9]*$/.test(s)) return s
  }
  return ''
}

// ── 7.6 방 어댑터 기록 ─────────────────────────────────────────────────────
// 기존 features.mjs 함수(guardOnChat·applyVisit·coverPlan·onInbound·logsView)를 방 하나짜리 기록으로 부른다.
// 방 관리 절은 roombotLive 가 아니면 enabled:false(게이트는 여기 한 곳). runtime 은 이 방 전용 객체를 그대로 쓴다.
export function adapterRecord(view, botId) {
  const cfg = view.cfg || normRoomConfig({})
  const live = roombotLive(view)
  const g = cfg.games
  if (!view.runtime || typeof view.runtime !== 'object') view.runtime = {}
  return {
    device_id: botId || '',
    config: {
      visit: { enabled: live && cfg.visit.enabled, rooms: ['r'] },
      profile: { enabled: live && cfg.profile.enabled, rooms: ['r'], name: cfg.profile.name, photo: cfg.profile.photo, status: cfg.profile.status },
      cover: {
        enabled: live && cfg.cover.enabled,
        rooms: ['r'],
        words: cfg.cover.words,
        links: cfg.cover.links && !(cfg.promo.enabled && cfg.promo.links),
      },
      guard: { kickOn: live && cfg.guard.enabled, rooms: ['r'], kickSecs: cfg.guard.secs, kickCount: cfg.guard.count },
      minigame: {
        enabled: !!(view.products && view.products.minigame && g.enabled),
        rooms: ['r'],
        cmdPrefix: cfg.cmdPrefix,
        word: g.word,
        baseball: g.baseball,
        dice: g.dice,
        rps: g.rps,
        quiz: g.quiz,
        cooldownMs: g.cooldownSec * 1000,
        dailyLimit: g.dailyLimit,
        byId: true,
      },
    },
    rooms: [{ key: 'r', chat_id: String(view.chat_id || ''), name: view.link_name || '', kind: 'open', list_kind: 'open_room' }],
    runtime: view.runtime,
    features: { macro: false, roombot: false, minigame: !!(view.products && view.products.minigame) },
  }
}

// ── 시각 ──────────────────────────────────────────────────────────────────
function kst(ms) {
  const t = new Date(Number(ms) + 9 * HOUR)
  if (!Number.isFinite(t.getTime())) return null
  const p = (n) => String(n).padStart(2, '0')
  return {
    y: t.getUTCFullYear(), mo: p(t.getUTCMonth() + 1), d: p(t.getUTCDate()), h: p(t.getUTCHours()), mi: p(t.getUTCMinutes()),
  }
}

export function kstStamp(ms) {
  const k = kst(ms)
  return k ? `${k.y}-${k.mo}-${k.d} ${k.h}:${k.mi}` : ''
}

function kstShort(ms) {
  const k = kst(ms)
  return k ? `${k.mo}-${k.d} ${k.h}:${k.mi}` : ''
}

function oneLine(s, max) {
  return String(s == null ? '' : s).replace(/[\r\n]+/g, ' ').trim().slice(0, max || 40)
}

// ── 한도 창 ───────────────────────────────────────────────────────────────
/** 미끄럼 창 계수기. 재시작하면 0 이다(5.3). */
export class Win {
  constructor(ms, max) {
    this.ms = ms
    this.max = max
    this.list = []
  }

  trim(now) {
    while (this.list.length && now - this.list[0] >= this.ms) this.list.shift()
  }

  count(now) {
    this.trim(now)
    return this.list.length
  }

  ok(now) {
    return this.count(now) < this.max
  }

  add(now) {
    this.trim(now)
    this.list.push(now)
  }

  /** 다음 자리가 나는 시각(지금 자리가 있으면 now). */
  freeAt(now) {
    this.trim(now)
    if (this.list.length < this.max) return now
    return this.list[this.list.length - this.max] + this.ms
  }
}

// ── 7.2 (a) 입장·퇴장 중복 판정 ────────────────────────────────────────────
export const VISIT_DEDUP_MS = 5000

/**
 * 같은 입장·퇴장을 두 번 세지 않는다. logId 가 있으면 chat|logId|사람(방마다 1시간·400개),
 * 없으면 같은 사람·같은 종류 5초. st 는 방 runtime 의 한 칸.
 */
export function visitDedup(st, chatId, ev, now) {
  if (!st.byLog || typeof st.byLog !== 'object') st.byLog = {}
  if (!st.byWho || typeof st.byWho !== 'object') st.byWho = {}
  const at = Number(ev.at) || now
  const who = ev.userId ? String(ev.userId) : 'n:' + String(ev.name || '')
  const logId = ev.logId ? String(ev.logId) : ''
  if (logId) {
    const key = `${chatId}|${logId}|${who}`
    if (st.byLog[key]) return true
    st.byLog[key] = now
    const keys = Object.keys(st.byLog)
    if (keys.length > 400) {
      for (const k of keys) if (now - Number(st.byLog[k]) > HOUR) delete st.byLog[k]
      const left = Object.keys(st.byLog)
      for (let i = 0; i < left.length - 400; i++) delete st.byLog[left[i]]
    }
    return false
  }
  const key = `${chatId}|${who}|${ev.kind}`
  const prev = Number(st.byWho[key] || 0)
  if (prev && Math.abs(at - prev) < VISIT_DEDUP_MS) return true
  st.byWho[key] = at
  const keys = Object.keys(st.byWho)
  if (keys.length > 400) for (const k of keys) if (Math.abs(at - Number(st.byWho[k])) > MIN) delete st.byWho[k]
  return false
}

// ── 피드 ──────────────────────────────────────────────────────────────────
/** 피드 JSON(채팅 type 0) → {feedType, members:[{userId, name}]}. 피드가 아니면 null. */
export function feedOf(message) {
  const text = typeof message === 'string' ? message.trim() : ''
  if (!text || text.charAt(0) !== '{') return null
  let obj
  try {
    obj = JSON.parse(text)
  } catch {
    const m = /"feedType"\s*:\s*(-?\d+)/.exec(text)
    if (!m) return null
    obj = { feedType: Number(m[1]) }
  }
  if (!isObj(obj)) return null
  const ft = Number(obj.feedType)
  if (!Number.isInteger(ft)) return null
  const members = []
  const push = (m) => {
    if (!isObj(m)) return
    const id = idText(m.userId != null ? m.userId : m.user_id)
    if (id) members.push({ userId: id, name: oneLine(m.nickName || m.nickname || '', 40) })
  }
  if (Array.isArray(obj.members)) obj.members.forEach(push)
  push(obj.member)
  // JSON.parse 가 큰 id 를 잃었으면 글에서 다시 읽는다
  const raw = text.match(/"userId"\s*:\s*"?([0-9]+)"?/g) || []
  raw.forEach((s, i) => {
    const id = /([0-9]+)"?$/.exec(s)[1]
    if (members[i] && members[i].userId !== id && /^[1-9][0-9]*$/.test(id)) members[i].userId = id
  })
  return { feedType: ft, members }
}

export function feedHas(feed, userId) {
  const me = String(userId || '')
  return !!(feed && me && feed.members.some((m) => m.userId === me))
}

/** 첨부의 멘션 user_id 목록. */
export function mentionIds(attachment) {
  let a = attachment
  if (typeof a === 'string') {
    try { a = JSON.parse(a) } catch { a = null }
  }
  const list = isObj(a) && Array.isArray(a.mentions) ? a.mentions : []
  const out = []
  for (const m of list) {
    const id = idText(m && m.user_id)
    if (id && !out.includes(id)) out.push(id)
  }
  return out
}

// ── 사람 판정 ─────────────────────────────────────────────────────────────
function exemptIds(cfg) {
  return new Set((cfg.exempt || []).map((e) => String(e.user_id)))
}

/** 방장·부방장·봇·제외할 사람이면 true. ctx.permOf(userId) 는 아는 권한(모르면 null). */
export function protectedPerson(cfg, ctx, userId) {
  if (!userId) return false
  if (exemptIds(cfg).has(String(userId))) return true
  if (ctx && ctx.selfId && String(ctx.selfId) === String(userId)) return true
  const p = ctx && typeof ctx.permOf === 'function' ? ctx.permOf(String(userId)) : null
  return staffPerm(p)
}

/** 멘션 1개의 글자 위치(features.visitMentionExtra 와 같은 모양). */
function withAt(text, mention) {
  if (!mention) return null
  const i = text.indexOf('@')
  return i < 0 ? null : Object.assign({}, mention, { at: i + 1 })
}

function mentionLine(label, name, userId) {
  const nm = oneLine(name, 40).replace(/@/g, '')
  if (userId && nm) return { line: `${label} : @${nm}`, mention: { userId: String(userId), len: nm.length } }
  return { line: `${label} : ${nm || '이름 없음'}`, mention: null }
}

// ── 7.2 (a) 들낙 감지 ──────────────────────────────────────────────────────
/**
 * 들어올 때마다 부른다. 사람별 입장 시각(최대 40)을 세고, 창 안 입장이 joins 이상이며 그 창에서 아직
 * 조치하지 않았으면 계획을 돌려준다. 제외·방장·부방장은 무시. id 를 모르면 경고만(idUnknown).
 * → null | {userId, name, count, windowMin, action:'warn'|'kick', notice:bool, idUnknown:bool}
 */
export function churnCheck(st, cfg, ev, ctx, now) {
  const c = cfg.churn
  if (!c || !c.enabled || ev.kind !== 'join') return null
  const userId = ev.userId ? String(ev.userId) : ''
  const name = oneLine(ev.name, 40)
  if (!userId && !name) return null
  if (userId && protectedPerson(cfg, ctx, userId)) return null
  if (!st.people || typeof st.people !== 'object') st.people = {}
  const key = userId || 'n:' + name
  const at = Number(ev.at) || now
  const windowMs = c.windowMin * MIN
  const row = st.people[key] || { times: [], actedAt: 0 }
  row.times = (Array.isArray(row.times) ? row.times : []).filter((t) => at - Number(t) < windowMs && Number(t) <= at)
  row.times.push(at)
  if (row.times.length > 40) row.times = row.times.slice(-40)
  st.people[key] = row
  const keys = Object.keys(st.people)
  if (keys.length > 500) {
    keys.sort((a, b) => lastOf(st.people[a]) - lastOf(st.people[b]))
    for (let i = 0; i < keys.length - 500; i++) delete st.people[keys[i]]
  }
  if (row.times.length < c.joins) return null
  if (row.actedAt && at - row.actedAt < windowMs) return null
  row.actedAt = at
  return {
    userId,
    name,
    count: row.times.length,
    windowMin: c.windowMin,
    action: userId ? c.action : 'warn',
    notice: !!c.notice,
    idUnknown: !userId,
  }
}

function lastOf(row) {
  const t = row && Array.isArray(row.times) ? row.times : []
  return t.length ? Number(t[t.length - 1]) : 0
}

/** result: 'warn' | 'kicked' | 'kick_failed' */
export function churnNotice(plan, result) {
  const nm = mentionLine('이름', plan.name || '', plan.userId)
  const act = result === 'kicked' ? '내보내기' : result === 'kick_failed' ? '내보내기 실패' : '경고'
  const text = ['[들낙 감지]', nm.line, `입장 : ${plan.windowMin}분 동안 ${plan.count}회`, `조치 : ${act}`].join('\n')
  return { text, mention: withAt(text, nm.mention) }
}

// ── 7.2 (b) 나갔을 때 내보내기 ─────────────────────────────────────────────
/**
 * 퇴장(피드 2·3)에만. → null(무시) | {type:'kick_fail', note:'id 없음', name} | {type:'kick', userId, name}
 */
export function leaveKickPlan(cfg, ev, ctx) {
  const c = cfg.leaveKick
  if (!c || !c.enabled || ev.kind !== 'leave') return null
  const userId = ev.userId ? String(ev.userId) : ''
  const name = oneLine(ev.name, 40)
  if (!userId) return { type: 'kick_fail', note: 'id 없음', name }
  if (protectedPerson(cfg, ctx, userId)) return null
  return { type: 'kick', userId, name }
}

const BAN_KEEP_MS = 30 * DAY
const BAN_MAX = 1000

/** 나간 사람의 내보내기가 실패하면 다시 들어올 때 내보내려고 적어 둔다(30일, 최대 1000명). */
export function noteBan(st, userId, name, now) {
  if (!st.bans || typeof st.bans !== 'object') st.bans = {}
  st.bans[String(userId)] = { at: now, name: oneLine(name, 40) }
  pruneBans(st, now)
}

export function pruneBans(st, now) {
  if (!st.bans || typeof st.bans !== 'object') st.bans = {}
  for (const k of Object.keys(st.bans)) if (now - Number(st.bans[k] && st.bans[k].at) > BAN_KEEP_MS) delete st.bans[k]
  const keys = Object.keys(st.bans)
  if (keys.length > BAN_MAX) {
    keys.sort((a, b) => Number(st.bans[a].at) - Number(st.bans[b].at))
    for (let i = 0; i < keys.length - BAN_MAX; i++) delete st.bans[keys[i]]
  }
}

export function bannedNow(st, userId, now) {
  const b = st && st.bans && st.bans[String(userId || '')]
  return !!(b && now - Number(b.at) <= BAN_KEEP_MS)
}

export function leaveKickNotice(name) {
  return `[재입장 차단]\n이름 : ${oneLine(name, 40) || '이름 없음'}`
}

// ── 7.2 (c) 프로필 로그 ────────────────────────────────────────────────────
/** 사진 서명 = 원본(없으면 작은) 사진 주소의 경로(쿼리 제거, 7.2(c)). 주소 전체는 저장하지 않는다. */
export function photoSig(original, small) {
  const raw = String(original || small || '').trim()
  if (!raw) return ''
  try {
    return new URL(raw).pathname.slice(0, 200)
  } catch {
    return raw.split('?')[0].replace(/^[a-z]+:\/\/[^/]*/i, '').slice(0, 200)
  }
}

function profileStore(runtime) {
  if (!runtime.profile || typeof runtime.profile !== 'object') runtime.profile = {}
  const p = runtime.profile
  if (!isObj(p.people)) p.people = {}
  if (!isObj(p.nextAt)) p.nextAt = {}
  return p
}

function nameChanges(changes) {
  return (Array.isArray(changes) ? changes : []).filter((c) => c && (!c.kind || c.kind === 'name'))
}

/**
 * 한 사람의 관찰(이름·사진 서명·상태 메시지). 첫 관찰은 기준만 저장한다. 바뀐 칸마다 안내 1개.
 * pcfg: {name, photo, status} (없으면 켜짐). runtime 은 방(또는 계정) runtime.
 * → [{text, mention, kind}]
 */
export function profileObserve(runtime, chatId, pcfg, ob, now) {
  const out = []
  const userId = idText(ob && ob.userId)
  const name = oneLine(ob && ob.name, 40)
  if (!userId) return out
  const p = profileStore(runtime)
  const key = `${chatId}${SEP}${userId}`
  const prev = p.people[key]
  const on = (k) => !pcfg || pcfg[k] !== false
  const photo = ob.photo == null ? null : String(ob.photo)
  const status = ob.status == null ? null : String(ob.status).slice(0, 200)
  if (!isObj(prev) || !prev.name) {
    if (!name) return out
    p.people[key] = {
      name, userId, at: now,
      photo: photo || undefined,
      status: status == null ? undefined : status,
      changes: isObj(prev) && Array.isArray(prev.changes) ? prev.changes : [],
    }
    pruneProfile(p)
    return out
  }
  const changes = Array.isArray(prev.changes) ? prev.changes.slice() : []
  const cur = String(prev.name).trim()
  const nowName = name || cur
  if (name && name !== cur) {
    changes.push({ at: now, kind: 'name', name: cur })
    if (on('name')) {
      const n = nameChanges(changes).length
      const nm = mentionLine('이름', name, userId)
      const lines = ['[프로필 변경 감지]', nm.line, '이전 : ' + (cur.replace(/@/g, '') || '이름 없음'), '시각 : ' + kstStamp(now)]
      if (n >= 2) lines.push('누적 : ' + n + '회')
      const text = lines.join('\n')
      out.push({ text, mention: withAt(text, nm.mention), kind: 'name' })
    }
  }
  if (photo && prev.photo && photo !== prev.photo) {
    changes.push({ at: now, kind: 'photo' })
    if (on('photo')) {
      const nm = mentionLine('이름', nowName, userId)
      const text = ['[프로필 변경 감지]', nm.line, '항목 : 프로필 사진', '시각 : ' + kstStamp(now)].join('\n')
      out.push({ text, mention: withAt(text, nm.mention), kind: 'photo' })
    }
  }
  if (status != null && prev.status != null && status !== prev.status) {
    changes.push({ at: now, kind: 'status', from: String(prev.status).slice(0, 200), to: status })
    if (on('status')) {
      const nm = mentionLine('이름', nowName, userId)
      const text = ['[프로필 변경 감지]', nm.line, '항목 : 상태 메시지', '이전 : ' + (oneLine(prev.status, 60) || '없음'), '시각 : ' + kstStamp(now)].join('\n')
      out.push({ text, mention: withAt(text, nm.mention), kind: 'status' })
    }
  }
  p.people[key] = {
    name: nowName,
    userId,
    at: now,
    photo: photo || prev.photo || undefined,
    status: status != null ? status : prev.status,
    changes: changes.slice(-30),
  }
  pruneProfile(p)
  return out
}

function pruneProfile(p) {
  const keys = Object.keys(p.people)
  if (keys.length <= 300) return
  keys.sort((a, b) => (Number(p.people[a] && p.people[a].at) || 0) - (Number(p.people[b] && p.people[b].at) || 0))
  for (let i = 0; i < keys.length - 300; i++) delete p.people[keys[i]]
}

/**
 * {앞글자}프로필 @닉네임 / {앞글자}프로필 닉네임. 대상: 멘션 user_id → 현재 이름 유일 일치.
 * 권한: staff(방장·부방장만) / all / off. → null(답 없음) | 답 글
 */
export function profileLookup(runtime, chatId, cfg, ask, ctx, now) {
  const lookup = cfg.profile.lookup
  if (!cfg.profile.enabled || lookup === 'off') return null
  if (lookup === 'staff') {
    const p = ctx && ctx.permOf ? ctx.permOf(String(ask.authorId || '')) : null
    const n = Number(p)
    if (!(Number.isFinite(n) && ((n & 1) || (n & 4)))) return null
  }
  const p = profileStore(runtime)
  let target = ''
  const mentioned = (ask.mentions || [])[0]
  if (mentioned) target = String(mentioned)
  const want = oneLine(String(ask.arg || '').replace(/^@/, ''), 40)
  if (!target) {
    if (!want) return `「${cfg.cmdPrefix}프로필 닉네임」처럼 입력해 주세요.`
    const hits = []
    for (const k of Object.keys(p.people)) {
      if (!k.startsWith(chatId + SEP)) continue
      const row = p.people[k]
      if (row && String(row.name || '').trim() === want && row.userId && !hits.includes(String(row.userId))) hits.push(String(row.userId))
    }
    if (hits.length > 1) return sameNameReply(hits.length)
    target = hits[0] || ''
  }
  const row = target ? p.people[`${chatId}${SEP}${target}`] : null
  if (!row) return want ? `「${want}」의 프로필 기록이 없어요.` : '이 사람의 프로필 기록이 없어요.'
  const changes = Array.isArray(row.changes) ? row.changes : []
  const olds = nameChanges(changes).slice(-5).map((c) => `${oneLine(c.name, 40) || '이름 없음'} (${kstShort(c.at)})`)
  const photos = changes.filter((c) => c && c.kind === 'photo').length
  const visit = runtime.visit && isObj(runtime.visit.people) ? runtime.visit.people[`${chatId}${SEP}${target}`] : null
  const since = now - 14 * DAY
  const joins = visit && Array.isArray(visit.joins) ? visit.joins.filter((t) => Number(t) >= since).length : 0
  const leaves = visit && Array.isArray(visit.leaves) ? visit.leaves.filter((t) => Number(t) >= since).length : 0
  return [
    '[프로필 기록]',
    '이름 : ' + (oneLine(row.name, 40) || '이름 없음'),
    '이전 이름 : ' + (olds.length ? olds.join(', ') : '없음'),
    '사진 변경 : ' + photos + '회',
    `최근 14일 : 입장 ${joins}회 · 퇴장 ${leaves}회`,
  ].join('\n')
}

// ── 7.2 (d) 홍보 금지 ──────────────────────────────────────────────────────
export const LINK_RE = /(?:https?:\/\/|open\.kakao\.com|kakao\.com\/o\/|www\.|[a-z0-9-]{2,}\.(?:com|net|org|kr|me|io|tv|cc|gg|xyz|link|shop|site|club|top|info|biz)(?![a-z0-9]))/i
const CARD_TYPES = new Set([71, 17, 9])
const MEDIA_TYPES = new Set([2, 27, 3, 18])

function attachText(a) {
  if (a == null) return ''
  if (typeof a === 'string') return a
  try { return JSON.stringify(a) } catch { return '' }
}

/** 이 글이 홍보 금지 위반인가. 방장·부방장·제외는 위반 아님. 답장(26)은 본문만 본다. */
export function promoViolation(cfg, ev, ctx) {
  const c = cfg.promo
  if (!c || !c.enabled || !ev.userId) return ''
  if (protectedPerson(cfg, ctx, ev.userId)) return ''
  const type = Number(ev.type)
  if (c.cards && CARD_TYPES.has(type)) return 'card'
  if (c.media && MEDIA_TYPES.has(type)) return 'media'
  if (c.links) {
    if (LINK_RE.test(String(ev.text || ''))) return 'link'
    if (CARD_TYPES.has(type) && LINK_RE.test(attachText(ev.attachment))) return 'link'
  }
  return ''
}

/**
 * 위반 1건의 조치 계획: 가림 → 경고 수 올림(resetHours 지나면 1부터) → kickAt 에 닿으면 내보냄 → 안내(같은 사람 10초에 1번).
 * → null | {userId, name, n, hide, kick, notice}
 */
export function promoCheck(st, cfg, ev, ctx, now) {
  const why = promoViolation(cfg, ev, ctx)
  if (!why) return null
  const c = cfg.promo
  if (!isObj(st.count)) st.count = {}
  if (!isObj(st.noticeAt)) st.noticeAt = {}
  const uid = String(ev.userId)
  const prev = st.count[uid]
  let n = 1
  if (isObj(prev) && now - Number(prev.at) < c.resetHours * HOUR) n = Number(prev.n) + 1
  st.count[uid] = { n, at: now }
  const kick = c.kickAt > 0 && n >= c.kickAt
  if (kick) delete st.count[uid]
  const lastNotice = Number(st.noticeAt[uid] || 0)
  const notice = !!c.notice && (!lastNotice || now - lastNotice >= 10000)
  if (notice) st.noticeAt[uid] = now
  const keys = Object.keys(st.count)
  if (keys.length > 500) for (const k of keys) if (now - Number(st.count[k].at) > c.resetHours * HOUR) delete st.count[k]
  for (const k of Object.keys(st.noticeAt)) if (now - Number(st.noticeAt[k]) > MIN) delete st.noticeAt[k]
  return { userId: uid, name: oneLine(ev.name, 40), n, why, hide: !!c.hide, kick, notice, kickAt: c.kickAt }
}

/** result: {hidden, kicked} */
export function promoNotice(plan, result) {
  const nm = mentionLine('이름', plan.name, plan.userId)
  // 분수 표기(1/3회) 대신 몇 회에 내보내는지 말로 적는다. 내보냈거나 기준에 닿은 뒤에는 횟수만.
  const warn = plan.kickAt > 0 && !result.kicked && plan.n < plan.kickAt
    ? `경고 : ${plan.n}회 (${plan.kickAt}회가 되면 내보내요)`
    : `경고 : ${plan.n}회`
  const act = result.kicked ? '내보내기' : result.hidden ? '글 가리기' : '경고'
  const text = ['[홍보 금지]', nm.line, warn, `조치 : ${act}`].join('\n')
  return { text, mention: withAt(text, nm.mention) }
}

// ── 7.2 (e) 가리기 ────────────────────────────────────────────────────────
export const RING_MAX = 300

/** 방마다 최근 300개 글 {logId, type, authorId, name, at, cmd?, hidden?}(본문 없음, 메모리만). */
export function ringPush(ring, item) {
  if (!item || !item.logId) return
  if (ring.some((x) => x.logId === item.logId)) return
  ring.push(item)
  ring.sort((a, b) => cmpId(a.logId, b.logId))
  if (ring.length > RING_MAX) ring.splice(0, ring.length - RING_MAX)
}

function cmpId(a, b) {
  try {
    const d = BigInt(a) - BigInt(b)
    return d < 0n ? -1 : d > 0n ? 1 : 0
  } catch {
    return String(a) < String(b) ? -1 : 1
  }
}

/**
 * 가릴 글 목록. 방장·부방장·봇·피드·이미 가린 글·명령 글은 뺀다. 300개 상한.
 * req: {last:N} 최근 N개 | {userId} 그 사람의 버퍼 안 글 전부
 */
export function hidePlan(ring, req, ctx) {
  const out = []
  const want = req && req.userId ? String(req.userId) : ''
  const limit = Math.max(0, Math.min(RING_MAX, Number(req && req.last) || RING_MAX))
  for (let i = ring.length - 1; i >= 0; i--) {
    const m = ring[i]
    if (!m || m.hidden || m.cmd || Number(m.type) === 0) continue
    const uid = String(m.authorId || '')
    if (!uid || (ctx && ctx.selfId && uid === String(ctx.selfId))) continue
    if (want && uid !== want) continue
    const p = ctx && ctx.permOf ? ctx.permOf(uid) : null
    if (staffPerm(p)) continue
    out.push({ logId: m.logId, type: Number(m.type) || 1 })
    if (!want && out.length >= limit) break
    if (out.length >= RING_MAX) break
  }
  return out
}

/**
 * 방 안 {앞글자}가리기 명령. → null(가리기 명령 아님) | {usage:true} | {last:N} | {userId} | {name}
 * 999 는 300 으로, 0·글자는 사용법.
 */
export function parseHideCommand(text, prefix, mentions) {
  const body = String(text || '').trim()
  const head = prefix + '가리기'
  if (!body.startsWith(head)) return null
  const rest = body.slice(head.length)
  if (rest && !/^\s/.test(rest)) return null
  const arg = rest.trim()
  if (mentions && mentions.length) return { userId: String(mentions[0]) }
  if (/^@/.test(arg)) return { name: oneLine(arg.slice(1), 40) }
  if (!/^\d{1,6}$/.test(arg)) return { usage: true }
  const n = Number(arg)
  if (n < 1) return { usage: true }
  return { last: Math.min(RING_MAX, n) }
}

export function hideUsage(prefix) {
  return `「${prefix}가리기 30」처럼 가릴 글 수(1~300)를 입력해 주세요. 한 사람의 글은 「${prefix}가리기 @이름」으로 가릴 수 있어요.`
}

export function hideDoneNotice(done, failed) {
  return `[글 가리기]\n글 ${done}개를 가렸어요.` + (failed ? `\n(${failed}개는 가리지 못했어요)` : '')
}

// ── 도움·입장 안내(7.3·7.9) ───────────────────────────────────────────────
// 방 메시지는 짧은 해요체(docs/TONE.md 「K bot 방 메시지」). 방 사람들은 계정·패널을 모르므로 봇은 이름으로, 설정하는 사람은 방장님·관리자로 쓴다.

/**
 * 켜진 게임과 켜진 방 관리 명령(가리기·프로필)의 목록. 아무것도 없으면 ''.
 * [명령어]
 * 미니게임 : !끝말잇기 … !랭킹
 * 방 관리 : !가리기 !프로필
 */
export function helpLine(view) {
  const cfg = view.cfg
  const p = cfg.cmdPrefix
  const games = []
  if (gamesLive(view)) {
    const g = cfg.games
    if (g.word) games.push(p + '끝말잇기')
    if (g.baseball) games.push(p + '숫자야구')
    if (g.dice) games.push(p + '주사위')
    if (g.rps) games.push(p + '가위바위보')
    if (g.quiz) games.push(p + '퀴즈', p + '힌트', p + '정답')
    if (g.word || g.baseball || g.quiz) games.push(p + '포기')
    games.push(p + '랭킹')
  }
  const room = []
  if (roombotLive(view)) {
    if (cfg.hide.command) room.push(p + '가리기')
    if (cfg.profile.enabled && cfg.profile.lookup !== 'off') room.push(p + '프로필')
  }
  if (!games.length && !room.length) return ''
  const lines = ['[명령어]']
  if (games.length) lines.push('미니게임 : ' + games.join(' '))
  if (room.length) lines.push('방 관리 : ' + room.join(' '))
  return lines.join('\n')
}

export function isHelpCommand(text, prefix) {
  const t = String(text || '').trim()
  return t === prefix + '도움' || t === prefix + '명령'
}

// 방장에게 부방장 지정을 부탁하는 줄. 방장이 고를 수 있게 방에 보이는 봇 이름을 넣는다(D12).
function promoteAsk(nick) {
  const who = nick ? `「${nick}」${josa(nick, '을')}` : 'K bot을'
  return `방장님이 ${who} 부방장으로 지정하면 방 관리 기능이 시작돼요.`
}

export function joinNotice(view, nickname) {
  const p = view.cfg.cmdPrefix
  const nick = oneLine(nickname, 40)
  if (view.products.roombot) {
    let t = `[K bot]\n방 관리봇이 입장했어요.\n${promoteAsk(nick)}`
    if (view.products.minigame) t += `\n「${p}도움」을 입력하면 미니게임 명령어를 볼 수 있어요.`
    return t
  }
  if (view.cfg.games.enabled) return `[K bot]\n미니게임봇이 입장했어요.\n「${p}도움」을 입력하면 명령어를 볼 수 있어요.`
  return '[K bot]\n미니게임봇이 입장했어요.\n관리자가 미니게임을 켜면 바로 쓸 수 있어요.'
}

// 미니게임봇으로 이미 들어가 있는 방에 방 관리봇을 더했을 때(입장 안내가 방 관리봇을 말하지 않았던 방) 1회.
// 7.9 의 방 관리봇 입장 안내와 같은 지정 문장으로, 방장이 지정할 계정을 고를 수 있게 닉네임을 넣는다(D12).
export function roombotAddedNotice(view, nickname) {
  const nick = oneLine(nickname, 40)
  return `[K bot]\n방 관리봇이 추가되었어요.\n${promoteAsk(nick)}`
}

// 끝소리: 'none' 받침 없음 | 'rieul' ㄹ 받침 | 'other' 다른 받침 | '' 모름(글자 없음).
// 영문·숫자는 읽는 소리로 대강 고른다. 글자 하나로 끝나면(2B, K) 알파벳 이름(엘·알 → ㄹ, 엠·엔 → 받침)으로,
// 낱말이면(bot, kim, bell) 끝소리로 읽는다.
function finalSound(word) {
  const s = String(word || '').replace(/[^0-9A-Za-z가-힣]+$/, '')
  if (!s) return ''
  const ch = s.charAt(s.length - 1)
  const code = ch.charCodeAt(0)
  if (code >= 0xAC00 && code <= 0xD7A3) {
    const jong = (code - 0xAC00) % 28
    return jong === 0 ? 'none' : jong === 8 ? 'rieul' : 'other'
  }
  if (/[0-9]/.test(ch)) return '178'.indexOf(ch) >= 0 ? 'rieul' : '036'.indexOf(ch) >= 0 ? 'other' : 'none'   // 일·칠·팔 / 영·삼·육 / 이·사·오·구
  const c = ch.toLowerCase()
  if (!/[A-Za-z]{2}$/.test(s)) return 'lr'.indexOf(c) >= 0 ? 'rieul' : 'mn'.indexOf(c) >= 0 ? 'other' : 'none'
  if (c === 'l') return 'rieul'
  return 'bcdgkmnpqt'.indexOf(c) >= 0 ? 'other' : 'none'
}

const JOSA = {
  '을': ['을', '를', '을', '을(를)'],               // [다른 받침, 받침 없음, ㄹ 받침, 모름]
  '은': ['은', '는', '은', '은(는)'],
  '이': ['이', '가', '이', '이(가)'],
  '으로': ['으로', '로', '로', '(으)로'],
  '이에요': ['이에요', '예요', '이에요', '(이)에요'],
  '이었어요': ['이었어요', '였어요', '이었어요', '(이)었어요'],
}

/** 낱말 뒤 조사를 받침에 맞춘다. kind: '을' | '은' | '이' | '으로' | '이에요' | '이었어요'. */
export function josa(word, kind) {
  const row = JOSA[kind]
  if (!row) return ''
  const f = finalSound(word)
  return f === 'other' ? row[0] : f === 'none' ? row[1] : f === 'rieul' ? row[2] : row[3]
}

// 이름 뒤 '로'/'으로'(받침이 없거나 ㄹ 받침이면 '로').
export function roJosa(word) {
  return josa(word, '으로')
}

/** 같은 이름을 쓰는 사람이 여럿일 때(!프로필·!가리기 @이름). */
export function sameNameReply(n) {
  return `같은 이름을 쓰는 사람이 ${n}명 있어요. @멘션으로 골라 주세요.`
}

// 기본 프로필로 들어가 있던 방을 오픈프로필로 바꾼 뒤(부방장 대기 방에서만, D12). 방장이 새 이름으로 찾게 한다.
export function profileChangedNotice(name) {
  const nick = oneLine(name, 40)
  if (!nick) return `[K bot]\nK bot 프로필이 바뀌었어요.\n${promoteAsk('')}`
  return `[K bot]\nK bot 프로필이 「${nick}」${josa(nick, '으로')} 바뀌었어요.\n${promoteAsk(nick)}`
}

export const PROMOTED_NOTICE = '[K bot]\n부방장으로 지정되었어요. 이제 켜 둔 방 관리 기능이 작동해요.'

/** 미니게임 랭킹(점수는 authorId, 이름은 names 표). */
export function rankingOf(runtime, n) {
  const board = runtime && runtime.scores && isObj(runtime.scores.r) ? runtime.scores.r : {}
  const names = runtime && runtime.names && isObj(runtime.names.r) ? runtime.names.r : {}
  return Object.entries(board)
    .map(([id, score]) => ({ name: oneLine(names[id] || (id.startsWith('n:') ? id.slice(2) : ''), 40) || '이름 없음', score: Number(score) || 0 }))
    .sort((a, b) => b.score - a.score)
    .slice(0, n || 10)
}

// ── 5.5 공정 몫 송신 ──────────────────────────────────────────────────────
export const SEND_ROOM_PER_MIN = 6
export const SEND_BOT_PER_MIN = 30
const QUEUE_MAX = 30
const STALE_MS = 10 * MIN

/**
 * 방별 대기열 + 봇 전체 페이서. 방을 돌아가며 하나씩 꺼낸다(round-robin).
 * 방 한도(6/분)에 걸린 방의 항목은 그 방 대기열에서만 밀린다. 대기열이 가득 차거나 10분 넘게 묵은 항목은 건너뛴다.
 */
export class Pacer {
  constructor(opts) {
    const o = opts || {}
    this.roomMax = o.roomMax || SEND_ROOM_PER_MIN
    this.botWin = new Win(MIN, o.botMax || SEND_BOT_PER_MIN)
    this.rooms = new Map()       // key → {queue, win}
    this.order = []
    this.rr = 0
  }

  room(key) {
    let r = this.rooms.get(key)
    if (!r) {
      r = { queue: [], win: new Win(MIN, this.roomMax) }
      this.rooms.set(key, r)
      this.order.push(key)
    }
    return r
  }

  /** → true(들어감) | false(가득 차서 건너뜀) */
  push(key, item, now) {
    const r = this.room(key)
    if (r.queue.length >= QUEUE_MAX) return false
    r.queue.push(Object.assign({ at: now, notBefore: now }, item))
    return true
  }

  drop(key) {
    this.rooms.delete(key)
    this.order = this.order.filter((k) => k !== key)
    if (this.rr >= this.order.length) this.rr = 0
  }

  pending() {
    let n = 0
    for (const r of this.rooms.values()) n += r.queue.length
    return n
  }

  /** 낡은 항목을 꺼내 버린다. → [{key, item}] */
  stale(now) {
    const out = []
    for (const [key, r] of this.rooms) {
      while (r.queue.length && now - r.queue[0].at > STALE_MS) out.push({ key, item: r.queue.shift() })
    }
    return out
  }

  /** 지금 보낼 항목 하나. → {key, item} | null */
  next(now) {
    if (!this.botWin.ok(now)) return null
    const n = this.order.length
    for (let i = 0; i < n; i++) {
      const idx = (this.rr + i) % n
      const key = this.order[idx]
      const r = this.rooms.get(key)
      if (!r || !r.queue.length) continue
      if (r.queue[0].notBefore > now) continue
      if (!r.win.ok(now)) continue
      const item = r.queue.shift()
      r.win.add(now)
      this.botWin.add(now)
      this.rr = (idx + 1) % n
      return { key, item }
    }
    return null
  }

  /** 다음에 무언가 보낼 수 있는 가장 이른 시각(없으면 0). */
  wakeAt(now) {
    let at = 0
    for (const r of this.rooms.values()) {
      if (!r.queue.length) continue
      const t = Math.max(r.queue[0].notBefore, r.win.freeAt(now), this.botWin.freeAt(now))
      if (!at || t < at) at = t
    }
    return at
  }
}

// ── 5.5 조치 한도 ─────────────────────────────────────────────────────────
export const LIMITS = Object.freeze({
  kickRoomHour: 10,
  kickBotHour: 30,
  kickBotDay: 200,
  hideRoom30m: 300,
  hideBot10m: 600,
})

export function roomLimits() {
  return { kick: new Win(HOUR, LIMITS.kickRoomHour), hide: new Win(30 * MIN, LIMITS.hideRoom30m) }
}

export function botLimits() {
  return {
    kickH: new Win(HOUR, LIMITS.kickBotHour),
    kickD: new Win(DAY, LIMITS.kickBotDay),
    hide: new Win(10 * MIN, LIMITS.hideBot10m),
  }
}
