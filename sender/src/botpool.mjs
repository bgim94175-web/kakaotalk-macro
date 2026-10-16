// K bot 계정(운영자 봇 카카오 계정) 풀 — docs/ACCOUNTS_V1.md 5.2~5.7·7장.
// 봇 하나 = BotSlot 하나. 봇은 고객이 산 방(room_installs)에 들어가 방 관리봇·미니게임을 돌린다.
//   · 입장: 봇마다 직렬(나가기 → 입장), 입장 사이 BOT_JOIN_GAP_MS(±20%), 원시 패킷 1회(executeWithReconnect 안 씀),
//     결과 판정은 locoOk, 입장 실패로 클라이언트를 닫았다 열지 않는다. 예산(시간·하루)·전역 정지(-444)를 강제한다.
//   · 권한·생존 점검: 부방장 대기 60초(±15초), 사용 중 10분, 재접속 직후, SYNCMEMT·피드 11/12/15 푸시 3초 뒤.
//   · 방별 처리: 방 어댑터 기록(roomfeat.adapterRecord)으로 features.mjs 를 부르고, 새 기능은 roomfeat.mjs.
//   · DB 쓰기는 2.2 의 sender 칸만, 늘 WHERE id AND phase='installed' AND bot_device_id=봇(store.updateInstall).
// 네트워크·DB 는 주입받는다(store, newClient) — selfcheck 가 가짜 연결·메모리 저장소로 같은 코드를 돈다.
import { createHash } from 'node:crypto'
import { Long } from 'bson'

import {
  coverNeedsAuthor,
  coverPlan,
  guardFinishHalt,
  guardOnChat,
  logsView,
  onInbound,
  visitEventsFromMessage,
  visitMentionExtra,
} from './features.mjs'
import { AVATAR_HOSTS, Avatars } from './avatar.mjs'
import { available as cardAvailable } from './card.mjs'
import { logCardPng } from './logcard.mjs'
import { Owner } from './owner.mjs'
import * as C from './roomcmd.mjs'
import * as R from './roomfeat.mjs'
import { open as openPasscode } from './secretbox.mjs'
import * as VR from './voiceroom.mjs'

const MIN = 60 * 1000
const HOUR = 60 * MIN
const DAY = 24 * HOUR

const RATE_STATUS = new Set([-312, -805, -819])
const GONE_STATUS = new Set([-324])
const DEAD_CODES = new Set(['invalid_access_token', 'login_rejected', 'kicked', 'reauth'])
// 방 멤버 명부: 카드 채우기는 방마다 60초에 20명까지, 명부에 없는 사람이 나가면 방마다 10초에 한 번 2초까지만 읽어 본다
const MEMBER_FILL_MAX = 20
const MEMBER_FILL_GAP_MS = MIN
const LEAVE_READ_MS = 2000
const LEAVE_READ_GAP_MS = 10000
const EMPTY_LINK_MS = 12 * 60 * MIN   // 옾링이 없다고 답한 pli 는 12시간 다시 묻지 않는다
const LINK_RETRY_MAX = 60            // 실패한 옾링 묶음을 나눠 다시 읽는 것은 한 번에 60번까지
const MEMBER_FAIL_MAX = 3             // 카드 채우기에서 세 번 못 읽은 사람은 목록에서 뺀다(다음 동기화가 다시 넣는다)
const MEMBER_LOG_MS = 60 * MIN        // 명부 동기화 요약은 처음·수가 바뀔 때·1시간마다만 남긴다
const BAD_LINK_MS = 30 * MIN          // 혼자서도 읽기가 실패한 pli 는 30분 동안 묶음 읽기에서 뺀다(모름으로 둔다)
const NOTICE_LINK_MAX = 20            // 동기화 한 번에 안내 전 옾링을 혼자 읽는 사람 수
const GAME_BACKLOG_MAX = 3            // 방 발송이 이만큼 밀려 있으면(분당 6 → 30초쯤 늦음) 검 강화 명령어를 받지 않는다
const PHOTO_MAX = 2                   // 봇 하나가 한꺼번에 올리는 사진 수(방마다는 하나씩, 순서대로)
const LOAD_RETRY_MS = 5000            // room_state 읽기가 실패한 방을 다시 읽기까지(실패할 때마다 두 배, 최대 2분)
const LOAD_RETRY_MAX_MS = 2 * MIN
const SAVE_SOON_MS = 300              // 게임 답이 나간 방은 이만큼 뒤에 한 번 저장한다(5초 주기를 기다리다 꺼지면 방에 보인 결과가 되돌아간다)
const PHOTO_LATE_MAX_MS = 2 * MIN     // 기다림을 넘긴 사진 올리기를 PHOTO_MAX 에 세고 그 방의 다음 글을 붙잡아 두는 최대 시간
// 다시 읽기(loadRuntime)에서 저장본보다 실패한 동안의 임시본을 쓰는 칸: 이 봇이 이 방에서 남긴 기록(프로필·안내 표시)
const OWN_KEYS = ['prof', 'welcomed', 'promoted']

// 카드를 더 읽어야 하는 사람: 카드를 읽은 적이 없거나(pli 모름), pli 는 있는데 옾링을 모른다
function needsCard(m) {
  return !m || m.pli == null || (!!m.pli && m.link == null)
}

// 멤버의 프로필 사진 주소(기록 카드 동그라미): 작은 사진(pi) → 큰 사진(fpi) → 원본(opi). 라이브러리 모양(profile_image_url …)과
// 원시 패킷(GETMEM·MEMBER) 모양 둘 다. 사진이 없으면 '', 사진 칸이 아예 없는 모양이면 null(모름 — 명부의 사진을 지우지 않는다)
const PHOTO_KEYS = [['profile_image_url', 'pi'], ['full_profile_image_url', 'fpi'], ['original_profile_image_url', 'opi']]
function photoOf(m) {
  if (!m || typeof m !== 'object') return null
  let seen = false
  for (const keys of PHOTO_KEYS) {
    for (const k of keys) {
      if (m[k] === undefined) continue
      seen = true
      const s = typeof m[k] === 'string' ? m[k].trim() : ''
      if (s && s.length <= 1000) return s
    }
  }
  return seen ? '' : null
}

// 안내에 적을 옾링: 주소, 오픈프로필이 아님('') → '', 오픈프로필인데 못 읽음·카드를 모름 → null(확인 못 함)
function noticeLink(m) {
  if (m && m.link) return m.link
  return m && (m.pli === '' || m.link === '') ? '' : null
}

function envNum(name, dflt) {
  const raw = process.env[name]
  if (raw == null || String(raw).trim() === '') return dflt
  const n = Number(raw)
  return Number.isFinite(n) && n >= 0 ? n : dflt
}

function envList(name, dflt) {
  const raw = String(process.env[name] || '').trim()
  if (!raw) return dflt
  const list = raw.split(',').map((x) => Number(x.trim())).filter((n) => Number.isFinite(n) && n >= 0)
  return list.length ? list : dflt
}

// 사진 서버 이름 목록(쉼표, 앞의 *. 는 지움). 'none' 이면 빈 목록(사진을 받지 않음).
function envHosts(name, dflt) {
  const raw = String(process.env[name] || '').trim().toLowerCase()
  if (!raw) return dflt
  if (raw === 'none') return []
  const list = raw.split(',').map((x) => x.trim().replace(/^\*?\./, '')).filter((h) => /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(h))
  return list.length ? list : dflt
}

// 카카오 status 목록(음수). 'none' 이면 빈 목록.
function envStatusList(name, dflt) {
  const raw = String(process.env[name] || '').trim()
  if (!raw) return dflt
  if (raw.toLowerCase() === 'none') return []
  const list = raw.split(',').map((x) => Number(x.trim())).filter((n) => Number.isInteger(n) && n < 0)
  return list.length ? list : dflt
}

export function poolOptions(over) {
  return Object.assign({
    joinGapMs: envNum('BOT_JOIN_GAP_MS', 45000),
    permPollMs: envNum('BOT_PERM_POLL_MS', 60000),
    activeCheckMs: envNum('BOT_ACTIVE_CHECK_MS', 600000),
    joinPerHour: envNum('BOT_JOIN_PER_HOUR', 20),
    joinPerDay: envNum('BOT_JOIN_PER_DAY', 80),
    resolvePerMin: envNum('BOT_RESOLVE_PER_MIN', 10),
    resolvePerDay: envNum('BOT_RESOLVE_PER_DAY', 300),
    // 속도 제한(-312·-805·-819) 뒤 다시 시도까지 [1번째, 2번째, 3번째 이후](5.3 6)
    rateWaits: envList('BOT_RATE_WAIT_MS', [10 * MIN, 30 * MIN, 2 * HOUR]),
    // 서버 IP 차단(-444) 뒤 모든 입장·조회 정지 [연속 1, 2, 3번 이상]
    ipWaits: envList('BOT_IP_WAIT_MS', [30 * MIN, 2 * HOUR, 6 * HOUR]),
    reconcileMs: envNum('BOT_RECONCILE_MS', 5 * MIN),
    pushDelayMs: envNum('BOT_PERM_PUSH_DELAY_MS', 3000),
    packetTimeoutMs: envNum('BOT_PACKET_TIMEOUT_MS', 20000),
    transientWaitMs: envNum('BOT_TRANSIENT_WAIT_MS', 2 * MIN),
    hideGapMs: envNum('BOT_HIDE_GAP_MS', 300),
    // 오픈프로필(D12): 봇이 가진 오픈프로필 목록을 다시 읽는 주기(접속할 때마다·푸시·관리자 요청 때도 읽는다)
    profileReadMs: envNum('BOT_PROFILE_READ_MS', 6 * HOUR),
    // 푸시·입장 대기 때문에 다시 읽을 때의 최소 간격, 푸시 뒤 기다림
    profileReadGapMs: envNum('BOT_PROFILE_READ_GAP_MS', MIN),
    profilePushDelayMs: envNum('BOT_PROFILE_PUSH_DELAY_MS', 5000),
    // 기본 프로필로 들어가 있는 방을 오픈프로필로 바꾸기(UPLINKPROF). off = 관리자가 방마다 누를 때만, auto = 점검 때 자동
    profileConvert: String(process.env.BOT_PROFILE_CONVERT || '').trim().toLowerCase() === 'auto' ? 'auto' : 'off',
    switchPerHour: envNum('BOT_PROFILE_SWITCH_PER_HOUR', 6),
    // 바꾸기가 거절된 방을 자동으로 다시 바꿔 보기까지(관리자 버튼은 바로 다시 보낸다)
    profileRetryMs: envNum('BOT_PROFILE_RETRY_MS', DAY),
    // 오픈프로필 입장(ptp 16)을 카카오가 거절했다고 보는 status(실측 전 가정 -804, 10.1 #9). 'none' = 없음
    profileBlockStatus: envStatusList('BOT_PROFILE_BLOCK_STATUS', [-804]),
    // 방 멤버 명부(옾링)를 GETMEM 으로 다시 읽는 주기, 옾링(INFOLINK) 20개 묶음 사이 쉼
    memberSyncMs: envNum('BOT_MEMBER_SYNC_MS', 10 * MIN),
    linkGapMs: envNum('BOT_LINK_GAP_MS', 300),
    memberGapMs: envNum('BOT_MEMBER_GAP_MS', 500),
    // 명부 일 하나(동기화·채우기·다시 읽기)를 기다리는 최대 시간. 넘기면 명부 줄은 다음 일로 넘어간다
    memberJobMs: envNum('BOT_MEMBER_JOB_MS', 2 * MIN),
    // 사진 1장 올리기(SHIP → 업로드 → COMPLETE)를 기다리는 최대 시간. 넘기면 글로 대신 보낸다
    photoTimeoutMs: envNum('BOT_PHOTO_TIMEOUT_MS', 25000),
    // room_state 한 번 읽기를 기다리는 최대 시간. 넘기면 읽기 실패로 보고 늦춰 가며 다시 읽는다(멈춘 읽기가 방을 붙잡지 않게)
    loadTimeoutMs: envNum('BOT_LOAD_TIMEOUT_MS', 10000),
    // 기록 카드 동그라미의 프로필 사진(avatar.mjs): 받기를 기다리는 최대 시간 · 최대 크기 · 받을 사진 서버(끝이 같은 이름, none = 받지 않음).
    // avatarFetch 는 시험이 넣는 가짜 fetch(null = 진짜 fetch)
    avatarTimeoutMs: envNum('BOT_AVATAR_TIMEOUT_MS', 3000),
    avatarMaxBytes: envNum('BOT_AVATAR_MAX_BYTES', 1.5 * 1024 * 1024),
    avatarHosts: envHosts('BOT_AVATAR_HOSTS', AVATAR_HOSTS),
    avatarFetch: null,
    flushMs: 5000,
    tickMs: 1000,
    reconnectGapMs: 2000,
    trace: process.env.SENDER_TRACE_PUSH === '1',
  }, over || {})
}

// ── 오픈프로필(D12) ─────────────────────────────────────────────────────────
// 봇은 고객 방에 카카오톡 기본 프로필이 아니라 그 계정의 오픈프로필(ptp 16, pli = 오픈프로필 링크 id)로 들어간다.
// SYNCLINK {ltk:0} 는 계정이 가진 오픈링크 전체다. 그중 lt 1(프로필형)이고 오픈프로필 표지(op)가 있거나
// 주소가 open.kakao.com/me/ 인 것만 오픈프로필이다. lt 2(이 계정이 만든 방)와 1:1 오픈채팅 링크(/o/)는 뺀다.
export const OPEN_PROFILE = 16

export function cleanName(s, max) {
  return String(s == null ? '' : s).replace(/[\r\n\t]+/g, ' ').trim().slice(0, max || 40)
}

