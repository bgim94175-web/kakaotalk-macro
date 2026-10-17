/*
 * capture-voiceroom.js — 카카오톡(BlueStacks) 「보이스룸 켜기」 HTTP 요청 캡처
 *
 * 왜 이렇게: 보이스룸은 LOCO 메타(type 16)로는 못 켠다(실측 — SETMETA -203 / CHGMETA -300).
 * 앱이 "켜기"를 누를 때 보내는 HTTP 개설 요청이 서버에 csIP·csPort·callId 를 만들게 하고,
 * 그 결과를 서버가 type-16 메타로 뿌린다. 그래서 우리가 떠야 하는 건 그 HTTP 요청 하나다.
 *
 * 왜 Java 레벨 OkHttp 훅인가:
 *   · OkHttp 의 Request/Response 객체를 가로채면 HTTP/1.1·HTTP/2 를 가리지 않고
 *     URL·헤더·바디가 "이미 복호화된 평문"으로 나온다(TLS 위 계층이라 인증서 핀 우회도 불필요).
 *   · ART(x86_64)에서 도는 자바 코드라 BlueStacks 의 Houdini(arm64 번역) 문제가 없다.
 *     frida 트램폴린이 정상으로 박힌다(문서 §7.5·7.6).
 *
 * 실행:
 *   # 새로 띄우며 붙기
 *   frida -U -f com.kakao.talk -l capture-voiceroom.js --no-pause
 *   # 이미 떠 있으면
 *   frida -U -n KakaoTalk -l capture-voiceroom.js
 *
 * 쓰는 법:
 *   1) 붙으면 "capture armed" 가 뜬다.
 *   2) 오픈채팅방에 들어가 「보이스룸 켜기」를 한 번 누른다.
 *   3) 로그에서 ★ 가 붙은 [REQ]/[RES] 블록(또는 livetalk/voice/call 관련 URL)을 통째로 복사.
 *
 * 안전: Authorization·Cookie 등 비밀 헤더 값은 <masked> 로 가린다(로그를 그대로 붙여도 토큰이 새지 않게).
 *   봇은 재현할 때 "자기 계정의" 토큰을 쓰므로, 캡처에서 필요한 건 URL·method·헤더 이름·바디의
 *   비밀 아닌 필드(chatId·linkId·title 등)다. 가려진 값은 몰라도 된다.
 */
'use strict';

var CONFIG = {
  // 이 단어가 URL 에 들어가면 줄 앞에 ★ 를 붙여 눈에 띄게 한다(켜기 요청 찾기용).
  HILITE: ['livetalk', 'live_talk', 'voicetalk', 'voice', 'vox', 'vcs', 'call', 'openlink', 'live'],
  // true 로 바꾸면 HILITE 에 맞는 요청만 찍는다(URL 을 알아낸 뒤 로그 폭주를 줄일 때).
  ONLY_HILITE: false,
  BODY_MAX: 8192,
  // 값을 가릴 헤더(소문자 비교). a(앱버전)·talk-os 같은 건 비밀이 아니라 남긴다.
  MASK_HEADERS: ['authorization', 'cookie', 'set-cookie', 's', 'c'],
};

function log(s) { console.log('[cap] ' + s); }
function warn(s) { console.log('[cap!] ' + s); }

function clip(s) {
  if (s == null) return s;
  return s.length > CONFIG.BODY_MAX ? s.slice(0, CONFIG.BODY_MAX) + '…(+' + (s.length - CONFIG.BODY_MAX) + ' chars)' : s;
}

function maybeMask(name, value) {
  return CONFIG.MASK_HEADERS.indexOf(('' + name).toLowerCase()) >= 0
    ? '<masked len=' + ('' + value).length + '>' : value;
}

function headersText(headers) {
  try {
    var out = [];
    var n = headers.size();
    for (var i = 0; i < n; i++) out.push('  ' + headers.name(i) + ': ' + maybeMask(headers.name(i), headers.value(i)));
    return out.join('\n');
  } catch (e) { return '  <headers read fail: ' + e + '>'; }
}

function requestBodyText(request) {
  try {
    var body = request.body();
    if (body == null) return null;
    var ct = '';
    try { var mt = body.contentType(); ct = mt ? ('' + mt.toString()) : ''; } catch (e) {}
    if (/octet-stream|protobuf|image|multipart/i.test(ct)) {
      var len = -1; try { len = body.contentLength(); } catch (e) {}
      return '<binary ' + (ct || '?') + ' ' + len + ' bytes>';
    }
    var Buffer = Java.use('okio.Buffer');
    var buf = Buffer.$new();
    body.writeTo(buf);
    return clip(buf.readUtf8());
  } catch (e) { return '<req body read fail: ' + e + '>'; }
}

