// 사이트 체험(/demo) 엔진 — docs/ACCOUNTS_V1.md 3.7. routes/demo.js 가 부른다.
//   catalog()             -> {first, groups}
//   start(scene, opts)    -> {ok:true, scene, state, out, clock} | {ok:false, status, reason, error}
//   step(state, ev)       -> {ok:true, state, out, clock}        | {ok:false, status, reason, error}
// clock 은 체험 시계(ms). 손님 글을 미리 그릴 때 시각으로 쓴다(매크로 30분 진행 뒤에는 실제 시각보다 앞선다).
// 장면 정보(scene): {id, group, title, desc, room:{name, count, kind:'open'|'dm', notice}, me:{id:'me', name, role},
//   members:[{id, name, role, av, gone?}], actions:[{id, label}], chips:[글], controls:[{key, label, value, options:[{v, label}]}],
//   buy:{href, label}}. members 에는 나중에 들어올 사람도 gone:true 로 미리 있다.
// 화면 항목(out, 차례대로 그린다 · wait = 앞 항목 뒤 기다릴 ms · at = 체험 시계):
//   {t:'day', at}                               날짜 줄
//   {t:'feed', text, at, wait, count}           카카오톡 시스템 줄(count = 이 줄 뒤 방 인원)
//   {t:'msg', id, from, text, at, wait, mention?} 말풍선. from = 사람 id | 'me' | 'kbot'. mention = {start, len}(반각 @ 부터)
//   {t:'msg', ..., img}                         K bot 의 그림 기록 카드(img = SVG data: 주소, text = 같은 내용의 글 안내 — 읽기 도구용)
//   {t:'hide', id, wait}                        그 글(손님 글은 cid)을 가린다
//   {t:'member', id, name?, gone?, wait}        이름 바꿈 · 들어옴(gone:false) · 나감·내보냄(gone:true)
//   {t:'panel', title, text, at, wait}          방 밖 패널 기록(올킥 감지)
//   {t:'hint', text, wait}                      휴대폰 아래 설명 한 줄(합니다체)
// 손님이 쓴 글(say)은 화면이 바로 그리므로 msg 로 돌려주지 않는다.
// 카카오톡 방 화면에서 미니게임봇·방 관리봇·카카오톡 매크로가 하는 일을 보여 준다.
// K bot(과 고객 계정)이 보내는 글은 전부 실제 봇 함수(sender/src/roomfeat.mjs · features.mjs)를
// 이 프로세스 안에서 불러 만든다. 여기서는 botpool.mjs·runner.mjs 가 하던 얇은 순서(이벤트 순서 ·
// 링 버퍼 · 멤버 명부 · 내보내기·가리기 흉내 · 간격)만 다시 짠다. 사람들의 대화·카카오톡 시스템 줄·
// 고객이 써 둔 예시 문구(매크로 글·자동 응답·저격 규칙)만 여기서 쓴다.
// 카카오톡에는 아무것도 보내지 않고 DB 도 쓰지 않는다. 상태 전체는 손님 브라우저가 들고 다니는 JSON 하나다.
'use strict';

const path = require('path');
const { pathToFileURL } = require('url');

const SENDER_SRC = path.join(__dirname, '..', 'sender', 'src');
let modsP = null;

// ESM 봇 모듈은 처음 쓸 때 한 번만 불러 둔다(실패하면 다음 요청이 다시 부른다).
function mods() {
  if (!modsP) {
    const load = (f) => import(pathToFileURL(path.join(SENDER_SRC, f)).href);
    modsP = Promise.all([load('roomfeat.mjs'), load('features.mjs'), load('roomcmd.mjs'), load('logcard.mjs')])
      .then((m) => ({ R: m[0], F: m[1], C: m[2], L: m[3] }));
    modsP.catch(() => { modsP = null; });
  }
  return modsP;
}

// ── 고정 값 ─────────────────────────────────────────────────────────────────
const MAX_STATE = 48 * 1024;          // 손님이 돌려보내는 상태 JSON 상한(바이트)
const MAX_TEXT = 1000;
const MAX_CID = 40;
const SEC = 1000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const MAX_GAP = 6 * HOUR;             // 단계 사이 실제 시간은 6시간까지만 센다
const CLOCK_LO = Date.UTC(2020, 0, 1);
const CLOCK_HI = Date.UTC(2100, 0, 1);
const RING_KEEP = 80;                 // 체험 링 버퍼(봇은 300). 상태를 작게 둔다
const SEEN_KEEP = 30;
const MAX_ITEMS = 300;                // 한 단계의 화면 항목 상한(정상은 글 가리기 80개 남짓이 가장 많다)
const TICK_MS = 20 * SEC;             // runner.mjs 매크로 점검 주기

// 화면 간격(ms). 실제 봇은 방 안내를 4초 간격으로, 답은 1초 안에 보낸다 → 체험에서는 줄인다.
const W_NPC = 300;
const W_BOT = 750;
const W_GAP = 900;
const W_FEED = 450;
const W_HIDE = 300;
const W_HINT = 400;
const W_DM = 1200;
const PLAY_SCALE = 150;               // 매크로 30분 진행: 가상 30분 → 화면 약 12초

const CHAT_ROOM = '9001';             // K bot 이 들어간 방
const CHAT_OPEN = '9002';             // 고객 계정이 들어간 오픈채팅
const CHAT_DM = '9003';               // 고객 계정의 갠톡
const BOT_ID = 'bot.00000000000000d1';
const KBOT = '1000';
const ME = '100';
const ME_NAME = '체험자';             // 봇 문구가 「{이름}님」을 붙인다 → '나님'이 되지 않게 이름을 쓴다
const SELLER = '3001';
const OPEN_KEY = '0\u0001중고 장터방';
const DM_KEY = '0\u0001' + ME_NAME;
const ROLE_PERM = { host: 1, sub: 4, member: 2 };
const ROLES = ['host', 'sub', 'member'];

const ERR_RESTART = '체험을 처음부터 다시 시작합니다.';
const ERR_SCENE = '체험 화면을 찾을 수 없습니다. 목록에서 다시 골라 주세요.';
const NOTICE = '체험용 방입니다. 실제 카카오톡에는 아무것도 보내지 않습니다.';
const PANEL_TITLE = 'K bot 패널 기록';

// 고객이 써 둔 예시 문구(봇 문구가 아니다)
const MACRO_MSG = '[공지] 매일 밤 9시 이벤트를 엽니다. 참여는 갠톡으로 주세요.';
const REPLY_MSG = '{이름}님, 문의 감사합니다. 확인하고 바로 답장 드릴게요.';
const SNIPE_REPLY = '{이름}님, 가격은 갠톡으로 문의 주세요.';
const BANNED = ['토토'];

// botpool.mjs 안에만 있는 방 답 문구(함수로 빠져 있지 않다). lib/demo-check.js 가 botpool.mjs 에 같은 글이 있는지 본다.
const POOL_TEXT = {
  hideStaff: '글 가리기는 방장과 부방장만 할 수 있어요.',
  hideBusy: '이미 글을 가리는 중이에요. 끝난 뒤 다시 입력해 주세요.',
  hideNone: '가릴 글이 없어요.',
  hideNoNameTail: '의 최근 글이 없어요.',
};

// 카카오톡이 방에 보이는 시스템 줄(features.mjs 피드 해석 · selfcheck 의 내보내기 줄과 같은 모양)
function joinedText(n) { return n + '님이 들어왔습니다.'; }
function leftText(n) { return n + '님이 나갔습니다.'; }
function kickedText(n) { return n + '님을 내보냈습니다.'; }

// 화면 설명(합니다체, docs/TONE.md)
const HINT = {
  macroSkip: '대화가 없어 이번 발송은 건너뜁니다.',
  replyCool: '같은 사람에게는 쿨타임(6시간) 동안 다시 답하지 않습니다.',
  snipeCool: '저격 규칙은 한 번 답한 뒤 60초 동안 다시 답하지 않습니다.',
  coverSilent: '금지어 검열은 방에 안내 없이 글만 가립니다.',
  leaveBan: '나간 사람을 내보내기 목록에 바로 올리지 못하면 K bot이 기록해 두었다가, 30일 안에 다시 들어올 때 바로 내보냅니다.',
  guardPanel: 'K bot은 방에 아무것도 올리지 않고 패널 기록에만 남깁니다.',
  guardHalt: 'K bot이 내보내기를 멈춘 10분 동안은 다시 기록하지 않습니다.',
  kickedGone: '내보낸 사람은 다시 들어올 수 없어 다른 손님으로 이어집니다.',
  noneLeft: '체험할 손님이 더 없습니다. [다시 시작]을 눌러 주세요.',
  nobodyToLeave: '나갈 손님이 없습니다. [손님 들어오기]를 먼저 눌러 주세요.',
  allInside: '손님이 모두 방에 있습니다. [손님 나가기]를 먼저 눌러 주세요.',
  leaveFirst: '먼저 [손님 나가기]를 눌러 주세요.',
  rejoinFirst: '먼저 [다시 들어오기]를 눌러 주세요.',
  paused: '내보내기·글 가리기가 3번 이어서 실패해 K bot이 10분 동안 내보내기와 글 가리기를 멈춥니다.',
};

// ── 사람 ────────────────────────────────────────────────────────────────────
// uid 는 봇 함수가 읽는 숫자 아이디. here:false 는 처음에 방 밖에 있는 사람.
function npc(uid, name, av, extra) {
  return Object.assign({ uid: uid, name: name, role: 'member', av: av, link: '', here: true }, extra || {});
}
function linkOf(id) { return 'https://open.kakao.com/o/' + id; }

const GUARD_VICTIMS = ['하늘', '바다', '별빛', '구름', '민트', '노을', '새벽', '은하', '소나무', '달빛']
  .map((n, i) => npc(String(2611 + i), n, 1 + (i % 5)));

