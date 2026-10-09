// 방 설정 검사 (DB 없이 돈다). docs/ACCOUNTS_V1.md 7.1·9.5 작업 1.
// 7.1 범위·열거, 금지어 300·제외 50, 제품 없음 403, 사용 중 아님 409, games.cooldownSec 0 거절,
// games.enabled 기본 true, 온 부분만 바꿈, 저장값 정리. 마지막 줄에 'room-config check ok'.
'use strict';

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

const rc = require('./room-config');

assert(typeof rc.sanitizeRoomConfig === 'function', 'room-config.sanitizeRoomConfig is exported');
assert(typeof rc.presentRoomConfig === 'function', 'room-config.presentRoomConfig is exported');
assert(rc.MAX_WORDS === 300, 'room-config.MAX_WORDS = 300');
assert(rc.MAX_EXEMPT === 50, 'room-config.MAX_EXEMPT = 50');
assert(Object.isFrozen(rc.DEFAULTS) && Object.isFrozen(rc.DEFAULTS.churn), 'DEFAULTS is frozen');

// ── 7.1 기본값
const D = rc.DEFAULTS;
assert(D.v === 1 && D.cmdPrefix === '!' && Array.isArray(D.exempt) && D.exempt.length === 0, 'v·cmdPrefix·exempt');
assert(D.games.enabled === true && D.games.word && D.games.baseball && D.games.dice && D.games.rps && D.games.quiz
  && D.games.cooldownSec === 3 && D.games.dailyLimit === 0, 'games are on by default (7.1)');
['visit', 'churn', 'leaveKick', 'profile', 'promo', 'cover', 'guard'].forEach(function (k) {
  assert(D[k].enabled === false, 'room-management feature ' + k + ' is off by default (D15)');
});
assert(D.churn.joins === 3 && D.churn.windowMin === 10 && D.churn.action === 'warn' && D.churn.notice === true, 'churn defaults');
assert(D.leaveKick.notice === false, 'leaveKick.notice default false');
assert(D.profile.name && D.profile.photo && D.profile.status && D.profile.lookup === 'staff', 'profile defaults');
assert(D.promo.links && D.promo.cards && !D.promo.media && D.promo.hide && D.promo.kickAt === 3 && D.promo.resetHours === 24 && D.promo.notice, 'promo defaults');
assert(D.cover.words.length === 0 && D.cover.links === true && D.hide.command === true, 'cover·hide defaults');
assert(D.guard.secs === 30 && D.guard.count === 5, 'guard defaults');

const BOTH = { products: { roombot: true, minigame: true }, display: 'active' };
function ok(body, prev, ctx) {
  const r = rc.sanitizeRoomConfig(prev || {}, body, ctx || BOTH);
  assert(r.ok, 'expected ok: ' + JSON.stringify(body) + ' → ' + JSON.stringify(r));
  return r.config;
}
function bad(body, status, reason, error, prev, ctx) {
  const r = rc.sanitizeRoomConfig(prev || {}, body, ctx || BOTH);
  assert(!r.ok && r.status === status && r.reason === reason,
    'expected ' + status + ' ' + reason + ': ' + JSON.stringify(body).slice(0, 120) + ' → ' + JSON.stringify(r));
  if (error) assert(r.error === error, 'error copy for ' + reason + ': ' + r.error);
  return r;
}

// ── 빈 저장은 완성본(기본값)으로
const empty = ok({});
assert(JSON.stringify(empty) === JSON.stringify(rc.normalizeRoomConfig({})), 'empty body keeps defaults');
assert(empty.games.enabled === true && empty.cmdPrefix === '!' && empty.v === 1, 'complete config');

