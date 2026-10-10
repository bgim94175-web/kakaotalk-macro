// 회원 권리 — 매크로 기간 · 주문 적용 · 기존 키 이관 · sender 로 권리 밀기 (docs/ACCOUNTS_V1.md 4.2·4.5·4.6·D6·D7·D19~D21)
//
// 모든 구매·지급은 회원(members)에 붙는다(D2).
//   macro_until       카카오톡 매크로 만료(ms). 다시 사면 max(지금, 만료) + 30일 × 개월(D6).
//   legacy_room_until 기존 키로 쓰던 계정 단위 옛 기능(입장·퇴장 로그 등 4개 화면)의 유예 만료(D20).
// sender 는 고객 카카오 계정마다 kakao_sessions.features = {v:2, macro_until, legacy_room_until} 로 권리를 판정한다.
// 부모는 그 값을 /v1/grants 로 민다(pushGrants). sender 는 받은 시각 값으로 스스로 만료를 판정하므로
// 밀기를 놓쳐도 만료는 정확하다. 첫 전체 밀기 전까지 기존 기록은 v1 의미라 SENDER_READY 마다 전체를 민다.
'use strict';

const db = require('./db');
const senderChild = require('./sender-child');
const installs = require('./installs');
const audit = require('./audit');

const DAY = 86400000;
const MAX_ACCOUNTS = Math.max(1, parseInt(process.env.MEMBER_MAX_ACCOUNTS, 10) || 3);
const PUSH_EVERY_MS = 10 * 60 * 1000;
const CLEANUP_FIRST_MS = 10 * 60 * 1000;
const CLEANUP_EVERY_MS = 24 * 3600 * 1000;
const BOT_ID_RE = /^bot\.[0-9a-f]{16}$/;

function envNum(name, dflt) {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : dflt;
}

