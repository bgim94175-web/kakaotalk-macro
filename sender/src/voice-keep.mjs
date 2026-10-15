// 보이스룸 유지(B층) — 한 번 켠 보이스룸이 꺼지지 않게 지키는 순수 계산.
// 시계·네트워크·DB 를 모른다. 상태 하나와 지금 시각만 받아 "다음에 무엇을 할지"를 답하고,
// 실제 신호(SETMETA type 16 LIVE_TALK_INFO)는 botpool 의 voiceSetMeta 가 보낸다.
//   · 유지: 켜 둔 동안 refreshMs 마다 같은 callId·startTime 으로 updateTime 만 올려 다시 알린다.
//   · 복구: liveon=false 를 보거나(CHGMETA) 봇이 다시 접속하면 callId 를 새로 받아 다시 켠다.
//   · 물러남: 사람(방장·부방장)이 끈 것은 따라 끈다(yieldToHuman). 서버가 내린 것만 다시 켠다.
//   · 끝: keepMs(기본 48시간)이 지나면 스스로 끄고, 연속 실패가 failMax 를 넘으면 포기한다.
// 상태는 room_state(runtime.voice)에 그대로 저장돼 sender 가 다시 켜져도 이어서 지킨다.
// selfcheck 가 이 파일만 따로 돌려 순서(켜기 → 유지 → 떨어짐 → 복구 → 포기 → 48시간 끝)를 검사한다.

const SEC = 1000
const MIN = 60 * SEC
const HOUR = 60 * MIN

// 속도 제한 응답(botpool 과 같은 값): 짧게 되풀이하지 않고 길게 쉰다.
const RATE_STATUS = new Set([-312, -805, -819])
// 방이 없어졌다: 더 지킬 것이 없다.
const GONE_STATUS = new Set([-324])

function num(name, dflt) {
  const n = Number(process.env[name])
  return Number.isFinite(n) && n > 0 ? n : dflt
}

export function normVoiceKeep(over) {
  const o = Object.assign({
    keepMs: num('SENDER_VOICE_KEEP_MS', 48 * HOUR),          // 켤 때 기본 유지 시간
    maxMs: num('SENDER_VOICE_KEEP_MAX_MS', 48 * HOUR),       // 아무도 이보다 길게는 못 켠다
    refreshMs: num('SENDER_VOICE_KEEP_REFRESH_MS', 4 * MIN), // 다시 알리는 주기
    recoverMs: num('SENDER_VOICE_KEEP_RECOVER_MS', 3 * SEC), // 꺼진 것을 본 뒤 다시 켜기까지
    graceMs: num('SENDER_VOICE_KEEP_GRACE_MS', 20 * SEC),    // 봇이 다시 접속한 뒤 기다림
    rateWaitMs: num('SENDER_VOICE_KEEP_RATE_MS', 10 * MIN),  // 속도 제한에 걸렸을 때 쉼
    failMax: num('SENDER_VOICE_KEEP_FAILS', 8),              // 연속 실패 이 횟수에 포기
    backoffs: [10 * SEC, 30 * SEC, 2 * MIN, 5 * MIN, 15 * MIN],
    yieldToHuman: process.env.SENDER_VOICE_KEEP_YIELD !== '0',
    // 음성 서버 값(실측 캡처). 서버 할당이 생기면 voiceSetMeta 가 받은 값으로 덮어쓴다.
    csIP: String(process.env.SENDER_VOICE_CS_IP || '211.242.15.98'),
    csIP6: String(process.env.SENDER_VOICE_CS_IP6 || '2404:4600:2:d5:211:242:15:98'),
    csPort: num('SENDER_VOICE_CS_PORT', 9000),
  }, over || {})
  o.maxMs = Math.max(MIN, Math.floor(o.maxMs))
  o.keepMs = Math.min(Math.max(MIN, Math.floor(o.keepMs)), o.maxMs)
  o.refreshMs = Math.max(10 * SEC, Math.floor(o.refreshMs))
  o.recoverMs = Math.max(0, Math.floor(o.recoverMs))
  o.graceMs = Math.max(0, Math.floor(o.graceMs))
  o.failMax = Math.max(1, Math.floor(o.failMax))
  if (!Array.isArray(o.backoffs) || !o.backoffs.length) o.backoffs = [10 * SEC]
  return o
}

