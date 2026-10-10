// 라이선스 키 / 주문번호 생성 + 플랜(기간) 계산 + 주문 승인(docs/ACCOUNTS_V1.md 4.2·4.3)
// 새 구매는 회원 계정에 붙는다(lib/entitle.js). 새 라이선스 키는 더 팔지 않는다(D2).
// 키 함수(createLicenses·grant)는 관리자 지원(/admin/create·/admin/grant)과 예전 가격으로 받은 미입금 키 주문 처리용으로 남긴다.
'use strict';

const db = require('./db');
const features = require('./features');

const DAY = 86400000;

// 헷갈리는 글자(I, O, 0, 1) 빼고 32자 — 전화로 불러줄 수 있게
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

const PLANS = {
  month:   { days: 30,  label: '1개월' },
  // quarter / year 는 더 이상 팔지 않는다. 예전 주문·키가 그 플랜으로 남아 있어서
  // 이름표(planLabel)와 기간(durationMs)을 계속 풀어줄 수 있게만 둔다.
  quarter: { days: 90,  label: '3개월' },
  year:    { days: 365, label: '1년' },
};
// 예전 키 주문의 플랜. 새 주문은 plan='member' 이고 기간은 주문 줄(orders.items)이 정한다(lib/pricing.js).
// custom(일수 직접 입력)은 관리자 발급 전용이다.
const SALE_PLANS = ['month'];

// KAKA-XXXX-XXXX-XXXX (구버전과 완전히 같은 형식)
function genKey() {
  const rnd = require('crypto').randomBytes(12);
  let out = 'KAKA';
  for (let i = 0; i < 12; i++) {
    if (i % 4 === 0) out += '-';
    out += ALPHABET[rnd[i] % ALPHABET.length];
  }
  return out;
}

// 사람이 읽을 수 있는 주문번호: ORD-YYMMDD-XXXXXX (X = 대문자+숫자 6자)
function genOrderId(now) {
  const d = new Date(now || Date.now());
  const p = (n) => String(n).padStart(2, '0');
  const ymd = p(d.getFullYear() % 100) + p(d.getMonth() + 1) + p(d.getDate());
  const rnd = require('crypto').randomBytes(6);
  let tail = '';
  for (let i = 0; i < 6; i++) tail += ALPHABET[rnd[i] % ALPHABET.length];
  return 'ORD-' + ymd + '-' + tail;
}

// 사용자가 입력한 키를 표준형으로 (공백 제거 + 대문자)
function normKey(s) {
  if (s === null || s === undefined) return '';
  return String(s).trim().toUpperCase().replace(/\s+/g, '');
}

function normOrderId(s) {
  if (s === null || s === undefined) return '';
  return String(s).trim().toUpperCase().replace(/[^A-Z0-9-]/g, '').slice(0, 32);
}

// 플랜 → 기간(ms). 잘못되면 0 을 돌려준다 (호출한 쪽에서 에러 처리)
function durationMs(plan, days) {
  if (plan === 'custom') {
    const d = Math.floor(Number(days));
    if (!isFinite(d) || d < 1 || d > 3650) return 0;
    return d * DAY;
  }
  const p = PLANS[plan];
  if (!p) return 0;
  return p.days * DAY;
}

function planLabel(plan, days) {
  if (plan === 'custom') return (Math.floor(Number(days)) || 0) + '일';
  return PLANS[plan] ? PLANS[plan].label : String(plan || '');
}

// 중복 안 겹치는 새 키 하나
async function uniqueKey(client) {
  for (let i = 0; i < 40; i++) {
    const k = genKey();
    const r = await db.q('SELECT 1 FROM licenses WHERE key=$1', [k], client);
    if (r.rowCount === 0) return k;
  }
  throw new Error('키 생성에 실패했습니다. 40회 시도 모두 중복되었습니다');
}

// 중복 안 겹치는 새 주문번호
async function uniqueOrderId(client) {
  for (let i = 0; i < 40; i++) {
    const id = genOrderId();
    const r = await db.q('SELECT 1 FROM orders WHERE id=$1', [id], client);
    if (r.rowCount === 0) return id;
  }
  throw new Error('주문번호 생성에 실패했습니다. 40회 시도 모두 중복되었습니다');
}

