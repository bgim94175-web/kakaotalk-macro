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

process.stderr.write('[voiceroom-check] ok\n')
