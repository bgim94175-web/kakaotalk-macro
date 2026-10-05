import { webcrypto } from 'node:crypto'

import { Long } from 'bson'
import {
  KakaoTalkClient,
  KakaoTalkListener,
  classifyKakaoChat,
  refreshKakaoOAuthToken,
} from 'agent-messenger/kakaotalk'

import {
  guardCanStopKicks,
  guardDue,
  guardFinishHalt,
  guardNotices,
  guardOnChat,
  macroMinMessages,
  macroNotifyReply,
  macroRoomsDue,
  noteMacroRetry,
  noteMacroSent,
  noteMacroWait,
  onInbound,
  othersSinceMine,
  chatLogsFromBody,
  realId,
  visitEventsFromMessage,
  visitMentionExtra,
  visitNeedsProfile,
} from './features.mjs'
import { openMultiCandidate, roomListKind, roomTitle, stampOpenLinkTitles } from './room-kind.mjs'
import { listIds, loadRecord, saveRecord } from './store.mjs'

if (!globalThis.crypto) globalThis.crypto = webcrypto

const DEAD = new Set(['invalid_access_token', 'login_rejected', 'kicked', 'reauth'])

function log(id, msg) {
  process.stderr.write(`[sender] ${id} ${msg}\n`)
}

function chatLinkId(ch) {
  const v = ch && (ch.link_id || ch.li)
  const s = v == null ? '' : String(v).trim()
  return /^[1-9][0-9]*$/.test(s) ? s : ''
}

function olName(ol) {
  if (!ol || typeof ol !== 'object') return ''
  if (typeof ol.ln === 'string' && ol.ln.trim()) return ol.ln.trim()
  const moim = ol.omt || ol.moim
  if (typeof moim === 'string' && moim.trim()) return moim.trim()
  if (moim && typeof moim === 'object') {
    const inner = moim.name || moim.title || moim.ln
    if (typeof inner === 'string' && inner.trim()) return inner.trim()
  }
  return ''
}

function olLinkKey(ol) {
  if (!ol || typeof ol !== 'object' || ol.li == null) return ''
  const v = ol.li
  if (typeof v === 'string' && /^[1-9][0-9]*$/.test(v.trim())) return v.trim()
  if (typeof v === 'number' && Number.isSafeInteger(v) && v > 0) return String(v)
  if (typeof v === 'bigint' && v > 0n) return v.toString()
  if (typeof v.toString === 'function') {
    const s = v.toString()
    if (/^[1-9][0-9]*$/.test(s)) return s
  }
  return ''
}

// One INFOLINK for the open multi chats. Per-room CHATINFO made 대화방 불러오기
// stall until the browser dropped it, and a missing ln dropped every row.
async function openLinkNames(client, list) {
  const names = new Map()
  const ids = []
  const seen = new Set()
  for (const ch of list || []) {
    if (!openMultiCandidate(ch)) continue
    const id = chatLinkId(ch)
    if (!id || seen.has(id)) continue
    seen.add(id)
    ids.push(id)
  }
  if (!ids.length || !client || typeof client.acquireSession !== 'function') return names
  let session
  try {
    session = await client.acquireSession()
  } catch {
    return names
  }
  for (let i = 0; i < ids.length; i += 20) {
    const part = ids.slice(i, i + 20)
    let body = null
    try {
      const response = await session.getOpenLinkInfo(part.map((id) => Long.fromString(id)))
      body = response && response.body
    } catch {
      body = null
    }
    const ols = body && Array.isArray(body.ols) ? body.ols : []
    for (let j = 0; j < part.length; j++) {
      const ol = ols[j]
      const name = olName(ol)
      if (!name) continue
      const key = olLinkKey(ol)
      if (key) names.set(key, name)
      else names.set(part[j], name)
    }
  }
  return names
}

