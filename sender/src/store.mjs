import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto'

import pg from 'pg'

// 세션은 라이선스 서버와 같은 Neon(DATABASE_URL)의 kakao_sessions 에 둔다.
// 토큰만 SENDER_KEY 로 봉인한다. 이 파일은 DROP / TRUNCATE 를 하지 않고, DELETE 도 하지 않는다.
// room_state·room_log 는 docs/ACCOUNTS_V1.md 2.1 의 블록을 글자 그대로 둔다(sender 단독 실행용, IF NOT EXISTS 라 겹쳐도 안전).
// room_installs·bot_accounts·bot_pending·room_leaves·room_blocklist 는 부모(lib/db.js)에만 있다 — 부모가 migrate 를 끝낸 뒤 자식을 띄운다.
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
  );
CREATE TABLE IF NOT EXISTS room_state (
  install_id BIGINT PRIMARY KEY,
  runtime    JSONB NOT NULL DEFAULT '{}',
  updated_at BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS room_log (
  id         BIGSERIAL PRIMARY KEY,
  install_id BIGINT NOT NULL,
  at         BIGINT NOT NULL,
  kind       TEXT NOT NULL,                      -- 7.8
  user_id    TEXT,
  name       TEXT,
  ok         BOOLEAN NOT NULL DEFAULT TRUE,
  detail     JSONB NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_room_log ON room_log (install_id, at DESC);
-- 방 멤버 명부: 봇이 방에 들어간 뒤 모은 사람별 닉네임·옾링(pli→link)·사진. NULL = 아직 모름, '' = 없음.
-- 오래된 행은 부모(lib/entitle.js cleanup)가 지운다. 이 파일은 DELETE 를 하지 않는다.
CREATE TABLE IF NOT EXISTS room_members (
  install_id BIGINT NOT NULL,
  chat_id    TEXT   NOT NULL DEFAULT '',
  user_id    TEXT   NOT NULL,
  name       TEXT   NOT NULL DEFAULT '',
  pli        TEXT,
  link       TEXT,
  photo      TEXT,
  seen_at    BIGINT NOT NULL,
  PRIMARY KEY (install_id, user_id)
);
-- 배포 겹침 울타리(owner.mjs): 마지막으로 켜진 sender 하나만 카카오 연결의 주인이다. 한 줄(id = 1)만 쓴다.
CREATE TABLE IF NOT EXISTS sender_owner (
  id    INT    PRIMARY KEY,
  boot  TEXT   NOT NULL,
  since BIGINT NOT NULL,
  beat  BIGINT NOT NULL
);
`

let pool = null
let schemaReady = null

function keyMaterial() {
  return String(process.env.SENDER_KEY || '').trim().replace(/^['"]|['"]$/g, '')
}

function key() {
  const raw = keyMaterial()
  if (!raw) throw new Error('SENDER_KEY is required')
  if (/^[0-9a-fA-F]{64}$/.test(raw)) return Buffer.from(raw, 'hex')
  return scryptSync(raw, 'kakao-sender-v1', 32)
}

// pg 는 연결 문자열의 sslmode=require 를 인증서 검증으로 덮어써서
// Pool 에 넣은 rejectUnauthorized:false 가 사라진다. Neon 문자열의
// channel_binding 도 이 클라이언트가 처리하지 않는다. 둘 다 떼고 SSL 은 여기서 정한다.
function connectionString() {
  const raw = process.env.DATABASE_URL
  if (!raw) throw new Error('DATABASE_URL is required')
  const url = String(raw)
  if (/[?&]sslmode=disable/i.test(url) || String(process.env.PGSSLMODE || '').toLowerCase() === 'disable') {
    return url
  }
  return url
    .replace(/([?&])channel_binding=[^&]*/gi, '$1')
    .replace(/([?&])sslmode=[^&]*/gi, '$1')
    .replace(/\?&/g, '?')
    .replace(/[?&]$/g, '')
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
  const url = connectionString()
  pool = new pg.Pool({
    connectionString: url,
    ssl: sslOf(url),
    max: 4,
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

// 권리(features)만 바꾼다(/v1/grants). 토큰을 다시 봉인하지 않는다.
export async function updateFeatures(id, features) {
  await ensureSchema()
  await getPool().query(
    'UPDATE kakao_sessions SET features = $2::jsonb, updated_at = $3 WHERE device_id = $1',
    [id, JSON.stringify(features || {}), Date.now()],
  )
}

// 모든 기록의 권리 칸(전체 밀기 full:true 가 목록에 없는 기록을 찾을 때).
export async function listFeatureRows() {
  await ensureSchema()
  const r = await getPool().query('SELECT device_id, features FROM kakao_sessions')
  return r.rows.map((row) => ({ device_id: row.device_id, features: row.features || {} }))
}

// ── 방 설치형 봇(K bot 계정)의 DB 쓰기 ─────────────────────────────────────────
// 2.2 쓰기 소유권: room_installs 는 sender 칸(state error_code error_detail chat_id perm perm_at joined_at
// state_at next_try_at attempts link_id link_name)만, 그리고 늘 WHERE id AND phase='installed' AND bot_device_id=봇.
const INSTALL_COLS = new Set([
  'state', 'error_code', 'error_detail', 'chat_id', 'perm', 'perm_at', 'joined_at', 'state_at', 'next_try_at', 'link_id', 'link_name',
])

function q(sql, params) {
  return getPool().query(sql, params)
}

export const dbStore = {
  async listInstalls(botIds) {
    if (!botIds.length) return []
    const r = await q(
      `SELECT r.*, m.blocked_reason AS member_blocked
         FROM room_installs r JOIN members m ON m.id = r.member_id
        WHERE r.phase = 'installed' AND r.bot_device_id = ANY($1)`,
      [botIds],
    )
    return r.rows
  },

  async getInstall(id) {
    const r = await q(
      `SELECT r.*, m.blocked_reason AS member_blocked
         FROM room_installs r JOIN members m ON m.id = r.member_id
        WHERE r.id = $1`,
      [id],
    )
    return r.rows[0] || null
  },

  async listLeaves(botIds) {
    if (!botIds.length) return []
    const r = await q('SELECT * FROM room_leaves WHERE done_at IS NULL AND bot_device_id = ANY($1) ORDER BY id', [botIds])
    return r.rows
  },

  async finishLeave(id, botId, result, done) {
    await q(
      'UPDATE room_leaves SET done_at = $3, result = $4 WHERE id = $1 AND bot_device_id = $2',
      [id, botId, done ? Date.now() : null, String(result).slice(0, 60)],
    )
  },

  // fields 의 칸만 쓴다. attempts:'+1' 이면 하나 올린다. 23505 는 그대로 던진다(호출자가 판정).
  async updateInstall(id, botId, fields) {
    const sets = []
    const params = [id, botId]
    for (const [k, v] of Object.entries(fields || {})) {
      if (k === 'attempts') {
        sets.push('attempts = attempts + 1')
        continue
      }
      if (!INSTALL_COLS.has(k)) throw new Error('sender may not write room_installs.' + k)
      params.push(v === undefined ? null : v)
      sets.push(`${k} = $${params.length}`)
    }
    if (!sets.length) return 0
    const r = await q(
      `UPDATE room_installs SET ${sets.join(', ')} WHERE id = $1 AND phase = 'installed' AND bot_device_id = $2`,
      params,
    )
    return r.rowCount
  },

  // 봇 계정이 끊겼을 때(D17): 맡은 방 중 오류가 아닌 것을 bot_down 으로. 내보내진 방은 건드리지 않는다.
  async markBotRooms(botId, now) {
    const r = await q(
      `UPDATE room_installs SET state = 'error', error_code = 'bot_down', error_detail = NULL, state_at = $2
        WHERE bot_device_id = $1 AND phase = 'installed' AND state <> 'error'`,
      [botId, now],
    )
    return r.rowCount
  },

  async isBlocked(linkId, linkUrl) {
    const r = await q(
      `SELECT 1 FROM room_blocklist
        WHERE ($1::text IS NOT NULL AND link_id = $1) OR ($2::text IS NOT NULL AND link_url = $2) LIMIT 1`,
      [linkId || null, linkUrl || null],
    )
    return r.rowCount > 0
  },

  async roomLog(installId, kind, row) {
    const x = row || {}
    await q(
      `INSERT INTO room_log (install_id, at, kind, user_id, name, ok, detail)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
      [
        installId,
        Number(x.at) || Date.now(),
        kind,
        x.user_id ? String(x.user_id) : null,
        x.name ? String(x.name).slice(0, 80) : null,
        x.ok !== false,
        JSON.stringify(x.detail || {}),
      ],
    )
  },

  // 이 설치에서 K bot 이 내보낸(또는 내보내려 한) 사람인가 → {any, kicked}
  async kickHistory(installId, userId) {
    const r = await q(
      `SELECT kind, ok FROM room_log WHERE install_id = $1 AND user_id = $2 AND kind IN ('kick','kick_fail')`,
      [installId, String(userId)],
    )
    return { any: r.rowCount > 0, kicked: r.rows.some((x) => x.kind === 'kick' && x.ok !== false) }
  },

  async loadRoomState(installId) {
    const r = await q('SELECT runtime FROM room_state WHERE install_id = $1', [installId])
    return r.rows[0] ? r.rows[0].runtime || {} : null
  },

  async saveRoomState(installId, runtime) {
    await q(
      `INSERT INTO room_state (install_id, runtime, updated_at) VALUES ($1, $2::jsonb, $3)
       ON CONFLICT (install_id) DO UPDATE SET runtime = EXCLUDED.runtime, updated_at = EXCLUDED.updated_at`,
      [installId, JSON.stringify(runtime || {}), Date.now()],
    )
  },

  // 방 멤버 명부(옾링·사진). 지금 방(chat)의 것만, since 보다 오래 안 본 사람은 읽지 않는다.
  async loadMembers(installId, chatId, since) {
    const r = await q(
      'SELECT user_id, name, pli, link, photo, seen_at FROM room_members WHERE install_id = $1 AND chat_id = $2 AND seen_at >= $3',
      [installId, String(chatId || ''), Number(since) || 0],
    )
    return r.rows
  },

  // 바뀐 사람만 묶어서 쓴다(500명씩).
  async saveMembers(installId, chatId, rows) {
    for (let i = 0; i < rows.length; i += 500) {
      const part = rows.slice(i, i + 500)
      await q(
        `INSERT INTO room_members (install_id, chat_id, user_id, name, pli, link, photo, seen_at)
         SELECT $1, $8, u, n, p, l, ph, s
           FROM unnest($2::text[], $3::text[], $4::text[], $5::text[], $6::text[], $7::bigint[]) AS t(u, n, p, l, ph, s)
         ON CONFLICT (install_id, user_id) DO UPDATE
            SET chat_id = EXCLUDED.chat_id, name = EXCLUDED.name, pli = EXCLUDED.pli, link = EXCLUDED.link,
                photo = EXCLUDED.photo, seen_at = EXCLUDED.seen_at`,
        [installId, part.map((r) => r.user_id), part.map((r) => r.name || ''), part.map((r) => r.pli), part.map((r) => r.link),
          part.map((r) => r.photo), part.map((r) => Number(r.seen_at) || Date.now()), String(chatId || '')],
      )
    }
  },

  // 2.2: bot_accounts 는 nickname state state_at(+ 오픈프로필 칸, 아래)만. 등록 직후 최소 행은 ensureBotAccount.
  async botState(botId, fields) {
    const sets = ['state_at = $2']
    const params = [botId, Date.now()]
    if (fields.state) {
      params.push(fields.state)
      sets.push(`state = $${params.length}`)
    }
    if (fields.nickname) {
      params.push(String(fields.nickname).slice(0, 60))
      sets.push(`nickname = $${params.length}`)
    }
    await q(`UPDATE bot_accounts SET ${sets.join(', ')} WHERE device_id = $1`, params)
  },

  async botNickname(botId) {
    const r = await q('SELECT nickname FROM bot_accounts WHERE device_id = $1', [botId])
    return r.rows[0] && r.rows[0].nickname ? String(r.rows[0].nickname) : ''
  },

  // 오픈프로필(D12, 2.2): sender 는 open_profiles·open_profile_li·open_profile_name·open_profile_at 을 쓰고,
  // 관리자가 고른 open_profile_pick(부모 칸)은 읽기만 한다.
  async botProfileRows(botIds) {
    if (!botIds || !botIds.length) return []
    const r = await q(
      `SELECT device_id, open_profiles, open_profile_pick, open_profile_li, open_profile_name, open_profile_at
         FROM bot_accounts WHERE device_id = ANY($1)`,
      [botIds],
    )
    return r.rows
  },

  // f = {list?: [{li,name,url}]|null, li?: string|null, name?: string|null, at?: ms|null}. 없는 키·list null 은 그대로 둔다.
  async botOpenProfile(botId, f) {
    const sets = []
    const params = [botId]
    if (f && Array.isArray(f.list)) {
      params.push(JSON.stringify(f.list.slice(0, 50)))
      sets.push(`open_profiles = $${params.length}::jsonb`)
    }
    if (f && f.li !== undefined) {
      params.push(f.li ? String(f.li) : null)
      sets.push(`open_profile_li = $${params.length}`)
    }
    if (f && f.name !== undefined) {
      params.push(f.name ? String(f.name).slice(0, 60) : null)
      sets.push(`open_profile_name = $${params.length}`)
    }
    if (f && f.at) {
      params.push(Number(f.at))
      sets.push(`open_profile_at = $${params.length}`)
    }
    if (!sets.length) return
    await q(`UPDATE bot_accounts SET ${sets.join(', ')} WHERE device_id = $1`, params)
  },

  // 배포 겹침 울타리(owner.mjs). 나보다 늦게 켜진 주인이 살아 있으면 주인이 되지 않는다.
  async claimOwner(boot, since, now, staleBefore) {
    await ensureSchema()
    const r = await q(
      `INSERT INTO sender_owner (id, boot, since, beat) VALUES (1, $1, $2, $3)
       ON CONFLICT (id) DO UPDATE SET boot = EXCLUDED.boot, since = EXCLUDED.since, beat = EXCLUDED.beat
        WHERE sender_owner.since <= EXCLUDED.since OR sender_owner.beat < $4`,
      [boot, since, now, staleBefore],
    )
    return r.rowCount === 1
  },

  async ownerBeat(boot, now) {
    const r = await q('UPDATE sender_owner SET beat = $2 WHERE id = 1 AND boot = $1', [boot, now])
    return r.rowCount === 1
  },

  async ownerRow() {
    const r = await q('SELECT boot, since, beat FROM sender_owner WHERE id = 1')
    return r.rows[0] || null
  },

  // 예전 서버가 밀려나며 지운 로그인을, 지금 붙어 있는 서버의 기록으로 되살린다. 지워진(needs_register) 행만 고친다.
  async restoreLogin(id, record) {
    const creds = credentialsOf(record)
    if (!creds || !creds.access_token) return false
    const r = await q(
      `UPDATE kakao_sessions SET token_ct = $2, needs_register = FALSE, reason = 'ok', updated_at = $3
        WHERE device_id = $1 AND needs_register = TRUE`,
      [id, seal(creds), Date.now()],
    )
    return r.rowCount === 1
  },

  async ensureBotAccount(botId, email) {
    await q(
      `INSERT INTO bot_accounts (device_id, email, created_at, state) VALUES ($1, $2, $3, 'connected')
       ON CONFLICT (device_id) DO NOTHING`,
      [botId, String(email || '').slice(0, 200) || botId, Date.now()],
    )
  },
}
