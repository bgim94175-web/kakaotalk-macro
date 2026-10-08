# K bot 다크 테마 v1 — 최종 디자인·구현 명세 (DARK_V1)

> 저장 위치 `docs/DARK_V1.md`. 대상: `public/style.css`(홈·구매·내 키·주문) + `public/panel.css`(관리 콘솔) + 5개 HTML meta + `public/app.js` 643행 + 고정 테스트 값.
> 출발점은 심사 1위 **안 C(카카오톡 다크 친숙형)**: 민트 단색 내 말풍선, `--ease-pop` 탄성 마이크로 인터랙션, `.hero` 거터 버그 수정, 앰버 왼쪽 띠, transform-only 펄스 링, 폰 완성도. 여기에 심사위원이 가져오라고 한 것을 접목했다 — **A**의 4단 엘리베이션 팔레트(#0B0E13→#121620→#181D28→#1F2531, 파비콘 남색과 같은 온도)·`--sh-inset-top` 유리 모서리·레일 선택 막대 `scaleY/scaleX`·placeholder 전용 토큰·글로우 예산 규칙·`.kkt-log` 점 격자·불투명 hex 고정값 규칙, **B**의 머리글 아래 1px 빛줄·nav 밑줄 `scaleX`·`main{overflow-x:clip}`·켜진 토글의 어두운 손잡이·배지 대비 5.09 빨강.
> 심사위원이 지적한 C의 약점은 전부 고쳤다: 따뜻한 갈색 바탕이 파비콘(#151D29)과 온도가 다름 → A의 블루-블랙 사다리로 교체 / overlay 위 placeholder 4.33 → 포커스 면 #1F2531 위 5.08 / 툴팁이 페이지보다 어두운 엘리베이션 역전 → `--rail-tip-bg #232A37`(가장 밝은 층) / 배지·칩·말풍선 글로우 → 전부 평면 / 레일 막대 height 트랜지션 → `scaleY` / `.kkt-line.enter` 의 `--i` 미정 → 지연 없음(새 줄은 한 번에 몇 개뿐) / 배지 pop 의 JS 훅 → CSS-only(`.kkt-row.bump .kkt-badge`).
> 원칙: **재스킨 + 모션 레이어.** 기존 id / class / data 속성 / DOM / `panel.js` `app.js` 로직은 그대로. 마크업은 meta 2줄과 캐시 버전만 바꾼다. 문구 변경 없음(TONE.md 적용 대상 없음). 브랜드 `K bot`·파비콘 그대로.

---

## 1. 무드·원칙

**파비콘이 그대로 화면이 된 밤.** 바닥은 순흑이 아니라 파랑이 아주 살짝 섞인 차콜(`#0B0E13`)이고, 그 위에 `#121620 → #181D28 → #1F2531 → #232A37` 네 단계로 조금씩 밝아지는 면이 겹친다. 선은 흰색 8%/14% 알파 헤어라인이라 "선이 보이는 게 아니라 면이 갈리는" 느낌이고, 모든 카드·버튼·아바타 윗변에 1px 흰 빛(`inset 0 1px 0 rgba(255,255,255,.06)`)이 얹혀 유리처럼 모서리가 선다. 색은 파비콘의 민트(`#3DDC97`) 하나가 주인이고 시안(`#4CC3F5`)은 링크·정보에만 쓴다. 민트는 **"내가 한 일 / 지금 보는 것 / 눌러야 할 것"** 에만 허락된다 — 내 말풍선(민트 단색 + 짙은 글자 10.87:1), 켜진 토글, 주 버튼, 현재 레일·현재 탭, 포커스 링. 빛(민트 알파 글로우)은 화면당 세 개를 넘지 않고, 나머지는 전부 평평하다. 움직임은 6~10px 슬라이드와 1~2px 리프트, 120–320ms, `transform`/`opacity` 뿐이며, 배지·토글·체크박스만 살짝 넘치는 탄성(`--ease-pop`)으로 "손에 붙는다". 지금의 밋밋함은 초록이 흐릿하고 모든 면이 같은 밝기여서다; 이 안은 깊이(엘리베이션)·절제된 빛(위계)·정확한 움직임(반응)으로 "멋있고 예쁘다"를 만든다.

규칙:
1. **순흑 금지.** 큰 면에 `#000` 없음. 가장 어두운 면은 `#0B0E13`(page·rail), 가장 밝은 면은 `#232A37`(툴팁). 층이 높을수록 밝다 — 예외 없음(툴팁 > 토스트 > 포커스 입력 > 입력 > 카드 > 페이지).
2. **선은 흰 알파.** 테두리는 `rgba(255,255,255,.08|.14|.22)` 세 단계만. 색 테두리는 상태(선택 민트 `.28`, 경고 앰버 `.26`, 오류 빨강 `.28`)에만.
3. **글자 대비.** 본문·보조·muted 글자는 각자 실제로 놓이는 면에서 ≥4.5:1(2장 표에서 전부 계산, 최저 4.57). placeholder 는 전용 토큰 `--ph` 로 분리하되 본문에는 쓰지 않는다. 민트 위 글자는 흰색이 아니라 `#06110C`(10.87:1; 흰색은 1.77:1 로 탈락).
4. **글로우 예산.** 한 화면에 민트 글로우 ≤3. 허용 목록: 주 버튼(`--glow-md`), 켜진 토글, 현재 레일 막대, 새 메시지 알약, 글이 있을 때의 보내기 버튼, 선택된 상품 카드/발급 키 박스, 포커스 링. **배지·칩·말풍선·아바타·카드 hover·날짜 칩·툴팁·경고 띠·현재 행 막대는 평면**(경고는 색 대신 왼쪽 3px 띠). 두 글로우가 한 화면에서 겹쳐 보이면 하나는 잘못된 것이다.
5. **그라디언트는 위계가 있는 곳에만.** `--g-primary`(주 버튼·보내기·세그먼트 선택·진행바·새 메시지 알약), `--g-title`(홈 h1 흰→민트), `--g-hero`(홈 상단 ambient), `--g-card-top`(카드 상단 3.5% 흰 빛), `--g-line`(머리글 아래 1px 빛줄, nav 밑줄). 카드·행·말풍선 본체에는 없다.
6. **움직임은 transform/opacity.** 키프레임은 `transform`·`opacity` 만(기존 `kkt-bump` 의 background-color 400ms 1회가 유일한 예외). 전환(transition)은 `transform`·`opacity`·`color`·`background-color`·`border-color`·`box-shadow` 만, `width/height/margin/padding/top/left/font-size` 는 어디서도 움직이지 않는다(기존 `.bar > i` 진행바 width 450ms 는 단일 요소·값 변경 시 1회라 유지). 이징 세트는 `--ease`(상태) · `--ease-out`(등장) · `--ease-pop`(탄성) 셋.
7. **등장은 한 번.** 로드 시 `.hero > *`·`#prods > .card.prod`·`#login.card`·`#console` 만. 콘솔의 9초/3초 재렌더 노드(`.kkt-row`·`.kkt-badge`·`.rail-acct`·`.rail-badge`·`.kkt-line:not(.enter)`)에는 어떤 키프레임도 붙이지 않는다. `prefers-reduced-motion` 에서는 전부 즉시 끝 상태.
8. **폰 먼저.** ≥360px 가로 스크롤 0, 터치 44px, UI_V4 2장 치수(머리글 57/53, 레일 72/64/64-가로, 목록 320/272/352, 분기 720/1024/1280) 그대로. `.hero` 거터 버그(`padding:46px 0 10px` 가 `.wrap` 의 16px 을 지움) 수정.

---

## 2. 공유 토큰 블록

아래 블록을 **`public/style.css` 4–37행 `:root` 와 `public/panel.css` 6–97행 `:root` + reduced-motion 토큰 줄을 대신해 그대로** 붙인다(두 파일에 같은 블록, 빌드 없음). 두 파일이 쓰던 **모든 기존 토큰 이름이 들어 있다** — `style.css`: `--bg --bg2 --card --card2 --line --line2 --text --sub --dim --accent --accent2 --amber --red --violet --on-accent --r-sm --r-md --r-lg --r-xl --sh-sm --sh-md --sh-lg --tap --pad --maxw`; `panel.css`: `--bg --paper --sunken --ink --muted --faint --line --line-strong --accent --accent-hi --accent-soft --accent-ink --danger --warn --ok-bg --ok-line --wait-bg --wait-line --focus --band-* --sh-sm --sh-md --r --r-sm --r-xs --r-md --r-pill --r-ava-rail --r-ava-rail-on --top-h --rail-w --rail-h --list-w --tap --rail-* --st-* --badge --badge-ink --bad-* --bump --ink-2 --paper-2 --log-bg --bubble-* --media-* --chip-* --search-bg --row-* --divider --send-off --acc-0…7 --fs-* --lh-* --sp-* --sh-console --sh-bubble --sh-tip --z-* --t-fast --t-base --t-enter --ease`. 사이트에 panel 별칭이 남고 콘솔에 사이트 이름이 남아도 해가 없다. `panel.css` 의 분기별 치수 재정의(1573 `--list-w:352px`, 1578 `--rail-w:64px; --list-w:272px`, 1596 `--top-h:53px; --rail-h:64px`)는 `:root` 밖이므로 그대로 둔다.

**테스트가 computed 로 읽는 토큰(`--rail-bg --bubble-me --bubble-them --ink-2 --badge --ok-bg --band-chat --on-accent/--accent-ink`)은 반드시 불투명 hex 또는 불투명 hex 로 끝나는 var 체인이다. rgba 를 쓰면 computed 가 `rgba(...)` 로 나와 단언이 깨진다.**

```css
:root{
  color-scheme: dark;

  /* ── 바탕: 층이 올라갈수록 조금씩 밝다. 순수 #000 은 큰 면에 쓰지 않는다 ── */
  --bg:        #0B0E13;   /* page · 레일 · 가장 아래 */
  --bg2:       #0F131A;   /* 가라앉은 면: 대화 창 바탕(log) · .card.flat */
  --card:      #121620;   /* surface-1: 카드 · 콘솔 본체 · 행 · 로그인 카드 */
  --paper-2:   #141925;   /* surface-1.5: 대화 열 머리(.kkt-tools) · 설정 메뉴 바탕(.settings-side) */
  --card2:     #181D28;   /* surface-2: 입력창 · 칩 · 체크 · 행 hover · 토글 줄 */
  --card3:     #1F2531;   /* surface-3 / overlay: 포커스된 입력 · 토스트 · 레일 hover */
  --overlay:   #1F2531;   /* = --card3 (별칭) */
  --tip:       #232A37;   /* 툴팁 — 가장 높은 층 */
  --line:      rgba(255,255,255,.08);   /* 헤어라인 */
  --line2:     rgba(255,255,255,.14);   /* 입력·버튼 테두리 */
  --line3:     rgba(255,255,255,.22);   /* hover 테두리 · 체크박스 선 */

  /* ── 글자 ── */
  --text:      #E8ECF2;   /* primary   (surface-1 15.25) */
  --sub:       #A3ACBA;   /* secondary (surface-1 7.89 · surface-2 7.36) */
  --dim:       #8B95A5;   /* muted     (surface-1 5.98 · surface-2 5.57 · surface-3 5.08) */
  --ph:        #8B95A5;   /* placeholder 전용 — 본문·라벨에 쓰지 않는다. 4.5 밑으로 내리지 않는다 */

  /* ── 액센트: 민트 하나 + 보조 시안 ── */
  --accent:        #3DDC97;   /* mint (파비콘) — 면·막대·점·글자 */
  --accent-hi:     #5CE7AD;   /* hover */
  --accent-lo:     #2FBF80;   /* press */
  --accent-soft:   #15302A;   /* 민트 틴트 면 (현재 탭·켜진 토글 줄·eyebrow·ok 칩) — 불투명 */
  --accent-line:   rgba(61,220,151,.28);
  --accent-dim:    rgba(61,220,151,.14);
  --on-accent:     #06110C;   /* 민트 위 글자 (10.87) */
  --accent2:       #4CC3F5;   /* cyan 글자·링크 (surface-1 8.98) */
  --accent2-raw:   #2BB4F0;   /* cyan 장식(그라디언트·빛줄)용 — 글자에는 쓰지 않는다 */
  --accent2-soft:  #13232C;
  --accent2-line:  rgba(76,195,245,.22);
  --amber:         #F5B14C;   --amber-soft: #2A2114;   --amber-line: rgba(245,177,76,.26);
  --red:           #FF7B81;   --red-soft:   #2C1A1D;   --red-line:   rgba(255,123,129,.28);
  --violet:        #B9A7F5;   /* 미니게임봇 아이콘 색 (app.js f.color) */
  --ok:            #3DDC97;

  /* ── 그라디언트: 위계가 있는 곳에만 ── */
  --g-primary:    linear-gradient(180deg, #4EE3A4 0%, #3DDC97 55%, #34CF8C 100%);
  --g-primary-hi: linear-gradient(180deg, #63EBB2 0%, #4EE3A4 55%, #3DDC97 100%);
  --g-accent:     var(--g-primary);
  --g-hero:       radial-gradient(760px 440px at 10% -10%, rgba(61,220,151,.22), transparent 62%),
                  radial-gradient(560px 360px at 92% 0%, rgba(43,180,240,.12), transparent 60%);
  --g-title:      linear-gradient(180deg, #FFFFFF 0%, #E8ECF2 48%, #7FE9BC 100%);
  --g-card-top:   linear-gradient(180deg, rgba(255,255,255,.035), transparent 42%);
  --g-line:       linear-gradient(90deg, transparent, rgba(61,220,151,.45) 30%, rgba(43,180,240,.45) 70%, transparent);

  /* ── 글로우·링 (민트 알파, 예산 ≤3/화면) ── */
  --glow-sm:  0 0 0 1px rgba(61,220,151,.35), 0 6px 18px -8px rgba(61,220,151,.45);
  --glow-md:  0 8px 24px -10px rgba(61,220,151,.55), 0 1px 2px rgba(0,0,0,.4);
  --glow-lg:  0 14px 36px -12px rgba(61,220,151,.6), 0 2px 6px rgba(0,0,0,.4);
  --glow-sel: 0 0 0 1px var(--accent), 0 12px 32px -16px rgba(61,220,151,.5);
  --ring:        0 0 0 3px rgba(61,220,151,.28);
  --ring-danger: 0 0 0 3px rgba(255,123,129,.28);

  /* ── 반경 ── */
  --r-xs: 6px; --r-sm: 10px; --r-md: 14px; --r-lg: 20px; --r-xl: 26px; --r-pill: 999px; --r: 16px;
  --r-ava-rail: 50%; --r-ava-rail-on: 14px;

  /* ── 그림자 (어두운 면은 그림자보다 '밝은 윗선'으로 층을 나눈다) ── */
  --sh-inset-top: inset 0 1px 0 rgba(255,255,255,.06);
  --sh-sm: 0 1px 2px rgba(0,0,0,.4);
  --sh-md: 0 10px 28px -14px rgba(0,0,0,.7), 0 1px 2px rgba(0,0,0,.4);
  --sh-lg: 0 28px 64px -32px rgba(0,0,0,.85), 0 2px 6px rgba(0,0,0,.4);
  --sh-console: 0 30px 80px -40px rgba(0,0,0,.9), 0 0 0 1px rgba(255,255,255,.06);
  --sh-bubble: 0 1px 2px rgba(0,0,0,.35);
  --sh-tip: 0 10px 28px -8px rgba(0,0,0,.7), 0 0 0 1px rgba(255,255,255,.08);

  /* ── 층 ── */
  --z-head: 2; --z-rail: 3; --z-strip: 4; --z-sum: 15; --z-top: 20; --z-tip: 20; --z-skip: 30; --z-toast: 60;

  /* ── 움직임: transform / opacity 만 ── */
  --t-fast: 120ms; --t-base: 160ms; --t-enter: 220ms; --t-slow: 320ms;
  --ease:     cubic-bezier(.2,.7,.2,1);      /* 상태 전환 (기존) */
  --ease-out: cubic-bezier(.16,1,.3,1);      /* 등장 */
  --ease-pop: cubic-bezier(.34,1.56,.64,1);  /* 탄성 — 배지·토글·체크 */

  /* ── 글꼴: 외부 파일 없음, 설치돼 있으면 Pretendard 우선 ── */
  --font: "Pretendard Variable", Pretendard, -apple-system, BlinkMacSystemFont, "Apple SD Gothic Neo",
          "Malgun Gothic", "Noto Sans KR", "Segoe UI", Roboto, "Helvetica Neue", sans-serif;
  --mono: ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace;
  --fs-11: 11px; --lh-11: 14px;  --fs-12: 12px; --lh-12: 16px;  --fs-13: 13px; --lh-13: 18px;
  --fs-14: 14px; --lh-14: 20px;  --fs-15: 15px; --lh-15: 22px;  --fs-16: 16px; --lh-16: 22px;
  --fs-17: 17px; --lh-17: 24px;  --fs-20: 20px; --lh-20: 26px;
  --sp-1: 4px; --sp-2: 8px; --sp-3: 12px; --sp-4: 16px; --sp-5: 20px; --sp-6: 24px; --sp-8: 32px;

  /* ── 치수 (UI_V4 2장 그대로) ── */
  --tap: 44px; --pad: 16px; --maxw: 760px;
  --top-h: 57px; --rail-w: 72px; --rail-h: 64px; --list-w: 320px;

  /* ── panel.css 기존 이름 → 같은 팔레트 ── */
  --paper: var(--card); --sunken: var(--card2);
  --ink: var(--text); --muted: var(--sub); --faint: var(--dim); --ink-2: #8B95A5;
  --line-strong: var(--line2);
  --accent-ink: var(--on-accent); --danger: var(--red); --warn: var(--amber); --focus: var(--accent);
  --ok-bg: #15302A; --ok-line: rgba(61,220,151,.28);
  --wait-bg: #2A2114; --wait-line: rgba(245,177,76,.26);
  --bad-bg: #2C1A1D; --bad-ink: #FF7B81; --bad-line: rgba(255,123,129,.28);
  --band-account: #3DDC97; --band-macro: #4CC3F5; --band-visit: #F5B14C; --band-reply: #B9A7F5;
  --band-snipe: #FF7B81; --band-cover: #E08BB0; --band-chat: #3DDC97;
  --rail-bg: #0B0E13; --rail-bg-2: #161B26; --rail-hover: #1F2531; --rail-active: #15302A;
  --rail-ink: #E8ECF2; --rail-muted: #8B95A5; --rail-pill: #3DDC97; --rail-line: rgba(255,255,255,.10); --rail-tip-bg: #232A37;
  --st-live: #3DDC97; --st-wait: #F5B14C; --st-off: #6F7A8B; --st-bad: #FF5A61;
  --badge: #D12B3C; --badge-ink: #FFFFFF; --bump: #15302A;
  --log-bg: #0F131A;
  --bubble-them: #1C222D; --bubble-them-line: rgba(255,255,255,.08);
  --bubble-me: #3DDC97; --bubble-me-ink: #06110C;
  --media-bg: #222937; --media-ink: #A3ACBA;
  --chip-bg: #222937; --chip-ink: #B7C0CC;
  --search-bg: #181D28; --row-hover: #181D28; --row-current: #172620; --row-current-bar: #3DDC97;
  --divider: rgba(255,255,255,.06); --send-off: #2A3240;
  --acc-0: #15805C; --acc-1: #2A6FBF; --acc-2: #9A6220; --acc-3: #AD4A66;
  --acc-4: #4E5D73; --acc-5: #7257C4; --acc-6: #1D7A96; --acc-7: #AD4F2D;   /* 흰 글자 ≥4.91 */
}
@media (prefers-reduced-motion: reduce){ :root{ --t-fast:0ms; --t-base:0ms; --t-enter:0ms; --t-slow:0ms } }
```

### 대비표 (WCAG 2.x 상대휘도, `(L1+.05)/(L2+.05)`, 소수 둘째 자리)

| 쌍 | 전경 | 바탕 | 비 | 기준 · 쓰이는 곳 |
|---|---|---|---|---|
| body / surface-1 | `#E8ECF2` | `#121620` | **15.25** | ≥4.5 · 카드·콘솔 본문 |
| body / page | `#E8ECF2` | `#0B0E13` | 16.30 | 히어로·푸터 |
| body / surface-2 | `#E8ECF2` | `#181D28` | 14.22 | 입력 글자 |
| body / surface-3 | `#E8ECF2` | `#1F2531` | 12.95 | 포커스 입력·토스트 |
| body / paper-2 | `#E8ECF2` | `#141925` | 14.82 | `#chat-title` |
| body / log | `#E8ECF2` | `#0F131A` | 15.70 | 빈 로그 제목 |
| secondary / surface-1 | `#A3ACBA` | `#121620` | **7.89** | ≥4.5 · `.lead .sub .desc` |
| secondary / surface-2 | `#A3ACBA` | `#181D28` | 7.36 | `.chk` 글자·보내기 아이콘(off) 아님 ↓ |
| secondary / surface-3 | `#A3ACBA` | `#1F2531` | 6.71 | |
| secondary / paper-2 | `#A3ACBA` | `#141925` | 7.67 | `.kkt-prev` |
| secondary / accent-soft | `#A3ACBA` | `#15302A` | 6.16 | 토글 줄 부제 |
| secondary / send-off | `#A3ACBA` | `#2A3240` | 5.63 | 보내기 버튼 아이콘(글 없을 때) |
| secondary / amber-soft | `#A3ACBA` | `#2A2114` | 6.91 | `.wait` 본문 |
| secondary / tip | `#A3ACBA` | `#232A37` | 6.29 | |
| muted / surface-1 | `#8B95A5` | `#121620` | 5.98 | `.hint .dim .state` |
| muted / surface-2 | `#8B95A5` | `#181D28` | **5.57** | ≥4.5 · 입력 placeholder(`--ph`) |
| muted / surface-3 | `#8B95A5` | `#1F2531` | 5.08 | 포커스 입력 placeholder |
| muted / paper-2 | `#8B95A5` | `#141925` | 5.81 | `.kkt-time` |
| muted / log | `#8B95A5` | `#0F131A` | 6.15 | `.kkt-at` |
| muted / page | `#8B95A5` | `#0B0E13` | 6.39 | `.hero-note` 푸터 |
| muted / row-current | `#8B95A5` | `#172620` | 5.20 | 현재 행 시각 |
| muted / accent-soft | `#8B95A5` | `#15302A` | 4.66 | 현재 탭 `.tval` 은 민트라 해당 없음 |
| muted / bubble-them | `#8B95A5` | `#1C222D` | 5.27 | |
| accent / surface-1 | `#3DDC97` | `#121620` | **10.23** | ≥4.5 · 민트 글자 |
| accent / page | `#3DDC97` | `#0B0E13` | 10.94 | eyebrow 점·레일 막대(비텍스트 ≥3) |
| accent / surface-2 | `#3DDC97` | `#181D28` | 9.54 | 가격 선택줄 |
| accent / paper-2 | `#3DDC97` | `#141925` | 9.94 | 안 읽은 행 시각 |
| accent / accent-soft | `#3DDC97` | `#15302A` | 7.99 | 현재 탭(≥1024)·`.strip`·켜진 토글 줄 |
| accent / row-current | `#3DDC97` | `#172620` | 8.90 | |
| on-accent / accent | `#06110C` | `#3DDC97` | **10.87** | ≥4.5 · 주 버튼·내 말풍선·현재 pill·세그먼트 |
| on-accent / g-primary 끝 | `#06110C` | `#4EE3A4` · `#34CF8C` | 11.75 · 9.56 | 그라디언트 양끝 |
| on-accent / g-primary-hi 끝 | `#06110C` | `#63EBB2` · `#3DDC97` | 12.86 · 10.87 | |
| on-accent / accent-lo | `#06110C` | `#2FBF80` | 8.13 | press |
| cyan / surface-1 | `#4CC3F5` | `#121620` | 8.98 | 링크·`.chip.info`·band-macro |
| cyan / page | `#4CC3F5` | `#0B0E13` | 9.60 | |
| cyan / accent2-soft | `#4CC3F5` | `#13232C` | 8.00 | `.note` 기본 |
| amber / surface-1 | `#F5B14C` | `#121620` | 9.71 | `.warnline` |
| amber / amber-soft | `#F5B14C` | `#2A2114` | 8.50 | `.note.alert` `.big.hi` `.kkt-notice` `.strip.wait` |
| body / amber-soft | `#E8ECF2` | `#2A2114` | 13.36 | `.note.alert` 본문 |
| red / surface-1 | `#FF7B81` | `#121620` | 7.23 | `.err .error .state.bad` |
| red / red-soft | `#FF7B81` | `#2C1A1D` | 6.60 | `.strip.down` `.chip.bad` |
| st-bad / surface-1 | `#FF5A61` | `#121620` | 5.93 | 점(비텍스트) |
| violet / surface-2 | `#B9A7F5` | `#181D28` | 7.96 | 미니게임 아이콘(`.ico` 위) |
| badge ink / badge | `#FFFFFF` | `#D12B3C` | **5.09** | ≥4.5 · `.kkt-badge .rail-badge` |
| body / bubble-them | `#E8ECF2` | `#1C222D` | 13.46 | 상대 말풍선 |
| on-accent / bubble-me | `#06110C` | `#3DDC97` | 10.87 | 내 말풍선 |
| media-ink / media-bg | `#A3ACBA` | `#222937` | 6.36 | `(사진)` |
| chip-ink / chip-bg | `#B7C0CC` | `#222937` | 7.93 | 날짜 칩·안 읽음 칩·계정 칩 |
| rail-ink / rail | `#E8ECF2` | `#0B0E13` | 16.30 | `전체` 글리프 |
| rail-muted / rail | `#8B95A5` | `#0B0E13` | 6.39 | `+`·톱니 |
| rail-ink / tip · rail-muted / tip | `#E8ECF2` · `#8B95A5` | `#232A37` | 12.15 · 4.76 | 툴팁 제목·부제 |
| accent / rail-active | `#3DDC97` | `#15302A` | 7.99 | 현재 `전체` 글리프 |
| 흰 글자 / acc-0…7 | `#FFFFFF` | `#15805C #2A6FBF #9A6220 #AD4A66 #4E5D73 #7257C4 #1D7A96 #AD4F2D` | 4.91 · 5.09 · 5.07 · 5.32 · 6.69 · 5.42 · 4.91 · 5.34 | 레일 아바타 글자 |
| on-accent / AVA_COLORS(panel.js 986, 10색) | `#06110C` | 최저 `#8a6fb0` | 4.56~6.52 | `.kkt-ava` 글자를 흰색→`#06110C` 로(흰색은 2.95~4.22 로 탈락) |
| g-title 끝 / page | `#7FE9BC` | `#0B0E13` | 13.15 | 홈 h1 마지막 줄 |
| 엘리베이션(비텍스트) | `#121620`/`#0B0E13` · `#181D28`/`#121620` · `#1F2531`/`#181D28` · `#232A37`/`#0B0E13` | | 1.07 · 1.07 · 1.10 · 1.34 | 헤어라인+inset 윗선이 경계를 담당 |

---

## 3. 공통 컴포넌트 (두 파일 공통 규칙)

### 3.1 머리글 (`header.top` / `.top`, `.bar`, `.brand`, nav)

```css
/* style.css 98–105 */
header.top{ position:sticky; top:0; z-index:20;
  background:rgba(11,14,19,.72);
  -webkit-backdrop-filter:saturate(1.4) blur(14px); backdrop-filter:saturate(1.4) blur(14px);
  border-bottom:1px solid var(--line); box-shadow:none }
header.top::after{ content:""; position:absolute; left:0; right:0; bottom:-1px; height:1px;
  background:var(--g-line); opacity:.7; pointer-events:none }
/* panel.css 137–140 */
.top{ position:relative; background:rgba(11,14,19,.85);
  -webkit-backdrop-filter:blur(14px); backdrop-filter:blur(14px);
  border-bottom:1px solid var(--line) }
.top::after{ content:""; position:absolute; left:0; right:0; bottom:-1px; height:1px; background:var(--g-line); opacity:.7; pointer-events:none }

.brand{ color:var(--text) }                          /* panel: var(--ink) */
.brand img{ filter:drop-shadow(0 0 8px rgba(61,220,151,.25)) }
.brand small{ color:var(--dim) }

/* nav — 현재는 민트 글자 + 2px 그라디언트 밑줄, hover 는 밑줄이 왼쪽에서 자라난다 (B 접목). 알약 배경 없음 */
nav.top-nav a, .top-nav a{ position:relative; color:var(--sub);
  transition:color var(--t-fast) var(--ease), background var(--t-fast) var(--ease) }
nav.top-nav a::after, .top-nav a::after{ content:""; position:absolute; left:10px; right:10px; bottom:7px; height:2px;
  border-radius:2px; background:linear-gradient(90deg,#3DDC97,#2BB4F0);
  transform:scaleX(0); transform-origin:left center; transition:transform var(--t-base) var(--ease-out) }
nav.top-nav a:hover, .top-nav a:hover{ color:var(--text); background:rgba(255,255,255,.05); text-decoration:none }
nav.top-nav a:hover::after, .top-nav a:hover::after{ transform:scaleX(1) }
nav.top-nav a[aria-current="page"], .top-nav a[aria-current="page"]{ color:var(--accent); background:transparent }
nav.top-nav a[aria-current="page"]::after, .top-nav a[aria-current="page"]::after{ transform:scaleX(1) }
@media (max-width:719px){ .top-nav a::after{ left:8px; right:8px } }   /* panel 폰 패딩 0 8px */
.who{ background:var(--sunken); border:1px solid var(--line); color:var(--muted); font-family:var(--mono) }
```

### 3.2 버튼

```css
/* style.css 292–314 */
.btn{ border:1px solid var(--line2); background:rgba(255,255,255,.03); color:var(--text);
  box-shadow:var(--sh-inset-top);
  transition:background var(--t-fast) var(--ease), border-color var(--t-fast) var(--ease),
             transform var(--t-fast) var(--ease), box-shadow var(--t-base) var(--ease) }
.btn:hover{ background:rgba(255,255,255,.07); border-color:var(--line3); transform:translateY(-1px); text-decoration:none }
.btn:active{ transform:translateY(0) scale(.98) }
.btn.primary{ background:var(--g-primary); border-color:transparent; color:var(--on-accent);
  box-shadow:inset 0 1px 0 rgba(255,255,255,.35), 0 4px 14px -8px rgba(61,220,151,.6) }
.btn.primary:hover{ background:var(--g-primary-hi); box-shadow:inset 0 1px 0 rgba(255,255,255,.4), var(--glow-md) }
.btn.primary:active{ background:var(--accent-lo) }
.btn.ghost{ background:transparent; color:var(--sub) }  .btn.ghost:hover{ color:var(--text) }
.btn:disabled,.btn[aria-disabled="true"]{ opacity:.42; transform:none; box-shadow:none }

/* panel.css 378–412 — 콘솔의 .btn 은 기본이 주 버튼 */
.btn{ border:1px solid transparent; background:var(--g-primary); color:var(--accent-ink);
  box-shadow:inset 0 1px 0 rgba(255,255,255,.35), 0 4px 14px -8px rgba(61,220,151,.6);
  transition:background var(--t-fast) var(--ease), border-color var(--t-fast) var(--ease),
             transform var(--t-fast) var(--ease), box-shadow var(--t-base) var(--ease) }
.btn:hover:not(:disabled){ background:var(--g-primary-hi); border-color:transparent;
  box-shadow:inset 0 1px 0 rgba(255,255,255,.4), var(--glow-md); transform:translateY(-1px) }
.btn:active:not(:disabled){ transform:translateY(0) scale(.98); background:var(--accent-lo) }
.btn.ghost{ background:rgba(255,255,255,.03); color:var(--ink); border-color:var(--line-strong); box-shadow:var(--sh-inset-top) }
.btn.ghost:hover:not(:disabled){ background:rgba(255,255,255,.07); border-color:var(--accent-line); color:var(--accent) }
.btn:disabled{ opacity:.42; box-shadow:none; transform:none }
```

### 3.3 입력 · 셀렉트 · 텍스트에어리어

```css
/* style.css 342–361 */
input[type=text],input[type=tel],input[type=search],textarea,select{
  background:var(--card2); color:var(--text); border:1px solid var(--line2);
  box-shadow:inset 0 1px 2px rgba(0,0,0,.3);
  transition:border-color var(--t-fast) var(--ease), background var(--t-fast) var(--ease), box-shadow var(--t-base) var(--ease) }
input:hover,textarea:hover,select:hover{ border-color:var(--line3) }
input::placeholder,textarea::placeholder{ color:var(--ph) }
input:focus,textarea:focus,select:focus{ outline:none; border-color:var(--accent); background:var(--card3); box-shadow:var(--ring) }
input:focus-visible,textarea:focus-visible,select:focus-visible{ outline:none }   /* 링이 대신한다 */
input.keyin{ font-family:var(--mono); letter-spacing:.08em }
.err{ color:var(--red) }
.fld.bad input,.fld.bad textarea{ border-color:var(--red-line); box-shadow:var(--ring-danger) }
.req{ color:var(--accent) }

/* panel.css 255–276 */
input[type="text"],input[type="password"],input[type="number"],input:not([type]),textarea,select{
  border:1px solid var(--line-strong); background:var(--sunken); color:var(--ink);
  box-shadow:inset 0 1px 2px rgba(0,0,0,.3);
  transition:border-color var(--t-fast) var(--ease), background var(--t-fast) var(--ease), box-shadow var(--t-base) var(--ease) }
input:focus,textarea:focus,select:focus{ outline:none; background:var(--card3); border-color:var(--accent); box-shadow:var(--ring) }
input::placeholder,textarea::placeholder{ color:var(--ph) }
```

### 3.4 체크박스

```css
/* style.css 235–266 (.chk) */
.chk{ border:1px solid var(--line2); background:var(--card2); color:var(--sub);
  transition:border-color var(--t-fast) var(--ease), background var(--t-fast) var(--ease), box-shadow var(--t-fast) var(--ease) }
.chk:hover{ border-color:var(--line3) }
.chk .box{ border:1.5px solid var(--line3); background:var(--card);
  transition:background var(--t-fast) var(--ease), border-color var(--t-fast) var(--ease), box-shadow var(--t-base) var(--ease) }
.chk .box::after{ border-color:var(--on-accent); transition:opacity var(--t-fast) var(--ease), transform var(--t-base) var(--ease-pop) }
.chk input:checked ~ .box{ background:var(--accent); border-color:var(--accent); box-shadow:0 0 0 3px var(--accent-dim);
  animation:check-pop var(--t-slow) var(--ease-pop) }
.chk input:checked ~ .box::after{ opacity:1; transform:rotate(42deg) scale(1) }
.chk input:checked ~ .t{ color:var(--accent) }
.chk:has(input:checked){ border-color:var(--accent-line); background:var(--accent-soft) }
.chk input:focus-visible ~ .box{ outline:2px solid var(--accent); outline-offset:3px }
.chk .amt{ color:var(--text) }
.fld.bad > label.chk{ border-color:var(--red-line) }

/* panel.css 279–305 */
input[type="checkbox"]{ border:1.5px solid var(--line3); background:var(--sunken);
  transition:background var(--t-fast) var(--ease), border-color var(--t-fast) var(--ease), box-shadow var(--t-base) var(--ease) }
input[type="checkbox"]:hover{ border-color:var(--accent) }
input[type="checkbox"]:checked{ background:var(--accent); border-color:var(--accent); box-shadow:0 0 0 3px var(--accent-dim);
  animation:check-pop var(--t-slow) var(--ease-pop) }
input[type="checkbox"]:checked::after{ border:solid var(--accent-ink); border-width:0 2px 2px 0 }   /* 흰 체크 → 어두운 체크 */
input[type="checkbox"]:focus-visible{ outline:none; box-shadow:var(--ring) }
```

### 3.5 토글 스위치 (`form.stack > label.check:first-child`, panel.css 319–361)

```css
form.stack > label.check:first-child{ border:1px solid var(--line); background:var(--sunken);
  transition:background var(--t-base) var(--ease), border-color var(--t-base) var(--ease), box-shadow var(--t-base) var(--ease), color var(--t-base) var(--ease) }
form.stack > label.check:first-child input[type="checkbox"]{ background:#2A3240; border-color:#2A3240;
  box-shadow:inset 0 1px 2px rgba(0,0,0,.4); animation:none }
form.stack > label.check:first-child input[type="checkbox"]::after{ background:#C9D1DC; box-shadow:0 1px 3px rgba(0,0,0,.5);
  border:0; transform:none; transition:transform 280ms var(--ease-pop), background var(--t-base) var(--ease) }
form.stack > label.check:first-child input[type="checkbox"]:checked{ background:var(--accent); border-color:var(--accent);
  box-shadow:0 0 14px -2px rgba(61,220,151,.55), inset 0 1px 0 rgba(255,255,255,.3) }
form.stack > label.check:first-child input[type="checkbox"]:checked::after{ transform:translateX(18px); background:#06110C }  /* 켜지면 손잡이가 어둡게 (B 접목) */
form.stack > label.check:first-child:has(input:checked){ background:var(--ok-bg); border-color:var(--ok-line); color:var(--accent) }
```

### 3.6 카드

```css
/* style.css 164–173 */
.card{ position:relative; background:var(--card); background-image:var(--g-card-top);
  border:1px solid var(--line); box-shadow:var(--sh-sm), var(--sh-inset-top) }
.card.flat{ background:var(--bg2); background-image:none; box-shadow:none }
/* panel.css 218–225 */
.card{ background:var(--paper); background-image:var(--g-card-top); border:1px solid var(--line); box-shadow:var(--sh-sm), var(--sh-inset-top) }
.card > h2::before{ background:var(--accent) }                 /* 띠는 평면, band 색은 토큰 값만 바뀜 (240–245 그대로) */
```

### 3.7 칩 · 배지

```css
/* style.css 317–329 */
.chip{ background:var(--card3); color:var(--sub); border:1px solid var(--line) }
.chip.ok{ background:var(--accent-soft); color:var(--accent); border-color:var(--accent-line) }
.chip.warn{ background:var(--amber-soft); color:var(--amber); border-color:var(--amber-line) }
.chip.bad{ background:var(--red-soft); color:var(--red); border-color:var(--red-line) }
.chip.info{ background:var(--accent2-soft); color:var(--accent2); border-color:var(--accent2-line) }
.chip.vio{ background:var(--card3); color:var(--violet) }
.chip.solid{ background:var(--accent); color:var(--on-accent); border-color:transparent }
/* panel.css 782–801, 1102–1115 — 배지는 평면 (글로우 없음) */
.rail-badge{ background:var(--badge); color:var(--badge-ink); border:2px solid var(--rail-bg) }
.kkt-badge{ background:var(--badge); color:var(--badge-ink); box-shadow:0 0 0 1px rgba(0,0,0,.25) }
```

### 3.8 오류 · 안내 · 띠

```css
/* style.css 522–540 */
.note{ background:var(--accent2-soft); border:1px solid var(--accent2-line); color:var(--sub) }
.note b{ color:var(--text) }
.note.warn{ background:var(--amber-soft); border-color:var(--amber-line) }
.note.dim{ background:var(--card2); border-color:var(--line) }
.note.alert{ background:var(--amber-soft); border:1px solid var(--amber-line); color:var(--text); box-shadow:inset 3px 0 0 var(--amber) }  /* 경고는 색보다 띠 */
.note.alert .ic,.note.alert b{ color:var(--amber) }
/* panel.css 414, 426–455 */
.error{ color:var(--danger) }
.strip{ border:1px solid var(--ok-line); background:var(--ok-bg); color:var(--accent) }
.strip::before{ background:var(--st-live); box-shadow:0 0 0 3px rgba(61,220,151,.18) }
.strip.wait{ background:var(--wait-bg); border-color:var(--wait-line); color:var(--warn) }
.strip.wait::before{ background:var(--st-wait); box-shadow:0 0 0 3px rgba(245,177,76,.18) }
.strip.down{ background:var(--bad-bg); border-color:var(--bad-line); color:var(--bad-ink) }
.strip.down::before{ background:var(--st-bad); box-shadow:0 0 0 3px rgba(255,90,97,.18) }
```

### 3.9 포커스 링 · 선택 · 스킵

```css
:focus-visible{ outline:2px solid var(--accent); outline-offset:2px }          /* 두 파일 */
::selection{ background:rgba(61,220,151,.28); color:#fff }                     /* 두 파일 */
.skip{ background:var(--g-primary); color:var(--on-accent) }                   /* panel: color:var(--accent-ink) */
.rail-btn:focus-visible{ outline:2px solid var(--accent); outline-offset:2px }  /* panel 670: 흰색 → 민트 */
.file-native:focus-visible + .btn{ outline:2px solid var(--focus); outline-offset:2px }  /* 그대로 (토큰 값만 바뀜) */
```

---

## 4. 공개 사이트 (`public/style.css` + `index/buy/my/order.html` + `app.js:643`)

PUBLIC 구현자는 style.css 를 위에서 아래로 다음 순서로 고친다. 적지 않은 속성은 기존 그대로.

### 4.1 기본 (47–95행)

```css
body{ position:relative; background:var(--bg); color:var(--text); font-family:var(--font) }   /* 나머지 선언 유지 */
body[data-page="home"]::before{ content:""; position:absolute; left:0; right:0; top:0; height:720px;
  background:var(--g-hero); pointer-events:none; z-index:0 }     /* 히어로 ambient — 홈에서만, 가로 스크롤 없음 */
header.top, main, footer.bot{ position:relative; z-index:1 }
main{ padding-bottom:40px; overflow-x:clip }                       /* B 접목: 어떤 장식도 뷰포트 밖으로 못 나간다 (clip 은 sticky .sum 을 깨지 않는다) */
a{ color:var(--accent2) }
:focus-visible{ outline:2px solid var(--accent); outline-offset:2px; border-radius:6px }
.skip{ background:var(--g-primary); color:var(--on-accent) }
```

### 4.2 머리글 (98–129행) — 3.1 그대로.

### 4.3 타이포 · 히어로 (131–161행)

```css
h1{ font-size:clamp(28px,7.4vw,46px); line-height:1.16; letter-spacing:-.035em; margin:0 0 14px; font-weight:800 }
.hero h1{ background:var(--g-title); -webkit-background-clip:text; background-clip:text;
  color:transparent; -webkit-text-fill-color:transparent }        /* 흰→연회색→민트: 3줄 h1 의 마지막 줄 '카카오톡 자동화' 가 민트로 물든다. 마크업 훅 불필요 */
.lead,.sub{ color:var(--sub) }   .dim,.hero-note{ color:var(--dim) }
.eyebrow{ display:inline-flex; align-items:center; gap:6px; padding:3px 10px 3px 8px;
  color:var(--accent); background:var(--accent-soft); border:1px solid var(--accent-line) }
.eyebrow::before{ content:""; width:6px; height:6px; border-radius:50%; background:var(--accent); box-shadow:0 0 8px rgba(61,220,151,.8) }

.hero{ padding:54px var(--pad) 14px }      /* 버그 수정: 46px 0 10px 이 .wrap 의 좌우 16px 을 지워 폰에서 h1 이 x=0 에 붙었다 */
.hero-cta{ gap:12px }
.hero > *{ animation:rise var(--t-slow) var(--ease-out) both }
.hero > :nth-child(2){ animation-delay:50ms } .hero > :nth-child(3){ animation-delay:100ms }
.hero > :nth-child(4){ animation-delay:150ms } .hero > :nth-child(5){ animation-delay:200ms }
```

### 4.4 카드 · 상품 카드 · 가격 · 선택 (163–232행)

```css
.card{ … 3.6 }
.prod{ transition:box-shadow var(--t-base) var(--ease), transform var(--t-base) var(--ease), border-color var(--t-base) var(--ease) }
@media (hover:hover){ .prod:hover{ border-color:var(--line2); box-shadow:var(--sh-md), var(--sh-inset-top); transform:translateY(-2px) } }
#prods > .card.prod:not(.skel){ animation:rise var(--t-slow) var(--ease-out) both; animation-delay:calc(120ms + var(--i,0) * 70ms) }
#prods > .card.prod:nth-child(2){ --i:1 }  #prods > .card.prod:nth-child(3){ --i:2 }
/* app.js 는 가격 로드 후 buildCards() 를 1회만 부르고 플랜 전환은 paint() 가 .sel 과 가격만 바꾼다(721–735행) → 재등장 없음. #prods.ready 가드·JS 훅 불필요. 추가하지 않는다 */
.prod .head .ico{ background:var(--card2); border:1px solid var(--line2); box-shadow:var(--sh-inset-top);
  transition:box-shadow var(--t-base) var(--ease-pop), border-color var(--t-base) var(--ease), transform var(--t-base) var(--ease-pop) }
.prod .desc{ color:var(--sub) }
ul.bul li{ color:var(--sub) }   ul.bul li::before{ background:var(--accent); opacity:.9 }
.prices .pr{ color:var(--sub); transition:background var(--t-fast) var(--ease), border-color var(--t-fast) var(--ease) }
.prices .pr .pv{ color:var(--text) }   .prices .pr .per{ color:var(--dim) }
.prices .pr[data-on="1"]{ background:var(--accent-soft); border-color:var(--accent-line); color:var(--text) }
.prices .pr[data-on="1"] .pv{ color:var(--accent) }
.prod.sel{ border-color:var(--accent); background:linear-gradient(180deg, rgba(61,220,151,.06), transparent 50%), var(--card); box-shadow:var(--glow-sel) }
.prod.sel .head .ico{ border-color:var(--accent-line); box-shadow:0 0 0 3px var(--accent-dim); transform:scale(1.04) }
```

### 4.5 체크 · 세그먼트 (235–289행) — `.chk` 는 3.4.

```css
.seg{ background:var(--card2); border:1px solid var(--line) }
.seg span{ color:var(--sub); transition:background var(--t-fast) var(--ease), color var(--t-fast) var(--ease) }
.seg span em{ color:var(--dim) }
.seg input:checked + span{ background:var(--g-primary); color:var(--on-accent); box-shadow:0 4px 12px -6px rgba(61,220,151,.6) }
.seg input:checked + span em{ color:rgba(6,17,12,.72) }
.seg input:focus-visible + span{ outline:2px solid var(--accent); outline-offset:2px }
```

### 4.6 버튼(292–314) 3.2 · 칩(317–329) 3.7 · 폼(332–361) 3.3

### 4.7 합계 · 큰 박스 · 키 · 대기 · 진행바 (363–467행)

```css
.sum{ background:rgba(18,22,32,.86); -webkit-backdrop-filter:blur(12px); backdrop-filter:blur(12px);
  border-top:1px solid var(--line2); box-shadow:0 -16px 34px -28px rgba(0,0,0,.9) }
.sum .ln{ color:var(--sub) }   .sum .ln .v{ color:var(--text) }
.sum .ln.off .v,.sum .ln.off{ color:var(--accent) }
.sum .ln.total{ color:var(--text) }   .sum .ln.total .v{ color:var(--accent); font-size:24px }
.sum .was{ color:var(--dim) }
.sum .nudge{ background:var(--amber-soft); border:1px solid var(--amber-line); color:var(--amber) }
.sum .saved{ background:var(--accent-soft); border:1px solid var(--accent-line); color:var(--accent) }
.big{ background:var(--card2); border:1px solid var(--line2) }   .big .k{ color:var(--sub) }   .big .v.accent{ color:var(--accent) }
.big.hi{ background:var(--amber-soft); border-color:var(--amber-line); box-shadow:inset 3px 0 0 var(--amber) }
.big .v.xl{ color:var(--amber) }   .warnline{ color:var(--amber) }
.keybox{ background:var(--accent-soft); border-color:var(--accent-line); box-shadow:var(--glow-sel) }   /* 사이트에서 글로우를 받는 유일한 박스 */
.keybox .v.key{ font-family:var(--mono); color:var(--accent) }
.wait{ background:var(--amber-soft); border:1px solid var(--amber-line); color:var(--sub) }
.wait .el{ color:var(--dim) }   .dots i{ background:var(--amber) }
.bar{ background:var(--card3) }
.bar > i{ background:var(--g-primary); box-shadow:0 0 10px rgba(61,220,151,.45) }   /* width .45s 전환은 기존 유지 (단일 요소·값 변경 1회) */
.bar.warn > i{ background:var(--amber); box-shadow:none }  .bar.bad > i{ background:var(--red); box-shadow:none }  .bar.off > i{ background:var(--dim); box-shadow:none }
```

### 4.8 기능 행 · 스텝 · FAQ · 상태 · 스켈레톤 · 토스트 · 푸터 · 표 (469–605행)

```css
.feat-row + .feat-row{ border-top:1px solid var(--line) }   .feat-row .meta{ color:var(--dim) }
ol.steps li{ color:var(--sub) }
ol.steps li::before{ background:var(--accent-soft); color:var(--accent); box-shadow:inset 0 0 0 1px var(--accent-line) }
ol.steps li b{ color:var(--text) }
details.faq{ background:var(--card); border:1px solid var(--line); box-shadow:var(--sh-sm) }
@media (hover:hover){ details.faq:hover{ border-color:var(--line2) } }
details.faq[open]{ box-shadow:var(--sh-md); border-color:var(--accent-line) }
details.faq > summary{ color:var(--text) }
details.faq > summary::after{ border-right-color:var(--dim); border-bottom-color:var(--dim) }
details.faq[open] > summary::after{ border-right-color:var(--accent); border-bottom-color:var(--accent) }
details.faq .body{ color:var(--sub) }
.state{ color:var(--dim) }   .state.bad{ color:var(--red) }
.spin{ border:2px solid var(--line2); border-top-color:var(--accent) }
.sk{ background:var(--card2) }
.sk::after{ background:linear-gradient(90deg, transparent 0%, rgba(255,255,255,.07) 50%, transparent 100%) }
#toast{ background:var(--card3); border:1px solid var(--line2); color:var(--text); box-shadow:var(--sh-lg) }
#toast[data-kind="bad"]{ border-color:var(--red-line); color:var(--red) }
#toast[data-kind="ok"]{ border-color:var(--accent-line) }
footer.bot{ border-top:1px solid var(--line); color:var(--dim) }
footer.bot a{ color:var(--sub) }   footer.bot a:hover{ color:var(--accent); text-decoration:none }
dl.kv dt{ color:var(--sub) }
```

### 4.9 키프레임 + reduced-motion (607–617행 교체) — 6장의 사이트 블록 그대로.

### 4.10 HTML 인라인 스타일 전수 (`grep style=" public/*.html`) — 색을 들고 있는 것은 **없다**, 전부 유지

| 파일:행 | 인라인 | 판정 |
|---|---|---|
| index.html 52 `margin:6px 0 0` · 55 `margin-bottom:14px` · 59 `margin-top:14px` · 98 `height:14px` · 201 `margin:0` · 202 `margin:6px 0 0` | 여백만 | 유지 |
| buy.html 33 `padding-top:26px` · 35 `font-size:clamp(23px,6vw,31px)` · 36 `margin-bottom:22px` · 40 `margin-bottom:20px` · 54/63 `margin-bottom:8px` · 56 `gap:9px` · 58/65 `margin-top:8px` · 107 `align-items:flex-start;padding:12px` · 109 `margin-top:2px` · 113 `display:block;font-weight:600;line-height:1.45` · 119 `margin:0` · 127 `margin-top:18px` · 141 `margin:0` | 여백·크기 | 유지 |
| buy.html 111 `display:block;color:var(--text);font-size:14.5px` | 토큰 색 | 유지(토큰 값이 바뀜) |
| my.html 33 · 35 · 48 `height:12px` · 52 · 55 · 56 · 57 · 60 · 62 · 68 · 72 · 86 | 여백·크기 | 유지 |
| order.html 33 · 35 · 42 · 51 · 56 · 71 | 여백·크기 | 유지 |
| panel.html | 인라인 없음 | — |

**바꾸는 것**
- `index.html buy.html my.html order.html` 8행 `<meta name="theme-color" content="#eef1f4">` → `content="#0B0E13"`; 9행 `<meta name="color-scheme" content="light">` → `content="dark"`.
- 4개 파일 `<link rel="stylesheet" href="/style.css?v=4">` → `?v=5`.
- **`app.js` 643행** `style: 'background:#f4f6f8;border:1px solid var(--line);color:' + f.color` → `style: 'background:var(--card2);border:1px solid var(--line2);color:' + f.color` (유일한 하드코딩 밝은색. `f.color` 의 `var(--accent)/var(--accent2)/var(--violet)` 22/33/44행과 682 `color:var(--text)`, 752 `color:var(--red)` 는 토큰이라 그대로).
- app.js 의 다른 인라인(316, 646, 678–683, 827–832, 921, 1030–1096, 1173, 1254–1272, 1320, 1452–1493, 1609–1624)은 여백·크기·토큰 색뿐 → 유지.

### 4.11 하이라이트 처리 요약 (사이트)
- 히어로: `body::before` 민트/시안 라디얼(.22/.12) + `.hero h1` 흰→민트 그라디언트 글자 + eyebrow 알약 점 글로우 + 주 버튼 그라디언트. 스태거 등장 5개.
- 상품: 카드 상단 3.5% 흰 빛 + inset 윗선, hover −2px, 선택 카드 민트 테두리 + 위 6% 틴트 + `--glow-sel`, 선택 아이콘 scale(1.04) + 3px 민트 링, 현재 플랜 가격줄 민트 틴트 + 민트 숫자.
- 결제: `.sum` 유리 바(합계 민트 24px), 묶음 할인 `.saved` 민트 틴트, 주 CTA 글로우. 폰 360–430: `.hero-cta .btn{width:100%}` + gap 12 라 주 버튼 글로우가 아래 고스트 버튼에 겹치지 않는다.

---

## 5. 콘솔 (`public/panel.css` + `public/panel.html`)

CONSOLE 구현자는 panel.css 를 위에서 아래로 고친다. 치수·격자·분기는 바꾸지 않는다.

### 5.1 기본 (98–132행)
```css
.trigger .hint{ color:var(--muted) }      /* 99행 유지 */
body{ background:var(--bg); color:var(--ink); font-family:var(--font) }
.skip{ background:var(--g-primary); color:var(--accent-ink) }
:focus-visible{ outline:2px solid var(--focus); outline-offset:2px }
::selection{ background:rgba(61,220,151,.28); color:#fff }
```

### 5.2 머리글 (137–209행) — 3.1. `h2 h3` 색 상속. `#login{ max-width:560px; margin:24px auto }` 유지.

### 5.3 로그인 카드 · 카드 · 폼 · 체크 · 토글 (214–375행)
```css
#login.card{ box-shadow:var(--sh-lg), var(--sh-inset-top); animation:rise var(--t-slow) var(--ease-out) both }   /* 첫 그리기 1회 */
.card{ … 3.6 }
.card[data-band="account"] > h2::before{ background:var(--band-account) }   /* 240–245 선택자 그대로, 값만 토큰 */
.lead{ color:var(--muted) }   .hint{ color:var(--faint) }   label{ color:var(--ink) }
/* 입력 3.3 · 체크박스 3.4 · 토글 3.5 */
.check{ color:var(--ink) }
```

### 5.4 버튼(378–412) 3.2 · 오류·띠(414–456) 3.8

### 5.5 계정 · 인증번호 · 현재 계정 · 방 고르기 · trigger (459–594행)
```css
.account{ border:1px solid var(--line); background:var(--paper); box-shadow:var(--sh-sm), var(--sh-inset-top) }
.account span{ color:var(--muted) }
.passcode-box{ border:1px solid var(--wait-line); background:var(--wait-bg) }
.code{ background:var(--paper); border:1px solid var(--line-strong); color:var(--accent); font-family:var(--mono);
  text-shadow:0 0 18px rgba(61,220,151,.35) }
.where{ background:var(--paper); border:1px solid var(--line); box-shadow:var(--sh-sm), var(--sh-inset-top); color:var(--ink) }
.where::before{ background:var(--st-live); box-shadow:0 0 0 3px rgba(61,220,151,.18) }
.inline{ color:var(--muted) }
fieldset{ border:1px solid var(--line); background:var(--paper) }   legend{ color:var(--faint) }
.room{ transition:background var(--t-fast) var(--ease) }   .room:hover{ background:var(--sunken) }
.room + .room{ border-top:1px solid var(--line) }   .room .name{ color:var(--ink) }
.room:has(input:checked) .name{ color:var(--accent) }
.thumb img{ border:1px solid var(--line-strong) }
.trigger{ border:1px solid var(--line); background:var(--sunken) }
.limit{ color:var(--faint) }
```

### 5.6 콘솔 골격 (597–633행)
```css
#console{ background:var(--paper); border:1px solid var(--line); box-shadow:var(--sh-console);
  animation:rise var(--t-slow) var(--ease-out) both }    /* #app hidden→보임 때 1회. 폴링은 #console 을 다시 만들지 않는다 */
.kkt-list{ border-right:1px solid var(--line); background:var(--paper) }
```

### 5.7 레일 (641–843행) — 치수 그대로, 막대는 scaleY
```css
#rail{ background:var(--rail-bg); color:var(--rail-ink); border-right:1px solid var(--line) }   /* 레일/목록 명도차가 작아 선이 필요 (A 약점 수정). offsetWidth 는 border-box 라 72 그대로 */
.rail-btn:focus-visible{ outline:2px solid var(--accent); outline-offset:2px }
.ava{ color:#fff }                                                           /* 레일 아바타: --acc-* 위 흰 글자 ≥4.91 */
.ava-rail, .rail-all .rail-glyph, .rail-skel{
  transition:border-radius var(--t-base) var(--ease), background var(--t-base) var(--ease),
             transform var(--t-fast) var(--ease), box-shadow var(--t-base) var(--ease) }
.ava-rail{ box-shadow:inset 0 1px 0 rgba(255,255,255,.14), 0 2px 6px rgba(0,0,0,.4) }
.rail-acct[aria-current="true"] .ava-rail{ box-shadow:0 0 0 2px var(--rail-bg), 0 0 0 3.5px var(--accent) }   /* 민트 링 — 평면 */
.rail-all .rail-glyph{ background:var(--rail-bg-2); color:var(--rail-ink); box-shadow:inset 0 0 0 1px var(--rail-line) }
.rail-all:hover .rail-glyph{ background:var(--rail-hover) }
.rail-all[aria-current="true"] .rail-glyph{ background:var(--rail-active); color:var(--accent); box-shadow:inset 0 0 0 1px rgba(61,220,151,.35) }
.rail-add, .rail-gear{ background:var(--rail-bg-2); box-shadow:inset 0 0 0 2px var(--rail-bg), inset 0 0 0 3px var(--rail-line); color:var(--rail-muted) }
.rail-add:hover, .rail-gear:hover{ background:var(--rail-hover); border-radius:14px; color:var(--accent) }
/* 선택 막대 — height 트랜지션 → scaleY (A 접목). 36px 기준 .22=8px, .56=20px, 1=36px */
.rail-all::before, .rail-acct::before{ content:""; position:absolute; left:calc((var(--rail-w) - 48px) / -2); top:50%;
  width:4px; height:36px; border-radius:0 4px 4px 0; background:var(--rail-pill);
  transform:translateY(-50%) scaleY(.22); transform-origin:50% 50%; opacity:0;
  transition:transform var(--t-base) var(--ease-out), opacity var(--t-base) var(--ease) }
.rail-all:hover::before, .rail-acct:hover::before{ transform:translateY(-50%) scaleY(.56); opacity:1 }
.rail-all[aria-current="true"]::before, .rail-acct[aria-current="true"]::before{ transform:translateY(-50%) scaleY(1); opacity:1; box-shadow:0 0 10px rgba(61,220,151,.55) }
.rail-sep{ height:1px; background:var(--rail-line) }
.rail-skel{ background:var(--rail-bg-2) }
.rail-dot{ border:3px solid var(--rail-bg); background:var(--st-off) }
.rail-acct[data-state="live"] .rail-dot{ background:var(--st-live) }
.rail-acct[data-state="live"] .rail-dot::after{ content:""; position:absolute; inset:-3px; border-radius:50%;
  border:2px solid var(--st-live); opacity:0; animation:pulse 2.4s var(--ease) infinite }   /* transform/opacity 만. scale 1.7 = 34px → 레일 12px 여백 안 */
.rail-acct[data-state="linking"] .rail-dot{ background:var(--st-wait) }
.rail-acct[data-state="error"] .rail-dot{ background:var(--st-wait); box-shadow:inset 0 0 0 2px var(--rail-ink) }
.rail-acct[data-state="needs_register"] .rail-dot{ background:var(--st-bad) }
.rail-acct[data-state="sender_down"] .rail-dot{ background:var(--st-off) }
.rail-badge{ … 3.7 }
.rail-tip{ background:var(--rail-tip-bg); color:var(--rail-ink); box-shadow:var(--sh-tip);
  transform:translateY(-50%) translateX(-4px);
  transition:opacity var(--t-fast) var(--ease), transform var(--t-fast) var(--ease-out), visibility 0s linear var(--t-fast) }
.rail-tip small{ color:var(--rail-muted) }
.rail-btn:hover > .rail-tip, .rail-btn:focus-visible > .rail-tip{ opacity:1; visibility:visible; transform:translateY(-50%) translateX(0); transition-delay:60ms, 60ms, 0s }
```
(`@supports (anchor-name)` 블록 834–843 은 그대로; fixed 툴팁의 `transform` 도 같은 규칙을 탄다.)

### 5.8 대화 열 (846–1182행)
```css
.kkt-tools{ background:var(--paper-2); border-bottom:1px solid var(--line) }
.chip{ background:var(--chip-bg); color:var(--chip-ink);
  transition:background var(--t-fast) var(--ease), color var(--t-fast) var(--ease), transform var(--t-fast) var(--ease) }
.chip:hover{ background-color:#2A3240 }
.chip:active{ transform:scale(.96) }
.chip b{ background:rgba(255,255,255,.10) }
.chip[aria-pressed="true"]{ background-color:var(--accent); color:var(--accent-ink) }      /* 평면 — 글로우 없음 */
.chip[aria-pressed="true"] b{ background:rgba(0,0,0,.18) }
.icon-btn{ color:var(--muted) }   .icon-btn svg{ transition:transform var(--t-slow) var(--ease) }
.icon-btn:hover{ background:rgba(255,255,255,.06); color:var(--ink) }
#chat-reload:hover svg{ transform:rotate(90deg) }   .icon-btn:active svg{ transform:scale(.9) }
.kkt-search{ background:var(--paper) }   .kkt-search-ico{ color:var(--muted) }
#chat-search{ background:var(--search-bg); color:var(--ink); border:1px solid transparent;
  transition:background var(--t-fast) var(--ease), border-color var(--t-fast) var(--ease), box-shadow var(--t-base) var(--ease) }
#chat-search:focus{ outline:none; background:var(--card3); border-color:var(--accent); box-shadow:var(--ring) }
#chat-search::placeholder{ color:var(--ph) }
.kkt-notice{ background:var(--wait-bg); border-top:1px solid var(--wait-line); border-bottom:1px solid var(--wait-line); color:var(--warn); box-shadow:inset 3px 0 0 var(--amber) }
.kkt-notice-text{ color:var(--ink) }
.st-dot{ background:var(--st-off) }   .st-dot[data-state="live"]{ background:var(--st-live); box-shadow:0 0 0 3px rgba(61,220,151,.18) }
.st-dot[data-state="needs_register"]{ background:var(--st-bad); box-shadow:0 0 0 3px rgba(255,90,97,.18) }
.kkt-row{ color:var(--ink); transition:background var(--t-fast) var(--ease) }
.kkt-row:hover{ background:var(--row-hover) }
.kkt-row:active .kkt-ava{ transform:scale(.94) }
.kkt-row[aria-current="true"]{ background:var(--row-current) }
.kkt-row[aria-current="true"]::before{ background:var(--row-current-bar) }                  /* 평면 막대 */
.kkt-rooms > [role="listitem"] + [role="listitem"] > .kkt-row::after{ border-top:1px solid var(--divider) }
.kkt-row.bump{ animation:kkt-bump 400ms var(--ease) both }                                 /* 기존, --bump #15302A → 투명 */
.kkt-row.bump .kkt-badge{ animation:pop var(--t-slow) var(--ease-pop) both }              /* 배지 pop — JS 훅 없이, 안 읽음이 늘어난 행에만(.bump 와 같은 조건) */
.kkt-ava{ background:var(--ava, var(--acc-4)); color:var(--accent-ink); box-shadow:inset 0 1px 0 rgba(255,255,255,.16), 0 2px 6px rgba(0,0,0,.35);
  transition:transform var(--t-fast) var(--ease) }    /* panel.js 986 AVA_COLORS 10색 위 어두운 글자 ≥4.56 (흰색은 2.95~4.22) */
.unread .kkt-name b{ font-weight:750; color:#fff }
.kkt-time{ color:var(--ink-2) }   .unread .kkt-time{ color:var(--accent) }
.kkt-prev{ color:var(--muted) }   .unread .kkt-prev{ color:var(--ink) }
.kkt-badge{ … 3.7 }   .kkt-acc{ color:var(--chip-ink) }
.kkt-empty{ color:var(--muted) }   .kkt-empty svg{ color:var(--faint) }   .kkt-empty strong, .kkt-empty-title{ color:var(--ink) }
.kkt-skel::before, .kkt-skel::after{ background:var(--chip-bg) }   .kkt-skel::after{ box-shadow:0 18px 0 0 var(--divider) }
```

### 5.9 대화 창 (1185–1441행)
```css
.kkt-room{ background:var(--log-bg) }
.kkt-head{ background:var(--paper); border-bottom:1px solid var(--line) }
.kkt-back{ color:var(--ink) }
.kkt-head-ava{ color:var(--accent-ink); box-shadow:inset 0 1px 0 rgba(255,255,255,.16) }
.kkt-sub{ color:var(--ink-2) }
.thread-state{ background:var(--sunken); color:var(--muted); box-shadow:inset 0 0 0 1px var(--line) }
.thread-state::before{ background:var(--st-off) }
.thread-state[data-state="live"]{ background:var(--ok-bg); color:var(--accent); box-shadow:inset 0 0 0 1px var(--ok-line) }
.thread-state[data-state="live"]::before{ background:var(--st-live); box-shadow:0 0 0 3px rgba(61,220,151,.18) }
.thread-state[data-state="linking"], .thread-state[data-state="error"]{ background:var(--wait-bg); color:var(--warn); box-shadow:inset 0 0 0 1px var(--wait-line) }
.thread-state[data-state="needs_register"]{ background:var(--bad-bg); color:var(--bad-ink); box-shadow:inset 0 0 0 1px var(--bad-line) }
.thread-state[data-state="sender_down"]{ background:var(--sunken); color:var(--muted) }
.kkt-log{ background:var(--log-bg);
  background-image:radial-gradient(rgba(255,255,255,.035) 1px, transparent 1px); background-size:22px 22px }   /* 점 격자 — 빈 로그가 꺼진 화면으로 보이지 않게 (A 접목) */
.kkt-date span{ background:var(--chip-bg); color:var(--chip-ink); border:1px solid var(--line) }
.kkt-bubble{ box-shadow:var(--sh-bubble) }                                                   /* 반경 16 유지 */
.kkt-line.them .kkt-bubble{ background:var(--bubble-them); border:1px solid var(--bubble-them-line); color:var(--ink) }
.kkt-line.me .kkt-bubble{ background:var(--bubble-me); color:var(--bubble-me-ink); font-weight:500; box-shadow:0 1px 2px rgba(0,0,0,.3) }   /* 민트 단색 — 글로우 없음. background-image 를 절대 얹지 않는다(테스트가 backgroundColor 를 읽는다) */
.kkt-bubble.media{ background:var(--media-bg); border-color:transparent; color:var(--media-ink) }
.kkt-at{ color:var(--ink-2) }
.kkt-line.enter{ animation:kkt-in var(--t-enter) var(--ease-out) both }
.kkt-newpill{ background:var(--g-primary); color:var(--accent-ink); font-weight:700; box-shadow:var(--glow-md);
  animation:pill-in var(--t-enter) var(--ease-out) both }
.kkt-newpill:hover{ background:var(--g-primary-hi) }
.kkt-note{ background:var(--wait-bg); border-top:1px solid var(--wait-line); color:var(--warn) }
.kkt-compose{ background:var(--paper); border-top:1px solid var(--line) }
.kkt-compose textarea{ background:var(--sunken); color:var(--ink); box-shadow:inset 0 0 0 1px var(--line);
  transition:background var(--t-fast) var(--ease), box-shadow var(--t-base) var(--ease) }
.kkt-compose textarea:focus{ outline:none; background:var(--card3); box-shadow:0 0 0 1px var(--accent), var(--ring) }
.kkt-compose textarea:disabled{ background:var(--sunken); color:var(--muted) }
.kkt-compose textarea:disabled::placeholder{ color:var(--muted) }
.kkt-compose textarea::placeholder{ color:var(--ph) }
.kkt-count{ color:var(--ink-2) }
.kkt-sendbtn{ background:var(--send-off); color:var(--sub);
  transition:background var(--t-base) var(--ease), color var(--t-base) var(--ease), box-shadow var(--t-base) var(--ease), transform 80ms var(--ease) }
.kkt-compose.has-text .kkt-sendbtn:not(:disabled){ background:var(--g-primary); color:var(--accent-ink); box-shadow:var(--glow-md) }
.kkt-compose.has-text .kkt-sendbtn:not(:disabled):hover{ background:var(--g-primary-hi) }
.kkt-sendbtn:not(:disabled):active{ transform:scale(.92) }
.compose-hint{ background:var(--paper); color:var(--ink-2) }
```

### 5.10 설정 모드 (1444–1519행)
```css
#settings{ background:var(--paper) }
.settings-side{ border-right:1px solid var(--line); background:var(--paper-2) }
#settings-acct{ background:var(--sunken) url("data:image/svg+xml;charset=utf-8,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'%3E%3Cpath d='m6 9 6 6 6-6' fill='none' stroke='%238B95A5' stroke-width='2.2' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E") no-repeat right 11px center / 16px 16px;
  color:var(--ink) }                                   /* chevron stroke %235b6878 → %238B95A5. 테두리·포커스는 공용 select 규칙 */
#settings-acct:disabled{ color:var(--muted) }
.panes{ … 그대로 }
/* 탭 알약 (<1024) — 현재 = 민트 면 + 짙은 글자 (흰 글자는 1.77:1 로 탈락) */
.tab{ border:1px solid var(--line-strong); background:var(--sunken); color:var(--muted);
  transition:background var(--t-fast) var(--ease), color var(--t-fast) var(--ease), border-color var(--t-fast) var(--ease), transform var(--t-fast) var(--ease) }
.tab:hover:not([disabled]){ border-color:var(--ok-line); color:var(--ink); transform:translateY(-1px) }
.tab:active:not([disabled]){ transform:scale(.97) }
.tab[aria-current="true"]{ background:var(--band-chat); border-color:var(--band-chat); color:var(--accent-ink); box-shadow:inset 0 1px 0 rgba(255,255,255,.25) }
.tab[disabled]{ opacity:.42 }
.tab[aria-current="true"] .tval{ opacity:.9 }
```

### 5.11 반응형 블록 (1522–1705행) — 치수·격자 변경 없음, 색·막대만
```css
@media (min-width:1024px){
  .tabs{ background:var(--paper); border:1px solid var(--line); box-shadow:var(--sh-sm), var(--sh-inset-top) }
  .tab{ border-color:transparent; background:transparent; box-shadow:none }
  .tab:hover:not([disabled]){ background:rgba(255,255,255,.05); border-color:transparent; transform:none }
  .tab[aria-current="true"]{ background:var(--ok-bg); color:var(--band-chat); border-color:transparent; box-shadow:inset 3px 0 0 var(--accent) }   /* background-image 없음 — computed rgb(21,48,42) */
  .tab[aria-current="true"] .tval{ color:var(--band-chat) }
  .tab-chat::after{ border-top:1px solid var(--line) }
}
@media (min-width:720px) and (max-width:1023px){ .settings-side{ border-bottom:1px solid var(--line) } }
@media (max-width:719px){
  #rail{ border-right:0; border-bottom:1px solid var(--line) }                 /* offsetHeight 는 border-box 라 64 그대로 */
  /* 선택 표시: 아바타 아래 3px 밑줄 — width 트랜지션 → scaleX. 36px 기준 .22=8px, .56=20px, 1=36px */
  .rail-all::before, .rail-acct::before{ left:50%; top:auto; bottom:0; width:36px; height:3px; border-radius:3px 3px 0 0;
    transform:translateX(-50%) scaleX(.22); transform-origin:50% 50%;
    transition:transform var(--t-base) var(--ease-out), opacity var(--t-base) var(--ease) }
  .rail-all:hover::before, .rail-acct:hover::before{ transform:translateX(-50%) scaleX(.56) }
  .rail-all[aria-current="true"]::before, .rail-acct[aria-current="true"]::before{ transform:translateX(-50%) scaleX(1) }
  .settings-side{ border-bottom:1px solid var(--line) }
  .kkt-row{ -webkit-tap-highlight-color:transparent }
}
```

### 5.12 키프레임 + reduced-motion (1708–1711행 교체) — 6장의 콘솔 블록 그대로. 기존 `kkt-bump`(1055) `kkt-in`(1323) 정의는 그 자리에서 지우고 한 곳에 모은다.

### 5.13 `panel.html`
- 8행 `<meta name="theme-color" content="#eef1f4">` → `content="#0B0E13"`; 그 다음 줄에 `<meta name="color-scheme" content="dark">` 추가(현재 없음).
- 10행 `/panel.css?v=12` → `/panel.css?v=13`. `/panel.js?v=15` 는 panel.js 를 건드리지 않으므로 그대로.
- 그 외 마크업 변경 없음(등장 훅은 `#login`·`#console` id, 배지 pop 은 `.bump`, 레일 펄스는 `data-state` 로 전부 기존 속성에 걸린다).

### 5.14 폰·태블릿 노트
- 폰(<720): 가로 레일 64px 아래 1px 선, 아바타 40 + 민트 밑줄(scaleX), 펄스 링은 `scale(1.7)` 에서 34px 라 64px 레일 안에 들어온다(`#rail overflow-x:auto` 가 세로를 자르지만 넘치지 않는다). `.kkt-tools` 48 + `.kkt-search` 52 + `.kkt-notice`(앰버 띠) 세 줄이 색으로 구분된다. 말풍선 `max-width:none`, 내 말풍선 민트 단색이 폰에서 가장 밝은 면이므로 보내기 버튼 글로우는 `.has-text` 에서만 켜진다. 설정: pill 띠 현재 = 민트 면 + 짙은 글자(글로우 없음 → `overflow-x:auto` 상자에서 잘릴 것이 없다), 토글 줄 전체가 터치 영역.
- 태블릿(720–1023): `.settings-side` 가 위(셀렉트 + pill 띠), 색 규칙은 폰과 같다. 940px 에서 `.tab[aria-current]` = `rgb(61,220,151)` / `rgb(6,17,12)`.
- `backdrop-filter` 는 `.top`(사이트·콘솔)·`.sum` 세 곳뿐. 글로우는 전부 `box-shadow` 라 레이어를 만들지 않는다.

---

## 6. 애니메이션 카탈로그

### 6.1 키프레임 (두 파일에 각각 정의; 사이트는 `rise check-pop shimmer sp dot`, 콘솔은 `rise pop check-pop pulse kkt-in pill-in kkt-bump`)

```css
@keyframes rise      { from{ opacity:0; transform:translateY(10px) } to{ opacity:1; transform:none } }
@keyframes pop       { 0%{ transform:scale(.5); opacity:0 } 60%{ transform:scale(1.12); opacity:1 } 100%{ transform:scale(1); opacity:1 } }
@keyframes check-pop { 0%{ transform:scale(.85) } 60%{ transform:scale(1.1) } 100%{ transform:scale(1) } }
@keyframes pulse     { 0%{ transform:scale(.7); opacity:.6 } 70%,100%{ transform:scale(1.7); opacity:0 } }
@keyframes kkt-in    { from{ opacity:0; transform:translateY(6px) scale(.98) } to{ opacity:1; transform:none } }
@keyframes pill-in   { from{ opacity:0; transform:translateY(6px) scale(.96) } to{ opacity:1; transform:none } }
@keyframes kkt-bump  { from{ background-color:var(--bump) } to{ background-color:transparent } }   /* 기존 · 유일한 비-transform 예외 */
@keyframes shimmer   { to{ transform:translateX(100%) } }        /* 기존 (.sk::after) */
@keyframes sp        { to{ transform:rotate(360deg) } }          /* 기존 (.spin) */
@keyframes dot       { 0%,72%,100%{ opacity:.28 } 30%{ opacity:1 } }   /* 기존 (.dots i) */
```

### 6.2 붙는 곳 · 시간 · 트리거

| 이름 | 선택자 | 시간 / 이징 / 지연 | 트리거 | 파일 |
|---|---|---|---|---|
| rise | `.hero > *` | 320ms `--ease-out` both, nth-child 2–5 에 50/100/150/200ms | 로드 1회 | style |
| rise | `#prods > .card.prod:not(.skel)` | 320ms `--ease-out`, `120ms + --i×70ms`(nth-child 2·3 → --i 1·2) | 가격 로드 후 스켈레톤→카드 교체 1회. 플랜 전환은 paint() 라 재생 없음 | style |
| rise | `#login.card`, `#console` | 320ms `--ease-out` both | 화면 첫 그리기 1회 (hidden→보임) | panel |
| pop | `.kkt-row.bump .kkt-badge` | 320ms `--ease-pop` both | panel.js 가 안 읽음 증가 행에 `.bump` 를 붙이는 500ms 동안만(1296–1297행). 9초 재렌더 자체는 `.bump` 를 붙이지 않으므로 평상시 재렌더에서 배지는 움직이지 않는다 | panel |
| check-pop | `.chk input:checked ~ .box`, `input[type="checkbox"]:checked`(토글 트랙 제외) | 320ms `--ease-pop` | 체크 상태 진입 | 둘 다 |
| pulse | `.rail-acct[data-state="live"] .rail-dot::after` | 2.4s `--ease` infinite | 접속 중인 동안 상시. `renderRail()` 이 노드를 다시 만들면 위상만 리셋 | panel |
| kkt-in | `.kkt-line.enter` | 220ms `--ease-out` both, 지연 없음 | panel.js 1682 가 **새 log_id 에만** `.enter`. 처음 열 때(`initial`)와 3초 재렌더의 기존 줄은 없음 | panel |
| pill-in | `.kkt-newpill` | 220ms `--ease-out` both | hidden 해제 | panel |
| kkt-bump | `.kkt-row.bump` | 400ms `--ease` both | 안 읽음 증가 행 1개 | panel |
| shimmer / sp / dot | `.sk::after` / `.spin` / `.dots i` | 1.3s / .75s / 1.25s (기존) | 로딩 | style |

### 6.3 전환 (transition) — 모두 `transform / opacity / color / background-color / border-color / box-shadow` 만

| 대상 | 속성 → 값 | 시간 / 이징 | 트리거 |
|---|---|---|---|
| `.btn`(둘 다) | transform translateY(-1px) / active scale(.98), background, border-color, box-shadow | 120ms `--ease` / box-shadow 160ms | hover · press |
| `.prod` | transform translateY(-2px), box-shadow, border-color | 160ms `--ease` | hover(`hover:hover`) |
| `.prod .ico` | transform scale(1.04), box-shadow | 160ms `--ease-pop` | `.sel` |
| `.chk .box::after` | transform scale(.5→1), opacity | 160ms `--ease-pop` / 120ms | 체크 |
| 토글 손잡이 `::after` | transform translateX(18px), background | **280ms `--ease-pop`** | 체크 |
| 토글 줄 `label.check:first-child` | background, border-color, color, box-shadow | 160ms | 체크 |
| nav `a::after` | transform scaleX(0→1), origin left | 160ms `--ease-out` | hover · current |
| `.ava-rail` `.rail-glyph` | border-radius 50%→14px, transform, box-shadow | 160ms / 120ms | hover · current · press scale(.94) |
| `.rail-*::before` 막대 | transform scaleY .22→.56→1 (폰 scaleX), opacity | 160ms `--ease-out` | hover · aria-current |
| `.rail-tip` | opacity, transform translateX(-4px→0) | 120ms, 60ms 지연 | hover · focus-visible |
| `.rail-gear svg` / `#chat-reload svg` | transform rotate(30deg) / rotate(90deg) | 160ms / 320ms | hover |
| `.chip` `.tab` | transform scale(.96)/(.97) press, translateY(-1px) hover, color, background | 120ms | press · hover |
| `.kkt-row` | background | 120ms | hover · current |
| `.kkt-ava` | transform scale(.94) | 120ms | press |
| `.kkt-sendbtn` | background, color, box-shadow 160ms · transform scale(.92) 80ms | `.has-text` · press |
| 입력·검색·textarea | border-color, background 120ms · box-shadow(링) 160ms | focus |
| `#toast` | opacity, transform (기존 200ms) | data-on |
| `details.faq summary::after` | transform rotate (기존 180ms) | open |
| `.bar > i` | width 450ms (기존, 단일 요소 예외) | 값 변경 |

### 6.4 Reduced motion — 두 파일

```css
/* style.css (607–617 교체) */
@media (prefers-reduced-motion: reduce){
  :root{ --t-fast:0ms; --t-base:0ms; --t-enter:0ms; --t-slow:0ms }
  *,*::before,*::after{ animation-duration:.001ms !important; animation-iteration-count:1 !important;
                        transition-duration:.001ms !important; scroll-behavior:auto !important }
  .hero > *, #prods > .card.prod, .chk input:checked ~ .box, .sk::after{ animation:none !important; opacity:1; transform:none }
  .dots i{ opacity:.75 !important }
}
/* panel.css (1708–1711 교체) */
@media (prefers-reduced-motion: reduce){
  *,*::before,*::after{ animation-duration:.001ms !important; animation-iteration-count:1 !important; transition-duration:.001ms !important }
  .kkt-line.enter, .kkt-row.bump, .kkt-row.bump .kkt-badge, .kkt-newpill, #login.card, #console,
  input[type="checkbox"]:checked{ animation:none !important; opacity:1; transform:none }
  .rail-acct[data-state="live"] .rail-dot::after{ display:none }
  .rail-tip{ transition:none }
}
```
(토큰 0ms 줄은 2장 블록 안에 있다. `.kkt-line.enter` 는 computed `animationName === 'none'`, `--t-enter === '0ms'` 가 테스트 [38] 의 조건이다.)

### 6.5 콘솔 재렌더 — 움직이면 안 되는 것 (DO-NOT-ANIMATE)

`renderInbox`(9초, 실패 시 20초)는 행 전체를 새로 만들고, `renderRail()` 은 매 inbox 폴링 뒤 서명이 바뀌면 레일 버튼을 새로 만들며(1442/1466/1508행), `renderThread`(3초)는 로그를 다시 그린다. 따라서 다음에는 **어떤 keyframe 도 붙이지 않는다**:
`.kkt-row` · `[role="listitem"]` · `.kkt-rooms` · `.kkt-ava` · `.kkt-meta` · `.kkt-badge`(`.bump` 조상 없이) · `.kkt-acc` · `.rail-acct` · `.ava-rail` · `.rail-badge` · `.rail-dot`(본체; `::after` 링만 상시) · `#rail-accounts` · `.kkt-date` · `.kkt-line:not(.enter)` · `.thread-state` · `#chat-title` · `.kkt-head` · `.kkt-tools` · `.kkt-compose` · `#settings` · `.tab`.
등장은 `#login.card`·`#console`(첫 그리기), `.kkt-line.enter`(새 줄), `.kkt-newpill`(hidden 해제), `.kkt-row.bump`(변한 행)·`.kkt-row.bump .kkt-badge` 뿐. hover/current 색 전환은 transition 이라 재렌더와 무관하다.

---

## 7. 테스트 변경 (값만 교체, 검사는 유지)

### 7.1 `scratchpad/inbox.mjs`

| 행 | 현재 | **새 줄** |
|---|---|---|
| 530 | `eq(colors.rail, 'rgb(15, 31, 25)', …)` | `eq(colors.rail, 'rgb(11, 14, 19)', '[36] #rail 배경이 --rail-bg(#0B0E13) 가 아니다')` |
| 531 | `eq(colors.me, 'rgb(220, 239, 228)', …)` | `eq(colors.me, 'rgb(61, 220, 151)', '[36] .kkt-line.me .kkt-bubble 배경이 --bubble-me(#3DDC97) 가 아니다')` |
| 532 | `eq(colors.them, 'rgb(255, 255, 255)', …)` | `eq(colors.them, 'rgb(28, 34, 45)', '[36] .kkt-line.them .kkt-bubble 배경이 --bubble-them(#1C222D) 가 아니다')` |
| 533 | `eq(colors.at, 'rgb(95, 107, 121)', …)` | `eq(colors.at, 'rgb(139, 149, 165)', '[36] .kkt-at 색이 --ink-2(#8B95A5) 가 아니다')` |
| 534 | `eq(colors.badge, 'rgb(208, 48, 58)', …)` | `eq(colors.badge, 'rgb(209, 43, 60)', '[36] .kkt-badge 배경이 --badge(#D12B3C) 가 아니다')` |
| 663 | `eq(tabs1280.bg, 'rgb(232, 242, 236)', …)` | `eq(tabs1280.bg, 'rgb(21, 48, 42)', '[36] ≥1024px .tab[aria-current="true"] 배경이 --ok-bg(#15302A) 가 아니다')` |
| 664 | `eq(tabs1280.color, 'rgb(47, 93, 80)', …)` | `eq(tabs1280.color, 'rgb(61, 220, 151)', '[36] ≥1024px .tab[aria-current="true"] 글자색이 --band-chat(#3DDC97) 가 아니다')` |
| 800 | `eq(m2.bg, 'rgb(47, 93, 80)', …)` | `eq(m2.bg, 'rgb(61, 220, 151)', '[36] <1024px .tab[aria-current="true"] 배경이 --band-chat(#3DDC97) 가 아니다')` |
| 801 | `eq(m2.color, 'rgb(255, 255, 255)', …)` | `eq(m2.color, 'rgb(6, 17, 12)', '[36] <1024px .tab[aria-current="true"] 글자가 --accent-ink(#06110C) 가 아니다 (민트 위 흰 글자는 1.77:1)')` |

그 외 inbox.mjs 의 `[35]` 치수(72/352/64/272), `[38]` reduced-motion(`animationName 'none'`, `--t-enter '0ms'`), 나머지 동작 검사는 **그대로 통과해야 한다**. `#rail` 의 `border-right/border-bottom` 1px 은 border-box 라 offsetWidth/Height 를 바꾸지 않는다.

### 7.2 `lib/panel-check.js`
- 색·theme-color 단언은 **없다**(grep `theme-color|#[0-9a-f]{6}|rgb` 0건). 추가하지 않는다.
- 236행 `'/panel.css?v=12', '/panel.js?v=15'` → `'/panel.css?v=13', '/panel.js?v=15'` (캐시 버전 문자열 단언. panel.js 는 그대로 v=15).

### 7.3 HTML meta (5개 파일)
```html
<meta name="theme-color" content="#0B0E13">
<meta name="color-scheme" content="dark">
```
index/buy/my/order: 8행 교체 + 9행 `light`→`dark`. panel.html: 8행 교체 + 9행에 color-scheme 추가. `shots.mjs` 는 색을 단언하지 않으므로 변경 없음(스크린샷 재촬영만).

---

## 8. 수용 기준 (Playwright: `PW=/opt/pw-browsers/chromium-1194/chrome-linux/chrome node <script.mjs>`, `import pw from '/opt/node-tools/node_modules/playwright/index.js'`, `chromium.launch({ executablePath: process.env.PW })`. 페이지는 `scratchpad/behavior.mjs` 상단 10줄 정적 서버로 `public/` 을 http 서빙(`/`→index.html, `/panel`→panel.html) — file:// 은 `/style.css` 절대 경로를 못 푼다.)

대비 공식: `L = .2126R + .7152G + .0722B`, 각 채널 `c ≤ .03928 ? c/12.92 : ((c+.055)/1.055)^2.4`, `ratio = (max(L)+.05)/(min(L)+.05)`. computed `color` 와 그 요소에서 가장 가까운 불투명 `backgroundColor` 조상을 쓴다.

1. **토큰**: 두 파일 모두 `getComputedStyle(document.documentElement)` 에서 `--bg`=`#0B0E13`, `--card`=`#121620`, `--card2`=`#181D28`, `--accent`=`#3DDC97`, `--on-accent`=`#06110C`, `color-scheme`=`dark`. 두 `:root` 블록의 텍스트가 동일(diff 0).
2. **고정 computed 색**: 7.1 의 9개 값이 inbox.mjs 로 통과. 추가로 `/` 1280×900 에서 `body` backgroundColor `rgb(11, 14, 19)`, `.card` `rgb(18, 22, 32)`, `.btn.primary` color `rgb(6, 17, 12)`, `input[type=text]` backgroundColor `rgb(24, 29, 40)`; `/panel` 1280 에서 `.kkt-log` backgroundColor `rgb(15, 19, 26)`, `.rail-tip` `rgb(35, 42, 55)`, `#settings-acct` `rgb(24, 29, 40)`.
3. **대비**: 아래 쌍을 computed 로 뽑아 공식으로 계산, 전부 ≥4.5 — 사이트: `.lead`/`.hero`, `.prod .desc`/`.card`, `.hint`/`.card`, `.chk .t`/`.chk`, `.btn.primary`(color/bg), `.prices .pr[data-on="1"] .pv`/`.pr`, `.note.alert span`/`.note.alert`, `.sum .ln.total .v`/`.sum`, `footer.bot`/`body`, `input::placeholder`(`--ph`)/`input` 배경; 콘솔: `.kkt-prev`/`.kkt-list`, `.kkt-time`/`.kkt-list`, `.unread .kkt-time`, `.kkt-at`/`.kkt-log`, `.kkt-line.me .kkt-bubble`, `.kkt-line.them .kkt-bubble`, `.kkt-badge`, `.chip`, `.chip[aria-pressed="true"]`, `.tab[aria-current="true"]`(940·1280), `.strip`, `.thread-state[data-state="live"]`, `.rail-tip small`/`.rail-tip`, `.lead`/`.card`, `form.stack > label.check:first-child:has(input:checked)`, `.kkt-ava`(10색 AVA_COLORS 전부 ≥4.5). 비텍스트(레일 막대·점·링)는 ≥3.
4. **가로 스크롤 없음**: 360·390·430 뷰포트에서 `/`, `/buy`, `/my`, `/order`, `/panel`(로그인·inbox·room·settings 모드) 모두 `document.documentElement.scrollWidth === clientWidth`, `getBoundingClientRect().right > clientWidth+1` 인 요소 0개.
5. **히어로 거터**: 390 에서 `.hero h1`·`.hero .lead`·`.hero-cta` 의 `left === 16` (현재 0 → 수정 확인). 1280 에서는 `.wrap` 가운데 정렬 그대로.
6. **터치 44px**: 360 에서 `button, a.btn, .btn, .chk, .tab, .rail-btn, .icon-btn, .kkt-sendbtn, .chip, nav a, input, select, details.faq summary` 중 보이는 요소 전부 `height ≥ 44`(`.btn.sm` 은 폰 규칙 1661 로 44, `.account-actions .btn` 1691 로 44). 폭은 아이콘 버튼 44, 레일 48.
7. **UI_V4 치수**: 1280 `#rail.offsetWidth 72`, `.kkt-list.offsetWidth 352`; 1024 `--list-w 320`; 940 `64 / 272`, `#tabs` row; 390 `#rail.offsetHeight 64`, `#rail` flex-direction row, `--top-h` `53px`.
8. **애니메이션 속성**: 두 파일의 `document.styleSheets` 전수에서 `CSSKeyframesRule` 의 모든 키프레임 선언이 `transform`·`opacity` 만 포함 — 예외는 이름이 `kkt-bump` 인 규칙 1개(background-color). 모든 `CSSStyleRule` 의 `transition-property` 토큰 집합 ⊆ `{transform, opacity, color, background, background-color, border-color, box-shadow, visibility, border-radius}` — 예외는 `.bar > i`(width) 1개. `width/height/margin/padding/top/left/right/bottom/font-size` 를 transition 하는 규칙은 그 외 0개. 모든 `animation-duration` 은 `120ms–320ms` 범위 또는 `{2.4s pulse, 1.3s shimmer, .75s sp, 1.25s dot, 400ms kkt-bump}`.
9. **등장은 1회**: `/panel` 1280 inbox 모드에서 10초 간격 두 번 `document.querySelectorAll('[class*="kkt-row"], .rail-acct, .kkt-badge, .rail-badge')` 의 computed `animationName` 이 전부 `none`(bump 중이 아닐 때). 처음 열린 대화의 `.kkt-line` 에 `.enter` 없음; 새 메시지 1건 추가 후 3초 내 `.kkt-line.enter` 가 정확히 1개.
10. **reduced motion**: `reducedMotion:'reduce'` 컨텍스트에서 `--t-enter`·`--t-slow`=`0ms`, `.kkt-line.enter`·`.hero > *`·`#prods > .card.prod`·`#console`·`#login.card` 의 `animationName === 'none'`, `.rail-acct[data-state="live"] .rail-dot::after` 의 `display === 'none'`, `.dots i` opacity .75. inbox.mjs [38] 통과.
11. **글로우 예산**: `/panel` 1280 inbox(대화 열림, 입력 비어 있음)에서 computed `box-shadow` 에 `rgba(61, 220, 151` 가 포함되고 blur ≥ 10px 인 보이는 요소 ≤3(허용: 레일 현재 막대, 주 버튼, 새 메시지 알약). `.kkt-badge`·`.rail-badge`·`.chip`·`.kkt-line.me .kkt-bubble`·`.kkt-row[aria-current="true"]::before` 의 box-shadow 에는 `61, 220, 151` 이 없다.
12. **레일 막대**: `.rail-acct[aria-current="true"]::before` 의 computed `transform` 이 1280 에서 `matrix(1, 0, 0, 1, 0, -18)`(scaleY 1), 비현재 행은 scaleY .22 → `matrix(1, 0, 0, 0.22, 0, -3.96)`; 390 에서 현재 `matrix(1, 0, 0, 1, -18, 0)`, 비현재 `matrix(0.22, …)`. `transition-property` 에 `height`·`width` 없음.
13. **meta**: 5개 HTML 에 `theme-color` `#0B0E13`, `color-scheme` `dark`; `style.css?v=5`(4개), `panel.css?v=13`(panel.html); `lib/panel-check.js` 236행 문자열 일치.
14. **콘솔 오류 0**: 위 모든 페이지·뷰포트에서 `page.on('console')` error 0, `pageerror` 0, 404 리소스 0.
15. **기존 스위트 통과**: `npm run check`(lib/panel-check.js 포함), `PW=… node scratchpad/inbox.mjs`, `scratchpad/behavior.mjs`, `scratchpad/smoke.mjs` 전부 녹색. `shots.mjs` 재촬영 결과(desk-inbox/phone-settings 등)를 PR 에 첨부.
16. **파일 범위**: `git diff --stat` 에 `public/panel.js` 가 없다. `public/app.js` diff 는 643행 1줄뿐. HTML diff 는 meta·link 줄뿐(index/buy/my/order 각 3줄, panel 3줄).

---

## 9. 구현 분담 (두 명 병렬, 파일 겹침 없음)

**공통**: 둘 다 2장의 `:root` 블록(reduced-motion 토큰 줄 포함)을 글자 그대로 붙인다. 6.1 키프레임 중 자기 파일 몫을 정의한다. 작업 전 `PW=… node scratchpad/inbox.mjs` 로 현재 녹색을 확인하고, 끝에 8장 전 항목을 돌린다.

### (a) PUBLIC — `public/style.css`, `public/index.html`, `public/buy.html`, `public/my.html`, `public/order.html`, `public/app.js`
1. style.css 4–37 `:root` → 2장 블록. 1–2행 주석의 "밝은 바탕" → "다크 바탕(DARK_V1)".
2. 47–95 기본(4.1), 98–129 머리글(3.1), 131–161 타이포·히어로(4.3, **`.hero` 패딩 버그 수정**), 163–232 카드·상품(4.4), 235–289 체크·세그(3.4·4.5), 292–314 버튼(3.2), 317–329 칩(3.7), 332–361 폼(3.3), 363–467(4.7), 469–605(4.8), 607–617 → 6.4 사이트 블록 + 키프레임 `rise check-pop`(기존 `dot sp shimmer` 는 제자리).
3. 4개 HTML: meta 2줄, `style.css?v=5`. 인라인 스타일은 4.10 표대로 **손대지 않는다**.
4. app.js 643행 1줄.
5. 검증: 8장 1–6, 8, 10(사이트 부분), 11 아님, 13, 14, 15(behavior/smoke 중 사이트 쪽), 16. 360/390/1280 스크린샷(`/`, `/buy`, `/my`, `/order`) 첨부.

### (b) CONSOLE — `public/panel.css`, `public/panel.html`, `scratchpad/inbox.mjs`, (`scratchpad/shots.mjs` 재촬영만), `lib/panel-check.js` 236행(캐시 버전 문자열)
1. panel.css 6–97 `:root` + reduced-motion 토큰 줄 → 2장 블록(1573/1578/1596 의 분기 치수 재정의는 그대로). 1–4행 주석 "밝은 바탕" → "다크 바탕(DARK_V1)".
2. 98–132(5.1), 137–209(3.1), 214–375(5.3, 3.3–3.6), 378–456(3.2·3.8), 459–594(5.5), 597–633(5.6), 641–843(5.7, **막대 scaleY/scaleX**), 846–1182(5.8), 1185–1441(5.9), 1444–1519(5.10), 1522–1705(5.11), 1708–1711 → 6.4 콘솔 블록 + 키프레임 `rise pop check-pop pulse kkt-in pill-in kkt-bump` 한 곳.
3. panel.html: meta 2줄, `panel.css?v=13`. lib/panel-check.js 236행 `'/panel.css?v=13'`.
4. inbox.mjs 530–534 · 663–664 · 800–801 을 7.1 의 새 줄로.
5. 검증: 8장 1–4, 6–12, 13, 14, 15(`npm run check`, inbox.mjs, behavior.mjs), 16. `shots.mjs` 로 desk-inbox / desk-settings / phone-list / phone-room / phone-settings / tab-inbox 재촬영 첨부.

**금지**: `public/panel.js` 수정(배지 pop·펄스·등장은 전부 기존 `.bump`·`data-state`·id 에 CSS 로 건다), DOM/id/class/data 속성 변경, 문구 변경, 외부 폰트/CDN/프레임워크, `#000` 큰 면, 글로우 추가(4번 규칙 목록 밖), width/height 트랜지션 추가, 재렌더 노드에 keyframe.