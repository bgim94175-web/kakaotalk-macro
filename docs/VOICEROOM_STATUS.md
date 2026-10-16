# 보이스룸 봇 — 작업 기록 (VOICEROOM_STATUS)

카카오톡 오픈채팅 보이스룸 관련으로 지금까지 만든 것과 리버싱으로 알아낸 사실을 정리한 기록.
작업은 **내부 페이로드 암호층에서 멈췄다**(아래 §5).

---

## 1. 목표 (당초)

카카오톡 계정 1개로, 앱/에뮬레이터 없이 여러 오픈채팅방에 보이스룸을 동시에 열고 음악을 재생하며
48시간 유지·자동복구하는 Node 서비스. → 보이스룸 프로토콜("VCS")을 직접 재현해야 성립.

---

## 2. 레포 산출물 (브랜치 `claude/voice-room-keepalive`)

| 커밋 | 내용 |
|---|---|
| `4742c04` | `sender/src/voice-keep.mjs` — 보이스룸 신호(SETMETA type 16 liveon) 유지 상태머신(순수 함수: 주기 재알림·복구·48h 만료·백오프). botpool 연결, 명령어 `!보룸유지 [시간]`·`!보룸유지끄기`·`!보룸유지?`, API `POST /v1/bot/voice-keep`. selfcheck(#41) 포함 |
| `0da0ce5` | 다중 방 실험 명령 `!보룸전체`·`!보룸전체끄기`, API `POST /v1/bot/voice-all`, `BotSlot.voiceAllRooms` / `BotPool.voiceAll` |

기존부터 있던 관련 코드:
- `sender/src/botpool.mjs`: `voiceSetMeta`(SETMETA 16 liveon 발신, csIP/callId 임의값), `voiceProbe`(LOCO 명령어 후보 탐색), 명령어 `!보룸실험`/`!보룸켜`/`!보룸중지`/`!보룸찾기`
- `sender/src/voice-probe.mjs`: 음성 서버 포트 프로빙(raw/TLS/LOCO)
- 게이트: 환경변수 `SENDER_VOICE_EXPERIMENT=1` 또는 `SENDER_VOICE_KEEP=1`
- `sender/README.md`: 위 환경변수·명령어 문서화

`npm run check` / `node src/selfcheck.mjs` 통과 상태.

> 참고: `voiceSetMeta`·`voice-keep`·`!보룸*` 계열은 **임의값(가짜 csIP/callId)으로 "보이스룸 라이브" 신호를 보내는** 실험층이다. 실제 음성 세션(VCS 미디어)은 없다.

---

## 3. 리버싱 환경 / 기법

- 분석 대상: `com.kakao.vox.jni.VoxCore` → `libVoxCore.so` (arm64, 7.2MB). OpenSSL 3.2 + pjsip(pjproject) 정적 링크. 빌드 경로 문자열: `Vox-Android`.
- 실험 기기: Windows + BlueStacks 5 (x86_64 / Android 11, arm64 앱을 Intel Houdini로 번역 실행), frida 17, root.
- **훅 기법(확인됨)**:
  - ART/JNI(x86)는 frida `Java.use`로 안정 훅.
  - arm64 네이티브는 `Interceptor.attach`가 Houdini에서 크래시(`0xdead0000`). → **GOT 슬롯을 덮어써서 libVoxCore `.text` 코드케이브(0x4adac0)에 심은 arm64 베니어로 분기**시키면 크래시 없이 가로채기 성공. (`SSL_write`/`SSL_read` 평문 캡처에 사용)
  - `mirror::String` 직접 읽기(abort 회피), 베니어 arm64 명령 손인코딩(capstone 검증) 등은 핸드오프 vcs55~61 기법 그대로.
- 사용 캡처 스크립트: vcs62~69 (PC 보관). 역할 — 62: VoxCore 메서드 열거, 63/64: JNI 데이터 경로·리스너, 65~67: SSL_write 캡처, 68: SSL_read 캡처, 69: SetVConfig+SSL_write 동시 캡처.

---

## 4. VCS 프로토콜 — 확인된 사실

- **전송**: pjsip SSL 소켓 + OpenSSL `TLS_method` → `vox.kakao.com`(세션마다 host:port 바뀜). 서버 인증 = 내장 DigiCert 루트(`GetCaCerts`). QUIC 코드는 존재하나 VCS는 미사용. CDR 서버 `mvoip-cdr.kakao.com`, 샌드박스 `vox-cdr-sb.sandbox.onkakao.net`.
- **미디어**: DTLS-SRTP + Opus. SDP offer는 `MakeVoiceRoomCall`의 String 인자(p12)로 **평문** 전달.
- **콜 셋업 JNI**: `SetVConfig(12 strings)` → `SetLocalNetwork("0.0.0.0",2/0)` → `SendNetworkEvent(1)` → `MakeVoiceRoomCall(csIP, csPort, bool, csIP6, csPort6, bool, chatId, userId, 1, title, 11, 3, SDP, true, true)` → `HangUp`. host:port·chatId·userId는 상위(LOCO/HTTP)에서 공급. 방 개설 HTTP: `POST open.kakao.com/c/voiceroom/user`.
- **와이어 프레임(양방향 확인)**: 12바이트 헤더 + 페이로드.
  ```
  [0:4]  u32  논스/시퀀스
  [4:6]  0x0000
  [6:8]  u16  메시지 타입
  [8:10] u16  페이로드 길이 (little-endian)
  [10:12]0x0000
  ```
  인바운드는 헤더 12바이트를 먼저 읽고 길이@8만큼 페이로드를 읽음. 타입: `0x7530`(핸드셰이크/제어, 첫 교환 out 304B / in 208B), `0x2b` 계열(데이터/SDP), keepalive `0x2b07` ~30초 주기.
- **SetVConfig 캡처값(세션 불변)**: p5 = `10adcc35eb09f92ebd9a87e42c158ee59a14effcd45ad21559540f3f4e67a85c` (32바이트), p6 = `e923488b28a34d01a29f0d778b06289b00000017921424506760010VXJnS0cgX5`.

---

## 5. 멈춘 지점 — 내부 페이로드 암호 (미해결)

프레임의 **페이로드가 암호화**돼 있음(엔트로피 7.03 bits/byte, 반복 없음). 확인된 성질:
- **키가 세션 불변(정적)** — 같은 제어 메시지의 첫 16바이트 암호문이 서로 다른 세션(프로세스 베이스 다름)에서 동일.
- **결정적 블록 암호**로 보임 — 모든 페이로드 길이가 16의 배수.
- 표준 암호(AES/ARIA/SEED/Camellia) × 모드(ECB/CBC/CTR/GCM) × 캡처된 키 후보(p5/p6 및 그 해시·파생)로는 **복호 실패**.
- libVoxCore의 VCS 코드가 OpenSSL EVP/저수준 AES를 **직접 호출하지 않음** → 내부 암호는 커스텀/인라인이거나 비자명한 키 유도로 추정.

**이 암호층을 넘는 작업은 중단함.** 그 이상은 카카오의 암호·자동화 방지 보호를 우회하여 권한 없는
제3자 서비스를 자동화하는 것에 해당하여, 더 진행하지 않기로 함. (암호 해독·VCS 재현·앱 하이재킹 포함)

---

## 6. 한 줄 요약

실험 환경·훅 기법·VCS 전송/프레이밍/JNI 입력까지는 확보했고, **내부 페이로드 암호에서 멈췄다.**
그 지점부터는 보호조치 우회·무권한 자동화라 중단.
