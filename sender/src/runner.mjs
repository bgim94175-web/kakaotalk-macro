import { webcrypto } from 'node:crypto'

import {
  KakaoTalkClient,
  KakaoTalkListener,
  classifyKakaoChat,
  refreshKakaoOAuthToken,
} from 'agent-messenger/kakaotalk'

import {
  macroMinMessages,
  macroRoomsDue,
  noteMacroRetry,
  noteMacroSent,
  noteMacroWait,
  onInbound,
  othersSinceMine,
  realId,
} from './features.mjs'
import { listIds, loadRecord, saveRecord } from './store.mjs'

if (!globalThis.crypto) globalThis.crypto = webcrypto

const DEAD = new Set(['invalid_access_token', 'login_rejected', 'kicked', 'reauth'])

function log(id, msg) {
  process.stderr.write(`[sender] ${id} ${msg}\n`)
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
    if (!slot) return { linked: false, needs_register: false, reason: 'absent' }
    return {
      linked: !slot.record.needs_register,
      needs_register: !!slot.record.needs_register,
      reason: slot.record.reason || (slot.record.needs_register ? 'reauth' : 'ok'),
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
    return list.map((ch) => ({
      chat_id: String(ch.chat_id),
      kind: classifyKakaoChat(ch),
      type: ch.type,
      title: ch.title || null,
      display_name: ch.display_name || null,
      members: ch.active_members,
      last_at: ch.last_message ? ch.last_message.sent_at : 0,
    }))
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
  }

  async start() {
    await saveRecord(this.id, this.record)
    this.timer = setInterval(() => {
      this.enqueue(async () => {
        await this.ensure()
        await this.macroTick()
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
  }

  async stop() {
    this.stopped = true
    if (this.timer) clearInterval(this.timer)
    this.timer = null
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
    const author = ev.author_id == null ? '' : String(ev.author_id)
    const sends = onInbound(this.record, {
      chatId: String(ev.chat_id || ''),
      text: ev.message || '',
      authorName: ev.author_name || '',
      mine: author.length > 0 && author === creds.user_id,
    })
    await saveRecord(this.id, this.record)
    for (const s of sends) await this.deliver(s)
  }

  async deliver(s) {
    if (this.record.needs_register) return
    if (s.delayMs > 0) await sleep(s.delayMs)
    try {
      const res = await this.client.sendMessage(s.chatId, s.text)
      if (!realLogId(res && res.log_id)) log(this.id, `send missing log id chat ${s.chatId}`)
    } catch (e) {
      await this.onError(e)
      log(this.id, `send failed: ${e && e.code ? e.code : e}`)
    }
  }

  async macroTick() {
    if (this.record.needs_register || !this.client) return
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

function credsUser(record) {
  return String((record.credentials && record.credentials.user_id) || '')
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export { realId }
