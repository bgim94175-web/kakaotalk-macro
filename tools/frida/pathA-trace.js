/*
 * pathA-trace.js — [Path A 1단계: 발견] 「보이스룸 켜기」가 부르는 카톡 내부 Java 메서드를 찾는다.
 *
 * 왜: A 는 봇이 프로토콜을 직접 말하는 대신, 앱이 "켜기" 때 실행하는 바로 그 Java 메서드를
 *     frida 로 호출해 앱이 네이티브(arm64 libVoxCore)로 음성서버에 붙게 만든다. arm64 코드는
 *     건드리지 않으니 Houdini(BlueStacks) 벽이 없다(= 이미 성공한 OkHttp 후킹과 같은 층).
 *
 * 이 스크립트가 찍는 것(켜기 한 번 누르면):
 *   [STACK] 보이스룸 HTTP 요청이 만들어질 때의 "자바 호출 스택" → 봇이 부를 상위 메서드가 여기 다 보인다.
 *   [NATIVE] libVoxCore 로 등록된 JNI 네이티브 메서드(이름+시그니처+선언 클래스) → MakeVoiceRoomCall 의 자바 선언.
 *   [RETRO] Retrofit 인터페이스(@GET c/voiceroom/...) 호출 시 그 인터페이스/메서드.
 *
 * 실행(기존 capture.ps1 처럼):  frida -U -f com.kakao.talk -l pathA-trace.js --no-pause
 *   또는 이미 떠 있으면:        frida -U -n KakaoTalk -l pathA-trace.js
 *
 * 쓰는 법: "capture armed" 뜨면 → 오픈채팅방에서 보이스룸 "켜기" 한 번 →
 *          [STACK]/[NATIVE]/[RETRO] 블록을 통째로 복사해서 주면 된다.
 *
 * 절대 크래시 안 나게: 모든 후킹은 try/catch. 네이티브(arm64) 코드엔 Interceptor 를 안 건다(= 벽 회피).
 */
'use strict';

var LIBVOX = 'libVoxCore.so';
var URL_HINT = /voiceroom|livetalk|live_talk|voicetalk|\/vox|vcs|voicecall|openlink\/.*call/i;

function L(tag, s) { console.log('[' + tag + '] ' + s); }

function javaStack() {
  try {
    var Exception = Java.use('java.lang.Exception');
    var Log = Java.use('android.util.Log');
    return Log.getStackTraceString(Exception.$new());
  } catch (e) { return '<stack fail: ' + e + '>'; }
}

/* ── 1) libVoxCore 로 등록되는 JNI 네이티브 메서드 덤프 (이름+sig+클래스) ───────────── */
function hookRegisterNatives() {
  try {
    var mod = Process.findModuleByName(LIBVOX);
    var voxLo = mod ? mod.base : null;
    var voxHi = mod ? mod.base.add(mod.size) : null;

    var targets = [];
    Process.getModuleByName('libart.so').enumerateExports().forEach(function (e) {
      if (e.name.indexOf('RegisterNatives') >= 0 && e.name.indexOf('CheckJNI') < 0) targets.push(e);
    });
    if (!targets.length) { L('NATIVE', 'RegisterNatives 심볼 못 찾음(생략)'); return; }

    targets.forEach(function (t) {
      Interceptor.attach(t.address, {
        onEnter: function (args) {
          try {
            var clazz = args[1], methods = args[2], count = args[3].toInt32();
            // 선언 클래스 이름 (JNI 로 Class.getName 호출)
            var cname = '?';
            try {
              var env = Java.vm.getEnv();
              var kls = env.findClass('java/lang/Class');
              var mid = env.getMethodId(kls, 'getName', '()Ljava/lang/String;');
              var js = env.callObjectMethod(clazz, mid);
              cname = Java.vm.getEnv().stringFromJni ? Java.vm.getEnv().stringFromJni(js) : env.getStringUtfChars(js, null).readCString();
            } catch (e) {}
            for (var i = 0; i < count; i++) {
              var p = methods.add(i * Process.pointerSize * 3);
              var nm = p.readPointer().readCString();
              var sig = p.add(Process.pointerSize).readPointer().readCString();
              var fn = p.add(Process.pointerSize * 2).readPointer();
              var inVox = voxLo && fn.compare(voxLo) >= 0 && fn.compare(voxHi) < 0;
              if (inVox || /voice|vox|room|call|conf|media/i.test(nm || '')) {
                L('NATIVE', (inVox ? '★libVoxCore ' : '          ') + cname + '.' + nm + '  ' + sig + '  @' + fn);
              }
            }
          } catch (e) { L('NATIVE', 'parse err ' + e); }
        }
      });
    });
    L('NATIVE', 'RegisterNatives 후킹 완료(' + targets.length + ') — 네이티브 등록 시 ★ 로 표시');
  } catch (e) { L('NATIVE', 'hook err ' + e); }
}

