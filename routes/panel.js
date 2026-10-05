// 라이선스 키로 들어가는 발송 관리 화면.
// 앱의 /verify 를 부르지 않으므로 기기 1대 규칙은 그대로다.
'use strict';

const express = require('express');

const db = require('../lib/db');
const keys = require('../lib/keys');
const auth = require('../lib/panel-auth');
const ids = require('../lib/panel-ids');
const text = require('../lib/auth-text');
const cfg = require('../lib/panel-config');
const sender = require('../lib/sender-child');

const router = express.Router();
const MAX_ACCOUNTS = 8;
const HARD_STATUS = {
  '-111': true, '-328': true, '-997': true, '-101': true, '-102': true,
  '-444': true, '-445': true, '-950': true, '-998': true, '-999': true,
  '8': true, '12': true, '13': true, '30': true, '31': true, '32': true, '99': true,
};

const wrap = (fn) => (req, res) => Promise.resolve(fn(req, res)).catch((e) => {
  if (e && (e.code === 'sender_down' || e.message === 'timeout')) return senderDown(res);
  console.error('[panel ' + req.method + ' ' + req.path + '] ' + (e && e.stack ? e.stack : e));
  if (!res.headersSent) res.status(500).json({ ok: false, error: '처리하지 못했습니다.' });
});

function cleanEmail(v) {
  const s = String(v || '').trim();
  if (s.length < 3 || s.length > 80) return '';
  if (/[\s\u0000-\u001f]/.test(s)) return '';
  return s;
}

function cleanPassword(v) {
  const s = v == null ? '' : String(v);
  if (s.length < 1 || s.length > 200) return '';
  return s;
}

async function licenseOf(key) {
  const lic = await db.one(
    'SELECT key, revoked, blocked_reason FROM licenses WHERE key=$1',
    [key]);
  const rows = lic ? await db.entitlements(key) : [];
  return auth.assess(lic, rows, Date.now());
}

async function session(req, res) {
  if (!auth.configured()) {
    res.status(503).json({ ok: false, error: '서버 설정이 없어 관리 화면을 열 수 없습니다.' });
    return null;
  }
  const tok = auth.readRequest(req);
  if (!tok) {
    res.status(401).json({ ok: false, error: '다시 로그인해 주세요.' });
    return null;
  }
  const gate = await licenseOf(tok.key);
  if (!gate.ok) {
    auth.clearCookie(req, res);
    res.status(gate.status).json({ ok: false, error: gate.error });
    return null;
  }
  if (tok.exp - Date.now() < auth.TTL_MS / 2) auth.writeCookie(req, res, tok.key, Date.now() + auth.TTL_MS);
  return { key: tok.key, gate: gate };
}

function senderDown(res) {
  res.status(503).json({
    ok: false,
    error: sender.reason(),
    sender_up: false,
  });
}

async function senderCall(method, path, body, timeoutMs) {
  if (!sender.up()) {
    const err = new Error('sender_down');
    err.code = 'sender_down';
    throw err;
  }
  const r = await sender.call(method, path, body, timeoutMs);
  if (!r.json) {
    const err = new Error('bad_response');
    err.code = 'bad_response';
    throw err;
  }
  return r;
}

function publicLogin(out) {
  const src = out || {};
  const view = {
    state: src.state || 'failed',
    passcode: src.passcode || '',
    remaining_seconds: src.remaining_seconds == null ? null : src.remaining_seconds,
    pending_id: src.pending_id || '',
    status: typeof src.status === 'number' ? src.status : null,
    text: text.customerText(src),
    can_force: !!src.can_force && !(src.status != null && HARD_STATUS[String(src.status)]),
  };
  if (view.state === 'ok' || view.state === 'waiting' || view.state === 'confirm_on_phone') view.text = '';
  return view;
}

async function accountRow(key, deviceId) {
  if (!ids.ownsDeviceId(key, deviceId)) return null;
  return db.one(
    'SELECT device_id, email, created_at FROM panel_accounts WHERE device_id=$1 AND license_key=$2',
    [deviceId, key]);
}

async function snapshot(deviceId) {
  const r = await senderCall('GET', '/v1/snapshot?device_id=' + encodeURIComponent(deviceId), null, 20000);
  if (!r.json.ok) {
    const err = new Error('snapshot');
    err.code = 'snapshot';
    throw err;
  }
  return r.json;
}

