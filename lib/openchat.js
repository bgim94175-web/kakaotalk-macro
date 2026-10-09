// 오픈채팅 링크 (docs/ACCOUNTS_V1.md 3.3·9.2).
// 고객이 붙여 넣는 글은 링크만 있지 않다. 카카오톡 "링크 공유"는 보통
//   "'동네모임' 오픈채팅방에 참여해 보세요 https://open.kakao.com/o/gAbCdEf 참여코드: 1234"
// 같은 모양이라 글 안에서 링크 하나를 뽑는다. 결과는 항상 https://open.kakao.com/o/<code> 한 모양이다
// (room_installs.link_url · room_blocklist.link_url 비교가 이 값으로 된다).
// 1:1 오픈채팅·오픈프로필(open.kakao.com/me/…)은 /o/ 가 아니므로 여기서 걸러진다.
'use strict';

const MAX_TEXT = 2000;
const CODE_MAX = 40;

// 앞쪽 경계: 글 처음이거나 주소에 들 수 없는 글자. (abcopen.kakao.com 같은 다른 호스트를 잡지 않게)
const LINK_RE = new RegExp(
  '(?:^|[^A-Za-z0-9.\\-_@/])(?:https?:\\/\\/)?open\\.kakao\\.com\\/o\\/([A-Za-z0-9]{1,' + CODE_MAX + '})(?![A-Za-z0-9])',
  'i');

// 붙여넣은 글 -> 'https://open.kakao.com/o/<code>' | ''
function normLink(text) {
  if (text === null || text === undefined) return '';
  const s = String(text).slice(0, MAX_TEXT);
  const m = LINK_RE.exec(s);
  if (!m) return '';
  return 'https://open.kakao.com/o/' + m[1];
}

// 표시용: 'open.kakao.com/o/<code>'
function shortLink(url) {
  return String(url || '').replace(/^https?:\/\//i, '');
}

module.exports = { normLink, shortLink };
