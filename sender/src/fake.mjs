// 가짜 모드(SENDER_FAKE=1, docs/ACCOUNTS_V1.md 9.4). 시험 전용 — 운영에서 켜지 않는다.
// 결과를 직접 쓰지 않고 연결 자리(seam)만 바꾼다: FakeKakaoClient 가 agent-messenger 의 KakaoTalkClient 자리에 들어가고,
// botpool·runner 는 진짜와 같은 코드(acquireSession().getConnection().sendPacket, onPush, onSessionEvent, getChats,
// getProfile, getMembersByIds, sendMessage)로 부른다. 그래서 JOININFO·CHECKJOIN·JOINLINK 본문, BSON Long 감싸기,
// lt·pv 검사, locoOk 판정, 권한 읽기, 푸시 해석이 가짜 모드에서도 실제 경로를 탄다.
//
// 가짜 방은 링크 코드(https://open.kakao.com/o/<코드>)로 정해진다. 코드에 든 낱말(대소문자 무시):
//   gone   JOININFO status -324(링크 없음)
//   dm     JOININFO ol.lt = 1(그룹 방 아님)
//   pass   참여코드 필요(pv & 64), 참여코드는 '0000'
//   noprof 기본 프로필 참여 막음(pv & 32 없음) — ptp:1 이면 -804(오픈프로필 ptp:16 은 받는다)
//   noanon 기본 프로필도 닉네임 프로필도 막음 — ptp:2 도 -804(오픈프로필 ptp:16 은 받는다)
//   noopen 오픈프로필(ptp:16) 입장·프로필 바꾸기(UPLINKPROF ptp:16)를 -804 로 거절
//   full   JOINLINK -501
//   rate   JOINLINK 처음 1번 -312
//   ipblock JOINLINK -444
//   weird  JOINLINK 알 수 없는 status -9999
//   lost   JOINLINK 응답 유실(statusCode -1) — 실제로는 들어가 있다
// 봇 계정(users[id].bot)은 기본으로 오픈프로필 1개를 갖는다(users[id].profiles, /v1/fake/profiles 로 바꿈).
// SYNCLINK 는 그 오픈프로필(lt 1, /me/ 주소, op 표지) + 걸러져야 할 링크 2개(이 계정이 만든 방 lt 2, 1:1 오픈채팅 /o/)를 준다.
// users[id].syncFail 이면 SYNCLINK 가 -500. 방 구성원은 ptp(1 기본·2 닉네임·16 오픈프로필)·pli 를 갖는다(없으면 ptp 1).
// 서버 상태는 프로세스 메모리. FAKE_STATE_FILE 이 있으면 그 파일에 남겨 자식을 다시 띄워도 이어진다(시험용).
import { createHash, randomBytes } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'

import { Long } from 'bson'

export function fakeOn() {
  return process.env.SENDER_FAKE === '1'
}

function sha(s) {
  return createHash('sha256').update(String(s)).digest('hex')
}

function decimalOf(hex) {
  return BigInt('0x' + hex).toString()
}

/** 가짜 사용자 id(장치 id 마다 고정). */
export function fakeUserId(deviceId) {
  return decimalOf(sha('user:' + deviceId).slice(0, 12))
}

export function fakeNick(userId) {
  return 'K bot 테스트 ' + sha('nick:' + userId).slice(0, 6)
}

/** 가짜 봇 계정의 기본 오픈프로필 이름(카카오톡 닉네임과 다르다). */
export function fakeProfileName(userId) {
  return 'K봇 오픈 ' + sha('open-name:' + userId).slice(0, 4)
}

function str(v) {
  if (v == null) return ''
  if (typeof v === 'object' && typeof v.toString === 'function') return v.toString()
  return String(v)
}

function L(v) {
  return Long.fromString(String(v))
}

function sec() {
  return Math.floor(Date.now() / 1000)
}

function codeOf(url) {
  const m = /open\.kakao\.com\/o\/([A-Za-z0-9]+)/.exec(String(url || ''))
  return m ? m[1] : ''
}

function has(code, word) {
  return String(code).toLowerCase().includes(word)
}

function resp(method, body, statusCode) {
  return { packetId: 0, statusCode: statusCode == null ? 0 : statusCode, method, bodyType: 0, body: body || {} }
}

// 고객 계정이 보는 가짜 오픈채팅방 2개(/v1/chats)
const CUSTOMER_ROOMS = [
  { chat_id: '9100000000001', link_id: '9200000000001', name: '가짜 오픈채팅 1', members: 12 },
  { chat_id: '9100000000002', link_id: '9200000000002', name: '가짜 오픈채팅 2', members: 30 },
]

class FakeServer {
  constructor() {
    this.file = String(process.env.FAKE_STATE_FILE || '').trim()
    this.rooms = {}          // code → room
    this.users = {}          // userId → {nick, bot}
    this.seq = 7000000000000
    this.clients = new Set()
    this.packets = []        // 최근 패킷 기록(시험 확인용)
    this.logins = {}         // userId → 새 세션 수
    this.load()
  }

  get joinMs() {
    const n = Number(process.env.FAKE_JOIN_MS)
    return process.env.FAKE_JOIN_MS != null && process.env.FAKE_JOIN_MS !== '' && Number.isFinite(n) && n >= 0 ? n : 1500
  }

  get kickLeft() {
    return process.env.FAKE_KICK_LEFT !== '0'
  }

  load() {
    if (!this.file || !existsSync(this.file)) return
    try {
      const j = JSON.parse(readFileSync(this.file, 'utf8'))
      this.rooms = j.rooms || {}
      this.users = j.users || {}
      this.seq = Number(j.seq) || this.seq
    } catch {
      /* 새로 시작 */
    }
  }

  save() {
    if (!this.file) return
    try {
      writeFileSync(this.file, JSON.stringify({ rooms: this.rooms, users: this.users, seq: this.seq }))
    } catch {
      /* 시험 보조 기록이다 */
    }
  }

