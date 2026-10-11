// 회원 인증 — 아이디·비밀번호(scrypt), 서버 세션(member_sessions + 쿠키 kb_s), CSRF, 채널톡 회원 식별.
// docs/ACCOUNTS_V1.md 3.1·3.2·8장 1~3·8, 9.2 의 서명을 그대로 따른다. 다른 작업은 이 서명만 믿는다.
// 지연 초기화 원칙: require 만으로는 DB 에 붙지 않고 타이머도 돌지 않는다.
'use strict';

const crypto = require('crypto');

const db = require('./db');
const rl = require('./ratelimit');
const settings = require('./settings');

const COOKIE = 'kb_s';
const OLD_PANEL_COOKIE = 'panel';             // 예전 키 로그인 쿠키(Path=/panel). 로그아웃 때 같이 지운다
// 한 아이디로 동시에 로그인할 수 있는 기기 수 — 관리자가 /manage [설정]에서 바꾼다(lib/settings.js)
function maxSessions() { return settings.get('sessions'); }
const DAY = 86400000;

function envNum(name, dflt) {
  const n = Number(process.env[name]);
  return isFinite(n) && n > 0 ? n : dflt;
}

function ttlMs() { return envNum('MEMBER_SESSION_TTL_MS', 30 * DAY); }
function resetWindowMs() { return envNum('AUTH_RESET_WINDOW_MS', 15 * 60000); }
const SEEN_EVERY_MS = 10 * 60000;              // last_seen_at 은 10분에 1번만 쓴다
const CACHE_MS = 30000;                        // 세션 읽기 메모리 저장
const CACHE_MAX = 5000;

// ── 화면 문구 (docs/ACCOUNTS_V1.md 3.1·3.2·6.3·6.4) ─────────────────────────
const TEXT = {
  login_required: '로그인이 필요합니다.',
  get session_evicted() { return '다른 기기에서 로그인해 이 기기는 로그아웃되었습니다. 한 아이디로 동시에 로그인할 수 있는 기기는 ' + maxSessions() + '대입니다.'; },
  blocked: '이용이 정지된 계정입니다. 문의해 주세요.',
  busy: '요청이 많아 처리하지 못했습니다. 잠시 뒤 다시 시도해 주세요.',
  bad_login_id: '아이디는 영문 소문자로 시작하고, 영문 소문자·숫자·밑줄(_)로 4~20자를 입력해 주세요.',
  reserved_id: '사용할 수 없는 아이디입니다. 다른 아이디를 입력해 주세요.',
  pw_short: '비밀번호는 8자 이상 입력해 주세요.',
  pw_long: '비밀번호는 128자 이하로 입력해 주세요.',
  pw_same: '아이디와 같은 비밀번호는 사용할 수 없습니다.',
  pw_easy: '너무 쉬운 비밀번호입니다. 다른 비밀번호를 입력해 주세요.',
  bad_type: '요청을 처리하지 못했습니다. 페이지를 새로고침한 뒤 다시 시도해 주세요.',
  bad_origin: '요청을 처리하지 못했습니다. 페이지를 새로고침한 뒤 다시 시도해 주세요.',
  db_down: '서버에 연결하지 못했습니다. 잠시 뒤 다시 시도해 주세요.',
};

// ── 아이디·비밀번호 규칙 (D1) ─────────────────────────────────────────────
const LOGIN_ID_RE = /^[a-z][a-z0-9_]{3,19}$/;
const RESERVED = new Set([
  'admin', 'administrator', 'root', 'system', 'sysop', 'kbot', 'k_bot', 'kakao', 'kakaotalk', 'support',
  'help', 'helpdesk', 'manage', 'manager', 'master', 'operator', 'official', 'staff', 'panel', 'console',
  'login', 'logout', 'signup', 'account', 'accounts', 'member', 'members', 'api', 'null', 'undefined',
  'guest', 'anonymous', 'owner', 'webmaster', 'security', 'billing', 'notice', 'service', 'contact',
]);
const RESERVED_PREFIX = ['admin', 'kbot', 'operator', 'official'];

function nfkc(v) {
  return String(v === null || v === undefined ? '' : v).normalize('NFKC');
}

