import { writeSync } from 'node:fs'
import { createServer } from 'node:http'

// 포트를 먼저 연다. 패치나 모듈 로드가 실패해도 부모는 그 이유를 읽을 수 있다.
const bind = process.env.SENDER_BIND || '0.0.0.0'
const portEnv = process.env.PORT
const port = portEnv == null || portEnv === '' ? 8787 : Number(portEnv)

let bootError = ''
let app = null

function lineOut(text) {
  const line = text.endsWith('\n') ? text : text + '\n'
  try { writeSync(1, line) } catch { process.stdout.write(line) }
}

function safeMessage(e) {
  return String(e && e.message ? e.message : e)
    .replace(/postgres(?:ql)?:\/\/\S+/gi, 'postgresql://…')
    .replace(/\/\/[^/\s@]+@/g, '//…@')
    .replace(/\s+/g, ' ')
    .slice(0, 300)
}

const server = createServer((req, res) => {
  if (!app) {
    res.writeHead(503, { 'content-type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify({ ok: false, error: bootError || 'sender_starting' }))
    return
  }
  app(req, res)
})

server.on('error', (e) => {
  process.stderr.write(`[sender] listen failed: ${safeMessage(e)}\n`)
  process.exit(1)
})

await new Promise((resolve) => {
  server.listen(port, bind, () => {
    const addr = server.address()
    const actual = addr && typeof addr === 'object' ? addr.port : port
    if (bind === '127.0.0.1') lineOut('SENDER_LISTENING ' + actual)
    process.stderr.write(`[sender] Kakao sender on ${bind}:${actual}\n`)
    resolve()
  })
})

try {
  const { patchKakaoLibrary } = await import('./patch-kakao.mjs')
  patchKakaoLibrary()
  const { createApp } = await import('./index.mjs')
  app = await createApp()
  lineOut('SENDER_READY')
} catch (e) {
  bootError = safeMessage(e)
  process.stderr.write(`[sender] boot failed: ${bootError}\n`)
  lineOut('SENDER_BOOT_ERROR ' + bootError)
}
