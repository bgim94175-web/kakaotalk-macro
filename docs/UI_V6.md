# UI V6 — 안드로이드 앱 폐기, 사이트 전용 운영 명세

- 작성: 2026-10-09. 상태: 구현 대기.
- 범위: 콘솔(`/panel`) 새 화면 2개(대화방 관리봇·미니게임)와 잠금 상태, 서버·발송 자식(sender) 변경, 새 웹 관리자(`/admin`), 공개 사이트 문구 정리, 앱 전용 코드·문서 삭제, 테스트, 4명 동시 구현 분담.
- 우선순위: 이 문서 > `docs/UI_V5.md` > `docs/UI_V4.md`. 이 문서가 다루지 않는 디자인 토큰·셸·모션·DOM 규칙은 UI_V5를 그대로 따른다(2장 토큰, 4.3 셸, 4.14 저장 바, 4.15 공통 컴포넌트, 5장 모션, 6장 모바일, 7장 접근성).
- 문구: `docs/TONE.md`(합니다체·명사형, 버튼 2~5자, 오류 = 현상 + 조치, 용어표)와 `docs/BRAND.md`(`K bot`). 화면 문구는 이 문서에 적힌 그대로 쓴다. 적히지 않은 문구를 새로 만들 때도 TONE.md를 따른다.
- 줄 번호는 2026-10-09 작업 트리 기준이다. 다른 에이전트가 `public/*`를 고치는 중이라 `public/` 파일의 줄 번호는 달라질 수 있다. 줄 번호 대신 id·함수 이름으로 찾는다.

---

## 0. 한눈에

| 항목 | 결정 |
|---|---|
| 안드로이드 사용자 앱 (`android/auto`) | 저장소에서 삭제. 앱 API(`/verify` `/heartbeat` `/entitlements` `/config` `/pubkey`)는 410 안내 응답만 남긴다(3.7). |
| 안드로이드 관리자 앱 (`android/admin`) | 삭제. 같은 일을 하는 웹 관리자 `/admin`을 새로 만든다(4장). |
| 대화방 관리봇 상품 | 콘솔 `#roombot` 화면. 서버(sender)에 이미 있는 엔진을 실제로 동작하게 고치고, 휴대폰에만 있던 기능을 옮긴다(2.4, 3.6). |
| 미니게임봇 상품 | 콘솔 `#minigame` 화면. 기능은 그대로 유지하고, 설정 화면에서 시연을 보여 준다(2.5). |
| 시연 | 설정을 바꾸면 바로 바뀌는 대화 시연. 시연 답장은 **실제 봇 코드**(sender의 같은 함수)가 계산한다(`POST /panel/api/bots/simulate`, 2.3·3.3). 입력 중 즉시 바뀌는 문구 미리 보기는 화면에서 계산한다. |
| 라이선스 | 콘솔 로그인은 3개 기능 중 하나라도 있으면 된다. 산 기능만 열리고, 없는 기능 화면은 잠금 카드 + 구매 링크(2.1). 서버도 같은 규칙으로 막는다. |
| 기간 만료·회수 후 발송 | 지금은 앱 하트비트 말고는 막는 곳이 없다. 부모 서버가 10분마다 키 상태를 sender에 밀어 넣는다(3.5). |
| 보안 수정 | `/verify`가 모든 앱 사용자에게 `SENDER_TOKEN`을 내려 주고 `/v1/*`가 공개 프록시로 열려 있다. 프록시를 없애고 배포 뒤 `SENDER_TOKEN`을 새 값으로 바꾼다(3.7). |
| 공개 사이트 | 안드로이드 전용 경고, 앱 설치 안내, 안드로이드 확인 체크박스, 기기 1대 문구를 없애고 콘솔 기준으로 다시 쓴다(5장). 구매·조회·주문 로직과 id는 유지. |
| 분담 | A 백엔드 · B 콘솔 · C 관리자 · D 사이트. 파일이 겹치지 않는다(8장). |

---

## 1. 결정 요약과 범위

### 1.1 사용자 결정 (원문)

1. 전체 방향: "안드로이드 앱은 완전히 없애고 사이트로만 운영할거야"
2. 관리자 앱: "웹 관리자 페이지로 옮기기"
3. 상품: "미니게임봇 기능은 웹 콘솔로 옮겨야해 기능은 제대로 유지하고 지금 방식처럼 기능설정할때 데모를 보여주는게 정말 좋은것 같아."
4. 안드로이드 코드: "저장소에서 삭제"

### 1.2 해석과 이 명세의 답

| 결정 | 이 명세의 답 |
|---|---|
| 앱을 완전히 없앤다 | `android/` 전체와 `.github/workflows/build-apk.yml` 삭제(6.1). 앱만 쓰던 서버 코드(서명 검증, 기기 고정, 세션 회전, 앱 서명 허용목록, 최소 버전, 공개 `/v1` 프록시) 삭제(3.7). DB 테이블·열은 지우지 않는다(`lib/db.js`는 DROP 금지). |
| 사이트로만 운영 | 판매하는 기능 3종(매크로·대화방 관리봇·미니게임봇)을 모두 콘솔에서 설정한다. 콘솔에 들어오는 조건을 "매크로 보유"에서 "기능 하나 이상 보유"로 바꾼다(2.1, 3.1). |
| 웹 관리자로 옮긴다 | 관리자 앱의 4개 탭(키·주문·입금·기록)과 통계·설정을 `/admin` 한 페이지로 옮긴다. 비밀번호는 브라우저에 저장하지 않고 HttpOnly 쿠키 세션을 쓴다(4장). 앱에서 막혀 있던 일(자동취소 주문 복구, 메모 수정, 입금 무시 되돌리기, 발급 대기 주문 탭)도 연다. |
| 미니게임 기능 유지 | sender의 미니게임 엔진은 앱과 같은 규칙·같은 데이터(단어 691개, 퀴즈 79개)다. 앱에만 있던 것(설정 화면, 점수·진행 상태, 초기화 2종, 명령 목록, 3초 쿨타임 하한, 하루 한도 기본값, 더 친절한 답장 문구)을 옮긴다(2.5, 2.7, 3.6). |
| 설정할 때 데모 | 미니게임과 관리봇 화면 오른쪽에 "대화 시연"을 둔다. 장면 버튼을 누르거나 참여자처럼 직접 입력하면, 지금 화면의 설정(저장 전 값)으로 봇이 무엇을 보낼지 그대로 보여 준다. 각 문구 칸 아래에는 입력할 때마다 바뀌는 미리 보기 말풍선을 둔다. V5의 올킥 미리 보기·갠톡 응답 미리 보기와 같은 문법이다(2.3). |
| 대화방 관리봇 | 사용자는 미니게임만 콕 집었지만 관리봇도 판매 중인 상품이고 지금은 앱에서만 동작한다. 앱이 없어지면 구매자가 쓸 곳이 없으므로 같은 방식으로 옮긴다(2.4). |

### 1.3 범위 밖

- 디자인 토큰·셸의 변경(V5 그대로).
- 콘솔 기존 7개 화면의 동작 변경(문구 2곳과 잠금 상태만 바꾼다, 2.8).
- 결제 수단·가격 변경. 가격은 그대로 `/api/price`.
- 운영 설정(자동 승인, 입금 계좌)을 웹에서 바꾸는 기능. 이번에는 읽기 전용으로 보여 준다(4.3 A16, 부록 C 질문 4).
- 앱에 저장돼 있던 고객 설정의 이전. 앱 설정은 휴대폰 안에 AndroidKeyStore로 잠겨 있고 서버로 보낸 적이 없어 옮길 방법이 없다. 고객에게 다시 설정하라고 안내한다(1.6).

### 1.4 정해 둔 것

| # | 결정 | 이유 |
|---|---|---|
| D1 | 콘솔 로그인: 키가 회수·차단되지 않았고, 기능 행 중 하나라도 `expires_at > now`이면 통과. 하나도 시작되지 않았으면 첫 로그인이 모든 미개시 기능을 시작한다(지금 `startPeriod`와 같음). | 미니게임·관리봇만 산 고객이 지금은 콘솔에 못 들어온다. |
| D2 | 기능별 화면 잠금. 매크로 = 주요 알림 + 기존 7개 화면(매크로·입장·퇴장 로그·프로필 로그·올킥 방지·금지어 검열·갠톡 응답·저격 규칙). 대화방 관리봇 = `#roombot`. 미니게임봇 = `#minigame`. 개요·계정·계정 추가는 모든 키. | 지금도 이 7개는 매크로 키만 쓸 수 있다(로그인이 매크로를 요구). 상품 경계를 바꾸지 않는다. |
| D3 | 서버가 같은 규칙으로 막는다: 설정 저장, 주요 알림·대화 읽기·답장, 기록 읽기, 봇 기록·초기화는 해당 기능이 없으면 403 `{need}`. | 화면만 막으면 API로 우회된다. |
| D4 | sender의 `record.features`는 라이선스 그대로 `{macro, roombot, minigame}`(true/false). 지금처럼 "이전 값이 true여야 켜짐"이 아니다. | 지금 규칙으로는 웹에서 관리봇·미니게임을 영원히 켤 수 없다. |
| D5 | 입장·퇴장 로그, 프로필 로그, 올킥 방지, 금지어 검열도 sender에서 `features.macro`로 막는다(지금은 막지 않음). | 기간이 끝난 키가 계속 동작하지 않게(D6). |
| D6 | 부모 서버가 10분마다 `panel_accounts`의 키별 기능 상태를 sender에 밀어 넣는다. 관리자 회수·차단·삭제·기능 회수·기간 추가 직후에는 그 키만 즉시. | 앱 하트비트가 유일한 차단 장치였다. |
| D7 | `keys.grant()`의 "활성화됨" 판정을 `device_id`에서 "`activated_at`이 있거나 이미 시작된 기능이 있음"으로 바꾼다. 콘솔 로그인(`/panel/api/me`)은 남은 미개시 기능을 시작한다. | 콘솔만 쓰는 키에 기능을 추가하면 영원히 시작되지 않는 버그. |
| D8 | 시연 답장은 서버의 실제 봇 함수로 계산한다(`/v1/simulate`). 화면에 봇 문장을 복제하지 않는다. 다만 문구 칸 미리 보기(토큰 바꾸기)와 잠금 화면·서버 중지 때의 대본 시연은 화면이 그린다. 그 대본은 부록 A 문장과 글자 하나 다르지 않게 쓰고 `lib/v6-check.js`가 대조한다. | "지금 방식처럼" 정확한 시연. 두 벌 코드가 어긋나지 않게. |
| D9 | 관리봇 기본 금지어 경고문은 앱 문장(`금지어가 감지되었습니다`)으로 바꾼다. 서버 문장은 금지어를 방에 다시 적어 올린다. | 욕설·경쟁사 링크를 봇이 되풀이하지 않게. |
| D10 | 대화방 선택은 오픈채팅방만(V5와 같음). 앱은 일반 그룹방·1:1 방도 골랐다. | V5 콘솔 규칙·`panel-check` 단언과 같게. 필요하면 부록 C 질문 1. |
| D11 | 관리봇의 "들낙 방지"는 이름을 `반복 입·퇴장 감지`로 바꿔 옮긴다. | `들낙 방지`는 V5에서 폐기한 이름이고 `panel-check`가 금지한다. |
| D12 | config.guard의 숨은 칸(환영·도배 감속·입퇴장 폭주·접속 유지·정기 공지)은 화면에 내놓지 않고 손대지 않는다. 같은 일은 관리봇이 한다. | 두 엔진이 같은 일을 다른 규칙으로 하면 고객이 헷갈린다. 저장값은 보존(`sanitizeGuard`가 그대로 둔다). |
| D13 | 관리자 비밀번호 헤더(`x-admin-password`)는 스크립트용으로 남긴다. 브라우저는 쓰지 않는다. | 4.2. |
| D14 | 웹 관리자 페이지 주소는 `/admin`, API는 그대로 `/admin/*`. | 운영자가 기억하기 쉽고, 쿠키 범위(`Path=/admin`)가 API와 페이지를 정확히 덮는다. 4.1에서 레이트리밋·라우터 충돌을 정리한다. |
| D15 | 앱 API 경로는 410 `app_retired` 안내만 남긴다(서명 없음). | 설치된 앱이 "서버 오류" 대신 종료 사실을 받는다. 6개월 뒤 경로째 지워도 된다. |
| D16 | 퀴즈 문장(`sender/data/quiz.json`)을 합니다체로 고친다. 순서·정답은 그대로. | 봇이 방에 올리는 사용자 노출 문구(TONE.md). 순서를 바꾸면 `runtime.asked` 번호가 틀어진다. |

### 1.5 이름표 추가 (V5 1.4에 더한다)

| route | 화면 이름 | 한 줄 설명(개요 표·팔레트) | `account` 키 | 단축키 | 필요한 기능 |
|---|---|---|---|---|---|
| `roombot` | 대화방 관리봇 | 인사·경고·공지·명령 | `roombot` | G B | `roombot` |
| `minigame` | 미니게임 | 방에서 하는 게임과 점수 | `minigame` | G G | `minigame` |

- 기존 줄의 "필요한 기능": `inbox` 및 `macro` `visit` `profile` `guard` `cover` `reply` `snipe` = `macro`. `overview` `accounts` `account-add` = 없음.
- 상품 이름(사이트·구매·관리자): `자동발송 매크로` · `대화방 관리봇` · `미니게임봇`(`lib/features.js` `LABELS` 그대로). 콘솔 화면 이름은 `대화방 관리봇` · `미니게임`.
- 새 상태 라벨: `구매 필요`(기능 없음), `기간 만료`(기능 있었으나 끝남), `동작 보류`(켜져 있으나 방·게임 미선택).
- 웹 관리자 화면 이름: `개요` `주문` `입금` `키` `기록` `설정`. 페이지 제목 `관리자 · K bot`.

### 1.6 배포 순서와 고객 안내

1. 한 번의 배포로 A·B·C·D를 함께 올린다(서로 의존한다: 콘솔 새 화면은 새 API가, 관리자 페이지는 새 인증이, 사이트 문구는 콘솔 기능이 있어야 맞다).
2. 배포 직후 운영자가 할 일(`DEPLOY.md`에 A가 적는다):
   - Render 대시보드에서 `SENDER_TOKEN`을 새 무작위 값으로 바꾸고 재배포(유출된 값 폐기). 부모와 자식이 같은 환경변수를 읽으므로 다른 설정은 필요 없다.
   - 대시보드에서 `SIGNING_PRIVATE_KEY` `APP_SIG_MODE` `ALLOWED_APP_SIGS` `MIN_APP_VERSION` `SENDER_PUBLIC_URL`를 지운다(코드가 더 읽지 않는다).
   - `/admin`에 로그인해 대기 주문·입금이 보이는지 확인.
3. 고객 안내(운영자가 카카오톡·연락처로 보낸다. 문안은 `DEPLOY.md`에 A가 넣는다):
   > K bot은 이제 웹 콘솔로만 운영합니다. 휴대폰 앱은 더 이상 동작하지 않습니다. 같은 키로 https://(서비스 주소)/panel 에 로그인하면 남은 기간 그대로 사용합니다. 앱에 저장했던 설정은 옮겨지지 않으므로 콘솔에서 다시 설정하십시오. 대화방 관리봇과 미니게임봇도 콘솔에서 설정합니다.
4. 콘솔 개요에는 예전 앱 사용자(키에 `device_id`가 남아 있음)에게만 한 번 보이는 안내 띠를 둔다(2.2 `#ov-legacy`).

---

## 2. 콘솔 새 화면 — 대화방 관리봇 · 미니게임

### 2.1 라이선스와 잠금

**`GET /panel/api/me` 응답에 더하는 것**(3.3):

