// 보이스룸 봇 — 순수 함수만 둔다. 네트워크·DB·시각 없음(botpool.mjs 가 주입한다).
// 하는 일:
//   · 방 안 명령어로 보이스룸을 켜고 끈다(방장·부방장만). 「!보룸켜기 [제목]」 · 「!보룸끄기」 · 「!보룸」
//   · 한 번 켠 보이스룸을 48시간까지 살려 둔다. KEEP_MS 마다 updateTime 을 올린 LIVE_TALK_INFO 를 다시 보내고(연장),
//     48시간이 되면 스스로 끈다. 끝나기 WARN_MS 전에 방에 한 번 알린다.
//   · 한 계정(봇 하나)이 여러 방의 보이스룸을 동시에 든다. 방마다 자기 session 을 room_state.runtime.voice 에 저장해
//     sender 가 다시 떠도 남은 시간을 그대로 이어 간다. 동시 개수는 maxRooms() 로 막는다.
//   · 카카오가 진짜 값(csIP·callId)을 CHGMETA 로 알려 주면 그 값으로 바꿔 끼워(adopt) 연장에 쓴다.
// callId 는 17자리로 2^53 을 넘는다 — 어디서도 Number 로 만들지 않고 문자열로만 다룬다(JSON.stringify 금지, 정규식으로 읽는다).
const MIN = 60 * 1000
const HOUR = 60 * MIN

export const MAX_MS = 48 * HOUR          // 한 번 켜면 최대 48시간
export const KEEP_MS = 4 * MIN           // 연장 신호 간격
export const WARN_MS = HOUR              // 끝나기 1시간 전에 한 번 알린다
export const MAX_FAILS = 5               // 연장이 내리 이만큼 실패하면 꺼진 것으로 본다
export const DEFAULT_MAX_ROOMS = 8       // 한 계정이 동시에 드는 보이스룸 수
export const DEFAULT_TITLE = '보이스룸'
// 과거 캡처에서 본 음성 서버. 카카오가 진짜 값을 주면 adopt 가 덮어쓴다.
export const FALLBACK_CS = Object.freeze({ csIP: '211.242.15.98', csIP6: '2404:4600:2:d5:211:242:15:98', csPort: 9000 })

export function maxRooms(env) {
  const n = Number((env || {}).SENDER_VOICE_MAX_ROOMS)
  return Number.isFinite(n) && n >= 1 && n <= 50 ? Math.floor(n) : DEFAULT_MAX_ROOMS
}

function clean(s, max) {
  return String(s == null ? '' : s).replace(/[\r\n]+/g, ' ').trim().slice(0, max || 40)
}

// ── 명령어 ────────────────────────────────────────────────────────────────
// 「보룸」과 「보이스룸」 둘 다 받고, 이름과 켜고 끄기 사이 띄어쓰기는 봐준다.
const ON_WORDS = ['켜기', '켜', '켬', '켜줘', '시작', 'on']
const OFF_WORDS = ['끄기', '꺼', '끔', '꺼줘', '중지', '종료', 'off']
const NAME = '(?:보이스룸|보룸)'

/**
 * 보이스룸 명령어 하나를 읽는다. → null(보이스룸 명령어 아님) |
 *   {cmd:'on', title} | {cmd:'off'} | {cmd:'status'}
 * 「!보룸켜기 야간수다」처럼 뒤에 붙인 글은 제목으로 쓴다(최대 40자).
 */
export function parseVoiceCommand(text, prefix) {
  const body = String(text || '').trim()
  if (!prefix || !body.startsWith(prefix)) return null
  const rest = body.slice(prefix.length).trim()
  const head = new RegExp('^' + NAME + '\\s*([^\\s]*)([\\s\\S]*)$').exec(rest)
  if (!head) return null
  const word = head[1].toLowerCase()
  const tail = clean(head[2], 40)
  if (ON_WORDS.includes(word)) return { cmd: 'on', title: tail }
  if (OFF_WORDS.includes(word)) return { cmd: 'off' }
  if (!word) return { cmd: 'status' }
  if (word === '상태' || word === '정보' || word === '남은시간') return { cmd: 'status' }
  // 「!보룸제목」처럼 붙여 쓴 글자는 다른 명령어일 수 있다 — 보이스룸 명령어로 보지 않는다.
  return null
}

