// 사용자앱 ↔ 서버 API — /verify, /heartbeat, /entitlements, /config, /pubkey
// 모든 사용자 응답은 Ed25519 서명된다.
// ★ 하위호환: 성공 응답의 키 순서는 ok,key,plan,expires_at,device_id 로 시작해야 하고
//   nonce,ts 는 맨 뒤여야 한다. v1.8 앱은 원문에서 sig 만 떼고 검증하니까 순서가 곧 계약이다.
// ★ config_key 는 /verify 성공 응답과, 세션을 증명한 /heartbeat 에만 싣는다.
//   세션 증명이 없는 /entitlements 에서는 session·config_key 를 둘 다 null 로 내린다
//   (필드는 순서 때문에 남겨둔다). 설정 복호화 키를 아무에게나 주면 SPEC 6.1 전제가 깨진다.
'use strict';

const express = require('express');
const db = require('../lib/db');
const signer = require('../lib/sign');
const features = require('../lib/features');
const keys = require('../lib/keys');
const audit = require('../lib/audit');

const router = express.Router();

// 앱이 얼마나 자주 재검증할지 / 오프라인 유예를 얼마나 줄지
const RECHECK_MS = Number(process.env.RECHECK_MS) || 6 * 3600 * 1000;    // 6시간
const GRACE_MS   = Number(process.env.GRACE_MS)   || 3 * 86400 * 1000;   // 3일
const MAX_BLOB   = 256 * 1024;                                          // 설정 백업 256KB
// 만료 audit 은 키마다 이 간격으로 한 번만 남긴다 (기록 탭이 expired 로 덮이는 걸 막는다)
const EXPIRED_AUDIT_MS = Number(process.env.EXPIRED_AUDIT_MS) || 6 * 3600 * 1000;

// 에러를 삼키지 않는다. 스택을 서버 로그에 남기고 500 을 준다.
const wrap = (fn) => (req, res) => Promise.resolve(fn(req, res)).catch((e) => {
  console.error('[' + req.method + ' ' + req.originalUrl + '] ' + (e && e.stack ? e.stack : e));
  if (!res.headersSent) res.status(500).json({ ok: false, error: 'server_error' });
});

// ── 앱 서명 허용목록 (ALLOWED_APP_SIGS + app_signatures 테이블). 30초 캐시.
let _sigCache = { at: 0, list: [] };
function bustSigCache() { _sigCache = { at: 0, list: [] }; }

async function allowedSigs() {
  const now = Date.now();
  if (_sigCache.at && now - _sigCache.at < 30000) return _sigCache.list;
  const env = String(process.env.ALLOWED_APP_SIGS || '')
    .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  let fromDb = [];
  try {
    const r = await db.q('SELECT sha256 FROM app_signatures WHERE allowed=TRUE');
    fromDb = r.rows.map((x) => String(x.sha256 || '').trim().toLowerCase()).filter(Boolean);
  } catch (e) {
    console.error('[license] 앱서명 목록 조회 실패 → 환경변수만 사용: ' + e.message);
  }
  const list = env.concat(fromDb);
  _sigCache = { at: now, list: list };
  return list;
}

// ── 서명 검사 강도. APP_SIG_MODE 환경변수로 정한다. 허용목록(env + DB)과 **분리**해야 한다.
//    예전엔 "목록이 비어있으면 통과" 였는데, 그러면 관리자앱에서 서명 하나를 추가하는 순간
//    app_sig 를 아예 안 보내는 구버전 앱(v1.8)이 전원 잠긴다. 그래서 강도를 따로 둔다.
//      off     — 검사 안 함
//      lenient — (기본) app_sig 를 보냈으면 목록과 대조, 안 보냈으면 통과 → 구버전과 공존 가능
//      strict  — app_sig 필수 + 목록에 있어야 함 → 구버전은 막힌다(전원 업데이트 후에 켜라)
function sigMode() {
  const m = String(process.env.APP_SIG_MODE || '').trim().toLowerCase();
  if (m === 'off' || m === 'strict' || m === 'lenient') return m;
  return 'lenient';
}

