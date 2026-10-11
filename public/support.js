/* ───────────────────────────────────────────────────────────────
   K bot — 실시간 상담(채널톡) 로더 · 사이트 공통 로그인 상태 (docs/ACCOUNTS_V1.md 6.10 · 부록 B · D25)

   모든 사이트 페이지가 app.js 보다 먼저 싣는다: <script src="/support.js?v=1" defer>.
   콘솔(panel.html)은 <html data-support-mode="link"> 로 SDK 없이 쓴다(링크 방식).

   내보내는 것 (작업 5 가 쓴다, 9.2):
     window.kbSite            GET /api/site 프라미스(페이지당 1회). 실패해도 {ok:false} 로 끝난다(거부하지 않음).
     window.kbSupport.open(ctx)   상담 창 열기(위젯이면 openChat, 아니면 새 창 /support?ctx=)
     window.kbSupport.reboot()    로그인·로그아웃 직후: shutdown → /api/site 다시 → 다시 결정
     window.kbSupport.ready()     결정이 끝나면 'chat'|'contact'|'off' 로 풀리는 프라미스(사이트 /support 화면이 쓴다)
     window.kbSupport.state()     지금 상태

   상태 하나로 모든 버튼을 다룬다: <html data-support="off|chat|contact">.
   [data-support] 버튼의 보이기는 CSS 가 정한다(style.css·panel.css):
     html:not([data-support="chat"]):not([data-support="contact"]) [data-support] { display:none !important }
   그래서 나중에 그려지는 버튼도 따로 처리할 필요가 없다. 버튼에 hidden 을 쓰지 않는다.
   클릭은 document 의 위임 처리기 1개가 받는다(customLauncherSelector 는 부팅 뒤에 생긴 버튼을 놓친다).
   ─────────────────────────────────────────────────────────────── */
