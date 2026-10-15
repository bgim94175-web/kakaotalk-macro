// 「추억의 검 강화」 점검(sword.mjs · sword-art.mjs · features.mjs 연결). 난수·시각을 고정해 늘 같은 결과.
// npm run check 가 부른다. 마지막 줄 'sword check ok'.
import { helpCard } from './helpcard.mjs'
import * as S from './sword.mjs'
import * as A from './sword-art.mjs'
import * as Card from './card.mjs'
import * as R from './roomfeat.mjs'
import { onInbound } from './features.mjs'

function assert(c, m) {
  if (!c) throw new Error('sword: ' + m)
}
function eq(a, b, m) {
  if (a !== b) throw new Error('sword: ' + m + '\n  got  ' + JSON.stringify(a) + '\n  want ' + JSON.stringify(b))
}
// 씨앗 난수(mulberry32)
function seeded(seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
const fixed = (v) => () => v
const T0 = Date.UTC(2026, 9, 17, 3, 0, 0)

function game() {
  const rt = {}
  let now = T0
  const g = {
    rt,
    get now() { return now },
    tick(ms) { now += ms },
    run(key, name, line, opt) {
      const o = opt || {}
      const sp = line.search(/\s/)
      const cmd = sp < 0 ? line : line.slice(0, sp)
      const arg = sp < 0 ? '' : line.slice(sp).trim()
      return S.run(rt, 'r', { cmd, arg, key, name, mentions: o.mentions || [], prefix: '!', now, rand: o.rand || fixed(0.999) })
    },
    u(key) { return rt.sword.r.u[key] },
    s() { return rt.sword.r },
  }
  return g
}
const PNG = (b) => Buffer.isBuffer(b) && b.length > 1000 && b.slice(0, 8).toString('hex') === '89504e470d0a1a0a'

// ── 표 ────────────────────────────────────────────────────────────────────
{
  let prevUp = 101
  let prevBroke = -1
  for (let lv = 0; lv < S.MAX_LV; lv++) {
    const c = S.chance(lv)
    assert(c.up > 0 && c.up < prevUp, 'success chance falls by level ' + lv)
    assert(c.broke >= prevBroke, 'destroy chance never falls ' + lv)
    assert(c.up + c.broke + c.fail === 100 && c.fail >= 0, 'chances add to 100 at ' + lv)
    assert(lv >= 5 ? c.broke > 0 : c.broke === 0, 'destroy only from +5 (' + lv + ')')
    assert(S.cost(lv).gold > 0 && (lv === 0 || S.cost(lv).gold > S.cost(lv - 1).gold), 'cost rises ' + lv)
    assert(S.cost(lv).mana === (lv >= 10 && lv < 15 ? 1 : 0) && S.cost(lv).scale === (lv >= 15 ? 1 : 0), 'materials ' + lv)
    prevUp = c.up
    prevBroke = c.broke
  }
  for (let lv = 1; lv <= S.MAX_LV; lv++) assert(S.price(lv) > S.price(lv - 1), 'sell price rises ' + lv)
  eq(S.price(0), 0, '+0 sells for nothing')
  eq(S.swordLabel(0), '+0 녹슨 철검', 'label 0')
  eq(S.swordLabel(7), '+7 은빛 기사검', 'label 7')
  eq(S.swordLabel(20), '+20 추억의 전설검', 'label 20')
  eq(S.tierOf(2), 0, 'tier 2')
  eq(S.tierOf(18), 6, 'tier 18')
  eq(S.won(1234567), '1,234,567', 'won')
  eq(S.helpLine('#'), '검 강화 : #강화 #내검 #사냥 #출석 #결투 #보스 #강화도움', 'help line')
}

// ── 강화: 확률 경계(고정 난수) ────────────────────────────────────────────
{
  const g = game()
  const r = g.run('1', '가', '강화', { rand: fixed(0.94) }) // +0 성공 95%
  assert(r.text.startsWith('[강화 성공]\n가님의 검이 +1 녹슨 철검이 됐어요.'), 'first enhance ' + r.text)
  eq(r.card.kind, 'enhance', 'card kind')
  eq(r.card.result, 'up', 'card result')
  eq(g.u('1').g, S.START_GOLD - S.cost(0).gold, 'gold paid')
  eq(g.u('1').lv, 1, 'level 1')
  eq(g.u('1').b, 1, 'best 1')
  // +9: 성공 50 · 파괴 6 · 실패 44
  const setLv = (lv, gold) => Object.assign(g.u('1'), { lv, g: gold == null ? 100000 : gold, e: 0, w: 0, f: 0 })
  setLv(9)
  eq(g.run('1', '가', '강화', { rand: fixed(0.4999) }).card.result, 'up', '+9 roll 49.99 → up')
  setLv(9)
  const idBefore = g.u('1').id
  const br = g.run('1', '가', '강화', { rand: fixed(0.5) })
  eq(br.card.result, 'broke', '+9 roll 50 → broke')
  assert(br.text.startsWith('[강화 파괴]\n가님의 +9 푸른 서리검이 부서졌어요. 새 +0 녹슨 철검을 받았어요.'), 'broke text ' + br.text)
  eq(g.u('1').lv, 0, 'broke → +0')
  assert(g.u('1').id !== idBefore, 'broke → new sword id')
  eq(g.u('1').k, 1, 'broken count')
  eq(g.u('1').b, 10, 'best record kept after break')
  setLv(9)
  eq(g.run('1', '가', '강화', { rand: fixed(0.56) }).card.result, 'fail', '+9 roll 56 → fail')
  eq(g.u('1').lv, 9, 'fail keeps level')
  // 보호 주문서: 파괴 → 지킴, 주문서 1장 씀
  setLv(9)
  g.u('1').it = { guard: 2 }
  const gd = g.run('1', '가', '강화 보호', { rand: fixed(0.5) })
  eq(gd.card.result, 'guarded', 'guard saves')
  eq(g.u('1').lv, 9, 'guarded level')
  eq(g.u('1').it.guard, 1, 'guard used once')
  assert(gd.text.startsWith('[강화 실패]\n부서질 뻔했지만 보호 주문서가 지켜 줬어요. +9 푸른 서리검 그대로예요.'), 'guarded text ' + gd.text)
  // 실패여도 보호 주문서를 썼으면 사라진다(쓴 만큼)
  setLv(9)
  g.run('1', '가', '강화 보호주문서', { rand: fixed(0.9) })
  eq(g.u('1').it.guard, undefined, 'guard used on a plain fail too')
  // 축복: +10%p
  setLv(9)
  g.u('1').it = { bless: 1 }
  eq(g.run('1', '가', '강화 축복', { rand: fixed(0.59) }).card.result, 'up', 'bless 60%')
  eq(g.u('1').it.bless, undefined, 'bless used')
  // +5 미만에서 보호 주문서는 받지 않고 쓰지도 않는다
  setLv(3)
  g.u('1').it = { guard: 1 }
  const gold = g.u('1').g
  eq(g.run('1', '가', '강화 보호').text, '+3에서는 검이 부서지지 않아요. 보호 주문서는 +5부터 써 주세요.', 'guard below +5')
  eq(g.u('1').it.guard, 1, 'guard kept below +5')
  eq(g.u('1').g, gold, 'no gold paid on refusal')
  // 없는 주문서
  setLv(7)
  g.u('1').it = {}
  eq(g.run('1', '가', '강화 보호').text, '보호 주문서가 없어요. 「!구매 보호 1」로 살 수 있어요.', 'no guard')
  eq(g.run('1', '가', '강화 축복').text, '축복 주문서가 없어요. 「!구매 축복 1」로 살 수 있어요.', 'no bless')
  // 골드 부족 · 재료 부족: 상태 그대로
  setLv(6, 10)
  eq(g.run('1', '가', '강화').text, '골드가 부족해요. +6 강화에는 800G가 필요해요. (보유 10G)\n「!사냥」으로 골드를 모아 보세요.', 'no gold')
  eq(g.u('1').lv, 6, 'no gold → same level')
  setLv(10)
  g.u('1').it = {}
  eq(g.run('1', '가', '강화').text, '+10부터는 강화할 때 마력석이 1개 필요해요. 「!사냥」이나 「!상점」에서 구할 수 있어요.', 'no mana')
  eq(g.u('1').g, 100000, 'no mana → no gold paid')
  g.u('1').it = { mana: 1 }
  g.run('1', '가', '강화', { rand: fixed(0.99) })
  eq(g.u('1').it.mana, undefined, 'mana used')
  eq(g.u('1').g, 100000 - S.cost(10).gold, 'gold at +10')
  setLv(15)
  g.u('1').it = { mana: 3 }
  assert(g.run('1', '가', '강화').text.startsWith('+15부터는 강화할 때 용의 비늘이 1개 필요해요.'), 'no scale')
  g.u('1').it = { scale: 1 }
  g.run('1', '가', '강화', { rand: fixed(0.0) })
  eq(g.u('1').lv, 16, 'scale used, level up')
  eq(g.u('1').it.scale, undefined, 'scale gone')
  // 최고 단계
  setLv(19)
  g.u('1').it = { scale: 1 }
  const top = g.run('1', '가', '강화', { rand: fixed(0.0) })
  eq(top.card.lv, 20, 'reach +20')
  assert(top.text.startsWith('[강화 성공]\n가님의 검이 +20 추억의 전설검이 됐어요.\n') && top.text.endsWith('\n최고 단계예요.') && top.text.split('최고 단계예요.').length === 2, 'top text ' + top.text)
  setLv(20)
  eq(g.run('1', '가', '강화').text, '가님의 검은 이미 최고 단계 +20 추억의 전설검이에요. 「!판매」로 팔 수 있어요.', 'max level')
}

// ── 강화: 씨앗 난수로 확률이 표대로인지(2만 번, 실패 보정 없이) ──────────────
{
  const g = game()
  const rand = seeded(20261017)
  for (const [lv, bless] of [[0, false], [9, false], [9, true], [14, false], [19, false], [19, true]]) {
    const n = 20000
    const got = { up: 0, broke: 0, fail: 0 }
    for (let i = 0; i < n; i++) {
      g.run('p', '확률', '내검')
      Object.assign(g.u('p'), { lv, g: 1e6, e: 0, w: 0, f: 0, it: { mana: 1, scale: 1, bless: 1 } })
      const r = g.run('p', '확률', bless ? '강화 축복' : '강화', { rand })
      got[r.card.result === 'guarded' ? 'broke' : r.card.result]++
    }
    const c = S.chance(lv)
    const up = Math.min(100, c.up + (bless ? S.BLESS_PCT : 0))
    const broke = Math.min(c.broke, 100 - up)
    const pct = (k) => (got[k] * 100) / n
    assert(Math.abs(pct('up') - up) < 1.2, `+${lv}${bless ? ' 축복' : ''} success ${pct('up')} vs ${up}`)
    assert(Math.abs(pct('broke') - broke) < 1.2, `+${lv} destroy ${pct('broke')} vs ${broke}`)
  }
}

// ── 쿨타임: 강화 10초 · 사냥 2분. 한 번만 알리고 그다음은 조용히, 상태는 그대로 ─
{
  const g = game()
  g.run('1', '가', '강화', { rand: fixed(0.5) })
  const gold = g.u('1').g
  eq(g.run('1', '가', '강화').text, '가님, 강화는 10초 뒤에 다시 할 수 있어요.', 'enhance cooldown note')
  g.tick(4000)
  eq(g.run('1', '가', '강화').text, '', 'enhance cooldown silent the second time')
  eq(g.u('1').g, gold, 'cooldown → no gold paid')
  g.tick(6000)
  assert(g.run('1', '가', '강화', { rand: fixed(0.5) }).card, 'enhance after 10s')
  // 다른 사람은 막히지 않는다
  assert(g.run('2', '나', '강화', { rand: fixed(0.5) }).card, 'cooldown is per person')
  // 사냥
  const h = g.run('3', '다', '사냥', { rand: fixed(0.5) })
  const band = h.text.split('\n')
  assert(/^\[사냥\] 다님이 .+(을|를) 잡았어요\.$/.test(band[0]), 'hunt line ' + h.text)
  const gained = g.u('3').g - S.START_GOLD
  assert(gained > 0 && band[1] === `+${S.won(gained)}G (보유 ${S.won(g.u('3').g)}G)`, 'hunt gold line ' + h.text)
  g.tick(60000)
  eq(g.run('3', '다', '사냥').text, '다님, 사냥은 1분 뒤에 다시 할 수 있어요.', 'hunt cooldown note')
  eq(g.run('3', '다', '사냥').text, '', 'hunt cooldown silent')
  g.tick(30500)
  eq(g.run('3', '다', '사냥').text, '', 'still silent until it ends')
  g.tick(29500)
  assert(g.run('3', '다', '사냥', { rand: fixed(0.5) }).text.startsWith('[사냥]'), 'hunt after 2 minutes')
  // 드롭: 난수 0 → 모든 드롭 + 보물(5배)
  g.tick(S.HUNT_CD_MS)
  const before = g.u('3').g
  const all = g.run('3', '다', '사냥', { rand: fixed(0) })
  assert(all.text.includes('보물 상자를 찾았어요. 골드 5배!') && all.text.includes('마력석 1개 · 축복 주문서 1개 · 보호 주문서 1개 · 용의 비늘 1개'), 'all drops ' + all.text)
  eq(g.u('3').g - before, 5 * 80, 'treasure x5 of the lowest roll (초록 슬라임 80)')
  assert(['guard', 'bless', 'mana', 'scale'].every((id) => g.u('3').it[id] === 1), 'drops in inventory ' + JSON.stringify(g.u('3').it))
  // 높은 단계는 센 몬스터
  g.tick(S.HUNT_CD_MS)
  g.u('3').lv = 16
  assert(/심연의 용|타락한 대마법사/.test(g.run('3', '다', '사냥', { rand: fixed(0.3) }).text), 'band by level')
}

// ── 판매 · 상점 ───────────────────────────────────────────────────────────
{
  const g = game()
  g.run('1', '가', '내검')
  eq(g.run('1', '가', '판매').text, '+0 검은 팔 수 없어요. 「!강화」로 먼저 키워 보세요.', 'sell +0')
  Object.assign(g.u('1'), { lv: 5, g: 0 })
  const id5 = g.u('1').id
  eq(g.run('1', '가', '판매').text, `+5 강철 장검을 ${S.won(S.price(5))}G에 팔았어요. (보유 ${S.won(S.price(5))}G)\n새 +0 녹슨 철검을 받았어요.`, 'sell +5')
  assert(g.u('1').lv === 0 && g.u('1').id !== id5 && g.u('1').s === 1, 'sold → new +0 sword')
  Object.assign(g.u('1'), { lv: 12, g: 0 })
  eq(g.run('1', '가', '판매').text, `+12 붉은 화염검을 ${S.won(S.price(12))}G에 팔까요? 팔려면 「!판매 확인」을 입력해 주세요.`, 'sell +12 asks')
  eq(g.u('1').lv, 12, 'not sold before confirm')
  g.run('1', '가', '판매 확인')
  assert(g.u('1').lv === 0 && g.u('1').g === S.price(12), 'sold after confirm')
  // 상점
  const shop = g.run('1', '가', '상점').text
  assert(shop.startsWith('[상점]\n보호 주문서 4,000G : ') && shop.includes('용의 비늘 : +15부터 강화할 때 1개씩 써요 (사냥에서만)') && shop.endsWith('구매 : !구매 보호 1'), 'shop ' + shop)
  g.u('1').g = 10000
  eq(g.run('1', '가', '구매 보호 주문서 2').text, '보호 주문서 2개를 8,000G에 샀어요. (보유 2,000G · 보호 주문서 2개)', 'buy 2 guard')
  eq(g.run('1', '가', '구매 축복 2').text, '골드가 부족해요. 축복 주문서 2개는 4,000G예요. (보유 2,000G)', 'buy no gold')
  eq(g.run('1', '가', '구매 비늘').text, '용의 비늘은 상점에서 팔지 않아요. 사냥이나 거래로 구해 주세요.', 'scale not sold')
  eq(g.run('1', '가', '구매 검').text, '「!구매 보호 1」처럼 입력해 주세요. 목록은 「!상점」에서 볼 수 있어요.', 'buy usage')
  eq(g.run('1', '가', '구매 보호 100').text, '한 번에 1~99개까지 살 수 있어요.', 'buy max')
  eq(g.run('1', '가', '판매 보호 3').text, '보호 주문서가 부족해요. (보유 2개)', 'sell more than owned')
  eq(g.run('1', '가', '판매 보호 2').text, '보호 주문서 2개를 2,000G에 팔았어요. (보유 4,000G)', 'sell items')
  eq(g.u('1').it.guard, undefined, 'items gone')
  g.u('1').it.mana = 999
  g.u('1').g = 1e6
  eq(g.run('1', '가', '구매 마력석 1').text, '마력석은 999개까지 가질 수 있어요.', 'item cap')
  const inv = g.run('1', '가', '인벤').text
  eq(inv, '[인벤] 가님\n골드 1,000,000G · 검 +0 녹슨 철검\n아이템 : 마력석 999', 'inventory')
  const info = g.run('1', '가', '내검')
  eq(info.text, '[내 검] 가님\n+0 녹슨 철검 · 최고 +12\n골드 1,000,000G · 판매가 0G\n아이템 : 마력석 999\n다음 강화 : 100G · 성공 95%', 'info text')
  eq(info.card.kind, 'info', 'info card')
  assert(g.run('1', '가', '강화도움').text.startsWith('《 검 강화 도움말 》\n━━━━━━━━━━━━\n▸ !강화 : '), 'help text')
}

// ── 거래: 읽기 ────────────────────────────────────────────────────────────
{
  const P = (a) => JSON.stringify(S.parseOffer(a))
  eq(P('@김 민수 보호 2 6000'), '{"target":"김 민수","item":"guard","qty":2,"price":6000}', 'parse spaced name')
  eq(P('@a 검 50000'), '{"target":"a","item":"sword","qty":1,"price":50000}', 'parse sword')
  eq(P('@a 보호 주문서 3개'), '{"target":"a","item":"guard","qty":3,"price":0}', 'parse two-word item + qty unit')
  eq(P('@a 마력석 3000골드'), '{"target":"a","item":"mana","qty":1,"price":3000}', 'parse price unit')
  eq(P('@a 마력석 3개 1,500'), '{"target":"a","item":"mana","qty":3,"price":1500}', 'parse qty unit + plain price with comma')
  eq(P('@a 비늘'), '{"target":"a","item":"scale","qty":1,"price":0}', 'parse gift')
  eq(P('@a 마력석 7'), '{"target":"a","item":"mana","qty":1,"price":7}', 'one plain number = price')
  eq(S.parseOffer('a 보호 1 1'), null, 'needs @')
  eq(S.parseOffer('@a 사과 1 1'), null, 'unknown item')
  eq(S.parseOffer('@보호 1'), null, 'no name')
}

// ── 거래: 아이템 ──────────────────────────────────────────────────────────
function sums(g, keys) {
  let gold = 0
  const items = {}
  for (const k of keys) {
    const u = g.u(k)
    gold += u.g
    for (const id of Object.keys(S.ITEMS)) items[id] = (items[id] || 0) + (u.it[id] || 0)
  }
  return JSON.stringify({ gold, items })
}
{
  const g = game()
  g.run('1', '홍길동', '내검')
  g.run('2', '김 민수', '내검')
  g.u('1').it = { guard: 3 }
  const offer = g.run('1', '홍길동', '거래 @김 민수 보호 2 800').text
  eq(offer, '[거래 제안] 홍길동님 → 김 민수님\n보호 주문서 2개 · 800G\n김 민수님, 2분 안에 「!수락」 또는 「!거절」을 입력해 주세요.', 'offer text')
  const before = sums(g, ['1', '2'])
  eq(g.run('2', '김 민수', '수락').text, '[거래 완료] 김 민수님이 홍길동님에게서 보호 주문서 2개를 800G에 샀어요.', 'accept text')
  eq(sums(g, ['1', '2']), before, 'trade conserves gold and items')
  eq(g.u('1').it.guard, 1, 'seller items')
  eq(g.u('2').it.guard, 2, 'buyer items')
  eq(g.u('1').g, S.START_GOLD + 800, 'seller gold')
  eq(g.u('2').g, S.START_GOLD - 800, 'buyer gold')
  eq(g.run('2', '김 민수', '수락'), null, 'second accept → no trade (no duplicate)')
  eq(g.s().t.length, 0, 'trade removed')
  // 제안 뒤 판 사람이 아이템을 팔아 버림 → 수락 때 취소(복제 없음)
  g.u('1').it = { mana: 2 }
  g.run('1', '홍길동', '거래 @김 민수 마력석 2 100')
  g.run('1', '홍길동', '판매 마력석 1')
  eq(g.run('2', '김 민수', '수락').text, '홍길동님의 마력석이 부족해서 거래를 취소했어요.', 'seller lost items → cancelled')
  eq(g.u('2').it.mana, undefined, 'buyer got nothing')
  eq(g.u('1').it.mana, 1, 'seller keeps the rest')
  // 산 사람 골드 부족 → 제안은 남고, 골드가 생기면 수락된다
  g.u('2').g = 50
  g.run('1', '홍길동', '거래 @김 민수 마력석 1 100')
  eq(g.run('2', '김 민수', '수락').text, '골드가 부족해요. 100G가 필요해요. (보유 50G)', 'buyer short of gold')
  eq(g.s().t.length, 1, 'offer kept')
  g.u('2').g = 100
  assert(g.run('2', '김 민수', '수락').text.startsWith('[거래 완료]'), 'accept after getting gold')
  eq(g.u('2').g, 0, 'buyer paid')
  // 거절 · 취소 · 만료
  g.u('1').it = { bless: 1 }
  g.run('1', '홍길동', '거래 @김 민수 축복')
  eq(g.run('2', '김 민수', '거절').text, '[거래 거절] 김 민수님이 홍길동님의 제안을 거절했어요.', 'reject')
  eq(g.run('2', '김 민수', '수락'), null, 'nothing after reject')
  g.run('1', '홍길동', '거래 @김 민수 축복')
  eq(g.run('1', '홍길동', '거래취소').text, '보낸 거래 제안을 취소했어요.', 'cancel')
  eq(g.run('1', '홍길동', '거래취소').text, '보낸 거래 제안이 없어요.', 'cancel none')
  g.run('1', '홍길동', '거래 @김 민수 축복')
  g.tick(S.TRADE_TTL_MS)
  eq(g.run('2', '김 민수', '수락'), null, 'expired offer')
  eq(g.u('1').it.bless, 1, 'expired → seller keeps it')
  // 무료(선물)
  g.run('1', '홍길동', '거래 @김 민수 축복')
  eq(g.run('2', '김 민수', '수락').text, '[거래 완료] 김 민수님이 홍길동님에게서 축복 주문서 1개를 받았어요.', 'gift accepted')
  // 잘못된 제안들
  eq(g.run('1', '홍길동', '거래').text, '「!거래 @상대 보호 1 3000」처럼 입력해 주세요. (아이템 수량 가격 · 검은 「!거래 @상대 검 50000」)', 'offer usage')
  eq(g.run('1', '홍길동', '거래 @없는사람 보호 1 1').text, '「없는사람」님을 찾지 못했어요. 상대가 먼저 「!내검」을 한 번 입력해야 거래할 수 있어요.', 'unknown target')
  eq(g.run('1', '홍길동', '거래 @홍길동 보호 1 1').text, '「홍길동」님을 찾지 못했어요. 상대가 먼저 「!내검」을 한 번 입력해야 거래할 수 있어요.', 'self by name')
  g.u('1').it = { guard: 1 }
  eq(g.run('1', '홍길동', '거래 @김 민수 보호 1 100000001').text, '가격은 0~100,000,000G로 입력해 주세요.', 'price max')
  eq(g.run('1', '홍길동', '거래 @김 민수 보호 2 10').text, '보호 주문서가 부족해요. (보유 1개)', 'offer more than owned')
  eq(g.run('1', '홍길동', '거래 @김 민수 검 10').text, '+0 검은 거래할 수 없어요.', 'no +0 sword trade')
  // 멘션 아이디로 찾는다(글자 이름이 바뀌었어도)
  g.run('3', '세번째', '내검')
  const m = g.run('1', '홍길동', '거래 @예전이름 보호 1 1', { mentions: ['3'] }).text
  assert(m.startsWith('[거래 제안] 홍길동님 → 세번째님'), 'mention resolves target ' + m)
  // 받는 사람이 이미 다른 제안을 받는 중
  g.run('2', '김 민수', '내검')
  g.u('2').it = { mana: 1 }
  eq(g.run('2', '김 민수', '거래 @세번째 마력석 1 1').text, '세번째님이 다른 거래 제안을 받고 있어요. 잠시 뒤 다시 해 주세요.', 'target busy')
  // 새 제안은 먼저 보낸 제안을 바꾼다
  g.u('1').it = { guard: 2 }
  const re = g.run('1', '홍길동', '거래 @세번째 보호 2 2').text
  assert(re.endsWith('(먼저 보낸 제안은 취소했어요)') && g.s().t.length === 1 && g.s().t[0].q === 2, 'replace own offer')
  // 같은 이름 둘이면 멘션 없이는 고르지 않는다
  g.run('4', '세번째', '내검')
  g.run('2', '김 민수', '거래취소')
  assert(g.run('2', '김 민수', '거래 @세번째 마력석 1 1').text.includes('찾지 못했어요'), 'ambiguous name')
}

// ── 거래: 검 ──────────────────────────────────────────────────────────────
{
  const g = game()
  g.run('1', '판매자', '내검')
  g.run('2', '구매자', '내검')
  Object.assign(g.u('1'), { lv: 12, b: 12 })
  Object.assign(g.u('2'), { lv: 3, g: 100000 })
  const sid = g.u('1').id
  eq(g.run('1', '판매자', '거래 @구매자 검 50000').text, '[거래 제안] 판매자님 → 구매자님\n+12 붉은 화염검 · 50,000G\n구매자님, 2분 안에 「!수락」 또는 「!거절」을 입력해 주세요.', 'sword offer')
  eq(g.run('2', '구매자', '수락').text, '구매자님은 이미 +3 검을 가지고 있어요. 「!판매」로 먼저 판 뒤 「!수락」을 입력해 주세요.', 'buyer has a sword')
  g.run('2', '구매자', '판매')
  eq(g.run('2', '구매자', '수락').text, '[거래 완료] 구매자님이 판매자님에게서 +12 붉은 화염검을 50,000G에 샀어요.', 'sword bought')
  assert(g.u('2').lv === 12 && g.u('2').id === sid && g.u('2').b === 12, 'buyer has the sword')
  assert(g.u('1').lv === 0 && g.u('1').id !== sid && g.u('1').b === 12, 'seller has a new +0')
  const ids = Object.values(g.s().u).map((u) => u.id)
  eq(new Set(ids).size, ids.length, 'sword ids stay unique')
  // 제안 뒤 강화하면 다른 검 → 취소
  g.run('3', '셋', '내검')
  g.run('2', '구매자', '거래 @셋 검 1')
  g.u('2').it = { mana: 1 }
  g.run('2', '구매자', '강화', { rand: fixed(0) })
  eq(g.run('3', '셋', '수락').text, '구매자님의 검이 바뀌어서 거래를 취소했어요.', 'sword changed → cancelled')
  eq(g.u('2').lv, 13, 'seller keeps the upgraded sword')
  // 제안 뒤 부서짐 → 취소
  g.tick(S.ENHANCE_CD_MS)
  g.run('2', '구매자', '거래 @셋 검 1')
  g.u('2').it = { mana: 1 }
  g.run('2', '구매자', '강화', { rand: fixed(0.4) }) // +13: 성공 30 · 파괴 14 → 0.4 = 파괴
  eq(g.u('2').lv, 0, 'broke')
  eq(g.run('3', '셋', '수락').text, '구매자님의 검이 바뀌어서 거래를 취소했어요.', 'broken sword → cancelled')
  eq(g.u('3').lv, 0, 'nobody got a broken sword')
}

// ── 아무렇게나 한 3,000번: 음수·한도 초과·검 복제가 없다 ─────────────────
{
  const g = game()
  const rand = seeded(7)
  const keys = ['1', '2', '3', '4']
  const names = { 1: '가', 2: '나', 3: '다', 4: '라' }
  let done = 0
  let swords = 0
  const cmds = ['강화', '강화 보호', '강화 축복', '사냥', '판매', '판매', '판매 확인', '구매 보호 1', '구매 축복 2', '구매 마력석 1', '판매 마력석 1', '거래취소', '수락', '수락', '수락', '거절', '내검']
  for (const k of keys) {
    g.run(k, names[k], '내검')
    Object.assign(g.u(k), { g: 200000, lv: k <= '2' ? 6 : 0, b: 6, it: { guard: 20, bless: 20, mana: 20, scale: 20 } })
  }
  for (let i = 0; i < 3000; i++) {
    const k = keys[Math.floor(rand() * 4)]
    let line = cmds[Math.floor(rand() * cmds.length)]
    if (rand() < 0.3) {
      const to = names[keys[Math.floor(rand() * 4)]]
      const what = ['검', '보호', '축복', '마력석', '비늘'][Math.floor(rand() * 5)]
      line = `거래 @${to} ${what} ${1 + Math.floor(rand() * 2)} ${Math.floor(rand() * 3000)}`
    }
    const before = JSON.stringify(g.rt)
    const r = g.run(k, names[k], line, { rand })
    if (/^수락/.test(line) && r && r.text.startsWith('[거래 완료]')) {
      const t = JSON.parse(before).sword.r.t.find((x) => x.to === k)
      const was = JSON.parse(before).sword.r.u
      const gold = (u) => u.g
      done++
      if (t.it === 'sword') swords++
      eq(gold(was[t.f]) + gold(was[k]), g.u(t.f).g + g.u(k).g, 'fuzz: gold moves, not made')
      if (t.it !== 'sword') eq((was[t.f].it[t.it] || 0) + (was[k].it[t.it] || 0), (g.u(t.f).it[t.it] || 0) + (g.u(k).it[t.it] || 0), 'fuzz: items move, not made')
    }
    for (const kk of Object.keys(g.s().u)) {
      const u = g.u(kk)
      assert(u.g >= 0 && u.g <= S.MAX_GOLD && u.lv >= 0 && u.lv <= S.MAX_LV && u.b >= u.lv, 'fuzz: bounds ' + JSON.stringify(u))
      for (const id of Object.keys(u.it)) assert(S.ITEMS[id] && u.it[id] > 0 && u.it[id] <= S.MAX_ITEM, 'fuzz: items ' + JSON.stringify(u.it))
    }
    const ids = Object.values(g.s().u).map((u) => u.id)
    eq(new Set(ids).size, ids.length, 'fuzz: one sword per id')
    g.tick(1000 + Math.floor(rand() * 20000))
  }
  assert(done >= 20 && swords >= 1, `fuzz really traded (${done} trades, ${swords} swords)`)
}

// ── 저장·정리 ─────────────────────────────────────────────────────────────
{
  const g = game()
  for (let i = 0; i < S.MAX_USERS; i++) {
    g.run(String(1000 + i), '사람' + i, '내검')
    g.tick(1000)
  }
  eq(Object.keys(g.s().u).length, S.MAX_USERS, 'filled to the cap')
  // 가장 오래된 사람(1000)이 거래 중이면 남고, 그다음(1001)이 정리된다
  g.u('1000').it = { guard: 1 }
  g.u('1000').a = 0
  g.u('1001').a = 1
  g.run('1000', '사람0', '거래 @사람2 보호 1 1')
  g.u('1000').a = 0
  g.run('new', '새사람', '내검')
  eq(Object.keys(g.s().u).length, S.MAX_USERS, 'still at the cap')
  assert(g.u('1000') && !g.u('1001') && g.u('new'), 'oldest idle user pruned, trading user kept')
  // 180일 넘게 안 한 사람은 새 사람이 올 때 정리
  g.u('1003').a = g.now - S.IDLE_MS - 1
  g.run('new2', '또새사람', '내검')
  assert(!g.u('1003') && g.u('1002'), 'idle user pruned (trade target kept)')
  // 크기: 200명 꽉 차도 작다
  const size = JSON.stringify(g.rt.sword).length
  assert(size < 60000, 'runtime size ' + size)
  // JSON 으로 저장했다 읽어도 그대로 이어진다
  const g2 = game()
  g2.run('1', '가', '내검')
  Object.assign(g2.u('1'), { lv: 9, g: 5000, it: { guard: 1 } })
  const saved = JSON.parse(JSON.stringify(g2.rt))
  const r1 = S.run(saved, 'r', { cmd: '강화', arg: '보호', key: '1', name: '가', prefix: '!', now: g2.now, rand: fixed(0.5) })
  eq(r1.card.result, 'guarded', 'continues after a JSON round trip')
  // 망가진 저장본
  const bad = { sword: { r: { u: { x: { g: '-5', lv: 99, it: { foo: 3, guard: '2', bless: -1 } }, y: null }, t: 'nope', q: 'a' } } }
  const r2 = S.run(bad, 'r', { cmd: '인벤', arg: '', key: 'x', name: '엑스', prefix: '!', now: T0, rand: fixed(0.5) })
  eq(r2.text, '[인벤] 엑스님\n골드 0G · 검 +20 추억의 전설검\n아이템 : 보호 주문서 2', 'broken saved state is cleaned')
  assert(Array.isArray(bad.sword.r.t) && bad.sword.r.q >= 1, 'broken lists fixed')
  // 방이 따로
  const two = {}
  S.run(two, 'a', { cmd: '내검', arg: '', key: '1', name: '가', prefix: '!', now: T0, rand: fixed(0.5) })
  eq(S.run(two, 'b', { cmd: '강화랭킹', arg: '', key: '1', name: '가', prefix: '!', now: T0 }).text, '아직 강화 기록이 없어요. 「!강화」로 시작해 보세요.', 'rooms are separate')
}

// ── 실패 보정 · 방 최고 기록 · 위로금 ─────────────────────────────────────
{
  const g = game()
  g.run('1', '가', '내검')
  // +9 성공 50%: 실패 2번 → 보정 +4% → 53.99 는 성공
  Object.assign(g.u('1'), { lv: 9, g: 100000, e: 0, w: 0, f: 0, it: { mana: 9 } })
  eq(g.run('1', '가', '강화', { rand: fixed(0.6) }).card.result, 'fail', 'pity: first fail')
  eq(g.u('1').f, 1, 'pity: one fail counted')
  g.tick(S.ENHANCE_CD_MS)
  const f2 = g.run('1', '가', '강화', { rand: fixed(0.6) })
  eq(f2.card.pity, 4, 'pity: card shows +4 for the next try')
  assert(f2.text.includes('실패 보정 +2%가 적용됐어요.') && f2.text.includes('성공 54%(보정 +4%)'), 'pity text ' + f2.text)
  g.tick(S.ENHANCE_CD_MS)
  const up = g.run('1', '가', '강화', { rand: fixed(0.5399) })
  eq(up.card.result, 'up', 'pity: 53.99 succeeds with +4')
  eq(g.u('1').f, 0, 'pity resets on success')
  // +10 은 방 최고 기록(처음 +10 이상)
  assert(up.text.includes('[방 최고 기록] 이 방에서 처음 나온 +10 푸른 서리검이에요!') && up.card.notes.includes('방 최고 기록'), 'room record ' + up.text)
  eq(g.s().top.lv, 10, 'room record saved')
  // 보정은 최대 +10
  eq(S.pityOf(3), 6, 'pity 3')
  eq(S.pityOf(40), S.PITY_MAX, 'pity max')
  // 다른 사람이 +10 을 다시 만들면 기록이 아니다
  g.run('2', '나', '내검')
  Object.assign(g.u('2'), { lv: 9, g: 100000, it: { mana: 9 } })
  const again = g.run('2', '나', '강화', { rand: fixed(0.1) })
  assert(!again.text.includes('방 최고 기록') && !again.card.notes.length, 'same level is not a new record')
  // +12 이 부서지면 판매가의 10% 위로금, 보정은 0
  Object.assign(g.u('1'), { lv: 12, g: 100000, e: 0, w: 0, f: 3, it: { mana: 9 } })
  const before = g.u('1').g
  const br = g.run('1', '가', '강화', { rand: fixed(0.999 - 0.2) }) // 35+6=41 성공 · 파괴 12 → 41~53, 79.9 는 실패
  eq(br.card.result, 'fail', 'pity +6: 79.9 is still a fail at +12')
  Object.assign(g.u('1'), { e: 0, w: 0, f: 0 })
  const br2 = g.run('1', '가', '강화', { rand: fixed(0.4) })
  eq(br2.card.result, 'broke', '+12 roll 40 → broke')
  eq(g.u('1').g, before - S.cost(12).gold * 2 + Math.floor(S.price(12) / 10), 'comfort gold paid')
  assert(br2.text.includes(`위로금 ${S.won(S.price(12) / 10)}G 받았어요.`) && br2.card.notes[0] === `위로금 ${S.won(S.price(12) / 10)}G`, 'comfort text ' + br2.text)
  eq(g.u('1').f, 0, 'pity resets on break')
  // 낮은 단계는 위로금 없음
  Object.assign(g.u('1'), { lv: 6, e: 0, w: 0 })
  assert(!g.run('1', '가', '강화', { rand: fixed(0.66) }).text.includes('위로금'), 'no comfort below +10')
}

// ── 출석 ──────────────────────────────────────────────────────────────────
{
  const g = game()
  const a1 = g.run('1', '가', '출석')
  eq(a1.text, `[출석] 가님 출석했어요.\n+400G (보유 1,400G)\n6일 더 연속으로 오면 보호 주문서·축복 주문서를 받아요.`, 'attend day 1')
  eq(g.run('1', '가', '출첵').text, '가님은 오늘 이미 출석했어요. (1일 연속) 내일 또 와 주세요.', 'attend twice a day')
  for (let d = 2; d <= 7; d++) {
    g.tick(24 * 3600 * 1000)
    const r = g.run('1', '가', '출석')
    if (d === 2) assert(r.text.startsWith('[출석] 가님 2일 연속 출석!\n+500G'), 'attend day 2 ' + r.text)
    if (d === 7) eq(r.text, `[출석] 가님 7일 연속 출석!\n+1,000G · 보호 주문서 1개 · 축복 주문서 1개 (보유 ${S.won(g.u('1').g)}G)\n7일 연속 보너스를 받았어요.`, 'attend day 7')
  }
  eq(g.u('1').it.guard, 1, 'week bonus guard')
  g.tick(2 * 24 * 3600 * 1000) // 하루 건너뜀
  assert(g.run('1', '가', '출석').text.startsWith('[출석] 가님 출석했어요.\n+400G'), 'streak resets after a missed day')
  // 날은 KST 자정에 바뀐다(T0 = KST 정오)
  eq(S.dayNo(T0 + 11 * 3600 * 1000 + 59 * 60 * 1000) , S.dayNo(T0), 'KST 23:59 same day')
  eq(S.dayNo(T0 + 12 * 3600 * 1000), S.dayNo(T0) + 1, 'KST midnight next day')
}

// ── 결투 ──────────────────────────────────────────────────────────────────
{
  const g = game()
  g.run('1', '가', '내검')
  g.run('2', '나', '내검')
  Object.assign(g.u('1'), { lv: 12, g: 10000 })
  Object.assign(g.u('2'), { lv: 9, g: 5000 })
  eq(S.duelChance(12, 9), 62, 'duel chance +3 levels')
  eq(S.duelChance(20, 0), 90, 'duel chance cap')
  eq(S.duelChance(0, 20), 10, 'duel chance floor')
  eq(g.run('1', '가', '결투').text, '「!결투 @상대」 또는 골드를 걸어 「!결투 @상대 3000」처럼 입력해 주세요.', 'duel usage')
  eq(g.run('1', '가', '결투 @없는사람').text.startsWith('「없는사람」님을 찾지 못했어요.'), true, 'duel unknown target')
  eq(g.run('1', '가', '결투 @나 6000').text, '나님의 골드가 6,000G보다 적어요. 내기를 줄여 주세요.', 'duel bet above target gold')
  const o = g.run('1', '가', '결투 @나 3000')
  eq(o.text, '[결투 신청] 가(+12) → 나(+9)\n내기 3,000G · 가님 승률 62%\n나님, 2분 안에 「!수락」 또는 「!거절」을 입력해 주세요.', 'duel offer')
  eq(S.offerAt(g.rt, 'r', '2', g.now), g.now, 'duel offer is visible to 수락 routing')
  // 받은 사람이 수락 → 61.99 는 신청한 사람 승
  const r = g.run('2', '나', '수락', { rand: fixed(0.6199) })
  assert(r.text.startsWith('[결투] 가(+12) vs 나(+9)\n가님의 붉은 화염검이 푸른 서리검을 ') && r.text.includes('\n승리 : 가님 +3,000G\n전적 : 가 1승 0패 · 나 0승 1패'), 'duel result ' + r.text)
  eq(g.u('1').g + g.u('2').g, 15000, 'duel moves gold, not made')
  eq(g.u('1').g, 13000, 'winner takes the bet')
  eq(g.s().t.length, 0, 'duel offer used')
  // 신청은 30초에 한 번, 거절, 낮은 검의 대역전
  eq(g.run('1', '가', '결투 @나').text, '가님, 결투 신청은 30초 뒤에 다시 할 수 있어요.', 'duel cooldown')
  g.tick(S.DUEL_CD_MS)
  g.run('2', '나', '결투 @가')
  eq(g.run('1', '가', '거절').text, '[결투 거절] 가님이 나님의 결투를 거절했어요.', 'duel refused')
  g.tick(S.DUEL_CD_MS)
  g.run('2', '나', '결투 @가 1000')
  const up = g.run('1', '가', '수락', { rand: fixed(0.3) }) // 나 승률 38% → 30 은 나 승(역전 아님)
  assert(up.text.includes('나님의 푸른 서리검이 붉은 화염검을') && !up.text.includes('대역전'), 'underdog wins ' + up.text)
  Object.assign(g.u('2'), { lv: 0 })
  g.tick(S.DUEL_CD_MS)
  g.run('2', '나', '결투 @가')
  assert(g.run('1', '가', '수락', { rand: fixed(0.01) }).text.includes('대역전! 나님의 녹슨 철검이'), 'upset is called out')
  // 수락할 때 신청한 사람 골드가 모자라면 취소
  g.tick(S.DUEL_CD_MS)
  g.run('2', '나', '결투 @가 100')
  g.u('2').g = 0
  eq(g.run('1', '가', '수락').text, '나님의 골드가 부족해서 결투를 취소했어요.', 'duel cancelled when bet is gone')
  // 멘션으로도
  g.tick(S.DUEL_CD_MS)
  assert(g.run('1', '가', '결투 @나나', { mentions: ['2'] }).text.startsWith('[결투 신청] 가(+12) → 나(+0)'), 'duel by mention')
}

// ── 방 보스 ────────────────────────────────────────────────────────────────
{
  const g = game()
  for (const [k, n, lv] of [['1', '가', 12], ['2', '나', 5], ['3', '다', 0]]) {
    g.run(k, n, '내검')
    Object.assign(g.u(k), { lv, g: 0 })
  }
  eq(S.hitBase(0), 60, 'hit +0')
  eq(S.hitBase(10), 1260, 'hit +10')
  eq(S.hitBase(20), 4060, 'hit +20')
  const b = g.run('1', '가', '보스')
  eq(b.text, '[보스 등장] 거대 왕슬라임이 나타났어요!\n체력 4,000\n「!공격」으로 함께 쓰러뜨리면 피해량만큼 골드를 나눠 받아요.', 'boss appears')
  // rand 0.5 → 피해 ×1.0, 치명타 없음(0.5 ≥ 0.1)
  eq(g.run('1', '가', '공격', { rand: fixed(0.5) }).text, '[공격] 가님이 거대 왕슬라임에게 1,692 피해!\n남은 체력 2,308 / 4,000\n■■■■■■□□□□', 'attack')
  eq(g.run('1', '가', '공격').text, '가님, 공격은 1분 뒤에 다시 할 수 있어요.', 'attack cooldown')
  eq(g.run('1', '가', '공격').text, '', 'attack cooldown said once')
  const crit = g.run('2', '나', '공격', { rand: fixed(0.05) }) // 치명타 ×2, 피해 ×0.82
  eq(crit.text.split('\n')[0], `[공격] 나님이 거대 왕슬라임에게 ${S.won(Math.round(S.hitBase(5) * 0.82 * 2))} 피해! (치명타)`, 'critical hit')
  assert(g.run('3', '다', '보스').text.startsWith('[보스] 거대 왕슬라임\n체력 ') && g.run('3', '다', '보스').text.endsWith('참여 2명 · 「!공격」으로 함께 쓰러뜨려요.'), 'boss status')
  g.run('3', '다', '공격', { rand: fixed(0.5) })
  g.tick(S.ATTACK_CD_MS)
  const kill = g.run('1', '가', '공격', { rand: fixed(0.5) })
  assert(kill.text.includes('[보스 처치] 가님의 마지막 일격으로 거대 왕슬라임을 쓰러뜨렸어요!\n마지막 일격 : 가님 (용의 비늘 · 보호 주문서)\n가장 큰 피해 : 가님 (축복 주문서 2개)\n1. 가 '), 'boss killed ' + kill.text)
  assert(kill.text.endsWith('다음 보스는 30분 뒤에 나타나요.'), 'next boss time')
  const paid = ['1', '2', '3'].map((k) => g.u(k).g)
  assert(paid.every((x) => x >= 100) && paid.reduce((a, x) => a + x, 0) <= 4000 * S.BOSS_REWARD + 300 && paid[0] > paid[1] && paid[1] > paid[2], 'reward split by damage ' + paid)
  eq(g.u('1').it.scale, 1, 'last hit scale')
  eq(g.u('1').it.bless, 2, 'mvp bless')
  eq(g.s().r, null, 'boss gone')
  eq(g.s().bk, 1, 'boss count')
  eq(g.run('2', '나', '공격').text, '다음 보스는 30분 뒤에 나타나요.', 'no boss during the gap')
  g.tick(S.BOSS_GAP_MS)
  assert(g.run('2', '나', '공격', { rand: fixed(0.5) }).text.startsWith('[보스 등장] 고블린 족장이 나타났어요!\n체력 8,000\n「!공격」으로 함께 쓰러뜨리면 피해량만큼 골드를 나눠 받아요.\n[공격] 나님이 고블린 족장에게'), 'attack spawns the next boss')
  // 하루 안에 못 쓰러뜨리면 도망
  g.tick(S.BOSS_TTL_MS)
  eq(g.run('3', '다', '보스').text, '고블린 족장이 도망갔어요.\n다음 보스는 30분 뒤에 나타나요.', 'boss flees')
  eq(g.s().bk, 1, 'fled boss is not counted')
  // 다섯을 다 쓰러뜨린 뒤에는 체력 1.5배
  g.s().bk = 5
  g.tick(S.BOSS_GAP_MS)
  assert(g.run('3', '다', '보스').text.startsWith('[보스 등장] 거대 왕슬라임이 나타났어요!\n체력 6,000'), 'second round is tougher')
  // 망가진 저장본은 지운다
  g.s().r = { i: 99, hp: 1, mx: 1, d: {} }
  S.roomState(g.rt, 'r')
  eq(g.s().r, null, 'bad boss dropped')
}

// ── 결투·보스 아무렇게나 2,000번: 골드가 생기지 않고(보스 보상 빼고) 한도를 지킨다 ──
{
  const g = game()
  const rand = seeded(11)
  const keys = ['1', '2', '3']
  const names = { 1: '가', 2: '나', 3: '다' }
  for (const k of keys) {
    g.run(k, names[k], '내검')
    Object.assign(g.u(k), { g: 50000, lv: Number(k) * 5 })
  }
  for (let i = 0; i < 2000; i++) {
    const k = keys[Math.floor(rand() * 3)]
    const to = names[keys[Math.floor(rand() * 3)]]
    const line = [`결투 @${to} ${Math.floor(rand() * 60000)}`, `결투 @${to}`, '수락', '거절', '공격', '보스', '출석'][Math.floor(rand() * 7)]
    const before = keys.reduce((n, kk) => n + g.u(kk).g, 0)
    const r = g.run(k, names[k], line, { rand })
    const after = keys.reduce((n, kk) => n + g.u(kk).g, 0)
    if (r && r.text.startsWith('[결투]')) eq(after, before, 'fuzz duel: gold moves, not made')
    for (const kk of keys) {
      const u = g.u(kk)
      assert(u.g >= 0 && u.g <= S.MAX_GOLD && Number.isFinite(u.g), 'fuzz duel bounds ' + JSON.stringify(u))
    }
    const r2 = g.s().r
    if (r2) assert(r2.hp > 0 && r2.hp <= r2.mx, 'fuzz boss hp')
    g.tick(1000 + Math.floor(rand() * 60000))
  }
}

// ── 랭킹 ──────────────────────────────────────────────────────────────────
{
  const g = game()
  for (const [k, n, lv, b] of [['1', '가', 3, 5], ['2', '나', 12, 12], ['3', '다', 3, 9], ['4', '라', 0, 0]]) {
    g.run(k, n, '내검')
    Object.assign(g.u(k), { lv, b })
  }
  const r = g.run('1', '가', '강화랭킹')
  eq(r.text, '[강화 랭킹]\n1. 나 +12 붉은 화염검 (최고 +12)\n2. 다 +3 강철 장검 (최고 +9)\n3. 가 +3 강철 장검 (최고 +5)', 'ranking text')
  eq(r.card.rows.length, 3, 'ranking leaves out people who never enhanced')
  eq(g.run('1', '가', '검랭킹').text, r.text, 'alias')
}

// ── 그림 ──────────────────────────────────────────────────────────────────
{
  for (let lv = 0; lv <= S.MAX_LV; lv++) {
    const a = A.swordSvg(lv, 'x')
    eq(A.swordSvg(lv, 'x').body, a.body, 'sword svg is deterministic ' + lv)
    assert(a.len > 300 && a.body.includes('<path') && !/NaN|undefined/.test(a.defs + a.body), 'sword svg ' + lv)
  }
  const b = A.swordSvg(12, 'k', { broken: true })
  assert(b.body.includes('saturate') || b.defs.includes('saturate'), 'broken sword is grey')
  // 묶음마다 그려 둔 검 그림(assets/swords): 8장 모두 있고, 서로 다르고, 진열장·랭킹이 그 그림을 쓴다
  const arts = new Set()
  for (const t of S.TIERS) {
    const art = A.artOf(t.from)
    assert(art && art.uri.startsWith('data:image/png;base64,') && art.w > 40 && art.h > 300, 'sword art for tier ' + t.name)
    arts.add(art && art.uri)
  }
  eq(arts.size, S.TIERS.length, 'every tier has its own sword art')
  eq(A.artOf(S.MAX_LV), A.artOf(20), 'top level uses the last tier art')
  const up = A.cardSvg({ kind: 'info', lv: 13, best: 13, owner: '하늘', gold: 1, price: 1, broken: 0, items: [], next: null })
  assert(up.includes(A.artOf(13).uri) && !up.includes(A.artOf(12 - 3).uri), 'showcase shows the tier art')
  const brk = A.cardSvg({ kind: 'enhance', result: 'broke', from: 18, lv: 0, best: 18, owner: '구름', gold: 0, spent: 1, used: [] })
  assert(brk.includes(A.artOf(18).uri) && brk.includes('saturate') && (brk.split(A.artOf(18).uri).length - 1) === 2, 'broken: the old sword in two grey pieces')
  const rk = A.cardSvg({ kind: 'rank', rows: [{ name: '가', lv: 20, best: 20 }, { name: '나', lv: 0, best: 0 }] })
  assert(rk.includes(A.artOf(20).uri) && rk.includes(A.artOf(0).uri), 'rank rows show the tier art')
  const cards = [
    { kind: 'enhance', result: 'up', from: 6, lv: 7, best: 7, owner: '<b>&"이름\'', gold: 3200, spent: 800, used: ['축복 주문서'], seed: 1 },
    { kind: 'enhance', result: 'broke', from: 12, lv: 0, best: 12, owner: '하늘', gold: 0, spent: 3000, used: [], seed: 2 },
    { kind: 'enhance', result: 'guarded', from: 16, lv: 16, best: 16, owner: '바람', gold: 1, spent: 6000, used: ['보호 주문서'], seed: 3 },
    { kind: 'enhance', result: 'fail', from: 19, lv: 19, best: 19, owner: '구름', gold: 1, spent: 10000, used: [], seed: 4 },
    { kind: 'enhance', result: 'up', from: 19, lv: 20, best: 20, owner: '별', gold: 1, spent: 10000, used: [], seed: 5 },
    { kind: 'info', lv: 0, best: 0, owner: '새싹', gold: 1000, price: 0, broken: 0, items: [{ name: '보호 주문서', n: 0 }], next: { gold: 100, up: 95, broke: 0, mana: 0, scale: 0 }, seed: 6 },
    { kind: 'info', lv: 20, best: 20, owner: '전설', gold: 1, price: 250000, broken: 9, items: [], next: null, seed: 7 },
    { kind: 'rank', rows: [{ name: '가', lv: 20, best: 20 }, { name: '나'.repeat(40), lv: 1, best: 3 }] },
  ]
  for (const c of cards) {
    const svg = A.cardSvg(c)
    // 붙인 그림(base64) 안의 글자는 빼고 본다
    assert(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg"') && svg.endsWith('</svg>') && !/NaN|undefined/.test(svg.replace(/data:image\/png;base64,[A-Za-z0-9+/=]+/g, '')), 'card svg ' + c.kind + ' ' + c.result)
    eq(A.cardSvg(c), svg, 'card svg deterministic')
  }
  const esc = A.cardSvg(cards[0])
  assert(esc.includes('&lt;b&gt;&amp;&quot;이름&#39;님의 검') && !esc.includes('<b>'), 'names are escaped in the card')
  eq(A.cardSvg({ kind: 'nope' }), '', 'unknown card')
  // PNG 로 보낼 때는 진열장(검·빛)을 한 번 그려 둔 그림으로 붙인다. 벡터 SVG 와 글 부분은 같다
  if (Card.available()) {
    const emb = A.cardSvg(cards[0], { embed: true })
    assert(emb.includes('<image x="34" y="34" width="312" height="446" href="data:image/png;base64,') && !emb.includes('feGaussianBlur'), 'embedded showcase')
    eq(A.cardSvg(cards[0], { embed: true }), emb, 'embedded card deterministic (cache)')
    assert(emb.includes('강화 성공') && emb.includes('&lt;b&gt;'), 'embedded card keeps the text')
  }
  if (Card.available()) {
    for (const c of [cards[0], cards[1], cards[5], cards[7]]) assert(PNG(A.cardPng(c)), 'card renders to PNG ' + c.kind)
  } else {
    eq(A.cardPng(cards[0]), null, 'no renderer → null (text is sent instead)')
    process.stdout.write('sword: PNG renderer not available, image checks skipped\n')
  }
}

// ── features.mjs · roomfeat 연결 ──────────────────────────────────────────
{
  const D = R.normRoomConfig({})
  eq(D.games.sword, true, 'games.sword default on')
  eq(R.normRoomConfig({ games: { sword: 'x' } }).games.sword, true, 'bad saved sword → default')
  eq(R.normRoomConfig({ games: { sword: false } }).games.sword, false, 'sword off saved')
  const mk = (cfg, products) => ({ chat_id: '77', link_name: '검방', products: products || { roombot: false, minigame: true }, perm: 2, state: 'active', cfg: R.normRoomConfig(cfg || {}), runtime: {} })
  const v = mk({ cmdPrefix: '#' })
  eq(R.adapterRecord(v, 'b').config.minigame.sword, true, 'adapter passes games.sword')
  const games = (p) => ['끝말잇기', '숫자야구', '주사위', '가위바위보', '퀴즈', '힌트', '정답', '포기', '랭킹'].map((c) => p + c)
  eq(R.helpLine(v), helpCard('K bot 명령어', [{ name: '미니게임', cmds: games('#') }, { name: '검 강화', cmds: S.helpCommands('#') }]), 'helpLine sword block')
  eq(R.helpLine(mk({ games: { sword: false } })), helpCard('K bot 명령어', [{ name: '미니게임', cmds: games('!') }]), 'helpLine without sword')
  assert(!R.helpLine(v).includes('몬스터') && R.normRoomConfig({ games: { monster: true } }).games.monster === undefined, 'no monster game')
  const both = mk({ profile: { enabled: true } }, { roombot: true, minigame: true })
  both.perm = 4
  const hb = R.helpLine(both)
  assert(hb.indexOf('◆ 미니게임') < hb.indexOf('◆ 검 강화') && hb.indexOf('◆ 검 강화') < hb.indexOf('◆ 방 관리'), 'sword block sits before the room block')
  eq(S.HELP_CMDS.join(' '), '강화 내검 사냥 출석 결투 보스 강화도움', 'roomfeat helpLine lists the same sword commands')
  assert(hb.includes(' ▸ !강화 · !내검 · !사냥 · !출석\n ▸ !결투 · !보스 · !강화도움'), 'sword block lines ' + hb)

  let now = Date.now()
  const send = (view, text, id, name, opt) => {
    const o = opt || {}
    const rec = R.adapterRecord(view, 'b')
    if (o.cool !== true) rec.config.minigame.cooldownMs = 0
    if (o.images === false) rec.config.minigame.images = false
    return onInbound(rec, { chatId: view.chat_id, text, authorName: name, authorId: id, mentions: o.mentions, mine: false })
  }
  const w = mk()
  const out = send(w, '!강화', '501', '검사')
  eq(out.length, 1, 'one reply')
  assert(out[0].text.startsWith('[강화 성공]') || out[0].text.startsWith('[강화 실패]'), 'enhance reply text ' + out[0].text)
  if (Card.available()) assert(PNG(out[0].image), 'enhance reply carries a PNG')
  eq(out[0].chatId, '77', 'reply chat')
  assert(w.runtime.sword && w.runtime.sword.r.u['501'].n === '검사', 'state saved in the room runtime by user id')
  // 그림을 끈 기록(체험)은 글만
  w.runtime.sword.r.u['501'].e = 0
  const plain = send(w, '!내검', '501', '검사', { images: false })
  assert(plain.length === 1 && !plain[0].image && plain[0].text.startsWith('[내 검] 검사님'), 'images:false → text only')
  // 방 쿨타임에 막히면 상태를 바꾸지 않는다
  const c = mk()
  send(c, '!주사위', '601', '쿨', { cool: true })
  const goldBefore = JSON.stringify(c.runtime.sword || null)
  eq(send(c, '!강화', '601', '쿨', { cool: true }).length, 0, 'room cooldown drops the reply')
  eq(JSON.stringify(c.runtime.sword || null), goldBefore, 'room cooldown → nothing changed')
  // 하루 최대 응답 수
  const d = mk({ games: { dailyLimit: 1 } })
  eq(send(d, '!내검', '701', '한도').length, 1, 'first reply within the daily limit')
  eq(send(d, '!사냥', '701', '한도').length, 0, 'daily limit reached')
  eq(d.runtime.sword.r.u['701'].h, 0, 'daily limit → hunt not taken')
  // 꺼진 방
  const off = mk({ games: { sword: false } })
  eq(send(off, '!강화', '801', '끔')[0].text, '이 방에서는 검 강화가 꺼져 있어요.', 'sword off message')
  eq(send(off, '!사냥', '801', '끔').length, 0, 'sword off → other sword commands silent')
  eq(send(off, '!수락', '801', '끔').length, 0, 'sword off → 수락 silent')
  assert(!off.runtime.sword, 'sword off → no state')
  // 받은 제안 없음
  eq(send(w, '!수락', '502', '둘')[0].text, '받은 신청이 없어요.', 'no trade to accept')
  // 멘션이 onInbound 로 들어온다
  send(w, '!내검', '502', '둘')
  w.runtime.sword.r.u['501'].it = { guard: 1 }
  const t = send(w, '!거래 @다른이름 보호 1 10', '501', '검사', { mentions: ['502'] })
  assert(t[0].text.startsWith('[거래 제안] 검사님 → 둘님'), 'mention through onInbound ' + t[0].text)
  assert(send(w, '!수락', '502', '둘')[0].text.startsWith('[거래 완료]'), 'accept through onInbound')
  // 방 설치형 「게임」 목록에도
  eq(send(w, '!게임', '502', '둘')[0].text, helpCard('K bot 명령어', [{ name: '미니게임', cmds: ['끝말잇기', '숫자야구', '주사위', '가위바위보', '퀴즈', '힌트', '정답', '포기', '랭킹'].map((c) => '!' + c) }, { name: '검 강화', cmds: S.helpCommands('!') }]), 'game list')
  // 계정 단위 옛 기능(byId 아님)에는 검 강화가 없다
  const legacy = { config: { minigame: { enabled: true, rooms: ['k'], cmdPrefix: '!', cooldownMs: 0 } }, rooms: [{ key: 'k', chat_id: '88', name: '옛방', kind: 'open', list_kind: 'open_room' }], runtime: {}, features: { macro: false, roombot: false, minigame: true } }
  eq(onInbound(legacy, { chatId: '88', text: '!강화', authorName: '옛', mine: false }).length, 0, 'legacy account path has no sword game')
  void now
}

process.stdout.write('sword check ok\n')
