// 관리자 API — 헤더 x-admin-password 로 보호. 관리자 응답은 서명하지 않는다.
'use strict';

const express = require('express');
const crypto = require('crypto');
const db = require('../lib/db');
const keys = require('../lib/keys');
const features = require('../lib/features');
const audit = require('../lib/audit');
const pricing = require('../lib/pricing');
const license = require('./license');
const rl = require('../lib/ratelimit');

const router = express.Router();

const wrap = (fn) => (req, res) => Promise.resolve(fn(req, res)).catch((e) => {
  console.error('[' + req.method + ' ' + req.originalUrl + '] ' + (e && e.stack ? e.stack : e));
  if (!res.headersSent) res.status(500).json({ ok: false, error: 'server_error' });
});

function clamp(v, lo, hi, dflt) {
  const n = Math.floor(Number(v));
  if (!isFinite(n)) return dflt;
  return Math.min(Math.max(n, lo), hi);
}

// 공개된 기본값 — 이 값이 그대로 들어있으면 비밀번호가 없는 것과 같다
const DEFAULT_PW = 'change-me-now';

// 관리자 API 를 열어도 되는 상태인지. 문제가 있으면 사람이 읽을 사유를 돌려준다.
function passwordProblem() {
  const raw = process.env.ADMIN_PASSWORD;
  const pw = (raw === null || raw === undefined) ? '' : String(raw);
  if (!pw.trim()) return 'ADMIN_PASSWORD 환경변수가 비어 있어';
  if (pw === DEFAULT_PW) return 'ADMIN_PASSWORD 가 공개된 기본값(' + DEFAULT_PW + ') 그대로야';
  return null;
}

// 비밀번호 비교. 길이가 달라도 같은 시간이 걸리게 sha256 을 떠서 비교한다
// (예전 구현은 길이가 다르면 즉시 false 라서 응답시간으로 길이를 알아낼 수 있었다).
function pwOk(given) {
  if (passwordProblem()) return false;
  const want = String(process.env.ADMIN_PASSWORD);
  const g = crypto.createHash('sha256').update(String(given === null || given === undefined ? '' : given), 'utf8').digest();
  const w = crypto.createHash('sha256').update(want, 'utf8').digest();
  try { return crypto.timingSafeEqual(g, w); } catch (e) { return false; }
}

let warnedProblem = '';

async function guard(req, res, next) {
  // ── 비밀번호가 없거나 기본값이면 관리자 API 를 통째로 닫는다 (503)
  const problem = passwordProblem();
  if (problem) {
    if (warnedProblem !== problem) {
      warnedProblem = problem;
      console.error('[admin] ★ 관리자 API 전체를 503 으로 막았어 — ' + problem +
                    ' / ADMIN_PASSWORD 를 제대로 설정하고 다시 배포해라');
    }
    return res.status(503).json({ ok: false, error: 'admin_disabled',
      reason: 'admin_password_unset',
      detail: '서버에 관리자 비밀번호가 설정돼 있지 않아서 관리자 API 를 닫아뒀어. ' +
              '서버 환경변수 ADMIN_PASSWORD 를 채우고 다시 배포해줘' });
  }
  warnedProblem = '';

  const ip = rl.ipOf(req);

  // ── 연속 실패로 차단된 IP (server.js 에서도 막지만, 라우터 단독 사용도 대비한다)
  const left = rl.adminBlockedMs(ip);
  if (left > 0) {
    const mins = Math.ceil(left / 60000);
    res.set('Retry-After', String(Math.ceil(left / 1000)));
    return res.status(429).json({ ok: false, error: 'too_many_attempts',
      detail: '비밀번호를 너무 많이 틀렸어. ' + mins + '분 뒤에 다시 해줘' });
  }

  // ── 인증 실패는 기록한다 (관리자앱 [기록] 탭에서 공격을 눈으로 볼 수 있게)
  if (!pwOk(req.header('x-admin-password'))) {
    const st = rl.noteAdminFail(ip);
    console.log('[admin] 비밀번호 틀림 ' + ip + ' ' + req.method + ' ' + req.path +
                ' (' + st.fails + '회' + (st.blocked ? ' → ' + Math.round(st.blockMs / 60000) + '분 차단' : '') + ')');
    await audit.record(req, 'bad_admin_pw', {
      detail: '관리자 비밀번호 틀림 ' + req.method + ' ' + req.path + ' / 연속 ' + st.fails + '회' +
              (st.blocked ? ' → ' + Math.round(st.blockMs / 60000) + '분 차단' : ''),
    });
    if (st.blocked) {
      res.set('Retry-After', String(Math.ceil(st.blockMs / 1000)));
      return res.status(429).json({ ok: false, error: 'too_many_attempts',
        detail: '비밀번호를 너무 많이 틀렸어. ' + Math.round(st.blockMs / 60000) + '분 뒤에 다시 해줘' });
    }
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }

  // 성공 → 실패 카운터 리셋. 조회까지 전부 서버 로그에 남겨서 유출에 흔적이 남게 한다.
  rl.clearAdminFails(ip);
  console.log('[admin] ' + req.method + ' ' + req.path + ' ip=' + ip);
  next();
}

