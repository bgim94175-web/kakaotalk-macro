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

## 4. 웹 관리자 `/admin`

관리자 앱(`android/admin`)의 키·주문·입금·기록·설정 탭과 통계를 웹 한 페이지로 옮긴다. 디자인은 V5 콘솔 셸(사이드바·상단 바·`.sec`·`.srow`·`.tbl`·토스트)과 같은 언어다. 파일: `public/admin.html` `public/admin.css` `public/admin.js`(C 담당). 서버 쪽 경로·인증은 A 담당.

### 4.1 주소와 서버 연결 (A)

- 페이지: `GET /admin`(그리고 `/admin/`, `/admin.html`) → `public/admin.html`. 자산: `/admin.css?v=1`, `/admin.js?v=1`(정적 파일, `no-cache`).
- `server.js`에서 **정적 파일 미들웨어보다 앞에** 등록한다(정적 파일이 CSP 없이 `admin.html`을 내보내지 않게):

```js
const ADMIN_CSP = "default-src 'none'; script-src 'self'; style-src 'self' https://fonts.googleapis.com; " +
  "font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";
function adminPage(req, res, next) {
  const f = path.join(PUBLIC_DIR, 'admin.html');
  if (!fs.existsSync(f)) return next();
  res.set({ 'Cache-Control': 'no-store', 'Content-Security-Policy': ADMIN_CSP, 'X-Frame-Options': 'DENY',
            'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff' });
  res.sendFile(f);
}
app.get(['/admin', '/admin.html'], adminPage);   // express.static 보다 위
```

- 라우터 순서상 `GET /admin`은 `routes/admin.js`의 `router.use('/admin', guard)`에 닿지 않는다(페이지 경로가 먼저 응답). API는 지금처럼 `/admin/*`.
- 레이트리밋(`lib/ratelimit.js kindOf`): `GET /admin`(정규화 뒤 정확히)은 `page` 종류(분당 120, 관리자 IP 차단 검사 없음). `/admin.html`은 대상 아님. `/admin/*`은 지금처럼 `admin`.
- CSP 때문에 C가 지킬 것: 인라인 `<script>` 없음, `style="…"` 속성 없음(스프라이트 `svg`는 `class="sprite"`로 숨김), `on…=` 속성 없음. JS에서 `el.style.transform = …` 같은 CSSOM 설정은 허용된다. 외부 리소스는 Google Fonts CSS 하나.

### 4.2 브라우저 인증 (A + C)

**쿠키 세션** — 새 `lib/admin-session.js`(A):

| 항목 | 값 |
|---|---|
| 쿠키 | `kadm` · `Path=/admin` · `HttpOnly` · `SameSite=Strict` · https면 `Secure` · `Max-Age` = 남은 시간 |
| 토큰 | `base64url(JSON {v:1, iat, exp, n})` + `.` + `base64url(HMAC-SHA256(secret, body))`, `n` = 무작위 8바이트 hex |
| 비밀값 | `sha256('kbot-admin-session-v1\n' + ADMIN_PASSWORD + '\n' + (ADMIN_SESSION_SECRET || ''))`. 비밀번호를 바꾸면 모든 세션이 끊긴다. 콘솔 쿠키(`CONFIG_SECRET`, `Path=/panel`)와 다른 키·다른 경로 |
| 유효 시간 | 12시간. 남은 시간이 절반 아래면 요청 때 새로 발급(같은 `iat`). 로그인 뒤 72시간이 지나면 다시 로그인 |
| 검증 | `timingSafeEqual`, `exp > now`, `now − iat < 72h` |

**새 경로**(`routes/admin.js`에서 `router.use('/admin', guard)`보다 **위에** 등록):

```
POST /admin/login  { password }
  비밀번호 미설정·기본값 → 503 (guard 와 같은 본문)
  IP 차단 중 → 429 { ok:false, error:'too_many_attempts', detail:'비밀번호 입력 실패 횟수를 초과했습니다. N분 후 다시 시도하십시오' } + Retry-After
  틀림 → rl.noteAdminFail + audit bad_admin_pw('관리자 비밀번호 틀림 POST /admin/login / 연속 N회[→ M분 차단]')
         → 차단에 걸리면 429(위와 같음), 아니면 401 { ok:false, error:'unauthorized', detail:'비밀번호가 일치하지 않습니다.' }
  맞음 → rl.clearAdminFails + 쿠키 발급 + audit admin_login('웹 관리자 로그인') → { ok:true, exp }
POST /admin/logout → 쿠키 삭제 → { ok:true }
GET  /admin/session (guard 통과) → { ok:true, via:'cookie'|'header', exp|null }
```

**`guard` 변경**:
1. 비밀번호 미설정 503, IP 차단 429 — 그대로.
2. `x-admin-password` 헤더가 있으면 지금 경로 그대로(틀리면 실패 횟수·audit·401/429).
3. 헤더가 없으면 쿠키: 없음·깨짐·만료 → 401 `{ ok:false, error:'unauthorized', reason:'session', detail:'다시 로그인하십시오.' }`(**실패 횟수를 세지 않는다** — 만료된 쿠키가 IP를 잠그지 않게. 쿠키는 HMAC이라 추측할 수 없다).
4. 쿠키로 들어온 요청은 모두 헤더 `x-kbot-admin: 1`이 있어야 하고, `Origin` 헤더가 있으면 그 호스트가 `x-forwarded-host || host`와 같아야 한다. 아니면 403 `{ ok:false, error:'bad_origin', detail:'허용되지 않은 요청입니다.' }`. (교차 사이트 요청은 사용자 정의 헤더를 붙이려면 사전 요청이 필요하고, 서버는 CORS를 허용하지 않는다.)
5. 통과하면 갱신 규칙대로 쿠키 재발급, 서버 로그 `[admin] METHOD PATH ip=… via=cookie|header`.