// 소문자·trim, 규칙 밖이면 ''
function normLoginId(raw) {
  const s = nfkc(raw).trim().toLowerCase();
  return LOGIN_ID_RE.test(s) ? s : '';
}

function isReserved(id) {
  if (RESERVED.has(id)) return true;
  return RESERVED_PREFIX.some((p) => id.indexOf(p) === 0);
}

// -> null | {reason, error}
function loginIdProblem(raw) {
  const id = normLoginId(raw);
  if (!id) return { reason: 'bad_login_id', error: TEXT.bad_login_id };
  if (isReserved(id)) return { reason: 'reserved_id', error: TEXT.reserved_id };
  return null;
}

const EASY = new Set([
  'password', 'password1', 'password12', 'password123', 'passw0rd', 'p@ssw0rd', 'qwerty12', 'qwerty123',
  'qwertyui', 'qwertyuiop', '1q2w3e4r', '1q2w3e4r5t', '1q2w3e4r!', 'asdf1234', 'asdfasdf', 'qwer1234',
  'abcd1234', 'abc12345', 'a1234567', 'a12345678', 'iloveyou', 'zxcvbnm1', '12341234', '11223344',
  'kakaotalk', 'kakao123', 'kbot1234', 'admin123', 'admin1234', 'letmein1', 'sunshine', 'princess',
]);

function sequential(s) {
  if (!/^[0-9]+$/.test(s) && !/^[a-z]+$/.test(s)) return false;
  let up = true;
  let down = true;
  for (let i = 1; i < s.length; i++) {
    const d = s.charCodeAt(i) - s.charCodeAt(i - 1);
    if (d !== 1 && !(d === -9 && s[i] === '0')) up = false;
    if (d !== -1) down = false;
  }
  return up || down;
}

// -> null | {reason:'bad_password', error}
function passwordProblem(pw, loginId) {
  const s = nfkc(pw);
  if (s.length < 8) return { reason: 'bad_password', error: TEXT.pw_short };
  if (s.length > 128) return { reason: 'bad_password', error: TEXT.pw_long };
  const low = s.toLowerCase();
  const id = nfkc(loginId).trim().toLowerCase();
  if (id && low === id) return { reason: 'bad_password', error: TEXT.pw_same };
  if (EASY.has(low) || /^(.)\1+$/.test(s) || sequential(low) || /^(.{1,4})\1+$/.test(low)) {
    return { reason: 'bad_password', error: TEXT.pw_easy };
  }
  return null;
}

// ── scrypt (8.1) ────────────────────────────────────────────────────────────
// N=2^15·r=8·p=1·32바이트, salt 16바이트, maxmem = 256*N*r. 동시 2개 + 대기 목록 상한 20.
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const DK_LEN = 32;
const HASH_CONCURRENCY = 2;

function logN() {
  const n = parseInt(process.env.AUTH_SCRYPT_LOG_N, 10);
  if (!isFinite(n)) return 15;
  return Math.min(17, Math.max(10, n));
}

function queueMax() {
  const n = parseInt(process.env.AUTH_HASH_QUEUE_MAX, 10);
  return isFinite(n) && n >= 0 ? n : 20;
}

let hashRunning = 0;
const hashWaiting = [];

function busyError() {
  const e = new Error('busy');
  e.code = 'busy';
  e.status = 503;
  e.reason = 'busy';
  e.publicError = TEXT.busy;
  return e;
}

// 해시 작업 1개를 슬롯에서 돌린다. 대기 목록이 가득 차면 바로 busy 로 거절한다.
function withHashSlot(fn) {
  return new Promise((resolve, reject) => {
    const run = () => {
      hashRunning++;
      Promise.resolve().then(fn).then(resolve, reject).finally(() => {
        hashRunning--;
        const next = hashWaiting.shift();
        if (next) next();
      });
    };
    if (hashRunning < HASH_CONCURRENCY) return run();
    if (hashWaiting.length >= queueMax()) return reject(busyError());
    hashWaiting.push(run);
  });
}

function hashStats() {
  return { running: hashRunning, waiting: hashWaiting.length, max: queueMax() };
}

