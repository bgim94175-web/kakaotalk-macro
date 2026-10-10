// 방 설정(room_installs.config) 검증·표시 — docs/ACCOUNTS_V1.md 7.1 표가 단일 소스다.
//   sanitizeRoomConfig(prev, body, ctx:{products, display}) -> {ok:true, config} | {ok:false, status, reason, error}
//   presentRoomConfig(cfg, products) -> 화면에 보낼 설정(기본값 채움 + status_supported)
// 검증 실패는 저장을 거부한다(조용히 버리지 않는다). 저장하는 값은 7.1 의 모든 칸을 채운 완성본이다.
// sender 는 쓸 때 같은 범위로 다시 자른다.
'use strict';

const MAX_WORDS = 300;
const MAX_WORD_LEN = 30;
const MAX_EXEMPT = 50;
const MAX_EXEMPT_NAME = 40;
// 오픈채팅 프로필의 상태 메시지 감지 지원 여부(10.1 #7 실측 뒤 필요하면 false). 작업 5 가 false 면 스위치를 숨긴다.
const STATUS_SUPPORTED = true;
const PREFIXES = ['!', '/', '.', '#'];
const USER_ID_RE = /^[1-9][0-9]{0,19}$/;

function freeze(o) {
  Object.values(o).forEach((v) => { if (v && typeof v === 'object') freeze(v); });
  return Object.freeze(o);
}

const DEFAULTS = freeze({
  v: 1,
  cmdPrefix: '!',
  exempt: [],
  visit: { enabled: false },
  churn: { enabled: false, joins: 3, windowMin: 10, action: 'warn', notice: true },
  leaveKick: { enabled: false, notice: false },
  profile: { enabled: false, name: true, photo: true, status: true, lookup: 'staff' },
  promo: { enabled: false, links: true, cards: true, media: false, hide: true, kickAt: 3, resetHours: 24, notice: true },
  cover: { enabled: false, words: [], links: true },
  hide: { command: true },
  guard: { enabled: false, secs: 30, count: 5 },
  games: { enabled: true, word: true, baseball: true, dice: true, rps: true, quiz: true, cooldownSec: 3, dailyLimit: 0 },
});

// 칸 정의: 형·범위·오류 문구. 문구는 그대로 화면에 보인다(합니다체, 부탁은 ~해 주세요, 마침표).
const BOOL = { t: 'bool' };
function int(lo, hi, error) { return { t: 'int', lo: lo, hi: hi, error: error }; }
function oneOf(list, error) { return { t: 'enum', list: list, error: error }; }

const SCHEMA = {
  visit: { enabled: BOOL },
  churn: {
    enabled: BOOL,
    joins: int(2, 20, '들낙 감지 입장 횟수는 2~20회로 입력해 주세요.'),
    windowMin: int(1, 1440, '들낙 감지 시간은 1~1,440분으로 입력해 주세요.'),
    action: oneOf(['warn', 'kick'], '들낙 감지 조치는 「경고만」·「내보내기」 중에서 골라 주세요.'),
    notice: BOOL,
  },
  leaveKick: { enabled: BOOL, notice: BOOL },
  profile: {
    enabled: BOOL, name: BOOL, photo: BOOL, status: BOOL,
    lookup: oneOf(['staff', 'all', 'off'], '기록 조회 명령어는 「방장·부방장만」·「모두」·「끄기」 중에서 골라 주세요.'),
  },
  promo: {
    enabled: BOOL, links: BOOL, cards: BOOL, media: BOOL, hide: BOOL,
    kickAt: int(0, 10, '홍보 금지에서 내보낼 경고 횟수는 0~10회로 입력해 주세요.'),
    resetHours: int(1, 720, '홍보 금지 경고 초기화 시간은 1~720시간으로 입력해 주세요.'),
    notice: BOOL,
  },
  cover: { enabled: BOOL, links: BOOL },          // words 는 따로 본다
  hide: { command: BOOL },
  guard: {
    enabled: BOOL,
    secs: int(5, 300, '올킥 감지 시간은 5~300초로 입력해 주세요.'),
    count: int(3, 30, '올킥 감지 인원은 3~30명으로 입력해 주세요.'),
  },
  games: {
    enabled: BOOL, word: BOOL, baseball: BOOL, dice: BOOL, rps: BOOL, quiz: BOOL,
    cooldownSec: int(1, 60, '미니게임 쿨타임은 1~60초로 입력해 주세요.'),
    dailyLimit: int(0, 5000, '미니게임 하루 최대 응답 수는 0~5,000회로 입력해 주세요.'),
  },
};

// 방 관리봇 절(7.1 제품 검사). 이 절은 products.roombot 과 display==='active' 가 필요하다.
const ROOMBOT_KEYS = ['exempt', 'visit', 'churn', 'leaveKick', 'profile', 'promo', 'cover', 'hide', 'guard'];
const SECTIONS = Object.keys(SCHEMA);

