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

// 체크박스는 true / "true" / "1" / "on" / 1 등 제각각으로 온다 → 느슨하게 받아준다
function truthy(v) {
  if (v === true) return true;
  if (v === false || v === null || v === undefined) return false;
  if (typeof v === 'number') return v === 1;
  const t = String(v).trim().toLowerCase();
  return t === 'true' || t === '1' || t === 'on' || t === 'yes' || t === 'y';
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

// ─────────────────────────────────────────────────────────────
// GET /api/price — 가격표 (lib/pricing.js 단일 소스)
// ?features=macro,roombot&plan=month 를 주면 quote 도 같이 계산해준다
// ─────────────────────────────────────────────────────────────
// 자동 입금확인이 켜져 있나. 웹 문구가 "자동으로 발급돼" / "관리자가 확인 후 발급" 으로 갈린다 —
// 꺼둔 채로 "1~2분 안에 자동 발급" 이라고 약속하면 입금한 구매자가 오지 않는 키를 기다린다.
function autoApproveOn() {
  return String(process.env.DEPOSIT_AUTO_APPROVE || '1') !== '0';
}
// 입금 웹훅 자체가 살아있나 (DEPOSIT_TOKEN 이 없으면 폰 자동화가 아예 붙지 못한다)
function depositHookOn() {
  return String(process.env.DEPOSIT_TOKEN || '').trim().length > 0;
}

router.get('/api/price', wrap(async (req, res) => {
  const body = pricing.table();
  const out = Object.assign({ ok: true }, body);
  out.purchase_base = features.purchaseBase(req);
  out.auto_approve = autoApproveOn() && depositHookOn();
  const wantFeats = features.normList(req.query.features);
  if (wantFeats.length && req.query.plan) {
    out.quote = pricing.quote(wantFeats, String(req.query.plan));
  }
  res.json(out);
}));

// ─────────────────────────────────────────────────────────────
// POST /api/order — 주문 접수 (무통장)
// 금액 뒷자리(1~99원)로 주문을 특정하므로 반드시 "정확한 금액"을 입금해야 한다
// ─────────────────────────────────────────────────────────────
router.post('/api/order', wrap(async (req, res) => {
  const b = req.body || {};
  const feats = features.normList(b.features);
  if (!feats.length) return res.json({ ok: false, reason: 'bad_feature', error: '기능을 하나 이상 골라줘' });

  const plan = String(b.plan || '').trim();
  const q = pricing.quote(feats, plan);
  if (!q.ok) {
    return res.json({ ok: false, reason: q.reason,
      error: q.reason === 'bad_plan' ? '플랜을 골라줘 (1개월/3개월/1년)' : '기능을 하나 이상 골라줘' });
  }

  const depositor = cut(b.depositor, 60);
  if (!depositor) return res.json({ ok: false, reason: 'no_depositor', error: '입금자명을 적어줘' });

  // 아이폰 확인 체크박스 — 값이 false 라도 주문을 거부하지 않는다.
  // 웹 UI 가 이미 막고 있고, 서버가 막으면 나중에 다른 경로(앱 딥링크·관리자 대행)로
  // 주문받을 때 걸린다. 기록만 남겨서 환불 분쟁 때 증거로 쓴다.
  const androidOk = truthy(b.android_ok);

  const targetKeyRaw = keys.normKey(b.target_key);
  let targetKey = null;
  if (targetKeyRaw) {
    const lic = await db.one('SELECT key FROM licenses WHERE key=$1', [targetKeyRaw]);
    if (!lic) return res.json({ ok: false, reason: 'invalid_key', error: '연장할 키를 못 찾았어. 키를 다시 확인해줘' });
    targetKey = targetKeyRaw;
  }

  const now = Date.now();
  const token = signer.randomHex(12); // 24 hex
  const made = await db.tx(async (client) => {
    const pick = await keys.pickAmount(client, q.amount);
    const id = await keys.uniqueOrderId(client);
    await db.q(
      `INSERT INTO orders (id, created_at, status, features, plan, amount, base_amount,
                           buyer_name, contact, depositor, memo, target_key, token, needs_review,
                           android_ok)
       VALUES ($1,$2,'pending',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
      [id, now, feats.join(','), plan, pick.amount, q.amount,
       cut(b.buyer_name, 60), cut(b.contact, 120), depositor, cut(b.memo, 500), targetKey,
       token, pick.needs_review, androidOk], client);
    return { id: id, amount: pick.amount, suffix: pick.suffix, needs_review: pick.needs_review };
  });

  await audit.record(req, 'order', { key: targetKey || null,
    detail: '주문 접수 ' + made.id + ' / 기능=' + feats.join(',') + ' / 플랜=' + plan +
            ' / ' + made.amount + '원 / 입금자=' + depositor +
            ' / 안드로이드확인=' + (androidOk ? '예' : '아니오') });

  res.json({
    ok: true,
    id: made.id,
    token: token,
    url: features.purchaseBase(req) + '/order/' + made.id + '?t=' + token,
    amount: made.amount,
    base_amount: q.amount,
    suffix: made.suffix,
    needs_review: made.needs_review,
    android_ok: androidOk,
    features: feats,
    plan: plan,
    plan_label: q.plan_label,
    subtotal: q.subtotal,
    discount: q.discount,
    bundle: q.bundle,
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
  if (!id) return res.json({ ok: false, reason: 'bad_request', error: '주문번호가 잘못됐어' });
  const row = await db.one('SELECT * FROM orders WHERE id=$1', [id]);
  if (!row) return res.json({ ok: false, reason: 'not_found', error: '없는 주문이야' });

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
    view.android_ok = o.android_ok;
  }

  res.json(Object.assign({ ok: true, now: Date.now(), authed: authed,
    account: pricing.bankInfo(), bank: pricing.bankInfo(),
    contact_info: pricing.contactInfo(),
    auto_approve: autoApproveOn() && depositHookOn(), order: view }, view));
}));

// ─────────────────────────────────────────────────────────────
// POST /api/lookup — 키 조회. 기능/만료/기기등록여부만.
// device_id · session · config_key 는 절대 내보내지 않는다.
// ─────────────────────────────────────────────────────────────
router.post('/api/lookup', wrap(async (req, res) => {
  const key = keys.normKey((req.body || {}).key);
  if (!key) return res.json({ ok: false, reason: 'bad_request', error: '키를 입력해줘' });

  const lic = await db.one(
    'SELECT key, plan, revoked, blocked_reason, device_id, activated_at, reset_count FROM licenses WHERE key=$1',
    [key]);
  if (!lic) return res.json({ ok: false, reason: 'invalid_key', error: '없는 키야. 다시 확인해줘' });

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
    device_registered: !!lic.device_id,   // 기기가 묶여 있는지만 (어떤 기기인지는 안 알려준다)
    activated_at: db.num(lic.activated_at),
    reset_count: Number(lic.reset_count) || 0,
    expires_at: features.maxExpiry(featMap),
    features: featMap,      // /verify 와 같은 형태
    feature_list: list,     // 화면에 바로 뿌리기 좋은 형태
    purchase: features.purchaseBase(req) + '/buy?key=' + encodeURIComponent(key),
  });
}));

// ─────────────────────────────────────────────────────────────
// POST /api/deposit-hook — 폰 자동화 앱이 은행 알림을 그대로 넘겨주는 웹훅
// 처리 결과가 뭐든 200 + ok:true 로 답한다 (자동화 앱이 재시도를 반복하면 중복만 쌓인다)
// ─────────────────────────────────────────────────────────────

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
      return res.status(503).json({ ok: false, error: 'DEPOSIT_TOKEN 미설정 — 입금 웹훅이 꺼져 있어' });
    }
    const given = req.header('x-deposit-token') || (req.query ? req.query.t : '') || '';
    if (!tsEqual(given, want)) {
      await audit.record(req, 'bad_deposit_token',
        { detail: '입금 웹훅 인증 실패 source=' + (req.query.source || '-') });
      return res.status(401).json({ ok: false, error: 'unauthorized' });
    }

    // text / message / body 아무 키로 와도 받고, text/plain 본문도 그대로 쓴다
    let text = '', source = '', atRaw = 0;
    const b = req.body;
    if (typeof b === 'string') {
      text = b;
    } else if (b && typeof b === 'object') {
      text = b.text || b.message || b.body || b.raw || '';
      source = b.source || '';
      atRaw = Number(b.at) || 0;
    }
    text = String(text === null || text === undefined ? '' : text).trim();
    if (!source) source = String((req.query && req.query.source) || 'unknown');
    source = String(source).slice(0, 40);
    if (!text) return res.json({ ok: true, status: 'ignored', why: '본문이 비었어' });
    if (text.length > 4000) text = text.slice(0, 4000);

    const at = (atRaw > 1000000000000 && atRaw < 4000000000000) ? atRaw : Date.now();
    const hash = signer.sha256Hex(text);
    const cands = amountCandidates(text);
    const name = parseName(text);

    // 중복 방어는 UNIQUE(raw_hash) 에 맡긴다 → 먼저 넣어보고 안 들어가면 중복
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

    // 이름 불일치는 거부하지 않고 경고만 (금액이 고유하므로 금액을 믿는다)
    if (name && matched.depositor && String(matched.depositor).trim() !== name) {
      await audit.record(req, 'order', { key: matched.target_key || null,
        detail: '입금자명 불일치 경고 주문=' + matched.id + ' 주문서=' + matched.depositor + ' 알림=' + name });
    }

    const auto = String(process.env.DEPOSIT_AUTO_APPROVE || '1') !== '0';
    if (!auto) {
      await setStatus('matched', usedAmount, matched.id);
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
                        order: matched.id, why: '자동 승인 중 오류 — 관리자 확인 필요' });
    }
    if (approved.error) {
      console.error('[deposit] 자동 승인 거절 order=' + matched.id + ' → ' + approved.error);
      await setStatus('ambiguous', usedAmount, matched.id);
      return res.json({ ok: true, status: 'ambiguous', candidates: 1, amount: usedAmount,
                        order: matched.id, why: approved.error });
    }

    await setStatus('matched', usedAmount, matched.id);
    await audit.record(req, 'order', { key: approved.key,
      detail: '자동입금 승인 ' + (name || matched.depositor || '입금자미상') +
              ' / 주문=' + matched.id + ' / ' + usedAmount + '원' });

    res.json({ ok: true, status: 'matched', order: matched.id, amount: usedAmount, key: approved.key });
  }));

module.exports = router;
