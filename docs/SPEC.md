# 카톡 매크로 / 봇 — 전체 설계 명세 (v2.0)

이 문서는 **서버 · 사용자앱(KakaoAuto) · 관리자앱(KakaoAdmin) · 구매 웹사이트**의 계약(contract)이다.
구현 중 이 문서와 코드가 어긋나면 **이 문서가 기준**이다. 새 필드를 추가하면 이 문서도 같이 고친다.

---

> **오발송 차단은 `docs/SEND_GUARD.md` 가 계약이다.** 발송 경로는 하나가 아니고(텍스트 1개 · 사진 3개), 차단 지점도 하나가 아니다. 발송이 늘어나는 기능을 넣기 전에 그 문서의 금지 사항을 먼저 읽어라.

## 0. 인프라

| 구성 | 위치 |
|---|---|
| 라이선스 서버 + 구매 웹 | Render (Node 18+, Express) — `https://kakaotalk-macro.onrender.com` |
| DB | Neon Postgres (`DATABASE_URL`) |
| 사용자앱 | `com.buseong.kakaoauto` (KakaoAuto) |
| 관리자앱 | `com.buseong.kakaoadmin` (KakaoAdmin) |
| 서명 공개키(앱에 박힘) | `MCowBQYDK2VwAyEAcoFrR7SpOov/AURAxp35+uWBSQTE12WKdWYgXwRWrF8=` (Ed25519 SPKI base64) |

환경변수: `DATABASE_URL`, `ADMIN_PASSWORD`, `SIGNING_PRIVATE_KEY`(Ed25519 PKCS8 PEM),
`CONFIG_SECRET`(설정 암호화 키 유도용 HMAC 시크릿 · 없으면 SIGNING_PRIVATE_KEY에서 유도),
`ALLOWED_APP_SIGS`(쉼표구분 SHA-256 hex · 관리자앱에서 넣은 `app_signatures` 행과 합집합),
`APP_SIG_MODE`(`off`/`lenient`(기본)/`strict` — 검사 강도. 허용목록과 **분리**되어 있다.
 `lenient` 는 `app_sig` 를 보냈을 때만 대조하므로 필드를 안 보내는 v1.8 과 공존한다),
`MIN_APP_VERSION`(정수 versionCode · 0이면 미적용), `PURCHASE_BASE`(기본 = 서버 자기 주소).

---

## 1. 기능(Feature) 카탈로그 — **3종 개별 결제**

| id | 한글명 | 설명 |
|---|---|---|
| `macro` | 자동발송 매크로 | 방별 주기 자동발송 · 이미지 첨부 · 메시지추적 · 오픈프로필 자동응답 |
| `roombot` | 방 관리봇 | 입/퇴장 인사, 금지어 감지, 도배 감지, 공지 자동안내 |
| `minigame` | 미니게임봇 | 끝말잇기 · 숫자야구 · 주사위 · 퀴즈 · 랭킹 |

- 기능마다 **독립된 만료일**을 가진다 (entitlement 단위).
- 서버 응답의 `features` 맵이 유일한 진실. 앱은 절대 자체 판단으로 기능을 열지 않는다.
- 꺼진 기능은 앱에서 카드가 잠긴 상태로 보이고, **[구매하기] 버튼 → 웹 구매페이지**로 이동한다.
- 구매 딥링크: `{PURCHASE_BASE}/buy?feature=<id>&key=<라이선스키 또는 생략>`

플랜 코드: `month`(30일) · `quarter`(90일) · `year`(365일) · `custom`(일수 지정).

---

## 2. DB 스키마 (Neon Postgres)

기존 `licenses` 테이블은 **파괴하지 않고** `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`로 확장하고,
기존 행은 `entitlements(feature='macro')`로 백필한다. 마이그레이션은 **몇 번 실행해도 안전(idempotent)**해야 한다.

```sql
licenses (
  key           TEXT PRIMARY KEY,
  plan          TEXT,              -- (구버전 호환) 최근 발급 플랜
  duration_ms   BIGINT,            -- (구버전 호환)
  expires_at    BIGINT,            -- (구버전 호환) = 전체 기능 중 가장 늦은 만료
  device_id     TEXT,              -- 최초 활성화 기기에 고정 (1키 = 1기기)
  device_name   TEXT,
  device_fp     TEXT,              -- 하드웨어 지문 해시 (복제 탐지용)
  activated_at  BIGINT,
  revoked       BOOLEAN DEFAULT FALSE,
  note          TEXT,
  created_at    BIGINT NOT NULL,
  last_seen     BIGINT,
  session_token TEXT,              -- 현재 유효 세션 (재활성화 때마다 회전)
  session_at    BIGINT,
  reset_count   INT DEFAULT 0,     -- 기기 초기화 누적 횟수
  last_reset_at BIGINT,
  app_sig       TEXT,              -- 마지막으로 본 앱 서명 SHA-256
  blocked_reason TEXT,             -- 관리자 차단 사유 (있으면 거부)
  owner_name    TEXT,
  owner_contact TEXT
)

entitlements (
  key         TEXT NOT NULL REFERENCES licenses(key) ON DELETE CASCADE,
  feature     TEXT NOT NULL,        -- macro | roombot | minigame
  plan        TEXT,
  starts_at   BIGINT,               -- 활성화 시점(=최초 verify) 이전엔 NULL
  duration_ms BIGINT NOT NULL,
  expires_at  BIGINT,               -- NULL = 아직 미개시 (활성화 때 계산)
  created_at  BIGINT NOT NULL,
  PRIMARY KEY (key, feature)
)

app_signatures (sha256 TEXT PRIMARY KEY, label TEXT, allowed BOOLEAN DEFAULT TRUE, created_at BIGINT)

audit_log (
  id BIGSERIAL PRIMARY KEY, at BIGINT NOT NULL, key TEXT, kind TEXT, -- activate|mismatch|takeover|bad_sig|expired|revoked|reset|order|tamper
  device_id TEXT, device_name TEXT, detail TEXT, ip TEXT
)

orders (
  id TEXT PRIMARY KEY, created_at BIGINT NOT NULL,
  status TEXT NOT NULL,             -- pending | paid | done | canceled
  features TEXT NOT NULL,           -- 쉼표구분 feature id
  plan TEXT NOT NULL, amount INT NOT NULL,
  buyer_name TEXT, contact TEXT, depositor TEXT, memo TEXT,
  target_key TEXT,                  -- 기존 키에 붙이는 경우
  issued_key TEXT, handled_at BIGINT,
  auto_canceled BOOLEAN DEFAULT FALSE, -- 48시간 미입금으로 서버가 자동 취소함 (승인 시 되살아난다)
  android_ok BOOLEAN DEFAULT FALSE     -- 구매 폼의 "안드로이드 기기 확인" 체크 (환불 분쟁 증거용)
)

configs (key TEXT PRIMARY KEY, blob TEXT, rev BIGINT, updated_at BIGINT)  -- 앱 설정 클라우드 백업(암호문)
```