// guard 는 async 다 → 에러를 삼키지 않고 express 에러 핸들러로 넘긴다
router.use('/admin', (req, res, next) => Promise.resolve(guard(req, res, next)).catch(next));

// 여러 키의 entitlements 를 한 번에 붙여준다
async function attachFeatures(shaped) {
  if (!shaped.length) return shaped;
  const list = shaped.map((x) => x.key);
  const r = await db.q(
    'SELECT key,feature,plan,starts_at,duration_ms,expires_at,created_at FROM entitlements WHERE key = ANY($1::text[]) ORDER BY feature',
    [list]);
  const byKey = {};
  for (const row of r.rows) {
    if (!byKey[row.key]) byKey[row.key] = [];
    byKey[row.key].push(db.shapeEnt(row));
  }
  for (const x of shaped) x.features = byKey[x.key] || [];
  return shaped;
}

// ─────────────────────────────────────────────────────────────
// 키 발급 / 연장
// ─────────────────────────────────────────────────────────────
router.post('/admin/create', wrap(async (req, res) => {
  const b = req.body || {};
  const feats = features.normList(b.features);
  if (!feats.length) return res.json({ ok: false, error: '기능을 하나 이상 골라야 해 (macro/roombot/minigame)' });
  const plan = String(b.plan || 'month');
  const dur = keys.durationMs(plan, b.days);
  if (!dur) return res.json({ ok: false, error: '플랜(month/quarter/year/custom) 또는 days 가 잘못됐어' });

  const out = await db.tx((client) => keys.createLicenses(client, {
    features: feats, plan: plan, days: b.days, count: b.count,
    note: b.note, owner_name: b.owner_name, owner_contact: b.owner_contact,
  }));

  res.json({ ok: true, keys: out.keys, features: out.features, plan: plan,
             duration_days: out.duration_days });
}));

router.post('/admin/grant', wrap(async (req, res) => {
  const b = req.body || {};
  const key = keys.normKey(b.key);
  if (!key) return res.json({ ok: false, error: 'key 가 필요해' });
  const feats = features.normList(b.features);
  if (!feats.length) return res.json({ ok: false, error: '기능을 하나 이상 골라야 해' });
  const plan = String(b.plan || 'month');
  if (!keys.durationMs(plan, b.days)) return res.json({ ok: false, error: '플랜 또는 days 가 잘못됐어' });

  const out = await db.tx((client) => keys.grant(client, key, feats, plan, b.days));
  if (!out) return res.json({ ok: false, error: '없는 키야' });
  res.json({ ok: true, key: key, plan: plan, duration_days: out.duration_days,
             changed: out.changed, activated: out.activated });
}));

router.post('/admin/revoke-feature', wrap(async (req, res) => {
  const b = req.body || {};
  const key = keys.normKey(b.key);
  const feature = String(b.feature || '').trim().toLowerCase();
  if (!key || !features.isValid(feature)) return res.json({ ok: false, error: 'key / feature 확인해' });

  const removed = await db.tx(async (client) => {
    const r = await db.q('DELETE FROM entitlements WHERE key=$1 AND feature=$2', [key, feature], client);
    if (r.rowCount > 0) await db.syncSummary(key, client);
    return r.rowCount;
  });
  res.json({ ok: removed > 0, key: key, feature: feature, removed: removed });
}));

