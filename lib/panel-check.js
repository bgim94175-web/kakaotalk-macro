'use strict';

const fs = require('fs');
const path = require('path');

process.env.CONFIG_SECRET = process.env.CONFIG_SECRET || 'panel-check-secret-value';

const auth = require('./panel-auth');
const text = require('./auth-text');
const cfg = require('./panel-config');

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

const future = Date.now() + 86400000;
const gate = auth.assess(
  { key: 'KAKA-TEST-TEST-TEST', revoked: false, blocked_reason: null, device_id: 'phone-1' },
  [{ feature: 'macro', expires_at: future }, { feature: 'roombot', expires_at: future }],
  Date.now());
assert(gate.ok, 'bound device still logs in');
assert(gate.features.roombot.on, 'roombot entitlement is visible');
assert(!/device_id/.test(JSON.stringify(gate)), 'assess result has no device id');

const expired = auth.assess(
  { revoked: false },
  [{ feature: 'macro', expires_at: Date.now() - 1000 }],
  Date.now());
assert(!expired.ok && expired.error.indexOf('끝났') >= 0, 'expired macro');

const unstarted = auth.assess({ revoked: false }, [{ feature: 'macro', expires_at: null }], Date.now());
assert(!unstarted.ok && unstarted.error.indexOf('시작되지') >= 0, 'unstarted macro');
// 로그인이 기간을 시작시킬 수 있도록, 미개시는 다른 거절과 구분되어야 한다
assert(unstarted.not_started === true, 'unstarted is flagged for the caller');
assert(!expired.not_started, 'expired must not look like unstarted');
assert(!auth.assess({ revoked: true }, [{ feature: 'macro', expires_at: null }]).not_started,
  'revoked key must not start its period');
assert(!auth.assess({ revoked: false }, [], Date.now()).not_started,
  'a key without macro must not start its period');
assert(!auth.assess({ revoked: true }, [{ feature: 'macro', expires_at: future }]).ok, 'revoked');

const token = auth.sign('KAKA-TEST-TEST-TEST', Date.now() + 60000);
const read = auth.readToken(token);
assert(read && read.key === 'KAKA-TEST-TEST-TEST', 'cookie roundtrip');
assert(!auth.readToken(token.slice(0, -2) + 'aa'), 'bad signature');

const t111 = text.customerText({ message: '다른 기기에서 로그인할 수 없습니다.', status: -111, device_name: 'Galaxy Tab S9', device_model: 'SM-X710' });
assert(t111.indexOf('다른 기기에서 로그인할 수 없습니다. (오류 번호 -111)') >= 0, '-111 code in brackets after the sentence');
assert(t111.indexOf('다른 기기에서 로그인할 수 없습니다.') >= 0, '-111 message');
assert(t111.indexOf('이용자 보호조치') < 0, '-111 is not rewritten as a protection block');
assert(t111.indexOf('카카오 상태') < 0, 'status code is shown only as (오류 번호 N)');

const t111b = text.customerText({ message: '이용자 보호조치로 막혔습니다.', status: -111 });
assert(t111b.indexOf('이용자 보호조치') < 0, '-111 drops the protection sentence');
assert(t111b === '카카오 로그인에 실패했습니다. (오류 번호 -111)', '-111 still shows the code with a sentence: ' + t111b);

const t328 = text.customerText({ message: 'Login failed with status -328', status: -328 });
assert(t328.indexOf('추가 기기 로그인이 막혀 있습니다. 카카오톡에서 보호조치를 해제한 뒤 다시 시도해 주세요.') >= 0, '-328 sentence says what to do');
assert(t328.indexOf('서브디바이스') < 0 && t328.indexOf('(오류 번호 -328)') >= 0, '-328 code');
assert(text.customerText({}) === '카카오가 실패 이유를 알려 주지 않았습니다. 잠시 뒤 다시 시도해 주세요.', 'no reason → what happened + what to do');
assert(text.customerText({ status: 12 }).indexOf('카카오 계정 또는 비밀번호') === 0, '카카오 계정 is spaced');

const t997 = text.customerText({ message: 'Login failed with status -997' });
assert(t997.indexOf('카카오가 이용을 제한한 계정입니다.') >= 0, '-997 sentence');
assert(t997.indexOf('(오류 번호 -997)') >= 0, '-997 code');

const sep = cfg.SEP;
const openRoom = { key: '0' + sep + '오픈', chat_id: '11', name: '오픈', list_kind: 'open_room', kind: 'open' };
const normal = { key: '0' + sep + '단톡', chat_id: '22', name: '단톡', list_kind: 'normal', kind: 'group' };
const dm = { key: '0' + sep + '갠톡', chat_id: '33', name: '갠톡', list_kind: 'open_dm', kind: 'open' };
const merged = cfg.mergeCatalog([], [
  { chat_id: '11', title: '오픈', list_kind: 'open_room', kind: 'open', type: 'OM' },
  { chat_id: '22', title: '단톡', list_kind: 'normal', kind: 'group', type: 'MultiChat' },
  { chat_id: '33', title: '갠톡', list_kind: 'open_dm', kind: 'open', type: 'OD' },
]);
assert(merged.length === 3, 'catalog keeps every chat for inbound replies');
const shown = cfg.splitRooms(merged);
assert(shown.open.length === 1 && shown.open[0].name === '오픈', 'open room');
assert(shown.normal.length === 0, 'normal chats are not in the picker');
assert(JSON.stringify(shown).indexOf('단톡') < 0, 'normal room is not offered');
assert(JSON.stringify(shown).indexOf('갠톡') < 0, 'open profile dm is not in the picker');

