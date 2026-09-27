# 리뷰 결함 목록 (자동 리뷰 + 적대적 검증)
총 49건, critical/high 14건 (검증 통과 12건)

## critical / high

### 1. [critical][security] GET /entitlements 가 세션·앱서명 검사 없이 유효 session 토큰과 config_key 를 그대로 내준다
- 파일: `/home/user/kakaotalk-macro/routes/license.js`:303
- 내용: `/entitlements` 핸들러는 `gate(req, v, { needSession: false })` (294행) 로 세션 증명을 아예 요구하지 않고, `sigOk(app_sig)` 도 호출하지 않는다(/verify 157행, /heartbeat 256행과 달리). 그런데 303행에서 `buildOk(..., g.lic.session_token || null, ...)` 로 **서버에 저장된 현재 유효 세션 토큰**을 응답에 싣고, buildOk(109행)가 **config_key** 까지 붙인다. 결과적으로 키 + device_id 만 알면(둘 다 앱 화면/ANDROID_ID 에서 얻을 수 있고 크랙앱은 device_id 를 임의로 위조 가능) 누구나 GET 한 번으로 (1) 현재 세션 토큰 (2) 설정 복호화 재료인 config_key 를 얻는다. 이러면 SPEC 7장의 '세션 회전 → 구 세션 session_superseded' 동시사용 차단이 무력화된다(잠긴 기기가 /entitlements 를 폴링해서 새 세션을 주워 heartbeat 를 계속 이어갈 수 있다), SPEC 6.2 서명 핀닝도 이 경로만은 통과하지 않으므로 리패키징 APK 가 bad_app_sig 없이 config_key 를 획득한다 → SPEC 6.1(설정 암호화)의 전제가 깨진다. 덧붙여 이 경로는 server.js:35-40 limitedPath 에 없어 레이트리밋도 안 걸린다.
- 제안 수정: /entitlements 도 `needSession: true` 로 세션을 검증하고(앱 refresh() 는 이미 세션을 갖고 있으니 body/query 에 session 을 실어 보내게 하면 된다), `sigOk(v.appSig)` 검사를 /verify 와 동일하게 적용하고, 응답에서 `session` 은 요청한 세션과 같을 때만(또는 아예 빼고) 내려라. limitedPath 에 GET /entitlements 도 추가해라.
- 재현: 전제: 키 KAKA-AAAA-BBBB-CCCC 가 기기 A(android_id = aaaa1111)에 활성화되어 있고 macro 기능이 유효. ALLOWED_APP_SIGS 에 정품 서명 1개가 등록되어 있다(= 핀닝 켜짐).

1) 기기 B(리패키징 APK 또는 curl. 서명이 달라 정품 app_sig 를 못 만든다)가 소유자 앱 화면에서 본 key 와 device_id 를 하드코딩하고 요청:
   GET /entitlements?key=KAKA-AAAA-BBBB-CCCC&device_id=aaaa1111&nonce=<32hex>
   (app_sig 생략 또는 쓰레기값)
   → 기대 결과: bad_app_sig 거부.
   → 실제 결과: 200 + 서명된 성공 응답. 그 안에 `"session":"<현재 유효 48hex>"` 와 `"config_key":"<base64 HMAC>"` 가 들어있다. (294행 needSession:false, sigOk 미호출, 303·109행)

2) 기기 B 가 방금 받은 session 으로:
   POST /heartbeat {"key":"KAKA-AAAA-BBBB-CCCC","device_id":"aaaa1111","session":"<1번에서 받은 값>","nonce":"..."}  ← app_sig 필드 자체를 넣지 않음
   → 256행 조건이 `v.appSig &&` 라서 서명검사 스킵, gate 의 세션 비교도 통과 → ok:true. 기기 B 는 /verify 를 한 번도 호출하지 않고 macro 를 계속 쓴다.

3) 동시 사용 차단 붕괴: 기기 A 가 앱을 다시 켜서 POST /verify 를 하면 세션이 회전(215~217행)하고, 기기 B 의 다음 heartbeat 는 session_superseded 로 잠긴다.
   → 기대 결과: 기기 B 는 여기서 영구 잠김.
   → 실제 결과: 기기 B 가 1번 요청(GET /entitlements)을 다시 한 번 보내면 회전된 **새 세션**을 그대로 받아서 2번을 재개한다. heartbeat 는 세션을 회전시키지 않으므로(271~276행) 기기 A 도 계속 정상이다. 결과적으로 두 기기가 무제한 동시 사용되고, 이 폴링은 server.js limitedPath 밖이라 레이트리밋도 안 걸린다.

4) 부가 피해: 1번 응답의 config_key 로 기기 B 는 HKDF(SPEC 6.1)를 그대로 수행해 설정을 암복호화할 수 있다 → "라이선스 검증을 통과한 적 없는 크랙앱은 자기 설정을 복호화할 수 없다" 는 SPEC 6.1 의 전제가 깨진다.

### 2. [high][security] AlarmReceiver 가 exported="true" — 아무 앱이나 발송을 강제로 트리거할 수 있다 (SPEC 10장은 exported=false 요구)
- 파일: `/home/user/kakaotalk-macro/android/auto/AndroidManifest.xml`:93
- 내용: SPEC 10장 'AndroidManifest 필수 항목'은 `AlarmReceiver(exported=false)` 를 명시한다. 실제 매니페스트는 91-95행에서 `android:exported="true"` + `android:permission="android.permission.RECEIVE_BOOT_COMPLETED"` 로 열려 있다. RECEIVE_BOOT_COMPLETED 는 protectionLevel=normal 이라 **어떤 서드파티 앱이든 매니페스트에 한 줄 적으면 자동으로 얻는다** → 발신자 제한 효과가 사실상 없다. 그리고 AlarmReceiver.onReceive(AlarmReceiver.java:34-80)는 발신자를 확인하지 않고, action 이 `com.buseong.kakaoauto.ALARM_FIRE` 이거나 **빈 문자열이어도** `Scheduler.runDue(c)` 를 그대로 실행한다(87행). 즉 외부 앱이 명시적 인텐트(setComponent)로 이 리시버를 때리면 사용자의 카톡으로 즉시 발송을 반복 유발해 하루 한도를 태우거나 도배를 일으킬 수 있다(인텐트 필터에 ACTION_FIRE 가 없어도 exported 컴포넌트는 명시적 인텐트로 호출된다).
- 제안 수정: `android:exported="false"` 로 바꿔라 — BOOT_COMPLETED/MY_PACKAGE_REPLACED 같은 시스템 보호 브로드캐스트는 exported=false 매니페스트 리시버에도 전달된다(안드로이드 공식 '기기 부팅 시 시작' 샘플이 exported=false 를 쓴다). 그래도 걱정되면 리시버를 부팅용/알람용 둘로 쪼개고 알람용만 exported=false 로 두되, onReceive 에서 action 이 빈 문자열인 경우를 runDue 로 흘리지 말고 거부해라.
- 재현: 입력: 사용자가 매크로를 정상 사용 중 — 라이선스에 MACRO 보유, macro.enabled=true, rooms=["가족방","공지방"], message="점검 안내", 알림 리스너 연결됨, dailyLimit=200(기본), interval=30분, minMessages=0(Settings.java:684 에서 허용되는 값).

같은 기기에 아무 서드파티 앱이 설치된다. 그 앱 매니페스트에 두 줄만 있으면 된다:
  <uses-permission android:name="android.permission.RECEIVE_BOOT_COMPLETED"/>   (normal → 설치 시 자동 부여, 동의창 없음)
  <queries><package android:name="com.buseong.kakaoauto"/></queries>

그 앱이 40초마다 이걸 반복한다:
  Intent i = new Intent();
  i.setComponent(new ComponentName("com.buseong.kakaoauto", "com.buseong.kakaoauto.AlarmReceiver"));
  sendBroadcast(i);   // action == null

실행 경로: exported="true" 라서 명시적 인텐트가 인텐트필터(BOOT_COMPLETED 3종)와 무관하게 배달된다 → AlarmReceiver.java:38 action="" → :39 isBoot("")=false → :82 `action.length()==0` 통과 → :83 Scheduler.runDue(c).

잘못된 결과: runDue 는 예정 시각(nextAt)을 now 와 비교하지 않으므로 사용자가 정한 30분 주기를 통째로 무시하고 즉시 work() 를 돈다. minNeed=0 이라 work():304 `others < minNeed` 가 항상 false → 두 방 모두 KakaoListener.sendTo() 로 "점검 안내"가 실제 발송되고, m.imagesThisTime(seq) 이 참인 주기에는 ImageSender.send() 로 첨부 이미지(최대 5장)까지 나간다. running 플래그는 동시 실행만 막으므로 공격자는 RUN_BUDGET_MS(35초)만 기다려 반복하면 되고, 40초 간격 × 방 2개면 약 1시간 7분 만에 dailyLimit 200건을 전부 소진한다 → 이후 하루 종일 정상 발송이 "하루 발송 한도(200건)를 다 썼어" 로 전부 차단된다. 동시에 runDue 의 finally 가 매번 scheduleNext(c) 로 다음 알람을 재기준점으로 잡아 사용자의 실제 예약 시각도 계속 밀린다. 사용자 눈에는 자기 카톡에서 같은 메시지가 40초마다 도배돼 나가고(방 상대에게는 스팸), 최악의 경우 카톡 계정 제재로 이어진다.

minMessages 를 기본값 1 로 둔 경우에도 결과는 나쁘다: 공격자가 계속 때리는 동안 상대가 메시지 한 개만 올려도 즉시 발송돼, "30분마다"가 "상대가 말하는 즉시 자동응답"으로 성격이 바뀌고 한도가 조기 소진된다.

### 3. [high][security] /admin/* 에 레이트리밋이 전혀 없다 + ADMIN_PASSWORD 미설정 시 기본값 'change-me-now' 로 그대로 서비스된다
- 파일: `/home/user/kakaotalk-macro/server.js`:37
- 내용: limitedPath(35-40행)는 POST /verify, /api/order, /api/lookup, GET /api/order/ 만 제한한다. `/admin/*` 는 목록에 없어서 비밀번호 추측을 무제한으로 시도할 수 있다. 관리자 API 는 routes/admin.js:41 의 미들웨어 하나(`router.use('/admin', guard)`)로 전부 보호되는 건 맞지만(누락된 /admin 경로는 없음 — 다른 라우터에도 /admin 라우트 없음), 인증 실패에 대한 지연·잠금·기록이 아예 없다(guard 는 audit 도 남기지 않는다). 게다가 routes/admin.js:28 의 `String(process.env.ADMIN_PASSWORD || 'change-me-now')` 때문에 환경변수를 안 넣어도 서버는 정상 부팅하고(server.js:143 은 console.error 경고만 한다) 공개된 기본 비밀번호로 /admin/create·/admin/list 가 열린다 = 키 무한 발급 + 전 고객 정보(device_id, note, owner_contact) 유출. 같은 맥락으로 /heartbeat, /entitlements, /config, /api/deposit-hook 도 레이트리밋 밖이라 입금 토큰 추측·DB 쓰기 폭주에 노출된다.
- 제안 수정: limitedPath 에 `/admin` 접두 경로를 추가하고(관리자용은 분당 5~10회 수준), 실패 시 audit.record(req,'bad_admin_pw') 로 기록 + IP별 연속 실패 시 지연/차단해라. ADMIN_PASSWORD 가 비어 있으면 기본값으로 돌지 말고 프로세스를 죽이거나 /admin 전체를 503 으로 닫아라(DEPOSIT_TOKEN 미설정 처리와 같은 방식). /api/deposit-hook, /heartbeat, /config 도 리밋 대상에 넣어라.
- 재현: **시나리오 A — 기본 비밀번호로 전 고객 유출 + 무한 키 발급 (인증 우회)**