// ── 장면 ────────────────────────────────────────────────────────────────────
// kind 'room' = K bot 이 들어간 방(봇 함수: roomfeat·features), 'acct' = 고객 계정(features onInbound·매크로).
const SCENES = {
  games: {
    group: 'game', title: '미니게임', kind: 'room',
    desc: () => '명령어를 누르거나 직접 입력하면 K bot이 실제 방에서와 똑같이 답합니다. 「!도움」을 입력하면 명령어 목록이 나옵니다.',
    room: { name: 'K bot 미니게임방', kind: 'open', extra: 21 },
    me: { role: 'member' },
    kbot: true,
    products: { roombot: false, minigame: true },
    config: () => ({}),
    npcs: [npc('2001', '하늘', 1), npc('2002', '바다', 2), npc('2003', '별빛', 3)],
    actions: [],
    chips: ['!도움', '!강화', '!출석', '!보스', '!공격', '!탐험', '!포획', '!레이드', '!도전', '!끝말잇기', '!숫자야구', '!퀴즈', '!주사위', '!가위바위보 가위', '!힌트', '!정답', '!포기', '!랭킹'],
    controls: [],
    seed: seedGames,
    act: {},
  },
  visit: {
    group: 'room', title: '입장·퇴장 기록', kind: 'room',
    desc: () => '[손님 들어오기]·[손님 나가기]를 누르면 K bot이 입장·퇴장 안내를 이미지로 올리고 그 사람을 멘션합니다. 이미지에는 오픈프로필 링크와 최근 기록이 나옵니다.',
    room: { name: 'K bot 체험방', kind: 'open', extra: 14 },
    me: { role: 'host' },
    kbot: true,
    products: { roombot: true, minigame: false },
    config: () => ({ visit: { enabled: true } }),
    npcs: [
      npc('2001', '하늘', 1, { link: linkOf('sDemo01') }),
      npc('2002', '바다', 2),
      npc('2101', '별빛', 3, { link: linkOf('sDemo02'), here: false }),
      npc('2102', '구름', 4, { here: false }),
      npc('2103', '민트', 5, { link: linkOf('sDemo03'), here: false }),
    ],
    // 누를 때마다 1분이 흐른다(안내 맨 아래 기록 시각이 한 분에 몰리지 않게)
    actions: [{ id: 'join', label: '손님 들어오기', advanceMs: MIN }, { id: 'leave', label: '손님 나가기', advanceMs: MIN }],
    chips: ['!옾링 하늘', '!설정', '!도움 관리'],
    controls: [],
    seed: (E) => { hist(E, '2001', '안녕하세요', 4 * MIN); hist(E, '2002', '반갑습니다', 3 * MIN); E.S.x = { j: 0, st: [] }; },
    act: { join: actVisitJoin, leave: actVisitLeave },
  },
  churn: {
    group: 'room', title: '들낙 감지', kind: 'room',
    desc: () => '[들어왔다 나가기]를 누를 때마다 같은 손님이 1분 머물다 나갑니다. 10분 안에 3번 들어오면 K bot이 들낙으로 감지합니다.',
    room: { name: 'K bot 체험방', kind: 'open', extra: 14 },
    me: { role: 'host' },
    kbot: true,
    products: { roombot: true, minigame: false },
    config: (o) => ({ churn: { enabled: true, action: o.action } }),
    npcs: [
      npc('2001', '하늘', 1), npc('2002', '바다', 2),
      npc('2201', '들락이', 3, { here: false }), npc('2202', '왔다감', 4, { here: false }), npc('2203', '스쳐감', 5, { here: false }),
    ],
    actions: [{ id: 'cycle', label: '들어왔다 나가기' }],
    chips: [],
    controls: [{ key: 'action', label: '조치', dflt: 'warn', options: [{ v: 'warn', label: '경고' }, { v: 'kick', label: '내보내기' }] }],
    seed: (E) => { hist(E, '2001', '오늘 모임 몇 시인가요?', 3 * MIN); E.S.x = { cur: '' }; },
    act: { cycle: actChurnCycle },
  },
  leavekick: {
    group: 'room', title: '나간 사람 재입장 차단', kind: 'room',
    desc: () => '[손님 나가기]를 누른 뒤 [다시 들어오기]를 누르면, 나갔던 사람을 K bot이 바로 내보냅니다. 나간 사람을 내보내기 목록에 바로 올리지 못한 경우의 동작이며, [재입장 차단] 안내는 설정에서 켠 경우에만 올립니다.',
    room: { name: 'K bot 체험방', kind: 'open', extra: 14 },
    me: { role: 'host' },
    kbot: true,
    products: { roombot: true, minigame: false },
    // 다시 들어온 사람의 [입장 안내] 를 함께 보이려고 입장·퇴장 기록도 켠다. 재입장 차단 안내도 켠다(기본은 꺼짐 — 설명에 적는다).
    config: () => ({ visit: { enabled: true }, leaveKick: { enabled: true, notice: true } }),
    npcs: [
      npc('2001', '하늘', 1, { link: linkOf('sDemo01') }), npc('2002', '바다', 2),
      npc('2003', '별빛', 3, { link: linkOf('sDemo02') }), npc('2004', '구름', 4),
    ],
    actions: [{ id: 'leave', label: '손님 나가기', advanceMs: MIN }, { id: 'rejoin', label: '다시 들어오기', advanceMs: MIN }],
    chips: [],
    controls: [],
    // 처음 [손님 나가기]는 하늘(맨 앞 사람)이다 → 나가겠다는 말도 하늘이 한다
    seed: (E) => { hist(E, '2001', '저는 이만 나가 볼게요', 2 * MIN); E.S.x = { left: [] }; },
    act: { leave: actLeaveKickLeave, rejoin: actLeaveKickRejoin },
  },
  profile: {
    group: 'room', title: '프로필 기록', kind: 'room',
    desc: () => '[닉네임 바꾸기]·[오픈프로필 바꾸기]를 누르면 K bot이 바뀐 내용을 이미지로 안내합니다. 「!프로필조회 닉네임」을 입력하면 지난 기록이 나옵니다.',
    room: { name: 'K bot 체험방', kind: 'open', extra: 14 },
    me: { role: 'host' },
    kbot: true,
    products: { roombot: true, minigame: false },
    config: () => ({ profile: { enabled: true, lookup: 'staff' } }),
    npcs: [npc('2001', '하늘', 1, { link: linkOf('sDemo01') }), npc('2002', '바다', 2)],
    actions: [{ id: 'rename', label: '닉네임 바꾸기', advanceMs: MIN }, { id: 'relink', label: '오픈프로필 바꾸기', advanceMs: MIN }],
    chips: ['!프로필조회 하늘', '!프로필조회 하늘_판매', '!옾링 하늘'],
    controls: [],
    seed: seedProfile,
    act: { rename: actRename, relink: actRelink },
  },
  promo: {
    group: 'room', title: '홍보 금지', kind: 'room',
    desc: (o) => '[홍보 링크 올리기]를 누르면 참여자가 링크를 올리고, K bot이 글을 가리고 경고합니다. 경고가 ' + o.kickAt + '회가 되면 내보냅니다.',
    room: { name: 'K bot 체험방', kind: 'open', extra: 14 },
    me: { role: 'host' },
    kbot: true,
    products: { roombot: true, minigame: false },
    config: (o) => ({ promo: { enabled: true, kickAt: Number(o.kickAt) } }),
    npcs: [
      npc('2001', '하늘', 1), npc('2301', '홍보맨', 2),
      npc('2302', '광고왕', 3, { here: false }), npc('2303', '할인정보', 4, { here: false }),
    ],
    actions: [{ id: 'post', label: '홍보 링크 올리기', advanceMs: 20 * SEC }],
    chips: [],
    controls: [{ key: 'kickAt', label: '내보내기 기준', dflt: '3', options: [{ v: '3', label: '3회' }, { v: '2', label: '2회' }] }],
    seed: (E) => { hist(E, '2001', '좋은 아침입니다', 3 * MIN); E.S.x = { p: 0, cur: '' }; },
    act: { post: actPromoPost },
  },
  cover: {
    group: 'room', title: '금지어 검열', kind: 'room',
    desc: () => '[욕설 쓰기]·[금지어 쓰기]를 누르거나 직접 입력하면 K bot이 그 글을 가립니다. 이 방의 금지어는 「토토」입니다.',
    room: { name: 'K bot 체험방', kind: 'open', extra: 14 },
    me: { role: 'member' },
    kbot: true,
    products: { roombot: true, minigame: false },
    config: () => ({ cover: { enabled: true, words: BANNED } }),
    npcs: [
      npc('101', '모임장', 0, { role: 'host' }), npc('2001', '하늘', 1),
      npc('2401', '불만러', 2), npc('2402', '정보통', 3),
    ],
    actions: [{ id: 'bad', label: '욕설 쓰기' }, { id: 'word', label: '금지어 쓰기' }],
    chips: ['토토 하실 분 계신가요', '안녕하세요'],
    controls: [],
    seed: (E) => { hist(E, '101', '서로 존중하는 대화 부탁드려요', 4 * MIN); hist(E, '2001', '네 알겠습니다', 3 * MIN); E.S.x = { b: 0, w: 0 }; },
    act: { bad: actCoverBad, word: actCoverWord },
  },
  hide: {
    group: 'room', title: '글 가리기', kind: 'room',
    desc: () => '방장·부방장은 「!가리기 5」로 최근 글 5개를, 「!가리기 @도배꾼」으로 한 사람의 글을 한 번에 가릴 수 있습니다. [도배하기]를 누르면 도배 글이 더 올라옵니다.',
    room: { name: 'K bot 체험방', kind: 'open', extra: 14 },
    me: { role: 'host' },
    kbot: true,
    products: { roombot: true, minigame: false },
    config: () => ({}),
    npcs: [npc('2001', '하늘', 1), npc('2002', '바다', 2), npc('2501', '도배꾼', 3)],
    actions: [{ id: 'spam', label: '도배하기' }],
    chips: ['!가리기 5', '!가리기 @도배꾼', '!내보내기 @도배꾼'],
    controls: [],
    seed: seedHide,
    act: { spam: actSpam },
  },
  guard: {
    group: 'room', title: '올킥 감지', kind: 'room',
    desc: () => '[여러 명 내보내기]를 누르면 다른 부방장이 짧은 시간에 5명을 내보냅니다. K bot은 이를 감지해 패널에 기록합니다.',
    room: { name: 'K bot 체험방', kind: 'open', extra: 4 },
    me: { role: 'host' },
    kbot: true,
    products: { roombot: true, minigame: false },
    config: () => ({ guard: { enabled: true } }),
    npcs: [npc('2601', '악성부방장', 0, { role: 'sub' })].concat(GUARD_VICTIMS),
    actions: [{ id: 'wave', label: '여러 명 내보내기' }],
    chips: [],
    controls: [],
    seed: (E) => { hist(E, '2611', '오늘도 좋은 하루 보내세요', 3 * MIN); hist(E, '2601', '방 정리 좀 할게요', MIN); E.S.x = {}; },
    act: { wave: actWave },
  },
  macro: {
    group: 'macro', title: '자동 발송', kind: 'acct',
    desc: () => '[30분 진행]을 누르면 30분 동안의 방을 빠르게 보여 줍니다. 판매왕(매크로를 쓰는 계정)이 정한 간격마다 글을 올리되, 그사이 다른 사람의 대화가 없으면 건너뜁니다.',
    room: { name: '중고 장터방', kind: 'open', extra: 37, chat: CHAT_OPEN, key: OPEN_KEY },
    me: { role: 'member' },
    kbot: false,
    npcs: [npc(SELLER, '판매왕', 0), npc('2001', '하늘', 1), npc('2002', '바다', 2), npc('2003', '별빛', 3)],
    actions: [{ id: 'play', label: '30분 진행' }],
    chips: ['안녕하세요', '이벤트는 언제 하나요?'],
    controls: [{ key: 'gap', label: '간격', dflt: '5', options: [{ v: '3', label: '3분' }, { v: '5', label: '5분' }, { v: '10', label: '10분' }] }],
    acct: (o) => ({
      accounts: [],
      macro: { enabled: true, message: MACRO_MSG, rooms: [OPEN_KEY], baseMin: Number(o.gap), randomMin: 0, minMessages: 1, sendImages: 'EVERY', images: [] },
    }),
    seed: seedMacro,
    say: sayMacro,
    act: { play: actMacroPlay },
  },
  reply: {
    group: 'macro', title: '갠톡 자동 응답', kind: 'acct',
    desc: () => '갠톡(1:1 대화)을 보내면 판매왕(매크로를 쓰는 계정)이 정해 둔 문구로 자동으로 답합니다. 같은 사람에게는 쿨타임(6시간) 동안 다시 답하지 않습니다.',
    room: { name: '판매왕', kind: 'dm', extra: 0, chat: CHAT_DM, key: DM_KEY },
    me: { role: 'member' },
    kbot: false,
    npcs: [npc(SELLER, '판매왕', 0)],
    actions: [],
    chips: ['안녕하세요, 거래 문의드립니다.', '배송은 얼마나 걸리나요?'],
    controls: [],
    acct: () => ({
      accounts: [],
      autoreply: { enabled: true, message: REPLY_MSG, scope: 'ALL', cooldownMs: 6 * HOUR, dailyLimit: 100, hourFrom: 0, hourTo: 24, firstOnly: false, delayMaxMs: 30000 },
    }),
    seed: (E) => { E.S.x = {}; },
    say: sayReply,
    act: {},
  },
  snipe: {
    group: 'macro', title: '저격 규칙', kind: 'acct',
    desc: () => '참여자가 「가격」이 들어간 글을 쓰면 판매왕(매크로를 쓰는 계정)이 정해 둔 답을 보냅니다. 한 번 답한 뒤 60초 동안은 다시 답하지 않습니다.',
    room: { name: '중고 장터방', kind: 'open', extra: 37, chat: CHAT_OPEN, key: OPEN_KEY },
    me: { role: 'member' },
    kbot: false,
    npcs: [npc(SELLER, '판매왕', 0), npc('2001', '하늘', 1), npc('2002', '바다', 2), npc('2003', '별빛', 3)],
    actions: [{ id: 'ask', label: '참여자가 가격 묻기' }],
    chips: ['가격이 얼마인가요?'],
    controls: [],
    acct: () => ({
      accounts: [],
      triggers: [{ id: 'demo-price', name: '가격 문의', enabled: true, mode: 'contains', pattern: '가격', reply: SNIPE_REPLY,
        cooldownMs: 60 * SEC, rooms: [], target: '', oncePerRoom: false, ignoreCase: true, fromMe: false, delayMs: 0 }],
    }),
    seed: (E) => { hist(E, '2001', '자전거 아직 있나요?', 2 * MIN); hist(E, SELLER, '네 아직 있어요', MIN); E.S.x = { a: 0 }; },
    say: saySnipe,
    act: { ask: actSnipeAsk },
  },
};