// ─────────────────────────────────────────────────────────────
// 조회
// ─────────────────────────────────────────────────────────────
router.get('/admin/list', wrap(async (req, res) => {
  const term = String(req.query.q || '').trim();
  const limit = clamp(req.query.limit, 1, 500, 100);
  const offset = clamp(req.query.offset, 0, 1000000, 0);

  let where = '';
  const params = [];
  if (term) {
    params.push('%' + term + '%');
    where = ` WHERE key ILIKE $1 OR note ILIKE $1 OR owner_name ILIKE $1
                 OR owner_contact ILIKE $1 OR device_name ILIKE $1 OR device_id ILIKE $1`;
  }
  const cnt = await db.q('SELECT COUNT(*)::int AS n FROM licenses' + where, params);
  const rows = await db.q(
    'SELECT * FROM licenses' + where + ' ORDER BY created_at DESC LIMIT $' +
    (params.length + 1) + ' OFFSET $' + (params.length + 2),
    params.concat([limit, offset]));

  const shaped = await attachFeatures(rows.rows.map(db.shapeLicense));
  res.json({ ok: true, now: Date.now(), total: cnt.rows[0].n,
             limit: limit, offset: offset, licenses: shaped });
}));

router.get('/admin/license', wrap(async (req, res) => {
  const key = keys.normKey(req.query.key);
  if (!key) return res.json({ ok: false, error: 'key 가 필요해' });
  const row = await db.one('SELECT * FROM licenses WHERE key=$1', [key]);
  if (!row) return res.json({ ok: false, error: '없는 키야' });
  const shaped = (await attachFeatures([db.shapeLicense(row)]))[0];
  const a = await db.q('SELECT * FROM audit_log WHERE key=$1 ORDER BY at DESC, id DESC LIMIT 20', [key]);
  const cfg = await db.one('SELECT rev, updated_at FROM configs WHERE key=$1', [key]);
  res.json({
    ok: true, now: Date.now(), license: shaped,
    audit: a.rows.map(db.shapeAudit),
    config: cfg ? { rev: Number(cfg.rev) || 0, updated_at: Number(cfg.updated_at) || 0 } : null,
  });
}));

router.get('/admin/audit', wrap(async (req, res) => {
  const key = keys.normKey(req.query.key);
  const kind = String(req.query.kind || '').trim().toLowerCase();
  const limit = clamp(req.query.limit, 1, 500, 100);
  const cond = [];
  const params = [];
  if (key) { params.push(key); cond.push('key=$' + params.length); }
  if (kind) { params.push(kind); cond.push('kind=$' + params.length); }
  params.push(limit);
  const r = await db.q(
    'SELECT * FROM audit_log' + (cond.length ? ' WHERE ' + cond.join(' AND ') : '') +
    ' ORDER BY at DESC, id DESC LIMIT $' + params.length, params);
  res.json({ ok: true, now: Date.now(), kinds: audit.KINDS, alert_kinds: audit.ALERT_KINDS,
             audit: r.rows.map(db.shapeAudit) });
}));

