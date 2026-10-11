// 오픈채팅 링크 (docs/ACCOUNTS_V1.md 3.3·9.2).
// 고객이 붙여 넣는 글은 링크만 있지 않다. 카카오톡 "링크 공유"는 보통
//   "'동네모임' 오픈채팅방에 참여해 보세요 https://open.kakao.com/o/gAbCdEf 참여코드: 1234"
// 같은 모양이라 글 안에서 링크 하나를 뽑는다. 결과는 항상 https://open.kakao.com/o/<code> 한 모양이다
// (room_installs.link_url · room_blocklist.link_url 비교가 이 값으로 된다).
// 오픈프로필(open.kakao.com/me/…)·게시물(/p/…) 링크는 방이 아니므로 종류만 알려 준다(알맞은 안내 문구용).
// 1:1 오픈채팅방도 /o/ 링크라 여기서는 못 거른다. 봇 조회(JOININFO lt 1)가 not_group 으로 거른다.
// 구매 화면(public/app.js normLink)도 같은 식을 쓴다. lib/purchase-check.js 가 두 쪽 결과를 맞춰 본다.
'use strict';

const MAX_TEXT = 2000;
const CODE_MAX = 40;

// 앞쪽 경계. https:// 가 있으면 바로 앞이 / 만 아니면 된다(방 제목이 붙어 온 'Tradehttps://…' · '링크:https://…' 도 받는다).
// https:// 가 없으면 주소에 들 수 없는 글자여야 한다(abcopen.kakao.com 같은 다른 호스트를 잡지 않게).
const HOST = '(?:(?:^|[^/])https?://|(?:^|[^A-Za-z0-9.\\-_@/]))open\\.kakao\\.com/';
// 코드 뒤에 _ - 가 이어지면 잘라 쓰지 않고 링크가 아닌 것으로 본다(엉뚱한 방을 조회하지 않게)
const LINK_RE = new RegExp(HOST + 'o/([A-Za-z0-9]{1,' + CODE_MAX + '})(?![A-Za-z0-9_\\-])', 'i');
const OTHER_RE = new RegExp(HOST + '(me|p)/', 'i');
// 복사할 때 섞여 드는 보이지 않는 글자(코드 가운데에 끼면 코드가 잘린다)
// 눈에 안 보이는 글자(폭 없는 공백·방향 표시·소프트 하이픈 등). 코드 중간에 끼면 코드가 잘리므로 먼저 지운다
const ZW_RE = /[\u00AD\u180E\u200B-\u200F\u202A-\u202E\u2060-\u2064\uFEFF]/g;

// 붙여넣은 글 -> {kind:'room', url} | {kind:'profile'} | {kind:'post'} | {kind:'none'}
function parseLink(text) {
  if (text === null || text === undefined) return { kind: 'none' };
  const s = String(text).slice(0, MAX_TEXT).replace(ZW_RE, '');
  const m = LINK_RE.exec(s);
  if (m) return { kind: 'room', url: 'https://open.kakao.com/o/' + m[1] };
  const o = OTHER_RE.exec(s);
  if (o) return { kind: o[1].toLowerCase() === 'me' ? 'profile' : 'post' };
  return { kind: 'none' };
}

// 붙여넣은 글 -> 'https://open.kakao.com/o/<code>' | ''
function normLink(text) {
  const p = parseLink(text);
  return p.kind === 'room' ? p.url : '';
}

// 표시용: 'open.kakao.com/o/<code>'
function shortLink(url) {
  return String(url || '').replace(/^https?:\/\//i, '');
}

module.exports = { parseLink, normLink, shortLink };