// ── LIVE_TALK_INFO(SETMETA type 16) 본문 ─────────────────────────────────
// callId 를 숫자로 담되 정밀도를 잃지 않게 문자열을 직접 조립한다.
export function newCallId(nowSec, rand) {
  const r = Math.floor((typeof rand === 'number' ? rand : Math.random()) * 1e6)
  return '1' + String(Math.floor(nowSec)) + String(Math.max(0, Math.min(999999, r))).padStart(6, '0')
}

export function onContent(s) {
  const title = clean(s.title, 40) || DEFAULT_TITLE
  const startSec = Math.floor(Number(s.startSec) || 0)
  const nowSec = Math.floor(Number(s.nowSec) || startSec)
  const callId = String(s.callId || '').replace(/\D/g, '') || newCallId(nowSec, 0)
  const cs = {
    csIP: String(s.csIP || FALLBACK_CS.csIP),
    csIP6: String(s.csIP6 || FALLBACK_CS.csIP6),
    csPort: Number(s.csPort) || FALLBACK_CS.csPort,
  }
  return '{"liveon":true,"title":' + JSON.stringify(title) +
    ',"updateTime":' + nowSec + ',"startTime":' + startSec +
    ',"csIP":' + JSON.stringify(cs.csIP) + ',"csIP6":' + JSON.stringify(cs.csIP6) + ',"csPort":' + cs.csPort +
    ',"callId":' + callId + ',"url":' + JSON.stringify(String(s.url || '')) + ',"blind":false}'
}

export function offContent() {
  return '{"liveon":false}'
}

// 카카오가 보내 준 보이스룸 메타를 읽는다(JSON.parse 는 callId 정밀도를 잃어 쓰지 않는다).
export function parseMeta(content) {
  const c = String(content || '')
  if (!/"liveon"|"csIP"|"callId"/.test(c)) return null
  const str = (k) => { const m = new RegExp('"' + k + '"\\s*:\\s*"([^"]*)"').exec(c); return m ? m[1] : '' }
  const num = (k) => { const m = new RegExp('"' + k + '"\\s*:\\s*"?(\\d+)"?').exec(c); return m ? m[1] : '' }
  return {
    liveon: /"liveon"\s*:\s*true/.test(c),
    title: str('title'),
    callId: num('callId'),
    csIP: str('csIP'),
    csIP6: str('csIP6'),
    csPort: Number(num('csPort')) || 0,
    startTime: Number(num('startTime')) || 0,
    count: Number(num('count')) || 0,
  }
}

// ── session(방 하나의 보이스룸) ──────────────────────────────────────────
export function newSession(o) {
  const now = Number(o.now) || 0
  const startSec = Math.floor(now / 1000)
  return {
    on: true,
    title: clean(o.title, 40) || DEFAULT_TITLE,
    by: String(o.by || ''),
    chat: String(o.chat || ''),
    startAt: now,
    endAt: now + MAX_MS,
    callId: String(o.callId || newCallId(startSec, o.rand)),
    csIP: String((o.cs && o.cs.csIP) || FALLBACK_CS.csIP),
    csIP6: String((o.cs && o.cs.csIP6) || FALLBACK_CS.csIP6),
    csPort: Number((o.cs && o.cs.csPort)) || FALLBACK_CS.csPort,
    url: '',
    lastAt: now,
    keeps: 0,
    fails: 0,
    warned: false,
    by_name: clean(o.byName, 40),
  }
}

// 저장본을 되살린다. 꺼진 것·끝난 것·다른 방 것·모양이 깨진 것은 버린다(null).
export function restore(raw, o) {
  const s = raw && typeof raw === 'object' ? raw : null
  if (!s || !s.on) return null
  const startAt = Number(s.startAt)
  if (!Number.isFinite(startAt) || startAt <= 0) return null
  const chat = String((o && o.chat) || '')
  if (chat && s.chat && String(s.chat) !== chat) return null
  const endAt = Number.isFinite(Number(s.endAt)) && Number(s.endAt) > startAt ? Number(s.endAt) : startAt + MAX_MS
  const now = Number((o && o.now) || 0)
  if (now && now >= endAt) return null
  return {
    on: true,
    title: clean(s.title, 40) || DEFAULT_TITLE,
    by: String(s.by || ''),
    chat: String(s.chat || chat),
    startAt,
    endAt,
    callId: String(s.callId || '').replace(/\D/g, '') || newCallId(Math.floor(startAt / 1000), 0),
    csIP: String(s.csIP || FALLBACK_CS.csIP),
    csIP6: String(s.csIP6 || FALLBACK_CS.csIP6),
    csPort: Number(s.csPort) || FALLBACK_CS.csPort,
    url: String(s.url || ''),
    lastAt: Number(s.lastAt) || startAt,
    keeps: Number(s.keeps) || 0,
    fails: Number(s.fails) || 0,
    warned: !!s.warned,
    by_name: clean(s.by_name, 40),
  }
}