export function ownOpenProfiles(ols, userId) {
  const out = []
  for (const ol of Array.isArray(ols) ? ols : []) {
    if (!ol || typeof ol !== 'object' || Number(ol.lt) !== 1) continue
    const lu = typeof ol.lu === 'string' ? ol.lu.trim() : ''
    const isProfile = (!!ol.op && typeof ol.op === 'object') || /^https:\/\/open\.kakao\.com\/me\//i.test(lu)
    if (!isProfile) continue
    const li = R.idText(ol.li)
    if (!li || out.some((p) => p.li === li)) continue
    const olu = ol.olu && typeof ol.olu === 'object' ? ol.olu : {}
    const owner = R.idText(olu.userId)
    if (owner && userId && owner !== String(userId)) continue
    out.push({ li, name: cleanName(olu.nn) || cleanName(ol.ln), url: /^https:\/\/open\.kakao\.com\//i.test(lu) ? lu.slice(0, 200) : '' })
  }
  return out
}

// DB(bot_accounts.open_profiles)·관리자 입력에서 온 목록 → [{li,name,url,src?}] | null
export function profileList(v) {
  let x = v
  if (typeof x === 'string') {
    try { x = JSON.parse(x) } catch { return null }
  }
  if (!Array.isArray(x)) return null
  const out = []
  for (const p of x) {
    const li = R.idText(p && p.li)
    if (!li || out.some((q) => q.li === li)) continue
    const row = { li, name: cleanName(p.name), url: typeof p.url === 'string' && /^https:\/\/open\.kakao\.com\//i.test(p.url) ? p.url.slice(0, 200) : '' }
    if (p.src === 'url') row.src = 'url'
    out.push(row)
  }
  return out
}

// 트레이스(SENDER_TRACE_PUSH=1, 10.1): Long 은 글자로, 참여코드·토큰은 가린다.
const TRACE_KEYS_HIDDEN = new Set(['pc', 'tk', 'passcode', 'token', 'access_token'])
function traceValue(v, depth) {
  if (v == null) return v
  if (typeof v === 'bigint') return v.toString()
  if (Long.isLong(v)) return v.toString()
  if (Buffer.isBuffer(v)) return `<${v.length} bytes>`
  if (typeof v === 'string') return v.length > 200 ? v.slice(0, 200) + '…' : v
  if (typeof v !== 'object') return v
  if (depth > 5) return '…'
  if (Array.isArray(v)) return v.slice(0, 30).map((x) => traceValue(x, depth + 1))
  const o = {}
  for (const [k, x] of Object.entries(v)) o[k] = TRACE_KEYS_HIDDEN.has(k) ? '<hidden>' : traceValue(x, depth + 1)
  return o
}

// 보이스룸 신호만: MSG type 52(vr_invite·vr_bye), 그리고 보이스룸 방 메타(CHGMETA).
// 메타 type 번호는 카카오가 11/12(node-kakao) 또는 다른 값으로 줄 수 있어 번호로 거르지 않는다.
// content 안에 liveon·csIP·callId·count 가 들어 있으면 보이스룸 메타다. 다른 글은 남기지 않는다.
let voiceWin = 0, voiceN = 0
function isVoiceMeta(meta) {
  if (!meta) return false
  const c = String(meta.content || '')
  return /"liveon"|"csIP"|"callId"|"startTime"|"count"/.test(c)
}
function voiceTraceOk(packet) {
  const b = packet.body || {}
  const voice = (packet.method === 'MSG' && b.chatLog && Number(b.chatLog.type) === 52) ||
    (packet.method === 'CHGMETA' && isVoiceMeta(b.meta))
  if (!voice) return false
  const now = Date.now()
  if (now - voiceWin > 60000) { voiceWin = now; voiceN = 0 }
  return ++voiceN <= 20
}

// 보이스룸 신호는 자르지 않는다(meta.content 의 url 이 200자를 넘는다).
function voiceText(b) {
  const head = { chatId: R.idText(b.chatId), li: R.idText(b.li) }
  if (b.meta) return JSON.stringify({ ...head, metaType: Number(b.meta.type), authorId: R.idText(b.meta.authorId) }) + ' content ' + String(b.meta.content || '')
  const l = b.chatLog || {}
  return JSON.stringify({ ...head, authorId: R.idText(l.authorId), author: b.authorNickname || '' }) + ' message ' + String(l.message || '')
}

export function traceText(v) {
  const s = JSON.stringify(traceValue(v, 0))
  return s && s.length > 4000 ? s.slice(0, 4000) + '…' : s
}

// 이 방법의 응답 모양을 남긴다(오픈프로필 실측). CHATONROOM 은 olu, INFOLINK 는 ols[0] 만.
const TRACE_METHODS = new Set(['SYNCLINK', 'JOININFO', 'CHECKJOIN', 'JOINLINK', 'UPLINKPROF', 'CHATONROOM', 'INFOLINK'])
const TRACE_NOISY = new Set(['CHATONROOM', 'INFOLINK'])

function log(id, msg) {
  process.stderr.write(`[sender] ${id} ${msg}\n`)
}

function errText(e) {
  return e && e.message ? e.message : String(e)
}

function L(v) {
  return Long.fromString(String(v))
}

function jitter(ms, frac) {
  const f = frac == null ? 0.2 : frac
  return Math.max(0, Math.round(ms * (1 - f + Math.random() * 2 * f)))
}

function atMs(v) {
  const n = Number(v && typeof v === 'object' && typeof v.toNumber === 'function' ? v.toNumber() : v)
  if (!Number.isFinite(n) || n <= 0) return 0
  return n < 1e12 ? Math.round(n * 1000) : Math.round(n)
}

function withTimeout(p, ms) {
  if (!ms) return p
  let t
  return Promise.race([
    p.finally(() => clearTimeout(t)),
    new Promise((_, reject) => {
      t = setTimeout(() => reject(Object.assign(new Error('packet timeout'), { timeout: true })), ms)
      if (t.unref) t.unref()
    }),
  ])
}

function credsOf(record) {
  const c = (record && record.credentials) || {}
  return {
    access_token: String(c.access_token || ''),
    refresh_token: String(c.refresh_token || ''),
    user_id: String(c.user_id || ''),
    device_uuid: String(c.device_uuid || ''),
    device_type: c.device_type === 'pc' ? 'pc' : 'tablet',
  }
}

function productsOf(row) {
  return { roombot: !!row.roombot, minigame: !!row.minigame }
}

// ── 풀 ────────────────────────────────────────────────────────────────────
export class BotPool {
  constructor(deps) {
    const d = deps || {}
    this.store = d.store
    this.newClient = d.newClient
    this.refreshToken = d.refreshToken || null
    this.opts = poolOptions(d.opts)
    this.now = d.now || (() => Date.now())
    this.bots = new Map()
    this.joinPausedUntil = 0
    this.ipStreak = 0
    this.hideJobs = new Map()
    this.jobSeq = 0
    this.syncing = null
    this.syncAgain = false
    this.timers = []
    this.traced = new Set()
    // 배포 겹침 울타리(owner.mjs). 주지 않으면 늘 주인이다(시험).
    this.owner = d.owner || new Owner(null)
    // 기록 카드의 프로필 사진(봇 모두가 같이 쓰는 기억)
    this.avatars = new Avatars({
      fetch: this.opts.avatarFetch, hosts: this.opts.avatarHosts, timeoutMs: this.opts.avatarTimeoutMs, maxBytes: this.opts.avatarMaxBytes,
      now: this.now, log: (line) => log('pool', line),
    })
  }

  start() {
    if (this.timers.length) return
    const every = (ms, fn) => {
      const t = setInterval(() => { fn().catch((e) => log('pool', errText(e))) }, ms)
      if (t.unref) t.unref()
      this.timers.push(t)
    }
    every(this.opts.reconcileMs, () => this.reconcile(null, { periodic: true }))
    every(this.opts.flushMs, () => this.flush())
  }

  async stop() {
    for (const t of this.timers) clearInterval(t)
    this.timers = []
    for (const s of this.bots.values()) await s.stop()
    await this.flush()
  }

  // 새 서버가 주인이 되었다(Hub.standDown): 봇 연결을 닫는다. 저장된 로그인은 그대로 둔다.
  async standDown() {
    for (const t of this.timers) clearInterval(t)
    this.timers = []
    const slots = [...this.bots.values()]
    this.bots.clear()
    for (const s of slots) await s.stop()
  }

  isBot(id) {
    return R.isBotId(id)
  }

  async attach(id, record) {
    let slot = this.bots.get(id)
    const c = credsOf(record)
    if (slot && !slot.dead && credsOf(slot.record).access_token === c.access_token && credsOf(slot.record).device_uuid === c.device_uuid) {
      slot.record = record
      if (this.store.saveRecord) await this.store.saveRecord(id, record)
      return slot
    }
    if (slot) await slot.stop()
    slot = new BotSlot(this, id, record)
    this.bots.set(id, slot)
    await slot.start()
    return slot
  }

  async detach(id) {
    const slot = this.bots.get(id)
    if (!slot) return
    await slot.stop()
    this.bots.delete(id)
  }

  status(id) {
    const slot = this.bots.get(id)
    if (!slot) return { linked: false, needs_register: false, reason: 'absent', connected: false }
    return {
      linked: !slot.record.needs_register,
      needs_register: !!slot.record.needs_register,
      reason: slot.record.reason || (slot.record.needs_register ? 'reauth' : 'ok'),
      connected: slot.live(),
      notices: [],
    }
  }

  viewOf(installId) {
    const id = Number(installId)
    for (const s of this.bots.values()) {
      const v = s.byInstall.get(id)
      if (v) return { slot: s, view: v }
    }
    return null
  }

  slotOf(botId) {
    return this.bots.get(botId) || null
  }

  // 보이스룸 실험(A층): 한 방에 liveon 신호만 보내 본다. SENDER_VOICE_EXPERIMENT 전용.
  // 방은 install_id · chat_id · li(오픈링크) 중 아무 것으로나 고른다(캡처 로그의 값 그대로 써도 됨).
  voiceFind(sel) {
    const s = sel || {}
    if (s.install_id != null && s.install_id !== '') return this.viewOf(s.install_id)
    const chat = s.chat_id != null ? String(s.chat_id) : ''
    const li = s.li != null ? String(s.li) : ''
    if (!chat && !li) return null
    for (const slot of this.bots.values()) {
      for (const v of slot.byInstall.values()) {
        if (chat && String(v.chat_id) === chat) return { slot, view: v }
        if (li && String(v.link_id) === li) return { slot, view: v }
      }
    }
    return null
  }

  async voiceExperiment(sel, on) {
    const got = this.voiceFind(sel)
    if (!got || !got.slot) return { ok: false, error: 'not_joined' }
    return got.slot.voiceSetMeta(got.view, on)
  }

  // 보이스룸 봇(패널·관리자 HTTP): 방 하나의 보이스룸을 켜고(op 'on')·끄고(op 'off')·본다(op 'status').
  async voiceCmd(sel, op, o) {
    const got = this.voiceFind(sel)
    if (!got || !got.slot) return { ok: false, error: 'not_joined' }
    return got.slot.voiceCmd(got.view, op, o || {})
  }

  // 이 서버의 봇들이 지금 들고 있는 보이스룸 전부(한 계정 여러 방을 한눈에 본다)
  voiceList() {
    const rows = []
    for (const slot of this.bots.values()) rows.push(...slot.voiceRows())
    rows.sort((a, b) => a.start_at - b.start_at)
    return { ok: true, max: VR.maxRooms(process.env), count: rows.length, rooms: rows }
  }

  // 서버 IP 차단(-444): 봇을 내리지 않고 모든 봇의 입장·조회를 멈춘다(5.3 6).
  ipBlocked(now) {
    const wait = this.opts.ipWaits[Math.min(this.ipStreak, this.opts.ipWaits.length - 1)]
    this.ipStreak += 1
    this.joinPausedUntil = Math.max(this.joinPausedUntil, now + wait)
    log('pool', `kakao blocked the server IP for joins, paused until ${new Date(this.joinPausedUntil).toISOString()}`)
    return this.joinPausedUntil
  }

  joinOk() {
    this.ipStreak = 0
  }

  // 설치·나가기 대기열을 DB 에서 다시 읽어 반영한다(부팅·/v1/bot/sync·5분마다, 5.2). 겹치는 호출은 하나로 모은다.
  async reconcile(installId, opt) {
    if (this.syncing) {
      this.syncAgain = true
      if (opt && opt.periodic) this.syncPeriodic = true
      return this.syncing
    }
    this.syncing = (async () => {
      let periodic = !!(opt && opt.periodic)
      do {
        this.syncAgain = false
        await this.reconcileOnce(periodic || this.syncPeriodic)
        this.syncPeriodic = false
        periodic = false
      } while (this.syncAgain)
    })().finally(() => { this.syncing = null })
    return this.syncing
  }

  async reconcileOnce(periodic) {
    const slots = [...this.bots.values()].filter((s) => !s.dead && !s.stopped)
    const ids = slots.map((s) => s.id)
    if (!ids.length) return
    const rows = await this.store.listInstalls(ids)
    const leaves = await this.store.listLeaves(ids)
    // 관리자가 고른 오픈프로필(bot_accounts.open_profile_pick, 부모 칸)을 함께 읽는다
    const profs = new Map()
    if (this.store.botProfileRows) {
      try {
        for (const p of await this.store.botProfileRows(ids)) profs.set(p.device_id, p)
      } catch (e) {
        log('pool', `open profile rows read failed: ${errText(e)}`)
      }
    }
    for (const s of slots) {
      try {
        if (profs.has(s.id)) await s.syncProfileRow(profs.get(s.id))
        await s.apply(rows.filter((r) => r.bot_device_id === s.id), leaves.filter((l) => l.bot_device_id === s.id))
        if (periodic && s.live()) await this.store.botState(s.id, { state: 'connected', nickname: s.nickname || undefined })
      } catch (e) {
        log(s.id, `reconcile failed: ${errText(e)}`)
      }
    }
  }

  // 봇·방마다 따로 저장한다(한 방의 느린 저장이 다른 방을 막지 않게 — 멈출 때 정해진 시간 안에 끝나도록)
  async flush() {
    await Promise.allSettled([...this.bots.values()].map((s) => s.flush()))
  }

  // 멈출 때의 마지막 저장(index.mjs). 먼저 새 메시지·점검을 받지 않게 한다 — 저장을 시작한 뒤에 처리한 결과(강화 등)는
  // 방에만 보이고 다음 시작 때 되돌아간다. 이미 대기열에 있는 답은 그대로 보낸다(그 결과는 이미 runtime 에 있다).
  // 진행 중인 저장은 flushView 가 기다린다. 처리 중이던 메시지가 그 사이 바꾼 것은 한 번 더 저장한다.
  async finalFlush() {
    for (const t of this.timers) clearInterval(t)
    this.timers = []
    const slots = [...this.bots.values()]
    for (const s of slots) s.close()
    await this.flush()
    await Promise.allSettled(slots.flatMap((s) => [s.chain, s.checks]))
    await this.flush()
  }

  // ── /v1/bot/resolve ─────────────────────────────────────────────────────
  // 조회는 맡은 방이 가장 적은 연결된 봇이 한다. 예산이 없으면 budget, 봇이 없으면 no_bot.
  async resolve(url) {
    const now = this.now()
    const live = [...this.bots.values()].filter((s) => s.live())
    if (!live.length) return { ok: false, error: 'no_bot' }
    if (this.joinPausedUntil > now) return { ok: false, error: 'budget' }
    const cands = live.filter((s) => s.resolveM.ok(now) && s.resolveD.ok(now)).sort((a, b) => a.load() - b.load())
    if (!cands.length) return { ok: false, error: 'budget' }
    const s = cands[0]
    s.resolveM.add(now)
    s.resolveD.add(now)
    const r = await s.raw('JOININFO', { lu: String(url), ref: 'EW' })
    const st = R.locoStatus(r)
    if (r && r.noSession) return { ok: false, error: 'no_bot' }
    if (GONE_STATUS.has(st)) return { ok: false, error: 'not_found', status: st }
    if (st === -444) {
      this.ipBlocked(now)
      return { ok: false, error: 'budget' }
    }
    if (st !== 0) return { ok: false, error: 'kakao_error', status: st }
    const ol = r.body && r.body.ol
    if (!ol || typeof ol !== 'object') return { ok: false, error: 'kakao_error', status: 0 }
    // 2(그룹방)가 아닌 종류는 로그에 남긴다(커뮤니티 방 등이 실제로 어떤 값을 보내는지 보려고)
    if (Number(ol.lt) !== 2) {
      log('pool', `resolve JOININFO link type ${ol.lt} ${R.groupLinkType(ol.lt) ? 'treated as a group room' : '-> not_group'} ` +
        `(keys ${Object.keys(ol).join(',')}, pv ${ol.pv}): ${typeof ol.ln === 'string' ? ol.ln.slice(0, 40) : ''}`)
    }
    if (!R.groupLinkType(ol.lt)) return { ok: false, error: 'not_group' }
    const li = R.idText(ol.li)
    if (!li) return { ok: false, error: 'kakao_error', status: 0 }
    const pv = Number(ol.pv) || 0
    const maxUsers = ol.ml != null ? Number(ol.ml) : (ol.mu != null ? Number(ol.mu) : null)
    return {
      ok: true,
      link_id: li,
      name: typeof ol.ln === 'string' ? ol.ln : '',
      url: typeof ol.lu === 'string' && ol.lu ? ol.lu : String(url),
      type: Number(ol.lt),
      needs_passcode: (pv & 64) !== 0,
      profile_only: (pv & 32) === 0,
      max_users: Number.isFinite(maxUsers) ? maxUsers : null,
    }
  }

  // ── /v1/bot/status ──────────────────────────────────────────────────────
  botStatus() {
    const now = this.now()
    const bots = []
    const rooms = []
    for (const s of this.bots.values()) {
      const counts = { open: 0, main: 0, other: 0, failed: 0, unknown: 0 }
      for (const v of s.byInstall.values()) {
        if (!v.chat_id || v.state === 'error') continue
        counts[s.roomProfile(v)] += 1
      }
      bots.push({
        device_id: s.id,
        connected: s.live(),
        nickname: s.nickname || null,
        rooms: s.load(),
        budget: {
          join_h: Math.max(0, s.joinH.max - s.joinH.count(now)),
          join_d: Math.max(0, s.joinD.max - s.joinD.count(now)),
          resolve_m: Math.max(0, s.resolveM.max - s.resolveM.count(now)),
          switch_h: Math.max(0, s.switchH.max - s.switchH.count(now)),
        },
        open_profile: s.openProfile ? Object.assign({}, s.openProfile) : null,
        open_profile_state: s.profileState,
        open_profiles: s.openProfiles ? s.openProfiles.map((p) => Object.assign({}, p)) : null,
        open_profile_read_at: s.profileReadAt || null,
        profile_rooms: counts,
        profile_convert: this.opts.profileConvert,
      })
      for (const v of s.byInstall.values()) {
        rooms.push({
          install_id: v.install_id, connected: s.live(), perm: v.perm == null ? null : v.perm, state: v.state,
          profile: v.chat_id && v.state !== 'error' ? s.roomProfile(v) : null,
        })
      }
      for (const id of s.joinQ.keys()) {
        if (!s.byInstall.has(id)) rooms.push({ install_id: id, connected: s.live(), perm: null, state: 'joining', profile: null })
      }
    }
    return { ok: true, bots, rooms, join_paused_until: this.joinPausedUntil > now ? this.joinPausedUntil : 0 }
  }

  // ── /v1/bot/open-profile ────────────────────────────────────────────────
  // 관리자 요청: 고른 오픈프로필을 DB 에서 다시 읽고(open_profile_pick), refresh 면 SYNCLINK 를 바로 다시 보낸다.
  // url(open.kakao.com/me/…) 이면 SYNCLINK 가 오픈프로필을 보여 주지 않을 때의 대안: JOININFO 로 확인해 목록에 더한다.
  async openProfileCmd(botId, body) {
    const s = this.bots.get(String(botId || ''))
    if (!s || s.dead || s.stopped) return { ok: false, error: 'not_connected' }
    const b = body || {}
    let read = null
    if (this.store.botProfileRows) {
      try {
        const rows = await this.store.botProfileRows([s.id])
        if (rows[0]) await s.syncProfileRow(rows[0])
      } catch (e) {
        log(s.id, `open profile row read failed: ${errText(e)}`)
      }
    }
    if (b.url) {
      const r = await s.addProfileByUrl(String(b.url))
      if (!r.ok) return r
    } else if (b.refresh) {
      if (!s.live()) return { ok: false, error: 'not_connected' }
      read = await s.readOpenProfiles('admin', true)
    }
    // read_ok·read_status: 이번 요청의 SYNCLINK 결과(다시 읽기만). 실패하면 남긴 목록을 그대로 쓰므로 판정만으로는 실패를 알 수 없다.
    return {
      ok: true,
      read_ok: read && typeof read.ok === 'boolean' ? read.ok : null,
      read_status: read && read.ok === false ? read.status : null,
      ...s.profileView(),
    }
  }

  // ── /v1/bot/room-profile ────────────────────────────────────────────────
  // how 'switch' = UPLINKPROF 로 프로필만 바꾼다(나가지 않음). 'rejoin' = 나갔다가 오픈프로필로 다시 입장(부방장 다시 지정 필요).
  async roomProfileCmd(installId, how) {
    const got = this.viewOf(installId)
    if (!got) return { ok: false, error: 'not_joined' }
    const err = got.slot.queueSwitch(got.view, how === 'rejoin' ? 'rejoin' : 'switch', true)
    if (err) return { ok: false, error: err }
    return { ok: true, queued: how === 'rejoin' ? 'rejoin' : 'switch' }
  }

  // 뷰가 없으면(아직 입장 전·오류) DB 행과 room_state 로 읽기 전용 뷰를 만든다.
  async viewOrRow(installId) {
    const got = this.viewOf(installId)
    if (got) return got
    const row = await this.store.getInstall(installId)
    if (!row || row.phase !== 'installed') return null
    const runtime = (await this.store.loadRoomState(row.id)) || {}
    return {
      slot: null,
      view: {
        install_id: Number(row.id), chat_id: row.chat_id || '', link_id: row.link_id || '', link_name: row.link_name || '',
        products: productsOf(row), perm: row.perm, state: row.state, cfg: R.normRoomConfig(row.config), runtime, ring: [],
      },
      row,
    }
  }

  // ── /v1/bot/room ────────────────────────────────────────────────────────
  async room(installId) {
    const got = await this.viewOrRow(installId)
    if (!got) return { ok: true, live: null, ranking: [] }
    const v = got.view
    const live = { connected: !!(got.slot && got.slot.live() && v.chat_id && v.state !== 'error'), perm: v.perm == null ? null : Number(v.perm) }
    if (got.slot && v.chat_id && v.state !== 'error') live.profile = got.slot.roomProfileView(v)
    return {
      ok: true,
      live,
      ranking: v.products.minigame ? R.rankingOf(v.runtime, 10) : [],
    }
  }

  // ── /v1/bot/logs ────────────────────────────────────────────────────────
  async logs(installId) {
    const got = await this.viewOrRow(installId)
    if (!got || !got.view.products.roombot) return { ok: true, visit: [], profile: [], guard: [] }
    const rec = R.adapterRecord(got.view, got.slot ? got.slot.id : '')
    return Object.assign({ ok: true }, logsView(rec))
  }

  // 방 관리 경로 공통 게이트(3.4.3): 방 관리봇 상품 없음 → no_roombot, 사용 중 아님 → not_active.
  async gate(installId) {
    const got = await this.viewOrRow(installId)
    if (!got) return { error: 'not_active' }
    if (!got.view.products.roombot) return { error: 'no_roombot' }
    if (!got.slot || !R.roombotLive(got.view)) return { error: 'not_active' }
    return got
  }

  // ── /v1/bot/people ──────────────────────────────────────────────────────
  async people(installId) {
    const g = await this.gate(installId)
    if (g.error) return { ok: false, error: g.error }
    return { ok: true, people: g.slot.peopleOf(g.view) }
  }

  // ── /v1/bot/hide ────────────────────────────────────────────────────────
  async hide(installId, body) {
    const g = await this.gate(installId)
    if (g.error) return { ok: false, error: g.error }
    const b = body || {}
    let req
    if (b.user_id != null && b.user_id !== '') {
      const uid = String(b.user_id).trim()
      if (!/^[1-9][0-9]{0,19}$/.test(uid)) return { ok: false, error: 'bad_request' }
      req = { userId: uid }
    } else {
      const n = Number(b.last)
      if (!Number.isInteger(n) || n < 1 || n > R.RING_MAX) return { ok: false, error: 'bad_request' }
      req = { last: n }
    }
    const by = b.by === 'panel' || !b.by ? 'panel' : String(b.by)
    return g.slot.startHide(g.view, req, by)
  }

  hideStatus(jobId, installId) {
    const job = this.hideJobs.get(String(jobId || ''))
    if (!job || (installId != null && installId !== '' && Number(installId) !== job.install_id)) return { ok: false, error: 'not_found' }
    return { ok: true, state: job.state, total: job.total, done: job.done, failed: job.failed }
  }

  // ── /v1/bot/unkick ──────────────────────────────────────────────────────
  async unkick(installId, userId) {
    const g = await this.gate(installId)
    if (g.error) return { ok: false, error: g.error }
    return g.slot.unkickUser(g.view, String(userId || ''))
  }

  // ── /v1/bot/games-reset ─────────────────────────────────────────────────
  async gamesReset(installId) {
    const got = await this.viewOrRow(installId)
    if (!got) return { ok: true }
    // 저장된 기록을 아직 못 읽은 방(loadFailed): 지금 runtime 은 저장되지 않는 임시본이라 지워도 남는다
    if (got.view.loadFailed) return { ok: false, error: 'busy' }
    const rt = got.view.runtime
    if (rt.scores) rt.scores.r = {}
    if (rt.names) rt.names.r = {}
    if (rt.games) delete rt.games.r
    // 검 강화(sword.mjs, 방 열쇠 r) 기록도 지운다(docs/ACCOUNTS_V1.md 7.3.3). mon 은 없앤 몬스터 수집의 예전 기록
    if (rt.sword) delete rt.sword.r
    delete rt.mon
    if (got.slot) got.view.dirty = true
    else await this.store.saveRoomState(got.view.install_id, rt)
    return { ok: true }
  }
}

// ── 봇 슬롯 ─────────────────────────────────────────────────────────────────
export class BotSlot {
  constructor(pool, id, record) {
    this.pool = pool
    this.store = pool.store
    this.opts = pool.opts
    this.id = id
    this.record = record
    this.client = null
    this.unpush = null
    this.unsession = null
    this.stopped = false
    this.dead = false
    this.nickname = ''
    this.userId = credsOf(record).user_id
    this.views = new Map()        // chat_id → BotRoom
    this.byInstall = new Map()    // install_id → BotRoom
    this.joinQ = new Map()        // install_id → {notBefore}
    this.leaveQ = []
    this.leaveTries = new Map()
    this.nextJoinAt = 0
    this.pumping = false
    this.pumpAgain = false
    this.pumpTimer = null
    this.pumpAt = 0
    this.joinH = new R.Win(HOUR, this.opts.joinPerHour)
    this.joinD = new R.Win(DAY, this.opts.joinPerDay)
    this.resolveM = new R.Win(MIN, this.opts.resolvePerMin)
    this.resolveD = new R.Win(DAY, this.opts.resolvePerDay)
    this.limits = R.botLimits()
    this.pacer = new R.Pacer()
    this.sending = false
    this.photoBusy = new Set()   // 사진을 올리는 중인 방(pacer 열쇠 = install id)
    this.photoLate = new Map()   // 기다림을 넘겼지만 아직 끝나지 않은 사진 올리기: pacer 열쇠 → 수(holdLate)
    this.photoLateN = 0
    this.sendTimer = null
    this.sendAt = 0
    this.ownKicks = new Map()
    this.rateN = new Map()
    this.transient = new Map()
    this.chain = Promise.resolve()
    this.checks = Promise.resolve()
    this.memberQ = Promise.resolve() // 방 멤버 명부 일(동기화·채우기·다시 읽기). 방 점검(checks)과 따로 줄 선다
    this.timers = []
    this.connects = 0
    this.refreshed = false
    this.downWritten = false
    // 오픈프로필(D12)
    this.openProfiles = null      // [{li,name,url}] — null = 아직 읽은 적 없음(캐시도 없음)
    this.profilePick = null       // 관리자가 고른 오픈프로필 li(bot_accounts.open_profile_pick)
    this.linkCache = new Map()    // 사람의 pli(오픈프로필 링크 id) → 옾링 주소('' = 없음). 방이 달라도 같다
    this.emptyLinks = new Map()   // 옾링이 없다고 답한 pli → 그때(EMPTY_LINK_MS 동안 다시 묻지 않는다. 5000개 캐시와 따로)
    this.badLinks = new Map()     // 혼자서도 읽기가 실패한 pli → 그때(BAD_LINK_MS 동안 묶음 읽기에서 뺀다. 안내 전 읽기는 한다)
    this.readPauseUntil = 0       // GETMEM·MEMBER·INFOLINK 가 속도 제한(-312·-805·-819)에 걸리면 이때까지 명부를 읽지 않는다
    this.lastProfileLi = null     // 지난번에 쓰던 li(고른 것이 없을 때 같은 것을 계속 쓴다)
    this.openProfile = null       // 지금 입장에 쓰는 {li,name,url}
    this.profileState = 'unknown' // ok | none | gone | unknown
    this.profileLoaded = false
    this.profileReadAt = 0
    this.profileTryAt = 0
    this.profileReading = null
    this.profileTimer = null
    this.profileWait = new Set()  // 오픈프로필을 아직 몰라 미룬 입장
    this.switchQ = new Map()      // install_id → {notBefore, how:'switch'|'rejoin', manual}
    this.switchH = new R.Win(HOUR, Math.max(1, Number(this.opts.switchPerHour) || 0))
    this.rejoinIds = new Set()    // 다시 입장(나간 직후): 사전 확인 없이 JOINLINK
    this.traceN = new Map()
  }

  now() {
    return this.pool.now()
  }

  // 방에 보일 이름: 오픈프로필 이름(없으면 카카오톡 닉네임)
  roomName() {
    return (this.openProfile && this.openProfile.name) || this.nickname || ''
  }

  live() {
    return !this.stopped && !this.dead && !this.record.needs_register && !!this.client && this.client.isConnected()
  }

  load() {
    let n = this.byInstall.size
    for (const id of this.joinQ.keys()) if (!this.byInstall.has(id)) n++
    return n
  }

  enqueue(fn) {
    const run = this.chain.then(fn, fn)
    this.chain = run.then(() => {}, () => {})
    return run
  }

  bg(p, what) {
    Promise.resolve(p).catch((e) => log(this.id, `${what || 'task'} failed: ${errText(e)}`))
  }

  async start() {
    if (this.store.saveRecord) await this.store.saveRecord(this.id, this.record)
    const every = (ms, fn) => {
      const t = setInterval(fn, ms)
      if (t.unref) t.unref()
      this.timers.push(t)
    }
    every(20000, () => this.bg(this.ensure(), 'ensure'))
    every(this.opts.tickMs, () => this.tick())
    await this.ensure()
  }

  // 멈추기 직전(BotPool.finalFlush): 새 푸시(메시지·입장)·점검·입장 작업을 받지 않는다. 연결과 보내기는 그대로 둔다
  close() {
    this.closing = true
    for (const t of this.timers) clearInterval(t)
    this.timers = []
    if (this.pumpTimer) clearTimeout(this.pumpTimer)
    this.pumpTimer = null
    for (const v of this.byInstall.values()) {
      if (v.saveTimer) clearTimeout(v.saveTimer)
      v.saveTimer = null
    }
  }

  async stop() {
    this.stopped = true
    for (const t of this.timers) clearInterval(t)
    this.timers = []
    if (this.pumpTimer) clearTimeout(this.pumpTimer)
    if (this.sendTimer) clearTimeout(this.sendTimer)
    if (this.profileTimer) clearTimeout(this.profileTimer)
    this.pumpTimer = null
    this.sendTimer = null
    this.profileTimer = null
    for (const v of this.byInstall.values()) {
      if (v.saveTimer) clearTimeout(v.saveTimer)
      v.saveTimer = null
    }
    await this.flush()
    try { this.unpush && this.unpush() } catch {}
    try { this.unsession && this.unsession() } catch {}
    try { this.client && this.client.close() } catch {}
    this.client = null
  }

  // ── 접속 ────────────────────────────────────────────────────────────────
  async ensure() {
    if (this.stopped || this.dead || this.record.needs_register) return
    if (this.client && this.client.isConnected()) return
    if (this.opening) return this.opening
    // 클라이언트가 있으면 새로 만들지 않고 그 클라이언트의 세션을 다시 얻는다(agent-messenger 가 끊긴 상태를 지웠으므로
    // 다음 acquireSession() 이 스스로 다시 접속한다, 5.3). 클라이언트를 닫았다 여는 일은 처음 접속 때만.
    // 새 서버가 주인이면 다시 붙지 않는다(붙으면 그쪽을 카카오에서 밀어낸다).
    this.opening = (async () => {
      if ((await this.pool.owner.check()) === 'lost') return
      if (this.stopped || this.dead) return
      return this.client ? this.reacquire() : this.open()
    })().finally(() => { this.opening = null })
    return this.opening
  }

  async reacquire() {
    try {
      await this.client.acquireSession()
      this.downWritten = false
      await this.afterConnect(false)
    } catch (e) {
      const code = e && e.code
      if (code === 'invalid_access_token' || code === 'client_closed') return this.open()
      if (DEAD_CODES.has(code)) {
        await this.markDead(code)
        return
      }
      log(this.id, `bot session reconnect failed: ${code || ''} ${errText(e)}`)
      await this.markDown()
    }
  }

  async open() {
    const creds = credsOf(this.record)
    if (!creds.access_token) {
      await this.markDead('reauth')
      return
    }
    try {
      if (this.client) {
        try { this.unpush && this.unpush() } catch {}
        try { this.unsession && this.unsession() } catch {}
        try { this.client.close() } catch {}
      }
      const client = this.pool.newClient()
      await client.login({ oauthToken: creds.access_token, userId: creds.user_id, deviceUuid: creds.device_uuid, deviceType: creds.device_type })
      this.unsession = client.onSessionEvent((ev) => this.onSession(ev))
      this.unpush = client.onPush((p) => this.onPushRaw(p))
      this.client = client
      await client.acquireSession()
      this.refreshed = false
      this.downWritten = false
      await this.afterConnect(true)
    } catch (e) {
      const code = e && e.code
      if (code === 'invalid_access_token' && !this.refreshed && this.pool.refreshToken) {
        this.refreshed = true
        try {
          const r = await this.pool.refreshToken(creds)
          this.record.credentials.access_token = r.accessToken
          this.record.credentials.refresh_token = r.refreshToken
          if (this.store.saveRecord) await this.store.saveRecord(this.id, this.record)
          return this.open()
        } catch (err) {
          log(this.id, `token refresh failed: ${err && err.code ? err.code : errText(err)}`)
        }
      }
      if (DEAD_CODES.has(code)) {
        await this.markDead(code)
        return
      }
      log(this.id, `bot session open failed: ${code || ''} ${errText(e)}`)
      await this.markDown()
    }
  }

  // 접속(또는 재접속) 직후: 닉네임을 읽고 bot_accounts 를 고치고, 맡은 방을 2초 간격으로 점검한다(5.4).
  async afterConnect(fresh) {
    this.connects += 1
    let nick = ''
    try {
      const prof = await withTimeout(this.client.getProfile(), 10000)
      nick = prof && prof.nickname ? String(prof.nickname).trim() : ''
    } catch (e) {
      log(this.id, `profile read failed: ${errText(e)}`)
    }
    if (!nick) {
      try { nick = await this.store.botNickname(this.id) } catch { nick = '' }
    }
    if (nick) this.nickname = nick
    try {
      await this.store.botState(this.id, { state: 'connected', nickname: this.nickname || undefined })
    } catch (e) {
      log(this.id, `bot_accounts update failed: ${errText(e)}`)
    }
    // 이 계정의 오픈프로필을 읽는다(SYNCLINK 1회, 실제 클라이언트도 접속 직후 보낸다). 실패하면 DB 의 지난 값을 쓴다.
    try {
      await this.readOpenProfiles('connect', this.connects === 1)
    } catch (e) {
      log(this.id, `open profile read failed: ${errText(e)}`)
    }
    const now = this.now()
    let i = 0
    for (const v of this.byInstall.values()) {
      if (!v.chat_id) continue
      v.nextCheckAt = now + this.opts.reconnectGapMs * i++
      v.checkFull = true
    }
    if (fresh || this.connects > 1) this.bg(this.pool.reconcile(null), 'reconcile')
    this.schedulePump(now)
    this.scheduleSend(now)
  }

  onSession(ev) {
    if (!ev || this.stopped) return
    if (ev.type === 'kicked') {
      // KICKOUT 사유 0(다른 기기 로그인)·1(계정 삭제)·없음일 때만 진짜 종료(5.2). -2(CHANGE_SERVER) 와 그 밖은 재접속.
      const r = ev.reason
      if (typeof r === 'number' && r !== 0 && r !== 1) {
        log(this.id, `kickout reason ${r}, reconnecting`)
        setTimeout(() => this.bg(this.ensure(), 'reconnect'), 1000).unref?.()
        return
      }
      this.bg(this.markDead('kicked'), 'markDead')
      return
    }
    if (ev.type === 'disconnected') {
      this.bg(this.markDown(), 'markDown')
      setTimeout(() => this.bg(this.ensure(), 'reconnect'), this.opts.reconnectGapMs).unref?.()
      return
    }
    if (ev.type === 'connected' && this.client && this.connects > 0 && !this.opening) {
      // 라이브러리가 스스로 다시 붙은 경우(소켓이 닫힌 뒤 다음 호출에서): 재접속 직후 점검
      this.downWritten = false
      this.bg(this.afterConnect(false), 'afterConnect')
    }
  }

  async markDown() {
    if (this.downWritten || this.dead) return
    this.downWritten = true
    try { await this.store.botState(this.id, { state: 'down' }) } catch {}
  }

  // 진짜 세션 종료(KICKOUT 0·1·없음, 토큰 무효, -997): 기록은 needs_register, 맡은 방은 bot_down(D17).
  async markDead(reason) {
    if (this.dead) return
    this.dead = true
    const why = reason || 'reauth'
    const v = await this.pool.owner.verdict(why, this)
    if (v === 'retry') {
      log(this.id, `bot session ${why} right after boot: reconnecting, saved login kept`)
      const t = setTimeout(() => {
        this.dead = false
        this.bg(this.ensure(), 'reconnect')
      }, this.pool.owner.retryMs)
      if (t.unref) t.unref()
      return
    }
    if (v === 'keep') {
      log(this.id, `bot session ${why} on a sender that is not the owner: saved login kept`)
      await this.stop()
      return
    }
    this.record.needs_register = true
    this.record.reason = why
    const c = credsOf(this.record)
    this.record.credentials = { access_token: '', refresh_token: '', user_id: c.user_id, device_uuid: '', device_type: 'tablet' }
    log(this.id, `bot session ended: ${this.record.reason}`)
    try { if (this.store.saveRecord) await this.store.saveRecord(this.id, this.record) } catch (e) { log(this.id, errText(e)) }
    try { await this.store.botState(this.id, { state: 'needs_register' }) } catch {}
    try { await this.store.markBotRooms(this.id, this.now()) } catch (e) { log(this.id, errText(e)) }
    for (const v of this.byInstall.values()) {
      if (v.state !== 'error') {
        v.state = 'error'
        v.error_code = 'bot_down'
      }
    }
    await this.stop()
  }

  // ── 오픈프로필(D12) ─────────────────────────────────────────────────────
  // 목록: SYNCLINK 로 읽어 bot_accounts.open_profiles 에 남긴다(읽기에 실패하면 남긴 값을 쓴다 — 실패를 "없음"으로 보지 않는다).
  // 고르기: 관리자가 고른 것(open_profile_pick) → 지난번에 쓰던 것 → 목록의 첫 번째. 고른 것이 목록에 없으면 gone(입장 멈춤).
  async loadProfileCache() {
    if (this.profileLoaded) return
    if (!this.store.botProfileRows) {
      this.profileLoaded = true
      return
    }
    try {
      const rows = await this.store.botProfileRows([this.id])
      this.profileLoaded = true
      if (rows && rows[0]) this.takeProfileRow(rows[0])
    } catch (e) {
      log(this.id, `open profile cache read failed: ${errText(e)}`)
    }
  }

  takeProfileRow(row) {
    if (this.openProfiles == null) {
      const list = profileList(row.open_profiles)
      if (list) this.openProfiles = list
    }
    this.profilePick = R.idText(row.open_profile_pick) || null
    if (!this.lastProfileLi) this.lastProfileLi = R.idText(row.open_profile_li) || null
  }

  // 재조정(5분)·관리자 요청 때: DB 의 고른 오픈프로필을 반영한다
  async syncProfileRow(row) {
    const wasLoaded = this.profileLoaded
    const before = this.profilePick
    if (!wasLoaded) {
      this.takeProfileRow(row || {})
      this.profileLoaded = true
    } else {
      this.profilePick = R.idText(row && row.open_profile_pick) || null
    }
    if (this.profilePick !== before || !wasLoaded) await this.applyProfile('pick')
  }

  selectProfile() {
    const list = this.openProfiles
    let prof = null
    let state
    if (list == null) state = 'unknown'
    else if (!list.length) state = 'none'
    else if (this.profilePick) {
      prof = list.find((p) => p.li === this.profilePick) || null
      state = prof ? 'ok' : 'gone'
    } else {
      const keep = (li) => (li ? list.find((p) => p.li === li) : null)
      prof = keep(this.openProfile && this.openProfile.li) || keep(this.lastProfileLi) || list[0]
      state = 'ok'
    }
    this.openProfile = prof ? Object.assign({}, prof) : null
    this.profileState = state
  }

  // 돌려주는 값 { ok, status, state }: 이번 SYNCLINK 가 됐는지(읽지 않았으면 null), 실패 status, 그 뒤의 판정
  readOpenProfiles(why, force) {
    if (this.profileReading) return this.profileReading
    const now = this.now()
    if (!this.client || (!force && now - this.profileTryAt < this.opts.profileReadGapMs)) {
      return Promise.resolve({ ok: null, status: null, state: this.profileState })
    }
    this.profileTryAt = now
    this.profileReading = (async () => {
      await this.loadProfileCache()
      const r = await this.raw('SYNCLINK', { ltk: 0 })
      const ok = R.locoOk(r)
      if (ok) {
        const found = ownOpenProfiles(r.body && r.body.ols, this.userId)
        // 링크로 직접 등록한 오픈프로필(src url)은 SYNCLINK 가 오픈프로필을 하나도 보여 주지 않을 때만 남긴다
        const manual = found.length ? [] : (this.openProfiles || []).filter((p) => p.src === 'url')
        this.openProfiles = found.concat(manual)
        this.profileReadAt = this.now()
      } else {
        log(this.id, `open profile read failed (${why}): status ${R.locoStatus(r)}${this.openProfiles ? ', keeping the saved list' : ''}`)
      }
      await this.applyProfile(why)
      return { ok, status: ok ? 0 : R.locoStatus(r), state: this.profileState }
    })().finally(() => { this.profileReading = null })
    return this.profileReading
  }

  async applyProfile(why) {
    const prevLi = this.openProfile ? this.openProfile.li : ''
    const prevName = this.openProfile ? this.openProfile.name : ''
    const prevState = this.profileState
    this.selectProfile()
    const li = this.openProfile ? this.openProfile.li : ''
    const changed = li !== prevLi || this.profileState !== prevState || (this.openProfile ? this.openProfile.name : '') !== prevName
    if (this.openProfile) this.lastProfileLi = this.openProfile.li
    if (this.store.botOpenProfile) {
      // 목록을 모르면(null) 남긴 값을 지우지 않는다. 쓰는 프로필 칸은 판정이 섰을 때만(없음·gone 이면 비운다).
      const f = { list: this.openProfiles, at: this.profileReadAt || null }
      if (this.profileState !== 'unknown') {
        f.li = li || null
        f.name = this.openProfile ? this.openProfile.name || null : null
      }
      try {
        await this.store.botOpenProfile(this.id, f)
      } catch (e) {
        log(this.id, `bot_accounts open profile update failed: ${errText(e)}`)
      }
    }
    if (changed) log(this.id, `open profile ${this.profileState}${this.openProfile ? ' ' + li + ' "' + this.openProfile.name + '"' : ''} (${why})`)
    if (this.profileState !== 'unknown' && this.profileWait.size) {
      // 오픈프로필을 몰라 미룬 입장: 판정이 섰으니 바로 다시 본다(없으면 bot_no_open_profile)
      for (const id of this.profileWait) if (this.joinQ.has(id)) this.joinQ.set(id, { notBefore: 0 })
      this.profileWait.clear()
    }
    if (changed && this.profileState === 'ok') {
      // bot_no_open_profile 로 멈춘 방을 다시 입장 줄에(apply), 기본 프로필 방은 바꾸기 대상(auto)
      this.bg(this.pool.reconcile(null), 'reconcile')
      for (const v of this.byInstall.values()) this.considerSwitch(v)
    }
    this.schedulePump(this.now())
  }

  // 이 계정의 링크가 생기거나 지워졌다는 푸시: 5초 뒤(앞 읽기에서 1분 지난 뒤) 다시 읽는다
  profilePushed(m) {
    if (this.profileTimer || this.stopped) return
    const now = this.now()
    const at = Math.max(now + this.opts.profilePushDelayMs, this.profileTryAt + this.opts.profileReadGapMs)
    this.profileTimer = setTimeout(() => {
      this.profileTimer = null
      this.bg(this.readOpenProfiles('push ' + m, true), 'open profile read')
    }, Math.max(0, at - now))
    if (this.profileTimer.unref) this.profileTimer.unref()
  }

  // SYNCLINK 가 오픈프로필을 보여 주지 않을 때의 대안: 관리자가 붙여 넣은 open.kakao.com/me/… 를 JOININFO 로 확인한다.
  // 프로필형 링크(lt 1)이고 주인이 이 봇 계정일 때만 받는다. 조회 예산을 쓴다.
  async addProfileByUrl(url) {
    const u = String(url || '').trim()
    if (!/^https:\/\/open\.kakao\.com\/me\/[A-Za-z0-9_-]+$/.test(u)) return { ok: false, error: 'bad_url' }
    if (!this.live()) return { ok: false, error: 'not_connected' }
    const now = this.now()
    if (this.pool.joinPausedUntil > now || !this.resolveM.ok(now) || !this.resolveD.ok(now)) return { ok: false, error: 'budget' }
    this.resolveM.add(now)
    this.resolveD.add(now)
    await this.loadProfileCache()
    const r = await this.raw('JOININFO', { lu: u, ref: 'EW' })
    const st = R.locoStatus(r)
    if (st !== 0) return { ok: false, error: GONE_STATUS.has(st) ? 'not_found' : 'kakao_error', status: st }
    const ol = r.body && r.body.ol
    if (!ol || typeof ol !== 'object' || Number(ol.lt) !== 1) return { ok: false, error: 'not_profile' }
    const olu = ol.olu && typeof ol.olu === 'object' ? ol.olu : {}
    if (R.idText(olu.userId) !== this.userId) return { ok: false, error: 'not_mine' }
    const li = R.idText(ol.li)
    if (!li) return { ok: false, error: 'kakao_error', status: 0 }
    const list = (this.openProfiles || []).filter((p) => p.li !== li)
    list.push({ li, name: cleanName(olu.nn) || cleanName(ol.ln), url: u, src: 'url' })
    this.openProfiles = list
    await this.applyProfile('url')
    return { ok: true }
  }

  profileView() {
    return {
      open_profile: this.openProfile ? Object.assign({}, this.openProfile) : null,
      open_profile_state: this.profileState,
      open_profiles: this.openProfiles ? this.openProfiles.map((p) => Object.assign({}, p)) : null,
    }
  }

  // ── 원시 패킷 ───────────────────────────────────────────────────────────
  // 같은 세션에 1회만 보낸다(5.3). 세션이 없거나 응답이 없으면 {statusCode:-1}. 다시 접속하지 않는다.
  async raw(method, body) {
    if (!this.client) return { statusCode: -1, body: {}, noSession: true }
    let s
    try {
      s = await this.client.acquireSession()
    } catch (e) {
      return { statusCode: -1, body: {}, noSession: true, error: errText(e) }
    }
    const conn = s && typeof s.getConnection === 'function' ? s.getConnection() : null
    if (!conn) return { statusCode: -1, body: {}, noSession: true }
    let out
    try {
      const r = await withTimeout(conn.sendPacket(method, body), this.opts.packetTimeoutMs)
      out = r || { statusCode: -1, body: {} }
    } catch (e) {
      out = { statusCode: -1, body: {}, error: errText(e), timeout: !!(e && e.timeout) }
    }
    if (this.opts.trace && TRACE_METHODS.has(method)) this.traceRaw(method, body, out)
    return out
  }

  // SENDER_TRACE_PUSH=1: 오픈프로필 실측(DEPLOY.md 체크리스트)용 응답 모양. CHATONROOM·INFOLINK 는 봇마다 처음 5번만.
  traceRaw(method, req, res) {
    const n = (this.traceN.get(method) || 0) + 1
    this.traceN.set(method, n)
    if (TRACE_NOISY.has(method) && n > 5) return
    const b = (res && res.body) || {}
    let shown = b
    if (method === 'CHATONROOM') shown = { status: b.status, olu: b.olu }
    else if (method === 'INFOLINK') shown = { status: b.status, ols0: Array.isArray(b.ols) ? b.ols[0] : undefined }
    log(this.id, `raw ${method} req ${traceText(req)} → statusCode ${res ? res.statusCode : '?'} body ${traceText(shown)}`)
  }

  // ── 보이스룸 실험(A층) ───────────────────────────────────────────────────
  // SETMETA(type 16) 로 LIVE_TALK_INFO 를 보낸다. 서버 할당(csIP/csPort/callId)과
  // 음성 미디어 세션은 아직 없다 — csIP/callId 를 임의값으로 채워, 카카오가
  //   (a) 필드 존재만 확인하는지(→ status 0, 가짜 값으로도 배너 가능) 아니면
  //   (b) callId 를 실제 할당과 대조하는지(→ 거부)
  // 를 응답 status 로 가린다. callId 는 2^53 을 넘으므로 숫자 정밀도를 잃지 않게
  // content 문자열을 직접 조립한다(JSON.stringify 금지). off 는 liveon:false 만 보낸다.
  async voiceSetMeta(view, on) {
    const chatId = view && view.chat_id ? String(view.chat_id) : ''
    if (!chatId) return { ok: false, error: 'no_chat' }
    const nowSec = Math.floor(Date.now() / 1000)
    const title = cleanName(view.link_name) || '보이스룸'
    let content
    if (on) {
      // 17자리 callId 를 문자열로 만든다(정밀도 유지). csIP 는 과거 캡처에서 본 음성서버.
      const callId = '1' + String(nowSec) + String(Math.floor(Math.random() * 1e6)).padStart(6, '0')
      const csIP = '211.242.15.98'
      const csIP6 = '2404:4600:2:d5:211:242:15:98'
      content = '{"liveon":true,"title":' + JSON.stringify(title) +
        ',"updateTime":' + nowSec + ',"startTime":' + nowSec +
        ',"csIP":"' + csIP + '","csIP6":"' + csIP6 + '","csPort":9000' +
        ',"callId":' + callId + ',"url":"","blind":false}'
    } else {
      content = '{"liveon":false}'
    }
    // 오픈채팅은 요청에 li(오픈링크 id)가 더 필요할 수 있다. li 포함본과 미포함본을 둘 다 시도해 로그로 가른다.
    const li = view && view.link_id ? String(view.link_id) : ''
    const attempts = []
    if (li) attempts.push({ tag: 'with-li', body: { chatId: L(chatId), li: L(li), type: 16, content } })
    attempts.push({ tag: 'no-li', body: { chatId: L(chatId), type: 16, content } })
    let last = { ok: false, status: -1 }
    for (const a of attempts) {
      const r = await this.raw('SETMETA', a.body)
      const st = R.locoStatus(r)
      log(this.id, `voice experiment SETMETA(16) ${a.tag} liveon=${on} chat ${chatId} li ${li || '-'} content ${content} → status ${st} body ${traceText((r && r.body) || {})}`)
      last = { ok: R.locoOk(r), status: st }
      if (last.ok) break
    }
    return { ok: last.ok, status: last.status, sent: content }
  }

  // 보이스룸 생성 명령어 탐색: 후보 LOCO 명령어를 빈 바디로 던져 본다.
  // 대조군을 함께 보낸다: REAL(진짜 명령어)·FAKE(완전 가짜 이름). "없는 명령어" 응답이
  // 어떤 상태코드인지(FAKE 로)와 "있는 명령어가 바디부족일 때" 코드(REAL 로)를 못박아,
  // 후보가 FAKE 와 다른 코드를 내면 그게 진짜 존재하는 명령어다. 과속 방지로 사이에 쉰다.
  async voiceProbe(view) {
    const chatId = view && view.chat_id ? String(view.chat_id) : ''
    if (!chatId) return { ok: false, error: 'no_chat' }
    const li = view && view.link_id ? String(view.link_id) : ''
    const groups = [
      ['REAL', ['WRITE', 'GETMEM', 'CHATINFO']],
      ['FAKE', ['ZZQXNON1', 'QWEORIZZ9']],
      ['CAND', [
        'LIVETALK', 'GETLT', 'CREATELT', 'LTCREATE', 'GETLIVETALK', 'CREATELIVETALK',
        'LIVEINFO', 'LTINFO', 'GETLTINFO', 'LIVEON', 'LTON', 'STARTLT', 'GETLIVE', 'CREATELIVE',
        'VRCREATE', 'CREATEVR', 'GETVR', 'VRINFO', 'MAKEVR', 'VROOM', 'GETVROOM', 'STARTVR', 'OPENVR',
        'VOX', 'GETVOX', 'CREATEVOX', 'VOXCREATE', 'OPENVOX',
        'MVOIP', 'GETVOIP', 'MAKEVOIP', 'CREATEVOIP', 'GETMVOIP',
      ]],
    ]
    const results = []
    for (const [tag, list] of groups) {
      for (const m of list) {
        const body = { chatId: L(chatId) }
        if (li) body.li = L(li)
        const r = await this.raw(m, body)
        const st = R.locoStatus(r)
        log(this.id, `voice probe ${tag} ${m} → status ${st} body ${traceText((r && r.body) || {})}`)
        results.push({ tag, m, st })
        await new Promise((ok) => { const t = setTimeout(ok, 500); if (t.unref) t.unref() })
      }
    }
    const codeOf = (tag) => results.filter((x) => x.tag === tag).map((x) => `${x.m}:${x.st}`).join(' ')
    // FAKE 들이 낸 상태코드 = "없는 명령어" 코드. 후보가 그와 다르면 존재하는 명령어 후보.
    const fakeCodes = new Set(results.filter((x) => x.tag === 'FAKE').map((x) => x.st))
    const standout = results.filter((x) => x.tag === 'CAND' && x.st !== -1 && !fakeCodes.has(x.st)).map((x) => `${x.m}:${x.st}`)
    log(this.id, `voice probe done. REAL[${codeOf('REAL')}] FAKE[${codeOf('FAKE')}] standout[${standout.join(' ') || 'none'}]`)
    return { ok: true, real: codeOf('REAL'), fake: codeOf('FAKE'), standout }
  }

  // ── 보이스룸 봇 ─────────────────────────────────────────────────────────
  // 방마다 보이스룸 하나(session)를 들고, KEEP_MS 마다 updateTime 을 올린 LIVE_TALK_INFO 를 다시 보내
  // 48시간까지 살려 둔다. session 은 room_state.runtime.voice 에 저장해 sender 가 다시 떠도 남은 시간을 이어 간다.
  // 한 계정이 여러 방의 보이스룸을 동시에 든다 — 방마다 session 이 따로라 서로 섞이지 않고, 동시 개수만 maxRooms 로 막는다.

  // 이 방의 session. runtime(저장본)이 바뀔 때 한 번만 되살린다. 끝난 session 도 그대로 돌려준다(voiceTick 이 끄고 알린다).
  voiceOf(v) {
    if (!v || !v.runtime) return null
    if (v.voiceAt !== v.runtime) {
      const back = VR.restore(v.runtime.voice, { chat: v.chat_id })
      if (back) v.runtime.voice = back
      else if (v.runtime.voice) { delete v.runtime.voice; v.dirty = true }
      v.voiceAt = v.runtime
    }
    const s = v.runtime.voice
    return s && s.on ? s : null
  }

  // 이 봇이 지금 들고 있는 보이스룸 수(exceptInstall 은 세지 않는다)
  voiceCount(exceptInstall) {
    let n = 0
    for (const v of this.byInstall.values()) {
      if (exceptInstall != null && Number(v.install_id) === Number(exceptInstall)) continue
      if (this.voiceOf(v)) n += 1
    }
    return n
  }

  voiceRows() {
    const now = this.now()
    const rows = []
    for (const v of this.byInstall.values()) {
      const s = this.voiceOf(v)
      if (s) rows.push(Object.assign(VR.sessionRow(v, s, now), { bot: this.id }))
    }
    return rows
  }

  // 신호 한 번(켜기·연장·끄기). 바디는 실측으로 밝혀진 모양 `{c, li, type, content}` 를 쓴다(7.10):
  // 옛 `chatId` 모양은 카카오가 바디를 읽지도 못했다(-203). li 포함본을 먼저 보내고, 안 되면 li 없이 한 번 더.
  async voiceSignal(v, content) {
    const chatId = v && v.chat_id ? String(v.chat_id) : ''
    if (!chatId) return { ok: false, status: -1 }
    const li = v && v.link_id ? String(v.link_id) : ''
    const attempts = []
    if (li) attempts.push({ tag: 'c+li', body: { c: L(chatId), li: L(li), type: 16, content } })
    attempts.push({ tag: 'c', body: { c: L(chatId), type: 16, content } })
    let last = { ok: false, status: -1 }
    for (const a of attempts) {
      const r = await this.raw('SETMETA', a.body)
      last = { ok: R.locoOk(r), status: R.locoStatus(r) }
      log(this.id, `voice signal ${a.tag} chat ${chatId} li ${li || '-'} → status ${last.status}`)
      if (last.ok) break
    }
    return last
  }

  voiceContent(s, now) {
    return VR.onContent({
      title: s.title, startSec: VR.startSecOf(s), nowSec: Math.floor(now / 1000),
      callId: s.callId, csIP: s.csIP, csIP6: s.csIP6, csPort: s.csPort, url: s.url,
    })
  }

  // 켜기. 카카오가 받아 주지 않으면 session 을 남기지 않는다(없는 보이스룸을 48시간 연장하지 않게).
  async voiceStart(v, o) {
    const now = this.now()
    const cur = this.voiceOf(v)
    if (cur && !VR.expired(cur, now)) return { ok: true, op: 'on', already: true, session: cur }
    // 봇이 부방장이어야 방 메타를 바꿀 수 있다(방 명령어는 앞에서 먼저 보고 더 친절히 답한다. HTTP 는 여기서 막는다)
    if (!R.roombotLive(v)) return { ok: false, op: 'on', error: v.products && v.products.roombot ? 'not_active' : 'no_roombot' }
    const max = VR.maxRooms(process.env)
    const count = this.voiceCount(v.install_id)
    if (count >= max) return { ok: false, op: 'on', error: 'too_many', count, max }
    const title = (o && o.title) || (cur && cur.title) || cleanName(v.link_name) || VR.DEFAULT_TITLE
    const s = VR.newSession({ title, by: this.id, byName: o && o.byName, chat: v.chat_id, now })
    const r = await this.voiceSignal(v, this.voiceContent(s, now))
    log(this.id, `voice on install ${v.install_id} chat ${v.chat_id} title ${s.title} callId ${s.callId} rooms ${count + 1}/${max} → status ${r.status}`)
    this.bg(this.roomLog(v.install_id, 'voice', { ok: r.ok, user_id: o && o.by, name: o && o.byName, detail: { op: 'on', title: s.title, status: r.status, hours: Math.round(VR.MAX_MS / 3600000) } }), 'voice log')
    if (!r.ok) return { ok: false, op: 'on', error: 'kakao', status: r.status }
    v.runtime.voice = s
    v.voiceAt = v.runtime
    v.dirty = true
    this.saveSoon(v)
    return { ok: true, op: 'on', session: s, status: r.status }
  }

  // 끄기. 신호가 실패해도 기록은 지운다(이미 내려간 보이스룸을 계속 연장하지 않게).
  async voiceStop(v, why, o) {
    const s = this.voiceOf(v)
    if (!s) return { ok: true, op: 'off', was: false }
    const now = this.now()
    const r = await this.voiceSignal(v, VR.offContent())
    const mins = Math.round((now - Number(s.startAt)) / MIN)
    log(this.id, `voice off install ${v.install_id} why ${why} after ${mins}m keeps ${s.keeps} → status ${r.status}`)
    if (v.runtime) delete v.runtime.voice
    v.dirty = true
    this.saveSoon(v)
    this.bg(this.roomLog(v.install_id, 'voice', { ok: true, user_id: o && o.by, name: o && o.byName, detail: { op: 'off', why, title: s.title, mins, status: r.status } }), 'voice log')
    return { ok: true, op: 'off', was: true, status: r.status, session: s }
  }

  // 연장 한 번. 내리 MAX_FAILS 번 실패하면 카카오에서 내려간 것으로 보고 기록을 접는다.
  async voiceKeep(v, s) {
    const r = await this.voiceSignal(v, this.voiceContent(s, this.now()))
    VR.touch(s, this.now(), r.ok)
    v.dirty = true
    this.saveSoon(v)
    if (!r.ok) log(this.id, `voice keep install ${v.install_id} status ${r.status} fails ${s.fails}`)
    if (VR.dead(s)) {
      log(this.id, `voice keep install ${v.install_id} gave up after ${s.fails} fails`)
      if (v.runtime) delete v.runtime.voice
      v.dirty = true
      this.saveSoon(v)
      this.say(v, VR.deadNotice(s))
      this.bg(this.roomLog(v.install_id, 'voice', { ok: false, detail: { op: 'dead', title: s.title, status: r.status, mins: Math.round((this.now() - Number(s.startAt)) / MIN) } }), 'voice log')
    }
    return r
  }

  async voiceEnd(v, s) {
    const r = await this.voiceStop(v, 'expired')
    this.say(v, VR.endNotice(s))
    return r
  }

  // 명령어·HTTP 공통 입구
  async voiceCmd(v, op, o) {
    const now = this.now()
    const s = this.voiceOf(v)
    if (op === 'status') {
      const live = s && !VR.expired(s, now) ? s : null
      return { ok: true, op: 'status', on: !!live, session: live, left_ms: live ? Math.max(0, Number(live.endAt) - now) : 0 }
    }
    if (op === 'off') return this.voiceStop(v, (o && o.why) || 'command', o)
    return this.voiceStart(v, o || {})
  }

  // 방 안 명령어 처리. 「보룸」(상태)은 누구나, 켜고 끄기는 방장·부방장만.
  // 봇이 부방장이어야 방 메타를 바꿀 수 있어 방 관리봇이 동작하는 방에서만 켜고 끈다.
  // → true(방장·부방장의 명령어로 처리를 끝냈다) | false(그 밖 — 부른 쪽이 홍보·금지어 검사를 이어 간다)
  async voiceChat(v, vc, m, name) {
    const now = this.now()
    const cur = this.voiceOf(v)
    const live = cur && !VR.expired(cur, now) ? cur : null
    const staff = C.isStaff(await this.permOf(v, m.authorId))
    if (vc.cmd === 'status') {
      this.say(v, VR.statusReply(live, now), { what: 'reply' })
      return staff
    }
    if (!staff) {
      this.say(v, VR.staffOnlyReply(), { what: 'reply' })
      return false
    }
    if (!R.roombotLive(v)) {
      this.say(v, C.notLiveReply(this.nameIn(v)), { what: 'reply' })
      return true
    }
    const by = { by: m.authorId, byName: name }
    if (vc.cmd === 'off') {
      if (!live) this.say(v, VR.offReply(null, now), { what: 'reply' })
      else {
        const r = await this.voiceStop(v, 'command', by)
        this.say(v, VR.offReply(r.session || live, this.now()), { what: 'reply' })
      }
      return true
    }
    const r = await this.voiceStart(v, Object.assign({ title: vc.title }, by))
    if (r.already) this.say(v, VR.alreadyReply(r.session, now), { what: 'reply' })
    else if (r.error === 'too_many') this.say(v, VR.capReply(r.count, r.max), { what: 'reply' })
    else this.say(v, r.ok ? VR.onReply(r.session) : VR.failReply(r.status), { what: 'reply' })
    return true
  }

  // tick 마다(1초): 연장할 방·끝난 방·끝나기 1시간 전 방을 본다. 방마다 한 번에 하나만 보낸다(voiceBusy).
  // tick 은 봇이 카카오에 붙어 있을 때만 돈다 — 끊긴 동안은 연장을 실패로 세지 않는다.
  voiceTick(now) {
    for (const v of this.byInstall.values()) {
      if (!v.licensed || !v.chat_id || v.state === 'error' || v.loading || v.voiceBusy) continue
      const s = this.voiceOf(v)
      if (!s) continue
      if (VR.expired(s, now)) {
        v.voiceBusy = true
        this.bg(this.voiceEnd(v, s).finally(() => { v.voiceBusy = false }), 'voice end')
        continue
      }
      if (VR.dueWarn(s, now)) {
        s.warned = true
        v.dirty = true
        this.saveSoon(v)
        this.say(v, VR.warnNotice(s, now))
      }
      if (VR.dueKeepalive(s, now, VR.KEEP_MS)) {
        v.voiceBusy = true
        this.bg(this.voiceKeep(v, s).finally(() => { v.voiceBusy = false }), 'voice keep')
      }
    }
  }

  // 카카오가 보낸 보이스룸 메타(CHGMETA): 진짜 callId·음성서버 값으로 바꿔 끼워 다음 연장에 쓴다.
  // 방장이 카카오 앱에서 직접 보이스룸을 끄면(liveon:false) 우리 기록도 접는다.
  voiceMeta(v, content) {
    const s = this.voiceOf(v)
    if (!s) return
    const meta = VR.parseMeta(content)
    if (!meta) return
    if (!meta.liveon) {
      log(this.id, `voice meta install ${v.install_id} liveon=false — kakao closed it, dropping our session`)
      if (v.runtime) delete v.runtime.voice
      v.dirty = true
      this.saveSoon(v)
      this.bg(this.roomLog(v.install_id, 'voice', { ok: true, detail: { op: 'off', why: 'kakao', title: s.title, mins: Math.round((this.now() - Number(s.startAt)) / MIN) } }), 'voice log')
      return
    }
    if (VR.adopt(s, meta)) {
      v.dirty = true
      this.saveSoon(v)
      log(this.id, `voice meta install ${v.install_id} adopted callId ${s.callId} cs ${s.csIP}:${s.csPort}`)
    }
  }

  // 보룸 진단(SENDER_VOICE_EXPERIMENT 전용): 켜기 거절의 까닭을 가린다(voiceroom.mjs diagVerdict).
  // SETMETA 를 여러 모양으로 던져 어디서 갈리는지 본다. full 이면 지금 방 메타를 '같은 값으로' 한 번 다시 쓴다
  // (바뀌는 것은 없지만 카카오가 그 방에 변경 알림을 띄울 수 있어, 시험 방에서만 쓰도록 인자로 받는다).
  async voiceDiag(v, full) {
    const chatId = v && v.chat_id ? String(v.chat_id) : ''
    if (!chatId) return { ok: false, error: 'no_chat' }
    const li = v && v.link_id ? String(v.link_id) : ''
    const rows = []
    const run = async (tag, body) => {
      const r = await this.raw('SETMETA', body)
      const st = R.locoStatus(r)
      log(this.id, `voice diag ${tag} chat ${chatId} type ${body.type} → status ${st} body ${traceText((r && r.body) || {})}`)
      rows.push({ tag, st })
      // 과속 방지로 사이에 쉰다. unref 하지 않는다 — 이것 말고 깨울 것이 없으면 타이머가 울지 않는다(selfcheck)
      await new Promise((ok) => setTimeout(ok, 400))
      return st
    }
    // 방 메타는 읽기만 한다(CHATINFO)
    const info = await this.raw('CHATINFO', { chatId: L(chatId) })
    const metas = (((info && info.body && info.body.chatInfo && info.body.chatInfo.chatMetas) || [])
      .filter((m) => m && typeof m.content === 'string'))
    const types = metas.map((m) => VR.metaTypeNum(m.type)).filter((n) => Number.isFinite(n))
    log(this.id, `voice diag start chat ${chatId} li ${li || '-'} perm ${v.perm} state ${v.state} metas ${JSON.stringify(types)}`)
    // 방에 이미 보이스룸 메타가 있으면 그 내용을 남긴다 — 카카오가 실제로 쓰는 값의 모양이다(방에는 싣지 않는다)
    for (const m of metas) {
      if (VR.isVoiceMetaType(m.type)) log(this.id, `voice diag existing meta type ${VR.metaTypeNum(m.type)} content ${String(m.content).slice(0, 800)}`)
    }
    const nowSec = Math.floor(this.now() / 1000)
    const on = VR.onContent({ title: '진단', startSec: nowSec, nowSec, callId: VR.newCallId(nowSec) })
    if (li) await run('on+li', { chatId: L(chatId), li: L(li), type: 16, content: on })
    await run('on-li', { chatId: L(chatId), type: 16, content: on })
    await run('off', { chatId: L(chatId), type: 16, content: VR.offContent() })
    await run('count', { chatId: L(chatId), type: 17, content: '{"count":0}' })
    await run('unknown', { chatId: L(chatId), type: 97, content: '{}' })
    // 대조군은 보이스룸이 아닌 메타로만 돌린다 — 거부당하는 타입(16·17)을 다시 써 보는 것은 대조군이 아니다
    let sameType = null
    let sameSkip = ''
    if (full) {
      const other = metas.find((m) => !VR.isVoiceMetaType(m.type))
      if (other) {
        sameType = VR.metaTypeNum(other.type)
        await run('same', { chatId: L(chatId), type: sameType, content: other.content })
      } else {
        sameSkip = metas.length ? '이 방엔 보이스룸 메타(16·17)밖에 없어요' : '이 방엔 읽을 수 있는 방 메타가 없어요'
        log(this.id, `voice diag same skipped — ${sameSkip}`)
      }
    }
    const text = VR.diagText(rows, { types, perm: v.perm, full: !!full, sameType, sameSkip })
    const v2 = VR.diagVerdict(rows, { perm: v.perm, sameType })
    log(this.id, `voice diag done ${rows.map((r) => r.tag + ':' + r.st).join(' ')} → ${v2.next}`)
    return { ok: true, rows, types, text, next: v2.next }
  }

  // 보룸 따라쓰기(SENDER_VOICE_EXPERIMENT 전용): 모양찾기로 `{c, li, type, content}` 가 '읽히는' 모양임을 알았다
  // (제목으로 치면 -500 = 읽고 나서 못 함. 반면 chatId 모양은 -203 = 바디를 못 읽음).
  // 그래서 이제 **모양은 고정하고 내용만** 바꿔 가며, 카카오가 보이스룸 자리에 무엇을 받아 주는지 본다.
  // 대조군으로 같은 내용을 옛 chatId 모양으로도 한 번 보내 둘의 코드가 다른지 같이 남긴다.
  async voiceMirror(v) {
    const chatId = v && v.chat_id ? String(v.chat_id) : ''
    if (!chatId) return { ok: false, error: 'no_chat' }
    const li = v && v.link_id ? String(v.link_id) : ''
    const info = await this.raw('CHATINFO', { chatId: L(chatId) })
    const metas = (((info && info.body && info.body.chatInfo && info.body.chatInfo.chatMetas) || [])
      .filter((m) => m && typeof m.content === 'string'))
    const mine = metas.find((m) => VR.metaTypeNum(m.type) === 16)
    if (!mine) return { ok: false, error: 'no_voice_meta' }
    const cnt = metas.find((m) => VR.metaTypeNum(m.type) === 17)
    const type = VR.metaTypeNum(mine.type)
    const extras = VR.metaExtras(mine)
    const keys = Object.keys(extras)
    const shape = VR.SHAPES.find((x) => x.tag === (li ? 'c+li' : 'c'))
    const oldShape = VR.SHAPES.find((x) => x.tag === 'chatId')
    log(this.id, `voice mirror shape ${shape.tag} type ${type} keys ${keys.join(',') || '-'} extras ${traceText(extras)}`)
    log(this.id, `voice mirror content ${VR.maskMeta(mine.content)}`)
    const rows = []
    const run = async (tag, body) => {
      const r = await this.raw('SETMETA', body)
      const st = R.locoStatus(r)
      log(this.id, `voice mirror ${tag} body ${traceText(body)} → status ${st} body ${traceText((r && r.body) || {})}`)
      rows.push({ tag, st })
      await new Promise((ok) => setTimeout(ok, 400))
      return st
    }
    const vals = (t, content) => ({ chatId: L(chatId), li: li ? L(li) : null, type: t, typeLong: L(String(t)), content })
    const nowSec = Math.floor(this.now() / 1000)
    // 카카오가 써 둔 값 그대로가 가장 중요한 한 발이다 — 이것마저 거부면 내용 문제가 아니다
    await run('asis', VR.shapeBody(shape, vals(type, mine.content)))
    await run('asis+extras', Object.assign(VR.shapeBody(shape, vals(type, mine.content)), extras))
    await run('off', VR.shapeBody(shape, vals(type, VR.offContent())))
    await run('on', VR.shapeBody(shape, vals(type, VR.turnOn(mine.content, nowSec))))
    await run('empty', VR.shapeBody(shape, vals(type, '{}')))
    if (cnt) await run('t17', VR.shapeBody(shape, vals(17, cnt.content)))
    // 대조군: 같은 내용을 옛 모양으로(코드가 갈리는지 한 줄로 보여 준다)
    await run('asis@chatId', VR.shapeBody(oldShape, vals(type, mine.content)))
    const text = VR.mirrorText(rows, { type, keys, shape: shape.tag })
    const next = VR.mirrorVerdict(rows).next
    log(this.id, `voice mirror done ${rows.map((r) => r.tag + ':' + r.st).join(' ')} → ${next}`)
    return { ok: true, rows, type, keys, shape: shape.tag, text, next }
  }

  // 보룸 쓰기시험(SENDER_VOICE_EXPERIMENT 전용): SETMETA 가 보이스룸이 아닌 타입으로는 통하는지 본다.
  // 따라쓰기까지 전부 -203 이라, 우리 바디 모양이 틀린 것인지 type 16 만 막힌 것인지 아직 못 가렸다.
  // 보이스룸이 아닌 메타가 있으면 그것을 글자 그대로 다시 쓰고(완전 무해), 없으면 type 3(제목)에
  // **지금 방 이름 그대로**를 쓴다(값이 같아 보이는 것은 그대로다).
  async voiceWriteTest(v) {
    const chatId = v && v.chat_id ? String(v.chat_id) : ''
    if (!chatId) return { ok: false, error: 'no_chat' }
    const li = v && v.link_id ? String(v.link_id) : ''
    const info = await this.raw('CHATINFO', { chatId: L(chatId) })
    const metas = (((info && info.body && info.body.chatInfo && info.body.chatInfo.chatMetas) || [])
      .filter((m) => m && typeof m.content === 'string'))
    const other = metas.find((m) => !VR.isVoiceMetaType(m.type))
    const type = other ? VR.metaTypeNum(other.type) : 3
    const content = other ? other.content : (cleanName(v.link_name) || '')
    if (!content) return { ok: false, error: 'nothing_to_write' }
    const what = other ? `지금 있는 type ${type} 메타를 글자 그대로` : `type 3(제목)에 지금 방 이름 「${content}」 그대로`
    log(this.id, `voice writetest ${what} chat ${chatId}`)
    const rows = []
    const run = async (tag, body) => {
      const r = await this.raw('SETMETA', body)
      const st = R.locoStatus(r)
      log(this.id, `voice writetest ${tag} type ${body.type} → status ${st} body ${traceText((r && r.body) || {})}`)
      rows.push({ tag, st })
      await new Promise((ok) => setTimeout(ok, 400))
      return st
    }
    const base = { chatId: L(chatId), type, content }
    await run(`type${type}`, base)
    if (li) await run(`type${type}+li`, Object.assign({}, base, { li: L(li) }))
    if (other) {
      const extras = VR.metaExtras(other)
      if (Object.keys(extras).length) await run(`type${type}+echo`, Object.assign({}, base, extras))
    }
    const text = VR.writeTestText(rows, { what })
    const next = VR.writeTestVerdict(rows).next
    log(this.id, `voice writetest done ${rows.map((r) => r.tag + ':' + r.st).join(' ')} → ${next}`)
    return { ok: true, rows, type, text, next }
  }

  // 보룸 모양찾기(SENDER_VOICE_EXPERIMENT 전용): SETMETA 바디의 칸 이름을 하나씩 바꿔 가며 통하는 모양을 찾는다.
  // 해가 없는 타입(제목 3에 지금 방 이름 그대로)으로 먼저 찾고, 통하는 모양이 나오면 **그 모양 그대로**
  // 보이스룸(16)을 한 번 쳐 본다. 거기서 0 이 나오면 보이스룸이 켜지는 것이고, 거부되면 그때야
  // "보이스룸 자리만 막혔다"가 처음으로 증명된다.
  async voiceShape(v, type) {
    const chatId = v && v.chat_id ? String(v.chat_id) : ''
    if (!chatId) return { ok: false, error: 'no_chat' }
    const li = v && v.link_id ? String(v.link_id) : ''
    const title = cleanName(v.link_name) || ''
    if (!title) return { ok: false, error: 'no_title' }
    const info = await this.raw('CHATINFO', { chatId: L(chatId) })
    const metas = (((info && info.body && info.body.chatInfo && info.body.chatInfo.chatMetas) || [])
      .filter((m) => m && typeof m.content === 'string'))
    const voiceMeta = metas.find((m) => VR.metaTypeNum(m.type) === 16)
    // type 16 으로 돌리면 제목 대신 보이스룸 내용으로 같은 모양들을 친다(카카오가 써 둔 값이 있으면 그것을 켠 모양으로)
    const want = Number(type) === 16 ? 16 : 3
    const nowSec = Math.floor(this.now() / 1000)
    const voiceBody = voiceMeta
      ? VR.turnOn(voiceMeta.content, nowSec)
      : this.voiceContent(VR.newSession({ title, by: this.id, chat: chatId, now: this.now() }), this.now())
    const rows = []
    const run = async (tag, body) => {
      const r = await this.raw('SETMETA', body)
      const st = R.locoStatus(r)
      log(this.id, `voice shape ${tag} body ${traceText(body)} → status ${st} body ${traceText((r && r.body) || {})}`)
      rows.push({ tag, st })
      await new Promise((ok) => setTimeout(ok, 400))
      return st
    }
    const vals = (type, content) => ({ chatId: L(chatId), li: li ? L(li) : null, type, typeLong: L(String(type)), content })
    let found = null
    for (const shape of VR.SHAPES) {
      const st = await run(shape.tag, VR.shapeBody(shape, vals(want, want === 16 ? voiceBody : title)))
      if (st === 0) { found = shape; break }
    }
    // 제목으로 통하는 모양을 찾았으면 그 모양 그대로 보이스룸을 쳐 본다
    if (found && want === 3) await run('보이스룸16', VR.shapeBody(found, vals(16, voiceBody)))
    const what = want === 16
      ? `보이스룸(16)${voiceMeta ? ' · 카카오가 써 둔 값을 켠 모양으로' : ' · 우리가 만든 값으로'}`
      : `제목(3)에 「${title}」 그대로${voiceMeta ? ' · 보이스룸 메타 있음' : ''}`
    const text = VR.shapeText(rows, { what, type: want })
    const verdict = VR.shapeVerdict(rows, { type: want })
    log(this.id, `voice shape done ${rows.map((r) => r.tag + ':' + r.st).join(' ')} → ${verdict.next} shape ${verdict.shape || '-'}`)
    return { ok: true, rows, text, next: verdict.next, shape: verdict.shape }
  }

  // ── DB 쓰기 ─────────────────────────────────────────────────────────────
  async write(installId, fields) {
    return this.store.updateInstall(Number(installId), this.id, fields)
  }

  async roomLog(installId, kind, row) {
    try {
      await this.store.roomLog(Number(installId), kind, Object.assign({ at: this.now() }, row || {}))
    } catch (e) {
      log(this.id, `room_log ${kind} failed: ${errText(e)}`)
    }
  }

  // ── 재조정 반영(5.2) ────────────────────────────────────────────────────
  async apply(rows, leaves) {
    const seen = new Set()
    const now = this.now()
    for (const row of rows) {
      const id = Number(row.id)
      seen.add(id)
      if (row.hold_reason) {
        await this.dropView(id)
        this.joinQ.delete(id)
        continue
      }
      if (row.state === 'queued' || row.state === 'joining') {
        await this.dropView(id)
        const nb = Number(row.next_try_at) || 0
        const cur = this.joinQ.get(id)
        if (!cur || cur.notBefore !== nb) this.joinQ.set(id, { notBefore: nb })
        continue
      }
      this.joinQ.delete(id)
      if (row.state === 'error' && row.error_code === 'bot_down' && this.live()) {
        // 봇이 다시 붙었다: 오류로 두지 않고 바로 생존·권한 점검(5.2)
        if (!row.chat_id) {
          await this.write(id, { state: 'queued', error_code: null, error_detail: null, state_at: now })
          this.joinQ.set(id, { notBefore: 0 })
          continue
        }
        const v = await this.upsertView(row)
        v.nextCheckAt = now
        v.checkFull = true
        continue
      }
      if (row.state === 'error' && row.error_code === 'bot_no_open_profile' && this.profileState === 'ok' && this.live()) {
        // 오픈프로필이 준비되었다: 미뤄 둔 입장을 다시 줄에 넣는다(D12)
        await this.dropView(id)
        if (await this.write(id, { state: 'queued', error_code: null, error_detail: null, next_try_at: null, state_at: now })) {
          this.joinQ.set(id, { notBefore: 0 })
          await this.roomLog(id, 'state', { detail: { state: 'queued', event: 'open_profile' } })
        }
        continue
      }
      await this.upsertView(row)
    }
    for (const id of [...this.byInstall.keys()]) if (!seen.has(id)) await this.dropView(id)
    for (const id of [...this.joinQ.keys()]) if (!seen.has(id)) this.joinQ.delete(id)
    this.leaveQ = leaves.slice()
    this.schedulePump(now)
  }

  newView(row) {
    return {
      install_id: Number(row.id),
      member_id: Number(row.member_id),
      chat_id: '',
      link_id: row.link_id || '',
      link_url: row.link_url || '',
      link_name: row.link_name || '',
      products: productsOf(row),
      perm: row.perm == null ? null : Number(row.perm),
      state: row.state,
      error_code: row.error_code || null,
      cfg: R.normRoomConfig(row.config),
      rev: Number(row.config_rev) || 0,
      licensed: !row.member_blocked,
      runtime: {},
      dirty: false,
      ring: [],
      ringFilled: false,
      names: new Map(),
      perms: new Map(),
      // 방 멤버 명부: user_id → {name, pli, link, seenAt}. null = 아직 모름, '' = 없음(room_members 에 저장)
      members: new Map(),
      membersChat: '',
      membersDirty: new Set(),
      memberRefresh: new Set(),
      memberSyncAt: 0,
      memberSyncing: false,
      memberOkAt: 0,              // 마지막으로 GETMEM 동기화가 된 때
      memberWant: new Set(),      // 카드(옾링)를 아직 못 읽은 사람 → MEMBER(옾링만 모르면 INFOLINK)로 채운다
      memberFails: new Map(),     // 카드 채우기에서 못 읽은 횟수
      memberFillAt: 0,
      memberFilling: false,
      memberJobAt: 0,             // 이 방의 동기화·채우기가 시작된 때(표시가 내려지지 않으면 오래된 것으로 본다)
      memberLog: '',              // 지난 동기화 요약(수가 같으면 1시간에 한 번만 남긴다)
      memberLogAt: 0,
      memberFailLogAt: 0,
      leaveReadAt: 0,
      nextCheckAt: 0,
      checkFull: false,
      checking: false,
      recheck: false,
      limits: R.roomLimits(),
      failStreak: 0,
      actPausedUntil: 0,
      hideJob: null,
    }
  }

  // opts.joining: 입장 성공(joined)이 처음 만드는 뷰. 옛 안내 기록을 이 봇 것으로 옮기지 않는다(adoptLegacyNotices).
  async upsertView(row, opts) {
    const id = Number(row.id)
    let v = this.byInstall.get(id)
    const hadRoombot = v ? !!v.products.roombot : null
    const created = !v
    if (!v) {
      // 맵에 먼저 넣고 읽는다(겹친 호출이 뷰를 둘 만들지 않게)
      v = this.newView(row)
      v.adoptLegacy = !(opts && opts.joining)
      this.byInstall.set(id, v)
      await this.loadRuntime(v)
    } else if (v.loadFailed) {
      await this.retryLoad(v)
    }
    v.member_id = Number(row.member_id)
    v.link_id = row.link_id || ''
    v.link_url = row.link_url || ''
    v.link_name = row.link_name || ''
    v.products = productsOf(row)
    v.perm = row.perm == null ? null : Number(row.perm)
    v.state = row.state
    v.error_code = row.error_code || null
    v.licensed = !row.member_blocked
    // 방 안 설정 명령어로 이 봇이 방금 쓴 설정(v.revFloor)보다 옛 행(그 전에 읽어 둔 재조정 목록)으로 되돌리지 않는다
    const rowRev = Number(row.config_rev) || 0
    if ((v.rev !== rowRev && rowRev >= (v.revFloor || 0)) || !v.cfg) {
      v.cfg = R.normRoomConfig(row.config)
      v.rev = rowRev
    }
    const chat = row.chat_id ? String(row.chat_id) : ''
    if (v.chat_id !== chat) {
      if (v.chat_id && this.views.get(v.chat_id) === v) this.views.delete(v.chat_id)
      v.chat_id = chat
    }
    // 멤버 명부는 방(chat)마다 따로다. 링크를 바꿔 다른 방이 되면 비우고 그 방 것을 읽는다.
    if (chat && v.membersChat !== chat) {
      await this.flushMembers(v)
      v.members.clear()
      v.memberWant.clear()
      v.membersChat = chat
      v.memberSyncAt = 0
      await this.loadMembers(v)
    }
    if (chat) {
      // 내보내진 옛 설치(오류)가 같은 방의 새 설치를 가리지 않게
      const cur = this.views.get(chat)
      if (!cur || cur === v || cur.state === 'error' || v.state !== 'error') this.views.set(chat, v)
    }
    const now = this.now()
    if (!v.nextCheckAt && chat) {
      if (v.state === 'waiting_host') v.nextCheckAt = now + jitter(this.opts.permPollMs, 0.25)
      else if (v.state === 'active') v.nextCheckAt = now + this.opts.activeCheckMs
    }
    if (created) this.adoptLegacyNotices(v, !(opts && opts.joining))
    // 이미 들어가 있는 방에 방 관리봇이 붙거나 빠졌다(4.2 "installed → 상품 플래그만 켬, 상태는 sender 가 다시 계산").
    // 다음 정기 점검(최대 10분)까지 기다리지 않고 곧 권한을 읽어 waiting_host·active 를 다시 정한다(0.1·5.4).
    // sender 가 꺼져 있던 동안 상품이 바뀌었으면(뷰를 새로 만듦) 상태가 상품·권한과 어긋나 있으니 그때도 곧 본다.
    const inRoom = !!chat && (v.state === 'active' || v.state === 'waiting_host')
    const changed = hadRoombot !== null && hadRoombot !== v.products.roombot
    const stale = v.products.roombot ? (v.state === 'active' && !(Number(v.perm) & 5)) : v.state === 'waiting_host'
    if (inRoom && (changed || stale)) this.soon(v)
    // 이 봇이 이 방에서 어떤 프로필로 보이는지 모르는 방(v6 때 기본 프로필로 들어간 방): 정기 점검(최대 10분)까지
    // 기다리지 않고 1분쯤 뒤에 읽어 runtime.prof 를 남긴다(부모가 방장에게 보일 이름으로 쓴다, 5.8)
    if (created && inRoom && !(opts && opts.joining) && !this.profOf(v)) {
      const at = now + jitter(this.opts.permPollMs, 0.25)
      if (!v.nextCheckAt || v.nextCheckAt > at) v.nextCheckAt = at
    }
    return v
  }

  // v6 첫 배포의 room_state.runtime 은 7.9 안내 기록을 봇 구분 없이 남겼다(welcomedChat·hostNoticed).
  // 재조정이 이미 방에 있는 행으로 뷰를 처음 만들 때(배포 뒤 첫 시작)는 지금 그 방을 맡은 이 봇이 보낸 것으로 옮긴다.
  // 그러지 않으면 배포 직후 사용 중인 모든 방 관리봇 방에 부방장 지정 안내가 다시 나간다.
  // 입장하면서 처음 만드는 뷰(옮기기·다시 입장 중이던 행)는 누가 보냈는지 모르므로 버린다(새 봇이면 다시 안내해야 한다, D17).
  adoptLegacyNotices(v, adopt) {
    const rt = v.runtime
    if (!rt || typeof rt !== 'object' || !('welcomedChat' in rt || 'hostNoticed' in rt)) return
    if (adopt && v.chat_id) {
      if (!rt.welcomed && rt.welcomedChat && String(rt.welcomedChat) === v.chat_id) {
        rt.welcomed = { chat: v.chat_id, by: this.id, roombot: !!v.products.roombot || rt.hostNoticed === true }
      }
      if (!rt.promoted && rt.hostNoticed === true) rt.promoted = { chat: v.chat_id, by: this.id }
    }
    delete rt.welcomedChat
    delete rt.hostNoticed
    v.dirty = true
  }

  // room_state 읽기. 읽기가 실패하면(DB 끊김 등) 빈 runtime 을 저장본처럼 쓰지 않는다 — 다음 저장이 그 방 사람들의 검·골드·점수·
  // 차단 기록을 빈 것으로 덮어쓰기 때문이다. v.loadFailed 인 동안은 저장(flushView)·미니게임·첫 안내를 하지 않고,
  // 늦춰 가며(5초 → 10초 → … 최대 2분) 다시 읽는다(tick · 메시지 · 재조정). → 읽었으면 true
  async loadRuntime(v) {
    let saved
    try {
      saved = await withTimeout(Promise.resolve(this.store.loadRoomState(v.install_id)), this.opts.loadTimeoutMs)
    } catch (e) {
      v.loadFails = (v.loadFails || 0) + 1
      v.loadFailed = true
      v.loadRetryAt = this.now() + Math.min(LOAD_RETRY_MAX_MS, LOAD_RETRY_MS * 2 ** Math.min(10, v.loadFails - 1))
      log(this.id, `room_state read failed install ${v.install_id} (${v.loadFails}): ${errText(e)}`)
      return false
    }
    if (!v.loadFailed) {
      // 처음 읽기: 읽는 동안 쌓인 것(dirty)은 합친다
      v.runtime = v.dirty ? Object.assign(saved || {}, v.runtime) : (saved || {})
      return true
    }
    // 다시 읽기: 저장본이 기준이다. 실패한 동안의 임시 runtime 은 저장본에 없는 칸만 옮긴다(입장 안내 표시·프로필 등).
    // 통째로 합치면 거의 빈 임시 칸(sword 등)이 저장본을 덮는다. 다만 두 가지는 임시본도 살린다:
    // - 이 봇이 이 방에서 남긴 기록(OWN_KEYS)은 저장본 것이 이 봇·이 방 것이 아니면(다른 봇으로 옮긴 뒤 등) 임시본을 쓴다
    // - 재입장 차단(bans)은 합친다(실패한 동안 나간 사람의 차단 기록이 사라지지 않게, 같은 사람이면 나중 것)
    const base = saved || {}
    const tmp = v.runtime || {}
    let moved = false
    for (const k of Object.keys(tmp)) {
      if (!(k in base)) {
        base[k] = tmp[k]
        moved = true
      } else if (OWN_KEYS.includes(k) && this.ownRecord(v, tmp[k]) && !this.ownRecord(v, base[k])) {
        base[k] = tmp[k]
        moved = true
      } else if (k === 'bans' && tmp.bans && typeof tmp.bans === 'object') {
        if (!base.bans || typeof base.bans !== 'object') base.bans = {}
        for (const [uid, b] of Object.entries(tmp.bans)) {
          const old = base.bans[uid]
          if (old && Number(old.at) >= Number(b && b.at)) continue
          base.bans[uid] = b
          moved = true
        }
        R.pruneBans(base, this.now())
      }
    }
    v.runtime = base
    v.dirty = moved
    v.loadFailed = false
    v.loadFails = 0
    v.loadRetryAt = 0
    log(this.id, `room_state read ok install ${v.install_id} after a failure`)
    this.adoptLegacyNotices(v, v.adoptLegacy)
    // 읽기가 실패해 미뤘던 안내: 입장 안내는 지금(이미 보낸 봇·방이면 noticed 가 막는다), 방 관리봇 추가 안내는 곧 점검에서
    if (v.joinPending) this.bg(this.joinNotices(v), 'join notice')
    if (v.addedPending) this.soon(v)
    return true
  }

  // 이 봇이 이 방(지금 chat)에서 남긴 기록인가(noticed·profOf 와 같은 기준)
  ownRecord(v, n) {
    return !!n && typeof n === 'object' && n.chat === v.chat_id && n.by === this.id
  }

  // 읽기가 실패한 방을 때가 되었으면 다시 읽는다(겹쳐 읽지 않는다). → 지금 읽혀 있으면 true
  async retryLoad(v) {
    if (!v.loadFailed) return true
    if (!v.loading) {
      if (this.now() < (v.loadRetryAt || 0)) return false
      v.loading = this.loadRuntime(v).finally(() => { v.loading = null })
    }
    await v.loading
    return !v.loadFailed
  }

  async dropView(installId) {
    const v = this.byInstall.get(Number(installId))
    if (!v) return
    if (v.saveTimer) clearTimeout(v.saveTimer)
    v.saveTimer = null
    await this.flushView(v)
    if (v.chat_id && this.views.get(v.chat_id) === v) this.views.delete(v.chat_id)
    this.byInstall.delete(Number(installId))
    this.pacer.drop(String(v.install_id))
  }

  async flushView(v) {
    await this.flushMembers(v)
    // 앞선 저장이 끝나기를 기다린 뒤 본다. 저장 중에는 dirty 가 이미 내려가 있어서, 기다리지 않으면 멈출 때의 마지막 저장이
    // 아직 DB 에 닿지 않은 저장(pg 대기열)을 '저장됨'으로 보고 건너뛴 채 끝난다
    while (v.saving) await v.saving
    // 저장본을 못 읽은 방은 저장하지 않는다(빈 runtime 이 저장본을 덮지 않게, loadRuntime)
    if (!v.dirty || v.loadFailed) return
    v.dirty = false
    const saving = Promise.resolve(this.store.saveRoomState(v.install_id, v.runtime)).catch((e) => {
      v.dirty = true
      log(this.id, `room_state save failed: ${errText(e)}`)
    })
    v.saving = saving
    try {
      await saving
    } finally {
      if (v.saving === saving) v.saving = null
    }
  }

  // 게임 답이 나간 방은 SAVE_SOON_MS 뒤에 한 번 저장한다(그 사이 답이 더 나가면 한 번으로 묶는다)
  saveSoon(v) {
    if (v.saveTimer || this.closing) return
    v.saveTimer = setTimeout(() => {
      v.saveTimer = null
      if (this.byInstall.get(v.install_id) === v) this.bg(this.flushView(v), 'room_state save')
    }, SAVE_SOON_MS)
    if (v.saveTimer.unref) v.saveTimer.unref()
  }

  async flush() {
    await Promise.allSettled([...this.byInstall.values()].map((v) => this.flushView(v)))
  }

  // ── 나가기 → 입장 작업 줄(5.2·5.3) ──────────────────────────────────────
  schedulePump(at) {
    if (this.stopped || this.closing) return
    const now = this.now()
    const when = Math.max(now, at || now)
    if (this.pumpTimer && this.pumpAt <= when) return
    if (this.pumpTimer) clearTimeout(this.pumpTimer)
    this.pumpAt = when
    this.pumpTimer = setTimeout(() => {
      this.pumpTimer = null
      this.bg(this.pump(), 'pump')
    }, Math.max(0, when - now))
    if (this.pumpTimer.unref) this.pumpTimer.unref()
  }

  async pump() {
    if (this.pumping) {
      this.pumpAgain = true
      return
    }
    this.pumping = true
    try {
      do {
        this.pumpAgain = false
        await this.pumpOnce()
      } while (this.pumpAgain && !this.stopped)
    } finally {
      this.pumping = false
    }
  }

  async pumpOnce() {
    if (!this.live()) return
    while (this.leaveQ.length && this.live()) {
      const lv = this.leaveQ.shift()
      try {
        await this.doLeave(lv)
      } catch (e) {
        log(this.id, `leave ${lv.id} failed: ${errText(e)}`)
      }
    }
    // 입장이 먼저, 그다음 프로필 바꾸기(UPLINKPROF·다시 입장). 둘 다 같은 간격(BOT_JOIN_GAP_MS)을 둔다.
    const first = (q) => {
      let best = null
      for (const [id, j] of q) {
        if (!best || j.notBefore < best.notBefore || (j.notBefore === best.notBefore && id < best.id)) best = { id, notBefore: j.notBefore }
      }
      return best
    }
    while (this.live()) {
      const now = this.now()
      const jb = first(this.joinQ)
      const sb = first(this.switchQ)
      let kind = ''
      let best = null
      if (jb && jb.notBefore <= now) { kind = 'join'; best = jb } else if (sb && sb.notBefore <= now) { kind = 'switch'; best = sb }
      if (!best) {
        const at = Math.min(jb ? jb.notBefore : Infinity, sb ? sb.notBefore : Infinity)
        if (at < Infinity) this.schedulePump(at)
        return
      }
      if (this.nextJoinAt > now) {
        this.schedulePump(this.nextJoinAt)
        return
      }
      let used = false
      if (kind === 'join') {
        this.joinQ.delete(best.id)
        try {
          used = await this.joinOne(best.id)
        } catch (e) {
          log(this.id, `join ${best.id} failed: ${errText(e)}`)
        }
      } else {
        const job = this.switchQ.get(best.id)
        this.switchQ.delete(best.id)
        try {
          used = await this.switchOne(best.id, job)
        } catch (e) {
          log(this.id, `profile switch ${best.id} failed: ${errText(e)}`)
        }
      }
      if (used) this.nextJoinAt = this.now() + jitter(this.opts.joinGapMs, 0.2)
    }
  }

  // 나가기 1행(5.2). 지금 이 봇이 같은 link_id 의 설치를 맡고 있으면 나가지 않는다(kept).
  async doLeave(lv) {
    const li = lv.link_id ? String(lv.link_id) : ''
    if (li) {
      for (const v of this.byInstall.values()) if (v.link_id === li) return this.finishLeave(lv, 'kept', true)
      const rows = await this.store.listInstalls([this.id])
      if (rows.some((r) => String(r.link_id || '') === li)) return this.finishLeave(lv, 'kept', true)
    }
    let chatId = lv.chat_id ? String(lv.chat_id) : ''
    let inRoom = false
    try {
      const chats = await this.client.getChats({ all: true })
      if (chatId) inRoom = chats.some((c) => String(c.chat_id) === chatId)
      if (!inRoom && li) {
        const hit = chats.find((c) => String(c.link_id || '') === li)
        if (hit) {
          chatId = String(hit.chat_id)
          inRoom = true
        }
      }
    } catch (e) {
      return this.leaveFailed(lv, 'list')
    }
    if (!inRoom) return this.finishLeave(lv, 'not_in_room', true)
    try {
      await this.client.leaveChat(chatId)
    } catch (e) {
      const m = /statusCode=(-?\d+)/.exec(errText(e))
      return this.leaveFailed(lv, m ? m[1] : 'error')
    }
    if (this.views.get(chatId)) this.views.delete(chatId)
    return this.finishLeave(lv, 'left', true)
  }

  async leaveFailed(lv, status) {
    const n = (this.leaveTries.get(lv.id) || 0) + 1
    this.leaveTries.set(lv.id, n)
    await this.finishLeave(lv, 'failed:' + status, n >= 5)
  }

  async finishLeave(lv, result, done) {
    if (done) this.leaveTries.delete(lv.id)
    await this.store.finishLeave(lv.id, this.id, result, done)
  }

  async chatByLink(li) {
    if (!li) return null
    try {
      const chats = await this.client.getChats({ all: true })
      const hit = (chats || []).find((c) => String(c.link_id || '') === String(li))
      return hit ? { chat_id: String(hit.chat_id), link_id: String(li) } : null
    } catch (e) {
      log(this.id, `chat list failed: ${errText(e)}`)
      return null
    }
  }

  // 입장 1건(5.3). → Kakao 에 입장 패킷을 보냈으면 true(다음 입장까지 간격을 둔다).
  async joinOne(id) {
    const row = await this.store.getInstall(id)
    if (!row || row.phase !== 'installed' || row.bot_device_id !== this.id || row.hold_reason) return false
    if (row.state !== 'queued' && row.state !== 'joining') return false
    const now = this.now()
    if (Number(row.next_try_at) > now) {
      this.joinQ.set(Number(row.id), { notBefore: Number(row.next_try_at) })
      return false
    }
    if (await this.store.isBlocked(row.link_id || null, row.link_url || null)) {
      await this.fail(row, 'blocked')
      return false
    }
    // 0. 사전 확인: 이미 그 방에 있으면 JOINLINK 없이 성공 처리(다시 입장으로 방금 나온 방은 건너뛴다)
    const rejoin = this.rejoinIds.has(Number(row.id))
    if (row.link_id && !rejoin) {
      const ch = await this.chatByLink(row.link_id)
      if (ch) {
        await this.joined(row, ch, null)
        return false
      }
    }
    // 0'. 오픈프로필(D12): 오픈프로필이 없으면 기본 프로필로 대신 들어가지 않는다. 카카오에 아무것도 보내지 않는다.
    const prof = this.profileState === 'ok' ? this.openProfile : null
    if (!prof) {
      if (this.profileState === 'unknown') {
        // 아직 읽지 못했다(접속 직후·SYNCLINK 실패): 오류로 두지 않고 줄에 남긴다. 읽히면 바로 다시 본다.
        this.profileWait.add(Number(row.id))
        this.joinQ.set(Number(row.id), { notBefore: now + this.opts.transientWaitMs })
        this.schedulePump(now + this.opts.transientWaitMs)
        this.bg(this.readOpenProfiles('join'), 'open profile read')
        return false
      }
      await this.fail(row, 'bot_no_open_profile', this.profileState)
      return false
    }
    if (this.pool.joinPausedUntil > now) {
      await this.rateLimited(row, this.pool.joinPausedUntil)
      return false
    }
    const free = Math.max(this.joinH.freeAt(now), this.joinD.freeAt(now))
    if (free > now) {
      await this.rateLimited(row, free)
      return false
    }
    this.joinH.add(now)
    this.joinD.add(now)
    // 1.
    if (!(await this.write(row.id, { state: 'joining', attempts: '+1', state_at: now }))) return false
    // 2. JOININFO
    const info = await this.raw('JOININFO', { lu: String(row.link_url), ref: 'EW' })
    const ist = R.locoStatus(info)
    if (ist !== 0) {
      await this.joinFail(row, ist, { step: 'info', res: info })
      return true
    }
    const ol = info.body && info.body.ol
    if (!ol || typeof ol !== 'object') {
      await this.joinFail(row, 0, { step: 'info', res: info, empty: true })
      return true
    }
    if (Number(ol.lt) !== 2) {
      log(this.id, `install ${row.id} JOININFO link type ${ol.lt} ${R.groupLinkType(ol.lt) ? 'treated as a group room' : '-> not_group'} ` +
        `(keys ${Object.keys(ol).join(',')}, pv ${ol.pv})`)
    }
    if (!R.groupLinkType(ol.lt)) {
      await this.fail(row, 'not_group')
      return true
    }
    const li = R.idText(ol.li)
    const name = typeof ol.ln === 'string' && ol.ln.trim() ? ol.ln.trim().slice(0, 200) : null
    if (!li) {
      await this.fail(row, 'kakao_error', '카카오 상태 ' + ist)
      return true
    }
    if (!row.link_id) {
      try {
        await this.write(row.id, { link_id: li, link_name: name || row.link_name || null })
      } catch (e) {
        if (e && e.code === '23505') {
          await this.fail(row, 'duplicate_room')
          return true
        }
        throw e
      }
      row.link_id = li
      if (name) row.link_name = name
      if (await this.store.isBlocked(li, null)) {
        await this.fail(row, 'blocked')
        return true
      }
      const ch = await this.chatByLink(li)
      if (ch) {
        await this.joined(row, ch, null)
        return true
      }
    } else if (String(row.link_id) !== li) {
      await this.fail(row, 'link_changed', 'li ' + li)
      return true
    } else if (name && name !== row.link_name) {
      await this.write(row.id, { link_name: name })
      row.link_name = name
    }
    // 3. 참여코드
    const pv = Number(ol.pv) || 0
    let tk = null
    if (pv & 64) {
      if (!row.passcode_ct) {
        await this.fail(row, 'passcode_needed')
        return true
      }
      const pc = openPasscode(row.passcode_ct)
      if (pc == null) {
        await this.fail(row, 'passcode_needed', 'passcode_unreadable')
        return true
      }
      const cj = await this.raw('CHECKJOIN', { li: L(li), pc })
      const cst = R.locoStatus(cj)
      if (cst !== 0) {
        if (RATE_STATUS.has(cst) || cst === -444 || cst === -997 || cst === -1) {
          await this.joinFail(row, cst, { step: 'check', res: cj, li })
        } else {
          await this.fail(row, 'passcode_wrong', '카카오 상태 ' + cst)
        }
        return true
      }
      tk = cj.body && cj.body.tk != null ? cj.body.tk : null
    }
    // 4. JOINLINK — 늘 이 계정의 오픈프로필(ptp 16, pli). 방의 pv(32 = 기본 프로필 참여 허용)와 관계없이 같다.
    //    기본 프로필(ptp 1)·닉네임 프로필(ptp 2)로 대신 들어가는 일은 없다(D12).
    const body = { li: L(li), ref: 'EW:', ptp: OPEN_PROFILE, pli: L(prof.li) }
    if (tk != null) body.tk = tk
    const jr = await this.raw('JOINLINK', body)
    const jst = R.locoStatus(jr)
    if (pv && this.opts.trace) log(this.id, `install ${row.id} JOINLINK ptp 16 status ${jst} room pv ${pv}`)
    if (jst === 0) {
      const room = jr.body && jr.body.chatRoom
      const chatId = R.idText(room && (room.chatId != null ? room.chatId : room.c)) || R.idText(jr.body && jr.body.chatId)
      if (chatId) {
        await this.joined(row, { chat_id: chatId, link_id: li, pv }, jr.body.olu, prof)
        return true
      }
      await this.joinFail(row, -1, { step: 'join', res: jr, li, ptp: body.ptp, prof })
      return true
    }
    await this.joinFail(row, jst, { step: 'join', res: jr, li, ptp: body.ptp, prof })
    return true
  }

  // 5.3 6 실패 처리
  async joinFail(row, status, ctx) {
    const now = this.now()
    const res = ctx.res || {}
    if (res.noSession) {
      // 봇 연결이 없다: 오류로 두지 않고 다시 줄에 넣는다
      this.joinQ.set(Number(row.id), { notBefore: now + this.opts.transientWaitMs })
      this.schedulePump(now + this.opts.transientWaitMs)
      return
    }
    // 카카오가 거절 이유 문장(errMsg)을 주면 남긴다 — 방 문제인지 봇 계정 제한인지 가를 수 있게(관리자 화면 오류 자세히에도)
    const em = res.body && typeof res.body.errMsg === 'string' ? res.body.errMsg.replace(/\s+/g, ' ').trim().slice(0, 160) : ''
    if (status !== 0 || em) log(this.id, `install ${row.id} join ${ctx.step || '?'} status ${status}${em ? ' msg ' + em : ''}`)
    const why = (st) => '카카오 상태 ' + st + (em ? ' · ' + em : '')
    if (RATE_STATUS.has(status)) {
      const n = this.rateN.get(Number(row.id)) || 0
      this.rateN.set(Number(row.id), n + 1)
      const wait = this.opts.rateWaits[Math.min(n, this.opts.rateWaits.length - 1)]
      await this.rateLimited(row, now + wait)
      return
    }
    if (status === -444) {
      const until = this.pool.ipBlocked(now)
      await this.rateLimited(row, until)
      return
    }
    if (status === -997) {
      await this.fail(row, 'bot_down', '카카오 상태 -997')
      await this.markDead('restricted')
      return
    }
    if (GONE_STATUS.has(status)) {
      await this.fail(row, 'link_gone', '카카오 상태 ' + status)
      return
    }
    if (status === -815) {
      await this.fail(row, 'kicked', '카카오 상태 -815')
      return
    }
    if (status === -501) {
      await this.fail(row, 'room_full', '카카오 상태 -501')
      return
    }
    if (ctx.step === 'info') {
      // 조회 단계의 응답 유실·알 수 없는 status: 세 번까지는 잠시 뒤 다시
      const n = (this.transient.get(Number(row.id)) || 0) + 1
      this.transient.set(Number(row.id), n)
      if ((status === -1 || ctx.empty) && n < 3) {
        await this.write(row.id, { state: 'joining', error_detail: null, next_try_at: now + this.opts.transientWaitMs, state_at: now })
        this.joinQ.set(Number(row.id), { notBefore: now + this.opts.transientWaitMs })
        this.schedulePump(now + this.opts.transientWaitMs)
        return
      }
      await this.fail(row, 'kakao_error', why(status))
      return
    }
    // 입장 단계: 오픈프로필(ptp 16) 입장을 카카오가 거절한 status(BOT_PROFILE_BLOCK_STATUS) → profile_blocked.
    // 기본 프로필로 다시 시도하지 않는다(D12).
    const lost = status === -1 || !!res.timeout
    if (!lost && ctx.step === 'join' && ctx.ptp === OPEN_PROFILE && this.opts.profileBlockStatus.includes(status)) {
      await this.fail(row, 'profile_blocked', '카카오 상태 ' + status)
      return
    }
    // 응답 유실·알 수 없는 status: 다시 접속하지 않는다. 지금 세션의 방 목록에서 같은 li 의 방을 찾는다.
    const ch = ctx.li ? await this.chatByLink(ctx.li) : null
    if (ch) {
      await this.joined(row, ch, null, ctx.prof || null)
      return
    }
    await this.fail(row, 'kakao_error', why(status))
  }

  async rateLimited(row, until) {
    const now = this.now()
    await this.write(row.id, { state: 'joining', error_detail: 'rate_limited', next_try_at: until, state_at: now })
    this.joinQ.set(Number(row.id), { notBefore: until })
    this.schedulePump(until)
  }

  async fail(row, code, detail) {
    const now = this.now()
    let n = 0
    try {
      n = await this.write(row.id, { state: 'error', error_code: code, error_detail: detail || null, next_try_at: null, state_at: now })
    } catch (e) {
      // 오류 칸을 쓰다 부분 UNIQUE 에 걸리면(다른 회원이 그 방을 설치함) 배타권이 없는 kicked 로 둔다
      if (e && e.code === '23505') {
        n = await this.write(row.id, { state: 'error', error_code: 'kicked', error_detail: code, next_try_at: null, state_at: now })
      } else throw e
    }
    this.transient.delete(Number(row.id))
    this.joinQ.delete(Number(row.id))
    this.rejoinIds.delete(Number(row.id))
    this.profileWait.delete(Number(row.id))
    if (!n) return
    await this.roomLog(row.id, 'state', { ok: false, detail: { state: 'error', code } })
    const v = this.byInstall.get(Number(row.id))
    if (v) {
      v.state = 'error'
      v.error_code = code
    }
    log(this.id, `install ${row.id} join error ${code}${detail ? ' (' + detail + ')' : ''}`)
  }

  // 5. 입장 성공(또는 이미 들어가 있음). sentProf = 이번 JOINLINK 에 실은 오픈프로필(사전 확인으로 끝났으면 null)
  async joined(row, ch, joinOlu, sentProf) {
    const now = this.now()
    const chatId = String(ch.chat_id)
    const li = String(ch.link_id || row.link_id || '')
    this.rejoinIds.delete(Number(row.id))
    this.profileWait.delete(Number(row.id))
    const self = await this.readSelf(chatId, joinOlu, true)
    if (self.open == null && sentProf) Object.assign(self, { open: true, pli: sentProf.li, nn: self.nn || sentProf.name })
    if (self.open && !self.nn && sentProf && self.pli === sentProf.li) self.nn = sentProf.name
    let perm = self.perm
    const products = productsOf(row)
    let state = 'active'
    if (products.roombot) state = perm != null && (perm & 5) ? 'active' : 'waiting_host'
    const fields = {
      chat_id: chatId, joined_at: now, error_code: null, error_detail: null, next_try_at: null,
      state, perm: perm == null ? null : perm, perm_at: perm == null ? null : now, state_at: now,
    }
    if (!row.link_id && li) fields.link_id = li
    try {
      await this.write(row.id, fields)
    } catch (e) {
      if (e && e.code === '23505') {
        // 내보내진 동안 다른 회원이 이 방을 설치했다
        try { await this.client.leaveChat(chatId) } catch {}
        await this.fail(row, 'room_taken')
        return
      }
      throw e
    }
    this.pool.joinOk()
    this.rateN.delete(Number(row.id))
    this.transient.delete(Number(row.id))
    await this.roomLog(row.id, 'state', { detail: { state, event: 'join' } })
    const v = await this.upsertView(Object.assign({}, row, fields, { link_id: row.link_id || li, state }), { joining: true })
    v.nextCheckAt = now + (state === 'waiting_host' ? jitter(this.opts.permPollMs, 0.25) : this.opts.activeCheckMs)
    if (ch.pv != null && Number.isFinite(Number(ch.pv))) v.linkPv = Number(ch.pv)
    // 이 방에서 봇이 어떤 프로필로 보이는지 남긴다(오픈프로필이 아니면 관리자 화면에 바꾸기 대상으로 보인다).
    // 바로 저장한다: 부모는 이 기록이 없는 입장 완료 방을 v6 때 기본 프로필로 들어간 방으로 본다(installs.BOT_NAME_SQL)
    this.noteSelf(v, self)
    await this.flushView(v)
    await this.joinNotices(v)
  }

  // 입장 안내·부방장 지정 확인(7.9). 저장본을 못 읽은 방(loadFailed)은 이 봇이 이미 안내했는지 모르니 미루고,
  // 다시 읽은 뒤 보낸다(loadRuntime → joinPending). 같은 봇이 같은 방에 다시 들어온 것이면 저장본의 표시가 막는다.
  async joinNotices(v) {
    if (v.loadFailed) {
      v.joinPending = true
      return
    }
    v.joinPending = false
    if (!v.chat_id || (v.state !== 'active' && v.state !== 'waiting_host') || this.byInstall.get(v.install_id) !== v) return
    const products = v.products
    // 미니게임봇으로 안내했던 방에 방 관리봇을 더한 뒤 다시 들어왔으면 방 관리봇 안내(지정할 계정 이름)를 한 번 더 한다
    const welcomed = this.noticed(v, 'welcomed') && (!products.roombot || v.runtime.welcomed.roombot)
    if (!welcomed && v.licensed) {
      this.markNoticed(v, 'welcomed', { roombot: !!products.roombot })
      v.addedPending = false
      this.say(v, R.joinNotice(v, this.nameIn(v)), { what: 'notice' })
    }
    if (v.state === 'active' && products.roombot && !this.noticed(v, 'promoted')) {
      this.markNoticed(v, 'promoted')
      await this.roomLog(v.install_id, 'perm', { detail: { perm: v.perm, granted: true, to: 'active' } })
      this.say(v, R.PROMOTED_NOTICE, { what: 'notice' })
    }
  }

  // 7.9 안내(입장 안내·부방장 지정 확인)는 "이 방에서 이 봇 계정이" 처음일 때 1회다. room_state 는 설치마다 하나라
  // 옮기기(D17: 새 봇을 다시 부방장으로 지정해야 함)·링크 바꾸기 뒤에는 봇이나 방이 달라져 다시 알린다.
  noticed(v, kind) {
    const n = v.runtime[kind]
    return !!n && typeof n === 'object' && n.chat === v.chat_id && n.by === this.id
  }

  markNoticed(v, kind, extra) {
    v.runtime[kind] = Object.assign({ chat: v.chat_id, by: this.id }, extra || {})
    v.dirty = true
  }

  // 권한 읽기(D13): CHATONROOM 의 olu.lmt → (입장 때) JOINLINK 의 olu.lmt → MEMBER(self) 의 mt → null(판정 보류)
  async readPerm(chatId, fallback) {
    return (await this.readSelf(chatId, fallback != null ? { lmt: fallback } : null, false)).perm
  }

  // 이 방에서의 봇 자신 → {perm, open, pli, nn}. 권한은 readPerm 과 같은 순서.
  // 프로필: CHATONROOM·JOINLINK·UPLINKPROF 의 olu.ptp(16 = 오픈프로필)·pli·nn. 그것이 없고 needProfile 이면
  // MEMBER(self) — 오픈채팅 멤버의 pli 는 오픈프로필로 들어와 있을 때만 있다(node-kakao OpenMemberStruct).
  // open: true(오픈프로필) | false(기본·닉네임 프로필) | null(모름)
  async readSelf(chatId, extraOlu, needProfile) {
    const out = { perm: null, open: null, pli: '', nn: '', ptp: null }
    const take = (olu) => {
      if (!olu || typeof olu !== 'object') return
      if (out.perm == null && olu.lmt != null && Number.isFinite(Number(olu.lmt))) out.perm = Number(olu.lmt)
      if (out.open != null) return
      const ptp = olu.ptp != null && Number.isFinite(Number(olu.ptp)) ? Number(olu.ptp) : null
      const pli = R.idText(olu.pli)
      if (ptp != null) out.open = ptp === OPEN_PROFILE
      else if (pli) out.open = true
      else return
      out.ptp = ptp
      out.pli = out.open ? pli : ''
      out.nn = cleanName(olu.nn || olu.nickName)
    }
    const r = await this.raw('CHATONROOM', { chatId: L(chatId) })
    if (R.locoOk(r)) take(r.body && r.body.olu)
    take(extraOlu)
    if ((out.perm == null || (needProfile && out.open == null)) && this.userId) {
      const m = await this.raw('MEMBER', { chatId: L(chatId), memberIds: [L(this.userId)] })
      if (R.locoOk(m)) {
        const list = (m.body && m.body.members) || []
        const me = list.find((x) => R.idText(x && x.userId) === this.userId) || list[0]
        if (me) {
          if (out.perm == null && me.mt != null && Number.isFinite(Number(me.mt))) out.perm = Number(me.mt)
          if (out.open == null && R.idText(me.userId) === this.userId) {
            const pli = R.idText(me.pli)
            out.open = !!pli
            out.pli = pli
            out.nn = cleanName(me.nickName || me.nn)
          }
        }
      }
    }
    return out
  }

  // ── 방마다 봇의 프로필(D12) ──────────────────────────────────────────────
  // runtime.prof = {open, pli, nn, chat, by, at, fail?, failAt?, sw?} — 이 봇(by)이 이 방(chat)에서 본 자기 프로필.
  // 부모는 room_state 에서 nn 을 읽어 방장에게 보일 이름으로 쓴다(installs BOT_NAME_SQL).
  profOf(v) {
    const p = v && v.runtime && v.runtime.prof
    return p && typeof p === 'object' && p.by === this.id && p.chat === v.chat_id ? p : null
  }

  profMatches(p) {
    return !!p && p.open === true && !!this.openProfile && p.pli === this.openProfile.li
  }

  // open(고른 오픈프로필) | other(다른 오픈프로필) | main(기본·닉네임 프로필) | failed(바꾸기 거절) | unknown
  roomProfile(v) {
    const p = this.profOf(v)
    if (!p || p.open == null) return 'unknown'
    if (this.profMatches(p)) return 'open'
    if (p.fail != null) return 'failed'
    return p.open ? 'other' : 'main'
  }

  roomProfileView(v) {
    const p = this.profOf(v)
    const q = this.switchQ.get(v.install_id)
    return {
      state: this.roomProfile(v),
      name: p && p.nn ? p.nn : null,
      fail: p && p.fail != null ? p.fail : null,
      fail_at: p && p.failAt ? p.failAt : null,
      switched_at: p && p.sw ? p.sw : null,
      queued: q ? q.how : null,
      target: this.openProfile ? this.openProfile.name : null,
      convert: this.opts.profileConvert,
    }
  }

  // 방에 보이는 봇 이름: 그 방에서 읽은 이름 → 기본 프로필이면 닉네임 → 오픈프로필 이름
  nameIn(v) {
    const p = this.profOf(v)
    if (p && p.nn) return p.nn
    if (p && p.open === false) return this.nickname || this.roomName()
    return this.roomName()
  }

  noteSelf(v, self, opt) {
    if (!self || self.open == null || !v || !v.chat_id) return
    const p = this.profOf(v)
    const next = { open: self.open, pli: self.open ? (self.pli || '') : '', nn: self.nn || (p && p.open === self.open && p.pli === (self.pli || '') ? p.nn : '') || '', chat: v.chat_id, by: this.id, at: this.now() }
    if (p && p.sw) next.sw = p.sw
    if (p && p.fail != null && !this.profMatches(next)) {
      next.fail = p.fail
      next.failAt = p.failAt
    }
    const same = p && p.open === next.open && p.pli === next.pli && p.nn === next.nn && (p.fail == null) === (next.fail == null)
    if (!same) {
      v.runtime.prof = next
      v.dirty = true
    }
    if (!(opt && opt.noQueue)) this.considerSwitch(v)
  }

  considerSwitch(v) {
    if (this.opts.profileConvert !== 'auto') return
    this.queueSwitch(v, 'switch', false)
  }

  // → '' (줄에 넣음·이미 있음) | 오류 코드
  queueSwitch(v, how, manual) {
    const now = this.now()
    if (!v || !v.chat_id || !v.link_id || (v.state !== 'active' && v.state !== 'waiting_host')) return 'not_joined'
    if (this.profileState !== 'ok' || !this.openProfile) return 'no_open_profile'
    if (!this.live()) return 'not_connected'
    const p = this.profOf(v)
    if (this.profMatches(p)) return 'already_open'
    if (how === 'switch' && !manual) {
      if (!p || p.open == null) return 'unknown'
      if (p.failAt && now - p.failAt < this.opts.profileRetryMs) return 'recent_fail'
    }
    const cur = this.switchQ.get(v.install_id)
    if (cur && (cur.how === how || cur.how === 'rejoin')) return ''
    this.switchQ.set(v.install_id, { notBefore: 0, how, manual: !!manual })
    this.schedulePump(now)
    return ''
  }

  // 프로필 바꾸기 1건(UPLINKPROF, 나가지 않는다). → 카카오에 패킷을 보냈으면 true
  async switchOne(id, job) {
    const v = this.byInstall.get(Number(id))
    if (!job || !v || !v.chat_id || !v.link_id || (v.state !== 'active' && v.state !== 'waiting_host')) return false
    const prof = this.profileState === 'ok' ? this.openProfile : null
    if (!prof) return false
    if (job.how === 'rejoin') return this.rejoinOne(v, job)
    const now = this.now()
    const free = this.switchH.freeAt(now)
    if (free > now) {
      this.switchQ.set(v.install_id, Object.assign({}, job, { notBefore: free }))
      this.schedulePump(free)
      return false
    }
    // 지금 프로필을 다시 읽는다. 이미 오픈프로필이면 보내지 않는다.
    const before = await this.readSelf(v.chat_id, null, true)
    this.noteSelf(v, before, { noQueue: true })
    if (before.open === true && before.pli === prof.li) return false
    this.switchH.add(now)
    const r = await this.raw('UPLINKPROF', { li: L(v.link_id), ptp: OPEN_PROFILE, pli: L(prof.li) })
    const st = R.locoStatus(r)
    log(this.id, `install ${v.install_id} UPLINKPROF ptp 16 status ${st} (room pv ${v.linkPv == null ? '?' : v.linkPv}, was ${before.open == null ? 'unknown' : (before.open ? 'open ' + before.pli : 'main')})`)
    const lost = st === -1 || !!r.timeout
    if (st === 0 || lost) {
      const after = await this.readSelf(v.chat_id, st === 0 && r.body ? r.body.olu : null, true)
      const done = after.open === true && after.pli === prof.li
      if (done || (st === 0 && after.open == null)) {
        const name = (done && after.nn) || prof.name
        v.runtime.prof = { open: true, pli: prof.li, nn: name, chat: v.chat_id, by: this.id, at: this.now(), sw: this.now() }
        v.dirty = true
        log(this.id, `install ${v.install_id} now joined with open profile ${prof.li}`)
        // 권한(부방장)이 그대로인지 바로 확인한다
        if (v.products.roombot && after.perm != null) await this.applyPerm(v, after.perm)
        if (v.state === 'waiting_host' && v.products.roombot && v.licensed) this.say(v, R.profileChangedNotice(name), { what: 'notice' })
        return true
      }
      if (lost) {
        // 응답이 없고 바뀌지도 않았다: 거절로 보지 않는다(다음 점검에서 다시 판단)
        this.noteSelf(v, after, { noQueue: true })
        return true
      }
    }
    const p = this.profOf(v) || { open: before.open, pli: before.pli || '', nn: before.nn || '', chat: v.chat_id, by: this.id, at: now }
    v.runtime.prof = Object.assign({}, p, { fail: st === 0 ? 'unchanged' : st, failAt: this.now() })
    v.dirty = true
    log(this.id, `install ${v.install_id} profile switch refused (${st === 0 ? 'unchanged' : 'status ' + st}); room stays as it is`)
    return true
  }

  // 다시 입장 1건(관리자 버튼): 나갔다가 오픈프로필로 다시 들어간다. 부방장은 방장이 다시 지정해야 한다.
  // 행을 먼저 queued 로 써 둔다(나간 뒤 멈춰도 다음 시작이 다시 입장한다). 입장 예산이 없으면 나가지 않는다.
  async rejoinOne(v, job) {
    const id = v.install_id
    const now = this.now()
    const until = Math.max(this.pool.joinPausedUntil, this.joinH.freeAt(now), this.joinD.freeAt(now))
    if (until > now) {
      this.switchQ.set(id, Object.assign({}, job, { notBefore: until }))
      this.schedulePump(until)
      return false
    }
    const row = await this.store.getInstall(id)
    if (!row || row.phase !== 'installed' || row.bot_device_id !== this.id || row.hold_reason) return false
    if (row.state !== 'active' && row.state !== 'waiting_host') return false
    const n = await this.write(id, { state: 'queued', error_code: null, error_detail: null, next_try_at: null, perm: null, perm_at: null, state_at: now })
    if (!n) return false
    // 새 이름으로 입장 안내·부방장 확인 안내를 다시 한다
    delete v.runtime.welcomed
    delete v.runtime.promoted
    delete v.runtime.prof
    v.dirty = true
    const chat = v.chat_id
    await this.dropView(id)
    let left = false
    try {
      await this.client.leaveChat(chat)
      left = true
    } catch (e) {
      log(this.id, `install ${id} rejoin: leave failed ${errText(e)}`)
    }
    if (left) this.rejoinIds.add(id)
    await this.roomLog(id, 'state', { detail: { state: 'queued', event: 'rejoin' } })
    log(this.id, `install ${id} rejoin with open profile (${left ? 'left' : 'leave failed, checking the room again'})`)
    this.joinQ.set(id, { notBefore: 0 })
    return true
  }

  // ── 권한·생존 점검(5.4) ─────────────────────────────────────────────────
  tick() {
    if (!this.live()) return
    const now = this.now()
    for (const v of this.byInstall.values()) {
      if (v.checking || !v.chat_id || !v.nextCheckAt || v.nextCheckAt > now) continue
      if (v.state === 'error' && v.error_code !== 'bot_down') {
        v.nextCheckAt = 0
        continue
      }
      v.checking = true
      this.checks = this.checks.then(() => this.checkRoom(v)).catch((e) => log(this.id, `check ${v.install_id} failed: ${errText(e)}`)).finally(() => { v.checking = false })
    }
    for (const v of this.byInstall.values()) {
      this.memberSync(v, now)
      this.memberFill(v, now)
      if (v.loadFailed && !v.loading && now >= (v.loadRetryAt || 0)) this.bg(this.retryLoad(v), 'room_state retry')
    }
    this.voiceTick(now)
    for (const [uid, at] of this.ownKicks) if (now - at > MIN) this.ownKicks.delete(uid)
    // 오픈프로필 목록을 주기적으로 다시 읽는다(모르는 상태면 5분마다)
    const every = this.profileState === 'unknown' ? 5 * MIN : this.opts.profileReadMs
    if (every && !this.profileReading && now - Math.max(this.profileReadAt, this.profileTryAt) > every) {
      this.bg(this.readOpenProfiles('periodic'), 'open profile read')
    }
  }

  async checkRoom(v) {
    if (!this.live() || !this.byInstall.has(v.install_id)) return
    const now = this.now()
    const full = v.checkFull || v.state === 'active' || v.state === 'error'
    v.checkFull = false
    v.recheck = false
    if (full) {
      try {
        await this.client.getChat(v.chat_id)
      } catch (e) {
        if (e && e.getChatFailureReason === 'chat_info_absent') {
          await this.roomGone(v, 'kicked')
          return
        }
        v.nextCheckAt = now + MIN
        return
      }
      // INFOLINK 에 링크가 없으면 방 삭제(5.4). 한 번의 빈 응답으로 방을 나가지 않게 두 번 연속일 때만.
      if (v.link_id) {
        const r = await this.raw('INFOLINK', { lis: [L(v.link_id)] })
        if (R.locoOk(r)) {
          const ols = (r.body && Array.isArray(r.body.ols)) ? r.body.ols : []
          const ol = ols.find((o) => R.idText(o && o.li) === v.link_id)
          if (ol) {
            v.linkMiss = 0
            // 방의 pv(32 = 기본 프로필 참여 허용, 8 = PROFILE_EDITABLE)를 프로필 바꾸기 기록에 함께 남긴다(실측)
            if (ol.pv != null && Number.isFinite(Number(ol.pv))) v.linkPv = Number(ol.pv)
          } else {
            v.linkMiss = (v.linkMiss || 0) + 1
            if (v.linkMiss >= 2) {
              await this.roomGone(v, 'room_deleted')
              return
            }
            v.checkFull = true
            v.nextCheckAt = this.now() + MIN
            return
          }
        }
      }
    }
    // 방 관리봇 방은 점검마다 권한을 읽는다(CHATONROOM 의 olu 에 프로필도 함께 온다).
    // 미니게임만 있는 방은 이 봇의 프로필을 아직 모를 때만 한 번 읽는다(D12 오픈프로필 확인).
    const needProf = !this.profOf(v) || this.profOf(v).open == null
    if (v.products.roombot || needProf) {
      const self = await this.readSelf(v.chat_id, null, needProf)
      if (!this.byInstall.has(v.install_id)) return
      this.noteSelf(v, self)
      if (v.products.roombot && self.perm != null) await this.applyPerm(v, self.perm)
    }
    if (!v.products.roombot && v.state !== 'active') {
      await this.applyPerm(v, v.perm == null ? 2 : v.perm)
    }
    if (!this.byInstall.has(v.install_id) || v.state === 'error') return
    const due = this.now() + (v.state === 'waiting_host' ? jitter(this.opts.permPollMs, 0.25) : this.opts.activeCheckMs)
    // 점검 도중에 soon() 이 왔으면(상품 변경·권한 푸시) 그 요청을 덮어쓰지 않는다
    v.nextCheckAt = v.recheck ? Math.min(due, this.now() + this.opts.pushDelayMs) : due
    v.recheck = false
  }

  // 방 관리봇이 있는 방: perm & 5 면 active, 아니면 waiting_host. 미니게임만 있는 방은 권한을 보지 않는다(늘 active).
  async applyPerm(v, perm) {
    const now = this.now()
    const prev = v.state
    const prevPerm = v.perm
    const state = v.products.roombot ? ((perm & 5) ? 'active' : 'waiting_host') : 'active'
    const fields = { perm, perm_at: now }
    if (state !== prev || v.error_code) Object.assign(fields, { state, state_at: now, error_code: null, error_detail: null })
    const n = await this.write(v.install_id, fields)
    if (!n) return
    v.perm = perm
    v.state = state
    v.error_code = null
    // 저장본을 못 읽은 방(loadFailed)은 안내 표시를 모르니 안내하지 않는다(다시 읽은 뒤 다음 점검 때)
    const promote = state === 'active' && v.products.roombot && !v.loadFailed && !this.noticed(v, 'promoted')
    // 읽기가 실패해 미룬 방 관리봇 추가 안내(addedPending)는 상태가 그대로여도 다시 읽은 뒤의 점검에서 보낸다
    if (state !== 'waiting_host') v.addedPending = false
    const pending = !!v.addedPending && !v.loadFailed
    if (prev === state && !promote && !pending) return
    if (prev === 'error') await this.roomLog(v.install_id, 'state', { detail: { state, event: 'revive' } })
    // 부방장 없이 사용 중이던 방(미니게임만)에 방 관리봇이 붙음: 강등이 아니라 처음 부방장 대기다(4.2). 해제 기록·알림을 남기지 않는다.
    const added = v.products.roombot && prev === 'active' && !(prevPerm != null && (prevPerm & 5))
    if (v.products.roombot && prev !== state && (prev === 'waiting_host' || (prev === 'active' && !added))) {
      await this.roomLog(v.install_id, 'perm', { detail: { perm, granted: state === 'active', to: state } })
    }
    if ((added || pending) && state === 'waiting_host' && v.licensed) {
      if (v.loadFailed) {
        v.addedPending = true
      } else {
        v.addedPending = false
        if (!(this.noticed(v, 'welcomed') && v.runtime.welcomed.roombot)) {
          // 방장이 어느 계정을 부방장으로 지정할지 알 수 있게 봇 닉네임을 방에 알린다(7.9·D12)
          this.markNoticed(v, 'welcomed', { roombot: true })
          this.say(v, R.roombotAddedNotice(v, this.nameIn(v)), { what: 'notice' })
        }
      }
    }
    if (promote) {
      this.markNoticed(v, 'promoted')
      if (prev !== 'waiting_host') await this.roomLog(v.install_id, 'perm', { detail: { perm, granted: true, to: state } })
      this.say(v, R.PROMOTED_NOTICE, { what: 'notice' })
    }
  }

  soon(v) {
    const at = this.now() + this.opts.pushDelayMs
    if (!v.nextCheckAt || v.nextCheckAt > at) v.nextCheckAt = at
    if (v.checking) v.recheck = true
  }

  // 내보내짐·방 삭제·나감(5.4 표)
  async roomGone(v, code) {
    const now = this.now()
    const n = await this.write(v.install_id, { state: 'error', error_code: code, error_detail: null, state_at: now })
    v.state = 'error'
    v.error_code = code
    v.nextCheckAt = 0
    if (n) await this.roomLog(v.install_id, 'state', { ok: false, detail: { state: 'error', code } })
    this.pacer.drop(String(v.install_id))
    if (code === 'kicked' && v.link_id) {
      await this.raw('KICKLEAVE', { c: L(v.chat_id), li: L(v.link_id) })
    } else if (code === 'room_deleted') {
      try { await this.client.leaveChat(v.chat_id) } catch {}
    }
    log(this.id, `install ${v.install_id} ${code}`)
  }

  // ── 푸시 ────────────────────────────────────────────────────────────────
  onPushRaw(packet) {
    if (!packet || this.stopped || this.closing) return
    if (this.opts.trace && !this.pool.traced.has(packet.method)) {
      this.pool.traced.add(packet.method)
      log(this.id, `push ${packet.method} keys ${Object.keys(packet.body || {}).join(',')}`)
    }
    // SENDER_TRACE_VOICE=1: 보이스룸 실험용. 보이스룸 신호만 본문 전체를 남긴다(분당 20줄).
    if (process.env.SENDER_TRACE_VOICE === '1' && voiceTraceOk(packet)) log(this.id, `voice? ${packet.method} ${voiceText(packet.body)}`)
    this.enqueue(() => this.onPush(packet)).catch((e) => log(this.id, `push ${packet.method} failed: ${errText(e)}`))
  }

  viewByLink(li) {
    const s = R.idText(li)
    if (!s) return null
    for (const v of this.byInstall.values()) if (v.link_id === s) return v
    return null
  }

  async onPush(packet) {
    const m = packet.method
    const b = packet.body || {}
    if (m === 'MSG' || m === 'NEWMEM' || m === 'DELMEM') {
      const log0 = b.chatLog || {}
      const chatId = R.idText(b.chatId) || R.idText(log0.chatId) || R.idText(b.c)
      if (chatId) await this.onChatLog(chatId, log0, typeof b.authorNickname === 'string' ? b.authorNickname : '', m)
      return
    }
    if (m === 'CHGMETA') {
      // 보이스룸 메타(liveon·csIP·callId)만 본다. 다른 메타는 할 일이 없다.
      const v = this.views.get(R.idText(b.chatId) || R.idText(b.c)) || this.viewByLink(b.li)
      if (v && v.licensed && v.state !== 'error' && b.meta) this.voiceMeta(v, b.meta.content)
      return
    }
    if (m === 'SYNCMEMT') {
      const chatId = R.idText(b.c) || R.idText(b.chatId)
      const v = this.views.get(chatId)
      if (!v) return
      const mids = (b.mids || []).map((x) => R.idText(x))
      const mts = b.mts || []
      mids.forEach((id, i) => {
        if (!id || id === this.userId) return
        if (mts[i] != null) v.perms.set(id, { mt: Number(mts[i]), at: this.now() })
      })
      if (mids.includes(this.userId) && v.products.roombot && v.state !== 'error') this.soon(v)
      return
    }
    if (m === 'LINKKICKED') {
      const v = this.views.get(R.idText(b.c) || R.idText(b.chatId)) || this.viewByLink(b.li)
      if (v && v.state !== 'error') await this.roomGone(v, 'kicked')
      return
    }
    if (m === 'LNKDELETED' || m === 'SYNCLINKDL') {
      const li = b.li != null ? b.li : (b.ol && b.ol.li)
      const v = this.viewByLink(li) || this.views.get(R.idText(b.c) || R.idText(b.chatId))
      if (v && v.state !== 'error') await this.roomGone(v, 'room_deleted')
      // 이 계정의 링크(오픈프로필 포함)가 지워졌다: 맡은 방이 아니면 오픈프로필 목록을 다시 읽는다
      else if (!v && m === 'SYNCLINKDL') this.profilePushed(m)
      return
    }
    if (/^SYNCLINK/.test(m) && m !== 'SYNCLINKPF') {
      // SYNCLINKCR(이 계정의 링크가 생김)·SYNCLINKUP 등: 맡은 방의 링크가 아니면 오픈프로필 목록을 다시 읽는다
      const li = R.idText(b.li != null ? b.li : (b.ol && b.ol.li))
      if (!li || !this.viewByLink(li)) this.profilePushed(m)
      return
    }
    if (m === 'LEFT') {
      const v = this.views.get(R.idText(b.chatId) || R.idText(b.c))
      if (v && v.state !== 'error') await this.roomGone(v, 'left')
      return
    }
    if (m === 'SYNCLINKPF') {
      // 오픈 프로필 변경 푸시(7.2(c), 모양은 실측 전). 사람 id 가 보이면 그 사람 카드를 다시 읽어 명부와 비교한다.
      const v = this.views.get(R.idText(b.c) || R.idText(b.chatId)) || this.viewByLink(b.li)
      if (!v || !v.licensed || v.state === 'error' || !R.roombotLive(v)) return
      const p = [b.olu, b.member, b.profile, b].find((x) => x && typeof x === 'object' && R.idText(x.userId))
      if (!p) return
      const uid = R.idText(p.userId)
      if (uid === this.userId) return
      this.refreshSoon(v, uid, String(p.nickName || p.nn || '').trim().slice(0, 40))
    }
  }

  async onChatLog(chatId, chatLog, authorNickname, method) {
    const v = this.views.get(chatId)
    if (!v || !v.licensed || v.state === 'error') return
    const now = this.now()
    const type = Number(chatLog.type)
    const authorId = R.idText(chatLog.authorId)
    const message = typeof chatLog.message === 'string' ? chatLog.message : (chatLog.message == null ? '' : String(chatLog.message))
    const ev = {
      logId: R.idText(chatLog.logId),
      authorId,
      type,
      text: message,
      attachment: chatLog.attachment,
      at: atMs(chatLog.sendAt) || now,
      nick: String(authorNickname || '').trim().slice(0, 40),
    }
    if (type === 0 || method !== 'MSG') {
      await this.onFeed(v, ev)
      return
    }
    if (authorId && authorId === this.userId) return
    await this.onMessage(v, ev)
  }

  // 피드: 권한 변경(11·12·15), 강퇴(6), 입장(4)·퇴장(2·3)
  async onFeed(v, ev) {
    const feed = R.feedOf(ev.text)
    const now = this.now()
    if (feed) {
      const ft = feed.feedType
      if (ft === 11 || ft === 12 || ft === 15) {
        for (const m of feed.members) {
          if (m.userId === this.userId) continue
          if (ft === 11) v.perms.set(m.userId, { mt: 4, at: now })
          else v.perms.delete(m.userId)
        }
        if (R.feedHas(feed, this.userId) && v.products.roombot) this.soon(v)
        return
      }
      if (ft === 6) {
        if (R.feedHas(feed, this.userId)) {
          await this.roomGone(v, 'kicked')
          return
        }
        if (R.roombotLive(v) && v.cfg.guard.enabled) {
          const own = feed.members.length > 0 && feed.members.every((x) => this.ownKicks.has(x.userId))
          const adapter = R.adapterRecord(v, this.id)
          const g = guardOnChat(adapter, { kind: 'msg', chatId: v.chat_id, text: ev.text, authorId: ev.authorId, messageType: 0, mine: false, ownKick: own, now })
          if (g.askHalt) {
            const allowed = !!(Number(v.perm) & 5)
            guardFinishHalt(adapter, v.chat_id, allowed, now, v.link_name || '대화방', g.askHalt.count, 'K bot')
            await this.roomLog(v.install_id, 'wave', { detail: { n: g.askHalt.count } })
          }
          this.sendAll(v, g.sends)
          v.dirty = true
        }
        return
      }
    }
    if (!R.roombotLive(v)) return
    const events = visitEventsFromMessage({ message: ev.text, message_type: 0, author_id: ev.authorId, attachment: ev.attachment })
    for (const e of events) {
      if (e.authorId && e.authorId === this.userId) continue
      await this.onVisit(v, { kind: e.kind, userId: e.authorId || '', name: e.authorName || '', logId: ev.logId, at: ev.at })
    }
  }

  ctxFor(v) {
    const now = this.now()
    return {
      selfId: this.userId,
      permOf: (uid) => {
        if (uid === this.userId) return v.perm
        const p = v.perms.get(String(uid))
        return p && now - p.at < 10 * MIN ? p.mt : null
      },
    }
  }

  // 작성자 권한(모르면 MEMBER 로 읽어 10분 둔다)
  async permOf(v, userId) {
    const uid = String(userId || '')
    if (!uid) return null
    if (uid === this.userId) return v.perm
    const hit = v.perms.get(uid)
    if (hit && this.now() - hit.at < 10 * MIN) return hit.mt
    const card = await this.memberCard(v, uid)
    return card ? card.perm : null
  }

  async memberCard(v, userId) {
    try {
      const rows = await this.client.getMembersByIds(v.chat_id, [String(userId)])
      const row = (rows || []).find((x) => x && String(x.user_id) === String(userId))
      if (!row) return null
      const perm = row.open_permission == null ? null : Number(row.open_permission)
      if (perm != null) v.perms.set(String(userId), { mt: perm, at: this.now() })
      return {
        name: String(row.nickname || '').trim().slice(0, 40),
        status: row.status_message == null ? null : String(row.status_message),
        perm,
        pli: row.open_profile_link_id ? String(row.open_profile_link_id) : '',
        photo: photoOf(row),
      }
    } catch (e) {
      log(this.id, `member read failed: ${errText(e)}`)
      return null
    }
  }

  async profileLink(pli) {
    const li = String(pli || '')
    if (!/^[1-9][0-9]*$/.test(li)) return ''
    const got = await this.linksFor([li])
    return got.get(li) || ''
  }

  // pli(사람의 오픈프로필 링크 id) → 옾링 주소. 봇마다 메모리에 둔다. 모르는 것만 20개씩 INFOLINK 로 읽는다.
  // 읽지 못한 묶음(실패 status·응답 없음)은 캐시에 넣지도 돌려주지도 않는다(모름) → 다음 동기화가 다시 읽는다.
  // 묶음이 실패하면(속도 제한 아님) 나눠 다시 읽는다: 읽지 못하는 사람(공개 옾링이 없는 프로필 등)이 하나라도 있으면
  //   카카오가 묶음 전체를 거절한다. 반으로 나눠 한쪽만 실패하면 그쪽을 다시 나누고, 두 쪽 다 실패하면 하나씩 읽는다.
  //   혼자서도 실패하는 사람은 모름으로 두고 BAD_LINK_MS 동안 묶음 읽기에서 뺀다(안내 전에는 linkNow 가 다시 읽는다).
  //   두 쪽 다 실패하면 옾링을 아는 사람 하나로 INFOLINK 가 되는지 먼저 확인한다. 확인이 실패하면 INFOLINK 자체가
  //   안 되는 것으로 보고 멈춘다(모름).
  //   다시 읽기는 한 번에 LINK_RETRY_MAX 번까지(남은 사람은 다음 동기화가 이어서 읽는다).
  // 속도 제한(-312·-805·-819)이면 멈추고 rateWaits 첫 값 동안 INFOLINK 를 보내지 않는다.
  async linksFor(plis) {
    const out = new Map()
    const want = []
    const now = this.now()
    for (const li of plis || []) {
      if (!/^[1-9][0-9]*$/.test(String(li || ''))) continue
      if (this.linkCache.has(li)) out.set(li, this.linkCache.get(li))
      else if (now - (this.emptyLinks.get(li) || -Infinity) < EMPTY_LINK_MS) out.set(li, '')
      else if (now - (this.badLinks.get(li) || -Infinity) < BAD_LINK_MS) continue
      else if (!want.includes(li)) want.push(li)
    }
    let sent = 0
    let extra = 0
    let okSeen = false
    let probed = ''
    let status = null
    const bad = []
    const send = async (lis) => {
      if (sent++ && this.opts.linkGapMs) await new Promise((ok) => setTimeout(ok, this.opts.linkGapMs))
      const r = await this.raw('INFOLINK', { lis: lis.map((x) => L(x)) })
      if (R.locoOk(r)) {
        okSeen = true
        return r
      }
      status = R.locoStatus(r)
      this.ratePause(status)
      return null
    }
    const read = async (part) => {
      const r = await send(part)
      if (!r) return RATE_STATUS.has(status) ? 'rate' : 'fail'
      const got = new Map()
      for (const row of (r.body && Array.isArray(r.body.ols) ? r.body.ols : [])) {
        const li = R.idText(row && row.li)
        if (li) got.set(li, R.profileUrl(row && row.lu))
      }
      for (const li of part) {
        const lu = got.get(li) || ''
        if (lu) this.linkCache.set(li, lu)
        else this.emptyLinks.set(li, this.now())
        out.set(li, lu)
      }
      return 'ok'
    }
    // 이번에 된 읽기가 없으면 옾링을 아는 사람 하나를 읽어 INFOLINK 가 되는지 본다
    const works = async () => {
      if (okSeen) return true
      if (probed) return false
      const li = this.linkProbe(want)
      probed = li ? 'failed' : 'none'
      if (li && await send([li])) probed = 'ok'
      return okSeen
    }
    const unreadable = (li) => {
      this.badLinks.set(li, this.now())
      bad.push(li)
    }
    const more = () => extra < LINK_RETRY_MAX && this.readPauseUntil <= this.now()
    // 실패한 묶음을 다시 읽는다 → 'done' | 'rate' | 'down' | 'stop'(다시 읽기 한도)
    const retry = async (part) => {
      if (part.length === 1) {
        if (!(await works())) return this.readPauseUntil > this.now() ? 'rate' : 'down'
        unreadable(part[0])
        return 'done'
      }
      const h = Math.ceil(part.length / 2)
      const halves = [part.slice(0, h), part.slice(h)]
      const res = []
      for (const x of halves) {
        if (!more()) return this.readPauseUntil > this.now() ? 'rate' : 'stop'
        extra++
        const st = await read(x)
        if (st === 'rate') return st
        res.push(st)
      }
      if (res[0] === 'fail' && res[1] === 'fail') {
        if (!(await works())) return this.readPauseUntil > this.now() ? 'rate' : 'down'
        // 두 쪽 다 실패: 읽지 못하는 사람이 많다 → 하나씩 읽는다
        for (const x of halves) {
          if (x.length === 1) {
            unreadable(x[0])
            continue
          }
          for (const li of x) {
            if (!more()) return this.readPauseUntil > this.now() ? 'rate' : 'stop'
            extra++
            const st = await read([li])
            if (st === 'rate') return st
            if (st === 'fail') unreadable(li)
          }
        }
        return 'done'
      }
      for (let k = 0; k < 2; k++) {
        if (res[k] !== 'fail') continue
        const st = await retry(halves[k])
        if (st !== 'done') return st
      }
      return 'done'
    }
    let end = ''
    for (let i = 0; i < want.length; i += 20) {
      if (this.readPauseUntil > this.now()) {
        end = 'rate'
        break
      }
      const part = want.slice(i, i + 20)
      const st = await read(part)
      if (st === 'rate') {
        end = st
        break
      }
      if (st === 'fail' && more()) {
        const how = await retry(part)
        if (how === 'rate' || how === 'down') {
          end = how
          break
        }
      }
    }
    if (this.emptyLinks.size > 20000) for (const k of [...this.emptyLinks.keys()].slice(0, 5000)) this.emptyLinks.delete(k)
    if (this.badLinks.size > 5000) for (const k of [...this.badLinks.keys()].slice(0, 1000)) this.badLinks.delete(k)
    if (this.linkCache.size > 5000) for (const k of [...this.linkCache.keys()].slice(0, 1000)) this.linkCache.delete(k)
    const left = want.filter((li) => !out.has(li)).length
    if (status !== null && (left || bad.length)) {
      const why = end === 'rate' ? ' (rate limited)' : end === 'down' ? ' (stopped)' : ''
      const skip = bad.length ? ` · ${bad.length} unreadable alone` : ''
      const check = probed ? ` · check read ${probed}` : ''
      log(this.id, `open link read failed: status ${status}${why} (${left} left unknown${skip}${check}, ${sent} reads)`)
    }
    return out
  }

  // 안내 바로 전에 한 사람의 옾링을 혼자 읽는다(묶음·나누기·다시 읽기 한도·badLinks 와 따로, 실패하면 한 번 더).
  // → 주소 | ''(없다고 답함) | null(읽지 못함·속도 제한으로 쉬는 중)
  async linkNow(pli) {
    const li = String(pli || '')
    if (!/^[1-9][0-9]*$/.test(li)) return ''
    if (this.linkCache.has(li)) return this.linkCache.get(li)
    if (this.now() - (this.emptyLinks.get(li) || -Infinity) < EMPTY_LINK_MS) return ''
    for (let k = 0; k < 2; k++) {
      if (this.readPauseUntil > this.now()) return null
      if (k && this.opts.linkGapMs) await new Promise((ok) => setTimeout(ok, this.opts.linkGapMs))
      const r = await this.raw('INFOLINK', { lis: [L(li)] })
      if (R.locoOk(r)) {
        const rows = r.body && Array.isArray(r.body.ols) ? r.body.ols : []
        const row = rows.find((x) => R.idText(x && x.li) === li)
        const lu = row ? R.profileUrl(row.lu) : ''
        if (lu) this.linkCache.set(li, lu)
        else this.emptyLinks.set(li, this.now())
        this.badLinks.delete(li)
        return lu
      }
      const st = R.locoStatus(r)
      this.ratePause(st)
      if (RATE_STATUS.has(st)) return null
    }
    return null
  }

  // 명부의 이 사람이 오픈프로필(pli)인데 옾링을 모르거나 비어 있으면('' 은 예전 읽기 실패일 수 있다) 안내 전에 혼자 읽어 적는다
  async fillLink(v, uid) {
    const m = v.members.get(uid)
    if (!m || !m.pli || m.link) return
    const link = await this.linkNow(m.pli)
    const cur = v.members.get(uid)
    if (link == null || !cur || cur.pli !== m.pli || cur.link) return
    const next = Object.assign({}, cur, { link })
    v.members.set(uid, next)
    v.membersDirty.add(uid)
    if (!needsCard(next)) {
      v.memberWant.delete(uid)
      v.memberFails.delete(uid)
    }
  }

  // INFOLINK 가 되는지 볼 pli 하나: 옾링을 읽어 둔 사람(캐시, 없으면 명부). 지금 읽으려는 것(want)은 빼고.
  linkProbe(want) {
    for (const [li, lu] of this.linkCache) if (lu && !want.includes(li)) return li
    for (const v of this.byInstall.values()) {
      if (!v || !v.members) continue
      for (const m of v.members.values()) if (m && m.pli && m.link && !want.includes(m.pli)) return m.pli
    }
    return ''
  }

  async memberIdByName(v, name) {
    const want = String(name || '').trim()
    if (!want) return ''
    try {
      const body = await this.client.executeWithReconnect(async ({ session }) => {
        const r = await session.getAllMembers(L(v.chat_id))
        return r && r.body
      })
      const ids = []
      for (const m of (body && body.members) || []) {
        const nm = String((m && (m.nickName || m.nickname || m.nn)) || '').trim()
        const id = R.idText(m && m.userId)
        if (nm === want && id && !ids.includes(id)) ids.push(id)
      }
      return ids.length === 1 ? ids[0] : ''
    } catch {
      return ''
    }
  }

  // 입장·퇴장 1건(7.2 (a)(b)(c) + 입장·퇴장 로그)
  async onVisit(v, ev) {
    const cfg = v.cfg
    const rt = v.runtime
    const now = this.now()
    if (!rt.evSeen || typeof rt.evSeen !== 'object') rt.evSeen = {}
    if (R.visitDedup(rt.evSeen, v.chat_id, ev, now)) return
    v.dirty = true
    if (!ev.userId && ev.name && ev.kind === 'join' && cfg.churn.enabled) ev.userId = await this.memberIdByName(v, ev.name)
    let card = null
    if (ev.kind === 'join' && ev.userId && (cfg.visit.enabled || cfg.profile.enabled)) card = await this.memberCard(v, ev.userId)
    // 들어온 사람은 카드(닉네임·옾링)를 명부에 합치고, 나간 사람은 명부에서 찾는다.
    // 명부는 봇이 들어간 뒤 방 전체를 읽어 둔 것이라, 봇보다 먼저 있던 사람이 나가도 옾링이 있다.
    if (card) {
      await this.mergeMembers(v, [{ uid: ev.userId, name: card.name || ev.name || '', pli: card.pli || '', photo: card.photo }], 'join')
      // 입장 안내를 보낼 때만 옾링을 모르면 혼자 한 번 더 읽는다
      if (cfg.visit.enabled && R.roombotLive(v)) await withTimeout(this.fillLink(v, ev.userId), LEAVE_READ_MS).catch(() => {})
    }
    // 명부에 없는(카드를 못 읽은) 사람·옾링을 모르는 사람이 나가면 퇴장 안내를 만들기 전에 한 번 짧게 읽어 본다
    if (ev.kind === 'leave' && ev.userId && cfg.visit.enabled) {
      const known = v.members.get(ev.userId)
      if (needsCard(known) || (known && known.pli && !known.link)) await this.leaveCard(v, ev.userId, known)
    }
    const mem = ev.userId ? v.members.get(ev.userId) : null
    const adapter = R.adapterRecord(v, this.id)
    const g = guardOnChat(adapter, {
      kind: ev.kind, chatId: v.chat_id, authorId: ev.userId, authorName: (card && card.name) || ev.name || (mem && mem.name) || '',
      profileLink: noticeLink(mem),
      mine: false, now, at: ev.at, logId: ev.logId,
    })
    this.sendAll(v, g.sends)
    const ctx = this.ctxFor(v)
    if (ev.kind === 'join') {
      // 재입장 차단을 끈 방이나, 적어 둔 뒤 제외 대상·방장·부방장이 된 사람은 내보내지 않는다(적어 둔 것은 그대로 둔다)
      if (ev.userId && cfg.leaveKick.enabled && !R.protectedPerson(cfg, ctx, ev.userId) && R.bannedNow(rt, ev.userId, now)) {
        // 나간 뒤 내보내지 못한 사람이 다시 들어왔다: 지금은 방 안이라 내보낼 수 있다(7.2(b))
        const name = ev.name || (rt.bans[ev.userId] && rt.bans[ev.userId].name) || ''
        const r = await this.kick(v, ev.userId, name, 'leave')
        if (r.ok) {
          delete rt.bans[ev.userId]
          if (cfg.leaveKick.notice) this.say(v, R.leaveKickNotice(name, this.now()), { what: 'notice' })
        }
        return
      }
      if (!rt.churn || typeof rt.churn !== 'object') rt.churn = {}
      const plan = R.churnCheck(rt.churn, cfg, { kind: 'join', userId: ev.userId, name: (card && card.name) || ev.name, at: ev.at }, ctx, now)
      if (plan) await this.doChurn(v, plan)
      return
    }
    const lk = R.leaveKickPlan(cfg, ev, ctx)
    if (lk) await this.doLeaveKick(v, lk)
  }

  async doChurn(v, plan) {
    let result = 'warn'
    if (plan.action === 'kick') {
      const r = await this.kick(v, plan.userId, plan.name, 'churn')
      result = r.ok ? 'kicked' : 'kick_failed'
    }
    const detail = { windowMin: plan.windowMin, joins: plan.count, action: plan.action }
    if (plan.idUnknown) detail.note = 'id 확인 불가'
    await this.roomLog(v.install_id, 'churn', { user_id: plan.userId || null, name: plan.name, ok: result !== 'kick_failed', detail })
    if (plan.notice) {
      const n = R.churnNotice(plan, result, this.now())
      this.say(v, n.text, { mention: n.mention, what: 'notice' })
    }
  }

  async doLeaveKick(v, plan) {
    if (plan.type === 'kick_fail') {
      await this.roomLog(v.install_id, 'kick_fail', { name: plan.name, ok: false, detail: { why: 'leave', note: plan.note } })
      return
    }
    const r = await this.kick(v, plan.userId, plan.name, 'leave', true)
    if (r.ok) {
      if (v.cfg.leaveKick.notice) this.say(v, R.leaveKickNotice(plan.name, this.now()), { what: 'notice' })
      return
    }
    // 내보내지 못하면(카카오가 받지 않음, 또는 연속 실패 멈춤·올킥 감지·한도로 건너뜀) 30일 안에 다시 들어오는 즉시 내보낸다.
    // 방 관리봇이 꺼져 있어 건너뛴 것만 적지 않는다.
    if (!r.skipped || r.held) {
      R.noteBan(v.runtime, plan.userId, plan.name, this.now())
      v.dirty = true
      // 건너뛴 사람도 패널의 「K bot이 내보낸 사람」 표(kick·kick_fail 기록)에 올라 해제할 수 있게
      if (r.skipped) await this.roomLog(v.install_id, 'kick_fail', { user_id: plan.userId, name: plan.name, ok: false, detail: { why: 'leave' } })
    }
  }

  // ── 조치(5.5) ───────────────────────────────────────────────────────────
  async openAction(v, method, extra) {
    if (!v.link_id || !v.chat_id) return { ok: false, status: -1 }
    const r = await this.raw(method, Object.assign({ li: L(v.link_id), c: L(v.chat_id) }, extra || {}))
    return { ok: R.locoOk(r), status: R.locoStatus(r) }
  }

  // 강퇴는 재시도하지 않는다. 한도를 넘으면 건너뛰고 skip 기록.
  // 연속 실패 멈춤·올킥 감지·한도로 건너뛰면 held(부르는 쪽이 나중에 내보내려고 적어 둘 수 있다).
  // left: 이미 나간 사람(7.2 (b)). 카카오가 받지 않아도(실측 전, 10.1 #5) 권한만 다시 읽고 연속 실패로 세지 않는다(레이트리밋 답은 센다).
  // 건너뛴 결과에는 note('paused'·'wave'·'limit')와 다시 될 때까지의 분(waitMin)을 붙인다(!내보내기 답).
  // by: 방에서 「!내보내기」를 쓴 사람(기록 detail.by).
  async kick(v, userId, name, why, left = false, by = '') {
    const now = this.now()
    const uid = String(userId || '')
    const mins = (at) => Math.max(1, Math.ceil((at - now) / MIN))
    if (!uid) return { ok: false, skipped: true }
    if (!R.roombotLive(v)) return { ok: false, skipped: true }
    if (v.actPausedUntil > now) {
      await this.roomLog(v.install_id, 'skip', { user_id: uid, name, detail: { what: 'kick', note: 'paused' } })
      return { ok: false, skipped: true, held: true, note: 'paused', waitMin: mins(v.actPausedUntil) }
    }
    const g = v.runtime.guard
    if (g && g.halt && Number(g.halt[v.chat_id] || 0) > now) {
      await this.roomLog(v.install_id, 'skip', { user_id: uid, name, detail: { what: 'kick', note: 'wave' } })
      return { ok: false, skipped: true, held: true, note: 'wave', waitMin: mins(Number(g.halt[v.chat_id])) }
    }
    if (!v.limits.kick.ok(now) || !this.limits.kickH.ok(now) || !this.limits.kickD.ok(now)) {
      await this.roomLog(v.install_id, 'skip', { user_id: uid, name, detail: { what: 'kick' } })
      const free = Math.max(v.limits.kick.freeAt(now), this.limits.kickH.freeAt(now), this.limits.kickD.freeAt(now))
      return { ok: false, skipped: true, held: true, note: 'limit', waitMin: mins(free) }
    }
    v.limits.kick.add(now)
    this.limits.kickH.add(now)
    this.limits.kickD.add(now)
    this.ownKicks.set(uid, now)
    const r = await this.openAction(v, 'KICKMEM', { mid: L(uid) })
    const extra = by ? { by: String(by) } : {}
    if (r.ok) {
      v.failStreak = 0
      await this.roomLog(v.install_id, 'kick', { user_id: uid, name, detail: Object.assign({ why }, extra) })
      return { ok: true }
    }
    await this.roomLog(v.install_id, 'kick_fail', { user_id: uid, name, ok: false, detail: Object.assign({ why, status: r.status }, extra) })
    // 레이트리밋 답은 나간 사람이어도 센다(사람이 방에 있는지와 상관없이 카카오가 막는 것)
    await this.actionFailed(v, left && !RATE_STATUS.has(r.status))
    return { ok: false, status: r.status }
  }

  // opt.noCount: 부방장 글 — 카카오가 거절해도 봇 권한 실패로 세지 않는다(권한만 다시 읽는다)
  async hideOne(v, logId, type, opt) {
    const now = this.now()
    if (v.actPausedUntil > now) return { ok: false, skipped: true }
    if (!v.limits.hide.ok(now) || !this.limits.hide.ok(now)) return { ok: false, skipped: true, limit: true }
    v.limits.hide.add(now)
    this.limits.hide.add(now)
    const r = await this.openAction(v, 'REWRITE', { logId: L(logId), t: Number(type) || 1 })
    if (r.ok) {
      v.failStreak = 0
      const m = v.ring.find((x) => x.logId === String(logId))
      if (m) m.hidden = true
      return { ok: true }
    }
    await this.actionFailed(v, !!(opt && opt.noCount))
    return { ok: false, status: r.status }
  }

  // 강퇴·가리기가 실패하면 권한을 바로 다시 읽는다. 잃었으면 waiting_host, 아니면 연속 3회에 10분 멈춤.
  // noCount: 이미 나간 사람의 내보내기 실패 — 권한만 읽고 세지 않는다(나가는 사람이 많은 방이 멈추지 않게).
  async actionFailed(v, noCount = false) {
    const perm = await this.readPerm(v.chat_id, null)
    if (perm != null && !(perm & 5) && v.products.roombot) {
      await this.applyPerm(v, perm)
      return
    }
    if (noCount) return
    v.failStreak += 1
    if (v.failStreak >= 3) {
      v.failStreak = 0
      v.actPausedUntil = this.now() + 10 * MIN
    }
  }

  // ── 메시지(5.7) ─────────────────────────────────────────────────────────
  async onMessage(v, m) {
    // 저장본을 못 읽은 방이면 때가 되었을 때 뒤에서 한 번 더 읽어 본다. 기다리지 않는다 — 이 봇의 메시지 줄(enqueue)이
    // 읽기가 끝날 때까지 다른 방 메시지까지 붙잡게 된다. 이번 메시지는 아래에서 미니게임을 건너뛴다
    if (v.loadFailed && !v.loading && this.now() >= (v.loadRetryAt || 0)) this.bg(this.retryLoad(v), 'room_state retry')
    const cfg = v.cfg
    const now = this.now()
    const name = m.nick || (v.names.get(m.authorId) || '')
    const prefix = cfg.cmdPrefix
    const text = m.text || ''
    const mentions = R.mentionIds(m.attachment)
    const isCmd = text.trim().startsWith(prefix)
    // 보이스룸 명령어 찾기(실험): SENDER_VOICE_EXPERIMENT=1 일 때만 남겨 둔 탐색용 명령어.
    if (process.env.SENDER_VOICE_EXPERIMENT === '1' && isCmd) {
      const t = text.trim().slice(prefix.length).trim()
      const dm = /^보룸진단(?:\s+(전체))?$/.exec(t)
      if (dm) {
        const n = Number(await this.permOf(v, m.authorId))
        if (!(Number.isFinite(n) && (n & 5))) {
          this.say(v, '보룸 진단은 방장·부방장만 쓸 수 있어요.', { what: 'reply' })
          return
        }
        this.say(v, '보룸 진단 중… 잠시만요(약 5초).', { what: 'reply' })
        const r = await this.voiceDiag(v, !!dm[1])
        this.say(v, r.ok ? r.text : '진단을 돌리지 못했어요.', { what: 'reply' })
        return
      }
      const sm = /^보룸모양(?:찾기)?(?:\s+(16))?$/.exec(t)
      if (sm) {
        const n = Number(await this.permOf(v, m.authorId))
        if (!(Number.isFinite(n) && (n & 5))) {
          this.say(v, '보룸 모양찾기는 방장·부방장만 쓸 수 있어요.', { what: 'reply' })
          return
        }
        this.say(v, `${sm[1] ? '보이스룸' : '제목'} 으로 SETMETA 바디 모양을 하나씩 바꿔 보는 중… 잠시만요(약 5초).`, { what: 'reply' })
        const r = await this.voiceShape(v, sm[1] ? 16 : 3)
        this.say(v, r.ok ? r.text : '모양찾기를 돌리지 못했어요.', { what: 'reply' })
        return
      }
      if (t === '보룸쓰기시험' || t === '보룸쓰기') {
        const n = Number(await this.permOf(v, m.authorId))
        if (!(Number.isFinite(n) && (n & 5))) {
          this.say(v, '보룸 쓰기시험은 방장·부방장만 쓸 수 있어요.', { what: 'reply' })
          return
        }
        this.say(v, '보이스룸이 아닌 메타를 써 보는 중… 잠시만요(약 2초).', { what: 'reply' })
        const r = await this.voiceWriteTest(v)
        this.say(v, r.ok ? r.text : '쓸 수 있는 메타를 찾지 못했어요.', { what: 'reply' })
        return
      }
      if (t === '보룸따라') {
        const n = Number(await this.permOf(v, m.authorId))
        if (!(Number.isFinite(n) && (n & 5))) {
          this.say(v, '보룸 따라쓰기는 방장·부방장만 쓸 수 있어요.', { what: 'reply' })
          return
        }
        this.say(v, '카카오가 써 둔 보이스룸 메타를 따라 써 보는 중… 잠시만요(약 5초).', { what: 'reply' })
        const r = await this.voiceMirror(v)
        this.say(v, r.ok ? r.text : (r.error === 'no_voice_meta' ? '이 방엔 카카오가 써 둔 보이스룸 메타가 없어요. 전에 보이스룸이 열린 적 있는 방에서 쳐 주세요.' : '따라쓰기를 돌리지 못했어요.'), { what: 'reply' })
        return
      }
      if (t === '보룸찾기') {
        const n = Number(await this.permOf(v, m.authorId))
        if (!(Number.isFinite(n) && (n & 5))) {
          this.say(v, '보룸 찾기는 방장·부방장만 쓸 수 있어요.', { what: 'reply' })
          return
        }
        this.say(v, '보룸 명령어 후보를 찾는 중… 잠시만요(약 20초).', { what: 'reply' })
        const r = await this.voiceProbe(v)
        this.say(v, `REAL[${r.real}]\nFAKE[${r.fake}]\n튀는 후보: ${r.standout && r.standout.length ? r.standout.join(', ') : '없음'}`, { what: 'reply' })
        return
      }
    }
    if (v.products.roombot && m.logId) {
      // 가리기 링 버퍼·작성자 목록은 방 관리봇이 있는 방에서만(8.11)
      R.ringPush(v.ring, { logId: m.logId, type: m.type, authorId: m.authorId, name, at: m.at, cmd: isCmd && /가리기/.test(text) })
      if (m.authorId && name) v.names.set(m.authorId, name)
      if (v.names.size > 500) v.names.delete(v.names.keys().next().value)
    }
    const live = R.roombotLive(v)
    // 닉네임이 명부와 다르면 프로필 변경 확인(입장·퇴장 안내나 프로필 변경 감지가 켜진 방)
    if (live && m.authorId && m.nick && (cfg.visit.enabled || cfg.profile.enabled)) this.noteName(v, m.authorId, m.nick)
    if (R.isHelpCommand(text, prefix)) {
      const line = R.helpLine(v)
      if (line) this.say(v, line, { what: 'reply' })
      return
    }
    // 보이스룸 봇(7.10): 「접두사+보룸켜기 [제목]」·「보룸끄기」·「보룸」(남은 시간). 켜고 끄기는 방장·부방장만.
    // 방장·부방장이 아닌 사람의 명령어 글은 아래 홍보·금지어 검사를 그대로 받는다(roomCommand 와 같은 규칙).
    if (v.products.roombot && isCmd) {
      const vc = VR.parseVoiceCommand(text, prefix)
      if (vc && await this.voiceChat(v, vc, m, name)) return
    }
    if (live && cfg.hide.command) {
      const hc = R.parseHideCommand(text, prefix, mentions)
      if (hc) {
        await this.hideCommand(v, m, hc)
        return
      }
    }
    if (v.products.roombot && R.isAdminHelpCommand(text, prefix)) {
      const line = R.adminHelp(v)
      if (line) this.say(v, line, { what: 'reply' })
      return
    }
    // 방 관리 명령어(7.2 (g)): 답한 명령어는 게임으로 넘기지 않는다. 방장·부방장이 아닌 사람의 명령어 글도 홍보·금지어 검사는 받는다.
    const rc = v.products.roombot ? await this.roomCommand(v, m, mentions) : null
    if (rc && rc.staff) return
    const adapter = R.adapterRecord(v, this.id)
    if (live) {
      let promo = null
      const pev = { userId: m.authorId, name, type: m.type, text, attachment: m.attachment }
      if (R.promoViolation(cfg, pev, this.ctxFor(v))) {
        await this.permOf(v, m.authorId)
        if (!v.runtime.promo || typeof v.runtime.promo !== 'object') v.runtime.promo = {}
        promo = R.promoCheck(v.runtime.promo, cfg, pev, this.ctxFor(v), now)
      }
      if (promo) {
        await this.doPromo(v, promo, m)
      } else {
        const coverEv = { chatId: v.chat_id, text, logId: m.logId, messageType: m.type, mine: false, staff: true }
        if (coverNeedsAuthor(adapter, coverEv)) coverEv.staff = R.hideSkips(cfg, await this.permOf(v, m.authorId))
        const plan = coverPlan(adapter, coverEv)
        // 가리기 범위(hide.target): 방장·봇 글은 늘, 부방장 글은 범위가 「부방장 글까지」일 때만 가린다
        const ap = plan ? await this.permOf(v, m.authorId) : null
        if (plan && !R.hideSkips(cfg, ap)) {
          const r = await this.hideOne(v, plan.logId, plan.type, { noCount: R.subHost(ap) })
          if (r.limit) await this.roomLog(v.install_id, 'skip', { user_id: m.authorId, name, detail: { what: 'hide' } })
          else await this.roomLog(v.install_id, 'cover', { user_id: m.authorId, name, ok: !!r.ok })
        }
      }
      const g = guardOnChat(adapter, { kind: 'msg', chatId: v.chat_id, text, authorId: m.authorId, authorName: name, mine: false, messageType: m.type, now })
      this.sendAll(v, g.sends)
      v.dirty = true
    }
    if (rc) return
    // 저장본을 못 읽은 방은 미니게임을 받지 않는다(빈 기록으로 검 강화가 새로 시작되지 않게, loadRuntime).
    // 이 메시지를 처리하는 사이에 다시 읽기가 끝났으면(runtime 이 바뀜) 옛 임시본에 쓰지 않게 이번 것은 건너뛴다
    if (R.gamesLive(v) && !v.loadFailed && adapter.runtime === v.runtime) {
      // 답이 바로 나갈 수 없으면(방 발송이 밀림 · 보낼 수 없는 방) 검 강화는 상태를 바꾸지 않는다(features swordReady)
      adapter.config.minigame.sendBusy = !v.chat_id || !v.licensed || this.pacer.backlog(String(v.install_id), now) >= GAME_BACKLOG_MAX
      const sends = onInbound(adapter, { chatId: v.chat_id, text, authorName: name, authorId: m.authorId, mentions, mentionLen: R.mentionLens(m.attachment), mine: false })
      this.sendAll(v, sends, 'reply')
      v.dirty = true
      if (sends.length) this.saveSoon(v)
    }
  }

  async doPromo(v, plan, m) {
    let hidden = false
    let kicked = false
    if (plan.hide && m.logId) {
      const r = await this.hideOne(v, m.logId, m.type)
      hidden = !!r.ok
      if (r.limit) await this.roomLog(v.install_id, 'skip', { user_id: plan.userId, name: plan.name, detail: { what: 'hide' } })
    }
    if (plan.kick) {
      const r = await this.kick(v, plan.userId, plan.name, 'promo')
      kicked = !!r.ok
    }
    await this.roomLog(v.install_id, 'promo', { user_id: plan.userId, name: plan.name, detail: { n: plan.n, why: plan.why, hidden, kicked } })
    if (plan.notice) {
      const n = R.promoNotice(plan, { hidden, kicked }, this.now())
      this.say(v, n.text, { mention: n.mention, what: 'notice' })
    }
    v.dirty = true
  }

  // ── 방 관리 명령어(7.2 (g)) ─────────────────────────────────────────────────
  // → null(방 관리 명령어가 아님 · 꺼 둔 명령어 → 게임 등 다음 처리로) | {staff}(답했다. staff 가 아니면 홍보·금지어 검사는 받는다)
  async roomCommand(v, m, mentions) {
    const cfg = v.cfg
    const c = C.parseRoomCommand(m.text, cfg.cmdPrefix)
    if (!c) return null
    if (c.cmd === 'link' && cfg.cmd.link === 'off') return null
    if (c.cmd === 'profile' && cfg.profile.lookup === 'off') return null
    const staff = C.isStaff(await this.permOf(v, m.authorId))
    const reply = (t) => { if (t) this.say(v, t, { what: 'reply' }) }
    const answer = (t) => {
      reply(t)
      return { staff }
    }
    if (!R.roombotLive(v)) {
      // 부방장 지정 대기: 방장·부방장에게만 지정이 먼저라고 알린다(방 관리 기능은 그 뒤에 동작한다)
      if (staff && v.state === 'waiting_host') reply(C.notLiveReply(this.nameIn(v)))
      return { staff }
    }
    const p = cfg.cmdPrefix
    if (c.cmd === 'link') {
      if (cfg.cmd.link === 'staff' && !staff) return answer(C.staffOnlyReply('link'))
      const who = await this.findPerson(v, c.arg, mentions, true)
      if (!who.userId) return answer(who.usage ? C.usageOf('link', p) : C.findFailReply(who))
      const mem = await this.freshMember(v, who.userId)
      if (!mem && !who.name) return answer(C.NOT_HERE_REPLY)
      return answer(C.linkReply({ name: (mem && mem.name) || who.name, link: mem ? noticeLink(mem) : who.link }))
    }
    if (c.cmd === 'profile') {
      if (!cfg.profile.enabled) {
        if (staff) reply(`프로필 기록이 꺼져 있어요. 「${p}프로필기록 켜기」로 켤 수 있어요.`)
        return { staff }
      }
      if (cfg.profile.lookup === 'staff' && !staff) return answer(C.staffOnlyReply('profile'))
      let target = null
      if (mentions.length || C.isLinkArg(c.arg)) {
        const who = await this.findPerson(v, c.arg, mentions, false)
        if (!who.userId) return answer(who.usage ? C.usageOf('profile', p) : C.findFailReply(who))
        target = { userId: who.userId, name: who.name || v.names.get(who.userId) || '' }
      } else if (c.arg) {
        // 닉네임: 명부의 지금 닉네임으로 찾고, 없으면 profileLookup 이 기록의 이름으로 찾는다
        const who = C.findPerson(this.bookOf(v), { arg: c.arg, allowName: true })
        if (who.many) return answer(C.findFailReply(who))
        if (who.userId) target = { userId: who.userId, name: who.name }
      }
      const out = R.profileLookup(v.runtime, v.chat_id, cfg, { authorId: m.authorId, arg: c.arg, mentions, target }, this.ctxFor(v), this.now())
      return answer(out)
    }
    if (!staff) return answer(C.staffOnlyReply(c.cmd))
    if (c.cmd === 'kick') {
      const who = await this.findPerson(v, c.arg, mentions, false)
      if (!who.userId) return answer(who.usage ? C.usageOf('kick', p) : C.findFailReply(who))
      const card = who.userId === this.userId ? null : await this.memberCard(v, who.userId)
      if (who.userId === this.userId || (card && R.protectedPerson(cfg, this.ctxFor(v), who.userId))) return answer(C.PROTECTED_REPLY)
      if (!card) return answer(C.NOT_HERE_REPLY)
      const name = card.name || who.name || ''
      const r = await this.kick(v, who.userId, name, 'command', false, m.authorId)
      return answer(C.kickReply(name, r))
    }
    if (c.cmd === 'unban') {
      const who = await this.findPerson(v, c.arg, mentions, true, true)
      if (!who.userId) return answer(who.usage ? C.usageOf('unban', p) : C.findFailReply(who))
      const r = await this.unkickUser(v, who.userId)
      const bans = v.runtime.bans || {}
      return answer(C.unbanReply(who.name || (bans[who.userId] && bans[who.userId].name) || '', r))
    }
    if (c.cmd === 'status') return answer(C.statusReply(cfg))
    const ch = C.configChange(cfg, c)
    if (!ch.patch) return answer(ch.reply)
    const ok = await this.changeConfig(v, ch.patch)
    if (ok) await this.roomLog(v.install_id, 'config', { user_id: m.authorId, name: m.nick || v.names.get(m.authorId) || '', detail: { text: ch.log, by: 'room' } })
    return answer(ok ? ch.reply : C.SAVE_FAIL_REPLY)
  }

  // 명부(멤버 명부 + 재입장 차단 목록)에서 사람 고르기. 옾링·닉네임으로 찾을 때 명부가 오래되었으면 먼저 한 번 읽는다.
  async findPerson(v, arg, mentions, allowName, withBans) {
    if (!(mentions && mentions.length) && arg) await this.ensureBook(v)
    return C.findPerson(this.bookOf(v, withBans), { mentions, arg, allowName })
  }

  // 명부 → [{userId, name, link, here}]. here: 마지막 동기화(GETMEM) 이후에 본 사람(모르면 true)
  bookOf(v, withBans) {
    const from = v.memberSeenFrom || 0
    const out = []
    for (const [uid, m] of v.members) out.push({ userId: uid, name: m.name, link: noticeLink(m), here: !from || Number(m.seenAt) >= from })
    if (withBans) {
      for (const [uid, b] of Object.entries((v.runtime && v.runtime.bans) || {})) {
        if (!v.members.has(uid) && b) out.push({ userId: uid, name: b.name || '', link: '', here: false })
      }
    }
    return out
  }

  // 옾링·닉네임으로 찾기 전: 명부를 30분 넘게 읽지 않았으면(입장·퇴장 기록·프로필 기록이 꺼진 방) 한 번 읽는다(최대 8초)
  async ensureBook(v) {
    const now = this.now()
    if (v.memberOkAt && now - v.memberOkAt < 30 * MIN) return
    if (this.readPauseUntil > now || this.memberBusy(v, 'memberSyncing', now)) return
    v.memberSyncing = true
    v.memberSyncAt = now
    v.memberJobAt = now
    const job = this.syncMembers(v).catch((e) => log(this.id, `member sync ${v.install_id} failed: ${errText(e)}`)).finally(() => { v.memberSyncing = false })
    await withTimeout(job, 8000).catch(() => {})
  }

  // 한 사람의 지금 카드(닉네임·옾링)를 읽어 명부에 합친다. 방에 없으면(카드가 없음) null.
  async freshMember(v, uid) {
    const card = await this.memberCard(v, uid)
    if (!card) return null
    await this.mergeMembers(v, [{ uid, name: card.name || '', pli: card.pli || '', photo: card.photo }], 'refresh')
    const m = v.members.get(uid)
    if (m && m.pli && !m.link) await withTimeout(this.fillLink(v, uid), LEAVE_READ_MS).catch(() => {})
    return v.members.get(uid) || null
  }

  // 방 안 설정 명령어의 저장: 저장본을 다시 읽어 patch 를 합치고 읽은 config_rev 일 때만 쓴다(패널 저장과 겹치면 다시, 3번까지).
  async changeConfig(v, patch) {
    for (let i = 0; i < 3; i++) {
      let row = null
      try {
        row = await this.store.getInstall(v.install_id)
      } catch (e) {
        log(this.id, `config read failed: ${errText(e)}`)
        return false
      }
      if (!row || row.phase !== 'installed' || row.bot_device_id !== this.id) return false
      const next = C.applyPatch(row.config, patch)
      const rev = Number(row.config_rev) || 0
      let n = 0
      try {
        n = await this.store.saveRoomConfig(v.install_id, this.id, next, rev, this.now())
      } catch (e) {
        log(this.id, `config save failed: ${errText(e)}`)
        return false
      }
      if (n) {
        v.cfg = R.normRoomConfig(next)
        v.rev = rev + 1
        v.revFloor = rev + 1
        return true
      }
    }
    return false
  }

  // ── 가리기(7.2 (e)) ─────────────────────────────────────────────────────
  async hideCommand(v, m, hc) {
    const p = await this.permOf(v, m.authorId)
    if (!R.canHideCommand(v.cfg, p)) {
      this.say(v, v.cfg.hide.by === 'host' ? '글 가리기는 방장만 할 수 있어요.' : '글 가리기는 방장과 부방장만 할 수 있어요.', { what: 'reply' })
      return
    }
    if (hc.usage) {
      this.say(v, R.hideUsage(v.cfg.cmdPrefix), { what: 'reply' })
      return
    }
    let req
    if (hc.userId) req = { userId: hc.userId }
    else if (hc.name) {
      if (!v.ringFilled) await this.fillRing(v)
      const ids = [...new Set(v.ring.filter((x) => x.name === hc.name && x.authorId).map((x) => x.authorId))]
      if (ids.length !== 1) {
        this.say(v, ids.length > 1 ? R.sameNameReply(ids.length) : `「${hc.name}」의 최근 글이 없어요.`, { what: 'reply' })
        return
      }
      req = { userId: ids[0] }
    } else req = { last: hc.last }
    const r = await this.startHide(v, req, m.authorId)
    if (!r.ok && r.error === 'busy') this.say(v, '이미 글을 가리는 중이에요. 끝난 뒤 다시 입력해 주세요.', { what: 'reply' })
  }

  async fillRing(v) {
    v.ringFilled = true
    try {
      const msgs = await this.client.getMessages(v.chat_id, { count: R.RING_MAX })
      for (const x of msgs || []) {
        const logId = R.idText(x && x.log_id)
        if (!logId) continue
        const authorId = R.idText(x.author_id)
        R.ringPush(v.ring, {
          logId, type: Number(x.type), authorId, name: String(x.author_name || v.names.get(authorId) || ''),
          at: atMs(x.sent_at), cmd: typeof x.message === 'string' && x.message.trim().startsWith(v.cfg.cmdPrefix + '가리기'),
        })
      }
    } catch (e) {
      log(this.id, `ring fill failed: ${errText(e)}`)
    }
  }

  async startHide(v, req, by) {
    const now = this.now()
    if (v.hideJob && v.hideJob.state === 'running') return { ok: false, error: 'busy' }
    if (by === 'panel' && Number(v.runtime.hideCooldownUntil || 0) > now) {
      return { ok: false, error: 'cooldown', retry_at: Number(v.runtime.hideCooldownUntil) }
    }
    if (!v.ringFilled) await this.fillRing(v)
    const items = R.hidePlan(v.ring, req, this.ctxFor(v), v.cfg)
    this.pool.jobSeq += 1
    const job = { id: `${v.install_id}.${this.pool.jobSeq}`, install_id: v.install_id, by, total: items.length, done: 0, failed: 0, state: 'running', at: now }
    this.pool.hideJobs.set(job.id, job)
    for (const [k, j] of this.pool.hideJobs) if (now - j.at > HOUR) this.pool.hideJobs.delete(k)
    v.hideJob = job
    this.bg(this.runHide(v, job, items), 'hide')
    return { ok: true, job: job.id }
  }

  async runHide(v, job, items) {
    let skipped = 0
    try {
      for (let i = 0; i < items.length; i++) {
        if (!this.live() || !R.roombotLive(v)) {
          job.failed += items.length - i
          break
        }
        const r = await this.hideOne(v, items[i].logId, items[i].type, { noCount: !!items[i].sub })
        if (r.ok) job.done += 1
        else {
          job.failed += 1
          if (r.limit) skipped += 1
        }
        if (this.opts.hideGapMs && i < items.length - 1) await new Promise((ok) => setTimeout(ok, this.opts.hideGapMs))
      }
    } finally {
      job.state = 'done'
      const now = this.now()
      if (job.by === 'panel') {
        v.runtime.hideCooldownUntil = now + 10 * MIN
        v.dirty = true
      }
      if (skipped) await this.roomLog(v.install_id, 'skip', { detail: { what: 'hide', n: skipped } })
      await this.roomLog(v.install_id, 'hide', {
        user_id: job.by === 'panel' ? null : job.by,
        ok: job.failed === 0,
        detail: { n: job.done, failed: job.failed, by: job.by === 'panel' ? 'panel' : 'host' },
      })
      if (job.total > 0) this.say(v, R.hideDoneNotice(job.done, job.failed), { what: 'notice' })
      else if (job.by !== 'panel') this.say(v, '가릴 글이 없어요.', { what: 'reply' })
    }
  }

  peopleOf(v) {
    const map = new Map()
    for (const m of v.ring) {
      if (!m.authorId || m.authorId === this.userId || Number(m.type) === 0) continue
      const row = map.get(m.authorId) || { user_id: m.authorId, name: '', count: 0 }
      row.count += 1
      if (m.name) row.name = m.name
      map.set(m.authorId, row)
    }
    return [...map.values()].sort((a, b) => b.count - a.count)
  }

  // 내보내기 해제: K bot 이 내보낸 사람(이 설치의 kick·kick_fail 기록, bans)만(3.4.3)
  async unkickUser(v, userId) {
    const uid = String(userId || '')
    if (!/^[1-9][0-9]*$/.test(uid)) return { ok: false, error: 'not_kicked' }
    const inBans = R.bannedNow(v.runtime, uid, this.now()) || !!(v.runtime.bans && v.runtime.bans[uid])
    const hist = await this.store.kickHistory(v.install_id, uid)
    if (!inBans && !hist.any) return { ok: false, error: 'not_kicked' }
    const name = (v.runtime.bans && v.runtime.bans[uid] && v.runtime.bans[uid].name) || v.names.get(uid) || ''
    if (hist.kicked) {
      const r = await this.openAction(v, 'KLDELITEM', { kid: L(uid) })
      if (!r.ok) {
        await this.actionFailed(v)
        return { ok: false, error: 'failed', status: r.status }
      }
    }
    if (v.runtime.bans) delete v.runtime.bans[uid]
    v.dirty = true
    await this.roomLog(v.install_id, 'unkick', { user_id: uid, name })
    return { ok: true }
  }

  // ── 방 멤버 명부(옾링) ──────────────────────────────────────────────
  // 봇이 방에 있는 동안 GETMEM 으로 모든 멤버의 닉네임·옾링을 읽어 둔다(입장 뒤 처음·10분마다·다시 시작한 뒤).
  // 그래서 봇이 들어가기 전부터 있던 사람이 나가도 퇴장 안내에 옾링을 적는다. 아는 사람이 바뀌었으면 프로필 변경 안내.
  // 명부 일(동기화·카드 채우기·다시 읽기)은 방 점검 줄(checks)과 따로 memberQ 에서 하나씩 한다.
  async loadMembers(v) {
    try {
      const rows = await this.store.loadMembers(v.install_id, v.membersChat, this.now() - 90 * DAY)
      for (const r of rows || []) {
        const uid = R.idText(r.user_id)
        if (!uid || v.members.has(uid)) continue
        v.members.set(uid, {
          name: String(r.name || ''),
          pli: r.pli == null ? null : String(r.pli),
          // pli 옆의 '' 는 예전 코드가 읽기 실패를 '없음'으로 저장한 것일 수 있다 → 모름으로 읽어 다시 확인한다
          link: r.link == null || (r.link === '' && r.pli) ? null : String(r.link),
          photo: r.photo == null ? null : String(r.photo),
          seenAt: Number(r.seen_at) || 0,
        })
        // 카드·옾링을 모르는 행(메시지로 이름만 본 사람·옾링 읽기가 실패한 사람)은 카드 채우기가 읽는다
        if (needsCard(v.members.get(uid))) v.memberWant.add(uid)
      }
    } catch (e) {
      log(this.id, `room_members read failed: ${errText(e)}`)
    }
  }

  async flushMembers(v) {
    if (!v.membersDirty.size || !v.membersChat) return
    const uids = [...v.membersDirty]
    v.membersDirty.clear()
    const rows = []
    for (const uid of uids) {
      const m = v.members.get(uid)
      // 사진은 주소만 적는다(그림은 저장하지 않는다)
      if (m) rows.push({ user_id: uid, name: m.name || '', pli: m.pli, link: m.link, photo: m.photo == null ? null : m.photo, seen_at: m.seenAt || this.now() })
    }
    try {
      await this.store.saveMembers(v.install_id, v.membersChat, rows)
    } catch (e) {
      for (const uid of uids) v.membersDirty.add(uid)
      log(this.id, `room_members save failed: ${errText(e)}`)
    }
  }

  // 명부 일 하나를 memberQ 에 넣는다. memberJobMs 를 넘기면 기다리지 않고 다음 일로 넘어간다(그 일은 뒤에서 마저 끝난다).
  // 방마다의 표시(memberSyncing 등)는 일이 실제로 끝날 때 내린다 → 같은 방의 같은 일이 겹치지 않는다.
  // 일 사이에는 memberGapMs 쉰다(다시 시작한 직후 모든 방의 GETMEM 이 한꺼번에 나가지 않게).
  memberJob(what, fn) {
    this.memberQ = this.memberQ
      .then(() => withTimeout(fn(), this.opts.memberJobMs))
      .catch((e) => log(this.id, `${what} ${e && e.timeout ? 'timed out' : 'failed: ' + errText(e)}`))
      .then(() => (this.opts.memberGapMs ? new Promise((ok) => setTimeout(ok, this.opts.memberGapMs)) : null))
  }

  // 속도 제한 답이면 rateWaits 첫 값 동안 명부 읽기(GETMEM·MEMBER·INFOLINK)를 쉰다
  ratePause(status) {
    if (RATE_STATUS.has(status)) this.readPauseUntil = Math.max(this.readPauseUntil, this.now() + (this.opts.rateWaits[0] || 0))
  }

  // 이 방의 명부 일 표시가 너무 오래 내려지지 않았으면(답이 끝내 안 온 일) 오래된 것으로 보고 푼다
  memberBusy(v, flag, now) {
    if (!v[flag]) return false
    if (now - v.memberJobAt < 5 * this.opts.memberJobMs) return true
    v[flag] = false
    return false
  }

  // 같은 방·같은 대화방인지(일을 기다리는 사이 방을 다시 만들었거나 대화방이 바뀌었으면 결과를 버린다)
  sameView(v, chat) {
    return this.live() && this.byInstall.get(v.install_id) === v && v.membersChat === chat
  }

  memberSync(v, now) {
    if (!v.chat_id || !R.roombotLive(v) || !(v.cfg.visit.enabled || v.cfg.profile.enabled)) return
    if (this.readPauseUntil > now) return
    if (this.memberBusy(v, 'memberSyncing', now) || (v.memberSyncAt && now - v.memberSyncAt < this.opts.memberSyncMs)) return
    v.memberSyncing = true
    v.memberSyncAt = now
    v.memberJobAt = now
    this.memberJob(`member sync ${v.install_id}`, () => this.syncMembers(v).finally(() => { v.memberSyncing = false }))
  }

  // GETMEM·MEMBER 의 멤버 하나 → {uid, name, pli, photo}. 봇 자신·id 없는 것은 null.
  memberRow(m) {
    const uid = R.idText(m && m.userId)
    if (!uid || uid === this.userId) return null
    return {
      uid,
      name: String(m.nickName || m.nickname || m.nn || '').trim().slice(0, 40),
      pli: R.idText(m.pli) || '',
      photo: photoOf(m),
    }
  }

  async syncMembers(v) {
    const chat = v.membersChat
    if (!this.sameView(v, chat) || !v.chat_id) return
    const t0 = this.now()
    const r = await this.raw('GETMEM', { chatId: L(v.chat_id) })
    const list = R.locoOk(r) && r.body && Array.isArray(r.body.members) ? r.body.members : null
    if (!list) {
      this.ratePause(R.locoStatus(r))
      this.memberFailLog(v, `member sync ${v.install_id}: GETMEM failed (status ${R.locoStatus(r)})`)
      return
    }
    if (!this.sameView(v, chat)) return
    const rows = list.map((m) => this.memberRow(m)).filter(Boolean)
    await this.mergeMembers(v, rows, 'sync')
    v.memberOkAt = this.now()
    v.memberSeenFrom = t0
    // 숫자만 남긴다(이름·주소는 남기지 않는다). pli·옾링 수로 실제 GETMEM 이 옾링을 주는지도 본다.
    // 수가 같으면 1시간에 한 번만(방이 많으면 10분마다 방마다 한 줄은 너무 많다)
    let links = 0
    for (const x of rows) { const m = v.members.get(x.uid); if (m && m.link) links++ }
    const key = `${rows.length} members, ${rows.filter((x) => x.pli).length} with pli, ${links} with link`
    const now = this.now()
    if (key !== v.memberLog || now - v.memberLogAt >= MEMBER_LOG_MS) {
      v.memberLog = key
      v.memberLogAt = now
      log(this.id, `member sync ${v.install_id}: ${key}, ${now - t0}ms`)
    }
  }

  // 명부 읽기 실패 줄은 방마다 10분에 한 번만
  memberFailLog(v, line) {
    const now = this.now()
    if (now - v.memberFailLogAt < 10 * MIN) return
    v.memberFailLogAt = now
    log(this.id, line)
  }

  // 카드(옾링)를 아직 못 읽은 사람(memberWant)을 MEMBER 로 채운다. 방마다 60초에 1번, 한 번에 20명까지.
  // 동기화 중이면 동기화가 채우므로 기다린다.
  memberFill(v, now) {
    if (!v.memberWant.size || this.memberBusy(v, 'memberFilling', now) || v.memberSyncing || now - v.memberFillAt < MEMBER_FILL_GAP_MS) return
    if (!v.chat_id || !R.roombotLive(v) || !(v.cfg.visit.enabled || v.cfg.profile.enabled)) return
    if (this.readPauseUntil > now) return
    const ids = [...v.memberWant].slice(0, MEMBER_FILL_MAX)
    v.memberFilling = true
    v.memberFillAt = now
    v.memberJobAt = now
    this.memberJob(`member fill ${v.install_id}`, () => this.fillMembers(v, ids).finally(() => { v.memberFilling = false }))
  }

  // pli 를 이미 아는 사람은 옾링만(INFOLINK), 나머지는 카드(MEMBER)를 읽는다.
  // 읽지 못한 사람은 줄 뒤로 보내고(같은 20명만 되풀이하지 않게) 세 번 못 읽으면 뺀다.
  async fillMembers(v, ids) {
    const chat = v.membersChat
    if (!this.sameView(v, chat)) return
    const linkOnly = []
    const cardIds = []
    for (const uid of ids) {
      const m = v.members.get(uid)
      if (m && m.pli && m.link == null) linkOnly.push(uid)
      else cardIds.push(uid)
    }
    let rows = []
    const failed = []
    if (cardIds.length) {
      const got = await this.readMembers(v, cardIds)
      if (got) rows = got
      else failed.push(...cardIds)
    }
    if (!this.sameView(v, chat)) return
    for (const uid of linkOnly) {
      const m = v.members.get(uid)
      rows.push({ uid, name: m.name || '', pli: m.pli })
    }
    // 답이 없는 사람(이미 나감)은 다시 읽지 않는다
    for (const uid of cardIds) if (!failed.includes(uid)) v.memberWant.delete(uid)
    if (rows.length) await this.mergeMembers(v, rows, 'refresh')
    for (const uid of [...failed, ...linkOnly]) {
      if (!v.memberWant.has(uid)) {
        v.memberFails.delete(uid)
        continue
      }
      const n = (v.memberFails.get(uid) || 0) + 1
      v.memberWant.delete(uid)
      if (n >= MEMBER_FAIL_MAX) {
        v.memberFails.delete(uid)
        continue
      }
      v.memberFails.set(uid, n)
      v.memberWant.add(uid)          // 줄 뒤로
    }
  }

  // MEMBER 1회(다시 접속하지 않음) → [{uid, name, pli, photo}] | null(읽지 못함)
  async readMembers(v, ids) {
    const r = await this.raw('MEMBER', { chatId: L(v.chat_id), memberIds: ids.map((x) => L(x)) })
    const list = R.locoOk(r) && r.body && Array.isArray(r.body.members) ? r.body.members : null
    if (!list) {
      this.ratePause(R.locoStatus(r))
      this.memberFailLog(v, `member read ${v.install_id}: MEMBER failed (status ${R.locoStatus(r)})`)
      return null
    }
    return list.map((m) => this.memberRow(m)).filter((x) => x && ids.includes(x.uid))
  }

  // 명부에 없는(카드를 못 읽은) 사람이 나갔다: 한 줄 남기고, 방마다 10초에 한 번 MEMBER 를 2초까지만 읽어 본다.
  // 나간 사람에게도 MEMBER 가 답하는지는 실측 전이다. 푸시 줄(chain)에서 도므로 짧게 끊고, 퇴장 안내는 그 뒤에 만든다.
  // pli 는 아는데 옾링만 모르면(옾링 읽기가 실패·쉬는 중이었음) INFOLINK 하나만 읽는다(10초 간격 없이).
  async leaveCard(v, uid, known) {
    const now = this.now()
    const linkOnly = !!(known && known.pli && !known.link)
    let got = 'skipped'
    if ((linkOnly || now - v.leaveReadAt >= LEAVE_READ_GAP_MS) && this.readPauseUntil <= now) {
      if (!linkOnly) v.leaveReadAt = now
      got = await withTimeout((async () => {
        if (linkOnly) {
          await this.fillLink(v, uid)
          const m = v.members.get(uid)
          if (!m || m.link == null) return 'failed'
          return m.link ? 'link' : 'no link'
        }
        const rows = await this.readMembers(v, [uid])
        if (!rows) return 'failed'
        if (!rows.length) return 'no card'
        await this.mergeMembers(v, rows, 'leave')
        return 'card'
      })(), LEAVE_READ_MS).catch((e) => (e && e.timeout ? 'timed out' : 'failed: ' + errText(e)))
    }
    const ago = v.memberOkAt ? `${Math.round((now - v.memberOkAt) / 1000)}s ago` : 'never'
    const what = !known ? 'not in' : linkOnly ? 'has no link in' : 'has no card in'
    log(this.id, `leave ${v.install_id}: ${uid} ${what} the member book (book ${v.members.size}, last sync ${ago}), ${linkOnly ? 'link' : 'member'} read: ${got}`)
  }

  // 새로 읽은 값(rows: {uid, name, pli, photo}, null = 모름)을 명부에 합친다. 옾링은 새로 보거나 바뀐 pli 와
  // 옾링이 아직 비어 있는('' 포함: 예전 읽기 실패가 '없음'으로 남았을 수 있다) pli 만 읽는다(읽어 둔 것은 캐시에서).
  // why 'sync'·'refresh' 면 아는 사람의 변경을 프로필 변경으로 알린다. 'join'(입장 안내가 대신)·'leave' 는 조용히 합친다.
  async mergeMembers(v, rows, why) {
    const need = []
    for (const r of rows) {
      const prev = v.members.get(r.uid)
      if (r.pli && !(prev && prev.pli === r.pli && prev.link)) need.push(r.pli)
    }
    const links = need.length ? await this.linksFor(need) : new Map()
    const now = this.now()
    const announce = []
    for (const r of rows) {
      const prev = v.members.get(r.uid) || null
      // 카드 한 장(MEMBER)이 pli 를 주지 않았다고 아는 오픈프로필을 지우지 않는다(지우는 것은 방 전체 동기화 GETMEM 만)
      const keepPli = why !== 'sync' && why !== 'join' && r.pli === '' && !!(prev && prev.pli)
      const pliKnown = r.pli !== null && r.pli !== undefined && !keepPli
      let link
      if (!pliKnown) link = prev ? prev.link : null
      else if (!r.pli) link = ''
      else if (links.has(r.pli)) link = links.get(r.pli)
      else link = prev && prev.pli === r.pli ? prev.link : null
      const next = {
        name: r.name || (prev && prev.name) || '',
        pli: pliKnown ? r.pli : (prev ? prev.pli : null),
        link,
        // 사진 주소(카드 동그라미). 모르면 예전 것. 사진만 바뀐 것은 안내하지 않는다(조용히 바꿔 둔다)
        photo: r.photo != null ? String(r.photo) : (prev && prev.photo != null ? prev.photo : null),
        seenAt: now,
      }
      v.members.set(r.uid, next)
      v.membersDirty.add(r.uid)
      if (!needsCard(next)) {
        v.memberWant.delete(r.uid)
        v.memberFails.delete(r.uid)
      } else if (!v.memberFails.has(r.uid)) {
        v.memberWant.add(r.uid)      // 옾링을 못 읽었다(읽기 실패·쉬는 중) → 카드 채우기가 다시 읽는다
      }
      if (!prev || (why !== 'sync' && why !== 'refresh')) continue
      // 안내할 거리가 있을 때만(닉네임이 바뀜·아는 pli 가 바뀜) 모은다
      if (!(prev.name && next.name && prev.name !== next.name) && (prev.pli == null || prev.pli === next.pli)) continue
      // 옾링은 pli 에서 나온다. pli 가 같으면 옾링은 바뀐 것이 아니다('' → 주소는 다시 읽어 고친 것) → 옾링 변경은 pli 가 바뀔 때만
      announce.push({ uid: r.uid, before: prev.pli === next.pli ? Object.assign({}, prev, { link: null }) : prev, after: next })
    }
    // 안내 전에 옾링을 모르는 사람은 혼자 한 번 더 읽는다(묶음 읽기가 실패했어도 '없음'으로 나가지 않게)
    let reads = 0
    for (const x of announce) {
      if (!R.roombotLive(v) || !v.cfg.profile.enabled) break
      const m = v.members.get(x.uid)
      if (m && m.pli && !m.link && reads < NOTICE_LINK_MAX) {
        reads++
        await this.fillLink(v, x.uid)
      }
      const after = v.members.get(x.uid) || x.after
      this.announceProfile(v, x.uid, x.before, Object.assign({}, after, { link: noticeLink(after) }))
    }
  }

  announceProfile(v, uid, before, after) {
    if (!R.roombotLive(v) || !v.cfg.profile.enabled) return
    const sends = R.profileChange(v.runtime, v.chat_id, v.cfg.profile, { userId: uid, before, after }, this.now())
    if (!sends.length) return
    this.sendAll(v, sends)
    v.dirty = true
  }

  // 메시지의 작성자 닉네임이 명부와 다르면 그 사람 카드를 다시 읽어(옾링 포함) 비교한다.
  noteName(v, uid, name) {
    const nm = String(name || '').trim().slice(0, 40)
    if (!nm || !uid || uid === this.userId) return
    const prev = v.members.get(uid)
    if (!prev) {
      // 명부에 아직 없다(동기화 전·GETMEM 이 빠뜨린 사람): 닉네임만 적어 두고, 옾링은 카드 채우기가 1분 안에 읽는다.
      v.members.set(uid, { name: nm, pli: null, link: null, photo: null, seenAt: this.now() })
      v.membersDirty.add(uid)
      v.memberWant.add(uid)
      return
    }
    if (prev.name !== nm) this.refreshSoon(v, uid, nm)
  }

  refreshSoon(v, uid, hint) {
    if (!uid || v.memberRefresh.has(uid)) return
    v.memberRefresh.add(uid)
    this.memberJob('member refresh', () => this.refreshMember(v, uid, hint).finally(() => { v.memberRefresh.delete(uid) }))
  }

  async refreshMember(v, uid, hint) {
    const chat = v.membersChat
    if (!this.sameView(v, chat)) return
    const card = await this.memberCard(v, uid)
    if (!this.sameView(v, chat)) return
    const row = card
      ? { uid, name: card.name || hint || '', pli: card.pli || '', photo: card.photo }
      : { uid, name: hint || '', pli: null }
    await this.mergeMembers(v, [row], 'refresh')
  }

  // ── 송신(5.5 공정 몫) ───────────────────────────────────────────────────
  say(v, text, opt) {
    const o = opt || {}
    // 차단된 회원의 방에서는 봇이 조용히 있는다(D27)
    if (!text || !String(text).trim() || !v.chat_id || !v.licensed) return
    const now = this.now()
    const item = { text: String(text), mention: o.mention || null, notBefore: now + Math.max(0, Number(o.delayMs) || 0), what: o.what || 'send', chat_id: v.chat_id }
    if (!this.pacer.push(String(v.install_id), item, now)) {
      this.bg(this.roomLog(v.install_id, 'skip', { detail: { what: item.what === 'reply' ? 'reply' : 'send' } }), 'skip log')
      return
    }
    this.scheduleSend(item.notBefore)
  }

  // 이미지 1장(PNG Buffer, card.mjs). 보내지 못하면 text 를 글로 대신 보낸다(text 가 없으면 조용히 넘어간다).
  // png 가 함수면(검 강화 카드 · 기록 카드) 대기열에 들어간 뒤 보낼 차례에 그린다(Promise 도 된다) — 대기열이 차서 건너뛰거나 묵어 버려지는 답은 그리지 않는다.
  // o.after = {text, mention}: 그림이 나간 바로 뒤에 보내는 한 줄(기록 카드의 멘션 줄). 그림이 실패하면 보내지 않는다(text 가 대신한다).
  // 그림 + 한 줄은 대기 목록의 한 자리이지만 발송 한도는 2개로 센다(cost).
  // → 그림이 대기열에 들어갔으면 true(글로 대신 보냈거나 · 건너뛰었으면 false)
  sayImage(v, png, opt) {
    const o = opt || {}
    if (!v.chat_id || !v.licensed) return false
    const render = typeof png === 'function' ? png : null
    if (!render && (!png || !png.length)) {
      if (o.text) this.say(v, o.text, o)
      return false
    }
    const now = this.now()
    const after = o.after && o.after.text ? { text: String(o.after.text), mention: o.after.mention || null } : null
    const item = { image: render ? null : png, text: o.text ? String(o.text) : '', mention: o.mention || null, notBefore: now + Math.max(0, Number(o.delayMs) || 0), what: o.what || 'send', chat_id: v.chat_id }
    if (render) item.render = render
    if (after) {
      item.after = after
      item.cost = 2
    }
    if (!this.pacer.push(String(v.install_id), item, now)) {
      this.bg(this.roomLog(v.install_id, 'skip', { detail: { what: item.what === 'reply' ? 'reply' : 'send' } }), 'skip log')
      return false
    }
    this.scheduleSend(item.notBefore)
    return true
  }

  sendAll(v, sends, what) {
    for (const s of sends || []) {
      // s.render(features pushSend): 그림을 아직 그리지 않은 카드 — s.image 를 읽으면 지금 그려지므로 함수째 넘긴다
      const art = typeof s.render === 'function' ? s.render : s.image
      if (art) this.sayImage(v, art, { text: s.text, mention: s.mention, delayMs: s.delayMs, what: what || 'notice' })
      else if (s.card && this.cardStyle(v, s.kind) === 'image') this.sayCard(v, s, what || 'notice')
      else this.say(v, s.text, { mention: s.mention, delayMs: s.delayMs, what: what || 'notice' })
    }
  }

  // 입장·퇴장 안내(visit)·프로필 변경 안내(profile)를 그림으로 보낼지(방 설정 visit.style·profile.style, 기본 그림)
  cardStyle(v, kind) {
    const c = v.cfg
    if (kind === 'visit') return c.visit.style
    if (kind === 'profile') return c.profile.style
    return 'text'
  }

  // 기록 카드: 그림 1장 + 바로 뒤 멘션 한 줄(`[입장 안내] @하늘`). 그림을 못 만들거나 못 보내면 지금까지의 글 안내 그대로(멘션 포함).
  // 동그라미의 프로필 사진(명부의 주소)은 카드가 대기열에 들어간 뒤 받기 시작하고(기다리지 않는다) 그림은 보낼 차례에 그린다 —
  // 그때 받은 사진을 넣고, 아직이면 그 방만 avatarTimeoutMs 까지 기다린다. 사진이 없거나 못 받으면 이름 첫 글자. 퇴장은 명부에 남은 마지막 사진.
  // 대기열이 받지 않은 카드(꽉 참 · 차단된 방)는 사진을 받지도 그리지도 않는다.
  sayCard(v, s, what) {
    const line = R.cardMentionLine(s.card, s.mention && s.mention.userId)
    const opt = { text: s.text, mention: s.mention, delayMs: s.delayMs, what, after: line }
    if (!cardAvailable()) return this.sayImage(v, null, opt)
    const uid = R.idText(s.userId || (s.mention && s.mention.userId))
    const m = uid ? v.members.get(uid) : null
    const url = m && m.photo ? m.photo : ''
    const card = s.card
    const room = v.link_name
    const wait = this.opts.avatarTimeoutMs + 500
    let photo = null // 그리기는 늘 나중(보낼 차례, 타이머)이라 아래에서 정해진다
    const queued = this.sayImage(v, async () => logCardPng(card, { room, avatar: photo ? await withTimeout(photo, wait).catch(() => null) : null }), opt)
    if (queued && url) photo = this.pool.avatars.get(url)
  }

  scheduleSend(at) {
    if (this.stopped) return
    const now = this.now()
    const when = Math.max(now, at || now)
    if (this.sendTimer && this.sendAt <= when) return
    if (this.sendTimer) clearTimeout(this.sendTimer)
    this.sendAt = when
    this.sendTimer = setTimeout(() => {
      this.sendTimer = null
      this.bg(this.drainSends(), 'send')
    }, Math.max(0, when - now))
    if (this.sendTimer.unref) this.sendTimer.unref()
  }

  // 사진을 올리는 중인 방(기다림을 넘겼지만 아직 끝나지 않은 올리기도), 또는 봇 전체로 올리는 사진이 PHOTO_MAX 개인데
  // 사진 차례인 방은 이번에 건너뛴다(Pacer skip)
  photoWait(key, item) {
    return this.photoBusy.has(key) || this.photoLate.has(key) || (!!(item.image || item.render) && this.photoBusy.size + this.photoLateN >= PHOTO_MAX)
  }

  // 기다림(photoTimeoutMs)을 넘긴 사진 올리기는 끊기지 않고 뒤에서 이어진다(늦게 올라갈 수 있다). 끝날 때까지(최대 PHOTO_LATE_MAX_MS)
  // PHOTO_MAX 에 세고 그 방의 다음 글도 붙잡아 둔다 — 늦은 사진이 그 뒤에 나간 새 결과보다 나중에 올라가지 않게
  holdLate(key, up) {
    this.photoLate.set(key, (this.photoLate.get(key) || 0) + 1)
    this.photoLateN++
    withTimeout(Promise.resolve(up), PHOTO_LATE_MAX_MS)
      .then((res) => { if (res && res.success === true) log(this.id, `image posted late install ${key}`) }, () => {})
      .finally(() => {
        const n = (this.photoLate.get(key) || 1) - 1
        if (n > 0) this.photoLate.set(key, n)
        else this.photoLate.delete(key)
        this.photoLateN = Math.max(0, this.photoLateN - 1)
        this.scheduleSend(this.now())
      })
  }

  async drainSends() {
    if (this.sending) return
    this.sending = true
    const skip = (key, item) => this.photoWait(key, item)
    try {
      const now0 = this.now()
      for (const s of this.pacer.stale(now0)) {
        await this.roomLog(Number(s.key), 'skip', { detail: { what: 'send', note: 'stale' } })
      }
      while (this.live()) {
        const next = this.pacer.next(this.now(), skip)
        if (!next) break
        const v = this.byInstall.get(Number(next.key))
        if (!v || v.state === 'error' || v.chat_id !== next.item.chat_id) continue
        if (next.item.image || next.item.render) {
          // 사진은 기다리지 않는다: 한 방의 업로드가 멈춰도 다른 방의 글은 나간다. 그 방의 다음 글은 업로드가 끝난 뒤(순서 유지)
          const key = next.key
          this.photoBusy.add(key)
          this.bg(this.deliver(v, next.item).finally(() => {
            this.photoBusy.delete(key)
            this.scheduleSend(this.now())
          }), 'photo send')
          continue
        }
        await this.deliver(v, next.item)
      }
    } finally {
      this.sending = false
    }
    if (!this.pacer.pending()) return
    if (!this.live()) {
      this.scheduleSend(this.now() + 2000)
      return
    }
    const wake = this.pacer.wakeAt(this.now(), skip)
    if (wake) this.scheduleSend(Math.max(wake, this.now() + 50))
  }

  // 사진 1장. 라이브러리 sendPhoto(SHIP → 업로드 → COMPLETE). SHIP 이 업로드 주소(k·vh·p) 없이 답하면
  // 확장자를 jpg 로 바꿔 한 번 더 보내 보고, 처음 한 번은 SHIP 답을 그대로 로그에 남긴다(원인 확인용, 토큰 값은 가린다).
  // 업로드 자체는 patch-kakao 가 끝을 둔다(연결 10초 · COMPLETE 20초). 여기서도 photoTimeoutMs(25초)까지만 기다리고(라이브러리가
  // 그래도 멈출 때의 상한), 넘기면 실패로 보고 글로 대신 보낸다. 그 올리기는 끝날 때까지 holdLate 가 센다(사진이 늦게 올라가 둘 다
  // 보일 수는 있다 — 결과가 안 보이는 것보다 낫다. 그래도 그 방의 다음 글보다 늦게 올라가지는 않는다).
  async sendPhoto(v, png) {
    for (const name of ['kbot.png', 'kbot.jpg']) {
      let up = null
      try {
        up = this.client.sendPhoto(v.chat_id, png, name)
        const res = await withTimeout(up, this.opts.photoTimeoutMs)
        if (res && res.success === true) {
          if (name !== 'kbot.png' && !this.photoExtNoted) {
            this.photoExtNoted = true
            log(this.id, 'image send ok with jpg extension')
          }
          return true
        }
        log(this.id, `image send failed install ${v.install_id} (${name}) status ${res ? res.status_code : '?'}`)
        return false
      } catch (e) {
        const msg = errText(e)
        log(this.id, `image send failed install ${v.install_id} (${name}): ${msg}`)
        if (e && e.timeout && up) this.holdLate(String(v.install_id), up)
        if (!/SHIP response missing/.test(msg)) return false
        if (!this.shipProbed) {
          this.shipProbed = true
          await this.shipProbe(v.chat_id, png).catch((err) => log(this.id, `ship probe failed: ${errText(err)}`))
        }
      }
    }
    return false
  }

  async renderCard(v, render) {
    try {
      return (await render()) || null
    } catch (e) {
      log(this.id, `card render failed install ${v.install_id}: ${errText(e)}`)
      return null
    }
  }

  async shipProbe(chatId, png) {
    const cs = createHash('sha1').update(png).digest('hex')
    for (const e of ['png', 'jpg']) {
      const r = await this.raw('SHIP', { c: L(chatId), t: 2, s: Long.fromNumber(png.length), cs, e })
      const b = Object.assign({}, (r && r.body) || {})
      if (typeof b.k === 'string') b.k = '(' + b.k.length + ' chars)'
      log(this.id, `ship probe e=${e} → status ${r ? r.statusCode : '?'} keys ${Object.keys(b).join(',') || '-'} body ${traceText(b)}`)
    }
  }

  async deliver(v, item) {
    if (item.image || item.render) {
      // 그림은 보낼 차례에 그린다(sayImage). 못 그리면(렌더러 없음·오류) 글로 대신 보낸다
      const png = item.image || (await this.renderCard(v, item.render))
      if (png && png.length && (await this.sendPhoto(v, png))) {
        if (item.after) await this.deliver(v, { text: item.after.text, mention: item.after.mention })
        return
      }
      if (!item.text) return
      item = Object.assign({}, item, { image: null, render: null, after: null })
    }
    try {
      const extra = item.mention ? visitMentionExtra(item.text, item.mention) : ''
      if (extra) {
        this.msgSeq = (this.msgSeq || 0) + 1
        const r = await this.raw('WRITE', { chatId: L(v.chat_id), msgId: Long.fromNumber(this.msgSeq), msg: item.text, type: 1, noSeen: false, scope: 1, extra })
        if (!R.locoOk(r)) log(this.id, `send failed status ${R.locoStatus(r)} install ${v.install_id}`)
        return
      }
      const res = await this.client.sendMessage(v.chat_id, item.text)
      if (!res || res.success !== true) log(this.id, `send failed install ${v.install_id}`)
    } catch (e) {
      log(this.id, `send failed install ${v.install_id}: ${errText(e)}`)
    }
  }
}
