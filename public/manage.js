/* ───────────────────────────────────────────────────────────────
   K bot — 판매 관리 화면 (/manage)
   routes/admin.js 의 /admin/* 와 공개 /api/price 만 부른다. 요청/응답 모양은 docs/ACCOUNTS_V1.md 3.5 가 기준이다.
     요약     GET  /admin/stats            (로그인 확인도 이걸로 한다)
     주문     GET  /admin/orders  POST /admin/order-approve {id, key?, skip_conflicts?}  /admin/order-cancel
     입금     GET  /admin/deposits  POST /admin/deposit-match {deposit_id, order_id, skip_conflicts?}  /admin/deposit-ignore
     회원     GET  /admin/members?q=  /admin/member?id=
              POST /admin/member-grant · member-block · member-logout · member-pwreset · license-reassign
     봇       GET  /admin/bots   POST /admin/bot-register/begin|confirm|cancel · bot-update · bot-remove ·
                                    bot-open-profile {device_id, li?|refresh?|url?}
     방       GET  /admin/rooms?display=&q=&bot=  /admin/room?id=  /admin/room-blocks
              POST /admin/room-grant · room-retry · room-move · room-remove · room-rebind · room-transfer ·
                   room-products · room-block · room-unblock · room-release · room-profile {id, how:switch|rejoin}
     키(예전) GET  /admin/list  /admin/license   POST /admin/create · grant · revoke-feature · revoke · block · delete
     기록     GET  /admin/audit?kind=&key=&member=

   인증: 헤더 x-admin-password. 비밀번호는 sessionStorage 에만 둔다(탭을 닫으면 사라짐).
         401 이면 지우고 로그인 화면으로, 503 admin_disabled 면 서버 설정 문제를 그대로 보여준다.
         429 는 두 종류다 — 비밀번호 연속 실패 차단(too_many_attempts)과 일반 과다요청(rate_limited).
   상품 이름·가격은 /api/price 가 단일 소스다(lib/pricing.js). 이 파일에 상품 상수를 두지 않는다.
   서버 문자열은 전부 textContent 로만 넣는다. 이 파일에 innerHTML 은 없다. 외부 라이브러리 안 씀.
   브라우저 대화상자(alert·confirm·prompt)는 쓰지 않는다 — 확인은 <dialog> 안에서 한다.
   ─────────────────────────────────────────────────────────────── */
