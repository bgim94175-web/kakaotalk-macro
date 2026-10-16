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
      const r = S.run(rt, 'r', { cmd, arg, key, name, mentions: o.mentions || [], mentionLen: o.mentionLen, prefix: '!', now, rand: o.rand || fixed(0.999) })
      // 방 글에 장식 「!」가 없다(docs/TONE.md). 명령어 앞 「!」 뒤에는 늘 글자가 붙는다. 분수 표기(체력 x / y)도 없다
      if (r && r.text) assert(!/!(?![가-힣A-Za-z0-9])/.test(r.text) && !/\d \/ \d/.test(r.text), 'tone: ' + r.text)
      return r
    },
    u(key) { return rt.sword.r.u[key] },
    s() { return rt.sword.r },
  }
  return g
}
const PNG = (b) => Buffer.isBuffer(b) && b.length > 1000 && b.slice(0, 8).toString('hex') === '89504e470d0a1a0a'

// ── 표 ────────────────────────────────────────────────────────────────────
{
  const T = S.TABLES
  eq(S.MAX_LV, 30, 'max level 30')
  eq(T.CHANCE.length, 30, 'odds table: one row per attempt +0..+29')
  eq(T.COST.length, 30, 'cost table length')
  eq(T.MAT.length, 30, 'material table length')
  eq(T.GUARD_K.length, 30, 'guard table length')
  eq(T.PRICE.length, 31, 'price table: +0..+30')
  eq(S.NAMES.length, 31, 'one name per level +0..+30')
  assert(Object.isFrozen(T.CHANCE) && Object.isFrozen(T.CHANCE[0]), 'tables are frozen')
  let prevUp = 101
  let prevBroke = -1
  for (let lv = 0; lv < S.MAX_LV; lv++) {
    const c = S.chance(lv)
    assert(c.up > 0 && c.up < prevUp, 'success chance falls by level ' + lv)
    assert(c.broke >= prevBroke, 'destroy chance never falls ' + lv)
    assert(c.up + c.broke + c.fail === 100 && c.fail >= 0, 'chances add to 100 at ' + lv)
    assert(lv >= 5 ? c.broke > 0 : c.broke === 0, 'destroy only from +5 (' + lv + ')')
    // 축복 없이 성공 100%가 되는 단계는 없다(보정 최대 +10%까지 더해도)
    assert(c.up + S.PITY_MAX < 100, 'bless always helps at ' + lv)
    assert(S.cost(lv).gold > 0 && (lv === 0 || S.cost(lv).gold > S.cost(lv - 1).gold), 'cost rises ' + lv)
    prevUp = c.up
    prevBroke = c.broke
  }
  // 재료: +10~+14 마력석 1/2/3/3/4 · +15~+19 용의 비늘 2/2/3/3/3 · +20~+29 별빛 결정 1/1/2/2/2/3/4/5/6/7
  const mats = (lv) => { const c = S.cost(lv); return [c.mana, c.scale, c.star] }
  for (let lv = 0; lv < 10; lv++) eq(JSON.stringify(mats(lv)), '[0,0,0]', 'gold only below +10 (' + lv + ')')
  eq(JSON.stringify([10, 11, 12, 13, 14].map((lv) => mats(lv))), '[[1,0,0],[2,0,0],[3,0,0],[3,0,0],[4,0,0]]', 'mana +10..+14')
  eq(JSON.stringify([15, 16, 17, 18, 19].map((lv) => mats(lv))), '[[0,2,0],[0,2,0],[0,3,0],[0,3,0],[0,3,0]]', 'scale +15..+19')
  eq(JSON.stringify([20, 21, 22, 23, 24, 25, 26, 27, 28, 29].map((lv) => S.cost(lv).star)), '[1,1,2,2,2,3,4,5,6,7]', 'star +20..+29')
  // 보호 주문서 수: 부서질 수 있는 단계부터, +5~+14 는 1개, +15~+19 는 비늘 수, +20부터는 결정 1개마다 5개
  for (let lv = 0; lv < S.MAX_LV; lv++) {
    const k = S.guardK(lv)
    assert((k > 0) === (S.chance(lv).broke > 0), 'guard only where a destroy can happen ' + lv)
    if (lv >= 5 && lv < 15) eq(k, 1, 'one scroll below +15 (' + lv + ')')
    if (lv >= 15 && lv < 20) eq(k, S.cost(lv).scale, 'scroll count = scale count at +' + lv)
    if (lv >= 20) eq(k, 5 * S.cost(lv).star, 'scroll count = 5 per star at +' + lv)
    assert(lv === 0 || k >= S.guardK(lv - 1), 'scroll count never falls ' + lv)
  }
  eq(S.guardK(29), 35, 'guard +29')
  for (let lv = 1; lv <= S.MAX_LV; lv++) assert(S.price(lv) > S.price(lv - 1), 'sell price rises ' + lv)
  eq(S.price(0), 0, '+0 sells for nothing')
  eq(S.price(S.MAX_LV), 4000000, '+30 sells for 4,000,000G')
  // +9~+20 판매가는 예전 그대로(가지고 있던 검의 값이 바뀌지 않는다)
  eq(JSON.stringify([9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20].map((lv) => S.price(lv))), '[5000,7000,9500,13000,18000,25000,35000,50000,70000,100000,150000,250000]', 'old sell prices kept at +9..+20')
  // 이름: 31개 모두 다르고 7자까지, 「검」으로 끝난다(「…이에요」·「…이」 조사가 맞다). 예전 이름은 그 단계에 그대로
  eq(new Set(S.NAMES).size, 31, 'names are unique')
  for (const n of S.NAMES) assert([...n].length <= 7 && n.endsWith('검'), 'name shape ' + n)
  const old = { 0: '녹슨 철검', 3: '강철 장검', 6: '은빛 기사검', 9: '푸른 서리검', 12: '붉은 화염검', 15: '황금 용검', 18: '칠흑의 마검', 20: '추억의 전설검' }
  for (const lv of Object.keys(old)) eq(S.swordName(Number(lv)), old[lv], 'old name kept at +' + lv)
  // 묶음: 14개, 그림 번호 = 묶음 번호, 묶음 이름 = 첫 단계 이름
  eq(S.FAMILIES.length, 14, '14 art families')
  S.FAMILIES.forEach((f, i) => {
    eq(f.art, i, 'family art index ' + i)
    eq(f.name, S.NAMES[f.from], 'family name is its first level name ' + i)
    eq(S.tierOf(f.from), i, 'tierOf at the family start ' + f.from)
    if (i) eq(S.tierOf(f.from - 1), i - 1, 'tierOf just before the family ' + f.from)
  })
  eq(S.FAMILIES[13].from, 30, 'the last family is +30 only')
  eq(S.swordLabel(0), '+0 녹슨 철검', 'label 0')
  eq(S.swordLabel(7), '+7 은빛 근위검', 'label 7')
  eq(S.swordLabel(19), '+19 칠흑의 마왕검', 'label 19')
  eq(S.swordLabel(20), '+20 추억의 전설검', 'label 20')
  eq(S.swordLabel(25), '+25 성운의 은하검', 'label 25')
  eq(S.swordLabel(30), '+30 태초의 창세검', 'label 30')
  eq(S.tierOf(2), 0, 'tier 2')
  eq(S.tierOf(18), 6, 'tier 18')
  eq(S.tierOf(20), 7, 'tier 20')
  eq(S.tierOf(22), 8, 'tier 22')
  eq(S.tierOf(30), 13, 'tier 30')
  // 사냥 한 번(보물 상자 포함 기대값)이 어느 단계든 강화 비용의 0.5~1.5배
  for (let lv = 0; lv < S.MAX_LV; lv++) {
    const band = T.HUNT[S.tierOf(lv)]
    const ev = (band.reduce((n, m) => n + (m[1] + m[2]) / 2, 0) / band.length) * (1 + (T.TREASURE_PCT / 100) * 4)
    const r = ev / S.cost(lv).gold
    assert(r >= 0.5 && r <= 1.5, `hunt funds about one press at +${lv} (${r.toFixed(2)})`)
  }
  eq(T.HUNT.length, S.FAMILIES.length, 'one hunting ground per family')
  // 아이템은 늘 산 값보다 싸게 팔린다
  for (const id of Object.keys(S.ITEMS)) assert(S.ITEMS[id].buy > S.ITEMS[id].sell && S.ITEMS[id].sell > 0, 'item sells below its price ' + id)
  eq(S.won(1234567), '1,234,567', 'won')
  eq(S.helpLine('#'), '검 강화 : #강화 #내검 #사냥 #출석 #결투 #보스 #강화랭킹 #강화도움', 'help line')
}

// ── 이익 고리 없음: 검을 만드는 가장 싼 기대 비용(정확한 계산)보다 판매가가 늘 낮다 ──
// 상태 (단계, 연속 실패), 강화마다 축복·보호를 쓸지 고르고 파괴되면 +0(위로금은 돌려받음). 아이템은 되팔 값으로 쳐서(가장 싸게)
// 만든 검을 팔아 남기는 고리가 없는지 본다. 결과는 스펙의 정확한 계산과 같다(+20 에서 0.72).
function buildCost(L, val) {
  const FMAX = S.PITY_MAX / S.PITY_STEP
  let X = 0 // +0 에서 +L 까지의 기대 비용(파괴되면 다시 여기서)
  for (let it = 0; it < 20000; it++) {
    let next = [0]
    for (let lv = L - 1; lv >= 0; lv--) {
      const ch = S.chance(lv)
      const c = S.cost(lv)
      const base = c.gold + c.mana * val.mana + c.scale * val.scale + c.star * val.star
      const comfort = lv >= S.COMFORT_FROM ? Math.floor(S.price(lv) / 10) : 0
      const V = []
      for (let f = FMAX; f >= 0; f--) {
        let best = Infinity
        for (const bless of [false, true]) {
          for (const guard of ch.broke ? [false, true] : [false]) {
            const cost = base + (bless ? val.bless : 0) + (guard ? S.guardK(lv) * val.guard : 0)
            const up = Math.min(100, ch.up + (bless ? S.BLESS_PCT : 0) + S.pityOf(f)) / 100
            const broke = Math.min(ch.broke / 100, 1 - up)
            const stay = 1 - up - broke + (guard ? broke : 0)
            const reset = guard ? 0 : broke
            const fn = Math.min(FMAX, f + 1)
            const v = fn === f ? (cost + up * next[0] + reset * (X - comfort)) / (1 - stay) : cost + up * next[0] + stay * V[fn] + reset * (X - comfort)
            if (v < best) best = v
          }
        }
        V[f] = best
      }
      next = V
    }
    if (Math.abs(next[0] - X) < 0.01) return next[0]
    X = next[0]
  }
  return X
}
{
  const at = (k) => Object.fromEntries(Object.keys(S.ITEMS).map((id) => [id, S.ITEMS[id][k]]))
  let worst = 0
  for (let L = 1; L <= S.MAX_LV; L++) {
    const r = S.price(L) / buildCost(L, at('sell'))
    worst = Math.max(worst, r)
    assert(r <= 0.75, `no profit loop: +${L} sells for ${(r * 100).toFixed(0)}% of its cheapest expected cost`)
  }
  assert(worst > 0.6, 'the solver really ran ' + worst)
  const top = buildCost(S.MAX_LV, at('buy'))
  assert(top > 60e6 && top < 80e6 && S.price(S.MAX_LV) / top < 0.1, '+30 from scratch at shop prices ' + Math.round(top))
}

