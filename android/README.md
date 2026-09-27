# 안드로이드 앱 빌드 안내

이 폴더에는 앱 두 개가 들어있다.

| 폴더 | 패키지 | 결과물 | 용도 |
|---|---|---|---|
| `auto/` | `com.buseong.kakaoauto` | `out/KakaoAuto_v2.0.apk` | 사용자앱 (매크로 · 방관리봇 · 미니게임봇) |
| `admin/` | `com.buseong.kakaoadmin` | `out/KakaoAdmin_v2.0.apk` | 관리자앱 (키 · 주문 · 기록 · 설정) |

> ⚠️ **기존 v1.8 / v1.4 사용자에게 배포하기 전에 5장을 먼저 읽어라.**
> 서명키가 달라서 **기존 앱을 삭제해야** v2.0 이 설치되고(설정이 날아간다),
> `ALLOWED_APP_SIGS` 에 **값을 하나라도 넣으면 구버전 사용자 전원이 즉시 잠긴다.**
> 이관 중에는 **비워두는 것**이 유일한 안전한 설정이다 (→ 5-2).

Gradle 도 AndroidX 도 안 쓴다. `aapt2 → javac → d8 → zipalign → apksigner` 를 직접 부른다.
외부 라이브러리 의존성은 **0개**다. (`org.json` 은 안드로이드 내장이라 그냥 쓴다)

---

## 1. 준비물

- **JDK 17 이상** (`javac`, `keytool` 이 PATH 에 있어야 함)
- **안드로이드 SDK** — 아래 두 개만 있으면 된다
  - `platforms;android-34`
  - `build-tools;34.0.0` (더 높은 버전이 있으면 자동으로 최신을 쓴다)
- `zip` 명령

안드로이드 스튜디오가 이미 깔려 있으면 SDK 는 보통 여기 있다.

```bash
# 리눅스
export ANDROID_HOME=$HOME/Android/Sdk
# 맥
export ANDROID_HOME=$HOME/Library/Android/sdk
```

스튜디오 없이 깔고 싶으면 commandline-tools 만 받아서:

```bash
sdkmanager "platforms;android-34" "build-tools;34.0.0"
```

`ANDROID_HOME` 을 안 정해도 `ANDROID_SDK_ROOT`, `~/Android/Sdk`, `~/Library/Android/sdk`,
`/opt/android-sdk` 순서로 알아서 찾아본다. 못 찾으면 어떻게 하라는 안내가 뜬다.

---

## 2. 빌드

```bash
cd android
chmod +x build.sh      # 처음 한 번만

./build.sh auto        # 사용자앱만
./build.sh admin       # 관리자앱만
./build.sh all         # 둘 다 (인자 없으면 이것과 같음)
```

결과물은 `android/out/` 에 생긴다.

```
android/out/KakaoAuto_v2.0.apk
android/out/KakaoAdmin_v2.0.apk
```

버전은 매니페스트에서 직접 읽어온다. 버전을 올리려면
`auto/AndroidManifest.xml` 의 `android:versionCode` / `android:versionName` 을 고치면 파일명도 같이 바뀐다.
(`versionCode` 는 **올릴 때 반드시 숫자를 키워야** 사용자가 덮어쓰기 업데이트를 할 수 있다)

### 깃허브에서 빌드하기

브랜치에 푸시하면 `.github/workflows/build-apk.yml` 이 돌아서 APK 두 개를 만든다.
레포 → **Actions** 탭 → 해당 실행 → 아래 **Artifacts** 에서 `KakaoAuto`, `KakaoAdmin` 을 내려받으면 된다.
수동으로 돌리고 싶으면 Actions 탭에서 **Run workflow** 를 누른다.

---

## 3. 서명키 (중요) — 의도된 트레이드오프

`android/keystore/app.jks` 가 서명키다. **이 파일은 일부러 깃에 커밋해 놨고**,
비밀번호 기본값도 `build.sh` 맨 위(`KS_PASS_DEFAULT`)에 평문으로 있다.