인덱스: `entitlements(key)`, `audit_log(at DESC)`, `audit_log(key)`, `orders(status, created_at DESC)`.

---

## 3. 사용자앱 ↔ 서버 API

모든 사용자용 응답은 **Ed25519 서명**된다. 서명 대상 = `sig`를 제외한 JSON을 `JSON.stringify(obj)`한 바이트.
**필드 삽입 순서가 서명 대상이므로 서버/앱 양쪽 다 `sig`만 떼고 나머지는 서버가 보낸 순서 그대로 다시 직렬화**해야 한다.
→ 앱은 원문 문자열에서 `,"sig":"..."` 부분만 제거하는 방식으로 검증한다 (v1.8과 동일 방식 유지).

### 3.1 `POST /verify` — 활성화 + 검증
요청:
```json
{ "key":"KAKA-XXXX-XXXX-XXXX", "device_id":"...", "device_name":"Galaxy S23",
  "device_fp":"sha256hex", "app_sig":"sha256hex", "app_version":20,
  "nonce":"랜덤32hex" }
```
응답(성공):
```json
{ "ok":true, "key":"...", "plan":"month", "expires_at":1790000000000,
  "device_id":"...", "features":{ "macro":{"on":true,"expires_at":179...,"plan":"month"},
                                   "roombot":{"on":false,"expires_at":0,"plan":null},
                                   "minigame":{"on":false,"expires_at":0,"plan":null} },
  "session":"랜덤48hex", "config_key":"base64", "recheck_ms":21600000,
  "grace_ms":259200000, "purchase":"https://.../buy",
  "nonce":"...", "ts":1759000000000, "sig":"base64" }
```
응답(실패): `{ "ok":false, "reason":"<코드>", "nonce":..., "ts":..., "sig":... }`

`reason` 코드 → 한국어 안내:
| 코드 | 안내문 |
|---|---|
| `bad_request` | 요청이 잘못됐어 |
| `invalid_key` | 없는 키야 |
| `revoked` | 사용 중지된 키야 |
| `blocked` | 차단된 키야 (관리자 문의) |
| `device_mismatch` | 다른 기기에 등록된 키야 (키 1개당 기기 1대) |
| `no_entitlement` | 구매한 기능이 없어 |
| `expired` | 기간이 끝났어 |
| `bad_app_sig` | 위조된 앱이야 |
| `update_required` | 앱을 최신 버전으로 업데이트해줘 |
| `no_network` | 서버에 연결 못 했어 (앱 내부 코드) |
| `bad_signature` | 서버 응답이 위조됐어 (앱 내부 코드) |
| `session_superseded` | 다른 기기에서 접속됨 — 이 기기는 잠김 |

동작 규칙:
1. `app_sig` 검사 → 허용목록(`app_signatures` + `ALLOWED_APP_SIGS`)에 없으면 `bad_app_sig` + audit 기록. 목록이 완전히 비어있으면 통과(초기 이관 유예).
2. `app_version < MIN_APP_VERSION` → `update_required`.
3. 키 조회 → 없으면 `invalid_key`, `revoked`/`blocked_reason` 처리.
4. `device_id` 가 NULL → **활성화**: device_id/fp/name 기록, 모든 미개시 entitlement의 `starts_at=now`, `expires_at=now+duration_ms`.
5. `device_id` 불일치 → `device_mismatch` + audit(`mismatch`) 기록. (기기 교체는 관리자 초기화만)
6. `device_fp` 가 저장된 값과 다르면 audit(`takeover`) 기록하되 통과 (하드웨어 지문은 OS 업데이트로 바뀔 수 있음).
7. 유효한 기능이 하나도 없으면(`all expired`) → `expired`, entitlement 자체가 0건이면 `no_entitlement`.
8. `session` 새로 발급 + 저장(기존 세션 무효화), `last_seen` 갱신.
9. `config_key` = base64( HMAC-SHA256(CONFIG_SECRET, key + "|" + device_id) ).
   **세션을 증명한 경로에만 포함**한다: `/verify` 성공 응답, 그리고 요청 `session` 이 서버 값과 일치하는
   `/heartbeat`. `/entitlements` 는 세션 증명이 없으므로 `config_key: null`, `session` 도 요청값이
   서버 값과 같을 때만 echo 하고 아니면 `null` 이다 (밀려난 기기가 유효 세션을 얻지 못하게).
   필드 자체는 `null` 로 남겨 응답 키 순서(하위호환 계약)를 깨지 않는다.

