// 웹 콘솔 API (/panel/api/*) — 회원 세션으로 들어간다(docs/ACCOUNTS_V1.md 3.4).
//   - 카카오 계정(고객 자기 계정, 매크로): 등록·해제·설정·받은함·채팅·기록
//   - 내 방(방 관리봇·미니게임봇 설치): 목록·상태·설정·다시 시도·기록·가리기·내보내기 해제·랭킹 초기화
// 클라이언트가 보낸 device_id·chat_id·install_id 는 그대로 믿지 않는다. 항상 회원 소유를 DB(또는 60초
// 메모리 저장)로 확인한다. bot. 으로 시작하는 device_id 는 고객 경로에서 무조건 404 다.
// 키 로그인(POST /panel/api/login)은 없어졌다. 콘솔 로그인 화면은 /api/auth/login 을 부른다.
'use strict';

const express = require('express');

const db = require('../lib/db');
const memberAuth = require('../lib/member-auth');
const ids = require('../lib/panel-ids');
const text = require('../lib/auth-text');
const cfg = require('../lib/panel-config');
const roomCfg = require('../lib/room-config');
const entitle = require('../lib/entitle');
const installs = require('../lib/installs');
const sender = require('../lib/sender-child');
const inboxLib = require('../lib/panel-inbox');

const router = express.Router();
const HARD_STATUS = {
  '-111': true, '-328': true, '-997': true, '-101': true, '-102': true,
  '-444': true, '-445': true, '-950': true, '-998': true, '-999': true,
  '8': true, '12': true, '13': true, '30': true, '31': true, '32': true, '99': true,
};

const TEXT = {
  no_account: '계정을 찾을 수 없습니다.',
  no_room: '방을 찾을 수 없습니다.',
  not_ready: '아직 준비 중입니다. 잠시 뒤 다시 시도해 주세요.',
  no_macro: '카카오 계정은 카카오톡 매크로 이용 기간에만 등록할 수 있습니다. 매크로를 구매한 뒤 다시 시도해 주세요.',
  legacy_only: '계정 설정에서는 쓸 수 없는 기능입니다. 방 관리 기능은 [내 방]에서 방마다 설정해 주세요.',
  stale: '다른 화면에서 설정이 바뀌었습니다. 페이지를 새로고침한 뒤 다시 저장해 주세요.',
  busy: '이미 글을 가리는 중입니다. 끝난 뒤 다시 시도해 주세요.',
  not_kicked: 'K bot이 내보낸 사람이 아닙니다.',
  unkick_failed: '내보내기를 해제하지 못했습니다. 잠시 뒤 다시 시도해 주세요.',
  bad_passcode: '참여코드는 20자 이하로 입력해 주세요.',
  hide_target: '가릴 글 개수나 사람 중 하나를 골라 주세요.',
  hide_last: '가릴 글 개수는 1~300개로 입력해 주세요.',
  bad_user: '사람을 다시 골라 주세요.',
  no_job: '진행 중인 글 가리기를 찾을 수 없습니다.',
  bot_failed: 'K bot에 요청하지 못했습니다. 잠시 뒤 다시 시도해 주세요.',
  register_restart: '서버가 다시 시작되어 등록이 중단되었습니다. 처음부터 다시 등록해 주세요.',
};

function maxAccountsText() {
  return '카카오 계정은 ' + entitle.maxAccounts() + '개까지 등록할 수 있습니다. 쓰지 않는 계정을 등록 해제한 뒤 다시 시도해 주세요.';
}

function fail(res, status, reason, error, extra) {
  if (res.headersSent) return;
  res.status(status).json(Object.assign({ ok: false, reason: reason, error: error }, extra || {}));
}

const wrap = (fn) => (req, res) => Promise.resolve(fn(req, res)).catch((e) => {
  if (e && (e.code === 'sender_down' || e.message === 'timeout')) return senderDown(res);
  if (e && e.code === 'NOT_IMPLEMENTED') return fail(res, 503, 'not_ready', TEXT.not_ready);
  console.error('[panel ' + req.method + ' ' + req.path + '] ' + (e && e.stack ? e.stack : e));
  if (!res.headersSent) res.status(500).json({ ok: false, error: '요청을 처리하지 못했습니다. 잠시 뒤 다시 시도해 주세요.' });
});

// 다른 작업의 모듈이 아직 틀이면 기본값으로(그 밖의 오류는 그대로 던진다)
async function optional(fn, fallback) {
  try {
    return await fn();
  } catch (e) {
    if (e && e.code === 'NOT_IMPLEMENTED') return fallback;
    throw e;
  }
}

function later(label, fn) {
  Promise.resolve().then(fn).catch((e) => console.error('[panel] ' + label + ' 실패: ' + (e && e.message ? e.message : e)));
}

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

// 회원 세션. 401/403 은 memberAuth 가 직접 쓴다.
async function session(req, res) {
  return memberAuth.requireMember(req, res);
}

async function memberRow(memberId) {
  return db.one(
    'SELECT id, login_id, macro_until, legacy_room_until, blocked_reason FROM members WHERE id=$1', [memberId]);
}

function legacyOn(m, now) {
  return !!m && Number(m.legacy_room_until) > (now || Date.now());
}

