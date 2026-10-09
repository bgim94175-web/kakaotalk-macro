// 가격표 — 서버 단일 소스. 가격을 바꿀 땐 이 파일만 고친다.
// 구매 페이지 / 주문 금액 / 관리자 화면이 전부 여기서 나온 값을 쓴다.
//
// 상품은 하나다: "K bot 1개월" 30,000원 = 30일, 기능 3종(macro·roombot·minigame) 전부 포함.
// 기능별 구매 · 3개월/1년 · 묶음 할인은 없다. 다시 사면 같은 키가 기능 3종 모두 30일씩 늘어난다.
'use strict';

const features = require('./features');
const keys = require('./keys');

const CURRENCY = 'KRW';
const NAME = 'K bot';
const PLAN = 'month';                       // keys.SALE_PLANS 의 유일한 값
const PLAN_DAYS = keys.PLANS[PLAN].days;    // 30
const PRICE = 30000;                        // 원. 주문 금액 = PRICE + 뒷자리(1~99원)

// 견적. 항상 성공한다 — 고를 게 없으니 인자도 받지 않는다.
// 예전 호출부가 (기능목록, 플랜) 을 넘겨도 무시하고 같은 값을 준다.
function quote() {
  const label = keys.planLabel(PLAN);
  return {
    ok: true,
    name: NAME,
    features: features.ALL.slice(),
    plan: PLAN,
    plan_label: label,
    days: PLAN_DAYS,
    lines: [{ plan: PLAN, label: NAME + ' ' + label, days: PLAN_DAYS, price: PRICE }],
    subtotal: PRICE,
    discount: 0,
    bundle: false,
    amount: PRICE,
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

// /api/price 응답 본체 (ok · purchase_base · auto_approve 는 라우터가 붙인다)
function table() {
  const label = keys.planLabel(PLAN);
  return {
    currency: CURRENCY,
    name: NAME,
    plan: PLAN,
    plan_label: label,
    days: PLAN_DAYS,
    price: PRICE,
    features: features.catalog(),
    plans: [{ id: PLAN, label: label, days: PLAN_DAYS, price: PRICE }],
    bank: bankInfo(),
    contact: contactInfo(),
  };
}

module.exports = { CURRENCY, NAME, PLAN, PLAN_DAYS, PRICE, quote, table, bankInfo, contactInfo };