function idText(v) {
  if (v == null || v === '') return ''
  if (typeof v === 'string' && /^[1-9][0-9]*$/.test(v.trim())) return v.trim()
  if (typeof v === 'number' && Number.isSafeInteger(v) && v > 0) return String(v)
  if (typeof v === 'bigint' && v > 0n) return v.toString()
  if (typeof v === 'object' && typeof v.toString === 'function') {
    const s = v.toString()
    if (/^[1-9][0-9]*$/.test(s)) return s
  }
  return ''
}

function logAfter(id, cursor) {
  if (!id) return false
  if (!cursor) return true
  try {
    return BigInt(id) > BigInt(cursor)
  } catch {
    return id > cursor
  }
}

function realLogId(v) {
  if (typeof v === 'bigint') v = v.toString()
  else if (typeof v === 'number' && Number.isFinite(v) && v === Math.trunc(v)) v = String(v)
  if (typeof v !== 'string') return ''
  const s = v.trim()
  return /^[1-9][0-9]*$/.test(s) ? s : ''
}

function credsOf(record) {
  const c = record.credentials || {}
  return {
    access_token: String(c.access_token || ''),
    refresh_token: String(c.refresh_token || ''),
    user_id: String(c.user_id || ''),
    device_uuid: String(c.device_uuid || ''),
    device_type: c.device_type === 'pc' ? 'pc' : 'tablet',
  }
}

export class Hub {
  constructor() {
    this.accounts = new Map()
  }

  async boot() {
    const ids = await listIds()
    for (const id of ids) {
      try {
        const rec = await loadRecord(id)
        if (!rec || rec.needs_register) continue
        if (!credsOf(rec).access_token) continue
        await this.attach(id, rec)
      } catch (e) {
        log(id, `boot skipped: ${e && e.message ? e.message : e}`)
      }
    }
  }

  status(id) {
    const slot = this.accounts.get(id)
    if (!slot) return { linked: false, needs_register: false, reason: 'absent', connected: false }
    return {
      linked: !slot.record.needs_register,
      needs_register: !!slot.record.needs_register,
      reason: slot.record.reason || (slot.record.needs_register ? 'reauth' : 'ok'),
      notices: guardNotices(slot.record),
      connected: socketUp(slot),
    }
  }

  async upsert(id, body) {
    const prev = await loadRecord(id)
    const creds = credsOf({ credentials: body.credentials || (prev && prev.credentials) })
    if (!creds.access_token || !creds.user_id || !creds.device_uuid) {
      const err = new Error('incomplete credentials')
      err.status = 400
      throw err
    }
    const record = {
      device_id: id,
      credentials: creds,
      config: body.config || (prev && prev.config) || {},
      rooms: Array.isArray(body.rooms) ? body.rooms : (prev && prev.rooms) || [],
      features: body.features || (prev && prev.features) || { macro: true, roombot: true, minigame: true },
      images: Array.isArray(body.images) ? body.images : (prev && prev.images) || [],
      runtime: (prev && prev.runtime) || {},
      needs_register: false,
      reason: 'ok',
    }
    if (body.config && prev && prev.runtime) record.runtime = prev.runtime
    await this.attach(id, record)
    return this.status(id)
  }

  async updateConfig(id, body) {
    const slot = this.accounts.get(id)
    const prev = slot ? slot.record : await loadRecord(id)
    if (!prev || !prev.credentials) {
      const err = new Error('not registered')
      err.status = 404
      throw err
    }
    if (body.config) prev.config = body.config
    if (Array.isArray(body.rooms)) prev.rooms = body.rooms
    if (body.features) prev.features = body.features
    if (Array.isArray(body.images)) prev.images = body.images
    await saveRecord(id, prev)
    if (!slot && !prev.needs_register) await this.attach(id, prev)
    return this.status(id)
  }

  async unlink(id) {
    const slot = this.accounts.get(id)
    if (slot) await slot.stop()
    this.accounts.delete(id)
    const prev = await loadRecord(id)
    if (prev) {
      prev.credentials = {}
      prev.images = []
      prev.needs_register = false
      prev.reason = 'unlinked'
      await saveRecord(id, prev)
    }
  }

