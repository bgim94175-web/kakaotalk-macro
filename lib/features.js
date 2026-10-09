// 기능(feature) 카탈로그 + 기능 상태 맵 계산
// entitlements 표가 유일한 진실이다. /panel 과 서버 발송(sender/)은 이 표 기준으로만 기능을 연다.
// 판매는 "K bot 1개월" 하나라 새 키는 항상 3종을 같이 갖는다 (lib/pricing.js).
// 기능을 셋으로 나눠 두는 건 예전 키(기능별로 산 키)와 관리자 개별 발급 때문이다.
'use strict';

const ALL = ['macro', 'roombot', 'minigame'];

const LABELS = {
  macro:    '자동발송 매크로',
  roombot:  '대화방 관리봇',
  minigame: '미니게임봇',
};

// 구매 페이지에 그대로 나간다. 서버 발송(sender/src/features.mjs)이 실제로 하는 것만 적는다.
// 단종된 앱에만 있던 기능(메시지 추적, 알림 답장 발송 등)은 적지 않는다.
//   macro    — /panel 매크로 · 갠톡 응답 · 저격 규칙
//   roombot  — /panel 입장·퇴장 로그 · 프로필 로그 · 금지어 검열 · 올킥 방지
//   minigame — 발송 쪽 미니게임 엔진. ★ /panel 에 아직 설정 화면이 없다 (켜는 경로가 없음)
const DESCS = {
  macro:    '대화방 주기 발송 · 이미지 첨부 · 갠톡 자동응답 · 저격 규칙',
  roombot:  '입장·퇴장 로그 · 프로필 변경 감지 · 금지어·링크 가림 · 올킥 감지',
  minigame: '끝말잇기 · 숫자야구 · 주사위 · 가위바위보 · 퀴즈 · 랭킹',
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

// entitlements 행들 → 웹(/api/lookup)에 내려줄 features 맵.
// ★ 항상 3개 키가 ALL 순서로 존재한다 (구매 페이지가 그걸 전제로 짜여 있다).
// 미보유 기능 = { on:false, expires_at:0, plan:null }
// 샀지만 아직 시작 안 됨 = { on:false, expires_at:0, plan:'month' } (/panel 첫 로그인 때 시작)
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

// 전체 기능 중 가장 늦은 만료 (없으면 0)
function maxExpiry(featMap) {
  let m = 0;
  for (const f of ALL) {
    const e = featMap[f] ? Number(featMap[f].expires_at) || 0 : 0;
    if (e > m) m = e;
  }
  return m;
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

// [{id,label,desc}] — 구매 페이지(/api/price)와 관리자 화면에서 목록 뿌릴 때
function catalog() {
  return ALL.map((id) => ({ id: id, label: label(id), desc: desc(id) }));
}

module.exports = {
  ALL, LABELS, DESCS,
  label, desc, isValid, normList, map, maxExpiry, daysLeft,
  purchaseBase, catalog,
};
