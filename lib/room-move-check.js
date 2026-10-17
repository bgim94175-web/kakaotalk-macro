// 봇 옮기기·다시 설치(고객, 무료) 검사 — DB 없이 돈다. docs/ACCOUNTS_V1.md 3.4.3.
//   installs.selfBlock · selfView(간격·까닭 문구) · selfMove · selfReinstall 을 가짜 DB·가짜 sender 로 돌린다:
//   회원 소유, 입금 대기·확인 대기, 옮기기 24시간 · 다시 설치 30분 간격, 같은 방의 새 링크(나가지 않음), 다른 회원·내 다른 설치·
//   입금 대기 주문과의 충돌, 금지 방, 확인하지 못한 링크, 확인 대기 낱말, 참여코드, 감사 기록, 연속 횟수(관리자만).
//   라우트: kindOf 버킷 · sameOriginWrites(CSRF) · /panel/api/bot-room/move·reinstall 의 회원 확인·회원당 시간 한도·응답 모양.
// 마지막 줄에 'room move check ok'.
'use strict';

process.env.CONFIG_SECRET = '0123456789abcdef0123456789abcdef';
delete process.env.ROOM_SELF_MOVE_GAP_MS;
delete process.env.ROOM_SELF_REINSTALL_GAP_MS;
delete process.env.ROOM_HOLD_WORDS;
process.env.ROOM_RETRY_BASE_MS = '120000';

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

const db = require('./db');
const senderChild = require('./sender-child');
const installs = require('./installs');
const secretbox = require('./secretbox');
const rl = require('./ratelimit');
const memberAuth = require('./member-auth');

const MIN = 60000;
const HOUR = 60 * MIN;
const L1 = 'https://open.kakao.com/o/gRoomOne';
const L1B = 'https://open.kakao.com/o/gRoomOneNew';   // 같은 방(li 111)의 바뀐 링크
const L2 = 'https://open.kakao.com/o/gRoomTwo';
const L3 = 'https://open.kakao.com/o/gRoomThree';
const L4 = 'https://open.kakao.com/o/gRoomFour';
const LGONE = 'https://open.kakao.com/o/gGone1';
const LDM = 'https://open.kakao.com/o/gDirect1';
const LDOWN = 'https://open.kakao.com/o/gNoBot1';
const LBLK = 'https://open.kakao.com/o/gBlocked1';
const LHOLD = 'https://open.kakao.com/o/gHold1';
const LPC = 'https://open.kakao.com/o/gCode1';
const BOT_A = 'bot.aaaaaaaaaaaaaaaa';
const BOT_B = 'bot.bbbbbbbbbbbbbbbb';

// ── 1. 순수 판정: selfBlock · selfView ─────────────────────────────────────
const NOW = Date.UTC(2026, 9, 13, 3, 0, 0);   // 12:00 KST
function row(extra) {
  return Object.assign({ id: 12, member_id: 7, link_url: L1, link_id: '111', link_name: '동네모임', roombot: true, minigame: true,
    phase: 'installed', order_id: 'ORD-1', bot_device_id: BOT_A, hold_reason: null, retry_n: 0, retry_at: null, state: 'active',
    error_code: null, error_detail: null, perm: 4, joined_at: NOW - HOUR, chat_id: '9001', state_at: NOW - HOUR, next_try_at: null,
    config: { visit: { enabled: true } }, config_rev: 1, self_move_at: null, self_reinstall_at: null, passcode_ct: null }, extra || {});
}
const B = (extra, kind) => installs.selfBlock(row(extra), NOW, kind);

assert(B({}, 'move') === null && B({}, 'reinstall') === null && B({}, 'relink') === null, 'active room: move and reinstall allowed');
let b = B({ phase: 'pending_payment' }, 'move');
assert(b && b.status === 409 && b.reason === 'not_installed' && b.error === '입금이 확인된 뒤에 옮기거나 다시 설치할 수 있습니다.', 'pending → 409');
assert(B({ phase: 'removed' }, 'reinstall').status === 404 && B({ phase: 'canceled' }, 'move').status === 404, 'removed · canceled → 404');
b = B({ hold_reason: 'name:도박' }, 'move');
assert(b.reason === 'held' && B({ hold_reason: 'name:도박' }, 'reinstall').reason === 'held', 'hold → held');
// 옮기기 24시간
b = B({ self_move_at: NOW - HOUR }, 'move');
assert(b && b.status === 429 && b.reason === 'too_soon' && b.retry_after === NOW + 23 * HOUR, 'move gap 24h: ' + JSON.stringify(b));
assert(b.error === '다른 방으로 옮기기는 방마다 24시간에 한 번 할 수 있습니다. 10월 14일 11:00 이후에 다시 시도해 주세요.', 'move gap copy: ' + b.error);
assert(B({ self_move_at: NOW - 24 * HOUR }, 'move') === null, 'move allowed again after 24h');
assert(B({ self_move_at: NOW - HOUR }, 'reinstall') === null && B({ self_move_at: NOW - HOUR }, 'relink') === null,
  'move gap does not block reinstall / same-room relink');
