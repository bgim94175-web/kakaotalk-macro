// 몬스터 수집(monster.mjs · monster-card.mjs · monster-data.mjs)과 미니게임 연결(features·roomfeat) 점검.
// 난수·시각은 모두 넣어 준 값만 쓴다(같은 입력이면 같은 결과). 마지막 줄에 'monster check ok'.
import { mkdirSync, writeFileSync } from 'node:fs'
import * as M from './monster.mjs'
import * as C from './monster-card.mjs'
import { ELEMENTS, RARITIES, SPECIES } from './monster-data.mjs'
import * as RF from './roomfeat.mjs'
import { onInbound } from './features.mjs'
import * as Sword from './sword.mjs'
import { parseRoomCommand } from './roomcmd.mjs'
import { available } from './card.mjs'

function assert(ok, msg) {
  if (!ok) throw new Error('monster check: ' + msg)
}
function eq(a, b, msg) {
  if (a !== b) throw new Error('monster check: ' + msg + '\n  got:  ' + JSON.stringify(a) + '\n  want: ' + JSON.stringify(b))
}

// 씨앗 난수(mulberry32)와 정해 둔 값을 차례로 내는 난수
function seeded(seed) {
  let s = seed >>> 0
  return () => {
    s = (s + 0x6d2b79f5) >>> 0
    let t = s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
function seq(list) {
  let i = 0
  return () => {
    if (i >= list.length) throw new Error('monster check: random sequence ran out at ' + i)
    return list[i++]
  }
}

const T0 = Date.UTC(2026, 9, 13, 3, 0, 0) // 2026-10-13 12:00 KST
function game() {
  const rt = {}
  const env = { now: T0, rand: seeded(1) }
  const say = (key, name, cmd, arg, mentions, rand) => M.handle(rt, { cmd, arg: arg || '', key, name, mentions: mentions || [], prefix: '!' }, { now: env.now, rand: rand || env.rand })
  return { rt, env, say, user: (k) => rt.mon.u[k] }
}
// 원하는 몬스터를 그 사람 보관함에 바로 넣는다(시험 준비용)
function give(g, key, name, sid, lv) {
  const mon = M.monState(g.rt)
  const u = M.userOf(mon, key, name, g.env.now)
  const id = mon.seq++
  u.m.push([id, sid, lv, 0])
  if (!u.ld) u.ld = id
  return id
}
function allIds(rt) {
  const ids = []
  for (const u of Object.values(rt.mon.u)) for (const x of u.m) ids.push(x[0])
  return ids
}

// ── 1. 도감 자료: 우리 몬스터만, 그림·숫자 모양이 맞는지 ──────────────────────
{
  eq(SPECIES.length, 35, 'species count')
  const ids = new Set()
  const names = new Set()
  const els = new Set(ELEMENTS.map((e) => e.id))
  for (const sp of SPECIES) {
    assert(sp.id === ids.size + 1, 'ids are 1..N in order: ' + sp.id)
    ids.add(sp.id)
    assert(/^[가-힣]{2,5}$/.test(sp.name) && !names.has(sp.name), 'name is unique Hangul: ' + sp.name)
    names.add(sp.name)
    assert(els.has(sp.el), 'element ' + sp.name)
    assert(RARITIES.some((r) => r.id === sp.r), 'rarity ' + sp.name)
    assert(Array.isArray(sp.st) && sp.st.length === 4 && sp.st.every((n) => Number.isInteger(n) && n > 0 && n <= 120), 'stats ' + sp.name)
    assert(typeof sp.mv === 'string' && sp.mv && typeof sp.d === 'string' && sp.d.endsWith('요.'), 'move and 해요체 description ' + sp.name)
    assert(sp.px.length === 16 && sp.px.every((r) => r.length === 16), '16×16 sprite ' + sp.name)
    for (const row of sp.px) for (const ch of row) assert(ch === '.' || 'kwp'.includes(ch) || ch in sp.pal, `palette has ${ch} for ${sp.name}`)
    if (sp.evo) {
      const to = SPECIES.find((s) => s.id === sp.evo.to)
      assert(to && to.el === sp.el && to.id > sp.id && sp.evo.lv > 1 && sp.evo.lv < M.MAX_LV, 'evolution ' + sp.name)
      assert(!to.wild, 'evolved forms do not appear in the wild: ' + to.name)
    }
  }
  for (const r of RARITIES) assert(SPECIES.some((s) => s.wild && s.r === r.id), 'every rarity has wild monsters: ' + r.name)
  // 다른 작품 이름을 쓰지 않는다(대표적인 이름 몇 개를 막아 둔다)
  const banned = ['피카츄', '파이리', '꼬부기', '이상해씨', '푸린', '이브이', '잠만보', '고라파덕', '냐옹', '뮤츠', '리자몽', '디지몬', '요괴']
  for (const sp of SPECIES) for (const b of banned) assert(!sp.name.includes(b), 'no franchise names: ' + sp.name)
  // 상성은 한 바퀴: 각 기운은 하나에 강하고 하나에 약하다
  for (const a of ELEMENTS) {
    const strong = ELEMENTS.filter((b) => M.advantage(a.id, b.id) === 1.5)
    const weak = ELEMENTS.filter((b) => M.advantage(a.id, b.id) === 0.7)
    assert(strong.length === 1 && weak.length === 1 && M.advantage(a.id, a.id) === 1, 'element cycle ' + a.name)
  }
  eq(M.advantage('sun', 'wave'), 1.5, 'sun beats wave')
  eq(M.advantage('wave', 'sun'), 0.7, 'wave is weak to sun')
}

// ── 2. 탐험: 쿨타임 · 출석 보상 · 줍기 · 만남 ────────────────────────────────
{
  const g = game()
  // 만남: 아이템 굴림 0.5(≥0.1) → 등급 굴림 0(보통) → 종류 0(첫 보통 야생 = 솜볕) → 레벨 0(최저)
  const r = g.say('101', '홍', '탐험', '', [], seq([0.5, 0, 0, 0, 0.5]))
  const first = SPECIES.find((s) => s.wild && s.r === 1)
  eq(r.text, `[탐험] 홍님 앞에 야생 ${first.name}${RF.josa(first.name, '이')} 나타났어요. (Lv.1 · 햇살 · 보통)\n처음 보는 몬스터예요.\n오늘 첫 탐험 보상으로 그물 3개를 받았어요. (매일 오면 더 늘어요)\n「!포획」으로 잡아 보세요. (그물 8 · 별그물 0 · 황금그물 0)`, 'encounter text')
  eq(r.card.kind, 'encounter', 'encounter card')
  eq(r.card.sid, first.id, 'encounter species')
  eq(r.card.bonus, 3, 'daily bonus on card')
  const u = g.user('101')
  eq(u.c, M.START_COINS, 'start coins')
  eq(u.dx[first.id - 1], '1', 'seen in dex')
  eq(JSON.stringify(u.e), JSON.stringify([first.id, 1, T0]), 'encounter stored')
  // 1분 안에 다시 → 남은 초, 상태 그대로
  g.env.now = T0 + 20_000
  eq(g.say('101', '홍', '탐험', '', [], seq([])).text, '홍님, 다음 탐험까지 40초 남았어요.', 'explore cooldown')
  eq(u.x, T0, 'cooldown does not move the clock')
  // 1분 뒤: 같은 날이라 출석 보상 없음. 줍기(0.05 < 0.1) → 코인(0.2 < 0.7) → 15 + floor(0*26)
  g.env.now = T0 + 60_000
  eq(g.say('101', '홍', '탐험', '', [], seq([0.05, 0.2, 0])).text, '[탐험] 홍님이 풀숲에서 코인 15개를 주웠어요. (코인 115개)', 'coin find')
  eq(u.e, null, 'finding an item clears the encounter')
  g.env.now = T0 + 120_000
  eq(g.say('101', '홍', '탐험', '', [], seq([0.05, 0.9])).text, '[탐험] 홍님이 풀숲에서 별그물 1개를 주웠어요. (별그물 1개)', 'net find')
  // 다음 날(KST 자정 넘김) → 출석 보상 다시
  g.env.now = Date.UTC(2026, 9, 13, 15, 0, 1) // 10-14 00:00:01 KST
  const nets = u.nets[0]
  const r2 = g.say('101', '홍', '탐험', '', [], seq([0.5, 0, 0, 0, 0.5]))
  assert(r2.text.includes('2일 연속 탐험! 보상으로 그물 4개를 받았어요. (황금그물까지 5일)'), 'daily bonus again next KST day, as a streak ' + r2.text)
  eq(u.nets[0], nets + 4, 'daily nets added (3 + streak)')
  eq(u.ds, 2, 'streak counted')
  eq(r2.card.streak, 2, 'streak on the card')
  eq(r2.text.split('\n')[1], '전에 본 적 있는 몬스터예요.', 'seen before')
  // 전설 등급: 등급 굴림 0.999 → 마지막 등급
  g.env.now += 61_000
  const r3 = g.say('101', '홍', '탐험', '', [], seq([0.5, 0.999, 0, 0.999, 0.5]))
  const legend = SPECIES.find((s) => s.wild && s.r === 4)
  eq(r3.card.sid, legend.id, 'legendary roll')
  eq(r3.card.lv, RARITIES[3].lv[1], 'legendary level range top')
  // 같은 씨앗이면 같은 탐험 결과(결정적)
  const a = game()
  const b = game()
  const runs = (x) => {
    const out = []
    for (let i = 0; i < 30; i++) {
      x.env.now = T0 + i * 61_000
      out.push(x.say('7', '가', '탐험').text, x.say('7', '가', '포획').text)
    }
    return out.join('|')
  }
  eq(runs(a), runs(b), 'seeded sessions are identical')
}

// ── 3. 포획 ───────────────────────────────────────────────────────────────
{
  const g = game()
  eq(g.say('101', '홍', '포획').text, '홍님, 지금 만난 몬스터가 없어요. 「!탐험」으로 찾아 주세요.', 'no encounter')
  g.say('101', '홍', '탐험', '', [], seq([0.5, 0, 0, 0, 0.5]))
  const sp = SPECIES.find((s) => s.wild && s.r === 1)
  eq(g.say('101', '홍', '포획', '은그물').text, '그물 종류는 그물 · 별그물 · 황금그물 중에서 골라 주세요.', 'unknown net')
  eq(g.say('101', '홍', '포획', '별그물').text, '홍님, 별그물이 없어요. 「!그물」로 살 수 있어요. (코인 100개)', 'no such net')
  // 실패(0.9 ≥ 0.7) · 도망 안 감(0.9 ≥ 0.15)
  eq(g.say('101', '홍', '포획', '', [], seq([0.9, 0.9])).text, `${sp.name}${RF.josa(sp.name, '이')} 그물을 빠져나왔어요. 다시 「!포획」해 보세요. (그물 7개 남음)\n실패 보정 : 다음 포획 확률 +5%`, 'escape')
  // 성공(0.1 < 0.7 + 0.05)
  const ok = g.say('101', '홍', '포획', '', [], seq([0.1]))
  eq(ok.text, `[포획] 홍님이 ${sp.name}${RF.josa(sp.name, '을')} 잡았어요. (Lv.1 · 보관함 1번)\n도감에 새로 올렸어요. (1/35종) · 코인 +10\n실패 보정 +5%로 잡았어요. 보정은 처음부터 다시 쌓여요.\n첫 몬스터라서 대표로 정했어요.\n[방 최초 발견] 이 방에서 처음 잡힌 ${sp.name}${RF.josa(sp.name, '이에요')}.`, 'catch text')
  assert(ok.card.roomFirst && ok.card.pity === 5 && !ok.card.shiny, 'catch card: room first · pity · not shiny')
  eq(ok.card.kind, 'catch', 'catch card')
  assert(ok.card.fresh && ok.card.first && ok.card.no === 1, 'catch card fields')
  const u = g.user('101')
  eq(u.m.length, 1, 'box has one')
  eq(u.ld, u.m[0][0], 'first catch is the leader')
  eq(u.dx[sp.id - 1], '2', 'caught in dex')
  eq(u.c, 110, 'catch coins')
  eq(u.e, null, 'encounter cleared after catch')
  eq(g.say('101', '홍', '포획').text, '홍님, 지금 만난 몬스터가 없어요. 「!탐험」으로 찾아 주세요.', 'cannot catch twice')
  // 도망: 실패 후 0.1 < 0.15
  g.env.now += 61_000
  g.say('101', '홍', '탐험', '', [], seq([0.5, 0, 0, 0, 0.5]))
  eq(g.say('101', '홍', '포획', '', [], seq([0.95, 0.1])).text, `${sp.name}${RF.josa(sp.name, '이')} 그물을 빠져나와 도망갔어요. (그물 5개 남음)\n실패 보정 : 다음 포획 확률 +5%`, 'flee')
  eq(u.e, null, 'fled clears encounter')
  // 두 번째 포획 → 대표 경험치(6 + 레벨×2)
  g.env.now += 61_000
  g.say('101', '홍', '탐험', '', [], seq([0.5, 0, 0, 0.99, 0.5]))
  const second = g.say('101', '홍', '포획', '', [], seq([0]))
  assert(second.text.includes(`대표 ${sp.name} 경험치 +${6 + 5 * 2}`), 'leader exp line ' + second.text)
  // 시간이 지난 만남(5분)은 사라진다
  g.env.now += 61_000
  g.say('101', '홍', '탐험', '', [], seq([0.5, 0, 0, 0, 0.5]))
  g.env.now += M.ENCOUNTER_MS
  eq(g.say('101', '홍', '포획', '', [], seq([])).text, '홍님, 지금 만난 몬스터가 없어요. 「!탐험」으로 찾아 주세요.', 'encounter expires')
  // 그물이 하나도 없으면
  g.env.now += 61_000
  g.say('101', '홍', '탐험', '', [], seq([0.5, 0, 0, 0, 0.5]))
  u.nets = [0, 0, 0]
  eq(g.say('101', '홍', '포획').text, `홍님, 그물이 없어요. 「!그물」로 살 수 있어요. (코인 ${u.c}개)`, 'out of nets')
  // 보관함이 가득 차면 그물을 쓰지 않는다
  u.nets = [3, 0, 0]
  while (u.m.length < M.MAX_BOX) u.m.push([M.monState(g.rt).seq++, 1, 1, 0])
  eq(g.say('101', '홍', '포획', '', [], seq([])).text, `홍님의 보관함이 가득 찼어요. (최대 30마리) 「!놓아주기 번호」로 자리를 비워 주세요.`, 'box full')
  eq(u.nets[0], 3, 'box full does not use a net')
  // 황금그물은 확률 2.5배(전설 0.1 → 0.25)
  const h = game()
  const legend = SPECIES.find((s) => s.wild && s.r === 4)
  h.say('5', '나', '탐험', '', [], seq([0.5, 0.999, 0, 0, 0.5]))
  h.user('5').nets = [0, 0, 1]
  assert(h.say('5', '나', '포획', '황금', [], seq([0.24])).text.startsWith(`[포획] 나님이 ${legend.name}`), 'gold net multiplies the chance')
}

// ── 4. 경험치 · 진화 ──────────────────────────────────────────────────────
{
  const g = game()
  give(g, '1', '가', 1, 11)
  const u = g.user('1')
  const x = u.m[0]
  const r = M.addExp(u, x, M.expNeed(11))
  eq(x[2], 12, 'level up to 12')
  eq(x[1], 2, 'species 1 evolves to 2 at Lv.12')
  eq(JSON.stringify(r.evolved), '[1,2]', 'evolution reported')
  eq(u.dx[1], '2', 'evolved form goes into the dex')
  // 한 번에 크게 올라도 두 단계 진화
  const y = [99, 1, 1, 0]
  u.m.push(y)
  const r2 = M.addExp(u, y, 100000)
  eq(y[2], M.MAX_LV, 'capped at max level')
  eq(y[1], 3, 'two-stage evolution')
  eq(JSON.stringify(r2.evolved), '[1,3]', 'evolution chain reported from the first form')
  eq(M.addExp(u, y, 50).gain, 0, 'no exp at max level')
  // 정보 카드 문구
  const info = g.say('1', '가', '내몬스터', '1')
  eq(info.text.split('\n')[0], '[몬스터 정보] 가님의 1번 볕뭉치 Lv.12 (대표)', 'info title')
  eq(info.text.split('\n').pop(), 'Lv.26에 해님뭉게로 진화해요.', 'next evolution')
}

// ── 5. 배틀(결정적) ───────────────────────────────────────────────────────
{
  const A = { sid: 1, lv: 10 }
  const B = { sid: 8, lv: 10 }
  const r1 = M.simulate(A, B, seeded(9))
  const r2 = M.simulate(A, B, seeded(9))
  eq(JSON.stringify(r1), JSON.stringify(r2), 'battle is deterministic for a seed')
  assert(r1.log.length >= 2 && r1.log.length <= 20 && (r1.win === 0 || r1.win === 1), 'battle shape')
  eq(r1.log[0].eff, r1.log[0].who === 0 ? 1.5 : 0.7, 'sun vs wave effectiveness')
  // 같은 종류·레벨에서 상성 유리 쪽이 대부분 이긴다
  let sunWins = 0
  for (let i = 0; i < 50; i++) if (M.simulate({ sid: 1, lv: 10 }, { sid: 8, lv: 10 }, seeded(100 + i)).win === 0) sunWins++
  assert(sunWins >= 40, 'advantage matters: ' + sunWins)
  // 레벨이 크게 높으면 이긴다
  for (let i = 0; i < 20; i++) eq(M.simulate({ sid: 8, lv: 25 }, { sid: 1, lv: 5 }, seeded(i)).win, 0, 'high level wins')
  const fixed = M.simulate({ sid: 22, lv: 7 }, { sid: 31, lv: 9 }, seeded(3))
  eq(JSON.stringify([fixed.win, fixed.hp, fixed.log.length]), JSON.stringify(M.simulate({ sid: 22, lv: 7 }, { sid: 31, lv: 9 }, seeded(3)) && [fixed.win, fixed.hp, fixed.log.length]), 'fixed battle stable')

  // 신청 → 수락 흐름
  const g = game()
  give(g, '101', '홍', 1, 10)
  give(g, '202', '김', 8, 10)
  eq(g.say('101', '홍', '배틀').text, '「!배틀 @상대」처럼 입력해 주세요.', 'battle usage')
  eq(g.say('101', '홍', '배틀', '@없는사람').text, '배틀할 상대를 찾지 못했어요. 「!배틀 @상대」처럼 멘션해 주세요.', 'battle unknown target')
  eq(g.say('101', '홍', '배틀', '@홍', ['101']).text, '자기 자신과는 배틀할 수 없어요.', 'no self battle')
  eq(g.say('101', '홍', '배틀', '@초보', ['303']).text, '초보님은 아직 몬스터가 없어요.', 'target without monsters')
  const ask = g.say('101', '홍', '배틀', '@김', ['202'])
  eq(ask.text, '[배틀 신청] 홍님 → 김님\n홍님 솜볕 Lv.10 vs 김님 이슬콩 Lv.10\n김님, 「!수락」 또는 「!거절」을 입력해 주세요. (3분 안)', 'battle ask')
  eq(g.say('101', '홍', '배틀', '@김', ['202']).text, '김님에게 이미 기다리는 신청이 있어요. 잠시 뒤 다시 해 주세요.', 'target busy')
  eq(g.say('101', '홍', '수락'), null, 'proposer cannot accept own request')
  const res = g.say('202', '김', '수락', '', [], seeded(9))
  const sim = M.simulate({ sid: 1, lv: 10 }, { sid: 8, lv: 10 }, seeded(9))
  eq(res.card.kind, 'battle', 'battle card')
  eq(res.card.win, sim.win, 'accepted battle = simulate with same rand')
  assert(res.text.startsWith('[배틀] 홍님 솜볕 Lv.10 vs 김님 이슬콩 Lv.10\n'), 'battle title')
  const winner = sim.win === 0 ? g.user('101') : g.user('202')
  const loser = sim.win === 0 ? g.user('202') : g.user('101')
  eq(winner.c, M.START_COINS + 30, 'winner coins')
  eq(loser.c, M.START_COINS + 10, 'loser coins')
  eq(winner.w, 1, 'win counted')
  eq(loser.l, 1, 'loss counted')
  eq(g.say('202', '김', '수락'), null, 'no pending after battle')
  // 이름으로도 찾는다(멘션 번호가 없을 때)
  assert(g.say('101', '홍', '배틀', '@김').text.startsWith('[배틀 신청] 홍님 → 김님'), 'name lookup')
  eq(g.say('101', '홍', '거절').text, '홍님이 김님에게 보낸 배틀 신청을 취소했어요.', 'proposer cancels')
  g.say('101', '홍', '배틀', '@김', ['202'])
  eq(g.say('202', '김', '거절').text, '김님이 홍님의 배틀 신청을 거절했어요.', 'target rejects')
  eq(g.say('202', '김', '거절'), null, 'nothing to reject')
  // 3분 지나면 신청이 사라진다
  g.say('101', '홍', '배틀', '@김', ['202'])
  g.env.now += M.PENDING_MS
  eq(g.say('202', '김', '수락'), null, 'request expires')
  // 하루 보상은 5번까지
  for (let i = 0; i < 6; i++) {
    g.env.now += 1000
    g.say('101', '홍', '배틀', '@김', ['202'])
    const t = g.say('202', '김', '수락', '', [], seeded(50 + i)).text
    if (i === 5) assert(/님은 오늘 배틀 보상을 모두 받았어요\. \(하루 5번\)/.test(t), 'daily battle rewards cap ' + t)
  }
}

// ── 6. 교환: 한 번에 맞바꾸고, 복제되지 않는다 ──────────────────────────────
{
  const g = game()
  const a1 = give(g, '101', '홍', 1, 3)
  const a2 = give(g, '101', '홍', 22, 5)
  const b1 = give(g, '202', '김', 8, 4)
  const before = allIds(g.rt).sort().join(',')
  eq(g.say('101', '홍', '교환', '@김').text, '「!교환 @상대 내번호 상대번호」처럼 입력해 주세요. 상대 번호는 「!내몬스터 @상대」로 볼 수 있어요.', 'trade usage')
  eq(g.say('101', '홍', '교환', '@김 9 1', ['202']).text, '내 몬스터 번호는 1~2 사이로 입력해 주세요.', 'bad own number')
  eq(g.say('101', '홍', '교환', '@김 1 9', ['202']).text, '김님의 몬스터 번호는 1~1 사이로 입력해 주세요.', 'bad their number')
  eq(g.say('101', '홍', '교환', '@홍 1 1', ['101']).text, '자기 자신과는 교환할 수 없어요.', 'no self trade')
  const ask = g.say('101', '홍', '교환', '@김 2 1', ['202'])
  eq(ask.text, '[교환 신청] 홍님 → 김님\n홍님의 콩돌 Lv.5 ↔ 김님의 이슬콩 Lv.4\n김님, 「!수락」 또는 「!거절」을 입력해 주세요. (3분 안)', 'trade ask')
  eq(g.say('101', '홍', '배틀', '@김', ['202']).text, '김님에게 이미 기다리는 신청이 있어요. 잠시 뒤 다시 해 주세요.', 'one request per target')
  const done = g.say('202', '김', '수락')
  eq(done.text, '[교환 완료] 홍님 ↔ 김님\n홍님이 이슬콩 Lv.4를, 김님이 콩돌 Lv.5를 받았어요.', 'trade done')
  eq(allIds(g.rt).sort().join(','), before, 'same monsters exist after the trade')
  eq(new Set(allIds(g.rt)).size, allIds(g.rt).length, 'no duplicated monster ids')
  eq(g.user('101').m.map((x) => x[0]).join(','), [a1, b1].join(','), 'A box after trade (same slot)')
  eq(g.user('202').m.map((x) => x[0]).join(','), String(a2), 'B box after trade')
  eq(g.user('202').ld, a2, 'B leader follows the traded slot')
  eq(g.user('101').dx[7], '2', 'received species enters the dex')
  eq(g.say('202', '김', '수락'), null, 'cannot accept twice')
  // 수락 전에 몬스터를 놓아주면 교환은 취소, 아무것도 생기지 않는다
  g.say('101', '홍', '교환', '@김 1 1', ['202'])
  g.say('101', '홍', '놓아주기', '1')
  const n0 = allIds(g.rt).length
  eq(g.say('202', '김', '수락').text, '교환할 몬스터가 바뀌어서 교환을 취소했어요. 다시 신청해 주세요.', 'changed monster cancels the trade')
  eq(allIds(g.rt).length, n0, 'cancelled trade changes nothing')
  // 상대가 배틀 신청을 받은 동안 그 사람은 다른 신청을 보낼 수 없다
  give(g, '303', '박', 29, 2)
  g.say('303', '박', '배틀', '@김', ['202'])
  eq(g.say('202', '김', '교환', '@박 1 1', ['303']).text, '김님이 받은 신청이 있어요. 먼저 「!수락」 또는 「!거절」을 입력해 주세요.', 'pending incoming blocks new requests')
  // 3분 지난 교환 신청은 수락할 수 없다
  g.say('202', '김', '거절')
  g.say('101', '홍', '교환', '@김 1 1', ['202'])
  g.env.now += M.PENDING_MS + 1
  eq(g.say('202', '김', '수락'), null, 'trade expires')
  eq(Object.keys(g.rt.mon.p).length, 0, 'expired requests are pruned')
}

// ── 7. 보관함 · 대표 · 놓아주기 · 상점 · 도감 · 랭킹 ─────────────────────────
{
  const g = game()
  eq(g.say('1', '가', '내몬스터').text, '가님은 아직 몬스터가 없어요. 「!탐험」으로 찾아 보세요.', 'empty box')
  give(g, '1', '가', 4, 3)
  give(g, '1', '가', 29, 6)
  const box = g.say('1', '가', '내몬스터')
  eq(box.text, '[내 몬스터] 가님 2/30마리 · 코인 100개\n1. 귤토끼 Lv.3 (대표)\n2. 초롱이 Lv.6\n그물 5 · 별그물 0 · 황금그물 0', 'box text')
  eq(box.card.kind, 'box', 'box card')
  eq(g.say('1', '가', '내몬스터', '3').text, '몬스터 번호는 1~2 사이로 입력해 주세요.', 'box bad number')
  eq(g.say('1', '가', '대표', '2').text, '가님의 대표 몬스터를 2번 초롱이로 정했어요. (Lv.6)', 'set leader')
  eq(g.say('1', '가', '대표').text, '「!대표 번호」처럼 입력해 주세요. 번호는 「!내몬스터」에서 볼 수 있어요.', 'leader usage')
  eq(g.say('1', '가', '놓아주기', '2').text, '가님이 초롱이를 놓아줬어요. 코인 +11 (코인 111개)\n대표는 1번 귤토끼로 바꿨어요.', 'release leader')
  give(g, '2', '나', 8, 2)
  eq(g.say('1', '가', '내몬스터', '@나', ['2']).text, '[내 몬스터] 나님 1/30마리 · 코인 100개\n1. 이슬콩 Lv.2 (대표)', "someone else's box hides their nets")
  // 상점
  eq(g.say('1', '가', '그물').text, '[그물 상점] 가님 코인 111개\n그물 20코인 · 잡을 확률 1배 (5개 있음)\n별그물 60코인 · 잡을 확률 1.5배 (0개 있음)\n황금그물 150코인 · 잡을 확률 2.5배 (0개 있음)\n사는 법 : 「!그물 별그물 2」', 'shop list')
  eq(g.say('1', '가', '그물', '별그물').text, '가님이 별그물 1개를 샀어요. (코인 51개 남음 · 별그물 1개)', 'buy one')
  eq(g.say('1', '가', '그물', '2').text, '가님이 그물 2개를 샀어요. (코인 11개 남음 · 그물 7개)', 'buy basic by count')
  eq(g.say('1', '가', '그물', '황금그물 1').text, '코인이 모자라요. (필요 150개 · 있는 코인 11개)', 'not enough coins')
  eq(g.say('1', '가', '그물', '별그물 0').text, '개수는 1~20개로 입력해 주세요.', 'bad count')
  eq(g.say('1', '가', '그물', '금그물').text, '그물 종류는 그물 · 별그물 · 황금그물 중에서 골라 주세요.', 'bad kind')
  // 도감
  const d = g.say('1', '가', '도감')
  eq(d.text, '[도감] 가님 0/35종\n잡은 몬스터 : 없음', 'dex text (give() skips the dex)')
  eq(d.card.kind, 'dex', 'dex card')
  eq(g.say('1', '가', '도감', '없는몬').text, '「없는몬」은 도감에 없는 이름이에요.', 'dex unknown name')
  eq(g.say('1', '가', '도감', '노을새').text, '아직 만나지 못한 몬스터예요. 「!탐험」으로 찾아 보세요.', 'dex unseen')
  g.user('1').dx = '1' + g.user('1').dx.slice(1)
  eq(g.say('1', '가', '도감', '솜볕').text, '[도감] No.1 솜볕 · 햇살 · 보통\n햇볕 잘 드는 창가에서 몸을 부풀리며 낮잠을 자요.\n기술 : 볕가루 뿌리기\nLv.12에 볕뭉치로 진화해요.\n본 적만 있는 몬스터예요.', 'dex species text')
  // 랭킹: 잡은 종류 → 최고 레벨
  g.user('1').dx = '22' + '0'.repeat(33)
  g.user('2').dx = '2' + '0'.repeat(34)
  eq(g.say('1', '가', '몬스터랭킹').text, '[몬스터 랭킹]\n1. 가 도감 2종 · 최고 Lv.3\n2. 나 도감 1종 · 최고 Lv.2', 'ranking')
  eq(game().say('1', '가', '몬스터랭킹').text, '아직 몬스터를 잡은 사람이 없어요.', 'empty ranking')
  {
    const z = game()
    z.say('9', '구', '몬스터')
    z.say('9', '구', '몬스터랭킹')
    eq(z.say('9', '구', '수락'), null, 'nothing to accept for a newcomer')
    eq(Object.keys(z.rt.mon.u).length, 0, 'help · ranking · accept do not create a player')
  }
  eq(g.say('1', '가', '몬스터').text, '[명령어]\n몬스터 수집 : !탐험 !포획 !도감 !내몬스터 !대표 !놓아주기 !그물 !배틀 !교환 !수락 !거절 !레이드 !도전 !몬스터랭킹\n상성 : 햇살 → 물결 → 바위 → 바람 → 별빛 → 햇살 (왼쪽이 오른쪽에 강해요)\n출석 : 매일 첫 탐험에 그물을 받아요. 연속으로 오면 더 많이, 7일마다 황금그물도 받아요.\n포획 : 실패할 때마다 다음 포획 확률이 5%씩 올라요. (최대 +20%)\n레이드 : 「!레이드」로 전설 몬스터를 부르고, 대표 몬스터로 「!도전」해서 함께 쓰러뜨려요.', 'help')
  eq(g.say('1', '가', '끝말잇기'), null, 'other commands are not ours')
}

// ── 8. 크기 제한: 사람 200명 · 오래된 사람부터 · 신청도 함께 지운다 ─────────────
{
  const g = game()
  for (let i = 0; i < M.MAX_USERS; i++) {
    g.env.now = T0 + i
    g.say(String(1000 + i), '사람' + i, '그물')
  }
  g.env.now = T0
  give(g, '1000', '사람0', 1, 1)
  give(g, '1001', '사람1', 1, 1)
  g.say('1001', '사람1', '배틀', '@사람0', ['1000'])
  eq(Object.keys(g.rt.mon.u).length, M.MAX_USERS, 'at the cap')
  g.env.now = T0 + 10_000
  g.say('9999', '새사람', '그물')
  eq(Object.keys(g.rt.mon.u).length, M.MAX_USERS, 'still at the cap after a new person')
  assert(!g.rt.mon.u['1000'] && g.rt.mon.u['9999'], 'oldest person removed, new kept')
  eq(Object.keys(g.rt.mon.p).length, 0, 'requests of removed people are removed')
  // 저장(JSON) 뒤에도 그대로 이어진다
  const copy = JSON.parse(JSON.stringify(g.rt))
  const r = M.handle(copy, { cmd: '그물', arg: '', key: '9999', name: '새사람', prefix: '!' }, { now: T0 + 20_000, rand: seeded(1) })
  assert(r.text.startsWith('[그물 상점] 새사람님'), 'state survives JSON')
  // 망가진 기록도 고쳐서 쓴다
  const broken = { mon: { u: { 5: { n: '가', m: [[1, 999, 1, 0], 'x', [2, 1, 3, 0]], nets: 'x', c: -5, dx: 5 } }, p: [], seq: -1 } }
  const rr = M.handle(broken, { cmd: '내몬스터', arg: '', key: '5', name: '가', prefix: '!' }, { now: T0, rand: seeded(1) })
  eq(rr.text, '[내 몬스터] 가님 1/30마리 · 코인 0개\n1. 솜볕 Lv.3 (대표)\n그물 5 · 별그물 0 · 황금그물 0', 'broken saved state is repaired')
  // 한 사람 기록 크기(보관함 30마리)
  const h = game()
  for (let i = 0; i < M.MAX_BOX; i++) give(h, '1', '가'.repeat(40), 1 + (i % 35), 30)
  assert(JSON.stringify(h.rt.mon.u['1']).length < 1200, 'one full user stays small: ' + JSON.stringify(h.rt.mon.u['1']).length)
}

// ── 9. 그림 ──────────────────────────────────────────────────────────────
{
  // 모든 몬스터 그림: 18×18 칸, 빈 색(#FF00FF) 없음, 테두리 있음
  for (const sp of SPECIES) {
    const cl = C.cells(sp)
    assert(cl.length === 18 && cl.every((r) => r.length === 18), 'cells 18×18 ' + sp.name)
    const flat = cl.flat()
    assert(!flat.includes('#FF00FF'), 'no missing palette color ' + sp.name)
    assert(flat.filter(Boolean).length > 60, 'sprite has body ' + sp.name)
  }
  const g = game()
  g.say('101', '홍', '탐험', '', [], seq([0.5, 0, 0, 0, 0.5]))
  give(g, '101', '홍', 31, 12)
  give(g, '202', '김', 22, 9)
  const cards = {
    encounter: g.say('101', '홍', '탐험', '', [], seq([])) && (g.env.now += 61_000, g.say('101', '홍', '탐험', '', [], seq([0.5, 0.95, 0, 0.5, 0.5]))).card,
    catch: g.say('101', '홍', '포획', '', [], seq([0])).card,
    dex: g.say('101', '홍', '도감').card,
    box: g.say('101', '홍', '내몬스터').card,
    info: g.say('101', '홍', '내몬스터', '1').card,
    species: g.say('101', '홍', '도감', '솜볕').card,
  }
  g.say('101', '홍', '배틀', '@김', ['202'])
  cards.battle = g.say('202', '김', '수락', '', [], seeded(4)).card
  for (const [k, card] of Object.entries(cards)) {
    assert(card && card.kind, 'card exists: ' + k)
    const svg = C.cardSvg(card)
    assert(svg.startsWith('<svg') && svg.endsWith('</svg>'), 'svg ' + k)
    eq(C.cardSvg(card), svg, 'same card → same svg ' + k)
    assert(!/undefined|NaN/.test(svg), 'no undefined/NaN in svg ' + k)
  }
  // 이름은 글자로 들어가되 SVG 를 깨지 않는다
  const odd = C.cardSvg({ kind: 'box', owner: '<b>&"', mons: [{ no: 1, sid: 1, lv: 1, lead: true }], coins: 0, nets: [0, 0, 0], dex: 0, total: 35 })
  assert(odd.includes('&lt;b&gt;&amp;&quot;') && !odd.includes('<b>'), 'owner name is escaped')
  eq(C.cardSvg({ kind: 'nope' }), '', 'unknown card → no svg')
  if (available()) {
    const outDir = process.env.MONSTER_SAMPLES || ''
    if (outDir) mkdirSync(outDir, { recursive: true })
    for (const [k, card] of Object.entries(cards)) {
      const png = C.cardPng(card)
      assert(png && png.length > 2000 && png.subarray(1, 4).toString() === 'PNG', 'png ' + k)
      const w = png.readUInt32BE(16)
      const h = png.readUInt32BE(20)
      assert(w === 720 && h >= 280 && h <= 1200, `png size ${k} ${w}×${h}`)
      if (outDir) writeFileSync(`${outDir}/card-${k}.png`, png)
    }
  } else {
    console.log('monster check: image renderer not available, PNG checks skipped')
  }
}

// ── 10. 미니게임 연결(features.onInbound · roomfeat) ─────────────────────────
{
  const view = (cfg) => {
    const v = { install_id: 1, chat_id: '555', link_id: '9001', link_name: '동네모임', products: { roombot: false, minigame: true }, perm: 0, state: 'active', runtime: {}, ring: [] }
    v.cfg = RF.normRoomConfig(cfg || {})
    return v
  }
  const realNow = Date.now
  const realRandom = Math.random
  let clock = T0
  Date.now = () => clock
  try {
    const v = view({})
    const rec = RF.adapterRecord(v)
    eq(rec.config.minigame.monster, true, 'adapter passes games.monster')
    const say = (text, id, name, mentions) => onInbound(rec, { chatId: '555', text, authorName: name || '홍', authorId: id || '101', mentions, mine: false })
    // 도움말
    // 검 강화(sword.mjs)도 기본 켜짐 — 몬스터 수집 줄은 검 강화 줄 다음
    eq(RF.helpLine(v), '[명령어]\n미니게임 : !끝말잇기 !숫자야구 !주사위 !가위바위보 !퀴즈 !힌트 !정답 !포기 !랭킹\n검 강화 : !강화 !내검 !사냥 !출석 !결투 !보스 !강화도움\n몬스터 수집 : ' + M.helpCommands('!'), 'helpLine has the monster line')
    const p2 = view({ cmdPrefix: '#' })
    assert(RF.helpLine(p2).endsWith('\n몬스터 수집 : ' + M.helpCommands('#')), 'helpLine uses the prefix')
    eq(RF.helpLine(view({ games: { monster: false } })).includes('몬스터'), false, 'monster off → not in help')
    // 탐험 → 그림 + 글
    Math.random = seq([0.5, 0, 0, 0, 0.5])
    const out = say('!탐험')
    eq(out.length, 1, 'one reply')
    assert(out[0].text.startsWith('[탐험] 홍님 앞에 야생 '), 'explore text fallback')
    if (available()) {
      const img = out[0].image
      assert(Buffer.isBuffer(img) && img.subarray(1, 4).toString() === 'PNG', 'explore reply carries a PNG')
      assert(out[0].image === img, 'PNG made once')
    }
    // 쿨타임(3초) 안: 답도 없고 상태도 그대로
    clock += 1000
    Math.random = seq([])
    eq(say('!포획').length, 0, 'cooldown drops the reply')
    assert(v.runtime.mon.u['101'].e, 'cooldown does not use the encounter')
    eq(v.runtime.mon.u['101'].nets[0], 8, 'cooldown does not use a net')
    clock += 3000
    Math.random = seq([0])
    const caught = say('!포획')
    assert(caught.length === 1 && caught[0].text.startsWith('[포획] 홍님이 '), 'catch through onInbound')
    // 멘션 번호가 features 를 지나 monster 까지 간다
    clock += 3000
    Math.random = seq([0.5, 0, 0, 0, 0.5])
    say('!탐험', '202', '김')
    clock += 3000
    Math.random = seq([0])
    say('!포획', '202', '김')
    clock += 3000
    const ask = say('!배틀 @김', '101', '홍', ['202'])
    assert(ask.length === 1 && ask[0].text.startsWith('[배틀 신청] 홍님 → 김님'), 'battle via mention ' + JSON.stringify(ask))
    eq(ask[0].image, undefined, 'text-only replies have no image')
    clock += 3000
    Math.random = seeded(2)
    const fight = say('!수락', '202', '김')
    assert(fight.length === 1 && fight[0].text.startsWith('[배틀] 홍님 '), 'battle accepted')
    clock += 3000
    eq(say('!수락', '202', '김')[0].text, '받은 신청이 없어요.', 'nothing to accept')
    // !게임 목록에도 몬스터 수집 줄
    clock += 3000
    eq(say('!게임')[0].text.split('\n')[3], '몬스터 수집 : ' + M.helpCommands('!'), '!게임 lists monster commands')
    eq(M.helpCommands('!'), '!탐험 !포획 !도감 !내몬스터 !배틀 !교환 !레이드 !도전 !몬스터', 'help line has the raid commands')
    // 레이드도 onInbound 를 지난다(글만)
    clock += 3000
    const raid = say('!레이드')
    assert(raid.length === 1 && raid[0].text.startsWith('[레이드 등장] 전설 몬스터 해오름사자가 나타났어요!'), 'raid via onInbound')
    eq(raid[0].image, undefined, 'raid reply is text only')
    clock += 3000
    Math.random = seq([0.5, 0.5])
    const hit = say('!도전')
    assert(hit.length === 1 && hit[0].text.startsWith('[도전] 홍님의 '), 'challenge via onInbound ' + JSON.stringify(hit))
    // 하루 최대 응답 수
    const lim = view({ games: { dailyLimit: 1 } })
    const lrec = RF.adapterRecord(lim)
    lrec.config.minigame.cooldownMs = 0
    Math.random = seq([0.5, 0, 0, 0, 0.5])
    eq(onInbound(lrec, { chatId: '555', text: '!탐험', authorName: '홍', authorId: '1', mine: false }).length, 1, 'first reply within limit')
    Math.random = seq([])
    eq(onInbound(lrec, { chatId: '555', text: '!포획', authorName: '홍', authorId: '1', mine: false }).length, 0, 'daily limit drops')
    eq(lim.runtime.mon.u['1'].nets[0], 8, 'daily limit does not use a net')
    // 꺼진 방
    const off = view({ games: { monster: false, sword: false } })
    const orec = RF.adapterRecord(off)
    eq(onInbound(orec, { chatId: '555', text: '!탐험', authorName: '홍', authorId: '1', mine: false })[0].text, '이 방에서는 몬스터 수집이 꺼져 있어요.', 'monster off')
    clock += 5000
    eq(onInbound(orec, { chatId: '555', text: '!수락', authorName: '홍', authorId: '1', mine: false }).length, 0, 'monster off: !수락 is silent')
    assert(!off.runtime.mon, 'monster off keeps no state')

    // 「수락」·「거절」은 검 강화 거래 제안과 같이 쓴다: 이 사람이 받은 것 중 가장 최근에 받은 게임이 답한다(7.3.3)
    const both = view({})
    const brec = RF.adapterRecord(both)
    brec.config.minigame.cooldownMs = 0
    const say2 = (text, id, name, mentions) => onInbound(brec, { chatId: '555', text, authorName: name, authorId: id, mentions, mine: false })
    for (const [id, nm] of [['101', '홍'], ['202', '김']]) {
      clock += 1000
      Math.random = seq([0.5, 0, 0, 0, 0.5])
      say2('!탐험', id, nm)
      clock += 1000
      Math.random = seq([0])
      say2('!포획', id, nm)
      clock += 1000
      say2('!내검', id, nm)
    }
    both.runtime.sword.r.u['101'].it = { guard: 2 }
    // 검 거래 먼저, 몬스터 배틀 나중 → 「수락」은 배틀, 다음 「수락」은 거래
    clock += 1000
    assert(say2('!거래 @김 보호 1 10', '101', '홍', ['202'])[0].text.startsWith('[거래 제안] 홍님 → 김님'), 'shared: sword offer')
    clock += 1000
    assert(say2('!배틀 @김', '101', '홍', ['202'])[0].text.startsWith('[배틀 신청] 홍님 → 김님'), 'shared: monster request')
    clock += 1000
    Math.random = seeded(3)
    assert(say2('!수락', '202', '김')[0].text.startsWith('[배틀] 홍님 '), 'shared: newest (monster) answers 수락 first')
    clock += 1000
    assert(say2('!수락', '202', '김')[0].text.startsWith('[거래 완료]'), 'shared: then the sword offer')
    clock += 1000
    eq(say2('!수락', '202', '김')[0].text, '받은 신청이 없어요.', 'shared: nothing left')
    // 몬스터 교환 신청 먼저, 검 거래 나중 → 「거절」은 검 거래, 다음 「거절」은 몬스터 신청
    clock += 1000
    assert(say2('!배틀 @김', '101', '홍', ['202'])[0].text.startsWith('[배틀 신청]'), 'shared: monster request 2')
    clock += 1000
    assert(say2('!거래 @김 보호 1 10', '101', '홍', ['202'])[0].text.startsWith('[거래 제안]'), 'shared: sword offer 2')
    clock += 1000
    assert(say2('!거절', '202', '김')[0].text.startsWith('[거래 거절]'), 'shared: newest (sword) answers 거절 first')
    clock += 1000
    eq(say2('!거절', '202', '김')[0].text, '김님이 홍님의 배틀 신청을 거절했어요.', 'shared: then the monster request')
    // 받은 것이 없으면 「거절」은 내가 보낸 몬스터 신청을 취소한다
    clock += 1000
    say2('!배틀 @김', '101', '홍', ['202'])
    clock += 1000
    eq(say2('!거절', '101', '홍')[0].text, '홍님이 김님에게 보낸 배틀 신청을 취소했어요.', 'shared: 거절 cancels my own monster request')
    // 만료된 검 거래(2분)는 고르지 않는다
    clock += 1000
    say2('!거래 @김 보호 1 10', '101', '홍', ['202'])
    clock += 3 * 60 * 1000
    eq(say2('!수락', '202', '김')[0].text, '받은 신청이 없어요.', 'shared: expired offers are ignored')
  } finally {
    Date.now = realNow
    Math.random = realRandom
  }
}

// ── 11. 명령어 이름: 검 강화 · 몬스터 수집 · 방 관리 · 기존 미니게임이 겹치지 않는다(수락·거절만 두 게임이 같이 쓴다) ──
{
  const base = ['끝말잇기', '숫자야구', '야구', '주사위', '가위바위보', '묵찌빠', '퀴즈', '힌트', '정답', '포기', '점수', '랭킹', '순위', '게임도움', '게임', '도움', '명령']
  const sw = [...Sword.COMMANDS]
  const shared = sw.filter((c) => M.isCommand(c)).sort()
  eq(JSON.stringify(shared), JSON.stringify(['거절', '수락']), 'sword ∩ monster = 수락 · 거절')
  for (const c of [...sw, ...M.COMMANDS]) {
    assert(!base.includes(c), 'game command collides with a base minigame command: ' + c)
    eq(parseRoomCommand('!' + c, '!'), null, 'game command read as a room command: ' + c)
    eq(parseRoomCommand('!' + c + ' @김', '!'), null, 'game command with an argument read as a room command: ' + c)
  }
}

// ── 12. 연속 출석: 하루 첫 탐험 그물이 연속 일수만큼 늘고(최대 7), 7일마다 황금그물, 하루 건너뛰면 1일부터 ──
{
  const g = game()
  const day = (n) => T0 + n * 86400000 // T0 은 KST 낮 12시 — 하루씩 더해도 날만 바뀐다
  const find = (n) => {
    g.env.now = day(n)
    return g.say('1', '가', '탐험', '', [], seq([0.05, 0.2, 0])) // 코인 줍기(만남 없음)
  }
  const got = []
  for (let d = 0; d < 7; d++) {
    const before = g.rt.mon && g.user('1') ? g.user('1').nets.slice() : M.START_NETS.slice()
    const r = find(d)
    const u = g.user('1')
    got.push([u.ds, u.nets[0] - before[0], u.nets[2] - before[2]].join(':'))
    if (d === 0) eq(r.text, '[탐험] 가님이 풀숲에서 코인 15개를 주웠어요. (코인 115개)\n오늘 첫 탐험 보상으로 그물 3개를 받았어요. (매일 오면 더 늘어요)', 'streak day 1')
    if (d === 2) eq(r.text.split('\n')[1], '3일 연속 탐험! 보상으로 그물 5개를 받았어요. (황금그물까지 4일)', 'streak day 3')
    if (d === 6) eq(r.text.split('\n')[1], '7일 연속 탐험! 보상으로 그물 7개와 황금그물 1개를 받았어요.', 'streak day 7')
  }
  eq(got.join(' '), '1:3:0 2:4:0 3:5:0 4:6:0 5:7:0 6:7:0 7:7:1', 'streak rewards grow and the 7th day adds a gold net')
  eq(M.dailyNets(1), 3, 'daily nets day 1')
  eq(M.dailyNets(100), M.DAILY_NETS_MAX, 'daily nets are capped')
  // 같은 날 다시 탐험하면 보상 없음
  const u = g.user('1')
  const n0 = u.nets[0]
  g.env.now = day(6) + 61_000
  eq(g.say('1', '가', '탐험', '', [], seq([0.05, 0.2, 0])).text.includes('연속'), false, 'no second reward on the same day')
  eq(u.nets[0], n0, 'same day: nets unchanged')
  eq(u.ds, 7, 'same day: streak unchanged')
  // 하루 건너뛰면 1일부터
  const r8 = find(8)
  eq(r8.text.split('\n')[1], '오늘 첫 탐험 보상으로 그물 3개를 받았어요. (매일 오면 더 늘어요)', 'missing a day resets the streak')
  eq(u.ds, 1, 'streak reset')
  // 7일마다 황금그물(14일째에도)
  const g0 = u.nets[2]
  for (let d = 9; d <= 21; d++) find(d)
  eq(u.ds, 14, 'streak counts up again')
  eq(u.nets[2] - g0, 2, 'gold net on days 7 and 14 of the streak')
  // 연속 일수가 없는 옛 저장본: 어제 받았으면 2일째로 이어진다
  delete u.ds
  eq(find(22).text.split('\n')[1], '2일 연속 탐험! 보상으로 그물 4개를 받았어요. (황금그물까지 5일)', 'old save without ds continues the streak')
  // 탐험 카드에 연속 일수 · 황금그물
  const h = game()
  h.env.now = day(0)
  h.say('1', '가', '탐험', '', [], seq([0.05, 0.2, 0]))
  Object.assign(h.user('1'), { ds: 6 })
  h.env.now = day(1)
  const card = h.say('1', '가', '탐험', '', [], seq([0.5, 0, 0, 0, 0.5])).card
  assert(card.streak === 7 && card.bonus === 7 && card.gold === 1, 'encounter card carries the streak ' + JSON.stringify(card))
  assert(C.cardSvg(card).includes('7일 연속 · 그물 +7 · 황금그물 +1'), 'streak chip on the card')
}

// ── 13. 포획 실패 보정: 실패마다 +5%p(최대 +20%p), 잡으면 0 ─────────────────
{
  const g = game()
  const legend = SPECIES.find((s) => s.wild && s.r === 4)
  g.say('5', '나', '탐험', '', [], seq([0.5, 0.999, 0, 0, 0.5]))
  const u = g.user('5')
  u.nets = [10, 0, 0]
  // 전설 0.1(+보정 최대 0.2): 0.35 는 늘 실패(도망 굴림 0.9 ≥ 0.5 → 남음)
  for (let i = 1; i <= 5; i++) {
    const t = g.say('5', '나', '포획', '', [], seq([0.35, 0.9])).text
    eq(u.pf, Math.min(4, i), 'pity count ' + i)
    eq(t.split('\n')[1], i <= 4 ? `실패 보정 : 다음 포획 확률 +${i * 5}%` : '실패 보정 : 다음 포획 확률 +20% (최대)', 'pity line ' + i)
  }
  eq(M.pityOf(u.pf), M.PITY_MAX, 'pity capped')
  // 탐험 글·카드에도 보정이 보인다(만남은 그대로 두고 확인만)
  const keep = u.e
  const x0 = u.x
  g.env.now += 61_000
  const ex = g.say('5', '나', '탐험', '', [], seq([0.5, 0.999, 0, 0, 0.5]))
  assert(ex.text.split('\n').includes('실패 보정 : 포획 확률 +20%') && ex.card.pity === 20, 'explore shows the pity bonus')
  assert(u.e && u.e[0] === keep[0] && u.x !== x0, 'new legendary encounter')
  // 0.1 + 0.2 = 0.3 → 0.29 로 잡힌다
  const ok = g.say('5', '나', '포획', '', [], seq([0.29]))
  assert(ok.text.startsWith(`[포획] 나님이 ${legend.name}`), 'pity makes the catch ' + ok.text)
  assert(ok.text.includes('\n실패 보정 +20%로 잡았어요. 보정은 처음부터 다시 쌓여요.'), 'pity line on success')
  eq(ok.card.pity, 20, 'pity on the catch card')
  assert(C.cardSvg(ok.card).includes('실패 보정 +20%'), 'pity chip on the catch card')
  eq(u.pf, 0, 'pity resets on success')
  // 보정 없이 잡으면 줄이 없다
  g.env.now += 61_000
  g.say('5', '나', '탐험', '', [], seq([0.5, 0, 0, 0, 0.5]))
  const plain = g.say('5', '나', '포획', '', [], seq([0]))
  assert(!plain.text.includes('실패 보정') && plain.card.pity === 0, 'no pity line without failures')
}

// ── 14. 빛나는 몬스터: 1% · 잡아도·진화해도·교환해도 그대로 · 옛 저장본 ──────────
{
  eq(M.SHINY_CHANCE, 0.01, 'shiny chance')
  const g = game()
  const sp = SPECIES.find((s) => s.wild && s.r === 1)
  eq(g.say('1', '가', '탐험', '', [], seq([0.5, 0, 0, 0, 0.01])).card.shiny, false, '0.01 is not shiny')
  g.env.now += 61_000
  const r = g.say('1', '가', '탐험', '', [], seq([0.5, 0, 0, 0, 0.005]))
  const lines = r.text.split('\n')
  eq(lines[0], `[탐험] 가님 앞에 야생 빛나는 ${sp.name}${RF.josa(sp.name, '이')} 나타났어요. (Lv.1 · 햇살 · 보통)`, 'shiny encounter title')
  eq(lines[2], '아주 드물게 나오는 빛나는 몬스터예요. 놓치지 마세요.', 'shiny encounter line')
  assert(r.card.shiny === true, 'shiny encounter card')
  eq(JSON.stringify(g.user('1').e), JSON.stringify([sp.id, 1, g.env.now, 1]), 'shiny flag stored on the encounter')
  const c = g.say('1', '가', '포획', '', [], seq([0]))
  assert(c.text.startsWith(`[포획] 가님이 빛나는 ${sp.name}${RF.josa(sp.name, '을')} 잡았어요.`), 'shiny catch text ' + c.text)
  assert(c.card.shiny === true, 'shiny catch card')
  const u = g.user('1')
  const x = u.m[0]
  eq(x[4], 1, 'shiny flag on the monster')
  const box = g.say('1', '가', '내몬스터')
  eq(box.text.split('\n')[1], `1. 빛나는 ${sp.name} Lv.1 (대표)`, 'shiny in the box list')
  assert(box.card.mons[0].shiny === true, 'shiny in the box card')
  const info = g.say('1', '가', '내몬스터', '1')
  assert(info.text.startsWith(`[몬스터 정보] 가님의 1번 빛나는 ${sp.name} Lv.1 (대표)`) && info.text.endsWith('아주 드물게 나오는 빛나는 몬스터예요.') && info.card.mon.shiny, 'shiny info')
  // 진화해도 빛남은 그대로
  const y = [999, 1, 11, 0, 1]
  u.m.push(y)
  M.addExp(u, y, M.expNeed(11))
  assert(y[1] === 2 && y[4] === 1, 'evolution keeps the shiny flag')
  u.m.pop()
  // 교환: 빛남이 몬스터와 함께 옮겨 간다
  give(g, '2', '나', 8, 3)
  const ids = allIds(g.rt).sort().join(',')
  assert(g.say('1', '가', '교환', '@나 1 1', ['2']).text.startsWith(`[교환 신청] 가님 → 나님\n가님의 빛나는 ${sp.name} Lv.1 ↔ 나님의 이슬콩 Lv.3`), 'trade ask names the shiny')
  assert(g.say('2', '나', '수락').text.includes(`나님이 빛나는 ${sp.name} Lv.1${RF.josa('Lv.1', '을')} 받았어요.`), 'trade done names the shiny')
  eq(allIds(g.rt).sort().join(','), ids, 'trade conserves monsters')
  eq(g.user('2').m[0][4], 1, 'shiny flag moved with the monster')
  eq(g.user('1').m[0].length, 4, 'the other monster stays plain')
  // 배틀 카드에도
  g.say('2', '나', '배틀', '@가', ['1'])
  const fight = g.say('1', '가', '수락', '', [], seeded(3))
  assert(fight.card.a.shiny === true && fight.card.b.shiny === false && fight.text.startsWith(`[배틀] 나님 빛나는 ${sp.name} Lv.`), 'battle shows the shiny')
  // 놓아주기
  const rel = g.say('2', '나', '놓아주기', '1')
  assert(rel.text.startsWith(`나님이 빛나는 ${sp.name}${RF.josa(sp.name, '을')} 놓아줬어요.`), 'release names the shiny ' + rel.text)
  // 옛 저장본(4칸 줄)은 그대로, 이상한 빛남 값은 지운다. JSON 왕복 뒤에도 그대로
  const old = { mon: { u: { 7: { n: '다', m: [[1, 1, 3, 0], [2, 8, 4, 0, 'x'], [3, 22, 5, 0, 1]], dx: '', e: [1, 2, T0, 7] }, }, seq: 4 } }
  const rr = M.handle(old, { cmd: '내몬스터', arg: '', key: '7', name: '다', prefix: '!' }, { now: T0, rand: seeded(1) })
  eq(rr.text, '[내 몬스터] 다님 3/30마리 · 코인 0개\n1. 솜볕 Lv.3 (대표)\n2. 이슬콩 Lv.4\n3. 빛나는 콩돌 Lv.5\n그물 5 · 별그물 0 · 황금그물 0', 'old saves load and keep the flag')
  eq(old.mon.u[7].m[1].length, 4, 'bad shiny value dropped')
  eq(old.mon.u[7].e.length, 3, 'bad encounter flag dropped')
  const copy = JSON.parse(JSON.stringify(old))
  eq(M.handle(copy, { cmd: '내몬스터', arg: '', key: '7', name: '다', prefix: '!' }, { now: T0, rand: seeded(1) }).text, rr.text, 'shiny survives JSON')
  // 그림: 빛나는 색은 다른 색표 · 금빛 후광 · 반짝이 별, 빠진 색 없음
  for (const s of SPECIES) {
    const a = C.cells(s).flat().join()
    const b = C.cells(s, true).flat()
    assert(b.join() !== a && !b.includes('#FF00FF'), 'shiny palette differs ' + s.name)
  }
  eq(C.shinyColor('#FFFFFF'), '#FFFFFF', 'white stays white')
  const shinySvg = C.cardSvg(r.card)
  const plainSvg = C.cardSvg(Object.assign({}, r.card, { shiny: false }))
  assert(shinySvg !== plainSvg && shinySvg.includes('<radialGradient') && shinySvg.includes('<polygon') && shinySvg.includes('빛나는') && !plainSvg.includes('<radialGradient'), 'shiny card has a glow')
  for (const card of [r.card, c.card, box.card, info.card, fight.card]) {
    const svg = C.cardSvg(card)
    assert(svg.startsWith('<svg') && !/undefined|NaN/.test(svg), 'shiny svg ' + card.kind)
    if (available()) {
      const png = C.cardPng(card)
      assert(png && png.subarray(1, 4).toString() === 'PNG', 'shiny png ' + card.kind)
      if (process.env.MONSTER_SAMPLES) writeFileSync(`${process.env.MONSTER_SAMPLES}/shiny-${card.kind}.png`, png)
    }
  }
}

// ── 15. 방 최초 발견: 이 방에서 처음 잡힌 종류에 한 줄 ─────────────────────────
{
  const g = game()
  const sp = SPECIES.find((s) => s.wild && s.r === 1)
  g.say('1', '가', '탐험', '', [], seq([0.5, 0, 0, 0, 0.5]))
  const a = g.say('1', '가', '포획', '', [], seq([0]))
  eq(a.text.split('\n').pop(), `[방 최초 발견] 이 방에서 처음 잡힌 ${sp.name}${RF.josa(sp.name, '이에요')}.`, 'room first line')
  assert(a.card.roomFirst === true && C.cardSvg(a.card).includes('방 최초 발견'), 'room first on the card')
  g.say('2', '나', '탐험', '', [], seq([0.5, 0, 0, 0, 0.5]))
  const b = g.say('2', '나', '포획', '', [], seq([0]))
  assert(!b.text.includes('[방 최초 발견]') && b.card.roomFirst === false, 'second catch of the species is not a room first')
  assert(b.text.includes('도감에 새로 올렸어요.'), 'still new in the personal dex')
  eq(g.rt.mon.fd.length, SPECIES.length, 'room set is bounded by the dex size')
  eq(g.rt.mon.fd, '1' + '0'.repeat(SPECIES.length - 1), 'room set')
  // 옛 방: 지금까지 잡힌 종류로 채운다(다시 「최초」라고 하지 않게) · 망가진 값은 고친다
  const old = { mon: { u: { 7: { n: '다', m: [], dx: '0000000' + '2' }, 8: { n: '라', m: [], dx: '01' } } } }
  M.handle(old, { cmd: '그물', arg: '', key: '7', name: '다', prefix: '!' }, { now: T0, rand: seeded(1) })
  eq(old.mon.fd, '0000000' + '1' + '0'.repeat(SPECIES.length - 8), 'old rooms seed the set from caught species')
  const bad = { mon: { fd: 'xyz', u: {} } }
  M.monState(bad)
  eq(bad.mon.fd, '0'.repeat(SPECIES.length), 'broken room set is rebuilt')
  const short = { mon: { fd: '11', u: {} } }
  M.monState(short)
  eq(short.mon.fd, '11' + '0'.repeat(SPECIES.length - 2), 'short room set is padded')
}

// ── 16. 레이드: 방 사람들이 대표 몬스터로 함께 ────────────────────────────────
{
  const g = game()
  const ap = '[레이드 등장] 전설 몬스터 해오름사자가 나타났어요!\n햇살 · 약점 별빛 · 체력 4,000\n아침마다 갈기를 흔들어 첫 햇살을 뿌려요.\n대표 몬스터로 「!도전」해서 함께 쓰러뜨려요. 피해량만큼 코인을 나눠 받아요.'
  eq(g.say('9', '구', '레이드').text, ap, 'raid appears on !레이드')
  eq(Object.keys(g.rt.mon.u).length, 0, '!레이드 does not create a player')
  eq(g.say('9', '구', '레이드').text, '[레이드] 해오름사자 · 햇살 · 약점 별빛\n체력 4,000 / 4,000\n■■■■■■■■■■\n남은 시간 24시간 · 「!도전」으로 함께 쓰러뜨려요.', 'raid status')
  eq(g.say('9', '구', '도전').text, '구님은 아직 몬스터가 없어요. 「!탐험」으로 먼저 잡아 주세요.', 'challenge needs a monster')
  give(g, '1', '가', 22, 10) // 바위: 보통
  give(g, '2', '나', 29, 10) // 별빛: 햇살에 강함
  give(g, '3', '다', 8, 5) // 물결: 햇살에 약함
  const d1 = M.raidHit(22, 10)
  const h1 = g.say('1', '가', '도전', '', [], seq([0.5, 0.5]))
  eq(h1.text, `[도전] 가님의 콩돌 Lv.10 · 데굴 구르기 → 해오름사자 -${d1}\n남은 체력 ${(4000 - d1).toLocaleString('en-US')} / 4,000\n■■■■■■■■■■`, 'challenge text')
  eq(g.rt.mon.r.hp, 4000 - d1, 'raid hp falls')
  g.env.now += 10_000
  eq(g.say('1', '가', '도전', '', [], seq([])).text, '가님, 다음 도전까지 50초 남았어요.', 'challenge cooldown')
  const d2 = Math.round(M.raidHit(29, 10) * 1.5 * 0.85 * 1.5)
  assert(g.say('2', '나', '도전', '', [], seq([0.05, 0])).text.startsWith(`[도전] 나님의 초롱이 Lv.10 · 불빛 깜빡 → 해오름사자 -${d2} (급소 · 효과가 좋아요)`), 'crit + advantage')
  const d3 = Math.round(M.raidHit(8, 5) * 0.7)
  assert(g.say('3', '다', '도전', '', [], seq([0.5, 0.5])).text.startsWith(`[도전] 다님의 이슬콩 Lv.5 · 이슬 톡 → 해오름사자 -${d3} (효과가 약해요)`), 'disadvantage')
  assert(g.say('9', '구', '레이드').text.endsWith('참여 3명 · 남은 시간 24시간 · 「!도전」으로 함께 쓰러뜨려요.'), 'status counts participants')
  // 마지막 일격: 남은 체력만큼만, 코인은 피해량대로(1인 최소 10), 마지막 일격·가장 큰 피해에 황금그물
  g.rt.mon.r.hp = 30
  g.rt.mon.r.d['3'] = 1
  g.env.now += M.RAID_CD_MS
  const coins0 = ['1', '2', '3'].map((k) => g.user(k).c)
  const gold0 = ['1', '2', '3'].map((k) => g.user(k).nets[2])
  const kill = g.say('1', '가', '도전', '', [], seq([0.5, 0.5]))
  const kl = kill.text.split('\n')
  eq(kl[0], `[도전] 가님의 콩돌 Lv.10 · 데굴 구르기 → 해오름사자 -30`, 'last hit only takes the hp left')
  eq(kl[1], '[레이드 성공] 가님의 마지막 일격으로 해오름사자를 쓰러뜨렸어요!', 'raid cleared')
  eq(kl[2], '마지막 일격 : 가님 (황금그물 1개)', 'last hit reward')
  const dmg = { 1: d1 + 30, 2: d2, 3: 1 }
  const top = Object.keys(dmg).sort((a, b) => dmg[b] - dmg[a])[0]
  eq(kl[3], `가장 큰 피해 : ${g.user(top).n}님 (황금그물 1개)`, 'top damage reward')
  eq(kl[kl.length - 1], '다음 레이드는 30분 뒤에 나타나요.', 'next raid time')
  const total = dmg[1] + dmg[2] + dmg[3]
  ;['1', '2', '3'].forEach((k, i) => {
    const want = Math.max(M.RAID_MIN_COINS, Math.floor((4000 * M.RAID_REWARD * dmg[k]) / total))
    eq(g.user(k).c - coins0[i], want, 'coin share ' + k)
    eq(g.user(k).nets[2] - gold0[i], (k === '1' ? 1 : 0) + (k === top ? 1 : 0), 'gold nets ' + k)
  })
  eq(g.user('3').c - coins0[2], M.RAID_MIN_COINS, 'minimum coins for a tiny hit')
  assert(kill.text.includes(`\n3. 다 1 피해 · 코인 +${M.RAID_MIN_COINS}`), 'reward rows')
  eq(g.rt.mon.r, null, 'raid gone')
  eq(g.rt.mon.rk, 1, 'raid count')
  eq(g.say('9', '구', '레이드').text, '다음 레이드는 30분 뒤에 나타나요.', 'no raid during the gap')
  g.env.now += M.RAID_GAP_MS - 60_000
  eq(g.say('9', '구', '도전').text, '다음 레이드는 1분 뒤에 나타나요.', 'gap counts down')
  g.env.now += 60_000
  const next = g.say('2', '나', '도전', '', [], seq([0.5, 0.5]))
  assert(next.text.startsWith('[레이드 등장] 전설 몬스터 물안개고래왕이 나타났어요!\n물결 · 약점 햇살 · 체력 7,000\n') && next.text.includes('\n[도전] 나님의 초롱이 Lv.10'), 'challenge spawns the next raid ' + next.text)
  // 하루 안에 못 쓰러뜨리면 도망
  g.env.now += M.RAID_TTL_MS
  eq(g.say('9', '구', '레이드').text, '물안개고래왕이 도망갔어요.\n다음 레이드는 30분 뒤에 나타나요.', 'raid flees after a day')
  eq(g.rt.mon.rk, 1, 'fled raid is not counted')
  // 다섯을 다 쓰러뜨린 뒤에는 체력 1.5배
  g.rt.mon.rk = 5
  g.env.now += M.RAID_GAP_MS
  assert(g.say('9', '구', '레이드').text.startsWith('[레이드 등장] 전설 몬스터 해오름사자가 나타났어요!\n햇살 · 약점 별빛 · 체력 6,000'), 'second round is tougher')
  eq(M.raidHp(9), Math.round(24000 * 1.5), 'raid hp table')
  // 망가진 레이드 저장본은 지운다
  for (const bad of [{ i: 99, hp: 1, mx: 1, d: {} }, { i: 0, hp: 9, mx: 5, d: {} }, { i: 0, hp: 0, mx: 5, d: {} }, { i: 0, hp: 1, mx: 5 }, 'x']) {
    g.rt.mon.r = bad
    M.monState(g.rt)
    eq(g.rt.mon.r, null, 'bad raid dropped ' + JSON.stringify(bad))
  }
  // 레이드 보스 이름은 우리 것: 도감 이름과 겹치지 않고 기운이 맞다
  const { RAID_BOSSES } = await import('./monster-data.mjs')
  for (const b of RAID_BOSSES) {
    assert(/^[가-힣]{3,7}$/.test(b.name) && !SPECIES.some((s) => s.name === b.name) && ELEMENTS.some((e) => e.id === b.el) && b.hp > 0 && b.d.endsWith('요.'), 'raid boss ' + b.name)
  }
  eq(new Set(RAID_BOSSES.map((b) => b.el)).size, ELEMENTS.length, 'one raid boss per element')
}

// ── 17. 아무렇게나 3,000번(씨앗 고정): 코인·그물이 음수·NaN 이 아니고, 몬스터는 잡기·놓아주기로만 늘고 준다 ──
{
  const g = game()
  const rand = seeded(20261017)
  const keys = ['1', '2', '3']
  const names = { 1: '가', 2: '나', 3: '다' }
  for (const k of keys) {
    give(g, k, names[k], [8, 15, 22][Number(k) - 1], 8)
    g.user(k).c = 3000
  }
  const lines = ['탐험', '탐험', '탐험', '포획', '포획', '포획', '포획 별그물', '포획 황금그물', '도전', '도전', '레이드', '배틀', '교환', '수락', '거절', '놓아주기 2', '그물 3', '그물 황금그물', '대표 2', '내몬스터', '몬스터랭킹']
  let caught = 0
  let cleared = 0
  let shinyMet = 0
  let traded = 0
  for (let i = 0; i < 3000; i++) {
    const k = keys[Math.floor(rand() * 3)]
    const o = keys[Math.floor(rand() * 3)]
    let line = lines[Math.floor(rand() * lines.length)]
    if (line === '배틀') line = `배틀 @${names[o]}`
    if (line === '교환') line = `교환 @${names[o]} 1 1`
    const sp = line.indexOf(' ')
    const cmd = sp < 0 ? line : line.slice(0, sp)
    const arg = sp < 0 ? '' : line.slice(sp + 1)
    const before = allIds(g.rt)
    const flags = new Map()
    for (const u of Object.values(g.rt.mon.u)) for (const x of u.m) flags.set(x[0], x[4] === 1)
    const r = g.say(k, names[k], cmd, arg, line.includes('@') ? [o] : [], rand)
    const after = allIds(g.rt)
    const t = r ? r.text : ''
    if (t.startsWith('[포획]')) caught++
    if (t.includes('[레이드 성공]')) cleared++
    if (t.includes('야생 빛나는 ')) shinyMet++
    if (t.startsWith('[교환 완료]')) traded++
    const delta = t.startsWith('[포획]') ? 1 : / 놓아줬어요\./.test(t) ? -1 : 0
    eq(after.length, before.length + delta, `fuzz: monsters only come from catches and leave by release (${line} → ${t.split('\n')[0]})`)
    eq(new Set(after).size, after.length, 'fuzz: no duplicated monster ids')
    if (t.startsWith('[교환 완료]')) eq(after.slice().sort().join(), before.slice().sort().join(), 'fuzz: trades conserve monsters')
    for (const u of Object.values(g.rt.mon.u)) {
      assert(Number.isSafeInteger(u.c) && u.c >= 0, 'fuzz: coins ' + u.c)
      assert(u.nets.length === 3 && u.nets.every((n) => Number.isSafeInteger(n) && n >= 0), 'fuzz: nets ' + u.nets)
      assert(u.m.length <= M.MAX_BOX && (!u.m.length || u.m.some((x) => x[0] === u.ld)), 'fuzz: box and leader')
      assert(Number(u.pf || 0) >= 0 && Number(u.pf || 0) <= M.PITY_MAX / M.PITY_STEP, 'fuzz: pity ' + u.pf)
      for (const x of u.m) {
        assert(x.length === 4 || (x.length === 5 && x[4] === 1), 'fuzz: tuple shape ' + JSON.stringify(x))
        if (flags.has(x[0])) eq(x[4] === 1, flags.get(x[0]), 'fuzz: shiny flag follows the monster')
        assert(x[2] >= 1 && x[2] <= M.MAX_LV && Number.isFinite(x[3]) && x[3] >= 0, 'fuzz: level/exp ' + JSON.stringify(x))
      }
    }
    const rr = g.rt.mon.r
    if (rr) assert(rr.hp > 0 && rr.hp <= rr.mx && rr.mx === M.raidHp(g.rt.mon.rk) && Object.values(rr.d).every((d) => Number.isFinite(d) && d > 0), 'fuzz: raid hp ' + JSON.stringify(rr))
    assert(/^[01]+$/.test(g.rt.mon.fd) && g.rt.mon.fd.length === SPECIES.length, 'fuzz: room set')
    assert(!/NaN|undefined/.test(t), 'fuzz: text ' + t)
    g.env.now += 1000 + Math.floor(rand() * 90_000)
  }
  assert(caught >= 50 && cleared >= 1 && shinyMet >= 1 && traded >= 1, `fuzz really played (${caught} catches, ${cleared} raids, ${shinyMet} shiny, ${traded} trades)`)
}

console.log('monster check ok')
