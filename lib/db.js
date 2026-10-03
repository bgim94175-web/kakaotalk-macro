// 라이선스 서버 — DB 계층 (Neon Postgres)
// 지연 초기화가 원칙이다: 이 모듈을 require 하는 것만으로는 DB에 붙지 않는다.
// (pg 모듈도 실제로 쓸 때 require 한다 → 라우터 단독 로드 테스트가 가능해야 하니까)
'use strict';

let _pg = null;
let _pool = null;

function pgmod() {
  if (!_pg) _pg = require('pg');
  return _pg;
}

// 커넥션 풀 (처음 쓸 때 만든다)
function pool() {
  if (_pool) return _pool;
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL(=Neon 연결문자열) 환경변수가 설정되지 않았습니다');
  const { Pool } = pgmod();
  // Neon 은 SSL 필수. 로컬 Postgres 로 테스트할 땐 sslmode=disable 을 붙이면 끈다.
  const noSsl = /[?&]sslmode=disable/i.test(url) ||
                String(process.env.PGSSLMODE || '').toLowerCase() === 'disable';
  _pool = new Pool({
    connectionString: url,
    ssl: noSsl ? false : { rejectUnauthorized: false }, // Neon 필수
    max: 3,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 15000,
  });
  // 유휴 커넥션이 끊겨도 프로세스가 죽지 않게 (Neon은 자주 끊는다)
  _pool.on('error', (e) => console.error('[db] 유휴 커넥션 에러:', e.message));
  return _pool;
}

// client 를 주면 그 트랜잭션 안에서, 안 주면 풀에서 바로 실행
function q(sql, params, client) {
  return (client || pool()).query(sql, params || []);
}

async function one(sql, params, client) {
  const r = await q(sql, params, client);
  return r.rows[0] || null;
}

// 트랜잭션. 콜백 안에서 에러 나면 롤백하고 그대로 던진다 (절대 삼키지 않음)
async function tx(fn) {
  const client = await pool().connect();
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (e) {
    try { await client.query('ROLLBACK'); }
    catch (e2) { console.error('[db] 롤백 실패:', e2.message); }
    throw e;
  } finally {
    client.release();
  }
}

