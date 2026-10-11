// 관리 화면이 저장하는 매크로·자동응답·경쟁사 저격.
// 고르는 목록은 오픈채팅방만. 일반 채팅과 오픈프로필 1:1(open_dm)은 올리지 않는다.
// 이미지가 없으면 이미지를 보내지 않고, 있으면 매번 붙인다.
'use strict';

const crypto = require('crypto');

const SEP = '\u0001';
const MAX_IMAGES = 5;
const MAX_IMAGE_BYTES = 2 * 1024 * 1024;

function clip(v, n) {
  const s = v == null ? '' : String(v);
  return s.length > n ? s.slice(0, n) : s;
}

function clampInt(v, lo, hi, fallback) {
  const n = Math.trunc(Number(v));
  if (!isFinite(n)) return fallback;
  if (n < lo) return lo;
  if (n > hi) return hi;
  return n;
}

function roomName(key) {
  const s = key == null ? '' : String(key);
  const i = s.indexOf(SEP);
  return i < 0 ? s : s.slice(i + 1);
}

function visibleCatalog(catalog) {
  const out = [];
  const list = catalog || [];
  for (let i = 0; i < list.length; i++) {
    const r = list[i];
    if (!r || r.list_kind !== 'open_room' || !r.key) continue;
    const name = String(r.name || '').trim();
    const id = String(r.chat_id || '');
    if (!name) continue;
    if (id && name === '오픈채팅 ' + id.slice(-4)) continue;
    out.push(r);
  }
  return out;
}

function splitRooms(catalog) {
  const open = [];
  const normal = [];
  const vis = visibleCatalog(catalog);
  for (let i = 0; i < vis.length; i++) {
    const r = vis[i];
    const row = { key: r.key, name: r.name || roomName(r.key) };
    if (r.members) row.members = r.members;
    if (r.list_kind === 'open_room') open.push(row);
    else normal.push(row);
  }
  return { open: open, normal: normal };
}

function keySet(catalog) {
  const vis = visibleCatalog(catalog);
  const set = {};
  for (let i = 0; i < vis.length; i++) set[vis[i].key] = true;
  return set;
}

function pickKeys(input, allowed) {
  const src = Array.isArray(input) ? input : [];
  const out = [];
  const seen = {};
  for (let i = 0; i < src.length; i++) {
    const k = src[i] == null ? '' : String(src[i]);
    if (!k || seen[k] || !allowed[k]) continue;
    seen[k] = true;
    out.push(k);
  }
  return out;
}

function jpegOrPngOrWebp(buf) {
  if (buf.length >= 3 && buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF) return true;
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47) return true;
  if (buf.length >= 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return true;
  return false;
}

function normalizeImages(list) {
  if (!Array.isArray(list)) {
    const err = new Error('이미지는 최대 5장까지 첨부할 수 있습니다.');
    err.status = 400;
    throw err;
  }
  if (list.length > MAX_IMAGES) {
    const err = new Error('이미지는 최대 5장까지 첨부할 수 있습니다.');
    err.status = 400;
    throw err;
  }
  const out = [];
  for (let i = 0; i < list.length; i++) {
    const raw = typeof list[i] === 'string' ? list[i] : (list[i] && list[i].b64);
    const b64 = String(raw || '').replace(/^data:image\/[a-zA-Z0-9.+-]+;base64,/, '');
    let buf;
    try { buf = Buffer.from(b64, 'base64'); }
    catch (e) { buf = Buffer.alloc(0); }
    if (!buf.length || buf.length > MAX_IMAGE_BYTES || !jpegOrPngOrWebp(buf)) {
      const err = new Error('jpg·png·webp 이미지만, 한 장에 2MB 이하로 첨부할 수 있습니다.');
      err.status = 400;
      throw err;
    }
    out.push(buf.toString('base64'));
  }
  return out;
}

function markers(n) {
  const out = [];
  for (let i = 0; i < n; i++) out.push(String(i + 1));
  return out;
}