> 서명키가 바뀌면 이미 앱을 깔아둔 사용자는 업데이트를 설치할 수 없다
> ("앱이 설치되지 않았습니다" 오류). 고정 키를 확보하려고 레포에 넣어둔 것이다.

대가는 정확히 이거다:

> **레포를 읽을 수 있는 사람은 정품과 똑같은 서명으로 개조 APK 를 만들 수 있다.**
> 그 APK 의 `app_sig` 는 허용목록 값과 같으니 서버가 통과시키고, 정품 위에 덮어쓰기로도 깔린다.
> 즉 그 사람에게는 **서명 핀닝(4장)이 존재하지 않는다.** → 그래서 **레포를 Private 으로 유지해라.**
> 자세한 내용은 `docs/ANTI_ABUSE.md` 2단.

- 키가 없으면 `build.sh` 가 자동으로 만든다 (RSA 2048 · 10000일 · alias `app` · CN `KakaoMacro`).
- **비밀번호는 환경변수 `KS_PASS` 를 먼저 본다.** 없을 때만 기본값으로 떨어지고,
  기본값을 쓰면 빌드 로그에 "기본 키스토어 비밀번호를 쓰고 있어" 경고가 크게 찍힌다.

```bash
KS_PASS="<진짜 비번>" ./build.sh all
```

- 깃에 키를 올리기 싫으면(= 공개 레포로 전환할 거면) **GitHub Secret** 으로 넘겨라.

```bash
base64 -w0 android/keystore/app.jks     # 맥은 base64 -i android/keystore/app.jks
```

출력값을 레포 → **Settings → Secrets and variables → Actions → New repository secret** 에
이름 `KEYSTORE_B64` 로, 비밀번호를 `KS_PASS` 로 넣어두면 CI 가 그걸 써서 서명한다
(`.github/workflows/build-apk.yml` 이 두 변수를 build.sh 에 넘긴다). 로컬에서도 같은 환경변수를 주면 된다.

```bash
KEYSTORE_B64="$(base64 -w0 keystore/app.jks)" KS_PASS="<진짜 비번>" ./build.sh all
```

### 3-1. 🔐 `app.jks` 를 절대 잃어버리지 마라

잃으면 **다음 버전에서 사용자 전원이 또 앱을 지우고 다시 깔아야 한다** (지금 v1.8→v2.0 에서 겪는 그 일).
레포에 있는 것은 백업이 아니다. 최소 두 군데 더 둬라.

```bash
# 1) 파일 자체를 레포 밖 안전한 곳(암호 관리자 · 외장 디스크 · 개인 클라우드)에 복사
cp keystore/app.jks ~/안전한곳/kakaomacro-app.jks
# 2) base64 한 줄로 만들어 비밀 메모 / GitHub Secret(KEYSTORE_B64)에도 보관
base64 -w0 keystore/app.jks
```

비밀번호(`KS_PASS`)도 같은 곳에 함께 적어둬라. **키만 있고 비번을 모르면 서명할 수 없다.**
복구 테스트도 한 번 해봐라 — 백업만 있으면 이렇게 되살아난다.

```bash
KEYSTORE_B64="$(cat 백업한_base64.txt)" KS_PASS="<비번>" ./build.sh auto
# → 출력된 서명 hex 가 docs/APP_SIGNATURE_HISTORY.md 의 v2.0 값과 같으면 백업이 살아있는 것이다
#    (docs/APP_SIGNATURE.txt 와 비교하면 안 된다 — build.sh 가 방금 그 값으로 덮어써서 항상 같다)
```

### 3-2. 키스토어를 레포에서 빼는 절차 (더 강하게 하려면)

지금 상태(커밋된 키 + 소스에 박힌 기본 비번)는 **레포에 접근할 수 있는 사람에게는 서명 핀닝이 없는 것과 같다.**
그걸 없애려면 키를 레포에서 빼고 **GitHub Secret 에만** 두면 된다. 대가는 "키 백업 책임이 전부 사람에게 온다" 는 것.
`docs/ANTI_ABUSE.md` 2단의 트레이드오프를 먼저 읽고 판단해라.