**헤더 비밀번호를 남기는 이유(D13)**: `DEPLOY.md`의 `curl` 점검과 운영 스크립트가 쓰고, 헤더는 교차 사이트에서 붙일 수 없어 CSRF 걱정이 없으며, 같은 실패 차단을 받는다. 브라우저 코드(`admin.js`)는 이 헤더를 절대 쓰지 않고 비밀번호를 어디에도 저장하지 않는다(`localStorage`·`sessionStorage`·변수 보관 금지 — 로그인 요청 직후 입력칸을 비운다).

**화면 흐름(C)**: 부팅 → `GET /admin/session` → 200이면 앱, 401이면 로그인, 503이면 사용 불가 화면, 429면 대기 화면. 모든 `fetch`는 `credentials: 'same-origin'`, 헤더 `x-kbot-admin: 1`, POST는 `content-type: application/json`. 작업 중 401이 오면 지금 화면을 그대로 둔 채 로그인 카드를 덮어 띄우고, 로그인하면 그 요청을 다시 보내지 않고 화면만 새로 읽는다.

### 4.3 API 대응표

모든 응답은 JSON. 업무 오류는 지금처럼 HTTP 200 `{ ok:false, error }`(스크립트 호환), 인증·과다 요청은 401/403/429/503 `{ error, detail }`. 화면은 `detail || error || '처리하지 못했습니다.'`를 보여 주고, 코드값(`unauthorized` `server_error` `bad_origin` `admin_disabled` `too_many_attempts`)이 그대로 오면 아래 문장으로 바꾼다: `다시 로그인하십시오.` / `서버 오류입니다. 잠시 뒤 다시 시도하십시오.` / `허용되지 않은 요청입니다.` / `서버에 관리자 비밀번호가 설정되지 않았습니다.` / `비밀번호 입력 실패 횟수를 초과했습니다.`

| 화면 동작 | 경로 | 변경(A) |
|---|---|---|
| 로그인·로그아웃·세션 | `POST /admin/login` `POST /admin/logout` `GET /admin/session` | A1~A3 새 경로(4.2) |
| 개요 지표, 사이드바 배지 | `GET /admin/stats` | A17 `sender_up` `sender_reason` `accounts_total`(panel_accounts 수) `alerts_24h`(24시간 안 `ALERT_KINDS` 기록 수) 추가 |
| 주문 목록·검색·탭 | `GET /admin/orders?status=&q=&limit=&offset=` | A13 `q`(주문번호·구매자·입금자·연락처 부분 일치, 숫자면 금액 일치도), `offset`, 응답 `total`. `%` `_` 이스케이프 |
| 주문 승인·복구 승인 | `POST /admin/order-approve {id, key?}` | 그대로. 이후 `sweep.key(key)` |
| 주문 취소 | `POST /admin/order-cancel {id, memo?}` | A8 `auto_canceled = FALSE`로도 바꾼다(사람이 취소한 주문은 되살아나지 않게). 0행이면 `{ok:false, error:'이미 완료되었거나 없는 주문입니다.'}` |
| 주문 메모 수정 | `POST /admin/order-memo {id, memo}` | A7 새. 메모를 바꿔 쓴다(500자, 빈 값은 NULL). audit `admin` `주문 메모 수정 {id}`. → `{ok, id, memo}` |
| 입금 목록 | `GET /admin/deposits?status=&limit=` | 그대로(`hook_enabled` `auto_approve` `needs_attention` 포함) |
| 입금 수동 매칭 | `POST /admin/deposit-match {deposit_id, order_id}` | A9 응답에 `issued` `amount_diff`(입금액 − 주문액, 입금액을 못 읽었으면 null). 이미 다른 주문에 매칭된 입금이면 `{ok:false, error:'이미 다른 주문에 매칭된 입금입니다: {주문}'}`. 이후 `sweep.key` |
| 입금 무시 | `POST /admin/deposit-ignore {deposit_id}` | A11 audit `admin` `입금 무시 {id}`. 0행이면 `없는 입금 기록입니다.` |
| 입금 무시 되돌리기 | `POST /admin/deposit-restore {deposit_id}` | A10 새. `ignored` → `unmatched`만. 아니면 `무시한 입금만 되돌릴 수 있습니다.` audit `admin` |
| 키 목록·검색·필터 | `GET /admin/list?q=&status=&feature=&limit=&offset=` | A14 `status` ∈ `active`(회수·차단 아님 + 켜진 기능 있음) · `expiring`(active이고 가장 늦은 만료 ≤ 7일) · `expired`(시작된 기능만 있고 모두 끝남) · `unused`(모든 기능 미개시) · `stopped`(회수 또는 차단). `feature` = 그 기능 행이 있음. `q`의 `%` `_` 이스케이프. 행마다 `accounts_n`(카카오 계정 수) |
| 키 상세 | `GET /admin/license?key=` | A5 `config` 삭제, `accounts: [{device_id, email, created_at, linked, needs_register, connected, reason}]`(sender가 켜져 있으면 `/v1/snapshot` 상태, 아니면 `reason:'sender_down'`), `sender: {up, reason}`, `legacy_app: {device_name, activated_at, reset_count} | null`(`device_id`가 있을 때만) |
| 키 정보 수정 | `POST /admin/license-update {key, note?, owner_name?, owner_contact?}` | A6 새. 보낸 칸만 바꾼다. 앞뒤 공백 제거, 500/60/120자, 빈 값은 NULL. audit `admin` `키 정보 수정 (메모·소유자·연락처 중 바뀐 것)`. → `{ok, license}` |
| 새 키 발급 | `POST /admin/create {features, plan, days?, count?, note?, owner_name?, owner_contact?}` | A12 audit `admin` `키 발급 {n}개 / 기능=… / 플랜=…` |
| 기능 추가·연장 | `POST /admin/grant {key, features, plan, days?}` | A12 audit `admin`. 이후 `sweep.key`. 3.4 규칙으로 콘솔 키에도 바로 시작 |
| 기능 하나 회수 | `POST /admin/revoke-feature {key, feature}` | A12 audit `admin` `기능 회수 {feature}`. 0행이면 `{ok:false, error:'그 기능이 없는 키입니다.'}`. 이후 `sweep.key` |
| 키 회수·복구 | `POST /admin/revoke {key, revoked}` | 0행 오류 `등록되지 않은 키입니다`. 이후 `sweep.key` |
| 키 차단·해제 | `POST /admin/block {key, reason|null}` | 같음 |
| 키 영구 삭제 | `POST /admin/delete {key}` | A19 같은 트랜잭션에서 `panel_pending`·`panel_accounts`(그 키) 삭제. 커밋 뒤 sender가 켜져 있으면 지운 계정마다 `POST /v1/unlink`(실패는 로그만). audit 문구 `관리자 키 삭제 (카카오 계정 {n}개 해제)`. → `{ok, key, accounts_removed}` |
| 기록 | `GET /admin/audit?key=&kind=&ip=&before_id=&limit=` | A15 `ip`(정확히), `before_id`(그 id보다 작은 것), 응답 `next_before_id`(가득 찼으면 마지막 행 id, 아니면 null) |
| 설정 상태 | `GET /admin/settings` | A16 새 읽기 전용: `{ok, hook_enabled, auto_approve, bank, contact, pending_ttl_hours, sender:{up, reason}, limits: rl.limits(), admin_session_hours: 12, sweep_minutes}` |
| — | `/admin/sigs` `/admin/sig-add` `/admin/sig-del` `/admin/reset-device` | A18 **삭제**(앱 전용) |

