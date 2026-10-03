import { failBody } from './register.mjs'

const a = failBody('login_failed', 'Login failed with status -111', null, { name: 'Galaxy Tab S9', model: 'SM-X710' })
if (a.status !== -111 || a.server_status !== -111) throw new Error('status -111')
if (a.device_name !== 'Galaxy Tab S9') throw new Error('device name')

const b = failBody('login_failed', '이용이 제한된 계정입니다.', -997, null)
if (b.status !== -997) throw new Error('status -997')

const c = failBody('registration_failed', 'Device registration failed with status -328', null, null)
if (c.status !== -328) throw new Error('status -328')

process.stdout.write('register check ok\n')