// 다시 설치 30분 (같은 날이면 시각만)
b = B({ self_reinstall_at: NOW - 10 * MIN }, 'reinstall');
assert(b && b.status === 429 && b.retry_after === NOW + 20 * MIN &&
       b.error === '다시 설치는 방마다 30분에 한 번 할 수 있습니다. 12:20 이후에 다시 시도해 주세요.', 'reinstall gap copy: ' + (b && b.error));
assert(B({ self_reinstall_at: NOW - 10 * MIN }, 'relink').reason === 'too_soon', 'relink shares the reinstall gap');
assert(B({ self_reinstall_at: NOW - 10 * MIN }, 'move') === null, 'reinstall gap does not block a move to another room');
// 상태별
assert(B({ state: 'queued' }, 'reinstall').reason === 'joining' && B({ state: 'joining' }, 'reinstall').reason === 'joining', 'joining → no reinstall');
assert(B({ state: 'joining' }, 'move') === null && B({ state: 'queued' }, 'relink') === null, 'joining room may still move / relink');
['link_gone', 'room_deleted', 'not_group', 'link_changed'].forEach((c) => {
  const x = B({ state: 'error', error_code: c }, 'reinstall');
  assert(x.reason === 'need_link' && x.error.indexOf('[다른 방으로 옮기기]') >= 0, c + ' → need_link');
  assert(B({ state: 'error', error_code: c }, 'relink') === null && B({ state: 'error', error_code: c }, 'move') === null, c + ' → a new link fixes it');
  assert(installs.ERRORS[c].long.indexOf('[다른 방으로 옮기기]') >= 0 && installs.ERRORS[c].long.indexOf('문의') < 0, c + ' copy points to self-service');
});
['duplicate_room', 'room_taken', 'blocked'].forEach((c) => {
  assert(B({ state: 'error', error_code: c }, 'reinstall').reason === 'need_support' &&
         B({ state: 'error', error_code: c }, 'relink').reason === 'need_support', c + ' → support');
  assert(B({ state: 'error', error_code: c }, 'reinstall').error === installs.ERRORS[c].long, c + ' → ERRORS copy');
});
['bot_down', 'bot_no_open_profile'].forEach((c) => assert(B({ state: 'error', error_code: c }, 'reinstall').reason === 'bot_check', c + ' → bot_check'));
['kicked', 'left', 'room_full', 'passcode_wrong'].forEach((c) => assert(B({ state: 'error', error_code: c }, 'reinstall') === null, c + ' → reinstall ok'));
assert(B({ state: 'waiting_host', perm: 2 }, 'reinstall') === null, 'waiting room may reinstall');
// 연속 횟수(고객 다시 시도와 같은 retry_n, D16)
b = B({ state: 'error', error_code: 'kicked', retry_n: 10, retry_at: NOW - HOUR, joined_at: NOW - 2 * HOUR }, 'reinstall');
assert(b && b.status === 403 && b.reason === 'admin_only', 'ten failed tries → admin only');
assert(B({ state: 'active', retry_n: 10, retry_at: NOW - 2 * HOUR, joined_at: NOW - HOUR }, 'reinstall') === null, 'a join after the tries resets the count');
// 환경변수 간격
process.env.ROOM_SELF_MOVE_GAP_MS = String(90 * MIN);
assert(B({ self_move_at: NOW - HOUR }, 'move').error.indexOf('1시간 30분에 한 번') >= 0, 'move gap from env');
delete process.env.ROOM_SELF_MOVE_GAP_MS;
assert(installs.gapText(30 * MIN) === '30분' && installs.gapText(24 * HOUR) === '24시간' && installs.gapText(90 * MIN) === '1시간 30분', 'gapText');

// RoomView 칸
let v = installs.publicView(row({ self_move_at: NOW - HOUR }), null, null, null, NOW);
['can_move', 'move_after', 'move_note', 'can_reinstall', 'reinstall_after', 'reinstall_note', 'self_rule'].forEach((k) => assert(k in v, 'RoomView has ' + k));
assert(v.can_move === true && v.move_after === NOW + 23 * HOUR && v.move_note.indexOf('24시간') >= 0, 'view: move waiting');
assert(v.can_reinstall === true && v.reinstall_after === 0 && v.reinstall_note === '', 'view: reinstall free');
assert(v.self_rule === '옮기기와 다시 설치는 무료입니다. 다른 방으로 옮기기는 방마다 24시간에 한 번, 다시 설치는 30분에 한 번 할 수 있습니다.', 'self_rule: ' + v.self_rule);
v = installs.publicView(row({ phase: 'pending_payment', bot_device_id: null }), null, null, null, NOW);
assert(v.can_move === false && v.can_reinstall === false && v.move_note === '입금이 확인된 뒤에 옮기거나 다시 설치할 수 있습니다.', 'view: pending');
v = installs.publicView(row({ state: 'error', error_code: 'room_deleted' }), null, null, null, NOW);
assert(v.can_move === true && v.can_reinstall === false && v.reinstall_note.indexOf('[다른 방으로 옮기기]') >= 0, 'view: deleted room → move only');
assert(JSON.stringify(v).indexOf(BOT_A) < 0, 'RoomView still hides the bot device id');
// 문구 규칙(TONE): 합니다체·마침표, 버튼은 [ ], 십시오·K bot 계정 없음
Object.keys(installs.SELF_TEXT).forEach((k) => {
  const t = installs.SELF_TEXT[k];
  assert(/(니다|주세요)\.$/.test(t) && t.indexOf('십시오') < 0 && t.indexOf('K bot 계정') < 0, 'SELF_TEXT.' + k + ' tone: ' + t);
});