  async chats(id) {
    const slot = this.requireLive(id)
    const list = await slot.client.getChats({ all: true })
    const names = await openLinkNames(slot.client, list)
    const stamped = stampOpenLinkTitles(list, names)
    return stamped.map((ch) => {
      const listKind = roomListKind(ch)
      const title = listKind === 'open_room' ? (roomTitle(ch) || null) : (ch.title || null)
      return {
        chat_id: String(ch.chat_id),
        kind: classifyKakaoChat(ch),
        type: ch.type,
        list_kind: listKind,
        title: title,
        display_name: listKind === 'open_room' ? null : (ch.display_name || null),
        members: ch.active_members,
        last_at: ch.last_message ? ch.last_message.sent_at : 0,
      }
    })
  }

  async recent(id, chatId) {
    const slot = this.requireLive(id)
    const msgs = await slot.client.getMessages(chatId, { count: 20 })
    const self = credsOf(slot.record).user_id
    const out = []
    for (const m of msgs || []) {
      const logId = realLogId(m && m.log_id)
      if (!logId) continue
      const authorId = m.author_id == null ? '' : String(m.author_id)
      out.push({
        log_id: logId,
        message: typeof m.message === 'string' ? m.message : '',
        mine: self.length > 0 && authorId === self,
        sent_at: m.sent_at || 0,
      })
    }
    return out
  }

  async sendText(id, chatId, text) {
    const slot = this.requireLive(id)
    const res = await slot.client.sendMessage(chatId, text)
    const logId = realLogId(res && res.log_id)
    if (!res || res.success !== true || !logId) {
      const err = new Error('undelivered')
      err.status = 502
      throw err
    }
    return { log_id: logId, kind: 'text' }
  }

  async sendImages(id, chatId, images) {
    const slot = this.requireLive(id)
    const photos = images.map((buf, i) => ({ data: buf, filename: `photo-${i + 1}.jpg` }))
    await slot.client.acquireSession()
    const res = photos.length === 1
      ? await slot.client.sendPhoto(chatId, photos[0].data, photos[0].filename)
      : await slot.client.sendMultiPhoto(chatId, photos)
    const logId = realLogId(res && res.log_id)
    if (!res || res.success !== true || !logId) {
      const err = new Error('undelivered')
      err.status = 502
      throw err
    }
    return { log_id: logId, kind: photos.length === 1 ? 'photo' : 'multiphoto' }
  }

  requireLive(id) {
    const slot = this.accounts.get(id)
    if (!slot || slot.record.needs_register) {
      const err = new Error(slot && slot.record.reason ? slot.record.reason : 'needs_register')
      err.status = 409
      err.needs_register = true
      throw err
    }
    return slot
  }

  async attach(id, record) {
    let slot = this.accounts.get(id)
    const creds = credsOf(record)
    const same = slot && credsOf(slot.record).access_token === creds.access_token
      && credsOf(slot.record).device_uuid === creds.device_uuid
    if (slot && !same) {
      await slot.stop()
      slot = null
    }
    if (!slot) {
      slot = new Slot(id, record)
      this.accounts.set(id, slot)
      await slot.start()
    } else {
      slot.record = record
      await saveRecord(id, record)
    }
  }
}

class Slot {
  constructor(id, record) {
    this.id = id
    this.record = record
    this.client = null
    this.listener = null
    this.timer = null
    this.stopped = false
    this.chain = Promise.resolve()
    this.refreshed = false
    this.linkIds = new Map()
    this.lastLog = new Map()
    this.profileLinks = new Map()
    this.visitCursor = new Map()
    this.visitEntered = new Set()
    this.visitLogs = new Set()
    this.unpush = null
  }

  async start() {
    await saveRecord(this.id, this.record)
    this.timer = setInterval(() => {
      this.enqueue(async () => {
        await this.ensure()
        await this.macroTick()
        await this.guardTick()
        await this.visitScan()
      }).catch((e) => log(this.id, e && e.message ? e.message : e))
    }, 20000)
    if (this.timer.unref) this.timer.unref()
    this.enqueue(() => this.ensure()).catch((e) => log(this.id, e && e.message ? e.message : e))
  }

