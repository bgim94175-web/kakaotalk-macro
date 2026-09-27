// 기능(feature) 카탈로그 + 기능 상태 맵 계산
// 서버 응답의 features 맵이 유일한 진실이다. 앱은 절대 자체 판단으로 기능을 열지 않는다.
'use strict';

const ALL = ['macro', 'roombot', 'minigame'];

const LABELS = {
  macro:    '자동발송 매크로',
  roombot:  '방 관리봇',
  minigame: '미니게임봇',
};

const DESCS = {
  macro:    '방별 주기 자동발송 · 이미지 첨부 · 메시지추적 · 오픈프로필 자동응답',
  roombot:  '입/퇴장 인사, 금지어 감지, 도배 감지, 공지 자동안내',
  minigame: '끝말잇기 · 숫자야구 · 주사위 · 퀴즈 · 랭킹',
};

function label(id) { return LABELS[id] || String(id || ''); }
function desc(id) { return DESCS[id] || ''; }
function isValid(id) { return ALL.indexOf(id) >= 0; }

// 입력(배열 또는 쉼표문자열) → 유효한 기능 목록. 중복 제거, ALL 순서 유지.
function normList(input) {
  let arr = input;
  if (typeof arr === 'string') arr = arr.split(',');
  if (!Array.isArray(arr)) return [];
  const set = {};
  for (const raw of arr) {
    const id = String(raw === null || raw === undefined ? '' : raw).trim().toLowerCase();
    if (isValid(id)) set[id] = true;
  }
  return ALL.filter((f) => set[f]);
}

// entitlements 행들 → 앱에 내려줄 features 맵.
// ★ 항상 3개 키가 ALL 순서로 존재한다 (앱이 그걸 전제로 짜여 있다).
// 미보유 기능 = { on:false, expires_at:0, plan:null }
function map(rows, now) {
  const t = now || Date.now();
  const byId = {};
  for (const r of (rows || [])) byId[r.feature] = r;
  const out = {};
  for (const f of ALL) {
    const r = byId[f];
    if (!r) { out[f] = { on: false, expires_at: 0, plan: null }; continue; }
    const exp = r.expires_at === null || r.expires_at === undefined ? 0 : Number(r.expires_at);
    out[f] = {
      on: exp > t,
      expires_at: exp,
      plan: r.plan || null,
    };
  }
  return out;
}

// 켜진 기능이 하나라도 있나
function anyOn(featMap) {
  for (const f of ALL) if (featMap[f] && featMap[f].on) return true;
  return false;
}

// 전체 기능 중 가장 늦은 만료 (없으면 0)
function maxExpiry(featMap) {
  let m = 0;
  for (const f of ALL) {
    const e = featMap[f] ? Number(featMap[f].expires_at) || 0 : 0;
    if (e > m) m = e;
  }
  return m;
}

// 구버전 호환 응답용 대표 plan — 가장 늦게 만료되는 기능의 플랜, 없으면 fallback
function bestPlan(featMap, fallback) {
  let m = -1, plan = null;
  for (const f of ALL) {
    const fm = featMap[f];
    if (!fm) continue;
    const e = Number(fm.expires_at) || 0;
    if (e > m) { m = e; plan = fm.plan || null; }
  }
  return plan || fallback || null;
}

// 남은 일수 (올림, 만료됐으면 0)
function daysLeft(expiresAt, now) {
  const e = Number(expiresAt) || 0;
  const t = now || Date.now();
  if (e <= t) return 0;
  return Math.ceil((e - t) / 86400000);
}

// 구매 사이트 기준 주소. PURCHASE_BASE → RENDER_EXTERNAL_URL → 요청 헤더 순
function purchaseBase(req) {
  let base = process.env.PURCHASE_BASE || process.env.RENDER_EXTERNAL_URL || process.env.SELF_URL || '';
  if (!base && req) {
    const proto = String(req.headers['x-forwarded-proto'] || req.protocol || 'https').split(',')[0].trim();
    const host = req.headers['x-forwarded-host'] || req.headers.host;
    if (host) base = proto + '://' + host;
  }
  return String(base).replace(/\/+$/, '');
}

// 구매 딥링크: {PURCHASE_BASE}/buy?feature=<id>&key=<키 또는 생략>
function buyUrl(req, feature, key) {
  const qs = [];
  if (feature && isValid(feature)) qs.push('feature=' + encodeURIComponent(feature));
  if (key) qs.push('key=' + encodeURIComponent(key));
  return purchaseBase(req) + '/buy' + (qs.length ? '?' + qs.join('&') : '');
}

// [{id,label,desc}] — 웹/관리자앱에서 목록 뿌릴 때
function catalog() {
  return ALL.map((id) => ({ id: id, label: label(id), desc: desc(id) }));
}

module.exports = {
  ALL, LABELS, DESCS,
  label, desc, isValid, normList, map, anyOn, maxExpiry, bestPlan, daysLeft,
  purchaseBase, buyUrl, catalog,
};
