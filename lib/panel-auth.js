// 관리 화면 로그인. 라이선스 키를 확인하고 쿠키만 준다.
// 앱의 기기 1대 규칙(device_id)은 건드리지 않는다.
'use strict';

const crypto = require('crypto');

const COOKIE = 'panel';
const TTL_MS = 12 * 60 * 60 * 1000;

function secret() {
  const raw = String(process.env.CONFIG_SECRET || '').trim();
  if (raw.length < 16) return '';
  return raw;
}

function configured() {
  return !!secret();
}

function mac(body) {
  return crypto.createHmac('sha256', secret()).update(body).digest('base64url');
}

function sign(key, exp) {
  const body = Buffer.from(JSON.stringify({ k: key, e: exp }), 'utf8').toString('base64url');
  return body + '.' + mac(body);
}

function readToken(raw) {
  if (!configured() || !raw || typeof raw !== 'string') return null;
  const i = raw.lastIndexOf('.');
  if (i < 1) return null;
  const body = raw.slice(0, i);
  const sig = raw.slice(i + 1);
  const expect = mac(body);
  const a = Buffer.from(sig);
  const b = Buffer.from(expect);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  let obj;
  try { obj = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')); }
  catch (e) { return null; }
  if (!obj || typeof obj.k !== 'string' || typeof obj.e !== 'number') return null;
  if (obj.e < Date.now()) return null;
  if (!/^[A-Z0-9-]{8,40}$/.test(obj.k)) return null;
  return { key: obj.k, exp: obj.e };
}

function cookiePair(req, name) {
  const raw = req && req.headers ? req.headers.cookie : '';
  if (!raw) return '';
  const parts = String(raw).split(';');
  for (let i = 0; i < parts.length; i++) {
    const s = parts[i].trim();
    const eq = s.indexOf('=');
    if (eq < 1) continue;
    if (s.slice(0, eq) === name) return decodeURIComponent(s.slice(eq + 1));
  }
  return '';
}

function readRequest(req) {
  return readToken(cookiePair(req, COOKIE));
}

function https(req) {
  if (req && req.secure) return true;
  const p = req && req.headers ? req.headers['x-forwarded-proto'] : '';
  return String(p || '').split(',')[0].trim() === 'https';
}

function writeCookie(req, res, key, exp) {
  const bits = [
    COOKIE + '=' + encodeURIComponent(sign(key, exp)),
    'Path=/panel',
    'HttpOnly',
    'SameSite=Lax',
    'Max-Age=' + Math.max(1, Math.floor((exp - Date.now()) / 1000)),
  ];
  if (https(req)) bits.push('Secure');
  res.setHeader('Set-Cookie', bits.join('; '));
}

function clearCookie(req, res) {
  const bits = [COOKIE + '=;', 'Path=/panel', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0'];
  if (https(req)) bits.push('Secure');
  res.setHeader('Set-Cookie', bits.join('; '));
}

// 키 행과 entitlement 행만 본다. device_id 가 있어도 통과시키고, 여기서 바꾸지 않는다.
function assess(lic, rows, now) {
  const t = now || Date.now();
  if (!lic) return { ok: false, status: 401, error: '없는 키입니다.' };
  if (lic.revoked || lic.blocked_reason) return { ok: false, status: 403, error: '정지된 키입니다.' };
  const list = rows || [];
  let row = null;
  for (let i = 0; i < list.length; i++) if (list[i] && list[i].feature === 'macro') row = list[i];
  if (!row) return { ok: false, status: 403, error: '매크로가 없는 키입니다.' };
  const exp = row.expires_at == null || row.expires_at === '' ? null : Number(row.expires_at);
  if (exp == null || !isFinite(exp) || exp === 0) {
    return { ok: false, status: 403, error: '이 키는 매크로 기간이 아직 시작되지 않았습니다. 이 화면은 기기를 묶지 않습니다.' };
  }
  if (exp <= t) return { ok: false, status: 403, error: '매크로 기간이 끝났습니다.' };
  const feat = {};
  for (let i = 0; i < list.length; i++) {
    const one = list[i];
    if (!one || !one.feature) continue;
    const e = one.expires_at == null ? 0 : Number(one.expires_at);
    feat[one.feature] = { on: e > t };
  }
  return { ok: true, expires_at: exp, features: feat };
}

function maskKey(key) {
  const parts = String(key || '').split('-');
  if (parts.length >= 4) return parts[0] + '-····-····-' + parts[parts.length - 1];
  if (key && key.length > 4) return '····' + key.slice(-4);
  return '····';
}

module.exports = {
  COOKIE, TTL_MS, configured, sign, readToken, readRequest, writeCookie, clearCookie, assess, maskKey,
};
