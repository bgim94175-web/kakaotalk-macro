/* ───────────────────────────────────────────────────────────────
   카톡 매크로 / 봇 — 구매 웹 공통 스크립트
   페이지 구분: <body data-page="home|buy|my|order">
   쓰는 서버 API (SPEC 5장):
     GET  /api/price        가격표 (서버가 단일 소스 — 여기서 하드코딩 안 함)
     POST /api/order        주문 접수  → {ok, id, amount, account}
     GET  /api/order/:id    주문 상태
     POST /api/lookup       키 조회 (기능/만료일/기기등록여부만)
   외부 라이브러리 안 씀. 이 파일 하나에 공통 로직 다 들어있다.
   ─────────────────────────────────────────────────────────────── */
(function () {
  'use strict';

  /* ══════════════════ 0. 카탈로그 (SPEC 1장) ══════════════════
     가격은 절대 여기 안 적는다. 이름/설명/불릿만. 가격은 /api/price. */

  var FEATURES = [
    {
      id: 'macro', name: '자동발송 매크로', icon: '⚡', color: 'var(--accent)', tag: '추천',
      desc: '방마다 주기 자동발송 + 이미지 첨부 + 메시지추적 + 오픈프로필 자동응답',
      bullets: [
        '방별로 주기(분 단위)와 메시지를 따로 지정',
        '이미지 최대 5장 첨부 발송',
        '메시지 추적 — 정해둔 문구가 올라오면 즉시 응답',
        '오픈프로필 개인톡 자동응답 (문구 직접 작성)',
        '{이름} {방} {시간} 치환 토큰 지원'
      ]
    },
    {
      id: 'roombot', name: '방 관리봇', icon: '🛡', color: 'var(--accent2)', tag: '',
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
        '방별 점수 랭킹 (!랭킹)',
        '명령 접두사 변경 · 쿨다운 / 일일 한도'
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

  var MSG_PRICE_FAIL = '가격 정보를 불러올 수 없어';

  var STATUS = {
    pending:  { kr: '입금 대기 중',            cls: 'warn' },
    paid:     { kr: '입금 확인됨 · 발급 준비',  cls: 'info' },
    done:     { kr: '발급 완료',               cls: 'ok'   },
    canceled: { kr: '취소됨',                  cls: 'bad'  },
    cancelled:{ kr: '취소됨',                  cls: 'bad'  }
  };

  /* 서버 reason 코드 → 한국어 (SPEC 3.1 표 + 웹 전용 몇 개) */
  var REASON_KR = {
    bad_request:   '요청이 잘못됐어',
    invalid_key:   '없는 키야',
    not_found:     '찾을 수 없어',
    revoked:       '사용 중지된 키야',
    blocked:       '차단된 키야 (관리자에게 문의해줘)',
    expired:       '기간이 끝났어',
    no_entitlement:'구매한 기능이 없어',
    device_mismatch:'다른 기기에 등록된 키야 (키 1개당 기기 1대)',
    server_error:  '서버에서 문제가 났어. 잠시 뒤 다시 해줘',
    rate_limited:  '요청이 너무 잦아. 조금 뒤에 다시 해줘',
    unauthorized:  '권한이 없어'
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
    var done = function () { toast(okMsg || '복사했어', 'ok'); };
    var fallback = function () {
      try {
        var ta = el('textarea', { value: s, 'aria-hidden': 'true' });
        ta.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0';
        document.body.appendChild(ta);
        ta.select(); ta.setSelectionRange(0, s.length);
        var ok = document.execCommand('copy');
        document.body.removeChild(ta);
        if (ok) done(); else toast('복사가 안 돼. 길게 눌러서 직접 복사해줘', 'bad');
      } catch (e) {
        toast('복사가 안 돼. 길게 눌러서 직접 복사해줘', 'bad');
      }
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(s).then(done, fallback);
    } else fallback();
  }

  function copyBtn(getText, label) {
    return el('button', {
      type: 'button', cls: 'btn sm', onclick: function () { copy(getText(), (label || '') + ' 복사했어'); }
    }, '복사');
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
      var e = new Error('서버에 연결 못 했어. 인터넷 확인하고 다시 해줘.');
      e.net = true;
      throw e;
    }).then(function (res) {
      return res.text().catch(function () { return ''; }).then(function (txt) {
        var data = null;
        try { data = txt ? JSON.parse(txt) : null; } catch (e) { data = null; }
        if (!res.ok || !data || data.ok === false) {
          var msg = (data && str(data.message)) ||
                    (data && errKr(pick(data, ['reason', 'error', 'code']))) ||
                    (res.status === 404 ? '찾을 수 없어' : '') ||
                    ('요청이 실패했어 (HTTP ' + res.status + ')');
          var e2 = new Error(msg);
          e2.status = res.status;
          e2.code = data ? str(pick(data, ['reason', 'error', 'code'])) : '';
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
    ['pricing', 'price', 'prices', 'data', 'result'].forEach(function (k) {
      if (root === raw && raw[k] && typeof raw[k] === 'object' && !Array.isArray(raw[k])) {
        // features 같은 알맹이가 안에 들어있으면 그걸 root 로 본다
        if (pick(raw[k], ['features', 'items', 'products', 'macro', 'catalog'])) root = raw[k];
      }
    });

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

    var found = 0;
    FEATURES.forEach(function (f) {
      var entry = readEntry(fsrc, f.id);
      if (entry === null && fsrc !== root) entry = readEntry(root, f.id);
      var prices = entryPrices(entry, f.id, root);
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
      cta: opts.cta || { text: '구매 신청하기', kind: 'link' },
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
      if (!self.ids.length) { toast('기능을 하나 이상 골라줘', 'bad'); return; }
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
          el('span', { text: '고른 기능 없음' }),
          el('span', { cls: 'v dim', text: '0원' })
        ]));
      } else if (!c.ok) {
        self.sumLines.appendChild(el('div', { cls: 'ln' }, [
          el('span', { cls: 'v', style: 'margin:0;color:var(--red)', text: MSG_PRICE_FAIL })
        ]));
      } else {
        self.sumLines.appendChild(el('div', { cls: 'ln' }, [
          el('span', { text: self.ids.map(featName).join(' · ') + ' · ' + planName(self.plan) }),
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
        self.sumSaved.textContent = '✓ ' + FEATURES.length + '종 묶음 ' + Math.round(c.rate * 100) + '% 할인 적용됨 — ' + won(c.discount) + ' 아꼈어';
        self.sumNudge.hidden = true;
      } else {
        self.sumSaved.hidden = true;
        if (self.ids.length > 0 && need > 0 && need <= FEATURES.length) {
          self.sumNudge.hidden = false;
          self.sumNudge.textContent = need + '개만 더 고르면 ' + FEATURES.length + '종 묶음 ' +
            Math.round(c.rate * 100) + '% 할인이 붙어';
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

  function pageHome() {
    var mount = $('#prods'), planMount = $('#planSeg'), sumMount = $('#sum');
    var state = el('div', { cls: 'state' }, [el('div', { cls: 'spin' }), '가격 불러오는 중…']);
    mount.appendChild(state);

    var q = qs();
    loadPrice().then(function () {
      clear(mount);
      var pk = Picker({
        ids: qFeatures(q), plan: qPlan(q) || 'month',
        variant: 'cards', mount: mount, planMount: planMount, sumMount: sumMount,
        cta: { text: '고른 기능으로 구매 신청', kind: 'link' }
      });
      pk.build();
      var bank = $('#bankLine');
      if (bank && PRICE.bank) bank.textContent = '입금 계좌 · ' + PRICE.bank;
    }).catch(function (e) {
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

    /* 앱에서 넘어온 딥링크 값 채우기 */
    var preKey = normKey(q.get('key') || '');
    if (preKey) keyIn.value = preKey;      // 앱 [구매하기] 딥링크로 들어온 키

    keyIn.addEventListener('input', function () {
      var atEnd = keyIn.selectionStart === keyIn.value.length;
      var v = normKey(keyIn.value);
      if (v !== keyIn.value && atEnd) { keyIn.value = v; }
    });
    keyIn.addEventListener('blur', function () { keyIn.value = normKey(keyIn.value); });

    var state = el('div', { cls: 'state' }, [el('div', { cls: 'spin' }), '가격 불러오는 중…']);
    mount.appendChild(state);

    var pk = null;

    loadPrice().then(function () {
      clear(mount);
      pk = Picker({
        ids: qFeatures(q), plan: qPlan(q) || 'month',
        variant: 'rows', mount: mount, planMount: planMount, sumMount: sumMount,
        cta: { text: '주문 접수하기', kind: 'submit' }
      });
      pk.build();
      var bank = $('#bankHint');
      if (bank) {
        bank.textContent = PRICE.bank
          ? '입금 계좌 · ' + PRICE.bank + ' — 주문 접수하면 다시 보여줄게'
          : '입금 계좌는 주문 접수 뒤에 안내할게';
      }
    }).catch(function (e) {
      clear(mount);
      mount.appendChild(el('p', { cls: 'err', text: e.message || MSG_PRICE_FAIL }));
      mount.appendChild(el('button', { type: 'button', cls: 'btn sm', onclick: function () { location.reload(); } }, '다시 시도'));
      if (sumMount) sumMount.hidden = true;
    });

    function setErr(fldId, msg) {
      var fld = $('#fld-' + fldId);
      var box = $('#err-' + fldId);
      if (fld) fld.classList.toggle('bad', !!msg);
      if (box) { box.textContent = msg || ''; box.hidden = !msg; }
    }

    form.addEventListener('submit', function (ev) {
      ev.preventDefault();
      if (!pk) { toast(MSG_PRICE_FAIL, 'bad'); return; }

      ['feature', 'depositor', 'contact', 'key'].forEach(function (k) { setErr(k, ''); });

      var ids = pk.ids.slice();
      var plan = pk.plan;
      var dep = str(depIn.value), con = str(conIn.value), memo = str(memoIn.value);
      var key = normKey(keyIn.value);
      var bad = null;

      if (!ids.length)  { setErr('feature', '기능을 하나 이상 골라줘'); bad = bad || mount; }
      if (!dep)         { setErr('depositor', '입금자명을 적어줘'); bad = bad || depIn; }
      if (!con)         { setErr('contact', '연락처(카톡ID 또는 전화번호)를 적어줘'); bad = bad || conIn; }
      if (key && !KEY_RE.test(key)) { setErr('key', '키 형식이 KAKA-XXXX-XXXX-XXXX 가 아니야'); bad = bad || keyIn; }

      var c = calc(ids, plan);
      if (ids.length && !c.ok) { setErr('feature', MSG_PRICE_FAIL); bad = bad || mount; }

      if (bad) {
        toast('빠진 칸이 있어', 'bad');
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
          target_key: key || null
        }
      }).then(function (res) {
        showResult(res, ids, plan, key, c);
      }).catch(function (e) {
        btn.disabled = false;
        btn.textContent = '주문 접수하기';
        toast(e.message || '주문 접수가 안 됐어', 'bad');
        var box = $('#submitErr');
        if (box) { box.textContent = e.message || '주문 접수가 안 됐어'; box.hidden = false; }
      });
    });

    function showResult(res, ids, plan, key, c) {
      var id = str(pick(res, ['id', 'order_id', 'orderId']));
      var amt = amount(pick(res, ['amount', 'total']));
      if (amt === null) amt = c.total;
      var acct = str(pick(res, ['account', 'bank', 'bank_info', 'bankInfo'])) || (PRICE && PRICE.bank) || '';

      var wrapEl = $('#formWrap');
      var out = $('#result');
      if (wrapEl) wrapEl.hidden = true;
      clear(out);
      out.hidden = false;

      out.appendChild(el('div', { cls: 'card' }, [
        el('div', { cls: 'chip ok', text: '주문 접수됨' }),
        el('h2', { style: 'margin:12px 0 6px', text: '입금하면 관리자가 키를 발급해줄게' }),
        el('p', { cls: 'sub small', style: 'margin-bottom:16px',
                  text: '아래 계좌로 금액을 그대로 입금하고, 입금자명은 반드시 아래 이름으로 해줘.' }),

        el('div', { cls: 'big' }, [
          el('div', { cls: 'k', text: '주문번호' }),
          el('div', { cls: 'v accent mono', text: id || '(응답에 주문번호가 없어)' }),
          el('div', { cls: 'btn-row' }, [
            id ? copyBtn(function () { return id; }, '주문번호') : null,
            id ? el('a', { cls: 'btn sm', href: '/order/' + encodeURIComponent(id) }, '주문 상태 보기') : null
          ])
        ]),
        el('div', { style: 'height:10px' }),
        el('div', { cls: 'big' }, [
          el('div', { cls: 'k', text: '입금 금액' }),
          el('div', { cls: 'v mono', text: won(amt) })
        ]),
        el('div', { style: 'height:10px' }),
        el('div', { cls: 'big' }, [
          el('div', { cls: 'k', text: '입금 계좌' }),
          el('div', { cls: 'v sm', text: acct || '관리자에게 문의' }),
          acct ? el('div', { cls: 'btn-row' }, [copyBtn(function () { return acct; }, '계좌')]) : null
        ]),

        el('div', { style: 'height:16px' }),
        el('dl', { cls: 'kv' }, [
          el('div', { cls: 'r' }, [el('dt', { text: '기능' }), el('dd', { text: ids.map(featName).join(' · ') })]),
          el('div', { cls: 'r' }, [el('dt', { text: '기간' }), el('dd', { text: planName(plan) + ' (' + planDays(plan) + '일)' })]),
          key ? el('div', { cls: 'r' }, [el('dt', { text: '연장할 키' }), el('dd', { cls: 'mono', text: key })]) : null
        ]),

        el('div', { style: 'height:16px' }),
        el('div', { cls: 'note warn' }, [
          el('span', { cls: 'ic', 'aria-hidden': 'true', text: '!' }),
          el('span', null, [
            el('b', { text: '주문번호는 꼭 남겨둬. ' }),
            '이 번호로 /order 페이지에서 진행 상태를 볼 수 있어. 입금 확인은 수동이라 조금 걸릴 수 있어.'
          ])
        ])
      ]));

      window.scrollTo(0, 0);
      toast('주문 접수됐어', 'ok');
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

    /* 관리자 연락처를 서버가 주면 안내 카드에 채운다 (없으면 기본 문구 그대로) */
    loadPrice().then(function () {
      var c = $('#adminContact');
      if (c && PRICE.contact) {
        clear(c);
        c.appendChild(el('b', { text: '관리자 연락처 · ' }));
        c.appendChild(document.createTextNode(PRICE.contact));
      }
    }).catch(function () {});

    form.addEventListener('submit', function (ev) {
      ev.preventDefault();
      var key = normKey(keyIn.value);
      keyIn.value = key;
      var errBox = $('#err-key');
      errBox.hidden = true;

      if (!key) { errBox.textContent = '키를 입력해줘'; errBox.hidden = false; keyIn.focus(); return; }
      if (!KEY_RE.test(key)) { errBox.textContent = '키 형식이 KAKA-XXXX-XXXX-XXXX 가 아니야'; errBox.hidden = false; keyIn.focus(); return; }

      var btn = $('#lookupBtn');
      btn.disabled = true; btn.textContent = '조회 중…';
      clear(out); out.hidden = false;
      out.appendChild(el('div', { cls: 'card' }, [el('div', { cls: 'state' }, [el('div', { cls: 'spin' }), '조회 중…'])]));

      api('/api/lookup', { method: 'POST', body: { key: key } })
        .then(function (res) { renderLookup(out, key, res); })
        .catch(function (e) {
          clear(out);
          out.appendChild(el('div', { cls: 'card' }, [
            el('div', { cls: 'state bad', text: e.message || '조회가 안 됐어' }),
            el('p', { cls: 'center tiny dim', style: 'margin:0',
                      text: '키를 다시 확인해줘. 그래도 안 되면 관리자에게 문의해줘.' })
          ]));
          toast(e.message || '조회가 안 됐어', 'bad');
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
    var src = pick(res, ['features', 'feature', 'entitlements', 'ents']);
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
          plan: str(pick(e, ['plan', 'plan_id']))
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
    var blocked = str(pick(res, ['blocked_reason', 'blockedReason', 'blocked']));
    var resets  = num(pick(res, ['reset_count', 'resetCount']));

    clear(out);

    var head = el('div', { cls: 'card' }, [
      el('div', { style: 'display:flex;align-items:center;gap:9px;flex-wrap:wrap' }, [
        el('span', { cls: 'chip info', text: '라이선스 키' }),
        devOn ? el('span', { cls: 'chip ok', text: '기기 등록됨' }) : el('span', { cls: 'chip', text: '기기 미등록' }),
        revoked ? el('span', { cls: 'chip bad', text: '사용 중지' }) : null,
        blocked ? el('span', { cls: 'chip bad', text: '차단됨' }) : null
      ]),
      el('div', { cls: 'v mono', style: 'font-size:clamp(17px,5vw,22px);font-weight:800;margin:11px 0 4px;word-break:break-all', text: key }),
      el('div', { cls: 'btn-row' }, [copyBtn(function () { return key; }, '키')]),
      devName ? el('p', { cls: 'tiny dim', style: 'margin:12px 0 0', text: '등록 기기 · ' + devName }) : null,
      (resets !== null && resets > 0) ? el('p', { cls: 'tiny dim', style: 'margin:4px 0 0', text: '기기 초기화 이력 ' + resets + '회' }) : null,
      blocked ? el('p', { cls: 'err', style: 'margin:10px 0 0', text: '차단 사유 · ' + blocked }) : null
    ]);
    out.appendChild(head);

    /* 기능별 남은 기간 */
    var list = el('div', { cls: 'card' }, [
      el('p', { cls: 'eyebrow', style: 'margin-bottom:2px', text: '기능별 남은 기간' })
    ]);

    FEATURES.forEach(function (f) {
      var st = feats[f.id];
      var left = daysLeft(st.expiresAt, now);
      var on = st.on && left > 0;
      var denom = planDays(st.plan) || Math.max(30, left);
      var pct = on ? clamp(Math.round(left / denom * 100), 3, 100) : 0;
      var barCls = 'bar' + (!on ? ' off' : (left <= 3 ? ' bad' : (left <= 7 ? ' warn' : '')));

      var chip = on
        ? el('span', { cls: 'chip ' + (left <= 7 ? 'warn' : 'ok'), text: (left <= 7 ? '만료 임박 · ' : '사용중 · ') + 'D-' + left })
        : el('span', { cls: 'chip', text: st.expiresAt ? '만료됨' : '미구매' });

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
          el('span', { text: st.plan ? planName(st.plan) + ' 플랜' : (on ? '' : '아직 안 켜져 있어') }),
          el('span', { cls: 'left', text: st.expiresAt ? '만료 ' + dateKr(st.expiresAt, true) : '' })
        ]),
        el('div', { cls: 'btn-row' }, [
          el('a', { cls: 'btn sm' + (on ? '' : ' primary'), href: buyUrl([f.id], 'month', key) },
             on ? '연장하기' : '구매하기')
        ])
      ]);
      list.appendChild(row);
      /* 진행바는 그린 다음에 채워서 전환이 보이게 (reduced-motion 이면 CSS가 껀다) */
      setTimeout(function () { $('i', bar).style.width = pct + '%'; }, 30);
    });

    out.appendChild(list);

    out.appendChild(el('p', { cls: 'tiny dim center', style: 'margin:14px 0 0',
      text: '보안 때문에 기기 ID·세션 같은 민감한 값은 여기 안 보여줘.' }));
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
      amount: amount(pick(o, ['amount', 'total', 'price'])),
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

    form.addEventListener('submit', function (ev) {
      ev.preventDefault();
      var v = str(idIn.value);
      if (!v) { toast('주문번호를 적어줘', 'bad'); idIn.focus(); return; }
      location.href = '/order/' + encodeURIComponent(v);
    });

    if (!id) {
      $('#findWrap').hidden = false;
      out.hidden = true;
      return;
    }
    idIn.value = id;
    load(id);

    function load(oid) {
      out.hidden = false;
      clear(out);
      out.appendChild(el('div', { cls: 'card' }, [el('div', { cls: 'state' }, [el('div', { cls: 'spin' }), '주문 불러오는 중…'])]));

      /* 계좌/이름표를 같이 쓰려고 가격표도 같이 받아둔다 (실패해도 진행) */
      var pricing = loadPrice().catch(function () { return null; });

      api('/api/order/' + encodeURIComponent(oid)).then(function (res) {
        return pricing.then(function () { render(normOrder(res), oid); });
      }).catch(function (e) {
        clear(out);
        out.appendChild(el('div', { cls: 'card' }, [
          el('div', { cls: 'state bad', text: e.status === 404 ? '그 주문번호를 못 찾았어' : (e.message || '주문을 불러올 수 없어') }),
          el('div', { cls: 'center' }, [
            el('button', { type: 'button', cls: 'btn sm', onclick: function () { load(oid); } }, '다시 시도')
          ])
        ]));
        $('#findWrap').hidden = false;
      });
    }

    function render(o, oid) {
      var st = STATUS[o.status] || { kr: o.status || '알 수 없음', cls: '' };
      clear(out);

      var showId = o.id || oid;
      var acct = o.account || (PRICE && PRICE.bank) || '';
      var pending = o.status === 'pending';

      out.appendChild(el('div', { cls: 'card' }, [
        el('div', { style: 'display:flex;align-items:center;gap:9px;flex-wrap:wrap' }, [
          el('span', { cls: 'chip ' + st.cls, text: st.kr }),
          o.created ? el('span', { cls: 'tiny dim', text: dateKr(o.created, true) + ' 접수' }) : null
        ]),
        el('div', { cls: 'big', style: 'margin-top:13px' }, [
          el('div', { cls: 'k', text: '주문번호' }),
          el('div', { cls: 'v accent mono', text: showId }),
          el('div', { cls: 'btn-row' }, [copyBtn(function () { return showId; }, '주문번호')])
        ]),

        pending ? el('div', { style: 'height:10px' }) : null,
        pending ? el('div', { cls: 'big' }, [
          el('div', { cls: 'k', text: '입금 금액' }),
          el('div', { cls: 'v mono', text: won(o.amount) })
        ]) : null,
        pending ? el('div', { style: 'height:10px' }) : null,
        pending ? el('div', { cls: 'big' }, [
          el('div', { cls: 'k', text: '입금 계좌' }),
          el('div', { cls: 'v sm', text: acct || '관리자에게 문의' }),
          acct ? el('div', { cls: 'btn-row' }, [copyBtn(function () { return acct; }, '계좌')]) : null
        ]) : null,

        o.issued ? el('div', { style: 'height:10px' }) : null,
        o.issued ? el('div', { cls: 'big' }, [
          el('div', { cls: 'k', text: '발급된 라이선스 키' }),
          el('div', { cls: 'v accent mono', text: o.issued }),
          el('div', { cls: 'btn-row' }, [
            copyBtn(function () { return o.issued; }, '키'),
            el('a', { cls: 'btn sm', href: '/my?key=' + encodeURIComponent(o.issued) }, '내 키 보기')
          ])
        ]) : null,

        el('div', { style: 'height:16px' }),
        el('dl', { cls: 'kv' }, [
          el('div', { cls: 'r' }, [el('dt', { text: '기능' }),
            el('dd', { text: o.features.length ? o.features.map(featName).join(' · ') : '-' })]),
          el('div', { cls: 'r' }, [el('dt', { text: '기간' }),
            el('dd', { text: o.plan ? planName(o.plan) + ' (' + planDays(o.plan) + '일)' : '-' })]),
          !pending ? el('div', { cls: 'r' }, [el('dt', { text: '금액' }), el('dd', { cls: 'mono', text: won(o.amount) })]) : null,
          o.depositor ? el('div', { cls: 'r' }, [el('dt', { text: '입금자명' }), el('dd', { text: o.depositor })]) : null,
          o.target ? el('div', { cls: 'r' }, [el('dt', { text: '연장할 키' }), el('dd', { cls: 'mono', text: o.target })]) : null,
          o.memo ? el('div', { cls: 'r' }, [el('dt', { text: '메모' }), el('dd', { text: o.memo })]) : null,
          o.handled ? el('div', { cls: 'r' }, [el('dt', { text: '처리 시각' }), el('dd', { text: dateKr(o.handled, true) })]) : null
        ]),

        el('div', { style: 'height:16px' }),
        el('div', { cls: 'btn-row' }, [
          el('button', { type: 'button', cls: 'btn', onclick: function () { load(oid); } }, '상태 새로고침'),
          el('a', { cls: 'btn ghost', href: '/' }, '처음으로')
        ])
      ]));

      var tip = pending
        ? '입금이 확인되면 관리자가 키를 발급해. 확인은 수동이라 조금 걸릴 수 있어. 이 페이지를 새로고침해서 확인해줘.'
        : (o.status === 'done'
            ? '발급된 키를 앱에 입력하면 바로 쓸 수 있어. 키 1개는 기기 1대에만 등록돼.'
            : (o.status === 'paid' ? '입금 확인됐어. 키 발급만 기다리면 돼.' : '취소된 주문이야. 다시 신청하려면 구매 페이지로 가줘.'));
      out.appendChild(el('div', { cls: 'note' + (pending ? ' warn' : '') }, [
        el('span', { cls: 'ic', 'aria-hidden': 'true', text: 'i' }),
        el('span', { text: tip })
      ]));
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
      toast('화면을 그리다 문제가 났어: ' + (e && e.message ? e.message : e), 'bad');
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
    toast('오류: ' + ((r && r.message) || r || '알 수 없음'), 'bad');
  });
})();
