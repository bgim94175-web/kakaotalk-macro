// 회원 인증 검사 (DB 없이 돈다). docs/ACCOUNTS_V1.md 9.5 작업 1.
// 해시 왕복·재해시 표시, 아이디·비밀번호 규칙, kindOf 새 경로, sameOriginWrites, id_token 검사, kb_o 서명·만료,
// 로그인 잠금, scrypt 대기 목록 상한, 채널톡 memberHash 시험 벡터, channelMemberId.
// 실패하면 throw 로 종료 코드가 0 이 아니게 된다. 마지막 줄에 'auth check ok'.
'use strict';

process.env.AUTH_SCRYPT_LOG_N = '10';
process.env.CONFIG_SECRET = '0123456789abcdef0123456789abcdef';
delete process.env.CHANNEL_MEMBER_SECRET;
delete process.env.CHANNEL_PLUGIN_KEY;
delete process.env.AUTH_HASH_QUEUE_MAX;
delete process.env.PURCHASE_BASE;
delete process.env.RENDER_EXTERNAL_URL;
delete process.env.SELF_URL;
delete process.env.LOGIN_FAIL_MAX;
delete process.env.LOGIN_SLOW_AFTER;

const crypto = require('crypto');

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

const auth = require('./member-auth');
const rl = require('./ratelimit');
const oauth = require('./google-oauth');

// ── 9.2 서명
assert(auth.COOKIE === 'kb_s', 'member-auth.COOKIE is kb_s');
assert(Number.isInteger(auth.MAX_SESSIONS) && auth.MAX_SESSIONS === 3, 'member-auth.MAX_SESSIONS defaults to 3');
['normLoginId', 'loginIdProblem', 'passwordProblem', 'hashPassword', 'verifyPassword', 'startSession',
  'readSession', 'requireMember', 'endSession', 'endAllSessions', 'sameOriginWrites', 'publicMember',
  'channelConfig', 'channelMemberId', 'noteLoginFail', 'loginBlockedMs', 'loginSlowMs', 'clearLoginFails'].forEach(function (f) {
  assert(typeof auth[f] === 'function', 'member-auth.' + f + ' is exported');
});
['noteLoginFail', 'loginBlockedMs', 'loginSlowMs', 'clearLoginFails'].forEach(function (f) {
  assert(typeof rl[f] === 'function', 'ratelimit.' + f + ' is exported');
});

// ── 아이디 규칙 (D1)
assert(auth.normLoginId('  KBUser ') === 'kbuser', 'login id is trimmed and lower-cased');
assert(auth.normLoginId('kb_user9') === 'kb_user9', 'letters, digits and underscore');
['abc', '1abc', '_abc', 'a'.repeat(21), 'kb-user', 'kb user', '한글아이디', '', null].forEach(function (v) {
  assert(auth.normLoginId(v) === '', 'invalid login id rejected: ' + v);
});
assert(auth.normLoginId('abcd') === 'abcd' && auth.normLoginId('a'.repeat(20)) === 'a'.repeat(20), '4~20 chars');
assert(auth.loginIdProblem('kbuser') === null, 'normal id passes');
assert(auth.loginIdProblem('ab').reason === 'bad_login_id', 'short id is bad_login_id');
assert(auth.loginIdProblem('ab').error === '아이디는 영문 소문자로 시작하고, 영문 소문자·숫자·밑줄(_)로 4~20자를 입력해 주세요.', 'bad_login_id copy (6.4)');
assert(auth.loginIdProblem('admin').reason === 'reserved_id' && auth.loginIdProblem('Kbot_Official').reason === 'reserved_id', 'reserved ids');
assert(auth.loginIdProblem('admin').error === '사용할 수 없는 아이디입니다. 다른 아이디를 입력해 주세요.', 'reserved_id copy (6.4)');

