# 카카오톡 보이스룸 멀티룸 유지 — 리버싱 핸드오프 문서

> **이 문서의 목적**: 카카오톡 오픈채팅 "보이스룸"을 **여러 방에서 동시에 48시간 유지**(꺼지면 자동 재개설)하는 봇을 만들기 위한 리버싱 결과 정리. 다음 작업자(Claude/개발자)가 이어받아 **VCS 음성세션 프로토콜 리버싱 + 멀티세션 클라이언트 구현**을 할 수 있도록 지금까지의 모든 발견을 담는다.
>
> **현재 상태**: 신호/제어 계층(채팅 LOCO, 멤버조회 WebSocket, HTTP, 데이터구조)은 **완전 해독**. 정작 "유지"의 핵심인 **VCS 실시간 음성세션 프로토콜(네이티브 libvox)은 미해독** = 남은 핵심 과제.

---

## 0. 목표와 제약

- **목표**: 봇 계정(오픈채팅 **부방장** 권한)으로 보이스룸을 켜고, **여러 방에서 동시에**, **48시간** 유지. 꺼지면 자동 재개설.
- **기존 봇**: `agent-messenger`(LOCO) 기반 채팅 매크로 봇 (이 레포). 보이스룸 기능은 없음.
- **경쟁 봇(목표 레퍼런스)**: "Vr Bot" — **한 계정이 여러 보이스룸에 동시에 스피커로 참가**하고 노래도 재생. (스크린샷으로 확인)

---

## 1. 핵심 결론 (TL;DR)

1. **보이스룸 `liveon` = 실제 음성 참가자(세션)가 방에 있어야 유지.** 참가자 0 → 즉시 `liveon:false`. (실측 캡처로 증명)
2. **참가자 세션 = 네이티브 음성엔진(`com.kakao.vox.jni` / libvox `.so`)이 VCS(Voice Call Server)에 붙어 유지.**
3. 채팅 LOCO 명령(SETMETA 등), 멤버조회 WebSocket, HTTP로는 **유지 불가** (확인 완료).
4. **한 계정이 여러 방 동시 = 앱으로는 불가능(1세션 제한).** 경쟁 봇은 **커스텀 VCS 클라이언트**로 한 계정 멀티세션을 구현 → 이게 핵심 자산.
5. **남은 과제 = VCS 음성세션 프로토콜 해독 + 멀티세션 유지 클라 구현.** (네이티브 영역, 미해독)
6. **희망 가설**: "유지"만이면 실제 오디오 코덱 없이 **세션 핸드셰이크 + keepalive만** 재현해도 될 가능성. → 검증 필요.

---

## 2. 보이스룸 전체 아키텍처 (APK 분석 확정)

```
[1] HTTP (VoiceroomApi):  voiceroom/user , voiceroom/user/acceptAgreements
      → 등록/약관 동의, 방 접속정보 획득:
        VoiceroomCallInfo { chatId, userId, callId, vcsHostV4, vcsHostV6, vcsPort }

[2] 멤버조회 (neocore, Kotlin):  wss://<vcsHost>:<vcsPort>
      → VMessage 바이너리로 "현재 참가자 목록" 1회 질의 (requestOnce)
      → ★ 읽기 전용. 유지와 무관. (단, 프로토콜은 아래 [3]과 같은 VCS일 가능성 → 참고용으로 완전 해독됨)

[3] 실시간 음성세션 (com.kakao.vox.jni → libvox .so, 네이티브)   ★★ 유지의 핵심 / 미해독
      → vcsHost:vcsPort 에 붙어 음성세션 보유 (아마 UDP)
      → 서버가 "참가자 있음" 인식 → liveon:true, 채팅방에 CHGMETA 방송
      → 멀티세션(한 계정 여러 callId) = 경쟁봇의 커스텀 구현

[4] 채팅 방송 (LOCO):  서버가 [3]의 상태를 방에 뿌리는 알림. 클라가 직접 못 씀.
```

---

## 3. 완전히 리버싱된 부분 (재사용 가능)

### 3.1 채팅 LOCO 신호 (관찰용)
서버가 뿌리는 방송. 클라가 직접 생성 불가.
- `CHGMETA` `meta.type = 16` = **LIVE_TALK_INFO**: `{liveon, title, updateTime, startTime, csIP, csIP6, csPort, callId, url, blind}`
- `CHGMETA` `meta.type = 17` = **LIVE_TALK_COUNT**: `{count}`
- `MSG` `chatLog.type = 52` = vr_invite / vr_bye: `{csIP, csIP6, csPort, callId, duration}`

### 3.2 멤버조회 WebSocket — VMessage 프로토콜 (완전 해독)
> `com.kakao.vox.neocore.*` (classes13.dex). ktor WebSocket + 커스텀 VMessage 바이너리.