// ─────────────────────────────────────────────────────────────
// 마이그레이션 — 몇 번 실행해도 안전(idempotent). 기존 데이터는 절대 지우지 않는다.
// DROP / TRUNCATE 는 이 파일에 단 한 줄도 없어야 한다.
// ─────────────────────────────────────────────────────────────
const STEPS = [
  ['licenses 생성(없으면)', `
    CREATE TABLE IF NOT EXISTS licenses (
      key          TEXT PRIMARY KEY,
      plan         TEXT,
      duration_ms  BIGINT,
      device_id    TEXT,
      device_name  TEXT,
      activated_at BIGINT,
      expires_at   BIGINT,
      revoked      BOOLEAN DEFAULT FALSE,
      note         TEXT,
      created_at   BIGINT NOT NULL,
      last_seen    BIGINT
    )`],

  // 구버전 테이블은 plan/duration_ms 가 NOT NULL 이었다 → 기능별 관리로 바뀌니 풀어준다
  ['licenses.plan NOT NULL 해제', `ALTER TABLE licenses ALTER COLUMN plan DROP NOT NULL`],
  ['licenses.duration_ms NOT NULL 해제', `ALTER TABLE licenses ALTER COLUMN duration_ms DROP NOT NULL`],

  ['licenses 컬럼 확장', `
    ALTER TABLE licenses
      ADD COLUMN IF NOT EXISTS device_fp      TEXT,
      ADD COLUMN IF NOT EXISTS session_token  TEXT,
      ADD COLUMN IF NOT EXISTS session_at     BIGINT,
      ADD COLUMN IF NOT EXISTS reset_count    INT DEFAULT 0,
      ADD COLUMN IF NOT EXISTS last_reset_at  BIGINT,
      ADD COLUMN IF NOT EXISTS app_sig        TEXT,
      ADD COLUMN IF NOT EXISTS blocked_reason TEXT,
      ADD COLUMN IF NOT EXISTS owner_name     TEXT,
      ADD COLUMN IF NOT EXISTS owner_contact  TEXT`],

  ['entitlements 생성', `
    CREATE TABLE IF NOT EXISTS entitlements (
      key         TEXT NOT NULL REFERENCES licenses(key) ON DELETE CASCADE,
      feature     TEXT NOT NULL,
      plan        TEXT,
      starts_at   BIGINT,
      duration_ms BIGINT NOT NULL,
      expires_at  BIGINT,
      created_at  BIGINT NOT NULL,
      PRIMARY KEY (key, feature)
    )`],

  ['app_signatures 생성', `
    CREATE TABLE IF NOT EXISTS app_signatures (
      sha256     TEXT PRIMARY KEY,
      label      TEXT,
      allowed    BOOLEAN DEFAULT TRUE,
      created_at BIGINT
    )`],

  ['audit_log 생성', `
    CREATE TABLE IF NOT EXISTS audit_log (
      id          BIGSERIAL PRIMARY KEY,
      at          BIGINT NOT NULL,
      key         TEXT,
      kind        TEXT,
      device_id   TEXT,
      device_name TEXT,
      detail      TEXT,
      ip          TEXT
    )`],

  ['orders 생성', `
    CREATE TABLE IF NOT EXISTS orders (
      id         TEXT PRIMARY KEY,
      created_at BIGINT NOT NULL,
      status     TEXT NOT NULL,
      features   TEXT NOT NULL,
      plan       TEXT NOT NULL,
      amount     INT NOT NULL,
      buyer_name TEXT,
      contact    TEXT,
      depositor  TEXT,
      memo       TEXT,
      target_key TEXT,
      issued_key TEXT,
      handled_at BIGINT
    )`],

  ['orders 컬럼 확장', `
    ALTER TABLE orders
      ADD COLUMN IF NOT EXISTS base_amount  INT,
      ADD COLUMN IF NOT EXISTS token        TEXT,
      ADD COLUMN IF NOT EXISTS needs_review BOOLEAN DEFAULT FALSE,
      ADD COLUMN IF NOT EXISTS auto_canceled BOOLEAN DEFAULT FALSE,
      ADD COLUMN IF NOT EXISTS android_ok   BOOLEAN DEFAULT FALSE`],

  ['orders.base_amount 채우기', `UPDATE orders SET base_amount=amount WHERE base_amount IS NULL`],

  ['deposits 생성', `
    CREATE TABLE IF NOT EXISTS deposits (
      id            BIGSERIAL PRIMARY KEY,
      at            BIGINT NOT NULL,
      amount        INT,
      name          TEXT,
      raw           TEXT NOT NULL,
      source        TEXT,
      raw_hash      TEXT NOT NULL,
      matched_order TEXT,
      status        TEXT NOT NULL
    )`],

  ['configs 생성', `
    CREATE TABLE IF NOT EXISTS configs (
      key        TEXT PRIMARY KEY,
      blob       TEXT,
      rev        BIGINT,
      updated_at BIGINT
    )`],

  ['인덱스', `CREATE INDEX IF NOT EXISTS idx_ent_key       ON entitlements (key)`],
  ['인덱스', `CREATE INDEX IF NOT EXISTS idx_audit_at      ON audit_log (at DESC)`],
  ['인덱스', `CREATE INDEX IF NOT EXISTS idx_audit_key     ON audit_log (key)`],
  ['인덱스', `CREATE INDEX IF NOT EXISTS idx_audit_kind    ON audit_log (kind)`],
  ['인덱스', `CREATE INDEX IF NOT EXISTS idx_orders_status ON orders (status, created_at DESC)`],
  ['인덱스', `CREATE INDEX IF NOT EXISTS idx_lic_device    ON licenses (device_id)`],
  ['인덱스', `CREATE INDEX IF NOT EXISTS idx_orders_amount ON orders (amount)`],
  ['인덱스', `CREATE UNIQUE INDEX IF NOT EXISTS deposits_dedupe ON deposits (raw_hash)`],
  ['인덱스', `CREATE INDEX IF NOT EXISTS idx_deposits_at   ON deposits (at DESC)`],

  // 카카오 발송 세션. sender/src/store.mjs 의 ensureSchema 와 같은 테이블이다.
  // 토큰 암호문만 token_ct 에 두고, 재시작해도 지우지 않는다.
  ['kakao_sessions 생성', `
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
    )`],

  // 관리 화면의 카카오 계정. 앱 기기 슬롯(licenses.device_id)과는 별개다.
  // 비밀번호 칸은 없다. 세션 토큰은 kakao_sessions 에만 있다.
  ['panel_accounts 생성', `
    CREATE TABLE IF NOT EXISTS panel_accounts (
      device_id   TEXT PRIMARY KEY,
      license_key TEXT NOT NULL,
      email       TEXT NOT NULL,
      created_at  BIGINT NOT NULL
    )`],
  ['panel_pending 생성', `
    CREATE TABLE IF NOT EXISTS panel_pending (
      pending_id  TEXT PRIMARY KEY,
      license_key TEXT NOT NULL,
      device_id   TEXT NOT NULL,
      email       TEXT NOT NULL,
      created_at  BIGINT NOT NULL,
      expires_at  BIGINT NOT NULL
    )`],
  ['인덱스', `CREATE INDEX IF NOT EXISTS idx_panel_accounts_key ON panel_accounts (license_key)`],
  ['인덱스', `CREATE INDEX IF NOT EXISTS idx_panel_pending_key ON panel_pending (license_key)`],
];

