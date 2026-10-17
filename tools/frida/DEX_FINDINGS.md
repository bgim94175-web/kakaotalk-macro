# DEX_FINDINGS — KakaoTalk 보이스룸 Java/JNI 층 전수분석 (base.apk 디컴파일)

출처: Play 설치본 전체 묶음(base + split_config.arm64_v8a/xhdpi/ko)을 받아, `base.apk`의 dex 38개를
androguard 로 디컴파일. **앱 dex 는 DexProtector 로 암호화되어 있지 않아 전부 읽힘**(네이티브 .so 만 보호).
→ 보이스룸 전체 흐름을 Java 레벨에서 복원함. (네이티브 와이어 포맷은 `FINDINGS.md` 정적분석 참고)

---

## 0. 헤드라인 결론
1. **"켜기(개설)"의 유일한 길 = 네이티브 `VoxCore.MakeVoiceRoomCall`**. HTTP 개설 엔드포인트는 **없음**
   (`/c/voiceroom/` 아래엔 `fraud/reportRecording|reportDescription|reportTitle` 뿐). LOCO·QR·딥링크 다 개설 불가(기존 확인).
2. 봇이 필요로 하는 **서버주소·세션설정은 HTTP(`GET /c/voiceroom/user` → `VoiceroomUserResponse`)로 받음** → 헤드리스 가능성의 핵심.
3. **세션 자격증명 = `oauthToken`(계정 토큰, 봇이 보유) + `skey`(세션키) + `uuid` + version/country/dns/lang.**
4. 미디어 = **Google WebRTC m130**(`libjingle_peerconnection_so.so`, `org.webrtc.*`, IceServer) → werift 호환.
5. 남은 단 하나 = 네이티브가 소켓에 쓰는 **와이어 바이트 포맷**(정적분석에서 빅엔디안+구조 확보, 최종확정만 남음).

---

## 1. JNI 네이티브 API — `com.kakao.vox.jni.VoxCore` (헤드리스 클라이언트 인터페이스)
정확한 시그니처(디컴파일 실측). `public final native`.

```
Init()Z · UnInit()V · GetCaCerts()Ljava/lang/String;
SetVConfig(S S S S S S S S S S S S)V        ← 로그인/세션 (아래 §2)
SetLocalNetwork(S,I)V · SendNetworkEvent(I)I · UpdateSystemQOS(S,S,S)V
SetARSdkInfo(S)V · SetAppSummaryInfo(S)V · UpdateAppDetailInfo(S)V
SetCallStateListnerV3(Ljava/lang/Object;)V  ← 응답 콜백
SetCallId(I)V · GetState(J)I · GetMediaType(J)I
GetVoxProperty(I)I · SetVoxProperty(I,S)V · SetVoxPropertyInt(I,I)V

개설/통화:
MakeVoiceRoomCall(S csIP, I port, Z tls, S csIP6, I port6, Z tls6,
                  J chatId, J userId, I callMediaType, S title,
                  I serviceType, I userType, S sdp, Z, Z) -> J callId   ★개설
JoinVoiceRoomCall(S csIP,I,Z, S csIP6,I,Z, J chatId, J userId, J callId, I,I,I) -> J
MakeGroupCall(...) · CheckGroupCall(...) · IncomingCall(...) · Answer(J,I,I,S)I
HangUp(J,I)I · AddMember(J,[J])V

미디어/협상:
SendMediaDescription(J,J,I,S)I · SendICEDescription(J,J,I,S,I,S)I · UpdateMedia(J,I,I)I
ChangeMediaAttribute(J,I,I,I)I · SendVideoACCInfo(J,I,S)I

보이스룸 제어(VRC*):
VRCInviteAsSpeaker(J,J)I · VRCInviteAsModerator(J,J)I · VRCAuthorizeSpeakerPermission(J,J)I
VRCRequestSpeakerPermission(J)I · VRCAcceptSpeakerInvitation(J,J,I,S,Z,Z,I)I
VRCChangeTitle(J,S)I · VRCChangeMediaAttribute(J,Z,I,Z)I · VRCShareContent(J,S,Z)I
VRCControl(J,S,J)I · VRCRevokeSpeakerPermission(J,J)I · VRCSendAcc(J,I,S)Z … (20여개)

오디오(로컬 DSP, 서버無): AudioFilter* · SpeexResampler* · WebRtcAudio*Vad · Down*Sample*
```
전체 ~70개. enum: `VoxType$VCSResponseCode / VCallState / VServiceType / VUserType / VCallMediaType / VCallError …`
(응답 파싱용 상수군 — 값은 추가 추출 대상).

---

## 2. 로그인 = `SetVConfig(12 문자열)` (호출부: `Vox30Manager.init` → `Vox30Manager.setVConfig`)
```
SetVConfig(
  version, country, dns, lang,          ← 앱/구성값
  skey,                                 ← 세션키 (sKey/sessionKey)   ★
  uuid,                                 ← 기기 uuid
  oauthToken,                           ← 계정 OAuth 토큰 (봇이 이미 보유)  ★
  model, osName, sdkInt, vmVersion, buildId   ← 기기정보(로컬 계산: Utility.getModel()… )
)
```
- 앞 7개는 `Vox30Manager` 필드(`version/country/dns/lang/skey/uuid/oauthToken`)에서 읽어 넘김.
- `Init()` → `SetVConfig(...)` 순서. (WebRTC 빌드 로그 확인: "Kakao vox webrtc **m130**, 2026-09-03 …")
- **헤드리스 핵심**: `oauthToken` 은 봇 계정 토큰, `skey`·`dns` 는 `VoiceroomUserResponse`(HTTP)에서 받는 것으로 보임(§4).

