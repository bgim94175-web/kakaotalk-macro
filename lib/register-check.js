'use strict';
// 카카오 계정 등록(/panel/api/register/*)을 실제 routes/panel.js 로 돌려 본다. db·sender·회원 세션만 바꿔 끼운다.
// 지켜야 할 것: 휴대폰에서 번호를 넣기 전에는 첫 확인이 ok 가 되지 않는다(재등록 포함).

const Module = require('module');
const path = require('path');
const http = require('http');
const express = require('express');

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

const ROOT = path.join(__dirname, '..');
const tables = { panel_accounts: [], panel_pending: [] };
const member = { id: 7, macro_until: Date.now() + 864e5, legacy_room_until: 0 };

const db = {
  async one(sql, args) {
    if (/FROM panel_accounts WHERE device_id=\$1 AND member_id=\$2/.test(sql)) {
      return tables.panel_accounts.find((r) => r.device_id === args[0] && r.member_id === args[1]) || null;
    }
    if (/FROM panel_pending WHERE pending_id=\$1 AND member_id=\$2/.test(sql)) {
      return tables.panel_pending.find((r) => r.pending_id === args[0] && r.member_id === args[1]) || null;
    }
    if (/FROM members WHERE id=\$1/.test(sql)) return member;
    if (/count\(\*\)::int AS n FROM panel_accounts/.test(sql)) {
      return { n: tables.panel_accounts.filter((r) => r.member_id === args[0]).length };
    }
    throw new Error('db.one 시험 대상 아님: ' + sql);
  },
  async q(sql, args) {
    if (/^DELETE FROM panel_pending WHERE expires_at/.test(sql)) {
      tables.panel_pending = tables.panel_pending.filter((r) => !(r.expires_at < args[0] || (r.member_id === args[1] && r.device_id === args[2])));
      return { rowCount: 0 };
    }
    if (/^DELETE FROM panel_pending WHERE pending_id=\$1/.test(sql)) {
      tables.panel_pending = tables.panel_pending.filter((r) => r.pending_id !== args[0]);
      return { rowCount: 0 };
    }
    if (/INSERT INTO panel_pending/.test(sql)) {
      tables.panel_pending.push({ pending_id: args[0], member_id: args[1], device_id: args[2], email: args[3], created_at: args[4], expires_at: args[5] });
      return { rowCount: 1 };
    }
    if (/INSERT INTO panel_accounts/.test(sql)) {
      if (!tables.panel_accounts.find((r) => r.device_id === args[0])) {
        tables.panel_accounts.push({ device_id: args[0], member_id: args[1], email: args[2], created_at: args[3] });
      }
      return { rowCount: 1 };
    }
    throw new Error('db.q 시험 대상 아님: ' + sql);
  },
};

// sender 흉내: 각 시험이 confirm 답과 스냅숏을 정한다
const S = { calls: [], confirm: null, snap: null };
let seq = 0;
const sender = {
  up: () => true,
  reason: () => '',
  customerReason: () => '',
  async call(method, url, body) {
    S.calls.push(url.split('?')[0]);
    if (url === '/v1/register/begin') {
      seq += 1;
      return { status: 200, json: { ok: true, state: 'confirm_on_phone', pending_id: 'pend-' + seq, passcode: '482913', remaining_seconds: 300 } };
    }
    if (url === '/v1/register/confirm') {
      const c = typeof S.confirm === 'function' ? S.confirm(body) : S.confirm;
      if (c instanceof Error) throw c;
      return { status: 200, json: Object.assign({ ok: true }, c) };
    }
    if (url.indexOf('/v1/snapshot') === 0) {
      return { status: 200, json: Object.assign({ ok: true, config: {}, rooms: [], features: {} }, S.snap) };
    }
    return { status: 200, json: { ok: true } };
  },
};

const stubs = {
  '../lib/db': db,
  '../lib/sender-child': sender,
  '../lib/member-auth': { requireMember: async () => ({ member: { id: member.id } }) },
  '../lib/entitle': { maxAccounts: () => 3, pushGrants: async () => {} },
  '../lib/installs': {},
};
const origLoad = Module._load;
Module._load = function (request, parent) {
  if (parent && parent.filename === path.join(ROOT, 'routes', 'panel.js') && stubs[request]) return stubs[request];
  return origLoad.apply(this, arguments);
};
const router = require('../routes/panel.js');
Module._load = origLoad;

function post(port, p, body) {
  return new Promise((resolve, reject) => {
    const data = Buffer.from(JSON.stringify(body));
    const req = http.request({
      host: '127.0.0.1', port, path: p, method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': data.length },
    }, (res) => {
      let s = '';
      res.on('data', (c) => { s += c; });
      res.on('end', () => { try { resolve(JSON.parse(s)); } catch (e) { reject(new Error(p + ' ' + res.statusCode + ' ' + s)); } });
    });
    req.on('error', reject);
    req.end(data);
  });
}

