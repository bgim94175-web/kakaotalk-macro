// VCS TLS MITM 릴레이. 앱 → (frida redirect) → 이 릴레이 → 진짜 CallServer.
// 우리 자가서명 cert(CN=kakao.com)로 앱 쪽 TLS 를 종료하고 평문을 로그로 남긴 뒤, 진짜 서버로 TLS 재접속해 중계.
// 실행:  REAL_IP=<진짜 csIP> node relay.mjs    (또는: node relay.mjs <진짜 csIP>)
//   REAL_IP = redirect.js 로그의 orig 값(= frida MakeVoiceRoomCall 1번째 인자).
// 평문은 콘솔 + mitm.log 에 hex 로 쌓인다.
//
// ★ 판정: 앱이 우리 cert 를 거부하면 "[relay] app TLS FAILED (pinning?)" 가 뜬다 → pjsip 핀/검증 ON → MITM 불가(정적 선회).
//         평문이 흐르면 → 로그인·프레임 전부 평문으로 확보.
import net from 'node:net'
import tls from 'node:tls'
import fs from 'node:fs'
import selfsigned from 'selfsigned'

const REAL_IP = process.env.REAL_IP || process.argv[2]
const REAL_PORT = Number(process.env.REAL_PORT || 5242)
const LISTEN = Number(process.env.LISTEN || 8443)
if (!REAL_IP) { console.error('REAL_IP 필요: REAL_IP=<csIP> node relay.mjs'); process.exit(1) }

const pems = selfsigned.generate(
  [{ name: 'commonName', value: 'kakao.com' }],
  { days: 365, keySize: 2048, altNames: [{ type: 2, value: 'kakao.com' }, { type: 2, value: '*.kakao.com' }] },
)
const logfile = 'mitm.log'
function dump(dir, buf) {
  const hex = buf.toString('hex')
  const ascii = [...buf].map((x) => (x >= 32 && x < 127 ? String.fromCharCode(x) : '.')).join('')
  console.log(`\n[${dir}] ${buf.length}B`)
  console.log(`  hex   ${hex.slice(0, 480)}${hex.length > 480 ? '…' : ''}`)
  console.log(`  ascii ${ascii.slice(0, 240)}`)
  try { fs.appendFileSync(logfile, `${new Date().toISOString()} ${dir} ${hex}\n`) } catch (e) {}
}

const server = tls.createServer({ key: pems.private, cert: pems.cert }, (cside) => {
  console.log('[relay] app TLS up — 진짜 서버로 연결 ' + REAL_IP + ':' + REAL_PORT)
  const sside = tls.connect({ host: REAL_IP, port: REAL_PORT, servername: 'kakao.com', rejectUnauthorized: false }, () => {
    console.log('[relay] upstream TLS up')
  })
  const end = (why) => { if (why) console.log('[relay] close:', why); cside.destroy(); sside.destroy() }
  cside.on('data', (d) => { dump('C>S', d); if (sside.writable) sside.write(d) })
  sside.on('data', (d) => { dump('S>C', d); if (cside.writable) cside.write(d) })
  cside.on('error', (e) => end('cside ' + e.message))
  sside.on('error', (e) => end('sside ' + e.message))
  cside.on('close', () => end()); sside.on('close', () => end())
})
server.on('tlsClientError', (e) => console.log('[relay] ★ app TLS FAILED (pinning 가능성):', e.message))
server.listen(LISTEN, '0.0.0.0', () => console.log(`[relay] listening :${LISTEN} → ${REAL_IP}:${REAL_PORT} (cert CN=kakao.com). 로그: ${logfile}`))