```json
{
  "features": {
    "macro":    { "owned": true,  "on": true,  "started": true,  "expires_at": 1767225600000 },
    "roombot":  { "owned": false, "on": false, "started": false, "expires_at": null },
    "minigame": { "owned": true,  "on": false, "started": true,  "expires_at": 1759276800000 }
  },
  "buy": { "macro": "https://…/buy?feature=macro&key=KAKA-…", "roombot": "…", "minigame": "…" },
  "legacy_app": false
}
```

- `owned` = 그 기능 행이 있음, `on` = `expires_at > now`, `started` = `expires_at`이 있음. `expires_at`(최상위)은 켜진 기능 중 **가장 먼저 끝나는** 만료 시각(사이드바 `#licLeft`가 쓴다. 남은 기간 경고는 가장 급한 것을 보여 준다). `#licLeft`의 `title`은 기능마다 한 줄: `자동발송 매크로 2026.12.31 만료` 등.

**화면 잠금 규칙**(`panel.js`):

```js
var ROUTE_LIC = { inbox: 'macro', macro: 'macro', visit: 'macro', profile: 'macro', guard: 'macro',
  cover: 'macro', reply: 'macro', snipe: 'macro', roombot: 'roombot', minigame: 'minigame' };
function licState(f) { var x = me && me.features && me.features[f]; return !x || !x.owned ? 'none' : x.on ? 'on' : 'expired'; }
```

- `licState(ROUTE_LIC[route]) !== 'on'`이면 그 `section.page`에 `data-locked="true"`, 아니면 속성 삭제. 잠긴 화면은 `[data-lockable]`(폼·기록 묶음)을 `hidden`, `.lock`을 보인다. 잠긴 화면은 저장 바를 쓰지 않는다(`formState`를 기준값과 비교하지 않음).
- 사이드바: 잠긴 항목의 `.fs`에 `lock` 클래스(점 대신 자물쇠 아이콘 `i-lock` 10px, `--fg-3`), `.nav-a[aria-description]` = `구매 필요` 또는 `기간 만료`. 이동은 막지 않는다(잠금 카드를 보여 준다).
- 개요 기능 표: 잠긴 행 `.feat.locked` — 스위치 자리에 `a.btn.sm[data-buy="{feature}"]` `구매`(만료면 `연장`), 요약 칸 `구매 필요`/`기간 만료 · YYYY.MM.DD`(`--fg-3`). 행 클릭은 그 화면(잠금 카드)으로.
- 주요 알림이 잠기면 `#inbox` 대신 잠금 카드를 보여 주고 `/panel/api/inbox` 폴링을 하지 않는다. `#navUnread`는 숨긴다.
- 팔레트: 잠긴 화면의 `설정` 묶음 항목은 숨긴다. `이동` 항목은 남기고 보조 글자 `구매 필요`.
- `me`는 부팅 때, `visibilitychange`로 다시 보일 때, 5분마다 다시 읽는다(구매 직후 잠금이 풀리도록). 다시 읽어 잠금 상태가 바뀌면 현재 화면을 다시 그린다(진입 모션 없음).
- 서버가 403 `{need: "roombot"}` 등을 주면(다른 창에서 기간이 끝난 경우) `me`를 다시 읽고, 토스트 kind `crit` `{상품 이름} 기능이 없는 키입니다.` + `구매 후 사용할 수 있습니다.`

**잠금 카드** — 잠길 수 있는 화면마다 제목(`.ph`) 바로 아래 하나:

```html
<div class="lock" data-lock="roombot" hidden>
  <div class="lock-h">
    <span class="lock-ic" aria-hidden="true"><svg class="ic" width="16" height="16"><use href="#i-lock"></use></svg></span>
    <div><b class="lock-t">대화방 관리봇은 구매 후 사용할 수 있습니다</b>
      <p class="lock-d">선택한 오픈채팅방에서 입·퇴장 인사, 금지어·링크·도배 경고, 공지와 명령 응답을 합니다.</p></div>
  </div>
  <ul class="lock-pts"><li>…</li></ul>
  <div class="lock-demo"><!-- 2.3 대화 시연(읽기 전용) --></div>
  <div class="lock-f"><a class="btn primary" data-buy="roombot" href="">구매하기</a>
    <span class="hint">구매 신청 화면의 기존 키 칸에 이 키가 들어갑니다. 결제가 확인되면 이 화면이 열립니다.</span></div>
</div>
```

| `data-lock` | `.lock-t` (없음 / 만료) | `.lock-d` | `.lock-pts` | `.lock-demo` |
|---|---|---|---|---|
| `macro` (7개 화면 + 주요 알림 공통) | `자동발송 매크로는 구매 후 사용할 수 있습니다` / `자동발송 매크로 사용 기간이 끝났습니다 · {YYYY.MM.DD} 만료` | `주기 발송, 갠톡 응답, 저격 규칙, 입장·퇴장 로그, 프로필 로그, 올킥 감지, 금지어 검열이 포함됩니다.` | `방마다 간격을 정해 홍보 메시지 발송` · `모든 계정의 1:1 대화를 주요 알림에서 읽고 답장` · `입장·퇴장과 닉네임 변경 기록, 올킥 감지` · `욕설·금지어·링크가 들어간 글 가림` | 없음 |
| `roombot` | `대화방 관리봇은 구매 후 사용할 수 있습니다` / `대화방 관리봇 사용 기간이 끝났습니다 · {날짜} 만료` | 위 표 | `입장·퇴장 인사({이름} {방} 넣기)` · `금지어·링크·도배 경고, 3회 누적 시 관리자 호출` · `!공지 · !규칙 · !경고 명령과 공지 자동 발송` · `반복 입·퇴장 감지와 인사 생략` | 관리봇 대본 시연(2.3) |
| `minigame` | `미니게임봇은 구매 후 사용할 수 있습니다` / `미니게임봇 사용 기간이 끝났습니다 · {날짜} 만료` | `끝말잇기, 숫자야구, 주사위, 가위바위보, 퀴즈를 방에서 명령어로 진행하고 방마다 점수를 기록합니다.` | `끝말잇기 · 사전 691단어, 두음법칙 처리` · `숫자야구 · 주사위 · 가위바위보` · `퀴즈 79문항` · `방마다 점수와 !랭킹` | 미니게임 대본 시연(2.3) |

- 버튼 글자: 없음 `구매하기`, 만료 `연장하기`. `href` = `me.buy[feature]`.
- 스타일: `.lock` = `section.sec` 모양(`--bg-1`, `--line-2` 테두리, 반경 `--r-4`, 안쪽 여백 24px), `.lock-ic` 32px 네모 `--bg-3`. `.lock-pts`는 `--fg-2` 13px, 앞에 `--fg-4` 점. 색은 토큰만.

### 2.2 셸·개요·팔레트 변경

**사이드바** — `K bot 설정` 묶음(7개) 다음에 묶음 하나를 더한다:

```html
<p class="nav-cap"><span>봇</span><span>별도 상품</span></p>
<a class="nav-a" href="#roombot" data-r="roombot"><svg class="ic" width="16" height="16" aria-hidden="true"><use href="#i-roombot"></use></svg>대화방 관리봇<span class="r"><span class="kb" aria-hidden="true">G B</span><span class="dirty">수정됨</span><i class="fs" data-fs="roombot"></i></span></a>
<a class="nav-a" href="#minigame" data-r="minigame"><svg class="ic" width="16" height="16" aria-hidden="true"><use href="#i-game"></use></svg>미니게임<span class="r"><span class="kb" aria-hidden="true">G G</span><span class="dirty">수정됨</span><i class="fs" data-fs="minigame"></i></span></a>
```

- 스프라이트에 `i-roombot`(말풍선 + 방패), `i-game`(주사위), `i-lock`(자물쇠) `symbol`을 추가한다(16×16, `stroke-width 1.4`, 기존 아이콘과 같은 선 굵기).
- `featOn('roombot')` = `account.roombot.enabled`, `featOn('minigame')` = `account.minigame.enabled`. `.fs.on`은 켜짐 + 잠기지 않음일 때만.
- `ROUTES`에 `roombot: { t: '대화방 관리봇', acct: true, feat: 'roombot', sw: 'roombot-on', g: 'b', icon: 'roombot' }`, `minigame: { t: '미니게임', acct: true, feat: 'minigame', sw: 'minigame-on', g: 'g', icon: 'game' }`. `FEAT_ROUTES`에 두 route, `FEAT_ROUTE`에 `roombot: 'roombot', minigame: 'minigame'`, `GKEYS`에 `b: 'roombot', g: 'minigame'`. 저장 바 `#saveBtn.form` = `roombot-form` / `minigame-form`.
- G 단축키에 `g` 다음 `g`가 들어가므로, `g`를 누른 상태에서 다시 `g`를 누르면 미니게임으로 간다(1초 안).

**개요**(`#overview`):

- 기능 표에 두 행을 `triggers` 행 다음에 더한다(V5 4.4와 같은 모양):
  - `div.feat[data-feat="roombot"][data-go="roombot"]` — `b` `대화방 관리봇`, 보조 `인사·경고·공지·명령`, `data-rooms="roombot"`(`{n}개 방` / `방 없음`), `data-sum="roombot"`, 스위치 `input[data-ov="roombot"][aria-label="대화방 관리봇 사용"]`.
  - `div.feat[data-feat="minigame"][data-go="minigame"]` — `미니게임`, `방에서 하는 게임과 점수`, `data-rooms="minigame"`, `data-sum="minigame"`, `input[data-ov="minigame"][aria-label="미니게임 사용"]`.
- 요약(`data-sum`): 관리봇 = `인사 {입장·퇴장|입장|퇴장|꺼짐} · 금지어 {n}개{ · 링크 경고}{ · 공지 자동}`; 켜져 있는데 방이 없으면 `대상 대화방 미설정 · 동작 보류`(`--warn`). 미니게임 = `게임 {n}종 · 쿨타임 {s}초`; 게임 0종이면 `사용할 게임 미선택 · 동작 보류`, 방 없음이면 `대상 대화방 미설정 · 동작 보류`.
- 계정 목록의 `기능 {켜진 수}/7` → `기능 {켜진 수}/{열린 화면 수}`(잠기지 않은 기능 화면 수: 매크로 7 + 관리봇 1 + 미니게임 1).
- `#ov-attn`(확인 필요)에 행 추가: 켜진 기능 중 3일 안에 끝나는 것마다 `● {상품 이름} {n}일 후 만료` + `만료 후에는 이 기능의 발송과 응답이 멈춥니다.` + `a.btn.sm[data-buy]` `연장`(점 `.warn`). 이미 끝난 기능은 행을 만들지 않는다(잠금 카드가 대신한다).
- 즉시 저장 스위치(`featBody`): `roombot` = 현재 `account.roombot` 전체 + `enabled`, **`notice` 키는 빼고 보낸다**(2.9). `minigame` = 현재 `account.minigame` 전체 + `enabled`.
- `#ov-legacy`(새, `#ov-attn` 위): `me.legacy_app`이고 `localStorage['kb.legacy-ok']`가 없을 때만 보인다. `div.banner.info[role=status]`(바탕 `--bg-2`, 테두리 `--line-3`, 경고색 아님) `휴대폰 앱 지원이 종료되었습니다. 앱에 저장했던 설정은 옮겨지지 않으므로 기능 화면에서 다시 설정하십시오.` + `button.btn.sm#ov-legacy-ok` `확인`(누르면 저장하고 숨김, 저장 실패는 무시).

**팔레트**:

- `이동` 묶음에 `대화방 관리봇`(G B), `미니게임`(G G).
- `설정` 묶음(★ = 빈 입력에서 보임):

| 이름 | 위치 | 이동 대상 id |
|---|---|---|
| 입장·퇴장 인사 | 대화방 관리봇 | `row-roombot-welcome` |
| 금지어 경고 ★ | 대화방 관리봇 | `row-roombot-ban` (포커스 `rb-ban-in`) |
| 도배 경고 | 대화방 관리봇 | `row-roombot-flood` |
| 공지 | 대화방 관리봇 | `row-roombot-notice` |
| 관리자 명단 | 대화방 관리봇 | `row-roombot-admins` |
| 반복 입·퇴장 감지 | 대화방 관리봇 | `row-roombot-churn` |
| 사용할 게임 ★ | 미니게임 | `row-minigame-games` |
| 응답 쿨타임 | 미니게임 | `row-minigame-cool` |
| 명령어 앞글자 | 미니게임 | `row-minigame-prefix` |
| 명령어 앞글자 | 대화방 관리봇 | `row-roombot-prefix` |

- 기능이 꺼져 있어 행이 접혀 있으면 V5 4.3 규칙대로 메인 스위치로 가고 warn 토스트.

**로그인 화면 문구**(`#login .lead` 첫 줄 교체):
`라이선스 키로 들어갑니다. 키는 기기에 묶이지 않으며 PC와 휴대폰 브라우저에서 같은 키로 로그인합니다.` 둘째 줄(`사용 기간이 시작됩니다`)은 그대로.
- 해시 `#key=KAKA-XXXX-XXXX-XXXX`로 열리면(주문 완료 화면의 `콘솔 열기`, 5.4): 라우터보다 먼저 값을 읽어 로그인 화면 `#key`에 넣고 `history.replaceState(null, '', location.pathname)`. 이미 로그인 상태면 값은 버린다. 서버에는 보내지 않는다(해시는 요청에 실리지 않는다).

### 2.3 공통 컴포넌트 — 시연

#### 2.3.1 대화 시연 `.kchat`

관리봇·미니게임 화면 오른쪽(≥1180px, sticky) 또는 메인 스위치 묶음 바로 아래(<1180px)에 하나씩 둔다. 잠금 카드 안에는 읽기 전용으로 하나.

```html
<aside class="demo-col" aria-label="대화방 관리봇 시연">
 <div class="kchat" id="rb-demo">
  <div class="kchat-h"><span class="nm" id="rb-demo-room">동네모임</span><span class="demo-tag">시연 · 실제로 보내지 않습니다</span></div>
  <div class="kchat-sc" role="toolbar" aria-label="시연 장면">
    <button type="button" class="fchip" data-sc="join" aria-pressed="false">입장</button> …
  </div>
  <div class="kchat-log" id="rb-demo-log" role="log" aria-live="polite" aria-label="시연 대화"></div>
  <form class="kchat-in" id="rb-demo-form" autocomplete="off">
    <div class="sel"><select id="rb-demo-who" aria-label="보내는 사람"></select><svg class="ic" …><use href="#i-down"></use></svg></div>
    <input class="inp" id="rb-demo-text" maxlength="500" placeholder="참여자로 입력해 보기" aria-label="시연 입력">
    <button type="submit" class="btn sm" id="rb-demo-send">입력</button>
  </form>
  <div class="kchat-f"><span id="rb-demo-note">설정을 바꾸면 시연에 바로 반영됩니다. 저장해야 방에 적용됩니다.</span><button type="button" class="btn sm ghost" id="rb-demo-reset">시연 초기화</button></div>
 </div>
</aside>
```

말 줄(`.kchat-log` 안, JS가 그린다):

| 클래스 | 모양 | 내용 |
|---|---|---|
| `.kl.sys` | 가운데, 알약, `--bg-2`, `--fg-3` 12px | 카카오톡 시스템 줄. `하늘님이 들어왔습니다.` / `하늘님이 나갔습니다.` |
| `.kl.in` | 왼쪽, 위에 `span.who` 이름(`--fg-3` 11px) + `.bub`(`--bg-3`) | 참여자 말 |
| `.kl.bot` | 오른쪽, `.bub.me`(`--inv` 바탕) + `span.bub-meta.me` `{계정 @ 앞} · 봇` | 봇 답장. 줄바꿈 그대로(`white-space: pre-wrap`) |
| `.kl.note` | 가운데, 점선 테두리 `--line-3`, `--fg-3` 12px, 앞에 `i.dot` | 봇이 보내지 않은 이유·설명(아래 표) |
| `.kl.typing` | 오른쪽, 점 3개(`tdot` 재사용) | 서버 응답 기다리는 동안 |
| `.kl.gap` | 가운데 `--fg-4` 11px 구분선 | 시간 경과 표시 `31초 후` |

