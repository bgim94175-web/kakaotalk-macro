(function () {
  var me = null;
  var account = null;
  var images = [];
  var imagesDirty = false;
  var triggers = [];
  var pendingId = '';
  var regDevice = '';
  var confirming = false;
  var stopConfirm = false;

  var login = document.getElementById('login');
  var app = document.getElementById('app');
  var who = document.getElementById('who');
  var logout = document.getElementById('logout');
  var runstate = document.getElementById('runstate');
  var list = document.getElementById('account-list');
  var detail = document.getElementById('detail');
  var passcode = document.getElementById('passcode');
  var tabsEl = document.getElementById('tabs');
  var consoleEl = document.getElementById('console');
  var settingsEl = document.getElementById('settings');
  var railEl = document.getElementById('rail');
  var railAccounts = document.getElementById('rail-accounts');
  var acctSel = document.getElementById('settings-acct');

  /* ── 탭 ─────────────────────────────────────────────────
     한 번에 한 가지만 보여 준다. 설정 하나를 고치려고 긴 화면을 훑지 않게 하고,
     탭마다 지금 값을 같이 적어 어디를 손봐야 하는지 바로 보이게 한다. */
  function tabButtons() {
    return tabsEl ? Array.prototype.slice.call(tabsEl.querySelectorAll('.tab')) : [];
  }
  function showTab(name) {
    if (!tabsEl) return;
    tabButtons().forEach(function (b) {
      b.setAttribute('aria-current', b.dataset.tab === name ? 'true' : 'false');
    });
    Array.prototype.forEach.call(document.querySelectorAll('[data-tab]'), function (node) {
      if (node.classList.contains('tab')) return;
      node.hidden = node.dataset.tab !== name;
    });
    // 'chat' 은 받은함(inbox) 모드, 나머지는 설정(settings) 모드. #inbox 가 data-tab="chat" 이라 위 루프가 전환을 만든다.
    var inbox = name === 'chat';
    var wasInbox = consoleEl.dataset.mode === 'inbox';
    consoleEl.dataset.mode = inbox ? 'inbox' : 'settings';
    settingsEl.hidden = inbox;
    // 채팅을 보고 있지 않으면 열어 둔 방을 계속 읽을 이유가 없다
    if (!inbox && chat.roomTimer) { clearInterval(chat.roomTimer); chat.roomTimer = null; }
    if (inbox && chat.openId && !chat.roomTimer) {
      loadThread(true);
      chat.roomTimer = setInterval(function () {
        if (document.hidden || !chat.openId) return;
        loadThread(false);
      }, 3000);
    }
    // 모드가 바뀔 때 포커스를 잃지 않게 한다
    if (!inbox && wasInbox) {
      var b = tabsEl.querySelector('.tab[data-tab="' + name + '"]');
      if (b) b.focus({ preventScroll: true });
    }
    if (inbox && !wasInbox && !isPhone()) {
      var s = document.getElementById('chat-search');
      if (s) s.focus({ preventScroll: true });
    }
  }
  function setTabsEnabled(on) {
    tabButtons().forEach(function (b) {
      if (b.dataset.tab !== 'account' && b.dataset.tab !== 'chat') b.disabled = !on;
    });
  }
  function sumText(name, value) {
    var n = tabsEl && tabsEl.querySelector('[data-sum="' + name + '"]');
    if (n) n.textContent = value || '';
  }
  function updateTabSummaries() {
    sumText('account', me && me.accounts ? me.accounts.length + '개' : '');
    if (!account) {
      ['chat', 'macro', 'visit', 'cover', 'profile', 'reply', 'snipe'].forEach(function (k) { sumText(k, ''); });
      return;
    }
    function rooms(v) { return (v || []).length; }
    var m = account.macro || {};
    sumText('macro', m.enabled ? '켜짐 · 방 ' + rooms(m.rooms) + '개' : '꺼짐');
    var v = account.visit || {};
    sumText('visit', v.enabled ? '켜짐 · 방 ' + rooms(v.rooms) + '개' : '꺼짐');
    var c = account.cover || {};
    sumText('cover', c.enabled ? '켜짐 · 방 ' + rooms(c.rooms) + '개' : '꺼짐');
    var pf = account.profile || {};
    sumText('profile', pf.enabled ? '켜짐 · 방 ' + rooms(pf.rooms) + '개' : '꺼짐');
    sumText('reply', (account.autoreply || {}).enabled ? '켜짐' : '꺼짐');
    var on = (account.triggers || []).filter(function (t) { return t && t.enabled !== false; }).length;
    sumText('snipe', on ? on + '개 켜짐' : '꺼짐');
  }

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

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
      throw err;
    }
    return json;
  }

  function reasonText(row) {
    if (!me || !me.sender_up) return (me && me.sender_reason) || '발송 프로세스가 멈춰 있습니다';
    if (row.connected) return '이 서버에서 보내는 중';
    if (row.needs_register) return '다시 등록이 필요합니다';
    if (row.linked) return '서버에 등록됨 · 접속을 붙이는 중';
    if (row.reason === 'kicked') return '다른 기기가 접속을 가져갔습니다';
    if (row.reason === 'unlinked') return '등록이 해제되었습니다';
    return '아직 발송 세션이 없습니다';
  }

  function showLogin() {
    document.body.dataset.screen = 'login';
    login.hidden = false;
    app.hidden = true;
    logout.hidden = true;
    who.textContent = '';
    chatReset();
  }

  function showApp() {
    document.body.dataset.screen = 'app';
    login.hidden = true;
    app.hidden = false;
    logout.hidden = false;
    who.textContent = me && me.mask ? me.mask : '';
    // 띠는 발송 작업 상태 하나만 말한다. /inbox 응답이 오면 그 값으로 덮어쓴다.
    inboxSt.senderUp = !!(me && me.sender_up);
    inboxSt.senderReason = (me && me.sender_reason) || '';
    updateStrip();
  }

  function renderAccounts() {
    updateTabSummaries();
    list.textContent = '';
    var rows = (me && me.accounts) || [];
    if (!rows.length) {
      list.appendChild(el('p', 'hint', '등록된 카카오 계정이 없습니다.'));
    }
    rows.forEach(function (row) {
      var box = el('div', 'account');
      var text = el('div');
      text.appendChild(el('strong', '', row.email));
      text.appendChild(el('span', '', reasonText(row)));
      var acts = el('div', 'account-actions');
      var toChat = el('button', 'btn ghost', '채팅');
      toChat.type = 'button';
      toChat.addEventListener('click', function () { openAccountSafe(row.device_id); });
      var toSettings = el('button', 'btn ghost', '설정');
      toSettings.type = 'button';
      toSettings.addEventListener('click', function () { openAccountSafe(row.device_id, 'macro'); });
      acts.appendChild(toChat);
      acts.appendChild(toSettings);
      box.appendChild(text);
      box.appendChild(acts);
      list.appendChild(box);
    });
    seedAccountsFromMe();
    renderRail();
    fillAcctSelect();
    updateStrip();
    updateUnread();
  }

  function dataUrl(b64) {
    var s = String(b64 || '');
    if (s.indexOf('data:') === 0) return s;
    var mime = 'image/jpeg';
    if (s.indexOf('iVBOR') === 0) mime = 'image/png';
    else if (s.indexOf('UklG') === 0) mime = 'image/webp';
    return 'data:' + mime + ';base64,' + s;
  }

  function renderThumbs() {
    var box = document.getElementById('thumbs');
    box.textContent = '';
    images.forEach(function (b64, i) {
      var item = el('div', 'thumb');
      var img = document.createElement('img');
      img.alt = '첨부 ' + (i + 1);
      img.src = dataUrl(b64);
      var rm = el('button', 'btn ghost', '빼기');
      rm.type = 'button';
      rm.addEventListener('click', function () {
        images.splice(i, 1);
        imagesDirty = true;
        renderThumbs();
      });
      item.appendChild(img);
      item.appendChild(rm);
      box.appendChild(item);
    });
  }

  function roomRow(room, selected, cool) {
    var row = el('label', 'room');
    var box = document.createElement('input');
    box.type = 'checkbox';
    box.checked = selected;
    box.dataset.key = room.key;
    var name = el('span', 'name', room.name || '대화방');
    var input = document.createElement('input');
    input.type = 'number';
    input.min = '1';
    input.max = '1440';
    input.className = 'cool';
    input.placeholder = '기본';
    input.setAttribute('aria-label', (room.name || '대화방') + ' 간격(분)');
    if (cool >= 1) input.value = String(cool);
    row.appendChild(box);
    row.appendChild(name);
    row.appendChild(input);
    return row;
  }

  function checkRow(room, selected) {
    var row = el('label', 'room plain');
    var box = document.createElement('input');
    box.type = 'checkbox';
    box.checked = selected;
    box.dataset.key = room.key;
    row.appendChild(box);
    row.appendChild(el('span', 'name', room.name || '대화방'));
    return row;
  }

  function fillChecks(id, rooms, picked) {
    var box = document.getElementById(id);
    box.textContent = '';
    if (!rooms.length) {
      box.appendChild(el('p', 'hint', '없음'));
      return;
    }
    rooms.forEach(function (room) {
      if (!room || room.list_kind === 'open_dm') return;
      box.appendChild(checkRow(room, picked.indexOf(room.key) >= 0));
    });
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

  function fillRooms(id, rooms, picked, cool) {
    var box = document.getElementById(id);
    box.textContent = '';
    if (!rooms.length) {
      box.appendChild(el('p', 'hint', '없음'));
      return;
    }
    rooms.forEach(function (room) {
      if (!room || room.list_kind === 'open_dm') return;
      var on = picked.indexOf(room.key) >= 0;
      box.appendChild(roomRow(room, on, cool[room.key]));
    });
  }

  function selectedRooms() {
    var keys = [];
    var cool = {};
    document.querySelectorAll('#rooms-open .room').forEach(function (row) {
      var box = row.querySelector('input[type="checkbox"]');
      var num = row.querySelector('input[type="number"]');
      if (!box || !box.checked || !box.dataset.key) return;
      keys.push(box.dataset.key);
      var n = parseInt(num && num.value, 10);
      if (n >= 1) cool[box.dataset.key] = n;
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

  function renderTriggers() {
    var box = document.getElementById('triggers');
    box.textContent = '';
    if (!triggers.length) {
      box.appendChild(el('p', 'hint', '규칙이 없습니다.'));
      return;
    }
    var choices = roomChoices();
    triggers.forEach(function (t, index) {
      var card = el('div', 'trigger');
      var on = document.createElement('input');
      on.type = 'checkbox';
      on.checked = t.enabled !== false;
      on.addEventListener('change', function () { triggers[index].enabled = on.checked; });
      card.appendChild(el('label', 'check', ''));
      card.lastChild.appendChild(on);
      card.lastChild.appendChild(document.createTextNode(' 사용'));

      function field(label, value, fn) {
        card.appendChild(el('label', '', label));
        var input = document.createElement('input');
        input.type = 'text';
        input.value = value || '';
        input.addEventListener('input', function () { fn(input.value); });
        card.appendChild(input);
      }
      field('이름', t.name, function (v) { triggers[index].name = v; });
      field('감지할 말', t.pattern, function (v) { triggers[index].pattern = v; });

      card.appendChild(el('label', '', '맞는 방식'));
      var mode = document.createElement('select');
      [['contains', '포함'], ['exact', '같음']].forEach(function (pair) {
        var o = document.createElement('option');
        o.value = pair[0];
        o.textContent = pair[1];
        if ((t.mode || 'contains') === pair[0]) o.selected = true;
        mode.appendChild(o);
      });
      if (t.mode === 'starts' || t.mode === 'regex') {
        var extra = document.createElement('option');
        extra.value = t.mode;
        extra.textContent = t.mode === 'regex' ? '정규식' : '시작';
        extra.selected = true;
        mode.appendChild(extra);
      }
      mode.addEventListener('change', function () { triggers[index].mode = mode.value; });
      card.appendChild(mode);

      card.appendChild(el('label', '', '보낼 말'));
      var reply = document.createElement('textarea');
      reply.rows = 2;
      reply.value = t.reply || '';
      reply.addEventListener('input', function () { triggers[index].reply = reply.value; });
      card.appendChild(reply);

      card.appendChild(el('label', '', '다시 반응하기까지 (초)'));
      var sec = document.createElement('input');
      sec.type = 'number';
      sec.min = '0';
      sec.max = '86400';
      sec.value = String(t.cooldown_sec == null ? 60 : t.cooldown_sec);
      sec.addEventListener('input', function () { triggers[index].cooldown_sec = Number(sec.value); });
      card.appendChild(sec);

      var once = document.createElement('input');
      once.type = 'checkbox';
      once.checked = !!t.once;
      once.addEventListener('change', function () { triggers[index].once = once.checked; });
      var onceLabel = el('label', 'check', '');
      onceLabel.appendChild(once);
      onceLabel.appendChild(document.createTextNode(' 이 방에서 한 번만'));
      card.appendChild(onceLabel);

      card.appendChild(el('label', '', '감지할 방'));
      var picks = el('div', 'rooms');
      var chosen = {};
      (t.rooms || []).forEach(function (k) { chosen[k] = true; });
      if (!choices.length) picks.appendChild(el('p', 'hint', '대화방을 불러온 뒤에 고릅니다. 비우면 오픈채팅방 전체입니다.'));
      choices.forEach(function (room) {
        var lab = el('label', 'check', '');
        var cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.checked = !!chosen[room.key];
        cb.addEventListener('change', function () {
          var cur = triggers[index].rooms || [];
          if (cb.checked) cur.push(room.key);
          else cur = cur.filter(function (k) { return k !== room.key; });
          triggers[index].rooms = cur;
        });
        lab.appendChild(cb);
        lab.appendChild(document.createTextNode(' ' + (room.name || '대화방')));
        picks.appendChild(lab);
      });
      card.appendChild(picks);

      card.appendChild(el('label', '', '답할 방'));
      var target = document.createElement('select');
      var same = document.createElement('option');
      same.value = '';
      same.textContent = '감지된 그 방';
      target.appendChild(same);
      choices.forEach(function (room) {
        var o = document.createElement('option');
        o.value = room.key;
        o.textContent = room.name || '대화방';
        if (t.target === room.key) o.selected = true;
        target.appendChild(o);
      });
      target.addEventListener('change', function () { triggers[index].target = target.value; });
      card.appendChild(target);

      var rm = el('button', 'btn ghost', '이 규칙 삭제');
      rm.type = 'button';
      rm.addEventListener('click', function () {
        triggers.splice(index, 1);
        renderTriggers();
      });
      card.appendChild(rm);
      box.appendChild(card);
    });
  }

  function fillDetail() {
    if (!account) {
      detail.hidden = true;
      return;
    }
    detail.hidden = false;
    document.getElementById('detail-where').textContent = account.email + ' · ' + reasonText(account);
    var m = account.macro || {};
    document.getElementById('macro-on').checked = !!m.enabled;
    document.getElementById('macro-message').value = m.message || '';
    document.getElementById('base-min').value = String(m.baseMin || 1);
    document.getElementById('random-min').value = String(m.randomMin || 0);
    document.getElementById('base-view').textContent = '~' + (m.baseMin || 1) + '분';
    images = (account.images || []).slice(0, 5);
    imagesDirty = false;
    renderThumbs();
    var cool = m.roomCooldownMin || {};
    var picked = m.rooms || [];
    var rooms = account.rooms || { open: [], normal: [] };
    fillRooms('rooms-open', rooms.open || [], picked, cool);
    var visit = account.visit || {};
    document.getElementById('visit-on').checked = !!visit.enabled;
    var visitPicked = visit.rooms || [];
    fillChecks('visit-open', rooms.open || [], visitPicked);
    var cover = account.cover || {};
    document.getElementById('cover-on').checked = !!cover.enabled;
    fillChecks('cover-open', rooms.open || [], cover.rooms || []);
    var profile = account.profile || {};
    document.getElementById('profile-on').checked = !!profile.enabled;
    fillChecks('profile-open', rooms.open || [], profile.rooms || []);
    var a = account.autoreply || {};
    document.getElementById('reply-on').checked = !!a.enabled;
    document.getElementById('reply-message').value = a.message || '';
    document.getElementById('reply-hours').value = String(a.cooldown_hours == null ? 6 : a.cooldown_hours);
    triggers = (account.triggers || []).map(function (t) { return Object.assign({}, t); });
    renderTriggers();
    updateTabSummaries();
  }

  async function refreshMe() {
    me = await api('/panel/api/me');
    showApp();
    renderAccounts();
    // 로그인 폼에서 처음 들어오는 길도 여기다 — 아직 콘솔이 뜨지 않았으면 부팅 표(UI_V4 1장)대로 연다.
    if (!inboxSt.booted) { bootConsole(); return; }
    loadInbox(true);
    if (!inboxSt.timer) scheduleInbox();
  }

  async function openAccount(id, tab) {
    say('room-error', '');
    say('macro-error', '');
    var res = await api('/panel/api/account?device_id=' + encodeURIComponent(id));
    account = res.account;
    fillDetail();
    fillAcctSelect();
    setTabsEnabled(true);
    if (tab) {
      showTab(tab);
      if (isPhone()) { var panes = document.querySelector('.panes'); if (panes) panes.scrollTop = 0; }
      return;
    }
    // 탭 없이 부르면 받은함으로 — 그 계정 필터. 등록 완료 뒤의 openAccount(view.device_id) 가 이 분기로 온다.
    // showTab 을 먼저 해야 selectRail 이 설정 모드 분기(openAccount 재호출)를 타지 않는다.
    showTab('chat');
    selectRail(id);
    loadInbox(true);
  }
  function openAccountSafe(id, tab) {
    return openAccount(id, tab).catch(function (e) {
      showTab('account');
      say('add-error', (e && e.message) || '처리하지 못했습니다.');
    });
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

  function showPass(view) {
    passcode.hidden = false;
    var hasCode = !!view.passcode;
    document.getElementById('code-title').textContent = hasCode ? '카카오톡에 입력할 번호' : '카카오 응답';
    document.getElementById('code').hidden = !hasCode;
    document.getElementById('code').textContent = view.passcode || '';
    document.getElementById('code-left').textContent = view.remaining_seconds
      ? '유효 시간 약 ' + Math.ceil(view.remaining_seconds / 60) + '분'
      : '';
    document.getElementById('code-wait').hidden = !hasCode;
    document.getElementById('force').hidden = !view.can_force;
    say('code-error', view.text || '');
    pendingId = view.pending_id || pendingId;
    if (view.device_id) regDevice = view.device_id;
  }

  function hidePass() {
    passcode.hidden = true;
    pendingId = '';
    stopConfirm = true;
    say('code-error', '');
    document.getElementById('code').textContent = '';
  }

  function sleep(ms) {
    return new Promise(function (resolve) { setTimeout(resolve, ms); });
  }

  async function confirmLoop() {
    if (confirming) return;
    confirming = true;
    stopConfirm = false;
    try {
      while (!stopConfirm && pendingId) {
        var view = null;
        try {
          view = await api('/panel/api/register/confirm', { pending_id: pendingId });
        } catch (e) {
          if (stopConfirm) return;
          if (e && (e.status === 401 || e.status === 403)) {
            say('code-error', e.message || '다시 로그인해 주세요.');
            return;
          }
          document.getElementById('code-wait').textContent = '아직 카카오톡에서 확인되지 않았습니다. 계속 기다립니다.';
          say('code-error', '연결이 잠깐 끊겼습니다. 카카오톡 확인을 계속 기다립니다.');
          await sleep(2000);
          continue;
        }
        if (stopConfirm) return;
        if (view.state === 'ok') {
          document.getElementById('add-form').dataset.reauth = '';
          hidePass();
          document.getElementById('password').value = '';
          await refreshMe();
          if (view.device_id) await openAccount(view.device_id);
          return;
        }
        if (view.state === 'waiting') {
          document.getElementById('code-wait').textContent = '아직 카카오톡에서 확인되지 않았습니다. 계속 기다립니다.';
          say('code-error', '');
          await sleep(2000);
          continue;
        }
        showPass(view);
        document.getElementById('code-wait').textContent = '';
        return;
      }
    } finally {
      confirming = false;
    }
  }

  document.getElementById('login-form').addEventListener('submit', async function (ev) {
    ev.preventDefault();
    say('login-error', '');
    var btn = ev.target.querySelector('button');
    btn.disabled = true;
    try {
      await api('/panel/api/login', { key: document.getElementById('key').value });
      document.getElementById('key').value = '';
      await refreshMe();
    } catch (e) {
      say('login-error', e.message);
    } finally {
      btn.disabled = false;
    }
  });

  logout.addEventListener('click', async function () {
    await api('/panel/api/logout', {});
    me = null;
    account = null;
    showLogin();
  });

  document.getElementById('add-form').addEventListener('submit', async function (ev) {
    ev.preventDefault();
    say('add-error', '');
    var btn = ev.target.querySelector('button');
    btn.disabled = true;
    try {
      var body = {
        email: document.getElementById('email').value,
        password: document.getElementById('password').value,
      };
      if (ev.target.dataset.reauth === '1' && regDevice) body.device_id = regDevice;
      var view = await api('/panel/api/register/begin', body);
      if (view.device_id) regDevice = view.device_id;
      if (view.state === 'ok') {
        document.getElementById('password').value = '';
        ev.target.dataset.reauth = '';
        hidePass();
        await refreshMe();
        if (view.device_id) await openAccount(view.device_id);
        return;
      }
      if (view.state === 'confirm_on_phone') {
        showPass(view);
        confirmLoop();
        return;
      }
      showPass(view);
      if (!view.passcode) passcode.hidden = false;
    } catch (e) {
      say('add-error', e.message);
    } finally {
      btn.disabled = false;
    }
  });

  document.getElementById('force').addEventListener('click', function () {
    var body = {
      email: document.getElementById('email').value,
      password: document.getElementById('password').value,
      forced: true,
    };
    if (document.getElementById('add-form').dataset.reauth === '1' && regDevice) body.device_id = regDevice;
    api('/panel/api/register/begin', body).then(function (view) {
      if (view.device_id) regDevice = view.device_id;
      if (view.state === 'confirm_on_phone') {
        showPass(view);
        confirmLoop();
      } else if (view.state === 'ok') {
        document.getElementById('password').value = '';
        hidePass();
        return refreshMe().then(function () {
          if (view.device_id) return openAccount(view.device_id);
        });
      } else {
        showPass(view);
      }
    }).catch(function (e) { say('code-error', e.message); });
  });

  document.getElementById('cancel-code').addEventListener('click', async function () {
    stopConfirm = true;
    var id = pendingId;
    hidePass();
    if (id) {
      try { await api('/panel/api/register/cancel', { pending_id: id }); } catch (e) { /* 화면은 닫는다 */ }
    }
  });

  document.getElementById('base-min').addEventListener('input', function () {
    var n = parseInt(this.value, 10);
    if (!(n >= 1)) n = 1;
    document.getElementById('base-view').textContent = '~' + n + '분';
  });

  document.getElementById('images').addEventListener('change', async function () {
    say('macro-error', '');
    var files = Array.prototype.slice.call(this.files || []).slice(0, 5);
    try {
      var next = [];
      for (var i = 0; i < files.length; i++) next.push(await readFile(files[i]));
      images = next;
      imagesDirty = true;
      renderThumbs();
    } catch (e) {
      say('macro-error', e.message);
    }
    this.value = '';
  });

  document.getElementById('macro-form').addEventListener('submit', async function (ev) {
    ev.preventDefault();
    if (!account) return;
    say('macro-error', '');
    var picked = selectedRooms();
    var body = {
      device_id: account.device_id,
      macro: {
        enabled: document.getElementById('macro-on').checked,
        message: document.getElementById('macro-message').value,
        baseMin: Number(document.getElementById('base-min').value),
        randomMin: Number(document.getElementById('random-min').value),
        rooms: picked.rooms,
        roomCooldownMin: picked.roomCooldownMin,
      },
    };
    if (imagesDirty) body.images = images;
    else body.images_unchanged = true;
    var btn = ev.target.querySelector('button[type="submit"]');
    btn.disabled = true;
    try {
      var res = await api('/panel/api/settings', body);
      account = res.account;
      fillDetail();
      await refreshMe();
    } catch (e) {
      say('macro-error', e.message);
    } finally {
      btn.disabled = false;
    }
  });

  document.getElementById('visit-form').addEventListener('submit', async function (ev) {
    ev.preventDefault();
    if (!account) return;
    say('visit-error', '');
    var btn = ev.target.querySelector('button');
    btn.disabled = true;
    try {
      var res = await api('/panel/api/settings', {
        device_id: account.device_id,
        images_unchanged: true,
        visit: {
          enabled: document.getElementById('visit-on').checked,
          rooms: checkedRooms('#visit-open'),
        },
      });
      account = res.account;
      fillDetail();
    } catch (e) {
      say('visit-error', e.message);
    } finally {
      btn.disabled = false;
    }
  });

  document.getElementById('cover-form').addEventListener('submit', async function (ev) {
    ev.preventDefault();
    if (!account) return;
    say('cover-error', '');
    var btn = ev.target.querySelector('button');
    btn.disabled = true;
    try {
      var res = await api('/panel/api/settings', {
        device_id: account.device_id,
        images_unchanged: true,
        cover: {
          enabled: document.getElementById('cover-on').checked,
          rooms: checkedRooms('#cover-open'),
        },
      });
      account = res.account;
      fillDetail();
    } catch (e) {
      say('cover-error', e.message);
    } finally {
      btn.disabled = false;
    }
  });

  document.getElementById('profile-form').addEventListener('submit', async function (ev) {
    ev.preventDefault();
    if (!account) return;
    say('profile-error', '');
    var btn = ev.target.querySelector('button');
    btn.disabled = true;
    try {
      var res = await api('/panel/api/settings', {
        device_id: account.device_id,
        images_unchanged: true,
        profile: {
          enabled: document.getElementById('profile-on').checked,
          rooms: checkedRooms('#profile-open'),
        },
      });
      account = res.account;
      fillDetail();
    } catch (e) {
      say('profile-error', e.message);
    } finally {
      btn.disabled = false;
    }
  });

  document.getElementById('reply-form').addEventListener('submit', async function (ev) {
    ev.preventDefault();
    if (!account) return;
    say('reply-error', '');
    var btn = ev.target.querySelector('button');
    btn.disabled = true;
    try {
      var res = await api('/panel/api/settings', {
        device_id: account.device_id,
        images_unchanged: true,
        autoreply: {
          enabled: document.getElementById('reply-on').checked,
          message: document.getElementById('reply-message').value,
          cooldown_hours: Number(document.getElementById('reply-hours').value),
        },
      });
      account = res.account;
      fillDetail();
    } catch (e) {
      say('reply-error', e.message);
    } finally {
      btn.disabled = false;
    }
  });

  document.getElementById('add-trigger').addEventListener('click', function () {
    triggers.push({
      name: '', pattern: '', mode: 'contains', reply: '', enabled: true,
      cooldown_sec: 60, once: false, rooms: [], target: '',
    });
    renderTriggers();
  });

  document.getElementById('save-triggers').addEventListener('click', async function () {
    if (!account) return;
    say('snipe-error', '');
    this.disabled = true;
    try {
      var res = await api('/panel/api/settings', {
        device_id: account.device_id,
        images_unchanged: true,
        triggers: triggers,
      });
      account = res.account;
      fillDetail();
    } catch (e) {
      say('snipe-error', e.message);
    } finally {
      this.disabled = false;
    }
  });

  document.getElementById('reload-rooms').addEventListener('click', async function () {
    if (!account) return;
    say('room-error', '');
    this.disabled = true;
    try {
      var res = await api('/panel/api/rooms', { device_id: account.device_id });
      account = res.account;
      fillDetail();
    } catch (e) {
      var msg = e && e.status ? e.message : '대화방 목록을 가져오지 못했습니다. 잠시 뒤 다시 눌러 주세요.';
      say('room-error', msg);
    } finally {
      this.disabled = false;
    }
  });

  var again = el('button', 'btn ghost', '이 계정 다시 등록');
  again.type = 'button';
  again.addEventListener('click', function () {
    if (!account) return;
    regDevice = account.device_id;
    document.getElementById('add-form').dataset.reauth = '1';
    document.getElementById('email').value = account.email || '';
    document.getElementById('add-form').scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
  var unlink = el('button', 'btn ghost', '이 계정 등록 해제');
  unlink.type = 'button';
  unlink.addEventListener('click', async function () {
    if (!account) return;
    if (!window.confirm('이 계정의 서버 발송을 해제합니다.')) return;
    try {
      await api('/panel/api/unlink', { device_id: account.device_id });
      account = null;
      detail.hidden = true;
      chatReset();
      await refreshMe();
    } catch (e) {
      say('macro-error', e.message);
    }
  });
  var actions = el('div', 'row-actions');
  actions.dataset.tab = 'account';   // 계정 손보는 버튼이니 계정 탭에 둔다
  actions.appendChild(again);
  actions.appendChild(unlink);
  document.getElementById('detail').insertBefore(actions, document.getElementById('macro-title').parentNode);

  // ── 통합 받은함 (docs/UI_V4.md 5장) ───────────────────────────
  // 계정 레일 + 대화 열 + 대화 창. 목록은 /panel/api/inbox 를 9초마다, 열린 대화는 3초마다 읽는다.
  // 답장은 그 대화를 받은 계정이 보낸다 — 전송 device_id 는 열린 행의 data-device 에서만 온다.
  var ui = { filter: '', query: '', unreadOnly: false };                 // '' = 전체
  var inboxSt = { accounts: [], chats: [], byDevice: {}, prevUnread: {}, sig: '', railSig: '',
                  busy: false, again: false, seq: 0, timer: null, fails: 0,
                  senderUp: true, senderReason: '', loaded: false, hiddenAt: 0, booted: false };
  var chat = { deviceId: '', openId: '', openName: '',
               roomBusy: false, roomAgain: false, sending: false,
               roomTimer: null, roomSig: '', renderedIds: {} };
  var kkt = document.getElementById('kkt');
  var chatRooms = document.getElementById('chat-rooms');
  var chatLog = document.getElementById('chat-log');
  var chatText = document.getElementById('chat-text');
  var chatSend = document.getElementById('chat-send');
  var chatPeer = document.getElementById('chat-peer');
  var chatNote = document.getElementById('chat-note');
  var chatHeadAva = document.getElementById('chat-head-ava');
  var chatHeadSub = document.getElementById('chat-head-sub');
  var chatForm = document.getElementById('chat-form');
  var chatTitle = document.getElementById('chat-title');
  var chatSearch = document.getElementById('chat-search');
  var chatUnread = document.getElementById('chat-unread');
  var chatNotice = document.getElementById('chat-notice');
  var threadState = document.getElementById('thread-state');
  var threadSettings = document.getElementById('thread-settings');
  var chatNewpill = document.getElementById('chat-newpill');
  var chatCount = document.getElementById('chat-count');
  var chatLive = document.getElementById('chat-live');
  var chatBack = document.getElementById('chat-back');
  var ACC_COLORS = ['var(--acc-0)', 'var(--acc-1)', 'var(--acc-2)', 'var(--acc-3)', 'var(--acc-4)', 'var(--acc-5)', 'var(--acc-6)', 'var(--acc-7)'];
  var STATE_LABEL = { live: '접속 중', linking: '연결 대기', needs_register: '등록 필요', error: '응답 없음', sender_down: '발송 중지' };
  var STRIP_DOWN = '발송 작업이 멈춰 있습니다. 작업이 다시 시작되면 저장된 계정으로 이어서 접속합니다.';

  function isPhone() { return window.matchMedia('(max-width: 719px)').matches; }
  function keyOf(device, id) { return device + '/' + id; }
  function openKey() { return chat.openId ? keyOf(chat.deviceId, chat.openId) : ''; }
  function accOf(id) {
    for (var i = 0; i < inboxSt.accounts.length; i++) if (inboxSt.accounts[i].device_id === id) return inboxSt.accounts[i];
    return null;
  }
  function accColor(id) {
    var i = inboxSt.accounts.map(function (a) { return a.device_id; }).indexOf(id);
    return ACC_COLORS[(i < 0 ? 0 : i) % 8];
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
  function currentTab() { var b = tabsEl.querySelector('.tab[aria-current="true"]'); return b ? b.dataset.tab : 'account'; }
  function fmtNum(n) { return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ','); }

  var AVA_COLORS = ['#6c8ebf', '#7e9f6b', '#b9795b', '#8a6fb0', '#c08a4e', '#5aa2a2', '#b56a8a', '#5f87b5', '#7a9a3e', '#a4704f'];
  function avaColor(name) {
    var s = String(name || '');
    var h = 0;
    for (var i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
    return AVA_COLORS[h % AVA_COLORS.length];
  }
  function initialOf(name) {
    var s = String(name || '').trim();
    return s ? s.slice(0, 1).toUpperCase() : '?';
  }
  function sameSender(a, b) {
    if (!a || !b || a.mine !== b.mine) return false;
    if (a.mine) return true;
    // 보낸 사람 아이디가 있으면 그걸로 묶는다. 이름은 비어 올 수 있다.
    if (a.author_id || b.author_id) return a.author_id === b.author_id;
    return (a.author || '') === (b.author || '');
  }
  function bigGap(a, b) {
    return Math.abs((Number(b.at) || 0) - (Number(a.at) || 0)) > 5 * 60 * 1000;
  }
  function updateComposeState() {
    if (!chatForm || !chatText) return;
    if (chatText.value.trim()) chatForm.classList.add('has-text');
    else chatForm.classList.remove('has-text');
  }
  function clearHead() {
    if (chatHeadAva) {
      chatHeadAva.className = 'kkt-head-ava ava';
      chatHeadAva.textContent = '';
      chatHeadAva.style.removeProperty('--ava');
    }
    if (chatHeadSub) chatHeadSub.textContent = '';
  }

  function fmtTime(ms) {
    var d = new Date(Number(ms) || 0);
    if (!ms || isNaN(d.getTime())) return '';
    var h = d.getHours();
    var m = d.getMinutes();
    var ap = h < 12 ? '오전' : '오후';
    var hh = h % 12;
    if (hh === 0) hh = 12;
    return ap + ' ' + hh + ':' + (m < 10 ? '0' + m : m);
  }
  function fmtDay(ms) {
    var d = new Date(Number(ms) || 0);
    if (!ms || isNaN(d.getTime())) return '';
    return d.getFullYear() + '년 ' + (d.getMonth() + 1) + '월 ' + d.getDate() + '일';
  }
  // 대화 열의 시각: 오늘은 시각, 올해는 월일, 다른 해는 연월일
  function fmtListTime(ms) {
    var d = new Date(Number(ms) || 0);
    if (!ms || isNaN(d.getTime())) return '';
    var now = new Date();
    if (d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate()) return fmtTime(ms);
    if (d.getFullYear() === now.getFullYear()) return (d.getMonth() + 1) + '월 ' + d.getDate() + '일';
    var mm = d.getMonth() + 1;
    var dd = d.getDate();
    return d.getFullYear() + '.' + (mm < 10 ? '0' + mm : mm) + '.' + (dd < 10 ? '0' + dd : dd);
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
      else if (st === 'sender_down') ph = '발송 작업 중지';
    }
    chatText.placeholder = ph;
  }
  function logEmpty(text) { return el('p', 'kkt-empty', text); }

  // ── 계정 상태 ─────────────────────────────────────────────
  // /me 가 올 때마다 레일을 먼저 그린다. /inbox 첫 응답이 status 를 덮어쓴다.
  function seedAccountsFromMe() {
    var prev = {};
    inboxSt.accounts.forEach(function (a) { prev[a.device_id] = a; });
    var up = !!(me && me.sender_up);
    inboxSt.accounts = ((me && me.accounts) || []).map(function (r) {
      var old = prev[r.device_id];
      return {
        device_id: r.device_id, email: r.email || '',
        status: !up ? 'sender_down' : (r.needs_register ? 'needs_register' : 'live'),
        reason: r.reason || '', connected: !!r.connected,
        unread: old ? old.unread : 0, chats: old ? old.chats : 0, error: '',
      };
    });
    inboxSt.senderUp = up;
    inboxSt.senderReason = (me && me.sender_reason) || '';
    Object.keys(inboxSt.byDevice).forEach(function (k) { if (!accOf(k)) delete inboxSt.byDevice[k]; });
  }
  function fillAcctSelect() {
    if (!acctSel) return;
    acctSel.textContent = '';
    if (!inboxSt.accounts.length) {
      var none = document.createElement('option');
      none.value = '';
      none.textContent = '계정 없음';
      acctSel.appendChild(none);
      acctSel.disabled = true;
      return;
    }
    acctSel.disabled = false;
    inboxSt.accounts.forEach(function (a) {
      var o = document.createElement('option');
      o.value = a.device_id;
      o.textContent = a.email;
      acctSel.appendChild(o);
    });
    var want = (account && account.device_id) || ui.filter || inboxSt.accounts[0].device_id;
    if (accOf(want)) acctSel.value = want;
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
  function updateUnread() {
    var total = totalUnread();
    sumText('chat', total ? '안 읽음 ' + total : (inboxSt.chats.length ? '대화 ' + inboxSt.chats.length + '개' : ''));
    document.title = (total ? '(' + total + ') ' : '') + '관리 · K bot';
    var n = document.getElementById('chat-unread-n');
    if (n) { n.textContent = total ? String(total) : ''; n.hidden = !total; }
  }
  function badgeText(n) { return n > 99 ? '99+' : String(n); }

  // ── 레일 ──────────────────────────────────────────────────
  function renderRail() {
    if (!railAccounts) return;
    var total = totalUnread();
    var sig = inboxSt.accounts.map(function (a) {
      return a.device_id + '\u0001' + stateOf(a.device_id) + '\u0001' + unreadOf(a.device_id) + '\u0001' + a.email;
    }).join('|') + '#' + ui.filter + '#' + total;
    if (sig === inboxSt.railSig) return;
    inboxSt.railSig = sig;
    var all = document.getElementById('rail-all');
    if (all) {
      all.setAttribute('aria-current', ui.filter ? 'false' : 'true');
      all.setAttribute('aria-label', '전체 대화' + (total ? ' · 안 읽음 ' + total : ''));
      var ab = all.querySelector('.rail-badge');
      if (ab) { ab.textContent = total ? badgeText(total) : ''; ab.hidden = !total; }
    }
    railAccounts.textContent = '';
    inboxSt.accounts.forEach(function (a, i) {
      var st = stateOf(a.device_id);
      var n = unreadOf(a.device_id);
      var b = el('button', 'rail-btn rail-acct');
      b.type = 'button';
      b.dataset.device = a.device_id;
      b.dataset.state = st;
      b.setAttribute('aria-current', ui.filter === a.device_id ? 'true' : 'false');
      b.setAttribute('aria-label', a.email + ' · ' + stateLabel(st) + (n ? ' · 안 읽음 ' + n : ''));
      b.style.setProperty('--ava', ACC_COLORS[i % 8]);
      var ava = el('span', 'ava ava-rail', initialOf(a.email));
      ava.setAttribute('aria-hidden', 'true');
      var dot = el('span', 'rail-dot');
      dot.setAttribute('aria-hidden', 'true');
      var badge = el('span', 'rail-badge', n ? badgeText(n) : '');
      badge.setAttribute('aria-hidden', 'true');
      badge.hidden = !n;
      var tip = el('span', 'rail-tip', a.email);
      tip.setAttribute('aria-hidden', 'true');
      tip.appendChild(el('small', '', stateLabel(st)));
      b.appendChild(ava);
      b.appendChild(dot);
      b.appendChild(badge);
      b.appendChild(tip);
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
    var ico = el('span', 'kkt-empty-ico');
    ico.setAttribute('aria-hidden', 'true');
    ico.innerHTML = '<svg viewBox="0 0 24 24" width="28" height="28" aria-hidden="true"><path d="M4 5.5A2.5 2.5 0 0 1 6.5 3h11A2.5 2.5 0 0 1 20 5.5v8a2.5 2.5 0 0 1-2.5 2.5H9l-4.2 3.4A.5.5 0 0 1 4 19V5.5Z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg>';
    box.appendChild(ico);
    box.appendChild(el('b', 'kkt-empty-title', title));
    box.appendChild(el('span', 'kkt-empty-text', text));
    if (action) {
      var btn = el('button', 'btn', action.label);
      btn.type = 'button';
      btn.addEventListener('click', action.fn);
      box.appendChild(btn);
    }
    return box;
  }
  function goRegister() {
    showTab('account');
    var email = document.getElementById('email');
    if (email && !isPhone()) email.focus();
  }
  function renderConvList() {
    if (!chatRooms) return;
    var rows = visibleRows();
    var chip = !ui.filter && inboxSt.accounts.length > 1;
    var sig = rows.map(function (c) {
      return c.device_id + '\u0001' + c.chat_id + '\u0001' + c.unread + '\u0001' + c.last_at + '\u0001' + c.name + '\u0001' + c.preview;
    }).join('|') + '#' + openKey() + '#' + ui.filter + '#' + ui.query + '#' + (ui.unreadOnly ? 1 : 0)
      + '#' + (inboxSt.accounts.length > 1 ? 'chip' : '') + '#' + inboxSt.accounts.length + '#' + (inboxSt.loaded ? 1 : 0);
    // 바뀐 게 없으면 그대로 둔다. 9초마다 새로 그리면 마우스·포커스가 끊긴다.
    if (sig === inboxSt.sig) return;
    inboxSt.sig = sig;
    var focusKey = '';
    var ae = document.activeElement;
    if (ae && chatRooms.contains(ae)) {
      var fr = ae.closest ? ae.closest('.kkt-row') : null;
      if (fr) focusKey = fr.dataset.key || '';
    }
    chatRooms.textContent = '';
    if (!inboxSt.accounts.length) {
      chatRooms.appendChild(emptyBox('등록된 계정 없음', '계정을 등록하면 갠톡이 여기에 모입니다.', { label: '계정 등록', fn: goRegister }));
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
    if (!rows.length) {
      if (ui.query.trim()) chatRooms.appendChild(emptyBox('검색 결과 없음', '검색어에 맞는 대화가 없습니다.'));
      else if (ui.unreadOnly) chatRooms.appendChild(emptyBox('안 읽은 대화 없음', '모든 대화를 읽었습니다.'));
      else if (ui.filter) chatRooms.appendChild(emptyBox('받은 갠톡 없음', '이 계정에 받은 갠톡이 없습니다.'));
      else chatRooms.appendChild(emptyBox('받은 갠톡 없음', '오픈프로필 1:1 채팅(갠톡)이 오면 여기에 나타납니다.'));
      return;
    }
    rows.forEach(function (c) {
      var name = c.name || '대화상대';
      var key = keyOf(c.device_id, c.chat_id);
      var isOpen = key === openKey();
      var showBadge = (c.unread || 0) > 0 && !isOpen;
      var item = el('div');
      item.setAttribute('role', 'listitem');
      var row = el('button', 'kkt-row' + (showBadge ? ' unread' : ''));
      row.type = 'button';
      row.dataset.id = c.chat_id;
      row.dataset.device = c.device_id;
      row.dataset.key = key;
      row.setAttribute('aria-current', isOpen ? 'true' : 'false');
      var ava = el('span', 'kkt-ava', initialOf(name));
      ava.setAttribute('aria-hidden', 'true');
      ava.style.setProperty('--ava', avaColor(name));
      var meta = el('span', 'kkt-meta');
      var nameRow = el('span', 'kkt-name');
      nameRow.appendChild(el('b', '', name));
      var t = el('time', 'kkt-time', fmtListTime(c.last_at));
      if (c.last_at) { try { t.setAttribute('datetime', new Date(Number(c.last_at)).toISOString()); } catch (e) { /* 시각이 없으면 비워 둔다 */ } }
      nameRow.appendChild(t);
      var prevRow = el('span', 'kkt-prev-row');
      prevRow.appendChild(el('span', 'kkt-prev', c.preview || ''));
      // 열어 둔 방은 읽는 중이다. 서버가 0 으로 돌리기 전까지 잠깐 뜨는 배지를 숨긴다.
      if (showBadge) {
        prevRow.appendChild(el('span', 'sr-only', '안 읽음 '));
        prevRow.appendChild(el('span', 'kkt-badge', badgeText(c.unread)));
      }
      meta.appendChild(nameRow);
      meta.appendChild(prevRow);
      if (chip) {
        var acc = el('span', 'kkt-acc');
        var accDot = el('i', 'kkt-acc-dot');
        accDot.setAttribute('aria-hidden', 'true');
        accDot.style.setProperty('--ava', accColor(c.device_id));
        acc.appendChild(accDot);
        var owner = accOf(c.device_id);
        acc.appendChild(document.createTextNode(c.email || (owner ? owner.email : '')));
        meta.appendChild(acc);
      }
      row.appendChild(ava);
      row.appendChild(meta);
      if (Object.prototype.hasOwnProperty.call(inboxSt.prevUnread, key) && inboxSt.prevUnread[key] < (c.unread || 0)) {
        row.classList.add('bump');
        setTimeout(function () { row.classList.remove('bump'); }, 500);
      }
      row.addEventListener('click', function () { openConversation(c.device_id, c.chat_id, name); });
      item.appendChild(row);
      chatRooms.appendChild(item);
      if (focusKey && key === focusKey) row.focus({ preventScroll: true });
    });
  }
  function markOpenRow(key) {
    if (!chatRooms) return;
    Array.prototype.forEach.call(chatRooms.querySelectorAll('.kkt-row'), function (r) {
      var open = r.dataset.key === key;
      r.setAttribute('aria-current', open ? 'true' : 'false');
      // 열어 둔 방은 읽는 중이다 — 다음 폴링을 기다리지 않고 배지를 바로 거둔다
      if (open) {
        r.classList.remove('unread');
        Array.prototype.forEach.call(r.querySelectorAll('.kkt-badge, .kkt-prev-row .sr-only'), function (n) { n.remove(); });
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
      var dot = el('span', 'st-dot');
      dot.dataset.state = st;
      dot.setAttribute('aria-hidden', 'true');
      row.appendChild(dot);
      row.appendChild(el('span', 'kkt-notice-text', a.email + ' · ' + stateLabel(st)));
      if (st === 'needs_register') {
        var b = el('button', 'btn ghost sm', '등록');
        b.type = 'button';
        row.appendChild(b);
      }
      chatNotice.appendChild(row);
    });
    chatNotice.hidden = false;
  }
  // 띠는 발송 작업 상태 하나만 말한다. 계정별 문제는 레일 점·알림·머리 칩·입력창이 맡는다.
  function updateStrip() {
    if (!runstate) return;
    var text = runstate.querySelector('.strip-text');
    if (inboxSt.senderUp || !inboxSt.accounts.length) {
      runstate.hidden = true;
      runstate.className = 'strip';
      if (text) text.textContent = '';
      return;
    }
    runstate.className = 'strip down';
    if (text) text.textContent = inboxSt.senderReason || STRIP_DOWN;
    runstate.hidden = false;
  }
  // 열린 대화의 머리 칩·부제·입력창을 계정 상태에 맞춘다. live 로 돌아오면 다음 thread 읽기 성공에서 다시 켜진다.
  function syncOpenState() {
    if (!chat.openId) return;
    var st = stateOf(chat.deviceId);
    var a = accOf(chat.deviceId);
    if (threadState) {
      threadState.dataset.state = st;
      threadState.textContent = stateLabel(st);
      threadState.hidden = false;
    }
    if (chatHeadSub) chatHeadSub.textContent = (a ? a.email : '') + ' 계정으로 답장';
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
      inboxSt.loaded = true;
      say('chat-error', '');
      applyInbox(res);
    } catch (e) {
      if (seq !== inboxSt.seq || !me) return;
      inboxSt.fails += 1;
      if (e && (e.status === 401 || e.status === 403)) { showLogin(); return; }
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
    ((me && me.accounts) || []).forEach(function (r) { meConn[r.device_id] = !!r.connected; });
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
  }

  // ── 레일에서 계정 고르기 ──────────────────────────────────
  function selectRail(deviceId) {
    ui.filter = deviceId || '';
    var wasSettings = consoleEl.dataset.mode === 'settings';
    if (railEl) {
      Array.prototype.forEach.call(railEl.querySelectorAll('.rail-btn[data-device]'), function (b) {
        b.setAttribute('aria-current', (b.dataset.device || '') === ui.filter ? 'true' : 'false');
      });
    }
    var a = accOf(ui.filter);
    if (chatTitle) chatTitle.textContent = ui.filter ? (a ? a.email : ui.filter) : '전체 대화';
    // 열린 대화가 새 필터에서 보이지 않을 때만 닫는다. 전체로 바꾸거나 그 계정을 고르면 유지.
    if (chat.openId && ui.filter && chat.deviceId !== ui.filter) closeConversation();
    renderRail();
    renderConvList();
    updateNotice();
    if (wasSettings) {
      if (ui.filter) openAccountSafe(ui.filter, currentTab());
      else showTab('chat');
    }
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
    if (chatHeadAva) {
      chatHeadAva.className = 'kkt-head-ava ava show';
      chatHeadAva.textContent = initialOf(name);
      chatHeadAva.style.setProperty('--ava', avaColor(name));
    }
    if (chatHeadSub) chatHeadSub.textContent = (a ? a.email : '') + ' 계정으로 답장';
    var st = stateOf(deviceId);
    if (threadState) { threadState.dataset.state = st; threadState.textContent = stateLabel(st); threadState.hidden = false; }
    if (threadSettings) threadSettings.hidden = false;
    // 쓰던 글은 방을 옮길 때 지운다. 남겨 두면 엉뚱한 사람에게 보내게 된다.
    chatText.value = '';
    if (chatNote) chatNote.textContent = '';
    autoGrow();
    updateComposeState();
    updateCount();
    setComposeEnabled(canSend(deviceId));
    updatePlaceholder();
    consoleEl.dataset.view = 'room';
    if (isPhone() && !(history.state && history.state.kview === 'room')) {
      history.pushState({ kview: 'room' }, '', location.pathname + location.search);
    }
    markOpenRow(keyOf(deviceId, chatId));
    updateUnread();
    renderRail();                     // 열린 대화를 뺀 안 읽음으로 레일 배지도 바로 맞춘다
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
    consoleEl.dataset.view = 'list';
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
    if (chatNote) chatNote.textContent = '';
    if (chatNewpill) chatNewpill.hidden = true;
    markOpenRow('');
    chatLog.textContent = '';
    chatLog.appendChild(logEmpty('대화를 선택하면 내용이 표시됩니다.'));
    updateUnread();
  }
  function backAction() {
    if (history.state && history.state.kview === 'room') history.back();
    else closeConversation();
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
    ui.filter = '';
    ui.query = '';
    ui.unreadOnly = false;
    if (chatSearch) chatSearch.value = '';
    if (chatUnread) chatUnread.setAttribute('aria-pressed', 'false');
    if (chatTitle) chatTitle.textContent = '전체 대화';
    closeConversation();
    if (chatRooms) chatRooms.textContent = '';
    if (railAccounts) railAccounts.textContent = '';
    say('chat-error', '');
    if (chatNotice) { chatNotice.textContent = ''; chatNotice.hidden = true; }
    setTabsEnabled(false);
    updateTabSummaries();
  }
  function bootConsole() {
    inboxSt.booted = true;
    // 수용 기준 12·14: 계정을 열기 전엔 계정별 탭이 꺼져 있고, 대화 창은 미선택 상태를 보인다.
    setTabsEnabled(false);
    closeConversation();
    if (!me.accounts || !me.accounts.length) showTab('account');
    else showTab('chat');
    loadInbox(true);
    scheduleInbox();
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
        if (chatNote) chatNote.textContent = '카카오 로그인이 끊겼습니다. 설정 › 계정에서 다시 등록해 주세요.';
        setComposeEnabled(false);
      } else if (e && e.status === 503) {
        if (chatNote) chatNote.textContent = (e.body && e.body.error) || '발송 작업이 멈춰 있습니다.';
      }
      if (initial) {
        chatLog.textContent = '';
        chatLog.appendChild(logEmpty('대화를 불러오지 못했습니다. 잠시 뒤 자동으로 다시 읽습니다.'));
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
    var lastDay = '';
    var fresh = 0;
    messages.forEach(function (m, i) {
      var day = fmtDay(m.at);
      var newDay = !!day && day !== lastDay;
      if (newDay) {
        var sep = el('div', 'kkt-date');
        sep.setAttribute('role', 'separator');
        sep.appendChild(el('span', '', day));
        chatLog.appendChild(sep);
        lastDay = day;
      }
      var prev = messages[i - 1];
      var next = messages[i + 1];
      var start = newDay || !prev || !sameSender(prev, m) || bigGap(prev, m) || fmtDay(prev.at) !== day;
      var end = !next || !sameSender(next, m) || bigGap(m, next) || fmtDay(next.at) !== day;
      var isNew = !initial && m.log_id && !prevIds[m.log_id];

      var line = el('div', 'kkt-line ' + (m.mine ? 'me' : 'them'));
      if (m.log_id) line.dataset.log = String(m.log_id);
      if (start) line.classList.add('grp-start');
      if (isNew) { line.classList.add('enter'); fresh += 1; }

      var col = el('div', 'kkt-col');
      var body = m.text || '(' + (m.label || '첨부') + ')';
      var bubble = el('div', 'kkt-bubble' + (m.text ? '' : ' media'), body);
      var pair = el('div', 'kkt-pair');
      pair.appendChild(bubble);
      if (end) pair.appendChild(el('div', 'kkt-at', fmtTime(m.at)));
      col.appendChild(pair);
      line.appendChild(col);
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
      if (chatNote) chatNote.textContent = '';
      await loadThread(true);          // 읽는 중이면 roomAgain 으로 한 번 더 → 보낸 글이 바로 보인다
      loadInbox(false);
    } catch (e) {
      if (chat.deviceId !== dev || chat.openId !== room) return;
      if (chatNote) {
        chatNote.textContent = (e && e.status === 409) ? '카카오 로그인이 끊겼습니다. 설정 › 계정에서 다시 등록해 주세요.'
          : (e && e.status === 503) ? ((e.body && e.body.error) || '발송 작업이 멈춰 있습니다.')
          : '메시지를 보내지 못했습니다. 잠시 뒤 다시 해 주세요.';
      }
    } finally {
      chat.sending = false;
      // 보내는 사이에 방을 닫았을 수 있다. 그때는 입력창을 다시 켜지 않는다.
      setComposeEnabled(!!chat.openId && canSend(chat.deviceId));
      if (chat.openId) chatText.focus();
    }
  }

  // #chat-notice 의 `등록` — 그 계정의 계정 탭으로 가서 다시 등록 폼을 채운다
  async function startReauth(deviceId, email) {
    try { await openAccount(deviceId, 'account'); } catch (e) { showTab('account'); }
    regDevice = deviceId;
    var form = document.getElementById('add-form');
    form.dataset.reauth = '1';
    document.getElementById('email').value = email || '';
    form.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  // ── 리스너 ────────────────────────────────────────────────
  if (tabsEl) {
    tabsEl.addEventListener('click', function (ev) {
      var b = ev.target.closest ? ev.target.closest('.tab') : null;
      if (!b || b.disabled) return;
      showTab(b.dataset.tab);
    });
  }
  if (railEl) {
    railEl.addEventListener('click', function (ev) {
      var b = ev.target.closest ? ev.target.closest('.rail-btn') : null;
      if (!b || !railEl.contains(b)) return;
      if (b.id === 'rail-all') {
        selectRail('');
        if (consoleEl.dataset.mode !== 'inbox') showTab('chat');
        return;
      }
      if (b.id === 'rail-add') { goRegister(); return; }
      if (b.id === 'rail-settings') {
        var target = ui.filter || (account && account.device_id) || (inboxSt.accounts[0] && inboxSt.accounts[0].device_id) || '';
        if (!target) { showTab('account'); return; }
        openAccountSafe(target, 'macro');
        return;
      }
      if (b.classList.contains('rail-acct')) selectRail(b.dataset.device || '');
    });
  }
  if (threadSettings) {
    threadSettings.addEventListener('click', function () {
      if (chat.deviceId) openAccountSafe(chat.deviceId, 'macro');
    });
  }
  if (acctSel) {
    acctSel.addEventListener('change', function () {
      if (acctSel.value) openAccountSafe(acctSel.value, currentTab());
    });
  }
  document.getElementById('chat-reload').addEventListener('click', function () { loadInbox(true); });
  if (chatBack) chatBack.addEventListener('click', backAction);
  document.getElementById('chat-form').addEventListener('submit', function (ev) {
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
        chatSearch.value = '';
        ui.query = '';
        renderConvList();
      }
    });
  }
  if (chatUnread) {
    chatUnread.addEventListener('click', function () {
      ui.unreadOnly = !ui.unreadOnly;
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
  window.addEventListener('popstate', function (ev) {
    if (ev.state && ev.state.kview === 'room') return;
    // 건너뛰기 링크(#main)의 해시 이동은 대화를 닫지 않는다
    if (isPhone() && consoleEl.dataset.view === 'room' && !location.hash) closeConversation();
  });
  document.addEventListener('keydown', function (ev) {
    if (!me || app.hidden) return;
    var t = ev.target;
    var inInput = !!(t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable));
    var toSearch = (ev.key === '/' && !inInput && !ev.ctrlKey && !ev.metaKey && !ev.altKey)
      || ((ev.ctrlKey || ev.metaKey) && !ev.altKey && (ev.key === 'k' || ev.key === 'K'));
    if (toSearch) {
      if (consoleEl.dataset.mode !== 'inbox' || !chatSearch) return;
      ev.preventDefault();
      chatSearch.focus();
      chatSearch.select();
      return;
    }
    if (ev.altKey && (ev.key === 'ArrowDown' || ev.key === 'ArrowUp')) {
      if (consoleEl.dataset.mode !== 'inbox') return;
      ev.preventDefault();
      stepConversation(ev.key === 'ArrowDown' ? 1 : -1);
    }
  });
  // 탭을 숨기면 폴링을 쉬므로, 다시 보이면 기다리지 말고 바로 읽는다. 오래 숨겼으면 계정 상태(/me)도 다시 본다.
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) { inboxSt.hiddenAt = Date.now(); return; }
    if (!me) return;
    if (inboxSt.hiddenAt && Date.now() - inboxSt.hiddenAt > 300000) refreshMe().catch(function () { /* 다음 폴링이 다시 시도한다 */ });
    else loadInbox(false);
    if (chat.openId) loadThread(false);
  });
  updatePlaceholder();

  api('/panel/api/me').then(function (res) {
    me = res;
    showApp();
    renderAccounts();
    bootConsole();
  }).catch(function () {
    showLogin();
  });
})();