A20: `sweep.key(key)`를 부르는 곳 = grant, revoke-feature, revoke, block, order-approve, deposit-match(응답을 기다리지 않음).

### 4.4 DOM 계약 (C)

**골격** `public/admin.html`:

```html
<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>관리자 · K bot</title>
<meta name="robots" content="noindex, nofollow">
<meta name="theme-color" content="#09090b">
<meta name="color-scheme" content="dark">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<!-- UI_V5 2.3 글꼴 링크 3줄 -->
<link rel="stylesheet" href="/admin.css?v=1">
</head>
<body>
<svg class="sprite" aria-hidden="true"><defs>…콘솔 스프라이트에서 필요한 symbol만…</defs></svg>
<a class="skip" href="#view">본문으로 건너뛰기</a>

<div id="gate" class="login" hidden>
  <div class="login-card">
    <span class="brand"><span class="brand-mark" aria-hidden="true">K</span>K bot</span>
    <div><h1>K bot 관리자</h1>
      <p class="lead">서버 환경변수 ADMIN_PASSWORD 값으로 들어갑니다. 비밀번호는 이 브라우저에 저장하지 않습니다.</p></div>
    <form id="login-form" novalidate>
      <div class="fld"><label for="pw">관리자 비밀번호</label>
        <input class="inp" id="pw" type="password" autocomplete="current-password" required>
        <span class="errt" id="login-error" role="alert"></span></div>
      <button type="submit" class="btn primary lg wide" id="loginBtn"><span class="spin"></span><span class="lbl-idle">들어가기</span></button>
    </form>
    <p class="hint" id="login-wait" hidden></p>
    <div class="banner" id="login-disabled" role="alert" hidden></div>
    <p class="login-foot">서버가 잠들어 있으면 첫 요청에 20초 이상 걸릴 수 있습니다.</p>
  </div>
</div>

<div id="app" data-route="" hidden>
  <aside class="side" id="side" aria-label="관리자 메뉴">
    <div class="side-brand"><span class="brand-mark" aria-hidden="true">K</span><b>K bot 관리자</b></div>
    <nav class="side-nav" id="nav" aria-label="화면">
      <span class="nav-ind" id="navInd"></span>
      <a class="nav-a" href="#overview" data-r="overview">[i-overview]개요</a>
      <a class="nav-a" href="#orders" data-r="orders">[i-order]주문<span class="r"><b class="badge-n" id="navOrders" hidden></b></span></a>
      <a class="nav-a" href="#deposits" data-r="deposits">[i-bank]입금<span class="r"><b class="badge-n" id="navDeposits" hidden></b></span></a>
      <a class="nav-a" href="#keys" data-r="keys">[i-key]키</a>
      <a class="nav-a" href="#audit" data-r="audit">[i-log]기록<span class="r"><b class="badge-n crit" id="navAlerts" hidden></b></span></a>
      <a class="nav-a" href="#settings" data-r="settings">[i-gear]설정</a>
    </nav>
    <div class="side-foot">
      <p class="mono" id="sessLeft"></p>
      <div class="links"><a href="/">[i-home]사이트</a><a href="/panel">[i-overview]콘솔</a><button type="button" id="logout">[i-logout]나가기</button></div>
    </div>
  </aside>
  <div class="scrim" id="scrim"></div>
  <div class="mainc">
    <header class="topbar">
      <button type="button" class="menu-btn" id="menuBtn" aria-label="메뉴 열기" aria-expanded="false" aria-controls="side">[i-menu]</button>
      <div class="crumbs"><span class="c-acct">관리자</span><span class="sl" aria-hidden="true">/</span><b id="crPage"></b></div>
      <div class="top-r"><span class="sync" id="sync"><i class="dot live"></i><span class="txt">발송 서버 정상</span></span>
        <button type="button" class="btn sm ghost" id="refresh" aria-label="새로고침">[i-refresh]</button></div>
    </header>
    <main class="view" id="view" tabindex="-1" aria-label="K bot 관리자">
      <section class="page" data-route="overview" id="page-overview" aria-labelledby="ov-title" hidden>…</section>
      <section class="page" data-route="orders" id="page-orders" aria-labelledby="ord-title" hidden>…</section>
      <section class="page" data-route="deposits" id="page-deposits" aria-labelledby="dep-title" hidden>…</section>
      <section class="page" data-route="keys" id="page-keys" aria-labelledby="key-title" hidden>…</section>
      <section class="page" data-route="audit" id="page-audit" aria-labelledby="aud-title" hidden>…</section>
      <section class="page" data-route="settings" id="page-settings" aria-labelledby="set-title" hidden>…</section>
    </main>
  </div>
</div>

<div class="sheet-wrap closed" id="sheetWrap" aria-hidden="true">
  <div class="scrim" data-sheet-close></div>
  <aside class="sheet" id="sheet" role="dialog" aria-modal="true" aria-labelledby="sheetTitle">
    <div class="sheet-h"><h2 id="sheetTitle"></h2><button type="button" class="btn sm ghost" data-sheet-close aria-label="닫기">[i-x]</button></div>
    <div class="sheet-b" id="sheetBody"></div>
  </aside>
</div>
<div class="dlg-wrap closed" id="dlgWrap" aria-hidden="true">
  <div class="dlg" role="alertdialog" aria-modal="true" aria-labelledby="dlgTitle" aria-describedby="dlgBody">
    <h2 id="dlgTitle"></h2><div id="dlgBody"></div>
    <div class="fld" id="dlgTypeWrap" hidden><label for="dlgType" id="dlgTypeLb"></label><input class="inp mono" id="dlgType" autocomplete="off"></div>
    <div class="acts"><button type="button" class="btn" id="dlgNo">취소</button><button type="button" class="btn primary" id="dlgYes"></button></div>
  </div>
</div>
<div class="toasts" id="toasts" aria-live="polite"></div>
<script src="/admin.js?v=1"></script>
</body>
</html>
```

