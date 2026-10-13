// 구매·발급·설치 검사 (DB 없이 돈다). docs/ACCOUNTS_V1.md 9.5 작업 2.
//   참여코드 봉인 고정 시험 벡터(9.0) · 9.2 서명 · pricing.quote 금액·한도·오류 · openchat.normLink(구매 화면과 같은 답) ·
//   installs.displayOf 전 상태(on_count 0 문구, retry_after, retry_admin_only, hold) · publicView 모양 ·
//   ERRORS 문구 규칙(TONE: 합니다체·마침표, '실시간 상담' 없음).
// 시험 벡터는 sender/src/selfcheck.mjs 와 같은 문자열이어야 한다(두 구현이 같은 형식이라는 증거).
'use strict';

// 벡터가 이 값에 기대므로 덮어쓴다(검사 전용 프로세스).
process.env.CONFIG_SECRET = '0123456789abcdef0123456789abcdef';

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

// ── 참여코드 봉인 (8장 6번, 9.0) ─────────────────────────────
const box = require('./secretbox');

const VECTOR_IV = '000102030405060708090a0b';
const VECTOR = 'v1.AAECAwQFBgcICQoLlAj1igkIAeTZFvTsl-bF0uEUVlk';

assert(box.sealWithIv('0000', VECTOR_IV) === VECTOR, 'secretbox: fixed test vector changed: ' + box.sealWithIv('0000', VECTOR_IV));
assert(box.sealWithIv('0000', Buffer.from(VECTOR_IV, 'hex')) === VECTOR, 'secretbox: Buffer iv gives the same blob');
assert(box.open(VECTOR) === '0000', 'secretbox: vector opens to 0000');

const s1 = box.seal('0000');
const s2 = box.seal('0000');
assert(/^v1\.[A-Za-z0-9_-]+$/.test(s1), 'secretbox: v1. + base64url');
assert(s1 !== s2, 'secretbox: random iv per seal');
assert(s1.indexOf('0000') < 0, 'secretbox: no plaintext in the blob');
assert(box.open(s1) === '0000' && box.open(s2) === '0000', 'secretbox: roundtrip');
assert(box.open(box.seal('참여코드 12345')) === '참여코드 12345', 'secretbox: utf8 roundtrip');

// 변조·형식 오류는 null
const raw = Buffer.from(VECTOR.slice(3), 'base64url');
for (const i of [0, 12, 27, raw.length - 1]) {
  const t = Buffer.from(raw);
  t[i] ^= 1;
  assert(box.open('v1.' + t.toString('base64url')) === null, 'secretbox: tampered byte ' + i + ' rejected');
}
assert(box.open('v2.' + VECTOR.slice(3)) === null, 'secretbox: unknown version rejected');
assert(box.open(VECTOR.slice(3)) === null, 'secretbox: missing prefix rejected');
assert(box.open('v1.' + raw.subarray(0, 27).toString('base64url')) === null, 'secretbox: short blob rejected');
assert(box.open('v1.abc def') === null && box.open('') === null && box.open(null) === null, 'secretbox: junk rejected');

// 다른 비밀 → 열리지 않음, 비밀 없음 → seal 은 던지고 open 은 null
process.env.CONFIG_SECRET = 'another-secret-value-0123456789';
assert(box.open(VECTOR) === null, 'secretbox: other CONFIG_SECRET cannot open');
process.env.CONFIG_SECRET = '';
assert(box.open(VECTOR) === null, 'secretbox: no CONFIG_SECRET -> null');
let threw = false;
try { box.seal('0000'); } catch (e) { threw = true; }
assert(threw, 'secretbox: seal without CONFIG_SECRET throws');
process.env.CONFIG_SECRET = '  0123456789abcdef0123456789abcdef  ';
assert(box.open(VECTOR) === '0000', 'secretbox: CONFIG_SECRET is trimmed');
process.env.CONFIG_SECRET = '0123456789abcdef0123456789abcdef';

// ── 9.2 서명 (작업 2 소유 모듈) ─────────────────────────────
function hasFns(mod, name, fns) {
  fns.forEach(function (f) { assert(typeof mod[f] === 'function', name + '.' + f + ' is exported'); });
}
const openchat = require('./openchat');
hasFns(openchat, 'openchat', ['normLink', 'parseLink']);
hasFns(box, 'secretbox', ['seal', 'open', 'sealWithIv']);

const entitle = require('./entitle');
hasFns(entitle, 'entitle', ['macroView', 'extendMacro', 'claimKey', 'applyOrder', 'afterApprove', 'pushGrants',
  'startLoop', 'reassignKey', 'summary']);
assert(Number.isInteger(entitle.maxAccounts()) && entitle.maxAccounts() > 0, 'entitle.maxAccounts()');

const installs = require('./installs');
hasFns(installs, 'installs', ['displayOf', 'publicView', 'preview', 'reserveForOrder', 'cancelForOrder',
  'cancelMemberOrder', 'conflictFor', 'assignBot', 'isBlocked', 'listForMember', 'getForMember', 'saveConfig',
  'retry', 'grantRoom', 'move', 'remove', 'rebind', 'setProducts', 'transfer', 'block', 'unblock', 'release',
  'nudge', 'nudgeMember', 'startLoop']);
assert(installs.ERRORS && typeof installs.ERRORS === 'object', 'installs.ERRORS');