```bash
cd /path/to/kakaotalk-macro

# 1) 키를 base64 한 줄로 만든다 (개행이 섞이면 CI 에서 디코드가 깨진다)
base64 -w0 android/keystore/app.jks > /tmp/ks.b64     # 맥: base64 -i android/keystore/app.jks > /tmp/ks.b64
wc -c /tmp/ks.b64                                     # 길이가 0 이 아닌지만 확인

# 2) GitHub Secret 2개 등록 (레포 → Settings → Secrets and variables → Actions → New repository secret)
#      KEYSTORE_B64 = /tmp/ks.b64 내용 전체
#      KS_PASS      = 키스토어 비밀번호 (기본값을 쓰고 있었다면 이 기회에 새 비번으로 바꿔라)
#    gh CLI 가 있으면:
gh secret set KEYSTORE_B64 < /tmp/ks.b64
gh secret set KS_PASS                                 # 프롬프트에 비번 입력

# 3) 로컬 백업을 먼저 확보한다 (레포에서 빼면 레포는 더 이상 백업이 아니다)
cp android/keystore/app.jks ~/안전한곳/kakaomacro-app.jks
#    권장 보관 위치: 암호 관리자(1Password·Bitwarden 등)의 파일 첨부 + 외장 디스크 1개.
#    base64 텍스트도 같이 넣고 KS_PASS 를 같은 항목에 적어둬라. 둘이 떨어지면 못 쓴다.
#    클라우드 드라이브에 평문으로 두지 마라 — 그건 레포에 두는 것과 위험이 같다.

# 4) 레포에서 추적 제거 + 무시 등록
git rm --cached android/keystore/app.jks
printf '\nandroid/keystore/*.jks\n' >> .gitignore
git add .gitignore && git commit -m "chore: 키스토어를 레포에서 빼고 Secret 으로 옮김"

# 5) CI 가 Secret 으로 서명하는지 확인 (Actions → 최신 실행 로그)
#    "KEYSTORE_B64 환경변수로 서명키를 복원한다" 가 찍히고
#    "기본 키스토어 비밀번호를 쓰고 있어" 경고가 안 찍혀야 한다.
#    빌드된 APK 의 서명 hex 가 docs/APP_SIGNATURE_HISTORY.md 의 v2.0 값과 같아야 한다.
```

- **4번 이후에도 git 히스토리에는 키가 남아있다.** 레포를 공개로 바꿀 거면 히스토리 정리
  (`git filter-repo` 등)까지 하거나, 그냥 키가 유출된 것으로 보고 **키를 교체**해야 한다.
  교체하면 **사용자 전원이 앱을 지우고 다시 깔아야 한다**(지금 v1.8→v2.0 에서 겪는 그 일) — DEPLOY.md 4장.
- 로컬에서 빌드할 때도 `KEYSTORE_B64` + `KS_PASS` 를 주면 된다(3장 예시). 안 주면 파일이 없어서
  `build.sh` 가 **새 키를 만들어버리고**, 그 APK 는 기존 사용자에게 덮어쓰기 설치가 안 된다. 주의해라.

공개 레포로 전환할 때 순서 요약: Secret 두 개 등록 → 로컬 백업 확인 → `git rm --cached android/keystore/app.jks`
→ `.gitignore` 에 `android/keystore/*.jks` 추가 → (히스토리에 남은 키 정리 또는 키 교체 여부 판단).

---

## 4. 서명 SHA-256 을 서버에 등록하는 절차 (리패키징 방지)

앱은 자기 APK 의 서명 SHA-256 을 계산해서 `/verify`, `/heartbeat`, `/entitlements` 요청마다
`app_sig` 로 같이 보낸다. 서버는 허용목록과 대조해서, 남이 뜯어서 다시 서명한 APK 를
`bad_app_sig` 로 거절한다. **허용목록이 완전히 비어있으면 그냥 통과시켜 주기 때문에(이관 유예)
새 APK 를 배포한 뒤에는 꼭 등록해야 한다.**

### 4-1. 값 확인

빌드가 끝나면 스크립트가 마지막에 이렇게 찍어준다.

