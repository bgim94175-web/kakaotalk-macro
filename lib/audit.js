// 감사 로그 — 누가 무슨 짓을 했는지 남긴다. 관리자앱 [기록] 탭이 이걸 본다.
'use strict';

const db = require('./db');

// activate|mismatch|takeover|bad_sig|expired|revoked|reset|order|tamper
// (+ 입금 웹훅 인증 실패: bad_deposit_token / 관리자 비밀번호 실패: bad_admin_pw)
const KINDS = ['activate', 'mismatch', 'takeover', 'bad_sig', 'expired', 'revoked', 'reset', 'order', 'tamper',
               'bad_deposit_token', 'bad_admin_pw'];

// 눈에 띄게 표시해야 하는 종류 (관리자앱에서 붉게)
const ALERT_KINDS = ['mismatch', 'takeover', 'bad_sig', 'tamper', 'bad_deposit_token', 'bad_admin_pw'];

function isKind(k) { return KINDS.indexOf(k) >= 0; }

function cut(s, n) {
  if (s === null || s === undefined) return null;
  const v = String(s);
  return v.length > n ? v.slice(0, n) : v;
}

// 프록시(Render) 뒤라서 x-forwarded-for 를 먼저 본다
function ipOf(req) {
  if (!req) return null;
  const fwd = req.headers && req.headers['x-forwarded-for'];
  if (fwd) return cut(String(fwd).split(',')[0].trim(), 64);
  return cut(req.ip || (req.socket && req.socket.remoteAddress) || '', 64) || null;
}

// 기록. 로그 쓰기가 실패해도 요청 자체를 죽이진 않지만, 절대 조용히 묻지 않는다.
async function log(kind, info) {
  const d = info || {};
  try {
    await db.q(
      'INSERT INTO audit_log (at, key, kind, device_id, device_name, detail, ip) VALUES ($1,$2,$3,$4,$5,$6,$7)',
      [Date.now(), cut(d.key, 64), cut(kind, 32), cut(d.device_id, 128), cut(d.device_name, 120),
       cut(d.detail, 2000), cut(d.ip, 64)]);
  } catch (e) {
    console.error('[audit] 기록 실패 kind=' + kind + ' key=' + (d.key || '-') + ' → ' + e.message);
  }
}

// 요청 객체에서 IP 뽑아서 기록하는 단축형. await 해도 되고 안 해도 된다.
function record(req, kind, info) {
  const d = Object.assign({}, info || {});
  d.ip = ipOf(req);
  return log(kind, d);
}

// 같은 사유가 계속 쌓여서 기록 탭의 위험 신호를 덮는 걸 막는 단축형.
// (만료된 키가 하트비트마다 expired 를 밀어넣으면 mismatch/takeover 가 LIMIT 밖으로 밀려난다)
const recent = new Map();   // "kind|key|device" → 마지막 기록 시각

function recordThrottled(req, kind, info, windowMs) {
  const d = info || {};
  const w = Number(windowMs) > 0 ? Number(windowMs) : 6 * 3600 * 1000;
  const id = kind + '|' + (d.key || '-') + '|' + (d.device_id || '-');
  const now = Date.now();
  const last = recent.get(id) || 0;
  if (last && now - last < w) return Promise.resolve();   // 창 안이면 조용히 넘긴다
  recent.set(id, now);
  // 메모리가 무한정 늘지 않게 오래된 것부터 버린다
  if (recent.size > 5000) {
    for (const [k, at] of recent) { if (now - at > w) recent.delete(k); }
  }
  return record(req, kind, d);
}

module.exports = { KINDS, ALERT_KINDS, isKind, ipOf, log, record, recordThrottled };