  nextLog() {
    this.seq += 1
    return String(this.seq)
  }

  room(code) {
    if (!code) return null
    let r = this.rooms[code]
    if (!r) {
      r = {
        code,
        li: decimalOf(sha(code).slice(0, 12)),
        ln: '테스트방 ' + code,
        lu: 'https://open.kakao.com/o/' + code,
        chatId: decimalOf(sha('chat:' + code).slice(0, 13)),
        passcode: has(code, 'pass') ? '0000' : '',
        members: {},       // userId → {mt, nick, photo, status}
        kicked: [],        // 카카오 내보내기 목록
        bans: [],          // 다시 들어올 수 없는 봇(-815)
        hidden: [],
        msgs: [],
        sent: [],
        deleted: false,
        rateHit: false,
        dropOlu: false,
        dropMember: false,
      }
      this.rooms[code] = r
      this.save()
    }
    return r
  }

  byLi(li) {
    const s = str(li)
    return Object.values(this.rooms).find((r) => r.li === s) || null
  }

  byChat(chatId) {
    const s = str(chatId)
    return Object.values(this.rooms).find((r) => r.chatId === s) || null
  }

  user(userId) {
    const id = str(userId)
    if (!this.users[id]) {
      this.users[id] = { nick: fakeNick(id), bot: false }
      this.save()
    }
    return this.users[id]
  }

  /** 그 계정의 오픈프로필 [{li,name,url}]. 봇 계정은 따로 정하지 않았으면 1개. */
  profilesOf(userId) {
    const id = str(userId)
    const u = this.user(id)
    if (Array.isArray(u.profiles)) return u.profiles
    if (!u.bot) return []
    const h = sha('open:' + id)
    return [{ li: decimalOf(h.slice(0, 12)), name: fakeProfileName(id), url: 'https://open.kakao.com/me/kb' + h.slice(0, 8) }]
  }

  /** /v1/fake/profiles: 오픈프로필 목록 바꾸기(null 이면 그대로) + 이 계정에 SYNCLINKCR·SYNCLINKDL 푸시. */
  setProfiles(userId, list, fail) {
    const id = str(userId)
    const u = this.user(id)
    const before = this.profilesOf(id)
    if (Array.isArray(list)) {
      u.profiles = list.map((p, i) => {
        const h = sha('open:' + id + ':' + i + ':' + String((p && p.name) || ''))
        return {
          li: p && /^[1-9][0-9]*$/.test(String(p.li || '')) ? String(p.li) : decimalOf(h.slice(0, 12)),
          name: String((p && p.name) || ('오픈프로필 ' + (i + 1))),
          url: p && typeof p.url === 'string' && p.url ? p.url : 'https://open.kakao.com/me/kb' + h.slice(0, 8),
        }
      })
    }
    if (fail !== undefined) u.syncFail = !!fail
    this.save()
    const after = this.profilesOf(id)
    for (const p of after) if (!before.some((q) => q.li === p.li)) this.pushTo(id, resp('SYNCLINKCR', { ol: this.profileLink(id, p) }))
    for (const p of before) if (!after.some((q) => q.li === p.li)) this.pushTo(id, resp('SYNCLINKDL', { li: L(p.li) }))
    return { ok: true, profiles: after }
  }

  profileLink(userId, p) {
    return {
      li: L(p.li), ln: p.name, lu: p.url, lt: 1, ac: true, pv: L('2'), dcl: 100,
      olu: { userId: L(str(userId)), nn: p.name, ptp: 2, lmt: 1 },
      op: { desc: '', tags: [] },
    }
  }

  /** 방 구성원 m 의 오픈링크 사용자 모양(olu) */
  oluOf(r, userId) {
    const m = r.members[str(userId)]
    const ptp = m && m.ptp ? Number(m.ptp) : 1
    const out = { userId: L(str(userId)), lmt: m ? Number(m.mt) : 2, ptp, nn: m ? m.nick : '' }
    if (ptp === 16 && m && m.pli) out.pli = L(m.pli)
    return out
  }

  record(client, method, body, out) {
    const row = { at: Date.now(), user: client ? client.userId : '', method, status: out ? (out.statusCode !== 0 ? out.statusCode : (out.body && out.body.status) || 0) : null }
    const c = body && (body.c || body.chatId)
    if (c) row.chat = str(c)
    if (body && body.li) row.li = str(body.li)
    if (body && body.ptp) row.ptp = body.ptp
    if (body && body.pli) row.pli = str(body.pli)
    if (body && body.mid) row.mid = str(body.mid)
    if (body && body.kid) row.kid = str(body.kid)
    this.packets.push(row)
    if (this.packets.length > 2000) this.packets.splice(0, this.packets.length - 2000)
  }

  isMember(r, userId) {
    return !!(r && r.members[str(userId)])
  }

  mtOf(r, userId) {
    const m = r && r.members[str(userId)]
    return m ? Number(m.mt) : 0
  }

  async packet(client, method, body) {
    const out = await this.handle(client, method, body || {})
    this.record(client, method, body, out)
    return out
  }

