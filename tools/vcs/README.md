# VCS 클라이언트 (탐색용 뼈대)

카카오 보이스룸 신호 서버(VCS = CallServer:5242/tls)에 **직접 붙어** 보룸을 켜기 위한 Node 클라이언트.
libVoxCore 정적분석(`../frida/FINDINGS.md`)으로 프로토콜을 거의 복원했고, 여기서 남은 바이트 레벨
3가지를 **실제 서버 응답으로** 맞춘다.

## 무엇이 확정됐나
- 전송 = 표준 TLS, **커스텀 암호 없음** (pjsip ssl_sock + OpenSSL)
- 프레임 = `[헤더][BSON 바디]`, 바디에 `method` 필드 + 통화/미디어 키들
- 흐름 = ConnectVcs → GetConf → MakeVoiceRoomCall(SDP) → 응답 → HangUp
- 미디어 = 표준 DTLS-SRTP/libwebrtc m130 (나중에 werift)

## 남은 TODO 3개 (이 코드로 서버 응답 보며 확정)
1. **헤더 정확한 오프셋** — `loco.mjs` 는 LOCO 추정(22B). 서버 응답이 `UNPARSED` 로 찍히면 오프셋을 조정.
2. **method 위치** — 헤더 11B vs BSON `{method}`. 지금은 둘 다 넣어 둠.
3. **핸드셰이크/인증** — 접속 직후 로그인 패킷이 필요한지, `SetVConfig` 의 두 토큰(64hex·긴 토큰)을
   어디에 넣는지. 접속 직후 서버가 먼저 보내는 바이트(afterConnectWaitMs 동안)를 보고 판단.

## 준비
```bash
cd tools/vcs
npm install
cp config.example.json config.json
```

## config 채우기 (frida 캡처에서)
- `server.host/port` ← `UpdateSystemQOS` 의 `ConnectedIp`/`ConnectedPort` (또는 MakeVoiceRoomCall 1·2번째 인자)
- `server.sni` ← `/c/voiceroom/user` 응답의 `SNI` (아직 미캡처면 host 로 두고 시도)
- `steps[].body` 의 `userId`/`chatId` ← 캡처값(큰 수는 `{"$long":"..."}`)
- `Desc`(SDP) ← 지금은 캡처한 SDP 문자열을 그대로 넣어 테스트. 실제 봇에선 werift 가 생성.

## 실행
```bash
node run.mjs config.json
```
모든 송수신 바이트가 `[vcs] >> / <<` 로그로 남는다.

## 로그 읽는 법
- `TLS up ...` + 서버 cert 가 보이면 TLS 는 성공. cert 가 안 오고 바로 close → **mTLS(클라 인증서) 필요** 가능성 → TODO-3.
- `<< UNPARSED` → 헤더 추정이 틀림(TODO-1). 그 hex 를 보고 `loco.mjs` 오프셋 조정.
- `<< 메서드 status -xxx` → 연결·프레이밍은 맞고 **바디(키/값)가 틀림**. status 코드로 어느 단계가 막혔는지 좁힌다.
- `status 0` → 그 메시지는 받아들여짐.

## ⚠️ 계정 주의
이 클라이언트는 **실제 카카오 음성서버에 접속**한다. 틀린 핸드셰이크를 과하게 반복하면 계정이
플래그될 수 있다(문서 §9.2). 천천히, 로그 위주로. 가능하면 테스트 부계정 권장.

## 파일
- `loco.mjs` — 프레이밍(헤더+BSON). 바이트 포맷은 여기만 고치면 된다.
- `vcs.mjs` — TLS 접속·송수신·PING·로깅.
- `run.mjs` — config 대로 step 실행.
- `config.example.json` — 채울 틀(추정 스키마 포함).

---

## UPDATE (Ghidra 디컴파일 반영)
프레임은 **method 문자열이 아니라 숫자 code** 였다(LOCO 아님). `loco.mjs` 를 그 모델로 교체:
- 헤더(추정, LE 13B): `[packetId u32][status u16][code u16][type u8][bsonLen u32]` → `writeHeader` 에서 조정 가능
- BSON 바디엔 method 없음. code 로 명령 구분. 주요 code: MakeVoiceRoomCall=0x272c, QueryCallable=0x7530, GetConf=0x7531
- `config.json` steps 는 `code`(16진 문자열) + `body`(BSON). 전체 모델은 `../frida/FINDINGS.md` 참고.
- 유일한 미확정 = 헤더 바이트 순서. 서버 응답이 `UNPARSED`/reset 이면 `writeHeader`/`readHeader` 만 바꿔가며 맞춘다.
