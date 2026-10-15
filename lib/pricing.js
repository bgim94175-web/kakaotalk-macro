// 가격표 — 서버 단일 소스 (docs/ACCOUNTS_V1.md 4.1). 가격을 바꿀 땐 이 파일만 고친다.
// 구매 페이지(/api/price) · 주문 금액(/api/order) · 관리자 화면이 전부 여기서 나온 값을 쓴다.
//
// 상품은 3종이다.
//   macro    카카오톡 매크로  15,000원 / 1개월(30일). 1~12개월. 다시 사면 만료일 뒤로 이어진다.
//   roombot  방 관리봇        10,000원 / 방 1개. 기간 없음(영구 설치).
//   minigame 미니게임봇       10,000원 / 방 1개. 기간 없음(영구 설치).
// 금액 = macro_months × 15000 + (방 상품 줄 수) × 10000. 할인 없음. 주문 1건 최대 380,000원(D24).
// 방 상품 값을 바꿔도 이미 낸 주문·설치한 방은 그대로다(주문 줄에 그때의 unit_price·amount 가 남는다).
// 화면 이름·설명은 lib/features.js 의 LABELS·DESCS 가 단일 소스다(옛 /admin 화면·/api/lookup 도 같은 이름을 쓴다).
'use strict';

const features = require('./features');

const CURRENCY = 'KRW';
const MAX_ROOMS = 10;

function freeze(o) {
  Object.values(o).forEach((v) => { if (v && typeof v === 'object') freeze(v); });
  return Object.freeze(o);
}

const PRODUCTS = freeze({
  macro:    { id: 'macro',    label: features.LABELS.macro,    unit: 'month', price: 15000, days: 30, min: 1, max: 12,
              desc: features.DESCS.macro },
  roombot:  { id: 'roombot',  label: features.LABELS.roombot,  unit: 'room',  price: 10000,
              desc: features.DESCS.roombot },
  minigame: { id: 'minigame', label: features.LABELS.minigame, unit: 'room',  price: 10000,
              desc: features.DESCS.minigame },
});

// 방에 설치하는 상품(방 1개 단위)
const ROOM_PRODUCTS = ['roombot', 'minigame'];

function label(id) {
  return PRODUCTS[id] ? PRODUCTS[id].label : String(id == null ? '' : id);
}

// 방 줄의 상품 목록 정규화 → ROOM_PRODUCTS 순서, 중복 제거. 모르는 값은 버린다.
function roomProducts(input) {
  let arr = input;
  if (arr && typeof arr === 'object' && !Array.isArray(arr)) {
    arr = ROOM_PRODUCTS.filter((p) => !!arr[p]);
  }
  if (typeof arr === 'string') arr = arr.split(',');
  if (!Array.isArray(arr)) return [];
  const set = {};
  for (const raw of arr) set[String(raw == null ? '' : raw).trim().toLowerCase()] = true;
  return ROOM_PRODUCTS.filter((p) => set[p]);
}

// 개월 수 해석. 비었으면 0. 정수가 아니면 NaN.
function parseMonths(v) {
  if (v === undefined || v === null || v === '' || v === false) return 0;
  const n = typeof v === 'number' ? v : Number(String(v).trim());
  if (!Number.isFinite(n) || Math.floor(n) !== n) return NaN;
  return n;
}

function fail(reason, error, room) {
  const out = { ok: false, reason: reason, error: error };
  if (room !== undefined) out.room = room;
  return out;
}

// 견적.
// input = { macro_months, rooms:[{ products:[…] }] }
// → { ok:true, lines:[{product, months?, room?, unit_price, amount}], total }
// | { ok:false, reason, error, room? }   (room = 몇 번째 방, 0부터)
function quote(input) {
  const b = input || {};
  const rooms = Array.isArray(b.rooms) ? b.rooms : [];
  const months = parseMonths(b.macro_months);

  if (months === 0 && rooms.length === 0) return fail('empty', '상품을 1개 이상 선택해 주세요.');
  const M = PRODUCTS.macro;
  if (!Number.isFinite(months) || months < 0 || months > M.max) {
    return fail('bad_months', '기간은 ' + M.min + '~' + M.max + '개월로 입력해 주세요.');
  }
  if (rooms.length > MAX_ROOMS) {
    return fail('too_many_rooms', '방은 한 번에 ' + MAX_ROOMS + '개까지 주문할 수 있습니다.');
  }

  const lines = [];
  let total = 0;
  if (months > 0) {
    const amount = months * M.price;
    lines.push({ product: 'macro', months: months, unit_price: M.price, amount: amount });
    total += amount;
  }
  for (let i = 0; i < rooms.length; i++) {
    const prods = roomProducts(rooms[i] && rooms[i].products);
    if (!prods.length) return fail('no_products', '이 방에 설치할 봇을 1개 이상 골라 주세요.', i);
    for (const p of prods) {
      const price = PRODUCTS[p].price;
      lines.push({ product: p, room: i, unit_price: price, amount: price });
      total += price;
    }
  }
  if (!lines.length) return fail('empty', '상품을 1개 이상 선택해 주세요.');
  return { ok: true, lines: lines, total: total };
}

// 무통장 입금 계좌 안내. 없으면 안내문구.
function bankInfo() {
  const v = process.env.BANK_INFO;
  return v && String(v).trim() ? String(v).trim() : '관리자에게 문의';
}

// 문의 연락처 (선택). 상담 창이 없을 때 보일 연락처이기도 하다(6.10).
function contactInfo() {
  const v = process.env.CONTACT_INFO;
  return v && String(v).trim() ? String(v).trim() : null;
}

// /api/price 응답 본체 (ok · purchase_base · auto_approve 는 라우터가 붙인다)
function table() {
  return {
    currency: CURRENCY,
    products: ['macro', 'roombot', 'minigame'].map((id) => Object.assign({}, PRODUCTS[id])),
    max_rooms: MAX_ROOMS,
    bank: bankInfo(),
    contact: contactInfo(),
  };
}

module.exports = {
  CURRENCY, PRODUCTS, MAX_ROOMS, ROOM_PRODUCTS,
  quote, table, label, bankInfo, contactInfo, roomProducts,
};