  async handle(client, method, b) {
    const me = client.userId
    if (method === 'JOININFO' && /open\.kakao\.com\/me\//.test(String(b.lu || ''))) {
      // 오픈프로필 링크(관리자가 붙여 넣은 /me/ 주소 확인용)
      for (const [uid, u] of Object.entries(this.users)) {
        if (!u) continue
        const p = this.profilesOf(uid).find((x) => x.url === String(b.lu))
        if (p) return resp(method, { status: 0, ol: this.profileLink(uid, p) })
      }
      return resp(method, { status: -324 })
    }
    if (method === 'SYNCLINK') {
      const u = this.user(me)
      if (u.syncFail) return resp(method, { status: -500 })
      const h = sha('own:' + me)
      const ols = this.profilesOf(me).map((p) => this.profileLink(me, p))
      // 걸러져야 하는 링크: 이 계정이 만든 오픈채팅방(lt 2), 1:1 오픈채팅 링크(lt 1, /o/, 표지 없음)
      ols.push({ li: L(decimalOf(h.slice(0, 12))), ln: '내가 만든 방', lu: 'https://open.kakao.com/o/own' + h.slice(0, 6), lt: 2, ac: true, ml: 300,
        olu: { userId: L(me), nn: u.nick, ptp: 1, lmt: 1 } })
      ols.push({ li: L(decimalOf(h.slice(12, 24))), ln: '1:1 문의', lu: 'https://open.kakao.com/o/dm' + h.slice(6, 12), lt: 1, ac: true, dcl: 10,
        olu: { userId: L(me), nn: u.nick, ptp: 1, lmt: 1 } })
      return resp(method, { status: 0, ols, ltk: 1 })
    }
    if (method === 'UPLINKPROF') {
      const r = this.byLi(b.li)
      if (!r || r.deleted || !this.isMember(r, me)) return resp(method, { status: -403 })
      const m = r.members[me]
      const ptp = Number(b.ptp)
      if (ptp === 16) {
        if (has(r.code, 'noopen')) return resp(method, { status: -804 })
        const p = this.profilesOf(me).find((x) => x.li === str(b.pli))
        if (!p) return resp(method, { status: -804 })
        Object.assign(m, { ptp: 16, pli: p.li, nick: p.name })
      } else if (ptp === 2) {
        Object.assign(m, { ptp: 2, pli: null, nick: String(b.nn || m.nick) })
      } else {
        Object.assign(m, { ptp: 1, pli: null, nick: this.user(me).nick })
      }
      this.save()
      const olu = this.oluOf(r, me)
      this.pushRoom(r, resp('SYNCLINKPF', { c: L(r.chatId), li: L(r.li), olu }))
      return resp(method, { status: 0, olu })
    }
    if (method === 'JOININFO') {
      const code = codeOf(b.lu)
      const r = this.room(code)
      if (!r || has(code, 'gone') || r.deleted) return resp(method, { status: -324 })
      const pv = (r.passcode ? 64 : 0) | (has(code, 'noprof') || has(code, 'noanon') ? 0 : 32)
      return resp(method, {
        status: 0,
        ol: { li: L(r.li), ln: r.ln, lu: r.lu, lt: has(code, 'dm') ? 1 : 2, pv, ml: 1500 },
      })
    }
    if (method === 'CHECKJOIN') {
      const r = this.byLi(b.li)
      if (!r) return resp(method, { status: -324 })
      if (r.passcode && String(b.pc) === r.passcode) return resp(method, { status: 0, tk: 't' })
      return resp(method, { status: -802 })
    }
    if (method === 'JOINLINK') {
      const r = this.byLi(b.li)
      if (!r || r.deleted) return resp(method, { status: -324 })
      const code = r.code
      if (has(code, 'full')) return resp(method, { status: -501 })
      if (has(code, 'rate') && !r.rateHit) {
        r.rateHit = true
        this.save()
        return resp(method, { status: -312 })
      }
      if (has(code, 'ipblock')) return resp(method, { status: -444 })
      if (has(code, 'weird')) return resp(method, { status: -9999 })
      const ptp = Number(b.ptp) || 1
      if (has(code, 'noprof') && ptp === 1) return resp(method, { status: -804 })
      if (has(code, 'noanon') && ptp !== 16) return resp(method, { status: -804 })
      if (has(code, 'noopen') && ptp === 16) return resp(method, { status: -804 })
      let prof = null
      if (ptp === 16) {
        prof = this.profilesOf(me).find((x) => x.li === str(b.pli)) || null
        if (!prof) return resp(method, { status: -804 })
      }
      if (r.bans.includes(me)) return resp(method, { status: -815 })
      if (r.passcode && b.tk !== 't') return resp(method, { status: -802 })
      if (this.joinMs) await new Promise((ok) => setTimeout(ok, this.joinMs))
      const u = this.user(me)
      const nick = prof ? prof.name : (ptp === 2 && b.nn ? String(b.nn) : u.nick)
      r.members[me] = { mt: 2, nick, ptp, pli: prof ? prof.li : null, photo: '', status: null }
      this.save()
      if (has(code, 'lost')) return resp(method, {}, -1)
      return resp(method, { status: 0, chatRoom: { chatId: L(r.chatId), type: 'OM' }, ol: { li: L(r.li), lt: 2 }, olu: this.oluOf(r, me) })
    }
    if (method === 'CHATONROOM') {
      const r = this.byChat(b.chatId)
      if (!r || !this.isMember(r, me)) return resp(method, { status: -403 })
      return resp(method, r.dropOlu ? { status: 0, chatId: L(r.chatId) } : { status: 0, chatId: L(r.chatId), olu: this.oluOf(r, me) })
    }
    if (method === 'MEMBER') {
      const r = this.byChat(b.chatId)
      if (!r) return resp(method, { status: -403 })
      if (r.dropMember) return resp(method, { status: 0, members: [] })
      const ids = (b.memberIds || []).map(str)
      return resp(method, { status: 0, chatId: L(r.chatId), members: ids.filter((id) => r.members[id]).map((id) => this.memberStruct(r, id)) })
    }
    if (method === 'GETMEM') {
      const r = this.byChat(b.chatId)
      if (!r) return resp(method, { status: -403 })
      return resp(method, { status: 0, members: Object.keys(r.members).map((id) => this.memberStruct(r, id)) })
    }
    if (method === 'CHATINFO') {
      const r = this.byChat(b.chatId)
      const cust = CUSTOMER_ROOMS.find((x) => x.chat_id === str(b.chatId))
      if (cust) return resp(method, { status: 0, chatInfo: { chatId: L(cust.chat_id), type: 'OM', li: L(cust.link_id), a: cust.members } })
      if (!r) return resp(method, { status: -403 })
      return resp(method, {
        status: 0,
        chatInfo: {
          chatId: L(r.chatId), type: 'OM', li: L(r.li), a: Object.keys(r.members).length, left: !this.isMember(r, me),
          lastLogId: r.msgs.length ? L(r.msgs[r.msgs.length - 1].logId) : undefined,
        },
      })
    }
    if (method === 'INFOLINK') {
      const ols = []
      for (const li of b.lis || []) {
        const s = str(li)
        const cust = CUSTOMER_ROOMS.find((x) => x.link_id === s)
        if (cust) {
          ols.push({ li: L(s), ln: cust.name, lu: 'https://open.kakao.com/o/fake' + s.slice(-4) })
          continue
        }
        const r = this.byLi(s)
        if (r && !r.deleted) {
          ols.push({ li: L(r.li), ln: r.ln, lu: r.lu, lt: 2, pv: L(String((r.passcode ? 64 : 0) | (has(r.code, 'noprof') || has(r.code, 'noanon') ? 0 : 32))) })
          continue
        }
        // 오픈프로필 링크(방 구성원 pli → 1:1 링크, 입장 로그)
        for (const [uid, u] of Object.entries(this.users)) {
          if (!u) continue
          const p = this.profilesOf(uid).find((x) => x.li === s)
          if (p) {
            ols.push({ li: L(p.li), ln: p.name, lu: p.url, lt: 1 })
            break
          }
        }
      }
      return resp(method, { status: 0, ols })
    }
    if (method === 'KICKMEM' || method === 'KLDELITEM' || method === 'REWRITE' || method === 'KICKLEAVE') {
      const r = this.byChat(b.c) || this.byLi(b.li)
      if (!r) return resp(method, { status: -403 })
      if (!(this.mtOf(r, me) & 5)) return resp(method, { status: -203 })
      if (method === 'KICKMEM') {
        const id = str(b.mid)
        if (!r.members[id] && !this.kickLeft) return resp(method, { status: -500 })
        delete r.members[id]
        if (!r.kicked.includes(id)) r.kicked.push(id)
      } else if (method === 'KLDELITEM') {
        const id = str(b.kid)
        if (!r.kicked.includes(id)) return resp(method, { status: -500 })
        r.kicked = r.kicked.filter((x) => x !== id)
      } else if (method === 'REWRITE') {
        r.hidden.push(str(b.logId))
        if (r.hidden.length > 2000) r.hidden.splice(0, r.hidden.length - 2000)
      }
      this.save()
      return resp(method, { status: 0 })
    }
    if (method === 'LEAVE') {
      const r = this.byChat(b.chatId)
      if (r) {
        delete r.members[me]
        this.save()
      }
      return resp(method, { status: 0 })
    }
    if (method === 'WRITE') {
      return resp(method, this.write(me, b.chatId, b.msg, b.extra))
    }
    return resp(method, { status: 0 })
  }

