// KakaoAuto on-device engine.
//
// Runs inside the app on the embedded Node runtime (nodejs-mobile, Node 18) and drives
// KakaoTalk through agent-messenger's kakaotalk module. The Java side (engine/NodeHost.java)
// owns this process and talks to it over stdin/stdout, one JSON object per line:
//
//   Java → engine   {"id":7,"m":"send.images","p":{...}}
//   engine → Java   {"id":7,"ok":true,"r":{...}}  |  {"id":7,"ok":false,"e":{"code":"...","message":"...","retryable":false}}
//   engine → Java   {"ev":"credentials","d":{...}}   (unsolicited events have no id)
//
// Pipes instead of a TCP port: nothing is reachable by other apps on the device.
// Secrets (password, tokens) live in memory only; they are never written to disk or stderr.
// Tokens are persisted by the Java side, encrypted with AndroidKeyStore.

import { webcrypto, randomBytes } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { createInterface } from 'node:readline'

import {
  KakaoTalkClient,
  attemptLogin,
  classifyKakaoChat,
  generateDeviceUuid,
  refreshKakaoOAuthToken,
  registerDevice,
  requestPasscode,
} from 'agent-messenger/kakaotalk'

// agent-messenger targets Node >= 22 and hashes uploads with the global WebCrypto object,
// which Node 18 only exposes as require('crypto').webcrypto.
if (!globalThis.crypto) globalThis.crypto = webcrypto

const ENGINE_VERSION = '1.0.0'
const LIB = 'agent-messenger@2.38.0'
const MAX_IMAGES = 5
const MAX_IMAGE_BYTES = 20 * 1024 * 1024
const PENDING_TTL_MS = 15 * 60 * 1000
const DEFAULT_IDLE_MS = 50 * 60 * 1000

const stdout = process.stdout
const toStderr = (...a) => process.stderr.write(a.map(String).join(' ') + '\n')
// Anything the library prints must not corrupt the protocol stream.
console.log = console.info = console.debug = console.warn = toStderr

function emit(obj) {
  stdout.write(JSON.stringify(obj) + '\n')
}

class EngineError extends Error {
  constructor(code, message, { retryable = false, serverStatus } = {}) {
    super(message || code)
    this.code = code
    this.retryable = retryable
    this.serverStatus = serverStatus
  }
}

const NETWORK_CODES = new Set(['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', 'EPIPE', 'ENETUNREACH', 'EHOSTUNREACH'])

function toWireError(e) {
  if (e instanceof EngineError) {
    return { code: e.code, message: clip(e.message), retryable: e.retryable, server_status: e.serverStatus ?? null }
  }
  const sys = e && (e.code || (e.cause && e.cause.code))
  if (typeof sys === 'string' && NETWORK_CODES.has(sys)) {
    return { code: 'network', message: clip(String(e.message || sys)), retryable: true, server_status: null }
  }
  const code = e && typeof e.code === 'string' ? e.code : 'upstream_error'
  return {
    code,
    message: clip(String((e && e.message) || e)),
    retryable: code === 'upstream_error' || code === 'network',
    server_status: e && typeof e.serverStatus === 'number' ? e.serverStatus : null,
  }
}

function clip(s) {
  return s.length > 300 ? s.slice(0, 300) + '…' : s
}

function need(p, key) {
  const v = p[key]
  if (typeof v !== 'string' || v.length === 0) throw new EngineError('bad_request', `missing ${key}`)
  return v
}

// ── account login (id/pw once + confirm the code on the phone) ─────────────

const pendingLogins = new Map()

function dropPendingLater(id) {
  setTimeout(() => pendingLogins.delete(id), PENDING_TTL_MS).unref()
}

function loginOk(r, deviceUuid) {
  return { state: 'ok', credentials: { ...r.credentials, device_uuid: deviceUuid } }
}

async function authBegin(p) {
  const email = need(p, 'email')
  const password = need(p, 'password')
  const deviceUuid = typeof p.device_uuid === 'string' && p.device_uuid ? p.device_uuid : generateDeviceUuid()
  const deviceType = p.device_type === 'pc' ? 'pc' : 'tablet'
  const forced = p.forced === true

  const r = await attemptLogin(email, password, deviceUuid, deviceType, forced)
  if (r.authenticated && r.credentials) return loginOk(r, deviceUuid)

  if (r.next_action === 'provide_passcode') {
    const pc = await requestPasscode(email, password, deviceUuid)
    if (!pc.passcode) {
      return { state: 'failed', code: pc.error || 'passcode_request_failed', message: pc.message || '' }
    }
    const pendingId = randomBytes(12).toString('hex')
    pendingLogins.set(pendingId, { email, password, deviceUuid, deviceType, forced })
    dropPendingLater(pendingId)
    return {
      state: 'confirm_on_phone',
      pending_id: pendingId,
      passcode: pc.passcode,
      remaining_seconds: typeof pc.remaining_seconds === 'number' ? pc.remaining_seconds : null,
      device_uuid: deviceUuid,
    }
  }

  if (r.error === 'bad_credentials') return { state: 'bad_credentials', message: r.message || '' }
  if (r.error === 'login_failed' && !forced) return { state: 'slot_occupied', message: r.message || '' }
  return { state: 'failed', code: r.error || 'login_failed', message: r.message || '' }
}

