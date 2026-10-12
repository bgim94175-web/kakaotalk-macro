// 보이스룸 실험(SENDER_VOICE_PROBE): 보이스룸 음성 서버(csIP:csPort)가 어떤 방식으로 말하는지 한 번 두드려 본다.
// 값은 `host:port` 또는 `1`(기본 203.133.188.66:9000). 결과는 `voice probe …` 로그 줄로만 남기고 아무것도 바꾸지 않는다.
import { createRequire } from 'node:module'
import { isIP, connect as netConnect } from 'node:net'
import { dirname, join } from 'node:path'
import { connect as tlsConnect } from 'node:tls'
import { pathToFileURL } from 'node:url'

const require = createRequire(import.meta.url)
const WAIT_MS = 4000

function log(text) {
  process.stderr.write(`[sender] voice probe ${text}\n`)
}

function hex(buf) {
  return buf.subarray(0, 96).toString('hex') + (buf.length > 96 ? `… (${buf.length} bytes)` : ` (${buf.length} bytes)`)
}

// 1) 그냥 TCP: 붙자마자 서버가 먼저 보내는 것이 있는지
function rawProbe(host, port) {
  return new Promise((resolve) => {
    const chunks = []
    const s = netConnect({ host, port })
    const done = (why) => { s.destroy(); resolve(`raw ${why}${chunks.length ? ' first ' + hex(Buffer.concat(chunks)) : ' no bytes'}`) }
    const t = setTimeout(() => done('open'), WAIT_MS)
    s.on('data', (d) => chunks.push(d))
    s.on('error', (e) => { clearTimeout(t); done('error ' + e.code) })
    s.on('close', () => { clearTimeout(t); done('closed') })
  })
}

// 2) TLS: 인증서 이름·ALPN 으로 무엇이 도는지 짐작
function tlsProbe(host, port) {
  return new Promise((resolve) => {
    const s = tlsConnect({ host, port, rejectUnauthorized: false, ...(isIP(host) ? {} : { servername: host }), ALPNProtocols: ['h2', 'http/1.1'] }, () => {
      const c = s.getPeerCertificate() || {}
      const out = `tls ok proto ${s.getProtocol()} alpn ${s.alpnProtocol || '-'} cert ${JSON.stringify({ subject: c.subject, issuer: c.issuer, san: c.subjectaltname, valid_to: c.valid_to })}`
      s.destroy()
      resolve(out)
    })
    s.setTimeout(WAIT_MS, () => { s.destroy(); resolve('tls timeout') })
    s.on('error', (e) => resolve('tls error ' + (e.code || e.message)))
  })
}

// 3) 채팅(LOCO)과 같은 암호 핸드셰이크 뒤 PING: 응답이 오면 같은 계열이다
async function locoProbe(host, port) {
  const base = join(dirname(require.resolve('agent-messenger/package.json')), 'dist/src/platforms/kakaotalk/protocol/connection.js')
  const { LocoConnection } = await import(pathToFileURL(base).href)
  const c = new LocoConnection()
  const pushes = []
  c.pushHandler = (p) => pushes.push(p.method)
  try {
    await c.connectSecure(host, port)
    const r = await Promise.race([c.sendPacket('PING', {}), new Promise((ok) => setTimeout(() => ok(null), WAIT_MS))])
    const got = r ? `reply ${r.method || '-'} status ${r.statusCode} body ${JSON.stringify(r.body).slice(0, 300)}` : 'no reply'
    return `loco ${got}${pushes.length ? ' pushes ' + pushes.join(',') : ''}`
  } catch (e) {
    return 'loco error ' + String(e && e.message ? e.message : e).slice(0, 200)
  } finally {
    try { c.socket && c.socket.destroy() } catch {}
  }
}

export async function voiceProbe(value) {
  const target = !value || value === '1' ? '203.133.188.66:9000' : value
  const [host, portText] = target.split(':')
  const port = Number(portText) || 9000
  log(`start ${host}:${port}`)
  for (const run of [rawProbe, tlsProbe, locoProbe]) {
    try { log(await run(host, port)) } catch (e) { log(`${run.name} failed ${e && e.message}`) }
  }
  log('done')
}
