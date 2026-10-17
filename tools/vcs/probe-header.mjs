// 헤더 바이트순서 자동 프로버. 유력 후보 레이아웃을 하나씩 보내 서버가 "응답 바이트"를 주는 걸 찾는다.
// (직렬화기가 간접호출이라 정적으로 못 떠서, 작은 후보공간을 실서버로 좁힌다.)
// 실행:  node probe-header.mjs config.json
//   config.server(host/port/sni) + steps[2].body 의 userId/chatId 를 쓴다(QueryCallable 0x7530 로 탐침).
import { readFileSync } from 'node:fs'
import tls from 'node:tls'
import { serialize, Long } from 'bson'

const cfg = JSON.parse(readFileSync(process.argv[2] || 'config.json', 'utf8'))
const S = cfg.server
// 최소 바디(QueryCallable). userId/chatId 는 config 에서.
const ids = (cfg.steps || []).map((s) => s.body).find((b) => b && b.userId) || {}
const body = {}
if (ids.userId && ids.userId.$long) body.userId = Long.fromString(ids.userId.$long)
if (ids.chatId && ids.chatId.$long) body.chatId = Long.fromString(ids.chatId.$long)
const bson = serialize(body)
const CODE = 0x7530 // QueryCallable
const pid = 0x11223344
const status = 0

// 후보 헤더 빌더들 (packetId/status/code/type/bsonLen 배치 × 엔디안 × 길이필드)
function hdr(parts) { return Buffer.concat(parts) }
const u32le = (v) => { const b = Buffer.alloc(4); b.writeUInt32LE(v >>> 0); return b }
const u16le = (v) => { const b = Buffer.alloc(2); b.writeUInt16LE(v & 0xffff); return b }
const u32be = (v) => { const b = Buffer.alloc(4); b.writeUInt32BE(v >>> 0); return b }
const u16be = (v) => { const b = Buffer.alloc(2); b.writeUInt16BE(v & 0xffff); return b }
const u8 = (v) => Buffer.from([v & 0xff])
const L = bson.length

const candidates = [
  ['LE pid st code type len',      hdr([u32le(pid), u16le(status), u16le(CODE), u8(1), u32le(L)])],
  ['LE pid st code len',           hdr([u32le(pid), u16le(status), u16le(CODE), u32le(L)])],
  ['BE pid st code type len',      hdr([u32be(pid), u16be(status), u16be(CODE), u8(1), u32be(L)])],
  ['BE pid st code len',           hdr([u32be(pid), u16be(status), u16be(CODE), u32be(L)])],
  ['LE len pid st code type',      hdr([u32le(L), u32le(pid), u16le(status), u16le(CODE), u8(1)])],
  ['BE len pid st code type',      hdr([u32be(L), u32be(pid), u16be(status), u16be(CODE), u8(1)])],
  ['LE totallen then pidstcodetype', hdr([u32le(L + 13), u32le(pid), u16le(status), u16le(CODE), u8(1), u32le(L)])],
]

function tryOne(name, header) {
  return new Promise((resolve) => {
    const frame = Buffer.concat([header, bson])
    const sock = tls.connect({ host: S.host, port: Number(S.port), servername: S.sni || S.host, rejectUnauthorized: false }, () => {
      sock.write(frame)
    })
    let got = Buffer.alloc(0)
    const done = (how) => {
      sock.destroy()
      const hex = got.length ? got.subarray(0, 48).toString('hex') : '-'
      resolve({ name, how, bytes: got.length, hex })
    }
    sock.on('data', (d) => { got = Buffer.concat([got, d]); })
    sock.setTimeout(5000, () => done('timeout'))
    sock.on('error', (e) => done('err:' + e.code))
    sock.on('close', () => done(got.length ? 'reply' : 'closed'))
  })
}

const run = async () => {
  console.log(`[probe] ${S.host}:${S.port} QueryCallable(0x7530) bson ${L}B — ${candidates.length} 후보\n`)
  for (const [name, h] of candidates) {
    const r = await tryOne(name, h)
    const flag = r.bytes > 0 ? '  ★★★ 응답 받음!' : ''
    console.log(`[${r.bytes > 0 ? 'HIT ' : '    '}] ${name.padEnd(34)} -> ${r.how} ${r.bytes}B ${r.hex}${flag}`)
    await new Promise((x) => setTimeout(x, 1500))
  }
  console.log('\n응답(★) 받은 레이아웃이 정답. 그 hex 를 알려주면 loco.mjs 를 확정합니다.')
}
run()
