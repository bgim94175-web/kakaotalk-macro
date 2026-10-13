// 미니게임 「추억의 검 강화」 — 순수 모듈. 네트워크·DB·타이머를 쓰지 않고, 시각(now)과 난수(rand)는 늘 인자로 받는다.
// 상태는 방 runtime.sword[방 열쇠] = { v, u: {사람 열쇠: 사람}, t: [거래 제안], q: 다음 번호 } 하나뿐(점수처럼 room_state 에 저장).
// features.mjs 가 명령어를 넘기고(run), 답 글과 카드(card)를 받아 보낸다. 카드 그림은 sword-art.mjs.
//
// 사람 u = { n: 이름, g: 골드, lv: 검 단계, id: 검 번호, b: 최고 단계, it: {guard, bless, mana, scale}, a: 마지막 활동,
//            e: 마지막 강화, h: 마지막 사냥, w: 쿨타임 안내를 이미 한 행동 시각, k: 부서진 횟수, s: 판매 횟수 }
// 거래 t = { id, f: 판 사람, to: 받을 사람, it: 아이템 id 또는 'sword', q: 수량, p: 가격, lv, sid: 검 번호, at }
import { josa } from './roomfeat.mjs'

export const MAX_LV = 20
export const START_GOLD = 1000
export const MAX_GOLD = 999999999
export const MAX_ITEM = 999
export const MAX_USERS = 200
export const MAX_TRADES = 40
export const IDLE_MS = 180 * 24 * 60 * 60 * 1000 // 180일 동안 안 한 사람은 정리한다
export const ENHANCE_CD_MS = 10 * 1000
export const HUNT_CD_MS = 2 * 60 * 1000
export const TRADE_TTL_MS = 2 * 60 * 1000
export const MAX_PRICE = 100000000
export const SELL_CONFIRM_LV = 10 // 이 단계부터 「판매 확인」을 받는다
export const BLESS_PCT = 10

// 단계별 [성공 %, 파괴 %]. 나머지는 실패(검은 그대로).
const CHANCE = [
  [95, 0], [90, 0], [85, 0], [80, 0], [75, 0],
  [70, 2], [65, 3], [60, 4], [55, 5], [50, 6],
  [45, 8], [40, 10], [35, 12], [30, 14], [25, 16],
  [20, 18], [15, 20], [10, 22], [7, 25], [5, 30],
]
// 단계별 강화 비용(골드)
const COST = [100, 150, 200, 300, 400, 600, 800, 1000, 1300, 1600, 2000, 2500, 3000, 3600, 4300, 5000, 6000, 7000, 8500, 10000]
// 단계별 판매가(골드)
const PRICE = [0, 100, 250, 500, 800, 1200, 1800, 2600, 3600, 5000, 7000, 9500, 13000, 18000, 25000, 35000, 50000, 70000, 100000, 150000, 250000]

// 검의 이름은 단계 묶음(tier)마다. 그림도 묶음마다 바뀐다(sword-art.mjs).
export const TIERS = [
  { from: 0, name: '녹슨 철검' },
  { from: 3, name: '강철 장검' },
  { from: 6, name: '은빛 기사검' },
  { from: 9, name: '푸른 서리검' },
  { from: 12, name: '붉은 화염검' },
  { from: 15, name: '황금 용검' },
  { from: 18, name: '칠흑의 마검' },
  { from: 20, name: '추억의 전설검' },
]

export const ITEMS = {
  guard: { name: '보호 주문서', buy: 4000, sell: 1000, desc: '강화하다 부서질 때 검을 지켜 줘요', alias: ['보호', '보호주문서', '보호권', '파괴방지'] },
  bless: { name: '축복 주문서', buy: 2000, sell: 500, desc: `강화 성공 확률 +${BLESS_PCT}%`, alias: ['축복', '축복주문서'] },
  mana: { name: '마력석', buy: 2500, sell: 800, desc: '+10부터 강화할 때 1개씩 써요', alias: ['마력석', '마석'] },
  scale: { name: '용의 비늘', buy: 0, sell: 3000, desc: '+15부터 강화할 때 1개씩 써요 (사냥에서만)', alias: ['용의비늘', '비늘', '용비늘'] },
}
const ITEM_IDS = Object.keys(ITEMS)
const SWORD_ALIAS = ['검', '칼']

