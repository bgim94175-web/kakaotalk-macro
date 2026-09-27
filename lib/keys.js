// 라이선스 키 / 주문번호 생성 + 플랜(기간) 계산
'use strict';

const db = require('./db');
const features = require('./features');

const DAY = 86400000;

// 헷갈리는 글자(I, O, 0, 1) 빼고 32자 — 전화로 불러줄 수 있게
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

const PLANS = {
  month:   { days: 30,  label: '1개월' },
  quarter: { days: 90,  label: '3개월' },
  year:    { days: 365, label: '1년' },
};
// 웹에서 팔 수 있는 플랜 (custom 은 관리자 전용)
const SALE_PLANS = ['month', 'quarter', 'year'];

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

// 사람이 읽을 수 있는 주문번호: ORD-YYMMDD + 4자 랜덤
function genOrderId(now) {
  const d = new Date(now || Date.now());
  const p = (n) => String(n).padStart(2, '0');
  const ymd = p(d.getFullYear() % 100) + p(d.getMonth() + 1) + p(d.getDate());
  const rnd = require('crypto').randomBytes(4);
  let tail = '';
  for (let i = 0; i < 4; i++) tail += ALPHABET[rnd[i] % ALPHABET.length];
  return 'ORD-' + ymd + tail;
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
  throw new Error('키 생성 실패 — 40번 시도했는데 계속 중복이야');
}

// 중복 안 겹치는 새 주문번호
async function uniqueOrderId(client) {
  for (let i = 0; i < 40; i++) {
    const id = genOrderId();
    const r = await db.q('SELECT 1 FROM orders WHERE id=$1', [id], client);
    if (r.rowCount === 0) return id;
  }
  throw new Error('주문번호 생성 실패 — 40번 시도했는데 계속 중복이야');
}

// 새 키 n개 발급 (+ 기능별 entitlement). 기기 활성화 전이므로 expires_at 은 NULL.
// opts = { features:[..], plan, days, count, note, owner_name, owner_contact }
async function createLicenses(client, opts) {
  const now = Date.now();
  const feats = features.normList(opts.features);
  if (!feats.length) throw new Error('기능을 하나 이상 골라야 해');
  const dur = durationMs(opts.plan, opts.days);
  if (!dur) throw new Error('플랜 또는 일수가 잘못됐어');
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
// 활성화된 키(device_id 있음) → expires_at = max(now, 기존 expires_at) + 기간
// 아직 활성화 안 된 키 → expires_at 은 NULL 유지, duration_ms 만 합산
async function grant(client, key, featList, plan, days) {
  const now = Date.now();
  const feats = features.normList(featList);
  if (!feats.length) throw new Error('기능을 하나 이상 골라야 해');
  const dur = durationMs(plan, days);
  if (!dur) throw new Error('플랜 또는 일수가 잘못됐어');

  const lic = await db.one('SELECT key, device_id FROM licenses WHERE key=$1 FOR UPDATE', [key], client);
  if (!lic) return null;
  const activated = !!lic.device_id;

  const changed = [];
  for (const f of feats) {
    const cur = await db.one(
      'SELECT feature, starts_at, duration_ms, expires_at FROM entitlements WHERE key=$1 AND feature=$2',
      [key, f], client);

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
      // 아직 안 쓴 키 → 기간만 늘려둔다 (활성화하는 순간부터 카운트)
      await db.q(
        'UPDATE entitlements SET duration_ms=$1, plan=$2 WHERE key=$3 AND feature=$4',
        [prevDur + dur, plan, key, f], client);
      changed.push({ feature: f, expires_at: null, added_days: Math.round(dur / DAY), created: false });
    } else {
      // 남은 기간에 더하기 (이미 만료됐으면 지금부터)
      const base = Math.max(now, prevExp === null ? now : prevExp);
      const exp = base + dur;
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

module.exports = {
  DAY, ALPHABET, PLANS, SALE_PLANS,
  genKey, genOrderId, normKey, normOrderId, durationMs, planLabel,
  uniqueKey, uniqueOrderId, createLicenses, grant,
};