export function expired(s, now) {
  return !!s && !!s.on && Number(now) >= Number(s.endAt)
}

export function dueKeepalive(s, now, everyMs) {
  if (!s || !s.on) return false
  if (expired(s, now)) return false
  return Number(now) - Number(s.lastAt || 0) >= (Number(everyMs) || KEEP_MS)
}

export function dueWarn(s, now) {
  return !!s && !!s.on && !s.warned && Number(s.endAt) - Number(now) <= WARN_MS
}

// 연장 결과를 적는다. ok 면 fails 를 0 으로, 아니면 쌓는다. dead() 가 참이면 꺼진 것으로 본다.
export function touch(s, now, ok) {
  if (!s) return s
  s.lastAt = Number(now) || s.lastAt
  if (ok) {
    s.keeps = (Number(s.keeps) || 0) + 1
    s.fails = 0
  } else {
    s.fails = (Number(s.fails) || 0) + 1
  }
  return s
}

export function dead(s) {
  return !!s && (Number(s.fails) || 0) >= MAX_FAILS
}

// 카카오가 알려 준 진짜 값으로 바꿔 끼운다(callId·음성서버·제목). 바뀐 것이 있으면 true.
export function adopt(s, meta) {
  if (!s || !s.on || !meta) return false
  if (meta.liveon === false) return false
  let changed = false
  const set = (k, val) => { if (val && String(s[k]) !== String(val)) { s[k] = val; changed = true } }
  set('callId', String(meta.callId || '').replace(/\D/g, ''))
  set('csIP', meta.csIP)
  set('csIP6', meta.csIP6)
  if (meta.csPort && Number(s.csPort) !== Number(meta.csPort)) { s.csPort = Number(meta.csPort); changed = true }
  if (meta.startTime) {
    const startAt = Number(meta.startTime) * 1000
    // 카카오의 시작 시각이 더 이르면 48시간은 그때부터 센다(두 번 켜도 늘어나지 않게).
    if (startAt > 0 && Math.abs(startAt - Number(s.startAt)) > 2000 && startAt < Number(s.startAt)) {
      s.startAt = startAt
      s.endAt = startAt + MAX_MS
      changed = true
    }
  }
  return changed
}

export function startSecOf(s) {
  return Math.floor(Number(s.startAt) / 1000)
}

// ── 사람에게 보이는 글 ───────────────────────────────────────────────────
export function spanText(ms) {
  const total = Math.max(0, Math.floor(Number(ms) || 0) / MIN)
  const h = Math.floor(total / 60)
  const m = Math.floor(total % 60)
  if (h && m) return `${h}시간 ${m}분`
  if (h) return `${h}시간`
  return `${Math.max(1, m)}분`
}

export function onReply(s) {
  return `보이스룸 「${s.title}」을 켰어요. ${spanText(MAX_MS)} 동안 제가 켜 둘게요.\n끄려면 「보룸끄기」를 쳐 주세요.`
}

export function offReply(s, now) {
  if (!s) return '지금 이 방에 켜 둔 보이스룸이 없어요.'
  return `보이스룸 「${s.title}」을 껐어요. (${spanText(Number(now) - Number(s.startAt))} 켜 뒀어요)`
}

export function statusReply(s, now) {
  if (!s || !s.on) return '지금 이 방에 켜 둔 보이스룸이 없어요. 「보룸켜기」로 켤 수 있어요.'
  const left = Number(s.endAt) - Number(now)
  return `보이스룸 「${s.title}」 켜져 있어요.\n켠 지 ${spanText(Number(now) - Number(s.startAt))} · 남은 시간 ${spanText(left)}`
}

