import { webcrypto } from 'node:crypto'

import { Long } from 'bson'
import {
  KakaoTalkClient,
  KakaoTalkListener,
  classifyKakaoChat,
  refreshKakaoOAuthToken,
} from 'agent-messenger/kakaotalk'

import {
  guardCanStopKicks,
  guardDue,
  guardFinishHalt,
  guardNotices,
  guardOnChat,
  macroMinMessages,
  macroNotifyReply,
  macroRoomsDue,
  noteMacroRetry,
  noteMacroSent,
  noteMacroWait,
  onInbound,
  othersSinceMine,
  chatLogsFromBody,
  coverNeedsAuthor,
  coverPlan,
  coverSkipsLink,
  realId,
  visitEventsFromMessage,
  visitMentionExtra,
  visitMemberId,
  visitNeedsProfile,
} from './features.mjs'
import { BotPool } from './botpool.mjs'
import { FakeKakaoClient, fakeOn } from './fake.mjs'
import { openMultiCandidate, roomListKind, roomTitle, stampOpenLinkTitles } from './room-kind.mjs'
import { isBotId, locoOk, withProfileLink } from './roomfeat.mjs'
import { dbStore, listFeatureRows, listIds, loadRecord, saveRecord, updateFeatures } from './store.mjs'

if (!globalThis.crypto) globalThis.crypto = webcrypto

const DEAD = new Set(['invalid_access_token', 'login_rejected', 'kicked', 'reauth'])

// 가짜 모드(SENDER_FAKE=1, 9.4)는 연결 자리만 바꾼다. 나머지 코드는 진짜와 같다.
export function newKakaoClient() {
  return fakeOn() ? new FakeKakaoClient() : new KakaoTalkClient()
}

async function refreshBotToken(creds) {
  return refreshKakaoOAuthToken({ accessToken: creds.access_token, refreshToken: creds.refresh_token, deviceUuid: creds.device_uuid })
}

/** KICKOUT 사유 0(다른 기기 로그인)·1(계정 삭제)·없음만 진짜 종료. -2(CHANGE_SERVER) 와 그 밖은 재접속(5.2). */
export function kickoutDead(reason) {
  return typeof reason !== 'number' || reason === 0 || reason === 1
}

/**
 * 권리 v2 기록이 지금 붙어 있어도 되는가(5.1). v2 가 아니면(첫 /v1/grants 전) 예전처럼 붙는다.
 * 봇 기록은 늘 붙는다.
 */
export function entitled(record, now) {
  const f = record && record.features
  if (!f || f.v !== 2) return true
  if (f.bot) return true
  const t = now == null ? Date.now() : now
  return t < Math.max(Number(f.macro_until) || 0, Number(f.legacy_room_until) || 0)
}

const traced = new Set()
function tracePush(id, packet) {
  if (process.env.SENDER_TRACE_PUSH !== '1' || !packet || traced.has(packet.method)) return
  traced.add(packet.method)
  log(id, `push ${packet.method} keys ${Object.keys(packet.body || {}).join(',')}`)
}

function log(id, msg) {
  process.stderr.write(`[sender] ${id} ${msg}\n`)
}

function chatLinkId(ch) {
  const v = ch && (ch.link_id || ch.li)
  const s = v == null ? '' : String(v).trim()
  return /^[1-9][0-9]*$/.test(s) ? s : ''
}

function olName(ol) {
  if (!ol || typeof ol !== 'object') return ''
  if (typeof ol.ln === 'string' && ol.ln.trim()) return ol.ln.trim()
  const moim = ol.omt || ol.moim
  if (typeof moim === 'string' && moim.trim()) return moim.trim()
  if (moim && typeof moim === 'object') {
    const inner = moim.name || moim.title || moim.ln
    if (typeof inner === 'string' && inner.trim()) return inner.trim()
  }
  return ''
}

function olLinkKey(ol) {
  if (!ol || typeof ol !== 'object' || ol.li == null) return ''
  const v = ol.li
  if (typeof v === 'string' && /^[1-9][0-9]*$/.test(v.trim())) return v.trim()
  if (typeof v === 'number' && Number.isSafeInteger(v) && v > 0) return String(v)
  if (typeof v === 'bigint' && v > 0n) return v.toString()
  if (typeof v.toString === 'function') {
    const s = v.toString()
    if (/^[1-9][0-9]*$/.test(s)) return s
  }
  return ''
}

// One INFOLINK for the open multi chats. Per-room CHATINFO made 대화방 불러오기
// stall until the browser dropped it, and a missing ln dropped every row.
async function openLinkNames(client, list) {
  const names = new Map()
  const ids = []
  const seen = new Set()
  for (const ch of list || []) {
    if (!openMultiCandidate(ch)) continue
    const id = chatLinkId(ch)
    if (!id || seen.has(id)) continue
    seen.add(id)
    ids.push(id)
  }
  if (!ids.length || !client || typeof client.acquireSession !== 'function') return names
  let session
  try {
    session = await client.acquireSession()
  } catch {
    return names
  }
  for (let i = 0; i < ids.length; i += 20) {
    const part = ids.slice(i, i + 20)
    let body = null
    try {
      const response = await session.getOpenLinkInfo(part.map((id) => Long.fromString(id)))
      body = response && response.body
    } catch {
      body = null
    }
    const ols = body && Array.isArray(body.ols) ? body.ols : []
    for (let j = 0; j < part.length; j++) {
      const ol = ols[j]
      const name = olName(ol)
      if (!name) continue
      const key = olLinkKey(ol)
      if (key) names.set(key, name)
      else names.set(part[j], name)
    }
  }
  return names
}

function idText(v) {
  if (v == null || v === '') return ''
  if (typeof v === 'string' && /^[1-9][0-9]*$/.test(v.trim())) return v.trim()
  if (typeof v === 'number' && Number.isSafeInteger(v) && v > 0) return String(v)
  if (typeof v === 'bigint' && v > 0n) return v.toString()
  if (typeof v === 'object' && typeof v.toString === 'function') {
    const s = v.toString()
    if (/^[1-9][0-9]*$/.test(s)) return s
  }
  return ''
}

function logAfter(id, cursor) {
  if (!id) return false
  if (!cursor) return true
  try {
    return BigInt(id) > BigInt(cursor)
  } catch {
    return id > cursor
  }
}

function realLogId(v) {
  if (typeof v === 'bigint') v = v.toString()
  else if (typeof v === 'number' && Number.isFinite(v) && v === Math.trunc(v)) v = String(v)
  if (typeof v !== 'string') return ''
  const s = v.trim()
  return /^[1-9][0-9]*$/.test(s) ? s : ''
}

function credsOf(record) {
  const c = record.credentials || {}
  return {
    access_token: String(c.access_token || ''),
    refresh_token: String(c.refresh_token || ''),
    user_id: String(c.user_id || ''),
    device_uuid: String(c.device_uuid || ''),
    device_type: c.device_type === 'pc' ? 'pc' : 'tablet',
  }
}

