# /panel 통합 채팅 콘솔 — 설계·구현 명세 (UI v4)

> 저장 위치 `docs/UI_V4.md`. 기준 파일(전부 다시 읽음): `public/panel.html`, `public/panel.css`, `public/panel.js`, `routes/panel.js`, `lib/panel-check.js`, `lib/panel-ids.js`, `lib/sender-child.js`, `sender/src/index.mjs`, `sender/src/runner.mjs`(status/inbox/requireLive), `docs/TONE.md`, `docs/BRAND.md`, `docs/UI_V3.md`, `scratchpad/behavior.mjs`, `scratchpad/profile.mjs`.
> 출발점은 심사 1위 **제안 B(Discord IA)**. 여기에 심사위원이 가져오라고 한 것들을 접목했다 — C의 폰 가로 레일·`.kkt-*` 선택자 유지·`#thread-settings`·`#chat-notice`·safe-area·"필터를 바꿔도 열린 대화 유지"·`.bump`·5분 뒤 `refreshMe`, A의 "문제 없으면 띠 숨김"·sender 중지 시 마지막 목록 유지·`새 메시지` 알림·글자 수 표시·`@supports(100dvh)`·같은 행 포커스 복원·`안 읽음` 필터. 지적된 약점은 전부 고쳤다 — `--ink-2` 대비(4.25→5.0), 폰 검색창 44px, `대화를 고르세요`·`접속 중(연결 대기)`·`발송 프로세스` 문구, sender 변경 없음, 1:1 로그의 중복 아바타 제거, `#rail-all` 비활성 제거, 격자 배치를 명시, `#compose-error` 신설 대신 기존 `#chat-note` 유지(문구가 세 곳에 흩어지지 않게).
> 화면 문구는 전부 TONE.md(합니다체·명사형, 버튼 2~5자, 오류 = 현상+조치, 반말·이모지 없음, `~주세요`를 `~하십시오`로 올리지 않음). 코드 식별자는 영문.

---

## 1. 제품 개념 + IA

**제품 개념.** 한 라이선스 키에 묶인 카카오 계정(최대 8개)의 오픈프로필 1:1 채팅(갠톡)을 **하나의 받은함**에 모은다. 왼쪽 어두운 **계정 레일**에서 `전체` 또는 계정 하나를 고르고, 가운데 **대화 열**에서 손님을 고르고, 오른쪽 **대화 창**에서 읽고 답한다. 답장은 **그 대화를 받은 계정**이 보낸다(전송 본문의 `device_id`는 행의 `data-device`에서만 온다). 판매자는 "어느 계정으로 왔는지"를 고르지 않는다 — 대화 창 머리에 `{email} 계정으로 답장`과 접속 상태 칩이 항상 보일 뿐이다. 계정별 설정(매크로·들낙 방지·욕설 가리기·프로필 감지·자동응답·저격·계정)은 레일의 톱니로 여는 **설정 모드**에 기존 카드 그대로 남는다.

**모드·뷰·필터**

| 상태 | 위치·값 | 설명 |
|---|---|---|
| 모드 | `#console[data-mode="inbox"]` | 레일 + 대화 열 + 대화 창. `showTab('chat')`과 동치 |
| 모드 | `#console[data-mode="settings"]` | 레일 + 설정 메뉴(`#settings-acct` + `#tabs`) + 설정 카드(`.panes`). `showTab('macro'…'account')`와 동치 |
| 뷰(폰) | `#console[data-view="list"\|"room"]` | <720px에서 대화 열과 대화 창을 번갈아 보임. ≥720px에서는 CSS가 무시 |
| 필터 | `ui.filter` (`''` = 전체, 또는 `device_id`) | 레일 선택. 대화 열 제목·계정 칩·`#chat-notice`를 결정 |
| 보기 | `ui.unreadOnly`, `ui.query` | `안 읽음` 토글과 검색. 서명(5.4)에 포함 |

**내비게이션**

- 레일: `전체` → 계정 N개(`created_at` 순) → `계정 추가(+)` → (아래 고정) `설정(톱니)`.
- 계정 아바타 클릭: inbox 모드면 `selectRail(device)`(필터 변경), settings 모드면 그 계정의 설정으로 전환(현재 탭 유지).
- `전체` 클릭: `selectRail('')` + inbox 모드.
- 톱니(`#rail-settings`): settings 모드. 대상 계정 = `ui.filter` → 없으면 `account.device_id` → 없으면 첫 계정. 계정이 0개면 `showTab('account')`. 탭은 `macro`.
- `+`(`#rail-add`): `showTab('account')` 후 `#email`에 포커스(≥720px만).
- 대화 창 머리의 `설정`(`#thread-settings`): 열린 대화를 받은 계정의 설정(`macro` 탭).
- settings 모드 `#tabs`의 첫 항목 `채팅`(`data-tab="chat"`)이 inbox 모드로 돌아가는 길 — 폰에서 레일이 숨겨질 때의 유일한 복귀 경로.
- 계정 등록은 settings 모드의 `account` 탭(`#account-block`) 한 곳. 레일 `+`, 빈 상태의 `계정 등록`, `#chat-notice`의 `등록`이 모두 그리로 보낸다.

**첫 진입 (`GET /panel/api/me` 성공 후)**

| 계정 수 | 동작 |
|---|---|
| 0 | `showTab('account')` → settings 모드, 계정 탭, 등록 폼. 레일은 `전체`(활성, 누르면 받은함 빈 상태 + `계정 등록` 버튼) + `+` + 톱니. `#runstate` 숨김 |
| 1 | `showTab('chat')`, 필터 전체. 행에 계정 칩 없음(계정이 하나). 레일 아바타 1개 |
| N | `showTab('chat')`, 필터 전체. 행마다 계정 칩, 레일 배지에 계정별 안 읽음 |

순서: `me` → `showApp()` → `renderAccounts()`(레일을 `me` 상태로 먼저 그림) → `bootConsole()`(위 표) → `loadInbox(true)` → 9초 주기. **대화는 자동으로 열지 않는다**(열면 서버가 그 방의 안 읽음을 0으로 돌리므로, 부팅·필터 변경·갱신 어디서도 `openConversation`을 자동 호출하지 않는다).

---

## 2. 레이아웃

**머리글.** `.bar`(브랜드 `K bot` + `구매 / 내 키 / 관리` + 오른쪽 `#who` + `#logout`)만 남긴다. `.pagehead`(h1 `매크로 관리`)는 제거하고 `<h1 class="sr-only">K bot 콘솔</h1>`로 바꾼다(BRAND.md: 콘솔 이름 `K bot 콘솔`, `<title>`은 `관리 · K bot`). 머리글은 고정하지 않는다(기존 주석의 이유 유지). 대신 `#app`이 머리글 아래 viewport를 꽉 채운다. `.bar { min-height: 56px; padding: 0 }`, 아래 1px 선 → `--top-h: 57px`(폰 `--top-h: 53px`, `.bar` 52px).

**본문 폭.** `showApp()`이 `document.body.dataset.screen = 'app'`, `showLogin()`이 `'login'`을 쓴다. `body[data-screen="app"] main { width: 100%; max-width: none; padding: 0; }`. 로그인 카드는 기존 `main` 폭 규칙 그대로에 `#login { max-width: 560px; margin: 24px auto }`.

**높이 공식 (모든 폭 공통)**

```css
#app { display: flex; flex-direction: column; gap: 10px;
       height: calc(100vh - var(--top-h)); padding: 12px 12px 16px;
       width: min(1480px, 100%); margin: 0 auto; }
@supports (height: 100dvh) { #app { height: calc(100dvh - var(--top-h)); } }
#runstate { flex: 0 0 auto; }
#console  { flex: 1 1 auto; min-height: 0; }
```

### 2.1 데스크톱 ≥1024px

```
┌──────────────────────────────────────────────────────────────────────────┐
│ K bot          구매  내 키  [관리]                      KAKA-····  [나가기] │ 56 .bar
├──────────────────────────────────────────────────────────────────────────┤ 12px 여백
│ ▒전체▒ │ 전체 대화         [안 읽음 3] ⟳ │ ← 김민수            [접속 중] 설정 │ 56
│ ▒ 3  ▒ │ [🔍 이름·내용 검색            ] │   a@kakao.com 계정으로 답장         │
│ ────── │ ┌(김) 김민수            오후 3:12│─────────────────────────────────│
│ ▒(A)●2▒│ │ 입금했어요                 (2)│         ── 2026년 10월 8일 ──    │
│ ▒(B)● ▒│ │ ◦ a@kakao.com                │ ┌─────────────┐ 오후 3:10          │
│ ▒(C)● ▒│ ├(이) 이영희            오후 2:40│ │ 안녕하세요    │                   │
│ ▒ +  ▒ │ │ 거래 되나요?                  │ └─────────────┘                   │
│        │ │ ◦ b@kakao.com                │               ┌───────────────┐   │
│        │ └…                             │     오후 3:12 │ 네, 가능합니다  │   │
│        │                                │               └───────────────┘   │
│        │                                │─────────────────────────────────│
│ ▒ ⚙  ▒ │                                │ [ 메시지 입력               ] (➤) │ ≥64
│        │                                │ Enter 전송 · Shift+Enter 줄바꿈     │
└──────────────────────────────────────────────────────────────────────────┘
   72px            320px                        minmax(0,1fr)
```

```css
#console { display: grid; grid-template-columns: var(--rail-w) minmax(0, 1fr);
           grid-template-rows: minmax(0, 1fr); border-radius: 16px; overflow: hidden;
           background: var(--paper); border: 1px solid var(--line); box-shadow: var(--sh-console); }
#rail     { grid-column: 1; grid-row: 1; }
#inbox, #settings { grid-column: 2; grid-row: 1; min-width: 0; min-height: 0; }
#kkt      { height: 100%; display: grid; grid-template-columns: var(--list-w) minmax(0, 1fr);
            grid-template-rows: minmax(0, 1fr); }
.kkt-list, .kkt-room { display: flex; flex-direction: column; min-width: 0; min-height: 0; }
.kkt-list { border-right: 1px solid var(--line); }
#chat-rooms, #chat-log, .panes, .settings-side { overflow-y: auto; min-height: 0; }
#settings { display: grid; grid-template-columns: 260px minmax(0, 1fr); grid-template-rows: minmax(0, 1fr); }
.settings-side { border-right: 1px solid var(--line); padding: 12px; background: var(--paper-2); }
.panes { padding: 20px 24px 28px; }
.panes > .card, .panes > #detail { max-width: 760px; }
```

- `--rail-w: 72px`, `--list-w: 320px`(≥1280px `352px`). 설정 모드: `.settings-side` = `#settings-acct` 셀렉트 + **세로** `#tabs`(기존 ≥900px 규칙을 ≥1024px로 옮김), `.panes` 자체 스크롤. `footer.limit`은 `.panes` 맨 아래.
- `#compose-hint`는 ≥720px에서만 보인다. `#chat-back`은 ≥720px에서 `display: none`.

### 2.2 태블릿 720–1023px (Playwright 뷰포트 940px가 이 구간)

```
┌──────────────────────────────────────────────────┐
│ K bot        구매 내 키 [관리]      KAKA-·· [나가기] │
├──────────────────────────────────────────────────┤
│▒전체▒│ 전체 대화    [안 읽음 3] ⟳ │ ← 김민수  [접속 중] 설정│
│▒(A)2▒│ [검색                   ] │   a@kakao.com 계정으로 답장│
│▒(B) ▒│ (김) 김민수          3:12 │   말풍선…                │
│▒ +  ▒│ 입금했어요            (2) │                          │
│      │ (이) 이영희          2:40 │──────────────────────────│
│▒ ⚙  ▒│                           │ [메시지 입력        ] (➤)│
└──────────────────────────────────────────────────┘
  64px          272px                minmax(0,1fr)
```

- `--rail-w: 64px`, `--list-w: 272px`. `#app` 폭 `100%`, 패딩 `10px`.
- 설정 모드: `#settings { grid-template-columns: minmax(0,1fr); grid-template-rows: auto minmax(0,1fr); }` — `.settings-side`가 **위**(셀렉트 왼쪽 + 가로 스크롤 `#tabs` pill 띠, 기존 <900px 스타일), `.panes`가 아래. 940px에서 `.tab[data-tab="macro"]`·`#rail-settings`가 모두 보인다.

### 2.3 폰 <720px (≥360px)

```
data-view="list"                         data-view="room"
┌──────────────────────────┐ 360         ┌──────────────────────────┐
│ K bot     구매 내키 관리 ·│ 52 .bar     │ K bot     구매 내키 관리 ·│
├──────────────────────────┤             ├──────────────────────────┤
│ (전체3)(A2)(B )(C●)(+)(⚙)│ 64 #rail 가로│ ← (김) 김민수   [접속 중] 설정│ 56
│──────────────────────────│             │   a@kakao.com 계정으로 답장│
│ 전체 대화   [안 읽음 3] ⟳ │ 48 .kkt-tools│──────────────────────────│
│ [🔍 이름·내용 검색      ] │ 52          │   ── 2026년 10월 8일 ──   │
│──────────────────────────│             │ ┌──────────┐              │
│ (김) 김민수        3:12  │ 64~72       │ │ 안녕하세요 │              │
│  입금했어요          (2) │             │ └──────────┘              │
│  ◦ a@kakao.com           │             │        ┌──────────────┐   │
│ (이) 이영희        2:40  │             │        │ 네, 가능합니다 │   │
│  거래 되나요?            │             │        └──────────────┘   │
│  ◦ b@kakao.com           │             │──────────────────────────│
│ …                        │ flex 1      │ [메시지 입력        ] (➤) │ ≥64 + safe-area
└──────────────────────────┘             └──────────────────────────┘
```

```css
@media (max-width: 719px) {
  :root { --top-h: 53px; --rail-h: 64px; }
  #app { padding: 0; gap: 0; width: 100%; }
  #console { display: flex; flex-direction: column; border-radius: 0; border: 0; box-shadow: none; }
  #rail { flex: 0 0 var(--rail-h); flex-direction: row; align-items: center; padding: 0 8px; gap: 6px; overflow-x: auto; }
  #rail-accounts { display: flex; flex-direction: row; gap: 6px; overflow: visible; }
  .rail-tip, .rail-sep { display: none; }
  #inbox, #settings { flex: 1 1 auto; min-height: 0; }
  #kkt { display: flex; flex-direction: column; }
  #console[data-view="list"] .kkt-room { display: none; }
  #console[data-view="room"] .kkt-list, #console[data-view="room"] #rail { display: none; }
  #console[data-mode="settings"] #rail { display: none; }
  #settings { display: flex; flex-direction: column; }
  .settings-side { border-right: 0; border-bottom: 1px solid var(--line); padding: 8px 12px; }
  .panes { padding: 14px 12px 28px; }
  .kkt-compose { padding-bottom: calc(10px + env(safe-area-inset-bottom)); }
  #compose-hint { display: none; }
}
```

- 콘솔 full-bleed, 머리글 아래 viewport 전부. 레일은 목록 위의 **가로 줄**(아바타 40px, 버튼 48×48 → 터치 44px 충족), 툴팁 없음(식별은 행의 계정 칩과 머리의 `~ 계정으로 답장`으로).
- `data-view="room"`에서 레일·대화 열을 `display:none`으로 빼고 `#chat-back` 표시. 설정 모드에서는 레일 숨김, 복귀는 `#tabs`의 `채팅`.
- 가로 스크롤 금지: `#console { overflow: hidden }`, 모든 열 `min-width: 0`, 말풍선 `max-width: 86%`, 긴 글 `overflow-wrap: anywhere`, 이메일 칩 `text-overflow: ellipsis`.
- `<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover, interactive-widget=resizes-content">` (`interactive-widget`은 Chrome Android에서만 동작하며 다른 브라우저는 무시한다). `#chat-text` focus 시 `chatLog.scrollTop = chatLog.scrollHeight`.
- 머리글 위 chrome 합계: 53 + 64 + 48 + 52 = 217px → 740px 폰에서 행 8개가 보인다.

---

## 3. 디자인 토큰 (`public/panel.css :root`)

기존 토큰은 **모두 유지**한다(설정 카드가 쓴다). 단 `--faint`는 `#8a96a6`(3.0:1)에서 `#66748a`(흰 바탕 4.74:1)로 올린다(`.hint`·`.limit`·`legend`의 대비 개선, 레이아웃 영향 없음). 아래를 **추가**한다. 색은 전부 hex.

