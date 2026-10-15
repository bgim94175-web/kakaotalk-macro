import { timingSafeEqual } from 'node:crypto'

import express from 'express'

import { fakeOn, fakeServer, fakeUserId } from './fake.mjs'
import { guardNotices, logsView } from './features.mjs'
import { beginLogin, cancelLogin, confirmLogin } from './register.mjs'
import { isBotId } from './roomfeat.mjs'
import { Hub } from './runner.mjs'
import { assertKey, loadRecord } from './store.mjs'

function senderToken() {
  return String(process.env.SENDER_TOKEN || '').trim()
}

const hub = new Hub()
const app = express()
app.disable('x-powered-by')
app.use(express.json({ limit: '20mb' }))

// 부모만 부른다(127.0.0.1, lib/sender-child.js call). 비교는 timingSafeEqual, 길이가 다르면 바로 거절(3.6·8.5).
function tokenOk(got) {
  const want = Buffer.from(senderToken(), 'utf8')
  const have = Buffer.from(String(got || ''), 'utf8')
  if (!want.length || have.length !== want.length) return false
  return timingSafeEqual(have, want)
}

function auth(req, res, next) {
  if (!tokenOk(req.get('x-sender-token'))) {
    res.status(401).json({ ok: false, error: 'unauthorized' })
    return
  }
  next()
}

// 고객용 경로는 봇 기록(bot.)에 404 — 고객 방 노출 방지 이중 장치, 봇 기록의 features 를 덮지 않게(3.6)
function botAbsent(res, id) {
  if (!isBotId(id)) return false
  res.status(404).json({ ok: false, error: 'not_found' })
  return true
}

function installIdOf(raw) {
  const s = raw == null ? '' : String(raw).trim()
  if (!/^[1-9][0-9]{0,15}$/.test(s)) return null
  return Number(s)
}

function deviceId(raw) {
  const id = raw == null ? '' : String(raw)
  if (!/^[A-Za-z0-9._-]{8,128}$/.test(id)) return null
  return id
}

function hasPassword(body) {
  if (!body || typeof body !== 'object') return false
  if (Object.prototype.hasOwnProperty.call(body, 'password') || Object.prototype.hasOwnProperty.call(body, 'passcode')) {
    return true
  }
  const c = body.credentials
  if (c && typeof c === 'object') {
    if (Object.prototype.hasOwnProperty.call(c, 'password') || Object.prototype.hasOwnProperty.call(c, 'passcode')) return true
  }
  return false
}

app.get('/health', (_req, res) => {
  res.json({ ok: true, service: 'kakao-sender' })
})

app.use('/v1', auth)

app.get('/v1/status', async (req, res) => {
  const id = deviceId(req.query.device_id)
  if (!id) return res.status(400).json({ ok: false, error: 'bad_device' })
  const st = hub.status(id)
  if (st.reason === 'absent') {
    const { loadRecord } = await import('./store.mjs')
    const rec = await loadRecord(id)
    if (!rec) return res.json({ ok: true, linked: false, needs_register: false, reason: 'absent' })
    return res.json({
      ok: true,
      linked: !rec.needs_register && !!(rec.credentials && rec.credentials.access_token),
      needs_register: !!rec.needs_register,
      reason: rec.reason || 'ok',
      notices: guardNotices(rec),
    })
  }
  res.json({ ok: true, ...st })
})

app.post('/v1/session', async (req, res) => {
  if (hasPassword(req.body)) return res.status(400).json({ ok: false, error: 'password_not_stored' })
  const id = deviceId(req.body && req.body.device_id)
  if (!id) return res.status(400).json({ ok: false, error: 'bad_device' })
  if (botAbsent(res, id)) return
  try {
    const st = await hub.upsert(id, req.body || {})
    res.json({ ok: true, ...st })
  } catch (e) {
    res.status(e.status || 500).json({ ok: false, error: e.message || 'failed' })
  }
})

app.post('/v1/config', async (req, res) => {
  if (hasPassword(req.body)) return res.status(400).json({ ok: false, error: 'password_not_stored' })
  const id = deviceId(req.body && req.body.device_id)
  if (!id) return res.status(400).json({ ok: false, error: 'bad_device' })
  if (botAbsent(res, id)) return
  try {
    const st = await hub.updateConfig(id, req.body || {})
    res.json({ ok: true, ...st })
  } catch (e) {
    res.status(e.status || 500).json({ ok: false, error: e.message || 'failed', needs_register: !!e.needs_register })
  }
})

