import * as Word from './word.mjs'
import * as Quiz from './quiz.mjs'

const SEP = '\u0001'
const WORD_TURN_MS = 30000
const BASEBALL_TRIES = 10
const BASEBALL_TTL_MS = 15 * 60 * 1000
const QUIZ_TTL_MS = 5 * 60 * 1000
const P_WORD = 1
const P_WORD_WIN = 3
const P_BASEBALL = 5
const P_RPS = 1
const P_QUIZ = 2
const ADMIN_CALL_AT = 3
const ROOM_COOLDOWN_MS = 3000
const FLOOD_WARN_MS = 60000
const ECHO_MS = 60000
const JOIN_DEDUP_MS = 10000
const JOIN_WORDS = ['들어왔습니다', '들어왔어요', '입장했습니다', '입장하셨습니다', '입장했어요', '참여했습니다', '참여하셨습니다', '들어왔네요']
const LEAVE_WORDS = ['나갔습니다', '나갔어요', '나가셨습니다', '퇴장했습니다', '퇴장하셨습니다', '퇴장했어요', '떠났습니다']
const LINK_RE = /(?:https?:\/\/|open\.kakao\.com|kakao\.com\/o\/|www\.|[a-z0-9-]{2,}\.(?:com|net|org|kr|me|io|tv|cc|gg|xyz|link|shop|site|club|top|info|biz)(?![a-z0-9]))/i

export function seoulParts(ms) {
  const fmt = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Seoul',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  })
  const bag = {}
  for (const p of fmt.formatToParts(new Date(ms))) bag[p.type] = p.value
  return bag
}

function clock(ms) {
  const p = seoulParts(ms)
  return `${p.hour}:${p.minute}`
}
function date(ms) {
  const p = seoulParts(ms)
  return `${p.year}-${p.month}-${p.day}`
}
function hourOf(ms) {
  return Number(seoulParts(ms).hour)
}
function dayKey(ms) {
  const p = seoulParts(ms)
  return `${p.year}-${p.month}-${p.day}`
}

export function parseRoomKey(key) {
  const s = key == null ? '' : String(key)
  const i = s.indexOf(SEP)
  if (i < 0) return { acc: '0', name: s.trim(), key: `0${SEP}${s.trim()}` }
  return { acc: s.slice(0, i), name: s.slice(i + 1), key: s }
}

export function accountOn(config, acc) {
  const list = config && config.accounts
  if (!Array.isArray(list) || list.length === 0) return true
  const a = acc && String(acc).trim() ? String(acc).trim() : '0'
  return list.some((k) => k && String(k).trim() === a)
}

export function roomByChat(rooms, chatId) {
  const id = String(chatId || '')
  if (!id) return null
  for (const r of rooms || []) {
    if (r && String(r.chat_id) === id) return r
  }
  return null
}

export function chatForRoom(rooms, roomKey) {
  const want = parseRoomKey(roomKey)
  for (const r of rooms || []) {
    if (!r) continue
    if (r.key === want.key || r.key === roomKey) return String(r.chat_id || '')
    const p = parseRoomKey(r.key)
    if (p.acc === want.acc && p.name === want.name) return String(r.chat_id || '')
  }
  return ''
}

function realId(id) {
  return typeof id === 'string' && /^[1-9][0-9]*$/.test(id)
}

function bareRoomName(name) {
  return String(name || '').trim().replace(/\s+\d{2,7}$/, '').trim()
}

function sameRoomName(a, b) {
  if (a === b) return true
  const left = bareRoomName(a)
  const right = bareRoomName(b)
  return left.length > 0 && left === right
}

function coversList(list, roomKey) {
  if (!Array.isArray(list) || list.length === 0) return false
  const p = parseRoomKey(roomKey)
  return list.some((k) => {
    const q = parseRoomKey(k)
    return q.key === p.key || (q.acc === p.acc && sameRoomName(q.name, p.name))
  })
}

function triggerCovers(t, roomKey) {
  const rooms = t && t.rooms
  if (!Array.isArray(rooms) || rooms.length === 0) return true
  return coversList(rooms, roomKey)
}

function matchTrigger(t, text) {
  const pattern = t.pattern == null ? '' : String(t.pattern)
  if (!pattern || text == null) return false
  const mode = t.mode || 'contains'
  if (mode === 'regex') {
    try {
      const flags = t.ignoreCase === false ? '' : 'iu'
      return new RegExp(pattern, flags).test(text)
    } catch {
      return false
    }
  }
  let m = String(text)
  let p = pattern
  if (t.ignoreCase !== false) {
    m = m.toLowerCase()
    p = p.toLowerCase()
  }
  if (mode === 'exact') return m.trim() === p.trim()
  if (mode === 'starts') return m.startsWith(p)
  return m.includes(p)
}

function renderTrigger(t, room, name, msg, now) {
  return String(t.reply || '')
    .replaceAll('{방}', room || '')
    .replaceAll('{이름}', name || '')
    .replaceAll('{메시지}', msg || '')
    .replaceAll('{시간}', clock(now))
}

function inHours(cfg, ms) {
  const f = Math.max(0, Math.min(24, Number(cfg.hourFrom) || 0))
  const t = Math.max(0, Math.min(24, Number(cfg.hourTo) || 0))
  if (f === t || (f === 0 && t === 24)) return true
  const h = hourOf(ms)
  if (f < t) return h >= f && h < t
  return h >= f || h < t
}

function renderReply(cfg, name, now) {
  return String(cfg.message || '')
    .replaceAll('{이름}', name || '')
    .replaceAll('{시간}', clock(now))
    .replaceAll('{날짜}', date(now))
}

function nameOf(who) {
  const n = who == null ? '' : String(who).trim()
  return n || '누군가'
}

function renderBot(tpl, room, who, now, count, word) {
  return String(tpl || '')
    .replaceAll('{방}', room || '')
    .replaceAll('{이름}', nameOf(who))
    .replaceAll('{시간}', clock(now))
    .replaceAll('{날짜}', date(now))
    .replaceAll('{횟수}', String(count))
    .replaceAll('{금지어}', word || '')
}

function squash(s) {
  return String(s || '').replace(/\s+/g, '').toLowerCase()
}

function banHit(cfg, body) {
  const words = cfg.banWords || []
  const m = squash(body)
  if (!m) return null
  for (const raw of words) {
    const w = squash(raw)
    if (w && m.includes(w)) return String(raw).trim()
  }
  return null
}

function tailWord(body, words) {
  for (const w of words) {
    const at = body.lastIndexOf(w)
    if (at < 0) continue
    const rest = body.length - (at + w.length)
    if (rest <= 2) return at
  }
  return -1
}

function joinLeaveKind(body) {
  if (tailWord(body, JOIN_WORDS) >= 0) return 1
  if (tailWord(body, LEAVE_WORDS) >= 0) return 2
  return 0
}

function personOf(body) {
  let at = tailWord(body, JOIN_WORDS)
  if (at < 0) at = tailWord(body, LEAVE_WORDS)
  if (at < 0) return ''
  let head = body.slice(0, at).trim()
  const nim = head.lastIndexOf('님')
  if (nim > 0) head = head.slice(0, nim).trim()
  return head.replace(/[,\s·]+$/g, '').trim()
}

function decimalId(v) {
  if (v == null || v === '') return ''
  if (typeof v === 'string') {
    const s = v.trim()
    return /^[1-9][0-9]*$/.test(s) ? s : ''
  }
  if (typeof v === 'bigint') return v > 0n ? v.toString() : ''
  if (typeof v === 'number') return Number.isSafeInteger(v) && v > 0 ? String(v) : ''
  if (typeof v === 'object' && typeof v.toString === 'function') {
    const s = v.toString()
    if (/^[1-9][0-9]*$/.test(s)) return s
  }
  return ''
}

function feedKind(ft) {
  if (ft === 1 || ft === 4) return 'join'
  if (ft === 2 || ft === 3) return 'leave'
  return ''
}

function feedTypeOf(raw, obj) {
  if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
    const n = Number(obj.feedType)
    if (Number.isInteger(n)) return n
  }
  const m = /"feedType"\s*:\s*(-?\d+)/.exec(String(raw || ''))
  return m ? Number(m[1]) : NaN
}

function decodeNick(raw) {
  if (!raw) return ''
  try {
    return JSON.parse('"' + raw + '"')
  } catch {
    return raw
  }
}

function peopleInJson(raw) {
  const text = String(raw || '')
  const out = []
  const re = /\{[^{}]*"userId"\s*:\s*"?([0-9]+)"?[^{}]*\}/g
  let m
  while ((m = re.exec(text))) {
    const id = /^[1-9][0-9]*$/.test(m[1]) ? m[1] : ''
    if (!id) continue
    const nick = /"nickName"\s*:\s*"((?:\\.|[^"\\])*)"/.exec(m[0])
    const name = String(decodeNick(nick ? nick[1] : '') || '').trim().slice(0, 40)
    out.push({ id, name })
  }
  return out
}

function inviterIds(raw) {
  const set = new Set()
  const re = /"inviter"\s*:\s*(\{[^{}]*\})/g
  let m
  while ((m = re.exec(String(raw || '')))) {
    for (const p of peopleInJson(m[1])) set.add(p.id)
  }
  return set
}

function uniquePeople(list) {
  const out = []
  const seen = new Set()
  for (const p of list) {
    if (!p || !p.id || seen.has(p.id)) continue
    seen.add(p.id)
    out.push(p)
  }
  return out
}

function peopleFromFeedObject(obj, ft) {
  const rows = []
  const push = (m) => {
    if (!m || typeof m !== 'object') return
    const id = decimalId(m.userId != null ? m.userId : m.user_id)
    if (!id) return
    const name = String(m.nickName || m.nickname || '').trim().slice(0, 40)
    rows.push({ id, name })
  }
  if (Array.isArray(obj.members)) {
    for (const m of obj.members) push(m)
  }
  if (ft !== 1) push(obj.member)
  push(obj.leaver)
  return rows
}

function eventsFromFeed(raw, obj) {
  const ft = feedTypeOf(raw, obj)
  const kind = feedKind(ft)
  if (!kind) return []
  let people = raw ? peopleInJson(raw) : []
  if (!people.length && obj) people = peopleFromFeedObject(obj, ft)
  if (ft === 1) {
    const skip = inviterIds(raw)
    people = people.filter((p) => !skip.has(p.id))
  }
  return uniquePeople(people).map((p) => ({ kind, authorId: p.id, authorName: p.name }))
}