const named = cfg.mergeCatalog([], [
  { chat_id: '44', title: null, display_name: '김, 이, 박', list_kind: 'normal', type: 2 },
  { chat_id: '55', title: '동네모임', display_name: '김, 이, 박', list_kind: 'open_room', type: 'OM' },
  { chat_id: '66', title: null, display_name: '김, 이, 박', list_kind: 'open_room', type: 'OM' },
  { chat_id: '77', title: '김철수, 이영희', display_name: '김, 이', list_kind: 'open_room', type: 'OM' },
]);
const namedSplit = cfg.splitRooms(named);
assert(namedSplit.normal.length === 0, 'normal chats stay out of the picker');
assert(JSON.stringify(namedSplit).indexOf('김, 이, 박') < 0, 'member names are not a room in the picker');
assert(namedSplit.open.some(function (r) { return r.name === '동네모임'; }), 'open room uses the room title');
assert(namedSplit.open.some(function (r) { return r.name === '김철수, 이영희'; }), 'a real open title may contain nicknames');
assert(!namedSplit.open.some(function (r) { return r.name === '김, 이, 박'; }), 'member list is not an open room name');
assert(!namedSplit.open.some(function (r) { return r.name.indexOf('오픈채팅') === 0; }), 'untitled open room is left out');
const invented = cfg.splitRooms([{ key: '0' + sep + '만든이름', chat_id: '995542', name: '오픈채팅 5542', list_kind: 'open_room' }]);
assert(invented.open.length === 0, 'generated open label is not shown');
// 이번에 이름을 못 읽은 오픈채팅방은 전에 쓰던 이름(같은 키)을 쓴다. 이름을 새로 만들지는 않고, 몇 개인지만 알린다.
const prevRooms = [
  { key: '0' + sep + '공지방', chat_id: '141', name: '공지방', list_kind: 'open_room', kind: 'open' },
  { key: '0' + sep + '오픈채팅 0142', chat_id: '990142', name: '오픈채팅 0142', list_kind: 'open_room', kind: 'open' },
  { key: '0' + sep + '김, 이, 박', chat_id: '143', name: '김, 이, 박', list_kind: 'normal', kind: 'group' },
];
const reload = [
  { chat_id: '141', title: null, display_name: null, list_kind: 'open_room', kind: 'open', type: 13, members: 30 },
  { chat_id: '990142', title: null, display_name: null, list_kind: 'open_room', kind: 'open', type: 13, members: 30 },
  { chat_id: '143', title: null, display_name: null, list_kind: 'open_room', kind: 'open', type: 2, members: 4 },
  { chat_id: '144', title: null, display_name: null, list_kind: 'open_room', kind: 'group', type: 'OC', members: 40 },
  { chat_id: '145', title: '새 방', display_name: null, list_kind: 'open_room', kind: 'open', type: 13, members: 9 },
  { chat_id: '146', title: null, display_name: '엄마, 아빠', list_kind: 'normal', kind: 'group', type: 10, members: 3 },
];
const kept = cfg.mergeCatalog(prevRooms, reload);
const keptOpen = cfg.splitRooms(kept).open;
assert(keptOpen.length === 2 && keptOpen[0].name === '공지방' && keptOpen[0].key === prevRooms[0].key && keptOpen[1].name === '새 방',
  'an unnamed open room keeps its old name and key');
assert(!kept.some(function (r) { return r.chat_id === '990142'; }), 'a made-up old name is not reused');
assert(!kept.some(function (r) { return r.chat_id === '143'; }), 'an old normal-chat name is not an open room name');
assert(!kept.some(function (r) { return r.chat_id === '144'; }), 'an unnamed open room is not given a name');
assert(cfg.unnamedRooms(kept, reload) === 3, 'the panel is told how many open rooms have no name yet');
assert(cfg.unnamedRooms(merged, [{ chat_id: '11', list_kind: 'open_room' }, { chat_id: '22', list_kind: 'normal' }]) === 0,
  'named open rooms and normal chats are not counted');

const prev = {
  accounts: ['main'],
  guard: { rooms: ['keep'], kickOn: true },
  macro: { enabled: false, minMessages: 1, dailyLimit: 200, notifyReply: true, sendImages: 'NEVER' },
  autoreply: { enabled: false, message: '', cooldownMs: 0 },
  triggers: [],
};
const jpeg = Buffer.from([0xFF, 0xD8, 0xFF, 0xD9]).toString('base64');
const images = cfg.normalizeImages([jpeg]);
assert(images.length === 1, 'jpeg accepted');
let bad = false;
try { cfg.normalizeImages(['aGVsbG8=']); } catch (e) { bad = true; }
assert(bad, 'non image rejected');

const next = cfg.applySettings(prev, {
  macro: {
    enabled: true,
    message: '안녕',
    baseMin: 1,
    randomMin: 3,
    rooms: [openRoom.key, dm.key, normal.key],
    roomCooldownMin: { [normal.key]: 5, [dm.key]: 9 },
  },
  images: [jpeg],
}, merged, images.length);
assert(next.guard && next.guard.kickOn === true, 'guard settings stay');
assert(next.macro.notifyReply === false, 'server send, not phone reply');
assert(next.macro.sendImages === 'EVERY', 'images send every time');
assert(next.macro.images.length === 1, 'image marker');
assert(next.macro.rooms.length === 1 && next.macro.rooms[0] === openRoom.key, 'only open rooms can be selected');
assert(next.macro.rooms.indexOf(dm.key) < 0, 'dm not selected');
assert(next.macro.rooms.indexOf(normal.key) < 0, 'normal room not selected');
assert(next.macro.roomCooldownMin[normal.key] == null, 'normal room cooldown dropped');
assert(next.macro.roomCooldownMin[dm.key] == null, 'dm cooldown dropped');
assert(next.macro.baseMin === 1 && next.macro.randomMin === 3, 'base and random are separate');
assert(next.accounts.length === 0, 'web account is on');
assert(next.visit == null, 'macro save does not invent the join notice');

