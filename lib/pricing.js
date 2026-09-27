// 가격표 — 서버 단일 소스. 가격을 바꿀 땐 이 파일만 고친다.
// 웹 구매페이지 / 주문 금액 / 관리자앱이 전부 여기서 나온 값을 쓴다.
'use strict';

const features = require('./features');
const keys = require('./keys');

const CURRENCY = 'KRW';

// 기능 × 플랜 → 원
const PRICES = {
  macro:    { month: 15000, quarter: 39000, year: 129000 },
  roombot:  { month: 12000, quarter: 31000, year: 105000 },
  minigame: { month: 12000, quarter: 31000, year: 105000 },
};

// 3종 동시 구매 시 총액의 15% 할인
const BUNDLE_DISCOUNT = 0.15;

function priceOf(feature, plan) {
  const row = PRICES[feature];
  if (!row) return null;
  const p = row[plan];
  return typeof p === 'number' ? p : null;
}

// 견적. 실패하면 { ok:false, reason } 을 준다 (throw 안 함)
// reason: bad_feature | bad_plan
function quote(featureList, plan) {
  const feats = features.normList(featureList);
  if (!feats.length) return { ok: false, reason: 'bad_feature' };
  if (keys.SALE_PLANS.indexOf(plan) < 0) return { ok: false, reason: 'bad_plan' };

  const lines = [];
  let subtotal = 0;
  for (const f of feats) {
    const p = priceOf(f, plan);
    if (p === null) return { ok: false, reason: 'bad_plan' };
    lines.push({ feature: f, label: features.label(f), price: p });
    subtotal += p;
  }

  const bundle = feats.length === features.ALL.length;
  const discount = bundle ? Math.round(subtotal * BUNDLE_DISCOUNT) : 0;

  return {
    ok: true,
    features: feats,
    plan: plan,
    plan_label: keys.planLabel(plan),
    days: keys.PLANS[plan] ? keys.PLANS[plan].days : 0,
    lines: lines,
    subtotal: subtotal,
    bundle: bundle,
    discount_rate: bundle ? BUNDLE_DISCOUNT : 0,
    discount: discount,
    amount: subtotal - discount,
    currency: CURRENCY,
  };
}

// 무통장 입금 계좌 안내. 없으면 안내문구.
function bankInfo() {
  const v = process.env.BANK_INFO;
  return v && String(v).trim() ? String(v).trim() : '관리자에게 문의';
}

// 문의 연락처 (선택)
function contactInfo() {
  const v = process.env.CONTACT_INFO;
  return v && String(v).trim() ? String(v).trim() : null;
}

// /api/price 응답 본체. 프론트가 어떤 식으로 짜여 있어도 되게
// features[](중첩 prices) 와 prices{}(평면) 둘 다 준다.
function table() {
  return {
    currency: CURRENCY,
    bundle_discount: BUNDLE_DISCOUNT,
    plans: keys.SALE_PLANS.map((id) => ({
      id: id,
      label: keys.planLabel(id),
      days: keys.PLANS[id].days,
    })),
    features: features.ALL.map((id) => ({
      id: id,
      label: features.label(id),
      desc: features.desc(id),
      prices: Object.assign({}, PRICES[id]),
    })),
    prices: JSON.parse(JSON.stringify(PRICES)),
    bank: bankInfo(),
    contact: contactInfo(),
  };
}

module.exports = { CURRENCY, PRICES, BUNDLE_DISCOUNT, priceOf, quote, table, bankInfo, contactInfo };