// 새 키 n개 발급 (+ 기능별 entitlement). 아직 아무도 안 쓴 키라 expires_at 은 NULL 이다.
// 기간은 회원 계정으로 이관할 때 시작한 것으로 계산한다(entitle.claimKey). 관리자 지원용으로만 쓴다.
// opts = { features:[..], plan, days, count, note, owner_name, owner_contact }
async function createLicenses(client, opts) {
  const now = Date.now();
  const feats = features.normList(opts.features);
  if (!feats.length) throw new Error('기능을 1개 이상 선택해 주세요');
  const dur = durationMs(opts.plan, opts.days);
  if (!dur) throw new Error('플랜 또는 일수 값이 올바르지 않습니다');
  const n = Math.min(Math.max(1, Math.floor(Number(opts.count) || 1)), 200);

  const out = [];
  for (let i = 0; i < n; i++) {
    const k = await uniqueKey(client);
    await db.q(
      `INSERT INTO licenses (key, plan, duration_ms, note, created_at, owner_name, owner_contact, reset_count, revoked)
       VALUES ($1,$2,$3,$4,$5,$6,$7,0,FALSE)`,
      [k, opts.plan, dur, opts.note || null, now, opts.owner_name || null, opts.owner_contact || null],
      client);
    for (const f of feats) {
      await db.q(
        `INSERT INTO entitlements (key, feature, plan, starts_at, duration_ms, expires_at, created_at)
         VALUES ($1,$2,$3,NULL,$4,NULL,$5)
         ON CONFLICT (key,feature) DO NOTHING`,
        [k, f, opts.plan, dur, now], client);
    }
    out.push(k);
  }
  return { keys: out, features: feats, duration_ms: dur, duration_days: Math.round(dur / DAY) };
}