function scryptRaw(pw, salt, ln, r, p) {
  const N = Math.pow(2, ln);
  return new Promise((resolve, reject) => {
    crypto.scrypt(nfkc(pw), salt, DK_LEN, { N: N, r: r, p: p, maxmem: 256 * N * r }, (err, dk) => {
      if (err) reject(err); else resolve(dk);
    });
  });
}

function formatHash(ln, r, p, salt, dk) {
  return '$scrypt$ln=' + ln + ',r=' + r + ',p=' + p + '$' + salt.toString('base64url') + '$' + dk.toString('base64url');
}

function parseHash(stored) {
  const m = /^\$scrypt\$ln=(\d{1,2}),r=(\d{1,2}),p=(\d{1,2})\$([A-Za-z0-9_-]{16,64})\$([A-Za-z0-9_-]{32,128})$/.exec(String(stored || ''));
  if (!m) return null;
  const ln = Number(m[1]);
  const r = Number(m[2]);
  const p = Number(m[3]);
  if (ln < 10 || ln > 20 || r < 1 || r > 32 || p < 1 || p > 4) return null;
  const salt = Buffer.from(m[4], 'base64url');
  const dk = Buffer.from(m[5], 'base64url');
  if (salt.length < 8 || dk.length !== DK_LEN) return null;
  return { ln: ln, r: r, p: p, salt: salt, dk: dk };
}

// -> Promise<string>
async function hashPassword(pw) {
  const ln = logN();
  const salt = crypto.randomBytes(16);
  const dk = await withHashSlot(() => scryptRaw(pw, salt, ln, SCRYPT_R, SCRYPT_P));
  return formatHash(ln, SCRYPT_R, SCRYPT_P, salt, dk);
}

// 없는 아이디도 같은 시간이 걸리게 지금 매개변수로 더미 해시를 한 번 돈다.
const DUMMY_SALT = crypto.randomBytes(16);

// -> Promise<{ok:boolean, rehash:boolean}>. stored 가 없거나 깨졌으면 더미 해시만 하고 false.
async function verifyPassword(pw, stored) {
  const h = parseHash(stored);
  if (!h) {
    await withHashSlot(() => scryptRaw(pw, DUMMY_SALT, logN(), SCRYPT_R, SCRYPT_P));
    return { ok: false, rehash: false };
  }
  const dk = await withHashSlot(() => scryptRaw(pw, h.salt, h.ln, h.r, h.p));
  const ok = dk.length === h.dk.length && crypto.timingSafeEqual(dk, h.dk);
  return { ok: ok, rehash: ok && (h.ln !== logN() || h.r !== SCRYPT_R || h.p !== SCRYPT_P) };
}

// ── 쿠키 ────────────────────────────────────────────────────────────────────
function isHttps(req) {
  if (req && req.secure) return true;
  const p = req && req.headers ? req.headers['x-forwarded-proto'] : '';
  return String(p || '').split(',')[0].trim() === 'https';
}

function cookieValue(req, name) {
  const raw = req && req.headers ? req.headers.cookie : '';
  if (!raw) return '';
  const parts = String(raw).split(';');
  for (let i = 0; i < parts.length; i++) {
    const s = parts[i].trim();
    const eq = s.indexOf('=');
    if (eq < 1) continue;
    if (s.slice(0, eq) === name) {
      try { return decodeURIComponent(s.slice(eq + 1)); } catch (e) { return ''; }
    }
  }
  return '';
}

// 모든 Set-Cookie 는 append 로 쓴다(setHeader 는 앞의 쿠키를 덮어쓴다).
function appendCookie(res, value) {
  if (!res || res.headersSent) return;
  if (typeof res.append === 'function') res.append('Set-Cookie', value);
  else {
    const prev = res.getHeader('Set-Cookie');
    const list = prev ? (Array.isArray(prev) ? prev : [String(prev)]) : [];
    list.push(value);
    res.setHeader('Set-Cookie', list);
  }
}

function writeCookie(req, res, token, maxAgeMs) {
  const bits = [COOKIE + '=' + token, 'Path=/', 'HttpOnly', 'SameSite=Lax',
    'Max-Age=' + Math.max(1, Math.floor(maxAgeMs / 1000))];
  if (isHttps(req)) bits.push('Secure');
  appendCookie(res, bits.join('; '));
}

