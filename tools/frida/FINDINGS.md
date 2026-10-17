# 보이스룸 켜기 — 리버싱 결과 (진행 중)

## 결론: 개설은 HTTP 가 아니라 VoxCore 네이티브다
오픈채팅 보이스룸 "켜기"는 LOCO 메타(type 16)로도, 평범한 HTTP POST 로도 안 된다.
방장이 켜는 순간 앱은 **`com.kakao.vox.jni.VoxCore.MakeVoiceRoomCall(...)`** 네이티브 메서드를 부른다.
그 신호가 음성서버(csIP:csPort)로 가고, 서버가 그 결과로 LOCO 에 liveon 메타(type 16)를 뿌린다
→ 그래서 클라이언트가 type 16 을 직접 못 쓰는 것이다(서버 전용). 2026-10-17 frida 실측.

## 캡처한 호출 (인자 순서)
```
VoxCore.MakeVoiceRoomCall(
  csIP(str),      // 음성서버 IPv4  예: 211.183.214.122
  csPort(int),    // 예: 5242
  bool,
  csIP6(str),     // IPv6
  csPort6(int),
  bool,
  chatId(long),   // 방 chatId — frida long→double 로 끝자리 반올림됨. 재현 시 문자열로 다룰 것
  userId(long),   // 켜는 사람
  int(=1),
  title(str),     // 방 제목(사용자 입력)
  int, int,
  sdp(str),       // ★ 평문 WebRTC SDP offer (아래)
  bool, bool)
```
csIP/csPort 는 직전 `GET https://open.kakao.com/c/voiceroom/user` 응답에서 받아온 것으로 보임.

## 미디어 스택 = 구글 libwebrtc 확정
SDP offer 가 전형적 libwebrtc:
- `a=msid-semantic: WMS ARDAMS` (Android libwebrtc 마커)
- `a=rtpmap:111 opus/48000/2`, `minptime=10;useinbandfec=1`
- `transport-cc`, `rtcp-mux`, `rtcp-rsize`, DTLS `a=setup:actpass`, `a=sendonly`
→ 문서 §4.2(pjmedia vs libwebrtc) 미지수 해결. 봇 측 미디어는 **werift / @roamhq/wrtc** 로 가능.

## 켜기 전체 흐름
```
GET /c/voiceroom/user           (HTTP, 쉬움)   → csIP:csPort 할당 받기
  → libwebrtc SDP offer 생성     (werift)
  → VoxCore 신호(MakeVoiceRoomCall 상당) 를 csIP:csPort 로 전송   ← VCS 프로토콜(문서 §4·§5)
  → 서버가 liveon 메타 뿌림       → 방 켜짐
```

## 남은 벽
- VCS 와이어 프로토콜: 12바이트 프레이밍 + pack 레이어 + 페이로드 암호(libVoxCore.so 내부, arm64 → Houdini).
- MakeVoiceRoomCall 은 **평문** SDP 를 받으므로, 프레이밍·암호는 그 아래 네이티브에서 일어난다.

## 다음
- (A 진행중) VoxCore 13개 메서드 전체를 켜기→유지→끄기 한 사이클 동안 캡처해 신호 순서·keepalive·종료 메서드 파악.

---

## 전체 신호 순서 (2026-10-17, 켜기→유지→끄기 한 사이클 실측)
VoxCore JNI 77개 메서드 중 켜기에 실제로 쓰인 순서:
```
GET /c/voiceroom/user → 200
SetLocalNetwork("0.0.0.0",2); SendNetworkEvent(1)
SetVoxProperty(7,"45005"); SetVoxProperty(8,"45005")        # MCC/MNC
SetVoxPropertyInt(9,0); SetVoxPropertyInt(11,13)            # nettype(13=LTE)
SetVConfig(ver, country, "", lang, "", <64hex>, <token>, model, os, sdk, voxver, build)
MakeVoiceRoomCall(csIP, port, true, csIP6, port6, true, chatId, userId, 1, title, 11, 3, <SDP>, true, true) -> callId
# 오디오 파이프라인 시작 (AudioFilterInit / SpeexResamplerInit 48000->16000 / DownBitPerSample32To16 / AudioFilterProcessing / WebRtcAudioRecordAgcProcessVad, 10ms 프레임)
...
HangUp(callId, 0)                                          # 끄기
SetARSdkInfo / UpdateSystemQOS / SetAppSummaryInfo / GetCaCerts
```