// ── 강화: 확률 경계(고정 난수) ────────────────────────────────────────────
{
  const g = game()
  const r = g.run('1', '가', '강화', { rand: fixed(0.84) }) // +0 성공 85%
  assert(r.text.startsWith('[강화 성공]\n가님의 검이 +1 손질한 철검이 됐어요.'), 'first enhance ' + r.text)
  eq(r.card.kind, 'enhance', 'card kind')
  eq(r.card.result, 'up', 'card result')
  eq(g.u('1').g, S.START_GOLD - S.cost(0).gold, 'gold paid')
  eq(g.u('1').lv, 1, 'level 1')
  eq(g.u('1').b, 1, 'best 1')
  // +9: 성공 26 · 파괴 8 · 실패 66
  const setLv = (lv, gold) => Object.assign(g.u('1'), { lv, g: gold == null ? 100000 : gold, e: 0, w: 0, f: 0 })
  setLv(9)
  eq(g.run('1', '가', '강화', { rand: fixed(0.2599) }).card.result, 'up', '+9 roll 25.99 → up')
  setLv(9)
  const idBefore = g.u('1').id
  const br = g.run('1', '가', '강화', { rand: fixed(0.26) })
  eq(br.card.result, 'broke', '+9 roll 26 → broke')
  assert(br.text.startsWith('[강화 파괴]\n가님의 +9 푸른 서리검이 부서졌어요. 새 +0 녹슨 철검을 받았어요.'), 'broke text ' + br.text)
  eq(g.u('1').lv, 0, 'broke → +0')
  assert(g.u('1').id !== idBefore, 'broke → new sword id')
  eq(g.u('1').k, 1, 'broken count')
  eq(g.u('1').b, 10, 'best record kept after break')
  setLv(9)
  eq(g.run('1', '가', '강화', { rand: fixed(0.34) }).card.result, 'fail', '+9 roll 34 → fail')
  eq(g.u('1').lv, 9, 'fail keeps level')
  // 보호 주문서: 파괴 → 지킴, +5~+14 는 1장
  setLv(9)
  g.u('1').it = { guard: 2 }
  const gd = g.run('1', '가', '강화 보호', { rand: fixed(0.3) })
  eq(gd.card.result, 'guarded', 'guard saves')
  eq(g.u('1').lv, 9, 'guarded level')
  eq(g.u('1').it.guard, 1, 'guard used once')
  assert(gd.text.startsWith('[강화 실패]\n부서질 뻔했지만 보호 주문서가 지켜 줬어요. +9 푸른 서리검 그대로예요.'), 'guarded text ' + gd.text)
  assert(gd.text.includes('\n사용 : 1,600G · 보호 주문서 1개 (보유 '), 'guarded: used line shows the scroll count ' + gd.text)
  // 실패여도 보호 주문서를 썼으면 사라진다(쓴 만큼)
  setLv(9)
  g.run('1', '가', '강화 보호주문서', { rand: fixed(0.9) })
  eq(g.u('1').it.guard, undefined, 'guard used on a plain fail too')
  // 축복: +10%p
  setLv(9)
  g.u('1').it = { bless: 1 }
  eq(g.run('1', '가', '강화 축복', { rand: fixed(0.359) }).card.result, 'up', 'bless 36%')
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
  eq(g.run('1', '가', '강화 보호').text, '+7에서 보호하려면 보호 주문서가 1개 필요해요. (보유 0개) 「!구매 보호 1」로 살 수 있어요.', 'no guard')
  eq(g.run('1', '가', '강화 축복').text, '축복 주문서가 없어요. 「!구매 축복 1」로 살 수 있어요.', 'no bless')
  // 골드 부족 · 재료 부족: 상태 그대로
  setLv(6, 10)
  eq(g.run('1', '가', '강화').text, '골드가 부족해요. +6 강화에는 800G가 필요해요. (보유 10G)\n「!사냥」으로 골드를 모아 보세요.', 'no gold')
  eq(g.u('1').lv, 6, 'no gold → same level')
  setLv(10)
  g.u('1').it = {}
  eq(g.run('1', '가', '강화').text, '+10 강화에는 마력석이 1개 필요해요. (보유 0개) 「!사냥」으로 모으거나 「!구매 마력석 1」로 살 수 있어요.', 'no mana')
  eq(g.u('1').g, 100000, 'no mana → no gold paid')
  g.u('1').it = { mana: 1 }
  g.run('1', '가', '강화', { rand: fixed(0.99) })
  eq(g.u('1').it.mana, undefined, 'mana used')
  eq(g.u('1').g, 100000 - S.cost(10).gold, 'gold at +10')
  setLv(13)
  g.u('1').it = { mana: 1 }
  eq(g.run('1', '가', '강화').text, '+13 강화에는 마력석이 3개 필요해요. (보유 1개) 「!사냥」으로 모으거나 「!구매 마력석 2」로 살 수 있어요.', 'mana count at +13')
  eq(g.u('1').it.mana, 1, 'short of mana → nothing taken')
  setLv(15)
  g.u('1').it = { mana: 3 }
  eq(g.run('1', '가', '강화').text, '+15 강화에는 용의 비늘이 2개 필요해요. (보유 0개) 「!사냥」으로 모으거나 「!구매 비늘 2」로 살 수 있어요.', 'no scale')
  g.u('1').it = { scale: 2 }
  const s15 = g.run('1', '가', '강화', { rand: fixed(0.0) })
  eq(g.u('1').lv, 16, 'scale used, level up')
  eq(g.u('1').it.scale, undefined, 'both scales gone')
  assert(s15.text.includes('\n사용 : 2,700G · 용의 비늘 2개 (보유 ') && s15.text.endsWith('\n다음 강화 : 3,000G + 용의 비늘 2개 · 성공 16% · 파괴 15%\n보호하려면 보호 주문서가 2개 필요해요.'), 'material counts in the text ' + s15.text)
  setLv(17)
  g.u('1').it = { scale: 3 }
  eq(g.run('1', '가', '강화 보호').text, '+17에서 보호하려면 보호 주문서가 3개 필요해요. (보유 0개) 「!구매 보호 3」으로 살 수 있어요.', 'guard count at +17 (으로 after 3)')
  // +19 → +20 은 이제 최고 단계가 아니다: 다음은 별빛 결정
  setLv(19)
  g.u('1').it = { scale: 3 }
  const t20 = g.run('1', '가', '강화', { rand: fixed(0.0) })
  assert(t20.text.startsWith('[강화 성공]\n가님의 검이 +20 추억의 전설검이 됐어요.\n') && t20.text.endsWith('\n다음 강화 : 4,300G + 별빛 결정 1개 · 성공 12% · 파괴 18%\n보호하려면 보호 주문서가 5개 필요해요.'), '+20 text ' + t20.text)
  setLv(20)
  g.u('1').it = { guard: 99 }
  eq(g.run('1', '가', '강화 보호').text, '+20 강화에는 별빛 결정이 1개 필요해요. (보유 0개) 「!사냥」으로 모으거나 「!구매 결정 1」로 살 수 있어요.', 'no star')
  // 최고 단계 +30
  setLv(29)
  g.u('1').it = { star: 7 }
  const top = g.run('1', '가', '강화', { rand: fixed(0.0) })
  eq(top.card.lv, 30, 'reach +30')
  eq(g.u('1').it.star, undefined, '7 stars used at +29')
  assert(top.text.startsWith('[강화 성공]\n가님의 검이 +30 태초의 창세검이 됐어요.\n') && top.text.endsWith('\n최고 단계예요.') && top.text.split('최고 단계예요.').length === 2, 'top text ' + top.text)
  setLv(30)
  eq(g.run('1', '가', '강화').text, '가님의 검은 이미 최고 단계 +30 태초의 창세검이에요. 「!판매」로 팔 수 있어요.', 'max level')
}