### 3.2 `POST /heartbeat` — 세션 유지 / 탈취 감지 / 만료 감지
요청: `{ "key":..., "device_id":..., "session":..., "nonce":... }`
성공: `{ "ok":true, "features":{...}, "expires_at":..., "session":"(같은 값 또는 회전값)", "nonce":..., "ts":..., "sig":... }`
실패: `reason` = `session_superseded` | `device_mismatch` | `expired` | `revoked` | `invalid_key` | `blocked`
- 서버 저장 세션 ≠ 요청 세션 → `session_superseded`.
- 앱은 기본 6시간마다(그리고 앱 진입 시) 호출. `session_superseded` 면 즉시 기능 전체 잠금.

### 3.3 `GET /entitlements?key=&device_id=&nonce=` — 기능 상태만 (서명됨)
구매 직후 앱에서 "새로고침" 누를 때 쓴다. 응답은 `/heartbeat` 성공 응답과 동일 형태.

### 3.4 설정 클라우드 백업 (선택)
- `POST /config` `{key, device_id, session, blob}` → `{ok:true, rev}` (blob = 앱이 암호화한 문자열, 최대 256KB)
- `GET /config?key=&device_id=&session=` → `{ok:true, blob, rev, updated_at}`
- 서버는 blob 내용을 해독할 수 없다(키가 없음). 기기 교체/재설치 복구용.

### 3.5 `GET /pubkey` → `{ ok:true, pubkey:"base64" }` (진단용)

---

## 4. 관리자 API (헤더 `x-admin-password`)

| 메서드 | 경로 | 본문 / 설명 |
|---|---|---|
| POST | `/admin/create` | `{features:["macro"],plan:"month",days?,count:1,note?,owner_name?,owner_contact?}` → `{ok,keys:[..]}` |
| POST | `/admin/grant` | `{key,features:[..],plan,days?}` 기존 키에 기능 추가/연장. 이미 있으면 **남은 기간에 더함** |
| POST | `/admin/revoke-feature` | `{key,feature}` 해당 기능만 회수 |
| GET | `/admin/list` | `?q=&limit=100&offset=0` → `{ok,now,licenses:[{...,features:[{feature,plan,expires_at}]}]}` |
| GET | `/admin/license?key=` | 단건 상세 + 최근 audit 20건 |
| POST | `/admin/revoke` | `{key,revoked:true}` |
| POST | `/admin/block` | `{key,reason}` / `reason:null` 이면 해제 |
| POST | `/admin/reset-device` | `{key}` 기기 고정 해제 (`reset_count++`, 세션 무효화, audit) |
| POST | `/admin/delete` | `{key}` |
| GET | `/admin/audit` | `?key=&kind=&limit=100` |
| GET | `/admin/orders` | `?status=pending` |
| POST | `/admin/order-approve` | `{id, key?}` key 없으면 신규 발급 → `{ok, key}` (주문의 features/plan 적용) |
| POST | `/admin/order-cancel` | `{id, memo?}` |
| GET | `/admin/sigs` / POST `/admin/sig-add` `{sha256,label}` / POST `/admin/sig-del` `{sha256}` | 앱 서명 허용목록 |
| GET | `/admin/stats` | `{ok, total, active, expiring_7d, by_feature:{macro:n,...}, pending_orders:n}` |

관리자 응답은 서명하지 않는다(비밀번호로 보호).

---

## 5. 구매 웹사이트 (`public/`, Express static + 라우트)

| 경로 | 내용 |
|---|---|
| `/` | 랜딩. 3개 상품 카드(가격/기능/추천), FAQ, 다운로드 안내 |
| `/buy?feature=&key=` | 구매 신청 폼: 기능 다중선택, 플랜 선택, 실시간 금액계산, 입금자명/연락처, 기존 키 입력(연장) |
| `POST /api/order` | 주문 접수 → `{ok, id, amount, account}` (무통장 계좌 안내) |
| `/order/:id` | 주문 상태 조회 페이지 |
| `/my` | 키 조회: 키 입력 → 기능별 남은 기간 표시 (`POST /api/lookup` — 키 소유 증명 없이 민감정보 노출 금지: 기능/만료일/기기등록여부만) |
| `GET /api/price` | 가격표 JSON (서버 단일 소스) |

가격표 (서버 `lib/pricing.js` 단일 소스, 원):
```
macro:    month 15000 / quarter 39000 / year 129000
roombot:  month 12000 / quarter 31000 / year 105000
minigame: month 12000 / quarter 31000 / year 105000
3종 묶음 할인: 총액의 15% 할인 (features 3개 동시 구매 시)
```
계좌 안내는 환경변수 `BANK_INFO`(예: `카카오뱅크 3333-00-0000000 김부성`). 없으면 "관리자에게 문의" 표시.

웹 디자인 톤: **앱과 동일** — 딥 네이비/차콜 배경, 민트-블루 액센트, 큰 라운드(18~22px), 얇은 흰색 8% 보더,
과한 그라디언트 금지, 여백 넉넉, 모바일 1열. 외부 CSS 프레임워크 금지(단일 `style.css`), 시스템 폰트 스택.

---

## 6. 무단사용(키 없이 APK 사용) 방지 — 다층 방어

> 클라이언트 검사는 결국 패치될 수 있다. 그래서 **서버 없이는 앱이 쓸모없게** 만드는 게 핵심이다.

1. **설정 암호화 (핵심)** — 방 목록 · 발송 메시지 · 트리거 · 자동응답문 등 *실제로 앱을 쓸모있게 만드는 모든 설정*은
   `config_key`(서버가 성공 응답에만 실어주는 값)로 유도한 AES-256-GCM 키로 암호화해 저장한다.
   라이선스 검증을 통과한 적 없는 기기/크랙앱은 **자기 설정을 복호화할 수 없다 → 보낼 메시지가 없다.**
   - 키 유도: `HKDF-SHA256(ikm = base64decode(config_key), salt = device_id UTF-8, info = "kakaoauto-cfg-v1", 32바이트)`
   - 저장형식: `v1:<base64(iv 12바이트)>:<base64(ciphertext||tag)>`
   - `config_key`는 **평문 저장 금지**. 앱 실행 중 메모리에만 두고, 오프라인 유예기간을 위해
     `AndroidKeyStore`(alias `kakaoauto_cfg`, AES/GCM, `setUserAuthenticationRequired(false)`)로 감싸서 저장한다.
     KeyStore 사용 불가 기기는 기기고정 키(fingerprint 유도)로 폴백 — 폴백 사실을 로그에 남긴다.