// 채팅 화면용 보조 — 들어온 메시지를 사람이 읽을 미리보기로 바꾼다.
// 글이 있으면 그대로, 없으면 종류만 알려 준다. 종류도 모르면 버린다(피드·알림 줄).
// 이모티콘 종류는 라이브러리의 KAKAO_EMOTICON_KIND_BY_TYPE(6·12·20·22·25)를 따른다.
// 모르는 종류라도 글이 아니라는 것만 알면 버리지 않는다 — 손님이 보낸 걸 놓치면 안 된다.
// 피드(입퇴장 안내 등, type 0 이하)만 기록하지 않는다.
function mediaLabel(type) {
  const t = Number(type)
  if (!Number.isFinite(t) || t <= 0) return ''
  switch (t) {
    case 2: case 16: case 27: return '사진'
    case 3: return '동영상'
    case 5: return '음성 메시지'
    case 6: case 12: case 20: case 22: case 25: return '이모티콘'
    case 18: return '파일'
    case 71: return '링크'
    default: return '메시지'
  }
}

function previewText(text, type) {
  const s = typeof text === 'string' ? text : ''
  if (s) return s
  const label = mediaLabel(type)
  return label ? `(${label})` : ''
}

function recordable(text, type) {
  return !!(typeof text === 'string' && text) || !!mediaLabel(type)
}

// 카카오가 주는 sent_at 은 초 단위다(LOCO sendAt). 화면은 밀리초로 읽으므로 여기서 맞춘다.
// 1e12 ms 는 2001년이다 — 그보다 작은 값은 초로 보고 1000 을 곱한다.
function atMs(v) {
  const n = Number(v)
  if (!Number.isFinite(n) || n <= 0) return 0
  return n < 1e12 ? Math.round(n * 1000) : Math.round(n)
}

// 카카오가 찍는 시각은 초 단위다. 우리가 보낸 글도 초로 맞춰야
// 같은 초에 오간 글끼리 순서가 뒤집히지 않는다(그다음은 log_id 로 가린다).
function nowAt() {
  return Math.floor(Date.now() / 1000) * 1000
}

// log_id 는 큰 정수 문자열이다. 시각이 같을 때 순서를 가른다.
function cmpLog(a, b) {
  const sa = a || ''
  const sb = b || ''
  if (sa === sb) return 0
  if (!sa) return -1
  if (!sb) return 1
  try {
    const d = BigInt(sa) - BigInt(sb)
    return d < 0n ? -1 : d > 0n ? 1 : 0
  } catch {
    return sa < sb ? -1 : 1
  }
}

export class Hub {
  constructor(deps) {
    const d = deps || {}
    this.accounts = new Map()
    this.pool = new BotPool({
      store: d.store || Object.assign({ saveRecord }, dbStore),
      newClient: d.newClient || newKakaoClient,
      refreshToken: refreshBotToken,
      opts: d.opts,
      now: d.now,
    })
    this.grantTimer = null
  }

  async boot() {
    const ids = await listIds()
    for (const id of ids) {
      try {
        const rec = await loadRecord(id)
        if (!rec || rec.needs_register) continue
        if (!credsOf(rec).access_token) continue
        // 권리가 끝난 v2 고객 기록은 붙이지 않는다(D7). 기록은 그대로 둔다.
        if (!isBotId(id) && !entitled(rec)) continue
        await this.attach(id, rec)
      } catch (e) {
        log(id, `boot skipped: ${e && e.message ? e.message : e}`)
      }
    }
    this.startTimers()
    this.pool.start()
    await this.pool.reconcile(null).catch((e) => log('pool', `boot reconcile failed: ${e && e.message ? e.message : e}`))
  }

  // 60초마다 권리가 끝난 고객 슬롯을 멈춘다(기록 보존). /v1/grants 로 살아나면 다시 붙는다.
  startTimers() {
    if (this.grantTimer) return
    this.grantTimer = setInterval(() => {
      this.expireSlots().catch((e) => log('hub', `expire check failed: ${e && e.message ? e.message : e}`))
    }, 60000)
    if (this.grantTimer.unref) this.grantTimer.unref()
  }

  async expireSlots(now) {
    let stopped = 0
    for (const [id, slot] of [...this.accounts]) {
      if (entitled(slot.record, now)) continue
      await slot.stop()
      if (this.accounts.get(id) === slot) this.accounts.delete(id)
      log(id, 'rights ended, slot stopped')
      stopped++
    }
    return stopped
  }

  /**
   * /v1/grants (3.6). grants = {device_id: {v:2, macro_until, legacy_room_until}}.
   * full 이면 목록에 없는 고객 기록 중 grants_at·reg_at 이 둘 다 as_of 보다 이른 것을 권리 없음으로 바꾸고 멈춘다.
   */
  async applyGrants(grants, opt) {
    const o = opt || {}
    const now = Date.now()
    const asOf = Number(o.asOf) || now
    let applied = 0
    let stopped = 0
    const listed = new Set()
    for (const [id, g] of Object.entries(grants || {})) {
      if (!/^[A-Za-z0-9._-]{8,128}$/.test(id) || isBotId(id) || !g || typeof g !== 'object') continue
      listed.add(id)
      const slot = this.accounts.get(id)
      const rec = slot ? slot.record : await loadRecord(id)
      if (!rec) continue
      const prev = rec.features && typeof rec.features === 'object' ? rec.features : {}
      const features = {
        v: 2,
        macro_until: Math.max(0, Number(g.macro_until) || 0),
        legacy_room_until: Math.max(0, Number(g.legacy_room_until) || 0),
        grants_at: now,
        reg_at: Number(prev.reg_at) || 0,
      }
      rec.features = features
      await updateFeatures(id, features)
      applied++
      if (entitled(rec, now)) {
        if (!slot && !rec.needs_register && credsOf(rec).access_token) await this.attach(id, rec)
      } else if (slot) {
        await slot.stop()
        if (this.accounts.get(id) === slot) this.accounts.delete(id)
        stopped++
      }
    }
    if (o.full) {
      for (const row of await listFeatureRows()) {
        const id = row.device_id
        if (listed.has(id) || isBotId(id)) continue
        const f = row.features && typeof row.features === 'object' ? row.features : {}
        if (Number(f.grants_at || 0) >= asOf || Number(f.reg_at || 0) >= asOf) continue
        const slot = this.accounts.get(id)
        const already = f.v === 2 && !Number(f.macro_until) && !Number(f.legacy_room_until)
        if (!already) {
          const features = { v: 2, macro_until: 0, legacy_room_until: 0, reg_at: Number(f.reg_at) || 0 }
          await updateFeatures(id, features)
          if (slot) slot.record.features = features
        }
        if (slot) {
          await slot.stop()
          if (this.accounts.get(id) === slot) this.accounts.delete(id)
          stopped++
        } else if (!already) stopped++
      }
    }
    return { applied, stopped }
  }

  status(id) {
    if (isBotId(id)) return this.pool.status(id)
    const slot = this.accounts.get(id)
    if (!slot) return { linked: false, needs_register: false, reason: 'absent', connected: false }
    return {
      linked: !slot.record.needs_register,
      needs_register: !!slot.record.needs_register,
      reason: slot.record.reason || (slot.record.needs_register ? 'reauth' : 'ok'),
      notices: guardNotices(slot.record),
      connected: socketUp(slot),
    }
  }