// ── 보호 주문서 수는 단계마다(+15부터 여러 장). 모자라면 아무것도 쓰지 않고, 있으면 그 수만큼 쓴다 ──
{
  const g = game()
  g.run('1', '가', '내검')
  for (let lv = 5; lv < S.MAX_LV; lv++) {
    const k = S.guardK(lv)
    const c = S.cost(lv)
    const it = Object.fromEntries(Object.entries({ guard: k - 1, bless: 1, mana: c.mana, scale: c.scale, star: c.star }).filter((x) => x[1] > 0))
    Object.assign(g.u('1'), { lv, b: lv, g: 1e6, e: 0, w: 0, f: 0, it })
    const before = JSON.stringify(g.u('1'))
    const no = g.run('1', '가', '강화 보호 축복', { rand: fixed(0) })
    const more = String(1)
    eq(no.text, `+${lv}에서 보호하려면 보호 주문서가 ${k}개 필요해요. (보유 ${k - 1}개) 「!구매 보호 ${more}」로 살 수 있어요.`, 'short of scrolls at +' + lv)
    eq(JSON.stringify(g.u('1')), before, 'short of scrolls → nothing changes at +' + lv)
    // 파괴 구간 한가운데: 지켜 주고 정확히 k장을 쓴다
    g.u('1').it.guard = k + 2
    const ch = S.chance(lv)
    const roll = (Math.min(100, ch.up + S.BLESS_PCT) + Math.min(ch.broke, 100 - Math.min(100, ch.up + S.BLESS_PCT)) / 2) / 100
    const r = g.run('1', '가', '강화 보호 축복', { rand: fixed(roll) })
    eq(r.card.result, 'guarded', 'guarded at +' + lv)
    eq(g.u('1').it.guard, 2, `exactly ${k} scrolls used at +${lv}`)
    eq(JSON.stringify(r.card.used), JSON.stringify([`보호 주문서 ${k}개`, '축복 주문서 1개']), 'card chips show the count at +' + lv)
    assert(r.text.includes(` · 보호 주문서 ${k}개 · 축복 주문서 1개 (보유 `), 'used line counts at +' + lv)
    assert(['mana', 'scale', 'star'].every((id) => !g.u('1').it[id]), 'materials used at +' + lv)
  }
  // +22: 결정 2 · 보호 10. 둘 다 모자라면 한 번에 모두(더 필요한 수)와 모두 사서 강화하는 골드를 알린다(아무것도 쓰지 않는다)
  Object.assign(g.u('1'), { lv: 22, g: 1e6, e: 0, w: 0, f: 0, it: { star: 1, guard: 3 } })
  eq(g.run('1', '가', '강화 보호').text, '+22 보호 강화에는 별빛 결정 1개 · 보호 주문서 7개가 더 필요해요.\n모두 사서 강화하려면 445,100G가 들어요. (보유 1,000,000G)\n「!사냥」으로 모으거나 「!구매 결정 1」 · 「!구매 보호 7」로 살 수 있어요.', 'every shortfall at once')
  eq(JSON.stringify(g.u('1').it), '{"star":1,"guard":3}', 'nothing taken')
  eq(g.u('1').g, 1e6, 'no gold taken')
  // 알려 준 대로 모두 사면 그대로 보호 강화가 된다
  assert(g.run('1', '가', '구매 결정 1').text.startsWith('별빛 결정 1개를 300,000G에 샀어요.'), 'buy the star from the hint')
  assert(g.run('1', '가', '구매 보호 7').text.startsWith('보호 주문서 7개를 140,000G에 샀어요.'), 'buy the scrolls from the hint')
  const ok = g.run('1', '가', '강화 보호', { rand: fixed(0.2) }) // +22 성공 10 · 파괴 20 → 0.2 는 파괴 구간(10~30)
  eq(ok.card.result, 'guarded', 'hint was enough for a guarded press')
  eq(g.u('1').g, 1e6 - 445100, 'the hint total is what it cost')
  // 리뷰 사례: +20 · 310,000G · 아이템 없음 → 결정만 사면 보호 주문서 살 골드가 없다는 것을 처음부터 안다
  Object.assign(g.u('1'), { lv: 20, g: 310000, e: 0, w: 0, f: 0, it: {} })
  eq(g.run('1', '가', '강화 보호').text, '+20 보호 강화에는 별빛 결정 1개 · 보호 주문서 5개가 더 필요해요.\n모두 사서 강화하려면 404,300G가 들어요. (보유 310,000G)\n「!사냥」으로 모으거나 「!구매 결정 1」 · 「!구매 보호 5」로 살 수 있어요.', '+20 guard + star shortfall together')
  // 골드도 모자라고 재료도 모자라면 함께(축복도 모자라면 끝에)
  Object.assign(g.u('1'), { lv: 15, g: 100, e: 0, w: 0, f: 0, it: { scale: 1 } })
  eq(g.run('1', '가', '강화 축복').text, '+15 강화에는 용의 비늘 1개 · 축복 주문서 1개가 더 필요해요.\n모두 사서 강화하려면 54,700G가 들어요. (보유 100G)\n「!사냥」으로 모으거나 「!구매 비늘 1」 · 「!구매 축복 1」로 살 수 있어요.', 'gold + material + bless together')
  Object.assign(g.u('1'), { lv: 15, g: 100, e: 0, w: 0, f: 0, it: {} })
  eq(g.run('1', '가', '강화').text, '+15 강화에는 용의 비늘 2개가 더 필요해요.\n모두 사서 강화하려면 102,700G가 들어요. (보유 100G)\n「!사냥」으로 모으거나 「!구매 비늘 2」로 살 수 있어요.', 'gold short and one material short')
  eq(JSON.stringify([g.u('1').lv, g.u('1').g, g.u('1').it]), '[15,100,{}]', 'combined shortfall → nothing changes')
  // 보호 없이 하면 주문서가 없어도 된다
  Object.assign(g.u('1'), { lv: 22, g: 1e6, e: 0, w: 0, f: 0, it: { star: 2 } })
  eq(g.run('1', '가', '강화', { rand: fixed(0.5) }).card.result, 'fail', 'no guard asked → no scrolls needed')
  // 「!내검」: +15부터 보호에 드는 수를 한 줄 더
  Object.assign(g.u('1'), { lv: 14 })
  assert(!g.run('1', '가', '내검').text.includes('보호하려면'), 'no scroll line below +15')
  Object.assign(g.u('1'), { lv: 25, f: 0 })
  const inf = g.run('1', '가', '내검')
  assert(inf.text.endsWith('\n다음 강화 : 6,400G + 별빛 결정 3개 · 성공 7% · 파괴 23%\n보호하려면 보호 주문서가 15개 필요해요.'), 'info scroll line ' + inf.text)
  eq(JSON.stringify([inf.card.next.gold, inf.card.next.star, inf.card.next.guard]), '[6400,3,15]', 'info card next carries the counts')
}

// ── 강화: 주문서 낱말. 띄어 쓰거나 수를 붙여도 읽고, 모르는 낱말이면 아무것도 쓰지 않고 다시 묻는다 ──
{
  const g = game()
  g.run('1', '가', '내검')
  const at15 = (it) => Object.assign(g.u('1'), { lv: 15, g: 100000, e: 0, w: 0, f: 0, it })
  // +15: 성공 17 · 파괴 14 → 0.30 은 파괴 구간. 보호 한 번에 주문서 2장
  for (const line of ['강화 보호', '강화 파괴방지', '강화 파괴 방지', '강화 보호 주문서', '강화 보호1', '강화 보호 1개', '강화 보호 1', '강화 보호 2개']) {
    at15({ guard: 2, scale: 2 })
    eq(g.run('1', '가', line, { rand: fixed(0.3) }).card.result, 'guarded', 'guard word: ' + line)
    eq(g.u('1').it.guard, undefined, 'guard used: ' + line)
  }
  at15({ bless: 1, scale: 2 })
  eq(g.run('1', '가', '강화 축복 주문서', { rand: fixed(0.26) }).card.result, 'up', 'spaced bless name (17 + 10 > 26)')
  eq(g.u('1').it.bless, undefined, 'spaced bless name: used')
  at15({ guard: 2, bless: 1, scale: 2 })
  eq(JSON.stringify(g.run('1', '가', '강화 보호 주문서 축복 주문서', { rand: fixed(0.5) }).card.used), '["보호 주문서 2개","축복 주문서 1개"]', 'both spaced names')
  // 잘못 쓴 낱말·군말(「!강화 ㄱㄱ」): 주문서 없이 강화하지 않는다(골드·주문서·재료·쿨타임 그대로).
  // 처음 못 읽은 낱말을 보이고 「!강화」만 쳐도 된다는 것을 먼저 알린다. 링크·긴 글은 따라 올리지 않는다
  const tail = ' 알 수 없어서 강화하지 않았어요. 「!강화」, 「!강화 보호」, 「!강화 축복」처럼 입력해 주세요.'
  for (const [line, head] of [['강화 보효', '「보효」는'], ['강화 가드', '「가드」는'], ['강화 보호 주문', '「주문」은'], ['강화 보호주문서1 ㅎ', '「ㅎ」은(는)'],
    ['강화 ㄱㄱ', '「ㄱㄱ」은(는)'], ['강화 가즈아', '「가즈아」는'], ['강화 open.kakao.com/o/abc', '「!강화」 뒤의 낱말을'], ['강화 열한글자가넘는긴낱말이에요', '「!강화」 뒤의 낱말을']]) {
    at15({ guard: 1, scale: 1 })
    eq(g.run('1', '가', line, { rand: fixed(0.3) }).text, head + tail, 'unknown word: ' + line)
    const u = g.u('1')
    assert(u.lv === 15 && u.g === 100000 && u.it.guard === 1 && u.it.scale === 1 && u.e === 0, 'unknown word changes nothing: ' + line + ' ' + JSON.stringify(u))
  }
  // 검·재료 이름은 강화 때 저절로 쓰는 것이라 그냥 넘어간다
  at15({ scale: 2 })
  eq(g.run('1', '가', '강화 검', { rand: fixed(0.5) }).card.result, 'fail', 'sword word is fine')
  at15({ scale: 2 })
  eq(g.run('1', '가', '강화 비늘 결정', { rand: fixed(0.5) }).card.result, 'fail', 'material words are fine')
}

// ── 축복: 축복 없이도 성공 100%면 쓰지 않는다 — 지금 표에서는 그런 단계가 없어서(85% + 보정 10%) 늘 쓴다 ──
{
  const g = game()
  g.run('1', '가', '내검')
  // +0 · 연속 실패 5번(85 + 10 = 95): 축복이 도움이 되므로 쓰고, 성공 100%
  Object.assign(g.u('1'), { lv: 0, g: 10000, e: 0, w: 0, f: 5, it: { bless: 1 } })
  const r = g.run('1', '가', '강화 축복', { rand: fixed(0.999) })
  eq(r.card.result, 'up', 'bless + max pity at +0: 100%')
  eq(g.u('1').it.bless, undefined, 'bless used at 95%')
  assert(r.text.includes('\n실패 보정 +10%가 적용됐어요.\n사용 : 60G · 축복 주문서 1개 (보유 9,940G)\n') && !r.text.includes('쓰지 않았어요'), 'bless at 95%: text ' + r.text)
  // +1 · 연속 실패 5번(80 + 10 = 90): 축복 주문서가 없으면 아무것도 하지 않고 알린다
  Object.assign(g.u('1'), { lv: 1, e: 0, w: 0, f: 5, it: {} })
  eq(g.run('1', '가', '강화 축복', { rand: fixed(0.999) }).text, '축복 주문서가 없어요. 「!구매 축복 1」로 살 수 있어요.', 'bless needed and none owned')
  eq(g.u('1').lv, 1, 'no bless → no enhance')
  // +0 · 보정 없음(85 → 95)
  Object.assign(g.u('1'), { lv: 0, e: 0, w: 0, f: 0, it: { bless: 1 } })
  eq(g.run('1', '가', '강화 축복', { rand: fixed(0.94) }).card.result, 'up', 'bless 85 + 10 → 95')
  eq(g.u('1').it.bless, undefined, 'bless used when it helps')
}