function clearCookie(req, res) {
  const sec = isHttps(req) ? '; Secure' : '';
  appendCookie(res, COOKIE + '=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0' + sec);
}

function clearOldPanelCookie(req, res) {
  const sec = isHttps(req) ? '; Secure' : '';
  appendCookie(res, OLD_PANEL_COOKIE + '=; Path=/panel; HttpOnly; SameSite=Lax; Max-Age=0' + sec);
}

// ── 세션 (D3, 8.2) ──────────────────────────────────────────────────────────
function sha256hex(s) {
  return crypto.createHash('sha256').update(String(s)).digest('hex');
}

const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

function tokenOf(req) {
  const t = cookieValue(req, COOKIE);
  return TOKEN_RE.test(t) ? t : '';
}

// sid(sha256 hex) -> { at, row|null }
const cache = new Map();

function dropSid(sid) {
  cache.delete(sid);
}

// 그 회원의 메모리 저장 항목을 모두 지운다(종료·차단·관리자 조치 뒤)
function forgetMember(memberId) {
  const id = Number(memberId);
  for (const [sid, hit] of cache) if (hit.row && Number(hit.row.member_id) === id) cache.delete(sid);
}

function remember(sid, row) {
  if (cache.size >= CACHE_MAX) {
    const now = Date.now();
    for (const [k, v] of cache) if (now - v.at >= CACHE_MS) cache.delete(k);
    if (cache.size >= CACHE_MAX) cache.clear();
  }
  cache.set(sid, { at: Date.now(), row: row });
}

function ipText(req) {
  const ip = rl.ipOf(req);
  return ip && ip !== 'unknown' ? ip.slice(0, 64) : null;
}

function uaText(req) {
  const ua = req && req.headers ? req.headers['user-agent'] : '';
  return ua ? String(ua).slice(0, 300) : null;
}

// -> Promise<{sid, evicted:number}>. 쿠키도 여기서 쓴다. 이 요청이 이미 들고 온 세션은 끊는다
// (같은 브라우저가 다시 로그인하면서 슬롯 하나를 헛되이 차지하지 않게).
async function startSession(req, res, memberId, method) {
  const token = crypto.randomBytes(32).toString('base64url');
  const sid = sha256hex(token);
  const now = Date.now();
  const ttl = ttlMs();
  const prevTok = tokenOf(req);
  const prevSid = prevTok ? sha256hex(prevTok) : '';
  const evicted = await db.tx(async (c) => {
    // 같은 회원의 동시 로그인을 줄 세운다(상한 계산이 겹치지 않게)
    await c.query('SELECT id FROM members WHERE id=$1 FOR UPDATE', [memberId]);
    if (prevSid) {
      await c.query(
        "UPDATE member_sessions SET revoked_at=$2, revoked_why='logout' WHERE id=$1 AND revoked_at IS NULL",
        [prevSid, now]);
    }
    await c.query(
      `INSERT INTO member_sessions (id, member_id, method, created_at, auth_at, last_seen_at, expires_at, ip, ua)
       VALUES ($1,$2,$3,$4,$4,$4,$5,$6,$7)`,
      [sid, memberId, method === 'google' ? 'google' : 'pw', now, now + ttl, ipText(req), uaText(req)]);
    // 상한을 넘으면 가장 오래 쓰지 않은 세션부터 끊는다(거절 대신 밀어내기, D3)
    const r = await c.query(
      `UPDATE member_sessions SET revoked_at=$2, revoked_why='cap'
        WHERE id IN (SELECT id FROM member_sessions
                      WHERE member_id=$1 AND revoked_at IS NULL AND expires_at > $2 AND id <> $3
                      ORDER BY last_seen_at DESC, created_at DESC
                      OFFSET $4)
        RETURNING id`,
      [memberId, now, sid, maxSessions() - 1]);
    await c.query('UPDATE members SET last_login_at=$2 WHERE id=$1', [memberId, now]);
    return r.rows.map((x) => x.id);
  });
  if (prevSid) dropSid(prevSid);
  evicted.forEach(dropSid);
  writeCookie(req, res, token, ttl);
  return { sid: sid, evicted: evicted.length };
}