function eventsFromKoreanFeed(text, author) {
  const body = String(text || '').trim()
  if (!body || body.length > 80 || body.charAt(0) === '{') return []
  const kindN = joinLeaveKind(body)
  if (!kindN) return []
  const at = tailWord(body, kindN === 1 ? JOIN_WORDS : LEAVE_WORDS)
  if (at < 0) return []
  const head = body.slice(0, at).trim()
  if (!/님이?$/.test(head)) return []
  const name = personOf(body).slice(0, 40)
  if (!name) return []
  return [{
    kind: kindN === 1 ? 'join' : 'leave',
    authorId: decimalId(author),
    authorName: name,
  }]
}

function asChatLog(raw, hint) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const message = raw.message != null ? raw.message : (raw.msg != null ? raw.msg : null)
  const attachment = raw.attachment
  const hasAttachment = attachment != null && attachment !== ''
  if (message == null && !hasAttachment) return null
  const logId = decimalId(raw.logId != null ? raw.logId : raw.log_id)
  const chatId = decimalId(raw.chatId != null ? raw.chatId : raw.chat_id) || hint || ''
  return {
    chatId,
    logId,
    message: message == null ? '' : String(message),
    type: raw.type != null ? raw.type : raw.message_type,
    authorId: raw.authorId != null ? raw.authorId : raw.author_id,
    attachment,
  }
}

function collectChatLog(out, seen, raw, hint) {
  const log = asChatLog(raw, hint)
  if (!log) return
  const key = log.logId ? `${log.chatId}\u0001${log.logId}` : `${log.chatId}\u0001${log.message}`
  if (seen.has(key)) return
  seen.add(key)
  out.push(log)
}

function collectChatList(out, seen, list, hint) {
  if (!Array.isArray(list)) return
  for (const row of list) collectChatLog(out, seen, row, hint)
}

/**
 * Chat logs carried by any LOCO body, not only a MSG packet.
 * CHATINFO keeps the current line on chatInfo.lastChatLog. SYNCMSG and
 * MCHATLOGS use chatLogs. A sub-device push may use either shape.
 */
export function chatLogsFromBody(body, chatHint) {
  const out = []
  const seen = new Set()
  if (!body || typeof body !== 'object') return out
  const hint = decimalId(chatHint) || decimalId(body.chatId) || decimalId(body.chat_id) || decimalId(body.c) || ''
  collectChatLog(out, seen, body.chatLog, hint)
  collectChatLog(out, seen, body.lastChatLog, hint)
  collectChatList(out, seen, body.chatLogs, hint)
  collectChatList(out, seen, body.chatlogs, hint)
  const info = body.chatInfo && typeof body.chatInfo === 'object' ? body.chatInfo : null
  if (info) {
    const infoHint = decimalId(info.chatId) || decimalId(info.c) || hint
    collectChatLog(out, seen, info.lastChatLog, infoHint)
    collectChatLog(out, seen, info.chatLog, infoHint)
    collectChatList(out, seen, info.chatLogs, infoHint)
  }
  return out
}

/**
 * Open-chat join and leave are the sentence Kakao shows:
 * "홍보ㄱㄱ님이 들어왔습니다." / "님이 나갔습니다."
 * That sentence is the packet text. It is not only a feedType JSON object,
 * and it often has no numeric author id.
 * Returns one event per person. Kick feeds are left for the room guard.
 */
export function visitEventsFromMessage(ev) {
  if (!ev || typeof ev !== 'object') return []
  const message = ev.message != null ? ev.message : ev.text
  const text = message == null ? '' : String(message).trim()
  if (text.charAt(0) === '{') {
    let obj = null
    try {
      const parsed = JSON.parse(text)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) obj = parsed
    } catch {
      obj = null
    }
    const fromText = eventsFromFeed(text, obj)
    if (fromText.length) return fromText
  }
  const attachment = ev.attachment
  if (typeof attachment === 'string' && attachment.trim().charAt(0) === '{') {
    const fromRaw = eventsFromFeed(attachment.trim(), null)
    if (fromRaw.length) return fromRaw
  }
  if (attachment && typeof attachment === 'object' && !Array.isArray(attachment)) {
    const fromObj = eventsFromFeed('', attachment)
    if (fromObj.length) return fromObj
  }
  const author = ev.author_id != null ? ev.author_id : ev.authorId
  return eventsFromKoreanFeed(text, author)
}

function isAdmin(cfg, who) {
  const n = String(who || '').trim()
  return (cfg.adminNames || []).some((a) => String(a || '').trim() === n)
}

function adminCall(cfg, n) {
  if (n < ADMIN_CALL_AT) return ''
  const names = (cfg.adminNames || []).map((a) => String(a || '').trim()).filter(Boolean).join(', ')
  let s = `\n경고 ${n}회 누적. `
  s += names ? `관리자 ${names}의 확인이 필요합니다.` : '관리자 확인이 필요합니다.'
  s += ' (봇은 강제퇴장을 수행할 수 없습니다.)'
  return s
}

function cooldownMs(macro, roomKey) {
  const own = macro.roomCooldownMin && Number(macro.roomCooldownMin[roomKey])
  if (own >= 1) return Math.min(1440, own) * 60000
  const base = Math.max(1, Number(macro.baseMin) || 1)
  const span = Math.max(0, Number(macro.randomMin) || 0)
  const extra = span > 0 ? Math.floor(Math.random() * (span + 1)) : 0
  return (base + extra) * 60000
}

function imagesThisTime(macro, seq) {
  const images = macro.images || []
  if (!images.length) return false
  // Saved "NEVER" is no longer a mode. With images attached it sends every time.
  const mode = macro.sendImages === 'NEVER' ? 'EVERY' : macro.sendImages
  if (mode === 'EVERY') return true
  if (mode === 'EVERY_N') {
    const n = Math.max(1, Number(macro.imageEveryN) || 1)
    return seq > 0 && seq % n === 0
  }
  return false
}

function rt(record) {
  if (!record.runtime) record.runtime = {}
  const r = record.runtime
  r.roomDueAt = r.roomDueAt || {}
  r.roomLastSent = r.roomLastSent || {}
  r.triggerCd = r.triggerCd || {}
  r.triggerOnce = r.triggerOnce || {}
  r.replyLast = r.replyLast || {}
  r.warns = r.warns || {}
  r.warnAt = r.warnAt || {}
  r.flood = r.flood || {}
  r.floodWarn = r.floodWarn || {}
  r.said = r.said || {}
  r.games = r.games || {}
  r.scores = r.scores || {}
  r.asked = r.asked || {}
  r.knownRooms = r.knownRooms || {}
  r.botLast = r.botLast || {}
  r.gameLast = r.gameLast || {}
  r.joinSeen = r.joinSeen || {}
  return r
}

function pushSend(out, chatId, text, delayMs) {
  if (!realId(chatId) || !text || !String(text).trim()) return
  out.push({ chatId, text: String(text), delayMs: delayMs || 0, images: null })
}

function featureOn(record, id) {
  const f = record.features || {}
  return f[id] !== false
}

export function onInbound(record, msg) {
  const out = []
  const config = record.config || {}
  const room = roomByChat(record.rooms, msg.chatId)
  if (!room || !realId(String(room.chat_id))) return out
  const text = msg.text == null ? '' : String(msg.text)
  if (!text.trim()) return out
  const parsed = parseRoomKey(room.key)
  if (!accountOn(config, parsed.acc)) return out
  const group = room.kind === 'group' || room.kind === 'open'
  const who = msg.authorName || ''
  const mine = !!msg.mine
  const now = Date.now()
  const state = rt(record)
  const unknown = !state.knownRooms[room.key]

  if (featureOn(record, 'macro')) {
    triggers(record, out, room, parsed, who, text, mine, now)
    if (!group && !mine) autoReply(record, out, room, parsed, who, text, now, state, unknown)
  }
  state.knownRooms[room.key] = true
  if (!mine) {
    if (featureOn(record, 'roombot')) roomBot(record, out, room, parsed, who, text, group, now, state)
    if (featureOn(record, 'minigame')) miniGame(record, out, room, parsed, who, text, now, state)
  }
  return out
}

function triggers(record, out, room, parsed, who, text, mine, now) {
  const list = (record.config && record.config.triggers) || []
  const state = rt(record)
  for (const t of list) {
    if (!t || t.enabled === false || !t.id) continue
    if (!triggerCovers(t, room.key)) continue
    if (mine && !t.fromMe) continue
    if (!matchTrigger(t, text)) continue
    const once = state.triggerOnce[t.id] || []
    if (t.oncePerRoom && once.includes(room.key)) continue
    const cool = Math.max(0, Number(t.cooldownMs) || 0)
    const last = Number(state.triggerCd[t.id] || 0)
    if (last && now - last < cool) continue
    let destKey = room.key
    const tgt = String(t.target || '').trim()
    if (tgt) destKey = tgt.includes(SEP) ? tgt : `${parsed.acc}${SEP}${tgt}`
    const chatId = chatForRoom(record.rooms, destKey)
    if (!realId(chatId)) continue
    const msg = renderTrigger(t, parsed.name, who, text, now)
    if (!msg.trim()) continue
    state.triggerCd[t.id] = now
    if (t.oncePerRoom) {
      once.push(room.key)
      state.triggerOnce[t.id] = once
    }
    const cap = Math.max(0, Math.min(60000, Number(t.delayMs) || 0))
    const wait = cap > 0 ? Math.floor(Math.random() * (cap + 1)) : 0
    pushSend(out, chatId, msg, wait)
  }
}

function autoReply(record, out, room, parsed, who, text, now, state, unknown) {
  const cfg = record.config && record.config.autoreply
  if (!cfg || !cfg.enabled) return
  if (!String(cfg.message || '').trim()) return
  const scope = cfg.scope || 'ALL'
  if (scope === 'UNKNOWN' && !unknown) return
  if (scope === 'EXCEPT' && coversList(cfg.exceptRooms || [], room.key)) return
  if (!inHours(cfg, now)) return
  const day = dayKey(now)
  if (state.replyDay !== day) {
    state.replyDay = day
    state.replyCount = 0
  }
  const key = who ? `${parsed.acc}${SEP}${who}` : room.key
  const last = Number(state.replyLast[key] || 0)
  if (cfg.firstOnly && last) return
  const cool = Math.max(0, Number(cfg.cooldownMs) || 0)
  if (last && now - last < cool) return
  const limit = Number(cfg.dailyLimit) || 0
  if (limit > 0 && state.replyCount >= limit) return
  const msg = renderReply(cfg, who || parsed.name, now)
  if (!msg.trim()) return
  state.replyLast[key] = now
  state.replyCount += 1
  const cap = Math.max(0, Math.min(120000, Number(cfg.delayMaxMs) || 0))
  const wait = cap > 0 ? Math.floor(Math.random() * (cap + 1)) : 0
  pushSend(out, room.chat_id, msg, wait)
}