2. **서명 핀닝** — 앱은 자기 APK 서명 SHA-256을 계산해 매 요청에 실어 보내고, 서버가 허용목록과 대조한다.
   리패키징(재서명)한 APK는 서명이 달라져 `bad_app_sig`로 거부된다.
3. **변조/디버그 탐지** — `ApplicationInfo.FLAG_DEBUGGABLE`, `Debug.isDebuggerConnected()`,
   설치 출처(`getInstallerPackageName`) 이상, 에뮬레이터 지표, `PackageManager`상 `sourceDir`이 여러 개(스플릿 위장)인 경우를
   `tamper` 플래그로 모아 서버에 `detail`로 보고(audit)하고, 심한 경우 앱이 스스로 잠긴다.
4. **1키 1기기 + 세션 회전** — 아래 7장.
5. **온라인 필수 + 유예** — 최초 활성화는 반드시 온라인. 이후 `recheck_ms`(기본 6시간)마다 heartbeat,
   연속 실패가 `grace_ms`(기본 3일)를 넘으면 기능 전체 잠금. 시계 되돌리기 방어: 저장된 `last_ok`보다
   현재 시각이 **과거**면 즉시 재검증 요구.
6. **기능 게이트는 단일 지점** — 모든 발송/봇 실행 경로는 `License.allowed(feature)` 한 곳만 통과한다.
   (곳곳에 중복 검사를 흩뿌리지 않는다. 우회 지점을 늘릴 뿐이다.)

### 현실적 한계 — 문서에 반드시 명시
서명 핀닝·변조 탐지는 **돈 안 들이고 할 수 있는 최선**이지 완벽한 방어가 아니다.
결정적인 방어는 1번(설정 암호화)과 5번(온라인 필수)이다. 더 강하게 막으려면 Play Integrity API가 필요하고,
그건 Google Play 배포가 전제다. 이 내용을 `docs/ANTI_ABUSE.md`에 그대로 적는다.

---

## 7. 1키 1기기 규칙

- 최초 `/verify` 성공 시 `device_id` 고정. 이후 다른 `device_id`는 **무조건 거부**(`device_mismatch`).
- `device_id` = `Settings.Secure.ANDROID_ID`. 초기화·롬 변경으로 바뀔 수 있으니, 사용자 안내는
  "기기를 바꾸거나 초기화했으면 관리자에게 초기화 요청" 으로 한다. 앱 잠금화면에 **초기화 요청 버튼**(웹 `/my`로 이동)을 둔다.
- `device_fp` = `sha256(MANUFACTURER|MODEL|DEVICE|BOARD|SDK_INT|ABI)` — 같은 android_id로 다른 하드웨어가 붙으면 audit `takeover`.
- **동시 사용 차단**: 세션 토큰이 `/verify` 마다 회전. 구 세션의 heartbeat는 `session_superseded`로 잠긴다.
  → android_id를 복제해도 두 기기가 동시에 정상 동작하지 못한다.
- 관리자 초기화 시 `reset_count++`. 관리자앱 목록에 초기화 횟수를 표시해 남용을 눈으로 잡는다.

---

## 8. 사용자앱 구조 (`android/auto/java/com/buseong/kakaoauto/`)

### 8.1 디자인 시스템 — `Theme.java` / `Ui.java` (모든 화면이 **반드시** 이것만 사용)

`Theme` (static final int 색상 · ARGB):
```
BG=0xFF0B0F14  BG2=0xFF111823  CARD=0xFF151D29  CARD2=0xFF1B2533
LINE=0x14FFFFFF  LINE2=0x22FFFFFF
TEXT=0xFFEAF0F7  SUB=0xFF93A2B5  DIM=0xFF5E6E82
ACCENT=0xFF3DDC97  ACCENT2=0xFF2BB4F0  AMBER=0xFFFFC65C  RED=0xFFFF6B6B  VIOLET=0xFFA78BFA
ON_ACCENT=0xFF07130D
R_SM=10 R_MD=14 R_LG=20 R_XL=26   (dp, 라운드 반경)
```
메서드: `static int dp(Context,float)`, `static int sp(...)`, `static GradientDrawable round(int fill,int radiusDp,int strokeColor,int strokeDp,Context)`,
`static GradientDrawable pill(int fill,int stroke,Context)`.

`Ui` (모두 static, 첫 인자 Context 또는 ViewGroup):
```
TextView  title(Context,String)                 // 22sp bold
TextView  h2(Context,String)                    // 16sp bold
TextView  label(Context,String)                 // 12sp SUB, letterSpacing .06
TextView  body(Context,String)                  // 14sp TEXT
TextView  sub(Context,String)                   // 13sp SUB
LinearLayout card(Context)                      // CARD 배경 + R_LG + LINE 보더 + 패딩16
LinearLayout row(Context)                       // horizontal, center vertical
View      spacer(Context,int dp)
View      divider(Context)
TextView  chip(Context,String text,int color)   // pill, color 12% 배경 + color 글자
TextView  btn(Context,String,boolean primary)   // primary=ACCENT 채움/ON_ACCENT 글자, 아니면 투명+LINE2 보더
EditText  field(Context,String hint)            // CARD2 배경 + R_MD + 보더
LinearLayout switchRow(Context,String title,String desc,boolean on,OnToggle cb)  // 커스텀 토글(우측 pill)
LinearLayout featureCard(Context,String name,String desc,State st,long expiresAt,Runnable onBuy,Runnable onOpen)
LinearLayout sectionHeader(Context,String label,String title)
void      toast(Context,String)
AlertDialog.Builder dialog(Context,String title)   // 다크 테마 적용된 빌더
```
`interface OnToggle { void on(boolean v); }`
`enum State { ON, OFF, EXPIRING }` — featureCard는 ON이면 오른쪽에 초록 `사용중 · D-12` 칩,
OFF면 `[구매하기]` 버튼(ACCENT), EXPIRING이면 AMBER `만료 임박 · D-3` 칩 + `[연장]`.

