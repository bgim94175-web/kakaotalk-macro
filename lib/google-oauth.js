// Google 연결·로그인(OAuth 2.0 + OIDC) 보조. 외부 라이브러리 없이 Node 내장 crypto·fetch 만 쓴다.
// docs/ACCOUNTS_V1.md 3.2(B1~B6)·8장 7번. 라우트는 routes/auth.js 에 있다.
//   - PKCE S256 + state + nonce
//   - 상태 쿠키 kb_o = base64url(JSON) + '.' + base64url(HMAC-SHA256(k, base64url(JSON))),
//     k = HKDF-SHA256(ikm=CONFIG_SECRET, salt='kbot', info='kbot/oauth/v1', 32)
//   - id_token 은 토큰 끝점에서 TLS 로 직접 받으므로 서명 대신 iss·aud·azp·exp·iat·nonce·sub 를 검사한다
//     (OIDC Core 3.1.3.7).
'use strict';

const crypto = require('crypto');

const STATE_COOKIE = 'kb_o';
const STATE_PATH = '/auth/google';
const STATE_TTL_MS = 600000;
const DEFAULT_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const DEFAULT_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const ISSUERS = ['https://accounts.google.com', 'accounts.google.com'];
const WEBVIEW_RE = /KAKAOTALK|NAVER\(inapp|Instagram|FBAN|FBAV|Line\/|; wv\)/i;
const NEXT_RE = /^\/(?!\/)[\w\-./?=&#%]{0,200}$/;

function env(name) {
  return String(process.env[name] || '').trim();
}

function clientId() { return env('GOOGLE_CLIENT_ID'); }
function clientSecret() { return env('GOOGLE_CLIENT_SECRET'); }

// 둘 다 있어야 켜진다(한쪽만 있으면 warnEnv 가 경고). 상태 쿠키 서명에 CONFIG_SECRET 도 필요하다.
function configured() {
  return !!(clientId() && clientSecret() && env('CONFIG_SECRET'));
}

function halfConfigured() {
  return !!clientId() !== !!clientSecret();
}

// 끝점 덮어쓰기는 https 이거나 http://localhost|127.0.0.1|[::1] 일 때만 받는다(오프라인 시험용)
function endpointOk(u) {
  let x;
  try { x = new URL(String(u)); } catch (e) { return false; }
  if (x.protocol === 'https:') return true;
  if (x.protocol !== 'http:') return false;
  return x.hostname === 'localhost' || x.hostname === '127.0.0.1' || x.hostname === '[::1]';
}

function authUrl() {
  const o = env('GOOGLE_AUTH_URL');
  return o && endpointOk(o) ? o : DEFAULT_AUTH_URL;
}

function tokenUrl() {
  const o = env('GOOGLE_TOKEN_URL');
  return o && endpointOk(o) ? o : DEFAULT_TOKEN_URL;
}

// warnEnv 용: [{name, value, used}]
function overrides() {
  const out = [];
  ['GOOGLE_AUTH_URL', 'GOOGLE_TOKEN_URL'].forEach((name) => {
    const v = env(name);
    if (v) out.push({ name: name, value: v, used: endpointOk(v) });
  });
  return out;
}

function redirectUri(base) {
  return env('GOOGLE_REDIRECT_URI') || String(base || '').replace(/\/+$/, '') + '/auth/google/callback';
}

function isWebview(ua) {
  return WEBVIEW_RE.test(String(ua || ''));
}

// next 는 이 사이트 안 경로만(//host 금지). 아니면 /account
function safeNext(next) {
  const s = typeof next === 'string' ? next : '';
  return NEXT_RE.test(s) ? s : '/account';
}

// next 에 g=<code> 를 붙인다. 이미 ? 가 있으면 &. # 뒤(조각)는 그대로 뒤에 둔다.
function withCode(next, code) {
  const n = safeNext(next);
  const hashAt = n.indexOf('#');
  const base = hashAt >= 0 ? n.slice(0, hashAt) : n;
  const frag = hashAt >= 0 ? n.slice(hashAt) : '';
  return base + (base.indexOf('?') >= 0 ? '&' : '?') + 'g=' + encodeURIComponent(code) + frag;
}

// 로그인 화면으로 보내는 결과 코드
function loginWithCode(code, next) {
  let u = '/login?g=' + encodeURIComponent(code);
  if (next) u += '&next=' + encodeURIComponent(safeNext(next));
  return u;
}

function b64url(buf) {
  return Buffer.from(buf).toString('base64url');
}

function randomToken(n) {
  return crypto.randomBytes(n).toString('base64url');
}

function challengeOf(verifier) {
  return crypto.createHash('sha256').update(String(verifier)).digest('base64url');
}

function stateKey() {
  const secret = env('CONFIG_SECRET');
  if (!secret) return null;
  return Buffer.from(crypto.hkdfSync('sha256', Buffer.from(secret, 'utf8'), Buffer.from('kbot'), Buffer.from('kbot/oauth/v1'), 32));
}

function sealState(obj) {
  const key = stateKey();
  if (!key) throw new Error('CONFIG_SECRET 이 없어 Google 상태 값을 서명할 수 없습니다');
  const body = b64url(Buffer.from(JSON.stringify(obj), 'utf8'));
  return body + '.' + crypto.createHmac('sha256', key).update(body).digest('base64url');
}

// -> {ok:true, state, expired:bool} | {ok:false}. 서명이 맞으면 만료된 값도 돌려준다(돌아갈 화면을 고르려고).
function openState(raw, now) {
  const key = stateKey();
  const s = String(raw || '');
  const i = s.lastIndexOf('.');
  if (!key || i < 1) return { ok: false };
  const body = s.slice(0, i);
  const sig = Buffer.from(s.slice(i + 1));
  const expect = Buffer.from(crypto.createHmac('sha256', key).update(body).digest('base64url'));
  if (sig.length !== expect.length || !crypto.timingSafeEqual(sig, expect)) return { ok: false };
  let obj;
  try { obj = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')); } catch (e) { return { ok: false }; }
  if (!obj || typeof obj !== 'object' || typeof obj.s !== 'string' || typeof obj.e !== 'number') return { ok: false };
  const t = now === undefined ? Date.now() : now;
  return { ok: true, state: obj, expired: obj.e < t };
}

function sameText(a, b) {
  const x = Buffer.from(String(a || ''));
  const y = Buffer.from(String(b || ''));
  return x.length === y.length && x.length > 0 && crypto.timingSafeEqual(x, y);
}

function stateCookie(value, secure) {
  return STATE_COOKIE + '=' + value + '; Path=' + STATE_PATH + '; HttpOnly; SameSite=Lax; Max-Age=' +
    Math.floor(STATE_TTL_MS / 1000) + (secure ? '; Secure' : '');
}

function clearStateCookie(secure) {
  return STATE_COOKIE + '=; Path=' + STATE_PATH + '; HttpOnly; SameSite=Lax; Max-Age=0' + (secure ? '; Secure' : '');
}

// B1-6: Google 로 보낼 주소
function buildAuthUrl(p) {
  const params = [
    ['client_id', clientId()],
    ['redirect_uri', p.redirectUri],
    ['response_type', 'code'],
    ['scope', 'openid email'],
    ['state', p.state],
    ['nonce', p.nonce],
    ['code_challenge', challengeOf(p.verifier)],
    ['code_challenge_method', 'S256'],
    ['prompt', 'select_account'],
  ].map((kv) => kv[0] + '=' + encodeURIComponent(kv[1])).join('&');
  const base = authUrl();
  return base + (base.indexOf('?') >= 0 ? '&' : '?') + params;
}

// B3: 코드 → id_token. 실패면 null
async function exchangeCode(p) {
  const body = new URLSearchParams({
    code: String(p.code || ''),
    client_id: clientId(),
    client_secret: clientSecret(),
    redirect_uri: p.redirectUri,
    grant_type: 'authorization_code',
    code_verifier: String(p.verifier || ''),
  }).toString();
  let r;
  try {
    r = await fetch(tokenUrl(), {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: body,
      signal: AbortSignal.timeout(10000),
    });
  } catch (e) {
    console.error('[google] 토큰 교환 실패: ' + (e && e.message ? e.message : e));
    return null;
  }
  if (r.status !== 200) {
    console.error('[google] 토큰 교환 HTTP ' + r.status);
    return null;
  }
  let json;
  try { json = await r.json(); } catch (e) { return null; }
  if (!json || typeof json.id_token !== 'string' || !json.id_token) return null;
  return json.id_token;
}

function decodePayload(idToken) {
  const parts = String(idToken || '').split('.');
  if (parts.length < 2 || !parts[1]) return null;
  try {
    const obj = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    return obj && typeof obj === 'object' ? obj : null;
  } catch (e) {
    return null;
  }
}

// B4: -> {ok:true, sub, email} | {ok:false, why}
function checkIdToken(idToken, expect) {
  const e = expect || {};
  const now = e.now === undefined ? Date.now() : e.now;
  const cid = e.clientId === undefined ? clientId() : e.clientId;
  const p = decodePayload(idToken);
  if (!p) return { ok: false, why: 'format' };
  if (ISSUERS.indexOf(p.iss) < 0) return { ok: false, why: 'iss' };
  if (!cid || p.aud !== cid) return { ok: false, why: 'aud' };
  if (p.azp !== undefined && p.azp !== cid) return { ok: false, why: 'azp' };
  if (typeof p.exp !== 'number' || !(p.exp * 1000 > now - 60000)) return { ok: false, why: 'exp' };
  if (typeof p.iat !== 'number' || !(p.iat * 1000 < now + 60000)) return { ok: false, why: 'iat' };
  if (typeof p.nonce !== 'string' || !e.nonce || !sameText(p.nonce, e.nonce)) return { ok: false, why: 'nonce' };
  if (typeof p.sub !== 'string' || p.sub.length < 1 || p.sub.length > 255) return { ok: false, why: 'sub' };
  const email = typeof p.email === 'string' && p.email ? p.email.slice(0, 320) : null;
  return { ok: true, sub: p.sub, email: email };
}

module.exports = {
  STATE_COOKIE, STATE_PATH, STATE_TTL_MS, DEFAULT_AUTH_URL, DEFAULT_TOKEN_URL, WEBVIEW_RE, NEXT_RE,
  clientId, configured, halfConfigured, endpointOk, authUrl, tokenUrl, overrides, redirectUri,
  isWebview, safeNext, withCode, loginWithCode, randomToken, challengeOf,
  sealState, openState, sameText, stateCookie, clearStateCookie,
  buildAuthUrl, exchangeCode, decodePayload, checkIdToken,
};
