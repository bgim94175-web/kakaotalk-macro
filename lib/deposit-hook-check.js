'use strict';
// 자동 입금확인 웹훅(POST /api/deposit-hook)을 실제 routes/purchase.js 로 돌려 본다. db·감사 기록·승인만 바꿔 끼운다.
// 지켜야 할 것: 확실히 읽은 금액 하나로만 주문을 찾는다. 입금자명 칸의 숫자로 다른 주문을 승인하지 않는다.
// 입금취소는 확인 필요로 남긴다. 줄바꿈이 그대로 들어간 JSON 본문도 400 없이 받아 줄 구조째 기록한다.

const Module = require('module');
const fs = require('fs');
const path = require('path');
const http = require('http');
const express = require('express');
const rl = require('./ratelimit');

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

process.env.DEPOSIT_TOKEN = 'deposit-check-token-0123456789';
process.env.DEPOSIT_AUTO_APPROVE = '1';

const ROOT = path.join(__dirname, '..');
const T = { deposits: [], orders: [], approved: [], audits: [] };

const db = {
  async one(sql, args) {
    if (/SELECT id FROM deposits WHERE raw_hash=\$1/.test(sql)) return T.deposits.find((d) => d.raw_hash === args[0]) || null;
    throw new Error('db.one 시험 대상 아님: ' + sql);
  },
  async q(sql, args) {
    if (/INSERT INTO deposits/.test(sql)) {
      if (T.deposits.some((d) => d.raw_hash === args[5])) return { rowCount: 0, rows: [] };
      const id = T.deposits.length + 1;
      T.deposits.push({ id, at: args[0], amount: args[1], name: args[2], raw: args[3], source: args[4], raw_hash: args[5],
        matched_order: null, status: 'unmatched' });
      return { rowCount: 1, rows: [{ id }] };
    }
    if (/^UPDATE deposits SET status=\$1, matched_order=\$2 WHERE id=\$3$/.test(sql)) {
      const d = T.deposits.find((x) => x.id === args[2]);
      d.status = args[0];
      d.matched_order = args[1];
      return { rowCount: 1 };
    }
    if (/^UPDATE deposits SET status='ambiguous', amount=NULL, matched_order=NULL WHERE id=\$1$/.test(sql)) {
      const d = T.deposits.find((x) => x.id === args[0]);
      Object.assign(d, { status: 'ambiguous', amount: null, matched_order: null });
      return { rowCount: 1 };
    }
    if (/SELECT \* FROM orders WHERE status='pending' AND amount=\$1/.test(sql)) {
      const rows = T.orders.filter((o) => o.status === 'pending' && o.amount === args[0]);
      return { rowCount: rows.length, rows };
    }
    throw new Error('db.q 시험 대상 아님: ' + sql);
  },
  async tx(fn) { return fn({}); },
};

const stubs = {
  '../lib/db': db,
  '../lib/audit': { record: async (req, kind, info) => { T.audits.push(kind + ' ' + (info && info.detail)); } },
  '../lib/keys': {
    async approveOrder(client, id) {
      const o = T.orders.find((x) => x.id === id);
      o.status = 'done';
      T.approved.push(id);
      return { key: null, member_id: 7 };
    },
  },
  '../lib/entitle': { afterApprove: () => {} },
};
const origLoad = Module._load;
Module._load = function (request, parent) {
  if (parent && parent.filename === path.join(ROOT, 'routes', 'purchase.js') && stubs[request]) return stubs[request];
  return origLoad.apply(this, arguments);
};
const router = require('../routes/purchase.js');
Module._load = origLoad;

// server.js 의 본문 처리와 같은 규칙: 입금 웹훅만 express.json 을 건너뛴다
const serverSrc = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
const skipAt = serverSrc.indexOf("if (rl.kindOf(req) === 'deposit') return next();");
assert(skipAt > 0 && skipAt < serverSrc.indexOf('return jsonSmall(req, res, next);'), 'server.js: 입금 웹훅은 express.json 을 건너뛴다');
['/api/deposit-hook', '/api/deposit-hook/', '/API/Deposit-Hook'].forEach((p) => {
  assert(rl.kindOf({ method: 'POST', path: p }) === 'deposit', 'kindOf deposit ' + p);
});

