import { KakaoTalkClient } from 'agent-messenger/kakaotalk'

import { roomListKind, roomTitle, stampOpenLinkTitles, withoutMemberCount } from './room-kind.mjs'
import { Hub, Slot } from './runner.mjs'
import { Owner } from './owner.mjs'
import { open, seal } from './store.mjs'
import { groupLinkType, kstClock, kstWhen, linkText, recordLines, withProfileLink } from './roomfeat.mjs'

// 방 안내 맨 아래 시각 줄(`오후 7:31`)
const CLOCK_RE = /\n오[전후] (?:[1-9]|1[0-2]):[0-5][0-9]$/
const hasClock = (t) => CLOCK_RE.test(t)
// 입장·퇴장·프로필 변경 안내 맨 아래: 시각만 적은 기록(`입장 기록 : N회` + 최근 시각 `11.15 오전 7:13`).
// 실제 봇 시각이 들어가는 안내는 이 기록을 떼고 비교한다
const REC_RE = /\n(?:입장|퇴장|변경) 기록 : [1-9][0-9]*회(?:\n(?:[0-9]{4}\.)?[01][0-9]\.[0-3][0-9] 오[전후] (?:[1-9]|1[0-2]):[0-5][0-9])+$/
const hasRec = (t) => REC_RE.test(t)
const noRec = (t) => t.replace(REC_RE, '')
import * as passbox from './secretbox.mjs'
import { linkable, has } from './word.mjs'
import { correct } from './quiz.mjs'
import {
  guardCanStopKicks,
  guardDue,
  guardFinishHalt,
  guardNotices,
  guardOnChat,
  macroNotifyReply,
  macroRoomsDue,
  noteMacroSent,
  onInbound,
  chatLogsFromBody,
  coverNeedsAuthor,
  coverPlan,
  coverSkipsLink,
  hasCoverLink,
  hasCoverWord,
  logsView,
  isProfanity,
  parseRoomKey,
  visitEventsFromMessage,
  visitMemberId,
  visitMentionExtra,
} from './features.mjs'

process.env.SENDER_KEY = process.env.SENDER_KEY || '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff'

const creds = { access_token: 'tok', refresh_token: 'ref', user_id: '9', device_uuid: 'du', device_type: 'tablet' }
const sealed = seal(creds)
if (sealed === JSON.stringify(creds)) throw new Error('token was stored in plaintext')
const back = open(sealed)
if (!back || back.access_token !== 'tok' || back.refresh_token !== 'ref' || back.user_id !== '9') {
  throw new Error('encrypt roundtrip failed')
}
const tampered = Buffer.from(sealed, 'base64')
tampered[tampered.length - 1] ^= 1
try {
  open(tampered.toString('base64'))
  throw new Error('tampered seal was accepted')
} catch (e) {
  if (e && e.message === 'tampered seal was accepted') throw e
}

// 방 참여코드 봉인 (docs/ACCOUNTS_V1.md 8장 6번·9.0). 부모 lib/secretbox.js 가 봉인한 값을 여기서 연다.
// 아래 벡터는 lib/purchase-check.js 와 같은 문자열이어야 한다.
{
  const prevSecret = process.env.CONFIG_SECRET
  process.env.CONFIG_SECRET = '0123456789abcdef0123456789abcdef'
  const VECTOR = 'v1.AAECAwQFBgcICQoLlAj1igkIAeTZFvTsl-bF0uEUVlk'
  const got = passbox.sealWithIv('0000', '000102030405060708090a0b')
  if (got !== VECTOR) throw new Error('secretbox: fixed test vector changed: ' + got)
  if (passbox.open(VECTOR) !== '0000') throw new Error('secretbox: vector does not open')
  const a = passbox.seal('0000')
  if (a === passbox.seal('0000') || passbox.open(a) !== '0000') throw new Error('secretbox: roundtrip')
  const raw = Buffer.from(VECTOR.slice(3), 'base64url')
  raw[raw.length - 1] ^= 1
  if (passbox.open('v1.' + raw.toString('base64url')) !== null) throw new Error('secretbox: tampered blob was accepted')
  process.env.CONFIG_SECRET = 'another-secret-value-0123456789'
  if (passbox.open(VECTOR) !== null) throw new Error('secretbox: other CONFIG_SECRET opened the blob')
  if (prevSecret === undefined) delete process.env.CONFIG_SECRET
  else process.env.CONFIG_SECRET = prevSecret
}

if (!linkable('고려', '여름')) throw new Error('word link 고려->여름')
if (!linkable('콜라', '나비')) throw new Error('word link 콜라->나비')
if (!has('사과')) throw new Error('dict missing 사과')
if (!correct(0, '서울')) throw new Error('quiz')

const kinds = [
  [{ type: 'OM' }, 'open_room'],
  [{ type: 'OD' }, 'open_dm'],
  [{ type: 'OpenMultiChat' }, 'open_room'],
  [{ type: 'OpenDirectChat' }, 'open_dm'],
  [{ type: 2, display_name: '김, 이, 박', active_members: 4 }, 'normal'],
  [{ type: 13 }, 'open_room'],
  [{ type: 15 }, 'open_room'],
  [{ type: 14 }, 'open_dm'],
  [{ type: 16 }, 'open_dm'],
  [{ type: 'DirectChat' }, 'normal'],
  [{ type: 'MultiChat' }, 'normal'],
  [{ type: 11 }, 'normal'],
  [{ type: 10 }, 'normal'],
  [{ type: 'PlusChat' }, 'normal'],
  [{ type: 'MemoChat' }, 'normal'],
  // 링크가 있고 3명 이상이면 이름을 못 읽었어도 오픈 단체방이다(이름이 없으면 패널 목록에서만 빠진다)
  [{ type: 2, link_id: '9', display_name: '김, 이, 박', title: '김, 이, 박', active_members: 4 }, 'open_room'],
  [{ type: 2, link_id: '9', title: '동네모임', display_name: '김, 이, 박', active_members: 4 }, 'open_room'],
  [{ type: 2, link_id: '9', title: '홍길동', display_name: '홍길동', active_members: 2 }, 'open_dm'],
  [{ type: 2, link_id: '9020', active_members: 2 }, 'open_dm'],
  // 1:1 에는 2명보다 많이 있을 수 없다: 링크가 있는 14·16 방도 3명 이상이면 단체방
  [{ type: 14, link_id: '9022', active_members: 50 }, 'open_room'],
  [{ type: 16, link_id: '9022', active_members: 3 }, 'open_room'],
  [{ type: 14, link_id: '9001', active_members: 2 }, 'open_dm'],
  [{ type: 16, link_id: '9001' }, 'open_dm'],
  [{ type: 'OD', link_id: '9001', active_members: 5 }, 'open_dm'],
  [{ type: 13, link_id: '9', title: '모임방', display_name: '김, 이', active_members: 3 }, 'open_room'],
  [{ type: 13, link_id: '9', display_name: '김, 이', active_members: 3 }, 'open_room'],
  [{ type: 'OM', title: '김, 이, 박', display_name: '김, 이, 박' }, 'open_room'],
  [{ type: 15, link_id: '3', title: '별명방', display_name: '가, 나', active_members: 2 }, 'open_room'],
  // 커뮤니티 타입 방(새 type 값): 오픈링크가 있으면 오픈 단체방
  [{ type: 18, link_id: '5', title: '커뮤니티방', display_name: '김, 이, 박', active_members: 40 }, 'open_room'],
  [{ type: 'OC', link_id: '5', title: '커뮤니티방', display_name: '김, 이, 박', active_members: 40 }, 'open_room'],
  [{ type: 17, link_id: '9005', active_members: 300 }, 'open_room'],
  [{ type: 'OC', link_id: '9006', active_members: 40 }, 'open_room'],
  [{ type: 18, link_id: '5' }, 'open_room'],
  [{ type: 17, link_id: '5', active_members: 2 }, 'open_dm'],
  // 일반 단톡방·1:1 은 고르는 목록에 올리지 않는다
  [{ type: 'MultiChat', title: '가족', active_members: 3 }, 'normal'],
  [{ type: 10, active_members: 5 }, 'normal'],
  [{ type: 11, active_members: 2 }, 'normal'],
  [{ type: 18, display_name: '김, 이, 박', active_members: 500 }, 'normal'],
]
for (const [ch, want] of kinds) {
  const got = roomListKind(ch)
  if (got !== want) throw new Error(`room kind ${JSON.stringify(ch)} -> ${got}, want ${want}`)
}
// 오픈링크 종류: 1(1:1·오픈프로필)만 그룹이 아니다. 커뮤니티(3)·모르는 값·빠진 값은 들어가 본다
for (const [lt, want] of [[1, false], ['1', false], [2, true], [3, true], [0, true], [undefined, true], [null, true]]) {
  if (groupLinkType(lt) !== want) throw new Error(`groupLinkType(${lt}) -> ${!want}`)
}

const roomKey = parseRoomKey('0\u0001공지').key
const record = {
  features: { macro: true, roombot: true, minigame: true },
  config: {
    accounts: [],
    macro: { enabled: true, message: '안녕', rooms: [roomKey], baseMin: 1, randomMin: 0, minMessages: 1, sendImages: 'EVERY', images: [] },
    triggers: [{ id: 't1', enabled: true, pattern: '가격', mode: 'contains', reply: '안내', rooms: [], fromMe: false, cooldownMs: 0, delayMs: 0 }],
    autoreply: { enabled: true, message: '{이름}님', scope: 'ALL', cooldownMs: 0, dailyLimit: 0, hourFrom: 0, hourTo: 24, delayMaxMs: 0 },
    roombot: { enabled: false },
    minigame: { enabled: false },
  },
  rooms: [{ key: roomKey, chat_id: '12345', name: '공지', kind: 'group' }],
  runtime: {},
}
const sends = onInbound(record, { chatId: '12345', text: '가격 문의', authorName: '김', mine: false })
if (sends.length !== 1 || sends[0].text !== '안내') throw new Error('trigger did not fire')
const due = macroRoomsDue(record, Date.now())
if (due.length !== 1 || due[0].chatId !== '12345') throw new Error('macro due')
noteMacroSent(record, roomKey, Date.now())
if (macroRoomsDue(record, Date.now()).length !== 0) throw new Error('cooldown')
if (macroNotifyReply(record)) throw new Error('notify reply defaults off')
record.config.macro.notifyReply = true
if (!macroNotifyReply(record)) throw new Error('notify reply on')
record.config.macro.notifyReply = false
if (macroNotifyReply(record)) throw new Error('notify reply off')
delete record.config.macro.notifyReply
if (macroNotifyReply(record)) throw new Error('notify reply absent')

// 갠톡 응답: 오픈프로필 1:1(list_kind open_dm)은 라이브러리 분류(kind)가 'open' 이어도 답한다.
// 오픈 단체방·일반 단톡방에는 답하지 않고, 목록 종류가 없는 예전 줄과 일반 1:1 은 예전처럼 kind 로 본다.
{
  const dmRec = (room) => ({
    features: { v: 2, macro_until: Date.now() + 60000 },
    config: {
      accounts: [],
      triggers: [],
      autoreply: { enabled: true, message: '{이름}님, 문의 감사합니다.', scope: 'ALL', cooldownMs: 6 * 3600000, dailyLimit: 0, hourFrom: 0, hourTo: 24, delayMaxMs: 0 },
    },
    rooms: [Object.assign({ key: parseRoomKey('0\u0001민지').key, chat_id: '777', name: '민지' }, room)],
    runtime: {},
  })
  const ask = (rec, mine) => onInbound(rec, { chatId: '777', text: '안녕하세요, 거래 문의드립니다.', authorName: '민지', mine: !!mine })
  const od = dmRec({ kind: 'open', list_kind: 'open_dm' })
  const first = ask(od)
  if (first.length !== 1 || first[0].chatId !== '777' || first[0].text !== '민지님, 문의 감사합니다.') throw new Error('autoreply: open-profile 1:1 gets a reply ' + JSON.stringify(first))
  if (ask(od).length !== 0) throw new Error('autoreply: open-profile 1:1 keeps the cooldown')
  if (ask(dmRec({ kind: 'open', list_kind: 'open_dm' }), true).length !== 0) throw new Error('autoreply: never answers own message')
  if (ask(dmRec({ kind: 'open', list_kind: 'open_room' })).length !== 0) throw new Error('autoreply: never in an open group room')
  if (ask(dmRec({ kind: 'dm', list_kind: 'open_room' })).length !== 0) throw new Error('autoreply: never in an open group room even when kind says dm')
  // 2026-10-11 전에 불러온 목록: 3명 이상인 type 14·16 단체방이 open_dm 으로 남아 있다 → 답하지 않는다
  if (ask(dmRec({ kind: 'open', list_kind: 'open_dm', members: 50 })).length !== 0) throw new Error('autoreply: never in an old open_dm row with 50 members')
  if (ask(dmRec({ kind: 'open', list_kind: 'open_dm', members: 2 })).length !== 1) throw new Error('autoreply: an open_dm row with 2 members gets a reply')
  if (ask(dmRec({ kind: 'group', list_kind: 'normal' })).length !== 0) throw new Error('autoreply: never in a normal group')
  if (ask(dmRec({ kind: 'open' })).length !== 0) throw new Error('autoreply: an old row without list_kind keeps the old rule')
  if (ask(dmRec({ kind: 'dm', list_kind: 'normal' })).length !== 1) throw new Error('autoreply: a normal 1:1 still gets a reply')
  if (ask(dmRec({ kind: 'dm' })).length !== 1) throw new Error('autoreply: an old dm row still gets a reply')
  const ended = dmRec({ kind: 'open', list_kind: 'open_dm' })
  ended.features.macro_until = Date.now() - 1000
  if (ask(ended).length !== 0) throw new Error('autoreply: no reply after the macro period')
}

const neverImages = {
  features: { macro: true },
  config: {
    accounts: [],
    macro: { enabled: true, message: '안녕', rooms: [roomKey], baseMin: 1, randomMin: 0, minMessages: 1, sendImages: 'NEVER', images: ['a.jpg'] },
  },
  rooms: [{ key: roomKey, chat_id: '12345', name: '공지', kind: 'group' }],
  runtime: {},
}
if (noteMacroSent(neverImages, roomKey, Date.now()) !== true) throw new Error('NEVER with images must send every time')
neverImages.config.macro.images = []
neverImages.runtime = {}
if (noteMacroSent(neverImages, roomKey, Date.now()) !== false) throw new Error('no images must not send')

const guardKey = parseRoomKey('0\u0001관리').key
function guardRecord(over) {
  return {
    features: { macro: true },
    config: {
      accounts: [],
      guard: Object.assign({
        rooms: [guardKey],
        presenceOn: true,
        presenceMin: 30,
        kickOn: true,
        kickCount: 3,
        kickSecs: 30,
        floodOn: true,
        floodCount: 3,
        floodSecs: 10,
        floodSlowSecs: 60,
        floodText: '천천히',
        churnOn: true,
        churnCount: 3,
        churnSecs: 20,
        churnQuietSecs: 120,
        churnText: '',
        welcomeOn: true,
        welcomeText: '어서 오세요',
        noticeOn: true,
        noticeText: '공지입니다',
        noticeMin: 60,
      }, over || {}),
    },
    rooms: [{ key: guardKey, chat_id: '555', name: '관리방', kind: 'group' }],
    runtime: {},
  }
}
const t0 = 1_700_000_000_000
const welcome = guardOnChat(guardRecord(), { kind: 'join', chatId: '555', authorId: '7', now: t0 })
if (welcome.sends.length !== 1 || welcome.sends[0].text !== '어서 오세요') throw new Error('welcome')
const again = guardOnChat(guardRecord(), { kind: 'join', chatId: '999', authorId: '7', now: t0 })
if (again.sends.length !== 0) throw new Error('guard must ignore a room that is off')
const noWelcome = guardRecord({ welcomeText: '  ' })
if (guardOnChat(noWelcome, { kind: 'join', chatId: '555', authorId: '7', now: t0 }).sends.length !== 0) {
  throw new Error('empty welcome must not send')
}
const flood = guardRecord()
for (let i = 0; i < 2; i++) {
  if (guardOnChat(flood, { kind: 'msg', chatId: '555', text: 'a', authorId: '7', messageType: 1, now: t0 + i }).sends.length !== 0) {
    throw new Error('flood early')
  }
}
const flooded = guardOnChat(flood, { kind: 'msg', chatId: '555', text: 'a', authorId: '7', messageType: 1, now: t0 + 2 })
if (flooded.sends.length !== 1 || flooded.sends[0].text !== '천천히') throw new Error('flood notice')
if (guardOnChat(flood, { kind: 'msg', chatId: '555', text: 'a', authorId: '7', messageType: 1, now: t0 + 3 }).sends.length !== 0) {
  throw new Error('slowed member must not get another notice')
}
const silentFlood = guardRecord({ floodText: '' })
for (let i = 0; i < 3; i++) guardOnChat(silentFlood, { kind: 'msg', chatId: '555', text: 'a', authorId: '7', messageType: 1, now: t0 + i })
if (guardNotices(silentFlood).length !== 0) throw new Error('flood must not invent a customer notice')
const churn = guardRecord()
guardOnChat(churn, { kind: 'join', chatId: '555', authorId: '1', now: t0 })
guardOnChat(churn, { kind: 'leave', chatId: '555', authorId: '1', now: t0 + 1 })
const third = guardOnChat(churn, { kind: 'join', chatId: '555', authorId: '2', now: t0 + 2 })
if (third.sends.some((s) => s.text === '어서 오세요')) throw new Error('join flood must not welcome')
if (third.sends.length !== 0) throw new Error('empty churn text must not send')
const kicked = guardRecord()
guardOnChat(kicked, { kind: 'msg', chatId: '555', text: '김님을 내보냈습니다', messageType: 0, now: t0 })
guardOnChat(kicked, { kind: 'msg', chatId: '555', text: '이님을 내보냈습니다', messageType: 0, now: t0 + 1 })
const wave = guardOnChat(kicked, { kind: 'msg', chatId: '555', text: '박님을 강퇴했습니다', messageType: 0, now: t0 + 2 })
if (!wave.askHalt || wave.askHalt.count < 3) throw new Error('kick wave')
const said = guardRecord()
if (guardOnChat(said, { kind: 'msg', chatId: '555', text: '강퇴했습니다', messageType: 1, now: t0 }).askHalt) {
  throw new Error('a normal message must not count as a kick')
}
guardFinishHalt(kicked, '555', true, t0 + 4, '관리방', 3)
const notes = guardNotices(kicked)
if (notes.length !== 1 || notes[0].text.indexOf('10분 동안 사람을 내보내지 않습니다') < 0 || notes[0].text.indexOf('강퇴') >= 0) throw new Error('halt notice')
const denied = guardRecord()
guardFinishHalt(denied, '555', false, t0, '관리방', 3)
if (guardNotices(denied)[0].text.indexOf('권한이 없습니다') < 0) throw new Error('no permission notice')
if (notes[0].text.indexOf('이 계정은 10분 동안') < 0) throw new Error('halt notice subject (customer account)')
const kbotHalt = guardRecord()
guardFinishHalt(kbotHalt, '555', true, t0, '관리방', 3, 'K bot')
if (guardNotices(kbotHalt)[0].text !== '「관리방」에서 짧은 시간에 3명을 내보냈습니다. K bot은 10분 동안 사람을 내보내지 않습니다.') throw new Error('halt notice subject (K bot) ' + guardNotices(kbotHalt)[0].text)
if (!guardCanStopKicks(1) || !guardCanStopKicks(4) || guardCanStopKicks(2) || guardCanStopKicks(8) || guardCanStopKicks(null)) {
  throw new Error('kick permission')
}
const guardDueNow = guardDue(guardRecord(), t0)
if (guardDueNow.presence.length !== 1 || guardDueNow.presence[0] !== '555') throw new Error('presence')
if (guardDueNow.sends.length !== 1 || guardDueNow.sends[0].text !== '공지입니다') throw new Error('notice')
const held = guardRecord()
guardDue(held, t0)
const later = guardDue(held, t0 + 1000)
if (later.presence.length !== 0 || later.sends.length !== 0) throw new Error('presence and notice must wait')
const blankNotice = guardRecord({ noticeText: '' })
if (guardDue(blankNotice, t0).sends.length !== 0) throw new Error('empty notice must not send')

function visitRecord(over) {
  return {
    features: { macro: true, roombot: false },
    config: {
      accounts: [],
      visit: Object.assign({ enabled: true, rooms: [guardKey] }, over || {}),
    },
    rooms: [{ key: guardKey, chat_id: '555', name: '동네모임', kind: 'open' }],
    runtime: {},
  }
}
function profileRecord(over) {
  return {
    features: { macro: true, roombot: false },
    config: {
      accounts: [],
      profile: Object.assign({ enabled: true, rooms: [guardKey] }, over || {}),
    },
    rooms: [{ key: guardKey, chat_id: '555', name: '동네모임', kind: 'open' }],
    runtime: {},
  }
}
const quietVisit = visitRecord({ enabled: false })
const quietJoin = guardOnChat(quietVisit, {
  kind: 'join', chatId: '555', authorId: '7', authorName: '홍길동',
  profileLink: 'https://open.kakao.com/o/abc', now: t0,
})
if (quietJoin.sends.length !== 0 || quietVisit.runtime.visit) throw new Error('join notice is off by default')
const firstVisit = visitRecord()
const firstLeft = guardOnChat(firstVisit, { kind: 'leave', chatId: '555', authorId: '7', authorName: '홍길동', now: t0 })
if (firstLeft.sends.length !== 1) throw new Error('a leave posts one notice')
const leftNote = firstLeft.sends[0].text
// 관리자 지정 모양(간단하게): [제목] · 이름(@멘션) · 옾링 · 맨 아래 시각만 적은 기록. 사진은 넘겨받아도 적지 않는다.
const expectedLeave = '[퇴장 안내]\n이름 : @홍길동\n옾링 : 없음\n퇴장 기록 : 1회\n11.15 오전 7:13'
if (leftNote !== expectedLeave) throw new Error('leave notice layout ' + JSON.stringify(leftNote))
const joined = guardOnChat(firstVisit, {
  kind: 'join', chatId: '555', authorId: '7', authorName: '홍길동',
  profileLink: 'https://open.kakao.com/o/abc', photo: 'https://k.kakaocdn.net/dn/a/b/img_s.jpg', now: t0 + 60000,
})
if (joined.sends.length !== 1) throw new Error('one join notice')
const note = joined.sends[0].text
const expected = '[입장 안내]\n이름 : @홍길동\n옾링 : https://open.kakao.com/o/abc\n입장 기록 : 1회\n11.15 오전 7:14'
// 접지 않는다([전체보기]용 보이지 않는 글자 없음). 멘션(@)은 이름 줄 하나뿐이다
if (note.indexOf('\u200b') >= 0 || note.split('@').length !== 2) throw new Error('the enter notice is short with one mention')
if (note !== expected) throw new Error('enter notice layout ' + JSON.stringify(note))
if (note.indexOf('강퇴') >= 0 || note.indexOf('들낙방지') >= 0) throw new Error('notice must not kick')
const mention = joined.sends[0].mention
if (!mention || mention.userId !== '7' || mention.len !== 3 || mention.at !== note.indexOf('홍길동')) {
  throw new Error('one mention of the joiner')
}
const extra = visitMentionExtra(note, mention)
if (extra !== '{"mentions":[{"user_id":7,"at":[1],"len":3}]}') throw new Error('mention attachment ' + extra)
if (extra.split('user_id').length !== 2) throw new Error('the notice mentions one person')
const laterJoin = guardOnChat(firstVisit, {
  kind: 'join', chatId: '555', authorId: '7', authorName: '홍길동',
  profileLink: 'https://open.kakao.com/o/abc', now: t0 + 120000,
})
if (laterJoin.sends.length !== 1) throw new Error('a later join posts again')
const laterText = laterJoin.sends[0].text
// 다시 들어오면 기록이 늘고(옛 → 새), 마지막 줄이 이번 시각이다
if (laterText !== '[입장 안내]\n이름 : @홍길동\n옾링 : https://open.kakao.com/o/abc\n입장 기록 : 2회\n11.15 오전 7:14\n11.15 오전 7:15') throw new Error('a later join adds to the record ' + JSON.stringify(laterText))
if (laterText.indexOf('🖼') >= 0 || laterText.indexOf('img_s.jpg') >= 0) throw new Error('visit notices never show a photo')
// 옾링: 주소 → 주소, '' → 없음, null(오픈프로필인데 읽지 못함) → 확인 못 함
if (linkText(null) !== '확인 못 함') throw new Error('unknown link is not shown as none')
if (linkText('') !== '없음' || linkText(undefined) !== '없음' || linkText('not-a-url') !== '없음') throw new Error('no link is 없음')
if (linkText('https://open.kakao.com/o/abc') !== 'https://open.kakao.com/o/abc') throw new Error('a link is written as is')
// 시각 줄: 카카오톡 시각 표시처럼 오전/오후 h:mm(한국 시간), 모르면 줄이 없다
if (kstClock(Date.UTC(2026, 9, 12, 10, 31)) !== '오후 7:31' || kstClock(Date.UTC(2026, 9, 12, 15, 5)) !== '오전 12:05' ||
  kstClock(Date.UTC(2026, 9, 12, 3, 0)) !== '오후 12:00' || kstClock(Date.UTC(2026, 9, 11, 23, 9)) !== '오전 8:09' || kstClock(0) !== '' || kstClock(undefined) !== '') {
  throw new Error('notice clock line')
}
// 기록 줄: `10.12 오후 7:31`, 가장 최근 기록과 해가 다르면 연도를 붙인다. 최근 5개만, 횟수는 전부
{
  const T = Date.UTC(2026, 9, 12, 10, 31)
  if (kstWhen(T, T) !== '10.12 오후 7:31' || kstWhen(Date.UTC(2025, 11, 31, 14, 0), T) !== '2025.12.31 오후 11:00' || kstWhen(0, T) !== '') throw new Error('record time')
  const seven = [6, 5, 4, 3, 2, 1, 0].map((d) => T - d * 86400000)
  if (recordLines('입장 기록', seven).join('|') !== '입장 기록 : 7회|10.08 오후 7:31|10.09 오후 7:31|10.10 오후 7:31|10.11 오후 7:31|10.12 오후 7:31') throw new Error('record keeps the latest five ' + recordLines('입장 기록', seven).join('|'))
  if (recordLines('입장 기록', []).length !== 0) throw new Error('no times, no record')
}
{
  const unk = guardOnChat(firstVisit, { kind: 'join', chatId: '555', authorId: '9', authorName: '모름', profileLink: null, now: t0 + 130000 })
  if (unk.sends.length !== 1 || unk.sends[0].text.indexOf('\n옾링 : 확인 못 함\n') < 0) throw new Error('visit notice with an unread link ' + JSON.stringify(unk.sends[0] && unk.sends[0].text))
}
if (!laterJoin.sends[0].mention || laterJoin.sends[0].mention.userId !== '7') throw new Error('still one mention')
const laterLeft = guardOnChat(firstVisit, {
  kind: 'leave', chatId: '555', authorId: '7', authorName: '홍길동', now: t0 + 3 * 3600000 + 120000,
})
const leftText = laterLeft.sends.length === 1 ? laterLeft.sends[0].text : ''
if (leftText !== '[퇴장 안내]\n이름 : @홍길동\n옾링 : https://open.kakao.com/o/abc\n퇴장 기록 : 2회\n11.15 오전 7:13\n11.15 오전 10:15') throw new Error('a later leave keeps the open profile and its own record ' + JSON.stringify(leftText))
// 입장·퇴장 시각은 관리 화면 기록에도 모두 남는다
{
  const row = firstVisit.runtime.visit.people['555\u00017']
  if (!row || row.joins.length !== 2 || row.leaves.length !== 2) throw new Error('every join and leave time is kept ' + JSON.stringify(row))
}
// 프로필 변경: 같은 사람(userId 7)이 이름/링크를 바꿔 다시 들어오면 안내는 지금 이름·옾링, 예전 것은 기록에 남는다.
const swapRec = visitRecord()
guardOnChat(swapRec, { kind: 'join', chatId: '555', authorId: '7', authorName: '홍길동',
  profileLink: 'https://open.kakao.com/o/old', now: t0 })
const renamed = guardOnChat(swapRec, { kind: 'join', chatId: '555', authorId: '7', authorName: '김철수',
  profileLink: 'https://open.kakao.com/o/new', now: t0 + 60000 })
const swapText = renamed.sends[0].text
const swapRow = () => swapRec.runtime.visit.people['555\u00017']
if (swapText !== '[입장 안내]\n이름 : @김철수\n옾링 : https://open.kakao.com/o/new\n입장 기록 : 2회\n11.15 오전 7:13\n11.15 오전 7:14') throw new Error('the current name and link are on the notice ' + JSON.stringify(swapText))
if (JSON.stringify(swapRow().changes.map((c) => [c.name, c.link])) !== '[["홍길동","https://open.kakao.com/o/old"]]') throw new Error('the old name and link are kept ' + JSON.stringify(swapRow().changes))
if (renamed.sends[0].mention.userId !== '7') throw new Error('still one mention after a rename')
if (visitMentionExtra(swapText, renamed.sends[0].mention).split('user_id').length !== 2) throw new Error('rename keeps one mention')
// 같은 사람이 그대로 다시 들어오면 변경 이력이 늘지 않는다
guardOnChat(swapRec, { kind: 'join', chatId: '555', authorId: '7', authorName: '김철수',
  profileLink: 'https://open.kakao.com/o/new', now: t0 + 120000 })
if (swapRow().changes.length !== 1) throw new Error('no new change when nothing changed')
// 처음 보는 사람은 변경 이력이 없다
if (firstVisit.runtime.visit.people['555\u00017'].changes.length !== 0) throw new Error('a first sighting has no change log')

// 즉시 감지 (들낙방지와 별개 기능, config.profile): 이미 본 사람(userId 7)이
// 메시지에서 다른 닉으로 나오면 그 즉시 [프로필 변경 감지]를 쏜다.
const liveRec = profileRecord()
const firstSeen = guardOnChat(liveRec, { kind: 'msg', chatId: '555', authorId: '7', authorName: '홍길동',
  text: '안녕하세요', now: t0 })
if (firstSeen.sends.length !== 0) throw new Error('a first sighting only sets a baseline')
const quietMsg = guardOnChat(liveRec, { kind: 'msg', chatId: '555', authorId: '7', authorName: '홍길동',
  text: '또 안녕', now: t0 + 1000 })
if (quietMsg.sends.length !== 0) throw new Error('an unchanged name posts nothing')
const renameMsg = guardOnChat(liveRec, { kind: 'msg', chatId: '555', authorId: '7', authorName: '사기꾼_새닉',
  text: '싸게 팝니다', now: t0 + 2000 })
if (renameMsg.sends.length !== 1) throw new Error('a rename posts one notice at once')
const rtext = renameMsg.sends[0].text
// 관리자 지정 모양(사진): 변경전(＠ — 멘션 아님) · 변경후(@멘션) · 옾링 · 변경 기록(시각만). 메시지에서는 옾링을 모르니 '없음'으로 두고 linkFor 로 봇에게 맡긴다.
const RENAME = '[프로필 변경 감지]\n변경전 : ＠홍길동\n변경후 : @사기꾼_새닉\n옾링 : 없음\n변경 기록 : 1회\n11.15 오전 7:13'
if (rtext !== RENAME) throw new Error('rename notice layout: ' + JSON.stringify(rtext))
if (renameMsg.sends[0].linkFor !== '7') throw new Error('rename notice asks the sender to fill the open profile link')
if (renameMsg.sends[0].mention.userId !== '7') throw new Error('rename notice mentions the person')
{
  const m0 = renameMsg.sends[0].mention
  if (rtext.slice(m0.at, m0.at + m0.len) !== '사기꾼_새닉') throw new Error('rename mention points at the new name')
  const filled = withProfileLink(renameMsg.sends[0], 'https://open.kakao.com/me/abc')
  if (filled.text !== RENAME.replace('옾링 : 없음', '옾링 : https://open.kakao.com/me/abc')) throw new Error('filled rename notice layout')
  if (filled.text.slice(filled.mention.at, filled.mention.at + filled.mention.len) !== '사기꾼_새닉') throw new Error('the mention moves with the filled link')
  if (filled.linkFor || !renameMsg.sends[0].linkFor) throw new Error('filling drops linkFor on the copy only')
  if (withProfileLink(renameMsg.sends[0], 'javascript:alert(1)') !== renameMsg.sends[0]) throw new Error('a bad link is not filled')
}
// 옛 이름의 ＠ 는 멘션 @ 가 아니다 — 멘션은 새 이름 하나
if (visitMentionExtra(rtext, renameMsg.sends[0].mention) !== '{"mentions":[{"user_id":7,"at":[1],"len":6}]}') throw new Error('rename keeps one mention on the new name')
if (renameMsg.sends[0].delayMs !== 0) throw new Error('first profile notice has no wait')
// 한 번 알린 뒤에는 같은 닉으로 또 쏘지 않는다
const after = guardOnChat(liveRec, { kind: 'msg', chatId: '555', authorId: '7', authorName: '사기꾼_새닉',
  text: '또 메시지', now: t0 + 3000 })
if (after.sends.length !== 0) throw new Error('no repeat notice for the same new name')
// 연달아 바꿔도 바뀔 때마다 알린다(누적 횟수는 안내에 적지 않는다)
const twice = guardOnChat(liveRec, { kind: 'msg', chatId: '555', authorId: '7', authorName: '또다른닉',
  text: '세번째', now: t0 + 4000 })
if (twice.sends.length !== 1 || twice.sends[0].text.indexOf('\n변경전 : ＠사기꾼_새닉\n변경후 : @또다른닉\n') < 0) throw new Error('a quick second rename is announced too')
if (twice.sends[0].text.indexOf('누적') >= 0) throw new Error('the rename notice stays short')
const thrice = guardOnChat(liveRec, { kind: 'msg', chatId: '555', authorId: '7', authorName: '세번째닉',
  text: '네번째', now: t0 + 5000 })
if (thrice.sends.length !== 1 || thrice.sends[0].text.indexOf('\n변경전 : ＠또다른닉\n변경후 : @세번째닉\n') < 0) throw new Error('a third rename posts again')
// 처음 보는 사람의 메시지는 기준이 없어 아무것도 안 한다
const stranger = guardOnChat(liveRec, { kind: 'msg', chatId: '555', authorId: '88', authorName: '처음본사람',
  text: '하이', now: t0 + 5000 })
