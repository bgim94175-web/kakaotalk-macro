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

// ── routes/panel.js 배치 규칙 (6.1 삽입 위치 · 10장 41)
const src = fs.readFileSync(path.join(__dirname, '..', 'routes', 'panel.js'), 'utf8');
const start = src.indexOf("router.post('/panel/api/login'");
const end = src.indexOf("router.post('/panel/api/logout'");
assert(start > 0 && end > start, 'login and logout routes exist in order');
const loginSrc = src.slice(start, end);
assert(!/device_id/.test(loginSrc) && !/inbox/.test(loginSrc), 'nothing was inserted into the login slice');

assert(/require\('\.\.\/lib\/panel-inbox'\)/.test(src), 'route requires lib/panel-inbox');
const inboxStart = src.indexOf("router.get('/panel/api/inbox'");
const inboxEnd = src.indexOf("router.get('/panel/api/chats'");
assert(inboxStart > 0 && inboxEnd > inboxStart, 'unified inbox route sits before the per-account chats route');
const inboxSrc = src.slice(inboxStart, inboxEnd);
assert(/allSettled/.test(inboxSrc) && /accountRows\(/.test(inboxSrc) && !/snapshot\(/.test(inboxSrc),
  'inbox fans out once per account from the cached account rows');
assert(/mergeInbox\(/.test(inboxSrc) && /sender_reason/.test(inboxSrc), 'inbox route merges and reports the sender state');
assert(inboxStart > end, 'inbox route is outside the login slice');
assert(src.indexOf('function ownsDevice(') > 0 && src.indexOf('function ownsDevice(') < inboxStart, 'inbox route sits below ownsDevice()');
assert((src.match(/forgetAccounts\(/g) || []).length >= 3, 'account cache is dropped on register and unlink');
const rememberStart = src.indexOf('async function rememberAccount(');
assert(rememberStart > 0 && /forgetAccounts\(/.test(src.slice(rememberStart, src.indexOf('\n}\n', rememberStart))),
  'rememberAccount drops the cache after the insert');
const unlinkStart = src.indexOf("router.post('/panel/api/unlink'");
const unlinkEnd = src.indexOf("router.post('/panel/api/rooms'");
assert(unlinkStart > 0 && unlinkEnd > unlinkStart, 'unlink and rooms routes exist in order');
const unlinkSrc = src.slice(unlinkStart, unlinkEnd);
assert(unlinkSrc.indexOf('DELETE FROM panel_accounts') >= 0
  && unlinkSrc.indexOf('forgetAccounts(s.key)') > unlinkSrc.indexOf('DELETE FROM panel_accounts'),
  'unlink drops the cache after the delete');

process.stdout.write('inbox check ok\n');
