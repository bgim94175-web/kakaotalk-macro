# UI V5 — 공개 사이트·콘솔 다크 리디자인 명세

- 작성: 2026-10-09. 상태: 구현 대기.
- 참조 프로토타입: `docs/UI_V5.prototype.html` — 단일 파일. 브라우저로 열면 공개 사이트(`#home` `#buy` `#my` `#order`)와 콘솔(`#login` `#overview` … `#snipe`)을 해시 라우트로 모두 볼 수 있다. 예시 데이터로 동작한다.
- 프로토타입 원본: `/tmp/claude-0/-home-user-kakaotalk-macro/8c77ca9b-6258-53a2-bfae-00e7470f9ad7/scratchpad/v5-final/` — `parts/a.html`(CSS), `parts/b.html`(마크업·SVG 스프라이트), `parts/c1.js`~`c4.js`(동작), `build.sh`(합치기), `verify.mjs`(모션·동작 검사), `smoke.mjs`(전 화면 오류·가로 넘침 검사), `shots.mjs`(스크린샷).
- 스크린샷: 같은 폴더 `shots/` — `d-*.png` 1440×900, `m-*.png` 390×844. 번호표는 부록 A.
- 범위: 화면 구조, 디자인 토큰, 모션, DOM 계약, 테스트 변경. **UI_V4.md 5장(받은함 상태·폴링·재렌더 회피·늦은 응답·전송·닫기)과 6장(API)은 그대로 유효하다.** 이 문서는 그중 바뀌는 부분만 적는다.
- 우선순위: 이 문서 > 프로토타입 > UI_V4.md. 프로토타입은 한 파일에 사이트와 콘솔을 함께 넣느라 일부 id·접두사가 실제 파일과 다르다. 실제 이름은 3.8(공개)·4.13(콘솔) 대응표를 따른다.
- 문구는 `docs/TONE.md`(합니다체·명사형, 버튼 2~5자, 오류 = 현상 + 조치)와 이 문서 1.4의 이름표를 따른다.

---

## 1. 개념·원칙

### 1.1 요청과 해석

사용자 요청(원문): "I don't want this website design. Destroy ai slop. I need website like cursor ai, Need motion grapics, If I click ui something part appear and happen (animation), I need website to use my K bot fuctions easy / Need panel / Kakao account add page, k bot setting page - macro, 입장 • 퇴장로그, 프로필 로그, 올 킥 방지, 금지어 검열, 갠톡 응답 시스템 / can you design my website?"

| 요청 | 이 명세의 답 |
|---|---|
| AI 티 나는 디자인 폐기 | 이전 라이트 그린·다크 민트 시안, V4 계정 무지개색(`--acc-0..7`)을 모두 버린다. 1.3 금지 목록. |
| Cursor 같은 사이트 | 거의 검정 단색, 1px 헤어라인, 흰 기본 버튼, 제품 화면이 곧 소개. 홈 첫 화면에 실제 콘솔 모양의 창이 움직인다. |
| 모션 그래픽 | 홈 히어로 시연(18.2초 루프, 장 5개), 동작 방식 구조도(데이터 흐름 점), 기능 탐색기 전환. 5장. |
| 누르면 무엇이 나타나는 애니메이션 | 원인-결과 모션: 스위치를 켜면 바로 아래 옵션이 펼쳐지고, 고친 것이 생기면 저장 바가 올라오고, 고른 항목으로 표시가 미끄러진다. 5장. |
| K bot 기능을 쉽게 | 사이드바 하나에 모든 기능, 계정 전환기, 기능별 화면 첫 줄 = 메인 스위치, 개요에서 즉시 켜고 끄기, Ctrl/⌘K 팔레트. |
| 패널 | `/panel` 콘솔: 개요, 받은함, 계정, 계정 추가, 기능 7개 화면. 4장. |
| 카카오 계정 추가 화면 | `#account-add` 3단계 등록 마법사(계정 입력 → 카카오톡에 번호 입력 → 완료), 재등록·다른 기기 끊기 포함. 4.6. |
| 매크로 / 입장·퇴장 로그 / 프로필 로그 / 올킥 방지 / 금지어 검열 / 갠톡 응답 | 각 기능 화면 4.7~4.12. 기존 저격 규칙도 유지(4.12). |

### 1.2 원칙

1. **한 가지 다크 화면.** 라이트 모드·테마 전환 없음. `color-scheme: dark`, `theme-color #09090b`.
2. **단색 + 상태색.** 색은 상태에만 쓴다: `--live`(동작 중), `--warn`(주의·대기), `--crit`(오류·등록 필요·올킥). 강조는 흰 버튼(`--inv`)과 글자 굵기로 한다.
3. **헤어라인과 면 밝기로 구획.** 그림자는 떠 있는 것(계정 메뉴, 팔레트, 토스트, 저장 바, 시연 창)에만.
4. **설정 행 문법.** 왼쪽 라벨 + 설명, 오른쪽 컨트롤(`.srow`). 기능 화면의 첫 행은 그 기능의 메인 스위치. 꺼져 있으면 옵션을 접고 점선 안내(`.off-note`)와 `켜기` 버튼만 보인다.
5. **저장은 화면 아래 저장 바 하나.** "변경사항 N건 · 계정 · 화면"을 적는다. 저장하지 않고 떠나면 같은 바가 "저장하지 않은 변경이 있습니다"로 바뀌어 묻는다. 브라우저 `confirm()` 금지.
6. **키보드.** Ctrl/⌘K 팔레트, Ctrl/⌘S 저장, G 다음 글자로 화면 이동, Esc 닫기. 받은함 `/` 검색, Alt+↑↓ 대화 이동(UI_V4 5.11 유지).
7. **모노 글꼴은 라틴 문자 값에만.** 이메일, 기기 id, 링크, 시각, 숫자. 한글은 언제나 산세리프(Geist → IBM Plex Sans KR).
8. **정직한 문구.** 서버가 실제로 하는 일만 적고, 못 하는 일은 적는다. 예: 올킥 방지는 감지·기록만 한다(강퇴를 막거나 다시 초대하지 않음). 금지어 검열은 이 계정이 부방장 이상일 때 글을 가리기만 한다. 입장·퇴장 로그와 프로필 로그는 방에 안내를 보낸다(4.8 안내 형식). 예시 데이터는 홈 시연 창 안에서만 쓰고 "콘솔 시연"이라고 밝힌다.
9. **모션은 원인을 따라간다.** 누른 곳에서 결과가 나타난다. 150~380ms, 이징 하나(`--ease`). 폴링으로 다시 그릴 때는 움직이지 않는다(5.5).
10. **폰에서도 전부 쓴다.** 390px 기준 가로 스크롤 없음, 누르는 대상 높이 44px(폰 목록 행·탭), 그 밖 컨트롤 32px 이상.

### 1.3 금지 목록 (하나라도 보이면 반려)

- 그라디언트 글자, 글로·네온(색이 번지는 `box-shadow`/`filter`), 민트·애시드 그린, 보라-파랑 그라디언트, 배경 점 격자·노이즈·블롭.
- 이모지. UI 문자열과 아이콘 대용 모두. `app.js` `FEATURES[].icon`(⚡🛡🎲) 포함.
- 같은 모양 아이콘 카드 3개짜리 그리드.
- 큰 라운드 남발. 반경은 `--r-1..4`(6/8/10/12px)와 원형(점·스위치·아바타)만.
- 크림색·세리프, 장식용 `01 02 03` 번호.
- 빈말 카피("혁신적인", "손쉽게", "강력한", "완벽한", "~해 보세요").
- 상태가 아닌 곳의 색: 기능별 색, 계정별 색. 계정은 첫 글자 네모(`.sq`)로만 구분한다.
- 스크롤 진입 시 투명도 0에서 나타나기. 진입 모션은 `translateY`만(`.rv`, 5.3).
- `alert()`, `confirm()`, `prompt()`.
- 외부 스크립트·CSS 프레임워크. 외부 리소스는 Google Fonts CSS 하나.
- 화면에 영어 문장 조각("Overview", "Settings", "Save changes"). 단축키 글자(`Ctrl K`, `G O`)와 고유명사(K bot, Geist)만 예외.

### 1.4 이름표

| route | 화면 이름 | 한 줄 설명(개요 표·팔레트) | `account` 키 | 단축키 |
|---|---|---|---|---|
| `overview` | 개요 | — | — | G O |
| `inbox` | 받은함 | — | — | G I |
| `accounts` | 계정 | — | — | G A |
| `account-add` | 계정 추가 (재등록이면 계정 재등록) | — | — | — |
| `macro` | 매크로 | 홍보 메시지 주기 발송 | `macro` (+`images`) | G M |
| `visit` | 입장·퇴장 로그 | 입장·퇴장 기록과 방 안내 | `visit` | G V |
| `profile` | 프로필 로그 | 닉네임 변경 기록과 방 안내 | `profile` | G P |
| `guard` | 올킥 방지 | 강퇴 다발 감지·기록 | `guard` | G K |
| `cover` | 금지어 검열 | 욕설·금지어·링크 가림 | `cover` | G C |
| `reply` | 갠톡 응답 | 1:1 대화 자동 응답 | `autoreply` | G R |
| `snipe` | 저격 규칙 | 지정한 말에 답장 | `triggers` | G S |

- 상태 라벨 5종(UI_V4 45항 그대로): `접속 중` / `연결 대기` / `등록 필요` / `응답 없음` / `발송 중지`.
- 기능 상태 라벨: `켜짐` / `꺼짐`.
- `/panel` 전체를 "콘솔"이라 부른다. 사이트 헤더 버튼은 `콘솔 열기`.
- 폐기되는 V4 이름: `들낙 방지` → 입장·퇴장 로그, `욕설 가리기` → 금지어 검열, `프로필 변경 감지`(화면 이름) → 프로필 로그(스위치 라벨로는 `프로필 변경 감지` 유지), `갠톡 자동응답` → 갠톡 응답(스위치 라벨 `자동 응답`), `경쟁사 저격` → 저격 규칙, `설정 › 계정` → 계정 화면.

---

## 2. 토큰

### 2.1 공유 `:root` 블록 — `public/style.css`와 `public/panel.css`에 글자 하나 다르지 않게

두 파일 모두 첫 규칙으로 아래 블록을 넣는다. 주석 한 줄 `/* K bot tokens v5 */`를 블록 바로 위에 둔다. `lib/panel-check.js`가 두 파일에서 `:root {`부터 첫 `}`까지를 잘라 같은지 비교한다(8.1). 색은 이 블록 밖에서 쓰지 않는다(`rgba(` `#hex` 금지, `transparent`·`currentColor`만 예외).

```css
/* K bot tokens v5 */
:root {
  color-scheme: dark;
  --bg: #09090b; --bg-1: #0e0e11; --bg-2: #141417; --bg-3: #1b1b1f; --bg-4: #242429;
  --line: #1f1f23; --line-2: #2a2a2f; --line-3: #3a3a40;
  --fg: #ededef; --fg-2: #a1a1aa; --fg-3: #8b8b94; --fg-4: #5c5c64;
  --inv: #f4f4f5; --inv-2: #d4d4d8; --inv-fg: #09090b; --inv-fg-2: #52525b;
  --live: #5fb878; --warn: #d6a24a; --crit: #ef6a60;
  --crit-bg: rgba(239, 106, 96, 0.08); --crit-line: rgba(239, 106, 96, 0.32);
  --warn-bg: rgba(214, 162, 74, 0.07); --warn-line: rgba(214, 162, 74, 0.34);
  --hl: rgba(244, 244, 245, 0.06); --hl-2: rgba(244, 244, 245, 0.11);
  --crit-pulse: rgba(239, 106, 96, 0.45); --live-pulse: rgba(95, 184, 120, 0.4);
  --scrim: rgba(5, 5, 7, 0.66); --glass: rgba(9, 9, 11, 0.82);
  --shadow: 0 24px 64px -24px rgba(0, 0, 0, 0.72), 0 2px 6px rgba(0, 0, 0, 0.36);
  --ring: 0 0 0 3px rgba(244, 244, 245, 0.08);

  --f-sans: "Geist", "IBM Plex Sans KR", "Apple SD Gothic Neo", "Malgun Gothic", system-ui, sans-serif;
  --f-mono: "Geist Mono", ui-monospace, "SFMono-Regular", Menlo, Consolas, monospace;

  --t-11: 11px; --t-12: 12px; --t-13: 13px; --t-14: 14px; --t-16: 16px; --t-18: 18px; --t-24: 24px;
  --r-1: 6px; --r-2: 8px; --r-3: 10px; --r-4: 12px;
  --ease: cubic-bezier(.2, .8, .2, 1);
  --d1: 150ms; --d2: 240ms; --d3: 380ms;
  --side-w: 248px; --top-h: 52px; --col-w: 1040px; --tap: 44px;
}
@media (prefers-reduced-motion: reduce) { :root { --d1: 0ms; --d2: 0ms; --d3: 0ms; } }
```

`--f-mono`에는 한글 글꼴을 넣지 않는다. 모노 요소에 한글이 들어가면 그 부분을 산세리프 `span`으로 감싼다(예: `총 2회`, `외 1회`).

### 2.2 공유 기초 블록

`:root` 다음에 두 파일 모두 프로토타입 CSS의 다음 범위를 그대로 복사한다(수정 금지, 순서 유지).

1. 리셋: `[hidden] { display: none !important; }`부터 `.skip:focus`까지(`*`, `html`, `body`, 폼 요소 상속, `.mono`, `.tnum`, `.sr`, `:focus-visible`, `[tabindex="-1"]:focus`, `::selection`, `.skip`).
2. `/* ---------- primitives ---------- */`부터 `/* ========== SITE ========== */` 직전까지: `.btn`(`.primary` `.ghost` `.danger` `.solid` `.sm` `.lg` `.wide` `.busy` + `.spin` `.lbl-idle`), `kbd`, `.dot`(`.live` `.warn` `.crit` `.pulse`), `.chip-acct`, `.tag`(`.line`), `.badge-n`(`.bump`), `.demo-tag`, 스위치(`.swl` `.swi` `.sw`), 입력(`.inp` `.ta` `.sel` `.num` `.chips` `.fld` `.lb` `.errt` `.hint` `.range`), 세그먼트(`.seg` `.seg-ind`).
3. `/* ---------- responsive: shared primitives (style.css + panel.css) ---------- */` 블록.
4. 맨 끝 `@media (prefers-reduced-motion: reduce) { … }` 블록(5.6).

`.sr`이 화면 낭독기 전용 클래스다. V4의 `.sr-only`는 `.sr`로 바꾼다.

### 2.3 글꼴

모든 HTML(`index` `buy` `my` `order` `panel`)의 `<head>`에, 스타일시트 링크보다 앞에:

```html
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600&family=Geist+Mono:wght@400;500&family=IBM+Plex+Sans+KR:wght@400;500;600&display=swap">
```

- 굵기는 400·500·600만. `font-weight: 700/800`(app.js 인라인 포함) 금지 → 600.
- 글꼴을 못 받으면 대체 글꼴로 그대로 동작해야 한다(오프라인 검사에서 레이아웃 깨짐 없음).
- 글자 크기는 토큰 단계 11·12·13·14(본문)·16·18·24px가 기본이다. 그 밖의 값은 프로토타입 CSS에 이미 있는 것만 쓴다: 시연 창 축소 글자 10.5·11.5·12.5px, 섹션 제목 `clamp(28px, 3.6vw, 44px)`, 홈 제목 `clamp(36px, 5.4vw, 68px)`, 금액 `clamp(28px, 6vw, 36px)`, 키 `clamp(18px, 4.6vw, 24px)`, 확인 번호 34px(폰 28px), 지표 숫자 26px.

### 2.4 색 쓰임

| 토큰 | 쓰임 | 대비(본문 위) |
|---|---|---|
| `--bg` | 페이지 바탕, 사이드바, 받은함 목록 | — |
| `--bg-1` | 카드(`.sec`), 입력창, 시연 창, 대화 창 바탕 | — |
| `--bg-2` | 떠 있는 면: 메뉴, 팔레트, 토스트, 받은 말풍선 | — |
| `--bg-3` | hover, 선택된 행, 사이드바 현재 위치 표시(`.nav-ind`) | — |
| `--bg-4` | 꺼진 스위치 트랙, 아바타, 진행 막대 바탕 | — |
| `--line` / `--line-2` / `--line-3` | 구획선 / 카드·입력 테두리 / hover·떠 있는 면 테두리 | — |
| `--fg` | 제목, 값, 본문 강조 | 17.0 (`--bg`) |
| `--fg-2` | 본문, 설명 | ≥ 6.0 (`--bg-4`까지) |
| `--fg-3` | 보조 설명, 시각, placeholder | ≥ 5.08 (`--bg-3`까지) |
| `--fg-4` | 장식만(축 눈금, 비활성 점). 글자에 쓰지 않는다 | — |
| `--inv` / `--inv-fg` | 기본 버튼, 내 말풍선, 선택된 계정 네모 | 18.5 |
| `--live` | 동작 중 점, 켜진 기능 점(`.fs.on`), 전송됨 표시 | 점·선만 |
| `--warn` / `--warn-bg` / `--warn-line` | 대기·주의(연결 대기, 저장 안 한 변경, 발송 작업 멈춤 띠) | 점·선 |
| `--crit` / `--crit-bg` / `--crit-line` | 오류 문구, 등록 필요, 올킥 감지, 삭제 버튼 | ≥ 5.08 (`--bg-4`) |
| `--hl` / `--hl-2` | 새로 들어온 행의 잠깐 밝아짐(5.4) | — |