function publicStatus(live, rec) {
  if (live && live.reason !== 'absent') return live
  if (!rec) return { linked: false, needs_register: false, reason: 'absent', connected: false, notices: [] }
  return {
    linked: !rec.needs_register && !!(rec.credentials && rec.credentials.access_token),
    needs_register: !!rec.needs_register,
    reason: rec.reason || 'ok',
    connected: false,
    notices: guardNotices(rec),
  }
}

app.get('/v1/snapshot', async (req, res) => {
  const id = deviceId(req.query.device_id)
  if (!id) return res.status(400).json({ ok: false, error: 'bad_device' })
  if (botAbsent(res, id)) return
  const rec = await loadRecord(id)
  const live = hub.status(id)
  const st = publicStatus(live, rec)
  res.json({
    ok: true,
    ...st,
    config: rec && rec.config ? rec.config : {},
    rooms: rec && Array.isArray(rec.rooms) ? rec.rooms : [],
    features: rec && rec.features ? rec.features : {},
    images: rec && Array.isArray(rec.images) ? rec.images : [],
  })
})

// 관리 화면의 기록 화면. 저장된 기록에서 읽으므로 카카오에 연결되지 않아도 된다.
// 붙어 있는 계정은 메모리의 record 가 가장 새것이라 그것을 먼저 쓴다.
app.get('/v1/logs', async (req, res) => {
  const id = deviceId(req.query.device_id)
  if (!id) return res.status(400).json({ ok: false, error: 'bad_device' })
  if (botAbsent(res, id)) return
  try {
    const live = hub.accounts.get(id)
    const rec = live && live.record ? live.record : await loadRecord(id)
    if (!rec) return res.status(404).json({ ok: false, error: 'absent' })
    res.json({ ok: true, ...logsView(rec) })
  } catch (e) {
    res.status(500).json({ ok: false, error: e && e.message ? e.message : 'failed' })
  }
})

app.post('/v1/register/begin', async (req, res) => {
  const id = deviceId(req.body && req.body.device_id)
  if (!id) return res.status(400).json({ ok: false, error: 'bad_device' })
  const email = req.body && typeof req.body.email === 'string' ? req.body.email : ''
  const password = req.body && typeof req.body.password === 'string' ? req.body.password : ''
  if (!email || !password) return res.status(400).json({ ok: false, error: 'bad_request' })
  try {
    const out = await beginLogin(hub, {
      device_id: id,
      email,
      password,
      forced: !!(req.body && req.body.forced),
    })
    res.json({ ok: true, ...out })
  } catch (e) {
    process.stderr.write(`[sender] register begin failed ${e && e.code ? e.code : ''}\n`)
    res.status(502).json({ ok: false, error: 'kakao_unreachable' })
  }
})

app.post('/v1/register/confirm', async (req, res) => {
  const pendingId = req.body && typeof req.body.pending_id === 'string' ? req.body.pending_id : ''
  if (!pendingId) return res.status(400).json({ ok: false, error: 'bad_request' })
  try {
    const out = await confirmLogin(hub, { pending_id: pendingId })
    res.json({ ok: true, ...out })
  } catch (e) {
    process.stderr.write(`[sender] register confirm failed ${e && e.code ? e.code : ''}\n`)
    res.status(502).json({ ok: false, error: 'kakao_unreachable' })
  }
})

app.post('/v1/register/cancel', async (req, res) => {
  cancelLogin(req.body && req.body.pending_id)
  res.json({ ok: true })
})

app.post('/v1/unlink', async (req, res) => {
  const id = deviceId(req.body && req.body.device_id)
  if (!id) return res.status(400).json({ ok: false, error: 'bad_device' })
  await hub.unlink(id)
  res.json({ ok: true, linked: false, needs_register: false, reason: 'unlinked' })
})

app.get('/v1/chats', async (req, res) => {
  const id = deviceId(req.query.device_id)
  if (!id) return res.status(400).json({ ok: false, error: 'bad_device' })
  if (botAbsent(res, id)) return
  try {
    const chats = await hub.chats(id)
    res.json({ ok: true, chats })
  } catch (e) {
    res.status(e.status || 500).json({
      ok: false,
      error: e.message || 'failed',
      needs_register: !!e.needs_register,
    })
  }
})

app.get('/v1/recent', async (req, res) => {
  const id = deviceId(req.query.device_id)
  const chatId = req.query && String(req.query.chat_id || '')
  if (!id || !/^[1-9][0-9]*$/.test(chatId)) {
    return res.status(400).json({ ok: false, error: 'bad_request' })
  }
  if (botAbsent(res, id)) return
  try {
    const messages = await hub.recent(id, chatId)
    res.json({ ok: true, messages })
  } catch (e) {
    res.status(e.status || 500).json({
      ok: false,
      error: e.message || 'failed',
      needs_register: !!e.needs_register,
    })
  }
})