function shapeSession(row, sid, token, renew) {
  const out = {
    sid: sid,
    method: row.method,
    auth_at: Number(row.auth_at),
    created_at: Number(row.created_at),
    member: {
      id: Number(row.member_id),
      login_id: row.login_id,
      blocked_reason: row.blocked_reason || null,
      macro_until: Number(row.macro_until) || 0,
      legacy_room_until: Number(row.legacy_room_until) || 0,
    },
  };
  Object.defineProperty(out, 'token', { value: token, enumerable: false });
  Object.defineProperty(out, 'renew', { value: !!renew, enumerable: false });
  return out;
}

// -> Promise<null | {sid, method, auth_at, member:{...}} | {revoked:string}>
async function readSession(req) {
  const token = tokenOf(req);
  if (!token) return null;
  const sid = sha256hex(token);
  const now = Date.now();
  let hit = cache.get(sid);
  if (!hit || now - hit.at >= CACHE_MS) {
    const row = await db.one(
      `SELECT s.id, s.member_id, s.method, s.created_at, s.auth_at, s.last_seen_at, s.expires_at,
              s.revoked_at, s.revoked_why, m.login_id, m.blocked_reason, m.macro_until, m.legacy_room_until
         FROM member_sessions s JOIN members m ON m.id = s.member_id
        WHERE s.id = $1`, [sid]);
    remember(sid, row);
    hit = cache.get(sid);
  }
  const row = hit.row;
  if (!row) return null;
  if (row.revoked_at) return { revoked: row.revoked_why || 'revoke' };
  if (Number(row.expires_at) <= now) return null;
  let renew = false;
  const ttl = ttlMs();
  const left = Number(row.expires_at) - now;
  if (now - Number(row.last_seen_at) >= SEEN_EVERY_MS || left < ttl / 2) {
    const exp = left < ttl / 2 ? now + ttl : Number(row.expires_at);
    renew = exp !== Number(row.expires_at);
    await db.q(
      'UPDATE member_sessions SET last_seen_at=$2, expires_at=$3 WHERE id=$1 AND revoked_at IS NULL',
      [sid, now, exp]);
    row.last_seen_at = now;
    row.expires_at = exp;
  }
  return shapeSession(row, sid, token, renew);
}

function sendJson(res, status, body) {
  if (!res || res.headersSent) return;
  res.status(status).json(body);
}

// -> Promise<Session|null>. 401/403 응답까지 직접 쓴다. opts.allowBlocked
async function requireMember(req, res, opts) {
  const o = opts || {};
  let s;
  try {
    s = await readSession(req);
  } catch (e) {
    console.error('[member-auth] 세션 읽기 실패: ' + (e && e.message ? e.message : e));
    sendJson(res, 503, { ok: false, reason: 'db_down', error: TEXT.db_down });
    return null;
  }
  if (!s || s.revoked) {
    if (cookieValue(req, COOKIE)) clearCookie(req, res);
    if (s && s.revoked === 'cap') {
      sendJson(res, 401, { ok: false, reason: 'session_evicted', error: TEXT.session_evicted });
    } else {
      sendJson(res, 401, { ok: false, reason: 'login_required', error: TEXT.login_required });
    }
    return null;
  }
  if (s.member.blocked_reason && !o.allowBlocked) {
    sendJson(res, 403, { ok: false, reason: 'blocked', error: TEXT.blocked });
    return null;
  }
  if (s.renew) writeCookie(req, res, s.token, ttlMs());
  if (req) req.kbSession = s;
  return s;
}

// readSession 이 만료를 늘렸으면(renew) 쿠키도 다시 쓴다. requireMember 를 쓰지 않는 경로(/api/site)용.
function refreshCookie(req, res, s) {
  if (s && !s.revoked && s.renew && s.token) writeCookie(req, res, s.token, ttlMs());
}

