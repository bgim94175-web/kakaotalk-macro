// 기록 카드 동그라미의 멤버 프로필 사진(docs/ACCOUNTS_V1.md 7.2(f)). 카카오가 주는 사진 주소(MEMBER·GETMEM 의 pi)를 받아
// 168px PNG(data URI)로 바꿔 둔다. 카드는 그 값을 넣어 그리고, 없으면(null) 지금처럼 이름 첫 글자로 그린다.
//   · https 만, 카카오 사진 서버만(BOT_AVATAR_HOSTS, 기본 kakaocdn.net · kakao.com · kakao.co.kr · daumcdn.net — 끝이 같은 주소).
//     http 주소는 https 로 바꿔 읽는다. 주소에 아이디·비밀번호·다른 포트·IP 가 있으면 받지 않는다. 받지 않은 서버는 이름만 한 번 로그에.
//   · 넘기는 답(3xx)은 목록 안의 주소로만 2번까지 따라간다(다른 곳으로 넘기면 멈춘다)
//   · BOT_AVATAR_TIMEOUT_MS(3초) 안에 끝나지 않으면, BOT_AVATAR_MAX_BYTES(1.5MB)를 넘으면 버린다
//   · 앞 바이트로 PNG · JPEG · GIF 만 받는다(content-type 은 믿지 않는다). resvg 2.6 은 WebP · BMP · CMYK JPEG 를 빈 그림으로 그린다.
//     머리의 크기가 너무 큰 그림(해독 폭탄)도 받지 않는다 — 크기는 해독기가 읽는 곳에서 읽는다(JPEG 은 해독기와 같은 순서로 엄격하게,
//     GIF 은 첫 장면의 크기). 받은 그림은 resvg 로 168×168 PNG 로 다시 그린다(card.mjs photoPng)
//   · 주소마다 200개 · 1시간(실패는 10분) 기억하고(가장 오래 안 쓴 것부터 버림), 같은 주소를 동시에 두 번 받지 않는다
//   · 받기 + 그리기는 동시에 4개까지(limit). 꽉 차면 기다리지 않고 null(실패로 기억하지 않음 — 다음 카드는 다시 받는다)
// get() 은 거절하지 않는다(실패 = null). 네트워크(fetch)·시계는 주입받는다 — 시험은 가짜 fetch 로 돈다(진짜 네트워크를 쓰지 않음).
import { photoPng } from './card.mjs'
import { AVATAR, PNG_SCALE } from './logcard.mjs'

export const AVATAR_HOSTS = Object.freeze(['kakaocdn.net', 'kakao.com', 'kakao.co.kr', 'daumcdn.net'])
export const AVATAR_PX = AVATAR.r * 2 * PNG_SCALE // 168
const MAX_SIDE = 4096
const MAX_PIXELS = 8 * 1024 * 1024 // 해독하면 32MB(RGBA)까지
const HOPS = 2
const NOTED_MAX = 100
const SLOT_MAX_MS = 30 * 1000

/** 받아도 되는 사진 주소(https 로 고친 것) 또는 ''. hosts = 끝이 같은 서버 이름들 */
export function avatarUrl(raw, hosts) {
  const list = hosts || AVATAR_HOSTS
  let u
  try {
    u = new URL(String(raw || '').trim())
  } catch {
    return ''
  }
  if (u.protocol === 'http:') u.protocol = 'https:' // 예전 사진 주소는 http 다. 카카오 사진 서버는 https 로도 답한다
  if (u.protocol !== 'https:' || u.username || u.password || (u.port && u.port !== '443')) return ''
  const h = u.hostname.toLowerCase().replace(/\.$/, '')
  if (!h || /^[0-9.]+$/.test(h) || h.includes(':') || h.includes('[')) return ''
  if (!list.some((d) => h === d || h.endsWith('.' + d))) return ''
  u.hash = ''
  return u.href
}

/** 앞 바이트 → 그릴 수 있는 그림 종류(image/png · image/jpeg · image/gif) 또는 '' */
export function sniff(b) {
  if (!Buffer.isBuffer(b)) return ''
  if (b.length >= 24 && b[0] === 0x89 && b.toString('latin1', 1, 4) === 'PNG' && b.toString('latin1', 12, 16) === 'IHDR') return 'image/png'
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg'
  if (b.length >= 10 && /^GIF8[79]a$/.test(b.toString('latin1', 0, 6))) return 'image/gif'
  return ''
}

// JPEG SOFn(크기를 적은 표시): C0–C3 · C5–C7 · C9–CB · CD–CF
const JPEG_SOF = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf])
// SOF 앞에 올 수 있는 길이 있는 표시: DHT · DQT · DRI · COM (+ APPn E0–EF)
const JPEG_SEG = new Set([0xc4, 0xdb, 0xdd, 0xfe])