```css
:root {
  /* 치수 */
  --top-h: 57px;  --rail-w: 72px;  --rail-h: 64px;  --list-w: 320px;  --tap: 44px;

  /* 레일(어두운 면) — 사이트 accent 와 같은 녹색 계열 */
  --rail-bg: #0f1f19;  --rail-bg-2: #163028;  --rail-hover: #1b3a2f;  --rail-active: #1f4b3a;
  --rail-ink: #e6efe9;  --rail-muted: #8fa89a;  --rail-pill: #ffffff;  --rail-line: #22362e;  --rail-tip-bg: #0b1511;

  /* 상태 점·칩 */
  --st-live: #2f9e6b;  --st-wait: #cf8a28;  --st-off: #8a96a6;  --st-bad: #d0303a;
  --badge: #d0303a;  --badge-ink: #ffffff;
  --bad-bg: #fbe9ea;  --bad-ink: #8c2f2f;  --bad-line: #ecc5c5;
  --bump: #fff8c4;

  /* 본문(밝은 면) */
  --ink-2: #5f6b79;          /* 시각·보조 글자. 흰 5.43:1, --log-bg 5.0:1 (B 의 #6b7684 는 4.25:1 로 탈락) */
  --paper-2: #f7f9fb;        /* 대화 열 머리·설정 메뉴 바탕 */
  --log-bg: #f3f6f8;         /* 대화 창 바탕 */
  --bubble-them: #ffffff;  --bubble-them-line: #e3e8ee;
  --bubble-me: #dcefe4;  --bubble-me-ink: #0f1720;
  --media-bg: #eef1f4;  --media-ink: #4f5b68;
  --chip-bg: #eef1f4;  --chip-ink: #3e4a57;
  --search-bg: #eef1f4;  --row-hover: #f3f6f4;  --row-current: #e8f2ec;  --row-current-bar: #1f4b3a;
  --divider: #e6ebf0;  --send-off: #c3ccd4;

  /* 계정 색 (레일 아바타·행 칩 점·설정 셀렉트 점). 순번 = me.accounts 순서 % 8. 흰 글자 ≥6.3:1 */
  --acc-0: #2a6b52; --acc-1: #2c4a6e; --acc-2: #6e542c; --acc-3: #5a3d45;
  --acc-4: #3e4d57; --acc-5: #4a4450; --acc-6: #1d4e89; --acc-7: #7a4b2a;

  /* 글자 크기 / 줄 높이 */
  --fs-11: 11px; --lh-11: 14px;   /* 레일 배지, 날짜 칩, 시각 */
  --fs-12: 12px; --lh-12: 16px;   /* 계정 칩, 머리 부제, 탭 요약, 힌트 */
  --fs-13: 13px; --lh-13: 18px;   /* 미리보기, 상태 칩, 알림 */
  --fs-14: 14px; --lh-14: 20px;   /* 말풍선, 행 이름 */
  --fs-15: 15px; --lh-15: 22px;   /* 본문, 입력창 */
  --fs-16: 16px; --lh-16: 22px;   /* 대화 상대 이름 */
  --fs-17: 17px; --lh-17: 24px;   /* 카드 h2 (기존) */
  --fs-20: 20px; --lh-20: 26px;   /* 빈 상태 제목 */

  /* 간격 · 반경 */
  --sp-1: 4px; --sp-2: 8px; --sp-3: 12px; --sp-4: 16px; --sp-5: 20px; --sp-6: 24px; --sp-8: 32px;
  --r-xs: 6px; --r-md: 14px; --r-pill: 999px;          /* --r-sm 10px, --r 16px 는 기존 */
  --r-ava-rail: 50%;  --r-ava-rail-on: 14px;            /* hover/current 에서 둥근 네모 */

  /* 그림자 · 층 · 움직임 */
  --sh-console: 0 18px 40px -28px rgba(15,23,32,.45), 0 1px 2px rgba(15,23,32,.06);
  --sh-bubble: 0 1px 1.5px rgba(15,23,32,.08);
  --sh-tip: 0 6px 18px -8px rgba(0,0,0,.5);
  --z-head: 2; --z-rail: 3; --z-strip: 4; --z-tip: 20; --z-skip: 30;
  --t-fast: 120ms; --t-base: 160ms; --t-enter: 220ms; --ease: cubic-bezier(.2,.7,.2,1);
}
@media (prefers-reduced-motion: reduce) { :root { --t-fast: 0ms; --t-base: 0ms; --t-enter: 0ms; } }
.sr-only { position: absolute; width: 1px; height: 1px; margin: -1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0; }
.trigger .hint { color: var(--muted); }   /* --faint 는 --sunken 위(4.42:1)에 글자로 쓰지 않는다 */
```

글꼴은 기존 시스템 스택 그대로, `body` 15px/1.6, 숫자(시각·배지·요약)는 `font-variant-numeric: tabular-nums`.

---

## 4. 컴포넌트 명세 (DOM 계약)

아래 id·class는 고정이다. 기존 설정 폼의 id·문구는 하나도 바꾸지 않는다(잘라 붙이기만).

### 4.0 전체 골격 (`public/panel.html`)

```html
<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover, interactive-widget=resizes-content">
<title>관리 · K bot</title>
<meta name="robots" content="noindex">
<meta name="theme-color" content="#eef1f4">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="stylesheet" href="/panel.css?v=12">
</head>
<body>
<a class="skip" href="#main">본문으로 건너뛰기</a>
<header class="top">
  <div class="bar">
    <a class="brand" href="/"><img src="/favicon.svg" alt="" width="26" height="26">K bot</a>
    <nav class="top-nav" aria-label="주요 메뉴">
      <a href="/buy">구매</a>
      <a href="/my">내 키</a>
      <a href="/panel" aria-current="page">관리</a>
    </nav>
    <div class="top-side">
      <p id="who" class="who"></p>
      <button type="button" id="logout" class="btn ghost" hidden>나가기</button>
    </div>
  </div>
</header>
<main id="main">
  <h1 class="sr-only">K bot 콘솔</h1>
  <section id="login" class="card"> …기존 32~42행 그대로(“사용 기간이 시작됩니다” 포함)… </section>

  <div id="app" hidden>
    <section class="strip" id="runstate" aria-live="polite" hidden>
      <p class="strip-text"></p>
    </section>
    <div id="console" class="console" data-mode="inbox" data-view="list">
      <nav id="rail" class="rail" aria-label="계정"> …4.1… </nav>
      <section id="inbox" class="inbox" data-tab="chat" aria-labelledby="chat-title">
        <div id="kkt" class="kkt"> <div class="kkt-list">…4.2…</div> <div class="kkt-room">…4.3~4.5…</div> </div>
      </section>
      <div id="settings" class="settings" hidden> …4.6… </div>
    </div>
    <p id="chat-live" class="sr-only" aria-live="polite"></p>
  </div>
</main>
<script src="/panel.js?v=15"></script>
</body>
</html>
```

핵심: `#inbox`가 `section[data-tab="chat"]`이다. 기존 `showTab()`의 `[data-tab]` 숨김 루프가 그대로 inbox/settings 전환을 만든다. `#kkt`는 `hidden`·`data-view` 없이 항상 보이는 두 열 컨테이너이고, `data-view`는 `#console`로 올라간다.

### 4.1 계정 레일 `#rail`

```html
<nav id="rail" class="rail" aria-label="계정">
  <button type="button" id="rail-all" class="rail-btn rail-all" data-device="" aria-current="true" aria-label="전체 대화">
    <span class="rail-glyph" aria-hidden="true">전체</span>
    <span class="rail-badge" aria-hidden="true" hidden></span>
    <span class="rail-tip" aria-hidden="true">전체 대화</span>
  </button>
  <hr class="rail-sep">
  <div id="rail-accounts" class="rail-accounts"></div>
  <button type="button" id="rail-add" class="rail-btn rail-add" aria-label="계정 추가">
    <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path d="M12 5v14M5 12h14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg>
    <span class="rail-tip" aria-hidden="true">계정 추가</span>
  </button>
  <span class="rail-grow"></span>
  <button type="button" id="rail-settings" class="rail-btn rail-gear" aria-label="설정">
    <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path d="M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Z" fill="none" stroke="currentColor" stroke-width="2"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg>
    <span class="rail-tip" aria-hidden="true">설정</span>
  </button>
</nav>

<!-- 계정 버튼 하나 (renderRail() 이 #rail-accounts 안에 만든다) -->
<button type="button" class="rail-btn rail-acct" data-device="wabc…0001" data-state="live" aria-current="false"
        aria-label="a@kakao.com · 접속 중 · 안 읽음 2" style="--ava: var(--acc-0)">
  <span class="ava ava-rail" aria-hidden="true">A</span>
  <span class="rail-dot" aria-hidden="true"></span>
  <span class="rail-badge" aria-hidden="true">2</span>
  <span class="rail-tip" aria-hidden="true">a@kakao.com<small>접속 중</small></span>
</button>
```

- 치수: 레일 폭 72/64(태블릿), 폰은 높이 64의 가로 줄. 버튼 48×48, 아바타 44px 원(폰 40px), 글자 = `initialOf(email)` 16px/700 흰색, 배경 `--ava`(계정 순번 `% 8`의 `--acc-N`).
- 선택 표시: `.rail-acct::before`(레일 왼쪽 끝 4×8px `--rail-pill` 막대) → hover 4×20 → `[aria-current="true"]` 4×36, `var(--t-base)`. 아바타는 hover/current에서 `border-radius: var(--r-ava-rail-on)`. 폰(가로)에서는 막대 대신 아바타 아래 3px `--rail-pill` 밑줄.
- `.rail-dot`: 12px, 아바타 오른쪽 아래, `border: 3px solid var(--rail-bg)`. `data-state` → 색: `live` `--st-live` / `linking` `--st-wait` / `error` `--st-wait` + 안쪽 2px 흰 링 / `needs_register` `--st-bad` / `sender_down` `--st-off`.
- `.rail-badge`: 오른쪽 위, `min-width:18px; height:18px; padding:0 5px; border-radius:9px; background:var(--badge); color:var(--badge-ink); font:700 11px/18px; border:2px solid var(--rail-bg)`. 0이면 `hidden`, 99 초과 `99+`. `#rail-all .rail-badge` = 전체 합(열린 대화 제외).
- `.rail-tip`: `position:absolute; left:calc(100% + 10px)`, `background:var(--rail-tip-bg); color:var(--rail-ink)`, 반경 8px, `padding:6px 10px`, `box-shadow:var(--sh-tip)`, `z-index:var(--z-tip)`, hover/`:focus-visible`에서만. `small`은 `--rail-muted` 12px. 폰에서는 `display:none`.
- 상태 라벨(명사형, 툴팁·aria-label·칩 공통): `live`→`접속 중`, `linking`→`연결 대기`, `needs_register`→`등록 필요`, `error`→`응답 없음`, `sender_down`→`발송 중지`.
- 상태: default / hover(`--rail-hover`) / `[aria-current="true"]`(`--rail-active`) / `:focus-visible`(2px `#fff` outline, offset 2). **disabled는 쓰지 않는다**(계정 0개여도 `전체`는 받은함 빈 상태로 간다). 첫 `/me` 전 `#rail-accounts`에 `.rail-skel` 2개(원형 회색, `aria-hidden`).
- `#rail-accounts { overflow-y:auto; scrollbar-width:none }`(세로), 폰은 가로 flex.

### 4.2 대화 열 `#inbox .kkt-list`

```html
<div class="kkt-list">
  <div class="kkt-tools">
    <h2 id="chat-title" class="kkt-toolname">전체 대화</h2>
    <button type="button" id="chat-unread" class="chip" aria-pressed="false">안 읽음 <b id="chat-unread-n" hidden></b></button>
    <button type="button" id="chat-reload" class="icon-btn" aria-label="새로고침">
      <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path d="M20 12a8 8 0 1 1-2.3-5.6M20 4v5h-5" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>
    </button>
  </div>
  <div class="kkt-search">
    <svg class="kkt-search-ico" viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><circle cx="11" cy="11" r="6.5" fill="none" stroke="currentColor" stroke-width="2"/><path d="m16 16 4 4" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg>
    <input id="chat-search" type="search" placeholder="이름·내용 검색" aria-label="대화 검색" autocomplete="off">
  </div>
  <div id="chat-notice" class="kkt-notice" role="status" hidden></div>
  <p id="chat-error" class="error" role="alert"></p>
  <div id="chat-rooms" class="kkt-rooms" role="list"></div>
</div>

<!-- 행 (renderConvList() 생성) -->
<div role="listitem">
  <button type="button" class="kkt-row unread" data-id="5" data-device="wabc…0001" data-key="wabc…0001/5" aria-current="false">
    <span class="kkt-ava" aria-hidden="true" style="--ava:#7e9f6b">김</span>
    <span class="kkt-meta">
      <span class="kkt-name"><b>김민수</b><time class="kkt-time" datetime="2026-10-08T15:12:00+09:00">오후 3:12</time></span>
      <span class="kkt-prev-row"><span class="kkt-prev">입금했어요</span><span class="sr-only">안 읽음 </span><span class="kkt-badge">2</span></span>
      <span class="kkt-acc"><i class="kkt-acc-dot" aria-hidden="true" style="--ava: var(--acc-0)"></i>a@kakao.com</span>
    </span>
  </button>
</div>

<!-- #chat-notice 내용 (updateNotice() 생성, 전체 필터 + 문제 계정 있을 때) -->
<p class="kkt-notice-title">확인이 필요한 계정 1개</p>
<div class="kkt-notice-row" data-device="wabc…0002">
  <span class="st-dot" data-state="needs_register" aria-hidden="true"></span>
  <span class="kkt-notice-text">b@kakao.com · 등록 필요</span>
  <button type="button" class="btn ghost sm">등록</button>
</div>
```

- `.kkt-tools` 48px, `--paper-2` 바탕, 아래 1px `--line`. `#chat-title` 15px/700, `overflow:hidden; text-overflow:ellipsis`, 전체 → `전체 대화`, 계정 필터 → 그 계정 이메일.
- `#chat-unread.chip`: 높이 32(터치 영역은 패딩으로 44), 반경 999, `--chip-bg/--chip-ink`, `[aria-pressed="true"]`는 `--accent` 바탕 흰 글자. `#chat-unread-n` = 전체 안 읽음(열린 대화 제외), 0이면 `hidden`.
- `.icon-btn` 44×44, 반경 10px, hover `--sunken`.
- `.kkt-search` 패딩 `4px 12px 8px`; input **44px**(폰 포함), 반경 12px, `--search-bg`, 왼쪽 아이콘 자리 36px, 포커스 시 `--paper` + accent 링. 비면 전체 목록. 입력 120ms debounce, `name`·`preview` 소문자 포함 검색.
- `.kkt-row`: grid `44px minmax(0,1fr)`, gap 12px, `padding:10px 12px`, `min-height:64px`(계정 칩 있으면 72px), 왼쪽 3px 선택 막대(`[aria-current="true"]::before`, `--row-current-bar`), hover `--row-hover`, current `--row-current`. 행 사이 `--divider` 1px(왼쪽 68px부터). `.bump`는 안 읽음이 늘어난 행에 400ms(`--bump`→투명).
- `.kkt-ava` 44px 반경 14px, `--ava` 바탕(`avaColor(name)`), 흰 글자 15px/700(장식, `aria-hidden`).
- `.kkt-name b` 14px/650; `.unread .kkt-name b { font-weight:750 }`, `.unread .kkt-prev { color:var(--ink) }`; 읽음이면 `.kkt-prev` `--muted` 13px, 한 줄 말줄임.
- `.kkt-time` `--ink-2` 12px tabular. 오늘 → `오후 3:12`, 올해 → `10월 7일`, 다른 해 → `2025.12.31`.
- `.kkt-badge`: 18px, `--badge/--badge-ink`, 11px/700, 반경 9px; **열려 있는 대화의 배지는 만들지 않는다**(기존 규칙 — 서버가 0으로 돌리기 전 잠깐 뜨는 값). `textContent`는 숫자만(`'7'`, 99 초과 `'99+'`).
- `.kkt-acc`(계정 칩): 전체 필터이고 계정이 2개 이상일 때만. 12px `--chip-ink`, 점 8px `--ava`, 말줄임. 계정 필터에선 만들지 않는다.
- `#chat-notice`(`role=status`, `--wait-bg` 바탕, `--wait-line` 위아래 선, 13px): 
  - 전체 필터: 상태가 `needs_register`·`error`인 계정이 있으면 제목 `확인이 필요한 계정 {n}개` + 계정별 행 `{email} · 등록 필요`(+ 버튼 `등록`) / `{email} · 응답 없음`(버튼 없음). `needs_register` 행을 앞에 둔다.
  - 계정 필터: 그 계정이 문제면 행 하나(제목 없음). 아니면 `hidden`.
  - `sender_up:false`이면 `hidden`(띠가 대신한다).
  - `등록` 클릭 → `startReauth(device_id, email)`(5.11).
- `#chat-error`(`role=alert`): `/panel/api/inbox` 요청 자체 실패(네트워크·5xx) → `대화 목록을 불러오지 못했습니다. 잠시 뒤 새로고침을 눌러 주세요.` 성공하면 비운다.
- 빈 상태 `.kkt-empty`(인라인 SVG 28px `--faint` + 제목 15px/700 + 설명 13px `--muted`, 가운데, 패딩 32px 20px — 이모지 없음):
  - 계정 0개: 제목 `등록된 계정 없음`, 설명 `계정을 등록하면 갠톡이 여기에 모입니다.`, 버튼 `계정 등록`(→ `showTab('account')`, `#email` 포커스)
  - 전체·대화 0: 제목 `받은 갠톡 없음`, 설명 `오픈프로필 1:1 채팅(갠톡)이 오면 여기에 나타납니다.`
  - 계정 필터·대화 0: 제목 `받은 갠톡 없음`, 설명 `이 계정에 받은 갠톡이 없습니다.`
  - 검색 0: 제목 `검색 결과 없음`, 설명 `검색어에 맞는 대화가 없습니다.`
  - 안 읽음 필터·0: 제목 `안 읽은 대화 없음`, 설명 `모든 대화를 읽었습니다.`
  - 첫 응답 전: `.kkt-skel` 행 4개(`aria-hidden`, 애니메이션 없음).

