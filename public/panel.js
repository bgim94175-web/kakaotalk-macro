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
    login.hidden = false;
    app.hidden = true;
    logout.hidden = true;
    who.textContent = '';
    chatReset();
  }

  function showApp() {
    login.hidden = true;
    app.hidden = false;
    logout.hidden = false;
    who.textContent = me && me.mask ? me.mask : '';
    var up = me && me.sender_up;
    runstate.className = up ? 'strip' : 'strip wait';
    runstate.textContent = '';
    var p = el('p', '', up
      ? '발송 위치: 이 서버. 계정 등록이 끝나면 폰이 꺼져 있어도 이 서버가 보냅니다.'
      : ((me && me.sender_reason) || '발송 프로세스가 지금 멈춰 있습니다. 키 확인은 그대로 됩니다. 프로세스가 다시 뜨면 저장된 계정으로 이어서 접속합니다.'));
    runstate.appendChild(p);
  }

  function renderAccounts() {
    list.textContent = '';
    var rows = (me && me.accounts) || [];
    if (!rows.length) {
      list.appendChild(el('p', 'hint', '등록된 카카오 계정이 없습니다.'));
      return;
    }
    rows.forEach(function (row) {
      var box = el('div', 'account');
      var text = el('div');
      text.appendChild(el('strong', '', row.email));
      text.appendChild(el('span', '', reasonText(row)));
      var open = el('button', 'btn ghost', '열기');
      open.type = 'button';
      open.addEventListener('click', function () { openAccount(row.device_id); });
      box.appendChild(text);
      box.appendChild(open);
      list.appendChild(box);
    });
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
    var a = account.autoreply || {};
    document.getElementById('reply-on').checked = !!a.enabled;
    document.getElementById('reply-message').value = a.message || '';
    document.getElementById('reply-hours').value = String(a.cooldown_hours == null ? 6 : a.cooldown_hours);
    triggers = (account.triggers || []).map(function (t) { return Object.assign({}, t); });
    renderTriggers();
  }

  async function refreshMe() {
    me = await api('/panel/api/me');
    showApp();
    renderAccounts();
  }

  async function openAccount(id) {
    say('room-error', '');
    say('macro-error', '');
    var res = await api('/panel/api/account?device_id=' + encodeURIComponent(id));
    account = res.account;
    fillDetail();
    chatStart(account.device_id);
    detail.scrollIntoView({ behavior: 'smooth', block: 'start' });
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
  actions.appendChild(again);
  actions.appendChild(unlink);
  document.getElementById('detail').insertBefore(actions, document.getElementById('macro-title').parentNode);

  // ── 채팅 (카카오톡풍) ──────────────────────────────────────
  // 목록은 9초, 열린 방은 3초마다 새로 읽는다. 방을 열면 그 방의 안 읽음은 서버에서 0 이 된다.
  var chat = {
    deviceId: '', openId: '', openName: '', openKind: '',
    dmOnly: false, listBusy: false, roomBusy: false, roomAgain: false, sending: false,
    listTimer: null, roomTimer: null, roomSig: '', listSig: '', renderedIds: {},
  };
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
      chatHeadAva.className = 'kkt-head-ava';
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
  function kindTag(k) {
    if (k === 'open_dm') return '갠톡';
    if (k === 'open_room') return '오픈방';
    return '';
  }
  function setComposeEnabled(on) {
    if (chatText) chatText.disabled = !on;
    if (chatSend) chatSend.disabled = !on;
  }
  function autoGrow() {
    if (!chatText) return;
    chatText.style.height = 'auto';
    chatText.style.height = Math.min(120, chatText.scrollHeight) + 'px';
  }

  function chatStop() {
    if (chat.listTimer) { clearInterval(chat.listTimer); chat.listTimer = null; }
    if (chat.roomTimer) { clearInterval(chat.roomTimer); chat.roomTimer = null; }
  }
  function chatReset() {
    chatStop();
    chat.deviceId = '';
    chat.openId = '';
    chat.openName = '';
    chat.openKind = '';
    chat.roomSig = '';
    chat.listSig = '';
    chat.renderedIds = {};
    chat.roomAgain = false;
    if (kkt) kkt.setAttribute('data-view', 'list');
    if (chatRooms) chatRooms.textContent = '';
    if (chatLog) chatLog.textContent = '';
    if (chatPeer) chatPeer.textContent = '대화를 고르세요';
    if (chatNote) chatNote.textContent = '';
    if (chatText) chatText.value = '';
    clearHead();
    autoGrow();
    updateComposeState();
    say('chat-error', '');
    setComposeEnabled(false);
  }
  function chatStart(deviceId) {
    chatReset();
    chat.deviceId = deviceId;
    if (kkt) kkt.hidden = false;
    loadChatList();
    chat.listTimer = setInterval(function () {
      if (document.hidden || !chat.deviceId) return;
      loadChatList();
    }, 9000);
  }

  async function loadChatList() {
    if (chat.listBusy || !chat.deviceId) return;
    chat.listBusy = true;
    var want = chat.deviceId;
    try {
      var res = await api('/panel/api/chats?device_id=' + encodeURIComponent(want));
      if (chat.deviceId !== want) return;
      if (chatNote) chatNote.textContent = '';
      say('chat-error', '');
      renderChatList(res.chats || []);
    } catch (e) {
      if (chat.deviceId !== want) return;
      if (e && e.status === 409) {
        if (chatNote) chatNote.textContent = '카카오 로그인이 끊겼습니다. 위에서 이 계정을 다시 등록해 주세요.';
        renderChatList([]);
      } else if (e && e.status === 503) {
        if (chatNote) chatNote.textContent = (e.body && e.body.error) || '발송 프로세스가 멈춰 있습니다.';
      } else {
        say('chat-error', '대화 목록을 불러오지 못했습니다.');
      }
    } finally {
      chat.listBusy = false;
    }
  }

  function renderChatList(chats) {
    var rows = chat.dmOnly ? chats.filter(function (c) { return c.list_kind === 'open_dm'; }) : chats;
    // 바뀐 게 없으면 그대로 둔다. 9초마다 새로 그리면 마우스·포커스가 끊긴다.
    var sig = rows.map(function (c) {
      return c.chat_id + '\u0001' + c.unread + '\u0001' + c.last_at + '\u0001' + c.name + '\u0001' + c.preview;
    }).join('|') + '#' + chat.openId;
    if (sig === chat.listSig) return;
    chat.listSig = sig;
    chatRooms.textContent = '';
    if (!rows.length) {
      chatRooms.appendChild(emptyState('🗨️', chat.dmOnly
        ? '갠톡이 아직 없습니다.'
        : '대화가 아직 없습니다.\n상대가 메시지를 보내면 여기에 나타납니다.'));
      return;
    }
    rows.forEach(function (c) {
      var name = c.name || '대화상대';
      var row = el('button', 'kkt-row');
      row.type = 'button';
      row.dataset.id = c.chat_id;
      if (c.chat_id === chat.openId) row.setAttribute('aria-current', 'true');
      var isDm = c.list_kind === 'open_dm';
      var ava = el('div', 'kkt-ava' + (isDm ? ' dm' : ''), initialOf(name));
      if (!isDm) ava.style.setProperty('--ava', avaColor(name));
      var meta = el('div', 'kkt-meta');
      var nameRow = el('div', 'kkt-name');
      nameRow.appendChild(el('b', '', name));
      var tag = kindTag(c.list_kind);
      if (tag) nameRow.appendChild(el('span', 'kkt-tag' + (c.list_kind === 'open_room' ? ' tagroom' : ''), tag));
      meta.appendChild(nameRow);
      meta.appendChild(el('div', 'kkt-prev', c.preview || ''));
      var right = el('div', 'kkt-right');
      right.appendChild(el('div', 'kkt-time', fmtTime(c.last_at)));
      // 열어 둔 방은 읽는 중이다. 서버가 0 으로 돌리기 전까지 잠깐 뜨는 배지를 숨긴다.
      if (c.unread > 0 && c.chat_id !== chat.openId) {
        right.appendChild(el('div', 'kkt-badge', c.unread > 99 ? '99+' : String(c.unread)));
      }
      row.appendChild(ava);
      row.appendChild(meta);
      row.appendChild(right);
      row.addEventListener('click', function () { openConversation(c.chat_id, name, c.list_kind); });
      chatRooms.appendChild(row);
    });
  }

  function markOpenRow(id) {
    Array.prototype.forEach.call(chatRooms.querySelectorAll('.kkt-row'), function (r) {
      if (r.dataset.id === id) r.setAttribute('aria-current', 'true');
      else r.removeAttribute('aria-current');
    });
  }

  function openConversation(id, name, kind) {
    chat.openId = id;
    chat.openName = name;
    chat.openKind = kind;
    chat.roomSig = '';
    chat.renderedIds = {};
    chat.roomAgain = false;
    chatPeer.textContent = name;
    var isDm = kind === 'open_dm';
    if (chatHeadAva) {
      chatHeadAva.className = 'kkt-head-ava show' + (isDm ? ' dm' : '');
      chatHeadAva.textContent = initialOf(name);
      if (isDm) chatHeadAva.style.removeProperty('--ava');
      else chatHeadAva.style.setProperty('--ava', avaColor(name));
    }
    if (chatHeadSub) chatHeadSub.textContent = isDm ? '오픈프로필 갠톡' : (kind === 'open_room' ? '오픈채팅방' : '채팅');
    setComposeEnabled(true);
    updateComposeState();
    if (kkt) kkt.setAttribute('data-view', 'room');
    markOpenRow(id);
    chatLog.textContent = '';
    chatLog.appendChild(el('p', 'kkt-empty', '불러오는 중…'));
    loadThread(true);
    if (chat.roomTimer) clearInterval(chat.roomTimer);
    chat.roomTimer = setInterval(function () {
      if (document.hidden || !chat.openId) return;
      loadThread(false);
    }, 3000);
  }

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
    } catch (e) {
      if (chat.openId !== wantRoom || chat.deviceId !== wantDevice) return;
      if (e && e.status === 409) {
        if (chatNote) chatNote.textContent = '카카오 로그인이 끊겼습니다. 위에서 이 계정을 다시 등록해 주세요.';
        setComposeEnabled(false);
      } else if (initial) {
        chatLog.textContent = '';
        chatLog.appendChild(el('p', 'kkt-empty', '대화를 불러오지 못했습니다.'));
      }
    } finally {
      chat.roomBusy = false;
      if (chat.roomAgain) {
        chat.roomAgain = false;
        loadThread(true);
      }
    }
  }

  function emptyState(emoji, text) {
    var box = el('div', 'kkt-empty');
    box.appendChild(el('span', 'kkt-emoji', emoji));
    box.appendChild(document.createTextNode(text));
    return box;
  }

  function renderThread(messages, initial) {
    var sig = messages.map(function (m) { return (m.log_id || '') + '.' + (m.text || '').length; }).join('|') + '#' + messages.length;
    if (!initial && sig === chat.roomSig) return;
    var nearBottom = (chatLog.scrollHeight - chatLog.scrollTop - chatLog.clientHeight) < 70;
    chat.roomSig = sig;
    var prevIds = chat.renderedIds || {};
    chatLog.textContent = '';
    if (!messages.length) {
      chatLog.appendChild(emptyState('💬', '아직 메시지가 없습니다. 먼저 인사를 보내 보세요.'));
      chat.renderedIds = {};
      return;
    }
    var grouped = chat.openKind !== 'open_dm';
    var lastDay = '';
    messages.forEach(function (m, i) {
      var day = fmtDay(m.at);
      var newDay = !!day && day !== lastDay;
      if (newDay) {
        chatLog.appendChild(el('div', 'kkt-date', day));
        lastDay = day;
      }
      var prev = messages[i - 1];
      var next = messages[i + 1];
      var start = newDay || !prev || !sameSender(prev, m) || bigGap(prev, m) || fmtDay(prev.at) !== day;
      var end = !next || !sameSender(next, m) || bigGap(m, next) || fmtDay(next.at) !== day;
      var isNew = !initial && m.log_id && !prevIds[m.log_id];

      var line = el('div', 'kkt-line ' + (m.mine ? 'me' : 'them'));
      if (start) line.classList.add('grp-start');
      if (isNew) line.classList.add('enter');

      if (!m.mine && grouped) {
        if (start) {
          // 이름을 모르면 방 이름을 빌려 쓰지 않는다. 색은 아이디로 갈라 둔다.
          var who = m.author || '';
          var av = el('div', 'kkt-ava-sm', who ? initialOf(who) : '?');
          av.style.setProperty('--ava', avaColor(who || m.author_id || ''));
          line.appendChild(av);
        } else {
          line.appendChild(el('div', 'kkt-ava-sm spacer'));
        }
      }

      var col = el('div', 'kkt-col');
      if (!m.mine && grouped && start && m.author) col.appendChild(el('div', 'kkt-who', m.author));
      var body = m.text || (m.label ? '(' + m.label + ')' : '');
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
    if (initial || nearBottom) chatLog.scrollTop = chatLog.scrollHeight;
  }

  async function sendChat() {
    if (!chat.openId || chat.sending) return;
    var text = chatText.value;
    if (!text.trim()) return;
    chat.sending = true;
    chatSend.disabled = true;
    try {
      await api('/panel/api/chat/send', { device_id: chat.deviceId, chat_id: chat.openId, text: text });
      chatText.value = '';
      autoGrow();
      updateComposeState();
      await loadThread(true);
      loadChatList();
    } catch (e) {
      if (chatNote) chatNote.textContent = (e && e.status === 409)
        ? '카카오 로그인이 끊겼습니다. 다시 등록해 주세요.'
        : ((e && e.message) || '메시지를 보내지 못했습니다.');
    } finally {
      chat.sending = false;
      chatSend.disabled = false;
      chatText.focus();
    }
  }

  document.getElementById('chat-dm-only').addEventListener('change', function () {
    chat.dmOnly = this.checked;
    loadChatList();
  });
  document.getElementById('chat-reload').addEventListener('click', function () { loadChatList(); });
  document.getElementById('chat-back').addEventListener('click', function () {
    if (kkt) kkt.setAttribute('data-view', 'list');
    chat.openId = '';
    if (chat.roomTimer) { clearInterval(chat.roomTimer); chat.roomTimer = null; }
    setComposeEnabled(false);
    chatPeer.textContent = '대화를 고르세요';
    clearHead();
    markOpenRow('');
  });
  document.getElementById('chat-form').addEventListener('submit', function (ev) {
    ev.preventDefault();
    sendChat();
  });
  chatText.addEventListener('input', function () { autoGrow(); updateComposeState(); });
  chatText.addEventListener('keydown', function (ev) {
    if (ev.key === 'Enter' && !ev.shiftKey) {
      ev.preventDefault();
      sendChat();
    }
  });
  // 탭을 숨기면 폴링을 쉬므로, 다시 보이면 기다리지 말고 바로 읽는다.
  document.addEventListener('visibilitychange', function () {
    if (document.hidden || !chat.deviceId) return;
    loadChatList();
    if (chat.openId) loadThread(false);
  });

  api('/panel/api/me').then(function (res) {
    me = res;
    showApp();
    renderAccounts();
  }).catch(function () {
    showLogin();
  });
})();
