# K bot — 전체 설계 명세 (v5 · 웹 콘솔 + 서버 발송)

이 문서는 **서버 · 구매 웹사이트 · 발송 콘솔(`/panel`) · 관리 콘솔(`/manage`)** 의 계약(contract)이다.
구현 중 이 문서와 코드가 어긋나면 **이 문서가 기준**이다. 새 필드를 추가하면 이 문서도 같이 고친다.

> **안드로이드 앱은 단종됐다.** 사용자앱(KakaoAuto)·관리자앱(KakaoAdmin)과 그 전용 코드는 저장소에서 제거했다.
> 앱 전용 API(`/verify` `/heartbeat` `/entitlements` `/config` `/pubkey`)와 앱 서명 관련 관리자 API
> (`/admin/sigs` `/admin/sig-add` `/admin/sig-del` `/admin/reset-device`)도 함께 제거됐다 (아래 "제거된 것" 참고).
> 제품은 **웹 콘솔 + 서버 발송**이다.

---

## 0. 인프라

| 구성 | 위치 |
|---|---|
| 라이선스 서버 + 구매 웹 + 콘솔 | Render (Node 18+, Express) |
| DB | Neon Postgres (`DATABASE_URL`) |
| 서버 발송 | `sender/` — 라이선스 서버가 띄우는 자식 프로세스. 세션은 Neon `kakao_sessions` |

환경변수는 `DEPLOY.md` 1장이 단일 소스다. 요점:
- `ADMIN_PASSWORD` — `/admin/*`(= `/manage`) 비밀번호. 비었거나 `change-me-now` 면 `/admin/*` 전체 503.
- `CONFIG_SECRET` — `/panel` 로그인 쿠키 서명 키(16자 이상). 비었거나 짧으면 `/panel` 로그인 503. **앱 설정 암호화 용도는 폐기됐다.**
- `BANK_INFO` `CONTACT_INFO` `PURCHASE_BASE` — 구매 페이지 표시값.
- `DEPOSIT_TOKEN` `DEPOSIT_AUTO_APPROVE` — 자동 입금확인.
- `SENDER_TOKEN` `SENDER_KEY` — 발송 자식. 없으면 발송 자식만 안 뜨고 나머지는 열린다.

---

## 1. 판매 구성 — 단일 상품

상품은 하나다: **K bot 1개월 = 30,000원 / 30일 / 기능 3종 전부.**
기능별 개별 구매, 3개월·1년 플랜, 묶음 할인은 **없다.** 다시 사면(기존 키를 `target_key` 로) 그 키의 기능 3종이 각각 **`max(지금, 현재 만료)` 기준 30일씩 연장**된다.

| id | 한글명 | 설명 (`lib/features.js`) |
|---|---|---|
| `macro` | 자동발송 매크로 | 대화방 주기 발송 · 이미지 첨부 · 갠톡 자동응답 · 저격 규칙 |
| `roombot` | 대화방 관리봇 | 입장·퇴장 로그 · 프로필 변경 감지 · 금지어·링크 가림 · 올킥 감지 |
| `minigame` | 미니게임봇 | 끝말잇기 · 숫자야구 · 주사위 · 가위바위보 · 퀴즈 · 랭킹 |

- 기능마다 **독립된 만료일**(entitlement 단위)을 가진다. 단일 상품은 세 기능을 같은 날짜로 함께 연장한다.
- 기능을 셋으로 나눠 둔 것은 **예전 키(기능별로 산 키)와 관리자 개별 발급** 때문이다. 판매 흐름에서는 항상 3종이 함께 간다.
- 서버의 entitlements 표가 유일한 진실이다. `/panel` 과 서버 발송(`sender/`)은 이 표 기준으로만 기능을 연다.

### 가격 단일 소스 — `lib/pricing.js`