  async ensure() {
    if (this.stopped || this.record.needs_register) return
    if (!this.client || !this.client.isConnected()) {
      if (this.listener) {
        try { this.listener.stop() } catch {}
        this.listener = null
      }
      await this.open()
    }
    if (!this.client || this.record.needs_register || this.listener) return
    this.listener = new KakaoTalkListener(this.client)
    this.listener.on('message', (ev) => {
      this.enqueue(() => this.onMessage(ev)).catch((e) => log(this.id, e && e.message ? e.message : e))
    })
    this.listener.on('member_joined', (ev) => {
      this.enqueue(() => this.onMember('join', ev)).catch((e) => log(this.id, e && e.message ? e.message : e))
    })
    this.listener.on('member_left', (ev) => {
      this.enqueue(() => this.onMember('leave', ev)).catch((e) => log(this.id, e && e.message ? e.message : e))
    })
    this.listener.on('kakaotalk_event', (ev) => {
      this.noteLink(ev)
    })
    this.listener.on('error', (err) => {
      this.enqueue(() => this.onError(err)).catch(() => {})
    })
    this.listener.on('disconnected', () => {
      if (!this.stopped && !this.record.needs_register) {
        this.listener = null
        this.enqueue(() => this.ensure()).catch(() => {})
      }
    })
    await this.listener.start()
    this.enqueue(() => this.visitScan()).catch(() => {})
  }

  async stop() {
    this.stopped = true
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    if (this.unpush) {
      try { this.unpush() } catch {}
      this.unpush = null
    }
    try { this.listener && this.listener.stop() } catch {}
    try { this.client && this.client.close() } catch {}
    this.listener = null
    this.client = null
  }

  enqueue(fn) {
    const run = this.chain.then(fn, fn)
    this.chain = run.then(() => {}, () => {})
    return run
  }

  async open() {
    if (this.stopped || this.record.needs_register) return
    const creds = credsOf(this.record)
    try {
      if (this.client) {
        try { this.client.close() } catch {}
      }
      const client = new KakaoTalkClient()
      await client.login({
        oauthToken: creds.access_token,
        userId: creds.user_id,
        deviceUuid: creds.device_uuid,
        deviceType: creds.device_type,
      })
      client.onSessionEvent((ev) => {
        if (ev && ev.type === 'kicked') {
          this.markDead('kicked').catch(() => {})
        }
      })
      await client.acquireSession()
      if (this.unpush) {
        try { this.unpush() } catch {}
        this.unpush = null
      }
      // The listener only emits message for method MSG. Open-chat feed lines
      // also arrive on other packets, and a throw in that handler is dropped.
      this.unpush = client.onPush((packet) => {
        this.enqueue(() => this.onPacket(packet)).catch(() => {})
      })
      this.visitEntered.clear()
      this.client = client
      this.refreshed = false
      this.record.needs_register = false
      this.record.reason = 'ok'
    } catch (e) {
      const code = e && e.code
      if (code === 'invalid_access_token' && !this.refreshed) {
        const ok = await this.refresh()
        if (ok) return this.open()
      }
      if (DEAD.has(code) || code === 'invalid_access_token' || code === 'login_rejected') {
        await this.markDead(code || 'reauth')
        return
      }
      log(this.id, `session open failed: ${code || ''} ${e && e.message ? e.message : e}`)
    }
  }

  async refresh() {
    this.refreshed = true
    const creds = credsOf(this.record)
    try {
      const r = await refreshKakaoOAuthToken({
        accessToken: creds.access_token,
        refreshToken: creds.refresh_token,
        deviceUuid: creds.device_uuid,
      })
      this.record.credentials.access_token = r.accessToken
      this.record.credentials.refresh_token = r.refreshToken
      await saveRecord(this.id, this.record)
      return true
    } catch (e) {
      log(this.id, `token refresh failed: ${e && e.code ? e.code : e}`)
      return false
    }
  }

