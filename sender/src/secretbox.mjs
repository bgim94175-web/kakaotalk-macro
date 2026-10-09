// 방 참여코드 봉인 (docs/ACCOUNTS_V1.md 8장 6번).
// lib/secretbox.js(부모)와 형식이 같아야 한다: 부모가 봉인한 room_installs.passcode_ct 를 여기서 연다.
//   AES-256-GCM
//   키 = HKDF-SHA256(ikm = CONFIG_SECRET(앞뒤 공백 제거), salt = 'kbot', info = 'room-passcode/v1', 32바이트)
//   값 = 'v1.' + base64url(iv 12바이트 ‖ tag 16바이트 ‖ 암호문)
// 두 파일의 시험(lib/purchase-check.js · src/selfcheck.mjs)이 같은 고정 벡터를 단언한다(9.0).
// 카카오 토큰 봉인(store.mjs, SENDER_KEY)과는 다른 키·형식이다. 섞어 쓰지 않는다.
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto'

const PREFIX = 'v1.'
const SALT = 'kbot'
const INFO = 'room-passcode/v1'
const IV_LEN = 12
const TAG_LEN = 16
const BLOB_RE = /^v1\.[A-Za-z0-9_-]+$/

let cached = { secret: null, key: null }

function key() {
  const secret = String(process.env.CONFIG_SECRET || '').trim()
  if (!secret) throw new Error('CONFIG_SECRET is required to seal room passcodes')
  if (cached.secret !== secret) {
    const k = hkdfSync('sha256', Buffer.from(secret, 'utf8'), Buffer.from(SALT, 'utf8'), Buffer.from(INFO, 'utf8'), 32)
    cached = { secret, key: Buffer.from(k) }
  }
  return cached.key
}

function ivBytes(iv) {
  const b = Buffer.isBuffer(iv) || iv instanceof Uint8Array ? Buffer.from(iv) : Buffer.from(String(iv || ''), 'hex')
  if (b.length !== IV_LEN) throw new Error('iv must be 12 bytes')
  return b
}

// 시험 전용: iv 를 정해 같은 입력에 같은 값을 만든다. 운영 코드는 seal 만 쓴다.
// iv = Buffer/Uint8Array 12바이트 또는 hex 24자.
export function sealWithIv(text, iv) {
  const k = key()
  const ivb = ivBytes(iv)
  const cipher = createCipheriv('aes-256-gcm', k, ivb, { authTagLength: TAG_LEN })
  const ct = Buffer.concat([cipher.update(Buffer.from(String(text), 'utf8')), cipher.final()])
  return PREFIX + Buffer.concat([ivb, cipher.getAuthTag(), ct]).toString('base64url')
}

// 평문 → 봉인값. CONFIG_SECRET 이 없으면 던진다.
export function seal(text) {
  return sealWithIv(text, randomBytes(IV_LEN))
}

// 봉인값 → 평문. 형식이 틀리거나, 변조됐거나, 키가 다르거나, CONFIG_SECRET 이 없으면 null.
export function open(blob) {
  if (typeof blob !== 'string' || !BLOB_RE.test(blob)) return null
  try {
    const buf = Buffer.from(blob.slice(PREFIX.length), 'base64url')
    if (buf.length < IV_LEN + TAG_LEN) return null
    const decipher = createDecipheriv('aes-256-gcm', key(), buf.subarray(0, IV_LEN), { authTagLength: TAG_LEN })
    decipher.setAuthTag(buf.subarray(IV_LEN, IV_LEN + TAG_LEN))
    const plain = Buffer.concat([decipher.update(buf.subarray(IV_LEN + TAG_LEN)), decipher.final()])
    return plain.toString('utf8')
  } catch {
    return null
  }
}