// ── 가격표·견적(4.1) ────────────────────────────────────────
const pricing = require('./pricing');
hasFns(pricing, 'pricing', ['quote', 'table', 'label', 'bankInfo', 'contactInfo']);
assert(pricing.MAX_ROOMS === 10, 'pricing.MAX_ROOMS = 10');
assert(pricing.PRODUCTS.macro.price === 20000 && pricing.PRODUCTS.macro.days === 30 &&
       pricing.PRODUCTS.macro.min === 1 && pricing.PRODUCTS.macro.max === 12, 'macro 20,000원 / 30일 / 1~12개월');
assert(pricing.PRODUCTS.roombot.price === 10000 && pricing.PRODUCTS.roombot.unit === 'room', 'roombot 10,000원 / 방');
assert(pricing.PRODUCTS.minigame.price === 10000 && pricing.PRODUCTS.minigame.unit === 'room', 'minigame 10,000원 / 방');
assert(pricing.label('macro') === '카카오톡 매크로' && pricing.label('roombot') === '방 관리봇' &&
       pricing.label('minigame') === '미니게임봇', 'product labels');
assert(Object.isFrozen(pricing.PRODUCTS) && Object.isFrozen(pricing.PRODUCTS.macro), 'PRODUCTS frozen');
// 스크립트가 꺼졌을 때 보이는 HTML 의 대체 금액·관리 화면 머리 설명도 pricing 과 같은 값이어야 한다(가격 조정 때 함께 고친다)
{
  const fs = require('fs');
  const path = require('path');
  const pub = (f) => fs.readFileSync(path.join(__dirname, '..', 'public', f), 'utf8');
  const comma = (n) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const buyHtml = pub('buy.html');
  ['macro', 'roombot', 'minigame'].forEach((id) => {
    const found = buyHtml.match(new RegExp('data-bind="price-' + id + '">([0-9,]+)<', 'g')) || [];
    found.forEach((m) => assert(m.indexOf('>' + comma(pricing.PRODUCTS[id].price) + '<') > 0,
      'buy.html fallback price for ' + id + ' = pricing (' + m + ')'));
  });
  assert((buyHtml.match(/data-bind="price-(roombot|minigame)">/g) || []).length === 4, 'buy.html has four room price fallbacks');
  const sub = /id="prodSub">([^<]*)</.exec(pub('manage.html'));
  assert(sub && sub[1].indexOf('방 관리봇 방마다 ' + comma(pricing.PRODUCTS.roombot.price) + '원') >= 0 &&
         sub[1].indexOf('미니게임봇 방마다 ' + comma(pricing.PRODUCTS.minigame.price) + '원') >= 0, 'manage.html #prodSub fallback = pricing');
  assert(!/15,000원/.test(buyHtml + pub('manage.html') + pub('panel.html') + pub('app.js') + pub('panel.js')), 'old 15,000원 room price is gone from the site');
}

const t = pricing.table();
assert(t.currency === 'KRW' && t.max_rooms === 10 && Array.isArray(t.products) && t.products.length === 3,
  'table shape');
assert(t.products.map((x) => x.id).join(',') === 'macro,roombot,minigame', 'table product order');
assert(t.products[0].desc === '내 카카오 계정으로 정해진 간격마다 자동 발송 · 이미지 첨부 · 갠톡 자동 응답 · 저격 규칙', 'macro desc');
assert(t.products[1].desc === '입장·퇴장 기록 · 들낙 감지 · 나간 사람 재입장 차단 · 프로필 기록 · 홍보 금지 · 글 가리기 · 금지어 검열 · 올킥 감지', 'roombot desc (용어집)');
assert('bank' in t && 'contact' in t, 'table bank/contact');
assert(!('PRICE' in pricing) && !('PLAN' in pricing) && !('NAME' in pricing), 'old PRICE/PLAN/NAME removed');

function q(input) { return pricing.quote(input); }
let r = q({ macro_months: 1 });
assert(r.ok && r.total === 20000 && r.lines.length === 1 && r.lines[0].product === 'macro' && r.lines[0].months === 1,
  'macro only, no rooms (rooms missing)');
r = q({ macro_months: 2, rooms: [] });
assert(r.ok && r.total === 40000, 'macro 2 months, empty rooms = 40,000');
r = q({ macro_months: '3', rooms: [] });
assert(r.ok && r.total === 60000, 'months as string');
r = q({ macro_months: 2, rooms: [{ products: ['roombot', 'minigame'] }, { products: ['minigame'] }] });
assert(r.ok && r.total === 40000 + 10000 * 3, 'macro + 3 room lines = 70,000');
assert(r.lines.filter((l) => l.room === 0).length === 2 && r.lines.filter((l) => l.room === 1).length === 1, 'room index on lines');
assert(r.lines.every((l) => l.amount === l.unit_price * (l.months || 1)), 'line amount = unit × count');
r = q({ rooms: [{ products: ['minigame', 'minigame', 'bogus'] }] });
assert(r.ok && r.total === 10000 && r.lines.length === 1, 'room products deduped, unknown dropped');
r = q({ rooms: [{ products: { roombot: true, minigame: false } }] });
assert(r.ok && r.total === 10000 && r.lines[0].product === 'roombot', 'room products as object');
const maxRooms = []; for (let i = 0; i < 10; i++) maxRooms.push({ products: ['roombot', 'minigame'] });
r = q({ macro_months: 12, rooms: maxRooms });
assert(r.ok && r.total === 440000, 'max order = 440,000 (D24)');

