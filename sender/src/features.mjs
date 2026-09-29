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

function coversList(list, roomKey) {
  if (!Array.isArray(list) || list.length === 0) return false
  const p = parseRoomKey(roomKey)
  return list.some((k) => {
    const q = parseRoomKey(k)
    return q.key === p.key || (q.acc === p.acc && q.name === p.name)
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
  if (macro.sendImages === 'EVERY') return true
  if (macro.sendImages === 'EVERY_N') {
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

export { realId }