입력:
1. 운영자가 `render.yaml` 블루프린트로 배포한다. `ADMIN_PASSWORD` 는 `sync: false`(자동생성 아님)이므로 대시보드에서 값을 채우지 않으면 비어 있다.
2. 서버 부팅: `warnEnv()`(server.js:143)가 `ADMIN_PASSWORD 가 없어 → 기본값(change-me-now)으로 돌아` 를 로그에 한 줄 찍는다. 그 다음 줄 `db.migrate().then(() => app.listen(PORT, ...))` 가 정상 실행되어 `license server on :3000`. 헬스체크 `/health` 200 → Render 는 배포 성공으로 판정.
3. 공격자(GitHub 에서 admin.js:28 을 읽은 누구나):
   `curl -H 'x-admin-password: change-me-now' 'https://<host>/admin/list?limit=500'`

잘못된 결과: `pwOk()` 가 `want='change-me-now'` 와 비교해 `timingSafeEqual` 통과 → guard 가 next() → **200 OK 와 함께 licenses 전체가 JSON 으로 나온다**: 모든 고객의 `key`, `device_id`, `device_name`, `note`, `owner_name`, `owner_contact` (admin.js:111-132, `db.shapeLicense`). 이어서
   `curl -XPOST -H 'x-admin-password: change-me-now' -H 'content-type: application/json' -d '{"features":["macro","roombot","minigame"],"plan":"year","count":100}' https://<host>/admin/create`
→ 1년치 3기능 키 100개가 공짜로 발급된다(admin.js:62-77). `POST /admin/delete` 로 결제한 고객 키를 지우거나 `POST /admin/revoke` 로 전부 잠글 수도 있다. 감사 로그에는 공격자를 특정할 게 IP 한 줄뿐이고, 조회(`/admin/list`)는 audit 을 아예 안 남기므로 유출 자체가 흔적이 없다.

**시나리오 B — 비밀번호를 제대로 설정해도 무제한 무기록 브루트포스**

입력: `ADMIN_PASSWORD=Hunter2!` 로 정상 설정된 상태. 공격자가 초당 수백 건으로
`POST /admin/create` + `x-admin-password: <추측값>` 을 계속 던진다.

경로 추적: `limitedPath(req)` → `req.method==='POST'` 이지만 `p==='/admin/create'` 는 `/verify`·`/api/order`·`/api/lookup` 어느 것과도 같지 않다 → `return false` → server.js:43 `if (!limitedPath(req)) return next();` 로 리밋 미들웨어를 그냥 통과. `rlBuckets` 에 카운트조차 올라가지 않는다.

잘못된 결과: 요청 수에 상한이 없다. 실패는 `401 {"ok":false,"error":"unauthorized"}` 뿐이고
- `audit.record` 호출이 없어 `GET /admin/audit` 에 아무것도 안 뜬다 → 운영자는 공격이 진행 중인지 **영원히 모른다**
- `console.log` 도 없다 → Render 로그에도 안 남는다
- IP별 지연/차단이 없어 429 도 안 나온다

게다가 `pwOk()`(admin.js:29-32)는 `a.length !== b.length` 면 즉시 false 를 리턴하므로, 공격자는 길이 1~64 를 각각 한 번씩 보내며 응답시간 차이로 **비밀번호 길이를 먼저 확정**한 뒤(리밋이 없어 64회로 충분) 해당 길이만 공략한다. 성공 시 결과는 시나리오 A 와 동일(전 고객 정보 유출 + 무한 키 발급).

**시나리오 C — 입금 토큰 추측이 곧 Neon 쓰기 폭주**

입력: `DEPOSIT_TOKEN` 설정됨. 공격자가 `POST /api/deposit-hook?t=<추측값>` 을 분당 수만 건 보낸다.
경로: `limitedPath` 에 `/api/deposit-hook` 이 없어 리밋 통과 → purchase.js:262 `tsEqual` 실패 → `audit.record(req,'bad_deposit_token',...)`.
잘못된 결과: 토큰 추측 시도가 무제한인 동시에, **실패 1건당 audit_log INSERT 1건**이 발생한다. Neon 무료 플랜의 쓰기/컴퓨트 한도를 공격자가 외부에서 임의로 소진시킬 수 있고, audit_log 가 쓰레기 행으로 덮여 `/admin/audit` 의 실제 경보(mismatch/takeover/tamper)가 20~500행 LIMIT 밖으로 밀려난다. 같은 이유로 `POST /heartbeat` 에 틀린 `app_sig` 를 붙여 던지면(license.js:255-260) 인증 없이도 요청당 `bad_sig` INSERT 가 무제한 발생한다.

### 4. [high][security] APK 서명 키스토어를 일부러 레포에 커밋하고 그 비밀번호가 build.sh 에 평문으로 박혀 있다 → 서명 핀닝(SPEC 6.2)이 무의미해진다
- 파일: `/home/user/kakaotalk-macro/.gitignore`:23
- 내용: .gitignore 23-25행이 `android/keystore/app.jks 는 일부러 커밋한다 ... (여기 적지 마라)` 라고 지시하고, android/build.sh:13 에 `KS_PASS="kakaomacro2026"` 가 평문으로 있다(build.sh:206 apksigner 에 그대로 넘긴다). 둘 다 같은 레포에 들어가므로 레포 읽기 권한이 있는 사람(또는 레포가 한 번이라도 공개/유출되면 누구나)은 **정품과 동일한 서명으로 개조 APK를 재서명**할 수 있다. 그러면 SPEC 6.2 의 서명 핀닝(app_sig 허용목록 대조)과 docs/APP_SIGNATURE.txt 의 해시 값이 전부 우회되고, 기기에 정품 위에 덮어쓰기 설치까지 된다(서명이 같으므로). CI 는 이미 `secrets.KEYSTORE_B64` 경로를 지원하므로(.github/workflows/build-apk.yml:42) 키스토어를 커밋할 필요가 없다.
- 제안 수정: `android/keystore/*.jks` 를 .gitignore 에 넣고(이미 커밋됐다면 히스토리에서 제거 + 키 교체 여부 판단), KS_PASS 는 `KS_PASS="${KEYSTORE_PASS:?keystore 비번을 환경변수로 넘겨라}"` 처럼 환경변수/GitHub Secret 에서만 받아라. '키를 잃으면 덮어쓰기 업데이트가 안 된다'는 문제는 KEYSTORE_B64 + KEYSTORE_PASS 를 Secrets 에 보관하고 오프라인 백업을 따로 두는 방식으로 해결해야 한다.
- 재현: 입력: 레포 읽기 권한이 있는 사람(협업자, 또는 레포가 한 번이라도 공개/유출된 뒤의 임의의 제3자)이 `git clone` 한다. android/ 가 .gitignore 대상이 아니므로(.gitignore:23-25 가 명시적으로 제외를 금지) 체크아웃에 android/keystore/app.jks 개인키가 그대로 들어있고, android/build.sh:13 에서 비번 `kakaomacro2026` 을 그냥 읽는다(실제로 이 비번으로 키스토어가 열리는 것을 확인했다).

공격자 행동: 안드로이드 소스에서 라이선스 게이트를 무력화한다 — 예컨대 기능 플래그 조회가 항상 macro/roombot/minigame 전부 enabled 를 반환하게 바꾸거나, /api/license/verify 호출 자체를 제거하고 로컬에서 성공 응답을 위조한다. 그다음 `./build.sh all` 을 돌린다. build.sh:206 이 커밋된 같은 키·같은 비번으로 재서명한다.

잘못된 결과:
1. 개조 APK 의 인증서 SHA-256 이 `33ed6784cbea8bb34eb9a4f08f1f13c845a588a8d7d14cb74915b70cc53730fa` — docs/APP_SIGNATURE.txt 및 ALLOWED_APP_SIGS 에 등록된 정품 값과 동일하다.
2. 앱이 `app_sig=33ed67…30fa` 를 실어 보내면 routes/license.js:157 의 sigOk() 가 허용목록에서 그 값을 찾아 **통과**시킨다. `bad_app_sig` 가 발생하지 않고, audit 에도 bad_sig 기록이 남지 않아 운영자는 위조 클라이언트를 구분할 수단이 없다(:255-259 하트비트 경로도 동일하게 통과).
3. 서명자가 일치하므로 Android 가 이 개조 APK 를 정품 설치본 위에 **덮어쓰기 업데이트로 설치**한다 — 삭제 요구도, 서명 불일치 경고도 없다. 사용자는 정품과 구별할 수 없는 앱을 받는다.
4. 결과적으로 SPEC 6.2 의 리패키징 방어(서명 핀닝)와 docs/APP_SIGNATURE.txt 해시가 전부 무의미해지고, 키 없이 앱을 쓰는 악용(사용자가 막으라고 요청한 바로 그 항목)과 기능별 결제 분리가 동시에 우회된다.

### 5. [high][protocol] /entitlements 가 서버 세션 토큰을 그대로 돌려줘서 '동시 사용 차단'이 무력화된다
- 파일: `routes/license.js`:303
- 내용: GET /entitlements 는 key+device_id 만 있으면 통과하고(gate 를 needSession:false 로 호출, 294행), 응답에 buildOk 로 g.lic.session_token 을 그대로 실어 보낸다(303행). SPEC 7장은 '세션 토큰이 /verify 마다 회전하므로 android_id 를 복제해도 두 기기가 동시에 정상 동작하지 못한다'고 보장하는데, 밀려난 기기가 /entitlements 를 한 번 부르면 현재 유효 세션을 공짜로 받아가서 /heartbeat 를 계속 통과한다. 세션 소유 증명이 전혀 없는 엔드포인트가 세션을 발급하는 셈이라, 키 1개를 두 기기가 무한히 돌려쓸 수 있다(=결제 회피).
- 제안 수정: buildOk 를 /entitlements 에서 쓸 때 session 을 null(또는 필드 제외)로 넘기거나, 요청에 session 을 요구해서 저장값과 일치할 때만 같은 값을 돌려줘라. 앱 License.saveTick(full=false) 은 이미 session 을 무시하니 빼도 사용자앱은 영향 없다.
- 재현: 전제: 키 `K=KAKA-1111-2222-3333` 이 `device_id=D` 에 고정돼 있고 `macro` entitlement 가 유효. `ALLOWED_APP_SIGS` 가 설정돼 있음(정상 운영 상태).

1. 정상 기기 A: `POST /verify {key:K, device_id:D, app_sig:<정상서명>}` → `session:"S1"` 발급, `licenses.session_token='S1'`. A 는 S1 로 heartbeat 중.
2. 공격자 기기 B: android_id 를 D 로 위조 + 리패키징한 APK(서명 다름). `POST /verify {key:K, device_id:D, app_sig:<위조>}` → `bad_app_sig` 로 **차단됨**. 여기까지는 설계대로 동작.
3. B 가 대신 `GET /entitlements?key=K&device_id=D&nonce=aaaa` (app_sig 생략 또는 쓰레기값) 호출.
   → 잘못된 결과: `200 {ok:true, features:{macro:{on:true,...}}, session:"S1", config_key:"<HMAC 원본>", sig:...}`
   서명 검사도 세션 검사도 없이 **현재 유효 세션 S1 과 설정 암호화 키를 그대로 내준다.** audit 기록 없음.