  async upsert(id, body) {
    const prev = await loadRecord(id)
    const creds = credsOf({ credentials: body.credentials || (prev && prev.credentials) })
    if (!creds.access_token || !creds.user_id || !creds.device_uuid) {
      const err = new Error('incomplete credentials')
      err.status = 400
      throw err
    }
    const bot = isBotId(id)
    const record = {
      device_id: id,
      credentials: creds,
      config: bot ? {} : (body.config || (prev && prev.config) || {}),
      rooms: bot ? [] : (Array.isArray(body.rooms) ? body.rooms : (prev && prev.rooms) || []),
      // 새 고객 기록의 기본 권리는 거부(5.1). 부모가 등록 직후 /v1/grants 로 실제 값을 민다.
      features: bot ? { v: 2, bot: true } : (body.features || (prev && prev.features) || { v: 2, macro_until: 0, legacy_room_until: 0 }),
      images: bot ? [] : (Array.isArray(body.images) ? body.images : (prev && prev.images) || []),
      runtime: bot ? {} : ((prev && prev.runtime) || {}),
      needs_register: false,
      reason: 'ok',
    }
    if (!bot && body.config && prev && prev.runtime) record.runtime = prev.runtime
    if (!bot && !entitled(record)) {
      // 권리가 끝난 v2 고객 기록은 저장만 하고 붙이지 않는다
      const slot = this.accounts.get(id)
      if (slot) {
        await slot.stop()
        this.accounts.delete(id)
      }
      await saveRecord(id, record)
      return this.status(id)
    }
    await this.attach(id, record)
    return this.status(id)
  }

  async updateConfig(id, body) {
    const slot = this.accounts.get(id)
    const prev = slot ? slot.record : await loadRecord(id)
    if (!prev || !prev.credentials) {
      const err = new Error('not registered')
      err.status = 404
      throw err
    }
    if (body.features && prev.features && prev.features.v === 2) {
      // v2 기록의 권리는 /v1/grants 만 바꾼다(3.6)
      const err = new Error('features_not_allowed')
      err.status = 400
      throw err
    }
    if (body.config) prev.config = body.config
    if (Array.isArray(body.rooms)) prev.rooms = body.rooms
    if (body.features) prev.features = body.features
    if (Array.isArray(body.images)) prev.images = body.images
    await saveRecord(id, prev)
    // 권리가 끝난 v2 고객 기록은 저장만 한다. 설정을 저장할 때마다 카카오에 다시 로그인하지 않게(5.1)
    if (!slot && !prev.needs_register && entitled(prev)) await this.attach(id, prev)
    return this.status(id)
  }

  async unlink(id) {
    if (isBotId(id)) {
      await this.pool.detach(id)
      const prev = await loadRecord(id)
      if (prev) {
        prev.credentials = {}
        prev.needs_register = false
        prev.reason = 'unlinked'
        await saveRecord(id, prev)
      }
      return
    }
    const slot = this.accounts.get(id)
    if (slot) await slot.stop()
    this.accounts.delete(id)
    const prev = await loadRecord(id)
    if (prev) {
      prev.credentials = {}
      prev.images = []
      prev.needs_register = false
      prev.reason = 'unlinked'
      await saveRecord(id, prev)
    }
  }

  async chats(id) {
    const slot = this.requireLive(id)
    const list = await slot.client.getChats({ all: true })
    const names = await openLinkNames(slot.client, list)
    const stamped = stampOpenLinkTitles(list, names)
    return stamped.map((ch) => {
      const listKind = roomListKind(ch)
      const title = listKind === 'open_room' ? (roomTitle(ch) || null) : (ch.title || null)
      return {
        chat_id: String(ch.chat_id),
        kind: classifyKakaoChat(ch),
        type: ch.type,
        list_kind: listKind,
        title: title,
        display_name: listKind === 'open_room' ? null : (ch.display_name || null),
        members: ch.active_members,
        last_at: ch.last_message ? ch.last_message.sent_at : 0,
      }
    })
  }

  async recent(id, chatId) {
    const slot = this.requireLive(id)
    const msgs = await slot.client.getMessages(chatId, { count: 20 })
    const self = credsOf(slot.record).user_id
    const out = []
    for (const m of msgs || []) {
      const logId = realLogId(m && m.log_id)
      if (!logId) continue
      const authorId = m.author_id == null ? '' : String(m.author_id)
      out.push({
        log_id: logId,
        message: typeof m.message === 'string' ? m.message : '',
        mine: self.length > 0 && authorId === self,
        sent_at: m.sent_at || 0,
      })
    }
    return out
  }

  // 채팅 목록. 오픈프로필로 온 1:1 채팅(open_dm)만 최근 대화순으로 돌려준다.
  // 오픈 단체방과 일반 채팅은 올리지 않는다 — 손님 갠톡이 묻히지 않게.
  async inbox(id) {
    const slot = this.requireLive(id)
    let catalog = []
    try {
      catalog = await slot.catalog()
    } catch {
      catalog = (slot.catalogCache && slot.catalogCache.list) || []
    }
    const byId = new Map()
    for (const ch of catalog) byId.set(ch.chat_id, Object.assign({}, ch))
    for (const [cid, conv] of slot.inbox) {
      const base = byId.get(cid) || {
        chat_id: cid, list_kind: 'normal', title: '', display_name: '', members: 0, last_at: 0, last_text: '',
      }
      // 더 최근 쪽의 미리보기를 쓴다. 버퍼가 거르는 글(피드 등)이 마지막일 수 있다.
      const bufAt = conv.lastAt || 0
      const catAt = base.last_at || 0
      if (!(catAt > bufAt && base.last_text)) base.last_text = conv.lastText || base.last_text || ''
      base.last_at = Math.max(catAt, bufAt)
      base.unread = conv.unread || 0
      base.peer = conv.peer || ''
      base.has_buffer = true
      byId.set(cid, base)
    }
    const out = []
    for (const ch of byId.values()) {
      const kind = ch.list_kind || 'normal'
      // 오픈프로필로 온 1:1 채팅만 올린다.
      // 오픈 단체방(매크로를 돌리는 방)과 일반 채팅은 이 화면이 다룰 일이 아니다.
      if (kind !== 'open_dm') continue
      // 받아 둔 기록이 있으면 그걸 믿는다(방을 열면 0 이 된다).
      // 기록이 없으면 — 프로세스가 막 떴을 때 — 카카오가 세어 둔 값을 쓴다.
      const unread = ch.has_buffer ? (ch.unread || 0) : (ch.unread_count || 0)
      out.push({
        chat_id: ch.chat_id,
        list_kind: kind,
        name: ch.title || ch.display_name || ch.peer || '',
        preview: ch.last_text || '',
        unread,
        last_at: ch.last_at || 0,
      })
    }
    out.sort((a, b) => (b.last_at - a.last_at) || (b.unread - a.unread))
    return out
  }

