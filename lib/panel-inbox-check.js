'use strict';

// 통합 받은함 서버 단언 (docs/UI_V4.md 6.1 · 11.1-A). lib/panel-check.js 와 같은 방식으로
// 실패하면 throw 로 종료 코드가 0 이 아니게 된다.
const fs = require('fs');
const path = require('path');

const inboxLib = require('./panel-inbox');

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

// ── 통합 받은함 서버 (docs/UI_V4.md 6.1 · 11.1-A)
const inboxRows = [
  { device_id: 'd1', email: 'a@x' }, { device_id: 'd2', email: 'b@x' },
  { device_id: 'd3', email: 'c@x' }, { device_id: 'd4', email: 'd@x' },
];
const inboxSettled = [
  { status: 'fulfilled', value: { status: 200, json: { ok: true, chats: [
    { chat_id: '5', list_kind: 'open_dm', name: '김', preview: 'p', unread: 2, last_at: 100 },
    { chat_id: '6', list_kind: 'open_room', name: '방', preview: '', unread: 9, last_at: 999 },
  ] } } },
  { status: 'fulfilled', value: { status: 409, json: { ok: false, error: 'kicked', needs_register: true } } },
  { status: 'rejected', reason: new Error('timeout') },
  { status: 'fulfilled', value: { status: 200, json: { ok: true, connected: false, chats: [
    { chat_id: 7, list_kind: 'open_dm', name: '이', preview: 'q', unread: '0', last_at: 200 },
  ] } } },
];
const mergedInbox = inboxLib.mergeInbox(inboxRows, inboxSettled, true);
assert(mergedInbox.accounts.length === 4, 'every account is reported');
assert(mergedInbox.accounts[0].status === 'live' && mergedInbox.accounts[0].unread === 2 && mergedInbox.accounts[0].chats === 1,
  'open_room rows are dropped from the unified inbox');
assert(mergedInbox.accounts[0].connected === null, 'connected is null unless the sender says');
assert(mergedInbox.accounts[1].status === 'needs_register' && mergedInbox.accounts[1].reason === 'kicked'
  && mergedInbox.accounts[1].error === '카카오 로그인이 끊겼습니다. 계정을 다시 등록해 주세요.', 'needs_register account');
assert(mergedInbox.accounts[2].status === 'error' && mergedInbox.accounts[2].reason === 'timeout'
  && mergedInbox.accounts[2].error === '대화 목록을 가져오지 못했습니다.', 'timed out account is an error, not a failure');
assert(mergedInbox.accounts[3].status === 'live' && mergedInbox.accounts[3].connected === false, 'sender connected flag is passed through');
assert(mergedInbox.chats.length === 2 && mergedInbox.chats[0].chat_id === '7' && mergedInbox.chats[0].device_id === 'd4'
  && mergedInbox.chats[0].unread === 0 && mergedInbox.chats[1].device_id === 'd1', 'chats merged across accounts, newest first, normalized');
assert(mergedInbox.chats.every(function (c) { return c.list_kind === 'open_dm' && typeof c.chat_id === 'string'; }),
  'merged chats are open_dm with string chat_id');
const inboxDown = inboxLib.mergeInbox(inboxRows, [], false);
assert(inboxDown.accounts.every(function (a) { return a.status === 'sender_down'; }) && inboxDown.chats.length === 0, 'sender down marks every account');
const senderDownErr = new Error('sender_down'); senderDownErr.code = 'sender_down';
assert(inboxLib.mergeInbox([inboxRows[0]], [{ status: 'rejected', reason: senderDownErr }], true).accounts[0].status === 'sender_down',
  'a sender_down rejection is not shown as a list failure');
const badResp = new Error('bad_response'); badResp.code = 'bad_response';
assert(inboxLib.mergeInbox([inboxRows[0]], [{ status: 'rejected', reason: badResp }], true).accounts[0].reason === 'bad_response',
  'a thrown code is kept as the reason');
assert(inboxLib.mergeInbox([inboxRows[0]], [{ status: 'fulfilled', value: { status: 502, json: { ok: false } } }], true).accounts[0].reason === 'bad_status',
  'a non-ok sender body without needs_register is bad_status');
assert(inboxLib.mergeInbox([inboxRows[0]], [undefined], true).accounts[0].reason === 'failed',
  'a missing settled entry is failed');
assert(inboxLib.NEEDS_REGISTER_TEXT === '카카오 로그인이 끊겼습니다. 계정을 다시 등록해 주세요.'
  && inboxLib.FETCH_FAIL_TEXT === '대화 목록을 가져오지 못했습니다.', 'copy constants are exported');

// ── routes/panel.js 배치 규칙 (6.1 삽입 위치 · 10장 41 → docs/ACCOUNTS_V1.md 3.4 회원 세션 기준)
const src = fs.readFileSync(path.join(__dirname, '..', 'routes', 'panel.js'), 'utf8');
assert(src.indexOf("router.post('/panel/api/login'") < 0, 'key login route is gone (3.4.1)');
assert(src.indexOf('panel-auth') < 0 && src.indexOf('startPeriod(') < 0, 'console no longer reads license-key cookies');
assert(src.indexOf("router.post('/panel/api/logout'") > 0 && /endSession\(req, res\)/.test(src), 'logout ends the member session');