// -> Promise<void>. 지금 세션을 끊고 쿠키(kb_s, 예전 panel)를 지운다.
async function endSession(req, res) {
  const token = tokenOf(req);
  if (token) {
    const sid = sha256hex(token);
    await db.q(
      "UPDATE member_sessions SET revoked_at=$2, revoked_why='logout' WHERE id=$1 AND revoked_at IS NULL",
      [sid, Date.now()]);
    dropSid(sid);
  }
  clearCookie(req, res);
  clearOldPanelCookie(req, res);
}

// -> Promise<number>. exceptSid 는 그대로 둔다.
async function endAllSessions(memberId, opts) {
  const o = opts || {};
  const why = String(o.why || 'revoke').slice(0, 32);
  const r = await db.q(
    `UPDATE member_sessions SET revoked_at=$2, revoked_why=$3
      WHERE member_id=$1 AND revoked_at IS NULL AND ($4::text IS NULL OR id <> $4::text)`,
    [memberId, Date.now(), why, o.exceptSid || null]);
  forgetMember(memberId);
  return r.rowCount;
}

// ── 구매 사이트 기준 주소 (lib/features.js purchaseBase 와 같은 순서) ─────────
function purchaseBase(req) {
  let base = process.env.PURCHASE_BASE || process.env.RENDER_EXTERNAL_URL || process.env.SELF_URL || '';
  if (!base && req && req.headers) {
    const proto = String(req.headers['x-forwarded-proto'] || req.protocol || 'https').split(',')[0].trim();
    const host = req.headers['x-forwarded-host'] || req.headers.host;
    if (host) base = proto + '://' + host;
  }
  return String(base).replace(/\/+$/, '');
}

function originOf(url) {
  try { return new URL(url).origin; } catch (e) { return ''; }
}

function requestOrigin(req) {
  const host = req && req.headers ? (req.headers['x-forwarded-host'] || req.headers.host) : '';
  if (!host) return '';
  const proto = isHttps(req) ? 'https' : String((req && req.protocol) || 'http');
  return originOf(proto + '://' + String(host).split(',')[0].trim());
}

// ── CSRF (8.3) ──────────────────────────────────────────────────────────────
// GET/HEAD/OPTIONS 외 요청이 3.1 의 경로면 (가) application/json 아니면 415 (나) Origin 이 있으면
// 요청 origin 또는 purchaseBase origin 과 같아야 함(null 거절) (다) Sec-Fetch-Site 가 있으면 same-origin.
function guardedPath(p, method) {
  if (p === '/api/order') return method === 'POST';
  if (p === '/api/room-preview') return true;
  return p.indexOf('/api/auth/') === 0 || p.indexOf('/api/my/') === 0 || p.indexOf('/panel/api/') === 0;
}

function sameOriginWrites(req, res, next) {
  const m = String(req.method || 'GET').toUpperCase();
  if (m === 'GET' || m === 'HEAD' || m === 'OPTIONS') return next();
  const p = rl.normPath(req.path || req.url);
  if (!guardedPath(p, m)) return next();
  const ctype = String((req.headers && req.headers['content-type']) || '').split(';')[0].trim().toLowerCase();
  if (ctype !== 'application/json') {
    return sendJson(res, 415, { ok: false, reason: 'bad_type', error: TEXT.bad_type });
  }
  const origin = req.headers && req.headers.origin;
  if (origin !== undefined) {
    const o = String(origin);
    const allowed = [requestOrigin(req), originOf(purchaseBase(req))].filter(Boolean);
    if (o === 'null' || allowed.indexOf(o) < 0) {
      return sendJson(res, 403, { ok: false, reason: 'bad_origin', error: TEXT.bad_origin });
    }
  }
  const site = req.headers && req.headers['sec-fetch-site'];
  if (site !== undefined && String(site) !== 'same-origin') {
    return sendJson(res, 403, { ok: false, reason: 'bad_origin', error: TEXT.bad_origin });
  }
  return next();
}

// ── 공개 모양 ───────────────────────────────────────────────────────────────
function maskEmail(email) {
  const s = String(email || '').trim();
  if (!s) return null;
  const at = s.lastIndexOf('@');
  const local = at > 0 ? s.slice(0, at) : s;
  const domain = at > 0 ? s.slice(at) : '';
  const keep = local.length > 2 ? 2 : 1;
  return local.slice(0, keep) + '***' + domain;
}