4. B: `POST /heartbeat {key:K, device_id:D, session:"S1"}` → `gate(needSession:true)` 에서 `S1 === lic.session_token` 이라 통과. heartbeat 는 회전하지 않으므로 A 도 계속 S1 로 통과.
   → 결과: A 와 B 가 **같은 세션 S1 을 동시에 들고 무기한 정상 동작**. 둘 중 누구도 `session_superseded` 를 받지 않는다. SPEC 7장이 "동시에 정상 동작하지 못한다" 고 보장한 상태가 그대로 깨지고, 키 1개 값으로 기기 2대(→N대)를 돌려쓴다 = 결제 회피.

밀려난 기기 복구 변형: B 가 정상 서명으로 `/verify` 해서 S2 로 회전시켜 A 가 `session_superseded` 로 잠긴 경우에도, A 가 `GET /entitlements?key=K&device_id=D` 한 번 부르면 S2 를 그대로 받아 `/heartbeat` 를 다시 통과한다. 회전이 만들어야 할 상호배타성이 "둘 다 같은 살아있는 토큰 보유" 로 바뀐다.

수정 검증 포인트: `routes/license.js:303` 의 세 번째 인자를 `null` 로 바꾸면 위 3단계 응답의 `session` 이 null 이 되어 4단계가 `session_superseded` 로 막힌다. 앱은 `License.java:529` 의 `if (full)` 가드 때문에 무영향.

### 6. [high][protocol] /heartbeat·/entitlements 가 app_sig·MIN_APP_VERSION 을 검사하지 않고 config_key 를 재발급한다
- 파일: `routes/license.js`:256
- 내용: app_sig 검사는 /verify(157행)에만 강제되고, /heartbeat 는 'v.appSig 가 있을 때만' 검사한다(256행) — 필드를 빼고 보내면 검사를 건너뛴다. /entitlements 는 app_sig 를 쿼리로 받아놓고(readCommon) 아예 보지 않는다(294행). MIN_APP_VERSION 도 /verify(163~164행)에만 있다. 그런데 두 경로 모두 okBody→buildOk 로 config_key(109행)를 다시 내려주고, 앱은 그 값을 그대로 Keystore 에 보관한다(License.java:547~557). 결과적으로 한 번만 정품으로 활성화된 기기에서는 리패키징된 APK가 /verify 를 영구히 피하면서 config_key·features 를 계속 받아갈 수 있다 → SPEC 6장 2번(서명 핀닝)과 11장(강제 업데이트)이 둘 다 우회된다. docs/ANTI_ABUSE.md:15 의 'config_key 는 라이선스 검증 성공 응답에만 실어 보낸다'는 설명과도 어긋난다.
- 제안 수정: sigOk / MIN_APP_VERSION 검사를 /heartbeat·/entitlements 에도 같은 조건(app_sig 누락 시 거부)으로 적용하고, config_key 는 /verify 성공 응답에만 넣어라(SPEC 3.1-9 문구대로). 앱은 config_key 를 Keystore 에 보관하므로 하트비트에서 뺀다고 기능이 깨지지 않는다 — 분실 복구는 재인증으로 처리.
- 재현: 전제: 운영자가 android/README.md:170~178 안내대로 ALLOWED_APP_SIGS=<v2.0 서명>, MIN_APP_VERSION=20 을 설정했고, 사용자가 정품 v2.0 으로 한 번 /verify 를 통과해 licenses.device_id='A' 로 고정된 상태.

입력: 리패키징(재서명)해서 app_sig 가 허용목록에 없는 APK, 또는 versionCode=9 인 구버전 빌드가 key/device_id 를 박아놓고 다음 한 줄만 호출한다 —
GET /entitlements?key=KAKA-XXXX-XXXX-XXXX&device_id=A&nonce=<32hex>   (app_sig 파라미터는 아예 생략, 또는 app_sig=<위조서명>&app_version=1 로 보내도 동일)

잘못된 결과: routes/license.js:287~303 이 sigOk 도 MIN_APP_VERSION 도 검사하지 않고, gate(needSession:false) 만 통과시킨 뒤 buildOk(101~114)로 HTTP 200 + Ed25519 서명된 { ok:true, features:{macro:{on:true...}}, config_key: base64(HMAC-SHA256(CONFIG_SECRET, "KAKA-XXXX-XXXX-XXXX|A")) ... } 을 내려준다. 기대값은 bad_app_sig(SPEC 3.1-1) 또는 update_required(SPEC 3.1-2)다. 리패키징 앱은 이 config_key 를 License.java:546~557 경로로 Keystore 에 넣고 SPEC 6-1 의 HKDF 로 AES 키를 유도해 설정을 복호화 → 유료 기능이 전부 동작한다. /verify 를 영구히 호출하지 않으므로 서명 핀닝·강제 업데이트가 둘 다 적용되지 않고, /entitlements 는 세션을 회전시키지 않아 정품 기기의 session_token 이 그대로 남는다 → 정품 기기와 크랙 기기가 동시에 정상 동작한다(1키 1기기 무력화). 필요할 때마다 같은 GET 한 번으로 features·config_key 를 재수급한다.

두 번째 입력: POST /heartbeat 에 {"key":"KAKA-XXXX-XXXX-XXXX","device_id":"A","session":"<정품에서 읽어낸 48hex>","nonce":"..."} 처럼 app_sig 키를 JSON 에서 빼고 보낸다. → 256행의 `v.appSig &&` 가 거짓이 되어 bad_sig audit 도 남지 않고 통과, buildOk 로 config_key·features 를 받고 앱의 K_LASTOK 이 갱신돼 3일 유예가 무한 연장된다. 기대값은 bad_app_sig 거부(app_sig 누락 = 거부)다.

### 7. [high][protocol] 백그라운드 하트비트가 매크로 알람에만 얹혀 있어 봇 전용 사용자는 3일 뒤 전부 잠긴다
- 파일: `android/auto/java/com/buseong/kakaoauto/Scheduler.java`:158
- 내용: 하트비트를 백그라운드에서 부르는 곳은 Scheduler.runDue 끝의 kickHeartbeat(495~499행) 하나뿐이다. 그런데 그 알람은 ensureScheduled/scheduleNext 에서 '매크로가 켜져 있고 License.allowed(MACRO) 일 때만' 유지되고 아니면 cancel 된다(88~90행, 158~160행). 그래서 roombot·minigame 만 결제한 사용자(또는 매크로를 끈 사용자)는 알람이 아예 없어 하트비트가 한 번도 돌지 않는다. License.state() 는 now > lastOk + graceMs 면 grace_expired 로 licensed=false 를 만들기 때문에(License.java:180~184), 인터넷이 정상이고 결제도 살아있는데 앱을 3일 동안 손으로 열지 않으면 방관리봇·미니게임봇이 통째로 멈춘다. 반대로 잠긴 뒤에는 알람이 취소된 상태라 스스로 복구할 방법도 없다(사용자가 앱을 열어야 MainActivity.maybeHeartbeat 가 돈다).
- 제안 수정: 매크로 발송 알람과 별개로 recheck_ms 주기의 라이선스 하트비트 알람(키가 저장돼 있으면 무조건 유지, 잠겨도 유지)을 하나 더 두고 kickHeartbeat 를 거기서 돌려라. KakaoListener 가 살아있는 동안 주기 체크를 얹는 것도 가능하다.
- 재현: 입력: 사용자가 방관리봇만 결제(features = macro:off, roombot:on, minigame:off). 앱을 열어 키를 인증하면 /verify 성공으로 lic_lastok=T0, lic_ok=true 가 저장되고 방관리봇 설정을 마친 뒤 앱을 닫는다. 매크로는 안 샀으므로 App.warmUp → Scheduler.ensureScheduled 가 License.allowed(MACRO)=false 로 cancel(c) 를 불러 알람이 아예 걸리지 않는다(Scheduler.java:87~91). 이후 카톡 알림은 계속 오고 KakaoListener 가 dispatch 하지만, 하트비트 알람이 없어 lic_lastok 은 T0 에서 갱신되지 않는다. 잘못된 결과: T0+3일 1초가 지난 순간부터 License.state() 가 grace_expired 로 licensed=false 를 만들고(License.java:184~187), KakaoListener.java:256 의 License.allowed(ctx, Features.ROOMBOT) 가 false 가 되어 RoomBot.onMessage 가 한 번도 호출되지 않는다. 인터넷이 정상이고 서버상 결제도 살아있는데 방관리봇이 통째로 멈추며, 그 분기에는 로그도 없어서 Log.add 에 아무 흔적이 남지 않는다. 게다가 알람이 취소된 상태라 자가 복구가 불가능해서, 사용자가 MainActivity 를 손으로 열어 onResume→maybeHeartbeat(MainActivity.java:77,593) 가 돌 때까지 영구히 멈춘 상태로 남는다. 동일한 일이 매크로+방관리봇을 산 사용자가 매크로 스위치만 끈 경우(Scheduler.java:83~86 의 !m.enabled → cancel)에도 발생한다.

### 8. [high][protocol] 주문 상태 페이지가 폴링을 안 한다 — 무인 자동발급인데 구매자가 키를 못 받는다
- 파일: `public/app.js`:1220
- 내용: SPEC 12.4 는 /order/:id 가 '5초마다 폴링(창 포커스 시 즉시) → status==='done' 이면 키를 크게 + 복사 버튼, 최대 30분 폴링 후 [새로고침] 버튼만 남긴다'를 요구한다. 그런데 pageOrder 는 load(id) 를 딱 한 번 부르고(1220행) 끝이며, 파일 전체에 setInterval·visibilitychange·focus 핸들러가 없다(폴링 코드 자체가 없음). 자동 입금확인이 DEPOSIT_AUTO_APPROVE=1 로 30초 안에 키를 발급해도 페이지는 계속 'pending' 상태로 멈춰 있다. 게다가 안내문이 '입금이 확인되면 관리자가 키를 발급해. 확인은 수동이라 조금 걸릴 수 있어'(1312행)라서 12장의 무인 발급 설계와 정반대로 설명한다.
- 제안 수정: load 를 5초 setInterval + 'visibilitychange'/'focus' 즉시 호출로 감싸고, status 가 done/canceled 면 타이머를 끄고, 30분 지나면 타이머만 정리해 [상태 새로고침] 버튼을 남겨라. pending 안내문도 '입금하면 보통 1~2분 안에 자동으로 키가 발급돼'로 고쳐라.
- 재현: Set DEPOSIT_TOKEN and leave DEPOSIT_AUTO_APPROVE unset (defaults to '1' per routes/purchase.js:336). A buyer submits an order for the macro feature and is redirected to /order/ORD-260927-A3K9QZ?t=<token>; the page fetches once and renders the '입금 대기' chip, '정확히 39,047원', and the tip '입금이 확인되면 관리자가 키를 발급해. 확인은 수동이라 조금 걸릴 수 있어.' (app.js:1312). The buyer transfers exactly 39,047원 and leaves the tab open. Within ~30 seconds the phone automation POSTs the bank notification to /api/deposit-hook; the server matches amount=39047 to exactly one pending order, issues KAKA-XXXX-XXXX-XXXX, writes issued_key and sets orders.status='done'. Expected (SPEC §12.4): within 5 seconds — or instantly when the buyer switches back to the tab — the page shows the key large with a copy button and '앱에 이 키를 입력해'. Actual: the DOM never changes. The page still shows '입금 대기' and the 'confirmation is manual' text indefinitely (minutes, hours), because load() is called once at app.js:1220 and no timer, visibilitychange or focus handler exists. The buyer's key is sitting in the database, reachable by the very request the page already knows how to make, but they see a stalled pending order and are told to wait on a human — so they contact the admin instead, defeating the unattended issuance the whole of §12 is built for.

