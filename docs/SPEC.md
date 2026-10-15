# K bot — 전체 설계 명세 (v6 · 회원 계정 · 상품 3종 · 방 설치형 봇)

이 문서는 **서버 · 구매 웹사이트 · 발송 콘솔(`/panel`) · 관리 콘솔(`/manage`) · 서버 발송(`sender/`)** 의 계약을 요약한다.
상세 구현 명세는 **`docs/ACCOUNTS_V1.md`** 가 단일 기준이다(이 문서와 어긋나면 ACCOUNTS_V1 이 이긴다). 새 필드를 추가하면 두 문서를 같이 고친다.

> **안드로이드 앱은 단종됐다.** 앱 전용 API(`/verify` `/heartbeat` `/entitlements` `/config` `/pubkey`)와 앱 서명 관리자 API 는 제거됐다(아래 8장).
> **라이선스 키 판매도 끝났다.** 모든 구매·지급은 회원 계정(`members`)에 붙는다. 예전 키는 회원이 `/account` 에서 이관한다.

---

## 0. 인프라

| 구성 | 위치 |
|---|---|
| 회원·결제 서버 + 구매 웹 + 콘솔 | Render (Node 22, Express) — `server.js` `lib/` `routes/` `public/` |
| DB | Neon Postgres (`DATABASE_URL`). 마이그레이션은 `lib/db.js` `STEPS`(idempotent, DROP 없음) |
| 서버 발송 | `sender/` — 서버가 띄우는 자식 프로세스(127.0.0.1 전용). 고객 카카오 계정과 운영자 K bot 계정의 세션을 `kakao_sessions` 에 둔다 |

환경변수는 `DEPLOY.md` 와 ACCOUNTS_V1 9.6 이 단일 소스다. 요점:
- `ADMIN_PASSWORD` — `/admin/*`(= `/manage`) 비밀번호.
- `CONFIG_SECRET` — 서명·봉인 키(16자 이상). OAuth 상태 쿠키, 채널톡 회원 식별, **방 참여코드 봉인**(`lib/secretbox.js`)에 쓴다.
- `BANK_INFO` `CONTACT_INFO` `PURCHASE_BASE` — 구매 페이지 표시값·주문 주소.
- `DEPOSIT_TOKEN` `DEPOSIT_AUTO_APPROVE` — 자동 입금확인.
- `SENDER_TOKEN` `SENDER_KEY` — 발송 자식. 없으면 발송 자식만 안 뜨고 나머지는 열린다.
- 회원·주문 한도: `MEMBER_MAX_SESSIONS`(3) `MEMBER_MAX_ACCOUNTS`(3) `MEMBER_MAX_PENDING_ORDERS`(3) `MEMBER_MAX_PENDING_ROOMS`(10) `IP_MAX_PENDING_ORDERS`(10) `ROOM_RETRY_BASE_MS`(120000) `ROOM_SELF_MOVE_GAP_MS`(24시간) `ROOM_SELF_REINSTALL_GAP_MS`(30분) `ROOM_HOLD_WORDS` `ROOM_LOG_KEEP_DAYS`(30) `ORDER_PENDING_TTL_MS`(48시간).

---

## 1. 판매 구성 — 상품 3종 (`lib/pricing.js` 단일 소스)

| id | 화면 이름 | 가격 | 단위 | 동작 주체 |
|---|---|---|---|---|
| `macro` | 카카오톡 매크로 | 15,000원 | 1개월(30일), 1~12개월 | 고객 **자기** 카카오 계정(콘솔에 등록, 회원당 3개) |
| `roombot` | 방 관리봇 | 10,000원 | 방 1개, 기간 없음 | 운영자 **K bot 계정**(방장이 부방장으로 지정해야 방 관리 기능 동작) |
| `minigame` | 미니게임봇 | 10,000원 | 방 1개, 기간 없음 | 운영자 K bot 계정(입장하면 바로 동작) |

```
PRODUCTS = { macro:{id,label,unit:'month',price:15000,days:30,min:1,max:12,desc},
             roombot:{id,label,unit:'room',price:10000,desc}, minigame:{…} }
MAX_ROOMS = 10
quote({macro_months, rooms:[{products:[…]}]})
  → {ok:true, lines:[{product, months?, room?, unit_price, amount}], total}
  | {ok:false, reason:'empty'|'bad_months'|'too_many_rooms'|'no_products', error, room?}
table()  → GET /api/price 본체      label(id) · bankInfo() · contactInfo()
```

