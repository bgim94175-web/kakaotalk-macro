import { KakaoTalkClient } from 'agent-messenger/kakaotalk'

import { roomListKind } from './room-kind.mjs'
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
  parseRoomKey,
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
const quietVisit = visitRecord({ enabled: false })
const quietJoin = guardOnChat(quietVisit, {
  kind: 'join', chatId: '555', authorId: '7', authorName: '홍길동',
  profileLink: 'https://open.kakao.com/o/abc', now: t0,
})
if (quietJoin.sends.length !== 0 || quietVisit.runtime.visit) throw new Error('join notice is off by default')
const firstVisit = visitRecord()
guardOnChat(firstVisit, { kind: 'leave', chatId: '555', authorId: '7', authorName: '홍길동', now: t0 })
const joined = guardOnChat(firstVisit, {
  kind: 'join', chatId: '555', authorId: '7', authorName: '홍길동',
  profileLink: 'https://open.kakao.com/o/abc', now: t0 + 60000,
})
if (joined.sends.length !== 1) throw new Error('one join notice')
const note = joined.sends[0].text
if (note.indexOf('https://open.kakao.com/o/abc') < 0) throw new Error('open profile link')
if (note.indexOf('동네모임') < 0) throw new Error('room name')
if (note.indexOf('2023-11-15 07:13') < 0 || note.indexOf('2023-11-15 07:14') < 0) throw new Error('join and leave times')
if (note.indexOf('강퇴') >= 0 || note.indexOf('@') >= 0) throw new Error('notice must not kick or mention')
const noLeave = visitRecord()
const onlyJoin = guardOnChat(noLeave, {
  kind: 'join', chatId: '555', authorId: '9', authorName: '김', profileLink: 'not-a-url', now: t0,
})
if (onlyJoin.sends[0].text.indexOf('아직 나간 기록이 없습니다') < 0) throw new Error('missing leave is stated')
if (onlyJoin.sends[0].text.indexOf('확인되지 않았습니다') < 0) throw new Error('missing link is stated')
if (onlyJoin.sends[0].delayMs !== 0) throw new Error('first notice has no wait')
const burst = guardOnChat(noLeave, {
  kind: 'join', chatId: '555', authorId: '10', authorName: '이', now: t0 + 100,
})
if (burst.sends.length !== 1 || burst.sends[0].delayMs < 3000) throw new Error('notices keep a gap')
const otherRoom = guardOnChat(noLeave, {
  kind: 'join', chatId: '999', authorId: '10', authorName: '이', now: t0,
})
if (otherRoom.sends.length !== 0) throw new Error('unwatched room stays quiet')
const left = guardOnChat(noLeave, { kind: 'leave', chatId: '555', authorId: '9', now: t0 + 200 })
if (left.sends.length !== 0) throw new Error('a leave is recorded and not announced')

const client = new KakaoTalkClient()
await client.login({ oauthToken: 'tok', userId: '42', deviceUuid: 'duuid-test', deviceType: 'tablet' })
if (client.isConnected()) throw new Error('login() must not open a LOCO socket')
const got = client.getCredentials()
if (got.oauthToken !== 'tok' || got.userId !== '42') throw new Error('credentials not restored')

process.stdout.write('sender selfcheck ok\n')
