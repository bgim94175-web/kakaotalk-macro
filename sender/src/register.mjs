import { randomBytes } from 'node:crypto'

import {
  attemptLogin,
  generateDeviceUuid,
  registerDevice,
  requestPasscode,
} from 'agent-messenger/kakaotalk'

import { fakeBegin, fakeCancel, fakeConfirm, fakeOn } from './fake.mjs'
import { isBotId } from './roomfeat.mjs'
import { dbStore, loadRecord } from './store.mjs'

// 안드로이드 엔진과 같은 등록이다. 비밀번호는 이 맵에만 있고, 성공·만료·취소 때 지운다.
// 저장소와 로그에는 넣지 않는다. SM-T870 은 라이브러리 기본값이라 보내지 않는다.
const TABLETS = [
  ['Galaxy Tab S9', 'SM-X710'],
  ['Galaxy Tab S9 FE', 'SM-X510'],
  ['Galaxy Tab S8', 'SM-X700'],
  ['Galaxy Tab A9+', 'SM-X210'],
  ['Galaxy Tab S7 FE', 'SM-T733'],
  ['Galaxy Tab S6 Lite', 'SM-P610'],
  ['Lenovo Tab P11', 'TB-J606F'],
  ['Xiaomi Pad 6', '23043RP34G'],
]
const PENDING_TTL_MS = 15 * 60 * 1000
const pending = new Map()

function pickTablet() {
  const row = TABLETS[randomBytes(1)[0] % TABLETS.length]
  return { name: row[0], model: row[1] }
}

export function failBody(code, message, status, tablet) {
  const out = { state: 'failed', code: code || 'login_failed', message: message || '' }
  let n = typeof status === 'number' && !Number.isNaN(status) ? status : null
  if (n == null) {
    const hit = String(message || '').match(/status (-?\d+)/)
    if (hit) n = Number(hit[1])
  }
  if (n != null && !Number.isNaN(n)) {
    out.status = n
    out.server_status = n
  }
  if (tablet && tablet.name) {
    out.device_name = tablet.name
    out.device_model = tablet.model || ''
  }
  return out
}

function withStatus(state, message, status, tablet) {
  const out = failBody('', message, status, tablet)
  out.state = state
  delete out.code
  return out
}

function statusOf(result) {
  if (!result) return null
  if (typeof result.status === 'number') return result.status
  if (typeof result.server_status === 'number') return result.server_status
  return null
}

function loginOk(result, deviceUuid) {
  const c = result.credentials || {}
  return {
    state: 'ok',
    credentials: {
      access_token: String(c.access_token || ''),
      refresh_token: String(c.refresh_token || ''),
      user_id: String(c.user_id || ''),
      device_uuid: deviceUuid,
      device_type: 'tablet',
    },
  }
}

function defaultConfig() {
  return {
    accounts: [],
    macro: {
      enabled: false,
      message: '',
      rooms: [],
      baseMin: 1,
      randomMin: 0,
      minMessages: 1,
      sendImages: 'EVERY',
      imageEveryN: 1,
      images: [],
      notifyReply: false,
      roomCooldownMin: {},
      dailyLimit: 200,
    },
    autoreply: {
      enabled: false,
      message: '',
      scope: 'ALL',
      exceptRooms: [],
      cooldownMs: 6 * 3600 * 1000,
      dailyLimit: 100,
      hourFrom: 0,
      hourTo: 24,
      firstOnly: false,
      delayMaxMs: 30000,
    },
    triggers: [],
  }
}

// 등록이 끝난 세션을 저장한다.
//   · 봇(bot.): features {v:2, bot:true}, config {} 로 저장하고 bot_accounts 최소 행을 ON CONFLICT DO NOTHING 으로 만든다(2.2·3.6).
//   · 새 고객 기록의 기본 권리는 거부: features {v:2, macro_until:0, legacy_room_until:0, reg_at:now}(5.1).
//     재등록은 이전 값을 두고 reg_at 만 고친다. 부모가 등록 직후 /v1/grants 로 실제 값을 민다.
export function registerFeatures(prev, now) {
  if (prev && prev.features && typeof prev.features === 'object' && Object.keys(prev.features).length) {
    return Object.assign({}, prev.features, { reg_at: now })
  }
  return { v: 2, macro_until: 0, legacy_room_until: 0, reg_at: now }
}