async function run(port) {
  const begin = (body) => post(port, '/panel/api/register/begin', Object.assign({ email: 'a@k.test', password: 'pw' }, body || {}));
  const confirm = (id) => post(port, '/panel/api/register/confirm', { pending_id: id });
  const askedSender = () => S.calls.indexOf('/v1/register/confirm') >= 0;

  // 1. 새 계정: 첫 확인은 sender 에 묻고, 확인 전이면 waiting
  S.calls = []; S.confirm = { state: 'waiting' }; S.snap = { linked: false, needs_register: false };
  let b = await begin();
  assert(b.state === 'confirm_on_phone' && b.passcode, '새 계정 등록 시작은 인증번호를 보여 준다');
  let c = await confirm(b.pending_id);
  assert(c.state === 'waiting' && askedSender(), '새 계정의 첫 확인은 sender 에 묻고 waiting');
  S.confirm = { state: 'ok' };
  c = await confirm(b.pending_id);
  assert(c.state === 'ok', '새 계정은 sender 가 ok 라고 하면 끝난다');
  assert(tables.panel_accounts.length === 1, '새 계정이 저장된다');
  S.calls = [];
  c = await confirm(b.pending_id);
  assert(c.state === 'ok' && !askedSender(), '이미 끝난 새 계정의 확인은 sender 에 다시 묻지 않는다');

  // 2. 재등록(로그인이 끊긴 계정): 예전 panel_accounts 행이 있어도 첫 확인은 ok 가 아니다 — 인증번호가 바로 넘어가던 버그
  tables.panel_accounts.push({ device_id: 'w7-old', member_id: 7, email: 're@k.test', created_at: 1 });
  S.calls = []; S.confirm = { state: 'waiting' }; S.snap = { linked: false, needs_register: true };
  b = await begin({ device_id: 'w7-old', email: 're@k.test' });
  assert(b.state === 'confirm_on_phone', '재등록 시작은 인증번호를 보여 준다');
  c = await confirm(b.pending_id);
  assert(c.state === 'waiting' && askedSender(), '재등록의 첫 확인은 sender 에 묻고 waiting (바로 완료 금지)');

  // 3. 재등록(예전 세션이 아직 붙어 있음): reg_at 이 이번 시작보다 이르면 끝난 것으로 보지 않는다
  S.calls = []; S.snap = { linked: true, needs_register: false, features: { reg_at: 5 } };
  b = await begin({ device_id: 'w7-old', email: 're@k.test' });
  c = await confirm(b.pending_id);
  assert(c.state === 'waiting', '붙어 있던 예전 세션만으로는 재등록 완료가 아니다');

  // 4. 재등록 성공: sender 의 ok 로 끝나고 행은 하나 그대로
  S.confirm = { state: 'ok' };
  c = await confirm(b.pending_id);
  assert(c.state === 'ok' && c.device_id === 'w7-old', '재등록은 sender 가 ok 라고 하면 끝난다');
  assert(tables.panel_accounts.filter((r) => r.device_id === 'w7-old').length === 1, '재등록은 행을 늘리지 않는다');

  // 5. 확인 요청이 20초 제한에 걸린 사이 성공: 이번 시작 뒤에 저장된 세션(reg_at)이면 ok
  b = await begin({ device_id: 'w7-old', email: 're@k.test' });
  const since = tables.panel_pending.find((r) => r.pending_id === b.pending_id).created_at;
  S.confirm = new Error('timeout'); S.snap = { linked: false, needs_register: true };
  c = await confirm(b.pending_id);
  assert(c.state === 'waiting', '확인 요청이 끊기고 아직 저장 전이면 waiting');
  S.snap = { linked: true, needs_register: false, features: { reg_at: since + 1 } };
  c = await confirm(b.pending_id);
  assert(c.state === 'ok', '이번 시작 뒤에 저장된 세션이면 ok');

  // 6. sender 가 다시 시작해 대기 목록을 잃음: 시간 초과가 아니라 다시 시작했다고 말하고 대기를 지운다
  b = await begin({ device_id: 'w7-old', email: 're@k.test' });
  S.confirm = { state: 'expired', reason: 'unknown_pending' }; S.snap = { linked: false, needs_register: true };
  c = await confirm(b.pending_id);
  assert(c.state === 'expired' && /다시 시작/.test(c.text), 'sender 재시작은 그 사실을 말한다');
  assert(!tables.panel_pending.find((r) => r.pending_id === b.pending_id), '잃은 대기는 지운다');

  // 7. 카카오 실패는 그대로 실패로 보이고 대기를 지운다
  b = await begin();
  S.confirm = { state: 'failed', code: 'registration_failed', status: -110 }; S.snap = { linked: false };
  c = await confirm(b.pending_id);
  assert(c.state === 'failed' && /-110/.test(c.text), '카카오 실패 문구와 오류 번호를 보인다');
  assert(!tables.panel_pending.find((r) => r.pending_id === b.pending_id), '실패한 대기는 지운다');
}

const app = express();
app.use(express.json());
app.use(router);
const srv = app.listen(0, '127.0.0.1', () => {
  run(srv.address().port).then(() => {
    srv.close();
    process.stdout.write('register flow check ok\n');
  }, (e) => {
    srv.close();
    process.stderr.write('register flow check FAILED: ' + (e && e.stack ? e.stack : e) + '\n');
    process.exit(1);
  });
});
