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
