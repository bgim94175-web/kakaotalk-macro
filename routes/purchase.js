// 구매 웹 API — 가격표 / 방 미리 보기 / 회원 주문 / 주문조회 / 내 주문 / 키조회 / 자동 입금확인 웹훅
// docs/ACCOUNTS_V1.md 3.3. 모든 새 구매는 회원 계정에 붙는다(D2). 라이선스 키는 더 팔지 않는다.
'use strict';

const express = require('express');
const crypto = require('crypto');
const db = require('../lib/db');
const keys = require('../lib/keys');
const features = require('../lib/features');
const pricing = require('../lib/pricing');
const audit = require('../lib/audit');
const signer = require('../lib/sign');
const openchat = require('../lib/openchat');
const installs = require('../lib/installs');
const entitle = require('../lib/entitle');
const memberAuth = require('../lib/member-auth');
const rl = require('../lib/ratelimit');
const { amountCandidates, parseName } = require('../lib/deposit-text');

const router = express.Router();

const wrap = (fn) => (req, res) => Promise.resolve(fn(req, res)).catch((e) => {
  console.error('[' + req.method + ' ' + req.originalUrl + '] ' + (e && e.stack ? e.stack : e));
  if (!res.headersSent) res.status(500).json({ ok: false, reason: 'server_error', error: '요청을 처리하지 못했습니다. 잠시 뒤 다시 시도해 주세요.' });
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

function envNum(name, dflt) {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : dflt;
}

// 자동 입금확인이 켜져 있나. 웹 문구가 "자동으로 적용" / "관리자가 확인 후 적용" 으로 갈린다 —
// 꺼둔 채로 "1~2분 안에 자동 적용" 이라고 약속하면 입금한 구매자가 오지 않는 적용을 기다린다.
function autoApproveOn() {
  return String(process.env.DEPOSIT_AUTO_APPROVE || '1') !== '0';
}
// 입금 웹훅 자체가 살아있나 (DEPOSIT_TOKEN 이 없으면 입금 알림 전달이 아예 붙지 못한다)
function depositHookOn() {
  return String(process.env.DEPOSIT_TOKEN || '').trim().length > 0;
}

function bad(res, status, reason, error, extra) {
  return res.status(status).json(Object.assign({ ok: false, reason: reason, error: error }, extra || {}));
}

// installs·entitle 이 돌려준 {ok:false, status, reason, error, …} 를 그대로 응답
function sendFail(res, r, extra) {
  const body = Object.assign({}, r, extra || {});
  const status = Number(body.status) || 400;
  delete body.status;
  body.ok = false;
  return res.status(status).json(body);
}

function orderUrl(req, id, token) {
  return features.purchaseBase(req) + '/order/' + id + '?t=' + token;
}

// 주문 줄 → 화면에 내보내는 공개 줄 {product, label, months?, install_id?, link_url?, link_name?, amount}
// (참여코드는 줄에 없다. hold·unverified 같은 관리용 표시는 내보내지 않는다)
function publicItems(items) {
  if (!Array.isArray(items)) return [];
  return items.filter((it) => it && typeof it === 'object').map((it) => {
    const out = { product: it.product, label: pricing.label(it.product) };
    if (it.product === 'macro') out.months = Number(it.months) || 0;
    if (it.install_id !== undefined && it.install_id !== null) out.install_id = Number(it.install_id);
    if (it.link_url) out.link_url = it.link_url;
    if (it.product !== 'macro') out.link_name = it.link_name || null;
    out.amount = Number(it.amount) || 0;
    return out;
  });
}

// 로그인한 회원(있으면). 401 을 쓰지 않는다.
async function viewerMemberId(req) {
  try {
    const s = await memberAuth.readSession(req);
    if (s && s.member && s.member.id !== undefined && s.member.id !== null) return Number(s.member.id);
  } catch (e) { /* 로그인 안 한 것으로 본다 */ }
  return null;
}

// ─────────────────────────────────────────────────────────────
// GET /api/price — 가격표 (lib/pricing.js 단일 소스, 인증 없음)
// ─────────────────────────────────────────────────────────────
router.get('/api/price', wrap(async (req, res) => {
  const out = Object.assign({ ok: true }, pricing.table());
  out.purchase_base = features.purchaseBase(req);
  out.auto_approve = autoApproveOn() && depositHookOn();
  res.json(out);
}));

// ─────────────────────────────────────────────────────────────
// POST /api/room-preview {link} — 붙여넣은 링크의 방을 봇으로 조회(회원)
// 부작용 있는 조회(실제 봇 계정이 JOININFO 를 보냄)라 POST 다. 회원당 시간 60회.
// 전체 카카오 조회량은 sender 의 봇별 조회 예산이 막는다(5.3).
// ─────────────────────────────────────────────────────────────
const PREVIEW_PER_HOUR = 60;
const previewHits = new Map();   // memberId → {start, n}

function previewAllowed(memberId, now) {
  const t = now || Date.now();
  if (previewHits.size > 5000) {
    for (const [k, v] of previewHits) if (t - v.start >= 3600000) previewHits.delete(k);
  }
  const cur = previewHits.get(memberId);
  if (!cur || t - cur.start >= 3600000) {
    previewHits.set(memberId, { start: t, n: 1 });
    return { ok: true };
  }
  cur.n += 1;
  if (cur.n > PREVIEW_PER_HOUR) return { ok: false, retryAfter: Math.ceil((cur.start + 3600000 - t) / 1000) };
  return { ok: true };
}

router.post('/api/room-preview', wrap(async (req, res) => {
  const s = await memberAuth.requireMember(req, res);
  if (!s) return;
  const memberId = Number(s.member.id);
  const lim = previewAllowed(memberId);
  if (!lim.ok) {
    res.set('Retry-After', String(lim.retryAfter));
    return bad(res, 429, 'rate_limited', '요청이 너무 잦습니다. 잠시 뒤 다시 시도해 주세요.');
  }
  const r = await installs.preview(memberId, (req.body || {}).link);
  if (!r.ok) return sendFail(res, r);
  res.json(r);
}));

// ─────────────────────────────────────────────────────────────
// POST /api/order — 회원 주문 접수 (무통장)
// body: { macro_months, rooms:[{link, passcode, products, unverified_ok} | {install_id, products}],
//         terms, depositor(필수), contact?, memo? }
// 금액 뒷자리(1~99원)로 주문을 특정하므로 반드시 "정확한 금액"을 입금해야 한다.
// 새 방 줄은 이 회원의 입금 대기 설치(room_installs.phase='pending_payment')로 예약한다(다른 회원은 막지 않음, D9).
// ─────────────────────────────────────────────────────────────
class OrderError extends Error {
  constructor(status, reason, error, room) {
    super(error);
    this.status = status;
    this.reason = reason;
    this.room = room;
  }
}

function roomFail(res, status, reason, error, room, extra) {
  const body = Object.assign({ ok: false, reason: reason, error: error }, extra || {});
  if (room !== undefined && room !== null) body.room = room;
  return res.status(status).json(body);
}

function maxPendingOrders() { return envNum('MEMBER_MAX_PENDING_ORDERS', 3); }
function maxPendingRooms() { return envNum('MEMBER_MAX_PENDING_ROOMS', 10); }
function maxPendingPerIp() { return envNum('IP_MAX_PENDING_ORDERS', 10); }
const TOO_MANY_PENDING = '입금 대기 중인 주문이 너무 많습니다. 기존 주문을 입금하거나 내 계정에서 취소한 뒤 다시 주문해 주세요.';

async function pendingCaps(client, memberId, ip, newRooms) {
  const a = await db.one("SELECT count(*)::int AS n FROM orders WHERE status='pending' AND member_id=$1", [memberId], client);
  if (a.n >= maxPendingOrders()) return false;
  if (ip) {
    const b = await db.one("SELECT count(*)::int AS n FROM orders WHERE status='pending' AND ip=$1", [ip], client);
    if (b.n >= maxPendingPerIp()) return false;
  }
  if (newRooms > 0) {
    const c = await db.one(
      "SELECT count(*)::int AS n FROM room_installs WHERE member_id=$1 AND phase='pending_payment'", [memberId], client);
    if (c.n + newRooms > maxPendingRooms()) return false;
  }
  return true;
}

function productsText(list) {
  const names = list.map((p) => pricing.label(p)).join(' · ');
  return names;   // '방 관리봇' · '미니게임봇' — 둘 다 '봇'(받침 있음)으로 끝나 '이' 를 붙인다
}

router.post('/api/order', wrap(async (req, res) => {
  const s = await memberAuth.requireMember(req, res);
  if (!s) return;
  const memberId = Number(s.member.id);
  const b = req.body || {};

  const depositor = cut(b.depositor, 60);
  if (!depositor) return bad(res, 400, 'no_depositor', '입금자명을 입력해 주세요.');

  // 방 행 정리. 링크도 설치 번호도 상품도 없는 행은 버린다(오류 아님). room = 보낸 배열의 위치.
  const rawRooms = Array.isArray(b.rooms) ? b.rooms : [];
  const rows = [];
  rawRooms.forEach((r, idx) => {
    if (!r || typeof r !== 'object') return;
    const link = r.link === null || r.link === undefined ? '' : String(r.link).trim();
    const iid = r.install_id === null || r.install_id === undefined || r.install_id === '' ? null : r.install_id;
    const prods = pricing.roomProducts(r.products);
    if (!link && iid === null && !prods.length) return;
    rows.push({ idx: idx, link: link, install_id: iid, passcode: r.passcode, products: prods, unverified_ok: r.unverified_ok === true });
  });

  // 상품 수준 검사(empty·bad_months·too_many_rooms). 방별 상품 없음은 방 검사에서 본다.
  const q0 = pricing.quote({ macro_months: b.macro_months, rooms: rows.map((r) => ({ products: r.products })) });
  if (!q0.ok && q0.reason !== 'no_products') return bad(res, 400, q0.reason, q0.error);
  if (rows.length && b.terms !== true) return bad(res, 400, 'no_terms', '이용 조건에 동의해 주세요.');

  const ipRaw = rl.ipOf(req);
  const ip = ipRaw && ipRaw !== 'unknown' ? cut(ipRaw, 64) : null;
  // 48시간 지난 미입금 주문을 먼저 자동 취소한다(4.3). 만료는 pickAmount 안에서도 돌지만 그건 아래 사전 검사 뒤라,
  // 방치된 주문만으로 상한에 걸린 회원·IP 가 자기 주문으로 그 주문들을 치우지 못하고 429 에 갇힌다.
  const expired = await db.tx((client) => keys.expireStalePending(client, Date.now()));
  if (expired) console.log('[purchase] 미입금으로 방치된 pending 주문 ' + expired + '건을 자동 취소했습니다');
  // 미입금 상한 사전 검사(트랜잭션 안에서 한 번 더 본다)
  const newRoomGuess = rows.filter((r) => r.install_id === null).length;
  if (!(await pendingCaps(null, memberId, ip, newRoomGuess))) return bad(res, 429, 'too_many_pending', TOO_MANY_PENDING);

  // 방마다 검사 → lines
  const lines = [];
  for (const r of rows) {
    const room = r.idx;
    if (r.install_id !== null) {
      const id = Number(r.install_id);
      const row = Number.isSafeInteger(id) && id > 0
        ? await db.one('SELECT * FROM room_installs WHERE id=$1 AND member_id=$2', [id, memberId]) : null;
      if (!row || row.phase !== 'installed') {
        return roomFail(res, 404, 'not_found', '방을 찾을 수 없습니다. 내 방 목록에서 다시 골라 주세요.', room);
      }
      if (!r.products.length) return roomFail(res, 400, 'no_products', '이 방에 설치할 봇을 1개 이상 골라 주세요.', room);
      lines.push({ kind: 'existing', room: room, row: row, products: r.products });
      continue;
    }
    const lk = installs.linkOf(r.link);
    if (!lk.ok) return roomFail(res, lk.status, lk.reason, lk.error, room);
    const url = lk.url;
    if (!r.products.length) return roomFail(res, 400, 'no_products', '이 방에 설치할 봇을 1개 이상 골라 주세요.', room);
    const pc = r.passcode === null || r.passcode === undefined ? '' : String(r.passcode).trim();
    if (pc.length > 20) return roomFail(res, 400, 'bad_passcode', installs.TEXT.bad_passcode, room);

    const pv = await installs.preview(memberId, url);
    if (!pv.ok) {
      const reason = pv.reason === 'taken' ? 'room_taken' : pv.reason;
      return roomFail(res, pv.status || 400, reason, pv.error, room);
    }
    if (pv.mine) {
      const mrow = await db.one('SELECT * FROM room_installs WHERE id=$1 AND member_id=$2', [pv.mine.install_id, memberId]);
      if (!mrow || mrow.phase === 'pending_payment') {
        return roomFail(res, 409, 'pending_exists', installs.TEXT.pending_exists, room);
      }
      // 이 회원의 기존 설치와 같은 방이면 그 설치에 상품을 더하는 줄로 바꾼다
      lines.push({ kind: 'existing', room: room, row: mrow, products: r.products });
      continue;
    }
    if (!pv.verified && !r.unverified_ok) {
      return roomFail(res, 400, 'unverified', '방 정보를 불러오지 못했습니다. 이대로 주문하려면 위 확인란을 선택하고, 아니면 잠시 뒤 다시 확인해 주세요.', room);
    }
    lines.push({
      kind: 'new', room: room, products: r.products,
      link_url: url, link_id: pv.room.link_id || null, link_name: pv.room.name || null,
      passcode: pc, unverified: !pv.verified, hold: !!installs.holdWordFor(pv.room.name),
    });
  }

  // 같은 주문 안의 같은 방
  const seen = new Map();
  for (const l of lines) {
    const ks = l.kind === 'existing'
      ? ['i:' + l.row.id, 'u:' + l.row.link_url].concat(l.row.link_id ? ['l:' + l.row.link_id] : [])
      : ['u:' + l.link_url].concat(l.link_id ? ['l:' + l.link_id] : []);
    for (const k of ks) {
      if (seen.has(k)) return roomFail(res, 400, 'duplicate_room', '이미 추가한 방입니다.', l.room);
    }
    ks.forEach((k) => seen.set(k, true));
  }

  // 기존 설치에 더하는 상품: 이미 있으면 409, 처리 대기 주문에 있으면 409
  for (const l of lines) {
    if (l.kind !== 'existing') continue;
    const have = l.products.filter((p) => !!l.row[p]);
    if (have.length) {
      return roomFail(res, 409, 'already_installed', '이 방에는 이미 ' + productsText(have) + '이 설치되어 있습니다.', l.room);
    }
    for (const p of l.products) {
      if (await installs.pendingHas(null, l.row.id, p)) {
        return roomFail(res, 409, 'pending_exists', installs.TEXT.pending_exists, l.room);
      }
    }
  }

  const q = pricing.quote({ macro_months: b.macro_months, rooms: lines.map((l) => ({ products: l.products })) });
  if (!q.ok) return bad(res, 400, q.reason, q.error, q.room !== undefined && lines[q.room] ? { room: lines[q.room].room } : null);

  const now = Date.now();
  const token = signer.randomHex(12); // 24 hex
  const newRooms = lines.filter((l) => l.kind === 'new').length;
  let made;
  try {
    made = await db.tx(async (client) => {
      const pick = await keys.pickAmount(client, q.total);   // 전역 advisory lock → 주문 접수가 직렬화된다
      if (!(await pendingCaps(client, memberId, ip, newRooms))) throw new OrderError(429, 'too_many_pending', TOO_MANY_PENDING);
      const id = await keys.uniqueOrderId(client);
      const items = [];
      if (q.lines[0] && q.lines[0].product === 'macro') {
        const m = q.lines[0];
        items.push({ product: 'macro', months: m.months, unit_price: m.unit_price, amount: m.amount });
      }
      for (const l of lines) {
        let installId;
        if (l.kind === 'new') {
          const rr = await installs.reserveForOrder(client, memberId, id, {
            link_url: l.link_url, link_id: l.link_id, link_name: l.link_name, passcode: l.passcode,
          });
          if (rr.error) throw new OrderError(rr.status || 409, rr.reason, rr.error, l.room);
          installId = rr.install_id;
        } else {
          installId = Number(l.row.id);
          for (const p of l.products) {
            if (await installs.pendingHas(client, installId, p)) {
              throw new OrderError(409, 'pending_exists', installs.TEXT.pending_exists, l.room);
            }
          }
        }
        const linkUrl = l.kind === 'new' ? l.link_url : l.row.link_url;
        const linkName = l.kind === 'new' ? l.link_name : (l.row.link_name || null);
        for (const p of l.products) {
          const price = pricing.PRODUCTS[p].price;
          const it = { product: p, install_id: installId, link_url: linkUrl, link_name: linkName, unit_price: price, amount: price };
          if (l.kind === 'new' && l.unverified) it.unverified = true;
          if (l.kind === 'new' && l.hold) it.hold = true;
          items.push(it);
        }
      }
      const feats = features.ALL.filter((f) => items.some((it) => it.product === f));
      await db.q(
        `INSERT INTO orders (id, created_at, status, features, plan, amount, base_amount,
                             buyer_name, contact, depositor, memo, target_key, token, needs_review,
                             member_id, kind, items, ip, terms_at)
         VALUES ($1,$2,'pending',$3,'member',$4,$5,NULL,$6,$7,$8,NULL,$9,$10,$11,'member',$12::jsonb,$13,$14)`,
        [id, now, feats.join(','), pick.amount, q.total, cut(b.contact, 120), depositor, cut(b.memo, 500),
         token, pick.needs_review, memberId, JSON.stringify(items), ip, lines.length ? now : null],
        client);
      await audit.record(req, 'order', { member_id: memberId,
        detail: '주문 접수 ' + id + ' / ' + items.map((it) => pricing.label(it.product) +
          (it.product === 'macro' ? ' ' + it.months + '개월' : ' #' + it.install_id)).join(', ') +
          ' / ' + pick.amount + '원 / 입금자=' + depositor }, client);
      return { id: id, amount: pick.amount, suffix: pick.suffix, needs_review: pick.needs_review, items: items };
    });
  } catch (e) {
    if (e instanceof OrderError) return roomFail(res, e.status, e.reason, e.message, e.room);
    if (e && e.code === '23505') return bad(res, 409, 'room_taken', installs.TEXT.taken);
    if (e && /CONFIG_SECRET/.test(String(e.message || ''))) {
      console.error('[order] 참여코드 봉인 실패 → ' + e.message);
      return bad(res, 503, 'no_secret', '참여코드를 저장할 수 없습니다. 문의해 주세요.');
    }
    throw e;
  }

  res.json({
    ok: true,
    id: made.id,
    token: token,
    url: orderUrl(req, made.id, token),
    amount: made.amount,
    base_amount: q.total,
    suffix: made.suffix,
    needs_review: made.needs_review,
    items: publicItems(made.items),
    bank: pricing.bankInfo(),
    account: pricing.bankInfo(),
    contact_info: pricing.contactInfo(),
    auto_approve: autoApproveOn() && depositHookOn(),
    created_at: now,
    status: 'pending',
  });
}));

// ─────────────────────────────────────────────────────────────
// GET /api/order/:id — 주문 상태. 토큰(?t=) 또는 주문 주인 회원만 본다. 남의 주문은 404.
// (프론트가 평면/중첩 어느 쪽으로 짜여도 되게 order 객체를 같이 준다)
// ─────────────────────────────────────────────────────────────
async function orderRooms(items) {
  const ids = [];
  for (const it of (Array.isArray(items) ? items : [])) {
    const id = it && it.install_id !== undefined && it.install_id !== null ? Number(it.install_id) : null;
    if (id && ids.indexOf(id) < 0) ids.push(id);
  }
  if (!ids.length) return [];
  const list = await installs.viewsByIds(ids);
  return list.map((x) => ({
    install_id: x.view.id,
    link_url: x.view.link_url,
    link_name: x.view.link_name,
    display: x.view.display,
    label: x.view.label,
    detail: x.view.detail,
    bot: x.view.bot,
  }));
}

router.get('/api/order/:id', wrap(async (req, res) => {
  const id = keys.normOrderId(req.params.id);
  if (!id) return bad(res, 400, 'bad_request', '주문번호 형식이 올바르지 않습니다.');
  const row = await db.one('SELECT * FROM orders WHERE id=$1', [id]);
  const notFound = () => bad(res, 404, 'not_found', '주문을 찾을 수 없습니다.');
  if (!row) return notFound();

  const o = db.shapeOrder(row);
  const authed = tsEqual(req.query.t, row.token || '');
  const viewer = o.member_id !== null ? await viewerMemberId(req) : null;
  const owner = o.member_id !== null && viewer !== null && viewer === o.member_id;
  if (!authed && !owner) return notFound();

  const isMember = o.kind === 'member' || o.member_id !== null;
  const view = {
    id: o.id,
    kind: o.kind,
    status: o.status,
    auto_canceled: o.auto_canceled,
    amount: o.amount,
    base_amount: o.base_amount,
    features: o.features,
    feature_labels: o.features.map((f) => features.label(f)),
    plan: o.plan,
    plan_label: isMember ? null : keys.planLabel(o.plan),
    created_at: o.created_at,
    handled_at: o.handled_at,
    needs_review: o.needs_review,
    items: publicItems(o.items),
    applied: o.status === 'done' ? o.applied : null,
    can_cancel: owner && o.status === 'pending' && isMember,
    accounts_n: null,
    rooms: [],
    depositor: o.depositor,
    buyer_name: o.buyer_name,
    contact: o.contact,
    memo: o.memo,
  };
  if (isMember) {
    view.rooms = await orderRooms(o.items);
    if (owner) {
      const a = await db.one('SELECT count(*)::int AS n FROM panel_accounts WHERE member_id=$1', [o.member_id]);
      view.accounts_n = a ? a.n : 0;
    }
    if (authed || owner) view.url = orderUrl(req, o.id, row.token);
  } else {
    // 예전 키 주문만 키를 보여 준다
    view.issued_key = o.status === 'done' ? (o.issued_key || null) : null;
    view.target_key = o.target_key ? maskKey(o.target_key) : null;
  }

  res.json(Object.assign({ ok: true, now: Date.now(), authed: authed, owner: owner,
    account: pricing.bankInfo(), bank: pricing.bankInfo(),
    contact_info: pricing.contactInfo(),
    auto_approve: autoApproveOn() && depositHookOn(), order: view }, view));
}));

// ─────────────────────────────────────────────────────────────
// GET /api/my/orders — 내 주문 최근 50건(회원)
// ─────────────────────────────────────────────────────────────
router.get('/api/my/orders', wrap(async (req, res) => {
  const s = await memberAuth.requireMember(req, res);
  if (!s) return;
  const memberId = Number(s.member.id);
  const r = await db.q('SELECT * FROM orders WHERE member_id=$1 ORDER BY created_at DESC, id DESC LIMIT 50', [memberId]);
  res.set('Cache-Control', 'no-store');
  res.json({
    ok: true,
    orders: r.rows.map((row) => {
      const o = db.shapeOrder(row);
      return {
        id: o.id,
        created_at: o.created_at,
        status: o.status,
        auto_canceled: o.auto_canceled,
        amount: o.amount,
        items: publicItems(o.items),
        applied: o.status === 'done' ? o.applied : null,
        url: orderUrl(req, o.id, row.token),
        can_cancel: o.status === 'pending',
      };
    }),
  });
}));

// ─────────────────────────────────────────────────────────────
// POST /api/my/orders/cancel {id} — 내 미입금 주문 취소(회원). 그 주문이 예약한 입금 대기 방도 취소된다.
// ─────────────────────────────────────────────────────────────
router.post('/api/my/orders/cancel', wrap(async (req, res) => {
  const s = await memberAuth.requireMember(req, res);
  if (!s) return;
  const r = await installs.cancelMemberOrder(Number(s.member.id), (req.body || {}).id, { req: req });
  if (!r.ok) return sendFail(res, r);
  res.json({ ok: true });
}));

// ─────────────────────────────────────────────────────────────
// POST /api/lookup — 예전 키 조회. 기능별 만료 / 회수·차단 / 회원 이관 여부.
// 예전 앱용 칸(device_id · session · 기기 초기화 횟수)은 내보내지 않는다.
// ─────────────────────────────────────────────────────────────
router.post('/api/lookup', wrap(async (req, res) => {
  const key = keys.normKey((req.body || {}).key);
  if (!key) return res.json({ ok: false, reason: 'bad_request', error: '키를 입력해 주세요.' });

  const lic = await db.one(
    'SELECT key, revoked, blocked_reason, activated_at, member_id FROM licenses WHERE key=$1',
    [key]);
  if (!lic) return res.json({ ok: false, reason: 'invalid_key', error: '등록되지 않은 키입니다. 키를 확인해 주세요.' });

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
    claimed: lic.member_id !== null && lic.member_id !== undefined,   // 회원 계정으로 이관된 키
    activated_at: db.num(lic.activated_at),
    expires_at: features.maxExpiry(featMap),
    features: featMap,      // { macro:{on,expires_at,plan}, ... } 3종 항상 존재
    feature_list: list,     // 화면에 바로 뿌리기 좋은 형태
    purchase: features.purchaseBase(req) + '/account#claim',
  });
}));

