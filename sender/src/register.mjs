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

// 카카오 호출과 기록 읽기를 한곳에 모은다. register-check.mjs 가 이것만 바꿔 끼워 실제 확인 흐름을 시험한다.
export const deps = { attemptLogin, generateDeviceUuid, registerDevice, requestPasscode, loadRecord }

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
  const prev = await deps.loadRecord(deviceId)
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
  const deviceUuid = deps.generateDeviceUuid()
  const tablet = pickTablet()
  const result = await deps.attemptLogin(email, password, deviceUuid, 'tablet', forced, undefined, tablet.name, tablet.model)
  if (result.authenticated && result.credentials) {
    await storeSession(hub, deviceId, loginOk(result, deviceUuid).credentials, email)
    return { state: 'ok', device_name: tablet.name, device_model: tablet.model }
  }
  if (result.next_action === 'provide_passcode') {
    const pc = await deps.requestPasscode(email, password, deviceUuid, tablet.name, tablet.model)
    if (!pc.passcode) {
      return logged('begin', failBody(pc.error || 'passcode_request_failed', pc.message || '', statusOf(pc), tablet))
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
  if (result.error === 'bad_credentials') return logged('begin', withStatus('bad_credentials', result.message || '', statusOf(result), tablet))
  if (result.error === 'login_failed' && !forced) {
    const failed = failBody(result.error, result.message || '', statusOf(result), tablet)
    failed.state = 'login_failed'
    failed.can_force = true
    return logged('begin', failed)
  }
  return logged('begin', failBody(result.error || 'login_failed', result.message || '', statusOf(result), tablet))
}

// 실패 결과만 남긴다. 계정·비밀번호·카카오 문장은 넣지 않고 상태와 오류 번호만 쓴다.
function logged(step, out) {
  if (out && out.state !== 'ok' && out.state !== 'waiting' && out.state !== 'confirm_on_phone') {
    process.stderr.write(`[sender] register ${step} -> ${out.state} ${out.code || ''} status=${out.status == null ? '-' : out.status}\n`)
  }
  return out
}

// 카카오가 '아직 휴대폰에서 확인하지 않았다'(-100)고 답했거나 잠깐 응답하지 못한 것(HTTP 5xx·429)은 실패가 아니라 기다림이다.
// 라이브러리는 -100 에 다음 확인 간격이 없거나 HTTP 오류가 나면 바로 registration_failed 로 돌려준다.
export function stillWaiting(reg) {
  if (!reg || !reg.error) return false
  if (reg.error === 'registration_timeout' || reg.status === -100) return true
  const hit = String(reg.message || '').match(/^HTTP (\d+) /)
  if (!hit) return false
  const code = Number(hit[1])
  return code >= 500 || code === 429
}

// 끝난 결과(성공·실패)는 대기 시간이 다 될 때까지 둔다. 부모의 앞선 확인이 20초 제한에 걸려 답을 못 받았어도
// 다음 확인이 같은 답을 받는다. 비밀번호는 바로 지운다.
function settle(row, out) {
  row.password = ''
  row.running = false
  row.result = out
  return logged('confirm', out)
}

export async function confirmLogin(hub, input) {
  const id = String(input.pending_id || '')
  if (fakeOn()) {
    const f = await fakeConfirm({ pending_id: id })
    if (f.credentials) await storeSession(hub, f.deviceId, f.credentials, f.email)
    return f.result
  }
  const row = pending.get(id)
  if (row && row.result) return row.result
  // 모르는 번호는 sender 가 다시 시작해 대기 목록을 잃은 것이다(대기 목록은 메모리에만 있다)
  if (!row) return { state: 'expired', reason: 'unknown_pending' }
  if (!row.password) return { state: 'expired' }
  if (row.running) return { state: 'waiting' }
  row.running = true
  const tablet = row.tablet
  try {
    const reg = await deps.registerDevice(row.email, row.password, '', row.deviceUuid, tablet.name, tablet.model)
    if (row.cancelled) return { state: 'expired' }
    if (stillWaiting(reg)) {
      row.running = false
      return { state: 'waiting' }
    }
    if (reg.error) return settle(row, failBody(reg.error, reg.message || '', statusOf(reg), tablet))
    const again = await deps.attemptLogin(row.email, row.password, row.deviceUuid, 'tablet', row.forced, undefined, tablet.name, tablet.model)
    if (row.cancelled) return { state: 'expired' }
    if (!(again.authenticated && again.credentials)) {
      return settle(row, failBody(again.error || 'login_failed', again.message || '', statusOf(again), tablet))
    }
    row.password = ''
    try {
      await storeSession(hub, row.deviceId, loginOk(again, row.deviceUuid).credentials, row.email)
    } catch (e) {
      process.stderr.write(`[sender] register store failed ${e && e.code ? e.code : ''}\n`)
      return settle(row, failBody('store_failed', '', null, tablet))
    }
    return settle(row, { state: 'ok', device_name: tablet.name, device_model: tablet.model })
  } catch (e) {
    row.running = false
    process.stderr.write('[sender] register confirm interrupted\n')
    // 비밀번호를 이미 지운 뒤(저장 직전)라면 다시 확인할 수 없다
    return row.password ? { state: 'waiting' } : settle(row, failBody('login_failed', '', null, tablet))
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