### 9. [high][runtime] WAKE_LOCK 권한 누락 — 화면 꺼진 동안 자동발송이 중간에 끊긴다
- 파일: `android/auto/AndroidManifest.xml`:19
- 내용: Scheduler.acquire() 는 PowerManager.PARTIAL_WAKE_LOCK 을 잡아서 runDue 가 도는 35초(RUN_BUDGET_MS)를 지키도록 설계돼 있다(Scheduler.java:412-429, 주석에도 "WAKE_LOCK 권한이 없으면 여기서 터진다" 라고 적혀 있다). 그런데 매니페스트 권한 목록(11~29행)에 android.permission.WAKE_LOCK 이 없다. newWakeLock 자체는 통과하지만 wl.acquire(60000) 에서 SecurityException 이 나고 catch 로 잡혀 "WakeLock 을 못 잡았어" 로그만 남는다. 즉 WakeLock 방어가 통째로 죽어 있다. AlarmReceiver 는 HANDOFF_MS(8초) 뒤에 goAsync PendingResult 를 먼저 놓아주기 때문에(AlarmReceiver.java:65) 그 뒤엔 프로세스를 잡아두는 게 아무것도 없다. Scheduler.work() 는 방 사이마다 1~3초씩 쉬므로(gap(), Scheduler.java:457-464) 방이 4개만 넘어도 8초를 넘기고, 도즈/화면꺼짐 상태에서 남은 방은 발송되지 않은 채 프로세스가 얼어붙을 수 있다.
- 제안 수정: auto/AndroidManifest.xml 권한 목록에 <uses-permission android:name="android.permission.WAKE_LOCK" /> 를 추가한다. (Scheduler 코드는 그대로 두면 된다 — 권한만 생기면 설계대로 동작한다.)
- 재현: 입력: 매크로 켬, 대상 방 5개(방A~방E), 최소 새 메시지 조건 충족, 이미지 첨부 없음, 화면 꺼진 상태(도즈). 알람이 RTC_WAKEUP 으로 울려 AlarmReceiver.onReceive → goAsync() → spawn() → Scheduler.runDue 진입. 진행: acquire() 가 SecurityException 으로 실패해 로그 "WakeLock 을 못 잡았어(java.lang.SecurityException: ... android.permission.WAKE_LOCK)" 만 남고 wl=null. work() 는 방A 발송 후 gap() 1~3초, 방B 발송 후 gap(), ... 로 진행하므로 방A~방C 를 보내는 데만 gap 2회(2~6초) + RemoteInput 발송 지연이 들어가 8초 경계에 닿는다. 8초 시점에 postDelayed(finish) 가 브로드캐스트를 놓아주고(AlarmReceiver.java:65) setExactAndAllowWhileIdle 가 준 임시 wake 창도 끝나면, 이 시점부터 프로세스를 깨워둘 게 아무것도 없어 gap() 의 Thread.sleep 에서 CPU 가 서스펜드된다. 잘못된 결과: 방D·방E 에 메시지가 발송되지 않는다(사용자에겐 "자동발송 · 성공 3건" 요약조차 안 뜬다 — 요약 로그도 멈춘 루프 뒤에 있다). 게다가 running 플래그가 true 로 남아 있어 다음 알람의 runDue 는 "앞선 자동발송이 아직 안 끝났어 — 이번 알람은 건너뛸게" 로 빠지고, 다음 알람을 다시 잡는 scheduleNext(c) 는 실행되지 못한 finally 안에 있으므로 이후 주기 발송까지 연쇄로 멈춘다. 화면을 켜서 프로세스가 다시 스케줄되기 전까지 자동발송이 사실상 정지한다.

### 10. [high][runtime] 그룹방이 1:1로 오판돼 오픈프로필 자동응답이 단체방에 발송된다
- 파일: `android/auto/java/com/buseong/kakaoauto/KakaoListener.java`:326
- 내용: parse() 의 그룹 판정 순서가 뒤집혀 있다. 320~323행에서 `m.sender` 가 비어 있으면 `m.sender = m.group ? "" : m.room` 으로 방 이름을 발신자 이름에 대입하는데, 이 시점의 m.group 은 아직 EXTRA_IS_GROUP_CONVERSATION 기본값(false)이다. 그 직후 326~330행의 구버전 보정은 `!convo.equals(m.sender)` 일 때만 group=true 로 바꾸는데, 방금 sender 에 convo(방 이름)를 넣었으므로 둘이 항상 같아서 보정이 절대 발동하지 않는다. 결과적으로 EXTRA_IS_GROUP_CONVERSATION 이 없고(minSdk 26 = 안드로이드 8/8.1 은 MessagingStyle 이 이 extra 를 안 넣는다) android.messages 배열도 없는 카톡 그룹방 알림은 group=false 로 분류된다. 그러면 dispatch() 241행의 `if (!m.group && !m.fromMe)` 를 통과해 AutoReply.onDirectMessage 가 불리고, AutoReply.java:79-80 의 2차 확인(`s.group`)도 같은 잘못된 값을 쓰기 때문에 막지 못한다. 기본 scope 가 SCOPE_ALL 이라 사용자의 단체방에 "오픈프로필 개인톡 자동응답" 메시지가 그대로 나간다(치환 토큰 {이름} 에는 그룹방 이름이 들어간다). 하루 한도 100건까지 도배될 수 있다.
- 제안 수정: sender 폴백(320-323행)보다 group 보정(326-330행)을 먼저 수행하고, 보정 조건을 sender 에 의존하지 않게 바꾼다. 예: `if (!ex.containsKey(EXTRA_IS_GROUP_CONVERSATION) && convo.length() > 0 && !convo.equals(title)) m.group = true;` (conversationTitle 과 title 이 다르면 그룹) 로 판정한 뒤에 sender 폴백을 적용한다. 추가로 AutoReply.onDirectMessage 에 "발신자 이름 == 방 이름" 이 확인되지 않으면 보내지 않는 보수적 게이트를 하나 더 둔다.
- 재현: 입력: 안드로이드 8.1(API 27) 기기, 매크로 라이선스 활성, 매크로 탭에서 자동응답 ON + 메시지 "지금 자리에 없어요 {이름}님" (나머지 기본값: scope=ALL, cooldown 6시간, dailyLimit 100, 운영시간 0~24). 카톡 그룹방 "우리반 단톡방"에서 홍길동이 "안녕하세요" 전송. 그 알림의 extras = { android.title="우리반 단톡방", android.conversationTitle="우리반 단톡방", android.text="홍길동 : 안녕하세요", 직접답장 RemoteInput 액션 1개 } / android.isGroupConversation 없음(API 28+ 전용이라 27에서는 불가) / android.messages 없음(MessagingStyle 아님).

추적: KakaoListener.parse() 298행 m.room="우리반 단톡방" → 299행 m.group=false → 309행 last=null 이라 m.sender="" → 319행 m.text="홍길동 : 안녕하세요" → 320-322행 m.sender="우리반 단톡방" → 326-328행에서 convo("우리반 단톡방").equals(m.sender) 이므로 329행 m.group=true 건너뜀 → group=false 확정. 206행 s.group=false. 241행 `!m.group && !m.fromMe` 통과 → AutoReply.onDirectMessage(room="우리반 단톡방", sender="우리반 단톡방", text) → AutoReply 79-80행 s.group(false) 로 통과 → coversRoom(ALL) true → KakaoListener.sendTo() 가 그 그룹방 알림의 RemoteInput 으로 발송.

잘못된 결과: 단체방 전원이 보는 채팅창에 "지금 자리에 없어요 우리반 단톡방님" 이 올라간다({이름} 에 그룹방 이름이 치환됨). 기대 결과는 그룹방이므로 아무 것도 보내지 않는 것. 참여 중인 모든 그룹방에서 각 방당 6시간마다 1회, 하루 최대 100건까지 반복된다.

### 11. [high][ux] 주문 상태 페이지에 자동 폴링이 없다 (SPEC 12.4 위반) — 자동 입금승인의 의미가 사라짐
- 파일: `/home/user/kakaotalk-macro/public/app.js`:1228
- 내용: pageOrder() 는 진입 시 load(id) 를 딱 한 번 호출하고 끝난다(app.js:1220 load(id), 1228~1245). setInterval/setTimeout/visibilitychange/focus 핸들러가 파일 전체에 하나도 없다(grep 결과 0건). 유일한 갱신 수단은 app.js:1306 의 [상태 새로고침] 수동 버튼이다. 그런데 서버는 routes/purchase.js:336 에서 DEPOSIT_AUTO_APPROVE 기본값 '1' 로 금액 매칭 즉시 키를 발급한다 → 키는 수십 초 안에 나오는데 구매자는 그걸 모르고 계속 손으로 새로고침해야 한다. SPEC 12.4 는 "5초마다 폴링(그리고 창 포커스 시 즉시), status==='done' 이면 키를 크게 + 복사 버튼, 최대 30분 폴링 후 중단" 을 명시하고 있다. 무인 발급 플로우의 마지막 한 칸이 비어 있다.
- 제안 수정: pageOrder() 안에 폴링 루프를 넣어라. status 가 'pending' 인 동안만 5초 간격으로 load(oid) 를 다시 돌리고, window 'focus' / document 'visibilitychange'(visible) 에서 즉시 1회 갱신, 누적 30분이 지나면 타이머를 끊고 [새로고침] 버튼만 남긴다. status 가 done/canceled 로 바뀌면 타이머를 반드시 clear 하고, 렌더 중복 방지로 in-flight 요청 플래그를 둬라.
- 재현: 입력: 구매자가 /buy 에서 매크로 1개월을 신청해 주문 KM-XXXX(금액 22,317원)를 받고 /order/KM-XXXX?t=<token> 로 이동한다. 페이지는 load() 를 1회 실행해 status='pending' 을 그려놓고 "입금 금액/계좌"와 "확인은 수동이라 조금 걸릴 수 있어. 이 페이지를 새로고침해서 확인해줘."(app.js:1312)를 띄운다. 구매자가 그 탭을 열어둔 채 뱅킹 앱으로 22,317원을 송금하고, 은행 알림 웹훅이 10초 뒤 /api/deposit 에 도착한다. 서버는 routes/purchase.js:336 기본 auto=true 로 금액을 매칭해 keys.approveOrder 를 즉시 실행하고 주문을 done 으로 바꾸며 라이선스 키를 발급한다. 잘못된 결과: 열려 있던 주문 페이지는 영원히 pending 화면 그대로다. 폴링 타이머도, 탭으로 돌아올 때 걸리는 focus/visibilitychange 갱신도 없어서 DOM이 절대 다시 그려지지 않는다. 이미 발급된 키가 서버에 있는데도 구매자는 [상태 새로고침]을 직접 누르거나 브라우저를 새로고침하기 전까지 키를 볼 수 없고, 화면 문구는 "사람이 수동으로 확인한다"고 말하고 있으니 구매자는 몇 분에서 몇십 분을 기다리거나 관리자에게 문의한다. SPEC 12.4 가 요구한 대로라면 송금 후 5초 이내 폴링 1회로 status==='done' 을 받아 키가 크게 뜨고 복사 버튼이 나왔어야 한다.