// 사냥터: 검 단계가 높을수록 센 몬스터(이름은 모두 이 게임에서 지은 것)
const HUNT = [
  [['초록 슬라임', 80, 150], ['들판 토끼', 70, 140], ['꼬마 고블린', 100, 180]],
  [['동굴 박쥐', 120, 220], ['버섯 도깨비', 130, 240], ['떠돌이 들개', 150, 260]],
  [['해골 병사', 220, 380], ['늪지 도마뱀', 250, 400], ['잿빛 늑대', 230, 360]],
  [['바위 오우거', 400, 650], ['불꽃 정령', 450, 700], ['서리 골렘', 420, 680]],
  [['고대 비룡', 700, 1100], ['몰락한 기사', 750, 1150]],
  [['심연의 용', 1200, 2000], ['타락한 대마법사', 1100, 1800]],
]
const DROPS = [
  ['mana', 12],
  ['bless', 6],
  ['guard', 2],
]
const TREASURE_PCT = 2 // 보물 상자: 골드 5배

/** 이 게임이 받는 명령어(앞글자 뺀 첫 낱말) */
export const COMMANDS = new Set([
  '강화', '검강화', '내검', '검', '검정보', '사냥', '판매', '상점', '구매', '인벤', '인벤토리',
  '거래', '거래취소', '수락', '거절', '강화랭킹', '검랭킹', '강화도움',
])

// ── 표 ────────────────────────────────────────────────────────────────────
export function tierOf(lv) {
  let t = 0
  for (let i = 0; i < TIERS.length; i++) if (lv >= TIERS[i].from) t = i
  return t
}

export function swordName(lv) {
  return TIERS[tierOf(lv)].name
}

/** "+7 은빛 기사검" */
export function swordLabel(lv) {
  return `+${lv} ${swordName(lv)}`
}

/** lv 에서 한 단계 올릴 때 확률(%) */
export function chance(lv) {
  const c = CHANCE[Math.max(0, Math.min(MAX_LV - 1, lv))]
  return { up: c[0], broke: c[1], fail: 100 - c[0] - c[1] }
}

/** lv 에서 한 단계 올릴 때 드는 것 */
export function cost(lv) {
  return { gold: COST[Math.max(0, Math.min(MAX_LV - 1, lv))], mana: lv >= 10 && lv < 15 ? 1 : 0, scale: lv >= 15 ? 1 : 0 }
}

export function price(lv) {
  return PRICE[Math.max(0, Math.min(MAX_LV, lv))]
}

export function won(n) {
  return String(Math.max(0, Math.floor(Number(n) || 0))).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

function g(n) {
  return won(n) + 'G'
}

function oneLine(s, n) {
  return String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n)
}

function itemByWord(w) {
  const k = String(w || '').replace(/\s+/g, '')
  if (!k) return ''
  if (SWORD_ALIAS.includes(k)) return 'sword'
  for (const id of ITEM_IDS) if (ITEMS[id].alias.includes(k)) return id
  return ''
}

// ── 상태 ──────────────────────────────────────────────────────────────────
function isObj(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}

/** runtime 안의 이 방 검 강화 상태(없으면 만든다). 저장본이 망가져 있으면 쓸 수 있는 칸만 남긴다. */
export function roomState(runtime, roomKey) {
  if (!isObj(runtime.sword)) runtime.sword = {}
  let s = runtime.sword[roomKey]
  if (!isObj(s)) s = runtime.sword[roomKey] = { v: 1, u: {}, t: [], q: 1 }
  if (!isObj(s.u)) s.u = {}
  if (!Array.isArray(s.t)) s.t = []
  if (!(Number(s.q) >= 1)) s.q = 1
  return s
}

function cleanUser(u) {
  u.g = Math.max(0, Math.min(MAX_GOLD, Math.floor(Number(u.g) || 0)))
  u.lv = Math.max(0, Math.min(MAX_LV, Math.floor(Number(u.lv) || 0)))
  u.b = Math.max(u.lv, Math.min(MAX_LV, Math.floor(Number(u.b) || 0)))
  if (!isObj(u.it)) u.it = {}
  for (const id of Object.keys(u.it)) if (!ITEMS[id]) delete u.it[id]
  for (const id of ITEM_IDS) {
    const n = Math.max(0, Math.min(MAX_ITEM, Math.floor(Number(u.it[id]) || 0)))
    if (n) u.it[id] = n
    else delete u.it[id]
  }
  return u
}

function has(o, k) {
  return Object.prototype.hasOwnProperty.call(o, k)
}

/** 사람 기록을 찾는다. make 면 없을 때 만든다(정원이 차면 가장 오래 안 한 사람부터 정리). */
export function userOf(s, key, name, now, make) {
  if (has(s.u, key) && isObj(s.u[key])) {
    const u = cleanUser(s.u[key])
    if (name) u.n = oneLine(name, 40)
    return u
  }
  if (!make) return null
  prune(s, now, 1)
  const u = { n: oneLine(name, 40), g: START_GOLD, lv: 0, id: s.q++, b: 0, it: {}, a: now, e: 0, h: 0, w: 0, k: 0, s: 0 }
  s.u[key] = u
  return u
}