  async markDead(reason) {
    this.record.needs_register = true
    this.record.reason = reason || 'reauth'
    this.record.credentials = {
      access_token: '',
      refresh_token: '',
      user_id: credsUser(this.record),
      device_uuid: '',
      device_type: 'tablet',
    }
    await saveRecord(this.id, this.record)
    log(this.id, `session ended: ${this.record.reason}`)
    await this.stop()
  }

  async onError(err) {
    const code = err && err.code
    if (code === 'invalid_access_token' && !this.refreshed) {
      if (await this.refresh()) {
        await this.open()
        return
      }
    }
    if (code === 'invalid_access_token' || code === 'login_rejected' || (err && /kicked/i.test(String(err.message || '')))) {
      await this.markDead(code || 'kicked')
    }
  }

  async onMessage(ev) {
    if (this.record.needs_register || !ev) return
    const creds = credsOf(this.record)
    const chatId = String(ev.chat_id || '')
    const author = ev.author_id == null ? '' : String(ev.author_id)
    if (ev.log_id) this.lastLog.set(chatId, String(ev.log_id))
    const taken = await this.takeVisit(chatId, {
      chatId,
      logId: ev.log_id ? String(ev.log_id) : '',
      message: ev.message,
      type: ev.message_type,
      authorId: ev.author_id,
      attachment: ev.attachment,
    })
    if (taken) return
    const sends = onInbound(this.record, {
      chatId,
      text: ev.message || '',
      authorName: ev.author_name || '',
      mine: author.length > 0 && author === creds.user_id,
    })
    const guard = guardOnChat(this.record, {
      kind: 'msg',
      chatId,
      text: ev.message || '',
      authorId: author,
      mine: author.length > 0 && author === creds.user_id,
      messageType: ev.message_type,
      now: Date.now(),
    })
    await saveRecord(this.id, this.record)
    for (const s of sends) await this.deliver(s)
    await this.finishGuard(guard)
  }

  async onMember(kind, ev) {
    if (this.record.needs_register || !ev) return
    const creds = credsOf(this.record)
    const chatId = String(ev.chat_id || '')
    let author = memberId(ev.member)
    let authorName = typeof ev.author_name === 'string' ? ev.author_name.trim() : ''
    if (!author && authorName && this.client && visitNeedsProfile(this.record, chatId)) {
      try {
        author = await this.memberIdByName(chatId, authorName)
      } catch (e) {
        await this.onError(e)
      }
    }
    if (this.record.needs_register) return
    let mine = author.length > 0 && author === creds.user_id
    let profileLink = ''
    if (!mine && this.client && visitNeedsProfile(this.record, chatId) && (author || authorName)) {
      try {
        let card = author ? await this.memberCard(chatId, author) : { name: '', link: '', userId: '' }
        if (!card.userId && authorName) {
          const found = await this.memberIdByName(chatId, authorName)
          if (found) {
            author = found
            card = await this.memberCard(chatId, found)
          }
        }
        if (card.userId) author = card.userId
        if (card.name) authorName = card.name
        profileLink = card.link
        mine = author.length > 0 && author === creds.user_id
      } catch (e) {
        await this.onError(e)
      }
    }
    if (this.record.needs_register) return
    const guard = guardOnChat(this.record, {
      kind,
      chatId,
      text: '',
      authorId: author,
      authorName,
      profileLink,
      mine,
      now: Date.now(),
    })
    await this.finishGuard(guard)
  }

  async memberIdByName(chatId, nickname) {
    const want = String(nickname || '').trim()
    if (!want || !this.client) return ''
    const body = await this.client.executeWithReconnect(async ({ session }) => {
      const response = await session.getAllMembers(Long.fromString(String(chatId)))
      return response && response.body
    })
    const members = body && Array.isArray(body.members) ? body.members : []
    const ids = []
    for (const m of members) {
      if (!m || typeof m !== 'object') continue
      const name = String(m.nickName || m.nickname || m.nn || '').trim()
      if (name !== want) continue
      const id = idText(m.userId)
      if (id && !ids.includes(id)) ids.push(id)
    }
    return ids.length === 1 ? ids[0] : ''
  }