- 금액 = `macro_months × 15000 + (방 상품 줄 수) × 10000`. 할인 없음. 주문 1건 최대 380,000원(매크로 12개월 + 방 10개 × 2상품).
- 카카오톡 매크로 기간: 결제 확인 시점부터 30일 × 개월. 다시 사면 `max(지금, 만료) + 30일 × 개월`(`members.macro_until`). 만료되면 sender 가 그 회원의 고객 계정 접속을 멈춘다.
- 방 상품: 설치 권리는 오픈채팅방의 **link_id**(카카오가 정한 방 id)에 영구히 묶인다. 한 방에 두 상품을 함께 둘 수 있고 같은 K bot 계정이 맡는다. 결제된 설치는 방마다 1개(부분 UNIQUE). 미입금 예약은 다른 회원을 막지 않고 **먼저 입금된 주문이 방을 갖는다**(D9).
- 화면 이름·설명은 `lib/features.js` `LABELS`·`DESCS` 가 단일 소스다(`자동발송 매크로`·`대화방 관리봇` 은 더 쓰지 않는다).

---

## 2. DB 스키마 (요약)

> 테이블·컬럼을 드롭하거나 이름을 바꾸지 않는다. 쓰지 않는 컬럼은 그대로 둔다. 전체 SQL 은 `lib/db.js` 와 ACCOUNTS_V1 2.1.

| 표 | 용도 |
|---|---|
| `members` | 회원. `login_id`(소문자 UNIQUE) · `pw_hash`(scrypt) · `macro_until` · `legacy_room_until` · `blocked_reason` |
| `member_sessions` · `member_google` | 로그인 세션(쿠키 `kb_s`, 회원당 동시 3대) · Google 연결(`sub`) |
| `licenses` · `entitlements` | 예전 라이선스 키와 기능별 기간. `licenses.member_id`·`claimed_at` = 회원 이관 |
| `panel_accounts` · `panel_pending` | 콘솔에 등록한 고객 카카오 계정. `member_id`(새 등록) 또는 `license_key`(예전 키) |
| `orders` | 주문. 회원 주문은 `kind='member'`, `member_id`, `items`(줄), `applied`(적용 결과), `ip`, `terms_at`. 예전 키 주문은 `kind` NULL |
| `deposits` | 입금 알림 원문과 매칭 결과 |
| `bot_accounts` · `bot_pending` | 운영자 K bot 계정 풀(device_id `bot.<16hex>`, 봇마다 `room_cap` 기본 20) |
| `room_installs` | 방 설치 1개 = 방 1개. `phase`(pending_payment·installed·canceled·removed, 부모가 씀) · `state`(queued·joining·waiting_host·active·error, sender 가 씀) · `bot_device_id` · `passcode_ct`(봉인) · `config`(방 설정) |
| `room_leaves` · `room_blocklist` | K bot 나가기 대기열(옮기기·해제·링크 바꾸기·금지) · 설치 금지 방 |
| `room_state` · `room_log` | sender 의 방별 실행 상태 · 조치 기록(30일 보존) |
| `audit_log` | 감사 기록. `member_id` 칸 추가. 종류: `order` `revoked` `bad_deposit_token` `bad_admin_pw` `member` `member_lockout` `install` `bot`(+ 옛 기록) |
| `kakao_sessions` | sender 소유. `features` v2 = `{v:2, macro_until, legacy_room_until, grants_at, reg_at}`(고객) / `{v:2, bot:true}`(봇) |

**`orders.items`**(줄 단위, 방 상품은 상품마다 한 줄이고 항상 `install_id` 가 있다):
```json
[ { "product": "macro",    "months": 2, "unit_price": 15000, "amount": 30000 },
  { "product": "roombot",  "install_id": 12, "link_url": "https://open.kakao.com/o/gAbCdEf", "link_name": "동네모임", "unit_price": 10000, "amount": 10000 },
  { "product": "minigame", "install_id": 12, "link_url": "https://open.kakao.com/o/gAbCdEf", "link_name": "동네모임", "unit_price": 10000, "amount": 10000 } ]
```
확인하지 못한 방 줄은 `"unverified": true`, 확인 대기 낱말(`ROOM_HOLD_WORDS`)에 걸린 방 줄은 `"hold": true`. 참여코드는 줄에 넣지 않는다(`room_installs.passcode_ct` 에만, AES-256-GCM 봉인).

**`orders.applied`**: `{ "macro": {"days":60, "until":ms}, "rooms":[{"install_id":12, "products":["roombot","minigame"]}], "skipped":[{"install_id":13, "products":["minigame"], "amount":10000, "why":"room_taken"}] }`.
예전 키 주문이 이관된 키를 가리킨 경우 `{"legacy_to_member": true, "macro": {...}, "legacy_room_until": ms}`.

