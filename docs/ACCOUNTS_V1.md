# ACCOUNTS V1 — 회원 계정 · 상품 3종 · 방 설치형 봇 구현 명세

기준 커밋: `9db383a` (브랜치 `claude/kbot-accounts-pricing`). 이 문서는 이번 작업의 **단일 기준**이다.
`docs/SPEC.md` 와 어긋나면 이 문서가 이긴다. 구현이 끝나면 SPEC.md 를 이 문서에 맞춰 고친다(작업 2 담당).
디자인 규칙은 `docs/UI_V5.md`·`docs/TONE.md`·`docs/BRAND.md` 를 그대로 따른다. `docs/DARK_V1.md` 는 폐기 문서다.

> **문구 정리(v7) 뒤의 기준.** 화면·서버 응답·방 메시지의 최종 문장은 코드가 단일 소스다(`lib/installs.js`·`routes/*.js`·`lib/*-text`·`public/*`·`sender/src/roomfeat.mjs`·`features.mjs`). 용어는 `docs/TONE.md` 용어집을 따른다: 콘솔 → **패널**(`K bot 패널`), 관리 콘솔 → **판매 관리**, `~하십시오` → `~해 주세요`, 강퇴 → 내보내기, 로그 → 기록, 가리기 → 글 가리기, 올킥 방지 → 올킥 감지, 나갔을 때 내보내기 → 나간 사람 재입장 차단, `부방장 대기` → `부방장 지정 대기`, 방에서는 짧은 해요체. 0.1·3.4.2·5.6·7.2·7.8·7.9 와 부록의 fa4 는 v7 문구로 고쳤다. 다른 장의 따옴표 문구 가운데 `~하십시오` 체로 남은 것은 v7 이전 표기이며, 어긋나면 코드와 TONE.md 가 이긴다.

읽는 법: 1장은 결정과 이유, 2~5장은 서버 계약, 6~7장은 화면과 방 관리 기능, 8장은 보안, 9장은 작업 분담과 시험, 10장은 실측·운영자 확인, 부록 A 는 사이트 문구 표, 부록 B 는 채널톡 로더다.
각 작업 담당은 1장 전부와 자기 작업이 쓰는 장을 읽는다. 다른 작업과 맞닿는 부분은 9.2 의 인터페이스만 믿는다. 구현에 필요한 내용(Google 흐름 3.2, 아이콘 6.11, 콘솔 마크업 6.9, 로더 부록 B)은 모두 이 문서 안에 있다. 이 문서 밖의 연구 보고를 근거로 삼지 않는다.

---

## 0. 용어와 고정 값

| 코드 값 | 화면 표기 | 뜻 |
|---|---|---|
| `macro` | 카카오톡 매크로 | 고객 **자기** 카카오 계정으로 보내는 발송 기능. 1개월(30일) 단위 |
| `roombot` | 방 관리봇 | **운영자 봇 계정**이 오픈채팅방에 들어가 관리하는 기능. 방 1개 설치 단위, 기간 없음 |
| `minigame` | 미니게임봇 | 운영자 봇 계정이 방에서 미니게임을 진행. 방 1개 설치 단위, 기간 없음 |
| member | 회원 | 아이디·비밀번호로 가입한 고객. 모든 구매·권리는 회원에게 붙는다 |
| customer account / device | 계정 (콘솔 화면) | 고객이 콘솔에 등록한 자기 카카오 계정. `panel_accounts` 행, sender `kakao_sessions` 행 |
| bot account | K bot 계정 | 운영자가 `/manage` 에 등록한 봇 카카오 계정. device_id `bot.<16hex>` |
| install | 설치한 방 (내 방) | 방 1개에 대한 설치 권리. `room_installs` 행 1개 = 방 1개(상품 2종을 함께 가질 수 있음) |
| link_id | — | 오픈채팅 링크 id(LOCO `li`, 10진 문자열). 방의 **영구 식별자** |
| chat_id | — | 봇이 들어간 뒤 받는 LOCO 채널 id. 봇 동작은 이 값으로 한다 |
| perm | — | 봇의 방 권한 비트. 1 방장, 2 일반, 4 부방장, 8 봇. `perm & 5` 이면 관리 권한 있음 |

화면 이름은 위 표기를 어디서나 같게 쓴다. `자동발송 매크로`·`대화방 관리봇`(예전 이름)은 더 쓰지 않는다.
`부방` 이 아니라 `부방장`, 방 주인은 `방장`, 방 비밀번호는 카카오 용어 그대로 `참여코드` 다.

### 0.1 방 상태 (고객·관리자 공통 5단계)

| 표시 값(`display`) | 라벨 | 근거 | 점 색 |
|---|---|---|---|
| `pending` | 입금 대기 | `phase='pending_payment'` | warn |
| `joining` | 입장 중 | `phase='installed'` 이고 `state` 가 `queued` 또는 `joining` | warn |
| `waiting` | 부방장 지정 대기 | `state='waiting_host'` (방 관리봇이 있고 봇 권한이 `perm & 5` 아님. `state='active'` 라도 방 관리봇이 있고 `perm & 5` 가 아니면 이 값) | warn |
| `active` | 사용 중 | `state='active'` | live |
| `error` | 오류 · {짧은 사유} | `state='error'`, 사유는 `error_code` (5.6 표) | crit |

`phase` 가 `canceled`·`removed` 인 행은 고객 목록에 나오지 않는다(주문 화면에는 `취소됨`, 관리자에게는 `설치 해제`).
`hold_reason` 이 있는 행(D28, 운영자 확인 대기)은 `joining` 으로 보이고 보조 문구가 `운영자 확인 뒤 입장합니다.` 다.

한 화면 안에서는 한 낱말이 한 가지만 뜻한다: 사이트의 `내 계정` = 회원 계정, 콘솔의 `카카오 계정` = 고객이 등록한 카카오 계정(콘솔 내비·제목도 `계정` → `카카오 계정`), `K bot 계정` = 운영자 봇. 결제 전 상태는 주문 칩·방 상태 모두 `입금 대기` 로 쓴다(0.1 의 `pending` 라벨도 `입금 대기`).

---

## 1. 결정 사항

| # | 항목 | 결정 | 이유 |
|---|---|---|---|
| D1 | 회원 | `members` 표. 아이디(영문 소문자로 시작, 소문자·숫자·`_` 4~20자) + 비밀번호(8~128자, scrypt). 이메일·휴대폰 인증 없음. 연락처는 선택 | 소유자 요구가 "ID+비밀번호". 추가 의존성 없이 Node 내장 `crypto.scrypt` 로 충분 |
| D2 | 권리의 주인 | 모든 구매·지급은 `member_id` 에 붙는다. 새 라이선스 키는 더 발급하지 않는다 | 키 공유 차단(소유자 요구 1) |
| D3 | 세션 | 서버 표 `member_sessions` + 무작위 불투명 쿠키 `kb_s`(Path=/, HttpOnly, SameSite=Lax, https 면 Secure). 회원당 **동시 로그인 3대**(`MEMBER_MAX_SESSIONS`). 4번째 로그인은 가장 오래 쓰지 않은 세션을 끊는다. 유휴 30일 만료 | 공유를 막으려면 기기 수를 세야 하고, 세려면 서버 표가 필요하다. 거절 대신 밀어내기로 해야 기기를 잃은 본인이 잠기지 않는다 |
| D4 | Google 연결 | 로그인한 회원만 Google 을 연결한다. Google 로그인은 연결된 회원만 가능(자동 가입 없음). Google 로그인 후 15분 안에는 현재 비밀번호 없이 새 비밀번호를 정할 수 있다 = 비밀번호 찾기 | 소유자 요구 1. 식별은 `sub` 만 쓴다(이메일은 표시용) |
| D5 | 카카오톡 매크로 범위 | 고객 자기 카카오 계정으로 발송. 계정 등록은 지금 흐름 그대로. 회원당 계정 **3개**(`MEMBER_MAX_ACCOUNTS`). 이미 3개를 넘는 기존 회원(키 이관)은 그대로 두고 추가만 막는다 | 무료 Render 512MB 에 고객 계정과 봇 계정의 LOCO 연결이 함께 산다. 1인 1구독 기준 |
| D6 | 매크로 기간 | 결제 확인 시점부터 30일 × 개월. 다시 사면 `max(지금, 만료) + 30일 × 개월`. "첫 로그인부터 시작" 규칙은 회원 구매에 없다 | 소유자 요구 2. 회원 단위라 미개시 상태를 둘 이유가 없다 |
| D7 | 매크로 만료 | 만료되면 sender 가 그 회원의 고객 계정 연결을 끊는다(기록은 보존). 다시 사면 이어서 붙는다. 콘솔은 계속 들어갈 수 있다(내 방 관리 때문에) | 만료 뒤에도 연결을 붙잡으면 메모리만 쓴다. 지금은 만료가 발송에 전혀 반영되지 않는 결함이 있다 |
| D8 | 방 식별 | 설치 권리는 **link_id** 에 묶는다(기간 없음). 2026-10-17 부터 고객은 사이트(패널)에서 봇을 다른 방으로 옮기거나 같은 방에 다시 설치할 수 있다 — 무료, 설치마다 옮기기 24시간·다시 설치 30분 간격(3.4.3). 같은 방(link_id, 미확인이면 링크 주소)에는 **결제된**(`installed`) 설치 행이 1개뿐(부분 UNIQUE). 한 방에 두 상품을 함께 둘 수 있고 같은 봇이 둘 다 맡는다. 설치의 주인은 회원 1명이고 상품 추가도 그 회원만 한다. 봇이 방에서 **내보내지면**(`error/kicked`) 그 설치는 배타권을 잃는다 — 다른 회원(대개 방장 본인)이 같은 방을 새로 살 수 있다 | 이름·키는 바꿀 수 있어 위조된다. link_id 는 카카오가 정한 방 id 다. 방장의 의사 표시(봇 내보내기)가 곧 남이 산 설치를 푸는 수단이다. 상품별로 주인을 나누면 명령어 앞글자·제외 목록처럼 방 단위 설정의 주인이 둘이 되어 받지 않는다(옮기기는 관리자 `room-transfer`) |
| D9 | 방 상품 구매 흐름 | 구매 화면에서 링크 붙여넣기 → 서버가 봇으로 링크를 조회해 방 이름·참여코드 필요 여부를 보여 줌(`POST /api/room-preview`) → 주문 접수 때 그 회원의 설치 행을 `입금 대기` 로 예약 → 입금 매칭(자동 또는 관리자) 때 같은 트랜잭션에서 `installed` + 봇 배정 → sender 가 입장. **미입금 예약은 다른 회원을 막지 않는다**: 같은 방을 여러 회원이 동시에 주문할 수 있고 **먼저 입금된 주문이 갖는다.** 늦게 입금된 주문은 `needs_review`(관리자가 나머지만 적용하고 그 방 금액을 환불, 4.2) | 미입금 주문으로 남의 방을 48시간씩 막는 것을 없앤다. 같은 회원 안에서는 예약이 중복 방지다 |
| D10 | 조회 실패 시 | 봇이 하나도 연결되어 있지 않거나 조회 예산(5.3)이 바닥나 링크를 조회하지 못하면 주문은 받되 `link_id` 를 비워 둔다(링크 주소로 중복 검사). 그 방 줄은 **고객이 확인란에 동의해야** 주문된다(6.6). 입장할 때 처음 조회한 방에 묶인다. 설치할 수 없는 링크로 밝혀지면(`link_gone`·`not_group`) 관리자가 `room-rebind` 로 링크를 바꾸거나 환불한다 | sender 장애가 판매를 막지 않게. 확인하지 못한 방에 돈을 받는다는 사실을 고객이 알고 산다 |
| D11 | 봇 계정 풀 | `/manage` 에서 운영자가 봇 카카오 계정을 지금 등록 흐름(휴대폰 확인 포함)으로 여러 개 등록. 배정은 **가장 적게 맡은 봇**, 봇마다 상한 `room_cap`(기본 20). 상한이 다 찼거나 봇이 없으면 `입장 중 · 순서 대기` 로 두고 1분마다 다시 배정 | 방이 늘면 계정 1개가 감당 못 한다(방마다 20초 점검 부하). 사용 가능한 봇이 생기면 자동으로 이어진다 |
| D12 | 봇 프로필 | 봇은 고객 방에 카카오톡 기본 프로필이 아니라 **그 봇 계정의 오픈프로필**로만 입장한다(`JOINLINK {ptp:16, pli: 오픈프로필 링크 id}`, 방의 `ol.pv` 와 관계없이). 오픈프로필이 없으면 입장하지 않고(`bot_no_open_profile`) 기본 프로필(`ptp:1`)·닉네임 프로필(`ptp:2`)로 대신 들어가는 일은 없다. 이미 기본 프로필로 들어가 있는 방은 나가지 않고 `UPLINKPROF` 로 바꾼다(5.8). 고객·방장에게 보이는 봇 이름 = 그 방에서 보이는 이름(오픈프로필 이름). **봇마다 오픈프로필 이름이 달라야 한다**(`K bot 1`, `K bot 2` …). `/manage` 가 겹치는 이름을 경고한다 | 기본 프로필은 운영자 개인 카카오톡 프로필이 고객 방에 드러나고, 방장이 봇을 눌렀을 때 개인 프로필이 보인다. 모든 봇이 `K bot` 이면 방장이 봇과 이름을 바꾼 사람을 구분하지 못해 엉뚱한 사람을 부방장으로 지정할 수 있다 |
| D13 | 부방장 감지 | 봇 자신의 권한은 `CHATONROOM` 응답의 `olu.lmt`(클라이언트 자신의 오픈링크 사용자 정보)를 먼저 읽고, `olu` 가 없으면 `MEMBER{chatId,[self]}`(=`getMembersByIds`)로 읽는다(node-kakao 와 같은 순서). 부방장 대기 방은 **60초(±15초)**, 사용 중 방은 **10분**마다. 푸시(`SYNCMEMT`, 피드 11·12·15)와 재접속은 즉시 확인의 신호로만 쓴다 | 푸시 모양이 실측되지 않았다. 폴링은 방 1개당 작은 패킷 1개라 싸다. 감지까지 최대 75초 + 콘솔 폴링 10초라 화면 문구는 "**1~2분 안에** 감지"로 정직하게 쓴다 |
| D14 | 강등 | 사용 중에 부방장이 해제되면 `부방장 지정 대기` 로 돌아간다. 방 관리 기능은 멈추고 미니게임은 계속한다 | 소유자 요구 3 |
| D15 | 설정 시점 | 방 관리봇 설정은 `사용 중` 일 때만 저장된다(서버가 409). 미니게임과 명령어 앞글자는 설치되면 언제든 저장된다. 방 관리 기능의 기본값은 전부 꺼짐이므로, 부방장 지정 안내는 "콘솔에서 켠 기능이 동작한다"고 말하고(7.9), 사용 중인데 켜진 기능이 없으면 화면이 `사용 중 · 켜진 기능 없음` 과 `입장·퇴장 로그` 바로가기를 보인다(RoomView `on_count`) | 소유자 요구 3 ("부방장을 얻으면 설정 가능"). 켜지 않은 기능을 "시작합니다"라고 말하지 않는다 |
| D16 | 내보내짐·방 삭제 | 봇이 내보내지면 `오류 · 내보내짐`(배타권 해제, D8), 방이 삭제되면 `오류 · 방 삭제됨`. 권리는 그 방(link_id)에 남는다. 고객 `다시 시도` 는 설치마다 간격이 2분부터 두 배씩 늘고(최대 6시간) 연속 10번이면 관리자만 할 수 있다(3.4.3). 내보내짐은 방장이 내보내기 목록에서 해제한 뒤에만 의미가 있으므로 같은 규칙 + 그 사이 다른 회원이 그 방을 설치했으면 409. 방이 삭제되었거나 링크가 바뀐 경우는 고객이 [다른 방으로 옮기기]에 새 링크를 넣는다(3.4.3, 무료·간격 있음·감사 기록). 관리자 `room-rebind` 도 그대로 있다 | 영구 설치 권리지만 방이 사라지면 쓸 곳이 없다. 옮기기를 고객에게 열면 권리 1개로 방을 돌려 쓸 수 있다. 실패할 입장을 고객이 무한히 반복시키면 공용 봇 계정이 제재받는다 |
| D17 | 봇 계정 장애 | 봇 계정이 끊기면(다른 기기 로그인 `KICKOUT` 사유 0·1, 토큰 만료) 그 봇의 방은 `오류 · K bot 점검`. `KICKOUT` 사유 -2(CHANGE_SERVER)는 재접속일 뿐이다. `-444`(BLOCKED_IP)는 서버 IP 문제라 봇을 내리지 않고 **모든 입장을 멈춘다**(5.3). **자동으로 다른 봇에 옮기지 않는다.** 관리자가 같은 봇을 다시 등록하면 그대로 이어지고, 다른 봇으로 옮기면 방장이 새 봇을 부방장으로 다시 지정해야 한다 | 자동 이동은 모든 방장에게 부방장 재지정을 강요한다. 대부분은 재등록으로 복구된다 |
| D18 | 설치 해제·이전 | 고객은 설치를 지울 수 없다(영구 권리). 다른 방으로 옮기기·같은 방에 다시 설치는 고객도 직접 한다(3.4.3). 관리자만 해제(`room-remove`) — 봇은 방에서 나간다. 관리자는 설치를 다른 회원에게 넘길 수 있다(`room-transfer`, 방장 확인은 상담에서). 환불은 범위 밖(운영자가 계좌로 처리) | 단순하게. 남이 먼저 산 방의 방장이 상담으로 넘겨받을 길을 둔다 |
| D19 | 기존 키 이관 | 회원이 `/account` 에서 기존 키를 입력해 1회 이관(`/api/auth/claim`). 매크로 남은 기간은 회원 매크로 기간에 **더한다**. 키에 묶인 콘솔 계정(`panel_accounts`)은 회원 것이 된다. 고객 스스로는 다른 회원에게 다시 이관할 수 없고, 잘못 이관된 키는 관리자가 `license-reassign` 으로 옮긴다(이관 IP·시각은 감사 기록에 남음). 이관된 키에 대한 옛 키 경로 지급(`/admin/grant`, 늦게 입금된 연장 주문)은 회원에게 적용하거나 409 로 막는다(4.2) | 소유자 요구 7. 키는 공유되던 물건이라 엉뚱한 사람이 먼저 이관할 수 있다 |
| D20 | 기존 계정 기능 유예 | 예전에는 고객 계정 위에서 입장·퇴장 로그·프로필 로그·올킥 방지·금지어 검열이 돌았다(키만 있으면 무조건). 이관한 회원은 그 키의 가장 늦은 만료일(`legacy_room_until`)까지 이 4개 화면을 계정 단위로 계속 쓴다. 새 회원에게는 보이지 않는다 | 이미 돈을 낸 고객의 기능을 기간 중에 빼앗지 않는다 |
| D21 | 미이관 키 | `/panel` 의 키 로그인은 없어진다. 미이관 키에 묶인 고객 계정은 키 만료일까지 발송을 계속하고(서버가 키 만료일로 권리를 밀어 줌), 콘솔은 회원 가입·이관 뒤 쓸 수 있다 | 로그인 수단은 하나로 |
| D22 | 주문 만료·취소 | 지금처럼 48시간 미입금 시 자동 취소(`ORDER_PENDING_TTL_MS`). 회원은 자기 미입금 주문을 직접 취소할 수 있다(`POST /api/my/orders/cancel`). 어느 쪽이든 그 주문이 예약한 `입금 대기` 설치도 `canceled`. 관리자가 늦은 입금으로 되살리면, 그 방이 그 사이 다른 회원에게 가지 않았을 때만 설치가 되살아난다. 회원당 미입금 주문 **3건**, 미입금 방 줄 **10개**, IP당 미입금 주문 **10건**까지(`MEMBER_MAX_PENDING_ORDERS`·`MEMBER_MAX_PENDING_ROOMS`·`IP_MAX_PENDING_ORDERS`) | 예약이 방을 막지 않고(D9), 미입금 주문이 금액 뒷자리(총액마다 99개)를 다 차지하지 못하게 |
| D23 | 고유 금액 | 주문 총액 + 1~99원 뒷자리(`pickAmount` 그대로). 가격이 모두 5,000원 배수라 총액이 다르면 뒷자리 구간이 겹치지 않는다. 입금자명이 달라도 지금처럼 감사 경고만 남기고 자동 적용한다 | 자동 입금 매칭 유지. 가족 이름 입금이 흔해 이름 불일치를 수동 처리로 돌리면 자동 확인이 거의 사라진다. 뒷자리까지 같은 금액이 우연히 남의 주문과 맞을 확률은 낮다 |
| D24 | 한도 | 주문 1건: 매크로 0~12개월, 방 0~10개. 총액 최대 380,000원 | 금액 오입력 방지 |
| D25 | 실시간 상담 | 채널톡(channel.io) 위젯. 소유자가 쓴 "채널 웍스"를 채널톡으로 본다. 떠 있는 기본 말풍선은 끄고 `[data-support]` 버튼으로만 연다. `CHANNEL_PLUGIN_KEY` 가 없거나 SDK 가 뜨지 않으면(차단·카카오톡 웹뷰) 버튼은 `CONTACT_INFO` 연락처 안내로 바뀌고, 둘 다 없을 때만 숨는다. **콘솔(`/panel`)에는 SDK 를 띄우지 않는다** — 콘솔의 상담 버튼은 새 창으로 `/support` 를 연다. 로그인한 회원은 아이디를 이름으로 넘기고, 회원 식별자(`memberId`, 추측할 수 없는 HMAC 값)는 `CHANNEL_MEMBER_SECRET` 이 있고 채널 데스크의 회원 해시 검증을 켠 경우에만 넘긴다 | 기본 말풍선은 색이 있어 디자인 원칙에 어긋나고 토스트·저장 바와 겹친다. 콘솔은 고객의 1:1 대화를 보여 주는 화면이라 제3자 스크립트를 들이지 않는다 |
| D26 | 방 기록 보존 | `room_log` 30일(`ROOM_LOG_KEEP_DAYS`). 부모 서버가 하루 1번 지운다(`entitle.startLoop`) | 무료 Neon 용량. **운영자 확인 필요 항목**(10.2) |
| D27 | 차단된 회원 | 로그인 거부, 세션 전부 종료, 고객 계정 발송 정지, 설치한 방의 봇 기능 정지(봇은 방에 남아 조용히 있음). 차단 해제 시 그대로 이어짐 | 관리자가 상황을 되돌릴 수 있게 |
| D28 | 설치할 방 제한 | 운영자 봇이 들어가는 방을 거른다: (1) `room_blocklist`(link_id·링크 주소) — 미리 보기·주문·입장 직전에 검사, 관리자 `room-block` 이 설치를 해제하고 다시 주문을 막는다. (2) 주문 때 이용 조건 확인란 필수(금지 용도·설치 해제 시 환불 없음 — 문구는 운영자 확인, 10.2), `orders.terms_at` 에 기록. (3) `ROOM_HOLD_WORDS`(쉼표 목록, 기본 비어 있음)에 방 이름이 걸리면 결제 뒤 입장하지 않고 `hold_reason` 을 남겨 관리자 `room-release` 를 기다린다 | 봇 계정은 운영자 명의다. 불법·도박·스팸 방에 들어가 신고되면 같은 봇의 다른 고객 방까지 끊긴다 |
| D29 | 공용 봇 보호 | 봇 1개를 최대 20개 방이 나눠 쓰므로 (1) 입장·조회 패킷(JOININFO·CHECKJOIN·JOINLINK)에 봇마다 시간·하루 예산, (2) 방마다 공정 몫 한도(5.5), (3) 입장 실패 때 봇 클라이언트를 닫았다 열지 않는다(5.3), (4) 고객 다시 시도는 지수 간격·횟수 상한(D16). 예산은 sender 가 강제한다(부모 라우트 검사는 보조) | 한 고객의 행동이 같은 봇의 다른 방을 끊거나 봇 계정 제재를 부르지 않게 |

---

## 2. 데이터 모델

### 2.1 마이그레이션 (`lib/db.js` `STEPS` 끝에 이 순서로 붙인다)

규칙: `CREATE TABLE IF NOT EXISTS`·`ADD COLUMN IF NOT EXISTS`·`CREATE [UNIQUE] INDEX IF NOT EXISTS`·`ALTER COLUMN … DROP NOT NULL` 만. DROP·TRUNCATE·컬럼 이름 변경 없음.
시간은 전부 BIGINT 밀리초. 부모(`server.js`)가 `db.migrate()` 를 끝낸 뒤에 sender 자식을 띄우므로 sender 는 이 표들이 있다고 가정한다.

```sql
-- [회원] ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS members (
  id                BIGSERIAL PRIMARY KEY,
  login_id          TEXT NOT NULL,
  pw_hash           TEXT NOT NULL,
  contact           TEXT,
  created_at        BIGINT NOT NULL,
  last_login_at     BIGINT,
  pw_changed_at     BIGINT,
  macro_until       BIGINT NOT NULL DEFAULT 0,   -- 카카오톡 매크로 만료(ms). 0 = 없음
  legacy_room_until BIGINT NOT NULL DEFAULT 0,   -- D20 계정 단위 옛 기능 유예 만료
  blocked_reason    TEXT,
  note              TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS members_login_uq ON members (lower(login_id));

CREATE TABLE IF NOT EXISTS member_sessions (
  id           TEXT PRIMARY KEY,                 -- sha256(쿠키 토큰) hex 64자
  member_id    BIGINT NOT NULL REFERENCES members(id),
  method       TEXT NOT NULL,                    -- 'pw' | 'google'
  created_at   BIGINT NOT NULL,
  auth_at      BIGINT NOT NULL,                  -- 마지막 인증 시각(비밀번호 재설정 창 계산)
  last_seen_at BIGINT NOT NULL,
  expires_at   BIGINT NOT NULL,
  revoked_at   BIGINT,
  revoked_why  TEXT,                             -- logout|cap|pw_change|logout_all|admin|blocked|revoke
  ip           TEXT,
  ua           TEXT
);
CREATE INDEX IF NOT EXISTS idx_msess_member ON member_sessions (member_id, last_seen_at DESC);

CREATE TABLE IF NOT EXISTS member_google (
  member_id BIGINT PRIMARY KEY REFERENCES members(id),
  sub       TEXT NOT NULL,
  email     TEXT,
  linked_at BIGINT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS member_google_sub_uq ON member_google (sub);

-- [기존 표에 회원 연결] ──────────────────────────────
ALTER TABLE licenses       ADD COLUMN IF NOT EXISTS member_id BIGINT, ADD COLUMN IF NOT EXISTS claimed_at BIGINT;
ALTER TABLE panel_accounts ADD COLUMN IF NOT EXISTS member_id BIGINT;
ALTER TABLE panel_accounts ALTER COLUMN license_key DROP NOT NULL;
ALTER TABLE panel_pending  ADD COLUMN IF NOT EXISTS member_id BIGINT;
ALTER TABLE panel_pending  ALTER COLUMN license_key DROP NOT NULL;
ALTER TABLE audit_log      ADD COLUMN IF NOT EXISTS member_id BIGINT;
ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS member_id BIGINT,
  ADD COLUMN IF NOT EXISTS kind      TEXT,       -- 'member' = 새 주문. NULL = 예전 키 주문
  ADD COLUMN IF NOT EXISTS items     JSONB,      -- 2.3
  ADD COLUMN IF NOT EXISTS applied   JSONB,      -- 2.3
  ADD COLUMN IF NOT EXISTS ip        TEXT,       -- 접수한 IP(IP당 미입금 상한, D22)
  ADD COLUMN IF NOT EXISTS terms_at  BIGINT;     -- 이용 조건 확인 시각(방 줄이 있는 주문, D28)
CREATE INDEX IF NOT EXISTS idx_lic_member       ON licenses (member_id);
CREATE INDEX IF NOT EXISTS idx_panel_acc_member ON panel_accounts (member_id);
CREATE INDEX IF NOT EXISTS idx_panel_pend_member ON panel_pending (member_id);
CREATE INDEX IF NOT EXISTS idx_audit_member     ON audit_log (member_id);
CREATE INDEX IF NOT EXISTS idx_orders_member    ON orders (member_id, created_at DESC);

-- [봇 계정 풀] ───────────────────────────────────────
CREATE TABLE IF NOT EXISTS bot_accounts (
  device_id  TEXT PRIMARY KEY,                   -- 'bot.' + 16 hex
  email      TEXT NOT NULL,                      -- 카카오계정 (관리자 표시용)
  label      TEXT,
  nickname   TEXT,                               -- sender 가 접속할 때 채운다
  room_cap   INT NOT NULL DEFAULT 20,
  enabled    BOOLEAN NOT NULL DEFAULT TRUE,      -- FALSE = 새 배정 중지(맡은 방은 유지)
  state      TEXT NOT NULL DEFAULT 'pending',    -- sender 가 씀: pending|connected|down|needs_register
  state_at   BIGINT,
  created_at BIGINT NOT NULL,
  removed_at BIGINT,
  note       TEXT
);
CREATE TABLE IF NOT EXISTS bot_pending (
  pending_id TEXT PRIMARY KEY,
  device_id  TEXT NOT NULL,
  email      TEXT NOT NULL,
  label      TEXT,
  room_cap   INT,
  created_at BIGINT NOT NULL,
  expires_at BIGINT NOT NULL
);

-- [방 설치] ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS room_installs (
  id            BIGSERIAL PRIMARY KEY,
  member_id     BIGINT NOT NULL REFERENCES members(id),
  link_url      TEXT NOT NULL,                   -- 정규화한 https://open.kakao.com/o/XXXX
  link_id       TEXT,                            -- 10진 문자열. 아직 조회 전이면 NULL
  link_name     TEXT,
  passcode_ct   TEXT,                            -- 참여코드 봉인값(lib/secretbox.js). 없으면 NULL
  roombot       BOOLEAN NOT NULL DEFAULT FALSE,  -- 결제(또는 지급)된 상품
  minigame      BOOLEAN NOT NULL DEFAULT FALSE,
  phase         TEXT NOT NULL,                   -- 부모가 씀: pending_payment|installed|canceled|removed
  order_id      TEXT,                            -- 이 행을 만든 주문. 관리자 지급이면 NULL
  bot_device_id TEXT,                            -- 부모가 배정
  hold_reason   TEXT,                            -- D28 운영자 확인 대기. NULL 이 아니면 sender 가 입장하지 않음
  retry_n       INT NOT NULL DEFAULT 0,          -- 고객 연속 다시 시도 횟수(3.4.3). 입장 성공 뒤 첫 다시 시도에서 0 으로
  state         TEXT NOT NULL DEFAULT 'queued',  -- sender 가 씀(부모는 queued 로 되돌릴 때만, 2.2): queued|joining|waiting_host|active|error
  error_code    TEXT,                            -- 5.6
  error_detail  TEXT,                            -- 원시 status·짧은 설명(관리자용)
  chat_id       TEXT,
  perm          INT,
  perm_at       BIGINT,
  joined_at     BIGINT,
  state_at      BIGINT,
  next_try_at   BIGINT,                          -- 입장 재시도 예정(속도 제한 대기)
  retry_at      BIGINT,                          -- 마지막 수동 다시 시도
  attempts      INT NOT NULL DEFAULT 0,
  config        JSONB NOT NULL DEFAULT '{}',     -- 7.1
  config_rev    INT NOT NULL DEFAULT 0,
  config_at     BIGINT,
  created_at    BIGINT NOT NULL,
  installed_at  BIGINT,
  removed_at    BIGINT,
  note          TEXT
);
-- 결제된 설치만 배타적이다(D8·D9). 내보내진 설치(error_code='kicked')는 배타권을 잃는다.
CREATE UNIQUE INDEX IF NOT EXISTS room_installs_link_uq ON room_installs (link_id)
  WHERE link_id IS NOT NULL AND phase = 'installed' AND error_code IS DISTINCT FROM 'kicked';
CREATE UNIQUE INDEX IF NOT EXISTS room_installs_url_uq ON room_installs (link_url)
  WHERE phase = 'installed' AND error_code IS DISTINCT FROM 'kicked';
CREATE INDEX IF NOT EXISTS idx_ri_member ON room_installs (member_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ri_bot    ON room_installs (bot_device_id) WHERE phase = 'installed';
CREATE INDEX IF NOT EXISTS idx_ri_state  ON room_installs (phase, state);
CREATE INDEX IF NOT EXISTS idx_ri_order  ON room_installs (order_id);
CREATE INDEX IF NOT EXISTS idx_ri_link   ON room_installs (link_id);
CREATE INDEX IF NOT EXISTS idx_ri_url    ON room_installs (link_url);

-- 나가기 대기열(옮기기·해제·링크 바꾸기 때 부모가 넣고 sender 가 처리). 입장보다 먼저 처리한다(5.2)
CREATE TABLE IF NOT EXISTS room_leaves (
  id            BIGSERIAL PRIMARY KEY,
  install_id    BIGINT NOT NULL,
  bot_device_id TEXT NOT NULL,                   -- 나갈 봇
  chat_id       TEXT,                            -- 넣을 때의 room_installs.chat_id 복사본(NULL 이면 link_id 로 찾음)
  link_id       TEXT,
  why           TEXT NOT NULL,                   -- move|remove|rebind|block
  created_at    BIGINT NOT NULL,
  done_at       BIGINT,
  result        TEXT                             -- left|kept|not_in_room|failed:<status>
);
CREATE INDEX IF NOT EXISTS idx_room_leaves_todo ON room_leaves (bot_device_id) WHERE done_at IS NULL;

-- 설치 금지 방(D28)
CREATE TABLE IF NOT EXISTS room_blocklist (
  id         BIGSERIAL PRIMARY KEY,
  link_id    TEXT,
  link_url   TEXT,
  reason     TEXT NOT NULL,
  created_at BIGINT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS room_block_link_uq ON room_blocklist (link_id) WHERE link_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS room_block_url_uq  ON room_blocklist (link_url) WHERE link_url IS NOT NULL;

-- [sender 소유: 방별 실행 상태와 조치 기록] ───────────
CREATE TABLE IF NOT EXISTS room_state (
  install_id BIGINT PRIMARY KEY,
  runtime    JSONB NOT NULL DEFAULT '{}',
  updated_at BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS room_log (
  id         BIGSERIAL PRIMARY KEY,
  install_id BIGINT NOT NULL,
  at         BIGINT NOT NULL,
  kind       TEXT NOT NULL,                      -- 7.8
  user_id    TEXT,
  name       TEXT,
  ok         BOOLEAN NOT NULL DEFAULT TRUE,
  detail     JSONB NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_room_log ON room_log (install_id, at DESC);

-- [봇 오픈프로필(D12, 5.8)] 단계 이름 accounts-v1:bot_accounts.open_profile. 칸 추가뿐, 모두 NULL 허용
ALTER TABLE bot_accounts
  ADD COLUMN IF NOT EXISTS open_profiles     JSONB,     -- sender: SYNCLINK 로 읽은 [{li,name,url}] (NULL = 읽은 적 없음, [] = 없음)
  ADD COLUMN IF NOT EXISTS open_profile_pick TEXT,      -- 부모(관리자): 고른 오픈프로필 li. NULL = 자동
  ADD COLUMN IF NOT EXISTS open_profile_li   TEXT,      -- sender: 지금 입장에 쓰는 오픈프로필 li(없으면 NULL)
  ADD COLUMN IF NOT EXISTS open_profile_name TEXT,      -- sender: 그 이름(방장에게 보이는 봇 이름)
  ADD COLUMN IF NOT EXISTS open_profile_at   BIGINT;    -- sender: 목록을 마지막으로 읽은 시각

-- [고객 봇 옮기기·다시 설치(3.4.3)] 단계 이름 upd-1017:room_installs.self_moves. 부모 칸, 칸 추가뿐, NULL 허용
ALTER TABLE room_installs
  ADD COLUMN IF NOT EXISTS self_move_at      BIGINT,    -- 고객이 마지막으로 다른 방으로 옮긴 때(ROOM_SELF_MOVE_GAP_MS)
  ADD COLUMN IF NOT EXISTS self_reinstall_at BIGINT;    -- 고객이 마지막으로 같은 방에 다시 설치한 때(ROOM_SELF_REINSTALL_GAP_MS)
```

`room_state`·`room_log` 는 sender 의 `store.mjs` `SCHEMA` 에도 **글자 그대로** 넣는다(sender 단독 실행용, `IF NOT EXISTS` 라 겹쳐도 안전).
`room_installs`·`bot_accounts`·`bot_pending`·`room_leaves`·`room_blocklist` 는 `lib/db.js` 에만 있다.
이 2.1 블록 전체는 9.0 의 0단계 커밋이 `lib/db.js` 에 넣는다(병렬 작업이 모두 이 표들에 기대므로).

### 2.2 쓰기 소유권 (서로의 칸을 쓰지 않는다)

| 표·칸 | 쓰는 쪽 | 메모 |
|---|---|---|
| `members`, `member_sessions`, `member_google` | 부모 | |
| `room_installs` 의 `member_id link_url passcode_ct roombot minigame phase order_id bot_device_id hold_reason retry_n config* retry_at self_move_at self_reinstall_at installed_at removed_at note` | 부모 | |
| 〃 "다시 입장" 묶음 | 부모 | 배정·다시 시도·옮기기·링크 바꾸기 때 부모는 **한 UPDATE 로** `state='queued', error_code=NULL, error_detail=NULL, next_try_at=NULL, perm=NULL, perm_at=NULL, state_at=$now` 를 함께 쓴다(이 칸들을 부모가 쓰는 유일한 경우). `assignBot` 이 봇을 못 찾았을 때 `error_detail='no_bot'` 을 쓰는 것도 이 예외에 든다 |
| `room_installs` 의 `state error_code error_detail chat_id perm perm_at joined_at state_at next_try_at attempts link_id link_name`(조회 결과) | sender | 항상 `WHERE id=$1 AND phase='installed' AND bot_device_id=$봇` 조건으로만(옮긴 뒤 옛 봇이 덮어쓰지 못하게) |
| 〃 `config config_rev config_at` (방 안 설정 명령어) | sender(예외) | 방장·부방장이 방에서 기능을 켜고 끌 때만(7.2 (g)). 패널 저장과 같은 규칙: 저장본을 다시 읽어 바꾼 칸만 합치고(모르는 칸 유지) `AND config_rev=$읽은 값` 일 때만 쓰며 `config_rev+1`. 패널과 겹치면 다시 읽어 3번까지. 위 `WHERE` 조건도 그대로(`store.saveRoomConfig`) |
| `room_leaves` | 부모가 INSERT(와 30일 지난 처리 행 삭제), sender 가 `done_at result` | sender 는 `WHERE id=$1 AND bot_device_id=$봇` |
| `room_blocklist` | 부모 | sender 는 읽기만 |
| `bot_accounts` 의 `nickname state state_at` | sender | 나머지 칸은 부모(관리자). 예외: sender 는 `bot.` 등록이 끝나면 `INSERT … (device_id, email, created_at, state) ON CONFLICT DO NOTHING` 으로 최소 행을 만든다(3.5, 봇이 고아가 되지 않게) |
| `bot_accounts` 의 `open_profiles open_profile_li open_profile_name open_profile_at` | sender | 오픈프로필(D12, 5.8): SYNCLINK 로 읽은 목록 `[{li,name,url}]`(NULL = 읽은 적 없음, `[]` = 없음)과 지금 입장에 쓰는 것. 읽기에 실패하면 남긴 값을 지우지 않는다 |
| `bot_accounts` 의 `open_profile_pick` | 부모(관리자) | 고른 오픈프로필 li. NULL = 자동(지금 쓰던 것 → 목록의 첫 번째). sender 는 읽기만 |
| `room_state`, `room_log` | sender | 부모는 읽기 + 하루 1번 오래된 `room_log` 삭제 |
| `kakao_sessions` | sender | 부모는 지금처럼 `/v1/*` 로만 바꾼다 |

### 2.3 JSON 모양

**`orders.items`** — 줄 단위. 방 상품은 상품마다 한 줄이고 항상 `install_id` 가 있다(주문 접수 때 예약하거나 기존 설치를 가리킴).

```json
[
  { "product": "macro",    "months": 2, "unit_price": 15000, "amount": 30000 },
  { "product": "roombot",  "install_id": 12, "link_url": "https://open.kakao.com/o/gAbCdEf", "link_name": "동네모임", "unit_price": 10000, "amount": 10000 },
  { "product": "minigame", "install_id": 12, "link_url": "https://open.kakao.com/o/gAbCdEf", "link_name": "동네모임", "unit_price": 10000, "amount": 10000 }
]
```

참여코드는 `items` 에 넣지 않는다(설치 행의 `passcode_ct` 에만).
새 주문은 `kind='member'`, `features` = 상품 id CSV(예 `macro,roombot,minigame`), `plan='member'`, `target_key`·`issued_key` 는 NULL, `ip` = `rl.ipOf(req)`, 방 줄이 있으면 `terms_at` = 접수 시각.
방 줄에는 확인하지 못한 방(D10)이면 `"unverified": true` 가 붙는다(관리자 화면 표시용).

**`orders.applied`** — 승인 때 실제로 적용한 것.

```json
{ "macro": { "days": 60, "until": 1767225600000 },
  "rooms": [ { "install_id": 12, "products": ["roombot","minigame"] } ],
  "skipped": [ { "install_id": 13, "products": ["minigame"], "amount": 10000, "why": "room_taken" } ] }
```

`skipped` 는 관리자가 충돌 줄을 빼고 승인했을 때만 있다(4.2). 그 금액은 운영자가 환불한다.
예전 키 주문이 이관된 키를 가리켜 회원에게 적용된 경우(4.2) `{"legacy_to_member": true, "macro": {...}, "legacy_room_until": ms}`.

**`kakao_sessions.features` v2** — 부모가 `/v1/grants` 로 민다(5.1).

```json
{ "v": 2, "macro_until": 1767225600000, "legacy_room_until": 0, "grants_at": 1767000000000, "reg_at": 1766000000000 }   // 고객 계정
{ "v": 2, "bot": true }                                              // 봇 계정
```

`grants_at` = sender 가 마지막으로 `/v1/grants` 값을 받은 시각, `reg_at` = 등록(`storeSession`) 시각. 둘 다 sender 가 채운다(전체 밀기의 경합 방지, 3.6).

**`room_installs.config`** — 7.1 에 정의.

---

## 3. API 계약

### 3.1 공통

- 응답: 성공 `{ ok:true, … }`, 실패 `{ ok:false, reason:'<영문 코드>', error:'<화면에 그대로 보일 한국어>' }`. 화면은 `reason` 으로 칸을 고르고 `error` 를 그대로 보여 준다.
- 상태 코드: 400 입력 오류, 401 로그인 필요, 403 권한·차단, 404 없음, 409 상태 충돌, 415 JSON 아님, 429 과다요청, 503 서버 설정·sender 없음.
- 401 문구는 항상 `로그인이 필요합니다. 다시 로그인하십시오.` 이고, 동시 로그인 상한으로 끊긴 세션이면 `reason:'session_evicted'`, `error:'다른 기기에서 로그인하여 이 기기는 로그아웃되었습니다. 동시에 로그인할 수 있는 기기는 3대입니다.'` 다.
- 인증: "회원" = `memberAuth.requireMember` 통과(차단된 회원은 403 `blocked`, `이용이 정지된 계정입니다. 문의하십시오.`).
- 문의 문구: 서버 `error` 는 `…문의하십시오.` 까지만 쓰고 "실시간 상담"을 넣지 않는다. 화면이 `[data-support]` 버튼(상담 또는 연락처, 6.10)을 그 옆에 붙인다. 상담 창이 없는 환경에서 없는 창을 가리키지 않기 위해서다.
- CSRF: 8.3 의 `sameOriginWrites` 가 `/api/auth/`, `/api/order`(POST), `/api/room-preview`, `/api/my/`, `/panel/api/` 의 쓰기 요청에 적용된다. 프런트의 `fetch` 는 이미 JSON 만 보낸다.
- 레이트리밋 종류(`lib/ratelimit.js` `KIND_LIMITS`·`kindOf`, 분당, 환경변수로 덮어씀):

| kind | 환경변수 | 기본 | 경로 |
|---|---|---|---|
| `auth` | `RATE_AUTH_PER_MIN` | 10 | POST `/api/auth/login` `/api/auth/password` `/api/auth/claim` `/api/auth/google/unlink` |
| `signup` | `RATE_SIGNUP_PER_MIN` | 5 | POST `/api/auth/signup` (+ 라우트 안에서 IP당 시간 20회) |
| `oauth` | `RATE_OAUTH_PER_MIN` | 20 | GET `/auth/google/start` `/auth/google/callback` |
| `preview` | `RATE_PREVIEW_PER_MIN` | 20 | POST `/api/room-preview` (+ 회원당 시간 60회. 전체 카카오 조회량은 sender 예산이 막는다, 5.3), POST `/panel/api/bot-room/move`(봇 옮기기, + 회원당 시간 20회, 3.4.3) |
| `member` | `RATE_MEMBER_PER_MIN` | 180 | 나머지 `/api/auth/*`, GET `/api/site` `/api/me` `/api/my/*`, POST `/api/my/orders/cancel` |
| `demo` | `RATE_DEMO_PER_MIN` | 180 | GET `/api/demo`, POST `/api/demo/start` `/api/demo/step` (사이트 체험 3.7, 로그인 없음 · 서버 안에서만 계산하고 카카오에는 보내지 않는다) |
| 기존 | | | `order-read` `order-write` `deposit` `admin` `panel` 그대로. `panel-login` 은 키 로그인이 없어지므로 쓰지 않는다(정의는 남겨도 됨). `/v1/*` 는 더 이상 공개하지 않는다(8.5) |

- 로그인 실패 제한(`ratelimit.js` 의 관리자 실패 패턴을 복사, `sweep()`·`resetAll()` 에 포함). 아이디는 존재 여부와 무관하게 센다.
  - **잠금**은 `(아이디, IP)` 쌍 단위: 15분에 10회 실패 → 그 IP 에서 그 아이디로 15분 로그인 불가(429 `locked`, `LOGIN_FAIL_MAX` 10, `LOGIN_BLOCK_MS` 900000). `noteLoginFail(id, ip)`·`loginBlockedMs(id, ip)`·`clearLoginFails(id, ip)`.
  - **아이디 단독**으로는 잠그지 않고 늦춘다: 15분에 30회를 넘으면 그 아이디의 이후 시도마다 응답 전 2초 대기(`loginSlowMs(id)`, 비밀번호 검사 전). 남이 아이디만 알고 본인을 내쫓을 수 없게 하기 위해서다.
  - `/api/auth/password` 의 `wrong_current` 와 `/api/auth/google/unlink` 의 비밀번호 실패도 같은 `(login_id, IP)` 계수기에 센다.
  - 순서: 레이트리밋 → `loginBlockedMs` → `loginSlowMs` → scrypt(8.1 세마포어). 잠겼으면 해시하지 않는다.
  - 잠겨도 Google 로그인은 된다.

### 3.2 회원·인증 (`routes/auth.js`, 작업 1)

| 메서드·경로 | 인증 | 요청 | 성공 응답 | 실패 |
|---|---|---|---|---|
| GET `/api/site` | 없음(쿠키 있으면 읽음) | — | `{ok, google:bool, channel:null\|{plugin_key, member_id?, member_hash?, name?}, contact:null\|string, member:null\|{id, login_id, google_linked}}`, `Cache-Control: no-store`. `contact` = `pricing.contactInfo()`(상담 창이 없을 때 보일 연락처). 401 을 내지 않는다 | — |
| POST `/api/auth/signup` | 없음 | `{login_id, password, contact?}` | `{ok, member}` + 세션 쿠키 | 400 `bad_login_id`·`reserved_id`·`bad_password`, 409 `taken` |
| POST `/api/auth/login` | 없음 | `{login_id, password}` | `{ok, member, evicted:n}` + 쿠키 | 401 `bad_credentials`, 403 `blocked`, 429 `locked` (`retry_after` 초) |
| POST `/api/auth/logout` | 회원 | `{}` | `{ok}` 쿠키 지움(옛 `panel` 쿠키도 Path=/panel 로 지움) | — |
| POST `/api/auth/logout-all` | 회원 | `{}` | `{ok, ended:n}` 지금 기기만 남기고 끊음 | — |
| GET `/api/auth/sessions` | 회원 | — | `{ok, sessions:[{sid, current, method, created_at, last_seen_at, device, ip}]}` (`sid`=id 앞 16자, `device`=UA 요약 예 `Windows · Chrome`, `ip`=마지막 옥텟 가림) | — |
| POST `/api/auth/sessions/revoke` | 회원 | `{sid}` | `{ok}` | 404 |
| POST `/api/auth/password` | 회원 | `{current?, next}` | `{ok}` 다른 기기 전부 로그아웃, 지금 세션은 유지 | 400 `bad_password`, 401 `wrong_current`, 403 `reauth_needed`(current 없음 + 재설정 창 지남) |
| POST `/api/auth/claim` | 회원 | `{key}` | `{ok, moved:{macro_until, legacy_room_until, accounts:n}}` | 404 `not_found`, 409 `claimed`(이미 이관됨), 403 `key_blocked`(회수·차단 키) |
| GET `/api/me` | 회원 | — | 3.2.1 | — |
| POST `/api/auth/google/unlink` | 회원 | `{password}` | `{ok}` | 401 `wrong_current`, 404 `not_linked` |
| GET `/auth/google/start?mode=link\|login&next=/path` | link: 회원(최근 비밀번호 로그인) | — | 302 Google | 302 `?g=off\|webview\|login_needed\|relogin` |
| GET `/auth/google/callback` | 상태 쿠키 | — | 302 `next?g=linked` 또는 로그인 후 `next` | 302 `?g=expired\|denied\|error\|taken\|already\|not_linked\|blocked` |

`member` 모양(어디서나 같음): `{ id, login_id, google_linked:bool, google_email_masked: 'ab***@gmail.com'|null }`.

#### 3.2.1 `GET /api/me`

```json
{ "ok": true,
  "member": { "id": 7, "login_id": "kbuser", "google_linked": true, "google_email_masked": "kb***@gmail.com", "created_at": 0 },
  "macro":  { "until": 1767225600000, "active": true, "days_left": 12 },
  "legacy_room_until": 0,
  "accounts": { "n": 1, "max": 3 },
  "rooms":  { "total": 2, "active": 1, "attention": 1 },
  "rooms_list": [ /* RoomView 3.4.2, 최대 50 */ ],
  "password_reset_open": false }   // 지금 세션이 Google 로그인이고 AUTH_RESET_WINDOW_MS 안이면 true
```

#### 3.2.2 `?g=` 코드와 문구 (로그인·내 계정 화면이 `.note` 로 보여 줌)

| g | 화면 | 문구 |
|---|---|---|
| `linked` | 내 계정 | Google 계정을 연결했습니다. |
| `off` | 로그인 | Google 로그인을 지금 사용할 수 없습니다. 아이디로 로그인하십시오. |
| `webview` | 로그인 | 카카오톡 안 브라우저에서는 Google 로그인이 제한됩니다. 외부 브라우저에서 여십시오. (+ `kakaotalk://web/openExternal?url=` 버튼 `외부 브라우저로 열기`) |
| `login_needed` | 로그인 | Google 계정을 연결하려면 먼저 아이디로 로그인하십시오. |
| `relogin` | 로그인 | Google 계정을 연결하기 전에 본인 확인이 필요합니다. 아이디와 비밀번호로 다시 로그인하십시오. |
| `expired` | 둘 다 | 확인 시간이 지났습니다. 다시 시도하십시오. |
| `denied` | 둘 다 | Google 계정 확인을 취소했습니다. |
| `error` | 둘 다 | Google 계정을 확인하지 못했습니다. 잠시 뒤 다시 시도하십시오. |
| `taken` | 내 계정 | 이 Google 계정은 다른 회원에게 연결되어 있습니다. |
| `already` | 내 계정 | 이미 다른 Google 계정이 연결되어 있습니다. 연결을 해제한 뒤 다시 시도하십시오. |
| `not_linked` | 로그인 | 연결된 회원이 없습니다. 아이디로 로그인한 뒤 내 계정에서 Google 계정을 연결하십시오. |
| `not_linked` + `next` 에 `recover` | 로그인 | Google 계정이 연결된 회원이 없습니다. 비밀번호를 잊었고 Google 계정을 연결하지 않은 경우, 문의하기로 아이디를 전달하면 확인 뒤 임시 비밀번호를 안내합니다. (+ `[data-support]` `문의하기`) |
| `blocked` | 로그인 | 이용이 정지된 계정입니다. 문의하십시오. (+ `[data-support]`) |
| `recover` | 내 계정 `#password` | Google 계정으로 확인되었습니다. 15분 안에 새 비밀번호를 정하십시오. |

**Google 흐름** (`lib/google-oauth.js` + `routes/auth.js`, 작업 1). 외부 라이브러리 없이 Node 내장 `crypto`·`fetch` 만 쓴다.

공통:
- `redirect_uri = GOOGLE_REDIRECT_URI || purchaseBase(req) + '/auth/google/callback'`. 운영은 `PURCHASE_BASE=https://kmacro.cloud` 필수.
- 상태 쿠키 `kb_o`: `Path=/auth/google; HttpOnly; SameSite=Lax; Secure(https); Max-Age=600`, 값 = `base64url(JSON) + '.' + base64url(HMAC-SHA256(k, base64url(JSON)))`, `k = HKDF-SHA256(ikm=CONFIG_SECRET, salt='kbot', info='kbot/oauth/v1', 32)`. JSON = `{s: state, cv: code_verifier, n: nonce, md: 'link'|'login', m: member_id|null, sid: 세션 id 앞 16자|null, nx: next, e: 만료 ms}`.
- 모든 Set-Cookie 는 `res.append('Set-Cookie', …)` 로 쓴다(`setHeader` 는 덮어쓴다).
- `next` 는 `^/(?!/)[\w\-./?=&#%]{0,200}$` 만, 아니면 `/account`. 결과 코드는 `next` 에 `g=<코드>` 를 붙여(이미 `?` 가 있으면 `&`) 돌려보낸다. 로그인 화면으로 보내는 코드는 `/login?g=<코드>&next=<원래 next>`.
- `GOOGLE_AUTH_URL`(기본 `https://accounts.google.com/o/oauth2/v2/auth`)·`GOOGLE_TOKEN_URL`(기본 `https://oauth2.googleapis.com/token`) 덮어쓰기는 `https:` 이거나 `http://localhost|127.0.0.1|[::1]` 일 때만 받는다(오프라인 시험용).

B1 `GET /auth/google/start?mode=&next=`:
1. Google 미설정(`GOOGLE_CLIENT_ID`·`GOOGLE_CLIENT_SECRET` 중 하나라도 없음) → 302 `/login?g=off`.
2. UA 가 웹뷰(`/KAKAOTALK|NAVER\(inapp|Instagram|FBAN|FBAV|Line\/|; wv\)/i`) → 302 `/login?g=webview&next=…`(링크 모드는 `/account?g=webview`).
3. 요청 호스트가 `purchaseBase` 의 호스트와 다르면 같은 경로·쿼리로 `purchaseBase` 에 302(쿠키가 콜백 호스트에 붙게).
4. `mode=link` 는 회원 세션 필수(없으면 302 `/login?g=login_needed&next=/account`). 그 세션이 아이디·비밀번호 로그인(`method='pw'`)이고 `auth_at` 이 `AUTH_RESET_WINDOW_MS` 안이어야 한다. 아니면 302 `/login?g=relogin&next=<encodeURIComponent('/auth/google/start?mode=link&next=' + encodeURIComponent(next))>` — 비밀번호로 다시 로그인하면 연결이 바로 이어진다. Google 연결은 "현재 비밀번호 없이 비밀번호를 정할 수 있는" 권한(`resetOpen`)을 주므로 비밀번호 변경만큼 엄격해야 한다: 훔친 세션 쿠키만으로 공격자 자신의 Google 을 연결해 두고 나중에 비밀번호를 바꿔 계정을 빼앗지 못하게. `mode=login` 은 세션이 없어도 된다.
5. `state` = 32바이트, `code_verifier` = 32바이트(base64url 43자), `nonce` = 16바이트(모두 `crypto.randomBytes` → base64url). 쿠키 `kb_o` 를 쓴다(`e = now + 600000`).
6. 302 `GOOGLE_AUTH_URL?client_id&redirect_uri&response_type=code&scope=openid%20email&state&nonce&code_challenge=base64url(sha256(code_verifier))&code_challenge_method=S256&prompt=select_account`.

B2 `GET /auth/google/callback` — 들어오자마자 `kb_o` 를 지우는 Set-Cookie(`Max-Age=0`)를 붙인다(어느 결과든):
1. 쿠키 없음·서명 불일치(`timingSafeEqual`)·`e < now` → `expired`. 쿼리 `state` 와 쿠키 `s` 비교(`timingSafeEqual`) 불일치 → `expired`.
2. 쿼리 `error=access_denied` → `denied`, 그 밖의 `error` → `error`.

B3 토큰 교환: `POST GOOGLE_TOKEN_URL`(`application/x-www-form-urlencoded`: `code, client_id, client_secret, redirect_uri, grant_type=authorization_code, code_verifier`), 10초 제한. 200 이 아니거나 `id_token` 이 없으면 `error`.

B4 `id_token` 검사: 토큰 끝점에서 TLS 로 직접 받았으므로 서명 대신 아래를 검사한다(OIDC Core 3.1.3.7). payload = 두 번째 조각 base64url JSON.
`iss ∈ {'https://accounts.google.com','accounts.google.com'}`, `aud === GOOGLE_CLIENT_ID`, `azp` 가 있으면 `=== GOOGLE_CLIENT_ID`, `exp*1000 > now - 60000`, `iat*1000 < now + 60000`, `nonce === 쿠키 n`, `sub` 는 1~255자 문자열. 하나라도 어긋나면 `error`. `email` 은 표시용(없어도 됨).

B5 적용:
- `md='link'`: 지금 세션이 있고 `member.id === m` 이며 세션 id 앞 16자 `=== sid` 여야 한다(아니면 `expired`). B1-4 의 최근 비밀번호 로그인 조건을 다시 본다(Google 화면에 머문 시간만큼 상태 쿠키 수명 600초를 더 봐준다, 아니면 B1-4 와 같은 `relogin` 주소). 이 회원에 다른 `sub` 가 이미 있으면 `already`, 이 `sub` 가 다른 회원에 있으면 `taken`, 같으면 `linked`(멱등). 새로 넣으면 `member_google` INSERT + 감사 `member google_link` → `nx?g=linked`.
- `md='login'`: `member_google.sub` 로 회원을 찾는다. 없으면 `/login?g=not_linked&next=nx`, 차단이면 `/login?g=blocked`. 있으면 `startSession(req, res, id, 'google')`(`auth_at=now`), `member_google.email` 갱신, `last_login_at` 갱신 → 302 `nx`. 로그인 실패 계수기는 건드리지 않는다.
- "비밀번호를 잊은 경우" 링크 = `/auth/google/start?mode=login&next=%2Faccount%3Fg%3Drecover%23password`.

B6 시험용 가짜 Google(작업 1 의 `e2e-auth.js` 안, 같은 파일을 최종 통합 시험이 재사용): `http://127.0.0.1:<port>` 에 `GET /auth`(쿼리를 저장하고 302 `redirect_uri?code=<무작위>&state=<그대로>`; 시험이 `?deny=1` 을 붙이면 `error=access_denied`), `POST /token`(코드 1회용, `code_verifier` 의 S256 이 저장한 `code_challenge` 와 같아야 200; `id_token` = `base64url({"alg":"none"}).base64url({iss:'https://accounts.google.com', aud, sub, email, nonce, iat, exp}).x`, `sub`·`email` 은 시험이 `POST /set-user` 로 정함). `GOOGLE_AUTH_URL=http://127.0.0.1:<port>/auth`, `GOOGLE_TOKEN_URL=http://127.0.0.1:<port>/token`.

### 3.3 구매 (`routes/purchase.js`, 작업 2)

#### `GET /api/price` (인증 없음)

```json
{ "ok": true, "currency": "KRW",
  "products": [
    { "id": "macro",    "label": "카카오톡 매크로", "unit": "month", "price": 15000, "days": 30, "min": 1, "max": 12,
      "desc": "내 카카오 계정으로 대화방 주기 발송 · 이미지 첨부 · 갠톡 응답 · 저격 규칙" },
    { "id": "roombot",  "label": "방 관리봇", "unit": "room", "price": 10000,
      "desc": "입장·퇴장 로그 · 들낙 감지 · 나갔을 때 내보내기 · 프로필 로그 · 홍보 금지 · 가리기 · 금지어 검열 · 올킥 방지" },
    { "id": "minigame", "label": "미니게임봇", "unit": "room", "price": 10000,
      "desc": "끝말잇기 · 숫자야구 · 주사위 · 가위바위보 · 퀴즈 · 추억의 검 강화 · 랭킹" } ],
  "max_rooms": 10, "bank": "…", "contact": null, "purchase_base": "https://kmacro.cloud", "auto_approve": true }
```

#### `POST /api/room-preview` `{link:<붙여넣은 글>}` (회원, kind `preview`, `sameOriginWrites` 적용)

부작용 있는 조회(실제 봇 계정이 JOININFO 를 보냄)라 GET 이 아니라 POST 다(다른 사이트의 최상위 이동으로 부를 수 없게).

1. `openchat.parseLink(text)` 로 글에서 `https://open.kakao.com/o/<code>`(코드는 영문·숫자 1~40자)를 뽑는다(`installs.linkOf`). 방 제목이 링크 앞에 붙어 와도(`Tradehttps://…`) 받고, 보이지 않는 글자(U+200B 등)는 지운다. 코드 뒤에 `_`·`-` 가 이어지면 잘라 쓰지 않고 링크가 아닌 것으로 본다. 결과는 늘 `https://open.kakao.com/o/<code>` 한 모양이다.
   방 링크가 없으면: 오픈프로필 링크(`/me/`)는 400 `profile_link` `오픈프로필 링크입니다. K bot을 설치할 오픈채팅방의 링크(https://open.kakao.com/o/…)를 붙여 넣어 주세요.`, 게시물 링크(`/p/`)는 400 `post_link` `오픈채팅 게시물 링크입니다. …`, 그 밖은 400 `bad_link` `오픈채팅방 링크를 찾지 못했습니다. 카카오톡에서 방 링크(https://open.kakao.com/o/…)를 복사해 붙여 넣어 주세요.`
   구매 화면(`public/app.js` `normLink`)도 같은 식을 쓰고 `lib/purchase-check.js` 가 두 쪽 결과를 맞춰 본다. 구매 화면은 방 링크가 없어도 `open.kakao.com` 이 든 글이면 서버에 보내 위 이유 문구를 받는다.
2. `room_blocklist` 에 링크 주소가 있으면 403 `blocked_room` `이 방에는 K bot을 설치할 수 없습니다.` (카카오 조회 전).
3. 같은 URL 결과를 10분 메모리 저장(`installs.preview` 내부). sender `POST /v1/bot/resolve {url}`. 조회된 `link_id` 가 금지 목록에 있으면 403 `blocked_room`.
4. 응답:

```json
{ "ok": true, "verified": true,
  "room": { "link_url": "https://open.kakao.com/o/gAbCdEf", "link_id": "123456789", "name": "동네모임", "needs_passcode": false, "profile_only": false, "max_users": 1500 },
  "mine": { "install_id": 12, "products": { "roombot": true, "minigame": false }, "display": "active", "label": "사용 중" },
  "available": { "roombot": false, "minigame": true } }
```

- `mine` 은 이 회원의 살아 있는 설치(같은 link_id 또는 링크 주소, `phase` installed·pending_payment)가 있을 때만. `available.X=false` 이유: 이미 설치됨 또는 이 회원의 처리 대기 주문(`status IN ('pending','paid')`)에 들어 있음.
- `profile_only` 는 호환용으로 남기고 **늘 `false`** 다. K bot 은 방의 프로필 설정(`ol.pv & 32`)과 관계없이 오픈프로필로 입장한다(D12). sender `/v1/bot/resolve` 는 원래 값(`!(ol.pv & 32)`)을 그대로 주지만 부모 미리 보기가 `false` 로 내보내 옛 `.hint`(닉네임 프로필 입장 안내)가 나오지 않게 한다.
- 실패: 404 `not_found` `링크가 만료되었거나 없는 방입니다.`, 422 `not_group` `1:1 오픈채팅방 링크입니다. 그룹 오픈채팅방이나 커뮤니티 방의 링크를 붙여 넣어 주세요.`(JOININFO `lt` 가 1 일 때만), 409 `taken` `이 방에는 다른 회원이 설치한 K bot이 있습니다. 방장이라면 K bot 계정을 방에서 내보낸 뒤 다시 확인하거나 문의하십시오.`
- `taken` 은 **다른 회원의 결제된 설치**(`phase='installed'`, `error_code` 가 `kicked` 아님)가 같은 link_id·링크 주소에 있을 때만이다. 다른 회원의 미입금 주문은 막지 않는다(D9).
- sender 가 없거나, 연결된 봇이 없거나, 조회 예산이 바닥났으면(`sender_down`·`no_bot`·`budget`): `{ok:true, verified:false, room:{link_url, link_id:null, name:null, needs_passcode:null, profile_only:null}, mine:null, available:{roombot:true, minigame:true}}` (D10). URL 기준 `taken`·`blocked_room` 은 이 경우에도 검사한다.

#### `POST /api/order` (회원, kind `order-write`)

요청:
```json
{ "macro_months": 2,
  "rooms": [ { "link": "https://open.kakao.com/o/gAbCdEf", "passcode": "", "products": ["roombot","minigame"], "unverified_ok": false },
             { "install_id": 12, "products": ["minigame"] } ],
  "terms": true,
  "depositor": "홍길동", "contact": "", "memo": "" }
```

`rooms` 는 빈 배열이어도 된다(매크로만 구매). 화면은 링크가 비어 있고 상품도 고르지 않은 방 행을 보내지 않는다(6.6).

검증 순서와 오류(`room` 은 몇 번째 방인지, 화면이 `#err-room{i}-link` 에 붙임):

| reason | 상태 | error |
|---|---|---|
| `no_depositor` | 400 | 입금자명을 입력하십시오 |
| `empty` | 400 | 상품을 1개 이상 선택하십시오 |
| `bad_months` | 400 | 기간은 1~12개월로 입력하십시오 |
| `too_many_rooms` | 400 | 방은 한 번에 10개까지 주문할 수 있습니다 |
| `no_terms` | 400 | 방 설치 이용 조건을 확인하고 동의하십시오 (방 줄이 있을 때만) |
| `too_many_pending` | 429 | 입금 대기 중인 주문이 너무 많습니다. 입금하거나 내 계정에서 주문을 취소한 뒤 다시 신청하십시오 (회원 3건·방 줄 10개·IP 10건, D22) |
| `bad_link`·`profile_link`·`post_link` (room) | 400 | (preview 와 같음) |
| `no_products` (room) | 400 | 방마다 설치할 상품을 1개 이상 선택하십시오 |
| `not_found` (room, `install_id` 줄) | 404 | 없는 방입니다. 내 방 목록에서 다시 고르십시오 — `install_id` 가 이 회원 소유(`member_id=$me`)이고 `phase='installed'` 가 아니면. 가격 계산 전에 검사 |
| `duplicate_room` (room) | 400 | 이미 추가한 방입니다 |
| `blocked_room` (room) | 403 | (preview 와 같음) |
| `unverified` (room) | 400 | 방을 확인하지 못했습니다. 확인란에 동의하거나 잠시 뒤 다시 확인하십시오 (`verified:false` 인데 `unverified_ok` 가 아님) |
| `already_installed` (room) | 409 | 이 방에는 이미 {상품}이 설치되어 있습니다 |
| `pending_exists` (room) | 409 | 이 방은 입금 대기 중인 내 주문에 들어 있습니다. 내 계정의 구매 내역에서 확인하십시오 (이 회원 자신의 `pending`·`paid` 주문만) |
| `room_taken` (room) | 409 | (preview `taken` 과 같음) |
| `not_found`·`not_group` (room) | 404·422 | (preview 와 같음) |
| `bad_passcode` (room) | 400 | 참여코드는 20자 이하로 입력하십시오 |

처리:
1. 트랜잭션 밖: `install_id` 줄의 소유·phase 확인. 링크 행마다 `installs.preview`(10분 메모리 저장을 쓰므로 화면에서 확인한 방은 카카오를 다시 부르지 않음). 링크가 **이 회원의 기존 설치**와 같은 방(link_id, 미확인이면 URL)이면 그 행을 `{install_id, products}` 줄로 바꾼다. `ROOM_HOLD_WORDS` 에 방 이름이 걸리면 그 줄에 `hold:true` 를 표시한다(D28).
   트랜잭션 밖 미입금 상한 사전 검사(빠른 429) **앞에서** 48시간 지난 미입금 주문을 먼저 자동 취소한다(`keys.expireStalePending`, 짧은 트랜잭션 하나, D22). 그러지 않으면 방치된 주문만으로 상한에 걸린 회원·IP 가 자기 주문으로 그 주문들을 치우지 못하고(만료는 `pickAmount` 안에서 돈다) 계속 `too_many_pending` 을 받는다.
2. 한 트랜잭션: `pricing.quote` → `keys.pickAmount(client, total)`(전역 advisory lock 이라 주문 접수 자체가 직렬화됨) → 미입금 상한 검사(`SELECT count(*) … WHERE status='pending' AND (member_id=$me OR ip=$ip)`, 이 회원의 `pending_payment` 방 줄 수) → `uniqueOrderId` → 새 방마다 `installs.reserveForOrder(client, memberId, orderId, room)` → 기존 설치에 상품을 더하는 줄은 같은 설치·같은 상품이 처리 대기 주문(`status IN ('pending','paid')`, `orders.items` JSON 검사)에 있는지 확인 → `INSERT orders(… member_id, kind='member', items, ip, terms_at …)` → `audit('order', {member_id})`.
3. 충돌 검사(`reserveForOrder`·`grantRoom`·`rebind`·`retry`·`applyOrder` 공통 SQL): INSERT·UPDATE 전에 SELECT 로 확인한다(트랜잭션 안의 UNIQUE 위반은 트랜잭션 전체를 깨뜨리므로).
   - 다른 회원의 결제된 설치: `WHERE phase='installed' AND error_code IS DISTINCT FROM 'kicked' AND id <> $self AND (link_id = $L OR link_url = $U)` (`$L` 이 NULL 이면 `link_url = $U` 만) → `room_taken`.
   - 이 회원의 같은 방 예약: `WHERE member_id=$me AND phase='pending_payment' AND (link_id = $L OR link_url = $U)` → `pending_exists`.
   - 다른 회원의 미입금 예약은 검사하지 않는다(D9).
4. 그래도 경합으로 23505 가 나면 라우트가 트랜잭션 밖에서 잡아 409 `room_taken` 으로 답한다.

응답(지금 모양 + 줄): `{ok, id, token, url, amount, base_amount, suffix, needs_review, items:[공개 줄], bank, account, contact_info, auto_approve, created_at, status:'pending'}`. 공개 줄 = `{product, label, months?, install_id?, link_url?, link_name?, amount}`.

#### `GET /api/order/:id` (토큰 `?t=` **또는** 주문 주인 회원)

지금 응답에 더해 `kind`, `items`(공개 줄), `applied`(done 일 때), `can_cancel`(주인 회원이고 `pending`), `accounts_n`(보는 사람이 주인 회원일 때 그 회원의 카카오 계정 수, 아니면 null — 완료 버튼 선택용, 6.7), `rooms:[{install_id, link_url, link_name, display, label, detail, bot:{nickname}|null}]`(이 주문의 방들 현재 상태, RoomView 와 같은 `detail`·봇 닉네임 — 방장에게 어느 계정을 부방장으로 지정할지 알려 준다). `issued_key` 는 예전 주문에만 있다. 남의 주문은 토큰 없이는 404.

#### `GET /api/my/orders` (회원)

`{ok, orders:[{id, created_at, status, auto_canceled, amount, items, applied, url, can_cancel}]}` 최근 50건. `url` 은 토큰 포함 주문 화면 주소.

#### `POST /api/my/orders/cancel` `{id}` (회원)

이 회원의 `status='pending'` 주문만. 한 트랜잭션에서 `UPDATE orders SET status='canceled', auto_canceled=FALSE, handled_at=$now, memo = memo || ' · 회원 취소'` + `installs.cancelForOrder(client, id)` + 감사 `order`(detail `member_cancel`). 응답 `{ok}`. 오류: 404 `없는 주문입니다.`, 409 `not_pending` `입금이 확인된 주문은 취소할 수 없습니다. 문의하십시오.`
사람이 취소한 주문이므로 늦게 입금되어도 자동으로 되살리지 않는다(지금 `approveOrder` 규칙). 입금 웹훅은 `pending` 주문만 찾으므로 그 입금은 `unmatched` 로 남아 관리자가 처리한다. 화면은 확인 단계에서 `입금한 뒤에는 취소하지 마십시오.` 를 보인다.

#### `POST /api/lookup` (예전 키 조회) — 그대로 둔다. 응답에 `claimed:bool` 만 추가.

#### `POST /api/deposit-hook` — 외부 계약 그대로. 내부만 3.3.1.

#### 3.3.1 입금 매칭 뒤

`db.tx(c => keys.approveOrder(c, id, null))` 가 끝나고 **커밋 뒤에** `entitle.afterApprove(result)` 를 부른다(기다리지 않음, 실패는 로그만). 회원 주문이면 그 회원 계정들에 권리를 밀고(`/v1/grants`) 새 설치를 sender 에 알린다(`/v1/bot/sync`).
`setStatus` 를 트랜잭션 밖에서 하는 지금 구조는 그대로 둔다.
`approveOrder` 가 `{error, reason:'room_taken'}` 으로 끝나면(다른 회원이 같은 방을 먼저 입금, D9) 트랜잭션은 롤백되고 입금은 지금 규칙대로 `ambiguous`, 주문은 `pending` 그대로 + `UPDATE orders SET needs_review=TRUE` (트랜잭션 밖). 관리자가 `order-approve {skip_conflicts:true}` 로 나머지만 적용한다(3.5).
`DEPOSIT_AUTO_APPROVE=0` 이면 지금처럼 `paid` 로만 바꾼다. 중복 검사(`available`, `pending_products`, 상품 추가 줄 검사)는 `paid` 도 처리 대기로 센다.

### 3.4 콘솔 (`routes/panel.js`, 작업 1)

모든 경로: 회원 세션. **클라이언트가 보낸 `device_id`·`chat_id`·`install_id` 를 그대로 믿지 않는다** — 항상 회원 소유인지 DB(또는 60초 메모리 저장)로 확인한다. `bot.` 으로 시작하는 device_id 는 고객 경로에서 무조건 404.

#### 3.4.1 기존 경로 (회원 기준으로 바꿈)

| 경로 | 바뀌는 점 |
|---|---|
| POST `/panel/api/login` | 없앤다. 콘솔 로그인 화면은 `/api/auth/login` 을 부른다. `lib/panel-inbox-check.js` 의 routes/panel.js 소스 단언(58~86줄: 로그인 구간, `ownsDevice(`, `forgetAccounts(s.key)`)은 작업 1 이 회원 기준으로 고쳐 쓴다(9.1) |
| POST `/panel/api/logout` | `/api/auth/logout` 과 같은 동작(호환용) |
| GET `/panel/api/me` | 아래 모양 |
| GET `/panel/api/account` | 소유 확인을 `panel_accounts.member_id` 로. 응답 `account` 에 `legacy` (bool, 계정 단위 옛 기능을 보여 줄지) 추가 |
| POST `/panel/api/register/begin` | 새 계정이면: 매크로 이용 중(`macro_until>now`) 또는 유예 중(`legacy_room_until>now`) 아니면 403 `no_macro` `카카오 계정 등록은 카카오톡 매크로를 이용 중일 때 할 수 있습니다. 카카오톡 매크로를 구매한 뒤 다시 등록하십시오.`(화면은 `구매` 버튼 → `/buy?macro=1` 을 붙인다); 계정 수 ≥ `MEMBER_MAX_ACCOUNTS` 면 400 `카카오 계정은 3개까지 등록할 수 있습니다. 사용하지 않는 계정을 해제한 뒤 다시 시도하십시오.` 새 device_id = `ids.newMemberDeviceId(memberId)` = `'w' + sha256('member:'+id)[0:12] + '.' + 16hex`. `panel_pending`·`panel_accounts` 에 `member_id` 를 쓴다(license_key NULL) |
| register/confirm·cancel, unlink, rooms(카탈로그 새로고침), settings, inbox, chats, chat, chat/send, logs | 소유 확인만 회원 기준. 등록이 `ok` 로 끝나면(begin·confirm 어느 쪽이든) 바로 `entitle.pushGrants(memberId)`. settings·rooms 가 sender 에 보내던 `features: cfg.featuresFor(...)` 는 **보내지 않는다**(권리는 `/v1/grants` 만 바꾼다). settings 는 `legacy=false` 인 계정에 `visit·profile·guard·cover` 가 오면 403 `이 계정에서는 사용할 수 없는 기능입니다. 방 관리봇은 내 방에서 설정합니다.` |

`GET /panel/api/me`:
```json
{ "ok": true,
  "member": { "id": 7, "login_id": "kbuser", "google_linked": false },
  "macro": { "until": 0, "active": false, "days_left": 0 },
  "legacy_room_until": 0,
  "max_accounts": 3,
  "accounts": [ { "device_id": "w…", "email": "…", "linked": true, "needs_register": false, "connected": true, "reason": "ok" } ],
  "rooms": [ /* RoomView, 아래 */ ],
  "sender_up": true, "sender_reason": "" }
```

#### 3.4.2 RoomView (콘솔·내 계정·관리자 공통 모양, `installs.publicView`)

```json
{ "id": 12, "link_url": "https://open.kakao.com/o/gAbCdEf", "link_name": "동네모임",
  "products": { "roombot": true, "minigame": true },
  "pending_products": { "roombot": false, "minigame": false },
  "display": "waiting", "label": "부방장 지정 대기",
  "detail": "오픈채팅방의 부방장 관리에서 「K bot 3」을 부방장으로 지정해 주세요. 방장만 지정할 수 있으며, 지정하면 1~2분 안에 자동으로 확인됩니다.",
  "error_code": null, "can_retry": false, "retry_after": 0, "retry_admin_only": false, "needs_passcode": false,
  "bot": { "nickname": "K bot 3" },
  "on_count": 0,
  "order": null,
  "perm": 2, "joined_at": 0, "state_at": 0, "config_rev": 3,
  "can_move": true, "move_after": 0, "move_note": "",
  "can_reinstall": true, "reinstall_after": 0, "reinstall_note": "",
  "self_rule": "옮기기와 다시 설치는 무료입니다. 다른 방으로 옮기기는 방마다 24시간에 한 번, 다시 설치는 30분에 한 번 할 수 있습니다." }
```

- `pending_products` = 이 설치를 가리키는 처리 대기 주문 줄(`pending`·`paid`). 콘솔은 상품 칩 옆에 `입금 대기` 를 붙인다.
- `bot.nickname` 이 비어 있으면 `K bot`. 고객 화면에는 봇의 카카오 계정 이메일·device_id 를 절대 내보내지 않는다.
- `on_count` = 켜진 방 관리 기능 수(`visit churn leaveKick profile promo cover guard` 의 `enabled`, 방 관리봇이 없으면 0). `display==='active'` 이고 방 관리봇이 있는데 0 이면 `label` = `사용 중 · 켜진 기능 없음`, `detail` = `방 관리 기능이 모두 꺼져 있습니다. 필요한 기능을 켜 주세요.`(D15).
- `order` = `phase='pending_payment'` 일 때 `{id, url}`(토큰 포함 주문 화면 주소), 그 밖에는 null. 콘솔은 `입금 안내` 링크로 보인다.
- `can_move`·`can_reinstall` = 고객이 이 설치를 다른 방으로 옮기거나 같은 방에 다시 설치할 수 있는가(3.4.3, `installs.selfView`). 간격 때문에 기다릴 때도 true 이고 `move_after`·`reinstall_after` 에 그 시각(ms, 0 이면 지금)이 온다. `move_note`·`reinstall_note` = 지금 못 하는 까닭(간격이면 `… {M월 D일} HH:MM 이후에 다시 시도해 주세요.`), 화면은 이 문구를 그대로 쓴다. `self_rule` = 간격 안내 한 줄(환경변수 값으로 만든다).
- `can_retry` = 오류 코드가 고객 다시 시도 대상(5.6)이고 `retry_admin_only` 가 아님. `retry_after` = 다음 다시 시도 가능 시각(ms, 0 이면 지금). `retry_admin_only` = `retry_n >= 10`(이때 `detail` 끝에 `다시 시도 횟수를 넘었습니다. 문의해 주세요.`).

#### 3.4.3 내 방 경로

| 메서드·경로 | 요청 | 응답 | 오류 |
|---|---|---|---|
| GET `/panel/api/bot-rooms` | — | `{ok, rooms:[RoomView]}` (`phase` installed·pending_payment, 최근순) | — |
| GET `/panel/api/bot-room?id=` | — | `{ok, room:RoomView, config:presentRoomConfig, ranking:[{name,score}]\|null, live:{connected, perm}\|null, sender_up}` (`ranking`·`live` 는 sender 가 있을 때만) | 404 `없는 방입니다.` |
| POST `/panel/api/bot-room/settings` | `{id, rev?, cmdPrefix?, exempt?, visit?, churn?, leaveKick?, profile?, promo?, cover?, hide?, guard?, games?}` — 온 부분만 바꾼다 | `{ok, room, config}` | 403 `no_roombot` `이 방에는 방 관리봇이 설치되어 있지 않습니다.` / `no_minigame` `이 방에는 미니게임봇이 설치되어 있지 않습니다.`, 409 `not_active` `부방장 지정을 기다리는 중입니다. 방장이 K bot 계정을 부방장으로 지정하면 설정할 수 있습니다.`, 409 `stale` (`rev` 가 있고 `config_rev` 와 다름) `다른 화면에서 설정이 바뀌었습니다. 새로 불러온 뒤 다시 저장하십시오.`, 400 검증 문구(7장) |
| POST `/panel/api/bot-room/move` | `{id, link, passcode?}` — 봇 옮기기(무료). kind `preview`(IP 분당 20) + 회원당 시간 20번 | `{ok, kind:'move'\|'reinstall', same_room, held, room}` — `link` 가 지금 방과 같은 방(같은 `link_id`, 또는 같은 주소)이면 `kind:'reinstall'`(나가지 않고 링크만 바꿔 다시 입장) | 400 `bad_link`·`profile_link`·`post_link`·`bad_passcode`, 404 `not_found`(남의 방·없는 방 또는 링크 만료), 422 `not_group`, 503 `not_verified` `지금은 링크를 확인할 수 없습니다. 잠시 뒤 다시 시도해 주세요.`, 403 `blocked_room`, 409 `not_installed`(입금 대기) · `held`(관리자 확인 대기) · `room_taken`(다른 회원의 K bot) · `own_room` `이 방에는 이미 내 K bot이 있습니다. 두 방을 합치려면 문의해 주세요.` · `pending_exists` · `order_pending`(이 설치에 상품을 더하는 입금 대기 주문) · `need_support` · `bot_check`, 403 `admin_only`, 429 `too_soon`(`retry_after` + `Retry-After`), 429 `rate_limited` |
| POST `/panel/api/bot-room/reinstall` | `{id, passcode?}` — 같은 방에 다시 설치(무료). kind `panel` | `{ok, kind:'reinstall', same_room:true, held:false, room}` | 404, 409 `not_installed`·`held`·`joining` `K bot이 지금 이 방에 들어가고 있습니다. 입장이 끝난 뒤에 다시 설치할 수 있습니다.`·`need_link` `지금 링크로는 들어갈 수 없습니다. [다른 방으로 옮기기]에 방 링크를 입력해 주세요.`·`need_support`(5.6 의 그 코드 문구)·`bot_check` `K bot을 점검하고 있습니다. 복구되면 자동으로 다시 동작합니다.`·`room_taken`, 403 `admin_only`, 429 `too_soon` |
| POST `/panel/api/bot-room/retry` | `{id, passcode?}` | `{ok, room}` | 409 `not_retryable` `지금은 다시 시도할 수 없습니다.`, 403 `admin_only` `다시 시도 횟수를 넘었습니다. 문의하십시오.`, 429 `too_soon` `{HH:MM} 이후에 다시 시도하십시오.`(`retry_after` 동봉), 409 `room_taken`(내보내진 동안 다른 회원이 그 방을 설치함) |
| GET `/panel/api/bot-room/logs?id=` | — | `{ok, visit:[], profile:[], guard:[], actions:[RoomLogRow], sender_up}` — 앞의 셋은 sender `/v1/bot/logs`, `actions` 는 DB `room_log` 최근 100건 | sender 없으면 앞의 셋은 빈 배열 + `sender_up:false`. **방 관리봇이 없으면 앞의 셋은 늘 빈 배열**이고 `actions` 는 `state`·`perm` 종류만 |
| GET `/panel/api/bot-room/people?id=` | — | `{ok, people:[{user_id, name, count}]}` (최근 300개 글의 작성자, sender) | 403 `no_roombot`, 409 `not_active`, 503 |
| POST `/panel/api/bot-room/hide` | `{id, last?:1~300, user_id?}` (둘 중 하나) | `{ok, job}` | 403 `no_roombot`, 409 `not_active`, 409 `busy` `가리기 작업이 진행 중입니다.`, 429 `hide_cooldown` `가리기는 방마다 10분에 한 번 할 수 있습니다. {HH:MM} 이후에 다시 시도하십시오.`, 503 |
| GET `/panel/api/bot-room/hide?id=&job=` | — | `{ok, state:'running'\|'done', total, done, failed}` | 403 `no_roombot`, 404 |
| POST `/panel/api/bot-room/unkick` | `{id, user_id}` | `{ok}` | 403 `no_roombot`, 409 `not_active`, 404 `not_kicked` `K bot이 내보낸 사람이 아닙니다.`(이 설치의 `room_log` `kick`·`kick_fail` 행이나 `runtime.bans` 에 없는 user_id — 방장이 직접 내보낸 사람은 풀지 않는다), 502 `내보내기를 해제하지 못했습니다.` |
| POST `/panel/api/bot-room/games-reset` | `{id}` | `{ok}` | 403 `no_minigame` |

방 관리 경로(`people`·`hide`·`hide 상태`·`unkick`, settings 의 방 관리 절)의 공통 게이트는 부모와 sender 양쪽에서 같은 순서로 검사한다: 방 관리봇 상품 없음 → 403 `no_roombot`, `display !== 'active'` → 409 `not_active`. 미니게임만 산 방은 봇이 부방장이어도 가리기·내보내기 해제를 쓸 수 없다.

다시 시도 규칙(`installs.retry`, 고객): `can_retry` 아니면 409. `retry_n >= 10` 이면 403 `admin_only`. 직전 다시 시도 뒤 입장에 성공했으면(`joined_at > retry_at`, 또는 `retry_at` 없음) 새 사건이므로 `retry_n = 0` 으로 보고 간격 검사 없이 통과. 아니면 간격 = `ROOM_RETRY_BASE_MS`(기본 120000) `× 2^(retry_n-1)`(최대 6시간), `now < retry_at + 간격` 이면 429. 통과하면 한 UPDATE 로 `retry_n = retry_n + 1, retry_at = $now` + 2.2 의 "다시 입장" 묶음. 오류 코드가 `kicked` 이면 그 전에 3.3 의 충돌 SQL 로 다른 회원의 결제된 설치를 확인한다(있으면 409 `room_taken`; UPDATE 의 23505 도 같은 응답). 관리자 다시 시도는 간격·횟수를 보지 않고 `retry_n=0` 으로 만든다.

봇 옮기기·다시 설치 규칙(`installs.selfMove`·`installs.selfReinstall`, 고객, 무료 — 2026-10-17 소유자 공지 "봇을 옮기거나 재설치는 무료(사이트에서 본인이 직접)"):

- **소유**: 라우트가 `roomFor`(회원 소유 installed·pending_payment)로 먼저 404 를 가르고, `installs` 가 잠근 행으로 `member_id` 를 다시 본다. 입금 대기(`pending_payment`)는 409 `not_installed`, 관리자 확인 대기(`hold_reason`)는 409 `held`.
- **다른 방으로 옮기기**(`selfMove`, 새 방 링크): 링크는 반드시 봇 조회(`resolveLink`, 10분 캐시)로 확인한다 — 관리자 `room-rebind` 와 달리 확인하지 못한 링크로는 옮기지 않는다(503 `not_verified`). 금지 방(주소·`link_id`) 403, 3.3 충돌 SQL(다른 회원의 결제된 설치 409 `room_taken`, 내 다른 설치 409 `own_room`, 내 입금 대기 예약 409 `pending_exists`), 이 설치에 상품을 더하는 처리 대기 주문이 있으면 409 `order_pending`. 통과하면 한 트랜잭션: 옛 봇·`chat_id`·`link_id` 로 `room_leaves` INSERT(`why:'rebind'`) → `link_url`·`link_id`·`link_name` 교체, `chat_id=NULL`, `passcode_ct` = 새 참여코드 봉인값 또는 NULL(옛 방 참여코드는 버린다), `retry_n=0, retry_at=NULL`, `self_move_at=$now` + 2.2 의 "다시 입장" 묶음. 봇은 그대로(같은 봇이 새 방에 들어가므로 봇 상한이 바뀌지 않는다), 봇이 없으면 `assignBot`. 새 방 이름이 `ROOM_HOLD_WORDS` 에 걸리면 `hold_reason='name:{낱말}'`, `bot_device_id=NULL`(D28 — 옮기기로 확인 대기를 건너뛰지 못하게). 설정(`config`)·상품·조치 기록·랭킹은 설치에 붙어 있어 그대로 따라간다(랭킹은 [랭킹 초기화]로 비운다). 방 관리봇이 있으면 새 방에서 다시 부방장 지정을 기다린다.
- **같은 방에 다시 설치**(`selfReinstall`, 또는 `selfMove` 에 같은 방의 새 링크·지금 링크): 나가지 않는다. 한 UPDATE 로 `retry_n = (3.4.3 의 새 사건 판정) + 1, retry_at = self_reinstall_at = $now`, `passcode_ct=COALESCE(새 값, 옛 값)`, 링크가 오면 `link_url`·`link_name` 교체 + "다시 입장" 묶음(`chat_id` 는 그대로). 봇이 이미 방에 있으면 sender 가 5.3 의 사전 확인으로 JOINLINK 없이 상태만 다시 읽는다. 오류 코드가 `kicked` 이면 다시 시도와 같은 충돌 검사(409 `room_taken`). 링크 없이 다시 설치는 `queued`·`joining` 이면 409 `joining`, `link_gone`·`room_deleted`·`not_group`·`link_changed` 면 409 `need_link`(새 링크로는 된다). `duplicate_room`·`room_taken`·`blocked` 는 409 `need_support`, `bot_down`·`bot_no_open_profile` 은 409 `bot_check`(링크가 와도 같다).
- **남용 한도**: 다른 방으로 옮기기는 설치마다 `ROOM_SELF_MOVE_GAP_MS`(기본 24시간)에 1번(`self_move_at`), 다시 설치(같은 방 새 링크 포함)는 `ROOM_SELF_REINSTALL_GAP_MS`(기본 30분)에 1번(`self_reinstall_at`). 둘 다 DB 칸이라 서버를 다시 띄워도 남는다. 다시 설치는 고객 다시 시도와 같은 `retry_n` 을 세므로 입장에 성공하지 못한 채 연속 10번이면 403 `admin_only`(D16·D29, 공용 봇 보호). 옮기기 시도(링크 조회)는 IP 버킷 `preview`(분당 20)와 회원당 시간 20번(라우트 메모리)으로 묶는다. 쓰기 경로는 `/panel/api/` 라 `sameOriginWrites`(8.3)가 걸린다.
- **감사**: `install` 종류, `member_move 설치 #{id} {옛 주소} → {새 주소} (li …) / 나갈 봇 … / 확인 대기 …`, `member_relink 설치 #{id} {옛 주소} → {새 주소} / 이전 {state}:{code} (n회)`, `member_reinstall 설치 #{id} / 이전 … (n회) / 참여코드 변경`. `member_id` 와 IP 를 남긴다.

`RoomLogRow` = `{at, kind, user_id, name, ok, text}` — `text` 는 부모가 7.8 표로 만든 한 줄 한국어.

모든 쓰기 성공 뒤 부모는 `installs.nudge(id)` 를 부른다(sender 가 DB 에서 그 행을 다시 읽음).

### 3.5 관리자 (`routes/admin.js`, 작업 6)

인증은 지금 `x-admin-password` 그대로. 기존 경로는 유지하고 아래를 바꾸거나 더한다.

| 경로 | 요청 | 응답·동작 |
|---|---|---|
| GET `/admin/stats` | — | 기존 + `members`, `macro_active`(만료 전 회원 수), `rooms_total`, `rooms_by_display:{pending,joining,waiting,active,error}`, `bots:{total, connected, cap, used}` |
| GET `/admin/orders` | 기존 | 각 주문에 `kind`, `member:{id, login_id}\|null`, `items`, `applied` |
| POST `/admin/order-approve` | `{id, key?, skip_conflicts?}` | 회원 주문에 `key` 가 오면 400 `회원 주문에는 키를 지정할 수 없습니다`. `room_taken` 으로 실패하면 400 + `conflicts:[{install_id, link_name, products, amount}]`. `skip_conflicts:true` 면 충돌한 방 줄을 `applied.skipped` 로 빼고(그 예약 행은 `canceled`) 나머지를 적용 — 화면은 `환불할 금액 n원` 을 크게 보인다. 커밋 뒤 `entitle.afterApprove` |
| POST `/admin/grant`·`/admin/revoke-feature` | 기존 | 키가 회원에게 이관되었으면(`licenses.member_id`) 409 `회원으로 이관된 키입니다. 회원 화면에서 기간을 조정하십시오.` + `member_id` |
| POST `/admin/license-reassign` | `{key, member_id\|null}` | 잘못 이관된 키를 옮긴다(D19). 한 트랜잭션: `licenses.member_id`·`claimed_at` 교체(null = 이관 취소), 그 키의 `panel_accounts`·`panel_pending` 의 `member_id` 를 같이 교체, 이전 회원의 세션 전부 종료(`why:'admin'`). 매크로 기간은 자동으로 다시 계산하지 않는다(관리자가 `member-grant` 로 조정). 감사 `member` `claim_reassign`(이전·새 회원). 커밋 뒤 두 회원 `pushGrants` |
| POST `/admin/order-cancel` | 기존 | 같은 트랜잭션에서 `installs.cancelForOrder(client, id)` |
| POST `/admin/deposit-match` | 기존 | **이미 `matched` 이거나 `matched_order` 가 있는 입금이면 409** `이미 매칭된 입금입니다`. 커밋 뒤 `entitle.afterApprove` |
| GET `/admin/members?q=&limit=` | q = 아이디 일부·회원번호·연락처·채널톡 memberId(`m`+24hex, 6.10 7) | `{ok, members:[{id, login_id, created_at, last_login_at, macro_until, legacy_room_until, blocked_reason, google_linked, accounts_n, rooms_n, sessions_n}]}` |
| GET `/admin/member?id=` | — | `{ok, member, sessions:[…], google:{email}\|null, accounts:[…], rooms:[RoomView+{phase, bot_device_id}], orders:[…], licenses:[{key(마스킹), claimed_at, claim_ip}], audit:[최근 50]}` (`claim_ip` 는 이관 감사 행의 ip) |
| POST `/admin/member-grant` | `{id, macro_days:1~3650}` | `entitle.extendMacro` + `pushGrants(id)` + audit `member` |
| POST `/admin/member-block` | `{id, reason\|null}` | 차단(이유 1~200자) 또는 해제. 차단이면 `memberAuth.endAllSessions(id,{why:'admin'})`, `pushGrants(id)`, `installs.nudgeMember(id)` |
| POST `/admin/member-logout` | `{id}` | 세션 전부 종료 |
| POST `/admin/member-pwreset` | `{id}` | 12자 임시 비밀번호를 만들어 해시 저장, 세션 전부 종료, 응답 `{ok, temp_password}` 1회만 표시 |
| POST `/admin/room-grant` | `{member_id, link, passcode?, roombot, minigame}` | 결제 없이 설치(`order_id` NULL). preview 검사·충돌 SQL(3.3)·금지 목록 동일 |
| GET `/admin/rooms?display=&q=&bot=` | | `{ok, rooms:[RoomView + {phase, member:{id,login_id}, bot_device_id, bot_label, error_detail, attempts, next_try_at, retry_n, hold_reason}]}` |
| GET `/admin/room?id=` | | 위 + `log:[room_log 100]`, `config`, `leaves:[미처리 room_leaves]` |
| POST `/admin/room-retry` | `{id}` | `phase='installed'` 이면 상태·오류 코드와 관계없이 2.2 의 "다시 입장" 묶음 + `retry_n=0`(`next_try_at` 도 지우므로 속도 제한 대기도 바로 풀림). 사용 중인 방이면 sender 가 5.3 의 사전 확인(이미 그 `li` 의 방에 있음)으로 JOINLINK 없이 성공 처리 |
| POST `/admin/room-move` | `{id, bot_device_id\|null}` | null = 자동 배정이되 **지금 봇은 후보에서 뺀다**(`assignBot(client, id, {exclude:[지금 봇]})`, 후보가 없으면 409 `옮길 K bot 계정이 없습니다`). 지정한 봇이 지금 봇과 같으면 400. 한 트랜잭션: 지금 봇·`chat_id`·`link_id` 로 `room_leaves` INSERT(`why:'move'`) → `bot_device_id` 교체 + "다시 입장" 묶음. audit `install` |
| POST `/admin/room-remove` | `{id}` | `phase='removed'`, `removed_at`, `room_leaves` INSERT(`why:'remove'`, 봇이 있을 때), `bot_device_id=NULL` |
| POST `/admin/room-rebind` | `{id, link}` | 새 링크 preview → 충돌 SQL(3.3, 다른 설치와 겹치면 409) → 한 트랜잭션: 옛 `chat_id`·`link_id` 로 `room_leaves` INSERT(`why:'rebind'`, 같은 봇이어도 넣는다. 나가기는 `link_id` 가 새 링크와 같으면 sender 가 건너뜀) → `link_url`·`link_id`·`link_name` 교체, `chat_id=NULL` + "다시 입장" 묶음 |
| POST `/admin/room-transfer` | `{id, member_id}` | 설치를 다른 회원에게 넘긴다(D18, 방장 확인은 상담에서). `member_id` 만 바꾸고 상품·설정·봇은 그대로. 받는 회원에게 같은 방 예약이 있으면 409. audit `install` `transfer`(이전·새 회원). 두 회원의 콘솔 캐시 무효화 |
| POST `/admin/room-products` | `{id, roombot, minigame}` | 상품 켜고 끄기(지급·회수). 미니게임을 처음 켜면 `config.games` 를 7.1 기본값으로 채운다 |
| POST `/admin/room-block` | `{id?, link?, reason}` | `room_blocklist` 에 link_id·링크 주소 INSERT(`ON CONFLICT DO NOTHING`). `id` 가 오면 그 설치를 `room-remove` 와 같이 해제(`why:'block'`). audit `install` `block` |
| POST `/admin/room-unblock` | `{block_id}` | 금지 목록에서 지움 |
| GET `/admin/room-blocks` | | `{ok, blocks:[{id, link_id, link_url, reason, created_at}]}` |
| POST `/admin/room-release` | `{id}` | 한 트랜잭션: `hold_reason=NULL` + `assignBot` → 커밋 뒤 nudge(D28 확인 대기 풀기). audit `install` `release` |
| GET `/admin/bots` | | `{ok, bots:[{device_id, email, label, nickname, room_name, nickname_dup:bool, open_profile:{li,name,url}\|null, open_profiles:[…]\|null, open_profile_pick, open_profile_state:'ok'\|'none'\|'gone'\|'unknown', open_profile_at, profile_rooms:{open,main,other,failed,unknown}\|null, room_cap, enabled, state, state_at, rooms_n, live:{connected}\|null}]}` (`room_name` = 방장에게 보이는 이름 = 오픈프로필 이름(없으면 닉네임), `nickname_dup` = 다른 봇과 그 이름이 같음, D12) |
| POST `/admin/bot-open-profile` | `{device_id, li?: string\|null, refresh?: true, url?: 'https://open.kakao.com/me/…'}` | `{ok, bot, picked, read_ok, read_status}`. `read_ok` = `refresh` 로 보낸 이번 SYNCLINK 가 됐는지(실패하면 false 와 카카오 상태 `read_status`, 남긴 목록·판정은 그대로. `refresh` 가 아니면 null). `li` = 고르기(목록에 없으면 400 `bad_profile`, null = 자동, 감사 `bot`), `refresh` = SYNCLINK 다시 읽기, `url` = SYNCLINK 가 오픈프로필을 보여 주지 않을 때 그 링크를 JOININFO 로 확인해 더하기(이 봇 계정 것만, 조회 예산). 409 `not_connected`·`budget`, 400 `not_profile`·`not_mine`·`not_found`, 503 `sender_down` (5.8) |
| POST `/admin/room-profile` | `{id, how:'switch'\|'rejoin'}` | `{ok, queued, room}`. 들어가 있는 방의 봇 프로필을 오픈프로필로: `switch` = `UPLINKPROF`(나가지 않음), `rejoin` = 나갔다가 오픈프로필로 다시 입장(방장이 부방장을 다시 지정). 409 `not_joined`·`no_open_profile`·`not_connected`·`already_open`, 감사 `install` (5.8) |
| POST `/admin/bot-register/begin` | `{email, password, label?, room_cap?, device_id?, forced?}` | `device_id` 가 오면 `isBotId()` 이고 `bot_accounts` 에 있는 행이어야 한다(아니면 400 `K bot 계정 id 가 아닙니다`) — 고객 `w…` id 에 봇 자격 증명이 들어가지 않게. 없으면 `'bot.' + 16hex` 새로. sender `/v1/register/begin` 결과를 콘솔과 같은 `publicLogin` 모양으로. `confirm_on_phone` 이면 `bot_pending` 저장. `ok` 면 `bot_accounts` upsert |
| POST `/admin/bot-register/confirm` | `{pending_id}` | 콘솔 confirm 과 같은 흐름이되, 준비 판정(콘솔의 `sessionReady()` 자리)은 `/v1/snapshot` 이 아니라 **`GET /v1/status?device_id=`** 의 `linked && !needs_register` 로 한다(`/v1/snapshot` 은 `bot.` 에 404, 3.6). 20초 호출 시간 초과·pending 만료·sender 의 `expired` 응답 어느 경우든 이 판정이 참이면 `bot_accounts` upsert 후 `ok`. sender 도 등록이 끝나면 최소 `bot_accounts` 행을 만든다(2.2) |
| POST `/admin/bot-register/cancel` | `{pending_id}` | |
| POST `/admin/bot-update` | `{device_id, label?, room_cap:1~200?, enabled?}` | 응답에 `nickname_dup` |
| POST `/admin/bot-remove` | `{device_id}` | 맡은 방(`phase='installed'`)이나 미처리 `room_leaves` 가 있으면 409 `맡은 방을 다른 K bot 계정으로 옮긴 뒤 해제하십시오`. 없으면 sender `/v1/unlink` + `removed_at` |
| GET `/admin/audit` | 기존 + `member=` | |

### 3.6 sender 내부 API (`sender/src/index.mjs`, 작업 3)

전부 `x-sender-token` 필요(기존 `auth`, 비교는 `crypto.timingSafeEqual`(길이가 다르면 바로 거절)로 바꾼다). 부모는 `lib/sender-child.js` `call()`(127.0.0.1)로만 부른다. **부모의 공개 `/v1/*` 프록시(`senderChild.install(app)`, server.js:34)는 없앤다** — 안드로이드 앱이 사라져 공개 쪽 사용처가 없고, 새 `/v1/grants`·`/v1/bot/*`·`/v1/fake/*` 가 인터넷에 노출되면 안 된다(8.5).

| 경로 | 요청 | 응답 |
|---|---|---|
| POST `/v1/grants` | `{grants:{<device_id>:{v:2, macro_until, legacy_room_until}}, full?:bool, as_of?:ms}` | `{ok, applied:n, stopped:n}`. 각 고객 기록의 `features` 를 바꾸고 저장. 만료면 슬롯을 멈추고, 살아나면 붙인다. `full:true` 가 아니면 목록에 없는 device 는 무시. **`full:true`** 면 목록에 없는 `bot.` 아닌 모든 기록 중 `grants_at`(마지막으로 권리를 받은 시각)과 등록 시각이 둘 다 `as_of` 보다 이른 것을 `{v:2, macro_until:0, legacy_room_until:0}` 으로 바꾸고 멈춘다(`panel_accounts` 행이 없는 고아 기록이 옛 v1 의미로 영원히 도는 것을 막는다) |
| POST `/v1/bot/resolve` | `{url}` | `{ok:true, link_id, name, url, type, needs_passcode, profile_only, max_users}` 또는 `{ok:false, error:'no_bot'\|'budget'\|'not_found'\|'not_group'\|'kakao_error', status?}` (HTTP 200). 조회 예산(5.3)을 쓴다 |
| POST `/v1/bot/open-profile` | `{device_id, refresh?, url?}` | 고른 오픈프로필(`open_profile_pick`)을 DB 에서 다시 읽어 반영하고, `refresh` 면 SYNCLINK, `url` 이면 JOININFO 로 확인 → `{ok, read_ok, read_status, open_profile, open_profile_state, open_profiles}` 또는 `{ok:false, error}`. `read_ok` 는 이번 SYNCLINK 결과(`refresh` 가 아니면 null), 실패면 `read_status` 에 카카오 상태 (5.8) |
| POST `/v1/bot/room-profile` | `{install_id, how}` | 봇의 작업 줄에 프로필 바꾸기(`switch`)·다시 입장(`rejoin`)을 넣는다 → `{ok, queued}` 또는 `{ok:false, error}` (5.8) |
| POST `/v1/bot/sync` | `{install_id?}` | `{ok}`. 없으면 전체 재조정. DB 에서 설치·나가기 대기열을 다시 읽어 반영(5.2) |
| GET `/v1/bot/status` | — | `{ok, bots:[{device_id, connected, nickname, rooms:n, budget:{join_h, join_d, resolve_m, switch_h}, open_profile:{li,name,url}\|null, open_profile_state, open_profiles, open_profile_read_at, profile_rooms:{open,main,other,failed,unknown}, profile_convert:'off'\|'auto'}], rooms:[{install_id, connected, perm, state, profile:'open'\|'main'\|'other'\|'failed'\|'unknown'\|null}], join_paused_until}` |
| GET `/v1/bot/room?install_id=` | — | `{ok, live:{connected, perm, profile?:{state, name, fail, fail_at, switched_at, queued, target, convert}}, ranking:[{name, score}]}` |
| GET `/v1/bot/logs?install_id=` | — | `{ok, visit, profile, guard}` (지금 `logsView` 모양, 그 방만. 방 관리봇이 없으면 빈 배열) |
| GET `/v1/bot/people?install_id=` | — | `{ok, people:[{user_id, name, count}]}` 또는 `{ok:false, error:'no_roombot'\|'not_active'}` |
| POST `/v1/bot/hide` | `{install_id, last?, user_id?, by}` | `{ok, job}` 또는 `{ok:false, error:'no_roombot'\|'not_active'\|'busy'\|'cooldown', retry_at?}`. sender 가 `v.products.roombot && (v.perm & 5) && v.state==='active'` 를 다시 확인한다 |
| GET `/v1/bot/hide?job=` | — | `{ok, state, total, done, failed}` |
| POST `/v1/bot/unkick` | `{install_id, user_id}` | `{ok}` 또는 `{ok:false, error:'no_roombot'\|'not_active'\|'not_kicked'\|'failed', status?}`. 위와 같은 재확인 + user_id 가 이 방의 `bans` 또는 이 설치의 `room_log` kick·kick_fail 에 있어야 함 |
| POST `/v1/bot/games-reset` | `{install_id}` | `{ok}` |
| POST `/v1/fake/perm` | `{install_id, perm}` | `SENDER_FAKE=1` 일 때만 존재(9.4) |
| POST `/v1/fake/event` | `{install_id, kind, user_id?, name?, text?, type?}` | 같음 |

기존 `/v1/register/*` 는 `device_id` 가 `bot.` 이면 봇 기록(`features {v:2, bot:true}`, `config {}`)으로 저장하고, 끝나면 `bot_accounts` 최소 행을 `ON CONFLICT DO NOTHING` 으로 만든다(2.2).
기존 `/v1/snapshot`·`/v1/logs`·`/v1/chats`·`/v1/recent`·`/v1/inbox`·`/v1/thread`·`/v1/send*`·`/v1/config`·`/v1/session` 은 `bot.` device 에 404 를 돌려준다(고객 방 노출 방지 이중 장치, 봇 기록의 `features` 를 덮지 않게). `/v1/status` 는 `bot.` 도 답한다(읽기 전용, 3.5 의 준비 판정이 쓴다).
`/v1/config` 는 v2 기록에 `features` 가 오면 400 `features_not_allowed`(권리는 `/v1/grants` 만 바꾼다). `/v1/session`(`Hub.upsert`)의 기본 `features` 는 `{v:2, macro_until:0, legacy_room_until:0}` 이다.

### 3.7 체험 API (`routes/demo.js` · 엔진 `lib/demo.js`, 로그인 없음)

화면은 6.13. 서버는 DB·로그인 없이 `lib/demo.js` 만 부르고, 체험 상태 전체(JSON 하나, 48KB 미만)는 화면이 들고 다니며 단계마다 돌려보낸다(서버는 상태를 저장하지 않는다). 카카오톡에는 아무것도 보내지 않는다. 레이트리밋 `demo`(3.1).

| 경로 | 요청 | 응답 |
|---|---|---|
| GET `/api/demo` | — | `{ok, first:'games', groups:[{id, title, desc, product, scenes:[{id, title}]}]}` |
| POST `/api/demo/start` | `{scene, opts?}` | `{ok, scene, state, out, clock}`. 모르는 장면은 400 `bad_scene`. `opts` 는 장면의 고르기 칸 값(모르는 칸·값은 기본값) |
| POST `/api/demo/step` | `{state, ev}` — `ev` = `{type:'say', text, cid}`(글은 앞뒤 공백을 지우고 1,000자까지, `cid` 는 화면의 글 번호 40자까지) 또는 `{type:'act', id}` | `{ok, state, out, clock}`. 상태가 틀리면(48KB 초과 · `v` 다름 · 모양 · 그 장면에 없는 버튼 · 엔진 처리 실패) 400 `bad_state` `체험을 처음부터 다시 시작합니다.` → 화면이 장면을 다시 시작한다. 손님이 일으킨 문제로 500 을 내지 않는다 |

- 장면 12개(id 고정): 미니게임봇 `games` · 방 관리봇 `visit` `churn` `leavekick` `profile` `promo` `cover` `hide` `guard` · 카카오톡 매크로 `macro` `reply` `snipe`. `scene`(방 이름·인원·공지, 손님 `me`, 사람 목록, 버튼 `actions`, 바로 입력 `chips`, 고르기 칸 `controls`, 구매 링크)과 `out` 항목(`day` `feed` `msg` `hide` `member` `panel` `hint`, 앞 항목 뒤 `wait` ms)의 모양은 `lib/demo.js` 머리 주석. `msg.mention` 은 반각 `@` 부터 이름 끝까지의 `{start, len}` 이고 실제 발송에서 멘션이 붙는 글(`visitMentionExtra`)에만 있다. `msg.img`(SVG `data:` 주소)는 K bot 의 기록 카드(7.2 (f))이고, 그때 `text` 는 같은 내용의 글 안내(읽기 도구용)다. 방 관리 명령어(7.2 (g))로 바꾼 설정은 상태의 `cfg`(장면 설정에 합치는 바뀐 칸)에 남는다. 체험에서는 글 속 `@닉네임` 이 방에 있는 사람이면 멘션으로 본다(카카오톡에서 @ 로 사람을 고른 것과 같게). `clock` 은 체험 시계 — 손님 글을 미리 그릴 때 시각으로 쓴다(매크로 30분 진행 뒤에는 실제 시각보다 앞선다).
- **문구:** K bot(과 고객 계정)이 방에 보내는 글은 전부 실제 봇 함수(`sender/src/roomfeat.mjs` · `features.mjs`)를 이 프로세스 안에서 불러 만든다(처음 쓸 때 `import()` 한 번). 엔진이 쓰는 글은 사람들의 대화, 카카오톡 시스템 줄(`…님이 들어왔습니다.` `…님이 나갔습니다.` `…님을 내보냈습니다.`), 고객이 써 둔 예시(매크로 글 · 자동 응답 · 저격 규칙), 화면 설명(`hint`, 합니다체)뿐이다. `botpool.mjs` 안에만 있는 가리기 답 4개는 그대로 옮기고 `lib/demo-check.js` 가 botpool.mjs 에 같은 글이 있는지 본다.
- **botpool 순서를 다시 짠 것(5.7):** 메시지는 링 버퍼 → 닉네임 비교(프로필 변경) → `!도움` → `!가리기` → `!프로필` → 홍보 금지/금지어 검열 → 올킥 감지 → 미니게임. 입장·퇴장은 중복 판정 → 안내(`guardOnChat`) → 재입장 차단 → 들낙 감지. 내보내기는 연속 실패 멈춤(`actionFailed` — 내보내기·가리기가 3번 이어서 실패하면 10분 동안 둘 다 건너뛰고, 성공하면 0 으로)과 올킥 멈춤·방 한도(시간 10회)를 보고, 이미 나간 사람의 내보내기는 실패로 보되 botpool 처럼 연속 실패로 세지 않고, 멈춤·올킥 감지·한도로 건너뛰어도 적어 둔다(7.2 (b) 의 실측 전 항목 — 그래서 목록에 바로 올리지 못한 경우의 `noteBan` 길을 보이고, 화면 설명도 「바로 올리지 못하면」으로 쓴다). `leavekick` 은 한 번에 한 사람만 나간다(나감 → 다시 들어옴). 가리기는 300ms 간격으로 하나씩, 그동안 다시 명령하면 `이미 글을 가리는 중이에요.` 링 버퍼는 80개(봇은 300). 매크로는 runner 의 20초 점검(`macroRoomsDue` → 다른 사람 글 수 → `noteMacroWait`/`noteMacroSent`), 갠톡 자동 응답·저격 규칙은 고객 계정 기록(v2 매크로 기간 안)의 `onInbound`.
- **시계:** 장면을 열 때 서버 시각에서 시작해 단계마다 실제로 흐른 시간(6시간까지)만큼 가고, 시간이 드는 버튼(들낙 1분 머묾 · 홍보 20초 · 매크로 30분)은 그만큼 더 간다. 입장·퇴장 · 재입장 차단 · 프로필 장면의 버튼은 1분씩 간다(안내 맨 아래 기록 시각이 한 분에 몰리지 않게). 방 관리봇 함수는 이 시계를 `now` 로 받는다. 미니게임·갠톡·저격 규칙의 `onInbound` 은 실제 `Date.now()` 를 쓰므로 쿨타임(자동 응답 6시간·저격 60초)도 실제 시간이다. 미니게임 쿨타임만 0 으로 둔다(selfcheck 7.7 #13 과 같은 방법). 같은 방 안내 4초 간격·답 1초는 화면 간격 750~900ms 로 줄이고, 방당 분당 6회 송신 한도(Pacer)는 흉내 내지 않는다.
- **체험 설정:** 장면마다 그 기능만 켜고 나머지는 7.1 기본값(`!가리기` 명령도 기본값대로 켜져 있어 어느 방 관리봇 장면에서나 `!도움` 에 답한다). 예외: `leavekick` 은 다시 들어온 사람의 `[입장 안내]` 를 보이려고 입장·퇴장 기록과 재입장 차단 안내(기본은 꺼짐 — 장면 설명에 `설정에서 켠 경우에만` 이라고 적는다)도 켠다. 미니게임만 있는 `games` 방의 K bot 은 일반 참여자(권한 2, 부방장 표시 없음 — botpool 이 미니게임만 있는 방은 권한을 보지 않는다). 손님 이름은 `체험자`(봇 문구가 `{이름}님` 을 붙인다). `profile` 은 처음부터 `!프로필조회 하늘` 에 기록이 나오게 이틀 전 닉네임 변경(`하늘이` → `하늘`) 하나를 실제 `profileChange` 로 남겨 둔다(그때 안내는 그리지 않는다). 상태의 사람 목록·장면 설정은 서버가 장면 정의로 다시 맞추고, `__proto__` 같은 열쇠가 섞인 상태는 받지 않는다. 장면 카운터(`x`)의 글은 그 장면 사람의 아이디만 받고, 명부는 제 칸(`hasOwnProperty`)으로만 찾는다. 고르기 칸 값은 글자·수만 읽는다. 매크로 점검 시각(`x.t`)은 체험 시계에서 1시간 안이어야 하고, 한 단계의 화면 항목은 300개까지(넘으면 `bad_state`).
- 검사: `lib/demo-check.js`(`npm run check:w4`) — 목록 모양, 장면마다 모든 버튼·명령어, K bot 글 = 같은 입력으로 부른 실제 함수 결과, 멘션 위치, 가리기 대상, 틀린 상태 거절(던지지 않음), 무작위 200단계 뒤 상태 48KB 미만, 화면 문구에 이모지·영문 없음, 레이트리밋 `demo` 버킷.

---

## 4. 가격 · 견적 · 발급

### 4.1 `lib/pricing.js` (작업 2)

```js
PRODUCTS = {
  macro:    { id:'macro',    label:'카카오톡 매크로', unit:'month', price:15000, days:30, min:1, max:12, desc:'…' },
  roombot:  { id:'roombot',  label:'방 관리봇',       unit:'room',  price:10000, desc:'…' },
  minigame: { id:'minigame', label:'미니게임봇',      unit:'room',  price:10000, desc:'…' },
}
MAX_ROOMS = 10
quote({ macro_months, rooms:[{ products:[…] }] })
  → { ok:true, lines:[{product, months?, room?:index, unit_price, amount}], total }
  | { ok:false, reason, error, room? }
table()  → /api/price 본체
label(id), bankInfo(), contactInfo()
```

- 금액 = `macro_months × 15000 + (방 상품 줄 수) × 10000`. 할인 없음.
- 방 상품 가격은 2026-10-17 에 15,000원 → **10,000원**(방 1개, 영구)으로 내렸다. 이미 접수된 주문은 그때의 `unit_price`·`amount` 를 주문 줄에 갖고 있어 바뀌지 않고, 설치한 방도 그대로다. `/buy`·`/manage` 의 HTML 대체 금액은 `lib/purchase-check.js` 가 `pricing.js` 와 같은지 본다.
- `lib/features.js` `LABELS`·`DESCS` 를 위 이름으로 바꾼다(`/admin` 옛 화면과 `/api/lookup` 이 씀).
- 예전 `PRICE`·`PLAN`·`NAME` 상수와 인자 없는 `quote()` 는 없앤다(호출부 전부 작업 2 소유).

### 4.2 발급 — `keys.approveOrder(client, id, overrideKey)` (작업 2)

호출부 3곳(`purchase.js` 입금 웹훅, `admin.js` order-approve·deposit-match)은 지금처럼 트랜잭션 안에서 부른다. 동작:

1. `SELECT * FROM orders WHERE id=$1 FOR UPDATE`. `done` 이면 `{ok, already:true, key:o.issued_key, member_id, applied}` (멱등).
2. 사람이 취소한 주문이면 오류(지금 규칙).
3. `o.member_id` 가 있으면 회원 경로:
   - `overrideKey` 가 있으면 `{error:'회원 주문에는 키를 지정할 수 없습니다'}`.
   - `entitle.applyOrder(client, o)`:
     - 회원 행 `FOR UPDATE`(차단된 회원이어도 적용한다. 돈은 들어왔다).
     - 매크로 줄 합계 개월 → `UPDATE members SET macro_until = GREATEST(macro_until, $now) + $ms WHERE id=$1 RETURNING macro_until`.
     - 방 줄을 `install_id` 로 묶어 행마다 `SELECT … FOR UPDATE` 한 뒤:
       - `pending_payment` → 상품 켬, `phase='installed'`, `installed_at`, `state='queued'`, `installs.assignBot(client, id)`.
       - `canceled`(자동 취소 주문을 되살리는 경우) → 같은 link_id/URL 로 살아 있는 다른 행이 있으면 `{error:'같은 방에 다른 설치가 있습니다: 설치 #'+id}`; 없으면 위와 같이 installed.
       - `installed` → 상품 플래그만 켬(상태는 sender 가 다시 계산).
       - `removed` 또는 다른 회원 소유 → 오류.
     - 방 줄 적용 전 충돌 확인(3.3 의 충돌 SQL, `pending_payment`·`canceled` 행을 `installed` 로 바꾸기 전): 다른 회원의 결제된 설치가 있으면 `opts.skipConflicts` 가 아니면 `{error:'같은 방에 다른 회원의 설치가 있습니다: 설치 #'+id, reason:'room_taken', conflicts:[…]}`(트랜잭션 롤백, 3.3.1). `skipConflicts` 면 그 줄을 `applied.skipped` 에 넣고 예약 행은 `canceled`.
     - 금지 목록(D28)에 걸린 방 줄도 같은 방식(`why:'blocked'`).
     - `hold:true` 표시가 있거나 `ROOM_HOLD_WORDS` 에 걸리는 방은 `installed` 로 바꾸되 `hold_reason='name:'+걸린 낱말` 을 쓴다(봇은 배정하지 않는다. 관리자 `room-release` 가 `hold_reason=NULL` 로 풀고 `assignBot` 한다).
     - 처음으로 `minigame` 이 켜지는 설치는 `config.games` 를 7.1 기본값(켜짐)으로 채운다(applyOrder·room-grant·room-products 공통).
     - `{ok, applied, installs:[id…]}`.
   - `UPDATE orders SET status='done', handled_at=$now, applied=$applied`.
   - `{ok, already:false, key:null, member_id, applied, installs, order:o}`.
4. 아니면 예전 키 경로(예전 가격으로 받은 미입금 주문 처리용). 단, 대상 키(`target_key` 또는 `overrideKey`)가 **회원에게 이관된 키**(`licenses.member_id` 있음)면 `grant()` 대신 그 회원에게 적용한다: 주문 기능에 `macro` 가 있으면 `entitle.extendMacro(client, member_id, 계획 일수)`, 그 밖의 기능(옛 `roombot`·`minigame` = 계정 단위 옛 기능)이 있으면 `legacy_room_until = GREATEST(legacy_room_until, now) + 계획 일수`(D20 의 계정 단위 화면). `applied = {legacy_to_member:true, macro:{days, until}?, legacy_room_until?}`, 반환에 `member_id`(커밋 뒤 `afterApprove` 가 그 회원 `pushGrants`). 이관 키를 대상으로 새 키를 만들지 않는다.

커밋 뒤 호출부는 `entitle.afterApprove(result)` 를 부른다. `already` 이거나 `member_id` 가 없으면 아무것도 안 한다.
`approveOrder(client, id, overrideKey, opts?)` — `opts.skipConflicts` 는 `/admin/order-approve` 만 넘긴다.

### 4.3 금액 뒷자리·만료

- `pickAmount` 는 그대로(전역 advisory lock, base 구간 검사).
- `expireStalePending` 은 취소한 주문 id 를 `RETURNING id` 로 받아 같은 트랜잭션에서 `UPDATE room_installs SET phase='canceled' WHERE phase='pending_payment' AND order_id = ANY($1)`.

### 4.4 봇 배정 — `installs.assignBot(client, installId, {exclude?:[device_id]})`

```sql
SELECT pg_advisory_xact_lock(1262636884);   -- 0x4B424F54 'KBOT'
SELECT b.device_id
  FROM bot_accounts b
  LEFT JOIN room_installs r ON r.bot_device_id = b.device_id AND r.phase = 'installed'
 WHERE b.enabled AND b.removed_at IS NULL AND b.state <> 'needs_register'
   AND NOT (b.device_id = ANY($exclude))
 GROUP BY b.device_id, b.room_cap, b.created_at, b.open_profile_li
HAVING count(r.id) < b.room_cap
 ORDER BY (b.open_profile_li IS NULL) ASC, count(r.id) ASC, b.created_at ASC   -- 오픈프로필을 아는 봇 먼저(D12)
 LIMIT 1;
UPDATE room_installs SET bot_device_id=$2, state='queued', error_code=NULL, error_detail=NULL,
       next_try_at=NULL, perm=NULL, perm_at=NULL, state_at=$now WHERE id=$1;
```

없으면 `bot_device_id` 를 NULL 로 두고 `error_detail='no_bot'` (화면: `입장 중 · 순서 대기`). 배정에 성공하면 위 UPDATE 가 `error_detail` 을 지운다.

`installs.startLoop()`(server.js 가 listen 뒤 1번) 가 1분마다:
1. `phase='installed' AND bot_device_id IS NULL AND hold_reason IS NULL` 을 다시 배정하고 배정되면 `nudge`.
2. **멈춘 입장 되돌리기**: `phase='installed' AND state='joining' AND state_at < now-15분 AND (next_try_at IS NULL OR next_try_at < now)` 인 행을 "다시 입장" 묶음으로 `queued` 로 되돌리고 `nudge`(sender 가 입장 중에 죽은 경우. sender 도 부팅·재조정 때 `joining` 을 다시 줄에 넣으므로 이것은 보조 장치다, 5.2).

### 4.5 권리를 sender 에 미는 규칙 (`entitle.pushGrants(memberId|null)`)

고객 device 마다 `{v:2, macro_until, legacy_room_until}`:
- 회원 소유(`panel_accounts.member_id`): 회원 값. 차단된 회원이면 둘 다 0.
- 미이관 키 소유(`member_id IS NULL`): `macro_until` = 그 키 `entitlements` macro `expires_at`(NULL 이면 0), `legacy_room_until` = 그 키 entitlements `expires_at` 최댓값. 회수·차단 키면 둘 다 0.

미는 때: 승인 직후(그 회원), 이관·이관 재배정 직후, 관리자 지급·차단, 계정 등록 완료 직후, `SENDER_READY`(전체), 10분마다(전체). sender 는 받은 시각 값으로 스스로 만료를 판정하므로 밀기를 놓쳐도 만료는 정확하다.
`pushGrants(null)`(전체)은 `{grants, full:true, as_of}` 로 보낸다. `as_of` = DB 를 읽기 시작한 시각. sender 는 목록에 없는 고객 기록을 권리 없음으로 바꾸고 멈춘다(3.6) — 등록은 됐는데 `panel_accounts` 행이 없는 기록(예: `rememberAccount` 실패)이 v1 의미로 모든 기능을 영원히 돌리던 구멍을 닫는다.

**`entitle.startLoop()`** (작업 2, server.js 가 listen 뒤 1번 부름) 가 맡는 일:
1. `senderChild.onReady(() => { pushGrants(null); installs.nudge(null) })` — 자식이 뜰 때마다 전체 밀기 + `/v1/bot/sync`(전체). 이 첫 전체 밀기 전까지 기존 기록은 v1 의미라 반드시 필요하다(D7).
2. 10분마다 `pushGrants(null)`.
3. 하루 1번(부팅 10분 뒤 시작, 24시간 간격) `DELETE FROM room_log WHERE at < now - ROOM_LOG_KEEP_DAYS일`, `DELETE FROM room_leaves WHERE done_at < now - 30일`, 만료된 `member_sessions`(30일 지난 것)·`bot_pending` 정리.
모든 단계는 실패를 로그만 남기고 다음 주기에 다시 한다. sender 가 없으면 1·2 는 건너뛴다.

### 4.6 기존 키 이관 계산 — `entitle.claimKey(client, memberId, key)`

한 트랜잭션, `licenses` 행 `FOR UPDATE`.

1. 없음 → 404 `not_found` `키를 찾을 수 없습니다. 키를 확인하십시오.` / `member_id` 있음 → 409 `claimed` `이미 회원 계정에 등록된 키입니다. 본인의 키라면 문의하십시오.`(관리자 `license-reassign`, D19) / 회수·차단 → 403 `key_blocked` `사용이 중지된 키는 등록할 수 없습니다. 문의하십시오.`
2. 미개시 entitlement(`expires_at IS NULL`)는 지금 시작한 것으로 본다: `expires_at = now + duration_ms`(키 행은 바꾸지 않고 계산만).
3. 매크로: `rem = max(0, macroExp - now)` → `macro_until = GREATEST(macro_until, now) + rem`.
4. 유예: `legacy_room_until = GREATEST(legacy_room_until, max(모든 entitlement 의 expires_at))`(옛 키는 기능과 관계없이 계정 단위 4개 화면을 썼으므로).
5. `UPDATE licenses SET member_id=$m, claimed_at=$now`, `UPDATE panel_accounts SET member_id=$m WHERE license_key=$key AND member_id IS NULL`, `panel_pending` 도 같게.
6. 감사 `member` `claim`(`audit.record(req, …)` 라 이관 IP 가 남는다, D19), 커밋 뒤 `pushGrants(memberId)`.

---

## 5. sender 변경 (작업 3)

### 5.1 고객 계정 (매크로)

- `featureOn(record, id)`: `features.v === 2` 이면 `macro` → `now < macro_until`, `roombot`·`minigame` → `false`. v2 가 아니면 지금 동작(첫 `/v1/grants` 전 호환).
- 계정 단위 옛 기능 게이트: `visitRoom`·`profileRoom`·`coverRoom`·`roomOf`·`enabledRooms` 맨 앞에 `if (v2 && !(now < legacy_room_until)) return null`.
- `Hub.boot`: v2 이고 `now ≥ max(macro_until, legacy_room_until)` 인 고객 기록은 붙이지 않는다. Hub 에 60초 타이머를 두어 만료된 고객 슬롯은 `stop()`(기록 보존), `/v1/grants` 로 살아나면 `attach`.
- 같은 규칙을 `Hub.updateConfig`(runner.mjs:287-288 의 "슬롯 없으면 attach")와 `Hub.upsert` 에도 둔다: 권리가 끝난 v2 고객 기록은 설정을 저장만 하고 붙이지 않는다. 만료된 회원이 콘솔에서 매크로 설정을 저장할 때마다 카카오에 다시 로그인하던 것을 막는다.
- 새 고객 기록의 기본 권리는 **거부**: `register.mjs` `storeSession` 이 새 고객 device 에 `features {v:2, macro_until:0, legacy_room_until:0, reg_at:now}` 을 넣는다(재등록은 이전 값 유지 + `reg_at` 갱신). 부모가 등록 직후 `/v1/grants` 로 실제 값을 민다.
- 버그 고침(계정·봇 공통): `coverMessage` 결과 판정을 `locoOk(res)` 로(5.5), `deliver()` 의 `await sleep(delayMs)` 를 체인 밖 `setTimeout` 후 enqueue 로, `visitSeen` 중복 판정을 7.2(a) 규칙으로.
- 갠톡 응답(`onInbound` → `autoReply`)은 방 줄의 `list_kind` 로 1:1 을 가른다. `open_dm`(오픈프로필 1:1 — 라이브러리 분류 `kind` 는 `'open'`)이면 답하고(적어 둔 인원 `members` 가 3명 이상이면 답하지 않는다 — 2026-10-11 전에 불러온 목록은 3명 이상인 type 14·16 단체방도 `open_dm` 으로 적었다), `open_room` 이면 `kind` 와 상관없이 답하지 않는다. `list_kind` 가 없거나 `normal` 이면 예전처럼 `kind` 가 `group`·`open` 이 아닐 때만 답한다.
- 대화방 불러오기 전에 처음 온 갠톡: `Slot.onMessage` 가 `addDirectRoom` 으로 그 방 하나만 `getChat`(CHATINFO, 제목 메타가 없는 오픈채팅이면 INFOLINK 하나 더)으로 읽어 확실한 1:1(type `OD`·14·16, 2명 이하, 상대 이름 `display_name` 있음)이면 `record.rooms` 에 `open_dm` 줄로 `mergeCatalog` 와 같은 이름·키로 더하고(저장은 그 메시지의 `saveRecord`), 보낸 사람 이름이 비었으면 방금 읽은 방 정보로 채운다. 링크와 인원만으로 1:1 로 보는 방(type 2·모르는 type)은 아직 2명인 단체방일 수 있어 더하지 않고 대화방 불러오기에 맡긴다. 매크로 대상(`macro.rooms`)에 남은 키는 쓰지 않는다(매크로 글이 이 1:1 로 가지 않게 `민지 2` 처럼 번호를 붙인다). 매크로 기간 안·갠톡 응답 켬(문구 있음)·내 글 아님·`record.rooms` 에 없는 방일 때만 묻는다. 갠톡이 아니거나 확실하지 않은 방은 하루, 읽지 못했거나 상대 이름이 없는 방은 10분 동안 다시 묻지 않는다(메모리, 최대 500개). 읽기 실패는 로그 한 줄만 남긴다(`onError` 로 넘기지 않는다). 로그에 방 이름·id 는 없다. 더한 줄은 고르는 목록에 나오지 않는다(`splitRooms`), 다음 대화방 불러오기는 `chat_id` 로 그 키를 그대로 쓴다.

### 5.2 봇 계정 슬롯

`isBotId(id) = /^bot\.[0-9a-f]{16}$/.test(id)`. Hub 는 봇 id 를 `BotSlot`(새 파일 `botpool.mjs`, `Slot` 을 상속하거나 감싼다)으로 붙인다.

- 하지 않는 것: `macroTick`, 받은함·카탈로그, `onInbound` 의 매크로·갠톡 응답.
- 갖는 것: `views: Map<chat_id, BotRoom>`, `byInstall: Map<install_id, BotRoom>`(BotRoom = sender 내부 방 객체 `{install_id, member_id, chat_id, link_id, link_name, products, perm, state, cfg, rev, licensed}`. 3.4.2 의 RoomView 와 다른 것), 입장 대기열, 권한 점검 일정, 방별 링 버퍼, 방별 송신 대기열.
- 접속하면 `client.getProfile()` 로 닉네임을 읽어 `UPDATE bot_accounts SET nickname=$2, state='connected', state_at=$now WHERE device_id=$1`. 끊기면 `state='down'`, `markDead` 면 `state='needs_register'` + 그 봇의 모든 `installed` 행 `state='error', error_code='bot_down'`. 등록 직후에는 관리자 쪽 `bot_accounts` INSERT 가 아직 없을 수 있으므로 sender 가 최소 행을 만들고(2.2) 5분 재조정 때마다 `nickname`·`state` 를 다시 쓴다.
- `markDead` 는 진짜 세션 종료에만: `patch-kakao.mjs` 가 agent-messenger 의 `dispatchPush` 를 고쳐 `KICKOUT` 본문의 `reason` 을 세션 이벤트(`{type:'kicked', reason}`)에 실어 보낸다. runner·botpool 은 `reason` 이 0(LOGIN_ANOTHER)·1(ACCOUNT_DELETED)·없음일 때만 `markDead('kicked')`, -2(CHANGE_SERVER)와 그 밖의 값은 재접속으로 처리한다(고객 계정 슬롯에도 같은 규칙).
- 봇이 다시 붙으면(재등록·재접속) `error_code='bot_down'` 인 자기 방을 오류로 두지 않고 바로 5.4 의 생존·권한 점검을 돌려 `active`/`waiting_host` 로 되돌린다.
- 접속할 때마다(닉네임을 읽은 뒤, 방 점검 전에) 그 계정의 오픈프로필을 `SYNCLINK {ltk:0}` 1회로 읽는다(5.8). 오픈프로필이 준비되면 `error_code='bot_no_open_profile'` 인 자기 방을 `queued` 로 되돌려 입장 줄에 넣는다(재조정 때도 같다).
- 설치 읽기(부팅·`/v1/bot/sync`·5분마다, 관리자가 고른 오픈프로필 `open_profile_pick` 도 함께 읽는다):

```sql
SELECT r.*, m.blocked_reason AS member_blocked
  FROM room_installs r JOIN members m ON m.id = r.member_id
 WHERE r.phase = 'installed' AND r.bot_device_id = ANY($1);
SELECT * FROM room_leaves WHERE done_at IS NULL AND bot_device_id = ANY($1) ORDER BY id;
```

  - **나가기를 입장보다 먼저** 처리한다(봇마다 직렬 작업 줄의 앞). 행마다: 지금 같은 봇이 같은 `link_id` 의 설치를 맡고 있으면(옮기기 대상이 자기 자신, 또는 rebind 의 새 링크가 같은 방) 나가지 않고 `result='kept'`. 아니면 `chat_id`(없으면 그 봇의 `getChats({all:true})` 에서 `link_id` 가 같은 방)로 `leaveChat` → `UPDATE room_leaves SET done_at=$now, result=$r WHERE id=$1 AND bot_device_id=$봇`. 그 방에 이미 없으면 `not_in_room`. 실패면 `failed:<status>` 로 두고 다음 재조정 때 다시(최대 5번). 한 설치에 나가기 행이 여러 개여도(옮기기 두 번) 행마다 따로 처리되므로 이전 봇이 방에 남지 않는다.
  - `state` 가 `queued` **또는 `joining`** 이면 입장 대기열에 넣는다(`next_try_at` 이 미래면 그때까지 미룸). `joining` 은 입장 도중 sender 가 재시작되었거나 속도 제한으로 미뤄진 행이다(5.3 6). `hold_reason` 이 있으면 넣지 않는다.
  - 그 외는 view 를 만들고/갱신한다(`config_rev` 가 바뀌면 설정만 바꿈). `member_blocked` 면 view 의 `licensed=false`.
  - 봇 view 에 있는데 위 결과에 없는 설치(옮겨졌거나 해제됨)는 view 를 지운다(나가기는 `room_leaves` 가 맡는다).

### 5.3 입장 작업

봇마다 직렬 1개(나가기 → 입장 순), 입장 사이 `BOT_JOIN_GAP_MS`(기본 45000, ±20% 흔들기). 원시 패킷은 `executeWithReconnect` 를 쓰지 않고 `const s = await client.acquireSession(); s.getConnection().sendPacket(method, body)` 1회(runner.mjs:1211 의 REWRITE 와 같은 API, JOINLINK 중복 방지). 결과 판정은 항상 `locoOk`. **입장 실패 때문에 봇 클라이언트를 닫았다 열지 않는다**(LOGINLIST 는 같은 봇의 다른 방 푸시를 끊고 서버 IP 에서 로그인을 반복시킨다). 소켓이 닫혀 `statusCode:-1` 이 오면 agent-messenger 가 상태를 지우므로 다음 `acquireSession()` 이 스스로 다시 접속한다.

**예산**(sender 가 강제, D29, 메모리 + 재시작 시 0): 봇마다 입장 시도(아래 1~4 한 묶음 = JOININFO·CHECKJOIN·JOINLINK) `BOT_JOIN_PER_HOUR`(기본 20)·`BOT_JOIN_PER_DAY`(기본 80), 조회(`/v1/bot/resolve` 의 JOININFO) 봇마다 `BOT_RESOLVE_PER_MIN`(기본 10)·`BOT_RESOLVE_PER_DAY`(기본 300) — 조회는 맡은 방이 가장 적은 연결된 봇이 한다. 예산이 없으면 입장은 `next_try_at` = 예산이 돌아오는 시각(`error_detail='rate_limited'`), 조회는 `{ok:false, error:'budget'}`(부모는 `verified:false`). 전역 입장 정지(`join_paused_until`, 아래 -444)도 모든 봇에 적용한다.

0. 사전 확인: 그 봇의 `getChats({all:true})`(patch-kakao 가 `link_id` 를 채움)에 이 설치의 `link_id` 와 같은 방이 있으면 JOINLINK 없이 5 로 간다(이미 들어가 있음: 관리자 다시 시도, 재시작 뒤 `joining` 행, 앞선 응답 유실. 5.8 의 다시 입장 직후는 건너뛴다). `hold_reason` 이 있거나 `room_blocklist` 에 있으면 시작하지 않는다(금지면 `error/blocked`).
   그다음 오픈프로필(D12): 이 봇의 오픈프로필을 아직 모르면(접속 직후·SYNCLINK 실패, 남긴 값도 없음) 행을 그대로 두고 `BOT_TRANSIENT_WAIT_MS` 뒤 다시 본다(오류 아님, 읽히면 바로). 없거나(`none`) 고른 것이 사라졌으면(`gone`) `error/bot_no_open_profile`(`error_detail` = `none`·`gone`)이고 카카오에 아무 패킷도 보내지 않는다.
1. `UPDATE … SET state='joining', attempts=attempts+1, state_at`.
2. `JOININFO {lu: link_url, ref:'EW'}` → `ol`. 실패: -324 등 링크 없음 → `link_gone`. `ol.lt === 1`(1:1 오픈채팅·오픈프로필) → `not_group`. 그 밖(2, 커뮤니티 방 등 새 값, `lt` 가 빠진 답)은 그룹방으로 보고 들어간다(`roomfeat.groupLinkType`). 2 가 아니면 `lt`·`ol` 칸 이름·`pv` 를 로그에 남긴다(`/v1/bot/resolve` 도 같다).
   `link_id` 가 비어 있으면 `ol.li` 를 저장(UNIQUE 위반 23505 → `duplicate_room`). 있는데 다르면 → `link_changed`. `link_name = ol.ln`. 저장한 `link_id` 가 금지 목록이면 → `blocked`. 0 의 사전 확인을 이 `li` 로 한 번 더.
3. `ol.pv & 64`(참여코드 필요): `passcode_ct` 가 없으면 `passcode_needed`. 있으면 `secretbox.open` → `CHECKJOIN {li, pc}` → 실패면 `passcode_wrong`, 성공이면 `tk`.
4. 프로필(D12): 늘 `JOINLINK {li, ref:'EW:', ptp:16, pli: 오픈프로필 li, tk?}`(`nn`·`pp` 없음). 방의 `ol.pv & 32`(기본 프로필 참여 허용)는 보지 않는다(트레이스에만 남긴다).
5. 성공: `chat_id = chatRoom.chatId`, `link_id = ol.li`, `joined_at`. `CHATONROOM {chatId, …}` 1회 — 응답 `olu.lmt` 가 봇 권한(없으면 JOINLINK 응답 `olu.lmt`, 그것도 없으면 `MEMBER(self)`, 5.4). 같은 `olu` 의 `ptp`·`pli`·`nn` 을 그 방의 봇 프로필로 남긴다(`room_state.runtime.prof`, 5.8). 방 관리봇이 있으면 `perm & 5 ? 'active' : 'waiting_host'`, 없으면 `active`. 처음 들어간 방이면 입장 안내 1회(7.9). `error_code` 가 `kicked` 였던 행을 지우다 23505(그 사이 다른 회원이 설치)면 `leaveChat` 후 `error/room_taken`.
6. 실패 처리:
   - -312·-805·-819(속도·시간 제한): `state` 는 `joining` 유지, `error_detail='rate_limited'`, `next_try_at = now + [10분, 30분, 2시간][min(n,2)]`.
   - -444(BLOCKED_IP, 서버 IP 차단): 봇을 내리지 않는다. 이 행은 `joining` 유지 + `rate_limited`, **전역** `join_paused_until = now + [30분, 2시간, 6시간][min(연속 횟수,2)]`, 모든 봇의 입장·조회를 그때까지 멈춘다. 관리자 화면에 `카카오가 서버 IP 의 입장을 막았습니다` 띠(`/v1/bot/status.join_paused_until`).
   - -815(OPENCHAT_REJOIN_REQUIRED)와 내보내진 방 재입장 status(10.1 #2): `kicked`.
   - -501: `room_full`(실측 전 가정).
   - `BOT_PROFILE_BLOCK_STATUS`(기본 `-804`, 실측 전 가정, 10.1 #9)에 든 status: `profile_blocked`(카카오가 오픈프로필 입장을 거절). 다른 프로필로 다시 보내지 않는다.
   - 응답 유실(`statusCode:-1`·시간 초과) 또는 알 수 없는 0 아닌 status: 다시 접속하지 않는다. 지금 세션(-1 이면 다음 `acquireSession()` 이 새로 연 세션)의 `getChats({all:true})` 로 `li` 가 같은 방을 찾는다. 있으면 성공 처리. 없으면 `kakao_error`, `error_detail = '카카오 상태 ' + status`.
   - -997: 봇 계정 자체 문제 → `bot_down` 처리와 같다(그 봇 전체).

`SENDER_TRACE_PUSH=1` 이면 처음 보는 `packet.method` 마다 본문 키 목록을 1회 로그로 남긴다(실측용, 10.1). 또 `SYNCLINK`·`JOININFO`·`CHECKJOIN`·`JOINLINK`·`UPLINKPROF` 의 요청·응답 모양 전체와 `CHATONROOM.olu`·`INFOLINK.ols[0]`(봇마다 처음 5번)을 `raw <방법> req … → statusCode … body …` 한 줄로 남긴다(Long 은 글자, `pc`·`tk` 는 `<hidden>`).

### 5.4 권한·생존 점검

| 대상 | 주기 | 방법 |
|---|---|---|
| `waiting_host` | `BOT_PERM_POLL_MS` 60000 ±15000 | 권한 읽기(아래) |
| `active` | `BOT_ACTIVE_CHECK_MS` 600000 | `getChat(chatId)`(나감·없음 판정) → 권한 읽기 |
| 재접속 직후 | 즉시(방마다 2초 간격) | 위 둘 |
| 푸시 `SYNCMEMT` 에 self, 피드 11·12·15 | 3초 뒤 1회 | 권한 읽기 |
| 들어가 있는 방의 `roombot` 이 바뀜(상품 추가·관리자 상품 변경, 4.2), 또는 상태가 상품·권한과 어긋남(`roombot` 인데 `active`·`perm & 5` 아님, `roombot` 없는데 `waiting_host`) | 3초 뒤 1회 | 권한 읽기 |
| 강퇴·삭제 푸시 | 즉시 | 아래 표 |

**권한 읽기**(D13): `CHATONROOM {chatId, …}` 응답의 `olu.lmt`(클라이언트 자신의 오픈링크 사용자 정보) → 없으면 `MEMBER {chatId, memberIds:[self]}` 의 `members[0].mt` → 둘 다 없으면 이번 점검은 판정 보류(상태 유지). 원시 패킷은 5.3 과 같은 방식으로 보낸다.

규칙: 방 관리봇이 있는 방에서 `perm & 5` 면 `active`, 아니면 `waiting_host`(강등이면 `room_log 'perm'` + 방 안내 없음). 미니게임만 있는 방은 권한을 보지 않는다. 미니게임만 쓰던 방(`active`, `perm & 5` 아님)에 방 관리봇을 더해 `waiting_host` 가 되는 것은 강등이 아니다: `perm` 기록을 남기지 않고, 그 방에 방 관리봇 안내를 아직 하지 않았으면 7.9 의 `방 관리봇 추가` 안내를 1회 한다. RoomView(`displayOf`)·관리자 필터도 sender 가 다시 계산하기 전의 `active` + `roombot` + `perm & 5` 아님을 `waiting` 으로 본다(0.1).

| 신호 | 상태 |
|---|---|
| `LINKKICKED` 또는 피드 6 의 대상이 self, 또는 `getChat` 이 `left` | `error/kicked`, `KICKLEAVE {c, li}` 로 정리 (배타권 해제, D8) |
| `LNKDELETED`·`SYNCLINKDL` 또는 INFOLINK 에 링크 없음 | `error/room_deleted`, `leaveChat` |
| `LEFT {chatId}` | `error/left` |
| `KICKOUT`(세션) 사유 0·1·없음 | 봇 전체 `bot_down` (D17). 사유 -2 는 재접속 |

### 5.5 원시 동작 공통

```js
locoOk(res) := res && res.statusCode === 0 && (typeof res.body?.status !== 'number' || res.body.status === 0)
openAction(view, method, extra)  // {li: Long(link_id), c: Long(chat_id), ...extra} → {ok, status}
kick(view, userId, reason)       // KICKMEM {mid}
unkick(view, userId)             // KLDELITEM {kid}
hide(view, logId, type)          // REWRITE {logId, t}
```

모든 id 는 `Long.fromString(String(v))` 로 다시 감싼다. 강퇴·가리기가 실패하면 즉시 봇 권한을 다시 읽고, 권한을 잃었으면 `waiting_host` 로 전환, 아니면 `kick_fail`/`hide_fail` 기록. 방마다 연속 3회 실패면 그 방의 조치를 10분 멈춘다. 이미 나간 사람의 내보내기 실패(7.2 (b))는 권한만 다시 읽고 연속 실패로 세지 않는다(더하지도 0 으로 되돌리지도 않는다). 레이트리밋 답(-312·-805·-819)은 나간 사람이어도 센다. 강퇴는 재시도하지 않는다.

한도(넘으면 건너뛰고 `room_log` 에 `한도 초과로 건너뜀`). 방 한도는 봇 한도를 방 여러 개가 나눠 쓸 수 있게 **공정 몫**으로 잡는다(D29, 봇 한도 ≥ 방 한도 × 3):

| 동작 | 방마다 | 봇마다 |
|---|---|---|
| 발송(안내·게임 답) | 6/분 | 30/분 |
| 강퇴 | 10/시간 | 30/시간 · 200/일 |
| 가리기(REWRITE) | 300/30분, 콘솔 가리기 작업은 방마다 10분에 1번 | 600/10분 |

봇 페이서는 방별 대기열을 **돌아가며**(round-robin) 하나씩 꺼낸다. 한 방의 대기열이 길어도 다른 방이 굶지 않는다. 방 한도에 걸린 방의 항목은 그 방 대기열에서만 밀린다.

### 5.6 오류 코드 (sender 가 쓰고 화면이 번역)

| error_code | 짧은 사유 | 긴 문구 | 고객 다시 시도 |
|---|---|---|---|
| `passcode_needed` | 참여코드 필요 | 참여코드가 필요한 방입니다. 참여코드를 입력한 뒤 다시 시도해 주세요. | 예(참여코드 입력) |
| `passcode_wrong` | 참여코드 불일치 | 참여코드가 맞지 않아 입장하지 못했습니다. 참여코드를 고친 뒤 다시 시도해 주세요. | 예(참여코드 입력) |
| `room_full` | 인원 초과 | 방 인원이 가득 차 입장하지 못했습니다. 자리가 생긴 뒤 다시 시도해 주세요. | 예 |
| `kicked` | 내보내짐 | K bot 「{닉네임}」이 방에서 내보내졌습니다. 오픈채팅방의 내보내기 목록에서 K bot을 해제한 뒤 [다시 시도]를 눌러 주세요. | 예 |
| `left` | 방 나감 | K bot이 방에서 나갔습니다. [다시 시도]를 누르면 K bot이 다시 들어갑니다. | 예 |
| `profile_blocked` | 프로필 제한 | 카카오가 K bot의 오픈프로필 입장을 거부했습니다. 오픈채팅방의 참여 프로필 설정을 확인한 뒤 다시 시도해 주세요. | 예 |
| `kakao_error` | 입장 거부 | 카카오 서버가 입장을 거부했습니다. 잠시 뒤 다시 시도해 주세요. | 예 |
| `link_gone` | 링크 만료 | 링크가 만료되었거나 방이 삭제되었습니다. 방 링크가 바뀌었으면 [다른 방으로 옮기기]에 새 링크를 입력해 주세요. | 아니오(고객 [다른 방으로 옮기기] 또는 관리자 rebind) |
| `room_deleted` | 방 삭제됨 | 오픈채팅방이 삭제되었습니다. [다른 방으로 옮기기]에 새 방의 링크를 입력하면 K bot이 그 방으로 옮겨 갑니다. | 아니오(고객 옮기기) |
| `not_group` | 설치 불가 링크 | 그룹 오픈채팅방 링크가 아닙니다. [다른 방으로 옮기기]에 그룹 오픈채팅방 링크를 입력해 주세요. | 아니오(고객 옮기기) |
| `link_changed` | 링크 불일치 | 등록한 링크가 지금은 다른 방을 가리킵니다. [다른 방으로 옮기기]에 방 링크를 다시 입력해 주세요. | 아니오(고객 옮기기) |
| `duplicate_room` | 중복된 방 | 이 방에는 이미 K bot이 있습니다. 문의해 주세요. | 아니오 |
| `room_taken` | 다른 회원 사용 중 | K bot이 내보내진 동안 다른 회원이 이 방에 K bot을 설치했습니다. 문의해 주세요. | 아니오 |
| `blocked` | 설치 불가 | 이 방에는 K bot을 설치할 수 없습니다. 문의해 주세요. | 아니오 |
| `bot_down` | K bot 점검 | 이 방의 K bot 연결이 끊겼습니다. 복구되면 자동으로 다시 동작합니다. | 아니오 |
| `bot_no_open_profile` | K bot 준비 중 | K bot을 준비하고 있습니다. 준비가 끝나면 K bot이 자동으로 입장합니다. | 아니오(오픈프로필이 생기면 sender 가 스스로 `queued` 로, D12) |

"예" 인 코드도 3.4.3 의 간격·횟수 규칙을 따른다(`retry_after`, 10번 넘으면 관리자만). 긴 문구의 "문의해 주세요." 옆에는 화면이 `[data-support]` 버튼을 붙인다(3.1).

`입장 중` 의 보조 문구: 기본 `K bot이 이 방에 들어가고 있습니다.` / `no_bot` → 라벨 `입장 중 · 순서 대기`, `입장 순서를 기다리고 있습니다. 순서가 되면 자동으로 입장합니다.` / `rate_limited` → `카카오 입장 제한으로 {HH:MM}에 다시 입장을 시도합니다.` / `hold_reason` → `운영자가 확인한 뒤 K bot이 들어갑니다.` `kicked` 의 `「{닉네임}」` 은 방에 보이는 봇 이름(오픈프로필 이름)으로 바뀌고, 모르면 그 부분을 뺀다.
이 표는 `lib/installs.js` `ERRORS` 가 단일 소스다(작업 2). 패널·사이트·판매 관리 화면은 서버가 준 `label`·`detail` 을 그대로 쓴다.

### 5.7 방별 처리 (봇 슬롯의 메시지 경로)

`onMessage`·`onPacket`(NEWMEM/DELMEM/피드)·`guardTick`·`visitScan` 맨 앞:

```js
const v = this.views.get(chatId)
if (!v || !v.licensed || v.state === 'error') return
```

- 방 관리 기능(입장·퇴장 로그, 들낙, 나간 사람 내보내기, 프로필, 홍보 금지, 가리기, 금지어, 올킥 방지)과 `/v1/bot/hide`·`/v1/bot/unkick`·`/v1/bot/people` 은 `roombotLive(v) = v.products.roombot && (v.perm & 5) && v.state === 'active'` 일 때만(한 함수로).
- 가리기 링 버퍼(7.2(e))와 작성자 목록은 `v.products.roombot` 인 방에서만 채운다. 미니게임만 있는 방에서는 남의 글 작성자 id 를 모으지 않는다.
- 미니게임은 `v.products.minigame && v.cfg.games.enabled` 이면 상태가 `active`·`waiting_host` 어느 쪽이든.
- 기존 `features.mjs` 함수들은 **방 어댑터 기록**으로 부른다(7.6). 새 기능은 순수 함수 모듈 `roomfeat.mjs`.
- 실행 상태는 방마다 `room_state.runtime` 에 둔다. 저장은 더러움 표시 + 5초마다 일괄(메시지마다 저장 금지). 정지 때 한 번 더 저장.
- 송신은 방별 대기열 + 봇 전체 페이서. 한 방의 지연(`VISIT_GAP_MS` 등)이 다른 방을 막지 않는다.

### 5.8 봇 오픈프로필 (D12)

봇은 고객 방에 카카오톡 기본 프로필이 아니라 그 계정의 **오픈프로필**로 들어간다. 프로토콜 근거는 node-kakao 4.5.0(`OpenProfileType.OPEN_PROFILE = 16`, `OpenLinkProfile.serializeLinkProfile`, `joinChannel`, `changeProfile`, `getLatestLinkList`)이고 실측 전이다(10.1 #9, `DEPLOY.md` 의 실측 순서).

- **찾기**: 접속할 때마다·`SYNCLINK*` 푸시(맡은 방 링크가 아닌 것, 5초 뒤·1분에 1번)·관리자 `[오픈프로필 다시 읽기]`·`BOT_PROFILE_READ_MS`(기본 6시간)마다 `SYNCLINK {ltk:0}` 을 보낸다. `ols` 가운데 `lt === 1` 이고 오픈프로필 표지 `op` 가 있거나 `lu` 가 `open.kakao.com/me/` 인 것만 오픈프로필이다(`lt 2` = 이 계정이 만든 방, `/o/` 1:1 오픈채팅 링크는 뺀다). 이름 = `olu.nn || ln`. 결과를 `bot_accounts.open_profiles` 에 남긴다. 읽기에 실패하면 남긴 값을 그대로 쓴다(실패를 "없음"으로 보지 않는다). SYNCLINK 가 오픈프로필을 보여 주지 않으면 관리자가 그 링크를 넣는다(`url`): `JOININFO {lu}` 로 `lt === 1` 이고 `olu.userId` 가 이 봇일 때만 목록에 더한다.
- **고르기**: 관리자가 고른 것(`open_profile_pick`) → 지난번에 쓰던 것 → 목록의 첫 번째. 상태 `ok`·`none`(없음)·`gone`(고른 것이 목록에 없음, 다시 고를 때까지 입장 멈춤)·`unknown`(아직 못 읽음). 지금 쓰는 것을 `open_profile_li`·`open_profile_name` 에 쓴다(`none`·`gone` 이면 비운다). 배정(4.4)은 `open_profile_li` 가 있는 봇을 먼저 고른다.
- **입장**: 5.3 의 0'·4. `ok` 가 아니면 카카오에 아무것도 보내지 않는다. 오픈프로필이 준비되면 `bot_no_open_profile` 방을 스스로 다시 입장 줄에 넣는다.
- **방마다 기록**: 입장·점검 때 `CHATONROOM.olu`(`ptp`·`pli`·`nn`, 없으면 `MEMBER(self)` — 오픈채팅 멤버의 `pli` 는 오픈프로필일 때만 있다)를 `room_state.runtime.prof = {open, pli, nn, chat, by, at, fail?, failAt?, sw?}` 로 남긴다(이 봇·이 방일 때만 유효). 미니게임만 있는 방도 모를 때 한 번 읽는다. `/v1/bot/status.rooms[].profile` = `open`(고른 오픈프로필)·`other`(다른 오픈프로필)·`main`(기본·닉네임 프로필)·`failed`(바꾸기 거절)·`unknown`.
- **방장에게 보이는 이름**: 입장 안내·`방 관리봇 추가` 안내(7.9)는 그 방에서 읽은 이름(`olu.nn`, 오픈프로필 이름). 부모의 RoomView 이름(`waitingDetail`·`kicked` 의 「{닉네임}」·`bot.nickname`)은 `installs.BOT_NAME_SQL` = `room_state.runtime.prof.nn`(지금 봇·지금 방) → (v6 때 들어간 방) `nickname` → `bot_accounts.open_profile_name` → `nickname`. sender 는 입장하자마자 `runtime.prof` 를 저장하므로, 들어가 있거나(`active`·`waiting_host`) 내보내진(`kicked`) 방인데 `prof` 가 하나도 없으면 v6 때 기본 프로필로 들어간 방으로 보고 기본 프로필 이름(닉네임)을 쓴다. sender 는 이런 방(들어가 있는 방)을 시작 후 1분쯤 뒤에 점검해 `prof` 를 남긴다.
- **이미 들어간 방 바꾸기**: 나갔다 다시 들어가지 않는다(부방장·입장 알림 때문에). `UPLINKPROF {li, ptp:16, pli}` 1회(`c` 없음)를 봇의 작업 줄에서 입장 다음 순서로, 입장과 같은 간격·`BOT_PROFILE_SWITCH_PER_HOUR`(기본 6) 예산으로 보낸다. 보내기 전에 지금 프로필을 다시 읽어 이미 바뀌었으면 보내지 않는다. 뒤에 `CHATONROOM` 으로 확인한다. 성공: `runtime.prof` 갱신, 권한을 다시 판정(부방장 유지 확인), 부방장 대기 방이면 방 안내 `[K bot]\nK bot 프로필이 「{이름}」(으)로 바뀌었어요.\n방장님이 「{이름}」을(를) 부방장으로 지정하면 방 관리 기능이 시작돼요.` 1회(문구는 7.9, `roomfeat.profileChangedNotice`). 거절: 방 상태는 그대로, `runtime.prof.fail = status`·`failAt`, 자동으로는 `BOT_PROFILE_RETRY_MS`(기본 24시간) 안에 다시 보내지 않는다. `room_log` 는 남기지 않는다(패널 기록에 `입장` 으로 잘못 보이지 않게, 결과는 `/admin/room` 의 `live.profile` 과 sender 로그).
  - 언제: `BOT_PROFILE_CONVERT=off`(기본)면 관리자가 방 상세의 `[오픈프로필로 바꾸기]`(`/admin/room-profile how=switch`)를 누를 때만, `auto` 면 점검 때 `main`·`other` 인 방을 차례로.
  - `[다시 입장(오픈프로필)]`(`how=rejoin`): 바꾸기가 거절된 방의 마지막 수단. 입장 예산이 있을 때만 행을 먼저 `queued`(perm 비움)로 쓰고 → 7.9 안내 기록을 지우고 → `leaveChat` → 사전 확인 없이 `JOINLINK ptp:16`. 방장이 부방장을 다시 지정해야 하고 입장 안내가 다시 나간다(`room_log 'state'` `{state:'queued', event:'rejoin'}`).

---

## 6. 화면 · UX

### 6.1 페이지 목록

| 경로 | 파일 | `data-page` | 담당 |
|---|---|---|---|
| `/` | index.html | home | 4 |
| `/buy` | buy.html | buy | 4 |
| `/order/:id` | order.html | order | 4 |
| `/login` | login.html (새) | login | 4 |
| `/signup` | signup.html (새) | signup | 4 |
| `/account` | account.html (새) | account | 4 |
| `/support` | support.html (새) | support | 4 |
| `/demo` | demo.html (새) | demo | 체험 (6.13) |
| `/my` | — | — | 서버가 302 `/account` (작업 1, server.js) |
| `/panel` | panel.html | — | 5 |
| `/manage` | manage.html | — | 6 |

캐시 무효화: `style.css?v=13`, `app.js?v=18`, `support.js?v=1`, `kk.css?v=1`, `demo.css?v=2`, `demo.js?v=1`, `panel.css?v=15`, `panel.js?v=19`, `manage.js?v=5`. 브랜드 마크업은 `BRAND.md` 대로 빈 `<span class="brand-mark" aria-hidden="true"></span>` 이다.

**보안 헤더**(작업 1, server.js 의 HTML 응답 전부 — `page(...)` 와 정적 `.html`): `X-Frame-Options: DENY` + `Content-Security-Policy: frame-ancestors 'none'`. `/panel`·`/manage` 에는 여기에 `script-src 'self'; object-src 'none'; base-uri 'self'` 를 더한다(두 화면은 제3자 스크립트를 싣지 않는다, D25). 사이트 화면은 채널톡 SDK 가 여러 호스트를 쓰므로 `script-src` 를 걸지 않는다.

**`/support`** (`support.html`, 작업 4): 사이트 셸 + `.pub-page` 안 h1 `실시간 상담`, 리드 `오류나 결제 문의를 채팅으로 상담합니다. 주문번호나 방 번호를 함께 보내면 확인이 빠릅니다.`. support.js 가 뜨면 바로 상담 창을 연다(`?ctx=` 가 있으면 첫 메시지로 넣음). 상담 창을 쓸 수 없으면 `contact` 연락처 안내(6.10). 콘솔의 상담 버튼은 이 화면을 새 창으로 연다.

### 6.2 상단 바와 바닥글 (사이트 공통, 작업 4)

```html
<nav class="top-nav" aria-label="주요 메뉴">
  <a class="btn ghost hide-s" href="/login" data-nav="login" data-auth="out">로그인</a>
  <a class="btn ghost icon-s" href="/login" data-auth="out" aria-label="로그인"><svg class="ic" width="16" height="16" aria-hidden="true"><use href="#i-user"></use></svg></a>
  <a class="btn ghost hide-s" href="/account" data-nav="account" data-auth="in" hidden>내 계정</a>
  <a class="btn ghost icon-s" href="/account" data-auth="in" hidden aria-label="내 계정"><svg class="ic" width="16" height="16" aria-hidden="true"><use href="#i-user"></use></svg></a>
  <a class="btn ghost" href="/demo" data-nav="demo">체험</a>
  <a class="btn ghost" href="/buy" data-nav="buy">구매</a>
  <a class="btn primary" href="/panel" data-nav="panel">패널 열기</a>
</nav>
```

- 지금의 `내 키`(`/my`) 버튼은 없앤다.
- HTML 기본은 로그아웃 상태. `window.kbSite`(support.js 가 만든 `/api/site` 프라미스)가 `member` 를 주면 `[data-auth="in"]` 를 보이고 `[data-auth="out"]` 를 숨긴다. `.icon-s` 는 760px 이하에서만 보인다(style.css 에 규칙 추가). 로그아웃 상태의 휴대폰 상단에도 로그인 진입점(아이콘)이 있다.
- `체험`(`/demo`)은 휴대폰(760px 이하)에서도 상단 바에 보인다(360px 에서도 한 줄에 든다). 바닥글 · 구매 화면 맨 위 체험 소개(6.6) · 상품 카드의 `[체험하기]` · 패널 왼쪽 아래 링크(`구매` 옆 `체험`)로도 들어간다.
- 바닥글 링크: `체험`, `구매`, `내 계정`, `주문 조회`, `패널`, `<button type="button" data-support>문의하기</button>`. `.foot .links button` 에 `a` 와 같은 규칙을 준다. `[data-support]` 를 보일지는 `hidden` 이 아니라 `<html data-support>` 값으로 CSS 가 정한다(6.10).
- 모든 사이트 페이지 `<head>` 에 `<script src="/support.js?v=1" defer></script>` 를 `app.js` 보다 먼저.

### 6.3 로그인 `/login`

- `.pub-page` 안 `.auth`(폭 400px). 제목 `회원 로그인`, 리드 `아이디와 비밀번호로 로그인합니다. 구매 내역과 이용 중인 상품은 회원 계정에 저장됩니다.`
- 폼 `#loginForm.card.form`: `#fld-login`(`#login_id`, `autocomplete="username"`, `autocapitalize="off"`), `#fld-pw`(`#pw`, `type="password"`, `autocomplete="current-password"`), `#submitErr`, 버튼 `#loginBtn` `로그인`(`.btn.primary.lg.wide`, `.spin`+`.lbl-idle`).
- `p.or` `또는`, `#googleBtn` = `<a class="btn lg wide" href="/auth/google/start?mode=login&next=…">` + 4색 G 마크(인라인 SVG, 이 문서가 허용하는 유일한 색 예외) + `Google 계정으로 로그인`. `/api/site.google=false` 면 `#googleBtn`·`.or` 숨김.
- `.hint` `Google 계정은 내 계정에서 연결한 경우에만 사용할 수 있습니다.`
- `.auth-foot`: `회원가입`(→`/signup?next=`), `비밀번호를 잊은 경우`(Google 재설정 링크. Google 꺼져 있으면 링크 대신 `#forgotNote` 만).
- `#forgotNote`(늘 보임, `.hint`): `Google 계정을 연결하지 않았다면 문의하기로 아이디를 전달하십시오. 확인 뒤 임시 비밀번호를 안내합니다.` + `[data-support]` `문의하기`. 관리자는 `member-pwreset` 으로 처리한다.
- (없앰) 예전 라이선스 키 안내 `#keyNote` — 손님 화면의 키 등록을 없앴다. 아이디 칸에 `KAKA-` 를 넣으면 `라이선스 키로는 로그인할 수 없습니다. 아이디로 로그인하거나 회원가입해 주세요`.
- `?g=` 는 3.2.2 문구를 `.note` 로. `?next=` 는 `^/(?!/)` 만 허용(`#` 포함 가능), 기본 `/account`.
- 성공 → 토스트 없이 `next` 로 이동.

검증 문구(사이트 `setErr` 패턴):

| 상황 | 칸 | 문구 |
|---|---|---|
| 아이디 비어 있음 | login | 아이디를 입력하십시오 |
| 비밀번호 비어 있음 | pw | 비밀번호를 입력하십시오 |
| `bad_credentials` | submitErr | 아이디 또는 비밀번호가 일치하지 않습니다. 다시 입력하십시오 |
| `locked` | submitErr | 로그인 실패 횟수를 초과했습니다. {N}분 후 다시 시도하십시오 |
| `blocked` | submitErr | 이용이 정지된 계정입니다. 문의하십시오 (+ `[data-support]`) |

### 6.4 회원가입 `/signup`

- 제목 `회원가입`, 리드 `아이디와 비밀번호만으로 가입합니다. 가입한 계정으로 상품을 구매하고 콘솔에 로그인합니다.`
- 칸: `아이디 *`(hint `영문 소문자로 시작하는 소문자·숫자·밑줄 4~20자`), `비밀번호 *`(`#pw`, `new-password`, hint `8자 이상`), `비밀번호 확인 *`(`#pw2`), `연락처 · 선택`(`#contact`, hint `입금 확인이 늦어질 때 연락드릴 번호입니다`).
- 버튼 `#signupBtn` `가입`. 성공 → 토스트 `가입되었습니다` → `next`(기본 `/account`).
- 폼 아래 `.hint`: `가입 후 내 계정에서 Google 계정을 연결해 두면 비밀번호를 잊었을 때 직접 다시 정할 수 있습니다.`

| reason | 칸 | 문구 |
|---|---|---|
| `bad_login_id` | login | 아이디는 영문 소문자로 시작하는 소문자·숫자·밑줄 4~20자로 입력하십시오 |
| `reserved_id` | login | 사용할 수 없는 아이디입니다. 다른 아이디를 입력하십시오 |
| `taken` | login | 이미 사용 중인 아이디입니다. 다른 아이디를 입력하십시오 |
| `bad_password` | pw | 서버 `error` 그대로(예: 비밀번호는 8자 이상 입력하십시오 / 아이디와 같은 비밀번호는 사용할 수 없습니다 / 너무 쉬운 비밀번호입니다. 다른 비밀번호를 입력하십시오) |
| 불일치(클라이언트) | pw2 | 비밀번호가 일치하지 않습니다 |

### 6.5 내 계정 `/account`

`.pub-grid`: 왼쪽 `.pub-main` 카드 묶음, 오른쪽 `aside`. 로그인 안 했으면 `/login?next=` + `encodeURIComponent(location.pathname + location.search + location.hash)` 로 이동(`/my` → `/account#claim` 에서 온 경우 `#claim` 이 남는다).

머리: eyebrow `내 계정`, h1 = login_id(mono), 오른쪽 `#logoutBtn` `.btn.ghost` `로그아웃`.
Google 이 켜져 있고 이 회원이 연결하지 않았으면 머리 아래 `.note.dim` `#googleNudge`: `Google 계정을 연결해 두면 비밀번호를 잊었을 때 직접 다시 정할 수 있습니다.` + `연결`(→ `#acc-google` 의 연결과 같은 주소).

| 카드 id | 제목 | 내용 |
|---|---|---|
| `#acc-products` | 이용 중인 상품 | `.feat-row` 3줄. 카카오톡 매크로: chip `사용 중 · D-n`(ok) / `만료 임박 · D-n`(warn, 7일 이하) / `만료됨`(bad) / `미구매`, 30일 기준 `.bar`, `.meta` `만료 YYYY.MM.DD HH:MM`, `연장 구매`(→`/buy?macro=1`). 방 관리봇·미니게임봇: `방 n개`, 확인 필요가 있으면 chip warn `확인 필요 n`, 버튼 `내 방 보기`(→`/panel#rooms`), `방 추가`(→`/buy#rooms`). `legacy_room_until>now` 면 `.note.dim` `기존 키로 쓰던 계정 기능(입장·퇴장 로그 등)은 YYYY.MM.DD까지 콘솔에서 계속 사용할 수 있습니다.` |
| `#acc-orders` | 구매 내역 | 최근 주문 목록: 주문번호(mono) · 상태 chip(회원 주문용 `STATUS_MEMBER` 매핑, 6.7) · 줄 요약(`카카오톡 매크로 2개월 · 방 관리봇 1개`) · 금액(`wonKids`) · 날짜, 행 전체가 주문 화면 링크. `can_cancel` 이면 행 끝에 `주문 취소`(인라인 2단계 확인: `입금한 뒤에는 취소하지 마십시오.` + `취소`) → `POST /api/my/orders/cancel`. 비어 있으면 `구매 내역이 없습니다.` |
| `#acc-sessions` | 로그인 기기 | 세션 목록(`device` · 마지막 사용 · `지금 이 기기` 표시 — IP 는 보이지도 보내지도 않는다, 손님이 불안해해서 뺐다), 행마다 `로그아웃`(인라인 확인), 아래 `다른 기기 모두 로그아웃`. hint `동시에 로그인할 수 있는 기기는 3대입니다. 4번째 기기에서 로그인하면 가장 오래 쓰지 않은 기기가 로그아웃됩니다.` |
| `#acc-google` | Google 계정 | 미연결: `Google 계정을 연결하면 비밀번호를 잊은 경우 Google 계정으로 로그인하여 새 비밀번호를 정할 수 있습니다.` + `연결`(→`/auth/google/start?mode=link&next=/account`). 연결됨: mono 이메일(가림) + `연결 해제`(인라인으로 비밀번호 칸이 펼쳐짐 → `해제`). Google 꺼져 있으면 카드 숨김 |
| `#password` | 비밀번호 변경 | 현재·새·확인. `/api/me.password_reset_open` 이 true 면 현재 칸을 숨기고 `.note` 3.2.2 `recover` 문구. 버튼 `변경`. 성공 토스트 `비밀번호를 변경했습니다. 다른 기기는 로그아웃되었습니다` |
| ~~`#claim`~~ | (없앰) 기존 라이선스 키 등록 | 손님 화면에서 뺐다(운영자 지정). `POST /api/auth/claim` 은 남아 있지만 화면에서 부르지 않는다. 구매 화면·로그인 화면·패널 로그인의 키 등록 안내도 함께 뺐다. |

aside: `.note.dim` `오류가 발생하면 문의하십시오. 주문번호를 함께 전달하면 확인이 빠릅니다.` + `[data-support]` `문의하기`.

### 6.6 구매 `/buy`

- 상품 카드(`.prods` 안에 세로로 3개, 가격은 `/api/price`): 왼쪽 위 상품 아이콘 칸(`.p-ic` — 매크로 `i-macro`, 방 관리봇 `i-shield`, 미니게임봇 `i-game`) + 이름, 설명, 체크 글머리, 맨 아래 가격 줄(`15,000원 / 1개월(30일)` + 작은 칸 `한 번에 1~12개월`·`기간 제한 없음`). 상품마다 색 하나(공용 `:root` 토큰 `--p-macro` 파랑 · `--p-room` 보라 · `--p-game` 분홍과 그 `-soft`·`-line`·`-glow`, `.prod[data-prod]` 가 `--acc*` 로 받는다)를 아이콘 칸·체크·고른 카드 테두리·금액에만 쓴다.
- 체험 소개(로그아웃 상태 — `data-auth="out"` + 처음부터 `hidden`, applyAuth 가 로그아웃으로 확인되면 보인다. 로그인한 회원에게는 잠깐도 보이지 않는다): 머리말 바로 아래 낮은 띠 `section.intro`(상품 카드가 첫 화면에 남게). 왼쪽 `체험` · `미니게임봇 · 방 관리봇 · 매크로가 하는 일을 구매 전에 볼 수 있습니다` · 리드(실제 방에서와 같은 문구 · 실제 카카오톡에 아무것도 보내지 않음) · `[체험하기]`(보조 버튼 — 구매하기가 주 버튼으로 남는다, `/demo`) 옆에 장면 바로 열기(미니게임 `#games` · 입장·퇴장 기록 `#visit` · 홍보 금지 `#promo` · 자동 발송 `#macro`, 휴대폰에서는 한 줄 가로 스크롤). 오른쪽 작은 카카오톡 방(kk.css, 높이 320px, 누르면 `/demo`): 나 `!도움` → K bot(부방장) `[명령어]` 답 한 쌍이 차례로 나타난다(움직임 줄이기면 한 번에). 보내기 버튼은 빈 입력 칸이라 회색. K bot 글은 실제 봇 함수 결과와 같아야 한다 — `lib/demo-check.js` 가 방 관리봇 + 미니게임봇 방(프로필 기록 켬)의 `helpLine` 과 비교하고, 장면 바로 열기 4개가 실제 장면인지 본다. 시각은 app.js `introNow()` 가 지금(한국 시간)으로 바꾼다.
- 로그아웃 상태: 상품 카드와 `#loginGate` 카드(`로그인`·`회원가입`, 둘 다 `next=` 지금 주소). 상품 카드마다 맨 아래 `{상품} 구매하기` 버튼 → `/login?next=/buy?p={상품}`(로그인하면 그 상품을 고른 채로 돌아온다). 옆에 `[체험하기]` → `/demo#macro`·`#visit`·`#games`(6.13, app.js `PROD_DEMO`). 폼은 숨김.
- 로그인 상태 `#buyForm.form` — **상품부터 고른다**(예전엔 방 관리봇을 사려면 `설치할 방` 의 `방 추가` 만 보여 손님이 어떻게 사는지 몰랐다). `.fsec` 마다 `.fsec-h` 단계 제목(`.step` + 번호 `.sn`, 번호는 보이는 칸 순서대로 다시 매긴다):
  1. `#pickSec` `상품 고르기` — hint `구매할 상품을 누르세요. 여러 개를 함께 골라도 됩니다.` `#picks.prods.picks` 안 상품 카드 3개(로그아웃 화면과 같은 카드). 카드 전체를 덮는 `.chk`(`#pick-{상품}`)라 카드 어디를 눌러도 고르고, 오른쪽 위 동그라미가 체크 표시다. 고른 카드는 `.sel` — 상품 색 테두리·빛, 아이콘 칸이 상품 색으로 차고, 체크가 톡 튀어나온다.
  2. `#macroSec` `매크로 기간`(매크로를 골랐을 때만): `.num #macroMonths`(1~12개월). hint `이미 쓰고 있으면 지금 만료일에 이어서 늘어납니다. 발송은 패널에 등록한 내 카카오 계정으로 합니다.` 이용 중이면 `#macroNow` `지금 만료일 YYYY.MM.DD · 여기에 이어서 늘어납니다`.
  3. `#rooms` `봇을 넣을 오픈채팅방`(방 관리봇·미니게임봇 중 하나라도 골랐을 때만, 고르면 방 행 1개가 바로 열린다): hint `방 링크를 붙여 넣으면 방 이름을 확인합니다. 방마다 한 번만 결제하면 기간 제한 없이 씁니다.` 방 행마다:
     - `#room{i}-link`(`type="url"`, placeholder `https://open.kakao.com/o/…`) + `확인` → `POST /api/room-preview`(붙여넣기·blur 때도). 미리 보기 줄·`verified:false` 확인란·참여코드 칸은 전과 같다.
     - 이 방에 넣을 봇 `.rprods`: **위에서 고른 봇만** 보이고 처음부터 켜져 있다(둘 다 골랐으면 방마다 끌 수 있다). `available.X=false` 면 비활성 + `설치됨`/`입금 대기`.
     - `빼기`(방이 2개 이상일 때만 — 마지막 한 줄은 빼지 않고, 그만 사려면 위에서 상품을 끈다). 아래 `다른 방도 추가`(최대 10). 링크가 빈 행은 보내지 않는다(한 줄도 없으면 `봇을 넣을 오픈채팅방 링크를 붙여 넣어 주세요`).
     - 이용 조건 확인란 `#terms` + 펼침 문단.
  4. `#payerSec` `입금자 정보`: `입금자명 *`, `연락처 (선택)`, `메모 (선택)`.
- 미리 고르기: `?p=macro,roombot,minigame` · `?macro=1`(매크로) · `#rooms`(방 관리봇) · `?add=<install_id>`(그 방을 행 1개로 미리 채우고 — 링크 읽기 전용 — 그 방에 아직 없는 봇을 위에서 고른다. 둘 다 있거나 입금 대기면 토스트). 패널·내 계정의 구매 버튼은 `?p=` 로 그 상품을 고른 채 연다(`봇 구매` → `?p=roombot`).
- 아무것도 고르지 않고 주문하면 `#err-pick` `구매할 상품을 1개 이상 골라 주세요`.
- aside `#sum`: 줄마다 `.ln`(`카카오톡 매크로 2개월` / `방 관리봇 · 동네모임`), `.ln.total` `결제 금액`, `.nudge` 지금 뒷자리 설명, `#submitBtn` `주문 접수`. 그 아래 `.note.dim` `구매 중 문제가 생기면 문의하십시오.` + `[data-support]` `문의하기`.
- 움직임(공개 페이지 전체): 들어올 때 제목·카드·칸이 위에서부터 차례로 살짝 떠오르고(`riseIn`), 숨겨 뒀다 보여 주는 칸(`#macroSec`·`#rooms`)도 보일 때 같은 움직임. 상품 카드는 마우스를 올리면 살짝 뜨고, `결제 금액` 이 바뀌면 숫자가 아래에서 올라온다. 페이지 맨 위에 상품 색 3개의 은은한 빛이 천천히 흐른다. 움직임 줄이기 설정이면 전부 끈다.
- 오류: 3.3 표의 `reason`·`room` 으로 칸에 붙이고, 첫 오류 칸으로 포커스+스크롤, 토스트 `입력 내용을 확인하십시오`. `room_taken`·`pending_exists`·`blocked_room`·`too_many_pending` 문구 옆에는 `[data-support]` 버튼을 붙인다.
- 주문이 접수되면 **주문 화면 `/order/{id}?t={token}` 으로 바로 넘어간다**(`location.replace`, `new=1` → 제목 `주문 완료`·리드 `아래 금액을 입금하면 이 화면에서 자동으로 확인됩니다. …`·토스트 `주문이 완료되었습니다`, 그 뒤 주소에서 `new=1` 을 뺀다). 그 화면이 5초마다 상태를 다시 읽어 입금 확인·처리 완료·방 입장을 실시간으로 보여 준다(6.7). 살아있는 표시(`입금 확인 대기 중 ••• N초 경과`)는 카드 맨 위에 두고, 보고 있는 동안 상태가 바뀌면 토스트 `입금이 확인되었습니다`/`처리가 끝났습니다`. 주문번호를 못 받은 예외에서만 이 자리에 `showResult` 결과를 그린다.

### 6.7 주문 상태 `/order/:id`

- 지금 폴링·금액 블록·`.wait` 유지. 리드(order.html:77) → `입금이 확인되면 이 화면에서 적용 결과와 방 입장 상태를 확인할 수 있습니다. 이 탭을 열어 두십시오.`
- 회원 주문(`kind='member'`)은 app.js 의 키 시대 문구를 아래로 바꾼다(예전 키 주문은 지금 문구·화면 그대로, `issued_key`). 자동 확인이 꺼져 있으면(`data-manual`·`AUTO_APPROVE=false`) 오른쪽 열.

| 자리(app.js) | 회원 주문 · 자동 확인 | 회원 주문 · 관리자 확인 |
|---|---|---|
| `STATUS_MEMBER.pending` | 입금 대기 | 입금 대기 |
| `STATUS_MEMBER.paid` | 입금 확인됨 · 적용 준비 | 입금 확인됨 · 적용 준비 |
| `STATUS_MEMBER.done` | 적용 완료 | 적용 완료 |
| `STATUS_MEMBER.canceled` | 취소됨 | 취소됨 |
| `issueMsg()` | 입금 후 1~2분 안에 자동으로 적용됩니다 | 입금 후 관리자가 확인하여 적용합니다 |
| 대기 줄(`makeWait`, paid) | 적용 대기 중 | 적용 대기 중 |
| 대기 팁(pending) | 입금 후 통상 1~2분 안에 상품이 회원 계정에 적용됩니다. 이 화면이 5초 간격으로 상태를 확인하므로 열어 두십시오. | 입금 후 관리자가 확인하여 적용합니다. 이 화면은 자동 갱신되므로 열어 두십시오. |
| 대기 팁(paid) | 입금이 확인되었습니다. 적용을 기다리십시오. 이 화면은 자동 갱신됩니다. | 같음 |
| 완료 팁 | 방은 K bot 계정이 입장한 뒤 내 방에서 상태를 확인합니다. 카카오톡 매크로는 콘솔에 카카오 계정을 등록하면 바로 사용합니다. | 같음 |
| 30분 경과 문구 | 30분 동안 적용되지 않아 자동 확인을 멈췄습니다. [상태 새로고침]으로 다시 확인하십시오. 같은 상태가 이어지면 주문번호를 전달하여 문의하십시오. | 같음 |
| order.html 오른쪽 `.note.dim` | 입금 확인은 금액 매칭으로 자동 처리됩니다. 안내된 금액을 뒷자리까지 정확히 입금하면 통상 1~2분 안에 상품이 회원 계정에 적용됩니다. 금액이 다르거나 30분이 지나도 상태가 바뀌지 않으면 주문번호와 입금자명을 전달하여 문의하십시오. (+ `[data-support]`) | 입금 확인 후 관리자가 적용합니다. 안내된 금액을 뒷자리까지 정확히 입금하십시오. 30분이 지나도 상태가 바뀌지 않으면 주문번호와 입금자명을 전달하여 문의하십시오. (+ `[data-support]`) |
| `TTL_CANCELED_MSG` | 미입금 48시간 경과로 자동 취소되었습니다. 이미 입금한 경우 주문번호를 전달하여 문의하십시오. | 같음 |

- 완료 시 `.big.keybox` 대신: chip ok `적용 완료`, `.kv` 줄 — `카카오톡 매크로` → `만료 YYYY.MM.DD`, 방마다 `{방 이름}` → `방 관리봇 · 미니게임봇 · {상태 라벨}` + 그 아래 `.dim` 한 줄로 `rooms[].detail`(`waiting`·`error`·`joining` 일 때. 방장에게 지정할 봇 닉네임이 여기 나온다). 오류 행이면 `[data-support]` `문의하기`.
- 완료 버튼: 주문에 방 줄이 있으면 primary `내 방 보기`(`/panel#rooms`). 매크로만이고 `accounts_n === 0` 이면 primary `카카오 계정 등록`(`/panel#account-add`), 그 밖(`accounts_n` 이 1 이상이거나 null)은 primary `콘솔 열기`(`/panel`). 보조 `내 계정`. 완료 뒤에도 방 상태가 `사용 중` 이 될 때까지 10초 폴링을 이어 간다(최대 10분).
- `can_cancel` 이면 금액 블록 아래 `주문 취소`(인라인 2단계 확인, 6.5 와 같은 문구).

### 6.8 홈 `/` · 구매 · 주문 화면의 문구 (작업 4)

index.html·buy.html·order.html 의 키 시대 문구는 **부록 A 의 문자열 표**대로 전부 바꾼다(`data-manual` 변형 포함, 줄 번호는 `9db383a` 기준). 요지:
- 메타 설명·히어로·기능·구조도·동작 방식·가격·FAQ·CTA·바닥글에서 `라이선스 키`·`키 발급`·`8개`·`계정마다` 를 없앤다. 방 관리 기능은 "카카오 계정마다"가 아니라 "K bot 계정이 방마다" 동작한다고 쓴다.
- 가격 섹션: `.prods` 행 3개(카드 3개를 가로로 늘어놓지 않는다). 매크로 `15,000원 / 1개월(30일)`, 방 관리봇 `10,000원 / 방 1개 · 기간 제한 없음`, 미니게임봇 같은 형식.
- `항상 켜져 있다고 보장하지 않습니다` 문구는 남긴다.
- `site-accounts.mjs` 가 `public/index.html`·`buy.html`·`order.html`·`login.html`·`signup.html`·`support.html` 과 `app.js` 의 회원 주문 문구에 `키 발급`·`키가 발급`·`8개`·`계정마다`·`자동응답` 이 없음을 단언한다(예외: `account.html` 의 `#claim` 카드, app.js 의 예전 키 주문·`/my` 분기).

### 6.9 콘솔 `/panel` (작업 5)

#### 로그인 카드 `#login`

- 구조 유지. 리드 2개: `회원 아이디로 로그인합니다. 콘솔 로그인은 기기에 묶지 않으며, 동시에 기기 3대까지 로그인할 수 있습니다.` / `결제가 확인되면 그때부터 카카오톡 매크로 사용 기간이 시작됩니다.` (panel-check 의 `기기에 묶지 않`·`사용 기간이 시작됩니다` 단언을 그대로 만족)
- 칸: `#login-id`(아이디, `.inp`, `autocomplete="username"`), `#login-pw`(`type="password"`), `#login-error`, `#loginBtn` `로그인`. `/api/auth/login` 을 부른다. 아래 `#loginGoogle`(사이트와 같은 버튼, Google 꺼지면 숨김).
- (없앰) 옛 키 사용자용 `#login-keynote` — 키 등록을 없애면서 뺐다.
- `.login-foot`: `회원가입`(`/signup?next=/panel`) · `내 계정`(`/account`) · `[data-support]` `문의하기`.

#### 사이드바

```
개요 (G O) · 주요 알림 (G I) · 카카오 계정 (G A) · 내 방 (G B, #navRoomN "사용 중/전체", 확인 필요 시 .rd 점)
p.nav-cap  매크로 설정 · {계정 이메일}
  매크로 (G M) · 갠톡 응답 (G R) · 저격 규칙 (G S)
  [legacy 일 때만] 입장·퇴장 로그 (G V) · 프로필 로그 (G P) · 올킥 방지 (G K) · 금지어 검열 (G C)
p.nav-cap#navCapRoom  방 설정 · {방 이름}    (방을 고른 뒤에만 보임)
  방 상태 · 입장·퇴장 로그 · 프로필 로그 · 홍보 금지 · 가리기·금지어 검열 · 올킥 방지 · 미니게임
```

- `#lic`: `#who` = login_id, `#licLeft` = `매크로 D-n` / `오늘 만료` / `매크로 미구매` / `매크로 만료`, `#licBar` 30일 기준.
- `.side-foot .links`(두 줄 두 칸 격자): `구매`(i-receipt) · `체험`(i-play, `/demo`) · `[data-support]` `문의하기`(i-help, 새 창으로 `/support`, 6.10) · `로그아웃`.
- 매크로가 없거나 만료면 매크로 설정 화면 위에 `.banner`(crit 띠): `카카오톡 매크로 사용 기간이 아닙니다. 발송과 주요 알림이 멈춰 있습니다.` + `구매`(→`/buy?macro=1`).

**계정 단위 옛 기능 게이트**(`account.legacy`, 3.4.1): `legacy` 가 false 인 계정을 보는 동안 다음을 **모두** 숨기거나 막는다 — 사이드바 4항목, 개요 `기능` 표의 `.feat[data-feat="visit"|"profile"|"guard"|"cover"]` 4행(panel.html:142-161, 스위치 포함), 명령 팔레트의 같은 4항목(panel.js:2847 부근), 단축키 `G V`·`G P`·`G K`·`G C`, 해시로 바로 연 `#visit`·`#profile`·`#guard`·`#cover`(→ `#rooms` 로 바꾸고 `notify('방 관리 기능은 내 방에서 방마다 설정합니다.')`). 서버 403 은 마지막 방어선이다.

**카카오 계정 화면**(`#accounts`, 지금 `계정`): 내비·h1 을 `카카오 계정` 으로. 리드 `카카오톡 매크로로 발송할 내 카카오 계정을 최대 {max_accounts}개까지 등록합니다. 등록된 계정의 발송과 기록은 서버가 수행합니다.`(panel.html:233). 상한 막대 `n / {max_accounts}`, `#add-full`(panel.html:257)과 panel.js:3100 의 알림도 `카카오 계정은 {max_accounts}개까지 등록할 수 있습니다.` — 숫자는 `/panel/api/me.max_accounts` 에서 읽고 HTML 에 `8` 을 쓰지 않는다.
**매크로가 없을 때 계정 추가**: `macro.active` 가 false 이고 `legacy_room_until <= now` 면 `#account-add` 의 마법사 대신 `.off-note` `카카오 계정 등록은 카카오톡 매크로를 이용 중일 때 할 수 있습니다.` + `구매`(→`/buy?macro=1`). 개요의 `#ov-add`·`#acc-add` 는 그대로 이 화면으로 온다(카카오 비밀번호를 입력한 뒤에야 `no_macro` 를 만나지 않게). 등록이 끊긴 기존 계정의 재등록은 막지 않는다.

#### 라우트

해시 형식 `#<route>` 또는 `#<route>/<install_id>`. 라우터는 `/` 앞을 라우트, 뒤를 인자로 읽는다. 방 라우트에 인자가 없으면 마지막으로 고른 방(`localStorage['kb.room']`, try/catch), 그것도 없으면 `#rooms`.

| route | t (화면 이름) | 폼 | G |
|---|---|---|---|
| `rooms` | 내 방 | — | b |
| `room` | 방 상태 | `room-form`(명령어 앞글자) | — |
| `r-visit` | 입장·퇴장 로그 | `r-visit-form` | — |
| `r-profile` | 프로필 로그 | `r-profile-form` | — |
| `r-promo` | 홍보 금지 | `r-promo-form` | — |
| `r-cover` | 가리기·금지어 검열 | `r-cover-form` | — |
| `r-guard` | 올킥 방지 | `r-guard-form` | — |
| `r-games` | 미니게임 | `r-games-form` | — |

저장은 기존 저장 바(`#save`, `saveBtn.form = '<route>-form'`)로. 저장 본문은 `POST /panel/api/bot-room/settings {id, rev, <그 화면의 절들>}`. 저장 성공 `notify('저장했습니다.', '{방 이름}')`.

#### 부팅과 개요 `#overview`

- 부팅: `kbSite` 의 `member` 가 없으면 `#login`. 있으면 `GET /panel/api/me` → 해시가 있으면 그 라우트, 없으면: 계정이 있으면 지금 규칙(마지막 계정 → 첫 live 계정), 계정이 없고 방이 있으면 `#rooms`, 둘 다 없으면 `#overview`.
- 개요 지표 4칸은 DOM(`.metric[data-metric]`)을 유지하고 내용만 바꾼다: `unread` 안 읽은 갠톡(전체 계정) · `macro` 매크로(`D-n`/`미구매`/`만료`) · `rooms` 사용 중인 방(`n / 전체`) · `attn` 확인 필요(계정 등록 필요 + 방 오류·부방장 대기). 입장·퇴장·이름 변경 지표는 옛 기능 유예 회원의 입장·퇴장 로그 화면에만 남는다.
- `#ov-attn` 확인 필요 목록에 방 행(`error`·`waiting`)을 더한다. 행을 누르면 `#room/<id>`.
- 계정도 방도 없으면 개요 본문 대신 `.empty` `구매한 상품이 없습니다.` + `카카오톡 매크로 구매`(→`/buy?macro=1`)·`방 추가`(→`/buy#rooms`).

#### 내 방 `#rooms` (panel.html 에 이 마크업 그대로)

```html
<section class="page" data-route="rooms" id="page-rooms" aria-labelledby="rooms-title" hidden>
 <div class="col">
  <div class="ph"><div><h1 id="rooms-title" tabindex="-1">내 방</h1><p>방 관리봇과 미니게임봇을 설치한 오픈채팅방입니다. 설정은 방마다 따로 저장됩니다.</p></div>
    <div class="ph-r"><a class="btn primary" href="/buy#rooms" id="rooms-add"><svg class="ic" width="14" height="14" aria-hidden="true"><use href="#i-plus"></use></svg>방 추가</a></div></div>
  <div class="grp" id="rooms-attn-grp" hidden><h2 class="grp-t">확인 필요</h2>
    <section class="sec" id="rooms-attn" aria-label="확인이 필요한 방"></section></div>
  <section class="sec clip"><div class="tbl-wrap">
    <table class="tbl stack" id="rooms-tbl"><thead><tr><th>대화방</th><th>상품</th><th>상태</th><th>K bot 계정</th><th><span class="sr">열기</span></th></tr></thead>
      <tbody id="rooms-list"></tbody></table></div>
    <p class="empty" id="rooms-empty" hidden>설치한 방이 없습니다. 방 추가에서 오픈채팅방 링크를 입력하고 구매합니다. 방 1개 · 상품당 10,000원입니다.</p>
    <div class="sec-f"><span class="poll" data-poll><svg class="ring" viewBox="0 0 14 14" aria-hidden="true"><circle class="bg" cx="7" cy="7" r="5"/><circle class="fg" cx="7" cy="7" r="5"/></svg><span>10초마다 갱신</span></span><span>부방장 지정은 1~2분 안에 자동으로 감지합니다.</span></div></section>
 </div>
</section>
```

표 행(panel.js 가 `esc()` 를 거쳐 만든다):

```html
<tr class="rowx" data-room="12" tabindex="0" role="link" aria-label="동네모임 방 상태 열기">
  <td data-l="대화방"><b>동네모임</b> <span class="mono dim">open.kakao.com/o/gAbCdEf</span></td>
  <td data-l="상품"><span class="tag line">방 관리봇</span> <span class="tag warn">미니게임봇 · 입금 대기</span></td>
  <td data-l="상태"><span class="state" data-state="waiting"><i class="dot warn"></i>부방장 지정 대기</span></td>
  <td data-l="K bot 계정"><span class="mono">K bot 3</span></td>
  <td class="go"><svg class="ic" width="16" height="16" aria-hidden="true"><use href="#i-right"></use></svg></td>
</tr>
```

- 이름이 아직 없으면 `<b>` 에 `이름 확인 전`. 상태 점: `pending`·`joining`·`waiting` = `dot warn`, `active` = `dot live`, `error` = `dot crit`. 행 클릭·Enter → `#room/<id>`.
- `#rooms-attn` 행(`error`·`waiting`·`pending`, 없으면 묶음 숨김):

```html
<div class="srow inline" data-room="12"><div class="srow-l"><span class="lb">동네모임</span><p>{detail}</p></div>
  <div class="srow-r"><span class="state" data-state="error"><i class="dot crit"></i>{label}</span> {버튼}</div></div>
```

  `{버튼}`: `passcode_needed`·`passcode_wrong` 이고 `can_retry` → `<a class="btn sm" href="#room/12" data-focus="r-passcode">참여코드 입력</a>`(그 화면에서 `#r-passcode` 에 포커스. 목록에서 바로 다시 시도하지 않는다). 그 밖의 `can_retry` → `<button type="button" class="btn sm" data-retry="12">다시 시도</button>`(`retry_after` 가 미래면 비활성 + `{HH:MM} 이후`). `can_retry` 가 아닌 `error` → `<button type="button" class="btn sm" data-support data-support-ctx="방 #12 · {label}">문의하기</button>`. `waiting` → `<a class="btn sm" href="#room/12">안내 보기</a>`. `pending` → `<a class="btn sm" href="{order.url}">입금 안내</a>`.
- `panel.css` 에 `.state[data-state="pending"|"joining"|"waiting"]` warn, `[data-state="active"]` live 규칙 추가(토큰만). `.sr`(화면 낭독 전용) 규칙이 없으면 추가.

#### 방 상태 `#room`

- `.ph`: h1 방 이름, `p` mono 링크 + `K bot 계정 「{닉네임}」`, `.ph-r` 에 `.state#room-state` 와 `목록`.
- `ol.stepper#room-steps`: 방 관리봇이 있으면 `.stepper.s4` 4단계 `입금 → 입장 → 부방장 지정 → 사용`, 미니게임만이면 3단계 `입금 → 입장 → 사용`. `.done`/`.cur` 는 display 로. `panel.css` 에 `.stepper.s4 { grid-template-columns: repeat(4, minmax(0, 1fr)); }` 와 `@media (max-width: 760px) { .stepper.s4 { grid-template-columns: repeat(2, minmax(0, 1fr)); row-gap: 14px; } }`(390px 에서 `부방장 지정` 이 잘리지 않게 2×2).
- `pending` 이면 `.srow.stack` `입금이 확인되면 K bot 계정이 입장합니다.` + `입금 안내`(RoomView `order.url`).
- `waiting` 이면 `#room-wait` 묶음: `.srow.stack` 설명(RoomView `detail`) + 패널 `.wait` 줄 `<i class="dot live pulse"></i><span class="grow">부방장 지정을 기다리는 중입니다 <span class="dim">· 1~2분 안에 감지</span></span>`. 미니게임도 있으면 `.note` `미니게임봇은 지금 사용할 수 있습니다.`
- `active` 이고 `on_count === 0` 이면 `.note` `방 관리 기능이 모두 꺼져 있습니다.` + `입장·퇴장 로그 설정`(→`#r-visit/<id>`) (방 관리봇이 있을 때만).
- `error` 이면 `.banner#room-err`: 긴 문구 + `can_retry` 면 `#room-retry` `다시 시도`(참여코드 오류면 그 앞에 `#r-passcode` 칸; `retry_after` 가 미래면 비활성 + `{HH:MM} 이후에 다시 시도할 수 있습니다`) + `[data-support]` `문의하기`(`data-support-ctx="방 #<id> · {label}"`).
- 상품 묶음: 상품 2줄(설치됨 `.tag.line` / 미설치는 `상품 추가` → `/buy?add=<id>`).
- **봇 옮기기·다시 설치**(3.4.3, 무료) `.grp#room-move-grp`, 제목 `봇 옮기기·다시 설치` + 오른쪽 `무료`. 상품 묶음 바로 아래, `room-form` 위. 입금 대기(`pending`)면 숨긴다.
  - `.srow#row-r-reinstall` `같은 방에 다시 설치` — 설명 `K bot이 방에서 내보내졌거나 방에서 답하지 않을 때 같은 방에 다시 들어갑니다. K bot이 방에 있으면 나가지 않고 상태만 다시 확인합니다. 내보내졌다면 먼저 오픈채팅방의 내보내기 목록에서 K bot을 해제해 주세요.` 오른쪽 `#r-reinstall-act` 안 `#r-reinstall-btn` `다시 설치`. 누르면 같은 자리가 인라인 확인으로 바뀐다: `K bot이 같은 방에 다시 들어갑니다.`(참여코드 오류인 방이면 `#r-reinstall-pc` 칸) + `취소` + `다시 설치`(primary). 성공 `notify('같은 방에 다시 설치합니다.', '{방} · K bot이 방에 들어가 상태를 다시 확인합니다.')`, 실패 `notify('다시 설치하지 못했습니다.', 서버 문구, {kind:'crit'})`. `can_reinstall` 이 아니거나 `reinstall_after` 가 미래면 버튼 비활성 + `p.hint#r-reinstall-note` = RoomView `reinstall_note`.
  - `.srow.stack#row-r-move` `다른 방으로 옮기기` — 설명 `옮길 오픈채팅방 링크를 입력합니다. K bot이 지금 방에서 나가고 새 방에 들어가며, 설정은 그대로 옮겨집니다. 방 링크만 바뀌었다면 바뀐 링크를 입력해 주세요. 같은 방이면 나가지 않고 다시 설치합니다.` 아래 `form#r-move-form`: `#r-move-link`(mono, placeholder `https://open.kakao.com/o/…`) + `#r-move-check` `링크 확인`. 2단계: ① `링크 확인` → `POST /api/room-preview`(3.3) → `.move-pv#r-move-pv` 에 `#r-move-q` 문장 — 다른 방이면 `「{방 이름}」 방으로 옮깁니다. K bot은 지금 방에서 나갑니다.`(+ 방 관리봇이 있으면 ` 새 방에서 K bot을 부방장으로 다시 지정해야 방 관리 기능이 동작합니다.`), 같은 방이면(`mine.install_id` 가 이 방) `지금 방과 같은 방입니다. 이 링크로 바꾸고 K bot이 같은 방에 다시 들어갑니다.`; 참여코드가 필요한 방이면 `#r-move-passcode`; `#r-move-no` `취소` · `#r-move-yes` `옮기기`/`다시 설치`. 미리 보기에서 막히는 경우(확인 못 한 링크, 내 다른 방, 입금 대기 예약, 옮기기 간격 안의 다른 방)는 확인 칸을 열지 않고 `#r-move-err` 에 까닭. ② `옮기기` → `POST /panel/api/bot-room/move` → 성공 `notify('K bot을 옮깁니다.', '{새 방} · K bot이 지금 방에서 나가고 새 방에 들어갑니다.')`(확인 대기면 `… · 관리자가 확인한 뒤 K bot이 들어갑니다.`, 같은 방이면 `notify('같은 방에 다시 설치합니다.', …)`), 방 제목·링크·상태가 RoomView 로 바뀐다. 실패는 `#r-move-err`. `can_move` 가 아니면 입력·버튼 비활성, `move_after` 가 미래면 `p.hint#r-move-note` = `move_note`(같은 방의 새 링크는 받으므로 입력은 막지 않는다). Esc 는 열린 확인을 닫는다.
  - `.sec-f` `#r-move-rule` = RoomView `self_rule`.
  - `error` 이고 오류 코드가 `link_gone`·`room_deleted`·`not_group`·`link_changed` 면 배너에 `#room-move-go` `새 링크 입력`(→ `#r-move-link` 로 포커스·강조), `#rooms` 의 확인 필요 줄 버튼도 `새 링크 입력`(`#room/<id>` + `data-focus="r-move-link"`).
- `room-form`: `.srow.inline` `명령어 앞글자` `.seg#r-prefix`(`!` `/` `.` `#`), 설명 `방 관리봇과 미니게임봇 명령어가 같은 앞글자를 씁니다.`
- 조치 기록 `table#r-log-tbl`(최근 100, `actions`): 시각 · 종류 · 대상 · 결과.
- 강등 감지(폴링 비교로 `active`→`waiting`, 직전 폴링에서도 `products.roombot` 이던 방만 — 미니게임만 쓰던 방에 방 관리봇을 더해 부방장 대기가 된 것은 강등이 아니다): `notify('부방장 권한이 해제되었습니다.', '{방} · 다시 지정하면 자동으로 이어집니다.', {kind:'warn'})`. 승격 감지(`waiting`→`active`): `notify('부방장 지정을 확인했습니다.', '{방} · 이제 방 관리 기능을 설정할 수 있습니다.')`.

#### 방 관리봇 화면 공통

- 방 관리봇이 없으면 화면 전체가 `.off-note` `이 방에는 방 관리봇이 설치되어 있지 않습니다.` + `상품 추가`.
- 있는데 `active` 가 아니면 폼 비활성 + `.off-note` `부방장 지정을 기다리는 중입니다. 방장이 K bot 계정을 부방장으로 지정하면 설정할 수 있습니다.`
- 각 기능은 `.sec` + `.srow.inline.main` 스위치 + `.dep` 펼침 + `.off-note`(지금 콘솔 문법). 7장이 칸 id·범위·문구를 정한다.

### 6.10 실시간 상담 (채널톡, 작업 4 의 `public/support.js`)

**상태 하나로 모든 버튼을 다룬다**: support.js 가 `<html data-support="off|chat|contact">` 를 정하고, CSS(style.css·panel.css 둘 다)가 `html:not([data-support="chat"]):not([data-support="contact"]) [data-support] { display: none !important; }` 로 보이기를 정한다. 그래서 나중에 그려지는 버튼(콘솔 `#room-err`, `#rooms-attn` 행, 주문 결과, 구매 오류 옆)도 따로 처리할 필요가 없다. 버튼에 `hidden` 을 쓰지 않는다.

1. 맨 먼저 `window.kbSite = fetch('/api/site', {credentials:'same-origin', cache:'no-store'}).then(r => r.json()).catch(() => ({ok:false}))`. `app.js`·`panel.js` 는 이 프라미스를 재사용한다(페이지당 요청 1회). `data-support="off"` 로 시작.
2. 방식: `<html data-support-mode="link">`(panel.html) 이면 **링크 방식**, 아니면 위젯 방식.
3. 결정:
   - `site.channel` 이 있고 위젯 방식 → 부록 B 의 공식 로더를 실행하고 `ChannelIO('boot', {pluginKey, memberId?, memberHash?, profile:{name: login_id}?, language:'ko', appearance:'dark', hideChannelButtonOnBoot:true}, cb)`. `cb(err, user)` 가 성공이면 `data-support="chat"`. 실패이거나 8초 안에 콜백이 없으면(차단·카카오톡 웹뷰) 아래 대체로.
   - `site.channel` 이 있고 링크 방식 → SDK 를 싣지 않고 `data-support="chat"`.
   - 대체: `site.contact` 가 있으면 `data-support="contact"`, 없으면 `off`.
4. 클릭: `document` 에 위임 처리기 1개 — `[data-support]` 를 누르면 `kbSupport.open(el.dataset.supportCtx)`. `customLauncherSelector` 는 쓰지 않는다(부팅 뒤에 생긴 버튼을 놓치므로).
5. `window.kbSupport = { open(ctx), reboot() }`:
   - 위젯·`chat` → `ChannelIO('openChat', undefined, ctx ? ctx + '\n' : undefined)`(입력창에 맥락을 미리 채움. 예 `주문 ORD-261009-AB12CD · 방 #12 · 참여코드 불일치`).
   - 링크·`chat`, 또는 `contact` → `window.open('/support' + (ctx ? '?ctx=' + encodeURIComponent(ctx) : ''), '_blank', 'noopener')`.
   - `reboot()` = `ChannelIO('shutdown')` → `/api/site` 다시 → 1~3 다시. 사이트 로그인·로그아웃 직후 부른다(콘솔은 SDK 가 없으므로 할 일 없음).
6. `/support` 화면: `chat` 이면 부팅 직후 `open(ctx)` 를 한 번 부르고 본문에 `상담 창이 열리지 않으면 아래 버튼을 누르십시오.` + `[data-support]` `상담 창 열기`. `contact` 면 `.note` 에 `site.contact` 를 그대로(textContent). `off` 면 `지금은 상담 창을 열 수 없습니다. 잠시 뒤 다시 시도하십시오.`
7. 회원 식별(D25, 8.8): `channelConfig(member)` 는 `CHANNEL_MEMBER_SECRET` 이 있을 때만 `member_id = 'm' + hex(HMAC-SHA256(HKDF(CONFIG_SECRET,'kbot','channel-member/v1'), String(member.id)))[0:24]`(순번이 아니라 추측할 수 없는 값)와 `member_hash = hex(HMAC-SHA256(hexDecode(CHANNEL_MEMBER_SECRET), member_id))` 를 준다. 없으면 이름만 넘기는 익명 부팅. 상담원은 회원을 **`memberId` 로만** 확인한다(표시 이름은 고객이 바꿀 수 있다). `/admin/members?q=m<24hex>` 가 이 값으로 회원을 찾는다(서버가 회원마다 계산해 비교).
8. `/manage` 에는 넣지 않는다. `/panel` 은 링크 방식이라 SDK 가 실리지 않는다(D25, 6.1 의 CSP).
9. `app.js` 전역 오류 토스트(1821-1827)는 다른 출처 스크립트 오류(`ev.filename` 이 우리 origin 이 아님, `Script error.`)와 스택에 `channel.io` 가 있는 rejection 을 무시하도록 고친다.
10. 문의 버튼 위치: 사이트 바닥글(`실시간 상담`), `/buy` aside 와 방 오류 옆, 주문·내 계정 aside(`문의하기`), 로그인 `#forgotNote`·`blocked`, 콘솔 사이드바·로그인 카드(`문의하기`), 콘솔 방 오류 배너·확인 필요 행(`문의하기`), 주문 화면의 방 오류 행. 빈 화면에는 두지 않는다.
11. `warnEnv`: `CHANNEL_PLUGIN_KEY` 와 `CONTACT_INFO` 가 둘 다 없으면 "상담 버튼이 모두 숨습니다" 경고.

### 6.11 아이콘 (스프라이트에 추가할 심볼)

아래 정의를 그대로 쓴다(viewBox 16, stroke 1.4, 고정 색 없음 — `currentColor` 만). 넣는 곳: 사이트 HTML 전부(작업 4), panel.html(작업 5), manage.html 은 필요한 것만(작업 6).

```html
<symbol id="i-link" viewBox="0 0 16 16"><g fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M6.8 9.2a2.6 2.6 0 0 0 3.7 0l2.2-2.2a2.6 2.6 0 0 0-3.7-3.7l-.9.9"/><path d="M9.2 6.8a2.6 2.6 0 0 0-3.7 0L3.3 9a2.6 2.6 0 0 0 3.7 3.7l.9-.9"/></g></symbol>
<symbol id="i-user" viewBox="0 0 16 16"><g fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"><circle cx="8" cy="5.5" r="2.6"/><path d="M3 13.5c.7-2.4 2.6-3.8 5-3.8s4.3 1.4 5 3.8"/></g></symbol>
<symbol id="i-lock" viewBox="0 0 16 16"><g fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"><rect x="3" y="7" width="10" height="6.5" rx="1.4"/><path d="M5.3 7V5.2a2.7 2.7 0 0 1 5.4 0V7"/></g></symbol>
<symbol id="i-help" viewBox="0 0 16 16"><g fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="8" r="5.8"/><path d="M6.3 6.4a1.8 1.8 0 0 1 3.5.5c0 1.2-1.8 1.5-1.8 2.6"/><path d="M8 11.4v.1"/></g></symbol>
<symbol id="i-game" viewBox="0 0 16 16"><rect x="2.5" y="2.5" width="11" height="11" rx="2" fill="none" stroke="currentColor" stroke-width="1.4"/><g fill="currentColor"><circle cx="5.6" cy="5.6" r=".9"/><circle cx="8" cy="8" r=".9"/><circle cx="10.4" cy="10.4" r=".9"/></g></symbol>
<symbol id="i-receipt" viewBox="0 0 16 16"><g fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M3.5 2.5h9v11l-1.5-1-1.5 1-1.5-1-1.5 1-1.5-1-1.5 1z"/><path d="M5.8 5.8h4.4M5.8 8.3h4.4"/></g></symbol>
```

쓰는 곳: `i-user` 상단 바 휴대폰 로그인·내 계정, `i-link` 콘솔 내 방·구매 화면 방 행, `i-lock` 비밀번호 카드·참여코드 칸, `i-help` 문의하기 버튼, `i-game` 콘솔 미니게임, `i-receipt` 구매 내역·주문 화면.
콘솔 사이드바 아이콘: 내 방 `i-link`, 방 상태 `i-overview`, 입장·퇴장 로그 `i-visit`, 프로필 로그 `i-profile`, 홍보 금지 `i-alert`, 가리기·금지어 검열 `i-cover`, 올킥 방지 `i-guard`, 미니게임 `i-game`.

### 6.12 관리 화면 `/manage` (작업 6)

- 머리 설명(manage.html:235) → `상품: 카카오톡 매크로 15,000원/1개월 · 방 관리봇 10,000원/방 · 미니게임봇 10,000원/방. 주문 승인과 입금 매칭은 자동 입금확인과 같은 방식으로 회원 계정에 적용됩니다.`
- 탭: `주문 · 입금 · 회원 · 봇 · 방 · 키 · 기록`. `.mg-tabs { overflow-x:auto; scrollbar-width:none }`.
- 요약 타일 8개(`repeat(4)`): 처리 대기 주문 · 확인 필요 입금 · 회원 · 이용 중 매크로 · 설치된 방 · 부방장 대기 · 오류 방 · K bot 계정(`접속 n / 전체 n`).
- `/v1/bot/status.join_paused_until` 이 미래면 화면 맨 위 crit 띠 `카카오가 서버 IP 의 입장을 막았습니다. {HH:MM}까지 모든 방 입장을 멈춥니다.`
- 주문 항목: 회원 주문이면 `keyLine` 대신 회원 아이디와 줄 요약(확인하지 못한 방 줄은 `.tag.warn` `미확인`), 승인 대화상자에 키 입력 없음, 결과 `적용 완료`. 승인이 `room_taken` 이면 대화상자가 충돌 방 목록과 `환불할 금액 n원` 을 보이고 `충돌한 방을 빼고 승인`(`skip_conflicts:true`) 버튼을 준다.
- 회원 항목: 아이디(mono) · `Google 연결` tag · chip `정상`/`차단`. `.mg-line` `매크로 D-n · 방 관리봇 n · 미니게임봇 n`. `.mg-meta` `가입 … · 최근 로그인 …`. 동작: `상세`·`기간 추가`·`차단`/`차단 해제`·`로그아웃`·`임시 비밀번호`. 상세는 `modal({wide:true})`. 상세의 `이관한 키` 줄마다 이관 시각·IP 와 `다른 회원으로 옮기기`(`license-reassign`, 회원 아이디 입력, `confirmAct`).
- 봇 항목: 닉네임 · mono 이메일 · chip(`접속 중` ok / `연결 대기` warn / `등록 필요` bad) · `nickname_dup` 이면 `.tag.warn` `이름 중복`(hint `방장이 구분할 수 있게 봇마다 다른 오픈프로필 이름을 쓰십시오`). 오픈프로필(D12, 5.8) 줄 `오픈프로필 「{이름}」 · open.kakao.com/me/…`, 없으면 `.tag.crit` `오픈프로필 없음` + crit 줄 `이 봇 계정에 오픈프로필이 없습니다. 카카오톡에서 이 계정으로 오픈프로필을 만든 뒤 [오픈프로필 다시 읽기]를 누르십시오. 기본 프로필로는 입장하지 않습니다.`, `gone` 이면 `.tag.warn` `오픈프로필 선택 필요`, 모르면 `.tag.line` `오픈프로필 확인 전`. 오픈프로필이 여럿이고 고르지 않았으면 hint `오픈프로필이 n개입니다. 지금은 「…」로 입장합니다.`, 오픈프로필이 아닌 프로필로 들어가 있는 방이 있으면 hint 로 그 수. 부하 막대 `.bar > i`(80% 이상 `.warn`) + `방 n / 상한`. 동작: `오픈프로필 선택`(라디오: 자동 + 목록, `다시 읽기`, 링크로 확인)·`오픈프로필 다시 읽기`·`재등록`·`새 방 받기 중지`/`새 방 받기 재개`·`최대 방 수 변경`·`삭제`. 등록은 콘솔 계정 등록 마법사와 같은 단계(휴대폰 확인 코드 표시, `.big` + `.v.key` 숫자 + `.wait` 점).
- 방 항목: 방 이름 · 상품 tag · (봇이 그 방에 오픈프로필이 아닌 프로필로 들어가 있으면 tag `기본 프로필`·`다른 오픈프로필`·`프로필 바꾸기 거절`) · 상태 chip(0.1 의 5단계, 사이트 chip 색) · `.mg-line` mono 링크 · 회원 아이디 · `.mg-meta` 봇 · 사유 · 시도 횟수 · 고객 다시 시도 횟수. 동작: `다시 시도`·`다른 봇으로 이동`·`링크 바꾸기`·`상품 변경`·`다른 회원에게 넘기기`(`room-transfer`)·`확인 후 입장`(`hold_reason` 있을 때, `room-release`)·`설치 해제`·`방 금지`(`room-block`, 사유 입력) — 해제·금지는 `confirmAct` danger. 필터: 전체 · 확인 필요 · 확인 대기(hold) · 부방장 대기 · 사용 중 · 입금 대기. 방 탭 아래 `금지한 방` 목록(`room-blocks`, 행마다 `금지 해제`). 방 상세의 정보에 `봇 프로필`(`live.profile`), 오픈프로필이 아니면 `봇 프로필` 칸에 `오픈프로필로 바꾸기`(primary)·`다시 입장(오픈프로필)`(danger, 부방장 다시 지정 경고) — 5.8.
- `manage.js` 의 `FEATS`·`FEAT_LABEL`·`PRODUCT` 상수는 `/api/price` 로 대체.

### 6.13 체험 `/demo` (화면)

공개 화면(로그인 없음). `demo.html` + `kk.css?v=1`(카카오톡 방 화면 `.kk-*` — 구매 화면 체험 소개와 같이 쓴다) + `demo.css?v=2`(체험 화면 배치 · 휴대폰 틀) + `demo.js?v=1`(자체 IIFE — app.js 는 헤더만 맡는다). 방에 나오는 K bot 글은 서버(`lib/demo.js` · `routes/demo.js`, `/api/demo*` — 3.7)가 실제 봇 함수로 만들고, 화면은 받은 글을 textContent 로만 그린다. 실제 카카오톡에는 아무것도 보내지 않는다.

- 문구: 제목 `K bot 체험`, 리드 `카카오톡 방과 같은 화면에서 미니게임봇, 방 관리봇, 매크로가 하는 일을 확인합니다. 체험 중에는 실제 카카오톡에 아무것도 보내지 않습니다.` 화면에서는 `데모` 대신 `체험`(TONE.md). 버튼 묶음 이름 `상황 만들기`(장면의 actions) · `바로 입력`(chips).
- 배치: 1100px 이상 `장면 목록(상품 묶음 → 장면) | 휴대폰(400px) | 설명 · 고르기 칸 · 버튼 · 패널 기록 · [구매] · [다시 시작]`. 760~1100 장면 탭(가로 스크롤)이 위, 휴대폰과 설명이 나란히. 760 미만 탭 → 설명(고르기 칸) → 버튼(`바로 입력` 은 한 줄 가로 스크롤) → 휴대폰(높이 `min(60svh, 560px)`, 최소 400px, 테두리 없음) → 안내 한 줄 → `[구매]` · `[다시 시작]` — 첫 화면에 누를 버튼이 보이고, 안내가 나타나도 버튼이 밀리지 않는다. 1099px 이하·터치 화면에서 누르는 곳 44px. 360·390px 에서 가로 스크롤 없음. 체험 화면은 머리말 여백을 줄이고(`.pub-head` 위 32px · 아래 24px) 휴대폰 높이를 `clamp(460px, 100vh - 290px, 760px)`(760~1100 은 `clamp(420px, 100vh - 370px, 760px)`)로 둬 1366×768 · 1440×900 에서 처음부터 입력 칸까지 보인다. 대화는 아래(입력 칸 쪽)에 붙여 쌓는다(글이 적어도 새 글은 입력 칸 바로 위). `상황 만들기` · `바로 입력` 을 눌렀을 때 휴대폰 아래쪽(새 글 · 입력 칸 · 안내)이 화면 밖이면 그만큼만 페이지를 내린다(모든 너비, 휴대폰 위가 머리 막대 밑으로 들어가지 않는 데까지).
- 휴대폰 = 카카오톡 오픈채팅방(밝은 기본 테마 `color-scheme: light`, 색은 `:root` 의 `--kk-*` 만): 위 막대(뒤로 · 방 이름 + 인원 · 검색 · 메뉴 — 모양만), 공지 띠(`i-notice`, 한 줄 말줄임, 누르면 펼침), 날짜 알약 `2026년 10월 12일 월요일`, 방 알림 알약(`…님이 들어왔습니다.`), 남의 말풍선(흰색, 둥근 네모 프로필 — K bot 은 `.brand-mark`, 그 밖은 이름 첫 글자 + `--kk-av-0..5`, 첫 줄에 이름과 `방장`/`부방장` 표시), 내 말풍선(노랑, 오른쪽). 같은 사람 · 같은 분이면 묶는다: 프로필 · 이름 · 꼬리는 첫 줄, 시각(`오후 7:31`, roomfeat `kstClock` 과 같은 모양)은 마지막 줄. 말풍선 옆 노란 숫자(안 읽은 사람 수)는 방 인원에서 시작해 3초쯤에 걸쳐 줄어 사라진다(장식, 화면 읽기 프로그램에는 숨김. 갠톡은 내가 보낸 글에만 1). 멘션은 `{start, len}` 칸(반각 `@` 부터)만 굵게, 링크는 글자 그대로, 가려진 글은 `가려진 메시지입니다.`(회색 기울임), 500자 넘는 글은 잘라 두고 `[전체보기]`. 입력 칸: `+` · `메시지 입력` · 보내기(글이 있을 때만 노랑). Enter 보내기(한글 조합 중 `isComposing`/229 제외), Shift+Enter 줄바꿈. 위로 올려 보는 중 새 글이 오면 아래 띠(이름 + 첫 줄)를 띄운다. 대화 칸은 `role="log" aria-live="polite"`.
- 재생: 응답 `out` 을 `wait`(ms) 간격으로 하나씩 그린다(재생 줄 하나). 요청은 누른 순서대로 하나씩, 앞 응답의 `state` 로 보낸다(버튼은 늘 누를 수 있다). 손님 글은 응답을 기다리지 않고 그리고 `cid` 로 보낸다(시각은 마지막으로 그린 글 기준, 재생이 끝났으면 응답 `clock` 도 본다). 장면을 열 때 `wait` 0 으로 온 앞부분은 원래 방에 있던 글로 보고 움직임 · 안 읽은 수 없이 그린다. `panel` 항목은 방 밖 `K bot 패널 기록` 칸(새 것이 위), `hint` 는 휴대폰 아래 안내 한 줄(마지막 것만 — 단계마다 그 단계 항목을 그리기 시작할 때 앞 단계의 안내를 지운다). `member` 는 이름 바꾸기 · 나감 표시. 위 막대 인원은 `feed.count` 가 있으면 그 값, 없으면 `member` 로 ±1.
- 오류: 429 → 서버 문구를 안내 줄(경고 모양 — 표시가 `i` 대신 `!`, app.js 의 경고 안내와 같다)에. `bad_state` → 처음부터 다시 연다(처음 한 번은 조용히, 다시 연 뒤 곧바로 또 나면 서버 문구도 안내 줄에). 경고 모양 안내는 다음 단계가 성공하면 지운다. 연결 실패 → `연결이 끊겼습니다. 잠시 뒤 다시 시도해 주세요.` 장면 목록 · 시작을 못 받으면 휴대폰 안에 문구 + `[다시 시도]`.
- 주소 `/demo#장면`(없거나 모르는 장면이면 목록의 `first`). 장면을 바꾸면 상태를 버리고 새로 시작한다. 고르기 칸을 바꾸거나 `[다시 시작]` 을 눌러도 처음부터.
- 움직임: 새 말풍선 · 알약은 300ms 살짝 떠오른다. 움직임 줄이기 설정이면 움직임만 없애고 간격(`wait`)은 그대로.
- 들어오는 길: 상단 바 `체험`(모든 너비 — 359px 이하는 상단 바 여백을 줄여 한 줄에 든다), 바닥글 `체험`, 구매 화면 맨 위 체험 소개(6.6), 패널 왼쪽 아래 `체험`, 구매 화면 로그아웃 카드의 `[체험하기]`(매크로 `#macro` · 방 관리봇 `#visit` · 미니게임봇 `#games`, app.js `PROD_DEMO`). 로그인 상태의 고르기 카드에는 넣지 않는다(카드 전체가 고르기 칸).
- 스프라이트: buy.html 과 같은 심볼 + 이 화면에만 `i-notice`(공지 띠).
- 검사: `lib/panel-check.js` 가 demo.css · kk.css 의 색(토큰만) · 두 파일에 `:root` 없음 · demo.html/demo.js 의 이모지 · `데모` · `해 보세요` 를 본다.

---

## 7. 방 관리 기능과 미니게임 (봇 계정 위에서, 작업 3 런타임 · 작업 1 검증 · 작업 5 화면)

### 7.1 방 설정 스키마 (`room_installs.config`)

`lib/room-config.js`(작업 1)의 `sanitizeRoomConfig(prev, body, ctx)`·`presentRoomConfig(cfg, products)` 가 단일 소스. sender 는 쓸 때 같은 범위로 다시 자른다.

| 경로 | 형 | 기본 | 범위·규칙 |
|---|---|---|---|
| `v` | int | 1 | |
| `cmdPrefix` | str | `!` | `!` `/` `.` `#` 중 하나 |
| `exempt` | `[{user_id, name}]` | `[]` | 최대 50, `user_id` `/^[1-9][0-9]{0,19}$/`, name 40자. 방장(1)·부방장(4)·봇(8)은 항상 제외 |
| `visit.enabled` | bool | false | 입장·퇴장 로그(지금 동작: 방 안내 + 기록) |
| `visit.style` | str | `image` | `image` \| `text` — 방에 보내는 입장·퇴장 안내 모양(7.2 (f)) |
| `churn.enabled` | bool | false | 들낙 감지 |
| `churn.joins` | int | 3 | 2~20 |
| `churn.windowMin` | int | 10 | 1~1440 |
| `churn.action` | str | `warn` | `warn` \| `kick` |
| `churn.notice` | bool | true | |
| `leaveKick.enabled` | bool | false | 나갔을 때 내보내기 |
| `leaveKick.notice` | bool | false | |
| `profile.enabled` | bool | false | 프로필 로그 |
| `profile.name` / `.status` | bool | true | 예전 `.photo` 는 무시(7.2 (c)) |
| `profile.lookup` | str | `staff` | `staff` \| `all` \| `off` — `{앞글자}프로필조회` |
| `profile.style` | str | `image` | `image` \| `text` — 프로필 변경 안내 모양(7.2 (f)) |
| `promo.enabled` | bool | false | 홍보 금지 |
| `promo.links` / `.cards` | bool | true | |
| `promo.media` | bool | false | |
| `promo.hide` | bool | true | 위반 글 가림 |
| `promo.kickAt` | int | 3 | 0~10, 0 = 내보내지 않음 |
| `promo.resetHours` | int | 24 | 1~720 |
| `promo.notice` | bool | true | |
| `cover.enabled` | bool | false | 금지어 검열(기본 욕설 + 고객 금지어 + 링크) |
| `cover.words` | `[str]` | `[]` | 최대 **300**개, 단어 30자, 중복 제거(지금 `sanitizeWords` 규칙) |
| `cover.links` | bool | true | 홍보 금지의 링크가 켜져 있으면 링크는 홍보 금지가 맡는다 |
| `hide.command` | bool | true | 방 안 `{앞글자}가리기` 명령 |
| `hide.by` | `staff`\|`host` | staff | 가리기 명령을 쓸 수 있는 사람: 방장·부방장 / 방장만(아니면 `글 가리기는 방장만 할 수 있어요.`) |
| `hide.target` | `members`\|`staff` | members | 가리는 범위: 일반 멤버 글 / 부방장 글까지. 방장·봇 글은 늘 뺀다. 가리기 명령·콘솔 가리기·금지어 검열(금지어·욕설·링크)에 함께 쓴다(`roomfeat.hideSkips`). 홍보 금지는 따르지 않는다 |
| `guard.enabled` | bool | false | 올킥 방지 |
| `guard.secs` | int | 30 | 5~300 |
| `guard.count` | int | 5 | 3~30 |
| `cmd.link` | str | `staff` | `staff` \| `all` \| `off` — 방 안 `{앞글자}옾링` 을 쓸 수 있는 사람(7.2 (g)). 프로필 기록을 꺼도 동작한다 |
| `games.enabled` | bool | **true** | 미니게임. 기본이 켜짐이라 미니게임봇은 입장하자마자 `!도움`·게임에 답한다(소유자 요구 "링크 첨부하면 바로 드가고"). 처음 `minigame` 이 켜지는 설치에 이 기본값을 채운다(4.2) |
| `games.word` `.baseball` `.dice` `.rps` `.quiz` | bool | true | 랭킹은 항상 켜짐 |
| `games.sword` | bool | true | 추억의 검 강화(7.3.1). 이 칸이 없는 예전 저장본도 켜짐으로 읽는다 |
| `games.cooldownSec` | int | 3 | **1**~60 (0 은 공용 봇 발송 한도를 한 방이 다 쓰게 하므로 받지 않음) |
| `games.dailyLimit` | int | 0 | 0~5000, 0 = 제한 없음(방 발송 6/분 한도가 따로 막는다, 5.5) |

검증 실패는 저장 거부(조용히 버리지 않음): 400 `bad_<path>`, 문구 예 `들낙 감지 횟수는 2~20회로 입력하십시오.`, `금지어는 300개까지 등록할 수 있습니다.`, `제외할 사람은 50명까지 등록할 수 있습니다.`
sender 기본값(`roomfeat.DEFAULTS`)은 이 표(`room-config.DEFAULTS`)와 글자 그대로 같아야 한다(selfcheck #40-5 가 본다).
제품 검사: roombot 절(`exempt visit churn leaveKick profile promo cover hide guard cmd`)은 `products.roombot` 과 `display==='active'` 필요, `games` 는 `products.minigame` 필요, `cmdPrefix` 는 설치됨이면 언제나.

### 7.2 기능별 동작

#### (a) 들낙 감지

- 들어오는 경로 정리: 봇 슬롯은 리스너 `member_joined`/`member_left` 를 쓰지 않고 `onPacket`(NEWMEM·DELMEM·피드 4/2/3/6) 하나로만 받는다. `chatLog.logId`·`sendAt` 을 같이 넘긴다.
- 중복 판정: logId 가 있으면 `chat|logId|사람` 으로(방마다 1시간·400개). 없으면 같은 사람·같은 종류 **5초**(`VISIT_DEDUP_MS`). 기존 60초 규칙은 없앤다(계정 단위 옛 기능에도 같은 규칙 적용).
- 시각은 `ev.at`(=`sendAt`) 우선. 입장 횟수는 시각이 같아도 이벤트마다 센다.
- `churnCheck(state, cfg, ev)`: 사람별 입장 시각 목록(최대 40). `windowMin` 안 입장 ≥ `joins` 이고 그 창에서 아직 조치하지 않았으면 → 안내(`notice`) + `room_log 'churn'`, `action==='kick'` 이면 강퇴 동작 추가. 제외·방장·부방장은 무시. 이름만 있고 id 를 확정 못 하면(`memberIdByName` 이 유일하지 않음) 경고만 + `room_log` `id 확인 불가`.
- 방 안내(멘션 1개, 이름은 자기 줄에):

```
[들낙 감지]
이름 : @{이름}
입장 : {M}분 동안 {횟수}회
조치 : 경고 | 내보내기 | 내보내기 실패
{오전|오후 h:mm}
```

#### (b) 나갔을 때 내보내기

- 퇴장(피드 2·3)에만. 피드 6(강퇴)에는 반응하지 않는다.
- `leaveKickPlan`: id 없음 → `kick_fail` `id 없음`. 제외·방장·부방장(캐시 권한 1·4) → 건너뜀. 그 외 → `KICKMEM`.
- `KICKMEM` 이 실패하면(이미 나간 사람에 대한 강퇴 허용 여부는 **실측 전**) `state.bans[userId] = {at, name}`(최대 1000, 30일). 이 실패는 연속 실패로 세지 않는다(5.5). 연속 실패 멈춤·올킥 감지·한도로 건너뛰어도 `bans` 에 적고 `kick_fail`(`why:'leave'`) 을 남긴다(까닭은 앞의 `skip` 기록, `내보낸 사람` 표에서 해제할 수 있게). 방 관리봇이 꺼져 있으면(`roombotLive` 아님) 적지 않는다. 표는 최근 조치 기록 100줄(입장·퇴장 제외)로 만들므로 건너뛴 사람은 `skip`·`kick_fail` 두 줄을 남기고, 나가는 사람이 많은 방에서는 일찍 표에서 밀려날 수 있다(그래도 다시 들어오면 내보낸다). 레이트리밋 답(`RATE_STATUS`)은 나간 사람이어도 연속 실패로 센다. 그 id 가 다시 들어오면 재입장 차단이 켜져 있고 제외 대상·방장·부방장(캐시 권한)이 아닐 때 바로 강퇴(그때는 방 안에 있으므로 성공하고 카카오 내보내기 목록에 올라 재입장이 막힌다). 이 경우 잠깐 들어왔다가 나가지고, 30일이 지나면 막지 못한다 — 화면 문구가 이를 그대로 말한다(7.4).
- 화면의 `내보낸 사람` 표에서 `내보내기 해제` → `KLDELITEM` + `bans` 삭제. 표와 해제 대상은 **K bot 이 내보낸 사람**(이 설치의 `room_log` `kick`·`kick_fail`, `bans`)뿐이다. 방장이 직접 내보낸 사람은 풀지 않는다(3.4.3 `not_kicked`).
- 안내(`notice` 켰을 때, 멘션 없음): `[재입장 차단]\n이름 : {이름}\n{오전|오후 h:mm}` (화면 이름 `나간 사람 재입장 차단`)

#### (c) 프로필 로그

- 관찰 원천: MSG 푸시 `authorNickname`(실측 전), `SYNCLINKPF` 푸시(실측 전), 입장 때 `memberCard`, 방마다 60초에 최대 1회 MEMBER(≤20명)로 명부에 카드가 없는 사람(글로 이름만 본 사람 등) 채우기.
- `profileObserve(state, cfg, {userId, name, status})`: 상태 메시지는 null 이면 무시. 첫 관찰은 기준만 저장. 변경은 `changes` 에 `{at, kind:'name'|'link'|'status', from?, to?}`(최근 30개).
- **방 안내 모양(관리자 지정, 최대한 간단하게)**: `[제목]` / `이름 : @{닉네임}`(멘션 @ 는 글에 하나) / 값 줄 / 맨 아래 시각 `{오전|오후 h:mm}`(`kstClock`, 한국 시간). 기호·접기([전체보기])는 쓰지 않는다. 들낙 감지·재입장 차단·홍보 금지도 맨 아래에 같은 시각 줄. 입장·퇴장·프로필 변경은 시각 줄 대신 시각만 적은 기록(`recordLines`): `{입장|퇴장|변경} 기록 : N회` / 최근 시각 5개 `{MM.DD 오전|오후 h:mm}`(`kstWhen`, 옛 → 새, 마지막 줄이 이번, 가장 최근과 해가 다르면 앞에 `YYYY.`).
- 프로필 변경 안내: `[프로필 변경 감지]` / `변경전 : ＠{옛 닉네임}`(전각 ＠ — 멘션 아님) / `변경후 : @{지금 닉네임}`(멘션) / `옾링 : {링크|없음|확인 못 함}` / 변경 기록. 닉네임이 그대로면 `이름 : @{닉네임}`. 옾링·상태 메시지가 바뀌었으면 `옾링 변경전 : …` / `옾링 변경후 : …`(이때 `옾링 :` 줄은 없다). 바뀔 때마다 알린다(같은 사람이 연달아 바꿔도 매번). 변경 기록의 횟수는 바뀐 때의 수(한 번에 여러 칸이 바뀌면 한 번).
- **방 멤버 명부(room_members)**: 봇이 방에 들어가 사용 중이 되면 GETMEM 으로 모든 멤버의 닉네임·pli 를 읽고, pli 는 INFOLINK(20개씩, 봇마다 메모리 캐시)로 옾링 주소를 얻는다. 10분마다 다시 읽고(BOT_MEMBER_SYNC_MS), 들어온 사람은 카드(MEMBER)로, 메시지 닉네임이 다르면 카드를 다시 읽어 합친다. GETMEM 이 빠뜨린 사람이 글을 쓰면 이름만 적어 두고 위의 카드 채우기가 읽는다. 아는 사람의 닉네임·옾링(pli 바뀜)이 바뀌면 프로필 변경 안내(profileChange). 옾링은 pli 가 바뀔 때만 바뀐 것으로 본다 → 비어 있던 옾링('')을 같은 pli 로 다시 읽어 채워도 안내하지 않는다. 퇴장 안내는 명부의 옾링을 쓴다 → 봇보다 먼저 있던 사람도 옾링이 나온다. 명부에 없는 사람이 나가면 로그 한 줄을 남기고, 안내를 만들기 전에 MEMBER 를 한 번 읽어 본다(방마다 10초에 1회, 2초까지. 나간 사람에게도 답하는지는 실측 전). 명부 일(동기화·채우기·다시 읽기)은 방 점검과 따로 봇마다 한 줄로 하고, 하나가 BOT_MEMBER_JOB_MS(2분)를 넘기면 다음 일로 넘어간다. GETMEM·MEMBER·INFOLINK 는 status 를 확인한다: 실패하면 로그 한 줄을 남기고 명부를 바꾸지 않으며, 읽지 못한 옾링은 '없음'이 아니라 모름(null)으로 두고 다음 동기화가 다시 읽는다. INFOLINK 가 속도 제한(-312·-805·-819)이면 그 읽기를 멈추고 BOT_RATE_WAIT_MS 첫 값 동안 옾링을 읽지 않는다. 동기화마다 숫자만 적힌 로그 한 줄(멤버 수·pli 있는 수·옾링 있는 수·걸린 시간). 명부는 (install_id, user_id) 행으로 저장하고 방(chat_id)이 바뀌면 그 방 것만 읽는다. 90일 못 본 사람·해제된 설치의 행은 부모의 하루 정리가 지운다.
- **옾링 값**: 주소 / `없음`(오픈프로필이 아님, 또는 INFOLINK 가 없다고 답함) / `확인 못 함`(오픈프로필인데 옾링을 읽지 못함). 입장·퇴장·프로필 변경 안내를 보내기 전에 명부에서 옾링을 모르는 사람은 INFOLINK 를 혼자 한 번(실패하면 한 번 더) 읽는다(동기화 한 번에 20명까지, 퇴장의 옾링만 읽기는 방마다 10초 간격 없이). 묶음 읽기에서 혼자서도 실패한 pli 는 '없음'으로 두지 않고 30분 동안 묶음 읽기에서 뺀다. 저장된 `link ''`(pli 있음)는 예전 읽기 실패일 수 있어 모름으로 읽어 다시 확인한다.
- **멤버 프로필 사진은 쓰지 않는다**: 입장·퇴장·프로필 변경 안내와 프로필 기록에 사진을 싣지 않는다. 저장된 설정·저장 요청의 `profile.photo` 는 오류 없이 버리고, `room_members.photo` 는 더 쓰지 않는다(열은 남겨 둔다). 예전 `changes` 의 `kind:'photo'` 는 화면·조회에 싣지 않는다.
- 입장·퇴장 안내: `[입장 안내]`|`[퇴장 안내]` / `이름 : @{닉네임}` / `옾링 : {링크|없음|확인 못 함}` / 입장(퇴장) 기록. 기록은 14일 안의 입장(퇴장) 시각이고, 머문 시간·예전 프로필은 기록(관리 화면)에만 남는다.
- 조회 명령 `{앞글자}프로필조회 @닉네임` / `옾링 주소` / `닉네임`(예전 `{앞글자}프로필` 도 같다, 7.2 (g)): 대상은 멘션 user_id → 옾링 주소(멤버 명부) → 닉네임(명부, 없으면 기록의 현재 이름) 유일 일치. 여러 명이면 `같은 이름을 쓰는 사람이 {n}명 있어요. @멘션으로 골라 주세요.` 명부에서 찾았는데 바뀐 적이 없는 사람(기록 행 없음)도 지금 이름 · `이전 이름 : 없음` · 입장·퇴장 횟수로 답한다(예전에는 `기록이 없어요` 라 헷갈렸다). 명부·기록 어디에도 없으면 `「{닉네임}」의 프로필 기록이 없어요.` 권한 `staff`(기본: 방장·부방장만 — 다른 사람에게는 `프로필 조회는 방장과 부방장만 할 수 있어요.`) / `all` / `off`(조용, 다음 처리로). 프로필 기록이 꺼져 있으면 방장·부방장에게 `프로필 기록이 꺼져 있어요. 「{앞글자}프로필기록 켜기」로 켤 수 있어요.` 답(멘션 없음):

```
[프로필 기록]
이름 : {현재}
이전 이름 : {A} (MM-DD HH:MM), …
최근 14일 : 입장 {n}회 · 퇴장 {n}회
```

- 화면의 `상태 메시지` 스위치는 숨기고 `오픈채팅 프로필에는 상태 메시지가 없어 감지하지 않습니다.` 를 보인다. `presentRoomConfig` 가 상수 `status_supported` 를 같이 내보내고 지금 값은 **`false`** 다(2026-10): 방 관리봇은 멤버 명부(GETMEM·MEMBER)의 닉네임·pli 만 비교하고 상태 메시지는 읽지 않으므로, 켜도 아무 일도 하지 않는 스위치였다. 저장된 `profile.status` 값은 그대로 둔다.

#### (d) 홍보 금지

- `promoCheck(state, cfg, ev)`: `cards` → 메시지 타입 {71, 17, 9}(후보 {4, 23, 24, 81, 82, 83, 98} 은 추적으로 확인 전까지 넣지 않음). `media` → {2, 27, 3, 18}. `links` → 본문 `LINK_RE`, 카드 타입이면 첨부 JSON 에도. 답장(26)의 인용 첨부는 보지 않는다. 방장·부방장·제외는 위반 아님.
- 순서: `hide` 면 그 글 가림(REWRITE) → `n = bump(state.promo[userId])`(`resetHours` 지나면 1부터) → `kickAt>0 && n>=kickAt` 이면 강퇴 → 안내. 같은 사람 안내는 10초에 1번.

```
[홍보 금지]
이름 : @{이름}
경고 : {n}회 ({kickAt}회가 되면 내보내요)
조치 : 경고 | 글 가리기 | 내보내기
{오전|오후 h:mm}
```

(`kickAt=0` 이거나 이미 내보냈으면 경고 줄은 `경고 : {n}회`. 분수 표기 `1/3회` 는 쓰지 않는다)

#### (e) 가리기

- 링 버퍼: 방 관리봇이 있는 방마다 최근 300개 글 `{logId, type, authorId, name, at}`(본문 없음, 메모리만, 5.7). 재시작 뒤 첫 가리기 요청 때 `getMessagePage` 로 최대 3쪽 채움.
- 방 안 명령(`hide.by` 가 허락한 사람, `hide.command` 켰을 때): `{앞글자}가리기 N`(1~300, 범위 밖이면 `「{앞글자}가리기 30」처럼 가릴 글 수(1~300)를 입력해 주세요. 한 사람의 글은 「{앞글자}가리기 @이름」으로 가릴 수 있어요.`) / `{앞글자}가리기 @닉네임`(그 사람의 버퍼 안 글 전부).
- 콘솔: 최근 N개 가리기, 사람별 가리기(`people` 에서 고름). 둘 다 인라인 2단계 확인.
- `hidePlan`: 방장·봇·피드·이미 가린 글·명령 글 제외, 부방장 글은 `hide.target: 'staff'` 일 때만(항목에 `sub`), 300개 상한. 부방장 글 가리기를 카카오가 거절해도 봇 권한 실패(연속 3회 멈춤)로 세지 않는다(권한만 다시 읽는다). 실행은 방별 작업 1개(진행 중이면 `busy`), 콘솔 작업은 방마다 끝난 뒤 10분 간격(`cooldown`), 300ms 간격, 방 300/30분·봇 600/10분(5.5). 방 안 명령도 같은 방 한도를 쓴다.
- 결과 안내: `[글 가리기]\n글 {n}개를 가렸어요.` + 실패가 있으면 `\n({m}개는 가리지 못했어요)`. `room_log 'hide'` 에 개수·실패·누가(`panel`/user_id).
- 금지어 상한 300(방 설정만. 계정 단위 옛 금지어는 200 그대로).

#### (f) 기록 카드(이미지) — 입장·퇴장·프로필 변경 안내

- `visit.style`·`profile.style` 이 `image`(기본)이면 `[입장 안내]`·`[퇴장 안내]`·`[프로필 변경 감지]` 를 그림 한 장(PNG, 논리 폭 720을 2배인 1440px 로 그려 휴대폰에서도 또렷하게)으로 보낸다. 모양: K bot 사이트와 같은 결 — 거의 검정 바탕 `#09090B`(투명 없음 — 카카오톡이 JPEG 로 바꿔도 같게) · 상자 면 `#0E0E11` · 가는 선 `#1F1F23`/`#2A2A2F`/`#3A3A40` · 흰 글 `#EDEDEF`(흐린 글 `#A1A1AA`/`#8B8B94`/`#71717A`). 종류마다 강조색 한 가지(입장 `#5FB878` · 퇴장 `#EF6A60` · 프로필 변경 `#A78BFA`)를 머리의 테두리 배지(점 + 제목 `입장 안내`·`퇴장 안내`·`프로필 변경 감지`)와 궤도의 점에만 쓰고 나머지는 흑백. 오른쪽 위에 낮은 대비의 궤도 그림, 그 가운데에 K bot 로고(`public/logo.svg` 의 흰 K, 네모 바탕 없이 — 궤도 선은 모두 K 뒤로 지나가 로고가 잘리지 않는다). 강조색 점은 입장 = 바깥에서 감겨 들어와 궤도에 올라탐, 퇴장 = 궤도를 벗어나 멀어짐, 프로필 변경 = 궤도 위에서 자리를 옮김. 이름 칸 뒤에는 궤도를 지워 글이 늘 깨끗한 바탕 위에 놓인다. 그 아래: 동그라미(이름 첫 글자 — 꾸밈 기호는 건너뛰고 첫 한글 → 영문·숫자 → 다른 글자, 이름이 없으면 사람 모양) + 큰 닉네임(길면 글자를 조금 줄이고 그래도 길면 …) + 설명 줄(`첫 방문` / `{n}번째 입장`·`{n}번째 퇴장` / 바뀐 칸 `… 변경`, 닉네임이 바뀌면 `변경전` + 옛 닉네임) · 숫자 줄(가는 세로선으로 나눈 `날짜` · `입장 시각`/`퇴장 시각`/`변경 시각` · `입장 기록`/`퇴장 기록`/`변경 기록` 횟수) · 칸 표(`옾링` 주소 / `없음` / `확인 못 함`, 프로필 변경은 `옾링 변경전/후`·`상태 메시지 변경전/후` — 변경전 값은 흐리게, 긴 값은 두 줄) · 최근 기록(두 번 이상일 때 최근 시각 최대 5개를 세로선 위에, 마지막이 이번 — 굵게 + `이번` 표, 기록이 더 많으면 `{n}회 중 최근 {m}회`) · 바닥(가는 선 · 말풍선 + 방 이름 · 회색 K 로고 + `K bot` — 밝은 K 는 위 그림 하나뿐). 모서리는 각지게(카카오톡이 깎는다). 내용은 글 안내와 **같다**: 제목 · 닉네임 · 옾링 · 기록(횟수 + 최근 시각) · 이번 시각 · 방 이름.
- 값은 `roomfeat.visitNoticeText`·`profileChangeNotice` 가 글과 함께 만드는 `card`(`{kind, title, name, before, fields:[{label, value}], record:{label, count, times}, at}`)이고, 그림은 `sender/src/logcard.mjs`(`logCardSvg` → `card.mjs svgToPng`)가 그린다.
- **멘션 · 옾링 글**: 그림에는 멘션도 누를 수 있는 링크도 넣을 수 없다. 그림 바로 뒤에 글 `[입장 안내]` / `이름 : @{닉네임}` / `옾링 : {링크|없음|확인 못 함}`(프로필 변경은 `변경전 : ＠{옛 닉네임}` / `변경후 : @{닉네임}` / 옾링 칸들, `roomfeat.cardMentionLine`, 멘션 @ 하나)을 보내 그 사람을 부르고 옾링을 글로 남긴다. id 를 모르면 같은 글을 멘션 없이. 기록(횟수·시각)은 그림에만. 까닭: 안내의 목적(그 사람에게 알림 · 방 사람들이 눌러 프로필을 봄)을 지키면서 긴 글 대신 읽기 쉬운 그림을 보이고, 채팅 목록·알림 미리보기에도 무슨 안내인지 한 줄로 보인다. id 를 모르면(이름만 아는 입장) 그림만 보낸다.
- 그림 + 한 줄은 발송 대기 목록의 한 항목이지만 방·봇 발송 한도(5.5)는 **2개**로 센다(`Pacer` 의 `cost`). 그림이 나간 뒤에만 한 줄을 보낸다.
- **글로 대신**: 렌더러를 못 불러오거나 그림을 못 만들면(`png null`) 또는 사진 보내기가 실패하면 지금의 글 안내 **하나**(멘션 포함)를 보낸다(한 줄은 보내지 않는다 — 두 번 부르지 않게). `style: 'text'` 면 처음부터 글 안내.
- 패널 미리 보기 그림 `public/img/logcard-join.png`·`logcard-profile.png` 는 `node sender/src/logcard-sample.mjs` 가 만든다(카드 모양이나 안내 내용을 바꾸면 다시 만들어 함께 올린다). 체험(3.7)은 같은 SVG 를 `img`(data: 주소)로 보낸다.

#### (g) 방 관리 명령어 (`sender/src/roomcmd.mjs`)

순수 함수(`parseRoomCommand`·`findPerson`·`configChange`·답 문구)는 `roomcmd.mjs`, 실행(권한 읽기·내보내기·저장)은 `botpool.roomCommand`, 체험은 `lib/demo.js roomCommand` 가 같은 함수를 부른다. 방 관리 기능이 동작할 때(`roombotLive`)만 답한다. 부방장 지정 대기 방에서 방장·부방장이 쓰면 `방 관리 명령어는 K bot이 부방장이 된 뒤에 쓸 수 있어요. 방장님이 「{봇 이름}」을 부방장으로 지정해 주세요.`, 다른 사람에게는 조용하다. 답한 명령어 글은 게임으로 넘기지 않는다. 방장·부방장이 아닌 사람의 명령어 글도 홍보 금지·금지어 검사를 그대로 받는다(명령어 뒤에 링크를 숨겨 올리지 못하게).

| 명령어 | 누가 | 하는 일 · 답 |
|---|---|---|
| `{앞글자}옾링 [@멘션 \| 옾링 주소 \| 닉네임]` | `cmd.link`(기본 방장·부방장) | `[옾링]\n이름 : {닉네임}\n옾링 : {주소\|없음\|확인 못 함}`. 멘션이면 카드(MEMBER)를 다시 읽어 지금 옾링. 방에 없는 사람을 멘션으로 고르면 `그 사람은 지금 이 방에 없어요.` `off` 면 조용(다음 처리로) |
| `{앞글자}프로필조회 [@멘션 \| 옾링 주소 \| 닉네임]` (`{앞글자}프로필` 도 같다) | `profile.lookup` | 7.2 (c) |
| `{앞글자}내보내기 [@멘션 \| 옾링 주소]` | 방장·부방장 | 닉네임만으로는 고르지 않는다(다른 사람을 내보내지 않게 — 사용법 답). 카드로 방에 있는지·권한을 읽고, 방장·부방장·제외 대상·K bot 이면 `방장·부방장·제외 대상은 내보낼 수 없어요.` 그 밖은 `kick(…, 'command', by)` — 한도·연속 실패 멈춤·올킥 감지 멈춤·기록(`kick` `why:'command'`, `by`)이 그대로 걸린다. 답: `{닉네임}님을 내보냈어요.` / `올킥 감지로 K bot의 내보내기가 멈춰 있어요. {n}분쯤 뒤에 다시 입력해 주세요.` / `내보내기가 여러 번 실패해 잠시 멈춰 있어요. …` / `K bot이 짧은 시간에 내보낼 수 있는 인원을 넘었어요. …` / `{닉네임}님을 내보내지 못했어요. 잠시 뒤 다시 입력해 주세요.` |
| `{앞글자}차단해제 [@멘션 \| 옾링 주소 \| 닉네임]` | 방장·부방장 | 패널의 `내보내기 해제`(3.4.3 `unkick`)와 같다: K bot 이 내보낸 사람이면 `KLDELITEM`, 재입장 차단 목록(`bans`)에서 지움. 나간 사람은 멘션할 수 없어 닉네임(명부 + `bans` 의 이름)으로도 고른다. `{닉네임}님의 내보내기·재입장 차단을 풀었어요. 다시 들어올 수 있어요.` / `K bot이 내보내거나 차단한 사람이 아니에요.` |
| `{앞글자}설정` | 방장·부방장 | `[설정]` + 기능별 `입장·퇴장 기록 : 켜짐` … `금지어 검열 : 꺼짐 (금지어 n개)` … + `「{앞글자}입장기록 켜기」처럼 켜고 끌 수 있어요.` |
| `{앞글자}입장기록` · `들낙감지` · `재입장차단` · `프로필기록` · `홍보금지` · `금지어`(=`금지어검열`) · `올킥감지` + `켜기`\|`끄기` | 방장·부방장 | 그 절의 `enabled` 를 바꿔 **패널과 같은 방 설정**(`room_installs.config`)에 저장(2.2 예외, `config_rev+1` → 패널은 다음 새로고침에 그 값을 읽는다). `{기능}을 켰어요.` / `{기능}은 이미 켜져 있어요.` / 뒤가 없으면 사용법 + 지금 상태. 저장이 안 되면 `설정을 저장하지 못했어요. 잠시 뒤 다시 입력해 주세요.` `room_log 'config'`(`detail.text`, `by:'room'`) |
| `{앞글자}금지어 추가 단어[, 단어]` · `삭제 단어` · `목록` | 방장·부방장 | 7.1 과 같은 규칙(30자 · 300개 · 대소문자 무시 중복). 답에 금지어를 다시 쓰지 않는다(`금지어 2개를 추가했어요. 지금 n개예요.`, 검열이 꺼져 있으면 켜는 법 한 줄). `목록` 은 방장·부방장이 요청했을 때만 `[금지어]\n{단어, …}`(50개까지 + `외 n개`) |
| `{앞글자}도움 관리` | 누구나 | `[방 관리 명령어]` + 위 명령어와 하는 일(켜진 것만: 옾링·프로필조회·가리기) |

- 사람 고르기(`findPerson`): 멘션 → 옾링 주소(`open.kakao.com/o/{코드}`, https·끝 `/`·`?` 뒤는 봐주고 코드는 대소문자 구분) → 닉네임(허용한 명령어만, 앞의 `@` 는 뗀다). 명부 = 멤버 명부(`v.members`) + (차단해제만) `bans`. 같은 닉네임이 여럿이면 지난 동기화 뒤에 본 사람이 하나일 때 그 사람, 아니면 `같은 이름을 쓰는 사람이 {n}명 있어요. @멘션으로 골라 주세요.` 못 찾으면 `「{닉네임}」을 이 방에서 찾지 못했어요.` / `그 옾링을 쓰는 사람을 이 방에서 찾지 못했어요.`
- 옾링·닉네임으로 찾기 전 명부를 30분 넘게 읽지 않았으면(입장·퇴장 기록·프로필 기록이 꺼진 방) GETMEM 동기화를 한 번 한다(최대 8초).
- `{앞글자}도움` 의 `방 관리 :` 줄: `옾링`(cmd.link 가 off 아님) · `프로필조회`(프로필 기록 켬 + 조회 off 아님) · `가리기`(hide.command) · `내보내기` · `설정`, 그리고 `「{앞글자}도움 관리」를 입력하면 방 관리 명령어 설명을 볼 수 있어요.`

#### 올킥 방지·입장·퇴장 로그·금지어 검열 (기존 기능을 봇 위에서)

- 지금 `guardOnChat`·`guardDue`·`applyVisit`·`coverPlan` 을 방 어댑터 기록으로 그대로 쓴다.
- `isKickFeed` 는 JSON 피드 6 도 센다. 봇 자신의 강퇴(`ownKicks`, 60초)는 올킥 계산에서 뺀다.
- 입장·퇴장 안내 문구에 `강퇴` 를 넣지 않는다(selfcheck 단언 유지). 내보내기 문구는 새 안내에만.

### 7.3 미니게임 (방별)

- `entry.games` 와 `cmdPrefix` 를 읽는다. `cooldownSec × 1000` → 기존 `cooldownMs`. 하루 횟수·쿨타임은 방 어댑터의 `runtime` 에 있으므로 방마다 따로다.
- 점수는 `authorId` 로 저장하고 `{id: name}` 표로 이름을 보인다(이름 빈 사람 둘이 섞이지 않게).
- `{앞글자}도움` 은 `sender/src/helpcard.mjs` 모양으로 답한다(`roomfeat.helpLine`): `《 K bot 명령어 》` · `━` 줄 · `◆ 미니게임`(켜진 게임) · `◆ 검 강화`(켜졌을 때, 7.3.1) · `◆ 방 관리`(7.2 (g)) 묶음마다 ` ▸ ` 줄(명령어를 ` · `로 잇고 폭 16을 넘으면 다음 줄), 묶음 사이 빈 줄, 방 관리가 있으면 `━` 줄과 `「!도움 관리」를 입력하면 …` 안내. `!도움 관리`(`《 방 관리 명령어 》`)·`!강화도움`(`《 검 강화 도움말 》`)·`!게임` 도 같은 모양. 패널 미리 보기와 `/buy` 의 `!도움` 말풍선(`data-real="help"`, 두 게임·방 관리 모두 켜진 기본값)도 같은 모양.
- 미니게임만 있는 방에서는 입장·퇴장·홍보·가리기가 조용하다.

#### 7.3.1 추억의 검 강화 (`sender/src/sword.mjs` 규칙 · `sword-art.mjs` 그림)

- 켜기: `games.sword`(기본 켜짐). 방 설치형 봇(`byId`)에서만 — 계정 단위 옛 기능에는 없다. 꺼진 방에서 `!강화`·`!강화도움` → `이 방에서는 검 강화가 꺼져 있어요.`, 다른 검 강화 명령어는 조용하다.
- `{앞글자}도움` 에 `◆ 검 강화` 묶음(`◆ 미니게임` 다음, `◆ 방 관리` 앞). `!게임` 목록과 패널 미리 보기도 같다.
- 명령어: `!강화 [보호] [축복]`(별칭 `검강화`) · `!내검`(`검`·`검정보`) · `!사냥` · `!판매 [확인]` / `!판매 아이템 [수량]` · `!상점` · `!구매 아이템 [수량]` · `!인벤`(`인벤토리`) · `!거래 @상대 아이템|검 [수량] [가격]` → 받은 사람 `!수락` / `!거절`, 보낸 사람 `!거래취소` · `!강화랭킹`(`검랭킹`) · `!출석`(`출첵`) · `!결투 @상대 [골드]` → 받은 사람 `!수락` / `!거절` · `!보스` · `!공격` · `!강화도움`.
- 재미 장치(sword.mjs): 실패 보정 — 강화가 실패(보호로 지킨 것 포함)할 때마다 다음 성공 +2%(최대 +10%), 성공·파괴·판매·거래로 검이 바뀌면 0으로. 방 최고 기록 — +10 이상에서 이 방에서 처음 나온 단계면 글에 `[방 최고 기록]` 줄, 카드 왼쪽 위에 리본. 위로금 — +10 이상 검이 부서지면 판매가의 10%. 출석 — KST 하루 한 번 300G + 연속 일수(7일까지)×100G, 7일마다 보호·축복 주문서 1개씩, 하루 건너뛰면 1일부터. 결투 — 신청할 때 두 사람의 검(번호·단계)을 적어 두고, `!수락` 때 어느 쪽이든 검이 바뀌었으면 `{이름}님의 검이 바뀌어서 결투를 취소했어요.` 로 취소한다. 멘션한 닉네임 끝의 숫자는 내기로 읽지 않는다(멘션 글자 수·저장된 이름으로 가른다). 신청한 사람 승률 50% + 단계 차이×4%(10~90%), 내기 골드(최대 1,000,000G)는 진 사람에게서 이긴 사람에게로만 옮긴다, 신청은 30초에 한 번, 2분 안에 수락·거절(거래 제안과 같은 줄). 방 보스 — `!보스`·`!공격` 이 보스를 부른다(쓰러뜨린 뒤 30분 동안은 없음), 공격은 1분에 한 번, 피해 = (60 + 단계×40 + 단계²×8) × 0.8~1.2(치명타 10% ×2), 한 번에 보스 최대 체력의 25%까지(`BOSS_HIT_MAX`, 치명타 포함 — 높은 단계 혼자서도 적어도 네 번이라 나타나는 글에서 바로 쓰러뜨리지 못하고 방 사람들이 함께 칠 틈이 있다), 쓰러뜨리면 체력×0.15 골드를 피해량대로(피해 1마다 0.15G, 1인 최소 100G, 최소액 때문에 합이 보상을 넘으면 모두 같은 비율로 줄인다), 마지막 일격에 앞의 네 보스는 마력석 2개·축복 주문서 1개, `심연의 마왕` 은 용의 비늘·보호 주문서 1개씩(`bossLastReward`, 별빛 결정은 보스에서 나오지 않는다), 가장 큰 피해에 축복 주문서 2개. 보스 다섯(4,000~50,000)을 돌고 바퀴가 돌수록 체력이 늘어난다. 난이도(`bl`)는 쓰러뜨린 수(`bk`)와 따로 센다 — 쓰러뜨리면 +1, 하루 안에 못 쓰러뜨려 도망가면 한 단계 쉬운 보스로 내려가고, 다음 보스는 도망간 때부터 30분 뒤에 나온다.
- 상태: `room_state.runtime.sword.r = {v, u:{사람 열쇠: {n 이름, g 골드, lv 검 단계, id 검 번호, b 최고 단계, it 아이템(guard·bless·mana·scale·star), a 마지막 활동, e 강화 시각, h 사냥 시각, w 쿨타임 안내(쿨타임마다 따로: e·h·du·r), k 부서진 수, s 판 수}}, t:[거래 제안], q 다음 번호}`. 사람 열쇠는 점수와 같다(`authorId`, 없으면 `n:이름`). 200명까지 — 넘으면 가장 오래 안 한 사람부터, 180일 안 한 사람은 새 사람이 올 때 지운다(거래 중인 사람은 남김). 아이템은 종류마다 999개, 골드 999,999,999. 랭킹 초기화(`games-reset`)는 검 강화 기록도 지운다(7.3.3).
- 강화: 처음 2,700G 와 `+0 녹슨 철검`. 단계 0~30, 이름은 단계마다 하나(`NAMES` 31개, 7자까지, 모두 `검` 으로 끝남). 그림·사냥터는 묶음(`FAMILIES` 14개, `{from, art}`)마다 같다: +0 `녹슨 철검` · +3 `강철 장검` · +6 `은빛 기사검` · +9 `푸른 서리검` · +12 `붉은 화염검` · +15 `황금 용검` · +18 `칠흑의 마검` · +20 `추억의 전설검` · +21 `천둥 폭풍검` · +23 `심해의 조류검` · +25 `성운의 은하검` · +27 `혼돈의 일식검` · +29 `천상의 태엽검` · +30 `태초의 창세검`(묶음 첫 단계의 이름이 묶음 이름, 예전 이름은 그 단계에 그대로). 표(`TABLES`, 얼려 둠)는 단계마다: 성공 85%(+0)에서 3%(+29)까지 줄고 파괴는 +5부터 4%에서 27%까지 늘어난다 — 파괴되면 새 +0 검, 실패는 단계 그대로. 비용 60G~8,700G(어느 단계든 사냥 한 번쯤). 재료는 성공·실패와 상관없이 강화할 때마다: +10~+14 마력석 1·2·3·3·4개, +15~+19 용의 비늘 2·2·3·3·3개, +20~+29 별빛 결정 1·1·2·2·2·3·4·5·6·7개. `보호` 는 파괴를 한 번 막고(+5부터만 받음) 한 번에 보호 주문서를 `GUARD_K` 장 쓴다 — +5~+14 1장, +15~+19 비늘 수만큼(2~3장), +20부터 별빛 결정 1개마다 5장(5~35장). `축복` 은 성공 +10%p, 1장. 쓴 주문서는 결과와 상관없이 사라진다(축복 없이도 성공 100%면 축복은 쓰지 않지만, 지금 표에는 그런 단계가 없다). 골드·재료·보호 주문서 수를 모두 본 뒤에야 아무것이든 쓴다. 모자란 것은 한 번에 모두 알린다 — 둘 이상이면 `+{lv}[ 보호] 강화에는 {아이템} {더 필요한 수}개 · …이/가 더 필요해요.` / `모두 사서 강화하려면 {강화 골드 + 상점가 합}G가 들어요. (보유 {골드}G)` / `「!사냥」으로 모으거나 「!구매 {짧은 이름} {수}」 · …(으)로 살 수 있어요.`(재료 → 보호 → 축복 순서, 골드만 모자란 것은 상점가 합 줄로 보인다), 하나만 모자라면 예전처럼 `+{lv} 강화에는 {재료}이/가 {n}개 필요해요. (보유 {m}개) 「!사냥」으로 모으거나 「!구매 {마력석|비늘|결정} {n-m}」(으)로 살 수 있어요.` · `+{lv}에서 보호하려면 보호 주문서가 {k}개 필요해요. (보유 {m}개) 「!구매 보호 {k-m}」(으)로 살 수 있어요.` 사용 줄과 카드 칩은 수를 보인다(`보호 주문서 5개`). +15부터 `!강화`·`!내검` 은 다음 강화 줄 아래 `보호하려면 보호 주문서가 {k}개 필요해요.` 를 붙이고, `!강화도움` 끝에 `높은 단계일수록 재료와 보호 주문서를 여러 개 써요.` `!강화` 뒤에 모르는 낱말이 있으면 아무것도 쓰지 않고 바른 입력을 알려 준다(`보호 주문서`·`파괴 방지`처럼 띄어 써도 된다). 한 사람 10초에 한 번.
- 사냥: 2분에 한 번. 사냥터 = 검의 묶음(14곳, 몬스터 이름은 모두 이 게임에서 지은 것). 몬스터 하나를 고르고 골드는 그 몬스터 범위 안에서(사냥터 0 의 50~120G 에서 사냥터 13 의 6,400~8,900G까지), 2% 보물 상자(5배). 아이템은 차례대로 따로 굴린다: 마력석 12% · 축복 6% · 보호 2% · 용의 비늘 1%(+10부터 4%) · 별빛 결정 +15~+19 0.2%, +20부터 0.7%.
- 판매: 검은 단계별 판매가(+9~+20 은 예전 그대로, +20 250,000G · +30 4,000,000G), +10부터 `!판매 확인` 을 받는다. 판매가는 어느 단계든 그 검을 만드는 가장 싼 기대 비용(아이템을 되팔 값으로 쳐도)의 75% 아래다(sword-check 가 정확히 계산해 본다). 아이템은 상점가의 일부(보호 1,000G · 축복 500G · 마력석 800G · 비늘 3,000G · 결정 30,000G). 상점: 보호 20,000G · 축복 2,000G · 마력석 2,500G · 용의 비늘 50,000G · 별빛 결정 300,000G(별칭 `별빛결정`·`별빛`·`결정`). 한 번에 1~99개, 종류마다 999개까지.
- 예전 저장본(+0~+20, 아이템 네 가지)은 옮기지 않고 그대로 쓴다: 단계·최고 단계는 0~30 안에 그대로, 골드·아이템도 그대로(`star` 는 처음부터 아는 아이템). 예전 +20 은 별빛 결정으로 이어서 강화한다.
- 거래: 받는 사람은 이 방에서 검 강화를 한 번 한 사람(멘션이 있으면 아이디로, 없으면 같은 이름이 한 명일 때). 끝의 수 2개 = 수량·가격, 1개 = 가격, 없으면 무료. 제안은 2분 동안, 보낸 사람마다 1개(새 제안은 앞 제안을 바꾼다), 받는 사람마다 1개. `!수락` 때 판 사람의 물건(검은 같은 검 번호·단계)과 산 사람의 골드를 다시 보고 한 번에 옮긴다 — 물건이 모자라거나 검이 바뀌었으면 취소, 산 사람 골드가 모자라거나(검이면) 이미 +1 이상 검이 있으면 제안은 남는다. 받은 제안이 없으면 7.3.3(`받은 신청이 없어요.`).
- 보내기: 하루 최대 응답 수는 방 단위, 3초 쿨타임은 검 강화만 사람 단위다. 방의 보내기 대기(Pacer backlog)가 3 이상이거나 답을 보낼 수 없을 때는 `Sword.run` 전에 조용히 거절한다 — 검 강화 상태를 바꾸지 않는다(결과가 안 보인 채 검이 부서지지 않게). 개인 쿨타임 중이면 한 번만 `{이름}님, 강화는 N초 뒤에 다시 할 수 있어요.` 하고 그다음은 조용하다.
- 그림: 강화 결과 · `!내검` · `!강화랭킹` 은 카드 PNG(720px, card.mjs) 한 장으로 보낸다. 같은 글(`[강화 성공]` · `[내 검]` · `[강화 랭킹]` …)을 대체 글로 붙여, 사진을 못 보내면 글이 나간다. 검 그림은 묶음 14개마다 그려 둔 그림(`sender/assets/swords/tier0~13.png`, 둘레 투명, `FAMILIES[].art`)을 세워 붙이고, 파괴는 같은 그림을 잿빛 두 동강으로 보여 준다. 랭킹 줄에도 같은 그림이 작게 들어간다(이름 칸은 검 이름 길이만큼 줄인다). 그림 파일이 없으면 묶음마다 색을 정한 벡터 검으로 대신한다(`loadArt` 는 없는 파일을 null 로). 카드의 다음 강화 칸은 재료 수까지(`4,300G + 결정 1`), +15부터 확률 막대 아래에 `보호하려면 보호 주문서 {k}개`, `!내검` 카드의 아이템은 주문서 두 칸 + 재료 세 칸. 진열장(검·빛)은 단계마다 한 번 그려 둔다. 체험(`lib/demo.js`)은 `images:false` 로 글만 쓴다.

#### 7.3.3 검 강화 공통 규칙

- `수락` · `거절`: 받은 검 강화 거래 제안·결투 신청에 답한다(`features.answerOffer`). 받은 것이 없으면 `받은 신청이 없어요.`, 검 강화가 꺼져 있으면 조용하다.
- 명령어 이름이 겹치지 않는다: 검 강화 `강화 검강화 내검 검 검정보 사냥 판매 상점 구매 인벤 인벤토리 거래 거래취소 강화랭킹 검랭킹 강화도움 출석 출첵 결투 보스 공격` · 방 관리 명령어(7.2 (g))와 기존 미니게임 명령어와도 다르다(selfcheck 가 맞춰 본다).
- 그림 카드: 답 항목의 `image` 는 처음 읽을 때 한 번 그린다(`pushSend` 에 그리는 함수를 넘긴다). 체험(`images:false`)은 그리지 않는다.
- 패널 `랭킹 초기화`(`games-reset`)는 점수와 함께 그 방의 검 강화(`runtime.sword`) 기록도 지운다(없앤 몬스터 수집의 예전 기록 `runtime.mon` 도 지운다).

### 7.4 콘솔 칸 (작업 5, id 고정)

| 화면 | 칸 |
|---|---|
| `r-visit` | `#r-visit-on`(입장·퇴장 로그) · 들낙 감지 `#r-churn-on` `#r-churn-joins`(.num 2~20 회) `#r-churn-min`(.num 1~1,440 분) `#r-churn-action`(.seg `경고만`=warn / `내보내기`=kick) `#r-churn-notice` + 문장 미리 보기 `#r-churn-sent` `<b>10분</b> 안에 <b>3회</b> 이상 들어오면 경고합니다.` · 나갔을 때 내보내기 `#r-leave-on`(설명: `방에서 나간 사람을 내보내기 목록에 올려 다시 들어오지 못하게 합니다. 카카오가 나간 사람의 내보내기를 허용하지 않으면, 30일 안에 다시 들어오는 즉시 내보냅니다.` — 10.1 #5 실측 뒤 한쪽 문장만 남긴다) `#r-leave-notice` · 제외할 사람 `#r-exempt`(.chips) + `#r-exempt-pick`(최근 작성자 select) · 방에 보내는 안내 `#r-visit-style`(.seg `이미지`=image / `글`=text, 미리 보기는 `public/img/logcard-join.png` + 멘션 한 줄 / 글 안내) · 표 `#r-visit-tbl`(기록), `#r-kick-tbl`(K bot 이 내보낸 사람, 행마다 `내보내기 해제`. 방의 `!내보내기`·`!차단해제` 도 여기에 걸린다) |
| `r-profile` | `#r-profile-on` `#r-profile-name` `#r-profile-status`(`status_supported:false` 라 숨김) `#r-profile-lookup`(.seg `방장·부방장만`=staff / `모두`=all / `끄기`=off, `!프로필조회`) `#r-profile-style`(.seg `이미지`/`글`) · 오픈프로필 조회 명령어 `#r-cmd-link`(.seg 같은 세 값, `!옾링`, 프로필 기록과 따로) · 표 `#r-profile-tbl`(열 `항목` 추가) |
| `r-promo` | `#r-promo-on` `#r-promo-links` `#r-promo-cards`(`공유 카드·프로필 공유`) `#r-promo-media`(`사진·동영상·파일`) `#r-promo-hide` `#r-promo-kick`(.num 0~10, hint `0이면 내보내지 않습니다`) `#r-promo-reset`(.num 1~720 시간) `#r-promo-notice` · 미리 보기 `#r-promo-preview`(.preview-chat) |
| `r-cover` | 금지어 `#r-cover-on` `#r-cover-links` `#r-cover-words`(.chips) `#r-cover-word-in` `#r-cover-word-n`(`n / 300`) `#r-cover-word-err` · 가리기 `#r-hide-cmd` `#r-hide-by`(.seg `방장·부방장`=staff / `방장만`=host) `#r-hide-target`(.seg `일반 멤버 글`=members / `부방장 글까지`=staff) `#r-hide-last`(.num 1~300) `#r-hide-last-btn` `#r-hide-who`(select) `#r-hide-who-btn` `#r-hide-status` |
| `r-guard` | `#r-guard-on` `#r-guard-secs` `#r-guard-count` `#r-guard-sent` · 표 `#r-guard-tbl` |
| `r-games` | `#r-games-on` `#r-games-word` `#r-games-baseball` `#r-games-dice` `#r-games-rps` `#r-games-quiz` `#r-games-sword`(추억의 검 강화) `#r-games-cool`(.num 1~60 초) `#r-games-limit`(.num 0~5,000 회, hint `0이면 제한 없음`) · 랭킹 `#r-rank-tbl`(상위 10) + `#r-rank-reset`(인라인 확인) · 미리 보기 `#r-games-preview` |
| `room` | `#r-prefix` · `#row-r-cmds`(방 관리봇이 있으면: 방에서 `!설정`·`!입장기록 켜기`·`!도움 관리` 안내) `#r-passcode` `#room-retry` `#room-state` `#room-steps` `#room-wait` `#room-err` `#r-log-tbl` · 옮기기·다시 설치 `#room-move-grp` `#r-reinstall-act` `#r-reinstall-btn` `#r-reinstall-note` `#r-move-form` `#r-move-link` `#r-move-check` `#r-move-note` `#r-move-pv` `#r-move-q` `#r-move-passcode` `#r-move-yes` `#r-move-no` `#r-move-err` `#r-move-rule` `#room-move-go` |

화면 문구 규칙: 강퇴 대신 `내보내기`, `들낙 방지` 금지(`들낙 감지`), `쿨다운`→`쿨타임`, `접두사`→`앞글자`, `1일`→`하루`. 내보내기 관련 화면에는 `.limit` `내보내기는 K bot 계정이 부방장일 때만 동작합니다. 방장·부방장·제외할 사람은 내보내지 않습니다.`

### 7.5 기록 화면 데이터

- `visit`·`profile`·`guard` 표: sender `/v1/bot/logs`(지금 `renderVisit`·`renderProfileLog`·`renderGuardList` 가 그리는 모양 그대로 + profile 행의 `changes[].kind`).
- `actions`(조치 기록): DB `room_log`. 콘솔 폴링 10초, 화면이 보일 때만.

### 7.6 방 어댑터 기록 (작업 3, `roomfeat.mjs` `adapterRecord(view)`)

```js
{ device_id: botId,
  config: {
    visit:   { enabled: cfg.visit.enabled, rooms: ['r'] },
    profile: { enabled: cfg.profile.enabled, rooms: ['r'] },
    cover:   { enabled: cfg.cover.enabled, rooms: ['r'], words: cfg.cover.words, links: cfg.cover.links && !(cfg.promo.enabled && cfg.promo.links) },
    guard:   { kickOn: cfg.guard.enabled, rooms: ['r'], kickSecs: cfg.guard.secs, kickCount: cfg.guard.count },
    minigame:{ enabled: cfg.games.enabled, rooms: ['r'], cmdPrefix: cfg.cmdPrefix, word, baseball, dice, rps, quiz, sword,
               cooldownMs: cfg.games.cooldownSec * 1000, dailyLimit: cfg.games.dailyLimit },
  },
  rooms: [{ key: 'r', chat_id, name: link_name, kind: 'open', list_kind: 'open_room' }],
  runtime: roomState.runtime,                     // 이 방 전용
  features: { macro: false, roombot: false, minigame: products.minigame } }
```

- 방 관리 절은 `roombotLive` 가 아니면 어댑터에서 `enabled:false` 로 만든다(한 곳에서 게이트).
- `renderBot` 의 `{방}` 은 `room.name` 을 쓴다(키 `r` 가 보이지 않게).
- 기존 `config.roombot`(옛 앱 방봇: 환영·경고·링크·도배 명령)은 봇 방에서 쓰지 않는다.

### 7.7 selfcheck 추가 사례 (작업 3, `sender/src/selfcheck.mjs`)

1. 같은 id 의 입장·퇴장 5번(logId 1~5, 0·5·10·15·20초) → 입장 3·퇴장 2 기록(60초 중복 회귀).
2. 같은 logId 재생 → 무시. logId 없이 500ms 안 2번 → 1번, 10초 간격 → 2번.
3. N=3, M=10: 세 번째 입장에서 멘션 1개 안내, 같은 창의 네 번째는 없음. `kick` → 강퇴 동작 1개. 제외·방장 → 없음. 이름만 → 경고만.
4. 시각은 `ev.at` 기준(뒤늦게 채운 묶음이 하나로 뭉치지 않음).
5. id 있는 퇴장 → 강퇴 동작. id 없음 → `kick_fail`. 제외 → 없음. 실패 → `bans` 등록, 그 id 재입장 → 강퇴. 피드 6 → 없음. #29(`FAKE_KICK_LEFT=0`): 나간 3명의 내보내기 거절 → 멈추지 않음(권한은 매번 다시 읽음), 방 안 사람의 실패 3번 → 10분 멈춤, 멈춤·한도·올킥 감지로 건너뛴 나간 사람 → `bans` + `kick_fail`, 방 관리봇 꺼짐 → 없음, 해제 → `KLDELITEM` 없이 `bans` 만, 적어 둔 뒤 제외 대상이 됨·재입장 차단 끔 → 다시 들어와도 강퇴 없음(`bans` 는 남김), 나간 3명의 `-805` → 10분 멈춤.
6. 사진만 바뀜 → 안내·기록 없음. 상태 null → 없음. 첫 관찰 → 없음. 연달아 바꿔도 매번 안내. #28: 봇보다 먼저 있던 사람이 나가도 퇴장 안내에 옾링, 메시지 닉네임 변경 안내. #28-2: 다른 오픈프로필로 바꿈 = ▸ 옾링 전·후, 패널 기록 kind link.
7. 조회: 방장 → 기록 문구, `staff` 에서 일반 → 없음, 멘션 id 우선, 동명이인 → 같은 이름 문구.
8. 홍보: 71 위반, 26(인용에만 링크) 아님, 1+`https://` 위반, 2 는 `media` 켰을 때만. 방장·제외 아님. 1/3·2/3 가림, 3/3 강퇴. `resetHours` 뒤 1부터.
9. 홍보 링크 켬 → 금지어 검열은 링크를 놔두고 욕설은 가림.
10. 링 350개 → 최근 300. `!가리기 5` → 방장 아닌 최근 5개(명령 글 제외). 멘션 첨부 → 그 사람. 999 → 300, 0·글자 → 사용법 답, 일반 사용자 → 거절.
11. 금지어 300개 통과·301번째 거절, 300개로 일치 동작.
12. `locoOk({statusCode:0, body:{status:-203}}) === false`.
13. 미니게임: 방 A 하루 한도가 방 B 를 막지 않음. 끈 게임 → 사용 중지 문구. 이름 빈 두 사람 점수 분리. 미니게임만 있는 방 → `!주사위` 답, 입장 안내·홍보·가리기 조용.
13-1. 추억의 검 강화(`sender/src/sword-check.mjs`, 따로 실행): 확률 표(성공은 줄고 파괴는 +5부터), 고정 난수로 성공·파괴·실패 경계와 보호·축복 주문서, 씨앗 난수 2만 번으로 확률이 표대로(±1.2%p), 골드·재료 부족 → 아무것도 바뀌지 않음(여럿이 모자라면 한 번에 모두와 모두 사서 강화하는 골드, 알려 준 대로 사면 강화됨), 개인 쿨타임(한 번만 안내), 사냥 드롭, 판매 확인, 상점 한도, 거래(읽기 · 옮긴 뒤 합계가 같음 · 두 번 수락 없음 · 제안 뒤 물건이 바뀌면 취소 · 만료 · 멘션 · 같은 이름 둘), 검 거래(검 번호가 하나뿐), 아무렇게나 3,000번(음수·한도 초과·검 복제 없음), 200명 정원·180일 정리·JSON 저장·망가진 저장본, 랭킹, 표(30·31칸, 재료·보호 주문서 수, 이름·묶음, 사냥 기대값이 강화 비용의 0.5~1.5배, 정확한 기대 비용으로 이익 고리 없음), 단계별 보호 주문서 수(모자라면 아무것도 바뀌지 않음), 별빛 결정 드롭·구매, 보스마다 마지막 일격 보상, 한 번에 보스 최대 체력의 25%까지(+20~+30 혼자 나타나는 글에서 쓰러뜨리지 못하고 적어도 네 번), 예전 저장본(+20 · 옛 아이템 · 옛 결투 신청)이 그대로 이어짐, 31단계 그림과 그림 파일 없는 벡터 그림이 늘 같은 SVG · PNG 렌더, `onInbound` 연결(방 쿨타임·하루 한도에 막히면 상태 그대로, 꺼진 방, `images:false`, 멘션 전달, 옛 계정 경로에는 없음).
14. 격리: 방 A 어댑터의 `logsView` 에 방 B 기록 없음.
15. v2 권리: `macro_until` 지난 고객 기록 → `onInbound` 매크로 없음. `legacy_room_until` 0 → `visitRoom` null.
16. 입장 오류 매핑: -324 → `link_gone`, -312 → `joining`+`rate_limited`, -815 → `kicked`, -444 → 행은 `rate_limited` + 전역 `join_paused_until`(봇은 `bot_down` 아님), 오픈프로필 입장(`ptp:16`) 거절(`noopen`) → `profile_blocked` 이고 다른 프로필로 다시 보내지 않음, 기본 프로필을 막은 방(`noprof`)도 `ptp:16` 으로 들어감, 모든 JOINLINK 가 `ptp:16`, 참여코드 실패 → `passcode_wrong`(9.4 의 가짜 연결로, 실제 `sendPacket` 경로를 탄다).
17. 게이트: 미니게임만 산 방(perm 4, `active`)에서 `/v1/bot/hide`·`/v1/bot/unkick`·`/v1/bot/people` → `no_roombot`. 방 관리봇 방이 `waiting_host` 면 `not_active`. unkick 대상이 `bans`·kick 기록에 없으면 `not_kicked`.
18. 기본 설정: 미니게임만 있는 설치를 기본 config 로 만들고 가짜 입장 직후 `!도움` → 게임 목록 답 1개(`games.enabled` 기본 켜짐, 검 강화 묶음 포함).
19. 권한 읽기: CHATONROOM 응답 `{olu:{lmt:4}}` → `active`, `olu` 없음 + MEMBER `{members:[{mt:2}]}` → `waiting_host`, 둘 다 없음 → 상태 유지.
20. 푸시 모양(가짜 연결의 `onPush` 로 주입): SYNCMEMT `{c, li, mids:[self], mts:[4]}` → 3초 뒤 권한 읽기 1회. 피드 11 MSG(`type:0`, `message` JSON `{feedType:11, members:[{userId:self}]}`) → 같음. LINKKICKED `{c, li, chatLog:{type:0, message:'{"feedType":6,"members":[{"userId":self}]}'}}` → `error/kicked`. LNKDELETED `{li}` → `error/room_deleted`. KICKOUT `{reason:-2}` → `markDead` 없음, `{reason:0}` → `bot_down`.
21. 나가기 대기열: 같은 설치에 두 행(봇 A, 봇 B) → 둘 다 처리. 나갈 봇 = 지금 봇이고 link_id 같음 → `kept`, `leaveChat` 없음. 나가기가 입장보다 먼저.
22. 다시 접속 금지: JOINLINK 가 알 수 없는 status → `client.close`/새 로그인 없이 `getChats` 확인만. 이미 그 `li` 의 방에 있으면 JOINLINK 를 보내지 않음.
23. 예산: 봇 시간 예산 20 을 다 쓰면 21번째 입장은 `rate_limited` + `next_try_at` = 예산 복귀 시각. 조회 예산이 없으면 `/v1/bot/resolve` 가 `budget`.
24. 공정 몫: 방 A 발송 대기 100개 + 방 B 1개 → 방 B 가 방 A 의 6개 안에 나간다. 방 A 강퇴 11번째(1시간 안) → `skip`.
40. 방 관리 명령어·기록 카드: #40-1 명령어 읽기(띄어쓰기·별칭·켜고 끄기가 조회보다 먼저)·사람 고르기(멘션·옾링 주소·닉네임·같은 닉네임·내보내기는 닉네임 거절)·설정 바꾸기 답·저장본 합치기·문구 규칙. #40-2 `!도움`·`!도움 관리`(스위치 따라). #40-3 카드 = 글 안내와 같은 값, 멘션 한 줄 extra, SVG 이스케이프, PNG 폭 720, 패널 미리 보기 그림. #40-4 발송 한도 cost 2. #40-5 sender 기본값 = `room-config` 기본값. #40(가짜 연결): 부방장 지정 대기 답, `!옾링`(권한·사용법·닉네임·멘션·주소·같은 닉네임·못 찾음·`off` 조용·`all`), `!프로필조회`(바뀐 적 없는 사람·별칭·권한), `!내보내기`(권한·닉네임 거절·방장·K bot 보호·올킥 감지 멈춤 답·주소로 KICKMEM + 기록 `why:'command'`·`by`·방에 없음), `!차단해제`(KLDELITEM·아닌 사람·권한), `!설정`·켜고 끄기(저장본·`config_rev`·모르는 칸 유지·`room_log 'config'`·이미 켬·사용법·옛 재조정 행이 되돌리지 않음·패널 저장과 겹치면 다시 읽어 패널 값 유지·저장 실패 답), 금지어 추가·목록·삭제·켜기, 부모 검증 통과, 방장·부방장이 아닌 사람의 명령어 글 홍보 금지, 입장 안내 = 사진(720) + 바로 뒤 멘션 한 줄, 사진 실패 → 글 안내 하나(멘션), `style:'text'` → 글, png 없음 → 글.
27. 오픈프로필(D12, 5.8): SYNCLINK 걸러내기(lt 1 + `op`/`/me/` 만, 남의 것·lt 2·`/o/` 뺌). (1) 오픈프로필 1개 → JOINLINK `ptp:16` + 그 `pli`, 방 구성원 이름·입장 안내 = 오픈프로필 이름, `bot_accounts` 칸 기록, `/v1/bot/status`·`/v1/bot/room` 의 `profile:'open'`, 트레이스(`raw SYNCLINK`·`CHATONROOM.olu`, `pc`·`tk` 가림). (2) 오픈프로필 없음 → `bot_no_open_profile`(`none`), JOININFO·JOINLINK 없음. (3) 오픈프로필을 만들면(SYNCLINKCR) 스스로 다시 입장. (4) 2개 → 고르지 않으면 첫 번째, 고르면 그것(이미 들어간 방은 `other`), 고른 것이 사라지면 `gone`(입장 멈춤), 자동으로 돌리면 지난번 것으로 다시 입장. (5) 기본 프로필로 들어가 있는 방 → `off` 면 스스로 바꾸지 않음, 관리자 요청에 `UPLINKPROF` 1번(권한·상태 유지, LEAVE·JOINLINK 없음), `auto` 면 부방장 대기 방을 바꾸고 새 이름 안내. (6) `UPLINKPROF` 거절(`noopen`) → 방 그대로, `fail` 기록, 24시간 안에 다시 보내지 않음, 나가지 않음. 관리자 `rejoin` → LEAVE → JOININFO → JOINLINK `ptp:16`, 새 이름으로 입장 안내. (8) SYNCLINK 실패 + 남긴 값 없음 → 행은 `queued`(오류 아님), 관리자 다시 읽기에 성공하면 입장. 남긴 값이 있으면 실패해도 `ok`. 링크 확인은 이 계정 오픈프로필만. (9) `ptp:16` 응답 유실 → 방 목록으로 성공 처리, 방 프로필 `open`.

### 7.8 `room_log.kind` 와 패널 한 줄

| kind | 한 줄 (`text`) |
|---|---|
| `join` `leave` | (기록 표가 따로 그림, 조치 기록에는 넣지 않음) |
| `churn` | 들낙 감지 · {이름} {M}분 {n}회 · {경고/내보내기/내보내기 실패} |
| `kick` | 내보내기 · {이름} · {사유: 들낙/퇴장/홍보/수동/방 명령어} |
| `kick_fail` | 내보내기 실패 · {이름} · {사유} |
| `unkick` | 내보내기 해제 · {이름} |
| `config` | 방에서 설정 변경 · {이름} · {들낙 감지 켜기 / 금지어 2개 추가 …}(7.2 (g)) |
| `promo` | 홍보 금지 · {이름} · 경고 {n}회 |
| `hide` | 글 가리기 · {n}개 (실패 {m}개) · {패널/방장} |
| `cover` | 금지어 가림 · {이름} |
| `perm` | 부방장 지정 감지 / 부방장 해제 감지 |
| `wave` | 올킥 감지 · {n}명 |
| `state` | K bot 입장 완료 · 오류({짧은 사유}) · K bot 입장 다시 시도 |
| `skip` | {K bot 한도 초과로 건너뜀 / 올킥 감지 중이라 건너뜀 / 실패가 이어져 잠시 멈춤 / 늦어져서 건너뜀} · {종류} |

### 7.9 입장 안내 (방에 처음 들어갔을 때 1회)

방 메시지는 짧은 해요체다(docs/TONE.md 「K bot 방 메시지」). 방 사람들은 계정·패널·회원을 모르므로 봇은 이름으로, 설정하는 사람은 방장님·관리자로 쓴다. 문구의 단일 소스는 `sender/src/roomfeat.mjs`(`joinNotice`·`roombotAddedNotice`·`PROMOTED_NOTICE`·`profileChangedNotice`)이고, 조사는 `josa()` 가 이름의 끝소리로 고른다.

- 방 관리봇 포함: `[K bot]\n방 관리봇이 입장했어요.\n방장님이 「{봇 이름}」을(를) 부방장으로 지정하면 방 관리 기능이 시작돼요.` (+ 미니게임도 있으면 `\n「{앞글자}도움」을 입력하면 미니게임 명령어를 볼 수 있어요.`). `{봇 이름}` 은 그 방에서 보이는 이름 = 오픈프로필 이름(D12, 5.8). 이름을 모르면 `K bot을`.
- 미니게임만: `[K bot]\n미니게임봇이 입장했어요.\n「{앞글자}도움」을 입력하면 명령어를 볼 수 있어요.` (games 기본 켜짐이라 바로 답한다, 7.1. 고객이 games 를 끈 뒤에 들어간 방이면 둘째 줄 대신 `관리자가 미니게임을 켜면 바로 쓸 수 있어요.`)
- 부방장 지정 감지 때(처음 1회): `[K bot]\n부방장으로 지정되었어요. 이제 켜 둔 방 관리 기능이 작동해요.` (D15. 켜지 않은 기능을 "시작합니다"라고 말하지 않는다)
- 미니게임봇으로 들어가 있는 방에 방 관리봇을 더했을 때(5.4, 그 봇이 그 방에서 방 관리봇 안내를 한 적이 없으면 1회): `[K bot]\n방 관리봇이 추가되었어요.\n방장님이 「{봇 이름}」을(를) 부방장으로 지정하면 방 관리 기능이 시작돼요.`
- 부방장 지정 대기 방에서 봇 프로필을 오픈프로필로 바꾼 뒤(5.8, 1회): `[K bot]\nK bot 프로필이 「{이름}」(으)로 바뀌었어요.\n방장님이 「{이름}」을(를) 부방장으로 지정하면 방 관리 기능이 시작돼요.`
- "처음 1회"는 **그 봇 계정이 그 방(chat)에서** 처음일 때다. `room_state.runtime` 에 `welcomed:{chat, by: 봇 device_id, roombot}`·`promoted:{chat, by}` 로 남겨, 다른 봇으로 옮긴 뒤(D17)나 링크를 바꿔 다른 방에 들어간 뒤에는 새 봇이 입장 안내(닉네임)와 부방장 지정 확인을 다시 한다. 미니게임봇으로만 안내한 방에 방 관리봇을 더한 뒤 다시 들어가면 방 관리봇 입장 안내를 한다.
- 이름(오픈프로필 이름)은 봇마다 달라야 방장이 진짜 봇을 고를 수 있다(D12). 이름을 아직 못 읽었으면 `「…」` 부분을 뺀다.

---

## 8. 보안

1. **비밀번호**: `crypto.scrypt` N=2^15·r=8·p=1·32바이트, salt 16바이트, `maxmem: 256*N*r` 명시, 저장 형식 `$scrypt$ln=15,r=8,p=1$<salt b64url>$<dk b64url>`, 매개변수가 다르면 성공 로그인 때 재해시. NFKC 정규화. 동시 해시 2개 세마포어 + **대기열 상한 20**(넘으면 503 `busy` `요청이 많아 처리하지 못했습니다. 잠시 뒤 다시 시도해 주세요.`, 512MB 인스턴스에서 대기 요청이 쌓이지 않게). 해시 전에 레이트리밋·`loginBlockedMs`·`loginSlowMs` 를 먼저 본다(3.1). 없는 아이디도 더미 해시로 같은 시간. `AUTH_SCRYPT_LOG_N`(10~17, 시험 10).
2. **세션**: 토큰 32바이트 무작위(base64url), DB 에는 sha256 만. 쿠키 `kb_s` `Path=/; HttpOnly; SameSite=Lax; Secure(https); Max-Age=30일`. 읽기는 30초 메모리 저장(종료·차단 때 그 회원 항목 지움), `last_seen_at` 은 10분에 1번만 갱신, 남은 기간 15일 미만이면 30일로 연장 + 쿠키 재발급. 비밀번호 변경·Google 재설정·관리자 차단 = 다른 세션 전부 종료.
3. **CSRF**: `sameOriginWrites` — GET/HEAD/OPTIONS 외 요청이 3.1 의 경로면 (가) `application/json` 아니면 415 (나) `Origin` 이 있으면 요청 origin 또는 `purchaseBase` origin 과 같아야 함(`null` 거절) (다) `Sec-Fetch-Site` 가 있으면 `same-origin` 이어야 함. `/api/deposit-hook`·`/admin/*` 제외(`/v1/*` 는 공개되지 않는다). 부작용 있는 GET 없음(로그아웃도 POST, 링크 조회도 POST `/api/room-preview`).
4. **소유 검사**: 콘솔·구매의 모든 `device_id`·`install_id`·주문 id 는 회원 소유를 서버가 확인. `bot.` id 는 고객 경로에서 404, sender 도 고객용 `/v1` 읽기에서 404(이중).
5. **sender 내부 API**: 부모의 공개 `/v1/*` 프록시(`lib/sender-child.js` `install()`·`proxy()`, server.js:34)를 **없앤다** — 자식은 127.0.0.1 에서만 듣고 부모 `call()` 만 쓴다. `x-sender-token` 비교는 `crypto.timingSafeEqual`. `/v1/fake/*` 는 `SENDER_FAKE=1` 일 때만 등록하고, 부모 `warnEnv` 가 `SENDER_FAKE` 를 보면 큰 경고를 찍는다(운영 금지).
6. **참여코드**: `lib/secretbox.js` 와 `sender/src/secretbox.mjs` 가 같은 형식 — AES-256-GCM, 키 = HKDF-SHA256(ikm=`CONFIG_SECRET`, salt=`'kbot'`, info=`'room-passcode/v1'`, 32바이트), 값 = `'v1.' + base64url(iv12 ‖ tag16 ‖ ct)`. 응답·로그·`items` 에 평문 없음. 화면은 `needs_passcode` 만 안다.
7. **OAuth**: PKCE S256 + state + nonce, id_token 의 iss·aud(·azp)·exp·nonce 검사, `sub` 로만 식별, 상태 쿠키는 콜백에서 항상 삭제, 링크 모드는 세션 id 가 같아야 함, `next` 는 `^/(?!/)[\w\-./?=&#%]{0,200}$` 만, 웹뷰 UA 차단, 끝점 덮어쓰기는 localhost/https 만.
8. **채널톡**: `memberId` 는 `CHANNEL_MEMBER_SECRET` 이 있을 때만, 값은 회원 번호가 아니라 `CONFIG_SECRET` 파생 키의 HMAC(6.10 7, 추측 불가). `memberHash` = hex 비밀로 HMAC-SHA256. **채널 데스크에서 회원 해시(Member Hash) 검증을 켠 뒤에** `CHANNEL_MEMBER_SECRET` 을 넣는다(꺼져 있으면 아무 브라우저나 남의 memberId 로 부팅해 그 회원의 지난 상담을 볼 수 있다) — DEPLOY.md·`warnEnv` 가 이를 알린다. 없으면 이름만 보내는 익명 부팅. 전화번호·이메일은 보내지 않는다. 콘솔에는 SDK 를 싣지 않는다(D25).
9. **레이트리밋·잠금**: 3.1 표. 로그인 실패 잠금은 `(아이디, IP)` 단위, 아이디 단독은 늦추기만(남이 본인을 내쫓지 못하게, 존재 여부 노출 없음). 미리 보기는 회원당 시간 60회 + sender 의 봇별 조회 예산(봇 계정 보호, 5.3).
10. **봇 보호**: 입장 간격·백오프·봇별 입장/조회 예산(5.3), 입장 실패로 다시 접속하지 않음, 고객 다시 시도 지수 간격·상한과 고객 옮기기(24시간)·다시 설치(30분) 간격·회원당 시간 20번(3.4.3), 방별 공정 몫 한도(5.5), 설치 금지 방·확인 대기(D28), 강퇴·가리기 예산, 방장·부방장·제외는 절대 내보내지 않음, 이름만으로는 내보내지 않음, 모든 강퇴 기록·해제 가능(K bot 이 내보낸 사람만). 기본값은 `경고만`.
11. **개인정보**: 멤버 프로필 사진은 저장하거나 안내·화면에 내보내지 않는다. 방 기록·작성자 목록은 그 방 주인 회원에게만, 그리고 방 관리봇이 있는 방에서만(미니게임만 산 회원은 남의 방 구성원 id·이름을 받지 않는다, 3.4.3). 관리자 화면도 봇 계정 비밀번호를 저장하지 않는다(등록 흐름은 sender 메모리에만, 지금과 같음).
12. **감사 기록**(`lib/audit.js` `KINDS` 추가): `member`(signup·pw_change·pw_reset_google·pw_reset_admin·google_link·google_unlink·claim·claim_reassign·logout_all·block·unblock·grant), `member_lockout`(알림 종류), `install`(retry·move·remove·rebind·products·grant·transfer·block·release, 고객 옮기기·다시 설치는 member_move·member_relink·member_reinstall), `order`(기존 + member_cancel), `bot`(register·update·remove). `audit.log(kind, {key?, member_id?, detail, ip})`. 실패한 로그인을 하나하나 남기지 않는다.
13. **XSS**: 사이트·관리 화면은 서버 문자열을 `textContent` 로만, 콘솔은 `esc()` 를 거쳐서만 `innerHTML`. 방 이름·닉네임은 고객이 정하는 값이다.
14. **화면 틀 막기·스크립트 제한**: 모든 HTML 에 `X-Frame-Options: DENY` + CSP `frame-ancestors 'none'`, `/panel`·`/manage` 는 CSP `script-src 'self'` 추가(6.1).

---

## 9. 작업 분담과 시험

### 9.0 0단계 커밋 (오케스트레이터, 나눠 맡기기 전에 1번)

병렬 작업이 서로의 결과 없이 커밋 조건을 통과하려면 공통 바닥이 먼저 있어야 한다. 0단계 커밋이 넣는 것:

1. `lib/db.js` `STEPS` 끝에 2.1 의 SQL 블록 전부(라벨 `accounts-v1:*`). 이 블록은 이후 작업 2 만 고친다.
2. `lib/secretbox.js`·`sender/src/secretbox.mjs` 완성본(8.6 형식)과 **고정 시험 벡터**: `CONFIG_SECRET='0123456789abcdef0123456789abcdef'`, 평문 `'0000'`, `iv = 000102030405060708090a0b`(시험 전용 `sealWithIv`) → 기대 blob 을 두 파일의 시험(`lib/purchase-check.js`·`sender` selfcheck)이 같은 문자열로 단언한다. 0단계에서 실제 값을 계산해 두 시험에 박는다.
3. 9.2 서명대로 내보내기만 하는 **틀 모듈**: `lib/member-auth.js`, `lib/room-config.js`, `lib/entitle.js`, `lib/installs.js`, `lib/openchat.js`(함수는 `throw new Error('not implemented')` 이거나 안전한 기본값). 각 작업이 자기 모듈을 채운다.
4. `package.json` `scripts` 에 패키지별 검사(9.3)를 먼저 만들어 둔다.

**합치는 순서**: 0 → 2 → 1 → 3 → 5 → 4 → 6. 각 작업은 자기 커밋 조건을 **자기 검사 명령**(9.3 의 `check:wN`)으로 통과하고, 합칠 때마다 오케스트레이터가 `npm run check` 전체를 돌린다. 앞 작업이 합쳐지기 전에 그 결과가 필요한 통합 시험(예: 작업 6 의 `manage-accounts.mjs` 가 작업 2 의 `installs`)은 합친 뒤에 돈다.

### 9.1 작업 패키지 (파일이 겹치지 않는다)

| 작업 | 이름 | 소유 파일 (만들거나 고치는 것) |
|---|---|---|
| 1 | 회원 인증 · 콘솔 API | `lib/member-auth.js`, `lib/google-oauth.js`(새), `routes/auth.js`(새), `lib/room-config.js`, `lib/auth-check.js`(새), `lib/room-config-check.js`(새), `routes/panel.js`, `lib/panel-config.js`, `lib/panel-ids.js`, `lib/panel-inbox-check.js`(routes/panel.js 소스 단언 58~86줄을 회원 세션 기준으로 고쳐 씀: 로그인 구간 단언은 지우고, `ownsDevice(`·`accountRows(`·`forgetAccounts(s.key)` 는 새 이름 — 예 `ownsMemberDevice(`·`memberAccountRows(`·`forgetAccounts(s.member.id)` — 으로 바꾼다. `mergeInbox` 단위 단언은 그대로), `lib/ratelimit.js`, `server.js`, `package.json`, `render.yaml`, `DEPLOY.md` |
| 2 | 구매 · 발급 · 설치 수명 | `lib/db.js`(0단계 뒤), `lib/pricing.js`, `lib/keys.js`, `lib/features.js`, `lib/audit.js`, `lib/entitle.js`, `lib/installs.js`, `lib/openchat.js`, `lib/secretbox.js`(0단계 뒤), `lib/sender-child.js`(공개 프록시 제거 + `onReady`), `lib/purchase-check.js`(새), `routes/purchase.js`, `docs/SPEC.md`, `README.md`(가격 30,000원·라이선스 키 로그인 설명 → 회원 계정·상품 3종, 10·19·24·31·36~40·70·78 줄 부근), `docs/AUTO_DEPOSIT.md`(키 발급 → 회원 계정 적용 문구) |
| 3 | 발송(sender) | `sender/src/*`(기존 전부 + 새 `botpool.mjs` `roomfeat.mjs` `secretbox.mjs`(0단계 뒤) `fake.mjs`), `sender/package.json`, `sender/README.md` |
| 4 | 공개 사이트 | `public/index.html` `buy.html` `order.html` `my.html`(파일은 지우지 않고 `<meta http-equiv="refresh" content="0;url=/account#claim">` 한 줄짜리 안내 페이지로 바꿈 — `/my` 경로 자체는 서버가 302) `login.html`(새) `signup.html`(새) `account.html`(새) `support.html`(새) `style.css` `app.js` `support.js`(새) |
| 5 | 콘솔 화면 | `public/panel.html` `panel.css` `panel.js`, `lib/panel-check.js` |
| 6 | 관리자 | `routes/admin.js`, `public/manage.html`, `public/manage.js` |

`server.js`(작업 1) 할 일: `routes/auth.js` 를 `purchaseRoutes` 앞에 mount, `sameOriginWrites` 를 레이트리밋 미들웨어 바로 뒤에, `app.get('/login'|'/signup'|'/account'|'/support', page(...))`, `app.get('/my', (q, r) => r.redirect(302, '/account#claim'))`, **`senderChild.install(app)` 줄 삭제**(8.5), HTML 보안 헤더(6.1), listen 뒤 `require('./lib/installs').startLoop()` 와 `require('./lib/entitle').startLoop()`, `warnEnv` 에 9.6 의 경고(Google 한쪽만 설정, 덮어쓰기 활성, `CHANNEL_MEMBER_SECRET` hex 아님, `CHANNEL_MEMBER_SECRET` 설정 시 "채널 데스크의 회원 해시 검증을 켰는지 확인" 알림, 상담 수단 없음, `SENDER_FAKE` 설정됨, 실제 redirect URI 출력).

지금 브랜치의 단일 요금제 초안(`lib/pricing.js`·`routes/purchase.js`·`public/app.js`·`public/manage.js` 의 `K bot 1개월 30,000원`)은 이 문서대로 전부 교체한다. 옛 키 경로(`createLicenses`·`grant`·`/admin/create`·`/admin/grant`)는 관리자 지원용으로 남긴다(이관된 키에는 409, 3.5).

손대지 않는 것: `lib/panel-auth.js`(옛 키 쿠키, 남겨 둠), `lib/panel-inbox.js`, `lib/auth-text.js`, `lib/sign.js`, `docs/UI_V*.md`, `docs/BRAND.md`·`TONE.md`.
`style.css`·`panel.css` 의 `:root` 토큰은 **아무도 바꾸지 않는다**(두 파일이 같아야 함). 새 색 없음. Google G 마크의 색은 HTML 인라인 SVG 에만.

### 9.2 인터페이스 (이 서명대로 만들고 이 서명만 믿는다)

**작업 1 → 다른 작업이 쓰는 것** (`lib/member-auth.js`, CommonJS)

```js
COOKIE                                   // 'kb_s'
MAX_SESSIONS                             // env MEMBER_MAX_SESSIONS || 3
normLoginId(raw) -> string               // 소문자·trim, 규칙 밖이면 ''
loginIdProblem(raw) -> null | {reason, error}
passwordProblem(pw, loginId) -> null | {reason:'bad_password', error}
hashPassword(pw) -> Promise<string>
verifyPassword(pw, stored) -> Promise<{ok:boolean, rehash:boolean}>
startSession(req, res, memberId, method) -> Promise<{sid, evicted:number}>
readSession(req) -> Promise<null | {sid, method, auth_at, member:{id, login_id, blocked_reason, macro_until, legacy_room_until}} | {revoked:string}>
requireMember(req, res, opts?) -> Promise<Session|null>   // 401/403 응답까지 직접 쓴다. opts.allowBlocked
endSession(req, res) -> Promise<void>
endAllSessions(memberId, {exceptSid?, why}) -> Promise<number>
sameOriginWrites(req, res, next)
publicMember(row, googleRow?) -> {id, login_id, google_linked, google_email_masked}
channelConfig(member|null) -> null | {plugin_key, member_id?, member_hash?, name?}   // member_id 는 6.10 7 의 HMAC 값
channelMemberId(memberId) -> string | null            // CHANNEL_MEMBER_SECRET 없으면 null. /admin/members?q= 가 씀
noteLoginFail(loginId, ip) / loginBlockedMs(loginId, ip) / loginSlowMs(loginId) / clearLoginFails(loginId, ip)   // lib/ratelimit.js
```

`lib/room-config.js`: `sanitizeRoomConfig(prev, body, ctx:{products, display}) -> {ok:true, config} | {ok:false, status, reason, error}`, `presentRoomConfig(cfg, products) -> object`, `DEFAULTS`, `MAX_WORDS=300`, `MAX_EXEMPT=50`.

`lib/panel-ids.js`: 기존 함수 유지 + `newMemberDeviceId(memberId)`, `isBotId(id)`.

**작업 2 → 다른 작업이 쓰는 것**

```js
// lib/pricing.js
PRODUCTS, MAX_ROOMS, quote(input), table(), label(id), bankInfo(), contactInfo()

// lib/openchat.js
normLink(text) -> string            // 'https://open.kakao.com/o/<code>' | ''
parseLink(text) -> {kind:'room', url} | {kind:'profile'} | {kind:'post'} | {kind:'none'}

// lib/secretbox.js
seal(text) -> string ; open(blob) -> string|null ; sealWithIv(text, iv) -> string   // 마지막은 시험 전용(9.0)

// lib/entitle.js
macroView(member, now?) -> {until, active, days_left}
extendMacro(client, memberId, days) -> Promise<number>          // 새 until
claimKey(client, memberId, key) -> Promise<{ok, moved?, status?, reason?, error?}>
applyOrder(client, orderRow) -> Promise<{ok, applied, installs} | {error}>
afterApprove(result) -> void                                     // 커밋 뒤, 기다리지 않음
pushGrants(memberId|null) -> Promise<void>                       // null = 전체, {full:true, as_of} 로 보냄(4.5)
startLoop() -> void                                              // server.js 가 listen 뒤 1번. onReady 전체 밀기 + 10분 밀기 + 하루 정리(4.5)
reassignKey(client, key, memberId|null) -> Promise<{ok, from, to} | {error}>   // /admin/license-reassign
summary(memberId) -> Promise<{macro, legacy_room_until, accounts:{n,max}, rooms:{total,active,attention}}>
MAX_ACCOUNTS                                                      // env MEMBER_MAX_ACCOUNTS || 3

// lib/installs.js
ERRORS                     // 5.6 표: code -> {short, long, retry}
displayOf(row, now?) -> {display, label, detail, can_retry, retry_after, retry_admin_only}
publicView(row, botRow?, pending?, order?) -> RoomView           // on_count·order 포함(3.4.2)
preview(memberId, text) -> Promise<{ok:true, verified, room, mine, available} | {ok:false, status, reason, error}>
reserveForOrder(client, memberId, orderId, room) -> Promise<{install_id} | {error, reason, status}>
cancelForOrder(client, orderId) -> Promise<number>
cancelMemberOrder(memberId, orderId) -> Promise<{ok} | {ok:false, status, reason, error}>   // POST /api/my/orders/cancel
conflictFor(client, {selfId?, memberId, linkId, linkUrl}) -> Promise<{taken:row|null, mine:row|null}>   // 3.3 의 충돌 SQL
assignBot(client, installId, {exclude?}) -> Promise<string|null>
isBlocked(client, {linkId, linkUrl}) -> Promise<boolean>
listForMember(memberId) -> Promise<RoomView[]>
getForMember(memberId, installId) -> Promise<{row, view:RoomView}|null>   // phase installed|pending_payment
saveConfig(memberId, installId, config, rev?) -> Promise<{ok, row} | {ok:false, status, reason, error}>
retry(installId, {memberId?, admin?, passcode?}) -> Promise<{ok, row} | {ok:false, status, reason, error}>
grantRoom(memberId, text, passcode, products) -> Promise<...>    // 관리자
move(installId, botId|null) / remove(installId) / rebind(installId, text) / setProducts(installId, products)
transfer(installId, memberId) / block({installId?, link?, reason}) / unblock(blockId) / release(installId)   // 관리자, 각각 room_leaves·감사 포함
nudge(installId|null) -> Promise<void>                           // sender /v1/bot/sync, 실패는 삼키고 로그
nudgeMember(memberId) -> Promise<void>
startLoop() -> void                                              // server.js 가 listen 뒤 1번 부름

// lib/sender-child.js
onReady(fn) -> void        // SENDER_READY 마다 호출
```

`keys.approveOrder` 의 반환은 4.2. `db.shapeOrder` 는 `member_id kind items applied` 를 더 낸다.
`audit.log(kind, {key?, member_id?, detail, ip})`·`audit.record(req, kind, info)` — `member_id` 칸이 추가된다. `KINDS` 는 8장 12번.

**작업 3 → 부모가 쓰는 것**: 3.6 의 HTTP 계약, 2.2 의 DB 쓰기 규칙, `SENDER_FAKE` 동작(9.4).

**작업 4 → 작업 5 가 쓰는 것**: `/support.js?v=1` 의 `window.kbSite`(프라미스), `window.kbSupport.open(ctx)/reboot()`, `<html data-support>` 규칙(6.10). panel.html 은 `<html data-support-mode="link">` 로 SDK 없이 쓴다.

### 9.3 `package.json` 검사 (0단계가 틀을 만들고 작업 1 이 이대로 맞춘다)

```
check:w1  node --check lib/member-auth.js lib/google-oauth.js routes/auth.js lib/room-config.js routes/panel.js server.js && node lib/auth-check.js && node lib/room-config-check.js && node lib/panel-inbox-check.js
check:w2  node --check lib/db.js lib/pricing.js lib/keys.js lib/entitle.js lib/installs.js lib/openchat.js lib/secretbox.js lib/sender-child.js routes/purchase.js && node lib/purchase-check.js
check:w3  npm --prefix sender run check
check:w4  node --check public/app.js public/support.js
check:w5  node --check public/panel.js && node lib/panel-check.js
check:w6  node --check routes/admin.js public/manage.js
check     기존 목록(그대로) + 위 여섯 개를 차례로
```

`lib/panel-inbox-check.js` 는 `check`·`check:w1` 에 남는다(작업 1 이 소스 단언을 고쳐 씀, 9.1). 각 check 파일은 DB 없이 돌고 마지막 줄에 `<이름> check ok` 를 찍는다. 작업마다 커밋 조건은 자기 `check:wN` 이고, 전체 `check` 는 합칠 때 오케스트레이터가 돌린다(9.0).

### 9.4 sender 가짜 모드 (`SENDER_FAKE=1`, 작업 3)

카카오에 붙지 않고 전체 흐름을 오프라인으로 돌리기 위한 모드. **결과를 직접 쓰지 않고 연결 자리(seam)를 바꾼다**: `fake.mjs` 가 agent-messenger 의 `KakaoTalkClient` 대신 쓰는 `FakeKakaoClient` 를 내보내고, botpool·runner 는 진짜와 같은 코드(`acquireSession().getConnection().sendPacket`, `onPush`, `onSessionEvent`, `getChats`, `getProfile`, `getMembersByIds`, `sendMessage`)로 그것을 부른다. 그래서 JOININFO·CHECKJOIN·JOINLINK 본문, BSON `Long` 감싸기, `lt`·`pv` 검사, `locoOk` 판정, 권한 읽기, 푸시 해석이 가짜 모드에서도 실제 경로를 탄다.

- 가짜 서버 상태(프로세스 메모리): 방 표 `{code → {li, ln, lt:2, pv, passcode?, chatId, members:Map<userId,{mt, nick}>, bans:Set, deleted}}`. 봇마다 `userId`.
- `sendPacket(method, body)` 응답(node-kakao 응답 모양, `{statusCode, body:{status, …}}`):
  - `JOININFO {lu}` → 코드에 `gone` → `status:-324`; `dm` → `ol.lt=1`; `comm` → `ol.lt=3`(커뮤니티 방); 그 밖 `{ol:{li: Long, ln, lu, lt:2, pv: (pass ? 64 : 0) | (noprof ? 0 : 32)}}`.
  - `CHECKJOIN {li, pc}` → `pc==='0000'` 이면 `{tk:'t'}`, 아니면 `status:-802`(가정 값, 10.1 #2 와 같게).
  - `JOINLINK {li, ptp, pli?, nn?, tk?}` → 코드에 `full` → `status:-501`; `rate` → 처음 1번 `-312`; `noprof` 이고 `ptp===1` → `status:-804`(가정 값); `noanon` 이고 `ptp!==16` → `-804`; `noopen` 이고 `ptp===16` → `-804`; `ptp===16` 인데 `pli` 가 그 계정의 오픈프로필이 아니면 `-804`; `bans` 에 봇 → `-815`; 성공 `{chatRoom:{chatId: Long}, olu:{userId, lmt:2, ptp, pli?, nn}}` 그리고 멤버 추가(이름 = 오픈프로필 이름). `FAKE_JOIN_MS`(기본 1500) 뒤 응답.
  - `CHATONROOM {chatId}` → `{olu:{userId, lmt: 지금 봇 mt, ptp, pli?, nn}}`(`ptp` 없는 옛 멤버는 1, `/v1/fake/perm` 이 `drop_olu:true` 면 `olu` 를 빼서 MEMBER 경로를 시험).
  - `MEMBER {chatId, memberIds}` → `{members:[{userId, type:1000, mt, pli?(오픈프로필일 때만), nickName}]}`.
  - `SYNCLINK {ltk}` → 그 계정의 오픈프로필(`lt:1`, `lu` = `open.kakao.com/me/…`, `op`, `olu{userId, nn, ptp:2}`) + 걸러져야 할 링크 2개(이 계정이 만든 방 `lt:2`, 1:1 오픈채팅 `lt:1` `/o/`). 봇 계정은 따로 정하지 않으면 오픈프로필 1개(`K봇 오픈 <4 hex>`, 닉네임과 다름). `syncFail` 이면 `status:-500`.
  - `UPLINKPROF {li, ptp, pli}` → 방에 없으면 `-403`, `noopen` 이고 `ptp===16` 이거나 `pli` 가 그 계정 것이 아니면 `-804`, 성공이면 멤버 `ptp`·`pli`·이름을 바꾸고 방에 SYNCLINKPF `{c, li, olu}` 푸시 + `{olu}`.
  - `JOININFO {lu: open.kakao.com/me/…}` → 그 오픈프로필 링크(`lt:1`, `olu.userId` = 주인), 없으면 `-324`.
  - `KICKMEM`·`KLDELITEM`·`REWRITE`·`KICKLEAVE` → 봇 `mt & 5` 가 아니면 `status:-203`(가정 값), 아니면 성공하고 상태를 바꾼다(나간 사람 KICKMEM 은 `FAKE_KICK_LEFT=0` 이면 실패 — 7.2(b) 의 대체 경로 시험).
  - `getChats({all:true})` → 봇이 들어간 방들 `{chat_id, link_id, type:'OM'}`.
- 푸시(`onPush` 처리기로 진짜 모양을 보냄):
  - `/v1/fake/perm {install_id, perm, drop_olu?}` → 그 방의 봇 `mt` 를 바꾸고 SYNCMEMT `{c, li, mids:[봇], mts:[perm]}` + 피드 11(승격)·12(강등) MSG `{chatLog:{type:0, message: JSON.stringify({feedType, members:[{userId:봇}]})}}` 를 보낸다. 상태 전환은 sender 의 실제 처리(3초 뒤 권한 읽기)로 일어난다.
  - `/v1/fake/profiles {device_id|user_id, profiles?:[{name, li?, url?}], fail?}` → 그 계정의 오픈프로필 목록을 바꾸고(새 것 SYNCLINKCR `{ol}`, 없어진 것 SYNCLINKDL `{li}` 푸시) `fail` 이면 SYNCLINK 를 실패시킨다.
  - `/v1/fake/event {install_id, kind}`: `kicked` → LINKKICKED `{c, li, chatLog:{type:0, message:'{"feedType":6,"members":[{"userId":<봇>}]}'}}` + 봇을 `bans` 에 넣음; `deleted` → LNKDELETED `{li}`; `join`/`leave`(user_id, name) → NEWMEM / DELMEM `{chatLog:{logId, sendAt, type:0, message: 피드 4 / 2 JSON}}`; `message`(user_id, name, text, type, attachment?) → MSG `{chatLog:{logId, authorId, type, message, attachment, sendAt}, authorNickname}`; `kickout`(reason) → KICKOUT `{reason}`.
- 고객 계정: `/v1/register/begin` — 이메일에 `phone` 이 있으면 `confirm_on_phone`(passcode `4829`, 300초) 후 confirm 에서 `ok`, 비밀번호 `wrong` 이면 `bad_credentials`, 그 외 즉시 `ok`. 붙은 슬롯은 `connected:true`, `/v1/chats` 는 가짜 오픈채팅방 2개, 발송은 가짜 log_id 로 성공.
- 봇 계정: 같은 등록 규칙. 등록되면 `bot_accounts.state='connected'`, 닉네임 `K bot 테스트 <n>`(봇마다 다르게).
- `/v1/bot/resolve`: 위 JOININFO 응답을 그대로 쓴다(진짜 해석 코드). `link_id` = 코드의 sha256 앞 12 hex 를 10진으로, `name` = `테스트방 ` + 코드.
- 가짜 모드에서도 DB 쓰기·`room_log`·설정 반영은 진짜와 같다. 예산(5.3)도 같게 적용하되 `BOT_JOIN_PER_HOUR` 등은 시험이 환경변수로 늘린다.
- selfcheck 의 7.7 #16·#19~#23·#27 은 이 가짜 연결을 프로세스 안에서 만들어 쓴다(HTTP 없이).

### 9.5 시험 계획

**공통 환경**: 로컬 Postgres 16 (`/usr/lib/postgresql/16/bin`, `psql` 있음). 예: `initdb -D $SCRATCH/pg -U postgres --auth=trust`(root 면 비root 사용자로), `pg_ctl -D $SCRATCH/pg -o "-p 55432 -k /tmp" -l $SCRATCH/pg.log start`, `createdb -h 127.0.0.1 -p 55432 -U postgres kb`, `DATABASE_URL=postgres://postgres@127.0.0.1:55432/kb?sslmode=disable`. `$SCRATCH` 는 각자의 scratchpad. 브라우저: `PW=/opt/pw-browsers/chromium-1194/chrome-linux/chrome`. 0단계(9.0)가 표를 만들어 두므로 어느 작업이든 로컬 PG 에 `db.migrate()` 로 표를 갖출 수 있다.

| 작업 | 단위 시험 (커밋 조건 = `check:wN`) | 통합 시험 (scratchpad 스크립트) |
|---|---|---|
| 1 | `lib/auth-check.js`: 해시 왕복·재해시 표시, 아이디·비밀번호 규칙, `kindOf` 새 경로(POST `/api/room-preview` 포함), `sameOriginWrites`(text/plain 415, 남의 Origin 403), id_token 검사(iss·aud·azp·nonce·exp·iat), `kb_o` 서명·만료, 로그인 잠금(같은 아이디·다른 IP 는 잠기지 않음, 30회 넘으면 `loginSlowMs>0`), scrypt 대기열 21번째 → busy, 채널 memberHash 시험 벡터(`lucas`/`4629de5d…3e25` → `99427c7b…afea2`), `channelMemberId` 가 순번이 아님. `lib/room-config-check.js`: 7.1 범위·열거·300 단어·50 제외·제품 없음 403·비활성 409·`games.cooldownSec` 0 거절·`games.enabled` 기본 true. `lib/panel-inbox-check.js`(고쳐 쓴 소스 단언) | `e2e-auth.js`: 로컬 PG + 가짜 Google 서버(3.2 B6) — 가입·로그인·잠금(같은 IP 11회 → 429, 다른 IP 는 로그인 됨)·세션 상한(4번째 로그인 → 가장 오래된 세션 401 `session_evicted`)·로그아웃·전부 로그아웃·비밀번호 변경 후 다른 세션 무효·Google 연결/taken/already/not_linked(recover 문구 포함)/denied/expired(쿠키 변조)/로그인/재설정 창(`AUTH_RESET_WINDOW_MS=1` → 403)·이관(macro 더하기, panel_accounts 이동, 재이관 409)·`/my` → `/account#claim` → 로그인 → `#claim` 유지·HTML 응답의 `X-Frame-Options`·`/panel` CSP·공개 `/v1/status` 가 404(프록시 없음) |
| 2 | `lib/purchase-check.js`: `quote` 금액·한도·오류(방 0개 매크로만 포함), `normLink`, `secretbox` 왕복·변조 거부·**0단계 시험 벡터**, `displayOf` 전 상태(`on_count` 0 문구, `retry_after`, `retry_admin_only`, hold), `ERRORS` 문구가 TONE 규칙(마침표·합니다체)·`실시간 상담` 이 없음 | `e2e-purchase2.js`: 로컬 PG + **가짜 자식**(`SENDER_CHILD_ENTRY=$SCRATCH/stub-sender.mjs`: `SENDER_LISTENING <port>`·`SENDER_READY` 를 찍고 `/v1/bot/resolve`·`/v1/bot/sync`·`/v1/grants` 를 흉내, 받은 `full` 을 기록) — 미리 보기(POST), **매크로만 주문**, 주문(매크로+새 방+기존 방 상품 추가), 남의 `install_id` 줄 404, 미입금 상한 429, 다른 회원의 미입금 주문이 있는 방도 주문 됨 → 먼저 입금된 쪽이 installed, 늦은 쪽 입금은 `ambiguous`+`needs_review` → 관리자 `skip_conflicts` 로 나머지 적용, 입금 웹훅 → done·`macro_until`·installed·봇 배정, 같은 알림 두 번 → 한 번만 적용, `DEPOSIT_AUTO_APPROVE=0` 에서 `paid` 주문이 있는 방·상품 재주문 409, 회원 주문 취소 → 설치 canceled, 48시간 만료 → 설치 canceled, 관리자 되살리기 성공·충돌, 이관된 키를 대상으로 한 옛 연장 주문 입금 → 회원 `macro_until` 증가, `SENDER_READY` 때 `full:true` 밀기 1회, `joining` 15분 멈춘 행 → `queued` |
| 3 | `npm --prefix sender run check`(selfcheck 7.7 전부 + secretbox 시험 벡터) | `e2e-sender-fake.mjs`: 로컬 PG 에 회원·봇·설치 행을 직접 넣고 `SENDER_FAKE=1` 자식만 띄워 queued → joining → waiting_host → (`/v1/fake/perm 4`) active → (`kicked`) error·배타권 해제 → (부모 대신 SQL 로 "다시 입장" 묶음) → active, **속도 제한(`rate` 코드) 중 자식 kill → 다시 띄움 → 같은 행이 `active`**, 옮기기 두 번(room_leaves 2행) → 두 이전 봇 모두 나감, rebind 같은 봇 → 새 방 입장·옛 방 나감, 미니게임만 방 → 입장 직후 `!도움` 답, 미니게임만 방 hide → `no_roombot`, `/v1/grants full` → 목록에 없는 고객 기록 정지, 설정 rev 변경 반영, 들낙·홍보 이벤트로 `room_log` 행 생성, 공개 경로 없이 `x-sender-token` 틀리면 401 |
| 4 | `check:w4` | `site-accounts.mjs`(Playwright, 모의 API): 로그인·가입 오류 칸, `KAKA-` 입력 안내, `data-auth` 전환(휴대폰 로그아웃 상태 상단 로그인 아이콘), 구매: 방 행 0개로 시작 → 매크로만 주문, 방 추가·미리 보기·참여코드 칸 전환·`verified:false` 확인란·이용 조건 확인란·합계, 로그아웃 상태 `#loginGate`, 주문 화면 회원 문구(6.7 표)·방 진행·detail·완료 버튼 분기·주문 취소, 내 계정 카드 6개 + Google 권유, `data-support` 3상태(`chat`·`contact`·`off`)와 나중에 그린 버튼도 같이 보임/숨김, `/support?ctx=` 가 `openChat` 에 맥락 전달(모의 ChannelIO), 6.8 의 금지 낱말 없음, 1440×900·390×844 가로 넘침 없음, 이모지·브라우저 대화상자 없음 |
| 5 | `check:w5` | `panel-rooms.mjs`(Playwright, 모의 API): 로그인 카드 아이디·비밀번호·`KAKA-` 안내, `#rooms` 표와 상태 5종 + `입금 안내` 링크, 확인 필요 행의 `참여코드 입력` → `#room/12` 의 `#r-passcode` 포커스, `#room/12` 직접 열기, 부방장 대기 → 사용 중 전환 시 폼 활성 + 승격 알림, `on_count 0` 안내, 강등 알림, 오류 배너 다시 시도(참여코드, `retry_after` 비활성), 각 방 화면 저장 본문 모양(7.1 키), 가리기 2단계 확인, legacy 아닌 계정에서 개요 4행·팔레트·`G V` 단축키·`#visit` 해시가 모두 막힘, 매크로 없을 때 계정 추가 `.off-note`, 카카오 계정 상한 문구가 `max_accounts`, **390px 에서 `.stepper.s4` 라벨이 잘리지 않음**(`scrollWidth <= clientWidth`), 콘솔에 `channel.io` 스크립트가 없음, `docs/UI_V5.md` 8.3 의 콘솔 검사 18개 항목 회귀(개요 지표는 아래 새 4종 기준) |
| 6 | `check:w6` | `manage-accounts.mjs`(Playwright, 로컬 PG + 작업 2 와 같은 방식의 stub 자식): 회원 목록·상세·기간 추가·차단, 키 옮기기, 봇 등록(가짜 confirm_on_phone, 20초 넘게 걸린 confirm 도 `/v1/status` 로 ok), `bot-register/begin` 에 `w…` id → 400, 닉네임 중복 표시, 방 이동(같은 봇 제외)·해제·rebind·넘기기·금지·확인 후 입장, 충돌 주문 `skip_conflicts` 승인, 이관된 키 `/admin/grant` 409, 입금 이중 매칭 409 |

**`lib/panel-check.js` 변경(작업 5)**: 259~286 줄(`featuresFor`·`panel-ids`·키 로그인 구간·`ownsDevice(s.key` 단언)을 지운다 — 같은 성격의 검사는 작업 1 의 `room-config-check.js` 가 맡는다. `'/panel.css?v=13'`·`'/panel.js?v=16'` 단언을 `v=14`·`v=17` 로. 새 단언: 7.4 의 id 전부, `data-route="rooms"`·`"room"`·`"r-visit"` … 8개, `href="#rooms" data-r="rooms"`, `들낙 감지` 있음·`들낙 방지` 없음, `id="login-id"`·`id="login-pw"`, `/support.js?v=1`, `data-support`, `data-support-mode="link"`, `.stepper.s4` 규칙, panel.html 에 `8개` 없음, panel.js 에 `/panel/api/bot-room/settings`·`/api/auth/login`.

**최종 통합(오케스트레이터, 모든 작업 합친 뒤)** `e2e-flow.mjs`: 실제 `server.js`(로컬 PG, `SENDER_FAKE=1`, 가짜 Google, `ROOM_RETRY_BASE_MS=1000`) →
1. 관리자: 봇 계정 등록(가짜, 이메일에 `phone` → `confirm_on_phone` 4829 → confirm) → `bot_accounts.state='connected'` 확인.
2. 가입 → 미리 보기(`verified:true` 단언) → 매크로만 주문 1건 → 회원 취소.
3. 주문(매크로 1개월 + 방 2개: `normal`(방 관리봇+미니게임), `passroom`(미니게임)) → 입금 웹훅 → 방1 `waiting_host` → `/v1/fake/perm 4` → `active`(승격 안내 문구) → 설정 저장(들낙 감지 `kick`) → `/v1/fake/event join×3` → `room_log churn`+`kick` → 방2 `passcode_needed` → 콘솔 다시 시도(참여코드 `0000`) → `active`(미니게임만) → `!도움` 답 → `kicked` → 다시 시도 → `active`.
4. 다른 회원이 방1 링크로 미리 보기 → `taken`; 방1 봇을 `kicked` 로 만든 뒤 → 다른 회원 미리 보기 `available`.
5. 고객 계정 등록(가짜) → `/v1/grants` 의 `macro_until` 확인 → 관리자 기간 추가 → 기존 키 이관 → 세션 상한.
각 단계 화면을 Playwright 로 1장씩(1440·390).
공개 `/v1` 프록시가 없으므로 시험은 `/v1/fake/*` 를 자식에 직접 부른다: `lib/sender-child.js` 가 자식을 띄울 때마다 표준 출력에 `[sender] listening 127.0.0.1:<port>` 를 찍고(작업 2), 시험은 그 줄에서 포트를 읽어 `x-sender-token` 을 붙여 부른다.

### 9.6 환경변수 (작업 1 이 `render.yaml`·`DEPLOY.md`·`warnEnv` 에 반영)

| 이름 | 기본 | 비고 |
|---|---|---|
| `GOOGLE_CLIENT_ID` `GOOGLE_CLIENT_SECRET` | — | 둘 다 있어야 Google 버튼이 보임 |
| `GOOGLE_REDIRECT_URI` | `PURCHASE_BASE/auth/google/callback` | Google 을 켜면 `PURCHASE_BASE=https://kmacro.cloud` 필수 |
| `GOOGLE_AUTH_URL` `GOOGLE_TOKEN_URL` | Google | 시험 전용 덮어쓰기 |
| `CHANNEL_PLUGIN_KEY` | — | 없으면 상담 버튼이 `CONTACT_INFO` 안내로 바뀌고, 그것도 없으면 숨김(6.10) |
| `CHANNEL_MEMBER_SECRET` | — | hex. 있으면 memberId+memberHash 부팅. **채널 데스크에서 회원 해시(Member Hash) 검증을 먼저 켠 뒤에** 넣는다(8.8). DEPLOY.md 에 순서를 쓰고 `warnEnv` 가 설정될 때마다 알린다 |
| `CONTACT_INFO` | — | 기존. 상담 창이 없을 때 보일 연락처 |
| `MEMBER_MAX_SESSIONS` | 3 | 처음 값. 운영 값은 `app_settings.sessions`(판매 관리 [설정]) |
| `MEMBER_MAX_ACCOUNTS` | 3 | 처음 값. 운영 값은 `app_settings.kakao_accounts` |
| `MEMBER_SESSION_TTL_MS` | 2592000000 | 30일 |
| `AUTH_RESET_WINDOW_MS` | 900000 | |
| `AUTH_SCRYPT_LOG_N` | 15 | |
| `LOGIN_FAIL_MAX` `LOGIN_BLOCK_MS` | 10 / 900000 | `(아이디, IP)` 잠금 |
| `LOGIN_SLOW_AFTER` `LOGIN_SLOW_MS` | 30 / 2000 | 아이디 단독 늦추기 |
| `AUTH_HASH_QUEUE_MAX` | 20 | scrypt 대기열 상한 |
| `MEMBER_MAX_PENDING_ORDERS` `MEMBER_MAX_PENDING_ROOMS` `IP_MAX_PENDING_ORDERS` | 3 / 10 / 10 | D22 |
| `ROOM_RETRY_BASE_MS` | 120000 | 고객 다시 시도 첫 간격(3.4.3) |
| `ROOM_SELF_MOVE_GAP_MS` | 86400000 | 고객 봇 옮기기(다른 방) 설치마다 간격(3.4.3) |
| `ROOM_SELF_REINSTALL_GAP_MS` | 1800000 | 고객 같은 방에 다시 설치 설치마다 간격(3.4.3) |
| `ROOM_HOLD_WORDS` | — | 쉼표 목록. 방 이름이 걸리면 확인 대기(D28) |
| `RATE_AUTH_PER_MIN` `RATE_SIGNUP_PER_MIN` `RATE_OAUTH_PER_MIN` `RATE_PREVIEW_PER_MIN` `RATE_MEMBER_PER_MIN` | 10/5/20/20/180 | |
| `RATE_DEMO_PER_MIN` | 180 | 사이트 체험 `/api/demo*` (3.7) |
| `BOT_ROOM_CAP` | 20 | 새 봇 기본 상한의 처음 값. 운영 값은 `app_settings.bot_room_cap`(저장할 때 등록한 봇 모두에 적용할 수 있음) |
| `BOT_JOIN_GAP_MS` `BOT_PERM_POLL_MS` `BOT_ACTIVE_CHECK_MS` | 45000 / 60000 / 600000 | sender |
| `BOT_JOIN_PER_HOUR` `BOT_JOIN_PER_DAY` `BOT_RESOLVE_PER_MIN` `BOT_RESOLVE_PER_DAY` | 20 / 80 / 10 / 300 | sender, 봇마다(5.3) |
| `BOT_PROFILE_CONVERT` | `off` | 기본 프로필로 들어가 있는 방을 오픈프로필로 바꾸기. `off` = 관리자 버튼만, `auto` = 점검 때 자동(5.8) |
| `BOT_PROFILE_SWITCH_PER_HOUR` `BOT_PROFILE_RETRY_MS` | 6 / 86400000 | 봇마다 시간당 프로필 바꾸기 상한, 거절된 방을 자동으로 다시 바꿔 보기까지 |
| `BOT_PROFILE_BLOCK_STATUS` | `-804` | 오픈프로필 입장 거절로 볼 카카오 status(쉼표 목록, `none` = 없음). 실측 뒤 고친다(10.1 #9) |
| `BOT_PROFILE_READ_MS` `BOT_PROFILE_READ_GAP_MS` `BOT_PROFILE_PUSH_DELAY_MS` | 21600000 / 60000 / 5000 | 오픈프로필 목록 다시 읽기 주기, 다시 읽기 최소 간격, 푸시 뒤 기다림 |
| `ROOM_LOG_KEEP_DAYS` | 30 | |
| `SENDER_TRACE_PUSH` | — | 실측용(오픈프로필 관련 패킷 모양도, 5.3 끝) |
| `SENDER_FAKE` `FAKE_JOIN_MS` `FAKE_KICK_LEFT` | — | **시험 전용** |

DEPLOY.md 의 30,000원 같은 옛 가격 문장(92·130 줄)과 키 중심 설명(15·31·59·106~139 줄)도 작업 1 이 고친다. `RATE_PANEL_LOGIN_PER_MIN` 줄은 "쓰지 않음"으로 표시한다.

---

## 10. 실측 확인과 운영자 확인

### 10.1 출시 전 실측 1회 (봇 계정 2개 + 참여코드 있는 시험 방 1개)

`SENDER_TRACE_PUSH=1` 로 아래를 기록하고 결과에 맞춰 5.3·5.4·7.2 의 상수만 고친다(구조는 바꾸지 않는다).

1. JOININFO `ol` 전체(인원 수 칸 유무), 태블릿 서브 기기에서 JOINLINK 허용 여부.
2. CHECKJOIN 틀린 코드 status, 가득 찬 방·이미 들어간 방·내보내진 뒤 JOINLINK status.
3. JOINLINK 뒤 그 세션이 받는 푸시(SYNCJOIN·SYNCLINKCR), 부방장 지정·해제 때 SYNCMEMT·피드 11/12 모양.
4. MEMBER(self) `mt` 부방장 전후, LINKKICKED 모양, 강퇴 후 재입장 status.
5. 이미 나간 사람에 대한 KICKMEM 결과, KLDELITEM 동작, 부방장의 REWRITE·KICKMEM 권한.
6. 두 봇 계정이 같은 방에서 본 `chat_id`·`li` 가 같은지.
7. 오픈채팅 멤버의 `status_message` 가 오는지, MSG 푸시의 `authorNickname` 유무, 카드 타입 번호(71·17·9 외).
8. 방장 화면의 실제 메뉴 이름(`부방장 관리`, `내보내기 목록`/`내보낸 사람` 등) — 7.9·RoomView `detail`·5.6 `kicked` 문구를 거기에 맞춘다.
9. 오픈프로필(D12, 5.8, `DEPLOY.md` 의 실측 순서): SYNCLINK 응답에서 오픈프로필 항목의 모양(`lt`·`lu` 가 `/me/`·`op`·`olu.nn`·`olu.ptp`, 1:1 오픈채팅 링크와 구분되는지), `JOINLINK ptp:16 + pli` 의 status·`olu`(`ptp:16`, `pli`, `nn`, `userId` = 봇), 기본 프로필 참여를 막은 방(`ol.pv & 32 == 0`)과 연 방 모두에서 오픈프로필로 입장되는지(32 비트의 뜻), 거절될 때의 status(→ `BOT_PROFILE_BLOCK_STATUS`), `UPLINKPROF` 의 status·`olu`·부방장 권한 유지·방에 보이는 변경 알림, 오픈프로필을 지우면 들어가 있는 방이 어떻게 되는지, 한 계정이 가질 수 있는 오픈프로필 수.
10. KICKOUT 본문의 `reason` 값(다른 기기 로그인 0, 서버 변경 -2)과 agent-messenger 패치 뒤 세션 이벤트에 실리는지.
11. 내보내진 뒤 JOINLINK 가 -815 인지 다른 값인지(5.3 6 매핑), CHATONROOM 응답에 `olu.lmt` 가 오는지(D13).

### 10.2 운영자에게 확인할 것 (기본값으로 구현하고 나중에 바꿀 수 있게)

- 동시 로그인 기기 3대, 회원당 카카오 계정 3개, 봇당 방 20개.
- 방 기록 30일 보존(그 뒤 자동 삭제).
- 고객이 설치를 다른 방으로 옮길 수 없음(관리자만, 방이 삭제된 경우).
- 봇 계정이 끊겼을 때 자동 이동하지 않음.
- 매크로 만료 뒤 고객 계정 연결을 끊음(주요 알림도 멈춤).
- "채널 웍스" = 채널톡(channel.io) 으로 해석함. 채널톡 플러그인 키(`CHANNEL_PLUGIN_KEY`)와, 회원 식별을 쓸 경우 회원 해시 비밀·데스크 설정.
- 봇 계정 닉네임(봇마다 달라야 함, 예 `K bot 1`·`K bot 2`).
- 설치 이용 조건 문구(6.6 `#terms`: 금지 용도, 설치 해제 시 환불 여부)와 `ROOM_HOLD_WORDS` 목록을 쓸지.
- 확인하지 못한 링크(D10)가 설치 불가로 밝혀졌을 때와, 같은 방을 두 회원이 입금해 늦은 쪽이 밀렸을 때(D9)의 환불 방식(운영자 계좌 이체 기준).
- 남이 먼저 산 방의 방장이 넘겨받기를 원할 때 상담에서 무엇으로 방장임을 확인할지(관리자 `room-transfer` 전).
- 미입금 주문 상한(회원 3건·방 줄 10개·IP 10건)과 고객 다시 시도 상한(연속 10번 뒤 관리자만).

---

## 부록 A. 사이트 문구 표 (작업 4, 줄 번호는 `9db383a`)

`data-manual` 이 있는 자리는 두 변형을 다 바꾼다(자동 확인이 꺼졌을 때 app.js `applyAutoCopy` 가 `data-manual` 값으로 바꿔 끼운다). `{…}` 는 `/api/price` 로 채우는 값(`data-bind="price-macro"`·`"price-roombot"`·`"price-minigame"`).

### A.1 `index.html`

| 줄·자리 | 지금 (요약) | 바꿀 문구 |
|---|---|---|
| 7 `meta description` | 카카오톡 자동발송 매크로 · 대화방 관리봇 · 미니게임봇. K bot 1개월 하나로… | K bot은 카카오톡 오픈채팅방 매크로와 방 관리봇·미니게임봇을 제공합니다. 매크로는 내 카카오 계정으로 발송하고, 방 관리봇과 미니게임봇은 K bot 계정이 방에 들어가 동작합니다. |
| 9 `og:description` | 여러 카카오 계정을… K bot 1개월 하나에… | 카카오톡 매크로는 1개월 15,000원, 방 관리봇과 미니게임봇은 방 1개 10,000원입니다. 회원 계정으로 구매하고 웹 콘솔에서 설정합니다. |
| 66 상단 `내 키` | `/my` 버튼 | 지운다(6.2 의 상단 바로 바꿈) |
| 75 kicker | 라이선스 키 1개 · 카카오 계정 최대 8개 | `<span>상품 3종</span><span class="sep" aria-hidden="true"></span><span>회원 계정</span>` |
| 76 h1 | 여러 카카오 계정을 / 하나의 콘솔에서 운영합니다 | `카카오톡 오픈채팅방을<br><span class="dim">하나의 콘솔에서</span> 운영합니다` |
| 77 lead | …를 계정마다 설정합니다… | 카카오톡 매크로는 내 카카오 계정으로 홍보 발송·갠톡 응답·저격 규칙을 실행합니다. 방 관리봇과 미니게임봇은 K bot 계정이 오픈채팅방에 들어가 입장·퇴장 로그, 들낙 감지, 홍보 금지, 가리기, 미니게임을 맡습니다. |
| 81 hero-note | 키가 자동 발급됩니다 / (manual) 관리자가 키를 발급합니다 | 무통장 입금 · 입금 후 통상 1~2분 안에 회원 계정에 적용됩니다 / (manual) 무통장 입금 · 입금 확인 후 관리자가 회원 계정에 적용합니다 |
| 164 기능 h2 | 운영에 필요한 기능을 / 계정마다 따로 설정합니다 | `운영에 필요한 기능을<br>한 콘솔에서 설정합니다` |
| 165 기능 desc | 설정은 계정 단위로 저장되며… | 매크로 설정은 등록한 카카오 계정 단위로, 방 관리봇과 미니게임봇 설정은 설치한 방 단위로 저장합니다. 주요 알림은 등록한 모든 카카오 계정의 갠톡을 한 목록으로 보여 줍니다. |
| 기능 탐색 `data-crumb` | `전체 계정 / 주요 알림`, `a@kakao.com / …` 8개 | 주요 알림 `내 카카오 계정 / 주요 알림`. 매크로·갠톡 응답·저격 규칙은 `a@kakao.com / …` 그대로. 입장·퇴장 로그·프로필 로그·올킥 방지·금지어 검열은 `동네모임 / …`(방 이름) |
| 기능 탐색 설명 | 입장·퇴장 로그·프로필 로그·금지어 검열 | 입장·퇴장 로그 `K bot 계정이 누가 언제 들어오고 나갔는지 기록하고 방에 안내합니다. 들낙 감지와 나간 사람 내보내기도 설정합니다.` · 프로필 로그 `닉네임과 오픈프로필 변경을 기록하고, 방에서 기록을 조회합니다.` · 금지어 검열 `기본 욕설, 추가 금지어(최대 300개), 링크가 들어간 글을 가리고, 최근 글을 한꺼번에 가립니다.` (나머지 그대로) |
| 197 동작 방식 h2 | 휴대폰은 계정을 등록할 때만 필요합니다 | 그대로 |
| 198 동작 방식 desc | …계정마다 켠 기능을 실행합니다… | 카카오톡 매크로는 내 카카오 계정을 등록하면 K bot 서버가 접속을 유지하며 발송합니다. 방 관리봇과 미니게임봇은 K bot 계정이 방에 들어가 동작하므로 등록할 계정이 없습니다. 콘솔은 PC와 휴대폰 브라우저에서 엽니다. |
| 212·233 구조도 `<text>` | 설정은 계정마다 따로 저장 | 설정은 계정·방 단위로 저장 |
| 251 단계 1 | 구매 신청 · …키가 발급됩니다 / (manual) …키를 발급합니다 | `<b>구매 신청</b>` 회원가입 후 상품을 고르고, 방 상품은 오픈채팅방 링크를 붙여 넣습니다. 표시된 금액을 뒷자리까지 입금하면 `<span data-manual="관리자가 입금을 확인한 후 회원 계정에 적용합니다.">통상 1~2분 안에 회원 계정에 적용됩니다.</span>` |
| 252 단계 2 | 계정 등록 · 발급된 키로 콘솔에 로그인한 후… | `<b>계정 등록 · 방 입장</b>` 카카오톡 매크로는 콘솔에서 카카오 계정을 입력하고 휴대폰 카카오톡에 표시된 입력란에 번호를 입력합니다. 방 상품은 K bot 계정이 방에 입장합니다. (who `콘솔 · 휴대폰`) |
| 253 단계 3 | 기능 켜기 · 계정마다… | `<b>기능 켜기</b>` 매크로는 등록한 계정별로 켭니다. 방 관리봇은 방장이 K bot 계정을 부방장으로 지정한 뒤 방별로 켜고, 미니게임봇은 입장하면 바로 동작합니다. |
| 259 가격 h2 | 요금제는 하나이며 / 모든 기능이 포함됩니다 | `매크로는 기간제,<br>방 상품은 방마다 한 번` |
| 261 가격 desc | 기능별 구매 없이 K bot 1개월 하나로… | 카카오톡 매크로는 1개월 단위로 구매하고, 방 관리봇과 미니게임봇은 설치할 방마다 한 번 구매하면 기간 제한 없이 사용합니다. |
| 264-272 가격 대체 마크업 | K bot 1개월 카드 + 포함 카드 3개 | `.prods` 행 3개(app.js 가 `/api/price` 로 다시 그림): `카카오톡 매크로` `{price-macro}원 / 1개월(30일)` · desc `/api/price` 의 desc · bul `카카오 계정 최대 3개`·`다시 구매하면 만료일 뒤로 연장`; `방 관리봇` `{price-roombot}원 / 방 1개 · 기간 제한 없음` · bul `방장이 K bot 계정을 부방장으로 지정하면 동작`; `미니게임봇` `{price-minigame}원 / 방 1개 · 기간 제한 없음` · bul `입장하면 바로 동작` |
| 277 가격 aside note | 사용 중인 키가 있으면 기존 키를 입력하십시오… | 기존 라이선스 키는 회원가입 후 내 계정에서 등록하면 남은 기간이 회원 계정으로 옮겨집니다. |
| 286 FAQ desc | 그 밖의 문의는 구매 신청 시 남긴 연락처로 안내합니다. | 그 밖의 궁금한 점은 문의하십시오. + `<button type="button" class="btn sm" data-support>문의하기</button>` |
| fa1 | …키가 발급됩니다… 그 키로 콘솔에 로그인하면… | 대부분 바로 사용합니다. 주문 때 안내된 **정확한 금액**(뒷자리까지)을 입금하면 `<span data-manual="관리자 확인 후">통상 1~2분 안에 자동으로</span>` 상품이 회원 계정에 적용됩니다. 카카오톡 매크로는 콘솔에서 카카오 계정을 등록하면 바로 발송하고, 방 상품은 K bot 계정이 방에 입장한 뒤 동작합니다. 입금 금액이 다르거나 같은 금액의 대기 주문이 겹치면 관리자가 확인하며, 수 시간이 걸릴 수 있습니다. |
| fq2·fa2 | 키 1개로 카카오 계정을 몇 개까지… 최대 8개… 계정마다… | Q `카카오 계정은 몇 개까지 등록합니까?` A 카카오톡 매크로를 이용하는 동안 회원 1명당 3개까지 등록합니다. 설정과 기록은 등록한 계정별로 저장되고, 주요 알림은 등록한 모든 계정의 1:1 대화를 한 목록으로 보여 줍니다. 답장은 그 대화를 받은 계정으로 발송됩니다. |
| fa4 | 선택한 방에… 기록은 두 기능을 켠 방에서만… | 방 관리봇을 설치한 방에 누군가 들어오거나 나가면 K bot이 **[입장 안내]** 또는 **[퇴장 안내]**를 보냅니다. 그 사람을 한 번 멘션하고, 오픈프로필 링크와 시각을 적습니다. 프로필 기록을 켜면 닉네임이나 오픈프로필을 바꾼 사람이 있을 때 방에 **[프로필 변경 감지]** 안내가 올라갑니다. K bot이 부방장일 때 동작합니다. |
| fa5 | …계정마다 설정합니다… | 막지 않습니다. 정해진 시간 안에 정해진 수 이상 강퇴가 일어나면 올킥으로 감지하여 기록합니다. 감지 시간(5~300초)과 강퇴 수(3~30건)는 방별로 설정합니다. 강퇴된 사람을 다시 초대하지 않습니다. |
| fa6 | 이 계정이… 최대 200개… 사람을 내보내지 않습니다. | K bot 계정이 그 방의 부방장일 때 동작합니다. 기본 욕설 목록과 직접 추가한 단어(최대 300개, 단어당 30자), 선택 시 링크가 들어간 글을 가립니다. 방장과 부방장이 올린 글은 가리지 않습니다. 방 관리봇은 들낙 감지·나갔을 때 내보내기·홍보 금지에서 내보내기를 켠 경우에만 사람을 내보내며, 방장·부방장·제외할 사람은 내보내지 않습니다. |
| fq8·fa8 | 키 1개로 여러 곳에서… 같은 키로… | Q `여러 기기에서 콘솔에 들어갈 수 있습니까?` A 들어갈 수 있습니다. 콘솔 로그인은 기기에 묶이지 않으며, 회원 아이디로 동시에 기기 3대까지 로그인합니다. 4번째 기기에서 로그인하면 가장 오래 쓰지 않은 기기가 로그아웃됩니다. 비밀번호를 다른 사람과 공유하지 마십시오. |
| fa9 | K bot 1개월 하나입니다… 기능별 구매는 없습니다… 첫 로그인부터… | 상품은 3종입니다. **카카오톡 매크로**는 1개월(30일) `{price-macro}`원, **방 관리봇**과 **미니게임봇**은 방 1개에 각 `{price-roombot}`원·`{price-minigame}`원이며 기간 제한이 없습니다. 한 방에 두 상품을 함께 설치할 수 있습니다. 매크로 기간은 입금이 확인된 시점부터 시작됩니다. |
| fa10 | 기존 키 항목에… 내 키 조회 화면의… | 카카오톡 매크로를 다시 구매하면 지금 만료일 뒤로 30일씩 이어집니다. 이미 만료된 경우 입금이 확인된 시점부터 다시 계산됩니다. 방 관리봇과 미니게임봇은 기간이 없어 연장하지 않습니다. 기존 라이선스 키는 회원가입 후 내 계정에서 등록하면 남은 기간이 회원 계정으로 옮겨집니다. |
| fa12 | …쿨타임(0~168시간)을 계정마다 설정합니다… | `계정마다` → `계정별로` (나머지 그대로) |
| fa14 | 키 발급 전에는… 관리자에게… | 입금 전에는 내 계정의 구매 내역에서 주문을 취소할 수 있습니다. 입금이 확인된 뒤에는 취소가 제한됩니다. 문의하기로 주문번호와 상황을 전달하여 협의하십시오. |
| 새 fq15·fa15 (`data-c="buy"`) | — | Q `K bot 계정은 언제 방에 입장합니까?` A 입금이 확인되면 순서대로 입장합니다. 보통 몇 분 안에 입장하며, 카카오 입장 제한이 걸리면 몇 시간이 걸릴 수 있습니다. 진행 상태는 콘솔의 내 방에서 확인합니다. |
| 새 fq16·fa16 (`data-c="console"`) | — | Q `방 관리봇은 언제부터 동작합니까?` A K bot 계정이 방에 입장한 뒤 방장이 그 계정을 부방장으로 지정하면 1~2분 안에 자동으로 감지합니다. 그 뒤 콘솔의 내 방에서 기능을 켭니다. 부방장이 해제되면 다시 지정할 때까지 방 관리 기능을 멈추고, 미니게임은 계속 동작합니다. |
| 356 CTA h2 | 키 하나로 / 계정 여러 개를 운영합니다 | `회원가입 후<br>바로 구매할 수 있습니다` · 버튼 `회원가입`(primary, `/signup?next=/buy`)·`구매 신청`(`/buy`) |
| 366 bankLine | (manual) 관리자 확인 후 키가 발급됩니다 | 일반 그대로 / (manual) 입금은 무통장 계좌이체 · 관리자 확인 후 회원 계정에 적용됩니다 |
| 369 바닥글 | 구매 신청 · 내 키 조회 · 주문 조회 · 콘솔 | 6.2 바닥글 |

### A.2 `buy.html`

| 줄·자리 | 바꿀 문구 |
|---|---|
| 65 상단 `내 키` | 지운다(6.2) |
| 76 h1 | `상품을 고르고 신청합니다` |
| 77 lead | 접수하면 주문번호와 입금 계좌가 바로 표시됩니다. `<span data-manual="안내된 &lt;b&gt;정확한 금액&lt;/b&gt;을 입금하면 관리자가 확인한 뒤 회원 계정에 적용합니다.">안내된 <b>정확한 금액</b>을 입금하면 통상 1~2분 안에 회원 계정에 적용됩니다.</span>` |
| 95·100-102 상품 hint·기존 키 칸 | 지운다(6.6 의 폼으로 바뀜). 기존 키 안내는 `.hint` `기존 라이선스 키는 내 계정에서 등록합니다.` 한 줄 |
| 128 aside note | 수집된 정보는 입금 확인과 상품 적용에만 사용됩니다. K bot은 카드번호를 요구하지 않으며, 카카오 비밀번호는 콘솔의 카카오 계정 등록 화면에서만 입력합니다. 그 밖의 곳에서 이 정보를 요구하는 연락에는 응하지 마십시오. |
| 141 바닥글 | 6.2 바닥글 |

### A.3 `order.html`

| 줄·자리 | 바꿀 문구 |
|---|---|
| 65 상단 `내 키` | 지운다(6.2) |
| 77 lead | 6.7 의 리드 |
| 95 오른쪽 note | 6.7 표의 `order.html 오른쪽 .note.dim` 두 변형(HTML 기본은 회원 주문 문구. 예전 키 주문을 열면 app.js 가 지금 문구로 바꿔 끼운다) |
| 107 바닥글 | 6.2 바닥글 |

## 부록 B. 채널톡 공식 로더 (support.js 에 그대로)

`@channel.io/channel-web-sdk-loader@2.0.2` 의 `loadScript()` 와 같은 코드다. support.js 는 이 함수를 정의해 두고 6.10 의 3 에서 한 번 부른 뒤 `ChannelIO('boot', …)` 를 부른다(부팅 호출은 SDK 가 뜨기 전에도 대기열에 쌓인다).

```js
function loadChannelIO() {
  var w = window;
  if (w.ChannelIO) return;
  var ch = function () { ch.c(arguments); };
  ch.q = [];
  ch.c = function (args) { ch.q.push(args); };
  w.ChannelIO = ch;
  function l() {
    if (w.ChannelIOInitialized) return;
    w.ChannelIOInitialized = true;
    var s = document.createElement('script');
    s.type = 'text/javascript';
    s.async = true;
    s.src = 'https://cdn.channel.io/plugin/ch-plugin-web.js';
    var x = document.getElementsByTagName('script')[0];
    if (x && x.parentNode) x.parentNode.insertBefore(s, x);
    else document.head.appendChild(s);
  }
  if (document.readyState === 'complete') l();
  else { w.addEventListener('DOMContentLoaded', l); w.addEventListener('load', l); }
}
```

부팅 옵션(`ChannelIO('boot', opts, cb)`): `pluginKey`(필수), `memberId`·`memberHash`(서버가 준 경우만), `profile: {name: login_id}`(로그인한 경우만), `language: 'ko'`, `appearance: 'dark'`, `hideChannelButtonOnBoot: true`. 상담 창 열기: `ChannelIO('openChat', undefined, 미리 채울 글)`. 끄기: `ChannelIO('shutdown')`.

### 부록 · 받은 갠톡 화면과 빠른 답장

- 목록: 사람마다 정해진 색의 동그라미(이름의 첫 한글·영문·숫자·한자, 없으면 사람 아이콘 — 이모지로 시작하는 이름도 글자를 찾는다), 이름 · 받은 계정 꼬리표(계정 색 점 + 전화번호 끝 4자리 또는 아이디) · 시각 / 미리 보기 · 안 읽음 배지 두 줄. 계정 칩은 `010-1234-5678` 모양. 대화는 같은 사람의 이어진 글을 묶고(첫 글에만 동그라미), 내가 보낸 글은 파란 말풍선.
- 빠른 답장: 입력창 위 버튼 줄. 누르면 적어 둔 글을 열린 대화에 바로 보낸다(`/panel/api/chat/send`, 입력창에 쓰던 글은 그대로). `편집`에서 버튼 이름(16자)·메시지(1,000자)를 추가·수정·삭제·순서 바꾸기, 최대 12개. 회원마다 `members.quick_replies`(JSONB, NULL = 저장한 적 없음 → 예시 3개) 에 저장(`GET`·`POST /panel/api/quick-replies`, 검사 `lib/quick-replies.js`, 점검 `lib/quick-replies-check.js`). 모든 계정의 갠톡에서 같이 쓴다.

### 부록 · 무료 회원(members.comp)

- 관리자가 `/manage` 회원 상세에서 [무료 회원 켜기·끄기](`POST /admin/member-comp {id, on}`, 감사 기록). 켜면 결제 없이 모든 기능: 카카오톡 매크로는 만료를 2100-01-01 로 본다(`entitle.macroUntilOf` — 실제 `macro_until` 은 그대로라 끄면 원래 기간으로), 회원 콘솔 [내 방]의 [봇 구매] 자리에 [방 추가]가 생겨 방 관리봇·미니게임봇을 바로 넣는다(`POST /panel/api/bot-room/free-add` → `installs.grantRoom`, 관리자 [봇 무료 설치]와 같다). 차단 회원은 무료 회원이어도 막힌다.
- 표시: 콘솔 사이드바 `무료 회원 · 기간 제한 없음`, /account 상품 칸 같은 문구, 관리자 회원 목록 `무료 회원 · 모든 기능`.
- 처음 배포 때 `mjl870` 을 한 번 켠다(`comp IS NULL` 일 때만 — 관리자가 끄면 다시 켜지지 않는다). 점검 `lib/comp-check.js`.