router.get('/admin/stats', wrap(async (req, res) => {
  const now = Date.now();
  const week = now + 7 * 86400000;

  const total = (await db.q('SELECT COUNT(*)::int AS n FROM licenses')).rows[0].n;
  const active = (await db.q(
    `SELECT COUNT(DISTINCT e.key)::int AS n FROM entitlements e
       JOIN licenses l ON l.key = e.key
      WHERE e.expires_at > $1 AND COALESCE(l.revoked,FALSE)=FALSE AND l.blocked_reason IS NULL`,
    [now])).rows[0].n;
  const expiring = (await db.q(
    `SELECT COUNT(*)::int AS n FROM (
       SELECT e.key, MAX(e.expires_at) AS m FROM entitlements e
         JOIN licenses l ON l.key = e.key
        WHERE COALESCE(l.revoked,FALSE)=FALSE AND l.blocked_reason IS NULL
        GROUP BY e.key) t
      WHERE t.m > $1 AND t.m <= $2`, [now, week])).rows[0].n;
  const byFeat = (await db.q(
    'SELECT feature, COUNT(*)::int AS n FROM entitlements WHERE expires_at > $1 GROUP BY feature', [now])).rows;
  const pending = (await db.q("SELECT COUNT(*)::int AS n FROM orders WHERE status='pending'")).rows[0].n;
  const revoked = (await db.q('SELECT COUNT(*)::int AS n FROM licenses WHERE COALESCE(revoked,FALSE)=TRUE')).rows[0].n;
  const blocked = (await db.q('SELECT COUNT(*)::int AS n FROM licenses WHERE blocked_reason IS NOT NULL')).rows[0].n;
  const deposits = (await db.q(
    "SELECT COUNT(*)::int AS n FROM deposits WHERE status IN ('unmatched','ambiguous')")).rows[0].n;

  const by_feature = {};
  for (const f of features.ALL) by_feature[f] = 0;
  for (const r of byFeat) if (by_feature[r.feature] !== undefined) by_feature[r.feature] = r.n;

  res.json({ ok: true, now: now, total: total, active: active, expiring_7d: expiring,
             by_feature: by_feature, pending_orders: pending,
             revoked: revoked, blocked: blocked, deposits_attention: deposits });
}));

// ─────────────────────────────────────────────────────────────
// 상태 변경
// ─────────────────────────────────────────────────────────────
router.post('/admin/revoke', wrap(async (req, res) => {
  const b = req.body || {};
  const key = keys.normKey(b.key);
  const revoked = b.revoked === undefined ? true : !!b.revoked;
  if (!key) return res.json({ ok: false, error: 'key 가 필요해' });
  const r = await db.q('UPDATE licenses SET revoked=$1 WHERE key=$2', [revoked, key]);
  if (r.rowCount > 0) {
    await audit.record(req, 'revoked', { key: key, detail: revoked ? '관리자 회수' : '관리자 회수 해제' });
  }
  res.json({ ok: r.rowCount > 0, key: key, revoked: revoked });
}));

router.post('/admin/block', wrap(async (req, res) => {
  const b = req.body || {};
  const key = keys.normKey(b.key);
  if (!key) return res.json({ ok: false, error: 'key 가 필요해' });
  const reason = (b.reason === null || b.reason === undefined || String(b.reason).trim() === '')
    ? null : String(b.reason).trim().slice(0, 500);
  const r = await db.q('UPDATE licenses SET blocked_reason=$1 WHERE key=$2', [reason, key]);
  if (r.rowCount > 0) {
    await audit.record(req, 'revoked', { key: key, detail: reason ? '차단: ' + reason : '차단 해제' });
  }
  res.json({ ok: r.rowCount > 0, key: key, blocked_reason: reason });
}));

// 기기 고정 해제. 기간(entitlements)은 건드리지 않는다 — 이미 산 기간은 계속 흐른다.
router.post('/admin/reset-device', wrap(async (req, res) => {
  const b = req.body || {};
  const key = keys.normKey(b.key);
  if (!key) return res.json({ ok: false, error: 'key 가 필요해' });
  const now = Date.now();
  const r = await db.q(
    `UPDATE licenses SET device_id=NULL, device_name=NULL, device_fp=NULL,
            session_token=NULL, session_at=NULL,
            reset_count=COALESCE(reset_count,0)+1, last_reset_at=$1::bigint
      WHERE key=$2
      RETURNING reset_count`, [now, key]);
  if (!r.rowCount) return res.json({ ok: false, error: '없는 키야' });
  const cnt = Number(r.rows[0].reset_count) || 0;
  await audit.record(req, 'reset', { key: key, detail: '관리자 기기 초기화 (누적 ' + cnt + '회)' });
  res.json({ ok: true, key: key, reset_count: cnt });
}));

