# 라이선스 서버 배포 (Render 무료 + Neon 무료)

## 1. Neon(무료 Postgres) 만들기
1. neon.tech 가입 → New Project
2. 대시보드의 **Connection string** 복사
   (`postgresql://user:pass@ep-xxx.neon.tech/dbname?sslmode=require` 형태)

## 2. GitHub에 이 폴더 올리기
- license-server 폴더를 새 레포로 push (Private 추천)

## 3. Render에 배포
1. render.com → New → **Web Service** → 그 레포 선택
2. Runtime: Node / Build: `npm install` / Start: `npm start` (render.yaml이 자동으로 잡아줌)
3. Environment에 환경변수 3개 추가:
   - `DATABASE_URL` = Neon 연결 문자열 (1번에서 복사한 것)
   - `ADMIN_PASSWORD` = 관리자 앱에서 쓸 비밀번호 (길고 아무도 모르게)
   - `SIGNING_PRIVATE_KEY` = **일단 비워두고 첫 배포**
4. 첫 배포 후 **Logs** 열기 → `===== 서명키 생성됨 =====` 아래에 뜨는:
   - PRIVATE KEY(-----BEGIN...END-----) 전체를 복사 → 환경변수 `SIGNING_PRIVATE_KEY`에 붙여넣고 저장(재배포)
   - PUBLIC KEY(base64 한 줄)는 따로 저장 → **사용자 앱 만들 때** 필요
   ※ 이렇게 고정해야 서버가 재시작해도 기존 키들의 서명이 유지돼.

## 4. 동작 확인
브라우저로 `https:// 배포주소 /` 열어서 `{"ok":true,...}` 뜨면 성공.

## 다음 단계에 필요한 것 (나한테 알려줘)
- 배포된 서버 주소 (예: https://kakao-license.onrender.com)
- 로그에 나온 PUBLIC KEY (base64 한 줄)
→ 이 둘로 관리자 앱과 사용자 앱을 만들면 돼.

## 참고
- **셀프핑 내장**: 서버가 9~11분마다 자기 주소(/health)를 호출해서 안 잠들게 해. 설정할 거 없음 (Render가 주소를 자동으로 알려줌).
  로그에 `셀프핑 켜짐 → https://...` 뜨면 정상.
- ⚠️ Render 무료는 **워크스페이스 전체 합쳐서 월 750시간**이야. 이 서버 하나를 24시간 켜두면 한 달 약 730시간이라,
  같은 워크스페이스에 **다른 무료 서비스도 계속 켜두면 한도를 넘어서 다음 달까지 전부 정지**돼.
  → 이 서버는 **별도 Render 계정(워크스페이스)**에 올리는 걸 추천.
- 셀프핑은 DB를 안 건드려서 Neon 무료 사용량은 안 먹어.
- 키 데이터는 Neon에 있어서 서버가 재시작·재배포돼도 안 날아감.