function botCanSend(state, cfg, roomKey, now) {
  const day = dayKey(now)
  if (state.botDay !== day) {
    state.botDay = day
    state.botCount = 0
  }
  const limit = Number(cfg.dailyLimit) || 0
  if (limit > 0 && state.botCount >= limit) return false
  const last = Number(state.botLast[roomKey] || 0)
  if (last && now - last < ROOM_COOLDOWN_MS) return false
  return true
}

function botSend(state, cfg, room, text, now, out) {
  if (!botCanSend(state, cfg, room.key, now)) return false
  pushSend(out, room.chat_id, text, 0)
  state.botLast[room.key] = now
  state.botCount += 1
  const said = state.said[room.key] || []
  said.push({ text: String(text).trim(), at: now })
  while (said.length > 6) said.shift()
  state.said[room.key] = said
  return true
}

function saidRecently(state, roomKey, body, now) {
  const said = state.said[roomKey] || []
  const t = String(body).trim()
  return said.some((s) => s && s.text === t && now - s.at < ECHO_MS)
}

function bumpWarn(state, roomKey, who, now) {
  const k = `${roomKey}${SEP}${who || ''}`
  const n = (Number(state.warns[k]) || 0) + 1
  state.warns[k] = n
  state.warnAt[k] = now
  return n
}

function warnCount(state, roomKey, who) {
  return Number(state.warns[`${roomKey}${SEP}${who || ''}`] || 0)
}

function roomBot(record, out, room, parsed, who, text, group, now, state) {
  const cfg = record.config && record.config.roombot
  if (!cfg || !cfg.enabled) return
  if (!coversList(cfg.rooms || [], room.key)) return
  const body = text.trim()
  if (saidRecently(state, room.key, body, now)) return
  const kind = joinLeaveKind(body)
  if (kind) {
    if (!group && who && who === parsed.name) return
    const prev = Number(state.joinSeen[`${room.key}${SEP}${body}`] || 0)
    if (prev && now - prev < JOIN_DEDUP_MS) return
    state.joinSeen[`${room.key}${SEP}${body}`] = now
    const on = kind === 1 ? cfg.welcomeOn : cfg.leaveOn
    const tpl = kind === 1 ? cfg.welcomeMsg : cfg.leaveMsg
    if (!on || !String(tpl || '').trim()) return
    const msg = renderBot(tpl, parsed.name, personOf(body), now, 0, '')
    botSend(state, cfg, room, msg, now, out)
    return
  }
  const prefix = cfg.cmdPrefix && String(cfg.cmdPrefix).trim() ? String(cfg.cmdPrefix).trim() : '!'
  if (body.startsWith(prefix) && body.length > prefix.length) {
    roomCommand(state, cfg, room, parsed, who, body.slice(prefix.length).trim(), prefix, now, out)
    return
  }
  const ban = banHit(cfg, body)
  if (ban) {
    const n = bumpWarn(state, room.key, who, now)
    let msg
    const tpl = String(cfg.warnMsg || '').trim()
    if (!tpl) msg = `${nameOf(who)}님, 금지어가 포함되어 있습니다 (경고 ${n}회, ${ban})`
    else {
      msg = renderBot(tpl, parsed.name, who, now, n, ban)
      if (!tpl.includes('{횟수}')) msg += ` (경고 ${n}회)`
    }
    botSend(state, cfg, room, msg + adminCall(cfg, n), now, out)
    return
  }
  if (cfg.blockLinks && LINK_RE.test(body)) {
    const n = bumpWarn(state, room.key, who, now)
    const tpl = String(cfg.linkMsg || '').trim()
    let msg = tpl
      ? renderBot(tpl, parsed.name, who, now, n, '')
      : `${nameOf(who)}님, 링크 및 초대링크 공유는 금지되어 있습니다 (경고 ${n}회)`
    if (tpl && !tpl.includes('{횟수}')) msg += ` (경고 ${n}회)`
    botSend(state, cfg, room, msg + adminCall(cfg, n), now, out)
    return
  }
  if (flood(state, cfg, room.key, who, now)) {
    const tpl = String(cfg.floodMsg || '').trim()
    const msg = tpl
      ? renderBot(tpl, parsed.name, who, now, 0, '')
      : `${nameOf(who)}님, 연속 발송을 자제하십시오 (${cfg.floodSecs}초 ${cfg.floodCount}개 초과)`
    botSend(state, cfg, room, msg, now, out)
  }
}

function flood(state, cfg, roomKey, who, now) {
  const limit = Number(cfg.floodCount) || 0
  const secs = Number(cfg.floodSecs) || 0
  if (limit < 2 || secs < 1) return false
  const k = `${roomKey}${SEP}${who || ''}`
  const hist = state.flood[k] || []
  const from = now - secs * 1000
  const kept = hist.filter((t) => t >= from)
  kept.push(now)
  state.flood[k] = kept.slice(-200)
  if (kept.length <= limit) return false
  const last = Number(state.floodWarn[k] || 0)
  if (last && now - last < FLOOD_WARN_MS) return false
  state.floodWarn[k] = now
  state.flood[k] = []
  return true
}

function roomCommand(state, cfg, room, parsed, who, line, prefix, now, out) {
  if (!line) return
  const sp = line.search(/\s/)
  const cmd = sp < 0 ? line : line.slice(0, sp)
  const arg = sp < 0 ? '' : line.slice(sp).trim()
  if (cmd === '공지') {
    if (!arg) {
      const n = String(cfg.notice || '').trim()
      botSend(state, cfg, room, n ? `[공지]\n${n}` : `등록된 공지가 없습니다. 관리자는 「${prefix}공지 내용」 으로 등록할 수 있습니다.`, now, out)
      return
    }
    if (!isAdmin(cfg, who)) {
      botSend(state, cfg, room, '공지는 관리자만 등록할 수 있습니다.', now, out)
      return
    }
    cfg.notice = arg
    botSend(state, cfg, room, `공지를 등록했습니다. 「${prefix}공지」 로 확인할 수 있습니다.`, now, out)
    return
  }
  if (cmd === '규칙') {
    botSend(state, cfg, room, `금지어·링크·도배를 경고합니다. 경고 ${ADMIN_CALL_AT}회 누적 시 관리자를 부릅니다. 강제퇴장은 방장이 카카오톡에서 합니다.`, now, out)
    return
  }
  if (cmd === '도움' || cmd === '명령' || cmd === '방도움') {
    botSend(state, cfg, room, `${prefix}공지 ${prefix}규칙 ${prefix}경고 ${prefix}경고초기화 ${prefix}도움`, now, out)
    return
  }
  if (cmd === '경고') {
    const target = arg && isAdmin(cfg, who) ? arg : who
    const n = warnCount(state, room.key, target)
    botSend(state, cfg, room, `${nameOf(target)}님, 누적 경고 ${n}회입니다.${n >= ADMIN_CALL_AT ? ' 관리자 확인이 필요합니다.' : ''}`, now, out)
    return
  }
  if (cmd === '경고초기화') {
    if (!isAdmin(cfg, who)) {
      botSend(state, cfg, room, '경고 초기화는 관리자만 실행할 수 있습니다.', now, out)
      return
    }
    let cleared = 0
    const prefixKey = `${room.key}${SEP}`
    for (const k of Object.keys(state.warns)) {
      if (k.startsWith(prefixKey)) {
        delete state.warns[k]
        delete state.warnAt[k]
        cleared++
      }
    }
    botSend(state, cfg, room, `이 대화방의 경고 기록 ${cleared}건을 삭제했습니다.`, now, out)
  }
}

function game(state, key) {
  if (!state.games[key]) {
    state.games[key] = { kind: '', word: '', secret: '', quiz: -1, tries: 0, used: [], at: 0 }
  }
  return state.games[key]
}

function scoreAdd(state, roomKey, who, n) {
  if (!state.scores[roomKey]) state.scores[roomKey] = {}
  const k = who || ''
  state.scores[roomKey][k] = (Number(state.scores[roomKey][k]) || 0) + n
  return state.scores[roomKey][k]
}

function gameOn(cfg, id) {
  if (!cfg) return false
  if (id === 'word') return cfg.word !== false
  if (id === 'baseball') return cfg.baseball !== false
  if (id === 'dice') return cfg.dice !== false
  if (id === 'rps') return cfg.rps !== false
  if (id === 'quiz') return cfg.quiz !== false
  return false
}

function gameSend(state, cfg, room, text, now, out) {
  const cool = Math.max(0, Number(cfg.cooldownMs) || 0)
  const last = Number(state.gameLast[room.key] || 0)
  if (cool && last && now - last < cool) return false
  const day = dayKey(now)
  if (state.gameDay !== day) {
    state.gameDay = day
    state.gameCount = 0
  }
  const limit = Number(cfg.dailyLimit) || 0
  if (limit > 0 && (state.gameCount || 0) >= limit) return false
  pushSend(out, room.chat_id, text, 0)
  state.gameLast[room.key] = now
  state.gameCount = (state.gameCount || 0) + 1
  const said = state.said[room.key] || []
  said.push({ text: String(text).trim(), at: now })
  state.said[room.key] = said.slice(-6)
  return true
}

function miniGame(record, out, room, parsed, who, text, now, state) {
  const cfg = record.config && record.config.minigame
  if (!cfg || !cfg.enabled) return
  if (!coversList(cfg.rooms || [], room.key)) return
  const body = text.trim()
  if (saidRecently(state, room.key, body, now)) return
  const prefix = cfg.cmdPrefix && String(cfg.cmdPrefix).trim() ? String(cfg.cmdPrefix).trim() : '!'
  if (body.startsWith(prefix) && body.length > prefix.length) {
    gameCommand(record, state, cfg, room, who, body.slice(prefix.length).trim(), prefix, now, out)
    return
  }
  play(state, cfg, room, who, body, prefix, now, out)
}

function roomBotOwnsHelp(record, room, prefix) {
  if (!featureOn(record, 'roombot')) return false
  const rb = record.config && record.config.roombot
  if (!rb || !rb.enabled) return false
  if (!coversList(rb.rooms || [], room.key)) return false
  const p = rb.cmdPrefix && String(rb.cmdPrefix).trim() ? String(rb.cmdPrefix).trim() : '!'
  return p === prefix
}