// ── 비밀번호 규칙
assert(auth.passwordProblem('Tr0ub4dor&3', 'kbuser') === null, 'good password passes');
assert(auth.passwordProblem('short1!', 'kbuser').error === '비밀번호는 8자 이상 입력해 주세요.', 'min 8');
assert(auth.passwordProblem('x'.repeat(5) + 'Y'.repeat(124), 'kbuser').error === '비밀번호는 128자 이하로 입력해 주세요.', 'max 128');
assert(auth.passwordProblem('KBuser12', 'kbuser12').error === '아이디와 같은 비밀번호는 사용할 수 없습니다.', 'not the login id');
['password', '12345678', 'aaaaaaaa', 'abcdefgh', 'qwer1234', '87654321', 'abababab'].forEach(function (pw) {
  const p = auth.passwordProblem(pw, 'kbuser');
  assert(p && p.reason === 'bad_password' && p.error === '너무 쉬운 비밀번호입니다. 다른 비밀번호를 입력해 주세요.', 'easy password rejected: ' + pw);
});
assert(auth.passwordProblem('x'.repeat(128), 'kbuser').reason === 'bad_password', 'repeated char is easy even at 128');

// ── kindOf 새 경로 (3.1 표)
function kind(method, p) { return rl.kindOf({ method: method, path: p }); }
assert(kind('POST', '/api/auth/login') === 'auth', 'login is auth');
assert(kind('POST', '/API/Auth/Login/') === 'auth', 'case and trailing slash are normalized');
assert(kind('POST', '/api/auth/password') === 'auth' && kind('POST', '/api/auth/claim') === 'auth'
  && kind('POST', '/api/auth/google/unlink') === 'auth', 'password·claim·unlink are auth');
assert(kind('POST', '/api/auth/signup') === 'signup', 'signup');
assert(kind('GET', '/auth/google/start') === 'oauth' && kind('GET', '/auth/google/callback') === 'oauth', 'oauth');
assert(kind('POST', '/api/room-preview') === 'preview', 'room preview (POST)');
['GET /api/site', 'GET /api/me', 'GET /api/my/orders', 'POST /api/my/orders/cancel', 'GET /api/auth/sessions',
  'POST /api/auth/logout', 'POST /api/auth/logout-all', 'POST /api/auth/sessions/revoke'].forEach(function (x) {
  const pr = x.split(' ');
  assert(kind(pr[0], pr[1]) === 'member', 'member bucket: ' + x);
});
assert(kind('GET', '/api/order/ORD-1') === 'order-read' && kind('POST', '/api/order') === 'order-write', 'order buckets kept');
assert(kind('POST', '/api/deposit-hook') === 'deposit' && kind('GET', '/admin/list') === 'admin', 'deposit·admin kept');
assert(kind('POST', '/panel/api/login') === 'panel' && kind('GET', '/panel/api/bot-rooms') === 'panel', 'key login bucket is unused');
assert(rl.maxFor('auth') === 10 && rl.maxFor('signup') === 5 && rl.maxFor('oauth') === 20
  && rl.maxFor('preview') === 20 && rl.maxFor('member') === 180, 'default per-minute limits (3.1)');

