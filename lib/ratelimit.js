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

// ── 요청 종류별 분당 한도 ───────────────────────────────────────────────────
// 한 IP 에 버킷을 하나만 주면 NAT(사무실·학교) 뒤 사용자끼리 서로를 막는다.
// 주문 페이지가 5초 폴링(=12회/분/구매자)을 하니까 읽기 전용 버킷은 따로 크게 준다.
// 기본값은 여기 적힌 값이고, 각 환경변수로 덮어쓸 수 있다.
const KIND_LIMITS = {
  // POST /verify /heartbeat /entitlements /config + GET /entitlements /config
  'verify':      { env: 'RATE_LIMIT_PER_MIN',       dflt: 30 },
  // GET /api/order/:id — 폴링 전용, 읽기만 하고 비용이 낮다
  'order-read':  { env: 'RATE_ORDER_READ_PER_MIN',  dflt: 180 },
  // POST /api/order, POST /api/lookup — 쓰기/조회라 아껴 쓴다
  'order-write': { env: 'RATE_ORDER_WRITE_PER_MIN', dflt: 20 },
  // POST /api/deposit-hook — 폰 자동화 앱이 몰아서 보낼 수 있다
  'deposit':     { env: 'RATE_DEPOSIT_PER_MIN',     dflt: 60 },
  // /admin/* — 관리자앱이 목록·상세를 연달아 부른다
  'admin':       { env: 'ADMIN_RATE_LIMIT_PER_MIN', dflt: 120 },
  // 관리 화면 로그인. 키 추측을 늦춘다.
  'panel-login': { env: 'RATE_PANEL_LOGIN_PER_MIN', dflt: 8 },
  // 관리 화면의 나머지. 인증 확인은 한 번 길게 기다린다.
  'panel':       { env: 'RATE_PANEL_PER_MIN',       dflt: 60 },
};
const KINDS = Object.keys(KIND_LIMITS);

// 종류별 분당 한도. 모르는 종류는 가장 보수적인 verify 한도를 쓴다.
function maxFor(kind) {
  const c = KIND_LIMITS[kind];
  if (!c) return envNum(KIND_LIMITS.verify.env, KIND_LIMITS.verify.dflt);
  return envNum(c.env, c.dflt);
}

// 지금 적용중인 한도 전체 (로그/점검용)
function limits() {
  const out = {};
  for (const k of KINDS) out[k] = maxFor(k);
  return out;
}

// 예전 이름 호환 — verify 버킷이 옛 "api" 버킷 자리다
function apiMax() { return maxFor('verify'); }
// 관리자 API: 성공 요청은 넉넉히
function adminMax() { return maxFor('admin'); }
// 관리자 인증 실패: IP당 분당 몇 번까지 허용하고, 넘으면 얼마나 차단할지
function adminFailMax() { return envNum('ADMIN_FAIL_PER_MIN', 10); }
function adminBlockMs() { return envNum('ADMIN_BLOCK_MS', 15 * MINUTE); }

// ── 경로 정규화 ─────────────────────────────────────────────────────────────
// Express 라우팅은 기본이 대소문자 무시다 → /ADMIN/list 도 /admin/list 로 간다.
// 여기서 소문자로 낮추고 끝 슬래시를 떼지 않으면 대소문자·슬래시만 바꿔서
// 사전 차단과 리밋 버킷을 통째로 우회할 수 있다.
function normPath(raw) {
  let p = String(raw === null || raw === undefined ? '' : raw).toLowerCase();
  const qm = p.indexOf('?');
  if (qm >= 0) p = p.slice(0, qm);
  while (p.length > 1 && p.charAt(p.length - 1) === '/') p = p.slice(0, -1);
  return p || '/';
}