// Waits (up to ~a minute) for the user to confirm the code in KakaoTalk on the phone.
// "waiting" means: not confirmed yet, call again while the code is still valid.
async function authConfirm(p) {
  const id = need(p, 'pending_id')
  const pl = pendingLogins.get(id)
  if (!pl) return { state: 'expired' }

  const reg = await registerDevice(pl.email, pl.password, '', pl.deviceUuid)
  if (reg.error === 'registration_timeout') return { state: 'waiting' }
  if (reg.error) {
    pendingLogins.delete(id)
    return { state: 'failed', code: reg.error, message: reg.message || '' }
  }

  const r = await attemptLogin(pl.email, pl.password, pl.deviceUuid, pl.deviceType, pl.forced)
  pendingLogins.delete(id)
  if (r.authenticated && r.credentials) return loginOk(r, pl.deviceUuid)
  return { state: 'failed', code: r.error || 'login_failed', message: r.message || '' }
}

function authCancel(p) {
  if (typeof p.pending_id === 'string') pendingLogins.delete(p.pending_id)
  return {}
}

// ── LOCO session ────────────────────────────────────────────────────────────

let creds = null
let client = null
let kicked = false
let idleMs = DEFAULT_IDLE_MS
let idleTimer = null

function normalizeCreds(c) {
  if (!c || typeof c !== 'object') throw new EngineError('bad_request', 'missing credentials')
  const out = {
    access_token: String(c.access_token || ''),
    refresh_token: String(c.refresh_token || ''),
    user_id: String(c.user_id || ''),
    device_uuid: String(c.device_uuid || ''),
    device_type: c.device_type === 'pc' ? 'pc' : 'tablet',
  }
  if (!out.access_token || !out.user_id || !out.device_uuid) throw new EngineError('bad_request', 'incomplete credentials')
  return out
}

function closeClient() {
  if (idleTimer) clearTimeout(idleTimer)
  idleTimer = null
  if (client) {
    try {
      client.close()
    } catch {}
  }
  client = null
}

async function ensureClient() {
  if (!creds) throw new EngineError('not_linked', 'no Kakao account linked')
  if (kicked) throw new EngineError('kicked', 'another device took this session slot')
  if (client) return client
  const c = new KakaoTalkClient()
  await c.login({
    oauthToken: creds.access_token,
    userId: creds.user_id,
    deviceUuid: creds.device_uuid,
    deviceType: creds.device_type,
  })
  c.onSessionEvent((ev) => {
    if (client !== c) return
    if (ev.type === 'kicked') {
      // Never fight for the slot automatically; the user decides in the app.
      kicked = true
      closeClient()
    }
    emit({ ev: 'session', d: { type: ev.type } })
  })
  client = c
  return c
}

function touchIdle() {
  if (idleTimer) clearTimeout(idleTimer)
  idleTimer = setTimeout(() => {
    idleTimer = null
    if (client) {
      closeClient()
      emit({ ev: 'session', d: { type: 'idle_closed' } })
    }
  }, idleMs)
  idleTimer.unref()
}

async function refreshTokens() {
  if (!creds.refresh_token) throw new EngineError('reauth_required', 'no refresh token')
  let r
  try {
    r = await refreshKakaoOAuthToken({
      accessToken: creds.access_token,
      refreshToken: creds.refresh_token,
      deviceUuid: creds.device_uuid,
    })
  } catch (e) {
    const code = e && e.code
    if (code === 'refresh_rejected' || code === 'refresh_credentials_missing') {
      throw new EngineError('reauth_required', 'Kakao rejected the saved login; sign in again', { serverStatus: e.serverStatus })
    }
    throw new EngineError('upstream_error', `token refresh failed (${code || 'unknown'})`, { retryable: true })
  }
  creds = { ...creds, access_token: r.accessToken, refresh_token: r.refreshToken || creds.refresh_token }
  emit({ ev: 'credentials', d: creds })
  closeClient()
}

// Runs op(client); on an expired access token refreshes once and retries.
async function withSession(op) {
  let c = await ensureClient()
  touchIdle()
  try {
    return await op(c)
  } catch (e) {
    if (!(e && e.code === 'invalid_access_token')) throw e
    await refreshTokens()
    c = await ensureClient()
    return await op(c)
  }
}