```
CURRENCY = 'KRW'
NAME     = 'K bot'
PLAN     = 'month'        // keys.SALE_PLANS 의 유일한 값
PLAN_DAYS= 30
PRICE    = 30000          // 원. 주문 금액 = PRICE + 뒷자리(1~99)
quote()      → { ok, name, features:[3종], plan:'month', plan_label:'1개월', days:30,
                 lines:[...], subtotal:30000, discount:0, bundle:false, amount:30000, currency:'KRW' }
table()      → GET /api/price 본체 (아래 5장)
bankInfo()   → BANK_INFO 또는 '관리자에게 문의'
contactInfo()→ CONTACT_INFO 또는 null
```
`quote()` 는 인자를 받지 않는다. 예전 호출부가 (기능목록, 플랜) 을 넘겨도 무시하고 같은 값을 준다.

플랜 코드: 판매는 `month`(30일) 하나다(`keys.SALE_PLANS = ['month']`).
`keys.PLANS` 에는 `quarter`(90일)·`year`(365일) 라벨이 **표시용으로만** 남아 있다 — 그 플랜으로 발급된 **예전 주문·키가 화면에 바르게 뜨게** 하기 위함이다. `custom`(일수 직접 입력)은 **관리자 발급 전용**이다.

---

## 2. DB 스키마 (Neon Postgres)

> **테이블·컬럼을 드롭하거나 이름을 바꾸지 않는다(운영 데이터).** 앱 단종으로 더 이상 쓰지 않는 컬럼은 **그대로 두고 쓰지 않을 뿐**이다.
> 마이그레이션은 기존 테이블을 유지한 채 `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` 로만 확장하며 **몇 번 실행해도 안전(idempotent)** 해야 한다.

```sql
licenses (
  key           TEXT PRIMARY KEY,
  plan          TEXT,              -- 최근 발급 플랜 (표시용)
  duration_ms   BIGINT,
  expires_at    BIGINT,            -- 전체 기능 중 가장 늦은 만료 (표시용)
  device_id     TEXT,              -- [앱 유물] 더 이상 쓰지 않음 (드롭 금지)
  device_name   TEXT,              -- [앱 유물]
  device_fp     TEXT,              -- [앱 유물]
  activated_at  BIGINT,            -- 최초 개시 시점 (/panel 이 쓸 수 있음)
  revoked       BOOLEAN DEFAULT FALSE,
  note          TEXT,
  created_at    BIGINT NOT NULL,
  last_seen     BIGINT,
  session_token TEXT,              -- [앱 유물]
  session_at    BIGINT,            -- [앱 유물]
  reset_count   INT DEFAULT 0,     -- [앱 유물]
  last_reset_at BIGINT,            -- [앱 유물]
  app_sig       TEXT,              -- [앱 유물]
  blocked_reason TEXT,             -- 관리자 차단 사유 (있으면 거부)
  owner_name    TEXT,
  owner_contact TEXT
)

entitlements (
  key         TEXT NOT NULL REFERENCES licenses(key) ON DELETE CASCADE,
  feature     TEXT NOT NULL,        -- macro | roombot | minigame
  plan        TEXT,
  starts_at   BIGINT,               -- 개시 전엔 NULL
  duration_ms BIGINT NOT NULL,
  expires_at  BIGINT,               -- NULL = 아직 미개시
  created_at  BIGINT NOT NULL,
  PRIMARY KEY (key, feature)
)

orders (
  id TEXT PRIMARY KEY,              -- ORD-YYMMDD-XXXXXX
  created_at BIGINT NOT NULL,
  status TEXT NOT NULL,             -- pending | paid | done | canceled
  features TEXT NOT NULL,           -- 쉼표구분 feature id (항상 3종)
  plan TEXT NOT NULL,               -- 항상 'month'
  base_amount INT,                  -- 기본 금액 (30000)
  amount INT NOT NULL,              -- 실제 입금액 (= base_amount + suffix)
  buyer_name TEXT, contact TEXT, depositor TEXT, memo TEXT,
  target_key TEXT,                  -- 기존 키 연장 대상
  token TEXT,                       -- 구매자 주문/키 조회용 비밀값 (24 hex)
  needs_review BOOLEAN DEFAULT FALSE,
  issued_key TEXT, handled_at BIGINT,
  auto_canceled BOOLEAN DEFAULT FALSE, -- 48시간 미입금 자동취소 (승인 시 되살아남)
  android_ok BOOLEAN DEFAULT FALSE     -- [앱 유물] 기본값 유지. 쓰지 않고 응답에 싣지 않는다
)

deposits (
  id BIGSERIAL PRIMARY KEY, at BIGINT NOT NULL,
  amount INT, name TEXT, raw TEXT NOT NULL, source TEXT,
  raw_hash TEXT NOT NULL,           -- sha256(raw) — 중복 전송 방어 (UNIQUE)
  matched_order TEXT,
  status TEXT NOT NULL              -- matched | unmatched | duplicate | ambiguous | ignored
)

audit_log (
  id BIGSERIAL PRIMARY KEY, at BIGINT NOT NULL, key TEXT, kind TEXT,
  device_id TEXT, device_name TEXT, detail TEXT, ip TEXT
)

app_signatures (sha256 TEXT PRIMARY KEY, label TEXT, allowed BOOLEAN DEFAULT TRUE, created_at BIGINT)  -- [앱 유물] 드롭 금지, 쓰지 않음
configs (key TEXT PRIMARY KEY, blob TEXT, rev BIGINT, updated_at BIGINT)  -- [앱 유물] 앱 설정 백업. 쓰지 않음
```