// 통과면 null, 막아야 하면 'bad_app_sig'.
async function sigProblem(appSig) {
  const mode = sigMode();
  if (mode === 'off') return null;
  const list = await allowedSigs();
  const s = String(appSig || '').trim().toLowerCase();

  if (!list.length) {
    // 목록이 비어 있으면 대조할 게 없다. strict 로 설정돼 있어도 전원을 잠그는 건 설정 실수가
    // 분명하니 막지 않고 크게 경고만 한다 (잠긴 사용자를 되살리는 게 훨씬 비싸다).
    if (mode === 'strict') {
      console.error('[license] APP_SIG_MODE=strict 인데 허용목록이 비어 있다 → lenient 로 동작한다. '
        + 'ALLOWED_APP_SIGS 에 정품 서명 SHA-256 을 넣어라 (docs/APP_SIGNATURE.txt)');
    }
    return null;
  }
  if (!s.length) return mode === 'strict' ? 'bad_app_sig' : null;  // 구버전은 lenient 에서만 통과
  return list.indexOf(s) >= 0 ? null : 'bad_app_sig';
}

// 하위호환용 래퍼 (기존 호출부가 boolean 을 기대한다)
async function sigOk(appSig) { return (await sigProblem(appSig)) === null; }

// ── 요청 값 정리
function pick(v, max) {
  if (v === null || v === undefined) return '';
  const s = String(v).trim();
  return s.length > max ? s.slice(0, max) : s;
}

function readCommon(src) {
  return {
    key: keys.normKey(src.key),
    deviceId: pick(src.device_id, 128),
    deviceName: pick(src.device_name, 120) || null,
    deviceFp: pick(src.device_fp, 128) || null,
    appSig: pick(src.app_sig, 128),
    appVer: Number(src.app_version) || 0,
    session: pick(src.session, 128),
    nonce: src.nonce === null || src.nonce === undefined ? null : pick(src.nonce, 128),
    tamper: pick(src.tamper, 2000),
  };
}

// ── 응답 조립 (★ 키 순서 고정)
function okBody(o) {
  return signer.sign({
    ok: true,
    key: o.key,
    plan: o.plan,
    expires_at: o.expires_at,
    device_id: o.device_id,
    features: o.features,
    session: o.session,
    config_key: o.config_key,
    recheck_ms: RECHECK_MS,
    grace_ms: GRACE_MS,
    purchase: o.purchase,
    nonce: o.nonce,
    ts: o.ts,
  });
}

function failBody(reason, nonce, ts) {
  return signer.sign({ ok: false, reason: reason, nonce: nonce === undefined ? null : nonce, ts: ts });
}

// 성공 응답 만들기 (featMap 은 이미 계산된 것)
// opts.withConfigKey = true 인 경로에서만 config_key 를 실어준다.
//   config_key 는 설정 복호화 키의 재료다(SPEC 6.1) → 세션 증명이 없는 경로에서는 절대 내리지 않는다.
//   ★ 필드 자체는 빼지 않고 null 로 둔다 — 응답 키 순서가 하위호환 계약이라서.
//   앱 License.str() 은 "null"/빈값을 기본값으로 바꿔주므로 보관본을 덮어쓰지 않는다.
function buildOk(req, key, deviceId, lic, featMap, session, nonce, now, opts) {
  const o = opts || {};
  return okBody({
    key: key,
    plan: features.bestPlan(featMap, lic ? lic.plan : null),
    expires_at: features.maxExpiry(featMap),
    device_id: deviceId,
    features: featMap,
    session: session || null,
    config_key: o.withConfigKey ? signer.configKey(key, deviceId) : null,
    purchase: features.purchaseBase(req) + '/buy',
    nonce: nonce,
    ts: now,
  });
}

// app_sig / MIN_APP_VERSION 검사. 강도는 APP_SIG_MODE 가 정한다 (sigProblem 주석 참고).
// lenient(기본) 에서는 필드를 아예 안 보내면 건너뛰고(구버전 호환), 보냈으면 반드시 목록에 있어야 한다.
// strict 에서는 필드가 없어도 막힌다 — /verify · /heartbeat · /entitlements 전부 같은 규칙이다.
async function appCheck(req, v, where) {
  if (await sigProblem(v.appSig)) {
    await audit.record(req, 'bad_sig', { key: v.key, device_id: v.deviceId, device_name: v.deviceName,
      detail: where + ' app_sig=' + v.appSig + ' ver=' + (v.appVer || '-') });
    return 'bad_app_sig';
  }
  const minVer = Number(process.env.MIN_APP_VERSION) || 0;
  if (minVer > 0 && v.appVer > 0 && v.appVer < minVer) return 'update_required';
  return null;
}

// gate 가 돌려준 사유를 기록한다.
// expired 는 만료 키가 하트비트/새로고침마다 밀어넣기 때문에 키별로 6시간에 한 번만 남긴다.
function auditGate(req, v, g) {
  if (!g.audit) return Promise.resolve();
  const info = { key: v.key, device_id: v.deviceId, device_name: v.deviceName, detail: g.detail || null };
  if (g.audit === 'expired') return audit.recordThrottled(req, 'expired', info, EXPIRED_AUDIT_MS);
  return audit.record(req, g.audit, info);
}