  // 한 방의 대화. 서버가 받아 둔 메시지를 돌려주고, 처음 열 때는 카카오에서 최근 글을 채운다.
  // 여는 순간 그 방의 안 읽음은 0 으로 돌린다.
  async thread(id, chatId) {
    const slot = this.requireLive(id)
    const key = String(chatId)
    let conv = slot.inbox.get(key)
    // 과거 글은 그 방을 처음 열 때 한 번만 읽는다. 조건을 글 개수로 두면 글이 적은 방은
    // 폴링마다(3초) 카카오를 다시 두드리게 된다 — 그러다 접속이 끊긴다.
    if ((!conv || !conv.filled) && slot.client) {
      try {
        const msgs = await slot.client.getMessages(key, { count: 25 })
        const self = credsOf(slot.record).user_id
        for (const m of msgs || []) {
          const logId = realLogId(m && m.log_id)
          if (!logId) continue
          const authorId = m.author_id == null ? '' : String(m.author_id)
          slot.noteChat(key, {
            logId,
            text: typeof m.message === 'string' ? m.message : '',
            mine: self.length > 0 && authorId === self,
            at: m.sent_at || 0,
            author: m.author_name || '',
            authorId,
            type: m.type == null ? m.message_type : m.type,
            backfill: true,
          })
        }
        // 읽을 글이 하나도 없는 방도 기록을 만들어 둔다. 안 그러면 계속 다시 읽는다.
        conv = slot.convFor(key)
        conv.filled = true
      } catch (e) {
        if (!conv) throw e
      }
    }
    if (conv) conv.unread = 0
    const list = conv ? conv.list : []
    return list.map((x) => ({
      log_id: x.log_id,
      text: x.text,
      label: x.text ? '' : (mediaLabel(x.type) || ''),
      mine: x.mine,
      at: x.at,
      author: x.author,
      author_id: x.author_id || '',
    }))
  }

  async sendText(id, chatId, text) {
    const slot = this.requireLive(id)
    if (!slot.client) {
      const err = new Error('not_connected')
      err.status = 503
      throw err
    }
    const res = await slot.client.sendMessage(chatId, text)
    const logId = realLogId(res && res.log_id)
    if (!res || res.success !== true || !logId) {
      const err = new Error('undelivered')
      err.status = 502
      throw err
    }
    slot.noteChat(String(chatId), { logId, text: String(text), mine: true, at: nowAt(), author: '', type: 1 })
    return { log_id: logId, kind: 'text' }
  }

  async sendImages(id, chatId, images) {
    const slot = this.requireLive(id)
    const photos = images.map((buf, i) => ({ data: buf, filename: `photo-${i + 1}.jpg` }))
    await slot.client.acquireSession()
    const res = photos.length === 1
      ? await slot.client.sendPhoto(chatId, photos[0].data, photos[0].filename)
      : await slot.client.sendMultiPhoto(chatId, photos)
    const logId = realLogId(res && res.log_id)
    if (!res || res.success !== true || !logId) {
      const err = new Error('undelivered')
      err.status = 502
      throw err
    }
    return { log_id: logId, kind: photos.length === 1 ? 'photo' : 'multiphoto' }
  }

  requireLive(id) {
    const slot = this.accounts.get(id)
    if (!slot || slot.record.needs_register) {
      const err = new Error(slot && slot.record.reason ? slot.record.reason : 'needs_register')
      err.status = 409
      err.needs_register = true
      throw err
    }
    return slot
  }

  async attach(id, record) {
    if (isBotId(id)) {
      await this.pool.attach(id, record)
      return
    }
    let slot = this.accounts.get(id)
    const creds = credsOf(record)
    const same = slot && credsOf(slot.record).access_token === creds.access_token
      && credsOf(slot.record).device_uuid === creds.device_uuid
    if (slot && !same) {
      await slot.stop()
      slot = null
    }
    if (!slot) {
      slot = new Slot(id, record)
      this.accounts.set(id, slot)
      await slot.start()
    } else {
      slot.record = record
      await saveRecord(id, record)
    }
  }
}

class Slot {
  constructor(id, record) {
    this.id = id
    this.record = record
    this.client = null
    this.listener = null
    this.timer = null
    this.stopped = false
    this.chain = Promise.resolve()
    this.refreshed = false
    this.linkIds = new Map()
    this.lastLog = new Map()
    this.profileLinks = new Map()
    this.visitCursor = new Map()
    this.visitEntered = new Set()
    this.visitLogs = new Set()
    this.coverLogs = new Set()
    this.unpush = null
    this.mentionSeq = 0
    // 채팅 화면용. 들어오고 나간 메시지를 방마다 메모리에 담아 둔다(프로세스가 다시 뜨면 비고,
    // 방을 열 때 카카오에서 최근 글로 다시 채운다). catalog 는 방 목록 캐시다.
    this.inbox = new Map()
    this.catalogCache = { at: 0, list: [] }
    this.catalogPromise = null
    // 오픈채팅방 이름(오픈링크 ln). 방 이름은 잘 바뀌지 않으니 길게 들고 있는다.
    this.linkNames = { at: 0, map: new Map() }
  }

  // getChats 는 resolveTitles 를 주지 않으면 title 을 채우지 않는다.
  // 그대로 두면 오픈방 이름 자리에 멤버 닉네임을 이어 붙인 문자열이 올라온다.
  // 그래서 매크로 쪽과 같은 방식으로 오픈링크 이름을 읽어 제목에 박는다.
  async stampNames(list) {
    const now = Date.now()
    if (now - this.linkNames.at > 600000) {
      try {
        this.linkNames = { at: now, map: await openLinkNames(this.client, list) }
      } catch {
        this.linkNames = { at: now, map: this.linkNames.map }
      }
    }
    return stampOpenLinkTitles(list, this.linkNames.map)
  }

  // 이 방이 오픈프로필 1:1 인지 목록 캐시에서 본다. 캐시에 없으면 '' — 아직 모른다는 뜻이다.
  kindOf(id) {
    for (const row of this.catalogCache.list || []) {
      if (row.chat_id === id) return row.list_kind || 'normal'
    }
    return ''
  }

  // 갠톡이 아닌 것으로 밝혀진 방의 기록은 버린다. 단체방까지 들고 있으면 메모리만 먹는다.
  pruneInbox(list) {
    if (!this.inbox.size) return
    const kinds = new Map()
    for (const row of list) kinds.set(row.chat_id, row.list_kind || 'normal')
    for (const cid of Array.from(this.inbox.keys())) {
      const k = kinds.get(cid)
      if (k && k !== 'open_dm') this.inbox.delete(cid)
    }
  }

  // 그 방의 기록을 꺼낸다. 없으면 만든다.
  // 프로세스가 다시 떠서 처음 만드는 방이면, 카카오가 세어 둔 안 읽음 수에서 이어 센다
  // (그래야 새 글 하나가 왔을 때 23 → 1 로 줄어들지 않는다).
  convFor(id) {
    let conv = this.inbox.get(id)
    if (conv) return conv
    if (this.inbox.size >= 240) {
      let oldestKey = null
      let oldestAt = Infinity
      for (const [k, c] of this.inbox) {
        if ((c.lastAt || 0) < oldestAt) { oldestAt = c.lastAt || 0; oldestKey = k }
      }
      if (oldestKey != null) this.inbox.delete(oldestKey)
    }
    let seed = 0
    for (const row of this.catalogCache.list || []) {
      if (row.chat_id === id) { seed = row.unread_count || 0; break }
    }
    conv = { chatId: id, list: [], unread: seed, lastAt: 0, lastText: '', lastMine: false, peer: '', filled: false }
    this.inbox.set(id, conv)
    return conv
  }