// ── 범위·열거 (7.1 표)
assert(ok({ churn: { enabled: true, joins: 2, windowMin: 1440, action: 'kick', notice: false } }).churn.action === 'kick', 'churn ok');
assert(ok({ churn: { joins: '20' } }).churn.joins === 20, 'numeric string accepted');
bad({ churn: { joins: 1 } }, 400, 'bad_churn.joins', '들낙 감지 횟수는 2~20회로 입력하십시오.');
bad({ churn: { joins: 21 } }, 400, 'bad_churn.joins');
bad({ churn: { joins: 2.5 } }, 400, 'bad_churn.joins');
bad({ churn: { windowMin: 0 } }, 400, 'bad_churn.windowMin');
bad({ churn: { windowMin: 1441 } }, 400, 'bad_churn.windowMin');
bad({ churn: { action: 'ban' } }, 400, 'bad_churn.action');
bad({ churn: { enabled: 'true' } }, 400, 'bad_churn.enabled');
bad({ churn: 'on' }, 400, 'bad_churn');
bad({ leaveKick: { notice: 1 } }, 400, 'bad_leaveKick.notice');
assert(ok({ profile: { lookup: 'all' } }).profile.lookup === 'all' && ok({ profile: { lookup: 'off' } }).profile.lookup === 'off', 'profile.lookup enum');
bad({ profile: { lookup: 'admins' } }, 400, 'bad_profile.lookup');
assert(ok({ promo: { kickAt: 0 } }).promo.kickAt === 0 && ok({ promo: { kickAt: 10, resetHours: 720 } }).promo.resetHours === 720, 'promo bounds');
bad({ promo: { kickAt: 11 } }, 400, 'bad_promo.kickAt');
bad({ promo: { kickAt: -1 } }, 400, 'bad_promo.kickAt');
bad({ promo: { resetHours: 0 } }, 400, 'bad_promo.resetHours');
bad({ promo: { resetHours: 721 } }, 400, 'bad_promo.resetHours');
bad({ guard: { secs: 4 } }, 400, 'bad_guard.secs');
bad({ guard: { secs: 301 } }, 400, 'bad_guard.secs');
bad({ guard: { count: 2 } }, 400, 'bad_guard.count');
bad({ guard: { count: 31 } }, 400, 'bad_guard.count');
assert(ok({ guard: { secs: 5, count: 30 } }).guard.count === 30, 'guard bounds');
bad({ games: { cooldownSec: 0 } }, 400, 'bad_games.cooldownSec', '미니게임 쿨타임은 1~60초로 입력하십시오.');
bad({ games: { cooldownSec: 61 } }, 400, 'bad_games.cooldownSec');
assert(ok({ games: { cooldownSec: 1 } }).games.cooldownSec === 1 && ok({ games: { cooldownSec: 60 } }).games.cooldownSec === 60, 'cooldown 1~60');
assert(ok({ games: { dailyLimit: 0 } }).games.dailyLimit === 0 && ok({ games: { dailyLimit: 5000 } }).games.dailyLimit === 5000, 'dailyLimit 0~5000');
bad({ games: { dailyLimit: 5001 } }, 400, 'bad_games.dailyLimit');
bad({ games: { quiz: 'no' } }, 400, 'bad_games.quiz');
['!', '/', '.', '#'].forEach(function (p) { assert(ok({ cmdPrefix: p }).cmdPrefix === p, 'prefix ' + p); });
bad({ cmdPrefix: '?' }, 400, 'bad_cmdPrefix');
bad({ cmdPrefix: '!!' }, 400, 'bad_cmdPrefix');
bad({ hide: { command: 'yes' } }, 400, 'bad_hide.command');
assert(ok({ hide: { command: false } }).hide.command === false, 'hide.command');

// ── 금지어 300개 (7.1, 7.7 #11)
const words300 = [];
for (let i = 0; i < 300; i++) words300.push('금지어' + i);
let cfg = ok({ cover: { enabled: true, words: words300 } });
assert(cfg.cover.words.length === 300 && cfg.cover.enabled === true, '300 words pass');
bad({ cover: { words: words300.concat(['하나더']) } }, 400, 'bad_cover.words', '금지어는 300개까지 등록할 수 있습니다.');
bad({ cover: { words: ['x'.repeat(31)] } }, 400, 'bad_cover.words');
assert(ok({ cover: { words: ['x'.repeat(30)] } }).cover.words[0].length === 30, '30-char word passes');
cfg = ok({ cover: { words: ['Spam', 'spam', ' 스팸 ', '', 'a\u0007b'] } });
assert(JSON.stringify(cfg.cover.words) === JSON.stringify(['Spam', '스팸', 'a b']), 'words trimmed, deduped case-insensitively, control chars removed');
assert(ok({ cover: { words: '하나\n둘,셋' } }).cover.words.length === 3, 'newline/comma separated string accepted');
assert(ok({ cover: { words: words300.concat(words300) } }).cover.words.length === 300, 'duplicates do not count toward 300');
bad({ cover: { words: { a: 1 } } }, 400, 'bad_cover.words');

// ── 제외할 사람 50명
const ex50 = [];
for (let i = 1; i <= 50; i++) ex50.push({ user_id: String(1000 + i), name: '사람' + i });
cfg = ok({ exempt: ex50 });
assert(cfg.exempt.length === 50 && cfg.exempt[0].user_id === '1001', '50 exempt pass');
bad({ exempt: ex50.concat([{ user_id: '9999', name: 'x' }]) }, 400, 'bad_exempt', '제외할 사람은 50명까지 등록할 수 있습니다.');
bad({ exempt: [{ user_id: '0123', name: 'x' }] }, 400, 'bad_exempt');
bad({ exempt: [{ user_id: 'abc', name: 'x' }] }, 400, 'bad_exempt');
bad({ exempt: [{ user_id: '1'.repeat(21), name: 'x' }] }, 400, 'bad_exempt');
bad({ exempt: [{ user_id: '5', name: 'x'.repeat(41) }] }, 400, 'bad_exempt');
bad({ exempt: 'all' }, 400, 'bad_exempt');
cfg = ok({ exempt: [{ user_id: 77, name: '숫자' }, { user_id: '77', name: '중복' }] });
assert(cfg.exempt.length === 1 && cfg.exempt[0].user_id === '77' && cfg.exempt[0].name === '숫자', 'exempt user_id normalized and deduped');