  async memberCard(chatId, userId) {
    if (!this.client || !userId) return { name: '', link: '', userId: '' }
    const members = await this.client.getMembersByIds(chatId, [userId])
    const row = (members || []).find((m) => m && String(m.user_id) === String(userId))
    if (!row) return { name: '', link: '', userId: '' }
    const name = String(row.nickname || '').trim()
    const pli = row.open_profile_link_id ? String(row.open_profile_link_id) : ''
    const link = pli ? await this.openProfileLink(pli) : ''
    const memberUserId = /^[1-9][0-9]*$/.test(String(row.user_id || '')) ? String(row.user_id) : ''
    return { name, link, userId: memberUserId }
  }

  async openProfileLink(linkId) {
    const id = String(linkId || '').trim()
    if (!/^[1-9][0-9]*$/.test(id)) return ''
    const cached = this.profileLinks.get(id)
    if (cached) return cached
    const body = await this.client.executeWithReconnect(async ({ session }) => {
      const response = await session.getOpenLinkInfo([Long.fromString(id)])
      return response && response.body
    })
    const link = linkFromOpenInfo(body)
    if (link) this.profileLinks.set(id, link)
    return link
  }

  async finishGuard(guard) {
    if (!guard || !guard.active) return
    for (const s of guard.sends || []) await this.deliver(s)
    if (guard.askHalt) await this.stopKickWave(guard.askHalt)
    await saveRecord(this.id, this.record)
  }

  async stopKickWave(ask) {
    let allowed = false
    try {
      const snap = await this.client.getMemberSnapshot(ask.chatId)
      const me = credsOf(this.record).user_id
      const row = (snap.members || []).find((m) => m && String(m.user_id) === me)
      allowed = guardCanStopKicks(row && row.open_permission)
    } catch (e) {
      await this.onError(e)
    }
    guardFinishHalt(this.record, ask.chatId, allowed, Date.now(), ask.roomName, ask.count)
    log(this.id, allowed ? 'kick wave halted' : 'kick wave noticed')
  }

  noteLink(ev) {
    if (!ev) return
    const chatId = ev.chatId != null ? ev.chatId : ev.chat_id
    const li = ev.linkId != null ? ev.linkId : ev.li
    if (chatId == null || li == null || li === '') return
    this.linkIds.set(String(chatId), String(li))
  }

  async visitScan() {
    if (this.record.needs_register || !this.client) return
    const rooms = this.record.rooms || []
    for (const room of rooms) {
      const chatId = String(room && room.chat_id || '')
      if (!visitNeedsProfile(this.record, chatId)) continue
      try {
        await this.scanRoom(chatId)
      } catch (e) {
        await this.onError(e)
      }
    }
  }

  async onPacket(packet) {
    if (this.record.needs_register || !packet) return
    const logs = chatLogsFromBody(packet.body)
    for (const log of logs) {
      const chatId = log.chatId
      if (!chatId || !visitNeedsProfile(this.record, chatId)) continue
      await this.takeVisit(chatId, log)
    }
  }

  async takeVisit(chatId, log) {
    if (!log) return ''
    const id = log.logId ? String(log.logId) : ''
    const key = id ? `${chatId}\u0001${id}` : ''
    if (key && this.visitLogs.has(key)) return 'seen'
    const visits = visitEventsFromMessage({
      message: log.message,
      message_type: log.type,
      author_id: log.authorId,
      attachment: log.attachment,
    })
    if (!visits.length) return ''
    if (key) {
      this.visitLogs.add(key)
      if (this.visitLogs.size > 800) {
        const first = this.visitLogs.values().next().value
        this.visitLogs.delete(first)
      }
    }
    if (id) this.lastLog.set(chatId, id)
    for (const v of visits) {
      await this.onMember(v.kind, {
        chat_id: chatId,
        member: { user_id: v.authorId },
        author_name: v.authorName,
      })
    }
    return 'visit'
  }