const visitOff = cfg.applySettings(prev, {
  visit: { enabled: false, rooms: [openRoom.key, dm.key, normal.key] },
}, merged, 0);
assert(visitOff.visit.enabled === false, 'join notice stays off');
assert(visitOff.visit.rooms.length === 1 && visitOff.visit.rooms[0] === openRoom.key, 'join notice rooms are open chats only');
assert(visitOff.guard.kickOn === true, 'join notice does not change the room bot');
const visitOn = cfg.applySettings(prev, {
  visit: { enabled: true, rooms: [normal.key] },
}, merged, 0);
assert(visitOn.visit.enabled === true && visitOn.visit.rooms.length === 0, 'a normal room is not a join-notice target');
assert(cfg.presentVisit(null).enabled === false, 'missing join notice is off');
const keptCover = cfg.applySettings(Object.assign({}, prev, {
  cover: { enabled: true, rooms: [openRoom.key] },
}), {
  visit: { enabled: true, rooms: [openRoom.key] },
}, merged, 0);
assert(keptCover.cover && keptCover.cover.enabled === true, 'join notice does not change profanity cover');
const coverOn = cfg.applySettings(prev, {
  cover: { enabled: true, rooms: [openRoom.key, normal.key] },
}, merged, 0);
assert(coverOn.cover.enabled === true && coverOn.cover.rooms.length === 1 && coverOn.cover.rooms[0] === openRoom.key, 'cover rooms are open chats only');
assert(coverOn.visit == null, 'cover save does not invent the join notice');
assert(cfg.presentCover(null).enabled === false, 'missing cover is off');

const profileOn = cfg.applySettings(prev, {
  profile: { enabled: true, rooms: [openRoom.key, normal.key] },
}, merged, 0);
assert(profileOn.profile.enabled === true && profileOn.profile.rooms.length === 1 && profileOn.profile.rooms[0] === openRoom.key, 'profile-change rooms are open chats only');
assert(profileOn.visit == null && profileOn.cover == null, 'profile save does not invent the other notices');
assert(cfg.presentProfile(null).enabled === false, 'missing profile detection is off');
const keptProfile = cfg.applySettings(Object.assign({}, prev, {
  profile: { enabled: true, rooms: [openRoom.key] },
}), {
  visit: { enabled: true, rooms: [openRoom.key] },
}, merged, 0);
assert(keptProfile.profile && keptProfile.profile.enabled === true, 'join notice does not change profile detection');

// ── 금지어 검열: 고객 금지어 + 링크 끄기 (config.cover.words / links)
const coverWords = cfg.applySettings(prev, {
  cover: {
    enabled: true,
    rooms: [openRoom.key, dm.key],
    words: ['  토토 ', '토토', 'TOTO', 'toto', '', '   ', 'x'.repeat(31), 'y'.repeat(30), 7, null, { a: 1 }],
    links: false,
  },
}, merged, 0);
assert(coverWords.cover.rooms.length === 1 && coverWords.cover.rooms[0] === openRoom.key, 'cover words save keeps open rooms only');
assert(JSON.stringify(coverWords.cover.words) === JSON.stringify(['토토', 'TOTO', 'y'.repeat(30), '7']),
  'words are trimmed, deduped (case-insensitive), 1-30 chars: ' + JSON.stringify(coverWords.cover.words));
assert(coverWords.cover.links === false, 'links can be turned off');
const manyWords = [];
for (let i = 0; i < 260; i++) manyWords.push('w' + i);
assert(cfg.applySettings(prev, { cover: { enabled: true, words: manyWords } }, merged, 0).cover.words.length === 200, 'at most 200 words');
const oldCoverPrev = Object.assign({}, prev, { cover: { enabled: true, rooms: [openRoom.key], words: ['토토'], links: false } });
const oldUiSave = cfg.applySettings(oldCoverPrev, { cover: { enabled: false, rooms: [openRoom.key] } }, merged, 0);
assert(oldUiSave.cover.enabled === false && oldUiSave.cover.words[0] === '토토' && oldUiSave.cover.links === false,
  'a save without words/links keeps the saved words and links');
const clearWords = cfg.applySettings(oldCoverPrev, { cover: { enabled: true, rooms: [], words: [], links: true } }, merged, 0);
assert(clearWords.cover.words.length === 0 && clearWords.cover.links === true, 'words can be cleared and links turned back on');
const legacyCover = cfg.presentCover({ enabled: true, rooms: [openRoom.key] });
assert(legacyCover.links === true && Array.isArray(legacyCover.words) && legacyCover.words.length === 0, 'old cover config: links on, no words');
assert(cfg.presentCover(null).links === true && cfg.presentCover(null).words.length === 0, 'missing cover: links default on');
assert(cfg.presentCover({ links: false }).links === false, 'links off is shown');
assert(Object.keys(cfg.presentCover(null)).sort().join() === 'enabled,links,rooms,words', 'cover view shape');
assert(coverWords.guard.kickOn === true && coverWords.guard.rooms[0] === 'keep', 'cover save does not change guard');

// ── 올킥 방지: config.guard 의 강퇴 감지 칸만 바꾸고 나머지는 그대로
const guardPrev = Object.assign({}, prev, {
  guard: { rooms: ['keep'], kickOn: false, welcomeOn: true, welcomeText: '어서 오세요', floodOn: true, floodCount: 9, presenceMin: 45 },
  visit: { enabled: true, rooms: [openRoom.key] },
  cover: { enabled: true, rooms: [openRoom.key], words: ['토토'], links: false },
});
const guardOn = cfg.applySettings(guardPrev, {
  guard: { enabled: true, rooms: [openRoom.key, normal.key, dm.key, 'nope'], secs: 45, count: 7 },
}, merged, 0);
assert(guardOn.guard.kickOn === true && guardOn.guard.kickSecs === 45 && guardOn.guard.kickCount === 7, 'guard save sets the kick detection');
assert(guardOn.guard.rooms.length === 1 && guardOn.guard.rooms[0] === openRoom.key, 'guard rooms are open chats only');
assert(guardOn.guard.welcomeOn === true && guardOn.guard.welcomeText === '어서 오세요' && guardOn.guard.floodOn === true
  && guardOn.guard.floodCount === 9 && guardOn.guard.presenceMin === 45, 'guard save keeps every other guard field');
