// capture-vcs-arm64.js — VCS(보이스룸) 평문 캡처. libVoxCore 의 OpenSSL SSL_write/SSL_read 를
// export 이름으로 후킹해 송·수신 평문을 그대로 덤프한다. (LOCO 채팅 5223 은 앱 자체 암호라 여기 안 잡힘
//  → 여기 찍히는 건 전부 VCS 음성 5242 트래픽이라 깔끔하다.)
//
// ★ 중요: 이 스크립트는 "arm64 에서 frida 가 네이티브 코드를 후킹할 수 있는" 환경에서만 동작한다.
//   - 실기기(루팅 arm64 폰) / arm64 안드로이드 이미지 / 클라우드 arm64 안드로이드 : OK
//   - BlueStacks(x86 + Houdini arm64 번역) : libVoxCore 가 arm64 라 x86 frida 로는 후킹 불가 → 안 잡힘
//
// 사용:
//   frida -U -n "com.kakao.talk" -l capture-vcs-arm64.js        (붙이기)
//   frida -U -f com.kakao.talk -l capture-vcs-arm64.js           (새로 띄우기; 패키지명은 실제 값으로)
//   → 보이스룸 "켜기" 누르면 핸드셰이크 직후 >>LOGIN, 이어서 >>0x272c(MakeVoiceRoomCall) 프레임이 뜬다.
//
// 캡처가 다 끝나면: >> (TX) 첫 프레임 = 로그인/핸드셰이크, 그 다음 큰 프레임 = MakeVoiceRoomCall.
// 이 hex 를 그대로 주면 tools/vcs/loco.mjs 의 헤더/바디를 실측으로 확정한다.

'use strict'

var LIB = 'libVoxCore.so'
var MAXDUMP = 512 // 한 프레임당 덤프 상한(bytes). 큰 SDP 도 앞부분이면 충분.

function hexdump_(ptr, len) {
  if (len <= 0) return '(0 bytes)'
  var n = Math.min(len, MAXDUMP)
  var bytes = new Uint8Array(ptr.readByteArray(n))
  var hex = '', asc = '', out = ''
  for (var i = 0; i < n; i++) {
    var b = bytes[i]
    hex += ('0' + b.toString(16)).slice(-2) + ' '
    asc += (b >= 0x20 && b < 0x7f) ? String.fromCharCode(b) : '.'
    if ((i & 15) === 15) { out += '    ' + hex + ' |' + asc + '|\n'; hex = ''; asc = '' }
  }
  if (hex) { while (hex.length < 48) hex += '   '; out += '    ' + hex + ' |' + asc + '|\n' }
  if (len > n) out += '    …(+' + (len - n) + ' bytes more, total ' + len + ')\n'
  return '\n' + out
}

function fdOf(ssl) {
  try {
    var f = Module.getExportByName(LIB, 'SSL_get_fd')
    return new NativeFunction(f, 'int', ['pointer'])(ssl)
  } catch (e) { return -1 }
}

function ts() { return new Date().toISOString().slice(11, 23) }

function hook() {
  var mod = Process.findModuleByName(LIB)
  if (!mod) { console.log('[!] ' + LIB + ' 아직 로드 안 됨 — 재시도'); return false }
  console.log('[+] ' + LIB + ' @ ' + mod.base + '  (size ' + mod.size + ')')

  var wr = Module.getExportByName(LIB, 'SSL_write')
  var rd = Module.getExportByName(LIB, 'SSL_read')
  console.log('[+] SSL_write=' + wr + '  SSL_read=' + rd)

  // SSL_write(ssl, buf, num) — 보내는 평문
  Interceptor.attach(wr, {
    onEnter: function (a) {
      var ssl = a[0], buf = a[1], num = a[2].toInt32()
      console.log('\n>> [' + ts() + '] TX SSL_write fd=' + fdOf(ssl) + ' len=' + num + hexdump_(buf, num))
    }
  })

  // SSL_read(ssl, buf, num) → 받은 평문은 반환 후 buf 에 채워짐
  Interceptor.attach(rd, {
    onEnter: function (a) { this.buf = a[1]; this.ssl = a[0] },
    onLeave: function (ret) {
      var n = ret.toInt32()
      if (n > 0) console.log('\n<< [' + ts() + '] RX SSL_read fd=' + fdOf(this.ssl) + ' len=' + n + hexdump_(this.buf, n))
    }
  })

  // 핸드셰이크 시점 표시(어느 소켓이 VCS 인지 구분)
  try {
    Interceptor.attach(Module.getExportByName(LIB, 'SSL_do_handshake'), {
      onEnter: function (a) { this.ssl = a[0] },
      onLeave: function () { console.log('[hs] SSL_do_handshake fd=' + fdOf(this.ssl) + ' @' + ts()) }
    })
  } catch (e) {}
  console.log('[+] 후킹 완료 — 이제 카톡에서 보이스룸 "켜기" 누르세요.')
  return true
}

if (!hook()) {
  // 아직 로드 전이면 dlopen 후 재시도
  var cands = ['android_dlopen_ext', 'dlopen']
  cands.forEach(function (name) {
    var p; try { p = Module.getExportByName(null, name) } catch (e) { return }
    Interceptor.attach(p, {
      onEnter: function (a) { try { this.n = a[0].readCString() } catch (e) {} },
      onLeave: function () { if (this.n && this.n.indexOf('VoxCore') >= 0) { setTimeout(hook, 50) } }
    })
  })
}