// ─────────────────────────────────────────────────────────────
// POST /api/deposit-hook — 폰 자동화 앱이 은행 알림을 그대로 넘겨주는 웹훅
// 처리 결과가 뭐든 200 + ok:true 로 답한다 (자동화 앱이 재시도를 반복하면 중복만 쌓인다)
// 흐름: 알림 원문 → 금액 후보 → 같은 금액의 pending 주문 1건 → keys.approveOrder
//       회원 주문은 회원 계정에 적용(매크로 기간 · 방 설치 + 봇 배정), 커밋 뒤 entitle.afterApprove 가
//       sender 에 권리를 밀고(/v1/grants) 새 설치를 알린다(/v1/bot/sync). 예전 키 주문은 예전 규칙 그대로.
//       같은 방을 다른 회원이 먼저 입금했으면(D9) 롤백 → 입금 ambiguous + 주문 needs_review(관리자 처리).
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

// 금액 후보·입금자명 읽기는 lib/deposit-text.js (은행 알림 모양별 시험: lib/deposit-check.js)

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
    // 뒷자리를 빼먹고 정가만 보낸 다른 주문의 입금일 수 있으니 자동 적용하지 않고 관리자에게 넘긴다.
    // (같은 방 충돌로 needs_review 가 켜진 주문도 여기서 관리자에게 넘어간다)
    // (구매 페이지도 이 주문은 "관리자 확인 대기"로 안내한다)
    if (matched.needs_review) {
      await setStatus('ambiguous', usedAmount, matched.id);
      return res.json({ ok: true, status: 'ambiguous', candidates: 1, amount: usedAmount,
                        order: matched.id, why: '금액 뒷자리가 없는 주문입니다. 관리자 확인이 필요합니다' });
    }

    // 이름 불일치는 거부하지 않고 경고만 (금액이 고유하므로 금액을 믿는다)
    if (name && matched.depositor && String(matched.depositor).trim() !== name) {
      await audit.record(req, 'order', { key: matched.target_key || null, member_id: matched.member_id || null,
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
      if (approved.reason === 'room_taken') {
        // 다른 회원이 같은 방을 먼저 입금했다. 주문은 pending 그대로 두고 관리자가 나머지만 적용한다(3.3.1)
        await db.q('UPDATE orders SET needs_review=TRUE WHERE id=$1', [matched.id]);
      }
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
    entitle.afterApprove(approved);    // 커밋 뒤, 기다리지 않음(실패는 로그만)
    await audit.record(req, 'order', { key: approved.key || null, member_id: approved.member_id || null,
      detail: '자동입금 승인 ' + (name || matched.depositor || '입금자미상') +
              ' / 주문=' + matched.id + ' / ' + usedAmount + '원' });

    res.json({ ok: true, status: 'matched', order: matched.id, amount: usedAmount, key: approved.key || null });
  }));

module.exports = router;