**UI 원칙**: 한 화면에 카드 4~6개 이하. 설정은 카드 안에서 접기(펼치기). 숫자 입력은 다이얼로그로 분리해
메인 화면은 "현재 값 + 수정" 형태만 보여준다. 애니메이션·그림자 남용 금지. 이모지는 아이콘 대용으로만 절제해서.
탭바는 화면 하단 고정, 4탭: **홈 · 매크로 · 봇 · 내정보**. (봇 탭 안에서 방관리/미니게임 선택)

### 8.2 클래스 책임

| 파일 | 책임 |
|---|---|
| `Theme.java` `Ui.java` | 디자인 시스템 (위) |
| `Device.java` | `deviceId(ctx)`, `deviceName()`, `fingerprint(ctx)`, `appSigSha256(ctx)`, `appVersion(ctx)`, `tamperFlags(ctx)`(콤마문자열, 정상이면 "") |
| `Crypto.java` | `String seal(byte[] key,String plain)`, `String open(byte[] key,String blob)`, `byte[] hkdf(byte[] ikm,byte[] salt,String info,int len)`, `byte[] sha256(byte[])`, `String hex(byte[])`, `String randomHex(int bytes)` |
| `Keystore.java` | `void putConfigKey(ctx,String b64)`, `String getConfigKey(ctx)` — AndroidKeyStore 래핑 + 폴백 |
| `Prefs.java` | 일반값: `getStr/putStr/getInt/putInt/getBool/putBool/getLong/putLong`. **민감값**: `secGet(ctx,name)`/`secPut(ctx,name,value)` (Crypto+configKey 자동 적용, 키 없으면 null/무시) |
| `Features.java` | `String[] ALL={"macro","roombot","minigame"}`, `String label(id)`, `String desc(id)`, `String buyUrl(ctx,id)` |
| `License.java` | 상태머신 + 네트워크. 아래 8.3 |
| `Settings.java` | 모든 사용자 설정의 타입 있는 모델 + `toJson()/fromJson()` + `load(ctx)/save(ctx)` (민감설정은 Prefs.secPut 경유). 매크로/봇/트리거/자동응답 설정 전부 이 안에 |
| `Log.java` | `void add(ctx,String)`, `String dump(ctx)`, `void clear(ctx)` — 최근 200줄 링버퍼, `MM/dd HH:mm:ss` 접두 |
| `MainActivity.java` | 앱 셸: 하단 탭 + 라이선스 게이트 + 홈(대시보드) |
| `ScreenMacro.java` | 매크로 화면 (방·메시지·주기·이미지·트리거·자동응답 진입) |
| `ScreenBot.java` | 방관리봇 / 미니게임봇 설정 화면 (하위 세그먼트) |
| `ScreenAccount.java` | 라이선스·기기·구매·로그·권한 |
| `Gate.java` | `static boolean check(Activity,String feature)` — 꺼져있으면 구매 유도 다이얼로그 띄우고 false |
| `KakaoListener.java` | NotificationListenerService — 알림 파싱, 세션 추적, RemoteInput 발송, 트리거/자동응답/봇 디스패치 |
| `Trigger.java` | 트리거 규칙 모델 + `match(String msg)` + 쿨다운 |
| `AutoReply.java` | 오픈프로필 1:1 자동응답 판단 + 쿨다운 |
| `RoomBot.java` | 방 관리봇 엔진 |
| `MiniGame.java` | 미니게임 엔진 (상태는 방별) |
| `ImageSender.java` | 이미지 1~5장 전송 오케스트레이션 |
| `ImagePicker.java` | 사진 선택(최대 5장) · URI 영속 권한 · 썸네일 |
| `KakaoAccessibility.java` | AccessibilityService — 카톡 공유 UI 자동 조작 |
| `Scheduler.java` `AlarmReceiver.java` | AlarmManager 주기 발송 |
| `App.java` | 크래시 핸들러 + 전역 초기화 |

### 8.3 `License.java` 계약
```java
public final class License {
  public static final class Feat { public boolean on; public long expiresAt; public String plan; }
  public static final class State {
    public boolean licensed;        // 키 인증 통과 + 유예 안 넘김
    public String  reason;          // 실패 코드 (licensed=false 일 때)
    public String  key, deviceId;
    public long    expiresAt, lastOk, recheckMs, graceMs;
    public java.util.Map<String,Feat> features;  // 항상 3개 키 존재
    public boolean locked;          // session_superseded 등 강제 잠금
  }
  public static State state(Context c);                 // 캐시에서 즉시
  public static boolean allowed(Context c,String feature); // ★ 유일한 기능 게이트
  public static long daysLeft(Context c,String feature);
  public static void  activate(Context c,String key,Cb cb);   // 백그라운드 스레드에서 /verify
  public static void  heartbeat(Context c,Cb cb);             // /heartbeat, 필요 시 자동 잠금
  public static void  refresh(Context c,Cb cb);               // /entitlements (구매 직후)
  public static void  signOut(Context c);                     // 로컬 키·설정키 삭제
  public static String reasonKr(String reason);
  public interface Cb { void done(boolean ok,String reason); }
}
```
- 모든 네트워크는 `Thread` + `Handler(Looper.getMainLooper())` 콜백. (라이브러리 추가 금지)
- 응답 검증: nonce 일치 → Ed25519 서명 검증 → `ts` 가 현재 시각 ±10분 → 실패 시 `bad_signature`.
- 성공 시 `config_key`를 `Keystore.putConfigKey`, 나머지 상태를 평문 Prefs(무해한 값)에 캐시.