router.post('/admin/delete', wrap(async (req, res) => {
  const key = keys.normKey((req.body || {}).key);
  if (!key) return res.json({ ok: false, error: 'key 가 필요해' });
  const removed = await db.tx(async (client) => {
    await db.q('DELETE FROM configs WHERE key=$1', [key], client);
    const r = await db.q('DELETE FROM licenses WHERE key=$1', [key], client); // entitlements 는 CASCADE
    return r.rowCount;
  });
  if (removed > 0) await audit.record(req, 'revoked', { key: key, detail: '관리자 키 삭제' });
  res.json({ ok: removed > 0, key: key });
}));

// ─────────────────────────────────────────────────────────────
// 주문
// ─────────────────────────────────────────────────────────────
router.get('/admin/orders', wrap(async (req, res) => {
  const status = String(req.query.status || '').trim().toLowerCase();
  const limit = clamp(req.query.limit, 1, 500, 200);
  const params = [];
  let where = '';
  if (status) { params.push(status); where = ' WHERE status=$1'; }
  params.push(limit);
  const r = await db.q(
    'SELECT * FROM orders' + where + ' ORDER BY created_at DESC LIMIT $' + params.length, params);
  // shapeOrder 가 android_ok(아이폰 확인 체크 여부)까지 실어준다 → 관리자앱이 환불 분쟁 때 본다
  res.json({ ok: true, now: Date.now(), bank: pricing.bankInfo(), orders: r.rows.map(db.shapeOrder) });
}));

router.post('/admin/order-approve', wrap(async (req, res) => {
  const b = req.body || {};
  const id = keys.normOrderId(b.id);
  if (!id) return res.json({ ok: false, error: 'id 가 필요해' });
  const askedKey = keys.normKey(b.key);

  // 자동 입금확인(POST /api/deposit-hook)과 **같은 로직**을 쓴다
  const out = await db.tx((client) => keys.approveOrder(client, id, askedKey));

  if (out.error) return res.json({ ok: false, error: out.error });
  if (!out.already) {
    await audit.record(req, 'order', { key: out.key,
      detail: '주문 승인 ' + id + ' / ' + (out.issued ? '신규발급' : '기존키 연장') +
              ' / 기능=' + (out.features || []).join(',') + ' / 플랜=' + out.plan });
  }
  res.json({ ok: true, id: id, key: out.key, issued: !!out.issued, already: !!out.already });
}));

router.post('/admin/order-cancel', wrap(async (req, res) => {
  const b = req.body || {};
  const id = keys.normOrderId(b.id);
  if (!id) return res.json({ ok: false, error: 'id 가 필요해' });
  const memo = b.memo === null || b.memo === undefined ? null : String(b.memo).trim().slice(0, 500);
  const now = Date.now();
  const r = await db.q(
    `UPDATE orders SET status='canceled', handled_at=$1::bigint,
            memo = CASE WHEN $2::text IS NULL THEN memo
                        ELSE COALESCE(memo || ' / ', '') || $2::text END
      WHERE id=$3 AND status <> 'done'`, [now, memo, id]);
  if (r.rowCount > 0) await audit.record(req, 'order', { detail: '주문 취소 ' + id + (memo ? ' / ' + memo : '') });
  res.json({ ok: r.rowCount > 0, id: id });
}));

// ─────────────────────────────────────────────────────────────
// 입금 내역 (자동 입금확인)
// ─────────────────────────────────────────────────────────────
router.get('/admin/deposits', wrap(async (req, res) => {
  const status = String(req.query.status || '').trim().toLowerCase();
  const limit = clamp(req.query.limit, 1, 500, 100);
  const params = [];
  let where = '';
  if (status) { params.push(status); where = ' WHERE status=$1'; }
  params.push(limit);
  const r = await db.q(
    'SELECT * FROM deposits' + where + ' ORDER BY at DESC, id DESC LIMIT $' + params.length, params);
  const pend = await db.q(
    "SELECT COUNT(*)::int AS n FROM deposits WHERE status IN ('unmatched','ambiguous')");
  res.json({
    ok: true, now: Date.now(),
    hook_enabled: !!String(process.env.DEPOSIT_TOKEN || '').trim(),
    auto_approve: String(process.env.DEPOSIT_AUTO_APPROVE || '1') !== '0',
    needs_attention: pend.rows[0].n,
    deposits: r.rows.map(db.shapeDeposit),
  });
}));

