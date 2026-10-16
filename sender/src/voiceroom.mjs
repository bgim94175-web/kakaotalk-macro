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
// 실측으로 밝혀진 LOCO 상태코드(2026-10-16, 봇이 방장인 시험 방)
//   -300 = 없는 명령어·모르는 메타 타입   (가짜 명령어 ZZQXNON1·QWEORIZZ9 와 쓰지 않는 type 97 이 모두 -300)
//   -203 = 있는데 보낸 내용이 틀림        (봇이 잘 쓰는 WRITE 를 빈 바디로 보냈더니 -203)
// 저장소가 예전에 -203 을 '권한 없음'으로 가정했으나(fake.mjs·9.4) 실측은 그렇지 않다.
export const STATUS_BAD_REQUEST = -203
export const STATUS_UNKNOWN = -300

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
 * → {verdict, next:'banner'|'bad_shape'|'unknown_type'|'owner_test'|'server_only'|'full'}
 *
 * 실측으로 밝혀진 상태코드(2026-10-16, 아래 STATUS_* 주석):
 *   -300 = 없는 명령어·모르는 타입 · -203 = 있는데 보낸 내용이 틀림
 * 그래서 보이스룸 타입이 -203 이고 모르는 타입이 -300 이면, 카카오는 그 타입을 **알고** 있고
 * 거부당한 것은 우리 내용이다 → 「보룸따라」로 카카오가 써 둔 메타를 따라 쓰는 것이 다음 수다.
 * same(보이스룸이 아닌 메타 다시 쓰기)이 -203 인 것도 같은 뜻이라(우리가 revision 같은 칸을 빠뜨렸을 수 있다)
 * 권한 이야기로 읽지 않는다.
 */
export function diagVerdict(rows, o) {
  const opt = o || {}
  const owner = (Number(opt.perm) & 1) !== 0
  const on = [stOf(rows, 'on+li'), stOf(rows, 'on-li')].filter((x) => x != null)
  const onOk = on.some((x) => x === 0)
  const onSt = on.find((x) => x !== 0)
  const unknown = stOf(rows, 'unknown')
  const off = stOf(rows, 'off')
  // 보이스룸 타입으로 돌린 same 은 대조군이 아니다 — 없는 셈 친다
  const same = isVoiceMetaType(opt.sameType) ? null : stOf(rows, 'same')
  if (onOk) return { verdict: '카카오가 켜기 신호를 받았어요. 방에 보이스룸 배너가 보이는지 확인해 주세요.', next: 'banner' }
  if (onSt === STATUS_UNKNOWN) {
    return { verdict: `카카오가 보이스룸 타입을 모른다고 답해요(${onSt}). 타입 번호부터 다시 봐야 합니다.`, next: 'unknown_type' }
  }
  if (onSt === STATUS_BAD_REQUEST && unknown === STATUS_UNKNOWN) {
    return {
      verdict: `모르는 타입은 ${unknown}, 보이스룸 타입은 ${onSt} — 카카오는 이 타입을 알고 있고 우리가 보낸 내용을 거부한 거예요. 권한 문제가 아닙니다.`,
      next: 'bad_shape',
    }
  }
  if (same === 0 && onSt != null) {
    return { verdict: `다른 방 메타는 쓸 수 있는데 보이스룸만 ${onSt} 로 거부돼요.`, next: onSt === STATUS_BAD_REQUEST ? 'bad_shape' : 'server_only' }
  }
  if (same != null && same !== 0 && same !== STATUS_BAD_REQUEST && !owner) {
    return { verdict: '이 봇은 보이스룸이 아닌 메타도 쓸 수 없어요. 권한 문제일 수 있으니 봇이 방장인 방에서 한 번 더 확인해 주세요.', next: 'owner_test' }
  }
  if (off === 0 && onSt != null) {
    return { verdict: '끄기는 받고 켜기만 거부돼요. 켜는 값(callId)을 서버가 먼저 만들어 줘야 하는 것으로 보입니다.', next: 'server_only' }
  }
  if (onSt === STATUS_BAD_REQUEST) {
    return { verdict: `보이스룸 메타가 ${onSt}(보낸 내용이 틀림) 로 거부돼요. 카카오가 써 둔 메타를 따라 써 보는 것이 다음 수입니다.`, next: 'bad_shape' }
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
  const tail = v.next === 'bad_shape' ? '\n「보룸따라」를 치면 카카오가 이 방에 써 둔 보이스룸 메타를 글자 그대로 따라 써 봅니다.'
    : v.next === 'full' && !opt.full ? '\n「보룸진단 전체」로 한 번 더 돌리면 더 가려집니다(보이스룸이 아닌 방 메타를 같은 값으로 다시 써 봅니다).' : ''
  return `${head}\n${line}${note}\n→ ${v.verdict}${tail}`
}

// ── 따라 쓰기(mirror) ────────────────────────────────────────────────────
// 실측으로 밝혀진 상태코드(2026-10-16):
//   -300 = 없는 명령어 · 모르는 메타 타입   (가짜 명령어 두 개와 쓰지 않는 type 97 이 모두 -300)
//   -203 = 있는데 요청 내용이 잘못됨        (봇이 잘 쓰는 WRITE 를 빈 바디로 보냈더니 -203)
// 즉 SETMETA type 16 의 -203 은 "권한 없음"이 아니라 "이 타입은 아는데 네가 보낸 내용이 틀렸다"는 뜻이다.
// 그래서 다음 수는 카카오가 그 방에 직접 써 둔 보이스룸 메타를 글자 그대로 따라 쓰는 것이다.
/** 로그에 남길 때 url 값만 가린다(주소에 토큰이 들어 있을 수 있다). */
export function maskMeta(content) {
  return String(content == null ? '' : content).replace(/"url"\s*:\s*"([^"]*)"/g, (m, u) => `"url":"<hidden ${u.length}>"`)
}