app.get('/v1/inbox', async (req, res) => {
  const id = deviceId(req.query.device_id)
  if (!id) return res.status(400).json({ ok: false, error: 'bad_device' })
  if (botAbsent(res, id)) return
  try {
    const chats = await hub.inbox(id)
    res.json({ ok: true, chats })
  } catch (e) {
    res.status(e.status || 500).json({
      ok: false,
      error: e.message || 'failed',
      needs_register: !!e.needs_register,
    })
  }
})

app.get('/v1/thread', async (req, res) => {
  const id = deviceId(req.query.device_id)
  const chatId = req.query && String(req.query.chat_id || '')
  if (!id || !/^[1-9][0-9]*$/.test(chatId)) {
    return res.status(400).json({ ok: false, error: 'bad_request' })
  }
  if (botAbsent(res, id)) return
  try {
    const messages = await hub.thread(id, chatId)
    res.json({ ok: true, messages })
  } catch (e) {
    res.status(e.status || 500).json({
      ok: false,
      error: e.message || 'failed',
      needs_register: !!e.needs_register,
    })
  }
})

app.post('/v1/send', async (req, res) => {
  const id = deviceId(req.body && req.body.device_id)
  const chatId = req.body && String(req.body.chat_id || '')
  const text = req.body && String(req.body.text || '')
  if (!id || !/^[1-9][0-9]*$/.test(chatId) || !text) {
    return res.status(400).json({ ok: false, error: 'bad_request' })
  }
  if (botAbsent(res, id)) return
  try {
    const r = await hub.sendText(id, chatId, text)
    res.json({ ok: true, ...r })
  } catch (e) {
    res.status(e.status || 500).json({ ok: false, error: e.message || 'failed', needs_register: !!e.needs_register })
  }
})

app.post('/v1/send-images', async (req, res) => {
  const id = deviceId(req.body && req.body.device_id)
  const chatId = req.body && String(req.body.chat_id || '')
  const images = req.body && Array.isArray(req.body.images) ? req.body.images : []
  if (!id || !/^[1-9][0-9]*$/.test(chatId) || images.length < 1 || images.length > 5) {
    return res.status(400).json({ ok: false, error: 'bad_request' })
  }
  if (botAbsent(res, id)) return
  const bufs = []
  for (const item of images) {
    const b64 = typeof item === 'string' ? item : item && item.b64
    if (!b64) return res.status(400).json({ ok: false, error: 'bad_image' })
    const buf = Buffer.from(b64, 'base64')
    if (buf.length === 0 || buf.length > 20 * 1024 * 1024) {
      return res.status(400).json({ ok: false, error: 'bad_image' })
    }
    bufs.push(buf)
  }
  try {
    const r = await hub.sendImages(id, chatId, bufs)
    res.json({ ok: true, ...r })
  } catch (e) {
    res.status(e.status || 500).json({ ok: false, error: e.message || 'failed', needs_register: !!e.needs_register })
  }
})

// ── 권리(5.1·3.6) ──────────────────────────────────────────────────────────
app.post('/v1/grants', async (req, res) => {
  const b = req.body && typeof req.body === 'object' ? req.body : {}
  const grants = b.grants && typeof b.grants === 'object' && !Array.isArray(b.grants) ? b.grants : null
  if (!grants) return res.status(400).json({ ok: false, error: 'bad_request' })
  try {
    const out = await hub.applyGrants(grants, { full: b.full === true, asOf: Number(b.as_of) || 0 })
    res.json({ ok: true, applied: out.applied, stopped: out.stopped })
  } catch (e) {
    process.stderr.write(`[sender] grants failed: ${e && e.message ? e.message : e}\n`)
    res.status(500).json({ ok: false, error: 'failed' })
  }
})

// ── K bot 계정(3.6) ────────────────────────────────────────────────────────
function botRoute(fn) {
  return async (req, res) => {
    try {
      const out = await fn(req, res)
      if (out && !res.headersSent) res.json(out)
    } catch (e) {
      process.stderr.write(`[sender] ${req.method} ${req.path} failed: ${e && e.message ? e.message : e}\n`)
      if (!res.headersSent) res.status(500).json({ ok: false, error: 'failed' })
    }
  }
}

function needInstall(res, raw) {
  const id = installIdOf(raw)
  if (!id) res.status(400).json({ ok: false, error: 'bad_install' })
  return id
}

