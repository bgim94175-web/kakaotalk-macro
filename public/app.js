/* ───────────────────────────────────────────────────────────────
   K bot — 구매 웹 공통 스크립트 (docs/ACCOUNTS_V1.md 6장 · 부록 A, docs/UI_V5.md 3장)
   페이지 구분: <body data-page="home|buy|order|login|signup|account|support">
   support.js(?v=1) 가 먼저 실려 window.kbSite(/api/site 프라미스)와 window.kbSupport 를 만든다. 여기서 재사용한다.

   쓰는 서버 API (docs/ACCOUNTS_V1.md 3장):
     GET  /api/site                사이트 상태(로그인 회원·Google·상담) — support.js 가 1회 부른다
     GET  /api/price               가격표 (서버가 단일 소스 — 여기서 금액을 하드코딩하지 않는다)
     POST /api/auth/signup|login|logout|logout-all|password|claim|sessions/revoke|google/unlink
     GET  /api/me · /api/auth/sessions · /api/my/orders
     POST /api/my/orders/cancel
     POST /api/room-preview        방 링크 확인(회원)
     POST /api/order               주문 접수(회원) → {ok, id, token, url, amount, items, ...}
     GET  /api/order/:id           주문 상태(토큰 ?t= 또는 주문 주인 회원)
   상품 3종: 카카오톡 매크로(1개월 단위) · 방 관리봇 · 미니게임봇(방 1개 단위, 기간 없음).
   쓰기 요청은 언제나 JSON 본문을 보낸다(서버 sameOriginWrites 가 JSON 이 아니면 415).
   서버 문자열은 textContent 로만 넣는다(8.13). innerHTML 은 이 파일에 적힌 정적 문자열에만.
   외부 라이브러리 안 씀.

   주문 상태 페이지는 무인 자동 적용 때문에 스스로 폴링한다 — 8장 pageOrder 참고.
   5초 간격 · 탭 숨으면 정지 · 다시 보이면 즉시 1회 · 최대 30분 · done/canceled 면 정지.
   회원 주문은 적용 뒤에도 방이 모두 '사용 중' 이 될 때까지 10초 간격으로 최대 10분 더 본다(6.7).
   ─────────────────────────────────────────────────────────────── */