function gameCommand(record, state, cfg, room, who, line, prefix, now, out) {
  if (!line) return
  const sp = line.search(/\s/)
  const cmd = sp < 0 ? line : line.slice(0, sp)
  const arg = sp < 0 ? '' : line.slice(sp).trim()
  if (cmd === '끝말잇기') return startWord(state, cfg, room, who, prefix, now, out)
  if (cmd === '숫자야구' || cmd === '야구') return startBaseball(state, cfg, room, who, prefix, now, out)
  if (cmd === '주사위') return dice(state, cfg, room, who, arg, now, out)
  if (cmd === '가위바위보' || cmd === '묵찌빠') return rps(state, cfg, room, who, arg, prefix, now, out)
  if (cmd === '퀴즈') return startQuiz(state, cfg, room, who, prefix, now, out)
  if (cmd === '힌트') return hint(state, cfg, room, now, out)
  if (cmd === '정답') return reveal(state, cfg, room, now, out)
  if (cmd === '포기') return giveUp(state, cfg, room, now, out)
  if (cmd === '점수') {
    const n = (state.scores[room.key] && state.scores[room.key][who || '']) || 0
    gameSend(state, cfg, room, `${nameOf(who)}님 누적 점수 ${n}점입니다.`, now, out)
    return
  }
  if (cmd === '랭킹' || cmd === '순위') {
    const board = state.scores[room.key] || {}
    const rows = Object.entries(board).sort((a, b) => b[1] - a[1]).slice(0, 10)
    const text = rows.length
      ? rows.map((r, i) => `${i + 1}. ${nameOf(r[0])} ${r[1]}점`).join('\n')
      : '아직 점수가 없습니다.'
    gameSend(state, cfg, room, text, now, out)
    return
  }
  if (cmd === '게임도움' || cmd === '게임' || cmd === '도움' || cmd === '명령') {
    if ((cmd === '도움' || cmd === '명령') && roomBotOwnsHelp(record, room, prefix)) return
    gameSend(state, cfg, room, `${prefix}끝말잇기 ${prefix}숫자야구 ${prefix}주사위 ${prefix}가위바위보 ${prefix}퀴즈 ${prefix}힌트 ${prefix}정답 ${prefix}포기 ${prefix}랭킹`, now, out)
  }
}

function busy(state, cfg, room, prefix, now, out, kind) {
  const g = game(state, room.key)
  if (g.kind && g.kind !== kind) {
    gameSend(state, cfg, room, `다른 게임이 진행 중입니다. ${prefix}포기 입력 후 시작하십시오.`, now, out)
    return true
  }
  return false
}

function startWord(state, cfg, room, who, prefix, now, out) {
  if (!gameOn(cfg, 'word')) {
    gameSend(state, cfg, room, '「끝말잇기」는 사용 중지 상태입니다.', now, out)
    return
  }
  if (busy(state, cfg, room, prefix, now, out, 'word')) return
  const g = game(state, room.key)
  const used = new Set()
  const first = Word.startWord(used)
  if (!first) return
  g.kind = 'word'
  g.owner = who
  g.used = [first]
  g.word = first
  g.tries = 0
  g.at = now
  gameSend(state, cfg, room, `끝말잇기를 시작합니다. 첫 단어 → 「${first}」\n'${Word.variantsText(Word.tail(first))}' 로 시작하는 단어를 ${WORD_TURN_MS / 1000}초 내에 입력하십시오. (사전 ${Word.size()}단어 · 종료 ${prefix}포기)`, now, out)
}

function startBaseball(state, cfg, room, who, prefix, now, out) {
  if (!gameOn(cfg, 'baseball')) {
    gameSend(state, cfg, room, '「숫자야구」는 사용 중지 상태입니다.', now, out)
    return
  }
  if (busy(state, cfg, room, prefix, now, out, 'baseball')) return
  const g = game(state, room.key)
  const d = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]
  for (let i = 9; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    const t = d[i]
    d[i] = d[j]
    d[j] = t
  }
  let a = d[0]
  let b = d[1]
  const e = d[2]
  if (a === 0) {
    const t = a
    a = b
    b = t
  }
  g.kind = 'baseball'
  g.owner = who
  g.secret = `${a}${b}${e}`
  g.tries = 0
  g.at = now
  gameSend(state, cfg, room, `숫자야구를 시작합니다. 서로 다른 3자리 숫자를 입력하십시오 (첫 자리 0 제외).\n자리와 숫자 일치 S, 숫자만 일치 B. 기회 ${BASEBALL_TRIES}회 · 종료 ${prefix}포기`, now, out)
}

function dice(state, cfg, room, who, arg, now, out) {
  if (!gameOn(cfg, 'dice')) {
    gameSend(state, cfg, room, '「주사위」는 사용 중지 상태입니다.', now, out)
    return
  }
  let faces = 6
  if (arg) {
    const n = Number(arg)
    if (!Number.isInteger(n) || n < 1 || n > 100) {
      gameSend(state, cfg, room, '주사위 면 수는 1~100 범위로 입력하십시오. (예: 주사위 20)', now, out)
      return
    }
    faces = n
  }
  const v = 1 + Math.floor(Math.random() * faces)
  gameSend(state, cfg, room, `${nameOf(who)}님 ${faces}면 주사위 결과 → ${v}`, now, out)
}

function rps(state, cfg, room, who, arg, prefix, now, out) {
  if (!gameOn(cfg, 'rps')) {
    gameSend(state, cfg, room, '「가위바위보」는 사용 중지 상태입니다.', now, out)
    return
  }
  let mine = -1
  const v = String(arg || '').trim()
  if (v.startsWith('가위')) mine = 0
  else if (v.startsWith('바위') || v.startsWith('묵')) mine = 1
  else if (v.startsWith('보')) mine = 2
  if (mine < 0) {
    gameSend(state, cfg, room, `「${prefix}가위바위보 가위」 형식으로 입력하십시오. (가위 · 바위 · 보)`, now, out)
    return
  }
  const bot = Math.floor(Math.random() * 3)
  const name = ['가위', '바위', '보']
  const diff = (mine - bot + 3) % 3
  let line = `봇 ${name[bot]} · ${nameOf(who)}님 ${name[mine]} → `
  if (diff === 0) line += '무승부'
  else if (diff === 1) {
    const total = scoreAdd(state, room.key, who, P_RPS)
    line += `${nameOf(who)}님 승리 (+${P_RPS}점, 누적 ${total}점)`
  } else line += '봇 승리'
  gameSend(state, cfg, room, line, now, out)
}

function startQuiz(state, cfg, room, who, prefix, now, out) {
  if (!gameOn(cfg, 'quiz')) {
    gameSend(state, cfg, room, '「퀴즈」는 사용 중지 상태입니다.', now, out)
    return
  }
  if (busy(state, cfg, room, prefix, now, out, 'quiz')) return
  const asked = new Set((state.asked[room.key] || []).map(Number))
  if (asked.size >= Quiz.size()) asked.clear()
  const idx = Quiz.randomIndex(asked)
  asked.add(idx)
  state.asked[room.key] = [...asked]
  const g = game(state, room.key)
  g.kind = 'quiz'
  g.owner = who
  g.quiz = idx
  g.at = now
  gameSend(state, cfg, room, `[퀴즈] ${Quiz.question(idx)}\n정답을 채팅으로 입력하십시오. (힌트 ${prefix}힌트 · 정답 공개 ${prefix}정답)`, now, out)
}

function play(state, cfg, room, who, body, prefix, now, out) {
  const g = state.games[room.key]
  if (!g || !g.kind) return
  if (g.kind === 'word' && now - g.at > WORD_TURN_MS) {
    const msg = `시간 초과. 「${g.word}」 에서 끝말잇기를 종료했습니다. 재시작 ${prefix}끝말잇기`
    g.kind = ''
    gameSend(state, cfg, room, msg, now, out)
    return
  }
  if (g.kind === 'baseball' && now - g.at > BASEBALL_TTL_MS) {
    const msg = `장시간 입력이 없어 숫자야구를 종료했습니다. 정답 ${g.secret}`
    g.kind = ''
    gameSend(state, cfg, room, msg, now, out)
    return
  }
  if (g.kind === 'quiz' && now - g.at > QUIZ_TTL_MS) {
    const msg = `퀴즈 제한 시간이 지났습니다. 정답 「${Quiz.answer(g.quiz)}」`
    g.kind = ''
    gameSend(state, cfg, room, msg, now, out)
    return
  }
  if (g.kind === 'word' && gameOn(cfg, 'word')) wordTurn(state, cfg, room, who, body, prefix, now, out)
  else if (g.kind === 'baseball' && gameOn(cfg, 'baseball')) baseballTurn(state, cfg, room, who, body, now, out)
  else if (g.kind === 'quiz' && gameOn(cfg, 'quiz')) quizTurn(state, cfg, room, who, body, prefix, now, out)
}

function wordTurn(state, cfg, room, who, body, prefix, now, out) {
  if (!Word.hangul(body) || body.length < 2 || body.length > 4) return
  const g = game(state, room.key)
  if (g.kind !== 'word') return
  const used = new Set(g.used || [])
  if (used.has(body)) {
    gameSend(state, cfg, room, `「${body}」는 이미 사용된 단어입니다. 다른 단어를 입력하십시오.`, now, out)
    return
  }
  if (!Word.has(body)) {
    gameSend(state, cfg, room, `「${body}」는 사전에 없는 단어입니다. 다른 단어를 입력하십시오.`, now, out)
    return
  }
  if (!Word.linkable(g.word, body)) {
    gameSend(state, cfg, room, `「${g.word}」 다음 단어는 '${Word.variantsText(Word.tail(g.word))}' 로 시작해야 합니다.`, now, out)
    return
  }
  used.add(body)
  g.word = body
  g.at = now
  const botWord = Word.nextStarting(Word.tail(body), used)
  if (!botWord) {
    g.kind = ''
    g.used = [...used]
    const total = scoreAdd(state, room.key, who, P_WORD + P_WORD_WIN)
    gameSend(state, cfg, room, `이을 단어가 없습니다. ${nameOf(who)}님 승리 (+${P_WORD + P_WORD_WIN}점, 누적 ${total}점)\n재시작 ${prefix}끝말잇기`, now, out)
    return
  }
  used.add(botWord)
  g.word = botWord
  g.used = [...used].slice(-120)
  const total = scoreAdd(state, room.key, who, P_WORD)
  gameSend(state, cfg, room, `통과. 「${botWord}」\n다음 시작 글자 '${Word.variantsText(Word.tail(botWord))}' (${nameOf(who)}님 ${total}점)`, now, out)
}

