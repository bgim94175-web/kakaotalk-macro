'use strict';
// 은행 입금 알림 원문 → 금액 · 자동 승인해도 되는지(sure) · 입금자명 (lib/deposit-text.js)
// 웹훅 전체 흐름(주문 찾기·승인)은 lib/deposit-hook-check.js 가 본다.

const { readDeposit } = require('./deposit-text');

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

const KAKAO = '[Web발신]\n[카카오뱅크]\n김*성(8227)\n10/11 15:18\n';
const KB = '[KB]7/10 16:40\n498125****8895\n';

const CASES = [
  // [원문, 금액, sure, 이름(undefined 면 안 봄)]
  // 알림 모양별
  [KAKAO + '입금 10,000원\n황정현', 10000, true, '황정현'],           // 실제로 받은 문자 — 예전엔 8,227원으로 읽었다
  ['[Web발신] [카카오뱅크] 김*성(8227) 10/11 15:18 입금 35,047원 황정현', 35047, true, '황정현'],
  ['[Web발신] [카카오뱅크] 김*성(8227) 10/11 15:18 입금 10,000원 황정현', 10000, true, '황정현'],   // 줄바꿈이 빠진 본문
  ['카카오뱅크 [Web발신] [카카오뱅크] 김*성(8227) 10/11 15:18 입금 10,000원 황정현', 10000, true, '황정현'], // MacroDroid 제목+본문
  [KB + '강동원\n1,000,000 입금\n잔액 50,000\n1644-9999', 1000000, true, '강동원'],   // KB 공식 모양
  [KB + '강동원\n35,047 입금\n1644-9999', 35047, true, '강동원'],
  ['[KB]8/27 14:00\n423725****1160\n입금\n1644-9999', null, false, null],
  [KB + '홍길동\n인터넷출금10,000\n잔액 50,000\n1644-9999', null, false, '홍길동'],
  ['[Web발신]\n[KB]10/11 15:18\n123456**789\n홍길동\n입금\n30,045\n잔액1,234,567', 30045, true, '홍길동'],
  ['신한 10/11 15:18 110-***-123456 입금 30,045원 잔액 1,000,000 홍길동', 30045, true, '홍길동'],
  ['토스뱅크 홍길동님이 30,045원을 보냈어요', 30045, true, '홍길동'],
  ['입금 30,045원 홍길동', 30045, true, '홍길동'],
  ['[Web발신]\n신한10/11 15:18\n110-***-123456\n입금 35,047\n잔액 51,000\n 황정현', 35047, true, '황정현'],
  ['[Web발신]\n농협 입금35,047원\n10/11 15:18 351-****-1234-53 황정현 잔액51,000원', 35047, true, '황정현'],
  ['[Web발신]\n[하나]10/11 15:18\n123-******-12345\n입금35,047원\n황정현\n잔액51,000원', 35047, true, '황정현'],
  ['입금 35,047원\n황정현 → 내 입출금통장(8227)', 35047, true, '황정현'],
  ['35,047원 받았어요\n황정현', 35047, true, '황정현'],
  [KAKAO + '입금 10,000원\n황정현\n잔액 1,234,567원', 10000, true, '황정현'],
  ['[카카오뱅크] 입금 ３５，０４７원 황정현', 35047, true, '황정현'],              // 전각 숫자
  ['[카카오뱅크]\r\n입금 35,047원\r\n황정현', 35047, true, '황정현'],             // CRLF · 줄바꿈 없는 공백
  ['[카카오뱅크] 입출금통장 입금 35,047원 황정현', 35047, true, '황정현'],       // "입출금"의 출금은 잔액류가 아니다
  ['[하나] 출금계좌 입금 35,047원', 35047, true, undefined],
  ['[IBK] 입금 홍길동 35,047원', 35047, true, '홍길동'],
  [KAKAO + '입금 1원\n황정현', 1, true, '황정현'],                               // 1원 시험 입금
  // 입금자명 칸에 숫자 (흔한 일: 동·호수, 주문번호)
  [KAKAO + '입금 35,047원\n508호홍길동', 35047, true, '508호홍길동'],
  [KAKAO + '입금 35,000원\n홍길동35047', 35000, true, '홍길동35047'],
  // 공격: 적은 돈을 보내며 이름 칸에 주문 금액을 적는다 → 그 금액으로 확실히 읽으면 안 된다
  [KAKAO + '입금 1원\n35047', 1, true, null],
  [KAKAO + '입금 100원\n35,047원', 100, false, null],
  [KB + '35047\n100 입금\n1644-9999', 100, true, null],
  [KAKAO + '입금 100원\n입금35047', 100, false, null],
  [KB + '35047 입금\n100 입금\n1644-9999', 100, false, null],
  [KAKAO + '입금 100원\n님이35047원보냈', 100, false, undefined],
  ['[Web발신] [카카오뱅크] 김*성(8227) 10/11 15:18 입금 100원 35047', 100, true, null],
  ['[KB]7/10 16:40 498125****8895 35047입금잔액 100 입금 1644-9999', 35047, false, undefined],  // 이름 칸 "잔액"으로 진짜 금액 지우기
  [KB + '35047입금잔액\n100 입금\n1644-9999', 35047, false, undefined],
  ['[IBK] 입금 35047입금 100원', 35047, false, undefined],
  // 확실하지 않음 → 자동 승인 안 함
  ['[X은행] 잔액 1,035,047원 입금 35,047원 황정현', 35047, false, '황정현'],
  ['[X] 황정현 35,047원 / 100원', 35047, false, '황정현'],
  ['[Web발신]\n[신한] 10/11 15:18 입금 1만원 황정현', null, false, '황정현'],
  ['[카카오뱅크] 김*성(8227) 10/11 15:18 입금취소 35,047원 황정현', 35047, false, '황정현'],
  ['[카카오뱅크] 입금정정 35,047원 황정현', 35047, false, '황정현'],
  ['황정현님에게 35,047원을 보냈어요', 35047, false, null],
  ['[신한] 10/11 15:18 이체 35,047원 홍길동', 35047, false, '홍길동'],
];

for (const [text, amount, sure, name] of CASES) {
  const r = readDeposit(text);
  const got = JSON.stringify([r.amount, r.sure, r.name]);
  assert(r.amount === amount, 'amount ' + JSON.stringify(text) + ' → ' + got);
  assert(r.sure === sure, 'sure ' + JSON.stringify(text) + ' → ' + got);
  if (name !== undefined) assert(r.name === name, 'name ' + JSON.stringify(text) + ' → ' + got);
  assert(Array.isArray(r.cands) && (r.amount === null || r.cands.indexOf(r.amount) >= 0), 'cands ' + JSON.stringify(text));
}
assert(readDeposit('잔액 1,234,567원').amount === null, '잔액만 있는 알림은 금액 없음');
assert(readDeposit('[Web발신] 입금 10,000원').name === null, '이름 없는 알림');
assert(readDeposit('').amount === null && readDeposit(null).sure === false, '빈 본문');

process.stdout.write('deposit text check ok\n');