// 기존 키에 기능 추가/연장.
// 기간이 시작된 키 → expires_at = max(now, 기존 expires_at) + 기간
// 아직 시작 안 된 키 → expires_at 은 NULL 유지, duration_ms 만 합산 (/panel 첫 로그인 때 한꺼번에 시작)
//
// "시작됐다" = 예전 앱 기기 등록(device_id) · /panel 첫 로그인(activated_at) · 만료일이 잡힌 기능이 하나라도 있음.
// device_id 만 보면 안 된다 — /panel 은 device_id 를 건드리지 않으므로 웹으로만 쓰는 키는 영원히
// "미시작" 으로 보이고, 그 키에 새로 붙인 기능은 expires_at=NULL 로 들어가 다시는 시작되지 않는다
// (/panel 로그인은 macro 가 미시작일 때만 기간을 시작시킨다).
async function grant(client, key, featList, plan, days) {
  const now = Date.now();
  const feats = features.normList(featList);
  if (!feats.length) throw new Error('기능을 1개 이상 선택해 주세요');
  const dur = durationMs(plan, days);
  if (!dur) throw new Error('플랜 또는 일수 값이 올바르지 않습니다');

  const lic = await db.one('SELECT key, device_id, activated_at FROM licenses WHERE key=$1 FOR UPDATE', [key], client);
  if (!lic) return null;

  const rows = await db.entitlements(key, client);
  const byFeat = {};
  let anyStarted = false;
  for (const r of rows) {
    byFeat[r.feature] = r;
    if (r.expires_at !== null && r.expires_at !== undefined) anyStarted = true;
  }
  const activated = !!lic.device_id ||
    (lic.activated_at !== null && lic.activated_at !== undefined) || anyStarted;

  const changed = [];
  for (const f of feats) {
    const cur = byFeat[f] || null;

    if (!cur) {
      const starts = activated ? now : null;
      const exp = activated ? now + dur : null;
      await db.q(
        `INSERT INTO entitlements (key, feature, plan, starts_at, duration_ms, expires_at, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [key, f, plan, starts, dur, exp, now], client);
      changed.push({ feature: f, expires_at: exp, added_days: Math.round(dur / DAY), created: true });
      continue;
    }

    const prevDur = Number(cur.duration_ms) || 0;
    const prevExp = cur.expires_at === null || cur.expires_at === undefined ? null : Number(cur.expires_at);

    if (prevExp === null && !activated) {
      // 아직 안 쓴 키 → 기간만 늘려둔다 (시작하는 순간부터 카운트)
      await db.q(
        'UPDATE entitlements SET duration_ms=$1, plan=$2 WHERE key=$3 AND feature=$4',
        [prevDur + dur, plan, key, f], client);
      changed.push({ feature: f, expires_at: null, added_days: Math.round(dur / DAY), created: false });
    } else {
      // 이미 만료일이 있으면 남은 기간에 더한다 (만료됐으면 지금부터).
      // 키는 시작됐는데 이 기능만 미시작으로 남아 있었다면, 쌓여 있던 기간(prevDur)도 지금부터 같이 센다.
      const exp = prevExp === null ? now + prevDur + dur : Math.max(now, prevExp) + dur;
      await db.q(
        `UPDATE entitlements SET duration_ms=$1, plan=$2, expires_at=$3,
                starts_at=COALESCE(starts_at,$4) WHERE key=$5 AND feature=$6`,
        [prevDur + dur, plan, exp, now, key, f], client);
      changed.push({ feature: f, expires_at: exp, added_days: Math.round(dur / DAY), created: false });
    }
  }
  await db.syncSummary(key, client);
  return { key: key, plan: plan, duration_days: Math.round(dur / DAY), changed: changed, activated: activated };
}

// 주문 승인 — 관리자 [승인] · 입금 매칭과 자동 입금확인이 **같은 로직**을 쓴다(4.2).
// 반드시 트랜잭션 client 안에서 호출해라 (주문 행을 FOR UPDATE 로 잡는다).
// opts.skipConflicts = 충돌한 방 줄을 빼고 나머지를 적용(/admin/order-approve 만 넘긴다).
// 반환:
//   {error, reason?, conflicts?}                 — 아무것도 적용하지 않았다(reason 'room_taken' 이면 needs_review 대상)
//   {ok, already:true, key, member_id, applied}  — 이미 done (멱등)
//   회원 주문:  {ok, already:false, key:null, member_id, applied, installs, order}
//   예전 키 주문: {ok, key, issued, already:false, features, plan, order, member_id?, applied?}
// 커밋 뒤 호출한 쪽이 entitle.afterApprove(결과) 를 부른다.
async function approveOrder(client, id, overrideKey, opts) {
  const now = Date.now();
  const o = await db.one('SELECT * FROM orders WHERE id=$1 FOR UPDATE', [id], client);
  if (!o) return { error: '주문을 찾을 수 없습니다: ' + id };
  if (o.status === 'done') {
    return { ok: true, key: o.issued_key, already: true, member_id: db.num(o.member_id),
             applied: db.jsonOf(o.applied), order: o };
  }
  // 사람이 취소한 주문은 되살리지 않는다. 다만 미입금으로 서버가 자동 취소한 주문은
  // 뒤늦게 입금이 들어오는 경우가 있으니 관리자가 승인하면 그대로 살려준다.
  if (o.status === 'canceled' && !o.auto_canceled) return { error: '이미 취소된 주문입니다: ' + id };

  // ── 회원 주문 ──
  if (o.member_id !== null && o.member_id !== undefined) {
    if (normKey(overrideKey)) return { error: '회원 주문에는 키를 지정할 수 없습니다' };
    const entitle = require('./entitle');
    // 적용 도중 오류로 끝나면 이 주문에 대해 쓴 것을 모두 되돌린다(호출한 쪽 트랜잭션은 계속 쓸 수 있게).
    await db.q('SAVEPOINT kb_apply_order', [], client);
    let r;
    try {
      r = await entitle.applyOrder(client, o, opts || {});
    } catch (e) {
      await db.q('ROLLBACK TO SAVEPOINT kb_apply_order', [], client);
      if (e && e.code === '23505') {
        return { error: '다른 회원이 같은 방을 먼저 결제했습니다: 주문 ' + id, reason: 'room_taken', conflicts: [] };
      }
      throw e;
    }
    if (!r || r.error) {
      await db.q('ROLLBACK TO SAVEPOINT kb_apply_order', [], client);
      return r || { error: '주문을 처리하지 못했습니다: ' + id };
    }
    await db.q('RELEASE SAVEPOINT kb_apply_order', [], client);
    await db.q("UPDATE orders SET status='done', handled_at=$1::bigint, applied=$2::jsonb WHERE id=$3",
      [now, JSON.stringify(r.applied), id], client);
    return { ok: true, already: false, key: null, member_id: Number(o.member_id), applied: r.applied,
             installs: r.installs || [], order: o };
  }

  // ── 예전 키 주문(예전 가격으로 받은 미입금 주문) ──
  const feats = features.normList(String(o.features || '').split(','));
  if (!feats.length) return { error: '주문의 기능 목록이 비어 있습니다: ' + id };
  const plan = String(o.plan || 'month');
  const dur = durationMs(plan, null);
  if (!dur) return { error: '주문의 플랜 값이 올바르지 않습니다: ' + plan };

  let key = normKey(overrideKey) || normKey(o.target_key);
  let issued = false;
  if (key) {
    // 회원에게 이관된 키면 키를 늘리지 않고 그 회원에게 적용한다(D19, 4.2 의 4)
    const lic = await db.one('SELECT key, member_id FROM licenses WHERE key=$1 FOR UPDATE', [key], client);
    if (lic && lic.member_id !== null && lic.member_id !== undefined) {
      const entitle = require('./entitle');
      const memberId = Number(lic.member_id);
      const days = Math.round(dur / DAY);
      const applied = { legacy_to_member: true };
      if (feats.indexOf('macro') >= 0) {
        const until = await entitle.extendMacro(client, memberId, days);
        if (until === null) return { error: '키를 등록한 회원을 찾을 수 없습니다: ' + memberId };
        applied.macro = { days: days, until: until };
      }
      if (feats.some((f) => f !== 'macro')) {
        const lru = await entitle.extendLegacy(client, memberId, days);
        if (lru === null) return { error: '키를 등록한 회원을 찾을 수 없습니다: ' + memberId };
        applied.legacy_room_until = lru;
      }
      await db.q("UPDATE orders SET status='done', handled_at=$1::bigint, issued_key=$2, applied=$3::jsonb WHERE id=$4",
        [now, key, JSON.stringify(applied), id], client);
      return { ok: true, key: key, issued: false, already: false, features: feats, plan: plan,
               member_id: memberId, applied: applied, order: o };
    }
    const g = await grant(client, key, feats, plan, null);
    if (!g) return { error: '연장 대상 키가 없습니다: ' + key };
  } else {
    const c = await createLicenses(client, {
      features: feats, plan: plan, count: 1,
      note: '주문 ' + id, owner_name: o.buyer_name, owner_contact: o.contact,
    });
    key = c.keys[0];
    issued = true;
  }
  await db.q('UPDATE orders SET status=$1, handled_at=$2::bigint, issued_key=$3 WHERE id=$4',
    ['done', now, key, id], client);
  return { ok: true, key: key, issued: issued, already: false, features: feats, plan: plan, order: o };
}

// 입금 없이 방치된 pending 주문은 자동 취소한다.
// 안 그러면 인증 없는 주문 생성만으로 금액 뒷자리 풀(1~99)이 영구히 고갈되고,
// 그 뒤부터는 정상 주문이 전부 suffix=0 + needs_review 로 떨어져 자동 입금확인이 마비된다.
function pendingTtlMs() {
  const n = Number(process.env.ORDER_PENDING_TTL_MS);
  if (isFinite(n) && n > 0) return n;
  return 48 * 3600 * 1000;   // 48시간
}

async function expireStalePending(client, now) {
  const at = now || Date.now();
  const ttl = pendingTtlMs();
  const cutoff = at - ttl;
  const memo = '미입금으로 자동 취소되었습니다 (' + Math.round(ttl / 3600000) + '시간 경과)';
  const r = await db.q(
    `UPDATE orders SET status='canceled', auto_canceled=TRUE, handled_at=$1::bigint,
            memo = COALESCE(memo || ' / ', '') || $2::text
      WHERE status='pending' AND created_at IS NOT NULL AND created_at < $3::bigint
      RETURNING id`,
    [at, memo, cutoff], client);
  const ids = r.rows.map((x) => x.id);
  if (ids.length) {
    // 그 주문이 예약한 입금 대기 설치도 같은 트랜잭션에서 취소한다(4.3, D22)
    await db.q(
      "UPDATE room_installs SET phase='canceled' WHERE phase='pending_payment' AND order_id = ANY($1::text[])",
      [ids], client);
  }
  return ids.length;
}

// 주문 금액 뒷자리(1~99원) 부여 — 대기중인 주문들과 총액이 겹치지 않게 고른다.
// 매칭의 핵심이라 반드시 유일해야 한다. 1~99 가 전부 차면 suffix=0 + needs_review.
// 동시에 주문이 들어와도 같은 최종금액을 고르지 않게 advisory lock 으로 직렬화한다
// (트랜잭션이 끝나면 자동으로 풀린다).
//
// 잠금 키는 base 금액이 아니라 전역 단일 키 하나로 고정한다. 주문 총액(base)은 상품 구성마다 다르고
// (모두 5,000원 배수라 총액이 다르면 뒷자리 구간이 겹치지 않지만) 예전 가격표로 받은 pending 주문이 남아 있을 수 있고, base 가 서로 다르면
// [base+1 .. base+99] 구간은 겹칠 수 있다(예: 128916 과 129000). taken 판정은 amount 절대범위로
// 다른 base 의 pending 주문까지 본다. base 단위로 잠그면 이런 교차-base 동시주문이 서로를
// 직렬화하지 못해 둘 다 같은 최종금액을 고를 수 있다 → 동일 amount pending 2건 → 입금 웹훅에서
// ambiguous 폴백. 전역 단일 키로 추첨 자체를 직렬화해 매칭 유일성을 보장한다. 트래픽이 낮은
// 서비스라 추첨을 전역 직렬화해도 성능 영향은 무시할 수 있다.
const AMOUNT_LOCK_KEY = 0x4b414b4f; // 'KAKO' — 주문 금액 추첨 전용 고정 키
async function pickAmount(client, base) {
  const now = Date.now();
  const baseNum = Math.floor(Number(base)) || 0;
  try {
    await db.q('SELECT pg_advisory_xact_lock($1::bigint)', [AMOUNT_LOCK_KEY], client);
  } catch (e) {
    console.error('[keys] 금액 잠금(advisory lock) 실패 → 잠금 없이 진행: ' + e.message);
  }

  const expired = await expireStalePending(client, now);
  if (expired) console.log('[keys] 미입금으로 방치된 pending 주문 ' + expired + '건을 자동 취소했습니다');

  const r = await db.q(
    "SELECT amount FROM orders WHERE status='pending' AND amount > $1 AND amount <= $2",
    [baseNum, baseNum + 99], client);
  const taken = {};
  for (const row of r.rows) taken[Number(row.amount)] = true;

  const pool = [];
  for (let s = 1; s <= 99; s++) if (!taken[baseNum + s]) pool.push(s);
  if (!pool.length) return { amount: baseNum, suffix: 0, needs_review: true };

  const rnd = require('crypto').randomBytes(2).readUInt16BE(0);
  const suffix = pool[rnd % pool.length];
  return { amount: baseNum + suffix, suffix: suffix, needs_review: false };
}

module.exports = {
  DAY, ALPHABET, PLANS, SALE_PLANS,
  genKey, genOrderId, normKey, normOrderId, durationMs, planLabel,
  uniqueKey, uniqueOrderId, createLicenses, grant, approveOrder, pickAmount,
  pendingTtlMs, expireStalePending,
};