  // 한 메시지를 그 방의 기록에 넣는다. log_id 로 중복을 막고, 최근 80개만 남긴다.
  // 내가 보낸 게 아니고 backfill(과거 채우기)도 아니면 안 읽음을 하나 올린다.
  noteChat(chatId, m) {
    const id = String(chatId || '')
    if (!id) return
    const text = typeof m.text === 'string' ? m.text : ''
    if (!recordable(text, m.type)) return
    // 채팅 화면은 오픈프로필 1:1 만 다룬다.
    // 처음 보는 방은 일단 담되, 목록을 다시 읽어 종류를 알아낸다 (새로 생긴 갠톡일 수 있다).
    const kind = this.kindOf(id)
    if (kind && kind !== 'open_dm') return
    if (!kind) this.catalogCache.at = 0
    const logId = m.logId ? String(m.logId) : ''
    const conv = this.convFor(id)
    if (logId && conv.list.some((x) => x.log_id === logId)) return
    const at = atMs(m.at) || nowAt()
    const row = {
      log_id: logId,
      text,
      mine: !!m.mine,
      at,
      author: m.author ? String(m.author) : '',
      // 이름은 캐시가 비면 빈 값이 온다. 말풍선을 사람별로 묶을 때는 이 아이디를 쓴다.
      author_id: m.authorId ? String(m.authorId) : '',
      type: m.type == null ? null : m.type,
    }
    conv.list.push(row)
    conv.list.sort((a, b) => (a.at - b.at) || cmpLog(a.log_id, b.log_id))
    if (conv.list.length > 80) conv.list = conv.list.slice(-80)
    // 미리보기는 가장 마지막 글이지만, 상대 이름은 방금 넣은 글에서 가져온다.
    const last = conv.list[conv.list.length - 1]
    conv.lastAt = last.at
    conv.lastText = previewText(last.text, last.type)
    conv.lastMine = last.mine
    if (!row.mine && row.author) conv.peer = row.author
    if (!row.mine && !m.backfill) conv.unread = Math.min(conv.unread + 1, 999)
  }

  // 방 목록 캐시. 열려 있는 세션의 채팅 목록을 가볍게 읽어 둔다(오픈링크 이름 조회는 빼서 빠르게).
  // 12초는 그대로 쓰고, 지나면 새로 읽되 이미 캐시가 있으면 옛 값을 바로 주고 뒤에서 갱신한다.
  catalog() {
    // 소켓을 다시 붙이는 사이에는 client 가 잠깐 없다. 그때는 가진 캐시를 준다.
    if (!this.client) return Promise.resolve(this.catalogCache.list || [])
    const fresh = this.catalogCache.at > 0 && (Date.now() - this.catalogCache.at < 12000)
    if (fresh) return Promise.resolve(this.catalogCache.list)
    const run = () => {
      if (this.catalogPromise) return this.catalogPromise
      this.catalogPromise = (async () => {
        const raw = await this.client.getChats({ all: true })
        const list = await this.stampNames(Array.isArray(raw) ? raw : [])
        const mapped = list.map((ch) => {
          const listKind = roomListKind(ch)
          const title = listKind === 'open_room' ? (roomTitle(ch) || '') : (ch.title || '')
          const lm = ch.last_message
          return {
            chat_id: String(ch.chat_id),
            list_kind: listKind,
            title: title || '',
            // 단체방에서 멤버 닉네임을 이은 문자열은 방 이름이 아니다 (room-kind.mjs 와 같은 규칙).
            display_name: listKind === 'open_room' ? '' : (ch.display_name || ''),
            members: ch.active_members || 0,
            last_at: lm ? atMs(lm.sent_at) : 0,
            last_text: lm && typeof lm.message === 'string' ? lm.message : '',
            // 카카오가 세는 안읽음. 프로세스가 다시 떠서 버퍼가 비었을 때 이 값을 쓴다.
            unread_count: Number(ch.unread_count) > 0 ? Number(ch.unread_count) : 0,
          }
        })
        this.catalogCache = { at: Date.now(), list: mapped }
        this.pruneInbox(mapped)
        return mapped
      })()
        .catch((e) => {
          if (this.catalogCache.at) return this.catalogCache.list
          throw e
        })
        .finally(() => { this.catalogPromise = null })
      return this.catalogPromise
    }
    if (this.catalogCache.at > 0) {
      run().catch(() => {})
      return Promise.resolve(this.catalogCache.list)
    }
    return run()
  }

  async start() {
    await saveRecord(this.id, this.record)
    this.timer = setInterval(() => {
      this.enqueue(async () => {
        await this.ensure()
        await this.macroTick()
        await this.guardTick()
        await this.visitScan()
      }).catch((e) => log(this.id, e && e.message ? e.message : e))
    }, 20000)
    if (this.timer.unref) this.timer.unref()
    this.enqueue(() => this.ensure()).catch((e) => log(this.id, e && e.message ? e.message : e))
  }

  async ensure() {
    if (this.stopped || this.record.needs_register) return
    if (!this.client || !this.client.isConnected()) {
      if (this.listener) {
        try { this.listener.stop() } catch {}
        this.listener = null
      }
      await this.open()
    }
    if (!this.client || this.record.needs_register || this.listener) return
    this.listener = new KakaoTalkListener(this.client)
    this.listener.on('message', (ev) => {
      this.enqueue(() => this.onMessage(ev)).catch((e) => log(this.id, e && e.message ? e.message : e))
    })
    this.listener.on('member_joined', (ev) => {
      this.enqueue(() => this.onMember('join', ev)).catch((e) => log(this.id, e && e.message ? e.message : e))
    })
    this.listener.on('member_left', (ev) => {
      this.enqueue(() => this.onMember('leave', ev)).catch((e) => log(this.id, e && e.message ? e.message : e))
    })
    this.listener.on('kakaotalk_event', (ev) => {
      this.noteLink(ev)
    })
    this.listener.on('error', (err) => {
      this.enqueue(() => this.onError(err)).catch(() => {})
    })
    this.listener.on('disconnected', () => {
      if (!this.stopped && !this.record.needs_register) {
        this.listener = null
        this.enqueue(() => this.ensure()).catch(() => {})
      }
    })
    await this.listener.start()
    this.enqueue(() => this.visitScan()).catch(() => {})
  }

  async stop() {
    this.stopped = true
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    if (this.unpush) {
      try { this.unpush() } catch {}
      this.unpush = null
    }
    try { this.listener && this.listener.stop() } catch {}
    try { this.client && this.client.close() } catch {}
    this.listener = null
    this.client = null
    this.inbox.clear()
    this.catalogCache = { at: 0, list: [] }
  }

  enqueue(fn) {
    const run = this.chain.then(fn, fn)
    this.chain = run.then(() => {}, () => {})
    return run
  }

  async open() {
    if (this.stopped || this.record.needs_register) return
    const creds = credsOf(this.record)
    try {
      if (this.client) {
        try { this.client.close() } catch {}
      }
      const client = newKakaoClient()
      await client.login({
        oauthToken: creds.access_token,
        userId: creds.user_id,
        deviceUuid: creds.device_uuid,
        deviceType: creds.device_type,
      })
      client.onSessionEvent((ev) => {
        if (ev && ev.type === 'kicked') {
          // KICKOUT 사유가 0·1·없음일 때만 진짜 종료. -2(CHANGE_SERVER) 와 그 밖은 다시 붙는다(5.2)
          if (kickoutDead(ev.reason)) this.markDead('kicked').catch(() => {})
          else this.enqueue(() => this.ensure()).catch(() => {})
        }
      })
      await client.acquireSession()
      if (this.unpush) {
        try { this.unpush() } catch {}
        this.unpush = null
      }
      // The listener only emits message for method MSG. Open-chat feed lines
      // also arrive on other packets, and a throw in that handler is dropped.
      this.unpush = client.onPush((packet) => {
        tracePush(this.id, packet)
        this.enqueue(() => this.onPacket(packet)).catch(() => {})
      })
      this.visitEntered.clear()
      this.client = client
      this.refreshed = false
      this.record.needs_register = false
      this.record.reason = 'ok'
    } catch (e) {
      const code = e && e.code
      if (code === 'invalid_access_token' && !this.refreshed) {
        const ok = await this.refresh()
        if (ok) return this.open()
      }
      if (DEAD.has(code) || code === 'invalid_access_token' || code === 'login_rejected') {
        await this.markDead(code || 'reauth')
        return
      }
      log(this.id, `session open failed: ${code || ''} ${e && e.message ? e.message : e}`)
    }
  }