function viewAccount(row, snap) {
  const config = snap.config || {};
  const rooms = cfg.splitRooms(snap.rooms || []);
  return {
    device_id: row.device_id,
    email: row.email,
    linked: !!snap.linked,
    needs_register: !!snap.needs_register,
    connected: !!snap.connected,
    reason: snap.reason || '',
    macro: cfg.presentMacro(config.macro),
    visit: cfg.presentVisit(config.visit),
    cover: cfg.presentCover(config.cover),
    autoreply: cfg.presentReply(config.autoreply),
    triggers: cfg.presentTriggers(config.triggers),
    images: Array.isArray(snap.images) ? snap.images : [],
    rooms: rooms,
  };
}

async function loadView(key, deviceId) {
  const row = await accountRow(key, deviceId);
  if (!row) return null;
  const snap = await snapshot(deviceId);
  return viewAccount(row, snap);
}

router.post('/panel/api/login', wrap(async (req, res) => {
  if (!auth.configured()) {
    return res.status(503).json({ ok: false, error: '서버 설정이 없어 관리 화면을 열 수 없습니다.' });
  }
  const key = keys.normKey(req.body && req.body.key);
  if (!/^[A-Z0-9-]{8,40}$/.test(key)) return res.status(401).json({ ok: false, error: '없는 키입니다.' });
  const gate = await licenseOf(key);
  if (!gate.ok) return res.status(gate.status).json({ ok: false, error: gate.error });
  auth.writeCookie(req, res, key, Date.now() + auth.TTL_MS);
  res.json({ ok: true, mask: auth.maskKey(key), expires_at: gate.expires_at });
}));

router.post('/panel/api/logout', wrap(async (req, res) => {
  auth.clearCookie(req, res);
  res.json({ ok: true });
}));

router.get('/panel/api/me', wrap(async (req, res) => {
  const s = await session(req, res);
  if (!s) return;
  const rows = await db.q(
    'SELECT device_id, email FROM panel_accounts WHERE license_key=$1 ORDER BY created_at',
    [s.key]);
  const accounts = [];
  const up = sender.up();
  for (let i = 0; i < rows.rows.length; i++) {
    const row = rows.rows[i];
    let st = { linked: false, needs_register: false, connected: false, reason: up ? 'absent' : 'sender_down' };
    if (up) {
      try {
        const snap = await snapshot(row.device_id);
        st = {
          linked: !!snap.linked,
          needs_register: !!snap.needs_register,
          connected: !!snap.connected,
          reason: snap.reason || '',
        };
      } catch (e) {
        st.reason = 'sender_down';
      }
    }
    accounts.push({
      device_id: row.device_id,
      email: row.email,
      linked: st.linked,
      needs_register: st.needs_register,
      connected: st.connected,
      reason: st.reason,
    });
  }
  res.json({
    ok: true,
    mask: auth.maskKey(s.key),
    expires_at: s.gate.expires_at,
    sender_up: up,
    sender_reason: up ? '' : sender.reason(),
    accounts: accounts,
  });
}));

router.get('/panel/api/account', wrap(async (req, res) => {
  const s = await session(req, res);
  if (!s) return;
  if (!sender.up()) return senderDown(res);
  try {
    const view = await loadView(s.key, String(req.query.device_id || ''));
    if (!view) return res.status(404).json({ ok: false, error: '없는 계정입니다.' });
    res.json({ ok: true, account: view });
  } catch (e) {
    if (e && e.code === 'sender_down') return senderDown(res);
    throw e;
  }
}));