/** 180일 넘게 안 한 사람을 지우고, room 칸이 모자라면 가장 오래 안 한 사람부터 지운다(거래 중인 사람은 남긴다). */
export function prune(s, now, room) {
  const busy = new Set()
  for (const t of s.t) {
    busy.add(t.f)
    busy.add(t.to)
  }
  for (const k of Object.keys(s.u)) {
    const u = s.u[k]
    if (!isObj(u)) delete s.u[k]
    else if (!busy.has(k) && now - (Number(u.a) || 0) > IDLE_MS) delete s.u[k]
  }
  const keys = Object.keys(s.u)
  let over = keys.length + (room || 0) - MAX_USERS
  if (over <= 0) return
  const old = keys.filter((k) => !busy.has(k)).sort((a, b) => (Number(s.u[a].a) || 0) - (Number(s.u[b].a) || 0))
  for (const k of old) {
    if (over <= 0) break
    delete s.u[k]
    over--
  }
}

function dropExpired(s, now) {
  s.t = s.t.filter((t) => isObj(t) && now - (Number(t.at) || 0) < TRADE_TTL_MS && has(s.u, t.f) && has(s.u, t.to))
}

// ── 명령어 ────────────────────────────────────────────────────────────────
/**
 * 명령어 하나를 처리한다. 상태를 바꾸고 답을 돌려준다. 이 게임 명령어가 아니거나(수락·거절인데 받은 제안이 없을 때 등)
 * 답할 것이 없으면 null.
 * req = { cmd, arg, key, name, mentions:[id], prefix, now, rand }
 * → { text, card? } (card 는 sword-art.mjs 가 그림으로 바꾼다. 그림을 못 보내면 text 가 대신 나간다)
 */
export function run(runtime, roomKey, req) {
  const cmd = String(req.cmd || '')
  if (!COMMANDS.has(cmd)) return null
  const s = roomState(runtime, roomKey)
  const now = Number(req.now) || 0
  const rand = typeof req.rand === 'function' ? req.rand : Math.random
  const p = req.prefix || '!'
  const key = String(req.key || '')
  if (!key) return null
  const ctx = { s, now, rand, p, key, name: oneLine(req.name, 40) || '참가자', arg: String(req.arg || '').trim(), mentions: Array.isArray(req.mentions) ? req.mentions.map(String) : [] }
  dropExpired(s, now)
  if (cmd === '수락' || cmd === '거절') return answerTrade(ctx, cmd === '수락')
  if (cmd === '강화도움') return { text: helpText(p) }
  if (cmd === '상점') return { text: shopText(p) }
  if (cmd === '강화랭킹' || cmd === '검랭킹') return ranking(ctx)
  const u = userOf(s, key, ctx.name, now, true)
  u.a = now
  ctx.u = u
  if (cmd === '강화' || cmd === '검강화') return enhance(ctx)
  if (cmd === '내검' || cmd === '검' || cmd === '검정보') return info(ctx)
  if (cmd === '사냥') return hunt(ctx)
  if (cmd === '판매') return sell(ctx)
  if (cmd === '구매') return buy(ctx)
  if (cmd === '인벤' || cmd === '인벤토리') return { text: invText(ctx) }
  if (cmd === '거래') return offer(ctx)
  if (cmd === '거래취소') return cancelTrade(ctx)
  return null
}

/**
 * 이 사람(key)이 받은, 아직 살아 있는 거래 제안 중 가장 최근 것의 시각(ms). 없으면 0. 상태를 바꾸지 않는다.
 * features 가 「수락」·「거절」을 검 강화와 몬스터 수집 중 어느 쪽에 넘길지 고를 때 쓴다.
 */
export function offerAt(runtime, roomKey, key, now) {
  const s = isObj(runtime && runtime.sword) ? runtime.sword[roomKey] : null
  if (!isObj(s) || !isObj(s.u) || !Array.isArray(s.t)) return 0
  let at = 0
  for (const t of s.t) {
    if (!isObj(t) || t.to !== String(key) || !has(s.u, t.f) || !has(s.u, t.to)) continue
    const a = Number(t.at) || 0
    if (now - a < TRADE_TTL_MS && a > at) at = a
  }
  return at
}

/** 「도움」 목록의 한 줄(roomfeat.helpLine · features 「게임」 · 패널 미리 보기가 같은 모양) */
export function helpLine(p) {
  return `검 강화 : ${p}강화 ${p}내검 ${p}사냥 ${p}강화도움`
}