function toId(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(String(v).trim());
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

function fail(status, reason, error) {
  return { ok: false, status: status, reason: reason, error: error };
}

function normKey(s) {
  if (s === null || s === undefined) return '';
  return String(s).trim().toUpperCase().replace(/\s+/g, '');
}

// -> {until, active, days_left}
function macroView(member, now) {
  const t = now == null ? Date.now() : Number(now);
  const until = member ? Number(member.macro_until) || 0 : 0;
  const active = until > t;
  return { until, active, days_left: active ? Math.ceil((until - t) / DAY) : 0 };
}

// 매크로 기간 연장: macro_until = GREATEST(macro_until, now) + days. → 새 until(ms). 회원이 없으면 null.
async function extendMacro(client, memberId, days) {
  const mid = toId(memberId);
  const d = Math.floor(Number(days));
  if (!mid) return null;
  if (!Number.isFinite(d) || d < 1 || d > 36500) throw new Error('매크로 일수가 올바르지 않습니다: ' + days);
  const r = await db.q(
    `UPDATE members SET macro_until = GREATEST(macro_until, $2::bigint) + $3::bigint
      WHERE id=$1 RETURNING macro_until`, [mid, Date.now(), d * DAY], client);
  return r.rows[0] ? Number(r.rows[0].macro_until) : null;
}

// 계정 단위 옛 기능 유예 연장(옛 키 주문이 이관된 키를 가리킨 경우, 4.2 의 4)
async function extendLegacy(client, memberId, days) {
  const r = await db.q(
    `UPDATE members SET legacy_room_until = GREATEST(legacy_room_until, $2::bigint) + $3::bigint
      WHERE id=$1 RETURNING legacy_room_until`, [memberId, Date.now(), Math.floor(days) * DAY], client);
  return r.rows[0] ? Number(r.rows[0].legacy_room_until) : null;
}

// ── 기존 키 이관(4.6) ──────────────────────────────────────────────────────
// 한 트랜잭션 client 안에서 부른다. opts.req(또는 opts.ip)를 주면 감사 기록에 이관 IP 를 남긴다(D19).
// 감사 기록(member claim)은 이 함수가 같은 트랜잭션으로 쓴다. 커밋 뒤 pushGrants(memberId) 는 호출한 쪽이 부른다.
async function claimKey(client, memberId, key, opts) {
  const mid = toId(memberId);
  const k = normKey(key);
  const notFound = fail(404, 'not_found', '키를 찾을 수 없습니다. 키를 확인해 주세요.');
  if (!mid || !k) return notFound;
  const lic = await db.one('SELECT key, member_id, revoked, blocked_reason FROM licenses WHERE key=$1 FOR UPDATE', [k], client);
  if (!lic) return notFound;
  if (lic.member_id !== null && lic.member_id !== undefined) {
    return fail(409, 'claimed', '이미 다른 아이디에 등록된 키입니다. 본인의 키라면 문의해 주세요.');
  }
  if (lic.revoked || lic.blocked_reason) {
    return fail(403, 'key_blocked', '사용이 중지된 키는 등록할 수 없습니다. 문의해 주세요.');
  }
  const now = Date.now();
  const ents = await db.q('SELECT feature, duration_ms, expires_at FROM entitlements WHERE key=$1', [k], client);
  let macroExp = 0;
  let maxExp = 0;
  for (const e of ents.rows) {
    // 미개시 기능은 지금 시작한 것으로 본다(키 행은 바꾸지 않고 계산만)
    const exp = e.expires_at === null || e.expires_at === undefined
      ? now + (Number(e.duration_ms) || 0)
      : Number(e.expires_at);
    if (e.feature === 'macro') macroExp = Math.max(macroExp, exp);
    if (exp > maxExp) maxExp = exp;
  }
  const rem = Math.max(0, macroExp - now);
  const m = await db.one(
    `UPDATE members
        SET macro_until = CASE WHEN $3::bigint > 0 THEN GREATEST(macro_until, $2::bigint) + $3::bigint ELSE macro_until END,
            legacy_room_until = GREATEST(legacy_room_until, $4::bigint)
      WHERE id=$1 RETURNING macro_until, legacy_room_until`,
    [mid, now, rem, maxExp], client);
  if (!m) return fail(404, 'no_member', '회원을 찾을 수 없습니다.');
  await db.q('UPDATE licenses SET member_id=$2, claimed_at=$3 WHERE key=$1', [k, mid, now], client);
  const acc = await db.q('UPDATE panel_accounts SET member_id=$2 WHERE license_key=$1 AND member_id IS NULL', [k, mid], client);
  await db.q('UPDATE panel_pending SET member_id=$2 WHERE license_key=$1 AND member_id IS NULL', [k, mid], client);
  const moved = {
    macro_until: Number(m.macro_until) || 0,
    legacy_room_until: Number(m.legacy_room_until) || 0,
    accounts: acc.rowCount || 0,
  };
  const info = { key: k, member_id: mid,
    detail: 'claim 키 이관 / 매크로 +' + Math.round(rem / DAY) + '일 / 계정 ' + moved.accounts + '개' };
  const o = opts || {};
  if (o.req) await audit.record(o.req, 'member', info, client);
  else await audit.log('member', Object.assign({ ip: o.ip || null }, info), client);
  return { ok: true, moved: moved };
}

// 잘못 이관된 키 옮기기(/admin/license-reassign, D19). memberId=null 이면 이관 취소.
// 이전 회원의 세션은 같은 트랜잭션에서 모두 끝낸다(why 'admin'). 감사 member claim_reassign 도 여기서 쓴다.
// 커밋 뒤 두 회원 pushGrants 와 memberAuth.endAllSessions(이전 회원, 세션 메모리 지우기)는 호출한 쪽이 부른다.
// 매크로 기간은 자동으로 다시 계산하지 않는다(관리자가 member-grant 로 조정).
async function reassignKey(client, key, memberId, opts) {
  const k = normKey(key);
  if (!k) return { error: '키를 입력해 주세요.' };
  const lic = await db.one('SELECT key, member_id FROM licenses WHERE key=$1 FOR UPDATE', [k], client);
  if (!lic) return { error: '키를 찾을 수 없습니다: ' + k };
  const from = toId(lic.member_id);
  let to = null;
  if (memberId !== null && memberId !== undefined && memberId !== '') {
    to = toId(memberId);
    if (!to) return { error: '회원 번호가 올바르지 않습니다' };
    const m = await db.one('SELECT id FROM members WHERE id=$1', [to], client);
    if (!m) return { error: '회원을 찾을 수 없습니다: ' + to };
  }
  if (from === to) return { error: to ? '이미 그 회원에게 등록된 키입니다' : '회원에게 등록되지 않은 키입니다' };
  const now = Date.now();
  await db.q(
    'UPDATE licenses SET member_id=$2::bigint, claimed_at=CASE WHEN $2::bigint IS NULL THEN NULL ELSE $3::bigint END WHERE key=$1',
    [k, to, now], client);
  const acc = await db.q('UPDATE panel_accounts SET member_id=$2::bigint WHERE license_key=$1', [k, to], client);
  await db.q('UPDATE panel_pending SET member_id=$2::bigint WHERE license_key=$1', [k, to], client);
  let ended = 0;
  if (from) {
    const s = await db.q(
      "UPDATE member_sessions SET revoked_at=$2, revoked_why='admin' WHERE member_id=$1 AND revoked_at IS NULL",
      [from, now], client);
    ended = s.rowCount || 0;
  }
  const info = { key: k, member_id: to || from,
    detail: 'claim_reassign 회원 ' + (from || '없음') + ' → ' + (to || '없음') + ' / 계정 ' + (acc.rowCount || 0) + '개' };
  const o = opts || {};
  if (o.req) await audit.record(o.req, 'member', info, client);
  else await audit.log('member', Object.assign({ ip: o.ip || null }, info), client);
  return { ok: true, from: from, to: to, accounts: acc.rowCount || 0, sessions_ended: ended };
}

// ── 주문 적용(4.2 의 3) ────────────────────────────────────────────────────
function conflictText(c) {
  if (c.why === 'room_taken') return '다른 회원이 같은 방을 먼저 결제했습니다: 방 #' + (c.taken_id || c.install_id);
  if (c.why === 'duplicate') return '같은 방이 이미 등록되어 있습니다: 방 #' + (c.other_id || c.install_id);
  if (c.why === 'blocked') return 'K bot을 설치할 수 없는 방입니다: 방 #' + c.install_id;
  if (c.why === 'removed') return '설치를 해제한 방입니다: 방 #' + c.install_id;
  if (c.why === 'other_member') return '다른 회원의 방입니다: 방 #' + c.install_id;
  return '방을 찾을 수 없습니다: 방 #' + c.install_id;
}

// 회원 주문 1건을 적용한다. 트랜잭션 client 안에서 keys.approveOrder 가 부른다.
// opts.skipConflicts = 충돌한 방 줄을 applied.skipped 로 빼고 나머지를 적용(/admin/order-approve 만).
// → {ok, applied, installs:[id…]} | {error, reason?, conflicts?}
// 충돌·금지·해제 검사를 쓰기 전에 모두 끝낸다(오류로 끝나면 아무것도 쓰지 않는다).
async function applyOrder(client, orderRow, opts) {
  const o = orderRow || {};
  const skip = !!(opts && opts.skipConflicts);
  const memberId = toId(o.member_id);
  if (!memberId) return { error: '회원 주문이 아닙니다: ' + o.id };
  // 차단된 회원이어도 적용한다(돈은 들어왔다).
  const member = await db.one('SELECT id FROM members WHERE id=$1 FOR UPDATE', [memberId], client);
  if (!member) return { error: '주문한 회원이 없습니다: ' + memberId };

  const items = db.jsonOf(o.items);
  if (!Array.isArray(items) || !items.length) return { error: '주문 줄이 비어 있습니다: ' + o.id };

  let months = 0;
  const groups = new Map();   // install_id → {products:Set, amount, link_name, link_url, hold}
  for (const it of items) {
    if (!it || typeof it !== 'object') continue;
    if (it.product === 'macro') {
      const n = Math.floor(Number(it.months));
      if (!Number.isFinite(n) || n < 0 || n > 120) return { error: '주문의 매크로 개월 수가 올바르지 않습니다: ' + it.months };
      months += n;
    } else if (it.product === 'roombot' || it.product === 'minigame') {
      const iid = toId(it.install_id);
      if (!iid) return { error: '주문 줄에 방 번호가 없습니다: ' + o.id };
      const g = groups.get(iid) || { products: new Set(), amount: 0, link_name: null, link_url: null, hold: false };
      g.products.add(it.product);
      g.amount += Number(it.amount) || 0;
      if (it.link_name) g.link_name = it.link_name;
      if (it.link_url) g.link_url = it.link_url;
      if (it.hold) g.hold = true;
      groups.set(iid, g);
    }
  }

  // 1단계: 행 잠금 + 검사
  const plans = [];
  const conflicts = [];
  for (const [iid, g] of groups) {
    const row = await db.one('SELECT * FROM room_installs WHERE id=$1 FOR UPDATE', [iid], client);
    const c = { install_id: iid, link_name: g.link_name || (row && row.link_name) || null,
                link_url: (row && row.link_url) || g.link_url || null,
                products: ['roombot', 'minigame'].filter((p) => g.products.has(p)), amount: g.amount, why: null, row: row };
    if (!row) c.why = 'missing';
    else if (toId(row.member_id) !== memberId) c.why = 'other_member';
    else if (row.phase === 'removed') c.why = 'removed';
    else if (row.phase === 'pending_payment' || row.phase === 'canceled') {
      const cf = await installs.conflictFor(client, { selfId: iid, memberId: memberId, linkId: row.link_id, linkUrl: row.link_url });
      if (cf.taken) { c.why = 'room_taken'; c.taken_id = Number(cf.taken.id); }
      else if (row.phase === 'canceled' && cf.mine) { c.why = 'duplicate'; c.other_id = Number(cf.mine.id); }
      else if (await installs.isBlocked(client, { linkId: row.link_id, linkUrl: row.link_url })) c.why = 'blocked';
    }
    if (c.why) conflicts.push(c);
    else plans.push({ row: row, g: g });
  }
  if (conflicts.length && !skip) {
    return {
      error: conflictText(conflicts[0]),
      reason: 'room_taken',
      conflicts: conflicts.map((c) => ({ install_id: c.install_id, link_name: c.link_name, link_url: c.link_url,
        products: c.products, amount: c.amount, why: c.why })),
    };
  }

  // 2단계: 쓰기
  const now = Date.now();
  const applied = { rooms: [] };
  const touched = [];
  if (months > 0) {
    const days = months * 30;
    const until = await extendMacro(client, memberId, days);
    applied.macro = { days: days, until: until };
  }
  for (const p of plans) {
    const row = p.row;
    const want = { roombot: p.g.products.has('roombot'), minigame: p.g.products.has('minigame') };
    const setR = !!row.roombot || want.roombot;
    const setM = !!row.minigame || want.minigame;
    const gd = installs.withGamesDefault(row, setM);
    const cfgBump = gd.changed ? 1 : 0;
    if (row.phase === 'installed') {
      await db.q(
        `UPDATE room_installs SET roombot=$2, minigame=$3, config=$4::jsonb, config_rev=config_rev + $5::int,
                config_at=CASE WHEN $5::int > 0 THEN $6::bigint ELSE config_at END
          WHERE id=$1`, [row.id, setR, setM, JSON.stringify(gd.config), cfgBump, now], client);
    } else {
      // pending_payment(또는 자동 취소에서 되살리는 canceled) → installed
      const word = (p.g.hold || installs.holdWordFor(row.link_name || p.g.link_name))
        ? (installs.holdWordFor(row.link_name || p.g.link_name) || '') : null;
      const hold = word === null ? null : 'name:' + word;
      await db.q(
        `UPDATE room_installs SET phase='installed', installed_at=$2::bigint, roombot=$3, minigame=$4,
                config=$5::jsonb, config_rev=config_rev + $6::int,
                config_at=CASE WHEN $6::int > 0 THEN $2::bigint ELSE config_at END,
                hold_reason=$7, bot_device_id=NULL,
                state='queued', error_code=NULL, error_detail=NULL, next_try_at=NULL, perm=NULL, perm_at=NULL, state_at=$2::bigint
          WHERE id=$1`, [row.id, now, setR, setM, JSON.stringify(gd.config), cfgBump, hold], client);
      if (!hold) await installs.assignBot(client, row.id);
    }
    applied.rooms.push({ install_id: Number(row.id), products: ['roombot', 'minigame'].filter((x) => want[x]) });
    touched.push(Number(row.id));
  }
  if (conflicts.length) {
    applied.skipped = [];
    for (const c of conflicts) {
      if (c.row && c.row.phase === 'pending_payment') {
        await db.q("UPDATE room_installs SET phase='canceled' WHERE id=$1 AND phase='pending_payment'", [c.install_id], client);
      }
      applied.skipped.push({ install_id: c.install_id, products: c.products, amount: c.amount, why: c.why });
    }
  }
  return { ok: true, applied: applied, installs: touched };
}

// ── 커밋 뒤 ────────────────────────────────────────────────────────────────
// keys.approveOrder 결과를 받는다. 이미 처리된 주문이거나 회원이 없으면 아무것도 하지 않는다.
// 기다리지 않는다. 실패는 로그만 남긴다.
function afterApprove(result) {
  if (!result || result.already || result.error) return;
  const mid = toId(result.member_id);
  if (!mid) return;
  const ids = Array.isArray(result.installs) ? result.installs.map(toId).filter(Boolean) : [];
  setImmediate(() => {
    Promise.resolve()
      .then(() => pushGrants(mid))
      .then(() => {
        if (!ids.length) return null;
        if (ids.length > 5) return installs.nudge(null);
        return Promise.all(ids.map((id) => installs.nudge(id)));
      })
      .catch((e) => console.error('[entitle] afterApprove 실패 member=' + mid + ' → ' + (e && e.message ? e.message : e)));
  });
}

// ── 권리 밀기(4.5) ─────────────────────────────────────────────────────────
// 고객 device 마다 {v:2, macro_until, legacy_room_until}.
//   회원 소유(panel_accounts.member_id, 또는 이관된 키 licenses.member_id): 회원 값. 차단 회원이면 둘 다 0.
//   미이관 키 소유: macro_until = 그 키 macro 만료(미개시 0), legacy_room_until = 그 키 기능 만료 최댓값. 회수·차단 키면 0.
async function grantsFor(memberId) {
  const r = await db.q(
    `SELECT pa.device_id, pa.license_key,
            COALESCE(pa.member_id, l.member_id) AS mid,
            m.macro_until, m.legacy_room_until, m.blocked_reason AS m_blocked,
            l.revoked AS l_revoked, l.blocked_reason AS l_blocked
       FROM panel_accounts pa
       LEFT JOIN licenses l ON l.key = pa.license_key
       LEFT JOIN members m ON m.id = COALESCE(pa.member_id, l.member_id)
      WHERE ($1::bigint IS NULL OR COALESCE(pa.member_id, l.member_id) = $1::bigint)`,
    [memberId]);
  const keyList = [];
  for (const row of r.rows) if ((row.mid === null || row.mid === undefined) && row.license_key) keyList.push(row.license_key);
  const ents = new Map();   // key → {macro, max}
  if (keyList.length) {
    const e = await db.q('SELECT key, feature, expires_at FROM entitlements WHERE key = ANY($1::text[])', [keyList]);
    for (const x of e.rows) {
      const cur = ents.get(x.key) || { macro: 0, max: 0 };
      const exp = x.expires_at === null || x.expires_at === undefined ? 0 : Number(x.expires_at);
      if (x.feature === 'macro') cur.macro = Math.max(cur.macro, exp);
      cur.max = Math.max(cur.max, exp);
      ents.set(x.key, cur);
    }
  }
  const grants = {};
  for (const row of r.rows) {
    const dev = String(row.device_id || '');
    if (!dev || BOT_ID_RE.test(dev)) continue;
    let g = { v: 2, macro_until: 0, legacy_room_until: 0 };
    if (row.mid !== null && row.mid !== undefined) {
      if (row.macro_until !== null && row.macro_until !== undefined && !row.m_blocked) {
        g = { v: 2, macro_until: Number(row.macro_until) || 0, legacy_room_until: Number(row.legacy_room_until) || 0 };
      }
    } else if (row.license_key && !row.l_revoked && !row.l_blocked) {
      const e = ents.get(row.license_key) || { macro: 0, max: 0 };
      g = { v: 2, macro_until: e.macro, legacy_room_until: e.max };
    }
    grants[dev] = g;
  }
  return grants;
}

// memberId = null 이면 전체({full:true, as_of}). sender 가 없으면 건너뛴다. 실패는 로그만.
// → {ok, applied?, stopped?, devices} | {ok:false, skipped|error}
async function pushGrants(memberId) {
  const full = memberId === null || memberId === undefined;
  const mid = full ? null : toId(memberId);
  if (!full && !mid) return { ok: false, error: 'bad_member' };
  if (!senderChild.up()) return { ok: false, skipped: 'sender_down' };
  try {
    const asOf = Date.now();               // DB 를 읽기 시작한 시각(3.6 의 경합 방지 기준)
    const grants = await grantsFor(mid);
    const n = Object.keys(grants).length;
    if (!full && !n) return { ok: true, devices: 0 };
    const body = full ? { grants: grants, full: true, as_of: asOf } : { grants: grants };
    const r = await senderChild.call('POST', '/v1/grants', body, 30000);
    const j = r && r.json ? r.json : null;
    if (!r || r.status !== 200 || !j || j.ok !== true) {
      console.error('[entitle] /v1/grants 응답 ' + (r ? r.status : '-') + ' ' + (j && j.error ? j.error : '') +
                    ' (' + (full ? '전체' : '회원 ' + mid) + ')');
      return { ok: false, error: 'sender_error', status: r ? r.status : 0 };
    }
    return { ok: true, devices: n, applied: Number(j.applied) || 0, stopped: Number(j.stopped) || 0 };
  } catch (e) {
    console.error('[entitle] 권리 밀기 실패 (' + (full ? '전체' : '회원 ' + mid) + ') → ' + (e && e.message ? e.message : e));
    return { ok: false, error: e && e.code ? e.code : 'error' };
  }
}

// ── 하루 1번 정리(4.5 의 3) ────────────────────────────────────────────────
async function cleanup(nowArg) {
  const now = nowArg == null ? Date.now() : Number(nowArg);
  const keepDays = envNum('ROOM_LOG_KEEP_DAYS', 30);
  const out = {};
  const steps = [
    ['room_log', 'DELETE FROM room_log WHERE at < $1', [now - keepDays * DAY]],
    ['room_leaves', 'DELETE FROM room_leaves WHERE done_at IS NOT NULL AND done_at < $1', [now - 30 * DAY]],
    ['member_sessions', 'DELETE FROM member_sessions WHERE expires_at < $1 OR (revoked_at IS NOT NULL AND revoked_at < $1)', [now - 30 * DAY]],
    ['bot_pending', 'DELETE FROM bot_pending WHERE expires_at < $1', [now]],
  ];
  for (const [name, sql, params] of steps) {
    try {
      const r = await db.q(sql, params);
      out[name] = r.rowCount || 0;
    } catch (e) {
      out[name] = -1;
      console.error('[entitle] 정리 실패 ' + name + ' → ' + (e && e.message ? e.message : e));
    }
  }
  const total = Object.values(out).filter((n) => n > 0).reduce((a, b) => a + b, 0);
  if (total) console.log('[entitle] 오래된 기록 정리: ' + Object.keys(out).map((k) => k + '=' + out[k]).join(' '));
  return out;
}

let loopStarted = false;

// server.js 가 listen 뒤 1번 부른다.
//   1. SENDER_READY 마다 전체 권리 밀기 + /v1/bot/sync(전체)
//   2. 10분마다 전체 권리 밀기
//   3. 하루 1번(부팅 10분 뒤 시작) 오래된 기록 정리
function startLoop() {
  if (loopStarted) return;
  loopStarted = true;
  senderChild.onReady(() => {
    pushGrants(null).then(() => installs.nudge(null))
      .catch((e) => console.error('[entitle] SENDER_READY 처리 실패 → ' + (e && e.message ? e.message : e)));
  });
  const t = setInterval(() => { pushGrants(null); }, PUSH_EVERY_MS);
  if (t.unref) t.unref();
  const run = () => {
    cleanup().catch(() => {}).then(() => {
      const n = setTimeout(run, CLEANUP_EVERY_MS);
      if (n.unref) n.unref();
    });
  };
  const first = setTimeout(run, CLEANUP_FIRST_MS);
  if (first.unref) first.unref();
}

// /api/me · /account 요약. rooms_list(최대 50)는 덤으로 준다(같은 조회를 두 번 하지 않게).
async function summary(memberId) {
  const mid = toId(memberId);
  const m = mid ? await db.one('SELECT macro_until, legacy_room_until FROM members WHERE id=$1', [mid]) : null;
  const acc = mid ? await db.one('SELECT count(*)::int AS n FROM panel_accounts WHERE member_id=$1', [mid]) : null;
  const list = mid ? await installs.listForMember(mid) : [];
  let active = 0;
  let attention = 0;
  for (const v of list) {
    if (v.display === 'active') active += 1;
    if (v.display === 'error' || v.display === 'waiting') attention += 1;
  }
  return {
    macro: macroView(m),
    legacy_room_until: m ? Number(m.legacy_room_until) || 0 : 0,
    accounts: { n: acc ? Number(acc.n) || 0 : 0, max: MAX_ACCOUNTS },
    rooms: { total: list.length, active: active, attention: attention },
    rooms_list: list.slice(0, 50),
  };
}

module.exports = {
  MAX_ACCOUNTS,
  macroView,
  extendMacro,
  extendLegacy,
  claimKey,
  applyOrder,
  afterApprove,
  pushGrants,
  grantsFor,
  startLoop,
  cleanup,
  reassignKey,
  summary,
};