  async refresh() {
    this.refreshed = true
    const creds = credsOf(this.record)
    try {
      const r = await refreshKakaoOAuthToken({
        accessToken: creds.access_token,
        refreshToken: creds.refresh_token,
        deviceUuid: creds.device_uuid,
      })
      this.record.credentials.access_token = r.accessToken
      this.record.credentials.refresh_token = r.refreshToken
      await saveRecord(this.id, this.record)
      return true
    } catch (e) {
      log(this.id, `token refresh failed: ${e && e.code ? e.code : e}`)
      return false
    }
  }

  async markDead(reason) {
    this.record.needs_register = true
    this.record.reason = reason || 'reauth'
    this.record.credentials = {
      access_token: '',
      refresh_token: '',
      user_id: credsUser(this.record),
      device_uuid: '',
      device_type: 'tablet',
    }
    await saveRecord(this.id, this.record)
    log(this.id, `session ended: ${this.record.reason}`)
    await this.stop()
  }

  async onError(err) {
    const code = err && err.code
    if (code === 'invalid_access_token' && !this.refreshed) {
      if (await this.refresh()) {
        await this.open()
        return
      }
    }
    if (code === 'invalid_access_token' || code === 'login_rejected' || (err && /kicked/i.test(String(err.message || '')))) {
      await this.markDead(code || 'kicked')
    }
  }

  async onMessage(ev) {
    if (this.record.needs_register || !ev) return
    const creds = credsOf(this.record)
    const chatId = String(ev.chat_id || '')
    const author = ev.author_id == null ? '' : String(ev.author_id)
    if (ev.log_id) this.lastLog.set(chatId, String(ev.log_id))
    this.noteChat(chatId, {
      logId: ev.log_id ? String(ev.log_id) : '',
      text: typeof ev.message === 'string' ? ev.message : '',
      mine: author.length > 0 && author === creds.user_id,
      at: ev.sent_at || nowAt(),
      author: ev.author_name || '',
      authorId: author,
      type: ev.message_type,
    })
    const taken = await this.takeVisit(chatId, {
      chatId,
      logId: ev.log_id ? String(ev.log_id) : '',
      message: ev.message,
      type: ev.message_type,
      authorId: ev.author_id,
      attachment: ev.attachment,
    })
    const coverEv = {
      chatId,
      text: ev.message || '',
      logId: ev.log_id ? String(ev.log_id) : '',
      messageType: ev.message_type,
      mine: author.length > 0 && author === creds.user_id,
      staff: true,
    }
    if (coverNeedsAuthor(this.record, coverEv)) {
      try {
        coverEv.staff = coverSkipsLink(await this.openPerm(chatId, author))
      } catch (e) {
        coverEv.staff = true
        await this.onError(e)
      }
    }
    const cover = coverPlan(this.record, coverEv)
    if (cover) await this.coverMessage(cover)
    if (taken) return
    const sends = onInbound(this.record, {
      chatId,
      text: ev.message || '',
      authorName: ev.author_name || '',
      mine: author.length > 0 && author === creds.user_id,
    })
    const guard = guardOnChat(this.record, {
      kind: 'msg',
      chatId,
      text: ev.message || '',
      authorId: author,
      authorName: ev.author_name || '',
      mine: author.length > 0 && author === creds.user_id,
      messageType: ev.message_type,
      now: Date.now(),
    })
    await saveRecord(this.id, this.record)
    for (const s of sends) await this.deliver(s)
    await this.finishGuard(guard)
  }

  async onMember(kind, ev) {
    if (this.record.needs_register || !ev) return
    const creds = credsOf(this.record)
    const chatId = String(ev.chat_id || '')
    let author = memberId(ev.member)
    let authorName = typeof ev.author_name === 'string' ? ev.author_name.trim() : ''
    let profileLink = ''
    if (this.client && visitNeedsProfile(this.record, chatId) && (author || authorName)) {
      try {
        const lookedUp = authorName ? await this.memberIdByName(chatId, authorName) : ''
        const cardFor = lookedUp || author
        const card = cardFor ? await this.memberCard(chatId, cardFor) : { name: '', link: '', userId: '' }
        const resolved = visitMemberId(author, authorName, lookedUp, card)
        author = resolved.userId
        if (resolved.name) authorName = resolved.name
        if (author && card.link && (!card.userId || card.userId === author)) profileLink = card.link
      } catch (e) {
        await this.onError(e)
      }
    }
    if (this.record.needs_register) return
    const mine = author.length > 0 && author === creds.user_id
    // 같은 입장·퇴장 판정은 logId 가 있으면 logId 로, 없으면 5초(7.2(a), 계정 단위 옛 기능에도 같은 규칙)
    const guard = guardOnChat(this.record, {
      kind,
      chatId,
      text: '',
      authorId: author,
      authorName,
      profileLink,
      mine,
      now: Date.now(),
      logId: ev.log_id ? String(ev.log_id) : '',
      at: atMs(ev.sent_at),
    })
    await this.finishGuard(guard)
  }

  async memberIdByName(chatId, nickname) {
    const want = String(nickname || '').trim()
    if (!want || !this.client) return ''
    const body = await this.client.executeWithReconnect(async ({ session }) => {
      const response = await session.getAllMembers(Long.fromString(String(chatId)))
      return response && response.body
    })
    const members = body && Array.isArray(body.members) ? body.members : []
    const ids = []
    for (const m of members) {
      if (!m || typeof m !== 'object') continue
      const name = String(m.nickName || m.nickname || m.nn || '').trim()
      if (name !== want) continue
      const id = idText(m.userId)
      if (id && !ids.includes(id)) ids.push(id)
    }
    return ids.length === 1 ? ids[0] : ''
  }

  async openPerm(chatId, userId) {
    if (!this.client || !userId) return null
    const members = await this.client.getMembersByIds(chatId, [userId])
    const row = (members || []).find((m) => m && String(m.user_id) === String(userId))
    if (!row || row.open_permission == null || row.open_permission === '') return null
    const n = Number(row.open_permission)
    return Number.isFinite(n) ? n : null
  }

  async memberCard(chatId, userId) {
    if (!this.client || !userId) return { name: '', link: '', userId: '' }
    const members = await this.client.getMembersByIds(chatId, [userId])
    const row = (members || []).find((m) => m && String(m.user_id) === String(userId))
    if (!row) return { name: '', link: '', userId: '' }
    const name = String(row.nickname || '').trim()
    const pli = row.open_profile_link_id ? String(row.open_profile_link_id) : ''
    const link = pli ? await this.openProfileLink(pli) : ''
    const memberUserId = /^[1-9][0-9]*$/.test(String(row.user_id || '')) ? String(row.user_id) : ''
    return { name, link, userId: memberUserId }
  }