  memberStruct(r, id) {
    const m = r.members[id]
    return {
      userId: L(id),
      type: 1000,
      nickName: m.nick,
      pli: Number(m.ptp) === 16 && m.pli ? L(m.pli) : undefined,
      mt: Number(m.mt),
      pi: m.photo ? m.photo + '?s=small' : '',
      opi: m.photo ? m.photo + '?s=orig' : '',
      statusMessage: m.status == null ? undefined : m.status,
    }
  }

  write(me, chatId, text, extra) {
    const logId = this.nextLog()
    const r = this.byChat(chatId)
    if (r) {
      r.sent.push({ at: Date.now(), user: str(me), text: String(text || ''), extra: extra ? String(extra) : '', logId })
      if (r.sent.length > 500) r.sent.splice(0, r.sent.length - 500)
      this.save()
    }
    return { status: 0, logId: L(logId), chatId: L(str(chatId)), sendAt: sec() }
  }

  // ── 푸시 ───────────────────────────────────────────────────────────────
  pushTo(userId, packet) {
    for (const c of this.clients) if (c.userId === str(userId)) c._dispatch(packet)
  }

  pushRoom(r, packet, exceptUser) {
    for (const id of Object.keys(r.members)) if (id !== exceptUser) this.pushTo(id, packet)
  }

  logRow(r, row) {
    r.msgs.push(row)
    if (r.msgs.length > 500) r.msgs.splice(0, r.msgs.length - 500)
  }

  /** 봇 권한을 바꾸고 SYNCMEMT + 피드 11(승격)/12(강등) 를 보낸다(9.4). */
  setPerm(chatId, botUserId, perm, dropOlu) {
    const r = this.byChat(chatId)
    if (!r || !r.members[str(botUserId)]) return { ok: false, error: 'not_in_room' }
    r.members[str(botUserId)].mt = Number(perm)
    r.dropOlu = !!dropOlu
    this.save()
    const bot = str(botUserId)
    this.pushTo(bot, resp('SYNCMEMT', { c: L(r.chatId), li: L(r.li), mids: [L(bot)], mts: [Number(perm)] }))
    const feedType = Number(perm) & 5 ? 11 : 12
    const logId = this.nextLog()
    const log = {
      logId: L(logId), chatId: L(r.chatId), authorId: L(bot), type: 0, sendAt: sec(),
      message: `{"feedType":${feedType},"members":[{"userId":${bot},"nickName":${JSON.stringify(r.members[bot].nick)}}]}`,
    }
    this.pushTo(bot, resp('MSG', { chatId: L(r.chatId), li: L(r.li), chatLog: log }))
    return { ok: true }
  }

