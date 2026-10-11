import { KakaoTalkClient } from 'agent-messenger/kakaotalk'

import { roomListKind, roomTitle, stampOpenLinkTitles, withoutMemberCount } from './room-kind.mjs'
import { Hub, Slot } from './runner.mjs'
import { Owner } from './owner.mjs'
import { open, seal } from './store.mjs'
import { FOLD, withProfileLink } from './roomfeat.mjs'

// 접힌 사람 안내: 첫 줄(제목 · @닉네임) + 보이지 않는 글자 + 줄바꿈 + 자세한 내용([전체보기])
const folded = (head, lines) => head + FOLD + '\n' + lines.join('\n')
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
  [{ type: 2, link_id: '9', display_name: '김, 이, 박', title: '김, 이, 박', active_members: 4 }, 'normal'],
  [{ type: 2, link_id: '9', title: '동네모임', display_name: '김, 이, 박', active_members: 4 }, 'open_room'],
  [{ type: 2, link_id: '9', title: '홍길동', display_name: '홍길동', active_members: 2 }, 'open_dm'],
  [{ type: 13, link_id: '9', title: '모임방', display_name: '김, 이', active_members: 3 }, 'open_room'],
  [{ type: 13, link_id: '9', display_name: '김, 이', active_members: 3 }, 'open_room'],
  [{ type: 'OM', title: '김, 이, 박', display_name: '김, 이, 박' }, 'open_room'],
  [{ type: 15, link_id: '3', title: '별명방', display_name: '가, 나', active_members: 2 }, 'open_room'],
]
for (const [ch, want] of kinds) {
  const got = roomListKind(ch)
  if (got !== want) throw new Error(`room kind ${JSON.stringify(ch)} -> ${got}, want ${want}`)
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
// 새 모양: 제목 · 줄 · 👤 🆔 🔗(🖼 은 사진을 알 때만) · 기록(가지 줄) · 줄. 옛 계정 기능은 사진을 몰라 사진 줄이 없다.
const expectedLeave = folded('📤 퇴장 안내 · @홍길동', [
  '━━━━━━━━━━━━━━',
  '👤 홍길동',
  '🆔 7',
  '🔗 옾링 : 없음',
  '',
  '🕒 퇴장 기록 · 1회',
  ' └ 2023-11-15 07:13',
  '━━━━━━━━━━━━━━',
])
if (leftNote !== expectedLeave) throw new Error('leave notice layout ' + JSON.stringify(leftNote))
if (leftNote.indexOf('입장 기록') >= 0 || leftNote.indexOf('입장 안내') >= 0) throw new Error('a leave notice has no enter log')
const joined = guardOnChat(firstVisit, {
  kind: 'join', chatId: '555', authorId: '7', authorName: '홍길동',
  profileLink: 'https://open.kakao.com/o/abc', photo: 'https://k.kakaocdn.net/dn/a/b/img_s.jpg', now: t0 + 60000,
})
if (joined.sends.length !== 1) throw new Error('one join notice')
const note = joined.sends[0].text
const expected = folded('📥 입장 안내 · @홍길동', [
  '━━━━━━━━━━━━━━',
  '👤 홍길동',
  '🆔 7',
  '🔗 옾링 : https://open.kakao.com/o/abc',
  '🖼 사진 : https://k.kakaocdn.net/dn/a/b/img_s.jpg',
  '',
  '🕒 입장 기록 · 1회',
  ' └ 2023-11-15 07:14',
  '━━━━━━━━━━━━━━',
])
// [전체보기]: 첫 줄만 보이고 500자가 넘게 채워져 카카오톡이 접는다. 멘션(@)은 첫 줄 하나뿐이다
if (note.split('\n')[0] !== '📥 입장 안내 · @홍길동' + FOLD || note.length < 500 || note.split('@').length !== 2) throw new Error('the enter notice folds behind 전체보기')
if (note !== expected) throw new Error('enter notice layout ' + JSON.stringify(note))
if (note.indexOf('퇴장 기록') >= 0 || note.indexOf('퇴장 안내') >= 0 || note.indexOf('07:13') >= 0) {
  throw new Error('an enter notice has no leave log')
}
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
if (laterText.indexOf('📥 입장 안내') !== 0 || laterText.indexOf('퇴장') >= 0) throw new Error('a later join is only an enter notice')
if (laterText.indexOf('🕒 입장 기록 · 2회\n ├ 2023-11-15 07:14\n └ 2023-11-15 07:15') < 0) throw new Error('every join time is listed')
if (laterText.indexOf('🖼 사진 : https://k.kakaocdn.net/dn/a/b/img_s.jpg') < 0) throw new Error('the photo is kept from the last time')
if (!laterJoin.sends[0].mention || laterJoin.sends[0].mention.userId !== '7') throw new Error('still one mention')
const laterLeft = guardOnChat(firstVisit, {
  kind: 'leave', chatId: '555', authorId: '7', authorName: '홍길동', now: t0 + 3 * 3600000 + 120000,
})
const leftText = laterLeft.sends.length === 1 ? laterLeft.sends[0].text : ''
if (leftText.indexOf('📤 퇴장 안내') !== 0) throw new Error('a later leave posts')
if (leftText.indexOf('입장 기록') >= 0) throw new Error('a leave notice has no enter log')
if (leftText.indexOf('🕒 퇴장 기록 · 2회\n ├ 2023-11-15 07:13\n └ 2023-11-15 10:15') < 0) throw new Error('every leave time is listed ' + JSON.stringify(leftText))
if (leftText.indexOf('🔗 옾링 : https://open.kakao.com/o/abc') < 0) throw new Error('the leave keeps the open profile')
if (leftText.indexOf('⏳ 머문 시간 : 3시간 (11-15 07:15 입장)') < 0) throw new Error('the leave states how long the person stayed ' + JSON.stringify(leftText))
// 프로필 변경: 같은 사람(userId 7)이 이름/링크를 바꿔 다시 들어오면 그 이력을 남긴다.
const swapRec = visitRecord()
guardOnChat(swapRec, { kind: 'join', chatId: '555', authorId: '7', authorName: '홍길동',
  profileLink: 'https://open.kakao.com/o/old', now: t0 })
const renamed = guardOnChat(swapRec, { kind: 'join', chatId: '555', authorId: '7', authorName: '김철수',
  profileLink: 'https://open.kakao.com/o/new', now: t0 + 60000 })
const swapText = renamed.sends[0].text
if (swapText.indexOf('📝 예전 프로필 · 1회\n └ 2023-11-15 07:14 · 홍길동 · https://open.kakao.com/o/old') < 0) throw new Error('the old name and link are kept ' + JSON.stringify(swapText))
if (swapText.indexOf('📥 입장 안내 · @김철수' + FOLD) !== 0 || swapText.indexOf('\n👤 김철수\n') < 0) throw new Error('the current name is the mention')
if (renamed.sends[0].mention.userId !== '7') throw new Error('still one mention after a rename')
if (visitMentionExtra(swapText, renamed.sends[0].mention).split('user_id').length !== 2) throw new Error('rename keeps one mention')
// 같은 사람이 그대로 다시 들어오면 변경 이력이 늘지 않는다
const swapAgain = guardOnChat(swapRec, { kind: 'join', chatId: '555', authorId: '7', authorName: '김철수',
  profileLink: 'https://open.kakao.com/o/new', now: t0 + 120000 })
if (swapAgain.sends[0].text.indexOf('📝 예전 프로필 · 1회') < 0) throw new Error('no new change when nothing changed')
if (swapAgain.sends[0].text.indexOf('· 김철수') >= 0) throw new Error('the current identity is not logged as a change')
// 처음 보는 사람은 변경 이력이 없다
if (note.indexOf('예전 프로필') >= 0) throw new Error('a first sighting has no change log')

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
// 새 모양: 사람 정보(👤 🆔 🔗) + 바뀐 내용(전·후). 메시지에서는 옾링을 모르니 '없음'으로 두고 linkFor 로 봇에게 맡긴다.
const RENAME = folded('🔔 프로필 변경 감지 · @사기꾼_새닉', ['━━━━━━━━━━━━━━', '👤 사기꾼_새닉', '🆔 7', '🔗 옾링 : 없음', '', '✏️ 바뀐 내용', '▸ 닉네임',
  ' ├ 전 : 홍길동', ' └ 후 : 사기꾼_새닉', '━━━━━━━━━━━━━━'])
if (rtext !== RENAME) throw new Error('rename notice layout: ' + JSON.stringify(rtext))
if (renameMsg.sends[0].linkFor !== '7') throw new Error('rename notice asks the sender to fill the open profile link')
if (renameMsg.sends[0].mention.userId !== '7') throw new Error('rename notice mentions the person')
{
  const m0 = renameMsg.sends[0].mention
  if (rtext.slice(m0.at, m0.at + m0.len) !== '사기꾼_새닉') throw new Error('rename mention points at the new name')
  const filled = withProfileLink(renameMsg.sends[0], 'https://open.kakao.com/me/abc')
  if (filled.text !== RENAME.replace('🔗 옾링 : 없음', '🔗 옾링 : https://open.kakao.com/me/abc')) throw new Error('filled rename notice layout')
  if (filled.text.slice(filled.mention.at, filled.mention.at + filled.mention.len) !== '사기꾼_새닉') throw new Error('the mention moves with the filled link')
  if (filled.linkFor || !renameMsg.sends[0].linkFor) throw new Error('filling drops linkFor on the copy only')
  if (withProfileLink(renameMsg.sends[0], 'javascript:alert(1)') !== renameMsg.sends[0]) throw new Error('a bad link is not filled')
}
if (visitMentionExtra(rtext, renameMsg.sends[0].mention).split('user_id').length !== 2) throw new Error('rename keeps one mention')
if (renameMsg.sends[0].delayMs !== 0) throw new Error('first profile notice has no wait')
// 한 번 알린 뒤에는 같은 닉으로 또 쏘지 않는다
const after = guardOnChat(liveRec, { kind: 'msg', chatId: '555', authorId: '7', authorName: '사기꾼_새닉',
  text: '또 메시지', now: t0 + 3000 })
if (after.sends.length !== 0) throw new Error('no repeat notice for the same new name')
// 연달아 바꿔도 바뀔 때마다 알리고, 누적 횟수가 올라간다
const twice = guardOnChat(liveRec, { kind: 'msg', chatId: '555', authorId: '7', authorName: '또다른닉',
  text: '세번째', now: t0 + 4000 })
if (twice.sends.length !== 1 || twice.sends[0].text.indexOf(' ├ 전 : 사기꾼_새닉\n └ 후 : 또다른닉') < 0) throw new Error('a quick second rename is announced too')
if (twice.sends[0].text.indexOf('🔁 누적 변경 : 2회') < 0) throw new Error('repeated renames count up')
const thrice = guardOnChat(liveRec, { kind: 'msg', chatId: '555', authorId: '7', authorName: '세번째닉',
  text: '네번째', now: t0 + 5000 })
if (thrice.sends.length !== 1 || thrice.sends[0].text.indexOf('🔁 누적 변경 : 3회') < 0) throw new Error('a third rename posts again')
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
if (onlyJoin.sends[0].text.indexOf('🔗 옾링 : 없음') < 0) throw new Error('missing link is stated')
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
if (left.sends.length !== 1 || left.sends[0].text.indexOf('📤 퇴장 안내') !== 0) throw new Error('a leave is announced')
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
if (plainPosted.sends[0].text.indexOf('📥 입장 안내') !== 0) throw new Error('plain sentence uses the enter notice')
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
if (feedLeft.sends.length !== 1 || feedLeft.sends[0].text.indexOf('📤 퇴장 안내') !== 0) {
  throw new Error('a feed leave posts one notice')
}
if (feedLeft.sends[0].text.indexOf('2023-11-15 07:13') < 0 || feedLeft.sends[0].text.indexOf('입장 기록') >= 0) {
  throw new Error('the leave time is on the leave notice')
}
const feedJoin = guardOnChat(feedRoom, {
  kind: openJoin[0].kind, chatId: '555', authorId: '7',
  authorName: '홍길동', profileLink: 'https://open.kakao.com/o/abc', now: t0 + 60000,
})
if (feedJoin.sends.length !== 1 || feedJoin.sends[0].text.indexOf('📥 입장 안내') !== 0) {
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
const ascii = folded('📥 입장 안내 · @GOLD_AEC1908', ['━━━━━━━━━━━━━━', '👤 GOLD_AEC1908', '🆔 42', '🔗 옾링 : https://open.kakao.com/o/abc', '', '🕒 입장 기록 · 1회', ' └ 2026-10-05 21:04', '━━━━━━━━━━━━━━'])
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
if (feedJoin.sends[0].text.indexOf('2023-11-15 07:13') >= 0 || feedJoin.sends[0].text.indexOf('퇴장') >= 0) {
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
    const n = RF.churnNotice(plan, 'warn')
    if (n.text.split('@').length !== 2 || !n.mention || n.mention.userId !== '7') throw new Error('7.7#3 one mention')
    if (n.text !== '[들낙 감지]\n이름 : @홍길동\n입장 : 10분 동안 3회\n조치 : 경고') throw new Error('7.7#3 notice layout ' + n.text)
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
  // #6 사진 변경 → 프로필 변경 안내 1개(사진 전·후). 상태 null → 없음. 첫 관찰 → 없음. 바로 또 바뀌어도 매번 안내
  {
    const rt = {}
    const pcfg = { name: true, photo: true, status: true }
    const P1 = 'https://k.kakaocdn.net/dn/a/1.jpg'
    const P2 = 'https://k.kakaocdn.net/dn/a/2.jpg'
    if (RF.profileObserve(rt, '555', pcfg, { userId: '7', name: '홍', photo: P1 + '?t=1', status: null }, T).length) throw new Error('7.7#6 first')
    const ph = RF.profileObserve(rt, '555', pcfg, { userId: '7', name: '홍', photo: P2 + '?t=2', status: null }, T + 1000)
    const PH = folded('🔔 프로필 변경 감지 · @홍', [RF.RULE, '👤 홍', '🆔 7', '🔗 옾링 : 없음', '🖼 사진 : ' + P2, '', '✏️ 바뀐 내용', '▸ 사진',
      ' ├ 전 : ' + P1, ' └ 후 : ' + P2, RF.RULE])
    if (ph.length !== 1 || ph[0].text !== PH || ph[0].mention.userId !== '7' || ph[0].text.slice(ph[0].mention.at, ph[0].mention.at + 1) !== '홍') throw new Error('7.7#6 photo ' + JSON.stringify(ph[0] && ph[0].text))
    if (RF.profileObserve(rt, '555', pcfg, { userId: '7', name: '홍', photo: P2, status: null }, T + 2000).length) throw new Error('7.7#6 status null')
    RF.profileObserve(rt, '555', pcfg, { userId: '8', name: '김', status: '안녕' }, T)
    const stc = RF.profileObserve(rt, '555', pcfg, { userId: '8', name: '김', status: '바이' }, T + 1)
    if (stc.length !== 1 || stc[0].text.indexOf('▸ 상태 메시지\n ├ 전 : 안녕\n └ 후 : 바이') < 0) throw new Error('7.7#6 status')
    // 바로 또 바뀌어도 알린다
    const st2 = RF.profileObserve(rt, '555', pcfg, { userId: '8', name: '김', status: '다시' }, T + 2)
    if (st2.length !== 1 || st2[0].text.indexOf('▸ 상태 메시지\n ├ 전 : 바이\n └ 후 : 다시') < 0) throw new Error('7.7#6 every change is announced')
    // 관찰한 곳에서 옾링을 알면 바로 적고 linkFor 는 없다
    const wl = RF.profileObserve(rt, '555', pcfg, { userId: '8', name: '김새닉', status: '다시', link: 'https://open.kakao.com/me/kim' }, T + 6 * 60000)
    if (wl.length !== 1 || wl[0].text.indexOf('\n👤 김새닉\n🆔 8\n🔗 옾링 : https://open.kakao.com/me/kim\n') < 0 || wl[0].text.indexOf('▸ 닉네임\n ├ 전 : 김\n └ 후 : 김새닉') < 0 || wl[0].linkFor) throw new Error('7.7#6 known link is written at once ' + JSON.stringify(wl[0] && wl[0].text))
    if (wl[0].text.slice(wl[0].mention.at, wl[0].mention.at + wl[0].mention.len) !== '김새닉') throw new Error('7.7#6 mention points at the current name')
    if (wl[0].text.indexOf('🔁 누적 변경 : 3회') < 0) throw new Error('7.7#6 cumulative changes ' + JSON.stringify(wl[0].text))
    if (RF.photoSig('https://x.kakao.com/p/1.jpg?t=9', '') !== '/p/1.jpg') throw new Error('7.7#6 photo signature is the path without the query')
    const rows = F.logsView({ rooms: [{ key: 'r', chat_id: '555', name: '방' }], runtime: rt }).profile
    if (!rows.some((r) => r.changes.some((c) => c.kind === 'photo'))) throw new Error('7.7#5 profile log has kind')
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
    if (RF.profileLookup(rt, '555', cfg, { authorId: '1', arg: '', mentions: [] }, host, T) !== '「!프로필 닉네임」처럼 입력해 주세요.') throw new Error('7.7#7 usage')
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
      profilePushDelayMs: 30, profileReadGapMs: 50, profileConvert: 'off', linkGapMs: 0,
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
  await pool.reconcile(null)
  await waitFor(() => [iGone, iBan, iAnon, iPassWrong, iPassNone, iDm].every((id) => rowOf(id).state === 'error') && rowOf(iPassOk).state === 'active' && rowOf(iRate).error_detail === 'rate_limited', 8000, '7.7#16 joins')
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
    if (sent[1] !== '[명령어]\n미니게임 : !끝말잇기 !숫자야구 !주사위 !가위바위보 !퀴즈 !힌트 !정답 !포기 !랭킹') throw new Error('7.7#18 game list text ' + JSON.stringify(sent))
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
  }

  // #28 방 멤버 명부: 봇이 들어가기 전부터 있던 사람도 옾링·사진을 안다(GETMEM + INFOLINK)
  //   · 먼저 있던 사람이 나가면 퇴장 안내에 옾링·사진 · 명부는 저장소에 남는다
  //   · 메시지 닉네임이 바뀌면 카드를 다시 읽어 프로필 변경 안내(닉네임 전·후 + 지금 옾링·사진)
  //   · 주기 동기화가 옾링(다른 오픈프로필로 바꿈)·사진 변경을 찾는다 · 바뀔 때마다 알린다
  {
    const code = 'bookx28'
    const room0 = fs.room(code)
    fs.setProfiles('701', [{ li: '7101', name: '먼저 온 프로필', url: 'https://open.kakao.com/o/first701' }, { li: '7102', name: '바꾼 프로필', url: 'https://open.kakao.com/o/second701' }])
    fs.setProfiles('702', [{ li: '7201', name: '둘째 프로필', url: 'https://open.kakao.com/o/second702' }])
    room0.members['701'] = { mt: 2, nick: '먼저온사람', ptp: 16, pli: '7101', photo: 'https://k.kakaocdn.net/dn/p/701a.jpg', status: null }
    room0.members['702'] = { mt: 2, nick: '둘째', ptp: 16, pli: '7201', photo: 'https://k.kakaocdn.net/dn/p/702a.jpg', status: null }
    room0.members['703'] = { mt: 2, nick: '기본프로필', ptp: 1, pli: null, photo: '', status: null }
    const iBook = install(code, { config: { visit: { enabled: true }, profile: { enabled: true } } })
    await pool.reconcile(null)
    await waitFor(() => rowOf(iBook).state === 'waiting_host', 5000, '#28 join')
    const chat = rowOf(iBook).chat_id
    fs.setPerm(chat, botA.uid, 4)
    await waitFor(() => rowOf(iBook).state === 'active', 3000, '#28 promotion')
    const vb = botA.slot.byInstall.get(iBook)
    await waitFor(() => vb.members.get('701') && vb.members.get('701').link && vb.members.get('702') && vb.members.get('702').link, 5000, '#28 member book')
    const m701 = vb.members.get('701')
    if (m701.link !== 'https://open.kakao.com/o/first701' || m701.photo !== 'https://k.kakaocdn.net/dn/p/701a.jpg' || m701.name !== '먼저온사람') throw new Error('#28 book row ' + JSON.stringify(m701))
    if (vb.members.get('703').link !== '' || vb.members.get('703').photo !== '') throw new Error('#28 default profile has no link and no photo')
    if (sentIn(iBook).some((t) => t.indexOf('프로필 변경 감지') >= 0)) throw new Error('#28 the first read only sets a baseline')
    // 먼저 있던 사람이 나간다 → 퇴장 안내에 옾링·사진(예전에는 '없음'이었다)
    fs.event(chat, botA.uid, { kind: 'leave', user_id: '701', name: '먼저온사람' })
    await waitFor(() => sentIn(iBook).some((t) => t.indexOf('📤 퇴장 안내') === 0), 8000, '#28 leave notice')
    const out = sentIn(iBook).find((t) => t.indexOf('📤 퇴장 안내') === 0)
    if (out.indexOf('\n👤 먼저온사람\n🆔 701\n🔗 옾링 : https://open.kakao.com/o/first701\n🖼 사진 : https://k.kakaocdn.net/dn/p/701a.jpg\n') < 0) throw new Error('#28 leave notice has the link of someone who was there before the bot ' + JSON.stringify(out))
    await pool.flush()
    const saved = await store.loadMembers(iBook, chat, 0)
    if (!saved.some((r) => r.user_id === '701' && r.link === 'https://open.kakao.com/o/first701')) throw new Error('#28 the book is saved ' + JSON.stringify(saved))
    // 메시지 닉네임이 바뀌었다 → 카드를 읽어 프로필 변경 안내
    fs.event(chat, botA.uid, { kind: 'profile', user_id: '702', name: '둘째새닉' })
    fs.event(chat, botA.uid, { kind: 'message', user_id: '702', name: '둘째새닉', text: '닉 바꿨어요' })
    await waitFor(() => sentIn(iBook).some((t) => t.indexOf('🔔 프로필 변경 감지') === 0), 8000, '#28 rename notice')
    const rn = sentIn(iBook).find((t) => t.indexOf('🔔 프로필 변경 감지') === 0)
    const RN = folded('🔔 프로필 변경 감지 · @둘째새닉', [RF.RULE, '👤 둘째새닉', '🆔 702', '🔗 옾링 : https://open.kakao.com/o/second702', '🖼 사진 : https://k.kakaocdn.net/dn/p/702a.jpg',
      '', '✏️ 바뀐 내용', '▸ 닉네임', ' ├ 전 : 둘째', ' └ 후 : 둘째새닉', RF.RULE])
    if (rn !== RN) throw new Error('#28 rename notice ' + JSON.stringify(rn))
    // 주기 동기화: 703 은 사진을 바꾸고, 702 는 닉네임을 또 바꿨다(바뀔 때마다 알린다)
    room0.members['703'].photo = 'https://k.kakaocdn.net/dn/p/703b.jpg'
    room0.members['702'].nick = '둘째또닉'
    vb.memberSyncAt = 0
    await waitFor(() => sentIn(iBook).some((t) => t.indexOf('\n👤 기본프로필\n') >= 0), 8000, '#28 photo notice')
    const pc = sentIn(iBook).find((t) => t.indexOf('\n👤 기본프로필\n') >= 0)
    if (pc.indexOf('🔗 옾링 : 없음\n🖼 사진 : https://k.kakaocdn.net/dn/p/703b.jpg\n') < 0 || pc.indexOf('▸ 사진\n ├ 전 : 없음\n └ 후 : https://k.kakaocdn.net/dn/p/703b.jpg') < 0) throw new Error('#28 photo change ' + JSON.stringify(pc))
    await waitFor(() => sentIn(iBook).some((t) => t.indexOf('\n👤 둘째또닉\n') >= 0), 8000, '#28 second rename notice')
    const rn2 = sentIn(iBook).find((t) => t.indexOf('\n👤 둘째또닉\n') >= 0)
    if (rn2.indexOf('▸ 닉네임\n ├ 전 : 둘째새닉\n └ 후 : 둘째또닉') < 0 || rn2.indexOf('🔁 누적 변경 : 2회') < 0) throw new Error('#28 a quick second rename is announced ' + JSON.stringify(rn2))
    const hist = vb.runtime.profile.people[chat + '\u0001702']
    if (!hist || hist.changes.filter((c) => c.kind === 'name').length !== 2) throw new Error('#28 both renames are recorded ' + JSON.stringify(hist))
  }
  // #28-2 다른 오픈프로필로 바꿈(pli → 다른 pli)은 옾링 변경. 방마다 1분에 6번까지만 보내므로 새 방에서 본다.
  {
    const code = 'bookx29'
    const room0 = fs.room(code)
    fs.setProfiles('711', [{ li: '7111', name: '처음 프로필', url: 'https://open.kakao.com/o/a711' }, { li: '7112', name: '바꾼 프로필', url: 'https://open.kakao.com/o/b711' }])
    room0.members['711'] = { mt: 2, nick: '바꿀사람', ptp: 16, pli: '7111', photo: 'https://k.kakaocdn.net/dn/p/711.jpg', status: null }
    const iLink = install(code, { config: { profile: { enabled: true } } })
    await pool.reconcile(null)
    await waitFor(() => rowOf(iLink).state === 'waiting_host', 5000, '#28-2 join')
    const chat = rowOf(iLink).chat_id
    fs.setPerm(chat, botA.uid, 4)
    await waitFor(() => rowOf(iLink).state === 'active', 3000, '#28-2 promotion')
    const vl = botA.slot.byInstall.get(iLink)
    await waitFor(() => vl.members.get('711') && vl.members.get('711').link === 'https://open.kakao.com/o/a711', 5000, '#28-2 member book')
    room0.members['711'].pli = '7112'
    vl.memberSyncAt = 0
    await waitFor(() => sentIn(iLink).some((t) => t.indexOf('▸ 옾링') >= 0), 8000, '#28-2 link change notice')
    const lc = sentIn(iLink).find((t) => t.indexOf('▸ 옾링') >= 0)
    if (lc.indexOf('▸ 옾링\n ├ 전 : https://open.kakao.com/o/a711\n └ 후 : https://open.kakao.com/o/b711') < 0 || lc.indexOf('🔗 옾링 : https://open.kakao.com/o/b711') < 0) throw new Error('#28-2 link change ' + JSON.stringify(lc))
    const rows = F.logsView(RF.adapterRecord(vl, botA.id)).profile
    if (!rows.some((r) => r.changes.some((c) => c.kind === 'link' && c.to === 'https://open.kakao.com/o/b711'))) throw new Error('#28-2 the panel log has the link change ' + JSON.stringify(rows))
  }

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
    await waitFor(() => sentIn(iP).some((t) => t === RF.PROMOTED_NOTICE), 3000, 'promotion notice')
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

    // 울타리가 없던 예전 서버가 지운 로그인 → 새 서버가 되살린다
    await store.saveRecord(id, Object.assign(rec(), { credentials: { access_token: '', refresh_token: '', user_id: uid, device_uuid: '', device_type: 'tablet' }, needs_register: true, reason: 'kicked' }))
    if ((await newHub.heal()) !== 1) throw new Error('owner: heal restores one login')
    const healed = store.records.get(id)
    if (healed.needs_register || healed.credentials.access_token !== 'fake-ov' || healed.reason !== 'ok') throw new Error('owner: healed record')
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