const TEXT = {
  bad_value: '설정 값이 올바르지 않습니다. 페이지를 새로고침한 뒤 다시 저장해 주세요.',
  bad_prefix: '명령어 앞글자는 ! / . # 중에서 골라 주세요.',
  words_max: '금지어는 ' + MAX_WORDS + '개까지 등록할 수 있습니다.',
  word_len: '금지어는 한 개에 ' + MAX_WORD_LEN + '자까지 입력할 수 있습니다.',
  exempt_max: '제외 대상은 ' + MAX_EXEMPT + '명까지 등록할 수 있습니다.',
  exempt_bad: '제외 대상을 다시 골라 주세요.',
  exempt_name: '제외 대상의 이름은 ' + MAX_EXEMPT_NAME + '자까지 입력할 수 있습니다.',
  no_roombot: '이 방에는 방 관리봇이 설치되어 있지 않습니다.',
  no_minigame: '이 방에는 미니게임봇이 설치되어 있지 않습니다.',
  not_active: '부방장 지정을 기다리는 중입니다. 방장이 K bot을 부방장으로 지정하면 설정할 수 있습니다.',
  not_installed: '입금이 확인된 뒤에 설정할 수 있습니다.',
};

function has(o, k) {
  return !!o && Object.prototype.hasOwnProperty.call(o, k) && o[k] !== undefined;
}