if (stranger.sends.length !== 0) throw new Error('a first-seen chatter is not a rename')
// 기능이 꺼져 있으면 닉이 바뀌어도 조용하다 (전용 토글)
const offRec = profileRecord({ enabled: false })
guardOnChat(offRec, { kind: 'msg', chatId: '555', authorId: '7', authorName: '홍길동', text: 'a', now: t0 })
const offChange = guardOnChat(offRec, { kind: 'msg', chatId: '555', authorId: '7', authorName: '바뀐닉', text: 'b', now: t0 + 1000 })
if (offChange.sends.length !== 0) throw new Error('profile detection stays off until enabled')
// 들낙방지만 켜져 있으면 메시지의 닉 변경은 쏘지 않는다 (두 기능은 독립)
const visitOnly = visitRecord()
guardOnChat(visitOnly, { kind: 'msg', chatId: '555', authorId: '7', authorName: '홍길동', text: 'a', now: t0 })
const visitOnlyChange = guardOnChat(visitOnly, { kind: 'msg', chatId: '555', authorId: '7', authorName: '바뀐닉', text: 'b', now: t0 + 1000 })
if (visitOnlyChange.sends.length !== 0) throw new Error('visit alone does not detect message renames')

const noLeave = visitRecord()
const onlyJoin = guardOnChat(noLeave, {
  kind: 'join', chatId: '555', authorId: '9', authorName: '김', profileLink: 'not-a-url', now: t0,
})
if (onlyJoin.sends[0].text.indexOf('퇴장') >= 0) throw new Error('an enter notice has no leave log')
if (onlyJoin.sends[0].text.indexOf('\n옾링 : 없음\n') < 0) throw new Error('missing link is stated')
if (!onlyJoin.sends[0].mention || onlyJoin.sends[0].mention.userId !== '9') throw new Error('the named person is the mention')
if (onlyJoin.sends[0].delayMs !== 0) throw new Error('first notice has no wait')
const burst = guardOnChat(noLeave, {
  kind: 'join', chatId: '555', authorId: '10', authorName: '이', now: t0 + 100,
})
if (burst.sends.length !== 1 || burst.sends[0].delayMs < 3000) throw new Error('notices keep a gap')
const otherRoom = guardOnChat(noLeave, {
  kind: 'join', chatId: '999', authorId: '10', authorName: '이', now: t0,
})
if (otherRoom.sends.length !== 0) throw new Error('unwatched room stays quiet')
const left = guardOnChat(noLeave, { kind: 'leave', chatId: '555', authorId: '9', authorName: '김', now: t0 + 200 })
if (left.sends.length !== 1 || left.sends[0].text.indexOf('[퇴장 안내]') !== 0) throw new Error('a leave is announced')
if (left.sends[0].text.indexOf('입장 기록') >= 0) throw new Error('a leave notice has no enter log')
if (left.sends[0].delayMs < 3000) throw new Error('a leave waits behind the previous notice')
const repeatJoin = guardOnChat(noLeave, {
  kind: 'join', chatId: '555', authorId: '9', authorName: '김', now: t0 + 500,
})
if (repeatJoin.sends.length !== 0) throw new Error('the same join is not sent twice')

const bigId = '9007199254740993'
const openJoin = visitEventsFromMessage({
  message_type: 0,
  message: `{"feedType":4,"members":[{"userId":${bigId},"nickName":"김ㅇㅇ"}]}`,
})
if (openJoin.length !== 1 || openJoin[0].kind !== 'join' || openJoin[0].authorId !== bigId) {
  throw new Error('open-chat join feed')
}
if (openJoin[0].authorName !== '김ㅇㅇ') throw new Error('open-chat join name')
const openLeave = visitEventsFromMessage({
  message_type: 0,
  message: '{"feedType":2,"member":{"userId":7,"nickName":"홍길동"}}',
})
if (openLeave.length !== 1 || openLeave[0].kind !== 'leave' || openLeave[0].authorId !== '7') {
  throw new Error('open-chat leave feed')
}
const typedJoin = visitEventsFromMessage({
  message_type: 0,
  message: '김ㅇㅇ님이 들어왔습니다.',
  author_id: '42',
})
if (typedJoin.length !== 1 || typedJoin[0].kind !== 'join' || typedJoin[0].authorName !== '김ㅇㅇ') {
  throw new Error('visible join line')
}
const typedLeave = visitEventsFromMessage({
  message_type: 0,
  message: 'ㅇㅇㅇ님이 나갔습니다.',
  author_id: '43',
})
if (typedLeave.length !== 1 || typedLeave[0].kind !== 'leave' || typedLeave[0].authorName !== 'ㅇㅇㅇ') {
  throw new Error('visible leave line')
}
const plainJoin = visitEventsFromMessage({
  message_type: 1,
  message: '홍보ㄱㄱ님이 들어왔습니다.',
})
if (plainJoin.length !== 1 || plainJoin[0].kind !== 'join' || plainJoin[0].authorName !== '홍보ㄱㄱ') {
  throw new Error('plain join sentence')
}
if (plainJoin[0].authorId) throw new Error('a sentence does not need a user id')
const plainLeave = visitEventsFromMessage({ message: '*^*^*님이 나갔습니다.' })
if (plainLeave.length !== 1 || plainLeave[0].kind !== 'leave' || plainLeave[0].authorName !== '*^*^*') {
  throw new Error('plain leave sentence')
}
if (visitEventsFromMessage({ message_type: 1, message: '오늘 들어왔습니다' }).length !== 0) {
  throw new Error('a normal sentence is not a join')
}
const plainPosted = guardOnChat(visitRecord(), {
  kind: plainJoin[0].kind,
  chatId: '555',
  authorId: plainJoin[0].authorId,
  authorName: plainJoin[0].authorName,
  now: t0,
})
if (plainPosted.sends.length !== 1 || plainPosted.sends[0].text.indexOf('홍보ㄱㄱ') < 0) {
  throw new Error('plain sentence posts one notice')
}
if (plainPosted.sends[0].text.indexOf('[입장 안내]') !== 0) throw new Error('plain sentence uses the enter notice')
if (plainPosted.sends[0].text.indexOf('@') >= 0 || plainPosted.sends[0].mention) {
  throw new Error('a sentence without a user id is not a fake mention')
}
if (visitMentionExtra(plainPosted.sends[0].text, plainPosted.sends[0].mention) !== '') {
  throw new Error('a sentence without a user id has no mention attachment')
}
const infoLogs = chatLogsFromBody({
  chatInfo: {
    chatId: '555',
    lastLogId: '900',
    lastChatLog: {
      logId: '900',
      type: 0,
      message: '홍보ㄱㄱ님이 들어왔습니다.',
    },
  },
})
if (infoLogs.length !== 1 || infoLogs[0].chatId !== '555' || infoLogs[0].logId !== '900') {
  throw new Error('the room info log is the current line')
}
const infoJoin = visitEventsFromMessage(infoLogs[0])
if (infoJoin.length !== 1 || infoJoin[0].kind !== 'join' || infoJoin[0].authorName !== '홍보ㄱㄱ') {
  throw new Error('the room info line is a join')
}
const pushedLogs = chatLogsFromBody({
  chatId: '555',
  chatLogs: [{ logId: '901', type: 1, message: '홍보ㄱㄱ님이 들어왔습니다.' }],
})
if (pushedLogs.length !== 1) throw new Error('a feed list is not only a MSG packet')
const pushedJoin = visitEventsFromMessage(pushedLogs[0])
if (pushedJoin.length !== 1 || pushedJoin[0].kind !== 'join' || pushedJoin[0].authorName !== '홍보ㄱㄱ') {
  throw new Error('a feed list line is a join')
}
const countedRoom = visitRecord()
countedRoom.config.visit.rooms = [parseRoomKey('0\u0001검 Fam 1424').key]
countedRoom.rooms = [{ key: parseRoomKey('0\u0001검 Fam').key, chat_id: '555', name: '검 Fam', kind: 'open' }]
const countedJoin = guardOnChat(countedRoom, {
  kind: 'join', chatId: '555', authorId: '', authorName: '홍보ㄱㄱ', now: t0 + 120000,
})
if (countedJoin.sends.length !== 1) throw new Error('member count is not part of the saved room')
const invited = visitEventsFromMessage({
  message_type: 0,
  message: '{"feedType":1,"inviter":{"userId":1,"nickName":"호스트"},"members":[{"userId":2,"nickName":"손님"}]}',
})
if (invited.length !== 1 || invited[0].authorId !== '2' || invited[0].kind !== 'join') {
  throw new Error('an invite counts the guest only')
}
const kickedFeed = visitEventsFromMessage({
  message_type: 0,
  message: '{"feedType":6,"member":{"userId":5,"nickName":"강퇴"}}',
})
if (kickedFeed.length !== 0) throw new Error('a kick feed is not a join notice')
const feedRoom = visitRecord()
const feedLeft = guardOnChat(feedRoom, {
  kind: openLeave[0].kind, chatId: '555', authorId: openLeave[0].authorId,
  authorName: openLeave[0].authorName, now: t0,
})
if (feedLeft.sends.length !== 1 || feedLeft.sends[0].text.indexOf('[퇴장 안내]') !== 0) {
  throw new Error('a feed leave posts one notice')
}
if (!feedLeft.sends[0].text.endsWith('\n퇴장 기록 : 1회\n11.15 오전 7:13') || feedLeft.sends[0].text.indexOf('입장') >= 0) {
  throw new Error('the leave time is on the leave notice')
}
const feedJoin = guardOnChat(feedRoom, {
  kind: openJoin[0].kind, chatId: '555', authorId: '7',
  authorName: '홍길동', profileLink: 'https://open.kakao.com/o/abc', now: t0 + 60000,
})
if (feedJoin.sends.length !== 1 || feedJoin.sends[0].text.indexOf('[입장 안내]') !== 0) {
  throw new Error('a feed join posts one notice')
}
if (!feedJoin.sends[0].mention || feedJoin.sends[0].mention.userId !== '7') throw new Error('the feed mention is the joiner')
const bigExtra = visitMentionExtra(feedJoin.sends[0].text, {
  userId: bigId,
  at: feedJoin.sends[0].text.indexOf('홍길동'),
  len: 3,
})
if (bigExtra !== `{"mentions":[{"user_id":"${bigId}","at":[1],"len":3}]}`) {
  throw new Error('a large open-chat id is an int64 string')
}
const ascii = '[입장 안내]\n이름 : @GOLD_AEC1908\n옾링 : https://open.kakao.com/o/abc\n오후 9:04'
const asciiAt = ascii.indexOf('GOLD_AEC1908')
const asciiExtra = visitMentionExtra(ascii, { userId: '42', at: asciiAt, len: 'GOLD_AEC1908'.length })
const asciiByte = Buffer.byteLength(ascii.slice(0, asciiAt), 'utf8')
if (asciiExtra.indexOf(`[${asciiByte}]`) >= 0) throw new Error('the mention is not a byte span')
if (asciiExtra !== '{"mentions":[{"user_id":42,"at":[1],"len":12}]}') {
  throw new Error('the first mention is ordinal 1')
}
const hostId = visitMemberId('99', 'GOLD_AEC1908', '42', { userId: '42', name: 'GOLD_AEC1908' })
if (hostId.userId !== '42' || hostId.name !== 'GOLD_AEC1908') throw new Error('the member list id is the mention')
const wrongCard = visitMemberId('99', 'GOLD_AEC1908', '', { userId: '99', name: '호스트' })
if (wrongCard.userId || wrongCard.name !== 'GOLD_AEC1908') throw new Error('a different member is not mentioned')
const fresh = visitMemberId('42', 'GOLD_AEC1908', '', { userId: '', name: '' })
if (fresh.userId !== '42') throw new Error('a new member keeps the feed id')
if (feedJoin.sends[0].text.indexOf('7:13') >= 0 || feedJoin.sends[0].text.indexOf('퇴장') >= 0) {
  throw new Error('the leave time stays off the enter notice')
}

const stamped = stampOpenLinkTitles([
  { type: 13, link_id: '42', title: null, display_name: '김, 이', active_members: 8 },
  { type: 'OD', link_id: '7', title: null, display_name: '김', active_members: 2 },
  { type: 2, link_id: '42', title: null, display_name: '김, 이', active_members: 8 },
  { type: 'MultiChat', title: '가족', display_name: '김', active_members: 3 },
], new Map([['42', '검 Fam 1424'], ['7', '프로필']]))
if (stamped[0].title !== '검 Fam 1424' || roomListKind(stamped[0]) !== 'open_room') throw new Error('open multi uses the link name')
if (roomTitle(stamped[0]) !== '검 Fam 1424') throw new Error('link name is the row')
if (stamped[1].title != null) throw new Error('open profile chat is not named here')
if (stamped[2].title !== '검 Fam 1424' || roomListKind(stamped[2]) !== 'open_room') throw new Error('type 2 open multi uses the link name')
if (stamped[3].title !== '가족' || roomListKind(stamped[3]) !== 'normal') throw new Error('a normal room stays out')
// 커뮤니티 타입 방(카카오가 새 type 값을 보냄)도 오픈링크 이름을 받아 목록에 오른다
const community = stampOpenLinkTitles([
  { type: 18, link_id: '77', title: null, display_name: '김, 이, 박', active_members: 120 },
  { type: 'MultiChat', title: null, display_name: '김, 이, 박', active_members: 5 },
], new Map([['77', '주식 커뮤니티']]))
if (community[0].title !== '주식 커뮤니티' || roomListKind(community[0]) !== 'open_room') throw new Error('community room gets its link name')
if (community[1].title != null || roomListKind(community[1]) !== 'normal') throw new Error('a normal group without a link stays out')
const unnamed = stampOpenLinkTitles(
  [{ type: 13, link_id: '1', title: null, display_name: '김, 이', active_members: 4 }],
  new Map(),
)
if (unnamed[0].title != null) throw new Error('missing link name is not invented')
const countedTitle = stampOpenLinkTitles([
  { type: 13, link_id: '9', title: null, display_name: '김', active_members: 1428 },
], new Map([['9', '검 Fam 1428']]))
if (countedTitle[0].title !== '검 Fam' || roomTitle(countedTitle[0]) !== '검 Fam') {
  throw new Error('member count is removed from the open-chat name')
}
if (withoutMemberCount('검 Fam 1424', 8) !== '검 Fam 1424') throw new Error('a real numbered title stays')
// 카카오가 준 오픈링크 이름은 닉네임 목록과 같아도 방 이름이다
const sameAsNick = stampOpenLinkTitles([
  { type: 13, link_id: '9008', title: null, display_name: '홍길동', active_members: 5 },
  { type: 14, link_id: '9022', title: null, display_name: '김, 이', active_members: 50 },
], new Map([['9008', '홍길동'], ['9022', '주식방']]))
if (roomListKind(sameAsNick[0]) !== 'open_room' || roomTitle(sameAsNick[0]) !== '홍길동') throw new Error('a link name equal to the nicknames is the room name')
if (roomTitle(sameAsNick[1]) !== '주식방') throw new Error('a big type 14 room with a link gets its link name')

if (!isProfanity('씨발') || !isProfanity('시 발') || !isProfanity('씨1발') || !isProfanity('씨이발')) {
  throw new Error('profanity is recognized')
}
if (isProfanity('안녕하세요') || isProfanity('시발점') || isProfanity('가보지') || isProfanity('자지마') || isProfanity('날씨 바뀜')) {
  throw new Error('ordinary words are not profanity')
}
const coverRec = {
  config: { cover: { enabled: true, rooms: ['0\u0001검 Fam'] } },
  rooms: [{ key: '0\u0001검 Fam', chat_id: '555', name: '검 Fam' }],
}
const covered = coverPlan(coverRec, { chatId: '555', text: '씨발', logId: '90', messageType: 1, mine: false })
if (!covered || covered.chatId !== '555' || covered.logId !== '90' || covered.type !== 1) throw new Error('profanity is covered')
const replyCover = coverPlan(coverRec, { chatId: '555', text: '병신', logId: '91', messageType: 26, mine: false })
if (!replyCover || replyCover.type !== 26) throw new Error('a profane reply is covered')
if (coverPlan(coverRec, { chatId: '555', text: '안녕', logId: '92', messageType: 1, mine: false })) throw new Error('a normal line stays')
if (coverPlan(coverRec, { chatId: '555', text: '씨발', logId: '93', messageType: 1, mine: true })) throw new Error('own profanity stays')
if (coverPlan(coverRec, { chatId: '555', text: '씨발', logId: '94', messageType: 0, mine: false })) throw new Error('a feed is not covered')
if (coverPlan(coverRec, { chatId: '555', text: '씨발', logId: '', messageType: 1, mine: false })) throw new Error('a cover needs a log id')
if (coverPlan(coverRec, { chatId: '9', text: '씨발', logId: '95', messageType: 1, mine: false })) throw new Error('an unwatched room is not covered')
coverRec.config.cover.enabled = false
if (coverPlan(coverRec, { chatId: '555', text: '씨발', logId: '96', messageType: 1, mine: false })) throw new Error('cover stays off')
coverRec.config.cover.enabled = true
const linkEv = { chatId: '555', text: '여기 https://example.com', logId: '97', messageType: 1, mine: false }
if (!hasCoverLink(linkEv.text) || !coverNeedsAuthor(coverRec, linkEv)) throw new Error('a member link needs the author')
if (coverPlan(coverRec, linkEv)) throw new Error('a link stays until the author is known')
const memberLink = coverPlan(coverRec, Object.assign({}, linkEv, { staff: false }))
if (!memberLink || memberLink.logId !== '97') throw new Error('a member link is covered')
if (coverPlan(coverRec, Object.assign({}, linkEv, { staff: true, logId: '98' }))) throw new Error('a host link stays')
if (!coverSkipsLink(1) || !coverSkipsLink(4) || !coverSkipsLink(null) || coverSkipsLink(2)) throw new Error('host and deputy links stay')
if (!coverPlan(coverRec, { chatId: '555', text: '씨발', logId: '99', messageType: 1, mine: false, staff: true })) {
  throw new Error('staff profanity is still covered')
}

// 금지어 검열: 고객 금지어는 욕설과 같은 접기로 비교한다. 링크는 끌 수 있고, 값이 없으면 켜진 것이다.
const wordRec = {
  config: { cover: { enabled: true, rooms: ['0\u0001검 Fam'], words: ['토토', 'Casino', '  ', '', 7] } },
  rooms: [{ key: '0\u0001검 Fam', chat_id: '555', name: '검 Fam' }],
}
const wordHit = coverPlan(wordRec, { chatId: '555', text: '토토 사이트 홍보', logId: '120', messageType: 1, mine: false, staff: true })
if (!wordHit || wordHit.logId !== '120') throw new Error('a custom banned word is covered, even from staff')
if (!coverPlan(wordRec, { chatId: '555', text: '토 . 토 하실분', logId: '121', messageType: 1, mine: false })) throw new Error('spacing tricks on a custom word are caught')
if (!coverPlan(wordRec, { chatId: '555', text: 'C A S I N O 오픈', logId: '122', messageType: 1, mine: false })) throw new Error('case tricks on a custom word are caught')
if (!coverPlan(wordRec, { chatId: '555', text: '토토토토', logId: '123', messageType: 1, mine: false })) throw new Error('repeated letters on a custom word are caught')
if (coverPlan(wordRec, { chatId: '555', text: '오늘 날씨 좋네요', logId: '124', messageType: 1, mine: false })) throw new Error('a line without a custom word stays')
if (coverPlan(wordRec, { chatId: '555', text: '토토', logId: '125', messageType: 1, mine: true })) throw new Error('own custom word stays')
if (hasCoverWord({ words: ['', '   ', '!!'] }, '아무 말이나 !!')) throw new Error('empty custom words never match')
if (hasCoverWord(null, '토토') || hasCoverWord({}, '토토')) throw new Error('no custom words means no word hit')
if (hasCoverWord({ words: ['토토'] }, '토요일에 만나요')) throw new Error('a doubled-syllable word must not shrink to one syllable and hide unrelated text')
if (!hasCoverWord({ words: ['토토'] }, '토 토 사이트') || !hasCoverWord({ words: ['토토'] }, '토토사이트')) throw new Error('a doubled-syllable word still matches itself, spaced or not')
if (!hasCoverWord({ words: ['이벤트'] }, '무료이벤트 진행중')) throw new Error('a word starting with 이 matches inside a longer phrase')
if (!hasCoverWord({ words: ['아이'] }, '아이가 울어요') || !hasCoverWord({ words: ['고양이'] }, '고양이가 왔다')) throw new Error('a word ending in 이 matches before a particle')
if (!hasCoverWord({ words: ['도박'] }, '도도박 하실분') || !hasCoverWord({ words: ['도박'] }, '도.박')) throw new Error('repeat and punctuation tricks still match a plain word')
if (coverNeedsAuthor(wordRec, { chatId: '555', text: '토토 https://x.com', logId: '126', messageType: 1, mine: false })) {
  throw new Error('a custom word hit does not need the author')
}
const noLinkRec = {
  config: { cover: { enabled: true, rooms: ['0\u0001검 Fam'], words: [], links: false } },
  rooms: [{ key: '0\u0001검 Fam', chat_id: '555', name: '검 Fam' }],
}
const offLink = { chatId: '555', text: '여기 https://example.com', logId: '127', messageType: 1, mine: false }
if (coverNeedsAuthor(noLinkRec, offLink)) throw new Error('links off never asks for the author')
if (coverPlan(noLinkRec, Object.assign({}, offLink, { staff: false }))) throw new Error('links off leaves a member link')
if (!coverPlan(noLinkRec, { chatId: '555', text: '씨발', logId: '128', messageType: 1, mine: false })) throw new Error('links off still covers profanity')
// links 가 없는 예전 설정은 지금처럼 링크를 가린다
if (coverRec.config.cover.links !== undefined) throw new Error('fixture must have no links field')
if (!coverNeedsAuthor(coverRec, Object.assign({}, offLink, { logId: '129' }))) throw new Error('links absent still asks for the author')
if (!coverPlan(coverRec, Object.assign({}, offLink, { logId: '130', staff: false }))) throw new Error('links absent still covers a member link')
const linkOnRec = { config: { cover: Object.assign({}, noLinkRec.config.cover, { links: true }) }, rooms: noLinkRec.rooms }
if (!coverPlan(linkOnRec, Object.assign({}, offLink, { logId: '131', staff: false }))) throw new Error('links on covers a member link')

// 기록 화면: 저장된 runtime 에서 읽고, record 를 고치지 않는다.
const logKey = '0\u0001동네모임'
const logRec = {
  config: {
    visit: { enabled: true, rooms: [logKey] },
    profile: { enabled: true, rooms: [logKey] },
  },
  rooms: [{ key: logKey, chat_id: '555', name: '동네모임', kind: 'open' }],
  runtime: {},
}
guardOnChat(logRec, { kind: 'join', chatId: '555', authorId: '7', authorName: '홍길동', profileLink: 'https://open.kakao.com/o/abc', now: t0 })
guardOnChat(logRec, { kind: 'leave', chatId: '555', authorId: '7', authorName: '홍길동', now: t0 + 120000 })
guardOnChat(logRec, { kind: 'join', chatId: '555', authorId: '7', authorName: '길동이', profileLink: 'https://open.kakao.com/o/abc', now: t0 + 240000 })
guardOnChat(logRec, { kind: 'join', chatId: '555', authorId: '', authorName: '이름만', now: t0 + 60000 })
guardOnChat(logRec, { kind: 'msg', chatId: '555', text: '안녕', authorId: '8', authorName: '철수', messageType: 1, now: t0 + 1000 })
guardOnChat(logRec, { kind: 'msg', chatId: '555', text: '안녕', authorId: '8', authorName: '영희', messageType: 1, now: t0 + 300000 })
guardOnChat(logRec, { kind: 'msg', chatId: '555', text: '안녕', authorId: '9', authorName: '그대로', messageType: 1, now: t0 + 2000 })
// JSON 왕복 뒤에는 두 키가 같은 객체가 아니다 — 저장된 기록이 이 모양이다
const storedLog = JSON.parse(JSON.stringify(logRec))
// 이름이 바뀌기 전 이름 키에 남은 옛 행도 같은 사람으로 합쳐야 한다
if (!storedLog.runtime.visit.people['555\u0001n:홍길동'] || !storedLog.runtime.visit.people['555\u00017']) throw new Error('fixture keeps the old name key')
const before = JSON.stringify(storedLog)
const logs = logsView(storedLog)
if (JSON.stringify(storedLog) !== before) throw new Error('logsView must not change the record')
if (logs.visit.length !== 2) throw new Error('visit log: one row per person per room (' + logs.visit.length + ')')
const hong = logs.visit[0]
if (hong.user_id !== '7' || hong.name !== '길동이' || hong.room !== '동네모임' || hong.chat_id !== '555') throw new Error('visit log: newest person first with the current name')
if (hong.joins.length !== 2 || hong.joins[0] !== t0 || hong.joins[1] !== t0 + 240000) throw new Error('visit log: joins merged oldest first')
if (hong.leaves.length !== 1 || hong.leaves[0] !== t0 + 120000) throw new Error('visit log: leaves kept')
if (hong.link !== 'https://open.kakao.com/o/abc') throw new Error('visit log: open profile link')
if (hong.changes.length !== 1 || hong.changes[0].name !== '홍길동' || hong.changes[0].at !== t0 + 240000) throw new Error('visit log: rename kept')
const nameOnlyRow = logs.visit[1]
if (nameOnlyRow.user_id !== '' || nameOnlyRow.name !== '이름만' || nameOnlyRow.joins[0] !== t0 + 60000) throw new Error('visit log: a name-only person stays')
// 9(그대로)는 바뀐 적이 없어 빠지고, 7 은 입장 닉으로도 바뀐 것이 잡힌다
if (logs.profile.length !== 2 || logs.profile.some((r) => r.user_id === '9')) throw new Error('profile log: only people with a change')
if (logs.profile[1].user_id !== '7' || logs.profile[1].changes[0].name !== '홍길동') throw new Error('profile log: newest change first')
const yh = logs.profile[0]
if (yh.user_id !== '8' || yh.name !== '영희' || yh.room !== '동네모임' || yh.changes.length !== 1 || yh.changes[0].name !== '철수' || yh.changes[0].at !== t0 + 300000) {
  throw new Error('profile log row')
}
if (Object.prototype.hasOwnProperty.call(yh.changes[0], 'link')) throw new Error('profile log changes are {at, name}')
guardFinishHalt(storedLog, '555', true, t0 + 10, '동네모임', 5)
guardFinishHalt(storedLog, '555', false, t0 + 20 * 60 * 1000, '동네모임', 6)
const kickLogs = logsView(storedLog).guard
if (kickLogs.length !== 2 || kickLogs[0].at !== t0 + 20 * 60 * 1000 || kickLogs[0].text.indexOf('권한이 없습니다') < 0) throw new Error('guard log: newest first')
const emptyLogs = logsView({ config: {}, rooms: [], runtime: {} })
if (emptyLogs.visit.length || emptyLogs.profile.length || emptyLogs.guard.length) throw new Error('empty record has empty logs')
const junkLogs = logsView({ rooms: [], runtime: { visit: { people: { bad: { name: 'x', joins: [1] }, ['555\u0001n:']: null } }, profile: { people: [] } } })
if (junkLogs.visit.length !== 0 || junkLogs.profile.length !== 0) throw new Error('malformed runtime rows are skipped')
const oddRooms = logsView({ rooms: { bad: true }, runtime: { visit: { people: { ['555\u00017']: { name: 'p', userId: '7', joins: [t0] } } } } })
if (oddRooms.visit.length !== 1 || oddRooms.visit[0].room !== '') throw new Error('a non-array room list still gives logs, with no room name')
const manyRec = { rooms: [], runtime: { visit: { people: {} } } }
for (let i = 1; i <= 350; i++) manyRec.runtime.visit.people['555\u0001' + i] = { name: 'p' + i, userId: String(i), joins: [t0 + i], leaves: [], changes: [] }
const many = logsView(manyRec).visit
if (many.length !== 300 || many[0].user_id !== '350' || many[0].room !== '') throw new Error('visit log: at most 300, newest first')

const client = new KakaoTalkClient()
await client.login({ oauthToken: 'tok', userId: '42', deviceUuid: 'duuid-test', deviceType: 'tablet' })
if (client.isConnected()) throw new Error('login() must not open a LOCO socket')
const got = client.getCredentials()
if (got.oauthToken !== 'tok' || got.userId !== '42') throw new Error('credentials not restored')

// ── 채팅 버퍼: 오픈프로필 갠톡만 · 대화 불러오기 · 보낸 메시지 기록 ──────────────
// 카카오는 sent_at 을 초로 준다. 버퍼는 밀리초로 들고 있어야 화면 시각이 맞는다.
const SEC = 1700000000
const chatSlot = new Slot('chat-dev', { credentials: { user_id: '111' }, needs_register: false, reason: 'ok' })
chatSlot.client = {
  async getMessages() { return [] },
  async sendMessage() { return { success: true, log_id: '900' } },
  async getChats() {
    return [
      { chat_id: '5', type: 'OD', title: '', display_name: '구매자', active_members: 2, last_message: { sent_at: SEC - 600, message: '이전글' } },
      { chat_id: '6', type: 'OD', title: '', display_name: '새손님', active_members: 2, unread_count: 4, last_message: { sent_at: SEC - 300, message: '문의드려요' } },
      { chat_id: '9', type: 'OM', link_id: '77', active_members: 50, title: '오픈방', display_name: 'a,b', unread_count: 9, last_message: { sent_at: SEC - 900, message: '방글' } },
      { chat_id: '42', type: '2', active_members: 2, title: '친구', display_name: '친구', last_message: { sent_at: SEC - 1200, message: '없음' } },
    ]
  },
}
chatSlot.noteChat('5', { logId: '100', text: '로벅 사려고요', mine: false, at: SEC, author: '구매자', type: 1 })
chatSlot.noteChat('5', { logId: '100', text: '중복', mine: false, at: SEC, author: '구매자', type: 1 })
chatSlot.noteChat('5', { logId: '101', text: '', mine: false, at: SEC + 60, author: '구매자', type: 2 })
chatSlot.noteChat('5', { logId: '102', text: '', mine: false, at: SEC + 90, type: 0 })
const conv5 = chatSlot.inbox.get('5')
if (!conv5 || conv5.list.length !== 2) throw new Error('chat: dedupe/record failed')
if (conv5.unread !== 2) throw new Error('chat: unread count wrong')
if (conv5.lastText !== '(사진)') throw new Error('chat: media preview wrong')
if (conv5.peer !== '구매자') throw new Error('chat: peer not tracked')
if (conv5.list[0].at !== SEC * 1000) throw new Error('chat: 초 단위 sent_at 을 ms 로 바꾸지 않았다')
// 글이 아닌 메시지: 모르는 종류라도 남겨야 손님이 보낸 걸 놓치지 않는다. 피드만 버린다.
chatSlot.noteChat('77', { logId: '401', text: '', mine: false, at: SEC, author: '손님', type: 22 })
const conv77 = chatSlot.inbox.get('77')
if (!conv77 || conv77.list.length !== 1) throw new Error('chat: 이모티콘(22) 을 버렸다')
if (conv77.lastText !== '(이모티콘)') throw new Error('chat: 이모티콘 미리보기가 틀리다')
chatSlot.noteChat('77', { logId: '402', text: '', mine: false, at: SEC + 10, type: 0 })
if (chatSlot.inbox.get('77').list.length !== 1) throw new Error('chat: 피드를 기록했다')
if (conv5.lastAt !== (SEC + 60) * 1000) throw new Error('chat: lastAt 이 ms 가 아니다')

const chatHub = new Hub()
chatHub.accounts.set('chat-dev', chatSlot)
const inbox = await chatHub.inbox('chat-dev')
const row5 = inbox.find((c) => c.chat_id === '5')
if (!row5 || row5.list_kind !== 'open_dm' || row5.name !== '구매자') throw new Error('chat: 갠톡 row wrong')
if (row5.unread !== 2 || row5.last_at !== (SEC + 60) * 1000) throw new Error('chat: inbox merge wrong')
// 받아 둔 기록이 없는 갠톡은 카카오가 세어 둔 안읽음 수를 그대로 보여야 한다
const row6 = inbox.find((c) => c.chat_id === '6')
if (!row6 || row6.unread !== 4) throw new Error('chat: 버퍼가 없을 때 카카오의 안읽음 수를 쓰지 않았다')
// 오픈 단체방과 일반 채팅은 이 목록에 올라오면 안 된다 (손님 갠톡이 묻힌다)
if (inbox.find((c) => c.chat_id === '9')) throw new Error('chat: 오픈 단체방이 목록에 올라왔다')
if (inbox.find((c) => c.chat_id === '42')) throw new Error('chat: 일반 채팅이 목록에 올라왔다')
if (inbox.length !== 2) throw new Error('chat: 갠톡만 올라와야 한다 (' + inbox.length + '개)')
// 갠톡이 아닌 방의 기록은 목록을 읽을 때 버려야 한다
chatSlot.noteChat('9', { logId: '501', text: '단체방 글', mine: false, at: SEC, author: 'x', type: 1 })
if (chatSlot.inbox.has('9')) throw new Error('chat: 단체방 메시지를 버퍼에 담았다')
if (inbox[0].chat_id !== '5') throw new Error('chat: not sorted recent-first')

await chatHub.sendText('chat-dev', '5', '네 가능합니다')
const afterSend = chatSlot.inbox.get('5').list
const mineRow = afterSend[afterSend.length - 1]
if (!mineRow.mine || mineRow.text !== '네 가능합니다') throw new Error('chat: sent not recorded')

const t5 = await chatHub.thread('chat-dev', '5')
if (chatSlot.inbox.get('5').unread !== 0) throw new Error('chat: thread did not clear unread')
if (!t5.length || t5[t5.length - 1].mine !== true) throw new Error('chat: thread order wrong')
const photoRow = t5.find((m) => m.log_id === '101')
if (!photoRow || photoRow.label !== '사진') throw new Error('chat: media label wrong')

