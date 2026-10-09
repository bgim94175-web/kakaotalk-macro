// 구매 웹 API — 가격표 / 주문 / 주문조회 / 키조회 / 자동 입금확인 웹훅
'use strict';

const express = require('express');
const crypto = require('crypto');
const db = require('../lib/db');
const keys = require('../lib/keys');
const features = require('../lib/features');
const pricing = require('../lib/pricing');
const audit = require('../lib/audit');
const signer = require('../lib/sign');

const router = express.Router();

const wrap = (fn) => (req, res) => Promise.resolve(fn(req, res)).catch((e) => {
  console.error('[' + req.method + ' ' + req.originalUrl + '] ' + (e && e.stack ? e.stack : e));
  if (!res.headersSent) res.status(500).json({ ok: false, error: 'server_error' });
});

function cut(v, n) {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  if (!s) return null;
  return s.length > n ? s.slice(0, n) : s;
}

// 같은 길이일 때만 비교 성립 → 길이 다르면 바로 false
function tsEqual(a, b) {
  const x = Buffer.from(String(a === null || a === undefined ? '' : a), 'utf8');
  const y = Buffer.from(String(b === null || b === undefined ? '' : b), 'utf8');
  if (x.length !== y.length || x.length === 0) return false;
  try { return crypto.timingSafeEqual(x, y); } catch (e) { return false; }
}

// KAKA-ABCD-EFGH-IJKL → KAKA-****-****-IJKL (남의 키를 엿보지 못하게)
function maskKey(k) {
  if (!k) return null;
  const parts = String(k).split('-');
  if (parts.length < 3) return String(k).slice(0, 2) + '****';
  return parts.map((p, i) => (i === 0 || i === parts.length - 1) ? p : '*'.repeat(p.length)).join('-');
}

// 자동 입금확인이 켜져 있나. 웹 문구가 "자동으로 발급돼" / "관리자가 확인 후 발급" 으로 갈린다 —
// 꺼둔 채로 "1~2분 안에 자동 발급" 이라고 약속하면 입금한 구매자가 오지 않는 키를 기다린다.
function autoApproveOn() {
  return String(process.env.DEPOSIT_AUTO_APPROVE || '1') !== '0';
}
// 입금 웹훅 자체가 살아있나 (DEPOSIT_TOKEN 이 없으면 입금 알림 전달이 아예 붙지 못한다)
function depositHookOn() {
  return String(process.env.DEPOSIT_TOKEN || '').trim().length > 0;
}

// ─────────────────────────────────────────────────────────────
// GET /api/price — 가격표 (lib/pricing.js 단일 소스)
// 상품은 "K bot 1개월" 하나라 고를 게 없다. 예전 ?features=&plan= 쿼리는 무시한다.
// ─────────────────────────────────────────────────────────────
router.get('/api/price', wrap(async (req, res) => {
  const out = Object.assign({ ok: true }, pricing.table());
  out.purchase_base = features.purchaseBase(req);
  out.auto_approve = autoApproveOn() && depositHookOn();
  res.json(out);
}));

