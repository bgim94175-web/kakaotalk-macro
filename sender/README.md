# 상시 발송 프로세스

카카오 계정 등록이 끝난 뒤 매크로, 이미지, 경쟁사 저격, 갠톡 자동응답, 방 관리봇, 미니게임은 이 프로세스가 `agent-messenger` 로 보냅니다. 고객 폰과 고객 컴퓨터는 꺼져 있어도 됩니다.

이 프로세스는 Render 무료 라이선스 서버(`server.js`)가 아닙니다. 그 서버는 요청이 없으면 잠듭니다. 운영자 PC 에 켜 두는 프로그램도 아닙니다. 항상 켜진 Node 호스트에서 `npm start` 로 떠 있어야 합니다.

비밀번호는 받지 않습니다. 라이브러리 세션 토큰만 AES-256-GCM 으로 디스크에 봉인합니다. 세션이 끊기면 발송을 멈추고, 앱은 계정을 다시 등록하라고 보여 줍니다.

## 환경 변수

| 이름 | 필수 | 설명 |
|---|---|---|
| `SENDER_TOKEN` | 예 | 앱이 라이선스 응답으로 받는 값과 같아야 합니다 |
| `SENDER_KEY` | 예 | 토큰 봉인 키. 64자 hex 또는 긴 비밀 |
| `PORT` | 아니오 | 기본 8787. Render 가 넣어 줍니다 |
| `DATA_DIR` | 아니오 | 봉인 파일 위치. 기본 `./state` |

라이선스 서버에는 `SENDER_PUBLIC_URL`(이 프로세스의 공개 주소)과 같은 `SENDER_TOKEN` 만 넣습니다. 발송 루프는 그 서버에 없습니다.

```bash
cd sender
npm install
SENDER_TOKEN=... SENDER_KEY=... npm start
```

`render.yaml` 의 `kakao-sender` 는 `plan: starter` 입니다. free 로 바꾸면 잠들어서 폰을 끈 동안 발송이 멈춥니다.