### 2.5 간격·레이아웃

- 4px 격자: 4·6·8·10·12·14·16·18·20·24·28·32·40·48·56·72·88·128px.
- 콘솔: 사이드바 `--side-w` 248px, 상단 바 `--top-h` 52px(폰 56px), 본문 열 `--col-w` 1040px 가운데 정렬, 페이지 안쪽 여백 `40px 28px 168px`(폰 `28px 16px 200px`; 아래 여백은 저장 바 자리). 받은함만 열 제한 없이 화면을 꽉 채운다(`.page.full`, 여백 0).
- 사이트: `.wrap` 1120px, `.wrap-wide` 1240px, 좌우 여백 24px(폰 16px). 섹션 간격 128px(폰 88px), 섹션 앵커 `scroll-margin-top: 60px`.

---

## 3. 공개 사이트 (PUBLIC)

### 3.0 공통

**파일**: `public/index.html`, `buy.html`, `my.html`, `order.html`, `style.css`, `app.js`. `style.css`는 전부 새로 쓴다(V4 라이트 스타일 폐기).

**`<head>`** (네 파일 공통, 기존 `title`·`description`·`robots` 유지):

```html
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#09090b">
<meta name="color-scheme" content="dark">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<!-- 2.3 글꼴 링크 3줄 -->
<link rel="stylesheet" href="/style.css?v=5">
<script src="/app.js?v=5" defer></script>
```

**`<body data-page="home|buy|my|order">`** — 그대로. 바로 아래 SVG 스프라이트(`<svg width="0" height="0" style="position:absolute" aria-hidden="true"><defs><symbol id="i-…">`)를 프로토타입 `parts/b.html` 첫 블록에서 그대로 복사한다. 아이콘은 `<svg class="ic" width="16" height="16" aria-hidden="true"><use href="#i-이름"></use></svg>`.

**헤더** `header.lnav#lnav` (sticky, 높이 60px, 바탕 `--glass` + blur, 스크롤 8px 넘으면 `.scrolled`로 아래 선 표시):

```html
<header class="lnav" id="lnav">
  <div class="wrap lnav-in">
    <a class="brand" href="/" aria-label="K bot 홈"><span class="brand-mark" aria-hidden="true">K</span>K bot</a>
    <nav class="lnav-links" aria-label="페이지 안 이동">
      <a href="/#features">기능</a><a href="/#how">동작 방식</a><a href="/#products">가격</a><a href="/#faq">질문</a>
    </nav>
    <nav class="top-nav" aria-label="주요 메뉴">
      <a class="btn ghost hide-s" href="/my" data-nav="my">내 키</a>
      <a class="btn ghost" href="/buy" data-nav="buy">구매</a>
      <a class="btn primary" href="/panel" data-nav="panel">콘솔 열기</a>
    </nav>
  </div>
</header>
```

- `app.js boot()`의 `nav.top-nav a[data-nav]` → `aria-current="page"` 로직을 그대로 쓴다. 현재 페이지 버튼은 `aria-current="page"`일 때 `color: var(--fg); background: var(--bg-3)`.
- 홈에서 `.lnav-links a`는 같은 페이지 앵커이므로 부드럽게 스크롤(`scroll-behavior`가 아니라 JS `scrollIntoView({behavior: reduced ? 'auto' : 'smooth'})`), 다른 페이지에서는 `/#…`로 이동.
- 폰(≤760px): `.lnav-links`와 `.hide-s` 숨김.

**본문** `main#main`(`tabindex="-1"`), 건너뛰기 링크 `a.skip[href="#main"]`.

**바닥글** `footer.foot`: 브랜드 한 줄, 링크(구매·내 키·주문 조회·콘솔), 입금 안내 `#bankLine[data-manual]`(홈만, 기존 문구·속성 유지), 저작권 줄. 색은 `--fg-3`, 위 구분선 `--line`.

**토스트** `#toast`(app.js가 만든다): 화면 아래 가운데, `--bg-2` 바탕, `--line-3` 테두리, `--shadow`. `data-on="1"`이면 `transform: translate(-50%, 0); opacity: 1`, 아니면 `translate(-50%, 12px); opacity: 0`, `transition: transform var(--d2) var(--ease), opacity var(--d2) var(--ease)`. `data-kind="bad"` → 테두리 `--crit-line`, 글자 `--crit`. `data-kind="ok"` → 앞에 `--live` 점.

### 3.1 홈 `index.html` — 섹션 순서와 DOM

순서: 히어로 → 시연 창 → 기능(`#features`) → 동작 방식(`#how`) → 가격(`#products`) → 앱 설치(`#install`) → 질문(`#faq`) → 마지막 안내(`.lcta`) → 바닥글. 프로토타입 `[data-pp="home"]` 안의 마크업을 그대로 옮기고 3.8 대응표대로 id를 바꾼다. 스크린샷: `d-00-home-fullpage.png`(전체), `d-01`~`d-07`, `m-01`~`m-07`.

**히어로** `section.wrap.hero`:

- 머리글 `p.kicker`: `라이선스 키 1개` · `카카오 계정 최대 8개`(가운데 점은 `span.sep` 3px 원).
- `h1`: `여러 카카오 계정을<br><span class="dim">하나의 콘솔에서</span> 운영합니다` (`.dim` = `--fg-3`). 크기 `clamp(36px, 5.4vw, 68px)`, 굵기 600, 자간 `-0.04em`, 줄간 1.1, 왼쪽 정렬.
- `p.lead`: `갠톡 응답, 홍보 발송, 입장·퇴장 기록, 금지어 검열, 올킥 감지를 계정마다 설정합니다. 등록이 끝난 계정은 휴대폰 없이 서버에서 동작합니다.`
- `.cta-row`: `a.btn.primary.lg[href="/panel"]` `콘솔 열기`, `a.btn.lg[href="#products"]` `가격 보기`, `span.hero-note[data-manual="무통장 입금 · 입금 확인 후 관리자가 키를 발급합니다"]` `무통장 입금 · 입금 후 통상 1~2분 내 키가 자동 발급됩니다`.

**시연 창** `section.wrap-wide.stage[aria-labelledby="demoCap"]` > `h2.sr#demoCap 콘솔 시연` + `.win#demo` + `.chapters`. 시연 창 안의 모든 이름·숫자는 예시다. 창 머리줄 오른쪽에 `span.demo-tag` `콘솔 시연`.

- 창 구조(`.win-body` 3열 `200px 296px 1fr`, 높이 520px: 사이드 · 대화 목록 · 대화 / ≤1100px 사이드 숨김 / ≤760px 대화만, 높이 540px): 프로토타입 마크업을 그대로 쓴다. 움직이는 요소 id: `dBadge`(사이드 받은함 배지), `dNew`·`dNewRow`·`dPv`(새 대화 행·미리보기), `dHead`(대화 머리: 이름 + `a@kakao.com 계정으로 답장`), `dEmpty`, `dInMeta`·`dIn`·`dInT`(받은 말), `dOut`·`dOutT`(보낸 말 + `21:16 · a@ · 전송됨`), `dType`·`dCaret`·`dSend`(입력·전송 버튼), 오른쪽 아래 기록 패널 `lgJoin`·`lgLeave`·`lgProf`·`lgKick`, 오른쪽 위 알림 `dAlert`(올킥 감지)와 그 안 `dKicks`(강퇴 막대 8개).
- 장 표시 `.chapters` > `ol.chap-list` > `button.chap[data-ch="0..4"]` (각 `.bar > i` 진행 막대, `.ct` 제목, `.cd` 설명) + 재생/일시정지 `button.playbtn#demoPlay`(44×44px 아이콘 버튼, `aria-label="시연 일시정지"`/`"시연 재생"`).

| `data-ch` | `.ct` | `.cd` |
|---|---|---|
| 0 | 갠톡 수신 | 모든 계정의 1:1 대화가 계정 표시와 함께 받은함에 모입니다. |
| 1 | 답장 발송 | 대화를 받은 계정이 그대로 답장합니다. 계정을 고르지 않습니다. |
| 2 | 입장·퇴장 기록 | 이름, 오픈프로필 링크, 시각을 기록하고 방에 안내를 보냅니다. |
| 3 | 프로필 변경 | 닉네임 변경을 감지하여 이전 이름과 함께 기록합니다. |
| 4 | 올킥 감지 | 짧은 시간에 강퇴가 몰리면 감지하여 기록합니다. |

시연 동작(타임라인·일시정지 규칙)은 5.2. `app.js`의 `pageHome()` 끝에서 `initDemo()`를 부른다.

**기능** `section#features.lsec` — 머리(`.lsec-h`: 왼쪽 `p.eyebrow 기능` + `h2 운영에 필요한 기능을 계정마다 따로 설정합니다`, 오른쪽 `p.desc`), 본문 `.fx`(탐색기, 2열 `340px 1fr`, ≤1100px `280px 1fr`):

- 왼쪽 `div.fx-list#fxList[role="tablist"][aria-label="기능 목록"]` > `span.fx-ind#fxInd`(선택 표시 면) + `button.fx-item#fxt{0..7}[role="tab"][aria-selected][aria-controls="fxPane"][tabindex]` 8개(통합 받은함·매크로·입장·퇴장 로그·프로필 로그·올킥 방지·금지어 검열·갠톡 응답·저격 규칙). 각 버튼은 `b` 이름 + `span > i` 한 줄 설명(선택된 것만 펼쳐짐, 프로토타입 `FX` 배열 문구 그대로).
- 오른쪽 `div.fx-view` > `div.fx-view-h`(`span#fxCrumb` 경로 `a@kakao.com / 매크로` + `span.demo-tag` `예시 화면`) + `div.fx-pane#fxPane[role="tabpanel"][aria-labelledby="fxt{i}"]` — 그 기능 콘솔 화면의 축소판(설정 행, 방 칩, 기록 표 몇 줄). 프로토타입 `fxHtml(k)`를 app.js로 옮기거나 같은 마크업을 정적으로 둔다(PUBLIC 판단). 축소판의 스위치·칩은 장식이다(`aria-hidden="true"`, `pointer-events: none`).
- 탭 전환: 클릭·←↑→↓·Home·End. 전환 모션 5.3.
- 폰: 목록이 가로 스크롤 줄(`.fx-item span` 숨김), `.fx-ind` 숨김, 선택 탭은 `--bg-3` 바탕.

**동작 방식** `section#how.lsec` — `h2 휴대폰은 계정을 등록할 때만 필요합니다`. `div.how.rv#howBox` > `figure.how-fig[aria-labelledby="howFigCap"]` 안에 SVG 두 벌: `svg.h`(데스크톱 viewBox 1000×300) / `svg.v`(폰 340×560, ≤760px에서만 표시). 노드 3열: 왼쪽 카카오 계정 3개(`a@` `b@` 접속 중, `c@` 등록 필요 — 점 색 상태색), 가운데 `K bot 서버`, 오른쪽 `오픈채팅방`·`콘솔`. 연결선 `.wire`(`--line-3` 1px, 등록 필요 계정 선은 `.dash` 점선), 그 위를 지나는 점(`circle.pk`, `--fg`; 등록 필요 계정 선에는 점을 보내지 않는다)을 SMIL `<animateMotion>`으로 흘린다(5.2). `figcaption.sr#howFigCap`에 그림 설명 문장. 그 아래 `ol.how-steps` 3칸: `구매 신청`(키 발급) · `계정 등록`(콘솔에서 카카오 계정 입력 후 카카오톡에 번호 입력) · `기능 켜기`(계정마다 기능을 켜고 방 선택). 각 칸 `b` 제목 + `p` 설명.

**가격** `section#products.lsec` — 기존 DOM 훅을 그대로 둔다: `#planSeg`(app.js가 결제 기간 라디오를 넣는다), `#prods`(Picker 카드), `#iosWarn`(아이폰 경고), `#sum`(합계). 배치: 위에 결제 기간 세그먼트, 아래 2열(왼쪽 카드 목록, 오른쪽 `aside` 합계 sticky). Picker DOM 변경은 3.6.

**앱 설치** `section#install.lsec` — `h2 앱 설치 안내`, 표 형식 행(`.ins-row`: 왼쪽 `b` 항목, 오른쪽 설명) 6줄: APK 다운로드 / 출처를 알 수 없는 앱 허용 / 알림 접근 권한 / 접근성 권한 · 이미지 발송용 / 배터리 최적화 예외 / 앱 업데이트 후. 문구는 프로토타입 그대로(기존 index.html 내용과 같음). 기존 `data-manual` 문구 유지.

**질문** `section#faq.lsec` — `h2 질문`, 분류 세그먼트 `div.seg#faqSeg[role="group"][aria-label="질문 분류"]` > `span.seg-ind` + `button[data-c=""|"console"|"buy"|"app"][aria-pressed]` (`전체` `콘솔` `구매·결제` `휴대폰 앱`), 목록 `div#faqList` > `.faq-i[data-cat]` > `button.faq-q[aria-expanded][aria-controls]`(오른쪽 `+` 아이콘이 열리면 45도 회전) + `div.faq-a[role="region"]` > `div` > `p…`. 질문 17개와 분류는 프로토타입 `FAQ` 배열 그대로(기존 index.html 질문 13개 + 콘솔 질문 4개). 정적 HTML로 넣고 app.js는 열기/분류만 담당한다. 분류를 바꾸면 보이는 항목만 `rowIn`으로 다시 들어온다(5.3).

**마지막 안내** `section.lcta`: `h2 키 하나로 계정 여러 개를 운영합니다` + `콘솔 열기`(primary) + `구매 신청`(→ `/buy`).

### 3.2 구매 `buy.html`

프로토타입 `[data-pp="buy"]`. 스크린샷 `d-08-buy`, `d-08b-buy-errors`, `m-08*`.

- 머리 `.pub-head`: `p.eyebrow 구매 신청` + `h1 기능과 기간을 선택합니다` + 설명(`data-manual` 기존 문구 유지).
- `#iosWarn` 경고(`.note.warn`), `#result`(접수 결과, 처음엔 비어 있음).
- `form#orderForm[novalidate]` > `#formWrap.pub-grid`(2열: 왼쪽 입력 · 오른쪽 `aside` 합계 sticky, ≤960px 1열).
  - 왼쪽 `fieldset.fsec` 상자들(각 `legend.lb` + 내용):
    1. 기능 `#fld-feature` > `#featRows`(Picker 줄 모양) + `#err-feature`
    2. 결제 기간 `#planSeg`
    3. 기존 키 `#fld-key` > `input#key[name=key]` + `#key-hint` + `#err-key`
    4. 입금자명 `#fld-depositor` > `input#depositor` + `#dep-hint` + `#err-depositor`
    5. 연락처 `#fld-contact` > `input#contact` + `#con-hint` + `#err-contact`
    6. 메모 `#fld-memo` > `textarea#memo`
    7. 안드로이드 확인 `#fld-android` > `label.chk` > `input#androidOk[name=android_ok]` + `#android-hint` + `#err-android`
  - `#bankHint`, `#submitErr`.
  - 오른쪽 `aside` > `#sum`(합계 + 제출 버튼 — app.js가 만든다).
- 오류 표시: `.fld.bad`(app.js가 `#fld-…`에 `bad` 토글) → 입력 테두리 `--crit-line`, `.err` 문구 `--crit`, 첫 오류 칸으로 포커스. 오류가 생긴 칸만 `shake`(5.4) 한 번.
- 접수 뒤 `#formWrap` 숨김, `#result`에 금액 상자(`.big` 28px 모노, 뒷자리 강조), 입금 계좌, 주문번호, 주문 상태 링크(app.js 기존 DOM).

### 3.3 내 키 `my.html`

프로토타입 `[data-pp="my"]`. 스크린샷 `d-09-my`, `m-09-my`.

- `form#lookupForm` > `#fld-key` > `input#key` + `#key-hint` + `#err-key` + `button#lookupBtn`(`조회`).
- `#result`: 키 상자(모노 18~22px), 상태 칩, 기능별 남은 기간 `.feat-row`(이름 + 칩 + 막대 `.bar > i`, 30일 이하 `.warn`, 만료 `.off`).
- `aside` 기기 초기화 안내: `#adminContact`, `#resetActions` > `#resetCopy`(`문구 복사`), `#resetHint`.

### 3.4 주문 상태 `order.html`

프로토타입 `[data-pp="order"]`(상단 `#ordSeg`는 프로토타입 전용 상태 전환이다 — 옮기지 않는다). 스크린샷 `d-10-order`, `d-10b-order-done`.

