/* ───────────────────────────────────────────────────────────────
   K bot — 구매 웹 공통 스크립트
   페이지 구분: <body data-page="home|buy|my|order">
   쓰는 서버 API (SPEC 5장):
     GET  /api/price        가격표 (서버가 단일 소스 — 여기서 하드코딩 안 함)
     POST /api/order        주문 접수  → {ok, id, token, amount, account, ...}
     GET  /api/order/:id    주문 상태
     POST /api/lookup       키 조회 (기능별 만료일 · 사용 중지/차단 여부만)
   상품은 "K bot 1개월" 하나다 (lib/pricing.js). 기능 3종이 모두 들어 있고 고를 게 없다.
   다시 사면 같은 키가 기능 3종 모두 연장된다. 사용은 웹 콘솔(/panel)에서 키로 로그인해서 한다.
   외부 라이브러리 안 씀. 이 파일 하나에 공통 로직 다 들어있다.

   주문 상태 페이지는 무인 자동발급(SPEC 12장) 때문에 스스로 폴링한다 — 8장 pageOrder 참고.
   5초 간격 · 탭 숨으면 정지 · 다시 보이면 즉시 1회 · 최대 30분 · done/canceled 면 정지.
   ─────────────────────────────────────────────────────────────── */
(function () {
  'use strict';

  /* ══════════════════ 0. 카탈로그 (SPEC 1장) ══════════════════
     가격 · 기간 · 기능 설명은 절대 여기 안 적는다. 전부 /api/price.
     아래 이름표는 응답을 받기 전이나 못 받았을 때 화면이 비지 않게 하는 용도뿐이다. */

  var FEATURES = [
    { id: 'macro',    name: '자동발송 매크로' },
    { id: 'roombot',  name: '대화방 관리봇' },
    { id: 'minigame', name: '미니게임봇' }
  ];

  var FEAT_IDS = FEATURES.map(function (f) { return f.id; });

  /* 남은 기간 막대의 분모 — 서버가 기간(days)을 알려주기 전에만 쓴다 */
  var DAYS_FALLBACK = 30;

  var MSG_PRICE_FAIL = '가격 정보를 불러올 수 없습니다';

  /* ── 자동 입금확인이 꺼져 있으면(DEPOSIT_AUTO_APPROVE=0 또는 DEPOSIT_TOKEN 미설정)
        "자동으로 발급돼" 라고 약속한 문구를 전부 "관리자 확인 후 발급" 으로 바꾼다.
        꺼둔 채로 자동 발급을 약속하면 입금한 구매자가 오지 않는 키를 기다린다.
        서버는 /api/price · /api/order · /api/order/:id 응답에 auto_approve 를 실어준다. */
  var AUTO_APPROVE = true;

  function applyAutoCopy(on) {
    if (on === undefined || on === null) return;   // 정보가 없으면 건드리지 않는다
    AUTO_APPROVE = on !== false;
    if (AUTO_APPROVE) return;
    var els = document.querySelectorAll('[data-manual]');
    for (var i = 0; i < els.length; i++) {
      if (els[i].getAttribute('data-manual-applied')) continue;
      els[i].innerHTML = els[i].getAttribute('data-manual');
      els[i].setAttribute('data-manual-applied', '1');
    }
  }

  /** 입금 후 안내 한 줄 — 자동/수동에 따라 갈린다 */
  function issueMsg(review) {
    if (review) return '입금 후 관리자가 확인합니다';
    return AUTO_APPROVE ? '입금 후 1~2분 내 키가 자동 발급됩니다' : '입금 후 관리자가 확인하여 키를 발급합니다';
  }

  /* 서버가 48시간 방치된 pending 주문을 자동 취소한다 (ORDER_PENDING_TTL_MS).
     접수 결과 화면과 주문 상태 페이지에서 같은 문구를 쓴다. */
  var TTL_MSG = '48시간 내 미입금 시 주문이 자동 취소됩니다. 취소 후 입금한 경우에도 관리자 확인이 가능합니다.';
  var TTL_CANCELED_MSG = '미입금 48시간 경과로 자동 취소되었습니다. 이미 입금한 경우 관리자에게 문의하십시오.';

  var STATUS = {
    pending:  { kr: '입금 대기 중',            cls: 'warn' },
    paid:     { kr: '입금 확인됨 · 발급 준비',  cls: 'info' },
    done:     { kr: '발급 완료',               cls: 'ok'   },
    canceled: { kr: '취소됨',                  cls: 'bad'  },
    cancelled:{ kr: '취소됨',                  cls: 'bad'  }
  };

  /* 서버 reason 코드 → 한국어 (SPEC 3.1 표 + 웹 전용 몇 개) */
  var REASON_KR = {
    bad_request:   '요청 형식이 올바르지 않습니다',
    no_depositor:  '입금자명을 입력하십시오',
    invalid_key:   '등록되지 않은 키입니다',
    key_blocked:   '사용이 중지된 키는 연장할 수 없습니다. 관리자에게 문의하십시오',
    not_found:     '조회 결과가 없습니다',
    revoked:       '사용이 중지된 키입니다',
    blocked:       '차단된 키입니다. 관리자에게 문의하십시오',
    expired:       '사용 기간이 만료되었습니다',
    no_entitlement:'구매한 기능이 없습니다',
    server_error:  '서버 오류가 발생했습니다. 잠시 후 다시 시도하십시오',
    rate_limited:  '요청이 너무 빈번합니다. 잠시 후 다시 시도하십시오',
    unauthorized:  '권한이 없습니다'
  };

  function featName(id) {
    if (PRICE && PRICE.feats[id] && PRICE.feats[id].label) return PRICE.feats[id].label;
    for (var i = 0; i < FEATURES.length; i++) if (FEATURES[i].id === id) return FEATURES[i].name;
    return String(id || '');
  }
  /* 플랜 이름표. 판매는 /api/price 의 플랜 하나뿐이지만, 예전에 팔던 다른 기간의 주문·키도
     그대로 보여야 하므로 서버가 준 이름표(plan_label)를 먼저 쓴다. 없으면 현재 상품의 이름표,
     그것도 아니면 id 그대로. */
  function planName(id, label) {
    var lb = str(label);
    if (lb) return lb;
    if (PRICE && id && id === PRICE.plan && PRICE.planLabel) return PRICE.planLabel;
    return id ? String(id) : '-';
  }
  /* 기간 일수 — 응답에 days 가 있으면 그걸, 없으면 현재 판매 중인 플랜일 때만 안다 (모르면 0 → 생략) */
  function planDays(id, days) {
    var d = num(days);
    if (d) return d;
    return (PRICE && id && id === PRICE.plan && PRICE.days) || 0;
  }
  /* "K bot 1개월 (30일)" — 주문 화면의 상품 줄 */
  function productText(id, label, days) {
    if (!id && !str(label)) return '-';
    var d = planDays(id, days);
    var name = PRICE && PRICE.name ? PRICE.name + ' ' : '';
    return name + planName(id, label) + (d ? ' (' + d + '일)' : '');
  }

  /* ══════════════════ 1. 유틸 ══════════════════ */

  function $(sel, root) { return (root || document).querySelector(sel); }
  function $$(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }

  function el(tag, attrs, kids) {
    var n = document.createElement(tag), k;
    if (attrs) for (k in attrs) {
      var v = attrs[k];
      if (v === null || v === undefined || v === false) continue;
      if (k === 'text') n.textContent = String(v);
      else if (k === 'html') n.innerHTML = v;                 // 정적 문자열에만 쓴다
      else if (k === 'cls') n.className = v;
      else if (k.slice(0, 2) === 'on' && typeof v === 'function') n.addEventListener(k.slice(2), v);
      else n.setAttribute(k, v === true ? '' : String(v));
    }
    if (kids !== null && kids !== undefined) {
      (Array.isArray(kids) ? kids : [kids]).forEach(function (c) {
        if (c === null || c === undefined || c === false) return;
        n.appendChild(typeof c === 'string' || typeof c === 'number' ? document.createTextNode(String(c)) : c);
      });
    }
    return n;
  }

  function clear(node) { while (node && node.firstChild) node.removeChild(node.firstChild); }

  function num(v) { var n = Number(v); return isFinite(n) ? n : null; }
  function str(v) { return typeof v === 'string' ? v.trim() : (v === null || v === undefined ? '' : String(v)); }

  function pick(o, keys) {
    if (!o || typeof o !== 'object') return undefined;
    for (var i = 0; i < keys.length; i++) {
      var v = o[keys[i]];
      if (v !== undefined && v !== null && v !== '') return v;
    }
    return undefined;
  }

  /* 금액 추출 — 숫자 / "30,000원" / {amount:30000} 다 받는다 */
  function amount(v) {
    if (v === null || v === undefined) return null;
    if (typeof v === 'number') return isFinite(v) ? v : null;
    if (typeof v === 'string') {
      var n = Number(v.replace(/[^0-9.\-]/g, ''));
      return isFinite(n) && n > 0 ? n : null;
    }
    if (typeof v === 'object') return amount(pick(v, ['amount', 'price', 'won', 'krw', 'value', 'total']));
    return null;
  }

  function won(n) {
    var v = num(n);
    if (v === null) return '-';
    return Math.round(v).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',') + '원';
  }
  /* 모노 글꼴 칸에 넣는 금액: 숫자는 모노, '원'은 산세리프 span (docs/UI_V5.md 2.1·7 — 모노에 한글 금지). 글자는 won() 과 같다. */
  function wonKids(n, pre) {
    var t = won(n);
    if (t.slice(-1) !== '원') return [(pre || '') + t];
    return [(pre || '') + t.slice(0, -1), el('span', { cls: 'sans', text: '원' })];
  }
  function setWon(node, n, empty) {
    clear(node);
    if (num(n) === null) { node.textContent = empty; return; }
    wonKids(n).forEach(function (k) { node.appendChild(typeof k === 'string' ? document.createTextNode(k) : k); });
  }

  /* 초 단위 타임스탬프로 와도 ms로 맞춘다 */
  function ts(v) {
    var n = num(v);
    if (n === null || n <= 0) return 0;
    return n < 1e12 ? Math.round(n * 1000) : Math.round(n);
  }

  function pad2(n) { return (n < 10 ? '0' : '') + n; }

  function dateKr(ms, withTime) {
    var t = ts(ms);
    if (!t) return '-';
    var d = new Date(t);
    var s = d.getFullYear() + '.' + pad2(d.getMonth() + 1) + '.' + pad2(d.getDate());
    if (withTime) s += ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes());
    return s;
  }

  function daysLeft(expiresMs, nowMs) {
    var e = ts(expiresMs);
    if (!e) return 0;
    var d = Math.ceil((e - (nowMs || Date.now())) / 86400000);
    return d > 0 ? d : 0;
  }

  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }

  /* 키 입력 정리: 영숫자만 남기고 4글자마다 하이픈 (KAKA-XXXX-XXXX-XXXX) */
  function normKey(s) {
    var v = String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 16);
    if (!v) return '';
    return v.match(/.{1,4}/g).join('-');
  }
  var KEY_RE = /^KAKA-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/;

  function qs() { return new URLSearchParams(location.search); }

  /* 주문 상태 링크. 토큰이 있어야 발급된 키·입금자명을 볼 수 있다 (서버가 ?t= 로 확인) */
  function orderUrl(id, token) {
    return '/order/' + encodeURIComponent(id) + (token ? '?t=' + encodeURIComponent(token) : '');
  }

  /* 주문 토큰을 이 브라우저에만 저장해둔다 — 링크를 잃어버려도 주문번호로 다시 볼 수 있게.
     저장이 막힌 브라우저(시크릿 등)에서도 죽지 않게 전부 try/catch. */
  var TOK_STORE = 'kk_order_tokens';
  function saveToken(id, token) {
    if (!id || !token) return;
    try {
      var m = JSON.parse(localStorage.getItem(TOK_STORE) || '{}');
      if (!m || typeof m !== 'object') m = {};
      m[id] = token;
      var ks = Object.keys(m);
      while (ks.length > 20) { delete m[ks.shift()]; }   // 오래된 건 버린다
      localStorage.setItem(TOK_STORE, JSON.stringify(m));
    } catch (e) { /* 저장 못 해도 링크로는 볼 수 있다 */ }
  }
  function loadToken(id) {
    try {
      var m = JSON.parse(localStorage.getItem(TOK_STORE) || '{}');
      return (m && typeof m === 'object' && str(m[id])) || '';
    } catch (e) { return ''; }
  }

  /* 구매 링크. 키가 있으면 연장 주문으로 미리 채운다 (/buy 가 ?key= 를 기존 키 칸에 넣는다) */
  function buyUrl(key) {
    return '/buy' + (key ? '?key=' + encodeURIComponent(key) : '');
  }

  /* ── 토스트 */
  var toastT = null;
  function toast(msg, kind) {
    var t = $('#toast');
    if (!t) { t = el('div', { id: 'toast', role: 'status', 'aria-live': 'polite' }); document.body.appendChild(t); }
    t.textContent = String(msg);
    t.setAttribute('data-kind', kind || '');
    t.setAttribute('data-on', '1');
    if (toastT) clearTimeout(toastT);
    toastT = setTimeout(function () { t.setAttribute('data-on', '0'); }, 2600);
  }

  /* ── 복사 (클립보드 API 안 되면 임시 textarea 폴백) */
  function copy(text, okMsg) {
    var s = String(text || '');
    if (!s) return;
    var done = function () { toast(okMsg || '복사되었습니다', 'ok'); };
    var fallback = function () {
      try {
        var ta = el('textarea', { value: s, 'aria-hidden': 'true' });
        ta.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0';
        document.body.appendChild(ta);
        ta.select(); ta.setSelectionRange(0, s.length);
        var ok = document.execCommand('copy');
        document.body.removeChild(ta);
        if (ok) done(); else toast('복사에 실패했습니다. 길게 눌러 직접 복사하십시오', 'bad');
      } catch (e) {
        toast('복사에 실패했습니다. 길게 눌러 직접 복사하십시오', 'bad');
      }
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(s).then(done, fallback);
    } else fallback();
  }

  function copyBtn(getText, label) {
    return el('button', {
      type: 'button', cls: 'btn sm', onclick: function () { copy(getText(), (label || '') + ' 복사되었습니다'); }
    }, '복사');
  }

  /* 숫자만 남긴다 — 입금 금액은 뱅킹 앱에 붙여넣으니까 쉼표·'원' 이 섞이면 안 된다 */
  function digits(v) { return String(v === null || v === undefined ? '' : v).replace(/[^0-9]/g, ''); }

  /* 연락처 문자열 안의 링크 · 이메일 · 휴대폰번호를 눌러서 바로 연락되게 바꾼다.
     나머지는 그냥 글자로 둔다 (예: "카톡 ID buseong"). 반환값은 문자열/노드 배열. */
  function linkify(s) {
    var txt = str(s), out = [], last = 0, m;
    if (!txt) return out;
    var re = /(https?:\/\/[^\s]+)|([A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})|(01[016-9][-.\s]?\d{3,4}[-.\s]?\d{4})/g;
    while ((m = re.exec(txt)) !== null) {
      if (m.index > last) out.push(txt.slice(last, m.index));
      var tok = m[0];
      if (m[1])      out.push(el('a', { href: tok, target: '_blank', rel: 'noopener noreferrer' }, tok));
      else if (m[2]) out.push(el('a', { href: 'mailto:' + tok }, tok));
      else           out.push(el('a', { href: 'tel:' + digits(tok) }, tok));
      last = m.index + tok.length;
    }
    if (last < txt.length) out.push(txt.slice(last));
    return out;
  }

  /* ── 입금 금액 블록 (SPEC 12.1)
     금액 뒷자리가 곧 주문번호 역할이라, 화면에서 가장 크게 띄우고 뒷자리 설명을 꼭 붙인다.
     구매 결과 화면(/buy)과 주문 상태 페이지(/order/:id)가 같이 쓴다. */
  function amountBlock(amt, base, review) {
    var v = num(amt);
    var b = num(base);
    var suffix = (b !== null && v !== null && v > b) ? (v - b) : null;
    var msg = review
      ? '동일 금액의 대기 주문이 중복되어 금액만으로 식별이 불가합니다. 관리자가 직접 확인하며, 최대 수 시간이 소요됩니다. ' +
        '입금 후 연락처로 통보하면 처리가 신속합니다.'
      : '정확히 ' + won(v) + '을 입금하십시오' +
        (suffix !== null ? ' · 뒷자리 ' + suffix + '원은 주문 확인용입니다' : '') +
        '. 금액이 일치하지 않으면 자동 확인이 불가합니다.';
    return el('div', { cls: 'big hi' }, [
      el('div', { cls: 'k', text: '입금 금액' }),
      el('div', { cls: 'v xl mono' }, wonKids(v)),
      el('div', { cls: 'tiny warnline', text: msg }),
      suffix !== null
        ? el('div', { cls: 'tiny dim', text: '상품 금액 ' + won(v - suffix) + ' + 주문 확인용 ' + suffix + '원' })
        : null,
      v === null ? null : el('div', { cls: 'btn-row' }, [
        el('button', {
          type: 'button', cls: 'btn sm',
          onclick: function () { copy(digits(Math.round(v)), '금액이 복사되었습니다 (숫자만)'); }
        }, '금액 복사')
      ])
    ]);
  }

  /* ══════════════════ 2. API ══════════════════ */

  function errKr(code) {
    var c = str(code);
    return REASON_KR[c] || '';
  }

  function api(path, opts) {
    var o = {};
    opts = opts || {};
    o.method  = opts.method || (opts.body ? 'POST' : 'GET');
    o.headers = { 'Accept': 'application/json' };
    if (opts.body !== undefined && opts.body !== null) {
      o.body = typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body);
      o.headers['Content-Type'] = 'application/json';
    }
    o.cache = 'no-store';
    return fetch(path, o).catch(function () {
      var e = new Error('서버에 연결할 수 없습니다. 네트워크 상태를 확인한 후 다시 시도하십시오.');
      e.net = true;
      throw e;
    }).then(function (res) {
      return res.text().catch(function () { return ''; }).then(function (txt) {
        var data = null;
        try { data = txt ? JSON.parse(txt) : null; } catch (e) { data = null; }
        if (!res.ok || !data || data.ok === false) {
          var code = data ? str(pick(data, ['reason', 'code'])) : '';
          /* 서버는 error 에 한국어 문구를, reason 에 코드를 담는다 */
          var human = data ? str(pick(data, ['message', 'error'])) : '';
          if (human && /^[a-z0-9_.-]+$/i.test(human)) { if (!code) code = human; human = ''; }
          var msg = human || errKr(code) ||
                    (res.status === 404 ? '조회 결과가 없습니다' : '') ||
                    ('요청이 실패했습니다 (HTTP ' + res.status + ')');
          var e2 = new Error(msg);
          e2.status = res.status;
          e2.code = code;
          e2.data = data;
          throw e2;
        }
        return data;
      });
    });
  }

  /* ══════════════════ 3. 가격표 ══════════════════
     GET /api/price → { ok, currency, name, plan, plan_label, days, price,
                        features:[{id,label,desc}], plans:[{id,label,days,price}],
                        bank, contact, purchase_base, auto_approve }
     정규화 결과: { name, price, plan, planLabel, days, order:[id...], feats:{id:{label,desc}}, bank, contact } */

  var PRICE = null;
  var pricePromise = null;

  function normalizePrice(raw) {
    if (!raw || typeof raw !== 'object') throw new Error(MSG_PRICE_FAIL);
    var plans = Array.isArray(raw.plans) ? raw.plans : [];
    var first = (plans[0] && typeof plans[0] === 'object') ? plans[0] : {};

    var price = amount(pick(raw, ['price', 'amount']));
    if (price === null) price = amount(pick(first, ['price', 'amount']));
    if (price === null) throw new Error(MSG_PRICE_FAIL);

    var P = {
      name: str(pick(raw, ['name', 'title'])),
      price: price,
      plan: str(pick(raw, ['plan'])) || str(pick(first, ['id', 'plan'])),
      planLabel: str(pick(raw, ['plan_label', 'planLabel'])) || str(pick(first, ['label', 'name'])),
      days: num(pick(raw, ['days'])) || num(pick(first, ['days'])) || 0,
      order: [], feats: {},
      bank: str(pick(raw, ['account', 'bank', 'bank_info', 'bankInfo'])),
      contact: str(pick(raw, ['admin_contact', 'adminContact', 'contact', 'support']))
    };

    (Array.isArray(raw.features) ? raw.features : []).forEach(function (e) {
      if (!e || typeof e !== 'object') return;
      var id = str(pick(e, ['id', 'feature', 'key']));
      if (!id || P.feats[id]) return;
      P.order.push(id);
      P.feats[id] = { label: str(pick(e, ['label', 'name'])), desc: str(pick(e, ['desc', 'description'])) };
    });
    return P;
  }

  /* 정적 문구 안의 [data-bind] 자리에 서버 값을 채운다 (HTML 에 적힌 값은 스크립트가 꺼졌을 때의 대체 문구) */
  function bindPrice() {
    if (!PRICE) return;
    var vals = {
      plan:  planTitle(),
      price: won(PRICE.price),
      days:  PRICE.days ? PRICE.days + '일' : ''
    };
    $$('[data-bind]').forEach(function (n) {
      var v = vals[n.getAttribute('data-bind')];
      if (v) n.textContent = v;
    });
  }

  function loadPrice() {
    if (pricePromise) return pricePromise;
    pricePromise = api('/api/price').then(function (raw) {
      PRICE = normalizePrice(raw);
      applyAutoCopy(raw && raw.auto_approve);    // 자동 발급이 꺼져 있으면 문구를 바꾼다
      bindPrice();
      return PRICE;
    }).catch(function (e) {
      pricePromise = null;                       // 다시 시도할 수 있게 캐시 비움
      throw new Error(e && e.net ? MSG_PRICE_FAIL + ' (서버 연결 실패)' : MSG_PRICE_FAIL);
    });
    return pricePromise;
  }

  /* ══════════════════ 4. 상품 카드 + 결제 금액 (랜딩 / 구매 공용) ══════════════════
     상품은 하나라 고를 게 없다. 카드 = 상품 줄 1개 + 포함 기능 줄, 합계 상자 = 금액 + 버튼. */

  /* "K bot 1개월" */
  function planTitle() {
    if (!PRICE) return '';
    return ((PRICE.name ? PRICE.name + ' ' : '') + planName(PRICE.plan)).trim();
  }

  /* 포함 기능 목록 — 서버가 준 순서 그대로. 응답이 비어 있으면 이름표만 */
  function featList() {
    var ids = (PRICE && PRICE.order.length) ? PRICE.order : FEAT_IDS;
    return ids.map(function (id) {
      var f = (PRICE && PRICE.feats[id]) || {};
      return { id: id, label: f.label || featName(id), desc: f.desc || '' };
    });
  }

  /* 랜딩 상품 카드 (#prods) */
  function renderPlanCard(mount) {
    var d = PRICE.days, list = featList();
    clear(mount);
    mount.appendChild(el('article', { cls: 'card prod one sel' }, [
      el('div', { cls: 'head' }, [
        el('div', { cls: 't' }, [
          el('div', { cls: 'chip-row' }, [
            el('h3', { text: planTitle() }),
            el('span', { cls: 'chip tagx', text: '모든 기능 포함' })
          ]),
          el('p', { cls: 'desc', text: (d ? d + '일 동안 ' : '') + '아래 기능 ' + list.length + '종을 모두 사용합니다.' })
        ])
      ]),
      el('ul', { cls: 'bul' }, [
        el('li', { text: '라이선스 키 1개 · 카카오 계정 최대 8개' }),
        el('li', { text: '사용 기간은 콘솔 첫 로그인 시점부터 시작' }),
        el('li', { text: '다시 구매하면 같은 키의 기간' + (d ? ' ' + d + '일' : '') + ' 연장' })
      ]),
      el('div', { cls: 'prices' }, [
        el('div', { cls: 'pr', 'data-on': '1' }, [
          el('span', { cls: 'pl', text: planName(PRICE.plan) }),
          el('span', { cls: 'pv' }, wonKids(PRICE.price))
        ]),
        d ? el('div', { cls: 'pr' }, [
          el('span', { cls: 'pl', text: '기간' }),
          el('span', { cls: 'pv' }, [String(d), el('span', { cls: 'sans', text: '일' })])
        ]) : null
      ])
    ]));
    list.forEach(function (f) {
      mount.appendChild(el('article', { cls: 'card prod one' }, [
        el('div', { cls: 'head' }, [
          el('div', { cls: 't' }, [
            el('div', { cls: 'chip-row' }, [
              el('h3', { text: f.label }),
              el('span', { cls: 'chip ok', text: '포함' })
            ]),
            f.desc ? el('p', { cls: 'desc', text: f.desc }) : null
          ])
        ])
      ]));
    });
  }

  /* 구매 폼의 포함 기능 줄 (#planFeats) — /my 의 기능 줄과 같은 모양 */
  function renderFeatRows(mount) {
    if (!mount) return;
    clear(mount);
    featList().forEach(function (f) {
      mount.appendChild(el('div', { cls: 'feat-row' }, [
        el('div', { cls: 'r1' }, [
          el('h3', { text: f.label }),
          el('span', { cls: 'chip ok', text: '포함' })
        ]),
        f.desc ? el('p', { cls: 'tiny dim', text: f.desc }) : null
      ]));
    });
  }

  /* 합계 상자 (#sum). cta = { kind:'link', href, text } (랜딩) | { kind:'submit', text } (구매 폼).
     금액 뒷자리 설명을 미리 붙인다 — 주문 후 몇 원이 더 붙은 금액을 보고 놀라지 않게. */
  function renderSum(mount, cta) {
    clear(mount);
    mount.className = 'sum';
    var d = PRICE.days;
    mount.appendChild(el('div', { cls: 'lines' }, [
      el('div', { cls: 'ln' }, [
        el('span', { text: planTitle() + (d ? ' · ' + d + '일' : '') }),
        el('span', { cls: 'v mono' }, wonKids(PRICE.price))
      ]),
      el('div', { cls: 'ln' }, [
        el('span', { text: '포함 기능' }),
        el('span', { cls: 'v', text: featList().length + '종 전체' })
      ]),
      el('div', { cls: 'ln total' }, [
        el('span', { text: '결제 금액' }),
        el('span', { cls: 'v mono' }, wonKids(PRICE.price))
      ])
    ]));
    /* 예시 뒷자리 47원은 설명용이다. 실제 뒷자리는 주문마다 서버가 1~99원 중 비어 있는 값을 고른다 */
    mount.appendChild(el('div', { cls: 'nudge',
      text: '주문 시 금액 뒷자리에 확인용 1~99원이 더해집니다 (예: ' + won(PRICE.price + 47) + ').' }));
    var btn = cta.kind === 'submit'
      ? el('button', { type: 'submit', cls: 'btn primary wide lg' }, cta.text)
      : el('a', { cls: 'btn primary wide lg', href: cta.href || '/buy' }, cta.text);
    mount.appendChild(btn);
    return btn;
  }

  /* ══════════════════ 5. 랜딩 (/) ══════════════════ */

  /* 가격 조회 중 상품 카드 자리표시 — 스켈레톤.
     빈 '—' 나 단독 스피너 대신 카드 골격을 먼저 보여줘 '가격이 비어 보이는' 인상을 줄인다.
     색·간격은 기존 토큰(--bg2,--line)만 쓴다. 장식이라 스크린리더에는 숨기고 aria-busy 로 상태를 알린다.
     모양은 renderPlanCard 와 같다: 상품 줄(금액 칸 있음) 1개 + 기능 줄. */
  function skeletonCards(mount) {
    clear(mount);
    mount.setAttribute('aria-busy', 'true');
    mount.appendChild(el('article', { cls: 'card prod one sel skel', 'aria-hidden': 'true' }, [
      el('div', { cls: 'head' }, [
        el('div', { cls: 't', style: 'flex:1' }, [
          el('div', { cls: 'sk sk-ln w40', style: 'margin-bottom:9px' }),
          el('div', { cls: 'sk sk-ln w90' })
        ])
      ]),
      el('div', { style: 'display:grid;gap:8px' }, [
        el('div', { cls: 'sk sk-ln w70' }),
        el('div', { cls: 'sk sk-ln w90' })
      ]),
      el('div', { cls: 'prices' }, [0, 1].map(function () {
        return el('div', { cls: 'pr' }, [el('span', { cls: 'sk sk-pl' }), el('span', { cls: 'sk sk-pv' })]);
      }))
    ]));
    FEATURES.forEach(function () {
      mount.appendChild(el('article', { cls: 'card prod one skel', 'aria-hidden': 'true' }, [
        el('div', { cls: 'head' }, [
          el('div', { cls: 't', style: 'flex:1' }, [
            el('div', { cls: 'sk sk-ln w40', style: 'margin-bottom:9px' }),
            el('div', { cls: 'sk sk-ln w70' })
          ])
        ])
      ]));
    });
  }

  function pageHome() {
    var mount = $('#prods'), sumMount = $('#sum');
    skeletonCards(mount);

    loadPrice().then(function () {
      mount.removeAttribute('aria-busy');
      renderPlanCard(mount);
      if (sumMount) renderSum(sumMount, { kind: 'link', href: '/buy', text: '구매 신청' });
      var bank = $('#bankLine');
      if (bank && PRICE.bank) bank.textContent = '입금 계좌 · ' + PRICE.bank;
    }).catch(function (e) {
      mount.removeAttribute('aria-busy');
      clear(mount);
      mount.appendChild(el('div', { cls: 'card' }, [
        el('div', { cls: 'state bad', text: e.message || MSG_PRICE_FAIL }),
        el('div', { cls: 'center' }, [
          el('button', { cls: 'btn', type: 'button', onclick: function () { location.reload(); } }, '다시 시도')
        ])
      ]));
      /* 합계 상자는 HTML 에 있던 [구매 신청] 버튼만 남긴다 — 금액은 구매 페이지에서 다시 조회한다 */
    });

    /* 홈 모션 (UI_V5 3.6-6) — 가격을 기다리지 않는다 */
    initNav(); initDemo(); initFx(); initHow(); initFaq(); initReveal();
  }

  /* ══════════════════ 5-1. 홈 모션 (docs/UI_V5.md 5.2 · 5.3) ══════════════════
     전부 transform/opacity 만 움직인다. 동작 줄이기면 결과만 즉시 보여 준다.
     요소가 없으면 조용히 끝난다 (다른 페이지에서 불려도 안전). */

  function reducedMotion() {
    return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  }

  var ICON_PLAY  = '<svg class="ic" width="16" height="16" aria-hidden="true"><use href="#i-play"></use></svg>';
  var ICON_PAUSE = '<svg class="ic" width="16" height="16" aria-hidden="true"><use href="#i-pause"></use></svg>';

  /* 헤더: 스크롤하면 아래 선, 홈 안 앵커는 부드럽게 이동 */
  var navReady = false;
  function initNav() {
    if (navReady) return;
    navReady = true;
    var nav = $('#lnav');
    if (nav) {
      var onScroll = function () { nav.classList.toggle('scrolled', (window.scrollY || window.pageYOffset || 0) > 8); };
      window.addEventListener('scroll', onScroll, { passive: true });
      onScroll();
    }
    if ((document.body.getAttribute('data-page') || '') !== 'home') return;   // 다른 페이지는 /#… 로 그냥 이동
    document.addEventListener('click', function (e) {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      var a = e.target && e.target.closest ? e.target.closest('a[href]') : null;
      if (!a || a.classList.contains('skip')) return;
      var m = (a.getAttribute('href') || '').match(/^\/?#([A-Za-z][\w-]*)$/);
      if (!m) return;
      var target = document.getElementById(m[1]);
      if (!target || target.id === 'main') return;
      e.preventDefault();
      target.scrollIntoView({ behavior: reducedMotion() ? 'auto' : 'smooth', block: 'start' });
      try { history.replaceState(null, '', '#' + m[1]); } catch (er) { /* 주소 표시만 못 바꾼다 */ }
    });
  }

  /* 시연 창 — requestAnimationFrame 타임라인 (5.2).
     마크업 기본 상태가 마지막 장면이라 JS 없이도, 동작 줄이기여도 완성된 화면이 보인다. */
  function initDemo() {
    var demo = $('#demo'), playBtn = $('#demoPlay');
    if (!demo || !playBtn) return;
    var chaps = $$('.chap');
    var OUT = '현재 1만 로벅스 기준 13,500원입니다. 거래방 공지 확인 부탁드립니다.';
    var CH = [0, 3200, 6800, 9800, 12800, 16400], END = 18200, TYPE0 = 3400, TYPE1 = 5700;
    var D = { t: END, playing: false, last: 0, raf: 0, user: false, started: false, auto: false, inView: true };
    var byId = function (id) { return document.getElementById(id); };
    function on() { for (var i = 0; i < arguments.length; i++) { var e = byId(arguments[i]); if (e) e.classList.remove('is-off'); } }
    function off() { for (var i = 0; i < arguments.length; i++) { var e = byId(arguments[i]); if (e) e.classList.add('is-off'); } }
    function badge(n, bump) {
      var b = byId('dBadge'); if (!b) return;
      b.textContent = String(n);
      if (bump && !demo.classList.contains('instant') && !reducedMotion()) { b.classList.remove('bump'); void b.offsetWidth; b.classList.add('bump'); }
    }
    function setText(id, t) { var e = byId(id); if (e) e.textContent = t; }
    var DYN = ['dNew', 'dHead', 'dInMeta', 'dIn', 'dInT', 'dOut', 'dOutT', 'lgJoin', 'lgLeave', 'lgProf', 'lgKick', 'dAlert'];
    var EV = [
      [0, function () {
        DYN.forEach(function (id) { off(id); }); on('dEmpty');
        byId('dNewRow').classList.remove('sel'); badge(2);
        setText('dPv', '안녕하세요, 로벅스 1만 개 시세 문의드립니다.'); setText('dType', '');
        byId('dKicks').classList.remove('go');
      }],
      [260, function () {
        on('dNew');
        var r = byId('dNewRow'); r.classList.remove('flash');
        if (!demo.classList.contains('instant')) { void r.offsetWidth; r.classList.add('flash'); }
      }],
      [420, function () { badge(3, true); }],
      [1200, function () { byId('dNewRow').classList.add('sel'); off('dEmpty'); on('dHead', 'dInMeta', 'dIn', 'dInT'); badge(2, true); }],
      [5900, function () { byId('dSend').classList.add('press'); }],
      [6060, function () { byId('dSend').classList.remove('press'); setText('dType', ''); on('dOut', 'dOutT'); setText('dPv', '나: ' + OUT); }],
      [7000, function () { on('lgJoin'); }],
      [7900, function () { on('lgLeave'); }],
      [10000, function () { on('lgProf'); }],
      [13000, function () { on('dAlert'); }],
      [13200, function () { byId('dKicks').classList.add('go'); }],
      [13600, function () { on('lgKick'); }]
    ];
    function run(from, to) { EV.forEach(function (ev) { if (ev[0] >= from && ev[0] < to) ev[1](); }); }
    function typing(t) {
      if (t >= TYPE0 && t < TYPE1 + 200) setText('dType', OUT.slice(0, Math.floor((t - TYPE0) / ((TYPE1 - TYPE0) / OUT.length))));
    }
    function chapters(t, cur) {
      chaps.forEach(function (c, i) {
        var p = clamp((t - CH[i]) / (CH[i + 1] - CH[i]), 0, 1);
        var bar = c.querySelector('.bar i');
        if (bar) bar.style.transform = 'scaleX(' + p.toFixed(3) + ')';
        var isOn = cur === undefined ? (t >= CH[i] && (t < CH[i + 1] || (i === CH.length - 2 && t >= CH[i]))) : i === cur;
        c.classList.toggle('on', isOn);
        if (isOn) c.setAttribute('aria-current', 'step'); else c.removeAttribute('aria-current');
      });
    }
    /* 0부터 CH[k] 직전까지 사건을 전환 없이 한꺼번에 적용 */
    function jump(k) {
      D.started = true;
      demo.classList.add('instant');
      var to = CH[k] === 0 ? 1 : CH[k];
      run(0, to);
      void demo.offsetWidth;
      demo.classList.remove('instant');
      D.t = to;
      chapters(D.t);
    }
    function frame(now) {
      if (!D.playing) return;
      var dt = Math.min(64, now - (D.last || now));
      D.last = now;
      var prev = D.t;
      D.t += dt;
      if (D.t >= END) { jump(0); D.last = now; D.raf = requestAnimationFrame(frame); return; }
      run(prev, D.t); typing(D.t); chapters(D.t);
      D.raf = requestAnimationFrame(frame);
    }
    function setPlay(onNow) {
      D.playing = onNow; D.last = 0;
      playBtn.innerHTML = onNow ? ICON_PAUSE : ICON_PLAY;
      playBtn.setAttribute('aria-label', onNow ? '시연 일시정지' : '시연 재생');
      var caret = byId('dCaret'); if (caret) caret.style.visibility = onNow ? '' : 'hidden';
      cancelAnimationFrame(D.raf);
      if (onNow) D.raf = requestAnimationFrame(frame);
    }

    chapters(END);
    var caret0 = byId('dCaret'); if (caret0) caret0.style.visibility = 'hidden';

    if (reducedMotion()) {
      /* 재생하지 않는다. 장을 누르면 그 장이 끝난 정지 화면 */
      playBtn.disabled = true;
      playBtn.setAttribute('aria-label', '동작 줄이기 설정으로 시연이 정지되어 있습니다');
      chaps.forEach(function (c) {
        c.addEventListener('click', function () {
          var k = +c.getAttribute('data-ch');
          jump(k);
          demo.classList.add('instant'); run(CH[k], CH[k + 1]); void demo.offsetWidth; demo.classList.remove('instant');
          setText('dType', '');
          D.t = CH[k + 1] - 1;
          chapters(D.t, k);
        });
      });
      return;
    }

    playBtn.addEventListener('click', function () {
      D.user = D.playing; D.auto = false;   /* 사용자가 멈춘 경우만 '직접 멈춤' — 재생을 누른 뒤엔 화면에 돌아오면 다시 재생 */
      if (!D.playing && (!D.started || D.t >= END)) jump(0);
      setPlay(!D.playing);
    });
    chaps.forEach(function (c) {
      c.addEventListener('click', function () { D.user = false; D.auto = false; jump(+c.getAttribute('data-ch')); setPlay(true); });
    });

    /* 화면 밖이면 멈추고, 돌아오면 사용자가 직접 멈춘 경우가 아닐 때만 다시 재생 */
    if ('IntersectionObserver' in window) {
      new IntersectionObserver(function (es) {
        D.inView = es[es.length - 1].isIntersecting;
        if (!D.inView && D.playing) { D.auto = true; setPlay(false); }
        else if (D.inView && D.auto && !D.user) {
          D.auto = false;
          if (!D.started) jump(0);
          setPlay(true);
        }
      }, { threshold: 0.25 }).observe(demo);
    }
    /* 첫 1.6초는 완성된 장면을 보여 주고, 아무것도 누르지 않았으면 처음부터 재생 */
    setTimeout(function () {
      if (D.user || D.started) return;
      if (!D.inView) { D.auto = true; return; }
      jump(0); setPlay(true);
    }, 1600);
  }

  /* 세그먼트 표시 면을 눌린 버튼 위치로 */
  function segPlace(seg, instant) {
    if (!seg) return;
    var ind = $('.seg-ind', seg), b = $('button[aria-pressed="true"]', seg);
    if (!ind || !b) return;
    if (instant || reducedMotion()) ind.style.transition = 'none';
    ind.style.width = b.offsetWidth + 'px';
    ind.style.transform = 'translateX(' + (b.offsetLeft - 3) + 'px)';
    if (instant) { void ind.offsetWidth; ind.style.transition = ''; }
  }

  /* 기능 탐색기 — 탭 목록 + 축소판 화면 (5.2) */
  function initFx() {
    var list = $('#fxList'), pane = $('#fxPane'), ind = $('#fxInd'), crumb = $('#fxCrumb');
    if (!list || !pane) return;
    var tabs = $$('.fx-item', list), panes = $$('.fx-c', pane);
    if (!tabs.length) return;
    var cur = 0, swapT = null;
    tabs.forEach(function (b, i) { if (b.getAttribute('aria-selected') === 'true') cur = i; });

    function place(instant) {
      var b = tabs[cur];
      if (!ind || !b || !b.offsetParent || !ind.offsetParent) return;
      if (instant || reducedMotion()) ind.style.transition = 'none';
      ind.style.transform = 'translateY(' + b.offsetTop + 'px)';
      ind.style.height = b.offsetHeight + 'px';
      if (instant) { void ind.offsetWidth; ind.style.transition = ''; }
    }
    function show(i) { panes.forEach(function (p, k) { p.hidden = k !== i; }); }
    function select(i) {
      if (i === cur) return;
      cur = i;
      tabs.forEach(function (b, k) { b.setAttribute('aria-selected', k === i ? 'true' : 'false'); b.tabIndex = k === i ? 0 : -1; });
      if (crumb) crumb.textContent = tabs[i].getAttribute('data-crumb') || '';
      pane.setAttribute('aria-labelledby', tabs[i].id);
      clearTimeout(swapT);
      if (reducedMotion()) { show(i); pane.classList.remove('out'); }
      else {
        pane.classList.add('out');
        swapT = setTimeout(function () { show(i); pane.classList.remove('out'); }, 170);
      }
      /* 설명 줄이 펼쳐지며 탭 높이가 바뀌므로 420ms 동안 위치를 따라간다 */
      var t0 = performance.now();
      (function track() { place(false); if (performance.now() - t0 < 420) requestAnimationFrame(track); })();
      /* 폰: 가로 스크롤 줄에서 새 탭이 보이게 */
      var b = tabs[i];
      if (list.scrollWidth > list.clientWidth + 1) {
        try { list.scrollTo({ left: Math.max(0, b.offsetLeft - 16), behavior: reducedMotion() ? 'auto' : 'smooth' }); }
        catch (e) { list.scrollLeft = Math.max(0, b.offsetLeft - 16); }
      }
    }
    list.addEventListener('click', function (e) {
      var b = e.target.closest ? e.target.closest('.fx-item') : null;
      if (b) select(tabs.indexOf(b));
    });
    list.addEventListener('keydown', function (e) {
      var n = null, last = tabs.length - 1;
      if (e.key === 'ArrowDown' || e.key === 'ArrowRight') n = cur === last ? 0 : cur + 1;
      else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') n = cur === 0 ? last : cur - 1;
      else if (e.key === 'Home') n = 0;
      else if (e.key === 'End') n = last;
      if (n === null) return;
      e.preventDefault();
      select(n);
      tabs[n].focus();
    });
    place(true);
    window.addEventListener('resize', function () { place(true); });
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(function () { place(true); });
  }

  /* 동작 방식 구조도 — 화면에 있을 때만 점이 흐른다 (SMIL) */
  function initHow() {
    var box = $('#howBox');
    if (!box) return;
    var svgs = $$('svg', box);
    function pause() { svgs.forEach(function (s) { if (s.pauseAnimations) s.pauseAnimations(); }); }
    function play() { svgs.forEach(function (s) { if (s.unpauseAnimations) s.unpauseAnimations(); }); }
    pause();
    if (reducedMotion() || !('IntersectionObserver' in window)) return;
    new IntersectionObserver(function (es) {
      if (es[es.length - 1].isIntersecting) play(); else pause();
    }, { threshold: 0.2 }).observe(box);
  }

  /* 질문 — 열고 닫기, 분류 */
  function initFaq() {
    var list = $('#faqList'), seg = $('#faqSeg');
    if (!list) return;
    list.addEventListener('click', function (e) {
      var q = e.target.closest ? e.target.closest('.faq-q') : null;
      if (!q) return;
      var it = q.parentNode, open = !it.classList.contains('open');
      it.classList.toggle('open', open);
      q.setAttribute('aria-expanded', open ? 'true' : 'false');
    });
    if (!seg) return;
    seg.addEventListener('click', function (e) {
      var b = e.target.closest ? e.target.closest('button[data-c]') : null;
      if (!b || b.getAttribute('aria-pressed') === 'true') return;
      $$('button[data-c]', seg).forEach(function (x) { x.setAttribute('aria-pressed', x === b ? 'true' : 'false'); });
      segPlace(seg);
      var cat = b.getAttribute('data-c'), n = 0, anim = !reducedMotion();
      $$('.faq-i', list).forEach(function (it) {
        var show = !cat || it.getAttribute('data-cat') === cat;
        it.hidden = !show;
        it.classList.remove('in');
        if (show && anim) { it.style.setProperty('--i', String(n++)); void it.offsetWidth; it.classList.add('in'); }
      });
    });
    segPlace(seg, true);
    window.addEventListener('resize', function () { segPlace(seg, true); });
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(function () { segPlace(seg, true); });
  }

  /* 스크롤 진입 — 화면 아래 블록만 24px 아래에서 제자리로. 투명도는 바꾸지 않는다 */
  function initReveal() {
    if (reducedMotion() || !('IntersectionObserver' in window)) return;
    var io = new IntersectionObserver(function (es) {
      es.forEach(function (en) { if (en.isIntersecting) { en.target.classList.remove('armed'); io.unobserve(en.target); } });
    }, { rootMargin: '0px 0px -6% 0px', threshold: 0.06 });
    $$('.rv').forEach(function (n) {
      if (n.getBoundingClientRect().top > window.innerHeight) { n.classList.add('armed'); io.observe(n); }
    });
  }

  /* ══════════════════ 6. 구매 신청 (/buy) ══════════════════
     상품은 하나라 입력은 입금자명(필수) · 연락처 · 메모 · 기존 키(연장 시)뿐이다.
     금액은 서버가 정한다 (기본가 + 뒷자리 1~99원). 화면은 응답 금액을 그대로 보여준다. */

  function pageBuy() {
    var q = qs();
    var form = $('#orderForm');
    var featMount = $('#planFeats'), sumMount = $('#sum');
    var keyIn = $('#key'), depIn = $('#depositor'), conIn = $('#contact'), memoIn = $('#memo');
    var submitBtn = null;

    /* /my [연장 구매] 에서 넘어온 키 채우기 */
    var preKey = normKey(q.get('key') || '');
    if (preKey) keyIn.value = preKey;

    keyIn.addEventListener('input', function () {
      var atEnd = keyIn.selectionStart === keyIn.value.length;
      var v = normKey(keyIn.value);
      if (v !== keyIn.value && atEnd) { keyIn.value = v; }
    });
    keyIn.addEventListener('blur', function () { keyIn.value = normKey(keyIn.value); });

    /* 가격표를 못 받으면 금액을 보여줄 수 없다 → 폼을 그대로 두고 [다시 시도] 만 내준다.
       페이지 새로고침(location.reload)은 사용자가 적어둔 입금자명·메모를 날려먹으니 쓰지 않는다. */
    function initPricing() {
      submitBtn = null;
      clear(sumMount);
      sumMount.className = 'sum';
      sumMount.appendChild(el('div', { cls: 'state' }, [el('div', { cls: 'spin' }), '가격 조회 중…']));
      loadPrice().then(function () {
        renderFeatRows(featMount);
        submitBtn = renderSum(sumMount, { kind: 'submit', text: '주문 접수' });
        var bank = $('#bankHint');
        if (bank) {
          bank.textContent = PRICE.bank
            ? '입금 계좌 · ' + PRICE.bank + ' · 주문 접수 후 재안내됩니다'
            : '입금 계좌는 주문 접수 후 안내됩니다';
        }
      }).catch(function (e) {
        clear(sumMount);
        sumMount.appendChild(el('p', { cls: 'err', text: (e && e.message) || MSG_PRICE_FAIL }));
        sumMount.appendChild(el('p', { cls: 'hint', text: '입력한 내용은 그대로 유지됩니다. 아래 버튼을 선택하십시오.' }));
        sumMount.appendChild(el('div', null, [
          el('button', { type: 'button', cls: 'btn sm', onclick: initPricing }, '다시 시도')
        ]));
      });
    }
    initPricing();

    function setErr(fldId, msg) {
      var fld = $('#fld-' + fldId);
      var box = $('#err-' + fldId);
      if (fld) fld.classList.toggle('bad', !!msg);
      if (box) { box.textContent = msg || ''; box.hidden = !msg; }
    }

    form.addEventListener('submit', function (ev) {
      ev.preventDefault();
      if (!submitBtn) { toast(MSG_PRICE_FAIL, 'bad'); return; }

      ['depositor', 'contact', 'key'].forEach(function (k) { setErr(k, ''); });
      var errBox = $('#submitErr');
      if (errBox) errBox.hidden = true;

      var dep = str(depIn.value), con = str(conIn.value), memo = str(memoIn.value);
      var key = normKey(keyIn.value);
      var bad = null;

      if (!dep) { setErr('depositor', '입금자명을 입력하십시오'); bad = bad || depIn; }
      if (key && !KEY_RE.test(key)) { setErr('key', '키 형식이 올바르지 않습니다. KAKA-XXXX-XXXX-XXXX 형식으로 입력하십시오'); bad = bad || keyIn; }

      if (bad) {
        toast('미입력 항목이 있습니다', 'bad');
        if (bad.focus) bad.focus();
        bad.scrollIntoView({ block: 'center' });
        return;
      }

      var btn = submitBtn;
      btn.disabled = true;
      btn.textContent = '접수 중…';

      /* 기능·기간은 보내지 않는다 — 서버가 항상 기능 3종 + 현재 플랜으로 받는다 */
      api('/api/order', {
        method: 'POST',
        body: {
          depositor: dep,
          buyer_name: dep,
          contact: con,
          memo: memo,
          target_key: key || null
        }
      }).then(function (res) {
        showResult(res, key);
      }).catch(function (e) {
        btn.disabled = false;
        btn.textContent = '주문 접수';
        var msg = e.message || '주문 접수에 실패했습니다';
        toast(msg, 'bad');
        /* 어느 칸이 문제인지 서버 reason 으로 짚어준다 */
        if (e.code === 'invalid_key' || e.code === 'key_blocked') { setErr('key', msg); keyIn.focus(); }
        else if (e.code === 'no_depositor') { setErr('depositor', msg); depIn.focus(); }
        else if (errBox) { errBox.textContent = msg; errBox.hidden = false; }
      });
    });

    function showResult(res, key) {
      applyAutoCopy(res && res.auto_approve);    // 접수 직후 안내 문구도 자동/수동을 맞춘다
      var id     = str(pick(res, ['id', 'order_id', 'orderId']));
      var token  = str(pick(res, ['token', 't']));
      var amt    = amount(pick(res, ['amount', 'total']));
      var base   = amount(pick(res, ['base_amount', 'baseAmount']));
      var suffix = num(pick(res, ['suffix']));
      var review = !!pick(res, ['needs_review', 'needsReview']);
      var acct   = str(pick(res, ['account', 'bank', 'bank_info', 'bankInfo'])) || (PRICE && PRICE.bank) || '';
      var labels = Array.isArray(res && res.feature_labels) ? res.feature_labels.map(str).filter(Boolean)
                 : (Array.isArray(res && res.features) ? res.features.map(featName) : featList().map(function (f) { return f.label; }));
      var link   = id ? orderUrl(id, token) : '';
      var full   = link ? (location.origin + link) : '';
      if (id && token) saveToken(id, token);

      var wrapEl = $('#formWrap');
      var out = $('#result');
      if (wrapEl) wrapEl.hidden = true;
      clear(out);
      out.hidden = false;

      /* base 가 응답에 없고 suffix 만 있으면 base 를 역산한다 (금액 - 뒷자리) */
      if (base === null && amt !== null && suffix !== null && suffix > 0) base = amt - suffix;

      out.appendChild(el('div', { cls: 'card' }, [
        el('div', { cls: 'chip ok', text: '주문 접수됨' }),
        el('h2', { style: 'margin:12px 0 6px',
                   text: issueMsg(review) }),
        el('p', { cls: 'sub small', style: 'margin-bottom:16px',
                  text: review
                    ? '아래 계좌로 표시된 금액을 정확히 입금하십시오. 이 주문은 금액만으로 식별이 불가하여 관리자가 직접 확인합니다. 입금자명도 입력한 이름과 동일하게 하십시오.'
                    : '아래 계좌로 금액을 뒷자리까지 정확히 입금하십시오. 해당 금액으로 주문을 조회하여 키를 자동 발급합니다. 입금자명을 입력한 이름과 동일하게 하면 확인이 더 정확합니다.' }),

        /* 입금 금액 — 화면에서 가장 크게 (SPEC 12.1) */
        amountBlock(amt, base, review),
        el('div', { style: 'height:10px' }),

        /* 계좌 */
        el('div', { cls: 'big' }, [
          el('div', { cls: 'k', text: '입금 계좌' }),
          el('div', { cls: 'v sm', text: acct || '관리자에게 문의' }),
          acct ? el('div', { cls: 'btn-row' }, [copyBtn(function () { return acct; }, '계좌')]) : null
        ]),
        el('div', { style: 'height:10px' }),

        /* 주문번호 */
        el('div', { cls: 'big' }, [
          el('div', { cls: 'k', text: '주문번호' }),
          el('div', { cls: 'v accent mono sm', text: id || '(응답에 주문번호 없음)' }),
          el('div', { cls: 'btn-row' }, [
            id ? copyBtn(function () { return id; }, '주문번호') : null,
            link ? el('a', { cls: 'btn sm primary', href: link }, '주문 상태 보기 (자동 갱신)') : null
          ])
        ]),

        /* 48시간 미입금 자동취소 (서버 ORDER_PENDING_TTL_MS) — 접수 직후에 미리 알려준다 */
        el('div', { style: 'height:12px' }),
        el('div', { cls: 'note dim' }, [
          el('span', { cls: 'ic', 'aria-hidden': 'true', text: 'i' }),
          el('span', { text: TTL_MSG })
        ]),

        review ? el('div', { style: 'height:12px' }) : null,
        review ? el('div', { cls: 'note warn' }, [
          el('span', { cls: 'ic', 'aria-hidden': 'true', text: '!' }),
          el('span', { text: '대기 주문이 다수여서 금액만으로 식별이 불가합니다. 관리자가 직접 확인하며 최대 수 시간이 소요됩니다. 입금 후 연락처로 통보하면 처리가 신속합니다.' })
        ]) : null,

        el('div', { style: 'height:16px' }),
        el('dl', { cls: 'kv' }, [
          el('div', { cls: 'r' }, [el('dt', { text: '상품' }),
            el('dd', { text: productText(str(pick(res, ['plan'])), pick(res, ['plan_label', 'planLabel']), pick(res, ['days'])) })]),
          el('div', { cls: 'r' }, [el('dt', { text: '포함 기능' }), el('dd', { text: labels.join(' · ') || '-' })]),
          key ? el('div', { cls: 'r' }, [el('dt', { text: '연장할 키' }), el('dd', { cls: 'mono', text: key })]) : null
        ])
      ]));

      /* 토큰이 든 링크를 잃어버리면 발급된 키를 웹에서 못 본다 → 크게 안내 */
      if (link) {
        out.appendChild(el('div', { cls: 'card' }, [
          el('p', { cls: 'eyebrow', style: 'margin-bottom:6px', text: '이 링크를 보관하십시오' }),
          el('p', { cls: 'sub small', style: 'margin-bottom:10px' }, [
            '발급된 키는 ', el('b', { text: '이 링크(주문번호 + 확인코드)' }),
            '로 접속해야 확인할 수 있습니다. 카카오톡 나에게 보내기 등에 보관하십시오.'
          ]),
          el('div', { cls: 'big' }, [
            el('div', { cls: 'k', text: '주문 상태 링크' }),
            el('div', { cls: 'v sm mono lnk', text: full }),
            el('div', { cls: 'btn-row' }, [
              copyBtn(function () { return full; }, '링크'),
              el('a', { cls: 'btn sm primary', href: link }, '열기' )
            ])
          ]),
          el('p', { cls: 'tiny dim', style: 'margin:10px 0 0',
                    text: '확인코드가 이 브라우저에 저장되어, 동일 브라우저에서는 주문번호만으로 재조회가 가능합니다.' })
        ]));
      }

      window.scrollTo(0, 0);
      toast('주문이 접수되었습니다', 'ok');
    }
  }

  /* ══════════════════ 7. 내 키 조회 (/my) ══════════════════ */

  function pageMy() {
    var form = $('#lookupForm'), keyIn = $('#key'), out = $('#result');
    var renew = $('#renewLink');

    /* [연장 구매] 링크는 입력된 키를 /buy 로 넘긴다 (형식이 맞을 때만) */
    function syncRenew() {
      if (!renew) return;
      var k = normKey(keyIn.value);
      renew.setAttribute('href', buyUrl(KEY_RE.test(k) ? k : ''));
    }

    keyIn.addEventListener('input', function () {
      var atEnd = keyIn.selectionStart === keyIn.value.length;
      var v = normKey(keyIn.value);
      if (v !== keyIn.value && atEnd) keyIn.value = v;
      syncRenew();
    });
    keyIn.addEventListener('blur', function () { keyIn.value = normKey(keyIn.value); syncRenew(); });

    var preKey = normKey(qs().get('key') || '');
    if (preKey) keyIn.value = preKey;
    syncRenew();

    /* 관리자 연락처를 서버가 주면 안내 카드에 채운다 (없으면 기본 문구 그대로).
       링크/이메일/전화번호는 한 번 눌러서 바로 연락되게 만든다. */
    loadPrice().then(function () {
      var c = $('#adminContact');
      if (c && PRICE.contact) {
        clear(c);
        c.className = 'tiny sub para-t';
        c.appendChild(el('b', { text: '관리자 연락처 · ' }));
        linkify(PRICE.contact).forEach(function (n) {
          c.appendChild(typeof n === 'string' ? document.createTextNode(n) : n);
        });
      }
    }).catch(function () {});

    form.addEventListener('submit', function (ev) {
      ev.preventDefault();
      var key = normKey(keyIn.value);
      keyIn.value = key;
      syncRenew();
      var errBox = $('#err-key');
      errBox.hidden = true;

      if (!key) { errBox.textContent = '키를 입력하십시오'; errBox.hidden = false; keyIn.focus(); return; }
      if (!KEY_RE.test(key)) { errBox.textContent = '키 형식이 올바르지 않습니다. KAKA-XXXX-XXXX-XXXX 형식으로 입력하십시오'; errBox.hidden = false; keyIn.focus(); return; }

      var btn = $('#lookupBtn');
      btn.disabled = true; btn.textContent = '조회 중…';
      clear(out); out.hidden = false;
      out.appendChild(el('div', { cls: 'card' }, [el('div', { cls: 'state' }, [el('div', { cls: 'spin' }), '조회 중…'])]));

      api('/api/lookup', { method: 'POST', body: { key: key } })
        .then(function (res) { renderLookup(out, key, res); })
        .catch(function (e) {
          clear(out);
          out.appendChild(el('div', { cls: 'card' }, [
            el('div', { cls: 'state bad', text: e.message || '조회에 실패했습니다' }),
            el('p', { cls: 'center tiny dim', style: 'margin:0',
                      text: '입력한 키를 확인하십시오. 동일한 오류가 반복되면 관리자에게 문의하십시오.' })
          ]));
          toast(e.message || '조회에 실패했습니다', 'bad');
        })
        .then(function () { btn.disabled = false; btn.textContent = '조회'; });
    });

    if (preKey && KEY_RE.test(preKey)) {
      /* 주문 상태 화면 [내 키 보기] 로 키가 들어왔으면 바로 조회 */
      if (typeof form.requestSubmit === 'function') form.requestSubmit();
      else form.dispatchEvent(new Event('submit', { cancelable: true }));
    }
  }

  /* /api/lookup 응답 정규화 → 기능맵 { id: {on, expiresAt, plan, planLabel, label, daysLeft} } */
  function pickFeatures(res) {
    var src = pick(res, ['feature_list', 'featureList', 'features', 'feature', 'entitlements', 'ents']);
    if (!src) {
      var lic = pick(res, ['license', 'lic', 'data']);
      if (lic) src = pick(lic, ['features', 'entitlements']);
    }
    var map = {};
    FEAT_IDS.forEach(function (id) { map[id] = { on: false, expiresAt: 0, plan: '', planLabel: '', label: '', daysLeft: null }; });
    if (!src) return map;

    function entry(e) {
      var exp = ts(pick(e, ['expires_at', 'expiresAt', 'expire_at']));
      var on = pick(e, ['on', 'active', 'enabled']);
      return {
        on: on === undefined ? exp > Date.now() : !!on,
        expiresAt: exp,
        plan: str(pick(e, ['plan', 'plan_id'])),
        planLabel: str(pick(e, ['plan_label', 'planLabel'])),
        label: str(pick(e, ['label', 'name'])),
        daysLeft: num(pick(e, ['days_left', 'daysLeft']))
      };
    }

    if (Array.isArray(src)) {
      src.forEach(function (e) {
        if (!e || typeof e !== 'object') return;
        var id = str(pick(e, ['feature', 'id', 'key', 'code']));
        if (!map[id]) return;
        map[id] = entry(e);
      });
      return map;
    }
    if (typeof src === 'object') {
      FEAT_IDS.forEach(function (id) {
        var e = src[id];
        if (e === undefined || e === null) return;
        if (typeof e === 'object') map[id] = entry(e);
        else if (typeof e === 'number') map[id] = { on: ts(e) > Date.now(), expiresAt: ts(e), plan: '', planLabel: '', label: '', daysLeft: null };
        else if (typeof e === 'boolean') map[id] = { on: e, expiresAt: 0, plan: '', planLabel: '', label: '', daysLeft: null };
      });
    }
    return map;
  }

  function renderLookup(out, key, res) {
    var now = ts(pick(res, ['now', 'ts', 'server_time'])) || Date.now();
    var feats = pickFeatures(res);
    var revoked = !!pick(res, ['revoked']);
    var blockedOn = !!pick(res, ['blocked']);
    var stopped = revoked || blockedOn;
    var activated = ts(pick(res, ['activated_at', 'activatedAt']));
    var srvExp = ts(pick(res, ['expires_at', 'expiresAt']));   // 기능 중 가장 늦은 만료 (서버 계산)
    var maxExp = 0;

    /* 키 전체 상태 — 기능 하나라도 쓰는 중이면 사용 중. 산 기능이 아직 시작 전이면 사용 대기
       (기간은 콘솔 첫 로그인 때 시작된다) */
    var anyOn = false, anyWait = false, anyOwned = false;
    FEAT_IDS.forEach(function (id) {
      var st = feats[id];
      if (st.expiresAt > maxExp) maxExp = st.expiresAt;
      if (st.on && st.expiresAt > now) anyOn = true;
      if (!st.expiresAt && st.plan) anyWait = true;
      if (st.expiresAt || st.plan) anyOwned = true;
    });
    if (srvExp) maxExp = srvExp;
    var leftAll = daysLeft(maxExp, now);

    var stateChip;
    if (revoked) stateChip = el('span', { cls: 'chip bad', text: '사용 중지' });
    else if (blockedOn) stateChip = el('span', { cls: 'chip bad', text: '차단됨' });
    else if (anyOn) stateChip = el('span', { cls: 'chip ' + (leftAll <= 7 ? 'warn' : 'ok'),
                                             text: (leftAll <= 7 ? '만료 임박 · ' : '사용 중 · ') + 'D-' + leftAll });
    else if (anyWait) stateChip = el('span', { cls: 'chip info', text: '사용 대기' });
    else stateChip = el('span', { cls: 'chip', text: anyOwned ? '만료됨' : '미구매' });

    var metaLine = '';
    if (anyOn && maxExp) metaLine = '만료 ' + dateKr(maxExp, true) + (activated ? ' · 사용 시작 ' + dateKr(activated, true) : '');
    else if (anyWait) metaLine = '콘솔에 이 키로 처음 로그인하는 시점부터 사용 기간이 시작됩니다.';
    else if (maxExp) metaLine = '만료 ' + dateKr(maxExp, true);

    clear(out);

    out.appendChild(el('div', { cls: 'card' }, [
      el('div', { cls: 'chip-row' }, [
        el('span', { cls: 'chip info', text: '라이선스 키' }),
        stateChip
      ]),
      el('div', { cls: 'v keyline', text: key }),
      el('div', { cls: 'btn-row' }, [
        copyBtn(function () { return key; }, '키'),
        stopped ? null : el('a', { cls: 'btn sm' + (anyOn || anyWait ? ' primary' : ''), href: '/panel' }, '콘솔 열기'),
        stopped ? null : el('a', { cls: 'btn sm' + (anyOn || anyWait ? '' : ' primary'), href: buyUrl(key) }, '연장 구매')
      ]),
      metaLine ? el('p', { cls: 'tiny dim', style: 'margin:12px 0 0', text: metaLine }) : null,
      revoked ? el('p', { cls: 'err', style: 'margin:10px 0 0', text: '사용이 중지된 키입니다. 관리자에게 문의하십시오.' })
              : (blockedOn ? el('p', { cls: 'err', style: 'margin:10px 0 0',
                                       text: '관리자가 차단한 키입니다. 관리자에게 문의하십시오.' }) : null)
    ]));

    /* 기능별 남은 기간 — 새 키는 세 기능이 같은 날 끝난다. 예전에 기능별로 산 키는 다를 수 있다 */
    var list = el('div', { cls: 'card' }, [
      el('p', { cls: 'eyebrow', style: 'margin-bottom:2px', text: '기능별 남은 기간' })
    ]);

    FEAT_IDS.forEach(function (id) {
      var st = feats[id];
      var name = st.label || featName(id);
      /* 서버가 days_left 를 주면 그걸 믿는다 (시계 차이로 하루 어긋나는 걸 막음) */
      var left = (st.daysLeft === null || st.daysLeft === undefined) ? daysLeft(st.expiresAt, now) : st.daysLeft;
      var on = st.on && left > 0;
      var notStarted = !on && !st.expiresAt && !!st.plan;   // 구매했지만 콘솔에 아직 로그인 안 함
      var denom = planDays(st.plan) || Math.max(DAYS_FALLBACK, left);
      var pct = on ? clamp(Math.round(left / denom * 100), 3, 100) : (notStarted ? 100 : 0);
      var barCls = 'bar' + (!on ? ' off' : (left <= 3 ? ' bad' : (left <= 7 ? ' warn' : '')));

      var chip = on
        ? el('span', { cls: 'chip ' + (left <= 7 ? 'warn' : 'ok'), text: (left <= 7 ? '만료 임박 · ' : '사용 중 · ') + 'D-' + left })
        : (notStarted ? el('span', { cls: 'chip info', text: '사용 대기' })
                      : el('span', { cls: 'chip', text: st.expiresAt ? '만료됨' : '미구매' }));

      var bar = el('div', {
        cls: barCls, role: 'progressbar', 'aria-label': name + ' 남은 기간',
        'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(pct)
      }, [el('i')]);

      list.appendChild(el('div', { cls: 'feat-row' }, [
        el('div', { cls: 'r1' }, [
          el('h3', { text: name }),
          chip
        ]),
        bar,
        el('div', { cls: 'meta' }, [
          el('span', { text: st.plan ? planName(st.plan, st.planLabel) + ' 플랜' : (on ? '' : '미구매') }),
          el('span', { cls: 'left', text: st.expiresAt ? '만료 ' + dateKr(st.expiresAt, true)
                                                       : (notStarted ? '콘솔 첫 로그인 시 기간 시작' : '') })
        ])
      ]));
      /* 진행바는 그린 다음에 채워서 전환이 보이게 (reduced-motion 이면 CSS가 껀다) */
      setTimeout(function () { $('i', bar).style.width = pct + '%'; }, 30);
    });

    out.appendChild(list);
  }

  /* ══════════════════ 8. 주문 상태 (/order/:id) ══════════════════ */

  function normOrder(raw) {
    var o = (raw && typeof raw.order === 'object' && raw.order) ? raw.order : (raw || {});
    function featIds(v) {
      var out = [];
      if (!v) return out;
      (Array.isArray(v) ? v : String(v).split(/[,\s|]+/)).forEach(function (x) {
        var id = str(typeof x === 'object' ? pick(x, ['id', 'feature', 'key']) : x).toLowerCase();
        if (id && out.indexOf(id) < 0) out.push(id);
      });
      return out;
    }
    return {
      id: str(pick(o, ['id', 'order_id', 'orderId'])),
      status: (str(pick(o, ['status', 'state'])) || 'pending').toLowerCase(),
      features: featIds(pick(o, ['features', 'feature', 'items'])),
      featLabels: (Array.isArray(o.feature_labels) ? o.feature_labels : []).map(str).filter(Boolean),
      plan: str(pick(o, ['plan', 'plan_id'])),
      planLabel: str(pick(o, ['plan_label', 'planLabel'])),
      days: num(pick(o, ['days'])),
      amount: amount(pick(o, ['amount', 'total', 'price'])),
      base: amount(pick(o, ['base_amount', 'baseAmount'])),
      needsReview: !!pick(o, ['needs_review', 'needsReview']),
      /* 서버가 48시간 미입금으로 자동 취소한 주문 (SPEC · ORDER_PENDING_TTL_MS).
         사람이 취소한 것과 문구를 다르게 보여줘야 한다 — 뒤늦게 입금한 구매자를 안심시켜야 하니까. */
      autoCanceled: !!(pick(o, ['auto_canceled', 'autoCanceled']) ||
                       pick(raw, ['auto_canceled', 'autoCanceled'])),
      authed: pick(raw, ['authed']) === undefined ? null : !!raw.authed,
      created: ts(pick(o, ['created_at', 'createdAt', 'created'])),
      handled: ts(pick(o, ['handled_at', 'handledAt'])),
      issued: str(pick(o, ['issued_key', 'issuedKey'])),
      target: str(pick(o, ['target_key', 'targetKey'])),       // 연장 주문이면 기존 키 (가려진 형태)
      depositor: str(pick(o, ['depositor', 'buyer_name', 'buyerName', 'buyer'])),
      contact: str(pick(o, ['contact'])),
      memo: str(pick(o, ['memo', 'note'])),
      account: str(pick(raw, ['account', 'bank', 'bank_info', 'bankInfo'])) ||
               str(pick(o, ['account', 'bank', 'bank_info']))
    };
  }

  function pageOrder() {
    var out = $('#result'), form = $('#findForm'), idIn = $('#oid');

    var m = location.pathname.match(/\/order\/([^\/?#]+)/);
    var id = (m ? decodeURIComponent(m[1]) : '') || str(qs().get('id'));
    /* 확인코드(t)가 있어야 발급된 키를 볼 수 있다. URL에 없으면 이 브라우저에 저장된 걸 쓴다. */
    var token = str(qs().get('t')) || (id ? loadToken(id) : '');

    form.addEventListener('submit', function (ev) {
      ev.preventDefault();
      var v = str(idIn.value).toUpperCase().replace(/[^A-Z0-9-]/g, '');
      if (!v) { toast('주문번호를 입력하십시오', 'bad'); idIn.focus(); return; }
      var t = loadToken(v);
      location.href = '/order/' + encodeURIComponent(v) + (t ? '?t=' + encodeURIComponent(t) : '');
    });

    if (!id) {
      $('#findWrap').hidden = false;
      out.hidden = true;
      return;
    }
    idIn.value = id;

    /* ── 폴링 (SPEC 12.4) ───────────────────────────────────────────────
       자동 입금확인은 보통 수십 초 안에 키를 발급한다. 그동안 이 페이지가 스스로
       상태를 확인해서, 발급되는 순간 키를 띄운다. 사용자가 새로고침할 이유가 없어야 한다.
         · 5초마다 GET /api/order/:id?t=...
         · 탭이 숨으면 멈추고, 다시 보이면 즉시 한 번 확인한다
           (서버 레이트리밋 분당 30회 + Render 무료 자원 아끼려고)
         · done / canceled 면 폴링 영구 중단. pending 과 paid(입금 확인됨·발급 대기) 는 둘 다 계속 확인한다
         · 최대 30분 폴링하고 중단 → [상태 새로고침] 버튼만 남긴다
         · 네트워크 실패는 조용히 다음 차례로 넘긴다 (연속 5회면 딱 한 번만 알린다)
         · 첫 조회가 네트워크 오류로 실패해도 폴링을 시작한다. 지하철에서 페이지를 연 구매자한테
           "이 탭 열어두면 돼" 라고 약속했으니, 연결이 돌아오면 알아서 이어져야 한다.
           단 영구 실패(404 / not_found / bad_request)는 더 두드려도 소용없으니 끊는다 */
    var POLL_MS   = 5000;
    var POLL_MAX  = 30 * 60 * 1000;
    var FAIL_WARN = 5;

    var timer = null;          // 다음 폴링 타이머
    var inFlight = false;      // 요청 겹침 방지
    var polling = false;       // pending/paid 라서 계속 확인해야 하는 상태인가 (실패 재시도 중에도 true)
    var startAt = Date.now();  // 폴링 시작 시각 (30분 기준점)
    var lastAt = 0;            // 마지막 요청 시각 (focus 중복 호출 방지)
    var fails = 0, failToasted = false;
    var timedOut = false;      // 30분 초과로 중단됨
    var lastSig = '';          // 응답이 그대로면 다시 안 그린다 (깜빡임·포커스 유실 방지)
    var lastOrder = null;
    var lastError = null;      // 마지막 실패 { msg, gone } — 아직 한 번도 못 불러온 동안 화면을 유지한다
    var everLoaded = false;    // 주문을 한 번이라도 받아왔나
    var waitBox = null;        // 살아있는 표시 (점 애니메이션)
    var shownStatus = '';      // 화면에 그려 둔 상태 — 상태가 바뀌어 다시 그릴 때만 카드가 올라온다 (UI_V5 3.4)

    function orderPath(oid) {
      return '/api/order/' + encodeURIComponent(oid) + (token ? '?t=' + encodeURIComponent(token) : '');
    }

    function clearTimer() { if (timer) { clearTimeout(timer); timer = null; } }
    function stopPoll() { polling = false; clearTimer(); }

    function schedule() {
      clearTimer();
      if (!polling || timedOut) return;
      if (document.hidden) return;                       // 숨어있는 동안은 아예 쉰다
      if (Date.now() - startAt > POLL_MAX) { giveUp(); return; }
      /* 계속 실패하면 간격을 늘린다 (레이트리밋·서버 장애에 더 매달리지 않게) — 최대 20초 */
      var wait = POLL_MS * (fails > 0 ? Math.min(fails + 1, 4) : 1);
      timer = setTimeout(function () { timer = null; fetchOrder(false); }, wait);
    }

    /* 30분 지났다 — 폴링을 끊고 수동 새로고침만 남긴다 */
    function giveUp() {
      timedOut = true;
      stopPoll();
      lastSig = '';
      if (lastOrder) { render(lastOrder, id); }
      else if (lastError) { renderError(); }   // 30분 내내 연결이 안 된 경우
    }

    function elapsedKr() {
      var s = Math.round((Date.now() - startAt) / 1000);
      if (s < 0) s = 0;
      return s < 60 ? (s + '초 경과') : (Math.floor(s / 60) + '분 경과');
    }

    function tickWait() { if (waitBox && waitBox.el) waitBox.el.textContent = elapsedKr(); }

    /* 점 애니메이션 + 경과시간이 붙은 "살아있음" 표시. 폴링 중일 때만 만든다. */
    function makeWait(txt) {
      var elap = el('span', { cls: 'el', 'aria-hidden': 'true', text: elapsedKr() });
      var box = el('div', { cls: 'wait', role: 'status', style: 'margin-top:12px' }, [
        el('span', { cls: 'txt' }, [
          txt,
          el('span', { cls: 'dots', 'aria-hidden': 'true' }, [el('i'), el('i'), el('i')])
        ]),
        elap
      ]);
      waitBox = { box: box, el: elap };
      return box;
    }

    /* 48시간 미입금 자동취소 안내 (서버 ORDER_PENDING_TTL_MS) — 입금 대기 중일 때만 */
    function ttlNote() {
      return el('div', { cls: 'note dim', style: 'margin-top:10px' }, [
        el('span', { cls: 'ic', 'aria-hidden': 'true', text: 'i' }),
        el('span', { text: TTL_MSG })
      ]);
    }

    /* 불러오기 실패 화면. 영구 실패가 아니면 재시도 중이라는 걸 화면에 남긴다 —
       "다시 시도" 를 안 눌러도 알아서 이어진다는 걸 구매자가 알아야 한다. */
    function renderError() {
      var e = lastError || {};
      var retrying = polling && !timedOut && !e.gone;
      clear(out);
      waitBox = null;
      out.hidden = false;
      out.appendChild(el('div', { cls: 'card' }, [
        el('div', { cls: 'state bad', text: e.msg || '주문을 불러올 수 없습니다' }),
        el('div', { cls: 'center' }, [
          el('button', { type: 'button', cls: 'btn sm', onclick: function () { fetchOrder(true); } }, '다시 시도')
        ])
      ]));
      if (retrying) {
        out.appendChild(makeWait('재연결 시도 중'));
        out.appendChild(el('div', { cls: 'note', style: 'margin-top:10px' }, [
          el('span', { cls: 'ic', 'aria-hidden': 'true', text: 'i' }),
          el('span', { text: '네트워크가 끊긴 경우에도 이 탭을 열어 두면 연결 복구 시 자동으로 확인이 재개됩니다. ' +
                             '수동 새로고침은 필요하지 않습니다.' })
        ]));
      } else if (!e.gone && timedOut) {
        out.appendChild(el('div', { cls: 'note warn', style: 'margin-top:12px' }, [
          el('span', { cls: 'ic', 'aria-hidden': 'true', text: '!' }),
          el('span', { text: '30분간 연결되지 않아 자동 확인을 중단했습니다. [다시 시도] 를 실행하십시오. ' +
                             '동일 상태가 지속되면 주문번호와 입금자명을 첨부하여 관리자에게 문의하십시오.' })
        ]));
      }
      $('#findWrap').hidden = false;
      schedule();
    }

    /* loud=true  : 사람이 누른 조회 — 스피너와 에러 화면까지 보여준다
       loud=false : 폴링 — 바뀐 게 없으면 화면을 건드리지 않는다 */
    function fetchOrder(loud) {
      if (inFlight) { if (!loud) schedule(); return; }
      if (!loud && document.hidden) { return; }
      inFlight = true;
      lastAt = Date.now();

      if (loud) {
        out.hidden = false;
        clear(out);
        waitBox = null;
        out.appendChild(el('div', { cls: 'card' }, [
          el('div', { cls: 'state' }, [el('div', { cls: 'spin' }), '주문 조회 중…'])
        ]));
      }

      /* 계좌/이름표를 같이 쓰려고 가격표도 받아둔다 (실패해도 진행) */
      var pricing = loadPrice().catch(function () { return null; });

      api(orderPath(id)).then(function (res) {
        return pricing.then(function () {
          fails = 0; failToasted = false;
          lastError = null; everLoaded = true;
          applyAutoCopy(res && res.auto_approve);  // 주문 조회 응답에도 실려온다
          var o = normOrder(res);
          lastOrder = o;
          var sig = [o.status, o.issued, o.amount, o.handled, o.needsReview ? 1 : 0,
                     o.autoCanceled ? 1 : 0, o.authed === false ? 0 : 1].join('|');
          if (!loud && sig === lastSig) { tickWait(); return; }   // 바뀐 게 없다
          lastSig = sig;
          render(o, id);
        });
      }).catch(function (e) {
        fails++;
        var gone = e && (e.status === 404 || e.code === 'not_found' || e.code === 'bad_request');
        if (gone) stopPoll();                                     // 없는 주문은 더 두드려봐야 소용없다
        /* 첫 조회부터 실패해도 폴링을 켠다. 안 켜면 타이머가 아예 안 돌아서
           "탭만 열어두면 갱신돼" 가 거짓말이 된다. 영구 실패(gone)는 위에서 끊었다. */
        else if (!timedOut && !polling) polling = true;

        lastError = { msg: (e && e.status === 404) || (e && e.code === 'not_found')
                        ? '해당 주문번호를 찾을 수 없습니다' : ((e && e.message) || '주문을 불러올 수 없습니다'),
                      gone: !!gone };

        if (loud || gone || !everLoaded) {
          /* 폴링이 계속 실패하는 동안 같은 화면을 다시 그려서 깜빡이게 하지 않는다 */
          var esig = ['ERR', lastError.msg, gone ? 1 : 0, timedOut ? 1 : 0, polling ? 1 : 0].join('|');
          if (loud || esig !== lastSig) { lastSig = esig; renderError(); }
          else tickWait();
        } else if (fails >= FAIL_WARN && !failToasted) {
          /* 폴링 실패로 토스트를 도배하지 않는다 — 연속 5회에 한 번만 */
          failToasted = true;
          toast('상태 확인이 반복 실패하고 있습니다. 네트워크 상태를 확인하십시오. 복구 시 자동으로 재개됩니다', 'bad');
        }
      }).then(function () {
        inFlight = false;
        schedule();
      });
    }

    /* 탭이 숨으면 폴링 정지, 다시 보이면 즉시 한 번 확인 */
    document.addEventListener('visibilitychange', function () {
      if (document.hidden) { clearTimer(); return; }
      if (!polling || timedOut) return;
      if (Date.now() - startAt > POLL_MAX) { giveUp(); return; }
      if (Date.now() - lastAt < 1200) { schedule(); return; }      // 방금 했으면 중복 호출 안 한다
      fetchOrder(false);
    });
    /* focus 도 같이 받는다 (일부 인앱브라우저는 visibilitychange 를 안 쏜다) */
    window.addEventListener('focus', function () {
      if (!polling || timedOut || document.hidden) return;
      if (Date.now() - lastAt < 1200) return;
      fetchOrder(false);
    });

    fetchOrder(true);

    function render(o, oid) {
      var st = STATUS[o.status] || { kr: o.status || '알 수 없음', cls: '' };
      clear(out);
      waitBox = null;
      out.hidden = false;
      /* 실패 화면에서 열어줬던 주문번호 찾기 폼은 다시 접는다 (재연결 성공) */
      var fw = $('#findWrap');
      if (fw) fw.hidden = true;

      var showId = o.id || oid;
      var acct = o.account || (PRICE && PRICE.bank) || '';
      var pending = o.status === 'pending';
      var paid = o.status === 'paid';
      var done = o.status === 'done';
      var canceled = o.status === 'canceled' || o.status === 'cancelled';
      /* SPEC 은 paid(입금 확인됨·발급 대기)도 정식 상태다. 화면은 "키 발급만 기다리면 돼" 라고
         띄우는데 폴링이 끊겨 있으면 그 약속이 깨진다 → pending 과 paid 둘 다 계속 확인한다.
         끝나는 건 done / canceled 뿐. (모르는 상태도 일단 지켜본다 — 30분 상한이 있다) */
      var live = !(done || canceled);
      var autoCanceled = canceled && o.autoCanceled;
      /* 연장 주문은 새 키 대신 기존 키가 늘어난다 — 발급 칸에는 그 기존 키가 그대로 나온다 */
      var extend = !!o.target;
      var days = planDays(o.plan, o.days);
      var enter = !!shownStatus && shownStatus !== o.status && !reducedMotion();
      shownStatus = o.status;

      if (live && !timedOut) {
        if (!polling) { polling = true; }
      } else {
        stopPoll();
      }

      out.appendChild(el('div', { cls: 'card' + (enter ? ' in' : '') }, [
        el('div', { cls: 'chip-row' }, [
          el('span', { cls: 'chip ' + st.cls, text: autoCanceled ? '자동 취소됨 · 미입금' : st.kr }),
          o.created ? el('span', { cls: 'tiny dim', text: dateKr(o.created, true) + ' 접수' }) : null
        ]),

        /* 발급된 키 — 가장 먼저, 크게, 모노스페이스 + 복사 */
        o.issued ? el('div', { cls: 'big keybox', style: 'margin-top:13px' }, [
          el('div', { cls: 'k', text: extend ? '연장된 라이선스 키' : '발급된 라이선스 키' }),
          el('div', { cls: 'v key', text: o.issued }),
          el('div', { cls: 'btn-row' }, [
            copyBtn(function () { return o.issued; }, '키'),
            el('a', { cls: 'btn sm primary', href: '/panel' }, '콘솔 열기'),
            el('a', { cls: 'btn sm', href: '/my?key=' + encodeURIComponent(o.issued) }, '내 키 보기')
          ]),
          el('div', { cls: 'tiny warnline', text: extend
            ? '기존 키의 기간이 연장되었습니다. 콘솔에서 그대로 사용하십시오.'
            : '이 키로 콘솔에 로그인합니다. 키를 아는 사람은 누구나 콘솔에 들어갈 수 있으므로 외부에 공유하지 마십시오.' })
        ]) : null,
        o.issued ? el('div', { style: 'height:10px' }) : null,

        /* 입금 금액 — pending 동안 화면에서 가장 크게 (SPEC 12.1) */
        pending ? el('div', { style: 'height:13px' }) : null,
        pending ? amountBlock(o.amount, o.base, o.needsReview) : null,
        pending ? el('div', { style: 'height:10px' }) : null,
        pending ? el('div', { cls: 'big' }, [
          el('div', { cls: 'k', text: '입금 계좌' }),
          el('div', { cls: 'v sm', text: acct || '관리자에게 문의' }),
          acct ? el('div', { cls: 'btn-row' }, [copyBtn(function () { return acct; }, '계좌')]) : null
        ]) : null,

        /* 주문번호 */
        el('div', { cls: 'big', style: 'margin-top:' + (pending || o.issued ? '10px' : '13px') }, [
          el('div', { cls: 'k', text: '주문번호' }),
          el('div', { cls: 'v accent mono sm', text: showId }),
          el('div', { cls: 'btn-row' }, [copyBtn(function () { return showId; }, '주문번호')])
        ]),

        el('div', { style: 'height:16px' }),
        el('dl', { cls: 'kv' }, [
          el('div', { cls: 'r' }, [el('dt', { text: '상품' }),
            el('dd', { text: productText(o.plan, o.planLabel, o.days) })]),
          el('div', { cls: 'r' }, [el('dt', { text: '포함 기능' }),
            el('dd', { text: o.featLabels.length ? o.featLabels.join(' · ')
                           : (o.features.length ? o.features.map(featName).join(' · ') : '-') })]),
          !pending ? el('div', { cls: 'r' }, [el('dt', { text: '금액' }), el('dd', { cls: 'mono' }, wonKids(o.amount))]) : null,
          o.depositor ? el('div', { cls: 'r' }, [el('dt', { text: '입금자명' }), el('dd', { text: o.depositor })]) : null,
          o.target ? el('div', { cls: 'r' }, [el('dt', { text: '연장할 키' }), el('dd', { cls: 'mono', text: o.target })]) : null,
          o.memo ? el('div', { cls: 'r' }, [el('dt', { text: '메모' }), el('dd', { text: o.memo })]) : null,
          o.handled ? el('div', { cls: 'r' }, [el('dt', { text: '처리 시각' }), el('dd', { text: dateKr(o.handled, true) })]) : null
        ]),

        el('div', { style: 'height:16px' }),
        el('div', { cls: 'btn-row' }, [
          el('button', { type: 'button', cls: 'btn', onclick: function () { fetchOrder(true); } }, '상태 새로고침'),
          el('a', { cls: 'btn ghost', href: '/' }, '처음으로')
        ])
      ]));

      /* 살아있는 표시 — 폴링 중일 때만 */
      if (live && polling && !timedOut) {
        out.appendChild(makeWait(paid ? '키 발급 대기 중'
                                      : (o.needsReview ? '관리자 확인 대기 중'
                                                       : '입금 확인 대기 중')));
      }

      /* 30분 초과 — 자동 확인을 멈췄다고 분명히 알린다 */
      if (live && timedOut) {
        out.appendChild(el('div', { cls: 'note warn', style: 'margin-top:12px' }, [
          el('span', { cls: 'ic', 'aria-hidden': 'true', text: '!' }),
          el('span', { text: paid
            ? '30분간 키가 발급되지 않아 자동 확인을 중단했습니다. [상태 새로고침] 으로 재확인하십시오. ' +
              '동일 상태가 지속되면 주문번호를 첨부하여 관리자에게 문의하십시오.'
            : '30분간 입금이 확인되지 않아 자동 확인을 중단했습니다. ' +
              '[상태 새로고침] 으로 재확인하십시오. 금액을 정확히 입금했음에도 동일한 경우 ' +
              '주문번호와 입금자명을 첨부하여 관리자에게 문의하십시오.' })
        ]));
      }

      var tip;
      if (pending) {
        tip = timedOut
          ? '자동 확인이 중단되었습니다. [상태 새로고침] 으로 재확인할 수 있습니다.'
          : (o.needsReview
              ? '이 주문은 금액만으로 자동 식별이 불가하여 관리자가 직접 확인합니다. 최대 수 시간이 소요되며, 이 화면은 상태를 계속 확인합니다.'
              : (AUTO_APPROVE
                  ? '입금 후 통상 1~2분 내 키가 자동 발급됩니다. 이 화면이 5초 간격으로 상태를 확인하므로 열어 두십시오.'
                  : '입금 후 관리자가 확인하여 키를 발급합니다. 이 화면은 자동 갱신되므로 열어 두십시오.'));
      } else if (paid) {
        tip = timedOut
          ? '입금이 확인되었습니다. 자동 확인이 중단된 상태이므로 [상태 새로고침] 을 실행하십시오.'
          : '입금이 확인되었습니다. 키 발급을 대기하십시오. 이 화면은 자동 갱신되므로 열어 두십시오.';
      } else if (done) {
        tip = extend
          ? '연장된 만료일은 [내 키 보기] 에서 확인할 수 있습니다.'
          : '발급된 키로 콘솔에 로그인하면 바로 사용할 수 있습니다.';
      } else if (autoCanceled) {
        tip = TTL_CANCELED_MSG;
      } else if (canceled) {
        tip = '취소된 주문입니다. 재신청은 구매 페이지에서 진행하십시오.';
      } else {
        tip = '상태를 계속 확인하고 있습니다. 장시간 변경이 없으면 관리자에게 문의하십시오.';
      }
      out.appendChild(el('div', { cls: 'note' + (pending || autoCanceled ? ' warn' : '') , style: 'margin-top:12px' }, [
        el('span', { cls: 'ic', 'aria-hidden': 'true', text: autoCanceled ? '!' : 'i' }),
        el('span', { text: tip })
      ]));

      /* 48시간 미입금 자동취소를 미리 알려준다 (입금 대기 중일 때만) */
      if (pending) out.appendChild(ttlNote());

      /* 발급 완료 — 콘솔 로그인까지 이어서 안내한다. 설치할 것은 없다 (웹 콘솔 /panel) */
      if (done && o.issued && !extend) {
        out.appendChild(el('div', { cls: 'card', style: 'margin-top:12px' }, [
          el('p', { cls: 'eyebrow', style: 'margin-bottom:6px', text: '다음 할 일' }),
          el('ol', { cls: 'steps' }, [
            el('li', null, ['위 키를 복사하여 ', el('b', { text: '콘솔' }), '에 로그인하십시오. PC와 휴대폰 브라우저 모두 사용할 수 있습니다.']),
            el('li', { text: '사용 기간은 첫 로그인 시점부터 ' + (days ? days + '일간 ' : '') + '적용됩니다.' }),
            el('li', { text: '카카오 계정을 등록하십시오. 휴대폰 카카오톡에 표시된 입력란에 확인 번호를 입력하면 등록이 끝납니다.' }),
            el('li', { text: '계정마다 매크로, 입장·퇴장 로그, 금지어 검열 등 필요한 기능을 켜고 적용할 방을 고르십시오.' })
          ]),
          el('div', { cls: 'btn-row' }, [
            el('a', { cls: 'btn primary', href: '/panel' }, '콘솔 열기')
          ])
        ]));
      }

      if (o.needsReview && pending) {
        out.appendChild(el('div', { cls: 'note warn', style: 'margin-top:10px' }, [
          el('span', { cls: 'ic', 'aria-hidden': 'true', text: '!' }),
          el('span', { text: '입금 후 연락처로 통보하면 처리가 신속합니다. 금액은 안내된 그대로 입금하십시오.' })
        ]));
      }

      /* 확인코드(t) 없이 주문번호만으로 들어온 경우 — 발급된 키는 안 보인다 */
      if (o.authed === false) {
        out.appendChild(el('div', { cls: 'note', style: 'margin-top:10px' }, [
          el('span', { cls: 'ic', 'aria-hidden': 'true', text: 'i' }),
          el('span', null, [
            '발급된 키와 입금자 정보는 ', el('b', { text: '구매 직후 받은 링크(주문번호 + 확인코드)' }),
            '로 접속해야 확인할 수 있습니다. 링크를 분실한 경우 관리자에게 주문번호를 전달하십시오.'
          ])
        ]));
      }

      /* 폴링 재개/정지 결정을 렌더 뒤에 한 번 더 태운다 */
      schedule();
    }
  }

  /* ══════════════════ 9. 부팅 ══════════════════ */

  function boot() {
    /* 헤더 현재 위치 표시 */
    var page = document.body.getAttribute('data-page') || '';
    $$('nav.top-nav a').forEach(function (a) {
      if (a.getAttribute('data-nav') === page) a.setAttribute('aria-current', 'page');
    });

    try {
      if (page !== 'home')  initNav();
      if (page === 'home')  pageHome();
      if (page === 'buy')   pageBuy();
      if (page === 'my')    pageMy();
      if (page === 'order') pageOrder();
    } catch (e) {
      /* 에러를 삼키지 않는다 — 사용자한테 보여준다 */
      console.error(e);
      toast('화면 렌더링 중 오류가 발생했습니다: ' + (e && e.message ? e.message : e), 'bad');
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();

  /* 잡히지 않은 오류도 조용히 넘기지 않는다 */
  window.addEventListener('error', function (ev) {
    if (ev && ev.message) toast('오류: ' + ev.message, 'bad');
  });
  window.addEventListener('unhandledrejection', function (ev) {
    var r = ev && ev.reason;
    toast('오류: ' + ((r && r.message) || r || '원인 미확인'), 'bad');
  });
})();