async function sessionOpen(p) {
  closeClient()
  creds = normalizeCreds(p.credentials)
  kicked = false
  if (typeof p.idle_ms === 'number' && p.idle_ms >= 60000) idleMs = p.idle_ms
  if (p.connect === false) return { user_id: creds.user_id, connected: false }
  await withSession((c) => c.acquireSession())
  return { user_id: creds.user_id, connected: true }
}

function sessionClose() {
  closeClient()
  creds = null
  kicked = false
  return {}
}

function status() {
  return {
    linked: creds !== null,
    connected: client !== null && client.isConnected(),
    kicked,
    user_id: creds ? creds.user_id : null,
  }
}

// ── rooms ───────────────────────────────────────────────────────────────────

function wireChat(ch) {
  // chat_id must stay a decimal string. A JSON number above 2^53 drops bits and
  // the photo is then shipped to the wrong room.
  const chatId = typeof ch.chat_id === 'string' ? ch.chat_id : realLogId(ch.chat_id)
  return {
    chat_id: chatId,
    kind: classifyKakaoChat(ch),
    type: ch.type,
    title: ch.title || null,
    display_name: ch.display_name || null,
    members: ch.active_members,
    last_at: ch.last_message ? ch.last_message.sent_at : 0,
  }
}

async function chatsList(p) {
  const chats = await withSession(async (c) => {
    try {
      return await c.getChats({ all: true, resolveTitles: p.resolve_titles === true })
    } catch (e) {
      if (e && e.code === 'invalid_access_token') throw e
      // A partial list is still useful for picking rooms.
      return await c.getChats({ resolveTitles: p.resolve_titles === true })
    }
  })
  return { chats: chats.map(wireChat) }
}

function cmpLog(a, b) {
  try {
    const x = BigInt(a)
    const y = BigInt(b)
    return x < y ? -1 : x > y ? 1 : 0
  } catch {
    return a < b ? -1 : a > b ? 1 : 0
  }
}

// Newer messages in one linked room. The app polls this instead of reading notifications.
// since_log_id is exclusive. author ids stay strings so values above 2^53 are not rounded.
async function chatRecent(p) {
  const chatId = needChatId(p)
  const since = typeof p.since_log_id === 'string' ? p.since_log_id : ''
  const count = Math.max(5, Math.min(40, Number(p.count) || 20))
  const msgs = await withSession((c) => c.getMessages(chatId, { count }))
  const self = creds ? String(creds.user_id) : ''
  const out = []
  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i]
    const logId = realLogId(m && m.log_id)
    if (!logId) continue
    if (since && cmpLog(logId, since) <= 0) continue
    const authorId = m.author_id == null ? '' : String(m.author_id)
    out.push({
      log_id: logId,
      author_id: authorId,
      author_name: m.author_name || '',
      message: typeof m.message === 'string' ? m.message : '',
      sent_at: m.sent_at || 0,
      mine: self.length > 0 && authorId === self,
    })
  }
  out.sort((a, b) => cmpLog(a.log_id, b.log_id))
  return { messages: out }
}

// How many messages from other people arrived after our own last message
// (the macro's "only post again after N new messages" rule).
async function chatActivity(p) {
  const chatId = need(p, 'chat_id')
  const count = Math.max(5, Math.min(80, Number(p.count) || 30))
  const msgs = await withSession((c) => c.getMessages(chatId, { count }))
  const self = Number(creds.user_id)
  const ordered = [...msgs].sort((a, b) => {
    const x = BigInt(a.log_id)
    const y = BigInt(b.log_id)
    return x < y ? -1 : x > y ? 1 : 0
  })
  let others = 0
  let lastMineAt = 0
  for (let i = ordered.length - 1; i >= 0; i--) {
    const m = ordered[i]
    if (m.author_id === self) {
      lastMineAt = m.sent_at
      break
    }
    others++
  }
  return {
    others_since_mine: others,
    mine_in_window: lastMineAt !== 0,
    last_mine_at: lastMineAt,
    newest_at: ordered.length ? ordered[ordered.length - 1].sent_at : 0,
  }
}

// ── sending ─────────────────────────────────────────────────────────────────

// A delivered Kakao message has a positive decimal log id. agent-messenger turns a
// missing id into the string "0" (longToString(undefined)) and still sets success
// when POST/FORWARD status is 0 or a COMPLETE packet arrived without a chatLog.
// That is a local upload ack, not a message in the room.
function realLogId(v) {
  if (typeof v === 'bigint') v = v.toString()
  else if (v && typeof v === 'object' && 'high' in v && 'low' in v) {
    const high = v.high >>> 0
    const low = v.low >>> 0
    v = ((BigInt(high) << 32n) | BigInt(low)).toString()
  } else if (typeof v === 'number' && Number.isFinite(v)) {
    if (v !== Math.trunc(v)) return ''
    v = String(v)
  }
  if (typeof v !== 'string') return ''
  const s = v.trim()
  if (!/^[1-9][0-9]*$/.test(s)) return ''
  return s
}