### 4.3 대화 창 머리 `.kkt-head`

```html
<div class="kkt-room">
  <div class="kkt-head">
    <button type="button" id="chat-back" class="kkt-back icon-btn" aria-label="대화 목록으로">
      <svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true"><path d="M15 5l-7 7 7 7" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>
    </button>
    <div id="chat-head-ava" class="kkt-head-ava ava" aria-hidden="true"></div>
    <div class="kkt-head-meta">
      <strong id="chat-peer" class="kkt-peer">선택한 대화 없음</strong>
      <span id="chat-head-sub" class="kkt-sub"></span>
    </div>
    <span id="thread-state" class="thread-state" data-state="" hidden></span>
    <button type="button" id="thread-settings" class="btn ghost sm" hidden>설정</button>
  </div>
  <div id="chat-log" class="kkt-log" tabindex="0" aria-label="대화 내용"></div>
  <button type="button" id="chat-newpill" class="kkt-newpill" hidden>새 메시지<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path d="m6 10 6 6 6-6" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg></button>
  <p id="chat-note" class="kkt-note" role="status"></p>
  <form id="chat-form" class="kkt-compose"> …4.5… </form>
  <p id="compose-hint" class="compose-hint">Enter 전송 · Shift+Enter 줄바꿈</p>
</div>
```

- 높이 56px, `--paper`, 아래 1px `--line`, `z-index:var(--z-head)`.
- `#chat-peer` 16px/700. `#chat-head-sub` 12px `--ink-2` = `{email} 계정으로 답장`. 대화 미선택 시 sub 비움, 아바타 `hidden`(`.show` 클래스 없음).
- `#chat-head-ava`: 40px 반경 12px, `--ava: avaColor(name)`, 흰 initial.
- `#thread-state` 칩(13px, 반경 999, 패딩 2px 10px, 앞 점 8px): `live`→`접속 중`(`--ok-bg`/`--accent`), `linking`→`연결 대기`(`--wait-bg`/`--warn`), `needs_register`→`등록 필요`(`--bad-bg`/`--bad-ink`), `error`→`응답 없음`(`--wait-bg`/`--warn`), `sender_down`→`발송 중지`(`--sunken`/`--muted`). 대화가 열려 있을 때만 보인다.
- `#thread-settings`(`설정`, 2자): 열린 대화를 받은 계정의 설정(`openAccount(chat.deviceId, 'macro')`). 열려 있을 때만.
- `#chat-back`은 ≥720px에서 `display:none`.
- `#chat-note`(`role=status`, `--wait-bg` 띠, 13px, `:empty`면 숨김): 입력창 바로 위. 409·503·전송 실패 문구가 여기 한 곳에 모인다(4.5).

### 4.4 메시지 로그 `#chat-log`

```html
<div class="kkt-date" role="separator"><span>2026년 10월 8일</span></div>
<div class="kkt-line them grp-start enter" data-log="1001">
  <div class="kkt-col"><div class="kkt-pair"><div class="kkt-bubble">안녕하세요</div><div class="kkt-at">오후 3:10</div></div></div>
</div>
<div class="kkt-line me grp-start" data-log="1002">
  <div class="kkt-col"><div class="kkt-pair"><div class="kkt-bubble">네, 가능합니다</div><div class="kkt-at">오후 3:12</div></div></div>
</div>
<div class="kkt-line them grp-start">
  <div class="kkt-col"><div class="kkt-pair"><div class="kkt-bubble media">(사진)</div><div class="kkt-at">오후 3:14</div></div></div>
</div>
```

- 바탕 `--log-bg`, 패딩 `16px 16px 12px`, `gap:2px`, `scrollbar-width:thin`.
- `.kkt-date`: 가운데, `margin:12px 0`; `span`은 `--chip-bg/--chip-ink` 11px/600, 패딩 3px 10px, 반경 999. 글은 `fmtDay()` 그대로(`YYYY년 M월 D일`).
- 묶기(기존 `sameSender`·`bigGap` 5분·같은 날): `grp-start`면 `margin-top:10px`; 묶음 마지막(`end`)에만 `.kkt-at`. **갠톡은 1:1이므로 로그에 상대 아바타·이름을 그리지 않는다**(머리에 있다 — 기존 `grouped` 분기 삭제).
- 말풍선 `.kkt-bubble`: 14px/20px, 패딩 8px 12px, 반경 16px, `max-width:min(560px, 86%)`, `white-space:pre-wrap; overflow-wrap:anywhere`, 그림자 `--sh-bubble`. `.them`: `--bubble-them` + 1px `--bubble-them-line`, `grp-start`면 왼쪽 위 반경 6px. `.me`: `--bubble-me/--bubble-me-ink`, 오른쪽 정렬, `grp-start`면 오른쪽 위 반경 6px.
- 매체(`text` 비고 `label` 있음): `.kkt-bubble.media` `--media-bg/--media-ink` 600, 기울임 없음, 글은 `'(' + label + ')'`(기존), `label`도 비면 `(첨부)`.
- `.kkt-at` 11px `--ink-2` tabular.
- 새 글 `.enter`: `@keyframes kkt-in { from { opacity:0; transform:translateY(6px) } }` `var(--t-enter) var(--ease) both`.
- `#chat-newpill`: 로그 위 하단 가운데 떠 있는 pill(`--accent` 바탕 흰 글자 13px/600, 36px, 그림자). 스크롤이 바닥에서 70px 넘게 떨어진 채 새 글이 오면 보이고, 누르거나 바닥 근처로 스크롤하면 숨는다.
- 상태(`.kkt-empty`, 글자 `--muted`): 미선택 `대화를 선택하면 내용이 표시됩니다.`; 로딩 `불러오는 중`; 빈 방 `아직 메시지가 없습니다.`; 실패 `대화를 불러오지 못했습니다. 잠시 뒤 자동으로 다시 읽습니다.`
- **접근성 결정(명시적 이탈)**: `#chat-log`의 `aria-live="polite"`를 **제거**한다. `renderThread()`가 로그 전체를 다시 그리므로 live 영역이면 변경마다 전체가 낭독된다. 대신 `#chat-live`(sr-only, polite)에 `새 메시지 {n}건 · {peer}`를 쓴다(폴링당 최대 1회, `initial`에는 쓰지 않음). `#runstate`·`#code`의 `aria-live="polite"`는 유지.

### 4.5 입력창 `#chat-form`

```html
<form id="chat-form" class="kkt-compose">
  <textarea id="chat-text" rows="1" placeholder="메시지 입력" autocomplete="off" maxlength="1000" aria-label="메시지" aria-describedby="chat-note" disabled></textarea>
  <span id="chat-count" class="kkt-count" aria-live="polite" hidden></span>
  <button type="submit" id="chat-send" class="kkt-sendbtn" aria-label="보내기" disabled>
    <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path d="M3.3 20.7l18-8.7-18-8.7.02 6.9L15 12 3.32 13.8z" fill="currentColor"/></svg>
  </button>
</form>
```

- 패딩 `10px 12px`, `--paper`, 위 1px `--line`, 폰 `padding-bottom: calc(10px + env(safe-area-inset-bottom))`. textarea `min-height:44px; max-height:140px; resize:none; border-radius:14px; padding:11px 14px; font-size:15px; background:var(--sunken)`; 포커스 시 `--paper` + accent 링. `autoGrow()` 상한 140.
- `.kkt-sendbtn` 44×44 원, 기본 `--send-off`, `.kkt-compose.has-text .kkt-sendbtn:not(:disabled)` → `--accent`, hover `--accent-hi`, active `scale(.92)`.
- Enter 전송, Shift+Enter 줄바꿈, IME 조합 중(`ev.isComposing || ev.keyCode === 229`) Enter 무시.
- `#chat-count`: 900자부터 `912/1,000` 표시(12px `--ink-2`, 오른쪽 아래). 1,000자가 상한(`maxlength`, 서버도 1,000자로 자른다).
- disabled 상태와 placeholder(명사형):
  - 대화 없음 → `선택한 대화 없음`
  - 계정 `needs_register` → `다시 등록 필요`
  - `sender_down` → `발송 작업 중지`
  - `linking`·`error` → 입력 가능(보내기 허용, 실패는 `#chat-note`)
  - 전송 중: `#chat-send`만 disabled, textarea 유지(이어서 타자 가능)
- `#chat-note` 문구(전송·읽기 실패. 입력 내용은 **지우지 않는다**):
  - 409 → `카카오 로그인이 끊겼습니다. 설정 › 계정에서 다시 등록해 주세요.`
  - 503 → 서버 `error`(= `sender.reason()`) 그대로, 없으면 `발송 작업이 멈춰 있습니다.`
  - 그 외 전송 실패 → `메시지를 보내지 못했습니다. 잠시 뒤 다시 해 주세요.`
  - 전송 성공·대화 전환·닫기 시 비운다.
- `#compose-hint` 12px `--ink-2`, 패딩 `0 14px 8px`, <720px `display:none`.

### 4.6 설정 뷰 `#settings`

```html
<div id="settings" class="settings" hidden>
  <div class="settings-side">
    <label for="settings-acct" class="sr-only">설정할 계정</label>
    <select id="settings-acct"></select>   <!-- option: email, value: device_id. 0개면 option '계정 없음' + disabled -->
    <nav class="tabs" id="tabs" aria-label="관리 메뉴">
      <button type="button" class="tab tab-chat" data-tab="chat" aria-current="false"><span class="tname">채팅</span><span class="tval" data-sum="chat"></span></button>
      <button type="button" class="tab" data-tab="macro" aria-current="false"><span class="tname">매크로</span><span class="tval" data-sum="macro"></span></button>
      <button type="button" class="tab" data-tab="visit" aria-current="false"><span class="tname">들낙 방지</span><span class="tval" data-sum="visit"></span></button>
      <button type="button" class="tab" data-tab="cover" aria-current="false"><span class="tname">욕설 가리기</span><span class="tval" data-sum="cover"></span></button>
      <button type="button" class="tab" data-tab="profile" aria-current="false"><span class="tname">프로필 감지</span><span class="tval" data-sum="profile"></span></button>
      <button type="button" class="tab" data-tab="reply" aria-current="false"><span class="tname">자동응답</span><span class="tval" data-sum="reply"></span></button>
      <button type="button" class="tab" data-tab="snipe" aria-current="false"><span class="tname">저격</span><span class="tval" data-sum="snipe"></span></button>
      <button type="button" class="tab" data-tab="account" aria-current="true"><span class="tname">계정</span><span class="tval" data-sum="account"></span></button>
    </nav>
  </div>
  <div class="panes">
    <section class="card" id="account-block" data-band="account" data-tab="account"> …기존 76~102행 그대로… </section>
    <div id="detail" hidden>
      <p id="detail-where" class="where"></p>
      <section class="card" data-band="macro" data-tab="macro" aria-labelledby="macro-title"> …기존 142~188행 그대로… </section>
      <section class="card" data-band="visit" data-tab="visit" aria-labelledby="visit-title"> …그대로… </section>
      <section class="card" data-band="cover" data-tab="cover" aria-labelledby="cover-title"> …그대로… </section>
      <section class="card" data-band="profile" data-tab="profile" aria-labelledby="profile-title"> …그대로… </section>
      <section class="card" data-band="reply" data-tab="reply" aria-labelledby="reply-title"> …그대로… </section>
      <section class="card" data-band="snipe" data-tab="snipe" aria-labelledby="snipe-title"> …그대로… </section>
    </div>
    <footer class="limit"> …기존 265~268행 두 문단 그대로… </footer>
  </div>
</div>
```

- 기존 `section.card[data-band="chat"]`(107~140행)은 삭제한다 — 그 안의 id는 4.2~4.5로 옮겨졌다. `#detail`의 직계 자식은 `p#detail-where` + 카드 6개뿐이어야 한다(JS가 `.row-actions`를 `#macro-title.parentNode` 앞에 끼워 넣는다 — 기존 코드 그대로).
- `.tab-chat`는 아래 구분선. `data-sum="chat"`에 `안 읽음 N`(0이면 `대화 N개`, 대화도 없으면 빈 값). 계정 0개여도 `chat`·`account` 탭은 활성(`setTabsEnabled`의 예외를 `account` 하나에서 `chat`·`account` 둘로).
- `.tabs`는 ≥1024px 세로(기존 ≥900 규칙 이동), 720~1023·<720px 가로 pill 띠(기존 규칙). `.shell` 규칙 삭제.
- `#settings-acct` change → `openAccount(value, currentTab())`. 셀렉트 왼쪽에 `--ava` 점은 두지 않는다(네이티브 select).
- `#account-list`의 계정 행: `.account > div(strong email, span reasonText) + .account-actions(button.btn.ghost '채팅', button.btn.ghost '설정')`. `채팅` → `openAccount(id)`(받은함, 그 계정 필터), `설정` → `openAccount(id, 'macro')`. 기존 `열기`는 없앤다(테스트 11장).
- `.row-actions[data-tab="account"]`(`이 계정 다시 등록` / `이 계정 등록 해제`)는 기존 JS 삽입 그대로.

### 4.7 상태 띠 `#runstate`

```html
<section class="strip" id="runstate" aria-live="polite" hidden>
  <p class="strip-text"></p>
</section>
```

- 띠는 **발송 작업(sender) 상태 하나만** 말한다. 계정별 문제는 레일 점·`#chat-notice`·머리 칩·입력창이 맡는다(문구가 세 곳에 흩어지지 않게).
- `sender_up:true` → `hidden`.
- `sender_up:false` → `.strip.down`(`--bad-bg` 바탕, `--bad-ink` 글자, 왼쪽 점 `--st-bad`): `sender_reason`이 있으면 그대로, 없으면 `발송 작업이 멈춰 있습니다. 작업이 다시 시작되면 저장된 계정으로 이어서 접속합니다.`
- 반경 12px, 패딩 10px 14px, 13.5px/600, 콘솔 위. 보이는 만큼 콘솔이 줄어든다(2장 높이 공식). 폰에서는 반경 0, 두 줄까지.

### 4.8 인라인 오류·공통

- `.error`(`--danger` 13px 600, `:empty` 숨김)와 `role="alert"` 유지. 모든 새 오류 문구는 [현상]+[조치] 두 문장 이내.
- `api()`의 메시지 변환 유지 — 네트워크 원문(`Load failed`, `timeout`, `needs_register`, `undelivered`)은 절대 화면에 쓰지 않는다. `e.message`를 그대로 띄우는 곳은 `#chat-note`의 503(서버 JSON `error`)과 기존 설정 폼 핸들러뿐.

### 4.9 새 문구 전수표 (TONE 점검용)

| 위치 | 문구 |
|---|---|
| h1(sr-only) | `K bot 콘솔` |
| 레일 aria-label | `전체 대화`, `전체 대화 · 안 읽음 3`, `{email} · 접속 중 · 안 읽음 2`, `계정 추가`, `설정` |
| 상태 라벨 | `접속 중` / `연결 대기` / `등록 필요` / `응답 없음` / `발송 중지` |
| 목록 제목 | `전체 대화` / `{email}` |
| 버튼 | `안 읽음`, `새로고침`(aria), `등록`, `계정 등록`, `채팅`, `설정`, `보내기`(aria), `대화 목록으로`(aria), `새 메시지`, `나가기`(기존) |
| 검색 | placeholder `이름·내용 검색`, aria `대화 검색` |
| 빈 상태 | 4.2의 5종 |
| 알림 | `확인이 필요한 계정 {n}개`, `{email} · 등록 필요`, `{email} · 응답 없음` |
| 오류 | `대화 목록을 불러오지 못했습니다. 잠시 뒤 새로고침을 눌러 주세요.`, `대화를 불러오지 못했습니다. 잠시 뒤 자동으로 다시 읽습니다.`, `카카오 로그인이 끊겼습니다. 설정 › 계정에서 다시 등록해 주세요.`, `메시지를 보내지 못했습니다. 잠시 뒤 다시 해 주세요.`, `발송 작업이 멈춰 있습니다.` |
| 머리 | `선택한 대화 없음`, `{email} 계정으로 답장` |
| 로그 | `대화를 선택하면 내용이 표시됩니다.`, `불러오는 중`, `아직 메시지가 없습니다.` |
| 입력창 | `메시지 입력` / `선택한 대화 없음` / `다시 등록 필요` / `발송 작업 중지`, `Enter 전송 · Shift+Enter 줄바꿈`, `912/1,000` |
| 띠 | `발송 작업이 멈춰 있습니다. 작업이 다시 시작되면 저장된 계정으로 이어서 접속합니다.` |
| 탭 요약 | `안 읽음 N` / `대화 N개` / (기존) `켜짐 · 방 N개` / `꺼짐` / `N개 켜짐` / `N개` |
| 셀렉트 | `계정 없음` |
| 문서 제목 | `(N) 관리 · K bot` / `관리 · K bot` |
| sr 알림 | `새 메시지 {n}건 · {peer}` |