**WebSocket 연결** (`VoxHttpClient`):
- URL: `wss://<host>:<port>` (host가 IPv6면 `[host]`로 감쌈). host=vcsHostV4/V6, port=vcsPort.
- 엔진: ktor + OkHttp. **VoxCerts의 핀된 CA 인증서(PEM)** 사용, hostnameVerifier = 항상 true, TLS.
- 타임아웃: CONNECT 10000ms, RESPONSE 10000ms, CLOSE 1000ms.
- **requestOnce**: 연결 → **바이너리 프레임 1개 전송** → **바이너리 프레임 1개 수신** → **연결 종료**. (일회성 req-res)

**VMessage 포맷** (`VMessageEncoder/Decoder/Header`):
- 전체 메시지 = **헤더(12바이트) + 본문**
- 헤더 (리틀엔디안):
  | 필드 | 타입 | 비고 |
  |---|---|---|
  | packetId | uint32 | 매 메시지 랜덤 |
  | statusCode | uint16 | 요청=0 |
  | methodId | uint16 | 메시지 종류 |
  | bodyLen | uint32 | 본문 길이 |
- 본문 = **kotlinx 바이너리 직렬화**(protobuf/cbor 계열)로 직렬화된 `@Serializable` 데이터클래스.
  - 인코딩: `mx30`(직렬화 포맷 객체) → `ete0`(ByteArrayOutput)으로 byte[] 생성 → 앞에 헤더 붙임.
  - 디코딩: 앞 12바이트 제거 후 역직렬화.
  - ※ 정확히 protobuf인지 cbor인지는 `mx30` 클래스를 더 봐야 확정. (둘 다 kotlinx-serialization)

**methodId / 상수** (`VMessageKey`):
- `0x2b06` = **11014** : MemberListRequest (보이스룸 멤버 조회)
- `VOX_PROTOCOL_VERSION` = 5
- `MSG_VERSION_30` = 0x3e8 = 1000
- `V_METHOD_VALIDATE` = 0x271e = 10014  ← "validate" 메서드 (용도 미확인, 참가/검증 관련 추정)

**멤버조회 호출 흐름** (`NeoCoreFacade` → `MemberListRepository` → `MemberListDataSource`):
```
getVoiceroomMemberList(host, port, userId:Long, chatId:Long, callId:Long, deviceConfig)
 → MemberListRequest.create(userId, chatId, callId, deviceConfig)
 → VMessageEncoder.encode(methodId=11014, request) = header + body
 → VoxHttpClient.requestOnce(host, port, bytes)  (wss 1회 req-res)
 → VMessageDecoder.decode(resp, VoiceroomMemberListResponse)
```

### 3.3 데이터 구조
- **VoiceroomCallInfo** (방 접속정보, HTTP에서 획득):
  `{ chatId:Long, userId:Long, callId:Long, vcsHostV4:String, vcsHostV6:String, vcsPort:Int }`
- **VoxQueryMemberListParam**: `{ vcsHostV4:String, vcsHostV6:String, vcsPort:Int, userId:Long, chatId:Long, callId:Long }`
- **VoxDeviceConfig** (17필드): `deviceModel, osName, osVersion, buildId, skey, oauthToken, duuid, appVer, lang, country, deviceType:Int(기본1), devSubType:Int(기본2), isRoaming:Int, mobileNetType:Int, carrierId, simOperator, netType:Int`
  - 기기정보 기본값은 `com.kakao.vox.utils.Utility`에서 (model/osName/sdkInt/buildId).
- **VoiceroomOpenChatUserType**: Host("h") / Staff("s") / Normal("m")  — 오픈채팅 내 역할 코드.

### 3.4 인증에 필요한 값
- VCS/멤버조회에 쓰는 핵심 인증 필드: **`skey`, `oauthToken`, `duuid`** (VoxDeviceConfig 안).
- 이 값들은 기존 봇(`agent-messenger`)의 로그인 세션에서 얻을 수 있어야 함 (확인 필요 — 토큰 종류 매핑).

### 3.5 HTTP 엔드포인트 (VoiceroomApi)
- `voiceroom/user`
- `voiceroom/user/acceptAgreements`
- `c/voiceroom/fraud/report*` (신고용, 무관)
- ※ "create/join"으로 보이는 별도 엔드포인트는 문자열상 안 보임. `voiceroom/user`(POST)가 등록+접속정보 반환 역할일 가능성. **VoiceroomApi 구현(retrofit 인터페이스)을 더 확인 필요** (classes11.dex의 `VoiceroomApi` 검색).

---

## 4. 배제된 접근 (다시 시도 X — 실측으로 확인)

