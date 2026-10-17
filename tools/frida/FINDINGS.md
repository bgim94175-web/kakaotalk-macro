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