function sanitizeMacro(input, prev, imageCount) {
  const src = input || {};
  const old = prev || {};
  const baseMin = clampInt(src.baseMin, 1, 1440, clampInt(old.baseMin, 1, 1440, 1));
  const randomMin = clampInt(src.randomMin, 0, 1440, 0);
  const rooms = Array.isArray(src.rooms) ? src.rooms.map((k) => String(k)) : [];
  const coolIn = src.roomCooldownMin && typeof src.roomCooldownMin === 'object' ? src.roomCooldownMin : {};
  const roomCooldownMin = {};
  for (let i = 0; i < rooms.length; i++) {
    const k = rooms[i];
    if (!Object.prototype.hasOwnProperty.call(coolIn, k)) continue;
    const n = Math.trunc(Number(coolIn[k]));
    if (n >= 1) roomCooldownMin[k] = Math.min(1440, n);
  }
  const count = imageCount < 0 ? 0 : imageCount;
  return {
    enabled: !!src.enabled,
    message: clip(src.message, 2000),
    rooms: rooms,
    baseMin: baseMin,
    randomMin: randomMin,
    minMessages: clampInt(old.minMessages, 0, 100, 1),
    sendImages: 'EVERY',
    imageEveryN: 1,
    images: markers(count),
    notifyReply: false,
    roomCooldownMin: roomCooldownMin,
    quietFrom: typeof old.quietFrom === 'string' ? old.quietFrom : '',
    quietTo: typeof old.quietTo === 'string' ? old.quietTo : '',
    dailyLimit: clampInt(old.dailyLimit, 1, 5000, 200),
  };
}

function sanitizeReply(input, prev) {
  const src = input || {};
  const old = prev || {};
  let hours = src.cooldown_hours;
  if (hours == null && src.cooldownMs != null) hours = Number(src.cooldownMs) / 3600000;
  if (hours == null) hours = (Number(old.cooldownMs) || 0) / 3600000;
  const cooldownMs = clampInt(Math.round(Number(hours) * 60), 0, 168 * 60, 6 * 60) * 60000;
  return {
    enabled: !!src.enabled,
    message: clip(src.message, 2000),
    scope: typeof old.scope === 'string' && old.scope ? old.scope : 'ALL',
    exceptRooms: Array.isArray(old.exceptRooms) ? old.exceptRooms : [],
    cooldownMs: cooldownMs,
    dailyLimit: clampInt(old.dailyLimit, 0, 5000, 100),
    hourFrom: clampInt(old.hourFrom, 0, 24, 0),
    hourTo: clampInt(old.hourTo, 0, 24, 24),
    firstOnly: !!old.firstOnly,
    delayMaxMs: clampInt(old.delayMaxMs, 0, 120000, 30000),
  };
}

function sanitizeTriggers(input, prev, allowed) {
  const src = Array.isArray(input) ? input : [];
  const oldById = {};
  const old = Array.isArray(prev) ? prev : [];
  for (let i = 0; i < old.length; i++) if (old[i] && old[i].id) oldById[old[i].id] = old[i];
  const out = [];
  for (let i = 0; i < src.length && out.length < 30; i++) {
    const t = src[i];
    if (!t || typeof t !== 'object') continue;
    const prevOne = t.id && oldById[t.id] ? oldById[t.id] : null;
    let mode = t.mode === 'exact' || t.mode === 'starts' || t.mode === 'regex' || t.mode === 'contains'
      ? t.mode : 'contains';
    if (!prevOne && mode !== 'contains' && mode !== 'exact') mode = 'contains';
    const id = prevOne ? String(prevOne.id) : crypto.randomBytes(4).toString('hex');
    let rooms = pickKeys(t.rooms, allowed);
    if (!rooms.length) rooms = Object.keys(allowed);
    if (!rooms.length) rooms = ['0' + SEP];
    let target = t.target == null ? '' : String(t.target);
    if (target && !allowed[target]) target = '';
    out.push({
      id: id,
      name: clip(t.name, 40),
      pattern: clip(t.pattern, 200),
      mode: mode,
      ignoreCase: prevOne ? prevOne.ignoreCase !== false : true,
      rooms: rooms,
      fromMe: prevOne ? !!prevOne.fromMe : false,
      reply: clip(t.reply, 500),
      target: target,
      delayMs: prevOne ? clampInt(prevOne.delayMs, 0, 60000, 0) : 0,
      cooldownMs: clampInt(t.cooldown_sec != null ? Number(t.cooldown_sec) * 1000 : t.cooldownMs, 0, 86400000, 60000),
      oncePerRoom: !!t.once,
      enabled: t.enabled !== false,
    });
  }
  return out;
}