## SetVConfig 인자 (세션 자격증명)
```
"26.8.3"  "KR"  ""  "ko"  ""
"<64 hex>"          # 세션 불변 키 (문서 §5.5 의 그 64hex)
"<긴 토큰>"          # ...00000017922005459000010wsRHFmESaQ 류
"SM-S901E" "android" "30" "2.1.0" "a/.../S901EXXU2AVH9"
```
출처(어디서 받아오는지)는 아직 미확인 — `/c/voiceroom/user` 응답 바디 또는 로그인일 가능성.

## 서버 / 미디어 (UpdateSystemQOS 실측)
- CallServer `203.133.189.66:5242/tls` (실제 접속), SessionServer `211.249.241.72:5242/tls`
- 미디어 = **서버 relay(SFU)**: local -> `203.133.190.66:31092`, dir SendOnly, opus 64kbps (P2P 아님)
- `MediaVersion: webrtc_m130`, `OpenSSL: 3.3.6`, VoxSdk `85d0ba76 2026-09-03`

## 방 제어 = VRC* 메서드
VRCChangeTitle / VRCInviteAsSpeaker / VRCRequestSpeakerPermission / VRCAuthorizeSpeakerPermission /
VRCInviteAsModerator / VRCRevokeSpeakerPermission ... → 발언자·진행자 모델 확정(문서 §3.5).

## 남은 벽 = VCS 와이어 프로토콜
위 JNI 인자는 다 평문으로 확보했지만, 이것들이 CallServer:5242(TLS)로 나갈 때의
**바이트 인코딩(프레이밍 + pack + 암호)** 은 libVoxCore.so(arm64) 내부라 아직 미해독.

## 두 갈래 길
- 실용(1계정): frida 로 앱의 VoxCore 를 직접 호출해 방을 켠다(VCS 재구현 불필요). 앱 상주 필요, 동시 1방.
- 완전(standalone): VCS 와이어 리버싱 후 Node 로 재구현. 다중방 가능, 대신 큰 작업(문서 2~3개월 추정).

---

## B1 정적분석 결과 (libVoxCore.so 디스어셈블, 2026-10-17)

### 암호 미스터리 해소 — 커스텀 레이어 없음
- `depack_do_frame_*` / `ssl/quic/quic_rx_depack.c` 는 전부 **OpenSSL 3.3 QUIC** 표준 코드였다.
  문서 §4.4/§5가 "pack 레이어 = 커스텀 암호"로 본 것은 오독. **커스텀 암호·프레이밍 레이어는 없다.**
- VCS 신호 전송 = pjsip `ssl_sock_ossl.c` + 정적 OpenSSL 3.3.6 → **와이어 암호는 표준 TLS뿐.** 깰 암호 없음.
- 미디어 = 표준 DTLS-SRTP(`SRTP_AES128_CM_SHA1_80` 등) / libwebrtc m130 → werift 로 재현 가능.

### 접속 서술자(JSON) — 봇 TLS 접속에 필요
바이너리 .rodata 의 JSON 키: `CallServer/CallServer4/CallServer6`, `SessionServer/4/6`, `AltPorts`,
`SNI`, `Cert`, `ConnectInfos`, `RetryConfig`, `ConnectionTimeoutSec`, `VoxProtocolVer` …
→ 서버 IP·포트·SNI·인증서·재시도 설정이 JSON 으로 내려온다(출처는 `/c/voiceroom/user` 로 추정).

### VCS 메서드 사전 (C++ job 클래스)
`VoxJobMakeVoiceRoomCall`, `VoxJobJoinVoiceRoomCall`, `VoxJobVRCInviteAsSpeaker/AsModerator`,
`VoxJobVRCRequest/Authorize/Revoke/CancelSpeakerPermission`, `VoiceRoomMemberTable`,
결과 콜백 `OnVRC*Result` … → 요청/응답 RPC, 메서드명이 곧 이 이름들.