function baseballTurn(state, cfg, room, who, body, now, out) {
  if (!/^\d{3}$/.test(body)) return
  const g = game(state, room.key)
  if (g.kind !== 'baseball') return
  if (body[0] === body[1] || body[1] === body[2] || body[0] === body[2]) {
    gameSend(state, cfg, room, '숫자 3개는 서로 달라야 합니다.', now, out)
    return
  }
  g.at = now
  g.tries += 1
  let s = 0
  let b = 0
  for (let i = 0; i < 3; i++) {
    const at = g.secret.indexOf(body[i])
    if (at < 0) continue
    if (at === i) s++
    else b++
  }
  if (s === 3) {
    const total = scoreAdd(state, room.key, who, P_BASEBALL)
    g.kind = ''
    gameSend(state, cfg, room, `정답입니다. ${body} · ${g.tries}회 시도. ${nameOf(who)}님 +${P_BASEBALL}점 (누적 ${total}점)`, now, out)
    return
  }
  if (g.tries >= BASEBALL_TRIES) {
    const secret = g.secret
    g.kind = ''
    gameSend(state, cfg, room, `${body} → ${s}S ${b}B\n기회를 모두 사용했습니다. 정답 ${secret}`, now, out)
    return
  }
  gameSend(state, cfg, room, `${body} → ${s}S ${b}B (${g.tries}/${BASEBALL_TRIES})`, now, out)
}

function quizTurn(state, cfg, room, who, body, prefix, now, out) {
  const g = game(state, room.key)
  if (g.kind !== 'quiz') return
  if (!Quiz.correct(g.quiz, body)) return
  const ans = Quiz.answer(g.quiz)
  g.kind = ''
  g.quiz = -1
  const total = scoreAdd(state, room.key, who, P_QUIZ)
  gameSend(state, cfg, room, `정답입니다. 「${ans}」 · ${nameOf(who)}님 +${P_QUIZ}점 (누적 ${total}점)\n다음 문제 ${prefix}퀴즈`, now, out)
}

function hint(state, cfg, room, now, out) {
  const g = game(state, room.key)
  let msg = '진행 중인 게임이 없습니다.'
  if (g.kind === 'quiz' && Quiz.valid(g.quiz)) msg = `힌트 · ${Quiz.hint(g.quiz)}`
  else if (g.kind === 'word') {
    const cand = Word.nextStarting(Word.tail(g.word), new Set(g.used || []))
    msg = cand ? `힌트 · ${cand[0]}…로 시작하는 ${cand.length}글자 단어` : '봇이 이을 수 있는 단어가 없습니다. 먼저 입력하면 승리합니다.'
  } else if (g.kind === 'baseball') msg = `힌트 · 숫자는 서로 다르며 첫 자리는 0이 아닙니다. 현재 ${g.tries}회 시도.`
  gameSend(state, cfg, room, msg, now, out)
}

function reveal(state, cfg, room, now, out) {
  const g = game(state, room.key)
  let msg = '진행 중인 게임이 없습니다.'
  if (g.kind === 'quiz' && Quiz.valid(g.quiz)) {
    msg = `정답 「${Quiz.answer(g.quiz)}」`
    g.kind = ''
  } else if (g.kind === 'baseball') {
    msg = `정답 ${g.secret}`
    g.kind = ''
  } else if (g.kind === 'word') msg = `현재 이어야 하는 단어는 「${g.word}」 입니다.`
  gameSend(state, cfg, room, msg, now, out)
}

function giveUp(state, cfg, room, now, out) {
  const g = game(state, room.key)
  let msg = '진행 중인 게임이 없습니다.'
  if (g.kind) {
    msg = `게임을 종료했습니다.`
    if (g.kind === 'baseball') msg += ` 정답 ${g.secret}.`
    if (g.kind === 'quiz' && Quiz.valid(g.quiz)) msg += ` 정답 「${Quiz.answer(g.quiz)}」.`
    if (g.kind === 'word') msg += ` 마지막 단어 「${g.word}」.`
    g.kind = ''
  }
  gameSend(state, cfg, room, msg, now, out)
}

export async function othersSinceMine(client, chatId, userId) {
  const msgs = await client.getMessages(chatId, { count: 30 })
  const self = String(userId)
  const ordered = [...msgs].sort((a, b) => {
    const x = BigInt(a.log_id)
    const y = BigInt(b.log_id)
    return x < y ? -1 : x > y ? 1 : 0
  })
  let others = 0
  for (let i = ordered.length - 1; i >= 0; i--) {
    if (String(ordered[i].author_id) === self) break
    others++
  }
  return others
}

/** Text macros go out as a KakaoTalk notification reply on the phone. The server must not also send. */
export function macroNotifyReply(record) {
  const macro = record && record.config && record.config.macro
  return !!(macro && macro.notifyReply === true)
}

export function macroRoomsDue(record, now) {
  const macro = record.config && record.config.macro
  if (!macro || !macro.enabled) return []
  if (!featureOn(record, 'macro')) return []
  const msg = String(macro.message || '')
  if (!msg.trim()) return []
  const state = rt(record)
  const due = []
  for (const key of macro.rooms || []) {
    const parsed = parseRoomKey(key)
    if (!parsed.name || !accountOn(record.config, parsed.acc)) continue
    const chatId = chatForRoom(record.rooms, parsed.key)
    if (!realId(chatId)) continue
    const at = Number(state.roomDueAt[parsed.key] || 0)
    if (at > now) continue
    due.push({ key: parsed.key, chatId, label: parsed.name })
  }
  return due
}

export function noteMacroSent(record, roomKey, now) {
  const state = rt(record)
  const macro = record.config.macro
  state.roomLastSent[roomKey] = now
  state.roomDueAt[roomKey] = now + cooldownMs(macro, roomKey)
  state.macroSeq = (Number(state.macroSeq) || 0) + 1
  return imagesThisTime(macro, state.macroSeq)
}

export function noteMacroWait(record, roomKey, now) {
  const state = rt(record)
  const base = Math.max(1, Number(record.config.macro.baseMin) || 1)
  state.roomDueAt[roomKey] = now + base * 60000
}

export function noteMacroRetry(record, roomKey, now) {
  const state = rt(record)
  const retry = now + 60000
  const cur = Number(state.roomDueAt[roomKey] || 0)
  if (cur < retry) state.roomDueAt[roomKey] = retry
}

export function macroMinMessages(record) {
  const n = Number(record.config && record.config.macro && record.config.macro.minMessages)
  return n < 0 || Number.isNaN(n) ? 0 : n
}

// 욕설이나 링크가 보이면 그 글만 가린다. 강퇴하지 않는다.
// 부방장과 방장이 올린 링크는 가리지 않는다. 권한을 모르면 링크는 그대로 둔다.
// 가리기 패킷은 node-kakao TalkOpenChannelSession.hideChat 과 같다.
// REWRITE { li, c, logId, t } 이고 t 는 그 글의 메시지 타입이다.
const SWEAR_TYPES = new Set([1, 2, 26])
const SWEAR_STEMS = [
  '씨발', '시발', '씨팔', '시팔', '씨벌', '시벌',
  '병신', '벙신', '병쉰',
  '좆', '좇', '존나', '존내', '지랄',
  '개새끼', '개새기', '개색기', '개색끼', '개쉐', '개자식',
  '니미', '느금',
  '창녀', '창년',
  '미친놈', '미친년', '미친새끼',
  '엿먹', '닥쳐',
  'fuck', 'shit', 'bitch',
  'ㅅㅂ', 'ㅆㅂ', 'ㅂㅅ', 'ㅈㄹ', 'ㅈㄴ',
]

function foldSwear(text) {
  let s = String(text || '').toLowerCase()
  s = s.replace(/[^\p{L}\p{N}]/gu, '')
  s = s.replace(/([가-힣])[0-9]+(?=[가-힣])/g, '$1')
  s = s.replace(/([가-힣ㄱ-ㅎㅏ-ㅣ])\1+/g, '$1')
  s = s.replace(/([가-힣])이(?=[가-힣])/g, '$1')
  s = s.replace(/시발점/g, '')
  return s
}

export function isProfanity(text) {
  const s = foldSwear(text)
  if (!s) return false
  for (const stem of SWEAR_STEMS) {
    if (s.includes(stem)) return true
  }
  return false
}

export function hasCoverLink(text) {
  return LINK_RE.test(String(text || ''))
}

/** True when this open-chat permission is the host, a deputy, or unknown. */
export function coverSkipsLink(openPermission) {
  if (openPermission == null || openPermission === '') return true
  const p = Number(openPermission)
  if (!Number.isFinite(p)) return true
  return (p & 1) !== 0 || (p & 4) !== 0
}

function coverRoom(record, ev) {
  const cfg = record && record.config && record.config.cover
  if (!cfg || cfg.enabled !== true || !ev || ev.mine) return null
  const type = Number(ev.messageType)
  if (!SWEAR_TYPES.has(type)) return null
  const logId = String(ev.logId || '')
  if (!/^[1-9][0-9]*$/.test(logId)) return null
  const chatId = String(ev.chatId || '')
  const room = roomByChat(record.rooms, chatId)
  if (!room || !realId(String(room.chat_id))) return null
  if (!coversList(cfg.rooms, room.key)) return null
  return { chatId: String(room.chat_id), logId, type }
}

// 고객이 넣은 금지어. 띄어쓰기·기호·대소문자 우회는 늘 잡는다(가벼운 접기).
// 욕설용 접기(foldSwear)는 반복 글자를 줄이고 글자 사이 '이'를 빼므로, 단어가 그 접기로 모양이
// 바뀌지 않을 때만 쓴다. 그래야 '토토'가 '토'로 줄어 '토요일'을 가리거나, '이벤트'가 '무료이벤트'에서
// 빠지는 일이 없다.
function lightFold(text) {
  return String(text || '').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '')
}

function coverWords(cfg) {
  const list = cfg && Array.isArray(cfg.words) ? cfg.words : []
  const out = []
  for (const w of list) {
    if (typeof w !== 'string' && typeof w !== 'number') continue
    const light = lightFold(w)
    if (!light) continue
    const folded = foldSwear(w)
    out.push({ light, folded: folded === light ? folded : '' })
  }
  return out
}

function coverCfg(record) {
  return (record && record.config && record.config.cover) || null
}

/** True when the message has one of the customer's own banned words. */
export function hasCoverWord(cfg, text) {
  const words = coverWords(cfg)
  if (!words.length) return false
  const light = lightFold(text)
  if (!light) return false
  const folded = foldSwear(text)
  return words.some((w) => light.includes(w.light) || (!!w.folded && folded.includes(w.folded)))
}

function coverLinksOn(cfg) {
  return !!cfg && cfg.links !== false
}

/** True when a link cover still needs the author's open-chat permission. */
export function coverNeedsAuthor(record, ev) {
  if (!coverRoom(record, ev)) return false
  const cfg = coverCfg(record)
  if (!coverLinksOn(cfg)) return false
  if (isProfanity(ev.text) || hasCoverWord(cfg, ev.text)) return false
  return hasCoverLink(ev.text)
}