function qfail(input, reason, room) {
  const x = q(input);
  assert(!x.ok && x.reason === reason, 'quote ' + JSON.stringify(input).slice(0, 80) + ' → ' + reason + ' (got ' + JSON.stringify(x) + ')');
  assert(typeof x.error === 'string' && x.error.length > 0, 'quote error text for ' + reason);
  if (room !== undefined) assert(x.room === room, 'quote room index for ' + reason);
  return x;
}
assert(qfail({}, 'empty').error === '상품을 1개 이상 선택해 주세요.', 'empty text');
qfail({ macro_months: 0, rooms: [] }, 'empty');
assert(qfail({ macro_months: 13 }, 'bad_months').error === '기간은 1~12개월로 입력해 주세요.', 'bad_months text');
qfail({ macro_months: -1 }, 'bad_months');
qfail({ macro_months: 1.5 }, 'bad_months');
qfail({ macro_months: 'abc' }, 'bad_months');
const tooMany = []; for (let i = 0; i < 11; i++) tooMany.push({ products: ['minigame'] });
assert(qfail({ rooms: tooMany }, 'too_many_rooms').error === '방은 한 번에 10개까지 주문할 수 있습니다.', 'too_many_rooms text');
assert(qfail({ macro_months: 1, rooms: [{ products: ['minigame'] }, { products: [] }] }, 'no_products', 1).error ===
  '이 방에 설치할 봇을 1개 이상 골라 주세요.', 'no_products text + room index');

// 옛 이름이 화면 이름표에 남지 않음(0장)
const feats = require('./features');
assert(feats.LABELS.macro === '카카오톡 매크로' && feats.LABELS.roombot === '방 관리봇', 'features.LABELS renamed');
assert(Object.values(feats.LABELS).join() .indexOf('자동발송') < 0 && Object.values(feats.LABELS).join().indexOf('대화방 관리봇') < 0,
  'old product names gone');

// ── 링크 정규화 ──────────────────────────────────────────────
const N = openchat.normLink;
const L = 'https://open.kakao.com/o/gAbCdEf';
assert(N(L) === L, 'normLink plain');
assert(N('http://open.kakao.com/o/gAbCdEf') === L, 'normLink http → https');
assert(N('open.kakao.com/o/gAbCdEf') === L, 'normLink no scheme');
assert(N('HTTPS://OPEN.KAKAO.COM/o/gAbCdEf') === L, 'normLink host case');
assert(N("'동네모임' 오픈채팅방에 참여해 보세요\nhttps://open.kakao.com/o/gAbCdEf 참여코드: 1234") === L, 'normLink in share text');
assert(N('(https://open.kakao.com/o/gAbCdEf)') === L, 'normLink in brackets');
assert(N('https://open.kakao.com/o/gAbCdEf?ref=x') === L, 'normLink query dropped');
assert(N('https://open.kakao.com/o/gAbCdEf/') === L, 'normLink trailing slash');
assert(N('https://open.kakao.com/o/gABCDEF') !== N('https://open.kakao.com/o/gabcdef'), 'normLink keeps code case');
assert(N('https://open.kakao.com/me/someone') === '', 'normLink open profile rejected');
assert(N('https://open.kakao.com/o/') === '', 'normLink empty code');
assert(N('https://evilopen.kakao.com/o/abc') === '', 'normLink other host');
assert(N('https://example.com/https://open.kakao.com/o/abc') === '', 'normLink nested in other url');
assert(N('https://open.kakao.com/o/' + 'a'.repeat(41)) === '', 'normLink code too long');
assert(N('') === '' && N(null) === '' && N(undefined) === '' && N(12345) === '', 'normLink junk');
// 카카오톡 공유 글, 방 제목이 링크 앞에 붙어 온 글
const G = 'https://open.kakao.com/o/gx56UHmh';
assert(N('카카오톡 오픈채팅을 시작해 보세요.\n링크를 선택하면 카카오톡이 실행됩니다.\n\n월계상단 테스트\nhttps://open.kakao.com/o/sQYMtoRi') ===
  'https://open.kakao.com/o/sQYMtoRi', 'normLink kakao share text');
