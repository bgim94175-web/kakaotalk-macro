import { KakaoTalkClient } from 'agent-messenger/kakaotalk'

import { roomListKind, roomTitle, stampOpenLinkTitles, withoutMemberCount } from './room-kind.mjs'
import { Hub, Slot } from './runner.mjs'
import { open, seal } from './store.mjs'
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
if (notes.length !== 1 || notes[0].text.indexOf('이후 강퇴하지 않습니다') < 0) throw new Error('halt notice')
const denied = guardRecord()
guardFinishHalt(denied, '555', false, t0, '관리방', 3)
if (guardNotices(denied)[0].text.indexOf('권한이 없습니다') < 0) throw new Error('no permission notice')
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
const expectedLeave = [
  '[퇴장안내]',
  '이름 : @홍길동',
  '옾링 : 찾지 못했습니다',
  '퇴장로그',
  '- 2023-11-15 07:13',
].join('\n')
if (leftNote !== expectedLeave) throw new Error('leave notice layout')
if (leftNote.indexOf('입장로그') >= 0 || leftNote.indexOf('[입장안내]') >= 0) throw new Error('a leave notice has no enter log')
const joined = guardOnChat(firstVisit, {
  kind: 'join', chatId: '555', authorId: '7', authorName: '홍길동',
  profileLink: 'https://open.kakao.com/o/abc', now: t0 + 60000,
})
if (joined.sends.length !== 1) throw new Error('one join notice')
const note = joined.sends[0].text
const expected = [
  '[입장안내]',
  '이름 : @홍길동',
  '옾링 : https://open.kakao.com/o/abc',
  '입장로그',
  '- 2023-11-15 07:14',
].join('\n')
if (note !== expected) throw new Error('enter notice layout')
if (note.indexOf('퇴장로그') >= 0 || note.indexOf('[퇴장안내]') >= 0 || note.indexOf('07:13') >= 0) {
  throw new Error('an enter notice has no leave log')
}
if (note.indexOf('들어온 방') >= 0 || note.indexOf('들어온 시각') >= 0 || note.indexOf('나간 시각') >= 0) {
  throw new Error('old labels')
}
if (note.indexOf('강퇴') >= 0 || note.indexOf('들낙방지') >= 0) throw new Error('notice must not kick')
const mention = joined.sends[0].mention
if (!mention || mention.userId !== '7' || mention.len !== 3 || mention.at !== note.indexOf('홍길동')) {
  throw new Error('one mention of the joiner')
}
const extra = visitMentionExtra(note, mention)
const byteAt = Buffer.byteLength(note.slice(0, note.indexOf('홍길동')), 'utf8')
if (byteAt === 1) throw new Error('a korean header is not the mention order')
if (extra !== '{"mentions":[{"user_id":7,"at":[1],"len":3}]}') throw new Error('mention attachment')
if (extra.indexOf(String(byteAt)) >= 0) throw new Error('the mention is not a byte span')
if (extra.split('user_id').length !== 2) throw new Error('the notice mentions one person')
const laterJoin = guardOnChat(firstVisit, {
  kind: 'join', chatId: '555', authorId: '7', authorName: '홍길동',
  profileLink: 'https://open.kakao.com/o/abc', now: t0 + 120000,
})
if (laterJoin.sends.length !== 1) throw new Error('a later join posts again')
const laterText = laterJoin.sends[0].text
if (laterText.indexOf('[입장안내]') < 0 || laterText.indexOf('퇴장') >= 0) throw new Error('a later join is only an enter notice')
if (laterText.indexOf('- 2023-11-15 07:14') < 0 || laterText.indexOf('- 2023-11-15 07:15') < 0) {
  throw new Error('every join time is listed')
}
if (!laterJoin.sends[0].mention || laterJoin.sends[0].mention.userId !== '7') throw new Error('still one mention')
const laterLeft = guardOnChat(firstVisit, {
  kind: 'leave', chatId: '555', authorId: '7', authorName: '홍길동', now: t0 + 180000,
})
if (laterLeft.sends.length !== 1 || laterLeft.sends[0].text.indexOf('[퇴장안내]') < 0) throw new Error('a later leave posts')
if (laterLeft.sends[0].text.indexOf('입장') >= 0) throw new Error('a leave notice has no enter log')
if (laterLeft.sends[0].text.indexOf('- 2023-11-15 07:13') < 0 || laterLeft.sends[0].text.indexOf('- 2023-11-15 07:16') < 0) {
  throw new Error('every leave time is listed')
}
if (laterLeft.sends[0].text.indexOf('옾링 : https://open.kakao.com/o/abc') < 0) throw new Error('the leave keeps the open profile')
// 프로필 변경: 같은 사람(userId 7)이 이름/링크를 바꿔 다시 들어오면 그 이력을 남긴다.
const swapRec = visitRecord()
guardOnChat(swapRec, { kind: 'join', chatId: '555', authorId: '7', authorName: '홍길동',
  profileLink: 'https://open.kakao.com/o/old', now: t0 })
