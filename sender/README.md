# 카카오 발송 자식

라이선스 서버(`server.js`)가 이 프로세스를 자식으로 띄웁니다. 별도 유료 웹 서비스는 없습니다. 자식이 예외로 죽거나 종료되면 부모는 `/health`, 회원·구매 사이트, 콘솔을 유지한 채 자식을 다시 띄웁니다. 셀프핑은 부모에 있습니다. Render 인스턴스 전체가 메모리 부족으로 죽는 것은 막지 못합니다.

이 프로세스가 `agent-messenger` 로 하는 일은 두 가지입니다. 기준 문서는 `docs/ACCOUNTS_V1.md` 입니다(5장 sender, 7장 방 관리 기능, 9.4 가짜 모드).

- **카카오톡 매크로(고객 계정)**: 회원이 콘솔에 등록한 자기 카카오 계정으로 주기 발송, 이미지 첨부, 갠톡 자동응답, 저격 규칙을 보냅니다. 회원당 계정 3개까지입니다. 인증번호만 폰의 카카오톡에 입력하고, 그 뒤에는 이 프로세스의 세션이 보냅니다.
- **방 관리봇·미니게임봇(K bot 계정)**: 운영자가 `/manage` 에 등록한 봇 카카오 계정(`bot.<16hex>`)이 고객이 산 오픈채팅방(`room_installs`)에 스스로 들어갑니다. 방 관리봇은 방장이 그 봇을 부방장으로 지정하면 1~2분 안에 감지해 동작하고, 미니게임봇은 들어가자마자 동작합니다.

## 권리(누가 무엇을 쓰는가)

고객 계정의 권리는 부모가 `/v1/grants` 로 미는 값만 믿습니다(`kakao_sessions.features` v2).

```json
{ "v": 2, "macro_until": 1767225600000, "legacy_room_until": 0, "grants_at": 1767000000000, "reg_at": 1766000000000 }
```

- `macro_until` 이 지나면 그 계정의 연결을 끊습니다(기록은 남깁니다). 다시 사면 부모가 새 값을 밀고, 그때 다시 붙습니다. 60초마다 만료를 스스로 판정하므로 밀기를 놓쳐도 만료는 정확합니다.
- `legacy_room_until` 은 예전 키에서 이관한 회원의 계정 단위 옛 기능(입장·퇴장 로그, 프로필 로그, 올킥 방지, 금지어 검열) 유예 기간입니다.
- 새로 등록한 계정의 기본 권리는 거부(`macro_until:0`)입니다. 부모가 등록 직후 실제 값을 밉니다.
- `features` 에 `v` 가 없는 예전 기록은 첫 `/v1/grants` 전까지 예전처럼 동작합니다. 부모는 자식이 뜰 때마다 전체(`full:true`)를 밀고, 그때 목록에 없는 고객 기록은 권리 없음으로 바뀌어 멈춥니다.

## K bot 계정과 방 설치

- 입장은 봇마다 한 줄로 처리합니다. 나가기(`room_leaves`)를 먼저, 입장을 나중에 하고, 입장 사이에 `BOT_JOIN_GAP_MS`(±20%)를 둡니다. 입장 패킷(JOININFO·CHECKJOIN·JOINLINK)은 같은 세션에 한 번만 보내고, 입장이 실패해도 봇 클라이언트를 닫았다 열지 않습니다. 같은 봇의 다른 방이 끊기지 않게 하기 위해서입니다.
- 봇마다 입장·조회 예산이 있습니다. 예산이 없으면 그 방은 `입장 중` 으로 남고 예산이 돌아오는 시각에 다시 시도합니다. 카카오가 서버 IP 의 입장을 막으면(-444) 봇을 내리지 않고 모든 봇의 입장과 조회를 잠시 멈춥니다.
- 방 상태(`queued → joining → waiting_host → active`, 또는 `error` + `error_code`)는 이 프로세스가 `room_installs` 에 씁니다. 부모가 쓴 칸은 건드리지 않고, 늘 `phase='installed'` 이고 그 봇이 맡은 행에만 씁니다.
- 방 관리 기능(입장·퇴장 로그, 들낙 감지, 나갔을 때 내보내기, 프로필 로그, 홍보 금지, 가리기, 금지어 검열, 올킥 방지)은 방 관리봇을 산 방에서 봇이 부방장일 때만 동작합니다. 미니게임은 미니게임봇을 산 방에서 부방장 지정과 관계없이 동작합니다.
- 방장·부방장·봇·제외할 사람은 내보내지 않고, 이름만으로는 내보내지 않습니다. 모든 내보내기는 `room_log` 에 남고, K bot 이 내보낸 사람만 콘솔에서 해제할 수 있습니다.
- 방마다 발송 6/분, 봇 전체 30/분 안에서 방을 돌아가며 보냅니다. 한 방이 몰려도 다른 방이 밀리지 않습니다.
- 방별 실행 상태는 `room_state`, 조치 기록은 `room_log` 에 둡니다. `room_state`·`room_log` 표는 이 프로세스도 만듭니다(겹쳐도 안전). `room_installs`·`bot_accounts`·`room_leaves`·`room_blocklist` 는 부모가 만듭니다.

