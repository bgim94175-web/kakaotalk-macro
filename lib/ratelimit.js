// IP 기반 레이트리밋 + 관리자 인증 실패 차단 (전부 메모리).
// 무료 플랜이라 Redis 는 안 쓴다. 인스턴스가 하나니까 메모리로 충분하다.
// 지연 초기화 원칙: require 만으로는 타이머를 돌리지 않는다(처음 쓸 때 청소 타이머가 붙는다).
'use strict';

const MINUTE = 60 * 1000;

// "종류|ip" → { at, n }
const buckets = new Map();
// ip → { at, n, until }  (관리자 비밀번호 틀린 횟수)
const adminFails = new Map();
// "아이디|ip" → { at, n, until }  (회원 로그인 실패 — 잠금은 이 쌍 단위, docs/ACCOUNTS_V1.md 3.1)
const loginFails = new Map();
// 아이디 → { at, n }  (아이디 단독 실패 수 — 잠그지 않고 늦추기만 한다)
const loginIdFails = new Map();

function envNum(name, dflt) {
  const n = Number(process.env[name]);
  return isFinite(n) && n > 0 ? n : dflt;
}

// ── 요청 종류별 분당 한도 ───────────────────────────────────────────────────
// 한 IP 에 버킷을 하나만 주면 NAT(사무실·학교) 뒤 사용자끼리 서로를 막는다.
// 주문 페이지가 5초 폴링(=12회/분/구매자)을 하니까 읽기 전용 버킷은 따로 크게 준다.
// 기본값은 여기 적힌 값이고, 각 환경변수로 덮어쓸 수 있다.
const KIND_LIMITS = {
  // GET /api/order/:id — 폴링 전용, 읽기만 하고 비용이 낮다
  'order-read':  { env: 'RATE_ORDER_READ_PER_MIN',  dflt: 180 },
  // POST /api/order, POST /api/lookup — 쓰기/조회라 아껴 쓴다
  'order-write': { env: 'RATE_ORDER_WRITE_PER_MIN', dflt: 20 },
  // POST /api/deposit-hook — 폰 자동화 앱이 몰아서 보낼 수 있다
  'deposit':     { env: 'RATE_DEPOSIT_PER_MIN',     dflt: 60 },
  // /admin/* — 관리자 화면(/manage)이 목록·상세를 연달아 부른다
  'admin':       { env: 'ADMIN_RATE_LIMIT_PER_MIN', dflt: 120 },
  // 예전 관리 화면 키 로그인. 키 로그인이 없어져 더 쓰지 않는다(정의만 남김, ACCOUNTS_V1 3.1).
  'panel-login': { env: 'RATE_PANEL_LOGIN_PER_MIN', dflt: 8 },
  // 관리 화면의 나머지. 채팅 화면이 대화 목록(9초)과 열린 방(3초)을 주기적으로 읽는다
  // → 한 창에서만 분당 약 27회다. 창을 두 개 띄우면 60 을 넘기므로 폴링용으로 크게 준다.
  // 회원 로그인 추측은 아래 auth 버킷과 로그인 실패 잠금이 막는다.
  'panel':       { env: 'RATE_PANEL_PER_MIN',       dflt: 180 },
  // 회원 인증(docs/ACCOUNTS_V1.md 3.1). 비밀번호를 검사하는 POST 만 — 로그인·비밀번호 변경·키 이관·Google 해제
  'auth':        { env: 'RATE_AUTH_PER_MIN',        dflt: 10 },
  // 회원가입. 라우트 안에서 IP당 시간 20회를 따로 센다
  'signup':      { env: 'RATE_SIGNUP_PER_MIN',      dflt: 5 },
  // Google 연결·로그인 시작과 콜백
  'oauth':       { env: 'RATE_OAUTH_PER_MIN',       dflt: 20 },
  // 방 링크 미리 보기(실제 봇 계정이 카카오에 조회를 보낸다). 회원당 시간 60회는 라우트가 센다
  'preview':     { env: 'RATE_PREVIEW_PER_MIN',     dflt: 20 },
  // 나머지 회원 경로: /api/auth/*, GET /api/site /api/me /api/my/*, POST /api/my/orders/cancel
  'member':      { env: 'RATE_MEMBER_PER_MIN',      dflt: 180 },
};
const KINDS = Object.keys(KIND_LIMITS);

// 종류별 분당 한도. 모르는 종류는 쓰기 버킷(order-write) 한도를 쓴다.
function maxFor(kind) {
  const c = KIND_LIMITS[kind] || KIND_LIMITS['order-write'];
  return envNum(c.env, c.dflt);
}

// 지금 적용중인 한도 전체 (로그/점검용)
function limits() {
  const out = {};
  for (const k of KINDS) out[k] = maxFor(k);
  return out;
}