/** 카카오가 준 메타에서 content·type 말고 함께 온 칸들(revision·authorId·updatedAt …). 그대로 돌려보내려고 모은다. */
export function metaExtras(meta) {
  const out = {}
  if (!meta || typeof meta !== 'object') return out
  for (const [k, v] of Object.entries(meta)) {
    if (k === 'type' || k === 'content') continue
    if (v === undefined) continue
    out[k] = v
  }
  return out
}

/**
 * 카카오가 써 둔 메타 본문을 켜진 모양으로 바꾼다. callId 정밀도를 잃지 않게 글자만 손본다(JSON.parse 금지).
 * liveon 을 true 로, updateTime 을 지금으로. 둘 중 없는 칸은 앞에 끼워 넣는다.
 */
export function turnOn(content, nowSec) {
  let t = String(content == null ? '' : content)
  const sec = Math.floor(Number(nowSec) || 0)
  if (/"liveon"\s*:\s*(true|false)/.test(t)) t = t.replace(/"liveon"\s*:\s*(true|false)/, '"liveon":true')
  else t = t.replace(/^\s*\{/, '{"liveon":true,')
  if (/"updateTime"\s*:\s*\d+/.test(t)) t = t.replace(/"updateTime"\s*:\s*\d+/, '"updateTime":' + sec)
  else t = t.replace(/^\s*\{/, '{"updateTime":' + sec + ',')
  return t
}

/** 따라 쓰기 결과 판정. rows = [{tag, st}] → {verdict, next} */
export function mirrorVerdict(rows) {
  const st = (tag) => { const h = (rows || []).find((r) => r && r.tag === tag); return h ? Number(h.st) : null }
  const any = (rows || []).filter((r) => Number(r.st) === 0).map((r) => r.tag)
  if (any.length) {
    return { verdict: `카카오가 받은 모양이 있어요: ${any.join(', ')}. 이 모양으로 켜기를 다시 맞추면 됩니다.`, next: 'shape_found' }
  }
  const asis = st('asis')
  const echo = st('echo')
  if (asis === STATUS_UNKNOWN || echo === STATUS_UNKNOWN) {
    return { verdict: '카카오가 이 타입을 모른다고 답해요. 타입 번호부터 다시 봐야 합니다.', next: 'unknown_type' }
  }
  return {
    verdict: '카카오가 써 둔 메타를 글자 그대로 돌려보내도 거부해요. 클라이언트가 쓸 수 있는 자리가 아닐 가능성이 큽니다.',
    next: 'server_only',
  }
}

/** 방에 보낼 따라 쓰기 답. o = {type, keys, has16} */
export function mirrorText(rows, o) {
  const opt = o || {}
  const line = (rows || []).map((r) => `${r.tag} ${r.st}`).join(' · ')
  const v = mirrorVerdict(rows)
  const keys = Array.isArray(opt.keys) && opt.keys.length ? opt.keys.join(',') : '없음'
  return `보룸 따라쓰기 (type ${opt.type} · 함께 온 칸 ${keys})\n${line}\n→ ${v.verdict}`
}

// ── 쓰기 시험(write test) ────────────────────────────────────────────────
// 따라쓰기까지 전부 -203 이었다. 그런데 우리는 SETMETA 가 **어떤 타입으로든** 통하는 것을 아직 본 적이 없다.
// 그래서 두 가지를 못 가린다:
//   (A) 우리 SETMETA 바디 모양이 애초에 틀렸다(그러면 모든 타입이 -203 이다)
//   (B) 바디는 맞는데 type 16 만 클라이언트가 쓸 수 없는 자리다
// 보이스룸이 아닌 타입 하나를 **지금 값 그대로** 써 보면 갈린다. 0 이 나오면 (B) — 이 길은 닫힌 것이다.
export function writeTestVerdict(rows) {
  const list = rows || []
  const okRow = list.find((r) => Number(r.st) === 0)
  if (okRow) {
    return {
      verdict: `보이스룸이 아닌 메타는 써집니다(${okRow.tag} 0). 바디 모양은 맞고, type 16 만 클라이언트가 쓸 수 없는 자리예요. 신호로 켜는 길은 닫혔습니다.`,
      next: 'voice_closed',
    }
  }
  if (list.some((r) => Number(r.st) === STATUS_UNKNOWN)) {
    return { verdict: '그 타입도 모른다고 답해요. 타입 번호부터 다시 봐야 합니다.', next: 'unknown_type' }
  }
  return {
    verdict: 'SETMETA 가 어떤 타입으로도 통하지 않아요. 우리 바디 모양이 틀렸거나, 오픈채팅은 다른 명령어로 메타를 바꾸는 것일 수 있습니다.',
    next: 'bad_shape',
  }
}

/** 방에 보낼 쓰기 시험 답. o = {what} — 무엇을 썼는지 사람 말로 */
export function writeTestText(rows, o) {
  const opt = o || {}
  const line = (rows || []).map((r) => `${r.tag} ${r.st}`).join(' · ')
  const v = writeTestVerdict(rows)
  return `보룸 쓰기시험 (${opt.what || '-'})\n${line}\n→ ${v.verdict}`
}

// ── 바디 모양 찾기(shape) ────────────────────────────────────────────────
// 쓰기시험에서 보이스룸이 아닌 타입(제목 3)마저 -203 이었다 → 우리 SETMETA 바디 모양 자체가 의심스럽다.
// 실제로 이 저장소에서 **운영 중 통하는** 오픈채팅 명령어(KICKMEM·REWRITE·KLDELITEM)는 openAction 을 거치며
// `{li, c}` 를 쓴다 — `chatId` 가 아니라 `c` 다. 반면 CHATONROOM·GETMEM 은 `chatId` 로 통한다(명령어마다 다르다).
// 그래서 SETMETA 가 어느 이름을 원하는지 모아 두고 하나씩 던져 본다. 해가 없는 타입(제목)으로 먼저 찾고,
// 통하는 모양이 있으면 그 모양으로 보이스룸(16)을 다시 친다.
export const SHAPES = Object.freeze([
  { tag: 'chatId', chat: 'chatId', li: false, type: 'type', content: 'content' },      // 지금까지 보내던 모양
  { tag: 'chatId+li', chat: 'chatId', li: true, type: 'type', content: 'content' },
  { tag: 'c', chat: 'c', li: false, type: 'type', content: 'content' },
  { tag: 'c+li', chat: 'c', li: true, type: 'type', content: 'content' },              // openAction 과 같은 모양
  { tag: 'c+li+t', chat: 'c', li: true, type: 't', content: 'content' },
  { tag: 'c+li+v', chat: 'c', li: true, type: 'type', content: 'v' },
  { tag: 'c+li+meta', chat: 'c', li: true, type: 'type', content: 'meta' },
  { tag: 'c+li+long', chat: 'c', li: true, type: 'type', content: 'content', longType: true },
])

/** 모양 하나로 바디를 만든다. vals = {chatId, li, type, typeLong, content} — 값은 부르는 쪽이 Long 으로 넣는다. */
export function shapeBody(shape, vals) {
  const o = {}
  const v = vals || {}
  o[shape.chat] = v.chatId
  if (shape.li && v.li != null) o.li = v.li
  o[shape.type] = shape.longType ? v.typeLong : v.type
  o[shape.content] = v.content
  return o
}

/** 모양 찾기 판정. rows = [{tag, st}] → {verdict, next, shape} */
export function shapeVerdict(rows, o) {
  const opt = o || {}
  const hit = (rows || []).find((r) => Number(r.st) === 0 && !String(r.tag).startsWith('보이스룸'))
  if (!hit) {
    return {
      verdict: '어떤 모양으로도 통하지 않아요. SETMETA 는 오픈채팅에서 쓰는 명령어가 아닐 수 있습니다 — 명령어 쪽을 찾아야 합니다.',
      next: 'no_shape',
      shape: '',
    }
  }
  const voice = (rows || []).find((r) => String(r.tag).startsWith('보이스룸'))
  if (voice && Number(voice.st) === 0) {
    return {
      verdict: `모양을 찾았어요(${hit.tag}). 그 모양으로 보이스룸도 받아들였습니다 — 켜집니다!`,
      next: 'voice_on',
      shape: hit.tag,
    }
  }
  if (voice) {
    return {
      verdict: `모양을 찾았어요(${hit.tag}) — 제목은 이 모양으로 써집니다. 그런데 같은 모양으로 보이스룸은 ${voice.st} 로 거부돼요. 보이스룸 자리만 막힌 것이 이제야 확인됐습니다.`,
      next: 'voice_closed',
      shape: hit.tag,
    }
  }
  return { verdict: `모양을 찾았어요(${hit.tag}). 이 모양으로 보이스룸을 다시 쳐 봐야 합니다.`, next: 'shape_found', shape: hit.tag }
}

export function shapeText(rows, o) {
  const opt = o || {}
  const line = (rows || []).map((r) => `${r.tag} ${r.st}`).join(' · ')
  const v = shapeVerdict(rows, opt)
  return `보룸 모양찾기 (${opt.what || '-'})\n${line}\n→ ${v.verdict}`
}
