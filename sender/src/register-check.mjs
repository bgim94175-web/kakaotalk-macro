import { beginLogin, confirmLogin, deps, failBody, stillWaiting } from './register.mjs'

const a = failBody('login_failed', 'Login failed with status -111', null, { name: 'Galaxy Tab S9', model: 'SM-X710' })
if (a.status !== -111 || a.server_status !== -111) throw new Error('status -111')
if (a.device_name !== 'Galaxy Tab S9') throw new Error('device name')

const b = failBody('login_failed', '이용이 제한된 계정입니다.', -997, null)
if (b.status !== -997) throw new Error('status -997')

const c = failBody('registration_failed', 'Device registration failed with status -328', null, null)
if (c.status !== -328) throw new Error('status -328')

// 카카오가 '아직 확인 전'(-100)이거나 잠깐 응답하지 못한 것은 기다림이다. 그 밖의 오류는 실패다.
if (!stillWaiting({ error: 'registration_timeout' })) throw new Error('timeout waits')
if (!stillWaiting({ error: 'registration_failed', status: -100 })) throw new Error('-100 waits')
if (!stillWaiting({ error: 'registration_failed', message: 'HTTP 503 from register endpoint' })) throw new Error('503 waits')
if (stillWaiting({ error: 'registration_failed', message: 'HTTP 400 from register endpoint' })) throw new Error('400 fails')
if (stillWaiting({ error: 'registration_failed', status: -110 })) throw new Error('-110 fails')
if (stillWaiting({ authenticated: false, message: 'Device registered.' })) throw new Error('success is not waiting')

// 실제 확인 흐름(가짜 모드 아님): 카카오 호출과 기록 읽기만 바꿔 끼운다
delete process.env.SENDER_FAKE
const K = { register: [], login: 0, upserts: [] }
deps.generateDeviceUuid = () => 'uuid-test'
deps.loadRecord = async () => null
deps.requestPasscode = async () => ({ passcode: '1234', remaining_seconds: 300 })
let loginStep = 'passcode'
deps.attemptLogin = async () => {
  K.login += 1
  if (loginStep === 'passcode') return { authenticated: false, next_action: 'provide_passcode' }
  return { authenticated: true, credentials: { access_token: 't', refresh_token: 'r', user_id: '1' } }
}
let gate = null
deps.registerDevice = async () => {
  const next = K.register.shift()
  if (next === 'gate') return new Promise((ok) => { gate = ok })
  return next
}
const hub = { upsert: async (id, body) => { K.upserts.push(id); return {} } }

async function pend() {
  loginStep = 'passcode'
  const out = await beginLogin(hub, { device_id: 'w1-test', email: 'a@k.test', password: 'pw' })
  if (out.state !== 'confirm_on_phone' || !out.pending_id || out.passcode !== '1234') throw new Error('begin gives a passcode')
  loginStep = 'ok'
  return out.pending_id
}

// 1. 확인 전(-100, 다음 간격 없음)은 waiting, 그 뒤 성공하면 ok. 늦게 온 확인도 같은 ok 를 받고 저장은 한 번.
let id = await pend()
K.register.push({ authenticated: false, error: 'registration_failed', status: -100 })
let r = await confirmLogin(hub, { pending_id: id })
if (r.state !== 'waiting') throw new Error('-100 is waiting, got ' + r.state)
K.register.push({ authenticated: false, message: 'Device registered.' })
r = await confirmLogin(hub, { pending_id: id })
if (r.state !== 'ok') throw new Error('registered device is ok, got ' + r.state)
r = await confirmLogin(hub, { pending_id: id })
if (r.state !== 'ok') throw new Error('a late confirm still gets ok, got ' + r.state)
if (K.upserts.length !== 1) throw new Error('session stored once, got ' + K.upserts.length)

// 2. 확인이 도는 중에 온 확인은 waiting, 끝나면 ok (부모의 20초 제한에 걸린 경우)
id = await pend()
K.register.push('gate')
const slow = confirmLogin(hub, { pending_id: id })
await new Promise((ok) => setTimeout(ok, 10))
r = await confirmLogin(hub, { pending_id: id })
if (r.state !== 'waiting') throw new Error('a confirm during a running one waits, got ' + r.state)
gate({ authenticated: false, message: 'Device registered.' })
if ((await slow).state !== 'ok') throw new Error('the running confirm ends ok')
r = await confirmLogin(hub, { pending_id: id })
if (r.state !== 'ok') throw new Error('the next confirm gets the kept ok, got ' + r.state)

// 3. 카카오 실패는 실패로 끝나고, 다음 확인도 같은 실패를 받는다
id = await pend()
K.register.push({ authenticated: false, error: 'registration_failed', status: -110, message: 'Device registration failed with status -110' })
r = await confirmLogin(hub, { pending_id: id })
if (r.state !== 'failed' || r.status !== -110) throw new Error('kakao failure is failed -110')
r = await confirmLogin(hub, { pending_id: id })
if (r.state !== 'failed' || r.status !== -110) throw new Error('the kept failure is returned again')

// 4. 모르는 번호(sender 재시작)는 이유를 붙인 expired
r = await confirmLogin(hub, { pending_id: 'nope' })
if (r.state !== 'expired' || r.reason !== 'unknown_pending') throw new Error('unknown pending is expired with a reason')

process.stdout.write('register check ok\n')
