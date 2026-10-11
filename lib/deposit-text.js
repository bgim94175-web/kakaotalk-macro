'use strict';
// 은행 입금 알림(문자·앱 푸시) 원문에서 금액과 입금자명을 읽는다. routes/purchase.js 의 /api/deposit-hook 이 쓴다.
// 은행마다 모양이 다르다. 예) 카카오뱅크 문자:
//   [Web발신] [카카오뱅크] 김*성(8227) 10/11 15:18 입금 10,000원 황정현
// 계좌 뒷자리 "(8227)", 날짜 "10/11", 시각 "15:18", 잔액 숫자는 금액이 아니다.
//
// 입금자명 칸(받는 분 통장 표시)은 보내는 사람이 마음대로 쓴다. 100원을 보내며 이름 칸에 "35047" 을 적어도
// 35,047원으로 읽으면 안 된다. 그래서 자동 승인은 sure 일 때만 한다:
//   은행이 "입금"과 붙여 쓴 금액이 딱 하나 + 그 밖의 "…원" 숫자 없음 + 취소·정정·반환 알림 아님.
// sure 가 아니면 금액은 화면에 보여 주기만 한다(관리자가 원문을 보고 연결).

const MAX = 100000000;
const NUM = '(\\d{1,3}(?:,\\d{3})+|\\d+)';

// 전각 숫자·쉼표·콜론, 줄바꿈 모양을 맞춘다
function norm(text) {
  return String(text || '')
    .replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
    .replace(/，/g, ',').replace(/：/g, ':').replace(/\u00a0/g, ' ')
    .replace(/\r\n?/g, '\n');
}

// 금액이 될 수 없는 조각을 공백으로 지운다(뒤 단계에서 숫자로 잡히지 않게).
function scrub(text) {
  return norm(text)
    .replace(/\(\s*[\d*\-\s]{2,}\)/g, ' ')                       // (8227) (123-***) 계좌 뒷자리
    .replace(/[\d*]+(?:-[\d*]+)+/g, ' ')                          // 110-***-123456 계좌·전화번호
    .replace(/\d*\*+\d*/g, ' ')                                   // 가려진 숫자
    .replace(/\d{1,4}[./]\d{1,2}(?:[./]\d{1,4})?/g, ' ')         // 10/11 2026.10.11 날짜
    .replace(/\d{1,2}:\d{2}(?::\d{2})?/g, ' ')                    // 15:18 시각
    // 잔액·수수료·출금 바로 뒤(같은 줄) 숫자. 단 뒤에 "입금"이 붙은 숫자는 남긴다 —
    // 이름 칸에 "잔액"을 적어 진짜 입금액("잔액 100 입금")을 지우지 못하게. ("입출금통장"의 출금은 빼고)
    .replace(new RegExp('(잔액|잔고|수수료|한도|누적|(?<!입)출금)[ \\t:]{0,2}' + NUM +
      '(?![\\d,]|[ \\t]*원?[ \\t]*(?:이|을|가)?[ \\t]*입금)[ \\t]*원?', 'g'), ' ');
}

function toAmount(s, min) {
  const n = Number(String(s).replace(/,/g, ''));
  return Number.isFinite(n) && n >= min && n <= MAX ? n : null;
}

// 정규식 목록으로 금액을 모은다(중복 없이, 나온 순서대로)
function collect(s, list, min) {
  const out = [];
  for (const re of list) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(s)) !== null) {
      const n = toAmount(m[1], min);
      if (n !== null && out.indexOf(n) < 0) out.push(n);
    }
  }
  return out;
}

// 은행이 "입금"과 붙여 쓴 금액. 금액 뒤 이름 줄로 넘어가 붙지 않게 숫자 앞뒤는 [ \t] 만 본다
// ("입금" 바로 다음 줄의 숫자만 예외 — KB 예전 문자 "입금\n30,045").
const TIED = [
  // 입금 10,000원 · 입금\n30,045 · 입금액: 10,000 · 입금 금액 10,000 (1만원은 읽지 않음)
  new RegExp('입금(?:액|금액)?[ \\t]*(?:금액)?[ \\t]*:?\\s{0,3}' + NUM + '(?![\\d,]|\\s*[만천])', 'g'),
  // 1,000,000 입금 (KB) · 10,000원 입금 · 10,000원이 입금
  new RegExp(NUM + '[ \\t]*원?[ \\t]*(?:이|을|가)?[ \\t]*입금', 'g'),
  // 홍길동님이 10,000원을 보냈어요 (토스)
  new RegExp('님이[ \\t]*' + NUM + '[ \\t]*원[ \\t]*(?:을|이)?[ \\t]*(?:보냈|입금)', 'g'),
  // 10,000원 받았어요
  new RegExp(NUM + '[ \\t]*원[ \\t]*(?:을|이)?[ \\t]*받았', 'g'),
];
const WON = [new RegExp(NUM + '\\s*원', 'g')];       // "…원" 이 붙은 숫자
const ANY = [/(\d{1,3}(?:,\d{3})+|\d{3,})/g];         // 마지막 수단: 세 자리 이상 숫자(보여 주기만)