export function capReply(count, max) {
  return `제 계정이 지금 ${count}개 방에서 보이스룸을 들고 있어요(최대 ${max}개). 다른 방에서 하나를 끄고 다시 쳐 주세요.`
}

export function staffOnlyReply() {
  return '보이스룸은 방장·부방장만 켜고 끌 수 있어요.'
}

export function failReply(status) {
  const st = Number(status)
  return `보이스룸을 켜지 못했어요${Number.isFinite(st) && st !== 0 ? ` (카카오 응답 ${st})` : ''}. 잠시 뒤 다시 쳐 주세요.`
}

export function alreadyReply(s, now) {
  return `보이스룸 「${s.title}」은 이미 켜져 있어요. 남은 시간 ${spanText(Number(s.endAt) - Number(now))}.`
}

export function warnNotice(s, now) {
  return `보이스룸 「${s.title}」이 ${spanText(Number(s.endAt) - Number(now))} 뒤에 꺼져요. 계속 쓰려면 그때 「보룸켜기」를 다시 쳐 주세요.`
}

export function endNotice(s) {
  return `보이스룸 「${s.title}」을 ${spanText(MAX_MS)} 켜 둔 뒤 껐어요. 다시 쓰려면 「보룸켜기」를 쳐 주세요.`
}

export function deadNotice(s) {
  return `보이스룸 「${s.title}」이 카카오에서 내려가 제 쪽 기록도 껐어요. 다시 켜려면 「보룸켜기」를 쳐 주세요.`
}

// 패널·관리자용 한 줄 요약
export function sessionRow(v, s, now) {
  return {
    install_id: Number(v.install_id) || 0,
    chat_id: String(v.chat_id || ''),
    link_id: String(v.link_id || ''),
    room: String(v.link_name || ''),
    title: s.title,
    by: s.by,
    on: true,
    start_at: Number(s.startAt),
    end_at: Number(s.endAt),
    left_ms: Math.max(0, Number(s.endAt) - Number(now)),
    keeps: Number(s.keeps) || 0,
    fails: Number(s.fails) || 0,
    call_id: String(s.callId || ''),
  }
}

// ── 진단(SENDER_VOICE_EXPERIMENT 전용) ───────────────────────────────────
// 카카오가 켜기 신호를 거절했을 때(실측 -203) 그 까닭을 가린다.
// 같은 방에 SETMETA 를 여러 모양으로 던져 보고, 어디서 갈리는지로 판정한다:
//   on+li · on-li  진짜 켜기 신호(오픈링크 id 포함·미포함 — 둘 중 하나만 되는지 본다)
//   off            끄기 신호(무해). 켜기만 막는지, 보이스룸 메타 전체를 막는지
//   count          type 17(LIVE_TALK_COUNT) — 보이스룸 메타 계열 전체가 막혔는지
//   unknown        쓰지 않는 type(97) 대조군 — "모르는 타입" 코드가 무엇인지 못박는다
//   same           지금 방에 있는 메타를 글자 그대로 다시 쓰기(바뀌는 것 없음, 「전체」일 때만)
//                  → 0 이면 이 봇은 메타를 쓸 수 있다는 뜻이라, 거부가 보이스룸 메타에만 걸린 것이다
export function metaTypeNum(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (v && typeof v === 'object' && 'low' in v) return Number(v.low)
  const n = Number(v)
  return Number.isFinite(n) ? n : NaN
}

function stOf(rows, tag) {
  const hit = (rows || []).find((r) => r && r.tag === tag)
  return hit ? Number(hit.st) : null
}

/** 보이스룸 계열 메타 타입(카카오가 보이스룸에 쓰는 자리) */
export const VOICE_META_TYPES = Object.freeze([16, 17])

export function isVoiceMetaType(t) {
  return VOICE_META_TYPES.includes(metaTypeNum(t))
}

/**
 * 진단 결과 한 줄 판정. rows = [{tag, st}], o = {perm, sameType}
 * → {verdict, next:'banner'|'server_only'|'owner_test'|'full'}
 * 핵심은 두 가지를 함께 보는 것이다:
 *   · 봇이 방장(perm & 1)인가 — 방장인데 거부면 권한으로는 설명되지 않는다
 *   · 모르는 타입(unknown)과 보이스룸 타입의 코드가 다른가 — 다르면 서버가 "모르는 타입"과
 *     "이 타입은 거부"를 가려서 답한다는 뜻이고, 거부가 보이스룸 자리에만 걸린 것이다
 * same 은 보이스룸이 아닌 메타로 돌렸을 때만 센다(거부당하는 타입을 다시 써 보는 것은 대조군이 아니다).
 */