```
━━━ 서명 SHA-256 ━━━
  KakaoAuto_v2.0.apk
    콜론 있는 형식 : 33:ED:67:84:...
    서버 등록용 hex: 33ed6784cbea8bb3...
```

"**서버 등록용 hex**" (콜론 없는 소문자) 가 서버에 넣을 값이다.
같은 값이 `docs/APP_SIGNATURE.txt` 에도 자동으로 기록된다 — **빌드할 때마다 현재 빌드 hex 한 줄로
덮어쓰므로(기계 판독용) 손으로 고치지 마라.**

> 📒 **알려진 서명 전부는 `docs/APP_SIGNATURE_HISTORY.md` 에 있다.**
> `APP_SIGNATURE.txt` 는 이력을 남기지 않으니(덮어쓴다) 구버전 서명·CN·versionCode 는 그 파일에서 봐라.
> **빌드 검증도 히스토리 파일의 v2.0 행과 대조해라** — `APP_SIGNATURE.txt` 와 비교하는 건
> build.sh 가 직전에 같은 값을 써넣기 때문에 **항상 통과하는 무의미한 검증이다.**

따로 확인하려면:

```bash
$ANDROID_HOME/build-tools/34.0.0/apksigner verify --print-certs out/KakaoAuto_v2.0.apk
```

사용자앱과 관리자앱은 같은 키로 서명하니까 값도 같다. 하나만 등록하면 된다.

### 4-2. 등록 — 방법 A: 환경변수 (권장)

Render → 해당 웹서비스 → **Environment** → `ALLOWED_APP_SIGS` 에 넣고 저장 → 재배포.
값이 여러 개면 쉼표로 이어 붙인다 (여러 세대의 v2.x 정품 서명을 동시에 허용할 때).

```
ALLOWED_APP_SIGS=33ed6784cbea8bb34eb9a4f08f1f13c845a588a8d7d14cb74915b70cc53730fa
```

> ⚠️ **기존 v1.8 사용자가 남아있는 동안에는 여기에 아무 값도 넣지 마라 — 넣는 순간 전원이 잠긴다.**
> **구버전 서명을 같이 넣어도 안 풀린다.** v1.8 앱은 `app_sig` 를 아예 보내지 않아서
> 대조할 값이 없고, 목록이 비어있지 않으면 서버가 `bad_app_sig` 로 거부한다. 자세한 건 아래 5-2.

### 4-3. 등록 — 방법 B: 관리자앱

관리자앱 → **설정** → **앱서명 허용목록** → 추가.
이쪽은 DB(`app_signatures` 테이블)에 들어가서 재배포 없이 바로 먹는다.

### 4-4. 구버전 차단 (선택)

새 APK 를 다 배포한 다음 서버 환경변수 `MIN_APP_VERSION` 을 `20` 으로 올리면
`versionCode` 가 그보다 낮은 구버전 앱은 업데이트하라는 안내를 받고 막힌다.
기본값은 `0` (강제 업데이트 끔) 이다.

**전원이 v2.0 으로 넘어온 걸 확인한 뒤에 올려라.** 이관 중에 올리면 v1.8 사용자가 그대로 막힌다.
막히는 정도는 `bad_app_sig` 와 같지만(기능 전체 잠금), 사용자가 보는 문구가
**"앱을 최신 버전으로 업데이트해줘"** 라서 원인이 바로 보이고 `0` 으로 되돌리면 즉시 복구된다.
그래서 **서명목록보다 이걸 먼저 올려서 구버전 잔존을 떠보는** 순서를 권한다(5-2).

---

## 5. 기존 v1.8 / v1.4 사용자 이관 — **반드시 읽어라**

기존에 배포한 APK 는 **다른 서명키**로 서명돼 있고, 그 키(.jks)는 우리한테 없다 (APK 만 남아있었다).
**원본 키가 없으니 같은 키로 서명하는 건 불가능하다.** 실측값:

| 앱 | 버전 | versionCode | CN | 서명 SHA-256 (hex) |
|---|---|---|---|---|
| KakaoAuto | v1.8 (기존) | 9 | KakaoAuto | `5b938482fa1d6eaff6a0cbbb23977d71ae0f65b8acd95a19c790d99c7f282467` |
| KakaoAdmin | v1.4 (기존) | 5 | KakaoAdmin | `3f74e4ed37e9550737757cb62c4fde5e9195ad8f5e8dc3b61e3936a5c0d93f00` |
| **새 빌드 (둘 다 공통)** | v2.0 | 20 | KakaoMacro | `33ed6784cbea8bb34eb9a4f08f1f13c845a588a8d7d14cb74915b70cc53730fa` |

### 5-1. ⚠️ 기존 앱을 먼저 삭제해야 설치된다

> # 기존 v1.8 / v1.4 가 깔린 폰은 v2.0 을 덮어쓸 수 없다.
> 서명자가 다르므로 설치가 `INSTALL_FAILED_UPDATE_INCOMPATIBLE` 로 실패한다
> ("앱이 설치되지 않았습니다 / 패키지가 기존 패키지와 충돌합니다").
> **기존 앱을 먼저 삭제한 다음** 새 APK 를 설치해야 한다. 우회 방법은 없다.

**삭제하면 앱에 저장된 설정이 전부 날아간다** — 발송 메시지, 대상 방 목록, 트리거·금지어,
자동응답 문구, 봇 설정, 첨부해둔 사진. 설정은 `config_key` 로 암호화돼 앱 데이터 안에만 있으니
앱을 지우면 같이 사라진다. 사용자에게 **미리** 말해라.

**라이선스 키는 안 날아간다** — 서버 DB 에 있으니 재설치 후 키만 다시 입력하면 기능은 그대로 돌아온다.

#### 사용자에게 이렇게 안내해라

```
1. 기존 앱 삭제  (설정 → 앱 → 카톡 오토 → 제거)
   ※ 앱에 저장한 메시지·방 목록·트리거 설정은 지워집니다. 다시 입력하셔야 해요.
   ※ 라이선스 키는 그대로 살아있어요.
2. 새 APK 설치
3. 앱 열고 라이선스 키 다시 입력 → 인증
4. 권한 3개 다시 켜기 (알림 접근 / 배터리 최적화 제외 / 이미지 쓰면 접근성)
5. 발송 메시지·대상 방·트리거 다시 설정
```

`device_id`(ANDROID_ID)는 앱 삭제로 안 바뀌니까 보통 같은 폰에서 그대로 다시 활성화된다.
그래도 **1키 1기기** 에 막히면 관리자앱 → 키 상세 → **기기초기화** 를 눌러주면 된다.

### 5-2. 이관 단계별 서버 설정 (`ALLOWED_APP_SIGS` · `MIN_APP_VERSION`)

> 🔴 **`ALLOWED_APP_SIGS` 에 값을 넣는 순간 v1.8 사용자 전원이 `bad_app_sig` 로 잠긴다.
> 구버전 서명 hex 를 같이 넣어도 마찬가지다.**
>
> **v1.8 앱은 `app_sig` 필드를 아예 보내지 않는다.** 서버 `routes/license.js` 의 `/verify` 는
> 목록이 비어있지 않으면 `sigOk(app_sig)` 를 통과해야 하고, `sigOk` 는
> `s.length > 0 && 목록에 있음` 이라서 **빈 값을 무조건 거부한다.**
> 즉 구버전 요청은 **대조 자체가 일어나지 않고** 바로 `bad_app_sig` 로 떨어진다.
> 그래서 "세 값 다 넣기" 는 **동작하지 않는 설정이다.** 이관 중 안전한 값은 **빈 값 하나뿐이다.**

| 단계 | 언제 | `ALLOWED_APP_SIGS` | `MIN_APP_VERSION` | 결과 |
|---|---|---|---|---|
| **1단계 — 이관 중** | v2.0 배포 시작 ~ 전원 전환 완료 전 | **비워둔다** (빈 값 = 서명검사 건너뜀) | `0` | 구버전·신버전 둘 다 정상 동작 |
| **2단계 — 전환 완료 후** | 아래 방법으로 구버전 잔존이 없는 걸 확인한 뒤 | **v2.0 hex 하나만** | `20` | 구버전은 `update_required`, 리패키징은 `bad_app_sig` |

