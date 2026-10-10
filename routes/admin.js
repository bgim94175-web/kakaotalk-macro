// 관리자 API — 헤더 x-admin-password 로 보호. 관리자 화면(/manage)이 이걸 부른다(docs/ACCOUNTS_V1.md 3.5).
//   주문 승인·취소 / 입금 매칭 / 회원 / K bot 계정 / 설치한 방 / 예전 라이선스 키 / 감사 기록.
// 다른 작업의 모듈은 9.2 의 인터페이스로만 부른다(installs·entitle·member-auth·keys).
// 응답: 성공 {ok:true, …}, 실패 {ok:false, reason, error}. error 는 관리 화면에 그대로 보이는 한국어다.
// 참여코드 평문·봇 계정 비밀번호는 어떤 응답에도 넣지 않는다(8.6·8.11).
'use strict';

const express = require('express');
const crypto = require('crypto');
const db = require('../lib/db');
const keys = require('../lib/keys');
const features = require('../lib/features');
const audit = require('../lib/audit');
const pricing = require('../lib/pricing');
const rl = require('../lib/ratelimit');
const ids = require('../lib/panel-ids');
const authText = require('../lib/auth-text');
const sender = require('../lib/sender-child');
const memberAuth = require('../lib/member-auth');
const entitle = require('../lib/entitle');
const installs = require('../lib/installs');

const router = express.Router();

const BOT_PENDING_MS = 15 * 60 * 1000;          // 봇 등록 휴대폰 확인 대기(콘솔과 같은 15분)
const BOT_CONFIRM_TIMEOUT_MS = 20000;           // /v1/register/confirm 호출 제한(3.5)
const ROOM_LIST_MAX = 500;
const LOG_LIMIT = 100;

const TEXT = {
  not_ready: '아직 준비 중인 기능입니다. 잠시 뒤 다시 시도해 주세요.',
  sender_down: '발송 서버가 멈춰 있습니다. 잠시 뒤 다시 시도해 주세요.',
  no_member: '회원을 찾을 수 없습니다.',
  no_room: '방을 찾을 수 없습니다.',
  no_order: '주문을 찾을 수 없습니다.',
  no_bot: 'K bot 계정을 찾을 수 없습니다.',
  bad_bot_id: 'K bot 계정 ID가 아닙니다.',
  member_key: '회원 주문에는 키를 지정할 수 없습니다.',
  claimed_key: '회원에게 등록된 키입니다. 회원 상세에서 기간을 조정해 주세요.',
  already_matched: '이미 주문과 연결된 입금입니다.',
  bot_busy: '이 K bot 계정이 들어가 있는 방을 다른 K bot 계정으로 옮긴 뒤 다시 시도해 주세요.',
  bot_exists: '이미 등록된 K bot 계정입니다. 그 계정의 [재등록]을 눌러 주세요.',
  bad_profile: '이 K bot 계정의 오픈프로필 목록에 없는 항목입니다. [오픈프로필 다시 읽기]를 누른 뒤 다시 골라 주세요.',
  bad_profile_url: 'open.kakao.com/me/로 시작하는 오픈프로필 링크를 넣어 주세요.',
  kakao_down: '카카오 서버에 연결하지 못했습니다.',
  failed: '요청을 처리하지 못했습니다.',
};

// 등록 실패 문구에서 "다른 기기 끊기"를 권하지 않을 카카오 상태(routes/panel.js 와 같은 목록)
const HARD_STATUS = {
  '-111': true, '-328': true, '-997': true, '-101': true, '-102': true,
  '-444': true, '-445': true, '-950': true, '-998': true, '-999': true,
  '8': true, '12': true, '13': true, '30': true, '31': true, '32': true, '99': true,
};

function fail(res, status, reason, error, extra) {
  if (res.headersSent) return;
  res.status(status).json(Object.assign({ ok: false, reason: reason, error: error }, extra || {}));
}

const wrap = (fn) => (req, res) => Promise.resolve(fn(req, res)).catch((e) => {
  if (e && e.code === 'NOT_IMPLEMENTED') return fail(res, 503, 'not_ready', TEXT.not_ready);
  if (e && (e.code === 'sender_down' || e.message === 'timeout')) return fail(res, 503, 'sender_down', TEXT.sender_down);
  if (e && e.code === 'busy') return fail(res, 503, 'busy', e.publicError || '요청이 많아 처리하지 못했습니다. 잠시 뒤 다시 시도해 주세요.');
  console.error('[' + req.method + ' ' + req.originalUrl + '] ' + (e && e.stack ? e.stack : e));
  if (!res.headersSent) res.status(500).json({ ok: false, error: 'server_error' });
});

function clamp(v, lo, hi, dflt) {
  const n = Math.floor(Number(v));
  if (!isFinite(n)) return dflt;
  return Math.min(Math.max(n, lo), hi);
}