function sendOutcome(res, kind) {
  const raw = res && res.log_id != null ? String(res.log_id) : ''
  const logId = realLogId(res && res.log_id)
  const status = res && res.status_code != null ? res.status_code : '?'
  const accepted = !!(res && res.success === true)
  if (!res || !accepted || !logId) {
    const why = !res
      ? 'empty Kakao response'
      : !accepted
        ? `Kakao rejected the image (status ${status}, log_id ${raw || 'none'})`
        : `Kakao returned no message id (status ${status}, log_id ${raw || 'none'})`
    throw new EngineError('undelivered', why, {
      serverStatus: typeof (res && res.status_code) === 'number' ? res.status_code : undefined,
    })
  }
  return { kind, log_id: logId, sent_at: res.sent_at, status_code: res.status_code }
}

async function sendText(p) {
  const chatId = needChatId(p)
  const text = need(p, 'text')
  const res = await withSession((c) => c.sendMessage(chatId, text))
  return sendOutcome(res, 'text')
}

function needChatId(p) {
  const chatId = need(p, 'chat_id')
  if (!/^[1-9][0-9]*$/.test(chatId)) throw new EngineError('bad_request', `invalid chat id ${chatId}`)
  return chatId
}

async function sendImages(p) {
  const chatId = needChatId(p)
  const paths = Array.isArray(p.paths) ? p.paths.filter((x) => typeof x === 'string' && x) : []
  if (paths.length < 1 || paths.length > MAX_IMAGES) {
    throw new EngineError('bad_request', `need 1-${MAX_IMAGES} images, got ${paths.length}`)
  }
  const photos = []
  for (let i = 0; i < paths.length; i++) {
    const data = await readFile(paths[i])
    if (data.byteLength === 0 || data.byteLength > MAX_IMAGE_BYTES) {
      throw new EngineError('bad_request', `image ${i + 1} is empty or larger than 20 MB`)
    }
    // ImagePrep always writes JPEG. The library routes on the filename extension
    // (sendPhoto vs sendMultiPhoto) and reads width/height from the bytes.
    photos.push({ data, filename: `photo-${i + 1}.jpg` })
  }
  // Open the LOCO session first so a login/check-in failure is reported as itself,
  // not as a missing photo message id. sendPhoto / sendMultiPhoto then run the
  // library upload (SHIP+POST+COMPLETE, or MSHIP+MPOST+FORWARD). No local WRITE.
  if (photos.length === 1) {
    const res = await withSession(async (c) => {
      await c.acquireSession()
      return c.sendPhoto(chatId, photos[0].data, photos[0].filename)
    })
    return sendOutcome(res, 'photo')
  }
  const res = await withSession(async (c) => {
    await c.acquireSession()
    return c.sendMultiPhoto(chatId, photos)
  })
  return sendOutcome(res, 'multiphoto')
}

// ── dispatch ────────────────────────────────────────────────────────────────

function ping() {
  return { engine: ENGINE_VERSION, lib: LIB, node: process.version, arch: process.arch }
}

const handlers = {
  ping,
  status,
  'auth.begin': authBegin,
  'auth.confirm': authConfirm,
  'auth.cancel': authCancel,
  'session.open': sessionOpen,
  'session.close': sessionClose,
  'chats.list': chatsList,
  'chat.activity': chatActivity,
  'chat.recent': chatRecent,
  'send.text': sendText,
  'send.images': sendImages,
}

async function handle(line) {
  let msg
  try {
    msg = JSON.parse(line)
  } catch {
    return
  }
  if (!msg || typeof msg !== 'object') return
  const { id, m } = msg
  const h = handlers[m]
  if (!h) {
    emit({ id, ok: false, e: { code: 'unknown_method', message: String(m), retryable: false } })
    return
  }
  try {
    const r = await h(msg.p && typeof msg.p === 'object' ? msg.p : {})
    emit({ id, ok: true, r: r ?? {} })
  } catch (e) {
    emit({ id, ok: false, e: toWireError(e) })
  }
}

process.on('uncaughtException', (e) => toStderr('uncaught:', e && e.stack ? e.stack : e))
process.on('unhandledRejection', (e) => toStderr('unhandled:', e && e.stack ? e.stack : e))

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity })
rl.on('line', (line) => {
  handle(line)
})
rl.on('close', () => {
  closeClient()
  process.exit(0)
})

emit({ ev: 'ready', d: ping() })
