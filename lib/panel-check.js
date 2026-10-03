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
assert(shown.normal.length === 1 && shown.normal[0].name === '단톡', 'normal room');
assert(JSON.stringify(shown).indexOf('갠톡') < 0, 'open profile dm is not in the picker');

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
assert(next.macro.rooms.length === 2, 'only the two visible rooms');
assert(next.macro.rooms.indexOf(dm.key) < 0, 'dm not selected');
assert(next.macro.roomCooldownMin[normal.key] === 5, 'per room cooldown');
assert(next.macro.roomCooldownMin[dm.key] == null, 'dm cooldown dropped');
assert(next.macro.baseMin === 1 && next.macro.randomMin === 3, 'base and random are separate');
assert(next.accounts.length === 0, 'web account is on');

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
assert(trig.triggers[0].rooms.indexOf(shown.normal[0].key) >= 0, 'trigger covers normal rooms');

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

const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'panel.html'), 'utf8');
assert(html.indexOf('오픈채팅방') >= 0 && html.indexOf('일반 채팅방') >= 0, 'two room groups');
assert(html.indexOf('오픈프로필') < 0, 'open profile dm category is not shown');
assert(html.indexOf('항상 켜져 있다고 보장하지 않습니다') >= 0, 'uptime limit is stated');
assert(html.indexOf('갠톡 자동응답') >= 0 && html.indexOf('경쟁사 저격') >= 0, 'existing features stay separated');

process.stdout.write('panel check ok\n');