- 아이콘 스프라이트: 콘솔의 `i-overview i-key i-search i-plus i-x i-check i-copy i-menu i-refresh i-down i-right i-home i-logout i-alert i-trash` + 새 `i-order`(영수증) `i-bank`(지폐) `i-log`(목록) `i-gear`(톱니).
- `admin.css`: 첫 규칙은 UI_V5 2.1 `:root` 토큰 블록을 **글자 하나 다르지 않게**(`/* K bot tokens v5 */` 주석 포함). 이어서 2.2 기초 블록, 그다음 `panel.css`의 셸·`.sec` `.srow` `.tbl` `.toolbar` `.seg` `.chips` `.confirm-in` `.metric(s)` `.toast` `.banner` `.empty` `.tag` `.badge-n` `.dot` 규칙을 복사하고 아래 새 규칙을 더한다. 색은 토큰만(`#hex` `rgba(` 금지 — `:root` 블록 제외).
- 해시 라우트: `#overview`(기본) `#orders` `#deposits` `#keys` `#audit` `#settings`. 쿼리 비슷한 꼬리 허용: `#orders?status=paid`, `#keys?q=KAKA-…`, `#audit?key=…`, `#audit?ip=…`. 화면 전환은 UI_V5 5.1(WAAPI 교차 전환), 사이드바 표시 `.nav-ind`, 폰 서랍(≤960px)도 V5와 같다. 화면 이름은 `#crPage`와 `document.title`(`{화면} · 관리자 · K bot`, 기본 화면은 `관리자 · K bot`).
- 사이드바 배지: `#navOrders` = `stats.pending_orders`(pending + paid), `#navDeposits` = `stats.deposits_attention`, `#navAlerts` = `stats.alerts_24h`(배경 `--crit`). 0이면 `hidden`. 늘면 `bump`.
- `#sessLeft`: `세션 {HH:MM}까지`(`/admin/session`의 `exp`). 헤더 인증일 때는 비움.
- `#sync`: `stats.sender_up` → `● 발송 서버 정상` / `● 발송 중지`(warn, `title` = `sender_reason`).

#### 4.4.1 개요 `#overview`

```html
<div class="col">
 <div class="ph"><div><h1 id="ov-title" tabindex="-1">개요</h1><p>처리할 주문과 입금, 키 현황입니다. 30초마다 갱신합니다.</p></div>
   <div class="ph-r"><button type="button" class="btn primary" data-act="issue">[i-plus]새 키 발급</button></div></div>
 <div class="grp" id="ov-attn" hidden><h2 class="grp-t">확인 필요<span id="ov-attn-n"></span></h2><section class="sec" id="ov-attn-list"></section></div>
 <div class="metrics" role="list" id="ov-metrics"></div>
 <div class="ov-grid">
   <div class="grp"><h2 class="grp-t">최근 주문</h2><section class="sec clip"><ul class="feed" id="ov-orders"></ul>
     <div class="sec-f"><span class="poll" data-poll>…30초마다 갱신…</span><a class="btn sm" href="#orders">전체 주문</a></div></section></div>
   <div class="grp"><h2 class="grp-t">기능별 사용 중</h2><section class="sec" id="ov-feats"></section></div>
 </div>
</div>
```