// 기존 행 백필: entitlements 가 하나도 없는 키는 macro 기능 보유로 옮긴다.
// plan / duration_ms / expires_at / starts_at(=activated_at) 을 그대로 가져간다.
const BACKFILL_SQL = `
  INSERT INTO entitlements (key, feature, plan, starts_at, duration_ms, expires_at, created_at)
  SELECT l.key, 'macro', l.plan, l.activated_at,
         COALESCE(l.duration_ms, 0), l.expires_at, COALESCE(l.created_at, $1)
    FROM licenses l
   WHERE NOT EXISTS (SELECT 1 FROM entitlements e WHERE e.key = l.key)
  ON CONFLICT (key, feature) DO NOTHING`;

async function migrate() {
  for (const [label, sql] of STEPS) {
    try {
      await q(sql);
    } catch (e) {
      console.error('[migrate] 실패 단계: ' + label + ' → ' + e.message);
      throw e;
    }
  }
  const r = await q(BACKFILL_SQL, [Date.now()]);
  if (r.rowCount > 0) console.log('[migrate] 기존 키 ' + r.rowCount + '개를 macro 기능으로 백필했습니다');
  console.log('[migrate] 스키마 준비 완료');
  return r.rowCount;
}

// ─────────────────────────────────────────────────────────────
// 값 변환 유틸 — pg 는 BIGINT 를 문자열로 준다. 앱/웹에 나갈 땐 숫자로 맞춘다.
// ─────────────────────────────────────────────────────────────
function num(v) { return v === null || v === undefined ? null : Number(v); }
function num0(v) { return v === null || v === undefined ? 0 : Number(v); }

// licenses 행 → JSON 안전 형태 (session_token 은 절대 밖으로 내보내지 않는다)
function shapeLicense(row) {
  if (!row) return null;
  return {
    key: row.key,
    plan: row.plan || null,
    duration_ms: num0(row.duration_ms),
    expires_at: num(row.expires_at),
    device_id: row.device_id || null,
    device_name: row.device_name || null,
    device_fp: row.device_fp || null,
    activated_at: num(row.activated_at),
    revoked: !!row.revoked,
    blocked_reason: row.blocked_reason || null,
    note: row.note || null,
    owner_name: row.owner_name || null,
    owner_contact: row.owner_contact || null,
    created_at: num0(row.created_at),
    last_seen: num(row.last_seen),
    has_session: !!row.session_token,
    session_at: num(row.session_at),
    reset_count: row.reset_count == null ? 0 : Number(row.reset_count),
    last_reset_at: num(row.last_reset_at),
    app_sig: row.app_sig || null,
    features: [],
  };
}