assert(N('Roblox Tradehttps://open.kakao.com/o/gx56UHmh') === G, 'normLink title glued (latin)');
assert(N('모임 2026https://open.kakao.com/o/gx56UHmh') === G && N('모임https://open.kakao.com/o/gx56UHmh') === G, 'normLink title glued (digit, 한글)');
assert(N('joinopen.kakao.com/o/gx56UHmh') === '' && N('http://m.open.kakao.com/o/abc') === '', 'normLink other host (no scheme, subdomain)');
// 보이지 않는 글자는 지우고, 코드 뒤에 _ - 가 이어지면 잘라 쓰지 않는다
assert(N('https://open.kakao.com/o/gx56\u200BUHmh') === G && N('\uFEFFhttps://open.kakao.com/o/gx56UHmh\u2060') === G, 'normLink zero-width removed');
assert(N('https://open.kakao.com/o/gx_56UHmh') === '' && N('https://open.kakao.com/o/gx56-UHmh') === '', 'normLink _ - rejected, not cut short');
assert(N('https://open.kakao.com/me/abc https://open.kakao.com/o/gx56UHmh') === G, 'normLink room link after a profile link');
// 링크 바로 앞에 : . 가 붙은 글(공지 글·제목 끝 마침표)
assert(N('링크:https://open.kakao.com/o/gx56UHmh') === G && N('URL:https://open.kakao.com/o/gx56UHmh') === G, 'normLink after a colon');
assert(N('Trade Co.https://open.kakao.com/o/gx56UHmh') === G && N('심심해서 만든 방...https://open.kakao.com/o/gx56UHmh') === G, 'normLink after a period');
// 방향 표시·소프트 하이픈 같은 안 보이는 글자도 지운다
assert(N('https://open.kakao.com/o/gx56\u200EUHmh') === G && N('https://open.kakao.com/o/gx\u00AD56UHmh') === G, 'normLink direction mark, soft hyphen');
assert(N('x'.repeat(1900) + ' ' + G) === G, 'normLink long text under 2000');
const P = (t) => openchat.parseLink(t).kind;
assert(P(G) === 'room' && openchat.parseLink(G).url === G, 'parseLink room');
assert(P('https://open.kakao.com/me/abcdef') === 'profile' && P('오픈프로필 open.kakao.com/me/abc') === 'profile', 'parseLink profile');
assert(P('https://open.kakao.com/p/abcdef') === 'post', 'parseLink post');
assert(P('https://evilopen.kakao.com/me/abc') === 'none' && P('') === 'none' && P(null) === 'none' && P('https://open.kakao.com/o/') === 'none', 'parseLink none');
const LINK_CASES = [L, G, '', 'abc', 'open.kakao.com/o/gAbCdEf', 'HTTPS://OPEN.KAKAO.COM/o/gAbCdEf', '(https://open.kakao.com/o/gAbCdEf)',
  "'동네모임' 오픈채팅방에 참여해 보세요\nhttps://open.kakao.com/o/gAbCdEf 참여코드: 1234", L + '?ref=x', L + '/', 'https://open.kakao.com/me/someone',
  'https://open.kakao.com/p/abc', 'https://open.kakao.com/o/', 'https://evilopen.kakao.com/o/abc', 'https://example.com/https://open.kakao.com/o/abc',
  'https://open.kakao.com/o/' + 'a'.repeat(40), 'https://open.kakao.com/o/' + 'a'.repeat(41), 'Roblox Tradehttps://open.kakao.com/o/gx56UHmh',
  '모임 2026https://open.kakao.com/o/gx56UHmh', 'joinopen.kakao.com/o/gx56UHmh', 'http://m.open.kakao.com/o/abc', 'a@open.kakao.com/o/abc',
  'https://open.kakao.com/o/gx56\u200BUHmh', 'https://open.kakao.com/o/gx_56UHmh', 'https://open.kakao.com/o/gx56-UHmh', 'https://open.kakao.com/o/gx56.',
  'https://open.kakao.com/me/abc https://open.kakao.com/o/gx56UHmh', 'x'.repeat(1990) + ' ' + G,
  '링크:https://open.kakao.com/o/gx56UHmh', 'Trade Co.https://open.kakao.com/o/gx56UHmh', '방...https://open.kakao.com/o/gx56UHmh',
  'https://open.kakao.com/o/gx56\u200EUHmh', 'https://open.kakao.com/o/gx\u00AD56UHmh'];
LINK_CASES.forEach((t) => assert(N(N(t)) === N(t), 'normLink idempotent: ' + JSON.stringify(t.slice(0, 60))));
// 구매 화면(public/app.js)의 normLink 가 서버와 같은 답을 내는가
{
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'public', 'app.js'), 'utf8');
  const part = (re, what) => { const m = re.exec(src); assert(m, 'app.js has ' + what); return m[0]; };
  const code = part(/var LINK_RE = \/.*\/i;/, 'LINK_RE') + '\n' + part(/var ZW_RE = \/.*\/g;/, 'ZW_RE') + '\n' +
    part(/function normLink\(text\) \{[\s\S]*?\n  \}/, 'normLink') + '\nnormLink;';
  const browserNorm = require('vm').runInNewContext(code, {});
  LINK_CASES.forEach((t) => assert(browserNorm(t) === N(t), 'app.js normLink = server: ' + JSON.stringify(t.slice(0, 60)) + ' → ' + browserNorm(t)));
}

// ── 방 상태 표시(0.1·3.4.2·5.6) ─────────────────────────────
process.env.ROOM_RETRY_BASE_MS = '120000';
const NOW = Date.UTC(2026, 9, 9, 3, 0, 0);   // 12:00 KST
const MIN = 60000;
function row(extra) {
  return Object.assign({ id: 12, member_id: 7, link_url: L, link_id: '123456789', link_name: '동네모임',
    roombot: true, minigame: true, phase: 'installed', order_id: 'ORD-261009-ABCDEF', bot_device_id: 'bot.0123456789abcdef',
    hold_reason: null, retry_n: 0, state: 'queued', error_code: null, error_detail: null, perm: null, joined_at: null,
    state_at: NOW - MIN, next_try_at: null, retry_at: null, config: {}, config_rev: 0 }, extra || {});
}
function D(extra, opts) { return installs.displayOf(row(extra), NOW, opts); }

