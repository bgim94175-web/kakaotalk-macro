import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto'

import pg from 'pg'

// 세션은 라이선스 서버와 같은 Neon(DATABASE_URL)의 kakao_sessions 에 둔다.
// 토큰만 SENDER_KEY 로 봉인한다. 이 파일은 DROP / TRUNCATE / DELETE 를 하지 않는다.
const SCHEMA = `
  CREATE TABLE IF NOT EXISTS kakao_sessions (
    device_id TEXT PRIMARY KEY,
    token_ct TEXT NOT NULL,
    config JSONB NOT NULL DEFAULT '{}',
    rooms JSONB NOT NULL DEFAULT '[]',
    features JSONB NOT NULL DEFAULT '{}',
    images JSONB NOT NULL DEFAULT '[]',
    runtime JSONB NOT NULL DEFAULT '{}',
    needs_register BOOLEAN NOT NULL DEFAULT FALSE,
    reason TEXT,
    updated_at BIGINT NOT NULL
  )`

let pool = null
let schemaReady = null

function key() {
  const raw = process.env.SENDER_KEY || ''
  if (!raw) throw new Error('SENDER_KEY is required')
  if (/^[0-9a-fA-F]{64}$/.test(raw)) return Buffer.from(raw, 'hex')
  return scryptSync(raw, 'kakao-sender-v1', 32)
}

export function assertKey() {
  key()
}

export function seal(obj) {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key(), iv)
  const plain = Buffer.from(JSON.stringify(obj), 'utf8')
  const ct = Buffer.concat([cipher.update(plain), cipher.final()])
  const tag = cipher.getAuthTag()
  return Buffer.concat([iv, tag, ct]).toString('base64')
}

export function open(blob) {
  const buf = Buffer.from(blob, 'base64')
  if (buf.length < 12 + 16) throw new Error('bad token seal')
  const iv = buf.subarray(0, 12)
  const tag = buf.subarray(12, 28)
  const ct = buf.subarray(28)
  const decipher = createDecipheriv('aes-256-gcm', key(), iv)
  decipher.setAuthTag(tag)
  const plain = Buffer.concat([decipher.update(ct), decipher.final()])
  return JSON.parse(plain.toString('utf8'))
}

function sslOf(url) {
  const noSsl = /[?&]sslmode=disable/i.test(url) ||
    String(process.env.PGSSLMODE || '').toLowerCase() === 'disable'
  return noSsl ? false : { rejectUnauthorized: false }
}

function getPool() {
  if (pool) return pool
  const url = process.env.DATABASE_URL
  if (!url) throw new Error('DATABASE_URL is required')
  pool = new pg.Pool({
    connectionString: url,
    ssl: sslOf(url),
    max: 2,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 15000,
  })
  pool.on('error', (e) => {
    process.stderr.write(`[sender] idle db connection: ${e.message}\n`)
  })
  return pool
}

export function ensureSchema() {
  if (!schemaReady) {
    schemaReady = getPool().query(SCHEMA).catch((e) => {
      schemaReady = null
      throw e
    })
  }
  return schemaReady
}

function credentialsOf(record) {
  const c = record && record.credentials
  if (!c || typeof c !== 'object') return null
  return {
    access_token: c.access_token == null ? '' : String(c.access_token),
    refresh_token: c.refresh_token == null ? '' : String(c.refresh_token),
    user_id: c.user_id == null ? '' : String(c.user_id),
    device_uuid: c.device_uuid == null ? '' : String(c.device_uuid),
    device_type: c.device_type === 'pc' ? 'pc' : 'tablet',
  }
}

function jsonOf(value, fallback) {
  return JSON.stringify(value == null ? fallback : value)
}

export async function saveRecord(id, record) {
  await ensureSchema()
  const creds = credentialsOf(record)
  const tokenCt = creds ? seal(creds) : ''
  const body = record || {}
  await getPool().query(
    `INSERT INTO kakao_sessions
       (device_id, token_ct, config, rooms, features, images, runtime, needs_register, reason, updated_at)
     VALUES ($1, $2, $3::jsonb, $4::jsonb, $5::jsonb, $6::jsonb, $7::jsonb, $8, $9, $10)
     ON CONFLICT (device_id) DO UPDATE SET
       token_ct = EXCLUDED.token_ct,
       config = EXCLUDED.config,
       rooms = EXCLUDED.rooms,
       features = EXCLUDED.features,
       images = EXCLUDED.images,
       runtime = EXCLUDED.runtime,
       needs_register = EXCLUDED.needs_register,
       reason = EXCLUDED.reason,
       updated_at = EXCLUDED.updated_at`,
    [
      id,
      tokenCt,
      jsonOf(body.config, {}),
      jsonOf(body.rooms, []),
      jsonOf(body.features, {}),
      jsonOf(body.images, []),
      jsonOf(body.runtime, {}),
      !!body.needs_register,
      body.reason == null ? null : String(body.reason),
      Date.now(),
    ],
  )
}

export async function loadRecord(id) {
  await ensureSchema()
  const r = await getPool().query(
    `SELECT device_id, token_ct, config, rooms, features, images, runtime, needs_register, reason
       FROM kakao_sessions WHERE device_id = $1`,
    [id],
  )
  const row = r.rows[0]
  if (!row) return null
  return {
    device_id: row.device_id,
    credentials: row.token_ct ? open(row.token_ct) : {},
    config: row.config || {},
    rooms: row.rooms || [],
    features: row.features || {},
    images: row.images || [],
    runtime: row.runtime || {},
    needs_register: !!row.needs_register,
    reason: row.reason || '',
  }
}

export async function listIds() {
  await ensureSchema()
  const r = await getPool().query(
    `SELECT device_id FROM kakao_sessions
      WHERE needs_register = FALSE AND token_ct <> ''`,
  )
  return r.rows.map((row) => row.device_id)
}

export function blankRuntime() {
  return {
    macroSeq: 0,
    roomDueAt: {},
    roomLastSent: {},
    triggerCd: {},
    triggerOnce: {},
    replyLast: {},
    replyDay: '',
    replyCount: 0,
    botDay: '',
    botCount: 0,
    botLast: {},
    warns: {},
    warnAt: {},
    flood: {},
    floodWarn: {},
    said: {},
    games: {},
    scores: {},
    asked: {},
    knownRooms: {},
    gameLast: {},
  }
}