export function helpText(p) {
  return [
    '[검 강화]',
    `${p}강화 : 골드로 검을 강화해요 (주문서 쓰기 : ${p}강화 보호 축복)`,
    `${p}내검 : 내 검과 골드를 봐요`,
    `${p}사냥 : 골드와 재료를 모아요 (2분에 한 번)`,
    `${p}판매 : 검을 팔아 골드로 바꿔요 (아이템 : ${p}판매 마력석 2)`,
    `${p}상점 · ${p}구매 보호 1 · ${p}인벤`,
    `${p}거래 @상대 보호 1 3000 : 아이템이나 검을 팔아요 (상대는 ${p}수락 · ${p}거절)`,
    `${p}강화랭킹`,
  ].join('\n')
}

export function shopText(p) {
  const rows = ITEM_IDS.map((id) => {
    const it = ITEMS[id]
    return it.buy ? `${it.name} ${g(it.buy)} : ${it.desc}` : `${it.name} : ${it.desc}`
  })
  return ['[상점]', ...rows, `구매 : ${p}구매 보호 1`].join('\n')
}

function cooldownLeft(ctx, last, cd) {
  const left = (Number(last) || 0) + cd - ctx.now
  if (left <= 0) return 0
  return left
}

function secText(ms) {
  const sec = Math.max(1, Math.ceil(ms / 1000))
  if (sec < 60) return `${sec}초`
  const m = Math.floor(sec / 60)
  const r = sec % 60
  return r ? `${m}분 ${r}초` : `${m}분`
}

// 쿨타임 중이면 한 번만 알리고(같은 행동 시각에 두 번 알리지 않는다) 그다음은 조용히 넘긴다
function cooling(ctx, last, cd, what) {
  const left = cooldownLeft(ctx, last, cd)
  if (!left) return null
  const u = ctx.u
  if (u.w === last) return { text: '' }
  u.w = last
  return { text: `${ctx.name}님, ${what}${josa(what, '은')} ${secText(left)} 뒤에 다시 할 수 있어요.` }
}

function nextLine(lv) {
  if (lv >= MAX_LV) return '최고 단계예요.'
  const c = cost(lv)
  const ch = chance(lv)
  const need = [g(c.gold)]
  if (c.mana) need.push(`${ITEMS.mana.name} 1개`)
  if (c.scale) need.push(`${ITEMS.scale.name} 1개`)
  return `다음 강화 : ${need.join(' + ')} · 성공 ${ch.up}%${ch.broke ? ` · 파괴 ${ch.broke}%` : ''}`
}

function enhance(ctx) {
  const { u, p } = ctx
  if (u.lv >= MAX_LV) return { text: `${ctx.name}님의 검은 이미 최고 단계 ${swordLabel(u.lv)}이에요. 「${p}판매」로 팔 수 있어요.` }
  const cd = cooling(ctx, u.e, ENHANCE_CD_MS, '강화')
  if (cd) return cd
  const words = ctx.arg.split(/\s+/).map((w) => itemByWord(w)).filter(Boolean)
  const useGuard = words.includes('guard')
  const useBless = words.includes('bless')
  const c = cost(u.lv)
  const ch = chance(u.lv)
  if (u.g < c.gold) {
    return { text: `골드가 부족해요. +${u.lv} 강화에는 ${g(c.gold)}가 필요해요. (보유 ${g(u.g)})\n「${p}사냥」으로 골드를 모아 보세요.` }
  }
  if (c.mana && (u.it.mana || 0) < c.mana) {
    return { text: `+10부터는 강화할 때 ${ITEMS.mana.name}이 1개 필요해요. 「${p}사냥」이나 「${p}상점」에서 구할 수 있어요.` }
  }
  if (c.scale && (u.it.scale || 0) < c.scale) {
    return { text: `+15부터는 강화할 때 ${ITEMS.scale.name}이 1개 필요해요. 「${p}사냥」에서 얻거나 다른 사람과 거래해 보세요.` }
  }
  if (useGuard && !ch.broke) return { text: `+${u.lv}에서는 검이 부서지지 않아요. 보호 주문서는 +5부터 써 주세요.` }
  if (useGuard && !(u.it.guard > 0)) return { text: `보호 주문서가 없어요. 「${p}구매 보호 1」로 살 수 있어요.` }
  if (useBless && !(u.it.bless > 0)) return { text: `축복 주문서가 없어요. 「${p}구매 축복 1」로 살 수 있어요.` }

  // 여기서부터 바꾼다(검사는 모두 끝났다)
  const from = u.lv
  u.g -= c.gold
  if (c.mana) take(u, 'mana', c.mana)
  if (c.scale) take(u, 'scale', c.scale)
  if (useGuard) take(u, 'guard', 1)
  if (useBless) take(u, 'bless', 1)
  u.e = ctx.now
  const up = Math.min(100, ch.up + (useBless ? BLESS_PCT : 0))
  const broke = Math.min(ch.broke, 100 - up)
  const roll = ctx.rand() * 100
  let result
  if (roll < up) {
    result = 'up'
    u.lv = from + 1
    if (u.lv > u.b) u.b = u.lv
  } else if (roll < up + broke) {
    if (useGuard) result = 'guarded'
    else {
      result = 'broke'
      u.lv = 0
      u.id = ctx.s.q++
      u.k = (Number(u.k) || 0) + 1
    }
  } else result = 'fail'
  const used = []
  if (useGuard) used.push(ITEMS.guard.name)
  if (useBless) used.push(ITEMS.bless.name)
  const spent = [g(c.gold)]
  if (c.mana) spent.push(ITEMS.mana.name)
  if (c.scale) spent.push(ITEMS.scale.name)
  let head
  let body
  if (result === 'up') {
    head = '[강화 성공]'
    body = `${ctx.name}님의 검이 ${swordLabel(u.lv)}${josa(swordName(u.lv), '이')} 됐어요.`
  } else if (result === 'fail') {
    head = '[강화 실패]'
    body = `${ctx.name}님의 검은 ${swordLabel(u.lv)} 그대로예요.`
  } else if (result === 'guarded') {
    head = '[강화 실패]'
    body = `부서질 뻔했지만 보호 주문서가 지켜 줬어요. ${swordLabel(u.lv)} 그대로예요.`
  } else {
    head = '[강화 파괴]'
    body = `${ctx.name}님의 ${swordLabel(from)}${josa(swordName(from), '이')} 부서졌어요. 새 ${swordLabel(0)}${josa(swordName(0), '을')} 받았어요.`
  }
  const text = [head, body, `사용 : ${spent.concat(used).join(' · ')} (보유 ${g(u.g)})`, nextLine(u.lv)].join('\n')
  return {
    text,
    card: { kind: 'enhance', result, from, lv: u.lv, best: u.b, owner: ctx.name, gold: u.g, spent: c.gold, used },
  }
}

