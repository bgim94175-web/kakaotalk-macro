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

  // ── ACCOUNTS V1 (docs/ACCOUNTS_V1.md 2.1) ─────────────────────────────
  // 회원 계정 · 상품 3종 · 방 설치형 봇. 문서 2.1 블록을 같은 순서로 한 문장씩 옮겼다.
  // 규칙: CREATE TABLE IF NOT EXISTS · ADD COLUMN IF NOT EXISTS · CREATE [UNIQUE] INDEX IF NOT EXISTS ·
  //       ALTER COLUMN … DROP NOT NULL 만. 시간은 전부 BIGINT 밀리초.
  // room_state · room_log 는 sender/src/store.mjs SCHEMA 에도 글자 그대로 넣는다(작업 3, sender 단독 실행용).

  // [회원]
  ['accounts-v1:members', `
    CREATE TABLE IF NOT EXISTS members (
      id                BIGSERIAL PRIMARY KEY,
      login_id          TEXT NOT NULL,
      pw_hash           TEXT NOT NULL,
      contact           TEXT,
      created_at        BIGINT NOT NULL,
      last_login_at     BIGINT,
      pw_changed_at     BIGINT,
      macro_until       BIGINT NOT NULL DEFAULT 0,   -- 카카오톡 매크로 만료(ms). 0 = 없음
      legacy_room_until BIGINT NOT NULL DEFAULT 0,   -- D20 계정 단위 옛 기능 유예 만료
      blocked_reason    TEXT,
      note              TEXT
    )`],
  ['accounts-v1:members_login_uq', `CREATE UNIQUE INDEX IF NOT EXISTS members_login_uq ON members (lower(login_id))`],

  ['accounts-v1:member_sessions', `
    CREATE TABLE IF NOT EXISTS member_sessions (
      id           TEXT PRIMARY KEY,                 -- sha256(쿠키 토큰) hex 64자
      member_id    BIGINT NOT NULL REFERENCES members(id),
      method       TEXT NOT NULL,                    -- 'pw' | 'google'
      created_at   BIGINT NOT NULL,
      auth_at      BIGINT NOT NULL,                  -- 마지막 인증 시각(비밀번호 재설정 창 계산)
      last_seen_at BIGINT NOT NULL,
      expires_at   BIGINT NOT NULL,
      revoked_at   BIGINT,
      revoked_why  TEXT,                             -- logout|cap|pw_change|logout_all|admin|blocked|revoke
      ip           TEXT,
      ua           TEXT
    )`],
  ['accounts-v1:idx_msess_member', `CREATE INDEX IF NOT EXISTS idx_msess_member ON member_sessions (member_id, last_seen_at DESC)`],

  ['accounts-v1:member_google', `
    CREATE TABLE IF NOT EXISTS member_google (
      member_id BIGINT PRIMARY KEY REFERENCES members(id),
      sub       TEXT NOT NULL,
      email     TEXT,
      linked_at BIGINT NOT NULL
    )`],
  ['accounts-v1:member_google_sub_uq', `CREATE UNIQUE INDEX IF NOT EXISTS member_google_sub_uq ON member_google (sub)`],

  // [기존 표에 회원 연결]
  ['accounts-v1:licenses.member_id', `
    ALTER TABLE licenses ADD COLUMN IF NOT EXISTS member_id BIGINT, ADD COLUMN IF NOT EXISTS claimed_at BIGINT`],
  ['accounts-v1:panel_accounts.member_id', `ALTER TABLE panel_accounts ADD COLUMN IF NOT EXISTS member_id BIGINT`],
  ['accounts-v1:panel_accounts.license_key NOT NULL 해제', `ALTER TABLE panel_accounts ALTER COLUMN license_key DROP NOT NULL`],
  ['accounts-v1:panel_pending.member_id', `ALTER TABLE panel_pending ADD COLUMN IF NOT EXISTS member_id BIGINT`],
  ['accounts-v1:panel_pending.license_key NOT NULL 해제', `ALTER TABLE panel_pending ALTER COLUMN license_key DROP NOT NULL`],
  ['accounts-v1:audit_log.member_id', `ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS member_id BIGINT`],
  ['accounts-v1:orders 컬럼 확장', `
    ALTER TABLE orders
      ADD COLUMN IF NOT EXISTS member_id BIGINT,
      ADD COLUMN IF NOT EXISTS kind      TEXT,       -- 'member' = 새 주문. NULL = 예전 키 주문
      ADD COLUMN IF NOT EXISTS items     JSONB,      -- 2.3
      ADD COLUMN IF NOT EXISTS applied   JSONB,      -- 2.3
      ADD COLUMN IF NOT EXISTS ip        TEXT,       -- 접수한 IP(IP당 미입금 상한, D22)
      ADD COLUMN IF NOT EXISTS terms_at  BIGINT      -- 이용 조건 확인 시각(방 줄이 있는 주문, D28)
  `],
  ['accounts-v1:idx_lic_member', `CREATE INDEX IF NOT EXISTS idx_lic_member ON licenses (member_id)`],
  ['accounts-v1:idx_panel_acc_member', `CREATE INDEX IF NOT EXISTS idx_panel_acc_member ON panel_accounts (member_id)`],
  ['accounts-v1:idx_panel_pend_member', `CREATE INDEX IF NOT EXISTS idx_panel_pend_member ON panel_pending (member_id)`],
  ['accounts-v1:idx_audit_member', `CREATE INDEX IF NOT EXISTS idx_audit_member ON audit_log (member_id)`],
  ['accounts-v1:idx_orders_member', `CREATE INDEX IF NOT EXISTS idx_orders_member ON orders (member_id, created_at DESC)`],

  // [봇 계정 풀]
  ['accounts-v1:bot_accounts', `
    CREATE TABLE IF NOT EXISTS bot_accounts (
      device_id  TEXT PRIMARY KEY,                   -- 'bot.' + 16 hex
      email      TEXT NOT NULL,                      -- 카카오계정 (관리자 표시용)
      label      TEXT,
      nickname   TEXT,                               -- sender 가 접속할 때 채운다
      room_cap   INT NOT NULL DEFAULT 20,
      enabled    BOOLEAN NOT NULL DEFAULT TRUE,      -- FALSE = 새 배정 중지(맡은 방은 유지)
      state      TEXT NOT NULL DEFAULT 'pending',    -- sender 가 씀: pending|connected|down|needs_register
      state_at   BIGINT,
      created_at BIGINT NOT NULL,
      removed_at BIGINT,
      note       TEXT
    )`],
  ['accounts-v1:bot_pending', `
    CREATE TABLE IF NOT EXISTS bot_pending (
      pending_id TEXT PRIMARY KEY,
      device_id  TEXT NOT NULL,
      email      TEXT NOT NULL,
      label      TEXT,
      room_cap   INT,
      created_at BIGINT NOT NULL,
      expires_at BIGINT NOT NULL
    )`],

  // [방 설치]
  ['accounts-v1:room_installs', `
    CREATE TABLE IF NOT EXISTS room_installs (
      id            BIGSERIAL PRIMARY KEY,
      member_id     BIGINT NOT NULL REFERENCES members(id),
      link_url      TEXT NOT NULL,                   -- 정규화한 https://open.kakao.com/o/XXXX
      link_id       TEXT,                            -- 10진 문자열. 아직 조회 전이면 NULL
      link_name     TEXT,
      passcode_ct   TEXT,                            -- 참여코드 봉인값(lib/secretbox.js). 없으면 NULL
      roombot       BOOLEAN NOT NULL DEFAULT FALSE,  -- 결제(또는 지급)된 상품
      minigame      BOOLEAN NOT NULL DEFAULT FALSE,
      phase         TEXT NOT NULL,                   -- 부모가 씀: pending_payment|installed|canceled|removed
      order_id      TEXT,                            -- 이 행을 만든 주문. 관리자 지급이면 NULL
      bot_device_id TEXT,                            -- 부모가 배정
      hold_reason   TEXT,                            -- D28 운영자 확인 대기. NULL 이 아니면 sender 가 입장하지 않음
      retry_n       INT NOT NULL DEFAULT 0,          -- 고객 연속 다시 시도 횟수(3.4.3). 입장 성공 뒤 첫 다시 시도에서 0 으로
      state         TEXT NOT NULL DEFAULT 'queued',  -- sender 가 씀(부모는 queued 로 되돌릴 때만, 2.2): queued|joining|waiting_host|active|error
      error_code    TEXT,                            -- 5.6
      error_detail  TEXT,                            -- 원시 status·짧은 설명(관리자용)
      chat_id       TEXT,
      perm          INT,
      perm_at       BIGINT,
      joined_at     BIGINT,
      state_at      BIGINT,
      next_try_at   BIGINT,                          -- 입장 재시도 예정(속도 제한 대기)
      retry_at      BIGINT,                          -- 마지막 수동 다시 시도
      attempts      INT NOT NULL DEFAULT 0,
      config        JSONB NOT NULL DEFAULT '{}',     -- 7.1
      config_rev    INT NOT NULL DEFAULT 0,
      config_at     BIGINT,
      created_at    BIGINT NOT NULL,
      installed_at  BIGINT,
      removed_at    BIGINT,
      note          TEXT
    )`],
  // 결제된 설치만 배타적이다(D8·D9). 내보내진 설치(error_code='kicked')는 배타권을 잃는다.
  ['accounts-v1:room_installs_link_uq', `
    CREATE UNIQUE INDEX IF NOT EXISTS room_installs_link_uq ON room_installs (link_id)
      WHERE link_id IS NOT NULL AND phase = 'installed' AND error_code IS DISTINCT FROM 'kicked'`],
  ['accounts-v1:room_installs_url_uq', `
    CREATE UNIQUE INDEX IF NOT EXISTS room_installs_url_uq ON room_installs (link_url)
      WHERE phase = 'installed' AND error_code IS DISTINCT FROM 'kicked'`],
  ['accounts-v1:idx_ri_member', `CREATE INDEX IF NOT EXISTS idx_ri_member ON room_installs (member_id, created_at DESC)`],
  ['accounts-v1:idx_ri_bot', `CREATE INDEX IF NOT EXISTS idx_ri_bot ON room_installs (bot_device_id) WHERE phase = 'installed'`],
  ['accounts-v1:idx_ri_state', `CREATE INDEX IF NOT EXISTS idx_ri_state ON room_installs (phase, state)`],
  ['accounts-v1:idx_ri_order', `CREATE INDEX IF NOT EXISTS idx_ri_order ON room_installs (order_id)`],
  ['accounts-v1:idx_ri_link', `CREATE INDEX IF NOT EXISTS idx_ri_link ON room_installs (link_id)`],
  ['accounts-v1:idx_ri_url', `CREATE INDEX IF NOT EXISTS idx_ri_url ON room_installs (link_url)`],

  // 나가기 대기열(옮기기·해제·링크 바꾸기 때 부모가 넣고 sender 가 처리). 입장보다 먼저 처리한다(5.2)
  ['accounts-v1:room_leaves', `
    CREATE TABLE IF NOT EXISTS room_leaves (
      id            BIGSERIAL PRIMARY KEY,
      install_id    BIGINT NOT NULL,
      bot_device_id TEXT NOT NULL,                   -- 나갈 봇
      chat_id       TEXT,                            -- 넣을 때의 room_installs.chat_id 복사본(NULL 이면 link_id 로 찾음)
      link_id       TEXT,
      why           TEXT NOT NULL,                   -- move|remove|rebind|block
      created_at    BIGINT NOT NULL,
      done_at       BIGINT,
      result        TEXT                             -- left|kept|not_in_room|failed:<status>
    )`],
  ['accounts-v1:idx_room_leaves_todo', `CREATE INDEX IF NOT EXISTS idx_room_leaves_todo ON room_leaves (bot_device_id) WHERE done_at IS NULL`],

  // 설치 금지 방(D28)
  ['accounts-v1:room_blocklist', `
    CREATE TABLE IF NOT EXISTS room_blocklist (
      id         BIGSERIAL PRIMARY KEY,
      link_id    TEXT,
      link_url   TEXT,
      reason     TEXT NOT NULL,
      created_at BIGINT NOT NULL
    )`],
  ['accounts-v1:room_block_link_uq', `CREATE UNIQUE INDEX IF NOT EXISTS room_block_link_uq ON room_blocklist (link_id) WHERE link_id IS NOT NULL`],
  ['accounts-v1:room_block_url_uq', `CREATE UNIQUE INDEX IF NOT EXISTS room_block_url_uq ON room_blocklist (link_url) WHERE link_url IS NOT NULL`],

  // [sender 소유: 방별 실행 상태와 조치 기록]
  ['accounts-v1:room_state', `
    CREATE TABLE IF NOT EXISTS room_state (
      install_id BIGINT PRIMARY KEY,
      runtime    JSONB NOT NULL DEFAULT '{}',
      updated_at BIGINT NOT NULL
    )`],
  ['accounts-v1:room_log', `
    CREATE TABLE IF NOT EXISTS room_log (
      id         BIGSERIAL PRIMARY KEY,
      install_id BIGINT NOT NULL,
      at         BIGINT NOT NULL,
      kind       TEXT NOT NULL,                      -- 7.8
      user_id    TEXT,
      name       TEXT,
      ok         BOOLEAN NOT NULL DEFAULT TRUE,
      detail     JSONB NOT NULL DEFAULT '{}'
    )`],
  ['accounts-v1:idx_room_log', `CREATE INDEX IF NOT EXISTS idx_room_log ON room_log (install_id, at DESC)`],

  // [봇 오픈프로필(D12)] 봇은 고객 방에 카카오톡 기본 프로필이 아니라 그 계정의 오픈프로필로 들어간다.
  // sender 가 open_profiles(SYNCLINK 로 읽은 목록 [{li,name,url}], NULL = 읽은 적 없음, [] = 없음)·open_profile_li·
  // open_profile_name(지금 입장에 쓰는 것)·open_profile_at 을 쓰고, 부모(관리자)가 open_profile_pick 을 쓴다(2.2).
  // 칸 추가뿐이고 모두 NULL 허용이라 운영 DB 에 그대로 붙는다.
  ['accounts-v1:bot_accounts.open_profile', `
    ALTER TABLE bot_accounts
      ADD COLUMN IF NOT EXISTS open_profiles     JSONB,
      ADD COLUMN IF NOT EXISTS open_profile_pick TEXT,
      ADD COLUMN IF NOT EXISTS open_profile_li   TEXT,
      ADD COLUMN IF NOT EXISTS open_profile_name TEXT,
      ADD COLUMN IF NOT EXISTS open_profile_at   BIGINT`],
  // 재등록을 시작할 때 이미 붙어 있던 봇인가. 그렇다면 '붙어 있다'만으로 휴대폰 확인을 마쳤다고 보지 않는다(서버가 다시 시작해도 남게 DB 에 둔다).
  ['accounts-v1:bot_pending.was_linked', `ALTER TABLE bot_pending ADD COLUMN IF NOT EXISTS was_linked BOOLEAN NOT NULL DEFAULT FALSE`],

  // [sender 소유: 방 멤버 명부] 봇이 방에 들어간 뒤 모은 닉네임·옾링(sender/src/store.mjs SCHEMA 와 같은 글).
  ['members-v1:room_members', `
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
    )`],

  // [운영 한도] 관리자가 /manage [설정]에서 바꾸는 값(lib/settings.js). 없는 키는 기본값을 쓴다.
  ['settings-v1:app_settings', `
    CREATE TABLE IF NOT EXISTS app_settings (
      key        TEXT PRIMARY KEY,
      value      JSONB NOT NULL,
      updated_at BIGINT NOT NULL
    )`],
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

// JSONB 칸: pg 는 객체로 준다. 문자열로 들어온 경우(직접 넣은 행)도 풀어 준다. 못 읽으면 null.
function jsonOf(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'string') {
    try { return JSON.parse(v); } catch (e) { return null; }
  }
  return v;
}

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
    member_id: num(row.member_id),
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
    // 회원 주문(docs/ACCOUNTS_V1.md 2.3). 예전 키 주문은 member_id·kind·items·applied 가 null 이다.
    member_id: num(row.member_id),
    kind: row.kind || null,
    items: Array.isArray(jsonOf(row.items)) ? jsonOf(row.items) : null,
    applied: jsonOf(row.applied),
    // orders.android_ok 열은 단종된 앱 시절 "안드로이드 확인" 체크 기록이다.
    // 열은 지우지 않지만(운영 데이터) 더 쓰지도 내보내지도 않는다.
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
  num, num0, jsonOf, entitlements, syncSummary,
  shapeLicense, shapeEnt, shapeAudit, shapeOrder, shapeDeposit,
};
