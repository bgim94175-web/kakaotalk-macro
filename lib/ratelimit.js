// IP 기반 레이트리밋 + 관리자 인증 실패 차단 (전부 메모리).
// 무료 플랜이라 Redis 는 안 쓴다. 인스턴스가 하나니까 메모리로 충분하다.
// 지연 초기화 원칙: require 만으로는 타이머를 돌리지 않는다(처음 쓸 때 청소 타이머가 붙는다).
'use strict';

const MINUTE = 60 * 1000;

// "종류|ip" → { at, n }
const buckets = new Map();
// ip → { at, n, until }  (관리자 비밀번호 틀린 횟수)
const adminFails = new Map();

function envNum(name, dflt) {
  const n = Number(process.env[name]);
  return isFinite(n) && n > 0 ? n : dflt;
}

// 일반 API: 분당 몇 번까지
function apiMax() { return envNum('RATE_LIMIT_PER_MIN', 30); }
// 관리자 API: 성공 요청은 넉넉히 (관리자앱이 목록·상세를 연달아 부른다)
function adminMax() { return envNum('ADMIN_RATE_LIMIT_PER_MIN', 120); }
// 관리자 인증 실패: IP당 분당 몇 번까지 허용하고, 넘으면 얼마나 차단할지
function adminFailMax() { return envNum('ADMIN_FAIL_PER_MIN', 10); }
function adminBlockMs() { return envNum('ADMIN_BLOCK_MS', 15 * MINUTE); }

// 프록시(Render) 뒤라서 x-forwarded-for 를 먼저 본다. audit 의 ip 와 같은 값이 나와야
// 차단 기록과 감사 기록이 서로 이어진다.
function ipOf(req) {
  if (!req) return 'unknown';
  const fwd = req.headers && req.headers['x-forwarded-for'];
  if (fwd) {
    const first = String(fwd).split(',')[0].trim();
    if (first) return first.slice(0, 64);
  }
  const ip = req.ip || (req.socket && req.socket.remoteAddress) || '';
  return String(ip).slice(0, 64) || 'unknown';
}

// ── 오래된 항목 청소 (5분마다, 첫 사용 때 붙는다)
let sweeper = null;
function ensureSweeper() {
  if (sweeper) return;
  sweeper = setInterval(sweep, 5 * MINUTE);
  if (sweeper.unref) sweeper.unref();   // 이 타이머가 프로세스를 붙잡지 않게
}

function sweep() {
  const now = Date.now();
  for (const [id, b] of buckets) if (now - b.at > 5 * MINUTE) buckets.delete(id);
  for (const [ip, f] of adminFails) {
    const dead = (!f.until || f.until <= now) && now - f.at > 10 * MINUTE;
    if (dead) adminFails.delete(ip);
  }
}

// 고정 윈도 카운터. 한도를 넘으면 { ok:false, retryAfter:초 }
function hit(kind, ip, max, windowMs) {
  ensureSweeper();
  const w = windowMs || MINUTE;
  const cap = Math.max(1, Math.floor(Number(max) || 0) || 1);
  const now = Date.now();
  const id = String(kind) + '|' + String(ip);
  let b = buckets.get(id);
  if (!b || now - b.at >= w) { b = { at: now, n: 0 }; buckets.set(id, b); }
  b.n++;
  if (b.n > cap) return { ok: false, retryAfter: Math.max(1, Math.ceil((b.at + w - now) / 1000)), n: b.n };
  return { ok: true, retryAfter: 0, n: b.n };
}

// ── 관리자 인증 실패 ──────────────────────────────────────────────────────────

// 차단이 걸려 있으면 남은 시간(ms), 아니면 0
function adminBlockedMs(ip) {
  const f = adminFails.get(String(ip));
  if (!f || !f.until) return 0;
  const left = f.until - Date.now();
  if (left <= 0) { f.until = 0; f.at = Date.now(); f.n = 0; return 0; }
  return left;
}

// 비밀번호 틀림 1회 기록. 분당 한도를 넘기면 그 IP 를 차단한다.
function noteAdminFail(ip) {
  ensureSweeper();
  const key = String(ip);
  const now = Date.now();
  let f = adminFails.get(key);
  if (!f) { f = { at: now, n: 0, until: 0 }; adminFails.set(key, f); }
  if (!f.until && now - f.at >= MINUTE) { f.at = now; f.n = 0; }
  f.n++;
  let blocked = false;
  if (f.n >= adminFailMax()) {
    f.until = now + adminBlockMs();
    blocked = true;
  }
  return { fails: f.n, blocked: blocked, blockMs: blocked ? f.until - now : 0 };
}

// 인증이 성공하면 그 IP 의 실패 카운터를 지운다 (정상 관리자가 오타 몇 번 낸 걸 끌고가지 않게)
function clearAdminFails(ip) {
  adminFails.delete(String(ip));
}

module.exports = {
  MINUTE, ipOf, hit, sweep,
  apiMax, adminMax, adminFailMax, adminBlockMs,
  adminBlockedMs, noteAdminFail, clearAdminFails,
};