function responseBodyText(response) {
  try {
    var b0 = response.body();
    if (b0 == null) return null;
    var ct = '';
    try { var mt = b0.contentType(); ct = mt ? ('' + mt.toString()) : ''; } catch (e) {}
    if (/octet-stream|protobuf|image/i.test(ct)) return '<binary ' + (ct || '?') + '>';
    // peekBody 는 바디를 소비하지 않고 복사본을 준다(원래 응답 흐름을 깨지 않는다).
    var peek = response.peekBody(CONFIG.BODY_MAX + 1);
    return clip('' + peek.string());
  } catch (e) { return '<resp body read fail: ' + e + '>'; }
}

function isHot(url) {
  var u = ('' + url).toLowerCase();
  for (var i = 0; i < CONFIG.HILITE.length; i++) if (u.indexOf(CONFIG.HILITE[i]) >= 0) return true;
  return false;
}

function dump(request, response) {
  try {
    if (request == null) return;
    var url = '' + request.url().toString();
    var hot = isHot(url);
    if (CONFIG.ONLY_HILITE && !hot) return;
    var mark = hot ? '★ ' : '';
    var lines = ['', mark + '================ [REQ] ' + request.method() + ' ' + url, headersText(request.headers())];
    var rb = requestBodyText(request);
    if (rb != null) lines.push('  --- body ---\n' + rb);
    if (response != null) {
      lines.push(mark + '---------------- [RES] ' + response.code());
      lines.push(headersText(response.headers()));
      var pb = responseBodyText(response);
      if (pb != null) lines.push('  --- body ---\n' + pb);
    }
    lines.push('================');
    console.log(lines.join('\n'));
  } catch (e) { warn('dump ' + e); }
}

function getField(obj, names) {
  for (var i = 0; i < names.length; i++) {
    try { var w = obj[names[i]]; if (w != null) return w.value; } catch (e) {}
  }
  return null;
}

// 최근에 찍은 요청을 짧게 기억해 중복(proceed 경로에서 생기는)을 줄인다.
var seen = {};
function freshOnce(key) {
  var now = Date.now();
  if (seen[key] && now - seen[key] < 1500) return false;
  seen[key] = now;
  return true;
}

function hookOkHttp() {
  var hooked = [];

  // OkHttp 4.x: HTTP 호출 하나당 정확히 한 번 — 최종 Response 를 돌려주는 자리(중복 없음)
  try {
    var RealCall = Java.use('okhttp3.internal.connection.RealCall');
    if (RealCall.getResponseWithInterceptorChain) {
      RealCall.getResponseWithInterceptorChain.implementation = function () {
        var resp = this.getResponseWithInterceptorChain();
        dump(getField(this, ['originalRequest', 'request']), resp);
        return resp;
      };
      hooked.push('RealCall.getResponseWithInterceptorChain');
    }
  } catch (e) {}

  // 위가 없을 때(구버전/다른 내부구조)의 대안: 체인의 proceed(Request). 인터셉터마다 불리므로 중복 제거한다.
  if (!hooked.length) {
    try {
      var RIC = Java.use('okhttp3.internal.http.RealInterceptorChain');
      var ov = RIC.proceed.overload('okhttp3.Request');
      ov.implementation = function (request) {
        var resp = ov.call(this, request);
        try {
          var key = request.method() + ' ' + request.url().toString();
          if (freshOnce(key)) dump(request, resp);
        } catch (e) { dump(request, resp); }
        return resp;
      };
      hooked.push('RealInterceptorChain.proceed');
    } catch (e) {}
  }

  return hooked;
}

// OkHttp 클래스를 못 찾았을 때: 난독화/셰이딩 여부를 보여 준다(실제 패키지명을 눈으로 확인).
function diagnose() {
  var hits = [];
  try {
    Java.enumerateLoadedClassesSync().forEach(function (n) {
      if (/okhttp|OkHttp|RealCall|InterceptorChain|HttpUrl/.test(n)) hits.push(n);
    });
  } catch (e) { warn('enumerate fail ' + e); }
  warn('OkHttp 표준 클래스명을 못 찾았어요. 로드된 관련 클래스 ' + hits.length + '개:');
  hits.slice(0, 50).forEach(function (n) { log('  ' + n); });
  if (!hits.length) warn('하나도 없으면 아직 네트워크 스택이 로드 전이거나, 앱이 OkHttp 를 안 쓰는 경로일 수 있어요.');
  else warn('이름이 okhttp3.* 가 아니라면 셰이딩된 것 — 그 패키지명으로 CONFIG 를 맞춰 다시 돌려 주세요.');
}

Java.perform(function () {
  var tries = 0;
  (function attempt() {
    var hooked = hookOkHttp();
    if (hooked.length) {
      log('capture armed: ' + hooked.join(', '));
      log('이제 오픈채팅에서 「보이스룸 켜기」를 한 번 눌러 보세요. ★ 줄을 찾으면 됩니다.');
      return;
    }
    if (++tries > 60) { diagnose(); return; }   // 최대 30초 기다리며 재시도(네트워크 스택 로드까지)
    setTimeout(attempt, 500);
  })();
});