1단계 (이 값 그대로):

```
ALLOWED_APP_SIGS=
MIN_APP_VERSION=0
```

이 기간에는 리패키징 방어(2단)가 꺼져 있다. 대신 **1단(설정 암호화)과 5단(온라인 필수)** 이
그대로 살아있어서 키 없이 앱을 쓰는 건 여전히 막힌다 — `docs/ANTI_ABUSE.md`.

2단계 (전원 v2.0 확인 후):

```
ALLOWED_APP_SIGS=33ed6784cbea8bb34eb9a4f08f1f13c845a588a8d7d14cb74915b70cc53730fa
MIN_APP_VERSION=20
```

#### 2단계로 넘어갈 시점 확인 — [기록] 탭으로는 못 한다

[기록] 탭은 **사고만** 남긴다(`bad_sig`·`mismatch`·`tamper`·`expired`·`bad_admin_pw` 등).
**성공한 인증은 audit 에 안 남고**, 구버전은 `app_sig` 를 보내지도 않으니
"구버전 서명으로 들어오는 요청이 끊겼다" 를 볼 방법이 **애초에 없다.** 실제로 관측 가능한 건 이거다.

**(A) 키마다 `app_sig` 가 채워졌는지 — 주 지표**

`/verify` 성공 시 서버가 `licenses.app_sig` 를 `COALESCE(새값, 기존값)` 으로 갱신한다.
v2.0 으로 한 번이라도 인증하면 채워지고, **v1.8 만 쓰는 키는 계속 비어 있다**(안 보내니까 덮이지도 않는다).

- 관리자앱 **[키] 탭 → 키 상세**의 **"마지막 앱 서명"** 항목. 값이 없으면 그 줄이 안 뜬다
  → 아직 v2.0 으로 안 붙은 키다. 값이 v2.0 hex 면 넘어온 것이다.
- 한 번에 세는 방법은 `DEPLOY.md` 4-2 의 `curl /admin/list` 예시를 써라
  (`app_sig` 가 `null` 인 키 + 그 키의 `last_seen` 을 같이 뽑아준다).

**(B) `MIN_APP_VERSION` 을 먼저 올려서 떠보기 — 확인 사살 (무해하지는 않다)**

`ALLOWED_APP_SIGS` 는 비워둔 채 `MIN_APP_VERSION=20` 만 먼저 올린다. 구버전이 남아있으면
그 사용자는 `update_required` 를 받는다.

**이것도 기능이 막히는 건 `bad_app_sig` 와 같다** — 앱은 서버 판정을 받으면 라이선스 상태를 꺼버리고
`License.allowed()` 가 전부 거부한다. 차이는 두 개뿐이다.

- 문구가 **"앱을 최신 버전으로 업데이트해줘"** 다(v2.0 앱 기준. 구버전 앱 문구는 v1.8 소스가 없어서
  확인 못 한다 — 적어도 서버가 내리는 사유는 "위조된 앱" 이 아니라 업데이트 요구로 바뀐다)
- `MIN_APP_VERSION=0` 으로 내리면 **다음 재검증에서 즉시 복구된다**

그리고 올리자마자 전원이 막히지도 않는다. `/verify` 는 `app_version` 을 안 보낸 요청도 `0 < 20` 으로
막지만, `/heartbeat`·`/entitlements` 는 **`app_version` 을 보낸 요청만** 검사한다
(`routes/license.js` 의 `appCheck` → `v.appVer > 0`). 즉 그 필드를 안 보내는 구버전은 이미 인증된
상태로는 계속 돌아가고 **다시 인증할 때(재설치·기기변경·세션 복구) 막힌다.**
→ 즉시 스위치가 아니라 **서서히 드러나는 신호**다. (A)가 깨끗해진 뒤에 올리고, 며칠~몇 주
문의가 없으면 그때 `ALLOWED_APP_SIGS` 에 v2.0 hex 를 넣어 2단계를 마무리한다.
(`update_required` 도 서버 기록에는 안 남는다. 이건 사용자 문의로 확인하는 방법이다)