### 남은 벽 = 와이어 메시지 바이트 포맷 (정적 RE 필요)
- 동적(SSL_read/write 평문)은 **Houdini 가 arm64 를 x86 번역·실행**해서 HW 브레이크포인트조차 안 걸림 → 불가.
- JNI `MakeVoiceRoomCall`(0x30dc54) → `sub_318f24`(스트립) → VoxJob → state → serializer → ssl_sock send.
  와이어 포맷은 이 스트립된 C++ 체인을 따라 디스어셈블해야 나온다(깊고 느린 작업, 암호 벽은 없음).

### 결론
암호 벽은 사라졌지만, 와이어 포맷 복원은 스트립된 C++ 호출 체인을 정적으로 뜯는 큰 작업이다.
pragmatic 대안(frida 로 앱의 MakeVoiceRoomCall 직접 구동)은 1계정·동시1방 한계로 바로 동작 가능.

---

## VCS 프로토콜 명령/이벤트 지도 (libVoxCore 정적분석, 2026-10-17)
공용 베이스 생성자 `sub_0x336324(this, name, id, ...)` 의 55개 호출부에서 (id, name) 추출.
요청(Job)·상태이벤트·응답처리기가 한 체계로 번호 매겨져 있어 프로토콜 전 흐름이 드러난다.

접속/세션:   0x7fa ConnectVcs · 0x809 ConnectVss · 0x819 Disconnect · 0x830 Init
             0x1199 OnConnected · 0x11aa OnReConnected
통화 생성:   0x200 MakeVoiceRoomCall · 0x22f JoinVoiceRoomCall · 0x24b Answer
             0x16d MakeGroupCall · 0xd1 VCall · 0x962 MakeVoiceRoomCall(상태층)
협상/미디어: 0xb01 SendGetConfRequest · 0x2e2 SendMediaDescription · 0x341 SendICEDescription
             0x29e UpdateMedia · 0x3c7 SendVideoACCInfo · 0x2be AddMember
앱스트림:    0x594 CreateAppStream · 0x5b8 UpdateAppStream · 0x5e1 DeleteAppStream
             0x5f9 UpdateAppMediaStream · 0x60e AddAppMediaControl
응답/알림:   0xb8c ProcessInviteResponse · 0xc07 ProcessJoinResponse · 0xc4b ProcessJoinNotification
             0xca1 ProcessEndNotification · 0xe05 ProcessHangupResponse · 0xe10 ProcessCallableResponse
             0xe91 ProcessGetConfResponse · 0xea3 ProcessAddMemberResponse
             0xec7 ProcessChangeMediaNotification · 0xee8 ProcessChangeMediaResponse
             0xd0e ProcessUpdateResponse · 0xd27 ProcessProgressResponse
상태머신:    0x11fc HandleCallInvited · 0x1211 HandleCallEstablished · 0x124d HandleCallEnded
             0x1273 HandleCallEndedByRemote · 0x129f HandleCallValidated · 0x12b2 HandleCallUpdatedBeforeAnswer
에러/네트워크: 0x770 RequestHangUpByError · 0x75c RequestAppStreamError · 0x64c OnNetworkEvent · 0x714 NetworkEventHandler

해석: 클라가 ConnectVcs/Vss 로 TLS 접속 → SendGetConfRequest 로 방 설정 받고 →
MakeVoiceRoomCall(SDP 포함) 전송 → ProcessInvite/JoinResponse 로 응답 →
SendMediaDescription/SendICEDescription 로 미디어 협상 → HandleCallEstablished.
종료는 HangUp → ProcessHangupResponse / ProcessEndNotification.

### 다음(미완): 와이어 바이트 포맷
id/name 은 내부 이벤트 번호다. 실제 TLS 로 나가는 프레임(헤더+바디 인코딩)은
요청 객체의 serialize 경로를 더 따라가야 확정된다. (암호는 없음 — TLS 평문 구조)

---

## ★ VCS 와이어 = BSON (해독, 2026-10-17)
`VBsonEnc`/`VBsonDec` (RTTI) + `"%s(method %s) bson error)"` + `"no method specified"` 확인.
→ **VCS 신호 바디 = BSON 문서**, 각 메시지에 문자열 `method` 필드. LOCO 채팅과 같은 BSON 계열.
   전송 = pjsip TLS 소켓(CallServer:5242) → 커스텀 암호 없음, 평문 BSON(TLS 안).