assert(guardPrev.guard.kickOn === false && guardPrev.guard.rooms[0] === 'keep', 'guard save does not mutate the previous config');
assert(JSON.stringify(guardOn.visit) === JSON.stringify(guardPrev.visit) && JSON.stringify(guardOn.cover) === JSON.stringify(guardPrev.cover),
  'guard save does not change visit or cover');
const guardLow = cfg.applySettings(guardPrev, { guard: { enabled: true, rooms: [], secs: 1, count: 0 } }, merged, 0);
assert(guardLow.guard.kickOn === true && guardLow.guard.kickSecs === 5 && guardLow.guard.kickCount === 3, 'guard clamps up to 5s / 3 kicks');
const guardHigh = cfg.applySettings(guardPrev, { guard: { enabled: false, secs: 9999, count: 999 } }, merged, 0);
assert(guardHigh.guard.kickOn === false && guardHigh.guard.kickSecs === 300 && guardHigh.guard.kickCount === 30, 'guard clamps down to 300s / 30 kicks');
assert(guardHigh.guard.rooms.length === 0, 'no rooms sent means no rooms');
['false', 1, 'true', null].forEach(function (v) {
  assert(cfg.applySettings(guardPrev, { guard: { enabled: v } }, merged, 0).guard.kickOn === false, 'only enabled === true turns kick detection on: ' + JSON.stringify(v));
});
const guardDefault = cfg.applySettings(prev, { guard: { enabled: true, rooms: [openRoom.key] } }, merged, 0);
assert(guardDefault.guard.kickSecs === 30 && guardDefault.guard.kickCount === 5, 'guard defaults 30s / 5 kicks');
const guardKeepNums = cfg.applySettings(Object.assign({}, prev, { guard: { kickSecs: 60, kickCount: 10 } }), { guard: { enabled: true, secs: '', count: null } }, merged, 0);
assert(guardKeepNums.guard.kickSecs === 60 && guardKeepNums.guard.kickCount === 10, 'missing numbers keep the saved ones');
const guardNoPrev = cfg.applySettings({ macro: prev.macro }, { guard: { enabled: true, rooms: [openRoom.key], secs: '40', count: '6' } }, merged, 0);
assert(guardNoPrev.guard.kickOn === true && guardNoPrev.guard.kickSecs === 40 && guardNoPrev.guard.kickCount === 6, 'guard works without a previous guard');
const visitAfterGuard = cfg.applySettings(guardPrev, { visit: { enabled: false, rooms: [] } }, merged, 0);
assert(JSON.stringify(visitAfterGuard.guard) === JSON.stringify(guardPrev.guard), 'visit save does not change guard');
const coverAfterGuard = cfg.applySettings(guardPrev, { cover: { enabled: false, rooms: [] } }, merged, 0);
assert(JSON.stringify(coverAfterGuard.guard) === JSON.stringify(guardPrev.guard), 'cover save does not change guard');
const profileAfterGuard = cfg.applySettings(guardPrev, { profile: { enabled: true, rooms: [openRoom.key] } }, merged, 0);
assert(JSON.stringify(profileAfterGuard.guard) === JSON.stringify(guardPrev.guard), 'profile save does not change guard');
const gv = cfg.presentGuard(guardOn.guard);
assert(JSON.stringify(gv) === JSON.stringify({ enabled: true, rooms: [openRoom.key], secs: 45, count: 7 }), 'guard view');
const gNone = cfg.presentGuard(null);
assert(JSON.stringify(gNone) === JSON.stringify({ enabled: false, rooms: [], secs: 30, count: 5 }), 'missing guard view uses defaults');
assert(cfg.presentGuard({ kickOn: 'yes', kickSecs: 1000, kickCount: 1 }).enabled === false
  && cfg.presentGuard({ kickSecs: 1000, kickCount: 1 }).secs === 300
  && cfg.presentGuard({ kickSecs: 1000, kickCount: 1 }).count === 3, 'guard view clamps stored numbers');
assert(cfg.presentGuard(prev.guard).enabled === true && cfg.presentGuard(prev.guard).rooms[0] === 'keep', 'app-written guard is shown as-is');

const noImg = cfg.applySettings(prev, {
  macro: { enabled: true, message: '글만', baseMin: 1, randomMin: 0, rooms: [normal.key], roomCooldownMin: {} },
}, merged, 0);
assert(noImg.macro.images.length === 0, 'no image means no image');

const trig = cfg.applySettings(prev, {
  triggers: [{ name: '가격', pattern: '가격', mode: 'contains', reply: '안내', enabled: true, cooldown_sec: 60, rooms: [] }],
}, merged, 0);
assert(trig.triggers.length === 1, 'trigger kept');
assert(trig.triggers[0].rooms.indexOf(dm.key) < 0, 'trigger does not cover hidden dm');
assert(trig.triggers[0].rooms.indexOf(shown.open[0].key) >= 0, 'trigger covers open rooms');
assert(trig.triggers[0].rooms.indexOf(normal.key) < 0, 'trigger does not cover normal rooms');

// 키 로그인·키 모양 device_id 단언(featuresFor·panel-ids·POST /panel/api/login·ownsDevice(s.key …))은
// 회원 세션으로 바뀌어 지웠다(docs/ACCOUNTS_V1.md 9.5). 같은 성격의 검사는 lib/room-config-check.js·lib/panel-inbox-check.js 가 맡는다.