  /** /v1/fake/event: kicked·deleted·join·leave·message·profile·kickout */
  event(chatId, botUserId, ev) {
    const r = this.byChat(chatId)
    const bot = str(botUserId)
    const kind = String(ev.kind || '')
    if (kind === 'kickout') {
      const reason = ev.reason == null ? 0 : Number(ev.reason)
      this.pushTo(bot, resp('KICKOUT', { reason }))
      return { ok: true }
    }
    if (!r) return { ok: false, error: 'no_room' }
    const at = sec()
    if (kind === 'kicked') {
      delete r.members[bot]
      if (!r.bans.includes(bot)) r.bans.push(bot)
      this.save()
      this.pushTo(bot, resp('LINKKICKED', {
        c: L(r.chatId), li: L(r.li),
        chatLog: { type: 0, message: `{"feedType":6,"members":[{"userId":${bot}}]}` },
      }))
      return { ok: true }
    }
    if (kind === 'unban') {
      r.bans = r.bans.filter((x) => x !== bot)
      this.save()
      return { ok: true }
    }
    if (kind === 'deleted') {
      r.deleted = true
      this.save()
      this.pushTo(bot, resp('LNKDELETED', { li: L(r.li) }))
      return { ok: true }
    }
    const uid = str(ev.user_id)
    const name = ev.name == null ? '' : String(ev.name)
    if (kind === 'profile') {
      if (!r.members[uid]) return { ok: false, error: 'not_member' }
      if (ev.name != null) r.members[uid].nick = name
      if (ev.photo != null) r.members[uid].photo = String(ev.photo)
      if (ev.status !== undefined) r.members[uid].status = ev.status
      if (ev.mt != null) r.members[uid].mt = Number(ev.mt)
      // 오픈프로필로 바꾸기(pli 있음 = ptp 16) / 빼기(pli '' = ptp 1)
      if (ev.pli !== undefined) Object.assign(r.members[uid], ev.pli ? { ptp: 16, pli: String(ev.pli) } : { ptp: 1, pli: null })
      this.save()
      return { ok: true }
    }
    const logId = ev.log_id ? String(ev.log_id) : this.nextLog()
    if (kind === 'join' || kind === 'leave') {
      if (kind === 'join') r.members[uid] = Object.assign({ mt: 2, photo: '', status: null }, r.members[uid] || {}, { nick: name || (r.members[uid] && r.members[uid].nick) || '' })
      else delete r.members[uid]
      this.save()
      // 큰 id 가 숫자로 뭉개지지 않게 JSON 을 글로 만든다(진짜 피드처럼 userId 는 숫자 칸)
      const who = `{"userId":${/^[1-9][0-9]*$/.test(uid) ? uid : 0},"nickName":${JSON.stringify(name)}}`
      const feed = kind === 'join' ? `{"feedType":4,"members":[${who}]}` : `{"feedType":2,"member":${who}}`
      const log = { logId: L(logId), chatId: L(r.chatId), authorId: L(uid || '1'), type: 0, message: feed, sendAt: ev.at ? Number(ev.at) : at }
      this.logRow(r, { logId, authorId: uid, type: 0, message: log.message, sendAt: log.sendAt, name })
      this.pushRoom(r, resp(kind === 'join' ? 'NEWMEM' : 'DELMEM', { chatId: L(r.chatId), chatLog: log }), uid)
      return { ok: true, log_id: logId }
    }
    if (kind === 'message') {
      if (uid && !r.members[uid]) r.members[uid] = { mt: 2, nick: name, photo: '', status: null }
      const type = ev.type == null ? 1 : Number(ev.type)
      const attachment = ev.attachment == null ? '' : (typeof ev.attachment === 'string' ? ev.attachment : JSON.stringify(ev.attachment))
      const log = { logId: L(logId), chatId: L(r.chatId), authorId: L(uid || '1'), type, message: String(ev.text || ''), attachment, sendAt: ev.at ? Number(ev.at) : at }
      this.logRow(r, { logId, authorId: uid, type, message: log.message, sendAt: log.sendAt, name })
      this.save()
      this.pushRoom(r, resp('MSG', { chatId: L(r.chatId), li: L(r.li), chatLog: log, authorNickname: name }), uid)
      return { ok: true, log_id: logId }
    }
    return { ok: false, error: 'bad_kind' }
  }

  sentIn(chatId) {
    const r = this.byChat(chatId)
    return r ? r.sent.slice() : []
  }

  roomByChat(chatId) {
    return this.byChat(chatId)
  }
}

let serverOne = null

export function fakeServer() {
  if (!serverOne) serverOne = new FakeServer()
  return serverOne
}

/** 시험이 같은 프로세스 안에서 새 가짜 서버를 쓸 때. */
export function resetFakeServer() {
  serverOne = new FakeServer()
  return serverOne
}

// ── 가짜 클라이언트 ─────────────────────────────────────────────────────────
class FakeSession {
  constructor(client) {
    this.client = client
  }

  getConnection() {
    const c = this.client
    if (!c.session) return null
    return { sendPacket: (method, body) => c.server.packet(c, method, body) }
  }

  send(method, body) {
    return this.client.server.packet(this.client, method, body)
  }

  getChatInfo(chatId) { return this.send('CHATONROOM', { chatId }) }
  getChannelInfo(chatId) { return this.send('CHATINFO', { chatId }) }
  getOpenLinkInfo(lis) { return this.send('INFOLINK', { lis }) }
  getAllMembers(chatId) { return this.send('GETMEM', { chatId }) }
  getMembersByIds(chatId, memberIds) { return this.send('MEMBER', { chatId, memberIds }) }
  leaveChat(chatId) { return this.send('LEAVE', { chatId }) }
  sendMessage(chatId, msg) { return this.send('WRITE', { chatId, msg, type: 1 }) }
}

function formatMember(m) {
  return {
    user_id: str(m.userId),
    nickname: m.nickName || '',
    profile_image_url: m.pi || null,
    full_profile_image_url: null,
    original_profile_image_url: m.opi || null,
    status_message: m.statusMessage == null ? null : String(m.statusMessage),
    country_iso: null,
    user_type: m.type == null ? null : Number(m.type),
    open_token: null,
    open_profile_link_id: m.pli ? str(m.pli) : null,
    open_permission: m.mt == null ? null : Number(m.mt),
  }
}