// 모든 콘솔 경로는 회원 세션을 먼저 확인한다(로그아웃만 예외)
const routeRe = /router\.(get|post)\('(\/panel\/api\/[^']+)'/g;
let m;
let routes = 0;
while ((m = routeRe.exec(src))) {
  routes++;
  const at = m.index;
  const next = src.indexOf('\nrouter.', at + 1);
  const block = src.slice(at, next < 0 ? src.length : next);
  if (m[2] === '/panel/api/logout') continue;
  assert(/await session\(req, res\)/.test(block) && /if \(!s\) return;/.test(block), m[1] + ' ' + m[2] + ' checks the member session');
  assert(block.indexOf('license_key=$') < 0 && block.indexOf('s.key') < 0, m[2] + ' does not key on the license');
}
assert(routes >= 20, 'console routes found (' + routes + ')');
assert(/requireMember\(req, res\)/.test(src), 'session() uses memberAuth.requireMember');

// 소유 확인: DB(panel_accounts.member_id) 또는 60초 목록 임시 저장. bot. 은 고객 경로에서 404.
const ownsAt = src.indexOf('async function ownsMemberDevice(');
assert(ownsAt > 0, 'ownsMemberDevice() exists');
const ownsSrc = src.slice(ownsAt, src.indexOf('\n}\n', ownsAt));
assert(/isBotId\(/.test(ownsSrc) && /memberAccountRows\(/.test(ownsSrc), 'ownsMemberDevice rejects bot ids and reads the member list');
const rowAt = src.indexOf('async function accountRow(');
const rowSrc = src.slice(rowAt, src.indexOf('\n}\n', rowAt));
assert(/isBotId\(/.test(rowSrc) && /member_id=\$2/.test(rowSrc), 'accountRow rejects bot ids and checks member_id');
assert(src.indexOf('featuresFor(') < 0, 'console no longer pushes features to the sender (grants only)');

assert(/require\('\.\.\/lib\/panel-inbox'\)/.test(src), 'route requires lib/panel-inbox');
const inboxStart = src.indexOf("router.get('/panel/api/inbox'");
const inboxEnd = src.indexOf("router.get('/panel/api/chats'");
assert(inboxStart > 0 && inboxEnd > inboxStart, 'unified inbox route sits before the per-account chats route');
const inboxSrc = src.slice(inboxStart, inboxEnd);
assert(/allSettled/.test(inboxSrc) && /memberAccountRows\(/.test(inboxSrc) && !/snapshot\(/.test(inboxSrc),
  'inbox fans out once per account from the cached account rows');
assert(/mergeInbox\(/.test(inboxSrc) && /sender_reason/.test(inboxSrc), 'inbox route merges and reports the sender state');
assert(ownsAt < inboxStart, 'inbox route sits below ownsMemberDevice()');
['/panel/api/chats', '/panel/api/chat', '/panel/api/logs'].forEach(function (p) {
  const at = src.indexOf("router.get('" + p + "'");
  const block = src.slice(at, src.indexOf('}));', at));
  assert(at > 0 && /ownsMemberDevice\(s\.member\.id, deviceId\)/.test(block) && block.indexOf('없는 계정입니다.') < 0
    && /TEXT\.no_account/.test(block), p + ' checks the device owner');
});
assert((src.match(/forgetAccounts\(/g) || []).length >= 3, 'account cache is dropped on register and unlink');
const rememberStart = src.indexOf('async function rememberAccount(');
const rememberSrc = src.slice(rememberStart, src.indexOf('\n}\n', rememberStart));
assert(rememberStart > 0 && /forgetAccounts\(memberId\)/.test(rememberSrc) && /member_id/.test(rememberSrc)
  && /pushGrants\(memberId\)/.test(rememberSrc), 'rememberAccount stores member_id, drops the cache and pushes grants');
const unlinkStart = src.indexOf("router.post('/panel/api/unlink'");
const unlinkEnd = src.indexOf("router.post('/panel/api/rooms'");
assert(unlinkStart > 0 && unlinkEnd > unlinkStart, 'unlink and rooms routes exist in order');
const unlinkSrc = src.slice(unlinkStart, unlinkEnd);
assert(unlinkSrc.indexOf('DELETE FROM panel_accounts') >= 0
  && unlinkSrc.indexOf('forgetAccounts(s.member.id)') > unlinkSrc.indexOf('DELETE FROM panel_accounts'),
  'unlink drops the cache after the delete');
const beginAt = src.indexOf("router.post('/panel/api/register/begin'");
const beginSrc = src.slice(beginAt, src.indexOf("\nrouter.", beginAt + 1));
assert(/no_macro/.test(beginSrc) && /newMemberDeviceId\(memberId\)/.test(beginSrc) && /MAX_ACCOUNTS/.test(beginSrc),
  'new accounts need the macro and respect the member account cap');
const settingsAt = src.indexOf("router.post('/panel/api/settings'");
const settingsSrc = src.slice(settingsAt, src.indexOf("\nrouter.", settingsAt + 1));
assert(/legacyKeysIn\(body\)/.test(settingsSrc) && /legacy_only/.test(settingsSrc), 'account-level legacy features are gated');
['/panel/api/bot-rooms', '/panel/api/bot-room', '/panel/api/bot-room/settings', '/panel/api/bot-room/retry',
  '/panel/api/bot-room/logs', '/panel/api/bot-room/people', '/panel/api/bot-room/hide', '/panel/api/bot-room/unkick',
  '/panel/api/bot-room/games-reset'].forEach(function (p) {
  assert(src.indexOf("'" + p + "'") > 0, 'room route exists: ' + p);
});

process.stdout.write('inbox check ok\n');