const panelJs = fs.readFileSync(path.join(__dirname, '..', 'public', 'panel.js'), 'utf8');
assert(panelJs.indexOf('연결이 잠깐 끊겼습니다. 카카오톡 확인을 계속 기다립니다.') >= 0, 'dropped confirm keeps waiting');
assert(panelJs.indexOf('Load failed') < 0, 'raw fetch error is not shown');
assert(panelJs.indexOf('대화방 목록을 가져오지 못했습니다. 잠시 뒤 다시 눌러 주세요.') >= 0, 'room reload failure stays in Korean');

const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'panel.html'), 'utf8');
const panelCss = fs.readFileSync(path.join(__dirname, '..', 'public', 'panel.css'), 'utf8');
const siteCss = fs.readFileSync(path.join(__dirname, '..', 'public', 'style.css'), 'utf8');
const both = html + '\n' + panelJs;

// 방·기능 (유지 + 이름 변경)
assert(html.indexOf('오픈채팅방') >= 0, 'open room group');
assert(html.indexOf('일반 채팅방') < 0, 'normal room group is not offered');
assert(html.indexOf('rooms-normal') < 0 && html.indexOf('visit-normal') < 0, 'normal room lists are gone');
assert(html.indexOf('오픈프로필로 온') < 0, 'open profile dm category is not shown');
assert(html.indexOf('id="visit-on"') >= 0 && html.indexOf('입장·퇴장 기록') >= 0, 'join/leave log switch');
assert(html.indexOf('id="cover-on"') >= 0 && html.indexOf('금지어 검열') >= 0, 'banned-word cover switch');
assert(html.indexOf('id="profile-on"') >= 0 && html.indexOf('프로필 기록') >= 0 && html.indexOf('프로필 변경 감지') >= 0, 'profile log switch');
assert(html.indexOf('id="guard-on"') >= 0 && html.indexOf('올킥 감지') >= 0, 'mass-kick guard switch');
assert(html.indexOf('id="reply-on"') >= 0 && html.indexOf('갠톡 응답') >= 0 && html.indexOf('저격 규칙') >= 0, 'existing features stay separated');
assert(html.indexOf('들낙 방지') < 0 && html.indexOf('욕설 가리기') < 0 && html.indexOf('경쟁사 저격') < 0, 'v4 feature names are gone');
assert(html.indexOf('발송이 잠시 멈출 수 있습니다') >= 0, 'uptime limit is stated');
assert(html.indexOf('무료 사용 한도') < 0 && html.indexOf('인스턴스') < 0 && html.indexOf('프로세스') < 0, 'server note has no internal terms');
assert(html.indexOf('이용 기간은 입금 확인 시점부터 시작됩니다') >= 0, 'login screen states when the period starts');
assert(html.indexOf('한 아이디로 기기 <span data-limit="sessions">3</span>대까지 동시에 로그인할 수 있습니다') >= 0, 'login screen states the device limit (filled from /api/site limits)');

// 사이드바 + 해시 라우트 (docs/UI_V5.md 4.1·4.3)
assert(html.indexOf('id="nav"') >= 0 && html.indexOf('id="tabs"') < 0, 'sidebar nav replaces the tab bar');
assert(html.indexOf('class="jumps"') < 0, 'no anchor jump list');
['overview', 'inbox', 'accounts', 'account-add', 'macro', 'visit', 'profile', 'guard', 'cover', 'reply', 'snipe'].forEach(function (r) {
  assert(html.indexOf('data-route="' + r + '"') >= 0, r + ' has a page');
});
['overview', 'inbox', 'accounts', 'macro', 'visit', 'profile', 'guard', 'cover', 'reply', 'snipe'].forEach(function (r) {
  assert(html.indexOf('href="#' + r + '" data-r="' + r + '"') >= 0, r + ' is in the sidebar');
});
['macro', 'visit', 'profile', 'guard', 'cover', 'autoreply', 'triggers'].forEach(function (k) {
  assert(html.indexOf('data-fs="' + k + '"') >= 0, k + ' shows on/off in the sidebar');
  assert(html.indexOf('data-sum="' + k + '"') >= 0, k + ' shows its current value on the overview');
});
['macro-form', 'visit-form', 'profile-form', 'guard-form', 'cover-form', 'reply-form', 'snipe-form'].forEach(function (f) {
  assert(html.indexOf('<form id="' + f + '"') >= 0, f + ' exists');
});

// 주요 알림·셸·등록 마크업
['id="inbox"', 'id="kkt"', 'id="rail"', 'id="rail-all"', 'id="rail-accounts"', 'id="chat-rooms"', 'id="chat-search"',
 'id="chat-unread"', 'id="chat-unread-n"', 'id="chat-notice"', 'id="chat-error"', 'id="chat-title"', 'id="chat-reload"',
 'id="chat-back"', 'id="chat-peer"', 'id="chat-head-sub"', 'id="thread-state"', 'id="thread-settings"', 'id="chat-log"',
 'id="chat-live"', 'id="chat-newpill"', 'id="chat-form"', 'id="chat-text"', 'id="chat-send"', 'id="chat-count"',
 'id="chat-note"', 'data-view="list"',
 'id="acctBtn"', 'id="acctMenu"', 'id="openPal"', 'id="palWrap"', 'id="palIn"', 'id="palList"', 'id="view"', 'id="crPage"',
 'id="runstate"', 'id="save"', 'id="saveBtn"', 'id="saveRevert"', 'id="leaveStay"', 'id="leaveDrop"', 'id="leaveSave"', 'id="toasts"',
 'id="account-list"', 'id="add-form"', 'id="email"', 'id="password"', 'id="add-error"', 'id="add-steps"', 'id="passcode"',
 'id="code-title"', 'id="code"', 'id="code-left"', 'id="code-wait"', 'id="code-error"', 'id="code-ring"', 'id="force"', 'id="cancel-code"',
 'id="rooms-open"', 'id="visit-open"', 'id="profile-open"', 'id="guard-open"', 'id="cover-open"', 'id="reload-rooms"',
 'id="triggers"', 'id="add-trigger"',
 '/panel.css?v=15', '/panel.js?v=19'].forEach(function (s) {
  assert(html.indexOf(s) >= 0, 'v5 console markup: ' + s);
});
['id="settings"', 'id="settings-acct"', 'id="rail-add"', 'id="rail-settings"', 'data-mode=', 'class="pagehead"', 'data-band="chat"', 'id="detail"'].forEach(function (s) {
  assert(html.indexOf(s) < 0, 'v4 markup removed: ' + s);
});