// 알림 원문 → { amount, sure, cands, name }
//   amount: 화면에 보일 금액(못 읽으면 null) · sure: 자동 승인해도 되는 금액인지 · cands: 읽은 금액들
function readDeposit(text) {
  const s = scrub(text);
  const cancel = /취소|정정|반환/.test(s);      // 입금취소·정정은 자동 처리하지 않는다
  const tied = collect(s, TIED, 1);             // 1원 시험 입금도 금액으로 보여 준다(주문은 1만원대라 맞을 일 없음)
  const won = collect(s, WON, 1);
  if (tied.length) {
    return { amount: tied[0], sure: tied.length === 1 && !cancel && won.every((n) => n === tied[0]),
             cands: tied, name: parseName(text) };
  }
  if (won.length) {
    return { amount: won[0], sure: won.length === 1 && !cancel && /입금|받았|님이/.test(s),
             cands: won, name: parseName(text) };
  }
  const any = collect(s, ANY, 100);
  return { amount: any.length === 1 ? any[0] : null, sure: false, cands: any, name: parseName(text) };
}

const NAME_STOP = ['입금', '출금', '잔액', '잔고', '한도', '누적', '계좌', '이체', '수수료', '결제', '승인',
  '취소', '만원', '알림', '내역', '거래', '일시', '확인', '문자', '광고', '머니', '송금', '완료', '현금',
  '발신', '보냈어요', '보냈습니다', '받았어요', '입금됨', '입금액', '금액', '통장', '보통예금', '예금',
  '저축예금', '자유적금', '적금', '체크', '안내', '고객', '고객님', '님이', '원이'];
const LINE_STOP = /^(입금|출금|잔액|잔고|이체|송금|입금액|금액|거래|내역|알림|안내|확인|완료|보냈어요|받았어요|입출금통장|통장|내통장|모임통장)$/;
const BANKISH = /뱅크|뱅킹|은행|저축|우체국|농협|신협|새마을|금고|카드|증권|페이|토스|카카오|^KB$|^IBK$|^NH$|Web발신/i;

// 이름처럼 생긴 조각만 남긴다(숫자뿐·가린 글자·은행 이름·입금 같은 낱말은 null)
function cleanName(w) {
  w = String(w || '').trim().replace(/^[[(]|[\])]$/g, '').replace(/(님이|님|씨)$/, '').trim();
  if (!w || w.length > 12 || /[*]/.test(w) || /^\d+$/.test(w)) return null;
  if (!/[가-힣A-Za-z]/.test(w) || LINE_STOP.test(w) || BANKISH.test(w)) return null;
  if (/\d[\d,]*\s*원/.test(w) || /(입금|출금|잔액|수수료)/.test(w)) return null;
  return w;
}

// 한 줄짜리 알림: 금액("…원") 뒤에 나온 이름 → 없으면 마지막 후보
function nameInLine(text) {
  const s = norm(text).replace(/\[[^\]]*\]/g, ' ');                // [Web발신] [카카오뱅크] 같은 머리표
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

// 입금자명 추정(보조 확인용 — 형식을 모르면 null).
// "홍길동님이 …" · "홍길동 → 내 통장" → 금액 줄 앞뒤의 이름만 있는 줄 → 한 줄짜리 알림 방식
function parseName(text) {
  const raw = norm(text).replace(/\[[^\]]*\]/g, '\n');
  let m = /([가-힣A-Za-z0-9]{2,12})\s*님이\s*\d/.exec(raw);
  if (m && cleanName(m[1])) return cleanName(m[1]);
  m = /(?:^|\n)\s*([^\n→]{2,12}?)\s*→/.exec(raw);
  if (m && cleanName(m[1])) return cleanName(m[1]);
  const lines = raw.split('\n').map((l) => l.trim()).filter(Boolean);
  const at = lines.findIndex((l) => /입금/.test(l) && /\d/.test(l));
  const order = at < 0 ? lines.map((_, i) => lines.length - 1 - i)
    : [at + 1, at - 1, at + 2, at - 2, at + 3, at - 3].filter((i) => i >= 0 && i < lines.length);
  for (const i of order) {
    const l = lines[i].replace(/\s*\(.*\)$/, '');
    if (/^[가-힣A-Za-z0-9][가-힣A-Za-z0-9 ]{1,11}$/.test(l)) {
      const n = cleanName(l);
      if (n) return n;
    }
  }
  return nameInLine(text);
}

module.exports = { readDeposit, parseName, scrub };