`audit_log.kind` 중 `order`·`bad_admin_pw`·`bad_deposit_token` 등 서버/주문 이벤트는 계속 쓴다.
`activate`·`mismatch`·`takeover`·`bad_sig`·`tamper`·`reset` 는 앱 유물이라 더 이상 기록되지 않는다(과거 행은 남아 있을 수 있다).
인덱스: `entitlements(key)`, `audit_log(at DESC)`, `audit_log(key)`, `orders(status, created_at DESC)`, `deposits(raw_hash) UNIQUE`.

카카오 세션 테이블 `kakao_sessions` 는 `sender/` 가 소유한다(토큰만 `SENDER_KEY` 로 봉인). 이 문서의 범위 밖이다 — `sender/README.md` 참고.

---

## 3. 구매 웹사이트 (`public/`, Express static + `routes/purchase.js`)

| 경로 | 내용 |
|---|---|
| `/` | 랜딩. 단일 상품 안내(가격·기능 3종·FAQ) |
| `/buy` | 구매 신청 폼: 입금자명(필수)·연락처·메모·기존 키(연장). 기능/플랜 선택은 없다 — 항상 3종 30일 |
| `/order/:id` | 주문 상태 조회 페이지 (5초 폴링, 발급되면 키 표시) |
| `/my` | 키 조회 페이지 (`POST /api/lookup`) |
| `/panel` | 발송 콘솔 (키로 로그인, `routes/panel.js`) |
| `/manage` | 관리 콘솔 (`ADMIN_PASSWORD` 로 로그인, `/admin/*` 호출) |

### 3.1 `GET /api/price` — 가격표 (서버 단일 소스)

```json
{ "ok": true, "currency": "KRW", "name": "K bot",
  "plan": "month", "plan_label": "1개월", "days": 30, "price": 30000,
  "features": [ {"id":"macro","label":"자동발송 매크로","desc":"..."},
                {"id":"roombot","label":"대화방 관리봇","desc":"..."},
                {"id":"minigame","label":"미니게임봇","desc":"..."} ],
  "plans": [ {"id":"month","label":"1개월","days":30,"price":30000} ],
  "bank": "카카오뱅크 3333-00-0000000 홍길동",
  "contact": "카톡ID: ...",
  "purchase_base": "https://...",
  "auto_approve": true }
```
`features` 는 **항상 3종**(ALL 순서). `bank`·`contact` 는 환경변수에서, `purchase_base`·`auto_approve` 는 라우터가 붙인다.

### 3.2 `POST /api/order` — 주문 접수

요청 본문:
```json
{ "depositor": "입금자명(필수)", "buyer_name": "", "contact": "", "memo": "", "target_key": "KAKA-...(선택)" }
```
- 서버는 본문의 `features`/`plan` 을 **무시**하고 항상 기능 3종 + `plan:'month'` 로 주문한다.
- `android_ok` 는 **받지도 쓰지도 않는다.**
- `amount = base(30000) + suffix(1~99)`. suffix 는 현재 `pending` 주문 중 같은 총액이 없도록 고른다
  (`lib/keys.js` 의 `pickAmount`). 전부 충돌하면 `suffix=0` + `needs_review=true`.
  `pickAmount` 직전에 48시간 넘긴 `pending` 주문을 자동취소해 뒷자리 풀을 회수한다.