function senderDown(res) {
  res.status(503).json({
    ok: false,
    reason: 'sender_down',
    error: sender.customerReason() || '발송 서버가 잠시 멈춰 있습니다. 복구되면 등록한 카카오 계정으로 자동으로 다시 접속합니다.',
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

// 이 회원의 카카오 계정 한 줄. 남의 것·봇 계정·없는 것은 null.
async function accountRow(memberId, deviceId) {
  if (typeof deviceId !== 'string' || !deviceId || ids.isBotId(deviceId) || deviceId.length > 64) return null;
  return db.one(
    'SELECT device_id, email, created_at FROM panel_accounts WHERE device_id=$1 AND member_id=$2',
    [deviceId, memberId]);
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

function viewAccount(row, snap, legacy) {
  const config = snap.config || {};
  const rooms = cfg.splitRooms(snap.rooms || []);
  return {
    device_id: row.device_id,
    email: row.email,
    linked: !!snap.linked,
    needs_register: !!snap.needs_register,
    connected: !!snap.connected,
    reason: snap.reason || '',
    legacy: !!legacy,
    macro: cfg.presentMacro(config.macro),
    visit: cfg.presentVisit(config.visit),
    cover: cfg.presentCover(config.cover),
    profile: cfg.presentProfile(config.profile),
    guard: cfg.presentGuard(config.guard),
    autoreply: cfg.presentReply(config.autoreply),
    triggers: cfg.presentTriggers(config.triggers),
    images: Array.isArray(snap.images) ? snap.images : [],
    rooms: rooms,
  };
}

async function loadView(memberId, deviceId) {
  const row = await accountRow(memberId, deviceId);
  if (!row) return null;
  const snap = await snapshot(deviceId);
  const m = await memberRow(memberId);
  return viewAccount(row, snap, legacyOn(m));
}

router.post('/panel/api/logout', wrap(async (req, res) => {
  await memberAuth.endSession(req, res);
  res.json({ ok: true });
}));

router.get('/panel/api/me', wrap(async (req, res) => {
  const s = await session(req, res);
  if (!s) return;
  const id = s.member.id;
  const m = await memberRow(id);
  if (!m) return fail(res, 401, 'login_required', memberAuth.TEXT.login_required);
  const g = await db.one('SELECT member_id FROM member_google WHERE member_id=$1', [id]);
  const rows = await memberAccountRows(id, true);
  const up = sender.up();
  const accounts = await Promise.all(rows.map(async (row) => {
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
    return {
      device_id: row.device_id,
      email: row.email,
      linked: st.linked,
      needs_register: st.needs_register,
      connected: st.connected,
      reason: st.reason,
    };
  }));
  const rooms = await optional(() => installs.listForMember(id), []);
  res.set('Cache-Control', 'no-store');
  res.json({
    ok: true,
    member: { id: Number(m.id), login_id: m.login_id, google_linked: !!g },
    macro: entitle.macroView(m),
    legacy_room_until: Number(m.legacy_room_until) || 0,
    max_accounts: entitle.maxAccounts(),
    accounts: accounts,
    rooms: Array.isArray(rooms) ? rooms : [],
    sender_up: up,
    sender_reason: up ? '' : sender.customerReason(),
  });
}));

router.get('/panel/api/account', wrap(async (req, res) => {
  const s = await session(req, res);
  if (!s) return;
  if (!sender.up()) return senderDown(res);
  try {
    const view = await loadView(s.member.id, String(req.query.device_id || ''));
    if (!view) return fail(res, 404, 'not_found', TEXT.no_account);
    res.json({ ok: true, account: view });
  } catch (e) {
    if (e && e.code === 'sender_down') return senderDown(res);
    throw e;
  }
}));

router.post('/panel/api/register/begin', wrap(async (req, res) => {
  const s = await session(req, res);
  if (!s) return;
  const memberId = s.member.id;
  let deviceId = String((req.body && req.body.device_id) || '');
  if (deviceId) {
    // 등록이 끊긴 기존 계정의 재등록은 매크로 기간과 관계없이 받는다
    const row = await accountRow(memberId, deviceId);
    if (!row) return fail(res, 404, 'not_found', TEXT.no_account);
  } else {
    const m = await memberRow(memberId);
    const now = Date.now();
    if (!m || !(Number(m.macro_until) > now || Number(m.legacy_room_until) > now)) {
      return fail(res, 403, 'no_macro', TEXT.no_macro);
    }
    const n = await db.one('SELECT count(*)::int AS n FROM panel_accounts WHERE member_id=$1', [memberId]);
    if (n && Number(n.n) >= entitle.maxAccounts()) return fail(res, 400, 'max_accounts', maxAccountsText());
    deviceId = ids.newMemberDeviceId(memberId);
  }
  const email = cleanEmail(req.body && req.body.email);
  const password = cleanPassword(req.body && req.body.password);
  if (!email || !password) return fail(res, 400, 'bad_input', '카카오 계정과 비밀번호를 입력해 주세요.');
  if (!sender.up()) return senderDown(res);
  const now = Date.now();
  await db.q('DELETE FROM panel_pending WHERE expires_at < $1 OR (member_id=$2 AND device_id=$3)', [now, memberId, deviceId]);
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
      `INSERT INTO panel_pending (pending_id, license_key, member_id, device_id, email, created_at, expires_at)
       VALUES ($1,NULL,$2,$3,$4,$5,$6)`,
      [out.pending_id, memberId, deviceId, email, now, now + 15 * 60 * 1000]);
  }
  if (out.state === 'ok') await rememberAccount(memberId, deviceId, email, now);
  const view = publicLogin(out);
  view.device_id = deviceId;
  res.json({ ok: true, ...view });
}));

// 이 등록 대기가 시작된 뒤(since)에 저장된 세션이어야 끝난 것으로 본다. 재등록은 예전 세션이 아직 붙어 있을 수 있어서
// '붙어 있다'만으로는 휴대폰 확인을 마쳤는지 알 수 없다. 저장할 때 sender 가 features.reg_at 을 찍는다.
async function sessionReady(deviceId, since) {
  if (!sender.up()) return false;
  try {
    const snap = await snapshot(deviceId);
    const regAt = Number(snap && snap.features && snap.features.reg_at) || 0;
    return !!(snap && snap.linked && !snap.needs_register && regAt >= Number(since || 0));
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
  const memberId = s.member.id;
  const pendingId = String((req.body && req.body.pending_id) || '');
  const row = await db.one(
    'SELECT pending_id, device_id, email, created_at, expires_at FROM panel_pending WHERE pending_id=$1 AND member_id=$2',
    [pendingId, memberId]);
  // 앞선 확인이 이미 끝냈다: 새 계정은 성공한 순간 panel_accounts 행이 생긴다.
  // 재등록은 예전 행이 그대로라(created_at 을 바꾸지 않는다) 여기서 끝내지 않고 sender 에 묻는다.
  const acct = row ? await accountRow(memberId, row.device_id) : null;
  if (acct && Number(acct.created_at) >= Number(row.created_at)) return res.json(okView(row.device_id));
  const since = row ? Number(row.created_at) : 0;
  const finish = async () => {
    await rememberAccount(memberId, row.device_id, row.email, Date.now());
    return res.json(okView(row.device_id));
  };
  const expired = !row || Number(row.expires_at) < Date.now();
  if (expired) {
    if (row && !sender.up()) return res.json(waitingView(row.device_id));
    if (row && await sessionReady(row.device_id, since)) return finish();
    if (row) await db.q('DELETE FROM panel_pending WHERE pending_id=$1', [pendingId]);
    return res.json({ ok: true, state: 'expired', text: text.customerText({ state: 'expired' }) });
  }
  if (await sessionReady(row.device_id, since)) return finish();
  if (!sender.up()) return res.json(waitingView(row.device_id));
  let out;
  try {
    const r = await senderCall('POST', '/v1/register/confirm', { pending_id: pendingId }, 20000);
    out = r.json;
  } catch (e) {
    if (await sessionReady(row.device_id, since)) return finish();
    return res.json(waitingView(row.device_id));
  }
  if (!out || out.ok === false) {
    if (await sessionReady(row.device_id, since)) return finish();
    return res.json(waitingView(row.device_id));
  }
  if (out.state === 'ok' || (out.state === 'expired' && await sessionReady(row.device_id, since))) {
    const still = await db.one(
      'SELECT pending_id FROM panel_pending WHERE pending_id=$1 AND member_id=$2',
      [pendingId, memberId]);
    if (!still) {
      try { await senderCall('POST', '/v1/unlink', { device_id: row.device_id }, 20000); } catch (e) { /* 취소가 먼저다 */ }
      return res.json({ ok: true, state: 'expired', text: text.customerText({ state: 'expired' }) });
    }
    await rememberAccount(memberId, row.device_id, row.email, Date.now());
    out = { state: 'ok' };
  } else if (out.state !== 'waiting') {
    await db.q('DELETE FROM panel_pending WHERE pending_id=$1', [pendingId]);
    // sender 가 다시 시작해 대기 목록을 잃었다 → 시간이 지났다고 하지 않고 그대로 말한다
    if (out.state === 'expired' && out.reason === 'unknown_pending') {
      return res.json({ ok: true, state: 'expired', text: TEXT.register_restart, device_id: row.device_id });
    }
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
    'SELECT pending_id FROM panel_pending WHERE pending_id=$1 AND member_id=$2',
    [pendingId, s.member.id]);
  if (row) {
    await db.q('DELETE FROM panel_pending WHERE pending_id=$1', [pendingId]);
    if (sender.up()) {
      try { await senderCall('POST', '/v1/register/cancel', { pending_id: pendingId }, 10000); } catch (e) { /* 자식이 없어도 화면은 닫는다 */ }
    }
  }
  res.json({ ok: true });
}));

router.post('/panel/api/unlink', wrap(async (req, res) => {
  const s = await session(req, res);
  if (!s) return;
  const deviceId = String((req.body && req.body.device_id) || '');
  const row = await accountRow(s.member.id, deviceId);
  if (!row) return fail(res, 404, 'not_found', TEXT.no_account);
  if (!sender.up()) return senderDown(res);
  const r = await senderCall('POST', '/v1/unlink', { device_id: deviceId }, 20000);
  if (!r.json.ok) return res.status(502).json({ ok: false, error: '등록을 해제하지 못했습니다. 잠시 뒤 다시 시도해 주세요.' });
  await db.q('DELETE FROM panel_accounts WHERE device_id=$1 AND member_id=$2', [deviceId, s.member.id]);
  forgetAccounts(s.member.id);
  res.json({ ok: true });
}));

router.post('/panel/api/rooms', wrap(async (req, res) => {
  const s = await session(req, res);
  if (!s) return;
  if (!sender.up()) return senderDown(res);
  const deviceId = String((req.body && req.body.device_id) || '');
  const row = await accountRow(s.member.id, deviceId);
  if (!row) return fail(res, 404, 'not_found', TEXT.no_account);
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
  // 권리(features)는 보내지 않는다 — /v1/grants 만 바꾼다(3.4.1)
  const saved = await senderCall('POST', '/v1/config', { device_id: deviceId, rooms: merged }, 20000);
  if (!saved.json || !saved.json.ok) {
    return res.status(502).json({ ok: false, error: '대화방 목록을 저장하지 못했습니다.' });
  }
  const again = await snapshot(deviceId);
  const m = await memberRow(s.member.id);
  // 이름을 아직 못 읽은 오픈채팅방 수 — 화면이 "목록이 최신입니다" 대신 몇 개가 빠졌는지 알린다
  const unnamed = cfg.unnamedRooms(merged, listed.chats || []);
  res.json({ ok: true, account: viewAccount(row, again, legacyOn(m)), unnamed: unnamed });
}));

router.post('/panel/api/settings', wrap(async (req, res) => {
  const s = await session(req, res);
  if (!s) return;
  const body = req.body || {};
  const deviceId = String(body.device_id || '');
  const row = await accountRow(s.member.id, deviceId);
  if (!row) return fail(res, 404, 'not_found', TEXT.no_account);
  // 계정 단위 옛 기능(입장·퇴장 로그·프로필 로그·올킥 방지·금지어 검열)은 키를 이관한 회원의 유예 기간에만
  const m = await memberRow(s.member.id);
  const legacy = legacyOn(m);
  if (!legacy && cfg.legacyKeysIn(body).length) return fail(res, 403, 'legacy_only', TEXT.legacy_only);
  if (!sender.up()) return senderDown(res);
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
  const payload = { device_id: deviceId, config: next };
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
  res.json({ ok: true, account: viewAccount(row, again, legacy) });
}));

// ── 채팅 ──────────────────────────────────────────────────────────────────
// 오픈프로필 갠톡·오픈채팅방의 대화를 이 화면에서 보고 답한다. 발송은 sender 세션이 한다.
function chatNeedsRegister(res) {
  return res.status(409).json({ ok: false, error: '카카오 로그인이 끊겼습니다. 계정을 다시 등록해 주세요.', needs_register: true });
}

// 통합 받은함은 9초, 열린 방은 3초마다 돌아온다. 그 횟수만큼 Neon 을 깨우지 않으려고 계정 목록은
// 회원별 60초 임시 저장에서 읽고, 등록·해제·이관 때 비운다. 세션 읽기도 30초 메모리 저장이다
// (lib/member-auth.js). 키 이관 계정은 예전 키 모양의 id 라서 모양만으로는 소유를 알 수 없다 → 목록으로 본다.
const ACCOUNT_CACHE_MS = 60000;
const acctCache = new Map();                      // member_id -> { rows, at }
async function memberAccountRows(memberId, fresh) {
  const id = Number(memberId);
  const hit = acctCache.get(id);
  if (!fresh && hit && Date.now() - hit.at < ACCOUNT_CACHE_MS) return hit.rows;
  const r = await db.q(
    'SELECT device_id, email FROM panel_accounts WHERE member_id=$1 ORDER BY created_at', [id]);
  acctCache.set(id, { rows: r.rows, at: Date.now() });
  return r.rows;
}
function forgetAccounts(memberId) { acctCache.delete(Number(memberId)); }

// 받은함·채팅·기록 같은 읽기 경로의 소유 확인(목록 임시 저장으로). bot. 은 늘 거절.
async function ownsMemberDevice(memberId, deviceId) {
  if (typeof deviceId !== 'string' || !deviceId || ids.isBotId(deviceId)) return false;
  const rows = await memberAccountRows(memberId);
  return rows.some((r) => r.device_id === deviceId);
}

router.get('/panel/api/inbox', wrap(async (req, res) => {
  const s = await session(req, res);
  if (!s) return;
  const rows = await memberAccountRows(s.member.id);
  const up = sender.up();
  const settled = up
    ? await Promise.allSettled(rows.map((row) =>
        senderCall('GET', '/v1/inbox?device_id=' + encodeURIComponent(row.device_id), null, 30000)))
    : [];
  const merged = inboxLib.mergeInbox(rows, settled, up);
  res.json({
    ok: true,
    sender_up: up,
    sender_reason: up ? '' : sender.customerReason(),
    at: Date.now(),
    accounts: merged.accounts,
    chats: merged.chats,
  });
}));

router.get('/panel/api/chats', wrap(async (req, res) => {
  const s = await session(req, res);
  if (!s) return;
  if (!sender.up()) return senderDown(res);
  const deviceId = String(req.query.device_id || '');
  if (!(await ownsMemberDevice(s.member.id, deviceId))) return fail(res, 404, 'not_found', TEXT.no_account);
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
  if (!/^[1-9][0-9]*$/.test(chatId)) return res.status(400).json({ ok: false, error: '대화방을 찾을 수 없습니다.' });
  if (!(await ownsMemberDevice(s.member.id, deviceId))) return fail(res, 404, 'not_found', TEXT.no_account);
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
  // 이름을 text 로 두면 위쪽의 auth-text 모듈(const text)을 가린다.
  const msg = (typeof body.text === 'string' ? body.text : '').slice(0, 1000);
  if (!/^[1-9][0-9]*$/.test(chatId)) return res.status(400).json({ ok: false, error: '대화방을 찾을 수 없습니다.' });
  if (!msg.trim()) return res.status(400).json({ ok: false, error: '보낼 내용을 입력해 주세요.' });
  const row = await accountRow(s.member.id, deviceId);
  if (!row) return fail(res, 404, 'not_found', TEXT.no_account);
  try {
    const r = await senderCall('POST', '/v1/send', { device_id: deviceId, chat_id: chatId, text: msg }, 20000);
    if (!r.json.ok) {
      if (r.json.needs_register) return chatNeedsRegister(res);
      return res.status(502).json({ ok: false, error: '메시지를 보내지 못했습니다. 잠시 뒤 다시 시도해 주세요.' });
    }
    res.json({ ok: true, log_id: r.json.log_id || '' });
  } catch (e) {
    if (e && (e.code === 'sender_down' || e.message === 'timeout')) return senderDown(res);
    throw e;
  }
}));

// ── 기록 ──────────────────────────────────────────────────────────────────
// 계정 단위 옛 기능의 입장·퇴장 기록, 프로필 변경 기록, 올킥 감지 알림(유예 회원). 기능을 켠 방만 남는다.
// sender 가 저장된 기록에서 바로 읽으므로 카카오 연결이 끊겨 있어도 보인다.
function logList(v) {
  return Array.isArray(v) ? v : [];
}

router.get('/panel/api/logs', wrap(async (req, res) => {
  const s = await session(req, res);
  if (!s) return;
  if (!sender.up()) return senderDown(res);
  const deviceId = String(req.query.device_id || '');
  if (!(await ownsMemberDevice(s.member.id, deviceId))) return fail(res, 404, 'not_found', TEXT.no_account);
  try {
    const r = await senderCall('GET', '/v1/logs?device_id=' + encodeURIComponent(deviceId), null, 20000);
    if (r.status === 404) return res.json({ ok: true, visit: [], profile: [], guard: [] });
    if (!r.json.ok) return res.status(502).json({ ok: false, error: '기록을 가져오지 못했습니다.' });
    res.json({
      ok: true,
      visit: logList(r.json.visit),
      profile: logList(r.json.profile),
      guard: logList(r.json.guard),
    });
  } catch (e) {
    if (e && (e.code === 'sender_down' || e.message === 'timeout')) return senderDown(res);
    if (e && e.code === 'bad_response') return res.status(502).json({ ok: false, error: '기록을 가져오지 못했습니다.' });
    throw e;
  }
}));

async function rememberAccount(memberId, deviceId, email, now) {
  await db.q(
    `INSERT INTO panel_accounts (device_id, license_key, member_id, email, created_at)
     VALUES ($1,NULL,$2,$3,$4)
     ON CONFLICT (device_id) DO UPDATE SET email=EXCLUDED.email
     WHERE panel_accounts.member_id = EXCLUDED.member_id`,
    [deviceId, memberId, email, now]);
  forgetAccounts(memberId);
  // 등록이 끝나면 바로 실제 권리를 민다(새 기록의 기본 권리는 거부, 5.1)
  later('권리 밀기', () => entitle.pushGrants(memberId));
}

// ── 내 방 (3.4.3) ───────────────────────────────────────────────────────────
// 방 관리 경로의 공통 게이트(부모와 sender 가 같은 순서로 검사): 상품 없음 403 → 사용 중 아님 409.
const ROOM_TEXT = {
  no_roombot: roomCfg.TEXT.no_roombot,
  no_minigame: roomCfg.TEXT.no_minigame,
  not_active: roomCfg.TEXT.not_active,
};

const SEOUL_HM = new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
function hhmm(ms) {
  const parts = SEOUL_HM.formatToParts(new Date(Number(ms) || Date.now()));
  const h = (parts.find((p) => p.type === 'hour') || {}).value || '00';
  const m = (parts.find((p) => p.type === 'minute') || {}).value || '00';
  return h + ':' + m;
}

function installIdOf(v) {
  const s = String(v === undefined || v === null ? '' : v).trim();
  return /^[1-9][0-9]{0,15}$/.test(s) ? Number(s) : 0;
}

function productsOf(row) {
  return { roombot: !!(row && row.roombot), minigame: !!(row && row.minigame) };
}

// 이 회원의 설치(installed·pending_payment). 없으면 404 를 쓰고 null.
async function roomFor(res, memberId, rawId) {
  const id = installIdOf(rawId);
  if (!id) { fail(res, 404, 'not_found', TEXT.no_room); return null; }
  const got = await installs.getForMember(memberId, id);
  if (!got || !got.row) { fail(res, 404, 'not_found', TEXT.no_room); return null; }
  return { id: id, row: got.row, view: got.view || {} };
}

function roombotGate(res, got) {
  if (!got.row.roombot) { fail(res, 403, 'no_roombot', ROOM_TEXT.no_roombot); return false; }
  if (got.view.display !== 'active') { fail(res, 409, 'not_active', ROOM_TEXT.not_active); return false; }
  return true;
}

// sender /v1/bot/* 의 {ok:false, error} 를 화면 응답으로
function botError(res, json, extra) {
  const code = json && json.error ? String(json.error) : '';
  if (code === 'no_roombot') return fail(res, 403, 'no_roombot', ROOM_TEXT.no_roombot);
  if (code === 'no_minigame') return fail(res, 403, 'no_minigame', ROOM_TEXT.no_minigame);
  if (code === 'not_active') return fail(res, 409, 'not_active', ROOM_TEXT.not_active);
  if (code === 'busy') return fail(res, 409, 'busy', TEXT.busy);
  if (code === 'not_kicked') return fail(res, 404, 'not_kicked', TEXT.not_kicked);
  if (code === 'failed') return fail(res, 502, 'failed', (extra && extra.failed) || TEXT.bot_failed);
  if (code === 'not_found') return fail(res, 404, 'not_found', (extra && extra.not_found) || TEXT.no_room);
  return fail(res, 502, code || 'bot_failed', TEXT.bot_failed);
}

function nudge(installId) {
  later('nudge', () => installs.nudge(installId));
}

router.get('/panel/api/bot-rooms', wrap(async (req, res) => {
  const s = await session(req, res);
  if (!s) return;
  const rooms = await optional(() => installs.listForMember(s.member.id), []);
  res.set('Cache-Control', 'no-store');
  res.json({ ok: true, rooms: Array.isArray(rooms) ? rooms : [] });
}));

router.get('/panel/api/bot-room', wrap(async (req, res) => {
  const s = await session(req, res);
  if (!s) return;
  const got = await roomFor(res, s.member.id, req.query.id);
  if (!got) return;
  const up = sender.up();
  let live = null;
  let ranking = null;
  if (up && got.row.phase === 'installed') {
    try {
      const r = await senderCall('GET', '/v1/bot/room?install_id=' + got.id, null, 10000);
      if (r.json && r.json.ok) {
        live = r.json.live || null;
        ranking = Array.isArray(r.json.ranking) ? r.json.ranking : null;
      }
    } catch (e) { /* 실시간 칸만 비운다 */ }
  }
  res.set('Cache-Control', 'no-store');
  res.json({
    ok: true,
    room: got.view,
    config: roomCfg.presentRoomConfig(got.row.config, productsOf(got.row)),
    ranking: ranking,
    live: live,
    sender_up: up,
  });
}));

router.post('/panel/api/bot-room/settings', wrap(async (req, res) => {
  const s = await session(req, res);
  if (!s) return;
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const got = await roomFor(res, s.member.id, body.id);
  if (!got) return;
  const products = productsOf(got.row);
  const clean = roomCfg.sanitizeRoomConfig(got.row.config, body, { products: products, display: got.view.display });
  // 순서: 상품·상태(403·409) → 다른 화면의 저장(409 stale) → 값 검증(400)
  if (!clean.ok && clean.status !== 400) return fail(res, clean.status, clean.reason, clean.error);
  let rev = null;
  if (body.rev !== undefined && body.rev !== null && body.rev !== '') {
    rev = Number(body.rev);
    if (!Number.isInteger(rev) || rev !== Number(got.row.config_rev)) return fail(res, 409, 'stale', TEXT.stale);
  }
  if (!clean.ok) return fail(res, clean.status, clean.reason, clean.error);
  const saved = await installs.saveConfig(s.member.id, got.id, clean.config, rev === null ? undefined : rev);
  if (!saved || !saved.ok) {
    const st = (saved && saved.status) || 409;
    return fail(res, st, (saved && saved.reason) || 'stale', (saved && saved.error) || TEXT.stale);
  }
  nudge(got.id);
  const again = await installs.getForMember(s.member.id, got.id);
  const row = (again && again.row) || saved.row || got.row;
  res.json({
    ok: true,
    room: (again && again.view) || got.view,
    config: roomCfg.presentRoomConfig(row.config, productsOf(row)),
  });
}));

router.post('/panel/api/bot-room/retry', wrap(async (req, res) => {
  const s = await session(req, res);
  if (!s) return;
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const got = await roomFor(res, s.member.id, body.id);
  if (!got) return;
  let passcode;
  if (body.passcode !== undefined && body.passcode !== null && body.passcode !== '') {
    if (typeof body.passcode !== 'string' && typeof body.passcode !== 'number') return fail(res, 400, 'bad_passcode', TEXT.bad_passcode);
    passcode = String(body.passcode).trim();
    if (passcode.length > 20) return fail(res, 400, 'bad_passcode', TEXT.bad_passcode);
  }
  const r = await installs.retry(got.id, { memberId: s.member.id, passcode: passcode });
  if (!r || !r.ok) {
    const extra = {};
    if (r && r.retry_after !== undefined) extra.retry_after = r.retry_after;
    return fail(res, (r && r.status) || 409, (r && r.reason) || 'not_retryable', (r && r.error) || '지금은 다시 시도할 수 없습니다.', extra);
  }
  nudge(got.id);
  const again = await installs.getForMember(s.member.id, got.id);
  res.json({ ok: true, room: again ? again.view : got.view });
}));

// ── 봇 옮기기·다시 설치 (무료, 3.4.3) ──────────────────────────────────────
// 방마다 간격(옮기기 24시간 · 다시 설치 30분)과 연속 횟수는 installs 가 DB 로 센다. 여기서는 옮기기 시도를 회원당 시간 20번으로
// 묶는다 — 옮기기는 실제 봇 계정이 카카오에 링크를 조회한다(실패한 시도는 DB 간격에 잡히지 않으므로). IP 버킷은 preview(분당 20).
const MOVE_PER_HOUR = 20;
const moveHits = new Map();   // memberId → {start, n}

function moveAllowed(memberId, now) {
  const t = now || Date.now();
  if (moveHits.size > 5000) {
    for (const [k, v] of moveHits) if (t - v.start >= 3600000) moveHits.delete(k);
  }
  const cur = moveHits.get(memberId);
  if (!cur || t - cur.start >= 3600000) {
    moveHits.set(memberId, { start: t, n: 1 });
    return { ok: true };
  }
  cur.n += 1;
  if (cur.n > MOVE_PER_HOUR) return { ok: false, retryAfter: Math.ceil((cur.start + 3600000 - t) / 1000) };
  return { ok: true };
}

function bodyPasscode(res, body) {
  if (body.passcode === undefined || body.passcode === null || body.passcode === '') return { ok: true, value: undefined };
  if (typeof body.passcode !== 'string' && typeof body.passcode !== 'number') { fail(res, 400, 'bad_passcode', TEXT.bad_passcode); return null; }
  const v = String(body.passcode).trim();
  if (v.length > 20) { fail(res, 400, 'bad_passcode', TEXT.bad_passcode); return null; }
  return { ok: true, value: v || undefined };
}

function selfFail(res, r) {
  const extra = {};
  if (r && r.retry_after !== undefined) {
    extra.retry_after = r.retry_after;
    const sec = Math.ceil((Number(r.retry_after) - Date.now()) / 1000);
    if (sec > 0) res.set('Retry-After', String(sec));
  }
  return fail(res, (r && r.status) || 409, (r && r.reason) || 'failed', (r && r.error) || TEXT.bot_failed, extra);
}

router.post('/panel/api/bot-room/move', wrap(async (req, res) => {
  const s = await session(req, res);
  if (!s) return;
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const got = await roomFor(res, s.member.id, body.id);
  if (!got) return;
  if (typeof body.link !== 'string' || !body.link.trim() || body.link.length > 2000) {
    return fail(res, 400, 'bad_link', installs.TEXT.bad_link);
  }
  const pc = bodyPasscode(res, body);
  if (!pc) return;
  const lim = moveAllowed(Number(s.member.id));
  if (!lim.ok) {
    res.set('Retry-After', String(lim.retryAfter));
    return fail(res, 429, 'rate_limited', '요청이 너무 잦습니다. 잠시 뒤 다시 시도해 주세요.');
  }
  const r = await installs.selfMove(got.id, body.link, { memberId: s.member.id, passcode: pc.value, req: req });
  if (!r || !r.ok) return selfFail(res, r);
  nudge(got.id);
  const again = await installs.getForMember(s.member.id, got.id);
  res.json({ ok: true, kind: r.kind, same_room: !!r.same_room, held: !!r.held, room: again ? again.view : got.view });
}));

router.post('/panel/api/bot-room/reinstall', wrap(async (req, res) => {
  const s = await session(req, res);
  if (!s) return;
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const got = await roomFor(res, s.member.id, body.id);
  if (!got) return;
  const pc = bodyPasscode(res, body);
  if (!pc) return;
  const r = await installs.selfReinstall(got.id, { memberId: s.member.id, passcode: pc.value, req: req });
  if (!r || !r.ok) return selfFail(res, r);
  nudge(got.id);
  const again = await installs.getForMember(s.member.id, got.id);
  res.json({ ok: true, kind: 'reinstall', same_room: true, held: false, room: again ? again.view : got.view });
}));

// ── 조치 기록 한 줄 (7.8). detail 칸은 sender(작업 3)가 쓴다 — 아래 이름들을 읽는다.
const KICK_WHY = { churn: '들낙', leave: '퇴장', leaveKick: '퇴장', promo: '홍보', manual: '수동', panel: '수동', command: '수동' };
const SKIP_WHAT = { send: '발송', notice: '발송', reply: '발송', kick: '내보내기', hide: '글 가리기', rewrite: '글 가리기' };
// 건너뛴 까닭(sender 의 detail.note). note 가 없으면 K bot 자체 한도(방·시간·하루)를 넘은 것이다.
const SKIP_WHY = { wave: '올킥 감지 중이라 건너뜀', paused: '실패가 이어져 잠시 멈춤', stale: '늦어져서 건너뜀' };

function pick(o, names) {
  for (let i = 0; i < names.length; i++) {
    const v = o[names[i]];
    if (v !== undefined && v !== null && v !== '') return v;
  }
  return undefined;
}

function shortErr(code) {
  const e = installs.ERRORS && code ? installs.ERRORS[code] : null;
  return (e && e.short) || (code ? String(code) : '');
}

function roomLogText(row) {
  const d = row && row.detail && typeof row.detail === 'object' ? row.detail : {};
  const name = (row && row.name) || pick(d, ['name', 'nick']) || (row && row.user_id) || '알 수 없음';
  const kind = row ? row.kind : '';
  if (kind === 'churn') {
    const min = pick(d, ['windowMin', 'min', 'minutes']);
    const n = pick(d, ['joins', 'n', 'count']);
    const act = pick(d, ['action']) === 'kick' ? (row.ok === false ? '내보내기 실패' : '내보내기') : '경고';
    return '들낙 감지 · ' + name + (min !== undefined ? ' ' + min + '분' : '') + (n !== undefined ? ' ' + n + '회' : '') + ' · ' + act;
  }
  if (kind === 'kick' || kind === 'kick_fail') {
    const why = KICK_WHY[pick(d, ['why', 'reason', 'source'])] || '';
    const note = kind === 'kick_fail' ? pick(d, ['note', 'error']) : undefined;
    return (kind === 'kick' ? '내보내기' : '내보내기 실패') + ' · ' + name + (why ? ' · ' + why : '') +
      (note && typeof note === 'string' && note.length <= 20 ? ' · ' + note : '');
  }
  if (kind === 'unkick') return '내보내기 해제 · ' + name;
  if (kind === 'promo') {
    const n = pick(d, ['n', 'count', 'warn']);
    return '홍보 금지 · ' + name + (n !== undefined ? ' · 경고 ' + n + '회' : '');
  }
  if (kind === 'hide') {
    const n = Number(pick(d, ['n', 'count', 'done', 'total'])) || 0;
    const failed = Number(pick(d, ['failed', 'fail'])) || 0;
    const by = pick(d, ['by']) === 'panel' ? '패널' : '방에서';
    return '글 가리기 · ' + n + '개' + (failed ? ' (실패 ' + failed + '개)' : '') + ' · ' + by;
  }
  if (kind === 'cover') return '글 가리기 (금지어) · ' + name;
  if (kind === 'perm') {
    const to = pick(d, ['to', 'state']);
    const perm = pick(d, ['perm', 'mt']);
    let granted = d.granted;
    if (granted === undefined && to !== undefined) granted = to === 'active';
    if (granted === undefined && perm !== undefined) granted = (Number(perm) & 5) !== 0;
    return granted ? '부방장 지정 감지' : '부방장 해제 감지';
  }
  if (kind === 'wave') {
    const n = pick(d, ['n', 'count']);
    return '올킥 감지' + (n !== undefined ? ' · ' + n + '명' : '');
  }
  if (kind === 'state') {
    const st = pick(d, ['state', 'to', 'event']);
    const code = pick(d, ['code', 'error_code']);
    if (st === 'error' || (code && st !== 'active')) return '오류(' + shortErr(code) + ')';
    if (st === 'retry' || st === 'queued') return 'K bot 입장 다시 시도';
    return 'K bot 입장 완료';
  }
  if (kind === 'skip') {
    const what = pick(d, ['what', 'action', 'kind']);
    return (SKIP_WHY[pick(d, ['note'])] || 'K bot 한도 초과로 건너뜀') + (what ? ' · ' + (SKIP_WHAT[what] || what) : '');
  }
  return String(kind || '');
}

function roomLogRow(r) {
  return {
    at: Number(r.at),
    kind: r.kind,
    user_id: r.user_id || null,
    name: r.name || null,
    ok: r.ok !== false,
    text: roomLogText(r),
  };
}

router.get('/panel/api/bot-room/logs', wrap(async (req, res) => {
  const s = await session(req, res);
  if (!s) return;
  const got = await roomFor(res, s.member.id, req.query.id);
  if (!got) return;
  const roombot = !!got.row.roombot;
  let up = sender.up();
  let visit = [];
  let profile = [];
  let guard = [];
  if (roombot && up) {
    try {
      const r = await senderCall('GET', '/v1/bot/logs?install_id=' + got.id, null, 15000);
      if (r.json && r.json.ok) {
        visit = logList(r.json.visit);
        profile = logList(r.json.profile);
        guard = logList(r.json.guard);
      }
    } catch (e) {
      up = false;
    }
  }
  // 방 관리봇이 없으면 남의 방 구성원 기록(입장·내보내기 등)을 내보내지 않는다(8.11). 상태·권한 줄만.
  const r = await db.q(
    `SELECT at, kind, user_id, name, ok, detail FROM room_log
      WHERE install_id=$1 AND kind NOT IN ('join','leave')
        AND ($2::boolean OR kind IN ('state','perm'))
      ORDER BY at DESC, id DESC LIMIT 100`,
    [got.id, roombot]);
  res.set('Cache-Control', 'no-store');
  res.json({ ok: true, visit: visit, profile: profile, guard: guard, actions: r.rows.map(roomLogRow), sender_up: up });
}));

router.get('/panel/api/bot-room/people', wrap(async (req, res) => {
  const s = await session(req, res);
  if (!s) return;
  const got = await roomFor(res, s.member.id, req.query.id);
  if (!got) return;
  if (!roombotGate(res, got)) return;
  if (!sender.up()) return senderDown(res);
  const r = await senderCall('GET', '/v1/bot/people?install_id=' + got.id, null, 20000);
  if (!r.json.ok) return botError(res, r.json);
  res.set('Cache-Control', 'no-store');
  res.json({ ok: true, people: Array.isArray(r.json.people) ? r.json.people : [] });
}));

router.post('/panel/api/bot-room/hide', wrap(async (req, res) => {
  const s = await session(req, res);
  if (!s) return;
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const got = await roomFor(res, s.member.id, body.id);
  if (!got) return;
  if (!roombotGate(res, got)) return;
  const hasLast = body.last !== undefined && body.last !== null && body.last !== '';
  const hasUser = body.user_id !== undefined && body.user_id !== null && body.user_id !== '';
  if (hasLast === hasUser) return fail(res, 400, 'bad_target', TEXT.hide_target);
  const call = { install_id: got.id, by: 'panel' };
  if (hasLast) {
    const n = typeof body.last === 'number' ? body.last : (/^\d{1,4}$/.test(String(body.last)) ? Number(body.last) : NaN);
    if (!Number.isInteger(n) || n < 1 || n > 300) return fail(res, 400, 'bad_last', TEXT.hide_last);
    call.last = n;
  } else {
    const uid = String(body.user_id).trim();
    if (!/^[1-9][0-9]{0,19}$/.test(uid)) return fail(res, 400, 'bad_user', TEXT.bad_user);
    call.user_id = uid;
  }
  if (!sender.up()) return senderDown(res);
  const r = await senderCall('POST', '/v1/bot/hide', call, 20000);
  if (!r.json.ok) {
    if (r.json.error === 'cooldown') {
      const at = Number(r.json.retry_at) || Date.now() + 600000;
      return fail(res, 429, 'hide_cooldown',
        '글 가리기는 방마다 10분에 한 번 할 수 있습니다. ' + hhmm(at) + ' 이후에 다시 시도해 주세요.', { retry_at: at });
    }
    return botError(res, r.json);
  }
  nudge(got.id);
  res.json({ ok: true, job: r.json.job });
}));

router.get('/panel/api/bot-room/hide', wrap(async (req, res) => {
  const s = await session(req, res);
  if (!s) return;
  const got = await roomFor(res, s.member.id, req.query.id);
  if (!got) return;
  if (!got.row.roombot) return fail(res, 403, 'no_roombot', ROOM_TEXT.no_roombot);
  const job = String(req.query.job || '');
  if (!/^[A-Za-z0-9_.:-]{1,64}$/.test(job)) return fail(res, 404, 'not_found', TEXT.no_job);
  if (!sender.up()) return senderDown(res);
  const r = await senderCall('GET', '/v1/bot/hide?job=' + encodeURIComponent(job) + '&install_id=' + got.id, null, 10000);
  if (!r.json.ok) return fail(res, 404, 'not_found', TEXT.no_job);
  res.set('Cache-Control', 'no-store');
  res.json({
    ok: true,
    state: r.json.state === 'done' ? 'done' : 'running',
    total: Number(r.json.total) || 0,
    done: Number(r.json.done) || 0,
    failed: Number(r.json.failed) || 0,
  });
}));

router.post('/panel/api/bot-room/unkick', wrap(async (req, res) => {
  const s = await session(req, res);
  if (!s) return;
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const got = await roomFor(res, s.member.id, body.id);
  if (!got) return;
  if (!roombotGate(res, got)) return;
  const uid = String(body.user_id === undefined || body.user_id === null ? '' : body.user_id).trim();
  if (!/^[1-9][0-9]{0,19}$/.test(uid)) return fail(res, 404, 'not_kicked', TEXT.not_kicked);
  if (!sender.up()) return senderDown(res);
  const r = await senderCall('POST', '/v1/bot/unkick', { install_id: got.id, user_id: uid }, 20000);
  if (!r.json.ok) return botError(res, r.json, { failed: TEXT.unkick_failed });
  nudge(got.id);
  res.json({ ok: true });
}));

router.post('/panel/api/bot-room/games-reset', wrap(async (req, res) => {
  const s = await session(req, res);
  if (!s) return;
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const got = await roomFor(res, s.member.id, body.id);
  if (!got) return;
  if (!got.row.minigame) return fail(res, 403, 'no_minigame', ROOM_TEXT.no_minigame);
  if (!sender.up()) return senderDown(res);
  const r = await senderCall('POST', '/v1/bot/games-reset', { install_id: got.id }, 15000);
  if (!r.json.ok) return botError(res, r.json);
  nudge(got.id);
  res.json({ ok: true });
}));

module.exports = router;
// 다른 라우트(키 이관 /api/auth/claim, 관리자 room-transfer·license-reassign)가 콘솔 계정 임시 저장을 비울 때 쓴다.
module.exports.forgetAccounts = forgetAccounts;
module.exports.roomLogText = roomLogText;
module.exports.hhmm = hhmm;