- `#result`: 상태 칩(`입금 대기 중` warn / `입금 확인됨 · 발급 준비` / `발급 완료` live / `취소됨` crit), 금액 상자, 대기 표시 `.wait`(점 3개 `tdot`), 발급되면 키 상자 `.big.keybox`.
- `#findWrap` > `form#findForm` > `input#oid` + `#oid-hint`.
- app.js 5초 폴링·`lastSig` 로직 그대로. 상태가 바뀌어 다시 그릴 때만 `#result .card`에 `rowIn` 한 번(같은 상태 폴링은 움직이지 않음).

### 3.5 app.js가 만드는 DOM — 유지와 스타일

app.js의 클래스·id·`data-*`는 모두 유지한다(`.card` `.prod` `.head` `.t` `.desc` `.bul` `.prices` `.pr[data-plan][data-on]` `.pl` `.pv` `.chk` `.box` `.amt` `.sel` `.seg` `.sum` `.nudge` `.saved` `.lines` `.ln` `.v` `.total` `.note` `.warn` `.info` `.ok` `.bad` `.chip` `.big` `.keybox` `.kv` `.r` `.k` `.feat-row` `.r1` `.bar` `.wait` `.txt` `.dots` `.el` `.skel` `.sk*` `.eyebrow` `.sub` `.small` `.tiny` `.dim` `.center` `.err` `.hint` `.btn-row` `.steps` `.lookup` 등). 프로토타입 CSS `/* ========== PUBLIC … ========== */` 블록과 `/* ---------- responsive: PUBLIC … */` 블록이 이 클래스들의 스타일이다. **`.pub ` 접두사를 지우고** `style.css`에 넣는다.

### 3.6 app.js 필수 변경 (PUBLIC 담당)

1. `FEATURES[]`에서 `icon`, `color` 필드 삭제. 카드 `.head` 안 `div.ico` 생성 코드(인라인 `background:#f4f6f8…`) 삭제. `pageMy`의 `el('span', { 'aria-hidden': 'true', text: f.icon })` 삭제.
2. 카드 태그 칩: `el('span', { cls: 'chip ok', text: f.tag })` → `cls: 'chip tagx'`.
3. 카드 안 선택 라벨 문구 `'선택'` → `f.name + ' 선택'`(화면 낭독기가 어떤 카드인지 읽도록. 시각상 `.t`는 `선택`만 보이게 하려면 이름 부분을 `span.sr`로).
4. 인라인 색: `var(--text)` → `var(--fg)`, `var(--red)` → `var(--crit)`. 인라인 `font-weight:800`·`700` → `600`, `font-size:14.5px` → `14px`. 그 밖의 인라인 `style` 중 색·글꼴이 든 것은 클래스로 옮긴다(간격용 `margin`·`height` 인라인은 둬도 된다).
5. `toast()`·`copy()`·폴링·검증 로직은 손대지 않는다.
6. 새 함수(홈 전용, `pageHome()` 끝에서 호출): `initNav()`(`.lnav.scrolled`, 앵커 스크롤), `initDemo()`(5.2), `initFx()`(탐색기), `initHow()`(SMIL 일시정지), `initFaq()`(열기·분류), `initReveal()`(5.3). 모두 요소가 없으면 조용히 끝난다.
7. `prefers-reduced-motion` 판단은 `window.matchMedia('(prefers-reduced-motion: reduce)').matches` 하나로.

### 3.7 공개 사이트 문구 원칙

- 판매 문구는 기존 index.html의 사실(안드로이드 전용, 키 1개 = 기기 1대, 무통장 입금, 자동 발급/관리자 확인 `data-manual`)을 그대로 유지한다. 새로 더하는 것은 콘솔 소개(받은함, 계정 8개, 휴대폰 없이 서버 동작)뿐이며, 서버가 항상 켜져 있다고 약속하지 않는다(질문 `휴대폰을 꺼도 동작합니까?` 답에 `항상 켜져 있다고 보장하지 않습니다` 포함).
- 금액·할인·기간은 언제나 `/api/price` 값. 프로토타입의 15,000원 등은 예시다.

### 3.8 프로토타입 → 실제 파일 대응표 (공개)

| 프로토타입 | 실제 |
|---|---|
| `[data-pp="home"]` / `"buy"` / `"my"` / `"order"` 묶음 | 각각 `index.html` / `buy.html` / `my.html` / `order.html`의 `main#main` 내용 |
| `.pub` 접두사 CSS | 접두사 없이 `style.css` |
| `href="#home"` `#buy` `#my` `#login` | `/` `/buy` `/my` `/panel` |
| `data-scroll="features"` 등 | `href="/#features"` 등(홈 안에서는 JS 부드러운 스크롤) |
| `#planSegBuy` `#sumBuy` `#iosWarnBuy` | `#planSeg` `#sum` `#iosWarn` |
| `#fld-key-my` `#keyMy` `#key-hint-my` `#err-key-my` `#resultMy` | `#fld-key` `#key` `#key-hint` `#err-key` `#result` |
| `#resultOrd` | `#result` |
| `#ordSeg` | 없음(프로토타입 상태 전환용) |
| 프로토타입 `Picker()`·예시 가격 | app.js 기존 `Picker`·`/api/price` |
| `pubToast()` | app.js `toast()` |

---

## 4. 콘솔 (PANEL) — IA·라우팅·DOM 계약

### 4.0 화면 구성 한눈에

```
┌────────────── 248px ──────────────┬──────────────────────────────────────────────┐
│ [A] a@kakao.com  접속 중   ▾       │ ≡  a@kakao.com / 매크로      ● 발송 서버 정상 │ ← 상단 바 52px (glass)
│ [ 이동 및 검색        Ctrl K ]     ├──────────────────────────────────────────────┤
│ 개요                         G O   │                                              │
│ 받은함                    G I  3   │   ┌────────── 본문 열 1040px ──────────┐     │
│ 계정                      G A 3/8  │   │ h1 매크로                          │     │
│ K bot 설정        a@kakao.com      │   │ 설명                                │     │
│ 매크로                  G M  ●     │   │ ┌ 매크로 발송 ───────────── [■□] ┐ │     │
│ 입장·퇴장 로그          G V  ●     │   │ │ 메시지 …                        │ │     │
│ 프로필 로그             G P  ○     │   │ └─────────────────────────────────┘ │     │
│ 올킥 방지               G K  ●     │   └─────────────────────────────────────┘     │
│ 금지어 검열             G C  ●     │                                              │
│ 갠톡 응답               G R  ○     │      ┌ ● 변경사항 2건 · a@ · 매크로  [되돌리기][저장 Ctrl S] ┐ │ ← 저장 바
│ 저격 규칙               G S  ●     │      └────────────────────────────────────────────┘ │
│ KAKA-7F3Q-····  남은 기간 23일     │                                              │
│ ▔▔▔▔▔▔▔▔▔▔▔▁▁▁                     │                                              │
│ 사이트   나가기                    │                                              │
└────────────────────────────────────┴──────────────────────────────────────────────┘
```

- 사이드바 위: 계정 전환기. 그 아래 팔레트 버튼. 메뉴는 두 묶음: 전체(개요·받은함·계정)와 `K bot 설정`(현재 계정의 기능 7개, 묶음 머리에 현재 계정 이메일). 기능 항목 오른쪽 점 `.fs`: 켜짐 `--live` 채움 / 꺼짐 `--line-3` 테두리만.
- 받은함 화면은 본문 열 제한 없이 상단 바 아래 전체를 쓴다(목록 360px + 대화).
- ≤960px: 사이드바는 왼쪽에서 밀려 나오는 서랍(`#menuBtn`), 상단 바 56px.
- 스크린샷: `d-12-overview`, `d-13*`, `d-16*`, `m-24-nav-open`.

### 4.1 파일과 골격 — `public/panel.html`

```html
<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover, interactive-widget=resizes-content">
<title>관리 · K bot</title>
<meta name="robots" content="noindex">
<meta name="theme-color" content="#09090b">
<meta name="color-scheme" content="dark">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<!-- 2.3 글꼴 링크 3줄 -->
<link rel="stylesheet" href="/panel.css?v=13">
</head>
<body>
<svg …스프라이트(프로토타입 parts/b.html 첫 블록)…></svg>
<a class="skip" href="#view" id="skipLink">본문으로 건너뛰기</a>

<div id="login" class="login" hidden>…4.2…</div>

<div id="app" data-route="" hidden>
  <aside class="side" id="side" aria-label="콘솔 메뉴">…4.3…</aside>
  <div class="scrim" id="scrim"></div>
  <div class="mainc">
    <header class="topbar">…4.3…</header>
    <div class="runstate" id="runstate" role="status" hidden><i class="dot warn"></i><span class="strip-text"></span></div>
    <main class="view" id="view" tabindex="-1">
      <h1 class="sr">K bot 콘솔</h1>
      <section class="page" data-route="overview" id="page-overview" aria-labelledby="ov-title" hidden>…4.4…</section>
      <section class="page full" data-route="inbox" id="inbox" data-view="list" aria-labelledby="chat-title" hidden>…4.5…</section>
      <section class="page" data-route="accounts" id="account-block" aria-labelledby="acc-title" hidden>…4.6…</section>
      <section class="page" data-route="account-add" id="page-add" aria-labelledby="add-title" hidden>…4.6…</section>
      <section class="page" data-route="macro" id="page-macro" aria-labelledby="macro-title" hidden>…4.7…</section>
      <section class="page" data-route="visit" id="page-visit" aria-labelledby="visit-title" hidden>…4.8…</section>
      <section class="page" data-route="profile" id="page-profile" aria-labelledby="profile-title" hidden>…4.8…</section>
      <section class="page" data-route="guard" id="page-guard" aria-labelledby="guard-title" hidden>…4.9…</section>
      <section class="page" data-route="cover" id="page-cover" aria-labelledby="cover-title" hidden>…4.10…</section>
      <section class="page" data-route="reply" id="page-reply" aria-labelledby="reply-title" hidden>…4.11…</section>
      <section class="page" data-route="snipe" id="page-snipe" aria-labelledby="snipe-title" hidden>…4.12…</section>
    </main>
  </div>
</div>

<div class="save" id="save" aria-live="polite">…4.3…</div>
<div class="toasts" id="toasts" aria-live="polite"></div>
<div class="pal-wrap closed" id="palWrap" aria-hidden="true">…4.3…</div>
<script src="/panel.js?v=16"></script>
</body>
</html>
```

규칙:

- 화면은 **정적 `section.page[data-route]` 11개**다. 프로토타입은 JS 문자열로 화면을 만들지만 실제 파일은 V4처럼 폼·id를 HTML에 두고 panel.js가 값을 채운다(기존 `fillDetail()`·폼 `submit` 핸들러 재사용). 목록·표·칩처럼 개수가 바뀌는 부분만 JS가 그린다.
- 한 번에 하나만 보인다: 현재 화면 `hidden=false`, 나머지 `hidden=true`. 전환 중 잠깐 두 화면이 겹친다(5.1). `.view { display: grid }` `.view > .page { grid-area: 1 / 1 }`.
- 각 화면 제목 `h1`에는 `tabindex="-1"`. 화면 전환 뒤 포커스는 그 `h1`으로(`focus({preventScroll: true})`). 부팅 첫 화면은 포커스를 옮기지 않는다.
- 각 기능 화면 첫머리(제목 아래)에 `div.banner[data-banner][role="status"]` — 현재 계정이 `needs_register`일 때만 보인다: `{email} 카카오 로그인이 끊겼습니다. 다시 등록하기 전까지 이 계정의 기능이 동작하지 않습니다.` + `a.btn.sm[href="#account-add"][data-reg="{device_id}"]` `재등록`.
- 화면 사이 공통 조각(프로토타입 함수 → 정적 마크업): `ph()` → `.ph > div > h1 + p` / `.ph-r`; `sec()` → `section.sec` (+ `.sec-f` 바닥줄); `grp()` → `.grp > h2.grp-t(+span 보조) + 내용`; `srow()` → `.srow`(`.inline` 한 줄, `.stack` 컨트롤이 아래로, `.main` 메인 스위치 행) > `.srow-l > .lb + p` + `.srow-r`; `swb()` → 4.15 스위치; `dep()`/`offNote()` → 4.15.

### 4.2 로그인 `#login`

V4 id 유지: `#login`, `#login-form`, `#key`, `#login-error`. 스크린샷 `d-11-login`, `m-11-login`.

```html
<div id="login" class="login" hidden>
  <div class="login-card">
    <a class="brand" href="/"><span class="brand-mark" aria-hidden="true">K</span>K bot</a>
    <div>
      <h1>K bot 콘솔</h1>
      <p class="lead">라이선스 키로 들어갑니다. 콘솔 로그인은 키를 기기에 묶지 않으며 앱의 기기 등록은 그대로입니다.</p>
      <p class="lead">아직 한 번도 사용하지 않은 키는 이 화면에 처음 들어오는 시점부터 사용 기간이 시작됩니다.</p>
    </div>
    <form id="login-form" novalidate>
      <div class="fld"><label for="key">라이선스 키</label>
        <input class="inp mono" id="key" name="key" autocomplete="off" autocapitalize="characters" spellcheck="false" placeholder="KAKA-XXXX-XXXX-XXXX" required>
        <span class="errt" id="login-error" role="alert"></span></div>
      <button type="submit" class="btn primary lg wide" id="loginBtn"><span class="spin"></span><span class="lbl-idle">들어가기</span></button>
    </form>
    <div class="login-foot"><a href="/buy">키가 없으면 구매 신청</a><a href="/my">내 키 조회</a></div>
  </div>
</div>
```

- 제출 중 `#loginBtn.busy` + `disabled`(`.spin` 보이고 글자 숨김). 실패 문구는 서버 `error` 그대로(`없는 키입니다.` 등), 입력 테두리 `--crit-line`, `#key`에 `shake` 한 번.
- ≥720px에서 로그인 화면이 보이면 `#key`에 포커스.

### 4.3 셸 — 사이드바·상단 바·저장 바·토스트·팔레트

**사이드바** `aside.side#side`:

```html
<div class="acct-wrap">
  <button type="button" class="acct-btn" id="acctBtn" aria-haspopup="menu" aria-expanded="false" aria-controls="acctMenu">
    <span class="sq inv" id="acctSq">A</span>
    <span class="acct-meta"><b id="acctEmail" class="mono"></b><small id="acctState"></small></span>
    <svg …i-updown…></svg>
  </button>
  <div class="menu closed" id="acctMenu" role="menu" aria-label="계정 전환"></div>
</div>
<button type="button" class="side-search" id="openPal">[i-search]이동 및 검색<kbd id="kbdHint">Ctrl K</kbd></button>
<nav class="side-nav" id="nav" aria-label="화면">
  <span class="nav-ind" id="navInd"></span>
  <a class="nav-a" href="#overview" data-r="overview">[i-overview]개요<span class="r"><span class="kb" aria-hidden="true">G O</span></span></a>
  <a class="nav-a" href="#inbox" data-r="inbox">[i-inbox]받은함<span class="r"><span class="kb" aria-hidden="true">G I</span><b class="badge-n" id="navUnread" hidden></b></span></a>
  <a class="nav-a" href="#accounts" data-r="accounts">[i-accounts]계정<span class="r"><span class="kb" aria-hidden="true">G A</span><span class="cnt mono" id="navAcctN"></span></span></a>
  <p class="nav-cap"><span>K bot 설정</span><span class="mono" id="navCapAcct"></span></p>
  <a class="nav-a" href="#macro" data-r="macro">[i-macro]매크로<span class="r"><span class="kb" aria-hidden="true">G M</span><span class="dirty">수정됨</span><i class="fs" data-fs="macro"></i></span></a>
  … visit(입장·퇴장 로그, G V, data-fs="visit") · profile(프로필 로그, G P, "profile") · guard(올킥 방지, G K, "guard")
  · cover(금지어 검열, G C, "cover") · reply(갠톡 응답, G R, "autoreply") · snipe(저격 규칙, G S, "triggers") 같은 모양
</nav>
<div class="side-foot">
  <div class="lic"><div class="row1"><span class="mono" id="who"></span><span id="licLeft"></span></div><span class="track" aria-hidden="true"><i id="licBar"></i></span></div>
  <div class="links"><a href="/">[i-home]사이트</a><button type="button" id="logout">[i-logout]나가기</button></div>
</div>
```

