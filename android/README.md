# 안드로이드 앱 빌드 안내

이 폴더에는 앱 두 개가 들어있다.

| 폴더 | 패키지 | 결과물 | 용도 |
|---|---|---|---|
| `auto/` | `com.buseong.kakaoauto` | `out/KakaoAuto_v2.0.apk` | 사용자앱 (매크로 · 방관리봇 · 미니게임봇) |
| `admin/` | `com.buseong.kakaoadmin` | `out/KakaoAdmin_v2.0.apk` | 관리자앱 (키 · 주문 · 기록 · 설정) |

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

## 3. 서명키 (중요)

`android/keystore/app.jks` 가 서명키다. **이 파일은 일부러 깃에 커밋해 놨다.**

> 서명키가 바뀌면 이미 앱을 깔아둔 사용자는 업데이트를 설치할 수 없다
> ("앱이 설치되지 않았습니다" 오류가 난다). 그래서 이 키는 절대 바꾸지 말고 잃어버리지도 마라.

- 키가 없으면 `build.sh` 가 자동으로 만든다 (RSA 2048 · 10000일 · alias `app` · CN `KakaoMacro`).
- 비밀번호는 `build.sh` 맨 위 `KS_PASS` 변수에 있다.
- 깃에 키를 올리기 싫으면 **GitHub Secret** 으로 넘기면 된다.

```bash
base64 -w0 android/keystore/app.jks     # 맥은 base64 -i android/keystore/app.jks
```

출력값을 레포 → **Settings → Secrets and variables → Actions → New repository secret** 에
이름 `KEYSTORE_B64` 로 넣어두면, CI 가 그걸 디코드해서 서명에 쓴다. 로컬에서도 같은 환경변수를 주면 된다.

```bash
KEYSTORE_B64="$(base64 -w0 keystore/app.jks)" ./build.sh all
```

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

"**서버 등록용 hex**" (콜론 없는 소문자) 가 서버에 넣을 값이다. 따로 확인하려면:

```bash
$ANDROID_HOME/build-tools/34.0.0/apksigner verify --print-certs out/KakaoAuto_v2.0.apk
```

사용자앱과 관리자앱은 같은 키로 서명하니까 값도 같다. 하나만 등록하면 된다.

### 4-2. 등록 — 방법 A: 환경변수 (권장)

Render → 해당 웹서비스 → **Environment** → `ALLOWED_APP_SIGS` 에 넣고 저장 → 재배포.
값이 여러 개면 쉼표로 이어 붙인다 (구버전 키와 신버전 키를 동시에 허용할 때).

```
ALLOWED_APP_SIGS=33ed6784cbea8bb3...,8a91bc...
```

### 4-3. 등록 — 방법 B: 관리자앱

관리자앱 → **설정** → **앱서명 허용목록** → 추가.
이쪽은 DB(`app_signatures` 테이블)에 들어가서 재배포 없이 바로 먹는다.

### 4-4. 구버전 차단 (선택)

새 APK 를 다 배포한 다음 서버 환경변수 `MIN_APP_VERSION` 을 `20` 으로 올리면
`versionCode` 가 그보다 낮은 구버전 앱은 업데이트하라는 안내를 받고 막힌다.
기본값은 `0` (강제 업데이트 끔) 이다.

---

## 5. 기존 v1.8 / v1.4 사용자 이전 — **반드시 읽어라**

기존에 배포한 APK 는 **다른 서명키**로 서명돼 있고, 그 키(.jks)는 우리한테 없다 (APK 만 남아있었다).

```
KakaoAuto  v1.8  versionCode 9   CN=KakaoAuto    5b938482fa1d6eaff6a0cbbb23977d71ae0f65b8acd95a19c790d99c7f282467
KakaoAdmin v1.4  versionCode 5   CN=KakaoAdmin   3f74e4ed37e9550737757cb62c4fde5e9195ad8f5e8dc3b61e3936a5c0d93f00
```

v2.0 은 새 키(`keystore/app.jks`, CN=KakaoMacro)로 서명하니까,

> **기존 사용자는 v2.0 을 덮어쓰기로 설치할 수 없다. 기존 앱을 먼저 지워야 한다.**
> ("앱이 설치되지 않았습니다 / 패키지가 기존 패키지와 충돌합니다" 오류가 난다)

### 사용자에게 이렇게 안내해라

1. 앱 삭제 (설정 → 앱 → 카톡 오토 → 제거)
2. 새 APK 설치
3. 앱 열고 키 다시 입력해서 활성화

앱을 지우면 기기 등록이 남아있어서 **1키 1기기** 규칙에 걸릴 수 있다. `device_id`(ANDROID_ID)는
앱 삭제로는 안 바뀌니까 보통 그대로 다시 활성화된다. 그래도 막히면 관리자앱 → 키 상세 →
**기기초기화** 를 눌러주면 된다.

### 이전 기간 동안 서버 설정

구버전 사용자가 갈아탈 시간을 주는 동안은 **구버전 서명도 허용목록에 같이 넣어둬라.**

```
ALLOWED_APP_SIGS=<v2.0 서명 hex>,5b938482fa1d6eaff6a0cbbb23977d71ae0f65b8acd95a19c790d99c7f282467,3f74e4ed37e9550737757cb62c4fde5e9195ad8f5e8dc3b61e3936a5c0d93f00
MIN_APP_VERSION=0
```

다 갈아탄 게 확인되면 구버전 두 줄을 빼고 `MIN_APP_VERSION=20` 으로 올려라.
그러면 구버전 앱은 "업데이트하세요" 안내를 받고 막힌다.

> 앞으로는 `keystore/app.jks` 를 절대 바꾸지 마라. 한 번 더 바꾸면 사용자가 또 앱을 지워야 한다.

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
| 설치할 때 `앱이 설치되지 않았습니다` | 서명키가 달라서다. 기존 앱을 먼저 지워라 (위 5장) |
| 앱은 켜지는데 메시지가 안 나감 | (1) 알림 접근 허용, (2) 카톡 알림 ON, (3) 라이선스 활성화 여부를 [내정보] 탭에서 확인 |
| 화면 끄면 멈춤 | 배터리 최적화 제외 (위 6-(3)) |
| `bad_app_sig` 로 거절당함 | 이 문서 4장대로 서명 SHA-256 을 `ALLOWED_APP_SIGS` 에 등록 |

---

## 8. 폴더 구조

```
android/
  build.sh                        빌드 스크립트 (이것만 실행하면 된다)
  keystore/app.jks                서명키 (커밋됨 · 바꾸지 마라)
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