### 8.4 새 매크로 기능 3종

#### (A) 이미지 첨부 최대 5장
- `ImagePicker`: `ACTION_OPEN_DOCUMENT` + `EXTRA_ALLOW_MULTIPLE`, 최대 5장(초과 시 앞 5장만 + 토스트),
  `takePersistableUriPermission` 으로 URI 영속화, 선택된 목록은 Settings에 문자열 URI 배열로 저장.
- **알림 RemoteInput으로는 이미지를 못 보낸다.** 그래서 전송은 다음 2단 전략:
  1. **공유 인텐트 + 접근성(기본)**: `ACTION_SEND_MULTIPLE` (`image/*`, 최대 5 URI,
     `setPackage("com.kakao.talk")`, `FLAG_GRANT_READ_URI_PERMISSION`) 로 카톡 공유 화면을 띄우고,
     `KakaoAccessibility` 가 **대상 방 이름 텍스트를 찾아 탭 → 확인/전송 버튼 탭** 한다.
  2. **직접 조작(폴백)**: 알림의 `contentIntent`로 방을 열고 `+` → `앨범` → 이미지 탭 → `전송`.
- 접근성 노드 탐색은 하드코딩 금지 — `text` / `contentDescription` / `viewIdResourceName` 후보 목록을
  `Selectors.java`(또는 `KakaoAccessibility` 내부 static 배열)로 모아두고, 한국어 라벨 후보를 여러 개 시도한다.
  (예: 전송 버튼 후보 = {"전송","보내기","확인","Send","확인 (1)"} 접두 매칭)
- 이미지 전송은 **텍스트 발송과 별도 옵션**: `매 발송마다` / `N번째 발송마다` / `수동 전송만`.
- 접근성 서비스가 꺼져 있으면 이미지 옵션 카드에 "접근성 권한 필요" 안내 + 설정 이동 버튼. 텍스트 발송은 영향 없음.

#### (B) 오픈프로필 개인톡 자동응답
- 설정: 사용 on/off, **응답 메시지(사용자 직접 입력, 여러 줄 허용)**, 적용 대상
  (`모든 1:1` / `모르는 사람만(내 목록에 없는 방)` / `특정 방 제외`), 같은 사람 재응답 쿨다운(기본 6시간),
  1일 최대 응답 수(기본 100), 운영시간(예 09:00~23:00, 미설정 시 24시간),
  `첫 메시지에만` 토글, 랜덤 지연(0~30초, 봇처럼 안 보이게).
- 판단: 알림 `android.isGroupConversation == false` (없으면 `android.messages` 발신자 수 1명 && 방이름==발신자명 휴리스틱)
  && 내가 보낸 메시지 아님 && 쿨다운 통과 && 운영시간 내 → RemoteInput 으로 응답.
- 치환 토큰: `{이름}`(발신자), `{시간}`(HH:mm), `{날짜}`. 여러 줄은 그대로 전송.
- 응답 이력(sender→lastAt, 일일 카운트)은 민감정보 아니므로 평문 Prefs, 자정 리셋.

#### (C) 메시지 추적 (키워드 트리거)
- 트리거 목록(최대 30개). 각 트리거:
```
name          표시용 이름
pattern       감지 문자열
mode          contains | exact | startsWith | regex
ignoreCase    기본 true
rooms         빈 값 = 모든 방 / 지정 시 해당 방에서만
fromMe        기본 false (내 메시지는 무시)
reply         보낼 메시지 ({방},{이름},{메시지},{시간} 치환)
target        빈 값 = 감지된 방 / 지정 시 그 방으로 보냄
delayMs       0~60000 랜덤 지연 상한
cooldownMs    기본 60000 (같은 트리거 재발동 최소 간격)
oncePerRoom   기본 false
enabled
```
- 감지 즉시(알림 도착 시점) 발송 — 주기 발송 스케줄과 무관하게 동작.
- `target`이 감지된 방과 다르면, 해당 방의 활성 RemoteInput 세션이 필요하다
  (카톡 알림이 최근에 온 방만 가능) → 불가하면 로그에 "대상 방 세션 없음" 남기고 스킵.
- 찾는 방식은 손님 화면에서 **포함 · 정확히 · 시작** 세 가지만 제시한다. 정규식은 엔진에는
  남아 있지만(기존 규칙 호환) 새 규칙에는 선택지로 내려오지 않는다 — 손님이 쓸 수 없는
  문법이고 틀리면 그 규칙이 조용히 멈춘다. 이미 정규식인 규칙을 열었을 때만 선택지에 보인다.
- 패턴 오류는 저장 시점에 검사해 사용자에게 알린다.

### 8.5 방 관리봇 (`roombot`) — 기능
입장/퇴장 인사(템플릿), 금지어 감지 시 경고 메시지(+횟수 누적), 도배 감지(N초 안에 M개 초과 → 경고),
링크/초대 차단 경고, 공지 명령(`!공지`), `!규칙`, 자동 환영 DM 금지(카톡 제약) — 전부 **메시지 발송으로만** 동작.
카톡은 외부 앱이 강제퇴장을 못 하므로 **"강퇴 대신 경고+관리자 호출"** 로 구현하고 그 한계를 UI에 적는다.

### 8.6 미니게임봇 (`minigame`) — 기능
`!끝말잇기` (단어 사전 내장 최소 300단어, 중복/두음법칙 처리), `!숫자야구` (3자리), `!주사위`, `!가위바위보`,
`!퀴즈` (내장 문제 50개), `!랭킹`(방별 점수), `!도움`. 방별 게임 상태는 메모리 + Prefs 백업.
명령어 앞글자는 설정 가능(기본 `!`). 봇 응답 쿨타임은 설정 가능하며 **하한 3초**다
(0 이면 간격 제한이 통째로 무효가 된다). 하루 최대 발송은 안전장치로 코드에 남기되
손님 화면에서는 내렸다 — 매크로·자동응답에서 일일 제한을 걷어낸 v4 와 같은 기준이다.