---

## 3. 개설 인자 조립 (`Vox30Manager.makeCallSignal(VoxCall30Source, String)`)
`MakeVoiceRoomCall` 의 15개 인자 출처(실측):
```
csIP      ← VoxCall30Source.getHostGroup().getIpv4().getIp()
port      ← .getIpv4().getPort()            tls  ← Utility.getTlsStatus(ipv4)
csIP6     ← .getIpv6().getIp()              port6← .getIpv6().getPort()   tls6 ← getTlsStatus(ipv6)
chatId    ← VoxCall30Source.getInfo().getChatId()            (long)
userId    ← getCallerId() → Utility.IdUtils.getLongIdFromString()
mediaType ← getInfo().getCallMediaType()
title     ← getInfo().getTitle()
serviceType← getInfo().getServiceType()
userType  ← getUserType().getValue()
sdp       ← WebRTC offer (libjingle, 아래 §5)
```
`VoxCall30Impl` 생성 시그니처: `(VoxHostGroup, VNetworkType, long, long, long, VCallMediaType, VServiceType, VUserType, Z, …)`.
로그 문자열: `makeVoiceRoomCall >> vssHostGroup:` / `joinVoiceRoomCall >> vrsHostGroup:` → 개설=VSS, 참여=VRS 서버그룹.

---

## 4. 서버주소·세션 HTTP 소스 — `GET /c/voiceroom/user` → `VoiceroomUserResponse`
클래스: `com.kakao.talk.net.retrofit.service.openlink.model.VoiceroomUserResponse` (classes11).
확인된 필드/JSON 키(문자열 풀): **`vssHostV4`, `vssHostV6`, `connectInfo`, `protocolVersion`, `serverTime`, `IceServer`(org.webrtc.PeerConnection$IceServer)**, 그리고 세션계열 `sKey/sessionKey/skeyToken`, `csIp(V4/V6)/csPort`.
→ 봇이 자기 `oauthToken` 으로 이 API 를 치면 **vssHost(csIP/port) + iceServers + (세션키)** 를 받아 HostGroup·SetVConfig 를 채울 수 있다.
  (정확한 JSON 바디는 BlueStacks OkHttp 캡처로 런타임 확정 — capture-voiceroom.js 가 그 응답을 그대로 뜬다.)

모델: `VoiceroomCallInfo(long,long,long, String,String, int)` = (chatId?, callId?, userId?, title, url?, serviceType/mediaType).

---

## 5. 미디어 = WebRTC m130
`libjingle_peerconnection_so.so`(12MB) + `org.webrtc.*` + IceServer(응답). 음악 송출 = 이 피어커넥션에 오디오 트랙을 넣는 것.
→ 헤드리스는 **werift / node-webrtc 로 동일 SDP/DTLS-SRTP** 생성, IceServer 는 §4 응답값 사용.

---

## 6. 헤드리스 봇 청사진 (순수 호스팅)
```
1) 봇(LOCO 로그인됨, oauthToken 보유)
2) GET /c/voiceroom/user  → vssHostV4/V6(csIP:port), iceServers, (skey/sessionKey), protocolVersion   [HTTP, 쉬움]
3) VoxCore 상당 구현:
   - SetVConfig(version,country,dns,lang, skey, uuid, oauthToken, model,os,sdk,vm,build)
   - (handshake: ConnectVcs/SetLocalNetwork/SendNetworkEvent 상당)
   - MakeVoiceRoomCall(csIP,port,tls, csIP6,port6,tls6, chatId, userId, mediaType, title, serviceType, userType, SDP, …)
4) 응답(callId) 파싱 → SendMediaDescription/SendICEDescription 로 미디어 협상
5) werift 로 DTLS-SRTP 오디오(노래) 송출
※ 한 프로세스에서 2~5 를 방마다 병렬 → 한 계정 여러 방 (서버가 계정당 세션수를 막지 않으면)
```
**남은 유일 과제** = 3)의 각 요청이 소켓에 나가는 **정확한 바이트(프레임 헤더+바디 코덱)**.
정적분석(FINDINGS.md): 빅엔디안, 숫자 code 체계, 메시지/노드 구조까지 확보. 송신 직렬화는 간접호출이라
최종 바이트는 **실서버 probe** 또는 **런타임 1회 확인**으로 못박아야 함.

---

## 7. "다른 방법" 결론 (전수 확인)
| 방법 | 개설 가능? | 비고 |
|---|---|---|
| LOCO 메타(SETMETA/CHGMETA type16) | ❌ | 서버전용(-203), 실측 완료 |
| HTTP POST 개설 | ❌ | 그런 엔드포인트 없음(dex 확인) |
| QR / `kakaoopen://join?...vr=` 딥링크 | ❌(참여만) | 기존 방 join 전용 |
| **헤드리스 VCS 재구현** | ✅ | 이 문서 = 완전한 의미 스펙. 남은 건 와이어 바이트 |
| **frida 로 앱 MakeVoiceRoomCall 직접 호출(voxcall.js)** | ✅ | BlueStacks 상주, 멀티룸 서버제한 여부 테스트용 |

## 8. BlueStacks 캡처로 아직 채울 값(자바층·재서명 없음=DexProtector 안 건드림)
- `GET /c/voiceroom/user` **응답 JSON 전체** (vssHost/csIP/port/iceServers/sessionKey 실값·정확한 키)
- `MakeVoiceRoomCall` **런타임 인자값** (voxcall.js: 특히 SDP 포맷·serviceType/userType/mediaType 상수·tls 플래그)
- 이 둘이면 §6 의 입력이 전부 실측으로 고정됨 → 남는 건 와이어 포맷뿐.
