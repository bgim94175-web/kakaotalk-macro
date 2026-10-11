'use strict';
// 은행 입금 알림 원문 → 금액 후보 첫째·입금자명 (lib/deposit-text.js)

const { amountCandidates, parseName } = require('./deposit-text');

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

const CASES = [
  // [원문, 금액, 이름]
  ['[Web발신]\n[카카오뱅크]\n김*성(8227)\n10/11 15:18\n입금 10,000원\n황정현', 10000, '황정현'],
  ['[Web발신]\n[KB]10/11 15:18\n123456**789\n홍길동\n입금\n30,045\n잔액1,234,567', 30045, '홍길동'],
  ['신한 10/11 15:18 110-***-123456 입금 30,045원 잔액 1,000,000 홍길동', 30045, '홍길동'],
  ['토스뱅크 홍길동님이 30,045원을 보냈어요', 30045, '홍길동'],
  ['입금 30,045원 홍길동', 30045, '홍길동'],
];

for (const [text, amount, name] of CASES) {
  const c = amountCandidates(text);
  assert(c[0] === amount, 'amount ' + JSON.stringify(text) + ' → ' + JSON.stringify(c));
  assert(parseName(text) === name, 'name ' + JSON.stringify(text) + ' → ' + parseName(text));
}
assert(amountCandidates('잔액 1,234,567원').length === 0, '잔액만 있는 알림은 금액 없음');
assert(parseName('[Web발신] 입금 10,000원') === null, '이름 없는 알림');

process.stdout.write('deposit text check ok\n');