## 내부 API

부모만 `127.0.0.1` 로 부릅니다(`lib/sender-child.js` `call()`). 공개 `/v1/*` 프록시는 없습니다. 모든 경로에 `x-sender-token` 이 필요하고, 틀리면 401 입니다.

| 경로 | 쓰임 |
|---|---|
| `POST /v1/register/begin·confirm·cancel`, `POST /v1/unlink`, `GET /v1/status` | 고객 계정과 K bot 계정 등록(봇은 `bot.` device_id) |
| `GET /v1/snapshot·chats·recent·inbox·thread·logs`, `POST /v1/send·send-images·config·session` | 콘솔의 고객 계정 화면. `bot.` 에는 404 |
| `POST /v1/grants` | 고객 계정 권리 밀기(`full:true` 면 전체) |
| `POST /v1/bot/resolve` | 오픈채팅 링크 조회(구매 화면 미리 보기) |
| `POST /v1/bot/sync` | 설치·나가기 대기열을 DB 에서 다시 읽기 |
| `GET /v1/bot/status·room·logs·people`, `POST·GET /v1/bot/hide`, `POST /v1/bot/unkick·games-reset` | 콘솔·관리 화면의 방 관리 |

## 가짜 모드(시험 전용)

`SENDER_FAKE=1` 이면 카카오에 붙지 않고 `src/fake.mjs` 의 가짜 연결을 씁니다. 패킷을 만들고 판정하는 코드는 진짜와 같습니다. 링크 코드에 든 낱말(`gone`·`dm`·`pass`·`noprof`·`noanon`·`full`·`rate`·`ipblock`·`weird`·`lost`)로 방의 반응을 정하고, `/v1/fake/perm`·`/v1/fake/event` 로 부방장 지정·내보내짐·입장·메시지 같은 푸시를 넣습니다. **운영에서 켜지 않습니다.**

## 보이스룸 유지(B층)

`SENDER_VOICE_KEEP=1` 이면 한 번 켠 보이스룸을 봇이 꺼지지 않게 지킵니다. 계산은 `src/voice-keep.mjs`(순수 함수, 시계·네트워크를 모릅니다), 신호는 `botpool.mjs` 의 `voiceSetMeta`(SETMETA type 16)가 보냅니다.

* **켜기** 방장·부방장이 방에서 「`!보룸유지`」(기본 48시간) 또는 「`!보룸유지 2`」(2시간)·「`!보룸유지 30분`」. 관리 쪽에서는 `POST /v1/bot/voice-keep { install_id | chat_id | li, hours? }`.
* **유지** 켜 둔 동안 `SENDER_VOICE_KEEP_REFRESH_MS`(기본 4분)마다 같은 `callId`·`startTime` 으로 `updateTime` 만 올려 다시 알립니다.
* **복구** 방 메타 푸시(`CHGMETA`)로 `liveon:false` 를 보거나 봇이 다시 접속하면 새 `callId` 로 다시 켭니다. 다시 켠 횟수는 상태 줄에 남습니다.
* **물러남** 사람(방장·부방장)이 보이스룸을 닫은 것은 따라 끕니다 — 다시 여는 싸움을 하지 않습니다(`SENDER_VOICE_KEEP_YIELD=0` 이면 다시 켭니다). 남이 연 보이스룸은 그 `callId` 를 들고 함께 지킵니다.
* **끝** 유지 시간이 다 되면 끄는 신호를 보내고 스스로 끝냅니다. 연속 실패가 `SENDER_VOICE_KEEP_FAILS`(기본 8)를 넘으면 포기하고, 방을 잃으면(내보내짐·나감·해지) 바로 끝냅니다. 속도 제한(-312·-805·-819)에는 길게 쉽니다.
* **끄기·보기** 「`!보룸유지끄기`」, 「`!보룸유지?`」(상태 줄). 관리 쪽에서는 같은 주소에 `{ on: false }`·`{ status: true }`.