| 시도 | 결과 | 의미 |
|---|---|---|
| `SETMETA(type16, liveon:true)` 직접 전송 (필드 다 채움) | **-203** INVALID_PARAMETER | LIVE_TALK_INFO는 서버 전용 메타, 클라 못 씀 |
| 후보 LOCO 명령어 33개 탐색 (LIVETALK/CREATEVR/GETVOIP…) | **전부 -300** | 그런 명령 없음 (대조군: WRITE→-203, GETMEM→0, 가짜→-300) |
| 멤버조회 WebSocket으로 유지 | 불가 | `requestOnce` = 붙고 1개 주고받고 끊음 (읽기 전용) |
| `.so`를 Node/리눅스 서버에서 실행 | 불가 | 안드로이드 ARM 전용 |

---

## 5. 남은 핵심 과제 = VCS 음성세션 프로토콜 (미해독)

### 5.1 어디에 있나
- `com.kakao.vox.jni.*`, `VoxMediaManager`, `VoxCall30Source`, `IVoxManager`($VoxServerAddr, $VoxHostGroup, $AppMediaProfile, $OnVoxStateListener) = **네이티브 브리지(JNI)**.
- 실제 세션/미디어 로직은 **네이티브 `libvox.so`** (C/C++) 안.
- **주의**: 받은 dex(classes1~38, base.apk)에는 vox 모듈 **인터페이스/데이터클래스만** 있고 **구현(VoiceroomManager impl, VoxManager impl)과 .so는 없음** → **vox 기능 모듈이 별도 split APK(dynamic feature)일 가능성 큼.** 그 split APK + 그 안의 `lib/arm64-v8a/libvox*.so`를 따로 구해야 함.

### 5.2 알아내는 방법
1. **라이브 트래픽 캡처 (권장)**: 루팅 안드로이드에서 진짜 카톡으로 보이스룸 켤 때 —
   - `tcpdump`로 vcsHost:vcsPort(보통 9000) 트래픽 캡처 (UDP/TCP 확인).
   - **Frida로 libvox의 send/recv(또는 암호화 함수) 후킹** → 암호화 직전/직후 평문 바이트 확보. (UDP 페이로드가 암호화돼 있으면 raw pcap만으론 부족)
2. **libvox.so 정적 리버싱**: split APK에서 .so 추출 → Ghidra/IDA로 ARM 디스어셈블. (어려움)

### 5.3 "유지 전용" 가설 (검증 포인트)
- `liveon`/`count`가 **오디오 프레임**에 묶였나, 아니면 **세션 접속/keepalive(참가 자체)**에 묶였나?
- 최초 캡처상 "참가자 있음"이면 유지됨 → **오디오 없이 세션만 붙잡아도 유지될 가능성**. (join + periodic keepalive만 재현)
- 이게 참이면: Node로 keepalive 세션을 **여러 개 동시** 보유 = 멀티룸. (코덱 불필요 → 난이도 급감)
- 거짓이면(오디오 프레임 필요): 코덱(Opus 등)까지 구현 → 난이도 상승.
- **→ 트래픽 캡처 후 "오디오 끊고 keepalive만 보낼 때 liveon 유지되는지" 실험으로 확정.**

---

## 6. 목표 구현 설계 (멀티룸 유지 봇)

```
서버(Node 등) 1프로세스:
  방마다 세션 핸들 1개:
    1) HTTP voiceroom/user(+acceptAgreements)로 VoiceroomCallInfo 획득
       (vcsHost, vcsPort, callId)  — 또는 재개설 시 새 callId
    2) VCS 세션 open: 핸드셰이크 + 인증(callId, userId, skey/oauthToken/duuid 등)
    3) keepalive 루프 (간격 = 캡처로 확정)
    4) (옵션) 오디오 송출 — 유지만이면 생략
  N개 방 = N개 세션 핸들 동시 보유 (멀티플렉싱)
  감시: liveon 꺼짐/48h 경과 감지 → 재개설(1~4 반복)
```
- 인증 토큰은 기존 봇의 카카오 로그인 세션에서 공급 (skey/oauthToken/duuid 매핑 확인 필요).
- 재개설 트리거: 채팅 CHGMETA(16) `liveon:false` 수신 또는 타이머.

---

## 7. 다음 단계 (구체적 TODO)

1. **vox 기능 split APK + libvox.so 확보** (base.apk엔 없음. 전체 설치본에서 split 추출 / APK 전체 재다운로드).
2. **라이브 캡처 환경 구성**: 루팅 안드로이드 + frida-server + PC frida-tools + tcpdump.
3. **보이스룸 켜면서 캡처**: vcsHost:vcsPort 트래픽 + libvox send/recv 후킹 평문.
4. **VCS 프로토콜 복원**: 전송(UDP/TCP), 핸드셰이크, 인증 필드, 암호화 여부/키, keepalive 간격, 프레임 포맷.
5. **"오디오 없이 유지" 가설 검증**: 세션만 붙잡고 오디오 안 보낼 때 liveon 유지되는지.
6. **Node 멀티세션 클라 구현** → 방 1개 PoC → N개 멀티플렉싱.
7. **기존 봇/서버와 연동**: 토큰 공급, 방 상태 감시, 자동 재개설, 패널 연동.
8. (정리) 현재 이 레포에 들어간 **막다른 실험 코드 제거**: `!보룸실험`·`!보룸찾기`·`voiceSetMeta`·`voiceProbe`·`/v1/bot/voice-experiment` (SENDER_VOICE_EXPERIMENT 뒤). — 유지와 무관으로 확정.