function shapeEnt(row) {
  return {
    feature: row.feature,
    plan: row.plan || null,
    starts_at: num(row.starts_at),
    duration_ms: num0(row.duration_ms),
    expires_at: num(row.expires_at),
    created_at: num0(row.created_at),
  };
}

function shapeAudit(row) {
  return {
    id: Number(row.id),
    at: num0(row.at),
    key: row.key || null,
    kind: row.kind || null,
    device_id: row.device_id || null,
    device_name: row.device_name || null,
    detail: row.detail || null,
    ip: row.ip || null,
  };
}

function shapeOrder(row) {
  if (!row) return null;
  return {
    id: row.id,
    created_at: num0(row.created_at),
    status: row.status,
    features: String(row.features || '').split(',').filter(Boolean),
    plan: row.plan,
    amount: Number(row.amount) || 0,
    buyer_name: row.buyer_name || null,
    contact: row.contact || null,
    depositor: row.depositor || null,
    memo: row.memo || null,
    target_key: row.target_key || null,
    issued_key: row.issued_key || null,
    handled_at: num(row.handled_at),
    base_amount: row.base_amount == null ? (Number(row.amount) || 0) : Number(row.base_amount),
    needs_review: !!row.needs_review,
    // 미입금으로 서버가 자동 취소한 주문 (관리자가 뒤늦은 입금을 보고 되살릴 수 있다)
    auto_canceled: !!row.auto_canceled,
    // 구매자가 "안드로이드에서 쓴다"를 체크했는지 (환불 분쟁 때 증거로 쓴다)
    android_ok: !!row.android_ok,
  };
}

// deposits 행 → JSON. raw(알림 원문)는 관리자만 본다.
function shapeDeposit(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    at: num0(row.at),
    amount: row.amount == null ? null : Number(row.amount),
    name: row.name || null,
    raw: row.raw || '',
    source: row.source || null,
    raw_hash: row.raw_hash || null,
    matched_order: row.matched_order || null,
    status: row.status || null,
  };
}

// 키 1건의 entitlements 를 읽어온다
async function entitlements(key, client) {
  const r = await q(
    'SELECT feature,plan,starts_at,duration_ms,expires_at,created_at FROM entitlements WHERE key=$1 ORDER BY feature',
    [key], client);
  return r.rows;
}

// licenses 의 구버전 호환 필드(expires_at / plan / duration_ms)를 entitlements 기준으로 다시 맞춘다.
// expires_at = 전체 기능 중 가장 늦은 만료 (전부 미개시면 NULL)
async function syncSummary(key, client) {
  const rows = await entitlements(key, client);
  if (!rows.length) {
    await q('UPDATE licenses SET expires_at=NULL WHERE key=$1', [key], client);
    return null;
  }
  let best = null, maxExp = null;
  for (const e of rows) {
    const exp = e.expires_at === null || e.expires_at === undefined ? null : Number(e.expires_at);
    if (exp !== null && (maxExp === null || exp > maxExp)) { maxExp = exp; best = e; }
  }
  if (!best) { // 아직 아무 기능도 개시 안 됨 → 기간이 가장 긴 걸 대표로
    for (const e of rows) if (!best || Number(e.duration_ms) > Number(best.duration_ms)) best = e;
  }
  await q(
    'UPDATE licenses SET expires_at=$1, plan=COALESCE($2,plan), duration_ms=COALESCE($3,duration_ms) WHERE key=$4',
    [maxExp, best ? (best.plan || null) : null, best ? Number(best.duration_ms) : null, key], client);
  return maxExp;
}

module.exports = {
  pool, q, one, tx, migrate,
  num, num0, entitlements, syncSummary,
  shapeLicense, shapeEnt, shapeAudit, shapeOrder, shapeDeposit,
};