- `#kbdHint`: Mac(`/Mac|iPhone|iPad/.test(navigator.platform)`)이면 `⌘ K`, 아니면 `Ctrl K`. 저장 바 `#saveKbd`도 같은 규칙(`⌘ S`/`Ctrl S`).
- 현재 화면 `.nav-a`에 `aria-current="page"`(`account-add`이면 `accounts` 항목). `.nav-ind`가 그 항목 위치로 미끄러진다(5.3).
- 기능 상태: `.fs[data-fs]`에 `on` 클래스, `title`과 부모 `.nav-a`의 `aria-description`에 `켜짐`/`꺼짐`. 저격 규칙은 규칙 하나라도 `enabled`이면 켜짐.
- 저장 안 한 변경이 있는 화면의 `.nav-a`에 `.is-dirty`(`.dirty` `수정됨` 글자 표시, `.fs` 숨김).
- `#navUnread`: 전체 안 읽음(UI_V4 `totalUnread()`), 0이면 `hidden`. 늘어날 때 `bump`. `#navAcctN` = `{등록 수}/8`. `#navCapAcct` = 현재 계정 이메일.
- `#who` = `me.mask`. `#licLeft` = `남은 기간 {N}일`(`Math.ceil((expires_at - now) / 86400000)`, 1일 미만이면 `오늘 만료`). `#licBar` `transform: scaleX(min(N, 30) / 30)`; N ≤ 7이면 `.lic.warn`(새 규칙: `.lic.warn .track i { background: var(--warn) }`, `.lic.warn #licLeft { color: var(--warn) }`). 만료 날짜를 `title`에 `YYYY.MM.DD 만료`.
- `#logout`: `POST /panel/api/logout` 뒤 로그인 화면(V4 핸들러 유지). 저장 안 한 변경이 있으면 먼저 저장 바 떠나기 묻기(4.14).

**계정 전환 메뉴** `#acctMenu[role=menu]`(열림: `.closed` 제거, `#acctBtn[aria-expanded=true]`):

- 머리 `p.menu-cap` `설정은 계정마다 따로 저장됩니다`.
- 계정마다 `button.menu-i[role=menuitemradio][aria-checked][data-switch="{device_id}"]` > `span.sq`(첫 글자, 현재 계정 `.inv`) + `span.grow.mono` 이메일 + 상태 점(`접속 중` live / `등록 필요` crit, `aria-label`).
- 구분선, `a.menu-i[href="#account-add"]` `계정 추가` + `{n}/8`, `a.menu-i[href="#accounts"]` `계정 관리`.
- 키보드: ↑↓ 이동, Enter 선택, Esc 닫고 `#acctBtn`으로 포커스. 바깥 클릭 닫힘.
- 선택 → `switchAccount(device_id)`(4.14 떠나기 확인 → `openAccount(id)` → 현재 화면 그대로 다시 채움. 개요·기능 화면이면 같은 화면 교차 전환 5.1).
- `#acctState`: `<i class="dot live"></i>접속 중` / `<i class="dot crit"></i>등록 필요` / `<i class="dot warn"></i>연결 대기`(UI_V4 `stateOf()`).

**상단 바** `header.topbar`:

```html
<button type="button" class="menu-btn" id="menuBtn" aria-label="메뉴 열기" aria-expanded="false" aria-controls="side">[i-menu]</button>
<div class="crumbs"><span class="c-acct" id="crAcct"></span><span class="sl" aria-hidden="true">/</span><b id="crPage"></b></div>
<div class="top-r">
  <span class="sync" id="sync"><i class="dot live"></i><span class="txt">발송 서버 정상</span></span>
  <button type="button" class="top-search" id="topSearch" aria-label="이동 및 검색">[i-search]</button>
</div>
```

- `#crAcct`: 계정별 화면(개요, 기능 7개)은 현재 계정 이메일(`.mono`), 받은함·계정·계정 추가는 `전체 계정`. `#crPage` = 1.4 화면 이름.
- `#sync`: `inboxSt.senderUp`이면 `● 발송 서버 정상`(live), 아니면 `● 발송 중지`(warn). 폰에서는 숨김.
- `#menuBtn`, `#topSearch`는 ≤960px에서만 보인다.
- `#runstate`(V4 4.7 그대로): `sender_up:false`면 보이고 `.down`, `.strip-text` = `sender_reason` 또는 `발송 작업이 멈춰 있습니다. 작업이 다시 시작되면 저장된 계정으로 이어서 접속합니다.`

**서랍(≤960px)**: `#menuBtn` → `#app.nav-open`(사이드바 `translateX(-102%)` → `none`, `#scrim` 페이드), `aria-expanded=true`, 첫 `.nav-a`로 포커스. 닫기: `#scrim` 클릭, Esc, 메뉴 항목 선택, 화면 전환. 스크린샷 `m-24-nav-open`.

**저장 바** `#save`:

```html
<div class="save" id="save" aria-live="polite">
  <div class="save-in" role="region" aria-label="저장">
    <span class="save-t"><i class="dot"></i><span id="saveTxt"></span></span>
    <button type="button" class="btn ghost when-edit" id="saveRevert">되돌리기</button>
    <button type="submit" class="btn primary when-edit" id="saveBtn" form=""><span class="spin"></span><span class="lbl-idle">저장</span><kbd class="kb-s" id="saveKbd">Ctrl S</kbd></button>
    <button type="button" class="btn ghost when-leave" id="leaveStay">머무르기</button>
    <button type="button" class="btn when-leave" id="leaveDrop">버리기</button>
    <button type="button" class="btn primary when-leave" id="leaveSave"><span class="spin"></span><span class="lbl-idle">저장</span></button>
  </div>
</div>
```

- `#saveBtn`은 `type="submit"`이고 `form` 속성을 현재 화면의 폼 id로 바꿔 단다(`macro-form` `visit-form` `profile-form` `guard-form` `cover-form` `reply-form` `snipe-form`). 그래서 저장은 V4의 폼 `submit` 핸들러가 그대로 처리한다. Ctrl/⌘S = `document.getElementById(form).requestSubmit()`.
- 표시: `#save.show`(아래에서 올라옴). `#saveTxt` = `변경사항 <b>{N}건</b><span class="ctx"> · <span class="mono">{email}</span> · {화면 이름}</span>`. 저장 중 `#saveBtn.busy`. 성공하면 바가 내려가고 토스트 `저장했습니다.` + `{email} · {화면 이름}`. 실패하면 바 유지, 그 화면 폼의 `#…-error`에 서버 문구, 바 `shake`.
- 떠나기 모드 `#save.show.leave`: `#saveTxt` = `저장하지 않은 변경이 있습니다.` `.when-edit` 숨김, `.when-leave` 보임, 점 `--warn`. 4.14.
- 폰: `.ctx`와 `#saveKbd` 숨김, 좌우 16px.

**토스트** `#toasts`(오른쪽 아래, 저장 바가 보이면 76px 위로): `div.toast` > 점(종류별) + `div > b 제목 + span 보조` + 선택 `button.btn.sm` 작업(예: `되돌리기`) + 닫기 `button[aria-label="알림 닫기"]`. 2.8초 뒤 `.bye`로 사라짐(작업 버튼이 있으면 6초). 한 번에 최대 3개(넘치면 가장 오래된 것부터 지움). 프로토타입 `toast(title, sub, {kind, action})`와 같은 모양. V4의 `say(id, text)` 인라인 오류는 그대로 쓰고, 토스트는 저장 성공·되돌리기 제안·복사 완료·팔레트 안내에만 쓴다.

**팔레트** `#palWrap`(Ctrl/⌘K, `#openPal`, `#topSearch`):

```html
<div class="pal-wrap closed" id="palWrap" aria-hidden="true">
  <div class="pal" role="dialog" aria-modal="true" aria-label="이동 및 검색">
    <div class="pal-in">[i-search]<input id="palIn" type="text" placeholder="화면 또는 설정 이름 입력" autocomplete="off" spellcheck="false" role="combobox" aria-expanded="true" aria-controls="palList" aria-autocomplete="list"><kbd>Esc</kbd></div>
    <div class="pal-list" id="palList" role="listbox" aria-label="결과"></div>
    <div class="pal-foot"><span><kbd>↑</kbd> <kbd>↓</kbd> 이동</span><span><kbd>Enter</kbd> 열기</span><span><kbd>Esc</kbd> 닫기</span><span style="margin-left:auto"><kbd>G</kbd> 다음 글자로 바로 이동</span></div>
  </div>
</div>
```

- 항목 묶음(`p.pal-cap[role=presentation]` 머리): `이동`(화면 10개, 오른쪽 `kbd` `G O` 등), `설정`(아래 표), `작업`(`계정 추가` → `#account-add`, `저격 규칙 추가` → `#snipe` 후 `#add-trigger` 클릭, `사이트로 이동` → `/`), `계정 전환`(계정마다 1개, 보조 글자 상태 라벨).
- 항목 `button.pal-i[role=option][id="pi{n}"][aria-selected][tabindex=-1]` > 아이콘 + `span.grow`(`em` `{위치} / ` + 이름) + `span.hint`(현재 화면이면 `현재 화면`, 현재 계정이면 `선택됨`, 아니면 단축키 `kbd`). 입력하면 `이름 + 위치 + 묶음` 문자열에 부분 일치(소문자 비교)로 거른다. **빈 입력일 때는 `설정` 묶음 중 표의 ★ 항목만** 보인다. `#palIn[aria-activedescendant]` 갱신, 선택 항목 `.act`. 결과 없음 → `p.pal-empty` `일치하는 화면이나 설정이 없습니다.`
- 설정 항목(이동 후 그 행으로 스크롤 + 행 깜빡임 `.flash` + 행 안 첫 컨트롤 포커스. 그 기능이 꺼져 있어 행이 접혀 있으면 메인 스위치 행으로 대신 가고 토스트 warn `{화면 이름}{이/가} 꺼져 있습니다.` / `켜면 이 설정이 표시됩니다. 스위치로 이동했습니다.`):

| 이름 | 위치 | 이동 대상 id |
|---|---|---|
| 메시지 | 매크로 | `macro-message` |
| 기본 간격 ★ | 매크로 | `base-min` |
| 방별 간격 | 매크로 | `row-macro-rooms` |
| 이미지 | 매크로 | `row-macro-img` |
| 기록할 대화방 | 입장·퇴장 로그 | `row-visit-rooms` |
| 방에 보내는 안내 | 입장·퇴장 로그 | `row-visit-notice` |
| 프로필 변경 감지 | 프로필 로그 | `row-profile-on` |
| 감지 시간과 강퇴 수 ★ | 올킥 방지 | `guard-secs` |
| 추가 금지어 ★ | 금지어 검열 | `cover-word-in` |
| 링크 가리기 | 금지어 검열 | `row-cover-links` |
| 응답 메시지 | 갠톡 응답 | `reply-message` |
| 쿨타임 | 갠톡 응답 | `reply-hours` |

- 설정 행 id: 각 `.srow`에 `row-{기능}-{칸}` id를 단다 — `row-macro-on|msg|img|base|rand|viz|rooms`, `row-visit-on|rooms|notice`, `row-profile-on|rooms|notice`, `row-guard-on|rooms|secs|count|preview`, `row-cover-on|rooms|base|words|links`, `row-reply-on|msg|cool|preview`.
- 열기/닫기 모션 5.3. 열면 `#palIn` 포커스, 닫으면 연 요소로 포커스 복귀. 바깥(scrim) 클릭·Esc로 닫힘.
- **G 단축키**: 입력 요소 밖에서 `g` 누른 뒤 1초 안에 `o i a m v p k c r s` → 그 화면. 팔레트 열림·IME 조합 중·수정키 조합이면 무시.

### 4.4 개요 `#overview` (기본 화면)

목적: 들어오자마자 확인할 것, 오늘 수치, 기능 켜고 끄기, 계정 전환, 최근 기록. 스크린샷 `d-12-overview`, `d-12b-overview-toggle`, `m-12*`.

```html
<section class="page" data-route="overview" id="page-overview" aria-labelledby="ov-title" hidden>
 <div class="col">
  <div class="ph"><div><h1 id="ov-title" tabindex="-1">개요</h1>
      <p><span class="mono" data-acct-email></span> 계정의 기능 상태와 최근 기록입니다. 스위치는 누르는 즉시 저장됩니다.</p></div>
    <div class="ph-r"><a class="btn" href="#inbox">[i-inbox]받은함 <b class="badge-n" id="ov-unread" hidden></b></a>
      <a class="btn primary" href="#account-add" id="ov-add">[i-plus]계정 추가</a></div></div>
  <div class="banner" data-banner role="status" hidden></div>
  <div class="grp" id="ov-attn" hidden><h2 class="grp-t">확인 필요<span id="ov-attn-n"></span></h2>
    <section class="sec" aria-label="확인 필요" id="ov-attn-list"></section></div>
  <div class="metrics" role="list">
    <div class="metric" role="listitem" data-metric="unread"><span class="k">안 읽은 갠톡<span>전체 계정</span></span><div class="v"><b></b></div><span class="d"></span></div>
    <div class="metric" role="listitem" data-metric="join"><span class="k">오늘 입장<span>24시간</span></span><div class="v"><b></b><svg class="spark" …></svg></div><span class="d"></span></div>
    <div class="metric" role="listitem" data-metric="leave">…오늘 퇴장…</div>
    <div class="metric" role="listitem" data-metric="name">…이름 변경…</div>
  </div>
  <div class="ov-grid">
    <div class="grp"><h2 class="grp-t">기능<span class="mono" data-acct-email></span></h2>
      <section class="sec" aria-label="기능">
        <div class="feat-h" aria-hidden="true"><span>기능</span><span class="h-r">대화방</span><span class="h-l">요약</span><span>사용</span><span></span></div>
        <div class="feat" data-feat="macro" data-go="macro" role="link" tabindex="0" aria-label="매크로 설정 열기">
          <div class="fn"><b><i class="fs" data-ovdot="macro"></i>매크로</b><span>홍보 메시지 주기 발송</span></div>
          <div class="fr" data-rooms="macro"></div>
          <div class="fl" data-sum="macro"></div>
          <div><span class="swl"><input type="checkbox" role="switch" class="swi" data-ov="macro" aria-label="매크로 사용"><span class="sw" aria-hidden="true"></span></span></div>
          <span class="go">[i-right]</span>
        </div>
        … visit · profile · guard · cover · autoreply(갠톡 응답) · triggers(저격 규칙) 같은 모양.
          triggers 행의 스위치 자리는 <span class="mono" data-sum-n="triggers"></span> (사용 중 규칙 수/전체)
      </section></div>
    <div class="ov-side">
      <div class="grp"><h2 class="grp-t">계정<span id="ov-acct-n"></span></h2>
        <section class="sec"><div id="ov-accts"></div>
          <div class="sec-f"><span>누르면 그 계정으로 전환합니다.</span><a class="btn sm" href="#account-add">[i-plus]추가</a></div></section></div>
      <div class="grp"><h2 class="grp-t">최근 기록</h2>
        <section class="sec clip"><ul class="feed" id="ovFeed"></ul>
          <div class="sec-f"><span class="poll" data-poll>…10초마다 갱신…</span><a class="btn sm" href="#visit">전체 기록</a></div></section></div>
    </div>
  </div>
 </div>
</section>
```

데이터와 계산(모두 실제 API 값. 예시 숫자 금지):

| 칸 | 출처 | 규칙 |
|---|---|---|
| `#ov-attn-list` | `GET /panel/api/logs` `guard[0]` + `me.accounts` | 24시간 안의 올킥 감지 1건(행: `● 올킥 감지 21:02` + 서버 문구 + `올킥 방지` 버튼 → `#guard`; 점 `.crit.pulse`) + `needs_register` 계정마다 행(`● c@kakao.com 등록 필요` + `카카오 로그인이 끊겼습니다. 다시 등록하기 전까지 이 계정의 기능이 동작하지 않습니다.` + `재등록` → `#account-add` 재등록 모드). 없으면 `#ov-attn` 숨김. `#ov-attn-n` = `{n}건` |
| 안 읽은 갠톡 | `/inbox` | `totalUnread()`. `.d` = 접속 중 계정마다 `{이메일 @ 앞}{n}` `·`로 연결 |
| 오늘 입장 / 퇴장 | `logs.visit[].joins[]` / `leaves[]` | 오늘 0시 이후 개수. 스파크 = 지금부터 거꾸로 24시간 시간대별 막대 24개(4.15). `.d` = `어제 {n}건 · +{차}` / `−{차}` |
| 이름 변경 | `logs.profile[].changes[].at` | 같은 규칙 |
| `.fs` / `.feat.off` / `data-ov` | `account` | 기능 켜짐 여부 |
| `.fr[data-rooms]` | `account[key].rooms.length` | `{n}개 방` / `방 없음`(`--fg-3`). 갠톡 응답 `1:1`, 저격 규칙 `{n}개 규칙` |
| `.fl[data-sum]` | `account` + `logs` | 매크로 `{baseMin}~{baseMin+randomMin}분 간격 · 이미지 {n}장`(랜덤 0이면 `{baseMin}분 간격`, 이미지 0이면 생략) / 입장·퇴장 최근 1건 `21:14 입장 · 하늘` / 프로필 최근 1건 `21:15 하늘 → 하늘_판매` / 올킥 최근 1건 `21:02 올킥 감지 · {방}`(문구의 「」 안) / 금지어 `금지어 {n}개 · 링크 가림|허용` / 갠톡 응답 `쿨타임 {n}시간` / 저격 `규칙 {n}개 중 {m}개 사용`. 값이 없으면 `기록 없음`(`--fg-3`) |
| `#ov-accts` | `me.accounts` + `/inbox` | 계정마다 `button.acc-li[data-acct]` > `.sq` + 이메일(모노) + `small`(상태 점·라벨, 현재 계정만 ` · 기능 {켜진 수}/7`) + 안 읽음 `badge-n` 또는 현재 계정 `span.tag.line 선택됨`. 누르면 계정 전환. `#ov-acct-n` = `{n} / 8` |
| `#ovFeed` | `logs` | 올킥·프로필·입장·퇴장을 합쳐 최신 8건: `li` > `time`(HH:MM 모노) + `span.ty`(`입장` `퇴장` `프로필` `올킥`, 올킥은 `.crit`) + `span.tx`(이름 또는 `이전 → 현재` + `small` 방). 없으면 `기록이 없습니다. 입장·퇴장 로그나 프로필 로그를 켜면 이곳에 표시됩니다.` |