---

## 9. 관리자앱 (`android/admin/java/com/buseong/kakaoadmin/`)
`Theme.java`/`Ui.java`는 사용자앱과 **동일한 디자인 토큰**(패키지만 다름).
탭: **키 · 주문 · 기록 · 설정**
- 키: 검색, 목록(키 · 소유자 · 기능칩3개 각각 남은일수 · 기기 · 초기화횟수 · 상태),
  새 키 발급(기능 다중선택 + 플랜 + 수량 + 메모), 상세 시트(연장/기능추가/기기초기화/차단/회수/삭제/복사)
- 주문: 대기 주문 목록 → 승인(키 신규발급 또는 기존키 연장) / 취소. 승인 결과 키 복사 버튼
- 기록: audit_log 필터(종류·키) — `mismatch`/`takeover`/`bad_sig`/`tamper` 를 눈에 띄는 색으로
- 설정: 서버주소/비번 저장, 앱서명 허용목록 관리, 통계(총/활성/7일내만료/기능별)

---

## 10. 빌드

Gradle/AndroidX 없이 **aapt2 + javac + d8 + zipalign + apksigner** 직접 사용 (현재 APK와 동일 구조 유지).
```
android/
  build.sh                 # ./build.sh [auto|admin|all]  → out/*.apk
  keystore/app.jks         # 고정 서명키 (없으면 build.sh가 생성) — 비번은 build.sh 상단 변수
  auto/AndroidManifest.xml
  auto/res/...
  auto/java/com/buseong/kakaoauto/*.java
  admin/AndroidManifest.xml
  admin/res/...
  admin/java/com/buseong/kakaoadmin/*.java
```
- `compileSdk/targetSdk = 34`, `minSdk = 26`, `versionCode`/`versionName`은 manifest에 직접.
- **자바 라이브러리 의존성 0개.** `org.json`은 안드로이드 내장이라 그대로 사용.
- `-source 17 -target 17`, `bootclasspath = $ANDROID_HOME/platforms/android-34/android.jar`.
- GitHub Actions `.github/workflows/build-apk.yml` 에서 같은 `build.sh`를 돌려 APK를 artifact로 올린다.

### AndroidManifest 필수 항목 (auto)
권한: `INTERNET`, `RECEIVE_BOOT_COMPLETED`, `SCHEDULE_EXACT_ALARM`, `USE_EXACT_ALARM`,
`REQUEST_IGNORE_BATTERY_OPTIMIZATIONS`, `POST_NOTIFICATIONS`, `READ_MEDIA_IMAGES`, `FOREGROUND_SERVICE`,
`QUERY_ALL_PACKAGES` 대신 `<queries><package android:name="com.kakao.talk"/></queries>`.
서비스: `KakaoListener`(`BIND_NOTIFICATION_LISTENER_SERVICE` + `NOTIFICATION_LISTENER_SETTINGS`),
`KakaoAccessibility`(`BIND_ACCESSIBILITY_SERVICE` + `<meta-data android:resource="@xml/accessibility"/>`).
리시버: `AlarmReceiver`(exported=false), 부팅 리시버.

---

## 11. 하위호환
- v1.8 앱이 새 서버에 붙어도 `/verify` 응답의 기존 필드(`ok,key,plan,expires_at,device_id,nonce,ts,sig`)가
  **같은 자리·같은 순서로 먼저** 오도록 JSON을 구성한다. (신규 필드는 뒤에 붙인다. v1.8은 원문에서 sig만 떼고 검증하므로 문제없음)
- 기존 키는 자동으로 `macro` 기능 보유로 백필된다.
- `MIN_APP_VERSION` 기본 0 → 강제 업데이트 끔. 새 APK 배포 뒤 값을 올려 구버전을 차단한다.

---

## 12. 자동 입금확인 (무인 키 발급) — 추가 명세

PG 없이 **개인 계좌 + 폰 자동화**로 입금을 자동 확인해 키를 즉시 발급한다.
폰의 자동화 앱이 은행 입금 알림/문자를 잡아서 서버로 POST 하고, 서버가 주문과 대조해 자동 승인한다.

### 12.1 주문 금액에 고유 뒷자리 부여 (매칭의 핵심)

주문 생성 시 `amount = base + suffix` (suffix 1~99원). suffix 는 **현재 `pending` 주문 중
같은 총액이 없도록** 고른다(1..99 를 섞어서 순회, 전부 충돌하면 suffix=0 + `needs_review` 표시).

→ 입금 금액이 곧 주문번호 역할을 하므로, 은행 알림 문자에서 **이름을 파싱하지 않아도** 주문을 특정할 수 있다.
이름은 보조 확인용으로만 쓴다(은행마다 형식이 다르고 동명이인이 있다).

구매 페이지에 **"정확히 39,047원"** 을 크게 띄우고 `뒷자리 47원은 주문 확인용이야. 금액이 다르면 자동 확인이 안 돼.` 를 붙인다.

`orders` 테이블에 컬럼 추가:
```sql
base_amount   INT           -- 할인 적용된 원래 금액
amount        INT           -- 실제 입금해야 하는 금액 (= base_amount + suffix)
token         TEXT          -- 구매자가 주문/키를 조회할 때 쓰는 비밀값 (24 hex)
needs_review  BOOLEAN DEFAULT FALSE
```
`orders.id` 형식: `ORD-YYMMDD-XXXXXX` (X = 대문자+숫자 6자).