- 지표 타일(`div.metric[role=listitem][data-go]`, 누르면 그 화면·필터로): `대기 주문`(`pending_orders` → `#orders?status=pending`), `발급 대기`(`paid_orders` → `#orders?status=paid`, 0보다 크면 `.warn`), `확인 필요 입금`(`deposits_attention` → `#deposits?status=attn`, 0보다 크면 `.crit`), `사용 중 키`(`active` → `#keys?status=active`), `7일 안 만료`(`expiring_7d` → `#keys?status=expiring`), `카카오 계정`(`accounts_total`), `회수·차단`(`revoked + blocked` → `#keys?status=stopped`), `전체 키`(`total`).
- `#ov-attn-list` 행(V5 개요 확인 필요와 같은 모양): 발급 대기 주문마다(최대 5) `● 주문 {id} 입금 확인됨 · 발급 대기` + `승인` 버튼(4.4.2 승인 흐름), 확인 필요 입금마다(최대 5) `● {금액}원 · {입금자} · {미매칭|모호}` + `매칭` 버튼, `sender_up`이 false면 `● 발송 서버 중지` + `sender_reason`, `alerts_24h > 0`이면 `● 경고 기록 {n}건 (24시간)` + `기록` 링크(`#audit`).
- `#ov-orders`: 최근 주문 6건 `li` > `time` + 상태 칩 + `span.mono` 주문번호 + 금액 + 입금자. 누르면 `#orders`에서 그 행 펼침.
- `#ov-feats`: 기능 3개 줄 `{상품 이름}` + 막대(`by_feature[f] / active`) + `{n}개`.

#### 4.4.2 주문 `#orders`

```html
<div class="col">
 <div class="ph"><div><h1 id="ord-title" tabindex="-1">주문</h1><p id="ord-bank">입금 계좌 · …</p></div></div>
 <section class="sec clip">
  <div class="toolbar">
    <div class="seg" id="ord-status" role="group" aria-label="주문 상태"><span class="seg-ind"></span>
      <button type="button" data-s="pending" aria-pressed="true">입금 대기</button><button type="button" data-s="paid" aria-pressed="false">발급 대기</button>
      <button type="button" data-s="done" aria-pressed="false">완료</button><button type="button" data-s="canceled" aria-pressed="false">취소</button>
      <button type="button" data-s="" aria-pressed="false">전체</button></div>
    <input class="inp" id="ord-q" type="search" placeholder="주문번호 · 입금자 · 연락처 · 금액" aria-label="주문 검색" autocomplete="off">
    <span class="grow"></span><span class="poll" data-poll>…</span>
  </div>
  <p class="errt pad" id="ord-error" role="alert"></p>
  <div class="tbl-wrap"><table class="tbl stack" id="ord-tbl"><thead><tr>
    <th>주문</th><th>상태</th><th>기능 · 기간</th><th style="text-align:right">금액</th><th>입금자 · 구매자</th><th>접수</th><th class="chev-c"><span class="sr">펼치기</span></th>
  </tr></thead><tbody></tbody></table></div>
  <div class="sec-f"><span id="ord-cnt"></span><button type="button" class="btn sm" id="ord-more" hidden>더 보기</button></div>
 </section>
</div>
```

> `style="text-align:right"`은 CSP에 걸린다. 실제 파일에서는 `th.r` 클래스로 쓴다(이 문서의 마크업 조각 모두 같은 규칙).

- 행 `tr.rowx[data-id][tabindex=0][aria-expanded]`: 주문번호(`.mono`, 옆 복사 버튼) / 상태 칩(`입금 대기` warn · `발급 대기` warn 굵게 · `완료` live · `취소` · `자동 취소`(`auto_canceled`)) / 기능 칩 + `1개월` 등 / 금액(`.mono`, `amount ≠ base_amount`면 아래 `확인용 {n}원 포함`, `needs_review`면 `확인 필요` crit 태그) / `입금자 X` + `구매자 Y · 연락처`(`--fg-3`) / `MM.DD HH:MM` / 펼침.
- 펼침 줄 `tr.detail`: `dl`(주문번호, 접수, 처리 시각, 기존 키 연장 대상 `target_key`, 발급 키(복사), 메모, 이전 주문의 안드로이드 확인 `예`일 때만 `안드로이드 확인 · 예 (이전 주문)`) + 동작 줄:
  - 상태 `pending`·`paid`: `승인`. 상태 `canceled` && `auto_canceled`: `복구 승인`(설명 `미입금으로 자동 취소된 주문입니다. 승인하면 주문이 되살아나고 키가 발급되거나 연장됩니다.`).
  - 상태가 `done`·`canceled`가 아니면: `취소`.
  - 모든 상태: `메모 수정`, `주문 페이지`(`/order/{id}` 새 창 아님, 같은 창에서 열지 않고 복사만 — `주문 링크 복사`).
- **승인 흐름**(펼침 줄 안 인라인 패널 `.act-panel`): `기존 키 (비우면 신규 발급)` 입력(`target_key`가 있으면 채움, 대문자 정규화) + 설명(입력 있으면 `이 키에 기능을 추가합니다. 사용 중인 기능은 남은 기간에 더해집니다.`, 없으면 `새 키를 발급하고 주문을 완료합니다.`) + `승인` primary / `취소`. → `POST /admin/order-approve`. 성공 시 패널이 결과 카드로 바뀐다: `승인했습니다 · {신규 발급|기존 키 연장}` + 큰 모노 키 + `키 복사` + `주문 링크 복사` + 안내 `구매자는 주문 상태 화면에서도 키를 확인할 수 있습니다.` 이미 처리됨(`already`)이면 `이미 완료된 주문입니다.` + 키.
- **취소 흐름**: 인라인 패널 — 사유 `textarea`(500자) + 빠른 칩 `입금 없음` `중복 주문` `환불` + `취소 처리` danger. 확인 대화상자 없이 이 패널 버튼이 확인이다. → `POST /admin/order-cancel {id, memo}`. 토스트 `주문을 취소했습니다.` + 주문번호.
- **메모 수정**: 메모 `dd`가 `textarea`로 바뀌고 `저장`·`취소`. → `POST /admin/order-memo`. 
- 탭 머리 글자에 개수를 붙이지 않는다(API에 상태별 개수가 없다). `#ord-cnt` = `{보이는 수} / 전체 {total}건`.
- 검색: 입력 300ms 뒤 `q`로 다시 읽음(탭 유지). `더 보기` = `offset` + 50.

