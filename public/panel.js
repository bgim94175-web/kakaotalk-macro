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
    if (!json) throw new Error('응답을 읽지 못했습니다.');
    if (!res.ok || json.ok === false) {
      var err = new Error(json.error || '처리하지 못했습니다.');
      err.body = json;
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
    document.querySelectorAll('#rooms-open .room, #rooms-normal .room').forEach(function (row) {
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
    (rooms.open || []).concat(rooms.normal || []).forEach(function (r) {
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
      if (!choices.length) picks.appendChild(el('p', 'hint', '대화방을 불러온 뒤에 고릅니다. 비우면 오픈채팅방과 일반 채팅방 전체입니다.'));
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
    fillRooms('rooms-normal', rooms.normal || [], picked, cool);
    var visit = account.visit || {};
    document.getElementById('visit-on').checked = !!visit.enabled;
    var visitPicked = visit.rooms || [];
    fillChecks('visit-open', rooms.open || [], visitPicked);
    fillChecks('visit-normal', rooms.normal || [], visitPicked);
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

  async function confirmLoop() {
    if (confirming) return;
    confirming = true;
    stopConfirm = false;
    try {
      while (!stopConfirm && pendingId) {
        var view = await api('/panel/api/register/confirm', { pending_id: pendingId });
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
          continue;
        }
        showPass(view);
        document.getElementById('code-wait').textContent = '';
        return;
      }
    } catch (e) {
      say('code-error', e.message);
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
          rooms: checkedRooms('#visit-open').concat(checkedRooms('#visit-normal')),
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
      say('room-error', e.message);
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
      await refreshMe();
    } catch (e) {
      say('macro-error', e.message);
    }
  });
  var actions = el('div', 'row-actions');
  actions.appendChild(again);
  actions.appendChild(unlink);
  document.getElementById('detail').insertBefore(actions, document.getElementById('macro-title').parentNode);

  api('/panel/api/me').then(function (res) {
    me = res;
    showApp();
    renderAccounts();
  }).catch(function () {
    showLogin();
  });
})();