let d = D({ phase: 'pending_payment', roombot: false, minigame: false, bot_device_id: null });
assert(d.display === 'pending' && d.label === '입금 대기' && !d.can_retry, 'pending');
d = D({ phase: 'canceled' });
assert(d.display === 'canceled' && d.label === '취소됨', 'canceled');
d = D({ phase: 'removed' });
assert(d.display === 'removed' && d.label === '설치 해제', 'removed');
d = D({ state: 'queued' });
assert(d.display === 'joining' && d.label === '입장 중' && d.detail === 'K bot이 이 방에 들어가고 있습니다.', 'queued → joining');
d = D({ state: 'joining' });
assert(d.display === 'joining' && d.label === '입장 중', 'joining');
d = D({ state: 'queued', bot_device_id: null, error_detail: 'no_bot' });
assert(d.display === 'joining' && d.label === '입장 중 · 순서 대기' &&
       d.detail === '입장 순서를 기다리고 있습니다. 순서가 되면 자동으로 입장합니다.', 'no_bot → 순서 대기');
d = D({ state: 'joining', error_detail: 'rate_limited', next_try_at: NOW + 30 * MIN });
assert(d.display === 'joining' && d.detail === '카카오 입장 제한으로 12:30에 다시 입장을 시도합니다.', 'rate_limited HH:MM (KST): ' + d.detail);
d = D({ hold_reason: 'name:도박', bot_device_id: null });
assert(d.display === 'joining' && d.label === '입장 중' && d.detail === '관리자가 확인한 뒤 K bot이 들어갑니다.', 'hold → joining');
d = D({ hold_reason: 'name:도박', state: 'error', error_code: 'kicked' });
assert(d.display === 'joining' && !d.can_retry, 'hold wins over state');
d = D({ state: 'waiting_host', perm: 2 }, { nickname: 'K bot 3' });
assert(d.display === 'waiting' && d.label === '부방장 지정 대기', 'waiting');
assert(d.detail === '오픈채팅방의 부방장 관리에서 「K bot 3」을 부방장으로 지정해 주세요. 방장만 지정할 수 있으며, 지정하면 1~2분 안에 자동으로 확인됩니다.',
  'waiting detail with nickname: ' + d.detail);
assert(D({ state: 'waiting_host' }, { nickname: 'K bot 2' }).detail.indexOf('「K bot 2」를 부방장으로') >= 0, 'josa 를 after 2');
assert(D({ state: 'waiting_host', bot_nickname: 'K봇' }).detail.indexOf('「K봇」을') >= 0, 'nickname from row.bot_nickname');
assert(D({ state: 'waiting_host' }).detail.indexOf('K bot을 부방장으로') >= 0, 'waiting without nickname');

d = D({ state: 'active', perm: 4, config: {} });
assert(d.display === 'active' && d.label === '사용 중 · 켜진 기능 없음' &&
       d.detail === '방 관리 기능이 모두 꺼져 있습니다. 필요한 기능을 켜 주세요.', 'active + roombot + on_count 0');
d = D({ state: 'active', perm: 4, config: { visit: { enabled: true } } });
assert(d.display === 'active' && d.label === '사용 중' && d.detail === '', 'active with a feature on');
d = D({ state: 'active', roombot: false, config: {} });
assert(d.display === 'active' && d.label === '사용 중', 'minigame-only active has no on_count note');
// 미니게임만 쓰던 방(active, 봇 perm 2)에 방 관리봇을 더한 직후: sender 가 다시 계산하기 전에도 부방장 대기(0.1)
d = D({ state: 'active', perm: 2, config: { visit: { enabled: true } } }, { nickname: 'K bot 3' });
assert(d.display === 'waiting' && d.label === '부방장 지정 대기' && d.detail.indexOf('「K bot 3」을 부방장으로') >= 0,
  'roombot added to a minigame-only room → waiting until the bot is 부방장');
assert(D({ state: 'active', perm: null }).display === 'waiting', 'roombot + active without a known perm → waiting');
assert(D({ state: 'active', perm: 1 }).display === 'active', 'perm 1 (방장) counts as host rights');
assert(D({ state: 'active', roombot: false, perm: 2 }).display === 'active', 'minigame-only room ignores perm');
assert(installs.onCountOf(row({ config: { visit: { enabled: true }, churn: { enabled: true }, games: { enabled: true },
  guard: { enabled: false } } })) === 2, 'on_count counts roombot sections only');
assert(installs.onCountOf(row({ roombot: false, config: { visit: { enabled: true } } })) === 0, 'on_count 0 without roombot');

// 오류 + 다시 시도
d = D({ state: 'error', error_code: 'passcode_needed' });
assert(d.display === 'error' && d.label === '오류 · 참여코드 필요' && d.can_retry && d.retry_after === 0 && !d.retry_admin_only,
  'first error: can retry now');
assert(d.detail === installs.ERRORS.passcode_needed.long, 'error detail = ERRORS long');
d = D({ state: 'error', error_code: 'kicked' }, { nickname: 'K bot 3' });
assert(d.label === '오류 · 내보내짐' &&
       d.detail === 'K bot 「K bot 3」이 방에서 내보내졌습니다. 오픈채팅방의 내보내기 목록에서 K bot을 해제한 뒤 [다시 시도]를 눌러 주세요.',
  'kicked with nickname: ' + d.detail);