### 12. [high][ux] "구매했는데 안 켜졌어 (새로고침)" 버튼이 새로고침을 안 한다 — 탭 이동만 한다
- 파일: `/home/user/kakaotalk-macro/android/auto/java/com/buseong/kakaoauto/ScreenMacro.java`:116
- 내용: 잠금 카드의 두 번째 버튼(ScreenMacro.java:116-118, ScreenBot.java:110-112)은 라벨에 "(새로고침)" 이라고 적혀 있는데 실제 동작은 Nav.go(Nav.ACCOUNT) 뿐이다. License.refresh(=/entitlements 재조회)를 부르지 않는다. 사용자 요구 (3)의 핵심 흐름(웹에서 결제 → 앱에서 기능 켜짐 확인)에서 가장 많이 눌릴 버튼이 자기 이름대로 동작하지 않는다. 결제 직후 사용자는 이 버튼을 누르고 "아무 일도 안 일어났다"고 느낀 뒤 내정보 화면에서 [기능 새로고침]을 다시 찾아 눌러야 한다. Gate.java:72 의 안내문("결제 뒤엔 내정보 탭에서 [새로고침]을 눌러줘")도 같은 우회를 요구한다.
- 제안 수정: 이 버튼에서 바로 License.refresh(a, cb) 를 호출하라. Nav.busy(btn, true, "확인 중…", "...") 로 중복탭을 막고, 콜백에서 성공이면 a.renderShell() (기능이 켜지면 화면이 잠금 해제됨), 실패면 License.reasonKr(reason) 을 토스트/에러줄로 보여준다. 탭 이동은 실패했을 때의 보조 동작으로만 남겨라.
- 재현: 키에 roombot 만 있는 사용자(macro 꺼짐)가 매크로 탭에서 잠금 카드를 본다 → [구매하기] 탭 → 브라우저에서 macro 결제 완료(서버에 entitlement 생성) → 앱으로 복귀(onResume 이 캐시로 renderShell, 하트비트는 10분 제한에 걸려 스킵. 설령 돌아도 완료 콜백이 HOME 탭만 refreshHome 하므로 매크로 탭은 그대로) → "구매했는데 안 켜졌어 (새로고침)" 버튼을 누른다. 잘못된 결과: 네트워크 요청이 한 건도 나가지 않고 내정보 탭으로 화면만 바뀐다. 기능 상태는 여전히 macro=꺼짐으로 표시되고, 사용자는 "아무 일도 안 일어났다"고 느낀 뒤 내정보 화면에서 [기능 새로고침]을 직접 찾아 눌러야 비로소 /entitlements 가 재조회되어 매크로가 켜진다.

## 검증에서 반박된 항목 (고치지 마라 — 오탐)
- [high] config_key 가 /verify 뿐 아니라 /heartbeat · /entitlements 응답에도 매번 실려 나간다 (SPEC 3.1-9 위반) (`/home/user/kakaotalk-macro/routes/license.js`)
- [high] 메시지추적이 자기 응답에 다시 걸려 쿨다운 간격으로 영원히 반복 발송된다 (`android/auto/java/com/buseong/kakaoauto/Trigger.java`)

## medium / low (여유 되면)
- [medium][security] 기능 게이트의 입력값(lic_feats · lic_ok · lic_lastok)이 평문 SharedPreferences 라서 루팅 기기에서 키 없이 3종 전부 켤 수 있다 — `/home/user/kakaotalk-macro/android/auto/java/com/buseong/kakaoauto/License.java`:75
  - 68-79행이 선언한 `lic_ok`(인증여부), `lic_feats`(기능 맵), `lic_lastok`(유예 기준시각)은 전부 평문 Prefs 에 저장되고, 유일한 게이트인 `allowed()`(197-206행)와 `state()`(120-190행)는 이 값들을 **아무 무결성 검증 없이** 그대로 신뢰한다(서버 응답 원문·서명은 버린다). 루팅된 기기에서 `lic_ok=true`, `lic_feats={"macro":{"on":true,"expires_at":9999999999999},...}`, `lic_lastok=now`
  - 수정: 서명이 검증된 응답 원문(features 포함)을 `Prefs.secPut` 으로 봉인해 저장하고 state() 가 그걸 읽게 하거나, 최소한 `HMAC(config_key, lic_ok|lic_feats|lic_lastok|device_id)` 를 같이 저장해 읽을 때 대조해라. config_key 가 없으면 features 는 전부 off 로 취급하는 것도 같이 넣어라(그래야 평문 조작만으로는 아무것도 안 열린다).
- [medium][security] Log.add 에 서버 응답 원문 앞부분(라이선스 키·device_id)이 그대로 찍힌다 — `/home/user/kakaotalk-macro/android/auto/java/com/buseong/kakaoauto/License.java`:816
  - 784·801·816행이 `snippet(r.raw)` / `snippet(raw)` 로 응답 원문 앞 120자를 사용자 로그(Log.add → SharedPreferences 평문 저장 + android.util.Log.i 로 logcat)에 남긴다. 성공 응답의 JSON 순서는 buildOk(routes/license.js:101-114) 기준 `{"ok":true,"key":"KAKA-....","plan":...,"expires_at":...,"device_id":"..."` 이므로, 200 응답이 서명 파싱/JSON 파싱에
  - 수정: snippet() 에서 `"key":"..."`, `"config_key":"..."`, `"session":"..."` 를 마스킹하거나(정규식 치환), 실패 로그에는 원문 대신 길이·HTTP 코드·파싱 실패 지점만 남겨라.
- [medium][security] 인증 없는 주문 생성 폭주로 금액 뒷자리 풀(1~99)을 고갈시켜 자동 입금확인을 마비시킬 수 있다 — `/home/user/kakaotalk-macro/lib/keys.js`:210
  - `POST /api/order`(routes/purchase.js:62)는 인증이 없고 분당 30회 리밋만 있다. pickAmount(lib/keys.js:210-224)는 같은 base 금액의 pending 주문과 겹치지 않는 suffix 를 1~99 중에서 고르는데, 주문은 만료·정리되지 않으므로(pending 주문을 지우는 코드가 어디에도 없다) 공격자가 같은 상품 조합으로 99건만 넣어두면 이후 정상 주문은 `suffix=0 + needs_review`(219행)로 떨어진다. 그러면 같은 금액의 pending 주문이 2건 이
  - 수정: pending 주문에 TTL 을 둬라(예: 생성 후 48시간이면 자동 canceled — 입금 훅 조회와 pickAmount 에서 제외). 여기에 IP/일 단위 주문 생성 상한(예: 10건)과, 같은 IP 가 pending 을 여러 건 쥐고 있으면 거부하는 검사를 추가해라. pickAmount 의 SELECT 는 같은 트랜잭션에서 `FOR UPDATE` 나 advisory lock 으로 잡아 동시 주문의 suffix 중복도 막아라.
- [medium][security] 관리자앱이 x-admin-password 를 붙인 채 리다이렉트를 자동 추종하고, 비밀번호를 평문 Prefs 에 저장한다 — `/home/user/kakaotalk-macro/android/admin/java/com/buseong/kakaoadmin/Api.java`:497
  - exec()는 497행에서 `conn.setInstanceFollowRedirects(true)` 를 켜고 498행에서 `x-admin-password` 헤더를 붙인다. HttpURLConnection 은 리다이렉트 시 요청 헤더를 다음 URL 로 그대로 다시 보내므로, 서버 주소가 잘못 입력됐거나(normBase 130-138행은 스킴이 없으면 https 를 붙여주지만 사용자가 `http://` 를 직접 넣으면 그대로 받는다) 중간에서 302 를 끼워 넣을 수 있는 상황이면 **관리자 비밀번호가 제3자 호스트로 전송**된다. 그 
  - 수정: 인증 헤더가 붙는 요청은 `setInstanceFollowRedirects(false)` 로 두고 3xx 는 에러로 처리해라. normBase 에서 `http://` 는 거부(또는 경고)해라. 저장할 땐 AndroidKeyStore 로 감싸라 — 사용자앱 Keystore.java 와 같은 방식을 그대로 재사용하면 된다.
- [medium][security] 변조 탐지 결과를 audit 로만 올리고, SPEC 6.3 이 요구한 '심한 경우 앱이 스스로 잠긴다'가 어디에도 구현돼 있지 않다 — `/home/user/kakaotalk-macro/android/auto/java/com/buseong/kakaoauto/Device.java`:157
  - tamperFlags()(157-182행)는 debuggable·debugger·installer·emulator·source_path·split 를 모아서 문자열로 주고, License.common()(672행 부근)이 요청에 실어 보내고, 서버는 routes/license.js:151-155 에서 audit(`tamper`) 로 기록만 한 뒤 그대로 통과시킨다. 앱 쪽에도 이 플래그를 근거로 기능을 잠그는 코드가 없다(`tamperFlags` 를 읽는 곳은 License.common 뿐). SPEC 6.3 은 '…를 tamper
  - 수정: 심각 플래그(debugger, source_path, split, 또는 debuggable)를 하나라도 만나면 License.state 가 locked=true/reason="tamper" 를 반환하도록 하고, Gate 가 전용 안내창을 띄우게 해라. 오탐이 걱정되면 서버가 응답으로 `tamper_action:"lock"|"warn"` 을 내려 원격에서 강도를 조절할 수 있게 하는 편이 안전하다(오탐 시 즉시 완화 가능).
- [low][security] /api/lookup 이 SPEC 5장이 허용한 범위(기능·만료일·기기등록여부)보다 많은 정보를 키만 알면 내준다 — `/home/user/kakaotalk-macro/routes/purchase.js`:195
  - SPEC 5장은 `/api/lookup` 을 '키 소유 증명 없이 민감정보 노출 금지: 기능/만료일/기기등록여부만' 으로 못박았다. 구현(195-208행)은 device_id·session·config_key·note 를 내보내지 않는 점은 규격대로 지켰지만, `activated_at`(202행)과 `reset_count`(203행)를 추가로 노출한다. 키 문자열만 입수한 제3자가 해당 키의 사용 시작 시각과 기기 초기화 이력까지 알 수 있다(운영상 남용 추적용 값이라 관리자 화면에만 있어야 한다).
  - 수정: 응답에서 activated_at·reset_count 를 빼거나(화면에 꼭 필요하면 `device_registered` 처럼 boolean 으로 뭉개서), /admin/license 쪽에만 남겨라.
- [low][security] 지연 발송(트리거 최대 60초 · 자동응답 최대 120초) 예약분은 발사 시점에 게이트를 다시 확인하지 않는다 — `/home/user/kakaotalk-macro/android/auto/java/com/buseong/kakaoauto/Trigger.java`:182
  - Trigger.onMessage 는 113행에서 License.allowed(MACRO) 를 통과한 뒤 182행의 지연 Runnable 안에서 KakaoListener.sendTo 를 바로 호출한다. AutoReply 도 같은 구조다(AutoReply.java:68 게이트 → 134-141행 지연 발송). 예약 후 실제 발송 사이(트리거 ≤60초, 자동응답 ≤120초)에 heartbeat 가 `session_superseded`/`expired` 를 받아 잠기더라도 그 건은 그대로 나간다. 창이 짧아 악용 가치는 낮지만, '모든 발
  - 수정: 지연 Runnable 첫 줄에 `if (!License.allowed(c, Features.MACRO)) { Log.add(c, "...기능이 꺼져서 예약 발송을 취소했어"); return; }` 를 넣어라. MiniGame/RoomBot 의 지연 발송 경로도 같이 손봐라.