// ── 제품·상태 검사 (7.1 끝, 3.4.3)
const GAMES_ONLY = { products: { roombot: false, minigame: true }, display: 'active' };
const BOT_ONLY = { products: { roombot: true, minigame: false }, display: 'active' };
const WAITING = { products: { roombot: true, minigame: true }, display: 'waiting' };
['exempt', 'visit', 'churn', 'leaveKick', 'profile', 'promo', 'cover', 'hide', 'guard'].forEach(function (k) {
  const body = {};
  body[k] = k === 'exempt' ? [] : { enabled: true };
  if (k === 'hide') body[k] = { command: false };
  bad(body, 403, 'no_roombot', '이 방에는 방 관리봇이 설치되어 있지 않습니다.', {}, GAMES_ONLY);
  bad(body, 409, 'not_active', '부방장 지정을 기다리는 중입니다. 방장이 K bot 계정을 부방장으로 지정하면 설정할 수 있습니다.', {}, WAITING);
});
bad({ games: { enabled: false } }, 403, 'no_minigame', '이 방에는 미니게임봇이 설치되어 있지 않습니다.', {}, BOT_ONLY);
assert(ok({ games: { enabled: false } }, {}, WAITING).games.enabled === false, 'games can be saved while waiting for the host');
assert(ok({ cmdPrefix: '/' }, {}, WAITING).cmdPrefix === '/', 'command prefix can be saved while waiting');
assert(ok({ cmdPrefix: '#' }, {}, GAMES_ONLY).cmdPrefix === '#', 'command prefix with minigame only');
assert(ok({ cmdPrefix: '.' }, {}, { products: { roombot: true, minigame: false }, display: 'error' }).cmdPrefix === '.', 'prefix on an errored install');
bad({ cmdPrefix: '/' }, 409, 'not_installed', null, {}, { products: { roombot: false, minigame: false }, display: 'pending' });
bad({ churn: { joins: 99 } }, 403, 'no_roombot', null, {}, GAMES_ONLY);           // 제품 검사가 값 검증보다 먼저
bad({ churn: { joins: 99 } }, 409, 'not_active', null, {}, WAITING);              // 상태 검사도 값 검증보다 먼저

// ── 온 부분만 바꾼다
const prev = ok({ churn: { enabled: false, joins: 7, windowMin: 30, action: 'kick' }, cmdPrefix: '#', cover: { words: ['하나'] } });
cfg = ok({ churn: { enabled: true } }, prev);
assert(cfg.churn.enabled === true && cfg.churn.joins === 7 && cfg.churn.windowMin === 30 && cfg.churn.action === 'kick', 'untouched fields kept');
assert(cfg.cmdPrefix === '#' && cfg.cover.words[0] === '하나', 'untouched sections kept');
cfg = ok({ cover: { enabled: true } }, prev);
assert(cfg.cover.words.length === 1, 'words kept when only the switch changes');
cfg = ok({ id: 12, rev: 3, unknown: { x: 1 }, churn: { extra: 1 } }, prev);
assert(cfg.id === undefined && cfg.rev === undefined && cfg.unknown === undefined && cfg.churn.extra === undefined, 'unknown keys are not stored');
assert(JSON.stringify(rc.normalizeRoomConfig(prev)) === JSON.stringify(prev), 'normalize is idempotent');

// ── 저장값 정리(관대하게): 틀린 저장값은 기본값으로
const messy = rc.normalizeRoomConfig({ cmdPrefix: '?', churn: { joins: 99, action: 'x', enabled: 'yes' }, games: null,
  cover: { words: ['a', 'A', 'x'.repeat(40)] }, exempt: [{ user_id: 'x' }, { user_id: '5', name: 'n' }] });
assert(messy.cmdPrefix === '!' && messy.churn.joins === 3 && messy.churn.action === 'warn' && messy.churn.enabled === false, 'bad stored values → defaults');
assert(messy.games.enabled === true && messy.cover.words.length === 1 && messy.exempt.length === 1, 'stored lists cleaned');
assert(rc.normalizeRoomConfig(null).games.enabled === true, 'null config → defaults');

// ── 화면용
const shown = rc.presentRoomConfig({}, { roombot: false, minigame: true });
assert(shown.games.enabled === true && shown.status_supported === true && shown.cmdPrefix === '!', 'present fills defaults + status_supported');
assert(shown.limits.words === 300 && shown.limits.exempt === 50, 'present carries limits');
assert(rc.onCount(ok({ visit: { enabled: true }, guard: { enabled: true } }), { roombot: true }) === 2, 'onCount counts enabled features');
assert(rc.onCount(ok({ visit: { enabled: true } }), { roombot: false }) === 0, 'onCount is 0 without the room bot');

process.stdout.write('room-config check ok\n');
