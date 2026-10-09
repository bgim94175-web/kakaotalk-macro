// 회원·인증 라우트 — docs/ACCOUNTS_V1.md 3.2(표·3.2.1·3.2.2·Google 흐름 B1~B5).
//   GET  /api/site                 공개 설정 + 지금 로그인한 회원(없으면 null). 401 을 내지 않는다
//   POST /api/auth/signup|login|logout|logout-all|password|claim|sessions/revoke|google/unlink
//   GET  /api/auth/sessions, /api/me
//   GET  /auth/google/start, /auth/google/callback
// 레이트리밋 종류는 lib/ratelimit.js kindOf, CSRF 는 server.js 의 sameOriginWrites 가 먼저 본다.
'use strict';

const express = require('express');

const db = require('../lib/db');
const rl = require('../lib/ratelimit');
const memberAuth = require('../lib/member-auth');
const oauth = require('../lib/google-oauth');
const audit = require('../lib/audit');
const entitle = require('../lib/entitle');
const installs = require('../lib/installs');
const pricing = require('../lib/pricing');
const panelRoutes = require('./panel');

const router = express.Router();

const T = memberAuth.TEXT;
const TEXT = {
  bad_credentials: '아이디 또는 비밀번호가 일치하지 않습니다. 다시 입력하십시오',
  taken: '이미 사용 중인 아이디입니다. 다른 아이디를 입력하십시오',
  bad_contact: '연락처는 100자 이하로 입력하십시오',
  signup_limit: '가입 요청이 너무 많습니다. 잠시 후 다시 시도하십시오',
  wrong_current: '현재 비밀번호가 일치하지 않습니다. 다시 입력하십시오',
  reauth_needed: '비밀번호 재설정 시간이 지났습니다. 현재 비밀번호를 입력하거나 Google 계정으로 다시 로그인하십시오.',
  no_session: '없는 로그인 기기입니다.',
  not_linked: '연결된 Google 계정이 없습니다.',
  claim_not_found: '키를 찾을 수 없습니다. 키를 확인하십시오.',
  server: '처리하지 못했습니다. 잠시 뒤 다시 시도하십시오.',
};

function lockedText(ms) {
  return '로그인 실패 횟수를 초과했습니다. ' + Math.max(1, Math.ceil(ms / 60000)) + '분 후 다시 시도하십시오';
}

function fail(res, status, reason, error, extra) {
  if (res.headersSent) return;
  res.status(status).json(Object.assign({ ok: false, reason: reason, error: error }, extra || {}));
}

const wrap = (fn) => (req, res) => Promise.resolve(fn(req, res)).catch((e) => {
  if (e && e.code === 'busy') return fail(res, 503, 'busy', T.busy);
  console.error('[auth ' + req.method + ' ' + req.path + '] ' + (e && e.stack ? e.stack : e));
  fail(res, 500, 'server_error', TEXT.server);
});

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// 다른 작업이 아직 틀(NOT_IMPLEMENTED)인 동안에도 이 화면이 열리게. 그 밖의 오류는 그대로 던진다.
let warnedStub = {};
async function optional(name, fn, fallback) {
  try {
    return await fn();
  } catch (e) {
    if (e && e.code === 'NOT_IMPLEMENTED') {
      if (!warnedStub[name]) { warnedStub[name] = true; console.warn('[auth] ' + name + ' 이(가) 아직 구현되지 않아 기본값을 씁니다'); }
      return fallback;
    }
    throw e;
  }
}

function ipOf(req) {
  return audit.ipOf(req);
}

function memberAudit(req, kind, memberId, detail) {
  return audit.log(kind, { member_id: memberId, detail: detail, ip: ipOf(req) });
}

async function googleRow(memberId, client) {
  return db.one('SELECT member_id, sub, email, linked_at FROM member_google WHERE member_id=$1', [memberId], client);
}

