// VCS 클라이언트 — CallServer 에 TLS 로 붙어 LOCO/BSON 패킷을 주고받는다. 모든 바이트를 로그로 남긴다.
// 아직 "탐색용"이다: 핸드셰이크·헤더가 완전히 확정되지 않았으므로, 연결·전송·로깅을 정확히 하고
// 서버가 돌려주는 것으로 빈칸을 메운다. (tools/frida/FINDINGS.md, tools/vcs/README.md 참고)
import tls from 'node:tls'
import { encodeFrame, createFrameReader } from './loco.mjs'

function hex(b, n = 80) {
  return b.subarray(0, n).toString('hex') + (b.length > n ? `…(${b.length}B)` : ` (${b.length}B)`)
}

export class VcsClient {
  constructor(opts) {
    // opts: {host, port, sni, caCert?, clientCert?, clientKey?, logHex, onPacket}
    this.o = opts || {}
    this.packetId = 0
    this.pending = new Map()
  }

  log(...a) { console.log('[vcs]', new Date().toISOString().slice(11, 23), ...a) }

  connect() {
    const o = this.o
    return new Promise((resolve, reject) => {
      const copt = {
        host: o.host,
        port: Number(o.port),
        servername: o.sni || o.host,
        // 서버 인증서 처리 미확정(descriptor 에 SNI/Cert 존재) → 우선 검증 끄고 cert 를 로그로 확인. TODO.
        rejectUnauthorized: false,
        ALPNProtocols: o.alpn || undefined,
        minVersion: 'TLSv1.2',
      }
      if (o.caCert) copt.ca = o.caCert
      if (o.clientCert) { copt.cert = o.clientCert; copt.key = o.clientKey } // mTLS 요구 시 (미확정)
      this.log(`connecting TLS ${o.host}:${o.port} sni=${copt.servername}`)
      const sock = tls.connect(copt, () => {
        const c = sock.getPeerCertificate() || {}
        this.log('TLS up', sock.getProtocol(), (sock.getCipher() || {}).name,
          'cert', JSON.stringify({ subject: c.subject, issuer: c.issuer, valid_to: c.valid_to }))
        resolve()
      })
      this.sock = sock
      const read = createFrameReader((h, b, raw) => this._onFrame(h, b, raw))
      sock.on('data', (d) => { if (o.logHex) this.log('<< raw', hex(d)); read(d) })
      sock.on('error', (e) => { this.log('ERR', e.code || e.message); reject(e) })
      sock.on('close', (hadErr) => this.log('closed', hadErr ? '(after error)' : ''))
      sock.on('timeout', () => this.log('idle timeout'))
      sock.setTimeout(Number(o.idleMs) || 60000)
    })
  }

  // method + BSON body 를 한 프레임으로 보낸다. 응답(같은 packetId)을 기다리는 Promise 반환.
  send(method, body) {
    const packetId = ++this.packetId
    const frame = encodeFrame({ packetId, method, body })
    this.log('>>', method, 'id', packetId, this.o.logHex ? hex(frame) : JSON.stringify(body))
    this.sock.write(frame)
    return new Promise((resolve) => {
      const t = setTimeout(() => { this.pending.delete(packetId); resolve({ timeout: true }) }, Number(this.o.replyMs) || 8000)
      this.pending.set(packetId, (r) => { clearTimeout(t); resolve(r) })
    })
  }

  _onFrame(h, b, raw) {
    if (!h) { this.log('<< UNPARSED (header guess wrong?)', hex(raw)); return }
    this.log('<<', h.method || '(no-method)', 'id', h.packetId, 'status', h.statusCode, 'body', JSON.stringify(b))
    const p = this.pending.get(h.packetId)
    if (p) { this.pending.delete(h.packetId); p({ h, b }) }
    if (typeof this.o.onPacket === 'function') { try { this.o.onPacket(h, b) } catch (e) { this.log('onPacket err', e) } }
  }

  // keepalive: PING 을 주기적으로. (문서 §1.8 — 서버가 응답 없으면 끊는다)
  startPing(method = 'PING', everyMs = 30000) {
    this._ping = setInterval(() => { try { this.send(method, {}) } catch (e) {} }, everyMs)
  }

  close() { if (this._ping) clearInterval(this._ping); if (this.sock) this.sock.destroy() }
}
