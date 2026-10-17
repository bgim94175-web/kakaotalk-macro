# VCS TLS MITM — 로그인/프레임 평문 캡처

frida 평문 훅은 Houdini(arm64)로 막히고, 추측 전송은 reset만 난다. 그래서 **중간자(MITM)** 로
VCS TLS를 가로채 **로그인부터 모든 프레임을 평문**으로 본다. BlueStacks가 루트라 가능.

```
앱(BlueStacks) ──(frida: connect :5242 → 릴레이)──▶ relay.mjs(PC) ──(진짜 TLS)──▶ CallServer:5242
                                                      │
                                                      └─ 평문 로그(mitm.log)
```

## 준비
- PC에 Node (없으면: `winget install OpenJS.NodeJS` 후 새 창)
- frida 연결은 기존 방식 그대로(VoxCore 캡처 때 쓰던 `-H 127.0.0.1:27042`)

## 절차
1. **PC LAN IP 확인**: `ipconfig` → IPv4 주소(예 192.168.x.x). 이게 BlueStacks에서 PC로 닿는 주소.
2. **싱싱한 csIP 얻기**: VoxCore frida 캡처 한 번 → `MakeVoiceRoomCall("<csIP>", 5242, ...)` 의 csIP.
3. **릴레이 띄우기** (PC, 터미널 A):
   ```
   cd tools\mitm
   npm install
   set REAL_IP=<2번 csIP>
   node relay.mjs
   ```
   `listening :8443 → <csIP>:5242` 뜨면 대기 중.
4. **redirect.js 편집**: `RELAY_IP` 를 1번 PC LAN IP 로. (`RELAY_PORT`=8443 그대로)
5. **frida 리다이렉트** (터미널 B): 카톡에 붙여 redirect.js 로드
   ```
   frida -H 127.0.0.1:27042 -p <KakaoTalk pid> -l redirect.js
   ```
   `[redir] armed` 확인.
6. **방에서 보이스룸 켜기** → 터미널 A(릴레이)에 `C>S`/`S>C` 평문이 뜬다.
7. 터미널 A 로그 + `tools\mitm\mitm.log` 를 붙여주세요.

## 판정
- `[relay] app TLS up` + `C>S` 평문 흐름 → **성공**. 로그인·프레임을 평문으로 확보 → 바로 구현으로.
- `[relay] ★ app TLS FAILED (pinning 가능성)` → pjsip가 우리 cert 거부 = **핀/검증 ON**. MITM 불가 → 정적 RE로 선회.
  (계정·서버엔 무해 — 우리 앱의 연결을 우리가 가로챈 것뿐.)
- `upstream ... error` → REAL_IP(csIP) 만료 → 2번 다시.

## 주의
- 이건 **님 기기의 님 앱 연결**을 가로채는 것이라 서버/계정에 추가 위험은 거의 없다(틀린 패킷 반복 전송이 아님).
- 캡처 끝나면 frida 창 닫고 릴레이 Ctrl+C. (redirect 는 그 frida 세션에서만 적용)
