// voiceroom.mjs 자체 점검 — 명령어 읽기·48시간 수명·연장·여러 방·저장본 되살리기·callId 정밀도.
import * as V from './voiceroom.mjs'

function eq(got, want, what) {
  if (got !== want) throw new Error(`${what}: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`)
}
function ok(cond, what) { if (!cond) throw new Error(what) }

// ── 명령어 ───────────────────────────────────────────────────────────────
eq(V.parseVoiceCommand('!보룸켜기', '!').cmd, 'on', '보룸켜기')
eq(V.parseVoiceCommand('!보이스룸켜기', '!').cmd, 'on', '보이스룸켜기')
eq(V.parseVoiceCommand('!보룸 켜기', '!').cmd, 'on', '띄어쓰기')
eq(V.parseVoiceCommand('!보룸시작', '!').cmd, 'on', '보룸시작')
eq(V.parseVoiceCommand('!보룸켜기 야간 수다방', '!').title, '야간 수다방', '제목')
eq(V.parseVoiceCommand('!보룸끄기', '!').cmd, 'off', '보룸끄기')
eq(V.parseVoiceCommand('!보룸종료', '!').cmd, 'off', '보룸종료')
eq(V.parseVoiceCommand('!보룸', '!').cmd, 'status', '상태')
eq(V.parseVoiceCommand('!보룸상태', '!').cmd, 'status', '보룸상태')
eq(V.parseVoiceCommand('!보룸이상한말', '!'), null, '모르는 꼬리는 넘긴다')
eq(V.parseVoiceCommand('보룸켜기', '!'), null, '접두사 없음')
eq(V.parseVoiceCommand('!검강화', '!'), null, '다른 명령어')
eq(V.parseVoiceCommand('/보룸켜기', '/').cmd, 'on', '다른 접두사')