---

## 8. 필요한 것 / 환경
- **PC** (Frida, Ghidra, 캡처 분석) — 필수.
- **루팅 안드로이드** + 카카오톡(부방장 계정) — 라이브 캡처용.
- **frida / frida-server**, **tcpdump/Wireshark**, **Ghidra 또는 IDA**.
- **vox split APK + libvox.so** (arm64-v8a).
- 기존 봇의 카카오 로그인 토큰(skey/oauthToken/duuid) 접근.

---

## 9. 미확인 / 열린 질문
1. VCS 전송이 **UDP냐 TCP냐** (csPort 9000).
2. VCS 페이로드 **암호화 여부**와 키 유도 방식 (callId/token 기반?).
3. `liveon` 유지가 **오디오 프레임 필요** vs **세션 keepalive만으로 충분**.
4. **한 계정 멀티세션**에 서버측 제한이 있나 (경쟁봇은 되는 걸로 보아 없거나 우회).
5. `voiceroom/user` 응답에 vcsHost/callId가 들어오는지 (= VoiceroomApi 구현 확인).
6. VMessage 본문이 **protobuf냐 cbor냐** (mx30 클래스 확인) — 멤버조회/validate 재현 시 필요.
7. `V_METHOD_VALIDATE(10014)`의 용도 (참가 검증? 세션 유지?) — 캡처로 확인.

---

## 부록 A. 실측 캡처 (최초, 경쟁봇이 켜고 끈 로그)
```
CHGMETA(16) {"liveon":true,"title":"K bot 문의방","startTime":...,
  "csIP":"121.53.240.85","csIP6":"2404:4600:9:34e:121:53:240:85","csPort":9000,
  "callId":12332122417656334,"url":"https://open.kakao.com/o/p24yBGRi/vr/12332122417656334","blind":false}
CHGMETA(17) {"count":1}        ← 봇 참가
MSG(52) vr_invite {csIP,csPort:9000,callId,duration:0}
... (봇 나감)
CHGMETA(16) {"liveon":false,...}
CHGMETA(17) {"count":0}        ← 참가자 0
MSG(52) vr_bye {... duration:3}

※ 2회차는 csIP/callId가 다름(121.53.240.85→211.242.15.98) = 매번 새로 할당.
※ 결론: liveon ↔ 실제 참가자(count) 1:1. 참가자 0이면 즉시 꺼짐.
```

## 부록 B. 주요 클래스 경로
- `com.kakao.vox.neocore.data.vmessage.{VMessageEncoder,VMessageDecoder,VMessageHeader,VMessageKey}` (classes13.dex)
- `com.kakao.vox.neocore.data.datasource.remote.{MemberListDataSource,VoxHttpClient,VoxCerts}`
- `com.kakao.vox.neocore.domain.repository.MemberListRepository`
- `com.kakao.vox.neocore.NeoCoreFacade`
- `com.kakao.vox.neocore.domain.model.VoxDeviceConfig`
- `com.kakao.talk.module.vox.domain.model.{VoiceroomCallInfo,VoxQueryMemberListParam}`
- `com.kakao.talk.module.vox.domain.model.voiceroom.VoiceroomOpenChatUserType`
- `com.kakao.talk.module.vox.contract.internal.{IVoiceroomManager,IVoiceroomChecker}` (인터페이스만; 구현은 split로 추정)
- `com.kakao.vox.{IVoxManager,media.VoxMediaManager,call.VoxCall30Source,jni.*}` (네이티브 브리지)
- HTTP: `com.kakao.talk.module.vox...VoiceroomApi` (classes11.dex, 경로 확인 필요)

## 부록 C. 환경/버전 메모
- 분석한 APK: KakaoTalk 전체 ~265MB, dex 38개(classes.dex~classes38.dex), 핀 인증서 VoxCerts(PEM) 포함.
- 기존 봇 라이브러리: `agent-messenger@2.38.0` (LOCO). PC_APP_VERSION 참고값 26.2.0.
- LOCO 상태코드: 0=성공, -202=INVALID_METHOD, -203=INVALID_PARAMETER/BODY, -300=(이 서버) 없는 명령, -444=BLOCKED_IP 등.