/**
 * 해독할 때 만들 그림 크기 {w, h, cmyk} 또는 null(못 읽음 → 받지 않는다).
 *  · PNG: IHDR(처음 덩어리)
 *  · GIF: 첫 장면(0x2C)의 크기 — resvg 는 화면 크기가 아니라 첫 장면 크기로 그림을 만든다. 장면이 화면보다 크면 null
 *  · JPEG: SOI 다음 표시를 길이대로 하나씩 건너 첫 SOFn. 해독기(jpeg-decoder)와 다른 곳을 읽지 않게 엄격하게 —
 *    표시 사이에 FF 가 아닌 바이트, FF 00, 모르는 표시(SOS · EOI · RSTn · SOI 등 포함)가 SOF 앞에 나오면 null
 *    (해독기는 그런 바이트를 건너뛰며 계속 찾으므로, 이 걸음이 건너뛴 곳의 다른 SOF 를 읽을 수 있다 — 크기 검사를 속이는 그림)
 */
export function imageSize(b, mime) {
  if (!Buffer.isBuffer(b)) return null
  if (mime === 'image/png') return b.length >= 24 ? { w: b.readUInt32BE(16), h: b.readUInt32BE(20), cmyk: false } : null
  if (mime === 'image/gif') return gifFrameSize(b)
  if (mime !== 'image/jpeg' || b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return null
  let i = 2
  while (i < b.length) {
    if (b[i] !== 0xff) return null // 표시 자리에 다른 바이트
    let j = i + 1
    while (j < b.length && b[j] === 0xff) j++ // 채움 바이트(FF FF …)
    if (j + 2 >= b.length) return null
    const m = b[j]
    if (JPEG_SOF.has(m)) return j + 8 < b.length ? { w: b.readUInt16BE(j + 6), h: b.readUInt16BE(j + 4), cmyk: b[j + 8] === 4 } : null
    if (!JPEG_SEG.has(m) && !(m >= 0xe0 && m <= 0xef)) return null // FF 00 · SOS · EOI · RSTn · 모르는 표시: 크기 전에 끝나거나 읽을 수 없음
    const len = b.readUInt16BE(j + 1)
    if (len < 2) return null
    i = j + 1 + len
  }
  return null
}

// GIF: 화면 크기(6–9) · 전체 색표를 건너 확장 블록(0x21)들을 지나 첫 장면(0x2C)의 폭 · 높이
function gifFrameSize(b) {
  if (b.length < 13) return null
  const sw = b.readUInt16LE(6)
  const sh = b.readUInt16LE(8)
  let i = 13
  if (b[10] & 0x80) i += 3 * (2 << (b[10] & 7)) // 전체 색표
  while (i < b.length) {
    const t = b[i]
    if (t === 0x2c) {
      if (i + 9 >= b.length) return null
      const w = b.readUInt16LE(i + 5)
      const h = b.readUInt16LE(i + 7)
      if (w > sw || h > sh) return null // 화면보다 큰 장면
      return { w, h, cmyk: false }
    }
    if (t !== 0x21 || i + 2 >= b.length) return null // 장면 전에 끝(0x3B) · 모르는 블록
    i += 2 // 0x21 + 이름표
    while (i < b.length && b[i] !== 0) i += 1 + b[i] // 작은 블록들(길이 + 바이트), 0 이면 끝
    i++
  }
  return null
}

function dataUri(png) {
  return png ? 'data:image/png;base64,' + png.toString('base64') : null
}

async function drop(res) {
  try {
    if (res && res.body) await res.body.cancel()
  } catch {
    /* 이미 닫힘 */
  }
}

export class Avatars {
  /**
   * o: {fetch, hosts, timeoutMs, maxBytes, max(기억 수), ttlMs, failTtlMs, limit(동시에 받기 + 그리기), now, log, render(시험: photoPng 자리)}
   */
  constructor(o) {
    const d = o || {}
    this.fetchFn = typeof d.fetch === 'function' ? d.fetch : (url, init) => globalThis.fetch(url, init)
    this.render = typeof d.render === 'function' ? d.render : photoPng
    this.hosts = Array.isArray(d.hosts) ? d.hosts : AVATAR_HOSTS
    this.timeoutMs = Number(d.timeoutMs) > 0 ? Number(d.timeoutMs) : 3000
    this.maxBytes = Number(d.maxBytes) > 0 ? Number(d.maxBytes) : 1.5 * 1024 * 1024
    this.max = Number(d.max) > 0 ? Number(d.max) : 200
    this.ttlMs = Number(d.ttlMs) > 0 ? Number(d.ttlMs) : 60 * 60 * 1000
    this.failTtlMs = Number(d.failTtlMs) > 0 ? Number(d.failTtlMs) : 10 * 60 * 1000
    this.limit = Number(d.limit) > 0 ? Number(d.limit) : 4
    this.active = 0 // 받거나 그리는 중(시간이 지나 포기한 것도 실제로 끝날 때까지 센다)
    this.now = d.now || (() => Date.now())
    this.log = d.log || (() => {})
    this.cache = new Map() // 주소 → {at, data(data URI | null)}. 넣은(쓴) 순서 = 오래된 것이 앞
    this.inflight = new Map() // 주소 → Promise
    this.noted = new Set() // 받지 않은 서버 이름(로그 한 번)
    this.stats = { fetches: 0, hits: 0, refused: 0, failed: 0, busy: 0, rejected: 0 }
  }

  /** 사진 주소 → Promise<'data:image/png;base64,…' | null>. 거절하지 않는다 */
  get(raw) {
    const url = avatarUrl(raw, this.hosts)
    if (!url) {
      this.refuse(raw)
      return Promise.resolve(null)
    }
    const hit = this.cache.get(url)
    if (hit && this.now() - hit.at < (hit.data ? this.ttlMs : this.failTtlMs)) {
      this.stats.hits++
      this.cache.delete(url)
      this.cache.set(url, hit) // 가장 최근에 쓴 것으로
      return Promise.resolve(hit.data)
    }
    const busy = this.inflight.get(url)
    if (busy) return busy
    if (this.active >= this.limit) {
      // 이미 limit 개를 받거나 그리는 중(입장 폭주 등): 기다리지 않고 첫 글자. 실패로 기억하지 않는다
      this.stats.busy++
      return Promise.resolve(null)
    }
    const p = this.load(url).then((data) => {
      if (!data) this.stats.failed++
      this.cache.delete(url)
      this.cache.set(url, { at: this.now(), data })
      while (this.cache.size > this.max) this.cache.delete(this.cache.keys().next().value)
      return data
    }).finally(() => this.inflight.delete(url))
    this.inflight.set(url, p)
    return p
  }

  // 받지 않은 주소: 서버 이름만 한 번 남긴다(실제 카카오 사진 서버를 운영에서 확인하려고. 주소 전체는 남기지 않는다)
  refuse(raw) {
    this.stats.refused++
    let host = ''
    try {
      host = new URL(String(raw || '').trim()).hostname.toLowerCase()
    } catch {
      return
    }
    if (!host || this.noted.has(host) || this.noted.size >= NOTED_MAX) return
    this.noted.add(host)
    this.log(`avatar host not allowed: ${host} (BOT_AVATAR_HOSTS)`)
  }

  // 받기 + 그리기 전체를 timeoutMs 안에. 넘기면 받기를 끊고 null. 자리(active)는 일이 실제로 끝날 때 돌려준다
  // (그리기는 끊을 수 없다 — 시간이 지나도 끝날 때까지 센다. 끊기를 무시하는 fetch 를 위해 늦어도 SLOT_MAX_MS 뒤에는 돌려준다)
  async load(url) {
    this.stats.fetches++
    this.active++
    let freed = false
    const free = () => {
      if (freed) return
      freed = true
      this.active--
      clearTimeout(cap)
    }
    const cap = setTimeout(free, Math.max(SLOT_MAX_MS, this.timeoutMs * 4))
    if (cap.unref) cap.unref()
    const ac = new AbortController()
    let timer = null
    const late = new Promise((ok) => {
      timer = setTimeout(() => {
        ac.abort()
        ok(null)
      }, this.timeoutMs)
    })
    const work = (async () => {
      const buf = await this.download(url, ac.signal)
      const mime = buf ? sniff(buf) : ''
      if (!mime) {
        if (buf) this.stats.rejected++
        return null
      }
      const size = imageSize(buf, mime)
      if (!size || !size.w || !size.h || size.cmyk || size.w > MAX_SIDE || size.h > MAX_SIDE || size.w * size.h > MAX_PIXELS) {
        this.stats.rejected++
        return null
      }
      return dataUri(await this.render(buf, mime, AVATAR_PX))
    })().catch(() => null).finally(free)
    try {
      return await Promise.race([work, late])
    } finally {
      clearTimeout(timer)
    }
  }

  async download(url, signal) {
    let cur = url
    for (let hop = 0; hop <= HOPS; hop++) {
      const res = await this.fetchFn(cur, { redirect: 'manual', signal, headers: { accept: 'image/png,image/jpeg,image/gif;q=0.9,*/*;q=0.1' } })
      if (!res) return null
      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get('location')
        await drop(res)
        let to = ''
        try {
          to = loc ? new URL(loc, cur).href : ''
        } catch {
          to = ''
        }
        const next = to ? avatarUrl(to, this.hosts) : ''
        if (!next) {
          if (to) this.refuse(to)
          return null
        }
        cur = next
        continue
      }
      if (res.status !== 200 || !res.body) {
        await drop(res)
        return null
      }
      const len = Number(res.headers.get('content-length'))
      if (len > this.maxBytes) {
        await drop(res)
        return null
      }
      const parts = []
      let n = 0
      for await (const chunk of res.body) {
        n += chunk.length
        if (n > this.maxBytes) return null // for await 를 빠져나오면 나머지 받기는 끊긴다
        parts.push(Buffer.from(chunk))
      }
      return Buffer.concat(parts)
    }
    return null
  }
}
