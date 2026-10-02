/* ───────────────────────────────────────────────────────────────
   카톡 매크로 / 봇 — 구매 웹 공통 스크립트
   페이지 구분: <body data-page="home|buy|my|order">
   쓰는 서버 API (SPEC 5장):
     GET  /api/price        가격표 (서버가 단일 소스 — 여기서 하드코딩 안 함)
     POST /api/order        주문 접수  → {ok, id, amount, account}
     GET  /api/order/:id    주문 상태
     POST /api/lookup       키 조회 (기능/만료일/기기등록여부만)
   외부 라이브러리 안 씀. 이 파일 하나에 공통 로직 다 들어있다.

   주문 상태 페이지는 무인 자동발급(SPEC 12장) 때문에 스스로 폴링한다 — 8장 pageOrder 참고.
   5초 간격 · 탭 숨으면 정지 · 다시 보이면 즉시 1회 · 최대 30분 · done/canceled 면 정지.
   ─────────────────────────────────────────────────────────────── */
(function () {
  'use strict';

  /* ══════════════════ 0. 카탈로그 (SPEC 1장) ══════════════════
     가격은 절대 여기 안 적는다. 이름/설명/불릿만. 가격은 /api/price. */

  var FEATURES = [
    {
      id: 'macro', name: '자동발송 매크로', icon: '⚡', color: 'var(--accent)', tag: '추천',
      desc: '대화방별 주기 자동발송 + 이미지 첨부 + 메시지 추적 + 오픈프로필 자동응답',
      bullets: [
        '대화방별로 주기(분 단위)와 메시지를 따로 지정',
        '이미지 최대 5장 첨부 발송',
        '메시지 추적 — 정해둔 문구가 올라오면 즉시 응답',
        '오픈프로필 개인톡 자동응답 (문구 직접 작성)',
        '{이름} {방} {시간} 자동 입력 지원'
      ]
    },
    {
      id: 'roombot', name: '대화방 관리봇', icon: '🛡', color: 'var(--accent2)', tag: '',
      desc: '입/퇴장 인사, 금지어·도배 감지, 공지 자동안내',
      bullets: [
        '입장 / 퇴장 인사 자동 발송',
        '금지어 감지 → 경고 메시지 + 횟수 누적',
        '도배 감지 (N초 안에 M개 넘으면 경고)',
        '링크 · 초대 차단 경고',
        '!공지 · !규칙 명령'
      ]
    },
    {
      id: 'minigame', name: '미니게임봇', icon: '🎲', color: 'var(--violet)', tag: '',
      desc: '끝말잇기 · 숫자야구 · 주사위 · 퀴즈 · 랭킹',
      bullets: [
        '끝말잇기 (사전 내장, 두음법칙 처리)',
        '숫자야구 3자리 · 주사위 · 가위바위보',
        '퀴즈 50문항 내장',
        '대화방별 점수 랭킹 (!랭킹)',
        '명령어 앞글자 변경 · 쿨타임 / 하루 한도'
      ]
    }
  ];

  var PLANS = [
    { id: 'month',   name: '1개월', days: 30,  note: '' },
    { id: 'quarter', name: '3개월', days: 90,  note: '' },
    { id: 'year',    name: '1년',   days: 365, note: '' }
  ];

  var FEAT_IDS  = FEATURES.map(function (f) { return f.id; });
  var BUNDLE_RATE_DEFAULT = 0.15;  // SPEC 5장 기본값. 서버가 값을 주면 그걸 쓴다.
  var BUNDLE_MIN_DEFAULT  = 3;

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
    bad_feature:   '기능을 1개 이상 선택하십시오',
    bad_plan:      '결제 기간을 선택하십시오 (1개월 / 3개월 / 1년)',
    no_depositor:  '입금자명을 입력하십시오',
    invalid_key:   '등록되지 않은 키입니다',
    not_found:     '조회 결과가 없습니다',
    revoked:       '사용이 중지된 키입니다',
    blocked:       '차단된 키입니다. 관리자에게 문의하십시오',
    expired:       '사용 기간이 만료되었습니다',
    no_entitlement:'구매한 기능이 없습니다',
    device_mismatch:'다른 기기에 등록된 키입니다 (키 1개당 기기 1대)',
    server_error:  '서버 오류가 발생했습니다. 잠시 후 다시 시도하십시오',
    rate_limited:  '요청이 너무 빈번합니다. 잠시 후 다시 시도하십시오',
    unauthorized:  '권한이 없습니다'
  };

  function featOf(id) {
    for (var i = 0; i < FEATURES.length; i++) if (FEATURES[i].id === id) return FEATURES[i];
    return null;
  }
  function featName(id) {
    var f = featOf(id);
    if (f) return (PRICE && PRICE.feats[id] && PRICE.feats[id].label) || f.name;
    return String(id || '');
  }
  function planOf(id) {
    for (var i = 0; i < PLANS.length; i++) if (PLANS[i].id === id) return PLANS[i];
    return null;
  }
  function planName(id) {
    var p = planOf(id);
    if (p) return (PRICE && PRICE.planLabel[id]) || p.name;
    return id ? String(id) : '-';
  }
  function planDays(id) {
    var p = planOf(id);
    var d = PRICE && PRICE.planDays[id];
    return num(d) || (p ? p.days : 0);
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

  /* 금액 추출 — 숫자 / "15,000원" / {amount:15000} 다 받는다 */
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

  /* ?feature=macro / ?feature=macro,roombot / ?feature=a&feature=b 다 받는다 */
  function qFeatures(q) {
    var raw = [];
    ['feature', 'features', 'f'].forEach(function (k) {
      q.getAll(k).forEach(function (v) { raw.push(v); });
    });
    var out = [];
    raw.forEach(function (v) {
      String(v).split(/[,\s|+]+/).forEach(function (x) {
        var id = x.trim().toLowerCase();
        if (FEAT_IDS.indexOf(id) >= 0 && out.indexOf(id) < 0) out.push(id);
      });
    });
    return out;
  }

  function qPlan(q) {
    var p = str(q.get('plan')).toLowerCase();
    return planOf(p) ? p : '';
  }

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

  function buyUrl(ids, plan, key) {
    var p = [];
    if (ids && ids.length) p.push('feature=' + encodeURIComponent(ids.join(',')));
    if (plan) p.push('plan=' + encodeURIComponent(plan));
    if (key) p.push('key=' + encodeURIComponent(key));
    return '/buy' + (p.length ? '?' + p.join('&') : '');
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
      el('div', { cls: 'v xl mono', text: won(v) }),
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
     서버 응답 모양이 조금 달라도 받아먹게 정규화한다. (SPEC엔 경로만 있고 키 이름은 안 박혀 있음)
     정규화 결과: { rate, min, bank, contact, feats:{id:{label,prices:{month,quarter,year}}},
                    planDays:{}, planLabel:{} }                                              */

  var PRICE = null;
  var pricePromise = null;

  function readEntry(src, id) {
    if (!src) return null;
    if (Array.isArray(src)) {
      for (var i = 0; i < src.length; i++) {
        var e = src[i];
        if (!e || typeof e !== 'object') continue;
        if (str(pick(e, ['id', 'feature', 'key', 'code', 'slug'])) === id) return e;
      }
      return null;
    }
    if (typeof src === 'object' && src[id] !== undefined) return src[id];
    return null;
  }

  function entryPrices(entry, id, root) {
    var out = {}, sub = entry && typeof entry === 'object'
      ? pick(entry, ['prices', 'price', 'plans', 'amounts', 'by_plan', 'byPlan'])
      : null;
    PLANS.forEach(function (p) {
      var v = null, cands = [entry, sub];
      for (var i = 0; i < cands.length && v === null; i++) {
        var s = cands[i];
        if (!s || typeof s !== 'object') continue;
        v = amount(pick(s, [p.id, p.id + '_price', p.id + 'Price', String(p.days), p.days]));
      }
      if (v === null) v = amount(pick(root, [id + '_' + p.id, id + '-' + p.id]));  // 납작한 형태도 허용
      if (v !== null) out[p.id] = v;
    });
    return out;
  }

  function readBundle(P, src) {
    if (!src || typeof src !== 'object') return;
    var d = pick(src, ['bundle_discount', 'bundleDiscount', 'bundle_rate', 'bundleRate',
                       'bundle', 'discount', 'discount_rate', 'discountRate']);
    if (d === undefined) return;
    if (typeof d === 'object') {
      var mn = num(pick(d, ['min', 'min_features', 'minFeatures', 'count', 'features']));
      if (mn) P.min = mn;
      d = pick(d, ['rate', 'percent', 'pct', 'value', 'ratio', 'discount', 'amount']);
    }
    var r = num(d);
    if (r !== null && r > 0) P.rate = r > 1 ? r / 100 : r;   // 15 로 와도 0.15 로 본다
  }

  function normalizePrice(raw) {
    if (!raw || typeof raw !== 'object') throw new Error(MSG_PRICE_FAIL);

    var root = raw;
    var hasTop = pick(raw, ['features', 'items', 'products', 'catalog']) !== undefined ||
                 readEntry(raw, 'macro') !== null;
    if (!hasTop) {
      /* 최상위가 껍데기면 한 겹 안쪽에서 알맹이를 찾는다 */
      ['pricing', 'price', 'prices', 'data', 'result'].forEach(function (k) {
        if (root !== raw) return;
        if (raw[k] && typeof raw[k] === 'object' && !Array.isArray(raw[k]) &&
            pick(raw[k], ['features', 'items', 'products', 'macro', 'catalog'])) root = raw[k];
      });
    }

    var P = {
      rate: BUNDLE_RATE_DEFAULT, min: BUNDLE_MIN_DEFAULT,
      bank: '', contact: '', feats: {}, planDays: {}, planLabel: {}
    };

    readBundle(P, root);
    if (root !== raw) readBundle(P, raw);

    P.bank    = str(pick(raw, ['account', 'bank', 'bank_info', 'bankInfo', 'deposit', 'deposit_account'])) ||
                str(pick(root, ['account', 'bank', 'bank_info', 'bankInfo', 'deposit', 'deposit_account']));
    P.contact = str(pick(raw, ['admin_contact', 'adminContact', 'support', 'support_contact', 'contact'])) ||
                str(pick(root, ['admin_contact', 'adminContact', 'support', 'support_contact', 'contact']));

    /* 플랜 메타(일수/이름)를 서버가 주면 반영 */
    var pm = pick(root, ['plans', 'periods', 'durations']);
    if (pm && typeof pm === 'object') {
      var list = Array.isArray(pm) ? pm : Object.keys(pm).map(function (k) {
        var v = pm[k];
        return (v && typeof v === 'object') ? Object.assign({ id: k }, v) : null;
      });
      list.forEach(function (e) {
        if (!e || typeof e !== 'object') return;
        var id = str(pick(e, ['id', 'plan', 'code']));
        if (!planOf(id)) return;
        var dd = num(pick(e, ['days', 'duration_days', 'durationDays']));
        if (dd) P.planDays[id] = dd;
        var lb = str(pick(e, ['label', 'name', 'title', 'kr']));
        if (lb) P.planLabel[id] = lb;
      });
    }

    var fsrc = pick(root, ['features', 'items', 'products', 'catalog', 'list']) || root;
    var flat = pick(root, ['prices', 'price_table', 'priceTable']);

    var found = 0;
    FEATURES.forEach(function (f) {
      var entry = readEntry(fsrc, f.id);
      if (entry === null && fsrc !== root) entry = readEntry(root, f.id);
      var prices = entryPrices(entry, f.id, root);
      if (!Object.keys(prices).length && flat) prices = entryPrices(readEntry(flat, f.id), f.id, root);
      var label = (entry && typeof entry === 'object')
        ? str(pick(entry, ['label', 'name', 'title', 'kr'])) : '';
      if (Object.keys(prices).length) found++;
      P.feats[f.id] = { label: label || f.name, prices: prices };
    });

    if (!found) throw new Error(MSG_PRICE_FAIL);
    return P;
  }

  function loadPrice() {
    if (pricePromise) return pricePromise;
    pricePromise = api('/api/price').then(function (raw) {
      PRICE = normalizePrice(raw);
      applyAutoCopy(raw && raw.auto_approve);    // 자동 발급이 꺼져 있으면 문구를 바꾼다
      return PRICE;
    }).catch(function (e) {
      pricePromise = null;                       // 다시 시도할 수 있게 캐시 비움
      throw new Error(e && e.net ? MSG_PRICE_FAIL + ' (서버 연결 실패)' : MSG_PRICE_FAIL);
    });
    return pricePromise;
  }

  function unitPrice(id, plan) {
    if (!PRICE || !PRICE.feats[id]) return null;
    var v = PRICE.feats[id].prices[plan];
    return v === undefined ? null : v;
  }

  /* 금액 계산 — 3종(=P.min개) 다 고르면 총액 할인 */
  function calc(ids, plan) {
    var r = { ok: true, subtotal: 0, discount: 0, total: 0, bundled: false, missing: [], rate: PRICE ? PRICE.rate : BUNDLE_RATE_DEFAULT, min: PRICE ? PRICE.min : BUNDLE_MIN_DEFAULT };
    ids.forEach(function (id) {
      var v = unitPrice(id, plan);
      if (v === null) { r.ok = false; r.missing.push(id); return; }
      r.subtotal += v;
    });
    if (!r.ok || !ids.length) { r.ok = r.ok && !!ids.length; return r; }
    if (ids.length >= r.min) {
      r.bundled = true;
      r.discount = Math.round(r.subtotal * r.rate);
    }
    r.total = r.subtotal - r.discount;
    return r;
  }

  /* ══════════════════ 4. 기능 선택 + 합계 (랜딩 / 구매 공용) ══════════════════ */

  function Picker(opts) {
    var self = {
      ids: (opts.ids || []).filter(function (x) { return FEAT_IDS.indexOf(x) >= 0; }),
      plan: planOf(opts.plan) ? opts.plan : 'month',
      variant: opts.variant || 'cards',      // cards(랜딩) | rows(구매폼)
      mount: opts.mount,
      planMount: opts.planMount,
      sumMount: opts.sumMount,
      onChange: opts.onChange || function () {},
      cta: opts.cta || { text: '구매 신청', kind: 'link' },
      cards: {}, boxes: {}, amts: {}
    };

    /* 플랜 세그먼트 */
    function buildPlan() {
      if (!self.planMount) return;
      clear(self.planMount);
      var box = el('div', { cls: 'seg', role: 'radiogroup', 'aria-label': '결제 기간' });
      PLANS.forEach(function (p) {
        var input = el('input', {
          type: 'radio', name: 'plan', value: p.id, id: 'plan-' + p.id,
          checked: self.plan === p.id ? true : null,
          onchange: function () { if (input.checked) { self.plan = p.id; paint(); self.onChange(self); } }
        });
        var lab = el('label', { for: 'plan-' + p.id }, [
          input,
          el('span', null, [ (PRICE && PRICE.planLabel[p.id]) || p.name, el('em', { text: planDays(p.id) + '일' }) ])
        ]);
        box.appendChild(lab);
      });
      self.planMount.appendChild(box);
    }

    /* 상품 카드 (랜딩) */
    function buildCards() {
      clear(self.mount);
      FEATURES.forEach(function (f) {
        var id = 'sel-' + f.id;
        var input = el('input', {
          type: 'checkbox', id: id, value: f.id,
          checked: self.ids.indexOf(f.id) >= 0 ? true : null,
          onchange: function () { toggle(f.id, input.checked); }
        });
        var amt = el('span', { cls: 'amt' });
        var prices = el('div', { cls: 'prices' });
        PLANS.forEach(function (p) {
          prices.appendChild(el('div', { cls: 'pr', 'data-plan': p.id }, [
            el('span', { cls: 'pl', text: (PRICE && PRICE.planLabel[p.id]) || p.name }),
            el('span', { cls: 'pv', text: '—' })
          ]));
        });

        var card = el('article', { cls: 'card prod' }, [
          el('div', { cls: 'head' }, [
            el('div', {
              cls: 'ico', 'aria-hidden': 'true',
              style: 'background:rgba(255,255,255,.05);border:1px solid var(--line);color:' + f.color
            }, f.icon),
            el('div', { cls: 't' }, [
              el('div', { style: 'display:flex;align-items:center;gap:8px;flex-wrap:wrap' }, [
                el('h3', { text: (PRICE && PRICE.feats[f.id] && PRICE.feats[f.id].label) || f.name }),
                f.tag ? el('span', { cls: 'chip ok', text: f.tag }) : null
              ]),
              el('p', { cls: 'desc', text: f.desc })
            ])
          ]),
          el('ul', { cls: 'bul' }, f.bullets.map(function (b) { return el('li', { text: b }); })),
          prices,
          el('label', { cls: 'chk', for: id }, [
            input,
            el('span', { cls: 'box', 'aria-hidden': 'true' }),
            el('span', { cls: 't' }, '선택'),
            amt
          ])
        ]);
        self.mount.appendChild(card);
        self.cards[f.id] = card; self.boxes[f.id] = input; self.amts[f.id] = amt;
      });
    }

    /* 기능 체크 줄 (구매 폼) */
    function buildRows() {
      clear(self.mount);
      FEATURES.forEach(function (f) {
        var id = 'buy-' + f.id;
        var input = el('input', {
          type: 'checkbox', id: id, name: 'feature', value: f.id,
          checked: self.ids.indexOf(f.id) >= 0 ? true : null,
          onchange: function () { toggle(f.id, input.checked); }
        });
        var amt = el('span', { cls: 'amt' });
        var wrap = el('label', { cls: 'chk', for: id, style: 'align-items:flex-start;padding:12px' }, [
          input,
          el('span', { cls: 'box', 'aria-hidden': 'true', style: 'margin-top:2px' }),
          el('span', { cls: 't' }, [
            el('span', { style: 'display:block;color:var(--text);font-size:14.5px', text: (PRICE && PRICE.feats[f.id] && PRICE.feats[f.id].label) || f.name }),
            el('span', { cls: 'tiny dim', style: 'display:block;font-weight:600;line-height:1.45', text: f.desc })
          ]),
          amt
        ]);
        self.mount.appendChild(wrap);
        self.cards[f.id] = wrap; self.boxes[f.id] = input; self.amts[f.id] = amt;
      });
    }

    function toggle(id, on) {
      var i = self.ids.indexOf(id);
      if (on && i < 0) self.ids.push(id);
      if (!on && i >= 0) self.ids.splice(i, 1);
      paint(); self.onChange(self);
    }

    /* 합계 박스 */
    function buildSum() {
      if (!self.sumMount) return;
      clear(self.sumMount);
      self.sumMount.className = 'sum';
      self.sumNudge = el('div', { cls: 'nudge', hidden: true });
      self.sumSaved = el('div', { cls: 'saved', hidden: true });
      self.sumLines = el('div', { cls: 'lines' });
      self.sumBtn = self.cta.kind === 'submit'
        ? el('button', { type: 'submit', cls: 'btn primary wide' }, self.cta.text)
        : el('button', { type: 'button', cls: 'btn primary wide', onclick: goBuy }, self.cta.text);
      self.sumMount.appendChild(self.sumNudge);
      self.sumMount.appendChild(self.sumSaved);
      self.sumMount.appendChild(self.sumLines);
      self.sumMount.appendChild(self.sumBtn);
    }

    function goBuy() {
      if (!self.ids.length) { toast('기능을 1개 이상 선택하십시오', 'bad'); return; }
      location.href = buyUrl(self.ids, self.plan, '');
    }

    function paint() {
      /* 카드 선택 표시 + 단가 */
      FEAT_IDS.forEach(function (id) {
        var card = self.cards[id];
        if (!card) return;
        var on = self.ids.indexOf(id) >= 0;
        if (self.boxes[id]) self.boxes[id].checked = on;
        card.classList.toggle('sel', on);
        var u = unitPrice(id, self.plan);
        if (self.amts[id]) self.amts[id].textContent = u === null ? '' : won(u);
        /* 랜딩 카드: 현재 플랜 가격 강조 + 가격 채우기 */
        $$('.pr', card).forEach(function (row) {
          var p = row.getAttribute('data-plan');
          row.setAttribute('data-on', p === self.plan ? '1' : '0');
          var v = unitPrice(id, p);
          var pv = $('.pv', row);
          if (pv) pv.textContent = v === null ? '—' : won(v);
        });
      });

      if (!self.sumMount) return;
      var c = calc(self.ids, self.plan);
      clear(self.sumLines);

      if (!self.ids.length) {
        self.sumLines.appendChild(el('div', { cls: 'ln' }, [
          el('span', { text: '선택된 기능 없음' }),
          el('span', { cls: 'v dim', text: '0원' })
        ]));
      } else if (!c.ok) {
        self.sumLines.appendChild(el('div', { cls: 'ln' }, [
          el('span', { cls: 'v', style: 'margin:0;color:var(--red)', text: MSG_PRICE_FAIL })
        ]));
      } else {
        var who = self.ids.length === FEATURES.length
          ? '전체 ' + FEATURES.length + '종'
          : self.ids.map(featName).join(' · ');
        self.sumLines.appendChild(el('div', { cls: 'ln' }, [
          el('span', { text: who + ' · ' + planName(self.plan) }),
          el('span', { cls: 'v mono', text: won(c.subtotal) })
        ]));
        if (c.bundled) {
          self.sumLines.appendChild(el('div', { cls: 'ln off' }, [
            el('span', { text: FEATURES.length + '종 묶음 할인 ' + Math.round(c.rate * 100) + '%' }),
            el('span', { cls: 'v mono', text: '-' + won(c.discount) })
          ]));
        }
        self.sumLines.appendChild(el('div', { cls: 'ln total' }, [
          el('span', { text: '결제 금액' }),
          el('span', { cls: 'v mono' }, [
            c.bundled ? el('s', { cls: 'was', text: won(c.subtotal) }) : null,
            document.createTextNode(won(c.total))
          ])
        ]));
      }

      /* 할인 유도 / 할인 적용 표시 */
      var need = c.min - self.ids.length;
      if (c.bundled) {
        self.sumSaved.hidden = false;
        self.sumSaved.textContent = '✓ ' + FEATURES.length + '종 묶음 ' + Math.round(c.rate * 100) + '% 할인 적용 · ' + won(c.discount) + ' 할인';
        self.sumNudge.hidden = true;
      } else {
        self.sumSaved.hidden = true;
        if (self.ids.length > 0 && need > 0 && need <= FEATURES.length) {
          self.sumNudge.hidden = false;
          self.sumNudge.textContent = need + '개 추가 선택 시 ' + FEATURES.length + '종 묶음 ' +
            Math.round(c.rate * 100) + '% 할인 적용';
        } else self.sumNudge.hidden = true;
      }

      if (self.sumBtn) {
        var dis = !self.ids.length || !c.ok;
        self.sumBtn.disabled = dis;
        self.sumBtn.setAttribute('aria-disabled', dis ? 'true' : 'false');
      }
    }

    self.paint = paint;
    self.build = function () {
      buildPlan();
      if (self.variant === 'rows') buildRows(); else buildCards();
      buildSum();
      paint();
    };
    return self;
  }

  /* ══════════════════ 5. 랜딩 (/) ══════════════════ */

  /* 가격 조회 중 상품 카드 자리표시 — 스켈레톤.
     빈 '—' 나 단독 스피너 대신 카드 골격을 먼저 보여줘 '가격이 비어 보이는' 인상을 줄인다.
     색·간격은 기존 토큰(--bg2,--line)만 쓴다. 장식이라 스크린리더에는 숨기고 aria-busy 로 상태를 알린다. */
  function skeletonCards(mount) {
    clear(mount);
    mount.setAttribute('aria-busy', 'true');
    FEATURES.forEach(function () {
      var priceRows = PLANS.map(function () {
        return el('div', { cls: 'pr' }, [
          el('span', { cls: 'sk sk-pl' }),
          el('span', { cls: 'sk sk-pv' })
        ]);
      });
      mount.appendChild(el('article', { cls: 'card prod skel', 'aria-hidden': 'true' }, [
        el('div', { cls: 'head' }, [
          el('div', { cls: 'sk sk-ico' }),
          el('div', { cls: 't', style: 'flex:1' }, [
            el('div', { cls: 'sk sk-ln w40', style: 'margin-bottom:9px' }),
            el('div', { cls: 'sk sk-ln w90' })
          ])
        ]),
        el('div', { style: 'display:grid;gap:8px' }, [
          el('div', { cls: 'sk sk-ln w70' }),
          el('div', { cls: 'sk sk-ln w90' })
        ]),
        el('div', { cls: 'prices' }, priceRows)
      ]));
    });
  }

  function pageHome() {
    var mount = $('#prods'), planMount = $('#planSeg'), sumMount = $('#sum');
    skeletonCards(mount);

    var q = qs();
    loadPrice().then(function () {
      mount.removeAttribute('aria-busy');
      clear(mount);
      var pk = Picker({
        ids: qFeatures(q), plan: qPlan(q) || 'month',
        variant: 'cards', mount: mount, planMount: planMount, sumMount: sumMount,
        cta: { text: '선택한 기능으로 구매 신청', kind: 'link' }
      });
      pk.build();
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
      if (sumMount) sumMount.hidden = true;
      if (planMount) planMount.hidden = true;
    });
  }

  /* ══════════════════ 6. 구매 신청 (/buy) ══════════════════ */

  function pageBuy() {
    var q = qs();
    var form = $('#orderForm');
    var mount = $('#featRows'), planMount = $('#planSeg'), sumMount = $('#sum');
    var keyIn = $('#key'), depIn = $('#depositor'), conIn = $('#contact'), memoIn = $('#memo');
    var androidIn = $('#androidOk');   // 안드로이드 확인 (필수 — iOS 는 아예 동작 안 함)

    /* 앱에서 넘어온 딥링크 값 채우기 */
    var preKey = normKey(q.get('key') || '');
    if (preKey) keyIn.value = preKey;      // 앱 [구매하기] 딥링크로 들어온 키

    keyIn.addEventListener('input', function () {
      var atEnd = keyIn.selectionStart === keyIn.value.length;
      var v = normKey(keyIn.value);
      if (v !== keyIn.value && atEnd) { keyIn.value = v; }
    });
    keyIn.addEventListener('blur', function () { keyIn.value = normKey(keyIn.value); });

    if (androidIn) androidIn.addEventListener('change', function () {
      if (androidIn.checked) setErr('android', '');
    });

    var pk = null;

    /* 가격표를 못 받으면 금액을 계산할 수 없다 → 폼을 그대로 두고 [다시 시도] 만 내준다.
       페이지 새로고침(location.reload)은 사용자가 적어둔 입금자명·메모를 날려먹으니 쓰지 않는다. */
    function initPricing() {
      clear(mount);
      mount.appendChild(el('div', { cls: 'state' }, [el('div', { cls: 'spin' }), '가격 조회 중…']));
      if (sumMount) sumMount.hidden = false;
      loadPrice().then(function () {
        clear(mount);
        pk = Picker({
          ids: pk ? pk.ids : qFeatures(q), plan: (pk && pk.plan) || qPlan(q) || 'month',
          variant: 'rows', mount: mount, planMount: planMount, sumMount: sumMount,
          cta: { text: '주문 접수', kind: 'submit' }
        });
        pk.build();
        var bank = $('#bankHint');
        if (bank) {
          bank.textContent = PRICE.bank
            ? '입금 계좌 · ' + PRICE.bank + ' · 주문 접수 후 재안내됩니다'
            : '입금 계좌는 주문 접수 후 안내됩니다';
        }
      }).catch(function (e) {
        pk = null;
        clear(mount);
        mount.appendChild(el('p', { cls: 'err', text: (e && e.message) || MSG_PRICE_FAIL }));
        mount.appendChild(el('p', { cls: 'hint', style: 'margin:6px 0 10px',
                                    text: '입력한 내용은 그대로 유지됩니다. 아래 버튼을 선택하십시오.' }));
        mount.appendChild(el('button', { type: 'button', cls: 'btn sm', onclick: initPricing }, '다시 시도'));
        if (sumMount) sumMount.hidden = true;
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
      if (!pk) { toast(MSG_PRICE_FAIL, 'bad'); return; }

      ['feature', 'depositor', 'contact', 'key', 'android'].forEach(function (k) { setErr(k, ''); });

      var ids = pk.ids.slice();
      var plan = pk.plan;
      var dep = str(depIn.value), con = str(conIn.value), memo = str(memoIn.value);
      var key = normKey(keyIn.value);
      var bad = null;

      if (!ids.length)  { setErr('feature', '기능을 1개 이상 선택하십시오'); bad = bad || mount; }
      if (!dep)         { setErr('depositor', '입금자명을 입력하십시오'); bad = bad || depIn; }
      if (!con)         { setErr('contact', '연락처(카카오톡 ID 또는 전화번호)를 입력하십시오'); bad = bad || conIn; }
      if (key && !KEY_RE.test(key)) { setErr('key', '키 형식이 올바르지 않습니다. KAKA-XXXX-XXXX-XXXX 형식으로 입력하십시오'); bad = bad || keyIn; }
      /* 아이폰 구매 → 환불 분쟁으로 이어진다. 확인 체크 없으면 접수 자체를 막는다 */
      if (androidIn && !androidIn.checked) {
        setErr('android', '아이폰에서는 동작하지 않습니다. 안드로이드 기기 사용 여부를 확인한 후 체크하십시오');
        bad = bad || androidIn;
      }

      var c = calc(ids, plan);
      if (ids.length && !c.ok) { setErr('feature', MSG_PRICE_FAIL); bad = bad || mount; }

      if (bad) {
        toast('미입력 항목이 있습니다', 'bad');
        if (bad.focus) bad.focus();
        bad.scrollIntoView({ block: 'center' });
        return;
      }

      var btn = pk.sumBtn;
      btn.disabled = true;
      btn.textContent = '접수 중…';

      api('/api/order', {
        method: 'POST',
        body: {
          features: ids,            // 배열로 보낸다 (서버가 쉼표 문자열로 저장)
          plan: plan,
          amount: c.total,          // 참고용 — 최종 금액은 서버 응답을 믿는다
          depositor: dep,
          buyer_name: dep,
          contact: con,
          memo: memo,
          target_key: key || null,
          /* 안드로이드 확인 체크 — 서버가 주문에 같이 저장한다 (환불 분쟁 증거).
             위 검증에서 체크 안 된 주문은 여기까지 못 오니 항상 true 다. */
          android_ok: true
        }
      }).then(function (res) {
        showResult(res, ids, plan, key, c);
      }).catch(function (e) {
        btn.disabled = false;
        btn.textContent = '주문 접수';
        var msg = e.message || '주문 접수에 실패했습니다';
        toast(msg, 'bad');
        /* 어느 칸이 문제인지 서버 reason 으로 짚어준다 */
        if (e.code === 'invalid_key') { setErr('key', msg); keyIn.focus(); }
        else if (e.code === 'no_depositor') { setErr('depositor', msg); depIn.focus(); }
        else if (e.code === 'bad_feature') { setErr('feature', msg); }
        else {
          var box = $('#submitErr');
          if (box) { box.textContent = msg; box.hidden = false; }
        }
      });
    });

    function showResult(res, ids, plan, key, c) {
      applyAutoCopy(res && res.auto_approve);    // 접수 직후 안내 문구도 자동/수동을 맞춘다
      var id     = str(pick(res, ['id', 'order_id', 'orderId']));
      var token  = str(pick(res, ['token', 't']));
      var amt    = amount(pick(res, ['amount', 'total']));
      if (amt === null) amt = c.total;
      var base   = amount(pick(res, ['base_amount', 'baseAmount']));
      var suffix = num(pick(res, ['suffix']));
      var review = !!pick(res, ['needs_review', 'needsReview']);
      var acct   = str(pick(res, ['account', 'bank', 'bank_info', 'bankInfo'])) || (PRICE && PRICE.bank) || '';
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
          el('div', { cls: 'r' }, [el('dt', { text: '기능' }), el('dd', { text: ids.map(featName).join(' · ') })]),
          el('div', { cls: 'r' }, [el('dt', { text: '기간' }), el('dd', { text: planName(plan) + ' (' + planDays(plan) + '일)' })]),
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
            el('div', { cls: 'v sm mono', style: 'font-size:13px;font-weight:600', text: full }),
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

    keyIn.addEventListener('input', function () {
      var atEnd = keyIn.selectionStart === keyIn.value.length;
      var v = normKey(keyIn.value);
      if (v !== keyIn.value && atEnd) keyIn.value = v;
    });
    keyIn.addEventListener('blur', function () { keyIn.value = normKey(keyIn.value); });

    var preKey = normKey(qs().get('key') || '');
    if (preKey) keyIn.value = preKey;

    /* 관리자 연락처를 서버가 주면 안내 카드에 채운다 (없으면 기본 문구 그대로).
       /my 는 '키 1개 = 기기 1대' 의 유일한 탈출구라서, 설명만 있고 연락할 방법이 없으면 안 된다.
       링크/이메일/전화번호는 한 번 눌러서 바로 연락되게 만든다. */
    loadPrice().then(function () {
      var c = $('#adminContact');
      if (c && PRICE.contact) {
        clear(c);
        c.className = 'tiny sub';
        c.appendChild(el('b', { text: '관리자 연락처 · ' }));
        linkify(PRICE.contact).forEach(function (n) {
          c.appendChild(typeof n === 'string' ? document.createTextNode(n) : n);
        });
      }
    }).catch(function () {});

    /* 초기화 요청 문구를 만들어준다 — 그대로 관리자에게 보내면 된다 */
    var resetBtn = $('#resetCopy');
    if (resetBtn) resetBtn.addEventListener('click', function () {
      var k = normKey(keyIn.value);
      if (!KEY_RE.test(k)) {
        toast('키를 먼저 입력하십시오. 요청 문구에 키가 포함되어야 처리됩니다', 'bad');
        keyIn.focus();
        return;
      }
      copy('[기기 초기화 요청]\n키: ' + k +
           '\n사유: (기기 교체 / 초기화 / 수리 중 선택하여 기재)' +
           '\n연락처: (구매 시 기재한 연락처)' +
           '\n새 기기에서 재활성화하기 위해 기기 초기화를 요청합니다.',
           '요청 문구가 복사되었습니다');
    });

    form.addEventListener('submit', function (ev) {
      ev.preventDefault();
      var key = normKey(keyIn.value);
      keyIn.value = key;
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
      /* 딥링크로 키가 들어왔으면 바로 조회 */
      if (typeof form.requestSubmit === 'function') form.requestSubmit();
      else form.dispatchEvent(new Event('submit', { cancelable: true }));
    }
  }

  /* /api/lookup 응답 정규화 → 기능맵 */
  function pickFeatures(res) {
    var src = pick(res, ['feature_list', 'featureList', 'features', 'feature', 'entitlements', 'ents']);
    if (!src) {
      var lic = pick(res, ['license', 'lic', 'data']);
      if (lic) src = pick(lic, ['features', 'entitlements']);
    }
    var map = {};
    FEAT_IDS.forEach(function (id) { map[id] = { on: false, expiresAt: 0, plan: '' }; });
    if (!src) return map;

    if (Array.isArray(src)) {
      src.forEach(function (e) {
        if (!e || typeof e !== 'object') return;
        var id = str(pick(e, ['feature', 'id', 'key', 'code']));
        if (!map[id]) return;
        map[id] = {
          on: pick(e, ['on', 'active', 'enabled']) === undefined
                ? ts(pick(e, ['expires_at', 'expiresAt', 'expire_at'])) > Date.now()
                : !!pick(e, ['on', 'active', 'enabled']),
          expiresAt: ts(pick(e, ['expires_at', 'expiresAt', 'expire_at'])),
          plan: str(pick(e, ['plan', 'plan_id'])),
          daysLeft: num(pick(e, ['days_left', 'daysLeft']))
        };
      });
      return map;
    }
    if (typeof src === 'object') {
      FEAT_IDS.forEach(function (id) {
        var e = src[id];
        if (e === undefined || e === null) return;
        if (typeof e === 'object') {
          map[id] = {
            on: pick(e, ['on', 'active', 'enabled']) === undefined
                  ? ts(pick(e, ['expires_at', 'expiresAt'])) > Date.now()
                  : !!pick(e, ['on', 'active', 'enabled']),
            expiresAt: ts(pick(e, ['expires_at', 'expiresAt'])),
            plan: str(pick(e, ['plan', 'plan_id']))
          };
        } else if (typeof e === 'number') {
          map[id] = { on: ts(e) > Date.now(), expiresAt: ts(e), plan: '' };
        } else if (typeof e === 'boolean') {
          map[id] = { on: e, expiresAt: 0, plan: '' };
        }
      });
    }
    return map;
  }

  function renderLookup(out, key, res) {
    var now = ts(pick(res, ['now', 'ts', 'server_time'])) || Date.now();
    var feats = pickFeatures(res);
    var devRaw = pick(res, ['device_registered', 'deviceRegistered', 'device_bound',
                            'has_device', 'activated', 'device_id', 'device']);
    var devOn = !!devRaw && devRaw !== '0' && devRaw !== 'false';
    var devName = str(pick(res, ['device_name', 'deviceName']));
    var revoked = !!pick(res, ['revoked']);
    var blockedOn = !!pick(res, ['blocked', 'blocked_reason', 'blockedReason']);
    /* 사유 문자열이 있으면 보여주고, boolean 이면 사유 없이 차단 표시만 */
    var blockedWhy = str(pick(res, ['blocked_reason', 'blockedReason']));
    if (blockedWhy === 'true' || blockedWhy === 'false') blockedWhy = '';
    var resets  = num(pick(res, ['reset_count', 'resetCount']));

    clear(out);

    var head = el('div', { cls: 'card' }, [
      el('div', { style: 'display:flex;align-items:center;gap:9px;flex-wrap:wrap' }, [
        el('span', { cls: 'chip info', text: '라이선스 키' }),
        devOn ? el('span', { cls: 'chip ok', text: '기기 등록됨' }) : el('span', { cls: 'chip', text: '기기 미등록' }),
        revoked ? el('span', { cls: 'chip bad', text: '사용 중지' }) : null,
        blockedOn ? el('span', { cls: 'chip bad', text: '차단됨' }) : null
      ]),
      el('div', { cls: 'v mono', style: 'font-size:clamp(17px,5vw,22px);font-weight:800;margin:11px 0 4px;word-break:break-all', text: key }),
      el('div', { cls: 'btn-row' }, [copyBtn(function () { return key; }, '키')]),
      devName ? el('p', { cls: 'tiny dim', style: 'margin:12px 0 0', text: '등록 기기 · ' + devName }) : null,
      (resets !== null && resets > 0) ? el('p', { cls: 'tiny dim', style: 'margin:4px 0 0', text: '기기 초기화 이력 ' + resets + '회' }) : null,
      blockedWhy ? el('p', { cls: 'err', style: 'margin:10px 0 0', text: '차단 사유 · ' + blockedWhy })
                 : (blockedOn ? el('p', { cls: 'err', style: 'margin:10px 0 0',
                                          text: '관리자가 차단한 키입니다. 관리자에게 문의하십시오.' }) : null)
    ]);
    out.appendChild(head);

    /* 기능별 남은 기간 */
    var list = el('div', { cls: 'card' }, [
      el('p', { cls: 'eyebrow', style: 'margin-bottom:2px', text: '기능별 남은 기간' })
    ]);

    FEATURES.forEach(function (f) {
      var st = feats[f.id];
      /* 서버가 days_left 를 주면 그걸 믿는다 (시계 차이로 하루 어긋나는 걸 막음) */
      var left = (st.daysLeft === null || st.daysLeft === undefined) ? daysLeft(st.expiresAt, now) : st.daysLeft;
      var on = st.on && left > 0;
      var denom = planDays(st.plan) || Math.max(30, left);
      var pct = on ? clamp(Math.round(left / denom * 100), 3, 100) : 0;
      if (!on && !st.expiresAt && st.plan) pct = 100;   // 활성화 대기: 기간 안 깎임
      var barCls = 'bar' + (!on ? ' off' : (left <= 3 ? ' bad' : (left <= 7 ? ' warn' : '')));

      var notStarted = !on && !st.expiresAt && !!st.plan;   // 구매했지만 앱에서 아직 활성화 안 함
      var chip = on
        ? el('span', { cls: 'chip ' + (left <= 7 ? 'warn' : 'ok'), text: (left <= 7 ? '만료 임박 · ' : '사용 중 · ') + 'D-' + left })
        : (notStarted ? el('span', { cls: 'chip info', text: '활성화 대기' })
                      : el('span', { cls: 'chip', text: st.expiresAt ? '만료됨' : '미구매' }));

      var bar = el('div', {
        cls: barCls, role: 'progressbar', 'aria-label': f.name + ' 남은 기간',
        'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(pct)
      }, [el('i')]);

      var row = el('div', { cls: 'feat-row' }, [
        el('div', { cls: 'r1' }, [
          el('span', { 'aria-hidden': 'true', text: f.icon }),
          el('h3', { text: featName(f.id) }),
          chip
        ]),
        bar,
        el('div', { cls: 'meta' }, [
          el('span', { text: st.plan ? planName(st.plan) + ' 플랜' : (on ? '' : '미활성') }),
          el('span', { cls: 'left', text: st.expiresAt ? '만료 ' + dateKr(st.expiresAt, true)
                                                       : (notStarted ? '앱에 키 입력 시 기간 개시' : '') })
        ]),
        el('div', { cls: 'btn-row' }, [
          el('a', { cls: 'btn sm' + (on || notStarted ? '' : ' primary'), href: buyUrl([f.id], 'month', key) },
             (on || notStarted) ? '연장' : '구매')
        ])
      ]);
      list.appendChild(row);
      /* 진행바는 그린 다음에 채워서 전환이 보이게 (reduced-motion 이면 CSS가 껀다) */
      setTimeout(function () { $('i', bar).style.width = pct + '%'; }, 30);
    });

    out.appendChild(list);

    out.appendChild(el('p', { cls: 'tiny dim center', style: 'margin:14px 0 0',
      text: '보안상 기기 ID 등 민감 정보는 표시되지 않습니다.' }));
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
      plan: str(pick(o, ['plan', 'plan_id'])),
      planLabel: str(pick(o, ['plan_label', 'planLabel'])),
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
      target: str(pick(o, ['target_key', 'targetKey'])),
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

      if (live && !timedOut) {
        if (!polling) { polling = true; }
      } else {
        stopPoll();
      }

      out.appendChild(el('div', { cls: 'card' }, [
        el('div', { style: 'display:flex;align-items:center;gap:9px;flex-wrap:wrap' }, [
          el('span', { cls: 'chip ' + st.cls, text: autoCanceled ? '자동 취소됨 · 미입금' : st.kr }),
          o.created ? el('span', { cls: 'tiny dim', text: dateKr(o.created, true) + ' 접수' }) : null
        ]),

        /* 발급된 키 — 가장 먼저, 크게, 모노스페이스 + 복사 */
        o.issued ? el('div', { cls: 'big keybox', style: 'margin-top:13px' }, [
          el('div', { cls: 'k', text: '발급된 라이선스 키' }),
          el('div', { cls: 'v key', text: o.issued }),
          el('div', { cls: 'btn-row' }, [
            copyBtn(function () { return o.issued; }, '키'),
            el('a', { cls: 'btn sm', href: '/my?key=' + encodeURIComponent(o.issued) }, '내 키 보기')
          ]),
          el('div', { cls: 'tiny warnline', text: '앱에서 이 키를 입력하십시오. 입력한 기기 1대에 고정됩니다.' })
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
          el('div', { cls: 'r' }, [el('dt', { text: '기능' }),
            el('dd', { text: o.features.length ? o.features.map(featName).join(' · ') : '-' })]),
          el('div', { cls: 'r' }, [el('dt', { text: '기간' }),
            el('dd', { text: o.plan ? (o.planLabel || planName(o.plan)) + ' (' + planDays(o.plan) + '일)' : '-' })]),
          !pending ? el('div', { cls: 'r' }, [el('dt', { text: '금액' }), el('dd', { cls: 'mono', text: won(o.amount) })]) : null,
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
        tip = '발급된 키를 앱에 입력하면 즉시 사용 가능합니다. 키 1개는 기기 1대에만 등록됩니다.';
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

      /* 발급 완료 — 앱 받는 법까지 이어서 안내한다 */
      if (done && o.issued) {
        out.appendChild(el('div', { cls: 'card', style: 'margin-top:12px' }, [
          el('p', { cls: 'eyebrow', style: 'margin-bottom:6px', text: '다음 할 일' }),
          el('ol', { cls: 'steps' }, [
            el('li', null, ['앱을 설치하십시오. APK 링크는 관리자가 안내합니다. ',
                            el('a', { href: '/#install' }, '설치 순서 보기')]),
            el('li', null, ['앱을 실행하여 위 키를 입력하십시오 (', el('b', { text: '안드로이드 전용' }), ').']),
            el('li', { text: '알림 접근 권한을 허용하면 발송이 시작됩니다. 이미지 발송에는 접근성 권한이 추가로 필요합니다.' })
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