---

## 3. 구매 API (`routes/purchase.js`)

응답 공통: 성공 `{ok:true, …}`, 실패 `{ok:false, reason, error}` + 상태 코드(400·401·403·404·409·422·429·503). `error` 는 화면에 그대로 보인다.

| 메서드·경로 | 인증 | 요약 |
|---|---|---|
| GET `/api/price` | 없음 | `{ok, currency, products:[3종], max_rooms, bank, contact, purchase_base, auto_approve}` |
| POST `/api/room-preview` `{link}` | 회원 | 붙여넣은 글에서 링크를 뽑아(`openchat.normLink`) 봇으로 조회(sender `/v1/bot/resolve`, 10분 메모리 저장, 회원당 시간 60회). `{ok, verified, room:{link_url, link_id, name, needs_passcode, profile_only, max_users}, mine, available}`. 실패: 400 `bad_link`, 403 `blocked_room`, 404 `not_found`, 422 `not_group`, 409 `taken`(다른 회원의 결제된 설치). sender·봇이 없거나 조회 예산이 바닥나면 `verified:false`(주문은 확인란 동의로 가능, D10) |
| POST `/api/order` | 회원 | `{macro_months, rooms:[{link, passcode, products, unverified_ok} \| {install_id, products}], terms, depositor, contact?, memo?}`. 검증 오류는 ACCOUNTS_V1 3.3 표(방 오류는 `room` = 보낸 배열의 위치). 새 방은 그 회원의 `pending_payment` 설치로 예약, 같은 회원의 기존 설치와 같은 방이면 상품 추가 줄로 바뀐다. 한 트랜잭션에서 금액 뒷자리 추첨(전역 잠금) → 미입금 상한(회원 3건·방 줄 10개·IP 10건) → 예약 → 주문 INSERT. 응답 `{ok, id, token, url, amount, base_amount, suffix, needs_review, items:[공개 줄], bank, account, contact_info, auto_approve, created_at, status}` |
| GET `/api/order/:id` | 토큰 `?t=` 또는 주문 주인 회원 | 남의 주문은 404. 회원 주문: `kind`, `items`, `applied`(done), `can_cancel`, `accounts_n`(주인일 때), `rooms:[{install_id, link_url, link_name, display, label, detail, bot}]`. 예전 키 주문만 `issued_key` |
| GET `/api/my/orders` | 회원 | 최근 50건 `{id, created_at, status, auto_canceled, amount, items, applied, url, can_cancel}` |
| POST `/api/my/orders/cancel` `{id}` | 회원 | 자기 `pending` 주문만. 그 주문이 예약한 방도 `canceled`. 409 `not_pending` |
| POST `/api/lookup` `{key}` | 없음 | 예전 키 조회(기능별 만료). `claimed`(회원 이관 여부) 추가 |
| POST `/api/deposit-hook` | `DEPOSIT_TOKEN` | 7장 |

방 상태 표시(0.1, `lib/installs.js` `displayOf`·`publicView` 가 단일 소스):

| `display` | 라벨 | 근거 |
|---|---|---|
| `pending` | 입금 대기 | `phase='pending_payment'` |
| `joining` | 입장 중 (`입장 중 · 순서 대기`) | 입장 대기·진행, 봇 없음(`no_bot`), 속도 제한, 운영자 확인 대기(`hold_reason`) |
| `waiting` | 부방장 대기 | 방 관리봇이 있고 K bot 계정이 부방장이 아님 |
| `active` | 사용 중 (`사용 중 · 켜진 기능 없음`) | |
| `error` | 오류 · {짧은 사유} | `error_code`(ACCOUNTS_V1 5.6 표 = `installs.ERRORS`) |

고객 다시 시도는 오류 코드별로 정해져 있고(참여코드·인원 초과·내보내짐·방 나감·프로필 제한·입장 거부), 간격은 2분부터 두 배씩(최대 6시간), 연속 10번이면 관리자만 할 수 있다.

---

## 4. 회원·콘솔 API (요약)

- 회원·인증(`routes/auth.js`): `/api/site`, `/api/me`, `/api/auth/signup|login|logout|logout-all|sessions|password|claim|google/unlink`, `/auth/google/start|callback`. ACCOUNTS_V1 3.2.
- 콘솔(`routes/panel.js`, 회원 세션): 고객 카카오 계정 등록·매크로 설정·갠톡 + 내 방(`/panel/api/bot-rooms`, `bot-room`, `bot-room/settings|retry|logs|people|hide|unkick|games-reset`). ACCOUNTS_V1 3.4.
- 기존 키 이관(`entitle.claimKey`): 매크로 남은 기간을 회원 기간에 **더하고**, 키에 묶인 콘솔 계정을 회원 것으로 옮긴다. 이관된 키는 고객이 다시 옮길 수 없다(관리자 `license-reassign`).