assert(D({ state: 'error', error_code: 'kicked' }, { nickname: 'K bot 2' }).detail.indexOf('「K bot 2」가 방에서') >= 0, 'josa 가');
assert(D({ state: 'error', error_code: 'kicked' }).detail.indexOf('K bot이 방에서 내보내졌습니다.') === 0, 'kicked without nickname');
// 직전 다시 시도 1회 뒤 실패: 2분 간격
d = D({ state: 'error', error_code: 'room_full', retry_n: 1, retry_at: NOW - MIN, joined_at: null });
assert(d.can_retry && d.retry_after === NOW - MIN + 2 * MIN, 'retry_after = retry_at + base (n=1)');
d = D({ state: 'error', error_code: 'room_full', retry_n: 3, retry_at: NOW - MIN });
assert(d.can_retry && d.retry_after === NOW - MIN + 8 * MIN, 'retry_after doubles (n=3 → 8분)');
d = D({ state: 'error', error_code: 'room_full', retry_n: 2, retry_at: NOW - 10 * MIN });
assert(d.can_retry && d.retry_after === 0, 'gap passed → retry_after 0');
d = D({ state: 'error', error_code: 'room_full', retry_n: 9, retry_at: NOW - MIN });
assert(d.can_retry && d.retry_after === NOW - MIN + 6 * 3600000, 'gap capped at 6 hours');
d = D({ state: 'error', error_code: 'room_full', retry_n: 10, retry_at: NOW - MIN });
assert(!d.can_retry && d.retry_admin_only && d.detail.endsWith(' 다시 시도 횟수를 넘었습니다. 문의해 주세요.'), 'retry_admin_only at 10');
// 직전 다시 시도 뒤 입장 성공 → 새 사건(횟수 0)
d = D({ state: 'error', error_code: 'kicked', retry_n: 10, retry_at: NOW - 60 * MIN, joined_at: NOW - 30 * MIN });
assert(d.can_retry && !d.retry_admin_only && d.retry_after === 0, 'joined after retry → fresh');
d = D({ state: 'error', error_code: 'link_gone' });
assert(d.label === '오류 · 링크 만료' && !d.can_retry && !d.retry_admin_only, 'link_gone not retryable');
d = D({ state: 'error', error_code: 'bot_down' });
assert(!d.can_retry && d.label === '오류 · K bot 점검', 'bot_down not retryable');
// D12: 봇 계정에 오픈프로필이 없으면 입장을 미룬다(고객이 할 일 없음, 자동으로 다시 입장)
d = D({ state: 'error', error_code: 'bot_no_open_profile', error_detail: 'none' });
assert(!d.can_retry && d.label === '오류 · K bot 준비 중' && d.detail.indexOf('자동으로 입장합니다') >= 0, 'bot_no_open_profile: not retryable, waits');
assert(installs.ERRORS.profile_blocked.long.indexOf('오픈프로필') >= 0 && installs.ERRORS.profile_blocked.long.indexOf('기본 프로필') < 0,
  'profile_blocked speaks of the open profile, not the main profile');
assert(/rs\.runtime->'prof'->>'nn'/.test(installs.BOT_NAME_SQL) && /b\.open_profile_name, b\.nickname\)$/.test(installs.BOT_NAME_SQL) &&
  installs.BOT_NAME_SQL.indexOf("rs.runtime->'prof'->>'nn'") < installs.BOT_NAME_SQL.indexOf('THEN NULLIF(b.nickname') &&
  installs.BOT_NAME_SQL.indexOf('THEN NULLIF(b.nickname') < installs.BOT_NAME_SQL.indexOf('b.open_profile_name') &&
  /rs\.install_id IS NULL AND rs0\.runtime->'prof' IS NULL/.test(installs.BOT_NAME_SQL) && /LEFT JOIN room_state rs0 ON rs0\.install_id = r\.id/.test(installs.BOT_NAME_JOIN),
  'bot name shown to hosts: room record → (joined under v6, no prof) main nickname → open profile name → nickname');
d = D({ state: 'error', error_code: 'weird_code' });
assert(d.label === '오류 · 확인 필요' && !d.can_retry, 'unknown code');
assert(installs.retryGapMs(1) === 120000 && installs.retryGapMs(2) === 240000 && installs.retryGapMs(20) === 6 * 3600000, 'retryGapMs');

// RoomView 모양(3.4.2)
const v = installs.publicView(row({ state: 'waiting_host', perm: 2, joined_at: NOW - MIN, config_rev: 3 }),
  { nickname: 'K bot 3' }, ['minigame'], null, NOW);
const keysWant = ['id', 'link_url', 'link_name', 'products', 'pending_products', 'display', 'label', 'detail', 'error_code',
  'can_retry', 'retry_after', 'retry_admin_only', 'needs_passcode', 'bot', 'on_count', 'order', 'perm', 'joined_at', 'state_at', 'config_rev'];
keysWant.forEach((k) => assert(k in v, 'RoomView has ' + k));
assert(v.id === 12 && v.display === 'waiting' && v.bot.nickname === 'K bot 3' && v.pending_products.minigame === true &&
       v.pending_products.roombot === false && v.order === null && v.perm === 2 && v.config_rev === 3, 'RoomView values');