function applySettings(prevConfig, body, catalog, imageCount) {
  const prev = prevConfig && typeof prevConfig === 'object' ? prevConfig : {};
  const next = Object.assign({}, prev);
  const allowed = keySet(catalog);
  if (body && body.macro) {
    const macro = sanitizeMacro(body.macro, prev.macro, imageCount);
    macro.rooms = pickKeys(macro.rooms, allowed);
    const cool = {};
    const src = macro.roomCooldownMin || {};
    for (let i = 0; i < macro.rooms.length; i++) {
      const k = macro.rooms[i];
      if (src[k] >= 1) cool[k] = src[k];
    }
    macro.roomCooldownMin = cool;
    next.macro = macro;
  }
  if (body && body.autoreply) next.autoreply = sanitizeReply(body.autoreply, prev.autoreply);
  if (body && body.triggers) next.triggers = sanitizeTriggers(body.triggers, prev.triggers, allowed);
  if (body && body.visit) next.visit = sanitizeVisit(body.visit, allowed);
  if (body && body.cover) next.cover = sanitizeCover(body.cover, prev.cover, allowed);
  if (body && body.profile) next.profile = sanitizeVisit(body.profile, allowed);
  if (body && body.guard) next.guard = sanitizeGuard(body.guard, prev.guard, allowed);
  if (next.macro && typeof next.macro === 'object') {
    next.macro = Object.assign({}, next.macro, { notifyReply: false });
    if (next.macro.sendImages === 'NEVER') next.macro.sendImages = 'EVERY';
  }
  next.accounts = [];
  return next;
}

function mergeCatalog(prev, chats) {
  const oldById = {};
  const list = prev || [];
  for (let i = 0; i < list.length; i++) {
    const r = list[i];
    if (r && r.chat_id) oldById[String(r.chat_id)] = r;
  }
  const used = {};
  const out = [];
  const src = chats || [];
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    const id = ch && ch.chat_id != null ? String(ch.chat_id) : '';
    if (!/^[1-9][0-9]*$/.test(id)) continue;
    const listKind = ch.list_kind === 'open_room' || ch.list_kind === 'open_dm' || ch.list_kind === 'normal'
      ? ch.list_kind : 'normal';
    const old = oldById[id];
    let name = '';
    if (listKind === 'open_room') {
      name = String(ch.title || '').trim();
      const members = String(ch.display_name || '').trim();
      if (!name || (members && name === members)) continue;
      const count = Number(ch.members);
      if (Number.isInteger(count) && count >= 10 && name.endsWith(' ' + count)) {
        const bare = name.slice(0, name.length - String(count).length).trim();
        if (bare) name = bare;
      }
    } else {
      name = String((ch.title || ch.display_name || (old && old.name) || '') || '').trim();
      if (!name) name = '대화방 ' + id.slice(-4);
    }
    let key = old && old.key ? String(old.key) : '';
    if (!key || used[key]) {
      key = '0' + SEP + name;
      let n = 2;
      while (used[key]) {
        key = '0' + SEP + name + ' ' + n;
        n++;
      }
    }
    used[key] = true;
    const row = {
      key: key,
      chat_id: id,
      name: name,
      kind: ch.kind || (old && old.kind) || 'unknown',
      list_kind: listKind,
    };
    if (ch.members) row.members = ch.members;
    out.push(row);
  }
  return out;
}

// 예전 키 시대의 권리 계산. 회원 콘솔은 더 이상 sender 에 features 를 보내지 않는다(권리는 /v1/grants 만
// 바꾼다, docs/ACCOUNTS_V1.md 3.4.1). lib/panel-check.js 의 옛 단언이 남아 있는 동안만 내보낸다.
function featuresFor(licenseFeat, prev) {
  const old = prev && prev.features ? prev.features : {};
  const lic = licenseFeat || {};
  return {
    macro: true,
    roombot: !!(lic.roombot && lic.roombot.on && old.roombot === true),
    minigame: !!(lic.minigame && lic.minigame.on && old.minigame === true),
  };
}

// 계정 단위 옛 기능(D20). 키를 이관한 회원이 legacy_room_until 까지만 쓴다. 그 밖의 계정에 이 절이 오면
// 콘솔 API 가 403 으로 거절한다(routes/panel.js /panel/api/settings).
const LEGACY_KEYS = ['visit', 'profile', 'guard', 'cover'];

function legacyKeysIn(body) {
  const b = body && typeof body === 'object' ? body : {};
  return LEGACY_KEYS.filter((k) => Object.prototype.hasOwnProperty.call(b, k) && b[k] !== undefined && b[k] !== null);
}

function sanitizeVisit(input, allowed) {
  const src = input || {};
  return {
    enabled: src.enabled === true,
    rooms: pickKeys(src.rooms, allowed),
  };
}

// 금지어 검열: 기본 욕설 + 고객이 넣은 금지어 + (끌 수 있는) 링크.
// 금지어나 링크 여부를 보내지 않은 저장(예전 화면)은 이전 값을 그대로 둔다.
const MAX_COVER_WORDS = 200;
const MAX_COVER_WORD_LEN = 30;