---

## 5. 관리자 API (헤더 `x-admin-password`, `routes/admin.js`)

기존 키 경로(`/admin/create` `/admin/grant` `/admin/list` …)는 관리자 지원용으로 남는다. 이관된 키에 대한 `/admin/grant` 는 409.
추가·변경(ACCOUNTS_V1 3.5): 주문 승인(`order-approve {id, skip_conflicts?}` — 같은 방 충돌이면 400 + `conflicts`, 충돌 줄을 빼고 승인하면 `applied.skipped` 와 환불할 금액), 입금 매칭(이미 매칭된 입금 409), 회원(`members` `member` `member-grant` `member-block` `member-logout` `member-pwreset`), 키 옮기기(`license-reassign`), 방(`rooms` `room` `room-grant` `room-retry` `room-move` `room-remove` `room-rebind` `room-transfer` `room-products` `room-block` `room-unblock` `room-blocks` `room-release`), K bot 계정(`bots` `bot-register/*` `bot-update` `bot-remove`).
방 관리 동작은 `lib/installs.js` 의 함수(`grantRoom` `retry({admin})` `move` `remove` `rebind` `transfer` `setProducts` `block` `unblock` `release`)를 그대로 부르고, 나가기는 `room_leaves` 로 sender 에 맡긴다.

---

## 6. sender 내부 API (요약)

자식은 127.0.0.1 에서만 듣고 부모는 `lib/sender-child.js` `call()` 로만 부른다(공개 `/v1/*` 프록시 없음). 모든 요청에 `x-sender-token`.
부모가 쓰는 것: `POST /v1/grants`(고객 계정 권리 `{v:2, macro_until, legacy_room_until}`; `full:true, as_of` 면 목록에 없는 고객 기록을 멈춤), `POST /v1/bot/resolve {url}`(링크 조회, 봇별 조회 예산), `POST /v1/bot/sync {install_id?}`(설치·나가기 대기열 다시 읽기), `GET /v1/bot/status|room|logs|people`, `POST /v1/bot/hide|unkick|games-reset`. ACCOUNTS_V1 3.6.

권리 밀기(`entitle.pushGrants`): 승인 직후(그 회원), 이관·재배정 직후, 관리자 지급·차단, 계정 등록 완료 직후, **자식이 뜰 때마다(`SENDER_READY`, 전체)**, 10분마다(전체).
`entitle.startLoop` 는 그 밖에 하루 1번 오래된 `room_log`(30일)·처리된 `room_leaves`(30일)·만료 세션·만료 `bot_pending` 을 지운다.
`installs.startLoop` 는 1분마다 봇 없는 설치를 다시 배정하고(가장 적게 맡은 봇, 상한 `room_cap`), 15분 넘게 `joining` 에 멈춘 설치를 `queued` 로 되돌린다.

---

## 7. 자동 입금확인 (회원 계정에 무인 적용)

PG 없이 **개인 계좌 + 판매자 폰 자동화**로 입금을 자동 확인해 주문을 회원 계정에 적용한다. 설정 가이드는 `docs/AUTO_DEPOSIT.md`.

### 7.1 주문 금액 고유 뒷자리

`amount = 총액 + suffix(1~99)`. suffix 는 현재 `pending` 주문 중 같은 금액이 없도록 고른다(`keys.pickAmount`, 전역 advisory lock).
가격이 모두 5,000원 배수라 총액이 다르면 뒷자리 구간이 겹치지 않는다. 전부 충돌하면 `suffix=0` + `needs_review`.

### 7.2 `POST /api/deposit-hook`

인증: 헤더 `x-deposit-token` 또는 쿼리 `?t=`(타이밍 안전 비교). `DEPOSIT_TOKEN` 미설정이면 503.
요청은 `{text|message|body|raw, source, at}` JSON, text/plain, 폼 어느 쪽이든 받는다. 응답은 항상 200 + `ok:true`, 결과는 `status`(`matched` `unmatched` `duplicate` `ambiguous` `ignored`).