성급하게 서명목록부터 채우면 남아있던 구버전 사용자는 **앱이 잠긴 채** 연락이 온다.
순서는 **(A) 확인 → (B) `MIN_APP_VERSION` → 며칠 대기 → `ALLOWED_APP_SIGS`** 다.

### 5-3. 🔐 `keystore/app.jks` 를 다시는 잃지 마라

> 이번 사태의 원인은 딱 하나다 — **원본 서명키를 보관하지 못했다.**
> 이 키를 또 잃으면 다음 버전에서 사용자 전원이 **또** 앱을 지우고 설정을 다시 입력해야 한다.

백업 방법은 3-1 을 봐라 (레포 밖 복사 + base64 보관 + `KS_PASS` 같이 기록 + 복구 테스트).
그리고 `keystore/app.jks` 를 **바꾸지 마라.** 바꾸는 건 재설치 사태를 한 번 더 만드는 것과 같다.

---

## 6. 앱 설치 후 켜야 하는 권한 3개

설치만 하면 아무것도 안 된다. **아래 3개를 켜야 동작한다.** 앱 [내정보] 탭에 바로 가는 버튼이 있다.

### (1) 알림 접근 허용 — **필수**

카톡 알림을 읽어서 방 이름 · 보낸사람 · 내용을 파싱하고, 알림에 붙어있는 답장창(RemoteInput)으로
메시지를 보낸다. **이게 꺼져 있으면 아무 메시지도 못 보낸다.**

```
설정 → 알림 → 고급 설정 → 기기 및 앱 알림   (또는 "알림 접근")
  → "카톡 오토 · 알림 읽기" 켜기
```

제조사별 경로가 조금씩 다르다.
- 삼성: 설정 → 알림 → 고급 설정 → 기기 및 앱 알림
- 샤오미: 설정 → 앱 → 권한 → 알림 접근
- LG/기타: 설정 → 앱 → 특수 접근 → 알림 접근

> 켠 다음에도 안 되면 카톡 알림 자체가 꺼져 있는지 확인해라.
> 카카오톡 앱 안에서 **설정 → 알림 → 메시지 알림 ON**, 그리고 안드로이드 쪽에서도 카톡 알림이 허용돼 있어야 한다.
> 알림을 "무음"으로 두는 건 괜찮다. 아예 끄면 안 된다.

### (2) 접근성 — **이미지 보낼 때만 필요**

이미지 첨부(최대 5장) 발송은 알림 답장창으로는 안 된다. 카톡 공유 화면을 대신 눌러줘야 한다.
텍스트만 보낼 거면 안 켜도 된다.

```
설정 → 접근성 → 설치된 앱 (또는 다운로드한 앱)
  → "카톡 오토 · 자동 조작" → 사용 켜기
```

카카오톡 화면만 읽는다. 읽은 내용은 기기 밖으로 안 나간다.

### (3) 배터리 최적화 제외 — **필수급**

이걸 안 하면 화면을 끈 뒤 몇 분 ~ 몇십 분 만에 시스템이 앱을 재워버려서 주기 발송이 멈춘다.

```
설정 → 배터리 → 배터리 사용량 최적화 → "카톡 오토" → 최적화하지 않음
```

- **삼성**: 설정 → 배터리 → 백그라운드 사용 제한 → **절전 모드에서 제외할 앱** 에 "카톡 오토" 추가.
  추가로 설정 → 디바이스 케어 → 배터리 → 백그라운드 사용 제한 → **사용하지 않는 앱 절전** 목록에서 빼줘라.
- **샤오미 / 레드미**: 설정 → 앱 → 앱 관리 → 카톡 오토 → **자동 시작 허용** + 절전 정책 "제한 없음".
  최근 앱 화면에서 카톡 오토를 **자물쇠로 고정**해두면 더 안정적이다.
- **오포 / 비보 / 원플러스**: 설정 → 배터리 → 백그라운드 절전 → 카톡 오토 → 제한 없음.

### 그 외

