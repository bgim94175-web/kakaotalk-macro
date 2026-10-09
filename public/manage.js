/* ───────────────────────────────────────────────────────────────
   K bot — 판매 관리 화면 (/manage)
   단종된 관리자 앱(android/admin, KakaoAdmin)을 대신하는 웹 화면이다.
   routes/admin.js 의 /admin/* 만 부른다. 요청/응답 모양은 거기가 기준이다.
     GET  /admin/stats            요약 숫자 (로그인 확인도 이걸로 한다)
     GET  /admin/orders           주문 목록 (?status=&limit=)
     POST /admin/order-approve    {id, key?}  → 신규 발급 또는 키 연장 (자동 입금확인과 같은 로직)
     POST /admin/order-cancel     {id, memo?}
     GET  /admin/deposits         입금 알림 기록
     POST /admin/deposit-match    {deposit_id, order_id} → 매칭 + 주문 승인
     POST /admin/deposit-ignore   {deposit_id}
     GET  /admin/list             키 목록 (?q=&limit=&offset=)
     GET  /admin/license          키 상세 (?key=) + 최근 기록 20건
     POST /admin/create           {features, plan, days?, count, note?, owner_name?, owner_contact?}
     POST /admin/grant            {key, features, plan, days?} → 남은 기간에 더한다
     POST /admin/revoke-feature   {key, feature}
     POST /admin/revoke           {key, revoked}
     POST /admin/block            {key, reason|null}
     POST /admin/delete           {key}
     GET  /admin/audit            기록 (?kind=&key=&limit=)

   인증: 헤더 x-admin-password. 비밀번호는 sessionStorage 에만 둔다(탭을 닫으면 사라짐).
         401 이면 지우고 로그인 화면으로, 503 admin_disabled 면 서버 설정 문제를 그대로 보여준다.
         429 는 두 종류다 — 비밀번호 연속 실패 차단(too_many_attempts)과 일반 과다요청(rate_limited).
   판매 상품은 "K bot 1개월" 하나다 (lib/pricing.js). 새 키·연장은 항상 기능 3종을 같이 다룬다.
   서버 문자열은 전부 textContent 로만 넣는다. 이 파일에 innerHTML 은 없다.
   외부 라이브러리 안 씀.
   ─────────────────────────────────────────────────────────────── */
