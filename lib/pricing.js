// 가격표 — 서버 단일 소스. 가격을 바꿀 땐 이 파일만 고친다.
// 웹 구매페이지 / 주문 금액 / 관리자앱이 전부 여기서 나온 값을 쓴다.
//
// 판매 상품은 하나다: "K bot" = 모든 기능(features.ALL) · 30일 · 30,000원.
// 기능별 단가·장기 플랜·묶음 할인은 팔지 않는다. 같은 키로 다시 사면 모든 기능이 30일씩 늘어난다.
// (keys.PLANS 의 quarter/year 는 예전 주문·예전 키를 승인·연장·표시하려고 남겨 둔다 — 판매는 안 한다)
'use strict';

const features = require('./features');
const keys = require('./keys');

const CURRENCY = 'KRW';

const PRODUCT = Object.freeze({
  id: 'kbot',
  label: 'K bot',
  plan: 'month',
  price: 30000,
});

// 상품 하나의 견적. 실패하면 { ok:false, reason } 을 준다 (throw 안 함)
// reason: bad_plan (판매하지 않는 기간) | bad_product (모르는 상품)
// featureList 는 무엇이 와도 무시한다 — K bot 은 항상 모든 기능이다. 예전 클라이언트가
// features:['macro'] 를 보내도 더 싼 주문이 되지 않게, 금액·기능은 여기서만 정한다.
function quote(featureList, plan, productId) {
  if (productId !== undefined && productId !== null && productId !== '' &&
      String(productId).trim().toLowerCase() !== PRODUCT.id) {
    return { ok: false, reason: 'bad_product' };
  }
  const p = plan === undefined || plan === null || plan === '' ? PRODUCT.plan : String(plan).trim();
  if (p !== PRODUCT.plan || keys.SALE_PLANS.indexOf(p) < 0) return { ok: false, reason: 'bad_plan' };

  const feats = features.ALL.slice();
  return {
    ok: true,
    product: PRODUCT.id,
    product_label: PRODUCT.label,
    features: feats,
    feature_labels: feats.map((f) => features.label(f)),
    plan: p,
    plan_label: keys.planLabel(p),
    days: keys.PLANS[p].days,
    lines: [{ id: PRODUCT.id, label: PRODUCT.label, price: PRODUCT.price }],
    subtotal: PRODUCT.price,
    bundle: false,
    discount_rate: 0,
    discount: 0,
    amount: PRODUCT.price,
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

// /api/price 와 주문 응답이 같이 쓰는 상품 설명
function product() {
  const plan = PRODUCT.plan;
  return {
    id: PRODUCT.id,
    label: PRODUCT.label,
    price: PRODUCT.price,
    currency: CURRENCY,
    plan: plan,
    plan_label: keys.planLabel(plan),
    days: keys.PLANS[plan].days,
    features: features.ALL.map((id) => ({ id: id, label: features.label(id), desc: features.desc(id) })),
  };
}

// /api/price 응답 본체. product 가 정본이다.
// 예전 모양(plans[] / features[] / prices{} / bundle_discount)도 새 가격과 맞춘 채로 남겨 둔다.
function table() {
  const prod = product();
  const prices = {};
  prices[PRODUCT.id] = {};
  prices[PRODUCT.id][PRODUCT.plan] = PRODUCT.price;
  return {
    currency: CURRENCY,
    product: prod,
    bundle_discount: 0,
    plans: keys.SALE_PLANS.map((id) => ({
      id: id,
      label: keys.planLabel(id),
      days: keys.PLANS[id].days,
    })),
    features: prod.features.map((f) => Object.assign({ included: true }, f)),
    prices: prices,
    bank: bankInfo(),
    contact: contactInfo(),
  };
}

module.exports = { CURRENCY, PRODUCT, quote, product, table, bankInfo, contactInfo };