상태는 방마다 `room_state.runtime.voice` 에 저장돼 sender 가 다시 켜져도 이어서 지키고, 켜기·복구·포기·끝은 `room_log` 의 `voice_keep` 줄로 남습니다. 음성 미디어 세션(VCS)과 서버 할당은 아직 없어, 지금은 보이스룸 **신호**(배너)를 지키는 층까지입니다.

## 환경 변수

라이선스 서비스 하나에 넣습니다. 값은 저장소에 적지 않습니다.

| 이름 | 필수 | 설명 |
|---|---|---|
| `DATABASE_URL` | 예 | 라이선스 서버와 같은 Neon 연결 문자열 |
| `SENDER_TOKEN` | 예 | 부모와 자식이 같은 값을 씁니다(내부 API 인증) |
| `SENDER_KEY` | 예 | 카카오 토큰 봉인 키. 64자 hex 또는 긴 비밀 |
| `CONFIG_SECRET` | 예 | 방 참여코드 봉인 키(부모와 같은 값). 없으면 참여코드가 필요한 방에 들어가지 못합니다 |
| `BOT_JOIN_GAP_MS` | 아니오 | 봇마다 입장 사이 간격. 기본 45000 |
| `BOT_PERM_POLL_MS` | 아니오 | 부방장 대기 방의 권한 확인 간격. 기본 60000(±15초) |
| `BOT_ACTIVE_CHECK_MS` | 아니오 | 사용 중인 방의 생존 확인 간격. 기본 600000 |
| `BOT_JOIN_PER_HOUR`·`BOT_JOIN_PER_DAY` | 아니오 | 봇마다 입장 예산. 기본 20·80 |
| `BOT_RESOLVE_PER_MIN`·`BOT_RESOLVE_PER_DAY` | 아니오 | 봇마다 링크 조회 예산. 기본 10·300 |
| `SENDER_TRACE_PUSH` | 아니오 | `1` 이면 처음 보는 푸시마다 본문 키를 한 번 로그로 남깁니다(실측용) |
| `SENDER_VOICE_KEEP` | 아니오 | `1` 이면 보이스룸 유지(아래 절)를 켭니다. `SENDER_VOICE_EXPERIMENT=1` 도 같이 켭니다 |
| `SENDER_VOICE_KEEP_MS`·`SENDER_VOICE_KEEP_MAX_MS` | 아니오 | 유지 시간 기본값·최대값. 기본 48시간 |
| `SENDER_VOICE_KEEP_REFRESH_MS` | 아니오 | 다시 알리는 주기. 기본 240000(4분) |
| `SENDER_VOICE_KEEP_RECOVER_MS`·`SENDER_VOICE_KEEP_GRACE_MS` | 아니오 | 꺼진 것을 본 뒤·다시 접속한 뒤 다시 켜기까지. 기본 3000·20000 |
| `SENDER_VOICE_KEEP_FAILS`·`SENDER_VOICE_KEEP_RATE_MS` | 아니오 | 연속 실패 포기 횟수·속도 제한 뒤 쉼. 기본 8·600000 |
| `SENDER_VOICE_KEEP_YIELD` | 아니오 | `0` 이면 사람이 보이스룸을 닫아도 다시 켭니다(기본은 따라 끕니다) |
| `SENDER_VOICE_CS_IP`·`SENDER_VOICE_CS_IP6`·`SENDER_VOICE_CS_PORT` | 아니오 | 보이스룸 메타에 넣는 음성 서버 값(실측 캡처가 기본) |
| `SENDER_VOICE_EXPERIMENT`·`SENDER_TRACE_VOICE` | 아니오 | 보이스룸 실험(신호·명령어 찾기)과 보이스룸 신호만 남기는 로그 |
| `SENDER_FAKE`·`FAKE_JOIN_MS`·`FAKE_KICK_LEFT`·`FAKE_STATE_FILE`·`FAKE_CONFIRM_MS` | 아니오 | 시험 전용 가짜 모드 |
| `BOT_RATE_WAIT_MS`·`BOT_IP_WAIT_MS`·`BOT_RECONCILE_MS`·`BOT_PERM_PUSH_DELAY_MS`·`BOT_HIDE_GAP_MS` | 아니오 | 시험 전용 간격 조정(쉼표 목록 또는 ms). 운영에서는 비워 둡니다 |
