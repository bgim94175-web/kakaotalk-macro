/* ───────────────────────────────────────────────────────────────
   K bot — 체험 화면 (/demo, docs/ACCOUNTS_V1.md 6.13)
   카카오톡 오픈채팅방과 같은 화면에서 장면을 고르고, 글을 입력하거나 버튼을 누르면 K bot이 실제 봇과 똑같이 답한다.
   K bot(과 손님 계정)이 보내는 글은 전부 서버(lib/demo.js)가 실제 봇 함수로 만든다 — 여기서는 받은 그대로 그린다.

   쓰는 서버 API (실패하면 {ok:false, reason, error} — error 는 한국어 그대로 보여 준다):
     GET  /api/demo          장면 목록 {first, groups:[{id, title, desc, product, scenes:[{id, title}]}]}
     POST /api/demo/start    {scene, opts?} → {scene:SceneInfo, state, out:Item[]}
     POST /api/demo/step     {state, ev}    → {state, out:Item[]}
                             ev = {type:'say', text, cid} (손님이 입력) | {type:'act', id} (버튼)
   state 는 서버가 만든 덩어리다. 열어 보지 않고 다음 요청에 그대로 돌려준다.
   out 항목은 wait(ms)만큼 기다렸다가 하나씩 그린다(재생 줄 하나). 요청은 누른 순서대로 한 번에 하나씩 보낸다.
   손님이 입력한 글은 응답을 기다리지 않고 바로 그린다(cid 로 — 서버는 이 글을 다시 보내지 않고, 가릴 때 cid 를 쓴다).

   서버 문자열은 textContent 로만 넣는다. 외부 라이브러리 안 씀. app.js 는 헤더(로그인 상태 · 현재 위치)만 맡는다.
   ─────────────────────────────────────────────────────────────── */