const renamed = guardOnChat(swapRec, { kind: 'join', chatId: '555', authorId: '7', authorName: '김철수',
  profileLink: 'https://open.kakao.com/o/new', now: t0 + 60000 })
const swapText = renamed.sends[0].text
if (swapText.indexOf('프로필 변경') < 0) throw new Error('a profile change is recorded')
if (swapText.indexOf('홍길동 / https://open.kakao.com/o/old') < 0) throw new Error('the old name and link are kept')
if (swapText.indexOf('이름 : @김철수') < 0) throw new Error('the current name is the mention')
if (renamed.sends[0].mention.userId !== '7') throw new Error('still one mention after a rename')
if (visitMentionExtra(swapText, renamed.sends[0].mention).split('user_id').length !== 2) throw new Error('rename keeps one mention')
// 같은 사람이 그대로 다시 들어오면 변경 이력이 늘지 않는다
const swapAgain = guardOnChat(swapRec, { kind: 'join', chatId: '555', authorId: '7', authorName: '김철수',
  profileLink: 'https://open.kakao.com/o/new', now: t0 + 120000 })
if (swapAgain.sends[0].text.split('프로필 변경').length !== 2) throw new Error('no new change when nothing changed')
if (swapAgain.sends[0].text.indexOf('김철수 /') >= 0) throw new Error('the current identity is not logged as a change')
// 처음 보는 사람은 변경 이력이 없다
if (note.indexOf('프로필 변경') >= 0) throw new Error('a first sighting has no change log')

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
if (rtext.indexOf('[프로필 변경 감지]') < 0) throw new Error('rename notice header')
if (rtext.indexOf('이름 : @사기꾼_새닉') < 0) throw new Error('rename notice mentions the new name')
if (rtext.indexOf('이전 : 홍길동') < 0) throw new Error('rename notice keeps the old name')
if (renameMsg.sends[0].mention.userId !== '7') throw new Error('rename notice mentions the person')
if (visitMentionExtra(rtext, renameMsg.sends[0].mention).split('user_id').length !== 2) throw new Error('rename keeps one mention')
if (renameMsg.sends[0].delayMs !== 0) throw new Error('first profile notice has no wait')
// 한 번 알린 뒤에는 같은 닉으로 또 쏘지 않는다
const after = guardOnChat(liveRec, { kind: 'msg', chatId: '555', authorId: '7', authorName: '사기꾼_새닉',
  text: '또 메시지', now: t0 + 3000 })
if (after.sends.length !== 0) throw new Error('no repeat notice for the same new name')
// 또 바꾸면 누적 횟수가 올라간다
const twice = guardOnChat(liveRec, { kind: 'msg', chatId: '555', authorId: '7', authorName: '또다른닉',
  text: '세번째', now: t0 + 4000 })
if (twice.sends.length !== 1) throw new Error('a second rename posts again')
if (twice.sends[0].text.indexOf('누적 : 2회') < 0) throw new Error('repeated renames count up')
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
if (onlyJoin.sends[0].text.indexOf('옾링 : 찾지 못했습니다') < 0) throw new Error('missing link is stated')
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
if (left.sends.length !== 1 || left.sends[0].text.indexOf('[퇴장안내]') < 0) throw new Error('a leave is announced')
if (left.sends[0].text.indexOf('입장') >= 0) throw new Error('a leave notice has no enter log')
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
if (plainPosted.sends[0].text.indexOf('[입장안내]') < 0) throw new Error('plain sentence uses the enter notice')
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
if (feedLeft.sends.length !== 1 || feedLeft.sends[0].text.indexOf('[퇴장안내]') < 0) {
  throw new Error('a feed leave posts one notice')
}
if (feedLeft.sends[0].text.indexOf('2023-11-15 07:13') < 0 || feedLeft.sends[0].text.indexOf('입장') >= 0) {
  throw new Error('the leave time is on the leave notice')
}
const feedJoin = guardOnChat(feedRoom, {
  kind: openJoin[0].kind, chatId: '555', authorId: '7',
  authorName: '홍길동', profileLink: 'https://open.kakao.com/o/abc', now: t0 + 60000,
})
if (feedJoin.sends.length !== 1 || feedJoin.sends[0].text.indexOf('[입장안내]') < 0) {
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
const ascii = '[입장안내]\n이름 : @GOLD_AEC1908\n옾링 : https://open.kakao.com/o/abc\n입장로그\n- 2026-10-05 21:04'
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

process.stdout.write('sender selfcheck ok\n')
