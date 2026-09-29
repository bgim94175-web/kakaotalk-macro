# 설치 파일 (v2.1 · 시험판)

| 파일 | 앱 | 버전 | 크기 | SHA-256 |
|---|---|---|---|---|
| [KakaoAuto-v2.1.apk](KakaoAuto-v2.1.apk) | 사용자앱 (카카오 계정 직접 연결 엔진 포함 · arm64/armv7) | 2.1.8 (29) | 36,607,214 B | `a387390a2695499c34369b90e935b91fc163f00842e53b59e0138588d444b138` |
| [KakaoAdmin-v2.1.apk](KakaoAdmin-v2.1.apk) | 관리자앱 | 2.1.1 (22) | 78,436 B | `c3ed71175849afe0c7deac1a5d73ab5342c6b5061ee036deda1292d8b6b030d6` |

- 서명 인증서 SHA-256: `33ed6784cbea8bb34eb9a4f08f1f13c845a588a8d7d14cb74915b70cc53730fa` (v2.0 과 동일 → v2.0 위에 업데이트 설치됩니다)
- 소스: `cursor/on-device-kakao-engine-9b70` 브랜치 `4b98524` (KakaoAuto versionName 2.1.8 · versionCode 29, KakaoAdmin versionName 2.1.1 · versionCode 22)
- 보낼 방은 오픈채팅방, 일반 채팅방, 오픈프로필로 온 갠톡 세 목록이다. 이미지가 없으면 이미지를 보내지 않고, 이미지가 있으면 기본은 매번이다.
- 등록이 끝나면 발송은 저장소의 상시 Node 프로세스(`sender/`)가 agent-messenger 로 한다. 폰이 꺼져 있어도 그 호스트가 켜져 있으면 계속된다. 이 환경에는 로그인할 카카오 계정이 없어 실로그인과 실발송은 확인하지 않았다.