### BSON append 헬퍼 (VBsonEnc 메서드)
- `sub_0x365fdc` = append(key, int/enum) — 254 호출부
- `sub_0x365f6c` = append(key, str/long) — 90
- `sub_0x365f8c` / `sub_0x365f94` = append 변종 — 47/47
- `sub_0x365efc` = method/sub-doc 설정 — 91 (값이 명령 이름: SendGetConfRequest, SendMediaDescription, SendICEDescription, UpdateMedia, AddMember, QueryCallable …)

### BSON 키 사전 (append 호출부에서 수집, adrp-문자열만이라 일부 누락)
식별/통화: method(명령명) · userId · destId · sdpUserId · appUserId · title · titleMode · MID · Desc(=SDP로 추정)
          isMultiChat · callable · completed · control · remainTime · reason · resCode · status · count
미디어:    mediaType · audioState · videoState · sdpType · sdpMLineIndex · MLineIdx · voiceFilter · audioFilter
          videoFEmo · videoBEmo · videoAlt · defaultMicOnOff · defaultCamOnOff · shareMode · recordCount
ICE/net:   ICEType · candidateType · NetWorkType · netType · mobileNetType · isRoaming · remote
          cs4Port · cs6Port · iceInactiveTimeout · iceUnwritableTimeout · iceUnwritableMinChecks
디바이스:  devType · devSubType · userType · serviceType · feature · voxVer · coreSystemInfo · appData · appDetailInfo
핸즈업/권한: handsUp · (+ VRC* 메서드들)

### 남은 것 (구현 전 확정 필요)
1. 패킷 헤더 바이트(길이 프리픽스 형식) — LOCO 와 동일 추정(agent-messenger 코덱 재사용 가능성).
2. 핵심 키 일부(chatId·callId·sdp 정확한 키명) — 레지스터 로드라 adrp 수집에 안 잡힘. MakeVoiceRoomCall 빌더 직접 디스어셈블로 확정.
3. VCS 핸드셰이크/인증 — SetVConfig 의 두 토큰(64hex, 긴 토큰)이 TLS/VCS 세션을 어떻게 인증하는지.

### 구현 경로 (B)
Node: TLS 소켓(CallServer:5242, SNI/Cert 는 /c/voiceroom/user 응답) → LOCO식 [헤더][BSON] 프레이밍
 → ConnectVcs/GetConf/MakeVoiceRoomCall(method+BSON, SDP 포함) → 응답 파싱 → werift 로 DTLS-SRTP 미디어.
암호 벽 없음. 남은 건 헤더·키 확정 + 핸드셰이크 + 구현/테스트.

---

## VCS TLS 접속 실측 (2026-10-17, PowerShell SslStream)
CallServer csIP:5242 로 직접 TLS 접속 테스트한 결과:
- TLS1.2 / AES128 핸드셰이크 **성공**
- 서버 인증서 = 공개 정상 인증서: `CN=kakao.com, O=Kakao Corp.` / issuer `Thawte TLS RSA CA G1`(DigiCert). → 봇은 공개 루트로 검증 가능(SNI = 실제 kakao 호스트명 필요; IP 접속은 name-mismatch 정상).
- **mTLS 아님** — 클라이언트 인증서 없이 핸드셰이크 성공. (descriptor 의 "Cert" 는 서버 검증용으로 추정)
- **서버가 먼저 보내지 않음** → 접속 직후 **클라이언트가 first-speak**. 즉 로그인/핸드셰이크 패킷을 클라가 보내야 하고, 여기에 SetVConfig 의 토큰(64hex·긴토큰)이 들어갈 것으로 보인다. ← 다음 확정 대상.

---

## VCS 첫 패킷 실측 (2026-10-17): LOCO-22B 헤더는 거부됨
TLS 접속 후 `[22B LOCO 헤더][빈 BSON]`(method="GetConf")를 1개 보냄 → 서버가 **즉시 연결 reset**.
- 서버가 바이트를 받고 능동 거부(무시 아님).
- method 가 BSON 바디에 있으므로(이름이 11B 초과) VCS 헤더는 LOCO 11B-method 형식이 아니다.
  → 프레임은 `[u32 len]+BSON` 또는 raw BSON 쪽이 유력. (미확정)