#### 4.4.3 입금 `#deposits`

- 머리 아래 상태 알약 2개 `span.pill#dep-hook`(`웹훅 켜짐` live / `웹훅 꺼짐 · DEPOSIT_TOKEN 미설정` warn), `span.pill#dep-auto`(`자동 승인 켜짐` / `자동 승인 꺼짐 · 입금이 확인되면 발급 대기로 바뀝니다`) + `a` `설정 보기`(`#settings`).
- 탭 `div.seg#dep-status`: `확인 필요`(`attn` = 화면에서 `unmatched`+`ambiguous`; API는 `status` 없이 읽고 거른다) · `매칭됨`(`matched`) · `무시`(`ignored`) · `전체`.
- 표 `#dep-tbl`: 금액(`.mono`, 없으면 `금액 못 읽음`) / 상태 칩(`미매칭` warn · `모호` crit · `매칭됨` live · `무시`) / 받은 시각 / 입금자 / 출처 / 매칭 주문(누르면 `#orders?q={id}`) / 펼침(원문 `pre.raw` — 텍스트로만, 줄바꿈 유지).
- 동작: `미매칭`·`모호` → `매칭`(시트, 아래), `무시`. `무시` → 즉시 `POST /admin/deposit-ignore` → 행이 `무시`로 바뀌고 토스트 `무시했습니다.` + 작업 버튼 `되돌리기`(6초, → `POST /admin/deposit-restore`). `무시` 행에는 `되돌리기` 버튼이 늘 있다.
- **매칭 시트** `#sheet`(제목 `입금 매칭`): 왼쪽(폰은 위) 입금 카드(금액, 시각, 입금자, 원문), 오른쪽 후보 주문 목록 = `GET /admin/orders?status=pending` + `?status=paid` + 최근 `canceled` 중 `auto_canceled`(7일 안) 합친 것, `|입금액 − 주문액|` 작은 순, 같으면 최근 순. 금액이 같은 주문은 `.exact`(왼쪽 `--live` 선 + `금액 일치` 태그). 후보를 고르면 아래 확인 줄: `입금 {a}원을 주문 {id}({b}원)에 매칭하고 승인합니다. 키가 발급되거나 연장되고 주문이 완료됩니다.` + `매칭 + 승인`. 금액이 다르면 문장 앞에 `● 금액이 다릅니다 · 입금 {a}원 / 주문 {b}원.`(crit)이 붙고 버튼이 `금액이 달라도 매칭`으로 바뀐다. → `POST /admin/deposit-match`. 성공하면 시트 안 결과 카드(승인 결과와 같은 모양, `issued`로 `신규 발급`/`기존 키 연장`).

#### 4.4.4 키 `#keys`

```html
<div class="ph"><div><h1 id="key-title" tabindex="-1">키</h1><p>라이선스 키와 기능별 기간, 콘솔에 등록된 카카오 계정입니다.</p></div>
  <div class="ph-r"><button type="button" class="btn primary" data-act="issue">[i-plus]새 키 발급</button></div></div>
<section class="sec clip">
 <div class="toolbar">
   <input class="inp" id="key-q" type="search" placeholder="키 · 소유자 · 연락처 · 메모" aria-label="키 검색" autocomplete="off">
   <div class="seg" id="key-status" role="group" aria-label="키 상태"><span class="seg-ind"></span>
     <button data-s="" aria-pressed="true">전체</button><button data-s="active">사용 중</button><button data-s="expiring">7일 안 만료</button>
     <button data-s="expired">만료</button><button data-s="unused">미사용</button><button data-s="stopped">회수·차단</button></div>
   <div class="sel"><select id="key-feature" aria-label="기능"><option value="">모든 기능</option><option value="macro">자동발송 매크로</option><option value="roombot">대화방 관리봇</option><option value="minigame">미니게임봇</option></select>[i-down]</div>
 </div>
 <div class="tbl-wrap"><table class="tbl stack" id="key-tbl"><thead><tr><th>키</th><th>상태</th><th>소유자</th><th>기능</th><th>카카오 계정</th><th>콘솔 시작</th></tr></thead><tbody></tbody></table></div>
 <div class="sec-f"><span id="key-cnt"></span><button type="button" class="btn sm" id="key-more" hidden>더 보기</button></div>
</section>
```

