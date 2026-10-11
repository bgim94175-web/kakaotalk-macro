# 서비스 이름 — K bot

서비스(웹사이트·K bot 패널·판매 관리)의 이름은 **K bot** 이다. 2026-10 결정.

## 표기 규칙

- 영문 그대로 `K bot` — 대문자 `K`, 한 칸 띄고 소문자 `bot`.
- 쓰지 않는 표기: `KBot`, `K-bot`, `Kbot`, `케이봇`, `K Bot`.
- 한국어 문장 안에서도 `K bot` 그대로 쓴다. 조사는 발음대로 붙인다: `K bot은`, `K bot에서`.
- 기존 명칭 `카카오톡 매크로` / `카톡 매크로` 는 **상품(기능) 설명**에만 남긴다. 사이트·패널의 이름으로는 쓰지 않는다.

## 쓰이는 곳

| 위치 | 표기 |
| --- | --- |
| 모든 페이지 `<title>` | `<화면 이름> · K bot` (홈은 `K bot`) |
| 상단 바 브랜드 | 로고(`logo.svg`) + `K bot` 글자 |
| 패널(`/panel`) 제목 | `K bot 패널` (탭 제목도 `K bot 패널`) |
| 판매 관리(`/manage`) 제목 | `판매 관리 · K bot` |
| 브라우저 탭 안 읽음 표시 | `(N) K bot 패널` |
| 파비콘 `aria-label` | `K bot` |

## 로고 — 2026-10 결정

K bot 을 대표하는 로고는 **검은 바탕(#111111) 위 흰색 K** 하나다. 사이트 어디에서든 로고가 필요하면 이것만 쓴다. 새 로고·글자 아이콘을 따로 만들지 않는다.

| 파일 | 용도 |
| --- | --- |
| `public/logo.svg` | 원본(벡터). 상단 바·푸터의 `.brand-mark` 가 배경 그림으로 쓴다 |
| `public/favicon.svg` | 브라우저 탭 아이콘 (`logo.svg` 와 같은 그림) |
| `public/apple-touch-icon.png` | 홈 화면 추가 아이콘 180×180 |
| `public/icon-512.png` | 큰 아이콘 512×512 (공유 미리보기 등) |
| `public/og-image.png` | 링크 미리보기 배너 1200×630 (카카오톡·디스코드 등). 로고 리빌 영상의 네온 K 장면을 공식 벡터로 다시 그린 그림 |

- 마크업은 `<span class="brand-mark" aria-hidden="true"></span>` 그대로 둔다. 그림은 CSS(`style.css`·`panel.css` 의 `.brand-mark`)가 넣는다.
- 색을 바꾸거나, 늘리거나, 기울이지 않는다. 바탕과 K 의 비율도 원본 그대로다.
- 패널의 계정 칸(`#acctSq`)에 뜨는 글자는 계정 첫 글자이지 로고가 아니다.

## 링크 미리보기 — 2026-10 결정

- 모든 손님 화면의 `<head>` 에 `og:image` 와 `twitter:card`(`summary_large_image`) 가 있고, 그림은 `public/og-image.png` 하나다. 디스코드는 `twitter:card` 가 있어야 큰 그림으로 보여 준다.
- 배너 글자: `K bot` · `카카오톡 오픈채팅방을 패널 하나로 운영합니다` · `카카오톡 매크로 · 방 관리봇 · 미니게임봇` · `kmacro.cloud`. 가격은 넣지 않는다(가격은 `og:description` 에 있다).
- 그림을 바꾸면 모든 화면의 `og-image.png?v=N` 숫자를 함께 올리고, 카카오톡은 [카카오 공유 디버거](https://developers.kakao.com/tool/debugger/sharing)에서 `https://kmacro.cloud` 캐시를 지워 주세요.
- 미리보기 봇(카카오톡·디스코드 등)은 `Accept: text/html` 없이 `/` 를 요청하기도 한다. 그래서 `server.js` 의 `PREVIEW_BOT` 에 든 User-Agent 에는 랜딩 페이지를 준다. curl 같은 연결 확인은 기존 JSON 그대로다.