function take(u, id, n) {
  const left = (u.it[id] || 0) - n
  if (left > 0) u.it[id] = left
  else delete u.it[id]
}

function give(u, id, n) {
  const next = Math.min(MAX_ITEM, (u.it[id] || 0) + n)
  if (next > 0) u.it[id] = next
}

function itemsLine(u) {
  const rows = ITEM_IDS.filter((id) => u.it[id] > 0).map((id) => `${ITEMS[id].name} ${u.it[id]}`)
  return rows.length ? rows.join(' · ') : '없음'
}

function info(ctx) {
  const { u } = ctx
  const text = [
    `[내 검] ${ctx.name}님`,
    `${swordLabel(u.lv)} · 최고 +${u.b}`,
    `골드 ${g(u.g)} · 판매가 ${g(price(u.lv))}`,
    `아이템 : ${itemsLine(u)}`,
    nextLine(u.lv),
  ].join('\n')
  const ch = chance(u.lv)
  return {
    text,
    card: {
      kind: 'info', lv: u.lv, best: u.b, owner: ctx.name, gold: u.g, price: price(u.lv), broken: u.k || 0,
      items: ITEM_IDS.map((id) => ({ name: ITEMS[id].name, n: u.it[id] || 0 })),
      next: u.lv >= MAX_LV ? null : { gold: cost(u.lv).gold, up: ch.up, broke: ch.broke, mana: cost(u.lv).mana, scale: cost(u.lv).scale },
    },
  }
}

function invText(ctx) {
  const { u } = ctx
  return [`[인벤] ${ctx.name}님`, `골드 ${g(u.g)} · 검 ${swordLabel(u.lv)}`, `아이템 : ${itemsLine(u)}`].join('\n')
}

function pick(rand, list) {
  return list[Math.min(list.length - 1, Math.floor(rand() * list.length))]
}

function hunt(ctx) {
  const { u, rand } = ctx
  const cd = cooling(ctx, u.h, HUNT_CD_MS, '사냥')
  if (cd) return cd
  u.h = ctx.now
  const band = HUNT[Math.min(HUNT.length - 1, Math.floor(u.lv / 3))]
  const [mob, lo, hi] = pick(rand, band)
  let gold = lo + Math.floor(rand() * (hi - lo + 1))
  const treasure = rand() * 100 < TREASURE_PCT
  if (treasure) gold *= 5
  u.g = Math.min(MAX_GOLD, u.g + gold)
  const got = []
  for (const [id, pct] of DROPS) {
    if (rand() * 100 < pct) {
      give(u, id, 1)
      got.push(ITEMS[id].name)
    }
  }
  const scalePct = u.lv >= 10 ? 4 : 1
  if (rand() * 100 < scalePct) {
    give(u, 'scale', 1)
    got.push(ITEMS.scale.name)
  }
  const lines = [`[사냥] ${ctx.name}님이 ${mob}${josa(mob, '을')} 잡았어요.`]
  if (treasure) lines.push('보물 상자를 찾았어요. 골드 5배!')
  lines.push(`+${g(gold)}${got.length ? ' · ' + got.map((n) => n + ' 1개').join(' · ') : ''} (보유 ${g(u.g)})`)
  return { text: lines.join('\n') }
}