// 공통 게이트: 키/기기 검사까지. 문제가 있으면 reason 을 돌려준다.
// 세션 검사는 needSession 이 true 일 때만 (heartbeat / config).
async function gate(req, v, opts) {
  const o = opts || {};
  const lic = await db.one('SELECT * FROM licenses WHERE key=$1', [v.key]);
  if (!lic) return { reason: 'invalid_key' };
  if (lic.revoked) return { reason: 'revoked', lic: lic, audit: 'revoked' };
  if (lic.blocked_reason) return { reason: 'blocked', lic: lic };
  if (!lic.device_id || lic.device_id !== v.deviceId) {
    return { reason: 'device_mismatch', lic: lic, audit: 'mismatch',
             detail: '등록기기=' + (lic.device_id || '(없음)') + ' 요청기기=' + v.deviceId };
  }
  if (o.needSession) {
    // 서버에 저장된 세션이 없으면(관리자 초기화 직후 등) 새로 발급해 복구시킨다
    if (lic.session_token && v.session !== lic.session_token) {
      return { reason: 'session_superseded', lic: lic };
    }
  }
  const ents = await db.entitlements(v.key);
  if (!ents.length) return { reason: 'no_entitlement', lic: lic };
  const featMap = features.map(ents, Date.now());
  if (!features.anyOn(featMap)) return { reason: 'expired', lic: lic, audit: 'expired' };
  return { lic: lic, featMap: featMap };
}

// ─────────────────────────────────────────────────────────────
// POST /verify — 활성화 + 검증
// ─────────────────────────────────────────────────────────────
router.post('/verify', wrap(async (req, res) => {
  const v = readCommon(req.body || {});
  const now = Date.now();
  const fail = (reason) => res.json(failBody(reason, v.nonce, now));

  if (!v.key || !v.deviceId) return fail('bad_request');

  // 변조 플래그는 거부하지 않고 기록만 한다 (오탐 가능성 때문에)
  if (v.tamper) {
    await audit.record(req, 'tamper',
      { key: v.key, device_id: v.deviceId, device_name: v.deviceName, detail: v.tamper });
  }

  if (!(await sigOk(v.appSig))) {
    await audit.record(req, 'bad_sig', { key: v.key, device_id: v.deviceId, device_name: v.deviceName,
      detail: 'app_sig=' + (v.appSig || '(없음)') + ' ver=' + v.appVer });
    return fail('bad_app_sig');
  }

  const minVer = Number(process.env.MIN_APP_VERSION) || 0;
  if (minVer > 0 && v.appVer < minVer) return fail('update_required');

  // 활성화/세션회전은 경쟁 상황(두 기기 동시 인증)이 있으니 행 잠금 트랜잭션으로
  const out = await db.tx(async (client) => {
    const lic = await db.one('SELECT * FROM licenses WHERE key=$1 FOR UPDATE', [v.key], client);
    if (!lic) return { fail: 'invalid_key' };
    if (lic.revoked) return { fail: 'revoked', audit: 'revoked' };
    if (lic.blocked_reason) return { fail: 'blocked', detail: lic.blocked_reason };

    let ents = await db.entitlements(v.key, client);
    // 살 수 있는 기능이 아예 없는 키에 기기를 묶어버리면 안 된다 → 묶기 전에 먼저 거른다
    if (!ents.length) return { fail: 'no_entitlement' };

    let activated = false, takeover = false;

    if (!lic.device_id) {
      // ── 최초 활성화: 기기 고정 + 미개시 기능 개시
      await db.q(
        `UPDATE licenses SET device_id=$1, device_name=$2, device_fp=$3,
                activated_at=COALESCE(activated_at,$4::bigint), last_seen=$4::bigint,
                app_sig=COALESCE($5,app_sig)
          WHERE key=$6`,
        [v.deviceId, v.deviceName, v.deviceFp, now, v.appSig || null, v.key], client);
      await db.q(
        `UPDATE entitlements SET starts_at=$1::bigint, expires_at=$1::bigint + duration_ms
          WHERE key=$2 AND expires_at IS NULL`,
        [now, v.key], client);
      activated = true;
      ents = await db.entitlements(v.key, client);
    } else if (lic.device_id !== v.deviceId) {
      // ── 1키 1기기: 다른 기기는 무조건 거부. 기기 교체는 관리자 초기화만.
      return { fail: 'device_mismatch', audit: 'mismatch',
               detail: '등록기기=' + lic.device_id + ' 요청기기=' + v.deviceId };
    } else {
      // ── 같은 기기: 하드웨어 지문이 바뀌면 복제 의심으로 기록만 하고 통과
      if (v.deviceFp && lic.device_fp && v.deviceFp !== lic.device_fp) takeover = true;
      await db.q(
        `UPDATE licenses SET device_name=COALESCE($1,device_name),
                device_fp=COALESCE($2,device_fp), last_seen=$3::bigint,
                app_sig=COALESCE($4,app_sig)
          WHERE key=$5`,
        [v.deviceName, v.deviceFp, now, v.appSig || null, v.key], client);
      if (takeover) {
        await db.q('UPDATE licenses SET device_fp=$1 WHERE key=$2', [v.deviceFp, v.key], client);
      }
    }

    const featMap = features.map(ents, now);
    if (!features.anyOn(featMap)) return { fail: 'expired', audit: 'expired' };

    // ── 세션 회전: 기존 세션은 이 순간 무효가 된다 (동시 사용 차단)
    const session = signer.randomHex(24); // 48 hex
    await db.q('UPDATE licenses SET session_token=$1, session_at=$2::bigint, last_seen=$2::bigint WHERE key=$3',
      [session, now, v.key], client);
    await db.syncSummary(v.key, client);

    const fresh = await db.one('SELECT * FROM licenses WHERE key=$1', [v.key], client);
    return { lic: fresh || lic, featMap: featMap, session: session, activated: activated, takeover: takeover };
  });

  if (out.fail) {
    if (out.audit) {
      await audit.record(req, out.audit, { key: v.key, device_id: v.deviceId,
        device_name: v.deviceName, detail: out.detail || null });
    }
    return fail(out.fail);
  }

  const onList = features.ALL.filter((f) => out.featMap[f].on).join(',');
  if (out.activated) {
    await audit.record(req, 'activate', { key: v.key, device_id: v.deviceId, device_name: v.deviceName,
      detail: '활성화 기능=' + (onList || '(없음)') + ' fp=' + (v.deviceFp || '-') });
  }
  if (out.takeover) {
    await audit.record(req, 'takeover', { key: v.key, device_id: v.deviceId, device_name: v.deviceName,
      detail: '하드웨어 지문 변경 감지 (같은 android_id, 다른 기기 의심)' });
  }

  // /verify 성공 응답에만 config_key 를 싣는다 (SPEC 3.1-9)
  res.json(buildOk(req, v.key, v.deviceId, out.lic, out.featMap, out.session, v.nonce, now,
                   { withConfigKey: true }));
}));