- 새 줄은 `msgIn`(V5)로 아래에서 올라오고, 한 장면 안의 줄은 220ms 간격으로 차례로 나타난다(동작 줄이기면 한 번에). 로그는 최근 40줄만 남기고 맨 아래로 스크롤(`scrollTop = scrollHeight`, 사용자가 위로 올려 둔 상태면 스크롤하지 않고 `.newpill` 대신 아무것도 하지 않음).
- 이름: 참여자 `하늘`, 관리자 = 관리자 명단 첫 이름(없으면 선택지 `관리자 (명단에 없음)`을 `disabled`로). 미니게임은 `하늘`과 `민지` 두 명.
- 시각: 한국시간 `HH:MM`, 날짜 `YYYY-MM-DD`(서버 `renderBot`·`renderReply`와 같음). `new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Seoul', … })`로 만든다.
- 방 이름: 화면에서 고른 첫 방 이름, 없으면 `동네모임`.

**실제 봇으로 계산**(정상 상태): 장면 버튼·입력·명령 칩을 누르면

```
POST /panel/api/bots/simulate
{ "device_id": "<현재 계정>", "feature": "roombot" | "minigame",
  "config": <formState(route) — 저장 전 값>,
  "room_name": "동네모임",
  "state": <직전 응답의 state, 처음엔 null>,
  "events": [ { "kind": "join" | "leave" | "msg", "who": "하늘", "text": "…", "dt": 0 } ] }
→ { "ok": true, "replies": [ { "i": 0, "text": "…" } ], "notes": [ { "i": 0, "code": "welcome_off" } ], "state": { … } }
```

- `events`는 최대 30개, `text`는 500자, `dt`는 앞 사건과의 간격(ms, 0~600000). 화면은 사건을 순서대로 그리고(`msg`는 `.kl.in`, `join`/`leave`는 `.kl.sys`), 같은 `i`의 `replies`를 그 사건 바로 아래에 `.kl.bot`으로, `notes`를 `.kl.note`로 그린다. `dt`가 10초 이상이면 사건 앞에 `.kl.gap` `{n}초 후` / `{n}분 후`.
- 요청 중에는 `.kl.typing`, 입력·장면 버튼은 그대로 두되 요청은 하나씩(줄 세우기). 응답이 늦게 와 그 사이 계정이 바뀌었으면 버린다.
- 실패(503·502·네트워크): `.kl.note` `시연 응답을 받지 못했습니다. 잠시 뒤 다시 시도하십시오.` 그리고 그 장면이 대본에 있으면 대본으로 대신 그린다(아래).
- `state`는 화면이 그대로 들고 있다가 다음 요청에 돌려준다(경고 횟수, 게임 진행, 점수가 이어진다). `시연 초기화`는 `state = null`, 로그 비움, 토스트 없음.
- 설정을 바꿔도 `state`는 유지한다. 단 방·앞글자를 바꾸면 초기화한다.
- 서버는 시연에서 쿨타임·하루 한도·계정 간 중복 방지를 적용하지 않는다(3.6 S16). 화면 `#…-demo-note`에 `시연에는 쿨타임과 하루 한도를 적용하지 않습니다.`를 함께 적는다(미니게임만. 관리봇은 위 기본 문장).

`notes[].code` → 화면 문장:

| code | 문장 |
|---|---|
| `off` | `{화면 이름}가 꺼져 있어 응답하지 않습니다.` (관리봇 `대화방 관리봇이`, 미니게임 `미니게임이`) |
| `no_room` | `대상 대화방이 없어 응답하지 않습니다.` |
| `welcome_off` / `leave_off` | `입장 인사가 꺼져 있어 보내지 않습니다.` / `퇴장 인사가 꺼져 있어 보내지 않습니다.` |
| `welcome_empty` / `leave_empty` | `입장 인사 문구가 비어 있어 보내지 않습니다.` / `퇴장 인사 문구가 비어 있어 보내지 않습니다.` |
| `churn_mute` | `반복 입·퇴장으로 보아 인사를 생략했습니다.` |
| `churn_listed` | `반복 입·퇴장 명단에 기록했습니다 ({n}회).` |
| `links_off` | `링크 경고가 꺼져 있어 응답하지 않습니다.` |
| `flood_off` | `도배 경고가 꺼져 있어 응답하지 않습니다.` |
| `flood_hold` | `같은 사람에게는 1분에 한 번만 도배 경고를 보냅니다.` |
| `game_off` | 없음(서버가 `「…」는 사용 중지 상태입니다.`를 보낸다) |
| `quiz_wrong` | `틀린 답에는 응답하지 않습니다.` |
| `ignored` | `봇이 응답하지 않는 말입니다.` |

**대본 시연**(잠금 카드, 서버 중지, 실패 대체): 화면에 고정한 장면별 줄 목록. 문장은 부록 A의 기본값 문장만 쓴다(사용자 설정을 쓰지 않는다). 잠금 카드는 들어올 때 첫 장면을 한 번 재생하고, 장면 버튼으로 다른 장면을 재생한다. 무한 반복하지 않는다(V5 5.5). 입력칸은 `disabled`, placeholder `구매 후 직접 입력해 볼 수 있습니다.`

#### 2.3.2 문구 미리 보기 `.tpl-prev`

문구를 쓰는 칸마다 아래에 둔다. V5 갠톡 응답 미리 보기(`.preview-chat`)와 같은 모양.

```html
<div class="preview-chat tpl-prev" id="rb-welcome-prev" aria-live="polite">
  <span class="kl-sys">하늘님이 들어왔습니다.</span>     <!-- 상황 줄, 칸마다 다름 -->
  <div class="bub me"></div>                             <!-- 바뀐 문장 -->
  <span class="bub-meta me">입장 인사 · a@</span>
</div>
```

- 입력할 때마다(`input`) 다시 그린다. 토큰 바꾸기는 서버 `renderBot`과 같다: `{방}` 방 이름, `{이름}` 시연 이름(비면 `누군가`), `{시간}` `HH:MM`, `{날짜}` `YYYY-MM-DD`, `{횟수}` 칸마다 정한 예시 수, `{금지어}` 첫 금지어(없으면 `금지어`). 같은 토큰은 모두 바꾼다.
- 비어 있을 때: 기본 문장이 있는 칸(금지어·링크·도배 경고문)은 기본 문장을 그리고 `bub-meta`를 `기본 문장 · a@`로. 기본 문장이 없는 칸(입장·퇴장 인사, 반복 입·퇴장 안내, 공지)은 말풍선 대신 `.kl-note` `문구를 입력하면 여기에 표시됩니다.`
- `{횟수}`가 없는 경고문에는 서버처럼 ` (경고 {n}회)`를 붙여 보여 준다. 경고 3회 예시에는 관리자 호출 줄(부록 A `RB-ADMIN-CALL`)도 붙인다.
- 문구 칸 위에 V5 갠톡 응답의 `div.tokens > button.tok[data-tok]`를 둔다(누르면 커서 자리에 넣기). 칸마다 쓸 수 있는 토큰만.

#### 2.3.3 시간 막대 `.kt` 재사용

V5 올킥 미리 보기(`.kt`, `.kt-strip`, `.kt-win`, `.kt-k`, `.kt-axis`, `.kt-res`)를 그대로 쓴다. 관리봇 도배·반복 입·퇴장, 미니게임 쿨타임에 쓴다. 각 화면의 고정 예시와 문장은 2.4·2.5.

#### 2.3.4 그 밖

- **칩 편집기**: V5 금지어 검열 `.chips`/`.wchip`/`.chips-meta` 그대로(Enter·쉼표·붙여넣기, IME 조합 중 Enter 무시, 빈 입력 Backspace 삭제, 중복 `shake`). 개수·길이 제한만 칸마다 다르다.
- **상태 알약** `.bstat`(새): `span.bstat[data-st="off|hold|on"]` > `i.dot` + 글자. `off` 점 기본, `hold` `--warn`, `on` `--live`. 화면 제목 아래 `.ph` 안에 둔다.
- **인라인 확인**: V5 계정 해제 확인 줄(`.confirm-in` 펼침)과 같은 문법. `confirm()` 금지.
- **오늘 발송 막대** `.meter`: `span.track > i`(가로 막대, `transform: scaleX(count/limit)`) + `span.mono` `{count} / {limit}`. 90% 이상 `--warn`.

### 2.4 대화방 관리봇 `#roombot`

저장: `roombot-form` submit → `POST /panel/api/settings` `{device_id, images_unchanged: true, roombot: {…}}`(본문 2.9). 기록: `GET /panel/api/bots`(2.4.5).

#### 2.4.1 마크업 골격

```html
<section class="page" data-route="roombot" id="page-roombot" aria-labelledby="roombot-title" hidden>
 <div class="col">
  <div class="ph"><div><h1 id="roombot-title" tabindex="-1">대화방 관리봇</h1>
      <p>선택한 오픈채팅방에서 입·퇴장 인사, 금지어·링크·도배 경고, 공지와 명령 응답을 합니다. 사람을 내보내지는 않습니다.</p>
      <span class="bstat" id="rb-status" data-st="off"><i class="dot"></i><span>미사용</span></span></div></div>
  <div class="banner" data-banner role="status" hidden></div>
  <div class="lock" data-lock="roombot" hidden>…2.1…</div>
  <div class="bot-grid" data-lockable>
   <section class="sec sec-main" aria-label="대화방 관리봇">…2.4.2 ①…</section>
   <aside class="demo-col" aria-label="대화방 관리봇 시연">…2.3.1 (#rb-demo)…</aside>
   <form id="roombot-form" class="stack" novalidate> …2.4.2 ②~⑦… <p class="errt" id="roombot-error" role="alert"></p></form>
  </div>
  <div class="grp" data-lockable>…2.4.5 기록…</div>
 </div>
</section>
```

- `.bot-grid`는 자식 3개(메인 묶음 · 시연 · 폼)의 격자다. ≥1180px: `grid-template-columns: minmax(0, 1fr) 360px; grid-template-areas: "main demo" "rest demo"; column-gap: 24px; row-gap: 24px; align-items: start`, `.demo-col { grid-area: demo; position: sticky; top: calc(var(--top-h) + 24px) }`, `.kchat-log` 높이 `min(52vh, 460px)`. <1180px: 한 열 `"main" "demo" "rest"`(시연이 메인 스위치 바로 아래), sticky 없음, `.kchat-log` 높이 360px(폰 320px).
- 메인 묶음은 폼 밖에 있다. V5 저장 흐름은 값을 id로 읽고(`formState`), 저장 바 `#saveBtn[form]`이 폼을 제출하므로 문제없다. 변경 추적 `input`·`change` 수신은 폼이 아니라 `section.page`에 단다(B 담당). 미니게임도 같은 틀이다.
- `#rb-status`(phone `statusText`와 같은 규칙): 꺼짐 `미사용`(`off`) / 켜짐 + 방 0 `대상 대화방 미설정 · 동작 보류`(`hold`) / 켜짐 `사용 중 · 대상 대화방 {n}개`(`on`). 저장된 값 기준(입력 중 값 아님).

#### 2.4.2 설정 — 묶음과 칸

모든 칸은 V5 `.srow` 문법. "dep" = 바로 위 스위치가 켜질 때 펼쳐지는 `.dep[data-dep]`(V5 5.3 옵션 펼침). 표의 `경로`는 저장되는 `config.roombot.*` 이름(본문 키와 같다).

**① 메인 묶음** `section.sec.sec-main[aria-label="대화방 관리봇"]`

| 행 id | 컨트롤 | 경로 | 기본 | 범위·검증 | 라벨 / 설명 |
|---|---|---|---|---|---|
| `row-roombot-on` (`.main`) | 스위치 `#roombot-on` | `enabled` | false | `=== true`만 켜짐 | `대화방 관리봇` / `켜면 아래에서 선택한 방에서 동작합니다. 끄면 응답을 멈추고 설정은 그대로 둡니다.` |
| `row-roombot-rooms` (dep, `.stack`) | 방 칩 `div.rooms#roombot-open` + `rooms-meta`(`data-rooms-count="roombot"`, `대화방 불러오기`) | `rooms` | [] | 오픈채팅방 키만(`pickKeys`) | `대화방` / `관리할 오픈채팅방을 선택합니다. 선택이 없으면 동작하지 않습니다.` |
| off-note (dep-off) | — | — | — | — | `대화방 관리봇이 꺼져 있습니다. 켜면 대화방과 인사·경고·공지 설정이 표시됩니다.` + `켜기` |
| `.sec-f` | — | — | — | — | `K bot은 강제퇴장, 초대 차단, 방 설정 변경을 하지 않습니다. 경고가 3회 쌓이면 관리자를 호출합니다.` |

켜져 있고 방이 0개면 방 칩 아래 `p.hint.warnline` `대화방을 선택하기 전까지 동작하지 않습니다.`(`--warn`).

아래 ②~⑦은 모두 `div.dep[data-dep="roombot-on"]` 안의 `.grp`.

**② 입·퇴장 인사** `h2.grp-t 입·퇴장 인사`

| 행 id | 컨트롤 | 경로 | 기본 | 범위·검증 | 라벨 / 설명 |
|---|---|---|---|---|---|
| `row-roombot-welcome` | 스위치 `#rb-welcome-on` | `welcomeOn` | false | bool | `입장 인사` / `들어온 사람에게 인사를 보냅니다.` |
| ↳ dep | `div.tokens`(`{이름}` `{방}` `{시간}` `{날짜}`) + `textarea.ta#rb-welcome-msg[maxlength=2000][rows=2]` placeholder `예: {이름}님, {방}에 오신 것을 환영합니다.` + `.tpl-prev#rb-welcome-prev`(상황 줄 `하늘님이 들어왔습니다.`, meta `입장 인사 · a@`) | `welcomeMsg` | '' | 2,000자. 켜져 있는데 비면 저장 막음: `입장 인사 문구를 입력하십시오.` | — |
| `row-roombot-leave` | 스위치 `#rb-leave-on` | `leaveOn` | false | bool | `퇴장 인사` / `나간 사람에게 인사를 보냅니다.` |
| ↳ dep | tokens + `#rb-leave-msg` placeholder `예: {이름}님, 안녕히 가십시오.` + `#rb-leave-prev`(상황 줄 `하늘님이 나갔습니다.`) | `leaveMsg` | '' | 2,000자. 켜져 있는데 비면 `퇴장 인사 문구를 입력하십시오.` | — |
| `row-roombot-churn` | 스위치 `#rb-churn-on` | `churnOn` | **true** | bool | `반복 입·퇴장 감지` / `같은 사람이 짧은 시간에 들어왔다 나가기를 반복하면 명단에 기록하고 인사를 생략할 수 있습니다. 내보내지는 않습니다.` |
| ↳ dep `row-roombot-churn-rule` | `.num#rb-churn-min`(분) + `.num#rb-churn-count`(회) + 문장 `p.sentence#rb-churn-sent` + `.kt#rb-churn-kt` | `churnMin` / `churnCount` | 10 / 4 | 1~180 / 2~20 | `기준` / `이 시간 안에 입장과 퇴장을 합쳐 이 횟수 이상이면 반복 입·퇴장으로 봅니다. 들어왔다 나가면 2회입니다.` |
| ↳ dep `row-roombot-churn-mute` | 스위치 `#rb-churn-mute` | `churnMute` | true | bool | `인사 생략` / 켜짐: `반복 입·퇴장인 사람에게는 인사를 보내지 않습니다.` 꺼짐: `인사를 그대로 보냅니다. 인사가 연달아 올라갈 수 있습니다.`(스위치에 따라 바뀜) |
| ↳ dep `row-roombot-churn-msg` | tokens(`{이름}` `{횟수}`) + `#rb-churn-msg[maxlength=500][rows=2]` placeholder `비워 두면 방에 올리지 않습니다.` + `#rb-churn-prev`(상황 줄 `하늘님이 들어왔습니다.`, `{횟수}` 예시 4) | `churnMsg` | '' | 500자, 선택 | `대화방 안내` / `반복 입·퇴장이 확인되면 방에 1회 올립니다. 비워 두면 명단에만 기록합니다. 당사자를 지목하는 안내이므로 필요할 때만 쓰십시오.` |
| `.sec-f` | — | — | — | — | `카카오톡의 입장·퇴장 알림을 기준으로 보냅니다. 이름을 알 수 없으면 {이름} 자리에 「누군가」가 들어갑니다. 입장·퇴장 로그의 [입장안내]와 따로 동작하므로, 둘 다 켜면 두 메시지가 모두 올라갑니다.` |