- 상태 칩: `차단`(crit, `blocked_reason`) > `회수`(crit) > `미사용`(기능이 모두 미개시) > `만료`(켜진 기능 없음) > `사용 중`(live). **`device_id`로 판단하지 않는다**(콘솔만 쓰는 키가 영원히 미사용으로 보이던 문제).
- 기능 칩: `매크로 D-23` / `관리봇 미개시` / `미니게임 만료`(7일 이하 warn, 만료 crit, 미개시 기본). 행 클릭·Enter → 키 시트.
- **키 시트**(`#sheet`, 제목 = 키, 폭 520px, 폰 전체 화면):
  - 머리: 키(모노 크게) + `키 복사` + 상태 칩 + 차단 사유(crit).
  - `기능` 블록: 기능마다 행 — 이름, `{plan} · {YYYY.MM.DD}까지` 또는 `미개시 · {n}일`, 칩, 오른쪽 `회수`(작은 danger 링크 → 4.5 확인 대화상자, 입력 확인 없음, 문장 `{기능} 기능을 이 키에서 삭제합니다. 남은 기간도 함께 사라지며 되돌릴 수 없습니다.`). 아래 `기능 추가·연장` 버튼 → 블록 안 인라인 패널: 기능 체크(3개, 설명은 5.5 상품 설명) + 기간 `seg`(`1개월` `3개월` `1년` `직접 입력` + 일수 1~3,650) + **미리 보기 표**(기능마다 `지금 {현재 만료 또는 미개시} → 적용 후 {새 만료}`; 3.4 규칙을 화면에서 같은 식으로 계산: 시작된 기능 = `max(now, 만료) + 기간`, 미개시인데 키가 쓰인 적 있음 = `now + 남은 기간 + 기간`, 키가 쓰인 적 없음 = `미개시 · {합친 일수}일`) + `적용`.
  - `정보` 블록(`dl.kvs`): 소유자·연락처·메모(각각 연필 버튼 → 그 자리 입력 → `POST /admin/license-update`), 발급, 콘솔 시작(`activated_at`), 마지막 기록.
  - `카카오 계정` 블록: `accounts` 행 — 이메일(모노) + 상태(`접속 중` live / `연결 대기` warn / `등록 필요` crit / `발송 중지` warn) + 등록일. 없으면 `콘솔에 등록된 카카오 계정이 없습니다.`
  - `이전 휴대폰 앱` 블록(`legacy_app`이 있을 때만, 접힌 상태 `details`): `기기 이름`, `앱 활성화`, `기기 초기화 {n}회`. 설명 `휴대폰 앱 지원 종료 전 기록입니다. 지금 동작에는 영향이 없습니다.`
  - `최근 기록` 블록: 20행(시각·종류 칩·내용) + `이 키의 기록 전체`(`#audit?key=`).
  - `동작` 줄(시트 아래 고정): `차단`/`차단 해제`, `회수`/`회수 복구`, `키 삭제`(danger).
    - 차단: 인라인 패널 — 사유 입력(필수, 500자) + 칩 `키 공유 의심` `환불 완료` `결제 취소` + `차단` danger. 문장 `이 키를 차단합니다. 콘솔에 바로 들어올 수 없고, 10분 안에 이 키의 모든 발송과 응답이 멈춥니다.`
    - 회수: 확인 대화상자 `키 회수` / `이 키의 사용을 중지합니다. 콘솔에 바로 들어올 수 없고, 10분 안에 이 키의 모든 발송과 응답이 멈춥니다. 나중에 복구할 수 있습니다.` / `회수`. 복구는 확인 없이 바로(토스트에 `되돌리기`).
    - 삭제: 확인 대화상자, 입력 확인 — 라벨 `키 마지막 4자리를 입력하십시오`, 맞아야 `영구 삭제` 버튼이 켜진다. 문장 `이 키를 영구 삭제합니다. 기능, 기간, 콘솔에 등록된 카카오 계정 {n}개가 모두 삭제되며 되돌릴 수 없습니다.`
- **새 키 발급 시트**(`data-act="issue"`, 제목 `새 키 발급`): 기능 카드 3장(체크, 이름 + 설명), 기간 `seg`(+ 직접 입력 일수), `수량`(1~100, 기본 1), `소유자 이름`, `연락처`, `메모`(모두 선택), `발급`. 검사: 기능 0개 `기능을 1개 이상 선택하십시오.` / 일수 범위 `일수를 1~3,650 범위로 입력하십시오.` / 수량 `1회 최대 100개까지 발급합니다.` 결과: `{n}개 발급했습니다.` + 키 목록(모노, 줄마다 `복사`) + `전체 복사`(줄바꿈으로 이음) + `텍스트로 받기`(`Blob` → `kbot-keys-{YYYYMMDD-HHMM}.txt` 내려받기) + `닫기`. 닫으면 목록 다시 읽기.

#### 4.4.5 기록 `#audit`

- 도구 줄: 종류 칩 줄 `div.kchips#aud-kinds[role=group]`(첫 칩 `전체`, 이어서 `ALERT_KINDS`를 앞에 crit 점과 함께, 그다음 나머지. `aria-pressed`) + `input#aud-key`(`키로 좁히기`) + `input#aud-ip`(`IP로 좁히기`) + `조회`.
- 종류 이름표: `activate` 사용 시작 · `expired` 기간 만료 · `revoked` 회수·차단·삭제 · `order` 주문 · `bad_deposit_token` 입금 코드 오류 · `bad_admin_pw` 관리자 비밀번호 실패 · `admin` 관리자 작업 · `admin_login` 관리자 로그인 · `mismatch` 기기 불일치(이전 앱) · `takeover` 동시 사용(이전 앱) · `bad_sig` 앱 위조(이전 앱) · `tamper` 앱 변조(이전 앱) · `reset` 기기 초기화(이전 앱). 서버가 모르는 종류를 주면 원래 값 그대로.
- 표 `#aud-tbl`: 시각(`MM.DD HH:MM:SS` 모노) / 종류 칩(경고 종류 crit) / 키(누르면 키 시트) / 내용 / IP(누르면 IP 필터). 경고 종류 행은 `--crit-bg` 바탕.
- `더 보기` = `before_id`. 처음 100행.

#### 4.4.6 설정 `#settings`

