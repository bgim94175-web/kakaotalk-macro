import express from 'express'

import { guardNotices } from './features.mjs'
import { beginLogin, cancelLogin, confirmLogin } from './register.mjs'
import { Hub } from './runner.mjs'
import { assertKey, loadRecord } from './store.mjs'

function senderToken() {
  return String(process.env.SENDER_TOKEN || '').trim()
}

const hub = new Hub()
const app = express()
app.disable('x-powered-by')
app.use(express.json({ limit: '20mb' }))

function auth(req, res, next) {
  const got = req.get('x-sender-token') || ''
  if (got !== senderToken()) {
    res.status(401).json({ ok: false, error: 'unauthorized' })
    return
  }
  next()
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

app.post('/v1/send', async (req, res) => {
  const id = deviceId(req.body && req.body.device_id)
  const chatId = req.body && String(req.body.chat_id || '')
  const text = req.body && String(req.body.text || '')
  if (!id || !/^[1-9][0-9]*$/.test(chatId) || !text) {
    return res.status(400).json({ ok: false, error: 'bad_request' })
  }
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

process.on('uncaughtException', (e) => {
  process.stderr.write(`[sender] uncaughtException ${e && e.stack ? e.stack : e}\n`)
  process.exit(1)
})
process.on('unhandledRejection', (e) => {
  process.stderr.write(`[sender] unhandledRejection ${e && e.stack ? e.stack : e}\n`)
  process.exit(1)
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