// ── 강화: 씨앗 난수로 확률이 표대로인지(2만 번, 실패 보정 없이) ──────────────
{
  const g = game()
  const rand = seeded(20261017)
  for (const [lv, bless] of [[0, false], [9, false], [9, true], [14, false], [19, false], [19, true], [25, false], [29, true]]) {
    const n = 20000
    const got = { up: 0, broke: 0, fail: 0 }
    for (let i = 0; i < n; i++) {
      g.run('p', '확률', '내검')
      Object.assign(g.u('p'), { lv, g: 1e6, e: 0, w: 0, f: 0, it: { mana: 9, scale: 9, star: 9, bless: 1 } })
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
  // 드롭: 난수 0 → 모든 드롭 + 보물(5배). +15 아래에서는 별빛 결정이 나오지 않는다
  g.tick(S.HUNT_CD_MS)
  const before = g.u('3').g
  const all = g.run('3', '다', '사냥', { rand: fixed(0) })
  assert(all.text.includes('보물 상자를 찾았어요. 골드를 5배로 받았어요.') && all.text.includes('\n+275G · 마력석 1개 · 축복 주문서 1개 · 보호 주문서 1개 · 용의 비늘 1개 (보유 '), 'all drops ' + all.text)
  eq(g.u('3').g - before, 5 * 55, 'treasure x5 of the lowest roll (초록 슬라임 55)')
  assert(['guard', 'bless', 'mana', 'scale'].every((id) => g.u('3').it[id] === 1) && !g.u('3').it.star, 'drops in inventory ' + JSON.stringify(g.u('3').it))
  // 높은 단계는 센 몬스터(사냥터 = 검 그림 묶음)
  const huntAt = (lv, x) => {
    g.tick(S.HUNT_CD_MS)
    g.u('3').lv = lv
    return g.run('3', '다', '사냥', { rand: fixed(x) }).text
  }
  assert(/심연의 용|타락한 대마법사/.test(huntAt(16, 0.3)), 'band by level')
  const h18 = huntAt(18, 0.4)
  assert(h18.startsWith('[사냥] 다님이 그림자 마수를 잡았어요.\n+2,570G (보유 '), 'new monsters at +18 ' + h18)
  assert(/빛 잃은 수호천사|날개 꺾인 석상/.test(huntAt(20, 0.3)), 'band at +20')
  assert(/천둥 그리폰|폭풍의 거인|뇌운의 정령/.test(huntAt(22, 0.5)), 'band at +22')
  assert(/창세의 수호룡|태초의 그림자/.test(huntAt(30, 0.7)), 'band at +30')
  // 별빛 결정: +15~+19 0.2%, +20부터 0.7%(난수 0.0019 → 0.19 < 0.2 · 0.0069 → 0.69 < 0.7)
  g.u('3').it = {}
  assert(huntAt(16, 0.0019).includes('별빛 결정 1개') && g.u('3').it.star === 1, 'star drop at +16')
  assert(!huntAt(16, 0.0021).includes('별빛 결정'), 'no star at +16 above 0.2%')
  assert(huntAt(21, 0.0069).includes('별빛 결정 1개') && g.u('3').it.star === 2, 'star drop at +21')
  assert(!huntAt(14, 0.0001).includes('별빛 결정'), 'no star below +15')
}

// ── 쿨타임 안내는 행동마다 한 번: 강화·사냥을 번갈아 해도 다시 알리지 않는다 ──
{
  const g = game()
  g.run('1', '가', '사냥', { rand: fixed(0.5) })
  g.run('1', '가', '강화', { rand: fixed(0.5) })
  g.tick(1000)
  eq(g.run('1', '가', '강화').text, '가님, 강화는 9초 뒤에 다시 할 수 있어요.', 'alternate: enhance note')
  eq(g.run('1', '가', '사냥').text, '가님, 사냥은 1분 59초 뒤에 다시 할 수 있어요.', 'alternate: hunt note')
  eq(g.run('1', '가', '강화').text, '', 'alternate: enhance silent after a hunt note')
  eq(g.run('1', '가', '사냥').text, '', 'alternate: hunt silent after an enhance note')
  g.tick(S.ENHANCE_CD_MS)
  assert(g.run('1', '가', '강화', { rand: fixed(0.5) }).card, 'enhance again after 10s')
  eq(g.run('1', '가', '강화').text, '가님, 강화는 10초 뒤에 다시 할 수 있어요.', 'a new enhance gets a new note')
  eq(g.run('1', '가', '사냥').text, '', 'the same hunt stays silent')
  // 예전 저장본(w 가 수 하나)도 이어진다
  g.u('1').w = g.u('1').e
  eq(g.run('1', '가', '강화').text, '가님, 강화는 10초 뒤에 다시 할 수 있어요.', 'legacy numeric w')
  eq(g.run('1', '가', '강화').text, '', 'legacy numeric w: then silent')
}

// ── 판매 · 상점 ───────────────────────────────────────────────────────────
{
  const g = game()
  g.run('1', '가', '내검')
  eq(g.run('1', '가', '판매').text, '+0 검은 팔 수 없어요. 「!강화」로 먼저 키워 보세요.', 'sell +0')
  Object.assign(g.u('1'), { lv: 5, g: 0 })
  const id5 = g.u('1').id
  eq(g.run('1', '가', '판매').text, `+5 명장의 강철검을 ${S.won(S.price(5))}G에 팔았어요. (보유 ${S.won(S.price(5))}G)\n새 +0 녹슨 철검을 받았어요.`, 'sell +5')
  assert(g.u('1').lv === 0 && g.u('1').id !== id5 && g.u('1').s === 1, 'sold → new +0 sword')
  Object.assign(g.u('1'), { lv: 12, g: 0 })
  eq(g.run('1', '가', '판매').text, `+12 붉은 화염검을 ${S.won(S.price(12))}G에 팔까요? 팔려면 「!판매 확인」을 입력해 주세요.`, 'sell +12 asks')
  eq(g.u('1').lv, 12, 'not sold before confirm')
  g.run('1', '가', '판매 확인')
  assert(g.u('1').lv === 0 && g.u('1').g === S.price(12), 'sold after confirm')
  // 상점: 다섯 가지 모두 산다
  const shop = g.run('1', '가', '상점').text
  eq(shop, '[상점]\n보호 주문서 20,000G : 강화하다 부서질 때 검을 지켜 줘요 (+15부터 여러 개씩 써요)\n축복 주문서 2,000G : 강화 성공 확률 +10%\n마력석 2,500G : +10~+14 강화에 1~4개씩 써요\n용의 비늘 50,000G : +15~+19 강화에 2~3개씩 써요 (사냥·보스에서도 나와요)\n별빛 결정 300,000G : +20부터 강화에 1~7개씩 써요 (사냥에서도 나와요)\n구매 : !구매 보호 1', 'shop ' + shop)
  g.u('1').g = 92000
  eq(g.run('1', '가', '구매 보호 주문서 2').text, '보호 주문서 2개를 40,000G에 샀어요. (보유 52,000G · 보호 주문서 2개)', 'buy 2 guard')
  eq(g.run('1', '가', '구매 비늘').text, '용의 비늘 1개를 50,000G에 샀어요. (보유 2,000G · 용의 비늘 1개)', 'scale is sold now')
  eq(g.run('1', '가', '구매 축복 2').text, '골드가 부족해요. 축복 주문서 2개는 4,000G예요. (보유 2,000G)', 'buy no gold')
  eq(g.run('1', '가', '구매 결정').text, '골드가 부족해요. 별빛 결정 1개는 300,000G예요. (보유 2,000G)', 'star too dear')
  g.u('1').g += 1200000
  for (const w of ['별빛 결정 2', '별빛결정 1', '결정 1개']) assert(g.run('1', '가', '구매 ' + w).text.startsWith('별빛 결정 '), 'buy star by ' + w)
  eq(g.u('1').it.star, 4, 'stars bought')
  eq(g.u('1').g, 2000, 'stars cost 300,000G each')
  eq(g.run('1', '가', '판매 결정 4').text, '별빛 결정 4개를 120,000G에 팔았어요. (보유 122,000G)', 'sell stars back at 30,000G')
  eq(g.run('1', '가', '판매 비늘').text, '용의 비늘 1개를 3,000G에 팔았어요. (보유 125,000G)', 'scale sells at 3,000G as before')
  g.u('1').g = 2000
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
  eq(info.text, '[내 검] 가님\n+0 녹슨 철검 · 최고 +12\n골드 1,000,000G · 판매가 0G\n아이템 : 마력석 999\n다음 강화 : 60G · 성공 85%', 'info text')
  eq(info.card.kind, 'info', 'info card')
  const help = g.run('1', '가', '강화도움').text
  assert(help.startsWith('《 검 강화 도움말 》\n━━━━━━━━━━━━\n▸ !강화 : '), 'help text')
  // 결투 신청·거래 제안을 거두는 명령어와 순위 명령어도 도움말에 있다
  assert(help.includes('\n▸ !거래취소 : 보낸 거래 제안·결투 신청을 취소해요\n') && help.includes('\n▸ !강화랭킹 : '), 'help lists 거래취소 and 강화랭킹 ' + help)
  assert(help.endsWith('\n━━━━━━━━━━━━\n강화에 실패하면 다음 강화 성공 확률이 2%씩 올라요. (최대 +10%)\n높은 단계일수록 재료와 보호 주문서를 여러 개 써요.'), 'help footer: scaled materials and scrolls ' + help)
}

// ── 아이템 999개: 못 받은 보상을 받았다고 하지 않는다 ─────────────────────
{
  const g = game()
  g.run('1', '가', '내검')
  g.u('1').it = { mana: 999 }
  const h = g.run('1', '가', '사냥', { rand: fixed(0) }) // 모든 드롭
  assert(h.text.includes('\n+275G · 축복 주문서 1개 · 보호 주문서 1개 · 용의 비늘 1개 (보유 ') && !h.text.includes('마력석 1개') && h.text.endsWith('\n마력석은 999개까지 가질 수 있어서 더 받지 못했어요.'), 'hunt at the cap ' + h.text)
  eq(g.u('1').it.mana, 999, 'mana stays at the cap')
  // 7일째 출석 보너스
  const a = game()
  a.run('1', '가', '출석')
  a.u('1').it = { guard: 999, bless: 999 }
  let r7 = null
  for (let d = 2; d <= 7; d++) {
    a.tick(24 * 3600 * 1000)
    r7 = a.run('1', '가', '출석')
  }
  eq(r7.text, `[출석] 가님 7일 연속 출석했어요.\n+1,000G (보유 ${S.won(a.u('1').g)}G)\n보호 주문서·축복 주문서는 999개까지 가질 수 있어서 더 받지 못했어요.`, 'week bonus at the cap')
  // 보스 마지막 일격 · 가장 큰 피해(혼자면 둘 다 같은 사람). 거대 왕슬라임: 마력석 2 + 축복 1, 가장 큰 피해 축복 2
  const b = game()
  b.run('1', '가', '내검')
  Object.assign(b.u('1'), { lv: 20, it: { mana: 999, bless: 998 } })
  b.run('1', '가', '보스')
  b.s().r.hp = 1000 // 한 번에 최대 체력의 25%(1,000)까지라, 마지막 한 번만 남겨 둔다
  const k = b.run('1', '가', '공격', { rand: fixed(0.5) })
  assert(k.text.includes('\n마지막 일격 : 가님 (축복 주문서 1개)\n가장 큰 피해 : 가님\n마력석은 999개까지 가질 수 있어서 가님은 더 받지 못했어요.\n축복 주문서는 999개까지 가질 수 있어서 가님은 더 받지 못했어요.\n'), 'boss rewards at the cap ' + k.text)
  assert(b.u('1').it.mana === 999 && b.u('1').it.bless === 999 && !b.u('1').it.guard && !b.u('1').it.scale, 'boss items capped ' + JSON.stringify(b.u('1').it))
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
  eq(P('@a 별빛 결정 2 500000'), '{"target":"a","item":"star","qty":2,"price":500000}', 'parse two-word star')
  eq(P('@별빛 결정 1 1'), '{"target":"별빛","item":"star","qty":1,"price":1}', 'a person called 별빛 can still get 결정')
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
  eq(g.run('1', '홍길동', '거래취소').text, '보낸 거래 제안이나 결투 신청이 없어요.', 'cancel none')
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
  eq(g.run('2', '김 민수', '결투 @세번째').text, '세번째님이 다른 거래 제안을 받고 있어요. 잠시 뒤 다시 해 주세요.', 'duel to a target busy with a trade')
  // 새 제안은 먼저 보낸 제안을 바꾼다
  g.u('1').it = { guard: 2 }
  const re = g.run('1', '홍길동', '거래 @세번째 보호 2 2').text
  assert(re.endsWith('(먼저 보낸 거래 제안은 취소했어요)') && g.s().t.length === 1 && g.s().t[0].q === 2, 'replace own offer')
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
  g.u('2').it = { mana: 3 }
  g.run('2', '구매자', '강화', { rand: fixed(0) })
  eq(g.run('3', '셋', '수락').text, '구매자님의 검이 바뀌어서 거래를 취소했어요.', 'sword changed → cancelled')
  eq(g.u('2').lv, 13, 'seller keeps the upgraded sword')
  // 제안 뒤 부서짐 → 취소
  g.tick(S.ENHANCE_CD_MS)
  g.run('2', '구매자', '거래 @셋 검 1')
  g.u('2').it = { mana: 3 }
  g.run('2', '구매자', '강화', { rand: fixed(0.25) }) // +13: 성공 20 · 파괴 12 → 0.25 = 파괴
  eq(g.u('2').lv, 0, 'broke')
  eq(g.run('3', '셋', '수락').text, '구매자님의 검이 바뀌어서 거래를 취소했어요.', 'broken sword → cancelled')
  eq(g.u('3').lv, 0, 'nobody got a broken sword')
}

// ── 아무렇게나 한 3,000번: 음수·한도 초과·검 복제가 없다 ─────────────────
{
  const g = game()
  const rand = seeded(8)
  const keys = ['1', '2', '3', '4']
  const names = { 1: '가', 2: '나', 3: '다', 4: '라' }
  let done = 0
  let swords = 0
  const cmds = ['강화', '강화 보호', '강화 축복', '사냥', '판매', '판매', '판매 확인', '구매 보호 1', '구매 축복 2', '구매 마력석 1', '판매 마력석 1', '거래취소', '수락', '수락', '수락', '거절', '내검']
  for (const k of keys) {
    g.run(k, names[k], '내검')
    Object.assign(g.u(k), { g: 200000, lv: k <= '2' ? 6 : 0, b: 6, it: { guard: 20, bless: 20, mana: 20, scale: 20, star: 5 } })
  }
  for (let i = 0; i < 3000; i++) {
    const k = keys[Math.floor(rand() * 4)]
    let line = cmds[Math.floor(rand() * cmds.length)]
    if (rand() < 0.3) {
      const to = names[keys[Math.floor(rand() * 4)]]
      const what = ['검', '보호', '축복', '마력석', '비늘', '결정'][Math.floor(rand() * 6)]
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
  const r1 = S.run(saved, 'r', { cmd: '강화', arg: '보호', key: '1', name: '가', prefix: '!', now: g2.now, rand: fixed(0.3) })
  eq(r1.card.result, 'guarded', 'continues after a JSON round trip')
  // 망가진 저장본
  const bad = { sword: { r: { u: { x: { g: '-5', lv: 99, it: { foo: 3, guard: '2', bless: -1 } }, y: null }, t: 'nope', q: 'a' } } }
  const r2 = S.run(bad, 'r', { cmd: '인벤', arg: '', key: 'x', name: '엑스', prefix: '!', now: T0, rand: fixed(0.5) })
  eq(r2.text, '[인벤] 엑스님\n골드 0G · 검 +30 태초의 창세검\n아이템 : 보호 주문서 2', 'broken saved state is cleaned')
  assert(Array.isArray(bad.sword.r.t) && bad.sword.r.q >= 1, 'broken lists fixed')
  // 방이 따로
  const two = {}
  S.run(two, 'a', { cmd: '내검', arg: '', key: '1', name: '가', prefix: '!', now: T0, rand: fixed(0.5) })
  eq(S.run(two, 'b', { cmd: '강화랭킹', arg: '', key: '1', name: '가', prefix: '!', now: T0 }).text, '아직 강화 기록이 없어요. 「!강화」로 시작해 보세요.', 'rooms are separate')
}

// ── 예전 저장본(+0~+20 시절: 비늘 1개 · 보호 1장 · 별빛 결정 없음)이 옮기지 않고 그대로 이어진다 ──
{
  // 예전 모양 그대로: 숫자 하나인 w, 예전 아이템 네 가지, 난이도(bl) 없는 방, 받는 사람 검이 없는 결투 신청
  const T1 = T0 - 3 * 24 * 3600 * 1000
  const oldRoom = {
    v: 1, q: 9, bk: 3, top: { lv: 20, n: '전설' },
    u: {
      a20: { n: '전설', g: 300000, lv: 20, id: 1, b: 20, it: { guard: 10, bless: 10, mana: 10, scale: 10 }, a: T1, e: T1, h: T1, w: T1, k: 2, s: 1, f: 3, d: S.dayNo(T1), ds: 4, dw: 2, dl: 1, r: T1 },
      a15: { n: '중간', g: 60000, lv: 15, id: 2, b: 17, it: { scale: 1, guard: 1, mana: 2 }, a: T1, e: T1, h: T1, w: 0, k: 0, s: 0, f: 0 },
      a7: { n: '새내기', g: 1000, lv: 7, id: 3, b: 7, it: {}, a: T1, e: 0, h: 0, w: {}, k: 0, s: 0, f: 0 },
    },
    t: [{ id: 8, f: 'a7', to: 'a20', it: 'duel', q: 1, p: 0, lv: 7, sid: 3, at: T0 - 1000 }],
  }
  const rt = { sword: { r: JSON.parse(JSON.stringify(oldRoom)) } }
  let now = T0
  const play = (key, name, line, x) => {
    const sp = line.search(/\s/)
    now += 20000
    return S.run(rt, 'r', { cmd: sp < 0 ? line : line.slice(0, sp), arg: sp < 0 ? '' : line.slice(sp + 1), key, name, prefix: '!', now, rand: fixed(x == null ? 0.999 : x) })
  }
  const u = (k) => rt.sword.r.u[k]
  // 보는 것만으로 아무것도 잃지 않는다(골드·단계·최고·아이템·기록)
  const info = play('a20', '전설', '내검')
  eq(info.text, '[내 검] 전설님\n+20 추억의 전설검 · 최고 +20\n골드 300,000G · 판매가 250,000G\n아이템 : 보호 주문서 10 · 축복 주문서 10 · 마력석 10 · 용의 비늘 10\n다음 강화 : 4,300G + 별빛 결정 1개 · 성공 18%(보정 +6%) · 파괴 18%\n보호하려면 보호 주문서가 5개 필요해요.', 'old +20 save: info')
  eq(JSON.stringify([u('a20').g, u('a20').lv, u('a20').b, u('a20').k, u('a20').f]), '[300000,20,20,2,3]', 'old +20 save: nothing lost')
  eq(rt.sword.r.bl, 3, 'old room: difficulty from kills')
  // 받는 사람 검이 적혀 있지 않은 예전 결투 신청도 그대로 겨룬다
  assert(play('a20', '전설', '수락', 0.5).text.startsWith('[결투] 새내기(+7) vs 전설(+20)'), 'old duel offer still fights')
  // 예전 최고 단계(+20)에서 이어서 강화한다: 별빛 결정이 없으면 알려 주고, 사서 보호하며 강화한다
  eq(play('a20', '전설', '강화 보호').text, '+20 강화에는 별빛 결정이 1개 필요해요. (보유 0개) 「!사냥」으로 모으거나 「!구매 결정 1」로 살 수 있어요.', 'old +20: needs a star')
  assert(play('a20', '전설', '구매 결정 1').text.startsWith('별빛 결정 1개를 300,000G에 샀어요. (보유 0G'), 'old +20: buys a star')
  u('a20').g = 50000
  const g20 = play('a20', '전설', '강화 보호 축복', 0.3) // 12 + 10 + 6 = 28 성공 · 파괴 18 → 0.3 은 파괴 구간
  eq(g20.card.result, 'guarded', 'old +20: guarded with 5 scrolls')
  eq(JSON.stringify(u('a20').it), '{"guard":5,"bless":9,"mana":10,"scale":10}', 'old +20: 5 scrolls, 1 bless and the star used')
  const up = play('a20', '전설', '구매 결정 1')
  assert(up.text.startsWith('골드가 부족해요.'), 'old +20: gold check')
  u('a20').it.star = 1
  const w21 = play('a20', '전설', '강화', 0)
  assert(w21.text.startsWith('[강화 성공]\n전설님의 검이 +21 천둥 폭풍검이 됐어요.\n[방 최고 기록] 이 방에서 처음 나온 +21 천둥 폭풍검이에요.'), 'old +20 → +21 ' + w21.text)
  eq(u('a20').b, 21, 'best record moves past the old cap')
  const h21 = play('a20', '전설', '사냥', 0.5)
  assert(/폭풍의 거인/.test(h21.text), 'old +20 hunts the new ground at +21 ' + h21.text)
  // 예전 +15(비늘 1개): 이제 2개가 필요하다고 알리고, 아무것도 쓰지 않는다. 사면 강화된다
  eq(play('a15', '중간', '강화').text, '+15 강화에는 용의 비늘이 2개 필요해요. (보유 1개) 「!사냥」으로 모으거나 「!구매 비늘 1」로 살 수 있어요.', 'old +15: needs 2 scales')
  eq(JSON.stringify([u('a15').g, u('a15').it.scale]), '[60000,1]', 'old +15: nothing taken')
  assert(play('a15', '중간', '구매 비늘').text.startsWith('용의 비늘 1개를 50,000G에 샀어요.'), 'old +15 buys a scale')
  eq(play('a15', '중간', '강화 보호', 0.2).text.split('\n')[0], '+15에서 보호하려면 보호 주문서가 2개 필요해요. (보유 1개) 「!구매 보호 1」로 살 수 있어요.', 'old +15: 2 scrolls to guard')
  eq(play('a15', '중간', '강화', 0).card.lv, 16, 'old +15 enhances')
  // 예전 +7
  assert(play('a7', '새내기', '강화', 0).text.startsWith('[강화 성공]\n새내기님의 검이 +8 은빛 성기사검이 됐어요.'), 'old +7 enhances')
  for (const k of Object.keys(rt.sword.r.u)) {
    const x = u(k)
    assert(x.lv >= 0 && x.lv <= S.MAX_LV && x.b >= x.lv && x.g >= 0 && Object.keys(x.it).every((id) => S.ITEMS[id] && x.it[id] > 0), 'old save stays valid ' + JSON.stringify(x))
  }
}

// ── 실패 보정 · 방 최고 기록 · 위로금 ─────────────────────────────────────
{
  const g = game()
  g.run('1', '가', '내검')
  // +9 성공 26%: 실패 2번 → 보정 +4% → 29.99 는 성공
  Object.assign(g.u('1'), { lv: 9, g: 100000, e: 0, w: 0, f: 0, it: { mana: 9 } })
  eq(g.run('1', '가', '강화', { rand: fixed(0.6) }).card.result, 'fail', 'pity: first fail')
  eq(g.u('1').f, 1, 'pity: one fail counted')
  g.tick(S.ENHANCE_CD_MS)
  const f2 = g.run('1', '가', '강화', { rand: fixed(0.6) })
  eq(f2.card.pity, 4, 'pity: card shows +4 for the next try')
  assert(f2.text.includes('실패 보정 +2%가 적용됐어요.') && f2.text.includes('성공 30%(보정 +4%)'), 'pity text ' + f2.text)
  g.tick(S.ENHANCE_CD_MS)
  const up = g.run('1', '가', '강화', { rand: fixed(0.2999) })
  eq(up.card.result, 'up', 'pity: 29.99 succeeds with +4')
  eq(g.u('1').f, 0, 'pity resets on success')
  // +10 은 방 최고 기록(처음 +10 이상)
  assert(up.text.includes('[방 최고 기록] 이 방에서 처음 나온 +10 얼음꽃 서리검이에요.') && up.card.notes.includes('방 최고 기록'), 'room record ' + up.text)
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
  const br = g.run('1', '가', '강화', { rand: fixed(0.999 - 0.2) }) // 21+6=27 성공 · 파괴 11 → 27~38, 79.9 는 실패
  eq(br.card.result, 'fail', 'pity +6: 79.9 is still a fail at +12')
  Object.assign(g.u('1'), { e: 0, w: 0, f: 0 })
  const br2 = g.run('1', '가', '강화', { rand: fixed(0.25) })
  eq(br2.card.result, 'broke', '+12 roll 25 → broke')
  eq(g.u('1').g, before - S.cost(12).gold * 2 + Math.floor(S.price(12) / 10), 'comfort gold paid')
  assert(br2.text.includes(`위로금 ${S.won(S.price(12) / 10)}G 받았어요.`) && br2.card.notes[0] === `위로금 ${S.won(S.price(12) / 10)}G`, 'comfort text ' + br2.text)
  eq(g.u('1').f, 0, 'pity resets on break')
  // 낮은 단계는 위로금 없음
  Object.assign(g.u('1'), { lv: 6, e: 0, w: 0 })
  const b6 = g.run('1', '가', '강화', { rand: fixed(0.43) }) // +6: 성공 41 · 파괴 5
  assert(b6.card.result === 'broke' && !b6.text.includes('위로금'), 'no comfort below +10')
}

// ── 실패 보정은 그 검에 쌓인 것: 팔거나 거래로 검이 바뀌면 처음부터 ──────────
{
  const g = game()
  g.run('1', '가', '내검')
  g.run('2', '나', '내검')
  Object.assign(g.u('1'), { lv: 16, g: 0, f: 5 })
  g.run('1', '가', '판매 확인')
  assert(g.u('1').lv === 0 && g.u('1').f === 0, 'pity resets on sell')
  // 나(실패 4번)가 +19 를 가(실패 5번)에게 넘긴다 → 둘 다 0
  Object.assign(g.u('1'), { f: 5 })
  Object.assign(g.u('2'), { lv: 19, b: 19, f: 4 })
  g.run('2', '나', '거래 @가 검 0')
  eq(g.run('1', '가', '수락').text, '[거래 완료] 가님이 나님에게서 +19 칠흑의 마왕검을 받았어요.', 'sword gift')
  eq(g.u('1').f, 0, 'pity resets for the one who got the sword')
  eq(g.u('2').f, 0, 'pity resets for the one who gave it away')
  assert(!g.run('1', '가', '내검').text.includes('보정'), 'no pity on the received sword')
}

// ── 사냥·공격 쿨타임은 검을 따라간다: 무료로 검을 돌려 가며 여럿이 높은 단계 사냥을 하지 못한다 ──
{
  const g = game()
  g.run('1', '가', '내검')
  g.run('2', '나', '내검')
  Object.assign(g.u('1'), { lv: 18, b: 18 })
  assert(g.run('1', '가', '사냥', { rand: fixed(0.5) }).text.startsWith('[사냥] 가님이 '), 'giver hunts')
  g.run('2', '나', '공격')
  g.tick(10000)
  g.run('1', '가', '공격')
  const h1 = g.u('1').h
  const r1 = g.u('1').r
  g.tick(10000)
  g.run('1', '가', '거래 @나 검 0')
  assert(g.run('2', '나', '수락').text.startsWith('[거래 완료] 나님이 가님에게서 +18 '), 'free sword gift')
  eq(g.u('2').h, h1, 'hunt time follows the sword')
  eq(g.u('2').r, r1, 'attack time follows the sword (the later of the two)')
  eq(g.run('2', '나', '사냥').text, `나님, 사냥은 ${(S.HUNT_CD_MS - 20000) / 1000 / 60 | 0}분 ${((S.HUNT_CD_MS - 20000) / 1000) % 60}초 뒤에 다시 할 수 있어요.`, 'receiver waits for the giver\'s hunt cooldown')
  g.tick(S.HUNT_CD_MS - 20000)
  assert(g.run('2', '나', '사냥', { rand: fixed(0.5) }).text.startsWith('[사냥] 나님이 '), 'hunt once the sword\'s cooldown is over')
  // 쿨타임이 더 남은 사람이 받으면 그대로(짧아지지 않는다)
  g.run('2', '나', '거래 @가 검 0')
  g.run('1', '가', '수락')
  eq(g.u('1').h, g.u('2').h, 'the later hunt time is kept')
}

// ── 출석 ──────────────────────────────────────────────────────────────────
{
  const g = game()
  const a1 = g.run('1', '가', '출석')
  eq(a1.text, `[출석] 가님 출석했어요.\n+400G (보유 ${S.won(S.START_GOLD + 400)}G)\n6일 더 연속으로 오면 보호 주문서·축복 주문서를 받아요.`, 'attend day 1')
  eq(g.run('1', '가', '출첵').text, '가님은 오늘 이미 출석했어요. (1일 연속) 내일 또 와 주세요.', 'attend twice a day')
  for (let d = 2; d <= 7; d++) {
    g.tick(24 * 3600 * 1000)
    const r = g.run('1', '가', '출석')
    if (d === 2) assert(r.text.startsWith('[출석] 가님 2일 연속 출석했어요.\n+500G'), 'attend day 2 ' + r.text)
    if (d === 7) eq(r.text, `[출석] 가님 7일 연속 출석했어요.\n+1,000G · 보호 주문서 1개 · 축복 주문서 1개 (보유 ${S.won(g.u('1').g)}G)\n7일 연속 보너스를 받았어요.`, 'attend day 7')
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
  eq(S.duelChance(30, 20), 90, 'duel cap from a 10-level gap')
  eq(S.duelChance(25, 24), 54, 'duel chance at the top')
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
  assert(g.run('1', '가', '수락', { rand: fixed(0.01) }).text.includes('대역전이에요. 나님의 녹슨 철검이'), 'upset is called out')
  // 수락할 때 신청한 사람 골드가 모자라면 취소
  g.tick(S.DUEL_CD_MS)
  g.run('2', '나', '결투 @가 100')
  g.u('2').g = 0
  eq(g.run('1', '가', '수락').text, '나님의 골드가 부족해서 결투를 취소했어요.', 'duel cancelled when bet is gone')
  // 멘션으로도
  g.tick(S.DUEL_CD_MS)
  assert(g.run('1', '가', '결투 @나나', { mentions: ['2'] }).text.startsWith('[결투 신청] 가(+12) → 나(+0)'), 'duel by mention')
}

// ── 결투: 신청 뒤 누구의 검이든 바뀌면 수락 때 취소(신청 때 보여 준 승률 그대로 겨룬다) ──
{
  const g = game()
  for (const [k, n] of [['1', '가'], ['2', '나'], ['3', '다']]) g.run(k, n, '내검')
  Object.assign(g.u('1'), { lv: 3, g: 100000 })
  Object.assign(g.u('2'), { lv: 3, g: 100000 })
  Object.assign(g.u('3'), { lv: 18, b: 18 })
  // 가(+3)가 신청 → 팔고 다에게서 +18 을 받는다 → 나의 수락은 취소
  assert(g.run('1', '가', '결투 @나 10000').text.includes('가님 승률 50%'), 'duel shown at 50%')
  g.run('1', '가', '판매')
  g.run('3', '다', '거래 @가 검 0')
  assert(g.run('1', '가', '수락').text.startsWith('[거래 완료]') && g.u('1').lv === 18, 'challenger takes a +18 while the duel waits')
  const gold = [g.u('1').g, g.u('2').g]
  eq(g.run('2', '나', '수락').text, '가님의 검이 바뀌어서 결투를 취소했어요.', 'challenger sword changed → cancelled')
  eq(g.s().t.length, 0, 'challenger changed: offer dropped')
  eq(JSON.stringify([g.u('1').g, g.u('2').g]), JSON.stringify(gold), 'challenger changed: no gold moved')
  // 받는 사람이 강화해서 검이 바뀜 → 취소
  g.tick(S.DUEL_CD_MS)
  g.run('1', '가', '결투 @나 10000')
  g.run('2', '나', '강화', { rand: fixed(0) })
  eq(g.u('2').lv, 4, 'target enhanced while the duel waits')
  eq(g.run('2', '나', '수락').text, '나님의 검이 바뀌어서 결투를 취소했어요.', 'target sword changed → cancelled')
  eq(g.s().t.length, 0, 'target changed: offer dropped')
  // 결투 신청 취소·바꾸기 말은 「결투 신청」
  g.tick(S.DUEL_CD_MS)
  g.run('1', '가', '결투 @나')
  eq(g.run('1', '가', '거래취소').text, '보낸 결투 신청을 취소했어요.', 'duel cancel wording')
  g.tick(S.DUEL_CD_MS)
  g.run('1', '가', '결투 @나')
  g.u('1').it = { guard: 1 }
  assert(g.run('1', '가', '거래 @다 보호 1 1').text.endsWith('(먼저 보낸 결투 신청은 취소했어요)'), 'trade replaces a duel')
  g.tick(S.DUEL_CD_MS)
  assert(g.run('1', '가', '결투 @나').text.endsWith('(먼저 보낸 거래 제안은 취소했어요)'), 'duel replaces a trade')
  // 받는 사람이 결투 신청을 받는 중이면 거래·결투 모두 그 이름(「결투 신청」)으로 막는다
  g.u('3').it = { guard: 1 }
  eq(g.run('3', '다', '거래 @나 보호 1 10').text, '나님이 다른 결투 신청을 받고 있어요. 잠시 뒤 다시 해 주세요.', 'trade to a target busy with a duel')
  eq(g.run('3', '다', '결투 @나').text, '나님이 다른 결투 신청을 받고 있어요. 잠시 뒤 다시 해 주세요.', 'duel to a target busy with a duel')
  // 이 기능 전에 저장된 신청(tl·tsid 없음)은 받는 사람 검을 보지 않는다
  const t = g.s().t[0]
  delete t.tl
  delete t.tsid
  g.u('2').lv = 9
  assert(g.run('2', '나', '수락', { rand: fixed(0.5) }).text.startsWith('[결투] 가(+18) vs 나(+9)'), 'offer saved before the snapshot still fights')
}

// ── 결투: 「민수 92」처럼 이름 끝의 수는 내기가 아니다 ───────────────────────
{
  const g = game()
  g.run('1', '철수', '내검')
  g.run('200', '민수 92', '내검')
  g.run('300', '부자 1000000', '내검')
  g.u('300').g = 2000000
  const next = () => {
    g.run('1', '철수', '거래취소')
    g.tick(S.DUEL_CD_MS)
  }
  const o1 = g.run('1', '철수', '결투 @민수 92', { mentions: ['200'] }).text
  assert(o1.startsWith('[결투 신청] 철수(+0) → 민수 92(+0)\n내기 없음 · '), 'mention: digits in the name are not a bet ' + o1)
  eq(g.s().t[0].p, 0, 'mention: no bet stored')
  next()
  assert(g.run('1', '철수', '결투 @민수 92 500', { mentions: ['200'] }).text.includes('\n내기 500G · '), 'mention + bet')
  next()
  assert(g.run('1', '철수', '결투 @민수 92').text.includes('\n내기 없음 · '), 'typed full name with digits')
  next()
  assert(g.run('1', '철수', '결투 @민수 92 500').text.includes('\n내기 500G · '), 'typed name + bet')
  next()
  // 1,000G 밖에 없어도 이름 끝의 큰 수 때문에 막히지 않는다
  assert(g.run('1', '철수', '결투 @부자 1000000', { mentions: ['300'] }).text.includes('\n내기 없음 · '), 'a big number in the name is not a bet')
  next()
  // 저장된 이름이 옛것(검 강화를 한 뒤 이름을 바꿈)이어도 멘션 글자 수(len)로 이름과 내기를 가른다
  g.run('22', '민수', '내검')
  g.run('33', '철수2', '내검')
  const stale = g.run('1', '철수', '결투 @민수 92', { mentions: ['22'], mentionLen: { 22: 5 } })
  assert(stale.text.includes('\n내기 없음 · ') && g.s().t[0].p === 0, 'stale stored name is a prefix of the new nickname: no bet ' + stale.text)
  next()
  assert(g.run('1', '철수', '결투 @민수 92 500', { mentions: ['22'], mentionLen: { 22: 5 } }).text.includes('\n내기 500G · '), 'mention len + bet')
  next()
  assert(g.run('1', '철수', '결투 @영희 92', { mentions: ['33'], mentionLen: { 33: 5 } }).text.includes('\n내기 없음 · '), 'renamed person: no bet')
  next()
  assert(g.run('1', '철수', '결투 @영희 92 300골드', { mentions: ['33'], mentionLen: { 33: 5 } }).text.includes('\n내기 300G · '), 'renamed person + bet with unit')
  next()
  // len 이 글과 맞지 않으면(@ 뒤 글자가 모자라거나 이름 중간에서 끊김) 예전처럼 읽는다
  for (const len of [1, 10]) {
    assert(g.run('1', '철수', '결투 @민수 92', { mentions: ['200'], mentionLen: { 200: len } }).text.includes('\n내기 없음 · '), 'len that does not fit the text falls back to the stored name ' + len)
    next()
  }
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
  eq(b.text, '[보스 등장] 거대 왕슬라임이 나타났어요.\n체력 4,000\n「!공격」으로 함께 쓰러뜨리면 피해량만큼 골드를 나눠 받아요.', 'boss appears')
  // rand 0.5 → 피해 ×1.0, 치명타 없음(0.5 ≥ 0.1). +12 는 1,692 지만 한 번에 최대 체력의 25%(1,000)까지
  eq(S.BOSS_HIT_MAX, 0.25, 'one hit is at most 25% of max hp')
  eq(S.hitBase(12), 1692, 'hit +12')
  eq(g.run('1', '가', '공격', { rand: fixed(0.5) }).text, '[공격] 가님이 거대 왕슬라임에게 1,000 피해를 줬어요.\n남은 체력 3,000 (최대 4,000)\n■■■■■■■■□□', 'attack (capped)')
  eq(g.run('1', '가', '공격').text, '가님, 공격은 1분 뒤에 다시 할 수 있어요.', 'attack cooldown')
  eq(g.run('1', '가', '공격').text, '', 'attack cooldown said once')
  const crit = g.run('2', '나', '공격', { rand: fixed(0.05) }) // 치명타 ×2, 피해 ×0.82
  eq(crit.text.split('\n')[0], `[공격] 나님이 거대 왕슬라임에게 치명타로 ${S.won(Math.round(S.hitBase(5) * 0.82 * 2))} 피해를 줬어요.`, 'critical hit')
  assert(g.run('3', '다', '보스').text.startsWith('[보스] 거대 왕슬라임\n체력 ') && g.run('3', '다', '보스').text.includes(' (최대 4,000)\n') && g.run('3', '다', '보스').text.endsWith('참여 2명 · 「!공격」으로 함께 쓰러뜨려요.'), 'boss status')
  g.run('3', '다', '공격', { rand: fixed(0.5) })
  // 남은 체력 4,000 - 1,000 - 754 - 60 = 2,186 → 가가 1분마다 1,000 · 1,000 · 186
  let kill = null
  const hits = []
  for (let i = 0; i < 3; i++) {
    g.tick(S.ATTACK_CD_MS)
    kill = g.run('1', '가', '공격', { rand: fixed(0.5) })
    hits.push(kill.text.split('\n')[0])
  }
  eq(hits.slice(0, 2).join('|'), '[공격] 가님이 거대 왕슬라임에게 1,000 피해를 줬어요.|[공격] 가님이 거대 왕슬라임에게 1,000 피해를 줬어요.', 'capped hits until the end')
  eq(hits[2], '[공격] 가님이 거대 왕슬라임에게 186 피해를 줬어요.', 'last hit takes only what is left')
  assert(kill.text.includes('[보스 처치] 가님의 마지막 일격으로 거대 왕슬라임을 쓰러뜨렸어요.\n마지막 일격 : 가님 (마력석 2개 · 축복 주문서 1개)\n가장 큰 피해 : 가님 (축복 주문서 2개)\n1. 가 '), 'boss killed ' + kill.text)
  assert(kill.text.endsWith('다음 보스는 30분 뒤에 나타나요.'), 'next boss time')
  const paid = ['1', '2', '3'].map((k) => g.u(k).g)
  // 다(+0)는 1인 최소 100G 몫이지만, 그만큼 합이 나눌 골드(4,000 × 0.15 = 600G)를 넘어서 모두 같은 비율로 줄었다
  eq(S.BOSS_REWARD, 0.15, 'boss gold 0.15 per damage')
  assert(paid.every((x) => x > 50) && paid.reduce((a, x) => a + x, 0) <= 4000 * S.BOSS_REWARD && paid.reduce((a, x) => a + x, 0) >= 4000 * S.BOSS_REWARD - 3 && paid[0] > paid[1] && paid[1] > paid[2], 'reward split by damage ' + paid)
  eq(g.u('1').it.mana, 2, 'last hit mana')
  eq(g.u('1').it.scale, undefined, 'no scale from the first boss')
  eq(g.u('1').it.bless, 3, 'last hit bless + mvp bless')
  eq(g.s().r, null, 'boss gone')
  eq(g.s().bk, 1, 'boss count')
  eq(g.run('2', '나', '공격').text, '다음 보스는 30분 뒤에 나타나요.', 'no boss during the gap')
  g.tick(S.BOSS_GAP_MS)
  assert(g.run('2', '나', '공격', { rand: fixed(0.5) }).text.startsWith('[보스 등장] 고블린 족장이 나타났어요.\n체력 8,000\n「!공격」으로 함께 쓰러뜨리면 피해량만큼 골드를 나눠 받아요.\n[공격] 나님이 고블린 족장에게'), 'attack spawns the next boss')
  // 하루 안에 못 쓰러뜨리면 도망
  g.tick(S.BOSS_TTL_MS)
  eq(g.run('3', '다', '보스').text, '고블린 족장이 도망갔어요.\n다음 보스는 30분 뒤에 나타나요.', 'boss flees')
  eq(g.s().bk, 1, 'fled boss is not counted')
  eq(g.s().bl, 0, 'fled boss → the next boss is one step easier')
  // 다섯을 다 쓰러뜨린 뒤에는 체력 1.5배
  g.s().bl = 5
  g.tick(S.BOSS_GAP_MS)
  assert(g.run('3', '다', '보스').text.startsWith('[보스 등장] 거대 왕슬라임이 나타났어요.\n체력 6,000'), 'second round is tougher')
  // 마지막 일격 보상은 보스마다: 앞의 넷은 마력석 2 + 축복 1, 심연의 마왕은 용의 비늘 1 + 보호 1(별빛 결정은 보스에서 안 나온다)
  for (let i = 0; i < 4; i++) eq(JSON.stringify(S.bossLastReward(i)), '[["mana",2],["bless",1]]', 'last hit reward of boss ' + i)
  eq(JSON.stringify(S.bossLastReward(4)), '[["scale",1],["guard",1]]', 'last hit reward of 심연의 마왕')
  Object.assign(g.s(), { r: null, bl: 9, rn: 0 }) // 두 바퀴째 심연의 마왕
  assert(g.run('1', '가', '보스').text.startsWith('[보스 등장] 심연의 마왕이 나타났어요.\n체력 75,000\n'), '심연의 마왕 lap 2')
  g.s().r.hp = 10
  g.u('1').it = {}
  g.tick(S.ATTACK_CD_MS)
  const demon = g.run('1', '가', '공격', { rand: fixed(0.5) })
  assert(demon.text.includes('\n마지막 일격 : 가님 (용의 비늘 1개 · 보호 주문서 1개)\n가장 큰 피해 : 가님 (축복 주문서 2개)\n'), '심연의 마왕 last hit ' + demon.text)
  eq(JSON.stringify(g.u('1').it), '{"scale":1,"guard":1,"bless":2}', '심연의 마왕 items')
  // 망가진 저장본은 지운다
  g.s().r = { i: 99, hp: 1, mx: 1, d: {} }
  S.roomState(g.rt, 'r')
  eq(g.s().r, null, 'bad boss dropped')
}

// ── 보스: 높은 단계 혼자 나타나자마자 쓰러뜨리지 못한다(한 번에 최대 체력의 25%까지, 치명타도) ──
{
  for (const [lv, bl] of [[20, 0], [25, 0], [30, 0], [30, 1], [30, 5], [30, 10]]) {
    const g = game()
    g.run('1', '고수', '내검')
    Object.assign(g.u('1'), { lv, g: 0 })
    g.s().bl = bl
    const rand = seeded(lv * 100 + bl)
    for (let t = 0; t < 200; t++) {
      Object.assign(g.s(), { r: null, rn: 0, bl })
      g.u('1').r = 0
      const r = g.run('1', '고수', '공격', { rand })
      const mx = g.s().r ? g.s().r.mx : 0
      assert(r.text.startsWith('[보스 등장] ') && !r.text.includes('[보스 처치]') && g.s().r && g.s().r.hp === mx - Math.ceil(mx * S.BOSS_HIT_MAX), `+${lv} bl ${bl}: the spawning reply never kills, one hit = 25% ` + r.text)
    }
    // 치명타(rand < 0.1)도 25%까지 · 혼자면 적어도 네 번
    Object.assign(g.s(), { r: null, rn: 0, bl })
    g.u('1').r = 0
    let n = 0
    let done = false
    while (!done && n < 10) {
      done = g.run('1', '고수', '공격', { rand: fixed(0.05) }).text.includes('[보스 처치]')
      n++
      g.tick(S.ATTACK_CD_MS)
    }
    eq(n, 4, `+${lv} bl ${bl}: a lone top player needs four hits`)
  }
}

// ── 보스: 도망간 때부터 30분 · 도망가면 한 단계 쉬운 보스 · 보상 합은 나눌 골드를 넘지 않는다 ──
{
  const g = game()
  g.run('1', '가', '내검')
  g.run('1', '가', '보스') // 거대 왕슬라임
  // 아무도 안 치고 사흘 뒤: 도망간 지 오래라 그 자리에서 다음 보스
  g.tick(3 * 24 * 3600 * 1000)
  eq(g.run('1', '가', '보스').text, '거대 왕슬라임이 도망갔어요.\n[보스 등장] 거대 왕슬라임이 나타났어요.\n체력 4,000\n「!공격」으로 함께 쓰러뜨리면 피해량만큼 골드를 나눠 받아요.', 'long-fled boss → the next one right away')
  // 도망간 지 10분 뒤에 보면 남은 20분만 기다린다
  g.tick(S.BOSS_TTL_MS + 10 * 60 * 1000)
  eq(g.run('1', '가', '보스').text, '거대 왕슬라임이 도망갔어요.\n다음 보스는 20분 뒤에 나타나요.', 'the wait counts from the flee')
  eq(g.s().bk, 0, 'fled bosses are not kills')
  // 난이도: 심연의 마왕(4)이 도망가면 화염 드레이크(3), 두 바퀴째 첫 보스(5)가 도망가면 첫 바퀴 같은 보스(0)
  const fleeFrom = (bl) => {
    Object.assign(g.s(), { r: null, bl, rn: 0 })
    g.run('1', '가', '보스')
    g.tick(S.BOSS_TTL_MS + S.BOSS_GAP_MS)
    return g.run('1', '가', '보스').text
  }
  assert(fleeFrom(4).startsWith('심연의 마왕이 도망갔어요.\n[보스 등장] 화염 드레이크가 나타났어요.\n체력 28,000\n'), 'flee → one step easier boss')
  assert(fleeFrom(5).startsWith('거대 왕슬라임이 도망갔어요.\n[보스 등장] 거대 왕슬라임이 나타났어요.\n체력 4,000\n'), 'flee on a lap start → same boss one lap back')
  assert(fleeFrom(0).startsWith('거대 왕슬라임이 도망갔어요.\n[보스 등장] 거대 왕슬라임이 나타났어요.\n체력 4,000\n'), 'easiest boss stays the easiest')
  eq(g.s().bk, 0, 'difficulty is apart from the kill count')
  // 난이도가 없는 예전 저장본은 쓰러뜨린 수에서 시작
  delete g.s().bl
  g.s().bk = 7
  S.roomState(g.rt, 'r')
  eq(g.s().bl, 7, 'legacy save: difficulty = kills')
  // 하루에 넣는 피해가 보스 체력보다 적은 방(+5 혼자 30분마다)도 쉬운 보스로 내려가 다시 쓰러뜨린다
  const w = game()
  w.run('1', '가', '내검')
  w.u('1').lv = 5
  Object.assign(w.s(), { bk: 4, bl: 4 })
  const rand = seeded(5)
  let kills = 0
  for (let i = 0; i < 10 * 48; i++) {
    if (w.run('1', '가', '공격', { rand }).text.includes('[보스 처치]')) kills++
    w.tick(30 * 60 * 1000)
  }
  assert(kills >= 2 && w.s().bk === 4 + kills, 'a stuck room gets easier bosses and kills again (' + kills + ')')
  // 조금 친 사람이 많아도(+10 하나 + +0 스물아홉) 보상 합은 체력 × 0.15 를 넘지 않는다
  const o = game()
  const ks = Array.from({ length: 30 }, (_, i) => String(100 + i))
  for (const k of ks) {
    o.run(k, '사람' + k, '내검')
    Object.assign(o.u(k), { lv: k === '100' ? 10 : 0, g: 0 })
  }
  o.run('100', '사람100', '보스')
  const rand2 = seeded(3)
  let killed = false
  for (let round = 0; round < 50 && !killed; round++) {
    for (const k of ks) {
      if (o.run(k, '사람' + k, '공격', { rand: rand2 }).text.includes('[보스 처치]')) {
        killed = true
        break
      }
    }
    o.tick(S.ATTACK_CD_MS)
  }
  const pool = 4000 * S.BOSS_REWARD
  const paid = ks.map((k) => o.u(k).g)
  const sum = paid.reduce((a, x) => a + x, 0)
  assert(killed && sum <= pool && sum >= pool - 2 * ks.length, 'crowd payout stays within the pool ' + sum)
  assert(paid.every((x) => x > 0) && paid[0] === Math.max(...paid), 'crowd payout: everyone gets some, the big hitter the most ' + paid)
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
  // 묶음마다 그려 둔 검 그림(assets/swords/tier{art}.png): 처음 8장(tier0~7)은 늘 있고, 있는 그림은 서로 다르고, 진열장·랭킹이 그 그림을 쓴다.
  // 새 묶음 그림(tier8~13)은 없어도 된다 — 없으면 벡터 검으로 그린다(아래 vector 점검)
  const arts = new Set()
  let have = 0
  for (const f of S.FAMILIES) {
    const art = A.artOf(f.from)
    if (f.art < 8) assert(art, 'sword art for family ' + f.name)
    if (!art) continue
    assert(art.uri.startsWith('data:image/png;base64,') && art.w > 40 && art.h > 300, 'sword art shape for family ' + f.name)
    arts.add(art.uri)
    have++
  }
  eq(arts.size, have, 'every family with a picture has its own picture')
  for (let lv = 0; lv <= S.MAX_LV; lv++) eq(A.artOf(lv), A.artOf(S.FAMILIES[S.tierOf(lv)].from), 'a level uses its family art ' + lv)
  // 그림 파일이 없는 폴더: 모두 null(던지지 않는다)
  const none = A.loadArt('/nonexistent/sword-art-dir')
  assert(none.length === S.FAMILIES.length && none.every((x) => x === null), 'missing art files → null, no throw')
  // 그림 없이(벡터 검) 31단계 모두: 진열장·랭킹이 그림 파일 없이 그려진다
  for (let lv = 0; lv <= S.MAX_LV; lv++) {
    const v = A.cardSvg({ kind: 'info', lv, best: lv, owner: '벡터', gold: 1, price: S.price(lv), broken: 0, items: [], next: null }, { vector: true })
    assert(!v.includes('data:image/png') && v.includes('<path') && !/NaN|undefined/.test(v), 'vector fallback card ' + lv)
    const vb = A.cardSvg({ kind: 'enhance', result: 'broke', from: lv, lv: 0, best: lv, owner: '벡터', gold: 0, spent: 1, used: [] }, { vector: true })
    assert(!vb.includes('data:image/png') && !/NaN|undefined/.test(vb), 'vector fallback broken card ' + lv)
  }
  const rv = A.cardSvg({ kind: 'rank', rows: [{ name: '가', lv: 30, best: 30 }, { name: '나', lv: 23, best: 23 }] }, { vector: true })
  assert(!rv.includes('data:image/png') && !/NaN|undefined/.test(rv), 'vector fallback rank card')
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
    { kind: 'enhance', result: 'guarded', from: 27, lv: 27, best: 28, owner: '일식', gold: 1, spent: 7400, used: ['보호 주문서 25개', '축복 주문서 1개'], pity: 10, seed: 8 },
    { kind: 'enhance', result: 'up', from: 29, lv: 30, best: 30, owner: '창세', gold: 1, spent: 8700, used: ['보호 주문서 35개', '축복 주문서 1개'], seed: 9 },
    { kind: 'info', lv: 24, best: 24, owner: '해일', gold: 1234567, price: 730000, broken: 2, items: ['보호 주문서', '축복 주문서', '마력석', '용의 비늘', '별빛 결정'].map((name, i) => ({ name, short: ['보호', '축복', '마력석', '비늘', '결정'][i], n: [12, 3, 999, 4, 17][i] })), next: { gold: 5900, mana: 0, scale: 0, star: 2, up: 19, broke: 22, pity: 10, guard: 10 }, seed: 10 },
  ]
  for (const c of cards) {
    const svg = A.cardSvg(c)
    // 붙인 그림(base64) 안의 글자는 빼고 본다
    assert(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg"') && svg.endsWith('</svg>') && !/NaN|undefined/.test(svg.replace(/data:image\/png;base64,[A-Za-z0-9+/=]+/g, '')), 'card svg ' + c.kind + ' ' + c.result)
    eq(A.cardSvg(c), svg, 'card svg deterministic')
  }
  // 높은 단계 카드: 다음 강화에 재료 수, 보호에 드는 주문서 수, 쓴 주문서 칩(수), 다섯 가지 아이템 칸
  const c27 = A.cardSvg(cards[8])
  assert(c27.includes('7,400G + 결정 5') && c27.includes('보호하려면 보호 주문서 25개') && c27.includes('보호 주문서 25개') && c27.includes('혼돈의 일식검'), 'enhance card at +27')
  const c30 = A.cardSvg(cards[9])
  assert(c30.includes('최고 단계 달성') && c30.includes('태초의 창세검') && !c30.includes('보호하려면'), 'enhance card at +30')
  const c24 = A.cardSvg(cards[10])
  assert(c24.includes('5,900G + 결정 2') && c24.includes('보호하려면 보호 주문서 10개') && c24.includes('>결정<') && c24.includes('>999<') && c24.includes('해신의 해일검'), 'info card at +24')
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
    for (const c of [cards[0], cards[1], cards[5], cards[7], cards[9], cards[10]]) assert(PNG(A.cardPng(c)), 'card renders to PNG ' + c.kind)
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
  eq(S.HELP_CMDS.join(' '), '강화 내검 사냥 출석 결투 보스 강화랭킹 강화도움', 'roomfeat helpLine lists the same sword commands')
  assert(hb.includes(' ▸ !강화 · !내검 · !사냥 · !출석\n ▸ !결투 · !보스 · !강화랭킹\n ▸ !강화도움'), 'sword block lines ' + hb)

  let now = Date.now()
  const send = (view, text, id, name, opt) => {
    const o = opt || {}
    const rec = R.adapterRecord(view, 'b')
    if (o.cool !== true) rec.config.minigame.cooldownMs = 0
    if (o.images === false) rec.config.minigame.images = false
    return onInbound(rec, { chatId: view.chat_id, text, authorName: name, authorId: id, mentions: o.mentions, mentionLen: o.mentionLen, mine: false })
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
  // 멘션 글자 수(len)도 onInbound 로 들어온다: 저장된 이름 「둘」, 지금 닉네임 「둘 77」
  const dl = send(w, '!결투 @둘 77', '501', '검사', { mentions: ['502'], mentionLen: { 502: 4 } })
  assert(dl[0].text.startsWith('[결투 신청] 검사(+') && dl[0].text.includes('\n내기 없음 · '), 'mention len through onInbound ' + dl[0].text)
  send(w, '!거래취소', '501', '검사')
  // 방 설치형 「게임」 목록에도
  eq(send(w, '!게임', '502', '둘')[0].text, helpCard('K bot 명령어', [{ name: '미니게임', cmds: ['끝말잇기', '숫자야구', '주사위', '가위바위보', '퀴즈', '힌트', '정답', '포기', '랭킹'].map((c) => '!' + c) }, { name: '검 강화', cmds: S.helpCommands('!') }]), 'game list')
  // 계정 단위 옛 기능(byId 아님)에는 검 강화가 없다
  const legacy = { config: { minigame: { enabled: true, rooms: ['k'], cmdPrefix: '!', cooldownMs: 0 } }, rooms: [{ key: 'k', chat_id: '88', name: '옛방', kind: 'open', list_kind: 'open_room' }], runtime: {}, features: { macro: false, roombot: false, minigame: true } }
  eq(onInbound(legacy, { chatId: '88', text: '!강화', authorName: '옛', mine: false }).length, 0, 'legacy account path has no sword game')
  void now
}

process.stdout.write('sword check ok\n')