  // [프로필 변경 감지]의 옾링을 관찰한 곳에서 몰랐다 → 그 사람 카드에서 찾아 채운다. 못 찾으면 '없음' 그대로.
  async withLink(s) {
    try {
      const card = await this.memberCard(s.chatId, s.linkFor)
      if (card.link && (!card.userId || card.userId === String(s.linkFor))) return withProfileLink(s, card.link)
    } catch (e) {
      await this.onError(e)
    }
    return s
  }

  async openProfileLink(linkId) {
    const id = String(linkId || '').trim()
    if (!/^[1-9][0-9]*$/.test(id)) return ''
    const cached = this.profileLinks.get(id)
    if (cached) return cached
    const body = await this.client.executeWithReconnect(async ({ session }) => {
      const response = await session.getOpenLinkInfo([Long.fromString(id)])
      return response && response.body
    })
    const link = linkFromOpenInfo(body)
    if (link) this.profileLinks.set(id, link)
    return link
  }

  async finishGuard(guard) {
    if (!guard || !guard.active) return
    for (const s of guard.sends || []) await this.deliver(s.linkFor ? await this.withLink(s) : s)
    if (guard.askHalt) await this.stopKickWave(guard.askHalt)
    await saveRecord(this.id, this.record)
  }

  async stopKickWave(ask) {
    let allowed = false
    try {
      const snap = await this.client.getMemberSnapshot(ask.chatId)
      const me = credsOf(this.record).user_id
      const row = (snap.members || []).find((m) => m && String(m.user_id) === me)
      allowed = guardCanStopKicks(row && row.open_permission)
    } catch (e) {
      await this.onError(e)
    }
    guardFinishHalt(this.record, ask.chatId, allowed, Date.now(), ask.roomName, ask.count)
    log(this.id, allowed ? 'kick wave halted' : 'kick wave noticed')
  }

  noteLink(ev) {
    if (!ev) return
    const chatId = ev.chatId != null ? ev.chatId : ev.chat_id
    const li = ev.linkId != null ? ev.linkId : ev.li
    if (chatId == null || li == null || li === '') return
    this.linkIds.set(String(chatId), String(li))
  }

  async visitScan() {
    if (this.record.needs_register || !this.client) return
    const rooms = this.record.rooms || []
    for (const room of rooms) {
      const chatId = String(room && room.chat_id || '')
      if (!visitNeedsProfile(this.record, chatId)) continue
      try {
        await this.scanRoom(chatId)
      } catch (e) {
        await this.onError(e)
      }
    }
  }

  async onPacket(packet) {
    if (this.record.needs_register || !packet) return
    const logs = chatLogsFromBody(packet.body)
    for (const log of logs) {
      const chatId = log.chatId
      if (!chatId || !visitNeedsProfile(this.record, chatId)) continue
      await this.takeVisit(chatId, log)
    }
  }

  async takeVisit(chatId, log) {
    if (!log) return ''
    const id = log.logId ? String(log.logId) : ''
    const key = id ? `${chatId}\u0001${id}` : ''
    if (key && this.visitLogs.has(key)) return 'seen'
    const visits = visitEventsFromMessage({
      message: log.message,
      message_type: log.type,
      author_id: log.authorId,
      attachment: log.attachment,
    })
    if (!visits.length) return ''
    if (key) {
      this.visitLogs.add(key)
      if (this.visitLogs.size > 800) {
        const first = this.visitLogs.values().next().value
        this.visitLogs.delete(first)
      }
    }
    if (id) this.lastLog.set(chatId, id)
    for (const v of visits) {
      await this.onMember(v.kind, {
        chat_id: chatId,
        member: { user_id: v.authorId },
        author_name: v.authorName,
        log_id: id,
        sent_at: log.sendAt,
      })
    }
    return 'visit'
  }

  async consumeLogs(chatId, logs, cursor) {
    const fresh = []
    for (const log of logs || []) {
      if (!log) continue
      const rowChat = log.chatId || chatId
      if (rowChat && rowChat !== chatId) continue
      const id = log.logId ? String(log.logId) : ''
      if (!id || !logAfter(id, cursor)) continue
      fresh.push(log)
    }
    fresh.sort((a, b) => {
      const aa = a.logId ? String(a.logId) : ''
      const bb = b.logId ? String(b.logId) : ''
      if (!aa || aa === bb) return 0
      return logAfter(aa, bb) ? 1 : -1
    })
    const slice = fresh.slice(-8)
    let tip = cursor
    for (const log of slice) {
      const id = log.logId ? String(log.logId) : ''
      if (id && logAfter(id, tip)) tip = id
      await this.takeVisit(chatId, log)
    }
    return tip
  }

  async scanRoom(chatId) {
    if (!this.visitEntered.has(chatId)) {
      try {
        const session = await this.client.acquireSession()
        const on = await session.getChatInfo(Long.fromString(chatId))
        this.visitEntered.add(chatId)
        const cursor = this.visitCursor.get(chatId) || ''
        await this.consumeLogs(chatId, chatLogsFromBody(on && on.body, chatId), cursor)
      } catch (e) {
        log(this.id, `room enter failed: ${e && e.message ? e.message : e}`)
      }
    }
    const session = await this.client.acquireSession()
    const infoRes = await session.getChannelInfo(Long.fromString(chatId))
    const body = infoRes && infoRes.body
    const info = body && body.chatInfo
    if (!info || info.left === true) return
    const max = idText(info.lastLogId) || idText(info.lastChatLog && info.lastChatLog.logId)
    if (!max) return
    const li = idText(info.li)
    if (li) this.linkIds.set(chatId, li)
    const cursor = this.visitCursor.get(chatId) || ''
    let tip = await this.consumeLogs(chatId, chatLogsFromBody(body, chatId), cursor)
    if (cursor && logAfter(max, cursor)) {
      try {
        let from = cursor
        for (let page = 0; page < 2; page++) {
          const res = await this.client.getMessagePage(chatId, { from, count: 40 })
          const msgs = (res && res.messages) || []
          const mapped = msgs.map((m) => ({
            chatId,
            logId: m && m.log_id ? String(m.log_id) : '',
            message: m && m.message,
            type: m && m.type,
            authorId: m && m.author_id,
            attachment: m && m.attachment,
          }))
          const got = await this.consumeLogs(chatId, mapped, cursor)
          if (logAfter(got, tip)) tip = got
          const next = res && res.next_cursor ? String(res.next_cursor) : ''
          if (!msgs.length || (res && res.complete) || !next || !logAfter(next, from)) break
          from = next
        }
        if (!logAfter(max, tip)) tip = max
      } catch (e) {
        log(this.id, `room log read failed: ${e && e.message ? e.message : e}`)
      }
    } else if (!cursor) {
      tip = max
    }
    if (tip && tip !== cursor) this.visitCursor.set(chatId, tip)
  }

  async guardTick() {
    if (this.record.needs_register || !this.client) return
    const due = guardDue(this.record, Date.now())
    for (const chatId of due.presence) await this.presence(chatId)
    for (const s of due.sends) await this.deliver(s)
    if (due.presence.length || due.sends.length) await saveRecord(this.id, this.record)
  }