// ── sameOriginWrites (8.3)
function mockRes() {
  return {
    statusCode: 200, body: null, headersSent: false, headers: {},
    status: function (c) { this.statusCode = c; return this; },
    json: function (b) { this.body = b; this.headersSent = true; return this; },
    setHeader: function (k, v) { this.headers[k.toLowerCase()] = v; },
    getHeader: function (k) { return this.headers[k.toLowerCase()]; },
  };
}
function csrf(method, p, headers) {
  const req = { method: method, path: p, url: p, protocol: 'http', secure: false,
    headers: Object.assign({ host: 'kb.test' }, headers || {}), socket: { remoteAddress: '127.0.0.1' } };
  const res = mockRes();
  let passed = false;
  auth.sameOriginWrites(req, res, function () { passed = true; });
  return { passed: passed, status: res.statusCode, body: res.body };
}
const JSONH = { 'content-type': 'application/json' };
let c = csrf('POST', '/api/auth/login', { 'content-type': 'text/plain' });
assert(!c.passed && c.status === 415, 'text/plain write is 415');
c = csrf('POST', '/api/auth/login', { 'content-type': 'application/x-www-form-urlencoded' });
assert(!c.passed && c.status === 415, 'form post is 415');
c = csrf('POST', '/api/auth/login', Object.assign({ origin: 'https://evil.example' }, JSONH));
assert(!c.passed && c.status === 403 && c.body.reason === 'bad_origin', 'foreign Origin is 403');
c = csrf('POST', '/api/auth/login', Object.assign({ origin: 'null' }, JSONH));
assert(!c.passed && c.status === 403, 'Origin null is 403');
c = csrf('POST', '/api/auth/login', Object.assign({ origin: 'http://kb.test', 'sec-fetch-site': 'cross-site' }, JSONH));
assert(!c.passed && c.status === 403, 'cross-site Sec-Fetch-Site is 403');
c = csrf('POST', '/api/auth/login', Object.assign({ origin: 'http://kb.test', 'sec-fetch-site': 'same-origin' }, { 'content-type': 'application/json; charset=utf-8' }));
assert(c.passed, 'same-origin JSON write passes');
c = csrf('POST', '/api/auth/login', JSONH);
assert(c.passed, 'JSON write without Origin passes (non-browser client)');
process.env.PURCHASE_BASE = 'https://kmacro.cloud';
c = csrf('POST', '/panel/api/bot-room/settings', Object.assign({ origin: 'https://kmacro.cloud' }, JSONH));
assert(c.passed, 'purchaseBase origin passes');
delete process.env.PURCHASE_BASE;
assert(!csrf('POST', '/api/order', { 'content-type': 'text/plain' }).passed, 'POST /api/order is guarded');
assert(!csrf('POST', '/api/room-preview', { 'content-type': 'text/plain' }).passed, 'room preview is guarded');
assert(!csrf('POST', '/api/my/orders/cancel', { 'content-type': 'text/plain' }).passed, '/api/my/ is guarded');
assert(!csrf('POST', '/PANEL/api/unlink', { 'content-type': 'text/plain' }).passed, '/panel/api/ is guarded (case-insensitive)');
assert(csrf('GET', '/api/auth/sessions', { 'content-type': 'text/plain', origin: 'https://evil.example' }).passed, 'GET is not guarded');
assert(csrf('POST', '/api/deposit-hook', { 'content-type': 'text/plain' }).passed, 'deposit hook is excluded');
assert(csrf('POST', '/admin/order-approve', { 'content-type': 'text/plain' }).passed, 'admin is excluded');
assert(csrf('POST', '/api/lookup', { 'content-type': 'text/plain' }).passed, 'old key lookup is not in the list');