(function () {
  'use strict';

  if (window.kbSupport && window.kbSupport.__kb) return;   // 두 번 실려도 한 번만

  var root = document.documentElement;
  var LINK_MODE = root.getAttribute('data-support-mode') === 'link';
  var BOOT_WAIT_MS = 8000;        // 이 안에 부팅 콜백이 없으면(차단·카카오톡 웹뷰) 대체 수단으로
  var CTX_MAX = 300;

  var state = 'off';
  var site = null;
  var gen = 0;                    // reboot 마다 올라간다 — 늦게 온 응답·콜백이 새 결정을 덮지 않게
  var widgetBooted = false;       // ChannelIO('boot') 가 성공했다
  var readyP = null, readyRes = null;

  function setState(s) {
    state = s;
    root.setAttribute('data-support', s);
  }

  function newReady() {
    readyP = new Promise(function (res) { readyRes = res; });
  }
  function settle() {
    if (!readyRes) return;
    var r = readyRes;
    readyRes = null;
    r(state);
  }

  function fetchSite() {
    var p;
    try {
      p = fetch('/api/site', { credentials: 'same-origin', cache: 'no-store', headers: { 'Accept': 'application/json' } })
        .then(function (r) { return r.json(); });
    } catch (e) {
      p = Promise.reject(e);
    }
    return p.then(function (s) { return s && typeof s === 'object' ? s : { ok: false }; })
      .catch(function () { return { ok: false }; });
  }

  /* 부록 B — @channel.io/channel-web-sdk-loader@2.0.2 의 loadScript() 와 같은 코드 */
  function loadChannelIO() {
    var w = window;
    if (w.ChannelIO) return;
    var ch = function () { ch.c(arguments); };
    ch.q = [];
    ch.c = function (args) { ch.q.push(args); };
    w.ChannelIO = ch;
    function l() {
      if (w.ChannelIOInitialized) return;
      w.ChannelIOInitialized = true;
      var s = document.createElement('script');
      s.type = 'text/javascript';
      s.async = true;
      s.src = 'https://cdn.channel.io/plugin/ch-plugin-web.js';
      var x = document.getElementsByTagName('script')[0];
      if (x && x.parentNode) x.parentNode.insertBefore(s, x);
      else document.head.appendChild(s);
    }
    if (document.readyState === 'complete') l();
    else { w.addEventListener('DOMContentLoaded', l); w.addEventListener('load', l); }
  }

  /* 대체: 연락처가 있으면 contact, 없으면 off */
  function fallback(g) {
    if (g !== gen) return;
    setState(site && site.contact ? 'contact' : 'off');
    settle();
  }

  function bootWidget(ch, g) {
    try { loadChannelIO(); } catch (e) { fallback(g); return; }
    var settled = false;
    var timer = setTimeout(function () {
      if (g !== gen || settled) return;
      settled = true;
      fallback(g);
    }, BOOT_WAIT_MS);
    var opts = {
      pluginKey: String(ch.plugin_key),
      language: 'ko',
      appearance: 'dark',
      hideChannelButtonOnBoot: true
    };
    /* 회원 식별(memberId·memberHash)은 서버가 준 경우만 — CHANNEL_MEMBER_SECRET 이 있을 때(8.8) */
    if (ch.member_id && ch.member_hash) {
      opts.memberId = String(ch.member_id);
      opts.memberHash = String(ch.member_hash);
    }
    var member = site && site.member;
    var name = ch.name || (member && member.login_id) || '';
    if (member && name) opts.profile = { name: String(name) };   // 로그인한 경우만
    try {
      window.ChannelIO('boot', opts, function (err) {
        if (g !== gen) return;
        clearTimeout(timer);
        if (err) {
          if (!settled) { settled = true; fallback(g); }
          return;
        }
        /* 8초가 지나 대체로 바꾼 뒤에 늦게 뜬 경우에도 상담 창이 실제로 되므로 chat 으로 올린다 */
        settled = true;
        widgetBooted = true;
        setState('chat');
        settle();
      });
    } catch (e) {
      clearTimeout(timer);
      if (!settled) { settled = true; fallback(g); }
    }
  }

  /* 관리자가 바꾸는 한도(카카오 계정 수·동시 로그인 기기 수)를 화면 숫자에 채운다.
     HTML 에는 기본값을 적어 두고 /api/site 의 limits 로 [data-limit] 칸을 바꾼다. 나중에 그린 칸은 fillLimits(node). */
  function fillLimits(node) {
    var lim = site && site.limits;
    if (!lim) return;
    var list = (node || document).querySelectorAll('[data-limit]');
    for (var i = 0; i < list.length; i++) {
      var v = lim[list[i].getAttribute('data-limit')];
      if (typeof v === 'number' && v > 0) list[i].textContent = String(v);
    }
  }

  /* 1~3: /api/site 를 받아 방식을 정한다 */
  function decide(s, g) {
    if (g !== gen) return;
    site = s && s.ok !== false ? s : null;
    fillLimits();
    var ch = site && site.channel && site.channel.plugin_key ? site.channel : null;
    if (ch && LINK_MODE) { setState('chat'); settle(); return; }   // 콘솔: SDK 없이 새 창 /support
    if (ch) { bootWidget(ch, g); return; }
    fallback(g);
  }

  function start() {
    var g = gen;
    newReady();
    Promise.resolve(window.kbSite).then(function (s) { decide(s, g); }, function () { decide(null, g); });
  }

  function cleanCtx(ctx) {
    var c = ctx === undefined || ctx === null ? '' : String(ctx);
    c = c.replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, ' ').trim();
    return c.length > CTX_MAX ? c.slice(0, CTX_MAX) : c;
  }

  /* 5: 상담 창 열기 */
  function open(ctx) {
    var c = cleanCtx(ctx);
    if (state === 'chat' && !LINK_MODE && widgetBooted && typeof window.ChannelIO === 'function') {
      try {
        window.ChannelIO('openChat', undefined, c ? c + '\n' : undefined);
        return true;
      } catch (e) { /* 아래 새 창으로 */ }
    }
    if (state === 'chat' || state === 'contact') {
      /* 상담 화면 안에서 연락처 안내를 다시 새 창으로 열지 않는다 */
      if (!LINK_MODE && document.body && document.body.getAttribute('data-page') === 'support') {
        var box = document.getElementById('supportBody');
        if (box && box.focus) box.focus();
        return true;
      }
      var url = '/support' + (c ? '?ctx=' + encodeURIComponent(c) : '');
      try { window.open(url, '_blank', 'noopener'); } catch (e) { location.href = url; }
      return true;
    }
    return false;
  }

  function reboot() {
    gen++;
    if (!LINK_MODE && widgetBooted && typeof window.ChannelIO === 'function') {
      try { window.ChannelIO('shutdown'); } catch (e) { /* 다음 부팅이 덮는다 */ }
    }
    widgetBooted = false;
    setState('off');
    window.kbSite = fetchSite();
    start();
    return window.kbSite;
  }

  /* 4: 위임 처리기 1개 — 나중에 그려진 버튼도 받는다 */
  document.addEventListener('click', function (e) {
    if (e.defaultPrevented || e.button !== 0) return;
    var t = e.target && e.target.closest ? e.target.closest('[data-support]') : null;
    if (!t || t === root || t === document.body) return;   // <html data-support> 자체는 버튼이 아니다
    if (t.disabled) return;
    e.preventDefault();
    open(t.getAttribute('data-support-ctx') || '');
  });

  window.kbSupport = {
    __kb: true,
    open: open,
    reboot: reboot,
    ready: function () { return readyP; },
    state: function () { return state; },
    site: function () { return site; },
    fillLimits: fillLimits
  };

  setState('off');
  window.kbSite = fetchSite();
  start();
})();
