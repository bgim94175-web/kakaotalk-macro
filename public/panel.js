(function () {
  'use strict';
  // docs/UI_V5.md — 콘솔. 화면은 panel.html 의 정적 section.page[data-route] 이고, 이 파일은 값을 채우고 라우팅한다.
  // 주요 알림 동작은 docs/UI_V4.md 5장 그대로(상태·폴링·재렌더 회피·늦은 응답·전송·닫기).
  // docs/ACCOUNTS_V1.md 6.9 — 회원 로그인(/api/auth/login), 카카오 계정(매크로), 내 방(#rooms·#room/<id>·#r-*/<id>).
  var me = null;
  var account = null;
  var rooms = [];                 // RoomView[] (3.4.2) — /panel/api/me.rooms 와 /panel/api/bot-rooms
  var roomSeen = {};              // install_id → 마지막으로 본 {d: display, rb: 방 관리봇 여부} (승격·강등 알림용)
  var routeArg = '';              // #route/<arg> 의 arg (방 라우트의 install_id)
  var curId = '';                 // 지금 설정·기록을 보는 계정
  var images = [];                // 새로 고른 이미지 [{b64, name}]
  var savedImages = 0;            // 서버에 저장된 이미지 수(미리 보기 없음, 바꾸면 통째로 대체된다)
  var imagesDirty = false;
  var triggers = [];
  var openRules = {};
  var coverWords = [];
  var pendingId = '';
  var regDevice = '';
  // 확인 번호 폴링 세대. 취소·숨기기·새 시작마다 올려서, 잠자던 옛 루프가 깨어나도 이어 가지 못하게 한다.
  var confirmGen = 0;

  function $(id) { return document.getElementById(id); }
  function qs(sel, root) { return (root || document).querySelector(sel); }
  function qsa(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }

  var login = $('login');
  var app = $('app');
  var who = $('who');
  var logout = $('logout');
  var runstate = $('runstate');
  var list = $('account-list');
  var passcode = $('passcode');
  var inboxEl = $('inbox');
  var railEl = $('rail');
  var railAccounts = $('rail-accounts');
  var viewEl = $('view');
  var saveEl = $('save');
  var saveBtn = $('saveBtn');
  var isMac = /Mac|iPhone|iPad/.test(navigator.platform || '');

  function reducedMotion() { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; }
  function isPhone() { return window.matchMedia('(max-width: 760px)').matches; }
  function wide() { return window.matchMedia('(min-width: 720px)').matches; }

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function ic(name, size) {
    var s = size || 16;
    return '<svg class="ic" width="' + s + '" height="' + s + '" aria-hidden="true"><use href="#i-' + name + '"></use></svg>';
  }
  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
  function fmtNum(n) { return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ','); }
  function short(email) { var s = String(email || ''); var i = s.indexOf('@'); return i > 0 ? s.slice(0, i) : s; }
  function iga(w) {
    var c = w.charCodeAt(w.length - 1);
    if (c < 0xAC00 || c > 0xD7A3) return w + '이(가)';
    return w + ((c - 0xAC00) % 28 ? '이' : '가');
  }
  function sameDay(a, b) {
    var x = new Date(a), y = new Date(b);
    return x.getFullYear() === y.getFullYear() && x.getMonth() === y.getMonth() && x.getDate() === y.getDate();
  }
  function fmtHM(ms) { var d = new Date(Number(ms) || 0); return pad(d.getHours()) + ':' + pad(d.getMinutes()); }
  function fmtMD(ms) { var d = new Date(Number(ms) || 0); return pad(d.getMonth() + 1) + '.' + pad(d.getDate()); }
  function fmtT(ms) { return sameDay(ms, Date.now()) ? fmtHM(ms) : fmtMD(ms) + ' ' + fmtHM(ms); }
  function fmtTL(ms) { return fmtMD(ms) + ' ' + fmtHM(ms); }
  function fmtFull(ms) { var d = new Date(Number(ms) || 0); return d.getFullYear() + '.' + fmtMD(ms) + ' ' + fmtHM(ms); }
  function linkText(u) { return String(u || '').replace(/^https?:\/\//, ''); }
  function last(arr) { return arr && arr.length ? arr[arr.length - 1] : 0; }
  // 모노 글꼴에는 한글을 넣지 않는다(UI_V5 2.1) — 사용자가 쓴 글에 한글이 있으면 산세리프로
  function hangul(t) { return /[\u3131-\u318e\uac00-\ud7a3]/.test(String(t || '')); }

  function say(id, text) {
    var n = document.getElementById(id);
    if (n) n.textContent = text || '';
  }

  async function api(path, body) {
    var opt = { method: body ? 'POST' : 'GET', credentials: 'same-origin', headers: {} };
    if (body) {
      opt.headers['content-type'] = 'application/json';
      opt.body = JSON.stringify(body);
    }
    var res = await fetch(path, opt);
    var json = null;
    try { json = await res.json(); } catch (e) { json = null; }
    if (!json) {
      var unreadable = new Error('응답을 읽지 못했습니다.');
      unreadable.status = res.status;
      throw unreadable;
    }
    if (!res.ok || json.ok === false) {
      var err = new Error(json.error || '처리하지 못했습니다.');
      err.body = json;
      err.status = res.status;
      err.reason = json.reason || '';
      throw err;
    }
    return json;
  }
  // 로그인이 끊긴 응답만 로그인 화면으로 보낸다. 403 은 대개 기능 거절(no_macro·legacy_only·no_roombot…)이고,
  // 차단된 회원(blocked)만 세션 문제다(ACCOUNTS_V1 3.1).
  function authFail(e) {
    if (!e) return false;
    if (e.status === 401) return true;
    return e.status === 403 && !!e.body && e.body.reason === 'blocked';
  }

  // ── 회원·상품 (ACCOUNTS_V1 3.4.1) ──────────────────────────
  function maxAcc() { var n = me && Number(me.max_accounts); return n > 0 ? n : 3; }
  function macroInfo() { return (me && me.macro) || { until: 0, active: false, days_left: 0 }; }
  // 계정 단위 옛 기능(입장·퇴장 로그·프로필 로그·올킥 방지·금지어 검열)을 보여 줄지 — 이관한 회원의 유예 기간(D20)
  function legacyOn() {
    if (account && typeof account.legacy === 'boolean') return account.legacy;
    return !!(me && Number(me.legacy_room_until) > Date.now());
  }
  // 새 카카오 계정 등록이 가능한가: 매크로 이용 중이거나 옛 기능 유예 중(3.4.1 register/begin)
  function macroOk() { return !!(macroInfo().active || (me && Number(me.legacy_room_until) > Date.now())); }
  function loginId() { return (me && me.member && me.member.login_id) || ''; }

  function reasonText(row) {
    if (!me || !me.sender_up) return (me && me.sender_reason) || '발송 서버가 멈춰 있습니다';
    if (row.connected) return '이 서버에서 보내는 중';
    if (row.needs_register) return '다시 등록이 필요합니다';
    if (row.linked) return '서버에 등록됨 · 접속하는 중';
    if (row.reason === 'kicked') return '다른 기기가 접속을 가져갔습니다';
    if (row.reason === 'unlinked') return '등록이 해제되었습니다';
    return '아직 서버에 접속하지 않았습니다';
  }

  // ── 토스트 (4.3) ───────────────────────────────────────────
  function notify(title, sub, opt) {
    opt = opt || {};
    var box = $('toasts');
    var t = el('div', 'toast' + (opt.kind === 'crit' ? ' crit' : ''));
    t.setAttribute('role', 'status');
    t.appendChild(el('i', 'dot ' + (opt.kind === 'warn' ? 'warn' : opt.kind === 'crit' ? 'crit' : 'ok')));
    var body = el('div');
    body.appendChild(el('b', '', title));
    if (sub) body.appendChild(el('span', '', sub));
    t.appendChild(body);
    var timer = null;
    function bye() {
      if (timer) clearTimeout(timer);
      if (!t.parentNode) return;
      t.classList.add('bye');
      setTimeout(function () { if (t.parentNode) t.parentNode.removeChild(t); }, reducedMotion() ? 0 : 240);
    }
    if (opt.action) {
      var b = el('button', 'btn sm', opt.action.label);
      b.type = 'button';
      b.addEventListener('click', function () { opt.action.fn(); bye(); });
      t.appendChild(b);
    }
    var x = el('button', 'x');
    x.type = 'button';
    x.setAttribute('aria-label', '알림 닫기');
    x.innerHTML = ic('x', 12);
    x.addEventListener('click', bye);
    t.appendChild(x);
    box.appendChild(t);
    while (box.children.length > 3) box.removeChild(box.firstChild);
    timer = setTimeout(bye, opt.action ? 6000 : 2800);
  }

  async function copyText(txt) {
    var done = false;
    try { if (navigator.clipboard) { await navigator.clipboard.writeText(txt); done = true; } } catch (e) { done = false; }
    if (!done) {
      try {
        var ta = el('textarea');
        ta.value = txt;
        ta.setAttribute('readonly', '');
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        done = document.execCommand('copy');
        document.body.removeChild(ta);
      } catch (e) { done = false; }
    }
    if (done) notify('복사했습니다.', txt);
    else notify('복사하지 못했습니다.', '직접 선택해 복사해 주세요.', { kind: 'crit' });
  }

  // ── 화면 이름표 (1.4) ──────────────────────────────────────
  var ROUTES = {
    overview: { t: '개요', member: true, g: 'o', icon: 'overview' },
    inbox: { t: '받은 갠톡', g: 'i', icon: 'inbox' },
    accounts: { t: '카카오 계정', g: 'a', icon: 'accounts' },
    'account-add': { t: '카카오 계정 추가', nav: 'accounts' },
    rooms: { t: '내 방', member: true, g: 'b', icon: 'link' },
    macro: { t: '매크로', acct: true, feat: 'macro', sw: 'macro-on', g: 'm', icon: 'macro' },
    visit: { t: '입장·퇴장 기록', acct: true, legacy: true, feat: 'visit', sw: 'visit-on', g: 'v', icon: 'visit' },
    profile: { t: '프로필 기록', acct: true, legacy: true, feat: 'profile', sw: 'profile-on', g: 'p', icon: 'profile' },
    guard: { t: '올킥 감지', acct: true, legacy: true, feat: 'guard', sw: 'guard-on', g: 'k', icon: 'guard' },
    cover: { t: '금지어 검열', acct: true, legacy: true, feat: 'cover', sw: 'cover-on', g: 'c', icon: 'cover' },
    reply: { t: '갠톡 응답', acct: true, feat: 'autoreply', sw: 'reply-on', g: 'r', icon: 'reply' },
    snipe: { t: '저격 규칙', acct: true, feat: 'triggers', g: 's', icon: 'snipe' },
    // 내 방 (ACCOUNTS_V1 6.9 라우트 표) — 해시 #<route>/<install_id>
    room: { t: '방 상태', room: true, icon: 'overview' },
    'r-visit': { t: '입장·퇴장 기록', room: true, roombot: true, sw: 'r-visit-on', icon: 'visit' },
    'r-profile': { t: '프로필 기록', room: true, roombot: true, sw: 'r-profile-on', icon: 'profile' },
    'r-promo': { t: '홍보 금지', room: true, roombot: true, sw: 'r-promo-on', icon: 'alert' },
    'r-cover': { t: '글 가리기·금지어 검열', room: true, roombot: true, sw: 'r-cover-on', icon: 'cover' },
    'r-guard': { t: '올킥 감지', room: true, roombot: true, sw: 'r-guard-on', icon: 'guard' },
    'r-games': { t: '미니게임', room: true, minigame: true, sw: 'r-games-on', icon: 'game' },
  };
  var FEAT_ROUTES = ['macro', 'visit', 'profile', 'guard', 'cover', 'reply', 'snipe'];
  var ROOM_ROUTES = ['room', 'r-visit', 'r-profile', 'r-promo', 'r-cover', 'r-guard', 'r-games'];
  var LEGACY_ROUTES = { visit: 1, profile: 1, guard: 1, cover: 1 };
  var LOG_ROUTES = { overview: 1, visit: 1, profile: 1, guard: 1 };
  var ROOM_LOG_ROUTES = { room: 1, 'r-visit': 1, 'r-profile': 1, 'r-guard': 1 };
  var FEAT_ROUTE = { macro: 'macro', visit: 'visit', profile: 'profile', guard: 'guard', cover: 'cover', autoreply: 'reply', triggers: 'snipe' };
  var GKEYS = { o: 'overview', i: 'inbox', a: 'accounts', b: 'rooms', m: 'macro', v: 'visit', p: 'profile', k: 'guard', c: 'cover', r: 'reply', s: 'snipe' };
  var LEGACY_NOTE = '방 관리 기능은 내 방에서 방마다 설정합니다.';
  function formOf(r) { return r + '-form'; }
  function errIdOf(r) { return r === 'room' ? 'room-set-error' : r + '-error'; }
  function routeTitle(r) { return ROUTES[r] ? ROUTES[r].t : ''; }
  function isRoomRoute(r) { return ROOM_ROUTES.indexOf(r) >= 0; }
  function isFormRoute(r) { return FEAT_ROUTES.indexOf(r) >= 0 || isRoomRoute(r); }
  // 기록 화면(계정 단위 옛 기능)은 유예 회원에게만 — 개요의 최근 기록도 그때만 읽는다
  function logRoute(r) { return !!LOG_ROUTES[r] && legacyOn(); }
  function curHash() { return route + (routeArg ? '/' + routeArg : ''); }

  function featOn(key) {
    if (!account) return false;
    if (key === 'triggers') return (account.triggers || []).some(function (t) { return t && t.enabled !== false; });
    return !!(account[key] && account[key].enabled);
  }

  // ── 로그인·셸 ─────────────────────────────────────────────
  // e: 로그인이 끊긴 응답(401 session_evicted 등)이면 그 문구를 로그인 카드에 보인다(3.1)
  function showLogin(e) {
    document.body.dataset.screen = 'login';
    login.hidden = false;
    app.hidden = true;
    who.textContent = '';
    stopLogs();
    stopRoomTimers();
    chatReset();
    route = '';
    routeArg = '';
    app.dataset.route = '';
    dirtyN = 0;
    leaveTarget = null;
    saveEl.classList.remove('show', 'leave');
    palClose(true);
    var msg = e && e.body && e.body.reason && e.body.reason !== 'login_required' && e.message ? e.message : '';
    say('login-error', msg);
    if (wide()) setTimeout(function () { $('login-id').focus(); }, 30);
  }

  function showApp() {
    document.body.dataset.screen = 'app';
    login.hidden = true;
    app.hidden = false;
    who.textContent = loginId();
    if (Array.isArray(me && me.rooms)) applyRooms(me.rooms, true);
    // 띠는 발송 서버 상태 하나만 말한다. /inbox 응답이 오면 그 값으로 덮어쓴다.
    inboxSt.senderUp = !!(me && me.sender_up);
    inboxSt.senderReason = (me && me.sender_reason) || '';
    updateStrip();
    updateLicense();
  }

  function meAccounts() { return (me && me.accounts) || []; }
  function meAcc(id) {
    var rows = meAccounts();
    for (var i = 0; i < rows.length; i++) if (rows[i].device_id === id) return rows[i];
    return null;
  }
  function needsReg(id) {
    var a = accOf(id);
    if (a && a.status === 'needs_register') return true;
    var m = meAcc(id);
    return !!(m && m.needs_register);
  }

  // 사이드바 아래: 회원 아이디 + 카카오톡 매크로 남은 기간(6.9 #lic)
  function macroDays(m) {
    if (!m || !m.until) return 0;
    var n = Number(m.days_left);
    if (!(n >= 0)) n = Math.ceil((Number(m.until) - Date.now()) / 86400000);
    return n;
  }
  function updateLicense() {
    var lic = $('lic');
    var left = $('licLeft');
    var bar = $('licBar');
    var m = macroInfo();
    left.removeAttribute('title');
    if (!me || !Number(m.until)) {
      left.textContent = me ? '매크로 미구매' : '';
      bar.style.transform = 'scaleX(0)';
      lic.classList.remove('warn');
      return;
    }
    var until = Number(m.until);
    left.title = fmtFull(until).slice(0, 10) + ' 만료';
    if (!m.active || until <= Date.now()) {
      left.textContent = '매크로 만료';
      bar.style.transform = 'scaleX(0)';
      lic.classList.add('warn');
      return;
    }
    var hours = (until - Date.now()) / 3600000;
    var n = macroDays(m);
    left.textContent = hours < 24 ? '오늘 만료' : '매크로 D-' + n;
    bar.style.transform = 'scaleX(' + (Math.max(0, Math.min(n, 30)) / 30) + ')';
    lic.classList.toggle('warn', n <= 7);
  }

  // 계정이 바뀌거나 상태가 바뀔 때 사이드바·경로·메뉴를 맞춘다
  function updateSide() {
    var a = curId ? (accOf(curId) || meAcc(curId)) : null;
    var email = a ? a.email : '';
    $('acctSq').textContent = email ? email.charAt(0).toUpperCase() : 'K';
    $('acctEmail').textContent = email || '카카오 계정 없음';
    $('acctEmail').classList.toggle('mono', !!email);
    var st = curId ? stateOf(curId) : '';
    var dot = st === 'live' ? 'live' : (st === 'needs_register' || st === 'error') ? 'crit' : 'warn';
    var acctState = $('acctState');
    acctState.textContent = '';
    if (curId) {
      acctState.appendChild(el('i', 'dot ' + dot));
      acctState.appendChild(el('span', dot === 'crit' ? 'crit' : '', stateLabel(st)));
    } else acctState.appendChild(el('span', '', '등록된 카카오 계정 없음'));
    var n = meAccounts().length;
    var max = maxAcc();
    var legacy = legacyOn();
    $('navAcctN').textContent = n + '/' + max;
    $('navCapAcct').textContent = email;
    qsa('[data-acct-email]').forEach(function (x) { x.textContent = email; });
    qsa('[data-max-acc]').forEach(function (x) { x.textContent = String(max); });
    // 계정 단위 옛 기능 4개는 유예 회원에게만(6.9 게이트)
    qsa('[data-legacy]').forEach(function (x) { x.hidden = !legacy; });
    qsa('.nav-a[data-r]').forEach(function (x) {
      var r = x.dataset.r;
      if (FEAT_ROUTES.indexOf(r) >= 0) {
        if (!n) x.setAttribute('aria-disabled', 'true');
        else x.removeAttribute('aria-disabled');
      }
    });
    qsa('[data-fs]').forEach(function (d) {
      var on = featOn(d.dataset.fs);
      d.classList.toggle('on', on);
      d.title = on ? '켜짐' : '꺼짐';
      var a2 = d.closest('.nav-a');
      if (a2) a2.setAttribute('aria-description', on ? '켜짐' : '꺼짐');
    });
    var full = n >= max;
    ['acc-add', 'ov-add'].forEach(function (id) {
      var b = $(id);
      if (!b) return;
      if (full) b.setAttribute('aria-disabled', 'true'); else b.removeAttribute('aria-disabled');
    });
    // 매크로를 사기 전에는 '계정 추가'를 눈에 띄게 두지 않는다(구매 안내 카드가 먼저 보이게)
    var ovAdd = $('ov-add');
    if (ovAdd) ovAdd.classList.toggle('primary', macroOk());
    $('acc-cap').style.transform = 'scaleX(' + Math.min(1, n / max) + ')';
    $('acc-cap-n').textContent = n + ' / ' + max;
    $('add-cap').textContent = n + ' / ' + max;
    updateCrumbs();
    renderAcctMenu();
    renderBanners();
    updateNoticeWho();
    updateRoomNav();
  }

  function updateCrumbs() {
    var R = ROUTES[route];
    if (!R) return;
    $('crPage').textContent = route === 'account-add' ? $('add-title').textContent : R.t;
    var cr = $('crAcct');
    var a = curId ? (accOf(curId) || meAcc(curId)) : null;
    if (R.acct) { cr.textContent = a ? a.email : ''; cr.classList.add('mono'); }
    else if (R.room) { var v = curRoom(); cr.textContent = v ? roomName(v) : '내 방'; cr.classList.toggle('mono', false); }
    else if (R.member) { cr.textContent = loginId(); cr.classList.toggle('mono', !hangul(loginId())); }
    else { cr.textContent = '전체 계정'; cr.classList.remove('mono'); }
  }

  function renderBanners() {
    var a = curId ? (accOf(curId) || meAcc(curId)) : null;
    var bad = !!(a && needsReg(curId));
    qsa('[data-banner]').forEach(function (b) {
      if (!bad) { b.hidden = true; b.textContent = ''; return; }
      b.innerHTML = ic('alert') + '<span class="grow"><b class="mono">' + esc(a.email) + '</b> 카카오 로그인이 끊겼습니다. 다시 등록하기 전까지 이 계정의 기능이 동작하지 않습니다.</span>' +
        '<a class="btn sm" href="#account-add" data-reg="' + esc(curId) + '">재등록</a>';
      b.hidden = false;
    });
    // 매크로가 없거나 만료면 매크로 설정 화면 위에 crit 띠(6.9)
    var off = !!me && !macroInfo().active;
    qsa('[data-macro-off]').forEach(function (b) {
      if (!off) { b.hidden = true; b.textContent = ''; return; }
      b.innerHTML = ic('alert') + '<span class="grow">카카오톡 매크로 이용 기간이 아닙니다(구매 전 또는 기간 만료). 발송과 갠톡 받기가 멈춰 있습니다.</span>' +
        '<a class="btn sm primary" href="/buy?p=macro">매크로 구매하기</a>';
      b.hidden = false;
    });
  }

  function updateNoticeWho() {
    var a = curId ? (accOf(curId) || meAcc(curId)) : null;
    var email = a ? a.email : '';
    var rooms = roomChoices();
    function nameOf(key) { for (var i = 0; i < rooms.length; i++) if (rooms[i].key === key) return rooms[i].name || '대화방'; return ''; }
    ['visit', 'profile'].forEach(function (k) {
      var n = qs('[data-notice-who="' + k + '"]');
      if (!n) return;
      var picked = checkedRooms('#' + k + '-open');
      var room = (picked.length && nameOf(picked[0])) || '선택한 방';
      n.textContent = room + ' · ' + email + ' 계정이 보냄';
    });
    var meta = $('reply-preview-meta');
    if (meta) meta.textContent = '자동 응답 · ' + short(email);
  }

  // ── 계정 전환 메뉴 (4.3) ──────────────────────────────────
  function renderAcctMenu() {
    var m = $('acctMenu');
    var html = '<p class="menu-cap">매크로 설정은 카카오 계정마다 따로 저장됩니다</p>';
    meAccounts().forEach(function (r) {
      var on = r.device_id === curId;
      var st = stateOf(r.device_id);
      var bad = st === 'needs_register' || st === 'error';
      html += '<button type="button" class="menu-i" role="menuitemradio" aria-checked="' + on + '" data-switch="' + esc(r.device_id) + '">' +
        '<span class="sq' + (on ? ' inv' : '') + '">' + esc((r.email || '?').charAt(0).toUpperCase()) + '</span>' +
        '<span class="grow mono">' + esc(r.email) + '</span>' +
        (bad ? '<span class="st crit">' + stateLabel(st) + '</span>' : '<i class="dot ' + (st === 'live' ? 'live' : 'warn') + '" aria-label="' + stateLabel(st) + '"></i>') +
        '<span class="chk-c">' + (on ? ic('check', 14) : '') + '</span></button>';
    });
    var n = meAccounts().length;
    html += '<div class="menu-sep" role="separator"></div>' +
      '<a class="menu-i" role="menuitem" href="#account-add" data-add-link' + (n >= maxAcc() ? ' aria-disabled="true"' : '') + '>' + ic('plus', 14) + '<span class="grow">계정 추가</span><span class="st mono">' + n + '/' + maxAcc() + '</span></a>' +
      '<a class="menu-i" role="menuitem" href="#accounts">' + ic('accounts', 14) + '<span class="grow">카카오 계정 관리</span></a>';
    m.innerHTML = html;
  }
  function openMenu(open) {
    var m = $('acctMenu');
    var b = $('acctBtn');
    m.classList.toggle('closed', !open);
    b.setAttribute('aria-expanded', open ? 'true' : 'false');
    if (open) {
      var f = qs('[aria-checked="true"]', m) || qs('.menu-i', m);
      setTimeout(function () { if (f) f.focus(); }, 20);
    }
  }

  // ── 라우터 (4.1·4.14·5.1) ──────────────────────────────────
  var route = '';
  var firstView = true;
  var curPage = null;
  var pendingFocus = null;
  var pendingReauth = null;

  function pageOf(r) { return qs('section.page[data-route="' + r + '"]'); }
  // 6.9 부팅: 계정이 있으면 개요, 계정이 없고 방이 있으면 내 방, 둘 다 없으면 개요
  function defaultRoute() {
    if (meAccounts().length) return 'overview';
    if (rooms.length) return 'rooms';
    return 'overview';
  }
  function parseHash() {
    var h = location.hash.replace(/^#/, '');
    var i = h.indexOf('/');
    return { r: i < 0 ? h : h.slice(0, i), arg: i < 0 ? '' : h.slice(i + 1), raw: h };
  }
  // 라우트 + 인자를 실제로 열 화면으로 바꾼다(게이트). 해시가 바뀌어야 하면 replaceState 로 고친다.
  function resolveRoute(h, arg, quiet) {
    var R = ROUTES[h];
    if (!R) return null;
    if (R.legacy && !legacyOn()) {
      // 계정 단위 옛 기능은 유예 회원만 — 해시로 바로 열어도 내 방으로(6.9)
      if (!quiet) notify(LEGACY_NOTE);
      return { r: 'rooms', arg: '', fix: true };
    }
    if (R.acct && !meAccounts().length) return { r: 'account-add', arg: '', fix: true };
    if (R.room) {
      var id = /^[1-9][0-9]{0,15}$/.test(arg) ? arg : '';
      if (!id) id = lastRoomId();
      if (!id || !roomById(id)) return { r: 'rooms', arg: '', fix: true };
      return { r: h, arg: id, fix: id !== arg };
    }
    return { r: h, arg: '', fix: !!arg };
  }

  function swapPage(next, animate) {
    if (curPage === next) return;
    if (next.getAnimations) next.getAnimations().forEach(function (a) { a.cancel(); });
    next.hidden = false;
    next.inert = false;
    next.removeAttribute('aria-hidden');
    var old = curPage;
    curPage = next;
    qsa('section.page').forEach(function (p) { if (p !== next && p !== old) { p.hidden = true; } });
    if (old) {
      old.inert = true;
      old.setAttribute('aria-hidden', 'true');
      if (animate) {
        // 나가는 화면은 직선으로 흐려진다. --ease 로 빼면 30~60ms 사이에 두 화면이 모두 0.4 아래로 내려가 빈 프레임처럼 보인다(8.3-2).
        var out = old.animate([{ opacity: 1 }, { opacity: 0 }],
          { duration: 160, easing: 'linear', fill: 'forwards' });
        out.onfinish = function () { if (old !== curPage) old.hidden = true; out.cancel(); };
      } else old.hidden = true;
    }
    if (animate) next.animate([{ opacity: 0, transform: 'translateY(8px)' }, { opacity: 1, transform: 'none' }],
      { duration: 240, delay: 40, easing: 'cubic-bezier(.2,.8,.2,1)', fill: 'backwards' });
  }

  function enterCol() {
    if (!curPage || reducedMotion()) return;
    var col = qs('.col', curPage);
    if (col && col.animate) col.animate([{ opacity: 0, transform: 'translateY(8px)' }, { opacity: 1, transform: 'none' }],
      { duration: 240, easing: 'cubic-bezier(.2,.8,.2,1)' });
  }

  function navInd(instant) {
    var R = ROUTES[route];
    var r = R && R.nav ? R.nav : route;
    var a = qs('.nav-a[data-r="' + r + '"]');
    var ind = $('navInd');
    qsa('.nav-a').forEach(function (x) { if (x === a) x.setAttribute('aria-current', 'page'); else x.removeAttribute('aria-current'); });
    if (!a) { ind.style.opacity = '0'; return; }
    if (instant || reducedMotion()) ind.style.transition = 'none';
    ind.style.opacity = '1';
    ind.style.height = a.offsetHeight + 'px';
    ind.style.transform = 'translateY(' + a.offsetTop + 'px)';
    if (instant || reducedMotion()) { void ind.offsetWidth; ind.style.transition = ''; }
  }

  function onHash() {
    if (!me || app.hidden) return;
    var ph = parseHash();
    var h = ph.r;
    var arg = ph.arg;
    if (!ROUTES[h]) {
      if (ph.raw !== '') return;            // 건너뛰기 등 화면이 아닌 해시는 무시한다
      h = route || defaultRoute();
      arg = route ? routeArg : '';
    }
    if (dirtyN > 0 && route && !(h === route && (arg || routeArg) === routeArg)) {
      history.replaceState(null, '', '#' + curHash());
      pendingFocus = null;
      askLeave({ route: h, arg: arg });
      return;
    }
    var res = resolveRoute(h, arg);
    if (!res) return;
    if (res.fix || ph.r !== res.r) history.replaceState(history.state, '', '#' + res.r + (res.arg ? '/' + res.arg : ''));
    if (res.r === route && res.arg === routeArg) return;
    showRoute(res.r, res.arg);
  }

  function showRoute(h, arg) {
    var prev = route;
    var prevArg = routeArg;
    var animate = !firstView && !reducedMotion() && typeof Element.prototype.animate === 'function';
    route = h;
    routeArg = arg || '';
    app.dataset.route = h;
    palClose(true);
    drawer(false);
    openMenu(false);
    // 주요 알림을 보고 있지 않으면 열어 둔 방을 계속 읽을 이유가 없다
    if (h !== 'inbox' && chat.roomTimer) { clearInterval(chat.roomTimer); chat.roomTimer = null; }
    if (h === 'inbox' && prev !== 'inbox' && chat.openId && !chat.roomTimer) {
      loadThread(true);
      chat.roomTimer = setInterval(function () {
        if (document.hidden || !chat.openId) return;
        loadThread(false);
      }, 3000);
    }
    if (ROUTES[h].room) setRoom(Number(routeArg));
    if (h === 'account-add') enterAdd(pendingReauth);
    pendingReauth = null;
    updateCrumbs();
    updateRoomNav();
    navInd(firstView || prev === '');
    if (isFormRoute(h)) saveBtn.setAttribute('form', formOf(h));
    markDirty();
    // 화면별로 지금 값을 그린다(진입 모션은 여기서만)
    if (h === 'overview') renderOverview(true);
    if (h === 'accounts') renderAcctTable(true);
    if (h === 'rooms') renderRoomsPage(true);
    if (h === 'visit') { renderVisit(true); segInd($('visit-type'), true); }
    if (h === 'profile') renderProfileLog(true);
    if (h === 'guard') { renderGuardList(true); renderGuardPreview(true); }
    if (h === 'macro') renderViz();
    if (ROUTES[h].room) renderRoomRoute(true);
    if (!logRoute(h)) stopLogs();
    window.scrollTo(0, 0);
    var page = pageOf(h);
    var sameRoute = prev === h;
    swapPage(page, animate);
    if (sameRoute && prevArg !== routeArg) enterCol();     // 다른 방의 같은 화면: 열만 다시 들어온다(5.1)
    if (logRoute(h)) startLogs();
    if (h === 'inbox') runRing(qs('#inbox [data-poll]'), inboxSt.fails >= 3 ? 20000 : 9000);
    roomRouteChanged();
    if (ROUTES[h].room) segInds(page);
    if (pendingFocus) {
      var pf = pendingFocus;
      pendingFocus = null;
      setTimeout(function () { focusSetting(pf); }, animate ? 260 : 0);
    } else if (h === 'account-add') {
      focusAddField();
    } else if (!firstView) {
      var h1 = qs('h1', page);
      if (h1) h1.focus({ preventScroll: true });
    }
    firstView = false;
  }

  // ── 서랍 (≤960px) ─────────────────────────────────────────
  function drawer(open) {
    var was = app.classList.contains('nav-open');
    app.classList.toggle('nav-open', open);
    $('menuBtn').setAttribute('aria-expanded', open ? 'true' : 'false');
    var main = qs('.mainc');
    if (main) main.inert = !!open;
    if (open && !was) {
      setTimeout(function () {
        var c = qs('.nav-a[aria-current="page"]') || qs('.nav-a');
        if (c) c.focus({ preventScroll: true });
        navInd(true);
      }, 60);
    }
  }

  // ── 저장·변경 추적·떠나기 (4.14) ──────────────────────────
  var baseline = {};
  var dirtyN = 0;
  var leaveTarget = null;

  function numVal(id) {
    var v = String($(id).value || '').replace(/[^0-9]/g, '');
    if (v === '') return null;
    var n = parseInt(v, 10);
    return isNaN(n) ? null : n;
  }
  function imageSig() {
    // 기준값과 같은 모양(배열)으로 센다. 저장된 이미지를 빼기만 해도 'saved:N' 이 사라져 변경 1건이 된다.
    return images.map(function (x) { return x.name + ':' + x.b64.length; }).concat(savedImages ? ['saved:' + savedImages] : []);
  }
  function formState(r) {
    if (r === 'macro') {
      var p = selectedRooms();
      return { enabled: $('macro-on').checked, message: $('macro-message').value, baseMin: numVal('base-min'), randomMin: numVal('random-min'),
        rooms: p.rooms, roomCooldownMin: p.roomCooldownMin, images: imageSig() };
    }
    if (r === 'visit') return { enabled: $('visit-on').checked, rooms: checkedRooms('#visit-open') };
    if (r === 'profile') return { enabled: $('profile-on').checked, rooms: checkedRooms('#profile-open') };
    if (r === 'guard') return { enabled: $('guard-on').checked, rooms: checkedRooms('#guard-open'), secs: numVal('guard-secs'), count: numVal('guard-count') };
    if (r === 'cover') return { enabled: $('cover-on').checked, rooms: checkedRooms('#cover-open'), words: coverWords.slice(), links: $('cover-links').checked };
    if (r === 'reply') return { enabled: $('reply-on').checked, message: $('reply-message').value, cooldown_hours: numVal('reply-hours') };
    if (r === 'snipe') return triggers.map(function (t) { return JSON.parse(JSON.stringify(t)); });
    return null;
  }
  function isPrim(v) { return v === null || v === undefined || typeof v !== 'object'; }
  function diffCount(a, b) {
    if (Array.isArray(a) || Array.isArray(b)) {
      a = Array.isArray(a) ? a : [];
      b = Array.isArray(b) ? b : [];
      var n = 0;
      if (a.every(isPrim) && b.every(isPrim)) {
        a.forEach(function (x) { if (b.indexOf(x) < 0) n += 1; });
        b.forEach(function (x) { if (a.indexOf(x) < 0) n += 1; });
        return n;
      }
      var seen = {};
      a.forEach(function (x, i) {
        var j = -1;
        if (x && x.id) { for (var k = 0; k < b.length; k++) if (b[k] && b[k].id === x.id) { j = k; break; } }
        else if (b[i] && !b[i].id && !seen[i]) j = i;
        if (j < 0) { n += 1; return; }
        seen[j] = true;
        n += diffCount(x, b[j]);
      });
      b.forEach(function (y, k) { if (!seen[k]) n += 1; });
      return n;
    }
    if (!isPrim(a) || !isPrim(b)) {
      a = isPrim(a) ? {} : a;
      b = isPrim(b) ? {} : b;
      var keys = {};
      Object.keys(a).forEach(function (k) { keys[k] = 1; });
      Object.keys(b).forEach(function (k) { keys[k] = 1; });
      var m = 0;
      Object.keys(keys).forEach(function (k) { m += diffCount(a[k], b[k]); });
      return m;
    }
    if ((a === null || a === undefined) && (b === null || b === undefined)) return 0;
    return a === b ? 0 : 1;
  }
  function takeBaseline() {
    FEAT_ROUTES.forEach(function (r) { baseline[r] = JSON.stringify(formState(r)); });
  }
  function markDirty() {
    if (FEAT_ROUTES.indexOf(route) >= 0 && account && baseline[route]) dirtyN = diffCount(formState(route), JSON.parse(baseline[route]));
    else if (isRoomRoute(route) && roomSt.cfg && baseline[route]) dirtyN = diffCount(roomFormState(route), JSON.parse(baseline[route]));
    else dirtyN = 0;
    paintSave();
  }
  function paintSave() {
    var show = dirtyN > 0 && !!me && !app.hidden;
    if (!show) { saveEl.classList.remove('leave'); leaveTarget = null; }
    saveEl.classList.toggle('show', show);
    var leave = saveEl.classList.contains('leave');
    var a = curId ? (accOf(curId) || meAcc(curId)) : null;
    if (show) {
      var where = isRoomRoute(route)
        ? '<span>' + esc(curRoom() ? roomName(curRoom()) : '') + '</span>'
        : '<span class="mono">' + esc(a ? a.email : '') + '</span>';
      $('saveTxt').innerHTML = leave
        ? '<b>저장하지 않은 변경사항이 있습니다.</b> <span class="ctx">이동하기 전에 저장하거나 버려 주세요.</span>'
        : '<b>변경사항 ' + dirtyN + '건</b><span class="ctx"> · ' + where + ' · ' + esc(routeTitle(route)) + '</span>';
    }
    qsa('.nav-a[data-r]').forEach(function (x) { x.classList.toggle('is-dirty', show && x.dataset.r === route); });
    // 개요 즉시 저장 스위치는 그 기능 화면에 저장 안 한 변경이 있으면 막는다
    qsa('input[data-ov]').forEach(function (sw) {
      var r = FEAT_ROUTE[sw.dataset.ov];
      var blocked = show && r === route;
      if (blocked) { sw.disabled = true; sw.title = '저장하지 않은 변경이 있습니다'; }
      else if (!sw.dataset.busy) { sw.disabled = false; sw.removeAttribute('title'); }
    });
  }
  function shakeSave() {
    if (reducedMotion()) return;
    saveEl.classList.remove('shake');
    void saveEl.offsetWidth;
    saveEl.classList.add('shake');
  }
  var leaveBack = null;   // 머무르기·Esc 뒤에 포커스를 돌려줄 곳(떠나기 안내가 뜰 때 있던 자리)
  function askLeave(t) {
    var ae = document.activeElement;
    if (ae && ae !== document.body && !ae.closest('.when-leave')) leaveBack = ae;
    leaveTarget = t;
    saveEl.classList.add('show', 'leave');
    paintSave();
    leaveTarget = t;
    shakeSave();
    setTimeout(function () { $('leaveStay').focus({ preventScroll: true }); }, 60);
  }
  function runLeave(t) {
    if (!t) return;
    if (t.route) { goRoute(t); return; }
    if (t.acct) { switchAccount(t.acct, t.opts); return; }
    if (t.logout) { doLogout(); return; }
    if (t.fn) t.fn();
  }
  function saveBusy(on) {
    [saveBtn, $('leaveSave')].forEach(function (b) { b.classList.toggle('busy', on); b.disabled = on; });
  }
  // 모든 설정 폼의 저장이 여기로 모인다. 성공하면 계정 값을 다시 채우고 기준값을 새로 잡는다.
  async function saveSettings(r, errId, body, after) {
    if (!account) return;
    var pending = leaveTarget && leaveTarget.saving ? leaveTarget : null;
    var sent = JSON.stringify(formState(r));
    var dev = body.device_id;     // 응답이 늦게 와 그 사이 다른 계정으로 바꿨으면 지금 화면에 덮어쓰지 않는다
    saveBusy(true);
    say(errId, '');
    try {
      var res = await api('/panel/api/settings', body);
      if (dev !== curId) {
        var was = (res && res.account) || accOf(dev) || meAcc(dev);
        notify('저장했습니다.', (was && was.email ? was.email + ' · ' : '') + routeTitle(r));
        if (after) after();
        return;
      }
      account = res.account;
      leaveTarget = null;
      saveEl.classList.remove('leave');
      if (JSON.stringify(formState(r)) === sent) fillDetail();
      else {
        // 저장하는 동안 더 고친 칸이 있다(4.14 "응답 뒤 다시 비교"). 그 화면 폼은 다시 채우지 않고,
        // 보낸 값을 새 기준으로 삼아 남은 변경만 저장 바에 센다.
        baseline[r] = sent;
        markDirty();
        updateSide();
        if (route === 'overview') renderOverview(false);
      }
      notify('저장했습니다.', account.email + ' · ' + routeTitle(r));
      if (after) after();
      if (pending) runLeave(pending);
    } catch (e) {
      if (authFail(e)) { showLogin(e); return; }
      if (dev !== curId) {
        var old = accOf(dev) || meAcc(dev);
        notify('설정을 저장하지 못했습니다.', (old && old.email ? old.email + ' · ' : '') + routeTitle(r), { kind: 'crit' });
        return;
      }
      say(errId, e.message);
      if (leaveTarget) leaveTarget.saving = false;
      saveEl.classList.remove('leave');
      paintSave();
      shakeSave();
    } finally {
      saveBusy(false);
    }
  }
  function revertRoute(text) {
    var y = window.scrollY;
    if (isRoomRoute(route)) {
      say(errIdOf(route), '');
      fillRoomForms();
      renderRoomRoute(false);
      window.scrollTo(0, y);
      if (text) notify(text);
      return;
    }
    if (FEAT_ROUTES.indexOf(route) >= 0) {
      say(route + '-error', '');
      if (route === 'macro') say('room-error', '');
    }
    fillDetail();
    window.scrollTo(0, y);
    if (text) notify(text);
  }

  // ── 계정 값 채우기 (V4 fillDetail) ────────────────────────
  function dataUrl(b64) {
    var s = String(b64 || '');
    if (s.indexOf('data:') === 0) return s;
    var mime = 'image/jpeg';
    if (s.indexOf('iVBOR') === 0) mime = 'image/png';
    else if (s.indexOf('UklG') === 0) mime = 'image/webp';
    return 'data:' + mime + ';base64,' + s;
  }

  function renderThumbs(popIdx) {
    var box = $('thumbs');
    box.textContent = '';
    var items = [];
    for (var s = 0; s < savedImages; s++) items.push({ saved: true, name: '저장된 이미지 ' + (s + 1) });
    images.forEach(function (x, i) { items.push({ b64: x.b64, name: x.name, i: i }); });
    items.forEach(function (it, k) {
      var t = el('div', 'img-t');
      if (popIdx == null || it.i !== popIdx) t.style.animation = 'none';
      t.title = it.name;
      var ph = el('span', 'ph');
      if (it.saved) ph.innerHTML = ic('image', 18);
      else {
        var img = document.createElement('img');
        img.alt = '';
        img.src = dataUrl(it.b64);
        ph.appendChild(img);
      }
      t.appendChild(ph);
      t.appendChild(el('span', it.saved || hangul(it.name) ? 'fn sans' : 'fn', it.name));
      var rm = el('button');
      rm.type = 'button';
      rm.dataset.imgDel = it.saved ? 'saved' : String(it.i);
      rm.setAttribute('aria-label', it.name + ' 빼기');
      rm.innerHTML = ic('x', 12);
      t.appendChild(rm);
      box.appendChild(t);
      void k;
    });
    if (items.length < 5) {
      var add = el('label', 'img-add');
      add.setAttribute('for', 'images');
      add.setAttribute('aria-label', '이미지 추가');
      add.setAttribute('tabindex', '0');
      add.setAttribute('role', 'button');
      add.innerHTML = ic('plus');
      box.appendChild(add);
    }
    if (savedImages) box.appendChild(el('p', 'hint w100', '저장된 이미지는 미리 볼 수 없습니다. 이미지를 새로 추가하거나 하나라도 빼면 저장된 이미지는 모두 빠지고, 새로 고른 이미지만 남습니다.'));
  }

  function roomRow(room, selected, cool) {
    var row = el('label', 'room row');
    var box = document.createElement('input');
    box.type = 'checkbox';
    box.checked = selected;
    box.dataset.key = room.key;
    var ck = el('span', 'ck');
    ck.setAttribute('aria-hidden', 'true');
    ck.innerHTML = ic('check', 10);
    var name = el('span', 'nm', room.name || '대화방');
    var mem = el('span', 'mem', room.members ? room.members + '명' : '');
    var wrap = el('span', 'coolw');
    var input = document.createElement('input');
    input.type = 'text';
    input.setAttribute('inputmode', 'numeric');
    input.className = 'cool';
    input.placeholder = '기본';
    input.autocomplete = 'off';
    input.dataset.cool = room.key;
    input.dataset.min = '1';
    input.dataset.max = '1440';
    input.dataset.empty = '1';
    input.setAttribute('aria-label', (room.name || '대화방') + ' 간격(분)');
    if (cool >= 1) input.value = String(cool);
    wrap.appendChild(input);
    wrap.appendChild(el('span', '', '분'));
    row.appendChild(box);
    row.appendChild(ck);
    row.appendChild(name);
    row.appendChild(mem);
    row.appendChild(wrap);
    return row;
  }

  function checkRow(room, selected) {
    var row = el('label', 'room');
    var box = document.createElement('input');
    box.type = 'checkbox';
    box.checked = selected;
    box.dataset.key = room.key;
    var ck = el('span', 'ck');
    ck.setAttribute('aria-hidden', 'true');
    ck.innerHTML = ic('check', 10);
    row.appendChild(box);
    row.appendChild(ck);
    row.appendChild(el('span', 'nm', room.name || '대화방'));
    if (room.members) row.appendChild(el('span', 'mem', room.members + '명'));
    return row;
  }

  function fillChecks(id, rooms, picked, fresh) {
    var box = document.getElementById(id);
    box.textContent = '';
    var n = 0;
    rooms.forEach(function (room) {
      if (!room || room.list_kind === 'open_dm') return;
      var row = checkRow(room, picked.indexOf(room.key) >= 0);
      if (fresh && fresh[room.key]) row.classList.add('pop');
      box.appendChild(row);
      n += 1;
    });
    if (!n) box.appendChild(el('p', 'rooms-none', '불러온 대화방이 없습니다. [대화방 불러오기]를 눌러 주세요.'));
  }

  function checkedRooms(root) {
    var keys = [];
    document.querySelectorAll(root + ' .room').forEach(function (row) {
      var box = row.querySelector('input[type="checkbox"]');
      if (!box || !box.checked || !box.dataset.key) return;
      keys.push(box.dataset.key);
    });
    return keys;
  }

  function fillRooms(id, rooms, picked, cool, fresh) {
    var box = document.getElementById(id);
    box.textContent = '';
    var head = el('div', 'rlist-h');
    head.setAttribute('aria-hidden', 'true');
    head.appendChild(el('span', '', '대화방'));
    head.appendChild(el('span', '', '간격'));
    var n = 0;
    rooms.forEach(function (room) {
      if (!room || room.list_kind === 'open_dm') return;
      if (!n) box.appendChild(head);
      var on = picked.indexOf(room.key) >= 0;
      var row = roomRow(room, on, cool[room.key]);
      if (fresh && fresh[room.key]) row.classList.add('pop');
      box.appendChild(row);
      n += 1;
    });
    if (!n) box.appendChild(el('p', 'rooms-none', '불러온 대화방이 없습니다. [대화방 불러오기]를 눌러 주세요.'));
  }

  function selectedRooms() {
    var keys = [];
    var cool = {};
    document.querySelectorAll('#rooms-open .room').forEach(function (row) {
      var box = row.querySelector('input[type="checkbox"]');
      var num = row.querySelector('input.cool');
      if (!box || !box.checked || !box.dataset.key) return;
      keys.push(box.dataset.key);
      var n = parseInt(num && num.value, 10);
      if (n >= 1 && n <= 1440) cool[box.dataset.key] = n;
    });
    return { rooms: keys, roomCooldownMin: cool };
  }

  function roomChoices() {
    var out = [];
    var rooms = account && account.rooms;
    if (!rooms) return out;
    (rooms.open || []).forEach(function (r) {
      if (r && r.list_kind !== 'open_dm') out.push(r);
    });
    return out;
  }
  function roomName(key) {
    var rs = roomChoices();
    for (var i = 0; i < rs.length; i++) if (rs[i].key === key) return rs[i].name || '대화방';
    return '대화방';
  }

  function roomsCount() {
    var m = selectedRooms().rooms.length;
    var set = function (k, n) { qsa('[data-rooms-count="' + k + '"]').forEach(function (x) { x.textContent = n ? n + '개 방 선택' : '선택한 방 없음'; }); };
    set('macro', m);
    set('visit', checkedRooms('#visit-open').length);
    set('profile', checkedRooms('#profile-open').length);
    set('guard', checkedRooms('#guard-open').length);
    set('cover', checkedRooms('#cover-open').length);
  }

  function syncDeps() {
    ['macro-on', 'visit-on', 'profile-on', 'guard-on', 'cover-on', 'reply-on'].forEach(function (id) {
      var on = $(id).checked;
      qsa('[data-dep="' + id + '"]').forEach(function (d) { d.dataset.open = on ? 'true' : 'false'; });
      qsa('[data-dep-off="' + id + '"]').forEach(function (d) { d.dataset.open = on ? 'false' : 'true'; });
    });
  }

  function fillDetail() {
    if (!account) return;
    var m = account.macro || {};
    $('macro-on').checked = !!m.enabled;
    $('macro-message').value = m.message || '';
    $('base-min').value = String(m.baseMin || 1);
    $('random-min').value = String(m.randomMin || 0);
    images = [];
    savedImages = Math.min(5, (account.images || []).length);
    imagesDirty = false;
    renderThumbs();
    var cool = m.roomCooldownMin || {};
    var picked = m.rooms || [];
    var rooms = account.rooms || { open: [], normal: [] };
    fillRooms('rooms-open', rooms.open || [], picked, cool);
    var visit = account.visit || {};
    $('visit-on').checked = !!visit.enabled;
    fillChecks('visit-open', rooms.open || [], visit.rooms || []);
    var profile = account.profile || {};
    $('profile-on').checked = !!profile.enabled;
    fillChecks('profile-open', rooms.open || [], profile.rooms || []);
    var guard = account.guard || {};
    $('guard-on').checked = !!guard.enabled;
    fillChecks('guard-open', rooms.open || [], guard.rooms || []);
    $('guard-secs').value = String(guard.secs || 30);
    $('guard-count').value = String(guard.count || 5);
    var cover = account.cover || {};
    $('cover-on').checked = !!cover.enabled;
    fillChecks('cover-open', rooms.open || [], cover.rooms || []);
    coverWords = (cover.words || []).slice();
    $('cover-links').checked = cover.links !== false;
    say('cover-word-err', '');
    var a = account.autoreply || {};
    $('reply-on').checked = !!a.enabled;
    $('reply-message').value = a.message || '';
    $('reply-hours').value = String(a.cooldown_hours == null ? 6 : a.cooldown_hours);
    triggers = (account.triggers || []).map(function (t) { return Object.assign({}, t, { rooms: (t.rooms || []).slice() }); });
    openRules = {};
    syncDeps();
    updateMacroCount();
    roomsCount();
    renderViz();
    renderGuardPreview(true);
    renderCoverChips();
    updateReplyPreview();
    renderTriggers();
    takeBaseline();
    markDirty();
    updateSide();
    if (route === 'overview') renderOverview(false);
  }

  // 대화방을 다시 불러오면 지금 고른 값은 그대로 두고 목록만 바꾼다. 새로 생긴 방만 튀어나온다.
  function refillRoomLists(prevKeys) {
    var rooms = (account.rooms && account.rooms.open) || [];
    var fresh = {};
    rooms.forEach(function (r) { if (r && prevKeys.indexOf(r.key) < 0) fresh[r.key] = true; });
    var mac = selectedRooms();
    fillRooms('rooms-open', rooms, mac.rooms, mac.roomCooldownMin, fresh);
    ['visit', 'profile', 'guard', 'cover'].forEach(function (k) {
      fillChecks(k + '-open', rooms, checkedRooms('#' + k + '-open'), fresh);
    });
    renderTriggers();
    roomsCount();
    renderViz();
    markDirty();
    return Object.keys(fresh).length;
  }

  // ── 매크로: 글자 수·예상 발송 (4.7) ────────────────────────
  function updateMacroCount() { $('macro-count').textContent = fmtNum($('macro-message').value.length) + ' / 2,000'; }
  function rnd(seed) { var x = Math.sin(seed * 9301 + 49297) * 233280; return x - Math.floor(x); }
  function sendTimes(base, rand, own, n) {
    var out = [];
    var t = 0;
    var i = 0;
    while (t < 1440 && i < 200) {
      var gap = own >= 1 ? own : base + Math.floor(rnd(n * 97 + i) * (rand + 1));
      t += i === 0 ? Math.floor(rnd(n + 3) * gap) : gap;
      if (t < 1440) out.push(t);
      i += 1;
    }
    return out;
  }
  var vizTimer = null;
  function queueViz() { clearTimeout(vizTimer); vizTimer = setTimeout(renderViz, 120); }
  function renderViz() {
    var box = $('macro-viz');
    if (!box) return;
    var p = selectedRooms();
    var lo = Math.max(1, numVal('base-min') || 1);
    var rand = Math.max(0, numVal('random-min') || 0);
    var hi = lo + rand;
    if (!p.rooms.length) { box.innerHTML = '<p class="mviz-none">보낼 방을 선택하면 방마다 예상 발송이 표시됩니다.</p>'; return; }
    var now = Date.now();
    var html = p.rooms.map(function (k, n) {
      var own = Number(p.roomCooldownMin[k]) || 0;
      var ts = sendTimes(lo, rand, own, n + 1);
      var span = own >= 1 ? own + '분 고정' : lo + (rand ? '~' + hi : '') + '분 간격';
      var per = own >= 1 ? Math.floor(1440 / own) + '회' : '약 ' + Math.floor(1440 / hi) + (hi !== lo ? '~' + Math.floor(1440 / lo) : '') + '회';
      return '<div class="mviz-lane"><div class="mviz-sum"><span class="rn">' + esc(roomName(k)) + '</span><span><b>' + span + '</b></span><span>하루 <b>' + per + '</b></span></div>' +
        '<div class="mviz-strip" aria-hidden="true">' + ts.map(function (t, i) { return '<i style="left:' + (t / 1440 * 100).toFixed(2) + '%;--i:' + i + '"></i>'; }).join('') + '</div></div>';
    }).join('');
    html += '<div class="mviz-axis" aria-hidden="true">' + [0, 6, 12, 18, 24].map(function (h, i) { return '<span>' + (i === 0 ? '<span class="sans">지금</span> ' : '') + fmtHM(now + h * 3600000) + '</span>'; }).join('') + '</div>';
    box.innerHTML = html;
  }

  // ── 올킥 미리 보기 (4.9) ──────────────────────────────────
  var KICKS = [-118, -96, -71, -52, -27, -22, -18, -14, -10, -6, -3];
  var guardSpan = 0;
  function rangeFill(r) {
    var v = Number(r.value);
    r.style.setProperty('--p', ((v - Number(r.min)) / (Number(r.max) - Number(r.min)) * 100) + '%');
  }
  function renderGuardPreview(redraw) {
    var secs = clamp(numVal('guard-secs') || 30, 5, 300);
    var count = clamp(numVal('guard-count') || 5, 3, 30);
    var rs = $('guard-secs-range');
    var rc = $('guard-count-range');
    rs.value = String(secs);
    rc.value = String(count);
    rangeFill(rs);
    rangeFill(rc);
    $('guard-sent').innerHTML = '<b>' + secs + '초</b> 안에 <b>' + count + '명</b> 이상 내보내면 올킥으로 감지합니다.';
    var span = Math.max(60, secs * 2);
    var strip = $('guard-strip');
    var inWin = KICKS.filter(function (k) { return -k <= secs; }).length;
    var hit = inWin >= count;
    if (redraw || span !== guardSpan || !qs('.kt-k', strip)) {
      guardSpan = span;
      qsa('.kt-k', strip).forEach(function (k) { k.remove(); });
      strip.insertAdjacentHTML('beforeend', KICKS.filter(function (k) { return -k <= span; }).map(function (k, i) {
        return '<i class="kt-k" data-s="' + (-k) + '" style="left:' + (100 + k / span * 100).toFixed(2) + '%;--i:' + i + '"></i>';
      }).join(''));
    }
    qsa('.kt-k', strip).forEach(function (k) { k.classList.toggle('in-win', Number(k.dataset.s) <= secs); });
    $('guard-win').style.width = (secs / span * 100) + '%';
    $('guard-ax0').innerHTML = '-' + span + '<span class="sans">초</span>';
    $('guard-ax1').innerHTML = '-' + Math.round(span / 2) + '<span class="sans">초</span>';
    $('guard-kt').classList.toggle('hit', hit);
    $('guard-res').innerHTML = (hit ? '<i class="dot crit"></i>' : '<i class="dot"></i>') + '구간 안에 내보낸 인원 ' + inWin + '명 · ' + (hit ? '올킥으로 감지됩니다' : '기준 미만이라 감지하지 않습니다');
  }

  // ── 금지어 칩 (4.10) ──────────────────────────────────────
  function renderCoverChips(newIdx) {
    var box = $('cover-words');
    var inp = $('cover-word-in');
    qsa('.wchip', box).forEach(function (c) { c.remove(); });
    coverWords.forEach(function (w, i) {
      var c = el('span', 'wchip' + (i === newIdx ? ' new' : ''));
      c.dataset.w = w.toLowerCase();
      c.appendChild(el('span', '', w));
      var b = el('button');
      b.type = 'button';
      b.dataset.wdel = String(i);
      b.setAttribute('aria-label', w + ' 삭제');
      b.innerHTML = ic('x', 12);
      c.appendChild(b);
      box.insertBefore(c, inp);
    });
    $('cover-word-cnt').textContent = coverWords.length + ' / 200';
  }
  // 반환: '' 정상 · 'dupe' 이미 있음 · 'long' 30자 초과 · 'max' 200개 초과 (long·max 는 입력을 남겨 고치게 한다)
  function addWords(raw) {
    var err = '';
    var code = '';
    var added = -1;
    String(raw).split(/[,\n]/).forEach(function (w) {
      w = w.trim();
      if (!w) return;
      if (w.length > 30) { err = '30자를 넘는 단어는 추가되지 않습니다. 단어를 줄여 다시 입력해 주세요.'; code = 'long'; return; }
      var lower = w.toLowerCase();
      if (coverWords.some(function (x) { return x.toLowerCase() === lower; })) {
        err = '이미 추가된 단어입니다.';
        if (!code) code = 'dupe';
        var c = qsa('#cover-words .wchip').filter(function (x) { return x.dataset.w === lower; })[0];
        if (c && !reducedMotion()) { c.classList.remove('dupe'); void c.offsetWidth; c.classList.add('dupe'); }
        return;
      }
      if (coverWords.length >= 200) { err = '금지어는 200개까지 등록할 수 있습니다. 쓰지 않는 단어를 지워 주세요.'; code = 'max'; return; }
      coverWords.push(w);
      added = coverWords.length - 1;
    });
    say('cover-word-err', err);
    if (added >= 0) { renderCoverChips(added); markDirty(); }
    return code;
  }

  // ── 갠톡 응답 미리 보기 (4.11) ────────────────────────────
  function updateReplyPreview() {
    var m = $('reply-message').value || '';
    $('reply-preview').textContent = m ? m.replace(/\{이름\}/g, '민지').replace(/\{시간\}/g, '21:16').replace(/\{날짜\}/g, '10월 9일') : '응답 메시지를 입력해 주세요.';
  }

  // ── 저격 규칙 (4.12) ──────────────────────────────────────
  var MODES = { contains: '포함', exact: '정확히 일치', starts: '시작 부분 일치', regex: '정규식(고급)' };
  function ruleMeta(t) {
    var rn = (t.rooms || []).length ? t.rooms.length + '개 방' : '모든 방';
    var sep = '<span aria-hidden="true">·</span>';
    return '<code' + (!t.pattern || hangul(t.pattern) ? ' class="sans"' : '') + '>' + esc(t.pattern || '감지할 말 없음') + '</code><span>' + (MODES[t.mode] || '포함') + '</span>' + sep + '<span>' + rn + '</span>' + sep +
      '<span class="tnum">쿨타임 ' + fmtNum(t.cooldown_sec == null ? 60 : t.cooldown_sec) + '초</span>' +
      (t.target ? sep + '<span>' + esc(roomName(t.target)) + '에 답장</span>' : '') + (t.once ? sep + '<span>방마다 한 번만</span>' : '');
  }
  function swHtml(attrs, on, label) {
    return '<span class="swl"><input type="checkbox" role="switch" class="swi" ' + attrs + ' aria-label="' + esc(label) + '"' + (on ? ' checked' : '') + '><span class="sw" aria-hidden="true"></span></span>';
  }
  function renderTriggers(newIdx) {
    var box = $('triggers');
    var base = [];
    try { base = JSON.parse(baseline.snipe || '[]'); } catch (e) { base = []; }
    $('snipe-count').textContent = '규칙 ' + triggers.length + ' / 30';
    $('add-trigger').disabled = triggers.length >= 30;
    if (!triggers.length) { box.innerHTML = '<p class="empty">등록된 규칙이 없습니다. [규칙 추가]를 눌러 첫 규칙을 만들어 주세요.</p>'; return; }
    var choices = roomChoices();
    box.innerHTML = triggers.map(function (t, i) {
      var old = t.id ? base.filter(function (b) { return b.id === t.id; })[0] : null;
      var modes = ['contains', 'exact'];
      [old && old.mode, t.mode].forEach(function (md) { if ((md === 'starts' || md === 'regex') && modes.indexOf(md) < 0) modes.push(md); });
      var open = !!openRules[i];
      var chosen = t.rooms || [];
      var picks = choices.length ? '<div class="rooms" role="group" aria-label="감지할 방">' + choices.map(function (r) {
        return '<label class="room"><input type="checkbox" data-rule-room="' + i + '" data-key="' + esc(r.key) + '"' + (chosen.indexOf(r.key) >= 0 ? ' checked' : '') + '><span class="ck" aria-hidden="true">' + ic('check', 10) + '</span><span class="nm">' + esc(r.name || '대화방') + '</span>' + (r.members ? '<span class="mem">' + r.members + '명</span>' : '') + '</label>';
      }).join('') + '</div>' : '<p class="rooms-none">불러온 대화방이 없습니다. [대화방 불러오기]를 눌러 주세요.</p>';
      return '<div class="rule' + (t.enabled === false ? ' off' : '') + (open ? ' open' : '') + (i === newIdx ? ' new' : '') + '" data-ri="' + i + '">' +
        '<div class="rule-h" role="button" tabindex="0" aria-expanded="' + open + '"><div class="t"><b>' + esc(t.name || '이름 없는 규칙') + '</b><div class="meta">' + ruleMeta(t) + '</div></div>' +
        swHtml('data-rule="' + i + '" data-f="enabled"', t.enabled !== false, (t.name || '규칙') + ' 사용') + '<span class="chev">' + ic('down') + '</span></div>' +
        '<div class="rule-b"><div><div class="rule-form">' +
          '<div class="fld"><label for="tn' + i + '">이름</label><input class="inp" id="tn' + i + '" data-rule="' + i + '" data-f="name" value="' + esc(t.name || '') + '" maxlength="40" autocomplete="off"></div>' +
          '<div class="fld"><label for="tm' + i + '">찾는 방식</label><div class="sel"><select id="tm' + i + '" data-rule="' + i + '" data-f="mode">' + modes.map(function (md) { return '<option value="' + md + '"' + (md === (t.mode || 'contains') ? ' selected' : '') + '>' + MODES[md] + '</option>'; }).join('') + '</select>' + ic('down', 14) + '</div>' +
            (t.mode === 'regex' ? '<span class="hint">정규식이 익숙하지 않다면 「포함」을 골라 주세요.</span>' : '') + '</div>' +
          '<div class="fld"><label for="tp' + i + '">감지할 말</label><input class="inp" id="tp' + i + '" data-rule="' + i + '" data-f="pattern" value="' + esc(t.pattern || '') + '" maxlength="200" autocomplete="off"></div>' +
          '<div class="fld"><span class="lb">다시 반응하기까지</span><div class="num"><button type="button" data-step="-1" aria-label="쿨타임 줄이기">−</button><input type="text" inputmode="numeric" autocomplete="off" data-rule="' + i + '" data-f="cooldown_sec" data-min="0" data-max="86400" value="' + (t.cooldown_sec == null ? 60 : t.cooldown_sec) + '" aria-label="쿨타임"><button type="button" data-step="1" aria-label="쿨타임 늘리기">+</button><span class="unit">초</span></div></div>' +
          '<div class="fld full"><label for="tr' + i + '">답장</label><textarea class="ta" id="tr' + i + '" data-rule="' + i + '" data-f="reply" rows="2" maxlength="500">' + esc(t.reply || '') + '</textarea></div>' +
          '<div class="fld full"><span class="lb">감지할 방</span>' + picks + '<div class="rooms-meta"><span>' + (chosen.length ? chosen.length + '개 방 선택' : '선택하지 않으면 저장할 때 참여 중인 모든 오픈채팅방') + '</span></div></div>' +
          '<div class="fld"><label for="tt' + i + '">답할 방</label><div class="sel"><select id="tt' + i + '" data-rule="' + i + '" data-f="target"><option value="">말이 올라온 방</option>' + choices.map(function (r) { return '<option value="' + esc(r.key) + '"' + (t.target === r.key ? ' selected' : '') + '>' + esc(r.name || '대화방') + '</option>'; }).join('') + '</select>' + ic('down', 14) + '</div></div>' +
          '<div class="foot"><span class="once">' + swHtml('data-rule="' + i + '" data-f="once"', !!t.once, '방마다 한 번만 답장') + '방마다 한 번만 답장</span>' +
            '<span class="del-wrap" data-del="' + i + '"><button type="button" class="btn sm ghost danger" data-del-ask="' + i + '">' + ic('trash', 12) + '삭제</button></span></div>' +
        '</div></div></div></div>';
    }).join('');
  }
  function refreshRuleHead(i) {
    var r = qs('.rule[data-ri="' + i + '"]');
    var t = triggers[i];
    if (!r || !t) return;
    qs('.rule-h .t b', r).textContent = t.name || '이름 없는 규칙';
    qs('.rule-h .meta', r).innerHTML = ruleMeta(t);
    r.classList.toggle('off', t.enabled === false);
    var cnt = qs('.fld.full .rooms-meta span', r);
    if (cnt) cnt.textContent = (t.rooms || []).length ? t.rooms.length + '개 방 선택' : '선택하지 않으면 저장할 때 참여 중인 모든 오픈채팅방';
  }

  // ── 계정 열기·전환 ────────────────────────────────────────
  var acctSeq = 0;
  function setCur(id) {
    curId = id || '';
    try { if (curId) localStorage.setItem('kb.acct', curId); } catch (e) { /* 저장소를 못 쓰면 다음 부팅에 첫 계정 */ }
  }
  async function openAccount(id) {
    var seq = ++acctSeq;
    say('room-error', '');
    say('macro-error', '');
    var res = await api('/panel/api/account?device_id=' + encodeURIComponent(id));
    if (seq !== acctSeq) return false;
    var changed = curId !== id;
    setCur(id);
    account = res.account;
    if (changed) resetLogs();
    fillDetail();
    if (changed && LOG_ROUTES[route]) { renderLogViews(true); loadLogs(false); }
    return true;
  }
  function switchAccount(id, opts) {
    opts = opts || {};
    openMenu(false);
    if (id === curId && account) { if (opts.then) opts.then(); return; }
    if (dirtyN > 0) { askLeave({ acct: id, opts: opts }); return; }
    openAccount(id).then(function (done) {
      if (!done) return;
      if (!opts.quiet) notify(account.email + ' 계정으로 전환했습니다.', '설정과 기록이 이 계정 기준으로 표시됩니다.');
      if (!opts.then && ROUTES[route] && ROUTES[route].acct) enterCol();
      if (opts.then) opts.then();
    }).catch(function (e) {
      if (authFail(e)) { showLogin(e); return; }
      notify('계정을 열지 못했습니다.', e.message, { kind: 'crit' });
    });
  }

  async function refreshMe() {
    me = await api('/panel/api/me');
    showApp();
    renderAccounts();
    // 로그인 폼에서 처음 들어오는 길도 여기다 — 아직 콘솔이 뜨지 않았으면 부팅한다.
    if (!inboxSt.booted) { bootConsole(); return; }
    if (curId && !meAcc(curId)) {
      var next = pickAccount();
      account = null;
      setCur('');
      if (next) await openAccount(next).catch(function () { /* 다음 동작에서 다시 연다 */ });
      else updateSide();
    }
    loadInbox(true);
    if (!inboxSt.timer) scheduleInbox();
  }

  function pickAccount() {
    var rows = meAccounts();
    if (!rows.length) return '';
    var saved = '';
    try { saved = localStorage.getItem('kb.acct') || ''; } catch (e) { saved = ''; }
    if (saved && meAcc(saved)) return saved;
    for (var i = 0; i < rows.length; i++) if (!rows[i].needs_register) return rows[i].device_id;
    return rows[0].device_id;
  }

  function renderAccounts() {
    seedAccountsFromMe();
    renderRail();
    updateStrip();
    updateUnread();
    updateSide();
    renderAcctTable(false);
  }

  // ── 계정 표 (4.6) ────────────────────────────────────────
  var acctSig = '';
  function stateHtml(id) {
    var st = stateOf(id);
    var dot = st === 'live' ? 'live' : (st === 'needs_register' || st === 'error') ? 'crit' : 'warn';
    return '<span class="state' + (dot === 'crit' ? ' crit' : '') + '" data-state="' + st + '"><i class="dot ' + dot + '"></i>' + stateLabel(st) + '</span>';
  }
  function renderAcctTable(force) {
    var rows = meAccounts();
    var sig = rows.map(function (r) { return r.device_id + ':' + r.email + ':' + stateOf(r.device_id) + ':' + unreadOf(r.device_id); }).join('|') + '#' + curId;
    if (!force && sig === acctSig) return;
    acctSig = sig;
    var openId = '';
    var op = qs('#account-list tr.confirm-row.open');
    if (op) openId = op.dataset.confirm;
    $('acc-empty').hidden = !!rows.length;
    $('acc-tbl-wrap').hidden = !rows.length;
    list.innerHTML = rows.map(function (r) {
      var u = unreadOf(r.device_id);
      var id = esc(r.device_id);
      var cur = r.device_id === curId;
      return '<tr class="rowx" data-acc-row="' + id + '"><td class="c-name"><div class="who"><span class="sq' + (cur ? ' inv' : '') + '">' + esc((r.email || '?').charAt(0).toUpperCase()) + '</span><div><b class="mono">' + esc(r.email) + '</b><small>' + id + '</small></div></div></td>' +
        '<td data-l="상태">' + stateHtml(r.device_id) + '</td>' +
        '<td data-l="안 읽음">' + (u ? '<b class="badge-n">' + u + '</b>' : '<span class="muted mono">0</span>') + '</td>' +
        '<td class="c-acts"><div class="acts">' + (needsReg(r.device_id) ? '<a class="btn sm primary" href="#account-add" data-reg="' + id + '">재등록</a>' : '') +
        '<button type="button" class="btn sm" data-acct-set="' + id + '">설정</button>' +
        '<button type="button" class="btn sm ghost" data-unlink="' + id + '" aria-label="' + esc(r.email) + ' 등록 해제">' + ic('unlink', 13) + '등록 해제</button></div></td></tr>' +
        '<tr class="confirm-row' + (openId === r.device_id ? ' open' : '') + '" data-confirm="' + id + '"><td colspan="4"><div class="confirm-in"><div><div class="confirm-box" role="group" aria-label="등록 해제 확인">' +
        '<span class="grow"><b class="mono">' + esc(r.email) + '</b> 등록을 해제합니다. 이 계정의 발송과 기록이 모두 멈춥니다.</span>' +
        '<button type="button" class="btn sm" data-unlink-no="' + id + '">취소</button><button type="button" class="btn sm danger solid" data-unlink-yes="' + id + '"><span class="spin"></span><span class="lbl-idle">등록 해제</span></button>' +
        '<p class="errt" data-unlink-err="' + id + '" role="alert"></p></div></div></div></td></tr>';
    }).join('');
  }

  async function unlinkAccount(id, btn) {
    var row = meAcc(id);
    var email = row ? row.email : '';
    btn.classList.add('busy');
    btn.disabled = true;
    try {
      await api('/panel/api/unlink', { device_id: id });
      // 그 계정의 열린 대화·필터·설정을 잊는다
      if (chat.deviceId === id) closeConversation();
      if (ui.filter === id) selectRail('');
      if (curId === id) { account = null; setCur(''); resetLogs(); }
      await refreshMe();
      if (!curId) {
        var next = pickAccount();
        if (next) await openAccount(next);
        else updateSide();
      }
      renderAcctTable(true);
      notify('등록을 해제했습니다.', email);
    } catch (e) {
      if (authFail(e)) { showLogin(e); return; }
      var p = qs('[data-unlink-err="' + CSS.escape(id) + '"]');
      if (p) p.textContent = e.message;
    } finally {
      btn.classList.remove('busy');
      btn.disabled = false;
    }
  }

  function readFile(file) {
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(file);
      var img = new Image();
      img.onload = function () {
        var max = 1600;
        var scale = Math.min(1, max / Math.max(img.width, img.height));
        var w = Math.max(1, Math.round(img.width * scale));
        var h = Math.max(1, Math.round(img.height * scale));
        var canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        canvas.getContext('2d').drawImage(img, 0, 0, w, h);
        URL.revokeObjectURL(url);
        var q = 0.82;
        var data = canvas.toDataURL('image/jpeg', q);
        while (data.length > 2.2 * 1024 * 1024 && q > 0.45) {
          q -= 0.1;
          data = canvas.toDataURL('image/jpeg', q);
        }
        resolve(data.split(',')[1]);
      };
      img.onerror = function () {
        URL.revokeObjectURL(url);
        reject(new Error('이미지를 읽지 못했습니다.'));
      };
      img.src = url;
    });
  }

  // ── 계정 추가 마법사 (4.6) ────────────────────────────────
  var addStep = 1;
  var ringTimer = null;
  var WAIT_HTML = $('code-wait-row').innerHTML;
  var doneEmail = '';
  var doneDevice = '';

  function setStep(n, animate) {
    if (animate === undefined) animate = route === 'account-add';
    var prev = addStep;
    addStep = n;
    qsa('#add-steps .stp').forEach(function (s) {
      var k = Number(s.dataset.s);
      s.classList.toggle('done', k < n);
      s.classList.toggle('cur', k === n);
      if (k === n) s.setAttribute('aria-current', 'step'); else s.removeAttribute('aria-current');
    });
    qsa('#add-ex > div').forEach(function (e) {
      var on = Number(e.dataset.ex) === n;
      e.classList.toggle('on', on);
      e.classList.toggle('dim', !on);
    });
    var next = qs('.wz-pane[data-step="' + n + '"]');
    var old = prev !== n ? qs('.wz-pane[data-step="' + prev + '"]') : null;
    var anim = animate && !reducedMotion() && !!next.animate && !!old;
    qsa('.wz-pane').forEach(function (p) {
      if (p === next) return;
      if (p === old && anim) {
        p.animate([{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'translateX(-16px)' }],
          { duration: 200, easing: 'cubic-bezier(.2,.8,.2,1)', fill: 'forwards' }).onfinish = function () {
          if (addStep !== Number(p.dataset.step)) p.hidden = true;
          p.getAnimations().forEach(function (a) { a.cancel(); });
        };
      } else p.hidden = true;
    });
    if (next.getAnimations) next.getAnimations().forEach(function (a) { a.cancel(); });
    next.hidden = false;
    if (anim) next.animate([{ opacity: 0, transform: 'translateX(16px)' }, { opacity: 1, transform: 'none' }],
      { duration: 300, delay: 60, easing: 'cubic-bezier(.2,.8,.2,1)', fill: 'backwards' });
  }

  function clearAddErrors() {
    ['email-error', 'password-error', 'add-error'].forEach(function (id) { say(id, ''); });
    $('email').classList.remove('err');
    $('password').classList.remove('err');
    $('force-box').hidden = true;
  }

  function enterAdd(reauth) {
    var form = $('add-form');
    if (reauth) {
      if (addStep === 2) { var old = pendingId; hidePassQuiet(); if (old) api('/panel/api/register/cancel', { pending_id: old }).catch(function () { /* 화면은 닫는다 */ }); }
      form.dataset.reauth = '1';
      regDevice = reauth.id;
      $('email').value = reauth.email || '';
      $('email').readOnly = true;
      $('add-title').textContent = '카카오 계정 재등록';
      $('add-desc').innerHTML = '<span class="mono">' + esc(reauth.email || '') + '</span> 계정을 다시 등록합니다. 기존 설정과 기록은 그대로 유지됩니다.';
      $('password').value = '';
      clearAddErrors();
      if (addStep !== 1) setStep(1, false);
    } else {
      if (form.dataset.reauth === '1') {
        form.dataset.reauth = '';
        regDevice = '';
        $('email').value = '';
        $('password').value = '';
        clearAddErrors();
      }
      $('email').readOnly = false;
      resetAddTitle();
      if (addStep === 3) { $('email').value = ''; $('password').value = ''; clearAddErrors(); setStep(1, false); }
    }
    // 매크로가 없으면 카카오 비밀번호를 받기 전에 막는다(6.9). 끊긴 기존 계정의 재등록은 막지 않는다.
    var fresh = form.dataset.reauth !== '1' && addStep === 1;
    var noMacro = fresh && !macroOk();
    var full = fresh && !noMacro && meAccounts().length >= maxAcc();
    $('add-nomacro').hidden = !noMacro;
    $('add-full').hidden = !full;
    $('add-grid').hidden = full || noMacro;
    $('add-steps').hidden = full || noMacro;
  }
  function resetAddTitle() {
    $('add-title').textContent = '카카오 계정 추가';
    $('add-desc').textContent = '카카오 계정을 입력하면 확인 번호가 나옵니다. 이 번호를 휴대폰 카카오톡에 입력하면 등록이 끝납니다.';
  }
  function focusAddField() {
    if (addStep !== 1 || !$('add-full').hidden || !$('add-nomacro').hidden) { var h = $('add-title'); h.focus({ preventScroll: true }); return; }
    if (!wide()) { $('add-title').focus({ preventScroll: true }); return; }
    if ($('add-form').dataset.reauth === '1') $('password').focus();
    else $('email').focus();
  }

  // 주요 알림 `등록`, 계정 표 `재등록`, 개요 `재등록`, 배너 `재등록`이 모두 여기로 온다
  function startReauth(deviceId, email) {
    var info = { id: deviceId, email: email || ((meAcc(deviceId) || {}).email) || '' };
    if (route === 'account-add') { enterAdd(info); focusAddField(); return; }
    if (dirtyN > 0) { askLeave({ fn: function () { pendingReauth = info; location.hash = '#account-add'; } }); return; }
    pendingReauth = info;
    location.hash = '#account-add';
  }

  function stopRing() { if (ringTimer) { clearInterval(ringTimer); ringTimer = null; } }
  function startRing(total) {
    stopRing();
    var left = total;
    var ring = $('code-ring');
    var lbl = $('code-ring-t');
    var cr = $('code-cring');
    ring.style.transition = 'none';
    ring.style.strokeDashoffset = '0';
    void ring.getBoundingClientRect();
    ring.style.transition = '';
    cr.classList.remove('low');
    lbl.textContent = Math.floor(left / 60) + ':' + pad(left % 60);
    ringTimer = setInterval(function () {
      left = Math.max(0, left - 1);
      ring.style.strokeDashoffset = (289.03 * (1 - left / total)).toFixed(2);
      lbl.textContent = Math.floor(left / 60) + ':' + pad(left % 60);
      cr.classList.toggle('low', left <= 30);
      if (left === 0) {
        stopRing();
        confirmGen += 1;
        var row = $('code-wait-row');
        row.innerHTML = '<i class="dot warn"></i><span class="grow">번호가 만료되었습니다. 다시 시도해 주세요.</span><button type="button" class="btn primary" id="code-retry">다시 시도</button>';
        $('code-retry').addEventListener('click', function () { hidePass(); focusAddField(); });
      }
    }, 1000);
  }

  function showPass(view) {
    var hasCode = !!view.passcode;
    var row = $('code-wait-row');
    // 옛 루프가 남긴 '아직 확인되지 않았습니다' 문구나 만료 줄을 기본 기다림 줄로 되돌린다
    row.innerHTML = WAIT_HTML;
    bindCancel();
    passcode.hidden = false;
    if (addStep !== 2) setStep(2);
    $('code-title').textContent = hasCode ? '휴대폰 카카오톡에 아래 번호를 입력해 주세요' : '카카오 응답';
    var code = $('code');
    code.hidden = !hasCode;
    code.textContent = '';
    if (hasCode) {
      String(view.passcode).split('').forEach(function (ch, i) {
        var s = el('span', '', ch);
        s.style.setProperty('--i', i);
        code.appendChild(s);
      });
      code.setAttribute('aria-label', '확인 번호 ' + view.passcode);
      code.dataset.code = String(view.passcode);
    }
    $('code-copy').hidden = !hasCode;
    $('code-email').textContent = $('email').value;
    $('code-left').textContent = view.remaining_seconds
      ? '유효 시간 약 ' + Math.ceil(view.remaining_seconds / 60) + '분'
      : '';
    $('code-wait').hidden = !hasCode;
    $('cancel-code').hidden = false;
    $('code-cring').hidden = !hasCode;
    say('code-error', view.text || '');
    pendingId = view.pending_id || pendingId;
    if (view.device_id) regDevice = view.device_id;
    if (hasCode) startRing(Number(view.remaining_seconds) || 300);
    else stopRing();
  }

  // 등록 시작이 ok 도 confirm_on_phone 도 아니면 1단계에 머물러 서버 문구를 보인다
  function showBeginFail(view) {
    say('add-error', view.text || view.status || '등록하지 못했습니다. 입력한 계정을 확인한 뒤 다시 시도해 주세요.');
    var box = $('force-box');
    box.hidden = !view.can_force;
    if (view.can_force) $('force').focus();
    if (view.device_id) regDevice = view.device_id;
  }

  function hidePass() {
    passcode.hidden = true;
    pendingId = '';
    confirmGen += 1;
    stopRing();
    say('code-error', '');
    $('code').textContent = '';
    if (!$('code-wait')) $('code-wait-row').innerHTML = WAIT_HTML;
    bindCancel();
    setStep(1);
  }

  async function showDone(view) {
    var form = $('add-form');
    var reauth = form.dataset.reauth === '1';
    var email = $('email').value;
    doneDevice = view.device_id || regDevice || '';
    doneEmail = email;
    hidePassQuiet();
    $('password').value = '';
    try { await refreshMe(); } catch (e) { /* 다음 폴링이 다시 읽는다 */ }
    if (doneDevice && meAcc(doneDevice)) {
      doneEmail = meAcc(doneDevice).email || email;
      try { await openAccount(doneDevice); } catch (e) { /* 설정 열기에서 다시 연다 */ }
    }
    $('add-done-title').textContent = reauth ? '재등록 완료' : '등록 완료';
    $('add-done-msg').textContent = reauth ? '다시 연결되었습니다. 기존 설정과 기록은 그대로 남아 있습니다.' : '등록되었습니다. 모든 기능은 꺼진 상태로 시작하니, 필요한 기능을 켜 주세요.';
    $('add-done-email').textContent = doneEmail;
    $('add-done-acct').textContent = doneEmail;
    $('add-done-at').textContent = fmtFull(Date.now());
    $('add-more').hidden = reauth;
    form.dataset.reauth = '';
    $('email').readOnly = false;
    setStep(3);
    $('add-done-title').focus({ preventScroll: true });   // 완료 카드 제목으로 포커스를 옮겨 결과를 바로 읽게 한다
  }
  function hidePassQuiet() {
    passcode.hidden = true;
    pendingId = '';
    confirmGen += 1;
    stopRing();
    say('code-error', '');
  }

  function sleep(ms) {
    return new Promise(function (resolve) { setTimeout(resolve, ms); });
  }

  async function confirmLoop() {
    var gen = ++confirmGen;
    var live = function () { return gen === confirmGen && !!pendingId; };
    while (live()) {
      var view = null;
      try {
        view = await api('/panel/api/register/confirm', { pending_id: pendingId });
      } catch (e) {
        if (!live()) return;
        if (authFail(e)) {
          say('code-error', e.message || '로그인이 필요합니다. 다시 로그인해 주세요.');
          return;
        }
        $('code-wait').textContent = '아직 카카오톡에서 확인되지 않았습니다. 계속 기다립니다.';
        say('code-error', '연결이 잠깐 끊겼습니다. 카카오톡 확인을 계속 기다립니다.');
        await sleep(2000);
        continue;
      }
      if (!live()) return;
      if (view.state === 'ok') {
        await showDone(view);
        return;
      }
      if (view.state === 'waiting') {
        $('code-wait').textContent = '아직 카카오톡에서 확인되지 않았습니다. 계속 기다립니다.';
        say('code-error', '');
        await sleep(2000);
        continue;
      }
      showPass(view);
      $('code-wait').textContent = '';
      return;
    }
  }

  function addBusy(btn, on) { btn.classList.toggle('busy', on); btn.disabled = on; }

  // ── 주요 알림 (docs/UI_V4.md 5장) ────────────────────────────
  // 목록은 /panel/api/inbox 를 9초마다, 열린 대화는 3초마다 읽는다.
  // 답장은 그 대화를 받은 계정이 보낸다 — 전송 device_id 는 열린 행의 data-device 에서만 온다.
  var ui = { filter: '', query: '', unreadOnly: false };                 // '' = 전체
  var inboxSt = { accounts: [], chats: [], byDevice: {}, prevUnread: {}, sig: '', railSig: '',
                  busy: false, again: false, seq: 0, timer: null, fails: 0, stagger: true,
                  senderUp: true, senderReason: '', loaded: false, hiddenAt: 0, booted: false };
  var chat = { deviceId: '', openId: '', openName: '',
               roomBusy: false, roomAgain: false, sending: false,
               roomTimer: null, roomSig: '', renderedIds: {} };
  var chatRooms = $('chat-rooms');
  var chatLog = $('chat-log');
  var chatText = $('chat-text');
  var chatSend = $('chat-send');
  var chatPeer = $('chat-peer');
  var chatNote = $('chat-note');
  var chatHeadAva = $('chat-head-ava');
  var chatHeadSub = $('chat-head-sub');
  var chatForm = $('chat-form');
  var chatTitle = $('chat-title');
  var chatSearch = $('chat-search');
  var chatUnread = $('chat-unread');
  var chatNotice = $('chat-notice');
  var threadState = $('thread-state');
  var threadSettings = $('thread-settings');
  var chatNewpill = $('chat-newpill');
  var chatCount = $('chat-count');
  var chatLive = $('chat-live');
  var chatBack = $('chat-back');
  var STATE_LABEL = { live: '접속 중', linking: '접속 대기', needs_register: '등록 필요', error: '접속 오류', sender_down: '발송 서버 멈춤' };
  var STRIP_DOWN = '발송 서버가 멈춰 있습니다. 서버가 다시 켜지면 등록한 계정으로 자동으로 다시 접속합니다.';

  function keyOf(device, id) { return device + '/' + id; }
  function openKey() { return chat.openId ? keyOf(chat.deviceId, chat.openId) : ''; }
  function accOf(id) {
    for (var i = 0; i < inboxSt.accounts.length; i++) if (inboxSt.accounts[i].device_id === id) return inboxSt.accounts[i];
    return null;
  }
  function stateOf(id) {
    var a = accOf(id);
    if (!inboxSt.senderUp) return 'sender_down';
    if (!a) return 'error';
    if (a.status === 'live' && a.connected === false) return 'linking';
    return a.status;                       // live | needs_register | error | sender_down
  }
  function stateLabel(st) { return STATE_LABEL[st] || ''; }
  function canSend(id) { var st = stateOf(id); return st !== 'needs_register' && st !== 'sender_down'; }

  function initialOf(name) {
    var s = String(name || '').trim();
    return s ? s.slice(0, 1).toUpperCase() : '?';
  }
  function updateComposeState() {
    if (!chatForm || !chatText) return;
    if (chatText.value.trim()) chatForm.classList.add('has-text');
    else chatForm.classList.remove('has-text');
  }
  function clearHead() {
    if (chatHeadAva) { chatHeadAva.textContent = ''; chatHeadAva.hidden = true; }
    if (chatHeadSub) chatHeadSub.textContent = '';
  }
  function setHeadSub(email) {
    if (!chatHeadSub) return;
    chatHeadSub.textContent = '';
    chatHeadSub.appendChild(el('span', 'kkt-acc chip-acct', email));
    chatHeadSub.appendChild(document.createTextNode(' 계정으로 답장'));
  }
  // 이메일 칩: 화면에는 @ 앞만, 화면 낭독기와 textContent 에는 전체 이메일
  function accChip(email) {
    var s = String(email || '');
    var at = s.indexOf('@');
    var chip = el('span', 'kkt-acc chip-acct');
    chip.title = s;
    if (at > 0) {
      chip.appendChild(document.createTextNode(s.slice(0, at + 1)));
      chip.appendChild(el('span', 'sr', s.slice(at + 1)));
    } else chip.textContent = s;
    return chip;
  }

  function fmtDay(ms) {
    var d = new Date(Number(ms) || 0);
    if (!ms || isNaN(d.getTime())) return '';
    return d.getFullYear() + '년 ' + (d.getMonth() + 1) + '월 ' + d.getDate() + '일';
  }
  // 대화 열의 시각: 오늘은 시각, 올해는 월.일, 다른 해는 연.월.일 (모노 글꼴이라 숫자만)
  function fmtListTime(ms) {
    var d = new Date(Number(ms) || 0);
    if (!ms || isNaN(d.getTime())) return '';
    var now = new Date();
    if (sameDay(d.getTime(), now.getTime())) return fmtHM(ms);
    if (d.getFullYear() === now.getFullYear()) return fmtMD(ms);
    return d.getFullYear() + '.' + fmtMD(ms);
  }
  function setComposeEnabled(on) {
    if (chatText) chatText.disabled = !on;
    if (chatSend) chatSend.disabled = !on;
  }
  function autoGrow() {
    if (!chatText) return;
    chatText.style.height = 'auto';
    chatText.style.height = Math.min(140, chatText.scrollHeight) + 'px';
  }
  function updateCount() {
    if (!chatCount || !chatText) return;
    var n = chatText.value.length;
    if (n >= 900) { chatCount.textContent = fmtNum(n) + '/1,000'; chatCount.hidden = false; }
    else { chatCount.textContent = ''; chatCount.hidden = true; }
  }
  function updatePlaceholder() {
    if (!chatText) return;
    var ph = '메시지 입력';
    if (!chat.openId) ph = '선택한 대화 없음';
    else {
      var st = stateOf(chat.deviceId);
      if (st === 'needs_register') ph = '다시 등록 필요';
      else if (st === 'sender_down') ph = '발송 서버 멈춤';
    }
    chatText.placeholder = ph;
  }
  function logEmpty(text) { return el('p', 'kkt-empty', text); }
  function threadEmpty() {
    var box = el('div', 'th-empty');
    var d = el('div');
    d.innerHTML = ic('inbox', 20);
    d.appendChild(el('b', 'th-empty-t', '선택한 대화 없음'));
    d.appendChild(el('span', 'kkt-empty', '대화를 선택하면 내용이 표시됩니다.'));
    if (!isPhone()) {
      var h = el('span', 'hint');
      h.innerHTML = '목록에서 <kbd>↑</kbd> <kbd>↓</kbd>로 이동하고 Enter로 엽니다.';
      d.appendChild(h);
    }
    box.appendChild(d);
    return box;
  }
  function setNote(kind, text) {
    if (!chatNote) return;
    chatNote.textContent = '';
    if (!text) return;
    chatNote.innerHTML = ic('alert', 14);
    chatNote.appendChild(el('span', 'grow', text));
    if (kind === 'reg' && chat.deviceId) {
      var a = el('a', 'btn sm', '재등록');
      a.href = '#account-add';
      a.dataset.reg = chat.deviceId;
      chatNote.appendChild(a);
    }
  }

  // ── 계정 상태 ─────────────────────────────────────────────
  // /me 가 올 때마다 필터 칩을 먼저 그린다. /inbox 첫 응답이 status 를 덮어쓴다.
  function seedAccountsFromMe() {
    var prev = {};
    inboxSt.accounts.forEach(function (a) { prev[a.device_id] = a; });
    var up = !!(me && me.sender_up);
    inboxSt.accounts = meAccounts().map(function (r) {
      var old = prev[r.device_id];
      return {
        device_id: r.device_id, email: r.email || '',
        status: !up ? 'sender_down' : (r.needs_register ? 'needs_register' : (old && old.status === 'error' ? 'error' : 'live')),
        reason: r.reason || '', connected: !!r.connected,
        unread: old ? old.unread : 0, chats: old ? old.chats : 0, error: '',
      };
    });
    inboxSt.senderUp = up;
    inboxSt.senderReason = (me && me.sender_reason) || '';
    Object.keys(inboxSt.byDevice).forEach(function (k) { if (!accOf(k)) delete inboxSt.byDevice[k]; });
  }

  // ── 안 읽음 ───────────────────────────────────────────────
  // 열린 대화는 서버가 0 으로 돌리기 전까지 클라이언트가 제외한다.
  function unreadOf(id) {
    var n = 0;
    inboxSt.chats.forEach(function (c) {
      if (c.device_id === id && keyOf(c.device_id, c.chat_id) !== openKey()) n += c.unread || 0;
    });
    return n;
  }
  function totalUnread() {
    var n = 0;
    inboxSt.accounts.forEach(function (a) { n += unreadOf(a.device_id); });
    return n;
  }
  var lastNavUnread = -1;
  function updateUnread() {
    var total = totalUnread();
    document.title = (total ? '(' + total + ') ' : '') + 'K bot 패널';
    var n = $('chat-unread-n');
    if (n) { n.textContent = total ? String(total) : ''; n.hidden = !total; }
    var nb = $('navUnread');
    nb.textContent = total ? badgeText(total) : '';
    nb.hidden = !total;
    if (lastNavUnread >= 0 && total > lastNavUnread && !reducedMotion()) { nb.classList.remove('bump'); void nb.offsetWidth; nb.classList.add('bump'); }
    lastNavUnread = total;
    var ov = $('ov-unread');
    ov.textContent = total ? badgeText(total) : '';
    ov.hidden = !total;
    renderUnreadMetric();
  }
  function badgeText(n) { return n > 99 ? '99+' : String(n); }

  // ── 계정 필터 칩 (V4 레일) ────────────────────────────────
  function renderRail() {
    if (!railAccounts) return;
    var total = totalUnread();
    var sig = inboxSt.accounts.map(function (a) {
      return a.device_id + '\u0001' + stateOf(a.device_id) + '\u0001' + unreadOf(a.device_id) + '\u0001' + a.email;
    }).join('|') + '#' + ui.filter + '#' + total;
    if (sig === inboxSt.railSig) return;
    inboxSt.railSig = sig;
    var all = $('rail-all');
    if (all) {
      all.setAttribute('aria-pressed', ui.filter ? 'false' : 'true');
      all.setAttribute('aria-label', '모든 계정' + (total ? ' · 안 읽음 ' + total : ''));
      var ab = all.querySelector('.rail-badge');
      if (ab) { ab.textContent = total ? badgeText(total) : ''; ab.hidden = !total; }
    }
    railAccounts.textContent = '';
    inboxSt.accounts.forEach(function (a) {
      var st = stateOf(a.device_id);
      var n = unreadOf(a.device_id);
      var b = el('button', 'fchip rail-acct');
      b.type = 'button';
      b.dataset.device = a.device_id;
      b.dataset.state = st;
      b.setAttribute('aria-pressed', ui.filter === a.device_id ? 'true' : 'false');
      b.setAttribute('aria-label', a.email + ' · ' + stateLabel(st) + (n ? ' · 안 읽음 ' + n : ''));
      var name = el('span', 'mono', short(a.email));
      name.title = a.email;
      b.appendChild(name);
      var badge = el('span', 'n rail-badge', n ? badgeText(n) : '');
      badge.setAttribute('aria-hidden', 'true');
      badge.hidden = !n;
      b.appendChild(badge);
      if (st === 'needs_register' || st === 'error' || st === 'sender_down') {
        var dot = el('span', 'rd rail-dot' + (st === 'needs_register' ? '' : ' warn'));
        dot.setAttribute('aria-hidden', 'true');
        b.appendChild(dot);
      }
      railAccounts.appendChild(b);
    });
  }

  // ── 대화 열 ───────────────────────────────────────────────
  function visibleRows() {
    var q = ui.query.trim().toLowerCase();
    return inboxSt.chats.filter(function (c) {
      if (ui.filter && c.device_id !== ui.filter) return false;
      if (ui.unreadOnly && !((c.unread || 0) > 0 && keyOf(c.device_id, c.chat_id) !== openKey())) return false;
      if (q && String(c.name || '').toLowerCase().indexOf(q) < 0 && String(c.preview || '').toLowerCase().indexOf(q) < 0) return false;
      return true;
    });
  }
  function emptyBox(title, text, action) {
    var box = el('div', 'kkt-empty');
    box.appendChild(el('b', 'kkt-empty-title', title));
    box.appendChild(el('span', 'kkt-empty-text', text));
    if (action) {
      var btn = el('button', 'btn sm', action.label);
      btn.type = 'button';
      btn.addEventListener('click', action.fn);
      box.appendChild(btn);
    }
    return box;
  }
  function goRegister() {
    if (route === 'account-add') { focusAddField(); return; }
    location.hash = '#account-add';
  }
  function renderConvList() {
    if (!chatRooms) return;
    var rows = visibleRows();
    var chip = !ui.filter && inboxSt.accounts.length > 1;
    var sig = rows.map(function (c) {
      return c.device_id + '\u0001' + c.chat_id + '\u0001' + c.unread + '\u0001' + c.last_at + '\u0001' + c.name + '\u0001' + c.preview;
    }).join('|') + '#' + openKey() + '#' + ui.filter + '#' + ui.query + '#' + (ui.unreadOnly ? 1 : 0)
      + '#' + (inboxSt.accounts.length > 1 ? 'chip' : '') + '#' + inboxSt.accounts.length + '#' + (inboxSt.loaded ? 1 : 0);
    $('chat-total').textContent = '대화 ' + rows.length + '개';
    // 바뀐 게 없으면 그대로 둔다. 9초마다 새로 그리면 마우스·포커스가 끊긴다.
    if (sig === inboxSt.sig) return;
    inboxSt.sig = sig;
    var stagger = inboxSt.stagger && !reducedMotion();
    var focusKey = '';
    var ae = document.activeElement;
    if (ae && chatRooms.contains(ae)) {
      var fr = ae.closest ? ae.closest('.kkt-row') : null;
      if (fr) focusKey = fr.dataset.key || '';
    }
    var top = chatRooms.scrollTop;
    chatRooms.textContent = '';
    if (!inboxSt.accounts.length) {
      chatRooms.appendChild(macroOk()
        ? emptyBox('등록된 카카오 계정 없음', '카카오 계정을 등록하면 갠톡이 여기에 모입니다.', { label: '계정 등록', fn: goRegister })
        : emptyBox('카카오톡 매크로 구매 필요', '매크로를 구매하고 카카오 계정을 등록하면 갠톡이 여기에 모입니다.', { label: '카카오톡 매크로 구매하기', fn: function () { location.href = '/buy?p=macro'; } }));
      return;
    }
    if (!inboxSt.loaded && !inboxSt.chats.length) {
      for (var i = 0; i < 4; i++) {
        var sk = el('div', 'kkt-skel');
        sk.setAttribute('aria-hidden', 'true');
        chatRooms.appendChild(sk);
      }
      return;
    }
    inboxSt.stagger = false;
    if (!rows.length) {
      if (ui.query.trim()) chatRooms.appendChild(emptyBox('검색 결과 없음', '검색어에 맞는 대화가 없습니다.'));
      else if (ui.unreadOnly) chatRooms.appendChild(emptyBox('안 읽은 대화 없음', '모든 대화를 읽었습니다.'));
      else if (ui.filter) chatRooms.appendChild(emptyBox('받은 갠톡 없음', needsReg(ui.filter) ? '이 계정은 다시 등록해야 대화를 불러옵니다.' : '이 계정에 받은 갠톡이 없습니다.'));
      else chatRooms.appendChild(emptyBox('받은 갠톡 없음', '오픈프로필로 갠톡(1:1 대화)이 오면 여기에 나타납니다.'));
      return;
    }
    rows.forEach(function (c, i) {
      var name = c.name || '대화상대';
      var key = keyOf(c.device_id, c.chat_id);
      var isOpen = key === openKey();
      var showBadge = (c.unread || 0) > 0 && !isOpen;
      var row = el('button', 'kkt-row' + (showBadge ? ' unread' : '') + (stagger ? ' in' : ''));
      row.type = 'button';
      row.setAttribute('role', 'listitem');
      row.style.setProperty('--i', String(Math.min(i, 14)));
      row.dataset.id = c.chat_id;
      row.dataset.device = c.device_id;
      row.dataset.key = key;
      row.setAttribute('aria-current', isOpen ? 'true' : 'false');
      var ava = el('span', 'av', initialOf(name));
      ava.setAttribute('aria-hidden', 'true');
      var meta = el('span', 'meta');
      var nm = el('span', 'nm kkt-name');
      nm.appendChild(el('b', '', name));
      if (chip) {
        var owner = accOf(c.device_id);
        nm.appendChild(accChip(c.email || (owner ? owner.email : '')));
      }
      meta.appendChild(nm);
      meta.appendChild(el('span', 'pv', c.preview || ''));
      var tm = el('span', 'tm');
      var t = el('time', 'kkt-time', fmtListTime(c.last_at));
      if (c.last_at) { try { t.setAttribute('datetime', new Date(Number(c.last_at)).toISOString()); } catch (e) { /* 시각이 없으면 비워 둔다 */ } }
      tm.appendChild(t);
      // 열어 둔 방은 읽는 중이다. 서버가 0 으로 돌리기 전까지 잠깐 뜨는 배지를 숨긴다.
      if (showBadge) {
        tm.appendChild(el('span', 'sr', '안 읽음 '));
        tm.appendChild(el('b', 'kkt-badge badge-n', badgeText(c.unread)));
      }
      row.appendChild(ava);
      row.appendChild(meta);
      row.appendChild(tm);
      if (Object.prototype.hasOwnProperty.call(inboxSt.prevUnread, key) && inboxSt.prevUnread[key] < (c.unread || 0) && !reducedMotion()) {
        row.classList.add('bump');
        setTimeout(function () { row.classList.remove('bump'); }, 950);
      }
      row.addEventListener('click', function () { openConversation(c.device_id, c.chat_id, name); });
      chatRooms.appendChild(row);
      if (focusKey && key === focusKey) row.focus({ preventScroll: true });
    });
    chatRooms.scrollTop = top;
  }
  function markOpenRow(key) {
    if (!chatRooms) return;
    Array.prototype.forEach.call(chatRooms.querySelectorAll('.kkt-row'), function (r) {
      var open = r.dataset.key === key;
      r.setAttribute('aria-current', open ? 'true' : 'false');
      // 열어 둔 방은 읽는 중이다 — 다음 폴링을 기다리지 않고 배지를 바로 거둔다
      if (open) {
        r.classList.remove('unread');
        Array.prototype.forEach.call(r.querySelectorAll('.kkt-badge, .tm .sr'), function (n) { n.remove(); });
      }
    });
  }

  // ── 알림 띠 ───────────────────────────────────────────────
  function updateNotice() {
    if (!chatNotice) return;
    chatNotice.textContent = '';
    if (!inboxSt.senderUp) { chatNotice.hidden = true; return; }
    var bad = inboxSt.accounts.filter(function (a) {
      var st = stateOf(a.device_id);
      return st === 'needs_register' || st === 'error';
    });
    if (ui.filter) bad = bad.filter(function (a) { return a.device_id === ui.filter; });
    if (!bad.length) { chatNotice.hidden = true; return; }
    bad.sort(function (a, b) {
      var x = stateOf(a.device_id) === 'needs_register' ? 0 : 1;
      var y = stateOf(b.device_id) === 'needs_register' ? 0 : 1;
      return x - y;
    });
    if (!ui.filter) chatNotice.appendChild(el('p', 'kkt-notice-title', '확인이 필요한 계정 ' + bad.length + '개'));
    bad.forEach(function (a) {
      var st = stateOf(a.device_id);
      var row = el('div', 'kkt-notice-row');
      row.dataset.device = a.device_id;
      var dot = el('i', 'dot ' + (st === 'needs_register' ? 'crit' : 'warn'));
      dot.setAttribute('aria-hidden', 'true');
      row.appendChild(dot);
      var txt = el('span', 'kkt-notice-text');
      txt.appendChild(el('span', 'mono', a.email));
      txt.appendChild(document.createTextNode(' · ' + stateLabel(st)));
      row.appendChild(txt);
      if (st === 'needs_register') {
        var b = el('button', 'btn sm', '등록');
        b.type = 'button';
        row.appendChild(b);
      }
      chatNotice.appendChild(row);
    });
    chatNotice.hidden = false;
  }
  // 띠는 발송 서버 상태 하나만 말한다. 계정별 문제는 칩 점·알림·머리 칩·입력창이 맡는다.
  function updateStrip() {
    var sync = $('sync');
    var up = inboxSt.senderUp;
    sync.innerHTML = '<i class="dot ' + (up ? 'live' : 'warn') + '"></i><span class="txt">' + (up ? '발송 서버 정상' : '발송 서버 멈춤') + '</span>';
    if (!runstate) return;
    var text = runstate.querySelector('.strip-text');
    if (up || !inboxSt.accounts.length) {
      runstate.hidden = true;
      runstate.className = 'runstate';
      if (text) text.textContent = '';
      return;
    }
    runstate.className = 'runstate down';
    if (text) text.textContent = inboxSt.senderReason || STRIP_DOWN;
    runstate.hidden = false;
  }
  function setThreadState(st) {
    if (!threadState) return;
    var dot = st === 'live' ? 'live' : (st === 'needs_register' || st === 'error') ? 'crit' : 'warn';
    threadState.dataset.state = st;
    threadState.innerHTML = '<i class="dot ' + dot + '"></i>' + esc(stateLabel(st));
    threadState.hidden = false;
  }
  // 열린 대화의 머리 칩·부제·입력창을 계정 상태에 맞춘다. live 로 돌아오면 다음 thread 읽기 성공에서 다시 켜진다.
  function syncOpenState() {
    if (!chat.openId) return;
    var st = stateOf(chat.deviceId);
    var a = accOf(chat.deviceId);
    setThreadState(st);
    setHeadSub(a ? a.email : '');
    if (!canSend(chat.deviceId)) setComposeEnabled(false);
    updatePlaceholder();
  }

  // ── 폴링 ──────────────────────────────────────────────────
  function scheduleInbox() {
    if (inboxSt.timer) clearTimeout(inboxSt.timer);
    inboxSt.timer = setTimeout(function () {
      inboxSt.timer = null;
      if (me && !document.hidden) loadInbox(false);
      if (me) scheduleInbox();
    }, inboxSt.fails >= 3 ? 20000 : 9000);
    runRing(qs('#inbox [data-poll]'), inboxSt.fails >= 3 ? 20000 : 9000);
  }
  async function loadInbox(force) {
    if (!me) return;
    // 읽는 중에 새로고침을 누르면 무시하지 말고, 끝난 뒤에 한 번 더 읽는다.
    if (inboxSt.busy) { if (force) inboxSt.again = true; return; }
    inboxSt.busy = true;
    var seq = ++inboxSt.seq;
    try {
      var res = await api('/panel/api/inbox');
      if (seq !== inboxSt.seq || !me) return;
      inboxSt.fails = 0;
      if (!inboxSt.loaded) inboxSt.stagger = true;
      inboxSt.loaded = true;
      say('chat-error', '');
      applyInbox(res);
    } catch (e) {
      if (seq !== inboxSt.seq || !me) return;
      inboxSt.fails += 1;
      if (authFail(e)) { showLogin(e); return; }
      say('chat-error', '대화 목록을 불러오지 못했습니다. 잠시 뒤 새로고침을 눌러 주세요.');
    } finally {
      inboxSt.busy = false;
      if (inboxSt.again) { inboxSt.again = false; loadInbox(false); }
    }
  }
  // 계정별 마지막 성공분을 byDevice 에 두고 합친다 — 한 계정이 실패해도 목록이 깜빡이지 않는다.
  function applyInbox(res) {
    inboxSt.senderUp = res.sender_up !== false;
    inboxSt.senderReason = res.sender_reason || '';
    var meConn = {};
    meAccounts().forEach(function (r) { meConn[r.device_id] = !!r.connected; });
    inboxSt.accounts = (res.accounts || []).map(function (a) {
      return {
        device_id: a.device_id, email: a.email || '', status: a.status || 'error', reason: a.reason || '',
        connected: (a.connected === null || a.connected === undefined) ? !!meConn[a.device_id] : !!a.connected,
        unread: Number(a.unread) || 0, chats: Number(a.chats) || 0, error: a.error || '',
      };
    });
    if (inboxSt.senderUp) {
      var next = {};
      var incoming = res.chats || [];
      inboxSt.accounts.forEach(function (a) {
        var id = a.device_id;
        if (a.status === 'live') next[id] = incoming.filter(function (c) { return c && c.device_id === id; });
        else if (a.status === 'needs_register') next[id] = [];
        else next[id] = inboxSt.byDevice[id] || [];
      });
      inboxSt.byDevice = next;
      var all = [];
      Object.keys(next).forEach(function (k) { all = all.concat(next[k]); });
      all.sort(function (a, b) { return (b.last_at - a.last_at) || (b.unread - a.unread); });
      inboxSt.chats = all;
    }
    renderRail();
    renderConvList();
    updateNotice();
    updateStrip();
    updateUnread();
    var pu = {};
    inboxSt.chats.forEach(function (c) { pu[keyOf(c.device_id, c.chat_id)] = c.unread || 0; });
    inboxSt.prevUnread = pu;
    syncOpenState();
    sideStateSig();
  }
  // 계정 상태가 바뀔 때만 사이드바·메뉴·계정 표·개요 계정 목록을 다시 그린다
  var sideSig = '';
  function sideStateSig() {
    var sig = inboxSt.accounts.map(function (a) { return a.device_id + ':' + stateOf(a.device_id) + ':' + unreadOf(a.device_id); }).join('|') + '#' + (inboxSt.senderUp ? 1 : 0);
    if (sig === sideSig) return;
    sideSig = sig;
    updateSide();
    renderAcctTable(false);
    if (route === 'overview') { renderAttn(); renderOvAccounts(); }
  }

  // ── 필터 칩에서 계정 고르기 ───────────────────────────────
  function selectRail(deviceId) {
    ui.filter = deviceId || '';
    inboxSt.stagger = true;
    if (railEl) {
      Array.prototype.forEach.call(railEl.querySelectorAll('.fchip[data-device]'), function (b) {
        b.setAttribute('aria-pressed', (b.dataset.device || '') === ui.filter ? 'true' : 'false');
      });
    }
    var a = accOf(ui.filter);
    if (chatTitle) chatTitle.textContent = ui.filter ? (a ? a.email : ui.filter) : '받은 갠톡';
    // 열린 대화가 새 필터에서 보이지 않을 때만 닫는다. 전체로 바꾸거나 그 계정을 고르면 유지.
    if (chat.openId && ui.filter && chat.deviceId !== ui.filter) closeConversation();
    renderRail();
    renderConvList();
    updateNotice();
  }

  // ── 대화 열기·닫기 ────────────────────────────────────────
  function openConversation(deviceId, chatId, name) {
    chat.deviceId = deviceId;   // 그 대화를 받은 계정 — 전송 device_id 는 여기서만 정해진다
    chat.openId = chatId;
    chat.openName = name;
    chat.roomSig = '';
    chat.renderedIds = {};
    chat.roomAgain = false;
    var a = accOf(deviceId);
    chatPeer.textContent = name;
    if (chatHeadAva) { chatHeadAva.textContent = initialOf(name); chatHeadAva.hidden = false; }
    setHeadSub(a ? a.email : '');
    setThreadState(stateOf(deviceId));
    if (threadSettings) threadSettings.hidden = false;
    // 쓰던 글은 방을 옮길 때 지운다. 남겨 두면 엉뚱한 사람에게 보내게 된다.
    chatText.value = '';
    setNote('', '');
    autoGrow();
    updateComposeState();
    updateCount();
    setComposeEnabled(canSend(deviceId));
    updatePlaceholder();
    inboxEl.dataset.view = 'room';
    inboxEl.dataset.open = '1';
    if (isPhone() && !(history.state && history.state.kview === 'room')) {
      history.pushState({ kview: 'room' }, '', '#inbox');
    }
    markOpenRow(keyOf(deviceId, chatId));
    updateUnread();
    renderRail();                     // 열린 대화를 뺀 안 읽음으로 칩 배지도 바로 맞춘다
    chatLog.textContent = '';
    chatLog.appendChild(logEmpty('불러오는 중'));
    if (chatNewpill) chatNewpill.hidden = true;
    loadThread(true);
    if (chat.roomTimer) clearInterval(chat.roomTimer);
    chat.roomTimer = setInterval(function () {
      if (document.hidden || !chat.openId) return;
      loadThread(false);
    }, 3000);
    if (!isPhone()) chatText.focus();
  }
  function closeConversation() {
    inboxEl.dataset.view = 'list';
    inboxEl.dataset.open = '';
    chat.openId = '';
    chat.deviceId = '';
    chat.openName = '';
    chat.roomSig = '';
    chat.renderedIds = {};
    chat.roomAgain = false;
    if (chat.roomTimer) { clearInterval(chat.roomTimer); chat.roomTimer = null; }
    chatText.value = '';
    autoGrow();
    updateComposeState();
    updateCount();
    setComposeEnabled(false);
    updatePlaceholder();
    chatPeer.textContent = '선택한 대화 없음';
    clearHead();
    if (threadState) { threadState.hidden = true; threadState.dataset.state = ''; threadState.textContent = ''; }
    if (threadSettings) threadSettings.hidden = true;
    setNote('', '');
    if (chatNewpill) chatNewpill.hidden = true;
    markOpenRow('');
    chatLog.textContent = '';
    chatLog.appendChild(threadEmpty());
    updateUnread();
  }
  function backAction() {
    var key = openKey();
    if (history.state && history.state.kview === 'room') history.back();
    else closeConversation();
    setTimeout(function () {
      var r = key && qsa('#chat-rooms .kkt-row').filter(function (x) { return x.dataset.key === key; })[0];
      if (r) r.focus({ preventScroll: true });
    }, 60);
  }
  function stepConversation(dir) {
    var rows = Array.prototype.slice.call(chatRooms.querySelectorAll('.kkt-row'));
    if (!rows.length) return;
    var idx = -1;
    var cur = openKey();
    rows.forEach(function (r, i) { if (r.dataset.key === cur) idx = i; });
    var next = idx < 0 ? (dir > 0 ? 0 : rows.length - 1) : idx + dir;
    if (next < 0 || next >= rows.length) return;
    rows[next].click();
  }

  // ── 로그아웃·해제 뒤 초기화 ───────────────────────────────
  function chatReset() {
    if (inboxSt.timer) { clearTimeout(inboxSt.timer); inboxSt.timer = null; }
    if (chat.roomTimer) { clearInterval(chat.roomTimer); chat.roomTimer = null; }
    inboxSt.seq += 1;                       // 비행 중 응답은 버린다
    inboxSt.accounts = [];
    inboxSt.chats = [];
    inboxSt.byDevice = {};
    inboxSt.prevUnread = {};
    inboxSt.sig = '';
    inboxSt.railSig = '';
    inboxSt.loaded = false;
    inboxSt.fails = 0;
    inboxSt.busy = false;
    inboxSt.again = false;
    inboxSt.booted = false;
    inboxSt.stagger = true;
    ui.filter = '';
    ui.query = '';
    ui.unreadOnly = false;
    sideSig = '';
    acctSig = '';
    if (chatSearch) chatSearch.value = '';
    if (chatUnread) chatUnread.setAttribute('aria-pressed', 'false');
    if (chatTitle) chatTitle.textContent = '받은 갠톡';
    closeConversation();
    if (chatRooms) chatRooms.textContent = '';
    if (railAccounts) railAccounts.textContent = '';
    say('chat-error', '');
    if (chatNotice) { chatNotice.textContent = ''; chatNotice.hidden = true; }
  }
  function bootConsole() {
    inboxSt.booted = true;
    // 대화 창은 미선택 상태로 시작한다(UI_V4 14항).
    closeConversation();
    var id = pickAccount();
    firstView = true;
    if (id) {
      setCur(id);
      updateSide();
      openAccount(id).catch(function (e) {
        if (authFail(e)) showLogin(e);
      });
    } else {
      account = null;
      setCur('');
      updateSide();
    }
    loadInbox(true);
    scheduleInbox();
    scheduleRooms();
    var ph = parseHash();
    var res = ROUTES[ph.r] ? resolveRoute(ph.r, ph.arg) : null;
    if (!res) res = resolveRoute(defaultRoute(), '', true);
    var want = res.r + (res.arg ? '/' + res.arg : '');
    if (ph.raw !== want) history.replaceState(null, '', '#' + want);
    route = '';
    routeArg = '';
    showRoute(res.r, res.arg);
  }

  // ── 대화 창 ───────────────────────────────────────────────
  async function loadThread(initial) {
    if (!chat.openId || !chat.deviceId) return;
    // 이미 읽는 중이면 끝난 뒤에 한 번 더 읽는다. 보낸 직후의 새로고침이 폴링에 묻히지 않게.
    if (chat.roomBusy) {
      if (initial) chat.roomAgain = true;
      return;
    }
    chat.roomBusy = true;
    var wantRoom = chat.openId;
    var wantDevice = chat.deviceId;
    try {
      var res = await api('/panel/api/chat?device_id=' + encodeURIComponent(wantDevice) +
        '&chat_id=' + encodeURIComponent(wantRoom));
      // 기다리는 사이에 방이나 계정이 바뀌었으면 늦게 온 응답은 버린다.
      if (chat.openId !== wantRoom || chat.deviceId !== wantDevice) return;
      renderThread(res.messages || [], initial);
      // 잠깐 끊겼다가 돌아오면 입력창도 되살린다. 안 그러면 방을 다시 열기 전까지 못 쓴다.
      if (!chat.sending) setComposeEnabled(canSend(wantDevice));
      updatePlaceholder();
    } catch (e) {
      if (chat.openId !== wantRoom || chat.deviceId !== wantDevice) return;
      if (e && e.status === 409) {
        setNote('reg', '카카오 로그인이 끊겼습니다. 계정 화면에서 다시 등록해 주세요.');
        setComposeEnabled(false);
      } else if (e && e.status === 503) {
        setNote('', (e.body && e.body.error) || '발송 서버가 멈춰 있습니다.');
      }
      if (initial) {
        chatLog.textContent = '';
        chatLog.appendChild(logEmpty('대화를 불러오지 못했습니다. 잠시 뒤 자동으로 다시 불러옵니다.'));
      }
    } finally {
      chat.roomBusy = false;
      if (chat.roomAgain) {
        chat.roomAgain = false;
        loadThread(true);
      }
    }
  }

  function nearBottomOf(node) {
    return (node.scrollHeight - node.scrollTop - node.clientHeight) < 70;
  }
  // 갠톡은 1:1 이라 로그에 상대 아바타·이름을 그리지 않는다 — 머리에 있다.
  function renderThread(messages, initial) {
    var sig = messages.map(function (m) { return (m.log_id || '') + '.' + (m.text || '').length; }).join('|') + '#' + messages.length;
    if (!initial && sig === chat.roomSig) return;
    var firstOpen = !chat.roomSig;
    var nearBottom = nearBottomOf(chatLog);
    var prevTop = chatLog.scrollTop;
    chat.roomSig = sig;
    var prevIds = chat.renderedIds || {};
    chatLog.textContent = '';
    if (!messages.length) {
      chatLog.appendChild(logEmpty('아직 메시지가 없습니다.'));
      chat.renderedIds = {};
      if (chatNewpill) chatNewpill.hidden = true;
      return;
    }
    var owner = accOf(chat.deviceId);
    var mineTag = owner ? short(owner.email) : '';
    var lastDay = '';
    var fresh = 0;
    messages.forEach(function (m, i) {
      var day = fmtDay(m.at);
      if (day && day !== lastDay) {
        var sep = el('span', 'kkt-day', day);
        sep.setAttribute('role', 'separator');
        chatLog.appendChild(sep);
        lastDay = day;
      }
      var isNew = !initial && m.log_id && !prevIds[m.log_id];
      var line = el('div', 'kkt-line ' + (m.mine ? 'me' : 'them'));
      if (m.log_id) line.dataset.log = String(m.log_id);
      if (isNew) { line.classList.add('enter'); fresh += 1; }
      else if (firstOpen && initial) { line.classList.add('enter'); line.style.setProperty('--i', String(Math.min(i, 8))); }
      var bubble = el('div', 'kkt-bubble');
      if (m.label) bubble.appendChild(el('span', 'kkt-label', m.label));
      if (m.text) bubble.appendChild(document.createTextNode(m.text));
      else if (!m.label) bubble.appendChild(document.createTextNode('(첨부)'));
      line.appendChild(bubble);
      var at = el('time', 'kkt-at');
      at.appendChild(el('span', 'mono', fmtHM(m.at)));
      if (m.mine) at.appendChild(document.createTextNode(' · ' + mineTag + ' · 전송됨'));
      line.appendChild(at);
      chatLog.appendChild(line);
    });

    var nextIds = {};
    messages.forEach(function (m) { if (m.log_id) nextIds[m.log_id] = 1; });
    chat.renderedIds = nextIds;
    if (initial || nearBottom) {
      chatLog.scrollTop = chatLog.scrollHeight;
      if (chatNewpill) chatNewpill.hidden = true;
    } else {
      chatLog.scrollTop = prevTop;
      if (fresh && chatNewpill) chatNewpill.hidden = false;
    }
    if (!initial && fresh && chatLive) chatLive.textContent = '새 메시지 ' + fresh + '건 · ' + chat.openName;
  }

  async function sendChat() {
    if (!chat.openId || chat.sending) return;
    var text = chatText.value;
    if (!text.trim()) return;
    var dev = chat.deviceId;
    var room = chat.openId;
    chat.sending = true;
    chatSend.disabled = true;
    try {
      await api('/panel/api/chat/send', { device_id: chat.deviceId, chat_id: chat.openId, text: text });
      if (chat.deviceId !== dev || chat.openId !== room) return;
      chatText.value = '';
      autoGrow();
      updateComposeState();
      updateCount();
      setNote('', '');
      await loadThread(true);          // 읽는 중이면 roomAgain 으로 한 번 더 → 보낸 글이 바로 보인다
      loadInbox(false);
    } catch (e) {
      if (chat.deviceId !== dev || chat.openId !== room) return;
      if (e && e.status === 409) setNote('reg', '카카오 로그인이 끊겼습니다. 계정 화면에서 다시 등록해 주세요.');
      else if (e && e.status === 503) setNote('', (e.body && e.body.error) || '발송 서버가 멈춰 있습니다.');
      else setNote('', '메시지를 보내지 못했습니다. 잠시 뒤 다시 시도해 주세요.');
    } finally {
      chat.sending = false;
      // 보내는 사이에 방을 닫았을 수 있다. 그때는 입력창을 다시 켜지 않는다.
      setComposeEnabled(!!chat.openId && canSend(chat.deviceId));
      if (chat.openId) chatText.focus();
    }
  }

  // ── 기록 폴링 (4.8) ───────────────────────────────────────
  var logsSt = { deviceId: '', data: null, sig: '', timer: null, busy: false, seq: 0, fails: 0, prev: null, fresh: {} };
  function resetLogs() {
    if (logsSt.timer) { clearTimeout(logsSt.timer); logsSt.timer = null; }
    logsSt.seq += 1;
    logsSt.busy = false;
    logsSt.deviceId = curId;
    logsSt.data = null;
    logsSt.sig = '';
    logsSt.prev = null;
    logsSt.fresh = {};
    logsSt.fails = 0;
    expanded = { visit: {}, profile: {} };
    ['visit-log-error', 'profile-log-error', 'guard-log-error', 'ov-log-error'].forEach(function (id) { say(id, ''); });
  }
  function stopLogs() {
    if (logsSt.timer) { clearTimeout(logsSt.timer); logsSt.timer = null; }
  }
  function startLogs() {
    if (!curId) return;
    if (logsSt.deviceId !== curId) resetLogs();
    stopLogs();
    loadLogs(false);
  }
  function scheduleLogs() {
    stopLogs();
    if (!LOG_ROUTES[route] || !me || app.hidden) return;
    var ms = logsSt.fails >= 3 ? 30000 : 10000;
    logsSt.timer = setTimeout(function () {
      logsSt.timer = null;
      if (!LOG_ROUTES[route]) return;
      if (document.hidden) { scheduleLogs(); return; }
      loadLogs(false);
    }, ms);
  }
  function runRing(ring, ms) {
    var r = ring ? qs('.fg', ring) : null;
    if (!r || reducedMotion()) return;
    r.style.transition = 'none';
    r.style.strokeDashoffset = '31.4';
    void r.getBoundingClientRect();
    r.style.transition = 'stroke-dashoffset ' + ms + 'ms linear';
    r.style.strokeDashoffset = '0';
  }
  function logSig(res) {
    function top(rows, fn) { return rows && rows.length ? fn(rows[0]) : 0; }
    var s = JSON.stringify(res || {});
    return s.length + ':' + top(res.visit, visitLatest) + ':' + top(res.profile, function (r) { return last(r.changes) ? last(r.changes).at : 0; }) + ':' + top(res.guard, function (g) { return g.at; }) + ':' + s.slice(0, 64);
  }
  async function loadLogs(manual) {
    if (!curId || logsSt.busy) return;
    logsSt.busy = true;
    var seq = ++logsSt.seq;
    var dev = curId;
    var page = pageOf(route);
    runRing(page ? qs('[data-poll]', page) : null, logsSt.fails >= 3 ? 30000 : 10000);
    var btn = $('visit-reload');
    if (manual) btn.classList.add('busy');
    try {
      var res = await api('/panel/api/logs?device_id=' + encodeURIComponent(dev));
      if (seq !== logsSt.seq || dev !== curId) return;
      logsSt.fails = 0;
      ['visit-log-error', 'profile-log-error', 'guard-log-error', 'ov-log-error'].forEach(function (id) { say(id, ''); });
      applyLogs({ visit: res.visit || [], profile: res.profile || [], guard: res.guard || [] });
    } catch (e) {
      if (seq !== logsSt.seq || dev !== curId) return;
      logsSt.fails += 1;
      if (authFail(e)) { showLogin(e); return; }
      var msg = e && e.status === 503 ? '발송 서버가 멈춰 있어 기록을 불러오지 못했습니다.'
        : e && e.status === 404 ? '계정을 찾을 수 없습니다.'
        : (e && e.status === 502 ? (e.message || '기록을 가져오지 못했습니다.') : '기록을 가져오지 못했습니다.') + ' 잠시 뒤 새로고침을 눌러 주세요.';
      if (e && e.status === 503) { inboxSt.senderUp = false; inboxSt.senderReason = (e.body && e.body.error) || ''; updateStrip(); }
      ['visit-log-error', 'profile-log-error', 'guard-log-error', 'ov-log-error'].forEach(function (id) { say(id, msg); });
    } finally {
      if (seq === logsSt.seq) {
        logsSt.busy = false;
        scheduleLogs();
      }
      btn.classList.remove('busy');
    }
  }
  function visitKey(r) { return r.chat_id + '/' + (r.user_id || r.name); }
  function visitLatest(r) { return Math.max(last(r.joins) || 0, last(r.leaves) || 0, last(r.changes) ? last(r.changes).at : 0); }
  function profileKey(r) { return r.chat_id + '/' + r.user_id; }
  function profileLatest(r) { return last(r.changes) ? last(r.changes).at : 0; }
  function applyLogs(data) {
    var sig = logSig(data);
    if (sig === logsSt.sig) return;              // 같으면 아무것도 다시 그리지 않는다
    logsSt.sig = sig;
    var prev = logsSt.prev;
    var fresh = {};
    var nextPrev = { visit: {}, profile: {}, guard: {} };
    data.visit.forEach(function (r) {
      var k = visitKey(r);
      var t = visitLatest(r);
      nextPrev.visit[k] = t;
      if (prev && (!(k in prev.visit) || t > prev.visit[k])) fresh['v:' + k] = 1;
    });
    data.profile.forEach(function (r) {
      var k = profileKey(r);
      var t = profileLatest(r);
      nextPrev.profile[k] = t;
      if (prev && (!(k in prev.profile) || t > prev.profile[k])) fresh['p:' + k] = 1;
    });
    data.guard.forEach(function (g) {
      nextPrev.guard[g.at] = 1;
      if (prev && !(g.at in prev.guard)) fresh['g:' + g.at] = 1;
    });
    var first = !logsSt.data;
    logsSt.data = data;
    logsSt.prev = nextPrev;
    logsSt.fresh = fresh;
    renderLogViews(first);
    fillVisitRooms();
  }
  function renderLogViews(enter) {
    if (route === 'overview') renderOverview(enter, true);
    if (route === 'visit') renderVisit(enter);
    if (route === 'profile') renderProfileLog(enter);
    if (route === 'guard') renderGuardList(enter);
  }
  function logsData() { return logsSt.data || { visit: [], profile: [], guard: [] }; }

  // 입장·퇴장 표 ----------------------------------------------------------
  var visitUi = { q: '', room: '', type: '' };
  var profileUi = { q: '' };
  var expanded = { visit: {}, profile: {} };
  function fillVisitRooms() {
    var sel = $('visit-room');
    var seen = {};
    var rooms = [];
    logsData().visit.forEach(function (r) { var name = r.room || ''; if (name && !seen[name]) { seen[name] = 1; rooms.push(name); } });
    var want = rooms.join('\u0001');
    if (sel.dataset.sig === want) return;
    sel.dataset.sig = want;
    var cur = visitUi.room;
    sel.innerHTML = '<option value="">모든 방</option>' + rooms.map(function (n) { return '<option' + (n === cur ? ' selected' : '') + '>' + esc(n) + '</option>'; }).join('');
    if (cur && rooms.indexOf(cur) < 0) { visitUi.room = ''; sel.value = ''; }
  }
  function visitEvents(r) {
    var e = [];
    (r.joins || []).forEach(function (t) { e.push({ at: t, ty: 'join', k: '입장' }); });
    (r.leaves || []).forEach(function (t) { e.push({ at: t, ty: 'leave', k: '퇴장' }); });
    (r.changes || []).forEach(function (c, i) {
      var next = r.changes[i + 1] ? r.changes[i + 1].name : r.name;
      e.push({ at: c.at, ty: 'name', k: '이름 변경', tx: '<span class="old">' + esc(c.name) + '</span><span class="arr">→</span>' + esc(next) });
    });
    return e.sort(function (a, b) { return b.at - a.at; });
  }
  function copyBtn(text) { return '<button type="button" class="cpy" data-copy="' + esc(text) + '" aria-label="오픈프로필 링크 복사">' + ic('copy', 13) + '</button>'; }
  function keepFocus(tbody) {
    var ae = document.activeElement;
    return ae && tbody.contains(ae) && ae.dataset ? ae.dataset.k || '' : '';
  }
  function renderVisit(enter) {
    renderVisitMetrics(enter);
    var tb = qs('#visit-tbl tbody');
    var L = logsData().visit;
    var q = visitUi.q.trim().toLowerCase();
    var rm = visitUi.room;
    var ty = visitUi.type;
    var rows = L.filter(function (r) {
      if (rm && r.room !== rm) return false;
      if (q && ((r.name || '') + ' ' + (r.link || '') + ' ' + (r.changes || []).map(function (c) { return c.name; }).join(' ')).toLowerCase().indexOf(q) < 0) return false;
      var lj = last(r.joins);
      var ll = last(r.leaves);
      if (ty === 'in' && !(lj > ll)) return false;
      if (ty === 'out' && !(ll > lj)) return false;
      if (ty === 'name' && !(r.changes || []).length) return false;
      return true;
    });
    $('visit-cnt').textContent = rows.length + '명' + (rows.length !== L.length ? ' · 전체 ' + L.length + '명' : '');
    var focusK = keepFocus(tb);
    var stagger = enter && !reducedMotion();
    if (!rows.length) {
      tb.innerHTML = '<tr class="none"><td colspan="6"><p class="empty">' + (L.length ? '조건에 맞는 기록이 없습니다. 검색어나 필터를 바꿔 주세요.' : (logsSt.data ? '기록이 없습니다. 위에서 기록을 켜고 방을 선택하면 이곳에 표시됩니다.' : '기록을 불러오고 있습니다.')) + '</p></td></tr>';
      return;
    }
    tb.innerHTML = rows.map(function (r, i) {
      var k = visitKey(r);
      var joins = r.joins || [];
      var leaves = r.leaves || [];
      var changes = r.changes || [];
      var lj = last(joins);
      var ll = last(leaves);
      var open = !!expanded.visit[k];
      var churn = joins.length >= 2 ? '<span class="tag line">들낙 ' + (joins.length - 1) + '회</span>' : '';
      var quick = leaves.some(function (t) { return joins.some(function (j) { return t > j && t - j < 60000; }); }) ? '<span class="tag line">1분 내 퇴장</span>' : '';
      var ch = changes.length ? '<span class="chain"><span class="old">' + esc(last(changes).name) + '</span><span class="arr">→</span>' + esc(r.name) + '</span>' + (changes.length > 1 ? ' <span class="muted">외 ' + (changes.length - 1) + '회</span>' : '') : '<span class="muted">—</span>';
      var ev = visitEvents(r);
      var tl = '<div class="tl"><ol aria-label="' + esc(r.name || '이름 없음') + ' 시간순 기록">' + ev.map(function (e) {
        return '<li class="ty-' + e.ty + '"><span class="mono">' + fmtTL(e.at) + '</span><span class="k">' + e.k + '</span><span>' + (e.tx || esc(r.room || '목록에 없는 방')) + '</span></li>';
      }).join('') + '</ol><div class="side-i"><dl><dt>사용자 ID</dt><dd>' + (r.user_id ? esc(r.user_id) : '<span class="sans">없음</span>') + '</dd><dt>방</dt><dd class="sans">' + esc(r.room || '목록에 없는 방') + '</dd><dt>오픈프로필</dt><dd>' + (r.link ? esc(r.link) : '<span class="sans">찾지 못했습니다</span>') + '</dd></dl></div></div>';
      var isFresh = !enter && logsSt.fresh['v:' + k];
      return '<tr class="rowx' + (stagger ? ' in' : '') + (isFresh ? ' fresh' : '') + '" style="--i:' + Math.min(i, 14) + '" tabindex="0" aria-expanded="' + open + '" data-x="' + i + '" data-k="' + esc(k) + '">' +
        '<td class="c-name"><div class="who-c"><span><span class="nm">' + esc(r.name || '이름 없음') + '</span>' + (churn || quick ? '<span class="badges">' + churn + quick + '</span>' : '') + '</span><span class="rm">' + esc(r.room || '목록에 없는 방') + '</span></div></td>' +
        '<td class="c-j" data-l="최근 입장">' + (lj ? '<span class="t">' + fmtT(lj) + (joins.length > 1 ? '<span class="more">총 ' + joins.length + '회</span>' : '') + '</span>' : '<span class="muted">—</span>') + '</td>' +
        '<td class="c-l" data-l="최근 퇴장">' + (ll ? '<span class="t">' + fmtT(ll) + (leaves.length > 1 ? '<span class="more">총 ' + leaves.length + '회</span>' : '') + '</span>' : '<span class="muted">—</span>') + '</td>' +
        '<td class="c-chain" data-l="이름 변경">' + ch + '</td>' +
        '<td class="c-link" data-l="링크">' + (r.link ? '<span class="lnk"><span>' + esc(linkText(r.link)) + '</span>' + copyBtn(r.link) + '</span>' : '<span class="muted">링크 없음</span>') + '</td>' +
        '<td class="chev-c">' + ic('down', 14) + '</td></tr>' +
        '<tr class="detail' + (open ? ' open' : '') + '"><td colspan="6"><div class="detail-in"><div>' + tl + '</div></div></td></tr>';
    }).join('');
    if (focusK) { var f = qsa('tr.rowx', tb).filter(function (x) { return x.dataset.k === focusK; })[0]; if (f) f.focus({ preventScroll: true }); }
  }
  function renderProfileLog(enter) {
    var tb = qs('#profile-tbl tbody');
    var L = logsData().profile;
    var q = profileUi.q.trim().toLowerCase();
    var rows = L.filter(function (r) { return !q || ((r.name || '') + ' ' + (r.changes || []).map(function (c) { return c.name; }).join(' ')).toLowerCase().indexOf(q) >= 0; });
    $('profile-cnt').textContent = rows.length + '명';
    var focusK = keepFocus(tb);
    var stagger = enter && !reducedMotion();
    if (!rows.length) {
      tb.innerHTML = '<tr class="none"><td colspan="5"><p class="empty">' + (L.length ? '검색어와 일치하는 이름이 없습니다.' : (logsSt.data ? '감지된 변경이 없습니다. 위에서 감지를 켜고 방을 선택하면 이곳에 표시됩니다.' : '기록을 불러오고 있습니다.')) + '</p></td></tr>';
      return;
    }
    tb.innerHTML = rows.map(function (r, i) {
      var k = profileKey(r);
      var changes = r.changes || [];
      var names = changes.map(function (c) { return c.name; }).concat([r.name]);
      var chain = names.map(function (n, j) { return j === names.length - 1 ? '<b class="cur">' + esc(n) + '</b>' : '<span class="old">' + esc(n) + '</span><span class="arr">→</span>'; }).join('');
      var lastC = last(changes);
      var open = !!expanded.profile[k];
      var tl = '<div class="tl"><ol aria-label="' + esc(r.name) + ' 이름 변경 기록">' + changes.map(function (c, j) {
        var next = changes[j + 1] ? changes[j + 1].name : r.name;
        return '<li class="ty-name"><span class="mono">' + fmtTL(c.at) + '</span><span class="k">이름 변경</span><span><span class="old">' + esc(c.name) + '</span><span class="arr">→</span>' + esc(next) + '</span></li>';
      }).reverse().join('') + '</ol><div class="side-i"><dl><dt>사용자 ID</dt><dd>' + (r.user_id ? esc(r.user_id) : '<span class="sans">없음</span>') + '</dd><dt>방</dt><dd class="sans">' + esc(r.room || '목록에 없는 방') + '</dd><dt>마지막 확인</dt><dd>' + (r.at ? fmtFull(r.at) : '—') + '</dd></dl></div></div>';
      var isFresh = !enter && logsSt.fresh['p:' + k];
      return '<tr class="rowx' + (stagger ? ' in' : '') + (isFresh ? ' fresh' : '') + '" style="--i:' + Math.min(i, 14) + '" tabindex="0" aria-expanded="' + open + '" data-x="' + i + '" data-k="' + esc(k) + '">' +
        '<td class="c-name"><div class="who-c"><span class="nm">' + esc(r.name) + '</span><span class="rm">' + esc(r.room || '목록에 없는 방') + '</span></div></td>' +
        '<td class="c-at" data-l="최근 변경"><span class="t">' + (lastC ? fmtT(lastC.at) : '—') + '</span></td>' +
        '<td class="c-chain" data-l="이력"><span class="chain">' + chain + '</span></td>' +
        '<td class="c-cnt"><span class="cnt-pill">' + changes.length + '<span class="sans">회</span></span></td>' +
        '<td class="chev-c">' + ic('down', 14) + '</td></tr>' +
        '<tr class="detail' + (open ? ' open' : '') + '"><td colspan="5"><div class="detail-in"><div>' + tl + '</div></div></td></tr>';
    }).join('');
    if (focusK) { var f = qsa('tr.rowx', tb).filter(function (x) { return x.dataset.k === focusK; })[0]; if (f) f.focus({ preventScroll: true }); }
  }
  function renderGuardList(enter) {
    var box = $('guard-list');
    var L = logsData().guard.slice(0, 20);
    var stagger = enter && !reducedMotion();
    if (!L.length) {
      box.innerHTML = '<li class="none"><p class="empty">' + (logsSt.data ? '감지된 올킥이 없습니다. 감지되면 이곳과 개요에 표시됩니다.' : '기록을 불러오고 있습니다.') + '</p></li>';
      return;
    }
    var now = Date.now();
    box.innerHTML = L.map(function (g, i) {
      var isFresh = !enter && logsSt.fresh['g:' + g.at];
      return '<li class="' + (stagger ? 'in' : '') + (isFresh ? ' fresh' : '') + '" style="--i:' + i + '"><i class="dot crit' + (i === 0 && now - g.at < 86400000 ? ' pulse' : '') + '"></i><time>' + fmtFull(g.at) + '</time><span class="tx">' + esc(g.text) + '</span></li>';
    }).join('');
  }
  function toggleDetail(tr) {
    var open = tr.getAttribute('aria-expanded') !== 'true';
    tr.setAttribute('aria-expanded', open ? 'true' : 'false');
    var d = tr.nextElementSibling;
    if (d && d.classList.contains('detail')) d.classList.toggle('open', open);
    var tbl = tr.closest('table');
    var tid = tbl ? tbl.id : '';
    var map = tid === 'visit-tbl' ? expanded.visit : tid === 'profile-tbl' ? expanded.profile
      : tid === 'r-visit-tbl' ? expandedR.visit : expandedR.profile;
    if (tr.dataset.k) { if (open) map[tr.dataset.k] = 1; else delete map[tr.dataset.k]; }
  }

  // ── 개요 (4.4) ────────────────────────────────────────────
  function startOfDay(ms) { var d = new Date(ms); d.setHours(0, 0, 0, 0); return d.getTime(); }
  function hourly(times, now) {
    var b = [];
    for (var i = 23; i >= 0; i--) {
      var lo = now - (i + 1) * 3600000;
      var hi = now - i * 3600000;
      b.push(times.filter(function (t) { return t > lo && t <= hi; }).length);
    }
    return b;
  }
  function sparkHtml(pts, animate) {
    var h = 26;
    var max = Math.max.apply(null, pts.concat([1]));
    return pts.map(function (p, i) {
      var bh = p ? Math.max(3, Math.round(p / max * h)) : 1;
      var cls = p ? (i === pts.length - 1 ? 'now' : '') : 'z';
      return '<rect class="' + cls + '" x="' + (i * 3) + '" y="' + (h - bh) + '" width="2" height="' + bh + '" rx=".5" style="--i:' + i + (animate ? '' : ';animation:none') + '"/>';
    }).join('');
  }
  function renderUnreadMetric() {
    var m = qs('[data-metric="unread"]');
    if (!m) return;
    qs('.v b', m).textContent = String(totalUnread());
    qs('.d', m).textContent = inboxSt.accounts.filter(function (a) { return stateOf(a.device_id) === 'live'; })
      .map(function (a) { return short(a.email) + ' ' + unreadOf(a.device_id); }).join(' · ');
  }
  function metric(name, times, now, animate) {
    var m = qs('[data-metric="' + name + '"]');
    var t0 = startOfDay(now);
    var y0 = t0 - 86400000;
    var today = times.filter(function (t) { return t >= t0; }).length;
    var yday = times.filter(function (t) { return t >= y0 && t < t0; }).length;
    var d = today - yday;
    qs('.v b', m).textContent = String(today);
    qs('.spark', m).innerHTML = sparkHtml(hourly(times, now), animate);
    qs('.d', m).textContent = '어제 ' + yday + '건 · ' + (d >= 0 ? '+' : '−') + Math.abs(d);
  }
  function guardRoom(text) { var m = String(text || '').match(/「(.*?)」/); return m ? m[1] : ''; }
  function featSummary(key) {
    var a = account || {};
    var L = logsData();
    if (key === 'macro') {
      var m = a.macro || {};
      var base = m.baseMin || 1;
      var rand = m.randomMin || 0;
      var n = (a.images || []).length;
      return esc(base + (rand ? '~' + (base + rand) : '') + '분 간격' + (n ? ' · 이미지 ' + n + '장' : ''));
    }
    if (key === 'visit') {
      var v = L.visit[0];
      if (!v) return '';
      var j = last(v.joins) || 0;
      var l = last(v.leaves) || 0;
      return '<span class="mono">' + fmtT(Math.max(j, l)) + '</span>' + (l > j ? '퇴장' : '입장') + ' · ' + esc(v.name || '이름 없음');
    }
    if (key === 'profile') {
      var p = L.profile[0];
      var ch = p && last(p.changes);
      if (!ch) return '';
      return '<span class="mono">' + fmtT(ch.at) + '</span>' + esc(ch.name) + ' → ' + esc(p.name);
    }
    if (key === 'guard') {
      var g = L.guard[0];
      return g ? '<span class="mono">' + fmtT(g.at) + '</span>올킥 감지 · ' + esc(guardRoom(g.text)) : '';
    }
    if (key === 'cover') { var c = a.cover || {}; return '금지어 ' + (c.words || []).length + '개 · 링크 ' + (c.links !== false ? '가리기' : '허용'); }
    if (key === 'autoreply') { var r = a.autoreply || {}; return '쿨타임 ' + (r.cooldown_hours == null ? 6 : r.cooldown_hours) + '시간'; }
    if (key === 'triggers') {
      var ts = a.triggers || [];
      return ts.length ? '규칙 ' + ts.length + '개 중 ' + ts.filter(function (t) { return t.enabled !== false; }).length + '개 사용' : '';
    }
    return '';
  }
  function renderFeatTable() {
    FEAT_KEYS.forEach(function (key) {
      var row = qs('.feat[data-feat="' + key + '"]');
      var on = featOn(key);
      row.classList.toggle('off', !on);
      var dot = qs('[data-ovdot="' + key + '"]', row);
      dot.classList.toggle('on', on);
      var sw = qs('input[data-ov="' + key + '"]', row);
      if (sw && !sw.dataset.busy) sw.checked = on;
      var fr = qs('[data-rooms="' + key + '"]', row);
      if (key === 'autoreply') fr.textContent = '모든 갠톡';
      else if (key === 'triggers') fr.textContent = ((account && account.triggers) || []).length + '개 규칙';
      else {
        var n = account && account[key] ? (account[key].rooms || []).length : 0;
        fr.innerHTML = n ? n + '개 방' : '<span class="dim">방 없음</span>';
      }
      var s = featSummary(key);
      qs('[data-sum="' + key + '"]', row).innerHTML = s || '<span class="dim">기록 없음</span>';
    });
    var ts = (account && account.triggers) || [];
    $('page-overview').querySelector('[data-sum-n="triggers"]').textContent = ts.filter(function (t) { return t.enabled !== false; }).length + '/' + ts.length;
  }
  var FEAT_KEYS = ['macro', 'visit', 'profile', 'guard', 'cover', 'autoreply', 'triggers'];
  // 확인 필요: 올킥(유예 회원) + 등록 필요 계정 + 방 오류·부방장 대기(6.9). 방 행을 누르면 #room/<id>.
  function attnRooms() { return rooms.filter(function (v) { return v.display === 'error' || v.display === 'waiting'; }); }
  function renderAttn() {
    var items = [];
    var g0 = legacyOn() ? logsData().guard[0] : null;
    if (g0 && Date.now() - g0.at < 86400000) {
      items.push('<div class="srow inline"><div class="srow-l"><span class="lb attn-lb"><i class="dot crit pulse"></i>올킥 감지 <span class="mono at">' + fmtT(g0.at) + '</span></span><p>' + esc(g0.text) + '</p></div>' +
        '<div class="srow-r"><a class="btn sm" href="#guard">올킥 감지</a></div></div>');
    }
    meAccounts().forEach(function (r) {
      if (!needsReg(r.device_id)) return;
      items.push('<div class="srow inline"><div class="srow-l"><span class="lb attn-lb"><i class="dot crit"></i><span class="mono em">' + esc(r.email) + '</span> 등록 필요</span><p>카카오 로그인이 끊겼습니다. 다시 등록하기 전까지 이 계정의 기능이 동작하지 않습니다.</p></div>' +
        '<div class="srow-r"><a class="btn sm" href="#account-add" data-reg="' + esc(r.device_id) + '">재등록</a></div></div>');
    });
    attnRooms().forEach(function (v) {
      var crit = v.display === 'error';
      items.push('<div class="srow inline rowlink" data-room-go="' + v.id + '"><div class="srow-l"><span class="lb attn-lb"><i class="dot ' + (crit ? 'crit' : 'warn') + '"></i>' + esc(roomName(v)) + ' <span class="at">' + esc(v.label) + '</span></span><p>' + esc(v.detail) + '</p></div>' +
        '<div class="srow-r"><a class="btn sm" href="#room/' + v.id + '">방 상태</a></div></div>');
    });
    $('ov-attn').hidden = !items.length;
    $('ov-attn-n').textContent = items.length + '건';
    $('ov-attn-list').innerHTML = items.join('');
  }
  function renderOvAccounts() {
    var rows = meAccounts();
    $('ov-acct-n').textContent = rows.length + ' / ' + maxAcc();
    var keys = FEAT_KEYS.filter(function (k) { return legacyOn() || ['visit', 'profile', 'guard', 'cover'].indexOf(k) < 0; });
    var onN = keys.filter(featOn).length;
    $('ov-accts').innerHTML = rows.length ? rows.map(function (r) {
      var cur = r.device_id === curId;
      var u = unreadOf(r.device_id);
      var st = stateOf(r.device_id);
      var dot = st === 'live' ? 'live' : (st === 'needs_register' || st === 'error') ? 'crit' : 'warn';
      return '<button type="button" class="acc-li' + (cur ? ' cur' : '') + '" data-acct="' + esc(r.device_id) + '">' +
        '<span class="sq' + (cur ? ' inv' : '') + '">' + esc((r.email || '?').charAt(0).toUpperCase()) + '</span>' +
        '<span class="meta"><b class="mono">' + esc(r.email) + '</b><small><i class="dot ' + dot + '"></i><span class="' + (dot === 'crit' ? 'crit' : '') + '">' + stateLabel(st) + '</span>' + (cur ? ' · 기능 ' + onN + '/' + keys.length : '') + '</small></span>' +
        (u ? '<b class="badge-n" aria-label="안 읽음 ' + u + '">' + badgeText(u) + '</b>' : (cur ? '<span class="tag line">선택됨</span>' : '<span></span>')) + '</button>';
    }).join('') : '<p class="empty">등록된 카카오 계정이 없습니다.</p>';
  }
  // 개요의 내 방 묶음: 최근 5개, 누르면 그 방의 상태
  function renderOvRooms() {
    $('ov-rooms-n').textContent = rooms.length ? roomsActiveN() + ' / ' + rooms.length : '';
    $('ov-rooms').innerHTML = rooms.length ? rooms.slice(0, 5).map(function (v) {
      return '<button type="button" class="acc-li" data-room-go="' + v.id + '">' +
        '<span class="sq">' + ic('link', 13) + '</span>' +
        '<span class="meta"><b>' + esc(roomName(v)) + '</b><small>' + esc(productsText(v)) + '</small></span>' +
        stateHtmlRoom(v) + '</button>';
    }).join('') : '<div class="empty">봇을 설치한 방이 없습니다. 방 관리봇·미니게임봇은 구매한 방에만 들어갑니다.<div class="acts-c"><a class="btn primary" href="/buy?p=roombot">방 관리봇 구매하기</a></div></div>';
  }
  // 개요 지표 4칸(6.9): 안 읽은 갠톡 · 매크로 · 사용 중인 방 · 확인 필요
  function renderMacroMetric() {
    var m = qs('[data-metric="macro"]');
    if (!m) return;
    var info = macroInfo();
    var b = qs('.v b', m);
    var until = Number(info.until) || 0;
    m.classList.remove('warn', 'crit');
    if (!until) {
      b.innerHTML = '<span class="sans">미구매</span>';
      qs('.d', m).textContent = '구매하면 입금 확인 시점부터 30일';
    } else if (!info.active || until <= Date.now()) {
      b.innerHTML = '<span class="sans">만료</span>';
      qs('.d', m).textContent = fmtFull(until).slice(0, 10) + ' 만료';
      m.classList.add('crit');
    } else {
      var n = macroDays(info);
      b.textContent = (until - Date.now()) < 86400000 ? 'D-0' : 'D-' + n;
      qs('.d', m).textContent = '만료 ' + fmtFull(until);
      if (n <= 7) m.classList.add('warn');
    }
  }
  function roomsActiveN() { return rooms.filter(function (v) { return v.display === 'active'; }).length; }
  function renderRoomsMetric() {
    var m = qs('[data-metric="rooms"]');
    if (!m) return;
    qs('.v b', m).innerHTML = roomsActiveN() + '<span class="of">/ ' + rooms.length + '</span>';
    var c = { joining: 0, waiting: 0, pending: 0, error: 0 };
    rooms.forEach(function (v) { if (c[v.display] !== undefined) c[v.display] += 1; });
    var parts = [];
    if (c.waiting) parts.push('부방장 지정 대기 ' + c.waiting);
    if (c.joining) parts.push('입장 중 ' + c.joining);
    if (c.pending) parts.push('입금 대기 ' + c.pending);
    if (c.error) parts.push('오류 ' + c.error);
    qs('.d', m).textContent = rooms.length ? (parts.join(' · ') || '모두 사용 중') : '설치한 방 없음';
  }
  function renderAttnMetric() {
    var m = qs('[data-metric="attn"]');
    if (!m) return;
    var reg = meAccounts().filter(function (r) { return needsReg(r.device_id); }).length;
    var err = rooms.filter(function (v) { return v.display === 'error'; }).length;
    var wait = rooms.filter(function (v) { return v.display === 'waiting'; }).length;
    var n = reg + err + wait;
    qs('.v b', m).textContent = String(n);
    m.classList.toggle('crit', reg + err > 0);
    var parts = [];
    if (reg) parts.push('등록 필요 ' + reg);
    if (err) parts.push('방 오류 ' + err);
    if (wait) parts.push('부방장 지정 대기 ' + wait);
    qs('.d', m).textContent = parts.join(' · ') || '없음';
  }
  function renderFeed(enter) {
    var L = logsData();
    var f = [];
    L.guard.forEach(function (g) { f.push({ at: g.at, ty: '올킥', crit: 1, tx: '여러 명 내보내기 감지', rm: guardRoom(g.text), fresh: logsSt.fresh['g:' + g.at] }); });
    L.profile.forEach(function (p) { var ch = last(p.changes); if (ch) f.push({ at: ch.at, ty: '프로필', tx: ch.name + ' → ' + p.name, rm: p.room, fresh: logsSt.fresh['p:' + profileKey(p)] }); });
    L.visit.forEach(function (v) {
      var fr = logsSt.fresh['v:' + visitKey(v)];
      (v.joins || []).forEach(function (t) { f.push({ at: t, ty: '입장', tx: v.name || '이름 없음', rm: v.room, fresh: fr && t === visitLatest(v) }); });
      (v.leaves || []).forEach(function (t) { f.push({ at: t, ty: '퇴장', tx: v.name || '이름 없음', rm: v.room, fresh: fr && t === visitLatest(v) }); });
    });
    f.sort(function (x, y) { return y.at - x.at; });
    f = f.slice(0, 8);
    var stagger = enter && !reducedMotion();
    $('ovFeed').innerHTML = f.length ? f.map(function (e, i) {
      return '<li class="' + (stagger ? 'in' : '') + (e.crit ? ' crit' : '') + (!enter && e.fresh ? ' fresh' : '') + '" style="--i:' + i + '"><time>' + fmtHM(e.at) + '</time><span class="ty">' + e.ty + '</span><span class="tx">' + esc(e.tx) + '<small>' + esc(e.rm || '') + '</small></span></li>';
    }).join('') : '<li class="none"><p class="empty">' + (logsSt.data ? '기록이 없습니다. 입장·퇴장 기록이나 프로필 기록을 켜면 이곳에 표시됩니다.' : '기록을 불러오고 있습니다.') + '</p></li>';
  }
  function renderOverview(enter, fromLogs) {
    var hasAcc = meAccounts().length > 0;
    var empty = !hasAcc && !rooms.length;
    // 계정도 방도 없으면 개요 본문 대신 빈 상태(6.9). 매크로를 샀는데 계정이 없으면 등록을 먼저 권한다.
    $('ov-empty').hidden = !empty;
    $('ov-metrics').hidden = empty;
    $('ov-grid').hidden = empty;
    if (empty) {
      // 아무것도 사지 않았으면 '구매 필요'를 크게 — 사야 설정할 수 있다는 걸 먼저 보인다
      var buy = macroOk();
      $('ov-empty-tag').textContent = buy ? '다음 단계' : '구매 필요';
      $('ov-empty-h').textContent = buy ? '카카오 계정을 등록해 주세요' : '아직 구매한 상품이 없습니다';
      $('ov-empty-t').textContent = buy
        ? '매크로를 쓰려면 먼저 카카오 계정을 등록해야 합니다. 방 관리봇·미니게임봇은 따로 구매합니다.'
        : '카카오톡 매크로와 방 관리봇은 구매해야 설정할 수 있습니다. 필요한 상품을 골라 구매해 주세요.';
      $('ov-empty-acts').innerHTML = (buy
        ? '<a class="btn primary" href="#account-add">' + ic('plus', 16) + '카카오 계정 등록</a>'
        : '<a class="btn primary" href="/buy?p=macro">카카오톡 매크로 구매하기</a>') +
        '<a class="btn" href="/buy?p=roombot">방 관리봇 구매하기</a>' +
        (buy ? '' : '<a class="btn" href="/buy?p=minigame">미니게임봇 구매하기</a>');
    }
    $('ov-feat-grp').hidden = !hasAcc;
    renderUnreadMetric();
    renderMacroMetric();
    renderRoomsMetric();
    renderAttnMetric();
    renderAttn();
    if (hasAcc) renderFeatTable();
    renderOvRooms();
    renderOvAccounts();
    if (legacyOn()) renderFeed(enter);
    void fromLogs;
  }
  // 옛 기능 유예 회원의 입장·퇴장 로그 화면에만 남는 오늘 입장·퇴장·이름 변경 지표
  function renderVisitMetrics(enter) {
    if (!legacyOn()) return;
    var now = Date.now();
    var L = logsData();
    var joins = [];
    var leaves = [];
    var names = [];
    L.visit.forEach(function (v) { joins = joins.concat(v.joins || []); leaves = leaves.concat(v.leaves || []); });
    L.profile.forEach(function (p) { (p.changes || []).forEach(function (c) { names.push(c.at); }); });
    var anim = enter && !reducedMotion();
    metric('join', joins, now, anim);
    metric('leave', leaves, now, anim);
    metric('name', names, now, anim);
  }

  // 개요 즉시 저장 스위치: 기능 객체 전체를 그대로 보내고 enabled 만 바꾼다
  function featBody(key, enabled) {
    var a = account || {};
    var body = { device_id: a.device_id, images_unchanged: true };
    var m = a.macro || {};
    if (key === 'macro') body.macro = { enabled: enabled, message: m.message || '', baseMin: m.baseMin || 1, randomMin: m.randomMin || 0, rooms: (m.rooms || []).slice(), roomCooldownMin: Object.assign({}, m.roomCooldownMin || {}) };
    if (key === 'visit') body.visit = { enabled: enabled, rooms: ((a.visit || {}).rooms || []).slice() };
    if (key === 'profile') body.profile = { enabled: enabled, rooms: ((a.profile || {}).rooms || []).slice() };
    if (key === 'guard') { var g = a.guard || {}; body.guard = { enabled: enabled, rooms: (g.rooms || []).slice(), secs: g.secs || 30, count: g.count || 5 }; }
    if (key === 'cover') { var c = a.cover || {}; body.cover = { enabled: enabled, rooms: (c.rooms || []).slice(), words: (c.words || []).slice(), links: c.links !== false }; }
    if (key === 'autoreply') { var r = a.autoreply || {}; body.autoreply = { enabled: enabled, message: r.message || '', cooldown_hours: r.cooldown_hours == null ? 6 : r.cooldown_hours }; }
    return body;
  }
  async function ovToggle(key, enabled, sw, isUndo) {
    if (!account) return;
    var email = account.email;
    var dev = account.device_id;
    var title = routeTitle(FEAT_ROUTE[key]);
    if (sw) { sw.disabled = true; sw.dataset.busy = '1'; }
    try {
      var res = await api('/panel/api/settings', featBody(key, enabled));
      if (curId === dev) { account = res.account; fillDetail(); }
      if (route === 'overview') renderFeatTable();
      if (isUndo) notify('되돌렸습니다.', title + ' · ' + email);
      else notify(title + (enabled ? ' 사용을 시작했습니다.' : ' 사용을 중지했습니다.'), email + ' · 저장됨', {
        action: { label: '되돌리기', fn: function () { if (curId === dev) ovToggle(key, !enabled, qs('input[data-ov="' + key + '"]'), true); } },
      });
    } catch (e) {
      if (authFail(e)) { showLogin(e); return; }
      if (sw) sw.checked = !enabled;
      notify('저장하지 못했습니다.', e.message, { kind: 'crit' });
    } finally {
      if (sw) { delete sw.dataset.busy; sw.disabled = false; }
      paintSave();
    }
  }

  // ═════════════════════════ 내 방 (docs/ACCOUNTS_V1.md 6.9 · 7.4) ═════════════════════════
  // 방 목록은 /panel/api/bot-rooms(내 방·개요 10초, 그 밖 30초), 고른 방은 /panel/api/bot-room?id= 와
  // /panel/api/bot-room/logs?id= (방 화면이 보일 때 10초). 방 설정 저장은 기존 저장 바로 POST /panel/api/bot-room/settings.
  var PRODUCT_LABEL = { roombot: '방 관리봇', minigame: '미니게임봇' };
  var LOG_KIND = { churn: '들낙 감지', kick: '내보내기', kick_fail: '내보내기 실패', unkick: '내보내기 해제', promo: '홍보 금지', hide: '글 가리기',
    cover: '글 가리기 (금지어)', perm: '권한 변경', wave: '올킥 감지', state: '방 상태 변경', skip: '처리 건너뜀' };
  var PROFILE_KIND = { name: '닉네임', link: '옾링', status: '상태 메시지' };   // 이 밖의 항목(예전 기록)은 표에 싣지 않는다
  var NOT_ACTIVE = '부방장 지정을 기다리는 중입니다. 방장이 K bot을 부방장으로 지정하면 설정할 수 있습니다.';
  var roomsSt = { timer: null, busy: false, seq: 0, fails: 0, sig: '' };
  var roomSt = blankRoom(0);
  var exemptList = [];            // 제외 대상(폼 값)
  var rcWords = [];               // 방 금지어(폼 값)
  var expandedR = { visit: {}, profile: {} };
  var rUi = { vq: '', pq: '' };
  var navRoomShown = null;

  function blankRoom(id) {
    return { id: id, cfg: null, cfgRev: 0, formRev: 0, ranking: null, live: null, senderUp: true, busy: false, seq: 0, fails: 0, timer: null,
      logs: null, logsSig: '', prevLogs: null, logsBusy: false, logSeq: 0, people: null, peopleAt: 0, peopleBusy: false, hide: null, loadErr: '' };
  }
  function roomById(id) {
    var n = Number(id);
    for (var i = 0; i < rooms.length; i++) if (rooms[i].id === n) return rooms[i];
    return null;
  }
  function curRoom() { return roomSt.id ? roomById(roomSt.id) : null; }
  function lastRoomId() {
    var v = '';
    try { v = localStorage.getItem('kb.room') || ''; } catch (e) { v = ''; }
    return v && roomById(v) ? v : '';
  }
  function roomName(v) { return (v && v.link_name) || '이름 확인 전'; }
  function dotOf(display) { return display === 'active' ? 'live' : display === 'error' ? 'crit' : 'warn'; }
  function stateHtmlRoom(v) {
    return '<span class="state" data-state="' + esc(v.display) + '"><i class="dot ' + dotOf(v.display) + '"></i>' + esc(v.label) + '</span>';
  }
  function productsText(v) {
    var have = [];
    var wait = [];
    ['roombot', 'minigame'].forEach(function (p) {
      if (v.products && v.products[p]) have.push(PRODUCT_LABEL[p]);
      else if (v.pending_products && v.pending_products[p]) wait.push(PRODUCT_LABEL[p]);
    });
    return have.join(' · ') + (wait.length ? (have.length ? ' · ' : '') + wait.join('·') + ' 입금 대기' : '');
  }
  function productTags(v) {
    var out = [];
    ['roombot', 'minigame'].forEach(function (p) {
      if (v.products && v.products[p]) out.push('<span class="tag line">' + PRODUCT_LABEL[p] + '</span>');
      else if (v.pending_products && v.pending_products[p]) out.push('<span class="tag warn">' + PRODUCT_LABEL[p] + ' · 입금 대기</span>');
    });
    return out.join(' ') || '<span class="muted">—</span>';
  }
  function nickHtml(v) {
    if (!v.bot) return '<span class="muted">입장 전</span>';
    var n = v.bot.nickname && v.bot.nickname !== 'K bot 계정' ? v.bot.nickname : 'K bot';
    return '<span' + (hangul(n) ? '' : ' class="mono"') + '>' + esc(n) + '</span>';
  }
  function roombotLiveV(v) { return !!(v && v.products && v.products.roombot && v.display === 'active'); }
  function roomFeatOn(c, k) {
    if (!c) return false;
    if (k === 'visit') return !!((c.visit && c.visit.enabled) || (c.churn && c.churn.enabled) || (c.leaveKick && c.leaveKick.enabled));
    return !!(c[k] && c[k].enabled);
  }

  // ── 목록 ──────────────────────────────────────────────────
  function noteTransition(v) {
    var prev = roomSeen[v.id];
    roomSeen[v.id] = seenOf(v);
    if (!prev || prev.d === v.display) return;
    if (prev.d === 'waiting' && v.display === 'active') notify('부방장 지정을 확인했습니다.', roomName(v) + ' · 이제 방 관리 기능을 설정할 수 있습니다.');
    /* 미니게임만 쓰던 방에 방 관리봇을 더해 부방장 대기가 된 것은 강등이 아니다 */
    else if (prev.d === 'active' && v.display === 'waiting' && prev.rb) notify('부방장 권한이 해제되었습니다.', roomName(v) + ' · 다시 부방장으로 지정하면 방 관리 기능이 자동으로 다시 동작합니다.', { kind: 'warn' });
  }
  function seenOf(v) {
    return { d: v.display, rb: !!(v.products && v.products.roombot) };
  }
  function applyRooms(list, quiet) {
    var next = Array.isArray(list) ? list.filter(function (v) { return v && v.id; }) : [];
    next.forEach(function (v) { if (quiet && !roomSeen[v.id]) roomSeen[v.id] = seenOf(v); else noteTransition(v); });
    var sig = JSON.stringify(next);
    var changed = sig !== roomsSt.sig;
    roomsSt.sig = sig;
    rooms = next;
    if (roomSt.id && !roomById(roomSt.id)) roomGone();
    if (changed) roomsChanged();
  }
  function mergeRoom(v) {
    if (!v || !v.id) return;
    noteTransition(v);
    var next = rooms.slice();
    var i = -1;
    for (var k = 0; k < next.length; k++) if (next[k].id === v.id) { i = k; break; }
    if (i >= 0) next[i] = v; else next.unshift(v);
    var sig = JSON.stringify(next);
    if (sig === roomsSt.sig) return;
    roomsSt.sig = sig;
    rooms = next;
    roomsChanged();
  }
  function roomsChanged() {
    updateRoomNav();
    if (route === 'rooms') renderRoomsPage(false);
    if (route === 'overview') renderOverview(false);
    if (ROUTES[route] && ROUTES[route].room) renderRoomRoute(false);
  }
  // 보던 방이 목록에서 사라졌다(취소·해제·옮겨짐)
  function roomGone() {
    var onRoom = ROUTES[route] && ROUTES[route].room;
    try { localStorage.removeItem('kb.room'); } catch (e) { /* 다음 부팅에 목록으로 */ }
    resetRoom(0);
    ROOM_ROUTES.forEach(function (r) { delete baseline[r]; });
    if (onRoom) {
      dirtyN = 0;
      paintSave();
      notify('방을 찾을 수 없습니다.', '봇 설치가 취소되었거나 해제된 방입니다.', { kind: 'warn' });
      location.hash = '#rooms';
    }
    updateRoomNav();
  }
  function updateRoomNav() {
    var v = curRoom();
    var show = !!v;
    $('navCapRoom').hidden = !show;
    qsa('[data-room-nav]').forEach(function (a) {
      a.hidden = !show;
      if (v) a.setAttribute('href', '#' + a.dataset.r + '/' + v.id);
    });
    $('navCapRoomName').textContent = v ? roomName(v) : '';
    var c = roomSt.cfg;
    qsa('[data-rfs]').forEach(function (d) {
      var k = d.dataset.rfs;
      var has = !!(v && (k === 'games' ? v.products.minigame : v.products.roombot));
      var on = has && roomFeatOn(c, k);
      d.classList.toggle('on', on);
      d.title = on ? '켜짐' : '꺼짐';
      var a = d.closest('.nav-a');
      if (a) a.setAttribute('aria-description', on ? '켜짐' : '꺼짐');
    });
    var act = roomsActiveN();
    $('navRoomN').textContent = rooms.length ? act + '/' + rooms.length : '';
    var err = rooms.some(function (x) { return x.display === 'error'; });
    var wait = rooms.some(function (x) { return x.display === 'waiting'; });
    var rd = $('navRoomRd');
    rd.hidden = !(err || wait);
    rd.classList.toggle('crit', err);
    var na = qs('.nav-a[data-r="rooms"]');
    if (err || wait) na.setAttribute('aria-description', '확인 필요'); else na.removeAttribute('aria-description');
    if (navRoomShown !== show) {
      navRoomShown = show;
      if (route) navInd(true);
    }
  }
  function attnButton(v) {
    var id = v.id;
    if (v.display === 'pending') {
      var url = v.order && v.order.url ? v.order.url : '/account';
      return '<a class="btn sm" href="' + esc(url) + '">입금 안내</a>';
    }
    if (v.display === 'waiting') return '<a class="btn sm" href="#room/' + id + '">지정 방법 보기</a>';
    if (v.can_retry && v.needs_passcode) return '<a class="btn sm" href="#room/' + id + '" data-focus="r-passcode">참여코드 입력</a>';
    if (v.can_retry) {
      var later = Number(v.retry_after) > Date.now();
      return '<button type="button" class="btn sm" data-retry="' + id + '"' + (later ? ' disabled' : '') + '><span class="spin"></span><span class="lbl-idle">' +
        (later ? esc(fmtHM(v.retry_after)) + ' 이후' : '다시 시도') + '</span></button>';
    }
    if (needLink(v) && v.can_move) return '<a class="btn sm" href="#room/' + id + '" data-focus="r-move-link">새 링크 입력</a>';
    return '<button type="button" class="btn sm" data-support data-support-ctx="' + esc('방 #' + id + ' · ' + v.label) + '">문의하기</button>';
  }
  var roomsPageSig = '';
  function renderRoomsPage(enter) {
    var sig = JSON.stringify(rooms) + '#' + Math.floor(Date.now() / 60000);
    if (!enter && sig === roomsPageSig) return;
    roomsPageSig = sig;
    var tb = $('rooms-list');
    $('rooms-empty').hidden = !!rooms.length;
    $('rooms-sec').hidden = !rooms.length;
    $('rooms-tbl').hidden = !rooms.length;
    var focusId = '';
    var ae = document.activeElement;
    if (ae && tb.contains(ae)) { var fr = ae.closest('tr[data-room]'); if (fr) focusId = fr.dataset.room; }
    var stagger = enter && !reducedMotion();
    tb.innerHTML = rooms.map(function (v, i) {
      var nm = roomName(v);
      return '<tr class="rowx' + (stagger ? ' in' : '') + '" style="--i:' + Math.min(i, 14) + '" data-room="' + v.id + '" tabindex="0" role="link" aria-label="' + esc(nm) + ' 방 상태 열기">' +
        '<td data-l="대화방"><b>' + esc(nm) + '</b> <span class="mono dim">' + esc(linkText(v.link_url)) + '</span></td>' +
        '<td data-l="봇">' + productTags(v) + '</td>' +
        '<td data-l="상태">' + stateHtmlRoom(v) + '</td>' +
        '<td data-l="K bot">' + nickHtml(v) + '</td>' +
        '<td class="go">' + ic('right') + '</td></tr>';
    }).join('');
    if (focusId) { var f = qs('tr[data-room="' + focusId + '"]', tb); if (f) f.focus({ preventScroll: true }); }
    var att = rooms.filter(function (v) { return v.display === 'error' || v.display === 'waiting' || v.display === 'pending'; });
    $('rooms-attn-grp').hidden = !att.length;
    $('rooms-attn').innerHTML = att.map(function (v) {
      return '<div class="srow inline" data-room="' + v.id + '"><div class="srow-l"><span class="lb">' + esc(roomName(v)) + '</span><p>' + esc(v.detail) + '</p></div>' +
        '<div class="srow-r">' + stateHtmlRoom(v) + ' ' + attnButton(v) + '</div></div>';
    }).join('');
  }

  // ── 폴링 ──────────────────────────────────────────────────
  function stopRoomTimers() {
    if (roomsSt.timer) { clearTimeout(roomsSt.timer); roomsSt.timer = null; }
    if (roomSt.timer) { clearTimeout(roomSt.timer); roomSt.timer = null; }
    if (roomSt.hide && roomSt.hide.timer) { clearTimeout(roomSt.hide.timer); roomSt.hide.timer = null; }
  }
  function scheduleRooms() {
    if (roomsSt.timer) clearTimeout(roomsSt.timer);
    roomsSt.timer = null;
    if (!me || app.hidden) return;
    var fast = route === 'rooms' || route === 'overview';
    var ms = roomsSt.fails >= 3 ? 30000 : fast ? 10000 : 30000;
    if (route === 'rooms') runRing(qs('#page-rooms [data-poll]'), ms);
    roomsSt.timer = setTimeout(function () {
      roomsSt.timer = null;
      if (!me || app.hidden) return;
      if (document.hidden) { scheduleRooms(); return; }
      loadRooms().then(scheduleRooms, scheduleRooms);
    }, ms);
  }
  async function loadRooms() {
    if (!me || roomsSt.busy) return;
    roomsSt.busy = true;
    var seq = ++roomsSt.seq;
    try {
      var res = await api('/panel/api/bot-rooms');
      if (seq !== roomsSt.seq || !me) return;
      roomsSt.fails = 0;
      applyRooms(res.rooms || [], false);
    } catch (e) {
      if (authFail(e)) { showLogin(e); return; }
      roomsSt.fails += 1;
    } finally {
      roomsSt.busy = false;
    }
  }
  function resetRoom(id) {
    if (roomSt.timer) clearTimeout(roomSt.timer);
    if (roomSt.hide && roomSt.hide.timer) clearTimeout(roomSt.hide.timer);
    roomSt = blankRoom(id);
    exemptList = [];
    rcWords = [];
    expandedR = { visit: {}, profile: {} };
    setHideStatus('');
  }
  function setRoom(id) {
    if (!id || roomSt.id === id) return;
    resetRoom(id);
    ROOM_ROUTES.forEach(function (r) { delete baseline[r]; });
    try { localStorage.setItem('kb.room', String(id)); } catch (e) { /* 저장소를 못 쓰면 다음 부팅에 목록 */ }
    updateRoomNav();
    loadRoom();
  }
  function roomRouteChanged() {
    var R = ROUTES[route];
    if (route === 'rooms') loadRooms().then(scheduleRooms, scheduleRooms);
    else scheduleRooms();
    if (R && R.room) {
      if (ROOM_LOG_ROUTES[route]) loadRoomLogs();
      if (route === 'r-visit' || route === 'r-cover') loadPeople(false);
      scheduleRoom();
    } else if (roomSt.timer) {
      clearTimeout(roomSt.timer);
      roomSt.timer = null;
    }
  }
  function scheduleRoom() {
    if (roomSt.timer) clearTimeout(roomSt.timer);
    roomSt.timer = null;
    if (!me || app.hidden || !ROUTES[route] || !ROUTES[route].room) return;
    var ms = roomSt.fails >= 3 ? 30000 : 10000;
    runRing(qs('[data-poll]', pageOf(route)), ms);
    var id = roomSt.id;
    roomSt.timer = setTimeout(function () {
      roomSt.timer = null;
      if (id !== roomSt.id || !ROUTES[route] || !ROUTES[route].room) return;
      if (document.hidden) { scheduleRoom(); return; }
      var tasks = [loadRoom()];
      if (ROOM_LOG_ROUTES[route]) tasks.push(loadRoomLogs());
      if (route === 'r-visit' || route === 'r-cover') tasks.push(loadPeople(false));
      Promise.all(tasks).then(scheduleRoom, scheduleRoom);
    }, ms);
  }
  async function loadRoom() {
    var id = roomSt.id;
    if (!id || roomSt.busy) return;
    var st = roomSt;
    st.busy = true;
    var seq = ++st.seq;
    try {
      var res = await api('/panel/api/bot-room?id=' + id);
      if (st !== roomSt || seq !== st.seq) return;
      st.fails = 0;
      st.loadErr = '';
      applyRoomDetail(res);
    } catch (e) {
      if (st !== roomSt) return;
      if (authFail(e)) { showLogin(e); return; }
      st.fails += 1;
      if (e && e.status === 404) {
        rooms = rooms.filter(function (v) { return v.id !== id; });
        roomsSt.sig = JSON.stringify(rooms);
        roomGone();
        return;
      }
      st.loadErr = (e && e.message) || '방 설정을 불러오지 못했습니다.';
      renderRoomRoute(false);
    } finally {
      st.busy = false;
    }
  }
  function applyRoomDetail(res) {
    if (res.room) mergeRoom(res.room);
    if (Object.prototype.hasOwnProperty.call(res, 'ranking')) roomSt.ranking = Array.isArray(res.ranking) ? res.ranking : null;
    if (Object.prototype.hasOwnProperty.call(res, 'live')) roomSt.live = res.live || null;
    if (Object.prototype.hasOwnProperty.call(res, 'sender_up')) roomSt.senderUp = res.sender_up !== false;
    if (res.config) {
      var v = curRoom();
      var rev = res.room ? Number(res.room.config_rev) || 0 : (v ? Number(v.config_rev) || 0 : roomSt.cfgRev);
      var changed = !roomSt.cfg || rev !== roomSt.cfgRev || JSON.stringify(res.config) !== JSON.stringify(roomSt.cfg);
      roomSt.cfg = res.config;
      roomSt.cfgRev = rev;
      // 고치는 중인 방 화면이 있으면 그 폼은 두고(저장하면 stale 로 알려 준다) 나머지만 다시 채운다
      if (changed) fillRoomForms(isRoomRoute(route) && dirtyN > 0 ? route : '');
    }
    renderRoomRoute(false);
  }
  async function loadRoomLogs() {
    var id = roomSt.id;
    var st = roomSt;
    if (!id || st.logsBusy) return;
    st.logsBusy = true;
    var seq = ++st.logSeq;
    try {
      var res = await api('/panel/api/bot-room/logs?id=' + id);
      if (st !== roomSt || seq !== st.logSeq) return;
      var data = { visit: res.visit || [], profile: res.profile || [], guard: res.guard || [], actions: res.actions || [], sender_up: res.sender_up !== false };
      var down = data.sender_up ? '' : '서버가 멈춰 있어 K bot의 방 기록을 불러오지 못했습니다. 서버가 다시 켜지면 이어서 표시합니다.';
      ['r-visit-log-error', 'r-profile-log-error', 'r-guard-log-error'].forEach(function (x) { say(x, down); });
      say('r-log-error', '');
      var sig = JSON.stringify(data);
      if (sig === st.logsSig) return;
      var first = !st.logs;
      st.prevLogs = st.logs;
      st.logs = data;
      st.logsSig = sig;
      renderRoomLogs(first);
    } catch (e) {
      if (st !== roomSt) return;
      if (authFail(e)) { showLogin(e); return; }
      var msg = '기록을 가져오지 못했습니다. 잠시 뒤 자동으로 다시 불러옵니다.';
      ['r-log-error', 'r-visit-log-error', 'r-profile-log-error', 'r-guard-log-error'].forEach(function (x) { say(x, msg); });
    } finally {
      st.logsBusy = false;
    }
  }
  function renderRoomLogs(enter) {
    if (route === 'room') renderRoomLog();
    if (route === 'r-visit') { renderRVisitTable(enter); renderKickTable(); }
    if (route === 'r-profile') renderRProfileTable(enter);
    if (route === 'r-guard') renderRGuardTable(enter);
  }
  async function loadPeople(force) {
    var v = curRoom();
    if (!roombotLiveV(v)) { fillPeople(null, ''); return; }
    var st = roomSt;
    if (!force && st.people && Date.now() - st.peopleAt < 30000) { fillPeople(st.people, ''); return; }
    if (st.peopleBusy) return;
    st.peopleBusy = true;
    if (!st.people) fillPeople(null, '최근 작성자를 불러오는 중');
    try {
      var res = await api('/panel/api/bot-room/people?id=' + st.id);
      if (st !== roomSt) return;
      st.people = Array.isArray(res.people) ? res.people : [];
      st.peopleAt = Date.now();
      fillPeople(st.people, '');
    } catch (e) {
      if (st !== roomSt) return;
      if (authFail(e)) { showLogin(e); return; }
      fillPeople(st.people, st.people ? '' : '최근 작성자를 불러오지 못했습니다');
    } finally {
      st.peopleBusy = false;
    }
  }
  function fillPeople(list, msg) {
    ['r-exempt-pick', 'r-hide-who'].forEach(function (sid) {
      var sel = $(sid);
      var cur = sel.value;
      var first = msg || (list && !list.length ? '최근 글을 쓴 사람이 없습니다' : '최근 작성자에서 고르기');
      var html = '<option value="">' + esc(first) + '</option>';
      (list || []).forEach(function (p) {
        var uid = String(p.user_id || '');
        if (!uid) return;
        if (sid === 'r-exempt-pick' && exemptList.some(function (x) { return x.user_id === uid; })) return;
        html += '<option value="' + esc(uid) + '">' + esc((p.name || '이름 없음') + ' · 글 ' + (Number(p.count) || 0) + '개') + '</option>';
      });
      if (sel.dataset.sig === html) return;
      sel.dataset.sig = html;
      sel.innerHTML = html;
      if (cur && qsa('option', sel).some(function (o) { return o.value === cur; })) sel.value = cur;
    });
  }

  // ── 방 설정 폼 (7.1 키) ───────────────────────────────────
  function segVal(id) { var b = qs('#' + id + ' button[aria-pressed="true"]'); return b ? b.dataset.v : ''; }
  function segSet(id, v) {
    qsa('#' + id + ' button[data-v]').forEach(function (b) { b.setAttribute('aria-pressed', b.dataset.v === v ? 'true' : 'false'); });
    segInd($(id), true);
  }
  function segInds(root) { qsa('.seg', root || document).forEach(function (sg) { segInd(sg, true); }); }
  function setSw(id, on) { $(id).checked = !!on; }
  function setNum(id, v) { $(id).value = String(v); }
  function depsIn(root) {
    qsa('.swi[id]', root).forEach(function (sw) {
      var open = sw.checked;
      qsa('[data-dep="' + sw.id + '"]', root).forEach(function (d) { d.dataset.open = open ? 'true' : 'false'; });
      qsa('[data-dep-off="' + sw.id + '"]', root).forEach(function (d) { d.dataset.open = open ? 'false' : 'true'; });
    });
  }
  function fillRoomForm(r) {
    var c = roomSt.cfg;
    if (!c) return;
    if (r === 'room') segSet('r-prefix', c.cmdPrefix);
    if (r === 'r-visit') {
      setSw('r-visit-on', c.visit.enabled);
      segSet('r-visit-style', c.visit.style || 'image');
      setSw('r-churn-on', c.churn.enabled);
      setNum('r-churn-joins', c.churn.joins);
      setNum('r-churn-min', c.churn.windowMin);
      segSet('r-churn-action', c.churn.action);
      setSw('r-churn-notice', c.churn.notice);
      setSw('r-leave-on', c.leaveKick.enabled);
      setSw('r-leave-notice', c.leaveKick.notice);
      exemptList = (c.exempt || []).map(function (x) { return { user_id: String(x.user_id), name: x.name || '' }; });
      renderExempt();
    }
    if (r === 'r-profile') {
      setSw('r-profile-on', c.profile.enabled);
      setSw('r-profile-name', c.profile.name);
      setSw('r-profile-status', c.profile.status);
      segSet('r-profile-lookup', c.profile.lookup);
      segSet('r-profile-style', c.profile.style || 'image');
      segSet('r-cmd-link', (c.cmd && c.cmd.link) || 'staff');
      var na = c.status_supported === false;
      $('row-r-profile-status').hidden = na;
      $('row-r-profile-status-na').hidden = !na;
    }
    if (r === 'r-promo') {
      setSw('r-promo-on', c.promo.enabled);
      setSw('r-promo-links', c.promo.links);
      setSw('r-promo-cards', c.promo.cards);
      setSw('r-promo-media', c.promo.media);
      setSw('r-promo-hide', c.promo.hide);
      setNum('r-promo-kick', c.promo.kickAt);
      setNum('r-promo-reset', c.promo.resetHours);
      setSw('r-promo-notice', c.promo.notice);
    }
    if (r === 'r-cover') {
      setSw('r-cover-on', c.cover.enabled);
      rcWords = (c.cover.words || []).slice();
      renderRcWords();
      say('r-cover-word-err', '');
      setSw('r-cover-links', c.cover.links);
      setSw('r-hide-cmd', c.hide.command);
      segSet('r-hide-by', c.hide.by || 'staff');
      segSet('r-hide-target', c.hide.target || 'members');
    }
    if (r === 'r-guard') {
      setSw('r-guard-on', c.guard.enabled);
      setNum('r-guard-secs', c.guard.secs);
      setNum('r-guard-count', c.guard.count);
    }
    if (r === 'r-games') {
      setSw('r-games-on', c.games.enabled);
      ['word', 'baseball', 'dice', 'rps', 'quiz', 'sword', 'monster'].forEach(function (g) { setSw('r-games-' + g, c.games[g] !== false); });
      setNum('r-games-cool', c.games.cooldownSec);
      setNum('r-games-limit', c.games.dailyLimit);
    }
    depsIn(pageOf(r));
    roomPreviews(r);
  }
  function fillRoomForms(except) {
    ROOM_ROUTES.forEach(function (r) {
      if (r === except) return;
      fillRoomForm(r);
      baseline[r] = JSON.stringify(roomFormState(r));
    });
    if (!except) roomSt.formRev = roomSt.cfgRev;
    markDirty();
    updateRoomNav();
  }
  function roomFormState(r) {
    var c = roomSt.cfg || {};
    if (r === 'room') return { cmdPrefix: segVal('r-prefix') };
    if (r === 'r-visit') return {
      visit: { enabled: $('r-visit-on').checked, style: segVal('r-visit-style') || 'image' },
      churn: { enabled: $('r-churn-on').checked, joins: numVal('r-churn-joins'), windowMin: numVal('r-churn-min'), action: segVal('r-churn-action'), notice: $('r-churn-notice').checked },
      leaveKick: { enabled: $('r-leave-on').checked, notice: $('r-leave-notice').checked },
      exempt: exemptList.map(function (x) { return { user_id: x.user_id, name: x.name }; }),
    };
    if (r === 'r-profile') return {
      profile: {
        enabled: $('r-profile-on').checked, name: $('r-profile-name').checked,
        status: c.status_supported === false ? !!(c.profile && c.profile.status) : $('r-profile-status').checked,
        lookup: segVal('r-profile-lookup'),
        style: segVal('r-profile-style') || 'image',
      },
      cmd: { link: segVal('r-cmd-link') || 'staff' },
    };
    if (r === 'r-promo') return {
      promo: {
        enabled: $('r-promo-on').checked, links: $('r-promo-links').checked, cards: $('r-promo-cards').checked, media: $('r-promo-media').checked,
        hide: $('r-promo-hide').checked, kickAt: numVal('r-promo-kick'), resetHours: numVal('r-promo-reset'), notice: $('r-promo-notice').checked,
      },
    };
    if (r === 'r-cover') return {
      cover: { enabled: $('r-cover-on').checked, words: rcWords.slice(), links: $('r-cover-links').checked },
      hide: { command: $('r-hide-cmd').checked, by: segVal('r-hide-by') || 'staff', target: segVal('r-hide-target') || 'members' },
    };
    if (r === 'r-guard') return { guard: { enabled: $('r-guard-on').checked, secs: numVal('r-guard-secs'), count: numVal('r-guard-count') } };
    if (r === 'r-games') {
      var g = { enabled: $('r-games-on').checked };
      ['word', 'baseball', 'dice', 'rps', 'quiz', 'sword', 'monster'].forEach(function (k) { g[k] = $('r-games-' + k).checked; });
      g.cooldownSec = numVal('r-games-cool');
      g.dailyLimit = numVal('r-games-limit');
      return { games: g };
    }
    return null;
  }
  async function saveRoomSettings(r) {
    var v = curRoom();
    if (!roomSt.cfg || !v) return;
    var pending = leaveTarget && leaveTarget.saving ? leaveTarget : null;
    var id = roomSt.id;
    var st = roomSt;
    var state = roomFormState(r);
    var sent = JSON.stringify(state);
    var body = Object.assign({ id: id, rev: roomSt.formRev }, state);
    var name = roomName(v);
    saveBusy(true);
    say(errIdOf(r), '');
    try {
      var res = await api('/panel/api/bot-room/settings', body);
      if (st !== roomSt) { notify('저장했습니다.', name + ' · ' + routeTitle(r)); return; }
      leaveTarget = null;
      saveEl.classList.remove('leave');
      applyRoomDetail({ room: res.room, config: res.config });
      if (JSON.stringify(roomFormState(r)) === sent) fillRoomForms();
      else {
        // 저장하는 동안 더 고친 칸이 있다 — 보낸 값을 새 기준으로 삼아 남은 변경만 센다(4.14)
        baseline[r] = sent;
        roomSt.formRev = roomSt.cfgRev;
        markDirty();
      }
      notify('저장했습니다.', name);
      if (pending) runLeave(pending);
    } catch (e) {
      if (authFail(e)) { showLogin(e); return; }
      if (st !== roomSt) { notify('설정을 저장하지 못했습니다.', name + ' · ' + routeTitle(r), { kind: 'crit' }); return; }
      say(errIdOf(r), e.message);
      if (leaveTarget) leaveTarget.saving = false;
      saveEl.classList.remove('leave');
      paintSave();
      shakeSave();
      // 다른 화면에서 바뀌었거나 상태가 바뀌었으면 서버 값을 다시 읽어 둔다(폼은 그대로, 되돌리기로 새 값을 받는다)
      if (e && (e.status === 409 || e.status === 403)) loadRoom();
    } finally {
      saveBusy(false);
    }
  }

  // 제외할 사람·방 금지어 칩
  function renderExempt() {
    var box = $('r-exempt');
    if (!exemptList.length) box.innerHTML = '<span class="chips-none">제외 대상이 없습니다.</span>';
    else box.innerHTML = exemptList.map(function (x) {
      var nm = x.name || '이름 없음';
      return '<span class="wchip" role="listitem" title="' + esc(nm + ' · ' + x.user_id) + '"><span>' + esc(nm) + '</span>' +
        '<button type="button" data-exdel="' + esc(x.user_id) + '" aria-label="' + esc(nm) + ' 제외 해제">' + ic('x', 12) + '</button></span>';
    }).join('');
    $('r-exempt-n').textContent = exemptList.length + ' / 50';
    fillPeople(roomSt.people, '');
  }
  function addExempt(uid, name) {
    say('r-exempt-err', '');
    if (!uid) return;
    if (exemptList.some(function (x) { return x.user_id === uid; })) { say('r-exempt-err', '이미 제외한 사람입니다.'); return; }
    if (exemptList.length >= 50) { say('r-exempt-err', '제외 대상은 50명까지 등록할 수 있습니다.'); return; }
    exemptList.push({ user_id: uid, name: String(name || '').slice(0, 40) });
    renderExempt();
    markDirty();
  }
  function renderRcWords(newIdx) {
    var box = $('r-cover-words');
    var inp = $('r-cover-word-in');
    qsa('.wchip', box).forEach(function (c) { c.remove(); });
    rcWords.forEach(function (w, i) {
      var c = el('span', 'wchip' + (i === newIdx ? ' new' : ''));
      c.dataset.w = w.toLowerCase();
      c.appendChild(el('span', '', w));
      var b = el('button');
      b.type = 'button';
      b.dataset.rwdel = String(i);
      b.setAttribute('aria-label', w + ' 삭제');
      b.innerHTML = ic('x', 12);
      c.appendChild(b);
      box.insertBefore(c, inp);
    });
    $('r-cover-word-n').textContent = rcWords.length + ' / 300';
  }
  function rcAddWords(raw) {
    var err = '';
    var code = '';
    var added = -1;
    String(raw).split(/[,\n]/).forEach(function (w) {
      w = w.trim();
      if (!w) return;
      if (w.length > 30) { err = '30자를 넘는 단어는 추가되지 않습니다. 단어를 줄여 다시 입력해 주세요.'; code = 'long'; return; }
      var lower = w.toLowerCase();
      if (rcWords.some(function (x) { return x.toLowerCase() === lower; })) {
        err = '이미 추가된 단어입니다.';
        if (!code) code = 'dupe';
        var c = qsa('#r-cover-words .wchip').filter(function (x) { return x.dataset.w === lower; })[0];
        if (c && !reducedMotion()) { c.classList.remove('dupe'); void c.offsetWidth; c.classList.add('dupe'); }
        return;
      }
      if (rcWords.length >= 300) { err = '금지어는 300개까지 등록할 수 있습니다. 쓰지 않는 단어를 지워 주세요.'; code = 'max'; return; }
      rcWords.push(w);
      added = rcWords.length - 1;
    });
    say('r-cover-word-err', err);
    if (added >= 0) { renderRcWords(added); markDirty(); }
    return code;
  }

  // 문장·미리 보기(지금 폼 값 기준)
  function roomPreviews(r) {
    var c = roomSt.cfg;
    var pfx = segVal('r-prefix') || (c && c.cmdPrefix) || '!';
    if (r === 'r-visit' || r === 'r-profile') stylePreview(r === 'r-visit' ? 'r-visit-style' : 'r-profile-style');
    if (r === 'r-visit') {
      var joins = numVal('r-churn-joins') || 3;
      var min = numVal('r-churn-min') || 10;
      var kick = segVal('r-churn-action') === 'kick';
      $('r-churn-sent').innerHTML = '<b>' + fmtNum(min) + '분</b> 안에 <b>' + joins + '회</b> 이상 들어오면 ' + (kick ? '내보냅니다.' : '경고합니다.');
    }
    if (r === 'r-promo') {
      var kickAt = numVal('r-promo-kick');
      if (kickAt === null) kickAt = 3;
      var hide = $('r-promo-hide').checked;
      var t = $('r-promo-preview-t');
      if (!$('r-promo-notice').checked) {
        t.textContent = '방에 안내를 보내지 않습니다. 위반은 조치 기록에만 남습니다.';
        t.classList.add('dim');
      } else {
        t.classList.remove('dim');
        // sender/src/roomfeat.mjs promoNotice 와 같은 모양(첫 위반)
        t.textContent = '[홍보 금지]\n이름 : @하늘\n경고 : ' + (kickAt > 1 ? '1회 (' + kickAt + '회가 되면 내보내요)' : '1회') + '\n조치 : ' + (kickAt === 1 ? '내보내기' : hide ? '글 가리기' : '경고') + '\n오후 9:14';
      }
    }
    if (r === 'r-cover') {
      var note = $('r-cover-links-note');
      if (note) note.hidden = !(c && c.promo && c.promo.enabled && c.promo.links);
    }
    if (r === 'r-guard') {
      $('r-guard-sent').innerHTML = '<b>' + (numVal('r-guard-secs') || 30) + '초</b> 안에 <b>' + (numVal('r-guard-count') || 5) + '명</b> 이상 내보내면 올킥으로 감지합니다.';
    }
    if (r === 'r-games') {
      $('r-games-preview-q').textContent = pfx + '도움';
      // sender/src/roomfeat.mjs helpLine 과 같은 모양: [명령어] / 미니게임 : … / 검 강화 : … / 몬스터 수집 : … / 방 관리 : … / 「!도움 관리」 안내
      var out = [];
      if ($('r-games-word').checked) out.push(pfx + '끝말잇기');
      if ($('r-games-baseball').checked) out.push(pfx + '숫자야구');
      if ($('r-games-dice').checked) out.push(pfx + '주사위');
      if ($('r-games-rps').checked) out.push(pfx + '가위바위보');
      if ($('r-games-quiz').checked) out.push(pfx + '퀴즈', pfx + '힌트', pfx + '정답');
      if ($('r-games-word').checked || $('r-games-baseball').checked || $('r-games-quiz').checked) out.push(pfx + '포기');
      out.push(pfx + '랭킹');
      var roomCmds = [];
      var v = curRoom();
      if (roombotLiveV(v) && c) {
        if (!c.cmd || c.cmd.link !== 'off') roomCmds.push(pfx + '옾링');
        if (c.profile && c.profile.enabled && c.profile.lookup !== 'off') roomCmds.push(pfx + '프로필조회');
        if (c.hide && c.hide.command) roomCmds.push(pfx + '가리기');
        roomCmds.push(pfx + '내보내기', pfx + '설정');
      }
      // 추억의 검 강화 줄(sender/src/sword.mjs helpLine)
      var sword = $('r-games-sword').checked ? '\n검 강화 : ' + pfx + '강화 ' + pfx + '내검 ' + pfx + '사냥 ' + pfx + '출석 ' + pfx + '결투 ' + pfx + '보스 ' + pfx + '강화도움' : '';
      // 몬스터 수집 줄(sender/src/monster.mjs helpCommands)
      var monCmds = $('r-games-monster').checked ? ['탐험', '포획', '도감', '내몬스터', '배틀', '교환', '레이드', '도전', '몬스터'].map(function (x) { return pfx + x; }) : [];
      $('r-games-preview-t').textContent = '[명령어]\n미니게임 : ' + out.join(' ') + sword + (monCmds.length ? '\n몬스터 수집 : ' + monCmds.join(' ') : '') +
        (roomCmds.length ? '\n방 관리 : ' + roomCmds.join(' ') + '\n「' + pfx + '도움 관리」를 입력하면 방 관리 명령어 설명을 볼 수 있어요.' : '');
    }
  }

  // 방에 보내는 안내 모양(이미지·글) 미리 보기 — sender/src/roomfeat.mjs card · logcard.mjs 와 같은 모양(그림은 sender/src/logcard-sample.mjs 가 만든다)
  var STYLE_NOTE = {
    image: '이미지 1장과 그 사람을 멘션한 한 줄을 보냅니다. 이미지를 보내지 못하면 아래 「글」 모양으로 보냅니다.',
    text: '글 1개로 보냅니다. 이름에 그 사람을 멘션합니다.'
  };
  function stylePreview(id) {
    var v = segVal(id) || 'image';
    qsa('[data-style-of="' + id + '"] .style-v').forEach(function (x) { x.hidden = x.dataset.v !== v; });
    var note = qs('[data-style-note="' + id + '"]');
    if (note) note.textContent = STYLE_NOTE[v] || '';
  }

  // ── 화면 그리기 ───────────────────────────────────────────
  function notActiveGate(v) {
    if (v.display === 'error') return { note: '방 상태가 「' + v.label + '」입니다. 방 상태 화면에서 문제를 해결한 뒤 설정할 수 있습니다.', btn: { label: '방 상태', href: '#room/' + v.id } };
    if (v.display === 'waiting') return { note: NOT_ACTIVE, btn: { label: '지정 방법 보기', href: '#room/' + v.id } };
    return { note: NOT_ACTIVE, btn: { label: '방 상태', href: '#room/' + v.id } };
  }
  function roomGate(r, v) {
    var R = ROUTES[r];
    var orderBtn = v.order && v.order.url ? { label: '입금 안내', href: v.order.url } : null;
    if (R.roombot || R.minigame) {
      var p = R.roombot ? 'roombot' : 'minigame';
      if (!v.products[p]) {
        if (v.pending_products && v.pending_products[p]) {
          return { all: true, lock: true, note: PRODUCT_LABEL[p] + '은 입금 대기 중입니다. 입금이 확인되면 설정할 수 있습니다.', btn: orderBtn };
        }
        return { all: true, lock: true, note: '이 방에는 ' + PRODUCT_LABEL[p] + (p === 'roombot' ? '이' : '이') + ' 설치되어 있지 않습니다.', btn: { label: '봇 추가', href: '/buy?add=' + v.id } };
      }
      if (R.roombot && v.display !== 'active') {
        var g = notActiveGate(v);
        return { lock: true, note: g.note, btn: g.btn };
      }
      return {};
    }
    // 방 상태(명령어 앞글자): 설치되면 언제나(7.1)
    return { lock: v.display === 'pending' || (!v.products.roombot && !v.products.minigame) };
  }
  function renderRoomRoute(enter) {
    var r = route;
    if (!ROUTES[r] || !ROUTES[r].room) return;
    var v = curRoom();
    if (!v) return;
    updateCrumbs();
    var page = pageOf(r);
    var g = roomGate(r, v);
    if (!roomSt.cfg && !g.note && roomSt.loadErr) g = { lock: true, note: roomSt.loadErr, btn: null };
    var gateEl = qs('[data-gate]', page);
    if (gateEl) {
      gateEl.hidden = !g.note;
      if (g.note) {
        qs('[data-gate-t]', gateEl).textContent = g.note;
        var gb = qs('[data-gate-btn]', gateEl);
        gb.hidden = !g.btn;
        if (g.btn) { gb.textContent = g.btn.label; gb.setAttribute('href', g.btn.href); }
      }
    }
    page.dataset.gated = g.all ? 'all' : '';
    qsa('fieldset[data-rfs]', page).forEach(function (f) { f.disabled = !!g.lock || !roomSt.cfg; });
    var pfx = (roomSt.cfg && roomSt.cfg.cmdPrefix) || '!';
    qsa('[data-prefix]', page).forEach(function (x) { x.textContent = pfx; });
    qsa('[data-r-who]', page).forEach(function (x) { x.textContent = roomName(v) + ' · K bot이 보냄'; });
    if (r === 'room') renderRoomPage();
    if (r === 'r-visit') { roomPreviews(r); renderRVisitTable(enter); renderKickTable(); }
    if (r === 'r-profile') renderRProfileTable(enter);
    if (r === 'r-promo') roomPreviews(r);
    if (r === 'r-cover') { roomPreviews(r); renderHideControls(); }
    if (r === 'r-guard') { roomPreviews(r); renderRGuardTable(enter); }
    if (r === 'r-games') { roomPreviews(r); renderRankTable(); }
  }
  var roomErrTimer = null;
  function renderRoomPage() {
    var v = curRoom();
    if (!v) return;
    $('room-title').textContent = roomName(v);
    $('row-r-cmds').hidden = !v.products.roombot;
    $('room-link').textContent = linkText(v.link_url);
    // 닉네임이 없으면 서버가 'K bot 계정' 을 채워 준다 → 「K bot 계정」 을 겹쳐 쓰지 않는다
    var bn = v.bot && v.bot.nickname && v.bot.nickname !== 'K bot 계정' && v.bot.nickname !== 'K bot' ? v.bot.nickname : '';
    $('room-bot').textContent = v.bot ? 'K bot' + (bn ? ' 「' + bn + '」' : '') : 'K bot 입장 전';
    var st = $('room-state');
    st.dataset.state = v.display;
    st.innerHTML = '<i class="dot ' + dotOf(v.display) + '"></i>' + esc(v.label);
    // 진행 단계: 방 관리봇이 있으면 4단계, 미니게임만이면 3단계(6.9)
    var four = !!(v.products.roombot || (v.pending_products && v.pending_products.roombot));
    var steps = $('room-steps');
    steps.classList.toggle('s4', four);
    qs('[data-s="host"]', steps).hidden = !four;
    qs('[data-s="use"] .n', steps).textContent = four ? '4' : '3';
    var order = four ? ['pay', 'join', 'host', 'use'] : ['pay', 'join', 'use'];
    var cur = { pending: 'pay', joining: 'join', error: 'join', waiting: 'host', active: 'use' }[v.display] || 'join';
    var ci = order.indexOf(cur);
    order.forEach(function (k, i) {
      var li = qs('[data-s="' + k + '"]', steps);
      var done = v.display === 'active' || i < ci;
      var isCur = !done && i === ci;
      li.classList.toggle('done', done);
      li.classList.toggle('cur', isCur);
      if (isCur) li.setAttribute('aria-current', 'step'); else li.removeAttribute('aria-current');
    });
    $('room-pending').hidden = v.display !== 'pending';
    $('room-order').setAttribute('href', (v.order && v.order.url) || '/account');
    $('room-join').hidden = v.display !== 'joining';
    $('room-join-t').textContent = v.display === 'joining' ? v.detail : '';
    $('room-wait').hidden = v.display !== 'waiting';
    $('room-wait-t').textContent = v.display === 'waiting' ? v.detail : '';
    $('room-wait-mg').hidden = !(v.display === 'waiting' && v.products.minigame);
    $('room-wait-mg-go').setAttribute('href', '#r-games/' + v.id);
    var off = v.display === 'active' && v.products.roombot && Number(v.on_count) === 0;
    $('room-off').hidden = !off;
    $('room-off-go').setAttribute('href', '#r-visit/' + v.id);
    renderRoomErr(v);
    renderMove(v);
    ['roombot', 'minigame'].forEach(function (p) {
      var box = qs('[data-prod-r="' + p + '"]');
      var html;
      if (v.products[p]) html = '<span class="tag line">설치됨</span>';
      else if (v.pending_products && v.pending_products[p]) html = '<span class="tag warn">입금 대기</span>';
      else if (v.display === 'pending') html = '<span class="muted">선택 안 함</span>';
      else html = '<a class="btn sm" href="/buy?add=' + v.id + '">' + ic('plus', 12) + '봇 추가</a>';
      if (box.dataset.sig !== html) { box.dataset.sig = html; box.innerHTML = html; }
    });
    renderRoomLog();
  }
  function renderRoomErr(v) {
    var box = $('room-err');
    var on = v.display === 'error';
    box.hidden = !on;
    if (roomErrTimer) { clearTimeout(roomErrTimer); roomErrTimer = null; }
    if (!on) return;
    $('room-err-t').textContent = v.detail;
    $('r-passcode-wrap').hidden = !(v.can_retry && v.needs_passcode);
    var rb = $('room-retry');
    rb.hidden = !v.can_retry;
    var later = v.can_retry && Number(v.retry_after) > Date.now();
    if (!rb.classList.contains('busy')) rb.disabled = later;
    var hint = $('room-retry-hint');
    hint.hidden = !later;
    hint.textContent = later ? fmtHM(v.retry_after) + ' 이후에 다시 시도할 수 있습니다.' : '';
    $('room-support').setAttribute('data-support-ctx', '방 #' + v.id + ' · ' + v.label);
    $('room-move-go').hidden = !(needLink(v) && v.can_move);
    if (later) {
      var wait = Math.min(Number(v.retry_after) - Date.now() + 200, 6 * 3600000);
      roomErrTimer = setTimeout(function () { if (route === 'room') renderRoomPage(); if (route === 'rooms') renderRoomsPage(true); }, wait);
    }
  }
  function emptyRow(cols, text) { return '<tr class="none"><td colspan="' + cols + '"><p class="empty">' + text + '</p></td></tr>'; }
  function renderRoomLog() {
    var tb = qs('#r-log-tbl tbody');
    var L = roomSt.logs ? roomSt.logs.actions : null;
    if (!L) { tb.innerHTML = emptyRow(4, '기록을 불러오고 있습니다.'); return; }
    if (!L.length) { tb.innerHTML = emptyRow(4, '조치 기록이 없습니다. K bot이 방에 들어가거나 켠 기능이 동작하면 이곳에 표시됩니다.'); return; }
    tb.innerHTML = L.map(function (a) {
      return '<tr class="line"><td data-l="시각"><span class="t">' + fmtTL(a.at) + '</span></td>' +
        '<td data-l="종류" class="c-kind">' + esc(LOG_KIND[a.kind] || a.kind) + '</td>' +
        '<td data-l="대상">' + (a.name ? esc(a.name) : '<span class="muted">—</span>') + '</td>' +
        '<td data-l="결과" class="c-txt' + (a.ok === false ? ' crit' : '') + '">' + esc(a.text) + '</td></tr>';
    }).join('');
  }
  function renderRVisitTable(enter) {
    var tb = qs('#r-visit-tbl tbody');
    var all = roomSt.logs ? roomSt.logs.visit : null;
    var prev = {};
    if (roomSt.prevLogs) roomSt.prevLogs.visit.forEach(function (r) { prev[visitKey(r)] = visitLatest(r); });
    if (!all) { tb.innerHTML = emptyRow(6, '기록을 불러오고 있습니다.'); $('r-visit-cnt').textContent = ''; return; }
    var q = rUi.vq.trim().toLowerCase();
    var rows = all.filter(function (r) {
      return !q || ((r.name || '') + ' ' + (r.link || '') + ' ' + (r.changes || []).map(function (c) { return c.name; }).join(' ')).toLowerCase().indexOf(q) >= 0;
    });
    $('r-visit-cnt').textContent = rows.length + '명' + (rows.length !== all.length ? ' · 전체 ' + all.length + '명' : '');
    if (!rows.length) {
      tb.innerHTML = emptyRow(6, all.length ? '검색어와 일치하는 기록이 없습니다.' : '기록이 없습니다. 입장·퇴장 기록을 켜면 이후 입장·퇴장이 이곳에 표시됩니다.');
      return;
    }
    var focusK = keepFocus(tb);
    var stagger = enter && !reducedMotion();
    tb.innerHTML = rows.map(function (r, i) {
      var k = visitKey(r);
      var joins = r.joins || [];
      var leaves = r.leaves || [];
      var changes = r.changes || [];
      var lj = last(joins);
      var ll = last(leaves);
      var open = !!expandedR.visit[k];
      var churn = joins.length >= 2 ? '<span class="tag line">들낙 ' + (joins.length - 1) + '회</span>' : '';
      var ch = changes.length ? '<span class="chain"><span class="old">' + esc(last(changes).name) + '</span><span class="arr">→</span>' + esc(r.name) + '</span>' + (changes.length > 1 ? ' <span class="muted">외 ' + (changes.length - 1) + '회</span>' : '') : '<span class="muted">—</span>';
      var ev = visitEvents(r);
      var tl = '<div class="tl"><ol aria-label="' + esc(r.name || '이름 없음') + ' 시간순 기록">' + ev.map(function (e) {
        return '<li class="ty-' + e.ty + '"><span class="mono">' + fmtTL(e.at) + '</span><span class="k">' + e.k + '</span><span>' + (e.tx || esc(r.room || roomName(curRoom()))) + '</span></li>';
      }).join('') + '</ol><div class="side-i"><dl><dt>사용자 ID</dt><dd>' + (r.user_id ? esc(r.user_id) : '<span class="sans">없음</span>') + '</dd><dt>오픈프로필</dt><dd>' + (r.link ? esc(r.link) : '<span class="sans">찾지 못했습니다</span>') + '</dd></dl></div></div>';
      var isFresh = !enter && roomSt.prevLogs && (!(k in prev) || visitLatest(r) > prev[k]);
      return '<tr class="rowx' + (stagger ? ' in' : '') + (isFresh ? ' fresh' : '') + '" style="--i:' + Math.min(i, 14) + '" tabindex="0" aria-expanded="' + open + '" data-x="' + i + '" data-k="' + esc(k) + '">' +
        '<td class="c-name"><div class="who-c"><span><span class="nm">' + esc(r.name || '이름 없음') + '</span>' + (churn ? '<span class="badges">' + churn + '</span>' : '') + '</span></div></td>' +
        '<td class="c-j" data-l="최근 입장">' + (lj ? '<span class="t">' + fmtT(lj) + (joins.length > 1 ? '<span class="more">총 ' + joins.length + '회</span>' : '') + '</span>' : '<span class="muted">—</span>') + '</td>' +
        '<td class="c-l" data-l="최근 퇴장">' + (ll ? '<span class="t">' + fmtT(ll) + (leaves.length > 1 ? '<span class="more">총 ' + leaves.length + '회</span>' : '') + '</span>' : '<span class="muted">—</span>') + '</td>' +
        '<td class="c-chain" data-l="이름 변경">' + ch + '</td>' +
        '<td class="c-link" data-l="링크">' + (r.link ? '<span class="lnk"><span>' + esc(linkText(r.link)) + '</span>' + copyBtn(r.link) + '</span>' : '<span class="muted">링크 없음</span>') + '</td>' +
        '<td class="chev-c">' + ic('down', 14) + '</td></tr>' +
        '<tr class="detail' + (open ? ' open' : '') + '"><td colspan="6"><div class="detail-in"><div>' + tl + '</div></div></td></tr>';
    }).join('');
    if (focusK) { var f = qsa('tr.rowx', tb).filter(function (x) { return x.dataset.k === focusK; })[0]; if (f) f.focus({ preventScroll: true }); }
  }
  // K bot 이 내보낸 사람: 조치 기록의 kick·kick_fail 중 사람마다 가장 최근 것, 그 뒤에 해제된 사람은 뺀다(7.2(b))
  function kickedPeople() {
    var A = (roomSt.logs && roomSt.logs.actions) || [];
    var seen = {};
    var out = [];
    A.forEach(function (a) {
      var uid = a.user_id ? String(a.user_id) : '';
      if (!uid || seen[uid]) return;
      if (a.kind === 'unkick') { seen[uid] = 1; return; }
      if (a.kind === 'kick' || a.kind === 'kick_fail') { seen[uid] = 1; out.push(a); }
    });
    return out;
  }
  function renderKickTable() {
    var tb = qs('#r-kick-tbl tbody');
    if (!roomSt.logs) { tb.innerHTML = emptyRow(4, '기록을 불러오고 있습니다.'); return; }
    var L = kickedPeople();
    if (!L.length) { tb.innerHTML = emptyRow(4, 'K bot이 내보낸 사람이 없습니다.'); return; }
    var live = roombotLiveV(curRoom());
    tb.innerHTML = L.map(function (a) {
      var nm = a.name || '이름 없음';
      return '<tr class="line" data-uid="' + esc(a.user_id) + '"><td data-l="이름"><span class="nm">' + esc(nm) + '</span></td>' +
        '<td data-l="시각"><span class="t">' + fmtTL(a.at) + '</span></td>' +
        '<td data-l="내용" class="c-txt' + (a.ok === false ? ' crit' : '') + '">' + esc(a.text) + '</td>' +
        '<td class="c-acts"><button type="button" class="btn sm" data-unkick="' + esc(a.user_id) + '" data-name="' + esc(nm) + '"' + (live ? '' : ' disabled title="K bot이 부방장일 때 해제할 수 있습니다"') + '>' +
        '<span class="spin"></span><span class="lbl-idle">내보내기 해제</span></button></td></tr>';
    }).join('');
  }
  function changeKind(c) { return (c && c.kind) || 'name'; }
  function renderRProfileTable(enter) {
    var tb = qs('#r-profile-tbl tbody');
    var all = roomSt.logs ? roomSt.logs.profile : null;
    if (!all) { tb.innerHTML = emptyRow(6, '기록을 불러오고 있습니다.'); $('r-profile-cnt').textContent = ''; return; }
    var q = rUi.pq.trim().toLowerCase();
    var rows = all.filter(function (r) { return !q || ((r.name || '') + ' ' + (r.changes || []).map(function (c) { return c.name || ''; }).join(' ')).toLowerCase().indexOf(q) >= 0; });
    $('r-profile-cnt').textContent = rows.length + '명';
    if (!rows.length) {
      tb.innerHTML = emptyRow(6, all.length ? '검색어와 일치하는 이름이 없습니다.' : '감지된 변경이 없습니다. 프로필 기록을 켜면 이곳에 표시됩니다.');
      return;
    }
    var focusK = keepFocus(tb);
    var stagger = enter && !reducedMotion();
    var prev = {};
    if (roomSt.prevLogs) roomSt.prevLogs.profile.forEach(function (r) { prev[profileKey(r)] = last(r.changes) ? last(r.changes).at : 0; });
    tb.innerHTML = rows.map(function (r, i) {
      var k = profileKey(r);
      var changes = (r.changes || []).filter(function (c) { return PROFILE_KIND[changeKind(c)]; });
      var nameCh = changes.filter(function (c) { return changeKind(c) === 'name'; });
      var lastC = last(changes);
      var open = !!expandedR.profile[k];
      var kinds = [];
      changes.forEach(function (c) { var kk = PROFILE_KIND[changeKind(c)]; if (kk && kinds.indexOf(kk) < 0) kinds.push(kk); });
      var chain;
      if (nameCh.length) {
        var names = nameCh.map(function (c) { return c.name; }).concat([r.name]);
        chain = names.map(function (n, j) { return j === names.length - 1 ? '<b class="cur">' + esc(n) + '</b>' : '<span class="old">' + esc(n) + '</span><span class="arr">→</span>'; }).join('');
      } else chain = '<b class="cur">' + esc(r.name) + '</b>';
      var tl = '<div class="tl"><ol aria-label="' + esc(r.name) + ' 프로필 변경 기록">' + changes.map(function (c, j) {
        var kind = changeKind(c);
        var what;
        if (kind === 'status' || kind === 'link') what = '<span class="old">' + esc(c.from || '없음') + '</span><span class="arr">→</span>' + esc(c.to || '없음');
        else {
          var nx = nameCh[nameCh.indexOf(c) + 1];
          what = '<span class="old">' + esc(c.name) + '</span><span class="arr">→</span>' + esc(nx ? nx.name : r.name);
        }
        void j;
        return '<li class="ty-name"><span class="mono">' + fmtTL(c.at) + '</span><span class="k">' + (PROFILE_KIND[kind] || '변경') + '</span><span>' + what + '</span></li>';
      }).reverse().join('') + '</ol><div class="side-i"><dl><dt>사용자 ID</dt><dd>' + (r.user_id ? esc(r.user_id) : '<span class="sans">없음</span>') + '</dd><dt>마지막 확인</dt><dd>' + (r.at ? fmtFull(r.at) : '—') + '</dd></dl></div></div>';
      var isFresh = !enter && roomSt.prevLogs && (!(k in prev) || (lastC ? lastC.at : 0) > prev[k]);
      return '<tr class="rowx' + (stagger ? ' in' : '') + (isFresh ? ' fresh' : '') + '" style="--i:' + Math.min(i, 14) + '" tabindex="0" aria-expanded="' + open + '" data-x="' + i + '" data-k="' + esc(k) + '">' +
        '<td class="c-name"><div class="who-c"><span class="nm">' + esc(r.name) + '</span></div></td>' +
        '<td class="c-at" data-l="최근 변경"><span class="t">' + (lastC ? fmtT(lastC.at) : '—') + '</span></td>' +
        '<td class="c-kind" data-l="항목">' + esc(kinds.join(' · ') || '닉네임') + '</td>' +
        '<td class="c-chain" data-l="이력"><span class="chain">' + chain + '</span></td>' +
        '<td class="c-cnt"><span class="cnt-pill">' + changes.length + '<span class="sans">회</span></span></td>' +
        '<td class="chev-c">' + ic('down', 14) + '</td></tr>' +
        '<tr class="detail' + (open ? ' open' : '') + '"><td colspan="6"><div class="detail-in"><div>' + tl + '</div></div></td></tr>';
    }).join('');
    if (focusK) { var f = qsa('tr.rowx', tb).filter(function (x) { return x.dataset.k === focusK; })[0]; if (f) f.focus({ preventScroll: true }); }
  }
  function renderRGuardTable(enter) {
    var tb = qs('#r-guard-tbl tbody');
    var L = roomSt.logs ? roomSt.logs.guard.slice(0, 20) : null;
    if (!L) { tb.innerHTML = emptyRow(2, '기록을 불러오고 있습니다.'); return; }
    if (!L.length) { tb.innerHTML = emptyRow(2, '감지된 올킥이 없습니다. 감지되면 이곳에 표시됩니다.'); return; }
    var stagger = enter && !reducedMotion();
    tb.innerHTML = L.map(function (g, i) {
      return '<tr class="line' + (stagger ? ' in' : '') + '" style="--i:' + i + '"><td data-l="시각"><span class="t">' + fmtFull(g.at) + '</span></td><td data-l="내용" class="c-txt">' + esc(g.text) + '</td></tr>';
    }).join('');
  }
  function renderRankTable() {
    var tb = qs('#r-rank-tbl tbody');
    var v = curRoom();
    var L = roomSt.ranking;
    var canReset = !!(v && v.products.minigame && v.display !== 'pending');
    var rb = $('r-rank-reset');
    if (rb) rb.disabled = !canReset;
    if (!L) {
      tb.innerHTML = emptyRow(3, v && v.display === 'pending' ? 'K bot이 방에 들어간 뒤에 표시됩니다.'
        : !roomSt.senderUp ? '서버가 멈춰 있어 랭킹을 불러오지 못했습니다.' : '랭킹을 불러오고 있습니다.');
      return;
    }
    if (!L.length) { tb.innerHTML = emptyRow(3, '아직 점수가 없습니다. 방에서 게임을 하면 이곳에 표시됩니다.'); return; }
    tb.innerHTML = L.slice(0, 10).map(function (p, i) {
      return '<tr class="line"><td class="c-rank" data-l="순위">' + (i + 1) + '</td><td data-l="이름">' + esc(p.name || '이름 없음') + '</td>' +
        '<td class="c-cnt" data-l="점수"><span class="cnt-pill">' + fmtNum(Number(p.score) || 0) + '<span class="sans">점</span></span></td></tr>';
    }).join('');
  }

  // ── 가리기 (7.2(e)) ───────────────────────────────────────
  function setHideStatus(text, err) {
    var row = $('row-r-hide-status');
    if (!row) return;
    row.hidden = !text;
    var p = $('r-hide-status');
    p.textContent = text || '';
    p.classList.toggle('errt', !!err);
  }
  function renderHideControls() {
    var busy = !!roomSt.hide;
    ['last', 'who'].forEach(function (k) {
      var b = $('r-hide-' + k + '-btn');
      if (b) b.disabled = busy;
    });
  }
  function hideReset(kind, focus) {
    var wrap = $('r-hide-' + kind + '-act');
    wrap.innerHTML = '<button type="button" class="btn sm" id="r-hide-' + kind + '-btn"' + (roomSt.hide ? ' disabled' : '') + '>가리기</button>';
    if (focus) $('r-hide-' + kind + '-btn').focus();
  }
  function hideAsk(kind) {
    var q;
    if (kind === 'last') {
      fixNum($('r-hide-last'));
      q = '최근 글 ' + (Number($('r-hide-last').value) || 1) + '개를 가립니다.';
    } else {
      var sel = $('r-hide-who');
      if (!sel.value) { setHideStatus('가릴 사람을 골라 주세요.', true); sel.focus(); return; }
      q = sel.options[sel.selectedIndex].text.split(' · ')[0] + '의 최근 글을 모두 가립니다.';
    }
    setHideStatus('');
    var wrap = $('r-hide-' + kind + '-act');
    wrap.innerHTML = '<span class="q">' + esc(q) + '</span><button type="button" class="btn sm" data-hide-no="' + kind + '">취소</button>' +
      '<button type="button" class="btn sm danger solid" data-hide-yes="' + kind + '"><span class="spin"></span><span class="lbl-idle">가리기</span></button>';
    qs('[data-hide-no]', wrap).focus();
  }
  async function hideRun(kind, btn) {
    var st = roomSt;
    var body = { id: st.id };
    if (kind === 'last') body.last = Number($('r-hide-last').value);
    else body.user_id = $('r-hide-who').value;
    addBusy(btn, true);
    try {
      var res = await api('/panel/api/bot-room/hide', body);
      if (st !== roomSt) return;
      st.hide = { job: res.job, id: st.id, timer: null };
      hideReset(kind, false);
      renderHideControls();
      setHideStatus('가리는 중입니다.');
      pollHide();
    } catch (e) {
      if (authFail(e)) { showLogin(e); return; }
      if (st !== roomSt) return;
      hideReset(kind, true);
      setHideStatus(e.message, true);
    }
  }
  async function pollHide() {
    var h = roomSt.hide;
    if (!h || h.id !== roomSt.id) return;
    try {
      var res = await api('/panel/api/bot-room/hide?id=' + h.id + '&job=' + encodeURIComponent(h.job));
      if (roomSt.hide !== h) return;
      if (res.state === 'done') {
        roomSt.hide = null;
        renderHideControls();
        setHideStatus('글 ' + res.done + '개를 가렸습니다.' + (res.failed ? ' (' + res.failed + '개는 가리지 못했습니다)' : ''));
        notify('가리기를 마쳤습니다.', roomName(curRoom()) + ' · ' + res.done + '개');
        return;
      }
      setHideStatus('가리는 중입니다 · ' + res.done + ' / ' + res.total + '개');
    } catch (e) {
      if (roomSt.hide !== h) return;
      if (authFail(e)) { showLogin(e); return; }
      if (e && e.status === 404) { roomSt.hide = null; renderHideControls(); setHideStatus('가리기 진행 상황을 확인하지 못했습니다. 조치 기록에서 결과를 확인해 주세요.', true); return; }
    }
    h.timer = setTimeout(pollHide, 1200);
  }

  // ── 다시 시도·내보내기 해제·랭킹 초기화 ─────────────────
  async function retryRoom(id, btn, fromPage) {
    var v = roomById(id);
    if (!v) return;
    var body = { id: v.id };
    if (fromPage) {
      say('room-retry-err', '');
      if (v.needs_passcode) {
        var pc = $('r-passcode').value.trim();
        if (!pc) { say('room-retry-err', '참여코드를 입력해 주세요.'); $('r-passcode').focus(); return; }
        if (pc.length > 20) { say('room-retry-err', '참여코드는 20자 이하로 입력해 주세요.'); $('r-passcode').focus(); return; }
        body.passcode = pc;
      }
    }
    addBusy(btn, true);
    try {
      var res = await api('/panel/api/bot-room/retry', body);
      if (fromPage) $('r-passcode').value = '';
      if (res.room) mergeRoom(res.room);
      notify('다시 시도합니다.', roomName(v) + ' · K bot이 다시 입장을 시도합니다.');
    } catch (e) {
      if (authFail(e)) { showLogin(e); return; }
      if (e && e.body && e.body.retry_after) {
        var nv2 = Object.assign({}, v, { retry_after: Number(e.body.retry_after) });
        mergeRoom(nv2);
      }
      if (fromPage) say('room-retry-err', e.message);
      else notify('다시 시도하지 못했습니다.', e.message, { kind: 'crit' });
      loadRooms();
    } finally {
      btn.classList.remove('busy');
      var cur = roomById(id);
      btn.disabled = !!(cur && Number(cur.retry_after) > Date.now());
      if (route === 'room') renderRoomPage();
    }
  }
  async function unkickPerson(btn) {
    var uid = btn.dataset.unkick;
    var nm = btn.dataset.name || '';
    var st = roomSt;
    addBusy(btn, true);
    try {
      await api('/panel/api/bot-room/unkick', { id: st.id, user_id: uid });
      notify('내보내기를 해제했습니다.', nm + ' · 다시 들어올 수 있습니다.');
      var tr = btn.closest('tr');
      if (tr) tr.remove();
      if (st === roomSt) loadRoomLogs();
    } catch (e) {
      if (authFail(e)) { showLogin(e); return; }
      notify('내보내기를 해제하지 못했습니다.', e.message, { kind: 'crit' });
      addBusy(btn, false);
    }
  }
  function rankAsk() {
    $('r-rank-act').innerHTML = '<span class="q">랭킹과 검 강화·몬스터 수집 기록을 초기화합니다.</span><button type="button" class="btn sm" data-rank-no>취소</button>' +
      '<button type="button" class="btn sm danger solid" data-rank-yes><span class="spin"></span><span class="lbl-idle">초기화</span></button>';
    qs('[data-rank-no]', $('r-rank-act')).focus();
  }
  function rankReset(focus) {
    $('r-rank-act').innerHTML = '<button type="button" class="btn sm ghost danger" id="r-rank-reset">' + ic('trash', 12) + '랭킹 초기화</button>';
    renderRankTable();
    if (focus) $('r-rank-reset').focus();
  }
  async function rankRun(btn) {
    var st = roomSt;
    addBusy(btn, true);
    try {
      await api('/panel/api/bot-room/games-reset', { id: st.id });
      if (st !== roomSt) return;
      st.ranking = [];
      rankReset(true);
      notify('랭킹을 초기화했습니다.', roomName(curRoom()));
    } catch (e) {
      if (authFail(e)) { showLogin(e); return; }
      notify('랭킹을 초기화하지 못했습니다.', e.message, { kind: 'crit' });
      rankReset(true);
    }
  }

  // ── 봇 옮기기·다시 설치 (무료, ACCOUNTS_V1 3.4.3) ─────────
  // 가능 여부·간격·까닭 문구는 서버 RoomView(can_move·move_after·move_note·can_reinstall·reinstall_after·reinstall_note·self_rule)를 그대로 쓴다.
  var NEED_LINK = { link_gone: 1, room_deleted: 1, not_group: 1, link_changed: 1 };
  var moveSt = { id: 0, link: '', same: false };
  var REINSTALL_BTN = '<button type="button" class="btn sm" id="r-reinstall-btn">' + ic('refresh', 12) + '다시 설치</button>';
  function needLink(v) { return !!(v && v.display === 'error' && NEED_LINK[v.error_code]); }
  function renderMove(v) {
    var grp = $('room-move-grp');
    grp.hidden = v.display === 'pending';
    if (moveSt.id !== v.id) {
      moveSt.id = v.id;
      $('r-move-link').value = '';
      moveReset(false);
      $('r-reinstall-act').innerHTML = REINSTALL_BTN;
    }
    if (grp.hidden) return;
    $('r-move-rule').textContent = v.self_rule || '';
    var now = Date.now();
    var rWait = Number(v.reinstall_after) > now;
    var rText = !v.can_reinstall || rWait ? (v.reinstall_note || '') : '';
    $('r-reinstall-note').textContent = rText;
    $('r-reinstall-note').hidden = !rText;
    var rb = $('r-reinstall-btn');
    if (rb && !rb.classList.contains('busy')) rb.disabled = !v.can_reinstall || rWait;
    if (!rb && (!v.can_reinstall || rWait) && !qs('[data-reinstall-yes].busy')) $('r-reinstall-act').innerHTML = REINSTALL_BTN;
    // 옮기기 간격 안이어도 같은 방의 새 링크는 받는다(서버가 링크를 확인한 뒤 가른다). 그래서 입력은 막지 않고 까닭만 보인다.
    var mText = !v.can_move || Number(v.move_after) > now ? (v.move_note || '') : '';
    $('r-move-note').textContent = mText;
    $('r-move-note').hidden = !mText;
    var lock = !v.can_move;
    $('r-move-link').disabled = lock;
    var mc = $('r-move-check');
    if (!mc.classList.contains('busy')) mc.disabled = lock || !$('r-move-pv').hidden;
    if (lock && !$('r-move-pv').hidden) moveReset(false);
  }
  function moveReset(focus) {
    moveSt.link = '';
    moveSt.same = false;
    $('r-move-pv').hidden = true;
    $('r-move-link').readOnly = false;
    $('r-move-passcode').value = '';
    var v = curRoom();
    var mc = $('r-move-check');
    mc.classList.remove('busy');
    mc.disabled = !(v && v.can_move);
    say('r-move-err', '');
    if (focus) $('r-move-link').focus();
  }
  async function moveCheck() {
    var v = curRoom();
    if (!v || !v.can_move) return;
    var inp = $('r-move-link');
    var text = inp.value.trim();
    say('r-move-err', '');
    if (!text) { say('r-move-err', '옮길 오픈채팅방 링크를 입력해 주세요.'); inp.focus(); return; }
    var btn = $('r-move-check');
    addBusy(btn, true);
    var ok = false;
    try {
      var pv = await api('/api/room-preview', { link: text });
      if (!curRoom() || curRoom().id !== v.id) return;
      ok = showMovePv(curRoom(), text, pv);
    } catch (e) {
      if (authFail(e)) { showLogin(e); return; }
      say('r-move-err', e.message);
    } finally {
      btn.classList.remove('busy');
      btn.disabled = ok || !(curRoom() && curRoom().can_move);
    }
  }
  // 미리 보기 결과 → 확인 칸. 옮길 수 없는 방이면 까닭을 보이고 false.
  function showMovePv(v, text, pv) {
    if (!pv.verified) { say('r-move-err', '지금은 링크를 확인할 수 없습니다. 잠시 뒤 다시 시도해 주세요.'); return false; }
    var mine = pv.mine;
    var same = !!(mine && Number(mine.install_id) === v.id);
    if (mine && !same) {
      say('r-move-err', mine.display === 'pending' ? '이미 입금 대기 중인 주문에 들어 있는 방입니다. 내 계정의 구매 내역에서 확인해 주세요.'
        : '이 방에는 이미 내 K bot이 있습니다. 두 방을 합치려면 문의해 주세요.');
      return false;
    }
    if (!same && Number(v.move_after) > Date.now()) { say('r-move-err', v.move_note); return false; }
    var name = (pv.room && pv.room.name) || '';
    moveSt.link = text;
    moveSt.same = same;
    $('r-move-q').textContent = same
      ? '지금 방과 같은 방입니다. 이 링크로 바꾸고 K bot이 같은 방에 다시 들어갑니다.'
      : (name ? '「' + name + '」 방으로' : '이 방으로') + ' 옮깁니다. K bot은 지금 방에서 나갑니다.' +
        (v.products && v.products.roombot ? ' 새 방에서 K bot을 부방장으로 다시 지정해야 방 관리 기능이 동작합니다.' : '');
    $('r-move-yes-t').textContent = same ? '다시 설치' : '옮기기';
    var needPc = !!(pv.room && pv.room.needs_passcode);
    $('r-move-pc-wrap').hidden = !needPc;
    $('r-move-passcode').value = '';
    $('r-move-link').readOnly = true;
    $('r-move-pv').hidden = false;
    (needPc ? $('r-move-passcode') : $('r-move-no')).focus();
    return true;
  }
  async function moveRun(btn) {
    var v = curRoom();
    if (!v || !moveSt.link) return;
    var body = { id: v.id, link: moveSt.link };
    if (!$('r-move-pc-wrap').hidden) {
      var pc = $('r-move-passcode').value.trim();
      if (!pc) { say('r-move-err', '참여코드를 입력해 주세요.'); $('r-move-passcode').focus(); return; }
      if (pc.length > 20) { say('r-move-err', '참여코드는 20자 이하로 입력해 주세요.'); $('r-move-passcode').focus(); return; }
      body.passcode = pc;
    }
    say('r-move-err', '');
    addBusy(btn, true);
    try {
      var res = await api('/panel/api/bot-room/move', body);
      $('r-move-link').value = '';
      moveReset(false);
      if (res.room) mergeRoom(res.room);
      var nm = roomName(res.room || v);
      if (res.same_room) notify('같은 방에 다시 설치합니다.', nm + ' · K bot이 새 링크로 방에 들어가 상태를 다시 확인합니다.');
      else if (res.held) notify('K bot을 옮깁니다.', nm + ' · 관리자가 확인한 뒤 K bot이 들어갑니다.');
      else notify('K bot을 옮깁니다.', nm + ' · K bot이 지금 방에서 나가고 새 방에 들어갑니다.');
      if (route === 'room') { renderRoomPage(); $('room-title').focus({ preventScroll: true }); }
    } catch (e) {
      if (authFail(e)) { showLogin(e); return; }
      say('r-move-err', e.message);
      if (e.body && e.body.retry_after) loadRooms();
    } finally {
      btn.classList.remove('busy');
      btn.disabled = false;
    }
  }
  function reinstallAsk() {
    var v = curRoom();
    if (!v || !v.can_reinstall || Number(v.reinstall_after) > Date.now()) return;
    var pc = v.needs_passcode
      ? '<span class="pc"><label class="sr" for="r-reinstall-pc">참여코드</label><input class="inp" id="r-reinstall-pc" type="text" maxlength="20" autocomplete="off" spellcheck="false" placeholder="참여코드"></span>' : '';
    $('r-reinstall-act').innerHTML = '<span class="q">K bot이 같은 방에 다시 들어갑니다.</span>' + pc +
      '<button type="button" class="btn sm" data-reinstall-no>취소</button>' +
      '<button type="button" class="btn sm primary" data-reinstall-yes><span class="spin"></span><span class="lbl-idle">다시 설치</span></button>';
    (v.needs_passcode ? $('r-reinstall-pc') : qs('[data-reinstall-no]')).focus();
  }
  function reinstallReset(focus) {
    $('r-reinstall-act').innerHTML = REINSTALL_BTN;
    var v = curRoom();
    if (v && route === 'room') renderMove(v);
    if (focus && !$('r-reinstall-btn').disabled) $('r-reinstall-btn').focus();
  }
  async function reinstallRun(btn) {
    var v = curRoom();
    if (!v) return;
    var body = { id: v.id };
    var pcIn = $('r-reinstall-pc');
    if (pcIn) {
      var pc = pcIn.value.trim();
      if (!pc) { notify('참여코드를 입력해 주세요.', '참여코드가 필요한 방입니다.', { kind: 'warn' }); pcIn.focus(); return; }
      if (pc.length > 20) { notify('참여코드는 20자 이하로 입력해 주세요.', '', { kind: 'warn' }); pcIn.focus(); return; }
      body.passcode = pc;
    }
    addBusy(btn, true);
    try {
      var res = await api('/panel/api/bot-room/reinstall', body);
      if (res.room) mergeRoom(res.room);
      reinstallReset(false);
      notify('같은 방에 다시 설치합니다.', roomName(res.room || v) + ' · K bot이 방에 들어가 상태를 다시 확인합니다.');
    } catch (e) {
      if (authFail(e)) { showLogin(e); return; }
      notify('다시 설치하지 못했습니다.', e.message, { kind: 'crit' });
      reinstallReset(true);
      if (e.body && e.body.retry_after) loadRooms();
    }
  }

  // ── 팔레트 (4.3) ──────────────────────────────────────────
  var PAL = [
    { g: '이동', t: '개요', icon: 'overview', go: 'overview', k: 'G O' },
    { g: '이동', t: '받은 갠톡', kw: '받은함 주요 알림 1:1 대화', icon: 'inbox', go: 'inbox', k: 'G I' },
    { g: '이동', t: '카카오 계정', kw: '계정', icon: 'accounts', go: 'accounts', k: 'G A' },
    { g: '이동', t: '내 방', kw: '방 관리봇 미니게임봇 설치', icon: 'link', go: 'rooms', k: 'G B' },
    { g: '이동', t: '매크로', icon: 'macro', go: 'macro', k: 'G M' },
    { g: '이동', t: '입장·퇴장 기록', icon: 'visit', go: 'visit', k: 'G V', legacy: 1 },
    { g: '이동', t: '프로필 기록', icon: 'profile', go: 'profile', k: 'G P', legacy: 1 },
    { g: '이동', t: '올킥 감지', icon: 'guard', go: 'guard', k: 'G K', legacy: 1 },
    { g: '이동', t: '금지어 검열', icon: 'cover', go: 'cover', k: 'G C', legacy: 1 },
    { g: '이동', t: '갠톡 응답', icon: 'reply', go: 'reply', k: 'G R' },
    { g: '이동', t: '저격 규칙', icon: 'snipe', go: 'snipe', k: 'G S' },
    { g: '설정', t: '메시지', sub: '매크로', icon: 'macro', go: 'macro', focus: 'macro-message' },
    { g: '설정', t: '기본 간격', sub: '매크로', icon: 'macro', go: 'macro', focus: 'base-min', top: 1 },
    { g: '설정', t: '방별 간격', sub: '매크로', icon: 'macro', go: 'macro', focus: 'row-macro-rooms' },
    { g: '설정', t: '이미지', sub: '매크로', icon: 'macro', go: 'macro', focus: 'row-macro-img' },
    { g: '설정', t: '기록할 대화방', sub: '입장·퇴장 기록', icon: 'visit', go: 'visit', focus: 'row-visit-rooms', legacy: 1 },
    { g: '설정', t: '방에 보내는 안내', sub: '입장·퇴장 기록', icon: 'visit', go: 'visit', focus: 'row-visit-notice', legacy: 1 },
    { g: '설정', t: '프로필 변경 감지', sub: '프로필 기록', icon: 'profile', go: 'profile', focus: 'row-profile-on', legacy: 1 },
    { g: '설정', t: '감지 시간과 내보낸 인원', sub: '올킥 감지', icon: 'guard', go: 'guard', focus: 'guard-secs', top: 1, legacy: 1 },
    { g: '설정', t: '추가 금지어', sub: '금지어 검열', icon: 'cover', go: 'cover', focus: 'cover-word-in', top: 1, legacy: 1 },
    { g: '설정', t: '링크 가리기', sub: '금지어 검열', icon: 'cover', go: 'cover', focus: 'row-cover-links', legacy: 1 },
    { g: '설정', t: '응답 메시지', sub: '갠톡 응답', icon: 'reply', go: 'reply', focus: 'reply-message' },
    { g: '설정', t: '쿨타임', sub: '갠톡 응답', icon: 'reply', go: 'reply', focus: 'reply-hours' },
    { g: '작업', t: '카카오 계정 추가', icon: 'plus', go: 'account-add' },
    { g: '작업', t: '봇 구매', sub: '방 관리봇 · 미니게임봇', icon: 'plus', href: '/buy?p=roombot' },
    { g: '작업', t: '저격 규칙 추가', icon: 'plus', go: 'snipe', then: 'add-trigger' },
    { g: '작업', t: '구매 페이지', icon: 'receipt', href: '/buy' },
  ];
  // 고른 방의 설정 화면(방 설정 묶음) — 방을 고른 뒤에만
  var ROOM_PAL = [
    { t: '방 상태', r: 'room', icon: 'overview' },
    { t: '입장·퇴장 기록', r: 'r-visit', icon: 'visit', kw: '들낙 감지 나간 사람 재입장 차단 제외 대상' },
    { t: '프로필 기록', r: 'r-profile', icon: 'profile' },
    { t: '홍보 금지', r: 'r-promo', icon: 'alert' },
    { t: '글 가리기·금지어 검열', r: 'r-cover', icon: 'cover' },
    { t: '올킥 감지', r: 'r-guard', icon: 'guard' },
    { t: '미니게임', r: 'r-games', icon: 'game', kw: '랭킹' },
  ];
  var palIdx = 0;
  var palItems = [];
  var palReturn = null;
  function palData() {
    var legacy = legacyOn();
    var out = PAL.filter(function (it) { return !it.legacy || legacy; });
    var cur = curRoom();
    if (cur) {
      var nm = roomName(cur);
      ROOM_PAL.forEach(function (it) { out.push({ g: '방 설정', t: it.t, sub: nm, kw: it.kw || '', icon: it.icon, go: it.r, arg: String(cur.id) }); });
    }
    rooms.forEach(function (v) {
      out.push({ g: '방 열기', t: roomName(v), kw: linkText(v.link_url), sub2: v.label, icon: 'link', go: 'room', arg: String(v.id) });
    });
    return out.concat(meAccounts().map(function (r) { return { g: '계정 전환', t: r.email, sub2: stateLabel(stateOf(r.device_id)), icon: 'accounts', acct: r.device_id }; }));
  }
  function palPaintAct() {
    qsa('.pal-i').forEach(function (b, i) { b.classList.toggle('act', i === palIdx); b.setAttribute('aria-selected', i === palIdx ? 'true' : 'false'); });
    $('palIn').setAttribute('aria-activedescendant', palItems.length ? 'pi' + palIdx : '');
  }
  function palRender() {
    var q = $('palIn').value.trim().toLowerCase();
    palItems = palData().filter(function (it) { return !q || (it.t + ' ' + (it.sub || '') + ' ' + it.g + ' ' + (it.kw || '')).toLowerCase().indexOf(q) >= 0; });
    if (!q) palItems = palItems.filter(function (it) { return (it.g !== '설정' || it.top) && it.g !== '방 열기'; });
    palIdx = clamp(palIdx, 0, Math.max(0, palItems.length - 1));
    var g = '';
    var html = '';
    palItems.forEach(function (it, i) {
      if (it.g !== g) { g = it.g; html += '<p class="pal-cap" role="presentation">' + g + '</p>'; }
      var here = it.go && it.go === route && (!it.arg || it.arg === routeArg) && !it.focus && !it.then;
      var hint = here ? '현재 화면' : it.acct ? (it.acct === curId ? '선택됨' : esc(it.sub2)) : it.sub2 ? esc(it.sub2) : it.k ? '<kbd>' + it.k + '</kbd>' : '';
      html += '<button type="button" class="pal-i' + (i === palIdx ? ' act' : '') + '" role="option" aria-selected="' + (i === palIdx) + '" data-pi="' + i + '" id="pi' + i + '" tabindex="-1">' + ic(it.icon, 15) +
        '<span class="grow">' + (it.sub ? '<em>' + esc(it.sub) + ' / </em>' : '') + esc(it.t) + '</span>' + (hint ? '<span class="hint">' + hint + '</span>' : '') + '</button>';
    });
    $('palList').innerHTML = html || '<p class="pal-empty">일치하는 화면이나 설정이 없습니다.</p>';
    $('palIn').setAttribute('aria-activedescendant', palItems.length ? 'pi' + palIdx : '');
  }
  function palOpen() {
    if (!me || app.hidden) return;
    palReturn = document.activeElement;
    drawer(false);
    openMenu(false);
    var w = $('palWrap');
    w.classList.remove('closed');
    w.setAttribute('aria-hidden', 'false');
    $('palIn').value = '';
    palIdx = 0;
    palRender();
    $('palIn').focus();                      // 바로 옮겨야 이어서 친 글자가 이전 입력칸으로 새지 않는다
    setTimeout(function () {
      // 빨리 Enter 를 눌러 이미 닫혔으면 이동한 곳의 포커스를 빼앗지 않는다
      if (!$('palWrap').classList.contains('closed') && document.activeElement !== $('palIn')) $('palIn').focus();
    }, 10);
  }
  function palClose(noReturn) {
    var w = $('palWrap');
    if (w.classList.contains('closed')) return;
    w.classList.add('closed');
    w.setAttribute('aria-hidden', 'true');
    if (!noReturn && palReturn && palReturn.focus) palReturn.focus({ preventScroll: true });
  }
  function palRun(i) {
    var it = palItems[i];
    if (!it) return;
    palClose(true);
    if (it.href) { location.href = it.href; return; }
    if (it.acct) {
      var back = palReturn && palReturn !== document.body && document.contains(palReturn) ? palReturn : $('acctBtn');
      back.focus({ preventScroll: true });
      switchAccount(it.acct);
      return;
    }
    if (it.go === route && (!it.arg || it.arg === routeArg)) {
      if (it.focus) focusSetting(it.focus);
      if (it.then) $(it.then).click();
      return;
    }
    goRoute({ route: it.go, arg: it.arg, focus: it.focus, then: it.then });
  }
  // 이동 + (선택) 그 화면의 설정으로 포커스·후속 클릭. 떠나기 확인이 걸리면 이 대상이 그대로 남았다가 버리기·저장 뒤에 실행된다.
  function goRoute(t) {
    var targ = t.arg || '';
    var same = t.route === route && (!targ || targ === routeArg);
    if (dirtyN > 0 && route && !same) { pendingFocus = null; askLeave(t); return; }
    pendingFocus = t.focus || null;
    if (t.then) {
      var then = t.then;
      setTimeout(function () { if (route === t.route) $(then).click(); }, reducedMotion() ? 0 : 320);
    }
    var want = '#' + t.route + (targ ? '/' + targ : '');
    if (same && location.hash === '#' + curHash()) {
      // 이미 그 화면이면 해시가 바뀌지 않아 hashchange 가 오지 않는다 — 포커스 요청만 처리
      if (pendingFocus) { var pf = pendingFocus; pendingFocus = null; focusSetting(pf); }
      return;
    }
    location.hash = want;
  }
  function focusSetting(id) {
    var target = $(id);
    // 다른(숨은) 화면의 칸이면 무시한다 — 남은 포커스 요청이 엉뚱한 화면에서 경고를 내지 않게
    if (!target || !curPage || !curPage.contains(target)) return;
    var row = target.closest('.srow') || target;
    var dp = row.closest('.dep[data-open="false"]');
    if (dp) {
      var swId = ROUTES[route] && ROUTES[route].sw;
      var sw = swId && $(swId);
      if (sw) {
        row = sw.closest('.srow');
        target = sw;
        notify(iga(routeTitle(route)) + ' 꺼져 있습니다.', '기능을 켜면 이 설정이 나타납니다. 켜기 스위치로 이동했습니다.', { kind: 'warn' });
      }
    }
    row.scrollIntoView({ block: 'center', behavior: reducedMotion() ? 'auto' : 'smooth' });
    row.classList.remove('flash');
    void row.offsetWidth;
    row.classList.add('flash');
    var f = target.matches('input,textarea,button,select') ? target : target.querySelector('input:not([type="file"]),textarea,button,select');
    if (f) f.focus({ preventScroll: true });
  }

  // ── 세그먼트 표시 ─────────────────────────────────────────
  function segInd(seg, instant) {
    if (!seg) return;
    var ind = qs('.seg-ind', seg);
    var b = qs('button[aria-pressed="true"]', seg);
    if (!ind || !b || !b.offsetWidth) return;
    if (instant || reducedMotion()) ind.style.transition = 'none';
    ind.style.width = b.offsetWidth + 'px';
    ind.style.transform = 'translateX(' + (b.offsetLeft - 3) + 'px)';
    if (instant || reducedMotion()) { void ind.offsetWidth; ind.style.transition = ''; }
  }

  // ── 숫자 칸 ───────────────────────────────────────────────
  function fixNum(inp) {
    var min = Number(inp.dataset.min);
    var max = Number(inp.dataset.max);
    var step = Number(inp.dataset.stepby) || 1;
    var raw = String(inp.value).replace(/[^0-9]/g, '');
    if (raw === '') { if (inp.dataset.empty) { inp.value = ''; return; } inp.value = String(min); return; }
    var v = clamp(parseInt(raw, 10), min, max);
    if (step > 1) v = clamp(Math.round(v / step) * step, min, max);
    inp.value = String(v);
  }

  // ═════════════════════════════ 리스너 ═════════════════════════════
  // 로그인
  // 회원 로그인(6.9) — /api/auth/login 을 부른다. 라이선스 키(KAKA-)는 로그인에 쓰지 않는다.
  function loginErr(text, field) {
    say('login-error', text);
    ['login-id', 'login-pw'].forEach(function (id) { $(id).classList.toggle('err', id === field); });
    if (field) $(field).focus();
  }
  $('login-form').addEventListener('submit', async function (ev) {
    ev.preventDefault();
    loginErr('', null);
    var btn = $('loginBtn');
    var id = $('login-id').value.trim();
    var pw = $('login-pw').value;
    if (/^KAKA-/i.test(id)) { loginErr('라이선스 키로는 로그인할 수 없습니다. 아이디로 로그인하거나 회원가입해 주세요.', 'login-id'); return; }
    if (!id) { loginErr('아이디를 입력해 주세요.', 'login-id'); return; }
    if (!pw) { loginErr('비밀번호를 입력해 주세요.', 'login-pw'); return; }
    addBusy(btn, true);
    try {
      await api('/api/auth/login', { login_id: id, password: pw });
      $('login-pw').value = '';
      try { if (window.kbSupport && window.kbSupport.reboot) window.kbSupport.reboot(); } catch (e) { /* 콘솔은 상담 SDK 가 없다 */ }
      await refreshMe();
    } catch (e) {
      var r = e && e.body ? e.body.reason : '';
      var text = r === 'locked' && e.body.retry_after
        ? '로그인 실패 횟수를 초과했습니다. ' + Math.max(1, Math.ceil(Number(e.body.retry_after) / 60)) + '분 후 다시 시도해 주세요.'
        : (e && e.message) || '로그인하지 못했습니다. 잠시 뒤 다시 시도해 주세요.';
      loginErr(text, r === 'bad_credentials' ? 'login-pw' : null);
    } finally {
      addBusy(btn, false);
    }
  });
  $('login-id').addEventListener('input', function () { this.classList.remove('err'); });
  $('login-pw').addEventListener('input', function () { this.classList.remove('err'); });

  async function doLogout() {
    try { await api('/api/auth/logout', {}); } catch (e) { /* 세션이 이미 끝났어도 로그인 화면으로 */ }
    try { if (window.kbSupport && window.kbSupport.reboot) window.kbSupport.reboot(); } catch (e) { /* 없음 */ }
    me = null;
    account = null;
    curId = '';
    rooms = [];
    roomSeen = {};
    resetRoom(0);
    resetLogs();
    showLogin();
  }
  logout.addEventListener('click', function () {
    if (dirtyN > 0) { askLeave({ logout: true }); return; }
    doLogout();
  });

  // 해시 라우트
  window.addEventListener('hashchange', onHash);
  window.addEventListener('beforeunload', function (e) {
    if (dirtyN > 0) { e.preventDefault(); e.returnValue = ''; }
  });
  window.addEventListener('resize', function () {
    if (app.hidden) return;
    // 서랍을 연 채 960px 위로 넓어지면 서랍 버튼·덮개가 사라지므로 닫아서 본문 inert 를 푼다
    if (app.classList.contains('nav-open') && !window.matchMedia('(max-width: 960px)').matches) drawer(false);
    navInd(true);
    segInd($('visit-type'), true);
    if (curPage && isRoomRoute(route)) segInds(curPage);
  });
  // 건너뛰기: 포커스만 옮기고 해시는 바꾸지 않는다(열린 대화를 닫지 않는다)
  $('skipLink').addEventListener('click', function (e) {
    e.preventDefault();
    var t = app.hidden ? $('login-id') : viewEl;
    if (t) t.focus();
  });

  // 사이드바·서랍·메뉴
  $('menuBtn').addEventListener('click', function () { drawer(!app.classList.contains('nav-open')); });
  $('scrim').addEventListener('click', function () { drawer(false); });
  $('nav').addEventListener('click', function (e) {
    var a = e.target.closest('.nav-a');
    if (!a) return;
    if (a.getAttribute('aria-disabled') === 'true') {
      e.preventDefault();
      goRegister();
    }
    drawer(false);
  });
  $('acctBtn').addEventListener('click', function (e) { e.stopPropagation(); openMenu($('acctMenu').classList.contains('closed')); });
  $('acctMenu').addEventListener('click', function (e) {
    var s = e.target.closest('[data-switch]');
    if (s) {
      openMenu(false);
      $('acctBtn').focus({ preventScroll: true });   // 메뉴가 다시 그려져도 포커스가 body 로 떨어지지 않게
      switchAccount(s.dataset.switch);
      return;
    }
    if (e.target.closest('a')) openMenu(false);
  });
  $('acctMenu').addEventListener('keydown', function (e) {
    var items = qsa('.menu-i', $('acctMenu'));
    var i = items.indexOf(document.activeElement);
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); items[(i + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length].focus(); }
    if (e.key === 'Escape') { e.stopPropagation(); openMenu(false); $('acctBtn').focus(); }
    if (e.key === 'Tab') {
      // 닫히는 메뉴 안으로 포커스가 넘어가 body 로 떨어지지 않게 직접 옮긴다
      e.preventDefault();
      openMenu(false);
      var nx = e.shiftKey ? null : $('openPal');
      (nx && nx.getClientRects().length ? nx : $('acctBtn')).focus();
    }
  });
  document.addEventListener('click', function (e) { if (!e.target.closest('.acct-wrap')) openMenu(false); });
  $('kbdHint').textContent = isMac ? '⌘ K' : 'Ctrl K';
  $('saveKbd').textContent = isMac ? '⌘ S' : 'Ctrl S';

  // 재등록·계정 추가 링크는 어디서 눌러도 같은 길로 간다
  document.addEventListener('click', function (e) {
    var reg = e.target.closest('[data-reg]');
    if (reg) {
      e.preventDefault();
      var id = reg.dataset.reg;
      startReauth(id, ((meAcc(id) || accOf(id)) || {}).email || '');
      return;
    }
    var add = e.target.closest('a[href="#account-add"]');
    if (add && macroOk() && meAccounts().length >= maxAcc()) {
      e.preventDefault();
      notify('카카오 계정은 ' + maxAcc() + '개까지 등록할 수 있습니다.', '쓰지 않는 계정의 등록을 해제한 뒤 다시 시도해 주세요.', { kind: 'warn' });
    }
  });

  // 저장 바
  $('saveRevert').addEventListener('click', function () { revertRoute('변경사항을 되돌렸습니다.'); });
  $('leaveStay').addEventListener('click', function () {
    leaveTarget = null;
    pendingFocus = null;
    saveEl.classList.remove('leave');
    paintSave();
    // 떠나기 버튼이 숨으면서 포커스가 body 로 떨어지지 않게, 안내가 뜨기 전 자리(없거나 안 보이면 저장 버튼)로 돌린다
    var back = leaveBack;
    leaveBack = null;
    var ok = back && back.isConnected && back.getClientRects().length > 0 && !back.closest('.closed, [inert], [hidden], [aria-hidden="true"]');
    if (ok) back.focus({ preventScroll: true });
    if (!ok || document.activeElement !== back) saveBtn.focus({ preventScroll: true });
  });
  $('leaveDrop').addEventListener('click', function () {
    var t = leaveTarget;
    leaveTarget = null;
    saveEl.classList.remove('leave');
    revertRoute('변경사항을 버렸습니다.');
    runLeave(t);
  });
  $('leaveSave').addEventListener('click', function () {
    if (!leaveTarget) return;
    leaveTarget.saving = true;
    var f = $(formOf(route));
    if (f) f.requestSubmit();
  });

  // 팔레트
  $('palIn').addEventListener('input', function () { palIdx = 0; palRender(); });
  $('palIn').addEventListener('keydown', function (e) {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      palIdx = clamp(palIdx + (e.key === 'ArrowDown' ? 1 : -1), 0, Math.max(0, palItems.length - 1));
      palPaintAct();
      var a = qs('.pal-i.act');
      if (a) a.scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'Enter') {
      if (e.isComposing) return;
      e.preventDefault();
      palRun(palIdx);
    } else if (e.key === 'Tab') e.preventDefault();
  });
  $('palList').addEventListener('click', function (e) { var b = e.target.closest('[data-pi]'); if (b) palRun(Number(b.dataset.pi)); });
  $('palList').addEventListener('mousemove', function (e) {
    var b = e.target.closest('[data-pi]');
    if (!b || Number(b.dataset.pi) === palIdx) return;
    palIdx = Number(b.dataset.pi);
    palPaintAct();
  });
  $('palWrap').addEventListener('click', function (e) { if (e.target.id === 'palWrap') palClose(); });
  $('openPal').addEventListener('click', palOpen);
  $('topSearch').addEventListener('click', palOpen);

  // 전역 단축키: Ctrl/⌘K 팔레트, Ctrl/⌘S 저장, G 다음 글자 이동, Esc 닫기, 주요 알림 / 검색·Alt+↑↓
  var gArmed = 0;
  document.addEventListener('keydown', function (ev) {
    if (!me || app.hidden) return;
    var t = ev.target;
    var inInput = !!(t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable));
    var palOpenNow = !$('palWrap').classList.contains('closed');
    if ((ev.ctrlKey || ev.metaKey) && !ev.altKey && (ev.key === 'k' || ev.key === 'K')) {
      ev.preventDefault();
      if (palOpenNow) palClose(); else palOpen();
      return;
    }
    if ((ev.ctrlKey || ev.metaKey) && !ev.altKey && (ev.key === 's' || ev.key === 'S')) {
      ev.preventDefault();
      if (dirtyN > 0) { var f = $(formOf(route)); if (f) f.requestSubmit(); }
      return;
    }
    if (ev.key === 'Escape') {
      if (palOpenNow) { palClose(); return; }
      if (app.classList.contains('nav-open')) { drawer(false); $('menuBtn').focus(); return; }
      if (!$('acctMenu').classList.contains('closed')) { openMenu(false); $('acctBtn').focus(); return; }
      if (saveEl.classList.contains('leave')) { $('leaveStay').click(); return; }
    }
    if (route === 'inbox' && !palOpenNow) {
      if (ev.key === '/' && !inInput && !ev.ctrlKey && !ev.metaKey && !ev.altKey) {
        ev.preventDefault();
        chatSearch.focus();
        chatSearch.select();
        return;
      }
      if (ev.altKey && (ev.key === 'ArrowDown' || ev.key === 'ArrowUp')) {
        ev.preventDefault();
        stepConversation(ev.key === 'ArrowDown' ? 1 : -1);
        return;
      }
    }
    if (inInput || ev.metaKey || ev.ctrlKey || ev.altKey || ev.isComposing || palOpenNow) return;
    var key = (ev.key || '').toLowerCase();
    if (key === 'g') { gArmed = Date.now(); return; }
    if (gArmed && Date.now() - gArmed < 1000 && GKEYS[key]) {
      ev.preventDefault();
      gArmed = 0;
      // 계정 단위 옛 기능의 단축키(G V·G P·G K·G C)는 유예 회원만(6.9)
      if (LEGACY_ROUTES[GKEYS[key]] && !legacyOn()) { notify(LEGACY_NOTE); return; }
      goRoute({ route: GKEYS[key] });
      return;
    }
    gArmed = 0;
  });

  // ── 콘솔 본문 위임: 클릭 ──────────────────────────────────
  viewEl.addEventListener('click', function (e) {
    var t = e.target;
    var step = t.closest('.num > button[data-step]');
    if (step) {
      var inp = step.parentNode.querySelector('input');
      var cur = parseInt(String(inp.value).replace(/[^0-9]/g, ''), 10);
      if (isNaN(cur)) cur = Number(inp.dataset.min);
      var nv = clamp(cur + Number(step.dataset.step) * (Number(inp.dataset.stepby) || 1), Number(inp.dataset.min), Number(inp.dataset.max));
      inp.value = String(nv);
      inp.dispatchEvent(new Event('input', { bubbles: true }));
      return;
    }
    // ── 내 방 (6.9) ──
    var sgb = t.closest('.seg[id^="r-"] button[data-v]');
    if (sgb) {
      var sg = sgb.parentNode;
      qsa('button[data-v]', sg).forEach(function (x) { x.setAttribute('aria-pressed', x === sgb ? 'true' : 'false'); });
      segInd(sg);
      if (isRoomRoute(route)) roomPreviews(route);
      markDirty();
      return;
    }
    var rowRoom = t.closest('tr[data-room]');
    if (rowRoom && !t.closest('a,button')) { location.hash = '#room/' + rowRoom.dataset.room; return; }
    var goRoom = t.closest('[data-room-go]');
    if (goRoom && !t.closest('a')) { location.hash = '#room/' + goRoom.dataset.roomGo; return; }
    var fl = t.closest('a[data-focus]');
    if (fl) {
      var want = (fl.getAttribute('href') || '').replace(/^#/, '');
      if (want === curHash()) { e.preventDefault(); focusSetting(fl.dataset.focus); }
      else pendingFocus = fl.dataset.focus;
      return;
    }
    var rt = t.closest('[data-retry]');
    if (rt) { retryRoom(Number(rt.dataset.retry), rt, false); return; }
    if (t.closest('#room-retry')) { retryRoom(roomSt.id, $('room-retry'), true); return; }
    var exd = t.closest('[data-exdel]');
    if (exd) {
      var uid = exd.dataset.exdel;
      exemptList = exemptList.filter(function (x) { return x.user_id !== uid; });
      renderExempt();
      markDirty();
      $('r-exempt-pick').focus();
      return;
    }
    var rwd = t.closest('[data-rwdel]');
    if (rwd) {
      var rchip = rwd.parentNode;
      if (rchip.classList.contains('bye')) return;
      var rword = rcWords[Number(rwd.dataset.rwdel)];
      rchip.classList.add('bye');
      setTimeout(function () {
        var k = rcWords.indexOf(rword);
        if (k >= 0) rcWords.splice(k, 1);
        renderRcWords(); markDirty(); $('r-cover-word-in').focus();
      }, reducedMotion() ? 0 : 200);
      return;
    }
    if (t.id === 'r-cover-words') { $('r-cover-word-in').focus(); return; }
    var uk = t.closest('[data-unkick]');
    if (uk) { unkickPerson(uk); return; }
    if (t.closest('#r-hide-last-btn')) { hideAsk('last'); return; }
    if (t.closest('#r-hide-who-btn')) { hideAsk('who'); return; }
    var hn = t.closest('[data-hide-no]');
    if (hn) { hideReset(hn.dataset.hideNo, true); return; }
    var hy = t.closest('[data-hide-yes]');
    if (hy) { hideRun(hy.dataset.hideYes, hy); return; }
    if (t.closest('#r-rank-reset')) { rankAsk(); return; }
    if (t.closest('#r-reinstall-btn')) { reinstallAsk(); return; }
    if (t.closest('[data-reinstall-no]')) { reinstallReset(true); return; }
    var riy = t.closest('[data-reinstall-yes]');
    if (riy) { reinstallRun(riy); return; }
    if (t.closest('#r-move-no')) { moveReset(true); return; }
    var mvy = t.closest('#r-move-yes');
    if (mvy) { moveRun(mvy); return; }
    if (t.closest('#room-move-go')) { focusSetting('r-move-link'); return; }
    if (t.closest('[data-rank-no]')) { rankReset(true); return; }
    var ry = t.closest('[data-rank-yes]');
    if (ry) { rankRun(ry); return; }
    var on = t.closest('[data-turn-on]');
    if (on) {
      var sw = $(on.dataset.turnOn);
      if (sw && !sw.checked) { sw.checked = true; sw.dispatchEvent(new Event('change', { bubbles: true })); }
      setTimeout(function () {
        var dep = qs('[data-dep="' + on.dataset.turnOn + '"] .dep-in');
        var f = dep && dep.querySelector('input:not([type="file"]):not([type="checkbox"]),textarea,select,input[type="checkbox"]');
        if (f) f.focus({ preventScroll: true }); else if (sw) sw.focus({ preventScroll: true });
      }, reducedMotion() ? 0 : 60);
      return;
    }
    var cp = t.closest('[data-copy]');
    if (cp) { e.stopPropagation(); copyText(cp.dataset.copy); return; }
    var lr = t.closest('[data-load-rooms]');
    if (lr) { reloadRooms(lr); return; }
    if (t.closest('.swl, label.room')) return;   // 진짜 체크박스는 change 로 알린다
    var go = t.closest('[data-go]');
    if (go) { location.hash = '#' + go.dataset.go; return; }
    var ac = t.closest('[data-acct]');
    if (ac) { switchAccount(ac.dataset.acct); return; }
    var as = t.closest('[data-acct-set]');
    if (as) { switchAccount(as.dataset.acctSet, { quiet: true, then: function () { location.hash = '#macro'; } }); return; }
    var rx = t.closest('tr.rowx[data-x]');
    if (rx && !t.closest('button,a')) { toggleDetail(rx); return; }
    var ul = t.closest('[data-unlink]');
    if (ul) {
      var cr = qs('[data-confirm="' + CSS.escape(ul.dataset.unlink) + '"]');
      cr.classList.toggle('open');
      if (cr.classList.contains('open')) setTimeout(function () { qs('[data-unlink-no]', cr).focus(); }, reducedMotion() ? 0 : 200);
      return;
    }
    var un = t.closest('[data-unlink-no]');
    if (un) {
      qs('[data-confirm="' + CSS.escape(un.dataset.unlinkNo) + '"]').classList.remove('open');
      var back = qs('[data-unlink="' + CSS.escape(un.dataset.unlinkNo) + '"]');
      if (back) back.focus();
      return;
    }
    var uy = t.closest('[data-unlink-yes]');
    if (uy) { unlinkAccount(uy.dataset.unlinkYes, uy); return; }
    var idl = t.closest('[data-img-del]');
    if (idl) {
      if (idl.dataset.imgDel === 'saved') savedImages = 0;
      else images.splice(Number(idl.dataset.imgDel), 1);
      imagesDirty = true;
      renderThumbs();
      markDirty();
      var add = qs('#thumbs .img-add');
      if (add) add.focus();
      return;
    }
    var wd = t.closest('[data-wdel]');
    if (wd) {
      var chipEl = wd.parentNode;
      if (chipEl.classList.contains('bye')) return;   // 사라지는 중인 칩을 또 누르면 무시(다음 단어가 지워지지 않게)
      var word = coverWords[Number(wd.dataset.wdel)];
      chipEl.classList.add('bye');
      setTimeout(function () {
        var k = coverWords.indexOf(word);       // 번호가 아니라 값으로 지운다(먼저 지운 칩 때문에 번호가 밀려도 안전)
        if (k >= 0) coverWords.splice(k, 1);
        renderCoverChips(); markDirty(); $('cover-word-in').focus();
      }, reducedMotion() ? 0 : 200);
      return;
    }
    if (t.id === 'cover-words') { $('cover-word-in').focus(); return; }
    var tk = t.closest('[data-tok]');
    if (tk) {
      var ta = $('reply-message');
      var s = ta.selectionStart == null ? ta.value.length : ta.selectionStart;
      var en = ta.selectionEnd == null ? s : ta.selectionEnd;
      ta.value = ta.value.slice(0, s) + tk.dataset.tok + ta.value.slice(en);
      ta.focus();
      ta.selectionStart = ta.selectionEnd = s + tk.dataset.tok.length;
      ta.dispatchEvent(new Event('input', { bubbles: true }));
      return;
    }
    var da = t.closest('[data-del-ask]');
    if (da) {
      var w = da.parentNode;
      var di = w.dataset.del;
      w.innerHTML = '<span class="q">이 규칙을 삭제합니다.</span><button type="button" class="btn sm" data-del-no="' + di + '">취소</button><button type="button" class="btn sm danger solid" data-del-yes="' + di + '">삭제</button>';
      qs('[data-del-no]', w).focus();
      return;
    }
    var dn = t.closest('[data-del-no]');
    if (dn) {
      var w2 = dn.parentNode;
      w2.innerHTML = '<button type="button" class="btn sm ghost danger" data-del-ask="' + dn.dataset.delNo + '">' + ic('trash', 12) + '삭제</button>';
      w2.firstChild.focus();
      return;
    }
    var dy = t.closest('[data-del-yes]');
    if (dy) {
      var ri = Number(dy.dataset.delYes);
      triggers.splice(ri, 1);
      var nextOpen = {};
      Object.keys(openRules).forEach(function (k) { var n = Number(k); if (n < ri) nextOpen[n] = 1; else if (n > ri) nextOpen[n - 1] = 1; });
      openRules = nextOpen;
      renderTriggers();
      markDirty();
      $('add-trigger').focus();
      return;
    }
    var rh = t.closest('.rule-h');
    if (rh) {
      var rl = rh.parentNode;
      var idx = Number(rl.dataset.ri);
      rl.classList.toggle('open');
      var open = rl.classList.contains('open');
      rh.setAttribute('aria-expanded', open ? 'true' : 'false');
      if (open) openRules[idx] = 1; else delete openRules[idx];
    }
  });
  viewEl.addEventListener('keydown', function (e) {
    var t = e.target;
    if (t.id === 'r-cover-word-in') {
      if ((e.key === 'Enter' || e.key === ',') && !e.isComposing && e.keyCode !== 229) {
        e.preventDefault();
        if (t.value.trim()) { var rres = rcAddWords(t.value); if (rres !== 'long' && rres !== 'max') t.value = ''; }
        return;
      }
      if (e.key === 'Backspace' && !t.value && rcWords.length) { rcWords.pop(); renderRcWords(); markDirty(); return; }
    }
    if (e.key === 'Enter' && t.matches && t.matches('#r-move-passcode, #r-reinstall-pc') && !e.isComposing) {
      e.preventDefault();
      var yes = t.id === 'r-move-passcode' ? $('r-move-yes') : qs('[data-reinstall-yes]');
      if (yes && !yes.disabled) yes.click();
      return;
    }
    if (e.key === 'Escape' && t.closest && t.closest('#r-move-pv, #r-reinstall-act')) {
      if (t.closest('#r-move-pv')) moveReset(true); else reinstallReset(true);
      return;
    }
    if (e.key === 'Enter' && t.matches && t.matches('#r-hide-last, #r-passcode')) {
      e.preventDefault();
      if (t.id === 'r-hide-last') fixNum(t);
      else if (!$('room-retry').disabled) retryRoom(roomSt.id, $('room-retry'), true);
      return;
    }
    if ((e.key === 'Enter' || e.key === ' ') && t.matches && t.matches('tr[data-room]')) { e.preventDefault(); location.hash = '#room/' + t.dataset.room; return; }
    if (t.id === 'cover-word-in') {
      if ((e.key === 'Enter' || e.key === ',') && !e.isComposing && e.keyCode !== 229) {
        e.preventDefault();
        if (t.value.trim()) { var res = addWords(t.value); if (res !== 'long' && res !== 'max') t.value = ''; }
        return;
      }
      if (e.key === 'Backspace' && !t.value && coverWords.length) { coverWords.pop(); renderCoverChips(); markDirty(); return; }
    }
    if (e.key === 'Enter' && t.matches && t.matches('input[data-rule]')) { e.preventDefault(); return; }
    if (e.key === 'Enter' && t.matches && t.matches('#guard-secs, #guard-count, #base-min, #random-min, #reply-hours, input.cool')) fixNum(t);
    if ((e.key === 'Enter' || e.key === ' ') && t.matches && t.matches('label.img-add')) { e.preventDefault(); $('images').click(); return; }
    if (e.key !== 'Enter' && e.key !== ' ') return;
    if (t.matches('.feat[data-go]')) { e.preventDefault(); location.hash = '#' + t.dataset.go; }
    else if (t.matches('tr.rowx[data-x]')) { e.preventDefault(); toggleDetail(t); }
    else if (t.matches('.rule-h')) { e.preventDefault(); t.click(); }
  });
  viewEl.addEventListener('paste', function (e) {
    if (e.target.id !== 'cover-word-in' && e.target.id !== 'r-cover-word-in') return;
    var txt = (e.clipboardData || window.clipboardData).getData('text');
    if (/[,\n]/.test(txt)) { e.preventDefault(); if (e.target.id === 'r-cover-word-in') rcAddWords(txt); else addWords(txt); }
  });
  viewEl.addEventListener('input', function (e) {
    var t = e.target;
    if (t.dataset && t.dataset.rule !== undefined && t.dataset.f) {
      var i = Number(t.dataset.rule);
      var f = t.dataset.f;
      if (!triggers[i]) return;
      if (f === 'cooldown_sec') {
        var raw = String(t.value).replace(/[^0-9]/g, '');
        if (raw !== '') triggers[i].cooldown_sec = clamp(parseInt(raw, 10), 0, 86400);
      } else if (t.type !== 'checkbox' && t.tagName !== 'SELECT') triggers[i][f] = t.value;
      refreshRuleHead(i);
      markDirty();
      return;
    }
    if (t.id === 'macro-message') updateMacroCount();
    if (t.id === 'reply-message') updateReplyPreview();
    if (t.id === 'base-min' || t.id === 'random-min' || t.classList.contains('cool')) queueViz();
    if (t.id === 'guard-secs-range' || t.id === 'guard-count-range') {
      $(t.dataset.twin).value = t.value;
      rangeFill(t);
      renderGuardPreview(false);
    }
    if (t.id === 'guard-secs' || t.id === 'guard-count') renderGuardPreview(false);
    if (t.id === 'r-visit-q') return;
    if (t.id === 'r-move-link' || t.id === 'r-move-passcode' || t.id === 'r-reinstall-pc') { say('r-move-err', ''); return; }
    if (t.id === 'r-profile-q') return;
    if (isRoomRoute(route)) roomPreviews(route);
    markDirty();
  });
  viewEl.addEventListener('change', function (e) {
    var t = e.target;
    if (t.dataset && t.dataset.ov) { ovToggle(t.dataset.ov, t.checked, t, false); return; }
    if (t.id === 'r-exempt-pick') {
      var opt = t.options[t.selectedIndex];
      if (t.value) addExempt(t.value, opt ? opt.text.split(' · ')[0] : '');
      t.value = '';
      return;
    }
    if (t.id === 'r-hide-who') { setHideStatus(''); return; }
    if (t.dataset && t.dataset.rule !== undefined && t.dataset.f) {
      var i = Number(t.dataset.rule);
      if (!triggers[i]) return;
      if (t.type === 'checkbox') triggers[i][t.dataset.f] = t.checked;
      else triggers[i][t.dataset.f] = t.value;
      if (t.dataset.f === 'mode') { renderTriggers(); var m = $('tm' + i); if (m) m.focus(); }
      else refreshRuleHead(i);
      markDirty();
      return;
    }
    if (t.dataset && t.dataset.ruleRoom !== undefined) {
      var j = Number(t.dataset.ruleRoom);
      var cur = (triggers[j].rooms || []).slice();
      var k = t.dataset.key;
      if (t.checked && cur.indexOf(k) < 0) cur.push(k);
      if (!t.checked) cur = cur.filter(function (x) { return x !== k; });
      triggers[j].rooms = cur;
      refreshRuleHead(j);
      markDirty();
      return;
    }
    if (t.matches && t.matches('.swi[id]') && /-on$/.test(t.id)) {
      var open = t.checked;
      qsa('[data-dep="' + t.id + '"]').forEach(function (d) { d.dataset.open = open ? 'true' : 'false'; });
      qsa('[data-dep-off="' + t.id + '"]').forEach(function (d) { d.dataset.open = open ? 'false' : 'true'; });
      if (t.id === 'guard-on' && open) renderGuardPreview(true);
      if (t.id === 'macro-on' && open) renderViz();
    }
    if (t.type === 'checkbox' && t.closest('.room')) {
      if (t.closest('#rooms-open') && !t.checked) {
        var c = t.closest('.room').querySelector('input.cool');
        if (c) c.value = '';
      }
      roomsCount();
      if (t.closest('#rooms-open')) queueViz();
      if (t.closest('#visit-open') || t.closest('#profile-open')) updateNoticeWho();
    }
    if (isRoomRoute(route)) roomPreviews(route);
    markDirty();
  });
  viewEl.addEventListener('focusout', function (e) {
    var t = e.target;
    if (!t.matches) return;
    if (t.matches('.num input[data-min], input.cool')) {
      var before = t.value;
      if (t.dataset.rule !== undefined) {
        fixNum(t);
        var i = Number(t.dataset.rule);
        if (triggers[i]) { triggers[i].cooldown_sec = Number(t.value); refreshRuleHead(i); }
      } else fixNum(t);
      if (t.value !== before) {
        if (isRoomRoute(route)) roomPreviews(route);
        if (t.id === 'guard-secs' || t.id === 'guard-count') renderGuardPreview(false);
        if (t.id === 'base-min' || t.id === 'random-min' || t.classList.contains('cool')) queueViz();
        markDirty();
      }
    }
  });

  // 내 방 기록 검색·방 설정 저장(저장 바의 #saveBtn 이 form 속성으로 이 폼들을 제출한다)
  var rvqTimer = null;
  $('r-visit-q').addEventListener('input', function () {
    var v = this.value;
    clearTimeout(rvqTimer);
    rvqTimer = setTimeout(function () { rUi.vq = v; renderRVisitTable(false); }, 150);
  });
  var rpqTimer = null;
  $('r-profile-q').addEventListener('input', function () {
    var v = this.value;
    clearTimeout(rpqTimer);
    rpqTimer = setTimeout(function () { rUi.pq = v; renderRProfileTable(false); }, 150);
  });
  $('r-move-form').addEventListener('submit', function (ev) {
    ev.preventDefault();
    if (!$('r-move-pv').hidden || $('r-move-check').disabled) return;
    moveCheck();
  });
  ROOM_ROUTES.forEach(function (r) {
    var f = $(formOf(r));
    if (!f) return;
    f.addEventListener('submit', function (ev) {
      ev.preventDefault();
      if (route !== r || dirtyN === 0 || !roomSt.cfg) return;
      qsa('.num input[data-min]', f).forEach(fixNum);
      saveRoomSettings(r);
    });
  });

  // 기록 도구줄
  var vqTimer = null;
  $('visit-q').addEventListener('input', function () {
    var v = this.value;
    clearTimeout(vqTimer);
    vqTimer = setTimeout(function () { visitUi.q = v; renderVisit(false); }, 150);
  });
  $('visit-room').addEventListener('change', function () { visitUi.room = this.value; renderVisit(true); });
  $('visit-type').addEventListener('click', function (e) {
    var b = e.target.closest('button[data-t]');
    if (!b) return;
    visitUi.type = b.dataset.t;
    qsa('#visit-type button').forEach(function (x) { x.setAttribute('aria-pressed', x === b ? 'true' : 'false'); });
    segInd($('visit-type'));
    renderVisit(true);
  });
  $('visit-reload').addEventListener('click', function () {
    if (logsSt.busy) return;
    stopLogs();
    loadLogs(true);
  });
  var pqTimer = null;
  $('profile-q').addEventListener('input', function () {
    var v = this.value;
    clearTimeout(pqTimer);
    pqTimer = setTimeout(function () { profileUi.q = v; renderProfileLog(false); }, 150);
  });

  // 이미지
  $('images').addEventListener('change', async function () {
    say('macro-error', '');
    var room = 5 - images.length - savedImages;
    var replace = savedImages > 0;        // 저장된 이미지는 다시 보낼 수 없어 새로 고르면 통째로 대체한다
    if (replace) room = 5;
    var files = Array.prototype.slice.call(this.files || []).slice(0, Math.max(0, room));
    try {
      var next = [];
      for (var i = 0; i < files.length; i++) next.push({ b64: await readFile(files[i]), name: files[i].name || ('이미지 ' + (i + 1)) });
      if (next.length) {
        if (replace) { savedImages = 0; images = []; }
        var first = images.length;
        images = images.concat(next).slice(0, 5);
        imagesDirty = true;
        renderThumbs(first);
        markDirty();
      }
    } catch (e) {
      say('macro-error', e.message);
    }
    this.value = '';
  });

  // 대화방 불러오기 — 모든 화면의 같은 버튼이 V4 reload-rooms 동작을 공유한다
  async function reloadRooms(btn) {
    if (!account || btn.disabled) return;
    say('room-error', '');
    var buttons = qsa('[data-load-rooms]');
    buttons.forEach(function (b) { b.classList.add('busy'); b.disabled = true; });
    var prevKeys = roomChoices().map(function (r) { return r.key; });
    var dev = account.device_id;    // 응답 전에 계정을 바꿨으면 그 결과를 지금 계정 화면에 넣지 않는다
    try {
      var res = await api('/panel/api/rooms', { device_id: dev });
      if (dev !== curId) return;
      if (res.account) account = res.account;
      else if (res.rooms) account.rooms = res.rooms;
      var added = refillRoomLists(prevKeys);
      var n = roomChoices().length;
      // 이름을 아직 못 읽은 오픈채팅방은 목록에 없다. "최신입니다" 대신 몇 개인지 알린다.
      var unnamed = res.unnamed > 0 ? res.unnamed : 0;
      if (unnamed) notify('대화방 ' + n + '개를 불러왔습니다.', (added ? '새 대화방 ' + added + '개 · ' : '') + '오픈채팅방 ' + unnamed + '개는 이름을 아직 못 읽어 목록에서 뺐습니다. 잠시 뒤 다시 불러와도 그대로면 문의해 주세요.', { kind: 'warn' });
      else if (added) notify('대화방 ' + n + '개를 불러왔습니다.', '새 대화방 ' + added + '개');
      else notify('대화방 목록이 최신입니다.');
    } catch (e) {
      if (authFail(e)) { showLogin(e); return; }
      var msg = e && e.status ? e.message : '대화방 목록을 가져오지 못했습니다. 잠시 뒤 다시 눌러 주세요.';
      if (dev !== curId) return;
      say('room-error', msg);
      notify('대화방을 불러오지 못했습니다.', msg, { kind: 'crit' });
    } finally {
      buttons.forEach(function (b) { b.classList.remove('busy'); b.disabled = false; });
    }
  }

  // ── 설정 저장 (V4 submit 핸들러, 버튼은 저장 바) ─────────
  function submitGuard(ev) { ev.preventDefault(); return !account || dirtyN === 0; }
  $('macro-form').addEventListener('submit', function (ev) {
    if (submitGuard(ev)) return;
    var picked = selectedRooms();
    var body = {
      device_id: account.device_id,
      macro: {
        enabled: $('macro-on').checked,
        message: $('macro-message').value,
        baseMin: Number($('base-min').value),
        randomMin: Number($('random-min').value),
        rooms: picked.rooms,
        roomCooldownMin: picked.roomCooldownMin,
      },
    };
    if (imagesDirty) body.images = images.map(function (x) { return x.b64; });
    else body.images_unchanged = true;
    saveSettings('macro', 'macro-error', body, function () { refreshMe().catch(function () { /* 다음 폴링 */ }); });
  });
  $('visit-form').addEventListener('submit', function (ev) {
    if (submitGuard(ev)) return;
    saveSettings('visit', 'visit-error', {
      device_id: account.device_id,
      images_unchanged: true,
      visit: {
        enabled: $('visit-on').checked,
        rooms: checkedRooms('#visit-open'),
      },
    });
  });
  $('profile-form').addEventListener('submit', function (ev) {
    if (submitGuard(ev)) return;
    saveSettings('profile', 'profile-error', {
      device_id: account.device_id,
      images_unchanged: true,
      profile: {
        enabled: $('profile-on').checked,
        rooms: checkedRooms('#profile-open'),
      },
    });
  });
  $('guard-form').addEventListener('submit', function (ev) {
    if (submitGuard(ev)) return;
    fixNum($('guard-secs'));
    fixNum($('guard-count'));
    saveSettings('guard', 'guard-error', {
      device_id: account.device_id,
      images_unchanged: true,
      guard: {
        enabled: $('guard-on').checked,
        rooms: checkedRooms('#guard-open'),
        secs: Number($('guard-secs').value),
        count: Number($('guard-count').value),
      },
    });
  });
  $('cover-form').addEventListener('submit', function (ev) {
    if (submitGuard(ev)) return;
    saveSettings('cover', 'cover-error', {
      device_id: account.device_id,
      images_unchanged: true,
      cover: {
        enabled: $('cover-on').checked,
        rooms: checkedRooms('#cover-open'),
        words: coverWords.slice(),
        links: $('cover-links').checked,
      },
    });
  });
  $('reply-form').addEventListener('submit', function (ev) {
    if (submitGuard(ev)) return;
    saveSettings('reply', 'reply-error', {
      device_id: account.device_id,
      images_unchanged: true,
      autoreply: {
        enabled: $('reply-on').checked,
        message: $('reply-message').value,
        cooldown_hours: Number($('reply-hours').value),
      },
    });
  });
  $('snipe-form').addEventListener('submit', function (ev) {
    if (submitGuard(ev)) return;
    saveSettings('snipe', 'snipe-error', {
      device_id: account.device_id,
      images_unchanged: true,
      triggers: triggers,
    });
  });

  $('add-trigger').addEventListener('click', function () {
    if (triggers.length >= 30) return;
    triggers.unshift({
      name: '', pattern: '', mode: 'contains', reply: '', enabled: true,
      cooldown_sec: 60, once: false, rooms: [], target: '',
    });
    var shifted = { 0: 1 };
    Object.keys(openRules).forEach(function (k) { shifted[Number(k) + 1] = 1; });
    openRules = shifted;
    renderTriggers(reducedMotion() ? -1 : 0);
    markDirty();
    var r = qs('.rule[data-ri="0"]');
    if (r) r.scrollIntoView({ block: 'nearest', behavior: reducedMotion() ? 'auto' : 'smooth' });
    setTimeout(function () { var f = $('tn0'); if (f) f.focus({ preventScroll: true }); }, reducedMotion() ? 0 : 120);
  });

  // ── 계정 추가 리스너 ──────────────────────────────────────
  function bindCancel() {
    var b = $('cancel-code');
    if (!b || b.dataset.bound) return;
    b.dataset.bound = '1';
    b.addEventListener('click', async function () {
      confirmGen += 1;
      var id = pendingId;
      hidePass();
      focusAddField();
      if (id) {
        try { await api('/panel/api/register/cancel', { pending_id: id }); } catch (e) { /* 화면은 닫는다 */ }
      }
    });
  }
  bindCancel();

  $('add-form').addEventListener('submit', async function (ev) {
    ev.preventDefault();
    clearAddErrors();
    var email = $('email').value.trim();
    var pw = $('password').value;
    if (!email) { say('email-error', '카카오 계정(이메일 또는 전화번호)을 입력해 주세요.'); $('email').classList.add('err'); }
    if (!pw) { say('password-error', '비밀번호를 입력해 주세요.'); $('password').classList.add('err'); }
    if (!email || !pw) { (email ? $('password') : $('email')).focus(); return; }
    var btn = $('add-next');
    addBusy(btn, true);
    try {
      var body = {
        email: $('email').value,
        password: $('password').value,
      };
      if (ev.target.dataset.reauth === '1' && regDevice) body.device_id = regDevice;
      var view = await api('/panel/api/register/begin', body);
      if (view.device_id) regDevice = view.device_id;
      if (view.state === 'ok') {
        await showDone(view);
        return;
      }
      if (view.state === 'confirm_on_phone') {
        showPass(view);
        confirmLoop();
        return;
      }
      showBeginFail(view);
    } catch (e) {
      if (authFail(e)) { showLogin(e); return; }
      addError(e);
    } finally {
      addBusy(btn, false);
    }
  });
  // 등록 시작 오류. no_macro 면 구매 버튼을 붙인다(3.4.1).
  function addError(e) {
    var p = $('add-error');
    if (e && e.body && e.body.reason === 'no_macro') {
      p.innerHTML = esc(e.message) + ' <a class="btn sm" href="/buy?macro=1">구매</a>';
      return;
    }
    say('add-error', e && e.message ? e.message : '등록하지 못했습니다.');
  }

  $('force').addEventListener('click', function () {
    var btn = this;
    var body = {
      email: $('email').value,
      password: $('password').value,
      forced: true,
    };
    if ($('add-form').dataset.reauth === '1' && regDevice) body.device_id = regDevice;
    addBusy(btn, true);
    say('add-error', '');
    api('/panel/api/register/begin', body).then(function (view) {
      if (view.device_id) regDevice = view.device_id;
      if (view.state === 'confirm_on_phone') {
        $('force-box').hidden = true;
        showPass(view);
        confirmLoop();
      } else if (view.state === 'ok') {
        $('force-box').hidden = true;
        return showDone(view);
      } else {
        showBeginFail(view);
      }
    }).catch(function (e) { if (authFail(e)) { showLogin(e); return; } addError(e); }).finally(function () { addBusy(btn, false); });
  });

  $('code-copy').addEventListener('click', function () { var c = $('code').dataset.code; if (c) copyText(c); });
  $('add-open').addEventListener('click', function () {
    var id = doneDevice;
    if (!id) { location.hash = '#macro'; return; }
    switchAccount(id, { quiet: true, then: function () { location.hash = '#macro'; } });
  });
  $('add-more').addEventListener('click', function () {
    $('email').value = '';
    $('password').value = '';
    clearAddErrors();
    $('add-form').dataset.reauth = '';
    $('email').readOnly = false;
    resetAddTitle();
    setStep(1);
    enterAdd(null);
    focusAddField();
  });

  // ── 주요 알림 리스너 ─────────────────────────────────────────
  if (railEl) {
    railEl.addEventListener('click', function (ev) {
      var b = ev.target.closest ? ev.target.closest('.fchip') : null;
      if (!b || !railEl.contains(b)) return;
      if (b.id === 'rail-all') { selectRail(''); return; }
      if (b.classList.contains('rail-acct')) selectRail(b.dataset.device || '');
    });
  }
  if (threadSettings) {
    threadSettings.addEventListener('click', function () {
      if (chat.deviceId) switchAccount(chat.deviceId, { quiet: true, then: function () { location.hash = '#macro'; } });
    });
  }
  $('chat-reload').addEventListener('click', function () { loadInbox(true); });
  if (chatBack) chatBack.addEventListener('click', backAction);
  $('chat-form').addEventListener('submit', function (ev) {
    ev.preventDefault();
    sendChat();
  });
  chatText.addEventListener('input', function () { autoGrow(); updateComposeState(); updateCount(); });
  chatText.addEventListener('keydown', function (ev) {
    if (ev.key === 'Enter' && !ev.shiftKey) {
      // 한글 조합 중의 Enter 는 조각을 보내게 되므로 무시한다
      if (ev.isComposing || ev.keyCode === 229) return;
      ev.preventDefault();
      sendChat();
      return;
    }
    if (ev.key === 'Escape') {
      if (isPhone()) backAction();
      else chatText.blur();
    }
  });
  // 폰에서 키보드가 뜨면 로그 바닥이 가려지므로 끝으로 내린다
  chatText.addEventListener('focus', function () { chatLog.scrollTop = chatLog.scrollHeight; });
  var searchTimer = null;
  if (chatSearch) {
    chatSearch.addEventListener('input', function () {
      if (searchTimer) clearTimeout(searchTimer);
      searchTimer = setTimeout(function () {
        searchTimer = null;
        ui.query = chatSearch.value || '';
        renderConvList();
      }, 120);
    });
    chatSearch.addEventListener('keydown', function (ev) {
      if (ev.key === 'Escape') {
        ev.stopPropagation();
        chatSearch.value = '';
        ui.query = '';
        renderConvList();
      }
    });
  }
  if (chatUnread) {
    chatUnread.addEventListener('click', function () {
      ui.unreadOnly = !ui.unreadOnly;
      inboxSt.stagger = true;
      chatUnread.setAttribute('aria-pressed', ui.unreadOnly ? 'true' : 'false');
      renderConvList();
    });
  }
  if (chatNotice) {
    chatNotice.addEventListener('click', function (ev) {
      var b = ev.target.closest ? ev.target.closest('button') : null;
      if (!b) return;
      var row = b.closest('.kkt-notice-row');
      if (!row) return;
      var a = accOf(row.dataset.device);
      startReauth(row.dataset.device, a ? a.email : '');
    });
  }
  if (chatNewpill) {
    chatNewpill.addEventListener('click', function () {
      chatLog.scrollTop = chatLog.scrollHeight;
      chatNewpill.hidden = true;
    });
  }
  chatLog.addEventListener('scroll', function () {
    if (chatNewpill && !chatNewpill.hidden && nearBottomOf(chatLog)) chatNewpill.hidden = true;
  });
  // 목록 ↑↓: 포커스만 옮긴다(열지는 않는다). Enter·Space 는 버튼이 연다.
  chatRooms.addEventListener('keydown', function (e) {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    if (e.altKey) return;
    var rs = qsa('#chat-rooms .kkt-row');
    var i = rs.indexOf(document.activeElement);
    if (i < 0) return;
    e.preventDefault();
    rs[clamp(i + (e.key === 'ArrowDown' ? 1 : -1), 0, rs.length - 1)].focus();
  });
  window.addEventListener('popstate', function (ev) {
    if (ev.state && ev.state.kview === 'room') return;
    // 해시 이동도 popstate 를 낸다. 주요 알림 안에서 뒤로 간 경우(대화 → 목록)만 닫는다. 다른 화면에서 돌아올 때는 열린 대화를 둔다.
    if (route === 'inbox' && inboxEl.dataset.view === 'room' && location.hash === '#inbox') closeConversation();
  });
  // 탭을 숨기면 폴링을 쉬므로, 다시 보이면 기다리지 말고 바로 읽는다. 오래 숨겼으면 계정 상태(/me)도 다시 본다.
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) { inboxSt.hiddenAt = Date.now(); return; }
    if (!me) return;
    if (inboxSt.hiddenAt && Date.now() - inboxSt.hiddenAt > 300000) refreshMe().catch(function () { /* 다음 폴링이 다시 시도한다 */ });
    else loadInbox(false);
    loadRooms();
    if (ROUTES[route] && ROUTES[route].room) { loadRoom(); if (ROOM_LOG_ROUTES[route]) loadRoomLogs(); }
    if (chat.openId && route === 'inbox') loadThread(false);
  });
  updatePlaceholder();
  closeConversation();
  setStep(1, false);

  // 부팅(6.9): 사이트 공통 /api/site(support.js 의 window.kbSite)에 회원이 없으면 로그인 카드, 있으면 /panel/api/me.
  function siteInfo() {
    if (window.kbSite && typeof window.kbSite.then === 'function') return window.kbSite;
    return fetch('/api/site', { credentials: 'same-origin', cache: 'no-store' }).then(function (r) { return r.json(); }).catch(function () { return { ok: false }; });
  }
  function applySite(site) {
    var g = !!(site && site.google);
    qsa('[data-google]').forEach(function (x) { x.hidden = !g; });
  }
  Promise.resolve(siteInfo()).catch(function () { return { ok: false }; }).then(function (site) {
    applySite(site);
    if (site && site.ok !== false && !site.member) { showLogin(); return; }
    return api('/panel/api/me').then(function (res) {
      me = res;
      showApp();
      renderAccounts();
      bootConsole();
    });
  }).catch(function (e) {
    showLogin(authFail(e) ? e : null);
  });
})();