// ── id_token 검사 (3.2 B4)
const CID = 'cid.apps.googleusercontent.com';
const NOW = 1767000000000;
function tok(over) {
  const p = Object.assign({ iss: 'https://accounts.google.com', aud: CID, sub: '1093', email: 'kb@gmail.com',
    nonce: 'n-123', iat: NOW / 1000 - 5, exp: NOW / 1000 + 3600 }, over || {});
  Object.keys(p).forEach(function (k) { if (p[k] === undefined) delete p[k]; });
  return Buffer.from('{"alg":"none"}').toString('base64url') + '.' + Buffer.from(JSON.stringify(p)).toString('base64url') + '.x';
}
function chk(t) { return oauth.checkIdToken(t, { clientId: CID, nonce: 'n-123', now: NOW }); }
let r = chk(tok());
assert(r.ok && r.sub === '1093' && r.email === 'kb@gmail.com', 'valid id_token');
assert(chk(tok({ iss: 'accounts.google.com' })).ok, 'bare issuer accepted');
assert(chk(tok({ azp: CID })).ok, 'matching azp accepted');
assert(chk(tok({ email: undefined })).ok && chk(tok({ email: undefined })).email === null, 'email is optional');
assert(chk(tok({ iss: 'https://evil.example' })).why === 'iss', 'iss');
assert(chk(tok({ aud: 'other' })).why === 'aud', 'aud');
assert(chk(tok({ azp: 'other' })).why === 'azp', 'azp');
assert(chk(tok({ nonce: 'n-999' })).why === 'nonce', 'nonce');
assert(chk(tok({ nonce: undefined })).why === 'nonce', 'missing nonce');
assert(chk(tok({ exp: NOW / 1000 - 61 })).why === 'exp', 'expired');
assert(chk(tok({ exp: NOW / 1000 - 30 })).ok, '60s clock skew on exp');
assert(chk(tok({ iat: NOW / 1000 + 61 })).why === 'iat', 'issued in the future');
assert(chk(tok({ sub: '' })).why === 'sub' && chk(tok({ sub: 'x'.repeat(256) })).why === 'sub' && chk(tok({ sub: 5 })).why === 'sub', 'sub 1~255 string');
assert(chk('garbage').why === 'format' && chk('a.b').why === 'format', 'bad format');

// ── kb_o 서명·만료
const st = { s: 'state1', cv: 'v', n: 'n', md: 'link', m: 7, sid: 'abcdef0123456789', nx: '/account', e: NOW + 600000 };
const sealed = oauth.sealState(st);
let o = oauth.openState(sealed, NOW);
assert(o.ok && !o.expired && o.state.m === 7 && o.state.md === 'link', 'state round trip');
assert(oauth.openState(sealed, NOW + 600001).ok && oauth.openState(sealed, NOW + 600001).expired, 'expired state is flagged');
const dot = sealed.lastIndexOf('.');
const forged = Buffer.from(JSON.stringify(Object.assign({}, st, { m: 8 }))).toString('base64url') + sealed.slice(dot);
assert(!oauth.openState(forged, NOW).ok, 'tampered body rejected');
assert(!oauth.openState(sealed.slice(0, -2) + (sealed.slice(-2) === 'AA' ? 'AB' : 'AA'), NOW).ok, 'tampered signature rejected');
assert(!oauth.openState('', NOW).ok && !oauth.openState('nodot', NOW).ok, 'missing cookie rejected');
process.env.CONFIG_SECRET = 'another-secret-another-secret-00';
assert(!oauth.openState(sealed, NOW).ok, 'other CONFIG_SECRET rejected');
process.env.CONFIG_SECRET = '0123456789abcdef0123456789abcdef';
assert(/^kb_o=[^;]+; Path=\/auth\/google; HttpOnly; SameSite=Lax; Max-Age=600; Secure$/.test(oauth.stateCookie(sealed, true)), 'kb_o attributes');
assert(/Max-Age=0/.test(oauth.clearStateCookie(false)) && /Path=\/auth\/google/.test(oauth.clearStateCookie(false)), 'kb_o clear');

// ── OAuth 보조
assert(oauth.safeNext('//evil.com') === '/account' && oauth.safeNext('https://evil.com') === '/account'
  && oauth.safeNext('/\\evil') === '/account' && oauth.safeNext(undefined) === '/account', 'next must be a local path');
assert(oauth.safeNext('/account?g=recover#password') === '/account?g=recover#password', 'next keeps query and hash');
assert(oauth.withCode('/account', 'linked') === '/account?g=linked', 'g appended with ?');
assert(oauth.withCode('/account?x=1#password', 'recover') === '/account?x=1&g=recover#password', 'g appended with & before #');
assert(oauth.loginWithCode('not_linked', '/account?g=recover#password') === '/login?g=not_linked&next=%2Faccount%3Fg%3Drecover%23password', 'login result keeps next');
assert(oauth.isWebview('Mozilla/5.0 (Linux; Android 14; wv) KAKAOTALK 10.4.5') && oauth.isWebview('... NAVER(inapp; search; ...)')
  && oauth.isWebview('Mozilla/5.0 (Linux; Android 13; SM-S911N; wv) AppleWebKit') && !oauth.isWebview('Mozilla/5.0 (Windows NT 10.0) Chrome/120'), 'webview UA');