없애는 문구: `대화를 고르세요`, `불러오는 중…`, `먼저 인사를 보내 보세요`, `🗨️`, `💬`, `오픈프로필 갠톡`(툴바), `발송 위치: 이 서버. …`(정상 띠), `위에서 이 계정을 다시 등록해 주세요`.

---

## 5. 상호작용·데이터 흐름

### 5.1 클라이언트 상태 (`public/panel.js` 채팅 블록 교체)

```js
var ui = { filter: '', query: '', unreadOnly: false };                 // '' = 전체
var inboxSt = { accounts: [], chats: [], byDevice: {}, prevUnread: {}, sig: '', railSig: '',
                busy: false, again: false, seq: 0, timer: null, fails: 0,
                senderUp: true, loaded: false, hiddenAt: 0 };
var chat = { deviceId: '', openId: '', openName: '',
             roomBusy: false, roomAgain: false, sending: false,
             roomTimer: null, roomSig: '', renderedIds: {} };
var consoleEl = document.getElementById('console');
var settingsEl = document.getElementById('settings');
var railEl = document.getElementById('rail');
var railAccounts = document.getElementById('rail-accounts');
var acctSel = document.getElementById('settings-acct');
var ACC_COLORS = ['var(--acc-0)','var(--acc-1)','var(--acc-2)','var(--acc-3)','var(--acc-4)','var(--acc-5)','var(--acc-6)','var(--acc-7)'];
function isPhone() { return window.matchMedia('(max-width: 719px)').matches; }
function keyOf(device, id) { return device + '/' + id; }
function openKey() { return chat.openId ? keyOf(chat.deviceId, chat.openId) : ''; }
function accOf(id) { for (var i = 0; i < inboxSt.accounts.length; i++) if (inboxSt.accounts[i].device_id === id) return inboxSt.accounts[i]; return null; }
function accColor(id) { var i = inboxSt.accounts.map(function (a) { return a.device_id; }).indexOf(id); return ACC_COLORS[(i < 0 ? 0 : i) % 8]; }
function stateOf(id) {
  var a = accOf(id);
  if (!inboxSt.senderUp) return 'sender_down';
  if (!a) return 'error';
  if (a.status === 'live' && a.connected === false) return 'linking';
  return a.status;                       // live | needs_register | error | sender_down
}
function stateLabel(st) { return { live: '접속 중', linking: '연결 대기', needs_register: '등록 필요', error: '응답 없음', sender_down: '발송 중지' }[st] || ''; }
function canSend(id) { var st = stateOf(id); return st !== 'needs_register' && st !== 'sender_down'; }
function currentTab() { var b = tabsEl.querySelector('.tab[aria-current="true"]'); return b ? b.dataset.tab : 'account'; }
```

`inboxSt.byDevice[device_id] = chats[]`는 계정별 **마지막 성공분**(5.3 병합). `me.accounts`는 `/me` 때마다 `seedAccountsFromMe()`로 `inboxSt.accounts`에 심는다(`status`: `!me.sender_up`→`sender_down`, `needs_register`→`needs_register`, 그 외 `live`; `connected: !!a.connected`). `applyInbox()`는 서버 `accounts`로 덮어쓰되 `connected === null`이면 `me`의 값을 이어 쓴다.

### 5.2 폴링

| 대상 | 요청 | 주기 | 조건 |
|---|---|---|---|
| 통합 받은함 | `GET /panel/api/inbox` | 9초 (`setTimeout` 체인 `scheduleInbox()`) | `me` 있음, `!document.hidden`, 모드 무관(설정 중에도 레일 배지·탭 요약 갱신) |
| 열린 대화 | `GET /panel/api/chat?device_id&chat_id` | 3초 (`setInterval`, 기존) | inbox 모드, `chat.openId` 있음, `!document.hidden` |
| 수동 | `#chat-reload` | 즉시 `loadInbox(true)` | busy면 `again` 표시 후 끝나고 1회 더 |
| 계정 상태 | `GET /panel/api/me` | 부팅, 등록/해제 뒤, 숨김 5분 초과 뒤 복귀 시 | 주기 폴링하지 않는다(계정별 `/v1/snapshot` 20초 × N) |

- 실패 백오프: `inboxSt.fails >= 3`이면 다음 간격 20초, 성공 시 9초. `fails`는 `/inbox` 자체 실패(네트워크·5xx·401)에서만 는다(계정별 `error`는 200이므로 세지 않는다).
- `/inbox`가 401/403이면 `showLogin()`(접속이 끝난 것).
- `showTab(name)`: `name !== 'chat'`이면 `roomTimer` 정지(기존), `'chat'`이면 `chat.openId` 있을 때 `loadThread(true)` + 타이머 재시작(기존). inbox 타이머는 건드리지 않는다.
- `showLogin()`/`chatReset()`: 두 타이머 정지, `inboxSt.seq++`(비행 중 응답 폐기), 상태 초기화.

```js
function scheduleInbox() {
  if (inboxSt.timer) clearTimeout(inboxSt.timer);
  inboxSt.timer = setTimeout(function () {
    inboxSt.timer = null;
    if (me && !document.hidden) loadInbox(false);
    if (me) scheduleInbox();
  }, inboxSt.fails >= 3 ? 20000 : 9000);
}
async function loadInbox(force) {
  if (!me) return;
  if (inboxSt.busy) { if (force) inboxSt.again = true; return; }
  inboxSt.busy = true;
  var seq = ++inboxSt.seq;
  try {
    var res = await api('/panel/api/inbox');
    if (seq !== inboxSt.seq || !me) return;
    inboxSt.fails = 0; inboxSt.loaded = true;
    say('chat-error', '');
    applyInbox(res);
  } catch (e) {
    if (seq !== inboxSt.seq || !me) return;
    inboxSt.fails += 1;
    if (e && (e.status === 401 || e.status === 403)) { showLogin(); return; }
    say('chat-error', '대화 목록을 불러오지 못했습니다. 잠시 뒤 새로고침을 눌러 주세요.');
  } finally {
    inboxSt.busy = false;
    if (inboxSt.again) { inboxSt.again = false; loadInbox(false); }
  }
}
```

### 5.3 받은함 응답 처리 `applyInbox(res)`

1. `inboxSt.senderUp = res.sender_up !== false`. 서버 `accounts`를 `inboxSt.accounts`로(`connected === null`이면 `me`의 `connected` 승계).
2. `senderUp === false`: `byDevice`·`chats`는 **이전 값 유지**(목록이 비지 않는다), 띠 `.down`, 열린 대화가 있으면 `setComposeEnabled(false)` + placeholder `발송 작업 중지`. 레일은 모두 `sender_down` 점. 3~4단계 건너뜀.
3. 계정별: `status === 'live'` → `byDevice[id] = res.chats.filter(device_id === id)`; `needs_register` → `byDevice[id] = []`; `error` → `byDevice[id]` **유지**(없으면 `[]`). `accounts`에 없는 `byDevice` 키는 삭제.
4. `inboxSt.chats = concat(byDevice[...])` → `last_at desc, unread desc` 정렬(서버와 같은 비교식).
5. `renderRail()`, `renderConvList()`, `updateNotice()`, `updateStrip()`, `updateUnread()`.
6. 열린 대화의 계정이 `needs_register`/`sender_down`이면 `setComposeEnabled(false)` + placeholder; `#thread-state`·`#chat-head-sub` 갱신. `live`로 돌아오면 다음 thread 폴링 성공에서 다시 켜진다(`loadThread` 성공 → `setComposeEnabled(canSend(wantDevice))`).

### 5.4 재렌더 회피 서명

- 레일: `railSig = accounts.map(a => a.device_id + '\u0001' + stateOf(a.device_id) + '\u0001' + unreadOf(a.device_id)).join('|') + '#' + ui.filter + '#' + totalUnread`. 같으면 건너뜀.
- 대화 열(보이는 행 = 필터·안 읽음·검색 적용 후):
  `sig = rows.map(c => c.device_id + '\u0001' + c.chat_id + '\u0001' + c.unread + '\u0001' + c.last_at + '\u0001' + c.name + '\u0001' + c.preview).join('|') + '#' + openKey() + '#' + ui.filter + '#' + ui.query + '#' + (ui.unreadOnly ? 1 : 0) + '#' + (inboxSt.accounts.length > 1 ? 'chip' : '')`.
  같으면 DOM 유지(behavior 1·2). 다르면 `#chat-rooms`를 비우고 다시 그린다. 다시 그리기 전 `document.activeElement`가 `#chat-rooms` 안이면 그 `data-key`를 기억했다가 같은 키의 새 행에 `focus({ preventScroll: true })`. `prevUnread[key] < unread`면 `.bump`.
- 대화 창: 기존 `renderThread` 서명 `(log_id + '.' + text.length)|… + '#' + length` 그대로. `initial`이면 서명 무시.

### 5.5 늦은 응답 버리기

- `loadThread`: 요청 전 `wantDevice = chat.deviceId, wantRoom = chat.openId`를 잡고, 응답 후 둘 다 같을 때만 그린다(기존). 오류 경로도 동일(behavior 3).
- `loadInbox`: `seq` 비교(5.2). `chatReset()`·`showLogin()`이 `seq`를 올려 비행 중 응답을 버린다.
- `sendChat`: 전송 시점의 `(dev, room)`을 잡고, 성공 후 그 대화가 아직 열려 있을 때만 입력창을 비우고 `loadThread(true)`.

### 5.6 안 읽음

```js
function unreadOf(id) { var n = 0; inboxSt.chats.forEach(function (c) { if (c.device_id === id && keyOf(c.device_id, c.chat_id) !== openKey()) n += c.unread || 0; }); return n; }
function totalUnread() { var n = 0; inboxSt.accounts.forEach(function (a) { n += unreadOf(a.device_id); }); return n; }
function updateUnread() {
  var total = totalUnread();
  sumText('chat', total ? '안 읽음 ' + total : (inboxSt.chats.length ? '대화 ' + inboxSt.chats.length + '개' : ''));
  document.title = (total ? '(' + total + ') ' : '') + '관리 · K bot';
  var n = document.getElementById('chat-unread-n'); n.textContent = total ? String(total) : ''; n.hidden = !total;
}
```
열린 대화는 서버가 0으로 돌리기 전까지 클라이언트가 제외한다(기존 규칙). 기존 `updateChatSummary(chats)`는 삭제하고 `updateUnread()`가 대신한다.

### 5.7 레일에서 계정 고르기 `selectRail(deviceId)`

1. `ui.filter = deviceId`; 레일 `aria-current` 갱신; `#chat-title` = 전체면 `전체 대화`, 아니면 그 계정 이메일.
2. `renderConvList()` — 캐시로 즉시(요청 없음). `updateNotice()`.
3. **열린 대화가 새 필터에서 보이지 않을 때만** `closeConversation()`(= 열린 대화의 계정 ≠ 필터이고 필터 ≠ 전체). 전체로 바꾸거나 그 대화의 계정을 고르면 유지한다. 검색어·안 읽음 토글은 대화를 닫지 않는다.
4. settings 모드였으면: `deviceId`면 `openAccount(deviceId, currentTab())`, 전체면 `showTab('chat')`.
5. `#rail-all` 클릭 = `selectRail('')` + `showTab('chat')`.

### 5.8 대화 전환 `openConversation(deviceId, chatId, name)`

```
chat.deviceId = deviceId   // 그 대화를 받은 계정 — 전송 device_id 는 여기서만 정해진다
chat.openId = chatId; chat.openName = name; chat.roomSig = ''; chat.renderedIds = {}; chat.roomAgain = false
머리: #chat-peer = name; #chat-head-ava(.show, --ava avaColor(name), initialOf(name));
      #chat-head-sub = email + ' 계정으로 답장'; #thread-state(data-state = stateOf, 라벨) hidden=false; #thread-settings hidden=false
초안 삭제: #chat-text.value = ''; #chat-note 비움; autoGrow(); updateComposeState()
setComposeEnabled(canSend(deviceId)); placeholder 갱신(4.5)
consoleEl.dataset.view = 'room'; isPhone() 이면 history.pushState({ kview: 'room' }, '', location.pathname + location.search)
markOpenRow(keyOf(deviceId, chatId)); updateUnread(); #chat-log = .kkt-empty '불러오는 중'; #chat-newpill hidden
loadThread(true); roomTimer 재설정(3000ms, document.hidden || !chat.openId 면 건너뜀)
!isPhone() 이면 #chat-text.focus()
```
목록은 여기서 다시 그리지 않는다(`markOpenRow`만). 배지는 다음 렌더에서 사라진다(기존 동작).

### 5.9 전송 `sendChat()`

```js
async function sendChat() {
  if (!chat.openId || chat.sending) return;
  var text = chatText.value; if (!text.trim()) return;
  var dev = chat.deviceId, room = chat.openId;
  chat.sending = true; chatSend.disabled = true;
  try {
    await api('/panel/api/chat/send', { device_id: chat.deviceId, chat_id: chat.openId, text: text });
    if (chat.deviceId !== dev || chat.openId !== room) return;
    chatText.value = ''; autoGrow(); updateComposeState(); chatNote.textContent = '';
    await loadThread(true);          // 읽는 중이면 roomAgain 으로 한 번 더 → 보낸 글이 바로 보인다 (behavior 4)
    loadInbox(false);
  } catch (e) {
    if (chat.deviceId !== dev || chat.openId !== room) return;
    chatNote.textContent = (e && e.status === 409) ? '카카오 로그인이 끊겼습니다. 설정 › 계정에서 다시 등록해 주세요.'
      : (e && e.status === 503) ? ((e.body && e.body.error) || '발송 작업이 멈춰 있습니다.')
      : '메시지를 보내지 못했습니다. 잠시 뒤 다시 해 주세요.';
  } finally {
    chat.sending = false;
    setComposeEnabled(!!chat.openId && canSend(chat.deviceId));
    if (chat.openId) chatText.focus();
  }
}
```
`panel-check`가 `device_id: chat.deviceId` 문자열을 단언한다(11장).

### 5.10 대화 닫기 `closeConversation()`

`consoleEl.dataset.view = 'list'`; `chat.openId = ''; chat.deviceId = ''; chat.openName = ''`; `roomTimer` 정지; `#chat-text` 비움·disabled(placeholder `선택한 대화 없음`); `#chat-peer = '선택한 대화 없음'`; `clearHead()`; `#thread-state`·`#thread-settings` hidden; `#chat-note` 비움; `#chat-newpill` hidden; `markOpenRow('')`; `#chat-log` = `.kkt-empty` `대화를 선택하면 내용이 표시됩니다.`; `updateUnread()`.

- `#chat-back` 클릭: `history.state && history.state.kview === 'room'`이면 `history.back()`(popstate가 닫는다), 아니면 `closeConversation()`.
- `popstate`: `ev.state && ev.state.kview === 'room'`이면 무시; `isPhone() && consoleEl.dataset.view === 'room' && !location.hash`이면 `closeConversation()`. 건너뛰기 링크(`#main`)가 만든 해시 이동은 `location.hash`가 있어 무시된다.

### 5.11 기타

- **초안**: 대화별 초안 보관 없음(엉뚱한 사람에게 보내는 사고 방지, behavior 5). 전환·닫기·필터로 닫힘·로그아웃 시 비운다.
- **visibilitychange**: 숨김 → `hiddenAt = Date.now()`. 보임 → `Date.now() - hiddenAt > 300000`이면 `refreshMe()`(안에서 `loadInbox(true)`), 아니면 `loadInbox(false)`; 열린 대화 있으면 `loadThread(false)`.
- **키보드**: 입력 요소 밖에서 `/` 또는 `Ctrl+K` → `#chat-search` 포커스. `Alt+↓/↑` → 보이는 행 기준 다음/이전 대화 열기(끝에서 멈춤). `#chat-search`에서 `Esc` → 비우기. `#chat-text`에서 `Esc` → 폰이면 `#chat-back`과 같은 동작, 아니면 blur. Enter/Shift+Enter(4.5).
- **`startReauth(deviceId, email)`**(`#chat-notice`의 `등록`): `try { await openAccount(deviceId, 'account'); } catch (e) { showTab('account'); }` → `regDevice = deviceId; add-form.dataset.reauth = '1'; #email.value = email; add-form.scrollIntoView({ behavior:'smooth', block:'start' })`. 기존 `again` 버튼 핸들러는 손대지 않는다.
- **모드 전환 포커스**: inbox→settings로 바뀔 때 현재 탭 버튼에 `focus({ preventScroll:true })`; settings→inbox로 돌아올 때 ≥720px이면 `#chat-search`에.

### 5.12 `showTab` / `openAccount` / 부트