(function () {
  'use strict';

  /* ══════════════════ 0. 이름표 · 문구 ══════════════════
     가격 · 기간 · 상품 설명은 여기 안 적는다. 전부 /api/price.
     아래 이름표는 응답을 받기 전이나 못 받았을 때 화면이 비지 않게 하는 용도뿐이다. */

  var FEATURES = [
    { id: 'macro',    name: '카카오톡 매크로' },
    { id: 'roombot',  name: '방 관리봇' },
    { id: 'minigame', name: '미니게임봇' }
  ];
  var ROOM_PRODUCTS = ['roombot', 'minigame'];

  /* 남은 기간 막대의 분모 — 매크로는 30일 단위다(서버가 days 를 주면 그 값) */
  var DAYS_FALLBACK = 30;

  var MSG_PRICE_FAIL = '가격 정보를 불러올 수 없습니다';
  var MSG_BROKEN = '화면을 표시하지 못했습니다. 새로고침 후에도 같으면 문의해 주세요.';
  var MSG_LOGIN = '로그인이 필요합니다.';
  var MSG_BAD_LINK = '오픈채팅방 링크를 찾지 못했습니다. 카카오톡에서 방 링크(https://open.kakao.com/o/…)를 복사해 붙여 넣어 주세요.';
  var MSG_UNVERIFIED = '방을 지금 확인하지 못했습니다. 결제 후 K bot이 들어갈 때 다시 확인하며, 들어가지 못하면 그 이유를 패널에 표시합니다.';
  var MSG_PROFILE_ONLY = 'K bot은 방의 프로필 설정과 관계없이 오픈프로필로 들어갑니다.';   // 미리 보기는 profile_only 를 늘 false 로 준다(D12). 호환용으로만 남긴다.

  /* ── 자동 입금확인이 꺼져 있으면(DEPOSIT_AUTO_APPROVE=0 또는 DEPOSIT_TOKEN 미설정)
        "자동으로 적용" 을 약속한 문구를 전부 "관리자 확인 후 적용" 으로 바꾼다([data-manual]).
        서버는 /api/price · /api/order · /api/order/:id 응답에 auto_approve 를 실어준다. */
  var AUTO_APPROVE = true;

  function applyAutoCopy(on) {
    if (on === undefined || on === null) return;   // 정보가 없으면 건드리지 않는다
    AUTO_APPROVE = on !== false;
    if (AUTO_APPROVE) return;
    var els = document.querySelectorAll('[data-manual]');
    for (var i = 0; i < els.length; i++) {
      if (els[i].getAttribute('data-manual-applied')) continue;
      els[i].innerHTML = els[i].getAttribute('data-manual');   // HTML 에 적힌 정적 문구
      els[i].setAttribute('data-manual-applied', '1');
    }
  }

  /** 입금 후 안내 한 줄 — 자동/수동, 회원 주문/예전 키 주문에 따라 갈린다 (6.7) */
  function issueMsg(review, member) {
    if (review) return '입금하면 관리자가 직접 확인합니다';
    if (member === false) {   // 예전 키 주문
      return AUTO_APPROVE ? '입금하면 1~2분 안에 키가 자동으로 발급됩니다' : '입금하면 관리자가 확인한 뒤 키를 발급합니다';
    }
    return AUTO_APPROVE ? '입금하면 1~2분 안에 자동으로 확인됩니다' : '입금하면 관리자가 확인한 뒤 처리합니다';
  }

  /* 서버가 48시간 방치된 pending 주문을 자동 취소한다 (ORDER_PENDING_TTL_MS).
     접수 결과 화면과 주문 상태 페이지에서 같은 문구를 쓴다. */
  var TTL_MSG = '48시간 안에 입금하지 않으면 주문이 자동으로 취소됩니다. 입금 전에는 내 계정의 구매 내역에서 직접 취소할 수 있습니다.';
  var TTL_MSG_HERE = '48시간 안에 입금하지 않으면 주문이 자동으로 취소됩니다. 입금 전에는 위 [주문 취소]로 취소할 수 있습니다.';
  var TTL_CANCELED_MSG = '48시간 안에 입금되지 않아 자동으로 취소되었습니다. 이미 입금했다면 주문번호를 적어 문의해 주세요.';
  var CANCEL_WARN = '주문을 취소합니다. 이미 입금했다면 취소하지 말고 문의해 주세요.';

  /* 예전 키 주문(kind 없음)의 상태 칩 */
  var STATUS = {
    pending:  { kr: '입금 대기 중',            cls: 'warn' },
    paid:     { kr: '입금 확인됨 · 발급 준비',  cls: 'info' },
    done:     { kr: '발급 완료',               cls: 'ok'   },
    canceled: { kr: '취소됨',                  cls: 'bad'  },
    cancelled:{ kr: '취소됨',                  cls: 'bad'  }
  };
  /* 회원 주문(kind='member')의 상태 칩 (6.7) */
  var STATUS_MEMBER = {
    pending:  { kr: '입금 대기',               cls: 'warn' },
    paid:     { kr: '입금 확인 · 처리 중',     cls: 'info' },
    done:     { kr: '처리 완료',               cls: 'ok'   },
    canceled: { kr: '취소됨',                  cls: 'bad'  },
    cancelled:{ kr: '취소됨',                  cls: 'bad'  }
  };

  /* 서버 reason 코드 → 한국어 (서버가 error 문구를 주지 않은 경우의 대체) */
  var REASON_KR = {
    bad_request:   '요청을 처리하지 못했습니다. 페이지를 새로고침한 뒤 다시 시도해 주세요',
    no_depositor:  '입금자명을 입력해 주세요',
    not_found:     '조회 결과가 없습니다',
    login_required:'로그인이 필요합니다.',
    server_error:  '서버 오류가 발생했습니다. 잠시 뒤 다시 시도해 주세요',
    rate_limited:  '요청이 너무 잦습니다. 잠시 뒤 다시 시도해 주세요',
    busy:          '요청이 많아 처리하지 못했습니다. 잠시 뒤 다시 시도해 주세요.',
    unauthorized:  '권한이 없습니다'
  };

  /* 결과 코드 ?g= (3.2.2). at: 그 문구를 보이는 화면 */
  var G_NOTES = {
    linked:       { at: 'account', t: 'Google 계정을 연결했습니다.' },
    off:          { at: 'login',   t: 'Google 로그인을 지금 사용할 수 없습니다. 아이디로 로그인해 주세요.', warn: true },
    webview:      { at: 'both',    t: '카카오톡 안 브라우저에서는 Google 로그인이 제한됩니다. 외부 브라우저에서 열어 주세요.', warn: true, external: true },
    login_needed: { at: 'login',   t: 'Google 계정을 연결하려면 먼저 아이디로 로그인해 주세요.' },
    relogin:      { at: 'login',   t: 'Google 계정을 연결하기 전에 본인 확인이 필요합니다. 아이디와 비밀번호로 다시 로그인해 주세요.' },
    expired:      { at: 'both',    t: '확인 시간이 지났습니다. 다시 시도해 주세요.', warn: true },
    denied:       { at: 'both',    t: 'Google 계정 확인을 취소했습니다.', warn: true },
    error:        { at: 'both',    t: 'Google 계정을 확인하지 못했습니다. 잠시 뒤 다시 시도해 주세요.', warn: true },
    taken:        { at: 'account', t: '이 Google 계정은 다른 아이디에 연결되어 있습니다.', warn: true },
    already:      { at: 'account', t: '이미 다른 Google 계정이 연결되어 있습니다. 연결을 해제한 뒤 다시 시도해 주세요.', warn: true },
    not_linked:   { at: 'login',   t: '이 Google 계정과 연결된 아이디가 없습니다. 아이디로 로그인한 뒤 내 계정에서 Google 계정을 연결해 주세요.', warn: true },
    blocked:      { at: 'login',   t: '이용이 정지된 계정입니다. 문의해 주세요.', warn: true, support: true }
  };
  var G_RECOVER_NONE = '이 Google 계정과 연결된 아이디가 없습니다. Google 계정을 연결하지 않았다면 아이디를 적어 문의해 주세요. 확인 후 임시 비밀번호를 안내합니다.';
  var G_RECOVER = 'Google 계정으로 확인되었습니다. 15분 안에 새 비밀번호를 정해 주세요.';

  function featName(id) {
    if (PRICE && PRICE.products[id] && PRICE.products[id].label) return PRICE.products[id].label;
    for (var i = 0; i < FEATURES.length; i++) if (FEATURES[i].id === id) return FEATURES[i].name;
    return String(id || '');
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
    append(n, kids);
    return n;
  }
  function append(n, kids) {
    if (kids === null || kids === undefined) return n;
    (Array.isArray(kids) ? kids : [kids]).forEach(function (c) {
      if (c === null || c === undefined || c === false) return;
      if (Array.isArray(c)) { append(n, c); return; }
      n.appendChild(typeof c === 'string' || typeof c === 'number' ? document.createTextNode(String(c)) : c);
    });
    return n;
  }

  /* 스프라이트 아이콘 <svg class="ic"><use href="#i-…"></svg> */
  function icon(name, size) {
    var NS = 'http://www.w3.org/2000/svg';
    var s = document.createElementNS(NS, 'svg');
    s.setAttribute('class', 'ic');
    s.setAttribute('width', String(size || 16));
    s.setAttribute('height', String(size || 16));
    s.setAttribute('aria-hidden', 'true');
    var u = document.createElementNS(NS, 'use');
    u.setAttribute('href', '#' + name);
    s.appendChild(u);
    return s;
  }

  /* 문의 버튼. 보이기는 <html data-support> 가 정한다(6.10) — hidden 을 쓰지 않는다 */
  function supportBtn(label, ctx, cls) {
    return el('button', { type: 'button', cls: cls || 'btn sm', 'data-support': true, 'data-support-ctx': ctx || null },
      [icon('i-help', 14), label || '문의하기']);
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

  /* 금액 추출 — 숫자 / "20,000원" / {amount:20000} 다 받는다 */
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

  function comma(n) { return Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ','); }
  function won(n) {
    var v = num(n);
    if (v === null) return '-';
    return comma(v) + '원';
  }
  /* 모노 글꼴 칸에 넣는 금액: 숫자는 모노, '원'은 산세리프 span (docs/UI_V5.md 2.1·7 — 모노에 한글 금지). 글자는 won() 과 같다. */
  function wonKids(n, pre) {
    var t = won(n);
    if (t.slice(-1) !== '원') return [(pre || '') + t];
    return [(pre || '') + t.slice(0, -1), el('span', { cls: 'sans', text: '원' })];
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


  /* 붙여넣은 글에서 오픈채팅 링크를 뽑아 https://open.kakao.com/o/<code> 로 맞춘다. 없으면 ''.
     lib/openchat.js 와 같은 식이다(lib/purchase-check.js 가 두 쪽 결과를 맞춰 본다).
     서버(lib/openchat.normLink)가 최종 판정한다 — 이건 화면 안내용 */
  var LINK_RE = /(?:(?:^|[^\/])https?:\/\/|(?:^|[^A-Za-z0-9.\-_@\/]))open\.kakao\.com\/o\/([A-Za-z0-9]{1,40})(?![A-Za-z0-9_\-])/i;
  var ZW_RE = /[\u00AD\u180E\u200B-\u200F\u202A-\u202E\u2060-\u2064\uFEFF]/g;
  function normLink(text) {
    var m = LINK_RE.exec(String(text || '').slice(0, 2000).replace(ZW_RE, ''));
    return m ? 'https://open.kakao.com/o/' + m[1] : '';
  }
  /* 미리 보기에 보낼 값: 방 링크, 아니면 open.kakao.com 이 든 글 그대로
     (오픈프로필·게시물 링크는 서버가 무엇이 틀렸는지 알려 준다) */
  function linkKey(text) {
    return normLink(text) || (/open\.kakao\.com\//i.test(String(text || '')) ? str(text) : '');
  }
  function shortLink(u) { return String(u || '').replace(/^https?:\/\//i, ''); }

  function qs() { return new URLSearchParams(location.search); }

  /* 이동할 주소(?next=)는 같은 사이트 경로만 받는다: ^/(?!/) — '#' 포함 가능 (6.3) */
  function safeNext(raw, dflt) {
    var v = str(raw);
    if (!v || v.length > 300 || !/^\/(?![\/\\])/.test(v) || /[\u0000-\u001F\u007F]/.test(v)) return dflt;
    return v;
  }
  function hereUrl() { return location.pathname + location.search + location.hash; }
  function loginUrl(next) { return '/login?next=' + encodeURIComponent(next || hereUrl()); }

  /* 주문 상태 링크. 토큰이 있으면 로그인하지 않은 브라우저에서도 볼 수 있다 (서버가 ?t= 로 확인) */
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
    var done = function () { toast(okMsg || '복사했습니다', 'ok'); };
    var fallback = function () {
      try {
        var ta = el('textarea', { 'aria-hidden': 'true' });
        ta.value = s;
        ta.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0';
        document.body.appendChild(ta);
        ta.select(); ta.setSelectionRange(0, s.length);
        var ok = document.execCommand('copy');
        document.body.removeChild(ta);
        if (ok) done(); else toast('복사하지 못했습니다. 길게 눌러 직접 복사해 주세요', 'bad');
      } catch (e) {
        toast('복사하지 못했습니다. 길게 눌러 직접 복사해 주세요', 'bad');
      }
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(s).then(done, fallback);
    } else fallback();
  }

  /* 받침에 맞는 목적격 조사 (계좌번호를 · 주문번호를 · 키를) */
  function objJosa(w) {
    var c = String(w || '').charCodeAt(String(w || '').length - 1);
    return (c >= 0xAC00 && c <= 0xD7A3 && (c - 0xAC00) % 28 === 0) ? '를' : '을';
  }

  function copyBtn(getText, label) {
    return el('button', {
      type: 'button', cls: 'btn sm', onclick: function () { copy(getText(), label ? label + objJosa(label) + ' 복사했습니다' : '복사했습니다'); }
    }, [icon('i-copy', 14), '복사']);
  }

  /* 숫자만 남긴다 — 입금 금액은 뱅킹 앱에 붙여넣으니까 쉼표·'원' 이 섞이면 안 된다 */
  function digits(v) { return String(v === null || v === undefined ? '' : v).replace(/[^0-9]/g, ''); }

  /* 버튼 진행 표시(.busy + .spin/.lbl-idle). 누르지 못하게 aria-disabled 만 건다 */
  function setBusy(btn, on) {
    if (!btn) return;
    btn.classList.toggle('busy', !!on);
    if (on) btn.setAttribute('aria-busy', 'true'); else btn.removeAttribute('aria-busy');
  }

  /* 칸 오류: #fld-<id> 에 .bad, #err-<id> 에 문구(+ 뒤에 붙일 노드) */
  function fieldErr(id, msg, extra) {
    var fld = document.getElementById('fld-' + id);
    var box = document.getElementById(id === 'submit' ? 'submitErr' : 'err-' + id);   // 폼 전체 오류는 #submitErr
    if (fld) fld.classList.toggle('bad', !!msg);
    if (box) {
      clear(box);
      if (msg) {
        box.appendChild(document.createTextNode(msg));
        if (extra) { box.appendChild(document.createTextNode(' ')); box.appendChild(extra); }
      }
      box.hidden = !msg;
    }
  }

  /* 첫 오류 칸으로 포커스 + 스크롤 */
  function focusField(node) {
    if (!node) return;
    try { node.focus({ preventScroll: true }); } catch (e) { try { node.focus(); } catch (e2) { /* 무시 */ } }
    var target = node.closest ? (node.closest('.fld') || node) : node;
    try { target.scrollIntoView({ block: 'center', behavior: reducedMotion() ? 'auto' : 'smooth' }); }
    catch (e) { target.scrollIntoView(); }
  }

  /* 인라인 2단계 확인 줄 (브라우저 확인 대화상자 금지 — UI_V5 1.3).
     host 아래에 [문구 + 실행 버튼 + 닫기] 줄을 펼친다. 실행하면 onAct() 의 프라미스가 끝날 때까지 진행 표시 */
  function inlineConfirm(host, text, actLabel, onAct) {
    var old = host.querySelector(':scope > .confirm');
    if (old) { old.parentNode.removeChild(old); return; }
    var act = el('button', { type: 'button', cls: 'btn sm danger solid' }, [el('span', { cls: 'spin' }), el('span', { cls: 'lbl-idle', text: actLabel })]);
    var close = el('button', { type: 'button', cls: 'btn sm ghost' }, '닫기');
    var errP = el('p', { cls: 'err', role: 'alert', hidden: true });
    var box = el('div', { cls: 'confirm', role: 'group' }, [
      el('p', { cls: 'confirm-t', text: text }),
      el('div', { cls: 'confirm-a' }, [act, close]),
      errP
    ]);
    var running = false;
    close.addEventListener('click', function () { if (box.parentNode) box.parentNode.removeChild(box); });
    act.addEventListener('click', function () {
      if (running) return;
      running = true;
      setBusy(act, true);
      errP.hidden = true;
      Promise.resolve().then(onAct).then(function () {
        if (box.parentNode) box.parentNode.removeChild(box);
      }, function (e) {
        running = false;
        setBusy(act, false);
        clear(errP);
        errP.appendChild(document.createTextNode((e && e.message) || '처리하지 못했습니다. 잠시 뒤 다시 시도해 주세요.'));
        errP.hidden = false;
      });
    });
    host.appendChild(box);
    try { act.focus({ preventScroll: true }); } catch (e) { act.focus(); }
    return box;
  }

  /* ── 입금 금액 블록 (SPEC 12.1)
     금액 뒷자리가 곧 주문번호 역할이라, 화면에서 가장 크게 띄우고 뒷자리 설명을 꼭 붙인다.
     구매 결과 화면(/buy)과 주문 상태 페이지(/order/:id)가 같이 쓴다. */
  function amountBlock(amt, base, review) {
    var v = num(amt);
    var b = num(base);
    var suffix = (b !== null && v !== null && v > b) ? (v - b) : null;
    var msg = review
      ? '같은 금액의 주문이 겹쳐 자동 확인이 어렵습니다. 관리자가 직접 확인하므로 몇 시간이 걸릴 수 있습니다.'
      : won(v) + '을 1원 단위까지 정확히 입금해 주세요.' +
        (suffix !== null ? ' 끝자리 ' + suffix + '원은 주문을 구분하는 금액입니다.' : '') +
        (AUTO_APPROVE ? ' 금액이 다르면 자동으로 확인되지 않습니다.' : ' 금액이 다르면 확인이 늦어질 수 있습니다.');
    return el('div', { cls: 'big hi' }, [
      el('div', { cls: 'k', text: '입금 금액' }),
      el('div', { cls: 'v xl mono' }, wonKids(v)),
      el('div', { cls: 'tiny warnline', text: msg }),
      suffix !== null
        ? el('div', { cls: 'tiny dim', text: '상품 금액 ' + won(v - suffix) + ' + 주문 구분용 ' + suffix + '원' })
        : null,
      v === null ? null : el('div', { cls: 'btn-row' }, [
        el('button', {
          type: 'button', cls: 'btn sm',
          onclick: function () { copy(digits(Math.round(v)), '금액을 숫자만 복사했습니다'); }
        }, [icon('i-copy', 14), '금액 복사'])
      ])
    ]);
  }

  function noteEl(kind, kids) {
    return el('div', { cls: 'note' + (kind ? ' ' + kind : '') }, [
      el('span', { cls: 'ic', 'aria-hidden': 'true', text: kind === 'warn' ? '!' : 'i' }),
      el('span', null, kids)
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
    if (o.method !== 'GET' && (opts.body === undefined || opts.body === null)) opts.body = {};   // 쓰기는 언제나 JSON
    if (opts.body !== undefined && opts.body !== null) {
      o.body = typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body);
      o.headers['Content-Type'] = 'application/json';
    }
    o.cache = 'no-store';
    o.credentials = 'same-origin';
    return fetch(path, o).catch(function () {
      var e = new Error('서버에 연결할 수 없습니다. 인터넷 연결을 확인한 뒤 다시 시도해 주세요.');
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
                    (res.status === 401 ? MSG_LOGIN : '') ||
                    (res.status === 404 ? '조회 결과가 없습니다' : '') ||
                    ('요청을 처리하지 못했습니다(오류 ' + res.status + '). 페이지를 새로고침한 뒤 다시 시도해 주세요.');
          var e2 = new Error(msg);
          e2.status = res.status;
          e2.code = code;
          e2.data = data || {};
          throw e2;
        }
        return data;
      });
    });
  }

  /* /api/site — support.js 가 만든 프라미스를 재사용한다(페이지당 1회). support.js 가 없으면 직접 부른다.
     실패해도 {ok:false} 로 풀린다(거부하지 않음). */
  function siteInfo() {
    if (!window.kbSite) {
      window.kbSite = fetch('/api/site', { credentials: 'same-origin', cache: 'no-store', headers: { 'Accept': 'application/json' } })
        .then(function (r) { return r.json(); })
        .catch(function () { return { ok: false }; });
    }
    return Promise.resolve(window.kbSite).then(function (s) {
      return s && typeof s === 'object' ? s : { ok: false };
    }, function () { return { ok: false }; });
  }

  /* 상단 바 data-auth 전환 (6.2): HTML 기본은 로그아웃 상태 */
  function applyAuth(s) {
    var inn = !!(s && s.member);
    $$('[data-auth]').forEach(function (n) {
      n.hidden = (n.getAttribute('data-auth') === 'in') !== inn;
    });
  }

  /* 로그인·로그아웃 직후 상담 위젯을 다시 부팅한다(6.10 5) */
  function supportReboot() {
    try { if (window.kbSupport && window.kbSupport.reboot) window.kbSupport.reboot(); } catch (e) { /* 무시 */ }
  }

  /* ══════════════════ 3. 가격표 ══════════════════
     GET /api/price → { ok, currency, products:[{id,label,unit,price,days?,min?,max?,desc}], max_rooms,
                        bank, contact, purchase_base, auto_approve }
     정규화 결과: { products:{id:{...}}, order:[id...], maxRooms, bank, contact } */

  var PRICE = null;
  var pricePromise = null;

  /* 서버는 계좌(BANK_INFO)가 없으면 '관리자에게 문의' 를 준다 — 그건 계좌 안내로 쓰지 않는다 */
  function realBank(v) {
    var b = str(v);
    return b === '관리자에게 문의' ? '' : b;
  }

  function normalizePrice(raw) {
    if (!raw || typeof raw !== 'object' || !Array.isArray(raw.products)) throw new Error(MSG_PRICE_FAIL);
    var P = {
      products: {}, order: [],
      maxRooms: num(raw.max_rooms) || 10,
      bank: realBank(pick(raw, ['bank', 'account', 'bank_info'])),
      contact: str(pick(raw, ['contact', 'admin_contact']))
    };
    raw.products.forEach(function (p) {
      if (!p || typeof p !== 'object') return;
      var id = str(p.id);
      var price = amount(p.price);
      if (!id || price === null || P.products[id]) return;
      P.order.push(id);
      P.products[id] = {
        id: id,
        label: str(p.label) || featName(id),
        unit: str(p.unit) || (id === 'macro' ? 'month' : 'room'),
        price: price,
        days: num(p.days) || 0,
        min: num(p.min) || 1,
        max: num(p.max) || 12,
        desc: str(p.desc)
      };
    });
    if (!P.order.length) throw new Error(MSG_PRICE_FAIL);
    return P;
  }

  /* 갠톡은 페이지마다 처음 한 번 '갠톡(1:1 대화)'로 쓴다(docs/TONE.md). 상품 설명이 그 페이지의 첫 언급인 곳
     (구매 화면)에만 [data-gloss] 를 붙인다. 홈은 머리글에서 이미 풀어 썼다. */
  function glossDm(t) { return String(t || '').replace(/갠톡(?!\()/, '갠톡(1:1 대화)'); }

  /* 정적 문구 안의 [data-bind] 자리에 서버 값을 채운다 (HTML 에 적힌 값은 스크립트가 꺼졌을 때의 대체 문구).
     price-<상품> 은 숫자만(쉼표 포함) — '원' 은 HTML 에 있다 */
  function bindPrice() {
    if (!PRICE) return;
    $$('[data-bind]').forEach(function (n) {
      var key = n.getAttribute('data-bind') || '';
      var m = key.match(/^(price|desc|label|days)-(\w+)$/);
      if (!m) return;
      var p = PRICE.products[m[2]];
      if (!p) return;
      var v = m[1] === 'price' ? comma(p.price) : (m[1] === 'desc' ? p.desc : (m[1] === 'label' ? p.label : (p.days ? String(p.days) : '')));
      if (v && m[1] === 'desc' && n.hasAttribute('data-gloss')) v = glossDm(v);
      if (v) n.textContent = v;
    });
  }

  function loadPrice() {
    if (pricePromise) return pricePromise;
    pricePromise = api('/api/price').then(function (raw) {
      PRICE = normalizePrice(raw);
      applyAutoCopy(raw && raw.auto_approve);    // 자동 적용이 꺼져 있으면 문구를 바꾼다
      bindPrice();
      return PRICE;
    }).catch(function (e) {
      pricePromise = null;                       // 다시 시도할 수 있게 캐시 비움
      throw new Error(e && e.net ? MSG_PRICE_FAIL + ' (서버 연결 실패)' : MSG_PRICE_FAIL);
    });
    return pricePromise;
  }

  /* ══════════════════ 4. 상품 줄 (홈 가격 · 구매 화면 로그아웃 상태) ══════════════════
     카드 3개를 가로로 늘어놓지 않는다 — .prods 안의 행 3개(6.8). */

  var PROD_BULLETS = {
    macro:    [['카카오 계정 최대 ', { limit: 'kakao_accounts', text: '3' }, '개'], '다시 구매하면 현재 만료일에 이어서 연장'],
    roombot:  ['방장이 K bot을 부방장으로 지정하면 동작'],
    minigame: ['K bot이 방에 들어가면 바로 동작']
  };

  /* 글 또는 [글, {limit, text}, 글] — limit 칸은 관리자가 바꾸는 한도 숫자(support.js fillLimits 가 채운다) */
  function bulletLi(t) {
    if (!Array.isArray(t)) return el('li', { text: t });
    var li = el('li', null, t.map(function (x) {
      return typeof x === 'string' ? x : el('span', { 'data-limit': x.limit, text: x.text });
    }));
    if (window.kbSupport && window.kbSupport.fillLimits) window.kbSupport.fillLimits(li);
    return li;
  }

  /* 모노 칸 안의 한글은 산세리프 span 으로 */
  function sans(t) { return el('span', { cls: 'sans', text: t }); }

  /* 매크로 `20,000원 / 1개월(30일)`, 방 상품 `15,000원 / 방 1개 · 기간 제한 없음` (부록 A.1) —
     가격 칸 두 줄로 나눠 보인다 */
  /* opt.pick: 누르면 고르는 행(체크 칸이 행 전체를 덮는다) · opt.buyHref: 로그아웃 화면의 [구매하기] */
  function prodRow(p, gloss, opt) {
    var o = opt || {};
    var room = p.unit === 'room';
    var days = p.days || DAYS_FALLBACK;
    var pickLab = null;
    if (o.pick) {
      pickLab = el('label', { cls: 'chk', for: 'pick-' + p.id }, [
        el('input', { type: 'checkbox', id: 'pick-' + p.id, 'data-p': p.id }),
        el('span', { cls: 'box', 'aria-hidden': 'true' }),
        el('span', { cls: 't', text: p.label + ' 고르기' })
      ]);
    }
    return el('article', { cls: 'card prod' + (o.pick ? '' : ' one'), 'data-prod': p.id }, [
      pickLab,
      el('div', { cls: 'head' }, [
        el('div', { cls: 't' }, [
          el('h3', { text: p.label }),
          p.desc ? el('p', { cls: 'desc', text: gloss ? glossDm(p.desc) : p.desc }) : null
        ])
      ]),
      el('ul', { cls: 'bul' }, (PROD_BULLETS[p.id] || []).map(bulletLi)),
      el('div', { cls: 'prices' }, [
        el('div', { cls: 'pr', 'data-on': '1' }, [
          el('span', { cls: 'pl', text: room ? '방 1개' : '1개월(' + days + '일)' }),
          el('span', { cls: 'pv' }, wonKids(p.price))
        ]),
        el('div', { cls: 'pr' }, room
          ? [el('span', { cls: 'pl', text: '기간' }), el('span', { cls: 'pv' }, [sans('제한 없음')])]
          : [el('span', { cls: 'pl', text: '한 번에' }), el('span', { cls: 'pv' }, [(p.min || 1) + '~' + (p.max || 12), sans('개월')])])
      ]),
      o.buyHref ? el('div', { cls: 'prod-act' }, [el('a', { cls: 'btn primary', href: o.buyHref(p.id) }, p.label + ' 구매하기')]) : null
    ]);
  }

  function renderProdRows(mount, opt) {
    if (!mount || !PRICE) return;
    mount.removeAttribute('aria-busy');
    clear(mount);
    var gloss = mount.hasAttribute('data-gloss');
    PRICE.order.forEach(function (id) { mount.appendChild(prodRow(PRICE.products[id], gloss, opt)); });
  }

  function prodRowsError(mount, msg) {
    if (!mount) return;
    mount.removeAttribute('aria-busy');
    clear(mount);
    mount.appendChild(el('div', { cls: 'card' }, [
      el('div', { cls: 'state bad', text: msg || MSG_PRICE_FAIL }),
      el('div', { cls: 'center' }, [
        el('button', { cls: 'btn', type: 'button', onclick: function () { location.reload(); } }, [icon('i-refresh', 14), '다시 시도'])
      ])
    ]));
  }


  /* ══════════════════ 5. 헤더 ══════════════════ */

  function reducedMotion() {
    return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  }


  /* 헤더: 스크롤하면 아래 선 */
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
  }


  /* ══════════════════ 6. 구매 신청 (/buy) — 6.6 ══════════════════
     로그아웃: 상품 소개(상품마다 [구매하기] → 로그인 뒤 그 상품을 고른 채로 돌아온다) + #loginGate.
     로그인: #buyForm — ① 상품 고르기 → 고른 상품에 필요한 칸만(매크로 기간 · 봇을 넣을 방) → 입금자 정보.
     방 관리봇·미니게임봇을 고르면 방 링크 칸이 바로 하나 열린다. 단계 번호는 보이는 칸 순서대로 다시 매긴다.
     미리 고르기: ?p=macro,roombot,minigame · ?macro=1 · #rooms(방 관리봇) · ?add=<install_id>(그 방에 없는 봇).
     금액은 서버가 정한다 (상품 금액 + 뒷자리 1~99원). 화면 합계는 /api/price 로 계산한 안내값이다. */

  var ROOM_HINT = {
    roombot:  '방장이 K bot을 부방장으로 지정해야 동작합니다',
    minigame: 'K bot이 방에 들어가면 바로 게임 명령어를 쓸 수 있습니다'
  };
  /* 미리 보기 오류 가운데 다시 확인해도 소용없는 것 — 주문을 막는다 */
  var PV_HARD = { bad_link: 1, profile_link: 1, post_link: 1, not_found: 1, not_group: 1, taken: 1, room_taken: 1, blocked_room: 1 };
  /* 문구 옆에 [문의하기] 를 붙이는 사유 (6.6) */
  var SUPPORT_REASONS = { room_taken: 1, taken: 1, pending_exists: 1, blocked_room: 1, too_many_pending: 1 };

  function pageBuy() {
    var q = qs();
    var bootBox = $('#buyBoot'), gate = $('#gateWrap'), form = $('#buyForm'), out = $('#result');
    var picksBox = $('#picks'), macroSec = $('#macroSec'), roomsSec = $('#rooms');
    var monthsRow = $('#macroMonthsRow'), monthsIn = $('#macroMonths'), macroNow = $('#macroNow');
    var roomsBox = $('#roomRows'), addBtn = $('#roomAdd'), termsIn = $('#terms');
    var depIn = $('#depositor'), conIn = $('#contact'), memoIn = $('#memo');
    var sumMount = $('#sum'), submitBtn = $('#submitBtn');
    var rows = [], seq = 0, sending = false, ME = null;
    var sumLines = null, sumNudge = null;
    var pk = {}, wanted = wantedFromUrl(), pendingAdd = 0;

    /* 주소로 미리 고를 상품 */
    function wantedFromUrl() {
      var w = {};
      str(q.get('p')).split(',').forEach(function (x) { x = str(x); if (x === 'macro' || ROOM_PRODUCTS.indexOf(x) >= 0) w[x] = 1; });
      if (q.get('macro') === '1') w.macro = 1;
      if (location.hash === '#rooms' && !w.roombot && !w.minigame) w.roombot = 1;
      return w;
    }
    function isPicked(k) { return !!(pk[k] && pk[k].inp.checked); }
    function roomPicks() { return ROOM_PRODUCTS.filter(isPicked); }

    /* 로그인·가입 링크는 지금 주소로 돌아오게 */
    $$('[data-next-base]').forEach(function (a) {
      a.setAttribute('href', a.getAttribute('data-next-base') + '?next=' + encodeURIComponent(hereUrl()));
    });

    Promise.all([siteInfo(), loadPrice().then(null, function (e) { return e instanceof Error ? e : new Error(MSG_PRICE_FAIL); })])
      .then(function (r) {
        var s = r[0], perr = r[1] instanceof Error ? r[1] : null;
        if (bootBox) bootBox.hidden = true;
        if (!s.member) { showGate(perr); return; }
        showForm(perr);
      });

    function showGate(perr) {
      gate.hidden = false;
      form.hidden = true;
      if (perr) prodRowsError($('#prods'), perr.message);
      else renderProdRows($('#prods'), { buyHref: function (id) { return loginUrl('/buy?p=' + id); } });
    }

    /* ── 폼 ─────────────────────────────────────────────── */
    function showForm(perr) {
      gate.hidden = true;
      form.hidden = false;
      initSum();
      if (perr) { priceFail(perr); prodRowsError(picksBox, perr.message); }
      else renderPicks();
      api('/api/me').then(function (me) {
        ME = me;
        var m = me.macro || {};
        if (macroNow && m.active && ts(m.until)) {
          macroNow.textContent = '지금 만료일 ' + dateKr(m.until) + ' · 여기에 이어서 늘어납니다';
          macroNow.hidden = false;
        }
        var add = num(q.get('add'));
        if (add) { if (pk.roombot) prefillInstall(add); else pendingAdd = add; }
      }, function (e) {
        if (e.status === 401) { showGate(perr); return; }
      });
      syncSteps();
      updateSum();
    }

    /* ① 상품 고르기: 가격표로 행 3개를 그리고, 누르면 고른다 */
    function renderPicks() {
      if (!PRICE || pk.roombot || pk.macro) return;
      renderProdRows(picksBox, { pick: true });
      $$('input[data-p]', picksBox).forEach(function (inp) {
        var k = inp.getAttribute('data-p');
        pk[k] = { inp: inp, card: inp.closest('.prod') };
        inp.addEventListener('change', function () { onPick(k); });
      });
      Object.keys(wanted).forEach(function (k) { if (pk[k]) setPick(k, true); });
      wanted = {};
      if (location.hash === '#rooms' && roomsSec && !roomsSec.hidden) {
        try { roomsSec.scrollIntoView({ block: 'start' }); } catch (e) { /* 무시 */ }
      }
      if (pendingAdd) { var a = pendingAdd; pendingAdd = 0; prefillInstall(a); }
    }

    function setPick(k, on) {
      if (!pk[k] || pk[k].inp.checked === on) return;
      pk[k].inp.checked = on;
      onPick(k);
    }

    function onPick(k) {
      var on = isPicked(k);
      if (pk[k] && pk[k].card) pk[k].card.classList.toggle('sel', on);
      fieldErr('pick', '');
      if (k === 'macro') syncMacro();
      else {
        rows.forEach(function (r) {
          var x = r.prod[k];
          if (on) { if (!x.inp.disabled) x.inp.checked = true; } else x.inp.checked = false;
          setRowErr(r, 'prod', '');
        });
        syncRooms();
      }
      syncSteps();
      updateSum();
    }

    /* 고른 방 상품이 있으면 방 칸을 열고(행이 없으면 하나), 행마다 고른 봇만 보인다 */
    function syncRooms() {
      var any = roomPicks().length > 0;
      roomsSec.hidden = !any;
      if (any && !rows.length) addRow();
      rows.forEach(syncRowProds);
      if (!any) { fieldErr('rooms', ''); fieldErr('terms', ''); }
    }
    function syncRowProds(r) {
      var n = 0;
      ROOM_PRODUCTS.forEach(function (k) { var on = isPicked(k); r.prod[k].lab.hidden = !on; if (on) n++; });
      r.prodBox.classList.toggle('one', n < 2);
    }

    /* 단계 번호: 보이는 칸 순서대로 1, 2, 3… */
    function syncSteps() {
      var n = 0;
      $$('.fsec', form).forEach(function (sec) {
        if (sec.hidden) return;
        var sn = $('.sn', sec);
        if (sn) sn.textContent = String(++n);
      });
    }

    /* 가격표를 못 받으면 금액을 보여줄 수 없다 → 폼을 그대로 두고 [다시 시도] 만 내준다.
       페이지 새로고침은 적어 둔 입금자명·메모를 날리므로 쓰지 않는다. */
    function priceFail(e) {
      clear(sumLines);
      sumLines.appendChild(el('p', { cls: 'err', text: (e && e.message) || MSG_PRICE_FAIL }));
      sumLines.appendChild(el('p', { cls: 'hint', text: '입력한 내용은 그대로 남아 있습니다. [다시 시도]를 눌러 주세요.' }));
      sumLines.appendChild(el('div', null, [el('button', { type: 'button', cls: 'btn sm', onclick: function () {
        loadPrice().then(function () { bindPrice(); renderPicks(); refreshRowPrices(); syncSteps(); updateSum(); }, priceFail);
      } }, [icon('i-refresh', 14), '다시 시도'])]));
    }

    function initSum() {
      clear(sumMount);
      sumMount.className = 'sum';
      sumLines = el('div', { cls: 'lines', 'aria-live': 'polite' });
      sumNudge = el('div', { cls: 'nudge' });
      sumMount.appendChild(sumLines);
      sumMount.appendChild(sumNudge);
      sumMount.appendChild(submitBtn);
      var bank = $('#bankHint');
      loadPrice().then(function () {
        if (bank) {
          bank.textContent = PRICE.bank
            ? '입금 계좌 · ' + PRICE.bank + ' · 주문하면 다시 안내합니다'
            : '입금 계좌는 주문하면 안내합니다';
        }
      }, function () { /* priceFail 이 알린다 */ });
    }

    /* ── 매크로 ─────────────────────────────────────────── */
    function months() {
      var n = parseInt(digits(monthsIn.value), 10);
      return isFinite(n) ? n : 0;
    }
    function macroMax() { return (PRICE && PRICE.products.macro && PRICE.products.macro.max) || 12; }
    function syncMacro() {
      macroSec.hidden = !isPicked('macro');
      if (isPicked('macro') && !months()) monthsIn.value = '1';
      fieldErr('macro', '');
    }
    monthsIn.addEventListener('input', function () {
      var v = digits(monthsIn.value).slice(0, 2);
      if (v !== monthsIn.value) monthsIn.value = v;
      fieldErr('macro', '');
      updateSum();
    });
    monthsIn.addEventListener('blur', function () {
      if (!isPicked('macro')) return;
      monthsIn.value = String(clamp(months() || 1, 1, macroMax()));
      updateSum();
    });
    $$('button[data-step]', monthsRow).forEach(function (b) {
      b.addEventListener('click', function () {
        monthsIn.value = String(clamp((months() || 1) + Number(b.getAttribute('data-step')), 1, macroMax()));
        fieldErr('macro', '');
        updateSum();
      });
    });

    /* ── 방 행 ──────────────────────────────────────────── */
    function maxRooms() { return (PRICE && PRICE.maxRooms) || 10; }
    function price(id) { return PRICE && PRICE.products[id] ? PRICE.products[id].price : null; }

    function addRow() {
      if (rows.length >= maxRooms()) return null;
      var i = seq++;
      var linkId = 'room' + i + '-link', codeId = 'room' + i + '-code';
      var r = { i: i, installId: null, view: null, preview: null, pvFor: '', pvErr: null, req: 0, pvP: null, needsCode: false, unvIn: null, prod: {} };

      r.linkIn = el('input', { type: 'url', id: linkId, name: linkId, inputmode: 'url', placeholder: 'https://open.kakao.com/o/…',
        autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false', maxlength: '2000', 'aria-describedby': 'room' + i + '-pv err-' + linkId });
      r.checkBtn = el('button', { type: 'button', cls: 'btn' }, '확인');
      r.pv = el('div', { cls: 'rpv', id: 'room' + i + '-pv' });
      r.linkErr = el('p', { cls: 'err', id: 'err-' + linkId, role: 'alert', hidden: true });

      r.codeLblT = el('span', { text: '참여코드 (선택)' });
      r.codeReq = el('span', { cls: 'req', 'aria-hidden': 'true', text: '*', hidden: true });
      r.codeIn = el('input', { type: 'text', id: codeId, name: codeId, maxlength: '20', autocomplete: 'off', autocapitalize: 'off',
        spellcheck: 'false', placeholder: '참여코드가 있는 방만 입력', 'aria-describedby': codeId + '-hint err-' + codeId });
      r.codeHint = el('p', { cls: 'hint', id: codeId + '-hint', text: '이 방은 참여코드가 필요합니다.', hidden: true });
      r.codeErr = el('p', { cls: 'err', id: 'err-' + codeId, role: 'alert', hidden: true });
      r.codeFld = el('div', { cls: 'fld', id: 'fld-' + codeId }, [
        el('label', { for: codeId, cls: 'lb-ic' }, [icon('i-lock', 14), r.codeLblT, r.codeReq]),
        r.codeIn, r.codeHint, r.codeErr
      ]);

      ROOM_PRODUCTS.forEach(function (k) {
        var id = 'room' + i + '-' + k;
        var inp = el('input', { type: 'checkbox', id: id, 'data-k': k });
        inp.checked = isPicked(k);
        var tag = el('span', { cls: 'tag', hidden: true });
        var amt = el('span', { cls: 'amt' }, price(k) !== null ? wonKids(price(k)) : null);
        var nmT = el('span', { text: featName(k) });
        var lab = el('label', { cls: 'chk', for: id }, [
          inp, el('span', { cls: 'box', 'aria-hidden': 'true' }),
          el('span', { cls: 't' }, [el('span', { cls: 'nm' }, [nmT, tag]), el('span', { cls: 'ds', text: ROOM_HINT[k] })]),
          amt
        ]);
        inp.addEventListener('change', function () { setRowErr(r, 'prod', ''); updateSum(); });
        r.prod[k] = { inp: inp, tag: tag, lab: lab, amt: amt, nmT: nmT };
      });
      r.prodErr = el('p', { cls: 'err', id: 'err-room' + i + '-prod', role: 'alert', hidden: true });
      r.prodBox = el('div', { cls: 'rprods' }, [r.prod.roombot.lab, r.prod.minigame.lab]);

      r.title = el('span', { text: '방' });
      r.delBtn = el('button', { type: 'button', cls: 'btn sm ghost' }, [icon('i-trash', 14), '빼기']);
      r.el = el('div', { cls: 'rrow' + (reducedMotion() ? '' : ' in'), 'data-i': String(i) }, [
        el('div', { cls: 'rrow-h' }, [el('span', { cls: 'rrow-t' }, [icon('i-link', 14), r.title]), r.delBtn]),
        el('div', { cls: 'fld', id: 'fld-' + linkId }, [
          el('label', { for: linkId, text: '오픈채팅방 링크' }),
          el('div', { cls: 'inrow' }, [r.linkIn, r.checkBtn]),
          r.pv, r.linkErr
        ]),
        r.codeFld,
        el('div', { cls: 'fld', id: 'fld-room' + i + '-prod', role: 'group', 'aria-label': '이 방에 넣을 봇' }, [
          r.prodBox,
          r.prodErr
        ])
      ]);

      r.linkIn.addEventListener('input', function () {
        setRowErr(r, 'link', '');
        if (linkKey(r.linkIn.value) !== r.pvFor) resetPreview(r);
        updateSum();
      });
      r.linkIn.addEventListener('paste', function () { setTimeout(function () { check(r, false); }, 0); });
      r.linkIn.addEventListener('blur', function () { if (str(r.linkIn.value)) check(r, false); });
      r.linkIn.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') { e.preventDefault(); check(r, true); }   // 폼 제출 대신 확인
      });
      r.checkBtn.addEventListener('click', function () { check(r, true); });
      r.codeIn.addEventListener('input', function () { setRowErr(r, 'code', ''); });
      r.delBtn.addEventListener('click', function () { removeRow(r); });

      rows.push(r);
      roomsBox.appendChild(r.el);
      syncRowProds(r);
      syncRows();
      return r;
    }

    function removeRow(r) {
      var k = rows.indexOf(r);
      if (k < 0) return;
      r.req++;   // 늦게 온 미리 보기 응답을 버린다
      rows.splice(k, 1);
      if (r.el.parentNode) r.el.parentNode.removeChild(r.el);
      syncRows();
      updateSum();
      try { addBtn.focus(); } catch (e) { /* 무시 */ }
    }

    function syncRows() {
      rows.forEach(function (r, k) {
        r.title.textContent = '방 ' + (k + 1);
        r.delBtn.hidden = rows.length < 2;          // 마지막 한 줄은 빼지 않는다(그만 사려면 위에서 상품을 끈다)
      });
      addBtn.disabled = rows.length >= maxRooms();
      var cap = $('#roomCap');
      if (cap) cap.textContent = rows.length >= maxRooms() ? '방은 한 번에 ' + maxRooms() + '개까지 주문할 수 있습니다' : '';
      fieldErr('rooms', '');
    }

    function refreshRowPrices() {
      rows.forEach(function (r) {
        ROOM_PRODUCTS.forEach(function (k) {
          var a = r.prod[k].amt;
          clear(a);
          if (price(k) !== null) append(a, wonKids(price(k)));
          r.prod[k].nmT.textContent = featName(k);
        });
      });
    }

    addBtn.addEventListener('click', function () {
      var r = addRow();
      if (r) { try { r.linkIn.focus(); } catch (e) { /* 무시 */ } }
      updateSum();
    });

    function setRowErr(r, slot, msg, extra) {
      var box = slot === 'code' ? r.codeErr : (slot === 'prod' ? r.prodErr : r.linkErr);
      var fld = box.parentNode;
      if (fld && fld.classList) fld.classList.toggle('bad', !!msg);
      clear(box);
      if (msg) {
        box.appendChild(document.createTextNode(msg));
        if (extra) { box.appendChild(document.createTextNode(' ')); box.appendChild(extra); }
      }
      box.hidden = !msg;
    }

    function resetPreview(r) {
      r.req++;
      r.preview = null; r.pvErr = null; r.pvFor = ''; r.pvP = null; r.unvIn = null;
      clear(r.pv);
      applyAvail(r, null);
    }

    /* POST /api/room-preview — 확인 버튼·붙여넣기·칸을 벗어날 때. 같은 링크는 다시 부르지 않는다(force 제외) */
    function check(r, force) {
      if (r.installId) return Promise.resolve();
      var raw = str(r.linkIn.value);
      var v = linkKey(raw);
      if (!raw) { resetPreview(r); setRowErr(r, 'link', ''); return Promise.resolve(); }
      if (!v) {
        resetPreview(r);
        r.pvErr = { reason: 'bad_link', msg: MSG_BAD_LINK };
        setRowErr(r, 'link', MSG_BAD_LINK);
        return Promise.resolve();
      }
      if (!force && v === r.pvFor && (r.preview || r.pvErr || r.pvP)) return r.pvP || Promise.resolve();
      var my = ++r.req;
      r.pvFor = v; r.preview = null; r.pvErr = null; r.unvIn = null;
      setRowErr(r, 'link', '');
      clear(r.pv);
      r.pv.appendChild(el('span', { cls: 'spin', 'aria-hidden': 'true' }));
      r.pv.appendChild(el('span', { text: '방을 확인하는 중…' }));
      setBusy(r.checkBtn, true);
      var p = api('/api/room-preview', { method: 'POST', body: { link: raw } }).then(function (res) {
        if (my !== r.req) return;
        r.preview = res;
        var u = res && res.room && res.room.link_url;
        if (u && normLink(u)) { r.linkIn.value = u; r.pvFor = normLink(u); }
        renderPreview(r);
      }, function (e) {
        if (my !== r.req) return;
        if (e.status === 401) { sessionLost(); return; }
        r.pvErr = { reason: e.code || '', msg: e.message };
        clear(r.pv);
        applyAvail(r, null);
        setRowErr(r, 'link', e.message, SUPPORT_REASONS[e.code] ? supportBtn('문의하기', '구매 · ' + shortLink(v) + ' · ' + e.message) : null);
      }).then(function () {
        if (my === r.req) { r.pvP = null; setBusy(r.checkBtn, false); }
        updateSum();
      });
      r.pvP = p;
      return p;
    }

    function renderPreview(r) {
      var p = r.preview || {};
      var room = p.room || {};
      clear(r.pv);
      r.unvIn = null;
      if (p.verified === false) {
        r.unvIn = el('input', { type: 'checkbox', id: 'room' + r.i + '-unv' });
        r.unvIn.addEventListener('change', function () { setRowErr(r, 'link', ''); });
        r.pv.appendChild(el('div', { cls: 'note warn' }, [
          el('span', { cls: 'ic', 'aria-hidden': 'true', text: '!' }),
          el('div', { cls: 'nt' }, [
            el('p', { text: MSG_UNVERIFIED }),
            el('label', { cls: 'chk', for: r.unvIn.id }, [r.unvIn, el('span', { cls: 'box', 'aria-hidden': 'true' }),
              el('span', { cls: 't' }, [el('span', { cls: 'nm', text: '확인되지 않은 방이지만 이대로 주문합니다' })])])
          ])
        ]));
      } else {
        if (p.mine) r.pv.appendChild(el('span', { cls: 'tag line', text: '내 방 · ' + (str(p.mine.label) || '설치됨') }));
        r.pv.appendChild(el('b', { text: str(room.name) || '이름 확인 전' }));
        r.pv.appendChild(el('span', { cls: 'mono', text: shortLink(room.link_url) }));
        if (room.profile_only) r.pv.appendChild(el('p', { cls: 'hint', text: MSG_PROFILE_ONLY }));
      }
      applyAvail(r, p);
    }

    /* 상품 칸 활성·비활성 + 참여코드 칸 (preview.available / mine / needs_passcode) */
    function applyAvail(r, p) {
      var mine = p && p.mine;
      var av = (p && p.available) || {};
      ROOM_PRODUCTS.forEach(function (k) {
        var x = r.prod[k];
        var ok = av[k] !== false;
        var installed = !!(mine && mine.products && mine.products[k]);
        var was = x.inp.disabled;
        x.inp.disabled = !ok;
        if (!ok) x.inp.checked = false;
        else if (was && isPicked(k)) x.inp.checked = true;
        x.tag.hidden = ok;
        x.tag.textContent = ok ? '' : (installed ? '설치됨' : '입금 대기');
        x.tag.className = 'tag ' + (installed ? 'line' : 'warn');
      });
      var needs = !!(p && p.room && p.room.needs_passcode) && !mine;
      r.needsCode = needs;
      r.codeFld.hidden = !!mine;
      r.codeLblT.textContent = needs ? '참여코드 ' : '참여코드 (선택)';
      r.codeReq.hidden = !needs;
      r.codeHint.hidden = !needs;
    }

    /* ?add=<install_id>: 내 설치를 행 1개로 미리 채운다(링크 읽기 전용, 이미 가진 상품 비활성) */
    function prefillInstall(id) {
      var list = (ME && Array.isArray(ME.rooms_list)) ? ME.rooms_list : [];
      var v = null;
      list.forEach(function (x) { if (x && Number(x.id) === id) v = x; });
      if (!v) { toast('방을 찾을 수 없습니다. 내 방 목록에서 다시 골라 주세요', 'bad'); return; }
      var missing = ROOM_PRODUCTS.filter(function (k) {
        return !(v.products && v.products[k]) && !(v.pending_products && v.pending_products[k]);
      });
      if (!missing.length) { toast('이 방에는 두 봇이 모두 있거나 입금 확인을 기다리고 있습니다', 'bad'); return; }
      var r = addRow();
      if (!r) return;
      r.installId = id;
      r.view = v;
      r.linkIn.value = v.link_url || '';
      r.linkIn.readOnly = true;
      r.checkBtn.hidden = true;
      r.codeFld.hidden = true;
      r.pv.appendChild(el('span', { cls: 'tag line', text: '내 방 · ' + (str(v.label) || '설치됨') }));
      r.pv.appendChild(el('b', { text: str(v.link_name) || '이름 확인 전' }));
      r.pv.appendChild(el('span', { cls: 'mono', text: shortLink(v.link_url) }));
      ROOM_PRODUCTS.forEach(function (k) {
        var x = r.prod[k];
        var have = !!(v.products && v.products[k]);
        var pend = !!(v.pending_products && v.pending_products[k]);
        x.inp.disabled = have || pend;
        x.tag.hidden = !(have || pend);
        x.tag.textContent = have ? '설치됨' : (pend ? '입금 대기' : '');
        x.tag.className = 'tag ' + (have ? 'line' : 'warn');
        if (!have && !pend) setPick(k, true);       // 이 방에 없는 봇을 위에서 고른다
      });
      syncRooms();
      syncSteps();
      updateSum();
      if (roomsSec) { try { roomsSec.scrollIntoView({ block: 'start' }); } catch (e) { /* 무시 */ } }
    }

    function rowProducts(r) {
      return ROOM_PRODUCTS.filter(function (k) { return isPicked(k) && r.prod[k].inp.checked && !r.prod[k].inp.disabled; });
    }
    function rowName(r, k) {
      if (r.view && r.view.link_name) return r.view.link_name;
      if (r.preview && r.preview.room && r.preview.room.name) return r.preview.room.name;
      return '방 ' + (k + 1);
    }
    /* 보낼 행: 방 상품을 고르지 않았으면 없음. 링크가 빈 행은 버린다(오류 아님 — 한 줄도 없으면 validate 가 알린다) */
    function sentRows() {
      if (!roomPicks().length) return [];
      return rows.filter(function (r) { return r.installId || str(r.linkIn.value); });
    }

    /* ── 합계 ───────────────────────────────────────────── */
    function updateSum() {
      if (!sumLines || !PRICE) return;
      clear(sumLines);
      var lines = [], total = 0;
      if (isPicked('macro') && PRICE.products.macro) {
        var m = clamp(months() || 1, 1, macroMax());
        lines.push({ t: PRICE.products.macro.label + ' ' + m + '개월', a: PRICE.products.macro.price * m });
      }
      rows.forEach(function (r, k) {
        rowProducts(r).forEach(function (p) {
          if (price(p) === null) return;
          lines.push({ t: featName(p) + ' · ' + rowName(r, k), a: price(p) });
        });
      });
      lines.forEach(function (l) {
        total += l.a;
        sumLines.appendChild(el('div', { cls: 'ln' }, [el('span', { text: l.t }), el('span', { cls: 'v mono' }, wonKids(l.a))]));
      });
      if (!lines.length) sumLines.appendChild(el('div', { cls: 'ln off' }, [el('span', { text: roomPicks().length ? '방 링크를 넣으면 금액이 나옵니다' : '고른 상품이 없습니다' }), el('span', { cls: 'v', text: '-' })]));
      sumLines.appendChild(el('div', { cls: 'ln total' }, [el('span', { text: '결제 금액' }), el('span', { cls: 'v mono' }, wonKids(total))]));
      sumNudge.textContent = '주문을 구분하려고 금액에 1~99원이 더해집니다' + (total ? ' (예: ' + won(total + 47) + ').' : '.');
    }

    /* ── 제출 ───────────────────────────────────────────── */
    function clearErrs() {
      ['pick', 'macro', 'rooms', 'terms', 'depositor', 'contact'].forEach(function (k) { fieldErr(k, ''); });
      rows.forEach(function (r) { setRowErr(r, 'link', ''); setRowErr(r, 'code', ''); setRowErr(r, 'prod', ''); });
      fieldErr('submit', '');
      var sb = $('#submitErr');
      if (sb) { clear(sb); sb.hidden = true; }
    }
    function submitErr(msg, extra) {
      var sb = $('#submitErr');
      if (!sb) { toast(msg, 'bad'); return; }
      clear(sb);
      sb.appendChild(document.createTextNode(msg));
      if (extra) { sb.appendChild(document.createTextNode(' ')); sb.appendChild(extra); }
      sb.hidden = false;
    }
    function firstEnabledProd(r) {
      var x = roomPicks().map(function (k) { return r.prod[k].inp; }).filter(function (i) { return !i.disabled; });
      return x[0] || r.linkIn;
    }
    function firstPick() { var k = PRICE ? PRICE.order[0] : 'macro'; return pk[k] ? pk[k].inp : picksBox; }
    /* 이 방에 넣을 봇이 없을 때: 고른 봇이 전부 이미 있거나 입금 대기면 그렇게 알린다 */
    function noProdMsg(r) {
      var ks = roomPicks();
      var blocked = ks.filter(function (k) { return r.prod[k].inp.disabled; }).length;
      return ks.length && blocked === ks.length
        ? '고른 봇이 이 방에 이미 있거나 입금 확인을 기다리고 있습니다. 다른 방 링크를 넣어 주세요'
        : '이 방에 넣을 봇을 1개 이상 골라 주세요';
    }

    /* 화면 위에서 아래 순서로 검사하고 첫 오류 칸을 돌려준다 */
    function validate() {
      var first = null;
      function mark(n) { if (!first) first = n; }
      var sent = sentRows();
      if (!isPicked('macro') && !roomPicks().length) { fieldErr('pick', '구매할 상품을 1개 이상 골라 주세요'); mark(firstPick()); }
      if (isPicked('macro')) {
        var m = months();
        if (!(m >= 1 && m <= macroMax())) { fieldErr('macro', '기간은 1~' + macroMax() + '개월로 입력해 주세요'); mark(monthsIn); }
      }
      if (roomPicks().length && !sent.length) {
        if (rows.length) { setRowErr(rows[0], 'link', '봇을 넣을 오픈채팅방 링크를 붙여 넣어 주세요'); mark(rows[0].linkIn); }
        else { fieldErr('rooms', '봇을 넣을 방을 추가해 주세요'); mark(addBtn); }
      }
      if (sent.length > maxRooms()) { fieldErr('rooms', '방은 한 번에 ' + maxRooms() + '개까지 주문할 수 있습니다'); mark(addBtn); }
      var seen = {};
      sent.forEach(function (r) {
        var prods = rowProducts(r);
        if (r.installId) {
          if (seen['i' + r.installId]) { setRowErr(r, 'link', '이미 추가한 방입니다'); mark(r.delBtn); return; }
          seen['i' + r.installId] = 1;
          if (r.view && r.view.link_url) seen['u' + normLink(r.view.link_url)] = 1;
          if (!prods.length) { setRowErr(r, 'prod', noProdMsg(r)); mark(firstEnabledProd(r)); }
          return;
        }
        var v = normLink(r.linkIn.value);
        /* 서버가 알려 준 이유(오픈프로필 링크 등)가 있으면 그 문구를 먼저 보인다 */
        if (r.pvErr && PV_HARD[r.pvErr.reason]) {
          setRowErr(r, 'link', r.pvErr.msg, SUPPORT_REASONS[r.pvErr.reason] ? supportBtn('문의하기', '구매 · ' + shortLink(v) + ' · ' + r.pvErr.msg) : null);
          mark(r.linkIn);
          return;
        }
        if (!v) { setRowErr(r, 'link', MSG_BAD_LINK); mark(r.linkIn); return; }
        var lid = r.preview && r.preview.room && r.preview.room.link_id;
        var mineId = r.preview && r.preview.mine && r.preview.mine.install_id;
        if (seen['u' + v] || (lid && seen['l' + lid]) || (mineId && seen['i' + mineId])) { setRowErr(r, 'link', '이미 추가한 방입니다'); mark(r.linkIn); return; }
        seen['u' + v] = 1; if (lid) seen['l' + lid] = 1; if (mineId) seen['i' + mineId] = 1;
        if (r.preview && r.preview.verified === false && !(r.unvIn && r.unvIn.checked)) {
          setRowErr(r, 'link', '방 정보를 불러오지 못했습니다. 이대로 주문하려면 위 확인란을 선택하고, 아니면 잠시 뒤 다시 확인해 주세요');
          mark(r.unvIn || r.linkIn);
        }
        if (r.needsCode && !str(r.codeIn.value)) { setRowErr(r, 'code', '참여코드를 입력해 주세요'); mark(r.codeIn); }
        if (!prods.length) { setRowErr(r, 'prod', noProdMsg(r)); mark(firstEnabledProd(r)); }
      });
      if (sent.length && !termsIn.checked) { fieldErr('terms', '이용 조건에 동의해 주세요'); mark(termsIn); }
      if (!str(depIn.value)) { fieldErr('depositor', '입금자명을 입력해 주세요'); mark(depIn); }
      return first;
    }

    termsIn.addEventListener('change', function () { fieldErr('terms', ''); });
    depIn.addEventListener('input', function () { fieldErr('depositor', ''); });
    var tt = $('#termsToggle'), tb = $('#termsBody');
    if (tt && tb) tt.addEventListener('click', function () {
      var open = tt.getAttribute('aria-expanded') !== 'true';
      tt.setAttribute('aria-expanded', open ? 'true' : 'false');
      tb.classList.toggle('open', open);
    });

    function lock(on) {
      sending = on;
      setBusy(submitBtn, on);
    }

    form.addEventListener('submit', function (ev) {
      ev.preventDefault();
      if (sending) return;
      if (!PRICE) { toast(MSG_PRICE_FAIL, 'bad'); return; }
      clearErrs();
      lock(true);
      /* 확인하지 않은 링크는 먼저 확인한다(서버도 다시 확인하지만, 미확인 동의란을 화면에 띄우려면 필요) */
      var pend = rows.filter(function (r) {
        return !r.installId && linkKey(r.linkIn.value) && (linkKey(r.linkIn.value) !== r.pvFor || r.pvP || (!r.preview && !r.pvErr));
      });
      Promise.all(pend.map(function (r) { return check(r, false); })).then(function () {
        var bad = validate();
        if (bad) {
          lock(false);
          toast('입력 내용을 확인해 주세요', 'bad');
          focusField(bad);
          return;
        }
        send();
      }, function () { lock(false); });
    });

    function send() {
      var sent = sentRows();
      var body = {
        macro_months: isPicked('macro') ? clamp(months(), 1, macroMax()) : 0,
        rooms: sent.map(function (r) {
          if (r.installId) return { install_id: r.installId, products: rowProducts(r) };
          return { link: str(r.linkIn.value), passcode: str(r.codeIn.value), products: rowProducts(r),
                   unverified_ok: !!(r.unvIn && r.unvIn.checked) };
        }),
        terms: sent.length ? !!termsIn.checked : false,
        depositor: str(depIn.value),
        contact: str(conIn.value),
        memo: str(memoIn.value)
      };
      api('/api/order', { method: 'POST', body: body }).then(function (res) {
        goLive(res, sent);
      }, function (e) {
        lock(false);
        orderFail(e, sent);
      });
    }

    function orderFail(e, sent) {
      var d = e.data || {};
      var reason = e.code || '';
      var msg = e.message || '주문하지 못했습니다';
      if (e.status === 401) {
        submitErr(MSG_LOGIN, el('a', { cls: 'btn sm', href: loginUrl('/buy') }, '로그인'));
        toast(msg, 'bad');
        return;
      }
      var r = (d.room !== undefined && d.room !== null && sent[Number(d.room)]) ? sent[Number(d.room)] : null;
      var sup = SUPPORT_REASONS[reason]
        ? supportBtn('문의하기', '구매 · ' + (r ? shortLink(r.linkIn.value) + ' · ' : '') + msg) : null;
      var focusEl = null;
      if (r) {
        var slot = reason === 'bad_passcode' ? 'code' : (reason === 'no_products' ? 'prod' : 'link');
        setRowErr(r, slot, msg, sup);
        focusEl = slot === 'code' ? r.codeIn : (slot === 'prod' ? firstEnabledProd(r) : r.linkIn);
        if (reason === 'unverified') check(r, true);
      } else if (reason === 'no_depositor') { fieldErr('depositor', msg); focusEl = depIn; }
      else if (reason === 'empty') { fieldErr('pick', msg); focusEl = firstPick(); }
      else if (reason === 'bad_months') { fieldErr('macro', msg); focusEl = monthsIn; }
      else if (reason === 'too_many_rooms') { fieldErr('rooms', msg); focusEl = addBtn; }
      else if (reason === 'no_terms') { fieldErr('terms', msg); focusEl = termsIn; }
      else {
        submitErr(msg, sup);
        focusEl = $('#submitErr');
      }
      toast('입력 내용을 확인해 주세요', 'bad');
      if (focusEl) focusField(focusEl);
    }

    function sessionLost() {
      submitErr(MSG_LOGIN, el('a', { cls: 'btn sm', href: loginUrl('/buy') }, '로그인'));
    }

    /* ── 접수 결과 ─────────────────────────────────────── */
    /* 주문이 접수되면 주문 화면(/order/:id)으로 바로 넘어간다 — 거기서 입금 확인·방 입장을 실시간으로 보여 준다.
       new=1 이면 그 화면 제목이 '주문 완료'가 된다. 주문번호를 못 받았으면(예외) 이 자리에 결과를 그린다. */
    function goLive(res, sent) {
      var id = str(pick(res, ['id', 'order_id']));
      var token = str(pick(res, ['token', 't']));
      if (!id) { showResult(res, sent); return; }
      if (token) saveToken(id, token);
      location.replace(orderUrl(id, token) + (token ? '&' : '?') + 'new=1');
    }

    function showResult(res) {
      applyAutoCopy(res && res.auto_approve);    // 접수 직후 안내 문구도 자동/수동을 맞춘다
      var id     = str(pick(res, ['id', 'order_id']));
      var token  = str(pick(res, ['token', 't']));
      var amt    = amount(pick(res, ['amount', 'total']));
      var base   = amount(pick(res, ['base_amount']));
      var suffix = num(pick(res, ['suffix']));
      var review = !!pick(res, ['needs_review']);
      var acct   = str(pick(res, ['account', 'bank'])) || (PRICE && PRICE.bank) || '';
      var link   = id ? orderUrl(id, token) : '';
      if (id && token) saveToken(id, token);
      if (base === null && amt !== null && suffix !== null && suffix > 0) base = amt - suffix;
      var g = groupItems(Array.isArray(res && res.items) ? res.items : []);

      form.hidden = true;
      clear(out);
      out.hidden = false;

      var prodLines = [];
      if (g.macro) prodLines.push(el('li', null, [featName('macro') + ' ' + g.macro.months + '개월 · ', el('span', { cls: 'mono' }, wonKids(g.macro.amount))]));
      g.rooms.forEach(function (rm) {
        rm.products.forEach(function (p) {
          prodLines.push(el('li', null, [featName(p) + ' · ' + (rm.link_name || shortLink(rm.link_url) || '방') + ' · ', el('span', { cls: 'mono' }, wonKids(rm.amounts[p]))]));
        });
      });

      out.appendChild(el('div', { cls: 'card stack' }, [
        el('div', { cls: 'chip-row' }, [el('span', { cls: 'chip ok', text: '주문 완료' })]),
        el('h2', { cls: 'res-h', text: issueMsg(review, true) }),
        el('p', { cls: 'sub small', text: g.macro && g.rooms.length ? '입금이 확인되면 바로 매크로를 쓸 수 있고, K bot이 방에 들어갑니다.'
          : (g.rooms.length ? '입금이 확인되면 K bot이 방에 들어갑니다.' : '입금이 확인되면 바로 매크로를 쓸 수 있습니다.') }),
        amountBlock(amt, base, review),
        el('div', { cls: 'big' }, [
          el('div', { cls: 'k', text: '입금 계좌' }),
          el('div', { cls: 'v sm', text: acct || '관리자에게 문의' }),
          acct ? el('div', { cls: 'btn-row' }, [copyBtn(function () { return acct; }, '계좌번호')]) : null
        ]),
        el('div', { cls: 'big' }, [
          el('div', { cls: 'k', text: '주문번호' }),
          el('div', { cls: 'v mono sm', text: id || '-' }),
          el('div', { cls: 'btn-row' }, [
            id ? copyBtn(function () { return id; }, '주문번호') : null,
            link ? el('a', { cls: 'btn sm primary', href: link }, '주문 조회') : null
          ])
        ]),
        noteEl('dim', [TTL_MSG]),
        review ? noteEl('warn', ['입금 후 주문번호를 적어 문의해 주시면 더 빨리 처리됩니다.',
          ' ', supportBtn('문의하기', '주문 ' + id + ' · 금액 확인')]) : null,
        el('dl', { cls: 'kv' }, [
          el('div', { cls: 'r' }, [el('dt', { text: '상품' }), el('dd', null, [el('ul', { cls: 'kv-list' }, prodLines)])]),
          g.rooms.length ? el('div', { cls: 'r' }, [el('dt', { text: '설치할 방' }), el('dd', null, [el('ul', { cls: 'kv-list' },
            g.rooms.map(function (rm) { return el('li', { cls: 'mono', text: shortLink(rm.link_url) }); }))])]) : null
        ]),
        el('div', { cls: 'btn-row' }, [
          el('a', { cls: 'btn', href: '/account' }, [icon('i-receipt', 14), '구매 내역 보기'])
        ])
      ]));

      window.scrollTo(0, 0);
      toast('주문이 완료되었습니다', 'ok');
    }
  }

  /* 주문 줄 묶기: 매크로 합계 + 방(install_id)마다 상품 목록 */
  function groupItems(items) {
    var macro = null, rooms = [], by = {};
    (items || []).forEach(function (it) {
      if (!it || typeof it !== 'object') return;
      var a = num(it.amount) || 0;
      if (it.product === 'macro') {
        if (!macro) macro = { months: 0, amount: 0 };
        macro.months += num(it.months) || 0;
        macro.amount += a;
        return;
      }
      var key = it.install_id !== undefined && it.install_id !== null ? 'i' + it.install_id : 'u' + str(it.link_url);
      var g = by[key];
      if (!g) {
        g = by[key] = { install_id: it.install_id !== undefined && it.install_id !== null ? Number(it.install_id) : null,
                        link_url: str(it.link_url), link_name: str(it.link_name), products: [], amounts: {}, amount: 0 };
        rooms.push(g);
      }
      if (g.products.indexOf(it.product) < 0) g.products.push(it.product);
      g.amounts[it.product] = (g.amounts[it.product] || 0) + a;
      g.amount += a;
      if (!g.link_name && it.link_name) g.link_name = str(it.link_name);
    });
    return { macro: macro, rooms: rooms };
  }

  /* 주문 줄 요약: `카카오톡 매크로 2개월 · 방 관리봇 (방 1개)` */
  function itemsSummary(items) {
    var g = groupItems(items), parts = [], n = {};
    if (g.macro) parts.push(featName('macro') + ' ' + g.macro.months + '개월');
    g.rooms.forEach(function (rm) { rm.products.forEach(function (p) { n[p] = (n[p] || 0) + 1; }); });
    ROOM_PRODUCTS.forEach(function (p) { if (n[p]) parts.push(featName(p) + ' (방 ' + n[p] + '개)'); });
    return parts.join(' · ') || '-';
  }

  /* ══════════════════ 7. 주문 상태 (/order/:id) — 6.7 ══════════════════ */

  function normOrder(raw) {
    var o = (raw && typeof raw.order === 'object' && raw.order) ? raw.order : (raw || {});
    function featIds(v) {
      var out = [];
      if (!v) return out;
      (Array.isArray(v) ? v : String(v).split(/[,\s|]+/)).forEach(function (x) {
        var id = str(typeof x === 'object' ? pick(x, ['id', 'feature', 'key', 'product']) : x).toLowerCase();
        if (id && out.indexOf(id) < 0) out.push(id);
      });
      return out;
    }
    var kind = str(pick(o, ['kind'])) || str(pick(raw, ['kind']));
    return {
      id: str(pick(o, ['id', 'order_id', 'orderId'])),
      kind: kind,
      member: kind === 'member',
      status: (str(pick(o, ['status', 'state'])) || 'pending').toLowerCase(),
      features: featIds(pick(o, ['features', 'feature'])),
      featLabels: (Array.isArray(o.feature_labels) ? o.feature_labels : []).map(str).filter(Boolean),
      items: Array.isArray(o.items) ? o.items : [],
      applied: o.applied && typeof o.applied === 'object' ? o.applied : null,
      rooms: Array.isArray(o.rooms) ? o.rooms : [],
      canCancel: !!o.can_cancel,
      accountsN: o.accounts_n === undefined || o.accounts_n === null ? null : num(o.accounts_n),
      plan: str(pick(o, ['plan', 'plan_id'])),
      planLabel: str(pick(o, ['plan_label', 'planLabel'])),
      days: num(pick(o, ['days'])),
      amount: amount(pick(o, ['amount', 'total', 'price'])),
      base: amount(pick(o, ['base_amount', 'baseAmount'])),
      needsReview: !!pick(o, ['needs_review', 'needsReview']),
      /* 서버가 48시간 미입금으로 자동 취소한 주문. 사람이 취소한 것과 문구를 다르게 보여 준다 */
      autoCanceled: !!(pick(o, ['auto_canceled', 'autoCanceled']) || pick(raw, ['auto_canceled', 'autoCanceled'])),
      authed: pick(raw, ['authed']) === undefined ? null : !!raw.authed,
      created: ts(pick(o, ['created_at', 'createdAt', 'created'])),
      handled: ts(pick(o, ['handled_at', 'handledAt'])),
      issued: str(pick(o, ['issued_key', 'issuedKey'])),
      target: str(pick(o, ['target_key', 'targetKey'])),       // 예전 연장 주문의 기존 키(가려진 형태)
      depositor: str(pick(o, ['depositor', 'buyer_name', 'buyerName', 'buyer'])),
      memo: str(pick(o, ['memo', 'note'])),
      account: str(pick(raw, ['account', 'bank', 'bank_info'])) || str(pick(o, ['account', 'bank']))
    };
  }

  /* order.html 오른쪽 안내 — HTML 기본은 회원 주문 문구. 예전 키 주문이면 그때 문구로 바꿔 끼운다(부록 A.3) */
  var LEGACY_ORDER_NOTE = {
    auto: '입금은 금액으로 자동 확인되며, 보통 1~2분 안에 키가 발급됩니다. 금액이 다르거나 30분이 지나도 상태가 바뀌지 않으면 주문번호와 입금자명을 적어 문의해 주세요.',
    manual: '관리자가 입금을 확인한 뒤 키를 발급합니다. 30분이 지나도 상태가 바뀌지 않으면 주문번호와 입금자명을 적어 문의해 주세요.'
  };
  /* 끝난 주문(완료·취소)에는 입금 안내 대신 이 문구를 둔다 */
  var ORDER_NOTE_END = '주문에 궁금한 점이 있으면 주문번호를 적어 문의해 주세요.';
  function setOrderNote(text) {
    var nt = $('#orderNoteT');
    if (!nt) return;
    if (!nt.hasAttribute('data-live-text')) nt.setAttribute('data-live-text', nt.textContent);
    nt.textContent = text == null ? nt.getAttribute('data-live-text') : text;
  }

  function pageOrder() {
    var out = $('#result'), form = $('#findForm'), idIn = $('#oid');

    var m = location.pathname.match(/\/order\/([^\/?#]+)/);
    var id = (m ? decodeURIComponent(m[1]) : '') || str(qs().get('id'));
    /* 확인코드(t)가 있으면 로그인하지 않은 브라우저에서도 본다. URL에 없으면 이 브라우저에 저장된 걸 쓴다.
       회원 주문은 주인 회원이면 확인코드 없이도 보인다(서버가 세션으로 확인). */
    var token = str(qs().get('t')) || (id ? loadToken(id) : '');

    form.addEventListener('submit', function (ev) {
      ev.preventDefault();
      var v = str(idIn.value).toUpperCase().replace(/[^A-Z0-9-]/g, '');
      if (!v) { toast('주문번호를 입력해 주세요', 'bad'); idIn.focus(); return; }
      var t = loadToken(v);
      location.href = '/order/' + encodeURIComponent(v) + (t ? '?t=' + encodeURIComponent(t) : '');
    });

    if (!id) {
      $('#findWrap').hidden = false;
      out.hidden = true;
      return;
    }
    idIn.value = id;
    $$('#orderNote [data-support]').forEach(function (b) { b.setAttribute('data-support-ctx', '주문 ' + id); });

    /* 구매 화면에서 막 넘어왔다(new=1): 제목을 '주문 완료'로 하고, 새로고침해도 다시 안 뜨게 주소에서 뺀다 */
    if (qs().get('new') === '1') {
      var h1 = $('.pub-head h1'), lead = $('.pub-head .lead');
      if (h1) h1.textContent = '주문 완료';
      if (lead) lead.textContent = '아래 금액을 입금하면 이 화면에서 자동으로 확인됩니다. 화면을 닫아도 내 계정의 구매 내역에서 다시 볼 수 있습니다.';
      document.title = '주문 완료 · K bot';
      toast('주문이 완료되었습니다', 'ok');
      try { history.replaceState(null, '', orderUrl(id, str(qs().get('t')))); } catch (e) { /* 주소만 못 바꾼다 */ }
    }

    /* ── 폴링 (SPEC 12.4) ───────────────────────────────────────────────
         · 5초마다 GET /api/order/:id?t=...
         · 탭이 숨으면 멈추고, 다시 보이면 즉시 한 번 확인한다
         · done / canceled 면 멈춘다. 단 회원 주문이 done 이고 아직 '사용 중' 이 아닌 방이 있으면
           10초 간격으로 최대 10분 더 본다(방 입장·부방장 지정 진행을 보여 주려고, 6.7)
         · 최대 30분 폴링하고 중단 → [상태 새로고침] 버튼만 남긴다
         · 네트워크 실패는 조용히 다음 차례로 넘긴다 (연속 5회면 딱 한 번만 알린다)
         · 첫 조회가 네트워크 오류로 실패해도 폴링을 시작한다. 영구 실패(404 / not_found / bad_request)는 끊는다 */
    var POLL_MS   = 5000;
    var ROOM_POLL_MS = 10000;
    var ROOM_WATCH_MAX = 10 * 60 * 1000;
    var POLL_MAX  = 30 * 60 * 1000;
    var FAIL_WARN = 5;

    var timer = null;          // 다음 폴링 타이머
    var inFlight = false;      // 요청 겹침 방지
    var polling = false;       // 계속 확인해야 하는 상태인가 (실패 재시도 중에도 true)
    var startAt = Date.now();  // 폴링 시작 시각 (30분 기준점)
    var doneAt = 0;            // 회원 주문 done 을 처음 본 시각 (방 상태 10분 기준점)
    var lastAt = 0;            // 마지막 요청 시각 (focus 중복 호출 방지)
    var fails = 0, failToasted = false;
    var timedOut = false;      // 30분 초과로 중단됨
    var lastSig = '';          // 응답이 그대로면 다시 안 그린다 (깜빡임·포커스 유실 방지)
    var lastOrder = null;
    var lastError = null;      // 마지막 실패 { msg, gone }
    var everLoaded = false;    // 주문을 한 번이라도 받아왔나
    var waitBox = null;        // 살아있는 표시 (점 애니메이션)
    var shownStatus = '';      // 화면에 그려 둔 상태 — 상태가 바뀌어 다시 그릴 때만 카드가 올라온다 (UI_V5 3.4)
    var pollEvery = POLL_MS;

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
      var wait = pollEvery * (fails > 0 ? Math.min(fails + 1, 4) : 1);
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
      var box = el('div', { cls: 'wait', role: 'status' }, [
        el('span', { cls: 'txt' }, [
          txt,
          el('span', { cls: 'dots', 'aria-hidden': 'true' }, [el('i'), el('i'), el('i')])
        ]),
        elap
      ]);
      waitBox = { box: box, el: elap };
      return box;
    }

    /* 불러오기 실패 화면. 영구 실패가 아니면 재시도 중이라는 걸 화면에 남긴다 */
    function renderError() {
      var e = lastError || {};
      var retrying = polling && !timedOut && !e.gone;
      clear(out);
      waitBox = null;
      out.hidden = false;
      out.appendChild(el('div', { cls: 'card' }, [
        el('div', { cls: 'state bad', text: e.msg || '주문을 불러올 수 없습니다' }),
        el('div', { cls: 'center' }, [
          el('button', { type: 'button', cls: 'btn sm', onclick: function () { fetchOrder(true); } }, [icon('i-refresh', 14), '다시 시도'])
        ])
      ]));
      if (retrying) {
        out.appendChild(makeWait('다시 연결하는 중'));
        out.appendChild(noteEl('', ['인터넷이 다시 연결되면 자동으로 다시 확인합니다. 새로고침할 필요는 없습니다.']));
      } else if (!e.gone && timedOut) {
        out.appendChild(noteEl('warn', ['30분 동안 연결되지 않아 자동 확인을 멈췄습니다. [다시 시도]를 눌러 주세요. ' +
          '같은 상태가 이어지면 주문번호와 입금자명을 적어 문의해 주세요.', ' ', supportBtn('문의하기', '주문 ' + id)]));
      } else if (e.gone) {
        out.appendChild(noteEl('', ['주문한 아이디로 로그인하면 이 주문을 볼 수 있습니다. ',
          el('a', { cls: 'btn sm', href: loginUrl(location.pathname) }, '로그인')]));
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

      /* 계좌·상품 이름표를 같이 쓰려고 가격표도 받아둔다 (실패해도 진행) */
      var pricing = loadPrice().catch(function () { return null; });

      api(orderPath(id)).then(function (res) {
        return pricing.then(function () {
          fails = 0; failToasted = false;
          lastError = null; everLoaded = true;
          applyAutoCopy(res && res.auto_approve);  // 주문 조회 응답에도 실려온다
          var o = normOrder(res);
          lastOrder = o;
          var sig = [o.status, o.issued, o.amount, o.handled, o.needsReview ? 1 : 0,
                     o.autoCanceled ? 1 : 0, o.authed === false ? 0 : 1, o.canCancel ? 1 : 0, o.accountsN,
                     JSON.stringify(o.rooms.map(function (r) { return [r.install_id, r.display, r.label, r.detail, r.bot && r.bot.nickname]; }))].join('|');
          if (!loud && sig === lastSig) { tickWait(); return; }   // 바뀐 게 없다
          lastSig = sig;
          render(o, id);
        });
      }).catch(function (e) {
        fails++;
        var gone = e && (e.status === 404 || e.code === 'not_found' || e.code === 'bad_request');
        if (gone) stopPoll();                                     // 없는 주문은 더 두드려봐야 소용없다
        else if (!timedOut && !polling) polling = true;

        lastError = { msg: (e && e.status === 404) || (e && e.code === 'not_found')
                        ? '해당 주문번호를 찾을 수 없습니다' : ((e && e.message) || '주문을 불러올 수 없습니다'),
                      gone: !!gone };

        if (loud || gone || !everLoaded) {
          var esig = ['ERR', lastError.msg, gone ? 1 : 0, timedOut ? 1 : 0, polling ? 1 : 0].join('|');
          if (loud || esig !== lastSig) { lastSig = esig; renderError(); }
          else tickWait();
        } else if (fails >= FAIL_WARN && !failToasted) {
          failToasted = true;
          toast('주문 상태를 계속 불러오지 못하고 있습니다. 인터넷 연결을 확인해 주세요. 연결되면 자동으로 다시 확인합니다', 'bad');
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

    /* [주문 취소] — 인라인 2단계 확인 (6.5 와 같은 문구) */
    function cancelBox(o) {
      var host = el('div', { cls: 'cancel-host' });
      var btn = el('button', { type: 'button', cls: 'btn sm danger' }, [icon('i-x', 14), '주문 취소']);
      btn.addEventListener('click', function () {
        inlineConfirm(host, CANCEL_WARN, '주문 취소', function () {
          return api('/api/my/orders/cancel', { method: 'POST', body: { id: o.id || id } }).then(function () {
            toast('주문을 취소했습니다', 'ok');
            lastSig = '';
            fetchOrder(true);
          });
        });
      });
      host.appendChild(el('div', { cls: 'btn-row' }, [btn]));
      return host;
    }

    function render(o, oid) {
      if (o.member) renderMember(o, oid); else renderLegacy(o, oid);
      /* 폴링 재개/정지 결정을 렌더 뒤에 한 번 더 태운다 */
      schedule();
    }

    /* 진행 중인가 — 폴링 켜기/끄기 */
    function decidePolling(live) {
      if (live && !timedOut) { if (!polling) polling = true; }
      else stopPoll();
    }

    function headChips(o, st, autoCanceled) {
      return el('div', { cls: 'chip-row' }, [
        el('span', { cls: 'chip ' + st.cls, text: autoCanceled ? '자동 취소됨 · 미입금' : st.kr }),
        o.created ? el('span', { cls: 'tiny dim', text: dateKr(o.created, true) + ' 주문' }) : null
      ]);
    }

    function accountBig(acct) {
      return el('div', { cls: 'big' }, [
        el('div', { cls: 'k', text: '입금 계좌' }),
        el('div', { cls: 'v sm', text: acct || '관리자에게 문의' }),
        acct ? el('div', { cls: 'btn-row' }, [copyBtn(function () { return acct; }, '계좌번호')]) : null
      ]);
    }
    function idBig(showId) {
      return el('div', { cls: 'big' }, [
        el('div', { cls: 'k', text: '주문번호' }),
        el('div', { cls: 'v mono sm', text: showId }),
        el('div', { cls: 'btn-row' }, [copyBtn(function () { return showId; }, '주문번호')])
      ]);
    }

    /* ── 회원 주문 (kind='member') ───────────────────────── */
    function renderMember(o, oid) {
      var st = STATUS_MEMBER[o.status] || { kr: o.status || '알 수 없음', cls: '' };
      clear(out);
      waitBox = null;
      out.hidden = false;
      var fw = $('#findWrap');
      if (fw) fw.hidden = true;

      var showId = o.id || oid;
      var acct = o.account || (PRICE && PRICE.bank) || '';
      var pending = o.status === 'pending';
      var paid = o.status === 'paid';
      var done = o.status === 'done';
      var canceled = o.status === 'canceled' || o.status === 'cancelled';
      var autoCanceled = canceled && o.autoCanceled;
      setOrderNote(done || canceled ? ORDER_NOTE_END : null);
      var g = groupItems(o.items);
      var views = {};
      o.rooms.forEach(function (r) { if (r && r.install_id !== undefined) views[Number(r.install_id)] = r; });

      if (done && !doneAt) doneAt = Date.now();
      var roomWatch = done && g.rooms.length > 0 && Date.now() - doneAt < ROOM_WATCH_MAX &&
        g.rooms.some(function (rm) { var v = views[rm.install_id]; return !v || v.display !== 'active'; });
      var live = !(done || canceled) || roomWatch;
      pollEvery = done ? ROOM_POLL_MS : POLL_MS;
      var was = shownStatus;
      var enter = !!was && was !== o.status && !reducedMotion();
      shownStatus = o.status;
      decidePolling(live);
      /* 보고 있는 동안 상태가 바뀌면 알린다 */
      if (was === 'pending' && (paid || done)) toast('입금이 확인되었습니다', 'ok');
      else if (was === 'paid' && done) toast('처리가 끝났습니다', 'ok');

      /* 상품 줄 */
      var kv = [];
      var applied = o.applied || {};
      if (g.macro) {
        var until = applied.macro && ts(applied.macro.until);
        kv.push(el('div', { cls: 'r' }, [el('dt', { text: featName('macro') }),
          el('dd', { text: done && until ? '만료 ' + dateKr(until) : g.macro.months + '개월' })]));
      }
      var skipped = {};
      (Array.isArray(applied.skipped) ? applied.skipped : []).forEach(function (s) { if (s) skipped[Number(s.install_id)] = s; });
      g.rooms.forEach(function (rm) {
        var v = views[rm.install_id] || null;
        var sk = rm.install_id !== null ? skipped[rm.install_id] : null;
        var label = sk ? '설치하지 못함' : (v ? str(v.label) : st.kr);
        var disp = v ? v.display : '';
        var showDetail = !sk && v && v.detail && (disp === 'waiting' || disp === 'error' || disp === 'joining');
        var ctx = '주문 ' + showId + (rm.install_id !== null ? ' · 방 #' + rm.install_id : '') + ' · ' + label;
        kv.push(el('div', { cls: 'r' }, [
          el('dt', { text: rm.link_name || (v && v.link_name) || '이름 확인 전' }),
          el('dd', null, [
            el('div', { cls: 'room-st' }, [
              disp ? el('i', { cls: 'dot ' + dotCls(disp), 'aria-hidden': 'true' }) : null,
              el('span', { text: rm.products.map(featName).join(' · ') + ' · ' + label })
            ]),
            el('div', { cls: 'mono dim tiny', text: shortLink(rm.link_url) }),
            showDetail ? el('div', { cls: 'dim tiny room-d', text: v.detail }) : null,
            (sk || disp === 'error') ? el('div', { cls: 'btn-row' }, [
              // 오류 문구가 말하는 [다시 시도]·참여코드 입력은 패널의 방 상태 화면에 있다
              !sk && v && v.can_retry ? el('a', { cls: 'btn sm', href: '/panel#room/' + rm.install_id },
                v.needs_passcode ? '패널에서 참여코드 입력' : '패널에서 다시 시도') : null,
              supportBtn('문의하기', ctx)]) : null
          ])
        ]));
      });
      if (!pending) kv.push(el('div', { cls: 'r' }, [el('dt', { text: '금액' }), el('dd', { cls: 'mono' }, wonKids(o.amount))]));
      if (o.depositor) kv.push(el('div', { cls: 'r' }, [el('dt', { text: '입금자명' }), el('dd', { text: o.depositor })]));
      if (o.memo) kv.push(el('div', { cls: 'r' }, [el('dt', { text: '메모' }), el('dd', { text: o.memo })]));
      if (o.handled) kv.push(el('div', { cls: 'r' }, [el('dt', { text: '처리 시각' }), el('dd', { text: dateKr(o.handled, true) })]));

      /* 완료 버튼 (6.7) */
      var acts;
      if (done) {
        var cta = g.rooms.length ? ['내 방 보기', '/panel#rooms']
          : (o.accountsN === 0 ? ['카카오 계정 등록', '/panel#account-add'] : ['패널 열기', '/panel']);
        acts = [
          el('a', { cls: 'btn primary', href: cta[1] }, cta[0]),
          el('a', { cls: 'btn', href: '/account' }, '내 계정'),
          el('button', { type: 'button', cls: 'btn ghost', onclick: function () { fetchOrder(true); } }, [icon('i-refresh', 14), '상태 새로고침'])
        ];
      } else {
        acts = [
          el('button', { type: 'button', cls: 'btn', onclick: function () { fetchOrder(true); } }, [icon('i-refresh', 14), '상태 새로고침'])
        ];
      }

      /* 살아있는 표시는 카드 맨 위에 — 휴대폰에서도 들어오자마자 '지금 확인 중'이 보이게 */
      var waitEl = (!done && live && polling && !timedOut)
        ? makeWait(paid ? '처리 대기 중' : (o.needsReview ? '관리자 확인 대기 중' : '입금 확인 대기 중')) : null;
      out.appendChild(el('div', { cls: 'card stack' + (enter ? ' in' : '') }, [
        headChips(o, st, autoCanceled),
        waitEl,
        pending ? amountBlock(o.amount, o.base, o.needsReview) : null,
        pending && o.canCancel ? cancelBox(o) : null,
        pending ? accountBig(acct) : null,
        idBig(showId),
        el('dl', { cls: 'kv' }, kv),
        el('div', { cls: 'btn-row' }, acts)
      ]));
      if (!done && live && timedOut) {
        out.appendChild(noteEl('warn', ['30분이 지나 자동 확인을 멈췄습니다. [상태 새로고침]을 누르면 다시 확인합니다. ' +
          '같은 상태가 이어지면 주문번호를 적어 문의해 주세요.', ' ', supportBtn('문의하기', '주문 ' + showId)]));
      }

      var tip, warn = false;
      if (pending) {
        warn = true;
        /* 30분이 지나 멈춘 경우는 위 경고 한 줄로 충분하다 — 같은 말을 두 번 하지 않는다 */
        tip = timedOut
          ? null
          : (o.needsReview
              ? '관리자가 확인을 마치면 이 화면에 바로 표시됩니다.'
              : (AUTO_APPROVE
                  ? '입금이 확인되면 이 화면에 바로 표시됩니다.'
                  : '관리자가 입금을 확인하면 이 화면에 바로 표시됩니다.'));
      } else if (paid) {
        tip = '입금이 확인되었습니다. 처리가 끝나면 이 화면에 바로 표시됩니다.';
      } else if (done) {
        var macroTip = o.accountsN === 0 ? '패널에 카카오 계정을 등록하면 매크로를 바로 쓸 수 있습니다.' : '패널에서 매크로를 바로 쓸 수 있습니다.';
        tip = g.rooms.length
          ? 'K bot이 방에 들어간 뒤 패널의 내 방에서 상태를 볼 수 있습니다.' + (g.macro ? ' ' + macroTip : '')
          : macroTip;
      } else if (autoCanceled) {
        warn = true;
        tip = TTL_CANCELED_MSG;
      } else if (canceled) {
        tip = '취소된 주문입니다. 다시 구매하려면 구매 화면에서 주문해 주세요.';
      } else {
        tip = '상태를 계속 확인하고 있습니다. 오래 바뀌지 않으면 주문번호를 적어 문의해 주세요.';
      }
      if (tip) out.appendChild(noteEl(warn ? 'warn' : '', [tip, autoCanceled ? ' ' : null, autoCanceled ? supportBtn('문의하기', '주문 ' + showId + ' · 자동 취소') : null]));
      if (pending) out.appendChild(noteEl('dim', [o.canCancel ? TTL_MSG_HERE : TTL_MSG]));
      if (o.needsReview && pending) {
        out.appendChild(noteEl('warn', ['입금 후 주문번호를 적어 문의해 주시면 더 빨리 처리됩니다. 금액은 안내된 그대로 입금해 주세요.',
          ' ', supportBtn('문의하기', '주문 ' + showId + ' · 금액 확인')]));
      }
    }

    function dotCls(d) {
      if (d === 'active') return 'live';
      if (d === 'error') return 'crit';
      return 'warn';
    }

    /* ── 예전 키 주문 (kind 없음) — 지금 화면 그대로 ─────── */
    function renderLegacy(o, oid) {
      var st = STATUS[o.status] || { kr: o.status || '알 수 없음', cls: '' };
      clear(out);
      waitBox = null;
      out.hidden = false;
      var fw = $('#findWrap');
      if (fw) fw.hidden = true;
      var lDone = o.status === 'done' || o.status === 'canceled' || o.status === 'cancelled';
      setOrderNote(lDone ? ORDER_NOTE_END : (AUTO_APPROVE ? LEGACY_ORDER_NOTE.auto : LEGACY_ORDER_NOTE.manual));

      var showId = o.id || oid;
      var acct = o.account || (PRICE && PRICE.bank) || '';
      var pending = o.status === 'pending';
      var paid = o.status === 'paid';
      var done = o.status === 'done';
      var canceled = o.status === 'canceled' || o.status === 'cancelled';
      var live = !(done || canceled);
      var autoCanceled = canceled && o.autoCanceled;
      var extend = !!o.target;
      var enter = !!shownStatus && shownStatus !== o.status && !reducedMotion();
      shownStatus = o.status;
      pollEvery = POLL_MS;
      decidePolling(live);
      var product = (o.planLabel || o.plan || '-') + (o.days ? ' (' + o.days + '일)' : '');

      out.appendChild(el('div', { cls: 'card stack' + (enter ? ' in' : '') }, [
        headChips(o, st, autoCanceled),
        o.issued ? el('div', { cls: 'big keybox' }, [
          el('div', { cls: 'k', text: extend ? '연장된 라이선스 키' : '발급된 라이선스 키' }),
          el('div', { cls: 'v key', text: o.issued }),
          el('div', { cls: 'btn-row' }, [
            copyBtn(function () { return o.issued; }, '키')
          ]),
          el('div', { cls: 'tiny warnline', text: '예전 라이선스 키 주문입니다. 이제 패널은 아이디로 로그인합니다.' })
        ]) : null,
        pending ? amountBlock(o.amount, o.base, o.needsReview) : null,
        pending ? accountBig(acct) : null,
        idBig(showId),
        el('dl', { cls: 'kv' }, [
          el('div', { cls: 'r' }, [el('dt', { text: '상품' }), el('dd', { text: product })]),
          el('div', { cls: 'r' }, [el('dt', { text: '포함 기능' }),
            el('dd', { text: o.featLabels.length ? o.featLabels.join(' · ') : (o.features.length ? o.features.map(featName).join(' · ') : '-') })]),
          !pending ? el('div', { cls: 'r' }, [el('dt', { text: '금액' }), el('dd', { cls: 'mono' }, wonKids(o.amount))]) : null,
          o.depositor ? el('div', { cls: 'r' }, [el('dt', { text: '입금자명' }), el('dd', { text: o.depositor })]) : null,
          o.target ? el('div', { cls: 'r' }, [el('dt', { text: '연장할 키' }), el('dd', { cls: 'mono', text: o.target })]) : null,
          o.memo ? el('div', { cls: 'r' }, [el('dt', { text: '메모' }), el('dd', { text: o.memo })]) : null,
          o.handled ? el('div', { cls: 'r' }, [el('dt', { text: '처리 시각' }), el('dd', { text: dateKr(o.handled, true) })]) : null
        ]),
        el('div', { cls: 'btn-row' }, [
          el('button', { type: 'button', cls: 'btn', onclick: function () { fetchOrder(true); } }, [icon('i-refresh', 14), '상태 새로고침']),
          el('a', { cls: 'btn ghost', href: '/' }, '처음으로')
        ])
      ]));

      if (live && polling && !timedOut) {
        out.appendChild(makeWait(paid ? '키 발급 대기 중' : (o.needsReview ? '관리자 확인 대기 중' : '입금 확인 대기 중')));
      }
      if (live && timedOut) {
        out.appendChild(noteEl('warn', ['30분 동안 처리되지 않아 자동 확인을 멈췄습니다. [상태 새로고침]으로 다시 확인해 주세요. ' +
          '같은 상태가 이어지면 주문번호와 입금자명을 적어 문의해 주세요.', ' ', supportBtn('문의하기', '주문 ' + showId)]));
      }
      var tip;
      if (pending) {
        tip = timedOut ? null
          : (AUTO_APPROVE ? '키가 발급되면 이 화면에 바로 표시됩니다.'
                          : '관리자가 입금을 확인하면 이 화면에 바로 표시됩니다.');
      } else if (paid) {
        tip = '입금이 확인되었습니다. 키가 발급되면 이 화면에 바로 표시됩니다.';
      } else if (done) {
        tip = '예전 라이선스 키 주문입니다. 이제 패널은 아이디로 로그인합니다. 궁금한 점이 있으면 주문번호를 적어 문의해 주세요.';
      } else if (autoCanceled) {
        tip = TTL_CANCELED_MSG;
      } else if (canceled) {
        tip = '취소된 주문입니다. 다시 구매하려면 구매 화면에서 주문해 주세요.';
      } else {
        tip = '상태를 계속 확인하고 있습니다. 오래 바뀌지 않으면 주문번호를 적어 문의해 주세요.';
      }
      if (tip) out.appendChild(noteEl(pending || autoCanceled ? 'warn' : '', [tip]));
      if (pending) out.appendChild(noteEl('dim', [TTL_MSG]));
      /* 확인코드(t) 없이 주문번호만으로 들어온 경우 — 발급된 키는 안 보인다 */
      if (o.authed === false) {
        out.appendChild(noteEl('', [
          '발급된 키와 입금자 정보는 ', el('b', { text: '구매 직후 받은 링크(주문번호 + 확인코드)' }),
          '로 접속해야 볼 수 있습니다. 링크를 잃어버렸다면 주문번호를 적어 문의해 주세요.'
        ]));
      }
    }
  }

  /* ══════════════════ 8. 로그인 (/login) — 6.3 ══════════════════ */

  function gNote(screen, code, next) {
    var box = $('#gNote');
    if (!box || !code) return;
    clear(box);
    var n = G_NOTES[code];
    if (code === 'recover' && screen === 'account') return;     // #password 카드가 보인다
    if (!n || (n.at !== 'both' && n.at !== screen)) return;
    var text = n.t, extra = [];
    if (code === 'not_linked' && /recover/.test(next || '')) {
      text = G_RECOVER_NONE;
      extra.push(supportBtn('문의하기', '비밀번호 찾기 · Google 연결 없음'));
    }
    if (n.support) extra.push(supportBtn('문의하기', '로그인 · 이용 정지'));
    if (n.external) {
      var target = location.origin + (screen === 'account' ? '/account' : '/login' + (next ? '?next=' + encodeURIComponent(next) : ''));
      extra.push(el('a', { cls: 'btn sm', href: 'kakaotalk://web/openExternal?url=' + encodeURIComponent(target) }, '외부 브라우저로 열기'));
    }
    var kids = [text];
    extra.forEach(function (x) { kids.push(' '); kids.push(x); });
    box.appendChild(noteEl(n.warn ? 'warn' : '', kids));
    box.hidden = false;
  }

  /* 주소의 ?g= 를 지운다(새로고침 때 다시 보이지 않게). 나머지는 그대로 */
  function dropG() {
    try {
      var u = new URL(location.href);
      if (!u.searchParams.has('g')) return;
      u.searchParams.delete('g');
      history.replaceState(null, '', u.pathname + (u.searchParams.toString() ? '?' + u.searchParams.toString() : '') + u.hash);
    } catch (e) { /* 주소만 못 바꾼다 */ }
  }

  function googleUi(on) {
    $$('[data-google]').forEach(function (n) { n.hidden = !on; });
    $$('[data-google-off]').forEach(function (n) { n.hidden = !!on; });
  }

  function pageLogin() {
    var q = qs();
    var next = safeNext(q.get('next'), '/account');
    var g = str(q.get('g'));
    var form = $('#loginForm'), idIn = $('#login_id'), pwIn = $('#pw'), btn = $('#loginBtn');
    var sending = false;

    var su = $('#signupLink');
    if (su) su.setAttribute('href', '/signup?next=' + encodeURIComponent(next));
    var gb = $('#googleBtn');
    if (gb) gb.setAttribute('href', '/auth/google/start?mode=login&next=' + encodeURIComponent(next));
    gNote('login', g, next);
    dropG();

    siteInfo().then(function (s) {
      googleUi(!!s.google);
      if (s.member && !g) location.replace(next);     // 이미 로그인한 경우
    });

    idIn.addEventListener('input', function () { fieldErr('login', ''); });
    pwIn.addEventListener('input', function () { fieldErr('pw', ''); });

    form.addEventListener('submit', function (ev) {
      ev.preventDefault();
      if (sending) return;
      fieldErr('login', ''); fieldErr('pw', ''); fieldErr('submit', '');
      var id = str(idIn.value), pw = pwIn.value || '';
      if (/^KAKA-/i.test(id)) {
        fieldErr('login', '라이선스 키로는 로그인할 수 없습니다. 아이디로 로그인하거나 회원가입해 주세요');
        idIn.focus();
        return;
      }
      var bad = null;
      if (!id) { fieldErr('login', '아이디를 입력해 주세요'); bad = idIn; }
      if (!pw) { fieldErr('pw', '비밀번호를 입력해 주세요'); bad = bad || pwIn; }
      if (bad) { bad.focus(); return; }
      sending = true;
      setBusy(btn, true);
      api('/api/auth/login', { method: 'POST', body: { login_id: id, password: pw } }).then(function () {
        supportReboot();
        location.href = next;                          // 토스트 없이 이동
      }, function (e) {
        sending = false;
        setBusy(btn, false);
        if (e.code === 'locked') {
          var sec = num(e.data && e.data.retry_after) || 900;
          fieldErr('submit', '로그인 실패 횟수를 초과했습니다. ' + Math.max(1, Math.ceil(sec / 60)) + '분 뒤 다시 시도해 주세요');
        } else if (e.code === 'bad_credentials') {
          fieldErr('submit', '아이디 또는 비밀번호가 일치하지 않습니다. 다시 입력해 주세요');
          try { pwIn.select(); } catch (er) { /* 무시 */ }
        } else if (e.code === 'blocked') {
          fieldErr('submit', '이용이 정지된 계정입니다. 문의해 주세요', supportBtn('문의하기', '로그인 · 이용 정지 · ' + id));
        } else {
          fieldErr('submit', e.message);
        }
      });
    });
  }

  /* ══════════════════ 9. 회원가입 (/signup) — 6.4 ══════════════════ */

  var SIGNUP_ERR = {
    bad_login_id: ['login', '아이디는 영문 소문자로 시작하고, 영문 소문자·숫자·밑줄(_)로 4~20자를 입력해 주세요'],
    reserved_id:  ['login', '사용할 수 없는 아이디입니다. 다른 아이디를 입력해 주세요'],
    taken:        ['login', '이미 사용 중인 아이디입니다. 다른 아이디를 입력해 주세요'],
    bad_password: ['pw', null],        // 서버 error 그대로
    bad_contact:  ['contact', null]
  };

  function pageSignup() {
    var q = qs();
    var next = safeNext(q.get('next'), '/account');
    var form = $('#signupForm'), idIn = $('#login_id'), pwIn = $('#pw'), pw2In = $('#pw2'), conIn = $('#contact'), btn = $('#signupBtn');
    var sending = false;
    var li = $('#loginLink');
    if (li) li.setAttribute('href', '/login?next=' + encodeURIComponent(next));

    siteInfo().then(function (s) { if (s.member) location.replace(next); });

    [['login', idIn], ['pw', pwIn], ['pw2', pw2In], ['contact', conIn]].forEach(function (x) {
      x[1].addEventListener('input', function () { fieldErr(x[0], ''); });
    });
    idIn.addEventListener('blur', function () { idIn.value = str(idIn.value).toLowerCase(); });

    form.addEventListener('submit', function (ev) {
      ev.preventDefault();
      if (sending) return;
      ['login', 'pw', 'pw2', 'contact', 'submit'].forEach(function (k) { fieldErr(k, ''); });
      var id = str(idIn.value).toLowerCase();
      idIn.value = id;
      var pw = pwIn.value || '', pw2 = pw2In.value || '';
      var bad = null;
      if (!id) { fieldErr('login', '아이디를 입력해 주세요'); bad = idIn; }
      else if (!/^[a-z][a-z0-9_]{3,19}$/.test(id)) { fieldErr('login', SIGNUP_ERR.bad_login_id[1]); bad = idIn; }
      if (!pw) { fieldErr('pw', '비밀번호를 입력해 주세요'); bad = bad || pwIn; }
      else if (pw.length < 8) { fieldErr('pw', '비밀번호는 8자 이상 입력해 주세요'); bad = bad || pwIn; }
      if (pw && pw2 !== pw) { fieldErr('pw2', '비밀번호가 일치하지 않습니다'); bad = bad || pw2In; }
      if (bad) { bad.focus(); return; }
      sending = true;
      setBusy(btn, true);
      api('/api/auth/signup', { method: 'POST', body: { login_id: id, password: pw, contact: str(conIn.value) } }).then(function () {
        supportReboot();
        toast('가입되었습니다', 'ok');
        setTimeout(function () { location.href = next; }, 700);
      }, function (e) {
        sending = false;
        setBusy(btn, false);
        var m = SIGNUP_ERR[e.code];
        if (m) {
          fieldErr(m[0], m[1] || e.message);
          var f = { login: idIn, pw: pwIn, contact: conIn }[m[0]];
          if (f) f.focus();
        } else {
          fieldErr('submit', e.message);
        }
      });
    });
  }

  /* ══════════════════ 10. 내 계정 (/account) — 6.5 ══════════════════ */

  function pageAccount() {
    var q = qs();
    var g = str(q.get('g'));
    var bootBox = $('#accBoot'), wrap = $('#accWrap');
    var SITE = null, ME = null;

    function toLogin() { location.replace(loginUrl(hereUrl())); }

    siteInfo().then(function (s) {
      SITE = s;
      if (!s.member) { toLogin(); return; }
      loadMe(true);
    });

    function failBoot(e) {
      clear(bootBox);
      bootBox.appendChild(el('div', { cls: 'state bad', text: (e && e.message) || '계정 정보를 불러오지 못했습니다' }));
      bootBox.appendChild(el('div', { cls: 'center' }, [
        el('button', { type: 'button', cls: 'btn sm', onclick: function () { location.reload(); } }, [icon('i-refresh', 14), '다시 시도']),
        e && e.code === 'blocked' ? supportBtn('문의하기', '내 계정 · 이용 정지') : null
      ]));
    }

    function loadMe(first) {
      return api('/api/me').then(function (me) {
        ME = me;
        if (first) {
          bootBox.hidden = true;
          wrap.hidden = false;
          gNote('account', g, '');
          dropG();
          googleNudge();
          loadOrders();
          loadSessions();
        }
        renderHead();
        renderProducts();
        renderGoogle();
        renderPassword();
        if (first) jumpHash();
      }, function (e) {
        if (e.status === 401) { toLogin(); return; }
        if (first) failBoot(e); else toast(e.message, 'bad');
      });
    }

    function jumpHash() {
      var h = location.hash;
      if (!/^#[A-Za-z][\w-]*$/.test(h)) return;
      var t = document.getElementById(h.slice(1));
      if (!t) return;
      setTimeout(function () {
        try { t.scrollIntoView({ block: 'start' }); } catch (e) { /* 무시 */ }
        var f = $('input:not([type="hidden"]):not([hidden])', t);
        if (f && f.offsetParent) { try { f.focus({ preventScroll: true }); } catch (e) { f.focus(); } }
      }, 0);
    }

    function renderHead() {
      var h = $('#accId');
      if (h) h.textContent = (ME.member && ME.member.login_id) || '';
      var un = $('#pwUser');
      if (un) un.value = (ME.member && ME.member.login_id) || '';
    }

    function googleNudge() {
      var box = $('#googleNudge');
      if (!box) return;
      box.hidden = !(SITE && SITE.google && ME.member && !ME.member.google_linked);
    }

    /* ── 이용 중인 상품 ─────────────────────────────── */
    function renderProducts() {
      var mount = $('#accProducts');
      if (!mount) return;
      clear(mount);
      var now = Date.now();
      var mv = ME.macro || {};
      var until = ts(mv.until);
      var active = !!mv.active && until > now;
      var left = active ? (num(mv.days_left) || daysLeft(until, now)) : 0;
      var chip = active
        ? el('span', { cls: 'chip ' + (left <= 7 ? 'warn' : 'ok'), text: (left <= 7 ? '만료 임박 · ' : '사용 중 · ') + 'D-' + left })
        : (until ? el('span', { cls: 'chip bad', text: '만료됨' }) : el('span', { cls: 'chip', text: '미구매' }));
      var pct = active ? clamp(Math.round(left / DAYS_FALLBACK * 100), 3, 100) : 0;
      var bar = el('div', { cls: 'bar' + (!active ? ' off' : (left <= 3 ? ' bad' : (left <= 7 ? ' warn' : ''))),
        role: 'progressbar', 'aria-label': featName('macro') + ' 남은 기간', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(pct) }, [el('i')]);
      mount.appendChild(el('div', { cls: 'feat-row', 'data-prod': 'macro' }, [
        el('div', { cls: 'r1' }, [el('h3', { text: featName('macro') }), chip]),
        bar,
        el('div', { cls: 'meta' }, [
          el('span', { text: until ? '만료 ' + dateKr(until, true) : '아직 구매하지 않았습니다' }),
          el('span', { text: '' })
        ]),
        el('div', { cls: 'btn-row' }, [el('a', { cls: 'btn sm' + (active ? '' : ' primary'), href: '/buy?macro=1' }, until ? '연장 구매' : '구매')])
      ]));
      setTimeout(function () { var i = $('i', bar); if (i) i.style.width = pct + '%'; }, 30);

      var list = Array.isArray(ME.rooms_list) ? ME.rooms_list : [];
      ROOM_PRODUCTS.forEach(function (k) {
        var n = 0, attn = 0, pend = 0;
        list.forEach(function (v) {
          if (!v) return;
          var has = !!(v.products && v.products[k]);
          if (has) {
            n++;
            if (v.display === 'error' || (k === 'roombot' && v.display === 'waiting')) attn++;
          }
          if (v.pending_products && v.pending_products[k]) pend++;
        });
        mount.appendChild(el('div', { cls: 'feat-row', 'data-prod': k }, [
          el('div', { cls: 'r1' }, [
            el('h3', { text: featName(k) }),
            n ? el('span', { cls: 'chip ok', text: '방 ' + n + '개' }) : el('span', { cls: 'chip', text: '미구매' }),
            attn ? el('span', { cls: 'chip warn', text: '확인 필요한 방 ' + attn + '개' }) : null,
            pend ? el('span', { cls: 'chip info', text: '입금 대기 ' + pend + '개' }) : null
          ]),
          el('div', { cls: 'btn-row' }, [
            n || pend ? el('a', { cls: 'btn sm', href: '/panel#rooms' }, [icon('i-link', 14), '내 방 보기']) : null,
            el('a', { cls: 'btn sm' + (n ? '' : ' primary'), href: '/buy?p=' + k }, [icon('i-plus', 14), n ? '다른 방에도 구매' : '구매'])
          ])
        ]));
      });
      var lr = ts(ME.legacy_room_until);
      if (lr > now) {
        mount.appendChild(noteEl('dim', ['예전 키로 쓰던 입장·퇴장 기록 등은 ' + dateKr(lr) + '까지 패널에서 계속 쓸 수 있습니다.']));
      }
    }

    /* ── 구매 내역 ─────────────────────────────────── */
    function loadOrders() {
      var mount = $('#accOrders');
      if (!mount) return Promise.resolve();
      return api('/api/my/orders').then(function (res) {
        renderOrders(Array.isArray(res.orders) ? res.orders : []);
      }, function (e) {
        if (e.status === 401) { toLogin(); return; }
        clear(mount);
        mount.appendChild(el('p', { cls: 'err', text: e.message }));
      });
    }

    function renderOrders(list) {
      var mount = $('#accOrders');
      clear(mount);
      if (!list.length) { mount.appendChild(el('p', { cls: 'empty-t', text: '구매 내역이 없습니다.' })); return; }
      list.forEach(function (o) {
        var st = STATUS_MEMBER[o.status] || { kr: str(o.status), cls: '' };
        var chipT = (o.status === 'canceled' && o.auto_canceled) ? '자동 취소됨' : st.kr;
        var href = str(o.url) ? relUrl(o.url) : orderUrl(o.id);
        var row = el('div', { cls: 'lrow orow' }, [
          el('a', { cls: 'lrow-l', href: href, 'aria-label': '주문 ' + o.id + ' 열기' }, [
            el('span', { cls: 't1' }, [el('span', { cls: 'mono', text: str(o.id) }), el('span', { cls: 'chip ' + st.cls, text: chipT })]),
            el('span', { cls: 't2', text: itemsSummary(o.items) })
          ]),
          el('div', { cls: 'lrow-r' }, [
            el('span', { cls: 'o-amt' }, [el('span', { cls: 'mono' }, wonKids(o.amount)), el('span', { cls: 't2 mono', text: dateKr(o.created_at) })]),
            o.can_cancel ? el('button', { type: 'button', cls: 'btn sm danger', 'data-cancel': str(o.id) }, '주문 취소') : null
          ])
        ]);
        var cb = row.querySelector('[data-cancel]');
        if (cb) cb.addEventListener('click', function () {
          inlineConfirm(row, CANCEL_WARN, '주문 취소', function () {
            return api('/api/my/orders/cancel', { method: 'POST', body: { id: o.id } }).then(function () {
              toast('주문을 취소했습니다', 'ok');
              loadOrders();
              loadMe(false);
            });
          });
        });
        mount.appendChild(row);
      });
    }

    /* 서버가 준 주문 주소(절대)를 같은 사이트 경로로 */
    function relUrl(u) {
      try {
        var x = new URL(u, location.origin);
        return x.pathname + x.search;
      } catch (e) { return '/order'; }
    }

    /* ── 로그인 기기 ───────────────────────────────── */
    function loadSessions() {
      var mount = $('#accSessions');
      if (!mount) return Promise.resolve();
      return api('/api/auth/sessions').then(function (res) {
        renderSessions(Array.isArray(res.sessions) ? res.sessions : []);
      }, function (e) {
        if (e.status === 401) { toLogin(); return; }
        clear(mount);
        mount.appendChild(el('p', { cls: 'err', text: e.message }));
      });
    }

    function renderSessions(list) {
      var mount = $('#accSessions');
      clear(mount);
      list.forEach(function (s) {
        var row = el('div', { cls: 'lrow' }, [
          el('div', { cls: 'lrow-l' }, [
            el('span', { cls: 't1' }, [
              el('span', { text: str(s.device) || '알 수 없는 기기' }),
              s.current ? el('span', { cls: 'tag line', text: '지금 이 기기' }) : null,
              s.method === 'google' ? el('span', { cls: 'tag', text: 'Google 로그인' }) : null
            ]),
            el('span', { cls: 't2' }, ['마지막 사용 ', el('span', { cls: 'mono', text: dateKr(s.last_seen_at, true) })])
          ]),
          el('div', { cls: 'lrow-r' }, [
            s.current ? null : el('button', { type: 'button', cls: 'btn sm', 'data-revoke': str(s.sid) }, [icon('i-logout', 14), '로그아웃'])
          ])
        ]);
        var b = row.querySelector('[data-revoke]');
        if (b) b.addEventListener('click', function () {
          inlineConfirm(row, '이 기기를 로그아웃합니다.', '로그아웃', function () {
            return api('/api/auth/sessions/revoke', { method: 'POST', body: { sid: s.sid } }).then(function () {
              toast('기기를 로그아웃했습니다', 'ok');
              loadSessions();
            });
          });
        });
        mount.appendChild(row);
      });
      var others = list.filter(function (s) { return !s.current; }).length;
      var allHost = el('div', { cls: 'lrow-foot' });
      var all = el('button', { type: 'button', cls: 'btn sm', disabled: others ? null : true }, '다른 기기 모두 로그아웃');
      all.addEventListener('click', function () {
        inlineConfirm(allHost, '지금 이 기기만 남기고 모두 로그아웃합니다.', '로그아웃', function () {
          return api('/api/auth/logout-all', { method: 'POST', body: {} }).then(function (res) {
            toast('다른 기기 ' + (num(res && res.ended) || 0) + '대를 로그아웃했습니다', 'ok');
            loadSessions();
          });
        });
      });
      allHost.appendChild(el('div', { cls: 'btn-row' }, [all]));
      mount.appendChild(allHost);
    }

    /* ── Google 계정 ───────────────────────────────── */
    function renderGoogle() {
      var card = $('#acc-google'), mount = $('#accGoogle');
      if (!card || !mount) return;
      card.hidden = !(SITE && SITE.google);
      if (card.hidden) return;
      clear(mount);
      var m = ME.member || {};
      if (!m.google_linked) {
        mount.appendChild(el('p', { cls: 'sub small', text: 'Google 계정을 연결해 두면 비밀번호를 잊었을 때 Google 계정으로 로그인해 새 비밀번호를 정할 수 있습니다.' }));
        var a = $('#googleLinkTpl');
        var link = a ? a.cloneNode(true) : el('a', { cls: 'btn', href: '/auth/google/start?mode=link&next=%2Faccount' }, '연결');
        link.removeAttribute('id');
        link.hidden = false;
        mount.appendChild(el('div', { cls: 'btn-row' }, [link]));
        return;
      }
      var host = el('div', { cls: 'g-host' });
      var unl = el('button', { type: 'button', cls: 'btn sm' }, [icon('i-unlink', 14), '연결 해제']);
      host.appendChild(el('div', { cls: 'lrow first' }, [
        el('div', { cls: 'lrow-l' }, [el('span', { cls: 't1' }, [el('span', { cls: 'mono', text: str(m.google_email_masked) || 'Google 계정' }), el('span', { cls: 'tag line', text: '연결됨' })])]),
        el('div', { cls: 'lrow-r' }, [unl])
      ]));
      unl.addEventListener('click', function () {
        var old = host.querySelector('.unlink');
        if (old) { old.parentNode.removeChild(old); return; }
        var pw = el('input', { type: 'password', id: 'gUnlinkPw', autocomplete: 'current-password', maxlength: '128' });
        var errP = el('p', { cls: 'err', id: 'err-gunlink', role: 'alert', hidden: true });
        var go = el('button', { type: 'submit', cls: 'btn sm danger solid' }, [el('span', { cls: 'spin' }), el('span', { cls: 'lbl-idle', text: '연결 해제' })]);
        var cancel = el('button', { type: 'button', cls: 'btn sm ghost' }, '닫기');
        var f = el('form', { cls: 'unlink confirm', novalidate: true }, [
          el('div', { cls: 'fld', id: 'fld-gunlink' }, [el('label', { for: 'gUnlinkPw', text: '현재 비밀번호' }), pw, errP]),
          el('div', { cls: 'confirm-a' }, [go, cancel])
        ]);
        cancel.addEventListener('click', function () { if (f.parentNode) f.parentNode.removeChild(f); });
        var busy = false;
        f.addEventListener('submit', function (ev) {
          ev.preventDefault();
          if (busy) return;
          fieldErr('gunlink', '');
          if (!pw.value) { fieldErr('gunlink', '비밀번호를 입력해 주세요'); pw.focus(); return; }
          busy = true;
          setBusy(go, true);
          api('/api/auth/google/unlink', { method: 'POST', body: { password: pw.value } }).then(function () {
            toast('Google 계정 연결을 해제했습니다', 'ok');
            loadMe(false).then(googleNudge);
          }, function (e) {
            busy = false;
            setBusy(go, false);
            fieldErr('gunlink', e.message);
            if (e.code === 'not_linked') loadMe(false);
          });
        });
        host.appendChild(f);
        pw.focus();
      });
      mount.appendChild(host);
    }

    /* ── 비밀번호 변경 ─────────────────────────────── */
    var resetOpen = false;
    function renderPassword() {
      resetOpen = !!ME.password_reset_open;
      var cur = $('#fld-cur'), rec = $('#pwRecover');
      if (cur) cur.hidden = resetOpen;
      if (rec) rec.hidden = !resetOpen;
    }

    var pwForm = $('#pwForm');
    if (pwForm) {
      var curIn = $('#pwCur'), newIn = $('#pwNew'), new2In = $('#pwNew2'), pwBtn = $('#pwBtn');
      var pwBusy = false;
      [['cur', curIn], ['new', newIn], ['new2', new2In]].forEach(function (x) {
        x[1].addEventListener('input', function () { fieldErr(x[0], ''); fieldErr('pw', ''); });
      });
      pwForm.addEventListener('submit', function (ev) {
        ev.preventDefault();
        if (pwBusy) return;
        ['cur', 'new', 'new2', 'pw'].forEach(function (k) { fieldErr(k, ''); });
        var cur = curIn.value || '', nx = newIn.value || '', nx2 = new2In.value || '';
        var bad = null;
        if (!resetOpen && !cur) { fieldErr('cur', '현재 비밀번호를 입력해 주세요'); bad = curIn; }
        if (!nx) { fieldErr('new', '새 비밀번호를 입력해 주세요'); bad = bad || newIn; }
        else if (nx.length < 8) { fieldErr('new', '비밀번호는 8자 이상 입력해 주세요'); bad = bad || newIn; }
        if (nx && nx2 !== nx) { fieldErr('new2', '비밀번호가 일치하지 않습니다'); bad = bad || new2In; }
        if (bad) { bad.focus(); return; }
        pwBusy = true;
        setBusy(pwBtn, true);
        var body = (resetOpen && !cur) ? { next: nx } : { current: cur, next: nx };
        api('/api/auth/password', { method: 'POST', body: body }).then(function () {
          pwBusy = false;
          setBusy(pwBtn, false);
          curIn.value = ''; newIn.value = ''; new2In.value = '';
          toast('비밀번호를 변경했습니다. 다른 기기는 로그아웃되었습니다', 'ok');
          loadMe(false);
          loadSessions();
        }, function (e) {
          pwBusy = false;
          setBusy(pwBtn, false);
          if (e.code === 'bad_password') { fieldErr('new', e.message); newIn.focus(); }
          else if (e.code === 'wrong_current') { fieldErr('cur', e.message); curIn.focus(); }
          else if (e.code === 'reauth_needed') {
            resetOpen = false;
            $('#fld-cur').hidden = false;
            $('#pwRecover').hidden = true;
            fieldErr('pw', e.message);
            curIn.focus();
          } else if (e.status === 401) { toLogin(); }
          else fieldErr('pw', e.message);
        });
      });
    }

    /* ── 로그아웃 ──────────────────────────────────── */
    var out = $('#logoutBtn');
    if (out) out.addEventListener('click', function () {
      setBusy(out, true);
      api('/api/auth/logout', { method: 'POST', body: {} }).then(function () {
        supportReboot();
        location.href = '/';
      }, function (e) {
        setBusy(out, false);
        toast(e.message, 'bad');
      });
    });
  }

  /* ══════════════════ 11. 실시간 상담 (/support) — 6.1 · 6.10 6 ══════════════════ */

  function pageSupport() {
    var ctx = str(qs().get('ctx')).replace(/[\u0000-\u001F\u007F]/g, ' ').slice(0, 300);
    var body = $('#supportBody');
    if (!body) return;
    var sup = window.kbSupport;
    var ready = sup && typeof sup.ready === 'function' ? sup.ready() : null;
    Promise.resolve(ready || 'off').then(function (stt) {
      clear(body);
      if (stt === 'chat') {
        body.appendChild(el('p', { cls: 'sub small', text: '상담 창이 열리지 않으면 아래 버튼을 눌러 주세요.' }));
        if (ctx) body.appendChild(el('dl', { cls: 'kv' }, [el('div', { cls: 'r' }, [el('dt', { text: '함께 보낼 내용' }), el('dd', { text: ctx })])]));
        body.appendChild(el('div', { cls: 'btn-row' }, [supportBtn('문의하기', ctx, 'btn primary')]));
        if (sup && sup.open) sup.open(ctx);
        return;
      }
      if (stt === 'contact') {
        return siteInfo().then(function (s) {
          body.appendChild(el('p', { cls: 'sub small', text: '지금은 상담 창 대신 아래 연락처로 문의해 주세요. 주문번호나 방 링크를 함께 보내 주시면 더 빨리 확인할 수 있습니다.' }));
          body.appendChild(el('div', { cls: 'note' }, [el('span', { cls: 'ic', 'aria-hidden': 'true', text: 'i' }),
            el('span', { cls: 'contact-t', text: str(s.contact) })]));
          if (ctx) body.appendChild(el('dl', { cls: 'kv' }, [el('div', { cls: 'r' }, [el('dt', { text: '함께 보낼 내용' }), el('dd', { text: ctx })])]));
        });
      }
      body.appendChild(noteEl('warn', ['지금은 상담 창을 열 수 없습니다. 잠시 뒤 다시 시도해 주세요.']));
    });
  }

  /* ══════════════════ 12. 부팅 ══════════════════ */

  function boot() {
    /* 헤더 현재 위치 표시 */
    var page = document.body.getAttribute('data-page') || '';
    $$('nav.top-nav a').forEach(function (a) {
      if (a.getAttribute('data-nav') === page) a.setAttribute('aria-current', 'page');
    });
    siteInfo().then(applyAuth);

    try {
      initNav();
      if (page === 'buy')     pageBuy();
      if (page === 'order')   pageOrder();
      if (page === 'login')   pageLogin();
      if (page === 'signup')  pageSignup();
      if (page === 'account') pageAccount();
      if (page === 'support') pageSupport();
    } catch (e) {
      /* 에러를 삼키지 않는다 — 사용자한테 보여준다 */
      console.error(e);
      toast(MSG_BROKEN, 'bad');
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();

  /* 잡히지 않은 오류도 조용히 넘기지 않는다. 단 다른 출처 스크립트(채널톡 SDK 등)의 오류는 무시한다(6.10 9) */
  window.addEventListener('error', function (ev) {
    if (!ev || !ev.message) return;
    if (/^Script error\.?$/i.test(String(ev.message))) return;
    var f = String(ev.filename || '');
    if (f && f.indexOf(location.origin + '/') !== 0) return;
    if (/channel\.io/i.test(f)) return;
    toast(MSG_BROKEN, 'bad');
  });
  window.addEventListener('unhandledrejection', function (ev) {
    var r = ev && ev.reason;
    var stack = String((r && r.stack) || '') + ' ' + String((r && r.message) || r || '');
    if (/channel\.io|ch-plugin/i.test(stack)) return;
    /* 서버가 준 한국어 문구면 그대로, 아니면(영문 예외 등) 손님용 안내로 */
    var m = String((r && r.message) || '');
    toast(/[\uAC00-\uD7A3]/.test(m) ? m : MSG_BROKEN, 'bad');
  });
})();