// runtime.voice 의 모양. 숫자는 모두 ms, callId 는 2^53 을 넘으므로 문자열로 둔다.
export function blankVoiceKeep() {
  return {
    on: false,
    by: '',          // 켠 사람 user_id('' = 관리자 API)
    startAt: 0,
    until: 0,
    callId: '',
    liveAt: 0,       // 마지막으로 켜져 있음을 확인한 때
    nextAt: 0,       // 다음에 손 볼 때
    fails: 0,        // 연속 실패
    lastStatus: 0,
    offAt: 0,        // 꺼져 있음을 본 때(0 = 아님) → 다음 차례에 다시 켠다
    opens: 0,        // 다시 켠 횟수
    refreshes: 0,
    stop: '',        // '' | user | expired | gave_up | closed | gone | off
    stopAt: 0,
  }
}

export function voiceKeepOn(st) {
  return !!(st && st.on)
}

// 「보룸유지 48」·「보룸유지 30분」·「보룸유지 2h」 → ms. 못 읽으면 0(기본값을 쓴다).
export function voiceKeepSpan(arg, opts) {
  const o = opts || normVoiceKeep()
  const s = String(arg == null ? '' : arg).trim()
  if (!s) return 0
  const m = /^([0-9]+(?:\.[0-9]+)?)\s*(분|m|min|시간|h|hr|hour|시)?$/i.exec(s)
  if (!m) return 0
  const n = Number(m[1])
  if (!Number.isFinite(n) || n <= 0) return 0
  const unit = (m[2] || '').toLowerCase()
  const ms = unit === '분' || unit === 'm' || unit === 'min' ? n * MIN : n * HOUR
  return Math.min(Math.max(MIN, Math.round(ms)), o.maxMs)
}

// 유지 켜기. 늘 처음부터 시작한다(지난 callId·실패 기록은 버린다).
export function voiceKeepStart(st, now, opts, span, by) {
  const o = opts || normVoiceKeep()
  const next = blankVoiceKeep()
  const want = Number(span) > 0 ? Math.min(Number(span), o.maxMs) : o.keepMs
  next.on = true
  next.by = String(by || '')
  next.startAt = now
  next.until = now + Math.max(MIN, want)
  next.nextAt = now          // 바로 켠다
  next.opens = st && st.opens ? Number(st.opens) || 0 : 0
  return next
}

// 유지 끄기. callId 는 끄는 신호(liveon:false)를 보낼 때까지 남긴다.
export function voiceKeepStop(st, now, why) {
  const next = Object.assign(blankVoiceKeep(), st || {})
  next.on = false
  next.nextAt = 0
  next.offAt = 0
  next.stop = String(why || 'user')
  next.stopAt = now
  return next
}

// 봇이 다시 접속했다: 지난 callId 는 죽은 것으로 보고 새로 켠다.
export function voiceKeepReconnect(st, now, opts) {
  if (!voiceKeepOn(st)) return false
  const o = opts || normVoiceKeep()
  st.callId = ''
  st.offAt = now
  st.fails = 0
  st.nextAt = now + o.graceMs
  return true
}

function backoffMs(o, fails, status) {
  if (RATE_STATUS.has(Number(status))) return o.rateWaitMs
  const i = Math.min(Math.max(1, fails) - 1, o.backoffs.length - 1)
  return o.backoffs[i]
}

/**
 * 다음에 할 일. { do, why, at }
 *   do: none(유지 안 함) | wait(아직 때가 아님, at 에 다시 묻기) | open(새 callId 로 켜기)
 *       | refresh(같은 callId 로 다시 알리기) | close(끄는 신호를 보내고 유지 끝)
 */