```js
function showTab(name) {
  if (!tabsEl) return;
  tabButtons().forEach(function (b) { b.setAttribute('aria-current', b.dataset.tab === name ? 'true' : 'false'); });
  Array.prototype.forEach.call(document.querySelectorAll('[data-tab]'), function (node) {
    if (node.classList.contains('tab')) return;
    node.hidden = node.dataset.tab !== name;
  });
  var inbox = name === 'chat';
  var wasInbox = consoleEl.dataset.mode === 'inbox';
  consoleEl.dataset.mode = inbox ? 'inbox' : 'settings';
  settingsEl.hidden = inbox;
  if (!inbox && chat.roomTimer) { clearInterval(chat.roomTimer); chat.roomTimer = null; }
  if (inbox && chat.openId && !chat.roomTimer) {
    loadThread(true);
    chat.roomTimer = setInterval(function () { if (document.hidden || !chat.openId) return; loadThread(false); }, 3000);
  }
  if (!inbox && wasInbox) { var b = tabsEl.querySelector('.tab[data-tab="' + name + '"]'); if (b) b.focus({ preventScroll: true }); }
  if (inbox && !wasInbox && !isPhone()) document.getElementById('chat-search').focus({ preventScroll: true });
}
function setTabsEnabled(on) {
  tabButtons().forEach(function (b) { if (b.dataset.tab !== 'account' && b.dataset.tab !== 'chat') b.disabled = !on; });
}
async function openAccount(id, tab) {
  say('room-error', ''); say('macro-error', '');
  var res = await api('/panel/api/account?device_id=' + encodeURIComponent(id));
  account = res.account;
  fillDetail();
  fillAcctSelect();                                   // acctSel.value = id
  setTabsEnabled(true);
  if (tab) { showTab(tab); if (isPhone()) document.querySelector('.panes').scrollTop = 0; }
  else { selectRail(id); showTab('chat'); loadInbox(true); }   // 등록 완료 뒤 기존 KEEP 코드의 openAccount(view.device_id) 호출이 이 분기로 온다
}
async function refreshMe() { me = await api('/panel/api/me'); showApp(); renderAccounts(); loadInbox(true); }
function bootConsole() {
  if (!me.accounts || !me.accounts.length) showTab('account'); else showTab('chat');
  loadInbox(true); scheduleInbox();
}
api('/panel/api/me').then(function (res) { me = res; showApp(); renderAccounts(); bootConsole(); }).catch(function () { showLogin(); });
```

`renderAccounts()`: `updateTabSummaries()` → `#account-list` 행(`채팅`/`설정`) → `seedAccountsFromMe()` → `renderRail()` → `fillAcctSelect()`.
`chatReset()`(showLogin·unlink에서 호출): 두 타이머 정지, `inboxSt.seq++`, `inboxSt` 초기화(`accounts/chats/byDevice/prevUnread/sig/railSig/loaded/fails`), `ui` 초기화, `closeConversation()`, `#chat-rooms`·`#rail-accounts` 비움, `say('chat-error','')`, `#chat-notice` hidden, `setTabsEnabled(false)`, `updateTabSummaries()`. **`showTab('account')`를 호출하지 않는다.**

---

## 6. API 계약

### 6.1 신규 `GET /panel/api/inbox`

요청: 쿠키 접속만. 쿼리 없음.

응답 200 (발송 작업이 멈춰 있어도 200 — 레일을 그릴 수 있어야 한다):

```json
{
  "ok": true,
  "sender_up": true,
  "sender_reason": "",
  "at": 1759900000000,
  "accounts": [
    { "device_id": "wabc0123def4.0000000000000001", "email": "a@kakao.com", "status": "live",
      "reason": "", "connected": null, "unread": 2, "chats": 12, "error": "" },
    { "device_id": "wabc0123def4.0000000000000002", "email": "b@kakao.com", "status": "needs_register",
      "reason": "kicked", "connected": null, "unread": 0, "chats": 0,
      "error": "카카오 로그인이 끊겼습니다. 계정을 다시 등록해 주세요." },
    { "device_id": "wabc0123def4.0000000000000003", "email": "c@kakao.com", "status": "error",
      "reason": "timeout", "connected": null, "unread": 0, "chats": 0,
      "error": "대화 목록을 가져오지 못했습니다." }
  ],
  "chats": [
    { "device_id": "wabc0123def4.0000000000000001", "email": "a@kakao.com", "chat_id": "5", "list_kind": "open_dm",
      "name": "김민수", "preview": "입금했어요", "unread": 2, "last_at": 1759899000000 }
  ]
}
```

| 필드 | 규칙 |
|---|---|
| `accounts[]` 순서 | `panel_accounts.created_at` |
| `status` | `live` \| `needs_register` \| `error` \| `sender_down` |
| | `/v1/inbox` 200 `ok:true` → `live`. `ok:false, needs_register:true` → `needs_register`(`reason` = sender `error` 문자열, 예 `kicked`·`reauth`; `error` = `카카오 로그인이 끊겼습니다. 계정을 다시 등록해 주세요.`). 타임아웃(30초)·비정상 응답·throw → `error`(`reason` = `timeout` \| `bad_response` \| `bad_status` \| `failed`; `error` = `대화 목록을 가져오지 못했습니다.`), 그 계정의 chats는 싣지 않는다(다른 계정은 그대로). `senderCall`이 `sender_down`을 던지면 → `sender_down`. `sender.up()`이 false → sender 호출 없이 모두 `sender_down`, `chats: []`, `sender_up:false`, `sender_reason: sender.reason()` |
| `connected` | `true` \| `false` \| `null`. sender `/v1/inbox` 응답에 boolean `connected`가 있으면 그 값, 없으면 `null`(**현재 sender는 주지 않으므로 항상 `null`** — sender 변경은 이 명세의 범위 밖. 클라이언트는 `null`이면 `/me`의 `connected`로 `연결 대기`를 판단) |
| `unread` / `chats` | 그 계정 chats의 `unread` 합 / 개수 |
| `chats[]` | sender `inbox()` 항목에 `device_id`·`email`을 덧붙인 것. `list_kind !== 'open_dm'` 또는 `chat_id`가 `/^[1-9][0-9]*$/`가 아닌 항목은 버린다. `chat_id`는 문자열, `unread`·`last_at`는 숫자(`Number(x) || 0`). 전체를 `(b.last_at - a.last_at) || (b.unread - a.unread)`로 정렬 |

오류: 401 `{ok:false,error:'다시 로그인해 주세요.'}`(`session()`), 503 `{ok:false,error:'서버 설정이 없어 관리 화면을 열 수 없습니다.'}`(설정 없음), gate 실패 → `gate.status` + 쿠키 삭제(`session()`), DB 실패 → 500 `{ok:false,error:'처리하지 못했습니다.'}`(`wrap`). `wrap`의 `sender_down`/`timeout` 503 분기는 이 라우트에서 발동하지 않는다(모든 sender 호출이 `allSettled` 안에 있다).

**서버 구현** — 순수 병합은 `lib/panel-inbox.js`(단위 단언 대상), 라우트는 `routes/panel.js`.

```js
// lib/panel-inbox.js
'use strict';
const NEEDS_REGISTER_TEXT = '카카오 로그인이 끊겼습니다. 계정을 다시 등록해 주세요.';
const FETCH_FAIL_TEXT = '대화 목록을 가져오지 못했습니다.';

function cleanChat(deviceId, email, c) {
  return {
    device_id: deviceId, email: email,
    chat_id: String(c.chat_id), list_kind: 'open_dm',
    name: String(c.name || ''), preview: String(c.preview || ''),
    unread: Number(c.unread) || 0, last_at: Number(c.last_at) || 0,
  };
}

// rows: [{device_id,email}] (created_at 순), settled: Promise.allSettled 결과(같은 순서), senderUp: sender.up()
function mergeInbox(rows, settled, senderUp) {
  const accounts = [];
  const chats = [];
  rows.forEach((row, i) => {
    const out = { device_id: row.device_id, email: row.email, status: 'error', reason: '', connected: null, unread: 0, chats: 0, error: '' };
    const r = settled[i];
    const json = r && r.status === 'fulfilled' && r.value ? r.value.json : null;
    if (!senderUp) {
      out.status = 'sender_down'; out.reason = 'sender_down';
    } else if (json && json.ok) {
      const list = (Array.isArray(json.chats) ? json.chats : [])
        .filter((c) => c && c.list_kind === 'open_dm' && /^[1-9][0-9]*$/.test(String(c.chat_id)));
      out.status = 'live';
      out.connected = typeof json.connected === 'boolean' ? json.connected : null;
      list.forEach((c) => { const n = cleanChat(row.device_id, row.email, c); out.unread += n.unread; chats.push(n); });
      out.chats = list.length;
    } else if (json && json.needs_register) {
      out.status = 'needs_register'; out.reason = String(json.error || 'needs_register'); out.error = NEEDS_REGISTER_TEXT;
    } else {
      const e = r && r.status === 'rejected' ? r.reason : null;
      if (e && e.code === 'sender_down') { out.status = 'sender_down'; out.reason = 'sender_down'; }
      else {
        out.reason = e && e.message === 'timeout' ? 'timeout' : ((e && e.code) || (json ? 'bad_status' : 'failed'));
        out.error = FETCH_FAIL_TEXT;
      }
    }
    accounts.push(out);
  });
  chats.sort((a, b) => (b.last_at - a.last_at) || (b.unread - a.unread));
  return { accounts, chats };
}

module.exports = { mergeInbox, NEEDS_REGISTER_TEXT, FETCH_FAIL_TEXT };
```

```js
// routes/panel.js — 상단 require 에 추가
const inboxLib = require('../lib/panel-inbox');

// routes/panel.js — ownsDevice() 바로 아래, router.get('/panel/api/chats' 바로 위에 삽입
// 통합 받은함은 9초마다 돌아온다. session() 이 라이선스 행을 이미 읽으므로 DB 를 완전히 피하진 못하지만,
// 계정 목록까지 매번 읽지는 않는다 — 키별 60초 임시 저장, 등록·해제 때 비운다.
const ACCOUNT_CACHE_MS = 60000;
const acctCache = new Map();                      // license_key -> { rows, at }
async function accountRows(key) {
  const hit = acctCache.get(key);
  if (hit && Date.now() - hit.at < ACCOUNT_CACHE_MS) return hit.rows;
  const r = await db.q(
    'SELECT device_id, email FROM panel_accounts WHERE license_key=$1 ORDER BY created_at', [key]);
  acctCache.set(key, { rows: r.rows, at: Date.now() });
  return r.rows;
}
function forgetAccounts(key) { acctCache.delete(key); }

router.get('/panel/api/inbox', wrap(async (req, res) => {
  const s = await session(req, res);
  if (!s) return;
  const rows = await accountRows(s.key);
  const up = sender.up();
  const settled = up
    ? await Promise.allSettled(rows.map((row) =>
        senderCall('GET', '/v1/inbox?device_id=' + encodeURIComponent(row.device_id), null, 30000)))
    : [];
  const merged = inboxLib.mergeInbox(rows, settled, up);
  res.json({
    ok: true,
    sender_up: up,
    sender_reason: up ? '' : sender.reason(),
    at: Date.now(),
    accounts: merged.accounts,
    chats: merged.chats,
  });
}));
```

```js
// routes/panel.js — 기존 두 곳에 한 줄씩
// rememberAccount(): INSERT 뒤
  forgetAccounts(key);
// router.post('/panel/api/unlink'): DELETE 뒤, res.json 앞
  forgetAccounts(s.key);
```

삽입 위치 규칙: `router.post('/panel/api/login'`과 `router.post('/panel/api/logout'` 사이에는 아무것도 넣지 않는다(panel-check가 그 구간을 읽는다). `/panel/api/inbox` 라우트는 반드시 `router.get('/panel/api/chats'` **앞**에 둔다(panel-check가 두 문자열 사이를 자른다).

`curl` 확인:

```
# 접속 없음 → 401
curl -si http://localhost:3000/panel/api/inbox | head -1
# 로그인 → 쿠키 → 받은함
curl -s -c /tmp/c.txt -H 'content-type: application/json' -d '{"key":"KAKA-…"}' http://localhost:3000/panel/api/login
curl -s -b /tmp/c.txt http://localhost:3000/panel/api/inbox | jq '.sender_up, [.accounts[] | {email, status, reason, unread}], (.chats | length)'
# 기대: 계정 0개 → accounts [], chats []; 한 계정 재등록 필요 → 그 계정만 status "needs_register", 나머지 chats 는 그대로;
#       sender 중지 → sender_up false, 모든 status "sender_down", chats []
```

### 6.2 sender (`sender/src`)

**변경 없음.** `/v1/inbox`가 `requireLive`로 409 `needs_register`를 돌려주는 동작을 6.1이 흡수한다. `chat-smoke.mjs`는 그대로 통과한다. (후속 선택지: `/v1/inbox` 응답에 `connected: hub.status(id).connected === true`를 더하면 6.1의 `connected`가 채워져 `연결 대기`가 폴링마다 갱신된다 — 이 명세의 수용 기준에는 넣지 않는다.)

### 6.3 기존 엔드포인트

| 엔드포인트 | 변경 |
|---|---|
| `GET /panel/api/me` | 없음. 부팅·등록 완료·해제·숨김 5분 초과 복귀 때만 호출 |
| `GET /panel/api/chats?device_id` | 유지(호환). 새 화면은 쓰지 않는다(panel-check가 `panel.js`에 `/panel/api/chats?`가 없음을 단언) |
| `GET /panel/api/chat?device_id&chat_id` | 없음. 409 → `#chat-note` + 입력 비활성, 503 → `#chat-note` |
| `POST /panel/api/chat/send {device_id, chat_id, text}` | 없음. `device_id` = 대화를 받은 계정(`chat.deviceId`) |
| `GET /panel/api/account`, `POST /panel/api/settings`, `/rooms`, `/register/*` | 없음 |
| `POST /panel/api/unlink` | 성공 뒤 `forgetAccounts(s.key)` 한 줄 |
| `POST /panel/api/login`, `/logout` | **손대지 않는다** |

---

## 7. 접근성

- **구조**: `header.top` → `main#main`(건너뛰기 대상) → `h1.sr-only` `K bot 콘솔`. `nav#rail[aria-label="계정"]`, `section#inbox[aria-labelledby="chat-title"]`, `nav#tabs[aria-label="관리 메뉴"]`, `#chat-rooms[role="list"] > div[role="listitem"] > button.kkt-row`, `#chat-log[tabindex="0"][aria-label="대화 내용"]`, `.kkt-date[role="separator"]`. 각 설정 카드의 `aria-labelledby="<x>-title"` 기존 유지.
- **aria-current**: 레일 선택(필터) `aria-current="true"`, 대화 행(열린 대화) `aria-current="true"`, 탭 `aria-current="true"|"false"`(기존 테스트가 본다), 상단 nav `aria-current="page"`. 한 묶음에 하나만.
- **aria-live**: `#runstate`(polite, 기존), `#code`(polite, 기존), `#chat-live`(polite, sr-only — 새 메시지 건수·상대), `#chat-count`(polite — 900자 넘을 때만 내용이 생긴다), `#chat-note`·`#chat-notice`(`role=status`), `#chat-error`·`#code-error`·각 `*-error`(`role=alert`). `#chat-log`에는 두지 않는다(4.4).
- **이름**: 레일 버튼 `aria-label="{email} · {상태} · 안 읽음 {n}"`(0이면 끝 항목 생략), 아이콘 버튼 전부 `aria-label`, 아바타·점·배지·툴팁 `aria-hidden`. 행 배지 앞 sr-only `안 읽음 `.
- **포커스 순서**: 건너뛰기 → 브랜드 → 구매/내 키/관리 → 나가기 → 레일(전체 → 계정들 → 추가 → 설정) → 안 읽음 → 새로고침 → 검색 → 알림 `등록` → 대화 행들 → (폰) 뒤로 → `설정` → 로그 → 입력 → 보내기. settings 모드: 레일 → 계정 셀렉트 → 탭들 → 카드 폼. 모드 전환 뒤 포커스를 잃지 않게 5.11의 규칙.
- **포커스 표시**: 밝은 면 `outline: 2px solid var(--focus)`(기존), 레일 안 `outline-color: #fff`, offset 2.
- **대비 (계산값)**: `--ink`/흰 18.1 · `--muted`/흰 5.7 · `--ink-2`#5f6b79/흰 5.43, /`--log-bg` 5.0, /`--row-current` 4.75 · `--faint`#66748a/흰 4.74(`--sunken` 위 4.42이므로 글자로 쓰지 않음, 3장 규칙) · `--accent`/흰 9.9 · 흰/`--accent` 9.9 · `--rail-ink`/`--rail-bg` 14.5 · `--rail-muted`/`--rail-bg` 6.7 · 흰/`--badge` 5.04 · `--chip-ink`/`--chip-bg` 7.98 · `--media-ink`/`--media-bg` 6.12 · `--bubble-me-ink`/`--bubble-me` 15.05 · `--accent`/`--ok-bg` 8.6 · `--warn`/`--wait-bg` 6.2 · `--bad-ink`/`--bad-bg` 7.0 · `--muted`/`--sunken` 5.3 · 흰/`--acc-0..7` ≥6.3. 비텍스트(레일 점/`--rail-bg`): `--st-live` 5.1, `--st-wait` 6.0, `--st-off` 5.7, `--st-bad` 3.4(3:1 충족). 금지 조합: `--faint`를 `--sunken`·`--log-bg` 위 글자로.
- **모션**: `prefers-reduced-motion`에서 `--t-*` 0ms, `.enter`·`.bump`·`.pop` 애니메이션 없음.
- **터치**: 조작 요소 전부 44px 이상(레일 48, 행 64, 아이콘 버튼 44, 검색 44, 입력 44, 보내기 44, 탭 44, `#chat-unread` 패딩으로 44).
- **IME**: Enter 전송 시 `isComposing`/`keyCode 229` 검사.
- **색만으로 상태를 전하지 않는다**: 점 옆에 항상 라벨(툴팁·칩·aria-label·알림 글).

