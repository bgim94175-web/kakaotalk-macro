// frida: 앱의 VCS TLS 접속(:5242)을 우리 릴레이로 돌린다.
// libc `connect` 는 x86_64(시스템 libc)라 Houdini 와 무관 — 평범한 Interceptor 로 안전하게 훅된다.
// 실행(기존 방식):  frida -H 127.0.0.1:27042 -p <KakaoTalk pid> -l redirect.js
//   (또는 -f com.kakao.talk 로 attach. VoxCore 캡처와 같은 frida 연결 사용)
//
// ★ RELAY_IP 를 PC 의 LAN IP(ipconfig 의 IPv4, BlueStacks 에서 닿는 주소)로 바꾸세요.
'use strict';
var RELAY_IP = '192.168.0.10';   // ← PC LAN IP 로 교체
var RELAY_PORT = 8443;           // relay.mjs 의 LISTEN 과 같게
var HIT_PORT = 5242;             // VCS 포트

function b(ip) { return ip.split('.').map(function (x) { return parseInt(x, 10); }); }

var libc = Process.getModuleByName('libc.so');
var connect = libc.getExportByName('connect');
Interceptor.attach(connect, {
  onEnter: function (a) {
    try {
      var sa = a[1];
      if (sa.isNull()) return;
      var fam = sa.readU16();
      if (fam !== 2) return; // AF_INET 만(IPv4). 앱이 IPv4 로 붙는다(QOS ConnectedIp).
      var port = (sa.add(2).readU8() << 8) | sa.add(3).readU8();
      if (port !== HIT_PORT) return;
      var o = sa.add(4);
      var orig = o.readU8() + '.' + o.add(1).readU8() + '.' + o.add(2).readU8() + '.' + o.add(3).readU8();
      console.log('[redir] :' + HIT_PORT + ' orig=' + orig + '  ->  ' + RELAY_IP + ':' + RELAY_PORT);
      sa.add(2).writeU8((RELAY_PORT >> 8) & 0xff);
      sa.add(3).writeU8(RELAY_PORT & 0xff);
      var ip = b(RELAY_IP);
      for (var i = 0; i < 4; i++) o.add(i).writeU8(ip[i]);
    } catch (e) { console.log('[redir] err ' + e); }
  },
});
console.log('[redir] armed — app :' + HIT_PORT + ' redirected to ' + RELAY_IP + ':' + RELAY_PORT
  + '  (relay 의 REAL_IP 는 위 orig 값으로 맞추세요)');