읽기 전용 카드 4개(`section.sec` + `.srow` 값은 오른쪽 모노):
1. `입금 자동 확인`: 웹훅(`켜짐`/`꺼짐 · DEPOSIT_TOKEN 미설정`), 자동 승인(`켜짐`/`꺼짐`), 미입금 자동 취소(`{n}시간`). 설명 `은행 알림을 받은 휴대폰 자동화 앱이 /api/deposit-hook 으로 보냅니다. 설정은 docs/AUTO_DEPOSIT.md를 따릅니다.`
2. `구매 안내`: 입금 계좌(`BANK_INFO`), 관리자 연락처(`CONTACT_INFO`).
3. `발송 서버`: 상태, 사유, 등록된 카카오 계정 수, 기능 상태 맞춤 주기 `{n}분`.
4. `관리자 세션`: 이 브라우저 세션 만료 시각, 유지 시간 `12시간`, `나가기` 버튼. 레이트리밋 표(종류 · 분당 한도).
- 카드 바닥줄 공통: `값은 Render 환경변수에서 바꿉니다. 바꾼 뒤 다시 배포해야 적용됩니다.`

### 4.5 확인 패턴

- 브라우저 `alert` `confirm` `prompt` 금지.
- **인라인 패널**(기본): 행·블록 안에서 펼쳐지는 작은 폼(승인, 취소, 차단, 메모, 기능 추가). 펼침은 V5 `grid-template-rows 0fr→1fr`, 열면 첫 입력에 포커스, `Esc`·`취소`로 닫고 연 버튼에 포커스 복귀.
- **확인 대화상자** `#dlg`(되돌릴 수 없는 일: 기능 회수, 키 회수, 키 삭제): `role=alertdialog`, 바깥 클릭으로 닫히지 않음, `Esc` = 취소, 처음 포커스는 `취소`(위험한 버튼에 먼저 가지 않음), 탭 순환을 대화상자 안에 가둠, 닫으면 연 요소로 포커스 복귀. 위험 버튼은 `btn danger solid`. 입력 확인이 있으면 맞을 때까지 `disabled`.
- **되돌리기 토스트**: 되돌릴 수 있는 일(입금 무시, 회수 복구, 차단 해제)은 확인 없이 하고 토스트에 `되돌리기`(6초).
- 동작 중 버튼은 `.busy` + `disabled`. 두 번 눌러도 요청은 한 번.

### 4.6 폴링·모션·모바일·안전

- 폴링: `stats`는 앱이 보이는 동안 30초마다(사이드바 배지·`#sync`). `#overview` `#orders` `#deposits`는 보이는 동안 20초마다 그 목록. `#keys` `#audit` `#settings`는 들어올 때와 `새로고침`만. `document.hidden`이면 건너뛰고, 다시 보이면 바로 1회. 늦은 응답(요청 순번이 바뀜)은 버린다. 서명이 같으면 다시 그리지 않고, 새 행만 `.fresh`(V5 5.4). 펼친 행·입력 중 검색어·스크롤을 유지한다.
- 20초 안에 응답이 없으면 그 화면 오류 줄에 `서버가 20초 안에 응답하지 않았습니다. 서버가 잠들어 있으면 첫 요청이 늦습니다. 다시 시도하십시오.` (`AbortController`).
- 모션: V5 5장 그대로(화면 교차 전환, 행 펼침, 토스트, 배지 `bump`, 세그먼트 표시). 시트는 오른쪽에서 `translateX(100%) → none` `--d3`, 배경 `--scrim` 페이드. 대화상자는 `scale(.97) → none` + 페이드 `--d2`. 동작 줄이기면 모두 즉시.
- 모바일(≤760px): 표는 V5 `.tbl.stack` 카드 목록, 시트·대화상자는 전체 화면, 도구 줄은 줄바꿈, 버튼·입력 높이 ≥ 44px(사이드바·칩) / ≥ 32px(그 밖). 390px에서 가로 넘침 없음.
- 안전: 주문(구매자·입금자·연락처·메모), 입금 원문, 기록 내용, 기기 이름, IP는 모두 공격자가 넣을 수 있는 글자다. **`textContent`로만 넣는다**(`innerHTML`에 서버 값을 넣지 않음. 고정 마크업 조각만 `innerHTML` 허용). 링크 `href`도 서버 값으로 만들지 않는다(주문 링크는 `/order/` + `encodeURIComponent(id)`).
- 복사: `navigator.clipboard.writeText`, 실패하면 숨긴 `textarea` 선택 + `document.execCommand('copy')`, 그것도 실패하면 토스트 `복사하지 못했습니다.` + `직접 선택하여 복사하십시오.` 성공 토스트 `복사했습니다.` + 무엇(`키` `주문번호` 등).

### 4.7 관리자 화면 문구 모음

| 위치 | 문구 |
|---|---|
| 503 사용 불가 화면(`#login-disabled`) | `서버에 관리자 비밀번호가 설정되지 않아 관리자 화면을 열 수 없습니다. Render 환경변수 ADMIN_PASSWORD를 설정한 뒤 다시 배포하십시오.` |
| 429 대기(`#login-wait`) | `비밀번호 입력 실패 횟수를 초과했습니다. {mm:ss} 후 다시 시도하십시오.`(1초마다 줄어듦, 그동안 `#loginBtn` `disabled`) |
| 401 비밀번호 틀림 | `비밀번호가 일치하지 않습니다.` |
| 빈 비밀번호 | `비밀번호를 입력하십시오.` |
| 빈 목록 | 주문 `해당 조건의 주문이 없습니다.` · 입금 `입금 기록이 없습니다. 자동화 앱이 /api/deposit-hook 으로 알림을 보내면 이곳에 표시됩니다.` · 키 `조건에 맞는 키가 없습니다.` · 기록 `해당 조건의 기록이 없습니다.` |
| 로그아웃 | 토스트 없이 로그인 화면, 입력칸 포커스 |

---