반복 입·퇴장 막대(`#rb-churn-kt`): 고정 예시 = 한 사람의 사건 `[-540 입장, -420 퇴장, -300 입장, -180 퇴장, -60 입장]`초. 보이는 범위 `max(10분, churnMin × 1.5)`. 창 폭 = `churnMin`. 창 안 사건 수 ≥ `churnCount`이면 `.hit`, 결과 `● 창 안의 입·퇴장 {n}회 · 반복 입·퇴장으로 기록합니다{인사 생략이면 ' · 인사 생략'}`, 아니면 `○ 창 안의 입·퇴장 {n}회 · 기준 미만입니다`. 눈금은 입장 `i.kt-k`(위로 34px), 퇴장 `i.kt-k.down`(아래로, `--fg-3`). 문장 `#rb-churn-sent` = `<b>{m}분</b> 안에 입장과 퇴장을 합쳐 <b>{n}회</b> 이상이면 반복 입·퇴장으로 봅니다.`

**③ 금지어 · 링크** `h2.grp-t 금지어 · 링크`

| 행 id | 컨트롤 | 경로 | 기본 | 범위·검증 | 라벨 / 설명 |
|---|---|---|---|---|---|
| `row-roombot-ban` | 칩 `div.chips#rb-ban-words` + `input#rb-ban-in[maxlength=30][placeholder="단어 입력"]` + `.chips-meta`(`span.errt#rb-ban-err` + `span.mono#rb-ban-cnt` `{n} / 60`) | `banWords` | [] | 단어 1~30자, 최대 60개, 대소문자 무시 중복 제거. 오류 문구는 금지어 검열과 같은 형식: `30자를 넘는 단어는 추가되지 않습니다. 단어를 줄여 다시 입력하십시오.` / `이미 추가된 단어입니다.` / `금지어는 60개까지 등록됩니다. 사용하지 않는 단어를 삭제하십시오.` | `금지어` / `이 단어가 들어간 글에 경고를 보내고 그 사람의 경고 횟수를 1회 올립니다. 띄어쓰기와 대소문자는 무시합니다. 글을 가리려면 금지어 검열을 사용하십시오.` |
| `row-roombot-warn` | tokens(`{이름}` `{횟수}` `{금지어}`) + `#rb-warn-msg[maxlength=2000][rows=2]` placeholder `비워 두면 기본 문장을 보냅니다.` + `#rb-warn-prev`(상황 줄 = `.kl-in` `하늘` `토 토 팝니다`(첫 금지어 사이에 공백), `{횟수}` 예시 1) | `warnMsg` | '' | 2,000자 | `금지어 경고문` / `{횟수}가 없으면 끝에 (경고 N회)가 붙습니다. {금지어}를 넣으면 그 단어가 방에 다시 올라갑니다.` |
| `row-roombot-links` | 스위치 `#rb-links-on` | `blockLinks` | false | bool | `링크 경고` / `링크와 오픈채팅 초대 링크가 들어간 글에 경고를 보내고 경고 횟수를 올립니다. 글을 가리지는 않습니다.` |
| ↳ dep | tokens(`{이름}` `{횟수}`) + `#rb-link-msg` + `#rb-link-prev`(상황 줄 `open.kakao.com/o/sAbc123 들어오세요`) | `linkMsg` | '' | 2,000자 | `링크 경고문` / `비워 두면 기본 문장을 보냅니다.` |
| `.sec-f` | — | — | — | — | `경고가 3회 쌓이면 관리자 명단의 이름을 함께 적어 호출합니다. 경고 횟수는 7일 동안 유지됩니다.` |

**④ 도배** `h2.grp-t 도배`

| 행 id | 컨트롤 | 경로 | 기본 | 범위·검증 | 라벨 / 설명 |
|---|---|---|---|---|---|
| `row-roombot-flood` | 스위치 `#rb-flood-on` | `floodOn` (새) | true | bool. 저장값에 없으면 true(예전 동작) | `도배 경고` / `한 사람이 정한 시간 안에 정한 개수보다 많이 보내면 경고합니다. 같은 사람에게는 1분에 한 번만 보내며 경고 횟수는 올리지 않습니다.` |
| ↳ dep `row-roombot-flood-rule` | `input.range#rb-flood-secs-range[min=1][max=600]` + `.num#rb-flood-secs`(초) / `.range#rb-flood-count-range[min=2][max=99]` + `.num#rb-flood-count`(개) + `.kt#rb-flood-kt` | `floodSecs` / `floodCount` | 10 / 5 | 1~600 / 2~99 | `기준` / `이 시간 안에 이 개수보다 많으면 도배로 봅니다.` |
| ↳ dep `row-roombot-flood-msg` | tokens(`{이름}`) + `#rb-flood-msg` + `#rb-flood-prev`(상황 줄 `하늘` × 3 `ㅋㅋ`) | `floodMsg` | '' | 2,000자 | `도배 경고문` / `비워 두면 기본 문장을 보냅니다.` |

도배 막대(`#rb-flood-kt`): 고정 예시 = 한 사람의 메시지 `[-58, -40, -21, -9, -7, -6, -5, -4, -3, -2, -1]`초. 보이는 범위 `max(60, floodSecs × 2)`. 창 안 개수 > `floodCount`이면 `.hit`, `● 구간 안의 메시지 {n}개 · 도배 경고를 보냅니다`, 아니면 `○ 구간 안의 메시지 {n}개 · 기준 이하라 경고하지 않습니다`. 문장 `<b>{s}초</b> 안에 <b>{c}개</b>보다 많이 보내면 도배 경고를 보냅니다.` (서버는 "초과"로 판정 — `>`.)

**⑤ 공지** `h2.grp-t 공지`

| 행 id | 컨트롤 | 경로 | 기본 | 범위·검증 | 라벨 / 설명 |
|---|---|---|---|---|---|
| `row-roombot-notice` | `textarea.ta#rb-notice[maxlength=2000][rows=3]` + `#rb-notice-prev`(상황 줄 `.kl-in` `하늘` `{앞글자}공지`, 말풍선 `[공지]\n…`; 비면 부록 A `RB-NOTICE-NONE`) + `span.hint#rb-notice-src`(아래) | `notice` | '' | 2,000자 | `공지` / `방에서 「{앞글자}공지」를 입력하면 이 내용을 보냅니다. 관리자는 방에서 「{앞글자}공지 내용」으로 바꿀 수 있고, 바뀐 내용은 이 칸에 반영됩니다.` |
| `row-roombot-notice-auto` | 스위치 `#rb-notice-auto` | `noticeAutoOn` (새) | false | bool. 켜져 있는데 공지가 비면 저장 막음: `공지를 입력하십시오. 비어 있으면 자동 발송하지 않습니다.` | `공지 자동 발송` / `정한 간격마다 선택한 방에 공지를 올립니다.` |
| ↳ dep | `.num#rb-notice-every`(분) + `span.hint#rb-notice-per` `하루 약 {⌊1440/n⌋}회` | `noticeEveryMin` (새) | 180 | 30~1,440 | `간격` / `처음 켠 뒤 한 간격이 지나면 첫 공지를 올립니다.` |

`#rb-notice-src`: `account.roombot.notice_by === 'chat'`이면 `방에서 {YYYY.MM.DD HH:MM}에 바뀐 공지입니다.`, 아니면 비움.

**⑥ 명령 · 관리자** `h2.grp-t 명령 · 관리자`

| 행 id | 컨트롤 | 경로 | 기본 | 범위·검증 | 라벨 / 설명 |
|---|---|---|---|---|---|
| `row-roombot-prefix` | `input.inp.mono#rb-prefix[maxlength=1]`(폭 56px, 가운데 정렬) + `span.errt#rb-prefix-err` + `p.hint#rb-prefix-clash` | `cmdPrefix` | `!` | 기호 1글자(`/^[^\p{L}\p{N}\s]$/u`). 틀리면 `기호 1글자를 입력하십시오. (예: ! . ~ #)` 저장 막음 | `명령어 앞글자` / `이 글자로 시작하는 메시지를 명령으로 처리합니다.` |
| `row-roombot-admins` | 칩 `div.chips#rb-admins` + `input#rb-admin-in[maxlength=40][placeholder="카카오톡 표시 이름"]` + `.chips-meta`(`#rb-admin-err` + `#rb-admin-cnt` `{n} / 60`) | `adminNames` | [] | 이름 1~40자, 최대 60, **대소문자 구분** 중복 제거(서버는 정확히 같은 이름만 관리자로 본다) | `관리자 명단` / `카카오톡에 표시되는 이름을 정확히 입력합니다. 관리자는 공지 등록, 다른 사람 경고 확인, 경고 초기화를 할 수 있고, 경고가 3회 쌓이면 호출됩니다.` |
| `row-roombot-cmds` (`.stack`) | `ul.cmds#rb-cmds`(아래) | — | — | — | `방에서 쓰는 명령` / `누르면 시연에서 실행합니다. 오른쪽 버튼으로 복사합니다.` |

`#rb-prefix-clash`: 미니게임이 켜져 있고(저장값) 앞글자가 같고 두 기능의 방이 하나 이상 겹치면 `미니게임과 같은 앞글자입니다. 「{p}도움」에는 대화방 관리봇이 답하고, 게임 명령 안내는 「{p}게임도움」으로 확인합니다.`

`#rb-cmds` 행(앞글자가 바뀌면 다시 그림): `li` > `button.cmd[data-cmd]` > `code` `{p}공지` + `span` 설명, 그리고 `button.btn.sm.ghost[data-copy="{p}공지"][aria-label="{p}공지 복사"]`(아이콘 `i-copy`). 목록:

| 명령 | 설명 | 시연 사건 |
|---|---|---|
| `{p}공지` | `등록된 공지 확인` | `msg` 하늘 |
| `{p}공지 내용` | `공지 등록 · 관리자 전용` | `msg` 관리자 `{p}공지 오늘 저녁 9시 정기 점검이 있습니다.` |
| `{p}규칙` | `대화방 규칙 확인` | `msg` 하늘 |
| `{p}경고` | `누적 경고 횟수 확인` | `msg` 하늘 |
| `{p}경고초기화` | `이 방 경고 기록 삭제 · 관리자 전용` | `msg` 관리자 |
| `{p}도움` | `명령 안내` | `msg` 하늘 |

**⑦ 발송 한도** `h2.grp-t 발송 한도`

| 행 id | 컨트롤 | 경로 | 기본 | 범위 | 라벨 / 설명 |
|---|---|---|---|---|---|
| `row-roombot-daily` | `.num#rb-daily`(건) + `.meter#rb-today` | `dailyLimit` | 300 | 1~2,000 | `하루 최대 발송` / `대화방 관리봇이 하루에 보내는 메시지 수의 상한입니다. 자정(한국시간)에 초기화됩니다. 같은 방에는 3초 안에 다시 보내지 않습니다.` |

`#rb-today` = `오늘 {count} / {limit}`(`GET /panel/api/bots`의 `roombot.today`). 기록을 못 읽었으면 `오늘 발송 수를 읽지 못했습니다.`(`--fg-3`).

#### 2.4.3 시연 장면 (`#rb-demo`)

장면 칩 `.kchat-sc > button.fchip[data-sc]`(누르면 `aria-pressed="true"` 잠깐, 끝나면 false):

| `data-sc` | 칩 글자 | 보내는 `events` |
|---|---|---|
| `join` | 입장 | `[{kind:'join', who:'하늘'}]` |
| `leave` | 퇴장 | `[{kind:'leave', who:'하늘'}]` |
| `churn` | 반복 입·퇴장 | `join, leave, join, leave, join`(who `초코우유`, `dt` 각 40000) |
| `ban` | 금지어 | `[{kind:'msg', who:'하늘', text: '{첫 금지어 글자 사이 공백} 팝니다'}]`. 금지어가 없으면 서버를 부르지 않고 `.kl.note` `금지어를 추가하면 시연할 수 있습니다.` |
| `link` | 링크 | `msg` 하늘 `open.kakao.com/o/sAbc123 들어오세요` |
| `flood` | 도배 | `msg` 하늘 `ㅋㅋ` × (`floodCount + 1`), `dt` 400 |
| `notice` | 공지 | `msg` 하늘 `{p}공지` |
| `rules` | 규칙 | `msg` 하늘 `{p}규칙` |

- 보내는 사람 선택(`#rb-demo-who`): `하늘`(참여자), 관리자 명단의 첫 이름(관리자). 직접 입력(`#rb-demo-form` submit)은 `[{kind:'msg', who, text}]`.
- 처음 화면에 들어올 때(계정마다 한 번, 잠금 아님, 동작 줄이기 아님) 저장된 설정으로 `join` 장면을 한 번 재생한다. 동작 줄이기면 응답이 오면 바로 그린다.
- 같은 장면을 연달아 누르면 `state`가 이어져 경고가 `(경고 2회)`, `(경고 3회)` + 관리자 호출로 늘어난다(그대로 보여 준다).

대본(잠금·실패용, 부록 A의 기본 문장. 예시 값: 방 `동네모임`, 이름 `하늘`, 앞글자 `!`, 금지어 `토토`, 관리자 없음):
- `join`: sys `하늘님이 들어왔습니다.` → bot `하늘님, 동네모임에 오신 것을 환영합니다.`(입장 인사 예시 문구) 
- `ban`: in `토 토 팝니다` → bot `RB-WARN-DEF`(n=1)
- `link`: in `open.kakao.com/o/sAbc123 들어오세요` → bot `RB-LINK-DEF`(n=1)
- `flood`: in `ㅋㅋ` × 6 → bot `RB-FLOOD-DEF`(10초 5개)
- `rules`: in `!규칙` → bot `RB-RULES`(금지어 1개, 링크 경고 켜짐, 도배 켜짐, 공지 없음)

#### 2.4.4 저장 전 검사 (화면, 서버 요청 전)

순서대로 첫 오류에서 멈추고 그 칸으로 스크롤·포커스, 칸 아래 `.errt` 또는 `#roombot-error`:
1. `#rb-prefix`가 기호 1글자가 아님 → `#rb-prefix-err` `기호 1글자를 입력하십시오. (예: ! . ~ #)`
2. 입장 인사 켜짐 + 문구 공백 → `입장 인사 문구를 입력하십시오.`
3. 퇴장 인사 켜짐 + 문구 공백 → `퇴장 인사 문구를 입력하십시오.`
4. 공지 자동 발송 켜짐 + 공지 공백 → `공지를 입력하십시오. 비어 있으면 자동 발송하지 않습니다.`
5. 숫자 칸은 V5 `.num` 규칙(범위 밖은 `blur` 때 가장 가까운 값)으로 이미 범위 안이다.
- 메인 스위치가 꺼져 있으면 2~4는 검사하지 않는다(꺼둔 채 초안 저장 허용).
- 검사 실패 시 저장 바 `shake`, 요청 없음.