- [medium][protocol] 재인증과 하트비트가 겹치면 정상 인증 직후 스스로 session_superseded 로 잠긴다 — `android/auto/java/com/buseong/kakaoauto/License.java`:562
  - applyFail 은 session_superseded 를 받으면 시점을 따지지 않고 K_LOCKED=true, K_SESSION="" 를 박는다(562~578행). /verify 는 매번 세션을 회전시키므로(routes/license.js:215~217), 만료·유예초과 상태에서 Scheduler.kickHeartbeat 가 띄운 하트비트가 날아가 있는 동안 사용자가 잠금화면에서 '인증하기'를 누르면(MainActivity.java:238) 구 세션 하트비트의 응답이 늦게 도착해 session_superseded 가 된다. 그 응
  - 수정: 하트비트 요청을 보낸 시각을 들고 있다가, 응답 처리 시점에 K_LASTOK 이 그 시각보다 최신이면(그 사이 verify 가 성공했으면) session_superseded 를 무시하라. 또는 activate 진행 중(ACTIVATING=true)에는 하트비트 실패 반영을 건너뛰어라.
- [low][protocol] 설정 클라우드 백업(/config)이 서버에만 있고 앱에 클라이언트가 없다 — `routes/license.js`:309
  - POST/GET /config 가 구현돼 있고(309~351행) 관리자 상세 응답도 config rev/updated_at 을 보여주는데(routes/admin.js:141~145), android/auto 전체에서 이 경로를 부르는 코드가 없다(그랩 결과 0건 — Keystore 의 ck_blob 은 로컬 저장용이다). SPEC 3.4 가 '선택'이라 계약 위반은 아니지만, 그 결과 기기 교체·재설치 시 복구 경로가 0이 된다(설정은 config_key 로 암호화돼 있어 기기 초기화하면 통째로 날아간다). 관리자 화면에는 항상 백
  - 수정: Settings.save 성공 시 Prefs.secGet 로 만든 암호문을 그대로 POST /config 로 올리고, 재인증 직후 GET /config 로 rev 가 더 크면 복원하는 코드를 ScreenAccount 에 [설정 백업/복원] 로 붙여라. 안 쓸 거면 서버 라우트와 관리자 표시를 함께 지워 계약을 정리해라.
- [low][protocol] 라이선스 키가 GET 쿼리스트링으로 전송돼 접근 로그에 남는다 — `routes/license.js`:287
  - /entitlements 는 key 를 쿼리로 받는다(287행, 앱도 License.java:365~370 에서 ?key= 로 붙인다). HTTPS 라 전송 중 노출은 없지만 Render/프록시 액세스 로그·에러 리포트에 라이선스 키와 device_id 가 평문으로 축적된다. SPEC 3.3 이 그 형태를 적어둔 탓이지만, 키는 결제 자산이라 로그에 남기지 않는 게 맞다.
  - 수정: POST /entitlements 를 추가(기존 GET 은 하위호환으로 유지)하고 앱은 POST 로 보내라. 최소한 서버에서 morgan 류 로깅을 쓸 때 쿼리를 마스킹해라.
- [low][protocol] 만료 키의 하트비트마다 expired audit 이 쌓여 기록 탭의 위험 신호를 덮는다 — `routes/license.js`:137
  - gate 는 만료된 키에 대해 audit:'expired' 를 돌려주고 /heartbeat·/entitlements 가 매번 기록한다(137행, 264~267행, 297~299행). /admin/audit 기본 limit 은 100 이고 at DESC 정렬이라(routes/admin.js:149~163), 만료 키가 쌓이면 최신 100건이 expired 로 채워져 정작 눈으로 잡아야 하는 mismatch·takeover·bad_sig·tamper 가 밀려난다.
  - 수정: expired 는 키별로 하루 1건만 남기거나(직전 동일 kind/key 기록이 N시간 내면 skip) 아예 기록하지 말고, 관리자앱 기본 필터를 ALERT_KINDS 로 시작하게 해라.
- [medium][runtime] Settings 캐시가 UI 스레드와 리스너·알람 스레드 사이에 공유돼 발송 주기가 통째로 유실될 수 있다 — `android/auto/java/com/buseong/kakaoauto/Settings.java`:439
  - Settings.load() 는 static `cached` 인스턴스를 그대로 돌려주고(456-457행), 그 안의 ArrayList 들(macro.rooms, macro.images, triggers, roombot.banWords/adminNames)은 동기화 없이 여러 스레드에서 동시에 읽고 쓴다. 쓰기: Nav.chipEditor 의 `items.remove(v)` (Nav.java:562) 와 ScreenMacro.java:430 `s.macro.images.remove(uri)` 가 메인 스레드에서 리스트를 **줄인다**
  - 수정: 엔진(Scheduler/Trigger/RoomBot/MiniGame)이 리스트를 쓰기 전에 스냅샷을 뜬다(`new ArrayList<>(m.rooms)`) — 순회 중 변경에서 완전히 분리된다. 또는 Settings.load() 가 엔진용으로는 불변 복사본을 돌려주고, 화면은 편집용 사본을 받아 save() 때 교체하도록 바꾼다.
- [medium][runtime] Log.add 가 매 줄마다 동기 commit() 을 하면서 클래스 락을 잡아 메인 스레드를 세운다 — `android/auto/java/com/buseong/kakaoauto/Log.java`:107
  - add() 는 `static synchronized` 인데(26행) 안에서 save() 가 200줄 링버퍼 전체를 문자열로 이어붙여 `Prefs.sp(c).edit().putString(...).commit()` 으로 **동기** 디스크 쓰기를 한다(100-108행). Scheduler.work() 는 방 하나당 최대 2~3줄을 남기므로 방 20개면 한 주기에 25번쯤 commit 이 돌고, 그 사이 메인 스레드가 Log.add(버튼 동작·토스트·화면 갱신 경로에서 상시 호출)를 부르면 같은 Log 클래스 모니터에서 블로킹된다. 알
  - 수정: 정상 로그는 apply() 로 바꾸고(크래시 직후 보존이 필요한 App.record 경로만 commit 유지), 저장을 디바운스한다(예: 마지막 add 후 1초 뒤 한 번만 save, 또는 add 10줄마다). 메모리 링버퍼 추가는 락 안에서 하고 디스크 쓰기는 락 밖 전용 스레드로 내보낸다.
- [medium][runtime] 썸네일 비트맵 디코딩을 메인 스레드에서 해서 매크로 탭 진입·onResume 마다 멈춘다 — `android/auto/java/com/buseong/kakaoauto/Nav.java`:983
  - Nav.thumb() 은 화면 조립 도중 ImagePicker.thumb() 을 그 자리에서 호출한다. thumb() 은 ContentResolver.openInputStream 을 **두 번**(경계 측정용 + 실제 디코딩용) 열고 BitmapFactory.decodeStream 을 돌린다(ImagePicker.java:186-214). 첨부 최대 5장이면 사진 제공자 IPC 10회 + 디코딩 5회가 전부 메인 스레드에서 일어난다. 게다가 MainActivity.onResume 은 renderShell() 로 화면을 매번 통째로 
  - 수정: 썸네일은 자리표시자를 먼저 붙이고 백그라운드 스레드(또는 KakaoListener.post)로 디코딩한 뒤 main Handler 로 setImageBitmap 한다. 디코딩 결과는 URI 키로 작은 LruCache 에 담아 재진입 때 재사용한다.