// 대화방 불러오기 전에 처음 온 갠톡: 방 하나만 카카오에 물어(CHATINFO) 오픈프로필 1:1 이면 목록에 더한다
{
  const dmRec = {
    credentials: { user_id: '111' }, needs_register: false, reason: 'ok',
    features: { v: 2, macro_until: Date.now() + 3 * 3600000 },
    config: {
      accounts: [],
      triggers: [],
      autoreply: { enabled: true, message: '{이름}님, 문의 감사합니다.', scope: 'ALL', cooldownMs: 6 * 3600000, dailyLimit: 0, hourFrom: 0, hourTo: 24, delayMaxMs: 0 },
    },
    // 같은 이름의 오픈 단체방이 이미 있어도 새 줄의 키는 겹치지 않는다
    rooms: [{ key: parseRoomKey('0\u0001민지').key, chat_id: '500', name: '민지', kind: 'open', list_kind: 'open_room' }],
    runtime: {},
  }
  const asked = []
  const dmSlot = new Slot('dm-new', dmRec)
  dmSlot.client = {
    async getChat(id) {
      asked.push(id)
      if (id === '801') return { chat_id: '801', type: 'OD', display_name: '민지', title: null, link_id: '9301', active_members: 2 }
      if (id === '802') return { chat_id: '802', type: 13, display_name: '가, 나', title: null, link_id: '9302', active_members: 30 }
      if (id === '803') return { chat_id: '803', type: 11, display_name: '친구', title: null, link_id: null, active_members: 2 }
      throw Object.assign(new Error('CHATINFO response missing chatInfo'), { code: 'get_chat_failed' })
    },
  }
  const { value: addedOk, lines: addLines } = await withLog(() => dmSlot.addDirectRoom('801'))
  if (addedOk !== true) throw new Error('new 1:1: an open-profile 1:1 is added')
  const added = dmRec.rooms.find((r) => r.chat_id === '801')
  if (!added || added.list_kind !== 'open_dm' || added.kind !== 'open' || added.name !== '민지' || added.key === dmRec.rooms[0].key) throw new Error('new 1:1: row ' + JSON.stringify(added))
  if (addLines.some((l) => /민지|801/.test(l))) throw new Error('new 1:1: the log has no names or ids')
  const reply = onInbound(dmRec, { chatId: '801', text: '안녕하세요', authorName: '민지', mine: false })
  if (reply.length !== 1 || reply[0].chatId !== '801' || reply[0].text !== '민지님, 문의 감사합니다.') throw new Error('new 1:1: replied ' + JSON.stringify(reply))
  if (onInbound(dmRec, { chatId: '500', text: '안녕하세요', authorName: '철수', mine: false }).length !== 0) throw new Error('new 1:1: the open room of the same name gets no reply')
  if (await dmSlot.addDirectRoom('801')) throw new Error('new 1:1: a listed chat is not asked again')
  if (await dmSlot.addDirectRoom('802')) throw new Error('new 1:1: an open group room is not added')
  if (await dmSlot.addDirectRoom('802')) throw new Error('new 1:1: an open group room is asked once')
  if (await dmSlot.addDirectRoom('803')) throw new Error('new 1:1: a normal 1:1 is not added (scope unchanged)')
  const { value: failed, lines: failLines } = await withLog(() => dmSlot.addDirectRoom('804'))
  if (failed) throw new Error('new 1:1: an unreadable chat is not added')
  if (failLines.some((l) => /804/.test(l))) throw new Error('new 1:1: the failure log has no ids')
  if (asked.join(',') !== '801,802,803,804') throw new Error('new 1:1: asked ' + asked.join(','))
  if (dmRec.rooms.length !== 2) throw new Error('new 1:1: only the 1:1 is added')
  // 11분 뒤: 읽지 못한 방만 다시 묻는다. 갠톡이 아닌 것으로 밝혀진 방은 하루 동안 묻지 않는다
  const realNow = Date.now
  const t0 = realNow()
  Date.now = () => t0 + 11 * 60000
  try {
    await withLog(async () => {
      for (const id of ['802', '803', '804']) await dmSlot.addDirectRoom(id)
    })
  } finally {
    Date.now = realNow
  }
  if (asked.join(',') !== '801,802,803,804,804') throw new Error('new 1:1: only the failed lookup is retried after 10 min ' + asked.join(','))
  // 채팅 화면 목록(catalog)이 이미 단체방으로 아는 방은 묻지 않는다
  dmSlot.catalogCache.list = [{ chat_id: '807', list_kind: 'open_room' }]
  if ((await dmSlot.addDirectRoom('807')) || asked.length !== 5) throw new Error('new 1:1: a chat the catalog knows as a group is not asked')
  dmSlot.catalogCache.list = []
  dmRec.config.autoreply.enabled = false
  if ((await dmSlot.addDirectRoom('805')) || asked.length !== 5) throw new Error('new 1:1: nothing is asked while auto reply is off')
  dmRec.config.autoreply.enabled = true
  dmRec.features.macro_until = Date.now() - 1000
  if ((await dmSlot.addDirectRoom('806')) || asked.length !== 5) throw new Error('new 1:1: nothing is asked after the macro period')
  dmRec.features.macro_until = Date.now() + 3 * 3600000
  // 확실한 1:1 type(OD·14·16)만 더한다: 링크 있는 2명 방이어도 type 2·모르는 type 은 단체방일 수 있어 더하지 않는다(하루 동안 묻지 않음).
  // 상대 이름을 못 읽은 1:1 은 더하지 않고 10분 뒤 다시 묻는다. 매크로 대상에 남은 키는 새 줄이 받지 않는다.
  dmSlot.client.getChat = async (id) => {
    asked.push(id)
    if (id === '811') return { chat_id: '811', type: 2, display_name: '하나', title: null, link_id: '9311', active_members: 2 }
    if (id === '812') return { chat_id: '812', type: 'OC', display_name: '두리', title: null, link_id: '9312', active_members: 2 }
    if (id === '813') return { chat_id: '813', type: 'OD', display_name: null, title: null, link_id: '9313', active_members: 2 }
    if (id === '814') return { chat_id: '814', type: 'OD', display_name: '수진', title: null, link_id: '9314', active_members: 2 }
    if (id === '815') return { chat_id: '815', type: 14, display_name: '가, 나, 다', title: null, link_id: null, active_members: 3 }
    throw Object.assign(new Error('CHATINFO response missing chatInfo'), { code: 'get_chat_failed' })
  }
  dmRec.config.macro = { enabled: true, message: '홍보 글', rooms: ['0\u0001수진'] }
  const before = asked.length
  await withLog(async () => {
    for (const id of ['811', '812', '813', '815']) {
      if (await dmSlot.addDirectRoom(id)) throw new Error('new 1:1: not added ' + id)
    }
  })
  if (dmRec.rooms.some((r) => ['811', '812', '813', '815'].includes(r.chat_id))) throw new Error('new 1:1: unsure or unnamed chats stay out')
  if (macroRoomsDue(dmRec, Date.now()).length !== 0) throw new Error('new 1:1: the stale macro key has no room yet')
  if (!(await withLog(() => dmSlot.addDirectRoom('814'))).value) throw new Error('new 1:1: a named OD chat is added')
  const sj = dmRec.rooms.find((r) => r.chat_id === '814')
  if (!sj || sj.name !== '수진' || sj.key === '0\u0001수진') throw new Error('new 1:1: a stale macro key is not reused ' + JSON.stringify(sj))
  if (macroRoomsDue(dmRec, Date.now()).length !== 0) throw new Error('new 1:1: macro posts never go to the new 1:1')
  const t1 = realNow()
  Date.now = () => t1 + 11 * 60000
  try {
    await withLog(async () => {
      for (const id of ['811', '812', '813', '815']) await dmSlot.addDirectRoom(id)
    })
  } finally {
    Date.now = realNow
  }
  if (asked.slice(before).join(',') !== '811,812,813,815,814,813') throw new Error('new 1:1: only the unnamed 1:1 is asked again ' + asked.slice(before).join(','))
  delete dmRec.config.macro
}

const backfillSlot = new Slot('bf', { credentials: { user_id: '111' }, needs_register: false })
let backfillReads = 0
backfillSlot.client = {
  async getMessages() {
    backfillReads += 1
    return [
      { log_id: '201', message: '백필1', author_id: '222', sent_at: SEC - 20 },
      { log_id: '202', message: '백필2', author_id: '111', sent_at: SEC - 10 },
    ]
  },
}
chatHub.accounts.set('bf', backfillSlot)
const bf = await chatHub.thread('bf', '7')
if (bf.length !== 2 || bf[1].mine !== true) throw new Error('chat: backfill wrong')
// 말풍선을 사람별로 묶으려면 보낸 사람 아이디가 화면까지 가야 한다
if (bf[0].author_id !== '222') throw new Error('chat: 보낸 사람 아이디를 넘기지 않았다')
if (backfillSlot.inbox.get('7').unread !== 0) throw new Error('chat: backfill must not create unread')
// 폴링은 3초마다 같은 방을 읽는다. 과거 글은 처음 한 번만 읽어야 한다.
await chatHub.thread('bf', '7')
await chatHub.thread('bf', '7')
if (backfillReads !== 1) throw new Error('chat: 방을 다시 볼 때마다 과거 글을 또 읽는다 (' + backfillReads + '회)')
// 읽을 글이 없는 방도 한 번만 읽고 만다
const emptySlot = new Slot('empty', { credentials: { user_id: '111' }, needs_register: false })
let emptyReads = 0
emptySlot.client = { async getMessages() { emptyReads += 1; return [] } }
chatHub.accounts.set('empty', emptySlot)
await chatHub.thread('empty', '8')
await chatHub.thread('empty', '8')
if (emptyReads !== 1) throw new Error('chat: 빈 방을 계속 다시 읽는다 (' + emptyReads + '회)')

// ── 대화방 불러오기: 지금 카카오의 방 목록(LCHATLIST) + 오픈링크 이름(INFOLINK) ──────────────
// 로그에 남는 줄을 받아 둔다(방 이름·링크 id 가 남지 않는지 본다).
async function withLog(fn) {
  const lines = []
  const write = process.stderr.write
  process.stderr.write = (s) => { lines.push(String(s)); return true }
  try {
    return { value: await fn(), lines }
  } finally {
    process.stderr.write = write
  }
}
{
  const { Long } = await import('bson')
  const L = (s) => Long.fromString(String(s))
  // 로그인 때 목록(getChats)에는 101 만 있다. 그 뒤 102·103 에 들어갔다.
  const raw = [
    { c: L(101), t: 13, li: L(9101), a: 30, n: 0, k: ['가', '나'], o: 4 },
    { c: L(102), t: 2, li: L(9102), a: 12, n: 0, k: ['다'], o: 3 },
    { c: L(103), t: 'OC', li: L(9103), a: 40, n: 0, k: [], o: 2 },
    { c: L(104), t: 10, a: 5, n: 0, k: ['엄마', '아빠'], o: 1 },
    { c: L(150), li: L(9150), a: 9 },
  ]
  let pages = 0
  let listFail = false
  let stuck = false
  const asked = []
  const session = {
    async getChatList(token) {
      pages++
      if (listFail) throw new Error('LOCO packet timeout: LCHATLIST (15000ms)')
      // stuck: 다음 위치를 무시하고 첫 쪽만 되풀이한다
      const from = stuck ? 0 : Number(token.toString())
      const page = raw.slice(from, from + 2)
      const next = from + page.length
      // 다음 위치는 Long 으로 온다(큰 값은 bson 이 숫자로 바꾸지 않는다)
      return { statusCode: 0, body: { status: 0, chatDatas: page, lastTokenId: L(next), lastChatId: page.length ? page[page.length - 1].c : 0, eof: next >= raw.length } }
    },
    async getOpenLinkInfo(lis) {
      const ids = lis.map((x) => x.toString())
      asked.push(ids)
      // 묶음 답: li 없는 이름 하나(첫 자리)와 9102 하나뿐. 하나씩 물으면 9101 만 답한다.
      if (ids.length > 1) return { statusCode: 0, body: { status: 0, ols: [{ ln: '엉뚱한 이름' }, { li: L(9102), ln: '동네모임', lt: 2 }] } }
      if (ids[0] === '9101') return { statusCode: 0, body: { status: 0, ols: [{ li: L(9101), ln: '검 Fam', lt: 2 }] } }
      throw new Error('LOCO packet timeout: INFOLINK (15000ms)')
    },
  }
  const listSlot = new Slot('list-dev', { credentials: { user_id: '111' }, needs_register: false, reason: 'ok' })
  listSlot.client = {
    async acquireSession() { return session },
    async getChats() { return [{ chat_id: '101', type: 13, link_id: '9101', active_members: 30, title: null, display_name: '가, 나' }] },
  }
  const listHub = new Hub()
  listHub.accounts.set('list-dev', listSlot)
  const { value: rows, lines } = await withLog(() => listHub.chats('list-dev'))
  const row = (id) => rows.find((r) => r.chat_id === id)
  if (pages !== 3) throw new Error('chats: LCHATLIST is read to eof (' + pages + ' pages)')
  if (rows.map((r) => r.chat_id).join(',') !== '101,102,103,104') throw new Error('chats: live list with rooms joined after login, bad row dropped: ' + rows.map((r) => r.chat_id))
  if (row('101').title !== '검 Fam') throw new Error('chats: a link name is matched by li only, then retried alone')
  if (row('102').title !== '동네모임' || row('102').list_kind !== 'open_room') throw new Error('chats: type 2 room named by li')
  if (row('103').list_kind !== 'open_room' || row('103').title !== null) throw new Error('chats: an unnamed community room stays an open room without a made-up name')
  if (row('103').kind !== 'group') throw new Error('chats: an unknown string type with 40 members is a group (no 1:1 auto reply)')
  if (row('104').list_kind !== 'normal') throw new Error('chats: a normal group stays out')
  if (asked.length !== 3 || asked[0].length !== 3 || asked[1][0] !== '9101' || asked[2][0] !== '9103') throw new Error('chats: unnamed links are retried one by one: ' + JSON.stringify(asked))
  const line = lines.find((s) => s.indexOf(' chats ') >= 0) || ''
  if (lines.filter((s) => s.indexOf(' chats ') >= 0).length !== 1) throw new Error('chats: one log line per load')
  if (line.indexOf('live 3p') < 0 || line.indexOf('rows 4 bad 1') < 0 || line.indexOf('unnamed 1') < 0 || line.indexOf('retry 2') < 0) throw new Error('chats: log counts: ' + line)
  if (/동네모임|검 Fam|9101|9102/.test(line)) throw new Error('chats: the log has no names or ids: ' + line)
  // 카카오가 eof 를 붙여 일부만 주면(오픈방이 절반 넘게 한꺼번에 빠짐) 빠진 방을 더한다 — 매크로 방이 사라지지 않게
  {
    const full = raw.slice()
    const extra = [5, 6, 7].map((i) => ({ c: L(110 + i), t: 13, li: L(9110 + i), a: 20, n: 0, k: ['라'], o: 0 }))
    raw.splice(4, 0, ...extra)                 // 오픈방 6개가 있는 목록을 한 번 읽어 둔다
    await withLog(() => listHub.chats('list-dev'))
    raw.length = 0
    raw.push(full[0], full[3])                 // 다음엔 101·104 만(eof) — 오픈방 5개가 한꺼번에 빠짐
    const { value: part, lines: partLines } = await withLog(() => listHub.chats('list-dev'))
    if (part.length !== 7 || !partLines.some((s) => s.indexOf('chats live 1p (partial) + kept 5') >= 0)) throw new Error('chats: a partial list keeps the rooms that vanished at once: ' + part.length + ' ' + partLines.join(' | '))
    raw.length = 0
    raw.push(...full)
    await withLog(() => listHub.chats('list-dev'))   // 지난 목록(오픈방 6개)에서 둘만 빠지면 그대로 쓴다 — 아래 시험을 위해 원래 목록으로
  }
  // 첫 쪽만 되풀이되면 끝까지 읽을 수 없다 → 예전 길(로그인 때 목록)
  stuck = true
  const { value: rep, lines: repLines } = await withLog(() => listHub.chats('list-dev'))
  // 로그인 때 목록(101)에 마지막으로 읽은 카카오 목록에만 있던 방(102~104)을 더한다 — 매크로 방이 사라지지 않게
  if (rep.length !== 4 || !repLines.some((s) => s.indexOf('chats login (LCHATLIST page repeats) + kept 3') >= 0)) throw new Error('chats: a repeating page falls back to getChats and keeps the last live rooms: ' + rep.length + ' ' + repLines.join(' | '))
  // LCHATLIST 가 실패하면 예전 길로 읽는다
  stuck = false
  listFail = true
  const { value: old, lines: oldLines } = await withLog(() => listHub.chats('list-dev'))
  if (old.length !== 4 || old[0].chat_id !== '101' || old[0].title !== '검 Fam') throw new Error('chats: LCHATLIST failure falls back to getChats (+ last live rooms)')
  if (!oldLines.some((s) => s.indexOf('chats login (LOCO packet timeout') >= 0)) throw new Error('chats: the fallback is logged')
}
// 가짜 연결: getChats 는 로그인 때 목록, LCHATLIST 는 지금 목록 — 로그인 뒤 들어간 방도 불러오고 폰에서 나간 방은 뺀다
{
  const FK = await import('./fake.mjs')
  const fs = FK.resetFakeServer()
  fs.chatSnapshot = true
  fs.chatPage = 1
  const uid = FK.fakeUserId('cust-list')
  const member = () => ({ mt: 2, nick: '손님', ptp: 1, pli: null, photo: '', status: null })
  const before = fs.room('roomlistbefore')
  before.members[uid] = member()
  const client = new FK.FakeKakaoClient(fs)
  await client.login({ oauthToken: 'fake-cust', userId: uid, deviceUuid: 'du-cust' })
  await client.acquireSession()
  const after = fs.room('roomlistafter')
  after.members[uid] = member()
  delete before.members[uid]
  const snap = await client.getChats()
  if (!snap.some((c) => c.chat_id === before.chatId) || snap.some((c) => c.chat_id === after.chatId)) throw new Error('fake: getChats is the login snapshot')
  const custSlot = new Slot('cust-list', { credentials: { user_id: uid }, needs_register: false, reason: 'ok' })
  custSlot.client = client
  const custHub = new Hub()
  custHub.accounts.set('cust-list', custSlot)
  const { value: rows } = await withLog(() => custHub.chats('cust-list'))
  const joined = rows.find((r) => r.chat_id === after.chatId)
  if (!joined || joined.list_kind !== 'open_room' || joined.title !== '테스트방 roomlistafter') throw new Error('fake: a room joined after login is listed with its name')
  if (rows.some((r) => r.chat_id === before.chatId)) throw new Error('fake: a room left from the phone is not listed')
  if (rows.length !== 3 || !rows.some((r) => r.title === '가짜 오픈채팅 2')) throw new Error('fake: customer rooms are listed (' + rows.length + ')')
  fs.chatListFail = true
  const { value: old } = await withLog(() => custHub.chats('cust-list'))
  // 카카오 목록을 못 읽으면 로그인 때 목록 + 마지막으로 읽은 카카오 목록에만 있던 방(로그인 뒤 들어간 방)
  if (!old.some((r) => r.chat_id === before.chatId) || !old.some((r) => r.chat_id === after.chatId)) throw new Error('fake: LCHATLIST failure uses the login list and keeps the room joined after login')
  custSlot.client.close()
}