export function diagVerdict(rows, o) {
  const opt = o || {}
  const owner = (Number(opt.perm) & 1) !== 0
  const who = owner ? '방장' : '부방장'
  const on = [stOf(rows, 'on+li'), stOf(rows, 'on-li')].filter((x) => x != null)
  const onOk = on.some((x) => x === 0)
  const onSt = on.find((x) => x !== 0)
  const off = stOf(rows, 'off')
  const unknown = stOf(rows, 'unknown')
  // 보이스룸 타입으로 돌린 same 은 대조군이 아니다 — 없는 셈 친다
  const same = isVoiceMetaType(opt.sameType) ? null : stOf(rows, 'same')
  if (onOk) return { verdict: '카카오가 켜기 신호를 받았어요. 방에 보이스룸 배너가 보이는지 확인해 주세요.', next: 'banner' }
  if (same === 0) {
    return { verdict: `이 봇은 다른 방 메타는 쓸 수 있는데 보이스룸 메타만 거부돼요(${who}). 카카오가 음성 서버로만 쓰는 자리입니다.`, next: 'server_only' }
  }
  if (same != null && same !== 0 && !owner) {
    return { verdict: '이 봇은 보이스룸이 아닌 메타도 쓸 수 없어요. 권한 문제일 수 있으니 봇이 방장인 방에서 한 번 더 확인해 주세요.', next: 'owner_test' }
  }
  if (same != null && same !== 0 && owner) {
    return { verdict: '봇이 방장인데도 방 메타를 아예 쓸 수 없어요. 방 메타는 클라이언트가 쓰는 자리가 아닙니다.', next: 'server_only' }
  }
  if (unknown != null && onSt != null && unknown !== onSt) {
    if (owner) {
      return {
        verdict: `봇이 방장인데도 보이스룸 타입만 ${onSt} 로 거부되고, 모르는 타입은 ${unknown} 이에요. 권한이 아니라 카카오가 음성 서버로만 쓰는 자리라는 뜻입니다.`,
        next: 'server_only',
      }
    }
    return { verdict: `모르는 타입은 ${unknown}, 보이스룸 타입은 ${onSt} — 거부가 보이스룸 메타에만 걸려 있어요.`, next: 'full' }
  }
  if (off === 0 && onSt != null) {
    return { verdict: '끄기는 받고 켜기만 거부돼요. 켜는 값(callId)을 서버가 먼저 만들어 줘야 하는 것으로 보입니다.', next: 'server_only' }
  }
  if (owner) {
    return { verdict: `봇이 방장인데도 보이스룸 메타가 ${onSt} 로 거부돼요. 권한으로는 설명되지 않습니다.`, next: 'server_only' }
  }
  return { verdict: '아직 가릴 수 없어요. 보이스룸이 아닌 메타가 있는 방에서 「보룸진단 전체」를 돌려 주세요.', next: 'full' }
}

/** 방에 보낼 진단 답. rows = [{tag, st}], o = {types, perm, full, sameType, sameSkip} */
export function diagText(rows, o) {
  const opt = o || {}
  const perm = Number(opt.perm)
  const who = (perm & 1) !== 0 ? '방장' : (perm & 4) !== 0 ? '부방장' : '권한 없음'
  const line = (rows || []).map((r) => `${r.tag} ${r.st}`).join(' · ')
  const v = diagVerdict(rows, { perm, sameType: opt.sameType })
  const head = `보룸 진단 (${who} ${perm} · 방 메타 ${Array.isArray(opt.types) && opt.types.length ? opt.types.join(',') : '없음'})`
  const note = opt.sameSkip ? `\n(대조군 생략: ${opt.sameSkip})` : ''
  const tail = v.next === 'full' && !opt.full ? '\n「보룸진단 전체」로 한 번 더 돌리면 더 가려집니다(보이스룸이 아닌 방 메타를 같은 값으로 다시 써 봅니다).' : ''
  return `${head}\n${line}${note}\n→ ${v.verdict}${tail}`
}