router.post('/panel/api/register/begin', wrap(async (req, res) => {
  const s = await session(req, res);
  if (!s) return;
  if (!sender.up()) return senderDown(res);
  const email = cleanEmail(req.body && req.body.email);
  const password = cleanPassword(req.body && req.body.password);
  if (!email || !password) return res.status(400).json({ ok: false, error: '카카오계정과 비밀번호를 입력해 주세요.' });
  let deviceId = String((req.body && req.body.device_id) || '');
  if (deviceId) {
    const row = await accountRow(s.key, deviceId);
    if (!row) return res.status(404).json({ ok: false, error: '없는 계정입니다.' });
  } else {
    const n = await db.one('SELECT count(*)::int AS n FROM panel_accounts WHERE license_key=$1', [s.key]);
    if (n && Number(n.n) >= MAX_ACCOUNTS) {
      return res.status(400).json({ ok: false, error: '계정은 8개까지 등록할 수 있습니다.' });
    }
    deviceId = ids.newDeviceId(s.key);
  }
  const now = Date.now();
  await db.q('DELETE FROM panel_pending WHERE expires_at < $1 OR (license_key=$2 AND device_id=$3)', [now, s.key, deviceId]);
  let out;
  try {
    const r = await senderCall('POST', '/v1/register/begin', {
      device_id: deviceId,
      email: email,
      password: password,
      forced: !!(req.body && req.body.forced),
    }, 45000);
    out = r.json;
  } catch (e) {
    if (e && (e.code === 'sender_down' || e.message === 'timeout')) return senderDown(res);
    return res.status(502).json({ ok: false, error: '카카오 서버에 연결하지 못했습니다.' });
  }
  if (!out || out.ok === false) {
    return res.status(502).json({ ok: false, error: '카카오 서버에 연결하지 못했습니다.' });
  }
  if (out.state === 'confirm_on_phone' && out.pending_id) {
    await db.q(
      `INSERT INTO panel_pending (pending_id, license_key, device_id, email, created_at, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [out.pending_id, s.key, deviceId, email, now, now + 15 * 60 * 1000]);
  }
  if (out.state === 'ok') await rememberAccount(s.key, deviceId, email, now);
  const view = publicLogin(out);
  view.device_id = deviceId;
  res.json({ ok: true, ...view });
}));

async function sessionReady(deviceId) {
  if (!sender.up()) return false;
  try {
    const snap = await snapshot(deviceId);
    return !!(snap && snap.linked && !snap.needs_register);
  } catch (e) {
    return false;
  }
}

function waitingView(deviceId) {
  return { ok: true, state: 'waiting', text: '', device_id: deviceId };
}

function okView(deviceId) {
  return { ok: true, state: 'ok', text: '', device_id: deviceId };
}

router.post('/panel/api/register/confirm', wrap(async (req, res) => {
  const s = await session(req, res);
  if (!s) return;
  const pendingId = String((req.body && req.body.pending_id) || '');
  const row = await db.one(
    'SELECT pending_id, device_id, email, expires_at FROM panel_pending WHERE pending_id=$1 AND license_key=$2',
    [pendingId, s.key]);
  if (row && await accountRow(s.key, row.device_id)) return res.json(okView(row.device_id));
  const expired = !row || Number(row.expires_at) < Date.now();
  if (expired) {
    if (row && !sender.up()) return res.json(waitingView(row.device_id));
    if (row && await sessionReady(row.device_id)) {
      await rememberAccount(s.key, row.device_id, row.email, Date.now());
      return res.json(okView(row.device_id));
    }
    if (row) await db.q('DELETE FROM panel_pending WHERE pending_id=$1', [pendingId]);
    return res.json({ ok: true, state: 'expired', text: text.customerText({ state: 'expired' }) });
  }
  if (await sessionReady(row.device_id)) {
    await rememberAccount(s.key, row.device_id, row.email, Date.now());
    return res.json(okView(row.device_id));
  }
  if (!sender.up()) return res.json(waitingView(row.device_id));
  let out;
  try {
    const r = await senderCall('POST', '/v1/register/confirm', { pending_id: pendingId }, 20000);
    out = r.json;
  } catch (e) {
    if (await sessionReady(row.device_id)) {
      await rememberAccount(s.key, row.device_id, row.email, Date.now());
      return res.json(okView(row.device_id));
    }
    return res.json(waitingView(row.device_id));
  }
  if (!out || out.ok === false) {
    if (await sessionReady(row.device_id)) {
      await rememberAccount(s.key, row.device_id, row.email, Date.now());
      return res.json(okView(row.device_id));
    }
    return res.json(waitingView(row.device_id));
  }
  if (out.state === 'ok' || (out.state === 'expired' && await sessionReady(row.device_id))) {
    const still = await db.one(
      'SELECT pending_id FROM panel_pending WHERE pending_id=$1 AND license_key=$2',
      [pendingId, s.key]);
    if (!still) {
      try { await senderCall('POST', '/v1/unlink', { device_id: row.device_id }, 20000); } catch (e) { /* 취소가 먼저다 */ }
      return res.json({ ok: true, state: 'expired', text: text.customerText({ state: 'expired' }) });
    }
    await rememberAccount(s.key, row.device_id, row.email, Date.now());
    out = { state: 'ok' };
  } else if (out.state !== 'waiting') {
    await db.q('DELETE FROM panel_pending WHERE pending_id=$1', [pendingId]);
  }
  const view = publicLogin(out);
  view.device_id = row.device_id;
  res.json({ ok: true, ...view });
}));

router.post('/panel/api/register/cancel', wrap(async (req, res) => {
  const s = await session(req, res);
  if (!s) return;
  const pendingId = String((req.body && req.body.pending_id) || '');
  const row = await db.one(
    'SELECT pending_id FROM panel_pending WHERE pending_id=$1 AND license_key=$2',
    [pendingId, s.key]);
  if (row) await db.q('DELETE FROM panel_pending WHERE pending_id=$1', [pendingId]);
  if (sender.up()) {
    try { await senderCall('POST', '/v1/register/cancel', { pending_id: pendingId }, 10000); } catch (e) { /* 자식이 없어도 화면은 닫는다 */ }
  }
  res.json({ ok: true });
}));

router.post('/panel/api/unlink', wrap(async (req, res) => {
  const s = await session(req, res);
  if (!s) return;
  const deviceId = String((req.body && req.body.device_id) || '');
  const row = await accountRow(s.key, deviceId);
  if (!row) return res.status(404).json({ ok: false, error: '없는 계정입니다.' });
  if (!sender.up()) return senderDown(res);
  const r = await senderCall('POST', '/v1/unlink', { device_id: deviceId }, 20000);
  if (!r.json.ok) return res.status(502).json({ ok: false, error: '등록을 해제하지 못했습니다. 잠시 뒤 다시 해 주세요.' });
  await db.q('DELETE FROM panel_accounts WHERE device_id=$1 AND license_key=$2', [deviceId, s.key]);
  res.json({ ok: true });
}));

router.post('/panel/api/rooms', wrap(async (req, res) => {
  const s = await session(req, res);
  if (!s) return;
  if (!sender.up()) return senderDown(res);
  const deviceId = String((req.body && req.body.device_id) || '');
  const row = await accountRow(s.key, deviceId);
  if (!row) return res.status(404).json({ ok: false, error: '없는 계정입니다.' });
  let snap;
  let listed;
  try {
    snap = await snapshot(deviceId);
    const r = await senderCall('GET', '/v1/chats?device_id=' + encodeURIComponent(deviceId), null, 90000);
    listed = r.json;
  } catch (e) {
    if (e && e.code === 'sender_down') return senderDown(res);
    return res.status(502).json({ ok: false, error: '대화방 목록을 가져오지 못했습니다.' });
  }
  if (!listed || !listed.ok) {
    if (listed && listed.needs_register) {
      return res.status(409).json({ ok: false, error: '카카오 로그인이 끊겼습니다. 계정을 다시 등록해 주세요.', needs_register: true });
    }
    return res.status(502).json({ ok: false, error: '대화방 목록을 가져오지 못했습니다.' });
  }
  const merged = cfg.mergeCatalog(snap.rooms || [], listed.chats || []);
  const saved = await senderCall('POST', '/v1/config', {
    device_id: deviceId,
    rooms: merged,
    features: cfg.featuresFor(s.gate.features, snap),
  }, 20000);
  if (!saved.json || !saved.json.ok) {
    return res.status(502).json({ ok: false, error: '대화방 목록을 저장하지 못했습니다.' });
  }
  const again = await snapshot(deviceId);
  res.json({ ok: true, account: viewAccount(row, again) });
}));

router.post('/panel/api/settings', wrap(async (req, res) => {
  const s = await session(req, res);
  if (!s) return;
  if (!sender.up()) return senderDown(res);
  const body = req.body || {};
  const deviceId = String(body.device_id || '');
  const row = await accountRow(s.key, deviceId);
  if (!row) return res.status(404).json({ ok: false, error: '없는 계정입니다.' });
  const snap = await snapshot(deviceId);
  let imageCount = Array.isArray(snap.images) ? snap.images.length : 0;
  let images;
  if (body.images_unchanged) {
    images = null;
  } else if (Array.isArray(body.images)) {
    try {
      images = cfg.normalizeImages(body.images);
    } catch (e) {
      return res.status(e.status || 400).json({ ok: false, error: e.message });
    }
    imageCount = images.length;
  }
  const next = cfg.applySettings(snap.config, body, snap.rooms || [], imageCount);
  const payload = {
    device_id: deviceId,
    config: next,
    features: cfg.featuresFor(s.gate.features, snap),
  };
  if (images) payload.images = images;
  if (Array.isArray(body.images) && images && images.length === 0) payload.images = [];
  const saved = await senderCall('POST', '/v1/config', payload, 30000);
  if (!saved.json || !saved.json.ok) {
    if (saved.json && saved.json.needs_register) {
      return res.status(409).json({ ok: false, error: '카카오 로그인이 끊겼습니다. 계정을 다시 등록해 주세요.', needs_register: true });
    }
    return res.status(502).json({ ok: false, error: '설정을 저장하지 못했습니다.' });
  }
  const again = await snapshot(deviceId);
  res.json({ ok: true, account: viewAccount(row, again) });
}));

// ── 채팅 ──────────────────────────────────────────────────────────────────
// 오픈프로필 갠톡·오픈채팅방의 대화를 이 화면에서 보고 답한다. 발송은 sender 세션이 한다.
function chatNeedsRegister(res) {
  return res.status(409).json({ ok: false, error: '카카오 로그인이 끊겼습니다. 계정을 다시 등록해 주세요.', needs_register: true });
}

router.get('/panel/api/chats', wrap(async (req, res) => {
  const s = await session(req, res);
  if (!s) return;
  if (!sender.up()) return senderDown(res);
  const deviceId = String(req.query.device_id || '');
  const row = await accountRow(s.key, deviceId);
  if (!row) return res.status(404).json({ ok: false, error: '없는 계정입니다.' });
  try {
    const r = await senderCall('GET', '/v1/inbox?device_id=' + encodeURIComponent(deviceId), null, 30000);
    if (!r.json.ok) {
      if (r.json.needs_register) return chatNeedsRegister(res);
      return res.status(502).json({ ok: false, error: '대화 목록을 가져오지 못했습니다.' });
    }
    res.json({ ok: true, chats: Array.isArray(r.json.chats) ? r.json.chats : [] });
  } catch (e) {
    if (e && (e.code === 'sender_down' || e.message === 'timeout')) return senderDown(res);
    throw e;
  }
}));

router.get('/panel/api/chat', wrap(async (req, res) => {
  const s = await session(req, res);
  if (!s) return;
  if (!sender.up()) return senderDown(res);
  const deviceId = String(req.query.device_id || '');
  const chatId = String(req.query.chat_id || '');
  if (!/^[1-9][0-9]*$/.test(chatId)) return res.status(400).json({ ok: false, error: '없는 대화방입니다.' });
  const row = await accountRow(s.key, deviceId);
  if (!row) return res.status(404).json({ ok: false, error: '없는 계정입니다.' });
  try {
    const r = await senderCall('GET',
      '/v1/thread?device_id=' + encodeURIComponent(deviceId) + '&chat_id=' + encodeURIComponent(chatId),
      null, 30000);
    if (!r.json.ok) {
      if (r.json.needs_register) return chatNeedsRegister(res);
      return res.status(502).json({ ok: false, error: '대화를 가져오지 못했습니다.' });
    }
    res.json({ ok: true, messages: Array.isArray(r.json.messages) ? r.json.messages : [] });
  } catch (e) {
    if (e && (e.code === 'sender_down' || e.message === 'timeout')) return senderDown(res);
    throw e;
  }
}));

router.post('/panel/api/chat/send', wrap(async (req, res) => {
  const s = await session(req, res);
  if (!s) return;
  if (!sender.up()) return senderDown(res);
  const body = req.body || {};
  const deviceId = String(body.device_id || '');
  const chatId = String(body.chat_id || '');
  const text = (typeof body.text === 'string' ? body.text : '').slice(0, 1000);
  if (!/^[1-9][0-9]*$/.test(chatId)) return res.status(400).json({ ok: false, error: '없는 대화방입니다.' });
  if (!text.trim()) return res.status(400).json({ ok: false, error: '보낼 내용을 입력해 주세요.' });
  const row = await accountRow(s.key, deviceId);
  if (!row) return res.status(404).json({ ok: false, error: '없는 계정입니다.' });
  try {
    const r = await senderCall('POST', '/v1/send', { device_id: deviceId, chat_id: chatId, text: text }, 20000);
    if (!r.json.ok) {
      if (r.json.needs_register) return chatNeedsRegister(res);
      return res.status(502).json({ ok: false, error: '메시지를 보내지 못했습니다. 잠시 뒤 다시 해 주세요.' });
    }
    res.json({ ok: true, log_id: r.json.log_id || '' });
  } catch (e) {
    if (e && (e.code === 'sender_down' || e.message === 'timeout')) return senderDown(res);
    throw e;
  }
}));

async function rememberAccount(key, deviceId, email, now) {
  await db.q(
    `INSERT INTO panel_accounts (device_id, license_key, email, created_at)
     VALUES ($1,$2,$3,$4)
     ON CONFLICT (device_id) DO UPDATE SET email=EXCLUDED.email
     WHERE panel_accounts.license_key = EXCLUDED.license_key`,
    [deviceId, key, email, now]);
}

module.exports = router;