/** A staff cover for one profane, banned-word or linked open-chat message. Null when this message stays. */
export function coverPlan(record, ev) {
  const plan = coverRoom(record, ev)
  if (!plan) return null
  const cfg = coverCfg(record)
  if (isProfanity(ev.text)) return plan
  if (hasCoverWord(cfg, ev.text)) return plan
  if (coverLinksOn(cfg) && hasCoverLink(ev.text) && ev.staff === false) return plan
  return null
}

// ── 방 관리봇 ──────────────────────────────────────────────────────────────
// Acts only in rooms the customer turned on. Does not kick, spam, mention-bomb,
// or rewrite text. Empty customer text means that action sends nothing.

const GUARD_HALT_MS = 10 * 60 * 1000
const KICK_PHRASE = /내보냈|강퇴했|강퇴하였/

function num(v, lo, hi, def) {
  const n = Number(v)
  if (!Number.isFinite(n)) return def
  return Math.max(lo, Math.min(hi, Math.trunc(n)))
}

function guardCfg(record) {
  const c = record && record.config && record.config.guard
  return c && typeof c === 'object' ? c : null
}

function gstate(record) {
  const state = rt(record)
  if (!state.guard || typeof state.guard !== 'object') state.guard = {}
  const g = state.guard
  g.presenceAt = g.presenceAt || {}
  g.noticeAt = g.noticeAt || {}
  g.slow = g.slow || {}
  g.quiet = g.quiet || {}
  g.halt = g.halt || {}
  g.kickAsked = g.kickAsked || {}
  g.kicks = g.kicks || {}
  g.flood = g.flood || {}
  g.churn = g.churn || {}
  g.joined = g.joined || {}
  if (!Array.isArray(g.notices)) g.notices = []
  return g
}

function pushNotice(g, now, text) {
  const line = String(text || '').trim()
  if (!line) return
  const last = g.notices[g.notices.length - 1]
  if (last && last.text === line && now - Number(last.at || 0) < 10 * 60 * 1000) return
  g.notices.push({ at: now, text: line })
  if (g.notices.length > 20) g.notices.splice(0, g.notices.length - 20)
}

function stamp(map, key, now, windowMs) {
  const list = Array.isArray(map[key]) ? map[key].filter((t) => now - Number(t) <= windowMs) : []
  list.push(now)
  if (list.length > 40) list.splice(0, list.length - 40)
  map[key] = list
  return list
}

function enabledRooms(record, cfg) {
  const out = []
  const keys = Array.isArray(cfg.rooms) ? cfg.rooms : []
  for (const key of keys) {
    const chatId = chatForRoom(record.rooms, key)
    if (!realId(chatId)) continue
    const room = roomByChat(record.rooms, chatId)
    if (!room || !coversList(cfg.rooms, room.key)) continue
    out.push(room)
  }
  return out
}

function roomOf(record, chatId) {
  const cfg = guardCfg(record)
  if (!cfg) return null
  const room = roomByChat(record.rooms, chatId)
  if (!room || !realId(String(room.chat_id))) return null
  if (!coversList(cfg.rooms, room.key)) return null
  return room
}

function roomLabel(room) {
  const name = room && (room.name || room.title)
  const s = name == null ? '' : String(name).trim()
  return s || '대화방'
}

function isKickFeed(text, messageType) {
  const body = String(text || '').trim()
  if (!body || body.length > 80) return false
  if (!KICK_PHRASE.test(body)) return false
  return messageType == null || Number(messageType) === 0
}

export function guardNotices(record) {
  const g = record && record.runtime && record.runtime.guard
  const list = g && Array.isArray(g.notices) ? g.notices : []
  return list
    .map((n) => ({ at: Number(n && n.at) || 0, text: n && n.text ? String(n.text) : '' }))
    .filter((n) => n.at > 0 && n.text)
    .slice(-20)
}

/** Periodic presence and notices. Updates the next-due marks. */
export function guardDue(record, now) {
  const presence = []
  const sends = []
  const cfg = guardCfg(record)
  if (!cfg) return { presence, sends }
  const g = gstate(record)
  const rooms = enabledRooms(record, cfg)
  if (cfg.presenceOn === true) {
    const every = num(cfg.presenceMin, 10, 240, 30) * 60000
    for (const room of rooms) {
      const last = Number(g.presenceAt[room.key] || 0)
      if (last && now - last < every) continue
      g.presenceAt[room.key] = now
      presence.push(String(room.chat_id))
    }
  }
  const notice = String(cfg.noticeText || '').trim()
  if (cfg.noticeOn === true && notice) {
    const every = num(cfg.noticeMin, 5, 1440, 60) * 60000
    for (const room of rooms) {
      const last = Number(g.noticeAt[room.key] || 0)
      if (last && now - last < every) continue
      g.noticeAt[room.key] = now
      sends.push({ chatId: String(room.chat_id), text: notice })
    }
  }
  return { presence, sends }
}

const VISIT_GAP_MS = 4000
const VISIT_KEEP_MS = 14 * 24 * 60 * 60 * 1000
const VISIT_KEEP_N = 30

function kstStamp(ms) {
  const t = new Date(Number(ms) + 9 * 60 * 60 * 1000)
  if (!Number.isFinite(t.getTime())) return ''
  const p = (n) => String(n).padStart(2, '0')
  return `${t.getUTCFullYear()}-${p(t.getUTCMonth() + 1)}-${p(t.getUTCDate())} ${p(t.getUTCHours())}:${p(t.getUTCMinutes())}`
}

function openProfileLink(raw) {
  const s = String(raw || '').trim()
  if (!/^https:\/\/open\.kakao\.com\/\S+$/i.test(s)) return ''
  return s
}

function visitRoom(record, chatId) {
  const cfg = record && record.config && record.config.visit
  if (!cfg || cfg.enabled !== true) return null
  const room = roomByChat(record.rooms, chatId)
  if (!room || !realId(String(room.chat_id))) return null
  if (!coversList(cfg.rooms, room.key)) return null
  return room
}

/** True when this join or leave should look up the person's open profile. */
export function visitNeedsProfile(record, chatId) {
  return !!visitRoom(record, chatId)
}

function visitState(record) {
  const state = rt(record)
  if (!state.visit || typeof state.visit !== 'object') state.visit = {}
  const v = state.visit
  if (!v.people || typeof v.people !== 'object' || Array.isArray(v.people)) v.people = {}
  if (!v.nextAt || typeof v.nextAt !== 'object' || Array.isArray(v.nextAt)) v.nextAt = {}
  if (!v.seen || typeof v.seen !== 'object' || Array.isArray(v.seen)) v.seen = {}
  return v
}

function visitIdentity(authorId, authorName) {
  const id = /^[1-9][0-9]*$/.test(String(authorId || '').trim()) ? String(authorId).trim() : ''
  const name = String(authorName || '').trim().slice(0, 40)
  if (!id && !name) return null
  return { id, name, key: id || ('n:' + name) }
}

function visitSeen(v, chatId, who, kind, now) {
  const keys = []
  if (who.id) keys.push(`${chatId}${SEP}${who.id}${SEP}${kind}`)
  if (who.name) keys.push(`${chatId}${SEP}n:${who.name}${SEP}${kind}`)
  if (!keys.length) keys.push(`${chatId}${SEP}${who.key}${SEP}${kind}`)
  for (const key of keys) {
    const prev = Number(v.seen[key] || 0)
    if (prev && now - prev < 60000) return true
  }
  for (const key of keys) v.seen[key] = now
  const all = Object.keys(v.seen)
  if (all.length > 400) {
    for (const k of all) {
      if (now - Number(v.seen[k] || 0) > 60000) delete v.seen[k]
    }
  }
  return false
}

function trimTimes(list, now) {
  const out = []
  const src = Array.isArray(list) ? list : []
  for (const t of src) {
    const n = Number(t)
    if (!Number.isFinite(n)) continue
    if (now - n > VISIT_KEEP_MS) continue
    out.push(n)
  }
  if (out.length > VISIT_KEEP_N) return out.slice(out.length - VISIT_KEEP_N)
  return out
}

function lastTouch(row) {
  const joins = row && Array.isArray(row.joins) ? row.joins : []
  const leaves = row && Array.isArray(row.leaves) ? row.leaves : []
  const j = joins.length ? Number(joins[joins.length - 1]) : 0
  const l = leaves.length ? Number(leaves[leaves.length - 1]) : 0
  return Math.max(j, l)
}

function pruneVisit(v) {
  const keys = Object.keys(v.people)
  if (keys.length <= 200) return
  keys.sort((a, b) => lastTouch(v.people[a]) - lastTouch(v.people[b]))
  const drop = keys.length - 200
  for (let i = 0; i < drop; i++) delete v.people[keys[i]]
}

function uniqTimes(list, now) {
  const seen = new Set()
  const out = []
  for (const t of trimTimes(list, now)) {
    if (seen.has(t)) continue
    seen.add(t)
    out.push(t)
  }
  return out
}

function rememberPerson(v, chatId, who, now, kind, link) {
  const keys = []
  if (who.id) keys.push(`${chatId}${SEP}${who.id}`)
  if (who.name) keys.push(`${chatId}${SEP}n:${who.name}`)
  if (!keys.length) keys.push(`${chatId}${SEP}${who.key}`)
  const prev = { joins: [], leaves: [], userId: '', changes: [] }
  for (const key of keys) {
    const row = v.people[key]
    if (!row || typeof row !== 'object') continue
    if (!prev.name && row.name) prev.name = row.name
    if (!prev.link && row.link) prev.link = row.link
    if (!prev.userId && row.userId) prev.userId = String(row.userId)
    if (Array.isArray(row.joins)) prev.joins = prev.joins.concat(row.joins)
    if (Array.isArray(row.leaves)) prev.leaves = prev.leaves.concat(row.leaves)
    if (Array.isArray(row.changes)) prev.changes = prev.changes.concat(row.changes)
  }
  // 같은 사람(userId 기준)이 이름이나 오픈프로필 링크를 바꾸면 그 사실을 남긴다.
  // 지금 못 읽은 링크(빈 값)는 바뀐 것으로 치지 않는다. 이름만 아는 사람은 추적할 수 없다.
  const prevName = prev.name ? String(prev.name) : ''
  const prevLink = openProfileLink(prev.link)
  const freshName = who.name ? String(who.name) : ''
  const freshLink = openProfileLink(link)
  const changes = trimChanges(prev.changes, now)
  const nameChanged = !!(prevName && freshName && prevName !== freshName)
  const linkChanged = !!(prevLink && freshLink && prevLink !== freshLink)
  if (nameChanged || linkChanged) {
    changes.push({ at: now, name: prevName, link: prevLink })
  }
  const row = {
    name: freshName || prevName,
    link: freshLink || prevLink,
    userId: who.id || (/^[1-9][0-9]*$/.test(prev.userId) ? prev.userId : ''),
    joins: uniqTimes(prev.joins, now),
    leaves: uniqTimes(prev.leaves, now),
    changes: trimChanges(changes, now),
  }
  if (kind === 'join') row.joins.push(now)
  else row.leaves.push(now)
  row.joins = uniqTimes(row.joins, now)
  row.leaves = uniqTimes(row.leaves, now)
  for (const key of keys) v.people[key] = row
  pruneVisit(v)
  return row
}