// 수 낱말: "3개" → 수량, "3000골드"·"3000G"·"3000원" → 가격, "3000" → 그냥 수
function numTok(t) {
  const m = /^(\d{1,9})(개|골드|G|g|원)?$/.exec(String(t).replace(/,/g, ''))
  if (!m) return null
  const unit = !m[2] ? '' : m[2] === '개' ? 'q' : 'p'
  return { n: parseInt(m[1], 10), unit }
}

function sell(ctx) {
  const { u, p } = ctx
  const toks = ctx.arg.split(/\s+/).filter(Boolean)
  const nums = []
  const words = []
  for (const t of toks) {
    const n = numTok(t)
    if (n) nums.push(n.n)
    else words.push(t)
  }
  const what = words.filter((w) => w !== '확인').join('')
  const item = what ? itemByWord(what) : 'sword'
  if (!item) return { text: `「${p}판매」(검) 또는 「${p}판매 마력석 2」처럼 입력해 주세요.` }
  if (item === 'sword') {
    if (u.lv === 0) return { text: '+0 검은 팔 수 없어요. 「' + p + '강화」로 먼저 키워 보세요.' }
    const gold = price(u.lv)
    if (u.lv >= SELL_CONFIRM_LV && !words.includes('확인')) {
      return { text: `${swordLabel(u.lv)}${josa(swordName(u.lv), '을')} ${g(gold)}에 팔까요? 팔려면 「${p}판매 확인」을 입력해 주세요.` }
    }
    const lv = u.lv
    u.g = Math.min(MAX_GOLD, u.g + gold)
    u.lv = 0
    u.id = ctx.s.q++
    u.s = (Number(u.s) || 0) + 1
    return { text: `${swordLabel(lv)}${josa(swordName(lv), '을')} ${g(gold)}에 팔았어요. (보유 ${g(u.g)})\n새 ${swordLabel(0)}${josa(swordName(0), '을')} 받았어요.` }
  }
  const n = nums.length ? nums[0] : 1
  if (!(n >= 1 && n <= MAX_ITEM)) return { text: `수량은 1~${MAX_ITEM}개로 입력해 주세요.` }
  const it = ITEMS[item]
  if ((u.it[item] || 0) < n) return { text: `${it.name}${josa(it.name, '이')} 부족해요. (보유 ${u.it[item] || 0}개)` }
  const gold = it.sell * n
  take(u, item, n)
  u.g = Math.min(MAX_GOLD, u.g + gold)
  return { text: `${it.name} ${n}개를 ${g(gold)}에 팔았어요. (보유 ${g(u.g)})` }
}

function buy(ctx) {
  const { u, p } = ctx
  const toks = ctx.arg.split(/\s+/).filter(Boolean)
  const nums = []
  const words = []
  for (const t of toks) {
    const n = numTok(t)
    if (n) nums.push(n.n)
    else words.push(t)
  }
  const item = itemByWord(words.join(''))
  if (!item || item === 'sword') return { text: `「${p}구매 보호 1」처럼 입력해 주세요. 목록은 「${p}상점」에서 볼 수 있어요.` }
  const it = ITEMS[item]
  if (!it.buy) return { text: `${it.name}${josa(it.name, '은')} 상점에서 팔지 않아요. 사냥이나 거래로 구해 주세요.` }
  const n = nums.length ? nums[0] : 1
  if (!(n >= 1 && n <= 99)) return { text: '한 번에 1~99개까지 살 수 있어요.' }
  if ((u.it[item] || 0) + n > MAX_ITEM) return { text: `${it.name}${josa(it.name, '은')} ${MAX_ITEM}개까지 가질 수 있어요.` }
  const total = it.buy * n
  if (u.g < total) return { text: `골드가 부족해요. ${it.name} ${n}개는 ${g(total)}예요. (보유 ${g(u.g)})` }
  u.g -= total
  give(u, item, n)
  return { text: `${it.name} ${n}개를 ${g(total)}에 샀어요. (보유 ${g(u.g)} · ${it.name} ${u.it[item]}개)` }
}