- **알림 권한**(안드로이드 13 이상): 앱 실행하면 물어본다. 허용해라. 동작 상태를 알림으로 보여준다.
- **사진 권한**: 이미지 첨부를 처음 고를 때 물어본다. 이미지 안 쓸 거면 거절해도 된다.
- **정확한 알람**: 매니페스트에 `USE_EXACT_ALARM` 이 있어서 따로 허용할 게 없다.
  혹시 "알람 및 리마인더" 권한을 묻는 기기라면 허용해라.

---

## 7. 자주 나는 문제

| 증상 | 원인 / 해결 |
|---|---|
| `안드로이드 SDK 를 못 찾았어` | `export ANDROID_HOME=...` 로 SDK 경로를 지정 |
| `zip 명령이 없어` | `sudo apt-get install -y zip` |
| `javac 가 없어` | JDK 17 이상 설치 후 PATH 확인 |
| `자바 소스가 없어` | `auto/java/...` 에 `.java` 파일이 있는지 확인 |
| 설치할 때 `앱이 설치되지 않았습니다` | 서명키가 달라서다(`INSTALL_FAILED_UPDATE_INCOMPATIBLE`). 기존 앱을 먼저 지워라 — 5-1 |
| 업데이트 뒤 구버전 사용자가 전부 잠김 | `ALLOWED_APP_SIGS` 에 값이 들어있어서다(구버전 서명을 같이 넣었어도 마찬가지). **비워라** — 5-2 |
| `기본 키스토어 비밀번호를 쓰고 있어` 경고 | `KS_PASS` 환경변수(또는 GitHub Secret)로 비번을 넘겨라 — 3장 |
| 빌드한 서명 hex 가 `APP_SIGNATURE_HISTORY.md` 와 다름 | 키스토어가 바뀌었다(백업 복원 실패 · 새로 생성됨). **배포하지 마라** — 그대로 내면 사용자가 또 앱을 지워야 한다. 3-1 백업부터 확인 |
| 앱은 켜지는데 메시지가 안 나감 | (1) 알림 접근 허용, (2) 카톡 알림 ON, (3) 라이선스 활성화 여부를 [내정보] 탭에서 확인 |
| 화면 끄면 멈춤 | 배터리 최적화 제외 (위 6-(3)) |
| 구버전 사용자만 `bad_app_sig` | `ALLOWED_APP_SIGS` 를 비워라(5-2 1단계). v1.8 은 `app_sig` 를 안 보내서 목록에 뭘 넣어도 통과 못 한다 |
| v2.0 인데 `bad_app_sig` | 그 APK 서명이 허용목록과 다르다 = 다른 키로 서명된 빌드다. 4장대로 현재 hex 를 등록하거나 정품 APK 를 다시 배포해라 |
| 관리자앱이 **503 `admin_disabled`** | 앱 문제가 아니다. **서버 `ADMIN_PASSWORD` 가 비어있거나 기본값(`change-me-now`)** 이라 `/admin/*` 전체가 닫힌 것 — `DEPLOY.md` 1장 |
| 관리자앱 **401** / **429** | 401 = 비밀번호 불일치. 429 = 분당 실패 한도(`ADMIN_FAIL_PER_MIN`, 기본 10) 초과로 IP 차단(기본 15분) — `DEPLOY.md` 7-1 |

---

## 8. 폴더 구조

```
android/
  build.sh                        빌드 스크립트 (이것만 실행하면 된다)
  keystore/app.jks                서명키 (커밋됨 · 바꾸지 마라 · 레포 밖 백업 필수 → 3-1)
  out/                            결과 APK (gitignore)
  build/  gen/                    중간 산출물 (gitignore)
  auto/
    AndroidManifest.xml           권한 · 서비스 · 리시버
    res/values/strings.xml        한국어 문자열
    res/values/styles.xml         다크 테마 (Theme.java 토큰과 같은 값)
    res/xml/accessibility.xml     접근성 서비스 설정 (카톡만)
    res/drawable/ic_bg.xml ic_fg.xml
    res/mipmap-anydpi-v26/ic_launcher.xml   적응형 아이콘 (민트)
    java/com/buseong/kakaoauto/*.java
  admin/
    ...같은 구성 (아이콘은 바이올렛, 권한은 INTERNET 하나)
```