  async presence(chatId) {
    const linkId = this.linkIds.get(String(chatId))
    const opts = linkId ? { linkId } : undefined
    try {
      await this.client.sendTyping(chatId, opts)
      return
    } catch (e) {
      await this.onError(e)
    }
    const logId = this.lastLog.get(String(chatId))
    if (!logId) return
    try {
      await this.client.markRead(chatId, logId, opts)
    } catch (e) {
      await this.onError(e)
    }
  }

  async linkIdFor(chatId) {
    const have = this.linkIds.get(String(chatId))
    if (have && /^[1-9][0-9]*$/.test(have)) return have
    if (!this.client) return ''
    const infoRes = await this.client.executeWithReconnect(async ({ session }) => {
      return session.getChannelInfo(Long.fromString(String(chatId)))
    })
    const info = infoRes && infoRes.body && infoRes.body.chatInfo
    const li = idText(info && info.li)
    if (li) this.linkIds.set(String(chatId), li)
    return li || ''
  }

  async coverMessage(plan) {
    if (!this.client || !plan) return
    const key = `${plan.chatId}\u0001${plan.logId}`
    if (this.coverLogs.has(key)) return
    this.coverLogs.add(key)
    if (this.coverLogs.size > 800) {
      const first = this.coverLogs.values().next().value
      this.coverLogs.delete(first)
    }
    try {
      const li = await this.linkIdFor(plan.chatId)
      if (!li) {
        log(this.id, `cover skipped, no link chat ${plan.chatId}`)
        return
      }
      const response = await this.client.executeWithReconnect(async ({ session }) => {
        return session.getConnection().sendPacket('REWRITE', {
          li: Long.fromString(li),
          c: Long.fromString(plan.chatId),
          logId: Long.fromString(plan.logId),
          t: plan.type,
        })
      })
      // 패킷 statusCode 가 0 이어도 본문 status 가 0 이 아니면 실패다(5.5 locoOk)
      if (!locoOk(response)) {
        const status = response && response.statusCode === 0 && response.body ? response.body.status : response && response.statusCode
        log(this.id, `cover failed status ${status} chat ${plan.chatId}`)
      } else log(this.id, `covered chat ${plan.chatId}`)
    } catch (e) {
      await this.onError(e)
    }
  }

  async writeMention(chatId, text, extra) {
    this.mentionSeq += 1
    const msgId = Long.fromNumber(this.mentionSeq)
    const response = await this.client.executeWithReconnect(async ({ session }) => {
      return session.getConnection().sendPacket('WRITE', {
        chatId: Long.fromString(String(chatId)),
        msgId,
        msg: text,
        type: 1,
        noSeen: false,
        scope: 1,
        extra,
      })
    })
    return {
      log_id: idText(response && response.body && response.body.logId),
    }
  }

  // 지연이 있는 안내는 작업 줄 밖에서 기다렸다가 줄에 넣는다(5.1). 줄 안에서 기다리면 그동안 다른 일이 멈춘다.
  async deliver(s) {
    if (this.record.needs_register) return
    if (s.delayMs > 0) {
      const t = setTimeout(() => {
        if (this.stopped) return
        this.enqueue(() => this.deliverNow(s)).catch((e) => log(this.id, e && e.message ? e.message : e))
      }, s.delayMs)
      if (t.unref) t.unref()
      return
    }
    return this.deliverNow(s)
  }

  async deliverNow(s) {
    if (this.record.needs_register || !this.client) return
    try {
      const extra = visitMentionExtra(s.text, s.mention)
      const res = extra
        ? await this.writeMention(s.chatId, s.text, extra)
        : await this.client.sendMessage(s.chatId, s.text)
      const sentId = realLogId(res && res.log_id)
      if (!sentId) log(this.id, `send missing log id chat ${s.chatId}`)
      // 자동응답·안내도 채팅 화면에 남긴다. 안 그러면 답한 줄 모르고 또 답하게 된다.
      else this.noteChat(String(s.chatId), { logId: sentId, text: String(s.text || ''), mine: true, at: nowAt(), type: 1 })
    } catch (e) {
      await this.onError(e)
      log(this.id, `send failed: ${e && e.code ? e.code : e}`)
    }
  }

  async macroTick() {
    if (this.record.needs_register || !this.client) return
    if (macroNotifyReply(this.record)) return
    const now = Date.now()
    const rooms = macroRoomsDue(this.record, now)
    const macro = this.record.config && this.record.config.macro
    if (!macro || !rooms.length) return
    const need = macroMinMessages(this.record)
    const creds = credsOf(this.record)
    for (const room of rooms) {
      let others = 0
      try {
        others = await othersSinceMine(this.client, room.chatId, creds.user_id)
      } catch (e) {
        await this.onError(e)
        noteMacroRetry(this.record, room.key, now)
        continue
      }
      if (others < need) {
        noteMacroWait(this.record, room.key, now)
        continue
      }
      try {
        const res = await this.client.sendMessage(room.chatId, String(macro.message))
        const sentId = realLogId(res && res.log_id)
        if (!sentId) throw new Error('undelivered')
        this.noteChat(String(room.chatId), { logId: sentId, text: String(macro.message), mine: true, at: nowAt(), type: 1 })
        const withImages = noteMacroSent(this.record, room.key, Date.now())
        if (withImages) await this.sendStoredImages(room.chatId)
      } catch (e) {
        await this.onError(e)
        noteMacroRetry(this.record, room.key, now)
      }
      await sleep(1000 + Math.floor(Math.random() * 2000))
    }
    await saveRecord(this.id, this.record)
  }

  async sendStoredImages(chatId) {
    const images = this.record.images || []
    const bufs = []
    for (const item of images) {
      if (!item) continue
      const b64 = typeof item === 'string' ? item : item.b64
      if (!b64) continue
      const buf = Buffer.from(b64, 'base64')
      if (buf.length > 0 && buf.length <= 20 * 1024 * 1024) bufs.push(buf)
      if (bufs.length >= 5) break
    }
    if (!bufs.length) return
    await this.client.acquireSession()
    if (bufs.length === 1) {
      const res = await this.client.sendPhoto(chatId, bufs[0], 'photo-1.jpg')
      if (!realLogId(res && res.log_id)) log(this.id, 'image send missing log id')
      return
    }
    const res = await this.client.sendMultiPhoto(chatId, bufs.map((data, i) => ({
      data,
      filename: `photo-${i + 1}.jpg`,
    })))
    if (!realLogId(res && res.log_id)) log(this.id, 'multi image send missing log id')
  }
}

function memberId(member) {
  if (!member || member.user_id == null) return ''
  const v = member.user_id
  const s = typeof v === 'object' && typeof v.toString === 'function' ? v.toString() : String(v)
  return /^[1-9][0-9]*$/.test(s) ? s : ''
}

function linkFromOpenInfo(body) {
  const row = body && Array.isArray(body.ols) ? body.ols[0] : null
  if (!row || typeof row !== 'object') return ''
  const candidates = [row.lu, row.url, row.linkUrl]
  for (const c of candidates) {
    const s = typeof c === 'string' ? c.trim() : ''
    if (/^https:\/\/open\.kakao\.com\//i.test(s)) return s
  }
  return ''
}

function socketUp(slot) {
  try {
    return !!(slot && slot.client && typeof slot.client.isConnected === 'function' && slot.client.isConnected())
  } catch {
    return false
  }
}

function credsUser(record) {
  return String((record.credentials && record.credentials.user_id) || '')
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export { realId, Slot, credsOf }