function isObj(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function fail(status, reason, error) {
  return { ok: false, status: status, reason: reason, error: error };
}

// 정수: 숫자이거나 숫자만 있는 글자. 소수·빈 값·그 밖은 null
function toInt(v) {
  if (typeof v === 'number') return Number.isInteger(v) ? v : null;
  if (typeof v === 'string' && /^\s*-?\d{1,9}\s*$/.test(v)) return parseInt(v, 10);
  return null;
}

// 저장된 값(또는 기본값)을 읽을 때: 틀린 칸은 기본값으로(관대하게)
function lenientField(spec, v, dflt) {
  if (spec.t === 'bool') return typeof v === 'boolean' ? v : dflt;
  if (spec.t === 'enum') return spec.list.indexOf(v) >= 0 ? v : dflt;
  const n = toInt(v);
  return n !== null && n >= spec.lo && n <= spec.hi ? n : dflt;
}

// 들어온 값(저장 요청)을 볼 때: 틀리면 오류
function strictField(spec, v) {
  if (spec.t === 'bool') return typeof v === 'boolean' ? { ok: true, v: v } : { ok: false };
  if (spec.t === 'enum') return spec.list.indexOf(v) >= 0 ? { ok: true, v: v } : { ok: false };
  const n = toInt(v);
  return n !== null && n >= spec.lo && n <= spec.hi ? { ok: true, v: n } : { ok: false };
}

function cleanWord(v) {
  if (typeof v !== 'string' && typeof v !== 'number') return '';
  return String(v).replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
}

// 금지어 목록 — 지금 sanitizeWords 규칙(줄바꿈·쉼표로 나눔, 앞뒤 공백 제거, 대소문자 무시 중복 제거).
// strict 면 30자 초과·300개 초과를 오류로, 아니면 잘라 낸다.
function wordsOf(input, strict) {
  let src = input;
  if (typeof src === 'string') src = src.split(/[\r\n,]+/);
  if (!Array.isArray(src)) return strict ? { ok: false, error: TEXT.bad_value } : { ok: true, v: [] };
  const out = [];
  const seen = {};
  for (let i = 0; i < src.length; i++) {
    const w = cleanWord(src[i]);
    if (!w) continue;
    if (w.length > MAX_WORD_LEN) {
      if (strict) return { ok: false, error: TEXT.word_len };
      continue;
    }
    const k = w.toLowerCase();
    if (seen[k]) continue;
    seen[k] = true;
    out.push(w);
  }
  if (out.length > MAX_WORDS) {
    if (strict) return { ok: false, error: TEXT.words_max };
    out.length = MAX_WORDS;
  }
  return { ok: true, v: out };
}

function exemptOf(input, strict) {
  if (!Array.isArray(input)) return strict ? { ok: false, error: TEXT.exempt_bad } : { ok: true, v: [] };
  const out = [];
  const seen = {};
  for (let i = 0; i < input.length; i++) {
    const it = input[i];
    const uid = isObj(it) && (typeof it.user_id === 'string' || typeof it.user_id === 'number') ? String(it.user_id).trim() : '';
    if (!USER_ID_RE.test(uid)) {
      if (strict) return { ok: false, error: TEXT.exempt_bad };
      continue;
    }
    let name = isObj(it) && (typeof it.name === 'string' || typeof it.name === 'number') ? cleanWord(it.name) : '';
    if (name.length > MAX_EXEMPT_NAME) {
      if (strict) return { ok: false, error: TEXT.exempt_name };
      name = name.slice(0, MAX_EXEMPT_NAME);
    }
    if (seen[uid]) continue;
    seen[uid] = true;
    out.push({ user_id: uid, name: name });
  }
  if (out.length > MAX_EXEMPT) {
    if (strict) return { ok: false, error: TEXT.exempt_max };
    out.length = MAX_EXEMPT;
  }
  return { ok: true, v: out };
}

// 저장된 설정 → 7.1 의 모든 칸을 채운 완성본(틀린 칸은 기본값)
function normalizeRoomConfig(cfg) {
  const src = isObj(cfg) ? cfg : {};
  const out = { v: 1 };
  out.cmdPrefix = PREFIXES.indexOf(src.cmdPrefix) >= 0 ? src.cmdPrefix : DEFAULTS.cmdPrefix;
  out.exempt = exemptOf(src.exempt, false).v;
  SECTIONS.forEach((sec) => {
    const spec = SCHEMA[sec];
    const from = isObj(src[sec]) ? src[sec] : {};
    const d = DEFAULTS[sec];
    const one = {};
    Object.keys(d).forEach((k) => {
      if (sec === 'cover' && k === 'words') { one.words = wordsOf(from.words, false).v; return; }
      one[k] = spec[k] ? lenientField(spec[k], from[k], d[k]) : d[k];
    });
    out[sec] = one;
  });
  return out;
}

// -> {ok:true, config} | {ok:false, status, reason, error}. 온 부분만 바꾼다.
function sanitizeRoomConfig(prev, body, ctx) {
  const b = isObj(body) ? body : {};
  const c = ctx || {};
  const products = isObj(c.products) ? c.products : {};
  const display = c.display;

  // 제품·상태 검사(3.4.3 의 순서: 403 no_roombot/no_minigame → 409 not_active)
  const touchedRoombot = ROOMBOT_KEYS.filter((k) => has(b, k));
  if (touchedRoombot.length && !products.roombot) return fail(403, 'no_roombot', TEXT.no_roombot);
  if (has(b, 'games') && !products.minigame) return fail(403, 'no_minigame', TEXT.no_minigame);
  if (has(b, 'cmdPrefix') && (display === 'pending' || (!products.roombot && !products.minigame))) {
    return fail(409, 'not_installed', TEXT.not_installed);
  }
  if (touchedRoombot.length && display !== 'active') return fail(409, 'not_active', TEXT.not_active);

  const next = normalizeRoomConfig(prev);

  if (has(b, 'cmdPrefix')) {
    if (PREFIXES.indexOf(b.cmdPrefix) < 0) return fail(400, 'bad_cmdPrefix', TEXT.bad_prefix);
    next.cmdPrefix = b.cmdPrefix;
  }
  if (has(b, 'exempt')) {
    const ex = exemptOf(b.exempt, true);
    if (!ex.ok) return fail(400, 'bad_exempt', ex.error);
    next.exempt = ex.v;
  }
  for (let s = 0; s < SECTIONS.length; s++) {
    const sec = SECTIONS[s];
    if (!has(b, sec)) continue;
    const inSec = b[sec];
    if (!isObj(inSec)) return fail(400, 'bad_' + sec, TEXT.bad_value);
    const spec = SCHEMA[sec];
    const keys = Object.keys(spec);
    for (let i = 0; i < keys.length; i++) {
      const k = keys[i];
      if (!has(inSec, k)) continue;
      const r = strictField(spec[k], inSec[k]);
      if (!r.ok) return fail(400, 'bad_' + sec + '.' + k, spec[k].error || TEXT.bad_value);
      next[sec][k] = r.v;
    }
    if (sec === 'cover' && has(inSec, 'words')) {
      const w = wordsOf(inSec.words, true);
      if (!w.ok) return fail(400, 'bad_cover.words', w.error);
      next.cover.words = w.v;
    }
  }
  return { ok: true, config: next };
}

// -> 화면에 보낼 설정. 기본값을 채우고 상수 status_supported 를 같이 보낸다(7.2(c)).
function presentRoomConfig(cfg, products) {
  const out = normalizeRoomConfig(cfg);
  out.status_supported = STATUS_SUPPORTED;
  out.limits = { words: MAX_WORDS, word_len: MAX_WORD_LEN, exempt: MAX_EXEMPT };
  return out;
}

// 켜진 방 관리 기능 수(3.4.2 on_count 와 같은 규칙). 방 관리봇이 없으면 0.
function onCount(cfg, products) {
  if (!products || !products.roombot) return 0;
  const c = normalizeRoomConfig(cfg);
  return ['visit', 'churn', 'leaveKick', 'profile', 'promo', 'cover', 'guard']
    .filter((k) => c[k].enabled === true).length;
}

module.exports = {
  DEFAULTS, MAX_WORDS, MAX_EXEMPT, MAX_WORD_LEN, MAX_EXEMPT_NAME, STATUS_SUPPORTED, PREFIXES, ROOMBOT_KEYS, TEXT,
  sanitizeRoomConfig, presentRoomConfig, normalizeRoomConfig, onCount,
};