응답:
```json
{ "ok": true, "id": "ORD-...", "token": "24hex", "url": "/order/ORD-...?t=...",
  "amount": 30047, "base_amount": 30000, "suffix": 47, "needs_review": false,
  "features": ["macro","roombot","minigame"],
  "feature_labels": ["자동발송 매크로","대화방 관리봇","미니게임봇"],
  "plan": "month", "plan_label": "1개월", "days": 30,
  "target_key": "KAKA-****-****-XXXX",
  "account": "...", "bank": "...", "contact_info": "...",
  "auto_approve": true, "created_at": 0, "status": "pending" }
```
`target_key` 는 **마스킹**해서 돌려준다(뒷자리만 노출). 신규 발급이면 `target_key: null`.

### 3.3 `GET /api/order/:id` — 주문 상태 조회

- `t`(token) 없으면 민감정보를 빼고 상태만: `status`·`amount`·`base_amount`·`features`·`feature_labels`·`plan`·`plan_label`·`days`·`created_at`.
- `t` 가 맞으면 `issued_key` 까지 포함한다.
- 응답 모양은 `POST /api/order` 와 같되 **`android_ok` 는 어떤 경우에도 싣지 않는다.**
- `/order/:id` 페이지는 5초마다 폴링(그리고 창 포커스 시 즉시) → `status==='done'` 이면 키를 크게 + 복사 버튼으로 바꾼다. 최대 30분 폴링 후 [새로고침] 버튼만 남긴다.

### 3.4 `POST /api/lookup` — 키 조회

요청: `{ "key": "KAKA-..." }`. 키 소유 증명 없이 민감정보를 노출하지 않는다.
응답에 포함: `key`, `revoked`, `blocked`, `expires_at`, `features`(3종 상태 맵), `feature_list`, `purchase`(구매 안내 링크).
앱 유물 필드(`device_registered`, `reset_count`)는 **싣지 않는다.** `activated_at` 은 `/panel` 이 쓰면 남긴다.

`features` 맵은 항상 3개 키가 ALL 순서로 존재한다:
```json
"features": { "macro":{"on":true,"expires_at":179...,"plan":"month"},
              "roombot":{"on":true,"expires_at":179...,"plan":"month"},
              "minigame":{"on":true,"expires_at":179...,"plan":"month"} }
```
미보유 = `{on:false, expires_at:0, plan:null}`. 샀지만 미개시 = `{on:false, expires_at:0, plan:'month'}`.

### 3.5 `POST /api/deposit-hook` — 자동 입금확인 (아래 7장)

### 3.6 발송 콘솔 API (`/panel/api/*`, `routes/panel.js`)

`/panel` 은 라이선스 키로 로그인하고(쿠키는 `CONFIG_SECRET` 로 서명), 카카오 계정 등록·매크로/봇 설정·갠톡 1:1 응답을 한다.
로그인/계정등록/방목록/설정/받은함/채팅/로그 엔드포인트가 있다. 설정과 발송의 실제 동작은 `sender/` 가 수행한다.
이 영역의 상세 계약은 `routes/panel.js` 와 `public/panel.*` 가 소유한다 — 이 문서에서 모양을 재정의하지 않는다.

---

## 4. 관리자 API (헤더 `x-admin-password`) — `routes/admin.js`

`/manage` 화면이 이 API 를 부른다. 관리자 응답은 서명하지 않는다(비밀번호로 보호). 요청/응답 모양은 변경 없음.