app.post('/v1/bot/resolve', botRoute(async (req, res) => {
  const url = req.body && typeof req.body.url === 'string' ? req.body.url.trim() : ''
  if (!/^https:\/\/open\.kakao\.com\/o\/[A-Za-z0-9]+$/.test(url)) {
    res.status(400).json({ ok: false, error: 'bad_url' })
    return null
  }
  return hub.pool.resolve(url)
}))

app.post('/v1/bot/sync', botRoute(async (req) => {
  const raw = req.body && req.body.install_id
  const id = raw == null || raw === '' ? null : installIdOf(raw)
  await hub.pool.reconcile(id)
  return { ok: true }
}))

app.get('/v1/bot/status', botRoute(async () => hub.pool.botStatus()))

app.get('/v1/bot/room', botRoute(async (req, res) => {
  const id = needInstall(res, req.query.install_id)
  return id ? hub.pool.room(id) : null
}))

app.get('/v1/bot/logs', botRoute(async (req, res) => {
  const id = needInstall(res, req.query.install_id)
  return id ? hub.pool.logs(id) : null
}))

app.get('/v1/bot/people', botRoute(async (req, res) => {
  const id = needInstall(res, req.query.install_id)
  return id ? hub.pool.people(id) : null
}))

app.post('/v1/bot/hide', botRoute(async (req, res) => {
  const id = needInstall(res, req.body && req.body.install_id)
  return id ? hub.pool.hide(id, req.body) : null
}))

app.get('/v1/bot/hide', botRoute(async (req) => hub.pool.hideStatus(req.query.job, req.query.install_id)))

app.post('/v1/bot/unkick', botRoute(async (req, res) => {
  const id = needInstall(res, req.body && req.body.install_id)
  return id ? hub.pool.unkick(id, req.body && req.body.user_id) : null
}))

app.post('/v1/bot/games-reset', botRoute(async (req, res) => {
  const id = needInstall(res, req.body && req.body.install_id)
  return id ? hub.pool.gamesReset(id) : null
}))

// 오픈프로필(D12): 관리자가 고른 것 반영 · 다시 읽기(refresh) · 링크로 확인(url, 조회 예산)
app.post('/v1/bot/open-profile', botRoute(async (req, res) => {
  const b = req.body || {}
  const id = deviceId(b.device_id)
  if (!id || !isBotId(id)) {
    res.status(400).json({ ok: false, error: 'bad_device' })
    return null
  }
  const url = typeof b.url === 'string' ? b.url.trim() : ''
  return hub.pool.openProfileCmd(id, { refresh: b.refresh === true, url })
}))

// 들어가 있는 방의 프로필 바꾸기: how 'switch'(UPLINKPROF, 나가지 않음) | 'rejoin'(나갔다가 오픈프로필로 다시 입장)
app.post('/v1/bot/room-profile', botRoute(async (req, res) => {
  const b = req.body || {}
  const id = needInstall(res, b.install_id)
  if (!id) return null
  const how = b.how === 'rejoin' ? 'rejoin' : 'switch'
  return hub.pool.roomProfileCmd(id, how)
}))

// ── 보이스룸 실험 전용(A층). SENDER_VOICE_EXPERIMENT=1 일 때만 등록한다 ──────────
// POST /v1/bot/voice-experiment { install_id | chat_id | li, on? }
//   on 기본 true(켜기), false 면 끄기. 방은 세 값 중 아무 것으로나 고른다(캡처 로그 값 그대로 OK).
// 봇이 그 방에 SETMETA(16) liveon 신호만 보낸다(서버 할당·음성세션 없음). 결과는 로그로 본다.
if (process.env.SENDER_VOICE_EXPERIMENT === '1') {
  process.stderr.write('[sender] SENDER_VOICE_EXPERIMENT=1 — voice room signal experiment enabled\n')
  app.post('/v1/bot/voice-experiment', botRoute(async (req, res) => {
    const b = req.body || {}
    const sel = { install_id: b.install_id, chat_id: b.chat_id, li: b.li }
    if ((sel.install_id == null || sel.install_id === '') && !sel.chat_id && !sel.li) {
      res.status(400).json({ ok: false, error: 'need_room' })
      return null
    }
    const on = !(b.on === false)
    return hub.pool.voiceExperiment(sel, on)
  }))
}

