# 내일(PC 켜면) 할 것 — 1단계: 런타임 값 캡처

목표: 보이스룸 "켜기" **딱 1번**으로 헤드리스 봇에 필요한 런타임 값을 전부 뜬다.
전부 자바 후킹이라 **BlueStacks 로 됨**(재서명/루트/gadget 불필요, DexProtector 안 건드림).

## 순서
1. 파워셀 아무 데서나 켜고 통째로 복붙 (폴더 자동 탐색 → 최신 받기 → 실행):
   ```powershell
   $f = Get-ChildItem $HOME -Recurse -File -Filter voxcapture.ps1 -ErrorAction SilentlyContinue | Select-Object -First 1
   if (-not $f) { $f = Get-ChildItem $HOME -Recurse -File -Filter capture.ps1 -ErrorAction SilentlyContinue | Select-Object -First 1 }
   Set-Location $f.DirectoryName ; git pull
   powershell -ExecutionPolicy Bypass -File .\voxcapture.ps1
   ```
2. 카톡 뜨면 → **봇 계정이 방장인 오픈채팅방** → 보이스룸 **"켜기" 1번**(제목 넣고 생성 완료까지)
3. 같은 폴더의 **`voxcapture-log.txt`** 통째로 나한테 전달

## 그 로그에 들어있을 것 (= 헤드리스 봇의 마지막 재료)
- `[HTTP] GET /c/voiceroom/user` 응답 JSON 전체 (vssHostV4/V6=csIP:port, iceServers, connectInfo, 세션키)
- `[VCFG] SetVConfig` 값 (ver/country/dns/lang/uuid/기기정보 — skey·oauthToken 은 마스킹됨)
- `[MAKE] MakeVoiceRoomCall` 15개 인자 + ★SDP + 반환 callId
- `[SEQ]` Init/SetLocalNetwork/… 핸드셰이크 순서

## (옵션) 멀티룸 즉석 테스트
켜기 1번 캡처 후, 같은 frida 창에서:
```
rpc.exports.again("<다른 오픈챗의 chatId>")
```
→ 같은 세션으로 두 번째 방 개설 시도. 두 방 다 켜져 있으면 = **한 계정 멀티룸 가능**(서버가 안 막음).

---
이 캡처가 끝나면 남는 건 "와이어 바이트 포맷" 하나. 그건 받은 값으로 실서버 맞추기 + 정적분석으로 확정.