export function voiceKeepPlan(st, now, opts) {
  const o = opts || normVoiceKeep()
  if (!voiceKeepOn(st)) return { do: 'none', why: st && st.stop ? st.stop : 'off', at: 0 }
  if (now >= Number(st.until || 0)) return { do: 'close', why: 'expired', at: 0 }
  if (Number(st.fails || 0) >= o.failMax) return { do: 'close', why: 'gave_up', at: 0 }
  const at = Math.min(Number(st.nextAt || 0), Number(st.until))
  if (at > now) return { do: 'wait', why: st.offAt ? 'dropped' : 'tick', at }
  if (!st.callId || st.offAt) return { do: 'open', why: st.offAt ? 'dropped' : (st.opens || st.liveAt ? 'reopen' : 'start'), at: now }
  return { do: 'refresh', why: 'tick', at: now }
}

/**
 * 한 번 손 본 결과를 상태에 넣는다. res = { ok, status, callId }
 * 돌려주는 값은 로그·안내에 쓰는 한 마디:
 *   opened | recovered | kept | retry | expired | gave_up | closed | gone
 */
export function voiceKeepDone(st, plan, res, now, opts) {
  const o = opts || normVoiceKeep()
  const r = res || {}
  const status = Number(r.status == null ? -1 : r.status)
  if (plan.do === 'close') {
    const why = plan.why === 'gave_up' ? 'gave_up' : 'expired'
    Object.assign(st, voiceKeepStop(st, now, why))
    st.callId = ''
    return why
  }
  if (plan.do !== 'open' && plan.do !== 'refresh') return ''
  if (r.ok) {
    if (r.callId) st.callId = String(r.callId)
    st.liveAt = now
    st.fails = 0
    st.lastStatus = 0
    const dropped = !!st.offAt
    st.offAt = 0
    if (plan.do === 'open') st.opens += 1
    else st.refreshes += 1
    st.nextAt = now + o.refreshMs
    if (plan.do === 'refresh') return 'kept'
    return dropped ? 'recovered' : 'opened'
  }
  st.fails = Number(st.fails || 0) + 1
  st.lastStatus = status
  if (GONE_STATUS.has(status)) {
    Object.assign(st, voiceKeepStop(st, now, 'gone'))
    st.callId = ''
    return 'gone'
  }
  // 켜기가 실패하면 그 callId 는 못 쓴다(다음에도 새로 받는다).
  if (plan.do === 'open') st.callId = ''
  else st.offAt = st.offAt || now   // 다시 알리기가 실패했다 → 켜져 있는지부터 다시 세운다
  st.nextAt = now + backoffMs(o, st.fails, status)
  return st.fails >= o.failMax ? 'gave_up' : 'retry'
}

/**
 * 방 메타 푸시(CHGMETA)를 보고 상태를 맞춘다. info = voiceMetaRead(content) + { mine, authorId }
 * 돌려주는 값: '' (볼 것 없음) | seen(켜져 있음) | adopted(남이 연 방을 따라간다) | dropped(꺼졌다, 다시 켠다)
 *              | closed(사람이 껐다 → 유지도 끈다)
 */
export function voiceKeepSaw(st, info, now, opts) {
  const o = opts || normVoiceKeep()
  if (!voiceKeepOn(st) || !info || info.liveon == null) return ''
  if (info.liveon) {
    st.liveAt = now
    st.offAt = 0
    st.fails = 0
    if (st.nextAt < now + o.refreshMs) st.nextAt = now + o.refreshMs
    if (info.callId && String(info.callId) !== st.callId) {
      st.callId = String(info.callId)
      return info.mine ? 'seen' : 'adopted'
    }
    return 'seen'
  }
  // 내가 보낸 끄기 신호의 메아리는 유지가 켜져 있는 동안엔 올 수 없다(끌 때 유지도 끈다).
  // 사람이 끈 것은 따라 끈다 — 방장이 닫은 방을 봇이 다시 여는 싸움을 하지 않는다.
  if (o.yieldToHuman && info.authorId && !info.mine) {
    Object.assign(st, voiceKeepStop(st, now, 'closed'))
    return 'closed'
  }
  st.offAt = now
  st.nextAt = now + o.recoverMs
  return 'dropped'
}

