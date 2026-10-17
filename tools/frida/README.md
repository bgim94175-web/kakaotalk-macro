# 보이스룸 켜기 — HTTP 개설 요청 캡처

보이스룸은 **LOCO 메타로는 못 켠다**(실측: `SETMETA` type 16 → `-203`, `CHGMETA` → `-300`).
type-16 `liveon` 메타는 서버가 켜고 나서 뿌리는 **결과물**이지 클라이언트가 쓰는 자리가 아니다.

앱이 "켜기"를 누를 때 보내는 **HTTP 개설 요청**이 서버에 `csIP`·`csPort`·`callId` 를 만들게 하고,
서버가 그걸 메타로 뿌린다. 그래서 떠야 하는 건 그 HTTP 요청 **하나**다. 그게 손에 들어오면
`sender` 의 켜기 lifecycle(48h·keepalive·다중방)은 이미 준비돼 있어 바로 붙는다.

## 가장 편한 길 — 원클릭 (Windows + BlueStacks)
한 번만: BlueStacks 설정 > 고급 > **ADB 켜기**(+루트), 그리고 PC 에 `pip install frida-tools`.

그다음 PowerShell 에서 이 폴더로 `cd` 한 뒤:
```powershell
powershell -ExecutionPolicy Bypass -File .\capture.ps1
```
`capture.ps1` 이 adb 연결 → frida-server **자동 다운로드(버전 자동 일치)·설치·실행** → 카톡 띄워 캡처까지 한 방에 한다.
창이 뜨면 방에서 **보이스룸 켜기 한 번** → `★` 블록 복사.

## 직접 실행(수동)
- frida 설치된 PC + BlueStacks(카톡 로그인) + `frida-server`(BlueStacks 안에서 실행 중, **android-x86_64**, PC frida 와 **같은 버전**)
- `frida-ps -U` 로 기기가 잡히는지 확인
```bash
frida -U -f com.kakao.talk -l capture-voiceroom.js --no-pause   # 새로 띄우며 붙기
frida -U -n KakaoTalk -l capture-voiceroom.js                   # 이미 떠 있는 앱
```

## frida 없이 가고 싶으면 — HTTP Toolkit
[HTTP Toolkit](https://httptoolkit.com)(무료) 의 "Android device via ADB" 는 루트 기기에서 인증서 주입 + 핀 우회를
거의 자동으로 한다. 붙은 뒤 보룸 켜기를 누르면 요청이 목록에 뜬다. 단, 카카오의 핀을 못 뚫으면
HTTPS 내용이 안 보일 수 있다 — 그럴 땐 위 OkHttp 훅(TLS 위 계층이라 핀과 무관)이 더 확실하다.

## 캡처 순서
1. `[cap] capture armed` 가 뜰 때까지 기다린다.
2. 봇이 **부방장인 오픈채팅방**에 들어가 **「보이스룸 켜기」를 한 번** 누른다.
3. 로그에서 `★` 가 붙은 `[REQ]` / `[RES]` 블록을 찾는다(없으면 `livetalk`·`voice`·`call`·`openlink` 가 든 URL).
4. 그 블록을 **통째로 복사**해서 붙여 주면, 그 요청을 봇이 재현하는 코드를 만든다.

## 무엇을 보게 되나 (필요한 것)
- **URL + method** — 개설 엔드포인트 (예상: `livetalk`/`voice`/`openlink` 계열)
- **헤더 이름들** — 어떤 토큰을 요구하는지 (값은 가려짐)
- **요청 바디** — `chatId`·`linkId`·`title` 등 비밀 아닌 필드
- **응답 바디** — `csIP`·`csPort`·`callId` 가 여기서 내려오는지 확인

## 안전
- `Authorization`·`Cookie`·`S`·`C` 등 **비밀 헤더 값은 `<masked len=NN>` 로 가린다.** 로그를 그대로
  붙여도 토큰이 새지 않는다. 봇은 재현 시 **자기 계정의** 토큰을 쓰므로 가려진 값은 몰라도 된다.
- 바디에 전화번호·토큰 같은 게 보이면 그 부분만 지우고 붙여도 된다(구조만 알면 충분).

## 안 될 때
- `★` 가 안 뜨고 `[REQ]` 도 안 보이면: 켜기가 OkHttp 가 아닌 다른 경로일 수 있다 →
  스크립트가 30초 뒤 `diagnose()` 로 로드된 OkHttp 관련 클래스를 찍는다. 이름이 `okhttp3.*` 가 아니면
  셰이딩된 것 — 그 패키지명으로 `CONFIG`/훅 대상을 맞춘다.
- 요청이 너무 많으면: 찾은 뒤 `capture-voiceroom.js` 의 `CONFIG.ONLY_HILITE = true` 로 바꿔 켜기 관련만 본다.
- Houdini(arm64 번역) 크래시: 이 스크립트는 **자바 레벨**만 훅하므로 해당 없음. 네이티브(libVoxCore) 훅과 섞지 말 것.

## 다음 단계
캡처한 `[REQ]`/`[RES]` 를 붙이면:
1. `sender` 에 그 HTTP 요청을 봇 계정 토큰으로 재현하는 호출을 추가한다.
2. 응답의 `csIP`·`csPort`·`callId` 를 기존 `voiceroom.mjs` 세션에 넣는다(`adopt` 가 이미 그 값을 받게 돼 있다).
3. 켜기 성공 → 48h keepalive 가 메타 연장을 이어 간다.