// ── 가짜 모드 전용(9.4). SENDER_FAKE=1 일 때만 등록한다(8.5) ───────────────────
if (fakeOn()) {
  process.stderr.write('[sender] SENDER_FAKE=1 — fake Kakao connection, never use in production\n')
  async function fakeTarget(installId) {
    const got = await hub.pool.viewOrRow(installId)
    if (!got) return null
    const botId = got.slot ? got.slot.id : (got.row && got.row.bot_device_id)
    const slot = botId ? hub.pool.slotOf(botId) : null
    const chatId = got.view.chat_id || (got.row && got.row.chat_id) || ''
    return { chatId, botUser: slot ? slot.userId : '', slot }
  }

  app.post('/v1/fake/perm', botRoute(async (req, res) => {
    const id = needInstall(res, req.body && req.body.install_id)
    if (!id) return null
    const t = await fakeTarget(id)
    if (!t || !t.chatId || !t.botUser) return { ok: false, error: 'not_joined' }
    return fakeServer().setPerm(t.chatId, t.botUser, Number(req.body.perm) || 0, !!req.body.drop_olu)
  }))

  app.post('/v1/fake/event', botRoute(async (req, res) => {
    const b = req.body || {}
    const id = needInstall(res, b.install_id)
    if (!id) return null
    const t = await fakeTarget(id)
    if (!t || !t.botUser) return { ok: false, error: 'not_joined' }
    if (!t.chatId && b.kind !== 'kickout') return { ok: false, error: 'not_joined' }
    return fakeServer().event(t.chatId, t.botUser, b)
  }))

  // 시험 확인용: 그 방에 봇이 보낸 글, 최근 패킷
  app.get('/v1/fake/sent', botRoute(async (req, res) => {
    const id = needInstall(res, req.query.install_id)
    if (!id) return null
    const t = await fakeTarget(id)
    return { ok: true, sent: t && t.chatId ? fakeServer().sentIn(t.chatId) : [] }
  }))

  app.get('/v1/fake/packets', botRoute(async () => ({ ok: true, packets: fakeServer().packets.slice(-500) })))

  // 봇 계정의 오픈프로필 바꾸기: {device_id | user_id, profiles:[{name, li?, url?}], fail?:true(SYNCLINK 실패)}
  app.post('/v1/fake/profiles', botRoute(async (req, res) => {
    const b = req.body || {}
    const dev = deviceId(b.device_id)
    const uid = dev ? fakeUserId(dev) : String(b.user_id || '')
    if (!/^[1-9][0-9]*$/.test(uid)) {
      res.status(400).json({ ok: false, error: 'bad_user' })
      return null
    }
    return fakeServer().setProfiles(uid, Array.isArray(b.profiles) ? b.profiles : null, b.fail)
  }))

  app.get('/v1/fake/room', botRoute(async (req, res) => {
    const id = needInstall(res, req.query.install_id)
    if (!id) return null
    const t = await fakeTarget(id)
    const r = t && t.chatId ? fakeServer().roomByChat(t.chatId) : null
    return { ok: true, room: r ? { code: r.code, li: r.li, chat_id: r.chatId, members: r.members, kicked: r.kicked, bans: r.bans, hidden: r.hidden.length } : null }
  }))
}

// 멈출 때 방별 실행 상태(room_state)를 한 번 더 저장한다(5.7). 새 메시지를 받지 않게 한 뒤, 진행 중인 저장을 기다리고
// 방마다 동시에 저장하고(pool.finalFlush), 끝나면 바로 나간다. DB 가 멈춰 있어도 정해진 시간(ms)이 지나면 나간다.
// 저장 전에 나가면 방에 이미 보인 결과(강화·거래)가 다음 시작 때 되돌아간다. 부모(lib/sender-child.js)는 이 프로세스가 끝나기를
// 이 시간보다 조금 더 기다린다.
let closing = false
function finalSave(code, ms) {
  if (closing) return
  closing = true
  const t = setTimeout(() => process.exit(code), ms)
  hub.pool.finalFlush().catch(() => {}).finally(() => {
    clearTimeout(t)
    process.exit(code)
  })
}
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => finalSave(0, 5000))

// 예기치 못한 오류로 끝날 때도 마지막 저장을 짧게(1.5초) 해 본다(이미 멈추는 중이면 그 저장을 마저 기다린다)
process.on('uncaughtException', (e) => {
  process.stderr.write(`[sender] uncaughtException ${e && e.stack ? e.stack : e}\n`)
  finalSave(1, 1500)
})
process.on('unhandledRejection', (e) => {
  process.stderr.write(`[sender] unhandledRejection ${e && e.stack ? e.stack : e}\n`)
  finalSave(1, 1500)
})

export async function createApp() {
  if (!senderToken()) throw new Error('SENDER_TOKEN is required')
  assertKey()
  try {
    await hub.boot()
  } catch (e) {
    process.stderr.write(`[sender] session restore skipped: ${e && e.message ? e.message : e}\n`)
  }
  return app
}
