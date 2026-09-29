import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { KakaoTalkClient } from 'agent-messenger/kakaotalk'

import { loadRecord, saveRecord } from './store.mjs'
import { linkable, has } from './word.mjs'
import { correct } from './quiz.mjs'
import { macroRoomsDue, noteMacroSent, onInbound, parseRoomKey } from './features.mjs'

process.env.SENDER_KEY = process.env.SENDER_KEY || '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff'

const dir = await mkdtemp(join(tmpdir(), 'kakao-sender-'))
process.env.DATA_DIR = dir

const rec = {
  credentials: { access_token: 'tok', refresh_token: 'ref', user_id: '9', device_uuid: 'du', device_type: 'tablet' },
  hello: '세션',
}
await saveRecord('device1234', rec)
const back = await loadRecord('device1234')
if (!back || back.credentials.access_token !== 'tok' || back.hello !== '세션') {
  throw new Error('encrypt roundtrip failed')
}

if (!linkable('고려', '여름')) throw new Error('word link 고려->여름')
if (!linkable('콜라', '나비')) throw new Error('word link 콜라->나비')
if (!has('사과')) throw new Error('dict missing 사과')
if (!correct(0, '서울')) throw new Error('quiz')

const roomKey = parseRoomKey('0\u0001공지').key
const record = {
  features: { macro: true, roombot: true, minigame: true },
  config: {
    accounts: [],
    macro: { enabled: true, message: '안녕', rooms: [roomKey], baseMin: 1, randomMin: 0, minMessages: 1, sendImages: 'NEVER', images: [] },
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

const client = new KakaoTalkClient()
await client.login({ oauthToken: 'tok', userId: '42', deviceUuid: 'duuid-test', deviceType: 'tablet' })
if (client.isConnected()) throw new Error('login() must not open a LOCO socket')
const got = client.getCredentials()
if (got.oauthToken !== 'tok' || got.userId !== '42') throw new Error('credentials not restored')

await rm(dir, { recursive: true, force: true })
process.stdout.write('sender selfcheck ok\n')