assert(oauth.endpointOk('https://x.example/token') && oauth.endpointOk('http://127.0.0.1:9911/auth')
  && oauth.endpointOk('http://localhost/t') && oauth.endpointOk('http://[::1]:80/t'), 'https and localhost overrides allowed');
assert(!oauth.endpointOk('http://evil.example/t') && !oauth.endpointOk('ftp://127.0.0.1/t') && !oauth.endpointOk('nope'), 'other overrides rejected');
process.env.GOOGLE_AUTH_URL = 'http://evil.example/auth';
assert(oauth.authUrl() === oauth.DEFAULT_AUTH_URL, 'rejected override falls back to Google');
process.env.GOOGLE_AUTH_URL = 'http://127.0.0.1:9911/auth';
process.env.GOOGLE_CLIENT_ID = CID;
const au = oauth.buildAuthUrl({ redirectUri: 'https://kmacro.cloud/auth/google/callback', state: 's1', nonce: 'n1', verifier: 'v'.repeat(43) });
assert(au.indexOf('http://127.0.0.1:9911/auth?client_id=' + encodeURIComponent(CID)) === 0, 'override used');
assert(au.indexOf('scope=openid%20email') > 0 && au.indexOf('code_challenge_method=S256') > 0 && au.indexOf('prompt=select_account') > 0
  && au.indexOf('code_challenge=' + crypto.createHash('sha256').update('v'.repeat(43)).digest('base64url')) > 0
  && au.indexOf('response_type=code') > 0 && au.indexOf('nonce=n1') > 0 && au.indexOf('state=s1') > 0, 'auth URL parameters (B1-6)');
delete process.env.GOOGLE_AUTH_URL;
assert(!oauth.configured(), 'Google needs both client id and secret');
process.env.GOOGLE_CLIENT_SECRET = 'sec';
assert(oauth.configured(), 'Google on with both');
delete process.env.GOOGLE_CLIENT_ID;
delete process.env.GOOGLE_CLIENT_SECRET;
assert(oauth.redirectUri('https://kmacro.cloud/') === 'https://kmacro.cloud/auth/google/callback', 'redirect URI from purchase base');

// ── publicMember·이메일 가림
const pm = auth.publicMember({ id: '7', login_id: 'kbuser' }, { email: 'kbuser@gmail.com' });
assert(pm.id === 7 && pm.google_linked === true && pm.google_email_masked === 'kb***@gmail.com', 'publicMember shape');
assert(auth.publicMember({ id: 1, login_id: 'a' }, null).google_email_masked === null, 'no google → null mask');
assert(auth.maskEmail('a@x.com') === 'a***@x.com', 'short local part');

// ── 채널톡 (6.10 7, 8.8)
assert(auth.channelConfig({ id: 7, login_id: 'kbuser' }) === null, 'no plugin key → null');
process.env.CHANNEL_PLUGIN_KEY = 'plugin-key-1';
let cc = auth.channelConfig({ id: 7, login_id: 'kbuser' });
assert(cc.plugin_key === 'plugin-key-1' && cc.name === 'kbuser' && cc.member_id === undefined && cc.member_hash === undefined,
  'without CHANNEL_MEMBER_SECRET only the name is sent');