(function () {
  'use strict';

  /* ══════════════════ 0. 문구 · 상수 ══════════════════ */

  var MSG_NET = '연결이 끊겼습니다. 잠시 뒤 다시 시도해 주세요.';
  var MSG_FAIL = '체험 화면을 표시하지 못했습니다. 새로고침한 뒤에도 같으면 문의해 주세요.';
  var MSG_LOADING = '체험 화면을 준비하는 중…';
  var MSG_HIDDEN = '가려진 메시지입니다.';         // 글 가리기로 가려진 글 자리
  var LONG_CUT = 500;                               // 카카오톡처럼 이보다 긴 글은 앞부분만 보이고 [전체보기]
  var MAX_WAIT = 15000;                             // wait 값이 이상해도 화면이 멈춘 듯 보이지 않게
  var STICK_PX = 80;                                // 맨 아래에서 이만큼 안이면 새 글이 올 때 따라 내려간다
  var ROLE_MARK = { host: '방장', sub: '부방장' };
  var PROD_ICON = { macro: 'i-macro', roombot: 'i-shield', minigame: 'i-game' };   // 구매 화면 카드와 같은 아이콘
  var WEEK = ['일', '월', '화', '수', '목', '금', '토'];
  var HINT_ROOM = 72;                               // 휴대폰 아래 설명 한 줄(두 줄)이 들어갈 자리
  var HINT_ROOM_S = 100;                            // 좁은 화면은 설명이 세 줄까지 된다


  /* ══════════════════ 1. 유틸 ══════════════════ */

  function $(id) { return document.getElementById(id); }

  function el(tag, attrs, kids) {
    var n = document.createElement(tag), k;
    if (attrs) for (k in attrs) {
      var v = attrs[k];
      if (v === null || v === undefined || v === false) continue;
      if (k === 'text') n.textContent = String(v);
      else if (k === 'cls') n.className = v;
      else if (k.slice(0, 2) === 'on' && typeof v === 'function') n.addEventListener(k.slice(2), v);
      else n.setAttribute(k, v === true ? '' : String(v));
    }
    (kids || []).forEach(function (c) {
      if (c === null || c === undefined || c === false) return;
      n.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
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

  function clear(node) { while (node && node.firstChild) node.removeChild(node.firstChild); }
  function str(v) { return typeof v === 'string' ? v : (v === null || v === undefined ? '' : String(v)); }
  function list(v) { return Array.isArray(v) ? v : []; }

  function reducedMotion() {
    return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  }

  /* 시각은 한국 시간으로. kkClock 은 봇의 roomfeat.kstClock 과 같은 모양(오후 7:31) */
  function kst(ms) {
    var n = Number(ms);
    if (!(n > 0)) return null;
    var d = new Date(n + 9 * 3600000);
    return isNaN(d.getTime()) ? null : d;
  }
  function kkClock(ms) {
    var d = kst(ms);
    if (!d) return '';
    var h = d.getUTCHours(), mi = d.getUTCMinutes();
    return (h < 12 ? '오전 ' : '오후 ') + (h % 12 || 12) + ':' + (mi < 10 ? '0' : '') + mi;
  }
  function kkDay(ms) {
    var d = kst(ms);
    return d ? d.getUTCFullYear() + '년 ' + (d.getUTCMonth() + 1) + '월 ' + d.getUTCDate() + '일 ' + WEEK[d.getUTCDay()] + '요일' : '';
  }
  function minuteOf(ms) { return Math.floor(Number(ms) / 60000); }

  /* 프로필 사진 대신 이름 첫 글자 */
  function initialOf(name) {
    var c = Array.from ? Array.from(str(name).trim())[0] : str(name).trim().charAt(0);
    return c ? c.toUpperCase() : '?';
  }
  /* 프로필 색(0~5). 서버가 av 를 안 주면 id 로 고른다 */
  function avOf(m, id) {
    var n = Number(m && m.av);
    if (n >= 0 && n <= 5 && Math.floor(n) === n) return n;
    var h = 0, s = str(id);
    for (var i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 997;
    return h % 6;
  }


  /* ══════════════════ 2. 서버 요청 ══════════════════
     JSON 만. {ok:false} 면 서버 문구(error)를 message 로, reason 을 code 로 던진다. 연결 실패는 e.net. */

  function api(path, body) {
    var opt = { method: body ? 'POST' : 'GET', headers: { 'Accept': 'application/json' }, cache: 'no-store', credentials: 'same-origin' };
    if (body) { opt.headers['Content-Type'] = 'application/json'; opt.body = JSON.stringify(body); }
    return fetch(path, opt).then(function (res) {
      return res.json().catch(function () { return null; }).then(function (data) {
        if (data && data.ok === true) return data;
        var e = new Error(data && typeof data.error === 'string' && data.error ? data.error : MSG_FAIL);
        e.status = res.status;
        e.code = data && data.reason;
        throw e;
      });
    }, function () {
      var e = new Error(MSG_NET);
      e.net = true;
      throw e;
    });
  }


  /* ══════════════════ 3. 상태 ══════════════════ */

  var R = {};                 // 화면 요소
  var S = {
    groups: [], scenes: {},   // 장면 목록 · id → {group, title}
    gen: 0,                   // 장면을 바꾸거나 다시 시작할 때마다 +1. 늦게 온 응답 · 타이머는 버린다
    scene: '', opts: {}, info: null, state: null,
    members: {},              // id → {name, role, av, gone}
    count: 0, dm: false,      // 위 막대 인원 · 갠톡 화면이면 true
    feedCount: false,         // 방 알림(feed)이 인원(count)을 함께 주면 그 값을 그대로 쓴다
    jobs: [], busy: false,    // 보낼 요청 줄
    retried: false,           // bad_state 로 한 번 조용히 다시 시작했는가
    rows: {},                 // 메시지 id → 줄 요소 (가리기용)
    group: null,              // 지금 이어 붙는 말풍선 묶음 {from, min, name, time}
    clock: 0, clockAt: 0,     // 마지막으로 그린 항목의 at 과 그때의 실제 시각(손님 글 시각용)
    srv: 0, srvAt: 0,         // 응답의 clock(체험 시계)과 받은 실제 시각
    seq: 0
  };


  /* ══════════════════ 4. 장면 목록 ══════════════════ */

  function groupOf(id) {
    for (var i = 0; i < S.groups.length; i++) if (S.groups[i].id === id) return S.groups[i];
    return null;
  }

  function renderScenes() {
    var nav = R.scenes;
    clear(nav);
    nav.removeAttribute('aria-busy');
    S.groups.forEach(function (g) {
      var ul = el('ul');
      list(g.scenes).forEach(function (sc) {
        if (!sc || !sc.id) return;
        S.scenes[sc.id] = { group: g.id, title: str(sc.title) };
        ul.appendChild(el('li', null, [el('a', { cls: 'demo-sc', href: '#' + sc.id, 'data-scene': sc.id, text: str(sc.title) })]));
      });
      nav.appendChild(el('div', { cls: 'demo-grp', 'data-prod': str(g.product) || null }, [
        el('p', { cls: 'demo-grp-h' }, [
          el('span', { cls: 'demo-grp-ic', 'aria-hidden': 'true' }, [icon(PROD_ICON[g.product] || 'i-check', 14)]),
          str(g.title)
        ]),
        ul
      ]));
    });
  }

  function markScene(id) {
    Array.prototype.forEach.call(R.scenes.querySelectorAll('.demo-sc'), function (a) {
      var on = a.getAttribute('data-scene') === id;
      if (on) a.setAttribute('aria-current', 'true'); else a.removeAttribute('aria-current');
      /* 좁은 화면의 가로 탭: 고른 장면이 보이게 탭 줄만 옆으로 민다(페이지는 움직이지 않는다) */
      if (on && R.scenes.scrollWidth > R.scenes.clientWidth + 1) {
        var left = a.offsetLeft - (R.scenes.clientWidth - a.offsetWidth) / 2;
        R.scenes.scrollTo({ left: Math.max(0, left), behavior: reducedMotion() ? 'auto' : 'smooth' });
      }
    });
  }


  /* ══════════════════ 5. 장면 설명 · 버튼 ══════════════════ */

  function renderInfo(info) {
    var g = groupOf(info.group) || groupOf((S.scenes[info.id] || {}).group) || {};
    var wrap = R.wrap;
    if (g.product) wrap.setAttribute('data-prod', g.product); else wrap.removeAttribute('data-prod');

    clear(R.kind);
    R.kind.appendChild(el('span', { cls: 'dot', 'aria-hidden': 'true' }));
    R.kind.appendChild(document.createTextNode(str(g.title)));
    R.title.textContent = str(info.title);
    R.desc.textContent = str(info.desc);

    /* 조치 · 간격 같은 고르기 칸 — 바꾸면 그 값으로 처음부터 */
    clear(R.ctrls);
    list(info.controls).forEach(function (c) {
      if (!c || !c.key) return;
      var seg = el('div', { cls: 'seg' });
      list(c.options).forEach(function (o) {
        var on = String(o.v) === String(c.value);
        seg.appendChild(el('button', {
          type: 'button', 'aria-pressed': on ? 'true' : 'false', text: str(o.label),
          onclick: function () {
            if (on) return;
            var next = {};
            for (var k in S.opts) next[k] = S.opts[k];
            next[c.key] = o.v;
            S.retried = false;
            start(S.scene, next);
          }
        }));
      });
      R.ctrls.appendChild(el('div', { cls: 'demo-ctrl', role: 'group', 'aria-label': str(c.label) }, [
        el('span', { cls: 'demo-ctrl-l', 'aria-hidden': 'true', text: str(c.label) }), seg
      ]));
    });
    R.ctrls.hidden = !R.ctrls.firstChild;

    clear(R.acts);
    list(info.actions).forEach(function (a) {
      if (!a || !a.id) return;
      R.acts.appendChild(el('button', {
        type: 'button', cls: 'btn lg demo-act',
        onclick: function () { act(a.id); revealPhone(); }
      }, [icon('i-play', 13), str(a.label)]));
    });
    R.actsW.hidden = !R.acts.firstChild;

    clear(R.chips);
    list(info.chips).forEach(function (t) {
      t = str(t);
      if (!t) return;
      R.chips.appendChild(el('button', { type: 'button', cls: 'demo-chip', text: t, onclick: function () { say(t); revealPhone(); } }));
    });
    R.chipsW.hidden = !R.chips.firstChild;
    R.play.hidden = R.actsW.hidden && R.chipsW.hidden;

    /* 구매 링크는 이 사이트 안 주소만 */
    var buy = info.buy || {};
    var href = str(buy.href);
    if (/^\/(?![\/\\])/.test(href) && buy.label) {
      R.buy.href = href;
      R.buy.textContent = str(buy.label);
      R.buy.hidden = false;
    } else R.buy.hidden = true;
    R.restart.disabled = false;
  }


  /* ══════════════════ 6. 카카오톡 방 ══════════════════ */

  /* 손님 글 시각: 마지막으로 그린 글의 시각에서 흐른 만큼. 다 그렸으면 서버 체험 시계(clock)도 본다
     (매크로 30분 진행처럼 시계가 앞서 간 뒤에도 맞게). 아직 재생 중이면 화면 순서가 꼬이지 않게 그린 글 기준 */
  function nowAt() {
    var t = Date.now();
    var a = S.clock ? S.clock + (t - S.clockAt) : t;
    if (!Q.items.length && S.srv) a = Math.max(a, S.srv + (t - S.srvAt));
    return a;
  }
  function syncClock(r) {
    if (Number(r && r.clock) > 0) { S.srv = Number(r.clock); S.srvAt = Date.now(); }
  }

  function memberOf(id) {
    var m = S.members[id];
    if (!m) m = S.members[id] = id === 'kbot' ? { name: 'K bot', role: 'sub' } : { name: '참가자', role: 'member', av: avOf(null, id) };
    return m;
  }

  /* 방을 비운다(장면 바꾸기 · 다시 시작) */
  function resetRoom(msg) {
    stopQueue();
    stopUnread();
    clear(R.log);
    S.rows = {};
    S.group = null;
    S.clock = 0;
    S.srv = 0;
    S.state = null;
    hideNewPill();
    setHint('');
    clear(R.recs);
    R.recs.hidden = true;
    R.log.appendChild(el('div', { cls: 'kk-state' }, [el('span', { cls: 'spin', 'aria-hidden': 'true' }), el('span', { text: msg || MSG_LOADING })]));
  }

  function roomError(e) {
    clear(R.log);
    R.log.appendChild(el('div', { cls: 'kk-state' }, [
      el('span', { text: e && e.message ? e.message : MSG_FAIL }),
      el('button', { type: 'button', cls: 'btn', onclick: function () { start(S.scene, S.opts); } }, [icon('i-refresh', 14), '다시 시도'])
    ]));
  }

  function renderRoom(info) {
    var room = info.room || {};
    S.members = {};
    list(info.members).forEach(function (m) {
      if (m && m.id) S.members[String(m.id)] = { name: str(m.name), role: str(m.role) || 'member', av: avOf(m, m.id), gone: m.gone === true };
    });
    var me = info.me || {};
    S.members.me = { name: str(me.name) || '나', role: str(me.role) || 'member', av: 0 };
    S.dm = room.kind === 'dm';
    S.count = Math.max(0, Math.floor(Number(room.count) || 0));
    S.feedCount = false;
    R.kk.classList.toggle('is-dm', S.dm);
    R.name.textContent = str(room.name);
    setCount();

    var notice = str(room.notice);
    R.noticeT.textContent = notice;
    R.notice.hidden = !notice;
    R.notice.setAttribute('aria-expanded', 'false');
    R.kk.classList.toggle('has-notice', !!notice);
    clear(R.log);
  }

  function setCount() { R.count.textContent = !S.dm && S.count > 0 ? String(S.count) : ''; }

  /* 버튼을 눌렀는데 휴대폰 아래쪽(새 글 · 입력 칸 · 설명)이 화면 밖이면 그만큼만 내려 보인다
     (휴대폰 위가 머리 막대 밑으로 들어가지 않는 만큼까지). 대화는 아래에 붙어 쌓이므로 새 글은 입력 칸 바로 위에 나온다.
     좁은 화면은 버튼이 휴대폰 바로 위에 있어, 내려도 버튼은 대부분 화면 안에 남는다 */
  var SIDE = window.matchMedia ? window.matchMedia('(min-width: 761px)') : null;
  function revealPhone() {
    if (!R.dev) return;
    var d = R.dev.getBoundingClientRect();
    var head = R.lnav ? R.lnav.getBoundingClientRect().bottom : 0;
    var room = SIDE && !SIDE.matches ? HINT_ROOM_S : HINT_ROOM;
    var by = Math.min(d.bottom + room - window.innerHeight, d.top - head - 12);
    if (by > 4) window.scrollBy({ top: by, behavior: reducedMotion() ? 'auto' : 'smooth' });
  }

  /* 스크롤: 맨 아래 근처면 새 글을 따라 내려가고, 위로 올려 보는 중이면 아래 띠로 알린다 */
  function nearBottom() { return R.log.scrollHeight - R.log.scrollTop - R.log.clientHeight < STICK_PX; }
  function toBottom() { R.log.scrollTop = R.log.scrollHeight; hideNewPill(); }
  function put(node, opt) {
    var stick = opt.force || nearBottom();
    R.log.appendChild(node);
    if (stick) toBottom();
    else if (opt.who !== undefined) showNewPill(opt.who, opt.text);
  }
  function showNewPill(who, text) {
    R.newWho.textContent = who;
    R.newT.textContent = str(text).replace(/\s+/g, ' ');
    R.newPill.hidden = false;
  }
  function hideNewPill() { R.newPill.hidden = true; }

  function addDay(it, hist) {
    var t = kkDay(it.at);
    if (!t) return;
    S.group = null;
    put(el('div', { cls: 'kk-day' + (hist ? '' : ' in'), role: 'separator', text: t }), { force: hist });
  }

  function addFeed(it, hist) {
    var t = str(it.text);
    if (typeof it.count === 'number' && it.count >= 0) {
      S.count = Math.floor(it.count);
      S.feedCount = true;
      setCount();
    }
    if (!t) return;
    S.group = null;
    put(el('div', { cls: 'kk-feed' + (hist ? '' : ' in'), text: t }), { force: hist, who: '', text: t });
  }

  /* 멘션은 반각 @ 로 시작하는 {start, len} 칸만 굵게. 전각 ＠ 나 맞지 않는 값은 그냥 글자 */
  function mentionOf(text, m) {
    if (!m || typeof m !== 'object') return null;
    var s = Number(m.start), n = Number(m.len);
    if (!(s >= 0) || !(n > 1) || Math.floor(s) !== s || Math.floor(n) !== n || s + n > text.length) return null;
    return text.charAt(s) === '@' ? { start: s, len: n } : null;
  }

  function fillBubble(bub, text, mention, full) {
    clear(bub);
    var cut = !full && text.length > LONG_CUT;
    var shown = cut ? text.slice(0, LONG_CUT) : text;
    var mk = mentionOf(text, mention);
    if (mk && mk.start + mk.len <= shown.length) {
      bub.appendChild(document.createTextNode(shown.slice(0, mk.start)));
      bub.appendChild(el('b', { cls: 'kk-at', text: shown.substr(mk.start, mk.len) }));
      bub.appendChild(document.createTextNode(shown.slice(mk.start + mk.len) + (cut ? '…' : '')));
    } else bub.appendChild(document.createTextNode(shown + (cut ? '…' : '')));
    if (cut) {
      bub.appendChild(el('button', {
        type: 'button', cls: 'kk-more',
        onclick: function () { fillBubble(bub, text, mention, true); }
      }, [el('span', { text: '전체보기' }), icon('i-right', 14)]));
    }
  }

  function addMsg(it, hist, force) {
    var from = str(it.from) || 'me';
    var mine = from === 'me';
    var m = memberOf(from);
    var at = Number(it.at) > 0 ? Number(it.at) : nowAt();
    var text = str(it.text);
    var g = S.group;
    var cont = !!(g && g.from === from && g.min === minuteOf(at) && g.name === m.name);
    if (cont) g.time.textContent = '';            // 시각은 묶음의 마지막 줄에만

    var row = el('div', { cls: 'kk-msg ' + (mine ? 'me' : 'them') + (cont ? ' cont' : ' first') + (hist ? '' : ' in') });
    var bub = el('div', { cls: 'kk-bub' });
    /* K bot 기록 카드(입장·퇴장·프로필 변경): 실제 봇처럼 사진 한 장. 글(같은 내용)은 읽기 도구용 대체 글 */
    var img = str(it.img);
    if (img && /^data:image\/svg\+xml;base64,[A-Za-z0-9+\/=]+$/.test(img)) {
      bub.className = 'kk-bub kk-img';
      bub.appendChild(el('img', { src: img, alt: text, width: '720', height: '600', decoding: 'async' }));
    } else fillBubble(bub, text, it.mention);
    var unread = el('span', { cls: 'kk-unread', 'aria-hidden': 'true' });
    var time = el('span', { cls: 'kk-time', text: kkClock(at) });
    var line = el('div', { cls: 'kk-line' }, [bub, el('span', { cls: 'kk-meta' }, [unread, time])]);

    if (mine) {
      row.appendChild(el('span', { cls: 'sr', text: (m.name || '나') + ' : ' }));
      row.appendChild(line);
    } else {
      var bot = from === 'kbot' || m.role === 'bot';
      row.appendChild(bot ? el('span', { cls: 'kk-av brand-mark', 'aria-hidden': 'true' })
        : el('span', { cls: 'kk-av', 'data-av': String(avOf(m, from)), 'aria-hidden': 'true', text: initialOf(m.name) }));
      var col = el('div', { cls: 'kk-col' });
      if (cont) col.appendChild(el('span', { cls: 'sr', text: m.name + ' : ' }));
      else {
        var role = ROLE_MARK[m.role];
        col.appendChild(el('div', { cls: 'kk-name' }, [
          el('span', { cls: 'kk-name-t', text: m.name }),
          role ? el('span', { cls: 'kk-role ' + m.role, text: role }) : null
        ]));
      }
      col.appendChild(line);
      row.appendChild(col);
    }

    var id = str(it.id);
    if (id) S.rows[id] = { row: row, bub: bub };
    S.group = { from: from, min: minuteOf(at), name: m.name, time: time };
    put(row, { force: force || hist, who: mine ? '' : m.name, text: text });

    /* 안 읽은 사람 수: 방에 막 올라온 글만. 열자마자 있던 글은 이미 읽힌 것으로 본다.
       갠톡에서 받은 글은 둘 다 읽었으니 숫자가 없다(보낸 글만 상대가 읽을 때까지 1) */
    if (!hist) {
      var n = S.dm ? (mine ? 1 : 0) : Math.max(0, S.count - (mine ? 1 : 2));
      if (n > 0) countDown(unread, n);
    }
  }

  function hideMsg(id) {
    var r = S.rows[str(id)];
    if (!r) return;
    clear(r.bub);
    r.bub.className = 'kk-bub is-hid now';
    r.bub.appendChild(document.createTextNode(MSG_HIDDEN));
  }

  /* 이름 바꾸기 · 나감/내보냄. 처음 보는 id 면 새로 들어온 사람 → 위 막대 인원 +1
     (방 알림이 인원을 함께 주는 뒤로는 그 값만 쓴다 — 두 번 세지 않게) */
  function setMember(it) {
    var id = str(it.id);
    if (!id) return;
    var m = S.members[id];
    var fresh = !m;
    if (!m) m = S.members[id] = { name: '', role: 'member', av: avOf(it, id) };
    if (typeof it.name === 'string' && it.name) m.name = it.name;
    var delta = 0;
    if (it.gone) {
      if (!m.gone && !fresh) delta = -1;
      m.gone = true;
    } else if (fresh || m.gone) {
      delta = 1;
      m.gone = false;
    }
    if (delta && !S.feedCount) { S.count = Math.max(0, S.count + delta); setCount(); }
    S.group = null;
  }

  /* 안 읽은 사람 수가 몇 초에 걸쳐 줄어 사라진다(타이머 하나로 모든 숫자를) */
  var U = { list: [], timer: 0 };
  function countDown(span, n) {
    span.textContent = String(n);
    U.list.push({ el: span, n: n, t0: Date.now(), dur: S.dm ? 1400 : 2200 + Math.random() * 1400 });
    if (!U.timer) U.timer = setInterval(tickUnread, 180);
  }
  function tickUnread() {
    var now = Date.now();
    U.list = U.list.filter(function (u) {
      var f = Math.min(1, (now - u.t0) / u.dur);
      var left = f >= 1 ? 0 : Math.ceil(u.n * Math.pow(1 - f, 2.2));
      var t = left > 0 ? String(left) : '';
      if (u.el.textContent !== t) u.el.textContent = t;
      return left > 0;
    });
    if (!U.list.length) stopUnread();
  }
  function stopUnread() { clearInterval(U.timer); U.timer = 0; U.list = []; }


  /* ══════════════════ 7. 방 밖: 짧은 설명 · K bot 패널 기록 ══════════════════ */

  /* 경고(연결 오류 · 요청이 잦음)는 사이트의 다른 경고 안내처럼 '!' 표시 */
  function setHint(text, warn) {
    var t = str(text);
    R.hint.hidden = !t;
    R.hint.classList.toggle('warn', !!warn);
    if (R.hintIc) R.hintIc.textContent = warn ? '!' : 'i';
    if (!t) return;
    R.hintT.textContent = t;
    R.hint.classList.remove('in');
    void R.hint.offsetWidth;                       // 같은 설명이 다시 와도 들어오는 움직임을 다시
    R.hint.classList.add('in');
  }

  function addRecord(it) {
    var li = el('li', { cls: 'demo-rec in' }, [
      el('p', { cls: 'demo-rec-h' }, [
        el('span', { cls: 'brand-mark', 'aria-hidden': 'true' }),
        el('span', { text: str(it.title) || 'K bot 패널 기록' }),
        Number(it.at) > 0 ? el('time', { text: kkClock(it.at) }) : null
      ]),
      el('p', { cls: 'demo-rec-t', text: str(it.text) })
    ]);
    R.recs.insertBefore(li, R.recs.firstChild);
    R.recs.hidden = false;
  }


  /* ══════════════════ 8. 재생 줄 ══════════════════
     항목마다 wait(ms) 기다린 뒤 그린다. 움직임 줄이기 설정이어도 간격은 그대로(움직임만 없앤다).
     start 응답 맨 앞의 wait 0 묶음은 방에 원래 있던 글(hist) — 움직임 · 안 읽은 수 없이 바로 그린다. */

  var Q = { items: [], timer: 0 };

  function play(items, fromStart) {
    var hist = !!fromStart;
    list(items).forEach(function (it) {
      if (!it || typeof it !== 'object') return;
      if (Number(it.wait) > 0) hist = false;
      Q.items.push({ it: it, hist: hist });
    });
    run();
  }

  function run() {
    if (Q.timer) return;
    while (Q.items.length) {
      var w = Math.min(MAX_WAIT, Math.max(0, Number(Q.items[0].it.wait) || 0));
      if (w > 0) {
        Q.timer = setTimeout(function () { Q.timer = 0; show(Q.items.shift()); run(); }, w);
        return;
      }
      show(Q.items.shift());
    }
  }

  function stopQueue() { clearTimeout(Q.timer); Q.timer = 0; Q.items = []; }

  function show(e) {
    var it = e.it;
    if (Number(it.at) > S.clock) { S.clock = Number(it.at); S.clockAt = Date.now(); }   // 지난 대화(hist)로 시계가 되돌지 않게
    if (it.t === 'day') addDay(it, e.hist);
    else if (it.t === 'feed') addFeed(it, e.hist);
    else if (it.t === 'msg') addMsg(it, e.hist);
    else if (it.t === 'hide') hideMsg(it.id);
    else if (it.t === 'member') setMember(it);
    else if (it.t === 'panel') addRecord(it);
    else if (it.t === 'hint') setHint(it.text);
  }


  /* ══════════════════ 9. 요청 줄 ══════════════════
     버튼은 언제나 누를 수 있다. 누른 일은 줄을 서서, 앞 요청의 state 를 받은 뒤 차례로 보낸다. */

  function enqueue(job) { S.jobs.push(job); pump(); }

  function pump() {
    if (S.busy || !S.jobs.length) return;
    var job = S.jobs.shift(), gen = S.gen;
    S.busy = true;
    Promise.resolve().then(function () { return job(gen); }).catch(function (e) {
      console.error(e);
    }).then(function () {
      if (gen !== S.gen) return;                   // 그사이 장면이 바뀌었다 — 새 장면의 줄은 start() 가 다시 돌린다
      S.busy = false;
      pump();
    });
  }

  /* 장면 시작(또는 다시 시작). 줄에 남은 일은 버린다 */
  function start(scene, opts) {
    var switching = !S.info || S.info.id !== scene;
    S.gen += 1;
    S.jobs = [];
    S.busy = false;
    S.scene = scene;
    S.opts = opts || {};
    S.info = null;                                 // 새 방이 뜰 때까지 손님 글은 받지 않는다
    markScene(scene);
    resetRoom();
    /* 다른 장면으로 바꾸는 중에는 앞 장면의 버튼을 누를 수 없게(흐리게) */
    R.wrap.classList.toggle('is-switching', switching);
    if (switching && knownScene(scene)) R.title.textContent = S.scenes[scene].title;
    enqueue(function (gen) {
      return api('/api/demo/start', { scene: scene, opts: S.opts }).then(function (r) {
        if (gen !== S.gen) return;
        var info = r.scene || {};
        R.wrap.classList.remove('is-switching');
        S.info = info;
        S.state = r.state;
        syncClock(r);
        renderRoom(info);
        renderInfo(info);
        play(r.out, true);
        toBottom();
      }, function (e) {
        if (gen !== S.gen) return;
        S.state = null;
        roomError(e);
        R.wrap.classList.remove('is-switching');
      });
    });
  }

  function step(ev) {
    enqueue(function (gen) {
      if (!S.state) return null;                   // 시작에 실패한 방 — [다시 시도] 를 기다린다
      return api('/api/demo/step', { state: S.state, ev: ev }).then(function (r) {
        if (gen !== S.gen) return;
        S.state = r.state;
        S.retried = false;
        if (R.hint.classList.contains('warn')) setHint('');   // 연결 오류 같은 경고는 다음 성공에서 지운다
        syncClock(r);
        /* 설명은 이번 단계의 것만 보인다: 이번 항목을 그리기 시작할 때 앞 단계의 설명을 지운다(빈 hint 항목) */
        play([{ t: 'hint', text: '' }].concat(list(r.out)), false);
      }, function (e) {
        if (gen !== S.gen) return;
        /* 서버가 state 를 못 읽으면 처음부터 — 처음 한 번은 조용히, 다시 시작한 뒤에도 또 그러면 서버 문구를 보인다 */
        if (e.code === 'bad_state') {
          var loud = S.retried;
          S.retried = true;
          start(S.scene, S.opts);
          if (loud) setHint(e.message, true);
          return;
        }
        setHint(e.net ? MSG_NET : e.message, true);
      });
    });
  }

  function act(id) { step({ type: 'act', id: id }); }

  /* 손님이 보낸 글은 바로 그린다. cid 는 이 글의 id — 서버가 가릴 때 쓴다 */
  function say(text) {
    var t = str(text).replace(/\r\n?/g, '\n').trim().slice(0, 1000);
    if (!t || !S.info) return;
    S.seq += 1;
    var cid = 'c' + S.seq + '-' + Date.now().toString(36);
    addMsg({ id: cid, from: 'me', text: t, at: nowAt() }, false, true);
    step({ type: 'say', text: t, cid: cid });
  }


  /* ══════════════════ 10. 입력 칸 ══════════════════
     Enter 보내기 · Shift+Enter 줄바꿈. 한글 조합 중 Enter(isComposing · 229)는 보내지 않는다. */

  function autoGrow() {
    R.ta.style.height = 'auto';
    R.ta.style.height = Math.min(R.ta.scrollHeight, 112) + 'px';
  }
  function syncSend() { R.send.disabled = !R.ta.value.trim(); }
  function submit() {
    var t = R.ta.value;
    if (!t.trim() || !S.info) return;
    R.ta.value = '';
    autoGrow();
    syncSend();
    say(t);
  }

  function bindComposer() {
    R.ta.addEventListener('input', function () { autoGrow(); syncSend(); });
    R.ta.addEventListener('keydown', function (ev) {
      if (ev.key !== 'Enter' || ev.shiftKey) return;
      if (ev.isComposing || ev.keyCode === 229) return;
      ev.preventDefault();
      submit();
    });
    R.form.addEventListener('submit', function (ev) { ev.preventDefault(); submit(); });
    /* 보내기를 눌러도 입력 칸에 커서가 남게(휴대폰 자판이 닫혔다 열리지 않게) */
    R.send.addEventListener('mousedown', function (ev) { if (document.activeElement === R.ta) ev.preventDefault(); });
    R.notice.addEventListener('click', function () {
      R.notice.setAttribute('aria-expanded', R.notice.getAttribute('aria-expanded') === 'true' ? 'false' : 'true');
    });
    R.newPill.addEventListener('click', function () {
      if (reducedMotion()) toBottom();
      else { R.log.scrollTo({ top: R.log.scrollHeight, behavior: 'smooth' }); hideNewPill(); }
    });
    R.log.addEventListener('scroll', function () { if (!R.newPill.hidden && nearBottom()) hideNewPill(); }, { passive: true });
    R.restart.addEventListener('click', function () { S.retried = false; start(S.scene, S.opts); });
  }


  /* ══════════════════ 11. 부팅 ══════════════════ */

  /* 목록에 있는 장면인가(#constructor 같은 이름이 원형에서 찾아지지 않게 제 칸만 본다) */
  function knownScene(id) { return Object.prototype.hasOwnProperty.call(S.scenes, id); }

  function sceneFromHash() {
    var h = '';
    try { h = decodeURIComponent((location.hash || '').slice(1)); } catch (e) { h = ''; }
    return knownScene(h) ? h : '';
  }

  function loadCatalog() {
    clear(R.log);
    R.log.appendChild(el('div', { cls: 'kk-state' }, [el('span', { cls: 'spin', 'aria-hidden': 'true' }), el('span', { text: MSG_LOADING })]));
    api('/api/demo').then(function (r) {
      S.groups = list(r.groups).filter(function (g) { return g && g.id; });
      renderScenes();
      var first = knownScene(r.first) ? r.first : (Object.keys(S.scenes)[0] || '');
      if (!first) throw new Error(MSG_FAIL);
      start(sceneFromHash() || first, {});
    }).catch(function (e) {
      clear(R.log);
      R.log.appendChild(el('div', { cls: 'kk-state' }, [
        el('span', { text: e && e.message ? e.message : MSG_FAIL }),
        el('button', { type: 'button', cls: 'btn', onclick: loadCatalog }, [icon('i-refresh', 14), '다시 시도'])
      ]));
    });
  }

  function boot() {
    R = {
      wrap: $('demoWrap'), scenes: $('demoScenes'),
      kind: $('demoKind'), title: $('demoTitle'), desc: $('demoDesc'), ctrls: $('demoCtrls'),
      play: $('demoPlay'), actsW: $('demoActsW'), acts: $('demoActs'), chipsW: $('demoChipsW'), chips: $('demoChips'),
      recs: $('demoRecs'), buy: $('demoBuy'), restart: $('demoRestart'),
      hint: $('demoHint'), hintT: $('demoHintT'), hintIc: document.querySelector('#demoHint > .ic'),
      lnav: $('lnav'), dev: document.querySelector('.kk-dev'),
      kk: $('kk'), name: $('kkName'), count: $('kkCount'), notice: $('kkNotice'), noticeT: $('kkNoticeT'),
      log: $('kkLog'), newPill: $('kkNew'), newWho: $('kkNewWho'), newT: $('kkNewT'),
      form: $('kkForm'), ta: $('kkText'), send: $('kkSend')
    };
    if (!R.wrap || !R.log) return;
    bindComposer();
    window.addEventListener('hashchange', function () {
      var sc = sceneFromHash();
      if (sc && sc !== S.scene) { S.retried = false; start(sc, {}); }
    });
    loadCatalog();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