// 요청 → 레이트리밋 종류. 제한 대상이 아니면 false.
// (server.js 의 미들웨어가 이걸 쓴다. 여기 두면 테스트에서 바로 부를 수 있다)
function kindOf(req) {
  if (!req) return false;
  const p = normPath(req.path || req.url);
  const m = String(req.method || 'GET').toUpperCase();

  // 관리자 API 는 전부 제한 대상 — 비밀번호 무한 추측을 막는다
  if (p === '/admin' || p.indexOf('/admin/') === 0) return 'admin';

  if (m === 'POST' && (p === '/verify' || p === '/heartbeat' ||
      p === '/entitlements' || p === '/config')) return 'verify';
  if (m === 'GET' && (p === '/entitlements' || p === '/config')) return 'verify';

  // 주문 조회는 폴링이라 따로 큰 버킷을 쓴다
  if (m === 'GET' && (p === '/api/order' || p.indexOf('/api/order/') === 0)) return 'order-read';

  if (m === 'POST' && (p === '/api/order' || p === '/api/lookup')) return 'order-write';
  if (m === 'POST' && p === '/api/deposit-hook') return 'deposit';

  if (m === 'POST' && p === '/panel/api/login') return 'panel-login';
  if (p === '/panel/api' || p.indexOf('/panel/api/') === 0) return 'panel';

  return false;
}

// ── IP 판정 ─────────────────────────────────────────────────────────────────
// 신뢰하는 프록시 홉 수. 1 = x-forwarded-for 의 맨 뒤 하나(=우리 바로 앞 프록시가 붙인 값).
function trustProxyHops() {
  const n = Math.floor(Number(process.env.TRUST_PROXY_HOPS));
  return isFinite(n) && n > 0 ? n : 1;
}

// ::ffff:1.2.3.4 / [::1]:1234 / 1.2.3.4:5678 같은 형태를 하나로 맞춘다.
// (같은 클라이언트가 표기만 달라서 다른 버킷으로 흩어지면 리밋이 헐거워진다)
function normIp(raw) {
  let s = String(raw === null || raw === undefined ? '' : raw).trim();
  if (!s) return '';
  // [::1]:1234 → ::1
  const br = s.match(/^\[([^\]]+)\](?::\d+)?$/);
  if (br) s = br[1].trim();
  // IPv4-mapped IPv6: ::ffff:1.2.3.4 → 1.2.3.4
  const m6 = s.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})(?::\d+)?$/i);
  if (m6) s = m6[1];
  // 1.2.3.4:5678 → 1.2.3.4 (콜론이 하나뿐일 때만 = IPv6 를 자르지 않게)
  const m4 = s.match(/^(\d{1,3}(?:\.\d{1,3}){3}):\d+$/);
  if (m4) s = m4[1];
  return s.toLowerCase().slice(0, 64);
}

// 프록시(Render) 뒤라서 x-forwarded-for 를 본다. 단, **맨 뒤(rightmost)** 를 쓴다.
// 프록시는 클라이언트가 보낸 XFF 뒤에 자기가 관찰한 IP 를 덧붙이므로 맨 앞 토큰은
// 공격자가 정하는 값이다(맨 앞을 믿으면 헤더 한 줄로 15분 차단이 리셋된다).
// TRUST_PROXY_HOPS=N 이면 뒤에서 N번째를 쓰고, 토큰이 부족하면 소켓 주소로 폴백한다.
// audit 의 ip 와 같은 값이 나와야 차단 기록과 감사 기록이 서로 이어진다(lib/audit.js 가 이걸 그대로 쓴다).
function ipOf(req) {
  if (!req) return 'unknown';
  const sock = normIp(req.socket && req.socket.remoteAddress);
  const fwd = req.headers && req.headers['x-forwarded-for'];
  if (fwd) {
    const toks = (Array.isArray(fwd) ? fwd.join(',') : String(fwd))
      .split(',').map(normIp).filter(Boolean);
    if (toks.length) {
      const idx = toks.length - trustProxyHops();   // 뒤에서 N번째
      if (idx >= 0) return toks[idx];
      // 홉 수보다 토큰이 적다 → 위조된 XFF 를 믿지 않고 소켓 주소를 쓴다
      if (sock) return sock;
      return toks[0];
    }
  }
  return sock || 'unknown';
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

// 테스트용 — 카운터를 전부 비운다 (운영 경로에서는 쓰지 않는다)
function resetAll() {
  buckets.clear();
  adminFails.clear();
}

module.exports = {
  MINUTE, KINDS, KIND_LIMITS,
  ipOf, normIp, trustProxyHops, normPath, kindOf,
  hit, sweep, maxFor, limits,
  apiMax, adminMax, adminFailMax, adminBlockMs,
  adminBlockedMs, noteAdminFail, clearAdminFails, resetAll,
};