#### 2.4.5 기록 — 경고 누적 · 반복 입·퇴장 명단

폼 아래 `div.grp[data-lockable]` `h2.grp-t 기록<span>최근 7일 · 많은 순</span>` > `section.sec.clip`:

```html
<div class="toolbar"><div class="seg" id="rb-rec-type" role="group" aria-label="기록 종류"><span class="seg-ind"></span>
  <button type="button" data-t="warns" aria-pressed="true">경고 누적</button><button type="button" data-t="churn" aria-pressed="false">반복 입·퇴장</button></div>
  <span class="grow"></span><span class="poll" data-poll>…20초마다 갱신…</span>
  <button type="button" class="btn sm" id="rb-rec-reset">기록 초기화</button></div>
<div class="confirm-in" id="rb-rec-confirm" data-open="false"><div><div class="confirm-box" role="group" aria-label="기록 초기화 확인">
  <span id="rb-rec-confirm-t"></span><button type="button" class="btn sm" id="rb-rec-no">취소</button>
  <button type="button" class="btn sm danger solid" id="rb-rec-yes">삭제</button></div></div></div>
<p class="errt pad" id="rb-rec-error" role="alert"></p>
<div class="tbl-wrap"><table class="tbl stack" id="rb-rec-tbl"><thead>…</thead><tbody></tbody></table></div>
<div class="sec-f"><span id="rb-rec-cnt"></span><span>강제퇴장은 방장이 카카오톡에서 직접 처리해야 합니다.</span></div>
```

- 경고 누적 열: `이름` · `방` · `횟수`(`span.cnt-pill` `{n}회`, 3회 이상 `.crit`) · `마지막 경고`(`fmtT`). 반복 입·퇴장 열: `이름` · `방` · `횟수` · `마지막 확인`.
- 빈 표: 경고 `누적된 경고가 없습니다.` / 반복 `기록된 반복 입·퇴장이 없습니다.`
- `#rb-rec-reset` → 확인 줄 펼침, 문장 경고 `누적된 경고 기록을 모두 삭제합니다. 설정은 그대로입니다.` / 반복 `반복 입·퇴장 명단을 모두 삭제합니다. 설정은 그대로입니다.` `삭제` → `POST /panel/api/bots/reset {device_id, what: 'warns' | 'churn'}` → 성공 토스트 `기록을 삭제했습니다.` + `{n}건 · {email}`, 응답의 `bots`로 다시 그림. 실패는 `#rb-rec-error`.
- 폴링: `#roombot` 또는 `#minigame`이 보이는 동안 20초 `setTimeout` 체인 `GET /panel/api/bots?device_id=`(V5 4.8 기록 폴링 규칙: 숨김이면 건너뜀, 3회 실패면 60초, 늦은 응답 버림, 서명이 같으면 다시 그리지 않음, 새 행만 `.fresh`). 잠긴 화면이면 부르지 않는다. 403·404는 멈춤.

### 2.5 미니게임 `#minigame`

저장: `minigame-form` → `{device_id, images_unchanged: true, minigame: {…}}`.

#### 2.5.1 골격

`#roombot`과 같은 틀(`.ph` + `#mg-status` + 배너 + 잠금 카드 + `.bot-grid`(폼 + `#mg-demo`) + 점수 묶음). 제목 `미니게임`, 설명 `선택한 오픈채팅방에서 끝말잇기, 숫자야구, 주사위, 가위바위보, 퀴즈를 명령어로 진행하고 방마다 점수를 기록합니다.`

`#mg-status`: `미사용` / `대상 대화방 미설정 · 동작 보류` / `사용할 게임 미선택 · 동작 보류` / `사용 중 · 대상 대화방 {n}개 · 게임 {k}종`.

#### 2.5.2 설정

**① 메인 묶음**

| 행 id | 컨트롤 | 경로 | 기본 | 범위 | 라벨 / 설명 |
|---|---|---|---|---|---|
| `row-minigame-on` (`.main`) | 스위치 `#minigame-on` | `enabled` | false | `=== true` | `미니게임` / `켜면 선택한 방에서 게임 명령에 응답합니다. 끄면 응답을 멈추고 점수는 그대로 둡니다.` |
| `row-minigame-rooms` (dep) | 방 칩 `#minigame-open` + `rooms-meta`(`data-rooms-count="minigame"`) | `rooms` | [] | 오픈채팅방 | `대화방` / `게임을 진행할 오픈채팅방을 선택합니다. 선택이 없으면 동작하지 않습니다.` |
| off-note | — | — | — | — | `미니게임이 꺼져 있습니다. 켜면 대화방과 게임 설정이 표시됩니다.` + `켜기` |

**② 게임** `h2.grp-t 게임` — `div.games#row-minigame-games[role=group][aria-label="사용할 게임"]`, 카드 5장(≥760px 2열, 폰 1열):

```html
<div class="game" data-game="word">
  <div class="game-h"><b>끝말잇기</b><code class="mono" data-cmd-of="word">!끝말잇기</code>
    <span class="swl"><input type="checkbox" role="switch" class="swi" id="mg-word" aria-label="끝말잇기 사용"><span class="sw" aria-hidden="true"></span></span></div>
  <p>사전 691단어 · 두음법칙 적용 · 같은 단어 다시 쓰기 불가 · 30초 안에 이어야 합니다. 이으면 1점, 봇이 이을 단어가 없으면 3점 더.</p>
  <button type="button" class="btn sm ghost" data-play="word">시연</button>
</div>
```

| `data-game` | 경로 | 기본 | 이름 / 명령 | 설명 |
|---|---|---|---|---|
| `word` | `word` | true | 끝말잇기 / `{p}끝말잇기` | 위 |
| `baseball` | `baseball` | true | 숫자야구 / `{p}숫자야구` | `서로 다른 3자리 숫자를 10번 안에 맞힙니다. 첫 자리는 0이 아닙니다. 맞히면 5점.` |
| `dice` | `dice` | true | 주사위 / `{p}주사위` | `1~100면 주사위를 굴립니다. 기본 6면, 점수 없음.` |
| `rps` | `rps` | true | 가위바위보 / `{p}가위바위보` | `봇과 한 판 합니다. 이기면 1점.` |
| `quiz` | `quiz` | true | 퀴즈 / `{p}퀴즈` | `상식 문제 79개 중 하나를 냅니다. 한 방에서 모두 낼 때까지 같은 문제를 다시 내지 않습니다. 5분 안에 맞히면 2점.` |

- 꺼진 카드는 `.game.off`(글자 `--fg-3`). 묶음 바닥줄: `꺼 둔 게임의 명령에는 「사용 중지 상태입니다」로 답합니다. 진행 중인 게임은 하나만 열 수 있습니다.`
- `시연` → 시연 탭을 그 게임으로 바꾸고 그 게임 첫 명령을 보낸다(2.5.3).
- 검사: 메인 켜짐 + 게임 0개 → 묶음 아래 `p.errt#mg-games-err` `게임을 1개 이상 켜십시오.` 저장 막음.

**③ 명령** `h2.grp-t 명령`

| 행 id | 컨트롤 | 경로 | 기본 | 범위 | 라벨 / 설명 |
|---|---|---|---|---|---|
| `row-minigame-prefix` | `#mg-prefix`(관리봇과 같은 칸 규칙) + `#mg-prefix-err` + `#mg-prefix-clash` | `cmdPrefix` | `!` | 기호 1글자 | `명령어 앞글자` / `이 글자로 시작하는 메시지를 명령으로 처리합니다.` |
| `row-minigame-cmds` (`.stack`) | `ul.cmds#mg-cmds` | — | — | — | `방에서 쓰는 명령` / `누르면 시연에서 실행합니다. 오른쪽 버튼으로 복사합니다.` |

`#mg-cmds`(켜진 게임만 + 공통, 꺼진 게임은 `· 미사용` 붙여 흐리게):

| 명령 | 설명 |
|---|---|
| `{p}끝말잇기` | `단어를 이어서 입력합니다. 두음법칙과 중복을 검사합니다.` |
| `{p}숫자야구` | `3자리 숫자를 맞힙니다. (스트라이크 · 볼)` |
| `{p}주사위 [면수]` | `주사위를 굴립니다. 기본 6면.` |
| `{p}가위바위보 가위` | `봇과 한 판 합니다. (가위 · 바위 · 보)` |
| `{p}퀴즈` | `상식 문제를 하나 냅니다.` |
| `{p}힌트` · `{p}정답` · `{p}포기` | `진행 중인 게임의 힌트 · 정답 공개 · 종료` |
| `{p}점수` | `내 누적 점수를 확인합니다.` |
| `{p}랭킹` | `이 방 점수 순위를 보여 줍니다.` |
| `{p}게임도움` | `명령 목록을 보여 줍니다.` |

`#mg-prefix-clash`: 관리봇이 켜져 있고 앞글자가 같고 방이 겹치면 `대화방 관리봇과 같은 앞글자입니다. 「{p}도움」에는 대화방 관리봇이 답하므로, 게임 명령 안내는 「{p}게임도움」으로 확인합니다.`

**④ 응답 속도와 한도** `h2.grp-t 응답 속도와 한도`

| 행 id | 컨트롤 | 경로 | 기본 | 범위 | 라벨 / 설명 |
|---|---|---|---|---|---|
| `row-minigame-cool` | `.range#mg-cool-range[min=3][max=600]` + `.num#mg-cool`(초) + `.kt#mg-cool-kt` | `cooldown_sec` (저장 `cooldownMs`) | 3 | 3~600 | `응답 쿨타임` / `같은 방에서 이 시간 안에는 다시 답하지 않습니다. 3초 미만으로는 설정할 수 없습니다. 쿨타임 중에 들어온 명령도 게임에는 반영되지만 답장은 보내지 않습니다.` |
| `row-minigame-daily` | `.num#mg-daily`(건) + `.meter#mg-today` | `dailyLimit` | 300 | 1~2,000 | `하루 최대 발송` / `미니게임이 하루에 보내는 메시지 수의 상한입니다. 자정(한국시간)에 초기화됩니다.` |

쿨타임 막대(`#mg-cool-kt`): 고정 예시 = 같은 방의 명령 `[0, 2, 7, 15, 16]`초(왼쪽에서 오른쪽, 축 `0초` … `{max(20, cool×2)}초`). 쿨타임으로 각 명령에 답할지 계산(직전 답장 시각 + 쿨타임 이전이면 답 없음): 답하는 명령은 `i.kt-k.in-win`, 답 없는 명령은 `i.kt-k.drop`(`--fg-4`, 가운데 사선). 결과 `● 명령 5개 중 {n}개에 답합니다 · 나머지 {m}개는 쿨타임으로 답하지 않습니다`. 문장 `같은 방에서 <b>{s}초</b> 안에는 다시 답하지 않습니다.`

#### 2.5.3 시연 (`#mg-demo`)

`.kchat` 머리 아래에 게임 탭(`div.seg#mg-demo-tab[role=group]`, 버튼 `data-g="word|baseball|dice|rps|quiz|rank"`, 글자 `끝말잇기` `숫자야구` `주사위` `가위바위보` `퀴즈` `랭킹`), 로그, 입력칸, 그리고 입력칸 위 빠른 칩 줄 `div.kchat-q#mg-demo-q`(탭마다 다름, `{p}`는 지금 앞글자):

| 탭 | 빠른 칩 (누르면 그 글을 하늘이 보낸 것으로) |
|---|---|
| word | `{p}끝말잇기` `{p}힌트` `{p}정답` `{p}포기` (이을 단어는 입력칸에 직접 입력한다. 화면이 단어를 추천하지 않는다) |
| baseball | `{p}숫자야구` `123` `456` `{p}힌트` `{p}정답` |
| dice | `{p}주사위` `{p}주사위 20` |
| rps | `{p}가위바위보 가위` `{p}가위바위보 바위` `{p}가위바위보 보` |
| quiz | `{p}퀴즈` `{p}힌트` `{p}정답` |
| rank | `{p}점수` `{p}랭킹` `{p}게임도움` |

- 보내는 사람 선택 `#mg-demo-who`: `하늘` / `민지`(점수가 사람마다 쌓이는 것을 보여 준다).
- 모든 입력은 `/panel/api/bots/simulate` `feature: 'minigame'`. 서버는 실제 사전·문제로 답한다(시연에서 퀴즈 정답을 모르면 `{p}힌트`·`{p}정답`을 쓴다). 틀린 퀴즈 답에는 서버가 답하지 않으므로 notes `quiz_wrong`.
- 탭 바꾸기는 로그를 지우지 않는다. `시연 초기화`는 점수·진행 게임 모두 지운다.
- 처음 들어올 때(계정마다 한 번): 끝말잇기 탭에서 `{p}끝말잇기`를 한 번 보낸다.
- 대본(잠금·실패용, 앞글자 `!`, 사람 `하늘`): 끝말잇기 = in `!끝말잇기` → `MG-WORD-START`(첫 단어 `사과`, 변형 `과`) → in `과자` → `MG-WORD-PASS`(봇 단어 `자전거`, 다음 `거`, 1점). 대본 단어는 모두 `sender/data/words.json`에 있다(`v6-check`가 확인). 숫자야구 = `!숫자야구` → `MG-BB-START` → `123` → `123 → 1S 1B (1/10)`. 주사위 = `!주사위 20` → `하늘님 20면 주사위 결과 → 14`. 가위바위보 = `!가위바위보 바위` → `봇 가위 · 하늘님 바위 → 하늘님 승리 (+1점, 누적 2점)`. 퀴즈 = `!퀴즈` → `[퀴즈] 대한민국의 수도는 어디입니까?\n정답을 채팅으로 입력하십시오. (힌트 !힌트 · 정답 공개 !정답)` → `서울` → `MG-QUIZ-OK`(+2점, 누적 4점). 랭킹 = `!랭킹` → `[랭킹] 상위 2명\n1. 하늘 4점\n2. 민지 1점`. 대본 문장은 부록 A 형식과 글자까지 같아야 한다.

#### 2.5.4 점수 · 진행 상태

폼 아래 `div.grp[data-lockable]` `h2.grp-t 점수 · 진행 상태<span>대상 대화방별 상위 5명</span>` > `section.sec`:

```html
<div class="toolbar"><span class="grow"></span><span class="poll" data-poll>…20초마다 갱신…</span>
  <button type="button" class="btn sm" id="mg-end-games">진행 중 게임 종료</button>
  <button type="button" class="btn sm ghost danger" id="mg-clear-scores">점수 전체 초기화</button></div>
<div class="confirm-in" id="mg-confirm" data-open="false">…같은 문법…</div>
<p class="errt pad" id="mg-rec-error" role="alert"></p>
<div class="boards" id="mg-boards"></div>
```

- `#mg-boards`(JS): 방마다 `div.board[data-room]` > 머리(`b` 방 이름 + `span.tag.line` `대상 방 아님`(선택 해제된 방에 점수가 남은 경우)) + `p.now` 진행 중 게임(`끝말잇기 · 현재 단어 「나비」 · 21:14 시작` / `숫자야구 · {n}회 시도` / `퀴즈 진행 중` / `진행 중인 게임 없음`) + `ol.top`(순위 · 이름 · `{n}점`, 이름 없음은 `누군가`) + `{n}명 더`(있을 때) + `button.btn.sm.ghost[data-clear-room="{room_key}"]` `이 방 점수 삭제`.
- 빈 상태: 방 없음 `대상 대화방이 설정되지 않았습니다.` / 점수 없음 `기록된 점수가 없습니다. 방에서 게임을 시작하면 점수가 기록됩니다.`
- 확인 문장: 게임 종료 `모든 대화방의 진행 중인 게임을 종료합니다. 점수는 그대로입니다.`(`종료`), 점수 전체 `모든 대화방의 점수 기록을 삭제합니다. 되돌릴 수 없습니다.`(`삭제`), 방 하나 `「{방}」의 점수 기록을 삭제합니다. 되돌릴 수 없습니다.`(`삭제`). → `POST /panel/api/bots/reset {what: 'games' | 'scores', room_key?}`. 토스트 `진행 중인 게임을 종료했습니다.` / `점수를 삭제했습니다.`
- 폴링: 2.4.5와 같은 요청(`GET /panel/api/bots`), 같은 규칙.

