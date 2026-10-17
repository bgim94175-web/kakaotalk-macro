/*
 * voxcapture.js — [내일용 통합 캡처] 보이스룸 "켜기" 한 번으로 헤드리스 봇에 필요한 런타임 값을 전부 뜬다.
 *
 * 전부 "자바 레벨" 후킹이라 BlueStacks(Houdini)에서 안전하고, 재서명/루트/gadget 불필요.
 * (네이티브 arm64 코드엔 Interceptor 를 안 건다 — 자바 네이티브 메서드의 '선언'만 후킹/관찰)
 *
 * 한 번 켜면 찍히는 것:
 *   [HTTP]  GET /c/voiceroom/user 요청·응답(JSON 전체: vssHostV4/V6, iceServers, connectInfo, (세션키) …)
 *   [VCFG]  VoxCore.SetVConfig 12개 값 (version/country/dns/lang/uuid/model/os/sdk/vm/build ·
 *                                       skey·oauthToken 은 길이+앞자리만 마스킹)
 *   [MAKE]  VoxCore.MakeVoiceRoomCall 15개 인자 (csIP/port/tls/ipv6/chatId/userId/mediaType/title/
 *                                                serviceType/userType/★SDP) + 반환 callId
 *   [JOIN]  JoinVoiceRoomCall · [SEQ] Init/SetLocalNetwork/SendNetworkEvent/UpdateSystemQOS (핸드셰이크 순서)
 *
 * 실행:  frida -U -f com.kakao.talk -l voxcapture.js --no-pause   (또는 -n KakaoTalk 로 attach)
 * 쓰는 법: "voxcapture armed" → 봇계정 방장 오픈챗에서 보이스룸 켜기 1번 → voxcapture-log.txt 를 통째로 전달.
 *
 * (옵션) 멀티룸 시험: 켜기 1번 캡처 뒤, frida repl 에서  rpc.exports.again("<다른방 chatId>")  →
 *   같은 세션으로 두 번째 방 개설 시도(서버가 한 계정 멀티세션 막는지 확인).
 */
'use strict';

var VOX = 'com.kakao.vox.jni.VoxCore';
var CONFIG = {
  HILITE: ['voiceroom', 'livetalk', 'live_talk', 'voicetalk', '/vox', 'vcs', 'openlink'],
  BODY_MAX: 20000,
  MASK_HEADERS: ['authorization', 'cookie', 'set-cookie', 's', 'c'],
};
function log(s) { console.log(s); }
function clip(s) { return (s && s.length > CONFIG.BODY_MAX) ? s.slice(0, CONFIG.BODY_MAX) + '…(+' + (s.length - CONFIG.BODY_MAX) + ')' : s; }
function mask(v) { var s = '' + v; return '<len=' + s.length + ' pfx=' + s.slice(0, 4) + '… sfx=…' + s.slice(-2) + '>'; }

/* ───────── VoxCore 자바 인자 캡처 ───────── */
var last = {};                 // {instance, args, overload} per method
function fmtArgs(name, args) {
  // 알려진 메서드는 이름을 붙여 읽기 쉽게
  var A = Array.prototype.map.call(args, function (a) { return a; });
  function s(i) { return A[i] == null ? 'null' : '"' + ('' + A[i]) + '"'; }
  if (name === 'MakeVoiceRoomCall') {
    return [
      'csIP=' + s(0), 'port=' + A[1], 'tls=' + A[2],
      'csIP6=' + s(3), 'port6=' + A[4], 'tls6=' + A[5],
      'chatId=' + A[6], 'userId=' + A[7], 'mediaType=' + A[8],
      'title=' + s(9), 'serviceType=' + A[10], 'userType=' + A[11],
      'b1=' + A[13], 'b2=' + A[14],
      '\n     ★SDP(' + ('' + A[12]).length + 'B)=\n' + ('' + A[12]),
    ].join(' ');
  }
  if (name === 'JoinVoiceRoomCall') {
    return ['csIP=' + s(0), 'port=' + A[1], 'tls=' + A[2], 'csIP6=' + s(3), 'port6=' + A[4], 'tls6=' + A[5],
      'chatId=' + A[6], 'userId=' + A[7], 'callId=' + A[8], A[9], A[10], A[11]].join(' ');
  }
  if (name === 'SetVConfig') {
    // 0ver 1country 2dns 3lang 4skey 5uuid 6oauthToken 7model 8os 9sdk 10vm 11build
    var lbl = ['ver', 'country', 'dns', 'lang', 'skey*', 'uuid', 'oauthToken*', 'model', 'os', 'sdk', 'vm', 'build'];
    return lbl.map(function (k, i) {
      var v = A[i]; return k + '=' + (k.endsWith('*') ? mask(v) : '"' + v + '"');
    }).join(' ');
  }
  return A.map(function (a, i) { return '[' + i + ']=' + (a == null ? 'null' : '"' + a + '"'); }).join(' ');
}