---

## 8. 기존 코드와의 접점

### 8.1 `public/panel.js` — 유지 vs 수정 vs 재작성

| 범위(현재 줄) | 처리 |
|---|---|
| 1–20 변수·요소 참조 | 유지. 5.1의 `consoleEl/settingsEl/railEl/railAccounts/acctSel` 추가. `kkt` 참조는 `document.getElementById('kkt')` 그대로 두되 `hidden`·`data-view`를 만지지 않는다 |
| 25–27 `tabButtons` | 유지 |
| 28–46 `showTab` | **수정** 5.12 |
| 47–51 `setTabsEnabled` | **수정**: 예외 `account`·`chat` |
| 52–74 `sumText`, `updateTabSummaries` | 유지(요약 문자열 `켜짐 · 방 N개`/`꺼짐`/`N개 켜짐`/`N개` 그대로) |
| 75–79 `updateChatSummary` | **삭제** → `updateUnread()`(5.6) |
| 81–124 `el`, `say`, `api`, `reasonText` | 유지 |
| 126–132 `showLogin` | **수정**: `document.body.dataset.screen = 'login'` 추가. `chatReset()` 호출 유지 |
| 134–146 `showApp` | **수정**: `document.body.dataset.screen = 'app'`; 띠 문구 생성 삭제 → `updateStrip()` |
| 148–168 `renderAccounts` | **수정**: `열기` → `채팅`/`설정`; 끝에 `seedAccountsFromMe(); renderRail(); fillAcctSelect();` |
| 170–452 `dataUrl … fillDetail` | **유지 그대로** |
| 454–458 `refreshMe` | **수정**: 끝에 `loadInbox(true)` |
| 460–470 `openAccount` | **수정** 5.12(`chatStart` 호출 제거, `tab` 인자) |
| 472–572 `readFile/showPass/hidePass/sleep/confirmLoop` | **유지 그대로**(556행 `openAccount(view.device_id)`는 새 시그니처의 "받은함으로" 분기를 탄다) |
| 574–856 로그인·로그아웃·등록·폼 submit·`reload-rooms` | **유지 그대로**(`대화방 목록을 가져오지 못했습니다. 잠시 뒤 다시 눌러 주세요.` 포함) |
| 858–886 `again`/`unlink`/`actions` 삽입 | **유지 그대로**(`#detail` 안 `#macro-title.parentNode` 앞 — 새 DOM에서도 성립) |
| 888–1250 채팅 블록 | **재작성** 5장. 그대로 가져오는 함수: `AVA_COLORS/avaColor/initialOf/sameSender/bigGap/updateComposeState/clearHead/fmtTime/fmtDay/setComposeEnabled/autoGrow`(autoGrow 상한 120→140), `loadThread`(성공 시 `setComposeEnabled(canSend(wantDevice))`, 409 문구 교체), `renderThread`(`grouped` 분기 삭제, `#chat-live`·`#chat-newpill` 추가), `markOpenRow`(`data-key` 비교). 삭제: `emptyState`(이모지), `chatStart`, `loadChatList`, `renderChatList`, `updateChatSummary`. 신설: `seedAccountsFromMe, renderRail, fillAcctSelect, selectRail, scheduleInbox, loadInbox, applyInbox, renderConvList, updateNotice, updateStrip, updateUnread, unreadOf, totalUnread, openConversation(3인자), closeConversation, startReauth, stateOf, stateLabel, canSend, accOf, accColor, keyOf, openKey, isPhone, currentTab, bootConsole` |
| 1252–1288 리스너 | `tabsEl` 클릭 **유지**; `#chat-reload`(`loadInbox(true)`), `#chat-back`(5.10), `#chat-form` submit, `chatText` input/keydown(IME 검사 추가), `visibilitychange`(5.11) **재작성**; 신설 `#rail`(클릭 위임: `.rail-acct`→`selectRail`, `#rail-all`, `#rail-add`, `#rail-settings`), `#thread-settings`, `#settings-acct` change, `#chat-search` input/keydown, `#chat-unread` 클릭, `#chat-notice` 클릭 위임, `#chat-newpill`, `#chat-log` scroll, `popstate`, 문서 keydown(단축키) |
| 1290–1296 부트 | **수정** 5.12 |

### 8.2 반드시 남는 id·속성·문구 — 새 DOM에서의 위치

| 항목 | 새 위치 |
|---|---|
| `#login`, `#login-form`, `#key`, `#login-error` | `main > section#login.card`(마크업·문구 불변, `사용 기간이 시작됩니다` 포함) |
| `#app` | `main > div#app`(flex column) |
| `#who`, `#logout` | `header .bar > .top-side`(id·핸들러 불변) |
| `#runstate` | `#app` 첫 자식 `section.strip[aria-live=polite][hidden]` |
| `#tabs` + 8개 `.tab[data-tab]` + `.tval[data-sum]` | `#settings > .settings-side > nav#tabs[aria-label="관리 메뉴"]`(버튼 8개 순서·속성 불변) |
| `#account-block[data-tab=account][data-band=account]` | `#settings .panes` 첫 카드 |
| `#account-list`, `#add-form[data-reauth]`, `#email`, `#password`, `#add-error`, `#passcode`, `#code-title`, `#code`, `#code-left`, `#code-wait`, `#code-error`, `#force`, `#cancel-code` | `#account-block` 안, 기존 그대로 |
| `#detail` | `.panes > div#detail[hidden]`; 직계 자식 = `p#detail-where` + 카드 6개(JS가 `.row-actions`를 `#macro-title.parentNode` 앞에 삽입) |
| `#detail-where` | `#detail` 첫 자식(문구 `email · reasonText` 기존) |
| `#macro-form, #macro-on, #macro-message, #base-min, #random-min, #base-view, #images, #thumbs, #reload-rooms, #room-error, #rooms-open, #macro-error, #macro-title` | macro 카드 안, 불변 |
| `#visit-form, #visit-on, #visit-open, #visit-error, #visit-title` / `#cover-*` / `#profile-*` / `#reply-form, #reply-on, #reply-message, #reply-hours, #reply-error, #reply-title` / `#triggers, #add-trigger, #save-triggers, #snipe-error, #snipe-title` | 각 카드 안, 불변 |
| `section[data-tab="X"]` 7개 + `aria-labelledby="X-title"` | 설정 카드 6개 + `section#inbox[data-tab="chat"][aria-labelledby="chat-title"]` |
| `data-band` 7종 | 설정 카드 6개(`chat` 카드는 삭제, `--band-chat` 토큰은 탭 현재색에 계속 쓰임) |
| `#kkt` | `#inbox > div#kkt.kkt`(항상 표시, `data-view`는 `#console`로 이동) |
| `#chat-title` | `.kkt-list > .kkt-tools > h2#chat-title` |
| `#chat-reload` | `.kkt-tools > button#chat-reload.icon-btn` |
| `#chat-error[role=alert]` | `.kkt-list > p#chat-error.error` |
| `#chat-rooms[role=list]` | `.kkt-list > div#chat-rooms`; 행 `.kkt-row[data-id][data-device][data-key][aria-current]`, 배지 `.kkt-badge`(숫자만) |
| `#chat-back`, `#chat-head-ava`, `#chat-peer`, `#chat-head-sub` | `.kkt-room > .kkt-head` |
| `#chat-log[tabindex=0]` | `.kkt-room > div#chat-log.kkt-log`(**`aria-live` 제거** — 4.4의 명시적 이탈, 대체 `#chat-live`) |
| `#chat-note[role=status]` | `.kkt-room`, 로그와 폼 사이 |
| `#chat-form`, `#chat-text`, `#chat-send` | `.kkt-room > form#chat-form.kkt-compose`; `.kkt-compose.has-text` 토글 유지 |
| `.kkt-bubble` | 로그의 말풍선(`textContent` = 글 또는 `(label)`) |
| `html[lang=ko]`, `meta robots noindex`, `meta theme-color #eef1f4`, `a.skip[href="#main"]`, `main#main`, `nav.top-nav[aria-label="주요 메뉴"]` + `/panel[aria-current=page]`, 브랜드 `K bot` | 불변 |
| 캐시 버전 | `/panel.css?v=12`, `/panel.js?v=15` |
| 문구(html) | `오픈채팅방`(legend 4개), `들낙 방지`(탭·h2), `욕설 가리기`(탭·h2), `프로필 변경 감지`(h2), `항상 켜져 있다고 보장하지 않습니다`(`footer.limit`), `갠톡 자동응답`·`경쟁사 저격`(h2), `사용 기간이 시작됩니다`(로그인 힌트), `id="tabs"`, `data-tab="…"`·`data-sum="…"` 8종 |
| 부재(html) | `일반 채팅방`, `rooms-normal`, `visit-normal`, `오픈프로필로 온`(새 빈 상태 문구는 `오픈프로필 1:1 채팅(갠톡)이 오면`), `class="jumps"`, `class="pagehead"` |
| 문구(js) | `연결이 잠깐 끊겼습니다. 카카오톡 확인을 계속 기다립니다.`(`confirmLoop`), `대화방 목록을 가져오지 못했습니다. 잠시 뒤 다시 눌러 주세요.`(`reload-rooms`); 부재 `Load failed` |
| `routes/panel.js` | login~logout 구간 불변(`not_started`, `startPeriod(` 포함, `device_id` 없음) |

### 8.3 `lib/panel-check.js` 기존 단언 ↔ 새 DOM

| 줄 | 단언 | 충족 |
|---|---|---|
| 193–203 | login 구간 | 라우트 추가 위치가 구간 밖(6.1) |
| 206 | `연결이 잠깐 끊겼습니다…` | `confirmLoop` 유지 |
| 207 | `Load failed` 없음 | 새 코드의 모든 catch는 한국어 문구 |
| 208 | `대화방 목록을 가져오지 못했습니다. 잠시 뒤 다시 눌러 주세요.` | `reload-rooms` 유지 |
| 211–214 | `오픈채팅방` 있음 / `일반 채팅방`·`rooms-normal`·`visit-normal`·`오픈프로필로 온` 없음 | 8.2 |
| 215–217 | `id="visit-on"`+`들낙 방지`, `id="cover-on"`+`욕설 가리기`, `id="profile-on"`+`프로필 변경 감지` | 카드·탭 유지 |
| 218 | `항상 켜져 있다고 보장하지 않습니다` | `footer.limit`(`.panes` 끝) |
| 219–220 | `갠톡 자동응답`·`경쟁사 저격`, `사용 기간이 시작됩니다` | 유지 |
| 223–224 | `id="tabs"` 있음, `class="jumps"` 없음 | `#settings nav#tabs` |
| 225–228 | 8개 `data-tab=`·`data-sum=` | 탭 버튼 8개 + `#inbox[data-tab=chat]` + 카드 7개 |

### 8.4 CSS 접점

삭제: `.pagehead` 규칙(125–131, 535·539), `.shell`(874, 918), `.kkt-*` 블록 전체(587–871), `.card[data-band="chat"]` 폰 규칙(582–584), `.kkt { height: 74vh … }`(584). 이동: `@media (min-width: 900px)` 탭 블록(917–944) → `(min-width: 1024px)`, 그 안의 `.shell` 줄 삭제. 유지: `.card/.stack/.room/.trigger/.thumbs/.account/.where/.strip/.limit/.tabs/.tab/.tval/.tname/.panes`, 폼 규칙. 추가: 3장 토큰, 2장 레이아웃, 4장 컴포넌트(`.rail*`, `.kkt-*` 새 정의, `.thread-state`, `.chip`, `.icon-btn`, `.kkt-notice`, `.kkt-newpill`, `.kkt-count`, `.strip.down`, `.account-actions`, `.settings-side`, `.sr-only`, `body[data-screen]`).

---

## 9. 구현 순서 & 위험

### 9.1 순서

1. **서버**(12-a): `lib/panel-inbox.js` → `routes/panel.js`(`accountRows/forgetAccounts`, 라우트, `rememberAccount`·unlink 한 줄) → `package.json` check에 `node --check lib/panel-inbox.js` → `lib/panel-check.js` 서버 블록(11.1-A) → `npm run check` → `curl`(6.1).
2. **HTML**(12-b): 4.0 골격으로 재배치. `#login`·`#account-block`·설정 카드 6개·`footer.limit`은 잘라 붙이기. `.pagehead` 제거, `#who/#logout` 이동, `h1.sr-only`, viewport 메타, 캐시 버전. `npm run check`(기존 단언).
3. **panel-check 화면 블록**(11.1-B) 추가 → 이 시점부터 HTML 계약 고정.
4. **CSS**: 토큰 → `body[data-screen]`·`#app` 높이 → 콘솔 grid(2.1) → 레일 → 대화 열 → 대화 창·말풍선 → 입력창 → 설정 모드(`.tabs` 1024) → 태블릿 → 폰 → reduced-motion. `.kkt-*` 옛 블록 삭제는 새 블록이 끝난 뒤.
5. **JS 1차(모드)**: `showTab/setTabsEnabled/openAccount/refreshMe/showApp/showLogin/renderAccounts/chatReset/bootConsole`, 레일 렌더(`me` 기준), `#settings-acct`, `#rail-*` 리스너. 이 시점에 `profile.mjs`(수정본) 통과.
6. **JS 2차(받은함)**: `loadInbox/applyInbox/renderConvList/updateNotice/updateStrip/updateUnread/selectRail/startReauth`, 검색·안 읽음, 서명, 백오프, visibilitychange. 
7. **JS 3차(대화)**: `openConversation/closeConversation/loadThread/renderThread/sendChat`, `#chat-newpill`, `#chat-live`, `#chat-count`, popstate, 단축키. `behavior.mjs`(수정본) 통과.
8. **새 테스트** `inbox.mjs`(11.3) 작성·통과. 360×740 폰 검사 포함.
9. **문구 검수**: 4.9 표로 전수 대조.
10. 배포 뒤 Render 로그에서 `/panel/api/inbox` 소요 시간(p95) 확인. 10초를 넘기면 9.2 ①.

### 9.2 위험과 대응

| 위험 | 대응 |
|---|---|
| ① 한 계정의 `/v1/inbox`가 30초 동안 응답하지 않아 전체 폴링이 30초까지 늘어남 | `allSettled`라 다른 계정은 같은 응답에 실리지만 응답 자체는 늦다. 클라이언트 `busy`로 겹침 방지 + 백오프. p95가 나쁘면 이 라우트의 타임아웃만 12초로 내린다(그 계정은 `error`) |
| ② 9초 폴링이 DB를 깨움 | `session()`의 라이선스 조회는 기존 `/chats`도 하던 것. 계정 목록은 60초 임시 저장, 등록·해제 때 즉시 무효화 |
| ③ 한 계정 실패로 목록이 깜빡임 | `byDevice` 병합: `error`는 이전 성공분 유지, `needs_register`만 비움, `sender_down`은 전체 유지 |
| ④ 전송이 엉뚱한 계정으로 나감 | `chat.deviceId`는 `openConversation`에서 행의 `data-device`로만 설정. 전송 본문은 전송 시점 스냅샷. 머리에 `{email} 계정으로 답장` 상시 표시. 필터가 그 대화를 가리면 닫는다 |
| ⑤ `#tabs`가 inbox 모드에서 숨겨져 기존 테스트가 실패 | 11.2의 `#rail-settings` 클릭 삽입. 동작 단언은 불변 |
| ⑥ `showTab`의 `[data-tab]` 루프 | `#inbox`에 `data-tab="chat"`, `#settings.hidden`은 `showTab` 한 줄. 새 요소에 `data-tab`을 달지 않는다 |
| ⑦ 폰 `100dvh` 미지원 | `100vh` 선언 후 `@supports`로 덮어씀. 키보드가 뜨면 `#chat-text` focus 시 로그 바닥으로 |
| ⑧ `aria-live` 로그가 폴링마다 떠듦 | `#chat-log`에서 제거, `#chat-live`에 건수만(4.4) |
| ⑨ 한글 조합 중 Enter 조각 전송 | `isComposing`/`keyCode 229` |
| ⑩ 건너뛰기 링크의 해시 이동이 popstate로 대화를 닫음 | 5.10: `location.hash`가 있으면 무시 |
| ⑪ 옛 `.kkt-*` CSS 삭제로 설정 카드가 흔들림 | 설정 폼 규칙은 손대지 않고 587–871 블록만 교체. `.tabs` 기준만 900→1024 |
| ⑫ `/me`가 느림(계정별 snapshot 20초) | 부팅 1회 + 드문 갱신. 레일은 `me`로 먼저 그리고 `inbox` 첫 응답이 덮어쓴다 |
| ⑬ 로그아웃·해제 사이에 도착한 옛 `/inbox` 응답 | `inboxSt.seq` 비교 |
| ⑭ 계정 8개 레일 넘침 | `#rail-accounts` 세로 스크롤(스크롤바 숨김), 톱니는 아래 고정. 최대 8개라 사실상 넘치지 않는다 |

---

## 10. 수용 기준

각 항목은 Playwright(`PW=/opt/pw-browsers/chromium-1194/chrome-linux/chrome`) 또는 `curl`/`npm run check`로 합·불합이 갈린다. 표기: [DOM] [동작] [시각] [API] [문구].