// 관리자 API: 성공 요청은 넉넉히
function adminMax() { return maxFor('admin'); }
// 관리자 인증 실패: IP당 분당 몇 번까지 허용하고, 넘으면 얼마나 차단할지
function adminFailMax() { return envNum('ADMIN_FAIL_PER_MIN', 10); }
function adminBlockMs() { return envNum('ADMIN_BLOCK_MS', 15 * MINUTE); }
// 회원 로그인 실패: (아이디, IP) 쌍이 15분에 이 횟수면 그 쌍을 잠근다
function loginFailMax() { return envNum('LOGIN_FAIL_MAX', 10); }
function loginBlockMs() { return envNum('LOGIN_BLOCK_MS', 15 * MINUTE); }
// 아이디 단독: 15분에 이 횟수를 넘으면 이후 시도마다 응답 전에 이만큼 기다린다(잠그지 않음)
function loginSlowAfter() { return envNum('LOGIN_SLOW_AFTER', 30); }
function loginSlowDelayMs() { return envNum('LOGIN_SLOW_MS', 2000); }
const LOGIN_WINDOW_MS = 15 * MINUTE;

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

  // 주문 조회는 폴링이라 따로 큰 버킷을 쓴다
  if (m === 'GET' && (p === '/api/order' || p.indexOf('/api/order/') === 0)) return 'order-read';

  if (m === 'POST' && (p === '/api/order' || p === '/api/lookup')) return 'order-write';
  if (m === 'POST' && p === '/api/deposit-hook') return 'deposit';

  // 회원 인증 (docs/ACCOUNTS_V1.md 3.1 표)
  if (p === '/api/auth' || p.indexOf('/api/auth/') === 0) {
    if (m === 'POST' && (p === '/api/auth/login' || p === '/api/auth/password' ||
        p === '/api/auth/claim' || p === '/api/auth/google/unlink')) return 'auth';
    if (m === 'POST' && p === '/api/auth/signup') return 'signup';
    return 'member';
  }
  if (p === '/auth/google' || p.indexOf('/auth/google/') === 0) return 'oauth';
  if (p === '/api/room-preview') return 'preview';
  if (p === '/api/site' || p === '/api/me') return 'member';
  if (p === '/api/my' || p.indexOf('/api/my/') === 0) return 'member';

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
  for (const [k, f] of loginFails) {
    const dead = (!f.until || f.until <= now) && now - f.at > LOGIN_WINDOW_MS;
    if (dead) loginFails.delete(k);
  }
  for (const [k, f] of loginIdFails) if (now - f.at > LOGIN_WINDOW_MS) loginIdFails.delete(k);
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

// ── 회원 로그인 실패 (docs/ACCOUNTS_V1.md 3.1) ─────────────────────────────────
// 아이디는 존재 여부와 관계없이 센다(있는 아이디인지 새지 않게). 표기만 다른 같은 아이디가 흩어지지 않게 맞춘다.
function loginKey(loginId) {
  return String(loginId === null || loginId === undefined ? '' : loginId).normalize('NFKC').trim().toLowerCase().slice(0, 64);
}

function pairKey(loginId, ip) {
  return loginKey(loginId) + '|' + String(ip);
}

// (아이디, IP) 잠금이 걸려 있으면 남은 시간(ms), 아니면 0
function loginBlockedMs(loginId, ip) {
  const f = loginFails.get(pairKey(loginId, ip));
  if (!f || !f.until) return 0;
  const left = f.until - Date.now();
  if (left <= 0) { loginFails.delete(pairKey(loginId, ip)); return 0; }
  return left;
}

// 아이디 단독 실패가 15분에 LOGIN_SLOW_AFTER 회를 넘었으면 응답 전에 기다릴 시간(ms). 잠그지 않는다
// — 남이 아이디만 알고 본인을 내쫓을 수 없게 하기 위해서다.
function loginSlowMs(loginId) {
  const f = loginIdFails.get(loginKey(loginId));
  if (!f) return 0;
  if (Date.now() - f.at >= LOGIN_WINDOW_MS) { loginIdFails.delete(loginKey(loginId)); return 0; }
  return f.n > loginSlowAfter() ? loginSlowDelayMs() : 0;
}

// 실패 1회 기록. 15분 창 안에서 LOGIN_FAIL_MAX 에 닿으면 그 (아이디, IP) 를 LOGIN_BLOCK_MS 동안 잠근다.
function noteLoginFail(loginId, ip) {
  ensureSweeper();
  const now = Date.now();
  const pk = pairKey(loginId, ip);
  let f = loginFails.get(pk);
  if (!f || (!f.until && now - f.at >= LOGIN_WINDOW_MS)) { f = { at: now, n: 0, until: 0 }; loginFails.set(pk, f); }
  f.n++;
  let blocked = false;
  if (!f.until && f.n >= loginFailMax()) {
    f.until = now + loginBlockMs();
    blocked = true;
  }
  const ik = loginKey(loginId);
  let g = loginIdFails.get(ik);
  if (!g || now - g.at >= LOGIN_WINDOW_MS) { g = { at: now, n: 0 }; loginIdFails.set(ik, g); }
  g.n++;
  return { fails: f.n, blocked: blocked, blockMs: f.until ? Math.max(0, f.until - now) : 0, idFails: g.n };
}

// 로그인 성공 때 그 (아이디, IP) 쌍만 지운다. 아이디 단독 계수는 창이 지나야 풀린다
// (남이 계속 두드리는 아이디를 본인 로그인 한 번으로 다시 빠르게 만들지 않는다).
function clearLoginFails(loginId, ip) {
  loginFails.delete(pairKey(loginId, ip));
}

// 테스트용 — 카운터를 전부 비운다 (운영 경로에서는 쓰지 않는다)
function resetAll() {
  buckets.clear();
  adminFails.clear();
  loginFails.clear();
  loginIdFails.clear();
}

module.exports = {
  MINUTE, KINDS, KIND_LIMITS,
  ipOf, normIp, trustProxyHops, normPath, kindOf,
  hit, sweep, maxFor, limits,
  adminMax, adminFailMax, adminBlockMs,
  adminBlockedMs, noteAdminFail, clearAdminFails, resetAll,
  loginFailMax, loginBlockMs, loginSlowAfter, loginSlowDelayMs,
  noteLoginFail, loginBlockedMs, loginSlowMs, clearLoginFails,
};