// ── 거래 ──────────────────────────────────────────────────────────────────
// 「거래 @상대 아이템 [수량] [가격]」: 상대 이름에 띄어쓰기가 있어도 되게 뒤에서부터 읽는다.
// 끝의 수 2개 = 수량·가격, 1개 = 가격(수량 1), 없으면 무료. 「3개」·「3000골드」처럼 단위를 붙이면 그 뜻으로 읽는다.
export function parseOffer(arg) {
  const toks = String(arg || '').trim().split(/\s+/).filter(Boolean)
  if (!toks.length || !toks[0].startsWith('@')) return null
  const nums = []
  while (toks.length > 1 && nums.length < 2) {
    const n = numTok(toks[toks.length - 1])
    if (!n) break
    nums.unshift(n)
    toks.pop()
  }
  // 남은 낱말 끝에서 아이템 이름을 찾는다(「보호 주문서」처럼 두 낱말도)
  let item = ''
  let cut = -1
  for (let k = toks.length - 1; k >= 1 && k >= toks.length - 2; k--) {
    const id = itemByWord(toks.slice(k).join(''))
    if (id) {
      item = id
      cut = k
    }
  }
  if (!item) return null
  const target = toks.slice(0, cut).join(' ').replace(/^@/, '').trim()
  if (!target) return null
  let qty = 1
  let price = 0
  const q = nums.find((x) => x.unit === 'q')
  const pr = nums.find((x) => x.unit === 'p')
  const plain = nums.filter((x) => !x.unit)
  if (q) qty = q.n
  if (pr) price = pr.n
  if (!q && !pr) {
    if (plain.length === 2) {
      qty = plain[0].n
      price = plain[1].n
    } else if (plain.length === 1) price = plain[0].n
  } else if (plain.length) {
    if (!q) qty = plain[0].n
    else if (!pr) price = plain[0].n
  }
  return { target, item, qty, price }
}

function findTarget(ctx, name) {
  const s = ctx.s
  // 멘션이 있으면 그 사람(이름이 바뀌었어도 아이디로)
  for (const id of ctx.mentions) if (id !== ctx.key && has(s.u, id)) return id
  const want = oneLine(name, 40)
  const hits = Object.keys(s.u).filter((k) => k !== ctx.key && isObj(s.u[k]) && s.u[k].n === want)
  return hits.length === 1 ? hits[0] : ''
}

function tradeWhat(t) {
  return t.it === 'sword' ? swordLabel(t.lv) : `${ITEMS[t.it].name} ${t.q}개`
}

function offer(ctx) {
  const { s, u, p, key } = ctx
  const usage = `「${p}거래 @상대 보호 1 3000」처럼 입력해 주세요. (아이템 수량 가격 · 검은 「${p}거래 @상대 검 50000」)`
  const o = parseOffer(ctx.arg)
  if (!o) return { text: usage }
  const to = findTarget(ctx, o.target)
  if (!to) return { text: `「${oneLine(o.target, 40)}」님을 찾지 못했어요. 상대가 먼저 「${p}내검」을 한 번 입력해야 거래할 수 있어요.` }
  if (to === key) return { text: '자신과는 거래할 수 없어요.' }
  if (!(o.price >= 0 && o.price <= MAX_PRICE)) return { text: `가격은 0~${won(MAX_PRICE)}G로 입력해 주세요.` }
  const v = s.u[to]
  if (o.item === 'sword') {
    if (u.lv === 0) return { text: '+0 검은 거래할 수 없어요.' }
  } else {
    if (!(o.qty >= 1 && o.qty <= MAX_ITEM)) return { text: `수량은 1~${MAX_ITEM}개로 입력해 주세요.` }
    const it = ITEMS[o.item]
    if ((u.it[o.item] || 0) < o.qty) return { text: `${it.name}${josa(it.name, '이')} 부족해요. (보유 ${u.it[o.item] || 0}개)` }
  }
  const busyTo = s.t.find((t) => t.to === to && t.f !== key)
  if (busyTo) return { text: `${v.n || '상대'}님이 다른 거래 제안을 받고 있어요. 잠시 뒤 다시 해 주세요.` }
  const replaced = s.t.some((t) => t.f === key)
  s.t = s.t.filter((t) => t.f !== key)
  if (s.t.length >= MAX_TRADES) return { text: '지금은 거래 제안이 많아요. 잠시 뒤 다시 해 주세요.' }
  const t = { id: s.q++, f: key, to, it: o.item, q: o.item === 'sword' ? 1 : o.qty, p: o.price, lv: o.item === 'sword' ? u.lv : 0, sid: u.id, at: ctx.now }
  s.t.push(t)
  const lines = [`[거래 제안] ${ctx.name}님 → ${v.n || '상대'}님`, `${tradeWhat(t)} · ${t.p ? g(t.p) : '무료'}`]
  lines.push(`${v.n || '상대'}님, 2분 안에 「${p}수락」 또는 「${p}거절」을 입력해 주세요.`)
  if (replaced) lines.push('(먼저 보낸 제안은 취소했어요)')
  return { text: lines.join('\n') }
}