동작:

- **즉시 저장 스위치** `input[data-ov]`: `change` → 그 기능 객체 전체를 바꿔 `POST /panel/api/settings` `{device_id, images_unchanged: true, [key]: {...account[key], enabled: checked}}`(macro는 V4 매크로 저장과 같은 필드 구성). 요청 중 스위치 `disabled`. 성공: `account = res.account` → 행 `.off` 토글, 사이드바 `.fs` 갱신, 토스트 `{화면 이름}{을/를} 켰습니다.`/`껐습니다.` + `{email}` + 작업 버튼 `되돌리기`(같은 요청을 이전 값으로). 실패: 스위치 원위치, 토스트 kind `crit` `저장하지 못했습니다.` + 서버 문구. 저격 규칙 행은 스위치가 없다(규칙별 켜기는 저격 규칙 화면에서).
- `.feat` 클릭·Enter → `data-go` 화면. 스위치 클릭은 행 이동을 막는다(`stopPropagation`).
- 기록 읽기: 개요에 들어올 때와 그 뒤 10초마다 `GET /panel/api/logs?device_id=`(4.8 폴링 규칙 공유). 새로 생긴 피드 항목만 `.fresh`(5.4).
- 처음 들어올 때만 지표 숫자·스파크·피드에 진입 모션(5.3). 폴링·계정 전환 재계산은 움직이지 않는다(5.5).

### 4.5 받은함 `#inbox` — UI_V4 동작 그대로, 모양만 V5

**동작은 UI_V4 5장 전부를 그대로 쓴다**(상태 객체, 9초/3초 폴링, `applyInbox`, 재렌더 회피 서명, 늦은 응답 버리기, 안 읽음, `selectRail`, `openConversation`, `sendChat`(`device_id: chat.deviceId`), `closeConversation`, 초안 삭제, 409/503 처리, 키보드, visibilitychange). 바뀌는 것만 적는다. 스크린샷 `d-13-inbox`, `d-13b-inbox-open`, `m-13*`.

변경점:

1. **레일 → 필터 칩.** V4 왼쪽 72px 계정 레일은 없어지고, 목록 머리의 칩 줄이 같은 일을 한다. 계정 추가·설정 버튼은 사이드바가 대신한다. id는 V4를 유지한다(테스트·코드 재사용).
2. **모드 → 라우트.** `#console[data-mode]`는 없다. 받은함은 `#app[data-route="inbox"]`. `data-view="list|room"`은 `#inbox`에 단다(폰 대화 열림).
3. **설정 탭 → 사이드바.** `#settings`, `#settings-acct`, `#tabs`, `.tab`, `.tval`, `#detail`, `#detail-where`, `.row-actions`, `#rail-add`, `#rail-settings`는 없다. `#thread-settings`(대화 머리 `설정`)는 그 대화 계정으로 전환한 뒤 `#macro`로 간다.
4. 폰 뒤로 가기: `history.pushState({ kview: 'room' }, '', '#inbox')`. `popstate`에서 `ev.state && ev.state.kview === 'room'`이면 무시, `#inbox[data-view="room"]`이고 `location.hash === '#inbox'`이면 `closeConversation()`.
5. 받은함은 본문 열 제한 없음(`.page.full`), 높이 `calc(100dvh - var(--top-h))`. 목록 360px(≤1100px 320px), 대화 나머지. 폰은 한 번에 하나(목록 ↔ 대화 미끄러짐, 5.3).

DOM:

```html
<section class="page full" data-route="inbox" id="inbox" data-view="list" aria-labelledby="chat-title" hidden>
 <h1 class="sr" id="chat-title" tabindex="-1">전체 대화</h1>
 <div class="ib">
  <div class="ib-list kkt-list" id="kkt">
    <div class="ib-lh">
      <div class="ib-filter" id="rail" role="toolbar" aria-label="계정 필터">
        <button type="button" class="fchip" id="rail-all" data-device="" aria-pressed="true">전체<span class="n rail-badge" hidden></span></button>
        <span id="rail-accounts" class="rail-accounts"></span>
      </div>
      <div class="row">
        <input class="inp" id="chat-search" type="search" placeholder="이름 또는 내용 검색" aria-label="대화 검색" autocomplete="off">
        <button type="button" class="btn" id="chat-unread" aria-pressed="false">안 읽음<span id="chat-unread-n" class="n" hidden></span></button>
      </div>
    </div>
    <div id="chat-notice" class="ib-notice" role="status" hidden></div>
    <p id="chat-error" class="errt" role="alert"></p>
    <div class="ib-rows" id="chat-rooms" role="list" aria-label="대화 목록"></div>
    <div class="ib-foot"><span class="poll" data-poll>…9초마다 갱신…</span>
      <span class="ib-foot-r"><span id="chat-total"></span><button type="button" class="btn sm ghost" id="chat-reload" aria-label="대화 목록 새로고침">[i-refresh]</button></span></div>
  </div>
  <div class="ib-th kkt-room">
    <div class="th-h kkt-head">
      <button type="button" class="back" id="chat-back" aria-label="대화 목록으로">[i-back]</button>
      <span class="av" id="chat-head-ava" aria-hidden="true"></span>
      <div class="who"><b id="chat-peer">선택한 대화 없음</b><small id="chat-head-sub"></small></div>
      <span class="st-l"><span class="state" id="thread-state" data-state="" hidden></span></span>
      <button type="button" class="btn sm ghost" id="thread-settings" hidden>설정</button>
    </div>
    <div class="th-log" id="chat-log" tabindex="0" aria-label="대화 내용"></div>
    <button type="button" class="newpill" id="chat-newpill" hidden></button>
    <p class="sr" id="chat-live" aria-live="polite"></p>
    <form class="comp kkt-compose" id="chat-form">
      <p class="comp-note" id="chat-note" role="status"></p>
      <div class="comp-box">
        <textarea id="chat-text" rows="1" maxlength="1000" placeholder="선택한 대화 없음" aria-label="메시지" aria-describedby="chat-note" autocomplete="off" disabled></textarea>
        <button type="submit" class="btn primary sm" id="chat-send" disabled aria-label="보내기">[i-send]<span>전송</span></button>
      </div>
      <div class="comp-meta"><span class="hint-k" id="compose-hint">Enter 전송 · Shift+Enter 줄바꿈</span><span class="mono" id="chat-count" aria-live="polite" hidden></span></div>
    </form>
  </div>
 </div>
</section>
```

JS가 그리는 부분(V4 함수 이름 유지):

- `renderRail()` → `#rail-accounts` 안에 계정마다 `button.fchip.rail-acct[data-device][data-state][aria-pressed]` > `span.mono`(이메일 @ 앞, `title` 전체 이메일) + 안 읽음 `span.n.rail-badge` 또는 `등록 필요`/`응답 없음`/`발송 중지`일 때 `span.rd.rail-dot`(`--crit`/`--warn` 6px 점). `aria-label` = `{email} · {상태 라벨} · 안 읽음 {n}`(해당하는 것만). `#rail-all .rail-badge` = 전체 안 읽음. 현재 필터 칩 `aria-pressed="true"`(V4 `aria-current` 대신. 테스트 8.2).
- `#chat-title` 텍스트: 전체면 `전체 대화`, 계정 필터면 그 이메일(V4 19항 유지; 화면 낭독기 제목).
- `updateNotice()` → `#chat-notice`: 머리 `p.kkt-notice-title`(`확인이 필요한 계정 {n}개`, 계정 필터 중이면 생략) + 계정마다 `div.kkt-notice-row` > 점 + `span.kkt-notice-text`(`{email} · 등록 필요` / `{email} · 응답 없음`) + 등록 필요일 때만 `button.btn.sm` `등록`(→ `startReauth()` = `#account-add` 재등록 모드, 4.6).
- `renderConvList()` → `#chat-rooms` 안에 `button.kkt-row[role=listitem][data-key][data-device][data-id][aria-current]` > `span.av`(이름 첫 글자, `--bg-4`) + `span` > `span.nm`(이름 + 전체 필터이고 계정 2개 이상이면 `span.kkt-acc.chip-acct` 이메일 @ 앞) + `span.pv`(미리보기, 내가 보낸 것이면 `나: `) + `span.tm` > `time.kkt-time` + 안 읽음 `b.kkt-badge.badge-n`(앞에 `span.sr 안 읽음 `). 안 읽은 행 `.unread`(이름 굵게). 빈 목록 `div.kkt-empty` > `p.kkt-empty-title` + 설명: `받은 갠톡 없음`/`오픈프로필 1:1 채팅(갠톡)이 오면 여기에 나타납니다.`, `검색 결과 없음`/`검색어에 맞는 대화가 없습니다.`, `안 읽은 대화 없음`/`모든 대화를 읽었습니다.`, `등록된 계정 없음` + `a.btn.sm[href="#account-add"]` `계정 등록`(V4 13항).
- `#chat-total` = `대화 {n}개`(보이는 행 수).
- `renderThread()` → `#chat-log` 안: 날짜가 바뀔 때 `span.kkt-day[role=separator]`(`2026년 10월 9일`), 메시지마다 `div.kkt-line(.me)` > `div.kkt-bubble`(받은 말 `--bg-2`, 내 말 `--inv` 바탕 `--inv-fg` 글자) + `time.kkt-at`(`21:16` 모노; 내 말이면 `21:16 · {이메일 @ 앞} · 전송됨`, 보내는 중이면 `전송 중`). 사진 등 `label`이 있으면 말풍선 안 `span.kkt-label`. 1:1 로그에 상대 아바타·이름 없음(V4 37항).
- `#chat-head-sub` = `<span class="kkt-acc chip-acct">{email}</span> 계정으로 답장` — **텍스트가 정확히 `{email} 계정으로 답장`이 되도록 칩 뒤에 공백 하나**(V4 20항).
- `#thread-state` = 상태 라벨, `data-state`(live·linking·needs_register·error·sender_down), 점 포함.
- 대화가 없을 때 대화 창: `div.th-empty` > 아이콘 + `b.th-empty-t` `선택한 대화 없음` + `대화를 선택하면 내용이 표시됩니다.` + 데스크톱만 `목록에서 ↑ ↓로 이동하고 Enter로 엽니다.`
- 입력창 막힘 문구(`#chat-note`, V4 5.3/5.9): 409 → `카카오 로그인이 끊겼습니다. 계정 화면에서 다시 등록해 주세요.` + `a.btn.sm` `재등록`, 503 → 서버 문구 또는 `발송 작업이 멈춰 있습니다.`, 그 밖 → `메시지를 보내지 못했습니다. 잠시 뒤 다시 해 주세요.` placeholder: `메시지 입력` / `다시 등록 필요` / `발송 작업 중지` / `선택한 대화 없음`.
- `#chat-count`: 900자 이상일 때만 `912/1,000`(V4 29항).
- 목록 ↑↓: 포커스가 행에 있으면 위/아래 행으로 포커스 이동(열지는 않음), Enter·Space로 열기.

### 4.6 계정 `#accounts`·계정 추가 `#account-add`

**계정 목록** — 스크린샷 `d-14-accounts`, `d-14b-accounts-confirm`, `m-14*`.

```html
<section class="page" data-route="accounts" id="account-block" aria-labelledby="acc-title" hidden>
 <div class="col">
  <div class="ph"><div><h1 id="acc-title" tabindex="-1">계정</h1><p>한 라이선스 키에 카카오 계정을 최대 8개까지 등록합니다. 등록된 계정의 발송과 기록은 서버가 수행합니다.</p></div>
    <div class="ph-r"><a class="btn primary" href="#account-add" id="acc-add">[i-plus]계정 추가</a></div></div>
  <div class="cap-bar"><span class="track"><i id="acc-cap"></i></span><span class="mono" id="acc-cap-n">0 / 8</span><span>등록됨</span></div>
  <section class="sec clip"><div class="tbl-wrap">
    <table class="tbl acct-tbl stack"><thead><tr><th>계정</th><th>상태</th><th>안 읽음</th><th style="text-align:right">관리</th></tr></thead>
      <tbody id="account-list"></tbody></table></div>
    <div class="sec-f"><span>카카오 비밀번호는 저장하지 않습니다. 로그인이 끊긴 계정은 재등록이 필요합니다.</span></div></section>
  <footer class="limit" aria-labelledby="limitT"><h2 class="grp-t" id="limitT">서버 운영 조건</h2>
    <p>발송은 K bot 서버가 수행합니다. 계정을 등록한 뒤에는 휴대폰을 꺼도 서버 프로세스가 동작하는 동안 해당 계정으로 발송합니다. 휴대폰은 등록할 때 카카오톡에 확인 번호를 입력하는 데에만 필요합니다.</p>
    <p>서버는 약 10분마다 자기 주소를 호출해 유휴 상태로 잠드는 것을 방지합니다. 이 호출이 실패하거나, 프로세스가 메모리 부족으로 종료되거나, 무료 사용 한도로 인스턴스가 중지되면 그 사이에는 발송하지 않습니다. 항상 켜져 있다고 보장하지 않습니다. 계정은 데이터베이스에 남으며, 프로세스가 다시 시작되면 이어서 접속합니다.</p></footer>
 </div>
</section>
```

- `renderAccounts()` → `#account-list` 행: `tr.rowx[data-acc-row]` > 계정(`.who` > `.sq` + `b.mono` 이메일 + `small` device_id) / 상태(`stateHtml`) / 안 읽음(`badge-n` 또는 `0`) / 관리(`.acts`: 등록 필요면 `a.btn.sm.primary` `재등록`(`data-reg`), `button.btn.sm` `설정`(`data-acct-set` → 그 계정으로 전환 후 `#macro`), `button.btn.sm.ghost` `[i-unlink]해제`(`data-unlink`, `aria-label="{email} 등록 해제"`)).
- 바로 다음 `tr.confirm-row[data-confirm]` > `td[colspan=4]` > `.confirm-in > div > .confirm-box[role=group][aria-label="등록 해제 확인"]`: `{email} 등록을 해제합니다. 이 계정의 서버 발송과 기록이 중지됩니다.` + `취소`(`data-unlink-no`) + `button.btn.sm.danger.solid` `해제`(`data-unlink-yes`). `해제` 누르면 이 줄이 펼쳐지고(5.3) `취소`로 포커스. **V4 `again`·`unlink`의 `window.confirm` 호출은 모두 이 인라인 확인으로 바꾼다.** 해제 성공 → `forget` 후 `refreshMe()`, 토스트 `등록을 해제했습니다.` + 이메일. 실패 → 확인 줄 안에 서버 문구.
- 등록 0개: 표 대신 `p.empty` `등록된 계정이 없습니다. 계정 추가를 눌러 첫 계정을 등록하십시오.`; 부팅 기본 화면은 `#account-add`(V4 13항의 대응).
- 8개면 `#acc-add`·`#ov-add`·메뉴 `계정 추가`에 `aria-disabled="true"`, 누르면 토스트 `계정은 8개까지 등록할 수 있습니다.`
- 등록일 열 없음(API에 `created_at`이 없다).

**계정 추가(등록 마법사)** — 스크린샷 `d-15-account-add-1`, `d-15b-account-add-2`, `d-15c-account-add-3`, `d-15d-account-reauth-conflict`, `m-15*`.