  async consumeLogs(chatId, logs, cursor) {
    const fresh = []
    for (const log of logs || []) {
      if (!log) continue
      const rowChat = log.chatId || chatId
      if (rowChat && rowChat !== chatId) continue
      const id = log.logId ? String(log.logId) : ''
      if (!id || !logAfter(id, cursor)) continue
      fresh.push(log)
    }
    fresh.sort((a, b) => {
      const aa = a.logId ? String(a.logId) : ''
      const bb = b.logId ? String(b.logId) : ''
      if (!aa || aa === bb) return 0
      return logAfter(aa, bb) ? 1 : -1
    })
    const slice = fresh.slice(-8)
    let tip = cursor
    for (const log of slice) {
      const id = log.logId ? String(log.logId) : ''
      if (id && logAfter(id, tip)) tip = id
      await this.takeVisit(chatId, log)
    }
    return tip
  }

  async scanRoom(chatId) {
    if (!this.visitEntered.has(chatId)) {
      try {
        const session = await this.client.acquireSession()
        const on = await session.getChatInfo(Long.fromString(chatId))
        this.visitEntered.add(chatId)
        const cursor = this.visitCursor.get(chatId) || ''
        await this.consumeLogs(chatId, chatLogsFromBody(on && on.body, chatId), cursor)
      } catch (e) {
        log(this.id, `room enter failed: ${e && e.message ? e.message : e}`)
      }
    }
    const session = await this.client.acquireSession()
    const infoRes = await session.getChannelInfo(Long.fromString(chatId))
    const body = infoRes && infoRes.body
    const info = body && body.chatInfo
    if (!info || info.left === true) return
    const max = idText(info.lastLogId) || idText(info.lastChatLog && info.lastChatLog.logId)
    if (!max) return
    const li = idText(info.li)
    if (li) this.linkIds.set(chatId, li)
    const cursor = this.visitCursor.get(chatId) || ''
    let tip = await this.consumeLogs(chatId, chatLogsFromBody(body, chatId), cursor)
    if (cursor && logAfter(max, cursor)) {
      try {
        let from = cursor
        for (let page = 0; page < 2; page++) {
          const res = await this.client.getMessagePage(chatId, { from, count: 40 })
          const msgs = (res && res.messages) || []
          const mapped = msgs.map((m) => ({
            chatId,
            logId: m && m.log_id ? String(m.log_id) : '',
            message: m && m.message,
            type: m && m.type,
            authorId: m && m.author_id,
            attachment: m && m.attachment,
          }))
          const got = await this.consumeLogs(chatId, mapped, cursor)
          if (logAfter(got, tip)) tip = got
          const next = res && res.next_cursor ? String(res.next_cursor) : ''
          if (!msgs.length || (res && res.complete) || !next || !logAfter(next, from)) break
          from = next
        }
        if (!logAfter(max, tip)) tip = max
      } catch (e) {
        log(this.id, `room log read failed: ${e && e.message ? e.message : e}`)
      }
    } else if (!cursor) {
      tip = max
    }
    if (tip && tip !== cursor) this.visitCursor.set(chatId, tip)
  }

  async guardTick() {
    if (this.record.needs_register || !this.client) return
    const due = guardDue(this.record, Date.now())
    for (const chatId of due.presence) await this.presence(chatId)
    for (const s of due.sends) await this.deliver(s)
    if (due.presence.length || due.sends.length) await saveRecord(this.id, this.record)
  }

  async presence(chatId) {
    const linkId = this.linkIds.get(String(chatId))
    const opts = linkId ? { linkId } : undefined
    try {
      await this.client.sendTyping(chatId, opts)
      return
    } catch (e) {
      await this.onError(e)
    }
    const logId = this.lastLog.get(String(chatId))
    if (!logId) return
    try {
      await this.client.markRead(chatId, logId, opts)
    } catch (e) {
      await this.onError(e)
    }
  }