function cancelTrade(ctx) {
  const before = ctx.s.t.length
  ctx.s.t = ctx.s.t.filter((t) => t.f !== ctx.key)
  return { text: before !== ctx.s.t.length ? '보낸 거래 제안을 취소했어요.' : '보낸 거래 제안이 없어요.' }
}

function answerTrade(ctx, yes) {
  const { s, key } = ctx
  const t = s.t.find((x) => x.to === key)
  if (!t) return null
  const buyer = userOf(s, key, ctx.name, ctx.now, false)
  const seller = userOf(s, t.f, '', ctx.now, false)
  buyer.a = ctx.now
  const sName = seller.n || '상대'
  const drop = () => {
    s.t = s.t.filter((x) => x !== t)
  }
  if (!yes) {
    drop()
    return { text: `[거래 거절] ${ctx.name}님이 ${sName}님의 제안을 거절했어요.` }
  }
  // 둘 다 아직 그 물건·골드를 가지고 있는지 다시 본다(제안한 뒤 바뀌었을 수 있다)
  if (t.it === 'sword') {
    if (seller.id !== t.sid || seller.lv !== t.lv) {
      drop()
      return { text: `${sName}님의 검이 바뀌어서 거래를 취소했어요.` }
    }
    if (buyer.lv > 0) return { text: `${ctx.name}님은 이미 +${buyer.lv} 검을 가지고 있어요. 「${ctx.p}판매」로 먼저 판 뒤 「${ctx.p}수락」을 입력해 주세요.` }
  } else if ((seller.it[t.it] || 0) < t.q) {
    drop()
    return { text: `${sName}님의 ${ITEMS[t.it].name}${josa(ITEMS[t.it].name, '이')} 부족해서 거래를 취소했어요.` }
  } else if ((buyer.it[t.it] || 0) + t.q > MAX_ITEM) {
    drop()
    return { text: `${ITEMS[t.it].name}${josa(ITEMS[t.it].name, '은')} ${MAX_ITEM}개까지 가질 수 있어서 거래를 취소했어요.` }
  }
  if (buyer.g < t.p) return { text: `골드가 부족해요. ${g(t.p)}가 필요해요. (보유 ${g(buyer.g)})` }
  // 한 번에 옮긴다
  drop()
  buyer.g -= t.p
  seller.g = Math.min(MAX_GOLD, seller.g + t.p)
  if (t.it === 'sword') {
    buyer.lv = seller.lv
    buyer.id = seller.id
    if (buyer.lv > buyer.b) buyer.b = buyer.lv
    seller.lv = 0
    seller.id = s.q++
  } else {
    take(seller, t.it, t.q)
    give(buyer, t.it, t.q)
  }
  // 이 사람이 같은 물건으로 보낸 다른 제안이 있으면 지금 기준으로 다시 본다(검을 넘겼으면 그 검 제안은 무효)
  s.t = s.t.filter((x) => !(x.f === t.f && x.it === 'sword' && seller.id !== x.sid))
  return { text: `[거래 완료] ${ctx.name}님이 ${sName}님에게서 ${tradeWhat(t)}${t.p ? `${josa(tradeWhat(t), '을')} ${g(t.p)}에 샀어요.` : `${josa(tradeWhat(t), '을')} 받았어요.`}` }
}

// ── 랭킹 ──────────────────────────────────────────────────────────────────
export function rankRows(s, n) {
  return Object.keys(s.u)
    .map((k) => s.u[k])
    .filter((u) => isObj(u) && (Number(u.lv) > 0 || Number(u.b) > 0))
    .sort((a, b) => (b.lv - a.lv) || (b.b - a.b) || (b.g - a.g))
    .slice(0, n || 10)
    .map((u) => ({ name: u.n || '참가자', lv: Number(u.lv) || 0, best: Number(u.b) || 0 }))
}

function ranking(ctx) {
  const rows = rankRows(ctx.s, 10)
  if (!rows.length) return { text: `아직 강화 기록이 없어요. 「${ctx.p}강화」로 시작해 보세요.` }
  const text = '[강화 랭킹]\n' + rows.map((r, i) => `${i + 1}. ${r.name} ${swordLabel(r.lv)} (최고 +${r.best})`).join('\n')
  return { text, card: { kind: 'rank', rows } }
}
