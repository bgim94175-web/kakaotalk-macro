// 사이트 체험 엔진 검사 (DB·HTTP 없이 lib/demo.js 를 바로 부른다). docs/ACCOUNTS_V1.md 3.7.
// 목록 모양 · 장면마다 모든 버튼과 명령어 · K bot(과 고객 계정)의 글 = 같은 입력으로 부른 실제 봇 함수의 결과 ·
// 멘션 위치 · 가리기 대상 · 틀린 상태 거절(던지지 않음) · 무작위 200단계 뒤 상태 48KB 미만 · 이모지·영문 없는 화면 문구.
// Math.random 은 씨앗 있는 난수로 바꿔 둔다(실패를 다시 볼 수 있게). 마지막 줄에 'demo check ok'.
'use strict';

const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const demo = require('./demo');
const rl = require('./ratelimit');

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

function seeded(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
Math.random = seeded(20261012);

const M = demo.meta;
const EMOJI = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u;
const ITEM_T = ['day', 'feed', 'msg', 'hide', 'member', 'panel', 'hint'];
const LABEL_BAN = ['데모', '해 보세요', '십시오', '강퇴', '로그', '옾링', '쿨다운'];

// 화면 문구(설명·버튼·힌트): 이모지·영문(K bot 제외)·금지 낱말 없음
function copyOk(s, where) {
  assert(typeof s === 'string' && s.length > 0, where + ': empty copy');
  assert(!EMOJI.test(s), where + ': emoji in ' + s);
  assert(!/[A-Za-z]/.test(s.replace(/K bot/g, '')), where + ': English on screen: ' + s);
  LABEL_BAN.forEach((w) => assert(s.indexOf(w) < 0, where + ': "' + w + '" in ' + s));
}

function bytes(v) {
  return Buffer.byteLength(JSON.stringify(v), 'utf8');
}

(async function main() {
  const src = path.join(__dirname, '..', 'sender', 'src');
  const R = await import(pathToFileURL(path.join(src, 'roomfeat.mjs')).href);
  const F = await import(pathToFileURL(path.join(src, 'features.mjs')).href);
  const Q = await import(pathToFileURL(path.join(src, 'quiz.mjs')).href);
  const botpool = fs.readFileSync(path.join(src, 'botpool.mjs'), 'utf8');

  // ── 레이트리밋: 새 'demo' 버킷 + 기존 버킷 그대로
  const kind = (m, p) => rl.kindOf({ method: m, path: p });
  assert(kind('GET', '/api/demo') === 'demo' && kind('POST', '/api/demo/start') === 'demo' && kind('POST', '/API/Demo/Step/') === 'demo', 'demo bucket');
  assert(kind('GET', '/api/demos') === false && kind('GET', '/demo') === false, 'demo bucket is only /api/demo*');
  assert(rl.maxFor('demo') === 180, 'RATE_DEMO_PER_MIN default 180');
  assert(kind('GET', '/api/order/ORD-1') === 'order-read' && kind('POST', '/api/auth/login') === 'auth' && kind('GET', '/panel/api/x') === 'panel', 'other buckets kept');

  // ── botpool 에만 있는 문구를 그대로 옮겼는가
  ['hideStaff', 'hideBusy', 'hideNone'].forEach((k) => assert(botpool.indexOf("'" + M.POOL_TEXT[k] + "'") >= 0, 'botpool text ' + k));
  assert(botpool.indexOf('」' + M.POOL_TEXT.hideNoNameTail + '`') >= 0, 'botpool text hideNoName');
  // 화면의 카카오톡 시스템 줄은 봇이 읽는 모양과 같다(입장·퇴장 해석, 내보내기 세기)
  const ev1 = F.visitEventsFromMessage({ message: '하늘님이 들어왔습니다.' });
  const ev2 = F.visitEventsFromMessage({ message: '하늘님이 나갔습니다.' });
  assert(ev1.length === 1 && ev1[0].kind === 'join' && ev1[0].authorName === '하늘' && ev2[0].kind === 'leave', 'join/leave lines parse');

  // ── 목록
  const cat = demo.catalog();
  assert(cat.first === 'games' && Array.isArray(cat.groups) && cat.groups.length === 3, 'catalog groups');
  const ids = [];
  cat.groups.forEach((g) => {
    assert(typeof g.id === 'string' && ['minigame', 'roombot', 'macro'].indexOf(g.product) >= 0, 'group ' + g.id);
    copyOk(g.title, 'group title');
    copyOk(g.desc, 'group desc');
    g.scenes.forEach((s) => { copyOk(s.title, 'scene title'); ids.push(s.id); });
  });
  assert(ids.join(',') === 'games,visit,churn,leavekick,profile,promo,cover,hide,guard,macro,reply,snipe', 'scene ids ' + ids.join(','));

  // ── 한 장면 세션: 단계마다 항목 모양·멘션·가리기 대상·이모지·상태 크기를 본다
  async function session(id, opts) {
    const r = await demo.start(id, opts);
    assert(r.ok, 'start ' + id + ' ' + JSON.stringify(r));
    const info = r.scene;
    const known = new Set();
    const froms = new Set(['me', 'kbot'].concat(info.members.map((m) => m.id)));
    const s = { id: id, info: info, state: r.state, known: known, all: [], n: 0 };
    s.check = (out) => {
      let lastAt = 0;
      out.forEach((it) => {
        assert(ITEM_T.indexOf(it.t) >= 0, id + ': item type ' + it.t);
        if (it.wait != null) assert(Number.isInteger(it.wait) && it.wait >= 0 && it.wait <= 3000, id + ': wait ' + it.wait);
        if (it.at != null) {
          assert(Number.isFinite(it.at), id + ': at');
          assert(it.at >= lastAt, id + ': time goes back ' + JSON.stringify(it));
          lastAt = it.at;
        }
        if (it.text != null) assert(!EMOJI.test(it.text), id + ': emoji in item ' + it.text);
        if (it.t === 'msg') {
          assert(typeof it.id === 'string' && froms.has(it.from) && it.text && Number.isFinite(it.at), id + ': msg shape ' + JSON.stringify(it));
          known.add(it.id);
          if (it.mention) {
            const at = it.mention.start;
            assert(it.text.charAt(at) === '@' && it.text.indexOf('@', at + 1) < 0 && it.text.indexOf('@') === at, id + ': mention @ ' + JSON.stringify(it));
            assert(it.mention.len >= 2 && at + it.mention.len <= it.text.length, id + ': mention len');
            const after = it.text.charAt(at + it.mention.len);
            assert(!after || after === '\n', id + ': mention ends at the name');
          }
        }
        if (it.t === 'hide') assert(known.has(it.id), id + ': hide of unknown message ' + it.id);
        if (it.t === 'feed') assert(it.text && Number.isInteger(it.count) && it.count > 0, id + ': feed');
        if (it.t === 'member') assert(froms.has(it.id), id + ': member id ' + it.id);
        if (it.t === 'hint') copyOk(it.text, id + ' hint');
        if (it.t === 'panel') assert(it.title && it.text && it.at, id + ': panel');
        s.all.push(it);
      });
    };
    s.check(r.out);
    s.start = r.out;
    s.step = async (ev) => {
      if (ev.type === 'say') known.add(ev.cid);
      const x = await demo.step(s.state, ev);
      assert(x.ok, id + ': step ' + JSON.stringify(ev) + ' → ' + JSON.stringify(x));
      assert(bytes(x.state) < demo.MAX_STATE, id + ': state too big ' + bytes(x.state));
      assert(typeof x.clock === 'number' && x.clock === x.state.clock, id + ': clock');
      s.check(x.out);
      s.state = x.state;
      return x.out;
    };
    s.act = (a) => s.step({ type: 'act', id: a });
    s.say = (text) => s.step({ type: 'say', text: text, cid: 'c' + (++s.n) });
    return s;
  }
  const bots = (out) => out.filter((i) => i.t === 'msg' && i.from === 'kbot');
  const one = (out, what) => {
    const b = bots(out);
    assert(b.length === 1, what + ': want one K bot message, got ' + JSON.stringify(out));
    return b[0];
  };
  const viewOf = (id, opts, rt) => ({
    chat_id: M.CHAT_ROOM, link_name: '', products: M.productsOf(id), perm: M.productsOf(id).roombot ? 4 : 2, state: 'active',
    cfg: R.normRoomConfig(M.configOf(id, opts || {})), runtime: rt || {},
  });
  const ctx = (id) => ({ selfId: M.KBOT, permOf: (u) => (u === M.ME ? (id === 'cover' || id === 'games' ? 2 : 1) : u === M.KBOT ? 4 : 2) });
  const mentionOf = (n) => (n.mention ? { start: n.mention.at - 1, len: n.mention.len + 1 } : undefined);
  const key = (uid) => M.CHAT_ROOM + '\u0001' + uid;

  // ── 장면 정보 모양
  for (const id of ids) {
    const s = await session(id);
    const i = s.info;
    assert(i.id === id && typeof i.group === 'string', id + ': info id');
    copyOk(i.title, id + ' title');
    copyOk(i.desc, id + ' desc');
    assert(/[.]$/.test(i.desc) && i.desc.split('. ').length <= 3, id + ': desc is 1–2 sentences');
    assert(i.room && i.room.name && Number.isInteger(i.room.count) && ['open', 'dm'].indexOf(i.room.kind) >= 0 && typeof i.room.notice === 'string', id + ': room');
    if (i.room.kind === 'open') copyOk(i.room.notice, id + ' notice');
    assert(i.me.id === 'me' && i.me.name && ['host', 'sub', 'member'].indexOf(i.me.role) >= 0, id + ': me');
    i.members.forEach((m) => assert(m.id && m.name && ['host', 'sub', 'member', 'bot'].indexOf(m.role) >= 0 && m.av >= 0 && m.av <= 5, id + ': member'));
    i.actions.forEach((a) => { copyOk(a.label, id + ' action'); assert(a.label.length >= 2 && a.label.length <= 10, id + ': label 2–10 chars ' + a.label); });
    i.chips.forEach((c) => assert(typeof c === 'string' && c && !EMOJI.test(c), id + ': chip'));
    i.controls.forEach((c) => {
      copyOk(c.label, id + ' control');
      assert(c.options.some((o) => o.v === c.value), id + ': control value');
      c.options.forEach((o) => copyOk(o.label, id + ' option'));
    });
    assert(i.buy && /^\/buy\?p=(minigame|roombot|macro)$/.test(i.buy.href), id + ': buy');
    assert(s.start[0].t === 'day', id + ': starts with the date');
    assert(bytes(s.state) < demo.MAX_STATE, id + ': start state size');
    // K bot 은 방 관리봇 방에서만 부방장(미니게임만 있는 방은 권한을 보지 않는다)
    const kb = i.members.find((m) => m.id === 'kbot');
    if (kb) assert(kb.role === (M.productsOf(id).roombot ? 'sub' : 'member'), id + ': K bot role ' + kb.role);
    // 방 관리봇 장면은 !가리기 명령이 기본값(켜짐)이라 !도움 에 답한다
    if (M.productsOf(id) && M.productsOf(id).roombot) {
      const h = bots(await s.say('!도움'));
      assert(h.length === 1 && h[0].text === R.helpLine(viewOf(id, s.state.opts)) && h[0].text.indexOf('방 관리 : !가리기') > 0, id + ': help answers ' + JSON.stringify(h));
    }
  }
  const ch = await demo.start('churn', { action: 'zzz', extra: 1 });
  assert(ch.scene.controls[0].value === 'warn' && Object.keys(ch.state.opts).join() === 'action', 'unknown opts fall back to defaults');

  // ── 미니게임: helpLine · joinNotice · onInbound 문구
  {
    const s = await session('games');
    const v = viewOf('games');
    assert(bots(s.start)[0].text === R.joinNotice(v, 'K bot'), 'games: join notice');
    assert(one(await s.say('!도움'), 'help').text === R.helpLine(v) && R.helpLine(v).indexOf('방 관리') < 0, 'games: help = helpLine, no room line');
    assert(one(await s.say('!랭킹'), 'rank').text === '[랭킹]\n1. 하늘 12점\n2. 바다 7점\n3. 별빛 3점', 'games: seeded ranking');
    assert(/^체험자님 6면 주사위 결과 → [1-6]$/.test(one(await s.say('!주사위'), 'dice').text), 'games: dice');
    assert(/^봇 : (가위|바위|보) \/ 체험자님 : 가위 → (무승부|봇 승리|체험자님 승리 \(\+1점, 누적 \d+점\))$/.test(one(await s.say('!가위바위보 가위'), 'rps').text), 'games: rps');
    const st = one(await s.say('!끝말잇기'), 'word').text;
    assert(/^끝말잇기를 시작해요\. 첫 단어는 「[가-힣]+」(예요|이에요)\.\n'[^']+'(로|으로) 시작하는 단어를 30초 안에 입력해 주세요\. \(그만하기 : !포기\)$/.test(st), 'games: word start ' + st);
    const w = s.state.runtime.games.r.word;
    assert(st.indexOf('「' + w + '」') > 0, 'games: word start is the state word');
    assert(one(await s.say('!정답'), 'reveal').text === '지금 이을 단어는 「' + w + '」' + R.josa(w, '이에요') + '.', 'games: word reveal');
    assert(one(await s.say('!숫자야구'), 'busy').text === '다른 게임이 진행 중이에요. 「!포기」로 끝낸 뒤 시작해 주세요.', 'games: busy');
    assert(one(await s.say('!포기'), 'quit').text === '게임을 끝냈어요. 마지막 단어는 「' + w + '」' + R.josa(w, '이었어요') + '.', 'games: give up');
    assert(one(await s.say('!포기'), 'none').text === '진행 중인 게임이 없어요.', 'games: nothing to give up');
    one(await s.say('!퀴즈'), 'quiz');
    const qi = s.state.runtime.games.r.quiz;
    assert(one(await s.say('!힌트'), 'hint').text === '힌트 : ' + Q.hint(qi), 'games: quiz hint');
    const ans = one(await s.say(Q.answer(qi)), 'answer').text;
    const total = s.state.runtime.scores.r[M.ME];
    assert(ans === '정답이에요. 「' + Q.answer(qi) + '」 · 체험자님 +2점 (누적 ' + total + '점)\n다음 문제 : !퀴즈', 'games: quiz answer ' + ans);
    one(await s.say('!숫자야구'), 'baseball');
    const secret = s.state.runtime.games.r.secret;
    assert(one(await s.say(secret), 'win').text.indexOf('정답이에요. ' + secret + ' (1번 만에) · 체험자님 +5점') === 0, 'games: baseball win');
    assert((await s.say('안녕하세요')).length === 0, 'games: chatter gets no answer');
  }

  // ── 입장·퇴장 기록: visitNoticeText(같은 사람·같은 기록 시각)
  {
    const s = await session('visit');
    for (const a of ['join', 'join', 'leave', 'join', 'leave', 'leave']) {
      const out = await s.act(a);
      const mem = out.find((i) => i.t === 'member');
      const b = one(out, 'visit ' + a);
      const uid = mem.id;
      const m = s.state.members[uid];
      const row = s.state.runtime.visit.people[key(uid)];
      const want = R.visitNoticeText(a === 'join' ? 'join' : 'leave', { userId: uid, name: m.name, link: m.link }, a === 'join' ? row.joins : row.leaves);
      assert(b.text === want.text, 'visit: notice = visitNoticeText ' + b.text);
      assert(JSON.stringify(b.mention) === JSON.stringify(mentionOf(want)), 'visit: mention offsets');
      assert(out.some((i) => i.t === 'feed' && i.text === m.name + (a === 'join' ? '님이 들어왔습니다.' : '님이 나갔습니다.')), 'visit: feed line');
    }
  }

  // ── 들낙 감지: churnNotice(경고 · 내보내기)
  for (const action of ['warn', 'kick']) {
    const s = await session('churn', { action: action });
    const c1 = await s.act('cycle');
    assert(bots(c1).length === 0 && bots(await s.act('cycle')).length === 0, 'churn: first two joins are quiet');
    const h1 = c1.filter((i) => i.t === 'hint').map((i) => i.text).join();
    assert(h1 === '10분 동안 입장 1회입니다. 3회가 되면 K bot이 ' + (action === 'kick' ? '내보내고 알립니다.' : '알립니다.'), 'churn: progress hint ' + h1);
    const out = await s.act('cycle');
    const b = one(out, 'churn third');
    const want = R.churnNotice({ userId: '2201', name: '들락이', count: 3, windowMin: 10 }, action === 'kick' ? 'kicked' : 'warn', b.at);
    assert(b.text === want.text && JSON.stringify(b.mention) === JSON.stringify(mentionOf(want)), 'churn: notice ' + action + ' ' + b.text);
    assert(out.some((i) => i.t === 'feed' && i.text === '들락이님을 내보냈습니다.') === (action === 'kick'), 'churn: kick feed only when kicking');
    const next = await s.act('cycle');
    assert(bots(next).length === 0, 'churn: same window is quiet');
    if (action === 'kick') assert(next.some((i) => i.t === 'member' && i.id === '2202'), 'churn: a kicked guest does not come back');
  }

  // ── 나간 사람 재입장 차단: 퇴장 → noteBan, 다시 들어옴 → [입장 안내] · 내보내기 · leaveKickNotice
  {
    const hints = (out) => out.filter((i) => i.t === 'hint').map((i) => i.text);
    const s = await session('leavekick');
    assert(hints(await s.act('rejoin')).join() === '먼저 [손님 나가기]를 눌러 주세요.', 'leavekick: nobody left yet');
    const out1 = await s.act('leave');
    assert(one(out1, 'leave').text.indexOf('[퇴장 안내]') === 0 && s.state.runtime.bans['2001'], 'leavekick: leave notes a ban');
    assert(hints(out1).join().indexOf('바로 올리지 못하면') > 0, 'leavekick: the ban hint is conditional ' + hints(out1));
    assert(s.state.lim.fs === 0, 'leavekick: a leaver kick that fails is not counted, like botpool actionFailed(noCount)');
    // 한 번에 한 사람만 나간다
    const again = await s.act('leave');
    assert(hints(again).join() === '먼저 [다시 들어오기]를 눌러 주세요.' && !again.some((i) => i.t === 'feed'), 'leavekick: one guest at a time');
    const out2 = await s.act('rejoin');
    const b = bots(out2);
    const row = s.state.runtime.visit.people[key('2001')];
    assert(b.length === 2 && b[0].text === R.visitNoticeText('join', { userId: '2001', name: '하늘', link: s.state.members['2001'].link }, row.joins).text, 'leavekick: join notice first');
    assert(b[1].text === R.leaveKickNotice('하늘', b[1].at) && !b[1].mention, 'leavekick: leaveKickNotice');
    assert(out2.some((i) => i.t === 'feed' && i.text === '하늘님을 내보냈습니다.') && !s.state.runtime.bans['2001'], 'leavekick: kicked and ban cleared');
    assert(s.state.lim.fs === 0, 'leavekick: a kick that works resets the failure count');
    // 나머지 세 사람도 나감 → 다시 들어옴. 다 끝나면 두 버튼 모두 [다시 시작] 안내(서로 미루지 않는다)
    for (let i = 0; i < 3; i++) {
      await s.act('leave');
      assert(bots(await s.act('rejoin')).length === 2, 'leavekick: cycle ' + i);
    }
    const none = '체험할 손님이 더 없습니다. [다시 시작]을 눌러 주세요.';
    assert(hints(await s.act('leave')).join() === none && hints(await s.act('rejoin')).join() === none, 'leavekick: both buttons agree when nobody is left');
    // 나간 사람의 실패는 연속 실패로 세지 않는다: 두 번 실패한 뒤에 나가도 멈추지 않는다
    const f = await session('leavekick');
    f.state.lim.fs = 2;
    await f.act('leave');
    assert(f.state.lim.pause === 0 && f.state.lim.fs === 2 && f.state.runtime.bans['2001'], 'leavekick: a leaver does not add to the failure count');
    // 연속 실패 멈춤 안내는 체험에서 나오지 않지만(나간 사람의 실패는 세지 않는다) 문구는 본다
    copyOk(M.PAUSED_HINT, 'leavekick: pause hint');
    // 연속 실패로 멈춘 동안 나가도 botpool 처럼 적어 두고(내보내기는 건너뜀), 멈춘 동안 다시 들어오면 내보내지 않는다
    const p = await session('leavekick');
    p.state.lim.pause = p.state.clock + 10 * 60000;
    const o3 = await p.act('leave');
    assert(p.state.runtime.bans['2001'] && hints(o3).join().indexOf('바로 올리지 못하면') > 0, 'leavekick: a leaver while paused is still banned ' + hints(o3));
    const o4 = await p.act('rejoin');
    assert(!o4.some((i) => i.t === 'feed' && /내보냈습니다/.test(i.text)) && bots(o4).length === 1 && p.state.runtime.bans['2001'], 'leavekick: no kick while paused');
  }

  // ── 프로필 기록: profileChange(닉네임·옾링) · profileLookup
  {
    const s = await session('profile');
    const pcfg = R.normRoomConfig(M.configOf('profile'));
    const first = one(await s.say('!프로필 하늘'), 'lookup seeded').text;
    assert(first === R.profileLookup(s.state.runtime, M.CHAT_ROOM, pcfg, { authorId: M.ME, arg: '하늘', mentions: [] }, ctx('profile'), Date.now()) &&
      first.indexOf('이전 이름 : 하늘이 (') > 0, 'profile: the seeded rename shows in the first lookup ' + first);
    const out = await s.act('rename');
    const b = one(out, 'rename');
    const p = s.state.runtime.profile.people[key('2001')];
    const times = [...new Set(p.changes.map((c) => c.at))];
    const want = R.profileChangeNotice({ userId: '2001', name: '하늘_판매', link: s.state.members['2001'].link }, [{ kind: 'name', from: '하늘', to: '하늘_판매' }], times);
    assert(b.text === want.text && JSON.stringify(b.mention) === JSON.stringify(mentionOf(want)), 'profile: rename notice ' + b.text);
    assert(out[0].t === 'member' && out[0].name === '하늘_판매' && out[1].from === '2001', 'profile: rename then the message, then the notice');
    const look = one(await s.say('!프로필 하늘_판매'), 'lookup').text;
    assert(look === R.profileLookup(s.state.runtime, M.CHAT_ROOM, R.normRoomConfig(M.configOf('profile')), { authorId: M.ME, arg: '하늘_판매', mentions: [] }, ctx('profile'), Date.now()), 'profile: lookup = profileLookup');
    const rl2 = one(await s.act('relink'), 'relink').text;
    assert(rl2.indexOf('옾링 변경전 : https://open.kakao.com/o/sDemo01\n옾링 변경후 : https://open.kakao.com/o/sDemo04') > 0, 'profile: relink notice ' + rl2);
    assert(one(await s.say('!도움'), 'help').text === R.helpLine(viewOf('profile')), 'profile: help');
  }

  // ── 홍보 금지: 가림 → 경고 → 기준에서 내보내기(promoNotice)
  for (const kickAt of [3, 2]) {
    const s = await session('promo', { kickAt: String(kickAt) });
    for (let n = 1; n <= kickAt; n++) {
      const out = await s.act('post');
      const post = out.find((i) => i.t === 'msg' && i.from === '2301');
      assert(out.some((i) => i.t === 'hide' && i.id === post.id), 'promo: the link post is hidden');
      const b = one(out, 'promo ' + n);
      const want = R.promoNotice({ userId: '2301', name: '홍보맨', n: n, kickAt: kickAt }, { hidden: true, kicked: n === kickAt }, b.at);
      assert(b.text === want.text, 'promo: notice ' + b.text);
      assert(out.some((i) => i.t === 'feed' && i.text === '홍보맨님을 내보냈습니다.') === (n === kickAt), 'promo: kick at ' + kickAt);
    }
    const next = await s.act('post');
    assert(next.some((i) => i.t === 'feed' && i.text === '광고왕님이 들어왔습니다.'), 'promo: next promoter joins');
    assert(bots(await s.say('https://open.kakao.com/o/gMine')).length === 0, 'promo: the host may post links');
  }

  // ── 금지어 검열: 조용히 가림(방 글 없음)
  {
    const s = await session('cover');
    for (const a of ['bad', 'word', 'bad', 'word']) {
      const out = await s.act(a);
      const post = out.find((i) => i.t === 'msg');
      assert(bots(out).length === 0 && out.some((i) => i.t === 'hide' && i.id === post.id), 'cover: ' + a + ' hidden without a notice');
      const rec = R.adapterRecord(viewOf('cover'), 'bot.0000000000000001');
      assert(F.coverPlan(rec, { chatId: M.CHAT_ROOM, text: post.text, logId: '77', messageType: 1, mine: false, staff: true }), 'cover: coverPlan agrees');
    }
    const mine = await s.say('토토 하실 분 계신가요');
    assert(mine.length >= 1 && mine[0].t === 'hide' && mine[0].id === 'c' + s.n, 'cover: the visitor message is hidden by cid');
    assert((await s.say('안녕하세요')).length === 0, 'cover: a clean message stays');
  }

  // ── 글 가리기: hidePlan · hideDoneNotice · hideUsage · botpool 답
  {
    const s = await session('hide');
    const spam = s.start.filter((i) => i.t === 'msg' && i.from === '2501').map((i) => i.id);
    const out = await s.say('!가리기 5');
    const hidden = out.filter((i) => i.t === 'hide').map((i) => i.id);
    assert(hidden.join() === spam.slice(-5).reverse().join(), 'hide: last 5 newest first ' + hidden.join());
    assert(one(out, 'done').text === R.hideDoneNotice(5, 0), 'hide: done notice');
    // 300ms 간격으로 가리는 동안 다시 명령하면 botpool 의 '이미 가리는 중' 답
    assert(one(await s.say('!가리기 @도배꾼'), 'busy').text === M.POOL_TEXT.hideBusy, 'hide: busy while hiding');
    s.state.real -= 5000;
    const who = await s.say('!가리기 @도배꾼');
    assert(who.filter((i) => i.t === 'hide').map((i) => i.id).join() === spam[0] && one(who, 'who').text === R.hideDoneNotice(1, 0), 'hide: one person');
    assert(one(await s.say('!가리기 많이'), 'usage').text === R.hideUsage('!'), 'hide: usage');
    assert(one(await s.say('!가리기 @없는사람'), 'noname').text === '「없는사람」' + M.POOL_TEXT.hideNoNameTail, 'hide: unknown name');
    await s.act('spam');
    assert(one(await s.say('!가리기 @도배꾼'), 'again').text === R.hideDoneNotice(3, 0), 'hide: new spam');
    assert(one(await s.say('!도움'), 'help').text === R.helpLine(viewOf('hide')), 'hide: help');
  }

  // ── 올킥 감지: 방 글 없음, 패널 기록 = guardFinishHalt
  {
    const s = await session('guard');
    const out = await s.act('wave');
    assert(out.filter((i) => i.t === 'feed' && /님을 내보냈습니다\.$/.test(i.text)).length === 5 && bots(out).length === 0, 'guard: 5 kick lines, no room message');
    const panel = out.find((i) => i.t === 'panel');
    assert(panel && panel.title === M.PANEL_TITLE && panel.text === F.guardFinishHalt({ runtime: {} }, M.CHAT_ROOM, true, panel.at, 'K bot 체험방', 5, 'K bot'), 'guard: panel record');
    assert(F.logsView({ rooms: [], runtime: s.state.runtime }).guard[0].text === panel.text, 'guard: logsView has the same record');
    const again = await s.act('wave');
    assert(!again.some((i) => i.t === 'panel'), 'guard: halted for 10 minutes');
  }

  // ── 매크로: 정한 간격 이상 · 앞 글 뒤 다른 사람 대화가 있을 때만 · 건너뜀 힌트 · 요약 횟수
  for (const gap of ['3', '5', '10']) {
    const s = await session('macro', { gap: gap });
    const out = await s.act('play');
    const posts = out.filter((i) => i.t === 'msg' && i.from === M.SELLER);
    assert(posts.length >= 3 && posts.every((p) => p.text === M.MACRO_MSG), 'macro: posts ' + gap);
    for (let i = 1; i < posts.length; i++) assert(posts[i].at - posts[i - 1].at >= Number(gap) * 60000, 'macro: interval ' + gap);
    let others = 2;
    for (const it of out) {
      if (it.t !== 'msg') continue;
      if (it.from === M.SELLER) {
        assert(others > 0, 'macro: never posts twice without other chat');
        others = 0;
      } else others += 1;
    }
    const skips = out.filter((i) => i.t === 'hint' && i.text === '대화가 없어 이번 발송은 건너뜁니다.').length;
    const last = out[out.length - 1];
    assert(last.t === 'hint' && last.text.indexOf('30분 동안 ' + posts.length + '회 보냈습니다.') === 0 && (skips ? last.text.indexOf(skips + '회는 건너뛰었습니다.') > 0 : true), 'macro: summary ' + last.text);
    if (gap === '5') assert(posts.length === 5 && skips === 1, 'macro: 5 minute timeline');
  }

  // ── 갠톡 자동 응답 · 저격 규칙: 같은 설정의 실제 onInbound
  {
    const fresh = (acct, room, name, text) => F.onInbound({ features: { v: 2, macro_until: Date.now() + 60000 }, config: acct, rooms: [room], runtime: {} },
      { chatId: room.chat_id, text: text, authorName: name, mine: false });
    const s = await session('reply');
    const out = await s.say('안녕하세요, 거래 문의드립니다.');
    const want = fresh(M.acctOf('reply'), { key: M.DM_KEY, chat_id: M.CHAT_DM, name: M.ME_NAME, kind: 'dm' }, M.ME_NAME, 'x');
    assert(out.length === 1 && out[0].from === M.SELLER && out[0].text === want[0].text, 'reply: auto reply ' + JSON.stringify(out));
    const again = await s.say('배송은 얼마나 걸리나요?');
    assert(again.length === 1 && again[0].t === 'hint', 'reply: cooldown');
    const n = await session('snipe');
    const ask = await n.act('ask');
    const asker = ask[0];
    const sw = fresh(M.acctOf('snipe'), { key: M.OPEN_KEY, chat_id: M.CHAT_OPEN, name: '중고 장터방', kind: 'open' }, n.info.members.find((m) => m.id === asker.from).name, asker.text);
    assert(ask[1].from === M.SELLER && ask[1].text === sw[0].text, 'snipe: reply ' + JSON.stringify(ask));
    const ask2 = await n.act('ask');
    assert(ask2.length === 2 && ask2[1].t === 'hint', 'snipe: cooldown');
  }

  // ── 틀린 상태·요청은 던지지 않고 bad_state(장면은 bad_scene)
  {
    const isBad = (r, why) => assert(r && r.ok === false && r.status === 400 && r.reason === 'bad_state' && r.error === demo.ERR_RESTART, 'bad_state: ' + why + ' ' + JSON.stringify(r));
    const s = await session('visit');
    const good = s.state;
    const ev = { type: 'act', id: 'join' };
    isBad(await demo.step(null, ev), 'null');
    isBad(await demo.step('x', ev), 'string');
    isBad(await demo.step({}, ev), 'empty');
    isBad(await demo.step(Object.assign({}, good, { v: 2 }), ev), 'wrong v');
    isBad(await demo.step(Object.assign({}, good, { scene: 'nope' }), ev), 'unknown scene');
    isBad(await demo.step(Object.assign({}, good, { scene: 'guard' }), ev), 'foreign scene');
    isBad(await demo.step(Object.assign({}, good, { clock: 'soon' }), ev), 'clock');
    isBad(await demo.step(Object.assign({}, good, { members: {} }), ev), 'members');
    isBad(await demo.step(Object.assign({}, good, { ring: 'x' }), ev), 'ring');
    isBad(await demo.step(Object.assign({}, good, { runtime: { pad: 'x'.repeat(50 * 1024) } }), ev), 'oversized');
    const evil = JSON.parse(JSON.stringify(good));
    evil.runtime = JSON.parse('{"__proto__":{"polluted":1},"visit":{}}');
    isBad(await demo.step(evil, ev), '__proto__');
    // 봇 함수는 틀린 runtime 칸을 스스로 새로 만든다 → 실패 없이 이어진다
    assert((await demo.step(Object.assign({}, good, { runtime: { visit: 7, evSeen: [] } }), ev)).ok, 'odd runtime is repaired by the bot functions');
    isBad(await demo.step(Object.assign({}, good, { x: { st: [{}] } }), ev), 'scene counters');
    const mac = (await demo.start('macro')).state;
    isBad(await demo.step(Object.assign({}, mac, { x: Object.assign({}, mac.x, { t0: 'abc' }) }), { type: 'act', id: 'play' }), 'macro tick origin');
    isBad(await demo.step(good, { type: 'act', id: 'wave' }), 'unknown action');
    isBad(await demo.step(good, { type: 'say', text: 'x', cid: 'c'.repeat(41) }), 'long cid');
    isBad(await demo.step(good, { type: 'say', text: 5, cid: 'c1' }), 'text type');
    isBad(await demo.step(good, null), 'no event');
    assert(({}).polluted === undefined, 'no prototype pollution');
    // 장면 카운터의 아이디는 그 장면 사람만 — 명부를 원형으로 찾아 Object.prototype 을 바꾸지 않는다
    const proto = JSON.parse(JSON.stringify(good));
    proto.x.st = ['__proto__'];
    isBad(await demo.step(proto, { type: 'act', id: 'leave' }), 'x.st __proto__');
    const lk = (await demo.start('leavekick')).state;
    isBad(await demo.step(Object.assign({}, lk, { x: { left: ['__proto__'] } }), { type: 'act', id: 'rejoin' }), 'x.left __proto__');
    isBad(await demo.step(Object.assign({}, lk, { x: { left: ['constructor'] } }), { type: 'act', id: 'rejoin' }), 'x.left constructor');
    assert(({}).gone === undefined && !('gone' in Object.prototype), 'no gone on Object.prototype');
    // 객체 값(toString 이 함수가 아님)으로 500 이 나지 않는다
    const odd = JSON.parse('{"toString":1}');
    const ob = await demo.start('churn', { action: odd });
    assert(ob.ok && ob.scene.controls[0].value === 'warn', 'opts object falls back to the default');
    assert((await demo.start('churn', JSON.parse('{"action":{"toString":1,"valueOf":2}}'))).ok, 'opts valueOf/toString');
    const chs = (await demo.start('churn')).state;
    assert((await demo.step(Object.assign({}, chs, { opts: { action: odd } }), { type: 'act', id: 'cycle' })).ok, 'state opts object falls back');
    const ringed = JSON.parse(JSON.stringify(good));
    ringed.ring[0].logId = odd;
    isBad(await demo.step(ringed, ev), 'ring logId object');
    // 매크로 점검 시각이 체험 시계보다 1시간 넘게 뒤면 받지 않는다(점검을 수백 번 돌리지 않게)
    isBad(await demo.step(Object.assign({}, mac, { x: Object.assign({}, mac.x, { t: Date.UTC(2020, 0, 2), t0: Date.UTC(2020, 0, 2) }) }), { type: 'act', id: 'play' }), 'macro old tick');
    const bs = await demo.start('nope');
    assert(bs.ok === false && bs.status === 400 && bs.reason === 'bad_scene' && bs.error, 'bad_scene');
    assert((await demo.start(undefined)).reason === 'bad_scene' && (await demo.start('__proto__')).reason === 'bad_scene', 'bad_scene for odd ids');
    const long = await demo.step(good, { type: 'say', text: '가'.repeat(1500), cid: 'c1' });
    assert(long.ok, 'long text is cut, not rejected');
  }

  // ── 무작위 200단계(시간도 무작위로 흐르게): 실패 없음 · 상태 48KB 미만
  {
    const rnd = seeded(7);
    const pick = (a) => a[Math.floor(rnd() * a.length)];
    const texts = ['안녕하세요', 'ㅅㅂ 진짜', '토토 사이트', 'https://example.com 보세요', '!가리기 3', '!가리기 @하늘', '!프로필 하늘',
      '!도움', '!주사위 20', '!끝말잇기', '사과', '123', '!랭킹', '가격 문의드려요', '!가리기 999', '', '   ', '가'.repeat(1200)];
    for (const id of ids) {
      const s = await session(id, s0opts(id, rnd));
      for (let i = 0; i < 200; i++) {
        s.state.real -= Math.floor(rnd() * 10 * 60000);
        const r = rnd();
        if (r < 0.45 && s.info.actions.length) await s.act(pick(s.info.actions).id);
        else if (r < 0.75 && s.info.chips.length) await s.say(pick(s.info.chips));
        else await s.say(pick(texts));
      }
      assert(bytes(s.state) < demo.MAX_STATE, id + ': state after 200 steps ' + bytes(s.state));
    }
  }

  // ── 구매 화면 체험 소개 칸(public/buy.html .intro): 미리보기 방의 K bot 글 = 같은 방 설정으로 부른 실제 helpLine
  {
    const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'buy.html'), 'utf8');
    const real = {};
    html.replace(/<div class="kk-bub" data-real="([a-z]+)">([\s\S]*?)<\/div>/g, (_, k, inner) => {
      real[k] = inner.replace(/<[^>]+>/g, '').replace(/&#10;/g, '\n').replace(/&amp;/g, '&');
      return '';
    });
    assert(Object.keys(real).join(',') === 'help', 'intro: preview bubbles ' + Object.keys(real).join(','));
    // 방 관리봇 + 미니게임봇, K bot 부방장, 프로필 기록 켬(조회는 기본값) — 미리보기 방 이름표(부방장)와 같은 방
    const view = { chat_id: '9001', link_name: '미리보기', products: { roombot: true, minigame: true }, perm: 4, state: 'active', cfg: R.normRoomConfig({ profile: { enabled: true } }), runtime: {} };
    assert(real.help === R.helpLine(view), 'intro: [명령어] preview = helpLine ' + JSON.stringify(real.help));
    assert(html.indexOf('<div class="kk-bub">!도움</div>') > 0 && R.isHelpCommand('!도움', '!'), 'intro: the visitor line is a real help command');
    const sec = html.slice(html.indexOf('<section class="intro"'), html.indexOf('</section>', html.indexOf('<section class="intro"')));
    assert(!EMOJI.test(sec), 'intro: no emoji');
    const ids = new Set();
    demo.catalog().groups.forEach((g) => g.scenes.forEach((x) => ids.add(x.id)));
    const links = sec.match(/href="\/demo#[a-z]+"/g) || [];
    assert(links.length === 4, 'intro: four scene links');
    links.forEach((h) => assert(ids.has(h.slice(12, -1)), 'intro: scene link to an unknown scene ' + h));
  }

  process.stdout.write('demo check ok\n');
})().catch((e) => {
  console.error(e && e.stack ? e.stack : e);
  process.exit(1);
});

// 무작위 단계의 장면 설정(조절 칸이 있으면 고른다)
function s0opts(id, rnd) {
  if (id === 'churn') return { action: rnd() < 0.5 ? 'warn' : 'kick' };
  if (id === 'promo') return { kickAt: rnd() < 0.5 ? '3' : '2' };
  if (id === 'macro') return { gap: ['3', '5', '10'][Math.floor(rnd() * 3)] };
  return {};
}