// 문구 (V4 유지 + 변경)
assert(both.indexOf('대화를 고르세요') < 0, 'polite-imperative placeholder is gone');
assert(panelJs.indexOf('먼저 인사를 보내 보세요') < 0 && panelJs.indexOf('불러오는 중…') < 0, 'friendly thread copy is gone');
// 화면 꾸밈에는 이모지를 쓰지 않는다. 방 안내 미리보기(.bub.notice)는 봇이 방에 보내는 글 그대로라 뺀다.
const bothUi = both.replace(/<div class="bub notice fold">[\s\S]*?<\/details><\/div>/g, '').replace(/<div class="bub notice">[^<]*<\/div>/g, '')
assert(!/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(bothUi), 'no emoji decoration');
assert(panelJs.indexOf('/panel/api/inbox') >= 0, 'client polls the unified inbox');
assert(panelJs.indexOf('/panel/api/chats?') < 0, 'per-account chat list is no longer polled');
assert(panelJs.indexOf('device_id: chat.deviceId') >= 0, 'reply is sent from the conversation owner account');
assert(panelJs.indexOf('계정 화면에서 다시 등록해 주세요.') >= 0 && both.indexOf('설정 › 계정') < 0, 'needs_register points to the account page');
assert(both.indexOf('선택한 대화 없음') >= 0 && both.indexOf('계정으로 답장') >= 0, 'thread header copy');
assert(panelJs.indexOf('발송 프로세스') < 0 && panelJs.indexOf('발송 작업') < 0 && panelJs.indexOf('발송 서버가 멈춰 있습니다') >= 0,
  'sender-down copy says 발송 서버 (not 발송 프로세스 / 발송 작업)');