1. [DOM] `cd /home/user/kakaotalk-macro && npm run check`가 `panel check ok`를 출력하고 종료 코드 0(11.1의 추가 단언 포함).
2. [DOM] `node --check public/panel.js` 종료 코드 0.
3. [동작] `behavior.mjs`(11.2 수정본) → `behavior: ALL PASS`, 종료 코드 0, `JS errors` 없음.
4. [동작] `profile.mjs`(11.2 수정본) → `profile tab: ALL PASS`, 종료 코드 0.
5. [동작] `inbox.mjs`(11.3) → `inbox: ALL PASS`, 종료 코드 0.
6. [동작] `node scratchpad/chat-smoke.mjs` 통과(sender 미변경 확인).
7. [DOM] `panel.html`에 `id="rail"`, `id="rail-all"`, `id="rail-accounts"`, `id="rail-add"`, `id="rail-settings"`, `id="inbox"`, `id="kkt"`, `id="chat-search"`, `id="chat-unread"`, `id="chat-notice"`, `id="settings-acct"`, `id="thread-state"`, `id="thread-settings"`, `id="chat-live"`, `id="chat-newpill"`, `id="chat-count"`, `data-mode="inbox"`, `data-view="list"`가 있고 `class="pagehead"`, `class="jumps"`, `data-band="chat"`가 없다.
8. [DOM] `#inbox`는 `<section data-tab="chat" aria-labelledby="chat-title">`이고, `document.querySelectorAll('[data-tab]:not(.tab)')`의 길이가 정확히 8(= `#inbox` + 카드 7개; JS 삽입 `.row-actions`를 더하면 9).
9. [DOM] `#detail`의 직계 자식 순서가 `#detail-where`, `.row-actions`(JS 삽입), macro, visit, cover, profile, reply, snipe 섹션이며 `#macro-title`의 부모가 `#detail`의 직계 자식.
10. [DOM] 설정 폼 id 52개(8.2 표의 `#macro-form`…`#snipe-error`, `#account-list`…`#cancel-code`)가 모두 존재하고 각각 1개.
11. [DOM] `html lang="ko"`, `meta[name=robots][content=noindex]`, `meta[name=theme-color][content="#eef1f4"]`, `a.skip[href="#main"]`, `main#main`, `nav.top-nav[aria-label="주요 메뉴"] a[href="/panel"][aria-current="page"]`, `.brand` 텍스트 `K bot`, `<title>관리 · K bot</title>`, `link[href="/panel.css?v=12"]`, `script[src="/panel.js?v=15"]`.
12. [동작] 계정 1개 `/me` → 로드 직후 `#console[data-mode="inbox"]`, `section[data-tab="chat"].hidden === false`, `#settings.hidden === true`, `#account-block.hidden === true`, `.tab[data-tab="chat"]`·`.tab[data-tab="account"]`는 `disabled === false`, 나머지 탭은 `disabled === true`.
13. [동작] 계정 0개 `/me` → 로드 직후 `#console[data-mode="settings"]`, `#account-block.hidden === false`, `#rail-all.disabled === false`; `#rail-all` 클릭 → inbox 모드에 `.kkt-empty` 제목 `등록된 계정 없음` + 버튼 `계정 등록`; 그 버튼 클릭 → `#account-block` 표시, (≥720px) `document.activeElement === #email`.
14. [동작] 어떤 경로로도 로드 직후 `#chat-peer.textContent === '선택한 대화 없음'`이고 `GET /panel/api/chat` 요청이 한 번도 나가지 않는다(대화 자동 열기 없음).
15. [동작] `#rail-settings` 클릭(계정 1개) → `GET /panel/api/account?device_id=…` 1회, `#console[data-mode="settings"]`, `.tab[data-tab="macro"][aria-current="true"]`, `section[data-tab="macro"].hidden === false`, `#settings-acct.value === device_id`, `document.activeElement === .tab[data-tab="macro"]`.
16. [동작] `.tab[data-tab="chat"]` 클릭 → inbox 모드 복귀, `.tab[data-tab="chat"][aria-current="true"]`, 열려 있던 대화가 있으면 `GET /panel/api/chat` 즉시 1회.
17. [동작] 계정 3개(A·B live, C needs_register), 전체 필터: `.kkt-row` 수 = A·B chats 합, `last_at` 내림차순; 각 행에 `.kkt-acc` 칩이 있고 텍스트가 그 행 `data-device` 계정의 이메일; `#rail-accounts .rail-acct` 3개, C는 `data-state="needs_register"`; `#rail-all .rail-badge.textContent` = 전체 안 읽음 합.
18. [동작] `#chat-notice`가 보이고(`hidden === false`) `.kkt-notice-title.textContent === '확인이 필요한 계정 1개'`, 행 텍스트 `C이메일 · 등록 필요`, 버튼 `등록`; 클릭 → settings 모드 계정 탭, `#add-form.dataset.reauth === '1'`, `#email.value === C이메일`.
19. [동작] 레일 B 클릭 → `ui` 필터: `#chat-title.textContent === B이메일`, `.kkt-row`가 B의 것만, `.kkt-acc` 없음, `.rail-acct[data-device=B][aria-current="true"]`, 네트워크 요청 없음(캐시 재필터).
20. [동작] B의 행 클릭 → `#chat-head-sub.textContent === B이메일 + ' 계정으로 답장'`, `#thread-state.textContent === '접속 중'`, `#thread-settings.hidden === false`; `#chat-text`에 입력 후 `#chat-send` → `POST /panel/api/chat/send` 본문 `{device_id: B, chat_id: '<그 행 data-id>', text}` (chat_id는 bare 문자열).
21. [동작] 대화 열린 채 레일 `전체` 클릭 → 대화 유지(`#chat-peer` 불변, `.kkt-row[aria-current="true"]` 존재); 레일 A 클릭 → 대화 닫힘(`#chat-peer === '선택한 대화 없음'`, `#chat-text.disabled === true`, `#chat-text.value === ''`).
22. [동작] `/inbox`가 B를 `status:'error'`로 돌려주면 다음 렌더에서 B의 행이 **그대로 남고** `.rail-acct[data-device=B][data-state="error"]`, `#chat-notice`에 `B이메일 · 응답 없음`(버튼 없음).
23. [동작] `/inbox`가 `sender_up:false`를 돌려주면 `#runstate.hidden === false`, `classList.contains('down')`, `.strip-text` = `sender_reason`(비면 `발송 작업이 멈춰 있습니다. 작업이 다시 시작되면 저장된 계정으로 이어서 접속합니다.`); `.kkt-row` 수 불변(마지막 목록 유지); 열린 대화의 `#chat-text.disabled === true`, placeholder `발송 작업 중지`; 모든 `.rail-dot` 부모가 `data-state="sender_down"`. 다시 `sender_up:true`가 오면 `#runstate.hidden === true`.
24. [동작] `/inbox`가 3회 연속 실패(HTTP 500)하면 `#chat-error.textContent === '대화 목록을 불러오지 못했습니다. 잠시 뒤 새로고침을 눌러 주세요.'`이고 다음 요청 간격이 20초(실패 3회 뒤 15초 동안 요청 없음); 401이면 `#login.hidden === false`.
25. [동작] `#chat-unread` 클릭 → `aria-pressed="true"`, `.kkt-row`가 `unread > 0`인 것만(열린 대화 제외); 모두 읽었으면 `.kkt-empty` 제목 `안 읽은 대화 없음`.
26. [동작] `#chat-search`에 이름 일부 입력 → 150ms 뒤 일치 행만; 비우면 전부; 일치 없음 → `.kkt-empty` 제목 `검색 결과 없음`. 검색 중에도 열린 대화는 닫히지 않는다.
27. [동작] 대화를 연 뒤 `document.title`이 `(N) 관리 · K bot`(N = 열린 대화 제외 전체 안 읽음, 0이면 `관리 · K bot`), `.tab[data-tab="chat"] .tval` = `안 읽음 N` 또는 `대화 N개`.
28. [동작] 폴링 응답에 새 `log_id`가 추가되면 `#chat-live.textContent`가 `새 메시지 {n}건 · {peer}`로 바뀌고, 로그가 바닥에서 70px 넘게 떨어져 있었으면 `#chat-newpill.hidden === false`; 클릭 → `scrollTop` 바닥, `hidden === true`.
29. [동작] `#chat-text`에 900자 입력 → `#chat-count.hidden === false`, 텍스트 `900/1,000`; `maxlength="1000"`.
30. [동작] IME 조합 중(`keydown` `isComposing:true`) Enter → 전송 요청 없음.
31. [동작] `visibilitychange`로 숨겼다 보이면 즉시 `GET /panel/api/inbox` 1회(+ 열린 대화면 `/chat` 1회); 숨긴 시간이 5분을 넘었으면 `GET /panel/api/me`도 1회.
32. [동작] 등록 완료(모의 `register/begin` → `state:'ok'`) 뒤 `GET /panel/api/me` → inbox 모드, `.rail-acct[data-device=새 device][aria-current="true"]`, `#chat-title` = 새 계정 이메일.
33. [동작] 폰 360×740, 계정 2개: `document.documentElement.scrollWidth <= 360`; `#rail`의 `offsetWidth > offsetHeight`(가로 줄)이고 `offsetHeight >= 44`; `.rail-btn`, `.kkt-row`, `#chat-reload`, `#chat-search`, `#chat-send`, `#chat-back`, `.tab`, `#chat-unread`의 `getBoundingClientRect().height >= 44`; 행 클릭 → `#console[data-view="room"]`, `.kkt-list`·`#rail`의 `display === 'none'`, `#chat-back` 보임; `#chat-back` 클릭 → `data-view="list"`; `history.back()`도 같은 결과; `a.skip` 클릭(해시 `#main`)은 열린 대화를 닫지 않는다.
34. [동작] 폰 settings 모드(`#rail-settings`는 폰 가로 레일 끝에 있음): `#rail` `display === 'none'`, `.settings-side`가 `.panes` 위, `.tab[data-tab="chat"]` 클릭으로 inbox 복귀.
35. [시각] 940×820(태블릿): `#rail.offsetWidth === 64`, `.kkt-list.offsetWidth === 272`; 1280×900: `#rail.offsetWidth === 72`, `.kkt-list.offsetWidth === 352`, `#settings` 설정 모드에서 `.tabs`의 `flex-direction === 'column'`; 940에서는 `'row'`.
36. [시각] `getComputedStyle(#rail).backgroundColor === 'rgb(15, 31, 25)'`, `.kkt-line.me .kkt-bubble` 배경 `rgb(220, 239, 228)`, `.kkt-at` 색 `rgb(95, 107, 121)`, `.kkt-badge` 배경 `rgb(208, 48, 58)`, `.tab[aria-current="true"]` 색은 기존 규칙(`--band-chat`/`--ok-bg`).
37. [시각] `#chat-log` 안에 `.kkt-ava-sm`·`.kkt-who`가 없다(1:1 로그에 상대 아바타·이름 없음).
38. [시각] `prefers-reduced-motion: reduce` 에뮬레이션에서 `.kkt-line.enter`의 `animationName === 'none'`.
39. [API] `curl` 401(쿠키 없음) → `{"ok":false,"error":"다시 로그인해 주세요."}`; 로그인 뒤 200 응답이 6.1 스키마(필드 이름·타입)와 일치: `accounts[].status ∈ {live,needs_register,error,sender_down}`, `connected ∈ {true,false,null}`, `chats[]`가 `last_at desc, unread desc`, 모든 `chats[].list_kind === 'open_dm'`, `chats[].chat_id`가 문자열.
40. [API] `lib/panel-check.js`의 `mergeInbox` 단언(11.1-A) 통과: open_room 행 제거, needs_register·timeout·sender_down 매핑, 병합 정렬, `senderUp:false` 처리.
41. [API] `routes/panel.js`에서 `router.get('/panel/api/inbox'`가 `router.get('/panel/api/chats'`보다 앞에 있고, 그 사이 텍스트에 `allSettled`·`accountRows(`가 있으며 `snapshot(`이 없다; `forgetAccounts(`가 3회 이상(정의 + rememberAccount + unlink); login~logout 구간 기존 단언 통과.
42. [API] 같은 키로 `/panel/api/inbox`를 60초 안에 두 번 부르면 `panel_accounts` SELECT가 1회(DB 로그 또는 `db.q` 스파이); 등록/해제 직후 호출은 다시 SELECT.
43. [문구] `panel.js`·`panel.html`에 U+1F300–U+1FAFF 범위 글자 없음; `대화를 고르세요`, `먼저 인사를 보내 보세요`, `불러오는 중…`, `발송 프로세스`(새 코드 — 기존 `reasonText`·`showApp` 옛 문구는 삭제됨, `loadChatList` 삭제) 없음; `panel.js`에 `설정 › 계정에서 다시 등록해 주세요.`, `device_id: chat.deviceId`, `/panel/api/inbox` 있음, `/panel/api/chats?` 없음.
44. [문구] 4.9 표의 모든 문구가 화면 소스에 그대로 있고(동적 부분 제외), `~해`·`~야`·`~줘`·`!`로 끝나는 UI 문자열이 새 코드에 없다(검토자 수동 대조).
45. [문구] 상태 라벨 5종이 레일 툴팁·aria-label·`#thread-state`·`#chat-notice`에서 동일한 단어를 쓴다(`접속 중`/`연결 대기`/`등록 필요`/`응답 없음`/`발송 중지`).

---

## 11. 테스트 변경

### 11.1 `lib/panel-check.js`

**A. 서버 블록** — 203행(`assert(!/device_id/.test(loginSrc) …)`) 바로 뒤, `const panelJs = …` 앞에 삽입(백엔드 담당):

```js
// ── 통합 받은함 서버 (docs/UI_V4.md 6.1 · 11.1-A)
const inboxLib = require('./panel-inbox');
const inboxRows = [
  { device_id: 'd1', email: 'a@x' }, { device_id: 'd2', email: 'b@x' },
  { device_id: 'd3', email: 'c@x' }, { device_id: 'd4', email: 'd@x' },
];
const inboxSettled = [
  { status: 'fulfilled', value: { status: 200, json: { ok: true, chats: [
    { chat_id: '5', list_kind: 'open_dm', name: '김', preview: 'p', unread: 2, last_at: 100 },
    { chat_id: '6', list_kind: 'open_room', name: '방', preview: '', unread: 9, last_at: 999 },
  ] } } },
  { status: 'fulfilled', value: { status: 409, json: { ok: false, error: 'kicked', needs_register: true } } },
  { status: 'rejected', reason: new Error('timeout') },
  { status: 'fulfilled', value: { status: 200, json: { ok: true, connected: false, chats: [
    { chat_id: 7, list_kind: 'open_dm', name: '이', preview: 'q', unread: '0', last_at: 200 },
  ] } } },
];
const mergedInbox = inboxLib.mergeInbox(inboxRows, inboxSettled, true);
assert(mergedInbox.accounts.length === 4, 'every account is reported');
assert(mergedInbox.accounts[0].status === 'live' && mergedInbox.accounts[0].unread === 2 && mergedInbox.accounts[0].chats === 1,
  'open_room rows are dropped from the unified inbox');
assert(mergedInbox.accounts[0].connected === null, 'connected is null unless the sender says');
assert(mergedInbox.accounts[1].status === 'needs_register' && mergedInbox.accounts[1].reason === 'kicked'
  && mergedInbox.accounts[1].error === '카카오 로그인이 끊겼습니다. 계정을 다시 등록해 주세요.', 'needs_register account');
assert(mergedInbox.accounts[2].status === 'error' && mergedInbox.accounts[2].reason === 'timeout'
  && mergedInbox.accounts[2].error === '대화 목록을 가져오지 못했습니다.', 'timed out account is an error, not a failure');
assert(mergedInbox.accounts[3].status === 'live' && mergedInbox.accounts[3].connected === false, 'sender connected flag is passed through');
assert(mergedInbox.chats.length === 2 && mergedInbox.chats[0].chat_id === '7' && mergedInbox.chats[0].device_id === 'd4'
  && mergedInbox.chats[0].unread === 0 && mergedInbox.chats[1].device_id === 'd1', 'chats merged across accounts, newest first, normalized');
const inboxDown = inboxLib.mergeInbox(inboxRows, [], false);
assert(inboxDown.accounts.every(function (a) { return a.status === 'sender_down'; }) && inboxDown.chats.length === 0, 'sender down marks every account');
const senderDownErr = new Error('sender_down'); senderDownErr.code = 'sender_down';
assert(inboxLib.mergeInbox([inboxRows[0]], [{ status: 'rejected', reason: senderDownErr }], true).accounts[0].status === 'sender_down',
  'a sender_down rejection is not shown as a list failure');

const inboxStart = src.indexOf("router.get('/panel/api/inbox'");
const inboxEnd = src.indexOf("router.get('/panel/api/chats'");
assert(inboxStart > 0 && inboxEnd > inboxStart, 'unified inbox route sits before the per-account chats route');
const inboxSrc = src.slice(inboxStart, inboxEnd);
assert(/allSettled/.test(inboxSrc) && /accountRows\(/.test(inboxSrc) && !/snapshot\(/.test(inboxSrc),
  'inbox fans out once per account from the cached account rows');
assert(inboxStart > end, 'inbox route is outside the login slice');
assert((src.match(/forgetAccounts\(/g) || []).length >= 3, 'account cache is dropped on register and unlink');
```

