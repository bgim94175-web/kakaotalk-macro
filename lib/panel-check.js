'use strict';

const fs = require('fs');
const path = require('path');

process.env.CONFIG_SECRET = process.env.CONFIG_SECRET || 'panel-check-secret-value';

const auth = require('./panel-auth');
const text = require('./auth-text');
const cfg = require('./panel-config');
const ids = require('./panel-ids');

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
assert(t111.indexOf('카카오 상태 -111') >= 0, '-111 code');
assert(t111.indexOf('다른 기기에서 로그인할 수 없습니다.') >= 0, '-111 message');
assert(t111.indexOf('이용자 보호조치') < 0, '-111 is not rewritten as a protection block');

const t111b = text.customerText({ message: '이용자 보호조치로 막혔습니다.', status: -111 });
assert(t111b.indexOf('이용자 보호조치') < 0, '-111 drops the protection sentence');
assert(t111b.indexOf('카카오 상태 -111') >= 0, '-111 still shows the code');

const t328 = text.customerText({ message: 'Login failed with status -328', status: -328 });
assert(t328.indexOf('이용자 보호조치로 인해 서브디바이스 로그인이 제한되었습니다.') >= 0, '-328 sentence');
assert(t328.indexOf('카카오 상태 -328') >= 0, '-328 code');

const t997 = text.customerText({ message: 'Login failed with status -997' });
assert(t997.indexOf('이용이 제한된 계정입니다.') >= 0, '-997 sentence');
assert(t997.indexOf('카카오 상태 -997') >= 0, '-997 code');

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

const feat = cfg.featuresFor({ macro: { on: true }, roombot: { on: true } }, { features: { macro: true, roombot: false } });
assert(feat.macro === true && feat.roombot === false && feat.minigame === false, 'site does not turn the room bot on');

const id = ids.newDeviceId('KAKA-TEST-TEST-TEST');
assert(ids.ownsDeviceId('KAKA-TEST-TEST-TEST', id), 'owner');
assert(!ids.ownsDeviceId('KAKA-OTHER-OTHER-OTHR', id), 'other key');
assert(!ids.ownsDeviceId('KAKA-TEST-TEST-TEST', 'phone-device-id'), 'apk device id is not a panel account');

const src = fs.readFileSync(path.join(__dirname, '..', 'routes', 'panel.js'), 'utf8');
const start = src.indexOf("router.post('/panel/api/login'");
const end = src.indexOf("router.post('/panel/api/logout'");
const login = src.slice(start, end);
assert(login.indexOf('device_id') < 0, 'login must not touch device_id');
assert(!/UPDATE\s+licenses/i.test(login), 'login must not rewrite the license');

const loginSrc = src.slice(start, end);
assert(/not_started/.test(loginSrc) && /startPeriod\(/.test(loginSrc),
  'first panel login starts an unused key period');
assert(!/device_id/.test(loginSrc), 'starting the period must not bind a device');

// 기록 화면 라우트: 채팅 라우트 뒤, 로그인 구간 밖, 기기 소유 확인 후 sender 를 부른다
const logsAt = src.indexOf("router.get('/panel/api/logs'");
assert(logsAt > src.indexOf("router.post('/panel/api/chat/send'"), 'logs route sits after the chat routes');
assert(logsAt > end, 'logs route is outside the login..logout slice');
const logsSrc = src.slice(logsAt, src.indexOf('}));', logsAt));
assert(/ownsDevice\(s\.key, deviceId\)/.test(logsSrc) && logsSrc.indexOf('없는 계정입니다.') >= 0, 'logs checks the device owner');
assert(/senderDown\(res\)/.test(logsSrc) && /\/v1\/logs\?device_id=/.test(logsSrc) && /20000/.test(logsSrc), 'logs calls the sender with 20s timeout');
assert(/guard: cfg\.presentGuard\(config\.guard\)/.test(src), 'account view carries guard');

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
assert(html.indexOf('id="visit-on"') >= 0 && html.indexOf('입장·퇴장 로그') >= 0, 'join/leave log switch');
assert(html.indexOf('id="cover-on"') >= 0 && html.indexOf('금지어 검열') >= 0, 'banned-word cover switch');
assert(html.indexOf('id="profile-on"') >= 0 && html.indexOf('프로필 로그') >= 0 && html.indexOf('프로필 변경 감지') >= 0, 'profile log switch');
assert(html.indexOf('id="guard-on"') >= 0 && html.indexOf('올킥 방지') >= 0, 'mass-kick guard switch');
assert(html.indexOf('id="reply-on"') >= 0 && html.indexOf('갠톡 응답') >= 0 && html.indexOf('저격 규칙') >= 0, 'existing features stay separated');
assert(html.indexOf('들낙 방지') < 0 && html.indexOf('욕설 가리기') < 0 && html.indexOf('경쟁사 저격') < 0, 'v4 feature names are gone');
assert(html.indexOf('항상 켜져 있다고 보장하지 않습니다') >= 0, 'uptime limit is stated');
assert(html.indexOf('사용 기간이 시작됩니다') >= 0, 'login screen states when the period starts');
assert(html.indexOf('기기에 묶지 않') >= 0, 'login screen says the console does not bind a device');

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

// 받은함·셸·등록 마크업
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
 '/panel.css?v=13', '/panel.js?v=16'].forEach(function (s) {
  assert(html.indexOf(s) >= 0, 'v5 console markup: ' + s);
});
['id="settings"', 'id="settings-acct"', 'id="rail-add"', 'id="rail-settings"', 'data-mode=', 'class="pagehead"', 'data-band="chat"', 'id="detail"'].forEach(function (s) {
  assert(html.indexOf(s) < 0, 'v4 markup removed: ' + s);
});

// 문구 (V4 유지 + 변경)
assert(both.indexOf('대화를 고르세요') < 0, 'polite-imperative placeholder is gone');
assert(panelJs.indexOf('먼저 인사를 보내 보세요') < 0 && panelJs.indexOf('불러오는 중…') < 0, 'friendly thread copy is gone');
assert(!/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(both), 'no emoji decoration');
assert(panelJs.indexOf('/panel/api/inbox') >= 0, 'client polls the unified inbox');
assert(panelJs.indexOf('/panel/api/chats?') < 0, 'per-account chat list is no longer polled');
assert(panelJs.indexOf('device_id: chat.deviceId') >= 0, 'reply is sent from the conversation owner account');
assert(panelJs.indexOf('계정 화면에서 다시 등록해 주세요.') >= 0 && both.indexOf('설정 › 계정') < 0, 'needs_register points to the account page');
assert(both.indexOf('선택한 대화 없음') >= 0 && both.indexOf('계정으로 답장') >= 0, 'thread header copy');
assert(panelJs.indexOf('발송 프로세스') < 0 || panelJs.indexOf('발송 프로세스') === panelJs.lastIndexOf('발송 프로세스'),
  'new copy says 발송 작업; only the kept reasonText() may still say 발송 프로세스');

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
    var hit = decls.match(/#[0-9a-fA-F]{3,8}(?![\w-])|rgba?\(|hsla?\(/g);
    if (hit) out = out.concat(hit);
    return m;
  });
  return out;
}
assert(declColors(panelCss).length === 0, 'panel.css colors come from tokens: ' + declColors(panelCss).join(' '));
assert(declColors(siteCss).length === 0, 'style.css colors come from tokens: ' + declColors(siteCss).join(' '));
assert(!/--acc-[0-7]/.test(panelCss), 'per-account colors are gone');

process.stdout.write('panel check ok\n');
