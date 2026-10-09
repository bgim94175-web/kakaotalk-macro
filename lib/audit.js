// 감사 로그 — 누가 무슨 짓을 했는지 남긴다. 관리자 화면(/manage) [기록] 탭이 이걸 본다.
'use strict';

const db = require('./db');
const rl = require('./ratelimit');

// 지금 기록하는 종류.
//   activate          — /panel 첫 로그인으로 사용 기간 시작
//   revoked           — 관리자 회수·차단·삭제
//   order             — 주문 접수·승인·취소·입금 매칭
//   bad_deposit_token — 입금 웹훅 인증 실패
//   bad_admin_pw      — 관리자 비밀번호 실패
// ★ 단종된 사용자앱이 남긴 옛 기록(mismatch/takeover/bad_sig/expired/reset/tamper)이
//   audit_log 에 그대로 있다. 표를 지우지 않으므로 화면은 모르는 종류도 그대로 보여 줘야 한다.
const KINDS = ['activate', 'revoked', 'order', 'bad_deposit_token', 'bad_admin_pw'];

// 눈에 띄게 표시해야 하는 종류 (관리자 화면에서 붉게)
const ALERT_KINDS = ['bad_deposit_token', 'bad_admin_pw'];

function isKind(k) { return KINDS.indexOf(k) >= 0; }

function cut(s, n) {
  if (s === null || s === undefined) return null;
  const v = String(s);
  return v.length > n ? v.slice(0, n) : v;
}

// IP 판정은 레이트리밋과 **같은 함수**를 쓴다 (lib/ratelimit.js).
// XFF 맨 앞은 클라이언트가 위조할 수 있어서 맨 뒤(rightmost)를 쓴다 → 차단 기록과
// 감사 기록의 ip 가 항상 같은 값이 되어 서로 이어진다.
function ipOf(req) {
  if (!req) return null;
  const ip = rl.ipOf(req);
  if (!ip || ip === 'unknown') return null;
  return cut(ip, 64);
}

// 기록. 로그 쓰기가 실패해도 요청 자체를 죽이진 않지만, 절대 조용히 묻지 않는다.
async function log(kind, info) {
  const d = info || {};
  try {
    // device_id / device_name 열은 예전 앱 기록용이다. 새 기록에서는 비워 둔다.
    await db.q(
      'INSERT INTO audit_log (at, key, kind, detail, ip) VALUES ($1,$2,$3,$4,$5)',
      [Date.now(), cut(d.key, 64), cut(kind, 32), cut(d.detail, 2000), cut(d.ip, 64)]);
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

module.exports = { KINDS, ALERT_KINDS, isKind, ipOf, log, record };
