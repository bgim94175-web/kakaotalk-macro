'use strict';
// 은행 입금 알림(문자·앱 푸시) 원문에서 금액과 입금자명을 읽는다. routes/purchase.js 의 /api/deposit-hook 이 쓴다.
// 은행마다 모양이 다르다. 예) 카카오뱅크 문자:
//   [Web발신] [카카오뱅크] 김*성(8227) 10/11 15:18 입금 10,000원 황정현
// 계좌 뒷자리 "(8227)", 날짜 "10/11", 시각 "15:18", 잔액 숫자는 금액이 아니다.
// 금액 후보 순서: "입금 10,000원"처럼 입금 바로 옆 숫자 → "…원" 숫자 → 그 밖의 숫자(예전 방식, 마지막 수단).

const MIN = 100;
const MAX = 100000000;
const NUM = '(\\d{1,3}(?:,\\d{3})+|\\d+)';

// 금액이 될 수 없는 조각을 공백으로 지운다(뒤 단계에서 숫자로 잡히지 않게).
function scrub(text) {
  return String(text || '')
    .replace(/\(\s*[\d*\-\s]{2,}\)/g, ' ')                       // (8227) (123-***) 계좌 뒷자리
    .replace(/[\d*]+(?:-[\d*]+)+/g, ' ')                          // 110-***-123456 계좌·전화번호
    .replace(/\d*\*+\d*/g, ' ')                                   // 가려진 숫자
    .replace(/\d{1,4}[./]\d{1,2}(?:[./]\d{1,4})?/g, ' ')         // 10/11 2026.10.11 날짜
    .replace(/\d{1,2}:\d{2}(?::\d{2})?/g, ' ');                   // 15:18 시각
}

function toAmount(s) {
  const n = Number(String(s).replace(/,/g, ''));
  return Number.isFinite(n) && n >= MIN && n <= MAX ? n : null;
}

const NOT_DEPOSIT = /(잔액|잔고|한도|누적|수수료)[^0-9]{0,8}$/;

// 금액 후보(중복 없이, 믿을 만한 순서)
function amountCandidates(text) {
  const s = scrub(text);
  const out = [];
  const push = (v) => {
    const n = toAmount(v);
    if (n !== null && out.indexOf(n) < 0) out.push(n);
  };
  let m;
  // 1) 입금 바로 옆: "입금 10,000원" "입금액 10,000원" "입금 금액: 10,000" "10,000원 입금" "10,000원이 입금"
  const near = [
    new RegExp('입금(?:액|금액)?\\s*(?:금액)?\\s*[:：]?\\s*' + NUM, 'g'),
    new RegExp(NUM + '\\s*원\\s*(?:이|이\\s*)?\\s*입금', 'g'),
  ];
  for (const re of near) {
    while ((m = re.exec(s)) !== null) push(m[1]);
  }
  // 2) "…원" 이 붙은 숫자(잔액·한도 뒤는 빼고)
  const won = new RegExp(NUM + '\\s*원', 'g');
  while ((m = won.exec(s)) !== null) {
    if (NOT_DEPOSIT.test(s.slice(Math.max(0, m.index - 14), m.index))) continue;
    push(m[1]);
  }
  // 3) 마지막 수단: 세 자리 이상 숫자
  const any = /(\d{1,3}(?:,\d{3})+|\d{3,})/g;
  while ((m = any.exec(s)) !== null) {
    if (NOT_DEPOSIT.test(s.slice(Math.max(0, m.index - 14), m.index))) continue;
    push(m[1]);
  }
  return out;
}

const NAME_STOP = ['입금', '출금', '잔액', '잔고', '한도', '누적', '계좌', '이체', '수수료', '결제', '승인',
  '취소', '만원', '알림', '내역', '거래', '일시', '확인', '문자', '광고', '머니', '송금', '완료', '현금',
  '발신', '보냈어요', '보냈습니다', '받았어요', '입금됨', '입금액', '금액', '통장', '보통예금', '예금',
  '저축예금', '자유적금', '적금', '체크', '안내', '고객', '고객님', '님이', '원이'];

// 입금자명 추정(보조 확인용 — 형식을 모르면 null). 금액 뒤에 오는 이름이 대부분이다.
function parseName(text) {
  const raw = String(text || '');
  const s = raw.replace(/\[[^\]]*\]/g, ' ');                       // [Web발신] [카카오뱅크] 같은 머리표
  const words = s.match(/[가-힣]{2,5}/g) || [];
  const cands = [];
  for (let w of words) {
    w = w.replace(/(님이|님|씨)$/, '');
    if (w.length < 2 || w.length > 4) continue;
    if (NAME_STOP.indexOf(w) >= 0 || /^원[을이은]/.test(w)) continue;
    if (/뱅|은행|저축|우체|협|카드|보험|증권|페이|체크|신용|금고|토스|카카오/.test(w)) continue;
    cands.push(w);
  }
  if (!cands.length) return null;
  // 금액 표기("…원") 뒤에 나온 이름이 있으면 그것, 없으면 마지막 후보
  const won = /\d[\d,]*\s*원/.exec(s);
  if (won) {
    const after = s.slice(won.index + won[0].length).match(/[가-힣]{2,5}/g) || [];
    for (let w of after) {
      w = w.replace(/(님이|님|씨)$/, '');
      if (cands.indexOf(w) >= 0) return w;
    }
  }
  return cands[cands.length - 1];
}

module.exports = { amountCandidates, parseName, scrub };