| 메서드 | 경로 | 본문 / 설명 |
|---|---|---|
| POST | `/admin/create` | `{features,plan,days?,count:1,note?,owner_name?,owner_contact?}` → `{ok,keys:[..]}` (관리자는 `custom` 일수 발급 가능) |
| POST | `/admin/grant` | `{key,features,plan,days?}` 기존 키에 기능 추가/연장. 이미 있으면 **남은 기간에 더함** |
| POST | `/admin/revoke-feature` | `{key,feature}` 해당 기능만 회수 |
| GET | `/admin/list` | `?q=&limit=100&offset=0` → `{ok,now,licenses:[{...,features:[{feature,plan,expires_at}]}]}` |
| GET | `/admin/license?key=` | 단건 상세 + 최근 audit |
| POST | `/admin/revoke` | `{key,revoked:true}` |
| POST | `/admin/block` | `{key,reason}` / `reason:null` 이면 해제 |
| POST | `/admin/delete` | `{key}` |
| GET | `/admin/audit` | `?key=&kind=&limit=100` |
| GET | `/admin/stats` | `{ok, total, active, ...}` + 대기 주문·주의 입금 건수 |
| GET | `/admin/orders` | `?status=pending` |
| POST | `/admin/order-approve` | `{id, key?}` key 없으면 신규 발급 → `{ok, key}` (주문의 features/plan 적용 = 3종 30일) |
| POST | `/admin/order-cancel` | `{id, memo?}` |
| GET | `/admin/deposits` | `?status=&limit=100` 입금 내역 (원문 포함) |
| POST | `/admin/deposit-match` | `{deposit_id, order_id}` 수동 매칭 → 주문 승인까지 수행 |
| POST | `/admin/deposit-ignore` | `{deposit_id}` 무시 처리 |

관리자 비밀번호 무한 추측은 `ADMIN_FAIL_PER_MIN`(기본 10)·`ADMIN_BLOCK_MS`(기본 15분)로 차단한다.

---

## 5. 제거된 것 (앱 단종)

아래는 안드로이드 앱 전용이라 **코드·엔드포인트·문서에서 제거**됐다. 요청이 오면 그냥 없는 경로다.

- **앱 라이선스 API:** `POST /verify`, `POST /heartbeat`, `GET /entitlements`, `POST /config` / `GET /config`, `GET /pubkey`.
  Ed25519 응답 서명, nonce, `config_key`(설정 암호화 키), `recheck_ms`/`grace_ms`(오프라인 유예), `app_sig`/`app_version` 검사가 모두 여기 딸려 있었고 함께 제거됐다.
- **앱 서명 관리자 API:** `GET /admin/sigs`, `POST /admin/sig-add`, `POST /admin/sig-del`, `POST /admin/reset-device`.
- **환경변수:** `SIGNING_PRIVATE_KEY`, `ALLOWED_APP_SIGS`, `APP_SIG_MODE`, `MIN_APP_VERSION`, `RECHECK_MS`, `GRACE_MS`, `EXPIRED_AUDIT_MS`, `RATE_LIMIT_PER_MIN`(앱 API 버킷).
  (`CONFIG_SECRET` 은 제거하지 않고 **`/panel` 로그인 쿠키 서명 키로 용도를 바꿨다.**)
- **1키 1기기·세션 회전·APK 서명 핀닝·변조 탐지**: 앱 보호 수단이라 전부 제거. 지금의 접근 통제는 **라이선스 키 로그인(`/panel`)** 과 **관리자 비밀번호(`/manage`)** 다.
- **안드로이드 소스**(`android/auto`, `android/admin`, 키스토어, `build.sh`)와 **APK 빌드 워크플로**(`.github/workflows/build-apk.yml`), 앱 전용 문서(`docs/ANTI_ABUSE.md`, `docs/SEND_GUARD.md`, `docs/MACRO_V4.md`, `docs/APP_SIGNATURE*`, `docs/field/`).

DB 는 예외다 — 위 2장대로 **테이블·컬럼은 드롭하지 않고** 그냥 쓰지 않는다.

---

## 6. 하위호환

- 예전에 기능별·분기/연 플랜으로 발급된 키와 주문은 그대로 유효하다. `keys.PLANS` 의 `quarter`/`year` 라벨은 그 표시를 위해 남겨 둔다.
- 예전 주문 행의 `android_ok` 컬럼은 기본값으로 남아 있고 신규 주문은 쓰지 않는다.
- 기능 상태 맵은 항상 3종(`macro`·`roombot`·`minigame`)을 ALL 순서로 돌려준다 — 구매 페이지가 그걸 전제로 짜여 있다.