### 2.6 시연·서버 공통 문구

봇이 방에 보내는 문장은 부록 A가 정본이다. sender(`features.mjs`)가 이 문장을 보내고, 콘솔 대본·미리 보기 기본 문장이 이 문장을 쓴다. 새 문장을 만들거나 고칠 때는 부록 A를 먼저 고친다.

### 2.7 휴대폰에만 있던 옵션 — 옮김/버림

| 휴대폰 기능 | 결정 | 방법 / 이유 | 고객에게 |
|---|---|---|---|
| 관리봇 입장·퇴장 인사({이름}) | 옮김 | sender에 코드는 있지만 입장·퇴장 알림이 그 함수에 닿지 않는다. `onMember` 경로에서 부르는 `roomBotOnMember`로 옮긴다(3.6 S2). | — |
| 들낙 방지(사람별 반복 입·퇴장, 인사 생략, 안내, 명단) | 옮김 | 이름 `반복 입·퇴장 감지`(D11). 3.6 S3. | — |
| 경고 누적 보기 · 초기화 | 옮김 | 2.4.5, `/v1/bots`. | — |
| 들낙 명단 · 초기화 | 옮김 | 같은 표의 `반복 입·퇴장` 탭. | — |
| 관리봇 입·퇴장 기록(7일 로그) | 버림 | 콘솔의 `입장·퇴장 로그`(매크로)가 같은 일을 더 자세히 한다. 관리봇 명단에는 반복 입·퇴장만 남긴다. | `입·퇴장 시각 기록은 입장·퇴장 로그 화면에서 확인합니다.`(관리봇 ② 묶음 바닥줄 끝에 한 문장 더) |
| 경고 7일 만료 | 옮김 | 3.6 S4. | 2.4.2 ③ 바닥줄 |
| `!규칙` `!도움` 자세한 문장, 거절 시 `(관리자: …)` | 옮김 | 부록 A `RB-RULES` `RB-HELP` `RB-ADMIN-TAIL`. | — |
| 기본 금지어 경고문 | 휴대폰 문장으로 통일 | D9. | — |
| `{날짜}` 형식 | 서버 형식 `YYYY-MM-DD`로 통일 | 갠톡 응답·매크로가 이미 서버 형식이다. 콘솔 갠톡 응답 미리 보기의 `10월 9일`도 고친다(2.8). | — |
| 발송 실패 시 하루 횟수·쿨타임 되돌리기 | 옮김(P2) | 3.6 S11. | — |
| 운영 메모(빈 인사, 한도 도달, 쿨타임 건너뜀, 이름 못 읽음) | 버림 | 콘솔에 활동 로그가 없다. 빈 인사는 저장 전 검사로 막고, 한도는 `오늘 n / 한도` 막대로 보인다. | — |
| 대상 방에 일반 그룹방·1:1 방 | 버림(보류) | D10. 부록 C 질문 1. | `오픈채팅방만 선택할 수 있습니다.`(방 칩 설명 끝) |
| 관리봇 하루 한도(휴대폰은 숨김) | 화면에 냄 | 2.4.2 ⑦. 범위 1~2,000(0 = 무제한 없앰). | — |
| 명령어 앞글자 3글자 입력(휴대폰은 저장 때 1글자로 잘림) | 1글자 기호로 통일 | 2.4.2 ⑥. | — |
| 도배 허용 개수 2~100(저장은 2~99) | 2~99로 통일 | — | — |
| 공지 자동안내(판매 문구) | 새로 만듦 | 휴대폰은 `!공지` 응답만 했다. 판매 문구대로 `공지 자동 발송` 추가(3.6 S7). | — |
| 미니게임 설정 화면 전체 | 옮김 | 2.5. | — |
| 미니게임 3초 쿨타임 하한, 하루 한도 기본 300 | 옮김 | 저장(3.2)과 sender(3.6 S8) 둘 다. | — |
| 점수 · 진행 상태, 점수 전체 초기화, 진행 중 게임 종료 | 옮김 | 2.5.4, `/v1/bots`. | — |
| 명령어 목록 복사 | 옮김 | `#mg-cmds`, `#rb-cmds`. | — |
| 미니게임 답장 문구(진행 중 게임 이름, 포기 시 게임 이름, 랭킹 머리, 켜진 게임만 나열하는 도움말, 사전 오류) | 휴대폰 문장으로 옮김 | 부록 A. 단 "앱의 봇 탭에서 활성화할 수 있습니다."는 방 사람이 볼 수 없는 곳을 가리키므로 버린다. | — |
| 다른 계정 봇이 이미 답했으면 조용히(SEND_HELD) | 옮김 | 같은 키의 계정 여러 개가 같은 방에 있으면 하나만 답한다(3.6 S10). | 2.4.2 ① 바닥줄 다음 줄: `같은 키의 계정 여러 개가 같은 방에 있으면 한 계정만 응답합니다.`(관리봇·미니게임 둘 다) |
| 긴급 정지 · 보호 대화방(SendGuard) | 버림 | 콘솔은 기능별 스위치와 즉시 저장(개요)이 있고, 보낼 방을 고른 방으로만 한정한다. 휴대폰 알림 답장 방식의 오발송 문제는 서버 발송에 없다. | — |
| 앱 활동 로그 | 버림 | 위와 같음. | — |
| 메아리 차단(봇 문장 앞 6자 일치, 내 이름) | 버림 | 서버는 보낸 사람 id로 내 메시지를 정확히 거른다(`mine`). | — |
| 점수판 크기 제한(방당 60명, 방 30개) | 옮김 | 3.6 S8. | — |

### 2.8 기존 화면 문구 수정 (콘솔)

1. 로그인 첫 줄(2.2).
2. 갠톡 응답 미리 보기 `{날짜}` 예시 `10월 9일` → 오늘 날짜 `YYYY-MM-DD`(서버 `renderReply`와 같게). 설명 `민지 님이 21:16에 메시지를 보낸 경우입니다.`의 시각도 지금 시각으로.
3. 계정 화면 `서버 운영 조건`은 그대로.
4. 코드·주석에서 `앱의 기기 등록`, `앱 몫` 같은 말은 화면 문구에서 없앤다(주석은 무관).

### 2.9 변경 추적·저장 (V5 4.14에 더한다)

- `formState('roombot')` = 2.4.2 표의 모든 경로(+ `rooms` 정렬 없이 고른 순서). `formState('minigame')` = `{enabled, rooms, cmdPrefix, word, baseball, dice, rps, quiz, cooldown_sec, dailyLimit}`.
- 관리봇 저장 본문: `formState('roombot')`에서 **`notice`는 기준값과 다를 때만 넣는다**(같으면 키를 빼고 보낸다). 방에서 `!공지 내용`으로 바뀐 공지를 화면의 옛 값이 덮지 않게 하려는 규칙이다(서버도 시각으로 한 번 더 막는다, 3.6 S6).
- 저장 성공 후 `account = res.account` → `fillDetail()`이 두 화면도 채운다(`#rb-*`, `#mg-*`, 칩, 미리 보기, 막대, 시연 방 이름).
- 잠긴 화면은 기준값을 잡지 않고 변경 수 0.

---

## 3. 서버 변경

담당은 모두 A(백엔드). 파일별 변경과 지켜야 할 동작을 적는다. `lib/db.js`의 DROP 금지 규칙은 그대로다(열·테이블은 남기고 쓰지 않는다).

### 3.1 `lib/panel-auth.js` — 기능 하나 이상이면 로그인

`assess(lic, rows, now)`를 바꾼다. 반환 모양:

```js
// 실패
{ ok: false, status, error, not_started?: true, features? }
// 성공
{ ok: true, expires_at, features: { macro: F, roombot: F, minigame: F }, unstarted: boolean }
// F = { owned, on, started, expires_at }  — 세 기능 모두 항상 들어 있다
```

규칙(순서대로):
1. 키 없음 → 401 `없는 키입니다.`
2. `revoked` 또는 `blocked_reason` → 403 `정지된 키입니다.`
3. 유효한 기능 행(`features.ALL`)이 0개 → 403 `기능이 없는 키입니다.`
4. `on`인 기능이 하나도 없음:
   - 미개시(`expires_at` NULL/0) 행이 하나라도 있으면 → 403 `not_started: true`, `이 키는 사용 기간이 아직 시작되지 않았습니다.`
   - 아니면 → 403 `사용 기간이 끝났습니다.`
5. 성공. `expires_at` = `on`인 기능의 만료 중 가장 이른 값. `unstarted` = 미개시 행이 있음.

- `device_id`를 읽거나 돌려주지 않는다(`panel-check` 단언 `assess result has no device id` 유지).
- 오류 문구는 기존 단언(`끝났`, `시작되지`)을 그대로 만족한다.
- `featureFlags(gate)` 내보내기: `{ macro, roombot, minigame }` = 각 `features[f].on`. 실패한 gate면 모두 false.

### 3.2 `lib/panel-config.js`

**`featuresFor(licenseFeat)`** — 두 번째 인자는 받지만 쓰지 않는다:

```js
function featuresFor(lic) {
  const l = lic || {};
  return { macro: !!(l.macro && l.macro.on), roombot: !!(l.roombot && l.roombot.on), minigame: !!(l.minigame && l.minigame.on) };
}
```

**공통 도우미**
- `cleanPrefix(v)`: 앞뒤 공백을 지운 값이 `/^[^\p{L}\p{N}\s]$/u`이면 그 값, 아니면 `'!'`. (여러 글자를 보내면 `'!'`. 화면이 막는다.)
- `sanitizeList(input, max, maxLen, fold)`: 지금의 `sanitizeWords`를 일반화(배열 또는 쉼표·줄바꿈 문자열, 제어문자 공백 처리, 길이 1~`maxLen`, 최대 `max`개, `fold(w)` 키로 중복 제거). `sanitizeWords(x)` = `sanitizeList(x, 200, 30, lower)`로 남긴다(기존 단언 유지).
- `has(src, k)` = `Object.prototype.hasOwnProperty.call(src, k)`.

**`sanitizeRoomBot(input, prev, allowed, now)`** — 저장되는 `config.roombot`:

| 키 | 규칙 | 없을 때(본문에 키가 없음) |
|---|---|---|
| `enabled` | `src.enabled === true` | false |
| `rooms` | `pickKeys(src.rooms, allowed)` | [] |
| `welcomeOn` `leaveOn` `blockLinks` `noticeAutoOn` | `=== true` | 이전 값(`=== true`) |
| `welcomeMsg` `leaveMsg` `warnMsg` `linkMsg` `floodMsg` | `clip(String, 2000)` (앞뒤 공백은 그대로 둔다 — 줄바꿈 서식 보존) | 이전 값 또는 '' |
| `churnMsg` | `clip(…, 500)` | 이전 값 또는 '' |
| `churnOn` `churnMute` `floodOn` | `src.x !== false` | 이전 값 `!== false` (없으면 true) |
| `churnMin` | `clampInt(1, 180)` | 이전 값 또는 10 |
| `churnCount` | `clampInt(2, 20)` | 이전 값 또는 4 |
| `floodSecs` | `clampInt(1, 600)` | 이전 값 또는 10 |
| `floodCount` | `clampInt(2, 99)` | 이전 값 또는 5 |
| `noticeEveryMin` | `clampInt(30, 1440)` | 이전 값 또는 180 |
| `dailyLimit` | `clampInt(1, 2000)` | 이전 값(범위 고정) 또는 300 |
| `banWords` | `sanitizeList(x, 60, 30, lower)` | 이전 값 또는 [] |
| `adminNames` | `sanitizeList(x, 60, 40, identity)` (대소문자 구분) | 이전 값 또는 [] |
| `cmdPrefix` | `cleanPrefix` | 이전 값(`cleanPrefix`) |
| `notice` | `clip(…, 2000)`. 이전 값과 다르면 `noticeAt = now`, `noticeBy = 'console'` | **이전 값·`noticeAt`·`noticeBy` 그대로** |
| `noticeAt` `noticeBy` | 본문 값은 무시한다 | 이전 값 |

- 이전 객체의 모르는 키는 버린다(관리봇은 서버가 쓰는 키만 저장).
- 저장을 거부하지 않는다(빈 인사 문구 등은 화면이 막는다. sender는 빈 문구를 보내지 않는다).

**`presentRoomBot(cfg)`** — `GET /panel/api/account`의 `roombot`. 위 표의 키를 모두 기본값으로 채워 돌려준다. `noticeAt` → `notice_at`(숫자, 없으면 0), `noticeBy` → `notice_by`(`'chat'` `'console'` `''`). 저장값이 범위를 벗어나면 범위로 고쳐 보여 준다.

**`sanitizeMiniGame(input, prev, allowed)`** — 저장되는 `config.minigame`:

| 키 | 규칙 | 없을 때 |
|---|---|---|
| `enabled` | `=== true` | false |
| `rooms` | `pickKeys` | [] |
| `cmdPrefix` | `cleanPrefix` | 이전 값 또는 `'!'` |
| `word` `baseball` `dice` `rps` `quiz` | `src.x !== false` | 이전 값 `!== false` |
| `cooldownMs` | 본문 `cooldown_sec` → `clampInt(sec, 3, 600) * 1000`. `cooldown_sec`이 없고 `cooldownMs`가 있으면 `clampInt(ms, 3000, 600000)` | 이전 값을 3000~600000으로, 없으면 3000 |
| `dailyLimit` | `clampInt(1, 2000)` | 이전 값 또는 300 |

**`presentMiniGame(cfg)`** — `{ enabled, rooms, cmdPrefix, word, baseball, dice, rps, quiz, cooldown_sec, dailyLimit }`(`cooldown_sec` = `round(cooldownMs / 1000)`, 기본 3).

**`applySettings(prevConfig, body, catalog, imageCount, now)`** — 다섯째 인자 `now`(없으면 `Date.now()`). 분기 추가:

```js
if (body && body.roombot) next.roombot = sanitizeRoomBot(body.roombot, prev.roombot, allowed, now || Date.now());
if (body && body.minigame) next.minigame = sanitizeMiniGame(body.minigame, prev.minigame, allowed);
```

- 다른 기능 저장이 `roombot`·`minigame`을 바꾸지 않는다(기존 `Object.assign` 그대로).
- `sanitizeGuard`는 그대로(D12: 숨은 칸 보존). 주석 `앱이 쓰는 config.guard`는 `예전에 저장된 칸`으로 고친다.

모듈 내보내기에 `featuresFor` `sanitizeRoomBot` `sanitizeMiniGame` `presentRoomBot` `presentMiniGame` `cleanPrefix` `keySet`을 더한다.

### 3.3 `routes/panel.js`

**권한 도우미**:

```js
const NEED_TEXT = { macro: '자동발송 매크로', roombot: '대화방 관리봇', minigame: '미니게임봇' };
function needFeature(s, res, f) {
  const x = s.gate.features && s.gate.features[f];
  if (x && x.on) return true;
  res.status(403).json({ ok: false, need: f, error: NEED_TEXT[f] + ' 기능이 없는 키입니다. 구매 후 사용할 수 있습니다.' });
  return false;
}
```