  async writeMention(chatId, text, extra) {
    const response = await this.client.executeWithReconnect(async ({ session }) => {
      return session.getConnection().sendPacket('WRITE', {
        chatId: Long.fromString(String(chatId)),
        msg: text,
        type: 1,
        noSeen: false,
        extra,
      })
    })
    return {
      log_id: idText(response && response.body && response.body.logId),
    }
  }

  async deliver(s) {
    if (this.record.needs_register) return
    if (s.delayMs > 0) await sleep(s.delayMs)
    try {
      const extra = visitMentionExtra(s.text, s.mention)
      const res = extra
        ? await this.writeMention(s.chatId, s.text, extra)
        : await this.client.sendMessage(s.chatId, s.text)
      if (!realLogId(res && res.log_id)) log(this.id, `send missing log id chat ${s.chatId}`)
    } catch (e) {
      await this.onError(e)
      log(this.id, `send failed: ${e && e.code ? e.code : e}`)
    }
  }

  async macroTick() {
    if (this.record.needs_register || !this.client) return
    if (macroNotifyReply(this.record)) return
    const now = Date.now()
    const rooms = macroRoomsDue(this.record, now)
    const macro = this.record.config && this.record.config.macro
    if (!macro || !rooms.length) return
    const need = macroMinMessages(this.record)
    const creds = credsOf(this.record)
    for (const room of rooms) {
      let others = 0
      try {
        others = await othersSinceMine(this.client, room.chatId, creds.user_id)
      } catch (e) {
        await this.onError(e)
        noteMacroRetry(this.record, room.key, now)
        continue
      }
      if (others < need) {
        noteMacroWait(this.record, room.key, now)
        continue
      }
      try {
        const res = await this.client.sendMessage(room.chatId, String(macro.message))
        if (!realLogId(res && res.log_id)) throw new Error('undelivered')
        const withImages = noteMacroSent(this.record, room.key, Date.now())
        if (withImages) await this.sendStoredImages(room.chatId)
      } catch (e) {
        await this.onError(e)
        noteMacroRetry(this.record, room.key, now)
      }
      await sleep(1000 + Math.floor(Math.random() * 2000))
    }
    await saveRecord(this.id, this.record)
  }

  async sendStoredImages(chatId) {
    const images = this.record.images || []
    const bufs = []
    for (const item of images) {
      if (!item) continue
      const b64 = typeof item === 'string' ? item : item.b64
      if (!b64) continue
      const buf = Buffer.from(b64, 'base64')
      if (buf.length > 0 && buf.length <= 20 * 1024 * 1024) bufs.push(buf)
      if (bufs.length >= 5) break
    }
    if (!bufs.length) return
    await this.client.acquireSession()
    if (bufs.length === 1) {
      const res = await this.client.sendPhoto(chatId, bufs[0], 'photo-1.jpg')
      if (!realLogId(res && res.log_id)) log(this.id, 'image send missing log id')
      return
    }
    const res = await this.client.sendMultiPhoto(chatId, bufs.map((data, i) => ({
      data,
      filename: `photo-${i + 1}.jpg`,
    })))
    if (!realLogId(res && res.log_id)) log(this.id, 'multi image send missing log id')
  }
}

function memberId(member) {
  if (!member || member.user_id == null) return ''
  const v = member.user_id
  const s = typeof v === 'object' && typeof v.toString === 'function' ? v.toString() : String(v)
  return /^[1-9][0-9]*$/.test(s) ? s : ''
}

function linkFromOpenInfo(body) {
  const row = body && Array.isArray(body.ols) ? body.ols[0] : null
  if (!row || typeof row !== 'object') return ''
  const candidates = [row.lu, row.url, row.linkUrl]
  for (const c of candidates) {
    const s = typeof c === 'string' ? c.trim() : ''
    if (/^https:\/\/open\.kakao\.com\//i.test(s)) return s
  }
  return ''
}

function socketUp(slot) {
  try {
    return !!(slot && slot.client && typeof slot.client.isConnected === 'function' && slot.client.isConnected())
  } catch {
    return false
  }
}

function credsUser(record) {
  return String((record.credentials && record.credentials.user_id) || '')
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export { realId }