/* ── 2) OkHttp 요청 생성 시점의 자바 스택 (켜기 흐름의 상위 메서드가 보인다) ──────────── */
function hookOkHttp() {
  var done = false;
  // Request$Builder.build() 가 가장 호환성 좋음(모든 요청이 여기 지남)
  try {
    var B = Java.use('okhttp3.Request$Builder');
    B.build.implementation = function () {
      var req = this.build();
      try {
        var url = '' + req.url().toString();
        if (URL_HINT.test(url)) {
          L('STACK', '================= 보이스룸 요청 발견 =================');
          L('STACK', req.method() + ' ' + url);
          L('STACK', javaStack());
          L('STACK', '====================================================');
        }
      } catch (e) {}
      return req;
    };
    done = true;
    L('cap', 'OkHttp Request.Builder.build 후킹됨');
  } catch (e) { L('cap!', 'okhttp build 후킹 실패: ' + e); }

  // 보조: RealCall 실행 시점에도 한 번
  ['okhttp3.internal.connection.RealCall', 'okhttp3.RealCall'].forEach(function (cn) {
    try {
      var RC = Java.use(cn);
      ['execute', 'enqueue'].forEach(function (m) {
        if (RC[m]) {
          RC[m].overloads.forEach(function (ov) {
            ov.implementation = function () {
              try {
                var url = '' + this.request().url().toString();
                if (URL_HINT.test(url)) { L('STACK', '(' + cn + '.' + m + ') ' + url + '\n' + javaStack()); }
              } catch (e) {}
              return ov.apply(this, arguments);
            };
          });
        }
      });
    } catch (e) {}
  });
}

/* ── 3) Retrofit 인터페이스 호출(=/c/voiceroom/... 선언) 잡기 ─────────────────────── */
function hookRetrofit() {
  try {
    var Proxy = Java.use('java.lang.reflect.Proxy');
    // retrofit 은 동적 프록시를 쓴다. InvocationHandler.invoke 를 후킹하면 인터페이스+메서드가 보인다.
    var IH = Java.use('java.lang.reflect.InvocationHandler');
    // 개별 구현이 obfuscate 되니, retrofit2 핵심만:
    var ServiceMethod = null;
    try { ServiceMethod = Java.use('retrofit2.Retrofit'); } catch (e) {}
    if (ServiceMethod && ServiceMethod.create) {
      ServiceMethod.create.implementation = function (svc) {
        try { L('RETRO', 'Retrofit.create(' + svc.getName() + ')'); } catch (e) {}
        return this.create(svc);
      };
      L('cap', 'retrofit2.Retrofit.create 후킹됨');
    }
  } catch (e) { /* retrofit 없거나 obfuscate — 무시 */ }
}

function main() {
  L('cap', 'capture armed — 보이스룸 "켜기" 한 번 누르세요. [STACK]/[NATIVE]/[RETRO] 블록을 복사해 주세요.');
  hookRegisterNatives();
  hookOkHttp();
  hookRetrofit();
}

setImmediate(function () { Java.perform(main); });