- [medium][runtime] 이미지 전송이 실패하는 핵심 원인을 Log.add(null, ...) 로 남겨서 사용자가 볼 수 없다 — `android/auto/java/com/buseong/kakaoauto/KakaoAccessibility.java`:142
  - arm() 에서 접근성 서비스 인스턴스가 아직 안 붙었을 때 `Log.add(null, "접근성 서비스가 아직 안 붙었어 — 공유창을 자동으로 못 누를 수 있어")` 를 호출한다. Log.add 는 Context 가 null 이면 android.util.Log 에만 찍고 `if (c == null) return;` 으로 링버퍼 저장을 건너뛴다(Log.java:30). 즉 내정보 탭의 활동 로그에 이 줄이 절대 남지 않는다. 사용자가 보게 되는 건 40초 뒤 ImageSender 의 "이미지 전송 시간 초과" 뿐이어서 원인(접근성 서
  - 수정: arm() 에 Context 를 넘기거나 App.app() 을 써서 로그를 남긴다. 아울러 Log.add 가 c==null 일 때 App.app() 으로 폴백하도록 하면 같은 실수를 전역에서 막을 수 있다.
- [medium][runtime] 설정키가 없는데도 캐시를 먼저 갈아치워 저장되지 않은 설정이 저장된 것처럼 동작한다 — `android/auto/java/com/buseong/kakaoauto/Settings.java`:495
  - save() 는 첫 줄에서 `cached = this;` 를 하고(495행) 그 다음에 `if (!Prefs.secReady(c))` 로 저장 가능 여부를 본다(497-500행). 설정키가 없으면 로그 한 줄만 남기고 return 하는데, 캐시는 이미 새 값으로 바뀌어 있다. 그래서 (1) 화면은 수정이 반영된 것처럼 보이고 ScreenMacro.apply 는 예외가 없으니 토스트도 띄우지 않으며(ScreenMacro.java:1142-1149), (2) Scheduler 는 캐시의 `macro.enabled=true` 를 읽고 알
  - 수정: secReady 검사를 캐시 대입보다 먼저 하고, 저장 불가면 캐시를 건드리지 않은 채 false 를 돌려준다. save() 가 boolean 을 반환하게 바꿔 apply()/화면이 실패를 토스트로 알리게 한다.
- [medium][runtime] http:// 서버 주소를 받아주지만 targetSdk 34 평문 차단으로 무조건 no_network 가 된다 — `android/auto/java/com/buseong/kakaoauto/License.java`:257
  - setServer() 는 http:// 로 시작하는 주소를 정상으로 받아 저장한다. 그런데 auto/AndroidManifest.xml 에 `android:usesCleartextTraffic` 도 networkSecurityConfig 도 없고 targetSdkVersion=34 이므로 평문 HTTP 는 플랫폼이 막는다. http() 에서 openConnection 이 SecurityException/IOException 으로 떨어지고 verify() 가 이를 "no_network"("서버에 연결 못 했어") 로만 보고한다(Lic
  - 수정: 둘 중 하나로 통일한다. (a) setServer 에서 http:// 를 거부하고 "https 만 쓸 수 있어" 라고 안내한다(권장 — 라이선스 응답이 평문으로 나가면 안 된다), 또는 (b) 디버그용으로만 허용하려면 매니페스트에 networkSecurityConfig 를 넣어 특정 도메인만 cleartextTrafficPermitted 로 열고 UI 에 그 사실을 명시한다.
- [low][runtime] count() 가 자정 리셋을 반영하지 않아 로그에 어제 숫자가 찍힌다 — `android/auto/java/com/buseong/kakaoauto/AutoReply.java`:162
  - onDirectMessage 의 발송 성공 로그가 `"(오늘 " + count() + "개)"` 를 쓰는데(138행) count() 는 rollDay() 를 부르지 않고 static sentToday 를 그대로 돌려준다(162-164행). 자정을 넘긴 첫 응답은 synchronized 블록 안에서 rollDay 로 0 → 1 이 되므로 실제 카운터는 맞지만, 발송이 랜덤 지연(delayMaxMs, 기본 30초) 뒤에 실행되는 사이에 날짜가 넘어가면 count() 가 리셋 전 값을 읽어 로그 숫자가 어긋난다. today(Context
  - 수정: count() 를 `today(c)` 처럼 rollDay(System.currentTimeMillis()) 를 먼저 부르게 통일하거나, 로그 문구에서 count() 대신 today(c) 를 쓴다.
- [low][runtime] HTC 빠른부팅 액션이 코드에만 있고 매니페스트 intent-filter 에 없어 절대 도달하지 않는다 — `android/auto/java/com/buseong/kakaoauto/AlarmReceiver.java`:113
  - isBoot() 는 ACTION_QUICKBOOT_HTC("com.htc.intent.action.QUICKBOOT_POWERON") 를 부팅으로 인정하고 28행에 상수까지 두었지만, auto/AndroidManifest.xml 의 AlarmReceiver intent-filter 에는 BOOT_COMPLETED / android.intent.action.QUICKBOOT_POWERON / MY_PACKAGE_REPLACED 세 개만 등록돼 있다. 해당 기기에서는 이 브로드캐스트가 리시버까지 오지 않으므로 분기 자체가 죽은 코드다(
  - 수정: 매니페스트 intent-filter 에 <action android:name="com.htc.intent.action.QUICKBOOT_POWERON" /> 를 추가하거나, 지원하지 않기로 정했다면 AlarmReceiver 의 상수와 분기를 지운다.
- [medium][ux] 구매 유도 모달이 탭 진입·앱 복귀마다 반복해서 뜨고, 화면 안내와 이중으로 겹친다 + 로그 링버퍼를 오염시킨다 — `/home/user/kakaotalk-macro/android/auto/java/com/buseong/kakaoauto/ScreenMacro.java`:47
  - ScreenMacro.build():47 과 ScreenBot.build():50 이 Gate.check() 를 부른다. MainActivity.onResume():73-81 → renderShell():104-135 → Nav.go(keep) → build() 이므로, 기능이 꺼진 탭에 머무는 동안 앱을 복귀할 때마다(구매 페이지 브라우저에서 돌아올 때 포함) 모달이 다시 뜬다. 게다가 같은 화면 아래에는 이미 fillLocked()(ScreenMacro.java:103-120)가 같은 설명 + [구매하기] 버튼을 그리고 있어 안
  - 수정: 화면 진입(build/refresh)에서는 Gate.check 를 부르지 말고 fillLocked() 의 인라인 안내만 쓰라. Gate.check 는 사용자가 실제로 동작을 실행하려 할 때(발송 버튼, 토글 켜기 등)만 호출한다. 차단 로그도 실행 시도에서만 남기고, 화면 조회 때는 Log.add 를 하지 마라.
- [medium][ux] "지금 사진만 보내기" 가 첫 번째 방에만 보내는데 UI 어디에도 그 말이 없다 — `/home/user/kakaotalk-macro/android/auto/java/com/buseong/kakaoauto/ScreenMacro.java`:479
  - sendImagesNow():479 는 final String room = s.macro.rooms.get(0); 으로 대상 방 목록의 첫 항목만 고른다. 버튼 라벨(406)은 "지금 사진만 보내기", 완료 토스트(487)는 "사진 전송을 끝냈어. 카톡에서 확인해줘" 라서, 대상 방을 5개 등록한 사용자는 5개 방에 다 갔다고 믿는다. 실제로 어느 방에 갔는지는 로그(482)에만 남는다. 요구 (4) 이미지 5장 첨부 기능의 수동 경로가 사용자 기대와 다르게 동작한다.
  - 수정: 둘 중 하나로 정리하라. (a) 버튼 라벨/토스트에 방 이름을 박는다: "「" + room + "」에 사진 보내기" 로 바꾸고 완료 토스트에도 방 이름을 넣는다. (b) rooms 를 순회하며 ImageSender.send 를 큐에 넣고(ImageSender 는 이미 대기열이 있다) 진행 상황을 "n/m 방" 으로 보여준다. 방이 2개 이상일 때는 Nav.choose 로 어느 방에 보낼지 고르게 하는 것도 방법이다.
- [medium][ux] 수동 발송이 방해금지 시간·하루 한도를 무시하면서 한도 카운터는 올린다 — `/home/user/kakaotalk-macro/android/auto/java/com/buseong/kakaoauto/ScreenMacro.java`:166
  - sendNow():166-203 은 라이선스·대상 방·메시지 유무만 보고 바로 보낸다. Scheduler.work() 가 지키는 m.inQuiet(now)(Scheduler.java:236)와 m.dailyLimit(Scheduler.java:243)를 여기서는 전혀 확인하지 않는다. 그런데 190 행에서 MainActivity.countSent(a, ok) 로 카운터는 올린다. 결과: 사용자가 "하루 최대 발송 200건", "방해금지 22:00~07:00" 을 걸어놨어도 수동 버튼은 새벽에 한도 초과 상태로 계속 발송되고, 그 발
  - 수정: sendNow 진입부에서 Settings.Macro.inQuiet(now) 와 dailyLimit 를 확인하라. 방해금지/한도에 걸리면 바로 보내지 말고 Nav.confirm 으로 "지금은 방해금지 시간이야(또는 하루 한도 초과). 그래도 보낼까?" 를 물어 사용자가 의식적으로 넘기게 하고, 그 선택을 Log.add 에 남겨라.
- [medium][ux] 한 화면 카드 수가 SPEC 한도(4~6개)를 넘는다 — 매크로 8개, 내정보 7개 — `/home/user/kakaotalk-macro/android/auto/java/com/buseong/kakaoauto/ScreenMacro.java`:89
  - SPEC 8.1 UI 원칙은 "한 화면에 카드 4~6개 이하" 다. fill():89-100 은 autoCard + messageFold + roomsFold + cycleFold + imageFold + triggerFold + replyFold + limitFold = 카드 8개를 세로로 쌓는다. ScreenAccount.fill():62-81 도 licenseCard + featureCard 3개 + deviceCard + advFold + logFold = 7개다. 접혀 있어 덜 답답하긴 하지만, 첫 화면에 동일한 생김새의 
  - 수정: 매크로 화면을 2단으로 나눠라. 1단 = 자동발송 카드 + "발송 내용"(메시지·방·주기를 카드 하나 안의 3줄 actionRow 로 합침), 2단 = "추가 기능" 4개를 Nav.actionRow 목록(제목 + 현재값 + ›)으로만 보여주고 탭하면 그 기능만 있는 하위 화면/다이얼로그로 들어가게 한다. 내정보도 기능 카드 3개를 featureCard 대신 한 카드 안의 3줄 요약으로 압축하면 카드 수가 한도 안으로 들어온다.
- [medium][ux] 접근성 정보가 앱 전체에 0건 — 커스텀 토글의 켜짐/꺼짐, 썸네일 삭제 버튼을 스크린리더가 읽을 수 없다 — `/home/user/kakaotalk-macro/android/auto/java/com/buseong/kakaoauto/Ui.java`:256
  - auto 패키지 전체에 setContentDescription 호출이 하나도 없다(grep 결과 0건). 문제가 되는 지점: (1) Ui.switchRow():256-404 는 Switch 위젯이 아니라 View 두 개로 만든 커스텀 토글이라 상태가 접근성 트리에 전혀 안 실린다 — TalkBack 사용자는 자동발송이 켜졌는지 꺼졌는지 알 수 없다. (2) Nav.toggle():406-412 는 switchRow 에 제목 "" 을 넘겨 라벨조차 없는 무명 컨트롤이다(트리거 목록의 on/off 스위치가 전부 이것). (3) Nav.
  - 수정: switchRow 루트에 setContentDescription(title + ", " + (on ? "켜짐" : "꺼짐")) 을 붙이고 paintSwitch 에서 상태가 바뀔 때마다 갱신하라(가능하면 AccessibilityNodeInfo 의 checkable/checked 를 채우는 AccessibilityDelegate 추가). Nav.toggle 에는 호출부에서 받은 이름을 contentDescription 으로 넘기게 시그니처를 고쳐라. Nav.thumb 박스에는 "첨부 사진 n번째, 탭하면 삭제" 를 붙이고 ✕ TextV
- [medium][ux] 방·금지어 칩과 사진 썸네일이 한 번 탭으로 즉시 삭제된다 (확인·되돌리기 없음, 칩 터치영역 36dp) — `/home/user/kakaotalk-macro/android/auto/java/com/buseong/kakaoauto/Nav.java`:514
  - removableChip():514-528 은 minimumHeight 를 36dp(520)로 잡아 권장 48dp 미달인데, 이게 대상 방을 지우는 유일한 수단이다(ScreenMacro.roomsFold 안내문: "칩을 누르면 지워진다"). chipEditor():558-567 은 탭 즉시 items.remove(v) → 저장까지 해버려 취소가 불가능하다. Nav.thumb():1018 도 같은 방식으로 첨부 사진이 탭 한 번에 사라지고 URI 영속 권한까지 release 된다(ScreenMacro.java:431). 방 이름 목록
  - 수정: 칩·썸네일의 삭제 히트영역을 오른쪽 ✕ 영역으로 한정하고 최소 48dp 를 확보하라. 삭제 후에는 되돌릴 방법을 줘라 — Ui.toast 대신 "「방이름」 지웠어 · 되돌리기" 를 짧게 띄우는 인라인 되돌리기 줄을 카드 안에 넣거나, 최소한 Nav.confirm 으로 한 번 묻는다. 사진 썸네일은 탭=미리보기, ✕=삭제로 분리하는 편이 낫다.
- [medium][ux] onResume 마다 화면 전체를 다시 만들어서, 잠금화면에 입력 중이던 키가 날아가고 스크롤이 맨 위로 튄다 — `/home/user/kakaotalk-macro/android/auto/java/com/buseong/kakaoauto/MainActivity.java`:73
  - onResume():73-81 이 조건 없이 renderShell() 을 부르고, renderShell():115 는 root.removeAllViews() 로 뷰 트리를 통째로 버린 뒤 buildLock() 또는 Nav.go(keep) 로 새로 만든다. buildLock():192-199 의 키 입력칸은 s.key(=인증 성공 후에만 채워지는 값)로만 초기화되므로, 사용자가 키를 손으로 입력하다 카톡/메모 앱으로 키를 확인하러 갔다 돌아오면 입력값이 전부 사라진다. 인증된 상태에서도 탭 화면이 매번 재생성되어 스크롤 위치가 초기화
  - 수정: renderShell 은 라이선스 상태(licensed/locked)가 바뀐 경우에만 전체 재빌드하고, 그렇지 않으면 Nav.reload()(제자리 갱신)만 호출하라. 잠금화면은 EditText 의 텍스트를 onSaveInstanceState 또는 Prefs 임시값에 담아 복원하고, 재빌드가 불가피하면 ScrollView 의 scrollY 를 저장·복원해라.
- [medium][ux] 설정 저장이 조용히 실패해도 화면은 저장된 것처럼 보인다 (설정키 없을 때) — `/home/user/kakaotalk-macro/android/auto/java/com/buseong/kakaoauto/ScreenMacro.java`:1142
  - Settings.save():493-500 은 Prefs.secReady(c) 가 false 면 Log.add 만 남기고 조용히 return 한다(예외를 던지지 않는다). 반면 ScreenMacro.apply():1142-1149 는 try/catch 로 예외만 감시하므로 이 경우를 전혀 감지하지 못하고 토스트도 안 띄운다. 게다가 save() 는 반환 전에 cached = this 를 해두기 때문에(494) 화면을 다시 그려도 방금 입력한 값이 그대로 보인다 → 사용자는 저장됐다고 믿지만 앱을 재시작하면 전부 사라진다. 화면 상단
  - 수정: Settings.save() 가 성공/실패(boolean 또는 실패 사유 문자열)를 반환하게 고치고, apply()/save() 호출부에서 false 면 Ui.toast("설정을 저장하지 못했어 — 라이선스 인증부터 해줘") 를 띄운 뒤 화면을 다시 그리지 말고 편집 전 값으로 되돌려라. canSave() 가 false 인 동안에는 편집 버튼/토글 자체를 setEnabled(false) + alpha 로 잠그는 편이 더 정직하다.
- [medium][ux] 봇 세그먼트가 두 기능의 구매/만료 상태를 전혀 표시하지 않는다 — 요구 (3)의 "켜짐 표시"가 봇 화면에서 빠졌다 — `/home/user/kakaotalk-macro/android/auto/java/com/buseong/kakaoauto/ScreenBot.java`:118
  - 요구사항 (3)은 "앱에서 어떤 기능이 켜져있는지 표시" 다. 홈(MainActivity.fillHome:345-359)과 내정보(ScreenAccount.fill:64-72)는 featureCard 로 사용중/D-N/미구매를 잘 보여주는데, 실제로 두 봇을 오가는 지점인 ScreenBot.segment():118-157 은 "방 관리봇 / 미니게임봇" 텍스트만 그린다. 어느 쪽이 잠겼는지 알 방법이 없어서, 사용자는 세그먼트를 눌러 모달(gate:75-77)을 맞고 나서야 그 기능이 꺼져 있음을 안다. 만료 임박(D-3) 같은 정
  - 수정: 세그먼트 라벨 옆에 작은 상태 점/칩을 붙여라 — License.allowed 면 Theme.ACCENT 점, expiringSoon 이면 Theme.AMBER, 꺼져 있으면 Theme.DIM 자물쇠 글리프. 세그먼트 텍스트에도 contentDescription 으로 "미니게임봇, 미구매" 를 넣고, 꺼진 세그먼트를 눌렀을 때는 모달 대신 그 자리에 잠금 카드(fillLocked)만 보여주면 된다.
- [medium][ux] 앱의 [초기화 요청하기] 버튼이 열어주는 /my 페이지에 실제로 요청할 수단이 없다 (1키 1기기의 유일한 탈출구) — `/home/user/kakaotalk-macro/public/my.html`:55
  - 요구 (1) 키 1개 = 기기 1대 규칙의 구제 경로는 앱 잠금화면 버튼 "초기화 요청하기"(MainActivity.java:262-266)와 내정보 카드 "기기 초기화 요청"(ScreenAccount.java:203-207)이고, 둘 다 Gate.openMy → /my 로 보낸다. 그런데 my.html:55-61 의 "기기를 바꿨다면" 카드는 설명문 3줄뿐이고 폼도, 링크도, mailto/카톡 링크도 없다. 최선의 안내가 my.html:61 "관리자 연락처는 구매할 때 안내받은 곳으로 문의해줘" 이며, CONTACT_INFO 환경
  - 수정: /my 의 조회 결과 아래에 "기기 초기화 요청" 폼을 붙여라(키 + 연락처 + 사유 → POST, 관리자앱의 기록 탭/주문 탭에 대기 항목으로 뜨게). 서버 작업이 부담이면 최소한 CONTACT_INFO 를 tel:/mailto:/오픈채팅 링크로 렌더해 한 번 탭으로 연락이 가게 하고, 연락처가 없으면 "구매 안내 메시지의 연락처로 문의" 대신 주문번호 조회 링크라도 제공해라.
- [medium][ux] 웹 문구는 "관리자가 수동 발급" 이라고 하는데 서버는 자동 발급이 기본이다 — 구매자가 기다릴 이유가 없는데 기다린다 — `/home/user/kakaotalk-macro/public/index.html`:43
  - index.html:43 "입금 확인 뒤 관리자가 키를 발급해", index.html:68 "입금이 확인되면 관리자가 키를 발급해", index.html:107 FAQ "무통장 입금이라 자동은 아니야", buy.html:36, order.html:55 "입금 확인은 사람이 직접 해" 가 모두 수동 발급을 전제한다. 실제로는 routes/purchase.js:336 에서 DEPOSIT_AUTO_APPROVE 기본 '1' 이라 금액(주문별 고유 뒷자리)이 맞으면 즉시 키가 발급되고, buy 결과 화면(app.js:909-911)은 "끝
  - 수정: 한쪽으로 통일하라. 자동 승인을 쓰는 게 맞으니 index/buy/order 문구를 "입금하면 보통 1분 안에 자동으로 키가 발급돼. 금액이 다르면 자동 확인이 안 되고 관리자가 직접 확인해" 로 바꾸고, FAQ 도 같은 내용으로 고쳐라. DEPOSIT_TOKEN 미설정(웹훅 비활성)일 때만 수동 문구가 보이도록 /api/price 응답에 auto_approve 플래그를 실어 프론트에서 분기하는 것이 가장 정확하다.
- [medium][ux] 사용자앱 다이얼로그가 자기 res 의 AppDialog 스타일을 안 쓴다 (styles.xml 주석은 쓴다고 적혀 있음) — 관리자앱과 톤이 갈린다 — `/home/user/kakaotalk-macro/android/auto/java/com/buseong/kakaoauto/Ui.java`:439
  - android/auto/res/values/styles.xml:23 주석은 "다이얼로그용 (Ui.dialog 이 이 스타일로 AlertDialog 를 만든다)" 이고 24행에 AppDialog 스타일이 정의돼 있다(R.java 에도 AppDialog=0x7f040000 로 생성됨). 그런데 Ui.java:439 는 new AlertDialog.Builder(c, android.R.style.Theme_Material_Dialog_Alert) 로 플랫폼 기본 다크 다이얼로그를 쓰고, 색은 showDark():548-575 에서 사후에
  - 수정: Ui.dialog 를 관리자앱과 동일하게 고쳐라 — R.style.AppDialog(또는 getResources().getIdentifier 로 조회)로 Builder 를 만들고, 조회 실패 시에만 android.R.style.Theme_Material_Dialog_Alert 로 폴백한다. 스타일에 windowBackground 라운드 드로어블을 넣어두면 showDark 의 사후 덧칠 의존도도 줄어든다.
- [low][ux] Theme 에 여백 토큰이 없어 화면 코드가 dp 숫자를 22종 하드코딩한다 — `/home/user/kakaotalk-macro/android/auto/java/com/buseong/kakaoauto/Theme.java`:37
  - Theme 는 색(15-35)과 라운드(R_SM~R_XL, 37-41)만 토큰화했고 여백 스케일이 없다. 그래서 화면 코드가 Theme.dp(c, n) 에 생짜 숫자를 박는다 — 전체에서 1,2,3,4,5,6,7,8,9,10,12,13,14,16,18,20,22,28,36,40,44,48,52,54,56,72,92,96,200 처럼 22종 이상의 값이 쓰이고, 호출 횟수만 Nav.java 60곳, Ui.java 31곳, MainActivity 19곳, ScreenMacro 15곳이다. Theme.java:9 주석이 "화면 코드에 색
  - 수정: Theme 에 S_1=4, S_2=8, S_3=12, S_4=16, S_5=20, S_6=24 같은 4dp 배수 스케일과 자주 쓰는 TAP=48, GAP=12 를 상수로 추가하고, 화면 코드의 dp 숫자를 그 토큰으로 바꿔라. 4의 배수에서 벗어난 값(3,5,7,9,13)은 이 기회에 정리한다.
- [low][ux] 미니게임 명령어 표의 명령 칸이 92dp 고정폭 + singleLine + ellipsize 없음 → 접두사가 길면 명령어가 잘려 보인다 — `/home/user/kakaotalk-macro/android/auto/java/com/buseong/kakaoauto/ScreenBot.java`:600
  - addCmd():588-609 는 명령 텍스트 TextView 에 setSingleLine(true)(599)만 걸고 ellipsize 를 주지 않은 채 폭을 Theme.dp(a, 92) 로 고정한다(600-601). 접두사는 최대 3글자까지 허용되므로(editPrefix:654) "!!!가위바위보" 같은 값이 가능하고, 13sp MONOSPACE BOLD 로 92dp 안에 들어가지 않는다. ellipsize 가 없으면 말줄임표도 없이 글자가 그냥 잘려서, 사용자가 방에 쳐야 할 명령을 이 표에서 정확히 읽을 수 없다(이 표가 명령
  - 수정: 고정폭을 버리고 wrap_content + 오른쪽 마진으로 두거나, 유지하려면 최소 setEllipsize(TruncateAt.END) 를 붙이고 폭을 dp(110) 이상으로 올려라. 더 나은 방법은 명령 칸을 눌러 클립보드로 복사되게 하는 것(Nav.copy)이다 — 사용자가 손으로 옮겨 적지 않아도 된다.
- [low][ux] .grid.g2 브레이크포인트가 죽어 있어 데스크톱에서도 상품 3카드가 1열로 길게 늘어진다 — `/home/user/kakaotalk-macro/public/style.css`:170
  - style.css:169-172 는 .grid 를 1열로 두고 720px 이상에서 .grid.g2 만 2열로 만든다. 그런데 g2 클래스를 붙이는 곳이 아무 데도 없다 — public/*.html 과 app.js 전체에 "g2" 문자열이 0건이고, 랜딩의 상품 목록은 index.html:55 의 class="grid", 구매 폼의 기능 선택은 buy.html:48 의 class="grid" 다. 결과적으로 이 미디어쿼리는 데드 CSS 이고, 넓은 화면에서 상품 3카드 + FAQ + 설치안내가 한 줄로 길게 쌓여 스크롤이 필요 이상으
  - 수정: index.html:55 의 #prods 에 g2(또는 auto-fit minmax 기반 새 클래스)를 붙여 720px 이상에서 2~3열이 되게 하고, 쓰지 않을 거면 style.css:170-172 를 지워 죽은 규칙을 남기지 마라.
- [low][ux] 사진 고르기를 누를 때마다 "최대 5장까지 고를 수 있어" 토스트가 뜬다 — `/home/user/kakaotalk-macro/android/auto/java/com/buseong/kakaoauto/ScreenMacro.java`:361
  - imageFold 의 pick 버튼(354-369)은 시스템 사진 선택기를 열기 직전 361행에서 매번 Ui.toast 를 띄운다. 같은 정보가 이미 카드 본문(342-343 "최대 5장. 알림 답장으로는 사진을 못 보내서…")에 상설로 적혀 있어서, 사진을 여러 번 고르는 동안 같은 토스트가 반복 노출된다. 게다가 이 토스트는 선택기 화면 위에 겹쳐 떠서 방해가 된다.
  - 수정: 361행 토스트를 지우고, 남은 장수를 버튼 라벨이나 카드 요약에 반영하라(예: "사진 고르기 (3장 더 가능)"). 초과 선택이 실제로 발생했을 때만 onImagesPicked():528-530 의 "최대 5장까지야" 토스트로 알리면 충분하다.