function sanitizeWords(input) {
  let src = input;
  if (typeof src === 'string') src = src.split(/[\r\n,]+/);
  if (!Array.isArray(src)) return [];
  const out = [];
  const seen = {};
  for (let i = 0; i < src.length && out.length < MAX_COVER_WORDS; i++) {
    const v = src[i];
    if (typeof v !== 'string' && typeof v !== 'number') continue;
    const w = String(v).replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
    if (w.length < 1 || w.length > MAX_COVER_WORD_LEN) continue;
    const k = w.toLowerCase();
    if (seen[k]) continue;
    seen[k] = true;
    out.push(w);
  }
  return out;
}

function sanitizeCover(input, prev, allowed) {
  const src = input || {};
  const old = prev && typeof prev === 'object' ? prev : {};
  const base = sanitizeVisit(src, allowed);
  const has = (k) => Object.prototype.hasOwnProperty.call(src, k);
  base.words = sanitizeWords(has('words') ? src.words : old.words);
  base.links = has('links') ? src.links !== false : old.links !== false;
  return base;
}

// 올킥 방지: 앱이 쓰는 config.guard 의 강퇴 감지 칸만 바꾼다.
// 환영·도배·공지 같은 다른 칸은 손대지 않는다.
function given(v) {
  return v != null && v !== '';
}

function sanitizeGuard(input, prev, allowed) {
  const src = input || {};
  const old = prev && typeof prev === 'object' && !Array.isArray(prev) ? prev : {};
  const secsIn = given(src.secs) ? src.secs : src.kickSecs;
  const countIn = given(src.count) ? src.count : src.kickCount;
  const out = Object.assign({}, old);
  out.kickOn = src.enabled === true;   // 다른 기능과 같이 true 만 켠다 ('false' 문자열이 켜지지 않게)
  out.rooms = pickKeys(src.rooms, allowed);
  out.kickSecs = clampInt(given(secsIn) ? secsIn : given(old.kickSecs) ? old.kickSecs : 30, 5, 300, 30);
  out.kickCount = clampInt(given(countIn) ? countIn : given(old.kickCount) ? old.kickCount : 5, 3, 30, 5);
  return out;
}

function presentMacro(macro) {
  const m = macro || {};
  return {
    enabled: !!m.enabled,
    message: m.message || '',
    rooms: Array.isArray(m.rooms) ? m.rooms : [],
    baseMin: clampInt(m.baseMin, 1, 1440, 1),
    randomMin: clampInt(m.randomMin, 0, 1440, 0),
    roomCooldownMin: m.roomCooldownMin && typeof m.roomCooldownMin === 'object' ? m.roomCooldownMin : {},
  };
}

function presentVisit(cfg) {
  const c = cfg || {};
  return {
    enabled: c.enabled === true,
    rooms: Array.isArray(c.rooms) ? c.rooms : [],
  };
}

function presentCover(cfg) {
  const c = cfg || {};
  const v = presentVisit(c);
  v.words = sanitizeWords(c.words);
  v.links = c.links !== false;
  return v;
}

function presentGuard(cfg) {
  const c = cfg && typeof cfg === 'object' ? cfg : {};
  return {
    enabled: c.kickOn === true,
    rooms: Array.isArray(c.rooms) ? c.rooms : [],
    secs: given(c.kickSecs) ? clampInt(c.kickSecs, 5, 300, 30) : 30,
    count: given(c.kickCount) ? clampInt(c.kickCount, 3, 30, 5) : 5,
  };
}

function presentProfile(cfg) {
  return presentVisit(cfg);
}

function presentReply(cfg) {
  const c = cfg || {};
  return {
    enabled: !!c.enabled,
    message: c.message || '',
    cooldown_hours: Math.round((Number(c.cooldownMs) || 0) / 3600000),
  };
}

function presentTriggers(list) {
  const src = Array.isArray(list) ? list : [];
  const out = [];
  for (let i = 0; i < src.length; i++) {
    const t = src[i];
    if (!t) continue;
    out.push({
      id: t.id || '',
      name: t.name || '',
      pattern: t.pattern || '',
      mode: t.mode || 'contains',
      reply: t.reply || '',
      enabled: t.enabled !== false,
      cooldown_sec: Math.round((Number(t.cooldownMs) || 0) / 1000),
      once: !!t.oncePerRoom,
      rooms: Array.isArray(t.rooms) ? t.rooms : [],
      target: t.target || '',
    });
  }
  return out;
}

module.exports = {
  SEP, MAX_IMAGES, MAX_IMAGE_BYTES, MAX_COVER_WORDS, MAX_COVER_WORD_LEN, LEGACY_KEYS, legacyKeysIn,
  visibleCatalog, splitRooms, normalizeImages, applySettings, mergeCatalog, featuresFor,
  sanitizeCover, sanitizeGuard,
  presentMacro, presentReply, presentTriggers, presentVisit, presentCover, presentProfile, presentGuard, markers,
};