| 경로 | 필요한 기능 |
|---|---|
| `GET /panel/api/inbox`, `GET /panel/api/chats`, `GET /panel/api/chat`, `POST /panel/api/chat/send`, `GET /panel/api/logs` | `macro` |
| `POST /panel/api/settings` | 본문에 `macro` `autoreply` `triggers` `visit` `profile` `guard` `cover` 중 하나가 있거나 `images` 배열이 있으면 `macro`; `roombot`이 있으면 `roombot`; `minigame`이 있으면 `minigame` (모두 만족해야 함) |
| `GET /panel/api/bots` | `roombot` 또는 `minigame` 중 하나 |
| `POST /panel/api/bots/reset` | `what`이 `warns`·`churn`이면 `roombot`, `scores`·`games`면 `minigame` |
| `POST /panel/api/bots/simulate` | 없음(잠금 화면 시연도 쓴다. 실제 발송 없음) |
| `me` `account` `register/*` `unlink` `rooms` `login` `logout` | 없음 |

**`POST /panel/api/login`** — 지금 흐름 유지. 바뀌는 것:
- `gate.ok`이고 `gate.unstarted`면 `startPeriod(key)`를 한 번 더 부른다(남은 미개시 기능 시작). 시작됐으면 audit `activate` `콘솔 로그인으로 추가 기능 사용 기간 시작`. 그 뒤 `gate = await licenseOf(key)`.
- 응답에 `features: gate.features` 추가.
- 로그인 구간(로그인~로그아웃 라우트 사이 소스)에 `device_id` 글자를 쓰지 않는다(`panel-check` 단언 유지).
- 끝에 `sweep.key(key)`(3.5, 기다리지 않음).

**`GET /panel/api/me`** — 지금 응답 + 2.1의 `features` `buy` `legacy_app`. `gate.unstarted`면 위와 같이 `startPeriod` 후 다시 읽는다. `legacy_app` = `SELECT (device_id IS NOT NULL) AS legacy FROM licenses WHERE key=$1`. `buy[f]` = `features.buyUrl(req, f, s.key)`.

**`viewAccount(row, snap)`** — 추가: `roombot: cfg.presentRoomBot(config.roombot)`, `minigame: cfg.presentMiniGame(config.minigame)`, `features: snap.features || {}`(sender가 지금 가진 값, 점검용).

**`POST /panel/api/settings`** — 권한 검사(위 표) → 지금 흐름. `cfg.applySettings(snap.config, body, snap.rooms || [], imageCount, Date.now())`. 본문 크기는 그대로(16mb 경로).

**`POST /panel/api/rooms`** — `featuresFor(s.gate.features)`(두 번째 인자 삭제).

**등록 완료 뒤** — `rememberAccount`를 부르는 세 곳(`register/begin`의 `ok`, `register/confirm`의 `ok`들) 다음에 `sweep.key(s.key)`(기다리지 않음). 새 계정의 `features`가 등록 직후부터 라이선스와 같아진다.

**새 경로 3개** (모두 `session` → `sender.up()` 아니면 `senderDown` → `ownsDevice(s.key, device_id)` 아니면 404 `없는 계정입니다.`):

```
GET  /panel/api/bots?device_id=
  → sender GET /v1/bots?device_id=  (20초)
  → { ok, roombot: BotRoombot, minigame: BotMinigame }
POST /panel/api/bots/reset { device_id, what: 'warns'|'churn'|'scores'|'games', room_key? }
  → what 검사(그 밖은 400 `초기화할 항목이 올바르지 않습니다.`) → 권한 → sender POST /v1/bots/reset (20초)
  → { ok, cleared, bots: { roombot, minigame } }
POST /panel/api/bots/simulate { device_id, feature, config, room_name, state, events }
  → 아래 검사 → sender POST /v1/simulate (10초)
  → { ok, replies: [{ i, text }], notes: [{ i, code, n? }], state }
```

- `BotRoombot` = `{ today: { count, limit }, warns: [{ room_key, room, name, n, at }], churn: [{ room_key, room, name, n, at }] }` — 7일 지난 기록 제외, 많은 순·최근 순, 각 50개까지.
- `BotMinigame` = `{ today: { count, limit }, rooms: [{ room_key, room, selected, game: null | { kind: 'word'|'baseball'|'quiz', label, at, word?, tries? }, top: [{ name, score }], players }] }` — `selected` = 지금 `config.minigame.rooms`에 있음. 선택된 방을 먼저, 그다음 점수만 남은 방. `top`은 점수 > 0인 상위 5명. 숫자야구 정답·퀴즈 정답은 내보내지 않는다.
- 시뮬레이션 검사: `feature` ∈ {`roombot`, `minigame`}(아니면 400). `events` 배열 1~30개, `kind` ∈ {`join` `leave` `msg`}, `who` 문자열 1~40자(없으면 `하늘`), `text` ≤ 500자(`msg`만), `dt` 정수 0~600000(없으면 0). `room_name` 1~60자(없으면 `동네모임`). `state`는 객체이고 `JSON.stringify` 길이 ≤ 65,536(넘으면 `{}`). 위반은 400 `시연 요청이 올바르지 않습니다.`
- 시뮬레이션 설정 만들기: `const KEY = '0\u0001' + roomName; const allowed = { [KEY]: true };` 화면 설정의 `rooms`가 비어 있지 않으면 `rooms: [KEY]`, 비어 있으면 `[]`(방 미선택 결과를 그대로 보여 주기 위해). `roombot`이면 `sanitizeRoomBot({...config, rooms}, {}, allowed, now)` 후 `notice`는 본문 값 그대로 넣는다(시연은 화면 값을 쓴다). `minigame`이면 `sanitizeMiniGame`. sender에는 `{ feature, config, room: { key: KEY, name: roomName }, state, events, me: short(email) }`.
- 시연은 레이트리밋 `panel` 버킷(분당 180)을 쓴다.

### 3.4 `lib/keys.js` — 기간 추가 규칙

```js
// 콘솔만 쓰는 키는 device_id 가 없다. 한 번이라도 쓴 키(활성화 시각이 있거나 시작된 기능이 있음)면 활성화된 키로 본다.
function isActivated(lic, anyStarted) { return !!(lic && (lic.device_id || lic.activated_at != null)) || !!anyStarted; }
```

`grant()`:
- `SELECT key, device_id, activated_at FROM licenses WHERE key=$1 FOR UPDATE`.
- `anyStarted` = `SELECT 1 FROM entitlements WHERE key=$1 AND expires_at IS NOT NULL LIMIT 1`.
- `activated = isActivated(lic, anyStarted)`.
- 기존 행이 미개시(`prevExp === null`)이고 키가 활성화됨이면: `expires_at = now + prevDur + dur`, `starts_at = now`, `duration_ms = prevDur + dur`(지금 코드는 이 경우 `prevDur`를 잃는다).
- 나머지 분기는 그대로. 반환 `activated`는 새 판정 값.
- `isActivated`를 내보낸다(`v6-check`가 쓴다).

### 3.5 새 `lib/license-sweep.js` — 기간·회수 상태를 sender에 밀어 넣기

```js
// 콘솔 키의 기능 상태를 sender 에 맞춘다. 앱 하트비트가 하던 차단을 서버가 대신한다.
const lastSig = new Map();   // device_id → JSON(features) 마지막으로 보낸 값
function start() { /* 부팅 60초 뒤 runAll(), 그 뒤 LICENSE_SWEEP_MS(기본 600000)마다 */ }
async function runAll() { /* panel_accounts 전부를 키별로 묶어 pushKey */ }
async function key(licenseKey) { /* 그 키 하나만 즉시 */ }
async function pushKey(licenseKey, deviceIds) {
  // lic = licenses 행, rows = entitlements → gate = panelAuth.assess(lic, rows, now)
  // want = gate.ok ? featureFlags(gate) : { macro: false, roombot: false, minigame: false }
  // 각 device: sig 가 lastSig 와 다르면 sender POST /v1/features { device_id, features: want } (10초), 성공하면 lastSig 갱신
}
```

- `sender.up()`이 아니면 아무것도 하지 않는다(다음 회차에 다시).
- 한 회차에 같은 키를 두 번 읽지 않는다. 오류는 키마다 `console.error`로 남기고 다음 키로.
- 부르는 곳: `server.js` 부팅(`senderChild.start()` 다음), 콘솔 로그인·등록 완료(3.3), 관리자 동작(4.3 A20).
- 기간이 끝난 키: `gate.ok`가 false → 모든 기능 false → sender가 매크로·기록·검열·올킥·관리봇·미니게임을 멈춘다(3.6 S1). 다시 사면 다음 로그인 또는 10분 안에 되살아난다.

### 3.6 sender (`sender/src/*`)

S1~S16. 각 항목 끝의 "검사"는 `sender/src/selfcheck.mjs`에 넣을 단언이다(`node src/selfcheck.mjs`가 `sender selfcheck ok`로 끝나야 함).

**S1. 매크로 기능 차단 범위 넓히기** (`features.mjs`)
- `coverRoom`, `visitRoom`, `applyProfile`의 방 확인, `guardOnChat`의 config.guard 부분, `guardDue` 맨 앞에 `if (!featureOn(record, 'macro')) …없음` 추가. `featureOn`은 그대로(값이 없으면 켜짐 — 옛 기록 호환).
- 검사: `features: { macro: false }`인 기록에서 `coverPlan`·`guardOnChat`(visit·kick)·`guardDue`가 아무것도 내지 않는다. `macro` 키가 없는 기록은 지금처럼 동작한다.

**S2. 관리봇 입장·퇴장 인사를 `onMember` 경로로** (`features.mjs`, `runner.mjs`)
- `roomBot()`에서 `joinLeaveKind` 분기(입장·퇴장 문장 처리)를 지운다. 입장·퇴장 알림은 `runner.onMessage`가 `takeVisit`으로 가로채 `onMember`로 보내므로 이 분기에는 닿지 않는다. 대신 새 함수:

```js
/** One join or leave for the room bot: greeting, churn notice. Returns sends and demo notes. */
export function roomBotOnMember(record, ev) // ev: { kind: 'join'|'leave', chatId, authorId, authorName, mine, now, skip }
// → { sends: [{ chatId, text, delayMs: 0, meta }], notes: [{ code, n? }] }
```

  1. `featureOn(record,'roombot')`, `cfg.enabled`, `!ev.mine`, `!ev.skip`, 방이 `cfg.rooms`에 있음 — 아니면 빈 결과(시연용 notes: 꺼짐 `off`, 방 없음 `no_room`).
  2. 중복 거르기 30초: 키 `room.key|kind|i:{authorId}`와 `room.key|kind|n:{name}` 중 하나라도 30초 안에 본 적 있으면 끝. 둘 다 기록(`state.rbSeen`, 1,000개 넘으면 오래된 것부터 삭제). LOCO `member_joined`와 입장 문장 파싱이 같은 입장을 두 번 알릴 수 있다.
  3. 반복 입·퇴장 집계(S3). 새로 판정되면(`n > 0`) `churnMsg`가 있으면 렌더해 `botSend`, notes `churn_listed`.
  4. `on = kind === 'join' ? welcomeOn : leaveOn`. 꺼져 있으면 notes `welcome_off`/`leave_off`로 끝. 문구가 비면 `welcome_empty`/`leave_empty`로 끝.
  5. `churnMute !== false`이고 그 사람이 지금 반복 입·퇴장 창 안이면 notes `churn_mute`로 끝.
  6. `renderBot(tpl, roomName, name, now, 0, '')` → `botSend`(3초 방 쿨타임 + 하루 한도).
- `runner.onMember`: `guardOnChat` 결과를 받은 뒤 `roomBotOnMember(this.record, { kind, chatId, authorId: author, authorName, mine, now, skip: !this.botOwner('roombot', chatId) })`의 `sends`를 `guard.sends` 뒤에 붙이고 `guard.active = true`로 해 `finishGuard`가 보내고 저장하게 한다.
- 이름: `onMember`는 지금 입장·퇴장 로그가 켜진 방에서만 이름을 찾아본다. 관리봇이 그 방에서 켜져 있고 `authorName`이 비어 있고 `author`가 있으면 `memberCard(chatId, author)`로 이름만 찾는다(`visitNeedsProfile || roomBotNeedsName(record, chatId)`). `roomBotNeedsName` = 관리봇 켜짐 + 방 포함 + (`welcomeOn || leaveOn || churnOn`).
- 검사: 입장 사건 → `「{이름}」` 들어간 환영 1건. 같은 사람 10초 뒤 같은 사건 → 0건(중복). `welcomeOn: false` → 0건 + notes `welcome_off`. 방이 목록에 없음 → 0건. `features.roombot: false` → 0건. 이름이 비면 `누군가`.

**S3. 반복 입·퇴장 감지** (`features.mjs`)
- runtime: `rbChurn: { [roomKey|person]: number[] }`(사건 시각, 사람당 24개까지), `rbChurnList: { [roomKey|person]: { room, name, n, at, noted } }`.
- `person` = `i:{authorId}`가 있으면 그것, 없으면 `n:{name}`. 둘 다 없으면 집계하지 않는다.
- 사건마다: 창 `churnMin`분 밖 시각을 지우고 지금 시각 추가. 창 안 개수 ≥ `churnCount`이고 `noted`가 30분 안이 아니면 `n += 1`, `at = now`, `noted = now`, `name` 갱신 → "새로 판정"(반환값 = 창 안 개수).
- `churning(state, cfg, roomKey, person, now)` = 창 안 개수 ≥ `churnCount`.
- 정리: `rbChurnList`에서 `at`이 7일 지난 것 삭제, `rbChurn` 키 400개 넘으면 가장 오래된 것부터 삭제.
- `churnOn === false`면 집계도 하지 않는다.
- `churnMsg` 렌더: `renderBot(churnMsg, roomName, name, now, n, '')`(`{횟수}` = 창 안 개수).
- 검사: 10분 기준 4회 → 입·퇴·입·퇴(각 1분 간격) 넷째에 새로 판정 1회, 다섯째 입장 환영은 `churnMute`면 0건·아니면 1건. `churnMsg: '{이름}님 반복 입장이 확인되었습니다 ({횟수}회)'`면 그 문장 1건. 30분 안 같은 사람 재판정 없음.

**S4. 경고 7일 만료와 크기 제한**
- `bumpWarn`: `warnAt[k]`가 7일보다 오래됐으면 0에서 다시 센다. `warnCount`도 7일 지난 값은 0.
- `warns` 키 400개 넘으면 `warnAt`이 가장 오래된 것부터 삭제.
- 검사: 8일 전 경고 2회인 사람이 다시 걸리면 `(경고 1회)`.

**S5. 관리봇 문장 교체** — 부록 A `RB-*`와 같게.
- 기본 금지어 경고문 `RB-WARN-DEF`(금지어를 적지 않음).
- `!규칙` → `RB-RULES`(금지어 수, `blockLinks`, `floodOn` 반영, 공지가 있으면 덧붙임).
- `!도움`·`!명령`·`!방도움` → `RB-HELP`.
- `!공지 내용`·`!경고초기화` 거절 끝에 `RB-ADMIN-TAIL`.
- `floodOn === false`면 도배 검사 안 함. 기본 도배 문장의 숫자는 저장값.
- 검사: 각 문장이 부록 A와 글자까지 같다(부록 A의 고정 문장 목록을 `selfcheck`에 그대로 넣어 비교).

**S6. 방에서 바꾼 공지를 콘솔 저장이 덮지 않게**
- `roomCommand`의 `!공지 내용`: `cfg.notice = arg; cfg.noticeAt = now; cfg.noticeBy = 'chat'`.
- 새 순수 함수 `export function mergeLiveConfig(prevConfig, nextConfig)`: 둘 다 `roombot`이 있고 `Number(prev.roombot.noticeAt) > Number(next.roombot.noticeAt || 0)`이면 `next.roombot.notice/noticeAt/noticeBy`를 `prev` 값으로. 새 객체를 돌려준다(입력을 바꾸지 않음).
- `Hub.updateConfig`: `if (body.config) prev.config = mergeLiveConfig(prev.config, body.config)`. `prev`는 붙어 있는 계정이면 메모리 기록(가장 새것)이다.
- 검사: prev `noticeAt: 200`, next `noticeAt: 100` → prev 공지 유지. next가 더 새것이면 next.