// ─────────────────────────────────────────────────────────────
// POST /heartbeat — 세션 유지 / 탈취 감지 / 만료 감지
// ─────────────────────────────────────────────────────────────
router.post('/heartbeat', wrap(async (req, res) => {
  const v = readCommon(req.body || {});
  const now = Date.now();
  const fail = (reason) => res.json(failBody(reason, v.nonce, now));

  if (!v.key || !v.deviceId) return fail('bad_request');

  // app_sig·app_version 은 보내온 경우에만 검사한다 (안 보내는 구버전 호출을 막지 않기 위해).
  // 보냈는데 허용목록에 없으면 반드시 거부된다.
  const bad = await appCheck(req, v, 'heartbeat');
  if (bad) return fail(bad);

  const g = await gate(req, v, { needSession: true });
  if (g.reason) {
    await auditGate(req, v, g);
    return fail(g.reason);
  }

  // 요청이 들고 온 세션이 서버 값과 정말 같은가 = 세션 소유 증명
  const proven = !!(g.lic.session_token && v.session && v.session === g.lic.session_token);

  // 세션은 유지한다(회전하지 않음). 서버에 세션이 없던 경우엔 새로 발급해 복구.
  let session = g.lic.session_token;
  if (!session) {
    session = signer.randomHex(24);
    await db.q('UPDATE licenses SET session_token=$1, session_at=$2::bigint WHERE key=$3', [session, now, v.key]);
  }
  await db.q('UPDATE licenses SET last_seen=$1::bigint, device_name=COALESCE($2,device_name) WHERE key=$3',
    [now, v.deviceName, v.key]);

  // config_key 는 세션을 증명한 하트비트에만 실어준다 (세션 복구로 새로 발급한 경우는 제외)
  res.json(buildOk(req, v.key, v.deviceId, g.lic, g.featMap, session, v.nonce, now,
                   { withConfigKey: proven }));
}));