// ── LIVE_TALK_INFO 본문: callId 정밀도(17자리)를 잃지 않는다 ─────────────
const callId = V.newCallId(1760000000, 0.123456)
eq(callId.length, 17, 'callId 17자리')
ok(!Number.isSafeInteger(Number(callId)), 'callId 는 2^53 을 넘는다(문자열로만 다뤄야 한다)')
const content = V.onContent({ title: '수다방', startSec: 1760000000, nowSec: 1760000300, callId })
ok(content.includes('"callId":' + callId), '본문에 callId 가 글자 그대로 들어간다')
ok(content.includes('"startTime":1760000000'), 'startTime 은 켠 시각')
ok(content.includes('"updateTime":1760000300'), 'updateTime 은 지금(연장)')
ok(content.includes('"liveon":true'), 'liveon')
eq(V.offContent(), '{"liveon":false}', '끄기 본문')
// 줄바꿈·따옴표가 든 제목도 본문을 깨지 않는다
const nasty = V.onContent({ title: 'a"b\nc', startSec: 1, nowSec: 1, callId: '12' })
ok(/"title":"a\\"b c"/.test(nasty), '제목은 한 줄로 따옴표를 막는다')
JSON.parse(nasty) // 모양이 깨지면 여기서 던진다

// ── 카카오가 준 메타 읽기 ────────────────────────────────────────────────
const meta = V.parseMeta('{"liveon":true,"title":"수다","csIP":"1.2.3.4","csIP6":"::1","csPort":9001,"callId":17600000001234567,"startTime":1759990000,"count":3}')
eq(meta.callId, '17600000001234567', '메타 callId 는 문자열로 읽는다')
eq(meta.csIP, '1.2.3.4', '메타 csIP')
eq(meta.csPort, 9001, '메타 csPort')
eq(meta.count, 3, '메타 count')
eq(V.parseMeta('{"hello":1}'), null, '보이스룸 메타가 아니다')

// ── 48시간 수명 ──────────────────────────────────────────────────────────
const t0 = 1_700_000_000_000
const s = V.newSession({ title: '수다방', by: 'bot1', chat: '123', now: t0, rand: 0.5 })
eq(s.endAt - s.startAt, V.MAX_MS, '수명 48시간')
eq(V.MAX_MS, 48 * 60 * 60 * 1000, '48시간')
ok(!V.expired(s, t0 + 47 * 3600_000), '47시간째는 살아 있다')
ok(V.expired(s, t0 + V.MAX_MS), '48시간째에 끝난다')
ok(!V.dueWarn(s, t0 + 46 * 3600_000), '46시간째는 아직 안 알린다')
ok(V.dueWarn(s, t0 + 47 * 3600_000), '끝 1시간 전에 알린다')
s.warned = true
ok(!V.dueWarn(s, t0 + 47.5 * 3600_000), '알림은 한 번만')

// ── 연장 ─────────────────────────────────────────────────────────────────
ok(!V.dueKeepalive(s, t0 + 60_000, V.KEEP_MS), '1분째는 연장하지 않는다')
ok(V.dueKeepalive(s, t0 + V.KEEP_MS, V.KEEP_MS), 'KEEP_MS 마다 연장한다')
ok(!V.dueKeepalive(s, t0 + V.MAX_MS + 1000, V.KEEP_MS), '끝난 방은 연장하지 않는다')
V.touch(s, t0 + V.KEEP_MS, true)
eq(s.keeps, 1, '연장 횟수')
ok(!V.dueKeepalive(s, t0 + V.KEEP_MS + 1000, V.KEEP_MS), '연장 직후에는 쉰다')
for (let i = 0; i < V.MAX_FAILS - 1; i++) V.touch(s, t0 + i, false)
ok(!V.dead(s), `${V.MAX_FAILS - 1}번 실패로는 죽지 않는다`)
V.touch(s, t0, false)
ok(V.dead(s), `${V.MAX_FAILS}번 내리 실패하면 꺼진 것으로 본다`)
V.touch(s, t0, true)
ok(!V.dead(s), '한 번 성공하면 실패가 지워진다')

// ── 진짜 값 바꿔 끼우기 ──────────────────────────────────────────────────
const s2 = V.newSession({ title: 't', by: 'bot1', chat: '1', now: t0 })
ok(V.adopt(s2, { liveon: true, callId: '99900000000000001', csIP: '5.6.7.8', csPort: 9100 }), '진짜 값이 오면 바꾼다')
eq(s2.callId, '99900000000000001', 'callId 교체')
eq(s2.csIP, '5.6.7.8', 'csIP 교체')
ok(!V.adopt(s2, { liveon: true, callId: '99900000000000001', csIP: '5.6.7.8', csPort: 9100 }), '같은 값은 바꾸지 않는다')
ok(!V.adopt(s2, { liveon: false }), '꺼짐 메타로는 바꾸지 않는다')
// 카카오 쪽 시작이 더 이르면 48시간은 그때부터 센다(두 번 켜서 늘리지 못하게)
const early = Math.floor((t0 - 3600_000) / 1000)
V.adopt(s2, { liveon: true, startTime: early })
eq(s2.endAt, early * 1000 + V.MAX_MS, '수명은 카카오의 시작 시각부터')
const before = s2.endAt
V.adopt(s2, { liveon: true, startTime: Math.floor((t0 + 7200_000) / 1000) })
eq(s2.endAt, before, '나중 시작 시각으로는 늘리지 않는다')

// ── 저장본 되살리기(sender 재시작) ───────────────────────────────────────
const saved = JSON.parse(JSON.stringify(V.newSession({ title: '밤샘', by: 'bot1', chat: '777', now: t0 })))
const back = V.restore(saved, { now: t0 + 10 * 3600_000, chat: '777' })
ok(back, '켜 둔 보이스룸은 되살아난다')
eq(back.title, '밤샘', '제목 유지')
eq(back.endAt, t0 + V.MAX_MS, '남은 시간은 처음 켠 때부터 센다')
eq(V.restore(saved, { now: t0 + V.MAX_MS + 1, chat: '777' }), null, '48시간이 지난 저장본은 버린다')
eq(V.restore(saved, { now: t0, chat: '888' }), null, '방이 옮겨 가면 버린다')
eq(V.restore({ on: false, startAt: t0 }, { now: t0 }), null, '꺼 둔 저장본은 버린다')
eq(V.restore({ on: true }, { now: t0 }), null, '모양이 깨진 저장본은 버린다')
eq(V.restore(null, { now: t0 }), null, '없는 저장본')
// 큰 callId 가 JSON 을 한 바퀴 돌아도 그대로다(문자열로 담기 때문)
ok(V.restore(saved, { now: t0, chat: '777' }).callId === saved.callId, 'callId 는 저장·되살리기를 지나도 같다')
ok(/^\d{17}$/.test(saved.callId), '저장본의 callId 는 숫자 문자열')

// ── 한 계정 여러 방 ──────────────────────────────────────────────────────
eq(V.maxRooms({}), V.DEFAULT_MAX_ROOMS, '기본 동시 개수')
eq(V.maxRooms({ SENDER_VOICE_MAX_ROOMS: '12' }), 12, '환경변수로 조정')
eq(V.maxRooms({ SENDER_VOICE_MAX_ROOMS: '0' }), V.DEFAULT_MAX_ROOMS, '말이 안 되는 값은 기본값')
eq(V.maxRooms({ SENDER_VOICE_MAX_ROOMS: '999' }), V.DEFAULT_MAX_ROOMS, '너무 큰 값은 기본값')
// 방마다 session 이 따로라 서로 섞이지 않는다
const a = V.newSession({ title: 'A', by: 'bot1', chat: '1', now: t0 })
const b = V.newSession({ title: 'B', by: 'bot1', chat: '2', now: t0 + 3600_000 })
ok(a.callId !== b.callId || a.startAt !== b.startAt, '방마다 다른 session')
eq(b.endAt - b.startAt, V.MAX_MS, '두 번째 방도 48시간')
ok(V.capReply(8, 8).includes('8'), '한도 안내')

// ── 사람에게 보이는 글 ───────────────────────────────────────────────────
eq(V.spanText(V.MAX_MS), '48시간', '48시간')
eq(V.spanText(90 * 60_000), '1시간 30분', '1시간 30분')
eq(V.spanText(30 * 60_000), '30분', '30분')
eq(V.spanText(0), '1분', '0은 1분으로')
ok(V.onReply(a).includes('48시간'), '켜기 답에 48시간')
ok(V.onReply(a).includes('A'), '켜기 답에 제목')
ok(V.statusReply(a, t0 + 3600_000).includes('47시간'), '상태 답에 남은 시간')
ok(V.statusReply(null, t0).includes('없어요'), '안 켠 방 상태')
ok(V.offReply(null, t0).includes('없어요'), '안 켠 방 끄기')
ok(V.offReply(a, t0 + 60_000).includes('A'), '끄기 답에 제목')
ok(V.endNotice(a).includes('48시간'), '끝 안내')
ok(V.warnNotice(a, t0 + 47 * 3600_000).includes('1시간'), '끝 1시간 전 안내')
ok(V.alreadyReply(a, t0).includes('이미'), '이미 켜져 있음')
ok(V.failReply(-801).includes('-801'), '실패 답에 상태코드')
ok(V.failReply(0).length > 0, '상태코드 없이도 답한다')
ok(V.staffOnlyReply().includes('방장'), '권한 안내')
ok(V.deadNotice(a).includes('보룸켜기'), '내려간 뒤 안내')

// 패널 한 줄
const row = V.sessionRow({ install_id: 5, chat_id: '9', link_id: '7', link_name: '방이름' }, a, t0 + 3600_000)
eq(row.install_id, 5, 'row install_id')
eq(row.left_ms, V.MAX_MS - 3600_000, 'row 남은 시간')
eq(row.call_id, a.callId, 'row callId 는 문자열')

// ── 진단 판정 ────────────────────────────────────────────────────────────
eq(V.metaTypeNum(16), 16, 'metaTypeNum 숫자')
eq(V.metaTypeNum({ low: 17, high: 0 }), 17, 'metaTypeNum Long')
eq(V.metaTypeNum('3'), 3, 'metaTypeNum 문자열')
ok(Number.isNaN(V.metaTypeNum('x')), 'metaTypeNum 이상한 값')

// 켜기가 되면 배너 확인으로 보낸다
eq(V.diagVerdict([{ tag: 'on+li', st: -203 }, { tag: 'on-li', st: 0 }], { perm: 4 }).next, 'banner', 'li 없이 되면 성공')
// 보이스룸이 아닌 메타는 쓰는데 보이스룸만 거부 → 서버 전용
eq(V.diagVerdict([{ tag: 'on-li', st: -203 }, { tag: 'unknown', st: -203 }, { tag: 'same', st: 0 }], { perm: 4, sameType: 3 }).next, 'bad_shape', '다른 메타는 쓰는데 보이스룸만 -203')
eq(V.diagVerdict([{ tag: 'on-li', st: -777 }, { tag: 'unknown', st: -777 }, { tag: 'same', st: 0 }], { perm: 4, sameType: 3 }).next, 'server_only', '모르는 코드로 거부되면 서버 전용')
eq(V.diagVerdict([{ tag: 'on-li', st: -300 }], { perm: 1 }).next, 'unknown_type', '타입을 모른다고 하면 번호부터')
// 부방장이 아무 메타도 못 씀 → 방장 방에서 한 번 더
eq(V.diagVerdict([{ tag: 'on-li', st: -203 }, { tag: 'same', st: -777 }], { perm: 4, sameType: 3 }).next, 'owner_test', '부방장이 설명 안 되는 코드로 거부')
eq(V.diagVerdict([{ tag: 'on-li', st: -203 }, { tag: 'same', st: -203 }], { perm: 4, sameType: 3 }).next, 'bad_shape', '-203 은 권한 이야기로 읽지 않는다')
// 방장인데 아무 메타도 못 씀 → 권한이 아니다
eq(V.diagVerdict([{ tag: 'on-li', st: -203 }, { tag: 'same', st: -203 }], { perm: 1, sameType: 3 }).next, 'bad_shape', '방장이어도 -203 은 내용 문제')
// 거부당하는 타입(16)으로 돌린 same 은 대조군이 아니다 — 없는 셈 친다
const sameVoice = V.diagVerdict([{ tag: 'on-li', st: -203 }, { tag: 'unknown', st: -300 }, { tag: 'same', st: -203 }], { perm: 1, sameType: 16 })
eq(sameVoice.next, 'bad_shape', '보이스룸 타입으로 돌린 same 은 세지 않는다')
ok(!sameVoice.verdict.includes('방장인 방에서'), '방장에게 방장 방에서 해 보라고 하지 않는다: ' + sameVoice.verdict)
// 부방장이면 같은 줄이라도 아직 가릴 수 있는 여지가 있다
eq(V.diagVerdict([{ tag: 'on-li', st: -203 }, { tag: 'unknown', st: -300 }], { perm: 4 }).next, 'bad_shape', '부방장도 같은 판정(권한 이야기가 아니다)')

// 실측 그대로(2026-10-16, 봇이 방장인 방): 모르는 타입 -300 · 보이스룸 -203 → 서버 전용
const real = [
  { tag: 'on+li', st: -203 }, { tag: 'on-li', st: -203 }, { tag: 'off', st: -203 },
  { tag: 'count', st: -203 }, { tag: 'unknown', st: -300 }, { tag: 'same', st: -203 },
]
const rv = V.diagVerdict(real, { perm: 1, sameType: 16 })
eq(rv.next, 'bad_shape', '실측 판정: 타입은 알고 내용이 틀린 것')
ok(rv.verdict.includes('-300') && rv.verdict.includes('권한 문제가 아닙니다'), '실측 판정 문구: ' + rv.verdict)
ok(V.diagText(real, { types: [16, 17], perm: 1, full: true, sameType: 16 }).includes('보룸따라'), '다음 수로 따라쓰기를 알려 준다')
const realText = V.diagText(real, { types: [16, 17], perm: 1, full: true, sameType: 16, sameSkip: '' })
ok(realText.startsWith('보룸 진단 (방장 1 · 방 메타 16,17)'), '권한을 말로 푼다: ' + realText)
ok(!realText.includes('보룸진단 전체'), '이미 결론이 났으면 전체를 권하지 않는다')

// 끄기만 받는 경우
eq(V.diagVerdict([{ tag: 'on-li', st: -500 }, { tag: 'off', st: 0 }, { tag: 'unknown', st: -500 }], { perm: 4 }).next, 'server_only', '끄기만 받음')
// 대조군을 못 돌렸으면 까닭을 적는다
const skipText = V.diagText([{ tag: 'on-li', st: -203 }, { tag: 'unknown', st: -203 }], { types: [16, 17], perm: 4, full: true, sameSkip: '이 방엔 보이스룸 메타(16·17)밖에 없어요' })
ok(skipText.includes('대조군 생략: 이 방엔'), '대조군 생략 까닭: ' + skipText)

eq(V.isVoiceMetaType(16), true, 'type 16 은 보이스룸 자리')
eq(V.isVoiceMetaType({ low: 17 }), true, 'type 17(Long) 도')
eq(V.isVoiceMetaType(3), false, 'type 3 은 아니다')

const dt = V.diagText([{ tag: 'on-li', st: -999 }, { tag: 'unknown', st: -999 }], { types: [3], perm: 4, full: false })
ok(dt.includes('on-li -999') && dt.includes('부방장 4') && dt.includes('방 메타 3'), '진단 답에 코드·권한·메타: ' + dt)
ok(dt.includes('보룸진단 전체'), '아직 모르면 전체로 안내')

// ── 따라 쓰기(mirror) ────────────────────────────────────────────────────
// 실측 상태코드
eq(V.STATUS_BAD_REQUEST, -203, '-203 = 요청 내용이 틀림')
eq(V.STATUS_UNKNOWN, -300, '-300 = 없는 명령어·모르는 타입')

// url 가리기(주소에 토큰이 들어 있을 수 있다)
const masked = V.maskMeta('{"liveon":true,"url":"https://x.kakao.com/t?k=secret","callId":123}')
ok(masked.includes('"url":"<hidden 30>"') && !masked.includes('secret'), 'url 을 가린다: ' + masked)
ok(masked.includes('"callId":123'), '다른 칸은 그대로')
eq(V.maskMeta(null), '', '없는 본문')

// 함께 온 칸 모으기
const ex = V.metaExtras({ type: 16, content: '{}', revision: 7, authorId: '9', updatedAt: 1, nope: undefined })
eq(JSON.stringify(ex), JSON.stringify({ revision: 7, authorId: '9', updatedAt: 1 }), 'content·type 말고 전부: ' + JSON.stringify(ex))
eq(JSON.stringify(V.metaExtras(null)), '{}', '없는 메타')

// 켜진 모양으로 바꾸기 — callId 는 글자 그대로 남아야 한다
const kakaoMeta = '{"liveon":false,"title":"수다","updateTime":1760000000,"startTime":1759999000,"csIP":"1.2.3.4","csPort":9000,"callId":17600000001234567,"url":"https://x"}'
const on = V.turnOn(kakaoMeta, 1760009999)
ok(on.includes('"liveon":true'), 'liveon 을 켠다')
ok(on.includes('"updateTime":1760009999'), 'updateTime 을 지금으로')
ok(on.includes('"callId":17600000001234567'), 'callId 는 글자 그대로: ' + on)
ok(on.includes('"startTime":1759999000'), 'startTime 은 건드리지 않는다')
JSON.parse(on)
// 칸이 없으면 끼워 넣는다
const bare = V.turnOn('{"title":"x"}', 5)
ok(bare.includes('"liveon":true') && bare.includes('"updateTime":5'), '없는 칸은 끼워 넣는다: ' + bare)
JSON.parse(bare)

// 판정
eq(V.mirrorVerdict([{ tag: 'asis', st: -203 }, { tag: 'off', st: 0 }]).next, 'written', '하나라도 써지면 쓸 수 있는 자리')
ok(V.mirrorVerdict([{ tag: 'off', st: 0 }]).verdict.includes('off'), '어느 내용이 통했는지 말한다')
eq(V.mirrorVerdict([{ tag: 'asis', st: -203 }, { tag: 'on', st: -500 }]).next, 'reached', '-500 이면 읽히는 자리')
ok(V.mirrorVerdict([{ tag: 'on', st: -500 }]).verdict.includes('통화 할당'), '막힌 곳을 짚는다')
eq(V.mirrorVerdict([{ tag: 'asis', st: -203 }, { tag: 'on', st: -203 }, { tag: 'empty', st: -203 }]).next, 'server_only', '전부 -203 이면 쓰는 자리가 아니다')
eq(V.mirrorVerdict([{ tag: 'asis', st: -300 }]).next, 'unknown_type', '모르는 타입이면 번호부터')
// 대조군(@chatId)은 판정에 세지 않는다 — 읽히지 않는 모양이라는 것을 이미 안다
eq(V.mirrorVerdict([{ tag: 'asis', st: -203 }, { tag: 'asis@chatId', st: 0 }]).next, 'server_only', '대조군은 판정에서 뺀다')
const mt = V.mirrorText([{ tag: 'asis', st: -203 }, { tag: 'off', st: 0 }], { type: 16, keys: ['revision', 'authorId'], shape: 'c+li' })
ok(mt.startsWith('보룸 따라쓰기 (모양 c+li · type 16 · 함께 온 칸 revision,authorId)'), '머리줄에 모양까지: ' + mt)
ok(V.mirrorText([], { type: 16, keys: [], shape: 'c' }).includes('함께 온 칸 없음'), '칸이 없을 때')

// ── 쓰기 시험 ────────────────────────────────────────────────────────────
eq(V.writeTestVerdict([{ tag: 'type3', st: 0 }]).next, 'voice_closed', '다른 타입이 써지면 보이스룸만 막힌 것')
ok(V.writeTestVerdict([{ tag: 'type3', st: 0 }]).verdict.includes('닫혔습니다'), '닫혔다고 분명히 말한다')
eq(V.writeTestVerdict([{ tag: 'type3', st: -203 }, { tag: 'type3+li', st: -203 }]).next, 'bad_shape', '전부 막히면 우리 모양이 의심')
ok(V.writeTestVerdict([{ tag: 'type3', st: -203 }]).verdict.includes('다른 명령어'), '오픈채팅은 다른 명령어일 수 있다고 짚는다')
eq(V.writeTestVerdict([{ tag: 'type3', st: -300 }]).next, 'unknown_type', '그 타입도 모른다면')
ok(V.writeTestText([{ tag: 'type3', st: 0 }], { what: 'type 3(제목)에 지금 방 이름 그대로' }).startsWith('보룸 쓰기시험 (type 3(제목)에 지금 방 이름 그대로)'), '무엇을 썼는지 밝힌다')

// ── 바디 모양 찾기 ───────────────────────────────────────────────────────
const vals = { chatId: 'CID', li: 'LI', type: 16, typeLong: 'L16', content: 'BODY' }
const byTag = (t) => V.SHAPES.find((x) => x.tag === t)
eq(JSON.stringify(V.shapeBody(byTag('chatId'), vals)), JSON.stringify({ chatId: 'CID', type: 16, content: 'BODY' }), '지금까지 보내던 모양')
eq(JSON.stringify(V.shapeBody(byTag('c+li'), vals)), JSON.stringify({ c: 'CID', li: 'LI', type: 16, content: 'BODY' }), 'openAction 과 같은 모양')
eq(JSON.stringify(V.shapeBody(byTag('c+li+t'), vals)), JSON.stringify({ c: 'CID', li: 'LI', t: 16, content: 'BODY' }), 'type 을 t 로')
eq(JSON.stringify(V.shapeBody(byTag('c+li+v'), vals)), JSON.stringify({ c: 'CID', li: 'LI', type: 16, v: 'BODY' }), 'content 를 v 로')
eq(V.shapeBody(byTag('c+li+long'), vals).type, 'L16', 'type 을 Long 으로')
eq(V.shapeBody(byTag('c'), vals).li, undefined, 'li 를 안 쓰는 모양')
eq(V.shapeBody(byTag('chatId+li'), { chatId: 'CID', li: null, type: 3, content: 'x' }).li, undefined, '옾링 id 가 없으면 빼고 보낸다')
ok(V.SHAPES.length >= 6 && V.SHAPES[0].tag === 'chatId', '지금 모양부터 먼저 본다')

eq(V.shapeVerdict([{ tag: 'chatId', st: -203 }, { tag: 'c+li', st: -203 }]).next, 'no_shape', '전부 막히면 명령어 쪽을 봐야 한다')

// 실측 그대로(2026-10-16): 코드가 갈린 자리에서 칸 이름을 읽어 낸다
const shapeReal = [
  { tag: 'chatId', st: -203 }, { tag: 'chatId+li', st: -203 }, { tag: 'c', st: -500 }, { tag: 'c+li', st: -500 },
  { tag: 'c+li+t', st: -300 }, { tag: 'c+li+v', st: -203 }, { tag: 'c+li+meta', st: -203 }, { tag: 'c+li+long', st: -500 },
]
const fr = V.fieldReport(shapeReal)
ok(fr.includes('방 id 칸은 `c`'), '방 id 칸: ' + JSON.stringify(fr))
ok(fr.includes('타입 칸은 `type`'), '타입 칸(t 는 -300 이었다)')
ok(fr.includes('내용 칸은 `content`'), '내용 칸(v·meta 는 -203 이었다)')
const sv = V.shapeVerdict(shapeReal, { type: 3 })
eq(sv.next, 'try_voice', '제목은 -500 이어도 그 모양으로 보이스룸을 쳐 봐야 한다')
eq(sv.shape, 'c', '읽힌 모양을 돌려준다')
ok(sv.verdict.includes('보룸모양 16'), '다음 수를 알려 준다: ' + sv.verdict)

// 보이스룸 타입으로 돌렸을 때
eq(V.shapeVerdict([{ tag: 'c+li', st: 0 }], { type: 16 }).next, 'voice_on', '보이스룸이 켜짐')
const reached = V.shapeVerdict([{ tag: 'chatId', st: -203 }, { tag: 'c+li', st: -500 }], { type: 16 })
eq(reached.next, 'reached', '읽히기는 했다')
ok(reached.verdict.includes('바디 모양은 맞고'), '모양은 맞다고 말한다')
eq(V.shapeVerdict([{ tag: 'chatId', st: -203 }, { tag: 'c+li', st: -203 }], { type: 16 }).next, 'bad_shape', '보이스룸은 읽히지도 않음')
eq(V.fieldReport([{ tag: 'chatId', st: -203 }, { tag: 'c', st: -203 }]).length, 0, '코드가 같으면 아무것도 못 읽는다')
ok(V.shapeVerdict([{ tag: 'chatId', st: -203 }]).verdict.includes('명령어'), '명령어 쪽을 짚는다')
const f = V.shapeVerdict([{ tag: 'chatId', st: -203 }, { tag: 'c+li', st: 0 }])
eq(f.next, 'shape_found', '통하는 모양을 찾음')
eq(f.shape, 'c+li', '어느 모양인지 돌려준다')
const won = V.shapeVerdict([{ tag: 'c+li', st: 0 }, { tag: '보이스룸16', st: 0 }])
eq(won.next, 'voice_on', '그 모양으로 보이스룸도 받으면 켜지는 것')
ok(won.verdict.includes('켜집니다'), '켜진다고 말한다')
const closed = V.shapeVerdict([{ tag: 'c+li', st: 0 }, { tag: '보이스룸16', st: -203 }])
eq(closed.next, 'voice_closed', '제목은 되는데 보이스룸만 거부 → 그때야 막힌 것이 증명된다')
ok(closed.verdict.includes('이제야'), '그때야 확인됐다고 말한다')
ok(V.shapeText([{ tag: 'c+li', st: 0 }], { what: '제목(3)에 「방」 그대로' }).startsWith('보룸 모양찾기 (제목(3)에 「방」 그대로)'), '무엇을 썼는지 밝힌다')

process.stderr.write('[voiceroom-check] ok\n')