**S7. 공지 자동 발송**
- 새 순수 함수 `export function roomBotDue(record, now, owns)` → `[{ chatId, text, delayMs: 0, meta }]`. 조건: `featureOn roombot`, `cfg.enabled`, `cfg.noticeAutoOn`, `notice.trim()`. 방마다(`cfg.rooms`의 실제 방, `owns(chatId)`가 참인 방): `state.rbNoticeAt[room.key]`가 없으면 지금으로 적고 보내지 않는다(켠 뒤 한 간격 후 첫 발송). `now - last ≥ noticeEveryMin × 60000`이면 `last = now`, `botSend`로 `RB-NOTICE` 문장.
- `runner.guardTick`에서 `guardDue` 다음에 부르고, 보낸 것이 있으면 저장.
- 검사: 처음 호출 0건, 180분 뒤 1건, 그 직후 0건, `notice` 빈 값 0건.

**S8. 미니게임 동작·문장·크기**
- `gameSend`: 쿨타임 = `Math.max(3000, Number(cfg.cooldownMs) || 3000)`, 하루 한도 = `clampNum(cfg.dailyLimit, 1, 9999, 300)`(없거나 0이면 300).
- 문장(부록 A): `MG-BUSY`(진행 중 게임 이름), `MG-GIVEUP`(게임 이름), `MG-RANK`(머리 줄, 0점 이하 제외, 같은 점수는 이름 순), `MG-RANK-NONE`, `MG-HELP`(켜진 게임만, `!점수` 포함, 퀴즈 수), `MG-NO-DICT`(`Word.startWord`가 null).
- 게임 이름표: `word` 끝말잇기, `baseball` 숫자야구, `quiz` 퀴즈, `dice` 주사위, `rps` 가위바위보.
- 크기: `scoreAdd` 뒤 그 방 점수판이 60명을 넘으면 점수가 가장 낮은 사람부터 지운다. `scores`의 방이 30개를 넘으면 `config.minigame.rooms`에 없는 방부터 지운다. `asked[room]`은 퀴즈 수를 넘지 않는다. `games`에서 대상 방이 아니고 진행 중이 아닌 항목은 지운다.
- 검사: `cooldownMs` 없는 설정에서 1초 간격 두 명령 → 두 번째 답 없음. `dailyLimit` 없는 설정에서 301번째 답 없음. 랭킹·도움말·포기·진행 중 문장 비교. 61명 점수 → 60명.

**S9. 기록·초기화 읽기 함수와 경로**
- `features.mjs`: `export function botsView(record, now)` → 3.3의 `{ roombot: BotRoombot, minigame: BotMinigame }`(방 이름은 `logRoomName` 방식으로 `record.rooms`에서). `export function botsReset(record, what, roomKey)` → 지운 수. `warns`(+`warnAt`), `churn`(`rbChurn` + `rbChurnList`), `scores`(방 지정 시 그 방만), `games`(모든 방의 `kind = ''`, 방 지정 시 그 방).
- `index.mjs`: `GET /v1/bots?device_id` → 붙어 있으면 메모리 기록, 아니면 `loadRecord`; 없으면 404 `absent`. `POST /v1/bots/reset {device_id, what, room_key?}` → `hub.botsReset(id, what, roomKey)`: 붙어 있으면 `slot.enqueue(async () => { n = botsReset(slot.record, …); await saveRecord(id, slot.record) })`(메시지 처리와 겹치지 않게), 아니면 불러와 고치고 저장. 응답 `{ ok, cleared, bots: botsView(rec) }`.
- 검사: `botsView`가 7일 지난 경고를 빼고, 정답·비밀 숫자를 내보내지 않는다. `botsReset('scores')` 뒤 점수 0. `botsReset('games')` 뒤 점수 유지.

**S10. 같은 키의 계정끼리 봇 중복 응답 막기**
- 같은 라이선스 키로 등록한 계정의 `device_id`는 `'w' + sha256('panel:' + key) 앞 12자 + …`(lib/panel-ids.js)라 앞 13글자가 같다.
- `export function botCovers(record, feature, chatId)` = `featureOn` + `cfg.enabled` + 방 포함.
- `Hub.botOwner(feature, chatId, selfId)`: `selfId`가 `w`로 시작하면, `accounts` 중 앞 13글자가 같고 `needs_register`가 아니고 `botCovers`가 참인 계정의 `device_id` 최솟값이 `selfId`인지. `w`로 시작하지 않으면 참.
- `Slot`에 `hub` 참조(`new Slot(id, record, hub)`; 테스트처럼 없으면 항상 참). `slot.botOwner(f, chatId)`.
- `onMessage`: `onInbound(…, { …, skip: { roombot: !this.botOwner('roombot', chatId), minigame: !this.botOwner('minigame', chatId) } })`. `onInbound`은 `msg.skip`이 참인 봇을 건너뛴다. `onMember`(S2)·`roomBotDue`(S7, `owns`)도 같은 판정.
- 검사: 같은 앞 13글자의 두 Slot, 둘 다 미니게임 켜짐 → 작은 `device_id`만 소유자. 하나가 꺼지면 다른 하나가 소유자.

**S11. 보내지 못하면 되돌리기 (P2)**
- `botSend`·`gameSend`가 넣는 send에 `meta: { kind: 'bot'|'game', roomKey, prevLast, text }`.
- `runner.deliver`가 성공 여부를 돌려준다. 실패이고 `meta`가 있으면 `undoSend(record, meta)`: 하루 횟수 −1(0 아래로 안 내려감), 방 마지막 시각을 `prevLast`로, `said`에서 그 문장 하나 삭제. `onMessage`·`finishGuard`·`guardTick`이 실패를 받으면 되돌린 뒤 저장.
- 검사: `undoSend` 뒤 `botCount`·`botLast` 원래 값.

**S12. 기능 상태만 바꾸는 경로**
- `POST /v1/features { device_id, features }` → `features`가 `{ macro, roombot, minigame }` 불린 3개가 아니면 400. `hub.setFeatures(id, f)`: 붙어 있으면 `slot.enqueue`로 `slot.record.features = f` 후 저장, 아니면 `loadRecord` → 없으면 404 → 고치고 저장. **붙이지 않는다**(`updateConfig`는 기록이 붙어 있지 않으면 접속을 시작하므로 쓰지 않는다).
- 검사(가짜 저장소 대신 순수 함수 `applyFeatures(record, f)`): 불린 아닌 값 거부.

**S13. `sender/data/quiz.json` 문장 고치기** (D16)
- 79문항의 `q`를 합니다체 의문문 또는 명사형 의문(`…은?`)으로, `h`를 명사형 또는 합니다체로. 예: `대한민국의 수도는 어디야?` → `대한민국의 수도는 어디입니까?`, `우리나라의 전통 집을 뭐라고 불러?` → `우리나라의 전통 집을 무엇이라고 부릅니까?`, `제주도에 있어` → `제주도에 있습니다`, `이걸 먹으면 한 살 더 먹는다고 해` → `먹으면 한 살 더 먹는다고 하는 음식`.
- **순서와 `a`는 바꾸지 않는다**(`runtime.asked`가 번호를 저장한다). 개수 79 유지.
- 검사: 79개, `q`가 `/(야|해|불러|일까|이야|마야|어)\?$/`로 끝나지 않음, `h`가 `/(어|야|해|지)\.?$/`로 끝나지 않음, `correct(0, '서울')` 그대로.

**S14. 등록 기본값** — `register.mjs` `storeSession`의 새 계정 `features`를 `{ macro: false, roombot: false, minigame: false }`로(라이선스는 등록 직후 3.3이 밀어 넣는다). 기존 계정(`prev.features`)은 그대로. `runner.upsert`의 대체 기본값(모두 true)은 손대지 않는다(부모가 늘 `features`를 보낸다).

**S15. 이름 모르는 참여자 (P2)** — `onMessage`에서 `author_name`이 비어 있고 `author`가 있고 그 방에서 관리봇·미니게임이 켜져 있으면 `memberCard`로 이름을 찾는다. 결과는 `this.nameCache`(`chatId|authorId` → `{ name, at }`, 10분, 500개)에 둔다. 찾지 못하면 지금처럼 `누군가`.

**S16. 시연 경로** — `POST /v1/simulate`:

```js
// body: { feature, config, room: { key, name }, state, events, me }
// 기록을 새로 만든다. 저장하지 않고 카카오에 보내지 않는다.
const record = { demo: true, features: { macro: true, roombot: true, minigame: true },
  config: { accounts: [], [feature]: config }, rooms: [{ key: room.key, chat_id: '1', name: room.name, kind: 'open' }],
  runtime: state || {} }
let t = Date.now()
for (const [i, ev] of events.entries()) {
  t += ev.dt || 0
  // msg  → onInbound(record, { chatId: '1', text: ev.text, authorName: ev.who, mine: false, now: t }) 의 text 들 → replies(i)
  // join/leave → roomBotOnMember(record, { kind, chatId: '1', authorName: ev.who, authorId: '', mine: false, now: t }) → replies(i), notes(i)
}
// → { ok, replies, notes, state: pick(record.runtime) }
```

- `record.demo`이면 `botCanSend`·`gameSend`가 쿨타임·하루 한도를 건너뛴다(횟수도 세지 않는다).
- `onInbound`이 `msg.now`를 받는다(없으면 `Date.now()` — 기존 동작). `roomBot`·`miniGame`이 notes를 낼 수 있게 내부에 `state.demoNotes` 배열을 두고(데모일 때만), 시뮬레이션이 사건마다 비운다. 관리봇 메시지 경로의 notes: 금지어·링크·도배·명령 어디에도 걸리지 않으면 `ignored`, `blockLinks`가 꺼져 있고 링크가 있으면 `links_off`, 도배 꺼짐인데 도배 조건이면 `flood_off`, 1분 안 재경고면 `flood_hold`. 미니게임: 퀴즈 진행 중 틀린 답 `quiz_wrong`, 응답 없는 말 `ignored`. 꺼짐 `off`, 방 없음 `no_room`.
- 돌려주는 `state` = `record.runtime`에서 `warns warnAt flood floodWarn rbChurn rbChurnList rbSeen games scores asked said joinSeen` 만.
- 크기 제한: 사건 30개, 응답 문장 수 100개.
- 검사: 관리봇 설정 `welcomeOn` + `welcomeMsg: '{이름}님 환영합니다'` + `join` 사건 → replies `[{ i: 0, text: '하늘님 환영합니다' }]`. 같은 `ban` 사건 3번(state 이어 받기) → 셋째 문장에 관리자 호출 줄. 미니게임 `!주사위 20` → `/^하늘님 20면 주사위 결과 → \d+$/`. 쿨타임 설정 600초여도 연속 명령 모두 응답.

`sender/package.json`의 `check`는 그대로(`selfcheck.mjs`가 새 단언을 포함).

### 3.7 앱 전용 코드 제거와 남길 것

| 파일 | 변경 |
|---|---|
| `routes/license.js` | **삭제**. |
| `routes/retired.js` (새) | `POST /verify` `POST /heartbeat` `GET|POST /entitlements` `GET|POST /config` `GET /pubkey` → 410 `{ ok: false, error: 'app_retired', detail: '휴대폰 앱 지원이 종료되었습니다. 같은 키로 웹 콘솔(/panel)에 로그인하십시오.' }`. 서명·DB 접근 없음. 머리 주석에 "2027-04 이후 삭제 가능". |
| `lib/sign.js` | `randomHex` `sha256Hex`만 남긴다(`routes/purchase.js`가 쓴다). Ed25519 서명, `pubkeyB64`, `configKey`, `cfgSecret`, `SIGNING_PRIVATE_KEY` 읽기·부팅 시 키 생성 삭제. |
| `lib/sender-child.js` | `install()`·`proxy()` 삭제(공개 `/v1/*` 프록시). `start` `call` `up` `reason` `status` `configured` 유지. |
| `server.js` | `senderChild.install(app)` 줄과 주석 삭제. `licenseRoutes` → `retiredRoutes`. 머리 주석의 `routes/license.js : 사용자앱 API` → `routes/retired.js : 종료된 앱 API 안내`. 루트 `/` 비 HTML 응답(`앱/curl 연결확인`)은 `curl 연결확인`으로 주석만. `warnEnv`에서 `SIGNING_PRIVATE_KEY` `ALLOWED_APP_SIGS` 경고 삭제. 4.1의 `/admin` 페이지 경로·헤더, 정적 파일 `no-cache` 규칙에 `admin.(html|js|css)` 추가. `listen` 뒤 `licenseSweep.start()`. |
| `lib/ratelimit.js` | `verify` 종류는 이름 그대로 두고(모르는 종류의 기본값) 주석을 `종료된 앱 API 경로 + 기본값`으로. `GET /admin`(정확히)은 새 종류 `page`(`RATE_PAGE_PER_MIN`, 기본 120)로 분류해 관리자 차단 검사에서 뺀다(4.1). |
| `routes/admin.js` | `require('./license')`, `/admin/sigs` `/admin/sig-add` `/admin/sig-del` `/admin/reset-device` 삭제. 나머지 4.3. |
| `routes/purchase.js` | 주문 접수에서 `android_ok`를 읽지 않는다(`INSERT` 열에서 빼면 기본값 FALSE). 접수 audit의 `/ 안드로이드확인=…` 삭제. 응답의 `android_ok` 삭제. `GET /api/order/:id`의 `view.android_ok` 삭제. `POST /api/lookup`에 `console_started_at`(= `activated_at`, 없으면 null)과 `kakao_accounts`(`SELECT count(*) FROM panel_accounts WHERE license_key=$1`) 추가. `device_registered` `reset_count`는 이번 배포에서는 남긴다(사이트가 읽지 않는다). |
| `lib/features.js` | `DESCS`를 5.5의 상품 설명과 같게. 머리 주석의 `앱` → `콘솔`. |
| `lib/audit.js` | `KINDS`에 `admin`(관리자 작업), `admin_login`(관리자 로그인) 추가. `ALERT_KINDS` 그대로. 머리 주석 `관리자앱 [기록] 탭` → `웹 관리자 [기록]`. 앱 전용 종류(`mismatch` `takeover` `bad_sig` `tamper` `reset`)는 옛 기록 표시용으로 남긴다. |
| `lib/keys.js` | 3.4. 주석의 `기기 활성화` → `첫 사용(콘솔 첫 로그인)`. |
| `package.json` `check` | `node --check routes/license.js` 삭제, `node --check routes/retired.js` `node --check lib/admin-session.js` `node --check lib/license-sweep.js` 추가, 끝에 `&& node lib/v6-check.js`. |

### 3.8 하위 호환

- 저장된 `config.roombot`·`config.minigame`이 없으면 `present*`가 기본값을 돌려준다. 휴대폰 시절 설정은 서버에 없다.
- 기존 기록의 `features`(`{macro:true, roombot:false, minigame:false}`)는 부팅 1분 뒤 첫 정리(3.5)에서 라이선스 값으로 바뀐다.
- `runtime`의 새 키(`rbChurn` `rbChurnList` `rbSeen` `rbNoticeAt`)는 필요할 때 만든다(`rt()`).
- `floodOn`이 없는 관리봇 설정은 켜짐, `noticeAt`이 없으면 0.
- `config.guard`의 숨은 칸은 그대로 보존된다.
- DB: `licenses.device_id/device_name/device_fp/session_token/session_at/app_sig/reset_count/last_reset_at`, `orders.android_ok`, 테이블 `configs` `app_signatures`는 남기고 새로 쓰지 않는다. `shapeLicense`·`shapeOrder`는 옛 행을 그대로 읽는다.
- 관리자 API의 헤더 인증은 그대로라 배포 직후에도 스크립트가 동작한다.

---