**B. 화면 블록** — 228행(`});` forEach 끝) 뒤, `process.stdout.write` 앞에 삽입(프런트엔드 담당):

```js
// ── 통합 받은함 화면 (docs/UI_V4.md 4장 · 11.1-B)
['id="rail"', 'id="rail-all"', 'id="rail-accounts"', 'id="rail-add"', 'id="rail-settings"',
 'id="inbox"', 'id="kkt"', 'id="chat-search"', 'id="chat-unread"', 'id="chat-notice"',
 'id="settings-acct"', 'id="thread-state"', 'id="thread-settings"', 'id="chat-live"',
 'id="chat-newpill"', 'id="chat-count"', 'data-mode="inbox"', 'data-view="list"',
 'id="chat-title"', 'id="chat-reload"', 'id="chat-note"', 'id="chat-back"',
 '/panel.css?v=12', '/panel.js?v=15'].forEach(function (s) {
  assert(html.indexOf(s) >= 0, 'unified console markup: ' + s);
});
assert(html.indexOf('class="pagehead"') < 0, 'page head is folded into the bar');
assert(html.indexOf('data-band="chat"') < 0, 'single-account chat card is gone');
assert(html.indexOf('대화를 고르세요') < 0 && panelJs.indexOf('대화를 고르세요') < 0, 'polite-imperative placeholder is gone');
assert(panelJs.indexOf('먼저 인사를 보내 보세요') < 0 && panelJs.indexOf('불러오는 중…') < 0, 'friendly thread copy is gone');
assert(!/[\u{1F300}-\u{1FAFF}]/u.test(panelJs) && !/[\u{1F300}-\u{1FAFF}]/u.test(html), 'no emoji decoration');
assert(panelJs.indexOf('/panel/api/inbox') >= 0, 'client polls the unified inbox');
assert(panelJs.indexOf('/panel/api/chats?') < 0, 'per-account chat list is no longer polled');
assert(panelJs.indexOf('device_id: chat.deviceId') >= 0, 'reply is sent from the conversation owner account');
assert(panelJs.indexOf('설정 › 계정에서 다시 등록해 주세요.') >= 0, 'needs_register points to the account tab');
assert(panelJs.indexOf('선택한 대화 없음') >= 0 && panelJs.indexOf('계정으로 답장') >= 0, 'thread header copy');
assert(panelJs.indexOf('발송 프로세스') < 0 || panelJs.indexOf('발송 프로세스') === panelJs.lastIndexOf('발송 프로세스'),
  'new copy says 발송 작업; only the kept reasonText() may still say 발송 프로세스');
```

(`reasonText()`는 KEEP 범위라 `발송 프로세스가 멈춰 있습니다`가 1회 남는다. `showApp`·`loadChatList`의 옛 문구는 삭제되므로 마지막 단언이 그 삭제를 보증한다.)

**C. `package.json`** `check`에 `node --check lib/panel-inbox.js &&`를 `node --check lib/panel-ids.js` 뒤에 추가.

### 11.2 기존 Playwright 테스트 수정

**`behavior.mjs`**

1. 39행 `else if (u.includes('/chats')) b = { ok: true, chats: state.chats }` 을 다음으로 교체:
   ```js
   else if (u.includes('/inbox')) b = { ok: true, sender_up: true, sender_reason: '', at: T,
     accounts: [{ device_id: DEV, email: 'x', status: 'live', reason: '', connected: true,
       unread: state.chats.reduce((n, c) => n + c.unread, 0), chats: state.chats.length, error: '' }],
     chats: state.chats.map(c => ({ ...c, device_id: DEV, email: 'x' })) }
   ```
   (`/me` 분기 다음, `/account`·`/chat/send`·`/chat` 분기 앞. `'/panel/api/inbox'`는 `/me`·`/account`·`/chat`을 포함하지 않는다.)
2. 56행 `await pg.getByRole('button', { name: '열기' }).first().click()` 삭제. 57행 `waitForSelector('.kkt-row')` 유지.
3. 1)~6) 불변(`.kkt-row`, `#chat-reload`, `.kkt-badge`, `.kkt-bubble`, `#chat-peer`, `#chat-text`, `#chat-send` 그대로).
4. 7) 첫 단언(114–118행) 불변. 120행 `await pg.locator('.tab[data-tab="macro"]').click()` **앞**에 삽입:
   ```js
   await pg.click('#rail-settings')
   await pg.waitForSelector('.tab[data-tab="macro"]')
   ```
   이후 단언(122–127행) 불변.
5. 8) 불변.

**`profile.mjs`**

1. 39행 `else if (u.includes('/chats')) b = { ok: true, chats: [] }` 을 다음으로 교체(`/account` 다음, `/chat` 앞):
   ```js
   else if (u.includes('/inbox')) b = { ok: true, sender_up: true, sender_reason: '', at: T,
     accounts: [{ device_id: DEV, email: 'x', status: 'live', reason: '', connected: true, unread: 0, chats: 0, error: '' }], chats: [] }
   ```
2. 46행 `await pg.getByRole('button', { name: '열기' }).first().click()` 을 다음으로 교체:
   ```js
   await pg.waitForSelector('#rail-accounts .rail-acct')
   await pg.click('#rail-settings')
   ```
   47행 `waitForSelector('.tab[data-tab="profile"]')` 유지.
3. 1)~5) 불변.

### 11.3 신규 `scratchpad/inbox.mjs` 개요

같은 정적 서버·route 골격. 상수: `DEV_A='wabc0123def4.0000000000000001'`, `DEV_B='wabc0123def4.0000000000000002'`, `DEV_C='wabc0123def4.0000000000000003'`, 이메일 `a@x`/`b@x`/`c@x`. 상태 객체 `state = { senderUp: true, status: { A:'live', B:'live', C:'needs_register' }, chats: { A:[{chat_id:'5',name:'김민수',preview:'입금했어요',unread:2,last_at:T-60000},{chat_id:'6',name:'박지훈',preview:'감사합니다',unread:0,last_at:T-7200000}], B:[{chat_id:'9',name:'이영희',preview:'거래 되나요?',unread:1,last_at:T-120000}], C:[] }, threads: {...}, inboxFail: 0, sends: [] }`. `/inbox` 모의는 `state`로 6.1 스키마를 조립(`status:'error'`인 계정의 chats는 싣지 않음, `senderUp:false`면 모두 `sender_down`·`chats:[]`), `/chat/send`는 본문을 `state.sends`에 push, `/account`는 device별 계정 객체, `/me`는 3계정, `/register/begin`은 `{ok:true,state:'ok',device_id:DEV_D}`(32번용). 요청 로그 `reqs[]`를 쌓아 "요청 없음/1회" 단언에 쓴다.

순서(각 단계는 10장 번호를 가리킨다):
1. 1280×900 부팅 → 12·14·17 단언.
2. 18 (`#chat-notice` + `등록` → 계정 탭·reauth).
3. `.tab[data-tab="chat"]` 클릭 → 16; 레일 B → 19.
4. B 행 열기 → 20 (`state.sends[0].device_id === DEV_B && chat_id === '9'`).
5. 레일 전체 → 대화 유지, 레일 A → 닫힘 → 21.
6. `state.status.B='error'` + `#chat-reload` → 22; `state.senderUp=false` + reload → 23; 복구 → `#runstate.hidden`.
7. `state.inboxFail=3`(500 응답) + reload ×3 → 24(간격은 `reqs` 타임스탬프로 15초 동안 없음 확인, `waitForTimeout(15500)`); 401 → 로그인 카드.
8. 재부팅(새 컨텍스트) → 25·26·27.
9. 대화 열고 스크롤 위로 올린 뒤 `state.threads` 추가 + 3.5초 대기 → 28; 900자 입력 → 29; `isComposing` Enter → 30.
10. `pg.evaluate`로 `document.hidden` 흉내(visibilitychange 디스패치 + `hiddenAt` 조작) → 31.
11. 등록 플로우(`#rail-add` → 폼 제출) → 32.
12. 새 컨텍스트 360×740 → 33·34 (`scrollWidth`, 44px 전수, `data-view`, `history.back()`, `a.skip`).
13. 새 컨텍스트 940×820 / 1280×900 → 35·36·37; `emulateMedia({reducedMotion:'reduce'})` → 38.
14. 계정 0개 컨텍스트 → 13.
출력 `inbox: ALL PASS`, 실패·pageerror·console.error 시 종료 코드 1.

---

## 12. 구현 분담

두 작업은 아래 계약만 보고 **대화 없이 병렬**로 진행한다. 합류 지점은 `lib/panel-check.js`(A·B 블록이 서로 다른 위치) 와 `npm run check`.

### 12-a 백엔드 (`routes/panel.js`, `lib/panel-inbox.js`, `lib/panel-check.js` A블록, `package.json`)

1. `lib/panel-inbox.js` — 6.1의 코드 그대로(`mergeInbox`, 문구 상수 2개).
2. `routes/panel.js` — `require('../lib/panel-inbox')`; `accountRows/forgetAccounts`; `GET /panel/api/inbox`(`ownsDevice()` 아래, `/panel/api/chats` 위); `rememberAccount`·unlink에 `forgetAccounts` 한 줄. login~logout 구간 불변.
3. `package.json` check에 `node --check lib/panel-inbox.js`.
4. `lib/panel-check.js` A블록(11.1-A), 203행 뒤.
5. 검증: `npm run check` → `panel check ok`; `curl`(6.1); sender 중지 상태(`SENDER_*` 환경 없이 기동)에서 `/inbox`가 200 `sender_up:false`.
6. 완료 산출물: 위 네 파일. 프런트엔드가 쓰는 것은 6.1 응답 스키마뿐.

### 12-b 프런트엔드 (`public/panel.html`, `public/panel.css`, `public/panel.js`, `lib/panel-check.js` B블록, `scratchpad/behavior.mjs`·`profile.mjs`·`inbox.mjs`)

1. `panel.html` 4.0~4.7 골격(설정 카드는 잘라 붙이기), 캐시 버전 `css v=12`/`js v=15`.
2. `panel.css` 3장 토큰 + 2장 레이아웃 + 4장 컴포넌트, 8.4의 삭제·이동.
3. `panel.js` 8.1 표대로: KEEP 범위는 한 글자도 바꾸지 않고, 수정 범위는 5.12, 채팅 블록은 5장으로 교체.
4. `lib/panel-check.js` B블록(11.1-B), 228행 뒤.
5. 테스트: 11.2 수정, 11.3 신규. 서버 없이 모의 응답만으로 돈다(아래 고정 응답을 모의에 그대로 쓴다).
6. 검증: `npm run check`(B블록 — A블록이 아직 없으면 그 부분만 실패하는 것이 정상), `node --check public/panel.js`, 세 Playwright 스크립트 `ALL PASS`, 10장 33~38 수동 확인.

### 12-c 양쪽이 공유하는 고정 응답 (모의 응답 = 서버 기대값)

```json
GET /panel/api/inbox  →  200
{ "ok": true, "sender_up": true, "sender_reason": "", "at": 1759900000000,
  "accounts": [
    { "device_id": "wabc0123def4.0000000000000001", "email": "a@x", "status": "live", "reason": "", "connected": null, "unread": 2, "chats": 2, "error": "" },
    { "device_id": "wabc0123def4.0000000000000002", "email": "b@x", "status": "live", "reason": "", "connected": null, "unread": 1, "chats": 1, "error": "" },
    { "device_id": "wabc0123def4.0000000000000003", "email": "c@x", "status": "needs_register", "reason": "kicked", "connected": null, "unread": 0, "chats": 0, "error": "카카오 로그인이 끊겼습니다. 계정을 다시 등록해 주세요." }
  ],
  "chats": [
    { "device_id": "wabc0123def4.0000000000000001", "email": "a@x", "chat_id": "5", "list_kind": "open_dm", "name": "김민수", "preview": "입금했어요", "unread": 2, "last_at": 1759899940000 },
    { "device_id": "wabc0123def4.0000000000000002", "email": "b@x", "chat_id": "9", "list_kind": "open_dm", "name": "이영희", "preview": "거래 되나요?", "unread": 1, "last_at": 1759899880000 },
    { "device_id": "wabc0123def4.0000000000000001", "email": "a@x", "chat_id": "6", "list_kind": "open_dm", "name": "박지훈", "preview": "감사합니다", "unread": 0, "last_at": 1759892800000 }
  ] }

GET /panel/api/inbox (sender 중지)  →  200
{ "ok": true, "sender_up": false, "sender_reason": "발송 작업이 아직 뜨지 않았습니다.", "at": 1759900000000,
  "accounts": [ { "device_id": "…0001", "email": "a@x", "status": "sender_down", "reason": "sender_down", "connected": null, "unread": 0, "chats": 0, "error": "" }, … ],
  "chats": [] }

GET /panel/api/inbox (쿠키 없음)  →  401  { "ok": false, "error": "다시 로그인해 주세요." }
GET /panel/api/chat?device_id&chat_id, POST /panel/api/chat/send {device_id, chat_id, text}, GET /panel/api/me, GET /panel/api/account?device_id, POST /panel/api/settings, /register/*, /unlink, /rooms  →  기존 계약 그대로
```

클라이언트 규칙 요약(양쪽 공통 이해): 대화 식별자 = `device_id + '/' + chat_id`; 전송 `device_id`는 항상 열린 대화의 `device_id`; `status`가 `error`인 계정은 응답에 chats가 없으므로 클라이언트가 이전 성공분을 유지한다; `sender_up:false`면 클라이언트는 목록을 비우지 않는다; `connected`가 `null`이면 `/me`의 `connected`로 `연결 대기`를 판단한다.
---

## 13. 구현 메모 (2026-10-08, 명세와 다른 점)

구현하면서 명세와 달리 한 것. 이유가 있어 바꾼 것이니 되돌리지 않는다.

| 항목 | 명세 | 구현 | 이유 |
|---|---|---|---|
| 11.1-A 서버 단언 | `lib/panel-check.js` 안 | `lib/panel-inbox-check.js`(별도 파일, `npm run check`에 연결) | 백엔드·프런트가 같은 파일을 동시에 고치지 않게 |
| 머리글 폭 | `.bar` 1060px 그대로 | `body[data-screen="app"] .bar { width: min(1480px, 100%); padding: 0 12px }` | 콘솔(#app 1480px) 왼쪽 끝과 브랜드가 한 줄에 서게 |
| 대화 열 때 배지 | 다음 렌더에서 사라짐(5.8) | `markOpenRow()`가 열린 행의 `.kkt-badge`·`.unread`를 바로 거두고, `openConversation()`이 `renderRail()`을 불러 레일 배지도 즉시 맞춤 | `안 읽음` 칩·문서 제목과 레일 숫자가 9초 동안 어긋나 보이는 것을 막음 |
| `refreshMe()` | `loadInbox(true)`만 | 아직 부팅 전이면 `bootConsole()`(로그인 폼 → 콘솔) | 로그인 핸들러가 KEEP 범위라 부팅 지점이 여기뿐 |
| `openAccount(id)` 탭 없음 | `selectRail` → `showTab('chat')` | `showTab('chat')` → `selectRail(id)` | `selectRail`의 설정 모드 분기가 `openAccount`를 다시 부르는 것을 피함 |
| 레일 툴팁 | `position:absolute` | `@supports(anchor-name)`면 anchor positioning(`position:fixed`) | `#rail-accounts`의 `overflow-y:auto`가 툴팁을 자르지 않게. 미지원 브라우저는 명세대로(계정 툴팁은 잘릴 수 있음, aria-label은 그대로) |
| 입력창 테두리 | 1px border | `border:0` + 포커스 링 `box-shadow` | 높이를 정확히 44px로 |
| `.rail-dot` / `#thread-state` | 12px / `2px 10px` | 14px(테두리 3 + 속 8) / 높이 26px | 1x 화면에서 점이 읽히게, 56px 머리 안에서 세로 가운데 |
| `.rail-badge` 글자 | `11px/18px` | `11px/14px` + `box-sizing:border-box` | 테두리 포함 18px를 지켜 아바타 글자를 덮지 않게 |
| `.who` | 항상 | 400px 미만에서 숨김 | 360px 폰에서 브랜드·메뉴·나가기와 겹침 |
| 추가 규칙 | — | `.btn.sm`(34px, 폰 44px), `.account-actions`, 스크롤 상자 `position:relative` | 명세 마크업이 쓰는 클래스에 규칙이 없었음 / 숨은 file input이 폰 설정 화면을 늘리던 문제 |
| 계정 목록 행 | `열기` | `채팅` / `설정` 두 버튼 | 4.6 |

검증 기록: `npm run check`(inbox check ok · panel check ok), `sender npm run check`, `node --check public/panel.js`, Playwright `behavior.mjs`·`profile.mjs`·`inbox.mjs`(수용 기준 12~38)·`shots.mjs` 전부 통과. 라이브 `curl`(39·42)은 이 컨테이너에 DB·sender 환경이 없어 `routes/panel.js`를 express·db·sender 스텁으로 띄운 인프로세스 하네스로 대신 확인했다.