// ─────────────────────────────────────────────────────────────
// POST /api/order — 주문 접수 (무통장)
// body: { depositor(필수), buyer_name?, contact?, memo?, target_key? }
// 상품은 하나다 — 본문에 features / plan 이 와도 무시하고 항상 3종 + 'month' 로 받는다.
// target_key 가 있으면 새 키 대신 그 키를 3종 모두 30일 연장한다.
// 금액 뒷자리(1~99원)로 주문을 특정하므로 반드시 "정확한 금액"을 입금해야 한다
// ─────────────────────────────────────────────────────────────
router.post('/api/order', wrap(async (req, res) => {
  const b = req.body || {};
  const q = pricing.quote();

  const depositor = cut(b.depositor, 60);
  if (!depositor) return res.json({ ok: false, reason: 'no_depositor', error: '입금자명을 입력하십시오' });

  const targetKeyRaw = keys.normKey(b.target_key);
  let targetKey = null;
  if (targetKeyRaw) {
    const lic = await db.one('SELECT key, revoked, blocked_reason FROM licenses WHERE key=$1', [targetKeyRaw]);
    if (!lic) return res.json({ ok: false, reason: 'invalid_key', error: '연장 대상 키를 찾을 수 없습니다. 키를 확인하십시오' });
    // 회수·차단된 키에 입금을 받으면 돈만 들어가고 쓸 수가 없다 → 주문 단계에서 막는다
    if (lic.revoked || lic.blocked_reason) {
      return res.json({ ok: false, reason: 'key_blocked', error: '사용이 중지된 키는 연장할 수 없습니다. 관리자에게 문의하십시오' });
    }
    targetKey = targetKeyRaw;
  }

  const now = Date.now();
  const token = signer.randomHex(12); // 24 hex
  const made = await db.tx(async (client) => {
    const pick = await keys.pickAmount(client, q.amount);
    const id = await keys.uniqueOrderId(client);
    await db.q(
      `INSERT INTO orders (id, created_at, status, features, plan, amount, base_amount,
                           buyer_name, contact, depositor, memo, target_key, token, needs_review)
       VALUES ($1,$2,'pending',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [id, now, q.features.join(','), q.plan, pick.amount, q.amount,
       cut(b.buyer_name, 60), cut(b.contact, 120), depositor, cut(b.memo, 500), targetKey,
       token, pick.needs_review], client);
    return { id: id, amount: pick.amount, suffix: pick.suffix, needs_review: pick.needs_review };
  });

  await audit.record(req, 'order', { key: targetKey || null,
    detail: '주문 접수 ' + made.id + ' / ' + pricing.NAME + ' ' + q.plan_label +
            (targetKey ? ' 연장' : ' 신규') + ' / ' + made.amount + '원 / 입금자=' + depositor });

  res.json({
    ok: true,
    id: made.id,
    token: token,
    url: features.purchaseBase(req) + '/order/' + made.id + '?t=' + token,
    amount: made.amount,
    base_amount: q.amount,
    suffix: made.suffix,
    needs_review: made.needs_review,
    features: q.features,
    feature_labels: q.features.map((f) => features.label(f)),
    plan: q.plan,
    plan_label: q.plan_label,
    days: q.days,
    target_key: targetKey ? maskKey(targetKey) : null,
    account: pricing.bankInfo(),
    bank: pricing.bankInfo(),
    contact_info: pricing.contactInfo(),
    auto_approve: autoApproveOn() && depositHookOn(),
    created_at: now,
    status: 'pending',
  });
}));

// ─────────────────────────────────────────────────────────────
// GET /api/order/:id — 주문 상태. ?t=<token> 이 맞으면 발급된 키까지 보여준다.
// (프론트가 평면/중첩 어느 쪽으로 짜여도 되게 order 객체를 같이 준다)
// ─────────────────────────────────────────────────────────────
router.get('/api/order/:id', wrap(async (req, res) => {
  const id = keys.normOrderId(req.params.id);
  if (!id) return res.json({ ok: false, reason: 'bad_request', error: '주문번호 형식이 올바르지 않습니다' });
  const row = await db.one('SELECT * FROM orders WHERE id=$1', [id]);
  if (!row) return res.json({ ok: false, reason: 'not_found', error: '존재하지 않는 주문입니다' });

  const o = db.shapeOrder(row);
  const authed = tsEqual(req.query.t, row.token || '');

  const view = {
    id: o.id,
    status: o.status,
    amount: o.amount,
    base_amount: o.base_amount,
    features: o.features,
    feature_labels: o.features.map((f) => features.label(f)),
    plan: o.plan,
    plan_label: keys.planLabel(o.plan),
    created_at: o.created_at,
    handled_at: o.handled_at,
    needs_review: o.needs_review,
  };
  if (authed) {
    view.issued_key = o.status === 'done' ? (o.issued_key || null) : null;
    view.depositor = o.depositor;
    view.buyer_name = o.buyer_name;
    view.memo = o.memo;
    view.target_key = o.target_key ? maskKey(o.target_key) : null;
  }

  res.json(Object.assign({ ok: true, now: Date.now(), authed: authed,
    account: pricing.bankInfo(), bank: pricing.bankInfo(),
    contact_info: pricing.contactInfo(),
    auto_approve: autoApproveOn() && depositHookOn(), order: view }, view));
}));

// ─────────────────────────────────────────────────────────────
// POST /api/lookup — 키 조회. 기능별 만료 / 회수·차단 여부만.
// 예전 앱용 칸(device_id · session · 기기 초기화 횟수)은 내보내지 않는다.
// ─────────────────────────────────────────────────────────────
router.post('/api/lookup', wrap(async (req, res) => {
  const key = keys.normKey((req.body || {}).key);
  if (!key) return res.json({ ok: false, reason: 'bad_request', error: '키를 입력하십시오' });

  const lic = await db.one(
    'SELECT key, revoked, blocked_reason, activated_at FROM licenses WHERE key=$1',
    [key]);
  if (!lic) return res.json({ ok: false, reason: 'invalid_key', error: '등록되지 않은 키입니다. 키를 확인하십시오' });

  const now = Date.now();
  const ents = await db.entitlements(key);
  const featMap = features.map(ents, now);

  const list = features.ALL.map((f) => ({
    feature: f,
    label: features.label(f),
    desc: features.desc(f),
    on: featMap[f].on,
    plan: featMap[f].plan,
    plan_label: featMap[f].plan ? keys.planLabel(featMap[f].plan) : null,
    expires_at: featMap[f].expires_at,
    days_left: features.daysLeft(featMap[f].expires_at, now),
  }));

  res.json({
    ok: true,
    now: now,
    key: key,
    revoked: !!lic.revoked,
    blocked: !!lic.blocked_reason,
    activated_at: db.num(lic.activated_at),   // 사용 기간이 시작된 시각 (/panel 첫 로그인). 미시작이면 null
    expires_at: features.maxExpiry(featMap),
    features: featMap,      // { macro:{on,expires_at,plan}, ... } 3종 항상 존재
    feature_list: list,     // 화면에 바로 뿌리기 좋은 형태
    purchase: features.purchaseBase(req) + '/buy?key=' + encodeURIComponent(key),
  });
}));

// ─────────────────────────────────────────────────────────────
// POST /api/deposit-hook — 폰 자동화 앱이 은행 알림을 그대로 넘겨주는 웹훅
// 처리 결과가 뭐든 200 + ok:true 로 답한다 (자동화 앱이 재시도를 반복하면 중복만 쌓인다)
// 흐름: 알림 원문 → 금액 후보 → 같은 금액의 pending 주문 1건 → keys.approveOrder
//       (신규면 3종 30일 키 발급, target_key 가 있으면 그 키 3종을 max(지금, 만료일)+30일)
// ─────────────────────────────────────────────────────────────

// 본문 꺼내기. 자동화 앱마다 보내는 모양이 다르다.
//  - JSON {text|message|body|raw, source, at}  (server.js 의 express.json 이 이미 풀어 둔 경우)
//  - text/plain 원문
//  - 폼(urlencoded) text=...&source=...
//  - 깨진 JSON — MacroDroid 처럼 변수를 JSON 문자열 안에 그대로 끼워 넣으면 알림 본문의
//    줄바꿈·따옴표 때문에 JSON 이 깨진다. 금액은 원문 안에 그대로 있으니 버리지 않고 원문째 쓴다.
function hookBody(req) {
  let b = req.body;
  if (Buffer.isBuffer(b)) b = b.toString('utf8');
  if (typeof b === 'string') {
    const raw = b;
    const t = raw.trim();
    if (t.charAt(0) === '{') {
      let obj = null;
      try { obj = JSON.parse(t); } catch (e) {
        // 문자열 안의 날 줄바꿈·탭은 JSON 에서 금지다 → 공백으로 바꿔 한 번 더
        try { obj = JSON.parse(t.replace(/[\u0000-\u001f]+/g, ' ')); } catch (e2) { obj = null; }
      }
      if (!obj || typeof obj !== 'object') return { text: raw, source: '', at: 0 };
      b = obj;
    } else if (req.is && req.is('application/x-www-form-urlencoded')) {
      const sp = new URLSearchParams(raw);
      b = { text: sp.get('text') || sp.get('message') || sp.get('body') || sp.get('raw') || '',
            source: sp.get('source') || '', at: sp.get('at') };
    } else {
      return { text: raw, source: '', at: 0 };
    }
  }
  if (!b || typeof b !== 'object') return { text: '', source: '', at: 0 };
  let text = b.text || b.message || b.body || b.raw || '';
  if (typeof text === 'object') {
    try { text = JSON.stringify(text); } catch (e) { text = ''; }
  }
  return { text: String(text), source: b.source ? String(b.source) : '', at: Number(b.at) || 0 };
}

// 중복 판정 해시. 같은 알림이 두 번 오면(자동화 앱 재전송) 한 번만 처리한다 — deposits.raw_hash UNIQUE.
// 본문만 해시하면 안 된다: 시각이 없는 알림 형식(예: "입금 30,045원 홍길동")에서 같은 사람이
// 다음 달에 우연히 같은 뒷자리로 또 입금하면 그 입금이 '중복'으로 버려진다 — 입금 기록조차 안 남아
// 관리자 화면에도 안 보이고, 주문은 48시간 뒤 자동 취소된다. 매달 연장하는 손님이 쌓일수록 잦아진다.
// 그래서 1시간 칸 번호를 섞고, 직전 칸도 같이 본다 → 1~2시간 안에 다시 온 같은 본문만 중복이다.
// (그 창을 벗어난 재전송이 와도 주문은 이미 done 이라 다시 발급되지 않는다 — 미매칭으로 남을 뿐)
const DEDUPE_SLOT_MS = 3600 * 1000;
function dedupeHash(text, slot) {
  return signer.sha256Hex(text + '\n#' + slot);
}

// 금액 후보 뽑기: 잔액/잔고/한도/누적 바로 뒤 숫자는 제외
function amountCandidates(text) {
  const re = /(\d{1,3}(?:,\d{3})+|\d{3,})/g;
  const out = [];
  const seen = {};
  let m;
  while ((m = re.exec(text)) !== null) {
    const before = text.slice(Math.max(0, m.index - 14), m.index);
    if (/(잔액|잔고|한도|누적)[^0-9]{0,8}$/.test(before)) continue;
    const n = Number(m[1].replace(/,/g, ''));
    if (!isFinite(n) || n < 100 || n > 100000000) continue;
    if (seen[n]) continue;
    seen[n] = true;
    out.push(n);
  }
  return out;
}

const NAME_STOP = ['입금', '출금', '잔액', '잔고', '한도', '누적', '계좌', '이체', '수수료', '결제', '승인',
  '취소', '만원', '알림', '내역', '거래', '일시', '확인', '문자', '광고', '머니', '송금', '완료', '현금'];

// 입금자명 추정 (보조 확인용 — 은행마다 형식이 다르니 실패해도 그냥 null)
function parseName(text) {
  const re = /[가-힣]{2,4}/g;
  const cands = [];
  let m;
  while ((m = re.exec(text)) !== null) {
    const w = m[0];
    if (NAME_STOP.indexOf(w) >= 0) continue;
    if (/뱅|은행|저축|우체|협|카드|보험|증권|페이|체크|신용/.test(w)) continue;
    cands.push(w);
  }
  if (!cands.length) return null;
  // 보통 금액 뒤에 이름이 온다 → 마지막 후보
  return cands[cands.length - 1].replace(/(님|씨)$/, '');
}

router.post('/api/deposit-hook',
  express.text({ type: function () { return true; }, limit: '64kb' }),
  wrap(async (req, res) => {
    const want = String(process.env.DEPOSIT_TOKEN || '').trim();
    if (!want) {
      return res.status(503).json({ ok: false, error: 'DEPOSIT_TOKEN 미설정 상태입니다. 입금 웹훅이 비활성 상태입니다' });
    }
    const given = req.header('x-deposit-token') || (req.query ? req.query.t : '') || '';
    if (!tsEqual(given, want)) {
      await audit.record(req, 'bad_deposit_token',
        { detail: '입금 웹훅 인증 실패 source=' + (req.query.source || '-') });
      return res.status(401).json({ ok: false, error: 'unauthorized' });
    }

    // text / message / body 아무 키로 와도 받고, text/plain 본문도 그대로 쓴다
    const hb = hookBody(req);
    let text = hb.text.trim();
    let source = hb.source || String((req.query && req.query.source) || 'unknown');
    source = source.slice(0, 40);
    if (!text) return res.json({ ok: true, status: 'ignored', why: '본문 없음' });
    if (text.length > 4000) text = text.slice(0, 4000);

    const atRaw = hb.at;
    const at = (atRaw > 1000000000000 && atRaw < 4000000000000) ? atRaw : Date.now();
    const slot = Math.floor(at / DEDUPE_SLOT_MS);
    const hash = dedupeHash(text, slot);
    const cands = amountCandidates(text);
    const name = parseName(text);

    // 직전 칸에 같은 본문이 이미 있으면 재전송이다
    const prev = await db.one('SELECT id FROM deposits WHERE raw_hash=$1', [dedupeHash(text, slot - 1)]);
    if (prev) return res.json({ ok: true, status: 'duplicate' });

    // 같은 칸 안의 중복은 UNIQUE(raw_hash) 에 맡긴다 → 먼저 넣어보고 안 들어가면 중복
    const ins = await db.q(
      `INSERT INTO deposits (at, amount, name, raw, source, raw_hash, matched_order, status)
       VALUES ($1::bigint,$2,$3,$4,$5,$6,NULL,'unmatched')
       ON CONFLICT (raw_hash) DO NOTHING RETURNING id`,
      [at, cands.length ? cands[0] : null, name, text, source, hash]);
    if (!ins.rowCount) return res.json({ ok: true, status: 'duplicate' });
    const depositId = Number(ins.rows[0].id);

    const setStatus = (status, amount, orderId) =>
      db.q('UPDATE deposits SET status=$1, amount=COALESCE($2,amount), matched_order=$3 WHERE id=$4',
        [status, amount === undefined ? null : amount, orderId || null, depositId]);

    // 출금/결제 알림은 무시
    if (/(출금|결제|승인취소|이체수수료)/.test(text) && !/입금/.test(text)) {
      await setStatus('ignored', null, null);
      return res.json({ ok: true, status: 'ignored', why: '출금 알림' });
    }

    if (!cands.length) {
      await setStatus('unmatched', null, null);
      return res.json({ ok: true, status: 'unmatched', amount: null });
    }

    // 금액 후보로 대기 주문 찾기
    let matched = null, ambiguous = 0, usedAmount = null;
    for (const amt of cands) {
      const r = await db.q("SELECT * FROM orders WHERE status='pending' AND amount=$1", [amt]);
      if (r.rowCount === 1) { matched = r.rows[0]; usedAmount = amt; break; }
      if (r.rowCount > 1) { ambiguous = r.rowCount; usedAmount = amt; break; }
    }

    if (ambiguous) {
      await setStatus('ambiguous', usedAmount, null);
      console.error('[deposit] 같은 금액 대기 주문 ' + ambiguous + '건 → 관리자 확인 필요 amount=' + usedAmount);
      return res.json({ ok: true, status: 'ambiguous', candidates: ambiguous, amount: usedAmount });
    }
    if (!matched) {
      await setStatus('unmatched', cands[0], null);
      return res.json({ ok: true, status: 'unmatched', amount: cands[0] });
    }

    // 금액 뒷자리를 못 받은 주문(needs_review, 금액=정가 그대로)은 금액이 고유하지 않다 —
    // 뒷자리를 빼먹고 정가만 보낸 다른 주문의 입금일 수 있으니 자동 발급하지 않고 관리자에게 넘긴다.
    // (구매 페이지도 이 주문은 "관리자 확인 대기"로 안내한다)
    if (matched.needs_review) {
      await setStatus('ambiguous', usedAmount, matched.id);
      return res.json({ ok: true, status: 'ambiguous', candidates: 1, amount: usedAmount,
                        order: matched.id, why: '금액 뒷자리가 없는 주문입니다. 관리자 확인이 필요합니다' });
    }

    // 이름 불일치는 거부하지 않고 경고만 (금액이 고유하므로 금액을 믿는다)
    if (name && matched.depositor && String(matched.depositor).trim() !== name) {
      await audit.record(req, 'order', { key: matched.target_key || null,
        detail: '입금자명 불일치 경고 주문=' + matched.id + ' 주문서=' + matched.depositor + ' 알림=' + name });
    }

    const auto = String(process.env.DEPOSIT_AUTO_APPROVE || '1') !== '0';
    if (!auto) {
      await setStatus('matched', usedAmount, matched.id);
      // 수동 확인 모드(DEPOSIT_AUTO_APPROVE=0): 입금은 확인됐으나 발급은 관리자가 한다.
      // 주문을 'paid'(입금 확인됨·발급 대기)로 전환한다 (SPEC 상태집합 pending|paid|done|canceled).
      // pending 일 때만 전환해 이미 done/canceled 인 주문을 덮지 않는다.
      await db.q("UPDATE orders SET status='paid' WHERE id=$1 AND status='pending'", [matched.id]);
      return res.json({ ok: true, status: 'matched', order: matched.id, amount: usedAmount,
                        key: null, auto_approve: false });
    }

    let approved;
    try {
      approved = await db.tx((client) => keys.approveOrder(client, matched.id, null));
    } catch (e) {
      console.error('[deposit] 자동 승인 실패 order=' + matched.id + ' → ' + (e && e.stack ? e.stack : e));
      await setStatus('ambiguous', usedAmount, matched.id);
      return res.json({ ok: true, status: 'ambiguous', candidates: 1, amount: usedAmount,
                        order: matched.id, why: '자동 승인 중 오류 발생. 관리자 확인 필요' });
    }
    if (approved.error) {
      console.error('[deposit] 자동 승인 거절 order=' + matched.id + ' → ' + approved.error);
      await setStatus('ambiguous', usedAmount, matched.id);
      return res.json({ ok: true, status: 'ambiguous', candidates: 1, amount: usedAmount,
                        order: matched.id, why: approved.error });
    }

    if (approved.already) {
      // 같은 입금의 다른 알림(문자 + 앱 푸시)이 동시에 들어와 다른 쪽이 먼저 발급했다.
      // 다시 발급하지 않는다. 순서대로 왔을 때(주문이 이미 done 이라 미매칭)와 똑같이 남긴다.
      await setStatus('unmatched', usedAmount, null);
      return res.json({ ok: true, status: 'unmatched', amount: usedAmount,
                        why: '이미 처리된 주문입니다: ' + matched.id });
    }

    await setStatus('matched', usedAmount, matched.id);
    await audit.record(req, 'order', { key: approved.key,
      detail: '자동입금 승인 ' + (name || matched.depositor || '입금자미상') +
              ' / 주문=' + matched.id + ' / ' + usedAmount + '원' });

    res.json({ ok: true, status: 'matched', order: matched.id, amount: usedAmount, key: approved.key });
  }));

module.exports = router;