// ── 2. 가짜 DB · 가짜 sender ───────────────────────────────────────────────
const S = { installs: new Map(), states: new Map(), leaves: [], audit: [], orders: [], blocks: [], bots: [{ id: BOT_A, cap: 20 }, { id: BOT_B, cap: 20 }],
  resolves: [], nudges: [], up: true };
const LINKS = {
  [L1]: { link_id: '111', name: '동네모임', max_users: 1500 }, [L1B]: { link_id: '111', name: '동네모임' },
  [L2]: { link_id: '222', name: '새 모임' }, [L3]: { link_id: '333', name: '셋째 방' }, [L4]: { link_id: '444', name: '넷째 방' },
  [LBLK]: { link_id: '555', name: '막힌 방' }, [LHOLD]: { link_id: '666', name: '주말 토토 모임' }, [LPC]: { link_id: '777', name: '코드 방', needs_passcode: true },
};
const clone = (o) => (o ? JSON.parse(JSON.stringify(o)) : o);
const REENTER = { state: 'queued', error_code: null, error_detail: null, next_try_at: null, perm: null, perm_at: null };

function exclusiveCheck() {
  const seen = {};
  for (const r of S.installs.values()) {
    if (r.phase !== 'installed' || r.error_code === 'kicked') continue;
    for (const k of [r.link_id ? 'li:' + r.link_id : null, 'url:' + r.link_url]) {
      if (!k) continue;
      if (seen[k]) { const e = new Error('duplicate key'); e.code = '23505'; throw e; }
      seen[k] = true;
    }
  }
}
function linkHit(r, linkId, linkUrl) { return r.link_url === linkUrl || (linkId != null && r.link_id === linkId); }
function query(sql, p) {
  const s = String(sql).replace(/\s+/g, ' ').trim();
  let m;
  if (/^SELECT \* FROM room_installs WHERE id=\$1( FOR UPDATE)?$/.test(s)) {
    const r = S.installs.get(Number(p[0]));
    return { rows: r ? [clone(r)] : [], rowCount: r ? 1 : 0 };
  }
  if (s.indexOf('FROM room_blocklist') >= 0) {
    const hit = S.blocks.some((x) => (p[0] != null && x.link_id === p[0]) || (p[1] != null && x.link_url === p[1]));
    return { rows: hit ? [{ '?column?': 1 }] : [], rowCount: hit ? 1 : 0 };
  }
  if (s.indexOf('jsonb_array_elements') >= 0) {
    const o = S.orders.find((x) => (x.status === 'pending' || x.status === 'paid') &&
      x.items.some((it) => String(it.install_id) === p[0] && it.product === p[1]));
    return { rows: o ? [{ id: o.id }] : [], rowCount: o ? 1 : 0 };
  }
  if (/^SELECT id, member_id, link_id, link_url, link_name, phase FROM room_installs WHERE phase='installed'/.test(s)) {
    const r = [...S.installs.values()].sort((a, b2) => a.id - b2.id).find((x) => x.phase === 'installed' && x.error_code !== 'kicked' &&
      x.id !== Number(p[0]) && linkHit(x, p[1], p[2]));
    return { rows: r ? [clone(r)] : [], rowCount: r ? 1 : 0 };
  }
  if (/^SELECT id, member_id, link_id, link_url, link_name, phase, order_id FROM room_installs WHERE member_id=\$4 AND phase='pending_payment'/.test(s)) {
    const r = [...S.installs.values()].find((x) => x.member_id === Number(p[3]) && x.phase === 'pending_payment' && x.id !== Number(p[0]) && linkHit(x, p[1], p[2]));
    return { rows: r ? [clone(r)] : [], rowCount: r ? 1 : 0 };
  }
  if (/^INSERT INTO room_leaves/.test(s)) {
    const id = S.leaves.length + 1;
    S.leaves.push({ id: id, install_id: Number(p[0]), bot_device_id: p[1], chat_id: p[2], link_id: p[3], why: p[4], created_at: p[5] });
    return { rows: [{ id: id }], rowCount: 1 };
  }
  if ((m = /^UPDATE room_installs SET link_url=\$2, link_id=\$3, link_name=\$4, chat_id=NULL, passcode_ct=\$5, hold_reason=\$6,/.exec(s))) {
    const r = S.installs.get(Number(p[0]));
    Object.assign(r, { link_url: p[1], link_id: p[2], link_name: p[3], chat_id: null, passcode_ct: p[4], hold_reason: p[5],
      bot_device_id: p[5] == null ? r.bot_device_id : null, retry_n: 0, retry_at: null, self_move_at: p[6], state_at: p[6] }, REENTER);
    exclusiveCheck();
    return { rows: [], rowCount: 1 };
  }
  if (/^UPDATE room_installs SET retry_n=\$2, retry_at=\$3::bigint, self_reinstall_at=\$3::bigint,/.test(s)) {
    const r = S.installs.get(Number(p[0]));
    Object.assign(r, { retry_n: p[1], retry_at: p[2], self_reinstall_at: p[2], state_at: p[2] }, REENTER);
    if (p[3] != null) r.passcode_ct = p[3];
    if (p[4] != null) r.link_url = p[4];
    if (p[5] != null) r.link_id = p[5];
    if (p[6] != null) r.link_name = p[6];
    exclusiveCheck();
    return { rows: [], rowCount: 1 };
  }
  if (s.indexOf('pg_advisory_xact_lock') >= 0) return { rows: [], rowCount: 1 };
  // 미리 보기(installs.preview): 다른 회원의 결제된 설치 · 내 같은 방(VIEW_SELECT, mc_rt = 지금 방의 runtime.mc) · 처리 대기 주문
  if (/^SELECT id FROM room_installs WHERE phase='installed' AND error_code IS DISTINCT FROM 'kicked' AND member_id <> \$1/.test(s)) {
    const r = [...S.installs.values()].find((x) => x.phase === 'installed' && x.error_code !== 'kicked' && x.member_id !== Number(p[0]) && linkHit(x, p[2], p[1]));
    return { rows: r ? [{ id: r.id }] : [], rowCount: r ? 1 : 0 };
  }
  if (s.indexOf(' AS mc_rt ') >= 0 && s.indexOf("WHERE r.member_id=$1 AND r.phase IN ('installed','pending_payment')") >= 0) {
    const r = [...S.installs.values()].filter((x) => x.member_id === Number(p[0]) && (x.phase === 'installed' || x.phase === 'pending_payment') && linkHit(x, p[2], p[1]))
      .sort((a, b2) => (b2.phase === 'installed') - (a.phase === 'installed') || b2.id - a.id)[0];
    if (!r) return { rows: [], rowCount: 0 };
    const mc = S.states.get(r.id) && S.states.get(r.id).mc;
    return { rows: [Object.assign(clone(r), { bot_nickname: null, order_token: null, mc_rt: mc && mc.chat === r.chat_id ? clone(mc) : null })], rowCount: 1 };
  }
  if (/^SELECT id, items FROM orders WHERE status IN \('pending','paid'\)/.test(s)) return { rows: [], rowCount: 0 };
  if (/^SELECT b\.device_id FROM bot_accounts b/.test(s)) {
    const ex = p[0] || [];
    const load = (id) => [...S.installs.values()].filter((x) => x.phase === 'installed' && x.bot_device_id === id).length;
    const bot = S.bots.filter((x) => ex.indexOf(x.id) < 0 && load(x.id) < x.cap).sort((a, b2) => load(a.id) - load(b2.id))[0];
    return { rows: bot ? [{ device_id: bot.id }] : [], rowCount: bot ? 1 : 0 };
  }
  if (/^UPDATE room_installs SET bot_device_id=\$2, state='queued'/.test(s)) {
    Object.assign(S.installs.get(Number(p[0])), { bot_device_id: p[1], state_at: p[2] }, REENTER);
    return { rows: [], rowCount: 1 };
  }
  if (/^UPDATE room_installs SET bot_device_id=NULL, state='queued'/.test(s)) {
    Object.assign(S.installs.get(Number(p[0])), { bot_device_id: null, state: 'queued', error_detail: 'no_bot' });
    return { rows: [], rowCount: 1 };
  }
  if (/^INSERT INTO audit_log/.test(s)) {
    S.audit.push({ kind: p[2], detail: p[3], ip: p[4], member_id: p[5] });
    return { rows: [], rowCount: 1 };
  }
  throw new Error('fake db: unexpected SQL: ' + s.slice(0, 160));
}
db.q = async (sql, params) => query(sql, params || []);
db.one = async (sql, params) => (query(sql, params || []).rows[0] || null);
db.tx = async (fn) => {
  const snap = { installs: new Map([...S.installs].map(([k, r]) => [k, clone(r)])), leaves: S.leaves.slice(), audit: S.audit.slice() };
  try {
    return await fn({ fake: true });
  } catch (e) {
    S.installs = snap.installs; S.leaves = snap.leaves; S.audit = snap.audit;   // 롤백
    throw e;
  }
};
senderChild.up = () => S.up;
senderChild.call = async (method, path, body) => {
  if (path === '/v1/bot/sync') { S.nudges.push(body && body.install_id); return { status: 200, json: { ok: true } }; }
  if (path === '/v1/bot/resolve') {
    S.resolves.push(body.url);
    if (body.url === LGONE) return { status: 200, json: { ok: false, error: 'not_found' } };
    if (body.url === LDM) return { status: 200, json: { ok: false, error: 'not_group' } };
    if (body.url === LDOWN) return { status: 200, json: { ok: false, error: 'no_bot' } };
    const l = LINKS[body.url];
    if (!l) return { status: 200, json: { ok: false, error: 'not_found' } };
    return { status: 200, json: { ok: true, link_id: l.link_id, name: l.name, needs_passcode: !!l.needs_passcode, max_users: l.max_users == null ? null : l.max_users } };
  }
  throw new Error('fake sender: ' + path);
};

