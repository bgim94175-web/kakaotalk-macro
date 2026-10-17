// VCS 탐색 러너. config(JSON)대로 TLS 접속 → steps 순서대로 패킷을 보내고 응답을 로그로 남긴다.
// 실행:  node run.mjs config.json
// config 는 config.example.json 를 복사해 frida 캡처값으로 채운다.
//
// 큰 수 처리(2^53 초과하는 chatId/callId): config 에서 {"$long":"184969..."} 로 쓰면 BSON Long 으로 넣는다.
//   {"$int":5}=Int32, {"$double":1.5}=Double, 그냥 정수=Int32, 문자열/불리언=그대로.
import { readFileSync } from 'node:fs'
import { Long, Int32, Double } from 'bson'
import { VcsClient } from './vcs.mjs'

function coerce(v) {
  if (Array.isArray(v)) return v.map(coerce)
  if (v && typeof v === 'object') {
    if ('$long' in v) return Long.fromString(String(v.$long))
    if ('$int' in v) return new Int32(v.$int | 0)
    if ('$double' in v) return new Double(Number(v.$double))
    const o = {}; for (const k of Object.keys(v)) o[k] = coerce(v[k]); return o
  }
  if (typeof v === 'number' && Number.isInteger(v)) return new Int32(v) // enum 필드는 int32 가 기본일 확률
  return v
}

const cfgPath = process.argv[2] || 'config.json'
const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'))
const s = cfg.server || {}

const client = new VcsClient({
  host: s.host, port: s.port, sni: s.sni, logHex: !!cfg.logHex,
  caCert: s.caCertPath ? readFileSync(s.caCertPath) : undefined,
  clientCert: s.clientCertPath ? readFileSync(s.clientCertPath) : undefined,
  clientKey: s.clientKeyPath ? readFileSync(s.clientKeyPath) : undefined,
  replyMs: cfg.replyMs, idleMs: cfg.idleMs,
  onPacket: (h, b) => {}, // 필요 시 서버 알림 처리
})

async function main() {
  await client.connect()
  // 접속 직후 서버가 먼저 보내는 게 있는지 잠깐 본다(핸드셰이크 힌트).
  await new Promise((r) => setTimeout(r, Number(cfg.afterConnectWaitMs) || 1500))
  for (const step of cfg.steps || []) {
    if (step.waitMs) { await new Promise((r) => setTimeout(r, step.waitMs)); continue }
    const body = coerce(step.body || {})
    const res = await client.send(step.method, body)
    console.log('[run] step', step.method, '→', res.timeout ? 'TIMEOUT(no reply)' : `status ${res.h?.statusCode}`)
    if (step.stopOnError && res.h && res.h.statusCode && res.h.statusCode !== 0) {
      console.log('[run] stop: non-zero status'); break
    }
  }
  if (cfg.ping) { client.startPing(cfg.ping.method || 'PING', cfg.ping.everyMs || 30000) }
  if (cfg.holdMs) { console.log(`[run] holding ${cfg.holdMs}ms …`); await new Promise((r) => setTimeout(r, cfg.holdMs)) }
  client.close()
}
main().catch((e) => { console.error('[run] fatal', e); process.exit(1) })