```html
<section class="page" data-route="account-add" id="page-add" aria-labelledby="add-title" hidden>
 <div class="col">
  <div class="ph"><div><h1 id="add-title" tabindex="-1">계정 추가</h1><p id="add-desc">카카오 계정을 입력한 뒤, 휴대폰 카카오톡에 표시된 입력란에 번호를 입력합니다.</p></div>
    <div class="ph-r"><span class="cap-bar"><span class="mono" id="add-cap">0 / 8</span><span>사용</span></span></div></div>
  <ol class="stepper" id="add-steps" aria-label="진행 단계">
    <li class="stp" data-s="1"><span class="bar"><i></i></span><span class="lbl"><span class="num-c"><span>1</span>[i-check]</span><span class="t">계정 입력</span></span></li>
    <li class="stp" data-s="2">… 카카오톡에 번호 입력</li>
    <li class="stp" data-s="3">… 완료</li>
  </ol>
  <div class="wz-grid">
   <div class="wz-stage" id="add-stage">
    <form class="wz-card wz-pane" id="add-form" data-step="1" novalidate>
      <div class="wz-body">
        <div class="fld"><label for="email">카카오계정</label><input class="inp" id="email" type="email" autocomplete="username" placeholder="name@kakao.com 또는 전화번호"><span class="errt" id="email-error" role="alert"></span></div>
        <div class="fld"><label for="password">비밀번호</label><input class="inp" id="password" type="password" autocomplete="current-password" placeholder="카카오계정 비밀번호"><span class="errt" id="password-error" role="alert"></span></div>
        <p class="errt" id="add-error" role="alert"></p>
      </div>
      <div class="sec-f"><span>비밀번호는 저장하지 않습니다.</span><span class="acts"><a class="btn" href="#accounts">취소</a><button type="submit" class="btn primary" id="add-next"><span class="spin"></span><span class="lbl-idle">다음</span></button></span></div>
    </form>
    <div class="wz-card wz-pane" id="passcode" data-step="2" hidden>
      <div class="pass-grid">
        <div>
          <p class="eyebrow" id="code-title">카카오톡에 입력할 번호</p>
          <div class="pass-code" id="code" aria-live="polite"></div>
          <p class="pass-copy"><span id="code-left"></span></p>
          <p class="wait" id="code-wait" role="status"></p>
          <div id="force-box" class="conflict" role="alert" hidden>
            <span><b>같은 계정이 다른 태블릿·PC에 접속되어 있어 등록하지 못했습니다.</b> 다른 기기 접속을 끊으면 그 기기의 카카오톡이 로그아웃되고 이 계정을 다시 등록합니다.</span>
            <button type="button" class="btn sm" id="force">다른 기기 끊기</button>
          </div>
          <p class="errt" id="code-error" role="alert"></p>
        </div>
        <div class="cring" aria-hidden="true"><svg viewBox="0 0 100 100"><circle class="trk" cx="50" cy="50" r="45"/><circle class="arc" id="code-ring" cx="50" cy="50" r="45"/></svg><span class="cring-t mono" id="code-ring-t"></span></div>
      </div>
      <div class="sec-f"><span>이 화면에는 번호를 입력하지 않습니다.</span><button type="button" class="btn" id="cancel-code">취소</button></div>
    </div>
    <div class="wz-card wz-pane" id="add-done" data-step="3" hidden>
      <div class="done-box"><svg class="done-mk" …><path …/></svg><h3>등록했습니다</h3>
        <p><span class="mono" id="add-done-email"></span> 계정이 연결되었습니다. 기능은 모두 꺼진 상태로 시작합니다.</p>
        <div class="acts"><a class="btn primary" href="#overview" id="add-go">기능 설정</a><a class="btn" href="#inbox">받은함</a><a class="btn ghost" href="#account-add" id="add-more">계정 하나 더</a></div></div>
    </div>
   </div>
   <aside class="explain" id="add-ex" aria-label="안내">
     <div data-ex="1"><h4>비밀번호</h4><p>카카오 로그인 확인에만 사용하며 저장하지 않습니다.</p></div>
     <div data-ex="2"><h4>확인 번호</h4><p>휴대폰 카카오톡에 입력란이 표시됩니다. 이 화면에는 입력하지 않습니다. 확인이 끝나면 다음 단계로 넘어갑니다.</p></div>
     <div data-ex="1"><h4>다른 기기 접속</h4><p>같은 계정이 다른 태블릿·PC에 접속되어 있으면 등록이 거부될 수 있습니다. 이 경우 다른 기기 끊기를 선택하십시오.</p></div>
     <div data-ex="3"><h4>등록 후</h4><p>발송과 기록은 K bot 서버가 수행합니다. 휴대폰을 꺼도 동작하며, 기능은 모두 꺼진 상태로 시작합니다.</p></div>
   </aside>
  </div>
 </div>
</section>
```

V4 흐름을 그대로 쓴다(`add-form` submit → `POST /panel/api/register/begin {email, password[, device_id, forced]}` → `showPass(view)` → `confirmLoop()`가 2초마다 `POST /panel/api/register/confirm {pending_id}` → `ok`/`waiting`/`expired`; `#force` → `forced: true`로 다시 begin; `#cancel-code` → `POST /panel/api/register/cancel`). 바뀌는 것:

- **단계 표시** `setStep(n)`: `#add-steps .stp`에 `done`(n보다 앞)·`cur`(n), `aria-current="step"`; `#add-ex > div[data-ex=n]`는 `.on`, 나머지 `.dim`; `.wz-pane[data-step=n]`만 보이고 전환은 5.3 가로 미끄러짐. `showPass(view)`는 `setStep(2)`, `hidePass()`는 `setStep(1)`, `state === 'ok'`는 `setStep(3)`.
- **번호** `#code`: `view.passcode`를 글자마다 `span`(`style="--i:{k}"`)으로 넣는다(길이 제한 없음, 4자리면 56×68px 칸). 번호가 없고 `view.text`가 있으면(실패) `#code-title` `카카오 응답`, `#code` 숨김, `#code-error`에 문구.
- **남은 시간 링** `#code-ring`: `remaining_seconds`부터 1초마다 줄어드는 원(둘레 `2π·45`, `stroke-dashoffset` = 둘레 × (1 − 남은/처음)). `#code-ring-t` = `4:59`. `#code-left` = `유효 시간 약 {분}분`(V4 문구). 60초 미만이면 링·글자 `--warn`. 0이 되면 `#code-wait` `시간이 지났습니다. 처음부터 다시 등록하십시오.` + `#cancel-code` 글자 `처음으로`.
- **다른 기기 끊기**: `view.can_force`면 `#force-box` 보임(V4는 `#force`만 토글 — 이제 상자째). 마법사 1단계 화면에서 begin 응답이 실패 + `can_force`이면 2단계로 넘어가지 않고 `#add-form` 안 `#wz-conflict` 자리에 같은 상자를 보여도 된다(프로토타입 `d-15d`). PANEL 판단으로 한 곳만 구현한다.
- **입력 검증**(서버 요청 전): 비어 있으면 `카카오계정이 비어 있습니다. 이메일 또는 전화번호를 입력하십시오.` / `비밀번호가 비어 있습니다. 비밀번호를 입력하십시오.`(`#email-error`·`#password-error`, 입력 `.err`).
- **재등록 모드** `startReauth(deviceId, email)`(받은함 `등록`, 계정 표 `재등록`, 개요 확인 필요 `재등록`, 배너 `재등록`): `location.hash = '#account-add'` 후 `add-form.dataset.reauth = '1'`, `regDevice = deviceId`, `#email.value = email` + `readonly`, `#add-title` `계정 재등록`, `#add-desc` `{email} 계정을 다시 등록합니다. 기존 설정과 기록은 그대로 유지됩니다.`, `#password` 포커스(≥720px). 다른 경로로 `#account-add`에 들어오면 재등록 모드를 지운다.
- **완료**: `refreshMe()` 뒤 새 계정을 현재 계정으로(`openAccount(view.device_id, 'keep')`), 3단계 표시. V4처럼 곧바로 받은함으로 보내지 않는다. `#add-go` → `#overview`.
- 8개가 차 있으면 1단계 대신 `p.empty` `계정은 8개까지 등록할 수 있습니다. 사용하지 않는 계정을 해제한 뒤 다시 시도하십시오.` + `계정` 링크.

### 4.7 매크로 `#macro`

스크린샷 `d-16-macro`, `d-16b-macro-savebar`, `m-16*`. 저장은 V4 `macro-form` submit(`{device_id, macro: {enabled, message, baseMin, randomMin, rooms, roomCooldownMin}, images | images_unchanged}`) 그대로.

```html
<section class="page" data-route="macro" id="page-macro" aria-labelledby="macro-title" hidden>
 <div class="col">
  <div class="ph"><div><h1 id="macro-title" tabindex="-1">매크로</h1><p>선택한 오픈채팅방에 메시지를 정해진 간격으로 발송합니다. 발송은 K bot 서버가 수행합니다.</p></div></div>
  <div class="banner" data-banner role="status" hidden></div>
  <form id="macro-form" class="stack" novalidate>
   <section class="sec" aria-label="매크로 발송">
    <div class="srow inline main" id="row-macro-on"><div class="srow-l"><span class="lb">매크로 발송</span><p>켜면 아래에서 선택한 방에 메시지를 보냅니다. 끄면 발송을 멈추고 설정은 그대로 둡니다.</p></div>
      <div class="srow-r"><span class="swl"><input type="checkbox" role="switch" class="swi" id="macro-on" aria-label="매크로 발송"><span class="sw" aria-hidden="true"></span></span></div></div>
    <div class="dep" data-dep="macro-on" data-open="false"><div class="dep-in">
      <div class="srow stack" id="row-macro-msg"><div class="srow-l"><label class="lb" for="macro-message">메시지</label><p>줄바꿈이 그대로 발송됩니다.</p></div>
        <div class="srow-r"><div style="width:100%"><textarea class="ta" id="macro-message" maxlength="2000" rows="4"></textarea>
          <div class="chips-meta"><span>최대 2,000자</span><span class="mono" id="macro-count">0 / 2,000</span></div></div></div></div>
      <div class="srow stack" id="row-macro-img"><div class="srow-l"><span class="lb">이미지</span><p>최대 5장. 첨부하면 매번 메시지와 함께 발송합니다.</p></div>
        <div class="srow-r"><div class="imgs" id="thumbs"></div><input type="file" id="images" accept="image/jpeg,image/png,image/webp" multiple hidden></div></div>
    </div></div>
    <div class="dep" data-dep-off="macro-on" data-open="true"><div class="dep-in"><div class="off-note"><span>매크로가 꺼져 있습니다. 켜면 메시지, 발송 간격, 보낼 방이 표시됩니다.</span><button type="button" class="btn sm" data-turn-on="macro-on">켜기</button></div></div></div>
   </section>
   <div class="dep" data-dep="macro-on" data-open="false"><div class="dep-in"><div class="stack-24">
     <div class="grp"><h2 class="grp-t">발송 간격</h2><section class="sec">
       <div class="srow" id="row-macro-base"><div class="srow-l"><span class="lb">기본 간격</span><p>방마다 발송과 발송 사이의 기본 시간입니다. 1~1,440분.</p></div>
         <div class="srow-r">[.num: 빼기 버튼 + input#base-min(inputmode=numeric, data-min=1, data-max=1440) + 더하기 버튼 + 단위 "분"]</div></div>
       <div class="srow" id="row-macro-rand">… 랜덤 간격 / 기본 간격에 0분부터 이 값까지를 무작위로 더합니다. 0~1,440분. / input#random-min(0~1440) …</div>
       <div class="srow stack" id="row-macro-viz"><div class="srow-l"><span class="lb">예상 발송</span><p>지금부터 24시간 동안의 예상입니다. 실제 시각은 서버가 정합니다.</p></div><div class="srow-r"><div class="mviz" id="macro-viz"></div></div></div>
     </section></div>
     <div class="grp"><h2 class="grp-t">보낼 방</h2><section class="sec">
       <div class="srow stack" id="row-macro-rooms"><div class="srow-l"><span class="lb">대화방과 방별 간격</span><p>이 계정이 참여 중인 오픈채팅방입니다. 간격을 비워 두면 기본 간격과 랜덤 간격을 따릅니다. 따로 정한 간격에는 랜덤 간격을 더하지 않습니다.</p></div>
         <div class="srow-r"><div style="width:100%"><div class="rlist" id="rooms-open" role="group" aria-label="보낼 방"></div>
           <div class="rooms-meta"><span data-rooms-count="macro"></span><button type="button" class="btn sm ghost" id="reload-rooms" data-load-rooms>[i-refresh]대화방 불러오기</button></div>
           <p class="errt" id="room-error" role="alert"></p></div></div></div>
     </section></div>
   </div></div></div>
   <p class="errt" id="macro-error" role="alert"></p>
  </form>
 </div>
</section>
```

- `#rooms-open`(JS): 머리 `div.rlist-h[aria-hidden]`(`대화방` · `간격`) + 방마다 `label.room.row` > `input[type=checkbox][data-key]`(V4 `roomRow` 체크 상태) + `span.ck`(체크 표시) + `span.nm` 이름 + `span.mem` `{members}명`(있을 때) + `span.coolw` > `input.cool[type=text][inputmode=numeric][data-cool="{key}"][placeholder="기본"][aria-label="{방} 간격(분)"]` + `분`. 체크하지 않은 방의 간격 칸은 흐리게(불투명도 .35) 막혀 있고, 체크를 풀면 그 방 간격 칸을 비운다. 간격 칸 값 1~1,440만 `roomCooldownMin[key]`에 넣는다(서버 규칙과 같음).
- `#macro-viz`(JS, 저장 전 미리보기): 선택한 방마다 줄 하나 — `div.mviz-sum`(방 이름 · `{lo}~{hi}분 간격`(따로 정한 방은 `{n}분 고정`) · `하루 약 {1440/hi}~{1440/lo}회`) + `div.mviz-strip`(24시간 위 예상 발송 눈금 `i`, `left = 분/1440`). 랜덤은 화면용 고정 시드(방 순서) 의사난수 — 실제 시각이 아니라는 문장이 설명에 있다. 맨 아래 축 `지금 21:16 · 03:16 · 09:16 · 15:16 · 21:16`. 방이 없으면 `보낼 방을 선택하면 방마다 예상 발송이 표시됩니다.` 값이 바뀌면 120ms 뒤 다시 그린다(눈금은 `kickIn`, 5.3).
- 이미지 `#thumbs`(JS): 장마다 `div.img-t[title=파일 이름]` > 미리보기(`img` object URL 또는 기존 이미지 표시) + `span.fn`(파일 이름, 한 줄 말줄임) + 빼기 `button[data-img-del][aria-label="{이름} 빼기"]`; 5장 미만이면 `label.img-add[for=images][aria-label="이미지 추가"]`(+). V4 이미지 검증·크기 제한·`images_unchanged` 로직 유지.
- `#macro-count` = `{n} / 2,000`(입력할 때 갱신). 서버 한도 2,000자와 같다.
- `대화방 불러오기`(`[data-load-rooms]`, 이 화면과 4.8~4.10의 같은 버튼 모두): V4 `reload-rooms` 핸들러(`POST /panel/api/rooms`) 공유. 진행 중 `.busy` + `disabled`, 성공하면 새로 생긴 방만 `.pop`(5.3), 실패 문구 `대화방 목록을 가져오지 못했습니다. 잠시 뒤 다시 눌러 주세요.`(V4 문구, panel-check 단언). 방이 0개면 목록 자리에 `불러온 대화방이 없습니다. 대화방 불러오기를 누르십시오.`(`--fg-3` 13px)

### 4.8 입장·퇴장 로그 `#visit` · 프로필 로그 `#profile`

스크린샷 `d-17-visit`, `d-17b-visit-expanded`, `d-17c-visit-fresh`, `d-18-profile`, `m-17*`, `m-18*`. 저장: `visit-form` → `{device_id, images_unchanged: true, visit: {enabled, rooms}}`, `profile-form` → `profile: {enabled, rooms}`(V4 그대로).

```html
<section class="page" data-route="visit" id="page-visit" aria-labelledby="visit-title" hidden>
 <div class="col">
  <div class="ph"><div><h1 id="visit-title" tabindex="-1">입장·퇴장 로그</h1><p>선택한 방에 누가 언제 들어오고 나갔는지 기록합니다. 켜져 있는 동안 방에 입장·퇴장 안내도 보냅니다.</p></div></div>
  <div class="banner" data-banner role="status" hidden></div>
  <form id="visit-form" class="stack" novalidate>
   <section class="sec" aria-label="입장·퇴장 기록">
    <div class="srow inline main"><div class="srow-l"><span class="lb">입장·퇴장 기록</span><p>켜면 선택한 방에서 누군가 들어오거나 나갈 때 그 사람을 멘션한 안내를 방에 보내고, 이 화면에 기록합니다.</p></div>
      <div class="srow-r">[스위치 input#visit-on aria-label="입장·퇴장 기록"]</div></div>
    <div class="dep" data-dep="visit-on" data-open="false"><div class="dep-in">
      <div class="srow stack"><div class="srow-l"><span class="lb">대화방</span><p>기록하고 안내를 보낼 오픈채팅방을 선택합니다.</p></div>
        <div class="srow-r"><div style="width:100%"><div class="rooms" id="visit-open" role="group" aria-label="대화방"></div>
          <div class="rooms-meta"><span data-rooms-count="visit"></span><button type="button" class="btn sm ghost" data-load-rooms>[i-refresh]대화방 불러오기</button></div></div></div></div>
      <div class="srow stack"><div class="srow-l"><span class="lb">방에 보내는 안내</span><p>입장 시 예시입니다. 퇴장 시에는 [퇴장안내]와 퇴장 시각을 적습니다. 이름이 바뀐 적이 있으면 이전 이름도 적습니다.</p></div>
        <div class="srow-r"><div class="preview-chat"><span class="who-l">{첫 선택 방 이름 또는 "선택한 방"} · {email} 계정이 보냄</span><div class="bub notice">[입장안내]&#10;이름 : @하늘&#10;옾링 : https://open.kakao.com/o/sH7k2Lb&#10;입장로그&#10;- 2026-10-09 21:14</div></div></div></div>
    </div></div>
    <div class="dep" data-dep-off="visit-on" data-open="true"><div class="dep-in"><div class="off-note"><span>입장·퇴장 기록이 꺼져 있습니다. 켜면 기록할 방과 방에 보내는 안내가 표시됩니다. 이미 남은 기록은 아래에 그대로 표시됩니다.</span><button type="button" class="btn sm" data-turn-on="visit-on">켜기</button></div></div></div>
    <div class="sec-f"><span>기록은 이 기능을 켠 방에서만 남습니다. K bot은 사람을 내보내지 않습니다.</span></div>
   </section>
   <p class="errt" id="visit-error" role="alert"></p>
  </form>
  <div class="grp"><h2 class="grp-t">기록<span>최근 300명 · 최근 활동순</span></h2>
   <section class="sec clip">
    <div class="toolbar">
      <input class="inp" id="visit-q" type="search" placeholder="이름 또는 링크 검색" aria-label="이름 또는 링크 검색">
      <div class="sel"><select id="visit-room" aria-label="대화방 필터"><option value="">모든 방</option></select>[i-down]</div>
      <div class="seg" id="visit-type" role="group" aria-label="기록 종류"><span class="seg-ind"></span>
        <button type="button" data-t="" aria-pressed="true">전체</button><button type="button" data-t="in" aria-pressed="false">입장</button>
        <button type="button" data-t="out" aria-pressed="false">퇴장</button><button type="button" data-t="name" aria-pressed="false">이름 변경</button></div>
      <span class="grow"></span><span class="poll" data-poll>…</span>
      <button type="button" class="btn sm" id="visit-reload">[i-refresh]새로고침</button>
    </div>
    <div class="tbl-wrap"><table class="tbl stack" id="visit-tbl"><thead><tr><th>이름 · 방</th><th>최근 입장</th><th>최근 퇴장</th><th>이름 변경</th><th>오픈프로필 링크</th><th class="chev-c"><span class="sr">펼치기</span></th></tr></thead><tbody></tbody></table></div>
    <div class="sec-f"><span id="visit-cnt"></span><span>행을 누르면 시간순 기록이 펼쳐집니다.</span></div>
    <p class="errt" id="visit-log-error" role="alert"></p>
   </section></div>
 </div>
</section>
```