export class FakeKakaoClient {
  constructor(server) {
    this.server = server || fakeServer()
    this.userId = ''
    this.deviceUuid = ''
    this.oauthToken = null
    this.session = null
    this.closed = false
    this.pushHandlers = new Set()
    this.sessionHandlers = new Set()
  }

  async login(creds) {
    const c = creds || {}
    if (!c.oauthToken) throw Object.assign(new Error('OAuth token is required'), { code: 'missing_token' })
    this.oauthToken = String(c.oauthToken)
    this.userId = str(c.userId)
    this.deviceUuid = String(c.deviceUuid || '')
    this.deviceType = c.deviceType || 'tablet'
    return this
  }

  getCredentials() {
    return { oauthToken: this.oauthToken, userId: this.userId, deviceUuid: this.deviceUuid, deviceType: this.deviceType }
  }

  async acquireSession() {
    if (this.closed) throw Object.assign(new Error('Client is closed'), { code: 'client_closed' })
    if (!this.session) {
      if (/^fake-dead/.test(String(this.oauthToken))) {
        throw Object.assign(new Error('invalid token'), { code: 'invalid_access_token' })
      }
      this.session = new FakeSession(this)
      this.server.clients.add(this)
      this.server.logins[this.userId] = (this.server.logins[this.userId] || 0) + 1
      this.emit({ type: 'connected', userId: this.userId })
    }
    return this.session
  }

  onPush(handler) {
    this.pushHandlers.add(handler)
    return () => this.pushHandlers.delete(handler)
  }

  onSessionEvent(handler) {
    this.sessionHandlers.add(handler)
    return () => this.sessionHandlers.delete(handler)
  }

  emit(ev) {
    for (const h of this.sessionHandlers) {
      try { h(ev) } catch { /* 진짜 클라이언트처럼 삼킨다 */ }
    }
  }

  isConnected() {
    return !!this.session && !this.closed
  }

  // agent-messenger 의 dispatchPush 를 patch-kakao 가 고친 모양 그대로: KICKOUT 은 세션 이벤트(reason 포함)로.
  _dispatch(packet) {
    if (!this.session) return
    if (packet.method === 'KICKOUT') {
      const reason = packet.body && typeof packet.body.reason === 'number' ? packet.body.reason : null
      this.session = null
      this.server.clients.delete(this)
      this.emit({ type: 'kicked', reason: reason == null ? 'Session kicked — another device logged in' : reason, message: 'Session kicked' })
      return
    }
    for (const h of this.pushHandlers) {
      try { h(packet) } catch { /* 진짜 클라이언트처럼 삼킨다 */ }
    }
  }

  async executeWithReconnect(op) {
    const session = await this.acquireSession()
    return op({ session, loginResult: { chatDatas: [] } })
  }

  close() {
    this.closed = true
    this.session = null
    this.server.clients.delete(this)
    this.closeCount = (this.closeCount || 0) + 1
  }

  lookupAuthorName() {
    return null
  }

  async getProfile() {
    await this.acquireSession()
    const u = this.server.user(this.userId)
    return { user_id: this.userId, nickname: u.nick, status_message: null, profile_image_url: null }
  }

  async getChats() {
    await this.acquireSession()
    const out = []
    for (const r of Object.values(this.server.rooms)) {
      if (!r.members[this.userId]) continue
      out.push({
        chat_id: r.chatId, type: 'OM', display_name: null, title: null, link_id: r.li,
        active_members: Object.keys(r.members).length, unread_count: 0, last_message: null,
      })
    }
    if (!this.server.user(this.userId).bot) {
      for (const c of CUSTOMER_ROOMS) {
        out.push({
          chat_id: c.chat_id, type: 'OM', display_name: '가, 나', title: null, link_id: c.link_id,
          active_members: c.members, unread_count: 0, last_message: null,
        })
      }
    }
    return out
  }

  async getChat(chatId) {
    await this.acquireSession()
    const r = this.server.byChat(chatId)
    if (!r || !r.members[this.userId]) {
      throw Object.assign(new Error('CHATINFO response missing chatInfo'), {
        code: 'get_chat_failed', getChatFailureReason: 'chat_info_absent',
      })
    }
    return {
      chat_id: r.chatId, type: 'OM', display_name: null, title: r.ln, link_id: r.li,
      active_members: Object.keys(r.members).length, unread_count: 0, last_message: null,
    }
  }

  async getMembersByIds(chatId, userIds) {
    const s = await this.acquireSession()
    const res = await s.getMembersByIds(L(str(chatId)), (userIds || []).map((x) => L(str(x))))
    if (res.statusCode !== 0 || (res.body && res.body.status)) {
      throw Object.assign(new Error('MEMBER failed'), { code: 'get_members_failed' })
    }
    return (res.body.members || []).map(formatMember)
  }

  async getMembers(chatId) {
    const s = await this.acquireSession()
    const res = await s.getAllMembers(L(str(chatId)))
    return ((res.body && res.body.members) || []).map(formatMember)
  }

  async getMemberSnapshot(chatId) {
    const members = await this.getMembers(chatId)
    return { chat_id: str(chatId), active_members: members.length, members, complete: true }
  }

  async sendMessage(chatId, text) {
    await this.acquireSession()
    const r = this.server.write(this.userId, chatId, text, '')
    return { success: true, status_code: 0, chat_id: str(chatId), log_id: str(r.logId), sent_at: r.sendAt }
  }

  async sendPhoto(chatId) {
    return this.sendMessage(chatId, '(사진)')
  }

  async sendMultiPhoto(chatId) {
    return this.sendMessage(chatId, '(사진 여러 장)')
  }

  async sendTyping() {
    return { success: true }
  }

  async markRead() {
    return { success: true }
  }

  async getMessages(chatId, options) {
    await this.acquireSession()
    const r = this.server.byChat(chatId)
    const n = Math.max(1, Number(options && options.count) || 20)
    const list = r ? r.msgs.slice(-n) : []
    return list.map((m) => ({
      log_id: m.logId, type: m.type, author_id: Number(m.authorId) || 0, author_name: m.name || null,
      message: m.message, attachment: null, sent_at: m.sendAt,
    }))
  }