// 수동 매칭 → 주문 승인까지 수행
router.post('/admin/deposit-match', wrap(async (req, res) => {
  const b = req.body || {};
  const depositId = Math.floor(Number(b.deposit_id));
  const orderId = keys.normOrderId(b.order_id);
  if (!isFinite(depositId) || depositId <= 0) return res.json({ ok: false, error: 'deposit_id 가 필요해' });
  if (!orderId) return res.json({ ok: false, error: 'order_id 가 필요해' });

  const dep = await db.one('SELECT * FROM deposits WHERE id=$1', [depositId]);
  if (!dep) return res.json({ ok: false, error: '없는 입금 기록이야' });

  const out = await db.tx((client) => keys.approveOrder(client, orderId, null));
  if (out.error) return res.json({ ok: false, error: out.error });

  await db.q("UPDATE deposits SET status='matched', matched_order=$1 WHERE id=$2", [orderId, depositId]);
  if (!out.already) {
    await audit.record(req, 'order', { key: out.key,
      detail: '수동 입금 매칭 승인 주문=' + orderId + ' 입금기록=' + depositId +
              ' 입금자=' + (dep.name || '미상') });
  }
  res.json({ ok: true, deposit_id: depositId, order_id: orderId, key: out.key, already: !!out.already });
}));

router.post('/admin/deposit-ignore', wrap(async (req, res) => {
  const depositId = Math.floor(Number((req.body || {}).deposit_id));
  if (!isFinite(depositId) || depositId <= 0) return res.json({ ok: false, error: 'deposit_id 가 필요해' });
  const r = await db.q("UPDATE deposits SET status='ignored' WHERE id=$1", [depositId]);
  res.json({ ok: r.rowCount > 0, deposit_id: depositId });
}));

// ─────────────────────────────────────────────────────────────
// 앱 서명 허용목록
// ─────────────────────────────────────────────────────────────
router.get('/admin/sigs', wrap(async (req, res) => {
  const r = await db.q('SELECT sha256,label,allowed,created_at FROM app_signatures ORDER BY created_at DESC NULLS LAST');
  const env = String(process.env.ALLOWED_APP_SIGS || '')
    .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  res.json({
    ok: true,
    env_sigs: env,
    min_app_version: Number(process.env.MIN_APP_VERSION) || 0,
    sigs: r.rows.map((x) => ({
      sha256: x.sha256, label: x.label || null,
      allowed: x.allowed === null || x.allowed === undefined ? true : !!x.allowed,
      created_at: db.num0(x.created_at),
    })),
  });
}));

router.post('/admin/sig-add', wrap(async (req, res) => {
  const b = req.body || {};
  const sha = String(b.sha256 || '').trim().toLowerCase().replace(/[^0-9a-f]/g, '');
  if (sha.length !== 64) return res.json({ ok: false, error: 'sha256 은 64자 hex 여야 해' });
  await db.q(
    `INSERT INTO app_signatures (sha256,label,allowed,created_at) VALUES ($1,$2,TRUE,$3)
     ON CONFLICT (sha256) DO UPDATE SET label=COALESCE(EXCLUDED.label, app_signatures.label), allowed=TRUE`,
    [sha, b.label ? String(b.label).slice(0, 120) : null, Date.now()]);
  license.bustSigCache();
  res.json({ ok: true, sha256: sha });
}));

router.post('/admin/sig-del', wrap(async (req, res) => {
  const sha = String((req.body || {}).sha256 || '').trim().toLowerCase().replace(/[^0-9a-f]/g, '');
  if (!sha) return res.json({ ok: false, error: 'sha256 이 필요해' });
  const r = await db.q('DELETE FROM app_signatures WHERE sha256=$1', [sha]);
  license.bustSigCache();
  res.json({ ok: r.rowCount > 0, sha256: sha });
}));

module.exports = router;
module.exports.passwordProblem = passwordProblem;
