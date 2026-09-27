# 앱 서명 이력 (사람이 관리하는 기록)

`docs/APP_SIGNATURE.txt` 는 **방금 빌드한 APK 의 hex 한 줄**만 들고 있다
(`android/build.sh` 가 빌드마다 덮어쓴다 — 기계 판독용이라 손으로 고치지 마라).
그래서 구버전 서명은 그 파일에 남지 않는다. **알려진 서명 전부는 이 파일에 적는다.**

## 알려진 서명 전부

| 앱 | 버전 | versionCode | 인증서 CN | 서명 SHA-256 (hex) | 상태 |
|---|---|:---:|---|---|---|
| KakaoAuto | v1.8 (원본) | 9 | KakaoAuto | `5b938482fa1d6eaff6a0cbbb23977d71ae0f65b8acd95a19c790d99c7f282467` | 구버전 · 원본 키 없음 |
| KakaoAdmin | v1.4 (원본) | 5 | KakaoAdmin | `3f74e4ed37e9550737757cb62c4fde5e9195ad8f5e8dc3b61e3936a5c0d93f00` | 구버전 · 원본 키 없음 |
| KakaoAuto + KakaoAdmin | v2.0 (현재) | 20 | KakaoMacro | `33ed6784cbea8bb34eb9a4f08f1f13c845a588a8d7d14cb74915b70cc53730fa` | **현재 정품** (`keystore/app.jks`) |

- v1.8 / v1.4 는 **서로 다른 키**로 서명됐고 그 키(.jks)가 우리한테 없다. 그래서 v2.0 은
  덮어쓰기 업데이트가 안 되고 사용자가 앱을 지워야 한다 (`DEPLOY.md` 4-1).
- v2.0 은 사용자앱·관리자앱을 **같은 키**로 서명하니까 hex 도 같다. 등록은 하나만 하면 된다.
- 위 세 값 말고 다른 hex 가 보이면 **우리가 만든 APK 가 아니다** (또는 키스토어가 바뀌었다).

## 이 파일로 검증하는 방법

빌드 직후 `docs/APP_SIGNATURE.txt` 와 비교하는 건 의미가 없다 — `build.sh` 가 직전에
그 파일을 방금 빌드한 값으로 덮어썼으니 **항상 같게 나온다.** 이 파일의 v2.0 행과 대조해라.

```bash
# 방금 빌드한 APK 의 서명 hex
$ANDROID_HOME/build-tools/34.0.0/apksigner verify --print-certs android/out/KakaoAuto_v2.0.apk \
  | grep -i 'SHA-256 digest' | sed 's/.*: *//' | tr -d ' :' | tr 'A-F' 'a-f'
# → 위 표의 v2.0 값과 같아야 한다 (= 서명키가 그대로라는 뜻)
```

값이 다르면 **키스토어가 바뀐 것**이다. 그대로 배포하면 기존 v2.0 사용자가 또 앱을 지워야 하니까
배포하지 말고 `android/keystore/app.jks` 백업을 먼저 확인해라 (`android/README.md` 3-1).

## 서명키를 바꿨을 때 (되도록 하지 마라)

바꿨다면 여기 행을 지우지 말고 **아래에 한 줄 추가**하고, 이전 행의 상태를 "구버전" 으로 바꿔라.
`ALLOWED_APP_SIGS` 이관 단계는 `DEPLOY.md` 4-2 와 같은 방식으로 다시 하면 된다
(전환 기간엔 비워두고, 전원 전환 후에 새 값 하나만).