// 프로필 변경 이력: 14일 안, 최대 VISIT_KEEP_N개, 같은 (이름/링크)는 한 번만.
function trimChanges(list, now) {
  const seen = new Set()
  const out = []
  const src = Array.isArray(list) ? list : []
  for (const c of src) {
    if (!c || typeof c !== 'object') continue
    const at = Number(c.at)
    if (!Number.isFinite(at) || now - at > VISIT_KEEP_MS) continue
    const name = String(c.name || '')
    const link = String(c.link || '')
    const sig = name + SEP + link
    if (seen.has(sig)) continue
    seen.add(sig)
    out.push({ at, name, link })
  }
  if (out.length > VISIT_KEEP_N) return out.slice(out.length - VISIT_KEEP_N)
  return out
}

function visitDelay(v, chatId, now) {
  const next = Number(v.nextAt[chatId] || 0)
  const at = Math.max(now, next)
  v.nextAt[chatId] = at + VISIT_GAP_MS
  return at - now
}

function timeLines(times) {
  return times.map((t) => '- ' + kstStamp(t))
}

function visitNotice(row, kind) {
  const name = String(row && row.name || '').replace(/[\r\n]/g, '').trim()
  const userId = /^[1-9][0-9]*$/.test(String(row && row.userId || '')) ? String(row.userId) : ''
  const link = row && row.link ? row.link : '찾지 못했습니다'
  const mentioned = !!(userId && name)
  const nameLine = mentioned ? ('이름 : @' + name) : ('이름 : ' + (name || '이름 없음'))
  const leave = kind === 'leave'
  const times = timeLines(leave ? (row && row.leaves) : (row && row.joins))
  const lines = [
    leave ? '[퇴장안내]' : '[입장안내]',
    nameLine,
    '옾링 : ' + link,
    leave ? '퇴장로그' : '입장로그',
    ...times,
  ]
  const changes = Array.isArray(row && row.changes) ? row.changes : []
  if (changes.length) {
    lines.push('프로필 변경')
    for (const c of changes) {
      const past = String(c && c.name || '').replace(/[@\r\n]/g, '').trim() || '이름 없음'
      const pastLink = c && c.link ? String(c.link) : '링크 없음'
      lines.push('- ' + kstStamp(c && c.at) + '  ' + past + ' / ' + pastLink)
    }
  }
  const text = lines.join('\n')
  if (!mentioned) return { text, mention: null }
  const at = text.indexOf('\n이름 : @')
  const start = at + '\n이름 : @'.length
  return { text, mention: { userId, at: start, len: name.length } }
}

function mentionIdJson(id) {
  let n
  try {
    n = BigInt(id)
  } catch {
    return ''
  }
  if (n <= 0n) return ''
  if (n <= BigInt(Number.MAX_SAFE_INTEGER)) return id
  return JSON.stringify(id)
}

/**
 * The open-chat member id Kakao mentions, not the enter line's author.
 * A unique member-list match wins. A member card is used only when its
 * nickname is that person. A card for someone else is dropped. When the
 * member list has not caught up, the feed id is kept.
 */
export function visitMemberId(feedId, name, lookedUpId, card) {
  const feed = /^[1-9][0-9]*$/.test(String(feedId || '')) ? String(feedId) : ''
  const found = /^[1-9][0-9]*$/.test(String(lookedUpId || '')) ? String(lookedUpId) : ''
  const cardId = card && /^[1-9][0-9]*$/.test(String(card.userId || '')) ? String(card.userId) : ''
  const cardName = String(card && card.name || '').trim()
  const want = String(name || '').trim()
  if (found) return { userId: cardId || found, name: cardName || want }
  if (cardId && cardName && want && cardName !== want) return { userId: '', name: want }
  if (cardId) return { userId: cardId, name: cardName || want }
  return { userId: feed, name: want }
}

/**
 * One WRITE mention of one open-chat member.
 * Kakao's at is the 1-based order of that mention in the message, not a
 * character or UTF-8 index. len is the nickname length in characters.
 * user_id is a JSON number when it fits in a safe integer, and a decimal
 * string when it is a larger int64. Open chat uses this same extra.
 * A byte offset is ignored and the name stays plain text.
 */
export function visitMentionExtra(text, mention) {
  if (!text || !mention) return ''
  const idJson = mentionIdJson(String(mention.userId || ''))
  const len = Number(mention.len)
  if (!idJson) return ''
  if (!Number.isInteger(len) || len < 1) return ''
  const mark = text.indexOf('@')
  if (mark < 0 || text.indexOf('@', mark + 1) >= 0) return ''
  if (text.slice(mark + 1, mark + 1 + len).length !== len) return ''
  if (text.charAt(mark + 1 + len) && text.charAt(mark + 1 + len) !== '\n') return ''
  return `{"mentions":[{"user_id":${idJson},"at":[1],"len":${len}}]}`
}

// 이미 기록이 있는 사람(userId 기준)이 닉을 바꾸면 그 즉시 [프로필 변경] 안내를 올린다.
// 조회 없이 메시지의 작성자 닉만으로 판단한다. 처음 보는 사람은 기준이 없어 넘어간다.
// ── 프로필 변경 감지 (들낙 방지와 별개 기능) ─────────────────────────────
// 조회 없이, 메시지·입장·퇴장에 따라오는 작성자 닉만으로 판단한다.
// 이미 본 사람(userId 기준)이 닉을 바꾸면 그 즉시 알린다. 처음 본 사람은 기준만 잡는다.
function profileRoom(record, chatId) {
  const cfg = record && record.config && record.config.profile
  if (!cfg || cfg.enabled !== true) return null
  const room = roomByChat(record.rooms, chatId)
  if (!room || !realId(String(room.chat_id))) return null
  if (!coversList(cfg.rooms, room.key)) return null
  return room
}

/** True when a watched room wants the author id looked up for profile tracking. */
export function profileNeedsAuthor(record, chatId) {
  return !!profileRoom(record, chatId)
}

function profileState(record) {
  const state = rt(record)
  if (!state.profile || typeof state.profile !== 'object') state.profile = {}
  const p = state.profile
  if (!p.people || typeof p.people !== 'object' || Array.isArray(p.people)) p.people = {}
  if (!p.nextAt || typeof p.nextAt !== 'object' || Array.isArray(p.nextAt)) p.nextAt = {}
  return p
}

function pruneProfile(p) {
  const keys = Object.keys(p.people)
  if (keys.length <= 300) return
  keys.sort((a, b) => (Number(p.people[a] && p.people[a].at) || 0) - (Number(p.people[b] && p.people[b].at) || 0))
  const drop = keys.length - 300
  for (let i = 0; i < drop; i++) delete p.people[keys[i]]
}

function profileDelay(p, chatId, now) {
  const next = Number(p.nextAt[chatId] || 0)
  const at = Math.max(now, next)
  p.nextAt[chatId] = at + VISIT_GAP_MS
  return at - now
}

function applyProfile(record, ev, sends) {
  if (!ev) return false
  const room = profileRoom(record, ev.chatId)
  if (!room) return false
  if (ev.mine) return false
  const id = /^[1-9][0-9]*$/.test(String(ev.authorId || '').trim()) ? String(ev.authorId).trim() : ''
  const name = String(ev.authorName || '').trim().slice(0, 40)
  if (!id || !name) return false
  const now = Number(ev.now) || Date.now()
  const p = profileState(record)
  const chatId = String(room.chat_id)
  const key = `${chatId}${SEP}${id}`
  const prev = p.people[key]
  if (!prev || typeof prev !== 'object' || !prev.name) {
    p.people[key] = { name, userId: id, at: now, changes: Array.isArray(prev && prev.changes) ? prev.changes : [] }
    pruneProfile(p)
    return false
  }
  if (String(prev.name).trim() === name) {
    prev.at = now
    return false
  }
  const prevName = String(prev.name).trim()
  const changes = trimChanges((Array.isArray(prev.changes) ? prev.changes : []).concat([
    { at: now, name: prevName, link: '' },
  ]), now)
  p.people[key] = { name, userId: id, at: now, changes }
  pruneProfile(p)
  const notice = profileNotice(name, id, prevName, changes, now)
  sends.push({ chatId, text: notice.text, mention: notice.mention, delayMs: profileDelay(p, chatId, now) })
  return true
}

function profileNotice(name, userId, prevName, changes, now) {
  const nm = String(name || '').replace(/[\r\n]/g, '').trim()
  const uid = /^[1-9][0-9]*$/.test(String(userId || '')) ? String(userId) : ''
  const old = String(prevName || '').replace(/[@\r\n]/g, '').trim() || '이름 없음'
  const mentioned = !!(uid && nm)
  const nameLine = mentioned ? ('이름 : @' + nm) : ('이름 : ' + (nm || '이름 없음'))
  const lines = ['[프로필 변경 감지]', nameLine, '이전 : ' + old, '변경 : ' + kstStamp(now)]
  const n = Array.isArray(changes) ? changes.length : 0
  if (n >= 2) lines.push('누적 : ' + n + '회')
  const text = lines.join('\n')
  if (!mentioned) return { text, mention: null }
  const at = text.indexOf('\n이름 : @')
  const start = at + '\n이름 : @'.length
  return { text, mention: { userId: uid, at: start, len: nm.length } }
}

/**
 * Record a join or leave for a watched room and queue that one notice.
 * An enter lists join times. A leave lists leave times. The other log stays out.
 */
function applyVisit(record, ev, sends) {
  if (!ev || (ev.kind !== 'join' && ev.kind !== 'leave')) return false
  const room = visitRoom(record, ev.chatId)
  if (!room) return false
  if (ev.mine) return false
  const who = visitIdentity(ev.authorId, ev.authorName)
  if (!who) return false
  const now = Number(ev.now) || Date.now()
  const v = visitState(record)
  if (visitSeen(v, String(room.chat_id), who, ev.kind, now)) return true
  const row = rememberPerson(v, String(room.chat_id), who, now, ev.kind, ev.profileLink)
  const notice = visitNotice(row, ev.kind)
  sends.push({
    chatId: String(room.chat_id),
    text: notice.text,
    mention: notice.mention,
    delayMs: visitDelay(v, String(room.chat_id), now),
  })
  return true
}