function hookVox() {
  var names = ['MakeVoiceRoomCall', 'JoinVoiceRoomCall', 'SetVConfig', 'Init', 'UnInit',
    'SetLocalNetwork', 'SendNetworkEvent', 'UpdateSystemQOS', 'SetARSdkInfo', 'SetAppSummaryInfo', 'SetCallId'];
  var cls = null;
  for (var cn of [VOX, 'com.kakao.vox.jni.VoxCoreImpl']) {
    try { cls = Java.use(cn); } catch (e) { continue; }
    var tag = cn.split('.').pop();
    names.forEach(function (nm) {
      if (typeof cls[nm] === 'undefined') return;
      try {
        cls[nm].overloads.forEach(function (ov) {
          ov.implementation = function () {
            var a = arguments;
            var kind = (nm === 'MakeVoiceRoomCall') ? 'MAKE' : (nm === 'JoinVoiceRoomCall') ? 'JOIN'
              : (nm === 'SetVConfig') ? 'VCFG' : 'SEQ';
            log('\n[' + kind + '] ' + tag + '.' + nm + '  ' + fmtArgs(nm, a));
            var ret = ov.apply(this, a);
            if (nm === 'MakeVoiceRoomCall' || nm === 'JoinVoiceRoomCall') {
              log('[' + kind + '] -> callId=' + ret);
              last[nm] = { instance: this, args: Array.prototype.slice.call(a), ov: ov };
            }
            return ret;
          };
        });
      } catch (e) { log('[vox] hook ' + nm + ' fail: ' + e); }
    });
    break; // first class that resolves wins
  }
  log('[vox] VoxCore 후킹 완료 (' + names.length + ' 메서드)');
}

// (옵션) 멀티룸 재호출 — chatId 만 바꿔 MakeVoiceRoomCall 을 또 부른다
function again(chatIdText) {
  var L = last['MakeVoiceRoomCall'];
  if (!L) { log('[again] 아직 켜기 캡처 안 됨'); return 'no-capture'; }
  var r;
  Java.perform(function () {
    try {
      var na = L.args.slice(); na[6] = Java.use('java.lang.Long').$new.call ? chatIdText : chatIdText; // chatId=index6 (primitive long)
      na[6] = chatIdText;
      log('[again] 2번째 방 chatId=' + chatIdText + ' 로 MakeVoiceRoomCall 재호출');
      r = '' + L.ov.apply(L.instance, na);
      log('[again] -> callId=' + r + '  ★ chat2 방에 보룸 떴는지 + 첫 방 유지되는지 확인!');
    } catch (e) { r = 'err:' + e; log('[again] 실패: ' + e); }
  });
  return r;
}
rpc.exports = { again: again };

/* ───────── OkHttp HTTP 캡처 (capture-voiceroom.js 와 동일 방식) ───────── */
function headersText(h) { try { var o = [], n = h.size(); for (var i = 0; i < n; i++) { var nm = h.name(i); var v = h.value(i); o.push('  ' + nm + ': ' + (CONFIG.MASK_HEADERS.indexOf(('' + nm).toLowerCase()) >= 0 ? '<masked>' : v)); } return o.join('\n'); } catch (e) { return '  <hdr fail>'; } }
function respBody(resp) { try { var b = resp.body(); if (b == null) return null; var ct = ''; try { ct = '' + b.contentType(); } catch (e) {} if (/octet-stream|protobuf|image/i.test(ct)) return '<binary ' + ct + '>'; return clip('' + resp.peekBody(CONFIG.BODY_MAX + 1).string()); } catch (e) { return '<resp fail: ' + e + '>'; } }
function isHot(u) { u = ('' + u).toLowerCase(); for (var i = 0; i < CONFIG.HILITE.length; i++) if (u.indexOf(CONFIG.HILITE[i]) >= 0) return true; return false; }
function dumpHttp(req, resp) {
  try {
    if (req == null) return; var url = '' + req.url().toString(); var hot = isHot(url); var m = hot ? '★ ' : '';
    var L = ['', m + '[HTTP REQ] ' + req.method() + ' ' + url, headersText(req.headers())];
    if (resp != null) { L.push(m + '[HTTP RES] ' + resp.code()); var pb = respBody(resp); if (pb != null) L.push('  --- body ---\n' + pb); }
    if (hot || /\/c\//.test(url)) log(L.join('\n'));   // voiceroom 류 + /c/ API 만 (로그 폭주 방지)
  } catch (e) {}
}
function getField(o, ns) { for (var i = 0; i < ns.length; i++) { try { var w = o[ns[i]]; if (w != null) return w.value; } catch (e) {} } return null; }
function hookOkHttp() {
  try {
    var RC = Java.use('okhttp3.internal.connection.RealCall');
    if (RC.getResponseWithInterceptorChain) {
      RC.getResponseWithInterceptorChain.implementation = function () {
        var resp = this.getResponseWithInterceptorChain();
        try { dumpHttp(getField(this, ['originalRequest', 'request']), resp); } catch (e) {}
        return resp;
      };
      log('[http] OkHttp 후킹 완료'); return true;
    }
  } catch (e) {}
  return false;
}

/* ───────── arm ───────── */
setImmediate(function () {
  Java.perform(function () {
    try { hookVox(); } catch (e) { log('[vox] ' + e); }
    var t = 0;
    (function attempt() { if (hookOkHttp()) return; if (++t > 60) { log('[http] OkHttp 못 찾음(네트워크 전)'); return; } setTimeout(attempt, 500); })();
    log('\n★ voxcapture armed — 봇계정 방장 오픈챗에서 보이스룸 "켜기" 1번 → voxcapture-log.txt 전달');
  });
});