(function () {
  'use strict';

  /* ══════════════════ 0. 고정 값 ══════════════════ */

  // lib/features.js ALL 과 같은 순서. 판매·연장은 항상 이 3종 전부다.
  var FEATS = ['macro', 'roombot', 'minigame'];
  var FEAT_LABEL = { macro: '자동발송 매크로', roombot: '대화방 관리봇', minigame: '미니게임봇' };
  var FEAT_SHORT = { macro: '매크로', roombot: '관리봇', minigame: '미니게임' };

  // lib/keys.js PLANS. 판매는 month 하나뿐이지만 예전 주문·키가 3개월/1년으로 남아 있다.
  var SALE_PLAN = 'month';
  var PLANS = { month: { days: 30, label: '1개월' }, quarter: { days: 90, label: '3개월' }, year: { days: 365, label: '1년' } };
  var PRODUCT = 'K bot';
  var DAY = 86400000;

  var ORDER_ST = {
    pending:  { kr: '입금 대기',             cls: 'warn' },
    paid:     { kr: '입금 확인 · 발급 대기', cls: 'info' },
    done:     { kr: '발급 완료',             cls: 'ok' },
    canceled: { kr: '취소',                  cls: '' }
  };
  var DEP_ST = {
    unmatched: { kr: '미매칭',    cls: 'warn' },
    ambiguous: { kr: '확인 필요', cls: 'bad' },
    matched:   { kr: '매칭됨',    cls: 'ok' },
    duplicate: { kr: '중복 알림', cls: '' },
    ignored:   { kr: '무시',      cls: '' }
  };
  // lib/audit.js KINDS + 단종된 사용자앱이 남긴 옛 종류(표에 그대로 남아 있다)
  var KIND_LABEL = {
    activate: '사용 시작',
    revoked: '회수 · 차단 · 삭제',
    order: '주문',
    bad_deposit_token: '입금 알림 코드 오류',
    bad_admin_pw: '관리자 비밀번호 실패',
    mismatch: '기기 불일치',
    takeover: '기기정보 변경',
    bad_sig: '앱 위조',
    tamper: '앱 변조',
    expired: '기간 만료',
    reset: '기기 초기화'
  };
  var KIND_BASE = ['activate', 'revoked', 'order', 'bad_deposit_token', 'bad_admin_pw'];
  var KIND_LEGACY = ['mismatch', 'takeover', 'bad_sig', 'tamper', 'expired', 'reset'];
  var ALERT_KINDS = ['bad_deposit_token', 'bad_admin_pw'];   // 서버 alert_kinds 가 오면 그걸로 바꾼다

  var KEY_RE = /^KAKA-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/;
  var PW_STORE = 'kb_manage_pw';
  var POLL_MS = 30000;         // 요약 숫자 갱신 간격 (관리자 버킷 분당 120회 — 여유가 크다)
  var KEY_PAGE = 50;
  var LIST_LIMIT = 200;

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
  function daysCeil(ms) { return Math.ceil(ms / DAY); }

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
  // "K bot 1개월 (30일)"
  function productText(plan) {
    var d = planDays(plan);
    return PRODUCT + ' ' + planLabel(plan) + (d ? ' (' + d + '일)' : '');
  }
  function featLabel(id) { return FEAT_LABEL[id] || String(id || ''); }
  function hasAllFeats(list) {
    var arr = Array.isArray(list) ? list : [];
    for (var i = 0; i < FEATS.length; i++) if (arr.indexOf(FEATS[i]) < 0) return false;
    return true;
  }
  function featText(list) {
    var arr = Array.isArray(list) ? list : [];
    if (!arr.length) return '기능 없음';
    if (hasAllFeats(arr)) return '기능 3종 전부';
    return arr.map(featLabel).join(' · ');
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
        if (ok) done(); else toast('복사에 실패했습니다. 직접 선택하여 복사하십시오', 'bad');
      } catch (e) {
        toast('복사에 실패했습니다. 직접 선택하여 복사하십시오', 'bad');
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
               error: '서버에 연결할 수 없습니다. 네트워크 상태를 확인하십시오' };
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
      out.error = str(o.detail) || '서버에 관리자 비밀번호가 설정되지 않아 관리자 기능이 차단되었습니다. 서버 환경변수 ADMIN_PASSWORD 를 설정한 후 재배포하십시오';
      return out;
    }
    if (st === 429) {
      // routes/admin.js guard: {error:'too_many_attempts', detail}
      // server.js 미들웨어: {reason:'rate_limited', error:'비밀번호 입력 실패 …' | '요청이 너무 빈번합니다 …'}
      var msg = str(o && o.detail) || (o && hasKo(o.error) ? str(o.error) : '');
      var locked = (o && o.error === 'too_many_attempts') || /비밀번호/.test(msg);
      out.kind = locked ? 'locked' : 'rate';
      if (!msg) {
        var m = retryMins(res);
        msg = locked
          ? '비밀번호 입력 실패 횟수를 초과했습니다.' + (m ? ' ' + m + '분 후 다시 시도하십시오' : ' 잠시 후 다시 시도하십시오')
          : '요청이 너무 빈번합니다. 잠시 후 다시 시도하십시오';
      }
      out.error = msg;
      return out;
    }
    if (!o) {
      out.kind = 'bad';
      out.error = st >= 500
        ? '서버가 응답하지 않습니다 (HTTP ' + st + '). 잠시 후 다시 시도하십시오'
        : '응답을 읽지 못했습니다 (HTTP ' + st + ')';
      return out;
    }
    if (st >= 500) {
      out.kind = 'server';
      out.error = hasKo(o.error) ? str(o.error) : '서버 오류가 발생했습니다. 잠시 후 다시 시도하십시오';
      return out;
    }
    if (o.ok === true && st < 400) { out.ok = true; return out; }
    out.kind = 'fail';
    out.error = hasKo(o.error) ? str(o.error) : '';
    return out;
  }

  function errText(r, fallback) {
    return (r && r.error) || fallback || '요청이 처리되지 않았습니다';
  }

  // 401 / 503(관리자 API 닫힘) 은 어느 화면에서 나와도 로그인 화면으로 돌린다. 처리했으면 true.
  // 비밀번호 연속 실패 차단(429)은 로그아웃시키지 않고 상단에 띄운다 (같은 IP 의 다른 사람이 틀렸을 수도 있다).
  function kicked(r) {
    if (!r || r.ok) return false;
    if (r.kind === 'auth') {
      dropPw();
      showLogin({ err: '비밀번호가 변경되었거나 일치하지 않습니다. 다시 입력하십시오' });
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
     <dialog> 를 열 때마다 새로 만들고 닫으면 지운다. 겹쳐 열 수 있다(키 상세 위에 확인창).
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
      setBody: function (kids) { clear(body); append(body, kids); },
      setActions: function (list) { clear(foot); append(foot, list || []); },
      error: function (msg) { err.textContent = msg || ''; },
      setBusy: function (on, b) { ctl.busy = !!on; busyBtn(b, on); xBtn.disabled = !!on; },
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
  // o = { title, body, ok, danger, run: () => Promise<r>, check?: () => 오류문구|'', done?: (r) => void, failMsg? }
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
        if (!r || !r.ok) { m.error(errText(r, o.failMsg)); return; }
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
      el('span', { text: text })
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

  // 기간 선택: 30일(판매 상품과 같음) / 직접 입력(custom, 관리자 전용).  → { get(): {plan, days}|{error} }
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
        if (!isFinite(d) || d < 1 || d > 3650) return { error: '일수는 1~3650 사이로 입력하십시오' };
        if (d === planDays(SALE_PLAN)) return { plan: SALE_PLAN, days: d };
        return { plan: 'custom', days: d };
      }
    };
  }

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
    if (!given) { errBox.textContent = '비밀번호를 입력하십시오'; pwIn.focus(); return; }
    // HTTP 헤더로 보낼 수 없는 글자(한글 등)는 서버 비밀번호에도 쓸 수 없다 — 요청 전에 막는다
    if (/[^\x20-\x7e]/.test(given)) {
      errBox.textContent = '비밀번호에 영문·숫자·기호 외의 글자(한글, 공백 문자 등)가 포함되어 있습니다. 서버에 설정한 값을 그대로 입력하십시오';
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
    var dep = num(STATS.deposits_attention) || 0;
    var rev = num(STATS.revoked) || 0;
    var blk = num(STATS.blocked) || 0;
    setStat('pending', pend);
    setSub('pending', paid > 0 ? '입금 확인 · 발급 대기 ' + paid + '건' : '입금 대기 포함');
    tone('pending', paid > 0 ? 'crit' : (pend > 0 ? 'hot' : ''));
    setStat('deposits', dep);
    tone('deposits', dep > 0 ? 'crit' : '');
    setStat('active', num(STATS.active));
    setStat('expiring', num(STATS.expiring_7d));
    tone('expiring', (num(STATS.expiring_7d) || 0) > 0 ? 'hot' : '');
    setStat('total', num(STATS.total));
    setStat('stopped', rev + blk);
    setSub('stopped', '회수 ' + rev + ' · 차단 ' + blk);

    var bf = STATS.by_feature || {};
    $('#featSum').textContent = '기능별 사용 중 — ' + FEATS.map(function (f) {
      return FEAT_LABEL[f] + ' ' + (num(bf[f]) || 0);
    }).join(' · ');

    badge('orders', pend);
    badge('deposits', dep);
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

  function badge(name, n) {
    var b = $('[data-badge="' + name + '"]');
    if (!b) return;
    b.hidden = !(n > 0);
    b.textContent = n > 99 ? '99+' : String(n || 0);
    var tab = b.parentNode;
    var base = name === 'orders' ? '주문' : '입금';
    tab.setAttribute('aria-label', base + (n > 0 ? ' (처리할 항목 ' + n + '건)' : ''));
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
    loadTab(TAB);
  }

  /* ══════════════════ 7. 탭 ══════════════════ */

  var TABS = ['orders', 'deposits', 'keys', 'audit'];
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
    if (changed || force) loadTab(name);
  }

  function loadTab(name) {
    if (name === 'orders') loadOrders();
    else if (name === 'deposits') loadDeposits();
    else if (name === 'keys') loadKeys(false);
    else if (name === 'audit') loadAudit();
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
    box.appendChild(el('div', { cls: 'mg-empty' + (bad ? ' bad' : ''), text: text }));
  }

  /* ══════════════════ 8. 주문 ══════════════════ */

  var ORD = { filter: 'open', gen: 0 };

  function orderRank(o) {
    if (o.status === 'paid') return 0;                       // 입금 확인됨 — 발급만 남았다
    if (o.status === 'pending' && o.needs_review) return 1;  // 금액 뒷자리 없음 — 사람 확인 필요
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
    if (!box.firstChild || box.firstChild.className.indexOf('mg-empty') >= 0) listState(box, '불러오는 중…');
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
      var label = { open: '처리 대기', done: '발급 완료', canceled: '취소', all: '전체' }[filter] || '';
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

  function orderItem(o) {
    var st = ORDER_ST[o.status] || { kr: o.status || '-', cls: '' };
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
      open && o.needs_review ? tag('확인 필요', 'warn') : null,
      revivable ? tag('미입금 자동 취소', 'line') : null,
      chip(st.kr, st.cls)
    ]));
    item.appendChild(el('div', { cls: 'mg-r1' }, [
      el('span', { cls: 'mg-amt' }, wonKids(amt)),
      suffix ? el('span', { cls: 'mg-meta', text: '확인용 뒷자리 ' + suffix + '원 포함' }) : null,
      !suffix && base && open ? el('span', { cls: 'mg-meta', text: '뒷자리 없음' }) : null
    ]));
    if (open && o.needs_review) {
      item.appendChild(el('p', { cls: 'mg-warn', text:
        '금액 뒷자리가 배정되지 않은 주문입니다. 금액만으로 입금을 구분할 수 없으므로 [입금] 탭의 원문과 입금자명을 확인한 후 승인하십시오.' }));
    }
    if (o.status === 'paid') {
      item.appendChild(el('p', { cls: 'mg-line', text: '입금이 확인되었습니다(수동 확인 모드). 승인하면 키가 발급됩니다.' }));
    }

    item.appendChild(el('div', { cls: 'mg-line', text: productText(o.plan) + ' · ' + featText(o.features) }));
    var who = ['입금자 ' + (str(o.depositor) || '미기재')];
    if (str(o.buyer_name) && str(o.buyer_name) !== str(o.depositor)) who.push('구매자 ' + str(o.buyer_name));
    if (str(o.contact)) who.push(str(o.contact));
    item.appendChild(el('div', { cls: 'mg-line', text: who.join(' · ') }));

    if (o.target_key) item.appendChild(keyLine('연장 대상', o.target_key));
    if (o.issued_key && o.issued_key !== o.target_key) item.appendChild(keyLine('발급 키', o.issued_key));
    else if (o.issued_key && o.status === 'done') item.appendChild(el('div', { cls: 'mg-meta', text: '연장 대상 키에 적용되었습니다' }));

    var meta = '접수 ' + dateKr(o.created_at, true);
    if (num(o.handled_at)) meta += ' · 처리 ' + dateKr(o.handled_at, true);
    item.appendChild(el('div', { cls: 'mg-meta', text: meta }));
    if (str(o.memo)) item.appendChild(el('div', { cls: 'mg-meta', text: '메모: ' + str(o.memo) }));

    var acts = el('div', { cls: 'mg-acts' });
    if (open || revivable) acts.appendChild(btn(revivable ? '승인 (복구)' : '승인', 'sm primary', function () { openApprove(o); }));
    if (open) acts.appendChild(btn('취소', 'sm danger', function () { openCancel(o); }));
    if (o.issued_key) acts.appendChild(copyBtn(o.issued_key, '키가', '키 복사'));
    acts.appendChild(copyBtn(o.id, '주문번호가', '주문번호 복사'));
    item.appendChild(acts);
    return item;
  }

  function keyInput(value, placeholder) {
    return el('input', { cls: 'inp mono keyin', autocomplete: 'off', spellcheck: 'false', autocapitalize: 'characters',
                         maxlength: '24', placeholder: placeholder || 'KAKA-XXXX-XXXX-XXXX', value: value || '' });
  }

  // 주문 승인. 이 창 자체가 확인 단계다.
  // 서버 규칙(keys.approveOrder): 입력한 키 > 주문의 target_key > 신규 발급. 비워도 target_key 가 있으면 그 키를 연장한다.
  function openApprove(o) {
    var days = planDays(o.plan);
    var revivable = o.status === 'canceled' && !!o.auto_canceled;
    var input = keyInput(o.target_key || '');
    input.id = 'apKey';
    input.setAttribute('data-autofocus', '');
    var hint = el('p', { cls: 'hint', 'aria-live': 'polite' });
    function upd() {
      var k = normKey(input.value);
      if (k) hint.textContent = '이 키의 기능 3종이 ' + (days || '주문 기간만큼') + (days ? '일' : '') + ' 연장됩니다. 남은 기간이 있으면 만료일에 더해집니다.';
      else if (o.target_key) hint.textContent = '비워 두면 주문에 적힌 연장 대상 키(' + o.target_key + ')가 연장됩니다.';
      else hint.textContent = '비워 두면 새 키가 발급됩니다. 기존 키를 입력하면 그 키가 연장됩니다.';
    }
    input.addEventListener('input', upd);
    upd();

    var body = [
      kv([
        ['주문', o.id, 'mono'],
        ['금액', won(o.amount)],
        ['상품', productText(o.plan)],
        ['기능', featText(o.features)],
        ['입금자', str(o.depositor) || '미기재'],
        ['상태', (ORDER_ST[o.status] || { kr: o.status }).kr]
      ]),
      o.status === 'paid' ? note('입금이 확인된 주문입니다. 승인하면 키가 발급 또는 연장됩니다.') : null,
      o.needs_review ? note('금액 뒷자리가 없는 주문입니다. [입금] 탭의 원문에서 입금 금액과 입금자명을 확인한 후 승인하십시오.', true) : null,
      revivable ? note('미입금으로 자동 취소된 주문입니다. 승인하면 주문이 복구되고 키가 발급 또는 연장됩니다.', true) : null,
      o.status === 'pending' && !o.needs_review ? note('입금 확인 전입니다. 입금 내역을 확인한 경우에만 승인하십시오.', true) : null,
      el('div', { cls: 'fld' }, [
        el('label', { for: 'apKey', text: o.target_key ? '연장할 키' : '기존 키에 적용 (선택)' }),
        input,
        hint
      ])
    ];

    confirmAct({
      title: revivable ? '주문 복구 · 승인' : '주문 승인',
      body: body,
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
        showIssued({
          title: '승인 완료',
          key: j.key,
          lead: j.already ? '이미 처리된 주문입니다. 아래는 이 주문에 연결된 키입니다.'
            : (j.issued ? '새 키가 발급되었습니다. 구매자에게 아래 키를 전달하십시오.'
                        : '기존 키의 기능 3종이 연장되었습니다.'),
          isNew: !!j.issued && !j.already,
          orderId: o.id
        });
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
        (o.orderId ? '구매자는 주문 상태 화면(/order/' + o.orderId + ')에서도 같은 키를 확인할 수 있습니다. ' : '') +
        (o.isNew ? '이 키로 콘솔(/panel)에 처음 로그인하는 시점부터 사용 기간이 시작됩니다.' : '') })
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
        kv([['주문', o.id, 'mono'], ['금액', won(o.amount)], ['입금자', str(o.depositor) || '미기재']]),
        note('직접 취소한 주문은 승인으로 되돌릴 수 없으며, 이후 같은 금액이 입금되어도 자동 발급되지 않습니다.', true),
        el('div', { cls: 'fld' }, [el('label', { for: 'cnMemo', text: '취소 사유 (선택)' }), memo])
      ],
      ok: '주문 취소',
      run: function () {
        var s = str(memo.value);
        return api('POST', '/admin/order-cancel', { id: o.id, memo: s || null });
      },
      failMsg: '취소하지 못했습니다. 이미 발급 완료된 주문이거나 없는 주문입니다',
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
    if (!box.firstChild || box.firstChild.className.indexOf('mg-empty') >= 0) listState(box, '불러오는 중…');
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
            ? '확인이 필요한 입금이 없습니다. 수신된 입금은 모두 처리되었습니다.'
            : '입금 기록이 없습니다.\n판매자 휴대폰의 자동화 앱이 /api/deposit-hook 으로 은행 알림을 보내면 이 목록에 표시됩니다.');
          return;
        }
        top.forEach(function (d) { box.appendChild(depositItem(d)); });
        return;
      }
      if (!all.length) {
        listState(box, '입금 기록이 없습니다.\n판매자 휴대폰의 자동화 앱이 /api/deposit-hook 으로 은행 알림을 보내면 이 목록에 표시됩니다.');
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
    box.appendChild(chip(auto ? '자동 발급 켜짐' : '자동 발급 꺼짐', auto ? 'ok' : 'warn'));
    if (!hook) {
      box.appendChild(el('p', { cls: 'hint', style: 'flex-basis:100%', text:
        '서버에 DEPOSIT_TOKEN 이 설정되지 않아 은행 입금 알림을 받지 않습니다. 모든 주문을 [주문] 탭에서 직접 승인해야 합니다.' }));
    } else if (!auto) {
      box.appendChild(el('p', { cls: 'hint', style: 'flex-basis:100%', text:
        '자동 발급이 꺼져 있습니다(DEPOSIT_AUTO_APPROVE=0). 금액이 일치한 주문은 입금 확인 상태로 바뀌며, [주문] 탭에서 승인해야 키가 발급됩니다.' }));
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
    if (d.status === 'unmatched') item.appendChild(el('p', { cls: 'mg-warn', text: '금액이 일치하는 대기 주문이 없습니다. 뒷자리를 빼고 입금했거나 이미 처리된 주문일 수 있습니다.' }));
    if (d.status === 'ambiguous') item.appendChild(el('p', { cls: 'mg-crit', text: '금액만으로 주문을 특정할 수 없어 자동 발급하지 않았습니다. 원문과 입금자명을 확인한 후 매칭하십시오.' }));

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
        btn('수동 매칭', 'sm primary', function () { openMatch(d); }),
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
    var okBtn = btn('매칭하고 승인', 'primary');
    okBtn.disabled = true;
    var m = modal({ title: '수동 매칭', wide: true, body: [
      kv([
        ['입금 금액', amount === null ? '금액 읽지 못함' : won(amount)],
        ['입금자', str(d.name) || '알 수 없음'],
        ['수신', dateKr(d.at, true, true)]
      ]),
      el('pre', { cls: 'mg-raw open', text: str(d.raw) || '(원문 없음)' }),
      el('div', { cls: 'mg-empty', text: '승인 가능한 주문을 불러오는 중…' })
    ] });
    m.setActions([btn('닫기', 'ghost', function () { if (!m.busy) m.close(); }), okBtn]);

    api('GET', '/admin/orders?limit=' + LIST_LIMIT).then(function (r) {
      if (kicked(r)) return;
      if (!r.ok) {
        m.setBody([el('div', { cls: 'mg-empty bad', text: '주문 목록을 불러오지 못했습니다\n' + errText(r) })]);
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
        if (!id) { summary.textContent = '연결할 주문을 선택하십시오.'; return; }
        var o = null;
        for (var i = 0; i < cands.length; i++) if (cands[i].id === id) o = cands[i];
        append(summary, [
          '입금 기록 #' + d.id + ' 을 주문 ', el('b', { cls: 'mono', text: id }), ' 에 연결하고 승인합니다. ',
          o ? (o.target_key ? '연장 대상 키의 기능 3종이 연장됩니다.' : '새 키가 발급됩니다.') : '주문의 연장 대상 키가 있으면 연장, 없으면 새 키가 발급됩니다.'
        ]);
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
        var st = ORDER_ST[o.status] || { kr: o.status };
        pick.appendChild(el('label', { cls: 'chk' }, [
          radio,
          el('span', { cls: 'box', 'aria-hidden': 'true' }),
          el('span', { cls: 't' }, [
            el('span', { cls: 'mg-r1' }, [
              el('span', { cls: 'mono', style: 'color:var(--fg)', text: o.id }),
              same ? tag('금액 일치', '') : null,
              o.id === d.matched_order ? tag('후보', 'warn') : null,
              o.needs_review ? tag('뒷자리 없음', 'warn') : null
            ]),
            el('span', { cls: 'mg-meta', text: won(o.amount) + ' · 입금자 ' + (str(o.depositor) || '미기재') + ' · ' +
                                                st.kr + (o.auto_canceled && o.status === 'canceled' ? '(자동)' : '') +
                                                ' · ' + dateKr(o.created_at, true) }),
            o.target_key ? el('span', { cls: 'mg-meta', text: '연장 대상 ' + o.target_key }) : null
          ])
        ]));
      });
      manual.addEventListener('input', function () {
        if (str(manual.value)) $$('input[name="' + gname + '"]', m.dlg).forEach(function (x) { x.checked = false; });
        upd();
      });

      m.setBody([
        kv([
          ['입금 금액', amount === null ? '금액 읽지 못함' : won(amount)],
          ['입금자', str(d.name) || '알 수 없음'],
          ['수신', dateKr(d.at, true, true)]
        ]),
        el('pre', { cls: 'mg-raw', text: str(d.raw) || '(원문 없음)' }),
        el('div', { cls: 'mg-sec' }, [
          el('span', { cls: 'mg-h3', text: '승인 가능한 주문 ' + cands.length + '건 · 금액이 같은 주문을 위에 표시합니다' }),
          cands.length ? pick : el('div', { cls: 'mg-empty', text: '승인 가능한 주문이 없습니다' })
        ]),
        el('div', { cls: 'fld' }, [
          el('label', { for: 'mtManual', text: '목록에 없는 주문번호 직접 입력' }),
          manual,
          el('p', { cls: 'hint', text: '최근 ' + LIST_LIMIT + '건 밖의 주문이면 주문번호를 입력하십시오.' })
        ]),
        summary
      ]);
      upd();
      var first = $('input[name="' + gname + '"]:checked', m.dlg) || $('input[name="' + gname + '"]', m.dlg) || manual;
      try { first.focus(); } catch (e) { /* 없음 */ }

      okBtn.addEventListener('click', function () {
        if (m.busy) return;
        var id = chosen();
        if (!id) { m.error('연결할 주문을 선택하십시오'); return; }
        m.error('');
        m.setBusy(true, okBtn);
        api('POST', '/admin/deposit-match', { deposit_id: d.id, order_id: id }).then(function (res) {
          m.setBusy(false, okBtn);
          if (kicked(res)) return;
          if (!res.ok) { m.error(errText(res, '매칭하지 못했습니다')); return; }
          m.close();
          showIssued({
            title: '매칭 완료',
            key: res.json.key,
            lead: res.json.already
              ? '이미 처리된 주문입니다. 입금 기록만 이 주문에 연결되었습니다.'
              : '주문 ' + id + ' 이 승인되었습니다. 아래 키가 발급 또는 연장되었습니다.',
            isNew: false,
            orderId: id
          });
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
        para('이 입금 기록을 무시 처리합니다. 확인 필요 목록에서 빠지며, 주문 상태와 키는 바뀌지 않습니다. 판매와 관계없는 입금(이체·환불 등)에 사용하십시오.')
      ],
      ok: '무시',
      run: function () { return api('POST', '/admin/deposit-ignore', { deposit_id: d.id }); },
      failMsg: '처리하지 못했습니다. 이미 삭제된 기록입니다',
      done: function () {
        toast('무시 처리되었습니다', 'ok');
        loadStats();
        loadDeposits();
      }
    });
  }

  /* ══════════════════ 10. 키 ══════════════════ */

  var KEYS = { term: '', rows: [], total: 0, now: 0, gen: 0, dirty: false };

  function findFeat(lic, id) {
    var fs = lic && Array.isArray(lic.features) ? lic.features : [];
    for (var i = 0; i < fs.length; i++) if (fs[i] && fs[i].feature === id) return fs[i];
    return null;
  }
  function maxExp(lic) {
    var m = 0;
    (lic.features || []).forEach(function (e) { var x = num(e.expires_at) || 0; if (x > m) m = x; });
    return m;
  }
  // "시작됐다" 판정은 lib/keys.js grant() 와 같다: 예전 앱 기기 등록 · /panel 첫 로그인 · 만료일이 잡힌 기능
  function isStarted(lic) {
    if (lic.device_id || num(lic.activated_at)) return true;
    return (lic.features || []).some(function (e) { return num(e.expires_at) !== null; });
  }
  function licState(lic, now) {
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
    return p + ' · ' + dateKr(exp, true) + ' 까지';
  }

  // 목록용 기능 칩: 3종 만료일이 같으면(새 키는 항상 그렇다) 칩 하나로 줄인다
  function featChips(lic, now) {
    var fs = FEATS.map(function (f) { return findFeat(lic, f); });
    var all = fs.every(Boolean);
    if (all) {
      var e0 = fs[0];
      var same = fs.every(function (e) {
        return num(e.expires_at) === num(e0.expires_at) &&
               (num(e.expires_at) !== null || num(e.duration_ms) === num(e0.duration_ms));
      });
      if (same) {
        var s = featState(e0, now);
        var extra = num(e0.expires_at) !== null ? ' · ' + dateKr(e0.expires_at) + ' 까지'
          : ' · 대기 ' + Math.round((num(e0.duration_ms) || 0) / DAY) + '일';
        return [chip('기능 3종 ' + s.kr + extra, s.cls)];
      }
    }
    var out = [];
    var missing = [];
    FEATS.forEach(function (f, i) {
      if (fs[i]) { var s2 = featState(fs[i], now); out.push(chip(FEAT_SHORT[f] + ' ' + s2.kr, s2.cls)); }
      else missing.push(FEAT_SHORT[f]);
    });
    if (missing.length) out.push(tag('미보유 ' + missing.join(' · '), 'line'));
    return out;
  }

  function loadKeys(append) {
    var my = ++KEYS.gen;
    var box = $('#keyList');
    var more = $('#keyMore');
    if (!append) {
      KEYS.rows = [];
      if (!box.firstChild || box.firstChild.className.indexOf('mg-empty') >= 0) listState(box, '불러오는 중…');
    } else {
      busyBtn(more, true);
    }
    KEYS.dirty = false;
    var offset = append ? KEYS.rows.length : 0;
    var q = '/admin/list?limit=' + KEY_PAGE + '&offset=' + offset + (KEYS.term ? '&q=' + encodeURIComponent(KEYS.term) : '');
    api('GET', q).then(function (r) {
      if (my !== KEYS.gen) return;
      busyBtn(more, false);
      if (kicked(r)) return;
      if (!r.ok) {
        if (append) { toast('목록을 더 불러오지 못했습니다 · ' + errText(r), 'bad'); return; }
        listState(box, '키 목록을 불러오지 못했습니다\n' + errText(r), true);
        $('#keyCount').textContent = '';
        more.hidden = true;
        return;
      }
      KEYS.total = num(r.json.total) || 0;
      KEYS.now = num(r.json.now) || Date.now();
      KEYS.rows = (append ? KEYS.rows : []).concat(r.json.licenses || []);
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
      listState(box, KEYS.term ? '검색 결과가 없습니다' : '발급된 키가 없습니다.\n[새 키 발급] 으로 키를 발급하십시오.');
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
                    body: el('div', { cls: 'mg-empty', text: '불러오는 중…' }) });
    m.setActions([btn('닫기', 'ghost', function () { m.close(); })]);
    var gen = 0;
    function refresh() {
      var my = ++gen;
      return api('GET', '/admin/license?key=' + encodeURIComponent(k)).then(function (r) {
        if (my !== gen) return;
        if (kicked(r)) return;
        if (!r.ok) {
          m.setBody(el('div', { cls: 'mg-empty bad', text: errText(r, '키를 불러오지 못했습니다') }));
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
    var changed = function () { KEYS.dirty = true; loadStats(); refresh(); };

    m.setTitle('키 상세');

    // 키 + 상태
    var top = el('div', { cls: 'big hi' }, [
      el('div', { cls: 'k', text: '라이선스 키' }),
      el('div', { cls: 'mg-keybox' }, [
        el('div', { cls: 'v key', text: key }),
        copyBtn(key, '키가', '키 복사')
      ]),
      el('div', { cls: 'chip-row', style: 'margin-top:10px' }, [chip(st.kr, st.cls)])
    ]);
    var alerts = [];
    if (str(lic.blocked_reason)) alerts.push(note('차단된 키입니다. 사유: ' + str(lic.blocked_reason), true));
    if (lic.revoked) alerts.push(note('회수된 키입니다. 이 키로는 콘솔(/panel)에 접속할 수 없습니다. 남은 기간은 보존됩니다.', true));
    if (!isStarted(lic) && (lic.features || []).length) {
      alerts.push(note('아직 사용 전입니다. 이 키로 콘솔(/panel)에 처음 로그인하는 시점부터 사용 기간이 시작됩니다.'));
    }

    // 기능
    var featBox = el('div');
    FEATS.forEach(function (f) {
      var e = findFeat(lic, f);
      var s = featState(e, now);
      featBox.appendChild(el('div', { cls: 'mg-feat' }, [
        el('span', { cls: 'nm', text: FEAT_LABEL[f] }),
        el('span', { cls: 'ln', text: featLine(e) }),
        chip(s.kr, s.cls),
        e ? btn('회수', 'sm danger', function () { revokeFeature(key, f, changed); }) : el('span')
      ]));
    });

    // 정보
    var info = kv([
      ['소유자', str(lic.owner_name) || '-'],
      ['연락처', str(lic.owner_contact) || '-'],
      str(lic.note) ? ['메모', str(lic.note)] : null,
      ['발급', dateKr(lic.created_at, true)],
      ['사용 시작', num(lic.activated_at) ? dateKr(lic.activated_at, true) : '-'],
      ['최종 만료', maxExp(lic) ? dateKr(maxExp(lic), true) : '-']
    ]);

    // 관리
    var acts = el('div', { cls: 'btn-row', style: 'margin-top:0' }, [
      btn('+30일 연장', 'primary', function () { openExtend(lic, now, changed); }),
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
        el('p', { cls: 'hint', style: 'margin-top:0', text: '연장은 기능 3종 모두에 적용됩니다. 환불은 삭제 대신 회수를 사용하면 기록이 남습니다.' })]),
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
    return FEATS.map(function (f) {
      var cur = findFeat(lic, f);
      if (!cur) return { f: f, text: started ? dateKr(now + durMs, true) + ' 까지 (새로 추가)' : '사용 시작 전 · 대기 ' + Math.round(durMs / DAY) + '일 (새로 추가)' };
      var prevExp = num(cur.expires_at);
      var prevDur = num(cur.duration_ms) || 0;
      if (prevExp === null && !started) return { f: f, text: '사용 시작 전 · 대기 ' + Math.round((prevDur + durMs) / DAY) + '일' };
      var exp = prevExp === null ? now + prevDur + durMs : Math.max(now, prevExp) + durMs;
      return { f: f, text: dateKr(exp, true) + ' 까지' };
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
          el('span', { cls: 'nm', text: FEAT_LABEL[x.f] }),
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
        para('기능 3종 모두에 적용됩니다. 남은 기간이 있으면 만료일에 더해지고, 이미 만료된 기능은 지금부터 계산됩니다. 보유하지 않은 기능은 새로 추가됩니다.'),
        per.node,
        el('section', { cls: 'mg-sec' }, [el('h3', { cls: 'mg-h3', text: '연장 후 (예상)' }), prev])
      ],
      ok: '연장',
      check: function () { var p = per.get(); return p.error || ''; },
      run: function () {
        var p = per.get();
        var body = { key: lic.key, features: FEATS.slice(), plan: p.plan };
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
        kv([['키', key, 'mono'], ['기능', FEAT_LABEL[f]]]),
        note(FEAT_LABEL[f] + ' 기능을 이 키에서 삭제합니다. 남은 기간도 함께 소멸되며 되돌릴 수 없습니다. 다시 부여하려면 기간 연장을 사용하십시오.', true)
      ],
      ok: '기능 회수',
      run: function () { return api('POST', '/admin/revoke-feature', { key: key, feature: f }); },
      failMsg: '회수하지 못했습니다. 이미 없는 기능입니다',
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
        on ? note('이 키의 사용을 중지합니다. 이 키로는 콘솔(/panel)에 접속할 수 없게 됩니다. 남은 기간은 보존되며, 회수 해제로 되돌릴 수 있습니다.', true)
           : para('회수를 해제합니다. 이 키로 콘솔(/panel)에 다시 접속할 수 있습니다.')
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
          para('차단을 해제합니다. 이 키로 콘솔(/panel)에 다시 접속할 수 있습니다.')
        ],
        ok: '차단 해제',
        run: function () { return api('POST', '/admin/block', { key: lic.key, reason: null }); },
        failMsg: '처리하지 못했습니다. 등록되지 않은 키입니다',
        done: function () { toast('차단이 해제되었습니다', 'ok'); changed(); }
      });
      return;
    }
    var reason = el('input', { cls: 'inp', id: 'blReason', maxlength: '500', autocomplete: 'off', placeholder: '예: 결제 분쟁, 이용 약관 위반' });
    reason.setAttribute('data-autofocus', '');
    confirmAct({
      title: '키 차단',
      danger: true,
      body: [
        kv([['키', lic.key, 'mono'], ['소유자', str(lic.owner_name) || '-']]),
        note('이 키의 사용을 차단합니다. 이 키로는 콘솔(/panel)에 접속할 수 없고, 이 키로 연장 주문을 할 수 없습니다. 차단 사유는 기록에 남습니다.', true),
        field('차단 사유 (필수)', reason)
      ],
      ok: '차단',
      check: function () { return str(reason.value) ? '' : '차단 사유를 입력하십시오'; },
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
        note('키와 기능별 기간, 소유자 정보가 모두 삭제되며 되돌릴 수 없습니다. 이 키로 접수된 주문 기록은 남습니다. 환불·정지 처리에는 삭제 대신 회수를 사용하십시오.', true),
        field('확인을 위해 키의 마지막 4자리(' + tail + ')를 입력하십시오', conf)
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

  /* ── 새 키 발급 */

  function openCreate() {
    var per = periodPicker('mg-new-' + (++modalSeq));
    var count = el('input', { cls: 'inp mono', type: 'number', inputmode: 'numeric', min: '1', max: '20', step: '1', value: '1' });
    var owner = el('input', { cls: 'inp', maxlength: '100', autocomplete: 'off' });
    var contact = el('input', { cls: 'inp', maxlength: '100', autocomplete: 'off' });
    var memo = el('input', { cls: 'inp', maxlength: '500', autocomplete: 'off', placeholder: '예: 테스트용, 지인 제공' });
    owner.setAttribute('data-autofocus', '');
    confirmAct({
      title: '새 키 발급',
      body: [
        note('판매 상품(K bot 1개월)과 같은 구성입니다. 기능 3종(' + FEATS.map(featLabel).join(' · ') +
             ')이 모두 포함되며, 사용 기간은 이 키로 콘솔(/panel)에 처음 로그인한 시점부터 시작됩니다.'),
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
        var n = Math.floor(Number(count.value));
        if (!isFinite(n) || n < 1 || n > 20) return '수량은 1~20 사이로 입력하십시오';
        return '';
      },
      run: function () {
        var p = per.get();
        var body = {
          features: FEATS.slice(), plan: p.plan, count: Math.floor(Number(count.value)) || 1,
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
      para(list.length + '개 키가 발급되었습니다. 기능 3종 · ' + (days || '') + '일. 사용 기간은 첫 로그인 시점부터 시작됩니다.'),
      el('div', { cls: 'mg-keys-out' }, list.map(function (k) {
        return el('div', { cls: 'r' }, [el('span', { cls: 'mono', text: k }), copyBtn(k, '키가')]);
      }))
    ] });
    var acts = [btn('닫기', 'ghost', function () { m.close(); })];
    if (list.length > 1) acts.push(btn('전체 복사', 'primary', function () { copy(list.join('\n'), '키 ' + list.length + '개가'); }));
    else if (list.length === 1) acts.push(btn('키 복사', 'primary', function () { copy(list[0], '키가'); }));
    m.setActions(acts);
  }

  /* ══════════════════ 11. 기록 ══════════════════ */

  var AUD = { gen: 0, kind: '', key: '', learned: false };

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
    if (!box.firstChild || box.firstChild.className.indexOf('mg-empty') >= 0) listState(box, '불러오는 중…');
    var q = '/admin/audit?limit=' + LIST_LIMIT;
    if (AUD.kind) q += '&kind=' + encodeURIComponent(AUD.kind);
    if (AUD.key) q += '&key=' + encodeURIComponent(AUD.key);
    api('GET', q).then(function (r) {
      if (my !== AUD.gen) return;
      if (kicked(r)) return;
      if (!r.ok) { listState(box, '기록을 불러오지 못했습니다\n' + errText(r), true); $('#audCount').textContent = ''; return; }
      if (Array.isArray(r.json.alert_kinds) && r.json.alert_kinds.length) ALERT_KINDS = r.json.alert_kinds.slice();
      if (!AUD.learned && Array.isArray(r.json.kinds)) { AUD.learned = true; fillKinds(r.json.kinds); }
      var list = r.json.audit || [];
      var label = AUD.kind ? (KIND_LABEL[AUD.kind] || AUD.kind) : '전체';
      $('#audCount').textContent = label + ' ' + list.length + '건' + (AUD.key ? ' · 키 ' + AUD.key : '') +
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
    $('#audKey').value = AUD.key;
    $('#audKind').value = '';
    if (TAB === 'audit') loadAudit(); else switchTab('audit');
  }

  /* ══════════════════ 12. 시작 ══════════════════ */

  function bind() {
    $('#loginForm').addEventListener('submit', onLoginSubmit);
    $('#logoutBtn').addEventListener('click', logout);
    $('#refreshBtn').addEventListener('click', function () { hideLock(); refreshAll(); });

    $$('.mg-tab').forEach(function (b) {
      b.addEventListener('click', function () { switchTab(b.getAttribute('data-tab')); });
      b.addEventListener('keydown', onTabKey);
    });
    window.addEventListener('hashchange', function () { if (STARTED) switchTab(tabFromHash()); });

    $$('.mg-stat').forEach(function (b) {
      b.addEventListener('click', function () {
        var go = b.getAttribute('data-go');
        var f = b.getAttribute('data-filter');
        if (go === 'orders' && f) { ORD.filter = f; setFilter('#ordFilt', f); }
        if (go === 'deposits' && f) { DEP.filter = f; setFilter('#depFilt', f); }
        if (go === TAB) loadTab(go); else switchTab(go);
        var tab = $('#tab-' + go);
        if (tab && tab.scrollIntoView) tab.scrollIntoView({ block: 'start', behavior: 'smooth' });
      });
    });

    $$('#ordFilt button').forEach(function (b) {
      b.addEventListener('click', function () {
        ORD.filter = b.getAttribute('data-f');
        setFilter('#ordFilt', ORD.filter);
        listState($('#ordList'), '불러오는 중…');
        loadOrders();
      });
    });
    $$('#depFilt button').forEach(function (b) {
      b.addEventListener('click', function () {
        DEP.filter = b.getAttribute('data-f');
        setFilter('#depFilt', DEP.filter);
        listState($('#depList'), '불러오는 중…');
        loadDeposits();
      });
    });

    $('#keyForm').addEventListener('submit', function (e) {
      e.preventDefault();
      KEYS.term = str($('#keyQ').value).slice(0, 100);
      listState($('#keyList'), '불러오는 중…');
      loadKeys(false);
    });
    $('#keyMore').addEventListener('click', function () { loadKeys(true); });
    $('#keyNew').addEventListener('click', openCreate);

    $('#audForm').addEventListener('submit', function (e) {
      e.preventDefault();
      AUD.kind = $('#audKind').value;
      var raw = str($('#audKey').value);
      AUD.key = raw ? (normKey(raw) || raw.toUpperCase()) : '';
      if (raw) $('#audKey').value = AUD.key;
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