처리 순서:
1. 같은 본문의 1~2시간 안 재전송 → `duplicate`.
2. 출금 알림 → `ignored`. 금액 후보 추출(`잔액|잔고|한도|누적` 바로 뒤 숫자 제외).
3. 후보로 `pending` 주문 조회 → 1건 `matched`, 2건↑ `ambiguous`, 0건 `unmatched`. 뒷자리 없는 주문(`needs_review`)은 `ambiguous`.
4. `matched` 면 `db.tx(c => keys.approveOrder(c, id, null))`:
   - 회원 주문: 매크로 기간 연장, 예약한 방을 `installed` + K bot 계정 배정(확인 대기 낱말에 걸리면 `hold_reason`, 봇 배정 없음), 기존 설치는 상품만 켬, 처음 켜지는 미니게임은 게임 설정 기본값(켜짐). `orders.status='done'`, `applied`.
   - 같은 방을 다른 회원이 먼저 입금해 설치했으면 아무것도 적용하지 않고 `{reason:'room_taken'}` → 입금 `ambiguous`, 주문 `needs_review=TRUE`(pending 유지). 관리자가 `skip_conflicts` 로 나머지만 적용하고 그 방 금액을 환불한다.
   - 예전 키 주문: 예전 규칙(새 키 발급 또는 대상 키 연장). 대상 키가 회원에게 이관된 키면 그 회원에게 적용(`legacy_to_member`).
5. 커밋 뒤 `entitle.afterApprove(결과)`(기다리지 않음): 그 회원 계정에 권리를 밀고(`/v1/grants`) 새 설치를 sender 에 알린다(`/v1/bot/sync`).
6. 입금자명이 주문서와 달라도 거부하지 않고 감사 경고만 남긴다(금액이 고유하므로 금액을 신뢰).

`DEPOSIT_AUTO_APPROVE=0` 이면 `matched` 주문을 `paid` 로만 바꾸고 적용은 관리자가 한다. 중복 검사(같은 방·같은 상품)는 `paid` 도 처리 대기로 센다.

### 7.3 48시간 미입금 자동취소

`ORDER_PENDING_TTL_MS`(기본 48시간)를 넘긴 `pending` 주문을 **신규 주문 생성 시** `pickAmount` 직전에 자동취소한다(`auto_canceled=TRUE` + 메모).
같은 트랜잭션에서 그 주문이 예약한 `pending_payment` 방도 `canceled`. 관리자가 승인하면 복구되며, 그 사이 다른 회원이 같은 방을 설치했으면 그 방 줄은 충돌로 남는다. 사람이 취소한 주문(관리자·회원)은 복구되지 않는다.

---

## 8. 제거된 것

- **앱 라이선스 API**(`/verify` `/heartbeat` `/entitlements` `/config` `/pubkey`)와 앱 서명 관리자 API, 관련 환경변수(`SIGNING_PRIVATE_KEY` `ALLOWED_APP_SIGS` `APP_SIG_MODE` `MIN_APP_VERSION` `RECHECK_MS` `GRACE_MS` …), 안드로이드 소스와 빌드 워크플로.
- **라이선스 키 판매·키 로그인**: 새 주문은 키를 발급하지 않고, `/panel` 은 회원 아이디로만 로그인한다. 단일 상품 `K bot 1개월 30,000원`(`pricing.PRICE`·`PLAN`·`NAME`, 인자 없는 `quote()`)은 없어졌다.
- **부모의 공개 `/v1/*` 프록시**(`senderChild.install`·`proxy`): sender 내부 API 는 인터넷에 노출하지 않는다.

DB 는 예외다 — **테이블·컬럼은 드롭하지 않고** 그냥 쓰지 않는다.

---

## 9. 하위호환

- 예전 키와 키 주문은 그대로 유효하다. 미이관 키에 묶인 고객 계정은 키 만료일까지 발송을 계속한다(서버가 키 만료일로 권리를 밀어 줌). `keys.PLANS` 의 `quarter`/`year` 라벨은 그 표시를 위해 남겨 둔다.
- 예전 가격으로 받은 미입금 키 주문은 입금되면 예전 규칙으로 처리한다(이관된 키면 회원에게 적용).
- 키를 이관한 회원은 그 키의 가장 늦은 만료일(`legacy_room_until`)까지 계정 단위 옛 기능(입장·퇴장 로그·프로필 로그·올킥 방지·금지어 검열)을 콘솔에서 계속 쓴다.
- `/api/lookup` 의 기능 상태 맵은 항상 3종(`macro`·`roombot`·`minigame`)을 같은 순서로 돌려준다.

---

## 10. 디자인 · 문구

- 화면 명세: `docs/UI_V5.md`(콘솔), ACCOUNTS_V1 6장(사이트·콘솔·관리 화면 변경)과 부록 A(사이트 문구 표).
- 서비스 이름 표기: `docs/BRAND.md` (**K bot**). 사용자 노출 문구 규칙: `docs/TONE.md`.