(function () {
  'use strict';

  /* ══════════════════ 0. 고정 값 ══════════════════ */

  // 예전 라이선스 키의 기간(lib/keys.js PLANS). 회원 상품에는 쓰지 않는다.
  var SALE_PLAN = 'month';
  var PLANS = { month: { days: 30, label: '1개월' }, quarter: { days: 90, label: '3개월' }, year: { days: 365, label: '1년' } };
  var DAY = 86400000;

  var DEP_ST = {
    unmatched: { kr: '주문 못 찾음', cls: 'warn' },
    ambiguous: { kr: '확인 필요', cls: 'bad' },
    matched:   { kr: '연결됨',    cls: 'ok' },
    duplicate: { kr: '중복 알림', cls: '' },
    ignored:   { kr: '무시',      cls: '' }
  };
  // 0.1 방 상태 5단계 + 설치 해제·취소 → 사이트 chip 색
  var ROOM_CLS = { pending: 'warn', joining: 'warn', waiting: 'warn', active: 'ok', error: 'bad', canceled: '', removed: '' };
  // 주문 적용에서 뺀 방 줄의 사유(entitle.applyOrder conflicts[].why)
  var WHY_LABEL = {
    room_taken: '다른 회원이 먼저 결제', duplicate: '이 회원에게 이미 있는 방', blocked: '차단한 방',
    removed: '설치 해제된 방', other_member: '다른 회원의 방', missing: '방 정보 없음'
  };
  var LEAVE_WHY = { move: '다른 봇으로 이동', remove: '설치 해제', rebind: '링크 바꾸기', block: '방 차단' };
  // lib/audit.js KINDS + 단종된 사용자앱이 남긴 옛 종류(표에 그대로 남아 있다)
  var KIND_LABEL = {
    order: '주문',
    member: '회원',
    install: '방 설치',
    bot: 'K bot 계정',
    settings: '운영 한도',
    member_lockout: '로그인 잠금',
    activate: '사용 시작',
    revoked: '회수 · 차단 · 삭제',
    bad_deposit_token: '입금 알림 코드 오류',
    bad_admin_pw: '관리자 로그인 실패',
    mismatch: '기기 불일치',
    takeover: '기기정보 변경',
    bad_sig: '앱 서명 불일치',
    tamper: '앱 변조 감지',
    expired: '기간 만료',
    reset: '기기 초기화'
  };
  var KIND_BASE = ['order', 'member', 'install', 'bot', 'settings', 'member_lockout', 'activate', 'revoked', 'bad_deposit_token', 'bad_admin_pw'];
  var KIND_LEGACY = ['mismatch', 'takeover', 'bad_sig', 'tamper', 'expired', 'reset'];
  var ALERT_KINDS = ['bad_deposit_token', 'bad_admin_pw', 'member_lockout'];   // 서버 alert_kinds 가 오면 그걸로 바꾼다

  var KEY_RE = /^KAKA-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/;
  var PW_STORE = 'kb_manage_pw';
  var POLL_MS = 30000;         // 요약 숫자 갱신 간격 (관리자 버킷 분당 120회 — 여유가 크다)
  var KEY_PAGE = 50;
  var LIST_LIMIT = 200;

  /* ── 상품표(/api/price). 상품 이름·가격·단위는 여기서만 읽는다. */
  var PRICE = { ids: [], byId: {}, loaded: false, loading: null };

  function loadPrice() {
    if (PRICE.loaded) return Promise.resolve(PRICE);
    if (PRICE.loading) return PRICE.loading;
    var p;
    try { p = fetch('/api/price', { cache: 'no-store', credentials: 'same-origin', headers: { 'Accept': 'application/json' } }); }
    catch (e) { p = Promise.reject(e); }
    PRICE.loading = p.then(function (res) { return res.json(); }).then(function (j) {
      var list = j && Array.isArray(j.products) ? j.products : [];
      if (!list.length) throw new Error('empty');
      PRICE.ids = [];
      PRICE.byId = {};
      list.forEach(function (x) { if (x && x.id) { PRICE.ids.push(String(x.id)); PRICE.byId[x.id] = x; } });
      PRICE.loaded = true;
      PRICE.loading = null;
      renderProdSub();
      return PRICE;
    }).catch(function () { PRICE.loading = null; return PRICE; });
    return PRICE.loading;
  }
  function plabel(id) { return PRICE.byId[id] && PRICE.byId[id].label ? String(PRICE.byId[id].label) : String(id || ''); }
  function roomProductIds() { return PRICE.ids.filter(function (id) { return PRICE.byId[id].unit === 'room'; }); }
  // 예전 키의 기능 목록 = 상품 id 전부(lib/features.js ALL 과 같은 이름)
  function featIds() { return PRICE.ids.slice(); }

  // "상품: 카카오톡 매크로 1개월 15,000원 · 방 관리봇 방마다 10,000원 · …" (6.12)
  function renderProdSub() {
    var n = document.getElementById('prodSub');
    if (!n || !PRICE.ids.length) return;
    var parts = PRICE.ids.map(function (id) {
      var p = PRICE.byId[id];
      var unit = p.unit === 'month' ? '1개월' : (p.unit === 'room' ? '방마다' : String(p.unit || ''));
      return plabel(id) + ' ' + (unit ? unit + ' ' : '') + won(p.price);
    });
    n.textContent = '상품: ' + parts.join(' · ') + '. 직접 승인하거나 입금을 연결한 주문도 자동 입금 확인과 똑같이 처리됩니다.';
  }

  /* ══════════════════ 1. 유틸 ══════════════════ */

  function $(sel, root) { return (root || document).querySelector(sel); }
  function $$(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }

  // DOM 생성. 글자는 text 로만 넣는다 (서버 값은 절대 HTML 로 해석하지 않는다).
  function el(tag, attrs, kids) {
    var n = document.createElement(tag), k;
    if (attrs) for (k in attrs) {
      if (!Object.prototype.hasOwnProperty.call(attrs, k)) continue;
      var v = attrs[k];
      if (v === null || v === undefined || v === false) continue;
      if (k === 'text') n.textContent = String(v);
      else if (k === 'cls') n.className = v;
      else if (k === 'value') n.value = String(v);
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
  function clear(node) { while (node && node.firstChild) node.removeChild(node.firstChild); }
  function icon(id, size) {
    var NS = 'http://www.w3.org/2000/svg';
    var s = document.createElementNS(NS, 'svg');
    s.setAttribute('width', String(size || 14));
    s.setAttribute('height', String(size || 14));
    s.setAttribute('aria-hidden', 'true');
    var u = document.createElementNS(NS, 'use');
    u.setAttribute('href', '#' + id);
    s.appendChild(u);
    return s;
  }

  function num(v) { var n = Number(v); return v !== null && v !== undefined && v !== '' && isFinite(n) ? n : null; }
  function str(v) { return typeof v === 'string' ? v.trim() : (v === null || v === undefined ? '' : String(v)); }
  function hasKo(s) { return /[가-힣]/.test(String(s || '')); }

  function won(n) {
    var v = num(n);
    if (v === null) return '-';
    return Math.round(v).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',') + '원';
  }
  // 모노 글꼴 칸의 금액: 숫자는 모노, '원' 은 산세리프 (docs/UI_V5.md — 모노에 한글 금지)
  function wonKids(n) {
    var t = won(n);
    if (t.slice(-1) !== '원') return [t];
    return [t.slice(0, -1), el('span', { cls: 'sans', text: '원' })];
  }

  function pad2(n) { return (n < 10 ? '0' : '') + n; }
  function dateKr(ms, withTime, withSec) {
    var t = num(ms);
    if (!t || t <= 0) return '-';
    var d = new Date(t);
    var s = d.getFullYear() + '.' + pad2(d.getMonth() + 1) + '.' + pad2(d.getDate());
    if (withTime) s += ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes());
    if (withTime && withSec) s += ':' + pad2(d.getSeconds());
    return s;
  }
  function hhmm(ms) { var d = new Date(num(ms) || 0); return pad2(d.getHours()) + ':' + pad2(d.getMinutes()); }
  function daysCeil(ms) { return Math.ceil(ms / DAY); }
  function shortLink(url) { return String(url || '').replace(/^https?:\/\//i, ''); }

  // 키 입력 정리: 영숫자만 남기고 4글자마다 하이픈 (KAKA-XXXX-XXXX-XXXX). public/app.js 와 같은 규칙.
  function normKey(s) {
    var v = String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 16);
    if (!v) return '';
    return v.match(/.{1,4}/g).join('-');
  }
  // lib/keys.js normOrderId 와 같은 규칙
  function normOrderId(s) {
    return String(s || '').trim().toUpperCase().replace(/[^A-Z0-9-]/g, '').slice(0, 32);
  }

  function planLabel(plan, durMs) {
    if (plan === 'custom') { var d = Math.round((num(durMs) || 0) / DAY); return d ? d + '일' : '직접 입력'; }
    return PLANS[plan] ? PLANS[plan].label : (plan ? String(plan) : '-');
  }
  function planDays(plan) { return PLANS[plan] ? PLANS[plan].days : 0; }
  function featLabel(id) { return plabel(id); }
  function hasAllFeats(list) {
    var arr = Array.isArray(list) ? list : [];
    var all = featIds();
    if (!all.length) return false;
    for (var i = 0; i < all.length; i++) if (arr.indexOf(all[i]) < 0) return false;
    return true;
  }
  function featText(list) {
    var arr = Array.isArray(list) ? list : [];
    if (!arr.length) return '기능 없음';
    if (hasAllFeats(arr)) return '기능 ' + arr.length + '종 전부';
    return arr.map(featLabel).join(' · ');
  }
  // 예전 키 주문의 상품 표시: "예전 키 1개월 (30일)"
  function legacyProductText(plan) {
    var d = planDays(plan);
    return '예전 키 ' + planLabel(plan) + (d ? ' (' + d + '일)' : '');
  }

  function chip(text, cls) { return el('span', { cls: 'chip' + (cls ? ' ' + cls : ''), text: text }); }
  function tag(text, cls) { return el('span', { cls: 'tag' + (cls ? ' ' + cls : ''), text: text }); }

  // 버튼. .spin/.lbl-idle 구조는 style.css 의 .btn.busy 와 맞춘다.
  function btn(label, cls, onClick, extra) {
    var b = el('button', { type: 'button', cls: 'btn' + (cls ? ' ' + cls : '') }, [
      el('span', { cls: 'spin', 'aria-hidden': 'true' }),
      el('span', { cls: 'lbl-idle', text: label })
    ]);
    if (extra) for (var k in extra) if (Object.prototype.hasOwnProperty.call(extra, k)) b.setAttribute(k, extra[k]);
    if (onClick) b.addEventListener('click', onClick);
    return b;
  }
  function busyBtn(b, on) {
    if (!b) return;
    b.classList.toggle('busy', !!on);
    b.disabled = !!on;
    if (on) b.setAttribute('aria-busy', 'true'); else b.removeAttribute('aria-busy');
  }
  // 목록 안의 밑줄 링크 버튼(회원 아이디 → 회원 상세 등)
  function inl(text, onClick, label) {
    return el('button', { type: 'button', cls: 'mg-inl', text: text, 'aria-label': label || null,
      onclick: function (e) { e.stopPropagation(); onClick(); } });
  }

  /* ── 토스트 (style.css #toast) */
  var toastT = null;
  function toast(msg, kind) {
    var t = $('#toast');
    if (!t) return;
    t.textContent = String(msg);
    t.setAttribute('data-kind', kind || '');
    t.setAttribute('data-on', '1');
    if (toastT) clearTimeout(toastT);
    toastT = setTimeout(function () { t.setAttribute('data-on', '0'); }, 2800);
  }

  /* ── 복사 (클립보드 API 가 안 되면 임시 textarea) */
  function copy(text, what) {
    var s = String(text || '');
    if (!s) return;
    var done = function () { toast((what ? what + ' ' : '') + '복사되었습니다', 'ok'); };
    var fallback = function () {
      try {
        var ta = el('textarea', { 'aria-hidden': 'true', readonly: true });
        ta.value = s;
        ta.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0';
        document.body.appendChild(ta);
        ta.select(); ta.setSelectionRange(0, s.length);
        var ok = document.execCommand('copy');
        document.body.removeChild(ta);
        if (ok) done(); else toast('복사하지 못했습니다. 직접 선택해 복사해 주세요', 'bad');
      } catch (e) {
        toast('복사하지 못했습니다. 직접 선택해 복사해 주세요', 'bad');
      }
    };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(s).then(done, fallback);
    else fallback();
  }
  function copyBtn(text, what, label) {
    return btn(label || '복사', 'sm', function (e) { e.stopPropagation(); copy(text, what); });
  }

  /* ══════════════════ 2. 비밀번호 보관 ══════════════════
     sessionStorage 만 쓴다. 막힌 브라우저(시크릿 등)에서는 메모리에만 두고, 새로고침하면 다시 묻는다. */

  var PW = '';
  function loadPw() { try { return sessionStorage.getItem(PW_STORE) || ''; } catch (e) { return ''; } }
  function savePw(p) { try { sessionStorage.setItem(PW_STORE, p); } catch (e) { /* 메모리에만 둔다 */ } }
  function dropPw() { PW = ''; try { sessionStorage.removeItem(PW_STORE); } catch (e) { /* 없음 */ } }

  /* ══════════════════ 3. API ══════════════════
     항상 {ok, status, kind, error, json} 로 돌려준다 (reject 하지 않는다).
     kind: '' | net | auth | disabled | locked | rate | server | bad | fail */

  function api(method, path, body) {
    var init = {
      method: method,
      headers: { 'x-admin-password': PW, 'Accept': 'application/json' },
      cache: 'no-store',
      credentials: 'same-origin'
    };
    if (body !== undefined) {
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    var p;
    try { p = fetch(path, init); } catch (e) { p = Promise.reject(e); }
    return p.then(function (res) {
      return res.text().then(function (txt) {
        var j = null;
        try { j = txt ? JSON.parse(txt) : null; } catch (e) { j = null; }
        return shape(res, j);
      }, function () { return shape(res, null); });
    }, function () {
      return { ok: false, status: 0, kind: 'net', json: {},
               error: '서버에 연결할 수 없습니다. 네트워크 상태를 확인해 주세요' };
    });
  }

  function retryMins(res) {
    var s = num(res && res.headers ? res.headers.get('Retry-After') : null);
    return s && s > 0 ? Math.ceil(s / 60) : 0;
  }

  function shape(res, j) {
    var st = res.status;
    var o = j && typeof j === 'object' ? j : null;
    var out = { ok: false, status: st, kind: '', error: '', json: o || {} };
    if (st === 401) {
      out.kind = 'auth';
      out.error = '비밀번호가 일치하지 않습니다';
      return out;
    }
    if (st === 503 && o && o.error === 'admin_disabled') {
      out.kind = 'disabled';
      out.error = str(o.detail) || '서버에 관리자 비밀번호가 설정되지 않아 관리자 기능을 막았습니다. 서버 환경변수 ADMIN_PASSWORD를 설정한 뒤 다시 배포해 주세요';
      return out;
    }
    if (st === 429) {
      // routes/admin.js guard: {error:'too_many_attempts', detail}
      // server.js 미들웨어: {reason:'rate_limited', error:'비밀번호 입력 실패 …' | '요청이 너무 잦습니다 …'}
      var msg = str(o && o.detail) || (o && hasKo(o.error) ? str(o.error) : '');
      var locked = (o && o.error === 'too_many_attempts') || /비밀번호/.test(msg);
      out.kind = locked ? 'locked' : 'rate';
      if (!msg) {
        var m = retryMins(res);
        msg = locked
          ? '비밀번호 입력 실패 횟수를 넘었습니다.' + (m ? ' ' + m + '분 뒤 다시 시도해 주세요' : ' 잠시 뒤 다시 시도해 주세요')
          : '요청이 너무 잦습니다. 잠시 뒤 다시 시도해 주세요';
      }
      out.error = msg;
      return out;
    }
    if (!o) {
      out.kind = 'bad';
      out.error = st >= 500
        ? '서버가 응답하지 않습니다 (HTTP ' + st + '). 잠시 뒤 다시 시도해 주세요'
        : '응답을 읽지 못했습니다 (HTTP ' + st + ')';
      return out;
    }
    if (st >= 500) {
      out.kind = 'server';
      out.error = hasKo(o.error) ? str(o.error) : '요청을 처리하지 못했습니다. 잠시 뒤 다시 시도해 주세요';
      return out;
    }
    if (o.ok === true && st < 400) { out.ok = true; return out; }
    out.kind = 'fail';
    out.error = hasKo(o.error) ? str(o.error) : '';
    return out;
  }

  function errText(r, fallback) {
    return (r && r.error) || fallback || '요청을 처리하지 못했습니다';
  }

  // 401 / 503(관리자 API 닫힘) 은 어느 화면에서 나와도 로그인 화면으로 돌린다. 처리했으면 true.
  // 비밀번호 연속 실패 차단(429)은 로그아웃시키지 않고 상단에 띄운다 (같은 IP 의 다른 사람이 틀렸을 수도 있다).
  function kicked(r) {
    if (!r || r.ok) return false;
    if (r.kind === 'auth') {
      dropPw();
      showLogin({ err: '비밀번호가 바뀌었거나 일치하지 않습니다. 다시 입력해 주세요' });
      return true;
    }
    if (r.kind === 'disabled') {
      dropPw();
      showLogin({ disabled: r.error });
      return true;
    }
    if (r.kind === 'locked') showLock(r.error);
    return false;
  }

  function showLock(msg) {
    var bar = $('#lockBar');
    if (!bar) return;
    $('#lockBarT').textContent = msg;
    bar.hidden = false;
  }
  function hideLock() { var bar = $('#lockBar'); if (bar) bar.hidden = true; }

  /* ══════════════════ 4. 대화상자 ══════════════════
     <dialog> 를 열 때마다 새로 만들고 닫으면 지운다. 겹쳐 열 수 있다(회원 상세 위에 확인창).
     처리 중(busy)에는 Esc · 닫기 버튼이 안 먹는다. 입력이 있는 창은 바깥 클릭으로 닫지 않는다. */

  var MODALS = [];
  var modalSeq = 0;

  function modal(o) {
    var tid = 'mg-dlg-t-' + (++modalSeq);
    var opener = document.activeElement;
    var dlg = el('dialog', { cls: 'mg-dlg' + (o.wide ? ' wide' : ''), 'aria-labelledby': tid });
    var body = el('div', { cls: 'mg-dlg-b' });
    var err = el('p', { cls: 'mg-dlg-e errt', role: 'alert' });
    var foot = el('div', { cls: 'mg-dlg-f' });
    var xBtn = el('button', { type: 'button', cls: 'btn ghost mg-x', 'aria-label': '닫기' }, icon('i-x', 16));
    dlg.appendChild(el('div', { cls: 'mg-dlg-in' }, [
      el('div', { cls: 'mg-dlg-h' }, [el('h2', { id: tid, text: o.title }), xBtn]),
      body, err, foot
    ]));

    var closed = false;
    var ctl = {
      dlg: dlg,
      body: body,
      busy: false,
      setTitle: function (t) { $('#' + tid, dlg).textContent = t; },
      setBody: function (kids) { clear(body); append(body, kids); body.scrollTop = 0; },
      setActions: function (list) { clear(foot); append(foot, list || []); },
      error: function (msg) { err.textContent = msg || ''; },
      setBusy: function (on, b) { ctl.busy = !!on; busyBtn(b, on); xBtn.disabled = !!on; },
      isOpen: function () { return !closed; },
      close: function () {
        if (closed) return;
        if (dlg.open && typeof dlg.close === 'function' && !dlg.classList.contains('nomodal')) { dlg.close(); return; }
        cleanup();
      }
    };
    function cleanup() {
      if (closed) return;
      closed = true;
      var i = MODALS.indexOf(ctl);
      if (i >= 0) MODALS.splice(i, 1);
      if (dlg.parentNode) dlg.parentNode.removeChild(dlg);
      if (typeof o.onClose === 'function') o.onClose();
      if (opener && opener.focus && document.contains(opener)) { try { opener.focus(); } catch (e) { /* 없음 */ } }
    }
    xBtn.addEventListener('click', function () { if (!ctl.busy) ctl.close(); });
    dlg.addEventListener('cancel', function (e) { if (ctl.busy) e.preventDefault(); });
    dlg.addEventListener('close', cleanup);
    if (o.light) dlg.addEventListener('click', function (e) { if (e.target === dlg && !ctl.busy) ctl.close(); });
    dlg.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && dlg.classList.contains('nomodal') && !ctl.busy) ctl.close();
    });

    if (o.body) append(body, o.body);
    if (o.actions) append(foot, o.actions);
    document.body.appendChild(dlg);
    MODALS.push(ctl);
    if (typeof dlg.showModal === 'function') {
      try { dlg.showModal(); } catch (e) { dlg.setAttribute('open', ''); dlg.classList.add('nomodal'); }
    } else {
      dlg.setAttribute('open', '');
      dlg.classList.add('nomodal');
    }
    var af = $('[data-autofocus]', dlg);
    if (af) { try { af.focus(); } catch (e) { /* 없음 */ } }
    return ctl;
  }

  function closeAllModals() {
    MODALS.slice().forEach(function (m) { m.busy = false; m.close(); });
  }

  // 확인 → 실행 → 결과. 실패하면 창을 닫지 않고 그 자리에 사유를 띄운다.
  // o = { title, body, ok, danger, run: () => Promise<r>, check?: () => 오류문구|'', done?: (r) => void,
  //       failMsg?, onFail?: (r, m) => true(직접 처리함) }
  function confirmAct(o) {
    var okBtn = btn(o.ok || '확인', o.danger ? 'danger solid' : 'primary');
    var m = modal({ title: o.title, body: o.body, wide: o.wide });
    m.setActions([btn('닫기', 'ghost', function () { if (!m.busy) m.close(); }), okBtn]);
    okBtn.addEventListener('click', function () {
      if (m.busy) return;
      var bad = o.check ? o.check() : '';
      if (bad) { m.error(bad); return; }
      m.error('');
      m.setBusy(true, okBtn);
      Promise.resolve(o.run()).then(function (r) {
        m.setBusy(false, okBtn);
        if (kicked(r)) return;
        if (!r || !r.ok) {
          if (o.onFail && o.onFail(r, m)) return;
          m.error(errText(r, o.failMsg));
          return;
        }
        m.close();
        if (o.done) o.done(r);
      });
    });
    return m;
  }

  function para(text, cls) { return el('p', { cls: 'mg-p' + (cls ? ' ' + cls : ''), text: text }); }
  function note(text, warn) {
    return el('div', { cls: 'note' + (warn ? ' warn' : ' dim') }, [
      el('span', { cls: 'ic', 'aria-hidden': 'true', text: warn ? '!' : 'i' }),
      el('span', null, text)
    ]);
  }
  function kv(rows) {
    return el('dl', { cls: 'kv' }, rows.filter(Boolean).map(function (r) {
      return el('div', { cls: 'r' }, [el('dt', { text: r[0] }), el('dd', { cls: r[2] || null }, r[1])]);
    }));
  }
  function field(label, input, hint, id) {
    if (id) input.id = id;
    return el('div', { cls: 'fld' }, [
      el('label', { for: input.id || null, text: label }),
      input,
      hint ? el('p', { cls: 'hint', text: hint }) : null
    ]);
  }
  function sec(title, kids) {
    return el('section', { cls: 'mg-sec' }, [el('h3', { cls: 'mg-h3', text: title }), kids]);
  }
  function textInput(o) {
    o = o || {};
    var n = el('input', { cls: 'inp' + (o.mono ? ' mono' : ''), type: o.type || 'text', autocomplete: o.autocomplete || 'off',
                          spellcheck: 'false', autocapitalize: 'off', maxlength: String(o.max || 200),
                          placeholder: o.placeholder || null, inputmode: o.inputmode || null,
                          min: o.min || null, step: o.step || null, value: o.value === undefined ? null : o.value });
    if (o.maxv) n.setAttribute('max', String(o.maxv));
    if (o.autofocus) n.setAttribute('data-autofocus', '');
    return n;
  }
  function checkRow(label, sub, checked) {
    var input = el('input', { type: 'checkbox', checked: !!checked });
    var node = el('label', { cls: 'chk' }, [
      input,
      el('span', { cls: 'box', 'aria-hidden': 'true' }),
      el('span', { cls: 't' }, [el('span', { text: label }), sub ? el('span', { cls: 'mg-meta', text: sub }) : null])
    ]);
    return { node: node, input: input };
  }
  function empty(text, bad, sm) { return el('div', { cls: 'mg-empty' + (bad ? ' bad' : '') + (sm ? ' sm' : ''), text: text }); }

  // 기간 선택: 30일(예전 판매 상품과 같음) / 직접 입력(custom, 관리자 전용).  → { get(): {plan, days}|{error} }
  function periodPicker(name) {
    var rMonth = el('input', { type: 'radio', name: name, value: 'month', checked: true });
    var rCustom = el('input', { type: 'radio', name: name, value: 'custom' });
    var days = el('input', { cls: 'inp mono', type: 'number', inputmode: 'numeric', min: '1', max: '3650', step: '1',
                             value: '30', disabled: true, 'aria-label': '일수' });
    function sync() { days.disabled = !rCustom.checked; if (rCustom.checked) { try { days.focus(); days.select(); } catch (e) { /* 없음 */ } } }
    rMonth.addEventListener('change', sync);
    rCustom.addEventListener('change', sync);
    var node = el('div', { cls: 'mg-sec' }, [
      el('span', { cls: 'lb', text: '기간' }),
      el('div', { cls: 'mg-numrow' }, [
        el('div', { cls: 'seg', role: 'radiogroup', 'aria-label': '기간' }, [
          el('label', null, [rMonth, el('span', null, ['30일', el('em', { text: '1개월' })])]),
          el('label', null, [rCustom, el('span', { text: '직접 입력' })])
        ]),
        el('span', { cls: 'mg-numrow' }, [days, el('span', { cls: 'dim tiny', text: '일' })])
      ])
    ]);
    return {
      node: node,
      onChange: function (fn) { [rMonth, rCustom, days].forEach(function (x) { x.addEventListener('input', fn); x.addEventListener('change', fn); }); },
      get: function () {
        if (!rCustom.checked) return { plan: SALE_PLAN, days: planDays(SALE_PLAN) };
        var d = Math.floor(Number(days.value));
        if (!isFinite(d) || d < 1 || d > 3650) return { error: '일수는 1~3650 사이로 입력해 주세요' };
        if (d === planDays(SALE_PLAN)) return { plan: SALE_PLAN, days: d };
        return { plan: 'custom', days: d };
      }
    };
  }

  function sleep(ms) { return new Promise(function (resolve) { setTimeout(resolve, ms); }); }

  /* ══════════════════ 5. 로그인 / 화면 전환 ══════════════════ */

  var STARTED = false;

  function showLogin(o) {
    o = o || {};
    stopPoll();
    closeAllModals();
    STARTED = false;
    STATS = null;
    $('#app').hidden = true;
    $('#login').hidden = false;
    document.title = '판매 관리 · K bot';
    var noteBox = $('#loginNote');
    noteBox.hidden = !o.disabled;
    $('#loginNoteT').textContent = o.disabled || '';
    $('#loginErr').textContent = o.err || '';
    $('#loginInfo').textContent = o.info || '';
    busyBtn($('#loginBtn'), false);
    var pw = $('#pw');
    pw.value = '';
    setTimeout(function () { try { pw.focus(); } catch (e) { /* 없음 */ } }, 0);
  }

  function onLoginSubmit(e) {
    e.preventDefault();
    var pwIn = $('#pw');
    var given = pwIn.value;
    var errBox = $('#loginErr');
    errBox.textContent = '';
    $('#loginInfo').textContent = '';
    if (!given) { errBox.textContent = '비밀번호를 입력해 주세요'; pwIn.focus(); return; }
    // HTTP 헤더로 보낼 수 없는 글자(한글 등)는 서버 비밀번호에도 쓸 수 없다 — 요청 전에 막는다
    if (/[^\x20-\x7e]/.test(given)) {
      errBox.textContent = '비밀번호에 영문·숫자·기호 외의 글자(한글, 공백 문자 등)가 들어 있습니다. 서버에 설정한 값을 그대로 입력해 주세요';
      pwIn.focus();
      return;
    }
    var b = $('#loginBtn');
    busyBtn(b, true);
    PW = given;
    api('GET', '/admin/stats').then(function (r) {
      busyBtn(b, false);
      if (r.ok) {
        savePw(given);
        pwIn.value = '';
        enterApp(r);
        return;
      }
      PW = '';
      if (r.kind === 'disabled') {
        $('#loginNote').hidden = false;
        $('#loginNoteT').textContent = r.error;
        return;
      }
      $('#loginNote').hidden = true;
      errBox.textContent = r.kind === 'auth'
        ? '비밀번호가 일치하지 않습니다. 연속으로 틀리면 일정 시간 접속이 차단됩니다'
        : r.error;
      pwIn.focus();
      try { pwIn.select(); } catch (x) { /* 없음 */ }
    });
  }

  function enterApp(statsRes) {
    $('#login').hidden = true;
    $('#app').hidden = false;
    hideLock();
    STARTED = true;
    if (statsRes && statsRes.ok) applyStats(statsRes.json);
    else loadStats();
    loadPrice().then(function () { if (TAB === 'keys' || TAB === 'orders') loadTab(TAB); });
    switchTab(tabFromHash(), true);
    startPoll();
  }

  function logout() {
    dropPw();
    showLogin({ info: '로그아웃되었습니다. 이 탭에 보관된 비밀번호가 삭제되었습니다' });
  }

  /* ══════════════════ 6. 요약 숫자 + 주기 갱신 ══════════════════ */

  var STATS = null;
  var pollT = null;
  var statsGen = 0;

  function loadStats() {
    var my = ++statsGen;
    return api('GET', '/admin/stats').then(function (r) {
      if (my !== statsGen) return null;
      if (kicked(r)) return null;
      if (!r.ok) {
        // 잠금(429)은 상단 경고에 이미 나온다 — 같은 문구를 두 번 띄우지 않는다
        $('#updAt').textContent = r.kind === 'locked' ? '요약 갱신 실패' : '요약 갱신 실패 · ' + errText(r);
        return null;
      }
      applyStats(r.json);
      return r.json;
    });
  }

  function setStat(k, v) { var n = $('[data-v="' + k + '"]'); if (n) n.textContent = v === null || v === undefined ? '–' : String(v); }
  function setSub(k, v) { var n = $('[data-s="' + k + '"]'); if (n) n.textContent = v || ''; }
  function tone(k, cls) {
    var n = $('[data-v="' + k + '"]');
    if (!n) return;
    var tile = n.parentNode;
    tile.classList.remove('hot', 'crit');
    if (cls) tile.classList.add(cls);
  }

  function applyStats(s) {
    hideLock();   // 응답을 받았다 = 차단·연결 문제가 풀렸다
    var prev = STATS;
    STATS = s || {};
    var pend = num(STATS.pending_orders) || 0;
    var paid = num(STATS.paid_orders) || 0;
    var review = num(STATS.review_orders) || 0;
    var dep = num(STATS.deposits_attention) || 0;
    var rbd = STATS.rooms_by_display || {};
    var waiting = num(rbd.waiting) || 0;
    var errors = num(rbd.error) || 0;
    var bots = STATS.bots || {};
    var botTotal = num(bots.total) || 0;
    var botConn = num(bots.connected) || 0;

    setStat('pending', pend);
    setSub('pending', paid > 0 ? '입금됨 · 승인 대기 ' + paid + '건' : (review > 0 ? '확인 필요 ' + review + '건 포함' : '입금 대기 포함'));
    tone('pending', paid > 0 || review > 0 ? 'crit' : (pend > 0 ? 'hot' : ''));
    setStat('deposits', dep);
    tone('deposits', dep > 0 ? 'crit' : '');
    setStat('members', num(STATS.members));
    setSub('members', (num(STATS.members_blocked) || 0) > 0 ? '차단 ' + STATS.members_blocked + '명' : '가입한 회원');
    setStat('macro', num(STATS.macro_active));
    setStat('rooms', num(STATS.rooms_total));
    var rs = [];
    if (num(rbd.pending)) rs.push('입금 대기 ' + rbd.pending);
    if (num(STATS.rooms_hold)) rs.push('검토 대기 ' + STATS.rooms_hold);
    if (num(rbd.joining)) rs.push('입장 중 ' + rbd.joining);
    setSub('rooms', rs.length ? rs.join(' · ') : '결제 완료된 방');
    tone('rooms', num(STATS.rooms_hold) ? 'hot' : '');
    setStat('waiting', waiting);
    tone('waiting', waiting > 0 ? 'hot' : '');
    setStat('errors', errors);
    tone('errors', errors > 0 ? 'crit' : '');
    setStat('bots', botConn + ' / ' + botTotal);
    setSub('bots', '접속 / 전체 · 방 ' + (num(bots.used) || 0) + ' / ' + (num(bots.cap) || 0));
    tone('bots', botTotal === 0 ? 'hot' : (botConn < botTotal ? 'crit' : ''));

    // 예전 라이선스 키 요약 (키 탭)
    $('#featSum').textContent = '예전 라이선스 키 — 사용 중 ' + (num(STATS.active) || 0) + ' · 7일 내 만료 ' +
      (num(STATS.expiring_7d) || 0) + ' · 전체 ' + (num(STATS.total) || 0) +
      ' · 회수·차단 ' + ((num(STATS.revoked) || 0) + (num(STATS.blocked) || 0));

    // 카카오가 서버 IP 의 입장을 막았으면 맨 위 띠(5.3 -444)
    var paused = num(STATS.join_paused_until) || 0;
    var pb = $('#pauseBar');
    if (paused > Date.now()) {
      $('#pauseBarT').textContent = '카카오가 서버 IP의 방 입장을 잠시 막았습니다. ' + hhmm(paused) + '까지 모든 방 입장을 멈춥니다.';
      pb.hidden = false;
    } else {
      pb.hidden = true;
    }

    badge('orders', pend, '주문');
    badge('deposits', dep, '입금');
    badge('rooms', errors, '방');
    badge('bots', botTotal > botConn ? botTotal - botConn : 0, '봇');
    var n = pend + dep;
    document.title = (n > 0 ? '(' + n + ') ' : '') + '판매 관리 · K bot';
    $('#updAt').textContent = '갱신 ' + dateKr(num(STATS.now) || Date.now(), true, true);

    // 새 주문·입금이 들어왔으면 보고 있는 목록도 다시 읽는다 (창이 열려 있으면 건드리지 않는다)
    if (prev && !MODALS.length &&
        (num(prev.pending_orders) !== pend || num(prev.deposits_attention) !== dep || num(prev.paid_orders) !== paid)) {
      if (TAB === 'orders') loadOrders();
      else if (TAB === 'deposits') loadDeposits();
    }
  }

  function badge(name, n, base) {
    var b = $('[data-badge="' + name + '"]');
    if (!b) return;
    b.hidden = !(n > 0);
    b.textContent = n > 99 ? '99+' : String(n || 0);
    var tab = b.parentNode;
    tab.setAttribute('aria-label', base + (n > 0 ? ' (확인할 항목 ' + n + '건)' : ''));
    tabFade();
  }

  // 탭이 화면보다 넓으면 가려진 쪽 가장자리를 흐리게 한다(.fade-l / .fade-r)
  function tabFade() {
    var t = $('.mg-tabs');
    if (!t) return;
    t.classList.toggle('fade-l', t.scrollLeft > 2);
    t.classList.toggle('fade-r', t.scrollLeft + t.clientWidth < t.scrollWidth - 2);
  }

  function startPoll() {
    stopPoll();
    pollT = setInterval(function () {
      if (document.hidden || !PW || !STARTED) return;
      loadStats();
    }, POLL_MS);
  }
  function stopPoll() { if (pollT) { clearInterval(pollT); pollT = null; } }

  function refreshAll() {
    loadStats();
    loadPrice();
    loadTab(TAB);
  }

  /* ══════════════════ 7. 탭 ══════════════════ */

  var TABS = ['orders', 'deposits', 'members', 'bots', 'rooms', 'keys', 'audit', 'settings'];
  var TAB = 'orders';

  function tabFromHash() {
    var h = String(location.hash || '').replace(/^#/, '');
    return TABS.indexOf(h) >= 0 ? h : 'orders';
  }

  function switchTab(name, force) {
    if (TABS.indexOf(name) < 0) name = 'orders';
    var changed = name !== TAB;
    TAB = name;
    TABS.forEach(function (t) {
      var b = $('#tab-' + t), p = $('#pane-' + t);
      var on = t === name;
      b.setAttribute('aria-selected', on ? 'true' : 'false');
      b.tabIndex = on ? 0 : -1;
      p.hidden = !on;
    });
    if (('#' + name) !== location.hash) {
      try { history.replaceState(null, '', '#' + name); } catch (e) { /* 없음 */ }
    }
    var tb = $('#tab-' + name);
    if (tb && tb.scrollIntoView && changed) { try { tb.scrollIntoView({ block: 'nearest', inline: 'nearest' }); } catch (e) { /* 없음 */ } }
    tabFade();
    if (changed || force) loadTab(name);
    if (changed && STARTED) loadStats();      // 탭을 옮기면 요약 숫자도 새로 읽는다(30초 주기를 기다리지 않게)
  }

  function loadTab(name) {
    if (name === 'orders') loadOrders();
    else if (name === 'deposits') loadDeposits();
    else if (name === 'members') loadMembers();
    else if (name === 'bots') loadBots();
    else if (name === 'rooms') loadRooms();
    else if (name === 'keys') loadKeys(false);
    else if (name === 'audit') loadAudit();
    else if (name === 'settings') loadSettings();
  }

  function onTabKey(e) {
    var i = TABS.indexOf(TAB);
    var next = -1;
    if (e.key === 'ArrowRight') next = (i + 1) % TABS.length;
    else if (e.key === 'ArrowLeft') next = (i - 1 + TABS.length) % TABS.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = TABS.length - 1;
    if (next < 0) return;
    e.preventDefault();
    switchTab(TABS[next]);
    $('#tab-' + TABS[next]).focus();
  }

  function setFilter(groupSel, f) {
    $$(groupSel + ' button').forEach(function (b) {
      b.setAttribute('aria-pressed', b.getAttribute('data-f') === f ? 'true' : 'false');
    });
  }

  function listState(box, text, bad) {
    clear(box);
    box.appendChild(empty(text, bad));
  }
  function isLoadingBox(box) { return !box.firstChild || box.firstChild.className.indexOf('mg-empty') >= 0; }

  /* ══════════════════ 8. 주문 ══════════════════
     회원 주문(kind='member')은 회원 계정에 적용된다(키 없음). 예전 키 주문은 예전 화면 그대로 키를 발급·연장한다. */

  var ORD = { filter: 'open', gen: 0 };

  function isMemberOrder(o) { return !!o && (o.kind === 'member' || num(o.member_id) !== null); }

  function orderSt(o) {
    var m = isMemberOrder(o);
    if (o.status === 'pending') return { kr: '입금 대기', cls: 'warn' };
    if (o.status === 'paid') return { kr: m ? '입금됨 · 승인 대기' : '입금됨 · 발급 대기', cls: 'info' };
    if (o.status === 'done') return { kr: m ? '승인 완료' : '발급 완료', cls: 'ok' };
    if (o.status === 'canceled') return { kr: '취소', cls: '' };
    return { kr: o.status || '-', cls: '' };
  }

  function orderRank(o) {
    if (o.status === 'paid') return 0;                       // 입금 확인됨 — 적용만 남았다
    if (o.status === 'pending' && o.needs_review) return 1;  // 사람 확인 필요
    if (o.status === 'pending') return 2;
    return 3;
  }
  function sortOrders(list) {
    return list.slice().sort(function (a, b) {
      var d = orderRank(a) - orderRank(b);
      if (d) return d;
      return (num(b.created_at) || 0) - (num(a.created_at) || 0);
    });
  }

  // 주문 줄(orders.items) → 매크로 줄 + 방별 묶음
  function orderGroups(o) {
    var items = Array.isArray(o.items) ? o.items : [];
    var macro = null;
    var rooms = [];
    var by = {};
    items.forEach(function (it) {
      if (!it || typeof it !== 'object') return;
      if (it.product === 'macro') {
        macro = { months: (macro ? macro.months : 0) + (num(it.months) || 0), amount: (macro ? macro.amount : 0) + (num(it.amount) || 0) };
        return;
      }
      var k = String(it.install_id || it.link_url || rooms.length);
      var g = by[k];
      if (!g) {
        g = by[k] = { install_id: num(it.install_id), name: str(it.link_name), url: str(it.link_url), products: [],
                      amount: 0, unverified: false, hold: false };
        rooms.push(g);
      }
      if (g.products.indexOf(it.product) < 0) g.products.push(it.product);
      g.amount += num(it.amount) || 0;
      if (it.unverified) g.unverified = true;
      if (it.hold) g.hold = true;
    });
    return { macro: macro, rooms: rooms };
  }

  // "카카오톡 매크로 2개월 · 방 관리봇 1개 · 미니게임봇 1개"
  function orderSummary(o) {
    if (!isMemberOrder(o)) return legacyProductText(o.plan) + ' · ' + featText(o.features);
    var g = orderGroups(o);
    var parts = [];
    if (g.macro && g.macro.months) parts.push(plabel('macro') + ' ' + g.macro.months + '개월');
    var cnt = {};
    g.rooms.forEach(function (r) { r.products.forEach(function (p) { cnt[p] = (cnt[p] || 0) + 1; }); });
    roomProductIds().concat(Object.keys(cnt).filter(function (p) { return roomProductIds().indexOf(p) < 0; })).forEach(function (p) {
      if (cnt[p]) parts.push(plabel(p) + ' (방 ' + cnt[p] + '개)');
    });
    return parts.length ? parts.join(' · ') : '주문 내용 없음';
  }

  function roomLabel(g) { return g.name || shortLink(g.url) || ('방 #' + g.install_id); }

  function orderLinesNode(o) {
    var g = orderGroups(o);
    var box = el('div', { cls: 'mg-lines' });
    if (g.macro && g.macro.months) {
      box.appendChild(el('div', { cls: 'ln' }, [
        el('b', { text: plabel('macro') + ' ' + g.macro.months + '개월' }),
        el('span', { cls: 'amt' }, wonKids(g.macro.amount))
      ]));
    }
    g.rooms.forEach(function (r) {
      box.appendChild(el('div', { cls: 'ln' }, [
        el('b', { text: roomLabel(r) }),
        el('span', { text: r.products.map(plabel).join(' · ') }),
        r.unverified ? tag('미확인', 'warn') : null,
        r.hold ? tag('검토 대기', 'warn') : null,
        r.install_id ? el('span', { cls: 'mono dim tiny', text: '#' + r.install_id }) : null,
        el('span', { cls: 'amt' }, wonKids(r.amount))
      ]));
    });
    if (!box.firstChild) box.appendChild(el('div', { cls: 'ln', text: '주문 내역이 없습니다' }));
    return box;
  }

  function fetchOrders(filter) {
    if (filter === 'open') {
      return Promise.all([
        api('GET', '/admin/orders?status=paid&limit=' + LIST_LIMIT),
        api('GET', '/admin/orders?status=pending&limit=' + LIST_LIMIT)
      ]).then(function (rs) {
        if (!rs[0].ok) return rs[0];
        if (!rs[1].ok) return rs[1];
        return { ok: true, json: {
          bank: rs[1].json.bank || rs[0].json.bank,
          orders: (rs[0].json.orders || []).concat(rs[1].json.orders || [])
        } };
      });
    }
    var q = '/admin/orders?limit=' + LIST_LIMIT + (filter === 'all' ? '' : '&status=' + encodeURIComponent(filter));
    return api('GET', q);
  }

  function loadOrders() {
    var my = ++ORD.gen;
    var box = $('#ordList');
    if (isLoadingBox(box)) listState(box, '불러오는 중…');
    var filter = ORD.filter;
    fetchOrders(filter).then(function (r) {
      if (my !== ORD.gen) return;   // 그사이 필터를 바꿨다
      if (kicked(r)) return;
      if (!r.ok) { listState(box, '주문 목록을 불러오지 못했습니다\n' + errText(r), true); $('#ordCount').textContent = ''; return; }
      var list = r.json.orders || [];
      if (filter === 'open' || filter === 'all') list = sortOrders(list);
      var bank = str(r.json.bank);
      var bankEl = $('#ordBank');
      bankEl.hidden = !bank;
      bankEl.textContent = bank ? '입금 계좌: ' + bank : '';
      var label = { open: '처리 대기', done: '완료', canceled: '취소', all: '전체' }[filter] || '';
      $('#ordCount').textContent = label + ' ' + list.length + '건' + (list.length >= LIST_LIMIT ? ' (최근 ' + LIST_LIMIT + '건까지 표시)' : '');
      clear(box);
      if (!list.length) {
        listState(box, filter === 'open' ? '처리할 주문이 없습니다' : '해당 상태의 주문이 없습니다');
        return;
      }
      list.forEach(function (o) { box.appendChild(orderItem(o)); });
    });
  }

  function keyLine(label, key) {
    return el('div', { cls: 'mg-keyline' }, [
      el('span', { text: label }),
      el('span', { cls: 'mono', text: key }),
      btn('키 상세', 'sm ghost', function () { openKey(key); })
    ]);
  }

  function memberLine(o, prefix) {
    var login = o.member && o.member.login_id ? o.member.login_id : '#' + o.member_id;
    return el('div', { cls: 'mg-line' }, [
      (prefix || '회원') + ' ',
      inl(login, function () { openMember(o.member_id); }, '회원 ' + login + ' 상세 열기')
    ]);
  }

  function appliedNode(o) {
    var a = o.applied;
    if (!a || typeof a !== 'object') return null;
    var parts = [];
    if (a.macro && a.macro.until) parts.push(plabel('macro') + ' 만료 ' + dateKr(a.macro.until, true));
    if (Array.isArray(a.rooms) && a.rooms.length) parts.push('방 ' + a.rooms.length + '개에 봇 설치');
    if (a.legacy_to_member) parts.push('회원이 등록한 키라 회원 기간에 반영');
    var kids = [];
    if (parts.length) kids.push(el('div', { cls: 'mg-meta', text: '처리 결과: ' + parts.join(' · ') }));
    if (Array.isArray(a.skipped) && a.skipped.length) {
      var refund = a.skipped.reduce(function (s, x) { return s + (num(x && x.amount) || 0); }, 0);
      kids.push(el('p', { cls: 'mg-warn', text: '제외한 방 ' + a.skipped.length + '개 · 환불할 금액 ' + won(refund) }));
    }
    return kids;
  }

  function orderItem(o) {
    var st = orderSt(o);
    var member = isMemberOrder(o);
    var open = o.status === 'pending' || o.status === 'paid';
    var revivable = o.status === 'canceled' && !!o.auto_canceled;
    var amt = num(o.amount) || 0;
    var base = num(o.base_amount) || 0;
    var suffix = base > 0 && amt > base ? amt - base : 0;

    var cls = 'mg-item';
    if (open && o.needs_review) cls += ' review';
    else if (o.status === 'paid') cls += ' paid';
    var item = el('article', { cls: cls, 'aria-label': '주문 ' + o.id });

    item.appendChild(el('div', { cls: 'mg-r1' }, [
      el('span', { cls: 'mg-id grow', text: o.id }),
      member ? null : tag('예전 키 주문', 'line'),
      open && o.needs_review ? tag('확인 필요', 'warn') : null,
      revivable ? tag('미입금 자동 취소', 'line') : null,
      chip(st.kr, st.cls)
    ]));
    item.appendChild(el('div', { cls: 'mg-r1' }, [
      el('span', { cls: 'mg-amt' }, wonKids(amt)),
      suffix ? el('span', { cls: 'mg-meta', text: '입금 구분용 ' + suffix + '원 포함' }) : null,
      !suffix && base && open ? el('span', { cls: 'mg-meta', text: '구분 금액 없음' }) : null
    ]));
    if (open && o.needs_review) {
      item.appendChild(el('p', { cls: 'mg-warn', text: suffix
        ? '다른 회원이 같은 방을 먼저 결제해서 자동 처리되지 않은 주문입니다. [승인]을 누르면 처리할 수 없는 방과 환불할 금액이 표시됩니다.'
        : '입금 구분용 금액이 붙지 않은 주문입니다. 금액만으로 입금을 구분할 수 없으니 [입금] 탭의 원문과 입금자명을 확인한 뒤 승인해 주세요.' }));
    }
    if (o.status === 'paid') {
      item.appendChild(el('p', { cls: 'mg-line', text: member
        ? '입금이 확인되었습니다. 자동 승인이 꺼져 있어 [승인]을 눌러야 회원 계정에 반영됩니다.'
        : '입금이 확인되었습니다. 자동 승인이 꺼져 있어 [승인]을 눌러야 키가 발급됩니다.' }));
    }

    if (member) {
      item.appendChild(memberLine(o));
      item.appendChild(orderLinesNode(o));
    } else {
      item.appendChild(el('div', { cls: 'mg-line', text: legacyProductText(o.plan) + ' · ' + featText(o.features) }));
    }
    var who = ['입금자 ' + (str(o.depositor) || '미기재')];
    if (str(o.buyer_name) && str(o.buyer_name) !== str(o.depositor)) who.push('구매자 ' + str(o.buyer_name));
    if (str(o.contact)) who.push(str(o.contact));
    item.appendChild(el('div', { cls: 'mg-line', text: who.join(' · ') }));

    if (!member) {
      if (o.target_key) item.appendChild(keyLine('연장 대상', o.target_key));
      if (o.issued_key && o.issued_key !== o.target_key) item.appendChild(keyLine('발급 키', o.issued_key));
      else if (o.issued_key && o.status === 'done') item.appendChild(el('div', { cls: 'mg-meta', text: '연장 대상 키가 연장되었습니다' }));
    }
    append(item, appliedNode(o));

    var meta = '접수 ' + dateKr(o.created_at, true);
    if (num(o.handled_at)) meta += ' · 처리 ' + dateKr(o.handled_at, true);
    item.appendChild(el('div', { cls: 'mg-meta', text: meta }));
    if (str(o.memo)) item.appendChild(el('div', { cls: 'mg-meta', text: '메모: ' + str(o.memo) }));

    var acts = el('div', { cls: 'mg-acts' });
    if (open || revivable) acts.appendChild(btn(revivable ? '승인 (복구)' : '승인', 'sm primary', function () { openApprove(o); }));
    if (open) acts.appendChild(btn('취소', 'sm danger', function () { openCancel(o); }));
    if (member) acts.appendChild(btn('회원 상세', 'sm', function () { openMember(o.member_id); }));
    if (o.issued_key) acts.appendChild(copyBtn(o.issued_key, '키가', '키 복사'));
    acts.appendChild(copyBtn(o.id, '주문번호가', '주문번호 복사'));
    item.appendChild(acts);
    return item;
  }

  function keyInput(value, placeholder) {
    return el('input', { cls: 'inp mono keyin', autocomplete: 'off', spellcheck: 'false', autocapitalize: 'characters',
                         maxlength: '24', placeholder: placeholder || 'KAKA-XXXX-XXXX-XXXX', value: value || '' });
  }

  function openApprove(o) {
    if (isMemberOrder(o)) openApproveMember(o);
    else openApproveLegacy(o);
  }

  // 같은 방 충돌(room_taken)로 멈춘 승인 → 처리할 수 없는 방 목록 + 환불 금액 + "해당 방 빼고 …" (3.5)
  function conflictBody(j, okLabel) {
    var list = Array.isArray(j.conflicts) ? j.conflicts : [];
    var refund = num(j.refund);
    if (refund === null) refund = list.reduce(function (s, c) { return s + (num(c.amount) || 0); }, 0);
    var rows = el('div', { cls: 'mg-rows' }, list.map(function (c) {
      return el('div', { cls: 'mg-row' }, [
        el('div', { cls: 't' }, [
          el('div', { cls: 'mg-r1' }, [
            el('span', { cls: 'mg-name', text: c.link_name || shortLink(c.link_url) || ('방 #' + c.install_id) }),
            tag(WHY_LABEL[c.why] || '처리할 수 없음', 'warn')
          ]),
          c.link_url ? el('div', { cls: 'mg-meta mono', text: shortLink(c.link_url) }) : null,
          el('div', { cls: 'mg-meta', text: (c.products || []).map(plabel).join(' · ') + (c.install_id ? ' · 방 #' + c.install_id : '') })
        ]),
        el('div', { cls: 'a' }, [el('span', { cls: 'mg-amt' }, wonKids(c.amount))])
      ]);
    }));
    return [
      note('이 주문에 처리할 수 없는 방이 있어 승인하지 못했습니다(다른 회원이 같은 방을 먼저 결제한 경우 등). [' + okLabel +
           ']을 누르면 아래 방을 빼고 나머지를 처리합니다. 뺀 방의 금액은 입금자 계좌로 환불해 주세요.', true),
      sec('처리할 수 없는 방 ' + list.length + '개', list.length ? rows : empty('처리할 수 없는 방의 정보가 없습니다', false, true)),
      el('div', { cls: 'big hi' }, [
        el('div', { cls: 'k', text: '환불할 금액' }),
        el('div', { cls: 'v xl mono' }, wonKids(refund))
      ])
    ];
  }

  // 회원 주문 승인. 이 창 자체가 확인 단계다. 키 입력 없음.
  function openApproveMember(o) {
    var revivable = o.status === 'canceled' && !!o.auto_canceled;
    var okBtn = btn('승인', 'primary');
    var login = o.member && o.member.login_id ? o.member.login_id : '#' + o.member_id;
    var m = modal({ title: revivable ? '주문 복구 · 승인' : '주문 승인', wide: true, body: [
      kv([
        ['주문', o.id, 'mono'],
        ['금액', won(o.amount)],
        ['회원', login],
        ['입금자', str(o.depositor) || '미기재'],
        ['상태', orderSt(o).kr]
      ]),
      sec('주문 내용', orderLinesNode(o)),
      o.status === 'paid' ? note('입금이 확인된 주문입니다. 승인하면 회원 계정에 반영되고, K bot이 주문한 방에 들어갑니다.') : null,
      o.needs_review ? note('확인이 필요한 주문입니다. [입금] 탭의 원문에서 입금 금액과 입금자명을 확인한 뒤 승인해 주세요.', true) : null,
      revivable ? note('미입금으로 자동 취소된 주문입니다. 승인하면 주문이 복구되고, 그사이 다른 회원이 결제하지 않은 방만 다시 등록됩니다.', true) : null,
      o.status === 'pending' && !o.needs_review ? note('입금 확인 전입니다. 입금 내역을 확인한 경우에만 승인해 주세요.', true) : null
    ] });
    m.setActions([btn('닫기', 'ghost', function () { if (!m.busy) m.close(); }), okBtn]);
    var skip = false;
    okBtn.addEventListener('click', function () {
      if (m.busy) return;
      m.error('');
      m.setBusy(true, okBtn);
      var body = { id: o.id };
      if (skip) body.skip_conflicts = true;
      api('POST', '/admin/order-approve', body).then(function (r) {
        m.setBusy(false, okBtn);
        if (kicked(r)) return;
        if (r.ok) {
          m.close();
          showApplied({ title: '승인 완료', order: o, json: r.json });
          afterOrderChange();
          return;
        }
        if (r.json && r.json.reason === 'room_taken' && !skip) {
          skip = true;
          m.setTitle('처리할 수 없는 방 확인');
          m.setBody(conflictBody(r.json, '해당 방 빼고 승인'));
          okBtn.querySelector('.lbl-idle').textContent = '해당 방 빼고 승인';
          return;
        }
        m.error(errText(r, '주문을 승인하지 못했습니다'));
      });
    });
  }

  // 회원 주문 처리 결과
  function showApplied(o) {
    var j = o.json || {};
    var a = j.applied || {};
    var refund = num(j.refund) || 0;
    var login = j.member && j.member.login_id ? j.member.login_id : (j.member_id ? '#' + j.member_id : '-');
    var rows = [['회원', login]];
    if (a.macro && a.macro.until) rows.push([plabel('macro'), '+' + (num(a.macro.days) || 0) + '일 · 만료 ' + dateKr(a.macro.until, true)]);
    if (a.legacy_room_until) rows.push(['기존 키 기능', dateKr(a.legacy_room_until, true) + '까지']);
    if (Array.isArray(a.rooms) && a.rooms.length) {
      rows.push(['방', el('div', { cls: 'kv-list' }, a.rooms.map(function (x) {
        return el('span', { text: '방 #' + x.install_id + ' · ' + (x.products || []).map(plabel).join(' · ') });
      }))]);
    }
    var body = [
      el('div', { cls: 'chip-row' }, [chip(j.already ? '이미 처리된 주문' : '처리 완료', 'ok')]),
      para(j.already ? '이미 처리된 주문입니다. 아래는 그때 처리한 내용입니다.'
        : '주문 내용을 회원 계정에 반영했습니다. K bot이 주문한 방에 순서대로 들어가며, 방 관리봇은 방장이 K bot을 부방장으로 지정하면 동작합니다.'),
      kv(rows)
    ];
    if (Array.isArray(a.skipped) && a.skipped.length) {
      body.push(sec('제외한 방 ' + a.skipped.length + '개', el('div', { cls: 'mg-rows' }, a.skipped.map(function (x) {
        return el('div', { cls: 'mg-row' }, [
          el('div', { cls: 't' }, [el('span', { text: '방 #' + x.install_id + ' · ' + (x.products || []).map(plabel).join(' · ') }),
                                   el('span', { cls: 'mg-meta', text: WHY_LABEL[x.why] || '처리할 수 없음' })]),
          el('div', { cls: 'a' }, [el('span', { cls: 'mg-amt' }, wonKids(x.amount))])
        ]);
      }))));
      body.push(el('div', { cls: 'big hi' }, [
        el('div', { cls: 'k', text: '환불할 금액' }),
        el('div', { cls: 'v xl mono' }, wonKids(refund)),
        el('div', { cls: 'tiny dim', text: '제외한 방의 금액입니다. 입금자 계좌로 환불해 주세요.' })
      ]));
    }
    var m = modal({ title: o.title, light: true, wide: true, body: body });
    var acts = [btn('닫기', 'ghost', function () { m.close(); })];
    if (j.member_id) acts.push(btn('회원 상세', 'primary', function () { m.close(); openMember(j.member_id); }, { 'data-autofocus': '' }));
    m.setActions(acts);
    var af = $('[data-autofocus]', m.dlg);
    if (af) af.focus();
  }

  // 예전 키 주문 승인. 서버 규칙(keys.approveOrder): 입력한 키 > 주문의 target_key > 신규 발급.
  function openApproveLegacy(o) {
    var days = planDays(o.plan);
    var revivable = o.status === 'canceled' && !!o.auto_canceled;
    var input = keyInput(o.target_key || '');
    input.id = 'apKey';
    input.setAttribute('data-autofocus', '');
    var hint = el('p', { cls: 'hint', 'aria-live': 'polite' });
    function upd() {
      var k = normKey(input.value);
      if (k) hint.textContent = '이 키의 기능이 ' + (days || '주문 기간만큼') + (days ? '일' : '') + ' 연장됩니다. 회원이 등록한 키면 키 대신 그 회원의 기간이 늘어납니다.';
      else if (o.target_key) hint.textContent = '비워 두면 주문에 적힌 연장 대상 키(' + o.target_key + ')가 연장됩니다.';
      else hint.textContent = '비워 두면 새 키가 발급됩니다. 기존 키를 입력하면 그 키가 연장됩니다.';
    }
    input.addEventListener('input', upd);
    upd();

    confirmAct({
      title: revivable ? '주문 복구 · 승인' : '주문 승인',
      body: [
        kv([
          ['주문', o.id, 'mono'],
          ['금액', won(o.amount)],
          ['상품', legacyProductText(o.plan)],
          ['기능', featText(o.features)],
          ['입금자', str(o.depositor) || '미기재'],
          ['상태', orderSt(o).kr]
        ]),
        note('예전 가격으로 접수된 키 주문입니다. 새 판매는 회원 주문으로 접수됩니다.'),
        o.needs_review ? note('입금 구분용 금액이 붙지 않은 주문입니다. [입금] 탭의 원문에서 입금 금액과 입금자명을 확인한 뒤 승인해 주세요.', true) : null,
        revivable ? note('미입금으로 자동 취소된 주문입니다. 승인하면 주문이 복구되고 키가 발급 또는 연장됩니다.', true) : null,
        o.status === 'pending' && !o.needs_review ? note('입금 확인 전입니다. 입금 내역을 확인한 경우에만 승인해 주세요.', true) : null,
        el('div', { cls: 'fld' }, [
          el('label', { for: 'apKey', text: o.target_key ? '연장할 키' : '연장할 기존 키 (선택)' }),
          input,
          hint
        ])
      ],
      ok: '승인',
      check: function () {
        var raw = str(input.value);
        if (raw && !KEY_RE.test(normKey(raw))) return '키 형식이 올바르지 않습니다 (KAKA-XXXX-XXXX-XXXX)';
        return '';
      },
      run: function () {
        var k = normKey(input.value);
        var payload = { id: o.id };
        if (k) payload.key = k;
        return api('POST', '/admin/order-approve', payload);
      },
      failMsg: '주문을 승인하지 못했습니다',
      done: function (r) {
        var j = r.json;
        if (j.member_id) showApplied({ title: '승인 완료', order: o, json: j });
        else {
          showIssued({
            title: '승인 완료',
            key: j.key,
            lead: j.already ? '이미 처리된 주문입니다. 아래는 이 주문에 연결된 키입니다.'
              : (j.issued ? '새 키가 발급되었습니다. 구매자에게 아래 키를 전달해 주세요.' : '기존 키의 기능이 연장되었습니다.'),
            orderId: o.id
          });
        }
        afterOrderChange();
      }
    });
  }

  function showIssued(o) {
    var key = str(o.key);
    var m = modal({ title: o.title, light: true, body: [
      para(o.lead),
      el('div', { cls: 'big hi' }, [
        el('div', { cls: 'k', text: '라이선스 키' }),
        el('div', { cls: 'v key', text: key || '(키 없음)' })
      ]),
      el('p', { cls: 'hint', text:
        (o.orderId ? '구매자는 주문 조회 화면(/order/' + o.orderId + ')에서도 같은 키를 확인할 수 있습니다. ' : '') +
        '손님 화면의 키 등록은 없어졌습니다. 기간을 옮겨야 하면 회원 쪽에서 직접 연장해 주세요.' })
    ] });
    var acts = [btn('닫기', 'ghost', function () { m.close(); })];
    if (key) {
      acts.unshift(btn('키 상세', '', function () { m.close(); openKey(key); }));
      acts.push(btn('키 복사', 'primary', function () { copy(key, '키가'); }, { 'data-autofocus': '' }));
    }
    m.setActions(acts);
    var af = $('[data-autofocus]', m.dlg);
    if (af) af.focus();
  }

  function openCancel(o) {
    var memo = el('textarea', { cls: 'ta', id: 'cnMemo', maxlength: '500', rows: '3', placeholder: '예: 입금 없음, 구매자 요청' });
    memo.setAttribute('data-autofocus', '');
    confirmAct({
      title: '주문 취소',
      danger: true,
      body: [
        kv([['주문', o.id, 'mono'], ['금액', won(o.amount)], ['입금자', str(o.depositor) || '미기재'],
            isMemberOrder(o) ? ['주문 내용', orderSummary(o)] : null]),
        note('직접 취소한 주문은 승인으로 되돌릴 수 없으며, 이후 같은 금액이 입금되어도 자동 처리되지 않습니다.' +
             (isMemberOrder(o) ? ' 이 주문으로 잡아 둔 입금 대기 방도 함께 취소됩니다.' : ''), true),
        el('div', { cls: 'fld' }, [el('label', { for: 'cnMemo', text: '취소 사유 (선택)' }), memo])
      ],
      ok: '주문 취소',
      run: function () {
        var s = str(memo.value);
        return api('POST', '/admin/order-cancel', { id: o.id, memo: s || null });
      },
      failMsg: '취소하지 못했습니다. 이미 완료되었거나 찾을 수 없는 주문입니다',
      done: function () {
        toast('주문이 취소되었습니다', 'ok');
        afterOrderChange();
      }
    });
  }

  function afterOrderChange() {
    loadStats();
    if (TAB === 'orders') loadOrders();
    else if (TAB === 'deposits') loadDeposits();
    KEYS.dirty = true;
  }

  /* ══════════════════ 9. 입금 ══════════════════ */

  var DEP = { filter: 'attention', gen: 0 };

  function needsAttention(d) { return d.status === 'unmatched' || d.status === 'ambiguous'; }

  function loadDeposits() {
    var my = ++DEP.gen;
    var box = $('#depList');
    if (isLoadingBox(box)) listState(box, '불러오는 중…');
    var filter = DEP.filter;
    api('GET', '/admin/deposits?limit=' + LIST_LIMIT).then(function (r) {
      if (my !== DEP.gen) return;
      if (kicked(r)) return;
      if (!r.ok) { listState(box, '입금 기록을 불러오지 못했습니다\n' + errText(r), true); $('#depCount').textContent = ''; return; }
      var j = r.json;
      renderDepSys(!!j.hook_enabled, !!j.auto_approve);
      var all = j.deposits || [];
      var top = all.filter(needsAttention);
      var rest = all.filter(function (d) { return !needsAttention(d); });
      var att = num(j.needs_attention);
      $('#depCount').textContent = (filter === 'attention' ? '확인 필요 ' + top.length + '건' : '전체 ' + all.length + '건') +
        (att !== null && att > top.length ? ' · 확인 필요 총 ' + att + '건 (최근 ' + LIST_LIMIT + '건만 표시)' : '') +
        (filter === 'all' && all.length >= LIST_LIMIT ? ' (최근 ' + LIST_LIMIT + '건까지 표시)' : '');
      clear(box);
      if (filter === 'attention') {
        if (!top.length) {
          listState(box, all.length
            ? '확인이 필요한 입금이 없습니다. 받은 입금은 모두 처리되었습니다.'
            : '입금 기록이 없습니다.\n판매자 휴대폰의 자동화 앱이 은행 입금 알림을 서버로 보내면 이 목록에 표시됩니다.');
          return;
        }
        top.forEach(function (d) { box.appendChild(depositItem(d)); });
        return;
      }
      if (!all.length) {
        listState(box, '입금 기록이 없습니다.\n판매자 휴대폰의 자동화 앱이 은행 입금 알림을 서버로 보내면 이 목록에 표시됩니다.');
        return;
      }
      top.forEach(function (d) { box.appendChild(depositItem(d)); });
      if (top.length && rest.length) box.appendChild(el('p', { cls: 'mg-sep', text: '처리된 입금' }));
      rest.forEach(function (d) { box.appendChild(depositItem(d)); });
    });
  }

  function renderDepSys(hook, auto) {
    var box = $('#depSys');
    clear(box);
    box.appendChild(chip(hook ? '입금 알림 수신 켜짐' : '입금 알림 수신 꺼짐', hook ? 'ok' : 'bad'));
    box.appendChild(chip(auto ? '자동 승인 켜짐' : '자동 승인 꺼짐', auto ? 'ok' : 'warn'));
    if (!hook) {
      box.appendChild(el('p', { cls: 'hint', style: 'flex-basis:100%', text:
        '서버에 입금 알림 코드(DEPOSIT_TOKEN)가 설정되지 않아 은행 입금 알림을 받지 않습니다. 모든 주문을 [주문] 탭에서 직접 승인해야 합니다.' }));
    } else if (!auto) {
      box.appendChild(el('p', { cls: 'hint', style: 'flex-basis:100%', text:
        '자동 승인이 꺼져 있습니다(DEPOSIT_AUTO_APPROVE=0). 금액이 맞는 주문은 「입금됨 · 승인 대기」로 바뀌며, [주문] 탭에서 승인해야 회원 계정에 반영됩니다.' }));
    }
  }

  function depositItem(d) {
    var st = DEP_ST[d.status] || { kr: d.status || '-', cls: '' };
    var attention = needsAttention(d);
    var item = el('article', { cls: 'mg-item' + (d.status === 'ambiguous' ? ' alert' : (d.status === 'unmatched' ? ' review' : '')),
                               'aria-label': '입금 기록 ' + d.id });
    item.appendChild(el('div', { cls: 'mg-r1' }, [
      el('span', { cls: 'mg-amt grow' }, num(d.amount) === null ? [el('span', { cls: 'sans', text: '금액 읽지 못함' })] : wonKids(d.amount)),
      chip(st.kr, st.cls)
    ]));
    var meta = [dateKr(d.at, true, true)];
    if (str(d.name)) meta.push('입금자 ' + str(d.name));
    if (str(d.source)) meta.push('출처 ' + str(d.source));
    meta.push('기록 #' + d.id);
    item.appendChild(el('div', { cls: 'mg-meta', text: meta.join(' · ') }));
    if (d.matched_order) {
      item.appendChild(el('div', { cls: 'mg-line' }, [
        (d.status === 'matched' ? '연결된 주문 ' : '후보 주문 '),
        el('span', { cls: 'mono', text: d.matched_order })
      ]));
    }
    if (d.status === 'unmatched') item.appendChild(el('p', { cls: 'mg-warn', text: '금액이 맞는 대기 주문이 없습니다. 입금 구분용 금액을 빼고 입금했거나 이미 처리된 주문일 수 있습니다.' }));
    if (d.status === 'ambiguous') {
      var cancelNote = /입금\s*(취소|정정)/.test(str(d.raw));
      item.appendChild(el('p', { cls: 'mg-crit', text: cancelNote
        ? '입금 취소·정정 알림입니다. 주문을 연결하지 말고, 이미 승인한 주문이 있는지 확인한 뒤 [무시]를 눌러 주세요.'
        : '같은 금액의 주문이 여러 개이거나, 주문에 확인할 점이 있거나, 금액을 확실히 읽지 못해 자동 처리하지 않았습니다. 원문과 입금자명을 확인한 뒤 주문을 연결해 주세요.' }));
    }

    var raw = str(d.raw);
    var pre = el('pre', { cls: 'mg-raw', text: raw || '(원문 없음)' });
    item.appendChild(pre);
    if (raw && (raw.length > 120 || raw.split('\n').length > 3)) {
      var more = el('button', { type: 'button', cls: 'mg-more', 'aria-expanded': 'false', text: '원문 펼치기' });
      more.addEventListener('click', function () {
        var open = !pre.classList.contains('open');
        pre.classList.toggle('open', open);
        more.textContent = open ? '원문 접기' : '원문 펼치기';
        more.setAttribute('aria-expanded', open ? 'true' : 'false');
      });
      item.appendChild(more);
    }

    if (attention) {
      item.appendChild(el('div', { cls: 'mg-acts' }, [
        btn('주문 연결', 'sm primary', function () { openMatch(d); }),
        btn('무시', 'sm', function () { openIgnore(d); })
      ]));
    }
    return item;
  }

  // 수동 매칭 후보: 승인 가능한 주문(keys.approveOrder 기준) — 대기 · 입금 확인 · 미입금 자동 취소
  function matchable(o) {
    return o.status === 'pending' || o.status === 'paid' || (o.status === 'canceled' && !!o.auto_canceled);
  }

  function openMatch(d) {
    var amount = num(d.amount);
    var okBtn = btn('연결 후 승인', 'primary');
    okBtn.disabled = true;
    var m = modal({ title: '주문 연결', wide: true, body: [
      kv([
        ['입금 금액', amount === null ? '금액 읽지 못함' : won(amount)],
        ['입금자', str(d.name) || '알 수 없음'],
        ['수신', dateKr(d.at, true, true)]
      ]),
      el('pre', { cls: 'mg-raw open', text: str(d.raw) || '(원문 없음)' }),
      empty('승인 가능한 주문을 불러오는 중…')
    ] });
    m.setActions([btn('닫기', 'ghost', function () { if (!m.busy) m.close(); }), okBtn]);

    api('GET', '/admin/orders?limit=' + LIST_LIMIT).then(function (r) {
      if (kicked(r)) return;
      if (!r.ok) {
        m.setBody([empty('주문 목록을 불러오지 못했습니다\n' + errText(r), true)]);
        return;
      }
      var cands = (r.json.orders || []).filter(matchable).sort(function (a, b) {
        var ea = amount !== null && num(a.amount) === amount ? 0 : 1;
        var eb = amount !== null && num(b.amount) === amount ? 0 : 1;
        if (ea !== eb) return ea - eb;
        var ca = a.id === d.matched_order ? 0 : 1, cb = b.id === d.matched_order ? 0 : 1;
        if (ca !== cb) return ca - cb;
        return (num(b.created_at) || 0) - (num(a.created_at) || 0);
      });
      var exact = cands.filter(function (o) { return amount !== null && num(o.amount) === amount; });
      var preset = '';
      if (d.matched_order && cands.some(function (o) { return o.id === d.matched_order; })) preset = d.matched_order;
      else if (exact.length === 1) preset = exact[0].id;

      var gname = 'mg-match-' + d.id;
      var manual = el('input', { cls: 'inp mono keyin', id: 'mtManual', autocomplete: 'off', spellcheck: 'false',
                                 autocapitalize: 'characters', maxlength: '32', placeholder: 'ORD-YYMMDD-XXXXXX' });
      var summary = el('p', { cls: 'mg-p', 'aria-live': 'polite' });
      function find(id) { for (var i = 0; i < cands.length; i++) if (cands[i].id === id) return cands[i]; return null; }
      function chosen() {
        var mv = normOrderId(manual.value);
        if (mv) return mv;
        var r0 = $('input[name="' + gname + '"]:checked', m.dlg);
        return r0 ? r0.value : '';
      }
      function upd() {
        var id = chosen();
        okBtn.disabled = !id;
        clear(summary);
        if (!id) { summary.textContent = '연결할 주문을 골라 주세요.'; return; }
        var o = find(id);
        var how = '주문 내용대로 처리됩니다.';
        if (o && isMemberOrder(o)) how = '회원 ' + (o.member && o.member.login_id ? o.member.login_id : '#' + o.member_id) + ' 계정에 반영됩니다: ' + orderSummary(o) + '.';
        else if (o) how = o.target_key ? '연장 대상 키가 연장됩니다.' : '새 키가 발급됩니다.';
        append(summary, ['이 입금을 주문(', el('b', { cls: 'mono', text: id }), ')에 연결하고 승인합니다. ', how]);
        if (o && amount !== null && num(o.amount) !== amount) {
          summary.appendChild(el('span', { cls: 'mg-warn', style: 'display:block;margin-top:4px', text:
            '⚠ 입금 금액(' + won(amount) + ')과 주문 금액(' + won(o.amount) + ')이 다릅니다.' }));
        }
      }

      var pick = el('div', { cls: 'mg-pick', role: 'radiogroup', 'aria-label': '연결할 주문' });
      cands.forEach(function (o) {
        var same = amount !== null && num(o.amount) === amount;
        var radio = el('input', { type: 'radio', name: gname, value: o.id, checked: o.id === preset });
        radio.addEventListener('change', function () { manual.value = ''; upd(); });
        var st = orderSt(o);
        pick.appendChild(el('label', { cls: 'chk' }, [
          radio,
          el('span', { cls: 'box', 'aria-hidden': 'true' }),
          el('span', { cls: 't' }, [
            el('span', { cls: 'mg-r1' }, [
              el('span', { cls: 'mono', style: 'color:var(--fg)', text: o.id }),
              same ? tag('금액 일치', '') : null,
              o.id === d.matched_order ? tag('후보', 'warn') : null,
              o.needs_review ? tag('확인 필요', 'warn') : null
            ]),
            el('span', { cls: 'mg-meta', text: won(o.amount) + ' · 입금자 ' + (str(o.depositor) || '미기재') + ' · ' +
                                                st.kr + (o.auto_canceled && o.status === 'canceled' ? '(자동)' : '') +
                                                ' · ' + dateKr(o.created_at, true) }),
            el('span', { cls: 'mg-meta', text: isMemberOrder(o)
              ? '회원 ' + (o.member && o.member.login_id ? o.member.login_id : '#' + o.member_id) + ' · ' + orderSummary(o)
              : (o.target_key ? '예전 키 주문 · 연장 대상 ' + o.target_key : '예전 키 주문') })
          ])
        ]));
      });
      manual.addEventListener('input', function () {
        if (str(manual.value)) $$('input[name="' + gname + '"]', m.dlg).forEach(function (x) { x.checked = false; });
        upd();
      });

      var pickBody = [
        kv([
          ['입금 금액', amount === null ? '금액 읽지 못함' : won(amount)],
          ['입금자', str(d.name) || '알 수 없음'],
          ['수신', dateKr(d.at, true, true)]
        ]),
        el('pre', { cls: 'mg-raw', text: str(d.raw) || '(원문 없음)' }),
        el('div', { cls: 'mg-sec' }, [
          el('span', { cls: 'mg-h3', text: '승인 가능한 주문 ' + cands.length + '건 · 금액이 같은 주문을 위에 표시합니다' }),
          cands.length ? pick : empty('승인 가능한 주문이 없습니다', false, true)
        ]),
        el('div', { cls: 'fld' }, [
          el('label', { for: 'mtManual', text: '목록에 없는 주문번호 직접 입력' }),
          manual,
          el('p', { cls: 'hint', text: '최근 ' + LIST_LIMIT + '건 밖의 주문이면 주문번호를 입력해 주세요.' })
        ]),
        summary
      ];
      m.setBody(pickBody);
      upd();
      var first = $('input[name="' + gname + '"]:checked', m.dlg) || $('input[name="' + gname + '"]', m.dlg) || manual;
      try { first.focus(); } catch (e) { /* 없음 */ }

      var skipId = '';     // 충돌을 보여 준 주문 — 다시 누르면 충돌한 방을 빼고 연결한다
      okBtn.addEventListener('click', function () {
        if (m.busy) return;
        var id = skipId || chosen();
        if (!id) { m.error('연결할 주문을 골라 주세요'); return; }
        m.error('');
        m.setBusy(true, okBtn);
        var body = { deposit_id: d.id, order_id: id };
        if (skipId) body.skip_conflicts = true;
        api('POST', '/admin/deposit-match', body).then(function (res) {
          m.setBusy(false, okBtn);
          if (kicked(res)) return;
          if (!res.ok && res.json && res.json.reason === 'room_taken' && !skipId) {
            skipId = id;
            m.setTitle('처리할 수 없는 방 확인');
            m.setBody(conflictBody(res.json, '해당 방 빼고 연결'));
            okBtn.querySelector('.lbl-idle').textContent = '해당 방 빼고 연결';
            return;
          }
          if (!res.ok) { m.error(errText(res, '연결하지 못했습니다')); return; }
          m.close();
          var o = find(id);
          if (res.json.member_id) {
            showApplied({ title: '연결 완료', order: o, json: res.json });
          } else {
            showIssued({
              title: '연결 완료',
              key: res.json.key,
              lead: res.json.already
                ? '이미 처리된 주문입니다. 입금 기록만 이 주문에 연결되었습니다.'
                : '주문(' + id + ')이 승인되었습니다. 아래 키가 발급 또는 연장되었습니다.',
              orderId: id
            });
          }
          afterOrderChange();
        });
      });
    });
  }

  function openIgnore(d) {
    confirmAct({
      title: '입금 무시',
      body: [
        kv([['입금 금액', num(d.amount) === null ? '금액 읽지 못함' : won(d.amount)], ['입금자', str(d.name) || '알 수 없음'], ['수신', dateKr(d.at, true, true)]]),
        para('이 입금 기록을 무시 처리합니다. 확인 필요 목록에서 빠지며, 주문 상태와 회원 계정은 바뀌지 않습니다. 판매와 관계없는 입금(이체·환불 등)에만 써 주세요.')
      ],
      ok: '무시',
      run: function () { return api('POST', '/admin/deposit-ignore', { deposit_id: d.id }); },
      failMsg: '처리하지 못했습니다. 이미 주문과 연결되었거나 삭제된 기록입니다',
      done: function () {
        toast('무시 처리되었습니다', 'ok');
        loadStats();
        loadDeposits();
      }
    });
  }

  /* ══════════════════ 10. 회원 ══════════════════ */

  var MEM = { q: '', filter: 'all', gen: 0 };

  function macroText(until, now) {
    var u = num(until) || 0;
    var t = num(now) || Date.now();
    if (u > t) return '매크로 D-' + daysCeil(u - t);
    if (u > 0) return '매크로 만료';
    return '매크로 없음';
  }

  function loadMembers() {
    var my = ++MEM.gen;
    var box = $('#memList');
    if (isLoadingBox(box)) listState(box, '불러오는 중…');
    var q = '/admin/members?limit=' + LIST_LIMIT + (MEM.q ? '&q=' + encodeURIComponent(MEM.q) : '');
    if (MEM.filter === 'blocked') q += '&blocked=1';
    if (MEM.filter === 'macro') q += '&macro=1';
    api('GET', q).then(function (r) {
      if (my !== MEM.gen) return;
      if (kicked(r)) return;
      if (!r.ok) { listState(box, '회원 목록을 불러오지 못했습니다\n' + errText(r), true); $('#memCount').textContent = ''; return; }
      var list = r.json.members || [];
      var total = num(r.json.total) || list.length;
      var label = { all: '전체', macro: '매크로 이용 중', blocked: '차단' }[MEM.filter] || '';
      $('#memCount').textContent = (MEM.q ? '검색 ‘' + MEM.q + '’ · ' : '') + label + ' ' + total + '명' +
        (total > list.length ? ' 중 ' + list.length + '명 표시 · 최근 가입 순' : ' · 최근 가입 순');
      clear(box);
      if (!list.length) {
        listState(box, MEM.q ? '검색 결과가 없습니다.\n아이디 일부, 회원 번호, 연락처, 채널톡 memberId(m으로 시작하는 25자)로 찾을 수 있습니다.' : '해당하는 회원이 없습니다');
        return;
      }
      var now = num(r.json.now) || Date.now();
      list.forEach(function (mb) { box.appendChild(memberItem(mb, now)); });
    });
  }

  function memberItem(mb, now) {
    var blocked = !!str(mb.blocked_reason);
    var item = el('article', { cls: 'mg-item click' + (blocked ? ' alert' : ''), 'aria-label': '회원 ' + mb.login_id });
    item.appendChild(el('div', { cls: 'mg-r1' }, [
      el('span', { cls: 'grow' }, el('button', { type: 'button', cls: 'mg-link', text: mb.login_id,
        'aria-label': '회원 ' + mb.login_id + ' 상세 열기', onclick: function () { openMember(mb.id); } })),
      mb.google_linked ? tag('Google 연결', 'line') : null,
      chip(blocked ? '차단' : '정상', blocked ? 'bad' : 'ok')
    ]));
    item.appendChild(el('div', { cls: 'mg-line', text: (mb.comp ? '무료 회원 · 모든 기능' : macroText(mb.macro_until, now)) + ' · ' + plabel('roombot') + ' ' +
      (num(mb.roombot_n) || 0) + ' · ' + plabel('minigame') + ' ' + (num(mb.minigame_n) || 0) }));
    item.appendChild(el('div', { cls: 'mg-meta', text: '가입 ' + dateKr(mb.created_at) + ' · 최근 로그인 ' +
      (num(mb.last_login_at) ? dateKr(mb.last_login_at, true) : '없음') + ' · 회원 #' + mb.id +
      ' · 카카오 계정 ' + (num(mb.accounts_n) || 0) + ' · 로그인 기기 ' + (num(mb.sessions_n) || 0) +
      (str(mb.contact) ? ' · ' + str(mb.contact) : '') }));
    if (blocked) item.appendChild(el('div', { cls: 'mg-crit', text: '차단 사유: ' + str(mb.blocked_reason) }));
    item.appendChild(memberActs(mb, function () { loadMembers(); loadStats(); }));
    return item;
  }

  // 회원 동작 버튼 줄(목록·상세 공통). changed() 는 성공 뒤 다시 읽기.
  function memberActs(mb, changed, inDetail) {
    var blocked = !!str(mb.blocked_reason);
    return el('div', { cls: inDetail ? 'btn-row' : 'mg-acts', style: inDetail ? 'margin-top:0' : null }, [
      inDetail ? null : btn('상세', 'sm', function () { openMember(mb.id); }),
      btn('기간 추가', inDetail ? 'primary' : 'sm', function () { openMemberGrant(mb, changed); }),
      inDetail ? btn('봇 무료 설치', '', function () { openRoomGrant(mb.login_id, changed); }) : null,
      inDetail ? btn(mb.comp ? '무료 회원 끄기' : '무료 회원 켜기', '', function () { openMemberComp(mb, changed); }) : null,
      btn(blocked ? '차단 해제' : '차단', (inDetail ? '' : 'sm') + (blocked ? '' : ' danger'), function () { openMemberBlock(mb, changed); }),
      btn('로그아웃', inDetail ? '' : 'sm', function () { openMemberLogout(mb, changed); }),
      btn('임시 비밀번호', inDetail ? '' : 'sm', function () { openMemberPwReset(mb, changed); })
    ]);
  }

  /* ── 회원 상세 (창 하나를 계속 다시 그린다) */
  function openMember(id) {
    var m = modal({ title: '회원 상세', wide: true, light: true,
                    onClose: function () { if (TAB === 'members') loadMembers(); },
                    body: empty('불러오는 중…') });
    m.setActions([btn('닫기', 'ghost', function () { m.close(); })]);
    var gen = 0;
    function refresh() {
      var my = ++gen;
      return api('GET', '/admin/member?id=' + encodeURIComponent(String(id))).then(function (r) {
        if (my !== gen || !m.isOpen()) return;
        if (kicked(r)) return;
        if (!r.ok) { m.setBody(empty(errText(r, '회원을 불러오지 못했습니다'), true)); return; }
        renderMemberDetail(m, r.json, function () { loadStats(); refresh(); });
      });
    }
    refresh();
    return m;
  }

  function renderMemberDetail(m, j, changed) {
    var mb = j.member || {};
    var now = num(j.now) || Date.now();
    var blocked = !!str(mb.blocked_reason);
    m.setTitle('회원 상세 · ' + mb.login_id);

    var top = el('div', { cls: 'big hi' }, [
      el('div', { cls: 'k', text: '회원 #' + mb.id }),
      el('div', { cls: 'mg-keybox' }, [el('div', { cls: 'v key', text: mb.login_id }), copyBtn(mb.login_id, '아이디가', '아이디 복사')]),
      el('div', { cls: 'chip-row', style: 'margin-top:10px' }, [
        chip(blocked ? '차단' : '정상', blocked ? 'bad' : 'ok'),
        j.google ? tag('Google 연결', 'line') : tag('Google 미연결', 'line')
      ])
    ]);
    var alerts = [];
    if (blocked) alerts.push(note('차단된 회원입니다. 로그인할 수 없고, 매크로 발송과 방 관리봇·미니게임봇이 멈춰 있습니다. 사유: ' + str(mb.blocked_reason), true));

    var macro = mb.macro || {};
    var info = kv([
      [plabel('macro'), num(macro.until) > now ? 'D-' + daysCeil(macro.until - now) + ' · 만료 ' + dateKr(macro.until, true)
        : (num(macro.until) ? '만료 ' + dateKr(macro.until, true) : '없음')],
      num(mb.legacy_room_until) > now ? ['기존 키 기능', dateKr(mb.legacy_room_until, true) + '까지'] : null,
      ['카카오 계정', (num(mb.accounts_n) || 0) + '개'],
      ['설치한 방', (num(mb.rooms_n) || 0) + '개 · ' + plabel('roombot') + ' ' + (num(mb.roombot_n) || 0) + ' · ' + plabel('minigame') + ' ' + (num(mb.minigame_n) || 0)],
      ['연락처', str(mb.contact) || '-'],
      ['가입', dateKr(mb.created_at, true)],
      ['최근 로그인', num(mb.last_login_at) ? dateKr(mb.last_login_at, true) : '없음'],
      num(mb.pw_changed_at) ? ['비밀번호 변경', dateKr(mb.pw_changed_at, true)] : null,
      j.google ? ['Google', [el('span', { cls: 'mono', text: str(j.google.email) || '-' }), ' · 연결 ' + dateKr(j.google.linked_at)]] : null,
      mb.channel_member_id ? ['채널톡 memberId', mb.channel_member_id, 'mono'] : null
    ]);

    // 설치한 방
    var rooms = Array.isArray(j.rooms) ? j.rooms : [];
    var roomBox = rooms.length ? el('div', { cls: 'mg-rows' }, rooms.map(function (v) {
      return el('div', { cls: 'mg-row' }, [
        el('div', { cls: 't' }, [
          el('div', { cls: 'mg-r1' }, [
            el('span', { cls: 'mg-name', text: v.link_name || '이름 확인 전' }),
            productTags(v),
            chip(v.label, ROOM_CLS[v.display] || '')
          ]),
          el('div', { cls: 'mg-meta mono', text: shortLink(v.link_url) }),
          el('div', { cls: 'mg-meta', text: '방 #' + v.id + (v.bot ? ' · ' + botName(v) : '') + (v.phase === 'removed' ? ' · 설치 해제 ' + dateKr(v.removed_at) : '') })
        ]),
        el('div', { cls: 'a' }, [btn('방 상세', 'sm', function () { openRoom(v.id, changed); })])
      ]);
    })) : empty('설치한 방이 없습니다', false, true);

    // 카카오 계정
    var accs = Array.isArray(j.accounts) ? j.accounts : [];
    var accBox = accs.length ? el('div', { cls: 'mg-rows' }, accs.map(function (a) {
      return el('div', { cls: 'mg-row' }, [
        el('div', { cls: 't' }, [
          el('span', { cls: 'mono', style: 'color:var(--fg)', text: a.email || '-' }),
          el('span', { cls: 'mg-meta' }, [el('span', { cls: 'mono', text: a.device_id }), ' · 등록 ' + dateKr(a.created_at) +
            (a.legacy_key ? ' · 예전 키 ' + a.legacy_key : '')])
        ])
      ]);
    })) : empty('등록한 카카오 계정이 없습니다', false, true);

    // 구매 내역
    var orders = Array.isArray(j.orders) ? j.orders : [];
    var ordBox = orders.length ? el('div', { cls: 'mg-rows' }, orders.map(function (o) {
      var st = orderSt(o);
      return el('div', { cls: 'mg-row' }, [
        el('div', { cls: 't' }, [
          el('div', { cls: 'mg-r1' }, [el('span', { cls: 'mg-id', text: o.id }), chip(st.kr, st.cls)]),
          el('div', { cls: 'mg-meta', text: orderSummary(o) + ' · ' + won(o.amount) + ' · ' + dateKr(o.created_at, true) })
        ]),
        el('div', { cls: 'a' }, [
          (o.status === 'pending' || o.status === 'paid' || (o.status === 'canceled' && o.auto_canceled))
            ? btn('승인', 'sm primary', function () { openApprove(o); }) : null,
          copyBtn(o.id, '주문번호가', '복사')
        ])
      ]);
    })) : empty('구매 내역이 없습니다', false, true);

    // 로그인 기기
    var sess = Array.isArray(j.sessions) ? j.sessions : [];
    var sessBox = sess.length ? el('div', { cls: 'mg-rows' }, sess.map(function (s) {
      return el('div', { cls: 'mg-row' }, [
        el('div', { cls: 't' }, [
          el('div', { cls: 'mg-r1' }, [
            el('span', { text: s.device || '알 수 없는 기기' }),
            tag(s.method === 'google' ? 'Google' : '비밀번호', 'line'),
            s.active ? chip('로그인 중', 'ok') : chip(s.revoked_at ? '로그아웃' : '만료', '')
          ]),
          el('div', { cls: 'mg-meta', text: '마지막 사용 ' + dateKr(s.last_seen_at, true) + ' · 시작 ' + dateKr(s.created_at, true) +
            (s.ip ? ' · IP ' + s.ip : '') + (s.revoked_why ? ' · 종료 사유 ' + s.revoked_why : '') })
        ])
      ]);
    })) : empty('로그인 기록이 없습니다', false, true);

    // 등록한 키(예전 라이선스 키)
    var lic = Array.isArray(j.licenses) ? j.licenses : [];
    var licBox = lic.length ? el('div', { cls: 'mg-rows' }, lic.map(function (l) {
      return el('div', { cls: 'mg-row' }, [
        el('div', { cls: 't' }, [
          el('span', { cls: 'mono', style: 'color:var(--fg)', text: l.key }),
          el('span', { cls: 'mg-meta', text: '등록 ' + dateKr(l.claimed_at, true, true) + ' · IP ' + (str(l.claim_ip) || '기록 없음') })
        ]),
        el('div', { cls: 'a' }, [btn('다른 회원으로 옮기기', 'sm', function () { openReassign(l, mb, changed); })])
      ]);
    })) : empty('등록한 키가 없습니다', false, true);

    // 최근 기록
    var logs = Array.isArray(j.audit) ? j.audit : [];
    var logBox = el('div');
    if (!logs.length) logBox.appendChild(el('p', { cls: 'mg-meta', text: '기록이 없습니다' }));
    logs.forEach(function (a) {
      logBox.appendChild(el('div', { cls: 'mg-log' }, [
        el('time', { text: dateKr(a.at, true, true) }),
        el('span', null, [chip(KIND_LABEL[a.kind] || str(a.kind) || '-', isAlert(a.kind) ? 'bad' : '')]),
        el('span', { cls: 'd', text: (str(a.detail) || '-') + (str(a.ip) ? ' · IP ' + str(a.ip) : '') })
      ]));
    });

    m.setBody([
      top,
      alerts,
      sec('관리', memberActs(mb, changed, true)),
      sec('회원 정보', info),
      sec('설치한 방 ' + rooms.length + '개', roomBox),
      sec('카카오 계정 ' + accs.length + '개', accBox),
      sec('구매 내역 ' + orders.length + '건', ordBox),
      sec('로그인 기기', sessBox),
      sec('등록한 키 ' + lic.length + '개', licBox),
      el('section', { cls: 'mg-sec' }, [
        el('h3', { cls: 'mg-h3', text: '최근 기록 ' + logs.length + '건' }),
        logBox,
        btn('기록 탭에서 전체 보기', 'sm ghost', function () { m.close(); showAuditForMember(mb.login_id); })
      ])
    ]);
  }

  function openMemberGrant(mb, changed) {
    var days = textInput({ type: 'number', mono: true, inputmode: 'numeric', min: '1', maxv: 3650, step: '1', value: '30', autofocus: true });
    days.style.width = '112px';
    var prev = el('p', { cls: 'mg-p', 'aria-live': 'polite' });
    var cur = num(mb.macro_until) || 0;
    function parse() { var d = Math.floor(Number(days.value)); return isFinite(d) && d >= 1 && d <= 3650 && String(days.value).indexOf('.') < 0 ? d : 0; }
    function upd() {
      var d = parse();
      prev.textContent = d ? '만료 예정: ' + dateKr(Math.max(Date.now(), cur) + d * DAY, true) + ' (현재 만료일 뒤로 ' + d + '일)' : '기간은 1~3650일로 입력해 주세요.';
    }
    days.addEventListener('input', upd);
    upd();
    confirmAct({
      title: '매크로 기간 추가',
      body: [
        kv([['회원', mb.login_id], [plabel('macro'), cur > Date.now() ? '만료 ' + dateKr(cur, true) : (cur ? '만료됨' : '없음')]]),
        para('결제 없이 ' + plabel('macro') + ' 기간을 늘립니다. 남은 기간이 있으면 만료일 뒤로 이어지고, 이미 만료되었으면 지금부터 계산합니다. 이 회원의 카카오 계정에 바로 반영됩니다.'),
        el('div', { cls: 'fld' }, [el('label', { text: '추가할 일수' }), el('div', { cls: 'mg-numrow' }, [days, el('span', { cls: 'dim tiny', text: '일 (1~3650)' })])]),
        prev
      ],
      ok: '기간 추가',
      check: function () { return parse() ? '' : '기간은 1~3650일로 입력해 주세요'; },
      run: function () { return api('POST', '/admin/member-grant', { id: mb.id, macro_days: parse() }); },
      failMsg: '기간을 추가하지 못했습니다',
      done: function (r) {
        toast('매크로 기간을 추가했습니다 · 만료 ' + dateKr(r.json.macro_until, true), 'ok');
        if (changed) changed();
      }
    });
  }

  // 무료 회원: 결제 없이 매크로(기간 무제한)와 패널 [방 추가](봇 무료 설치)를 쓴다
  function openMemberComp(mb, changed) {
    var on = !mb.comp;
    confirmAct({
      title: on ? '무료 회원 켜기' : '무료 회원 끄기',
      body: [
        kv([['회원', mb.login_id]]),
        para(on
          ? '결제 없이 모든 기능을 씁니다. ' + plabel('macro') + '는 기간 제한 없이 켜지고, 회원 콘솔 [내 방]에 [방 추가]가 생겨 ' + plabel('roombot') + '·' + plabel('minigame') + '을 무료로 넣을 수 있습니다.'
          : '무료 회원을 끕니다. ' + plabel('macro') + '는 원래 결제한 기간으로 돌아가고, 이미 넣은 방은 그대로 남습니다.')
      ],
      ok: on ? '켜기' : '끄기',
      run: function () { return api('POST', '/admin/member-comp', { id: mb.id, on: on }); },
      failMsg: '바꾸지 못했습니다',
      done: function () {
        toast(on ? '무료 회원을 켰습니다' : '무료 회원을 껐습니다', 'ok');
        if (changed) changed();
      }
    });
  }

  function openMemberBlock(mb, changed) {
    var blocked = !!str(mb.blocked_reason);
    if (blocked) {
      confirmAct({
        title: '차단 해제',
        body: [
          kv([['회원', mb.login_id], ['차단 사유', str(mb.blocked_reason)]]),
          para('차단을 해제합니다. 다시 로그인할 수 있고, 매크로 발송과 방 관리봇·미니게임봇이 다시 동작합니다.')
        ],
        ok: '차단 해제',
        run: function () { return api('POST', '/admin/member-block', { id: mb.id, reason: null }); },
        failMsg: '처리하지 못했습니다',
        done: function () { toast('차단을 해제했습니다', 'ok'); if (changed) changed(); }
      });
      return;
    }
    var reason = textInput({ max: 200, placeholder: '예: 결제 분쟁, 이용 조건 위반', autofocus: true });
    confirmAct({
      title: '회원 차단',
      danger: true,
      body: [
        kv([['회원', mb.login_id]]),
        note('이 회원의 로그인을 막고 모든 기기에서 로그아웃시킵니다. 매크로 발송과 방 관리봇·미니게임봇이 멈춥니다. K bot은 방에서 나가지 않고 동작만 멈춥니다. 차단을 해제하면 그대로 이어집니다.', true),
        field('차단 사유 (필수, 200자 이하)', reason, null, 'mbReason')
      ],
      ok: '차단',
      check: function () { var s = str(reason.value); return s && s.length <= 200 ? '' : '차단 사유를 1~200자로 입력해 주세요'; },
      run: function () { return api('POST', '/admin/member-block', { id: mb.id, reason: str(reason.value) }); },
      failMsg: '차단하지 못했습니다',
      done: function (r) { toast('회원을 차단했습니다 · 로그아웃 ' + (num(r.json.ended) || 0) + '대', 'ok'); if (changed) changed(); }
    });
  }

  function openMemberLogout(mb, changed) {
    confirmAct({
      title: '모든 기기 로그아웃',
      body: [kv([['회원', mb.login_id], ['로그인 기기', (num(mb.sessions_n) || 0) + '대']]),
             para('이 회원을 모든 기기에서 로그아웃시킵니다. 회원은 다시 로그인하면 이어서 사용할 수 있습니다.')],
      ok: '로그아웃',
      run: function () { return api('POST', '/admin/member-logout', { id: mb.id }); },
      failMsg: '처리하지 못했습니다',
      done: function (r) { toast('로그아웃했습니다 · ' + (num(r.json.ended) || 0) + '대', 'ok'); if (changed) changed(); }
    });
  }

  function openMemberPwReset(mb, changed) {
    confirmAct({
      title: '임시 비밀번호 발급',
      danger: true,
      body: [
        kv([['회원', mb.login_id]]),
        note('12자 임시 비밀번호를 만들어 기존 비밀번호를 바꾸고 모든 기기에서 로그아웃시킵니다. 임시 비밀번호는 다음 화면에서 한 번만 표시됩니다. 상담에서 본인 확인을 마친 경우에만 발급해 주세요.', true)
      ],
      ok: '발급',
      run: function () { return api('POST', '/admin/member-pwreset', { id: mb.id }); },
      failMsg: '발급하지 못했습니다',
      done: function (r) {
        var pw = str(r.json.temp_password);
        var m2 = modal({ title: '임시 비밀번호', body: [
          para('아래 비밀번호를 회원에게 전달해 주세요. 이 창을 닫으면 다시 볼 수 없습니다. 로그인한 뒤 내 계정에서 비밀번호를 바꾸도록 안내해 주세요.'),
          el('div', { cls: 'big hi' }, [
            el('div', { cls: 'k', text: '아이디 ' + (r.json.login_id || mb.login_id) }),
            el('div', { cls: 'mg-keybox' }, [el('div', { cls: 'v key', text: pw })])
          ])
        ] });
        m2.setActions([btn('닫기', 'ghost', function () { m2.close(); }),
                       btn('복사', 'primary', function () { copy(pw, '임시 비밀번호가'); }, { 'data-autofocus': '' })]);
        var af = $('[data-autofocus]', m2.dlg);
        if (af) af.focus();
        if (changed) changed();
      }
    });
  }

  function openReassign(l, mb, changed) {
    var login = textInput({ max: 40, placeholder: '옮길 회원 아이디', autofocus: true });
    confirmAct({
      title: '키 옮기기',
      danger: true,
      body: [
        kv([['키', l.key, 'mono'], ['현재 회원', mb.login_id], ['등록', dateKr(l.claimed_at, true) + ' · IP ' + (str(l.claim_ip) || '기록 없음')]]),
        note('잘못 등록된 키를 다른 회원에게 옮깁니다. 키에 묶인 카카오 계정도 함께 옮겨지고, 현재 회원은 모든 기기에서 로그아웃됩니다. 매크로 기간은 자동으로 다시 계산하지 않으니 필요하면 두 회원의 기간을 따로 조정해 주세요.', true),
        field('옮길 회원 아이디', login, '회원 번호를 입력해도 됩니다.', 'raLogin')
      ],
      ok: '옮기기',
      check: function () { return str(login.value) ? '' : '옮길 회원 아이디를 입력해 주세요'; },
      run: function () {
        var v = str(login.value);
        var body = { key: l.key_ref };
        if (/^#?\d+$/.test(v)) body.member_id = v.replace(/^#/, ''); else body.login_id = v;
        return api('POST', '/admin/license-reassign', body);
      },
      failMsg: '옮기지 못했습니다',
      done: function () { toast('키를 옮겼습니다', 'ok'); if (changed) changed(); }
    });
  }

  /* ══════════════════ 11. K bot 계정 ══════════════════
     봇 카카오 계정은 콘솔의 계정 등록과 같은 단계로 등록한다(휴대폰 확인 번호 → 확인 대기 → 완료).
     비밀번호는 서버에 저장하지 않는다(sender 메모리에만, 8.11). */

  var BOTS = { list: [], gen: 0, senderUp: true, defaultCap: 20 };

  function botState(b) {
    if (b.state === 'needs_register') return { kr: '등록 필요', cls: 'bad' };
    var conn = b.live ? !!b.live.connected : b.state === 'connected';
    if (conn) return { kr: '접속 중', cls: 'ok' };
    return { kr: '접속 대기', cls: 'warn' };
  }
  function botTitle(b) { return str(b.nickname) || '닉네임 확인 전'; }

  /* 오픈프로필(D12): 봇은 고객 방에 카카오톡 기본 프로필이 아니라 그 계정의 오픈프로필로 들어간다.
     오픈프로필이 없으면 입장하지 않는다(방 상태 '오류 · K bot 준비 중'). 방장에게 보이는 이름은 오픈프로필 이름이다. */
  var PROFILE_HINT = {
    none: '이 K bot 계정에 오픈프로필이 없습니다. 카카오톡에서 이 계정으로 오픈프로필을 만든 뒤 [오픈프로필 다시 읽기]를 눌러 주세요. 기본 프로필로는 입장하지 않습니다.',
    gone: '고른 오픈프로필을 찾지 못했습니다. [오픈프로필 선택]에서 다시 골라 주세요.',
    unknown: '오픈프로필을 아직 확인하지 못했습니다. K bot 계정이 접속할 때 자동으로 읽으며, [오픈프로필 다시 읽기]를 누르면 바로 읽습니다. 확인될 때까지 새 방에 입장하지 않습니다.'
  };
  function profileTag(b) {
    var s = b.open_profile_state;
    if (s === 'none') return tag('오픈프로필 없음', 'crit');
    if (s === 'gone') return tag('오픈프로필 선택 필요', 'warn');
    if (s !== 'ok') return tag('오픈프로필 확인 전', 'line');
    return null;
  }
  // 이름 뒤 '로'/'으로'(sender roomfeat.roJosa 와 같은 규칙)
  function ro(word) {
    var w = String(word || '').replace(/[^0-9A-Za-z가-힣]+$/, '');
    if (!w) return '(으)로';
    var ch = w.charAt(w.length - 1);
    var code = ch.charCodeAt(0);
    if (code >= 0xAC00 && code <= 0xD7A3) { var j = (code - 0xAC00) % 28; return j === 0 || j === 8 ? '로' : '으로'; }
    if (/[0-9]/.test(ch)) return '036'.indexOf(ch) >= 0 ? '으로' : '로';
    if (!/[A-Za-z]{2}$/.test(w)) return 'mn'.indexOf(ch.toLowerCase()) >= 0 ? '으로' : '로';
    return 'bcdgkmnpqt'.indexOf(ch.toLowerCase()) >= 0 ? '으로' : '로';
  }
  // 방에서 봇이 보이는 프로필(sender 판정) → 목록 태그
  var ROOM_PROFILE = {
    main: { t: '기본 프로필', c: 'warn' },
    other: { t: '다른 오픈프로필', c: 'warn' },
    failed: { t: '프로필 바꾸기 거절', c: 'crit' }
  };

  function loadBots() {
    var my = ++BOTS.gen;
    var box = $('#botList');
    if (isLoadingBox(box)) listState(box, '불러오는 중…');
    return api('GET', '/admin/bots').then(function (r) {
      if (my !== BOTS.gen) return null;
      if (kicked(r)) return null;
      if (!r.ok) { listState(box, 'K bot 계정을 불러오지 못했습니다\n' + errText(r), true); $('#botCount').textContent = ''; return null; }
      var j = r.json;
      BOTS.list = j.bots || [];
      BOTS.senderUp = j.sender_up !== false;
      BOTS.defaultCap = num(j.default_cap) || 20;
      var sys = $('#botSys');
      clear(sys);
      if (!BOTS.senderUp) sys.appendChild(el('div', { style: 'margin-bottom:12px' }, note('발송 서버가 멈춰 있어 접속 상태를 확인할 수 없고, 등록·삭제를 할 수 없습니다. 발송 서버가 다시 켜지면 저장된 계정으로 이어서 접속합니다.', true)));
      var used = 0, cap = 0, conn = 0;
      BOTS.list.forEach(function (b) { used += num(b.rooms_n) || 0; if (b.enabled) cap += num(b.room_cap) || 0; if (botState(b).cls === 'ok') conn++; });
      $('#botCount').textContent = 'K bot 계정 ' + BOTS.list.length + '개 · 접속 ' + conn + ' · 맡은 방 ' + used + ' / ' + cap;
      clear(box);
      if (!BOTS.list.length) {
        listState(box, '등록된 K bot 계정이 없습니다.\n[K bot 계정 등록]으로 운영자 카카오 계정을 등록하면 결제된 방에 K bot이 자동으로 들어갑니다.');
        return BOTS.list;
      }
      BOTS.list.forEach(function (b) { box.appendChild(botItem(b)); });
      return BOTS.list;
    });
  }

  function loadBar(n, cap) {
    var pct = cap > 0 ? Math.min(1, n / cap) : 0;
    var bar = el('span', { cls: 'bar' + (pct >= 0.8 ? ' warn' : ''), role: 'img', 'aria-label': '맡은 방 ' + n + ' / 최대 ' + cap });
    var fill = el('i');
    fill.style.width = Math.round(pct * 100) + '%';
    bar.appendChild(fill);
    return el('div', { cls: 'mg-load' }, [bar, el('span', { cls: 'n', text: '방 ' + n + ' / ' + cap })]);
  }

  function botItem(b) {
    var st = botState(b);
    var pstate = b.open_profile_state || 'unknown';
    var item = el('article', { cls: 'mg-item' + (st.cls === 'bad' || pstate === 'none' ? ' alert' : ''), 'aria-label': 'K bot 계정 ' + botTitle(b) });
    item.appendChild(el('div', { cls: 'mg-r1' }, [
      el('span', { cls: 'mg-name grow', text: botTitle(b) }),
      profileTag(b),
      b.nickname_dup ? tag('이름 중복', 'warn') : null,
      b.enabled ? null : tag('새 방 받기 중지', 'line'),
      chip(st.kr, st.cls)
    ]));
    item.appendChild(el('div', { cls: 'mg-line mono', text: b.email || '-' }));
    var prof = b.open_profile;
    if (pstate === 'ok' && prof) {
      item.appendChild(el('div', { cls: 'mg-line' }, ['오픈프로필 「' + (str(prof.name) || '이름 없음') + '」',
        str(prof.url) ? ' · ' : null, str(prof.url) ? el('span', { cls: 'mono', text: shortLink(prof.url) }) : null]));
    } else {
      item.appendChild(el('div', { cls: pstate === 'none' ? 'mg-crit' : 'mg-meta', text: PROFILE_HINT[pstate] || PROFILE_HINT.unknown }));
    }
    var plist = Array.isArray(b.open_profiles) ? b.open_profiles : [];
    if (pstate === 'ok' && plist.length > 1 && !b.open_profile_pick) {
      item.appendChild(el('p', { cls: 'hint', style: 'margin-top:0', text: '오픈프로필이 ' + plist.length + '개입니다. 현재는 「' + (str(prof && prof.name) || '-') + '」' + ro(str(prof && prof.name)) + ' 입장합니다. [오픈프로필 선택]에서 바꿀 수 있습니다.' }));
    }
    var pr = b.profile_rooms || {};
    var notOpen = (num(pr.main) || 0) + (num(pr.other) || 0) + (num(pr.failed) || 0);
    if (notOpen) {
      var parts = [];
      if (num(pr.main)) parts.push('기본 프로필 ' + pr.main + '개');
      if (num(pr.other)) parts.push('다른 오픈프로필 ' + pr.other + '개');
      if (num(pr.failed)) parts.push('바꾸기 거절 ' + pr.failed + '개');
      item.appendChild(el('p', { cls: 'hint', style: 'margin-top:0', text: '오픈프로필이 아닌 프로필로 들어가 있는 방: ' + parts.join(' · ') + '. ' +
        (b.profile_convert === 'auto' ? '한 시간에 정해진 수만큼 자동으로 바꾸고 있습니다.' : '[맡은 방]에서 방을 열어 [오픈프로필로 바꾸기]를 눌러 주세요.') }));
    }
    if (b.nickname_dup) item.appendChild(el('p', { cls: 'hint', style: 'margin-top:0', text: '방장이 구분할 수 있도록 봇마다 오픈프로필 이름을 다르게 정해 주세요.' }));
    item.appendChild(loadBar(num(b.rooms_n) || 0, num(b.room_cap) || 0));
    var meta = [];
    if (str(b.label)) meta.push(str(b.label));
    meta.push('등록 ' + dateKr(b.created_at));
    if (num(b.state_at)) meta.push('상태 변경 ' + dateKr(b.state_at, true));
    if (num(b.leaves_n)) meta.push('퇴장 대기 ' + b.leaves_n + '개');
    item.appendChild(el('div', { cls: 'mg-meta' }, [el('span', { cls: 'mono', text: b.device_id }), ' · ' + meta.join(' · ')]));
    item.appendChild(el('div', { cls: 'mg-acts' }, [
      btn('오픈프로필 선택', 'sm', function () { openBotProfile(b); }),
      btn('오픈프로필 다시 읽기', 'sm', function (e) { refreshBotProfile(b, e.currentTarget); }),
      btn('재등록', 'sm', function () { openBotRegister(b); }),
      btn(b.enabled ? '새 방 받기 중지' : '새 방 받기 재개', 'sm', function () { openBotEnable(b); }),
      btn('최대 방 수 변경', 'sm', function () { openBotCap(b); }),
      btn('맡은 방', 'sm', function () { showRoomsForBot(b); }),
      btn('삭제', 'sm danger', function () { openBotRemove(b); })
    ]));
    return item;
  }

  function afterBotChange() { loadStats(); if (TAB === 'bots') loadBots(); }

  /* ══════════════════ 운영 한도 ([설정] 탭) ══════════════════
     GET/POST /admin/settings. 값은 서버(lib/settings.js)가 검사한다. */
  var SETS = { gen: 0, botsN: 0 };
  var SET_HINT = {
    bot_room_cap: '새로 등록하는 K bot 계정이 맡을 수 있는 방의 수입니다. 이미 등록한 계정은 [봇] 탭에서 계정마다 바꿀 수 있습니다.',
    kakao_accounts: '회원 1명이 패널에 등록할 수 있는 카카오 계정 수입니다. 줄여도 이미 등록한 계정은 그대로 두고, 새로 등록할 때만 막습니다.',
    sessions: '한 아이디로 동시에 로그인할 수 있는 기기 수입니다. 넘으면 가장 오래 쓰지 않은 기기부터 로그아웃됩니다. 줄이면 다음 로그인부터 적용됩니다.'
  };

  function loadSettings() {
    var my = ++SETS.gen;
    var box = $('#setList');
    if (isLoadingBox(box)) listState(box, '불러오는 중…');
    return api('GET', '/admin/settings').then(function (r) {
      if (my !== SETS.gen) return;
      if (kicked(r)) return;
      if (!r.ok) { listState(box, '설정을 불러오지 못했습니다\n' + errText(r), true); return; }
      SETS.botsN = num(r.json.bots_n) || 0;
      clear(box);
      (r.json.settings || []).forEach(function (s) { box.appendChild(settingItem(s)); });
    });
  }

  function settingItem(s) {
    var item = el('article', { cls: 'mg-item', 'aria-label': s.label });
    item.appendChild(el('div', { cls: 'mg-r1' }, [
      el('span', { cls: 'mg-name grow', text: s.label }),
      el('span', { cls: 'mono', text: s.value + s.unit })
    ]));
    item.appendChild(el('p', { cls: 'hint', style: 'margin-top:0', text: SET_HINT[s.key] || '' }));
    item.appendChild(el('div', { cls: 'mg-meta', text: s.min + '~' + s.max + s.unit + ' · 기본값 ' + s.default + s.unit }));
    item.appendChild(el('div', { cls: 'mg-acts' }, [btn('변경', 'sm', function () { openSetting(s); })]));
    return item;
  }

  function openSetting(s) {
    var inp = textInput({ type: 'number', mono: true, inputmode: 'numeric', min: String(s.min), maxv: s.max, step: '1', value: String(s.value), autofocus: true });
    var apply = s.key === 'bot_room_cap' && SETS.botsN
      ? checkRow('이미 등록한 K bot 계정 ' + SETS.botsN + '개에도 적용', '계정마다 따로 정한 최대 방 수를 이 값으로 바꿉니다. 맡은 방이 이 값보다 많아도 옮기지 않습니다.', false)
      : null;
    function parse() {
      var n = Math.floor(Number(inp.value));
      return isFinite(n) && n >= s.min && n <= s.max && String(inp.value).indexOf('.') < 0 ? n : 0;
    }
    confirmAct({
      title: s.label + ' 변경',
      body: [
        para(SET_HINT[s.key] || ''),
        el('div', { cls: 'fld' }, [el('label', { text: s.label }), el('div', { cls: 'mg-numrow' }, [inp, el('span', { cls: 'dim tiny', text: s.unit + ' (' + s.min + '~' + s.max + ')' })])]),
        apply ? apply.node : null
      ],
      ok: '변경',
      check: function () { return parse() ? '' : s.label + '는 ' + s.min + '~' + s.max + s.unit + '로 입력해 주세요'; },
      run: function () {
        var values = {};
        values[s.key] = parse();
        return api('POST', '/admin/settings', { values: values, apply_bots: !!(apply && apply.input.checked) });
      },
      failMsg: '바꾸지 못했습니다',
      done: function (r) {
        var n = r && r.json ? num(r.json.applied_bots) || 0 : 0;
        toast(s.label + '를 ' + parse() + s.unit + '로 바꿨습니다' + (n ? ' · K bot 계정 ' + n + '개에도 적용' : ''), 'ok');
        loadSettings();
        if (n) loadStats();
      }
    });
  }

  function profileDone(r) {
    var bot = r && r.json && r.json.bot;
    var s = bot ? bot.open_profile_state : '';
    var pn = str(bot && bot.open_profile && bot.open_profile.name);
    // 다시 읽기에서 이번 SYNCLINK 가 실패하면 남긴 판정이 그대로라, 판정 대신 읽기 실패를 알린다
    if (r && r.json && r.json.read_ok === false) {
      var st = r.json.read_status;
      toast('카카오에서 오픈프로필 목록을 읽지 못했습니다' + (typeof st === 'number' ? '(카카오 상태 ' + st + ')' : '') +
        '. 저장된 목록을 그대로 씁니다', 'bad');
    } else if (s === 'ok') toast('오픈프로필 「' + pn + '」' + ro(pn) + ' 입장합니다', 'ok');
    else if (s === 'none') toast('오픈프로필이 없습니다. 카카오톡에서 먼저 만들어 주세요', 'bad');
    else if (s === 'gone') toast('고른 오픈프로필을 찾지 못했습니다. 다시 골라 주세요', 'bad');
    else toast('오픈프로필을 아직 확인하지 못했습니다', 'bad');
    afterBotChange();
    return bot;
  }

  function refreshBotProfile(b, button) {
    busyBtn(button, true);
    api('POST', '/admin/bot-open-profile', { device_id: b.device_id, refresh: true }).then(function (r) {
      busyBtn(button, false);
      if (kicked(r)) return;
      if (!r.ok) { toast(errText(r, '오픈프로필을 읽지 못했습니다'), 'bad'); return; }
      profileDone(r);
    });
  }

  // 오픈프로필 고르기 · 다시 읽기 · 링크로 확인(SYNCLINK 가 오픈프로필을 보여 주지 않을 때의 대안)
  function openBotProfile(b0) {
    var b = b0;
    var gname = 'mg-prof-' + String(b.device_id).replace(/[^A-Za-z0-9]/g, '');
    var m = modal({ title: '오픈프로필 선택', wide: true });
    var okBtn = btn('저장', 'primary');
    var readBtn = btn('다시 읽기', '');
    var urlIn = textInput({ type: 'url', inputmode: 'url', max: 200, placeholder: 'https://open.kakao.com/me/…' });
    var urlBtn = btn('링크로 확인', 'sm');
    function opt(value, title, sub, checked) {
      var radio = el('input', { type: 'radio', name: gname, value: value, checked: !!checked });
      return el('label', { cls: 'chk' }, [radio, el('span', { cls: 'box', 'aria-hidden': 'true' }),
        el('span', { cls: 't' }, [el('span', { style: 'color:var(--fg)', text: title }), sub ? el('span', { cls: 'mg-meta', text: sub }) : null])]);
    }
    function render() {
      var list = Array.isArray(b.open_profiles) ? b.open_profiles : [];
      var cur = b.open_profile_state === 'ok' && b.open_profile ? b.open_profile : null;
      var pick = el('div', { cls: 'mg-pick', role: 'radiogroup', 'aria-label': '방에 쓸 오픈프로필' });
      pick.appendChild(opt('', '자동', '현재 쓰는 오픈프로필을 계속 쓰고, 없으면 목록의 첫 번째를 씁니다', !b.open_profile_pick));
      list.forEach(function (p) {
        var sub = [shortLink(p.url) || '링크 확인 전'];
        if (cur && cur.li === p.li) sub.push('현재 사용 중');
        pick.appendChild(opt(p.li, str(p.name) || '이름 없음', sub.join(' · '), b.open_profile_pick === p.li));
      });
      okBtn.disabled = !list.length;
      m.setBody([
        kv([['K bot 계정', botTitle(b)], ['카카오 계정', b.email || '-', 'mono'],
            ['현재 사용 중', cur ? '「' + (str(cur.name) || '이름 없음') + '」' : (b.open_profile_state === 'none' ? '없음' : '확인 전')],
            ['마지막 확인', num(b.open_profile_at) ? dateKr(b.open_profile_at, true) : '-']]),
        note('방장과 구성원에게는 이 오픈프로필의 이름과 사진이 보입니다. 봇마다 이름이 달라야 방장이 부방장으로 지정할 계정을 찾을 수 있습니다. 오픈프로필이 없으면 기본 프로필로 대신 입장하지 않고, 오픈프로필이 생길 때까지 기다립니다.'),
        list.length ? sec('방에 쓸 오픈프로필', pick) : el('div', { cls: 'mg-crit', text: PROFILE_HINT.none }),
        sec('목록에 없을 때', [
          para('카카오톡에서 이 계정으로 오픈프로필을 만들었는데 목록에 없으면 [다시 읽기]를 눌러 주세요. 그래도 없으면 그 오픈프로필의 링크를 넣고 [링크로 확인]을 눌러 주세요. 이 계정으로 만든 오픈프로필만 추가할 수 있습니다.'),
          el('div', { cls: 'mg-numrow' }, [urlIn, urlBtn])
        ])
      ]);
    }
    function after(r, button) {
      busyBtn(button, false);
      m.busy = false;
      if (kicked(r)) return false;
      if (!r.ok) { m.error(errText(r, '처리하지 못했습니다')); return false; }
      m.error('');
      if (r.json && r.json.bot) b = r.json.bot;
      return true;
    }
    readBtn.addEventListener('click', function () {
      if (m.busy) return;
      m.busy = true;
      busyBtn(readBtn, true);
      api('POST', '/admin/bot-open-profile', { device_id: b.device_id, refresh: true }).then(function (r) {
        if (!after(r, readBtn)) return;
        render();
        profileDone(r);
      });
    });
    urlBtn.addEventListener('click', function () {
      if (m.busy) return;
      var u = String(urlIn.value || '').trim();
      if (!/^https:\/\/open\.kakao\.com\/me\/[A-Za-z0-9_-]+$/.test(u)) { m.error('https://open.kakao.com/me/로 시작하는 오픈프로필 링크를 넣어 주세요'); return; }
      m.busy = true;
      busyBtn(urlBtn, true);
      api('POST', '/admin/bot-open-profile', { device_id: b.device_id, url: u }).then(function (r) {
        if (!after(r, urlBtn)) return;
        urlIn.value = '';
        render();
        profileDone(r);
      });
    });
    okBtn.addEventListener('click', function () {
      if (m.busy) return;
      var chosen = $('input[name="' + gname + '"]:checked', m.dlg);
      var li = chosen && chosen.value ? chosen.value : null;
      m.error('');
      m.setBusy(true, okBtn);
      api('POST', '/admin/bot-open-profile', { device_id: b.device_id, li: li }).then(function (r) {
        m.setBusy(false, okBtn);
        if (kicked(r)) return;
        if (!r.ok) { m.error(errText(r, '저장하지 못했습니다')); return; }
        m.close();
        profileDone(r);
      });
    });
    m.setActions([btn('닫기', 'ghost', function () { if (!m.busy) m.close(); }), readBtn, okBtn]);
    render();
  }

  function openBotEnable(b) {
    var on = !b.enabled;
    confirmAct({
      title: on ? '새 방 받기 재개' : '새 방 받기 중지',
      body: [kv([['K bot 계정', botTitle(b)], ['카카오 계정', b.email || '-', 'mono'], ['맡은 방', (num(b.rooms_n) || 0) + '개']]),
             para(on ? '새로 결제된 방을 이 계정이 다시 받습니다.' : '이 계정은 새 방을 받지 않습니다. 이미 맡은 방은 그대로 둡니다.')],
      ok: on ? '재개' : '중지',
      run: function () { return api('POST', '/admin/bot-update', { device_id: b.device_id, enabled: on }); },
      failMsg: '바꾸지 못했습니다',
      done: function () { toast(on ? '새 방 받기를 재개했습니다' : '새 방 받기를 중지했습니다', 'ok'); afterBotChange(); }
    });
  }

  function openBotCap(b) {
    var cap = textInput({ type: 'number', mono: true, inputmode: 'numeric', min: '1', maxv: 200, step: '1', value: String(num(b.room_cap) || BOTS.defaultCap), autofocus: true });
    cap.style.width = '112px';
    function parse() { var n = Math.floor(Number(cap.value)); return isFinite(n) && n >= 1 && n <= 200 && String(cap.value).indexOf('.') < 0 ? n : 0; }
    confirmAct({
      title: '최대 방 수 변경',
      body: [
        kv([['K bot 계정', botTitle(b)], ['맡은 방', (num(b.rooms_n) || 0) + '개'], ['현재 최대 방 수', (num(b.room_cap) || 0) + '개']]),
        para('이 계정이 맡을 수 있는 방의 수입니다. 맡은 방보다 낮추어도 이미 맡은 방은 옮기지 않습니다. 방이 많을수록 이 계정의 부담이 커지니 너무 높게 잡지 마세요.'),
        el('div', { cls: 'fld' }, [el('label', { text: '최대 방 수' }), el('div', { cls: 'mg-numrow' }, [cap, el('span', { cls: 'dim tiny', text: '개 (1~200)' })])])
      ],
      ok: '변경',
      check: function () { return parse() ? '' : '최대 방 수는 1~200개로 입력해 주세요'; },
      run: function () { return api('POST', '/admin/bot-update', { device_id: b.device_id, room_cap: parse() }); },
      failMsg: '바꾸지 못했습니다',
      done: function () { toast('최대 방 수를 ' + parse() + '개로 바꿨습니다', 'ok'); afterBotChange(); }
    });
  }

  function openBotRemove(b) {
    confirmAct({
      title: 'K bot 계정 삭제',
      danger: true,
      body: [
        kv([['K bot 계정', botTitle(b)], ['카카오 계정', b.email || '-', 'mono'], ['맡은 방', (num(b.rooms_n) || 0) + '개']]),
        note('이 카카오 계정의 연결을 끊고 목록에서 뺍니다. 맡은 방이나 처리하지 않은 퇴장이 있으면 삭제할 수 없습니다. 먼저 [방] 탭에서 다른 K bot 계정으로 옮겨 주세요.', true)
      ],
      ok: '삭제',
      run: function () { return api('POST', '/admin/bot-remove', { device_id: b.device_id }); },
      failMsg: '삭제하지 못했습니다',
      done: function () { toast('K bot 계정을 삭제했습니다', 'ok'); afterBotChange(); }
    });
  }

  // 등록 마법사(콘솔 계정 등록과 같은 단계). bot = 재등록할 계정 또는 null
  function openBotRegister(bot) {
    var st = { pendingId: '', deviceId: bot ? bot.device_id : '', gen: 0, done: false, email: '' };
    var m = modal({ title: bot ? 'K bot 계정 재등록' : 'K bot 계정 등록', onClose: function () {
      st.gen++;
      if (st.pendingId && !st.done) api('POST', '/admin/bot-register/cancel', { pending_id: st.pendingId });
      if (st.done) afterBotChange();
    } });

    var email = textInput({ max: 80, placeholder: '카카오 계정 이메일 또는 전화번호', autocomplete: 'off', value: bot ? (bot.email || '') : '', autofocus: true });
    var pw = textInput({ type: 'password', max: 200, autocomplete: 'new-password' });
    var label = textInput({ max: 40, placeholder: '예: K bot 3 (관리용 메모)', value: bot ? (bot.label || '') : '' });
    var cap = textInput({ type: 'number', mono: true, inputmode: 'numeric', min: '1', maxv: 200, step: '1', value: String(bot ? (num(bot.room_cap) || BOTS.defaultCap) : BOTS.defaultCap) });
    var forceBox = el('div', { hidden: true });

    function step1(msg) {
      st.pendingId = '';
      m.setTitle(bot ? 'K bot 계정 재등록' : 'K bot 계정 등록');
      clear(forceBox);
      forceBox.hidden = true;
      m.setBody([
        note(bot ? '같은 K bot 계정 ID로 다시 로그인합니다. 맡은 방과 설정은 그대로 이어집니다.'
                 : '운영자 명의의 카카오 계정을 K bot 계정으로 등록합니다. 고객 계정과 다른 계정을 써 주세요. 봇은 고객 방에 이 계정의 오픈프로필로 들어가므로, 카카오톡에서 오픈프로필을 하나 만들고 이름은 다른 K bot 계정과 겹치지 않게 정해 주세요.'),
        field('카카오 계정', email, null, 'brEmail'),
        field('비밀번호', pw, '비밀번호는 카카오 로그인 확인에만 쓰고 저장하지 않습니다.', 'brPw'),
        el('div', { cls: 'mg-row2' }, [
          field('관리용 이름 (선택)', label, null, 'brLabel'),
          el('div', { cls: 'fld' }, [el('label', { for: 'brCap', text: '최대 방 수' }), el('div', { cls: 'mg-numrow' }, [cap, el('span', { cls: 'dim tiny', text: '개' })])])
        ]),
        forceBox
      ]);
      cap.id = 'brCap';
      cap.style.width = '112px';
      var next = btn('다음', 'primary', function () { begin(false, next); });
      m.setActions([btn('닫기', 'ghost', function () { if (!m.busy) m.close(); }), next]);
      m.error(msg || '');
    }

    function begin(forced, b) {
      if (m.busy) return;
      var e = str(email.value), p = pw.value;
      if (!e) { m.error('카카오 계정을 입력해 주세요'); email.focus(); return; }
      if (!p) { m.error('비밀번호를 입력해 주세요'); pw.focus(); return; }
      var c = Math.floor(Number(cap.value));
      if (!isFinite(c) || c < 1 || c > 200) { m.error('최대 방 수는 1~200개로 입력해 주세요'); cap.focus(); return; }
      m.error('');
      m.setBusy(true, b);
      st.email = e;
      var body = { email: e, password: p, label: str(label.value) || null, room_cap: c, forced: !!forced };
      if (st.deviceId) body.device_id = st.deviceId;
      api('POST', '/admin/bot-register/begin', body).then(function (r) {
        m.setBusy(false, b);
        if (kicked(r)) return;
        if (!r.ok) { m.error(errText(r, '등록하지 못했습니다')); return; }
        var v = r.json;
        // 새 봇은 등록을 마친 뒤에만 id 를 쥔다. 실패·취소 뒤 다시 [다음]을 누르면 서버가 새 id 를 다시 만든다.
        if (v.device_id && (bot || v.state === 'ok')) st.deviceId = v.device_id;
        if (v.state === 'ok') { pw.value = ''; done(); return; }
        if (v.state === 'confirm_on_phone') { step2(v); return; }
        m.error(v.text || '등록하지 못했습니다. 입력한 계정을 확인한 뒤 다시 시도해 주세요.');
        if (v.can_force) {
          clear(forceBox);
          forceBox.hidden = false;
          var fb = btn('다른 기기 끊기', 'sm primary', function () { begin(true, fb); });
          forceBox.appendChild(el('div', { cls: 'note warn' }, [
            el('span', { cls: 'ic', 'aria-hidden': 'true', text: '!' }),
            el('span', { cls: 'mg-sec' }, [
              el('span', null, [el('b', { text: '같은 계정이 다른 태블릿·PC에 접속되어 있어 등록하지 못했습니다.' }),
                ' 다른 기기 접속을 끊으면 그 기기의 카카오톡이 로그아웃되고 등록을 다시 진행합니다.']),
              el('span', null, fb)
            ])
          ]));
        }
      });
    }

    function step2(v) {
      st.pendingId = v.pending_id || st.pendingId;
      m.setTitle('휴대폰 확인');
      var started = Date.now();
      var elapsed = el('span', { cls: 'el', text: '0초' });
      var waitTxt = el('span', { text: '카카오톡 확인을 기다리는 중입니다' });
      var hasCode = !!v.passcode;
      m.setBody([
        el('div', { cls: 'big hi' }, [
          el('div', { cls: 'k', text: hasCode ? '휴대폰 카카오톡에 아래 번호를 입력해 주세요' : '휴대폰 카카오톡에서 로그인을 확인해 주세요' }),
          hasCode ? el('div', { cls: 'mg-keybox' }, [el('div', { cls: 'v key', text: String(v.passcode), 'aria-label': '확인 번호 ' + v.passcode }), copyBtn(String(v.passcode), '확인 번호가', '번호 복사')]) : null,
          el('div', { cls: 'tiny dim' }, [el('span', { cls: 'mono', text: st.email }),
            v.remaining_seconds ? ' · 유효 시간 약 ' + Math.ceil(v.remaining_seconds / 60) + '분' : ''])
        ]),
        el('div', { cls: 'wait' }, [
          el('i', { cls: 'dot live pulse', 'aria-hidden': 'true' }),
          el('span', { cls: 'txt' }, [waitTxt, el('span', { cls: 'dots', 'aria-hidden': 'true' }, [el('i'), el('i'), el('i')])]),
          elapsed
        ]),
        el('p', { cls: 'hint', text: '이 계정이 로그인된 휴대폰의 카카오톡에서 확인하면 이 창이 자동으로 다음 단계로 넘어갑니다. 2초마다 확인합니다.' })
      ]);
      m.setActions([btn('취소', 'ghost', function () {
        var pid = st.pendingId;
        st.gen++;
        st.pendingId = '';
        if (pid) api('POST', '/admin/bot-register/cancel', { pending_id: pid });
        step1('');
      })]);
      var gen = ++st.gen;
      var tick = setInterval(function () {
        if (gen !== st.gen || !m.isOpen()) { clearInterval(tick); return; }
        elapsed.textContent = Math.floor((Date.now() - started) / 1000) + '초';
      }, 1000);
      (function loop() {
        if (gen !== st.gen || !m.isOpen() || !st.pendingId) { clearInterval(tick); return; }
        api('POST', '/admin/bot-register/confirm', { pending_id: st.pendingId }).then(function (r) {
          if (gen !== st.gen || !m.isOpen()) { clearInterval(tick); return; }
          if (kicked(r)) { clearInterval(tick); return; }
          if (!r.ok) {
            m.error('연결이 잠깐 끊겼습니다. 카카오톡 확인을 계속 기다립니다.');
            sleep(2000).then(loop);
            return;
          }
          var v2 = r.json;
          m.error('');
          if (v2.state === 'ok') { clearInterval(tick); pw.value = ''; if (v2.device_id) st.deviceId = v2.device_id; done(); return; }
          if (v2.state === 'waiting') { waitTxt.textContent = '아직 카카오톡에서 확인되지 않았습니다. 계속 기다립니다'; sleep(2000).then(loop); return; }
          if (v2.state === 'confirm_on_phone') { clearInterval(tick); step2(v2); return; }
          clearInterval(tick);
          st.pendingId = '';
          step1(v2.text || '확인 시간이 지났습니다. 처음부터 다시 등록해 주세요.');
        });
      })();
    }

    function done() {
      st.done = true;
      st.pendingId = '';
      m.setTitle(bot ? '재등록 완료' : '등록 완료');
      m.setBody([
        el('div', { cls: 'chip-row' }, [chip(bot ? '재등록 완료' : '등록 완료', 'ok')]),
        para(bot ? '다시 연결되었습니다. 맡은 방은 K bot이 방에 있는지와 권한을 확인한 뒤 이어서 동작합니다.'
                 : '등록되었습니다. 결제된 방 가운데 K bot 계정을 기다리는 방이 있으면 1분 안에 이 계정이 맡습니다.'),
        kv([
          ['카카오 계정', st.email, 'mono'],
          ['K bot 계정 ID', st.deviceId, 'mono'],
          ['닉네임', bot && bot.nickname ? bot.nickname : '접속하면 자동으로 채워집니다']
        ]),
        el('p', { cls: 'hint', text: '오픈프로필이 없으면 목록에 「오픈프로필 없음」이 표시되고 방에 입장하지 않습니다. 오픈프로필 이름이 다른 K bot 계정과 같으면 「이름 중복」이 표시됩니다. 그때는 카카오톡에서 이 계정의 오픈프로필 이름을 바꿔 주세요.' })
      ]);
      var close = btn('닫기', 'primary', function () { m.close(); }, { 'data-autofocus': '' });
      m.setActions([close]);
      try { close.focus(); } catch (e) { /* 없음 */ }
    }

    step1('');
    try { email.focus(); } catch (e) { /* 없음 */ }
  }

  /* ══════════════════ 12. 설치한 방 ══════════════════
     상태 라벨·보조 문구는 서버(installs.publicView)가 준 label·detail 을 그대로 쓴다. */

  var ROOMS = { filter: '', q: '', bot: '', botName: '', gen: 0 };

  // 「K bot 테스트 1」 (관리용 이름)
  function botName(v) {
    var nick = str(v.bot_nickname) || '닉네임 확인 전';
    return '「' + nick + '」' + (str(v.bot_label) && str(v.bot_label) !== nick ? ' ' + str(v.bot_label) : '');
  }

  function productTags(v) {
    var out = [];
    var p = v.products || {};
    var pp = v.pending_products || {};
    roomProductIds().forEach(function (id) {
      if (p[id]) out.push(tag(plabel(id), ''));
      else if (pp[id]) out.push(tag(plabel(id) + ' · 입금 대기', 'line'));
    });
    if (!out.length && !roomProductIds().length) {
      if (p.roombot) out.push(tag('roombot', ''));
      if (p.minigame) out.push(tag('minigame', ''));
    }
    return out;
  }

  // 검토 대기 사유(hold_reason 'name:<단어>') → 화면 문구
  function holdText(h) {
    var s = str(h);
    return s.indexOf('name:') === 0 ? '방 이름에 「' + s.slice(5) + '」 포함' : s;
  }

  function roomReason(v) {
    var parts = [];
    if (v.hold_reason) parts.push('검토 대기 · ' + holdText(v.hold_reason));
    if (v.raw_error_code) parts.push('오류 코드 ' + v.raw_error_code);
    if (v.raw_error_code === 'bot_no_open_profile') parts.push(v.error_detail === 'gone' ? '고른 오픈프로필 없음' : (v.error_detail === 'none' ? '봇에 오픈프로필 없음' : '오픈프로필 확인 필요'));
    else if (v.error_detail) parts.push(v.error_detail === 'no_bot' ? '방을 맡을 K bot 계정 없음' : (v.error_detail === 'rate_limited' ? '카카오 입장 제한으로 대기 중' : v.error_detail));
    if (num(v.next_try_at) && num(v.next_try_at) > Date.now()) parts.push(hhmm(v.next_try_at) + ' 다시 입장');
    return parts.join(' · ');
  }

  function loadRooms() {
    var my = ++ROOMS.gen;
    var box = $('#roomList');
    if (isLoadingBox(box)) listState(box, '불러오는 중…');
    var q = '/admin/rooms?limit=300&display=' + encodeURIComponent(ROOMS.filter) +
      (ROOMS.q ? '&q=' + encodeURIComponent(ROOMS.q) : '') + (ROOMS.bot ? '&bot=' + encodeURIComponent(ROOMS.bot) : '');
    renderRoomScope();
    loadBlocks();
    return api('GET', q).then(function (r) {
      if (my !== ROOMS.gen) return;
      if (kicked(r)) return;
      if (!r.ok) { listState(box, '방 목록을 불러오지 못했습니다\n' + errText(r), true); $('#roomCount').textContent = ''; return; }
      var list = r.json.rooms || [];
      var c = r.json.counts || {};
      var cnt = { '': c.live, attention: c.attention, hold: c.hold, waiting: c.waiting, active: c.active, pending: c.pending };
      $$('#roomFilt button').forEach(function (b) {
        var f = b.getAttribute('data-f');
        var em = $('em', b);
        if (!em) { em = el('em'); b.appendChild(em); }
        em.textContent = num(cnt[f]) === null ? '' : String(cnt[f]);
      });
      $('#roomCount').textContent = list.length + '개 표시' + (list.length >= 300 ? ' (최근 300개까지)' : '') + ' · 최근 설치 순';
      clear(box);
      if (!list.length) {
        listState(box, ROOMS.q || ROOMS.bot ? '조건에 맞는 방이 없습니다' : (ROOMS.filter ? '해당 상태의 방이 없습니다' : '설치한 방이 없습니다.\n회원이 방 관리봇·미니게임봇을 결제하거나 [봇 무료 설치]로 설치하면 이 목록에 표시됩니다.'));
        return;
      }
      list.forEach(function (v) { box.appendChild(roomItem(v)); });
    });
  }

  function renderRoomScope() {
    var box = $('#roomScope');
    clear(box);
    if (!ROOMS.bot) { box.hidden = true; return; }
    box.hidden = false;
    box.appendChild(el('span', { text: 'K bot 계정 「' + (ROOMS.botName || ROOMS.bot) + '」의 방만 표시합니다' }));
    box.appendChild(btn('전체 보기', 'sm ghost', function () { ROOMS.bot = ''; ROOMS.botName = ''; listState($('#roomList'), '불러오는 중…'); loadRooms(); }));
  }

  function showRoomsForBot(b) {
    ROOMS.bot = b.device_id;
    ROOMS.botName = botTitle(b);
    ROOMS.filter = '';
    ROOMS.q = '';
    $('#roomQ').value = '';
    setFilter('#roomFilt', '');
    if (TAB === 'rooms') { listState($('#roomList'), '불러오는 중…'); loadRooms(); } else switchTab('rooms');
  }

  function roomItem(v) {
    var live = v.phase === 'installed' || v.phase === 'pending_payment';
    var cls = 'mg-item';
    if (v.display === 'error') cls += ' alert';
    else if (v.hold_reason) cls += ' review';
    if (!live) cls += ' dim';
    var item = el('article', { cls: cls, 'aria-label': '방 #' + v.id });
    item.appendChild(el('div', { cls: 'mg-r1' }, [
      el('span', { cls: 'grow' }, el('button', { type: 'button', cls: 'mg-link sans', text: v.link_name || '이름 확인 전',
        'aria-label': '방 #' + v.id + ' 상세 열기', onclick: function () { openRoom(v.id); } })),
      productTags(v),
      v.hold_reason ? tag('검토 대기', 'warn') : null,
      ROOM_PROFILE[v.bot_profile] ? tag(ROOM_PROFILE[v.bot_profile].t, ROOM_PROFILE[v.bot_profile].c) : null,
      chip(v.label, ROOM_CLS[v.display] || '')
    ]));
    item.appendChild(el('div', { cls: 'mg-line' }, [
      el('span', { cls: 'mono', text: shortLink(v.link_url) }), ' · 회원 ',
      inl(v.member && v.member.login_id ? v.member.login_id : '#' + (v.member ? v.member.id : '-'), function () { openMember(v.member.id); })
    ]));
    if (v.detail && (v.display === 'error' || v.display === 'waiting' || v.display === 'joining')) {
      item.appendChild(el('div', { cls: v.display === 'error' ? 'mg-crit' : 'mg-meta', text: v.detail }));
    }
    var meta = ['방 #' + v.id];
    meta.push(v.bot_device_id ? 'K bot 계정 ' + botName(v) : 'K bot 계정 없음');
    var reason = roomReason(v);
    if (reason) meta.push(reason);
    meta.push('입장 시도 ' + (num(v.attempts) || 0) + '회');
    meta.push('고객 다시 시도 ' + (num(v.retry_n) || 0) + '회');
    if (v.phase === 'removed') meta.push('설치 해제 ' + dateKr(v.removed_at, true));
    if (v.phase === 'canceled') meta.push('주문 취소됨');
    if (v.order_id) meta.push('주문 ' + v.order_id);
    item.appendChild(el('div', { cls: 'mg-meta', text: meta.join(' · ') }));
    item.appendChild(roomActs(v, function () { loadStats(); loadRooms(); }));
    return item;
  }

  // 방 동작 줄(목록·상세 공통)
  function roomActs(v, changed, inDetail) {
    var sm = inDetail ? '' : 'sm';
    var acts = el('div', { cls: inDetail ? 'btn-row' : 'mg-acts', style: inDetail ? 'margin-top:0' : null });
    if (!inDetail) acts.appendChild(btn('상세', 'sm', function () { openRoom(v.id); }));
    if (v.phase === 'installed') {
      if (v.hold_reason) acts.appendChild(btn('입장 허용', (sm + ' primary').trim(), function () { openRoomRelease(v, changed); }));
      acts.appendChild(btn('다시 시도', sm, function () { openRoomRetry(v, changed); }));
      acts.appendChild(btn('다른 봇으로 이동', sm, function () { openRoomMove(v, changed); }));
      acts.appendChild(btn('링크 바꾸기', sm, function () { openRoomRebind(v, changed); }));
      acts.appendChild(btn('봇 변경', sm, function () { openRoomProducts(v, changed); }));
      acts.appendChild(btn('다른 회원에게 넘기기', sm, function () { openRoomTransfer(v, changed); }));
      acts.appendChild(btn('설치 해제', (sm + ' danger').trim(), function () { openRoomRemove(v, changed); }));
      acts.appendChild(btn('방 차단', (sm + ' danger').trim(), function () { openRoomBlock(v, changed); }));
    } else if (v.phase === 'pending_payment' && v.order_id) {
      acts.appendChild(btn('주문 보기', sm, function () { ORD.filter = 'open'; setFilter('#ordFilt', 'open'); closeAllModals(); switchTab('orders'); }));
    }
    return acts;
  }

  function roomHead(v) {
    return kv([
      ['방', v.link_name || '이름 확인 전'],
      ['링크', shortLink(v.link_url), 'mono'],
      ['회원', v.member && v.member.login_id ? v.member.login_id : '-'],
      ['상태', v.label]
    ]);
  }

  function openRoom(id, outerChanged) {
    var m = modal({ title: '방 상세', wide: true, light: true, body: empty('불러오는 중…'),
                    onClose: function () { if (TAB === 'rooms') loadRooms(); } });
    m.setActions([btn('닫기', 'ghost', function () { m.close(); })]);
    var gen = 0;
    function refresh() {
      var my = ++gen;
      return api('GET', '/admin/room?id=' + encodeURIComponent(String(id))).then(function (r) {
        if (my !== gen || !m.isOpen()) return;
        if (kicked(r)) return;
        if (!r.ok) { m.setBody(empty(errText(r, '방을 불러오지 못했습니다'), true)); return; }
        renderRoomDetail(m, r.json, function () { loadStats(); refresh(); if (outerChanged) outerChanged(); });
      });
    }
    refresh();
  }

  function renderRoomDetail(m, j, changed) {
    var v = j.room || {};
    m.setTitle('방 상세 · #' + v.id);
    var top = el('div', { cls: 'big hi' }, [
      el('div', { cls: 'k', text: '방 #' + v.id + (v.phase === 'removed' ? ' · 설치 해제' : (v.phase === 'canceled' ? ' · 주문 취소됨' : '')) }),
      el('div', { cls: 'v', text: v.link_name || '이름 확인 전' }),
      el('div', { cls: 'chip-row', style: 'margin-top:10px' }, [chip(v.label, ROOM_CLS[v.display] || ''), productTags(v),
        v.hold_reason ? tag('검토 대기', 'warn') : null])
    ]);
    var alerts = [];
    if (v.detail) alerts.push(note(v.detail, v.display === 'error' || v.display === 'waiting'));
    if (v.hold_reason) alerts.push(note('방 이름에 검토 대상 단어가 있어 입장을 보류했습니다(' + holdText(v.hold_reason) + '). 문제가 없으면 [입장 허용]을 눌러 주세요.', true));
    var live = j.live;
    var info = kv([
      ['링크', [el('span', { cls: 'mono', text: shortLink(v.link_url) }), ' ', copyBtn(v.link_url, '링크가', '복사')]],
      ['링크 ID', v.link_id || '확인 전', v.link_id ? 'mono' : null],
      ['채팅 ID', v.chat_id || '-', v.chat_id ? 'mono' : null],
      ['회원', [inl(v.member && v.member.login_id ? v.member.login_id : '-', function () { openMember(v.member.id); }), ' · #' + (v.member ? v.member.id : '-')]],
      ['K bot 계정', v.bot_device_id ? [botName(v) + ' · ', el('span', { cls: 'mono', text: v.bot_device_id })] : '없음'],
      ['상태', (v.label || '-') + ' (' + [v.state || '-', v.raw_error_code, v.error_detail].filter(Boolean).join(' · ') + ')'],
      ['권한', (num(v.perm) ? ((num(v.perm) & 5) ? '관리 권한 있음' : '관리 권한 없음') + ' (값 ' + String(v.perm) + ')' : '-') +
        (live ? ' · 현재 ' + (live.connected ? '연결됨' : '연결 안 됨') + (live.perm !== undefined && live.perm !== null ? ' · 권한 값 ' + live.perm : '') : '')],
      live && live.profile ? ['봇 프로필', roomProfileText(live.profile)] : null,
      ['입장 시도', (num(v.attempts) || 0) + '회' + (num(v.next_try_at) ? ' · 다음 ' + dateKr(v.next_try_at, true) : '')],
      ['고객 다시 시도', (num(v.retry_n) || 0) + '회' + (num(v.retry_at) ? ' · 마지막 ' + dateKr(v.retry_at, true) : '')],
      ['참여코드', v.has_passcode ? '저장됨(값은 표시하지 않음)' : '없음'],
      ['주문', v.order_id || '무료 설치(관리자)', v.order_id ? 'mono' : null],
      ['설치일', dateKr(v.installed_at || v.created_at, true) + (num(v.joined_at) ? ' · 입장 ' + dateKr(v.joined_at, true) : '')],
      v.phase === 'removed' ? ['설치 해제', dateKr(v.removed_at, true)] : null
    ]);
    var leaves = Array.isArray(j.leaves) ? j.leaves : [];
    var leaveBox = leaves.length ? el('div', { cls: 'mg-rows' }, leaves.map(function (l) {
      return el('div', { cls: 'mg-row' }, [el('div', { cls: 't' }, [
        el('span', { text: (LEAVE_WHY[l.why] || l.why) + ' · ' + dateKr(l.created_at, true) }),
        el('span', { cls: 'mg-meta' }, [el('span', { cls: 'mono', text: l.bot_device_id }), l.result ? ' · ' + l.result : ' · 처리 대기'])
      ])]);
    })) : null;
    var logs = Array.isArray(j.log) ? j.log : [];
    var logBox = el('div');
    if (!logs.length) logBox.appendChild(el('p', { cls: 'mg-meta', text: '기록이 없습니다' }));
    logs.forEach(function (x) {
      logBox.appendChild(el('div', { cls: 'mg-log' }, [
        el('time', { text: dateKr(x.at, true, true) }),
        el('span', null, [chip(x.text || x.kind, x.ok === false ? 'bad' : '')]),
        x.detail && Object.keys(x.detail).length ? el('span', { cls: 'd', text: JSON.stringify(x.detail) }) : null
      ]));
    });
    var cfg = el('pre', { cls: 'mg-raw scroll', text: JSON.stringify(j.config || {}, null, 2) });
    var lp = live && live.profile;
    var profBox = null;
    if (v.phase === 'installed' && lp && lp.state !== 'open') {
      profBox = el('div', null, [
        para(lp.state === 'failed'
          ? '카카오가 오픈프로필로 바꾸기를 거절했습니다. 방은 그대로 동작합니다. 꼭 바꿔야 하면 [다시 입장(오픈프로필)]을 눌러 주세요. 다시 입장하면 방장이 부방장을 다시 지정해야 합니다.'
          : '봇이 이 방에 오픈프로필이 아닌 프로필로 들어가 있습니다. [오픈프로필로 바꾸기]는 나가지 않고 프로필만 바꿉니다.'),
        el('div', { cls: 'btn-row', style: 'margin-top:0' }, [
          btn('오픈프로필로 바꾸기', 'primary', function () { openRoomProfile(v, 'switch', lp, changed); }),
          btn('다시 입장(오픈프로필)', 'danger', function () { openRoomProfile(v, 'rejoin', lp, changed); })
        ])
      ]);
    }
    m.setBody([
      top,
      alerts,
      v.phase === 'installed' ? sec('관리', roomActs(v, changed, true)) : null,
      profBox ? sec('봇 프로필', profBox) : null,
      sec('정보', info),
      leaveBox ? sec('처리 대기 중인 퇴장 ' + leaves.length + '개', leaveBox) : null,
      sec('설정 · 버전 ' + (num(j.config_rev) || 0) + (num(j.config_at) ? ' · ' + dateKr(j.config_at, true) : ''), cfg),
      sec('조치 기록 ' + logs.length + '건 (최근 ' + 100 + '건)', logBox)
    ]);
  }

  function roomDone(msg, changed) { return function () { toast(msg, 'ok'); if (changed) changed(); }; }

  // live.profile = {state: open|main|other|failed|unknown, name, fail, fail_at, queued, target}
  function roomProfileText(p) {
    var name = str(p.name) ? ' 「' + str(p.name) + '」' : '';
    var t;
    if (p.state === 'open') t = '오픈프로필' + name;
    else if (p.state === 'main') t = '기본 프로필' + name + ' · 오픈프로필로 바꾸기 전';
    else if (p.state === 'other') t = '다른 오픈프로필' + name + (str(p.target) ? ' · 고른 오픈프로필 「' + str(p.target) + '」' : '');
    else if (p.state === 'failed') t = '바꾸기 거절(' + (typeof p.fail === 'number' ? '카카오 상태 ' + p.fail : '바뀌지 않음') +
      (num(p.fail_at) ? ' · ' + dateKr(p.fail_at, true) : '') + ')' + name;
    else t = '확인 전';
    if (p.queued) t += p.queued === 'rejoin' ? ' · 다시 입장 대기' : ' · 바꾸기 대기';
    return t;
  }

  function openRoomProfile(v, how, lp, changed) {
    var target = str(lp && lp.target);
    var who = target ? '오픈프로필 「' + target + '」' : '이 K bot 계정의 오픈프로필';
    var whoRo = who + (target ? ro(target) : '로');
    confirmAct({
      title: how === 'rejoin' ? '다시 입장(오픈프로필)' : '오픈프로필로 바꾸기',
      danger: how === 'rejoin',
      body: how === 'rejoin'
        ? [roomHead(v), note('봇이 방에서 나갔다가 ' + whoRo + ' 다시 들어갑니다. 방장이 부방장을 다시 지정해야 방 관리봇이 동작하고, 방에 입장 안내가 다시 나갑니다. [오픈프로필로 바꾸기]가 거절된 방에만 써 주세요.', true)]
        : [roomHead(v), para('봇이 방에서 나가지 않고 프로필만 ' + whoRo + ' 바꿉니다. 카카오가 거절하면 방은 그대로 두고 거절 사유를 기록합니다. 이 봇의 입장 대기 순서대로 처리하므로 1~2분 걸릴 수 있습니다.')],
      ok: how === 'rejoin' ? '다시 입장' : '바꾸기',
      run: function () { return api('POST', '/admin/room-profile', { id: v.id, how: how }); },
      failMsg: '요청하지 못했습니다',
      done: roomDone(how === 'rejoin' ? '다시 입장을 요청했습니다' : '오픈프로필로 바꾸기를 요청했습니다', changed)
    });
  }

  function openRoomRetry(v, changed) {
    confirmAct({
      title: '다시 시도',
      body: [roomHead(v), para('상태와 오류에 관계없이 처음부터 다시 입장합니다. 고객 다시 시도 횟수와 다음 입장까지의 대기 시간이 초기화됩니다. 이미 방에 있으면 입장 없이 상태만 다시 확인합니다.')],
      ok: '다시 시도',
      run: function () { return api('POST', '/admin/room-retry', { id: v.id }); },
      failMsg: '다시 시도하지 못했습니다',
      done: roomDone('다시 입장 대기 목록에 넣었습니다', changed)
    });
  }

  function openRoomRelease(v, changed) {
    confirmAct({
      title: '입장 허용',
      body: [roomHead(v), kv([['보류 사유', holdText(v.hold_reason) || '-']]),
             para('검토 대기를 풀고 이 방을 맡을 K bot 계정을 정해 입장합니다. 차단할 방이면 이 버튼 대신 [방 차단]을 눌러 주세요.')],
      ok: '입장 허용',
      run: function () { return api('POST', '/admin/room-release', { id: v.id }); },
      failMsg: '처리하지 못했습니다',
      done: function (r) {
        toast(r.json.bot ? '입장을 허용했습니다' : '입장을 허용했습니다. 방을 맡을 K bot 계정이 없어 기다립니다', 'ok');
        if (changed) changed();
      }
    });
  }

  function openRoomMove(v, changed) {
    var m = modal({ title: '다른 봇으로 이동', body: [roomHead(v), empty('K bot 계정을 불러오는 중…', false, true)] });
    var okBtn = btn('이동', 'primary');
    okBtn.disabled = true;
    m.setActions([btn('닫기', 'ghost', function () { if (!m.busy) m.close(); }), okBtn]);
    api('GET', '/admin/bots').then(function (r) {
      if (!m.isOpen()) return;
      if (kicked(r)) return;
      if (!r.ok) { m.setBody([roomHead(v), empty(errText(r, 'K bot 계정을 불러오지 못했습니다'), true, true)]); return; }
      var gname = 'mg-move-' + v.id;
      var pick = el('div', { cls: 'mg-pick', role: 'radiogroup', 'aria-label': '옮길 K bot 계정' });
      function opt(value, title, sub, tagsKids, checked, disabled) {
        var radio = el('input', { type: 'radio', name: gname, value: value, checked: !!checked, disabled: !!disabled });
        radio.addEventListener('change', function () { okBtn.disabled = false; });
        return el('label', { cls: 'chk' }, [radio, el('span', { cls: 'box', 'aria-hidden': 'true' }),
          el('span', { cls: 't' }, [el('span', { cls: 'mg-r1' }, [el('span', { style: 'color:var(--fg)', text: title }), tagsKids]),
                                    sub ? el('span', { cls: 'mg-meta', text: sub }) : null])]);
      }
      pick.appendChild(opt('', '자동 배정', '현재 계정을 빼고 맡은 방이 가장 적은 계정으로 옮깁니다', null, true));
      (r.json.bots || []).forEach(function (b) {
        if (b.device_id === v.bot_device_id) return;
        var s = botState(b);
        pick.appendChild(opt(b.device_id, botTitle(b), (b.email || '') + ' · 방 ' + (num(b.rooms_n) || 0) + ' / ' + (num(b.room_cap) || 0) +
          (b.open_profile_state === 'ok' && b.open_profile ? ' · 오픈프로필 「' + str(b.open_profile.name) + '」' : ''),
          [chip(s.kr, s.cls), profileTag(b), b.enabled ? null : tag('새 방 받기 중지', 'line')], false, false));
      });
      okBtn.disabled = false;
      m.setBody([
        roomHead(v),
        kv([['현재 K bot 계정', v.bot_device_id ? botName(v) : '없음']]),
        note('현재 K bot 계정은 방에서 나가고 새 계정이 입장합니다. 방 관리봇이 있으면 방장이 새 계정을 부방장으로 다시 지정해야 합니다.', true),
        sec('옮길 K bot 계정', pick)
      ]);
    });
    okBtn.addEventListener('click', function () {
      if (m.busy) return;
      var chosen = $('input[name="mg-move-' + v.id + '"]:checked', m.dlg);
      if (!chosen) { m.error('옮길 K bot 계정을 골라 주세요'); return; }
      m.error('');
      m.setBusy(true, okBtn);
      api('POST', '/admin/room-move', { id: v.id, bot_device_id: chosen.value || null }).then(function (res) {
        m.setBusy(false, okBtn);
        if (kicked(res)) return;
        if (!res.ok) { m.error(errText(res, '옮기지 못했습니다')); return; }
        m.close();
        toast('다른 K bot 계정으로 옮겼습니다', 'ok');
        if (changed) changed();
      });
    });
  }

  function openRoomRebind(v, changed) {
    var link = textInput({ type: 'url', inputmode: 'url', max: 2000, placeholder: 'https://open.kakao.com/o/…', autofocus: true });
    confirmAct({
      title: '링크 바꾸기',
      body: [roomHead(v),
             note('K bot이 지금 방에서 나가고 새 링크의 방으로 다시 입장합니다. 링크가 만료되었거나 방이 삭제된 경우에 써 주세요. 이미 K bot을 설치한 다른 방의 링크로는 바꿀 수 없습니다.', true),
             field('새 오픈채팅방 링크', link, '카카오톡에서 공유한 글을 그대로 붙여 넣어도 링크만 읽습니다.', 'rbLink')],
      ok: '링크 바꾸기',
      check: function () { return str(link.value) ? '' : '새 링크를 입력해 주세요'; },
      run: function () { return api('POST', '/admin/room-rebind', { id: v.id, link: str(link.value) }); },
      failMsg: '링크를 바꾸지 못했습니다',
      done: function (r) { toast(r.json.verified === false ? '링크를 바꿨습니다. 방은 입장할 때 확인합니다' : '링크를 바꿨습니다', 'ok'); if (changed) changed(); }
    });
  }

  function openRoomProducts(v, changed) {
    var p = v.products || {};
    var rows = roomProductIds().map(function (id) {
      return { id: id, c: checkRow(plabel(id), id === 'roombot' ? '방장이 K bot을 부방장으로 지정해야 동작합니다' : 'K bot이 방에 들어가면 바로 게임 명령어를 쓸 수 있습니다', !!p[id]) };
    });
    confirmAct({
      title: '봇 변경',
      body: [roomHead(v),
             para('결제 없이 이 방의 방 관리봇·미니게임봇을 켜거나 끕니다. 미니게임봇을 처음 켜면 게임 설정이 기본값(켜짐)으로 채워집니다. 둘 다 빼려면 [설치 해제]를 눌러 주세요.'),
             el('div', { cls: 'mg-checks' }, rows.map(function (x) { return x.c.node; }))],
      ok: '저장',
      check: function () { return rows.some(function (x) { return x.c.input.checked; }) ? '' : '봇을 1개 이상 골라 주세요'; },
      run: function () {
        var body = { id: v.id };
        rows.forEach(function (x) { body[x.id] = !!x.c.input.checked; });
        return api('POST', '/admin/room-products', body);
      },
      failMsg: '봇을 바꾸지 못했습니다',
      done: roomDone('봇을 바꿨습니다', changed)
    });
  }

  function openRoomTransfer(v, changed) {
    var login = textInput({ max: 40, placeholder: '받을 회원 아이디', autofocus: true });
    confirmAct({
      title: '다른 회원에게 넘기기',
      body: [roomHead(v),
             note('이 방의 회원을 바꿉니다. 봇·설정·K bot 계정은 그대로입니다. 방장 확인은 상담에서 끝낸 뒤 넘겨 주세요.', true),
             field('받을 회원 아이디', login, '회원 번호를 입력해도 됩니다.', 'tfLogin')],
      ok: '넘기기',
      check: function () { return str(login.value) ? '' : '받을 회원 아이디를 입력해 주세요'; },
      run: function () {
        var s = str(login.value);
        var body = { id: v.id };
        if (/^#?\d+$/.test(s)) body.member_id = s.replace(/^#/, ''); else body.login_id = s;
        return api('POST', '/admin/room-transfer', body);
      },
      failMsg: '넘기지 못했습니다',
      done: roomDone('방을 넘겼습니다', changed)
    });
  }

  function openRoomRemove(v, changed) {
    confirmAct({
      title: '설치 해제',
      danger: true,
      body: [roomHead(v), note('봇 설치를 해제합니다. K bot이 방에서 나가고 회원의 내 방 목록에서 사라집니다. 되돌릴 수 없습니다. 환불이 필요하면 회원 계좌로 직접 보내 주세요.', true)],
      ok: '설치 해제',
      run: function () { return api('POST', '/admin/room-remove', { id: v.id }); },
      failMsg: '해제하지 못했습니다',
      done: roomDone('설치를 해제했습니다', changed)
    });
  }

  function openRoomBlock(v, changed) {
    var reason = textInput({ max: 200, placeholder: '예: 도박 홍보 방', autofocus: true });
    confirmAct({
      title: '방 차단',
      danger: true,
      body: [roomHead(v),
             note('이 방의 봇 설치를 해제하고, 같은 방은 다시 미리 보기·주문·입장할 수 없게 막습니다. K bot은 방에서 나갑니다.', true),
             field('차단 사유 (필수, 200자 이하)', reason, null, 'rbkReason')],
      ok: '방 차단',
      check: function () { var s = str(reason.value); return s && s.length <= 200 ? '' : '차단 사유를 1~200자로 입력해 주세요'; },
      run: function () { return api('POST', '/admin/room-block', { id: v.id, reason: str(reason.value) }); },
      failMsg: '차단하지 못했습니다',
      done: roomDone('방을 차단했습니다', changed)
    });
  }

  function openLinkBlock() {
    var link = textInput({ type: 'url', inputmode: 'url', max: 2000, placeholder: 'https://open.kakao.com/o/…', autofocus: true });
    var reason = textInput({ max: 200, placeholder: '예: 스팸 방' });
    confirmAct({
      title: '링크 차단',
      danger: true,
      body: [para('아직 K bot을 설치하지 않은 방을 미리 막습니다. 차단한 링크의 방은 미리 보기·주문·입장이 모두 막힙니다. 이미 봇을 설치한 방이면 그 방의 [방 차단]을 눌러 주세요.'),
             field('오픈채팅방 링크', link, null, 'lbLink'),
             field('차단 사유 (필수, 200자 이하)', reason, null, 'lbReason')],
      ok: '차단',
      check: function () {
        if (!str(link.value)) return '링크를 입력해 주세요';
        var s = str(reason.value);
        return s && s.length <= 200 ? '' : '차단 사유를 1~200자로 입력해 주세요';
      },
      run: function () { return api('POST', '/admin/room-block', { link: str(link.value), reason: str(reason.value) }); },
      failMsg: '차단하지 못했습니다',
      done: function () { toast('링크를 차단했습니다', 'ok'); loadBlocks(); }
    });
  }

  function openRoomGrant(presetLogin, changed) {
    var login = textInput({ max: 40, placeholder: '회원 아이디', value: presetLogin || '', autofocus: !presetLogin });
    var link = textInput({ type: 'url', inputmode: 'url', max: 2000, placeholder: 'https://open.kakao.com/o/…', autofocus: !!presetLogin });
    var code = textInput({ max: 20, placeholder: '없으면 비워 두세요' });
    var rows = roomProductIds().map(function (id) { return { id: id, c: checkRow(plabel(id), null, false) }; });
    confirmAct({
      title: '봇 무료 설치',
      body: [para('결제 없이 이 회원의 방에 봇을 설치합니다(주문 없음). 링크 확인과 다른 회원의 방·차단한 방 검사는 주문할 때와 같습니다. 이 회원에게 이미 같은 방이 있으면 봇만 더합니다.'),
             field('회원 아이디', login, '회원 번호를 입력해도 됩니다.', 'rgLogin'),
             field('오픈채팅방 링크', link, null, 'rgLink'),
             field('참여코드 (선택)', code, '암호화해 저장하며 화면에 다시 보이지 않습니다.', 'rgCode'),
             sec('설치할 봇', el('div', { cls: 'mg-checks' }, rows.map(function (x) { return x.c.node; })))],
      ok: '설치',
      check: function () {
        if (!str(login.value)) return '회원 아이디를 입력해 주세요';
        if (!str(link.value)) return '링크를 입력해 주세요';
        if (str(code.value).length > 20) return '참여코드는 20자 이하로 입력해 주세요';
        return rows.some(function (x) { return x.c.input.checked; }) ? '' : '설치할 봇을 1개 이상 골라 주세요';
      },
      run: function () {
        var s = str(login.value);
        var body = { link: str(link.value), passcode: str(code.value) || null };
        if (/^#?\d+$/.test(s)) body.member_id = s.replace(/^#/, ''); else body.login_id = s;
        rows.forEach(function (x) { body[x.id] = !!x.c.input.checked; });
        return api('POST', '/admin/room-grant', body);
      },
      failMsg: '설치하지 못했습니다',
      done: function (r) {
        toast(r.json.added === false ? '이미 등록된 방에 봇을 더했습니다' : '봇을 설치했습니다 · 방 #' + r.json.install_id, 'ok');
        loadStats();
        if (TAB === 'rooms') loadRooms();
        if (changed) changed();
      }
    });
  }

  /* ── 차단한 방 */
  var BLK = { gen: 0 };
  function loadBlocks() {
    var my = ++BLK.gen;
    var box = $('#blockList');
    if (isLoadingBox(box)) listState(box, '불러오는 중…');
    return api('GET', '/admin/room-blocks').then(function (r) {
      if (my !== BLK.gen) return;
      if (kicked(r)) return;
      if (!r.ok) { listState(box, '차단 목록을 불러오지 못했습니다\n' + errText(r), true); return; }
      var list = r.json.blocks || [];
      $('#blockCount').textContent = list.length + '개';
      clear(box);
      if (!list.length) { box.appendChild(empty('차단한 방이 없습니다', false, true)); return; }
      list.forEach(function (b) {
        box.appendChild(el('article', { cls: 'mg-item', 'aria-label': '차단한 방 ' + b.id }, [
          el('div', { cls: 'mg-r1' }, [
            b.link_url ? el('span', { cls: 'mg-id grow', text: shortLink(b.link_url) })
                       : el('span', { cls: 'grow' }, ['링크 ID ', el('span', { cls: 'mg-id', text: b.link_id })]),
            tag('차단', 'crit')
          ]),
          el('div', { cls: 'mg-line', text: '사유: ' + (b.reason || '-') }),
          el('div', { cls: 'mg-meta', text: (b.link_id ? '링크 ID ' + b.link_id + ' · ' : '') + '차단 ' + dateKr(b.created_at, true) }),
          el('div', { cls: 'mg-acts' }, [btn('차단 해제', 'sm', function () { openUnblock(b); })])
        ]));
      });
    });
  }

  function openUnblock(b) {
    confirmAct({
      title: '차단 해제',
      body: [kv([['링크', b.link_url ? shortLink(b.link_url) : '-', 'mono'], ['링크 ID', b.link_id || '-', b.link_id ? 'mono' : null], ['사유', b.reason || '-']]),
             para('차단 목록에서 지웁니다. 이 방을 다시 미리 보기·주문할 수 있습니다. 차단하면서 설치 해제한 방은 자동으로 되살아나지 않습니다.')],
      ok: '차단 해제',
      run: function () { return api('POST', '/admin/room-unblock', { block_id: b.id }); },
      failMsg: '해제하지 못했습니다',
      done: function () { toast('차단을 해제했습니다', 'ok'); loadBlocks(); }
    });
  }

  /* ══════════════════ 13. 예전 라이선스 키 ══════════════════
     새 판매는 회원 계정으로 처리한다. 키 화면은 기존 고객 지원용이다(createLicenses·grant 는 남겨 둔다).
     회원에게 이관된 키(member_id)는 서버가 연장·회수를 409 로 막는다 → 화면도 회원 상세로 안내한다. */

  var KEYS = { term: '', rows: [], total: 0, now: 0, gen: 0, dirty: false };

  function findFeat(lic, id) {
    var fs = lic && Array.isArray(lic.features) ? lic.features : [];
    for (var i = 0; i < fs.length; i++) if (fs[i] && fs[i].feature === id) return fs[i];
    return null;
  }
  // 키에 있는 기능 + 상품표의 기능(순서는 상품표 먼저)
  function keyFeatIds(lic) {
    var ids = featIds();
    (lic && Array.isArray(lic.features) ? lic.features : []).forEach(function (e) {
      if (e && e.feature && ids.indexOf(e.feature) < 0) ids.push(e.feature);
    });
    return ids;
  }
  function maxExp(lic) {
    var m = 0;
    (lic.features || []).forEach(function (e) { var x = num(e.expires_at) || 0; if (x > m) m = x; });
    return m;
  }
  // "시작됐다" 판정은 lib/keys.js grant() 와 같다: 예전 앱 기기 등록 · 예전 /panel 첫 로그인 · 만료일이 잡힌 기능
  function isStarted(lic) {
    if (lic.device_id || num(lic.activated_at)) return true;
    return (lic.features || []).some(function (e) { return num(e.expires_at) !== null; });
  }
  function licState(lic, now) {
    if (lic.member_id) return { kr: '회원 등록됨', cls: 'info' };
    if (str(lic.blocked_reason)) return { kr: '차단', cls: 'bad' };
    if (lic.revoked) return { kr: '회수', cls: 'bad' };
    if (!(lic.features || []).length) return { kr: '기능 없음', cls: '' };
    if (!isStarted(lic)) return { kr: '사용 전', cls: 'info' };
    var m = maxExp(lic);
    if (m <= now) return { kr: '만료', cls: 'warn' };
    if (m - now <= 7 * DAY) return { kr: '만료 임박', cls: 'warn' };
    return { kr: '사용 중', cls: 'ok' };
  }
  function featState(e, now) {
    if (!e) return { kr: '없음', cls: '' };
    var exp = num(e.expires_at);
    if (exp === null) return { kr: '사용 전', cls: 'info' };
    if (exp <= now) return { kr: '만료', cls: 'bad' };
    var d = daysCeil(exp - now);
    return { kr: 'D-' + d, cls: d <= 7 ? 'warn' : 'ok' };
  }
  function featLine(e) {
    if (!e) return '미보유';
    var exp = num(e.expires_at);
    var p = planLabel(e.plan, e.duration_ms);
    if (exp === null) return p + ' · 사용 시작 전 · 대기 ' + Math.round((num(e.duration_ms) || 0) / DAY) + '일';
    return p + ' · ' + dateKr(exp, true) + '까지';
  }

  // 목록용 기능 칩: 기능 만료일이 모두 같으면 칩 하나로 줄인다
  function featChips(lic, now) {
    var ids = keyFeatIds(lic);
    var fs = ids.map(function (f) { return findFeat(lic, f); });
    var all = fs.length > 0 && fs.every(Boolean);
    if (all) {
      var e0 = fs[0];
      var same = fs.every(function (e) {
        return num(e.expires_at) === num(e0.expires_at) &&
               (num(e.expires_at) !== null || num(e.duration_ms) === num(e0.duration_ms));
      });
      if (same) {
        var s = featState(e0, now);
        var extra = num(e0.expires_at) !== null ? ' · ' + dateKr(e0.expires_at) + '까지'
          : ' · 대기 ' + Math.round((num(e0.duration_ms) || 0) / DAY) + '일';
        return [chip('기능 ' + fs.length + '종 ' + s.kr + extra, s.cls)];
      }
    }
    var out = [];
    var missing = [];
    ids.forEach(function (f, i) {
      if (fs[i]) { var s2 = featState(fs[i], now); out.push(chip(featLabel(f) + ' ' + s2.kr, s2.cls)); }
      else missing.push(featLabel(f));
    });
    if (missing.length) out.push(tag('미보유 ' + missing.join(' · '), 'line'));
    return out;
  }

  function loadKeys(appendMore) {
    var my = ++KEYS.gen;
    var box = $('#keyList');
    var more = $('#keyMore');
    if (!appendMore) {
      KEYS.rows = [];
      if (isLoadingBox(box)) listState(box, '불러오는 중…');
    } else {
      busyBtn(more, true);
    }
    KEYS.dirty = false;
    var offset = appendMore ? KEYS.rows.length : 0;
    var q = '/admin/list?limit=' + KEY_PAGE + '&offset=' + offset + (KEYS.term ? '&q=' + encodeURIComponent(KEYS.term) : '');
    api('GET', q).then(function (r) {
      if (my !== KEYS.gen) return;
      busyBtn(more, false);
      if (kicked(r)) return;
      if (!r.ok) {
        if (appendMore) { toast('목록을 더 불러오지 못했습니다 · ' + errText(r), 'bad'); return; }
        listState(box, '키 목록을 불러오지 못했습니다\n' + errText(r), true);
        $('#keyCount').textContent = '';
        more.hidden = true;
        return;
      }
      KEYS.total = num(r.json.total) || 0;
      KEYS.now = num(r.json.now) || Date.now();
      KEYS.rows = (appendMore ? KEYS.rows : []).concat(r.json.licenses || []);
      renderKeys();
    });
  }

  function renderKeys() {
    var box = $('#keyList');
    clear(box);
    $('#keyCount').textContent = KEYS.term
      ? '검색 ‘' + KEYS.term + '’ · ' + KEYS.total + '건 중 ' + KEYS.rows.length + '건 표시'
      : '전체 ' + KEYS.total + '건 중 ' + KEYS.rows.length + '건 표시 · 최근 발급 순';
    $('#keyMore').hidden = KEYS.rows.length >= KEYS.total;
    if (!KEYS.rows.length) {
      listState(box, KEYS.term ? '검색 결과가 없습니다' : '발급된 키가 없습니다.');
      return;
    }
    KEYS.rows.forEach(function (lic) { box.appendChild(keyItem(lic, KEYS.now)); });
  }

  function keyItem(lic, now) {
    var st = licState(lic, now);
    var item = el('article', { cls: 'mg-item click' });
    item.appendChild(el('div', { cls: 'mg-r1' }, [
      el('span', { cls: 'grow' }, el('button', { type: 'button', cls: 'mg-link', text: lic.key,
        'aria-label': '키 ' + lic.key + ' 상세 열기', onclick: function () { openKey(lic.key); } })),
      chip(st.kr, st.cls)
    ]));
    if (lic.member_id) {
      item.appendChild(el('div', { cls: 'mg-line' }, ['회원 ', inl(lic.member && lic.member.login_id ? lic.member.login_id : '#' + lic.member_id,
        function () { openMember(lic.member_id); }), ' 계정에 등록 · ' + dateKr(lic.claimed_at, true)]));
    }
    var who = [];
    if (str(lic.owner_name)) who.push(str(lic.owner_name));
    if (str(lic.owner_contact)) who.push(str(lic.owner_contact));
    item.appendChild(el('div', { cls: 'mg-line', text: who.length ? who.join(' · ') : '소유자 미지정' }));
    item.appendChild(el('div', { cls: 'mg-chips' }, featChips(lic, now)));
    var meta = '발급 ' + dateKr(lic.created_at) + (num(lic.activated_at) ? ' · 사용 시작 ' + dateKr(lic.activated_at) : '');
    if (str(lic.note)) meta += ' · ' + str(lic.note);
    item.appendChild(el('div', { cls: 'mg-meta', text: meta }));
    if (str(lic.blocked_reason)) item.appendChild(el('div', { cls: 'mg-crit', text: '차단 사유: ' + str(lic.blocked_reason) }));
    return item;
  }

  /* ── 키 상세 (창 하나를 계속 다시 그린다) */

  function openKey(key) {
    var k = normKey(key) || str(key);
    var m = modal({ title: '키 상세', wide: true, light: true, onClose: function () { if (KEYS.dirty && TAB === 'keys') loadKeys(false); },
                    body: empty('불러오는 중…') });
    m.setActions([btn('닫기', 'ghost', function () { m.close(); })]);
    var gen = 0;
    function refresh() {
      var my = ++gen;
      return api('GET', '/admin/license?key=' + encodeURIComponent(k)).then(function (r) {
        if (my !== gen || !m.isOpen()) return;
        if (kicked(r)) return;
        if (!r.ok) {
          m.setBody(empty(errText(r, '키를 불러오지 못했습니다'), true));
          return;
        }
        renderKeyDetail(m, r.json, refresh);
      });
    }
    refresh();
    return m;
  }

  function renderKeyDetail(m, j, refresh) {
    var lic = j.license || {};
    var now = num(j.now) || Date.now();
    var key = lic.key;
    var st = licState(lic, now);
    var claimed = !!lic.member_id;
    var changed = function () { KEYS.dirty = true; loadStats(); refresh(); };

    m.setTitle('키 상세');

    var top = el('div', { cls: 'big hi' }, [
      el('div', { cls: 'k', text: '라이선스 키' }),
      el('div', { cls: 'mg-keybox' }, [
        el('div', { cls: 'v key', text: key }),
        copyBtn(key, '키가', '키 복사')
      ]),
      el('div', { cls: 'chip-row', style: 'margin-top:10px' }, [chip(st.kr, st.cls)])
    ]);
    var alerts = [];
    if (claimed) {
      alerts.push(note(['회원 ', el('b', { text: lic.member && lic.member.login_id ? lic.member.login_id : '#' + lic.member_id }),
        ' 계정에 등록된 키입니다(' + dateKr(lic.claimed_at, true) + '). 기간 연장·기능 회수는 회원 상세에서 해 주세요. 잘못 등록되었으면 회원 상세의 [다른 회원으로 옮기기]를 눌러 주세요.']));
    }
    if (str(lic.blocked_reason)) alerts.push(note('차단된 키입니다. 사유: ' + str(lic.blocked_reason), true));
    if (lic.revoked) alerts.push(note('회수된 키입니다. 회원 계정에 등록할 수 없고, 이 키에 묶인 카카오 계정의 발송이 멈춥니다. 남은 기간은 보존됩니다.', true));
    if (!claimed && !isStarted(lic) && (lic.features || []).length) {
      alerts.push(note('아직 사용 전입니다. 손님 화면의 키 등록은 없어졌습니다.'));
    }

    // 기능
    var featBox = el('div');
    keyFeatIds(lic).forEach(function (f) {
      var e = findFeat(lic, f);
      var s = featState(e, now);
      featBox.appendChild(el('div', { cls: 'mg-feat' }, [
        el('span', { cls: 'nm', text: featLabel(f) }),
        el('span', { cls: 'ln', text: featLine(e) }),
        chip(s.kr, s.cls),
        e && !claimed ? btn('회수', 'sm danger', function () { revokeFeature(key, f, changed); }) : el('span')
      ]));
    });

    // 정보
    var info = kv([
      ['소유자', str(lic.owner_name) || '-'],
      ['연락처', str(lic.owner_contact) || '-'],
      str(lic.note) ? ['메모', str(lic.note)] : null,
      ['발급', dateKr(lic.created_at, true)],
      ['사용 시작', num(lic.activated_at) ? dateKr(lic.activated_at, true) : '-'],
      ['최종 만료', maxExp(lic) ? dateKr(maxExp(lic), true) : '-'],
      claimed ? ['회원 등록', dateKr(lic.claimed_at, true)] : null
    ]);

    // 관리
    var acts = el('div', { cls: 'btn-row', style: 'margin-top:0' }, [
      claimed ? btn('회원 상세', 'primary', function () { openMember(lic.member_id); })
              : btn('+30일 연장', 'primary', function () { openExtend(lic, now, changed); }),
      btn(lic.revoked ? '회수 해제' : '회수', lic.revoked ? '' : 'danger', function () { toggleRevoke(lic, changed); }),
      btn(str(lic.blocked_reason) ? '차단 해제' : '차단', str(lic.blocked_reason) ? '' : 'danger', function () { toggleBlock(lic, changed); }),
      btn('삭제', 'danger solid', function () { openDelete(lic, m); })
    ]);

    // 최근 기록
    var logs = Array.isArray(j.audit) ? j.audit : [];
    var logBox = el('div');
    if (!logs.length) logBox.appendChild(el('p', { cls: 'mg-meta', text: '기록이 없습니다' }));
    logs.forEach(function (a) {
      logBox.appendChild(el('div', { cls: 'mg-log' }, [
        el('time', { text: dateKr(a.at, true, true) }),
        el('span', null, [chip(KIND_LABEL[a.kind] || str(a.kind) || '-', isAlert(a.kind) ? 'bad' : '')]),
        el('span', { cls: 'd', text: str(a.detail) || '-' })
      ]));
    });

    m.setBody([
      top,
      alerts,
      el('section', { cls: 'mg-sec' }, [el('h3', { cls: 'mg-h3', text: '기능' }), featBox]),
      el('section', { cls: 'mg-sec' }, [el('h3', { cls: 'mg-h3', text: '관리' }), acts,
        el('p', { cls: 'hint', style: 'margin-top:0', text: claimed ? '회원이 등록한 키의 기간은 회원 상세에서 관리합니다.'
          : '연장은 키의 모든 기능에 적용됩니다. 환불할 때는 삭제 대신 회수를 쓰면 기록이 남습니다.' })]),
      el('section', { cls: 'mg-sec' }, [el('h3', { cls: 'mg-h3', text: '정보' }), info]),
      el('section', { cls: 'mg-sec' }, [
        el('h3', { cls: 'mg-h3', text: '최근 기록 ' + logs.length + '건' }),
        logBox,
        btn('기록 탭에서 전체 보기', 'sm ghost', function () { m.close(); showAuditFor(key); })
      ])
    ]);
  }

  // 연장 미리보기 — lib/keys.js grant() 계산을 그대로 따라 한다 (서버 시각 기준, 대략값)
  function previewGrant(lic, now, durMs) {
    var started = isStarted(lic);
    return keyFeatIds(lic).map(function (f) {
      var cur = findFeat(lic, f);
      if (!cur) return { f: f, text: started ? dateKr(now + durMs, true) + '까지 (새로 추가)' : '사용 시작 전 · 대기 ' + Math.round(durMs / DAY) + '일 (새로 추가)' };
      var prevExp = num(cur.expires_at);
      var prevDur = num(cur.duration_ms) || 0;
      if (prevExp === null && !started) return { f: f, text: '사용 시작 전 · 대기 ' + Math.round((prevDur + durMs) / DAY) + '일' };
      var exp = prevExp === null ? now + prevDur + durMs : Math.max(now, prevExp) + durMs;
      return { f: f, text: dateKr(exp, true) + '까지' };
    });
  }

  function openExtend(lic, now, changed) {
    var per = periodPicker('mg-ext-' + (++modalSeq));
    var prev = el('div');
    function upd() {
      var p = per.get();
      clear(prev);
      if (p.error) { prev.appendChild(el('p', { cls: 'mg-warn', text: p.error })); return; }
      previewGrant(lic, now, p.days * DAY).forEach(function (x) {
        var e = findFeat(lic, x.f);
        prev.appendChild(el('div', { cls: 'mg-feat' }, [
          el('span', { cls: 'nm', text: featLabel(x.f) }),
          el('span', { cls: 'ln', text: '현재 ' + featLine(e) + '  →  ' + x.text })
        ]));
      });
    }
    per.onChange(upd);
    upd();
    confirmAct({
      title: '기간 연장',
      body: [
        kv([['키', lic.key, 'mono'], ['소유자', str(lic.owner_name) || '-']]),
        para('키의 모든 기능에 적용됩니다. 남은 기간이 있으면 만료일에 더해지고, 이미 만료된 기능은 지금부터 계산됩니다. 보유하지 않은 기능은 새로 추가됩니다.'),
        per.node,
        el('section', { cls: 'mg-sec' }, [el('h3', { cls: 'mg-h3', text: '연장 후 (예상)' }), prev])
      ],
      ok: '연장',
      check: function () { var p = per.get(); if (p.error) return p.error; return keyFeatIds(lic).length ? '' : '상품 정보를 불러오지 못했습니다. 새로고침한 뒤 다시 시도해 주세요'; },
      run: function () {
        var p = per.get();
        var body = { key: lic.key, features: keyFeatIds(lic), plan: p.plan };
        if (p.plan === 'custom') body.days = p.days;
        return api('POST', '/admin/grant', body);
      },
      failMsg: '연장하지 못했습니다',
      done: function (r) {
        toast('기간이 ' + (num(r.json.duration_days) || '') + '일 연장되었습니다', 'ok');
        changed();
      }
    });
  }

  function revokeFeature(key, f, changed) {
    confirmAct({
      title: '기능 회수',
      danger: true,
      body: [
        kv([['키', key, 'mono'], ['기능', featLabel(f)]]),
        note(featLabel(f) + ' 기능을 이 키에서 삭제합니다. 남은 기간도 함께 사라지며 되돌릴 수 없습니다. 다시 주려면 기간 연장을 써 주세요.', true)
      ],
      ok: '기능 회수',
      run: function () { return api('POST', '/admin/revoke-feature', { key: key, feature: f }); },
      failMsg: '회수하지 못했습니다. 이미 회수된 기능입니다',
      done: function () { toast('기능이 회수되었습니다', 'ok'); changed(); }
    });
  }

  function toggleRevoke(lic, changed) {
    var on = !lic.revoked;
    confirmAct({
      title: on ? '키 회수' : '회수 해제',
      danger: on,
      body: [
        kv([['키', lic.key, 'mono'], ['소유자', str(lic.owner_name) || '-']]),
        on ? note('이 키의 사용을 중지합니다. 회원 계정에 등록할 수 없게 되고, 아직 회원 계정에 등록하지 않은 키라면 묶인 카카오 계정의 발송이 멈춥니다. 남은 기간은 보존되며, 회수 해제로 되돌릴 수 있습니다.', true)
           : para('회수를 해제합니다. 남은 기간이 있으면 이 키의 카카오 계정 발송이 이어지고, 회원 계정에 등록할 수 있습니다.')
      ],
      ok: on ? '회수' : '회수 해제',
      run: function () { return api('POST', '/admin/revoke', { key: lic.key, revoked: on }); },
      failMsg: '처리하지 못했습니다. 등록되지 않은 키입니다',
      done: function () { toast(on ? '키가 회수되었습니다' : '회수가 해제되었습니다', 'ok'); changed(); }
    });
  }

  function toggleBlock(lic, changed) {
    var blocked = !!str(lic.blocked_reason);
    if (blocked) {
      confirmAct({
        title: '차단 해제',
        body: [
          kv([['키', lic.key, 'mono'], ['차단 사유', str(lic.blocked_reason)]]),
          para('차단을 해제합니다. 이 키를 다시 회원 계정에 등록할 수 있습니다.')
        ],
        ok: '차단 해제',
        run: function () { return api('POST', '/admin/block', { key: lic.key, reason: null }); },
        failMsg: '처리하지 못했습니다. 등록되지 않은 키입니다',
        done: function () { toast('차단이 해제되었습니다', 'ok'); changed(); }
      });
      return;
    }
    var reason = el('input', { cls: 'inp', id: 'blReason', maxlength: '500', autocomplete: 'off', placeholder: '예: 결제 분쟁, 이용 조건 위반' });
    reason.setAttribute('data-autofocus', '');
    confirmAct({
      title: '키 차단',
      danger: true,
      body: [
        kv([['키', lic.key, 'mono'], ['소유자', str(lic.owner_name) || '-']]),
        note('이 키의 사용을 차단합니다. 회원 계정에 등록할 수 없고, 아직 회원 계정에 등록하지 않은 키라면 묶인 카카오 계정의 발송이 멈춥니다. 차단 사유는 기록에 남습니다.', true),
        field('차단 사유 (필수)', reason)
      ],
      ok: '차단',
      check: function () { return str(reason.value) ? '' : '차단 사유를 입력해 주세요'; },
      run: function () { return api('POST', '/admin/block', { key: lic.key, reason: str(reason.value) }); },
      failMsg: '처리하지 못했습니다. 등록되지 않은 키입니다',
      done: function () { toast('키가 차단되었습니다', 'ok'); changed(); }
    });
  }

  function openDelete(lic, detail) {
    var tail = String(lic.key || '').slice(-4);
    var conf = el('input', { cls: 'inp mono keyin', id: 'dlConf', maxlength: '4', autocomplete: 'off', spellcheck: 'false',
                             autocapitalize: 'characters', placeholder: tail });
    conf.setAttribute('data-autofocus', '');
    confirmAct({
      title: '키 삭제',
      danger: true,
      body: [
        kv([['키', lic.key, 'mono'], ['소유자', str(lic.owner_name) || '-']]),
        note('키와 기능별 기간, 소유자 정보가 모두 삭제되며 되돌릴 수 없습니다. 이 키로 접수된 주문 기록은 남습니다. 환불·정지 처리에는 삭제 대신 회수를 써 주세요.', true),
        field('확인을 위해 키의 마지막 4자리(' + tail + ')를 입력해 주세요', conf)
      ],
      ok: '영구 삭제',
      check: function () { return normKeyTail(conf.value) === tail ? '' : '마지막 4자리가 일치하지 않습니다'; },
      run: function () { return api('POST', '/admin/delete', { key: lic.key }); },
      failMsg: '삭제하지 못했습니다. 이미 삭제된 키입니다',
      done: function () {
        toast('키가 삭제되었습니다', 'ok');
        KEYS.dirty = true;
        loadStats();
        if (detail) detail.close();
      }
    });
  }
  function normKeyTail(s) { return String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(-4); }

  /* ── 새 키 발급 (지원용) */

  function openCreate() {
    var per = periodPicker('mg-new-' + (++modalSeq));
    var count = el('input', { cls: 'inp mono', type: 'number', inputmode: 'numeric', min: '1', max: '20', step: '1', value: '1' });
    var owner = el('input', { cls: 'inp', maxlength: '100', autocomplete: 'off' });
    var contact = el('input', { cls: 'inp', maxlength: '100', autocomplete: 'off' });
    var memo = el('input', { cls: 'inp', maxlength: '500', autocomplete: 'off', placeholder: '예: 기존 고객 보상, 지인 제공' });
    owner.setAttribute('data-autofocus', '');
    confirmAct({
      title: '새 키 발급',
      body: [
        note('기존 고객 지원용 라이선스 키를 발급합니다. 기능 ' + featIds().length + '종(' + featIds().map(featLabel).join(' · ') +
             ')이 모두 포함됩니다. 손님 화면의 키 등록은 없어졌으니 새 판매에는 회원 주문을 써 주세요.'),
        per.node,
        el('div', { cls: 'mg-sec' }, [el('span', { cls: 'lb', text: '수량' }),
          el('div', { cls: 'mg-numrow' }, [count, el('span', { cls: 'dim tiny', text: '개 (최대 20개)' })])]),
        el('div', { cls: 'mg-row2' }, [field('소유자 이름 (선택)', owner, null, 'nkOwner'), field('연락처 (선택)', contact, null, 'nkContact')]),
        field('메모 (선택)', memo, null, 'nkMemo')
      ],
      ok: '발급',
      check: function () {
        var p = per.get();
        if (p.error) return p.error;
        if (!featIds().length) return '상품 정보를 불러오지 못했습니다. 새로고침한 뒤 다시 시도해 주세요';
        var n = Math.floor(Number(count.value));
        if (!isFinite(n) || n < 1 || n > 20) return '수량은 1~20 사이로 입력해 주세요';
        return '';
      },
      run: function () {
        var p = per.get();
        var body = {
          features: featIds(), plan: p.plan, count: Math.floor(Number(count.value)) || 1,
          note: str(memo.value) || null, owner_name: str(owner.value) || null, owner_contact: str(contact.value) || null
        };
        if (p.plan === 'custom') body.days = p.days;
        return api('POST', '/admin/create', body);
      },
      failMsg: '키를 발급하지 못했습니다',
      done: function (r) {
        showCreated(r.json.keys || [], num(r.json.duration_days));
        loadStats();
        KEYS.term = '';
        var q = $('#keyQ'); if (q) q.value = '';
        if (TAB === 'keys') loadKeys(false); else KEYS.dirty = true;
      }
    });
  }

  function showCreated(list, days) {
    var m = modal({ title: '발급 완료', light: true, body: [
      para(list.length + '개 키가 발급되었습니다 · ' + (days || '') + '일. 받은 사람이 회원 계정에 등록하면 그때부터 기간이 계산됩니다.'),
      el('div', { cls: 'mg-keys-out' }, list.map(function (k) {
        return el('div', { cls: 'r' }, [el('span', { cls: 'mono', text: k }), copyBtn(k, '키가')]);
      }))
    ] });
    var acts = [btn('닫기', 'ghost', function () { m.close(); })];
    if (list.length > 1) acts.push(btn('전체 복사', 'primary', function () { copy(list.join('\n'), '키 ' + list.length + '개가'); }));
    else if (list.length === 1) acts.push(btn('키 복사', 'primary', function () { copy(list[0], '키가'); }));
    m.setActions(acts);
  }

  /* ══════════════════ 14. 기록 ══════════════════ */

  var AUD = { gen: 0, kind: '', key: '', member: '', learned: false };

  function isAlert(kind) { return ALERT_KINDS.indexOf(kind) >= 0; }

  function fillKinds(serverKinds) {
    var sel = $('#audKind');
    var cur = sel.value;
    clear(sel);
    sel.appendChild(el('option', { value: '', text: '전체 종류' }));
    var base = KIND_BASE.slice();
    (serverKinds || []).forEach(function (k) { if (k && base.indexOf(k) < 0 && KIND_LEGACY.indexOf(k) < 0) base.push(k); });
    base.forEach(function (k) { sel.appendChild(el('option', { value: k, text: KIND_LABEL[k] || k })); });
    var og = el('optgroup', { label: '예전 앱 기록' });
    KIND_LEGACY.forEach(function (k) { og.appendChild(el('option', { value: k, text: KIND_LABEL[k] })); });
    sel.appendChild(og);
    sel.value = cur;
    if (sel.value !== cur) sel.value = '';
  }

  function loadAudit() {
    var my = ++AUD.gen;
    var box = $('#audList');
    if (isLoadingBox(box)) listState(box, '불러오는 중…');
    var q = '/admin/audit?limit=' + LIST_LIMIT;
    if (AUD.kind) q += '&kind=' + encodeURIComponent(AUD.kind);
    if (AUD.key) q += '&key=' + encodeURIComponent(AUD.key);
    if (AUD.member) q += '&member=' + encodeURIComponent(AUD.member);
    api('GET', q).then(function (r) {
      if (my !== AUD.gen) return;
      if (kicked(r)) return;
      if (!r.ok) { listState(box, '기록을 불러오지 못했습니다\n' + errText(r), true); $('#audCount').textContent = ''; return; }
      if (Array.isArray(r.json.alert_kinds) && r.json.alert_kinds.length) ALERT_KINDS = r.json.alert_kinds.slice();
      if (!AUD.learned && Array.isArray(r.json.kinds)) { AUD.learned = true; fillKinds(r.json.kinds); }
      var list = r.json.audit || [];
      var label = AUD.kind ? (KIND_LABEL[AUD.kind] || AUD.kind) : '전체';
      $('#audCount').textContent = label + ' ' + list.length + '건' + (AUD.key ? ' · 키 ' + AUD.key : '') +
        (AUD.member ? ' · 회원 ' + (r.json.member ? r.json.member.login_id : AUD.member + '(없음)') : '') +
        (list.length >= LIST_LIMIT ? ' (최근 ' + LIST_LIMIT + '건까지 표시)' : '');
      clear(box);
      if (!list.length) { listState(box, '해당 조건의 기록이 없습니다'); return; }
      list.forEach(function (a) { box.appendChild(auditItem(a)); });
    });
  }

  function auditItem(a) {
    var alert = isAlert(a.kind);
    var legacy = KIND_LEGACY.indexOf(a.kind) >= 0;
    var item = el('article', { cls: 'mg-item' + (alert ? ' alert' : '') });
    item.appendChild(el('div', { cls: 'mg-r1' }, [
      el('time', { cls: 'mg-meta grow mono', text: dateKr(a.at, true, true) }),
      legacy ? tag('예전 앱', 'line') : null,
      chip(KIND_LABEL[a.kind] || str(a.kind) || '-', alert ? 'bad' : (a.kind === 'order' ? 'info' : ''))
    ]));
    if (a.key) {
      item.appendChild(el('div', { cls: 'mg-keyline' }, [
        el('span', { cls: 'mono', text: a.key }),
        btn('키 상세', 'sm ghost', function () { openKey(a.key); }),
        AUD.key !== a.key ? btn('이 키만 보기', 'sm ghost', function () { showAuditFor(a.key); }) : null
      ]));
    }
    if (a.member_id) {
      var login = a.member_login || ('#' + a.member_id);
      item.appendChild(el('div', { cls: 'mg-keyline' }, [
        el('span', { text: '회원' }),
        el('span', { cls: 'mono', text: login }),
        btn('회원 상세', 'sm ghost', function () { openMember(a.member_id); }),
        AUD.member !== (a.member_login || String(a.member_id)) ? btn('이 회원만 보기', 'sm ghost', function () { showAuditForMember(a.member_login || String(a.member_id)); }) : null
      ]));
    }
    if (str(a.detail)) item.appendChild(el('div', { cls: 'mg-line', text: str(a.detail) }));
    var meta = [];
    if (str(a.ip)) meta.push('IP ' + str(a.ip));
    if (str(a.device_name)) meta.push('기기 ' + str(a.device_name));
    if (meta.length) item.appendChild(el('div', { cls: 'mg-meta', text: meta.join(' · ') }));
    return item;
  }

  function showAuditFor(key) {
    AUD.key = normKey(key) || str(key);
    AUD.kind = '';
    AUD.member = '';
    $('#audKey').value = AUD.key;
    $('#audMember').value = '';
    $('#audKind').value = '';
    if (TAB === 'audit') loadAudit(); else switchTab('audit');
  }
  function showAuditForMember(login) {
    AUD.member = str(login);
    AUD.kind = '';
    AUD.key = '';
    $('#audKey').value = '';
    $('#audMember').value = AUD.member;
    $('#audKind').value = '';
    if (TAB === 'audit') loadAudit(); else switchTab('audit');
  }

  /* ══════════════════ 15. 시작 ══════════════════ */

  function bind() {
    $('#loginForm').addEventListener('submit', onLoginSubmit);
    $('#logoutBtn').addEventListener('click', logout);
    $('#refreshBtn').addEventListener('click', function () { hideLock(); refreshAll(); });

    $$('.mg-tab').forEach(function (b) {
      b.addEventListener('click', function () { switchTab(b.getAttribute('data-tab')); });
      b.addEventListener('keydown', onTabKey);
    });
    window.addEventListener('hashchange', function () { if (STARTED) switchTab(tabFromHash()); });
    $('.mg-tabs').addEventListener('scroll', tabFade, { passive: true });
    window.addEventListener('resize', tabFade);

    $$('.mg-stat').forEach(function (b) {
      b.addEventListener('click', function () {
        var go = b.getAttribute('data-go');
        var f = b.getAttribute('data-filter');
        if (go === 'orders' && f) { ORD.filter = f; setFilter('#ordFilt', f); }
        if (go === 'deposits' && f) { DEP.filter = f; setFilter('#depFilt', f); }
        if (go === 'members' && f) { MEM.filter = f; MEM.q = ''; $('#memQ').value = ''; setFilter('#memFilt', f); }
        if (go === 'rooms' && f !== null) { ROOMS.filter = f; ROOMS.bot = ''; ROOMS.botName = ''; setFilter('#roomFilt', f); }
        if (go === TAB) loadTab(go); else switchTab(go);
        var tab = $('#tab-' + go);
        if (tab && tab.scrollIntoView) tab.scrollIntoView({ block: 'start', behavior: 'smooth' });
      });
    });

    function filterGroup(sel, state, box, load) {
      $$(sel + ' button').forEach(function (b) {
        b.addEventListener('click', function () {
          state.filter = b.getAttribute('data-f');
          setFilter(sel, state.filter);
          listState($(box), '불러오는 중…');
          load();
        });
      });
    }
    filterGroup('#ordFilt', ORD, '#ordList', loadOrders);
    filterGroup('#depFilt', DEP, '#depList', loadDeposits);
    filterGroup('#memFilt', MEM, '#memList', loadMembers);
    filterGroup('#roomFilt', ROOMS, '#roomList', loadRooms);

    $('#memForm').addEventListener('submit', function (e) {
      e.preventDefault();
      MEM.q = str($('#memQ').value).slice(0, 80);
      listState($('#memList'), '불러오는 중…');
      loadMembers();
    });
    $('#roomForm').addEventListener('submit', function (e) {
      e.preventDefault();
      ROOMS.q = str($('#roomQ').value).slice(0, 200);
      listState($('#roomList'), '불러오는 중…');
      loadRooms();
    });
    $('#roomGrantBtn').addEventListener('click', function () { openRoomGrant('', null); });
    $('#roomBlockBtn').addEventListener('click', openLinkBlock);
    $('#botNew').addEventListener('click', function () { openBotRegister(null); });

    $('#keyForm').addEventListener('submit', function (e) {
      e.preventDefault();
      KEYS.term = str($('#keyQ').value).slice(0, 100);
      listState($('#keyList'), '불러오는 중…');
      loadKeys(false);
    });
    $('#keyMore').addEventListener('click', function () { loadKeys(true); });
    $('#keyNew').addEventListener('click', function () { loadPrice().then(openCreate); });

    $('#audForm').addEventListener('submit', function (e) {
      e.preventDefault();
      AUD.kind = $('#audKind').value;
      var raw = str($('#audKey').value);
      AUD.key = raw ? (normKey(raw) || raw.toUpperCase()) : '';
      if (raw) $('#audKey').value = AUD.key;
      AUD.member = str($('#audMember').value).slice(0, 40);
      listState($('#audList'), '불러오는 중…');
      loadAudit();
    });
    $('#audKind').addEventListener('change', function () {
      AUD.kind = $('#audKind').value;
      listState($('#audList'), '불러오는 중…');
      loadAudit();
    });

    document.addEventListener('visibilitychange', function () {
      if (!document.hidden && STARTED && PW) loadStats();
    });

    var lnav = $('#lnav');
    if (lnav) {
      var onScroll = function () { lnav.classList.toggle('scrolled', window.scrollY > 4); };
      window.addEventListener('scroll', onScroll, { passive: true });
      onScroll();
    }
  }

  function boot() {
    bind();
    fillKinds([]);
    loadPrice();
    PW = loadPw();
    if (!PW) { showLogin(); return; }
    // 보관된 비밀번호가 아직 맞는지 요약 숫자로 확인한다. 틀리면 kicked() 가 로그인으로 돌린다.
    api('GET', '/admin/stats').then(function (r) {
      if (r.ok) { enterApp(r); return; }
      if (kicked(r)) return;
      // 네트워크 · 과다요청 등: 비밀번호 문제는 아니니 화면은 열고 사유를 띄운다
      enterApp(null);
      if (r.kind !== 'locked') showLock(r.error);
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
