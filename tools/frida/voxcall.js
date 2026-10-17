/*
 * voxcall.js — [Path A+ 1단계] 앱의 VoxCore.MakeVoiceRoomCall 을 "직접 여러 번 불러"
 *   한 프로필로 여러 보룸이 되는지 시험하기 위한 준비. 지금 단계는 "정확한 호출을 그대로 뜨는" 것.
 *
 * 왜 Houdini 에서 되나:
 *   네이티브(arm64) 코드를 Interceptor 로 후킹하면 크래시지만, **자바 네이티브 메서드를 '호출/후킹'** 하는 건
 *   ART(x86) 층이라 정상. 앱이 평소 켜기 할 때 타는 바로 그 경로를 그대로 쓰는 것이다.
 *
 * 이 스크립트가 하는 일(켜기 1번 누르면):
 *   · com.kakao.vox.jni.VoxCore 를 찾아 MakeVoiceRoomCall(및 연관 메서드)을 후킹해
 *     인자 개수·타입·값·반환(callId)·호출 순서를 전부 로그로 남긴다.
 *   · 마지막 호출(인스턴스+인자)을 저장해 두고, rpc.exports.again(chatId) / 전역 트리거로 "다시 부르기"도 된다.
 *
 * 실행:  frida -U -f com.kakao.talk -l voxcall.js --no-pause    (또는 -n KakaoTalk 로 attach)
 * 쓰는 법: "voxcall armed" 뜨면 → 봇계정이 방장인 방에서 보이스룸 켜기 1번 →
 *          [VOX] 블록(특히 MakeVoiceRoomCall 인자들)을 통째로 복사해서 줘.
 *
 * 안전: 자바 레벨만 건드린다(네이티브 Interceptor 없음 → Houdini 크래시 없음). 모든 후킹 try/catch.
 */
'use strict';

var METHODS = ['MakeVoiceRoomCall', 'JoinVoiceRoomCall', 'ConnectVcs', 'ConnectVss', 'SetVConfig', 'SetLocalNetwork'];
var last = {};        // 메서드별 마지막 {instance, args, overload}
var voxClassName = null;

function safe(v) {
  try {
    if (v === null || v === undefined) return String(v);
    var cn = v.$className;
    if (cn) {
      if (/String/.test(cn)) { var s = v.toString(); return '"' + (s.length > 220 ? s.slice(0, 220) + '…(' + s.length + ')' : s) + '"'; }
      if (/Long|Integer|Boolean|Double|Float|Short|Byte/.test(cn)) return cn + '(' + v.toString() + ')';
      return cn;
    }
    var t = typeof v;
    if (t === 'string') return '"' + (v.length > 220 ? v.slice(0, 220) + '…(' + v.length + ')' : v) + '"';
    return String(v);
  } catch (e) { return '<?' + e + '>'; }
}

function hookOne(K, name) {
  if (typeof K[name] === 'undefined') return false;
  var ov = K[name].overloads;
  ov.forEach(function (o) {
    o.implementation = function () {
      var args = Array.prototype.slice.call(arguments);
      console.log('\n[VOX] ' + name + '  (argc=' + args.length + ') @' + new Date().toISOString().slice(11, 19));
      args.forEach(function (a, i) { console.log('   [' + i + '] ' + safe(a)); });
      var ret;
      try { ret = o.apply(this, arguments); }
      catch (e) { console.log('[VOX] ' + name + ' threw: ' + e); throw e; }
      console.log('[VOX] ' + name + ' -> ' + safe(ret));
      last[name] = { instance: this, args: args, overload: o, cls: K.$className };
      return ret;
    };
  });
  console.log('[voxcall] 후킹: ' + K.$className + '.' + name + ' (' + ov.length + ' overload)');
  return true;
}

// chatId 만 바꿔 MakeVoiceRoomCall 을 다시 부른다(2단계 시험). chatId 타입은 캡처한 그 자리의 타입을 따라간다.
function again(chatIdText, chatIdArgIndex) {
  var L = last['MakeVoiceRoomCall'];
  if (!L) { console.log('[voxcall] 아직 켜기 1번 캡처 안 됨 — 먼저 방에서 켜기 누르세요'); return; }
  var idx = (chatIdArgIndex == null) ? 6 : chatIdArgIndex; // FINDINGS 기준 chatId=index 6 (로그로 확인)
  Java.perform(function () {
    try {
      var na = L.args.slice();
      var cur = na[idx];
      var cn = cur && cur.$className;
      if (cn && /Long/.test(cn)) na[idx] = Java.use('java.lang.Long').$new(Java.use('java.lang.Long').parseLong(String(chatIdText)));
      else if (typeof cur === 'string') na[idx] = String(chatIdText);
      else na[idx] = chatIdText; // primitive long 이면 frida 가 문자열/숫자 받아줌
      console.log('[voxcall] 2번째 방 시험 — chatId[' + idx + '] = ' + chatIdText);
      var r = L.overload.apply(L.instance, na);
      console.log('[voxcall] 2번째 -> ' + safe(r) + '  ★ chat2 에 보룸 떴는지 + 첫 방 유지되는지 확인!');
    } catch (e) { console.log('[voxcall] 2번째 실패: ' + e); }
  });
}
rpc.exports = { again: again };
globalThis.__voxAgain = again; // 콘솔에서 __voxAgain("<chatId>") 로도 호출 가능

function arm() {
  var cands = [];
  try { Java.use('com.kakao.vox.jni.VoxCore'); cands.push('com.kakao.vox.jni.VoxCore'); } catch (e) {}
  if (!cands.length) {
    Java.enumerateLoadedClassesSync().forEach(function (n) {
      if (/vox/i.test(n) && /VoxCore|Vox$/.test(n)) cands.push(n);
    });
  }
  if (!cands.length) { console.log('[voxcall] VoxCore 클래스 아직 안 보임 — 카톡 보이스룸 화면 한 번 들어갔다 나와서 로드시켜 주세요'); return false; }
  var any = false;
  cands.forEach(function (cn) {
    try {
      var K = Java.use(cn);
      voxClassName = cn;
      METHODS.forEach(function (m) { if (hookOne(K, m)) any = true; });
    } catch (e) { console.log('[voxcall] ' + cn + ' 후킹 실패: ' + e); }
  });
  return any;
}

setImmediate(function () {
  Java.perform(function () {
    var ok = arm();
    if (!ok) {
      // VoxCore 가 나중에 로드되면 그때 다시
      try {
        var CL = Java.use('java.lang.ClassLoader');
        CL.loadClass.overload('java.lang.String').implementation = function (n) {
          var c = this.loadClass(n);
          if (/VoxCore/.test(n)) setTimeout(function () { Java.perform(arm); }, 100);
          return c;
        };
      } catch (e) {}
    }
    console.log('[voxcall] armed — 방장인 방에서 보이스룸 켜기 1번 → [VOX] 블록 전부 복사해서 주세요.');
  });
});
