'use strict';
// 운영 한도 — 관리자가 /manage [설정]에서 바꾼다. DB(app_settings)에 두고 메모리에 담아 바로 읽는다.
//   bot_room_cap    새 K bot 계정의 최대 방 수 기본값(이미 등록한 계정은 [봇] 탭에서 계정마다 바꾼다)
//   kakao_accounts  회원 1명이 패널에 등록할 수 있는 카카오 계정 수
//   sessions        한 아이디로 동시에 로그인할 수 있는 기기 수(넘으면 가장 오래 쓰지 않은 기기부터 로그아웃)
// 저장한 값이 없으면 기본값: 환경 변수(예전 방식) → 코드 기본값.
// 한 인스턴스라 저장하면 메모리 값도 바로 바뀐다. 배포가 겹치는 짧은 동안을 위해 1분마다 DB 를 다시 읽는다.

const db = require('./db');

const DEFS = {
  bot_room_cap:   { env: 'BOT_ROOM_CAP',        dflt: 20, min: 1, max: 200, unit: '개' },
  kakao_accounts: { env: 'MEMBER_MAX_ACCOUNTS', dflt: 3,  min: 1, max: 20,  unit: '개' },
  sessions:       { env: 'MEMBER_MAX_SESSIONS', dflt: 3,  min: 1, max: 10,  unit: '대' },
};
const LABELS = {
  bot_room_cap: '봇 1개당 기본 방 수',
  kakao_accounts: '회원 1명당 카카오 계정 수',
  sessions: '동시 로그인 기기 수',
};
const RELOAD_MS = 60000;

let saved = {};          // key → 저장한 값(정수)
let loadedAt = 0;
let loading = null;

function intIn(v, d) {
  const n = Number(v);
  return Number.isInteger(n) && n >= d.min && n <= d.max ? n : null;
}

function fallback(key) {
  const d = DEFS[key];
  const e = intIn(Math.floor(Number(process.env[d.env])), d);
  return e === null ? d.dflt : e;
}

async function load() {
  if (loading) return loading;
  loading = db.q('SELECT key, value FROM app_settings').then((r) => {
    const next = {};
    for (const row of r.rows || []) {
      const d = DEFS[row.key];
      const n = d ? intIn(row.value, d) : null;
      if (n !== null) next[row.key] = n;
    }
    saved = next;
    loadedAt = Date.now();
  }).finally(() => { loading = null; });
  return loading;
}

function get(key) {
  if (!DEFS[key]) throw new Error('unknown setting ' + key);
  if (loadedAt && Date.now() - loadedAt > RELOAD_MS) load().catch(() => { /* 다음 읽기에서 다시 */ });
  return Object.prototype.hasOwnProperty.call(saved, key) ? saved[key] : fallback(key);
}

// 입력 검사. 문제가 없으면 null, 있으면 화면 문구.
function problem(key, value) {
  const d = DEFS[key];
  if (!d) return '알 수 없는 설정입니다.';
  if (intIn(value, d) === null) return LABELS[key] + '는 ' + d.min + '~' + d.max + d.unit + '로 입력해 주세요.';
  return null;
}

// values: {key: 정수}. 검사를 모두 통과해야 저장한다. → 바뀐 항목 [{key, from, to}]
async function save(values) {
  const keys = Object.keys(values || {});
  for (const k of keys) {
    const p = problem(k, values[k]);
    if (p) {
      const err = new Error(p);
      err.code = 'bad_setting';
      throw err;
    }
  }
  const now = Date.now();
  const changed = [];
  for (const k of keys) {
    const from = get(k);
    const to = Number(values[k]);
    await db.q(
      `INSERT INTO app_settings (key, value, updated_at) VALUES ($1, $2::jsonb, $3)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at`,
      [k, JSON.stringify(to), now]);
    saved[k] = to;
    if (from !== to) changed.push({ key: k, from, to });
  }
  return changed;
}

// 관리 화면용: 지금 값·기본값·범위
function view() {
  return Object.keys(DEFS).map((k) => ({
    key: k, label: LABELS[k], value: get(k), default: fallback(k),
    min: DEFS[k].min, max: DEFS[k].max, unit: DEFS[k].unit,
    saved: Object.prototype.hasOwnProperty.call(saved, k),
  }));
}

module.exports = { DEFS, LABELS, load, get, problem, save, view };