// ─────────────────────────────────────────────────────────────
// /entitlements — 기능 상태만 (구매 직후 새로고침)
// 세션을 회전시키지도, 발급하지도 않는다. 응답 형태는 /heartbeat 성공과 같다.
// ★ 세션 소유 증명이 없는 경로다 →
//   - 서버에 저장된 session_token 을 절대 응답에 싣지 않는다 (요청이 들고 온 값과 같을 때만 echo)
//   - config_key 도 내리지 않는다 (설정 복호화 키의 재료)
//   GET 은 하위호환용으로 남기고, 키가 접근로그에 남지 않는 POST 를 같이 받는다.
// ─────────────────────────────────────────────────────────────
async function entitlements(req, res, src) {
  const v = readCommon(src || {});
  const now = Date.now();
  const fail = (reason) => res.json(failBody(reason, v.nonce, now));

  if (!v.key || !v.deviceId) return fail('bad_request');

  // /verify 와 같은 기준으로 앱 서명·버전을 본다 (필드가 없으면 건너뜀 — 구버전 호환)
  const bad = await appCheck(req, v, 'entitlements');
  if (bad) return fail(bad);

  const g = await gate(req, v, { needSession: false });
  if (g.reason) {
    await auditGate(req, v, g);
    return fail(g.reason);
  }
  await db.q('UPDATE licenses SET last_seen=$1::bigint WHERE key=$2', [now, v.key]);

  const echo = (v.session && g.lic.session_token && v.session === g.lic.session_token) ? v.session : null;
  res.json(buildOk(req, v.key, v.deviceId, g.lic, g.featMap, echo, v.nonce, now));
}

router.get('/entitlements', wrap((req, res) => entitlements(req, res, req.query)));
router.post('/entitlements', wrap((req, res) => entitlements(req, res, req.body)));

// ─────────────────────────────────────────────────────────────
// 설정 클라우드 백업 — 서버는 blob 내용을 해독할 수 없다 (키가 앱에만 있음)
// ─────────────────────────────────────────────────────────────
router.post('/config', wrap(async (req, res) => {
  const b = req.body || {};
  const v = readCommon(b);
  const now = Date.now();
  const fail = (reason) => res.json(failBody(reason, v.nonce, now));

  if (!v.key || !v.deviceId) return fail('bad_request');
  const blob = b.blob === null || b.blob === undefined ? '' : String(b.blob);
  if (!blob) return fail('bad_request');
  if (Buffer.byteLength(blob, 'utf8') > MAX_BLOB) return fail('too_large');

  const g = await gate(req, v, { needSession: true });
  if (g.reason) return fail(g.reason);

  const r = await db.q(
    `INSERT INTO configs (key, blob, rev, updated_at) VALUES ($1,$2,1,$3::bigint)
     ON CONFLICT (key) DO UPDATE SET blob=EXCLUDED.blob, rev=COALESCE(configs.rev,0)+1,
            updated_at=EXCLUDED.updated_at
     RETURNING rev`,
    [v.key, blob, now]);

  res.json(signer.sign({ ok: true, rev: Number(r.rows[0].rev), nonce: v.nonce, ts: now }));
}));

router.get('/config', wrap(async (req, res) => {
  const v = readCommon(req.query || {});
  const now = Date.now();
  const fail = (reason) => res.json(failBody(reason, v.nonce, now));

  if (!v.key || !v.deviceId) return fail('bad_request');
  const g = await gate(req, v, { needSession: true });
  if (g.reason) return fail(g.reason);

  const row = await db.one('SELECT blob, rev, updated_at FROM configs WHERE key=$1', [v.key]);
  res.json(signer.sign({
    ok: true,
    blob: row ? (row.blob || null) : null,
    rev: row ? Number(row.rev) || 0 : 0,
    updated_at: row ? Number(row.updated_at) || 0 : 0,
    nonce: v.nonce,
    ts: now,
  }));
}));

// ─────────────────────────────────────────────────────────────
// GET /pubkey — 진단용 (서명 안 함)
// ─────────────────────────────────────────────────────────────
router.get('/pubkey', wrap(async (req, res) => {
  res.json({ ok: true, pubkey: signer.pubkeyB64() });
}));

module.exports = router;
module.exports.bustSigCache = bustSigCache;
module.exports.RECHECK_MS = RECHECK_MS;
module.exports.GRACE_MS = GRACE_MS;
// 테스트용 훅 (서명 검사 강도를 단독으로 검증한다)
module.exports.__test = { sigProblem: sigProblem, sigMode: sigMode, allowedSigs: allowedSigs };