// 17자리 callId(문자열). 숫자로 담으면 정밀도를 잃는다.
export function voiceCallId(now, rnd) {
  const sec = Math.floor(Number(now) / 1000)
  const r = typeof rnd === 'function' ? rnd() : Math.random()
  return '1' + String(sec) + String(Math.floor(r * 1e6)).padStart(6, '0')
}

/**
 * SETMETA(16) 의 content. callId 는 JSON.stringify 를 거치지 않고 문자열로 붙인다(정밀도).
 * on=false 는 liveon 만 보낸다(카카오 클라이언트와 같다).
 */
export function voiceMetaContent(o) {
  const a = o || {}
  if (!a.on) return '{"liveon":false}'
  const sec = Math.floor(Number(a.now || 0) / 1000)
  const start = Math.floor(Number(a.startAt || a.now || 0) / 1000) || sec
  const callId = String(a.callId || '').replace(/[^0-9]/g, '') || voiceCallId(a.now || Date.now())
  return '{"liveon":true,"title":' + JSON.stringify(String(a.title || '보이스룸')) +
    ',"updateTime":' + sec + ',"startTime":' + start +
    ',"csIP":' + JSON.stringify(String(a.csIP || '')) +
    ',"csIP6":' + JSON.stringify(String(a.csIP6 || '')) +
    ',"csPort":' + (Number(a.csPort) || 9000) +
    ',"callId":' + callId +
    ',"url":' + JSON.stringify(String(a.url || '')) + ',"blind":false}'
}

// 받은 content 읽기. callId 는 JSON.parse 가 정밀도를 깎으므로 글자에서 바로 뽑는다.
export function voiceMetaRead(content) {
  const s = String(content == null ? '' : content)
  if (!s) return null
  const out = { liveon: null, callId: '', title: '', startAt: 0, count: null }
  const cid = /"callId"\s*:\s*"?([0-9]+)"?/.exec(s)
  if (cid) out.callId = cid[1]
  const live = /"liveon"\s*:\s*(true|false)/.exec(s)
  if (live) out.liveon = live[1] === 'true'
  let body = null
  try { body = JSON.parse(s) } catch { body = null }
  if (body && typeof body === 'object') {
    if (out.liveon == null && typeof body.liveon === 'boolean') out.liveon = body.liveon
    if (typeof body.title === 'string') out.title = body.title
    if (Number(body.startTime) > 0) out.startAt = Number(body.startTime) * 1000
    if (body.count != null && Number.isFinite(Number(body.count))) out.count = Number(body.count)
  }
  if (out.liveon == null && !out.callId) return null
  return out
}

function spanText(ms) {
  const m = Math.max(0, Math.round(Number(ms) / MIN))
  const h = Math.floor(m / 60)
  const mm = m % 60
  if (h && mm) return `${h}시간 ${mm}분`
  if (h) return `${h}시간`
  return `${mm}분`
}

// 방 안내·로그에 쓰는 한 줄.
export function voiceKeepText(st, now) {
  if (!st || (!st.on && !st.stop)) return '보룸 유지: 꺼짐'
  if (!st.on) {
    const why = {
      user: '사람이 끔', expired: '시간이 다 됨', gave_up: '카카오가 계속 거절해서 포기',
      closed: '방에서 보이스룸을 닫음', gone: '방이 없어짐', off: '꺼짐',
    }[st.stop] || st.stop
    return `보룸 유지: 꺼짐 (${why})`
  }
  const left = spanText(Number(st.until || 0) - now)
  const last = st.liveAt ? `${spanText(now - st.liveAt)} 전 확인` : '아직 확인 전'
  const extra = []
  if (st.opens > 1) extra.push(`다시 켜기 ${st.opens - 1}회`)
  if (st.fails) extra.push(`연속 실패 ${st.fails}회(status ${st.lastStatus})`)
  return `보룸 유지: 켜짐 — 남은 시간 ${left}, ${last}${extra.length ? ', ' + extra.join(', ') : ''}`
}