// V5 새 단언
assert(panelJs.indexOf('/panel/api/logs?device_id=') >= 0, 'logs are read per account');
assert(/guard:\s*\{/.test(panelJs) && /secs:/.test(panelJs) && /count:/.test(panelJs), 'guard settings are saved');
assert(/words:/.test(panelJs) && /links:/.test(panelJs), 'cover words and link switch are saved');
assert(!/(^|[^\w.$])(alert|confirm|prompt)\(/m.test(panelJs) && panelJs.indexOf('window.confirm') < 0, 'no native dialogs');
assert(both.indexOf('등록을 해제합니다.') >= 0, 'unlink asks inline');
assert(html.indexOf('fonts.googleapis.com/css2?family=Geist') >= 0, 'console loads Geist');
assert(html.indexOf('<meta name="theme-color" content="#09090b">') >= 0, 'dark theme color');
function rootBlock(css) { var i = css.indexOf(':root {'); return i < 0 ? '' : css.slice(i, css.indexOf('}', i) + 1); }
assert(rootBlock(panelCss).indexOf('--bg: #09090b;') >= 0 && rootBlock(panelCss) === rootBlock(siteCss),
  'style.css and panel.css share one :root token block');
function declColors(css) {
  var out = [];
  css.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\{([^{}]*)\}/g, function (m, decls) {
    if (/^\s*color-scheme: dark;/.test(decls)) return m;
    // docs/BRAND.md: 로고 바탕(#111111)은 로고 그림의 일부라 테마 토큰이 아니다. .brand-mark 의 logo.svg 짝만 허용한다.
    decls = decls.replace(/#111(?=\s+url\(\/logo\.svg\))/g, '');
    var hit = decls.match(/#[0-9a-fA-F]{3,8}(?![\w-])|rgba?\(|hsla?\(/g);
    if (hit) out = out.concat(hit);
    return m;
  });
  return out;
}
assert(declColors(panelCss).length === 0, 'panel.css colors come from tokens: ' + declColors(panelCss).join(' '));
assert(declColors(siteCss).length === 0, 'style.css colors come from tokens: ' + declColors(siteCss).join(' '));
assert(!/--acc-[0-7]/.test(panelCss), 'per-account colors are gone');

// inbox 화면의 보이는 이름은 '받은 갠톡'(문장 점검 48). '받은함'·'주요 알림'은 팔레트 검색어로만 남는다.
assert(/data-r="inbox">[\s\S]{0,160}?받은 갠톡<span class="r">/.test(html), 'sidebar names the inbox page 받은 갠톡');
assert(html.indexOf('받은함') < 0 && html.indexOf('주요 알림') < 0 && html.indexOf('전체 대화') < 0, 'panel.html shows one inbox name');
assert(/inbox:\s*\{\s*t:\s*'받은 갠톡'/.test(panelJs), 'route title (breadcrumb) is 받은 갠톡');
assert(/t:\s*'받은 갠톡',\s*kw:\s*'받은함 주요 알림/.test(panelJs) && panelJs.split('받은함').length === 2 && (panelJs.match(/'[^'\n]*주요 알림[^'\n]*'/g) || []).length === 1,
  'palette keeps 받은함·주요 알림 only as search keywords');

// ── ACCOUNTS V1 (docs/ACCOUNTS_V1.md 6.9·7.4·9.5) ─────────────────────────
// 회원 로그인 카드
['id="login-id"', 'id="login-pw"', 'id="login-error"', 'id="loginBtn"', 'id="loginGoogle"', 'id="login-keynote"'].forEach(function (s) {
  assert(html.indexOf(s) >= 0, 'member login card: ' + s);
});
assert(html.indexOf('id="key"') < 0 && html.indexOf('placeholder="KAKA-') < 0, 'license-key login field is gone');
assert(html.indexOf('/signup?next=%2Faccount%23claim') >= 0, 'old key users are pointed to signup + claim');
assert(panelJs.indexOf('/api/auth/login') >= 0 && panelJs.indexOf('/panel/api/login') < 0, 'console logs in through /api/auth/login');
assert(panelJs.indexOf('/api/auth/logout') >= 0, 'console logs out through /api/auth/logout');
assert(/\^KAKA-\/i/.test(panelJs) && panelJs.indexOf('라이선스 키는 로그인에 쓰지 않습니다.') >= 0, 'KAKA- in the id field is not sent');
// 실시간 상담: 콘솔은 링크 방식(SDK 없음, D25)
assert(html.indexOf('data-support-mode="link"') >= 0, 'console uses the link support mode');
assert(html.indexOf('/support.js?v=1') >= 0 && html.indexOf('/support.js?v=1') < html.indexOf('/panel.js?v=19'), 'support.js loads before panel.js');
assert(html.indexOf('data-support') >= 0 && html.indexOf('channel.io') < 0 && panelJs.indexOf('channel.io') < 0, 'support buttons, no channel SDK in the console');
assert(panelCss.indexOf('html:not([data-support="chat"]):not([data-support="contact"]) [data-support] { display: none !important; }') >= 0, 'support buttons follow <html data-support>');
assert(panelJs.indexOf('kbSite') >= 0, 'console boot reuses window.kbSite');
// 사이드바: 카카오 계정 · 내 방 · 매크로 설정 · 방 설정
assert(html.indexOf('href="#rooms" data-r="rooms"') >= 0 && html.indexOf('id="navRoomN"') >= 0, 'rooms in the sidebar');
assert(/data-r="accounts">[\s\S]{0,160}?카카오 계정<span class="r">/.test(html), 'accounts page is named 카카오 계정');
assert(html.indexOf('id="navCapRoom"') >= 0 && html.indexOf('매크로 설정') >= 0, 'sidebar groups');
['visit', 'profile', 'guard', 'cover'].forEach(function (r) {
  assert(new RegExp('href="#' + r + '" data-r="' + r + '" data-legacy hidden').test(html), r + ' is a legacy-only sidebar item');
  assert(new RegExp('data-legacy hidden data-feat="' + r + '"').test(html), r + ' overview row is legacy-only');
});
assert(/LEGACY_ROUTES\[GKEYS\[key\]\] && !legacyOn\(\)/.test(panelJs), 'G V/P/K/C are blocked without legacy');
assert(panelJs.indexOf("'방 관리 기능은 내 방에서 방마다 설정합니다.'") >= 0, 'legacy hash is redirected with a notice');
// 라우트 8개 + 7.4 의 칸 id
['rooms', 'room', 'r-visit', 'r-profile', 'r-promo', 'r-cover', 'r-guard', 'r-games'].forEach(function (r) {
  assert(html.indexOf('data-route="' + r + '"') >= 0, r + ' has a page');
});
['room-form', 'r-visit-form', 'r-profile-form', 'r-promo-form', 'r-cover-form', 'r-guard-form', 'r-games-form'].forEach(function (f) {
  assert(html.indexOf('<form id="' + f + '"') >= 0, f + ' exists');
});
['r-visit-on', 'r-churn-on', 'r-churn-joins', 'r-churn-min', 'r-churn-action', 'r-churn-notice', 'r-churn-sent', 'r-leave-on', 'r-leave-notice',
 'r-exempt', 'r-exempt-pick', 'r-visit-tbl', 'r-kick-tbl',
 'r-profile-on', 'r-profile-name', 'r-profile-photo', 'r-profile-status', 'r-profile-lookup', 'r-profile-tbl',
 'r-promo-on', 'r-promo-links', 'r-promo-cards', 'r-promo-media', 'r-promo-hide', 'r-promo-kick', 'r-promo-reset', 'r-promo-notice', 'r-promo-preview',
 'r-cover-on', 'r-cover-links', 'r-cover-words', 'r-cover-word-in', 'r-cover-word-n', 'r-cover-word-err',
 'r-hide-cmd', 'r-hide-last', 'r-hide-last-btn', 'r-hide-who', 'r-hide-who-btn', 'r-hide-status',
 'r-guard-on', 'r-guard-secs', 'r-guard-count', 'r-guard-sent', 'r-guard-tbl',
 'r-games-on', 'r-games-word', 'r-games-baseball', 'r-games-dice', 'r-games-rps', 'r-games-quiz', 'r-games-cool', 'r-games-limit',
 'r-rank-tbl', 'r-rank-reset', 'r-games-preview',
 'r-prefix', 'r-passcode', 'room-retry', 'room-state', 'room-steps', 'room-wait', 'room-err', 'r-log-tbl',
 'rooms-tbl', 'rooms-list', 'rooms-attn', 'rooms-attn-grp', 'rooms-empty', 'rooms-add'].forEach(function (id) {
  assert(html.indexOf('id="' + id + '"') >= 0, '7.4 field id: ' + id);
});
assert(html.indexOf('<th>대화방</th><th>봇</th><th>상태</th><th>K bot</th>') >= 0, '#rooms table columns');
assert(panelJs.indexOf('<td data-l="봇">') >= 0 && panelJs.indexOf('<td data-l="K bot">') >= 0
  && panelCss.indexOf('#rooms-tbl td[data-l="봇"]') >= 0 && panelCss.indexOf('#rooms-tbl td[data-l="K bot"]') >= 0, '#rooms phone labels match the columns');
assert(html.indexOf('방장이 K bot을 부방장으로 지정하면 1~2분 안에 자동으로 확인됩니다.') >= 0, 'rooms page says 1~2분');
assert(html.indexOf('들낙 감지') >= 0 && html.indexOf('들낙 방지') < 0 && panelJs.indexOf('들낙 방지') < 0, '들낙 감지, never 들낙 방지');
assert(html.indexOf('쿨다운') < 0 && html.indexOf('접두사') < 0, 'room screens use 쿨타임 / 앞글자');
assert(html.indexOf('내보내기는 K bot이 부방장일 때만 동작합니다. 방장·부방장·제외 대상은 내보내지 않습니다.') >= 0, 'kick limit note');
assert(panelCss.indexOf('.stepper.s4 { grid-template-columns: repeat(4, minmax(0, 1fr)); }') >= 0, '.stepper.s4 is four columns');
assert(/@media \(max-width: 760px\) \{\s*\/\*[^*]*\*\/\s*\.stepper\.s4 \{ grid-template-columns: repeat\(2, minmax\(0, 1fr\)\); row-gap: 14px; \}/.test(panelCss), '.stepper.s4 is 2×2 on phones');
assert(/\.state\[data-state="pending"\], \.state\[data-state="joining"\], \.state\[data-state="waiting"\]/.test(panelCss) && /\.state\[data-state="active"\]/.test(panelCss), 'room state colors');
// 카카오 계정 상한은 /panel/api/me.max_accounts 에서 읽는다
assert(html.indexOf('8개') < 0 && html.indexOf('/ 8') < 0, 'panel.html does not hard-code 8 accounts');
assert(!/[^\w.](8개|\/8')/.test(panelJs) && panelJs.indexOf('max_accounts') >= 0, 'panel.js reads max_accounts');
assert(html.indexOf('id="add-nomacro"') >= 0 && html.indexOf('카카오 계정은 카카오톡 매크로 이용 기간에만 등록할 수 있습니다.') >= 0, 'account add asks for macro first');
// 콘솔 API
['/panel/api/bot-rooms', '/panel/api/bot-room?id=', '/panel/api/bot-room/settings', '/panel/api/bot-room/retry', '/panel/api/bot-room/logs?id=',
 '/panel/api/bot-room/people?id=', '/panel/api/bot-room/hide', '/panel/api/bot-room/unkick', '/panel/api/bot-room/games-reset'].forEach(function (u) {
  assert(panelJs.indexOf(u) >= 0, 'panel.js calls ' + u);
});
assert(panelJs.indexOf("notify('부방장 지정을 확인했습니다.'") >= 0 && panelJs.indexOf("notify('부방장 권한이 해제되었습니다.'") >= 0, 'promotion and demotion notices');
assert(/rev:\s*roomSt\.formRev/.test(panelJs), 'room settings send rev');
assert(html.indexOf('<link rel="icon" href="/favicon.svg" type="image/svg+xml">') >= 0 && html.indexOf('<link rel="apple-touch-icon" href="/apple-touch-icon.png">') >= 0, 'brand icons');
assert((html.match(/<span class="brand-mark" aria-hidden="true"><\/span>/g) || []).length === (html.match(/brand-mark/g) || []).length, 'brand mark markup is the empty span');

// ── 문장 점검(공통 용어·말투) ─────────────────────────────────────────────
// 화면에 보이는 글만 본다: html 은 주석을 빼고, panel.js 는 따옴표 문자열만.
const htmlText = html.replace(/<!--[\s\S]*?-->/g, '');
const jsText = (panelJs.match(/'(?:[^'\\\n]|\\.)*'/g) || []).join('\n');
const onScreen = htmlText + '\n' + jsText;
['콘솔', '십시오', '강퇴', '강제퇴장', '올킥 방지', '나갔을 때 내보내기', '퇴장 후 내보냄', '제외할 사람', '입장·퇴장 로그', '프로필 로그',
 '주요 알림<', 'K bot 계정이', 'K bot 계정을', '관리 · K bot', '이동 및 검색', '배정 전', '카카오계정', '방 상품'].forEach(function (w) {
  assert(onScreen.indexOf(w) < 0, 'copy rule: no "' + w + '" on screen');
});
assert(html.indexOf('<title>K bot 패널</title>') >= 0 && panelJs.indexOf("'K bot 패널'") >= 0, 'tab title is K bot 패널');
assert(html.indexOf('[재입장 차단]') >= 0 && html.indexOf('나간 사람 재입장 차단') >= 0, 'leave-kick is named 나간 사람 재입장 차단');
assert(html.indexOf('갠톡(1:1 대화)') >= 0, '갠톡 is introduced once as 갠톡(1:1 대화)');
assert(!/」(?:을|를) 눌러|「[^」]*추가」에서/.test(onScreen) && onScreen.indexOf('[대화방 불러오기]를 눌러 주세요') >= 0,
  'buttons are named in [] (「」 is for room commands and option values)');
assert(html.indexOf('</svg>로그아웃</button>') >= 0, 'sidebar logout button says 로그아웃');
assert(/res\.unnamed > 0/.test(panelJs) && onScreen.indexOf('이름을 아직 읽지 못해 목록에 없습니다. 잠시 뒤 [대화방 불러오기]를 다시 눌러 주세요.') >= 0,
  'room reload says how many open rooms have no name yet, instead of "목록이 최신입니다"');
assert(/function short\(email\)[^\n]*s\.slice\(0, i\)/.test(panelJs), 'short ids drop the trailing @');

process.stdout.write('panel check ok\n');