  async getMessagePage(chatId, options) {
    const msgs = await this.getMessages(chatId, { count: Number(options && options.count) || 40 })
    return { messages: msgs, next_cursor: null, complete: true }
  }

  async leaveChat(chatId) {
    const s = await this.acquireSession()
    await s.leaveChat(L(str(chatId)))
    return { success: true, status_code: 0, chat_id: str(chatId) }
  }
}

// ── 가짜 등록(9.4) ──────────────────────────────────────────────────────────
// 이메일에 'phone' 이 있으면 confirm_on_phone(인증번호 4829, 300초) 뒤 confirm 에서 ok, 비밀번호 'wrong' 이면
// bad_credentials, 그 밖에는 바로 ok. FAKE_CONFIRM_MS 만큼 confirm 을 늦출 수 있다(관리자 20초 시험용).
const fakePending = new Map()

function fakeCreds(deviceId) {
  return {
    access_token: 'fake-' + randomBytes(12).toString('hex'),
    refresh_token: 'fake-r-' + randomBytes(8).toString('hex'),
    user_id: fakeUserId(deviceId),
    device_uuid: 'fake-' + randomBytes(16).toString('hex'),
    device_type: 'tablet',
  }
}

export function fakeBegin(input) {
  const deviceId = String(input.device_id || '')
  const email = String(input.email || '')
  const password = String(input.password || '')
  const tablet = { device_name: 'Galaxy Tab S9', device_model: 'SM-X710' }
  if (password === 'wrong') {
    return { result: Object.assign({ state: 'bad_credentials', message: '이메일 또는 비밀번호가 맞지 않습니다.', status: -100 }, tablet) }
  }
  const user = fakeServer().user(fakeUserId(deviceId))
  if (/^bot\./.test(deviceId)) {
    user.bot = true
    fakeServer().save()
  }
  if (email.includes('phone')) {
    const pendingId = randomBytes(12).toString('hex')
    fakePending.set(pendingId, { deviceId, email, at: Date.now() })
    setTimeout(() => fakePending.delete(pendingId), 15 * 60 * 1000).unref()
    return {
      result: Object.assign({ state: 'confirm_on_phone', pending_id: pendingId, passcode: '4829', remaining_seconds: 300 }, tablet),
    }
  }
  return { result: Object.assign({ state: 'ok' }, tablet), credentials: fakeCreds(deviceId), deviceId, email }
}

// 실제처럼 첫 확인(FAKE_CONFIRM_WAITS 번, 기본 1번)은 '아직 휴대폰에서 확인 전'인 waiting 이다.
// 끝난 결과는 실제 sender 처럼 대기 시간 동안 남아, 늦게 온 확인도 같은 ok 를 받는다.
export async function fakeConfirm(input) {
  const id = String(input.pending_id || '')
  const row = fakePending.get(id)
  if (!row) return { result: { state: 'expired', reason: 'unknown_pending' } }
  if (row.result) return { result: row.result }
  const waits = process.env.FAKE_CONFIRM_WAITS == null ? 1 : (Number(process.env.FAKE_CONFIRM_WAITS) || 0)
  row.seen = (row.seen || 0) + 1
  if (row.seen <= waits) return { result: { state: 'waiting' } }
  const wait = Number(process.env.FAKE_CONFIRM_MS) || 0
  if (wait > 0) await new Promise((ok) => setTimeout(ok, wait))
  row.result = { state: 'ok', device_name: 'Galaxy Tab S9', device_model: 'SM-X710' }
  return {
    result: row.result,
    credentials: fakeCreds(row.deviceId),
    deviceId: row.deviceId,
    email: row.email,
  }
}

export function fakeCancel(pendingId) {
  fakePending.delete(String(pendingId || ''))
}

// ── 메모리 저장소(selfcheck 전용, DB 없이 botpool 을 돌린다) ─────────────────
// lib/db.js 의 room_installs 부분 UNIQUE 를 흉내 낸다: installed 이고 kicked 가 아닌 행끼리 link_id·link_url 이 겹치면 23505.
export class MemStore {
  constructor() {
    this.installs = new Map()
    this.members = new Map()
    this.leaves = []
    this.logs = []
    this.states = new Map()
    this.roomMembers = new Map()   // install_id → Map(user_id → 방 멤버 명부 행)
    this.bots = new Map()
    this.blocks = []
    this.records = new Map()
    this.senderOwner = null       // 배포 겹침 울타리 한 줄(owner.mjs)
    this.seq = 0
  }

  addMember(id, blocked) {
    this.members.set(Number(id), { id: Number(id), blocked_reason: blocked || null })
  }

  addInstall(row) {
    const id = row.id || ++this.seq
    const full = Object.assign({
      id, member_id: 1, link_url: '', link_id: null, link_name: null, passcode_ct: null, roombot: false, minigame: false,
      phase: 'installed', order_id: null, bot_device_id: null, hold_reason: null, retry_n: 0, state: 'queued',
      error_code: null, error_detail: null, chat_id: null, perm: null, perm_at: null, joined_at: null, state_at: null,
      next_try_at: null, retry_at: null, attempts: 0, config: {}, config_rev: 0, created_at: Date.now(),
    }, row, { id })
    this.installs.set(id, full)
    if (!this.members.has(Number(full.member_id))) this.addMember(full.member_id)
    return full
  }

  withMember(r) {
    const m = this.members.get(Number(r.member_id))
    return Object.assign({}, r, { member_blocked: m ? m.blocked_reason : null })
  }

  async listInstalls(botIds) {
    return [...this.installs.values()].filter((r) => r.phase === 'installed' && botIds.includes(r.bot_device_id)).map((r) => this.withMember(r))
  }

  async getInstall(id) {
    const r = this.installs.get(Number(id))
    return r ? this.withMember(r) : null
  }