- reset 만으로는 "프레임 오류" vs "로그인 선행 필요" 를 구분 불가. 추측 전송 반복은 계정 위험.
- 결론: 프레임 포맷 + 로그인 패킷은 **정적 RE로 확정**해야 안전(가상호출 많아 느림). 또는 소수의 신중한 탐색.

---

## ★★ VCS 프로토콜 — Ghidra 디컴파일로 확정 (2026-10-17)
libVoxCore 를 Ghidra 로 디컴파일해 와이어 모델을 복원했다.

### 프레임 = [헤더(숫자 명령코드)] + [BSON 바디]
LOCO 11바이트 method **문자열이 아니라 숫자 명령코드**가 헤더에 들어간다.
→ 그래서 앞서 LOCO-22B(문자열 method)·raw-BSON 둘 다 서버가 reset 한 것.

### 패킷 객체 (SendRequest FUN_0x439110 → 생성자 FUN_0x4603b8, 0x40바이트)
```
+0x00  vtable
+0x08  packetId   u32   (rand()%0x7ffffffe, 요청마다)
+0x0c  statusCode u16   (요청=0)
+0x0e  command    u16   (숫자 명령코드, 아래 맵)
+0x18  bson ptr / +0x20 bson len   (BSON 바디 복사본)
+0x38  type       u8    (=1)
```
전송: `SendRequest(this, code, bsonEnc)` → 패킷 생성 → `transport(this+0xcf0)->vtable[0x30](pkt)` 가 TLS 소켓으로 직렬화.
(직렬화 함수 자체 = transport vtable+0x30, 간접호출 뒤라 바이트 순서는 미확정 — 유일한 남은 빈칸.)

### BSON 바디 = 타입별 key/value (method 필드 없음)
BSON 인코더: init FUN_0x465efc(buf,0x4000) · append long FUN_0x46601c(k,v) · append int FUN_0x465fdc(k,v) · buf ptr/len FUN_0x465f94/f8c.
예(UpdateMedia, code 0x2731): `{userId:long, devType:int, mediaType:int, callId:long, videoState:int}` — method 없음.

### 와이어 명령코드 맵 (SendRequest 호출부 45개에서 추출)
```
0x272c MakeVoiceRoomCall   ← 보룸 개설 (핵심)
0x2722 MakeGroupCall       0x272a AddMember
0x2730 SendMediaDescription  0x2724/0x272d SendICEDescription  0x2731 UpdateMedia
0x2743 CreateAppStream 0x2745 AddAppMediaControl 0x2747 DeleteAppStream 0x2749/0x274b UpdateApp*Stream
0x2b04~0x2b29  VRC* (발언자/진행자 제어군)
0x7530 QueryCallable       0x7531 SendGetConfRequest
```
(문서의 "0x7530 out 304B" 캡처가 QueryCallable 과 일치 — 코드 체계 검증됨.)

### 접속 흐름 (확정)
```
TLS connect(CallServer:5242, 표준 cert, mTLS 아님, 커스텀 암호 없음)
  → QueryCallable(0x7530) → SendGetConfRequest(0x7531)  [방 설정 수신]
  → MakeVoiceRoomCall(0x272c, BSON: userId/chatId/title/SDP/cs.. )
  → ProcessInvite/JoinResponse → SendMediaDescription(0x2730)/SendICEDescription(0x2724)
  → HandleCallEstablished → (미디어: DTLS-SRTP/libwebrtc) → HangUp
```

### 남은 단 하나: 와이어 헤더 바이트 순서
packetId/status/code/type/bsonLen 가 와이어에 어떤 순서·엔디안으로 나가는지(transport 직렬화). LE 추정:
`[packetId u32][status u16][code u16][type u8][bsonLen u32][bson]`(13B 헤더) — 서버 응답으로 확정 필요.
나머지(명령코드·BSON 스키마·흐름·접속)는 전부 확정.