**기록 표(JS)** — `GET /panel/api/logs?device_id` 응답 `visit` 행(이 문서 머리의 API 모양: `{chat_id, room, name, user_id, link, joins[], leaves[], changes[{at, name, link}]}`, 최근 활동순 ≤300, 안쪽 배열은 오래된 것부터):

- 거르기: 검색(이름·링크·이전 이름, 대소문자 무시), 방(`room` 값; 선택지는 응답 행의 `room` 중복 없이), 종류(`in`: 마지막 입장 > 마지막 퇴장, `out`: 반대, `name`: `changes.length > 0`). 검색 입력 150ms 지연.
- 행 `tr.rowx[tabindex=0][aria-expanded][data-x]`:
  - 이름 · 방 `td.c-name` > `.who-c` > `span.nm`(이름, 없으면 `이름 없음`) + `span.badges`(`span.tag.line` `들낙 {joins.length − 1}회`(입장 2회 이상) / `1분 내 퇴장`(어떤 입장 뒤 60초 안 퇴장)) + `span.rm` 방 이름(없으면 `목록에 없는 방`).
  - 최근 입장 `td.c-j[data-l="최근 입장"]` > `span.t` 시각(오늘이면 `HH:MM`, 아니면 `MM.DD HH:MM`, 모노) + 2회 이상이면 `span.more` `총 {n}회`(산세리프).
  - 최근 퇴장 `td.c-l` 같은 규칙, 없으면 `—`.
  - 이름 변경 `td.c-chain` > `.chain` > `span.old` 직전 이름 + `span.arr` → + 현재 이름, 2회 이상이면 ` 외 {n−1}회`; 없으면 `—`.
  - 링크 `td.c-link` > `span.lnk` > 링크 텍스트(`open.kakao.com/o/…` 앞 `https://` 생략, 모노, 말줄임) + 복사 `button.cpy[data-copy][aria-label="오픈프로필 링크 복사"]`(복사 → 토스트 `복사했습니다.`); `link`가 `''`면 `링크 없음`(`--fg-3`).
  - `td.chev-c` 펼침 화살표.
- 펼침 줄 `tr.detail > td[colspan=6] > .detail-in > div > .tl`: 왼쪽 `ol`(입장·퇴장·이름 변경을 합쳐 최신순, 항목 `li.ty-join|ty-leave|ty-name` > `span.mono` `MM.DD HH:MM` + `span.k` 종류 + 내용(방 이름 또는 `이전 → 이후`)), 오른쪽 `.side-i > dl`(사용자 ID(`user_id`, 없으면 `없음` — 이름만 있는 기록), 방, 오픈프로필(전체 링크 또는 `찾지 못했습니다`)). 행 클릭·Enter·Space로 토글(5.3), `aria-expanded` 갱신, 한 번에 여러 개 열림 허용.
- `#visit-cnt` = `{보이는 수}명`(+ 거른 경우 ` · 전체 {n}명`).
- 빈 표: 기록 0 → `기록이 없습니다. 위에서 기록을 켜고 방을 선택하면 이곳에 표시됩니다.` / 거른 결과 0 → `조건에 맞는 기록이 없습니다. 검색어나 필터를 바꾸십시오.`
- 폰(≤760px): 표가 카드 목록(`.tbl.stack`)이 된다 — 이름·배지·방 / 최근 입장·퇴장 / 이름 변경 / 링크(복사 버튼 포함)를 모두 유지하고 `td[data-l]::before`로 칸 이름 표시. 펼침도 그대로.

**프로필 로그** 같은 틀:

- 제목 `프로필 로그`, 설명 `선택한 방에서 닉네임이 바뀐 사람을 이전 이름과 함께 기록합니다. 켜져 있는 동안 방에 변경 안내도 보냅니다.`
- 메인 스위치 `input#profile-on`, 라벨 `프로필 변경 감지`, 설명 `켜면 선택한 방에서 닉네임을 바꾼 사람을 멘션한 안내를 방에 보내고, 이 화면에 기록합니다. 처음 본 사람은 기준만 잡고, 그 뒤 이름이 바뀔 때부터 기록합니다.` 방 목록 `#profile-open`(V4 id). 안내 미리보기 `[프로필 변경 감지]&#10;이름 : @하늘_판매&#10;이전 : 하늘&#10;변경 : 2026-10-09 21:15`, 설명 `두 번 이상 바꾼 사람은 누적 횟수도 적습니다.` 꺼짐 안내 `프로필 변경 감지가 꺼져 있습니다. 꺼져 있는 동안에는 새 기록을 남기지 않으며, 이미 남은 기록은 아래에 그대로 표시됩니다.` 바닥줄 `기록은 이 기능을 켠 방에서만 남습니다. 입장·퇴장 로그와 따로 켜고 끕니다.` 오류 `#profile-error`.
- 기록 `변경 기록` / `최근 300명 · 최근 변경순`: 도구줄 `#profile-q`(`현재 이름 또는 이전 이름 검색`) + 폴링 표시. 표 `#profile-tbl`: 현재 이름 · 방 / 최근 변경(`changes` 마지막 `at`) / 변경 이력(`이전1 → 이전2 → 현재` 체인, 마지막만 `--fg`) / 횟수(`span.cnt-pill` `{n}회`, 오른쪽 정렬) / 펼침(이름 변경 시간순 + `dl` 사용자 ID · 방 · 마지막 확인(`at`, `YYYY.MM.DD HH:MM`)). `#profile-cnt` `{n}명`. 빈 표: `감지된 변경이 없습니다. 위에서 감지를 켜고 방을 선택하면 이곳에 표시됩니다.` / `검색어와 일치하는 이름이 없습니다.`

**기록 폴링(입장·퇴장·프로필·올킥·개요 공통)** `logsSt = { deviceId, data, sig, timer, busy, seq, fails }`:

- 이 네 화면 중 하나가 보이는 동안만 10초 `setTimeout` 체인으로 `GET /panel/api/logs?device_id={현재 계정}`. 다른 화면으로 가면 멈춘다. `document.hidden`이면 건너뛴다. 3회 연속 실패면 30초.
- 늦은 응답: 요청 때의 `seq`·`deviceId`가 지금과 같을 때만 반영(계정 전환 뒤 옛 계정 기록이 그려지지 않게).
- 서명 `sig` = 응답 JSON 문자열의 길이 + 각 목록 첫 행의 최신 시각. 같으면 아무것도 다시 그리지 않는다.
- 새 행 판별: 이전 응답에 없던 키(visit `chat_id + '/' + (user_id || name)`, profile `chat_id + '/' + user_id`, guard `at`)이거나 최신 시각이 커진 행 → `.fresh`(5.4). 첫 로드와 계정 전환 직후에는 `.fresh` 없이 진입 모션만.
- 오류: 503 → 화면 위 `#runstate`(이미 UI_V4 규칙), 표 위 `#…-log-error`에 `발송 작업이 멈춰 있어 기록을 불러오지 못했습니다.`; 502 → 서버 문구 `기록을 가져오지 못했습니다.` + ` 잠시 뒤 새로고침을 눌러 주십시오.`; 401 → 로그인 화면; 404 → `없는 계정입니다.` 이전 표는 지우지 않는다.
- 폴링 표시 `span.poll[data-poll]` > 작은 원 링 + `10초마다 갱신`: 링은 요청 사이 10초 동안 채워진다(5.3). `새로고침`(`#visit-reload`) = 즉시 1회(진행 중 `.busy`).

### 4.9 올킥 방지 `#guard`

스크린샷 `d-19-guard`, `d-19b-guard-preview`, `d-25-reduced-guard`, `m-19*`. 저장: `guard-form` → `{device_id, images_unchanged: true, guard: {enabled, rooms, secs, count}}`(새 필드. 백엔드 완료).

```html
<section class="page" data-route="guard" id="page-guard" aria-labelledby="guard-title" hidden>
 <div class="col">
  <div class="ph"><div><h1 id="guard-title" tabindex="-1">올킥 방지</h1><p>짧은 시간에 강퇴가 몰리면 올킥으로 감지하여 기록합니다.</p></div></div>
  <div class="banner" data-banner role="status" hidden></div>
  <form id="guard-form" class="stack" novalidate>
   <section class="sec" aria-label="올킥 감지">
    <div class="srow inline main"><div class="srow-l"><span class="lb">올킥 감지</span><p>켜면 선택한 방에서 정해진 시간 안에 정해진 수 이상 강퇴가 일어날 때 감지 기록을 남깁니다.</p></div>
      <div class="srow-r">[스위치 input#guard-on aria-label="올킥 감지"]</div></div>
    <div class="dep" data-dep="guard-on" data-open="false"><div class="dep-in">
      <div class="srow stack" id="row-guard-rooms">… 대화방 / 감지할 오픈채팅방을 선택합니다. / div.rooms#guard-open + rooms-meta(data-rooms-count="guard") + 대화방 불러오기 …</div>
      <div class="srow" id="row-guard-secs"><div class="srow-l"><span class="lb">감지 시간</span><p>이 시간 안의 강퇴 수를 셉니다. 5~300초.</p></div>
        <div class="srow-r"><input type="range" class="range" id="guard-secs-range" min="5" max="300" step="5" aria-label="감지 시간 조절">[.num input#guard-secs min 5 max 300 step 5 단위 "초"]</div></div>
      <div class="srow" id="row-guard-count"><div class="srow-l"><span class="lb">강퇴 수</span><p>이 수 이상이면 올킥으로 감지합니다. 3~30건.</p></div>
        <div class="srow-r"><input type="range" class="range" id="guard-count-range" min="3" max="30" step="1" aria-label="강퇴 수 조절">[.num input#guard-count min 3 max 30 단위 "건"]</div></div>
      <div class="srow stack" id="row-guard-preview"><div class="srow-l"><span class="lb">미리 보기</span><p>예시 강퇴 기록에 지금 기준을 적용한 결과입니다.</p></div>
        <div class="srow-r"><div class="kt" id="guard-kt">
          <p class="sentence" id="guard-sent"></p>
          <div class="kt-strip" id="guard-strip" aria-hidden="true"><span class="kt-win" id="guard-win"></span><span class="kt-cap">예시 기록</span></div>
          <div class="kt-axis" aria-hidden="true"><span id="guard-ax0"></span><span id="guard-ax1"></span><span>지금</span></div>
          <span class="kt-res" id="guard-res" role="status"></span></div></div></div>
    </div></div>
    <div class="dep" data-dep-off="guard-on" data-open="true"><div class="dep-in"><div class="off-note"><span>올킥 감지가 꺼져 있습니다. 켜면 감지할 방과 감지 기준이 표시됩니다.</span><button type="button" class="btn sm" data-turn-on="guard-on">켜기</button></div></div></div>
    <div class="sec-f"><span>K bot은 강퇴를 막거나 강퇴된 사람을 다시 초대하지 않습니다. 감지와 기록만 합니다.</span></div>
   </section>
   <p class="errt" id="guard-error" role="alert"></p>
  </form>
  <div class="grp"><h2 class="grp-t">최근 감지<span>최근 20건 · 최신순</span></h2>
   <section class="sec clip"><ul class="alerts" id="guard-list"></ul>
    <div class="sec-f"><span class="poll" data-poll>…</span><span>감지 문구는 서버가 기록한 그대로 표시합니다.</span></div>
    <p class="errt" id="guard-log-error" role="alert"></p></section></div>
 </div>
</section>
```

- 범위 막대와 숫자 칸은 서로 묶인다(어느 쪽을 바꿔도 다른 쪽 갱신, 숫자 칸은 범위 밖 값을 `blur` 때 가장 가까운 허용값으로). 막대 채움 `--p`(0~100%).
- **미리 보기**(JS, 화면용 고정 예시 `KICKS = [-118, -96, -71, -52, -27, -22, -18, -14, -10, -6, -3]`초):
  - `#guard-sent` = `<b>{secs}초</b> 안에 <b>{count}건</b> 이상 강퇴되면 올킥으로 감지합니다.`
  - 띠 `#guard-strip`: 보이는 범위 `span = max(60, secs × 2)`초. 범위 안 강퇴마다 `i.kt-k[data-s]`(`left = 100 + k/span×100 %`), 감지 시간 안이면 `.in-win`(`--fg`), 밖이면 `--fg-4`. 오른쪽 끝에서 `secs/span` 폭의 창 `#guard-win`(`--bg-3` + 왼쪽 경계선). 축 `-{span}초`, `-{span/2}초`, `지금`.
  - `#guard-res` = 기준 이상이면 `● 구간 안의 강퇴 {n}건 · 올킥으로 감지됩니다`(점 crit, `#guard-kt.hit`로 창 경계 `--crit-line`), 아니면 `○ 구간 안의 강퇴 {n}건 · 기준 미만이라 감지하지 않습니다`.
  - 감지 시간을 바꾸면 눈금을 다시 그리고(`kickIn`), 강퇴 수만 바꾸면 결과 문장만 바꾼다.
- **최근 감지** `#guard-list`: `logs.guard`(≤20, 최신순) 행마다 `li` > `i.dot.crit`(첫 행이 24시간 안이면 `.pulse`) + `time` `YYYY.MM.DD HH:MM`(모노) + `span.tx` 서버 문구 그대로(`「방」에서 짧은 시간에 강퇴가 N건 있었습니다. …`). 없으면 `감지된 올킥이 없습니다. 감지되면 이곳과 개요에 표시됩니다.` 폴링·`.fresh`는 4.8 공통 규칙.

### 4.10 금지어 검열 `#cover`

스크린샷 `d-20-cover`, `m-20-cover`. 저장: `cover-form` → `{device_id, images_unchanged: true, cover: {enabled, rooms, words, links}}`(새 필드 `words`·`links`).

- 제목 `금지어 검열`, 설명 `선택한 방에 욕설, 금지어, 링크가 올라오면 그 글을 가립니다.`
- 메인 스위치 `input#cover-on` `금지어 검열` — 설명 `켜면 선택한 방에서 기본 욕설, 추가 금지어, 링크가 들어간 글을 가립니다. 이 계정이 그 방의 부방장 이상이어야 동작합니다.` 방 `#cover-open`(V4 id), 꺼짐 안내 `금지어 검열이 꺼져 있습니다. 켜면 검열할 방과 가릴 내용이 표시됩니다.`, 바닥줄 `글만 가리며 사람을 내보내지 않습니다.`
- 켜졌을 때만 보이는 두 번째 묶음 `가릴 내용`(`div.dep[data-dep="cover-on"]` 안 `.grp`):
  - `기본 욕설 목록` — `서버에 내장된 욕설 목록입니다. 검열이 켜져 있으면 항상 적용됩니다.` 오른쪽 `span.tag.line` `항상 적용`.
  - `추가 금지어` — `Enter 또는 쉼표로 추가합니다. 띄어쓰기, 기호, 대소문자를 바꿔 쓴 글도 가립니다.` 컨트롤 `div.chips#cover-words` > 단어 칩들 + `input#cover-word-in[maxlength=30][placeholder="단어 입력"][aria-describedby="cover-word-err cover-word-cnt"]`, 아래 `div.chips-meta` > `span.errt#cover-word-err[role=alert]` + `span.mono#cover-word-cnt`(`{n} / 200`).
  - `링크 가리기` — `오픈채팅 링크와 외부 주소가 들어간 글을 가립니다. 방장과 부방장이 올린 링크는 가리지 않습니다.` 스위치 `input#cover-links`(기본 켜짐).
  - 바닥줄 `단어당 30자 · 최대 200개 · 대소문자를 구분하지 않고 같은 단어는 한 번만 저장합니다.`