assert(JSON.stringify(v).indexOf('bot.0123456789abcdef') < 0, 'RoomView never exposes bot device_id');
const vp = installs.publicView(row({ phase: 'pending_payment', bot_device_id: null, roombot: false, minigame: false }), null,
  { roombot: true, minigame: true }, { id: 'ORD-261009-ABCDEF', url: '/order/ORD-261009-ABCDEF?t=x' }, NOW);
assert(vp.display === 'pending' && vp.order && vp.order.id === 'ORD-261009-ABCDEF' && vp.bot === null, 'pending RoomView order link');
const vn = installs.publicView(row({ state: 'error', error_code: 'passcode_wrong' }), null, null, null, NOW);
assert(vn.needs_passcode === true && vn.error_code === 'passcode_wrong' && vn.bot.nickname === 'K bot', 'needs_passcode + default bot name');
assert(installs.publicView(row({ state: 'active' }), null, null, null, NOW).error_code === null, 'error_code only in error state');

// 확인 대기 낱말(D28)
process.env.ROOM_HOLD_WORDS = '도박, 토토 ,';
assert(installs.holdWordFor('주말 토토 모임') === '토토' && installs.holdWordFor('동네모임') === null &&
       installs.holdWordFor('') === null, 'holdWordFor');
process.env.ROOM_HOLD_WORDS = '';
assert(installs.holdWordFor('도박방') === null, 'no hold words → never hold');

// 처음 켜지는 미니게임은 games 기본값(켜짐)으로 채운다(4.2)
let g = installs.withGamesDefault({ minigame: false, config: {} }, true);
assert(g.changed && g.config.games && g.config.games.enabled === true && g.config.games.cooldownSec === 3, 'games defaults filled');
g = installs.withGamesDefault({ minigame: true, config: {} }, true);
assert(!g.changed, 'already minigame → untouched');
g = installs.withGamesDefault({ minigame: false, config: { games: { enabled: false } } }, true);
assert(!g.changed && g.config.games.enabled === false, 'existing games config kept');

// ── 오류 문구 규칙(TONE) ────────────────────────────────────
const codes = Object.keys(installs.ERRORS);
['passcode_needed', 'passcode_wrong', 'room_full', 'kicked', 'left', 'profile_blocked', 'kakao_error', 'link_gone',
 'room_deleted', 'not_group', 'link_changed', 'duplicate_room', 'room_taken', 'blocked', 'bot_down', 'bot_no_open_profile']
  .forEach((c) => assert(codes.indexOf(c) >= 0, 'ERRORS has ' + c));
assert(codes.length === 16, 'ERRORS = 5.6 table (16 codes)');
const retryable = codes.filter((c) => installs.ERRORS[c].retry).sort().join(',');
assert(retryable === 'kakao_error,kicked,left,passcode_needed,passcode_wrong,profile_blocked,room_full', 'retry flags = 5.6: ' + retryable);
for (const c of codes) {
  const e = installs.ERRORS[c];
  assert(typeof e.short === 'string' && e.short && !/[.!?]$/.test(e.short), c + ': short is a noun label');
  assert(/(니다|주세요)\.$/.test(e.long), c + ': long ends with 합니다체 / ~해 주세요 + 마침표');
  assert(e.long.indexOf('십시오') < 0 && e.long.indexOf('K bot 계정') < 0 && e.short.indexOf('K bot 계정') < 0, c + ': no ~하십시오 / K bot 계정 (TONE)');
  assert(!/설치[가는를의]? ?(있|주인)|다른 설치|설치 불가 방/.test(e.long + ' ' + e.short), c + ': 설치 is not a noun for the record');
  assert(e.long.indexOf('실시간 상담') < 0 && e.short.indexOf('실시간 상담') < 0, c + ': no 실시간 상담');
  assert(!/[!~😀-🙏]/u.test(e.long), c + ': no exclamation/emoji');
  e.long.split(/(?<=\.)\s/).forEach((sent) => assert(/(니다|주세요)\.$/.test(sent.trim()), c + ': each sentence ends politely: ' + sent));
}
Object.keys(installs.TEXT).forEach((k) => assert(installs.TEXT[k].indexOf('실시간 상담') < 0, 'TEXT.' + k + ': no 실시간 상담'));
Object.keys(installs.TEXT).forEach((k) => assert(installs.TEXT[k].indexOf('십시오') < 0 && /[.]$/.test(installs.TEXT[k]), 'TEXT.' + k + ': ~해 주세요 + 마침표'));
assert(installs.LABELS.waiting === '부방장 지정 대기', 'waiting label names who waits for what');

// ── sender-child: 공개 프록시 없음 + onReady ───────────────
const sc = require('./sender-child');
assert(typeof sc.onReady === 'function', 'sender-child.onReady');
assert(!('proxy' in sc), 'sender-child: no proxy export');
const fakeApp = { use() { throw new Error('install must not mount anything'); } };
sc.install(fakeApp);   // 호환용 빈 함수: 아무 경로도 걸지 않는다
assert(require('fs').readFileSync(require('path').join(__dirname, 'sender-child.js'), 'utf8')
  .indexOf("'[sender] listening 127.0.0.1:'") >= 0, 'sender-child prints "[sender] listening 127.0.0.1:<port>"');
assert(/process\.once\('exit', stopChild\)/.test(require('fs').readFileSync(require('path').join(__dirname, 'sender-child.js'), 'utf8')),
  'sender-child stops the child when the parent exits');

