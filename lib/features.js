// 기능(feature) 카탈로그 + 기능 상태 맵 계산 (docs/ACCOUNTS_V1.md 0장·4.1)
// 화면 이름·설명의 단일 소스다. lib/pricing.js 의 상품표와 옛 /admin 화면·/api/lookup 이 이 이름을 쓴다.
// 새 구매는 회원 계정에 붙는다(lib/entitle.js). entitlements 표는 예전 라이선스 키의 기간 기록이며,
// 옛 키 경로(/admin/create·/admin/grant·/api/lookup)와 이관 계산(entitle.claimKey)만 읽는다.
'use strict';

const ALL = ['macro', 'roombot', 'minigame'];

const LABELS = {
  macro:    '카카오톡 매크로',
  roombot:  '방 관리봇',
  minigame: '미니게임봇',
};

// 구매 페이지(/api/price)에 그대로 나간다. 서버 발송(sender/)이 실제로 하는 것만 적는다.
//   macro    — 고객 자기 카카오 계정으로 발송: /panel 매크로 · 갠톡 자동 응답 · 저격 규칙
// 화면 용어는 docs/TONE.md 용어집을 따른다(정해진 간격마다 자동 발송 · 기록 · 나간 사람 재입장 차단 · 글 가리기 · 올킥 감지).
//   roombot  — 운영자 K bot 계정이 방에 들어가 관리(방 1개 단위, 기간 없음)
//   minigame — 운영자 K bot 계정이 방에서 미니게임 진행(방 1개 단위, 기간 없음)
const DESCS = {
  macro:    '내 카카오 계정으로 정해진 간격마다 자동 발송 · 이미지 첨부 · 갠톡 자동 응답 · 저격 규칙',
  roombot:  '입장·퇴장 기록 · 들낙 감지 · 나간 사람 재입장 차단 · 프로필 기록 · 홍보 금지 · 글 가리기 · 금지어 검열 · 올킥 감지',
  minigame: '끝말잇기 · 숫자야구 · 주사위 · 가위바위보 · 퀴즈 · 추억의 검 강화 · 랭킹',
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
// 샀지만 아직 시작 안 됨 = { on:false, expires_at:0, plan:'month' } (회원 계정으로 이관할 때 시작, entitle.claimKey)
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