- **칩 입력**(JS, `cover.words` 초안 배열):
  - Enter·쉼표·붙여넣기(쉼표·줄바꿈으로 나눔)로 추가. IME 조합 중 Enter 무시(`e.isComposing`).
  - 빈 입력에서 Backspace → 마지막 칩 삭제.
  - 칩 `span.wchip[data-w="{소문자}"]` > `span` 단어 + `button[aria-label="{단어} 삭제"]`(×). 새 칩 `.new`(`pop`).
  - 30자 초과: 추가 안 함, `30자를 넘는 단어는 추가되지 않습니다. 단어를 줄여 다시 입력하십시오.` 중복(대소문자 무시): 추가 안 함, `이미 추가된 단어입니다.` + 기존 칩 `.dupe`(`shake`). 200개 초과: `금지어는 200개까지 등록됩니다. 사용하지 않는 단어를 삭제하십시오.`
  - 저장 본문 `words`는 배열(서버는 쉼표·줄바꿈 문자열도 받지만 화면은 배열로 보낸다).

### 4.11 갠톡 응답 `#reply`

스크린샷 `d-21-reply`, `d-21b-reply-on`, `m-21*`. 저장 V4 `reply-form` 그대로(`autoreply: {enabled, message, cooldown_hours}`).

- 제목 `갠톡 응답`, 설명 `오픈프로필 1:1 대화(갠톡)에 등록한 문구로 자동 응답합니다. 매크로의 보낼 방과는 따로 동작합니다.`
- 메인 스위치 `input#reply-on` `자동 응답` — `켜면 새 1:1 대화에 응답 메시지를 보냅니다. 받은함에서 직접 답장하는 것은 영향받지 않습니다.`
- `응답 메시지` — `아래 표시를 넣으면 보낼 때 실제 값으로 바뀝니다.` 위에 `div.tokens[role=group][aria-label="표시 넣기"]` > `button.tok[data-tok]` `{이름}` `{시간}` `{날짜}`(누르면 커서 자리에 넣고 입력창 포커스, 넣은 글자 위치 유지), 아래 `textarea#reply-message[maxlength=2000][rows=3][placeholder="예: {이름}님, 문의 감사합니다."]`.
- `쿨타임` — `같은 사람에게 다시 응답하기까지의 시간입니다. 0이면 매번 응답합니다. 0~168시간.` `.num` `input#reply-hours`(0~168, 단위 `시간`).
- `미리 보기` — `민지 님이 21:16에 메시지를 보낸 경우입니다.` `div.preview-chat` > 받은 말풍선 `안녕하세요, 거래 문의드립니다.` + 내 말풍선 `#reply-preview`(토큰을 `민지` `21:16` `10월 9일`로 바꾼 문장, 비어 있으면 `응답 메시지를 입력하십시오.`) + `span.bub-meta.me` `자동 응답 · {email @ 앞}`. 입력할 때마다 갱신.
- 꺼짐 안내 `자동 응답이 꺼져 있습니다. 켜면 응답 메시지와 쿨타임이 표시됩니다.` 오류 `#reply-error`.

### 4.12 저격 규칙 `#snipe`

스크린샷 `d-22-snipe`, `m-22-snipe`. 저장 V4 `#save-triggers` 로직을 `form#snipe-form` submit으로 옮긴다(`triggers: [{id, name, pattern, mode, reply, enabled, cooldown_sec, once, rooms, target}]`).

- 제목 `저격 규칙`, 설명 `지정한 말이 올라오면 정해진 답장을 보냅니다. 매크로, 갠톡 응답과 따로 동작합니다.` 오른쪽 `button.btn.primary#add-trigger` `[+]규칙 추가`(30개면 `disabled`).
- `form#snipe-form` > `section.sec[aria-label="규칙"]` > `div#triggers` + `.sec-f` > `span#snipe-count`(`규칙 {n} / 30`) + `새 규칙의 찾는 방식은 포함과 같음 중에서 고릅니다.` + `p.errt#snipe-error`.
- 규칙(JS `renderTriggers()`): `div.rule(.off)(.open)[data-ri]` >
  - 머리 `div.rule-h[role=button][tabindex=0][aria-expanded]` > `.t` > `b` 이름(없으면 `이름 없는 규칙`) + `.meta`(`code` 감지할 말 · 찾는 방식 · `{n}개 방`/`모든 방` · `쿨타임 {n}초` · `{방}에 답장`(대상 방이 있을 때) · `방마다 1회`(once)) + 사용 스위치(`aria-label="{이름} 사용"`) + `span.chev`.
  - 본문 `div.rule-b > div > .rule-form`(2열 격자, 폰 1열): `이름`(`input` maxlength 40) / `찾는 방식`(`select`: `포함` `같음`; 기존 규칙이 `starts`·`regex`이면 그 값도 선택지에 남김: `앞글자` `정규식(고급)` + 정규식이면 힌트 `정규식(고급)은 잘 모르면 「포함」을 선택하십시오.`) / `감지할 말`(maxlength 200) / `다시 반응하기까지`(`.num` 0~86,400 `초`) / `답장`(전체 폭 `textarea` maxlength 500) / `감지할 방`(전체 폭 방 칩, 아래 `선택하지 않으면 저장 시점의 모든 오픈채팅방`) / `답할 방`(`select`: `감지된 그 방` + 오픈채팅방들) / 바닥 `.foot`: `방마다 한 번만 답장` 스위치 + 삭제.
  - 삭제: `button.btn.sm.ghost.danger` `[휴지통]삭제` → 같은 자리에서 `삭제할까요?` 대신 TONE 문구 `이 규칙을 삭제합니다.` + `취소` + `button.btn.sm.danger.solid` `삭제`(인라인 확인, `confirm()` 금지). 삭제는 초안에서만 빠지고 저장해야 반영(저장 바 카운트 증가).
- `규칙 추가` → 맨 위에 빈 규칙(`mode: 'contains'`, `cooldown_sec: 60`, `enabled: true`) 추가·펼침(`.new` `rowIn`) + 이름 칸 포커스. 머리 클릭·Enter·Space → 펼침 토글(5.3).
- 규칙이 없으면 `p.empty` `등록된 규칙이 없습니다. 규칙 추가를 눌러 첫 규칙을 만드십시오.`

### 4.13 프로토타입 → 실제 id·클래스 대응표 (콘솔)

| 프로토타입 | 실제 | 비고 |
|---|---|---|
| `#loginScr` / `#lkey` | `#login` / `#key` | V4 id |
| `PAGES[x].render()` 문자열 | `section.page[data-route=x]` 정적 마크업 | 4.1 |
| `.page.leave` 복제 후 id 제거 | 같은 `section`을 `inert` + `aria-hidden` 후 `hidden` | 5.1 |
| `input[data-sw="enabled"]` | `#macro-on` `#visit-on` `#profile-on` `#guard-on` `#cover-on` `#reply-on` | |
| `data-dep="enabled"` / `data-dep-off="enabled"` | `data-dep="{스위치 id}"` / `data-dep-off="{스위치 id}"` | |
| `data-turn-on="enabled"` | `data-turn-on="{스위치 id}"` | |
| `data-room-path`, `data-bind`, `S.draft` | V4 `checkedRooms()`·폼 값 + `formState()`(4.14) | |
| `#mMsg` `#mCnt` `#mImgs` `#mBase` `#mRand` `#mViz` | `#macro-message` `#macro-count` `#thumbs` `#base-min` `#random-min` `#macro-viz` | |
| 매크로 `#rooms-open` | `#rooms-open` | 같음 |
| 입장·퇴장 방 칩 / `#vQ` `#vRoom` `#vSeg` `#vReload` `#vTbl` `#vCnt` | `#visit-open` / `#visit-q` `#visit-room` `#visit-type` `#visit-reload` `#visit-tbl` `#visit-cnt` | |
| 프로필 방 칩 / `#pQ` `#pTbl` `#pCnt` | `#profile-open` / `#profile-q` `#profile-tbl` `#profile-cnt` | |
| 올킥 방 칩 / `#gSecs` `#gCount` / `#gKt` `#gSent` `#gStrip` `#gWin` `#gAx0` `#gAx1` `#gRes` `#gList` | `#guard-open` / `#guard-secs` `#guard-count` / `#guard-kt` `#guard-sent` `#guard-strip` `#guard-win` `#guard-ax0` `#guard-ax1` `#guard-res` `#guard-list` | |
| 금지어 방 칩 / `#wChips` `#wIn` `#wErr` `#wCnt` | `#cover-open` / `#cover-words` `#cover-word-in` `#cover-word-err` `#cover-word-cnt` | |
| `#rMsg` `#rCool` `#rPrev` | `#reply-message` `#reply-hours` `#reply-preview` | |
| `#tAdd` `#tList` `#tCnt` | `#add-trigger` `#triggers` `#snipe-count` | |
| `.ib#ib`, `.ib.is-room` | `#inbox .ib`, `#inbox[data-view="room"] .ib` | CSS 선택자 바꿈 |
| `#ibFilter` / `.fchip[data-f]` | `#rail` / `#rail-all`, `.fchip.rail-acct[data-device]` | `.n` → `.n.rail-badge`, `.rd` → `.rd.rail-dot` |
| `#ibQ` `#ibUnread` `#ibNotice` `#ibRows` `#ibCount` `#ibReload` | `#chat-search` `#chat-unread` `#chat-notice` `#chat-rooms` `#chat-total` `#chat-reload` | |
| `.ib-notice .t` / `.r` | `.kkt-notice-title` / `.kkt-notice-row` > `.kkt-notice-text` | |
| `.cv` / `.cv .badge-n` / `.cv .chip-acct` | `.kkt-row` / `.kkt-badge.badge-n` / `.kkt-acc.chip-acct` | CSS의 `.cv` → `.kkt-row` |
| `#ibTh` `.th-h` `#ibBack` | `.ib-th.kkt-room` `.th-h.kkt-head` `#chat-back` | |
| `.th-log#thLog` / `.msg(.me)` / `.bub` / `.msg time` / `.th-day` / `.msg.in` | `#chat-log` / `.kkt-line(.me)` / `.kkt-bubble` / `.kkt-at` / `.kkt-day` / `.kkt-line.enter` | CSS 이름 바꿈 |
| `#ibText` `#ibSend` `#ibCnt` `#ibNote` `.hint-k` | `#chat-text` `#chat-send` `#chat-count` `#chat-note` `#compose-hint` | |
| `#wzForm` `#wzEmail` `#wzPw` `#wzEmailErr` `#wzPwErr` `#wzNext` | `#add-form` `#email` `#password` `#email-error` `#password-error` `#add-next` | |
| `#wzSteps` `#wzEx` `#wzStage` `#wzCap` | `#add-steps` `#add-ex` `#add-stage` `#add-cap` | |
| `#wzConflict` + `#wzForce` | `#force-box` + `#force` | |
| `#wzRing` `#wzLeft` | `#code-ring` `#code-ring-t` (+ V4 `#code-left`) | |
| `#wzSim` `예시: 확인 완료` | 없음 | 프로토타입 전용 |
| `.demo-tag.top` `예시 데이터` | 없음 | 프로토타입 전용 |
| 토스트 `toast(title, sub, opt)` | 같은 모양의 `notify(title, sub, opt)` | V4 `say()` 유지 |

### 4.14 저장·변경 추적·떠나기

- **기준값**: `fillDetail()`(V4)이 계정 값을 폼에 채운 직후, 화면마다 `baseline[route] = JSON.stringify(formState(route))`. `formState(route)`는 그 폼의 `submit` 핸들러가 보낼 기능 객체(이미지는 파일 이름·크기 목록)를 돌려준다. 저격 규칙은 규칙 배열 전체.
- **변경 수**: `input`·`change`마다 현재 `formState`와 기준값을 잎 단위로 비교한 다른 칸 수(배열은 원소 단위, 방 목록은 추가·삭제된 방마다 1). 0이면 저장 바 내림, 1 이상이면 `#save.show` + `#saveTxt` 갱신 + `#saveBtn.form = '{route}-form'` + 사이드바 `.is-dirty`.
- **되돌리기** `#saveRevert`: 그 화면만 `fillDetail` 값으로 다시 채우고(접힘·펼침도 원래대로), 저장 바 내림, 토스트 `변경을 되돌렸습니다.`
- **저장 성공**: `account = res.account` → `fillDetail()` → 기준값 갱신 → 저장 바 내림 → 사이드바 `.fs`·개요 표 갱신 → 토스트. 저장 중 다른 입력은 막지 않는다(응답 뒤 다시 비교).
- **떠나기**: 변경이 남은 채 다른 화면(해시 변경, 사이드바, 팔레트, G 단축키), 계정 전환, `나가기`를 하려 하면:
  1. 해시 변경이면 `history.replaceState(null, '', '#' + 현재 route)`로 되돌린다.
  2. `#save.leave` + `shake`. `#leaveStay` 포커스.
  3. `머무르기` → 원래 편집 모드. `버리기` → 되돌리기 후 원래 하려던 이동 실행. `저장` → 저장 성공 뒤 이동(실패하면 머무름).
  - 창 닫기·새로고침: 변경이 있으면 `beforeunload`에서 `e.preventDefault(); e.returnValue = ''`(브라우저 기본 확인. 문구 지정 불가).
- **즉시 저장(개요 스위치)**: 개요 스위치는 저장 바를 쓰지 않는다(4.4). 그 기능 화면에 저장 안 한 변경이 있으면 개요 스위치는 `disabled` + `title="저장하지 않은 변경이 있습니다"`.

### 4.15 공통 컴포넌트

- **스위치**: `span.swl > input.swi[type=checkbox][role=switch](#id)(aria-label) + span.sw[aria-hidden]`. 진짜 체크박스가 트랙 위에 투명하게 겹쳐 있어 Playwright `.check()`·키보드·폼 값이 그대로 동작한다. 켜짐: 트랙 `--inv`, 손잡이 `--inv-fg`가 14px 이동(`--d2`). 포커스: 트랙에 `--ring` + 2px 외곽선.
- **방 칩**(입장·퇴장, 프로필, 올킥, 금지어, 저격): `div.rooms[role=group]` > `label.room > input[type=checkbox][data-key] + span.ck + span.nm + span.mem`. 선택 `label.room:has(> input:checked)` → 글자 `--fg`, 테두리 `--fg-3`, 바탕 `--bg-3`, 체크 표시. 아래 `div.rooms-meta` > `span[data-rooms-count]`(`{n}개 방 선택` / `선택한 방 없음` / 저격은 `선택하지 않으면 저장 시점의 모든 오픈채팅방`). 폰은 칩이 한 줄씩 44px 목록이 된다. V4 `fillChecks()`·`checkedRooms()`는 `#…-open input[type=checkbox]`만 보면 되므로 그대로 쓴다.
- **숫자 칸** `.num`: `button[aria-label="{이름} 줄이기"]` − / `input[type=text][inputmode=numeric]` / `button[aria-label="{이름} 늘리기"]` + / `span` 단위. 버튼은 `step`만큼, 범위 밖은 `blur` 때 고정. 길게 누르기 반복 없음.
- **세그먼트** `.seg`: `span.seg-ind`(선택 표시)가 `aria-pressed="true"` 버튼 위치로 미끄러진다(5.3).
- **점 상태** `.dot`: 6px 원. `.live` `--live`, `.warn` `--warn`, `.crit` `--crit`, 기본 `--fg-4`.
- **스파크** `svg.spark[width=72][height=26]`(지표): 지금부터 거꾸로 1시간씩 24칸 막대(`rect` 폭 2, x = 칸 × 3, 높이 = `max(3, round(개수 / 최대 × 26))`, 0이면 높이 1 `.z`), 마지막(지금) 막대 `.now` `--fg`, 나머지 `--fg-3`, `.z` `--line-3`.
- **폴링 링** `span.poll[data-poll]` > `svg.ring[viewBox="0 0 14 14"]`(`circle.bg` + `circle.fg`, r=5, `stroke-dasharray: 31.4`) + `span` 글자(`9초마다 갱신`/`10초마다 갱신`). 요청을 보낼 때마다 `runRing(ms)`: `.fg`의 `stroke-dashoffset`을 31.4로 되돌린 뒤 `ms` 동안 linear로 0까지(다음 요청까지 채워짐). 동작 줄이기에서는 링을 움직이지 않는다.
- **빈 상태** `p.empty`: 가운데 정렬, 여백 `40px 20px`, `--fg-3` 13px, 다음 할 일을 한 문장으로.
- **배너** `.banner`: `--crit-bg` 바탕, `--crit-line` 테두리, 경고 아이콘, 오른쪽 버튼.