function toId(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(String(v).trim().replace(/^#/, ''));
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

function num(v) { return v === null || v === undefined ? null : Number(v); }
function str(v) { return v === null || v === undefined ? '' : String(v).trim(); }

function later(label, fn) {
  Promise.resolve().then(fn).catch((e) => console.error('[admin] ' + label + ' 실패: ' + (e && e.message ? e.message : e)));
}

// 공개된 기본값 — 이 값이 그대로 들어있으면 비밀번호가 없는 것과 같다
const DEFAULT_PW = 'change-me-now';

// 관리자 API 를 열어도 되는 상태인지. 문제가 있으면 사람이 읽을 사유를 돌려준다.
function passwordProblem() {
  const raw = process.env.ADMIN_PASSWORD;
  const pw = (raw === null || raw === undefined) ? '' : String(raw);
  if (!pw.trim()) return 'ADMIN_PASSWORD 환경변수가 비어 있습니다';
  if (pw === DEFAULT_PW) return 'ADMIN_PASSWORD 가 공개된 기본값(' + DEFAULT_PW + ') 으로 설정되어 있습니다';
  return null;
}

// 비밀번호 비교. 길이가 달라도 같은 시간이 걸리게 sha256 을 떠서 비교한다
// (예전 구현은 길이가 다르면 즉시 false 라서 응답시간으로 길이를 알아낼 수 있었다).
function pwOk(given) {
  if (passwordProblem()) return false;
  const want = String(process.env.ADMIN_PASSWORD);
  const g = crypto.createHash('sha256').update(String(given === null || given === undefined ? '' : given), 'utf8').digest();
  const w = crypto.createHash('sha256').update(want, 'utf8').digest();
  try { return crypto.timingSafeEqual(g, w); } catch (e) { return false; }
}

let warnedProblem = '';

async function guard(req, res, next) {
  // ── 비밀번호가 없거나 기본값이면 관리자 API 를 통째로 닫는다 (503)
  const problem = passwordProblem();
  if (problem) {
    if (warnedProblem !== problem) {
      warnedProblem = problem;
      console.error('[admin] ★ 관리자 API 전체를 503 으로 막았어 — ' + problem +
                    ' / ADMIN_PASSWORD 를 제대로 설정하고 다시 배포해라');
    }
    return res.status(503).json({ ok: false, error: 'admin_disabled',
      reason: 'admin_password_unset',
      detail: '서버에 관리자 비밀번호가 설정되지 않아 관리자 API를 막았습니다. ' +
              '서버 환경변수 ADMIN_PASSWORD를 설정한 뒤 다시 배포해 주세요.' });
  }
  warnedProblem = '';

  const ip = rl.ipOf(req);

  // ── 연속 실패로 차단된 IP (server.js 에서도 막지만, 라우터 단독 사용도 대비한다)
  const left = rl.adminBlockedMs(ip);
  if (left > 0) {
    const mins = Math.ceil(left / 60000);
    res.set('Retry-After', String(Math.ceil(left / 1000)));
    return res.status(429).json({ ok: false, error: 'too_many_attempts',
      detail: '비밀번호 입력 실패 횟수를 넘었습니다. ' + mins + '분 뒤 다시 시도해 주세요.' });
  }

  // ── 인증 실패는 기록한다 (관리자 화면 [기록] 탭에서 공격을 눈으로 볼 수 있게)
  if (!pwOk(req.header('x-admin-password'))) {
    const st = rl.noteAdminFail(ip);
    console.log('[admin] 비밀번호 틀림 ' + ip + ' ' + req.method + ' ' + req.path +
                ' (' + st.fails + '회' + (st.blocked ? ' → ' + Math.round(st.blockMs / 60000) + '분 차단' : '') + ')');
    await audit.record(req, 'bad_admin_pw', {
      detail: '관리자 비밀번호 틀림 ' + req.method + ' ' + req.path + ' / 연속 ' + st.fails + '회' +
              (st.blocked ? ' → ' + Math.round(st.blockMs / 60000) + '분 차단' : ''),
    });
    if (st.blocked) {
      res.set('Retry-After', String(Math.ceil(st.blockMs / 1000)));
      return res.status(429).json({ ok: false, error: 'too_many_attempts',
        detail: '비밀번호 입력 실패 횟수를 넘었습니다. ' + Math.round(st.blockMs / 60000) + '분 뒤 다시 시도해 주세요.' });
    }
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }

  // 성공 → 실패 카운터 리셋. 조회까지 전부 서버 로그에 남겨서 유출에 흔적이 남게 한다.
  rl.clearAdminFails(ip);
  console.log('[admin] ' + req.method + ' ' + req.path + ' ip=' + ip);
  res.set('Cache-Control', 'no-store');
  next();
}

// guard 는 async 다 → 에러를 삼키지 않고 express 에러 핸들러로 넘긴다
router.use('/admin', (req, res, next) => Promise.resolve(guard(req, res, next)).catch(next));

// ─────────────────────────────────────────────────────────────
// 공통 도구
// ─────────────────────────────────────────────────────────────

// 회원 찾기: 번호(7, '#7') 또는 아이디(대소문자 무시). → members 행 | null
async function findMember(idOrLogin, client) {
  const id = toId(idOrLogin);
  if (id) {
    const row = await db.one('SELECT * FROM members WHERE id=$1', [id], client);
    if (row) return row;
  }
  const login = str(idOrLogin).toLowerCase();
  if (!login || login.length > 40) return null;
  return db.one('SELECT * FROM members WHERE lower(login_id)=$1', [login], client);
}

// body 의 member_id(번호) 또는 login_id(아이디)로 회원을 고른다. → {id, login_id} | {status, error}
async function memberFromBody(b) {
  const raw = b.member_id;
  if (raw !== null && raw !== undefined && raw !== '') {
    const m = await findMember(raw);
    return m ? { id: Number(m.id), login_id: m.login_id } : { status: 404, error: TEXT.no_member };
  }
  if (str(b.login_id)) {
    const m = await findMember(b.login_id);
    return m ? { id: Number(m.id), login_id: m.login_id }
      : { status: 404, error: '아이디가 「' + str(b.login_id).slice(0, 40) + '」인 회원을 찾을 수 없습니다.' };
  }
  return { status: 400, error: '회원 아이디를 입력해 주세요.' };
}

async function loginsOf(memberIds) {
  const list = Array.from(new Set((memberIds || []).map(toId).filter(Boolean)));
  if (!list.length) return new Map();
  const r = await db.q('SELECT id, login_id FROM members WHERE id = ANY($1::bigint[])', [list]);
  return new Map(r.rows.map((x) => [Number(x.id), x.login_id]));
}

// 콘솔(routes/panel.js)의 회원별 카카오 계정 메모리 저장(60초)을 지운다(키 옮기기·방 넘기기 뒤).
function consoleForget(memberId) {
  if (!memberId) return;
  try {
    const panel = require('./panel');
    if (panel && typeof panel.forgetAccounts === 'function') panel.forgetAccounts(memberId);
  } catch (e) { /* 콘솔 라우터가 없으면 60초 뒤 저절로 새로 읽는다 */ }
}

function pushLater(memberId) {
  if (!memberId) return;
  later('권리 밀기 member=' + memberId, () => entitle.pushGrants(memberId));
}

// "KAKA-AB12-CD34-EF56" → "KAKA-****-****-EF56"
function maskKey(k) {
  const s = String(k || '');
  const m = /^([A-Z]+)-([A-Z0-9]{4})-([A-Z0-9]{4})-([A-Z0-9]{4})$/.exec(s);
  if (!m) return s.length > 4 ? '****' + s.slice(-4) : '****';
  return m[1] + '-****-****-' + m[4];
}

// 로그인 기기 요약(UA) — "Windows · Chrome"
function uaSummary(ua) {
  const s = String(ua || '');
  if (!s) return '알 수 없는 기기';
  let os = '기타';
  if (/iPhone|iPad|iPod/.test(s)) os = 'iOS';
  else if (/Android/.test(s)) os = 'Android';
  else if (/Windows/.test(s)) os = 'Windows';
  else if (/Mac OS X|Macintosh/.test(s)) os = 'macOS';
  else if (/Linux/.test(s)) os = 'Linux';
  let br = '브라우저';
  if (/KAKAOTALK/i.test(s)) br = '카카오톡';
  else if (/Edg\//.test(s)) br = 'Edge';
  else if (/SamsungBrowser/.test(s)) br = 'Samsung Internet';
  else if (/Whale\//.test(s)) br = 'Whale';
  else if (/Firefox\//.test(s)) br = 'Firefox';
  else if (/Chrome\//.test(s)) br = 'Chrome';
  else if (/Safari\//.test(s)) br = 'Safari';
  return os + ' · ' + br;
}

function maskIp(ip) {
  const s = String(ip || '');
  if (!s) return null;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(s)) return s.replace(/\.\d+$/, '.*');
  const parts = s.split(':');
  if (parts.length > 2) return parts.slice(0, 3).join(':') + ':*';
  return s;
}

// ── sender 상태(/v1/bot/status). 요약 숫자가 30초마다 부르므로 5초 메모리에 둔다.
let botStatusMemo = { at: 0, val: null };
async function senderBotStatus() {
  if (!sender.up()) return null;
  if (Date.now() - botStatusMemo.at < 5000) return botStatusMemo.val;
  let val = null;
  try {
    const r = await sender.call('GET', '/v1/bot/status', null, 4000);
    if (r && r.status === 200 && r.json && r.json.ok) val = r.json;
  } catch (e) { val = null; }
  botStatusMemo = { at: Date.now(), val: val };
  return val;
}
function forgetBotStatus() { botStatusMemo = { at: 0, val: null }; }

// 주문이 가리키는 처리 대기(pending·paid) 상품 → Map(install_id → {roombot, minigame})
async function pendingMap(installIds) {
  const list = (installIds || []).map(toId).filter(Boolean).map(String);
  const out = new Map();
  if (!list.length) return out;
  const r = await db.q(
    `SELECT it->>'install_id' AS iid, it->>'product' AS p
       FROM orders o,
            jsonb_array_elements(CASE WHEN jsonb_typeof(o.items) = 'array' THEN o.items ELSE '[]'::jsonb END) it
      WHERE o.status IN ('pending','paid')
        AND it->>'install_id' = ANY($1::text[])
        AND it->>'product' IN ('roombot','minigame')`, [list]);
  for (const row of r.rows) {
    const id = Number(row.iid);
    const cur = out.get(id) || { roombot: false, minigame: false };
    cur[row.p] = true;
    out.set(id, cur);
  }
  return out;
}

// bot_nickname = 방장에게 보일 봇 이름(그 방에서 읽은 이름 → 오픈프로필 이름 → 닉네임, installs.BOT_NAME_SQL, D12)
const ROOM_SELECT = `
  SELECT r.*, ` + installs.BOT_NAME_SQL + ` AS bot_nickname, b.label AS bot_label, b.email AS bot_email,
         m.login_id AS member_login, o.token AS order_token
    FROM room_installs r
    LEFT JOIN bot_accounts b ON b.device_id = r.bot_device_id` + installs.BOT_NAME_JOIN + `
    LEFT JOIN members m ON m.id = r.member_id
    LEFT JOIN orders o ON o.id = r.order_id`;

// room_installs 행 → 관리 화면 모양 = RoomView(3.4.2) + 관리 칸(3.5). 참여코드는 있는지만 알린다.
function adminRoomView(row, pend, base) {
  const order = row.order_id && row.order_token
    ? { id: row.order_id, token: row.order_token, url: base + '/order/' + row.order_id + '?t=' + row.order_token }
    : null;
  const v = installs.publicView(row, { nickname: row.bot_nickname || null }, pend || null, order);
  return Object.assign({}, v, {
    phase: row.phase,
    state: row.state || null,
    raw_error_code: row.error_code || null,
    member: { id: Number(row.member_id), login_id: row.member_login || null },
    bot_device_id: row.bot_device_id || null,
    bot_label: row.bot_label || null,
    bot_nickname: row.bot_nickname || null,
    error_detail: row.error_detail || null,
    attempts: Number(row.attempts) || 0,
    next_try_at: num(row.next_try_at),
    retry_n: Number(row.retry_n) || 0,
    retry_at: num(row.retry_at),
    hold_reason: row.hold_reason || null,
    link_id: row.link_id || null,
    chat_id: row.chat_id || null,
    order_id: row.order_id || null,
    has_passcode: !!row.passcode_ct,
    created_at: num(row.created_at),
    installed_at: num(row.installed_at),
    removed_at: num(row.removed_at),
    note: row.note || null,
  });
}

async function roomViews(rows, req) {
  const pend = await pendingMap(rows.map((r) => r.id));
  const base = features.purchaseBase(req);
  // 들어가 있는 방에서 봇이 어떤 프로필로 보이는지(open|main|other|failed|unknown, D12). sender 상태는 5초 메모리.
  const prof = new Map();
  if (rows.length) {
    const st = await senderBotStatus();
    if (st && Array.isArray(st.rooms)) for (const x of st.rooms) if (x && x.profile) prof.set(Number(x.install_id), String(x.profile));
  }
  return rows.map((row) => Object.assign(adminRoomView(row, pend.get(Number(row.id)), base),
    { bot_profile: prof.get(Number(row.id)) || null }));
}

async function roomById(id, req) {
  const rid = toId(id);
  if (!rid) return null;
  const row = await db.one(ROOM_SELECT + ' WHERE r.id=$1', [rid]);
  if (!row) return null;
  return (await roomViews([row], req))[0];
}

// installs.* 관리자 함수 결과 → 응답. 성공이면 갱신된 방 모양을 붙인다(DB 행·봉인값은 내보내지 않는다).
async function sendInstallResult(req, res, r, roomId, keep) {
  if (!r || !r.ok) {
    const st = (r && Number(r.status)) || 400;
    return fail(res, st, (r && r.reason) || 'failed', (r && r.error) || TEXT.failed);
  }
  const out = { ok: true };
  (keep || []).forEach((k) => { if (r[k] !== undefined) out[k] = r[k]; });
  if (roomId) out.room = await roomById(roomId, req);
  res.json(out);
}

// bot_accounts.open_profiles(JSONB) → [{li,name,url}] | null(읽은 적 없음)
function profileListOf(v) {
  const x = db.jsonOf(v);
  if (!Array.isArray(x)) return null;
  return x.filter((p) => p && /^[1-9][0-9]*$/.test(String(p.li || '')))
    .map((p) => ({ li: String(p.li), name: str(p.name), url: str(p.url) || null }));
}

// ok | none(오픈프로필 없음) | gone(고른 오픈프로필이 사라짐) | unknown(아직 읽지 못함). sender 가 살아 있으면 그 판정을 쓴다.
function profileStateOf(row, live) {
  if (live && live.open_profile_state) return String(live.open_profile_state);
  const list = profileListOf(row.open_profiles);
  if (!list) return 'unknown';
  if (!list.length) return 'none';
  if (row.open_profile_pick && !list.some((p) => p.li === String(row.open_profile_pick))) return 'gone';
  return 'ok';
}

// 방장에게 보일 이름 = 오픈프로필 이름(없으면 카카오톡 닉네임)
function roomNameOf(row) { return str(row.open_profile_name) || str(row.nickname); }

function shapeBot(row, live, dupSet) {
  const nick = str(row.nickname);
  const list = (live && Array.isArray(live.open_profiles) ? live.open_profiles.map((p) => ({ li: String(p.li), name: str(p.name), url: str(p.url) || null }))
    : null) || profileListOf(row.open_profiles);
  const state = profileStateOf(row, live);
  let prof = null;
  if (live && live.open_profile && live.open_profile.li) {
    prof = { li: String(live.open_profile.li), name: str(live.open_profile.name), url: str(live.open_profile.url) || null };
  } else if (state === 'ok' && row.open_profile_li) {
    const hit = (list || []).find((p) => p.li === String(row.open_profile_li));
    prof = { li: String(row.open_profile_li), name: str(row.open_profile_name), url: hit ? hit.url : null };
  }
  const roomName = (prof && prof.name) || roomNameOf(row);
  return {
    device_id: row.device_id,
    email: row.email || null,
    label: row.label || null,
    nickname: nick || null,
    room_name: roomName || null,
    // 방장이 구분할 이름(오픈프로필 이름)이 다른 봇과 겹침(D12)
    nickname_dup: !!(roomName && dupSet && dupSet.has(roomName.toLowerCase())),
    open_profile: prof,
    open_profiles: list,
    open_profile_pick: row.open_profile_pick || null,
    open_profile_state: state,
    open_profile_at: num(row.open_profile_at),
    profile_rooms: live && live.profile_rooms ? live.profile_rooms : null,
    profile_convert: live && live.profile_convert ? live.profile_convert : null,
    room_cap: Number(row.room_cap) || 0,
    enabled: row.enabled !== false,
    state: row.state || 'pending',
    state_at: num(row.state_at),
    created_at: num(row.created_at),
    note: row.note || null,
    rooms_n: Number(row.rooms_n) || 0,
    leaves_n: Number(row.leaves_n) || 0,
    live: live ? { connected: !!live.connected, rooms: live.rooms === undefined ? null : Number(live.rooms) || 0,
                   budget: live.budget || null } : null,
  };
}

// 방장에게 보일 이름(오픈프로필 이름, 없으면 닉네임)이 겹치는 봇(대소문자·앞뒤 공백 무시, D12)
function dupNicknames(rows) {
  const seen = new Map();
  for (const r of rows) {
    const n = roomNameOf(r).toLowerCase();
    if (!n) continue;
    seen.set(n, (seen.get(n) || 0) + 1);
  }
  const dup = new Set();
  for (const [n, c] of seen) if (c > 1) dup.add(n);
  return dup;
}

async function botRows(where, params) {
  return (await db.q(
    `SELECT b.*,
            (SELECT count(*) FROM room_installs r WHERE r.bot_device_id = b.device_id AND r.phase = 'installed')::int AS rooms_n,
            (SELECT count(*) FROM room_leaves l WHERE l.bot_device_id = b.device_id AND l.done_at IS NULL)::int AS leaves_n
       FROM bot_accounts b
      WHERE b.removed_at IS NULL` + (where ? ' AND ' + where : '') + `
      ORDER BY b.created_at ASC, b.device_id ASC`, params || [])).rows;
}

async function allBotsShaped() {
  const rows = await botRows();
  const st = await senderBotStatus();
  const live = new Map();
  if (st && Array.isArray(st.bots)) for (const b of st.bots) if (b && b.device_id) live.set(String(b.device_id), b);
  const dup = dupNicknames(rows);
  return { bots: rows.map((r) => shapeBot(r, live.get(r.device_id), dup)), status: st };
}

// 여러 키의 entitlements 를 한 번에 붙여준다
async function attachFeatures(shaped) {
  if (!shaped.length) return shaped;
  const list = shaped.map((x) => x.key);
  const r = await db.q(
    'SELECT key,feature,plan,starts_at,duration_ms,expires_at,created_at FROM entitlements WHERE key = ANY($1::text[]) ORDER BY feature',
    [list]);
  const byKey = {};
  for (const row of r.rows) {
    if (!byKey[row.key]) byKey[row.key] = [];
    byKey[row.key].push(db.shapeEnt(row));
  }
  for (const x of shaped) x.features = byKey[x.key] || [];
  return shaped;
}

// 회원에게 이관된 키(D19)면 회원 정보를 붙인다
async function attachClaims(rows, shaped) {
  const logins = await loginsOf(rows.map((r) => r.member_id));
  shaped.forEach((x, i) => {
    const mid = toId(rows[i].member_id);
    x.member_id = mid;
    x.claimed_at = num(rows[i].claimed_at);
    x.member = mid ? { id: mid, login_id: logins.get(mid) || null } : null;
  });
  return shaped;
}

// 키가 회원에게 이관됐는지(트랜잭션 안이면 잠근다)
async function claimedMember(key, client) {
  const row = await db.one('SELECT member_id FROM licenses WHERE key=$1' + (client ? ' FOR UPDATE' : ''), [key], client);
  return row ? toId(row.member_id) : null;
}

// ─────────────────────────────────────────────────────────────
// 키 발급 / 연장 (예전 키 경로 — 관리자 지원용으로 남긴다. 이관된 키에는 409)
// ─────────────────────────────────────────────────────────────
router.post('/admin/create', wrap(async (req, res) => {
  const b = req.body || {};
  const feats = features.normList(b.features);
  if (!feats.length) return res.json({ ok: false, error: '기능을 1개 이상 선택해 주세요 (macro/roombot/minigame)' });
  const plan = String(b.plan || 'month');
  const dur = keys.durationMs(plan, b.days);
  if (!dur) return res.json({ ok: false, error: '플랜(month/quarter/year/custom) 또는 days 값이 올바르지 않습니다' });

  const out = await db.tx((client) => keys.createLicenses(client, {
    features: feats, plan: plan, days: b.days, count: b.count,
    note: b.note, owner_name: b.owner_name, owner_contact: b.owner_contact,
  }));

  res.json({ ok: true, keys: out.keys, features: out.features, plan: plan,
             duration_days: out.duration_days });
}));

router.post('/admin/grant', wrap(async (req, res) => {
  const b = req.body || {};
  const key = keys.normKey(b.key);
  if (!key) return res.json({ ok: false, error: 'key 값이 필요합니다' });
  const feats = features.normList(b.features);
  if (!feats.length) return res.json({ ok: false, error: '기능을 1개 이상 선택해 주세요' });
  const plan = String(b.plan || 'month');
  if (!keys.durationMs(plan, b.days)) return res.json({ ok: false, error: '플랜 또는 days 값이 올바르지 않습니다' });

  const out = await db.tx(async (client) => {
    const mid = await claimedMember(key, client);
    if (mid) return { claimed: mid };
    return keys.grant(client, key, feats, plan, b.days);
  });
  if (out && out.claimed) return fail(res, 409, 'claimed', TEXT.claimed_key, { member_id: out.claimed });
  if (!out) return res.json({ ok: false, error: '등록되지 않은 키입니다' });
  res.json({ ok: true, key: key, plan: plan, duration_days: out.duration_days,
             changed: out.changed, activated: out.activated });
}));

router.post('/admin/revoke-feature', wrap(async (req, res) => {
  const b = req.body || {};
  const key = keys.normKey(b.key);
  const feature = String(b.feature || '').trim().toLowerCase();
  if (!key || !features.isValid(feature)) return res.json({ ok: false, error: 'key / feature 값을 확인해 주세요' });

  const out = await db.tx(async (client) => {
    const mid = await claimedMember(key, client);
    if (mid) return { claimed: mid };
    const r = await db.q('DELETE FROM entitlements WHERE key=$1 AND feature=$2', [key, feature], client);
    if (r.rowCount > 0) await db.syncSummary(key, client);
    return { removed: r.rowCount };
  });
  if (out.claimed) return fail(res, 409, 'claimed', TEXT.claimed_key, { member_id: out.claimed });
  res.json({ ok: out.removed > 0, key: key, feature: feature, removed: out.removed });
}));

// 잘못 이관된 키를 다른 회원으로 옮긴다(D19). member_id=null 이면 이관 취소.
router.post('/admin/license-reassign', wrap(async (req, res) => {
  const b = req.body || {};
  const key = keys.normKey(b.key);
  if (!key) return fail(res, 400, 'bad_key', '키를 입력해 주세요.');
  let to = null;
  const wantsNull = (b.member_id === null || b.member_id === '') && !str(b.login_id);
  if (!wantsNull) {
    const m = await memberFromBody(b);
    if (m.error) return fail(res, m.status || 404, 'no_member', m.error);
    to = m.id;
  }
  const out = await db.tx((client) => entitle.reassignKey(client, key, to, { req: req }));
  if (!out || !out.ok) {
    const msg = (out && out.error) || TEXT.failed;
    return fail(res, /찾을 수 없습니다/.test(msg) ? 404 : 409, 'reassign_failed', msg);
  }
  const from = toId(out.from);
  const dest = toId(out.to);
  // 이전 회원의 세션은 reassignKey 가 같은 트랜잭션에서 끝냈다. 여기서는 세션 메모리 저장을 지운다.
  if (from) await memberAuth.endAllSessions(from, { why: 'admin' });
  consoleForget(from);
  consoleForget(dest);
  pushLater(from);
  pushLater(dest);
  res.json({ ok: true, key: key, from: from, to: dest, accounts: Number(out.accounts) || 0 });
}));

// ─────────────────────────────────────────────────────────────
// 조회 (예전 키)
// ─────────────────────────────────────────────────────────────
router.get('/admin/list', wrap(async (req, res) => {
  const term = String(req.query.q || '').trim();
  const limit = clamp(req.query.limit, 1, 500, 100);
  const offset = clamp(req.query.offset, 0, 1000000, 0);

  let where = '';
  const params = [];
  if (term) {
    params.push('%' + term + '%');
    where = ` WHERE key ILIKE $1 OR note ILIKE $1 OR owner_name ILIKE $1
                 OR owner_contact ILIKE $1 OR device_name ILIKE $1 OR device_id ILIKE $1`;
  }
  const cnt = await db.q('SELECT COUNT(*)::int AS n FROM licenses' + where, params);
  const rows = await db.q(
    'SELECT * FROM licenses' + where + ' ORDER BY created_at DESC LIMIT $' +
    (params.length + 1) + ' OFFSET $' + (params.length + 2),
    params.concat([limit, offset]));

  const shaped = await attachFeatures(rows.rows.map(db.shapeLicense));
  await attachClaims(rows.rows, shaped);
  res.json({ ok: true, now: Date.now(), total: cnt.rows[0].n,
             limit: limit, offset: offset, licenses: shaped });
}));

router.get('/admin/license', wrap(async (req, res) => {
  const key = keys.normKey(req.query.key);
  if (!key) return res.json({ ok: false, error: 'key 값이 필요합니다' });
  const row = await db.one('SELECT * FROM licenses WHERE key=$1', [key]);
  if (!row) return res.json({ ok: false, error: '등록되지 않은 키입니다' });
  const shaped = (await attachFeatures([db.shapeLicense(row)]))[0];
  await attachClaims([row], [shaped]);
  const a = await db.q('SELECT * FROM audit_log WHERE key=$1 ORDER BY at DESC, id DESC LIMIT 20', [key]);
  // configs 는 단종된 사용자앱의 설정 백업이다. 새로 쌓이지 않지만 응답 형태는 그대로 둔다(없으면 null).
  const cfg = await db.one('SELECT rev, updated_at FROM configs WHERE key=$1', [key]);
  res.json({
    ok: true, now: Date.now(), license: shaped,
    audit: a.rows.map(db.shapeAudit),
    config: cfg ? { rev: Number(cfg.rev) || 0, updated_at: Number(cfg.updated_at) || 0 } : null,
  });
}));

router.get('/admin/audit', wrap(async (req, res) => {
  const key = keys.normKey(req.query.key);
  const kind = String(req.query.kind || '').trim().toLowerCase();
  const limit = clamp(req.query.limit, 1, 500, 100);
  const cond = [];
  const params = [];
  if (key) { params.push(key); cond.push('key=$' + params.length); }
  if (kind) { params.push(kind); cond.push('kind=$' + params.length); }
  let member = null;
  if (str(req.query.member)) {
    const m = await findMember(req.query.member);
    if (!m) return res.json({ ok: true, now: Date.now(), kinds: audit.KINDS, alert_kinds: audit.ALERT_KINDS, audit: [], member: null });
    member = { id: Number(m.id), login_id: m.login_id };
    params.push(member.id);
    cond.push('member_id=$' + params.length);
  }
  params.push(limit);
  const r = await db.q(
    'SELECT * FROM audit_log' + (cond.length ? ' WHERE ' + cond.join(' AND ') : '') +
    ' ORDER BY at DESC, id DESC LIMIT $' + params.length, params);
  const shaped = r.rows.map(db.shapeAudit);
  const logins = await loginsOf(shaped.map((a) => a.member_id));
  shaped.forEach((a) => { a.member_login = a.member_id ? logins.get(a.member_id) || null : null; });
  res.json({ ok: true, now: Date.now(), kinds: audit.KINDS, alert_kinds: audit.ALERT_KINDS,
             audit: shaped, member: member });
}));

router.get('/admin/stats', wrap(async (req, res) => {
  const now = Date.now();
  const week = now + 7 * 86400000;

  const total = (await db.q('SELECT COUNT(*)::int AS n FROM licenses')).rows[0].n;
  const active = (await db.q(
    `SELECT COUNT(DISTINCT e.key)::int AS n FROM entitlements e
       JOIN licenses l ON l.key = e.key
      WHERE e.expires_at > $1 AND COALESCE(l.revoked,FALSE)=FALSE AND l.blocked_reason IS NULL`,
    [now])).rows[0].n;
  const expiring = (await db.q(
    `SELECT COUNT(*)::int AS n FROM (
       SELECT e.key, MAX(e.expires_at) AS m FROM entitlements e
         JOIN licenses l ON l.key = e.key
        WHERE COALESCE(l.revoked,FALSE)=FALSE AND l.blocked_reason IS NULL
        GROUP BY e.key) t
      WHERE t.m > $1 AND t.m <= $2`, [now, week])).rows[0].n;
  const byFeat = (await db.q(
    'SELECT feature, COUNT(*)::int AS n FROM entitlements WHERE expires_at > $1 GROUP BY feature', [now])).rows;
  // 입금 대기(pending)와 입금 확인됨·적용 대기(paid, 수동 확인 모드)를 함께 집계한다.
  const pending = (await db.q("SELECT COUNT(*)::int AS n FROM orders WHERE status IN ('pending','paid')")).rows[0].n;
  const paidWaiting = (await db.q("SELECT COUNT(*)::int AS n FROM orders WHERE status='paid'")).rows[0].n;
  const review = (await db.q("SELECT COUNT(*)::int AS n FROM orders WHERE status IN ('pending','paid') AND needs_review")).rows[0].n;
  const revoked = (await db.q('SELECT COUNT(*)::int AS n FROM licenses WHERE COALESCE(revoked,FALSE)=TRUE')).rows[0].n;
  const blocked = (await db.q('SELECT COUNT(*)::int AS n FROM licenses WHERE blocked_reason IS NOT NULL')).rows[0].n;
  const deposits = (await db.q(
    "SELECT COUNT(*)::int AS n FROM deposits WHERE status IN ('unmatched','ambiguous')")).rows[0].n;

  const by_feature = {};
  for (const f of features.ALL) by_feature[f] = 0;
  for (const r of byFeat) if (by_feature[r.feature] !== undefined) by_feature[r.feature] = r.n;

  // ── 회원·방·봇 (3.5)
  const mem = await db.one(
    `SELECT COUNT(*)::int AS n,
            COUNT(*) FILTER (WHERE macro_until > $1)::int AS macro,
            COUNT(*) FILTER (WHERE blocked_reason IS NOT NULL)::int AS blocked
       FROM members`, [now]);
  const rb = await db.q(
    `SELECT CASE WHEN phase = 'pending_payment' THEN 'pending'
                 WHEN hold_reason IS NOT NULL THEN 'joining'
                 WHEN state = 'waiting_host' OR (state = 'active' AND roombot AND COALESCE(perm, 0) & 5 = 0) THEN 'waiting'
                 WHEN state = 'active' THEN 'active'
                 WHEN state = 'error' THEN 'error'
                 ELSE 'joining' END AS d,
            (phase = 'installed' AND hold_reason IS NOT NULL) AS hold,
            COUNT(*)::int AS n
       FROM room_installs WHERE phase IN ('installed','pending_payment')
      GROUP BY 1, 2`);
  const rooms_by_display = { pending: 0, joining: 0, waiting: 0, active: 0, error: 0 };
  let roomsTotal = 0;
  let roomsHold = 0;
  for (const r of rb.rows) {
    rooms_by_display[r.d] = (rooms_by_display[r.d] || 0) + r.n;
    if (r.d !== 'pending') roomsTotal += r.n;
    if (r.hold) roomsHold += r.n;
  }
  const bt = await db.one(
    `SELECT COUNT(*)::int AS total,
            COUNT(*) FILTER (WHERE state = 'connected')::int AS connected,
            COALESCE(SUM(room_cap) FILTER (WHERE enabled), 0)::int AS cap
       FROM bot_accounts WHERE removed_at IS NULL`);
  const used = await db.one(
    `SELECT COUNT(*)::int AS n FROM room_installs r JOIN bot_accounts b ON b.device_id = r.bot_device_id
      WHERE r.phase = 'installed' AND b.removed_at IS NULL`);
  const st = await senderBotStatus();
  let connected = bt.connected;
  if (st && Array.isArray(st.bots)) {
    const ours = new Set((await db.q('SELECT device_id FROM bot_accounts WHERE removed_at IS NULL')).rows.map((x) => x.device_id));
    connected = st.bots.filter((b) => b && b.connected && ours.has(String(b.device_id))).length;
  }
  const paused = st && Number(st.join_paused_until) > now ? Number(st.join_paused_until) : 0;

  res.json({ ok: true, now: now, total: total, active: active, expiring_7d: expiring,
             by_feature: by_feature, pending_orders: pending, paid_orders: paidWaiting, review_orders: review,
             revoked: revoked, blocked: blocked, deposits_attention: deposits,
             members: mem.n, members_blocked: mem.blocked, macro_active: mem.macro,
             rooms_total: roomsTotal, rooms_hold: roomsHold, rooms_by_display: rooms_by_display,
             bots: { total: bt.total, connected: connected, cap: bt.cap, used: used.n },
             sender_up: sender.up(), join_paused_until: paused });
}));

// ─────────────────────────────────────────────────────────────
// 상태 변경 (예전 키)
// ─────────────────────────────────────────────────────────────
router.post('/admin/revoke', wrap(async (req, res) => {
  const b = req.body || {};
  const key = keys.normKey(b.key);
  const revoked = b.revoked === undefined ? true : !!b.revoked;
  if (!key) return res.json({ ok: false, error: 'key 값이 필요합니다' });
  const r = await db.q('UPDATE licenses SET revoked=$1 WHERE key=$2', [revoked, key]);
  if (r.rowCount > 0) {
    await audit.record(req, 'revoked', { key: key, detail: revoked ? '관리자 회수' : '관리자 회수 해제' });
  }
  res.json({ ok: r.rowCount > 0, key: key, revoked: revoked });
}));

router.post('/admin/block', wrap(async (req, res) => {
  const b = req.body || {};
  const key = keys.normKey(b.key);
  if (!key) return res.json({ ok: false, error: 'key 값이 필요합니다' });
  const reason = (b.reason === null || b.reason === undefined || String(b.reason).trim() === '')
    ? null : String(b.reason).trim().slice(0, 500);
  const r = await db.q('UPDATE licenses SET blocked_reason=$1 WHERE key=$2', [reason, key]);
  if (r.rowCount > 0) {
    await audit.record(req, 'revoked', { key: key, detail: reason ? '차단: ' + reason : '차단 해제' });
  }
  res.json({ ok: r.rowCount > 0, key: key, blocked_reason: reason });
}));

router.post('/admin/delete', wrap(async (req, res) => {
  const key = keys.normKey((req.body || {}).key);
  if (!key) return res.json({ ok: false, error: 'key 값이 필요합니다' });
  const removed = await db.tx(async (client) => {
    await db.q('DELETE FROM configs WHERE key=$1', [key], client);   // 예전 앱 설정 백업이 남아 있으면 같이 지운다
    const r = await db.q('DELETE FROM licenses WHERE key=$1', [key], client); // entitlements 는 CASCADE
    return r.rowCount;
  });
  if (removed > 0) await audit.record(req, 'revoked', { key: key, detail: '관리자 키 삭제' });
  res.json({ ok: removed > 0, key: key });
}));

// ─────────────────────────────────────────────────────────────
// 주문
// ─────────────────────────────────────────────────────────────
async function shapeOrders(rows) {
  const shaped = rows.map(db.shapeOrder);
  const logins = await loginsOf(shaped.map((o) => o.member_id));
  shaped.forEach((o) => {
    o.member = o.member_id ? { id: o.member_id, login_id: logins.get(o.member_id) || null } : null;
  });
  return shaped;
}

router.get('/admin/orders', wrap(async (req, res) => {
  const status = String(req.query.status || '').trim().toLowerCase();
  const limit = clamp(req.query.limit, 1, 500, 200);
  const params = [];
  const cond = [];
  if (status) { params.push(status); cond.push('status=$' + params.length); }
  if (str(req.query.member)) {
    const m = await findMember(req.query.member);
    params.push(m ? Number(m.id) : -1);
    cond.push('member_id=$' + params.length);
  }
  params.push(limit);
  const r = await db.q(
    'SELECT * FROM orders' + (cond.length ? ' WHERE ' + cond.join(' AND ') : '') +
    ' ORDER BY created_at DESC LIMIT $' + params.length, params);
  res.json({ ok: true, now: Date.now(), bank: pricing.bankInfo(), orders: await shapeOrders(r.rows) });
}));

// 승인이 같은 방 충돌(room_taken)로 멈췄을 때 화면에 보일 목록과 환불 금액
function conflictBody(out) {
  const list = (Array.isArray(out.conflicts) ? out.conflicts : []).map((c) => ({
    install_id: toId(c.install_id),
    link_name: c.link_name || null,
    link_url: c.link_url || null,
    products: Array.isArray(c.products) ? c.products : [],
    amount: Number(c.amount) || 0,
    why: c.why || 'room_taken',
  }));
  return { conflicts: list, refund: list.reduce((a, c) => a + c.amount, 0) };
}

function refundOf(applied) {
  const sk = applied && Array.isArray(applied.skipped) ? applied.skipped : [];
  return sk.reduce((a, c) => a + (Number(c && c.amount) || 0), 0);
}

function appliedText(out) {
  const a = out.applied || {};
  const parts = [];
  if (a.macro && a.macro.days) parts.push('매크로 ' + a.macro.days + '일');
  if (Array.isArray(a.rooms) && a.rooms.length) parts.push('방 ' + a.rooms.map((x) => '#' + x.install_id).join(','));
  if (Array.isArray(a.skipped) && a.skipped.length) {
    parts.push('제외 ' + a.skipped.map((x) => '#' + x.install_id).join(',') + ' 환불 ' + refundOf(a) + '원');
  }
  if (a.legacy_to_member) parts.push('이관 키 → 회원');
  return parts.join(' / ');
}

router.post('/admin/order-approve', wrap(async (req, res) => {
  const b = req.body || {};
  const id = keys.normOrderId(b.id);
  if (!id) return fail(res, 400, 'bad_id', '주문번호가 필요합니다.');
  const askedKey = keys.normKey(b.key);
  const skip = b.skip_conflicts === true;

  const pre = await db.one('SELECT id, member_id, status FROM orders WHERE id=$1', [id]);
  if (!pre) return fail(res, 404, 'not_found', TEXT.no_order);
  const isMember = pre.member_id !== null && pre.member_id !== undefined;
  if (isMember && askedKey) return fail(res, 400, 'member_order_key', TEXT.member_key);

  // 자동 입금확인(POST /api/deposit-hook)과 **같은 로직**을 쓴다
  const out = await db.tx((client) => keys.approveOrder(client, id, askedKey, skip ? { skipConflicts: true } : undefined));

  if (out.error) {
    if (out.reason === 'room_taken') return fail(res, 400, 'room_taken', out.error, conflictBody(out));
    return fail(res, 409, 'not_applied', out.error);
  }
  entitle.afterApprove(out);    // 커밋 뒤, 기다리지 않는다
  const mid = toId(out.member_id);
  const logins = await loginsOf([mid]);
  if (!out.already) {
    await audit.record(req, 'order', { key: out.key || null, member_id: mid,
      detail: '주문 승인 ' + id + (mid ? ' / 회원 ' + (logins.get(mid) || mid) + ' / ' + appliedText(out)
        : ' / ' + (out.issued ? '신규발급' : '기존키 연장') + ' / 기능=' + (out.features || []).join(',') + ' / 플랜=' + out.plan) });
  }
  res.json({ ok: true, id: id, kind: isMember ? 'member' : null, key: out.key || null, issued: !!out.issued,
             already: !!out.already, member_id: mid, member: mid ? { id: mid, login_id: logins.get(mid) || null } : null,
             applied: out.applied || null, refund: refundOf(out.applied) });
}));

router.post('/admin/order-cancel', wrap(async (req, res) => {
  const b = req.body || {};
  const id = keys.normOrderId(b.id);
  if (!id) return res.json({ ok: false, error: 'id 값이 필요합니다' });
  const memo = b.memo === null || b.memo === undefined ? null : String(b.memo).trim().slice(0, 500);
  const now = Date.now();
  const out = await db.tx(async (client) => {
    const r = await db.q(
      `UPDATE orders SET status='canceled', handled_at=$1::bigint,
              memo = CASE WHEN $2::text IS NULL THEN memo
                          ELSE COALESCE(memo || ' / ', '') || $2::text END
        WHERE id=$3 AND status <> 'done' RETURNING member_id`, [now, memo, id], client);
    if (!r.rowCount) return { n: 0 };
    const rooms = await installs.cancelForOrder(client, id);
    await audit.record(req, 'order', { member_id: toId(r.rows[0].member_id),
      detail: '주문 취소 ' + id + (rooms ? ' / 입금 대기 방 ' + rooms + '개 취소' : '') + (memo ? ' / ' + memo : '') }, client);
    return { n: r.rowCount, rooms: rooms };
  });
  res.json({ ok: out.n > 0, id: id, canceled_rooms: out.rooms || 0 });
}));

// ─────────────────────────────────────────────────────────────
// 입금 내역 (자동 입금확인)
// ─────────────────────────────────────────────────────────────
router.get('/admin/deposits', wrap(async (req, res) => {
  const status = String(req.query.status || '').trim().toLowerCase();
  const limit = clamp(req.query.limit, 1, 500, 100);
  const params = [];
  let where = '';
  if (status) { params.push(status); where = ' WHERE status=$1'; }
  params.push(limit);
  const r = await db.q(
    'SELECT * FROM deposits' + where + ' ORDER BY at DESC, id DESC LIMIT $' + params.length, params);
  const pend = await db.q(
    "SELECT COUNT(*)::int AS n FROM deposits WHERE status IN ('unmatched','ambiguous')");
  res.json({
    ok: true, now: Date.now(),
    hook_enabled: !!String(process.env.DEPOSIT_TOKEN || '').trim(),
    auto_approve: String(process.env.DEPOSIT_AUTO_APPROVE || '1') !== '0',
    needs_attention: pend.rows[0].n,
    deposits: r.rows.map(db.shapeDeposit),
  });
}));

// 수동 매칭 → 주문 승인까지 한 트랜잭션. 이미 매칭된 입금(matched·duplicate)은 409.
// ambiguous 입금의 matched_order 는 "후보 주문"이라 매칭을 막지 않는다(routes/purchase.js 가 후보를 거기 적는다).
router.post('/admin/deposit-match', wrap(async (req, res) => {
  const b = req.body || {};
  const depositId = Math.floor(Number(b.deposit_id));
  const orderId = keys.normOrderId(b.order_id);
  if (!isFinite(depositId) || depositId <= 0) return fail(res, 400, 'bad_deposit', '입금 기록 번호(deposit_id)가 필요합니다.');
  if (!orderId) return fail(res, 400, 'bad_order', '주문번호(order_id)가 필요합니다.');
  const skip = b.skip_conflicts === true;

  const out = await db.tx(async (client) => {
    const dep = await db.one('SELECT * FROM deposits WHERE id=$1 FOR UPDATE', [depositId], client);
    if (!dep) return { fail: [404, 'not_found', '입금 기록을 찾을 수 없습니다.'] };
    if (dep.status === 'matched' || dep.status === 'duplicate') return { fail: [409, 'already_matched', TEXT.already_matched] };
    const ord = await db.one('SELECT id FROM orders WHERE id=$1', [orderId], client);
    if (!ord) return { fail: [404, 'not_found', TEXT.no_order] };
    const r = await keys.approveOrder(client, orderId, null, skip ? { skipConflicts: true } : undefined);
    if (r.error) return { approve: r };
    await db.q("UPDATE deposits SET status='matched', matched_order=$1 WHERE id=$2", [orderId, depositId], client);
    return { r: r, dep: dep };
  });
  if (out.fail) return fail(res, out.fail[0], out.fail[1], out.fail[2]);
  if (out.approve) {
    if (out.approve.reason === 'room_taken') return fail(res, 400, 'room_taken', out.approve.error, conflictBody(out.approve));
    return fail(res, 409, 'not_applied', out.approve.error);
  }
  const r = out.r;
  entitle.afterApprove(r);
  const mid = toId(r.member_id);
  if (!r.already) {
    await audit.record(req, 'order', { key: r.key || null, member_id: mid,
      detail: '수동 입금 매칭 승인 주문=' + orderId + ' 입금기록=' + depositId +
              ' 입금자=' + (out.dep.name || '미상') + (mid ? ' / ' + appliedText(r) : '') });
  }
  const logins = await loginsOf([mid]);
  res.json({ ok: true, deposit_id: depositId, order_id: orderId, key: r.key || null, already: !!r.already,
             member_id: mid, member: mid ? { id: mid, login_id: logins.get(mid) || null } : null,
             applied: r.applied || null, refund: refundOf(r.applied) });
}));

router.post('/admin/deposit-ignore', wrap(async (req, res) => {
  const depositId = Math.floor(Number((req.body || {}).deposit_id));
  if (!isFinite(depositId) || depositId <= 0) return res.json({ ok: false, error: 'deposit_id 값이 필요합니다' });
  const r = await db.q("UPDATE deposits SET status='ignored' WHERE id=$1 AND status <> 'matched'", [depositId]);
  res.json({ ok: r.rowCount > 0, deposit_id: depositId });
}));

// ─────────────────────────────────────────────────────────────
// 회원 (3.5)
// ─────────────────────────────────────────────────────────────
const MEMBER_LIST_SQL = `
  SELECT m.id, m.login_id, m.contact, m.created_at, m.last_login_at, m.macro_until, m.legacy_room_until,
         m.blocked_reason, m.note,
         (g.member_id IS NOT NULL) AS google_linked,
         (SELECT count(*) FROM panel_accounts pa WHERE pa.member_id = m.id)::int AS accounts_n,
         (SELECT count(*) FROM room_installs r WHERE r.member_id = m.id AND r.phase IN ('installed','pending_payment'))::int AS rooms_n,
         (SELECT count(*) FROM room_installs r WHERE r.member_id = m.id AND r.phase = 'installed' AND r.roombot)::int AS roombot_n,
         (SELECT count(*) FROM room_installs r WHERE r.member_id = m.id AND r.phase = 'installed' AND r.minigame)::int AS minigame_n,
         (SELECT count(*) FROM member_sessions s WHERE s.member_id = m.id AND s.revoked_at IS NULL AND s.expires_at > $1)::int AS sessions_n
    FROM members m
    LEFT JOIN member_google g ON g.member_id = m.id`;

function shapeMemberRow(r) {
  return {
    id: Number(r.id),
    login_id: r.login_id,
    contact: r.contact || null,
    created_at: num(r.created_at),
    last_login_at: num(r.last_login_at),
    macro_until: Number(r.macro_until) || 0,
    legacy_room_until: Number(r.legacy_room_until) || 0,
    blocked_reason: r.blocked_reason || null,
    note: r.note || null,
    google_linked: !!r.google_linked,
    accounts_n: Number(r.accounts_n) || 0,
    rooms_n: Number(r.rooms_n) || 0,
    roombot_n: Number(r.roombot_n) || 0,
    minigame_n: Number(r.minigame_n) || 0,
    sessions_n: Number(r.sessions_n) || 0,
  };
}

function likeEsc(s) { return String(s).replace(/[\\%_]/g, (c) => '\\' + c); }

// 채널톡 memberId('m' + 24hex, 6.10 7)로 회원 찾기 — 서버가 회원마다 계산해 비교한다
async function membersByChannelId(cid) {
  const want = String(cid).toLowerCase();
  if (!memberAuth.channelMemberId(1)) return [];          // CHANNEL_MEMBER_SECRET 없음
  const r = await db.q('SELECT id FROM members ORDER BY id');
  const hit = [];
  for (const row of r.rows) {
    if (String(memberAuth.channelMemberId(Number(row.id)) || '').toLowerCase() === want) hit.push(Number(row.id));
  }
  return hit;
}

router.get('/admin/members', wrap(async (req, res) => {
  const q = str(req.query.q).slice(0, 80);
  const limit = clamp(req.query.limit, 1, 500, 100);
  const now = Date.now();
  const params = [now];
  let where = '';
  if (q) {
    if (/^m[0-9a-f]{24}$/i.test(q)) {
      params.push(await membersByChannelId(q));
      where = ' WHERE m.id = ANY($2::bigint[])';
    } else {
      params.push('%' + likeEsc(q) + '%');
      where = ' WHERE (m.login_id ILIKE $2 OR m.contact ILIKE $2 OR m.note ILIKE $2';
      const id = toId(q);
      if (id) { params.push(id); where += ' OR m.id = $3'; }
      where += ')';
    }
  }
  if (req.query.blocked === '1') where += (where ? ' AND' : ' WHERE') + ' m.blocked_reason IS NOT NULL';
  if (req.query.macro === '1') where += (where ? ' AND' : ' WHERE') + ' m.macro_until > $1';
  params.push(limit);
  const r = await db.q(MEMBER_LIST_SQL.replace('SELECT m.id,', 'SELECT count(*) OVER () AS total_n, m.id,') + where +
    ' ORDER BY m.created_at DESC, m.id DESC LIMIT $' + params.length, params);
  const total = r.rows.length ? Number(r.rows[0].total_n) || 0 : 0;
  res.json({ ok: true, now: now, total: total, members: r.rows.map(shapeMemberRow) });
}));

router.get('/admin/member', wrap(async (req, res) => {
  const m = await findMember(req.query.id);
  if (!m) return fail(res, 404, 'not_found', TEXT.no_member);
  const id = Number(m.id);
  const now = Date.now();
  const listRow = await db.one(MEMBER_LIST_SQL + ' WHERE m.id = $2', [now, id]);
  const g = await db.one('SELECT email, linked_at FROM member_google WHERE member_id=$1', [id]);
  const sess = await db.q(
    `SELECT id, method, created_at, auth_at, last_seen_at, expires_at, revoked_at, revoked_why, ip, ua
       FROM member_sessions WHERE member_id=$1
      ORDER BY (revoked_at IS NULL AND expires_at > $2) DESC, last_seen_at DESC LIMIT 20`, [id, now]);
  const acc = await db.q(
    `SELECT pa.device_id, pa.email, pa.license_key, pa.created_at
       FROM panel_accounts pa WHERE pa.member_id=$1 ORDER BY pa.created_at`, [id]);
  const rooms = await db.q(ROOM_SELECT + ' WHERE r.member_id=$1 ORDER BY r.id DESC LIMIT 200', [id]);
  const orders = await db.q('SELECT * FROM orders WHERE member_id=$1 ORDER BY created_at DESC LIMIT 50', [id]);
  const lic = await db.q('SELECT key, claimed_at FROM licenses WHERE member_id=$1 ORDER BY claimed_at DESC NULLS LAST', [id]);
  const licenses = [];
  for (const l of lic.rows) {
    const a = await db.one(
      `SELECT ip, at FROM audit_log WHERE kind='member' AND key=$1
        ORDER BY (detail LIKE 'claim %') DESC, at DESC LIMIT 1`, [l.key]);
    licenses.push({ key: maskKey(l.key), key_ref: l.key, claimed_at: num(l.claimed_at),
                    claim_ip: a ? a.ip || null : null });
  }
  const au = await db.q('SELECT * FROM audit_log WHERE member_id=$1 ORDER BY at DESC, id DESC LIMIT 50', [id]);
  const member = Object.assign(shapeMemberRow(listRow), {
    pw_changed_at: num(m.pw_changed_at),
    macro: entitle.macroView(m, now),
    channel_member_id: memberAuth.channelMemberId(id),
  });
  res.json({
    ok: true, now: now, member: member,
    google: g ? { email: g.email || null, linked_at: num(g.linked_at) } : null,
    sessions: sess.rows.map((s) => ({
      sid: String(s.id).slice(0, 16), method: s.method, created_at: num(s.created_at), auth_at: num(s.auth_at),
      last_seen_at: num(s.last_seen_at), expires_at: num(s.expires_at), revoked_at: num(s.revoked_at),
      revoked_why: s.revoked_why || null, active: !s.revoked_at && Number(s.expires_at) > now,
      device: uaSummary(s.ua), ip: maskIp(s.ip),
    })),
    accounts: acc.rows.map((a) => ({ device_id: a.device_id, email: a.email, created_at: num(a.created_at),
                                     legacy_key: a.license_key ? maskKey(a.license_key) : null })),
    rooms: await roomViews(rooms.rows, req),
    orders: await shapeOrders(orders.rows),
    licenses: licenses,
    audit: au.rows.map(db.shapeAudit),
  });
}));

router.post('/admin/member-grant', wrap(async (req, res) => {
  const b = req.body || {};
  const id = toId(b.id);
  const days = Math.floor(Number(b.macro_days));
  if (!id) return fail(res, 404, 'not_found', TEXT.no_member);
  if (!Number.isFinite(days) || days < 1 || days > 3650 || String(b.macro_days).indexOf('.') >= 0) {
    return fail(res, 400, 'bad_days', '기간은 1~3650일로 입력해 주세요.');
  }
  const until = await db.tx(async (client) => {
    const u = await entitle.extendMacro(client, id, days);
    if (u === null || u === undefined) return null;
    await audit.record(req, 'member', { member_id: id, detail: 'grant 매크로 +' + days + '일 → 만료 ' + new Date(u).toISOString() }, client);
    return u;
  });
  if (until === null) return fail(res, 404, 'not_found', TEXT.no_member);
  pushLater(id);
  res.json({ ok: true, id: id, macro_until: Number(until), macro: entitle.macroView({ macro_until: until }) });
}));

router.post('/admin/member-block', wrap(async (req, res) => {
  const b = req.body || {};
  const id = toId(b.id);
  if (!id) return fail(res, 404, 'not_found', TEXT.no_member);
  const raw = b.reason === null || b.reason === undefined ? '' : String(b.reason).trim();
  if (raw.length > 200) return fail(res, 400, 'bad_reason', '차단 사유는 200자 이하로 입력해 주세요.');
  const reason = raw || null;
  const row = await db.tx(async (client) => {
    const r = await db.one('UPDATE members SET blocked_reason=$2 WHERE id=$1 RETURNING id, login_id', [id, reason], client);
    if (!r) return null;
    await audit.record(req, 'member', { member_id: id, detail: reason ? 'block 차단: ' + reason : 'unblock 차단 해제' }, client);
    return r;
  });
  if (!row) return fail(res, 404, 'not_found', TEXT.no_member);
  let ended = 0;
  if (reason) ended = await memberAuth.endAllSessions(id, { why: 'admin' });
  pushLater(id);
  later('nudgeMember ' + id, () => installs.nudgeMember(id));
  res.json({ ok: true, id: id, blocked_reason: reason, ended: Number(ended) || 0 });
}));

router.post('/admin/member-logout', wrap(async (req, res) => {
  const id = toId((req.body || {}).id);
  if (!id) return fail(res, 404, 'not_found', TEXT.no_member);
  const m = await db.one('SELECT id FROM members WHERE id=$1', [id]);
  if (!m) return fail(res, 404, 'not_found', TEXT.no_member);
  const ended = await memberAuth.endAllSessions(id, { why: 'admin' });
  await audit.record(req, 'member', { member_id: id, detail: 'logout_all 관리자 / 세션 ' + ended + '개 종료' });
  res.json({ ok: true, id: id, ended: Number(ended) || 0 });
}));

// 임시 비밀번호 12자(헷갈리는 글자 0·O·1·l·I 제외, 영문·숫자 섞음)
const TEMP_ALPHA = 'abcdefghjkmnpqrstuvwxyz';
const TEMP_DIGIT = '23456789';
function tempPassword(loginId) {
  for (let tries = 0; tries < 20; tries++) {
    const all = TEMP_ALPHA + TEMP_ALPHA.toUpperCase() + TEMP_DIGIT;
    const chars = [];
    chars.push(TEMP_ALPHA[crypto.randomInt(TEMP_ALPHA.length)]);
    chars.push(TEMP_ALPHA.toUpperCase()[crypto.randomInt(TEMP_ALPHA.length)]);
    chars.push(TEMP_DIGIT[crypto.randomInt(TEMP_DIGIT.length)]);
    chars.push(TEMP_DIGIT[crypto.randomInt(TEMP_DIGIT.length)]);
    while (chars.length < 12) chars.push(all[crypto.randomInt(all.length)]);
    for (let i = chars.length - 1; i > 0; i--) {
      const j = crypto.randomInt(i + 1);
      const t = chars[i]; chars[i] = chars[j]; chars[j] = t;
    }
    const pw = chars.join('');
    let problem = null;
    try { problem = memberAuth.passwordProblem(pw, loginId); } catch (e) { problem = null; }
    if (!problem) return pw;
  }
  throw new Error('임시 비밀번호를 만들지 못했습니다');
}

router.post('/admin/member-pwreset', wrap(async (req, res) => {
  const id = toId((req.body || {}).id);
  if (!id) return fail(res, 404, 'not_found', TEXT.no_member);
  const m = await db.one('SELECT id, login_id FROM members WHERE id=$1', [id]);
  if (!m) return fail(res, 404, 'not_found', TEXT.no_member);
  const pw = tempPassword(m.login_id);
  const hash = await memberAuth.hashPassword(pw);
  await db.tx(async (client) => {
    await db.q('UPDATE members SET pw_hash=$2, pw_changed_at=$3 WHERE id=$1', [id, hash, Date.now()], client);
    await audit.record(req, 'member', { member_id: id, detail: 'pw_reset_admin 임시 비밀번호 발급' }, client);
  });
  const ended = await memberAuth.endAllSessions(id, { why: 'admin' });
  res.set('Cache-Control', 'no-store');
  res.json({ ok: true, id: id, login_id: m.login_id, temp_password: pw, ended: Number(ended) || 0 });
}));

// ─────────────────────────────────────────────────────────────
// 설치한 방 (3.5)
// ─────────────────────────────────────────────────────────────
// 화면 필터 → SQL 조건. 기본('')은 살아 있는 설치(installed·pending_payment).
const ROOM_FILTERS = {
  '': "r.phase IN ('installed','pending_payment')",
  live: "r.phase IN ('installed','pending_payment')",
  pending: "r.phase = 'pending_payment'",
  joining: "r.phase = 'installed' AND (r.hold_reason IS NOT NULL OR r.state IN ('queued','joining'))",
  hold: "r.phase = 'installed' AND r.hold_reason IS NOT NULL",
  // installs.displayOf 와 같게: 방 관리봇이 있는데 perm & 5 가 아니면 사용 중이 아니라 부방장 대기(0.1)
  waiting: "r.phase = 'installed' AND r.hold_reason IS NULL AND (r.state = 'waiting_host' OR (r.state = 'active' AND r.roombot AND COALESCE(r.perm, 0) & 5 = 0))",
  active: "r.phase = 'installed' AND r.hold_reason IS NULL AND r.state = 'active' AND NOT (r.roombot AND COALESCE(r.perm, 0) & 5 = 0)",
  error: "r.phase = 'installed' AND r.hold_reason IS NULL AND r.state = 'error'",
  attention: "r.phase = 'installed' AND r.hold_reason IS NULL AND r.state = 'error'",
  removed: "r.phase = 'removed'",
  canceled: "r.phase = 'canceled'",
  all: 'TRUE',
};

router.get('/admin/rooms', wrap(async (req, res) => {
  const display = str(req.query.display).toLowerCase();
  if (!Object.prototype.hasOwnProperty.call(ROOM_FILTERS, display)) return fail(res, 400, 'bad_display', '알 수 없는 필터입니다.');
  const limit = clamp(req.query.limit, 1, ROOM_LIST_MAX, 300);
  const params = [];
  const cond = [ROOM_FILTERS[display]];
  const q = str(req.query.q).slice(0, 200);
  if (q) {
    params.push('%' + likeEsc(q) + '%');
    let c = '(r.link_name ILIKE $' + params.length + ' OR r.link_url ILIKE $' + params.length +
            ' OR m.login_id ILIKE $' + params.length;
    const id = toId(q);
    if (/^#?\d+$/.test(q)) {
      params.push(String(q).replace(/^#/, ''));
      c += ' OR r.link_id = $' + params.length;
      if (id) { params.push(id); c += ' OR r.id = $' + params.length; }
    }
    cond.push(c + ')');
  }
  if (str(req.query.bot)) { params.push(str(req.query.bot)); cond.push('r.bot_device_id = $' + params.length); }
  if (str(req.query.member)) {
    const m = await findMember(req.query.member);
    params.push(m ? Number(m.id) : -1);
    cond.push('r.member_id = $' + params.length);
  }
  params.push(limit);
  const rows = await db.q(ROOM_SELECT + ' WHERE ' + cond.join(' AND ') +
    ' ORDER BY r.id DESC LIMIT $' + params.length, params);
  const counts = await db.one(
    `SELECT COUNT(*) FILTER (WHERE ` + ROOM_FILTERS[''].replace(/r\./g, '') + `)::int AS live,
            COUNT(*) FILTER (WHERE ` + ROOM_FILTERS.attention.replace(/r\./g, '') + `)::int AS attention,
            COUNT(*) FILTER (WHERE ` + ROOM_FILTERS.hold.replace(/r\./g, '') + `)::int AS hold,
            COUNT(*) FILTER (WHERE ` + ROOM_FILTERS.waiting.replace(/r\./g, '') + `)::int AS waiting,
            COUNT(*) FILTER (WHERE ` + ROOM_FILTERS.active.replace(/r\./g, '') + `)::int AS active,
            COUNT(*) FILTER (WHERE ` + ROOM_FILTERS.pending.replace(/r\./g, '') + `)::int AS pending,
            COUNT(*) FILTER (WHERE ` + ROOM_FILTERS.joining.replace(/r\./g, '') + `)::int AS joining
       FROM room_installs`);
  res.json({ ok: true, now: Date.now(), rooms: await roomViews(rows.rows, req), counts: counts });
}));

router.get('/admin/room', wrap(async (req, res) => {
  const view = await roomById(req.query.id, req);
  if (!view) return fail(res, 404, 'not_found', TEXT.no_room);
  const raw = await db.one('SELECT config, config_rev, config_at FROM room_installs WHERE id=$1', [view.id]);
  const log = await db.q(
    'SELECT id, at, kind, user_id, name, ok, detail FROM room_log WHERE install_id=$1 ORDER BY at DESC, id DESC LIMIT $2',
    [view.id, LOG_LIMIT]);
  const leaves = await db.q(
    `SELECT id, bot_device_id, chat_id, link_id, why, created_at, done_at, result FROM room_leaves
      WHERE install_id=$1 AND done_at IS NULL ORDER BY id`, [view.id]);
  let live = null;
  if (sender.up() && view.phase === 'installed') {
    try {
      const r = await sender.call('GET', '/v1/bot/room?install_id=' + encodeURIComponent(String(view.id)), null, 4000);
      if (r && r.status === 200 && r.json && r.json.ok) live = r.json.live || null;
    } catch (e) { live = null; }
  }
  res.json({
    ok: true, now: Date.now(), room: view,
    config: db.jsonOf(raw && raw.config) || {}, config_rev: raw ? Number(raw.config_rev) || 0 : 0,
    config_at: raw ? num(raw.config_at) : null,
    log: log.rows.map((x) => {
      const d = db.jsonOf(x.detail) || {};
      return { id: Number(x.id), at: num(x.at), kind: x.kind, user_id: x.user_id || null, name: x.name || null,
               ok: x.ok !== false, detail: d, text: logText(x.kind, x.name || x.user_id, d, x.ok !== false) };
    }),
    leaves: leaves.rows.map((l) => ({ id: Number(l.id), bot_device_id: l.bot_device_id, chat_id: l.chat_id || null,
      link_id: l.link_id || null, why: l.why, created_at: num(l.created_at), result: l.result || null })),
    live: live, sender_up: sender.up(),
  });
}));

// room_log 한 줄(7.8 표). 관리 화면은 원본 detail 도 함께 보인다.
const KICK_WHY = { churn: '들낙', leave: '퇴장', leaveKick: '퇴장', promo: '홍보', manual: '수동', panel: '수동', rejoin: '퇴장' };
// 건너뛴 동작·까닭(routes/panel.js 의 roomLogText 와 같은 말). note 가 없으면 K bot 자체 한도를 넘은 것이다.
const SKIP_WHAT = { send: '발송', notice: '발송', reply: '발송', kick: '내보내기', hide: '글 가리기', rewrite: '글 가리기' };
const SKIP_WHY = { wave: '올킥 감지 중이라 건너뜀', paused: '실패가 이어져 잠시 멈춤', stale: '늦어져서 건너뜀' };
function logText(kind, who, d, ok) {
  const name = who || '알 수 없음';
  switch (kind) {
    case 'join': return '입장 · ' + name;
    case 'leave': return '퇴장 · ' + name;
    case 'churn': return '들낙 감지 · ' + name + (d.windowMin !== undefined ? ' ' + d.windowMin + '분' : '') +
      (d.joins !== undefined ? ' ' + d.joins + '회' : '') + ' · ' + (d.action === 'kick' ? (ok ? '내보내기' : '내보내기 실패') : '경고');
    case 'kick': return '내보내기 · ' + name + (KICK_WHY[d.why || d.reason] ? ' · ' + KICK_WHY[d.why || d.reason] : '');
    case 'kick_fail': return '내보내기 실패 · ' + name + (KICK_WHY[d.why || d.reason] ? ' · ' + KICK_WHY[d.why || d.reason] : '');
    case 'unkick': return '내보내기 해제 · ' + name;
    case 'promo': return '홍보 금지 · ' + name + (d.n !== undefined ? ' · 경고 ' + d.n + '회' : '');
    case 'hide': return '글 가리기 · ' + (Number(d.n || d.done || d.count) || 0) + '개' +
      (Number(d.failed) ? ' (실패 ' + Number(d.failed) + '개)' : '') + ' · ' + (d.by === 'panel' ? '패널' : '방장');
    case 'cover': return '금지어 가림 · ' + name;
    case 'perm': return (d.granted === true || d.to === 'active' || (Number(d.perm) & 5)) ? '부방장 지정 감지' : '부방장 해제 감지';
    case 'wave': return '올킥 감지' + (d.n !== undefined ? ' · ' + d.n + '명' : '');
    case 'state': {
      const code = d.code || d.error_code;
      const st = d.state || d.to || d.event;
      if (st === 'error' || (code && st !== 'active')) {
        const e = installs.ERRORS && installs.ERRORS[code];
        return '오류(' + ((e && e.short) || code || '확인 필요') + ')';
      }
      if (st === 'retry' || st === 'queued') return 'K bot 입장 다시 시도';
      return 'K bot 입장 완료';
    }
    case 'skip': return (SKIP_WHY[d.note] || 'K bot 한도 초과로 건너뜀') + (d.what || d.action ? ' · ' + (SKIP_WHAT[d.what || d.action] || d.what || d.action) : '');
    default: return String(kind || '');
  }
}

router.post('/admin/room-grant', wrap(async (req, res) => {
  const b = req.body || {};
  const m = await memberFromBody(b);
  if (m.error) return fail(res, m.status || 404, 'no_member', m.error);
  const prods = [];
  if (b.roombot === true) prods.push('roombot');
  if (b.minigame === true) prods.push('minigame');
  if (!prods.length) return fail(res, 400, 'no_products', '설치할 봇을 1개 이상 골라 주세요.');
  const passcode = b.passcode === null || b.passcode === undefined ? '' : String(b.passcode);
  const r = await installs.grantRoom(m.id, str(b.link), passcode, prods, { req: req });
  await sendInstallResult(req, res, r, r && r.ok ? r.install_id : null, ['install_id', 'added', 'verified']);
}));

router.post('/admin/room-retry', wrap(async (req, res) => {
  const id = toId((req.body || {}).id);
  if (!id) return fail(res, 404, 'not_found', TEXT.no_room);
  const r = await installs.retry(id, { admin: true, req: req });
  await sendInstallResult(req, res, r, id);
}));

router.post('/admin/room-move', wrap(async (req, res) => {
  const b = req.body || {};
  const id = toId(b.id);
  if (!id) return fail(res, 404, 'not_found', TEXT.no_room);
  let bot = null;
  if (b.bot_device_id !== null && b.bot_device_id !== undefined && b.bot_device_id !== '') {
    bot = str(b.bot_device_id);
    if (!ids.isBotId(bot)) return fail(res, 400, 'bad_bot_id', TEXT.bad_bot_id);
  }
  const r = await installs.move(id, bot, { req: req });
  await sendInstallResult(req, res, r, id, ['from', 'to']);
}));

router.post('/admin/room-remove', wrap(async (req, res) => {
  const id = toId((req.body || {}).id);
  if (!id) return fail(res, 404, 'not_found', TEXT.no_room);
  const r = await installs.remove(id, { req: req });
  await sendInstallResult(req, res, r, id);
}));

router.post('/admin/room-rebind', wrap(async (req, res) => {
  const b = req.body || {};
  const id = toId(b.id);
  if (!id) return fail(res, 404, 'not_found', TEXT.no_room);
  const r = await installs.rebind(id, str(b.link), { req: req });
  await sendInstallResult(req, res, r, id, ['verified']);
}));

router.post('/admin/room-transfer', wrap(async (req, res) => {
  const b = req.body || {};
  const id = toId(b.id);
  if (!id) return fail(res, 404, 'not_found', TEXT.no_room);
  const m = await memberFromBody(b);
  if (m.error) return fail(res, m.status || 404, 'no_member', m.error);
  const r = await installs.transfer(id, m.id, { req: req });
  if (r && r.ok) {
    consoleForget(toId(r.from));
    consoleForget(m.id);
  }
  await sendInstallResult(req, res, r, id, ['from', 'to']);
}));

router.post('/admin/room-products', wrap(async (req, res) => {
  const b = req.body || {};
  const id = toId(b.id);
  if (!id) return fail(res, 404, 'not_found', TEXT.no_room);
  const r = await installs.setProducts(id, { roombot: b.roombot === true, minigame: b.minigame === true }, { req: req });
  await sendInstallResult(req, res, r, id);
}));

router.post('/admin/room-block', wrap(async (req, res) => {
  const b = req.body || {};
  const id = toId(b.id);
  const reason = str(b.reason);
  if (!reason || reason.length > 200) return fail(res, 400, 'bad_reason', '차단 사유를 1~200자로 입력해 주세요.');
  if (!id && !str(b.link)) return fail(res, 400, 'bad_link', '차단할 방(방 번호 또는 링크)을 지정해 주세요.');
  const r = await installs.block({ installId: id || null, link: id ? null : str(b.link), reason: reason }, { req: req });
  await sendInstallResult(req, res, r, id || null, ['block_id', 'link_url', 'link_id', 'removed']);
}));

router.post('/admin/room-unblock', wrap(async (req, res) => {
  const blockId = toId((req.body || {}).block_id);
  if (!blockId) return fail(res, 404, 'not_found', '차단 목록에 없는 항목입니다.');
  const r = await installs.unblock(blockId, { req: req });
  await sendInstallResult(req, res, r, null);
}));

router.get('/admin/room-blocks', wrap(async (req, res) => {
  const r = await db.q('SELECT id, link_id, link_url, reason, created_at FROM room_blocklist ORDER BY created_at DESC, id DESC LIMIT 500');
  res.json({ ok: true, now: Date.now(), blocks: r.rows.map((x) => ({
    id: Number(x.id), link_id: x.link_id || null, link_url: x.link_url || null, reason: x.reason, created_at: num(x.created_at),
  })) });
}));

router.post('/admin/room-release', wrap(async (req, res) => {
  const id = toId((req.body || {}).id);
  if (!id) return fail(res, 404, 'not_found', TEXT.no_room);
  const r = await installs.release(id, { req: req });
  await sendInstallResult(req, res, r, id, ['bot']);
}));

// ─────────────────────────────────────────────────────────────
// K bot 계정 (3.5, D11·D12·D17)
// ─────────────────────────────────────────────────────────────
router.get('/admin/bots', wrap(async (req, res) => {
  const out = await allBotsShaped();
  const st = out.status;
  const now = Date.now();
  res.json({ ok: true, now: now, bots: out.bots, sender_up: sender.up(),
             join_paused_until: st && Number(st.join_paused_until) > now ? Number(st.join_paused_until) : 0,
             default_cap: botCapDefault() });
}));

function botCapDefault() {
  const n = Math.floor(Number(process.env.BOT_ROOM_CAP));
  return Number.isFinite(n) && n >= 1 && n <= 200 ? n : 20;
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

function cleanLabel(v) {
  const s = str(v).replace(/[\u0000-\u001f]/g, '');
  return s ? s.slice(0, 40) : null;
}

function capOf(v) {
  if (v === null || v === undefined || v === '') return { cap: null };
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1 || n > 200) return { error: '최대 방 수는 1~200개로 입력해 주세요.' };
  return { cap: n };
}

// 콘솔의 publicLogin 과 같은 모양(routes/panel.js)
function publicLogin(out) {
  const src = out || {};
  const view = {
    state: src.state || 'failed',
    passcode: src.passcode || '',
    remaining_seconds: src.remaining_seconds == null ? null : src.remaining_seconds,
    pending_id: src.pending_id || '',
    status: typeof src.status === 'number' ? src.status : null,
    text: authText.customerText(src),
    can_force: !!src.can_force && !(src.status != null && HARD_STATUS[String(src.status)]),
  };
  if (view.state === 'ok' || view.state === 'waiting' || view.state === 'confirm_on_phone') view.text = '';
  return view;
}

// 등록이 끝난 봇을 bot_accounts 에 넣거나 고친다. state·nickname 은 sender 칸이라 쓰지 않는다(2.2).
async function upsertBot(deviceId, email, label, cap) {
  await db.q(
    `INSERT INTO bot_accounts (device_id, email, label, room_cap, enabled, created_at)
     VALUES ($1, $2, $3, COALESCE($4::int, $5::int), TRUE, $6)
     ON CONFLICT (device_id) DO UPDATE
        SET email = EXCLUDED.email,
            label = COALESCE($3, bot_accounts.label),
            room_cap = COALESCE($4::int, bot_accounts.room_cap),
            removed_at = NULL`,
    [deviceId, email, label, cap, botCapDefault(), Date.now()]);
  forgetBotStatus();
}

// 봇 기록이 등록을 마쳤나 — /v1/snapshot 은 bot. 에 404 라서 /v1/status 로 본다(3.5)
async function botReady(deviceId) {
  if (!sender.up()) return false;
  try {
    const r = await sender.call('GET', '/v1/status?device_id=' + encodeURIComponent(deviceId), null, 8000);
    return !!(r && r.status === 200 && r.json && r.json.linked && !r.json.needs_register);
  } catch (e) {
    return false;
  }
}

// 재등록이면 시작할 때 이미 붙어 있던 기록일 수 있다 → 그때는 /v1/status 만으로 끝났다고 보지 않는다
const linkedAtBegin = new Map();   // pending_id → true
function noteLinkedAtBegin(pendingId, on) {
  if (!pendingId) return;
  if (on) linkedAtBegin.set(pendingId, Date.now());
  else linkedAtBegin.delete(pendingId);
  for (const [k, at] of linkedAtBegin) if (Date.now() - at > BOT_PENDING_MS) linkedAtBegin.delete(k);
}

async function finishBot(req, row, how) {
  await upsertBot(row.device_id, row.email, row.label || null, row.room_cap == null ? null : Number(row.room_cap));
  await db.q('DELETE FROM bot_pending WHERE pending_id=$1', [row.pending_id]);
  noteLinkedAtBegin(row.pending_id, false);
  await audit.record(req, 'bot', { detail: 'register ' + row.device_id + ' ' + row.email + (how ? ' (' + how + ')' : '') });
}

router.post('/admin/bot-register/begin', wrap(async (req, res) => {
  const b = req.body || {};
  const email = cleanEmail(b.email);
  const password = cleanPassword(b.password);
  if (!email || !password) return fail(res, 400, 'bad_input', '카카오 계정과 비밀번호를 입력해 주세요.');
  const label = cleanLabel(b.label);
  const c = capOf(b.room_cap);
  if (c.error) return fail(res, 400, 'bad_cap', c.error);
  let deviceId = str(b.device_id);
  let existing = null;
  if (deviceId) {
    // 고객 w… id 에 봇 자격 증명이 들어가지 않게: bot. 모양이고 bot_accounts 에 있는 행이어야 한다
    existing = ids.isBotId(deviceId) ? await db.one('SELECT device_id FROM bot_accounts WHERE device_id=$1', [deviceId]) : null;
    if (!existing) return fail(res, 400, 'bad_bot_id', TEXT.bad_bot_id);
  } else {
    const dup = await db.one(
      'SELECT device_id FROM bot_accounts WHERE lower(email)=lower($1) AND removed_at IS NULL LIMIT 1', [email]);
    if (dup) return fail(res, 409, 'bot_exists', TEXT.bot_exists, { device_id: dup.device_id });
    deviceId = 'bot.' + crypto.randomBytes(8).toString('hex');
  }
  if (!sender.up()) return fail(res, 503, 'sender_down', sender.reason() || TEXT.sender_down);
  const now = Date.now();
  await db.q('DELETE FROM bot_pending WHERE expires_at < $1 OR device_id = $2', [now, deviceId]);
  const wasLinked = existing ? await botReady(deviceId) : false;
  let out;
  try {
    const r = await sender.call('POST', '/v1/register/begin', {
      device_id: deviceId, email: email, password: password, forced: b.forced === true,
    }, 45000);
    out = r && r.json;
    if (!r || r.status !== 200 || !out || out.ok === false) return fail(res, 502, 'kakao_down', TEXT.kakao_down);
  } catch (e) {
    if (e && (e.code === 'sender_down' || e.message === 'timeout')) return fail(res, 503, 'sender_down', TEXT.sender_down);
    return fail(res, 502, 'kakao_down', TEXT.kakao_down);
  }
  if (out.state === 'confirm_on_phone' && out.pending_id) {
    await db.q(
      `INSERT INTO bot_pending (pending_id, device_id, email, label, room_cap, created_at, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (pending_id) DO NOTHING`,
      [out.pending_id, deviceId, email, label, c.cap, now, now + BOT_PENDING_MS]);
    noteLinkedAtBegin(out.pending_id, wasLinked);
  }
  if (out.state === 'ok') {
    await upsertBot(deviceId, email, label, c.cap);
    await audit.record(req, 'bot', { detail: 'register ' + deviceId + ' ' + email + (existing ? ' (재등록)' : '') });
  }
  const view = publicLogin(out);
  view.device_id = deviceId;
  res.json(Object.assign({ ok: true }, view));
}));

function expiredView() {
  return { ok: true, state: 'expired', text: authText.customerText({ state: 'expired' }) };
}

router.post('/admin/bot-register/confirm', wrap(async (req, res) => {
  const pendingId = str((req.body || {}).pending_id).slice(0, 100);
  if (!pendingId) return fail(res, 400, 'bad_input', '등록 대기 번호(pending_id)가 필요합니다.');
  const row = await db.one('SELECT * FROM bot_pending WHERE pending_id=$1', [pendingId]);
  if (!row) return res.json(expiredView());
  const ok = () => ({ ok: true, state: 'ok', text: '', device_id: row.device_id });
  const waiting = () => ({ ok: true, state: 'waiting', text: '', device_id: row.device_id });
  const trustStatus = !linkedAtBegin.has(pendingId);
  const ready = async () => trustStatus && await botReady(row.device_id);

  if (Number(row.expires_at) < Date.now()) {
    if (!sender.up()) return res.json(waiting());
    if (await ready()) { await finishBot(req, row, '확인 시간 경과 뒤 상태 확인'); return res.json(ok()); }
    await db.q('DELETE FROM bot_pending WHERE pending_id=$1', [pendingId]);
    noteLinkedAtBegin(pendingId, false);
    return res.json(expiredView());
  }
  if (await ready()) { await finishBot(req, row, '상태 확인'); return res.json(ok()); }
  if (!sender.up()) return res.json(waiting());
  let out = null;
  try {
    const r = await sender.call('POST', '/v1/register/confirm', { pending_id: pendingId }, BOT_CONFIRM_TIMEOUT_MS);
    out = r && r.status === 200 ? r.json : null;
  } catch (e) {
    out = null;      // 20초 초과·연결 끊김 → 아래에서 /v1/status 로 판정
  }
  if (!out || out.ok === false) {
    if (await ready()) { await finishBot(req, row, '확인 응답 없음 · 상태 확인'); return res.json(ok()); }
    return res.json(waiting());
  }
  if (out.state === 'ok' || (out.state === 'expired' && await ready())) {
    const still = await db.one('SELECT pending_id FROM bot_pending WHERE pending_id=$1', [pendingId]);
    if (!still) {
      // 그사이 취소했다 → 붙은 기록을 다시 떼어 낸다
      try { await sender.call('POST', '/v1/unlink', { device_id: row.device_id }, 20000); } catch (e) { /* 취소가 먼저다 */ }
      return res.json(expiredView());
    }
    await finishBot(req, row, '');
    return res.json(ok());
  }
  if (out.state !== 'waiting') {
    await db.q('DELETE FROM bot_pending WHERE pending_id=$1', [pendingId]);
    noteLinkedAtBegin(pendingId, false);
  }
  const view = publicLogin(out);
  view.device_id = row.device_id;
  res.json(Object.assign({ ok: true }, view));
}));

router.post('/admin/bot-register/cancel', wrap(async (req, res) => {
  const pendingId = str((req.body || {}).pending_id).slice(0, 100);
  const row = pendingId ? await db.one('SELECT pending_id FROM bot_pending WHERE pending_id=$1', [pendingId]) : null;
  if (row) {
    await db.q('DELETE FROM bot_pending WHERE pending_id=$1', [pendingId]);
    noteLinkedAtBegin(pendingId, false);
    if (sender.up()) {
      try { await sender.call('POST', '/v1/register/cancel', { pending_id: pendingId }, 10000); } catch (e) { /* 자식이 없어도 화면은 닫는다 */ }
    }
  }
  res.json({ ok: true });
}));

router.post('/admin/bot-update', wrap(async (req, res) => {
  const b = req.body || {};
  const deviceId = str(b.device_id);
  if (!ids.isBotId(deviceId)) return fail(res, 400, 'bad_bot_id', TEXT.bad_bot_id);
  const sets = [];
  const params = [deviceId];
  const changed = [];
  if (b.label !== undefined) {
    params.push(cleanLabel(b.label));
    sets.push('label=$' + params.length);
    changed.push('label=' + (params[params.length - 1] || '없음'));
  }
  if (b.room_cap !== undefined) {
    const c = capOf(b.room_cap);
    if (c.error || c.cap === null) return fail(res, 400, 'bad_cap', c.error || '최대 방 수는 1~200개로 입력해 주세요.');
    params.push(c.cap);
    sets.push('room_cap=$' + params.length);
    changed.push('room_cap=' + c.cap);
  }
  if (b.enabled !== undefined) {
    params.push(b.enabled === true);
    sets.push('enabled=$' + params.length);
    changed.push('enabled=' + (b.enabled === true));
  }
  if (!sets.length) return fail(res, 400, 'bad_input', '바꿀 값이 없습니다.');
  const r = await db.q('UPDATE bot_accounts SET ' + sets.join(', ') + ' WHERE device_id=$1 AND removed_at IS NULL RETURNING device_id', params);
  if (!r.rowCount) return fail(res, 404, 'not_found', TEXT.no_bot);
  await audit.record(req, 'bot', { detail: 'update ' + deviceId + ' ' + changed.join(' ') });
  forgetBotStatus();
  const out = await allBotsShaped();
  const bot = out.bots.find((x) => x.device_id === deviceId) || null;
  res.json({ ok: true, bot: bot, nickname_dup: bot ? bot.nickname_dup : false });
}));

// 오픈프로필(D12): li 로 고르기(null = 자동: 지금 쓰는 것 → 첫 번째) · refresh 로 다시 읽기 · url(open.kakao.com/me/…) 로 확인해 더하기
const OPEN_PROFILE_ERR = {
  not_connected: 'K bot 계정이 지금 카카오에 연결되어 있지 않습니다. 연결된 뒤 다시 시도해 주세요.',
  budget: '카카오 조회 한도에 걸렸습니다. 잠시 뒤 다시 시도해 주세요.',
  not_found: '오픈프로필 링크를 찾을 수 없습니다. 링크를 다시 확인해 주세요.',
  not_profile: '오픈프로필 링크가 아닙니다. open.kakao.com/me/로 시작하는 링크를 넣어 주세요.',
  not_mine: '이 K bot 계정의 오픈프로필이 아닙니다. 이 계정으로 만든 오픈프로필의 링크를 넣어 주세요.',
  kakao_error: '카카오 서버가 확인을 거부했습니다. 잠시 뒤 다시 시도해 주세요.',
  bad_url: 'open.kakao.com/me/로 시작하는 오픈프로필 링크를 넣어 주세요.',
};

router.post('/admin/bot-open-profile', wrap(async (req, res) => {
  const b = req.body || {};
  const deviceId = str(b.device_id);
  if (!ids.isBotId(deviceId)) return fail(res, 400, 'bad_bot_id', TEXT.bad_bot_id);
  const row = await db.one(
    'SELECT device_id, open_profiles, open_profile_pick FROM bot_accounts WHERE device_id=$1 AND removed_at IS NULL', [deviceId]);
  if (!row) return fail(res, 404, 'not_found', TEXT.no_bot);
  const url = str(b.url);
  if (url && !/^https:\/\/open\.kakao\.com\/me\/[A-Za-z0-9_-]{1,100}$/.test(url)) return fail(res, 400, 'bad_url', TEXT.bad_profile_url);
  const refresh = b.refresh === true;
  let picked = false;
  if (b.li !== undefined) {
    const li = b.li === null || b.li === '' ? null : str(b.li);
    if (li !== null && !(profileListOf(row.open_profiles) || []).some((p) => p.li === li)) return fail(res, 400, 'bad_profile', TEXT.bad_profile);
    await db.q('UPDATE bot_accounts SET open_profile_pick=$2 WHERE device_id=$1', [deviceId, li]);
    await audit.record(req, 'bot', { detail: 'open-profile ' + deviceId + ' pick=' + (li || 'auto') });
    picked = true;
  }
  let out = null;
  if (sender.up()) {
    try {
      const r = await sender.call('POST', '/v1/bot/open-profile', { device_id: deviceId, refresh: refresh, url: url || '' },
        url || refresh ? 30000 : 10000);
      out = r && r.json ? r.json : null;
    } catch (e) {
      out = null;
    }
  }
  if ((url || refresh) && !out) return fail(res, 503, 'sender_down', TEXT.sender_down);
  if ((url || refresh) && !out.ok) {
    const code = String(out.error || 'failed');
    return fail(res, code === 'not_connected' || code === 'budget' ? 409 : 400, code, OPEN_PROFILE_ERR[code] || TEXT.failed);
  }
  if (url) await audit.record(req, 'bot', { detail: 'open-profile ' + deviceId + ' url ' + url });
  forgetBotStatus();
  const shaped = await allBotsShaped();
  const bot = shaped.bots.find((x) => x.device_id === deviceId) || null;
  res.json({ ok: true, bot: bot, picked: picked, read_ok: out && out.ok ? !!out.read_ok : null });
}));

// 들어가 있는 방의 봇 프로필(D12): how 'switch' = 오픈프로필로 바꾸기(UPLINKPROF, 나가지 않음 · 부방장 유지 기대),
// 'rejoin' = 나갔다가 오픈프로필로 다시 입장(방장이 부방장을 다시 지정해야 함). sender 가 봇의 입장 줄에서 차례로 처리한다.
const ROOM_PROFILE_ERR = {
  not_joined: 'K bot이 이 방에 들어가 있지 않습니다. 사용 중이거나 부방장 지정 대기인 방만 바꿀 수 있습니다.',
  no_open_profile: '이 방의 K bot 계정에 쓸 오픈프로필이 없습니다. [K bot 계정] 탭에서 먼저 확인해 주세요.',
  not_connected: '이 방의 K bot 계정이 지금 카카오에 연결되어 있지 않습니다. 연결된 뒤 다시 시도해 주세요.',
  already_open: '이미 오픈프로필로 들어가 있습니다.',
};

router.post('/admin/room-profile', wrap(async (req, res) => {
  const b = req.body || {};
  const id = toId(b.id);
  const how = b.how === 'rejoin' ? 'rejoin' : 'switch';
  const row = id ? await db.one('SELECT id, member_id, phase FROM room_installs WHERE id=$1', [id]) : null;
  if (!row || row.phase !== 'installed') return fail(res, 404, 'not_found', TEXT.no_room);
  if (!sender.up()) return fail(res, 503, 'sender_down', TEXT.sender_down);
  let j = null;
  try {
    const r = await sender.call('POST', '/v1/bot/room-profile', { install_id: id, how: how }, 10000);
    j = r && r.json ? r.json : null;
  } catch (e) {
    return fail(res, 503, 'sender_down', TEXT.sender_down);
  }
  if (!j) return fail(res, 503, 'sender_down', TEXT.sender_down);
  if (!j.ok) {
    const code = String(j.error || 'failed');
    return fail(res, 409, code, ROOM_PROFILE_ERR[code] || TEXT.failed);
  }
  await audit.record(req, 'install', { member_id: Number(row.member_id), detail: 'profile-' + how + ' #' + id });
  res.json({ ok: true, queued: j.queued || how, room: await roomById(id, req) });
}));

router.post('/admin/bot-remove', wrap(async (req, res) => {
  const deviceId = str((req.body || {}).device_id);
  if (!ids.isBotId(deviceId)) return fail(res, 400, 'bad_bot_id', TEXT.bad_bot_id);
  const row = await db.one('SELECT device_id, email FROM bot_accounts WHERE device_id=$1 AND removed_at IS NULL', [deviceId]);
  if (!row) return fail(res, 404, 'not_found', TEXT.no_bot);
  const busy = await db.one(
    `SELECT (SELECT count(*) FROM room_installs WHERE bot_device_id=$1 AND phase='installed')::int AS rooms,
            (SELECT count(*) FROM room_leaves WHERE bot_device_id=$1 AND done_at IS NULL)::int AS leaves`, [deviceId]);
  if (busy.rooms > 0 || busy.leaves > 0) {
    return fail(res, 409, 'bot_busy', TEXT.bot_busy, { rooms: busy.rooms, leaves: busy.leaves });
  }
  if (!sender.up()) return fail(res, 503, 'sender_down', TEXT.sender_down);
  try {
    const r = await sender.call('POST', '/v1/unlink', { device_id: deviceId }, 20000);
    if (!r || r.status !== 200) return fail(res, 502, 'unlink_failed', 'K bot 계정 연결을 끊지 못했습니다. 잠시 뒤 다시 시도해 주세요.');
  } catch (e) {
    return fail(res, 503, 'sender_down', TEXT.sender_down);
  }
  await db.tx(async (client) => {
    await db.q('UPDATE bot_accounts SET removed_at=$2, enabled=FALSE WHERE device_id=$1', [deviceId, Date.now()], client);
    await db.q('DELETE FROM bot_pending WHERE device_id=$1', [deviceId], client);
    await audit.record(req, 'bot', { detail: 'remove ' + deviceId + ' ' + row.email }, client);
  });
  forgetBotStatus();
  res.json({ ok: true, device_id: deviceId });
}));

module.exports = router;
module.exports.passwordProblem = passwordProblem;