---

## 7. 자동 입금확인 (무인 키 발급)

PG 없이 **개인 계좌 + 판매자 폰 자동화**로 입금을 자동 확인해 키를 즉시 발급한다.
설정 가이드는 `docs/AUTO_DEPOSIT.md`. 금액 매칭이 핵심이다.

### 7.1 주문 금액 고유 뒷자리

주문 생성 시 `amount = base(30000) + suffix(1~99)`. suffix 는 현재 `pending` 주문 중 같은 총액이 없도록 고른다.
전부 충돌하면 `suffix=0` + `needs_review`. → 입금 금액이 곧 주문번호 역할을 하므로 이름을 파싱하지 않아도 주문을 특정한다.
구매 페이지에 **"정확히 30,047원"** 을 크게 띄운다.

### 7.2 `POST /api/deposit-hook`

인증: 헤더 `x-deposit-token` **또는** 쿼리 `?t=`. `DEPOSIT_TOKEN` 과 타이밍 안전 비교. 불일치 → 401.
`DEPOSIT_TOKEN` 미설정 시 엔드포인트 자체를 비활성(503). 토큰 없이 열어두면 누구나 입금을 위조할 수 있다.

요청(여러 키 허용 — 자동화 앱이 보내기 쉬운 쪽으로):
```json
{ "text":"[카카오뱅크] 09/27 14:32 입금 30,047원 홍길동 잔액 1,234,567원", "source":"macrodroid" }
```
`text` 대신 `message`/`body` 로 와도, `Content-Type: text/plain` 본문도 `text` 로 취급.

응답(항상 200 + `ok:true`, 결과는 `status` 로):
```json
{ "ok":true, "status":"matched", "order":"ORD-...", "amount":30047, "key":"KAKA-..." }
{ "ok":true, "status":"unmatched", "amount":30047 }
{ "ok":true, "status":"duplicate" }
{ "ok":true, "status":"ambiguous", "candidates":2 }
{ "ok":true, "status":"ignored", "why":"출금 알림" }
```

처리 순서:
1. `raw_hash = sha256(text)` 중복 확인 → 있으면 `duplicate`.
2. 출금 판정: `출금`·`결제`·`승인취소`·`이체수수료` 포함 + `입금` 미포함 → `ignored`.
3. 금액 후보 추출(`잔액|잔고|한도|누적` 바로 뒤 숫자는 제외).
4. 후보로 `pending` 주문 조회. 정확히 1건 → `matched`, 2건↑ → `ambiguous`, 전부 0건 → `unmatched`.
5. `matched` 면 `/admin/order-approve` 와 동일 로직으로 발급/연장(`target_key` 있으면 그 키의 3종 연장, 없으면 신규 3종 발급). `orders.status='done'`, `issued_key`, `handled_at`, audit(`order`).
6. `deposits` 에 결과 기록.
7. 파싱된 이름이 `orders.depositor` 와 달라도 **거부하지 않고** audit 경고만 남긴다(금액이 고유하므로 금액을 신뢰).

`DEPOSIT_AUTO_APPROVE=0` 이면 `matched` 라도 발급하지 않고 기록만 하며, `/manage` [입금] 에서 수동 매칭한다. 구매 웹 문구도 이에 맞춰 바뀐다.

### 7.3 48시간 미입금 자동취소

`ORDER_PENDING_TTL_MS`(기본 48시간)를 넘긴 `pending` 주문을 **신규 주문 생성 시** `pickAmount` 직전에 자동취소한다.
`auto_canceled=TRUE` + 메모 기록. `/manage` [주문] 에서 **승인하면 복구**된다(수동 취소 주문은 복구 안 됨). 자세한 운영은 `DEPLOY.md` 6-2.

---

## 8. 디자인 · 문구

- 웹 디자인 토큰·화면 명세: `docs/DARK_V1.md`, `docs/UI_V5.md` (콘솔 UI).
- 서비스 이름 표기: `docs/BRAND.md` (**K bot**).
- 사용자 노출 문구 규칙: `docs/TONE.md`.