  async listLeaves(botIds) {
    return this.leaves.filter((l) => !l.done_at && botIds.includes(l.bot_device_id)).map((l) => Object.assign({}, l))
  }

  async finishLeave(id, botId, result, done) {
    const l = this.leaves.find((x) => x.id === id && x.bot_device_id === botId)
    if (!l) return
    l.result = result
    if (done) l.done_at = Date.now()
  }

  exclusive(r) {
    return r.phase === 'installed' && r.error_code !== 'kicked'
  }

  async updateInstall(id, botId, fields) {
    const r = this.installs.get(Number(id))
    if (!r || r.phase !== 'installed' || r.bot_device_id !== botId) return 0
    const next = Object.assign({}, r)
    for (const [k, v] of Object.entries(fields || {})) {
      if (k === 'attempts') next.attempts = (Number(next.attempts) || 0) + 1
      else next[k] = v === undefined ? null : v
    }
    if (this.exclusive(next)) {
      for (const o of this.installs.values()) {
        if (o.id === next.id || !this.exclusive(o)) continue
        if ((next.link_id && o.link_id === next.link_id) || (next.link_url && o.link_url === next.link_url)) {
          throw Object.assign(new Error('duplicate key value violates unique constraint'), { code: '23505' })
        }
      }
    }
    this.installs.set(next.id, next)
    return 1
  }

  async markBotRooms(botId, now) {
    let n = 0
    for (const r of this.installs.values()) {
      if (r.bot_device_id === botId && r.phase === 'installed' && r.state !== 'error') {
        Object.assign(r, { state: 'error', error_code: 'bot_down', error_detail: null, state_at: now })
        n++
      }
    }
    return n
  }

  async isBlocked(linkId, linkUrl) {
    return this.blocks.some((b) => (linkId && b.link_id === linkId) || (linkUrl && b.link_url === linkUrl))
  }

  async roomLog(installId, kind, row) {
    const x = row || {}
    this.logs.push({ install_id: Number(installId), at: Number(x.at) || Date.now(), kind, user_id: x.user_id || null, name: x.name || null, ok: x.ok !== false, detail: x.detail || {} })
  }

  async kickHistory(installId, userId) {
    const rows = this.logs.filter((l) => l.install_id === Number(installId) && l.user_id === String(userId) && (l.kind === 'kick' || l.kind === 'kick_fail'))
    return { any: rows.length > 0, kicked: rows.some((l) => l.kind === 'kick' && l.ok) }
  }

  async loadRoomState(installId) {
    const s = this.states.get(Number(installId))
    return s ? JSON.parse(JSON.stringify(s)) : null
  }

  async saveRoomState(installId, runtime) {
    this.states.set(Number(installId), JSON.parse(JSON.stringify(runtime || {})))
  }

  async loadMembers(installId, chatId, since) {
    const m = this.roomMembers.get(Number(installId))
    if (!m) return []
    return [...m.values()].filter((r) => r.chat_id === String(chatId || '') && Number(r.seen_at) >= (Number(since) || 0)).map((r) => Object.assign({}, r))
  }

  async saveMembers(installId, chatId, rows) {
    const id = Number(installId)
    if (!this.roomMembers.has(id)) this.roomMembers.set(id, new Map())
    const m = this.roomMembers.get(id)
    for (const r of rows || []) m.set(String(r.user_id), Object.assign({ chat_id: String(chatId || '') }, r))
  }

  async botState(botId, fields) {
    const b = this.bots.get(botId) || { device_id: botId }
    if (fields.state) b.state = fields.state
    if (fields.nickname) b.nickname = fields.nickname
    b.state_at = Date.now()
    this.bots.set(botId, b)
  }

  async botNickname(botId) {
    const b = this.bots.get(botId)
    return b && b.nickname ? b.nickname : ''
  }

  async ensureBotAccount(botId, email) {
    if (!this.bots.has(botId)) this.bots.set(botId, { device_id: botId, email, state: 'connected' })
  }

  async botProfileRows(botIds) {
    return botIds.filter((id) => this.bots.has(id)).map((id) => {
      const b = this.bots.get(id)
      return {
        device_id: id,
        open_profiles: b.open_profiles == null ? null : JSON.parse(JSON.stringify(b.open_profiles)),
        open_profile_pick: b.open_profile_pick || null,
        open_profile_li: b.open_profile_li || null,
        open_profile_name: b.open_profile_name || null,
        open_profile_at: b.open_profile_at || null,
      }
    })
  }

  async botOpenProfile(botId, f) {
    const b = this.bots.get(botId) || { device_id: botId }
    if (f && Array.isArray(f.list)) b.open_profiles = JSON.parse(JSON.stringify(f.list))
    if (f && f.li !== undefined) b.open_profile_li = f.li || null
    if (f && f.name !== undefined) b.open_profile_name = f.name || null
    if (f && f.at) b.open_profile_at = Number(f.at)
    this.bots.set(botId, b)
  }

  async saveRecord(id, record) {
    this.records.set(id, JSON.parse(JSON.stringify(record)))
  }

  // 배포 겹침 울타리(owner.mjs) — store.mjs 의 sender_owner 한 줄과 같은 규칙
  async claimOwner(boot, since, now, staleBefore) {
    const cur = this.senderOwner
    if (cur && !(cur.since <= since || cur.beat < staleBefore)) return false
    this.senderOwner = { boot, since, beat: now }
    return true
  }

  async ownerBeat(boot, now) {
    if (!this.senderOwner || this.senderOwner.boot !== boot) return false
    this.senderOwner.beat = now
    return true
  }

  async ownerRow() {
    return this.senderOwner ? Object.assign({}, this.senderOwner) : null
  }

  async restoreLogin(id, record) {
    const cur = this.records.get(id)
    const c = record && record.credentials
    if (!cur || !cur.needs_register || !c || !c.access_token) return false
    cur.credentials = JSON.parse(JSON.stringify(c))
    cur.needs_register = false
    cur.reason = 'ok'
    return true
  }
}