async function storeSession(hub, deviceId, credentials, email) {
  const prev = await loadRecord(deviceId)
  const now = Date.now()
  if (isBotId(deviceId)) {
    // 최소 행을 먼저 만든다. 그다음 붙으면서(afterConnect) nickname·state 를 그 행에 쓴다.
    try {
      await dbStore.ensureBotAccount(deviceId, email)
    } catch (e) {
      process.stderr.write(`[sender] ${deviceId} bot_accounts insert failed: ${e && e.message ? e.message : e}\n`)
    }
    await hub.upsert(deviceId, { credentials, config: {}, features: { v: 2, bot: true }, rooms: [], images: [] })
    return
  }
  const body = { credentials }
  if (prev && prev.config) body.config = prev.config
  else body.config = defaultConfig()
  body.features = registerFeatures(prev, now)
  if (prev && Array.isArray(prev.rooms)) body.rooms = prev.rooms
  if (prev && Array.isArray(prev.images)) body.images = prev.images
  await hub.upsert(deviceId, body)
}

export async function beginLogin(hub, input) {
  const email = String(input.email || '')
  const password = String(input.password || '')
  const deviceId = String(input.device_id || '')
  const forced = input.forced === true
  if (fakeOn()) {
    const f = fakeBegin({ device_id: deviceId, email, password, forced })
    if (f.credentials) await storeSession(hub, deviceId, f.credentials, email)
    return f.result
  }
  const deviceUuid = generateDeviceUuid()
  const tablet = pickTablet()
  const result = await attemptLogin(email, password, deviceUuid, 'tablet', forced, undefined, tablet.name, tablet.model)
  if (result.authenticated && result.credentials) {
    await storeSession(hub, deviceId, loginOk(result, deviceUuid).credentials, email)
    return { state: 'ok', device_name: tablet.name, device_model: tablet.model }
  }
  if (result.next_action === 'provide_passcode') {
    const pc = await requestPasscode(email, password, deviceUuid, tablet.name, tablet.model)
    if (!pc.passcode) {
      return failBody(pc.error || 'passcode_request_failed', pc.message || '', statusOf(pc), tablet)
    }
    const pendingId = randomBytes(12).toString('hex')
    const row = { email, password, deviceUuid, deviceId, forced, tablet, cancelled: false, running: false }
    pending.set(pendingId, row)
    setTimeout(() => {
      const cur = pending.get(pendingId)
      if (cur) cur.password = ''
      pending.delete(pendingId)
    }, PENDING_TTL_MS).unref()
    return {
      state: 'confirm_on_phone',
      pending_id: pendingId,
      passcode: pc.passcode,
      remaining_seconds: typeof pc.remaining_seconds === 'number' ? pc.remaining_seconds : null,
      device_name: tablet.name,
      device_model: tablet.model,
    }
  }
  if (result.error === 'bad_credentials') return withStatus('bad_credentials', result.message || '', statusOf(result), tablet)
  if (result.error === 'login_failed' && !forced) {
    const failed = failBody(result.error, result.message || '', statusOf(result), tablet)
    failed.state = 'login_failed'
    failed.can_force = true
    return failed
  }
  return failBody(result.error || 'login_failed', result.message || '', statusOf(result), tablet)
}

export async function confirmLogin(hub, input) {
  const id = String(input.pending_id || '')
  if (fakeOn()) {
    const f = await fakeConfirm({ pending_id: id })
    if (f.credentials) await storeSession(hub, f.deviceId, f.credentials, f.email)
    return f.result
  }
  const row = pending.get(id)
  if (!row || !row.password) return { state: 'expired' }
  if (row.running) return { state: 'waiting' }
  row.running = true
  const tablet = row.tablet
  try {
    const reg = await registerDevice(row.email, row.password, '', row.deviceUuid, tablet.name, tablet.model)
    if (row.cancelled) return { state: 'expired' }
    if (reg.error === 'registration_timeout') {
      row.running = false
      return { state: 'waiting' }
    }
    if (reg.error) {
      pending.delete(id)
      return failBody(reg.error, reg.message || '', statusOf(reg), tablet)
    }
    const again = await attemptLogin(row.email, row.password, row.deviceUuid, 'tablet', row.forced, undefined, tablet.name, tablet.model)
    if (row.cancelled) return { state: 'expired' }
    pending.delete(id)
    if (again.authenticated && again.credentials) {
      await storeSession(hub, row.deviceId, loginOk(again, row.deviceUuid).credentials, row.email)
      return { state: 'ok', device_name: tablet.name, device_model: tablet.model }
    }
    return failBody(again.error || 'login_failed', again.message || '', statusOf(again), tablet)
  } catch (e) {
    row.running = false
    process.stderr.write('[sender] register confirm interrupted\n')
    return { state: 'waiting' }
  }
}

export function cancelLogin(pendingId) {
  if (fakeOn()) fakeCancel(pendingId)
  const row = pending.get(String(pendingId || ''))
  if (!row) return
  row.cancelled = true
  row.password = ''
  pending.delete(String(pendingId))
}