assert(auth.channelMemberId(7) === null, 'channelMemberId is null without CHANNEL_MEMBER_SECRET');
assert(JSON.stringify(auth.channelConfig(null)) === JSON.stringify({ plugin_key: 'plugin-key-1' }), 'anonymous boot');
process.env.CHANNEL_MEMBER_SECRET = '4629de5def93d6a2abea6afa9bd5476d9c6cbc04223f9a2f7e517b535dde3e25';
assert(auth.channelMemberHash('lucas') === '99427c7bba36a6902c5fd6383f2fb0214d19b81023296b4bd6b9e024836afea2',
  'Channel Talk member hash test vector (lucas)');
const mid7 = auth.channelMemberId(7);
const mid8 = auth.channelMemberId(8);
const expect7 = 'm' + crypto.createHmac('sha256',
  Buffer.from(crypto.hkdfSync('sha256', Buffer.from(process.env.CONFIG_SECRET), Buffer.from('kbot'), Buffer.from('channel-member/v1'), 32)))
  .update('7').digest('hex').slice(0, 24);
assert(mid7 === expect7 && /^m[0-9a-f]{24}$/.test(mid7), 'channelMemberId = m + HMAC(HKDF(CONFIG_SECRET))[0:24]');
assert(mid7 !== mid8 && mid7.indexOf('7') !== 1 && mid7 !== 'm' + '7'.padStart(24, '0'), 'channelMemberId is not the sequence number');
process.env.CONFIG_SECRET = 'another-secret-another-secret-00';
assert(auth.channelMemberId(7) !== mid7, 'channelMemberId depends on CONFIG_SECRET');
process.env.CONFIG_SECRET = '0123456789abcdef0123456789abcdef';
cc = auth.channelConfig({ id: 7, login_id: 'kbuser' });
assert(cc.member_id === mid7 && cc.member_hash === crypto.createHmac('sha256', Buffer.from(process.env.CHANNEL_MEMBER_SECRET, 'hex')).update(mid7).digest('hex'),
  'member_hash = HMAC(hex secret, member_id)');
process.env.CHANNEL_MEMBER_SECRET = 'not-hex!';
assert(auth.channelMemberId(7) === null && auth.channelConfig({ id: 7, login_id: 'kbuser' }).member_id === undefined
  && auth.memberSecretProblem() !== '', 'non-hex secret is treated as missing');
delete process.env.CHANNEL_MEMBER_SECRET;
delete process.env.CHANNEL_PLUGIN_KEY;

// ── 로그인 잠금 (3.1): (아이디, IP) 15분 10회 → 잠금. 다른 IP 는 잠기지 않음. 아이디 단독 30회 초과 → 늦추기.
rl.resetAll();
for (let i = 0; i < 9; i++) rl.noteLoginFail('KBUser', '10.0.0.1');
assert(rl.loginBlockedMs('kbuser', '10.0.0.1') === 0, '9 failures do not lock');
const tenth = rl.noteLoginFail('kbuser', '10.0.0.1');
assert(tenth.blocked && rl.loginBlockedMs('kbuser', '10.0.0.1') > 14 * 60000, '10th failure locks the (id, ip) pair for 15 minutes');
assert(rl.loginBlockedMs('kbuser', '10.0.0.2') === 0, 'same id from another IP is not locked');
assert(rl.loginBlockedMs('other', '10.0.0.1') === 0, 'another id from the same IP is not locked');
assert(rl.loginSlowMs('kbuser') === 0, '10 failures do not slow the id');
for (let i = 0; i < 20; i++) rl.noteLoginFail('kbuser', '10.0.1.' + i);
assert(rl.loginSlowMs('kbuser') === 0, '30 failures do not slow the id yet');
rl.noteLoginFail('kbuser', '10.0.2.1');
assert(rl.loginSlowMs('kbuser') === 2000, 'over 30 failures slow the id by 2 s');
assert(rl.loginSlowMs('someone') === 0, 'other ids are not slowed');
assert(rl.loginBlockedMs('kbuser', '10.0.9.9') === 0, 'slowing never locks a fresh IP');
rl.clearLoginFails('kbuser', '10.0.0.1');
assert(rl.loginBlockedMs('kbuser', '10.0.0.1') === 0, 'clearLoginFails removes the pair lock');
rl.resetAll();
assert(rl.loginSlowMs('kbuser') === 0, 'resetAll clears login counters');