function post(port, p, ct, body) {
  return new Promise((resolve, reject) => {
    const data = Buffer.from(body);
    const req = http.request({
      host: '127.0.0.1', port, path: p, method: 'POST', agent: false,
      headers: { 'content-type': ct, 'content-length': data.length, 'x-deposit-token': process.env.DEPOSIT_TOKEN },
    }, (res) => {
      let s = '';
      res.on('data', (c) => { s += c; });
      res.on('end', () => { try { resolve(Object.assign({ http: res.statusCode }, JSON.parse(s))); } catch (e) { reject(new Error(p + ' ' + res.statusCode + ' ' + s)); } });
    });
    req.on('error', reject);
    req.end(data);
  });
}

const KAKAO = '[Web발신]\n[카카오뱅크]\n김*성(8227)\n';
let minute = 10;
// 시각을 바꿔 매번 다른 알림으로 만든다(중복 판정에 걸리지 않게)
const kakao = (line, label) => KAKAO + '10/11 15:' + (minute++) + '\n' + line + '\n' + label;

async function run(port) {
  const hook = (text, p) => post(port, p || '/api/deposit-hook', 'application/json', JSON.stringify({ text, source: 'shortcuts' }));
  const last = () => T.deposits[T.deposits.length - 1];
  const order = (amount, extra) => {
    const o = Object.assign({ id: 'ORD-' + amount + '-' + T.orders.length, status: 'pending', amount, depositor: '홍길동' }, extra);
    T.orders.push(o);
    return o;
  };

  // 1. 받은 카카오뱅크 문자: 10,000원 · 황정현, 맞는 주문이 없으니 주문 못 찾음
  let r = await hook(KAKAO + '10/11 15:18\n입금 10,000원\n황정현');
  assert(r.status === 'unmatched' && r.amount === 10000, '받은 문자는 10,000원 미매칭: ' + JSON.stringify(r));
  assert(last().amount === 10000 && last().name === '황정현', '입금 기록 10,000원 · 황정현');

  // 2. 공격: 적은 돈 + 입금자명 칸에 주문 금액 → 35,047원 주문은 그대로 대기
  const target = order(35047, { depositor: '공격자' });
  const attacks = [
    // [원문, 기록될 금액]
    [kakao('입금 100원', '35047'), 100],
    [kakao('입금 1원', '35047'), 1],
    [kakao('입금 100원', '35,047원'), 100],
    [kakao('입금 100원', '입금35047'), null],                                   // 입금에 붙은 금액이 둘 → 금액·후보 없이 확인 필요
    ['[KB]7/10 16:41\n498125****8895\n35047 입금\n100 입금\n1644-9999', null],
    ['[KB]7/10 16:42 498125****8895 35047입금잔액 100 입금 1644-9999', null],    // 금액이 둘 → 확인 필요(승인 안 함)
    ['[IBK] 입금 35047잔액 100원', 35047],                                        // 이름 칸 "잔액"으로 진짜 금액 지우기
  ];
  for (const [text, amount] of attacks) {
    r = await hook(text);
    assert(r.status !== 'matched' && target.status === 'pending' && T.approved.length === 0,
      '이름 칸 숫자로 승인하지 않는다: ' + JSON.stringify(text) + ' → ' + JSON.stringify(r));
    assert(last().amount === amount && last().status === r.status, '읽은 금액 그대로 기록한다(주문 금액으로 덮지 않음): ' + JSON.stringify(text) + ' → ' + last().amount);
    if (amount === null) assert(last().matched_order === null && r.order === undefined, '금액이 둘이면 후보 주문도 붙이지 않는다: ' + JSON.stringify(text));
  }

  // 3. 입금취소: 같은 금액의 대기 주문이 있어도 연결하지 않고 확인 필요로 남긴다
  r = await hook('[카카오뱅크] 김*성(8227) 10/11 16:21 입금취소 35,047원 황정현');
  assert(r.status === 'ambiguous' && target.status === 'pending' && last().status === 'ambiguous' && last().matched_order === null,
    '입금취소는 확인 필요: ' + JSON.stringify(r));

  // 4. 금액은 하나인데 입금 알림인지 확실하지 않으면 맞는 주문을 후보로만 붙인다
  r = await hook('[신한] 10/11 16:20 이체 35,047원 홍길동');
  assert(r.status === 'ambiguous' && r.order === target.id && target.status === 'pending' && T.approved.length === 0,
    '확실하지 않은 금액은 자동 승인하지 않는다: ' + JSON.stringify(r));
  assert(last().status === 'ambiguous' && last().matched_order === target.id, '후보 주문이 기록된다');
  // 금액이 둘 이상이고 어느 것인지 모르면 금액도 후보도 붙이지 않는다(이름 칸 숫자일 수 있다)
  r = await hook('[X] 황정현 35,047원 / 100원');
  assert(r.status === 'ambiguous' && r.amount === null && r.order === undefined && target.status === 'pending', '금액 둘 → 후보 없음: ' + JSON.stringify(r));
  assert(last().amount === null && last().matched_order === null, '금액 둘 → 기록에도 금액·후보 없음');

  // 5. 정상 입금: 대기 주문 하나와 금액이 맞으면 승인
  r = await hook('[Web발신] [카카오뱅크] 김*성(8227) 10/11 16:30 입금 35,047원 황정현');
  assert(r.status === 'matched' && r.order === target.id && T.approved[0] === target.id && target.status === 'done',
    '정상 입금은 승인: ' + JSON.stringify(r));
  assert(last().status === 'matched' && last().amount === 35047 && last().matched_order === target.id, '연결 기록');
  assert(T.audits.some((a) => /입금자명 불일치/.test(a)), '이름이 다르면 경고만 남긴다');

  // 6. 같은 금액의 대기 주문이 둘이면 확인 필요
  order(30045); order(30045);
  r = await hook('[Web발신] [카카오뱅크] 김*성(8227) 10/11 16:31 입금 30,045원 홍길동');
  assert(r.status === 'ambiguous' && r.candidates === 2 && T.approved.length === 1, '같은 금액 주문 둘 → 확인 필요');

  // 7. 줄바꿈이 그대로 들어간 JSON(MacroDroid) — 끝 슬래시·대소문자가 달라도 400 없이 받아 줄 구조째 기록
  const paths = ['/api/deposit-hook', '/api/deposit-hook/', '/API/Deposit-Hook'];
  for (const p of paths) {
    const text = KAKAO + '10/11 17:0' + paths.indexOf(p) + '\n입금 10,000원\n황정현';
    r = await post(port, p + '?source=macrodroid', 'application/json', '{"text":"' + text + '","source":"macrodroid"}');
    assert(r.http === 200 && r.status === 'unmatched' && r.amount === 10000, '날 줄바꿈 JSON ' + p + ': ' + JSON.stringify(r));
    assert(last().raw === text && last().source === 'macrodroid' && last().name === '황정현', '원문 줄바꿈이 남는다 ' + p);
  }
  // JSON 바깥에도 날 줄바꿈이 있으면 공백으로 풀어 금액은 읽는다
  r = await post(port, '/api/deposit-hook', 'application/json', '{\n"text":"입금 10,000원\n황정현",\n"source":"tasker"}');
  assert(r.status === 'unmatched' && r.amount === 10000 && last().source === 'tasker', '줄바꿈 섞인 JSON: ' + JSON.stringify(r));

  // 8. text/plain · 폼 본문
  r = await post(port, '/api/deposit-hook?source=plain', 'text/plain', '[신한] 10/11 17:10 입금 20,045원 홍길동');
  assert(r.status === 'unmatched' && r.amount === 20045 && last().source === 'plain', 'text/plain 본문');
  r = await post(port, '/api/deposit-hook', 'application/x-www-form-urlencoded',
    'text=' + encodeURIComponent('[신한] 10/11 17:11 입금 20,046원 홍길동') + '&source=form');
  assert(r.status === 'unmatched' && r.amount === 20046 && last().source === 'form', '폼 본문');

  // 9. 같은 알림 재전송 · 출금 알림
  r = await post(port, '/api/deposit-hook?source=plain', 'text/plain', '[신한] 10/11 17:10 입금 20,045원 홍길동');
  assert(r.status === 'duplicate', '같은 알림은 한 번만');
  r = await hook('[KB]7/10 15:22\n498125****8895\n홍길동\n인터넷출금10,000\n잔액 50,000\n1644-9999');
  assert(r.status === 'ignored' && last().status === 'ignored', '출금 알림은 무시');
}

const app = express();
const jsonSmall = express.json({ limit: '512kb' });
app.use((req, res, next) => (rl.kindOf(req) === 'deposit' ? next() : jsonSmall(req, res, next)));
app.use(router);
app.use((err, req, res, next) => res.status(err.status || 500).json({ ok: false, error: String(err.type || err.message) }));
const srv = app.listen(0, '127.0.0.1', () => {
  run(srv.address().port).then(() => {
    srv.close();
    process.stdout.write('deposit hook check ok\n');
  }, (e) => {
    srv.close();
    process.stderr.write('deposit hook check FAILED: ' + (e && e.stack ? e.stack : e) + '\n');
    process.exit(1);
  });
});