/**
 * One inbound chat, join, or leave.
 * kind: 'msg' | 'join' | 'leave'
 * askHalt is set when a kick wave should be stopped if this account is allowed.
 */
export function guardOnChat(record, ev) {
  const sends = []
  let askHalt = null
  if (!ev) return { sends, askHalt, active: false }
  const visitActive = applyVisit(record, ev, sends)
  const profileActive = applyProfile(record, ev, sends)
  const cfg = guardCfg(record)
  if (!cfg) return { sends, askHalt, active: visitActive || profileActive }
  const room = roomOf(record, ev.chatId)
  if (!room) return { sends, askHalt, active: visitActive || profileActive }
  const now = Number(ev.now) || Date.now()
  const g = gstate(record)
  const chatId = String(room.chat_id)
  const mine = !!ev.mine
  const author = ev.authorId == null ? '' : String(ev.authorId)

  if (ev.kind === 'msg' && !mine && cfg.kickOn === true && isKickFeed(ev.text, ev.messageType)) {
    const windowMs = num(cfg.kickSecs, 5, 300, 30) * 1000
    const need = num(cfg.kickCount, 3, 30, 5)
    const times = stamp(g.kicks, chatId, now, windowMs)
    const halted = Number(g.halt[chatId] || 0)
    const asked = Number(g.kickAsked[chatId] || 0)
    if (times.length >= need && now >= halted && now - asked >= 15000) {
      g.kickAsked[chatId] = now
      askHalt = { chatId, roomName: roomLabel(room), count: times.length }
    }
  }

  if (ev.kind === 'msg' && !mine && author && cfg.floodOn === true) {
    const key = `${chatId}${SEP}${author}`
    if (now >= Number(g.slow[key] || 0)) {
      const windowMs = num(cfg.floodSecs, 3, 120, 10) * 1000
      const need = num(cfg.floodCount, 3, 50, 8)
      const times = stamp(g.flood, key, now, windowMs)
      if (times.length >= need) {
        g.slow[key] = now + num(cfg.floodSlowSecs, 10, 600, 60) * 1000
        g.flood[key] = []
        const text = String(cfg.floodText || '').trim()
        if (text) sends.push({ chatId, text })
      }
    }
  }

  if ((ev.kind === 'join' || ev.kind === 'leave') && cfg.churnOn === true) {
    const quietUntil = Number(g.quiet[chatId] || 0)
    if (now >= quietUntil) {
      const windowMs = num(cfg.churnSecs, 5, 300, 20) * 1000
      const need = num(cfg.churnCount, 3, 50, 8)
      const times = stamp(g.churn, chatId, now, windowMs)
      if (times.length >= need) {
        g.quiet[chatId] = now + num(cfg.churnQuietSecs, 30, 600, 120) * 1000
        g.churn[chatId] = []
        const text = String(cfg.churnText || '').trim()
        if (text) sends.push({ chatId, text })
      }
    }
  }

  if (ev.kind === 'join' && !mine && cfg.welcomeOn === true) {
    const text = String(cfg.welcomeText || '').trim()
    const quiet = now < Number(g.quiet[chatId] || 0)
    const seenKey = `${chatId}${SEP}${author || 'join'}`
    const seen = Number(g.joined[seenKey] || 0)
    if (text && !quiet && now - seen >= 30000) {
      g.joined[seenKey] = now
      sends.push({ chatId, text })
    }
  }

  return { sends, askHalt, active: true }
}

/** Record that this account has stopped kicking, and the sentence for the customer. */
export function guardFinishHalt(record, chatId, allowed, now, roomName, count) {
  const g = gstate(record)
  const id = String(chatId || '')
  g.halt[id] = now + GUARD_HALT_MS
  g.kickAsked[id] = 0
  const room = roomName && String(roomName).trim() ? String(roomName).trim() : '대화방'
  const n = Number(count) || 0
  const text = allowed
    ? `「${room}」에서 짧은 시간에 강퇴가 ${n}건 있었습니다. 이 계정은 이후 강퇴하지 않습니다.`
    : `「${room}」에서 짧은 시간에 강퇴가 ${n}건 있었습니다. 이 계정은 강퇴를 멈출 권한이 없습니다.`
  pushNotice(g, now, text)
  return text
}

// ── 기록 화면 (관리 화면의 입장·퇴장 / 프로필 / 올킥 방지 기록) ─────────────
// 저장된 record 를 읽기만 한다. runtime 을 고치지 않는다.
const LOG_MAX = 300

function logTimes(list) {
  const out = []
  const seen = new Set()
  for (const t of Array.isArray(list) ? list : []) {
    const n = Number(t)
    if (!Number.isFinite(n) || n <= 0 || seen.has(n)) continue
    seen.add(n)
    out.push(n)
  }
  return out.sort((a, b) => a - b)
}

function logChanges(list, withLink) {
  const out = []
  const seen = new Set()
  for (const c of Array.isArray(list) ? list : []) {
    if (!c || typeof c !== 'object') continue
    const at = Number(c.at)
    if (!Number.isFinite(at) || at <= 0) continue
    const name = String(c.name || '')
    const link = String(c.link || '')
    const sig = at + SEP + name + SEP + (withLink ? link : '')
    if (seen.has(sig)) continue
    seen.add(sig)
    out.push(withLink ? { at, name, link } : { at, name })
  }
  return out.sort((a, b) => a.at - b.at)
}

function logRoomName(record, chatId) {
  const rooms = record && Array.isArray(record.rooms) ? record.rooms : []
  const room = roomByChat(rooms, chatId)
  if (!room) return ''
  const name = room.name || room.title || parseRoomKey(room.key).name
  return name == null ? '' : String(name).trim()
}

function logChatOf(key) {
  const s = String(key || '')
  const i = s.indexOf(SEP)
  const chatId = i < 0 ? '' : s.slice(0, i)
  return realId(chatId) ? chatId : ''
}

function logLatest(row) {
  let t = 0
  for (const n of row.joins) t = Math.max(t, n)
  for (const n of row.leaves) t = Math.max(t, n)
  for (const c of row.changes) t = Math.max(t, c.at)
  return t
}

function visitLogRows(record) {
  const v = record && record.runtime && record.runtime.visit
  const people = v && v.people && typeof v.people === 'object' && !Array.isArray(v.people) ? v.people : {}
  // rememberPerson 은 한 사람을 chat|id 와 chat|n:이름 두 키에 같이 둔다.
  // 같은 방에서 아이디가 같으면 한 사람, 아이디가 없으면 이름이 같은 사람과 합친다.
  const groups = new Map()
  const nameOnly = []
  for (const key of Object.keys(people)) {
    const row = people[key]
    if (!row || typeof row !== 'object') continue
    const chatId = logChatOf(key)
    if (!chatId) continue
    const userId = /^[1-9][0-9]*$/.test(String(row.userId || '')) ? String(row.userId) : ''
    const part = {
      name: String(row.name || '').trim(),
      link: String(row.link || ''),
      joins: logTimes(row.joins),
      leaves: logTimes(row.leaves),
      changes: logChanges(row.changes, true),
    }
    part.touch = logLatest(part)
    if (!userId) {
      nameOnly.push({ chatId, part })
      continue
    }
    const gk = chatId + SEP + userId
    if (!groups.has(gk)) groups.set(gk, { chatId, userId, parts: [] })
    groups.get(gk).parts.push(part)
  }
  for (const { chatId, part } of nameOnly) {
    let home = null
    for (const g of groups.values()) {
      if (g.chatId !== chatId) continue
      if (g.parts.some((p) => p.name && p.name === part.name)) {
        home = g
        break
      }
    }
    if (!home) {
      const gk = chatId + SEP + 'n:' + part.name
      if (!groups.has(gk)) groups.set(gk, { chatId, userId: '', parts: [] })
      home = groups.get(gk)
    }
    home.parts.push(part)
  }
  const out = []
  for (const g of groups.values()) {
    const parts = g.parts.slice().sort((a, b) => b.touch - a.touch)
    const latest = parts[0]
    const name = latest.name || (parts.find((p) => p.name) || {}).name || ''
    const link = latest.link || (parts.find((p) => p.link) || {}).link || ''
    const row = {
      chat_id: g.chatId,
      room: logRoomName(record, g.chatId),
      name,
      user_id: g.userId,
      link,
      joins: logTimes(parts.flatMap((p) => p.joins)),
      leaves: logTimes(parts.flatMap((p) => p.leaves)),
      changes: logChanges(parts.flatMap((p) => p.changes), true),
    }
    if (!row.name && !row.user_id) continue
    out.push(row)
  }
  out.sort((a, b) => logLatest(b) - logLatest(a))
  return out.slice(0, LOG_MAX)
}

function profileLogRows(record) {
  const p = record && record.runtime && record.runtime.profile
  const people = p && p.people && typeof p.people === 'object' && !Array.isArray(p.people) ? p.people : {}
  const out = []
  for (const key of Object.keys(people)) {
    const row = people[key]
    if (!row || typeof row !== 'object') continue
    const chatId = logChatOf(key)
    if (!chatId) continue
    const changes = logChanges(row.changes, false)
    if (!changes.length) continue
    const userId = /^[1-9][0-9]*$/.test(String(row.userId || '')) ? String(row.userId) : ''
    out.push({
      chat_id: chatId,
      room: logRoomName(record, chatId),
      name: String(row.name || '').trim(),
      user_id: userId,
      at: Number(row.at) || changes[changes.length - 1].at,
      changes,
    })
  }
  const lastChange = (r) => r.changes[r.changes.length - 1].at
  out.sort((a, b) => lastChange(b) - lastChange(a))
  return out.slice(0, LOG_MAX)
}

/**
 * What the panel's log page shows, read from a stored record.
 * visit: join/leave rows, one per person per room, newest activity first.
 * profile: rename rows with at least one change, newest change first.
 * guard: anti-mass-kick notices, newest first.
 * Times inside a row (joins, leaves, changes) stay oldest first.
 */
export function logsView(record) {
  return {
    visit: visitLogRows(record),
    profile: profileLogRows(record),
    guard: guardNotices(record).slice().reverse(),
  }
}

/** Owner or manager of an open chat. This account never sends a kick. */
export function guardCanStopKicks(openPermission) {
  const p = Number(openPermission)
  if (!Number.isFinite(p)) return false
  return (p & 1) !== 0 || (p & 4) !== 0
}

export { realId }