// ── room_installs UPDATE: 한 문에서 같은 칸을 두 번 쓰지 않는다(PG: multiple assignments to same column) ──
{
  const src = require('fs').readFileSync(require('path').join(__dirname, 'installs.js'), 'utf8');
  const reenter = /const REENTER_SQL = `([^`]*)`/.exec(src);
  assert(reenter, 'installs REENTER_SQL');
  const full = src.replace(/(['`]) \+ REENTER_SQL \+ (['`])/g, reenter[1]);
  const colsOf = (set) => {
    const out = [];
    let depth = 0, cur = '';
    for (const ch of set) {
      if (ch === '(') depth++;
      if (ch === ')') depth--;
      if (ch === ',' && depth === 0) { out.push(cur); cur = ''; } else cur += ch;
    }
    out.push(cur);
    return out.map((x) => x.split('=')[0].trim()).filter(Boolean);
  };
  const re = /UPDATE room_installs SET ([\s\S]*?)\s+WHERE/g;
  let m, n = 0;
  while ((m = re.exec(full)) !== null) {
    n++;
    const cols = colsOf(m[1]);
    const dup = cols.filter((c, i) => cols.indexOf(c) !== i);
    assert(!dup.length, 'room_installs UPDATE assigns a column twice: ' + dup.join(',') + ' in "' + m[1].replace(/\s+/g, ' ').slice(0, 120) + '"');
  }
  assert(n >= 5, 'room_installs UPDATE statements scanned (' + n + ')');
}

// ── 감사 종류(8장 12번) ─────────────────────────────────────
const audit = require('./audit');
['member', 'member_lockout', 'install', 'bot', 'order'].forEach((k) => assert(audit.isKind(k), 'audit kind ' + k));

// ── db.shapeOrder 회원 칸 ──────────────────────────────────
const dbm = require('./db');
const so = dbm.shapeOrder({ id: 'ORD-1', created_at: '1', status: 'pending', features: 'macro,roombot', plan: 'member', amount: 35012,
  member_id: '7', kind: 'member', items: [{ product: 'macro', months: 1 }], applied: null });
assert(so.member_id === 7 && so.kind === 'member' && Array.isArray(so.items) && so.applied === null, 'shapeOrder member fields');
const so2 = dbm.shapeOrder({ id: 'ORD-2', created_at: '1', status: 'done', features: 'macro', plan: 'month', amount: 30012 });
assert(so2.member_id === null && so2.kind === null && so2.items === null, 'shapeOrder legacy order');

// ── 서버 문구 규칙(docs/TONE.md): routes/*.js · lib/*.js 의 화면에 나가는 문자열(주석 제외) ─────
{
  const fs = require('fs');
  const path = require('path');
  const files = ['routes/admin.js', 'routes/auth.js', 'routes/panel.js', 'routes/purchase.js']
    .concat(fs.readdirSync(__dirname).filter((f) => /\.js$/.test(f) && !/-check\.js$/.test(f)).map((f) => 'lib/' + f));
  for (const f of files) {
    const src = fs.readFileSync(path.join(__dirname, '..', f), 'utf8').split('\n')
      .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).map((l) => l.replace(/\s\/\/ .*$/, '')).join('\n');
    const strs = (src.match(/'(?:[^'\\\n]|\\.)*'/g) || []).filter((q) => /[가-힣]/.test(q)).join('\n');
    ['십시오', '콘솔', '카카오계정', '빈번', '존재하지 않는', '서브디바이스', '카카오 상태 ', '렌더링', '올킥 방지', '입장·퇴장 로그',
      '나갔을 때 내보내기', '주기 발송', '방 상품', '다른 설치', '설치의 주인'].forEach((w) => {
      assert(strs.indexOf(w) < 0, f + ': no "' + w + '" in user-facing strings');
    });
  }
}
assert(pricing.quote({ rooms: [{ products: [] }] }).error === '이 방에 설치할 봇을 1개 이상 골라 주세요.', 'no_products copy matches the buy page');
assert(installs.TEXT.taken.indexOf('다른 회원의 K bot') >= 0 && installs.TEXT.not_found === '링크가 만료되었거나 방이 삭제되었습니다.', 'preview copy');
// 오픈프로필·게시물 링크는 무엇이 틀렸는지 알려 준다(미리 보기·주문·관리자 링크 바꾸기 공통)
assert(installs.linkOf(G).ok && installs.linkOf(G).url === G, 'linkOf room');
assert(installs.linkOf('https://open.kakao.com/me/abc').reason === 'profile_link' && installs.linkOf('https://open.kakao.com/p/abc').reason === 'post_link' &&
  installs.linkOf('abc').reason === 'bad_link' && installs.linkOf('abc').status === 400, 'linkOf reasons');
{
  const appSrc = require('fs').readFileSync(require('path').join(__dirname, '..', 'public', 'app.js'), 'utf8');
  assert(appSrc.indexOf("var MSG_BAD_LINK = '" + installs.TEXT.bad_link + "';") >= 0, 'app.js MSG_BAD_LINK = server TEXT.bad_link');
  assert(/PV_HARD = \{[^}]*profile_link: 1, post_link: 1/.test(appSrc), 'app.js: profile/post link errors block the order');
}

process.stdout.write('purchase check ok\n');