// ── routes/auth.js 보조 (기기 요약·IP 가림)
const authRoutes = require('../routes/auth');
assert(authRoutes.uaSummary('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0 Safari/537.36') === 'Windows · Chrome', 'Windows · Chrome');
assert(authRoutes.uaSummary('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit Version/17.0 Mobile/15E148 Safari/604.1') === 'iPhone · Safari', 'iPhone · Safari');
assert(authRoutes.uaSummary('Mozilla/5.0 (Windows NT 10.0) Chrome/120 Safari/537.36 Edg/120') === 'Windows · Edge', 'Edge');
assert(authRoutes.uaSummary('') === '알 수 없는 기기', 'unknown device');
assert(authRoutes.maskIp('203.0.113.45') === '203.0.113.*' && authRoutes.maskIp('2001:db8::1') === '2001:db8::*', 'last octet masked');

// ── scrypt: 형식·왕복·재해시 표시·대기 목록 상한(2 실행 + 20 대기, 그다음은 busy)
(async function () {
  const h = await auth.hashPassword('Correct-Horse-9');
  assert(/^\$scrypt\$ln=10,r=8,p=1\$[A-Za-z0-9_-]{22}\$[A-Za-z0-9_-]{43}$/.test(h), 'hash format $scrypt$ln=..,r=8,p=1$salt$dk');
  let v = await auth.verifyPassword('Correct-Horse-9', h);
  assert(v.ok === true && v.rehash === false, 'verify ok, no rehash at current parameters');
  v = await auth.verifyPassword('Correct-Horse-8', h);
  assert(v.ok === false && v.rehash === false, 'wrong password');
  v = await auth.verifyPassword('Ｃｏｒｒｅｃｔ-Horse-9', h);
  assert(v.ok === true, 'NFKC normalization (full-width letters)');
  v = await auth.verifyPassword('Correct-Horse-9', null);
  assert(v.ok === false, 'missing hash runs the dummy and fails');
  v = await auth.verifyPassword('Correct-Horse-9', '$scrypt$broken');
  assert(v.ok === false, 'broken hash fails');
  process.env.AUTH_SCRYPT_LOG_N = '11';
  v = await auth.verifyPassword('Correct-Horse-9', h);
  assert(v.ok === true && v.rehash === true, 'different parameters → rehash on success');
  v = await auth.verifyPassword('nope-nope-nope', h);
  assert(v.ok === false && v.rehash === false, 'no rehash flag on failure');
  process.env.AUTH_SCRYPT_LOG_N = '10';

  const jobs = [];
  for (let i = 0; i < 22; i++) jobs.push(auth.hashPassword('Queue-Password-' + i));
  const st0 = auth.hashStats();
  assert(st0.running === 2 && st0.waiting === 20, '2 running + 20 waiting');
  let busy = null;
  try { await auth.hashPassword('one-too-many-1'); } catch (e) { busy = e; }
  assert(busy && busy.code === 'busy' && busy.status === 503 && busy.publicError === '요청이 많아 처리하지 못했습니다. 잠시 뒤 다시 시도해 주세요.', '21st waiting hash is busy (503)');
  const done = await Promise.all(jobs);
  assert(done.length === 22 && done.every(function (x) { return /^\$scrypt\$/.test(x); }), 'queued hashes all finish');
  const st1 = auth.hashStats();
  assert(st1.running === 0 && st1.waiting === 0, 'queue drains');

  process.stdout.write('auth check ok\n');
})().catch(function (e) {
  console.error(e && e.stack ? e.stack : e);
  process.exit(1);
});