### 12.2 `deposits` 테이블
```sql
deposits (
  id BIGSERIAL PRIMARY KEY,
  at BIGINT NOT NULL,
  amount INT,                  -- 파싱된 입금액 (매칭에 쓴 값)
  name TEXT,                   -- 파싱된 입금자명 (없을 수 있음)
  raw TEXT NOT NULL,           -- 알림 원문 (관리자가 눈으로 확인)
  source TEXT,                 -- macrodroid | shortcuts | manual | 기타
  raw_hash TEXT NOT NULL,      -- sha256(raw) — 중복 전송 방어
  matched_order TEXT,          -- 매칭된 주문 id (없으면 NULL)
  status TEXT NOT NULL         -- matched | unmatched | duplicate | ambiguous | ignored
)
CREATE UNIQUE INDEX IF NOT EXISTS deposits_dedupe ON deposits(raw_hash);
```

### 12.3 `POST /api/deposit-hook`

인증: 헤더 `x-deposit-token` **또는** 쿼리 `?t=` (자동화 앱이 헤더를 못 넣는 경우 대비).
`DEPOSIT_TOKEN` 환경변수와 **타이밍 안전 비교**(`crypto.timingSafeEqual`). 불일치 → 401 + audit(`bad_deposit_token`).
`DEPOSIT_TOKEN` 이 설정되지 않으면 엔드포인트 자체를 **비활성**(503 + "DEPOSIT_TOKEN 미설정") — 토큰 없이 열어두면 누구나 입금을 위조할 수 있다.

요청 (둘 중 아무 형식이나 받는다 — 자동화 앱이 보내기 쉬운 쪽으로):
```json
{ "text":"[카카오뱅크] 09/27 14:32 입금 39,047원 홍길동 잔액 1,234,567원",
  "source":"macrodroid", "at":1759000000000 }
```
`text` 대신 `message` / `body` 키로 와도 받아준다. `Content-Type: text/plain` 본문도 그대로 `text` 로 취급.

응답:
```json
{ "ok":true, "status":"matched", "order":"ORD-260927-A3K9QZ", "amount":39047, "key":"KAKA-..." }
{ "ok":true, "status":"unmatched", "amount":39047 }     // 금액에 맞는 대기 주문 없음 — 기록만
{ "ok":true, "status":"duplicate" }                      // 같은 원문 재전송
{ "ok":true, "status":"ambiguous", "candidates":2 }      // 같은 금액 대기 주문이 2개 이상 → 관리자 확인 필요
{ "ok":true, "status":"ignored", "why":"출금 알림" }
```
**항상 200 + ok:true 로 응답**한다(자동화 앱이 실패로 보고 재시도를 반복하면 중복이 쌓인다).
실제 처리 결과는 `status` 로 알린다.

처리 순서:
1. `raw_hash = sha256(text)` 로 중복 확인 → 있으면 `duplicate`.
2. 출금 판정: `출금`·`결제`·`승인취소`·`이체수수료` 를 포함하고 `입금` 을 포함하지 않으면 `ignored`.
3. 금액 후보 추출: `/(\d{1,3}(?:,\d{3})+|\d{3,})/g` 로 전부 뽑고, 바로 앞에 `잔액|잔고|한도|누적` 이 붙은 건 제외.
4. 후보 각각으로 `SELECT * FROM orders WHERE status='pending' AND amount=$1` 조회.
   정확히 1건 → `matched`. 2건 이상 → `ambiguous`. 0건 → 다음 후보. 전부 0건 → `unmatched`.
5. `matched` 면 **`/admin/order-approve` 와 동일한 로직**을 호출해 키 발급/연장
   (`target_key` 가 있으면 그 키에 기능 추가·연장, 없으면 신규 발급).
   `orders.status='done'`, `issued_key`, `handled_at` 기록. audit(`order`, detail=`자동입금 승인 <입금자명>`).
6. `deposits` 에 결과 기록.
7. 이름 검증: 파싱된 이름이 있고 `orders.depositor` 와 다르면 **거부하지 않고** audit 에 경고로 남긴다
   (은행 표기가 다를 수 있다. 금액이 고유하므로 금액을 신뢰한다).

### 12.4 구매자에게 키 전달 (무인)

- 주문 생성 응답에 `{id, token, amount, ...}` 를 준다. 구매 페이지는 `/order/<id>?t=<token>` 으로 이동하고
  그 링크를 `localStorage` 에 저장한다("내 주문" 목록).
- `GET /api/order/:id` — `t` 없으면 `{status, amount, features, plan, created_at}` 만.
  `t` 가 맞으면 `issued_key` 까지 포함.
- `/order/:id` 페이지는 **5초마다 폴링**(그리고 창 포커스 시 즉시) → `status==='done'` 이면
  키를 크게 + 복사 버튼 + "앱에 이 키를 입력해" 안내로 바꾼다. 최대 30분 폴링 후 중단하고 [새로고침] 버튼만 남긴다.

### 12.5 관리자 API 추가
| 메서드 | 경로 | 설명 |
|---|---|---|
| GET | `/admin/deposits` | `?status=&limit=100` 입금 내역 (원문 포함) |
| POST | `/admin/deposit-match` | `{deposit_id, order_id}` 수동 매칭 → 주문 승인까지 수행 |
| POST | `/admin/deposit-ignore` | `{deposit_id}` 무시 처리 |

관리자앱 **[주문] 탭에 [입금] 세그먼트 추가**: 미매칭/모호 건을 위에, 원문을 접어서 보여주고 [수동 매칭](대기 주문 선택) / [무시].

### 12.6 환경변수 추가
| 변수 | 설명 |
|---|---|
| `DEPOSIT_TOKEN` | 입금 웹훅 인증 토큰(랜덤 32자 이상). **미설정 시 웹훅 비활성** |
| `DEPOSIT_AUTO_APPROVE` | `1`(기본) 이면 금액 일치 시 자동 승인, `0` 이면 기록만 하고 관리자 승인 대기 |