function contactInfo() {
  try { return pricing.contactInfo ? pricing.contactInfo() : null; } catch (e) { return null; }
}

// ── 기기 요약·IP 가림 (GET /api/auth/sessions) ──────────────────────────────
function uaSummary(ua) {
  const s = String(ua || '');
  if (!s) return '알 수 없는 기기';
  let os = '';
  if (/iPhone/.test(s)) os = 'iPhone';
  else if (/iPad/.test(s)) os = 'iPad';
  else if (/Android/.test(s)) os = 'Android';
  else if (/Windows/.test(s)) os = 'Windows';
  else if (/CrOS/.test(s)) os = 'ChromeOS';
  else if (/Mac OS X|Macintosh/.test(s)) os = 'macOS';
  else if (/Linux/.test(s)) os = 'Linux';
  let br = '';
  if (/KAKAOTALK/i.test(s)) br = '카카오톡';
  else if (/NAVER\(inapp/i.test(s)) br = '네이버';
  else if (/SamsungBrowser\//.test(s)) br = '삼성 인터넷';
  else if (/Whale\//.test(s)) br = '웨일';
  else if (/Edg(e|A|iOS)?\//.test(s)) br = 'Edge';
  else if (/OPR\/|Opera/.test(s)) br = 'Opera';
  else if (/Firefox\/|FxiOS\//.test(s)) br = 'Firefox';
  else if (/Chrome\/|CriOS\//.test(s)) br = 'Chrome';
  else if (/Safari\//.test(s)) br = 'Safari';
  const parts = [os, br].filter(Boolean);
  return parts.length ? parts.join(' · ') : '알 수 없는 기기';
}

function maskIp(ip) {
  const s = String(ip || '');
  if (!s) return '';
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(s)) return s.replace(/\.\d{1,3}$/, '.*');
  if (s.indexOf(':') >= 0) {
    const parts = s.split(':');
    parts[parts.length - 1] = '*';
    return parts.join(':');
  }
  return '*';
}

function cleanContact(v) {
  if (v === undefined || v === null) return { ok: true, v: null };
  const s = String(v).replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  if (!s) return { ok: true, v: null };
  if (s.length > 100) return { ok: false };
  return { ok: true, v: s };
}

function body(req) {
  return req.body && typeof req.body === 'object' ? req.body : {};
}

function str(v, max) {
  if (typeof v !== 'string' && typeof v !== 'number') return '';
  const s = String(v);
  return max && s.length > max ? s.slice(0, max) : s;
}

// 로그인 실패 계수기 앞단(3.1 순서: 레이트리밋 → loginBlockedMs → loginSlowMs → scrypt).
// 잠겼으면 응답까지 쓰고 false.
async function passLoginGate(req, res, idKey) {
  const ip = rl.ipOf(req);
  const left = rl.loginBlockedMs(idKey, ip);
  if (left > 0) {
    res.set('Retry-After', String(Math.ceil(left / 1000)));
    fail(res, 429, 'locked', lockedText(left), { retry_after: Math.ceil(left / 1000) });
    return false;
  }
  const slow = rl.loginSlowMs(idKey);
  if (slow > 0) await sleep(slow);
  return true;
}

function noteFail(req, idKey) {
  const r = rl.noteLoginFail(idKey, rl.ipOf(req));
  if (r.blocked) {
    console.log('[auth] 로그인 실패 잠금 ' + idKey + ' @ ' + rl.ipOf(req));
    audit.log('member_lockout', { detail: '로그인 실패 ' + r.fails + '회로 잠금: ' + idKey, ip: ipOf(req) });
  }
  return r;
}

// ── GET /api/site ───────────────────────────────────────────────────────────
router.get('/api/site', wrap(async (req, res) => {
  res.set('Cache-Control', 'no-store');
  let member = null;
  let s = null;
  try { s = await memberAuth.readSession(req); } catch (e) { s = null; }
  if (s && !s.revoked && !s.member.blocked_reason) {
    memberAuth.refreshCookie(req, res, s);
    const g = await googleRow(s.member.id).catch(() => null);
    member = { id: s.member.id, login_id: s.member.login_id, google_linked: !!g };
  }
  res.json({
    ok: true,
    google: oauth.configured(),
    channel: memberAuth.channelConfig(member),
    contact: contactInfo(),
    member: member,
  });
}));

// ── 가입 ────────────────────────────────────────────────────────────────────
router.post('/api/auth/signup', wrap(async (req, res) => {
  const b = body(req);
  const ip = rl.ipOf(req);
  // 분당 한도(signup 버킷)와 별도로 IP당 시간 20회
  const hour = rl.hit('signup-hour', ip, 20, 60 * 60000);
  if (!hour.ok) {
    res.set('Retry-After', String(hour.retryAfter));
    return fail(res, 429, 'rate_limited', TEXT.signup_limit);
  }
  const idProblem = memberAuth.loginIdProblem(b.login_id);
  if (idProblem) return fail(res, 400, idProblem.reason, idProblem.error);
  const loginId = memberAuth.normLoginId(b.login_id);
  const pw = str(b.password, 1000);
  const pwProblem = memberAuth.passwordProblem(pw, loginId);
  if (pwProblem) return fail(res, 400, pwProblem.reason, pwProblem.error);
  const contact = cleanContact(b.contact);
  if (!contact.ok) return fail(res, 400, 'bad_contact', TEXT.bad_contact);

  const exists = await db.one('SELECT id FROM members WHERE lower(login_id)=lower($1)', [loginId]);
  if (exists) return fail(res, 409, 'taken', TEXT.taken);
  const hash = await memberAuth.hashPassword(pw);
  const now = Date.now();
  const row = await db.one(
    `INSERT INTO members (login_id, pw_hash, contact, created_at, pw_changed_at)
     VALUES ($1,$2,$3,$4,$4) ON CONFLICT DO NOTHING RETURNING id, login_id`,
    [loginId, hash, contact.v, now]);
  if (!row) return fail(res, 409, 'taken', TEXT.taken);
  await memberAudit(req, 'member', row.id, 'signup ' + loginId);
  await memberAuth.startSession(req, res, row.id, 'pw');
  res.json({ ok: true, member: memberAuth.publicMember(row, null) });
}));

// ── 로그인 ──────────────────────────────────────────────────────────────────
router.post('/api/auth/login', wrap(async (req, res) => {
  const b = body(req);
  const rawId = str(b.login_id, 200);
  const pw = str(b.password, 1000);
  const idKey = rawId.normalize('NFKC').trim().toLowerCase();
  if (!idKey || !pw) return fail(res, 401, 'bad_credentials', TEXT.bad_credentials);
  if (!(await passLoginGate(req, res, idKey))) return;

  const loginId = memberAuth.normLoginId(rawId);
  const row = loginId
    ? await db.one('SELECT id, login_id, pw_hash, blocked_reason FROM members WHERE lower(login_id)=lower($1)', [loginId])
    : null;
  const v = await memberAuth.verifyPassword(pw, row ? row.pw_hash : null);
  if (!row || !v.ok) {
    noteFail(req, idKey);
    return fail(res, 401, 'bad_credentials', TEXT.bad_credentials);
  }
  rl.clearLoginFails(idKey, rl.ipOf(req));
  // 비밀번호가 맞은 뒤에만 차단을 알린다(추측하는 쪽에 차단 여부가 새지 않게)
  if (row.blocked_reason) return fail(res, 403, 'blocked', T.blocked);
  if (v.rehash) {
    try {
      const h = await memberAuth.hashPassword(pw);
      await db.q('UPDATE members SET pw_hash=$2 WHERE id=$1', [row.id, h]);
    } catch (e) {
      if (!(e && e.code === 'busy')) console.error('[auth] 재해시 실패: ' + e.message);
    }
  }
  const started = await memberAuth.startSession(req, res, row.id, 'pw');
  const g = await googleRow(row.id);
  res.json({ ok: true, member: memberAuth.publicMember(row, g), evicted: started.evicted });
}));

// 로그아웃은 세션이 이미 끝났어도 쿠키를 지우고 ok 를 준다(화면이 막히지 않게).
router.post('/api/auth/logout', wrap(async (req, res) => {
  await memberAuth.endSession(req, res);
  res.json({ ok: true });
}));

router.post('/api/auth/logout-all', wrap(async (req, res) => {
  const s = await memberAuth.requireMember(req, res, { allowBlocked: true });
  if (!s) return;
  const n = await memberAuth.endAllSessions(s.member.id, { exceptSid: s.sid, why: 'logout_all' });
  await memberAudit(req, 'member', s.member.id, 'logout_all ' + n);
  res.json({ ok: true, ended: n });
}));

router.get('/api/auth/sessions', wrap(async (req, res) => {
  const s = await memberAuth.requireMember(req, res);
  if (!s) return;
  const r = await db.q(
    `SELECT id, method, created_at, last_seen_at, ip, ua FROM member_sessions
      WHERE member_id=$1 AND revoked_at IS NULL AND expires_at > $2
      ORDER BY last_seen_at DESC, created_at DESC`,
    [s.member.id, Date.now()]);
  res.set('Cache-Control', 'no-store');
  res.json({
    ok: true,
    sessions: r.rows.map((x) => ({
      sid: String(x.id).slice(0, 16),
      current: x.id === s.sid,
      method: x.method,
      created_at: Number(x.created_at),
      last_seen_at: Number(x.last_seen_at),
      device: uaSummary(x.ua),
      ip: maskIp(x.ip),
    })),
  });
}));

router.post('/api/auth/sessions/revoke', wrap(async (req, res) => {
  const s = await memberAuth.requireMember(req, res);
  if (!s) return;
  const sid = str(body(req).sid, 64);
  if (!/^[0-9a-f]{16}$/.test(sid)) return fail(res, 404, 'not_found', TEXT.no_session);
  const r = await db.q(
    `UPDATE member_sessions SET revoked_at=$3, revoked_why='revoke'
      WHERE member_id=$1 AND revoked_at IS NULL AND left(id, 16) = $2 RETURNING id`,
    [s.member.id, sid, Date.now()]);
  if (!r.rowCount) return fail(res, 404, 'not_found', TEXT.no_session);
  memberAuth.forgetMember(s.member.id);
  if (r.rows.some((x) => x.id === s.sid)) memberAuth.clearCookie(req, res);
  res.json({ ok: true });
}));

// ── 비밀번호 변경·재설정 ────────────────────────────────────────────────────
function resetOpen(s) {
  return !!s && s.method === 'google' && Date.now() - Number(s.auth_at) < memberAuth.resetWindowMs();
}

router.post('/api/auth/password', wrap(async (req, res) => {
  const s = await memberAuth.requireMember(req, res);
  if (!s) return;
  const b = body(req);
  const next = str(b.next, 1000);
  const current = str(b.current, 1000);
  const problem = memberAuth.passwordProblem(next, s.member.login_id);
  if (problem) return fail(res, 400, problem.reason, problem.error);
  let how = 'pw_change';
  if (current) {
    const idKey = String(s.member.login_id).toLowerCase();
    if (!(await passLoginGate(req, res, idKey))) return;
    const row = await db.one('SELECT pw_hash FROM members WHERE id=$1', [s.member.id]);
    const v = await memberAuth.verifyPassword(current, row ? row.pw_hash : null);
    if (!v.ok) {
      noteFail(req, idKey);
      return fail(res, 401, 'wrong_current', TEXT.wrong_current);
    }
    rl.clearLoginFails(idKey, rl.ipOf(req));
  } else if (resetOpen(s)) {
    how = 'pw_reset_google';
  } else {
    return fail(res, 403, 'reauth_needed', TEXT.reauth_needed);
  }
  const hash = await memberAuth.hashPassword(next);
  await db.q('UPDATE members SET pw_hash=$2, pw_changed_at=$3 WHERE id=$1', [s.member.id, hash, Date.now()]);
  // 재설정 창은 한 번 쓰면 닫는다(같은 Google 로그인으로 다시 바꾸려면 현재 비밀번호가 필요)
  if (how === 'pw_reset_google') {
    await db.q("UPDATE member_sessions SET auth_at=0 WHERE id=$1", [s.sid]);
  }
  const ended = await memberAuth.endAllSessions(s.member.id, { exceptSid: s.sid, why: 'pw_change' });
  await memberAudit(req, 'member', s.member.id, how + ' (다른 기기 ' + ended + '대 로그아웃)');
  res.json({ ok: true, ended: ended });
}));

// ── 기존 키 이관 (D19, 4.6) ─────────────────────────────────────────────────
router.post('/api/auth/claim', wrap(async (req, res) => {
  const s = await memberAuth.requireMember(req, res);
  if (!s) return;
  const key = str(body(req).key, 80).trim().toUpperCase();
  if (!/^[A-Z0-9-]{8,40}$/.test(key)) return fail(res, 404, 'not_found', TEXT.claim_not_found);
  // 감사 기록(member claim, 이관 IP 포함)은 claimKey 가 같은 트랜잭션에서 쓴다(opts.req, 작업 2).
  const out = await db.tx((c) => entitle.claimKey(c, s.member.id, key, { req: req }));
  if (!out || !out.ok) {
    const st = out && out.status ? out.status : 400;
    return fail(res, st, (out && out.reason) || 'claim_failed', (out && out.error) || TEXT.server);
  }
  const moved = out.moved || {};
  if (typeof panelRoutes.forgetAccounts === 'function') panelRoutes.forgetAccounts(s.member.id);
  memberAuth.forgetMember(s.member.id);
  Promise.resolve().then(() => entitle.pushGrants(s.member.id))
    .catch((e) => console.error('[auth] 이관 뒤 권리 밀기 실패: ' + (e && e.message ? e.message : e)));
  res.json({
    ok: true,
    moved: {
      macro_until: Number(moved.macro_until) || 0,
      legacy_room_until: Number(moved.legacy_room_until) || 0,
      accounts: Number(moved.accounts) || 0,
    },
  });
}));

// ── GET /api/me (3.2.1) ─────────────────────────────────────────────────────
function roomSummary(list) {
  let active = 0;
  let attention = 0;
  for (let i = 0; i < list.length; i++) {
    const d = list[i] && list[i].display;
    if (d === 'active') active++;
    else if (d === 'error' || d === 'waiting') attention++;
  }
  return { total: list.length, active: active, attention: attention };
}

router.get('/api/me', wrap(async (req, res) => {
  const s = await memberAuth.requireMember(req, res);
  if (!s) return;
  const id = s.member.id;
  const row = await db.one(
    'SELECT id, login_id, created_at, macro_until, legacy_room_until, blocked_reason FROM members WHERE id=$1', [id]);
  if (!row) return fail(res, 401, 'login_required', T.login_required);
  const g = await googleRow(id);
  // entitle.summary 가 rooms_list 를 같이 준다(같은 조회를 두 번 하지 않게). 없으면 직접 읽는다.
  const sum = await optional('entitle.summary', () => entitle.summary(id), null);
  const roomsList = sum && Array.isArray(sum.rooms_list)
    ? sum.rooms_list
    : await optional('installs.listForMember', () => installs.listForMember(id), []);
  const list = Array.isArray(roomsList) ? roomsList.slice(0, 50) : [];
  let accounts = sum && sum.accounts;
  if (!accounts) {
    const n = await db.one('SELECT count(*)::int AS n FROM panel_accounts WHERE member_id=$1', [id]);
    accounts = { n: n ? Number(n.n) : 0, max: entitle.MAX_ACCOUNTS };
  }
  const member = memberAuth.publicMember(row, g);
  member.created_at = Number(row.created_at);
  res.set('Cache-Control', 'no-store');
  res.json({
    ok: true,
    member: member,
    macro: entitle.macroView(row),
    legacy_room_until: Number(row.legacy_room_until) || 0,
    accounts: accounts,
    rooms: (sum && sum.rooms) || roomSummary(list),
    rooms_list: list,
    password_reset_open: resetOpen(s),
  });
}));

// ── Google 연결 해제 ────────────────────────────────────────────────────────
router.post('/api/auth/google/unlink', wrap(async (req, res) => {
  const s = await memberAuth.requireMember(req, res);
  if (!s) return;
  const g = await googleRow(s.member.id);
  if (!g) return fail(res, 404, 'not_linked', TEXT.not_linked);
  const pw = str(body(req).password, 1000);
  const idKey = String(s.member.login_id).toLowerCase();
  if (!(await passLoginGate(req, res, idKey))) return;
  const row = await db.one('SELECT pw_hash FROM members WHERE id=$1', [s.member.id]);
  const v = await memberAuth.verifyPassword(pw, pw ? (row && row.pw_hash) : null);
  if (!pw || !v.ok) {
    noteFail(req, idKey);
    return fail(res, 401, 'wrong_current', TEXT.wrong_current);
  }
  rl.clearLoginFails(idKey, rl.ipOf(req));
  await db.q('DELETE FROM member_google WHERE member_id=$1', [s.member.id]);
  await memberAudit(req, 'member', s.member.id, 'google_unlink');
  res.json({ ok: true });
}));

// ── Google 흐름 (B1~B5) ─────────────────────────────────────────────────────
function hostOf(url) {
  try { return new URL(url).host.toLowerCase(); } catch (e) { return ''; }
}

function requestHost(req) {
  const h = req.headers['x-forwarded-host'] || req.headers.host || '';
  return String(h).split(',')[0].trim().toLowerCase();
}

function redirect(res, url) {
  res.set('Cache-Control', 'no-store');
  res.redirect(302, url);
}

async function liveSession(req) {
  try {
    const s = await memberAuth.readSession(req);
    if (!s || s.revoked || s.member.blocked_reason) return null;
    return s;
  } catch (e) {
    return null;
  }
}

router.get('/auth/google/start', wrap(async (req, res) => {
  const mode = req.query.mode === 'link' ? 'link' : 'login';
  const next = oauth.safeNext(typeof req.query.next === 'string' ? req.query.next : '');
  if (!oauth.configured()) return redirect(res, '/login?g=off');
  if (oauth.isWebview(req.headers['user-agent'])) {
    return redirect(res, mode === 'link' ? '/account?g=webview' : oauth.loginWithCode('webview', next));
  }
  // 상태 쿠키가 콜백 호스트에 붙어야 한다 → 기준 주소와 다른 호스트로 왔으면 그쪽으로 옮긴다
  const base = memberAuth.purchaseBase(req);
  const baseHost = hostOf(base);
  if (baseHost && baseHost !== requestHost(req)) return redirect(res, base + req.originalUrl);
  let s = null;
  if (mode === 'link') {
    s = await liveSession(req);
    if (!s) return redirect(res, '/login?g=login_needed&next=' + encodeURIComponent('/account'));
  }
  const state = oauth.randomToken(32);
  const verifier = oauth.randomToken(32);
  const nonce = oauth.randomToken(16);
  const sealed = oauth.sealState({
    s: state, cv: verifier, n: nonce, md: mode,
    m: s ? s.member.id : null,
    sid: s ? s.sid.slice(0, 16) : null,
    nx: next,
    e: Date.now() + oauth.STATE_TTL_MS,
  });
  memberAuth.appendCookie(res, oauth.stateCookie(sealed, memberAuth.isHttps(req)));
  redirect(res, oauth.buildAuthUrl({ redirectUri: oauth.redirectUri(base), state: state, nonce: nonce, verifier: verifier }));
}));

router.get('/auth/google/callback', wrap(async (req, res) => {
  // 어느 결과든 상태 쿠키는 지운다
  memberAuth.appendCookie(res, oauth.clearStateCookie(memberAuth.isHttps(req)));
  const opened = oauth.openState(memberAuth.cookieValue(req, oauth.STATE_COOKIE));
  if (!opened.ok) return redirect(res, '/login?g=expired');
  const st = opened.state;
  const nx = oauth.safeNext(st.nx);
  const toResult = (code) => (st.md === 'link' ? oauth.withCode(nx, code) : oauth.loginWithCode(code, nx));
  if (opened.expired) return redirect(res, toResult('expired'));
  const q = req.query || {};
  if (typeof q.state !== 'string' || !oauth.sameText(q.state, st.s)) return redirect(res, toResult('expired'));
  if (q.error !== undefined) return redirect(res, toResult(q.error === 'access_denied' ? 'denied' : 'error'));
  if (typeof q.code !== 'string' || !q.code) return redirect(res, toResult('error'));

  const base = memberAuth.purchaseBase(req);
  const idToken = await oauth.exchangeCode({ code: q.code, verifier: st.cv, redirectUri: oauth.redirectUri(base) });
  if (!idToken) return redirect(res, toResult('error'));
  const tok = oauth.checkIdToken(idToken, { nonce: st.n });
  if (!tok.ok) {
    console.log('[google] id_token 검사 실패: ' + tok.why);
    return redirect(res, toResult('error'));
  }

  if (st.md === 'link') {
    const s = await liveSession(req);
    if (!s || s.member.id !== Number(st.m) || s.sid.slice(0, 16) !== st.sid) return redirect(res, toResult('expired'));
    const mine = await googleRow(s.member.id);
    if (mine) return redirect(res, toResult(mine.sub === tok.sub ? 'linked' : 'already'));
    const other = await db.one('SELECT member_id FROM member_google WHERE sub=$1', [tok.sub]);
    if (other) return redirect(res, toResult('taken'));
    try {
      await db.q('INSERT INTO member_google (member_id, sub, email, linked_at) VALUES ($1,$2,$3,$4)',
        [s.member.id, tok.sub, tok.email, Date.now()]);
    } catch (e) {
      if (e && e.code === '23505') {
        const again = await googleRow(s.member.id);
        return redirect(res, toResult(again && again.sub === tok.sub ? 'linked' : (again ? 'already' : 'taken')));
      }
      throw e;
    }
    await memberAudit(req, 'member', s.member.id, 'google_link ' + (memberAuth.maskEmail(tok.email) || ''));
    return redirect(res, toResult('linked'));
  }

  // 로그인: 연결된 회원만(자동 가입 없음). 로그인 실패 계수기는 건드리지 않는다.
  const row = await db.one(
    `SELECT m.id, m.login_id, m.blocked_reason FROM member_google g JOIN members m ON m.id = g.member_id
      WHERE g.sub=$1`, [tok.sub]);
  if (!row) return redirect(res, oauth.loginWithCode('not_linked', nx));
  if (row.blocked_reason) return redirect(res, '/login?g=blocked');
  await memberAuth.startSession(req, res, row.id, 'google');
  await db.q('UPDATE member_google SET email=$2 WHERE member_id=$1', [row.id, tok.email]);
  return redirect(res, nx);
}));

module.exports = router;
module.exports.uaSummary = uaSummary;
module.exports.maskIp = maskIp;