function put(extra) {
  const r = Object.assign(row({ self_move_at: null, self_reinstall_at: null }), extra || {});
  S.installs.set(r.id, r);
  return r;
}
function reset() {
  S.installs = new Map(); S.states = new Map(); S.leaves = []; S.audit = []; S.orders = []; S.blocks = []; S.resolves = []; S.nudges = [];
  S.up = true;
  installs.clearPreviewCache();
}
const get = (id) => S.installs.get(id);
const tick = () => new Promise((r) => setImmediate(r));

(async () => {
  // 2.1 다른 방으로 옮기기
  reset();
  put({ id: 12, passcode_ct: secretbox.seal('old') });
  let t0 = Date.now();
  let r = await installs.selfMove(12, '새 방 ' + L2 + ' 들어와요', { memberId: 7 });
  assert(r.ok && r.kind === 'move' && r.same_room === false && r.held === false && r.link_url === L2 && r.link_name === '새 모임', 'move ok: ' + JSON.stringify(r));
  let x = get(12);
  assert(x.link_url === L2 && x.link_id === '222' && x.link_name === '새 모임' && x.chat_id === null && x.state === 'queued' &&
         x.perm === null && x.bot_device_id === BOT_A && x.passcode_ct === null && x.retry_n === 0 && x.self_move_at >= t0, 'row moved: ' + JSON.stringify(x));
  assert(S.leaves.length === 1 && S.leaves[0].bot_device_id === BOT_A && S.leaves[0].chat_id === '9001' && S.leaves[0].link_id === '111' &&
         S.leaves[0].why === 'rebind', 'old room is left: ' + JSON.stringify(S.leaves));
  assert(S.audit.length === 1 && S.audit[0].kind === 'install' && S.audit[0].member_id === 7 &&
         S.audit[0].detail.indexOf('member_move 설치 #12 ' + L1 + ' → ' + L2) === 0, 'audit member_move: ' + JSON.stringify(S.audit));
  await tick();
  assert(S.nudges.indexOf(12) >= 0, 'sender is nudged');
  assert(x.config && x.config.visit && x.config.visit.enabled === true && x.roombot && x.minigame, 'settings and products move along');

  // 2.2 24시간 안에 다른 방으로 또 → 429, 아무것도 바뀌지 않음
  r = await installs.selfMove(12, L3, { memberId: 7 });
  assert(!r.ok && r.status === 429 && r.reason === 'too_soon' && r.retry_after > Date.now() + 23 * HOUR, 'second move within 24h → 429');
  assert(get(12).link_url === L2 && S.leaves.length === 1 && S.audit.length === 1, 'nothing changed on 429');

  // 2.3 같은 방의 바뀐 링크(같은 li) → 옮기기 간격과 관계없이 다시 설치, 나가지 않음
  reset();
  put({ id: 12, self_move_at: Date.now() - HOUR, passcode_ct: secretbox.seal('keep') });
  r = await installs.selfMove(12, L1B, { memberId: 7 });
  assert(r.ok && r.kind === 'reinstall' && r.same_room === true && r.link_url === L1B, 'same room new link → relink: ' + JSON.stringify(r));
  x = get(12);
  assert(x.link_url === L1B && x.link_id === '111' && x.chat_id === '9001' && x.state === 'queued' && x.retry_n === 1 &&
         x.self_reinstall_at > 0 && secretbox.open(x.passcode_ct) === 'keep', 'relink keeps the chat and passcode: ' + JSON.stringify(x));
  assert(S.leaves.length === 0, 'relink does not leave the room');
  assert(S.audit[0].detail.indexOf('member_relink 설치 #12 ' + L1 + ' → ' + L1B) === 0, 'audit member_relink');
  r = await installs.selfReinstall(12, { memberId: 7 });
  assert(!r.ok && r.status === 409 && r.reason === 'joining', 'reinstall while the bot is joining → 409 joining');
  get(12).state = 'active';
  r = await installs.selfReinstall(12, { memberId: 7 });
  assert(!r.ok && r.status === 429 && r.error.indexOf('다시 설치는 방마다 30분에 한 번') === 0, 'reinstall right after relink → 429');

  // 2.4 같은 방에 다시 설치(링크 없이)
  reset();
  put({ id: 12, state: 'error', error_code: 'kicked', chat_id: '9001', retry_n: 2, retry_at: Date.now() - 2 * HOUR, joined_at: Date.now() - 5 * HOUR });
  r = await installs.selfReinstall(12, { memberId: 7, passcode: ' 4321 ' });
  x = get(12);
  assert(r.ok && x.state === 'queued' && x.error_code === null && x.retry_n === 3 && x.retry_at === x.self_reinstall_at &&
         secretbox.open(x.passcode_ct) === '4321' && x.bot_device_id === BOT_A && S.leaves.length === 0 && S.resolves.length === 0,
         'reinstall requeues, counts the try, no lookup, no leave: ' + JSON.stringify(x));
  assert(S.audit[0].detail.indexOf('member_reinstall 설치 #12 / 이전 error:kicked (3회) / 참여코드 변경') === 0, 'audit member_reinstall: ' + S.audit[0].detail);
  // 지금 링크를 그대로 넣으면 다시 설치와 같다(조회하지 않음)
  reset();
  put({ id: 12 });
  r = await installs.selfMove(12, L1, { memberId: 7 });
  assert(r.ok && r.kind === 'reinstall' && S.resolves.length === 0 && S.leaves.length === 0, 'same link → reinstall without lookup');
  // 봇이 없는 설치는 다시 설치하며 봇을 배정한다
  reset();
  put({ id: 12, bot_device_id: null, state: 'error', error_code: 'left' });
  r = await installs.selfReinstall(12, { memberId: 7 });
  assert(r.ok && get(12).bot_device_id, 'reinstall assigns a bot when none');

  // 2.5 소유·상태
  reset();
  put({ id: 12 });
  put({ id: 13, member_id: 8, link_url: L3, link_id: '333' });
  r = await installs.selfMove(13, L4, { memberId: 7 });
  assert(!r.ok && r.status === 404 && S.resolves.length === 0, "another member's install → 404, no lookup");
  r = await installs.selfReinstall(13, { memberId: 7 });
  assert(!r.ok && r.status === 404, "another member's install → 404 (reinstall)");
  r = await installs.selfReinstall(12, { memberId: null });
  assert(!r.ok && r.status === 404, 'no member → 404');
  put({ id: 14, member_id: 7, phase: 'pending_payment', link_url: L4, link_id: null, bot_device_id: null });
  r = await installs.selfMove(14, L2, { memberId: 7 });
  assert(!r.ok && r.status === 409 && r.reason === 'not_installed' && S.resolves.length === 0, 'pending install → 409 before lookup');
  put({ id: 15, member_id: 7, hold_reason: 'name:x', link_url: 'https://open.kakao.com/o/gHeld1', link_id: '999' });
  r = await installs.selfMove(15, L2, { memberId: 7 });
  assert(!r.ok && r.reason === 'held' && S.resolves.length === 0, 'held install → 409 before lookup');
  r = await installs.selfReinstall(12, { memberId: 7, passcode: 'x'.repeat(21) });
  assert(!r.ok && r.status === 400 && r.reason === 'bad_passcode', 'long passcode → 400');

  // 2.6 링크 문제
  reset();
  put({ id: 12 });
  r = await installs.selfMove(12, 'https://open.kakao.com/me/someone', { memberId: 7 });
  assert(!r.ok && r.reason === 'profile_link' && S.resolves.length === 0, 'open profile link → 400');
  r = await installs.selfMove(12, '링크 없음', { memberId: 7 });
  assert(!r.ok && r.status === 400 && r.reason === 'bad_link', 'no link → 400');
  r = await installs.selfMove(12, LGONE, { memberId: 7 });
  assert(!r.ok && r.status === 404 && r.reason === 'not_found', 'gone link → 404');
  r = await installs.selfMove(12, LDM, { memberId: 7 });
  assert(!r.ok && r.status === 422 && r.reason === 'not_group', '1:1 link → 422');
  r = await installs.selfMove(12, LDOWN, { memberId: 7 });
  assert(!r.ok && r.status === 503 && r.reason === 'not_verified' && r.error === '지금은 링크를 확인할 수 없습니다. 잠시 뒤 다시 시도해 주세요.',
    'unverified link → 503 (customers never move to an unchecked link)');
  S.blocks.push({ link_id: '555', link_url: null });
  r = await installs.selfMove(12, LBLK, { memberId: 7 });
  assert(!r.ok && r.status === 403 && r.reason === 'blocked_room', 'blocked room (by li) → 403');
  assert(get(12).link_url === L1 && S.leaves.length === 0 && S.audit.length === 0, 'failed moves change nothing');

  // 2.7 충돌
  reset();
  put({ id: 12 });
  put({ id: 20, member_id: 8, link_url: L2, link_id: '222' });
  r = await installs.selfMove(12, L2, { memberId: 7 });
  assert(!r.ok && r.status === 409 && r.reason === 'room_taken' && r.error === installs.TEXT.taken, "another member's room → 409");
  get(20).error_code = 'kicked'; get(20).state = 'error';
  r = await installs.selfMove(12, L2, { memberId: 7 });
  assert(r.ok, 'a room whose other K bot was kicked is free (D8)');
  reset();
  put({ id: 12 });
  put({ id: 21, member_id: 7, link_url: L3, link_id: '333' });
  r = await installs.selfMove(12, L3, { memberId: 7 });
  assert(!r.ok && r.reason === 'own_room' && r.error === '이 방에는 이미 내 K bot이 있습니다. 두 방을 합치려면 문의해 주세요.', 'my other install → own_room');
  put({ id: 22, member_id: 7, phase: 'pending_payment', link_url: L4, link_id: null, bot_device_id: null });
  r = await installs.selfMove(12, L4, { memberId: 7 });
  assert(!r.ok && r.reason === 'pending_exists', 'room in my unpaid order → pending_exists');
  S.orders.push({ id: 'ORD-9', status: 'pending', items: [{ product: 'minigame', install_id: 12 }] });
  r = await installs.selfMove(12, L2, { memberId: 7 });
  assert(!r.ok && r.status === 409 && r.reason === 'order_pending', 'unpaid order adding a bot to this room → 409');
  S.orders = [];
  // 내보내진 동안 다른 회원이 그 방을 설치함 → 다시 설치 409
  reset();
  put({ id: 12, state: 'error', error_code: 'kicked' });
  put({ id: 23, member_id: 8, link_url: L1, link_id: '111', chat_id: '9002' });
  r = await installs.selfReinstall(12, { memberId: 7 });
  assert(!r.ok && r.status === 409 && r.reason === 'room_taken', 'kicked room taken meanwhile → 409');
  assert(get(12).state === 'error' && S.audit.length === 0, 'nothing written');

  // 2.8 확인 대기 낱말 · 참여코드 · 봇 없는 설치
  reset();
  process.env.ROOM_HOLD_WORDS = '토토';
  put({ id: 12 });
  r = await installs.selfMove(12, LHOLD, { memberId: 7 });
  x = get(12);
  assert(r.ok && r.held === true && x.hold_reason === 'name:토토' && x.bot_device_id === null && S.leaves.length === 1, 'hold word → held, bot leaves');
  assert(installs.publicView(x, null, null, null, Date.now()).detail === '관리자가 확인한 뒤 K bot이 들어갑니다.', 'held room shows the review note');
  process.env.ROOM_HOLD_WORDS = '';
  reset();
  put({ id: 12, bot_device_id: null, chat_id: null, state: 'queued', error_detail: 'no_bot' });
  r = await installs.selfMove(12, LPC, { memberId: 7, passcode: '2468' });
  x = get(12);
  assert(r.ok && secretbox.open(x.passcode_ct) === '2468' && x.bot_device_id && S.leaves.length === 0, 'passcode sealed, bot assigned, nothing to leave');
  // 연속 실패 10번 → 관리자만
  reset();
  put({ id: 12, state: 'error', error_code: 'kicked', retry_n: 10, retry_at: Date.now() - HOUR, joined_at: Date.now() - 2 * HOUR });
  r = await installs.selfReinstall(12, { memberId: 7 });
  assert(!r.ok && r.status === 403 && r.reason === 'admin_only', 'ten tries → admin only');
  r = await installs.selfMove(12, L2, { memberId: 7 });
  assert(r.ok && get(12).retry_n === 0, 'moving to another room starts a fresh count');

  // ── 3. 경로 버킷 · CSRF ──────────────────────────────────────────────────
  assert(rl.kindOf({ method: 'POST', path: '/panel/api/bot-room/move' }) === 'preview', 'move uses the preview bucket (Kakao lookups)');
  assert(rl.kindOf({ method: 'POST', path: '/PANEL/api/bot-room/move/' }) === 'preview', 'bucket ignores case and trailing slash');
  assert(rl.kindOf({ method: 'POST', path: '/panel/api/bot-room/reinstall' }) === 'panel', 'reinstall uses the panel bucket');
  function csrf(path, headers) {
    let status = 0;
    let passed = false;
    const res = { statusCode: 200, headersSent: false, setHeader() {}, getHeader() {}, set() { return res; },
      status(n) { status = n; res.statusCode = n; return res; }, json() { return res; }, end() { status = status || res.statusCode; return res; } };
    const req = { method: 'POST', path: path, url: path, headers: Object.assign({ host: 'kmacro.cloud' }, headers), protocol: 'https',
      get(h) { return this.headers[String(h).toLowerCase()]; }, socket: {} };
    memberAuth.sameOriginWrites(req, res, () => { passed = true; });
    return passed ? 'next' : (status || res.statusCode);
  }
  ['/panel/api/bot-room/move', '/panel/api/bot-room/reinstall'].forEach((p) => {
    assert(csrf(p, { 'content-type': 'text/plain' }) === 415, p + ': form posts are refused (415)');
    assert(csrf(p, { 'content-type': 'application/json', origin: 'https://evil.example' }) === 403, p + ': other origin → 403');
    assert(csrf(p, { 'content-type': 'application/json', 'sec-fetch-site': 'cross-site' }) === 403, p + ': cross-site → 403');
    assert(csrf(p, { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' }) === 'next', p + ': same-origin JSON passes');
  });

  // ── 3.5 미리 보기의 멤버 수(옮기기 확인 · 구매 미리 보기) ────────────────
  // 카카오는 들어가지 않은 방의 지금 멤버 수를 알려 주지 않는다(JOININFO 는 최대 인원 ml 만). 내 방(K bot 이 들어가 있음)이면 그 방의 수.
  reset();
  put({ id: 12, state: 'active', perm: 4 });
  S.states.set(12, { mc: { n: 778, max: 1500, at: Date.now() - MIN, chat: '9001' } });
  let pv = await installs.preview(7, L1);
  assert(pv.ok && pv.verified && pv.room.max_users === 1500 && pv.room.member_count === 778 && pv.mine && pv.mine.install_id === 12, 'preview of my room: count + limit ' + JSON.stringify(pv.room));
  installs.clearPreviewCache();
  pv = await installs.preview(7, L2);
  assert(pv.ok && pv.room.member_count === null && pv.room.max_users === null && !pv.mine, 'preview of a room without the bot: no count ' + JSON.stringify(pv.room));
  // 옮기기 전 방(chat 이 다름)의 수 · 오래된 수 · 내보내진 방의 수는 보이지 않는다
  S.states.set(12, { mc: { n: 778, max: 1500, at: Date.now() - MIN, chat: '8888' } });
  installs.clearPreviewCache();
  assert((await installs.preview(7, L1)).room.member_count === null, 'count of another chat is not shown');
  S.states.set(12, { mc: { n: 778, max: 1500, at: Date.now() - installs.MEMBER_COUNT_MAX_AGE_MS - MIN, chat: '9001' } });
  installs.clearPreviewCache();
  assert((await installs.preview(7, L1)).room.member_count === null, 'stale count is not shown');
  S.states.set(12, { mc: { n: 778, max: 1500, at: Date.now() - MIN, chat: '9001' } });
  get(12).state = 'error';
  get(12).error_code = 'kicked';
  installs.clearPreviewCache();
  assert((await installs.preview(7, L1)).room.member_count === null, 'kicked room shows no count');
  // sender 가 꺼져 확인하지 못한 링크라도 내 방이면 저장된 수
  get(12).state = 'waiting_host';
  get(12).error_code = null;
  S.up = false;
  installs.clearPreviewCache();
  pv = await installs.preview(7, L1);
  assert(pv.ok && !pv.verified && pv.room.member_count === 778 && pv.room.max_users === 1500, 'unverified preview of my room keeps the saved count ' + JSON.stringify(pv.room));
  S.up = true;

  // ── 4. 라우트(회원 확인 · 회원당 시간 한도 · 응답 모양) ─────────────────
  await routeChecks();
  process.stdout.write('room move check ok\n');
})().catch((e) => {
  console.error(e && e.stack ? e.stack : e);
  process.exit(1);
});

async function routeChecks() {
  const express = require('express');
  const http = require('http');
  let who = 7;
  memberAuth.requireMember = async (req, res) => {
    if (!who) { res.status(401).json({ ok: false, reason: 'login', error: '로그인해 주세요.' }); return null; }
    return { member: { id: who } };
  };
  const owned = { 12: 7, 30: 9 };
  installs.getForMember = async (mid, id) => (owned[id] === Number(mid)
    ? { row: { id: id, phase: 'installed', roombot: true, minigame: false, config: {} }, view: { id: id, display: 'active', link_url: L2 } } : null);
  const calls = [];
  installs.selfMove = async (id, link, o) => {
    calls.push(['move', id, link, o.memberId, o.passcode, !!o.req]);
    if (link.indexOf('soon') >= 0) return { ok: false, status: 429, reason: 'too_soon', error: '잠시 뒤', retry_after: Date.now() + 90000 };
    return { ok: true, kind: 'move', same_room: false, held: false };
  };
  installs.selfReinstall = async (id, o) => { calls.push(['reinstall', id, o.memberId, o.passcode]); return { ok: true, kind: 'reinstall', same_room: true }; };
  installs.nudge = async () => {};
  const router = require('../routes/panel');
  const app = express();
  app.use(express.json());
  app.use(router);
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  async function post(path, body) {
    const res = await fetch('http://127.0.0.1:' + port + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return { status: res.status, json: await res.json(), retry: res.headers.get('retry-after') };
  }
  try {
    let r = await post('/panel/api/bot-room/move', { id: 12, link: ' ' + L3 });
    assert(r.status === 200 && r.json.ok && r.json.kind === 'move' && r.json.same_room === false && r.json.held === false &&
           r.json.room && r.json.room.id === 12, 'move route ok: ' + JSON.stringify(r.json));
    assert(calls[0][0] === 'move' && calls[0][1] === 12 && calls[0][3] === 7 && calls[0][4] === undefined && calls[0][5] === true, 'route passes member, no passcode, req');
    r = await post('/panel/api/bot-room/move', { id: 30, link: L3 });
    assert(r.status === 404 && r.json.reason === 'not_found' && calls.length === 1, "someone else's room → 404 before installs");
    r = await post('/panel/api/bot-room/move', { id: 'abc', link: L3 });
    assert(r.status === 404, 'bad id → 404');
    r = await post('/panel/api/bot-room/move', { id: 12 });
    assert(r.status === 400 && r.json.reason === 'bad_link', 'missing link → 400');
    r = await post('/panel/api/bot-room/move', { id: 12, link: L3, passcode: { a: 1 } });
    assert(r.status === 400 && r.json.reason === 'bad_passcode', 'object passcode → 400');
    r = await post('/panel/api/bot-room/move', { id: 12, link: L3, passcode: 1234 });
    assert(r.status === 200 && calls[calls.length - 1][4] === '1234', 'numeric passcode → string');
    r = await post('/panel/api/bot-room/move', { id: 12, link: 'soon ' + L3 });
    assert(r.status === 429 && r.json.reason === 'too_soon' && r.json.retry_after > Date.now() && Number(r.retry) >= 89, 'too_soon passes retry_after + Retry-After');
    for (let i = calls.filter((c) => c[0] === 'move').length; i < 20; i++) await post('/panel/api/bot-room/move', { id: 12, link: L3 });
    const before = calls.length;
    r = await post('/panel/api/bot-room/move', { id: 12, link: L3 });
    assert(r.status === 429 && r.json.reason === 'rate_limited' && calls.length === before && Number(r.retry) > 0, '21st move attempt in an hour → 429');
    r = await post('/panel/api/bot-room/reinstall', { id: 12, passcode: ' 77 ' });
    assert(r.status === 200 && r.json.ok && r.json.kind === 'reinstall' && r.json.same_room === true && calls[calls.length - 1][3] === '77', 'reinstall route ok');
    r = await post('/panel/api/bot-room/reinstall', { id: 30 });
    assert(r.status === 404, "reinstall someone else's room → 404");
    who = 0;
    r = await post('/panel/api/bot-room/reinstall', { id: 12 });
    assert(r.status === 401, 'logged out → 401');
  } finally {
    server.close();
  }
}