// ════════════════════════════════════════════════════════════════════════════
// 방 설치형 봇(K bot 계정) — docs/ACCOUNTS_V1.md 7.7 의 사례. DB·HTTP 없이 돈다.
// 1~15 는 순수 함수, 16~24 는 9.4 의 가짜 연결(FakeKakaoClient)과 메모리 저장소로 실제 botpool 경로를 탄다.
// ════════════════════════════════════════════════════════════════════════════
{
  const RF = await import('./roomfeat.mjs')
  const F = await import('./features.mjs')
  const Q = await import('./quiz.mjs')
  const { BotPool } = await import('./botpool.mjs')
  const { Long } = await import('bson')
  const FK = await import('./fake.mjs')
  const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms))
  async function waitFor(fn, ms, what) {
    const end = Date.now() + (ms || 5000)
    for (;;) {
      const v = await fn()
      if (v) return v
      if (Date.now() > end) throw new Error('timed out: ' + (what || 'condition'))
      await sleep(20)
    }
  }
  function view(over) {
    const v = Object.assign({
      install_id: 1, chat_id: '555', link_id: '9001', link_name: '동네모임', products: { roombot: true, minigame: false },
      perm: 4, state: 'active', runtime: {}, ring: [],
    }, over || {})
    v.cfg = RF.normRoomConfig(v.config || {})
    return v
  }
  const T = 1_700_000_000_000
  const host = { selfId: '1000', permOf: (id) => (id === '1' ? 1 : id === '4' ? 4 : null) }

  // #1 같은 id 의 입장·퇴장 5번(logId 1~5, 0·5·10·15·20초) → 입장 3·퇴장 2 (60초 중복 회귀)
  {
    const v = view({ config: { visit: { enabled: true } } })
    const rec = RF.adapterRecord(v)
    const kinds = ['join', 'leave', 'join', 'leave', 'join']
    kinds.forEach((kind, i) => {
      F.guardOnChat(rec, { kind, chatId: '555', authorId: '7', authorName: '홍길동', logId: String(i + 1), at: T + i * 5000, now: T + i * 5000 })
    })
    const row = F.logsView(rec).visit[0]
    if (!row || row.joins.length !== 3 || row.leaves.length !== 2) throw new Error('7.7#1 visit counts ' + JSON.stringify(row && [row.joins.length, row.leaves.length]))
  }
  // #2 같은 logId 재생 → 무시. logId 없이 500ms 안 2번 → 1번, 10초 간격 → 2번
  {
    const v = view({ config: { visit: { enabled: true } } })
    const rec = RF.adapterRecord(v)
    const a = F.guardOnChat(rec, { kind: 'join', chatId: '555', authorId: '7', authorName: '홍', logId: '50', at: T, now: T })
    const b = F.guardOnChat(rec, { kind: 'join', chatId: '555', authorId: '7', authorName: '홍', logId: '50', at: T, now: T + 1000 })
    if (a.sends.length !== 1 || b.sends.length !== 0) throw new Error('7.7#2 logId replay')
    const c = F.guardOnChat(rec, { kind: 'leave', chatId: '555', authorId: '8', authorName: '김', at: T, now: T })
    const d = F.guardOnChat(rec, { kind: 'leave', chatId: '555', authorId: '8', authorName: '김', at: T + 500, now: T + 500 })
    const e = F.guardOnChat(rec, { kind: 'leave', chatId: '555', authorId: '8', authorName: '김', at: T + 10500, now: T + 10500 })
    if (c.sends.length !== 1 || d.sends.length !== 0 || e.sends.length !== 1) throw new Error('7.7#2 5 second rule')
    const st = {}
    if (RF.visitDedup(st, '555', { kind: 'join', userId: '7', logId: '9' }, T)) throw new Error('7.7#2 dedup first')
    if (!RF.visitDedup(st, '555', { kind: 'join', userId: '7', logId: '9' }, T)) throw new Error('7.7#2 dedup replay')
  }
  // #3 N=3, M=10: 세 번째 입장에서 멘션 1개 안내, 같은 창의 네 번째는 없음. kick → 강퇴 1개. 제외·방장 → 없음. 이름만 → 경고만
  {
    const cfg = RF.normRoomConfig({ churn: { enabled: true, joins: 3, windowMin: 10, action: 'warn' }, exempt: [{ user_id: '77', name: '제외' }] })
    const st = {}
    const ev = (i, extra) => Object.assign({ kind: 'join', userId: '7', name: '홍길동', at: T + i * 60000 }, extra || {})
    if (RF.churnCheck(st, cfg, ev(0), host, T) || RF.churnCheck(st, cfg, ev(1), host, T)) throw new Error('7.7#3 early')
    const plan = RF.churnCheck(st, cfg, ev(2), host, T)
    if (!plan || plan.count !== 3 || plan.action !== 'warn') throw new Error('7.7#3 third join')
    const n = RF.churnNotice(plan, 'warn', T)
    if (n.text.split('@').length !== 2 || !n.mention || n.mention.userId !== '7') throw new Error('7.7#3 one mention')
    if (n.text !== '[들낙 감지]\n이름 : @홍길동\n입장 : 10분 동안 3회\n조치 : 경고\n' + RF.kstClock(T) || !hasClock(n.text)) throw new Error('7.7#3 notice layout ' + n.text)
    if (F.visitMentionExtra(n.text, n.mention).split('user_id').length !== 2) throw new Error('7.7#3 mention extra')
    if (RF.churnCheck(st, cfg, ev(3), host, T)) throw new Error('7.7#3 fourth in same window')
    const kcfg = RF.normRoomConfig({ churn: { enabled: true, joins: 3, windowMin: 10, action: 'kick' } })
    const ks = {}
    let kp = null
    for (let i = 0; i < 3; i++) kp = RF.churnCheck(ks, kcfg, ev(i), host, T)
    if (!kp || kp.action !== 'kick' || kp.userId !== '7') throw new Error('7.7#3 kick plan')
    if (RF.churnNotice(kp, 'kicked').text.indexOf('조치 : 내보내기') < 0) throw new Error('7.7#3 kicked line')
    if (RF.churnNotice(kp, 'kick_failed').text.indexOf('조치 : 내보내기 실패') < 0) throw new Error('7.7#3 kick failed line')
    const xs = {}
    for (let i = 0; i < 4; i++) {
      if (RF.churnCheck(xs, cfg, ev(i, { userId: '77' }), host, T)) throw new Error('7.7#3 exempt')
      if (RF.churnCheck(xs, cfg, ev(i, { userId: '1' }), host, T)) throw new Error('7.7#3 host')
    }
    const ns = {}
    let np = null
    for (let i = 0; i < 3; i++) np = RF.churnCheck(ns, kcfg, ev(i, { userId: '' }), host, T)
    if (!np || np.action !== 'warn' || !np.idUnknown) throw new Error('7.7#3 name only warns')
    if (RF.churnNotice(np, 'warn').mention) throw new Error('7.7#3 name only has no mention')
  }
  // #4 시각은 ev.at 기준(뒤늦게 채운 묶음이 하나로 뭉치지 않음)
  {
    const cfg = RF.normRoomConfig({ churn: { enabled: true, joins: 3, windowMin: 10 } })
    const st = {}
    let p = null
    for (let i = 0; i < 3; i++) p = RF.churnCheck(st, cfg, { kind: 'join', userId: '9', name: 'a', at: T + i * 6 * 60000 }, host, T + 3600000)
    if (p) throw new Error('7.7#4 backfilled joins spread over 12 minutes are not one burst')
    const v = view({ config: { visit: { enabled: true } } })
    const rec = RF.adapterRecord(v)
    for (let i = 0; i < 3; i++) F.guardOnChat(rec, { kind: 'join', chatId: '555', authorId: '9', authorName: 'a', at: T + i * 60000, now: T + 999999 })
    const row = F.logsView(rec).visit[0]
    if (row.joins.length !== 3 || row.joins[0] !== T || row.joins[2] !== T + 120000) throw new Error('7.7#4 visit times are ev.at')
  }
  // #5 id 있는 퇴장 → 강퇴. id 없음 → kick_fail. 제외 → 없음. 실패 → bans, 그 id 재입장 → 강퇴. 피드 6 → 없음
  {
    const cfg = RF.normRoomConfig({ leaveKick: { enabled: true }, exempt: [{ user_id: '77', name: 'x' }] })
    const k = RF.leaveKickPlan(cfg, { kind: 'leave', userId: '7', name: '홍' }, host)
    if (!k || k.type !== 'kick' || k.userId !== '7') throw new Error('7.7#5 kick plan')
    const f = RF.leaveKickPlan(cfg, { kind: 'leave', userId: '', name: '홍' }, host)
    if (!f || f.type !== 'kick_fail' || f.note !== 'id 없음') throw new Error('7.7#5 no id')
    if (RF.leaveKickPlan(cfg, { kind: 'leave', userId: '77', name: 'x' }, host)) throw new Error('7.7#5 exempt')
    if (RF.leaveKickPlan(cfg, { kind: 'leave', userId: '4', name: 'x' }, host)) throw new Error('7.7#5 deputy')
    if (RF.leaveKickPlan(cfg, { kind: 'join', userId: '7', name: '홍' }, host)) throw new Error('7.7#5 join is not a leave')
    const st = {}
    RF.noteBan(st, '7', '홍', T)
    if (!RF.bannedNow(st, '7', T + 1000) || RF.bannedNow(st, '7', T + 31 * 86400000)) throw new Error('7.7#5 bans 30 days')
    const kicked = F.visitEventsFromMessage({ message_type: 0, message: '{"feedType":6,"members":[{"userId":7,"nickName":"홍"}]}' })
    if (kicked.length !== 0) throw new Error('7.7#5 kick feed is not a leave')
  }
  // #6 사진만 바뀜 → 안내·기록 없음(사진은 뺐다. 예전 설정 photo:true 도). 상태 null → 없음. 첫 관찰 → 없음. 바로 또 바뀌어도 매번 안내
  {
    const rt = {}
    const pcfg = { name: true, photo: true, status: true }
    const P1 = 'https://k.kakaocdn.net/dn/a/1.jpg'
    const P2 = 'https://k.kakaocdn.net/dn/a/2.jpg'
    if (RF.profileObserve(rt, '555', pcfg, { userId: '7', name: '홍', photo: P1 + '?t=1', status: null }, T).length) throw new Error('7.7#6 first')
    if (RF.profileObserve(rt, '555', pcfg, { userId: '7', name: '홍', photo: P2 + '?t=2', status: null }, T + 1000).length) throw new Error('7.7#6 photo change is not announced')
    if (RF.profileObserve(rt, '555', pcfg, { userId: '7', name: '홍', photo: P2, status: null }, T + 2000).length) throw new Error('7.7#6 status null')
    if (JSON.stringify(rt).indexOf('kakaocdn') >= 0) throw new Error('7.7#6 photos are not stored')
    RF.profileObserve(rt, '555', pcfg, { userId: '8', name: '김', status: '안녕' }, T)
    const stc = RF.profileObserve(rt, '555', pcfg, { userId: '8', name: '김', status: '바이' }, T + 1)
    if (stc.length !== 1 || stc[0].text.indexOf('\n이름 : @김\n상태 메시지 변경전 : 안녕\n상태 메시지 변경후 : 바이\n') < 0) throw new Error('7.7#6 status ' + JSON.stringify(stc[0] && stc[0].text))
    // 바로 또 바뀌어도 알린다
    const st2 = RF.profileObserve(rt, '555', pcfg, { userId: '8', name: '김', status: '다시' }, T + 2)
    if (st2.length !== 1 || st2[0].text.indexOf('\n상태 메시지 변경전 : 바이\n상태 메시지 변경후 : 다시\n') < 0) throw new Error('7.7#6 every change is announced')
    // 관찰한 곳에서 옾링을 알면 바로 적고 linkFor 는 없다
    const wl = RF.profileObserve(rt, '555', pcfg, { userId: '8', name: '김새닉', status: '다시', link: 'https://open.kakao.com/me/kim' }, T + 6 * 60000)
    if (wl.length !== 1 || wl[0].text !== '[프로필 변경 감지]\n변경전 : ＠김\n변경후 : @김새닉\n옾링 : https://open.kakao.com/me/kim\n변경 기록 : 3회\n11.15 오전 7:13\n11.15 오전 7:13\n11.15 오전 7:19' || wl[0].linkFor) throw new Error('7.7#6 known link is written at once ' + JSON.stringify(wl[0] && wl[0].text))
    if (wl[0].text.slice(wl[0].mention.at, wl[0].mention.at + wl[0].mention.len) !== '김새닉') throw new Error('7.7#6 mention points at the current name')
    // 예전에 저장된 사진 변경 기록은 기록 화면에 나오지 않고, 다음 변경 때 기록에서도 빠진다
    const k8 = Object.keys(rt.profile.people).find((k) => rt.profile.people[k].userId === '8')
    rt.profile.people[k8].changes.unshift({ at: T - 5, kind: 'photo' })
    const rows = F.logsView({ rooms: [{ key: 'r', chat_id: '555', name: '방' }], runtime: rt }).profile
    if (!rows.some((r) => r.changes.some((c) => c.kind === 'status')) || rows.some((r) => r.changes.some((c) => c.kind === 'photo'))) throw new Error('7.7#5 profile log has kind, no photo')
    const wl2 = RF.profileObserve(rt, '555', pcfg, { userId: '8', name: '김새닉', status: '또' }, T + 7 * 60000)
    if (wl2.length !== 1 || wl2[0].text.indexOf('\n상태 메시지 변경전 : 다시\n상태 메시지 변경후 : 또\n') < 0) throw new Error('7.7#6 status change ' + JSON.stringify(wl2[0] && wl2[0].text))
    if (rt.profile.people[k8].changes.some((c) => c.kind === 'photo') || rt.profile.people[k8].changes.length !== 4) throw new Error('7.7#6 old photo changes are dropped ' + JSON.stringify(rt.profile.people[k8].changes))
    if (RF.normRoomConfig({ profile: { enabled: true, photo: true } }).profile.photo !== undefined) throw new Error('7.7#6 a saved photo option is dropped')
  }
  // #7 조회: 방장 → 기록 문구, staff 에서 일반 → 없음, 멘션 id 우선, 동명이인 → 같은 이름 문구
  {
    const rt = {}
    const cfg = RF.normRoomConfig({ profile: { enabled: true, lookup: 'staff' } })
    const pc = cfg.profile
    RF.profileObserve(rt, '555', pc, { userId: '7', name: '홍길동' }, T)
    RF.profileObserve(rt, '555', pc, { userId: '7', name: '길동이' }, T + 60000)
    RF.profileObserve(rt, '555', pc, { userId: '8', name: '같은이름' }, T)
    RF.profileObserve(rt, '555', pc, { userId: '9', name: '같은이름' }, T)
    const ok = RF.profileLookup(rt, '555', cfg, { authorId: '1', arg: '길동이', mentions: [] }, host, T + 120000)
    if (!ok || ok.indexOf('[프로필 기록]') !== 0 || ok.indexOf('이전 이름 : 홍길동') < 0) throw new Error('7.7#7 host lookup ' + ok)
    if (RF.profileLookup(rt, '555', cfg, { authorId: '50', arg: '길동이', mentions: [] }, host, T) !== null) throw new Error('7.7#7 staff only')
    const byMention = RF.profileLookup(rt, '555', cfg, { authorId: '1', arg: '같은이름', mentions: ['7'] }, host, T)
    if (byMention.indexOf('이름 : 길동이') < 0) throw new Error('7.7#7 mention wins')
    if (RF.profileLookup(rt, '555', cfg, { authorId: '1', arg: '같은이름', mentions: [] }, host, T) !== '같은 이름을 쓰는 사람이 2명 있어요. @멘션으로 골라 주세요.') {
      throw new Error('7.7#7 same name')
    }
    // 기록 없는 사람: 이름으로 물으면 그 이름, 멘션으로 물으면 자리표시 단어 없이(문장 점검 203)
    if (RF.profileLookup(rt, '555', cfg, { authorId: '1', arg: '없는사람', mentions: [] }, host, T) !== '「없는사람」의 프로필 기록이 없어요.') throw new Error('7.7#7 no record by name')
    if (RF.profileLookup(rt, '555', cfg, { authorId: '1', arg: '', mentions: ['999'] }, host, T) !== '이 사람의 프로필 기록이 없어요.') throw new Error('7.7#7 no record by mention')
    if (RF.profileLookup(rt, '555', cfg, { authorId: '1', arg: '', mentions: [] }, host, T) !== '「!프로필조회 @닉네임」처럼 입력해 주세요.') throw new Error('7.7#7 usage')
    if (!/\n최근 14일 : 입장 \d+회 · 퇴장 \d+회$/.test(ok)) throw new Error('7.7#7 14-day line ' + ok)
  }
  // #8 홍보: 71 위반, 26(인용에만 링크) 아님, 1+https:// 위반, 2 는 media 켰을 때만. 방장·제외 아님. 1/3·2/3 가림, 3/3 강퇴. resetHours 뒤 1부터
  {
    const cfg = RF.normRoomConfig({ promo: { enabled: true, kickAt: 3, resetHours: 24 }, exempt: [{ user_id: '77', name: '' }] })
    const pv = (ev) => RF.promoViolation(cfg, Object.assign({ userId: '7', name: '홍' }, ev), host)
    if (pv({ type: 71, text: '' }) !== 'card') throw new Error('7.7#8 card')
    if (pv({ type: 26, text: '네', attachment: '{"src_message":"https://x.com"}' })) throw new Error('7.7#8 reply quote')
    if (pv({ type: 1, text: '여기 https://x.com' }) !== 'link') throw new Error('7.7#8 link')
    if (pv({ type: 2, text: '' })) throw new Error('7.7#8 media off')
    const mcfg = RF.normRoomConfig({ promo: { enabled: true, media: true } })
    if (RF.promoViolation(mcfg, { userId: '7', type: 2, text: '' }, host) !== 'media') throw new Error('7.7#8 media on')
    if (RF.promoViolation(cfg, { userId: '1', type: 1, text: 'https://x.com' }, host)) throw new Error('7.7#8 host')
    if (RF.promoViolation(cfg, { userId: '77', type: 1, text: 'https://x.com' }, host)) throw new Error('7.7#8 exempt')
    const st = {}
    const e = { userId: '7', name: '홍', type: 1, text: 'https://x.com' }
    const p1 = RF.promoCheck(st, cfg, e, host, T)
    const p2 = RF.promoCheck(st, cfg, e, host, T + 20000)
    const p3 = RF.promoCheck(st, cfg, e, host, T + 40000)
    if (p1.n !== 1 || p1.kick || !p1.hide || p2.n !== 2 || p2.kick || p3.n !== 3 || !p3.kick) throw new Error('7.7#8 1/3 2/3 3/3')
    if (RF.promoNotice(p1, { hidden: true }).text !== '[홍보 금지]\n이름 : @홍\n경고 : 1회 (3회가 되면 내보내요)\n조치 : 글 가리기') throw new Error('7.7#8 notice')
    if (RF.promoNotice(p3, { hidden: true, kicked: true }).text !== '[홍보 금지]\n이름 : @홍\n경고 : 3회\n조치 : 내보내기') throw new Error('7.7#8 kicked notice')
    if (RF.promoNotice(p1, { hidden: true }, T).text !== '[홍보 금지]\n이름 : @홍\n경고 : 1회 (3회가 되면 내보내요)\n조치 : 글 가리기\n' + RF.kstClock(T)) throw new Error('7.7#8 notice ends with the time')
    if (RF.leaveKickNotice('홍', T) !== '[재입장 차단]\n이름 : 홍\n' + RF.kstClock(T)) throw new Error('7.7#8 leave kick notice ends with the time')
    RF.promoCheck(st, cfg, e, host, T + 50000)
    const later = RF.promoCheck(st, cfg, e, host, T + 50000 + 25 * 3600000)
    if (later.n !== 1) throw new Error('7.7#8 reset after resetHours')
  }
  // #9 홍보 링크 켬 → 금지어 검열은 링크를 놔두고 욕설은 가림
  {
    const v = view({ config: { promo: { enabled: true, links: true }, cover: { enabled: true, links: true } } })
    const rec = RF.adapterRecord(v)
    if (rec.config.cover.links !== false) throw new Error('7.7#9 cover links off while promo links on')
    if (F.coverPlan(rec, { chatId: '555', text: '여기 https://x.com', logId: '91', messageType: 1, mine: false, staff: false })) throw new Error('7.7#9 link left to promo')
    if (!F.coverPlan(rec, { chatId: '555', text: '씨발', logId: '92', messageType: 1, mine: false })) throw new Error('7.7#9 profanity still covered')
  }
  // #10 링 350개 → 최근 300. !가리기 5 → 방장 아닌 최근 5개(명령 글 제외). 멘션 → 그 사람. 999 → 300, 0·글자 → 사용법
  {
    const ring = []
    for (let i = 1; i <= 350; i++) RF.ringPush(ring, { logId: String(1000 + i), type: 1, authorId: i % 10 === 0 ? '1' : String(100 + (i % 3)), name: 'n', at: i })
    if (ring.length !== 300 || ring[0].logId !== '1051') throw new Error('7.7#10 ring keeps the newest 300')
    RF.ringPush(ring, { logId: '2000', type: 1, authorId: '101', name: 'n', at: 9999, cmd: true })
    const plan = RF.hidePlan(ring, { last: 5 }, host)
    if (plan.length !== 5 || plan.some((x) => x.logId === '2000') || plan.some((x) => ring.find((m) => m.logId === x.logId).authorId === '1')) {
      throw new Error('7.7#10 last 5')
    }
    const who = RF.hidePlan(ring, { userId: '102' }, host)
    if (!who.length || who.some((x) => ring.find((m) => m.logId === x.logId).authorId !== '102')) throw new Error('7.7#10 one person')
    const c1 = RF.parseHideCommand('!가리기 5', '!', [])
    const c2 = RF.parseHideCommand('!가리기 @홍', '!', ['7'])
    const c3 = RF.parseHideCommand('!가리기 999', '!', [])
    if (c1.last !== 5 || c2.userId !== '7' || c3.last !== 300) throw new Error('7.7#10 parse')
    if (!RF.parseHideCommand('!가리기 0', '!', []).usage || !RF.parseHideCommand('!가리기 많이', '!', []).usage) throw new Error('7.7#10 usage')
    if (RF.parseHideCommand('!가리기싫다', '!', []) !== null || RF.parseHideCommand('/가리기 3', '!', []) !== null) throw new Error('7.7#10 not a command')
    if (RF.hideUsage('!') !== '「!가리기 30」처럼 가릴 글 수(1~300)를 입력해 주세요. 한 사람의 글은 「!가리기 @이름」으로 가릴 수 있어요.') throw new Error('7.7#10 usage text')
    if (RF.hideDoneNotice(4, 1) !== '[글 가리기]\n글 4개를 가렸어요.\n(1개는 가리지 못했어요)') throw new Error('7.7#10 done text')
  }
  // #11 금지어 300개 통과·301번째 거절, 300개로 일치 동작
  {
    const words = Array.from({ length: 301 }, (_, i) => '금지' + i)
    if (RF.checkRoomConfig({ cover: { words: words.slice(0, 300) } }).ok !== true) throw new Error('7.7#11 300 pass')
    const bad = RF.checkRoomConfig({ cover: { words } })
    if (bad.ok || bad.error !== '금지어는 300개까지 등록할 수 있습니다.') throw new Error('7.7#11 301 rejected')
    const cfg = RF.normRoomConfig({ cover: { enabled: true, words } })
    if (cfg.cover.words.length !== 300) throw new Error('7.7#11 sender clamps to 300')
    const rec = RF.adapterRecord(view({ config: { cover: { enabled: true, words: words.slice(0, 300) } } }))
    if (!F.coverPlan(rec, { chatId: '555', text: '이건 금지299 입니다', logId: '93', messageType: 1, mine: false })) throw new Error('7.7#11 300th word matches')
  }
  // #12
  if (RF.locoOk({ statusCode: 0, body: { status: -203 } }) !== false || RF.locoOk({ statusCode: 0, body: {} }) !== true || RF.locoOk({ statusCode: -1, body: {} })) {
    throw new Error('7.7#12 locoOk')
  }
  // #13 미니게임: 방 A 하루 한도가 방 B 를 막지 않음. 끈 게임 → 사용 중지 문구. 이름 빈 두 사람 점수 분리
  {
    const mk = (cfg) => {
      const v = view({ products: { roombot: false, minigame: true }, config: cfg })
      const rec = RF.adapterRecord(v)
      rec.config.minigame.cooldownMs = 0
      return { v, rec }
    }
    const A = mk({ games: { dailyLimit: 1 } })
    const B = mk({ games: { dailyLimit: 1 } })
    const say = (x, text, id, name) => F.onInbound(x.rec, { chatId: '555', text, authorName: name == null ? '홍' : name, authorId: id || '7', mine: false })
    if (say(A, '!주사위').length !== 1 || say(A, '!주사위').length !== 0) throw new Error('7.7#13 room A daily limit')
    if (say(B, '!주사위').length !== 1) throw new Error('7.7#13 room B is not blocked by room A')
    const off = mk({ games: { dice: false } })
    const o = say(off, '!주사위')
    if (o.length !== 1 || o[0].text !== '이 방에서는 주사위가 꺼져 있어요.') throw new Error('7.7#13 disabled game')
    // 미니게임 답 문구(문장 점검 213~229): 해요체, 조사는 받침에 맞춤, 명령어는 「」 안에
    {
      const W = mk({})
      const one = (text, id, name) => { const r = say(W, text, id, name); return r.length ? r[0].text : '' }
      const st = one('!끝말잇기')
      if (!/^끝말잇기를 시작해요\. 첫 단어는 「[가-힣]+」(예요|이에요)\.\n'[^']+'(로|으로) 시작하는 단어를 30초 안에 입력해 주세요\. \(그만하기 : !포기\)$/.test(st)) throw new Error('7.7#13 word start ' + st)
      if (one('!숫자야구') !== '다른 게임이 진행 중이에요. 「!포기」로 끝낸 뒤 시작해 주세요.') throw new Error('7.7#13 busy')
      const first = W.v.runtime.games.r.word
      const reveal = one('!정답')
      if (reveal !== `지금 이을 단어는 「${first}」${RF.josa(first, '이에요')}.`) throw new Error('7.7#13 word reveal ' + reveal)
      const quit = one('!포기')
      if (quit !== `게임을 끝냈어요. 마지막 단어는 「${first}」${RF.josa(first, '이었어요')}.`) throw new Error('7.7#13 give up ' + quit)
      if (one('!포기') !== '진행 중인 게임이 없어요.') throw new Error('7.7#13 nothing to give up')
      if (one('!주사위 0') !== '주사위 면 수는 1~100 사이로 입력해 주세요. (예: 「!주사위 20」)') throw new Error('7.7#13 dice usage')
      if (one('!가위바위보 손') !== '「!가위바위보 가위」처럼 입력해 주세요. (가위 · 바위 · 보)') throw new Error('7.7#13 rps usage')
      if (!/^봇 : (가위|바위|보) \/ 홍님 : 보 → (무승부|봇 승리|홍님 승리 \(\+1점, 누적 \d+점\))$/.test(one('!가위바위보 보'))) throw new Error('7.7#13 rps result')
      const qs = one('!퀴즈')
      if (!/^\[퀴즈\] .+\n정답을 입력해 주세요\. \(힌트 : !힌트 · 정답 보기 : !정답\)$/.test(qs)) throw new Error('7.7#13 quiz start ' + qs)
      const qa = Q.answer(W.v.runtime.games.r.quiz)
      if (one('!정답') !== `정답은 「${qa}」${RF.josa(qa, '이에요')}.`) throw new Error('7.7#13 quiz reveal')
      one('!숫자야구')
      const secret = W.v.runtime.games.r.secret
      if (one('112') !== '숫자 3개는 서로 달라야 해요.') throw new Error('7.7#13 baseball repeat digits')
      if (!new RegExp('^정답이에요\\. ' + secret + ' \\(1번 만에\\) · 홍님 \\+5점 \\(누적 \\d+점\\)$').test(one(secret))) throw new Error('7.7#13 baseball win')
      if (!/^\[랭킹\]\n1\. 홍 \d+점$/.test(one('!랭킹'))) throw new Error('7.7#13 ranking header')
      if (!/^홍님의 누적 점수는 \d+점이에요\.$/.test(one('!점수'))) throw new Error('7.7#13 score')
      if (one('!주사위', '8', '') .indexOf('참가자님 ') !== 0) throw new Error('7.7#13 nameless player is 참가자')
    }
    const S = mk({})
    for (const id of ['301', '302']) {
      say(S, '!퀴즈', id, '')
      const g = S.v.runtime.games.r
      say(S, Q.answer(g.quiz), id, '')
    }
    const board = S.v.runtime.scores.r
    if (board['301'] !== 2 || board['302'] !== 2 || Object.keys(board).length !== 2) throw new Error('7.7#13 scores by author id ' + JSON.stringify(board))
    if (RF.rankingOf(S.v.runtime).length !== 2) throw new Error('7.7#13 ranking keeps two nameless people')
  }
  // #14 격리: 방 A 어댑터의 logsView 에 방 B 기록 없음
  {
    const a = view({ install_id: 1, chat_id: '601', config: { visit: { enabled: true } } })
    const b = view({ install_id: 2, chat_id: '602', config: { visit: { enabled: true } } })
    F.guardOnChat(RF.adapterRecord(b), { kind: 'join', chatId: '602', authorId: '5', authorName: 'b', now: T })
    F.guardOnChat(RF.adapterRecord(a), { kind: 'join', chatId: '602', authorId: '6', authorName: 'x', now: T })
    if (F.logsView(RF.adapterRecord(a)).visit.length !== 0 || F.logsView(RF.adapterRecord(b)).visit.length !== 1) throw new Error('7.7#14 isolation')
  }
  // #15 v2 권리: macro_until 지난 고객 기록 → 매크로 없음. legacy_room_until 0 → visitRoom null
  {
    const key = parseRoomKey('0\u0001공지').key
    const rec2 = {
      features: { v: 2, macro_until: Date.now() - 1000, legacy_room_until: 0 },
      config: {
        accounts: [],
        macro: { enabled: true, message: '안녕', rooms: [key], baseMin: 1, minMessages: 0 },
        triggers: [{ id: 't1', enabled: true, pattern: '가격', mode: 'contains', reply: '안내', rooms: [] }],
        visit: { enabled: true, rooms: [key] },
      },
      rooms: [{ key, chat_id: '12345', name: '공지', kind: 'group' }],
      runtime: {},
    }
    if (onInbound(rec2, { chatId: '12345', text: '가격', authorName: '김', mine: false }).length !== 0) throw new Error('7.7#15 expired macro')
    if (macroRoomsDue(rec2, Date.now()).length !== 0) throw new Error('7.7#15 expired macro loop')
    if (F.visitNeedsProfile(rec2, '12345')) throw new Error('7.7#15 legacy room features off')
    rec2.features.macro_until = Date.now() + 60000
    rec2.features.legacy_room_until = Date.now() + 60000
    if (onInbound(rec2, { chatId: '12345', text: '가격', authorName: '김', mine: false }).length !== 1) throw new Error('7.7#15 live macro')
    if (!F.visitNeedsProfile(rec2, '12345')) throw new Error('7.7#15 legacy grace')
  }

  // #40-1 방 관리 명령어 읽기(roomcmd.parseRoomCommand) · 사람 고르기(findPerson) · 설정 바꾸기(configChange) — 순수 함수
  {
    const RC = await import('./roomcmd.mjs')
    const P = (t) => RC.parseRoomCommand(t, '!')
    const eq = (a, b, what) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error('#40-1 ' + what + ' ' + JSON.stringify(a)) }
    eq(P('!옾링 @하늘'), { cmd: 'link', arg: '@하늘' }, 'link')
    eq(P('!옾링'), { cmd: 'link', arg: '' }, 'link usage')
    eq(P('!프로필조회 하늘'), { cmd: 'profile', arg: '하늘' }, 'profile')
    eq(P('!프로필 하늘'), { cmd: 'profile', arg: '하늘' }, 'profile alias')
    eq(P('!프로필 조회 하늘'), { cmd: 'profile', arg: '하늘' }, 'profile spaced')
    eq(P('!내보내기 https://open.kakao.com/o/sAbc'), { cmd: 'kick', arg: 'https://open.kakao.com/o/sAbc' }, 'kick')
    eq(P('!차단해제 하늘'), { cmd: 'unban', arg: '하늘' }, 'unban')
    eq(P('!차단 해제 하늘'), { cmd: 'unban', arg: '하늘' }, 'unban spaced')
    eq(P('!설정'), { cmd: 'status' }, 'status')
    eq(P('!설정 아무거나'), null, 'status with words is not a command')
    eq(P('!입장기록 켜기'), { cmd: 'toggle', sec: 'visit', on: true }, 'toggle on')
    eq(P('!입장 기록 끄기'), { cmd: 'toggle', sec: 'visit', on: false }, 'toggle off spaced')
    eq(P('!들낙감지'), { cmd: 'toggle', sec: 'churn', on: null }, 'toggle usage')
    eq(P('!재입장차단 꺼'), { cmd: 'toggle', sec: 'leaveKick', on: false }, 'leaveKick')
    eq(P('!프로필기록 켜기'), { cmd: 'toggle', sec: 'profile', on: true }, 'profile toggle')
    eq(P('!프로필 기록 켜기'), { cmd: 'toggle', sec: 'profile', on: true }, 'profile toggle spaced is not a lookup')
    eq(P('!홍보금지 켜기'), { cmd: 'toggle', sec: 'promo', on: true }, 'promo')
    eq(P('!올킥감지 끄기'), { cmd: 'toggle', sec: 'guard', on: false }, 'guard')
    eq(P('!금지어검열 켜기'), { cmd: 'toggle', sec: 'cover', on: true }, 'cover toggle')
    eq(P('!금지어 추가 토토, 바카라'), { cmd: 'words', op: 'add', words: ['토토', '바카라'] }, 'words add')
    eq(P('!금지어 삭제 토토'), { cmd: 'words', op: 'del', words: ['토토'] }, 'words del')
    eq(P('!금지어 목록'), { cmd: 'words', op: 'list', words: [] }, 'words list')
    eq(P('!금지어 켜기'), { cmd: 'words', op: 'on', words: [] }, 'words on')
    eq(P('!금지어'), { cmd: 'words', op: '', words: [] }, 'words usage')
    eq(P('!설정값'), null, 'a longer word is not the command')
    eq(P('!옾링주소'), null, 'a longer word is not the command 2')
    eq(P('/옾링 하늘'), null, 'other prefix')
    eq(RC.parseRoomCommand('/옾링 하늘', '/'), { cmd: 'link', arg: '하늘' }, 'custom prefix')
    eq(P('!끝말잇기'), null, 'games are not room commands')
    if (!RC.isStaff(1) || !RC.isStaff(4) || !RC.isStaff(5) || RC.isStaff(2) || RC.isStaff(8) || RC.isStaff(null)) throw new Error('#40-1 isStaff')
    // 사람 고르기: 멘션 → 옾링 주소 → 닉네임. 같은 닉네임이면 지금 방에 있는 사람이 하나일 때 그 사람
    const book = [
      { userId: '11', name: '하늘', link: 'https://open.kakao.com/o/sky11', here: true },
      { userId: '12', name: '하늘', link: '', here: false },
      { userId: '13', name: '바다', link: null, here: true },
      { userId: '14', name: '별', link: 'https://open.kakao.com/o/Star14', here: true },
      { userId: '15', name: '별', link: '', here: true },
    ]
    const F2 = (arg, extra) => RC.findPerson(book, Object.assign({ arg, allowName: true }, extra || {}))
    eq(F2('', { mentions: ['13'] }), { userId: '13', name: '바다', link: null }, 'mention')
    eq(F2('아무거나', { mentions: ['99'] }), { userId: '99', name: '', link: null }, 'mention not in the book')
    eq(F2('https://open.kakao.com/o/sky11'), { userId: '11', name: '하늘', link: 'https://open.kakao.com/o/sky11' }, 'by link')
    eq(F2('open.kakao.com/o/sky11/'), { userId: '11', name: '하늘', link: 'https://open.kakao.com/o/sky11' }, 'by link without https, trailing slash')
    eq(F2('https://OPEN.kakao.com/o/Star14?x=1').userId, '14', 'link query ignored, host case-insensitive')
    eq(F2('https://open.kakao.com/o/star14'), { none: 'link' }, 'link code is case-sensitive')
    eq(F2('https://open.kakao.com/o/nobody'), { none: 'link' }, 'link not found')
    eq(F2('하늘').userId, '11', 'same name: the one still here')
    eq(F2('별'), { many: 2 }, 'same name: two here')
    eq(F2('@바다').userId, '13', '@name typed without a real mention')
    eq(F2('구름'), { none: 'name', name: '구름' }, 'name not found')
    eq(F2(''), { usage: true }, 'usage')
    eq(RC.findPerson(book, { arg: '바다', allowName: false }), { usage: true }, 'kick does not pick by name')
    eq(RC.findPerson(book, { arg: 'https://open.kakao.com/o/sky11', allowName: false }).userId, '11', 'kick picks by link')
    eq(RC.findFailReply({ none: 'name', name: '구름' }), '「구름」을 이 방에서 찾지 못했어요.', 'name fail copy')
    eq(RC.findFailReply({ none: 'name', name: '하늘' }), '「하늘」을 이 방에서 찾지 못했어요.', 'name fail copy josa')
    eq(RC.findFailReply({ none: 'name', name: '바다' }), '「바다」를 이 방에서 찾지 못했어요.', 'name fail copy josa 2')
    eq(RC.findFailReply({ many: 2 }), '같은 이름을 쓰는 사람이 2명 있어요. @멘션으로 골라 주세요.', 'many copy')
    eq(RC.linkReply({ name: '하늘', link: 'https://open.kakao.com/o/sky11' }), '[옾링]\n이름 : 하늘\n옾링 : https://open.kakao.com/o/sky11', 'link reply')
    eq(RC.linkReply({ name: '바다', link: '' }), '[옾링]\n이름 : 바다\n옾링 : 없음', 'link reply none')
    eq(RC.linkReply({ name: '별', link: null }), '[옾링]\n이름 : 별\n옾링 : 확인 못 함', 'link reply unknown')
    eq(RC.kickReply('하늘', { ok: true }), '하늘님을 내보냈어요.', 'kick ok')
    eq(RC.kickReply('하늘', { ok: false, note: 'wave', waitMin: 7 }), '올킥 감지로 K bot의 내보내기가 멈춰 있어요. 7분쯤 뒤에 다시 입력해 주세요.', 'kick wave')
    eq(RC.kickReply('하늘', { ok: false, note: 'limit', waitMin: 30 }), 'K bot이 짧은 시간에 내보낼 수 있는 인원을 넘었어요. 30분쯤 뒤에 다시 입력해 주세요.', 'kick limit')
    eq(RC.kickReply('', { ok: false, status: -500 }), '그 사람을 내보내지 못했어요. 잠시 뒤 다시 입력해 주세요.', 'kick fail')
    // 설정 바꾸기: 답 · 바꿀 칸 · 기록 한 줄. 이미 그 상태면 저장 없이 답만
    const cfg0 = RF.normRoomConfig({ visit: { enabled: true }, cover: { words: ['토토'] } })
    eq(RC.configChange(cfg0, { cmd: 'toggle', sec: 'churn', on: true }), { patch: { churn: { enabled: true } }, reply: '들낙 감지를 켰어요.', log: '들낙 감지 켜기' }, 'toggle change')
    eq(RC.configChange(cfg0, { cmd: 'toggle', sec: 'visit', on: true }), { reply: '입장·퇴장 기록은 이미 켜져 있어요.' }, 'toggle already')
    eq(RC.configChange(cfg0, { cmd: 'toggle', sec: 'leaveKick', on: false }), { reply: '나간 사람 재입장 차단은 이미 꺼져 있어요.' }, 'toggle already off')
    eq(RC.configChange(cfg0, { cmd: 'toggle', sec: 'promo', on: null }).reply, '「!홍보금지 켜기」·「!홍보금지 끄기」로 입력해 주세요. 지금은 꺼져 있어요.', 'toggle usage')
    eq(RC.configChange(cfg0, { cmd: 'words', op: 'add', words: ['바카라', '토토', 'TOTO'] }).patch, { cover: { words: ['토토', '바카라', 'TOTO'] } }, 'words add dedupe')
    eq(RC.configChange(cfg0, { cmd: 'words', op: 'add', words: ['토토'] }), { reply: '이미 등록된 금지어예요.' }, 'words dupe')
    eq(RC.configChange(cfg0, { cmd: 'words', op: 'add', words: ['x'.repeat(31)] }).reply, '금지어는 한 개에 30자까지 입력할 수 있어요.', 'word too long')
    const many = RF.normRoomConfig({ cover: { words: Array.from({ length: 300 }, (_, i) => 'w' + i) } })
    eq(RC.configChange(many, { cmd: 'words', op: 'add', words: ['하나더'] }).reply, '금지어는 300개까지 등록할 수 있어요.', 'words max')
    const addReply = RC.configChange(cfg0, { cmd: 'words', op: 'add', words: ['바카라'] }).reply
    if (addReply !== '금지어 1개를 추가했어요. 지금 2개예요.\n금지어 검열은 꺼져 있어요. 「!금지어 켜기」로 켤 수 있어요.' || addReply.indexOf('바카라') >= 0) throw new Error('#40-1 the reply does not repeat the word ' + addReply)
    eq(RC.configChange(RF.normRoomConfig({ cover: { words: ['Spam', '토토'] } }), { cmd: 'words', op: 'del', words: ['spam'] }), { patch: { cover: { words: ['토토'] } }, reply: '금지어 1개를 삭제했어요. 지금 1개예요.', log: '금지어 1개 삭제' }, 'words del (case-insensitive)')
    eq(RC.configChange(cfg0, { cmd: 'words', op: 'del', words: ['없는말'] }), { reply: '등록되지 않은 금지어예요.' }, 'words del missing')
    eq(RC.configChange(cfg0, { cmd: 'words', op: 'list', words: [] }), { reply: '[금지어]\n토토' }, 'words list')
    eq(RC.configChange(cfg0, { cmd: 'words', op: 'on', words: [] }).patch, { cover: { enabled: true } }, 'words on = cover toggle')
    eq(RC.configChange(cfg0, { cmd: 'words', op: '', words: [] }).reply, '「!금지어 추가 단어」·「!금지어 삭제 단어」·「!금지어 목록」으로 입력해 주세요.', 'words usage')
    const st = RC.statusReply(cfg0)
    if (st !== '[설정]\n입장·퇴장 기록 : 켜짐\n들낙 감지 : 꺼짐\n나간 사람 재입장 차단 : 꺼짐\n프로필 기록 : 꺼짐\n홍보 금지 : 꺼짐\n금지어 검열 : 꺼짐 (금지어 1개)\n올킥 감지 : 꺼짐\n「!입장기록 켜기」처럼 켜고 끌 수 있어요.') throw new Error('#40-1 status ' + JSON.stringify(st))
    // 저장본에 합치기: 모르는 칸·다른 절은 그대로, 원본은 바꾸지 않는다
    const raw = { visit: { enabled: false, style: 'text' }, future: { x: 1 } }
    const merged = RC.applyPatch(raw, { visit: { enabled: true }, churn: { enabled: true } })
    eq(merged, { visit: { enabled: true, style: 'text' }, future: { x: 1 }, churn: { enabled: true } }, 'applyPatch')
    if (raw.visit.enabled !== false) throw new Error('#40-1 applyPatch keeps the original')
    // 문구 규칙(docs/TONE.md): 방 메시지에 반말·사과·이모지 없음, 명령어는 「」 안
    const copy = [RC.usageOf('link', '!'), RC.usageOf('kick', '!'), RC.usageOf('unban', '!'), RC.usageOf('profile', '!'), RC.staffOnlyReply('kick'), RC.staffOnlyReply('status'), RC.PROTECTED_REPLY, RC.NOT_HERE_REPLY, RC.SAVE_FAIL_REPLY, RC.notLiveReply('케이봇'), RC.unbanReply('하늘', { ok: true }), RC.unbanReply('', { error: 'not_kicked' })]
    for (const t of copy) if (/죄송|미안|[\u{1F300}-\u{1FAFF}]|해줘|했어\.|\uD83D/u.test(t) || !/요\.$/.test(t)) throw new Error('#40-1 room copy ' + t)
    eq(RC.notLiveReply('케이봇'), '방 관리 명령어는 K bot이 부방장이 된 뒤에 쓸 수 있어요. 방장님이 「케이봇」을 부방장으로 지정해 주세요.', 'not live copy')
  }
  // #40-2 도움말(!도움 · !도움 관리) — 방 관리 기능이 동작할 때만 방 관리 줄
  {
    const v = view({ products: { roombot: true, minigame: true }, config: { profile: { enabled: true } } })
    const h = RF.helpLine(v)
    if (h !== '[명령어]\n미니게임 : !끝말잇기 !숫자야구 !주사위 !가위바위보 !퀴즈 !힌트 !정답 !포기 !랭킹\n검 강화 : !강화 !내검 !사냥 !강화도움\n몬스터 수집 : !탐험 !포획 !도감 !내몬스터 !배틀 !교환 !몬스터\n방 관리 : !옾링 !프로필조회 !가리기 !내보내기 !설정\n「!도움 관리」를 입력하면 방 관리 명령어 설명을 볼 수 있어요.') throw new Error('#40-2 help ' + JSON.stringify(h))
    const ah = RF.adminHelp(v)
    if (!ah.startsWith('[방 관리 명령어]\n!옾링 @닉네임 : 옾링 보기\n!프로필조회 @닉네임 : 프로필 기록 보기\n!가리기 30 : 최근 글 30개 가리기') || ah.indexOf('\n!내보내기 @닉네임 : 내보내기\n') < 0 || ah.indexOf('\n!금지어 추가 · 삭제 단어\n') < 0) throw new Error('#40-2 admin help ' + JSON.stringify(ah))
    const off = view({ config: { cmd: { link: 'off' }, hide: { command: false } } })
    if (RF.helpLine(off) !== '[명령어]\n방 관리 : !내보내기 !설정\n「!도움 관리」를 입력하면 방 관리 명령어 설명을 볼 수 있어요.' || RF.adminHelp(off).indexOf('!옾링') >= 0 || RF.adminHelp(off).indexOf('!가리기') >= 0) throw new Error('#40-2 help follows the switches ' + JSON.stringify(RF.helpLine(off)))
    const waiting = view({ state: 'waiting_host' })
    if (RF.helpLine(waiting) !== '' || RF.adminHelp(waiting) !== '') throw new Error('#40-2 no room commands while waiting for the host')
    if (!RF.isAdminHelpCommand('!도움 관리', '!') || !RF.isAdminHelpCommand('!도움관리', '!') || RF.isAdminHelpCommand('!도움', '!') || RF.isAdminHelpCommand('!도움 관리자', '!')) throw new Error('#40-2 admin help command')
  }
  // #40-3 그림 기록 카드: 글 안내와 같은 내용(제목 · 닉네임 · 옾링 · 기록) + 멘션 한 줄. 카드 PNG 는 폭 720
  {
    const LC = await import('./logcard.mjs')
    const CARD = await import('./card.mjs')
    const t1 = Date.UTC(2026, 9, 12, 10, 31)
    const n = RF.visitNoticeText('join', { userId: '555', name: '하늘', link: 'https://open.kakao.com/o/sAbc' }, [t1 - 120000, t1])
    const c = n.card
    if (c.kind !== 'join' || c.title !== '입장 안내' || c.name !== '하늘' || c.before !== '' || c.at !== '오후 7:31') throw new Error('#40-3 card head ' + JSON.stringify(c))
    if (JSON.stringify(c.fields) !== JSON.stringify([{ label: '옾링', value: 'https://open.kakao.com/o/sAbc' }])) throw new Error('#40-3 card link')
    if (JSON.stringify(c.record) !== JSON.stringify({ label: '입장 기록', count: 2, times: ['10.12 오후 7:29', '10.12 오후 7:31'] })) throw new Error('#40-3 card record ' + JSON.stringify(c.record))
    // 글 안내의 기록 줄과 같은 값
    if (n.text !== ['[입장 안내]', '이름 : @하늘', '옾링 : https://open.kakao.com/o/sAbc', '입장 기록 : 2회', ...c.record.times].join('\n')) throw new Error('#40-3 text and card agree')
    const lv = RF.visitNoticeText('leave', { userId: '555', name: '하@늘', link: null }, [t1]).card
    if (lv.kind !== 'leave' || lv.title !== '퇴장 안내' || lv.name !== '하늘' || lv.fields[0].value !== '확인 못 함' || lv.record.label !== '퇴장 기록') throw new Error('#40-3 leave card ' + JSON.stringify(lv))
    if (RF.visitNoticeText('join', { userId: '', name: '', link: '' }, [t1]).card.fields[0].value !== '없음') throw new Error('#40-3 no link → 없음')
    const pc = RF.profileChangeNotice({ userId: '555', name: '하늘_판매', link: 'https://open.kakao.com/o/sNew' },
      [{ kind: 'name', from: '하늘', to: '하늘_판매' }, { kind: 'link', from: 'https://open.kakao.com/o/sOld', to: 'https://open.kakao.com/o/sNew' }], [t1]).card
    if (pc.kind !== 'profile' || pc.title !== '프로필 변경 감지' || pc.before !== '하늘' || pc.name !== '하늘_판매' ||
      JSON.stringify(pc.fields) !== JSON.stringify([{ label: '옾링 변경전', value: 'https://open.kakao.com/o/sOld' }, { label: '옾링 변경후', value: 'https://open.kakao.com/o/sNew' }]) || pc.record.label !== '변경 기록') throw new Error('#40-3 profile card ' + JSON.stringify(pc))
    const pc2 = RF.profileChangeNotice({ userId: '555', name: '하늘', link: '' }, [{ kind: 'name', from: '하늘이', to: '하늘' }], [t1]).card
    if (JSON.stringify(pc2.fields) !== JSON.stringify([{ label: '옾링', value: '없음' }])) throw new Error('#40-3 profile card keeps the link line')
    // 멘션 한 줄: 그림 안에는 멘션을 넣을 수 없다 → `[입장 안내] @하늘`(visitMentionExtra 가 받는 모양)
    const line = RF.cardMentionLine(c, '555')
    if (!line || line.text !== '[입장 안내] @하늘' || F.visitMentionExtra(line.text, line.mention) !== '{"mentions":[{"user_id":555,"at":[1],"len":2}]}') throw new Error('#40-3 mention line ' + JSON.stringify(line))
    if (RF.cardMentionLine(c, '') !== null || RF.cardMentionLine(pc, '555').text !== '[프로필 변경 감지] @하늘_판매') throw new Error('#40-3 mention line without id / profile')
    // 카드 그림: 글과 같은 값이 다 들어간다(SVG 글자), 이스케이프, 폭 720 PNG
    const svg = LC.logCardSvg(Object.assign({}, c, { name: '<하늘&>' }), { room: '동네 "모임"' })
    for (const want of ['입장 안내', '오후 7:31', '&lt;하늘&amp;&gt;', '옾링', 'https://open.kakao.com/o/sAbc', '입장 기록', '2회', '10.12 오후 7:29', '10.12 오후 7:31', '동네 &quot;모임&quot;']) {
      if (svg.indexOf(want) < 0) throw new Error('#40-3 card svg has ' + want)
    }
    if (svg.indexOf('<하늘') >= 0 || LC.logCardSvg(pc).indexOf('변경전') < 0 || LC.ACCENT.join === LC.ACCENT.leave || LC.ACCENT.leave === LC.ACCENT.profile) throw new Error('#40-3 card svg escape / profile / accents')
    if (CARD.available()) {
      const png = LC.logCardPng(c, { room: '동네모임' })
      if (!png || png.readUInt32BE(16) !== 720 || png.readUInt32BE(20) < 400 || png.readUInt32BE(20) > 1400) throw new Error('#40-3 card png 720 wide')
      // 패널 미리 보기 그림(public/img/logcard-*.png)은 sender/src/logcard-sample.mjs 가 만든다
      const { readFileSync } = await import('node:fs')
      for (const f of ['logcard-join.png', 'logcard-profile.png']) {
        const b = readFileSync(new URL('../../public/img/' + f, import.meta.url))
        if (b.readUInt32BE(12) !== 0x49484452 || b.readUInt32BE(16) !== 720) throw new Error('#40-3 panel preview ' + f + ' is a 720-wide PNG')
      }
    }
    if (LC.logCardPng(null) !== null) throw new Error('#40-3 no card → null')
  }
  // #40-4 발송 한도: 그림 + 멘션 한 줄(cost 2)은 방 한도(분당 6)에서 2개로 센다. 대기 목록은 한 자리
  {
    const pc = new RF.Pacer({ roomMax: 6, botMax: 30 })
    const t0 = 1_000_000
    pc.push('a', { text: 'img1', cost: 2 }, t0)
    pc.push('a', { text: 'img2', cost: 2 }, t0)
    pc.push('a', { text: 'img3', cost: 2 }, t0)
    pc.push('a', { text: 'txt' }, t0)
    const got = []
    for (let x; (x = pc.next(t0));) got.push(x.item.text)
    if (got.join() !== 'img1,img2,img3' || pc.pending() !== 1) throw new Error('#40-4 cost counts toward the room limit ' + got.join())
    if (pc.wakeAt(t0) !== t0 + 60000) throw new Error('#40-4 wake when one slot frees')
    const pc2 = new RF.Pacer({ roomMax: 6, botMax: 30 })
    for (let i = 0; i < 5; i++) pc2.push('b', { text: 't' + i }, t0 + i)
    for (let i = 0; i < 5; i++) pc2.next(t0 + i)
    pc2.push('b', { text: 'img', cost: 2 }, t0 + 10)
    if (pc2.next(t0 + 10) !== null) throw new Error('#40-4 a 2-cost item waits for two free slots')
    if (pc2.wakeAt(t0 + 10) !== t0 + 60000) throw new Error('#40-4 wake when two slots are free ' + (pc2.wakeAt(t0 + 10) - t0))
    if (!pc2.next(t0 + 60001) || pc2.pending() !== 0) throw new Error('#40-4 sent once two slots are free')
  }
  // #40-5 sender 기본값 = 부모 기본값(lib/room-config.js). 한쪽에만 칸을 더하면 여기서 걸린다
  {
    const { createRequire } = await import('node:module')
    const rc = createRequire(import.meta.url)('../../lib/room-config.js')
    if (JSON.stringify(rc.DEFAULTS) !== JSON.stringify(RF.DEFAULTS)) throw new Error('#40-5 sender DEFAULTS differ from lib/room-config.js DEFAULTS')
    const messy = { visit: { style: 'gif', enabled: true }, profile: { style: 'text' }, cmd: { link: 'all' }, cover: { words: ['a', 'A'] } }
    if (JSON.stringify(rc.normalizeRoomConfig(messy)) !== JSON.stringify(RF.normRoomConfig(messy))) throw new Error('#40-5 normalize parity')
  }

  // ── 16~24: 가짜 연결(9.4) + 메모리 저장소 ────────────────────────────────
  const prevSecret = process.env.CONFIG_SECRET
  const prevJoin = process.env.FAKE_JOIN_MS
  process.env.CONFIG_SECRET = 'selfcheck-secret-0123456789abcdef'
  process.env.FAKE_JOIN_MS = '0'
  const passbox2 = await import('./secretbox.mjs')
  const fs = FK.resetFakeServer()
  const store = new FK.MemStore()
  const pool = new BotPool({
    store,
    newClient: () => new FK.FakeKakaoClient(fs),
    opts: {
      joinGapMs: 0, permPollMs: 150, activeCheckMs: 600000, pushDelayMs: 120, tickMs: 30, hideGapMs: 0,
      rateWaits: [60000, 120000, 240000], ipWaits: [300000, 600000, 900000], reconnectGapMs: 5, transientWaitMs: 60000,
      profilePushDelayMs: 30, profileReadGapMs: 50, profileConvert: 'off', linkGapMs: 0, memberGapMs: 0,
    },
  })
  async function addBot(n) {
    const id = 'bot.' + String(n).padStart(16, '0')
    const uid = FK.fakeUserId(id)
    fs.user(uid).bot = true
    await pool.attach(id, { device_id: id, credentials: { access_token: 'fake-' + n, user_id: uid, device_uuid: 'fake-du-' + n, device_type: 'tablet' }, features: { v: 2, bot: true }, config: {}, rooms: [], runtime: {} })
    return { id, uid, slot: pool.slotOf(id) }
  }
  const botA = await addBot(1)
  const botB = await addBot(2)
  if (!botA.slot.live() || botA.slot.nickname !== FK.fakeNick(botA.uid)) throw new Error('fake bot connected with its own nickname')
  const url = (code) => 'https://open.kakao.com/o/' + code
  const rowOf = (id) => store.installs.get(id)
  function install(code, over) {
    return store.addInstall(Object.assign({ link_url: url(code), bot_device_id: botA.id, roombot: true, minigame: false, state: 'queued' }, over || {})).id
  }
  const sentIn = (id) => fs.sentIn(rowOf(id).chat_id).map((x) => x.text)
  const packets = (method, filter) => fs.packets.filter((p) => p.method === method && (!filter || filter(p)))

  // #16 입장 오류 매핑(실제 sendPacket 경로)
  const iGone = install('gonex1')
  const iRate = install('ratex1')
  const iBan = install('banx1')
  fs.room('banx1').bans.push(botA.uid)
  const iAnon = install('noopenx1')        // 오픈프로필 입장을 거절하는 방(D12)
  const iNoProf = install('noprofx1', { roombot: false, minigame: true })   // 기본 프로필 참여를 막은 방(pv & 32 없음)
  const iPassWrong = install('passx1', { passcode_ct: passbox2.seal('1234') })
  const iPassNone = install('passx2')
  const iPassOk = install('passx3', { passcode_ct: passbox2.seal('0000'), roombot: false, minigame: true })
  const iDm = install('dmx1')
  const iComm = install('commx1', { roombot: false, minigame: true })   // 커뮤니티 타입 방(오픈링크 종류 3)
  await pool.reconcile(null)
  await waitFor(() => [iGone, iBan, iAnon, iPassWrong, iPassNone, iDm].every((id) => rowOf(id).state === 'error') && rowOf(iPassOk).state === 'active' && rowOf(iRate).error_detail === 'rate_limited', 8000, '7.7#16 joins')
  await waitFor(() => rowOf(iComm).state === 'active', 5000, 'community room joins like a group room')
  const codeOf = (id) => rowOf(id).error_code
  if (codeOf(iGone) !== 'link_gone') throw new Error('7.7#16 -324 → link_gone, got ' + codeOf(iGone))
  if (rowOf(iRate).state !== 'joining' || rowOf(iRate).error_detail !== 'rate_limited' || !(rowOf(iRate).next_try_at > Date.now() + 50000)) throw new Error('7.7#16 -312 → joining + rate_limited')
  if (codeOf(iBan) !== 'kicked') throw new Error('7.7#16 -815 → kicked')
  if (codeOf(iAnon) !== 'profile_blocked') throw new Error('7.7#16 ptp 16 refused → profile_blocked, got ' + codeOf(iAnon))
  const anonJoins = packets('JOINLINK', (p) => p.li === fs.room('noopenx1').li)
  if (anonJoins.length !== 1 || anonJoins[0].ptp !== 16) throw new Error('D12 refused open profile join is not retried with another profile ' + JSON.stringify(anonJoins))
  await waitFor(() => rowOf(iNoProf).state === 'active', 5000, 'D12 room without main profile joins with the open profile')
  if (packets('JOINLINK', (p) => p.ptp !== 16).length) throw new Error('D12 every JOINLINK is ptp 16 ' + JSON.stringify(packets('JOINLINK', (p) => p.ptp !== 16)))
  if (codeOf(iPassWrong) !== 'passcode_wrong') throw new Error('7.7#16 passcode failure → passcode_wrong')
  if (codeOf(iPassNone) !== 'passcode_needed') throw new Error('7.7#16 passcode_needed')
  if (codeOf(iDm) !== 'not_group') throw new Error('7.7#16 lt 1 → not_group')
  if (!rowOf(iPassOk).link_id || rowOf(iPassOk).link_name !== '테스트방 passx3') throw new Error('7.7#16 join stores link_id and name')
  // -444: 행은 rate_limited + 전역 join_paused_until, 봇은 bot_down 아님
  const iIp = install('ipblockx1')
  const iAfterIp = install('normalafterip')
  await pool.reconcile(null)
  await waitFor(() => rowOf(iIp).error_detail === 'rate_limited', 5000, '7.7#16 -444')
  if (!(pool.joinPausedUntil > Date.now() + 200000) || botA.slot.dead || store.bots.get(botA.id).state !== 'connected') throw new Error('7.7#16 -444 pauses all joins, bot stays up')
  await sleep(100)
  if (rowOf(iAfterIp).error_detail !== 'rate_limited' || Number(rowOf(iAfterIp).next_try_at) !== pool.joinPausedUntil) throw new Error('7.7#16 global pause holds other joins')
  if (pool.botStatus().join_paused_until !== pool.joinPausedUntil) throw new Error('7.7#16 status shows the pause')
  pool.joinPausedUntil = 0
  store.installs.get(iAfterIp).next_try_at = null
  store.installs.get(iAfterIp).state = 'queued'
  await pool.reconcile(null)
  await waitFor(() => rowOf(iAfterIp).state === 'waiting_host', 5000, 'join after pause')

  // #18 기본 설정: 미니게임만 있는 설치 → 가짜 입장 직후 !도움 → 게임 목록 답 1개
  {
    const iMini = install('minix1', { roombot: false, minigame: true, config: {} })
    await pool.reconcile(null)
    await waitFor(() => rowOf(iMini).state === 'active', 5000, '7.7#18 mini join')
    const chat = rowOf(iMini).chat_id
    fs.event(chat, botA.uid, { kind: 'message', user_id: '501', name: '손님', text: '!도움' })
    await waitFor(() => sentIn(iMini).length >= 2, 5000, '7.7#18 reply')
    const sent = sentIn(iMini)
    if (sent[0] !== '[K bot]\n미니게임봇이 입장했어요.\n「!도움」을 입력하면 명령어를 볼 수 있어요.') throw new Error('7.7#18 join notice first ' + JSON.stringify(sent))
    if (sent.filter((t) => t.startsWith('[명령어]')).length !== 1) throw new Error('7.7#18 one game list ' + JSON.stringify(sent))
    if (sent[1] !== '[명령어]\n미니게임 : !끝말잇기 !숫자야구 !주사위 !가위바위보 !퀴즈 !힌트 !정답 !포기 !랭킹\n검 강화 : !강화 !내검 !사냥 !강화도움\n몬스터 수집 : !탐험 !포획 !도감 !내몬스터 !배틀 !교환 !몬스터') throw new Error('7.7#18 game list text ' + JSON.stringify(sent))
    // 미니게임만 있는 방: !주사위 답, 입장 안내·홍보·가리기 조용
    const before = packets('REWRITE').length
    fs.event(chat, botA.uid, { kind: 'join', user_id: '502', name: '새손님' })
    fs.event(chat, botA.uid, { kind: 'message', user_id: '502', name: '새손님', text: 'https://spam.example.com' })
    fs.event(chat, botA.uid, { kind: 'message', user_id: '503', name: '방장', text: '!가리기 5' })
    await sleep(1100)
    fs.event(chat, botA.uid, { kind: 'message', user_id: '501', name: '손님', text: '!주사위' })
    await waitFor(() => sentIn(iMini).some((t) => t.indexOf('면 주사위 결과') >= 0), 5000, '7.7#13 dice in minigame-only room')
    if (packets('REWRITE').length !== before) throw new Error('7.7#13 minigame-only room does not hide')
    if (sentIn(iMini).some((t) => t.indexOf('입장 안내') >= 0 || t.indexOf('[홍보 금지]') >= 0 || t.indexOf('[글 가리기]') >= 0)) throw new Error('7.7#13 minigame-only room is quiet')
    // #17 미니게임만 산 방(perm 4, active)에서 hide·unkick·people → no_roombot
    fs.setPerm(chat, botA.uid, 4)
    await sleep(200)
    for (const r of [await pool.hide(iMini, { last: 3 }), await pool.unkick(iMini, '502'), await pool.people(iMini)]) {
      if (r.ok || r.error !== 'no_roombot') throw new Error('7.7#17 no_roombot ' + JSON.stringify(r))
    }
    // 랭킹 초기화(games-reset)는 점수와 함께 검 강화·몬스터 수집 기록도 지운다(7.3.3)
    const vm = botA.slot.byInstall.get(iMini)
    vm.runtime.scores = { r: { 501: 3 } }
    vm.runtime.sword = { r: { v: 1, u: { 501: { n: '손님', g: 5000, lv: 7 } }, t: [], q: 2 } }
    vm.runtime.mon = { v: 1, seq: 3, u: { 501: { n: '손님', c: 100, m: [[1, 1, 5, 0]] } }, p: {} }
    if (!(await pool.gamesReset(iMini)).ok) throw new Error('7.3.3 games-reset ok')
    if (Object.keys(vm.runtime.scores.r).length || (vm.runtime.sword && vm.runtime.sword.r) || vm.runtime.mon) throw new Error('7.3.3 games-reset clears scores · sword · monster ' + JSON.stringify(vm.runtime))
  }

  // #28 방 멤버 명부: 봇이 들어가기 전부터 있던 사람도 옾링을 안다(GETMEM + INFOLINK)
  //   · 먼저 있던 사람이 나가면 퇴장 안내에 옾링 · 명부는 저장소에 남는다 · 사진은 어디에도 적지 않는다
  //   · 메시지 닉네임이 바뀌면 카드를 다시 읽어 프로필 변경 안내(닉네임 전·후 + 지금 옾링)
  //   · 주기 동기화가 닉네임·옾링(다른 오픈프로필로 바꿈) 변경을 찾는다(사진만 바뀌면 안내 없음) · 바뀔 때마다 알린다
  {
    const code = 'bookx28'
    const room0 = fs.room(code)
    fs.setProfiles('701', [{ li: '7101', name: '먼저 온 프로필', url: 'https://open.kakao.com/o/first701' }, { li: '7102', name: '바꾼 프로필', url: 'https://open.kakao.com/o/second701' }])
    fs.setProfiles('702', [{ li: '7201', name: '둘째 프로필', url: 'https://open.kakao.com/o/second702' }])
    room0.members['701'] = { mt: 2, nick: '먼저온사람', ptp: 16, pli: '7101', photo: 'https://k.kakaocdn.net/dn/p/701a.jpg', status: null }
    room0.members['702'] = { mt: 2, nick: '둘째', ptp: 16, pli: '7201', photo: 'https://k.kakaocdn.net/dn/p/702a.jpg', status: null }
    room0.members['703'] = { mt: 2, nick: '기본프로필', ptp: 1, pli: null, photo: '', status: null }
    const iBook = install(code, { config: { visit: { enabled: true, style: 'text' }, profile: { enabled: true, style: 'text' } } })
    await pool.reconcile(null)
    await waitFor(() => rowOf(iBook).state === 'waiting_host', 5000, '#28 join')
    const chat = rowOf(iBook).chat_id
    fs.setPerm(chat, botA.uid, 4)
    await waitFor(() => rowOf(iBook).state === 'active', 3000, '#28 promotion')
    const vb = botA.slot.byInstall.get(iBook)
    await waitFor(() => vb.members.get('701') && vb.members.get('701').link && vb.members.get('702') && vb.members.get('702').link, 5000, '#28 member book')
    const m701 = vb.members.get('701')
    if (m701.link !== 'https://open.kakao.com/o/first701' || m701.pli !== '7101' || m701.name !== '먼저온사람' || 'photo' in m701) throw new Error('#28 book row ' + JSON.stringify(m701))
    if (vb.members.get('703').link !== '' || vb.members.get('703').pli !== '') throw new Error('#28 default profile has no link')
    if (sentIn(iBook).some((t) => t.indexOf('프로필 변경 감지') >= 0)) throw new Error('#28 the first read only sets a baseline')
    // 먼저 있던 사람이 나간다 → 퇴장 안내에 옾링(예전에는 '없음'이었다)
    fs.event(chat, botA.uid, { kind: 'leave', user_id: '701', name: '먼저온사람' })
    await waitFor(() => sentIn(iBook).some((t) => t.indexOf('[퇴장 안내]') === 0), 8000, '#28 leave notice')
    const out = sentIn(iBook).find((t) => t.indexOf('[퇴장 안내]') === 0)
    if (noRec(out) !== '[퇴장 안내]\n이름 : @먼저온사람\n옾링 : https://open.kakao.com/o/first701' || !hasRec(out) || out.indexOf('🖼') >= 0) throw new Error('#28 leave notice has the link of someone who was there before the bot ' + JSON.stringify(out))
    await pool.flush()
    const saved = await store.loadMembers(iBook, chat, 0)
    if (!saved.some((r) => r.user_id === '701' && r.link === 'https://open.kakao.com/o/first701')) throw new Error('#28 the book is saved ' + JSON.stringify(saved))
    // 메시지 닉네임이 바뀌었다 → 카드를 읽어 프로필 변경 안내
    fs.event(chat, botA.uid, { kind: 'profile', user_id: '702', name: '둘째새닉' })
    fs.event(chat, botA.uid, { kind: 'message', user_id: '702', name: '둘째새닉', text: '닉 바꿨어요' })
    await waitFor(() => sentIn(iBook).some((t) => t.indexOf('[프로필 변경 감지]') === 0), 8000, '#28 rename notice')
    const rn = sentIn(iBook).find((t) => t.indexOf('[프로필 변경 감지]') === 0)
    const RN = '[프로필 변경 감지]\n변경전 : ＠둘째\n변경후 : @둘째새닉\n옾링 : https://open.kakao.com/o/second702'
    if (noRec(rn) !== RN || !hasRec(rn) || rn.indexOf('\n변경 기록 : 1회\n') < 0) throw new Error('#28 rename notice ' + JSON.stringify(rn))
    // 주기 동기화: 703 은 사진만 바꾸고(안내 없음), 702 는 닉네임을 또 바꿨다(바뀔 때마다 알린다)
    room0.members['703'].photo = 'https://k.kakaocdn.net/dn/p/703b.jpg'
    room0.members['702'].nick = '둘째또닉'
    vb.memberSyncAt = 0
    // 봇 전체 발송 한도(분당 30)에 걸리면 다음 1분 창까지 기다린다
    await waitFor(() => sentIn(iBook).some((t) => t.indexOf('\n변경후 : @둘째또닉\n') >= 0), 70000, '#28 second rename notice').catch((e) => {
      const sl = botA.slot
      throw new Error(e.message + ' DIAG ' + JSON.stringify({ live: sl.live(), syncing: vb.memberSyncing, syncAt: vb.memberSyncAt, now: Date.now(), checking: vb.checking,
        sent: sentIn(iBook).map((t) => t.split('\n')[0].slice(0, 30)), pend: sl.pacer ? sl.pacer.pending() : null, m702: vb.members.get('702') && vb.members.get('702').name }))
    })
    await sleep(300)
    if (sentIn(iBook).some((t) => t.indexOf('기본프로필') >= 0 || t.indexOf('🖼') >= 0)) throw new Error('#28 a photo-only change is not announced')
    const rn2 = sentIn(iBook).find((t) => t.indexOf('\n변경후 : @둘째또닉\n') >= 0)
    if (rn2.indexOf('\n변경전 : ＠둘째새닉\n변경후 : @둘째또닉\n') < 0 || !hasRec(rn2) || rn2.indexOf('\n변경 기록 : 2회\n') < 0) throw new Error('#28 a quick second rename is announced ' + JSON.stringify(rn2))
    const hist = vb.runtime.profile.people[chat + '\u0001702']
    if (!hist || hist.changes.filter((c) => c.kind === 'name').length !== 2) throw new Error('#28 both renames are recorded ' + JSON.stringify(hist))
  }
  // #28-2 다른 오픈프로필로 바꿈(pli → 다른 pli)은 옾링 변경. 방마다 1분에 6번까지만 보내므로 새 방에서 본다.
  {
    const code = 'bookx29'
    const room0 = fs.room(code)
    fs.setProfiles('711', [{ li: '7111', name: '처음 프로필', url: 'https://open.kakao.com/o/a711' }, { li: '7112', name: '바꾼 프로필', url: 'https://open.kakao.com/o/b711' }])
    room0.members['711'] = { mt: 2, nick: '바꿀사람', ptp: 16, pli: '7111', photo: 'https://k.kakaocdn.net/dn/p/711.jpg', status: null }
    const iLink = install(code, { config: { profile: { enabled: true, style: 'text' } } })
    await pool.reconcile(null)
    await waitFor(() => rowOf(iLink).state === 'waiting_host', 5000, '#28-2 join')
    const chat = rowOf(iLink).chat_id
    fs.setPerm(chat, botA.uid, 4)
    await waitFor(() => rowOf(iLink).state === 'active', 3000, '#28-2 promotion')
    const vl = botA.slot.byInstall.get(iLink)
    await waitFor(() => vl.members.get('711') && vl.members.get('711').link === 'https://open.kakao.com/o/a711', 5000, '#28-2 member book')
    room0.members['711'].pli = '7112'
    vl.memberSyncAt = 0
    await waitFor(() => sentIn(iLink).some((t) => t.indexOf('\n옾링 변경전 : ') >= 0), 8000, '#28-2 link change notice')
    const lc = sentIn(iLink).find((t) => t.indexOf('\n옾링 변경전 : ') >= 0)
    if (lc.indexOf('\n옾링 변경전 : https://open.kakao.com/o/a711\n옾링 변경후 : https://open.kakao.com/o/b711\n') < 0 || lc.indexOf('\n옾링 : ') >= 0 || !hasRec(lc)) throw new Error('#28-2 link change ' + JSON.stringify(lc))
    const rows = F.logsView(RF.adapterRecord(vl, botA.id)).profile
    if (!rows.some((r) => r.changes.some((c) => c.kind === 'link' && c.to === 'https://open.kakao.com/o/b711'))) throw new Error('#28-2 the panel log has the link change ' + JSON.stringify(rows))
  }

  // 로그 줄을 모은다(그대로 내보내면서). 명부 시험(#28-3~6)이 남기는 한 줄 로그를 확인한다.
  async function withLog(fn) {
    const lines = []
    const w = process.stderr.write
    process.stderr.write = function (chunk, ...rest) {
      lines.push(String(chunk))
      return w.call(this, chunk, ...rest)
    }
    try {
      await fn(lines)
    } finally {
      process.stderr.write = w
    }
  }
  const hasLine = (lines, ...parts) => lines.some((l) => parts.every((p) => l.indexOf(p) >= 0))
  // 명부 시험(#28-3~6)의 입장 4번은 뒤 사례가 보는 봇 A 의 입장 예산(시간 20)에서 돌려준다(아래 끝에서)
  const joinMark = [botA.slot.joinH.list.length, botA.slot.joinD.list.length]
  // #28-3 옾링을 읽지 못하면(INFOLINK 실패) '없음'으로 굳히지 않고 모름(null)으로 두었다가 다음 동기화가 채운다.
  //   · 예전에 '' 로 저장된 행(pli 는 있음)도 다시 읽어 고친다 · 고쳐 읽은 것은 옾링 변경이 아니다(프로필 변경 안내 없음)
  //   · 속도 제한(-805)이면 그 뒤 잠시 INFOLINK 를 보내지 않는다 · 동기화마다 숫자만 적힌 로그 한 줄
  {
    const code = 'bookx30'
    const room0 = fs.room(code)
    fs.setProfiles('731', [{ li: '7311', name: '셋째 프로필', url: 'https://open.kakao.com/o/a731' }])
    fs.setProfiles('732', [{ li: '7321', name: '넷째 프로필', url: 'https://open.kakao.com/o/a732' }])
    room0.members['731'] = { mt: 2, nick: '새로읽기', ptp: 16, pli: '7311', photo: 'https://k.kakaocdn.net/dn/p/731.jpg', status: null }
    room0.members['732'] = { mt: 2, nick: '고쳐읽기', ptp: 16, pli: '7321', photo: 'https://k.kakaocdn.net/dn/p/732.jpg', status: null }
    const iHeal = install(code, { config: { visit: { enabled: true, style: 'text' }, profile: { enabled: true, style: 'text' } } })
    // 예전 코드가 읽기 실패를 '없음'('')으로 저장해 둔 행
    await store.saveMembers(iHeal, room0.chatId, [{ user_id: '732', name: '고쳐읽기', pli: '7321', link: '', photo: 'https://k.kakaocdn.net/dn/p/732.jpg', seen_at: Date.now() }])
    await withLog(async (lines) => {
      try {
        fs.infolinkFail = -805
        await pool.reconcile(null)
        await waitFor(() => rowOf(iHeal).state === 'waiting_host', 5000, '#28-3 join')
        const chat = rowOf(iHeal).chat_id
        const vh = botA.slot.byInstall.get(iHeal)
        // 저장된 '없음'('', pli 있음)은 예전 읽기 실패일 수 있어 모름(null)으로 읽는다 → 안내는 '확인 못 함', 다시 읽기 대상
        if (!vh.members.get('732') || vh.members.get('732').link !== null || !vh.memberWant.has('732')) throw new Error('#28-3 saved row loaded ' + JSON.stringify(vh.members.get('732')))
        fs.setPerm(chat, botA.uid, 4)
        await waitFor(() => rowOf(iHeal).state === 'active', 3000, '#28-3 promotion')
        await waitFor(() => vh.memberOkAt > 0, 5000, '#28-3 first sync')
        const m731 = vh.members.get('731')
        if (!m731 || m731.pli !== '7311' || m731.link !== null) throw new Error('#28-3 a failed link read stays unknown, not 없음 ' + JSON.stringify(m731))
        if (botA.slot.linkCache.has('7311') || botA.slot.linkCache.has('7321')) throw new Error('#28-3 a failed link read is not cached')
        if (!hasLine(lines, 'open link read failed: status -805')) throw new Error('#28-3 failed link read is logged')
        if (!hasLine(lines, `member sync ${iHeal}: 2 members, 2 with pli, 0 with link, `)) throw new Error('#28-3 one summary line per sync ' + JSON.stringify(lines))
        // 속도 제한 동안은 명부를 읽지 않는다(GETMEM·MEMBER·INFOLINK 모두 쉼 — 실패한 INFOLINK 가 늘지 않음)
        const failed = () => packets('INFOLINK', (p) => p.status === -805).length
        const n0 = failed()
        const ok0 = vh.memberOkAt
        const getmem0 = packets('GETMEM').length
        if (!(botA.slot.readPauseUntil > Date.now())) throw new Error('#28-3 a rate-limited INFOLINK pauses member reads')
        vh.memberSyncAt = 0
        await sleep(400)
        if (failed() !== n0 || vh.memberOkAt !== ok0 || packets('GETMEM').length !== getmem0) throw new Error('#28-3 no member reads while rate limited')
        // 풀린 뒤 다음 동기화가 채운다 — 모름 → 주소, '' → 주소 모두 프로필 변경이 아니다
        fs.infolinkFail = 0
        botA.slot.readPauseUntil = 0
        vh.memberSyncAt = 0
        await waitFor(() => vh.members.get('731').link === 'https://open.kakao.com/o/a731' && vh.members.get('732').link === 'https://open.kakao.com/o/a732', 5000, '#28-3 links filled')
        await sleep(300)
        if (sentIn(iHeal).some((t) => t.indexOf('프로필 변경 감지') >= 0)) throw new Error('#28-3 filling a link is not a profile change ' + JSON.stringify(sentIn(iHeal)))
      } finally {
        fs.infolinkFail = 0
        botA.slot.readPauseUntil = 0
      }
    })
  }
  // #28-4 GETMEM 이 빠뜨린 사람: 글을 쓰면 이름만 적어 두었다가 카드 채우기(MEMBER)가 옾링을 채운다(방마다 60초에 20명까지).
  //   명부에 없는 사람이 나가면 로그 한 줄 + 안내를 만들기 전에 MEMBER 를 한 번 읽어 본다(나간 사람에게도 답하는 경우)
  {
    const code = 'bookx31'
    const room0 = fs.room(code)
    fs.setProfiles('741', [{ li: '7411', name: '빠진 프로필', url: 'https://open.kakao.com/o/a741' }])
    fs.setProfiles('742', [{ li: '7421', name: '조용한 프로필', url: 'https://open.kakao.com/o/a742' }])
    room0.members['741'] = { mt: 2, nick: '빠진사람', ptp: 16, pli: '7411', photo: 'https://k.kakaocdn.net/dn/p/741.jpg', status: null }
    room0.members['742'] = { mt: 2, nick: '조용한사람', ptp: 16, pli: '7421', photo: 'https://k.kakaocdn.net/dn/p/742.jpg', status: null }
    const many = []
    for (let i = 1; i <= 24; i++) {
      many.push(String(7500 + i))
      room0.members[String(7500 + i)] = { mt: 2, nick: '손님' + i, ptp: 1, pli: null, photo: '', status: null }
    }
    room0.getmemSkip = ['741', '742', ...many]
    room0.keepLeft = true
    const iFill = install(code, { config: { visit: { enabled: true, style: 'text' }, profile: { enabled: true, style: 'text' } } })
    await pool.reconcile(null)
    await waitFor(() => rowOf(iFill).state === 'waiting_host', 5000, '#28-4 join')
    const chat = rowOf(iFill).chat_id
    fs.setPerm(chat, botA.uid, 4)
    await waitFor(() => rowOf(iFill).state === 'active', 3000, '#28-4 promotion')
    const vf = botA.slot.byInstall.get(iFill)
    await waitFor(() => vf.memberOkAt > 0, 5000, '#28-4 first sync')
    if (vf.members.has('741') || vf.members.has('742') || vf.members.has(many[0])) throw new Error('#28-4 GETMEM left them out')
    // 25명이 글을 쓴다 → 이름만 적힌 행 25개. 채우기를 잠시 막아 두고 모은다
    vf.memberFillAt = Date.now()
    fs.event(chat, botA.uid, { kind: 'message', user_id: '741', name: '빠진사람', text: '안녕하세요' })
    for (let i = 0; i < many.length; i++) fs.event(chat, botA.uid, { kind: 'message', user_id: many[i], name: '손님' + (i + 1), text: '안녕' })
    await waitFor(() => vf.memberWant.size === 25, 5000, '#28-4 25 name-only rows')
    const stub = vf.members.get('741')
    if (stub.name !== '빠진사람' || stub.pli !== null || stub.link !== null) throw new Error('#28-4 name-only row ' + JSON.stringify(stub))
    vf.memberFillAt = 0
    await waitFor(() => vf.memberWant.size === 5, 3000, '#28-4 first fill')
    await sleep(300)
    if (vf.memberWant.size !== 5) throw new Error('#28-4 at most 20 per room per minute, left ' + vf.memberWant.size)
    const m741 = vf.members.get('741')
    if (m741.link !== 'https://open.kakao.com/o/a741' || m741.pli !== '7411') throw new Error('#28-4 filled row ' + JSON.stringify(m741))
    vf.memberFillAt = 0
    await waitFor(() => vf.memberWant.size === 0 && many.every((id) => vf.members.get(id).pli === ''), 3000, '#28-4 the rest is filled a minute later')
    if (sentIn(iFill).some((t) => t.indexOf('프로필 변경 감지') >= 0)) throw new Error('#28-4 filling a name-only row is not a profile change')
    await pool.flush()
    if (!(await store.loadMembers(iFill, chat, 0)).some((r) => r.user_id === '741' && r.link === 'https://open.kakao.com/o/a741')) throw new Error('#28-4 filled row saved')
    // 명부에 없는 742 가 나간다 → 로그 한 줄 + MEMBER 로 읽어 퇴장 안내에 옾링
    await withLog(async (lines) => {
      fs.event(chat, botA.uid, { kind: 'leave', user_id: '742', name: '조용한사람' })
      await waitFor(() => sentIn(iFill).some((t) => t.indexOf('[퇴장 안내]') === 0), 8000, '#28-4 leave notice')
      const out = sentIn(iFill).find((t) => t.indexOf('[퇴장 안내]') === 0)
      if (out.indexOf('\n이름 : @조용한사람\n옾링 : https://open.kakao.com/o/a742\n') < 0 || out.indexOf('🖼') >= 0) throw new Error('#28-4 leave notice of someone not in the book ' + JSON.stringify(out))
      if (!hasLine(lines, `leave ${iFill}: 742 not in the member book`, 'member read: card')) throw new Error('#28-4 leave line ' + JSON.stringify(lines))
    })
  }
  // #28-7 GETMEM 이 빠뜨린 사람의 카드를 옾링 읽기가 실패하는 동안 채웠다(pli 는 있고 옾링만 모름):
  //   목록에서 빠지지 않고 다음 채우기가 옾링만(INFOLINK) 다시 읽는다. 옾링을 모른 채 나가면 나갈 때 옾링을 한 번 읽는다.
  {
    const code = 'bookx34'
    const room0 = fs.room(code)
    fs.setProfiles('771', [{ li: '7711', name: '늦은 프로필', url: 'https://open.kakao.com/o/a771' }])
    fs.setProfiles('772', [{ li: '7721', name: '나갈 프로필', url: 'https://open.kakao.com/o/a772' }])
    room0.members['771'] = { mt: 2, nick: '늦은사람', ptp: 16, pli: '7711', photo: 'https://k.kakaocdn.net/dn/p/771.jpg', status: null }
    room0.members['772'] = { mt: 2, nick: '나갈사람', ptp: 16, pli: '7721', photo: 'https://k.kakaocdn.net/dn/p/772.jpg', status: null }
    room0.getmemSkip = ['771', '772']
    room0.keepLeft = true
    botA.slot.joinH.list = []     // 봇 A 의 시간당 입장 한도(20)를 이 방이 쓰지 않게(뒤 시험의 입장이 밀리지 않게)
    const iLate = install(code, { config: { visit: { enabled: true, style: 'text' }, profile: { enabled: true, style: 'text' } } })
    await pool.reconcile(null)
    await waitFor(() => rowOf(iLate).state === 'waiting_host', 5000, '#28-7 join')
    const chat = rowOf(iLate).chat_id
    fs.setPerm(chat, botA.uid, 4)
    await waitFor(() => rowOf(iLate).state === 'active', 3000, '#28-7 promotion')
    const vt = botA.slot.byInstall.get(iLate)
    await waitFor(() => vt.memberOkAt > 0, 5000, '#28-7 first sync')
    try {
      vt.memberFillAt = Date.now()
      fs.event(chat, botA.uid, { kind: 'message', user_id: '771', name: '늦은사람', text: '안녕' })
      fs.event(chat, botA.uid, { kind: 'message', user_id: '772', name: '나갈사람', text: '안녕' })
      await waitFor(() => vt.memberWant.size === 2, 5000, '#28-7 name-only rows')
      // 옾링 읽기가 실패하는(속도 제한 아님) 동안 카드를 채운다 → pli 는 채워지고 옾링은 모름
      fs.infolinkFail = -500
      vt.memberFillAt = 0
      await waitFor(() => vt.members.get('771').pli && vt.members.get('772').pli, 3000, '#28-7 cards filled')
      const half = vt.members.get('771')
      if (half.pli !== '7711' || half.link !== null) throw new Error('#28-7 link unknown while INFOLINK fails ' + JSON.stringify(half))
      if (!vt.memberWant.has('771') || !vt.memberWant.has('772')) throw new Error('#28-7 rows with unknown link stay in the fill list')
      // 옾링을 모른 채 772 가 나간다 → 나갈 때 옾링을 한 번 읽는다(실패해도 안내는 나간다)
      fs.infolinkFail = 0
      vt.leaveReadAt = 0
      await withLog(async (lines) => {
        fs.event(chat, botA.uid, { kind: 'leave', user_id: '772', name: '나갈사람' })
        await waitFor(() => sentIn(iLate).some((t) => t.indexOf('[퇴장 안내]') === 0), 8000, '#28-7 leave notice')
        const out = sentIn(iLate).find((t) => t.indexOf('[퇴장 안내]') === 0)
        if (out.indexOf('\n옾링 : https://open.kakao.com/o/a772\n') < 0) throw new Error('#28-7 leave reads the unknown link ' + JSON.stringify(out))
        if (!hasLine(lines, `leave ${iLate}: 772 has no link in the member book`, 'link read: link')) throw new Error('#28-7 leave line ' + JSON.stringify(lines))
      })
      // 다음 채우기는 771 의 옾링만 다시 읽는다(MEMBER 없이)
      const members0 = packets('MEMBER').length
      vt.memberFillAt = 0
      await waitFor(() => vt.members.get('771').link === 'https://open.kakao.com/o/a771', 3000, '#28-7 link filled later')
      if (packets('MEMBER').length !== members0) throw new Error('#28-7 a link-only fill sends no MEMBER')
      if (vt.memberWant.has('771')) throw new Error('#28-7 filled row leaves the fill list')
      await sleep(300)
      if (sentIn(iLate).some((t) => t.indexOf('프로필 변경 감지') >= 0)) throw new Error('#28-7 filling a link is not a profile change')
    } finally {
      fs.infolinkFail = 0
    }
  }
  // #28-8 옾링 묶음(20개)에 읽지 못하는 사람이 있으면 카카오가 묶음 전체를 -500 으로 거절한다 → 나눠 다시 읽어 나머지는 읽고
  //   혼자서도 실패하는 사람만 옾링 없음으로 둔다. 읽지 못하는 사람이 많으면(두 쪽 다 실패) 옾링을 아는 사람 하나로 INFOLINK 가
  //   되는지 확인하고 하나씩 읽는다. INFOLINK 자체가 안 되면(확인도 실패) 몇 번만 보내고 멈추고 아무것도 정하지 않는다(모름).
  {
    const slot = botA.slot
    const ids = Array.from({ length: 37 }, (_, k) => String(7800 + k))
    for (const id of ids) fs.setProfiles(id, [{ li: id + '1', name: '묶음' + id, url: 'https://open.kakao.com/o/b' + id }])
    const plis = ids.map((id) => id + '1')
    const urlOf = (k) => 'https://open.kakao.com/o/b' + ids[k]
    const reads = () => packets('INFOLINK').length
    const check = (got, want, what) => {
      const miss = want.filter(([li, lu]) => got.get(li) !== lu)
      if (miss.length) throw new Error(what + ' ' + JSON.stringify(miss.map(([li, lu]) => [li, got.get(li), lu])))
    }
    try {
      // INFOLINK 가 안 된다 → 20·10·10·확인 한 번만 보내고 멈춘다
      fs.infolinkFail = -500
      const r0 = reads()
      await withLog(async (lines) => {
        const down = await slot.linksFor(plis.slice(0, 25))
        if (down.size !== 0) throw new Error('#28-8 nothing decided while INFOLINK fails ' + JSON.stringify([...down]))
        if (!hasLine(lines, 'open link read failed: status -500 (stopped) (25 left unknown', 'check read failed')) throw new Error('#28-8 down log ' + JSON.stringify(lines))
      })
      if (reads() - r0 > 4) throw new Error('#28-8 stops early while INFOLINK fails: ' + (reads() - r0))
      // 한 사람 → 그 사람만 옾링 없음
      fs.infolinkFail = 0
      fs.infolinkBad = new Set([plis[3]])
      await withLog(async (lines) => {
        const got = await slot.linksFor(plis.slice(0, 25))
        check(got, plis.slice(0, 25).map((li, k) => [li, k === 3 ? undefined : urlOf(k)]), '#28-8 split read')
        if (!hasLine(lines, 'open link read failed: status -500', '1 unreadable alone')) throw new Error('#28-8 log ' + JSON.stringify(lines))
      })
      const r1 = reads()
      await slot.linksFor(plis.slice(0, 25))
      if (reads() !== r1) throw new Error('#28-8 known links are not read again')
      // 많은 사람(12명 중 10명) → 확인 읽기 뒤 하나씩 읽어 두 사람만 옾링이 나오고, 나머지는 모름('없음'이 아니다)
      const many = plis.slice(25)
      fs.infolinkBad = new Set(many.filter((_, k) => k !== 4 && k !== 9))
      const got = await slot.linksFor(many)
      check(got, many.map((li, k) => [li, k === 4 || k === 9 ? urlOf(25 + k) : undefined]), '#28-8 many unreadable')
      // 혼자서도 못 읽은 사람은 30분 동안 묶음 읽기에서 빠지지만, 안내 전 읽기(linkNow)는 다시 읽는다
      fs.setProfiles('7900', [{ li: '79001', name: '혼자', url: 'https://open.kakao.com/o/b7900' }])
      fs.setProfiles('7901', [{ li: '79011', name: '혼자2', url: 'https://open.kakao.com/o/b7901' }])
      fs.infolinkBad = new Set(['79001'])
      const one = await slot.linksFor(['79001'])
      if (one.size !== 0 || !slot.badLinks.has('79001')) throw new Error('#28-8 single unreadable stays unknown ' + JSON.stringify([...one]))
      if (await slot.linkNow('79001') !== null) throw new Error('#28-8 linkNow of an unreadable link is unknown')
      fs.infolinkBad = new Set()
      const r2 = reads()
      if ((await slot.linksFor(['79001'])).size !== 0 || reads() !== r2) throw new Error('#28-8 an unreadable link is skipped for a while')
      if (await slot.linkNow('79001') !== 'https://open.kakao.com/o/b7900' || slot.badLinks.has('79001')) throw new Error('#28-8 linkNow reads it again before a notice')
      fs.infolinkFail = -500
      const none = await slot.linksFor(['79011'])
      if (none.size !== 0) throw new Error('#28-8 single while INFOLINK fails ' + JSON.stringify([...none]))
      if (await slot.linkNow('79011') !== null) throw new Error('#28-8 linkNow while INFOLINK fails is unknown')
    } finally {
      fs.infolinkFail = 0
      fs.infolinkBad = new Set()
    }
  }
  // #28-9 프로필 변경 안내는 옾링을 모르면(묶음 읽기 실패로 명부에 null) 보내기 전에 혼자 한 번 더 읽는다 → 주소.
  //   그래도 못 읽으면 '없음'이 아니라 '확인 못 함'. 카드 한 장(MEMBER)이 pli 를 빼고 줘도 아는 오픈프로필·옾링을 지우지 않는다.
  {
    const code = 'bookx36'
    const room0 = fs.room(code)
    fs.setProfiles('791', [{ li: '7911', name: '바꿀 프로필', url: 'https://open.kakao.com/o/a791' }])
    fs.setProfiles('792', [{ li: '7921', name: '못읽을 프로필', url: 'https://open.kakao.com/o/a792' }])
    fs.setProfiles('793', [{ li: '7931', name: '빠질 프로필', url: 'https://open.kakao.com/o/a793' }])
    room0.members['791'] = { mt: 2, nick: '옾프사람', ptp: 16, pli: '7911', photo: 'https://k.kakaocdn.net/dn/p/791.jpg', status: null }
    room0.members['792'] = { mt: 2, nick: '못읽음', ptp: 16, pli: '7921', photo: '', status: null }
    room0.members['793'] = { mt: 2, nick: '빠질사람', ptp: 16, pli: '7931', photo: '', status: null }
    botA.slot.joinH.list = []
    const iP = install(code, { config: { visit: { enabled: true, style: 'text' }, profile: { enabled: true, style: 'text' } } })
    await pool.reconcile(null)
    await waitFor(() => rowOf(iP).state === 'waiting_host', 5000, '#28-9 join')
    const chat = rowOf(iP).chat_id
    fs.setPerm(chat, botA.uid, 4)
    await waitFor(() => rowOf(iP).state === 'active', 3000, '#28-9 promotion')
    const vp = botA.slot.byInstall.get(iP)
    await waitFor(() => vp.memberOkAt > 0 && vp.members.get('791') && vp.members.get('791').link, 5000, '#28-9 first sync')
    const notice = (nm) => sentIn(iP).find((t) => t.indexOf('[프로필 변경 감지]') === 0 && t.indexOf('\n변경후 : @' + nm + '\n') >= 0)
    try {
      // 운영에서처럼 옾링을 모른 채(null) 남았고, 묶음 읽기는 그 사람을 30분 건너뛴다
      vp.members.set('791', Object.assign({}, vp.members.get('791'), { link: null }))
      botA.slot.linkCache.delete('7911')
      botA.slot.badLinks.set('7911', Date.now())
      fs.event(chat, botA.uid, { kind: 'message', user_id: '791', name: '옾프사람☯', text: '안녕' })
      room0.members['791'].nick = '옾프사람☯'
      await waitFor(() => notice('옾프사람☯'), 70000, '#28-9 rename notice')
      const n1 = notice('옾프사람☯')
      if (n1.indexOf('\n옾링 : https://open.kakao.com/o/a791\n') < 0 || n1.indexOf('🖼') >= 0) throw new Error('#28-9 the link is read before the notice ' + JSON.stringify(n1))
      if (vp.members.get('791').link !== 'https://open.kakao.com/o/a791') throw new Error('#28-9 the read link is kept in the book')
      // INFOLINK 가 안 된다 → 확인 못 함('없음' 아님)
      vp.members.set('792', Object.assign({}, vp.members.get('792'), { link: null }))
      botA.slot.linkCache.delete('7921')
      fs.infolinkFail = -500
      fs.event(chat, botA.uid, { kind: 'message', user_id: '792', name: '못읽음2', text: '안녕' })
      room0.members['792'].nick = '못읽음2'
      await waitFor(() => notice('못읽음2'), 70000, '#28-9 unread link notice')
      const n2 = notice('못읽음2')
      if (n2.indexOf('\n옾링 : 확인 못 함\n') < 0) throw new Error('#28-9 an unread link is not shown as none ' + JSON.stringify(n2))
      fs.infolinkFail = 0
      // MEMBER 가 pli 를 빼고 준다 → 명부의 pli·옾링은 그대로, 옾링 변경 안내 없음
      room0.memberNoPli = true
      fs.event(chat, botA.uid, { kind: 'message', user_id: '793', name: '빠질사람2', text: '안녕' })
      room0.members['793'].nick = '빠질사람2'
      await waitFor(() => notice('빠질사람2'), 70000, '#28-9 rename without pli')
      const n3 = notice('빠질사람2')
      const m793 = vp.members.get('793')
      if (m793.pli !== '7931' || m793.link !== 'https://open.kakao.com/o/a793') throw new Error('#28-9 a card without pli keeps the book ' + JSON.stringify(m793))
      if (n3.indexOf('옾링 변경전') >= 0 || n3.indexOf('\n옾링 : https://open.kakao.com/o/a793\n') < 0) throw new Error('#28-9 no false link change ' + JSON.stringify(n3))
    } finally {
      fs.infolinkFail = 0
      room0.memberNoPli = false
      botA.slot.badLinks.delete('7911')
    }
  }
  // #28-5 나간 사람의 카드를 읽지 못해도 안내는 나간다(옾링 확인 못 함). 읽기는 2초에서 끊고, 방마다 10초에 한 번만 한다.
  {
    const code = 'bookx32'
    const room0 = fs.room(code)
    for (const id of ['751', '752', '753']) room0.members[id] = { mt: 2, nick: '나갈사람' + id, ptp: 1, pli: null, photo: '', status: null }
    room0.getmemSkip = ['751', '752', '753']
    const iLv = install(code, { config: { visit: { enabled: true, style: 'text' } } })
    await pool.reconcile(null)
    await waitFor(() => rowOf(iLv).state === 'waiting_host', 5000, '#28-5 join')
    const chat = rowOf(iLv).chat_id
    fs.setPerm(chat, botA.uid, 4)
    await waitFor(() => rowOf(iLv).state === 'active', 3000, '#28-5 promotion')
    const vl = botA.slot.byInstall.get(iLv)
    await waitFor(() => vl.memberOkAt > 0, 5000, '#28-5 first sync')
    // 아래에서 onVisit 를 바로 기다리는 동안 이벤트 루프가 비지 않게(풀의 타이머는 unref)
    const alive = setInterval(() => {}, 100)
    await withLog(async (lines) => {
      try {
        // 751: 나간 뒤라 MEMBER 에 카드가 없다 → 옾링은 확인 못 함('없음'이라고 하지 않는다), 사진 줄은 늘 없음
        fs.event(chat, botA.uid, { kind: 'leave', user_id: '751', name: '나갈사람751' })
        await waitFor(() => sentIn(iLv).some((t) => t.indexOf('[퇴장 안내]') === 0), 70000, '#28-5 leave notice')
        const out = sentIn(iLv).find((t) => t.indexOf('[퇴장 안내]') === 0)
        if (out.indexOf('\n이름 : @나갈사람751\n옾링 : 확인 못 함\n') < 0 || out.indexOf('🖼 사진') >= 0) throw new Error('#28-5 leave notice without a card ' + JSON.stringify(out))
        if (!hasLine(lines, `leave ${iLv}: 751 not in the member book (book 0, last sync `, 'member read: no card')) throw new Error('#28-5 leave line ' + JSON.stringify(lines))
        // 752: MEMBER 가 답하지 않는다 → 2초에서 끊고 안내를 만든다
        room0.memberHang = true
        vl.leaveReadAt = 0
        let t0 = Date.now()
        await botA.slot.onVisit(vl, { kind: 'leave', userId: '752', name: '나갈사람752', logId: '7520001', at: Date.now() })
        const took = Date.now() - t0
        if (took < 1800 || took > 3500) throw new Error('#28-5 a stuck read is cut at 2 s, took ' + took)
        // 753: 10초 안의 두 번째는 읽지 않고 바로 안내
        t0 = Date.now()
        await botA.slot.onVisit(vl, { kind: 'leave', userId: '753', name: '나갈사람753', logId: '7530001', at: Date.now() })
        if (Date.now() - t0 > 500) throw new Error('#28-5 one read per room per 10 s')
        if (!hasLine(lines, `leave ${iLv}: 752 not in`, 'member read: timed out') || !hasLine(lines, `leave ${iLv}: 753 not in`, 'member read: skipped')) throw new Error('#28-5 leave lines ' + JSON.stringify(lines))
        await waitFor(() => sentIn(iLv).filter((t) => t.indexOf('[퇴장 안내]') === 0).length === 3, 70000, '#28-5 all leave notices go out')
      } finally {
        clearInterval(alive)
        room0.memberHang = false
        fs.releaseHeld()
      }
    })
  }
  // #28-6 명부 일은 방 점검 줄과 따로 돈다. 한 방의 GETMEM 이 답하지 않아도 memberJobMs 뒤 다른 방의 명부 일이 이어지고,
  //   멈춘 방은 그 일이 끝날 때까지 다시 동기화하지 않는다. GETMEM 실패는 로그 한 줄로 남고 명부는 그대로다.
  {
    const code = 'bookx33'
    const room0 = fs.room(code)
    room0.members['761'] = { mt: 2, nick: '기다림', ptp: 1, pli: null, photo: '', status: null }
    const iHang = install(code, { config: { visit: { enabled: true } } })
    await pool.reconcile(null)
    await waitFor(() => rowOf(iHang).state === 'waiting_host', 5000, '#28-6 join')
    const chat = rowOf(iHang).chat_id
    fs.setPerm(chat, botA.uid, 4)
    await waitFor(() => rowOf(iHang).state === 'active', 3000, '#28-6 promotion')
    const vh = botA.slot.byInstall.get(iHang)
    await waitFor(() => vh.memberOkAt > 0 && !vh.memberSyncing, 5000, '#28-6 first sync')
    // 다른 방: #28-5 의 방
    const vOther = botA.slot.byInstall.get([...store.installs.values()].find((r) => r.link_url === url('bookx32')).id)
    let open = null
    await withLog(async (lines) => {
      try {
        // GETMEM 실패(-500) → 로그 한 줄, 명부·마지막 동기화 시각은 그대로
        const okF = vh.memberOkAt
        room0.getmemFail = -500
        vh.memberSyncAt = 0
        await waitFor(() => hasLine(lines, `member sync ${iHang}: GETMEM failed (status -500)`), 3000, '#28-6 GETMEM failure is logged')
        await waitFor(() => !vh.memberSyncing, 3000, '#28-6 failed sync ends')
        if (vh.memberOkAt !== okF || !vh.members.get('761')) throw new Error('#28-6 a failed sync keeps the book')
        room0.getmemFail = 0
        // GETMEM 이 답하지 않는다 → 300ms 뒤 명부 줄은 다음 일로
        botA.slot.opts = Object.assign({}, pool.opts, { memberJobMs: 300 })
        room0.getmemHang = true
        vh.memberSyncAt = 0
        await waitFor(() => fs.holds.length === 1, 3000, '#28-6 GETMEM is stuck')
        // 방 점검 줄이 막혀 있어도 명부 일은 돈다
        const gate = new Promise((ok) => { open = ok })
        botA.slot.checks = botA.slot.checks.then(() => gate)
        const ok0 = vOther.memberOkAt
        vOther.memberSyncAt = 0
        await waitFor(() => vOther.memberOkAt > ok0, 3000, '#28-6 another room syncs while one is stuck')
        if (!hasLine(lines, `member sync ${iHang} timed out`)) throw new Error('#28-6 timed out line')
        // 멈춘 방은 두 번째 동기화를 시작하지 않는다
        vh.memberSyncAt = 0
        await sleep(200)
        if (!vh.memberSyncing || fs.holds.length !== 1) throw new Error('#28-6 the stuck room does not start a second sync')
        // 풀리면 그 일이 끝나고, 다음 동기화를 받는다
        const okH = vh.memberOkAt
        room0.getmemHang = false
        fs.releaseHeld()
        await waitFor(() => !vh.memberSyncing && vh.memberOkAt > okH, 3000, '#28-6 the stuck sync finishes later')
      } finally {
        if (open) open()
        room0.getmemFail = 0
        room0.getmemHang = false
        fs.releaseHeld()
        botA.slot.opts = pool.opts
      }
    })
  }
  // #29 나간 사람 재입장 차단(7.2 (b)): 카카오가 나간 사람의 내보내기를 받지 않아도(FAKE_KICK_LEFT=0) 그 실패는
  //   연속 실패 멈춤으로 세지 않는다(권한은 실패마다 다시 읽는다). 방 안 사람의 진짜 실패는 그대로 세어 3번이면 10분 멈춘다.
  //   멈춤·올킥 감지·한도로 건너뛴 나간 사람도 bans 에 적고 kick_fail 로 남긴다(패널 표에서 해제). 다시 들어오면 내보내고 bans 를 지운다.
  //   방 관리봇이 꺼져 있어 건너뛴 사람은 적지 않는다. 적어 둔 뒤 제외 대상이 되거나 재입장 차단을 끄면 다시 들어와도 내보내지 않는다.
  //   레이트리밋 답은 나간 사람이어도 센다.
  {
    const iK = install('lkickx1', { config: { leaveKick: { enabled: true } } })
    await pool.reconcile(null)
    await waitFor(() => rowOf(iK).state === 'waiting_host', 5000, '#29 join')
    const chat = rowOf(iK).chat_id
    fs.setPerm(chat, botA.uid, 4)
    await waitFor(() => rowOf(iK).state === 'active', 3000, '#29 promotion')
    const vk = botA.slot.byInstall.get(iK)
    const prevLeft = process.env.FAKE_KICK_LEFT
    const kMark = [botA.slot.limits.kickH.list.length, botA.slot.limits.kickD.list.length]
    let seq = 0
    const leave = (uid) => botA.slot.onVisit(vk, { kind: 'leave', userId: uid, name: '나간' + uid, logId: uid + String(++seq).padStart(4, '0'), at: Date.now() })
    const logsOf = (uid, kind) => store.logs.filter((l) => l.install_id === iK && l.user_id === uid && l.kind === kind)
    const banned = (uid) => RF.bannedNow(vk.runtime, uid, Date.now())
    const kicks = () => packets('KICKMEM', (p) => p.chat === chat)
    process.env.FAKE_KICK_LEFT = '0'
    try {
      // 나간 3명: KICKMEM 3번 모두 거절 → 멈추지 않음, 3명 모두 bans + kick_fail, 권한은 실패마다 다시 읽음
      const perm0 = packets('CHATONROOM', (p) => p.chat === chat).length
      for (const uid of ['7301', '7302', '7303']) await leave(uid)
      if (kicks().length !== 3) throw new Error('#29 one KICKMEM per leaver ' + kicks().length)
      if (vk.failStreak !== 0 || vk.actPausedUntil > Date.now()) throw new Error('#29 refused leaver kicks do not pause the room ' + vk.failStreak + ' ' + vk.actPausedUntil)
      if (!['7301', '7302', '7303'].every((u) => banned(u) && logsOf(u, 'kick_fail').length === 1)) throw new Error('#29 every refused leaver is banned and logged')
      if (packets('CHATONROOM', (p) => p.chat === chat).length - perm0 < 3) throw new Error('#29 each failure still re-reads the permission')
      // 방 안 사람의 실패(여기서는 manual)는 센다. 나간 사람의 실패는 세지도 되돌리지도 않는다 → 세 번째에서 멈춤
      await botA.slot.kick(vk, '7311', 'm1', 'manual')
      await leave('7304')
      if (vk.failStreak !== 1 || !banned('7304')) throw new Error('#29 a leaver failure leaves the streak alone ' + vk.failStreak)
      await botA.slot.kick(vk, '7312', 'm2', 'manual')
      await botA.slot.kick(vk, '7313', 'm3', 'manual')
      if (!(vk.actPausedUntil > Date.now() + 9 * 60000)) throw new Error('#29 three real failures still pause for 10 min')
      // 멈춘 동안 나감 → KICKMEM 없이 bans + skip(paused) + kick_fail
      const k0 = kicks().length
      await leave('7305')
      if (kicks().length !== k0 || !banned('7305')) throw new Error('#29 a leaver while paused is still banned')
      if (!logsOf('7305', 'skip').some((l) => l.detail.note === 'paused') || logsOf('7305', 'kick_fail').length !== 1) throw new Error('#29 paused leaver logs ' + JSON.stringify(store.logs.filter((l) => l.user_id === '7305')))
      // 방 한도(시간 10회)로 건너뜀 → bans + kick_fail
      vk.actPausedUntil = 0
      vk.failStreak = 0
      while (vk.limits.kick.ok(Date.now())) vk.limits.kick.add(Date.now())
      await leave('7306')
      if (kicks().length !== k0 || !banned('7306') || logsOf('7306', 'kick_fail').length !== 1) throw new Error('#29 a leaver over the room limit is still banned')
      vk.limits.kick.list.length = 0
      // 올킥 감지로 멈춘 동안 나감 → KICKMEM 없이 bans + skip(wave) + kick_fail
      const g0 = vk.runtime.guard
      vk.runtime.guard = Object.assign({}, g0, { halt: Object.assign({}, g0 && g0.halt, { [chat]: Date.now() + 60000 }) })
      try {
        await leave('7308')
      } finally {
        vk.runtime.guard = g0
      }
      if (kicks().length !== k0 || !banned('7308') || !logsOf('7308', 'skip').some((l) => l.detail.note === 'wave') || logsOf('7308', 'kick_fail').length !== 1) throw new Error('#29 a leaver during a kick wave halt is still banned')
      // 방 관리봇이 꺼진 동안(권한 없음)은 적지 않는다
      const perm = vk.perm
      vk.perm = 2
      await botA.slot.doLeaveKick(vk, { type: 'kick', userId: '7307', name: '나간7307' })
      vk.perm = perm
      if (banned('7307') || logsOf('7307', 'kick_fail').length) throw new Error('#29 no ban while the room bot is off')
      // 적어 둔 사람이 다시 들어옴 → 방 안이라 내보내기 성공, bans 지움
      fs.byChat(chat).members['7305'] = { mt: 2, nick: '나간7305', ptp: 1, pli: null, photo: '', status: null }
      await botA.slot.onVisit(vk, { kind: 'join', userId: '7305', name: '나간7305', logId: '73059999', at: Date.now() })
      if (banned('7305') || !fs.byChat(chat).kicked.includes('7305') || logsOf('7305', 'kick').length !== 1) throw new Error('#29 a banned leaver who comes back is kicked')
      // 해제는 그대로: kick_fail 만 있는 사람 → bans 만 지움(KLDELITEM 없음)
      const kl0 = packets('KLDELITEM').length
      if (!(await pool.unkick(iK, '7306')).ok || banned('7306') || packets('KLDELITEM').length !== kl0) throw new Error('#29 unkick a held leaver')
      // 적어 둔 뒤 제외 대상이 된 사람, 재입장 차단을 끈 방: 다시 들어와도 내보내지 않는다(적어 둔 것은 그대로)
      const cfg0 = vk.cfg
      const k1 = kicks().length
      try {
        vk.cfg = Object.assign({}, cfg0, { exempt: [{ user_id: '7301', name: '나간7301' }] })
        fs.byChat(chat).members['7301'] = { mt: 2, nick: '나간7301', ptp: 1, pli: null, photo: '', status: null }
        await botA.slot.onVisit(vk, { kind: 'join', userId: '7301', name: '나간7301', logId: '73019999', at: Date.now() })
        vk.cfg = Object.assign({}, cfg0, { leaveKick: Object.assign({}, cfg0.leaveKick, { enabled: false }) })
        fs.byChat(chat).members['7302'] = { mt: 2, nick: '나간7302', ptp: 1, pli: null, photo: '', status: null }
        await botA.slot.onVisit(vk, { kind: 'join', userId: '7302', name: '나간7302', logId: '73029999', at: Date.now() })
      } finally {
        vk.cfg = cfg0
      }
      if (kicks().length !== k1 || !banned('7301') || !banned('7302') || logsOf('7301', 'kick').length || logsOf('7302', 'kick').length) throw new Error('#29 no rejoin kick for an exempt person or with the feature off')
      // 레이트리밋 답(-805)은 나간 사람이어도 센다 → 세 번이면 10분 멈춤
      vk.failStreak = 0
      vk.actPausedUntil = 0
      const openAction0 = botA.slot.openAction
      botA.slot.openAction = async (v, method, extra) => (method === 'KICKMEM' ? { ok: false, status: -805 } : openAction0.call(botA.slot, v, method, extra))
      try {
        for (const uid of ['7321', '7322', '7323']) await leave(uid)
      } finally {
        delete botA.slot.openAction
      }
      if (!(vk.actPausedUntil > Date.now() + 9 * 60000) || !['7321', '7322', '7323'].every((u) => banned(u))) throw new Error('#29 rate-limited leaver kicks still pause the room ' + vk.failStreak)
    } finally {
      if (prevLeft === undefined) delete process.env.FAKE_KICK_LEFT
      else process.env.FAKE_KICK_LEFT = prevLeft
      vk.actPausedUntil = 0
      vk.failStreak = 0
      botA.slot.limits.kickH.list.splice(kMark[0])
      botA.slot.limits.kickD.list.splice(kMark[1])
    }
  }
  // #40 방 관리 명령어(7.3)와 그림 기록(7.2(a)(c))을 실제 botpool 경로로:
  //   · 부방장 지정 대기: 방장·부방장의 방 관리 명령어에 지정이 먼저라고 답한다(다른 사람은 조용)
  //   · !도움·!도움 관리 · !옾링(멘션·옾링 주소·닉네임, 권한, 같은 닉네임·못 찾음) · !프로필조회(바뀐 적 없는 사람도) · !내보내기(권한·보호·
  //     닉네임 거절·옾링 주소로·방에 없음·올킥 감지 멈춤) · !차단해제 · !설정 · 켜고 끄기·금지어(저장본·config_rev·패널과 겹침·모르는 칸 유지·
  //     부모 검증 통과·재조정이 되돌리지 않음·저장 실패) · 방장·부방장이 아닌 사람의 명령어 글도 홍보 금지 검사
  //   · 입장 안내 그림(720) + 바로 뒤 멘션 한 줄 · 그림 실패 → 지금의 글 안내(멘션 포함) · 글 모양 설정 · 그림을 못 만들면 글
  {
    const RC40 = await import('./roomcmd.mjs')
    const CARD40 = await import('./card.mjs')
    const code = 'cmdx40'
    const room0 = fs.room(code)
    fs.setProfiles('4011', [{ li: '40111', name: '하늘 프로필', url: 'https://open.kakao.com/o/sky4011' }])
    fs.setProfiles('4013', [{ li: '40131', name: '하늘2 프로필', url: 'https://open.kakao.com/o/sky4013' }])
    fs.setProfiles('4014', [{ li: '40141', name: '구름 프로필', url: 'https://open.kakao.com/o/cloud4014' }])
    fs.setProfiles('4015', [{ li: '40151', name: '별빛 프로필', url: 'https://open.kakao.com/o/star4015' }])
    const mem = (mt, nick, pli) => ({ mt, nick, ptp: pli ? 16 : 1, pli: pli || null, photo: '', status: null })
    room0.members['4001'] = mem(1, '방장님')
    room0.members['4002'] = mem(4, '부방장')
    room0.members['4011'] = mem(2, '하늘', '40111')
    room0.members['4012'] = mem(2, '바다')
    room0.members['4013'] = mem(2, '하늘', '40131')
    room0.members['4014'] = mem(2, '구름', '40141')
    const iC = install(code, { config: { visit: { enabled: true }, profile: { enabled: true } } })
    await pool.reconcile(null)
    await waitFor(() => rowOf(iC).state === 'waiting_host', 5000, '#40 join')
    const chat = rowOf(iC).chat_id
    const vc = botA.slot.byInstall.get(iC)
    const pc = botA.slot.pacer
    const botMax0 = pc.botWin.max
    pc.botWin.max = 100000
    pc.room(String(iC)).win.max = 100000
    const sent = () => fs.sentIn(chat)
    const texts = () => sent().map((x) => x.text)
    const kMark = [botA.slot.limits.kickH.list.length, botA.slot.limits.kickD.list.length]
    try {
      await waitFor(() => texts().some((t) => t.startsWith('[K bot]')), 5000, '#40 bot join notice')
      const post = (uid, name, text, mentionId) => fs.event(chat, botA.uid, {
        kind: 'message', user_id: uid, name, text,
        attachment: mentionId ? { mentions: [{ user_id: Number(mentionId), at: [1], len: 2 }] } : undefined,
      })
      const ask = async (uid, name, text, mentionId) => {
        const n = sent().length
        post(uid, name, text, mentionId)
        await waitFor(() => sent().length > n, 5000, '#40 reply to ' + text)
        await sleep(30)
        return sent()[n].text
      }
      const quiet = async (uid, name, text) => {
        const n = sent().length
        post(uid, name, text)
        await sleep(400)
        if (sent().length !== n) throw new Error('#40 no reply to ' + text + ' ' + JSON.stringify(texts().slice(n)))
      }
      const expect = async (got, want, what) => {
        const t = await got
        if (t !== want) throw new Error('#40 ' + what + ' ' + JSON.stringify(t))
      }
      // 부방장 지정 대기
      await expect(ask('4001', '방장님', '!설정'), RC40.notLiveReply(botA.slot.nameIn(vc)), 'waiting: host is told to promote the bot')
      await quiet('4012', '바다', '!설정')
      fs.setPerm(chat, botA.uid, 4)
      await waitFor(() => rowOf(iC).state === 'active', 3000, '#40 promotion')
      await waitFor(() => texts().some((x) => x.indexOf('부방장으로 지정되었어요') >= 0), 3000, '#40 promoted notice')
      await waitFor(() => vc.members.get('4014') && vc.members.get('4014').link === 'https://open.kakao.com/o/cloud4014' && vc.memberOkAt > 0, 5000, '#40 member book')
      await sleep(100)
      // 도움말
      await expect(ask('4012', '바다', '!도움'), '[명령어]\n방 관리 : !옾링 !프로필조회 !가리기 !내보내기 !설정\n「!도움 관리」를 입력하면 방 관리 명령어 설명을 볼 수 있어요.', 'help')
      if (!(await ask('4012', '바다', '!도움 관리')).startsWith('[방 관리 명령어]\n!옾링 @닉네임 : 옾링 보기')) throw new Error('#40 admin help')
      // !옾링: 기본은 방장·부방장만
      await expect(ask('4012', '바다', '!옾링 구름'), '옾링 조회는 방장과 부방장만 할 수 있어요.', 'link staff only')
      await expect(ask('4002', '부방장', '!옾링'), '「!옾링 @닉네임」처럼 입력해 주세요. 옾링 주소나 닉네임으로도 찾을 수 있어요.', 'link usage')
      await expect(ask('4002', '부방장', '!옾링 구름'), '[옾링]\n이름 : 구름\n옾링 : https://open.kakao.com/o/cloud4014', 'link by name')
      await expect(ask('4002', '부방장', '!옾링 @바다', '4012'), '[옾링]\n이름 : 바다\n옾링 : 없음', 'link by mention (default profile)')
      await expect(ask('4001', '방장님', '!옾링 https://open.kakao.com/o/sky4013'), '[옾링]\n이름 : 하늘\n옾링 : https://open.kakao.com/o/sky4013', 'link by link')
      await expect(ask('4001', '방장님', '!옾링 open.kakao.com/o/cloud4014/'), '[옾링]\n이름 : 구름\n옾링 : https://open.kakao.com/o/cloud4014', 'link by link without https')
      await expect(ask('4001', '방장님', '!옾링 하늘'), '같은 이름을 쓰는 사람이 2명 있어요. @멘션으로 골라 주세요.', 'link same name')
      await expect(ask('4001', '방장님', '!옾링 없는사람'), '「없는사람」을 이 방에서 찾지 못했어요.', 'link name not found')
      await expect(ask('4001', '방장님', '!옾링 https://open.kakao.com/o/nobody40'), '그 옾링을 쓰는 사람을 이 방에서 찾지 못했어요.', 'link not found')
      // !프로필조회: 바뀐 적이 없는 사람도 명부에서 찾아 답한다(예전에는 「기록이 없어요」) · !프로필 도 같다
      const prof = '[프로필 기록]\n이름 : 구름\n이전 이름 : 없음\n최근 14일 : 입장 0회 · 퇴장 0회'
      await expect(ask('4001', '방장님', '!프로필조회 구름'), prof, 'profile lookup by name')
      await expect(ask('4001', '방장님', '!프로필 https://open.kakao.com/o/cloud4014'), prof, 'profile lookup alias by link')
      await expect(ask('4012', '바다', '!프로필조회 구름'), '프로필 조회는 방장과 부방장만 할 수 있어요.', 'profile staff only')
      // !내보내기
      const kicks = () => packets('KICKMEM', (p) => p.chat === chat)
      const k0 = kicks().length
      await expect(ask('4012', '바다', '!내보내기 @구름', '4014'), '내보내기는 방장과 부방장만 할 수 있어요.', 'kick staff only')
      await expect(ask('4002', '부방장', '!내보내기 구름'), '「!내보내기 @닉네임」처럼 멘션으로 입력해 주세요. 옾링 주소로도 고를 수 있어요.', 'kick does not pick by name')
      await expect(ask('4002', '부방장', '!내보내기 @방장님', '4001'), '방장·부방장·제외 대상은 내보낼 수 없어요.', 'kick protects the host')
      await expect(ask('4002', '부방장', '!내보내기 @케이봇', botA.uid), '방장·부방장·제외 대상은 내보낼 수 없어요.', 'kick protects the bot')
      if (kicks().length !== k0) throw new Error('#40 no KICKMEM for refused kicks')
      // 올킥 감지로 멈춘 동안: 내보내지 않고 남은 분을 말한다
      const g0 = vc.runtime.guard
      vc.runtime.guard = Object.assign({}, g0, { halt: Object.assign({}, g0 && g0.halt, { [chat]: Date.now() + 5 * 60000 - 1000 }) })
      try {
        await expect(ask('4002', '부방장', '!내보내기 @바다', '4012'), '올킥 감지로 K bot의 내보내기가 멈춰 있어요. 5분쯤 뒤에 다시 입력해 주세요.', 'kick during a wave halt')
      } finally {
        vc.runtime.guard = g0
      }
      if (kicks().length !== k0) throw new Error('#40 no KICKMEM during a halt')
      await expect(ask('4002', '부방장', '!내보내기 https://open.kakao.com/o/cloud4014'), '구름님을 내보냈어요.', 'kick by link')
      if (kicks().length !== k0 + 1 || !fs.byChat(chat).kicked.includes('4014')) throw new Error('#40 KICKMEM sent')
      const kl = store.logs.filter((l) => l.install_id === iC && l.kind === 'kick' && l.user_id === '4014')
      if (kl.length !== 1 || kl[0].detail.why !== 'command' || kl[0].detail.by !== '4002' || kl[0].name !== '구름') throw new Error('#40 kick log ' + JSON.stringify(kl))
      await expect(ask('4002', '부방장', '!내보내기 https://open.kakao.com/o/cloud4014'), '그 사람은 지금 이 방에 없어요.', 'kick someone who is gone')
      // !차단해제: K bot이 내보낸 사람(닉네임으로) → 카카오 내보내기 목록에서도 푼다
      await expect(ask('4001', '방장님', '!차단해제 구름'), '구름님의 내보내기·재입장 차단을 풀었어요. 다시 들어올 수 있어요.', 'unban')
      if (fs.byChat(chat).kicked.includes('4014')) throw new Error('#40 unban sends KLDELITEM')
      await expect(ask('4001', '방장님', '!차단해제 바다'), 'K bot이 내보내거나 차단한 사람이 아니에요.', 'unban someone not kicked')
      await expect(ask('4012', '바다', '!차단해제 구름'), '차단 해제는 방장과 부방장만 할 수 있어요.', 'unban staff only')
      // !설정 · 켜고 끄기: 패널과 같은 방 설정(room_installs.config)에 저장, config_rev + 1
      await expect(ask('4012', '바다', '!설정'), '설정은 방장과 부방장만 바꿀 수 있어요.', 'status staff only')
      await expect(ask('4012', '바다', '!들낙감지 켜기'), '설정은 방장과 부방장만 바꿀 수 있어요.', 'toggle staff only')
      const st = await ask('4001', '방장님', '!설정')
      if (!st.startsWith('[설정]\n입장·퇴장 기록 : 켜짐\n들낙 감지 : 꺼짐\n')) throw new Error('#40 status ' + JSON.stringify(st))
      const rev0 = Number(rowOf(iC).config_rev) || 0
      rowOf(iC).config = Object.assign({}, rowOf(iC).config, { future: { keep: 1 } })     // 이 버전이 모르는 칸
      await expect(ask('4001', '방장님', '!들낙감지 켜기'), '들낙 감지를 켰어요.', 'toggle on')
      if (rowOf(iC).config.churn.enabled !== true || rowOf(iC).config_rev !== rev0 + 1 || !vc.cfg.churn.enabled || vc.rev !== rev0 + 1) throw new Error('#40 toggle is saved ' + JSON.stringify([rowOf(iC).config.churn, rowOf(iC).config_rev, rev0]))
      if (!rowOf(iC).config.future || rowOf(iC).config.future.keep !== 1 || rowOf(iC).config.visit.enabled !== true) throw new Error('#40 other fields are kept')
      const cl = store.logs.filter((l) => l.install_id === iC && l.kind === 'config')
      if (cl.length !== 1 || cl[0].user_id !== '4001' || cl[0].detail.text !== '들낙 감지 켜기' || cl[0].detail.by !== 'room') throw new Error('#40 config log ' + JSON.stringify(cl))
      await expect(ask('4001', '방장님', '!들낙 감지 켜기'), '들낙 감지는 이미 켜져 있어요.', 'toggle already on')
      if (rowOf(iC).config_rev !== rev0 + 1) throw new Error('#40 no save when nothing changes')
      await expect(ask('4001', '방장님', '!입장기록'), '「!입장기록 켜기」·「!입장기록 끄기」로 입력해 주세요. 지금은 켜져 있어요.', 'toggle usage')
      // 재조정이 예전 행(그 전에 읽은 목록)을 주어도 되돌리지 않는다
      await botA.slot.upsertView(Object.assign({}, rowOf(iC), { config: {}, config_rev: rev0 }))
      if (!vc.cfg.churn.enabled) throw new Error('#40 an older reconcile row does not undo a room command')
      // 패널이 그사이 저장했다(config_rev 가 바뀜) → 다시 읽어 합친다(패널 값 유지)
      const row = store.installs.get(iC)
      store.installs.set(iC, Object.assign({}, row, { config: Object.assign({}, row.config, { guard: { enabled: false, secs: 60, count: 5 } }), config_rev: row.config_rev + 1 }))
      const getInstall0 = store.getInstall
      let reads = 0
      store.getInstall = async (id) => {
        reads++
        const r = await getInstall0.call(store, id)
        // 첫 읽기 뒤 패널이 한 번 더 저장한다(겹침)
        if (reads === 1) { const cur = store.installs.get(iC); store.installs.set(iC, Object.assign({}, cur, { config_rev: cur.config_rev + 1 })) }
        return r
      }
      try {
        await expect(ask('4002', '부방장', '!올킥감지 켜기'), '올킥 감지를 켰어요.', 'toggle after a panel save')
      } finally {
        store.getInstall = getInstall0
      }
      if (reads !== 2 || rowOf(iC).config.guard.enabled !== true || rowOf(iC).config.guard.secs !== 60 || !vc.cfg.guard.enabled || vc.cfg.guard.secs !== 60) throw new Error('#40 retried on a stale rev and kept the panel value ' + JSON.stringify([reads, rowOf(iC).config.guard]))
      // 금지어
      await expect(ask('4001', '방장님', '!금지어 추가 토토, 바카라'), '금지어 2개를 추가했어요. 지금 2개예요.\n금지어 검열은 꺼져 있어요. 「!금지어 켜기」로 켤 수 있어요.', 'words add')
      await expect(ask('4001', '방장님', '!금지어 목록'), '[금지어]\n토토, 바카라', 'words list')
      await expect(ask('4001', '방장님', '!금지어 삭제 토토'), '금지어 1개를 삭제했어요. 지금 1개예요.', 'words del')
      await expect(ask('4001', '방장님', '!금지어 켜기'), '금지어 검열을 켰어요.', 'cover on')
      if (JSON.stringify(rowOf(iC).config.cover.words) !== '["바카라"]' || rowOf(iC).config.cover.enabled !== true || !vc.cfg.cover.enabled) throw new Error('#40 words saved ' + JSON.stringify(rowOf(iC).config.cover))
      // 방에서 바꾼 설정은 부모 검증(lib/room-config.js)을 그대로 통과하고, 양쪽 정리 결과가 같다
      {
        const { createRequire } = await import('node:module')
        const rc = createRequire(import.meta.url)('../../lib/room-config.js')
        const cfgNow = rowOf(iC).config
        const chk = rc.sanitizeRoomConfig({}, rc.normalizeRoomConfig(cfgNow), { products: { roombot: true, minigame: true }, display: 'active' })
        if (!chk.ok || JSON.stringify(rc.normalizeRoomConfig(cfgNow)) !== JSON.stringify(RF.normRoomConfig(cfgNow))) throw new Error('#40 parent accepts the saved config ' + JSON.stringify(chk))
      }
      // 저장이 안 되면(계속 겹침) 답으로 알린다
      const save0 = store.saveRoomConfig
      store.saveRoomConfig = async () => 0
      try {
        await expect(ask('4001', '방장님', '!재입장차단 켜기'), '설정을 저장하지 못했어요. 잠시 뒤 다시 입력해 주세요.', 'save failure')
      } finally {
        store.saveRoomConfig = save0
      }
      if (vc.cfg.leaveKick.enabled) throw new Error('#40 a failed save changes nothing')
      // 방장·부방장이 아닌 사람의 명령어 글도 홍보 금지 검사를 받는다(명령어로 링크를 숨겨 올리지 못하게)
      await expect(ask('4001', '방장님', '!홍보금지 켜기'), '홍보 금지를 켰어요.', 'promo on')
      const rw0 = packets('REWRITE', (p) => p.chat === chat).length
      const n0 = sent().length
      post('4012', '바다', '!옾링 https://spam.example.com/x')
      await waitFor(() => texts().slice(n0).some((t) => t.startsWith('[홍보 금지]')), 5000, '#40 promo on a command message')
      if (texts()[n0] !== '옾링 조회는 방장과 부방장만 할 수 있어요.' || packets('REWRITE', (p) => p.chat === chat).length !== rw0 + 1) throw new Error('#40 command message is moderated ' + JSON.stringify(texts().slice(n0)))
      await expect(ask('4001', '방장님', '!홍보금지 끄기'), '홍보 금지를 껐어요.', 'promo off')
      // !옾링 끄기 → 조용(다음 처리로) · 모두 → 누구나
      const setCfg = async (patch) => {
        const cur = store.installs.get(iC)
        store.installs.set(iC, Object.assign({}, cur, { config: RC40.applyPatch(cur.config, patch), config_rev: cur.config_rev + 1 }))
        await pool.reconcile(null)
      }
      await setCfg({ cmd: { link: 'off' } })
      await quiet('4001', '방장님', '!옾링 구름')
      await setCfg({ cmd: { link: 'all' } })
      await expect(ask('4012', '바다', '!옾링 https://open.kakao.com/o/sky4011'), '[옾링]\n이름 : 하늘\n옾링 : https://open.kakao.com/o/sky4011', 'link for everyone')
      // 입장 안내 그림: 사진(폭 720) 1장 + 바로 뒤 멘션 한 줄 `[입장 안내] @별빛`
      const join = async (uid, name, pli) => {
        room0.members[uid] = mem(2, name, pli)
        if (vc.runtime.visit && vc.runtime.visit.nextAt) vc.runtime.visit.nextAt = {}
        const n = sent().length
        fs.event(chat, botA.uid, { kind: 'join', user_id: uid, name })
        await waitFor(() => sent().slice(n).some((x) => x.text.indexOf('입장 안내') >= 0), 8000, '#40 join notice ' + uid)
        await sleep(50)
        return sent().slice(n)
      }
      const j1 = await join('4015', '별빛', '40151')
      const photo = j1[0] && j1[0].extra ? JSON.parse(j1[0].extra) : null
      if (CARD40.available()) {
        if (j1.length !== 2 || j1[0].text !== '(사진)' || !photo || photo.w !== 720 || !(photo.h > 400)) throw new Error('#40 join card photo ' + JSON.stringify(j1))
        if (j1[1].text !== '[입장 안내] @별빛' || j1[1].extra !== '{"mentions":[{"user_id":4015,"at":[1],"len":2}]}') throw new Error('#40 mention line right after the card ' + JSON.stringify(j1[1]))
        const buf = fs.photos[fs.photos.length - 1].buf
        if (buf.readUInt32BE(16) !== 720) throw new Error('#40 photo bytes')
      } else if (j1.length !== 1 || j1[0].text.indexOf('[입장 안내]\n이름 : @별빛\n') !== 0) throw new Error('#40 without the renderer the text notice goes out ' + JSON.stringify(j1))
      // 그림 보내기가 실패하면 지금의 글 안내(멘션 포함) 하나만
      room0.photoFail = true
      let j2
      try {
        j2 = await join('4016', '노을')
      } finally {
        room0.photoFail = false
      }
      if (j2.length !== 1 || j2[0].text.indexOf('[입장 안내]\n이름 : @노을\n옾링 : 없음\n입장 기록 : 1회\n') !== 0 || j2[0].extra !== '{"mentions":[{"user_id":4016,"at":[1],"len":2}]}') throw new Error('#40 image failure falls back to the text notice ' + JSON.stringify(j2))
      // 방에 보내는 안내 = 글 → 예전과 같은 글 안내
      await setCfg({ visit: { style: 'text' } })
      const j3 = await join('4017', '새벽')
      if (j3.length !== 1 || j3[0].text.indexOf('[입장 안내]\n이름 : @새벽\n') !== 0) throw new Error('#40 text style ' + JSON.stringify(j3))
      // 그림을 못 만들면(렌더러 없음 = png null) 글 안내
      const n4 = sent().length
      botA.slot.sayImage(vc, null, { text: '[입장 안내]\n이름 : @새벽', mention: { userId: '4017', len: 2, at: 12 }, after: { text: '[입장 안내] @새벽', mention: { userId: '4017', len: 2 } } })
      await waitFor(() => sent().length > n4, 3000, '#40 null png')
      await sleep(100)
      if (sent().length !== n4 + 1 || sent()[n4].text !== '[입장 안내]\n이름 : @새벽') throw new Error('#40 no png → the text notice only ' + JSON.stringify(sent().slice(n4)))
    } finally {
      pc.botWin.max = botMax0
      botA.slot.limits.kickH.list.splice(kMark[0])
      botA.slot.limits.kickD.list.splice(kMark[1])
    }
  }
  botA.slot.joinH.list.splice(joinMark[0])
  botA.slot.joinD.list.splice(joinMark[1])

  // #19 권한 읽기·#20 푸시
  {
    const iP = iAfterIp
    const chat = rowOf(iP).chat_id
    const v = botA.slot.byInstall.get(iP)
    // #17 방 관리봇 방이 waiting_host 면 not_active
    if ((await pool.hide(iP, { last: 3 })).error !== 'not_active' || (await pool.people(iP)).error !== 'not_active') throw new Error('7.7#17 not_active')
    // #20 SYNCMEMT·피드 11 → 3초(시험 120ms) 뒤 권한 읽기 1회
    const before = packets('CHATONROOM', (p) => p.chat === chat).length
    fs.setPerm(chat, botA.uid, 4)
    await waitFor(() => rowOf(iP).state === 'active', 3000, '7.7#20 promotion')
    await sleep(100)
    const reads = packets('CHATONROOM', (p) => p.chat === chat).length - before
    if (reads !== 1) throw new Error('7.7#20 one perm read after the push, got ' + reads)
    await waitFor(() => sentIn(iP).some((t) => t === RF.PROMOTED_NOTICE), 70000, 'promotion notice')   // 봇 전체 발송 한도(분당 30) 창까지 기다릴 수 있다
    if (!store.logs.some((l) => l.install_id === iP && l.kind === 'perm' && l.detail.granted === true)) throw new Error('7.7#20 perm log')
    // #19 olu 없음 + MEMBER mt 2 → waiting_host
    fs.room(fs.byChat(chat).code).dropOlu = true
    fs.byChat(chat).members[botA.uid].mt = 2
    v.nextCheckAt = Date.now()
    await waitFor(() => rowOf(iP).state === 'waiting_host', 3000, '7.7#19 MEMBER fallback')
    if (!store.logs.some((l) => l.install_id === iP && l.kind === 'perm' && l.detail.granted === false)) throw new Error('7.7#19 demotion log')
    // 둘 다 없음 → 상태 유지
    fs.byChat(chat).dropMember = true
    fs.byChat(chat).members[botA.uid].mt = 4
    const permAt = rowOf(iP).perm_at
    v.nextCheckAt = Date.now()
    await sleep(300)
    if (rowOf(iP).state !== 'waiting_host' || rowOf(iP).perm_at !== permAt) throw new Error('7.7#19 no answer keeps the state')
    fs.byChat(chat).dropMember = false
    fs.byChat(chat).dropOlu = false
    v.nextCheckAt = Date.now()
    await waitFor(() => rowOf(iP).state === 'active', 3000, '7.7#19 olu.lmt 4 → active')
    // #17 unkick 대상이 bans·kick 기록에 없으면 not_kicked
    if ((await pool.unkick(iP, '999')).error !== 'not_kicked') throw new Error('7.7#17 not_kicked')
    // #24 방 A 강퇴 11번째(1시간 안) → skip
    for (let i = 0; i < 10; i++) {
      const r = await botA.slot.kick(v, String(7000 + i), 'k' + i, 'manual')
      if (!r.ok) throw new Error('7.7#24 kick ' + i + ' ' + JSON.stringify(r))
    }
    const eleventh = await botA.slot.kick(v, '7010', 'k10', 'manual')
    if (eleventh.ok || !eleventh.skipped || !store.logs.some((l) => l.install_id === iP && l.kind === 'skip' && l.detail.what === 'kick')) throw new Error('7.7#24 kick room limit')
    // unkick: K bot 이 내보낸 사람만, KLDELITEM
    const un = await pool.unkick(iP, '7003')
    if (!un.ok || !packets('KLDELITEM').length || fs.byChat(chat).kicked.includes('7003')) throw new Error('7.7#17 unkick')
    // LINKKICKED → error/kicked(배타권 해제)
    fs.event(chat, botA.uid, { kind: 'kicked' })
    await waitFor(() => rowOf(iP).state === 'error', 3000, '7.7#20 LINKKICKED')
    if (rowOf(iP).error_code !== 'kicked') throw new Error('7.7#20 kicked')
    if (!packets('KICKLEAVE').length) throw new Error('7.7#20 KICKLEAVE')
    // LNKDELETED → error/room_deleted
    const iDel = install('delx1', { roombot: false, minigame: true })
    await pool.reconcile(null)
    await waitFor(() => rowOf(iDel).state === 'active', 3000, 'del join')
    fs.event(rowOf(iDel).chat_id, botA.uid, { kind: 'deleted' })
    await waitFor(() => rowOf(iDel).error_code === 'room_deleted', 3000, '7.7#20 LNKDELETED')
    // INFOLINK 에 링크가 없으면(푸시를 놓친 경우) 두 번 연속일 때 room_deleted(5.4)
    const iDel2 = install('delx2', { roombot: false, minigame: true })
    await pool.reconcile(null)
    await waitFor(() => rowOf(iDel2).state === 'active', 3000, 'del2 join')
    fs.room('delx2').deleted = true
    const v2 = botA.slot.byInstall.get(iDel2)
    v2.checkFull = true
    v2.nextCheckAt = Date.now()
    await waitFor(() => v2.linkMiss === 1, 3000, 'first INFOLINK miss')
    if (rowOf(iDel2).state !== 'active') throw new Error('5.4 one INFOLINK miss does not leave the room')
    v2.nextCheckAt = Date.now()
    await waitFor(() => rowOf(iDel2).error_code === 'room_deleted', 3000, '5.4 INFOLINK twice → room_deleted')
  }

  // #25 이미 들어간 방에 방 관리봇 추가(4.2 "installed → 상품 플래그만 켬, 상태는 sender 가 다시 계산"):
  //     미니게임만 쓰던 방(봇 perm 2, active) → 곧 waiting_host(강등 기록 없음) + 지정할 계정 닉네임 안내 1회 → 부방장 지정 → active.
  //     옮기기(D17): 새 봇이 자기 닉네임으로 입장 안내를 하고, 다시 부방장으로 지정되면 확인 안내를 한다.
  {
    const botC = await addBot(3)
    const botD = await addBot(4)
    const iUp = install('upsellx1', { bot_device_id: botC.id, roombot: false, minigame: true, config: {} })
    await pool.reconcile(null)
    await waitFor(() => rowOf(iUp).state === 'active', 5000, '#25 minigame-only join')
    const chat = rowOf(iUp).chat_id
    if (Number(rowOf(iUp).perm) & 5) throw new Error('#25 bot joined without host rights')
    const vC = botC.slot.byInstall.get(iUp)
    if (!(vC.nextCheckAt > Date.now() + 60000)) throw new Error('#25 an active room otherwise waits for the long check')
    store.installs.get(iUp).roombot = true          // 부모 applyOrder·setProducts: 상품 플래그만 켬
    await pool.reconcile(iUp)                         // 부모 nudge → /v1/bot/sync
    await waitFor(() => rowOf(iUp).state === 'waiting_host', 3000, '#25 roombot added → waiting_host right away')
    if (store.logs.some((l) => l.install_id === iUp && l.kind === 'perm')) throw new Error('#25 adding roombot is not a demotion')
    await waitFor(() => sentIn(iUp).some((t) => t.indexOf('방 관리봇이 추가되었어요') >= 0), 3000, '#25 roombot added notice')
    const addN = sentIn(iUp).filter((t) => t.indexOf('방 관리봇이 추가되었어요') >= 0)
    if (addN.length !== 1 || addN[0].indexOf('「' + botC.slot.roomName() + '」') < 0 || botC.slot.roomName() === botC.slot.nickname) throw new Error('#25 added notice names the bot by its open profile ' + JSON.stringify(addN))
    fs.setPerm(chat, botC.uid, 4)
    await waitFor(() => rowOf(iUp).state === 'active', 3000, '#25 promotion after add')
    await waitFor(() => sentIn(iUp).filter((t) => t === RF.PROMOTED_NOTICE).length === 1, 3000, '#25 promoted notice')
    // 다른 정기 점검이 와도 안내를 되풀이하지 않는다
    vC.nextCheckAt = Date.now()
    await sleep(300)
    if (sentIn(iUp).filter((t) => t.indexOf('방 관리봇이') >= 0 || t === RF.PROMOTED_NOTICE).length !== 2) throw new Error('#25 notices are once ' + JSON.stringify(sentIn(iUp)))
    // 상품 해제(관리자 room-products): waiting_host 방에서 방 관리봇을 빼면 곧 active
    fs.setPerm(chat, botC.uid, 2)
    await waitFor(() => rowOf(iUp).state === 'waiting_host', 3000, '#25 demotion')
    store.installs.get(iUp).roombot = false
    await pool.reconcile(iUp)
    await waitFor(() => rowOf(iUp).state === 'active', 3000, '#25 roombot removed → active right away')
    store.installs.get(iUp).roombot = true
    fs.setPerm(chat, botC.uid, 4)
    await pool.reconcile(iUp)
    await waitFor(() => rowOf(iUp).state === 'active' && Number(rowOf(iUp).perm) === 4, 3000, '#25 roombot back with host rights')
    // 옮기기: 부모가 한 UPDATE 로 "다시 입장" 묶음 + 옛 봇 나가기 행
    const before = sentIn(iUp).length
    Object.assign(store.installs.get(iUp), { bot_device_id: botD.id, state: 'queued', error_code: null, error_detail: null, next_try_at: null, perm: null, perm_at: null })
    store.leaves.push({ id: 25, install_id: iUp, bot_device_id: botC.id, chat_id: chat, link_id: rowOf(iUp).link_id, why: 'move', created_at: Date.now(), done_at: null, result: null })
    await pool.reconcile(null)
    await waitFor(() => rowOf(iUp).state === 'waiting_host' && rowOf(iUp).bot_device_id === botD.id, 5000, '#25 moved bot joins')
    await waitFor(() => sentIn(iUp).slice(before).some((t) => t.indexOf('방 관리봇이 입장했어요') >= 0), 3000, '#25 new bot join notice')
    const joinN = sentIn(iUp).slice(before).filter((t) => t.indexOf('방 관리봇이 입장했어요') >= 0)
    if (joinN.length !== 1 || joinN[0].indexOf('「' + botD.slot.roomName() + '」') < 0 || botD.slot.roomName() === botC.slot.roomName()) throw new Error('#25 new bot names itself ' + JSON.stringify(joinN))
    fs.setPerm(chat, botD.uid, 4)
    await waitFor(() => rowOf(iUp).state === 'active', 3000, '#25 new bot promoted')
    await waitFor(() => sentIn(iUp).slice(before).filter((t) => t === RF.PROMOTED_NOTICE).length === 1, 3000, '#25 new bot promoted notice')
    await waitFor(() => store.leaves.find((l) => l.id === 25).done_at, 3000, '#25 old bot leaves')
    // 뒤 사례(#23 예산)가 봇 A·B 만 있다고 보므로 이 사례의 봇은 내린다
    store.installs.get(iUp).phase = 'removed'
    await pool.detach(botC.id)
    await pool.detach(botD.id)
  }

  // #26 v6 첫 배포의 room_state(봇 구분 없는 welcomedChat·hostNoticed)로 다시 시작해도
  //     사용 중인 방에 안내를 되풀이하지 않는다. 옮기던 중이던 행은 새 봇이 안내한다.
  //     sender 가 꺼진 사이 방 관리봇이 붙은 방(뷰를 새로 만듦)도 10분 점검을 기다리지 않는다.
  {
    const botE = await addBot(5)
    const botF = await addBot(6)
    const iL = install('legacyx1', { bot_device_id: botE.id, roombot: true, minigame: false, config: {} })
    await pool.reconcile(null)
    await waitFor(() => rowOf(iL).state === 'waiting_host', 5000, '#26 join')
    const chat = rowOf(iL).chat_id
    fs.setPerm(chat, botE.uid, 4)
    await waitFor(() => rowOf(iL).state === 'active', 3000, '#26 promoted')
    await waitFor(() => sentIn(iL).filter((t) => t === RF.PROMOTED_NOTICE).length === 1, 3000, '#26 promoted notice')
    // 배포 전 기록 모양으로 되돌리고 뷰를 처음부터 다시 만든다(sender 다시 시작)
    await botE.slot.dropView(iL)
    store.states.set(iL, { welcomedChat: chat, hostNoticed: true })
    const n0 = sentIn(iL).length
    await pool.reconcile(iL)
    const vE = botE.slot.byInstall.get(iL)
    if (!vE || vE.runtime.welcomedChat !== undefined || vE.runtime.hostNoticed !== undefined) throw new Error('#26 legacy keys dropped ' + JSON.stringify(vE && vE.runtime))
    if (!(vE.runtime.welcomed && vE.runtime.welcomed.by === botE.id && vE.runtime.welcomed.chat === chat && vE.runtime.welcomed.roombot === true)) throw new Error('#26 welcomed adopted ' + JSON.stringify(vE.runtime))
    if (!(vE.runtime.promoted && vE.runtime.promoted.by === botE.id)) throw new Error('#26 promoted adopted ' + JSON.stringify(vE.runtime))
    vE.nextCheckAt = Date.now()                       // 정기 점검이 와도
    await sleep(400)
    if (sentIn(iL).length !== n0) throw new Error('#26 no repeated notices after restart ' + JSON.stringify(sentIn(iL).slice(n0)))
    await botE.slot.flush()
    if (store.states.get(iL).hostNoticed !== undefined || !store.states.get(iL).promoted) throw new Error('#26 converted runtime saved')
    // 옮기던 중(queued)인 행에 옛 기록만 있으면 새 봇은 누가 안내했는지 모르니 다시 안내한다
    await botE.slot.dropView(iL)
    store.states.set(iL, { welcomedChat: chat, hostNoticed: true })
    Object.assign(store.installs.get(iL), { bot_device_id: botF.id, state: 'queued', error_code: null, error_detail: null, next_try_at: null, perm: null, perm_at: null })
    store.leaves.push({ id: 26, install_id: iL, bot_device_id: botE.id, chat_id: chat, link_id: rowOf(iL).link_id, why: 'move', created_at: Date.now(), done_at: null, result: null })
    await pool.reconcile(null)
    await waitFor(() => rowOf(iL).state === 'waiting_host' && rowOf(iL).bot_device_id === botF.id, 5000, '#26 moved bot joins')
    await waitFor(() => sentIn(iL).slice(n0).some((t) => t.indexOf('「' + botF.slot.roomName() + '」') >= 0), 3000, '#26 moved bot names itself')
    fs.setPerm(chat, botF.uid, 4)
    await waitFor(() => sentIn(iL).slice(n0).filter((t) => t === RF.PROMOTED_NOTICE).length === 1, 3000, '#26 moved bot promoted notice')
    // sender 가 꺼진 사이 미니게임만 쓰던 방에 방 관리봇이 붙음 → 다시 시작하자마자 부방장 대기(강등 기록 없음)
    const iM = install('legacyx2', { bot_device_id: botE.id, roombot: false, minigame: true, config: {} })
    await pool.reconcile(null)
    await waitFor(() => rowOf(iM).state === 'active', 5000, '#26 minigame-only join')
    await botE.slot.dropView(iM)
    store.installs.get(iM).roombot = true
    await pool.reconcile(iM)
    await waitFor(() => rowOf(iM).state === 'waiting_host', 3000, '#26 stale active roombot room rechecked right after restart')
    if (store.logs.some((l) => l.install_id === iM && l.kind === 'perm')) throw new Error('#26 restart recheck is not a demotion')
    await waitFor(() => sentIn(iM).some((t) => t.indexOf('방 관리봇이 추가되었어요') >= 0), 3000, '#26 added notice after restart')
    store.installs.get(iL).phase = 'removed'
    store.installs.get(iM).phase = 'removed'
    await pool.detach(botE.id)
    await pool.detach(botF.id)
  }

  // #27 오픈프로필(D12): 봇은 고객 방에 카카오톡 기본 프로필이 아니라 그 계정의 오픈프로필(ptp 16, pli)로 들어간다.
  {
    const BP = await import('./botpool.mjs')
    const meName = (uid, code) => fs.room(code).members[uid] && fs.room(code).members[uid].nick
    const sentOf = (id) => (rowOf(id).chat_id ? sentIn(id) : [])
    // SYNCLINK 걸러내기: 오픈프로필(lt 1 + op 또는 /me/)만, 이 계정이 만든 방(lt 2)·1:1 오픈채팅(/o/)·남의 것은 뺀다
    const ols = [
      { li: '11', lt: 1, lu: 'https://open.kakao.com/me/aa', ln: '링크 이름', olu: { userId: '5', nn: '오픈 이름' } },
      { li: '12', lt: 1, lu: 'https://open.kakao.com/o/sAbc', ln: '1:1 문의' },
      { li: '13', lt: 2, lu: 'https://open.kakao.com/o/gAbc', ln: '내 방', op: undefined },
      { li: '14', lt: 1, lu: '', ln: '표지 있음', op: { desc: '' } },
      { li: '15', lt: 1, lu: 'https://open.kakao.com/me/bb', ln: '남의 것', olu: { userId: '6' } },
    ]
    const own = BP.ownOpenProfiles(ols, '5')
    if (own.map((p) => p.li).join(',') !== '11,14' || own[0].name !== '오픈 이름' || own[1].name !== '표지 있음') throw new Error('#27 SYNCLINK filter ' + JSON.stringify(own))
    if (BP.traceText({ li: Long.fromString('123'), pc: '0000', tk: 't' }) !== '{"li":"123","pc":"<hidden>","tk":"<hidden>"}') throw new Error('#27 trace hides passcode, Long as text')
    if (RF.profileChangedNotice('K bot 1') !== '[K bot]\nK bot 프로필이 「K bot 1」로 바뀌었어요.\n방장님이 「K bot 1」을 부방장으로 지정하면 방 관리 기능이 시작돼요.') throw new Error('#27 changed notice')
    if (RF.profileChangedNotice('') !== '[K bot]\nK bot 프로필이 바뀌었어요.\n방장님이 K bot을 부방장으로 지정하면 방 관리 기능이 시작돼요.') throw new Error('#27 changed notice without a name')
    if (RF.roJosa('케이봇') !== '으로' || RF.roJosa('봇2') !== '로' || RF.roJosa('K봇 하늘') !== '로' || RF.roJosa('K bot 2B') !== '로' ||
      RF.roJosa('K bot M') !== '으로' || RF.roJosa('K bot') !== '으로' || RF.roJosa('K bot 3') !== '으로') throw new Error('#27 로/으로')
    // 방 메시지 조사(문장 점검 220·225): 받침에 맞춘다
    if (RF.josa('바람', '은') !== '은' || RF.josa('사과', '은') !== '는' || RF.josa('K bot 2', '을') !== '를' || RF.josa('K bot 1', '을') !== '을' ||
      RF.josa('123', '이었어요') !== '이었어요' || RF.josa('789', '이었어요') !== '였어요' || RF.josa('서울', '이에요') !== '이에요' ||
      RF.josa('라 / 나', '으로') !== '로' || RF.josa('림 / 임', '으로') !== '으로' || RF.josa('', '을') !== '을(를)') throw new Error('#27 조사')
    const jv = (products, games) => ({ cfg: { cmdPrefix: '!', games: { enabled: games } }, products })
    if (RF.joinNotice(jv({ roombot: true, minigame: true }, true), '하늘') !== '[K bot]\n방 관리봇이 입장했어요.\n방장님이 「하늘」을 부방장으로 지정하면 방 관리 기능이 시작돼요.\n「!도움」을 입력하면 미니게임 명령어를 볼 수 있어요.') throw new Error('#27 join notice text')
    if (RF.joinNotice(jv({ roombot: false, minigame: true }, false), '') !== '[K bot]\n미니게임봇이 입장했어요.\n관리자가 미니게임을 켜면 바로 쓸 수 있어요.') throw new Error('#27 minigame-off join notice')
    if (RF.roombotAddedNotice(jv({ roombot: true }, false), '') !== '[K bot]\n방 관리봇이 추가되었어요.\n방장님이 K bot을 부방장으로 지정하면 방 관리 기능이 시작돼요.') throw new Error('#27 added notice without a name')

    // 1. 오픈프로필 1개: JOINLINK 는 ptp 16 + 그 pli 하나뿐, 방에 보이는 이름 = 오픈프로필 이름, 입장 안내도 그 이름
    const G = { uid: FK.fakeUserId('bot.0000000000000071') }
    fs.user(G.uid).bot = true
    fs.setProfiles(G.uid, [{ name: 'K봇 하나' }])
    Object.assign(G, await addBot(71))
    const gli = fs.profilesOf(G.uid)[0].li
    if (G.slot.profileState !== 'ok' || !G.slot.openProfile || G.slot.openProfile.li !== gli || G.slot.roomName() !== 'K봇 하나') throw new Error('#27 discovery ' + JSON.stringify(G.slot.profileView()))
    const gRow = store.bots.get(G.id)
    if (gRow.open_profile_li !== gli || gRow.open_profile_name !== 'K봇 하나' || gRow.open_profiles.length !== 1 || !gRow.open_profile_at) throw new Error('#27 bot_accounts open profile columns ' + JSON.stringify(gRow))
    const i1 = install('opone1', { bot_device_id: G.id, roombot: true, minigame: true, config: {} })
    await pool.reconcile(null)
    await waitFor(() => rowOf(i1).state === 'waiting_host', 5000, '#27.1 join')
    // 입장하자마자 runtime.prof 를 저장한다(5초 일괄 저장을 기다리지 않는다): 부모는 prof 가 없는 입장 완료 방을 v6 방으로 본다
    await waitFor(() => !!(store.states.get(i1) && store.states.get(i1).prof && store.states.get(i1).prof.by === G.id), 500, '#27.1 prof saved right after the join')
    const j1 = packets('JOINLINK', (p) => p.user === G.uid)
    if (j1.length !== 1 || j1[0].ptp !== 16 || j1[0].pli !== gli) throw new Error('#27.1 JOINLINK ptp 16 + pli ' + JSON.stringify(j1))
    const m1 = fs.room('opone1').members[G.uid]
    if (m1.nick !== 'K봇 하나' || m1.ptp !== 16 || m1.pli !== gli) throw new Error('#27.1 room member is the open profile ' + JSON.stringify(m1))
    await waitFor(() => sentOf(i1).some((t) => t.indexOf('방 관리봇이 입장했어요') >= 0), 3000, '#27.1 join notice')
    if (!sentOf(i1).some((t) => t.indexOf('「K봇 하나」') >= 0) || sentOf(i1).some((t) => t.indexOf(G.slot.nickname) >= 0)) throw new Error('#27.1 notice names the open profile ' + JSON.stringify(sentOf(i1)))
    const v1 = G.slot.byInstall.get(i1)
    if (G.slot.roomProfile(v1) !== 'open' || v1.runtime.prof.nn !== 'K봇 하나' || v1.runtime.prof.by !== G.id) throw new Error('#27.1 room profile record ' + JSON.stringify(v1.runtime.prof))
    await G.slot.flush()
    if (!store.states.get(i1).prof || store.states.get(i1).prof.nn !== 'K봇 하나') throw new Error('#27.1 room_state keeps the name the room shows')
    const st1 = pool.botStatus()
    const gs = st1.bots.find((b) => b.device_id === G.id)
    if (!gs || gs.open_profile_state !== 'ok' || gs.open_profile.name !== 'K봇 하나' || gs.profile_rooms.open !== 1) throw new Error('#27.10 status ' + JSON.stringify(gs))
    if (st1.rooms.find((r) => r.install_id === i1).profile !== 'open') throw new Error('#27.10 status room profile')
    if ((await pool.room(i1)).live.profile.state !== 'open' || (await pool.room(i1)).live.profile.name !== 'K봇 하나') throw new Error('#27.10 /v1/bot/room profile')
    // SENDER_TRACE_PUSH: 응답 모양 기록(참여코드·토큰은 가림)
    {
      const lines = []
      const w = process.stderr.write.bind(process.stderr)
      process.stderr.write = (chunk, ...rest) => { lines.push(String(chunk)); return true }
      try {
        G.slot.opts = Object.assign({}, G.slot.opts, { trace: true })
        await G.slot.readOpenProfiles('trace', true)
        await G.slot.raw('CHATONROOM', { chatId: Long.fromString(rowOf(i1).chat_id) })
      } finally {
        process.stderr.write = w
        G.slot.opts = pool.opts
      }
      const sync = lines.find((l) => l.indexOf('raw SYNCLINK') >= 0) || ''
      if (sync.indexOf('"lt":1') < 0 || sync.indexOf('/me/') < 0 || sync.indexOf(gli) < 0) throw new Error('#27 trace SYNCLINK ' + sync)
      if (!lines.some((l) => l.indexOf('raw CHATONROOM') >= 0 && l.indexOf('"ptp":16') >= 0)) throw new Error('#27 trace CHATONROOM olu')
    }

    // 2. 오픈프로필 없음: bot_no_open_profile(none), JOININFO·JOINLINK 를 보내지 않는다
    const H = { uid: FK.fakeUserId('bot.0000000000000072') }
    fs.user(H.uid).bot = true
    fs.setProfiles(H.uid, [])
    Object.assign(H, await addBot(72))
    if (H.slot.profileState !== 'none' || store.bots.get(H.id).open_profile_li !== null) throw new Error('#27.2 none ' + H.slot.profileState)
    const i2 = install('opnone1', { bot_device_id: H.id, roombot: true, minigame: false, config: {} })
    await pool.reconcile(null)
    await waitFor(() => rowOf(i2).state === 'error', 3000, '#27.2 no open profile')
    if (rowOf(i2).error_code !== 'bot_no_open_profile' || rowOf(i2).error_detail !== 'none') throw new Error('#27.2 error ' + JSON.stringify([rowOf(i2).error_code, rowOf(i2).error_detail]))
    if (packets('JOININFO', (p) => p.user === H.uid).length || packets('JOINLINK', (p) => p.user === H.uid).length) throw new Error('#27.2 nothing sent to Kakao')

    // 3. 오픈프로필을 만들면(SYNCLINKCR 푸시) 다시 읽고, 멈춘 방은 스스로 다시 입장 줄에 들어가 ptp 16 으로 들어간다
    fs.setProfiles(H.uid, [{ name: 'K봇 둘' }])
    await waitFor(() => rowOf(i2).state === 'waiting_host', 5000, '#27.3 requeued after the profile appeared')
    const hli = fs.profilesOf(H.uid)[0].li
    const j3 = packets('JOINLINK', (p) => p.user === H.uid)
    if (j3.length !== 1 || j3[0].ptp !== 16 || j3[0].pli !== hli || meName(H.uid, 'opnone1') !== 'K봇 둘') throw new Error('#27.3 join with the new profile ' + JSON.stringify(j3))
    if (store.bots.get(H.id).open_profile_name !== 'K봇 둘') throw new Error('#27.3 bot_accounts name')

    // 4. 오픈프로필 2개: 고른 것이 없으면 첫 번째, 관리자가 고르면 그것, 고른 것이 사라지면 gone(입장 멈춤)
    const I = { uid: FK.fakeUserId('bot.0000000000000073') }
    fs.user(I.uid).bot = true
    fs.setProfiles(I.uid, [{ name: 'K봇 셋 A' }, { name: 'K봇 셋 B' }])
    Object.assign(I, await addBot(73))
    const [pa, pb] = fs.profilesOf(I.uid)
    if (I.slot.openProfile.li !== pa.li || I.slot.openProfiles.length !== 2) throw new Error('#27.4 default first')
    const i4a = install('optwoa', { bot_device_id: I.id, roombot: false, minigame: true })
    await pool.reconcile(null)
    await waitFor(() => rowOf(i4a).state === 'active', 5000, '#27.4 join A')
    if (meName(I.uid, 'optwoa') !== 'K봇 셋 A') throw new Error('#27.4 joined with the first profile')
    store.bots.get(I.id).open_profile_pick = pb.li                         // 부모 /admin/bot-open-profile
    const cmd = await pool.openProfileCmd(I.id, {})
    if (!cmd.ok || cmd.open_profile.li !== pb.li || cmd.open_profile_state !== 'ok') throw new Error('#27.4 pick ' + JSON.stringify(cmd))
    if (G.slot.roomProfile(v1) !== 'open' || I.slot.roomProfile(I.slot.byInstall.get(i4a)) !== 'other') throw new Error('#27.4 old room shows another open profile')
    const i4b = install('optwob', { bot_device_id: I.id, roombot: false, minigame: true })
    await pool.reconcile(null)
    await waitFor(() => rowOf(i4b).state === 'active', 5000, '#27.4 join B')
    const jb = packets('JOINLINK', (p) => p.user === I.uid && p.li === fs.room('optwob').li)
    if (jb.length !== 1 || jb[0].pli !== pb.li || meName(I.uid, 'optwob') !== 'K봇 셋 B') throw new Error('#27.4 picked profile ' + JSON.stringify(jb))
    store.bots.get(I.id).open_profile_pick = '99999'
    await pool.reconcile(null)
    if (I.slot.profileState !== 'gone' || store.bots.get(I.id).open_profile_li !== null) throw new Error('#27.4 gone ' + I.slot.profileState)
    const i4c = install('optwoc', { bot_device_id: I.id, roombot: false, minigame: true })
    await pool.reconcile(null)
    await waitFor(() => rowOf(i4c).state === 'error', 3000, '#27.4 gone stops joins')
    if (rowOf(i4c).error_code !== 'bot_no_open_profile' || rowOf(i4c).error_detail !== 'gone') throw new Error('#27.4 gone detail')
    store.bots.get(I.id).open_profile_pick = null
    await pool.reconcile(null)
    await waitFor(() => rowOf(i4c).state === 'active', 5000, '#27.4 cleared pick → joins again')
    if (meName(I.uid, 'optwoc') !== 'K봇 셋 B') throw new Error('#27.4 keeps the last used profile when the pick is cleared')

    // 5. 기본 프로필(ptp 1)로 들어가 있는 방 → 관리자 [오픈프로필로 바꾸기] = UPLINKPROF 1번. 권한·상태 유지, 나가기·입장 없음
    const rm = fs.room('opmainx1')
    rm.members[G.uid] = { mt: 4, nick: G.slot.nickname, photo: '', status: null }      // 옛 입장(ptp 없음 = 기본 프로필)
    const i5 = install('opmainx1', { bot_device_id: G.id, roombot: true, minigame: false, link_id: rm.li, config: {} })
    await pool.reconcile(null)
    await waitFor(() => rowOf(i5).state === 'active', 5000, '#27.5 already in the room with the main profile')
    const v5 = G.slot.byInstall.get(i5)
    if (G.slot.roomProfile(v5) !== 'main' || G.slot.nameIn(v5) !== G.slot.nickname) throw new Error('#27.5 main profile detected ' + JSON.stringify(v5.runtime.prof))
    await sleep(200)
    if (packets('UPLINKPROF', (p) => p.li === rm.li).length) throw new Error('#27.5 BOT_PROFILE_CONVERT=off does not switch by itself')
    const mark5 = fs.packets.length
    const q5 = await pool.roomProfileCmd(i5, 'switch')
    if (!q5.ok || q5.queued !== 'switch') throw new Error('#27.5 queue ' + JSON.stringify(q5))
    await waitFor(() => G.slot.roomProfile(v5) === 'open', 3000, '#27.5 switched')
    const after5 = fs.packets.slice(mark5).filter((p) => p.user === G.uid)
    if (after5.filter((p) => p.method === 'UPLINKPROF').length !== 1 || after5.some((p) => p.method === 'LEAVE' || p.method === 'JOINLINK' || p.method === 'JOININFO')) throw new Error('#27.5 one UPLINKPROF, no leave/join ' + after5.map((p) => p.method).join(','))
    if (after5.find((p) => p.method === 'UPLINKPROF').ptp !== 16 || after5.find((p) => p.method === 'UPLINKPROF').pli !== gli) throw new Error('#27.5 UPLINKPROF body')
    if (rowOf(i5).state !== 'active' || Number(rowOf(i5).perm) !== 4 || rm.members[G.uid].nick !== 'K봇 하나' || rm.members[G.uid].mt !== 4) throw new Error('#27.5 perm and state kept')
    if ((await pool.roomProfileCmd(i5, 'switch')).error !== 'already_open') throw new Error('#27.5 already open')
    // 자동(BOT_PROFILE_CONVERT=auto): 부방장 대기 방은 점검 때 바꾸고 새 이름을 방에 알린다
    const rw = fs.room('opmainx2')
    rw.members[G.uid] = { mt: 2, nick: G.slot.nickname, ptp: 1, photo: '', status: null }
    const i5b = install('opmainx2', { bot_device_id: G.id, roombot: true, minigame: false, link_id: rw.li, config: {} })
    await pool.reconcile(null)
    await waitFor(() => rowOf(i5b).state === 'waiting_host', 5000, '#27.5 waiting room on the main profile')
    pool.opts.profileConvert = 'auto'
    const v5b = G.slot.byInstall.get(i5b)
    v5b.nextCheckAt = Date.now()
    await waitFor(() => G.slot.roomProfile(v5b) === 'open', 3000, '#27.5 auto switch')
    await waitFor(() => sentOf(i5b).some((t) => t === RF.profileChangedNotice('K봇 하나')), 3000, '#27.5 changed notice in a waiting room')
    if (rowOf(i5b).state !== 'waiting_host' || rw.members[G.uid].nick !== 'K봇 하나') throw new Error('#27.5 auto switch keeps the state')

    // 6. UPLINKPROF 거절(noopen): 방은 그대로, 실패 기록, 24시간 안에는 다시 보내지 않음, 나가지 않음
    const rn = fs.room('opnoopenx1')
    rn.members[G.uid] = { mt: 4, nick: G.slot.nickname, ptp: 1, photo: '', status: null }
    const i6 = install('opnoopenx1', { bot_device_id: G.id, roombot: true, minigame: false, link_id: rn.li, config: {} })
    await pool.reconcile(null)
    await waitFor(() => rowOf(i6).state === 'active', 5000, '#27.6 join')
    const v6 = G.slot.byInstall.get(i6)
    await waitFor(() => G.slot.roomProfile(v6) === 'failed', 3000, '#27.6 refused switch is recorded')
    if (v6.runtime.prof.fail !== -804 || !v6.runtime.prof.failAt || rowOf(i6).state !== 'active') throw new Error('#27.6 failure ' + JSON.stringify(v6.runtime.prof))
    v6.nextCheckAt = Date.now()
    await sleep(300)
    if (packets('UPLINKPROF', (p) => p.li === rn.li).length !== 1) throw new Error('#27.6 no retry within 24 hours')
    if (packets('LEAVE', (p) => p.chat === rn.chatId).length || packets('JOINLINK', (p) => p.li === rn.li).length) throw new Error('#27.6 never leaves or rejoins for a switch')
    if ((await pool.room(i6)).live.profile.state !== 'failed') throw new Error('#27.6 room view shows the failure')
    pool.opts.profileConvert = 'off'
    // 관리자 [다시 입장]: 나갔다가 오픈프로필로 다시 들어간다(부방장은 다시 지정, 새 이름으로 다시 안내)
    const rr = fs.room('oprejoinx1')
    rr.members[G.uid] = { mt: 4, nick: G.slot.nickname, ptp: 1, photo: '', status: null }
    const i6r = install('oprejoinx1', { bot_device_id: G.id, roombot: true, minigame: false, link_id: rr.li, config: {} })
    await pool.reconcile(null)
    await waitFor(() => rowOf(i6r).state === 'active', 5000, '#27.6 rejoin room join')
    const markR = fs.packets.length
    const qr = await pool.roomProfileCmd(i6r, 'rejoin')
    if (!qr.ok || qr.queued !== 'rejoin') throw new Error('#27.6 rejoin queue ' + JSON.stringify(qr))
    await waitFor(() => rowOf(i6r).state === 'waiting_host' && rr.members[G.uid] && rr.members[G.uid].ptp === 16, 5000, '#27.6 rejoined with the open profile')
    const seqR = fs.packets.slice(markR).filter((p) => p.user === G.uid && ['LEAVE', 'JOININFO', 'JOINLINK'].includes(p.method)).map((p) => p.method + (p.ptp ? ':' + p.ptp : ''))
    if (seqR.join(',') !== 'LEAVE,JOININFO,JOINLINK:16') throw new Error('#27.6 rejoin = leave then join with ptp 16 ' + seqR.join(','))
    await waitFor(() => sentOf(i6r).some((t) => t.indexOf('「K봇 하나」') >= 0 && t.indexOf('방 관리봇이 입장했어요') >= 0), 3000, '#27.6 rejoin notice')

    // 8. SYNCLINK 실패 + 남긴 값 없음: 행은 오류가 아니라 queued 로 남는다. 다시 읽기에 성공하면 들어간다
    const J = { uid: FK.fakeUserId('bot.0000000000000074') }
    fs.user(J.uid).bot = true
    fs.setProfiles(J.uid, [{ name: 'K봇 넷' }], true)
    Object.assign(J, await addBot(74))
    if (J.slot.profileState !== 'unknown') throw new Error('#27.8 unknown after a failed read')
    const i8 = install('opfailx1', { bot_device_id: J.id, roombot: false, minigame: true })
    await pool.reconcile(null)
    await sleep(300)
    if (rowOf(i8).state !== 'queued' || packets('JOININFO', (p) => p.user === J.uid).length) throw new Error('#27.8 stays queued ' + rowOf(i8).state)
    fs.setProfiles(J.uid, null, false)
    const rj = await pool.openProfileCmd(J.id, { refresh: true })
    if (!rj.ok || rj.open_profile_state !== 'ok' || rj.read_ok !== true) throw new Error('#27.8 admin refresh ' + JSON.stringify(rj))
    await waitFor(() => rowOf(i8).state === 'active', 5000, '#27.8 joins after the profile is read')
    // 남긴 값이 있으면 읽기 실패가 "없음"이 되지 않는다
    fs.setProfiles(J.uid, null, true)
    await J.slot.readOpenProfiles('test', true)
    if (J.slot.profileState !== 'ok' || store.bots.get(J.id).open_profile_li !== fs.profilesOf(J.uid)[0].li) throw new Error('#27.8 failed read keeps the cached profile')
    // 관리자 다시 읽기: 이번 SYNCLINK 가 실패하면 read_ok false 와 카카오 상태를 돌려준다(남긴 판정은 그대로)
    const rf = await pool.openProfileCmd(J.id, { refresh: true })
    if (!rf.ok || rf.read_ok !== false || rf.read_status !== -500 || rf.open_profile_state !== 'ok') throw new Error('#27.8 failed admin refresh reports read_ok false ' + JSON.stringify(rf))
    if ((await pool.openProfileCmd(J.id, {})).read_ok !== null) throw new Error('#27.8 no read without refresh')
    fs.setProfiles(J.uid, null, false)
    // 링크로 직접 확인(SYNCLINK 가 오픈프로필을 보여 주지 않을 때의 대안): 이 계정 것만 받는다
    if ((await pool.openProfileCmd(J.id, { url: fs.profilesOf(G.uid)[0].url })).error !== 'not_mine') throw new Error('#27 url of another account is refused')
    const byUrl = await pool.openProfileCmd(J.id, { url: fs.profilesOf(J.uid)[0].url })
    if (!byUrl.ok || byUrl.open_profiles.length !== 1) throw new Error('#27 url adds the same profile once ' + JSON.stringify(byUrl))

    for (const id of [i1, i2, i4a, i4b, i4c, i5, i5b, i6, i6r, i8]) store.installs.get(id).phase = 'removed'
    for (const b of [G, H, I, J]) await pool.detach(b.id)
  }

  // #21 나가기 대기열
  {
    const r1 = fs.room('leavex1')
    r1.members[botA.uid] = { mt: 2, nick: 'a' }
    r1.members[botB.uid] = { mt: 2, nick: 'b' }
    const iMoved = install('leavex1', { bot_device_id: 'bot.ffffffffffffffff', state: 'active', link_id: r1.li, chat_id: r1.chatId })
    store.leaves.push({ id: 1, install_id: iMoved, bot_device_id: botA.id, chat_id: r1.chatId, link_id: r1.li, why: 'move', created_at: Date.now(), done_at: null, result: null })
    store.leaves.push({ id: 2, install_id: iMoved, bot_device_id: botB.id, chat_id: null, link_id: r1.li, why: 'move', created_at: Date.now(), done_at: null, result: null })
    // 지금 봇이 같은 link_id 를 맡고 있으면 kept
    const r2 = fs.room('keepx1')
    r2.members[botA.uid] = { mt: 2, nick: 'a' }
    install('keepx1', { state: 'active', link_id: r2.li, chat_id: r2.chatId, roombot: false, minigame: true })
    store.leaves.push({ id: 3, install_id: 999, bot_device_id: botA.id, chat_id: r2.chatId, link_id: r2.li, why: 'rebind', created_at: Date.now(), done_at: null, result: null })
    // 나가기가 입장보다 먼저
    const iNew = install('orderx1', { roombot: false, minigame: true })
    const mark = fs.packets.length
    await pool.reconcile(null)
    await waitFor(() => store.leaves.every((l) => l.done_at) && rowOf(iNew).state === 'active', 5000, '7.7#21 leaves')
    const L1 = store.leaves.find((l) => l.id === 1)
    const L2 = store.leaves.find((l) => l.id === 2)
    const L3 = store.leaves.find((l) => l.id === 3)
    if (L1.result !== 'left' || L2.result !== 'left' || r1.members[botA.uid] || r1.members[botB.uid]) throw new Error('7.7#21 both old bots left')
    if (L3.result !== 'kept' || !r2.members[botA.uid]) throw new Error('7.7#21 kept')
    const seq = fs.packets.slice(mark).filter((p) => p.user === botA.uid && (p.method === 'LEAVE' || p.method === 'JOININFO')).map((p) => p.method)
    if (seq[0] !== 'LEAVE' || seq.indexOf('JOININFO') < seq.lastIndexOf('LEAVE')) throw new Error('7.7#21 leave before join ' + seq.join(','))
    if (packets('LEAVE', (p) => p.chat === r2.chatId).length) throw new Error('7.7#21 kept room is not left')
  }

  // #27.11 v6 때 기본 프로필로 들어가 있던 방(runtime.prof 없음): 정기 점검(10분)을 기다리지 않고 곧 읽어 prof 를 남긴다
  {
    const rv = fs.room('v6mainx1')
    rv.members[botA.uid] = { mt: 2, nick: '운영자 기본닉' }
    const iV6 = install('v6mainx1', { state: 'active', link_id: rv.li, chat_id: rv.chatId, roombot: false, minigame: true })
    await pool.reconcile(null)
    await waitFor(() => { const v = botA.slot.byInstall.get(iV6); return !!(v && v.runtime.prof && v.runtime.prof.by === botA.id) }, 3000, '#27.11 v6 room profile is read soon')
    const pv6 = botA.slot.byInstall.get(iV6).runtime.prof
    if (pv6.open !== false || pv6.nn !== '운영자 기본닉' || pv6.chat !== rv.chatId) throw new Error('#27.11 v6 room shows the main profile ' + JSON.stringify(pv6))
    if (packets('JOINLINK', (p) => p.li === rv.li).length || sentIn(iV6).length) throw new Error('#27.11 no join or notice for an adopted room')
    store.installs.get(iV6).phase = 'removed'
  }

  // #22 다시 접속 금지: JOINLINK 알 수 없는 status → close·새 로그인 없이 getChats 확인만. 이미 그 li 의 방이면 JOINLINK 없음
  {
    const loginsBefore = fs.logins[botA.uid]
    const client = botA.slot.client
    const iWeird = install('weirdx1', { roombot: false, minigame: true })
    await pool.reconcile(null)
    await waitFor(() => rowOf(iWeird).state === 'error', 5000, '7.7#22 weird')
    if (rowOf(iWeird).error_code !== 'kakao_error' || rowOf(iWeird).error_detail !== '카카오 상태 -9999') throw new Error('7.7#22 unknown status → kakao_error')
    if (fs.logins[botA.uid] !== loginsBefore || botA.slot.client !== client || client.closeCount) throw new Error('7.7#22 no reconnect after a join failure')
    const rIn = fs.room('alreadyx1')
    rIn.members[botA.uid] = { mt: 4, nick: 'a' }
    const iIn = install('alreadyx1', { link_id: rIn.li })
    const jl = packets('JOINLINK').length
    await pool.reconcile(null)
    await waitFor(() => rowOf(iIn).state === 'active', 5000, '7.7#22 already in room')
    if (packets('JOINLINK').length !== jl || packets('JOININFO', (p) => false).length) throw new Error('7.7#22 no JOINLINK when already in the room')
    // 응답 유실(lost): 다시 접속하지 않고 방 목록에서 찾아 성공 처리
    const iLost = install('lostx1', { roombot: false, minigame: true })
    await pool.reconcile(null)
    await waitFor(() => rowOf(iLost).state === 'active', 5000, '7.7#22 lost response')
    if (fs.logins[botA.uid] !== loginsBefore) throw new Error('7.7#22 lost response does not log in again')
    // #27.9 오픈프로필 입장(ptp 16)의 응답이 유실되어도 방 목록으로 찾아 성공 처리하고, 그 방의 프로필은 오픈프로필로 남는다
    const lostJoin = packets('JOINLINK', (p) => p.li === fs.room('lostx1').li)
    if (lostJoin.length !== 1 || lostJoin[0].ptp !== 16 || botA.slot.roomProfile(botA.slot.byInstall.get(iLost)) !== 'open') throw new Error('#27.9 lost ptp 16 join ' + JSON.stringify(lostJoin))
  }

  // #23 예산: 시간 예산 20 을 다 쓰면 21번째 입장은 rate_limited + next_try_at = 예산 복귀 시각. 조회 예산이 없으면 budget
  {
    const s = botB.slot
    const now = Date.now()
    for (let i = 0; i < 20; i++) s.joinH.add(now - 1000 + i)
    const iBudget = install('budgetx1', { bot_device_id: botB.id })
    await pool.reconcile(null)
    await waitFor(() => rowOf(iBudget).error_detail === 'rate_limited', 5000, '7.7#23 budget')
    if (Number(rowOf(iBudget).next_try_at) !== now - 1000 + 3600000) throw new Error('7.7#23 next_try_at = budget return ' + rowOf(iBudget).next_try_at)
    if (packets('JOININFO', (p) => p.user === botB.uid).length) throw new Error('7.7#23 no packet without budget')
    for (const b of [botA.slot, botB.slot]) for (let i = 0; i < 10; i++) b.resolveM.add(Date.now())
    if ((await pool.resolve(url('anyx1'))).error !== 'budget') throw new Error('7.7#23 resolve budget')
    botA.slot.resolveM.list = []
    const ok = await pool.resolve(url('passx9'))
    if (!ok.ok || !ok.needs_passcode || ok.profile_only || ok.name !== '테스트방 passx9' || !/^\d+$/.test(ok.link_id)) throw new Error('7.7#23 resolve ' + JSON.stringify(ok))
    if ((await pool.resolve(url('gonex9'))).error !== 'not_found' || (await pool.resolve(url('dmx9'))).error !== 'not_group') throw new Error('7.7#23 resolve errors')
    // 커뮤니티 타입 방(오픈링크 종류 3)은 그룹방처럼 받는다
    botA.slot.resolveM.list = []
    const cm = await pool.resolve(url('commx9'))
    if (!cm.ok || cm.type !== 3 || !/^\d+$/.test(cm.link_id)) throw new Error('7.7#23 community link resolves ' + JSON.stringify(cm))
  }

  // #24 공정 몫: 방 A 발송 대기 100개 + 방 B 1개 → 방 B 가 방 A 의 6개 안에 나간다
  {
    const pc = new RF.Pacer()
    let t = T
    for (let i = 0; i < 100; i++) if (i < 30) pc.push('A', { text: 'a' + i }, t)
    pc.push('B', { text: 'b' }, t)
    const order = []
    for (let i = 0; i < 7; i++) {
      const n = pc.next(t)
      if (n) order.push(n.key)
      t += 100
    }
    if (order.indexOf('B') < 0 || order.indexOf('B') > 5) throw new Error('7.7#24 B goes out within A\'s first six ' + order.join(''))
    if (order.filter((k) => k === 'A').length > 6) throw new Error('7.7#24 room A limit 6/min')
    const full = new RF.Pacer()
    for (let i = 0; i < 30; i++) full.push('A', { text: 'x' }, T)
    if (full.push('A', { text: 'x' }, T) !== false) throw new Error('7.7#24 a full queue skips')
  }

  // #20 KICKOUT: 사유 -2 → markDead 없음(다시 붙음), 사유 0 → bot_down
  {
    const s = botB.slot
    const iB = install('kickoutx1', { bot_device_id: botB.id, roombot: false, minigame: true })
    s.joinH.list = []
    await pool.reconcile(null)
    await waitFor(() => rowOf(iB).state === 'active', 5000, 'kickout room join')
    const logins = fs.logins[botB.uid]
    fs.event(rowOf(iB).chat_id, botB.uid, { kind: 'kickout', reason: -2 })
    await waitFor(() => fs.logins[botB.uid] > logins && s.live(), 25000, '7.7#20 reconnect after -2')
    if (s.dead || rowOf(iB).state !== 'active') throw new Error('7.7#20 reason -2 is a reconnect')
    fs.event(rowOf(iB).chat_id, botB.uid, { kind: 'kickout', reason: 0 })
    // markDead 는 기록을 지우기 전에 주인인지 묻는다(owner.mjs). 쓰기가 끝날 때까지 기다린다.
    await waitFor(() => s.dead && rowOf(iB).error_code === 'bot_down' && store.bots.get(botB.id).state === 'needs_register', 3000, '7.7#20 reason 0 → bot_down')
  }

  // #20-2 배포 겹침(owner.mjs): 새 서버가 같은 봇에 붙어 카카오가 예전 연결을 내보내도(KICKOUT 0)
  //   예전 서버는 저장된 로그인을 지우지 않고, 다시 붙지 않고, 모든 연결을 닫는다(standDown).
  //   새 서버는 울타리가 없던 예전 서버가 지운 로그인을 되살리고, 막 켜진 뒤 받은 KICKOUT 으로는 지우지 않는다.
  {
    const id = 'bot.' + '7'.repeat(16)
    const uid = FK.fakeUserId(id)
    fs.user(uid).bot = true
    const rec = () => ({ device_id: id, credentials: { access_token: 'fake-ov', user_id: uid, device_uuid: 'fake-du-ov', device_type: 'tablet' }, features: { v: 2, bot: true }, config: {}, rooms: [], runtime: {} })
    const hubWith = (owner) => new Hub({ store, newClient: () => new FK.FakeKakaoClient(fs), opts: pool.opts, owner })
    const oldOwner = new Owner(store)
    if (!(await oldOwner.claim())) throw new Error('owner: first sender claims')
    const oldHub = hubWith(oldOwner)
    await oldHub.attach(id, rec())
    const oldSlot = oldHub.pool.slotOf(id)
    await waitFor(() => oldSlot.live(), 3000, 'owner: old sender connects')
    const iO = install('ownerx1', { bot_device_id: id, roombot: false, minigame: true })
    await oldHub.pool.reconcile(null)
    await waitFor(() => rowOf(iO).state === 'active', 5000, 'owner: room join')

    await sleep(2)
    const newOwner = new Owner(store, { retryMs: 30 })
    if (!(await newOwner.claim())) throw new Error('owner: the newer sender takes over')
    if (await new Owner(store, { now: () => Date.now() - 60000 }).claim()) throw new Error('owner: an older boot cannot take it back while the owner beats')
    const newHub = hubWith(newOwner)
    await newHub.attach(id, rec())
    const newSlot = newHub.pool.slotOf(id)
    await waitFor(() => newSlot.live(), 3000, 'owner: new sender connects')

    oldSlot.client._dispatch({ method: 'KICKOUT', body: { reason: 0 } })
    await waitFor(() => oldHub.inert && oldSlot.stopped && oldOwner.lost, 3000, 'owner: old sender stands down')
    const logins = fs.logins[uid]
    await sleep(60)
    const saved = store.records.get(id)
    if (saved.needs_register || saved.credentials.access_token !== 'fake-ov') throw new Error('owner: old sender cleared the saved login')
    if (store.bots.get(id).state === 'needs_register' || rowOf(iO).error_code === 'bot_down') throw new Error('owner: old sender marked the bot down')
    if (fs.logins[uid] !== logins || oldHub.pool.bots.size) throw new Error('owner: old sender reconnected')
    if (!newSlot.live()) throw new Error('owner: new sender must stay connected')
    await oldHub.attach(id, rec())
    if (oldHub.pool.bots.size || fs.logins[uid] !== logins) throw new Error('owner: a stood-down sender must not attach')

    // 울타리가 없던 예전 서버가 지운 로그인(기록·봇 상태·맡은 방 bot_down) → 새 서버가 되살린다
    await store.saveRecord(id, Object.assign(rec(), { credentials: { access_token: '', refresh_token: '', user_id: uid, device_uuid: '', device_type: 'tablet' }, needs_register: true, reason: 'kicked' }))
    await store.botState(id, { state: 'needs_register' })
    await store.markBotRooms(id, Date.now())
    if (rowOf(iO).error_code !== 'bot_down') throw new Error('owner: test setup bot_down')
    if ((await newHub.heal()) !== 1) throw new Error('owner: heal restores one login')
    const healed = store.records.get(id)
    if (healed.needs_register || healed.credentials.access_token !== 'fake-ov' || healed.reason !== 'ok') throw new Error('owner: healed record')
    await waitFor(() => rowOf(iO).state === 'active' && store.bots.get(id).state === 'connected', 5000, 'owner: heal puts the bot and its rooms back')
    if ((await newHub.heal()) !== 0) throw new Error('owner: heal leaves a good record alone')

    // 막 켜진 주인이 KICKOUT 을 받음(예전 서버가 다시 붙음) → 지우지 않고 다시 붙는다
    const before = fs.logins[uid]
    newSlot.client._dispatch({ method: 'KICKOUT', body: { reason: 0 } })
    await waitFor(() => fs.logins[uid] > before && newSlot.live(), 3000, 'owner: owner reconnects after a kick right after boot')
    if (newSlot.dead || store.records.get(id).needs_register) throw new Error('owner: owner kept the login after a boot-time kick')

    // 주인 고동: 새 서버가 살아 있으면 예전 서버는 lost, 조용해지면 orphan(다시 시작해 주인이 된다)
    if ((await newOwner.tick()) !== 'mine') throw new Error('owner: tick mine')
    if ((await oldOwner.tick()) !== 'lost') throw new Error('owner: tick lost')
    store.senderOwner.beat = Date.now() - 120000
    if ((await oldOwner.tick()) !== 'orphan') throw new Error('owner: tick orphan')
    if ((await newOwner.tick()) !== 'mine') throw new Error('owner: a live owner beats again')
    await newHub.pool.stop()
    store.senderOwner = null
  }

  await pool.stop()
  if (prevSecret === undefined) delete process.env.CONFIG_SECRET
  else process.env.CONFIG_SECRET = prevSecret
  if (prevJoin === undefined) delete process.env.FAKE_JOIN_MS
  else process.env.FAKE_JOIN_MS = prevJoin
}

process.stdout.write('sender selfcheck ok\n')