// -> {id, login_id, google_linked, google_email_masked}
function publicMember(row, googleRow) {
  if (!row) return null;
  return {
    id: Number(row.id),
    login_id: row.login_id,
    google_linked: !!googleRow,
    google_email_masked: googleRow ? maskEmail(googleRow.email) : null,
  };
}

// ── 채널톡 (6.10 7, 8.8) ────────────────────────────────────────────────────
function configSecret() {
  return String(process.env.CONFIG_SECRET || '').trim();
}

function pluginKey() {
  return String(process.env.CHANNEL_PLUGIN_KEY || '').trim();
}

// hex 가 아니면 없는 것으로 본다(warnEnv 가 따로 경고한다)
function memberSecret() {
  const s = String(process.env.CHANNEL_MEMBER_SECRET || '').trim();
  if (!s || s.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(s)) return null;
  return Buffer.from(s, 'hex');
}

function memberSecretProblem() {
  const s = String(process.env.CHANNEL_MEMBER_SECRET || '').trim();
  if (!s) return '';
  return memberSecret() ? '' : 'CHANNEL_MEMBER_SECRET 이 hex 가 아닙니다';
}

let memberIdKeyCache = null;
function memberIdKey() {
  const secret = configSecret();
  if (!secret) return null;
  if (!memberIdKeyCache || memberIdKeyCache.secret !== secret) {
    memberIdKeyCache = {
      secret: secret,
      key: Buffer.from(crypto.hkdfSync('sha256', Buffer.from(secret, 'utf8'), Buffer.from('kbot'), Buffer.from('channel-member/v1'), 32)),
    };
  }
  return memberIdKeyCache.key;
}

// -> string | null. CHANNEL_MEMBER_SECRET 없으면 null. 순번이 아니라 추측할 수 없는 값('m' + 24hex).
function channelMemberId(memberId) {
  if (memberId === null || memberId === undefined || !memberSecret()) return null;
  const key = memberIdKey();
  if (!key) return null;
  return 'm' + crypto.createHmac('sha256', key).update(String(memberId)).digest('hex').slice(0, 24);
}

function channelMemberHash(channelId) {
  const secret = memberSecret();
  if (!secret || !channelId) return null;
  return crypto.createHmac('sha256', secret).update(String(channelId)).digest('hex');
}

// -> null | {plugin_key, member_id?, member_hash?, name?}
function channelConfig(member) {
  const key = pluginKey();
  if (!key) return null;
  const out = { plugin_key: key };
  if (member && member.id !== undefined && member.id !== null) {
    if (member.login_id) out.name = String(member.login_id);
    const mid = channelMemberId(member.id);
    const hash = mid ? channelMemberHash(mid) : null;
    if (mid && hash) {
      out.member_id = mid;
      out.member_hash = hash;
    }
  }
  return out;
}

// ── 로그인 실패 제한은 lib/ratelimit.js 에 있다(9.2 가 그쪽 이름으로 적어 둠). 편의상 다시 내보낸다.
const noteLoginFail = rl.noteLoginFail;
const loginBlockedMs = rl.loginBlockedMs;
const loginSlowMs = rl.loginSlowMs;
const clearLoginFails = rl.clearLoginFails;

module.exports = {
  COOKIE,
  maxSessions,
  normLoginId,
  loginIdProblem,
  passwordProblem,
  hashPassword,
  verifyPassword,
  startSession,
  readSession,
  requireMember,
  endSession,
  endAllSessions,
  sameOriginWrites,
  publicMember,
  channelConfig,
  channelMemberId,
  noteLoginFail,
  loginBlockedMs,
  loginSlowMs,
  clearLoginFails,
  // 작업 1 내부·시험용 보조
  TEXT, OLD_PANEL_COOKIE, ttlMs, resetWindowMs, logN, queueMax, hashStats, busyError, parseHash,
  isHttps, cookieValue, appendCookie, writeCookie, refreshCookie, clearCookie, clearOldPanelCookie, sha256hex,
  forgetMember, purchaseBase, requestOrigin, maskEmail, channelMemberHash, memberSecretProblem,
};