const GROUPS = [
  { id: 'game', title: '미니게임봇', desc: '방에서 끝말잇기·숫자야구·퀴즈 같은 게임을 엽니다.', product: 'minigame',
    buy: { href: '/buy?p=minigame', label: '미니게임봇 구매' }, scenes: ['games'] },
  { id: 'room', title: '방 관리봇', desc: 'K bot이 부방장으로 방을 지키고 기록합니다.', product: 'roombot',
    buy: { href: '/buy?p=roombot', label: '방 관리봇 구매' }, scenes: ['visit', 'churn', 'leavekick', 'profile', 'promo', 'cover', 'hide', 'guard'] },
  { id: 'macro', title: '카카오톡 매크로', desc: '내 카카오 계정으로 정해진 간격마다 자동 발송하고, 갠톡과 정해 둔 단어에 답합니다.', product: 'macro',
    buy: { href: '/buy?p=macro', label: '카카오톡 매크로 구매' }, scenes: ['macro', 'reply', 'snipe'] },
];
const GROUP_OF = {};
GROUPS.forEach((g) => g.scenes.forEach((id) => { GROUP_OF[id] = g; SCENES[id].id = id; }));

// ── 공통 도구 ───────────────────────────────────────────────────────────────
function isObj(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function has(o, k) {
  return Object.prototype.hasOwnProperty.call(o, k);
}

// KST 날짜(roomfeat 의 시각 함수처럼 +9시간 고정)
function dayKey(ms) {
  const t = new Date(Number(ms) + 9 * HOUR);
  return t.getUTCFullYear() + '-' + (t.getUTCMonth() + 1) + '-' + t.getUTCDate();
}

function bytes(v) {
  return Buffer.byteLength(JSON.stringify(v), 'utf8');
}

function fail(status, reason, error) {
  return { ok: false, status: status, reason: reason, error: error };
}

function badState() {
  return fail(400, 'bad_state', ERR_RESTART);
}

// 조절 칸 값은 글자·수만 읽는다(객체의 toString 은 부르지 않는다)
function normOpts(def, raw) {
  const src = isObj(raw) ? raw : {};
  const out = {};
  for (const c of def.controls) {
    const r = has(src, c.key) ? src[c.key] : null;
    const v = typeof r === 'string' || typeof r === 'number' ? String(r) : '';
    out[c.key] = c.options.some((o) => o.v === v) ? v : c.dflt;
  }
  return out;
}

// ── 화면 항목 ───────────────────────────────────────────────────────────────
function env(M, def, S, now) {
  return { R: M.R, F: M.F, C: M.C, L: M.L, def: def, S: S, now: now, items: [], maxAt: now, lastBot: false, view: null, ctx: null, vlast: 0 };
}

function fromId(uid) {
  const id = String(uid);
  return id === ME ? 'me' : id === KBOT ? 'kbot' : id;
}

// 명부의 한 사람. 손님이 돌려보낸 상태의 아이디로도 찾으므로 원형(__proto__ 등)은 보지 않는다.
function mem(E, uid) {
  return has(E.S.members, uid) ? E.S.members[uid] : null;
}

function nameOf(E, uid) {
  if (uid === ME) return ME_NAME;
  if (uid === KBOT) return 'K bot';
  const m = mem(E, uid);
  return m ? m.name : '';
}

// 날짜가 바뀌면(KST) 날짜 줄을 먼저 넣는다
function put(E, item) {
  if (item.t === 'day') {
    E.S.day = dayKey(item.at);
    E.items.push(item);
    return;
  }
  if (typeof item.at === 'number') {
    const dk = dayKey(item.at);
    if (dk !== E.S.day) {
      const day = { t: 'day', at: item.at };
      if (item.wait) {
        day.wait = item.wait;
        item.wait = 0;
      }
      E.items.push(day);
      E.S.day = dk;
    }
    if (item.at > E.maxAt) E.maxAt = item.at;
  }
  E.items.push(item);
  E.lastBot = item.t === 'msg' && (item.from === 'kbot' || item.from === SELLER);
}

function newLog(S) {
  S.seq += 1;
  return String(S.seq);
}

function present(E) {
  let n = E.def.room.extra + 1 + (E.def.kbot ? 1 : 0);
  for (const uid of Object.keys(E.S.members)) if (!E.S.members[uid].gone) n += 1;
  return n;
}

function feed(E, text, wait) {
  put(E, { t: 'feed', text: text, at: E.now, wait: wait, count: present(E) });
}

function memberItem(E, uid, extra) {
  put(E, Object.assign({ t: 'member', id: fromId(uid), wait: 0 }, extra));
}

function hint(E, text, wait) {
  put(E, { t: 'hint', text: text, wait: wait == null ? W_HINT : wait });
}

// 멘션은 실제 발송처럼 visitMentionExtra 가 만들어질 때만(아니면 평문으로 나간다). start 는 '@' 자리.
function mentionOf(E, text, mention) {
  if (!mention || !E.F.visitMentionExtra(text, mention)) return null;
  return { start: text.indexOf('@'), len: Number(mention.len) + 1 };
}

// 사람(또는 고객 계정)의 말풍선 1개. 봇의 반응은 부르는 쪽(npcSay · acctInbound)이 이어서 만든다.
function talk(E, uid, text, wait, at) {
  const logId = newLog(E.S);
  const when = at == null ? E.now : at;
  put(E, { t: 'msg', id: 'm' + logId, from: fromId(uid), text: text, at: when, wait: wait });
  return logId;
}

// 지난 대화(처음 화면). 봇은 반응하지 않는다.
function hist(E, uid, text, ago) {
  const at = E.now - ago;
  const logId = talk(E, uid, text, 0, at);
  if (E.def.products && E.def.products.roombot) ringAdd(E, { logId: logId, type: 1, authorId: uid, name: nameOf(E, uid), at: at, cmd: false, mid: 'm' + logId });
  if (E.def.id === 'macro' && uid !== SELLER) E.S.x.o = Math.min(30, (E.S.x.o || 0) + 1);
  return logId;
}

function botSay(E, text, mention, at, wait) {
  if (!text || !String(text).trim()) return;
  const logId = newLog(E.S);
  const item = { t: 'msg', id: 'm' + logId, from: 'kbot', text: String(text), at: at == null ? E.now : at, wait: wait == null ? (E.lastBot ? W_GAP : W_BOT) : wait };
  const mk = mentionOf(E, item.text, mention);
  if (mk) item.mention = mk;
  put(E, item);
}

// botpool sendAll: 방 안내의 delayMs(같은 방 4초 간격)는 화면 간격(W_GAP)으로 줄인다.
// 입장·퇴장·프로필 변경 안내는 방 설정(visit.style·profile.style, 기본 그림)대로 그림 카드 + 멘션 한 줄(botpool sayCard)
function sendAll(E, sends) {
  for (const s of sends || []) {
    if (s.card && cardStyle(E.view, s.kind) === 'image') botCard(E, s);
    else botSay(E, s.text, s.mention);
  }
}

function cardStyle(v, kind) {
  if (kind === 'visit') return v.cfg.visit.style;
  if (kind === 'profile') return v.cfg.profile.style;
  return 'text';
}

// 그림은 실제 봇과 같은 카드(logcard.mjs)를 SVG 로 그려 보낸다(실제 봇은 같은 SVG 를 PNG 로 바꿔 보낸다)
function botCard(E, s) {
  const svg = E.L.logCardSvg(s.card, { room: E.view.link_name });
  const logId = newLog(E.S);
  put(E, {
    t: 'msg', id: 'm' + logId, from: 'kbot', text: String(s.text), at: E.now, wait: E.lastBot ? W_GAP : W_BOT,
    img: 'data:image/svg+xml;base64,' + Buffer.from(svg, 'utf8').toString('base64'),
  });
  const line = E.R.cardMentionLine(s.card, s.mention && s.mention.userId);
  if (line) botSay(E, line.text, line.mention, null, W_NPC);
}

function ringAdd(E, item) {
  E.R.ringPush(E.S.ring, item);
  if (E.S.ring.length > RING_KEEP) E.S.ring.splice(0, E.S.ring.length - RING_KEEP);
}

// ── 방 보기(botpool 의 view) ────────────────────────────────────────────────
// K bot 권한: 방 관리봇이 있는 방은 부방장(4). 미니게임만 있는 방은 권한을 보지 않으므로(botpool applyPerm) 일반 참여자(2)로 둔다.
function kbotPerm(def) {
  return def.products && def.products.roombot ? 4 : 2;
}

// 방 설정 = 장면 설정 + 체험 중 방에서 명령어로 바꾼 것(S.cfg, botpool changeConfig 처럼 저장본에 합친다)
function roomView(E) {
  const base = E.def.config(E.S.opts);
  return {
    install_id: 1, chat_id: CHAT_ROOM, link_name: E.def.room.name, products: E.def.products,
    perm: kbotPerm(E.def), state: 'active', cfg: E.R.normRoomConfig(isObj(E.S.cfg) ? E.C.applyPatch(base, E.S.cfg) : base), runtime: E.S.runtime,
  };
}

function permOf(E, uid) {
  const id = String(uid || '');
  if (id === KBOT) return kbotPerm(E.def);
  if (id === ME) return ROLE_PERM[E.def.me.role];
  const m = mem(E, id);
  return m ? ROLE_PERM[m.role] : null;
}

// botpool ctxFor: 체험 방은 모든 사람의 권한을 안다(카드를 읽어 둔 상태)
function ctxOf(E) {
  return { selfId: KBOT, permOf: (uid) => permOf(E, uid) };
}

// 안내에 적을 옾링(botpool noticeLink): 주소 · 오픈프로필 아님('') · 모름(null)
function noticeLink(m) {
  if (m && m.link) return m.link;
  return m && (m.pli === '' || m.link === '') ? '' : null;
}

// ── 조치 흉내(botpool kick · hideOne · actionFailed) ────────────────────────
// 실패가 3번 이어지면 10분 동안 내보내기·가리기를 멈추고(lim.pause), 성공하면 연속 실패 수(lim.fs)를 0 으로 되돌린다.
// 멈춤·올킥 감지·한도로 건너뛰면 held. left: 이미 나간 사람 — 실패해도 연속 실패로 세지 않는다(botpool kick 과 같다).
function kick(E, uid, name, why, left) {
  const R = E.R;
  const S = E.S;
  const now = E.now;
  const id = String(uid || '');
  const mins = (at) => Math.max(1, Math.ceil((at - now) / MIN));
  if (!id || !R.roombotLive(E.view)) return { ok: false, skipped: true };
  if (S.lim.pause > now) return { ok: false, skipped: true, held: true, note: 'paused', waitMin: mins(S.lim.pause) };
  const g = S.runtime.guard;
  if (g && g.halt && Number(g.halt[CHAT_ROOM] || 0) > now) return { ok: false, skipped: true, held: true, why: why, note: 'wave', waitMin: mins(Number(g.halt[CHAT_ROOM])) };
  S.lim.k = S.lim.k.filter((t) => now - t < HOUR && t <= now);
  if (S.lim.k.length >= R.LIMITS.kickRoomHour) return { ok: false, skipped: true, held: true, note: 'limit', waitMin: mins(S.lim.k[0] + HOUR) };
  S.lim.k.push(now);
  const m = mem(E, id);
  // 이미 나간 사람은 카카오가 내보내기를 받지 않는다고 본다(실측 전, 7.2 (b) — 체험은 이 대체 길을 보인다)
  if (!m || m.gone) {
    if (!left) actionFailed(E);
    return { ok: false, status: -1 };
  }
  S.lim.fs = 0;
  m.gone = true;
  m.kicked = true;
  memberItem(E, id, { gone: true });
  feed(E, kickedText(m.name), W_FEED);
  kickFeed(E, KBOT, [id], true);
  return { ok: true };
}

function hideOne(E, logId, wait) {
  const S = E.S;
  const now = E.now;
  if (S.lim.pause > now) return { ok: false, skipped: true };
  S.lim.h = S.lim.h.filter((t) => now - t < 30 * MIN && t <= now);
  if (S.lim.h.length >= E.R.LIMITS.hideRoom30m) return { ok: false, skipped: true, limit: true };
  S.lim.h.push(now);
  S.lim.fs = 0;
  const m = S.ring.find((x) => x.logId === String(logId));
  if (m) m.hidden = true;
  put(E, { t: 'hide', id: m ? m.mid : 'm' + logId, wait: wait });
  return { ok: true };
}

// 체험의 K bot 은 권한을 잃지 않는다 → 연속 실패만 센다
function actionFailed(E) {
  const S = E.S;
  S.lim.fs = (Number(S.lim.fs) || 0) + 1;
  if (S.lim.fs >= 3) {
    S.lim.fs = 0;
    S.lim.pause = E.now + 10 * MIN;
    hint(E, HINT.paused);
  }
}

// 내보내기 피드(6): botpool onFeed 의 올킥 감지 경로. 봇 자신의 내보내기(own)는 세지 않는다.
function kickFeed(E, kicker, uids, own) {
  const R = E.R;
  const F = E.F;
  const v = E.view;
  if (!R.roombotLive(v) || !v.cfg.guard.enabled) return;
  const text = JSON.stringify({ feedType: 6, members: uids.map((u) => ({ userId: Number(u), nickName: nameOf(E, u) })) });
  const adapter = R.adapterRecord(v, BOT_ID);
  const g = F.guardOnChat(adapter, { kind: 'msg', chatId: v.chat_id, text: text, authorId: kicker, messageType: 0, mine: false, ownKick: own, now: E.now });
  if (g.askHalt) {
    const allowed = !!(Number(v.perm) & 5);
    const note = F.guardFinishHalt(adapter, v.chat_id, allowed, E.now, v.link_name || '대화방', g.askHalt.count, 'K bot');
    put(E, { t: 'panel', title: PANEL_TITLE, text: note, at: E.now, wait: W_GAP });
    E.recorded = true;
  }
  sendAll(E, g.sends);
}

// ── 입장·퇴장(botpool onFeed → onVisit) ─────────────────────────────────────
function npcVisit(E, uid, kind, wait) {
  const m = mem(E, uid);
  if (!m) return;
  m.gone = kind !== 'join';
  memberItem(E, uid, kind === 'join' ? { name: m.name, gone: false } : { gone: true });
  feed(E, kind === 'join' ? joinedText(m.name) : leftText(m.name), wait || W_NPC);
  if (!E.R.roombotLive(E.view)) return;
  // 카카오 피드 JSON(입장 4 · 퇴장 2)을 실제 해석 함수로 읽는다
  const raw = JSON.stringify({ feedType: kind === 'join' ? 4 : 2, members: [{ userId: Number(uid), nickName: m.name }] });
  const logId = newLog(E.S);
  for (const e of E.F.visitEventsFromMessage({ message: raw, message_type: 0, author_id: uid })) {
    if (e.authorId && e.authorId === KBOT) continue;
    onVisit(E, { kind: e.kind, userId: e.authorId || '', name: e.authorName || '', logId: logId, at: E.now });
  }
}

function onVisit(E, ev) {
  const R = E.R;
  const F = E.F;
  const S = E.S;
  const v = E.view;
  const cfg = v.cfg;
  const rt = S.runtime;
  const now = E.now;
  if (!isObj(rt.evSeen)) rt.evSeen = {};
  if (R.visitDedup(rt.evSeen, v.chat_id, ev, now)) return;
  const who = ev.userId ? mem(E, ev.userId) : null;
  // 들어온 사람은 카드(닉네임·오픈프로필)를 읽어 명부에 합친다 — 체험 명부는 늘 최신이다
  const card = ev.kind === 'join' && who && (cfg.visit.enabled || cfg.profile.enabled) ? { name: who.name } : null;
  const adapter = R.adapterRecord(v, BOT_ID);
  const g = F.guardOnChat(adapter, {
    kind: ev.kind, chatId: v.chat_id, authorId: ev.userId, authorName: (card && card.name) || ev.name || (who && who.name) || '',
    profileLink: noticeLink(who), mine: false, now: now, at: ev.at, logId: ev.logId,
  });
  sendAll(E, g.sends);
  const ctx = E.ctx;
  if (ev.kind === 'join') {
    // 재입장 차단을 끈 방이나 제외 대상·방장·부방장이 된 사람은 내보내지 않는다(botpool 과 같다)
    if (ev.userId && cfg.leaveKick.enabled && !R.protectedPerson(cfg, ctx, ev.userId) && R.bannedNow(rt, ev.userId, now)) {
      // 나간 뒤 내보내지 못한 사람이 다시 들어왔다: 지금은 방 안이라 내보낼 수 있다(7.2 (b))
      const name = ev.name || (rt.bans[ev.userId] && rt.bans[ev.userId].name) || '';
      const r = kick(E, ev.userId, name, 'leave');
      if (r.ok) {
        delete rt.bans[ev.userId];
        if (cfg.leaveKick.notice) botSay(E, R.leaveKickNotice(name, now));
      }
      return;
    }
    if (!isObj(rt.churn)) rt.churn = {};
    const plan = R.churnCheck(rt.churn, cfg, { kind: 'join', userId: ev.userId, name: (card && card.name) || ev.name, at: ev.at }, ctx, now);
    if (plan) doChurn(E, plan);
    return;
  }
  const lk = R.leaveKickPlan(cfg, ev, ctx);
  if (lk) doLeaveKick(E, lk);
}

function doChurn(E, plan) {
  let result = 'warn';
  if (plan.action === 'kick') result = kick(E, plan.userId, plan.name, 'churn').ok ? 'kicked' : 'kick_failed';
  E.churned = true;
  if (plan.notice) {
    const n = E.R.churnNotice(plan, result, E.now);
    botSay(E, n.text, n.mention);
  }
}

function doLeaveKick(E, plan) {
  if (plan.type === 'kick_fail') return;
  const r = kick(E, plan.userId, plan.name, 'leave', true);
  if (r.ok) {
    if (E.view.cfg.leaveKick.notice) botSay(E, E.R.leaveKickNotice(plan.name, E.now));
    return;
  }
  // 내보내지 못하면(받지 않음, 또는 멈춤·올킥 감지·한도로 건너뜀) 30일 안에 다시 들어오는 즉시 내보낸다
  if (!r.skipped || r.held) {
    E.R.noteBan(E.S.runtime, plan.userId, plan.name, E.now);
    E.banned = true;
  }
}

function doPromo(E, plan, m) {
  let hidden = false;
  let kicked = false;
  if (plan.hide && m.logId) hidden = !!hideOne(E, m.logId, W_BOT).ok;
  if (plan.kick) kicked = !!kick(E, plan.userId, plan.name, 'promo').ok;
  if (plan.notice) {
    const n = E.R.promoNotice(plan, { hidden: hidden, kicked: kicked }, E.now);
    botSay(E, n.text, n.mention);
  }
}

// ── 프로필(botpool noteName → refreshMember → mergeMembers → announceProfile) ──
// 명부(book)는 봇이 마지막으로 읽은 프로필이다. 바뀐 사람만 book 을 들고 있다가 다시 읽을 때 비교한다.
function noteName(E, uid, nick) {
  const m = mem(E, uid);
  if (!m || uid === KBOT || !nick) return;
  if (m.book && m.book.name !== nick) refreshMember(E, uid);
}

function refreshMember(E, uid) {
  const m = mem(E, uid);
  const prev = m && m.book;
  if (!prev) return;
  delete m.book;
  const next = { name: m.name, pli: m.pli, link: m.link };
  if (!(prev.name && next.name && prev.name !== next.name) && (prev.pli == null || prev.pli === next.pli)) return;
  // pli 가 같으면 옾링은 바뀐 것이 아니다 → 이전 옾링을 모름(null)으로 둔다
  const before = prev.pli === next.pli ? { name: prev.name, pli: prev.pli, link: null } : { name: prev.name, pli: prev.pli, link: prev.link };
  const after = { name: next.name, pli: next.pli, link: noticeLink(next) };
  if (!E.R.roombotLive(E.view) || !E.view.cfg.profile.enabled) return;
  sendAll(E, E.R.profileChange(E.S.runtime, CHAT_ROOM, E.view.cfg.profile, { userId: uid, before: before, after: after }, E.now));
}

// ── 메시지(botpool onMessage 순서: 링 → 닉네임 → 도움 → 가리기 → 프로필 → 홍보/금지어 → 올킥 → 게임) ──
function roomMessage(E, m) {
  const R = E.R;
  const F = E.F;
  const v = E.view;
  const cfg = v.cfg;
  const prefix = cfg.cmdPrefix;
  const text = m.text;
  const isCmd = text.trim().startsWith(prefix);
  if (v.products.roombot && m.logId) {
    ringAdd(E, { logId: m.logId, type: m.type, authorId: m.uid, name: m.name, at: E.now, cmd: isCmd && /가리기/.test(text), mid: m.mid });
  }
  const live = R.roombotLive(v);
  if (live && m.uid && m.name && (cfg.visit.enabled || cfg.profile.enabled)) noteName(E, m.uid, m.name);
  if (R.isHelpCommand(text, prefix)) {
    const line = R.helpLine(v);
    if (line) botSay(E, line);
    return;
  }
  if (live && cfg.hide.command) {
    const hc = R.parseHideCommand(text, prefix, []);
    if (hc) {
      hideCommand(E, m, hc);
      return;
    }
  }
  if (v.products.roombot && R.isAdminHelpCommand(text, prefix)) {
    const line = R.adminHelp(v);
    if (line) botSay(E, line);
    return;
  }
  // 방 관리 명령어(botpool roomCommand): 방장·부방장이 아닌 사람의 명령어 글도 홍보·금지어 검사를 받고, 게임으로는 넘기지 않는다
  const rc = v.products.roombot ? roomCommand(E, m, typedMentions(E, text)) : null;
  if (rc && rc.staff) return;
  const adapter = R.adapterRecord(v, BOT_ID);
  if (live) {
    let promo = null;
    const pev = { userId: m.uid, name: m.name, type: m.type, text: text, attachment: null };
    if (R.promoViolation(cfg, pev, E.ctx)) {
      if (!isObj(v.runtime.promo)) v.runtime.promo = {};
      promo = R.promoCheck(v.runtime.promo, cfg, pev, E.ctx, E.now);
    }
    if (promo) doPromo(E, promo, m);
    else {
      const coverEv = { chatId: v.chat_id, text: text, logId: m.logId, messageType: m.type, mine: false, staff: true };
      if (F.coverNeedsAuthor(adapter, coverEv)) coverEv.staff = F.coverSkipsLink(permOf(E, m.uid));
      const plan = F.coverPlan(adapter, coverEv);
      if (plan && hideOne(E, plan.logId, W_BOT).ok) E.covered = true;
    }
    const g = F.guardOnChat(adapter, { kind: 'msg', chatId: v.chat_id, text: text, authorId: m.uid, authorName: m.name, mine: false, messageType: m.type, now: E.now });
    sendAll(E, g.sends);
  }
  if (rc) return;
  if (R.gamesLive(v)) {
    // 체험에서는 미니게임 쿨타임을 0 으로 둔다(selfcheck 7.7 #13 과 같은 방법) — 답이 조용히 버려지지 않게
    adapter.config.minigame.cooldownMs = 0;
    // 체험 화면은 글만 그린다 — 검 강화·몬스터 수집 카드 그림(PNG)은 만들지 않는다(답 글은 실제 봇의 대체 글과 같다)
    adapter.config.minigame.images = false;
    const sends = F.onInbound(adapter, { chatId: v.chat_id, text: text, authorName: m.name, authorId: m.uid, mine: false });
    for (const s of sends) botSay(E, s.text);
  }
}

// 카카오톡에서 @ 를 치고 사람을 고르면 멘션이 된다 → 체험에서는 글 속 「@닉네임」이 방에 있는 사람이면 그 사람의 멘션으로 본다
function typedMentions(E, text) {
  const i = text.indexOf('@');
  if (i < 0) return [];
  const rest = text.slice(i + 1);
  let best = null;
  for (const uid of Object.keys(E.S.members)) {
    const m = E.S.members[uid];
    if (m.gone || !m.name || rest.indexOf(m.name) !== 0) continue;
    const after = rest.charAt(m.name.length);
    if (after && !/\s/.test(after)) continue;
    if (!best || m.name.length > best.n) best = { uid: uid, n: m.name.length };
  }
  return best ? [best.uid] : [];
}

// 체험 명부(botpool bookOf): 장면 사람 + 재입장 차단 목록. here = 지금 방에 있음
function bookOf(E) {
  return Object.keys(E.S.members).map((uid) => {
    const m = E.S.members[uid];
    return { userId: uid, name: m.name, link: noticeLink(m), here: !m.gone };
  });
}

// botpool roomCommand 와 같은 순서·같은 답(roomcmd.mjs). 체험의 K bot 은 늘 부방장이다.
// → null(방 관리 명령어 아님 · 꺼 둔 명령어) | {staff}
function roomCommand(E, m, mentions) {
  const R = E.R;
  const C = E.C;
  const v = E.view;
  const cfg = v.cfg;
  const c = C.parseRoomCommand(m.text, cfg.cmdPrefix);
  if (!c) return null;
  if (c.cmd === 'link' && cfg.cmd.link === 'off') return null;
  if (c.cmd === 'profile' && cfg.profile.lookup === 'off') return null;
  const staff = C.isStaff(permOf(E, m.uid));
  const answer = (t) => {
    if (t) botSay(E, t);
    return { staff: staff };
  };
  if (!R.roombotLive(v)) return { staff: staff };
  const p = cfg.cmdPrefix;
  const book = bookOf(E);
  if (c.cmd === 'link') {
    if (cfg.cmd.link === 'staff' && !staff) return answer(C.staffOnlyReply('link'));
    const who = C.findPerson(book, { mentions: mentions, arg: c.arg, allowName: true });
    if (!who.userId) return answer(who.usage ? C.usageOf('link', p) : C.findFailReply(who));
    const mm = mem(E, who.userId);
    return answer(mm ? C.linkReply({ name: mm.name, link: noticeLink(mm) }) : C.NOT_HERE_REPLY);
  }
  if (c.cmd === 'profile') {
    if (!cfg.profile.enabled) return answer(staff ? '프로필 기록이 꺼져 있어요. 「' + p + '프로필기록 켜기」로 켤 수 있어요.' : '');
    if (cfg.profile.lookup === 'staff' && !staff) return answer(C.staffOnlyReply('profile'));
    let target = null;
    if (mentions.length || C.isLinkArg(c.arg) || c.arg) {
      const who = C.findPerson(book, { mentions: mentions, arg: c.arg, allowName: !mentions.length && !C.isLinkArg(c.arg) });
      if (who.many) return answer(C.findFailReply(who));
      if ((mentions.length || C.isLinkArg(c.arg)) && !who.userId) return answer(who.usage ? C.usageOf('profile', p) : C.findFailReply(who));
      if (who.userId) target = { userId: who.userId, name: who.name };
    }
    return answer(R.profileLookup(v.runtime, v.chat_id, cfg, { authorId: m.uid, arg: c.arg, mentions: mentions, target: target }, E.ctx, E.now));
  }
  if (!staff) return answer(C.staffOnlyReply(c.cmd));
  if (c.cmd === 'kick') {
    const who = C.findPerson(book, { mentions: mentions, arg: c.arg, allowName: false });
    if (!who.userId) return answer(who.usage ? C.usageOf('kick', p) : C.findFailReply(who));
    const mm = mem(E, who.userId);
    if (who.userId === KBOT || (mm && !mm.gone && R.protectedPerson(cfg, E.ctx, who.userId))) return answer(C.PROTECTED_REPLY);
    if (!mm || mm.gone) return answer(C.NOT_HERE_REPLY);
    return answer(C.kickReply(mm.name, kick(E, who.userId, mm.name, 'command')));
  }
  if (c.cmd === 'unban') {
    const who = C.findPerson(book, { mentions: mentions, arg: c.arg, allowName: true });
    if (!who.userId) return answer(who.usage ? C.usageOf('unban', p) : C.findFailReply(who));
    const mm = mem(E, who.userId);
    const bans = isObj(E.S.runtime.bans) ? E.S.runtime.bans : {};
    if (!has(bans, who.userId) && !(mm && mm.kicked)) return answer(C.unbanReply(who.name, { ok: false, error: 'not_kicked' }));
    delete bans[who.userId];
    if (mm) mm.kicked = false;
    return answer(C.unbanReply(who.name, { ok: true }));
  }
  if (c.cmd === 'status') return answer(C.statusReply(cfg));
  const ch = C.configChange(cfg, c);
  if (!ch.patch) return answer(ch.reply);
  E.S.cfg = C.applyPatch(isObj(E.S.cfg) ? E.S.cfg : {}, ch.patch);
  E.view = roomView(E);
  return answer(ch.reply);
}

// botpool hideCommand → startHide → runHide(300ms 간격으로 하나씩 가린 뒤 끝 안내)
function hideCommand(E, m, hc) {
  const R = E.R;
  const S = E.S;
  const n = Number(permOf(E, m.uid));
  if (!(Number.isFinite(n) && ((n & 1) || (n & 4)))) {
    botSay(E, POOL_TEXT.hideStaff);
    return;
  }
  if (hc.usage) {
    botSay(E, R.hideUsage(E.view.cfg.cmdPrefix));
    return;
  }
  let req;
  if (hc.userId) req = { userId: hc.userId };
  else if (hc.name) {
    const ids = [...new Set(S.ring.filter((x) => x.name === hc.name && x.authorId).map((x) => x.authorId))];
    if (ids.length !== 1) {
      botSay(E, ids.length > 1 ? R.sameNameReply(ids.length) : '「' + hc.name + '」' + POOL_TEXT.hideNoNameTail);
      return;
    }
    req = { userId: ids[0] };
  } else req = { last: hc.last };
  if (Number(S.lim.hu || 0) > E.now) {
    botSay(E, POOL_TEXT.hideBusy);
    return;
  }
  const items = R.hidePlan(S.ring, req, E.ctx);
  let done = 0;
  let failed = 0;
  items.forEach((it, i) => {
    if (hideOne(E, it.logId, i ? W_HIDE : W_BOT).ok) done += 1;
    else failed += 1;
  });
  S.lim.hu = items.length > 1 ? E.now + (items.length - 1) * 300 : 0;
  if (items.length > 0) botSay(E, R.hideDoneNotice(done, failed), null, E.now, W_GAP);
  else botSay(E, POOL_TEXT.hideNone);
}

// 방 관리봇·미니게임 방의 사람 글 1개
function npcSay(E, uid, text, wait) {
  const logId = talk(E, uid, text, wait == null ? W_NPC : wait);
  roomMessage(E, { uid: uid, name: nameOf(E, uid), text: text, type: 1, logId: logId, mid: 'm' + logId });
  return logId;
}

// 손님(체험하는 사람)이 직접 쓴 글. 화면에는 이미 그려져 있으니 다시 보내지 않는다(cid 로 가린다).
function sayRoom(E, e) {
  if (!e.text) return;
  const logId = newLog(E.S);
  roomMessage(E, { uid: ME, name: ME_NAME, text: e.text, type: 1, logId: logId, mid: e.cid });
  if (E.covered && E.def.id === 'cover') {
    const cfg = E.R.adapterRecord(E.view, BOT_ID).config.cover;
    const why = E.F.isProfanity(e.text) ? '욕설' : E.F.hasCoverWord(cfg, e.text) ? '금지어' : '링크';
    hint(E, '보낸 글에 ' + why + E.R.josa(why, '이') + ' 있어 K bot이 가렸습니다. ' + HINT.coverSilent);
  }
}

// ── 장면별 동작 ─────────────────────────────────────────────────────────────
function seedGames(E) {
  const rt = E.S.runtime;
  // 랭킹이 비어 보이지 않게 방 사람들의 지난 점수를 넣어 둔다(점수 열쇠는 authorId, 7.3)
  rt.scores = { r: { '2001': 12, '2002': 7, '2003': 3 } };
  rt.names = { r: { '2001': '하늘', '2002': '바다', '2003': '별빛' } };
  const at = E.now - 3 * MIN;
  put(E, { t: 'feed', text: joinedText('K bot'), at: at, wait: 0, count: present(E) });
  botSay(E, E.R.joinNotice(E.view, 'K bot'), null, at, 0);
  hist(E, '2002', '오늘도 퀴즈 하실 분 계신가요?', MIN);
  E.S.x = {};
}

function seedHide(E) {
  hist(E, '2001', '안녕하세요', 6 * MIN);
  hist(E, '2002', '반가워요', 5 * MIN);
  for (let i = 0; i < 6; i++) hist(E, '2501', SPAM_TEXT, 3 * MIN - i * 10 * SEC);
  E.S.x = { s: 0 };
}

const SPAM_TEXT = '갠톡 주시면 최저가로 드려요';

function actSpam(E) {
  for (let i = 0; i < 3; i++) {
    npcSay(E, '2501', SPAM_TEXT, i ? 250 : W_NPC);
    E.now += 2 * SEC;
  }
  E.S.x.s = (Number(E.S.x.s) || 0) + 1;
}

function absent(E, uid) {
  const m = mem(E, uid);
  return !!m && m.gone && !m.kicked;
}

function inside(E, uid) {
  const m = mem(E, uid);
  return !!m && !m.gone;
}

// 입장·퇴장 기록: 들어올 손님은 차례로 돌고, 나갈 손님은 가장 최근에 들어온 사람
function actVisitJoin(E) {
  const x = E.S.x;
  const order = E.def.npcs.map((p) => p.uid);
  const start = Math.max(0, Number(x.j) || 0) % order.length;
  let pick = '';
  for (let i = 0; i < order.length; i++) {
    const uid = order[(start + i) % order.length];
    if (absent(E, uid)) {
      pick = uid;
      x.j = (start + i + 1) % order.length;
      break;
    }
  }
  if (!pick) {
    hint(E, HINT.allInside, 0);
    return;
  }
  x.st = (Array.isArray(x.st) ? x.st : []).filter((u) => u !== pick).concat([pick]).slice(-10);
  npcVisit(E, pick, 'join');
}

function actVisitLeave(E) {
  const x = E.S.x;
  const stack = (Array.isArray(x.st) ? x.st : []).filter((u) => inside(E, u));
  const pick = stack.length ? stack[stack.length - 1] : E.def.npcs.map((p) => p.uid).find((u) => inside(E, u));
  if (!pick) {
    hint(E, HINT.nobodyToLeave, 0);
    return;
  }
  x.st = stack.filter((u) => u !== pick);
  npcVisit(E, pick, 'leave');
}

// 들낙 감지: 같은 손님이 들어와 1분 머물다 나가고 1분 뒤 다음 순서
const CHURN_GUESTS = ['2201', '2202', '2203'];

function actChurnCycle(E) {
  const x = E.S.x;
  const uid = CHURN_GUESTS.find((u) => !E.S.members[u].kicked);
  if (!uid) {
    hint(E, HINT.noneLeft, 0);
    return;
  }
  if (x.cur && x.cur !== uid) hint(E, HINT.kickedGone, 0);
  x.cur = uid;
  if (inside(E, uid)) {
    npcVisit(E, uid, 'leave');
    E.now += MIN;
  }
  E.churned = false;
  npcVisit(E, uid, 'join');
  const acted = E.churned;
  E.now += MIN;
  if (inside(E, uid)) npcVisit(E, uid, 'leave', 1000);
  E.now += MIN;
  if (acted) return;
  const row = E.S.runtime.churn && E.S.runtime.churn.people && E.S.runtime.churn.people[uid];
  const cfg = E.view.cfg.churn;
  const n = row && Array.isArray(row.times) ? row.times.length : 0;
  if (row && row.actedAt && E.now - row.actedAt < cfg.windowMin * MIN) hint(E, '이미 알린 손님은 ' + cfg.windowMin + '분이 지나야 다시 알립니다.');
  else hint(E, cfg.windowMin + '분 동안 입장 ' + n + '회입니다. ' + cfg.joins + '회가 되면 K bot이 ' + (cfg.action === 'kick' ? '내보내고 알립니다.' : '알립니다.'));
}

// 나간 사람 재입장 차단: 한 번에 한 사람만 나간다(나감 → 다시 들어옴). 나간 사람의 내보내기 실패는
// botpool 처럼 연속 실패로 세지 않으므로, 체험에서는 연속 실패 멈춤(actionFailed · HINT.paused)이 나오지 않는다.
// 그 길은 botpool 과 모양을 맞추려고 남겨 두고, 문구는 lib/demo-check.js 가 따로 본다.
function leftWaiting(E) {
  return (Array.isArray(E.S.x.left) ? E.S.x.left : []).filter((u) => absent(E, u));
}

function actLeaveKickLeave(E) {
  const x = E.S.x;
  if (leftWaiting(E).length) {
    hint(E, HINT.rejoinFirst, 0);
    return;
  }
  const uid = E.def.npcs.map((p) => p.uid).find((u) => inside(E, u));
  if (!uid) {
    hint(E, HINT.noneLeft, 0);
    return;
  }
  E.banned = false;
  npcVisit(E, uid, 'leave');
  x.left = [uid];
  if (E.banned) hint(E, HINT.leaveBan);
}

function actLeaveKickRejoin(E) {
  const x = E.S.x;
  const list = leftWaiting(E);
  const uid = list[list.length - 1];
  if (!uid) {
    const someoneInside = E.def.npcs.some((p) => inside(E, p.uid));
    hint(E, someoneInside ? HINT.leaveFirst : HINT.noneLeft, 0);
    return;
  }
  x.left = list.filter((u) => u !== uid);
  npcVisit(E, uid, 'join');
}

// 프로필 기록: 하늘의 닉네임이 하늘 ↔ 하늘_판매 로, 오픈프로필이 sDemo01 ↔ sDemo04 로 번갈아 바뀐다
// 처음부터 「!프로필조회 하늘」에 기록이 나오게, 이틀 전 닉네임 변경(하늘이 → 하늘)을 실제 profileChange 로 남겨 둔다(그때 안내는 지난 일이라 그리지 않는다)
function seedProfile(E) {
  E.R.profileChange(E.S.runtime, CHAT_ROOM, E.view.cfg.profile, { userId: '2001', before: { name: '하늘이', link: null }, after: { name: '하늘', link: null } }, E.now - 2 * DAY);
  hist(E, '2001', '안녕하세요', 3 * MIN);
  E.S.x = { r: 0, l: 0 };
}

const RENAME = ['하늘_판매', '하늘'];
const RENAME_SAY = ['닉네임을 바꿨어요', '이름을 다시 바꿨어요'];

function actRename(E) {
  const x = E.S.x;
  const m = E.S.members['2001'];
  const i = (Number(x.r) || 0) % RENAME.length;
  if (!m.book) m.book = { name: m.name, pli: m.pli, link: m.link };
  m.name = RENAME[i];
  x.r = (Number(x.r) || 0) + 1;
  memberItem(E, '2001', { name: m.name });
  npcSay(E, '2001', RENAME_SAY[i]);
}

function actRelink(E) {
  const x = E.S.x;
  const m = E.S.members['2001'];
  const i = (Number(x.l) || 0) % 2;
  if (!m.book) m.book = { name: m.name, pli: m.pli, link: m.link };
  m.link = linkOf(i ? 'sDemo01' : 'sDemo04');
  m.pli = i ? 'p2001' : 'p2001b';
  x.l = (Number(x.l) || 0) + 1;
  // 오픈프로필 변경 푸시(SYNCLINKPF)·명부 동기화가 그 사람 카드를 다시 읽는다
  refreshMember(E, '2001');
}

// 홍보 금지: 내보내진 사람은 다시 못 들어오니 다음 사람이 들어와 올린다
const PROMOTERS = ['2301', '2302', '2303'];
const PROMO_TEXT = [
  '오늘만 특가 공동구매 모집합니다 https://open.kakao.com/o/gDemoAd1',
  '부업 정보방 들어오세요 https://open.kakao.com/o/gDemoAd2',
  '쿠폰 나눔 링크입니다 https://open.kakao.com/o/gDemoAd3',
];

function actPromoPost(E) {
  const x = E.S.x;
  const uid = PROMOTERS.find((u) => !E.S.members[u].kicked);
  if (!uid) {
    hint(E, HINT.noneLeft, 0);
    return;
  }
  if (x.cur && x.cur !== uid) hint(E, HINT.kickedGone, 0);
  x.cur = uid;
  let wait = W_NPC;
  if (!inside(E, uid)) {
    npcVisit(E, uid, 'join');
    E.now += 5 * SEC;
    wait = 800;
  }
  const n = Number(x.p) || 0;
  x.p = n + 1;
  npcSay(E, uid, PROMO_TEXT[n % PROMO_TEXT.length], wait);
}

// 금지어 검열: 방에는 아무것도 올리지 않는다
const BAD_TEXT = ['ㅅㅂ 왜 이렇게 느려요', '이 방 진짜 ㅈㄴ 조용하네요'];
const WORD_TEXT = ['토토 하실 분 갠톡 주세요', '토.토 정보 공유합니다'];

function actCoverBad(E) {
  const x = E.S.x;
  const n = Number(x.b) || 0;
  x.b = n + 1;
  E.covered = false;
  npcSay(E, '2401', BAD_TEXT[n % BAD_TEXT.length]);
  if (E.covered) hint(E, 'K bot이 욕설이 담긴 글을 가렸습니다. ' + HINT.coverSilent);
}

function actCoverWord(E) {
  const x = E.S.x;
  const n = Number(x.w) || 0;
  x.w = n + 1;
  E.covered = false;
  npcSay(E, '2402', WORD_TEXT[n % WORD_TEXT.length]);
  if (E.covered) hint(E, 'K bot이 금지어 「' + BANNED[0] + '」가 담긴 글을 가렸습니다. ' + HINT.coverSilent);
}

// 올킥 감지: 다른 부방장이 몇 초 사이에 5명을 내보낸다
function actWave(E) {
  const victims = GUARD_VICTIMS.map((p) => p.uid).filter((u) => inside(E, u)).slice(0, 5);
  if (!victims.length) {
    hint(E, '내보낼 사람이 더 없습니다. [다시 시작]을 눌러 주세요.', 0);
    return;
  }
  E.recorded = false;
  victims.forEach((uid, i) => {
    if (i) E.now += 1200;
    const m = E.S.members[uid];
    m.gone = true;
    m.kicked = true;
    memberItem(E, uid, { gone: true });
    feed(E, kickedText(m.name), i ? 350 : W_NPC);
    kickFeed(E, '2601', [uid], false);
  });
  hint(E, E.recorded ? HINT.guardPanel : HINT.guardHalt, W_GAP);
}

// ── 고객 계정(매크로·갠톡 자동 응답·저격 규칙) ───────────────────────────────
// 고객 계정 기록(v2 권리: 매크로 기간 안). runtime 은 체험 상태의 것을 그대로 쓴다.
function acctRecord(E) {
  const def = E.def;
  const dm = def.room.kind === 'dm';
  return {
    features: { v: 2, macro_until: Date.now() + DAY, legacy_room_until: 0 },
    config: def.acct(E.S.opts),
    rooms: [{ key: def.room.key, chat_id: def.room.chat, name: dm ? ME_NAME : def.room.name, kind: dm ? 'dm' : 'open' }],
    runtime: E.S.runtime,
  };
}

// runner onInbound 경로: 답이 있으면 고객 계정(판매왕)이 보낸다
function acctInbound(E, uid, text) {
  const sends = E.F.onInbound(acctRecord(E), { chatId: E.def.room.chat, text: text, authorName: nameOf(E, uid), mine: false });
  for (const s of sends) {
    talk(E, SELLER, s.text, E.def.room.kind === 'dm' ? W_DM : W_BOT);
  }
  return sends.length;
}

function sayReply(E, e) {
  if (!e.text) return;
  if (!acctInbound(E, ME, e.text)) hint(E, HINT.replyCool, W_GAP);
}

function saySnipe(E, e) {
  if (!e.text) return;
  if (!acctInbound(E, ME, e.text) && e.text.indexOf('가격') >= 0) hint(E, HINT.snipeCool, W_GAP);
}

const ASKERS = ['2002', '2003', '2001'];
const ASK_TEXT = ['이거 가격 얼마예요?', '자전거 가격 알려 주실 수 있나요?', '가격 조정 되나요?'];

function actSnipeAsk(E) {
  const x = E.S.x;
  const n = Number(x.a) || 0;
  x.a = n + 1;
  const uid = ASKERS[n % ASKERS.length];
  talk(E, uid, ASK_TEXT[n % ASK_TEXT.length], W_NPC);
  if (!acctInbound(E, uid, ASK_TEXT[n % ASK_TEXT.length])) hint(E, HINT.snipeCool, W_GAP);
}

// 매크로: runner macroTick(20초마다) — 때가 된 방(macroRoomsDue)에서, 내 마지막 글 뒤 다른 사람 글이
// minMessages 보다 적으면 건너뛰고(noteMacroWait) 아니면 보낸다(noteMacroSent).
function seedMacro(E) {
  E.S.x = { o: 0, t: E.now, t0: E.now };
  hist(E, '2001', '오늘 직거래 되시는 분 계신가요?', 4 * MIN);
  hist(E, '2003', '저 가능해요', 3 * MIN);
}

function tickAfter(x, at) {
  const k = Math.ceil((at - x.t0) / TICK_MS);
  return x.t0 + Math.max(1, k) * TICK_MS;
}

function macroRun(E, rec, until, mode) {
  const F = E.F;
  const x = E.S.x;
  for (let n = 0; n < 500; n++) {
    const due = Number((rec.runtime.roomDueAt || {})[OPEN_KEY] || 0);
    const t = tickAfter(x, Math.max(x.t + 1, due));
    if (t > until) break;
    x.t = t;
    if (!F.macroRoomsDue(rec, t).length) continue;
    if ((Number(x.o) || 0) < F.macroMinMessages(rec)) {
      F.noteMacroWait(rec, OPEN_KEY, t);
      mode.skip(t);
      continue;
    }
    mode.post(t);
    x.o = 0;
    F.noteMacroSent(rec, OPEN_KEY, t);
  }
}

function sayMacro(E, e) {
  if (!e.text) return;
  const x = E.S.x;
  const rec = acctRecord(E);
  const quiet = {
    skip: () => {},
    post: (t) => talk(E, SELLER, MACRO_MSG, W_DM, Math.max(t, E.now)),
  };
  macroRun(E, rec, E.now - 1, quiet);
  x.o = Math.min(30, (Number(x.o) || 0) + 1);
  macroRun(E, rec, E.now + TICK_MS, quiet);
}

// 30분 진행: 사람들의 대화(초 단위 시각)와 20초마다의 점검을 시각 순서대로 돌린다.
// 누를 때마다 다음 대화로 바꾼다(같은 대화가 30분 뒤 그대로 되풀이되지 않게). 시각은 모두 같다.
const PLAY_AT = [60, 130, 370, 790, 850, 1330, 1630];
const PLAY_SCRIPTS = [
  [['2001', '안녕하세요, 아이 옷 나눔 아직 되나요?'], ['2002', '네 아직 있어요. 갠톡 드릴게요.'], ['2003', '주말에 직거래 되시는 분 계신가요?'],
    ['2001', '자전거 사진 더 볼 수 있을까요?'], ['2002', '방금 올렸어요.'], ['2003', '자전거는 어느 동네에서 거래하시나요?'], ['2001', '저도 궁금해요.']],
  [['2002', '유모차도 혹시 있나요?'], ['2001', '지난주에 나갔어요.'], ['2003', '책상 의자 세트 올려 봅니다.'],
    ['2002', '의자 높이 조절 되나요?'], ['2003', '네 됩니다.'], ['2001', '이벤트는 몇 시에 시작하나요?'], ['2002', '밤 9시라고 공지에 있어요.']],
  [['2003', '전자레인지 나눔 받으실 분 계신가요?'], ['2002', '저요, 갠톡 드릴게요.'], ['2001', '택배 거래도 되나요?'],
    ['2003', '택배비만 내 주시면 됩니다.'], ['2001', '좋네요.'], ['2002', '오늘 올라온 물건 많네요.'], ['2003', '주말이라 그런가 봐요.']],
];

function actMacroPlay(E) {
  const x = E.S.x;
  const rec = acctRecord(E);
  const t0 = E.now;
  const end = t0 + 30 * MIN;
  let posts = 0;
  let skips = 0;
  // 지난 단계 뒤 흐른 시간의 점검은 조용히 먼저 돌린다(요약 횟수에 넣지 않는다)
  macroRun(E, rec, t0 - 1, { skip: () => {}, post: (t) => talk(E, SELLER, MACRO_MSG, 150, t) });
  E.vlast = t0;
  const vwait = (at) => {
    const w = Math.round((Math.max(at, E.vlast) - E.vlast) / PLAY_SCALE);
    E.vlast = Math.max(at, E.vlast);
    return Math.max(150, Math.min(2500, w));
  };
  const play = {
    skip: (t) => {
      skips += 1;
      hint(E, HINT.macroSkip, vwait(t));
    },
    post: (t) => {
      posts += 1;
      talk(E, SELLER, MACRO_MSG, vwait(t), t);
    },
  };
  const n = Math.max(0, Number(x.n) || 0);
  x.n = (n + 1) % PLAY_SCRIPTS.length;
  PLAY_SCRIPTS[n % PLAY_SCRIPTS.length].forEach((row, i) => {
    const at = t0 + PLAY_AT[i] * SEC;
    macroRun(E, rec, at - 1, play);
    talk(E, row[0], row[1], vwait(at), at);
    x.o = Math.min(30, (Number(x.o) || 0) + 1);
  });
  macroRun(E, rec, end, play);
  E.now = end;
  hint(E, '30분 동안 ' + posts + '회 보냈습니다.' + (skips ? ' 대화가 없던 ' + skips + '회는 건너뛰었습니다.' : ''), 600);
}

// ── 상태 ────────────────────────────────────────────────────────────────────
function initMembers(def) {
  const out = {};
  for (const p of def.npcs) {
    out[p.uid] = { name: p.name, role: p.role, av: p.av, link: p.link || '', pli: p.link ? 'p' + p.uid : '', gone: !p.here, kicked: false };
  }
  return out;
}

function sceneInfo(def, S) {
  const members = [];
  if (def.kbot) members.push({ id: 'kbot', name: 'K bot', role: kbotPerm(def) === 4 ? 'sub' : 'member', av: 0 });
  for (const p of def.npcs) {
    const m = S.members[p.uid];
    const row = { id: p.uid, name: m.name, role: m.role, av: m.av };
    if (m.gone) row.gone = true;
    members.push(row);
  }
  const roomCount = def.room.kind === 'dm' ? 2 : def.room.extra + 1 + (def.kbot ? 1 : 0) + def.npcs.filter((p) => !S.members[p.uid].gone).length;
  const g = GROUP_OF[def.id];
  return {
    id: def.id,
    group: def.group,
    title: def.title,
    desc: def.desc(S.opts),
    room: { name: def.room.name, count: roomCount, kind: def.room.kind, notice: def.room.kind === 'dm' ? '' : NOTICE },
    me: { id: 'me', name: ME_NAME, role: def.me.role },
    members: members,
    actions: def.actions.map((a) => ({ id: a.id, label: a.label })),
    chips: def.chips.slice(),
    controls: def.controls.map((c) => ({ key: c.key, label: c.label, value: S.opts[c.key], options: c.options.map((o) => ({ v: o.v, label: o.label })) })),
    buy: { href: g.buy.href, label: g.buy.label },
  };
}

// __proto__ 같은 열쇠가 섞인 상태는 받지 않는다(Object.assign 등에서 원형이 바뀌지 않게)
function cleanTree(v, depth) {
  if (depth > 12) return false;
  if (v === null || typeof v !== 'object') return typeof v !== 'function';
  if (Array.isArray(v)) return v.every((x) => cleanTree(x, depth + 1));
  for (const k of Object.keys(v)) {
    if (k === '__proto__' || k === 'constructor' || k === 'prototype') return false;
    if (!cleanTree(v[k], depth + 1)) return false;
  }
  return true;
}

function finite(n, lo, hi) {
  return typeof n === 'number' && Number.isFinite(n) && n >= lo && n <= hi;
}

function str(s, max) {
  return typeof s === 'string' && s.length <= max;
}

function nums(a, max) {
  return Array.isArray(a) && a.length <= max && a.every((t) => finite(t, 0, CLOCK_HI));
}

// 손님이 돌려보낸 상태를 검사한다. 틀리면 null(→ bad_state, 화면이 장면을 다시 시작한다).
function loadState(raw) {
  if (!isObj(raw)) return null;
  let json;
  try {
    json = JSON.stringify(raw);
  } catch (e) {
    return null;
  }
  if (!json || Buffer.byteLength(json, 'utf8') > MAX_STATE || !cleanTree(raw, 0)) return null;
  const S = JSON.parse(json);
  if (S.v !== 1 || typeof S.scene !== 'string' || !has(SCENES, S.scene)) return null;
  const def = SCENES[S.scene];
  if (!finite(S.clock, CLOCK_LO, CLOCK_HI) || !finite(S.real, CLOCK_LO, CLOCK_HI)) return null;
  if (!Number.isSafeInteger(S.seq) || S.seq < 1000 || S.seq > 1e12 || !str(S.day, 12)) return null;
  if (!isObj(S.members) || !isObj(S.runtime) || !isObj(S.x) || !Array.isArray(S.ring) || S.ring.length > RING_KEEP) return null;
  // 방에서 명령어로 바꾼 설정(roomCommand). 값은 normRoomConfig 가 다시 자른다
  if (S.cfg != null && (!isObj(S.cfg) || Object.keys(S.cfg).some((k) => !isObj(S.cfg[k])))) return null;
  if (!isObj(S.lim) || !nums(S.lim.k, 100) || !nums(S.lim.h, 400) || !finite(S.lim.hu, 0, CLOCK_HI)) return null;
  if (S.lim.fs == null) S.lim.fs = 0;
  if (S.lim.pause == null) S.lim.pause = 0;
  if (!Number.isInteger(S.lim.fs) || S.lim.fs < 0 || S.lim.fs > 2 || !finite(S.lim.pause, 0, CLOCK_HI)) return null;
  const uids = Object.keys(S.members);
  if (uids.length !== def.npcs.length || !def.npcs.every((p) => has(S.members, p.uid))) return null;
  for (const uid of uids) {
    const m = S.members[uid];
    if (!isObj(m) || !str(m.name, 40) || !m.name || ROLES.indexOf(m.role) < 0 || !Number.isInteger(m.av) || m.av < 0 || m.av > 5) return null;
    if (!str(m.link, 200) || !str(m.pli, 40) || typeof m.gone !== 'boolean' || typeof m.kicked !== 'boolean') return null;
    if (m.book != null && (!isObj(m.book) || !str(m.book.name, 40) || !str(m.book.pli, 40) || !str(m.book.link, 200))) return null;
  }
  // 장면별 카운터: 수 · 이 장면 사람의 아이디('' 포함) · 아이디 목록만(명부를 아이디로 찾으므로 다른 글은 받지 않는다)
  const npcIds = new Set(def.npcs.map((p) => p.uid));
  for (const k of Object.keys(S.x)) {
    const v = S.x[k];
    const ok = finite(v, -CLOCK_HI, CLOCK_HI) || v === '' || npcIds.has(v) || (Array.isArray(v) && v.length <= 20 && v.every((u) => npcIds.has(u)));
    if (!ok) return null;
  }
  // 매크로 점검 시각은 체험 시계에서 1시간 안(정상 상태는 간격 10분 남짓 뒤처질 뿐이다 — 오래된 시각으로 점검을 수백 번 돌리지 않게)
  if (def.id === 'macro' && !(finite(S.x.t, CLOCK_LO, CLOCK_HI) && finite(S.x.t0, CLOCK_LO, CLOCK_HI) && S.x.t >= S.x.t0 && S.x.t >= S.clock - HOUR)) return null;
  for (const r of S.ring) {
    if (!isObj(r) || typeof r.logId !== 'string' || !/^[1-9][0-9]{0,15}$/.test(r.logId) || !str(r.mid, MAX_CID) || !r.mid) return null;
    if (!str(r.authorId, 20) || !str(r.name, 40) || !finite(r.type, 0, 100) || !finite(r.at, 0, CLOCK_HI)) return null;
  }
  S.opts = normOpts(def, S.opts);
  return S;
}

// 다음 요청까지 들고 다닐 상태를 작게 둔다(실제 함수들의 상한보다 더 줄이는 곳만)
function prune(S) {
  const rt = S.runtime;
  const trimKeys = (o, n) => {
    if (!isObj(o)) return;
    const keys = Object.keys(o);
    for (let i = 0; i < keys.length - n; i++) delete o[keys[i]];
  };
  if (isObj(rt.evSeen)) {
    trimKeys(rt.evSeen.byLog, SEEN_KEEP);
    trimKeys(rt.evSeen.byWho, SEEN_KEEP);
  }
  if (isObj(rt.visit)) trimKeys(rt.visit.seen, SEEN_KEEP);
  if (S.ring.length > RING_KEEP) S.ring.splice(0, S.ring.length - RING_KEEP);
}

// ── 공개 함수 ───────────────────────────────────────────────────────────────
function catalog() {
  return {
    first: 'games',
    groups: GROUPS.map((g) => ({
      id: g.id, title: g.title, desc: g.desc, product: g.product,
      scenes: g.scenes.map((id) => ({ id: id, title: SCENES[id].title })),
    })),
  };
}

function bindRoom(E) {
  if (E.def.kind === 'room') {
    E.view = roomView(E);
    E.ctx = ctxOf(E);
  }
}

async function start(sceneId, opts) {
  if (typeof sceneId !== 'string' || !has(SCENES, sceneId)) return fail(400, 'bad_scene', ERR_SCENE);
  const M = await mods();
  const def = SCENES[sceneId];
  const now = Date.now();
  // 조절 칸 값을 읽지 못하면 기본값으로 연다
  let o;
  try {
    o = normOpts(def, opts);
  } catch (e) {
    o = normOpts(def, null);
  }
  const S = {
    v: 1, scene: sceneId, opts: o, clock: now, real: now, seq: 1000, day: '',
    members: initMembers(def), runtime: {}, ring: [], lim: { k: [], h: [], hu: 0, fs: 0, pause: 0 }, x: {},
  };
  const E = env(M, def, S, now);
  bindRoom(E);
  def.seed(E);
  if (!E.items.length) put(E, { t: 'day', at: now });
  if (E.items[0].t !== 'day') E.items.unshift({ t: 'day', at: E.items[0].at });
  S.clock = Math.max(now, E.maxAt);
  prune(S);
  return { ok: true, scene: sceneInfo(def, S), state: S, out: E.items, clock: S.clock };
}

function readEvent(ev, def) {
  if (!isObj(ev)) return null;
  if (ev.type === 'say') {
    if (typeof ev.text !== 'string' || typeof ev.cid !== 'string') return null;
    if (!ev.cid || ev.cid.length > MAX_CID || /[\u0000-\u001f\u007f]/.test(ev.cid)) return null;
    return { type: 'say', text: ev.text.trim().slice(0, MAX_TEXT).trim(), cid: ev.cid };
  }
  if (ev.type === 'act' && typeof ev.id === 'string') {
    const a = def.actions.find((x) => x.id === ev.id);
    return a ? { type: 'act', action: a } : null;
  }
  return null;
}

async function step(raw, ev) {
  const M = await mods();
  let S;
  let e;
  // 손님이 보낸 상태·이벤트는 어떤 모양이든 던지지 않고 bad_state 로 돌려준다
  try {
    S = loadState(raw);
    e = S ? readEvent(ev, SCENES[S.scene]) : null;
  } catch (err) {
    return badState();
  }
  if (!S || !e) return badState();
  const def = SCENES[S.scene];
  try {
    const realNow = Date.now();
    const gap = Math.max(0, Math.min(MAX_GAP, realNow - S.real));
    const adv = e.action && e.action.advanceMs ? e.action.advanceMs : 0;
    const E = env(M, def, S, S.clock + Math.max(gap, adv));
    bindRoom(E);
    if (e.type === 'say') (def.say || sayRoom)(E, e);
    else def.act[e.action.id](E);
    S.clock = Math.max(E.now, E.maxAt);
    S.real = realNow;
    prune(S);
    if (bytes(S) > MAX_STATE || E.items.length > MAX_ITEMS) return badState();
    return { ok: true, state: S, out: E.items, clock: S.clock };
  } catch (err) {
    console.error('[demo] ' + S.scene + ' 단계 처리 실패: ' + (err && err.message ? err.message : err));
    return badState();
  }
}

module.exports = {
  catalog,
  start,
  step,
  mods,
  MAX_STATE,
  ERR_RESTART,
  // lib/demo-check.js 가 같은 입력으로 실제 함수를 다시 불러 비교할 때 쓴다
  meta: {
    SCENE_IDS: Object.keys(SCENES), CHAT_ROOM, CHAT_OPEN, CHAT_DM, KBOT, ME, ME_NAME, SELLER, OPEN_KEY, DM_KEY,
    MACRO_MSG, REPLY_MSG, SNIPE_REPLY, BANNED, POOL_TEXT, NOTICE, PANEL_TITLE, PAUSED_HINT: HINT.paused,
    configOf: (id, opts) => SCENES[id].config ? SCENES[id].config(normOpts(SCENES[id], opts)) : null,
    acctOf: (id, opts) => SCENES[id].acct ? SCENES[id].acct(normOpts(SCENES[id], opts)) : null,
    productsOf: (id) => SCENES[id].products || null,
  },
};
