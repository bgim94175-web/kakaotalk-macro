// 미니게임 「추억의 검 강화」 — 순수 모듈. 네트워크·DB·타이머를 쓰지 않고, 시각(now)과 난수(rand)는 늘 인자로 받는다.
// 상태는 방 runtime.sword[방 열쇠] = { v, u: {사람 열쇠: 사람}, t: [거래 제안], q: 다음 번호 } 하나뿐(점수처럼 room_state 에 저장).
// features.mjs 가 명령어를 넘기고(run), 답 글과 카드(card)를 받아 보낸다. 카드 그림은 sword-art.mjs.
//
// 사람 u = { n: 이름, g: 골드, lv: 검 단계, id: 검 번호, b: 최고 단계, it: {guard, bless, mana, scale}, a: 마지막 활동,
//            e: 마지막 강화, h: 마지막 사냥, w: 쿨타임 안내를 이미 한 행동 시각 {e, h, du, r}(행동마다), k: 부서진 횟수, s: 판매 횟수,
//            f: 연속 실패(실패 보정 — 검이 바뀌면 0), d: 마지막 출석 날(KST 날 번호), ds: 연속 출석 일수, du: 마지막 결투 신청,
//            dw·dl: 결투 승·패, r: 마지막 보스 공격 }
// 거래 t = { id, f: 판 사람, to: 받을 사람, it: 아이템 id 또는 'sword' 또는 'duel'(결투 신청, p = 내기 골드), q: 수량, p: 가격, lv, sid: 검 번호, at,
//          결투면 tl·tsid: 받는 사람 검 단계·번호(신청 때 보여 준 승률 그대로 겨루게) }
// 방 기록 top = { lv, n } (방에서 나온 가장 높은 검) · 보스 r = { i: 보스 번호, hp, mx, at: 나타난 시각, d: {사람 열쇠: 피해} } | null,
// rn: 다음 보스가 나타날 수 있는 시각, bk: 쓰러뜨린 보스 수, bl: 보스 난이도(다음 보스 차례 — 쓰러뜨리면 한 단계 위, 도망가면 한 단계 아래)
import { josa } from './roomfeat.mjs'
import { helpCard } from './helpcard.mjs'

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
export const PITY_STEP = 2 // 연속 실패 1번마다 다음 강화 성공 +2%
export const PITY_MAX = 10
export const RECORD_FROM = 10 // 이 단계부터 「방 최고 기록」을 알린다
export const COMFORT_FROM = 10 // 이 단계부터 부서지면 판매가의 10%를 위로금으로 준다
export const DAILY_BASE = 300 // 출석: 300G + 연속 일수(7일까지) × 100G, 7일마다 보호·축복 주문서
export const DAILY_STEP = 100
export const DAILY_WEEK = 7
export const DUEL_CD_MS = 30 * 1000
export const MAX_BET = 1000000
export const ATTACK_CD_MS = 60 * 1000
export const BOSS_GAP_MS = 30 * 60 * 1000 // 보스를 쓰러뜨리면 30분 뒤 다음 보스
export const BOSS_TTL_MS = 24 * 60 * 60 * 1000 // 하루 안에 못 쓰러뜨리면 도망간다
export const BOSS_REWARD = 0.6 // 체력 × 0.6 골드를 피해량대로 나눈다
// 방 보스(이름은 모두 이 게임에서 지은 것). 다섯을 다 쓰러뜨리면 처음부터, 한 바퀴마다 체력이 처음의 0.5배씩 는다(2바퀴째 1.5배, 3바퀴째 2배)
export const BOSSES = [
  { name: '거대 왕슬라임', hp: 4000 },
  { name: '고블린 족장', hp: 8000 },
  { name: '서리 거인', hp: 15000 },
  { name: '화염 드레이크', hp: 28000 },
  { name: '심연의 마왕', hp: 50000 },
]

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
  scale: { name: '용의 비늘', buy: 0, sell: 3000, desc: '+15부터 강화할 때 1개씩 써요 (사냥·보스에서)', alias: ['용의비늘', '비늘', '용비늘'] },
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
  '출석', '출첵', '결투', '보스', '공격',
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
  if (!isObj(s.top) || !(Number(s.top.lv) > 0)) delete s.top
  if (s.r != null && !(isObj(s.r) && BOSSES[s.r.i] && Number(s.r.mx) > 0 && Number(s.r.hp) > 0 && isObj(s.r.d))) s.r = null
  s.bk = Math.max(0, Math.floor(Number(s.bk) || 0))
  // 난이도가 없는 예전 저장본은 쓰러뜨린 수에서 시작한다(그때는 둘이 같았다)
  s.bl = s.bl == null || !Number.isFinite(Number(s.bl)) ? s.bk : Math.max(0, Math.floor(Number(s.bl)))
  s.rn = Math.max(0, Number(s.rn) || 0)
  return s
}

function cleanUser(u) {
  u.g = Math.max(0, Math.min(MAX_GOLD, Math.floor(Number(u.g) || 0)))
  u.lv = Math.max(0, Math.min(MAX_LV, Math.floor(Number(u.lv) || 0)))
  u.b = Math.max(u.lv, Math.min(MAX_LV, Math.floor(Number(u.b) || 0)))
  u.f = Math.max(0, Math.min(50, Math.floor(Number(u.f) || 0)))
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
  const u = { n: oneLine(name, 40), g: START_GOLD, lv: 0, id: s.q++, b: 0, it: {}, a: now, e: 0, h: 0, w: {}, k: 0, s: 0, f: 0 }
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
 * req = { cmd, arg, key, name, mentions:[id], mentionLen:{id: 글자 수}, prefix, now, rand }
 * (mentionLen = 카카오 멘션 첨부의 len — 글 안 「@닉네임」의 닉네임 글자 수. 결투에서 이름과 내기를 가른다)
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
  const ctx = { s, now, rand, p, key, name: oneLine(req.name, 40) || '참가자', arg: String(req.arg || '').trim(), mentions: Array.isArray(req.mentions) ? req.mentions.map(String) : [], mentionLen: isObj(req.mentionLen) ? req.mentionLen : {} }
  dropExpired(s, now)
  if (cmd === '수락' || cmd === '거절') return answerTrade(ctx, cmd === '수락')
  if (cmd === '강화도움') return { text: helpText(p) }
  if (cmd === '상점') return { text: shopText(p) }
  if (cmd === '강화랭킹' || cmd === '검랭킹') return ranking(ctx)
  if (cmd === '보스') return bossInfo(ctx)
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
  if (cmd === '출석' || cmd === '출첵') return attend(ctx)
  if (cmd === '결투') return duel(ctx)
  if (cmd === '공격') return attack(ctx)
  return null
}

/**
 * 이 사람(key)이 받은, 아직 살아 있는 거래 제안 중 가장 최근 것의 시각(ms). 없으면 0. 상태를 바꾸지 않는다.
 * features 가 「수락」·「거절」을 검 강화에 넘길지 고를 때 쓴다.
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
export const HELP_CMDS = ['강화', '내검', '사냥', '출석', '결투', '보스', '강화랭킹', '강화도움']

export function helpLine(p) {
  return '검 강화 : ' + HELP_CMDS.map((c) => p + c).join(' ')
}

/** 「!도움」·「!게임」 목록의 검 강화 묶음 */
export function helpCommands(p) {
  return HELP_CMDS.map((c) => p + c)
}

export function helpText(p) {
  return helpCard('검 강화 도움말', [{ lines: [
    `${p}강화 : 골드로 검을 강화해요 (주문서 쓰기 : ${p}강화 보호 축복)`,
    `${p}내검 : 내 검과 골드를 봐요`,
    `${p}사냥 : 골드와 재료를 모아요 (2분에 한 번)`,
    `${p}출석 : 하루 한 번 골드를 받아요 (7일 연속이면 주문서도)`,
    `${p}결투 @상대 [골드] : 검끼리 겨뤄요 (높은 검이 유리, 골드를 걸 수 있어요)`,
    `${p}보스 · ${p}공격 : 방 사람들과 함께 보스를 쓰러뜨리고 골드를 나눠요`,
    `${p}판매 : 검을 팔아 골드로 바꿔요 (아이템 : ${p}판매 마력석 2)`,
    `${p}상점 · ${p}구매 보호 1 · ${p}인벤`,
    `${p}거래 @상대 보호 1 3000 : 아이템이나 검을 팔아요 (상대는 ${p}수락 · ${p}거절)`,
    `${p}거래취소 : 보낸 거래 제안·결투 신청을 취소해요`,
    `${p}강화랭킹 : 방 강화 순위를 봐요`,
  ] }], `강화에 실패하면 다음 강화 성공 확률이 ${PITY_STEP}%씩 올라요. (최대 +${PITY_MAX}%)`)
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

// 쿨타임 중이면 한 번만 알리고(같은 행동 시각에 두 번 알리지 않는다) 그다음은 조용히 넘긴다.
// k = 그 행동 시각 칸(e·h·du·r). 알린 시각은 행동마다 따로 적어서, 강화·사냥을 번갈아 해도 다시 알리지 않는다
function cooling(ctx, k, cd, what) {
  const u = ctx.u
  const last = u[k]
  const left = cooldownLeft(ctx, last, cd)
  if (!left) return null
  if (!isObj(u.w)) u.w = {} // 예전 저장본은 수 하나
  if (u.w[k] === last) return { text: '' }
  u.w[k] = last
  return { text: `${ctx.name}님, ${what}${josa(what, '은')} ${secText(left)} 뒤에 다시 할 수 있어요.` }
}

/** 연속 실패 n번 → 다음 강화 성공 보너스(%) */
export function pityOf(n) {
  return Math.min(PITY_MAX, Math.max(0, Math.floor(Number(n) || 0)) * PITY_STEP)
}

function nextLine(lv, pity) {
  if (lv >= MAX_LV) return '최고 단계예요.'
  const c = cost(lv)
  const ch = chance(lv)
  const need = [g(c.gold)]
  if (c.mana) need.push(`${ITEMS.mana.name} 1개`)
  if (c.scale) need.push(`${ITEMS.scale.name} 1개`)
  const up = Math.min(100, ch.up + (pity || 0))
  return `다음 강화 : ${need.join(' + ')} · 성공 ${up}%${pity ? `(보정 +${pity}%)` : ''}${ch.broke ? ` · 파괴 ${Math.min(ch.broke, 100 - up)}%` : ''}`
}

// 「강화」 뒤 낱말 → 쓸 주문서. 「보호 주문서」·「파괴 방지」처럼 띄어 써도, 「보호1」·「보호 1개」처럼 수를 붙여도 읽는다.
// 모르는 낱말이 하나라도 있으면 { bad: 그 낱말 }(잘못 쓴 주문서 이름 때문에 주문서 없이 강화되지 않게 아무것도 하지 않고 다시 묻는다).
// 검·마력석·비늘은 강화 때 저절로 쓰는 것이라 적어도 그냥 넘어간다.
function enhanceArgs(arg) {
  const raw = String(arg || '').split(/\s+/).filter((t) => t && !numTok(t))
  const toks = raw.map((t) => t.replace(/\d+개?$/, '') || t)
  const ids = []
  for (let i = 0; i < toks.length; i++) {
    const two = i + 1 < toks.length ? itemByWord(toks[i] + toks[i + 1]) : ''
    if (two) {
      ids.push(two)
      i++
      continue
    }
    const one = itemByWord(toks[i])
    if (!one) return { bad: raw[i] }
    ids.push(one)
  }
  return { guard: ids.includes('guard'), bless: ids.includes('bless') }
}

// 모르는 낱말로 강화하지 않았을 때. 짧은 낱말(글자·숫자 10자까지)만 다시 보인다 — 링크나 긴 글을 봇이 따라 올리지 않게
function badEnhanceText(bad, p) {
  const w = String(bad || '')
  const head = /^[0-9A-Za-z가-힣ㄱ-ㅎㅏ-ㅣ]{1,10}$/.test(w) ? `「${w}」${josa(w, '은')}` : `「${p}강화」 뒤의 낱말을`
  return `${head} 알 수 없어서 강화하지 않았어요. 「${p}강화」, 「${p}강화 보호」, 「${p}강화 축복」처럼 입력해 주세요.`
}

function enhance(ctx) {
  const { u, p } = ctx
  if (u.lv >= MAX_LV) return { text: `${ctx.name}님의 검은 이미 최고 단계 ${swordLabel(u.lv)}이에요. 「${p}판매」로 팔 수 있어요.` }
  const want = enhanceArgs(ctx.arg)
  if (want.bad != null) return { text: badEnhanceText(want.bad, p) }
  const cd = cooling(ctx, 'e', ENHANCE_CD_MS, '강화')
  if (cd) return cd
  const c = cost(u.lv)
  const ch = chance(u.lv)
  const useGuard = want.guard
  // 축복 없이도 성공 100%면 축복 주문서는 쓰지 않는다(강화는 그대로 한다)
  const useBless = want.bless && ch.up + pityOf(u.f) < 100
  const keepBless = want.bless && !useBless
  if (u.g < c.gold) {
    return { text: `골드가 부족해요. +${u.lv} 강화에는 ${g(c.gold)}가 필요해요. (보유 ${g(u.g)})\n「${p}사냥」으로 골드를 모아 보세요.` }
  }
  if (c.mana && (u.it.mana || 0) < c.mana) {
    return { text: `+10부터는 강화할 때 ${ITEMS.mana.name}이 1개 필요해요. 「${p}사냥」이나 「${p}상점」에서 구할 수 있어요.` }
  }
  if (c.scale && (u.it.scale || 0) < c.scale) {
    return { text: `+15부터는 강화할 때 ${ITEMS.scale.name}이 1개 필요해요. 「${p}사냥」·「${p}보스」에서 얻거나 다른 사람과 거래해 보세요.` }
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
  const pity = pityOf(u.f)
  const up = Math.min(100, ch.up + (useBless ? BLESS_PCT : 0) + pity)
  const broke = Math.min(ch.broke, 100 - up)
  const roll = ctx.rand() * 100
  let result
  let record = false
  let comfort = 0
  if (roll < up) {
    result = 'up'
    u.lv = from + 1
    if (u.lv > u.b) u.b = u.lv
    u.f = 0
    const top = ctx.s.top
    if (u.lv >= RECORD_FROM && u.lv > (top ? Number(top.lv) || 0 : 0)) {
      ctx.s.top = { lv: u.lv, n: ctx.name }
      record = true
    }
  } else if (roll < up + broke) {
    if (useGuard) {
      result = 'guarded'
      u.f = Math.min(50, u.f + 1)
    } else {
      result = 'broke'
      u.lv = 0
      u.id = ctx.s.q++
      u.k = (Number(u.k) || 0) + 1
      u.f = 0
      if (from >= COMFORT_FROM) {
        comfort = Math.floor(price(from) / 10)
        u.g = Math.min(MAX_GOLD, u.g + comfort)
      }
    }
  } else {
    result = 'fail'
    u.f = Math.min(50, u.f + 1)
  }
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
  const lines = [head, body]
  if (record) lines.push(`[방 최고 기록] 이 방에서 처음 나온 ${swordLabel(u.lv)}${josa(swordName(u.lv), '이에요')}.`)
  if (comfort) lines.push(`위로금 ${g(comfort)} 받았어요.`)
  if (pity) lines.push(`실패 보정 +${pity}%가 적용됐어요.`)
  if (keepBless) lines.push(`이미 성공 확률이 100%라서 ${ITEMS.bless.name}${josa(ITEMS.bless.name, '은')} 쓰지 않았어요.`)
  lines.push(`사용 : ${spent.concat(used).join(' · ')} (보유 ${g(u.g)})`, nextLine(u.lv, pityOf(u.f)))
  const notes = []
  if (record) notes.push('방 최고 기록')
  if (comfort) notes.push(`위로금 ${g(comfort)}`)
  if (keepBless) notes.push(`${ITEMS.bless.name} 안 씀`)
  return {
    text: lines.join('\n'),
    card: { kind: 'enhance', result, from, lv: u.lv, best: u.b, owner: ctx.name, gold: u.g, spent: c.gold, used, pity: pityOf(u.f), notes },
  }
}

function take(u, id, n) {
  const left = (u.it[id] || 0) - n
  if (left > 0) u.it[id] = left
  else delete u.it[id]
}

/** 아이템을 준다. 종류마다 999개까지라 실제로 받은 수를 돌려준다 */
function give(u, id, n) {
  const before = u.it[id] || 0
  const next = Math.min(MAX_ITEM, before + n)
  if (next > 0) u.it[id] = next
  return next - before
}

/** 보상 아이템 [[id, 수]…]을 준다 → got: 받은 것 「이름 N개」, full: 999개가 차서 덜 받은 아이템 이름 */
function reward(u, list) {
  const got = []
  const full = []
  for (const [id, n] of list) {
    const k = give(u, id, n)
    if (k > 0) got.push(`${ITEMS[id].name} ${k}개`)
    if (k < n) full.push(ITEMS[id].name)
  }
  return { got, full }
}

/** 999개가 차서 못 받은 보상 안내(받지도 않은 것을 받았다고 하지 않는다) */
function fullLine(full, who) {
  const last = full[full.length - 1]
  return `${full.join('·')}${josa(last, '은')} ${MAX_ITEM}개까지 가질 수 있어서 ${who ? `${who}님은 ` : ''}더 받지 못했어요.`
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
    nextLine(u.lv, pityOf(u.f)),
  ].join('\n')
  const ch = chance(u.lv)
  return {
    text,
    card: {
      kind: 'info', lv: u.lv, best: u.b, owner: ctx.name, gold: u.g, price: price(u.lv), broken: u.k || 0,
      items: ITEM_IDS.map((id) => ({ name: ITEMS[id].name, n: u.it[id] || 0 })),
      next: u.lv >= MAX_LV ? null : { gold: cost(u.lv).gold, up: Math.min(100, ch.up + pityOf(u.f)), broke: Math.min(ch.broke, 100 - Math.min(100, ch.up + pityOf(u.f))), pity: pityOf(u.f), mana: cost(u.lv).mana, scale: cost(u.lv).scale },
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
  const cd = cooling(ctx, 'h', HUNT_CD_MS, '사냥')
  if (cd) return cd
  u.h = ctx.now
  const band = HUNT[Math.min(HUNT.length - 1, Math.floor(u.lv / 3))]
  const [mob, lo, hi] = pick(rand, band)
  let gold = lo + Math.floor(rand() * (hi - lo + 1))
  const treasure = rand() * 100 < TREASURE_PCT
  if (treasure) gold *= 5
  u.g = Math.min(MAX_GOLD, u.g + gold)
  const drops = []
  for (const [id, pct] of DROPS) {
    if (rand() * 100 < pct) drops.push([id, 1])
  }
  const scalePct = u.lv >= 10 ? 4 : 1
  if (rand() * 100 < scalePct) drops.push(['scale', 1])
  const { got, full } = reward(u, drops)
  const lines = [`[사냥] ${ctx.name}님이 ${mob}${josa(mob, '을')} 잡았어요.`]
  if (treasure) lines.push('보물 상자를 찾았어요. 골드를 5배로 받았어요.')
  lines.push(`+${g(gold)}${got.length ? ' · ' + got.join(' · ') : ''} (보유 ${g(u.g)})`)
  if (full.length) lines.push(fullLine(full))
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
    u.f = 0 // 실패 보정은 그 검에 쌓인 것 — 검이 바뀌면 처음부터
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
  if (!it.buy) return { text: `${it.name}${josa(it.name, '은')} 상점에서 팔지 않아요. 사냥·보스나 거래로 구해 주세요.` }
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
  if (t.it === 'duel') return '결투'
  return t.it === 'sword' ? swordLabel(t.lv) : `${ITEMS[t.it].name} ${t.q}개`
}

// 보낸 것의 이름: 결투는 「결투 신청」, 나머지는 「거래 제안」
function sentWhat(t) {
  return t.it === 'duel' ? '결투 신청' : '거래 제안'
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
  if (busyTo) return { text: `${v.n || '상대'}님이 다른 ${sentWhat(busyTo)}을 받고 있어요. 잠시 뒤 다시 해 주세요.` }
  const replaced = s.t.find((t) => t.f === key)
  s.t = s.t.filter((t) => t.f !== key)
  if (s.t.length >= MAX_TRADES) return { text: '지금은 거래 제안이 많아요. 잠시 뒤 다시 해 주세요.' }
  const t = { id: s.q++, f: key, to, it: o.item, q: o.item === 'sword' ? 1 : o.qty, p: o.price, lv: o.item === 'sword' ? u.lv : 0, sid: u.id, at: ctx.now }
  s.t.push(t)
  const lines = [`[거래 제안] ${ctx.name}님 → ${v.n || '상대'}님`, `${tradeWhat(t)} · ${t.p ? g(t.p) : '무료'}`]
  lines.push(`${v.n || '상대'}님, 2분 안에 「${p}수락」 또는 「${p}거절」을 입력해 주세요.`)
  if (replaced) lines.push(`(먼저 보낸 ${sentWhat(replaced)}은 취소했어요)`)
  return { text: lines.join('\n') }
}

function cancelTrade(ctx) {
  const mine = ctx.s.t.find((t) => t.f === ctx.key)
  if (!mine) return { text: '보낸 거래 제안이나 결투 신청이 없어요.' }
  ctx.s.t = ctx.s.t.filter((t) => t.f !== ctx.key)
  return { text: `보낸 ${sentWhat(mine)}을 취소했어요.` }
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
    if (t.it === 'duel') return { text: `[결투 거절] ${ctx.name}님이 ${sName}님의 결투를 거절했어요.` }
    return { text: `[거래 거절] ${ctx.name}님이 ${sName}님의 제안을 거절했어요.` }
  }
  if (t.it === 'duel') return fight(ctx, t, seller, buyer, drop)
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
    // 실패 보정은 검을 따라가지도, 사람에게 남지도 않는다(둘 다 검이 바뀌었다)
    buyer.f = 0
    seller.f = 0
    // 사냥·보스 공격 쿨타임은 검을 따라간다(무료로 검을 돌려 가며 여럿이 높은 단계 사냥을 하지 못하게)
    buyer.h = Math.max(Number(buyer.h) || 0, Number(seller.h) || 0)
    buyer.r = Math.max(Number(buyer.r) || 0, Number(seller.r) || 0)
  } else {
    take(seller, t.it, t.q)
    give(buyer, t.it, t.q)
  }
  // 이 사람이 같은 물건으로 보낸 다른 제안이 있으면 지금 기준으로 다시 본다(검을 넘겼으면 그 검 제안은 무효)
  s.t = s.t.filter((x) => !(x.f === t.f && x.it === 'sword' && seller.id !== x.sid))
  return { text: `[거래 완료] ${ctx.name}님이 ${sName}님에게서 ${tradeWhat(t)}${t.p ? `${josa(tradeWhat(t), '을')} ${g(t.p)}에 샀어요.` : `${josa(tradeWhat(t), '을')} 받았어요.`}` }
}

// ── 출석 ──────────────────────────────────────────────────────────────────
/** KST 날 번호(하루에 1씩) */
export function dayNo(now) {
  return Math.floor((Number(now) + 9 * 3600 * 1000) / 86400000)
}

function attend(ctx) {
  const { u } = ctx
  const day = dayNo(ctx.now)
  if (Number(u.d) === day) return { text: `${ctx.name}님은 오늘 이미 출석했어요. (${Math.max(1, Number(u.ds) || 1)}일 연속) 내일 또 와 주세요.` }
  u.ds = Number(u.d) === day - 1 ? Math.min(9999, (Number(u.ds) || 0) + 1) : 1
  u.d = day
  const gold = DAILY_BASE + DAILY_STEP * Math.min(DAILY_WEEK, u.ds)
  u.g = Math.min(MAX_GOLD, u.g + gold)
  const week = u.ds % DAILY_WEEK === 0
  const bonus = week ? reward(u, [['guard', 1], ['bless', 1]]) : { got: [], full: [] }
  const lines = [u.ds > 1 ? `[출석] ${ctx.name}님 ${u.ds}일 연속 출석했어요.` : `[출석] ${ctx.name}님 출석했어요.`]
  lines.push(`+${g(gold)}${bonus.got.length ? ' · ' + bonus.got.join(' · ') : ''} (보유 ${g(u.g)})`)
  if (bonus.full.length) lines.push(fullLine(bonus.full))
  if (week && bonus.got.length) lines.push(`${DAILY_WEEK}일 연속 보너스를 받았어요.`)
  else if (!week) lines.push(`${DAILY_WEEK - (u.ds % DAILY_WEEK)}일 더 연속으로 오면 ${ITEMS.guard.name}·${ITEMS.bless.name}${josa(ITEMS.bless.name, '을')} 받아요.`)
  return { text: lines.join('\n') }
}

// ── 결투 ──────────────────────────────────────────────────────────────────
/** 도전한 사람(검 a단계)이 상대(b단계)를 이길 확률(%) */
export function duelChance(a, b) {
  return Math.max(10, Math.min(90, 50 + (a - b) * 4))
}

// 「결투 @상대 [골드]」 → { name, bet }. 「민수 92」처럼 이름 끝의 수를 내기로 읽지 않는다.
// 멘션 글자 수(mentionLen)를 알면 「@」 뒤 그만큼이 상대 이름이고 그 뒤만 내기로 읽는다 — 저장된 이름이 옛것이어도(이름을 바꾼 뒤
// 아직 검 강화를 안 한 사람) 맞다. 모르면 멘션된 사람(멘션이 없으면 이 방 사람)의 이름이 글 앞과 그대로 맞을 때 그 이름을 떼고
// 남은 것만 내기로 읽는다(긴 이름부터). 맞는 이름도 없으면 예전처럼 끝의 수 하나를 내기로 본다.
function duelArg(ctx) {
  const s = ctx.s
  const mid = ctx.mentions.find((id) => id !== ctx.key && has(s.u, id) && isObj(s.u[id]))
  const len = mid ? Number(ctx.mentionLen[mid]) : 0
  const raw = ctx.arg
  if (Number.isInteger(len) && len > 0 && raw.charAt(0) === '@' && raw.length > len && /^(\s|$)/.test(raw.slice(1 + len))) {
    const tail = raw.slice(1 + len).trim()
    const n = tail ? numTok(tail) : null
    return { name: oneLine(raw.slice(1, 1 + len), 40), bet: n && n.unit !== 'q' ? n.n : 0 }
  }
  const rest = oneLine(raw, 200).replace(/^@/, '').trim()
  const names = (mid ? [s.u[mid].n] : Object.keys(s.u).filter((k) => k !== ctx.key && isObj(s.u[k])).map((k) => s.u[k].n))
    .filter((n) => typeof n === 'string' && n)
    .sort((a, b) => b.length - a.length)
  for (const nm of names) {
    if (rest === nm) return { name: nm, bet: 0 }
    if (rest.startsWith(nm + ' ')) {
      const n = numTok(rest.slice(nm.length + 1))
      if (n && n.unit !== 'q') return { name: nm, bet: n.n }
    }
  }
  const toks = rest.split(' ').filter(Boolean)
  let bet = 0
  if (toks.length > 1) {
    const n = numTok(toks[toks.length - 1])
    if (n && n.unit !== 'q') {
      bet = n.n
      toks.pop()
    }
  }
  return { name: toks.join(' '), bet }
}

function duel(ctx) {
  const { s, u, p, key } = ctx
  const usage = `「${p}결투 @상대」 또는 골드를 걸어 「${p}결투 @상대 3000」처럼 입력해 주세요.`
  const { name, bet } = duelArg(ctx)
  if (!name && !ctx.mentions.length) return { text: usage }
  const to = findTarget(ctx, name)
  if (!to) return { text: `「${oneLine(name, 40)}」님을 찾지 못했어요. 상대가 먼저 「${p}내검」을 한 번 입력해야 결투할 수 있어요.` }
  if (!(bet >= 0 && bet <= MAX_BET)) return { text: `내기 골드는 0~${won(MAX_BET)}G로 입력해 주세요.` }
  if (u.g < bet) return { text: `골드가 부족해요. (보유 ${g(u.g)})` }
  const v = s.u[to]
  if (v.g < bet) return { text: `${v.n || '상대'}님의 골드가 ${g(bet)}보다 적어요. 내기를 줄여 주세요.` }
  const cd = cooling(ctx, 'du', DUEL_CD_MS, '결투 신청')
  if (cd) return cd
  const busyTo = s.t.find((t) => t.to === to && t.f !== key)
  if (busyTo) return { text: `${v.n || '상대'}님이 다른 ${sentWhat(busyTo)}을 받고 있어요. 잠시 뒤 다시 해 주세요.` }
  const replaced = s.t.find((t) => t.f === key)
  s.t = s.t.filter((t) => t.f !== key)
  if (s.t.length >= MAX_TRADES) return { text: '지금은 신청이 많아요. 잠시 뒤 다시 해 주세요.' }
  u.du = ctx.now
  s.t.push({ id: s.q++, f: key, to, it: 'duel', q: 1, p: bet, lv: u.lv, sid: u.id, tl: v.lv, tsid: v.id, at: ctx.now })
  const lines = [
    `[결투 신청] ${ctx.name}(+${u.lv}) → ${v.n || '상대'}(+${v.lv})`,
    `${bet ? `내기 ${g(bet)}` : '내기 없음'} · ${ctx.name}님 승률 ${duelChance(u.lv, v.lv)}%`,
    `${v.n || '상대'}님, 2분 안에 「${p}수락」 또는 「${p}거절」을 입력해 주세요.`,
  ]
  if (replaced) lines.push(`(먼저 보낸 ${sentWhat(replaced)}은 취소했어요)`)
  return { text: lines.join('\n') }
}

const DUEL_WIN = ['꺾었어요', '튕겨 냈어요', '압도했어요', '한 번에 베어 냈어요']

// 결투 수락: a = 신청한 사람, b = 받은 사람(지금 「수락」한 사람)
function fight(ctx, t, a, b, drop) {
  const bet = t.p
  const aName = a.n || '상대'
  const bName = ctx.name
  // 신청 때 보여 준 승률 그대로 겨룬다: 그 뒤 둘 중 누구의 검이든 바뀌었으면(강화·판매·거래) 취소.
  // 받는 사람 검(tl·tsid)이 없는 예전 신청은 신청한 사람 검만 본다
  if (t.sid != null && (a.id !== t.sid || a.lv !== t.lv)) {
    drop()
    return { text: `${aName}님의 검이 바뀌어서 결투를 취소했어요.` }
  }
  if (t.tsid != null && (b.id !== t.tsid || b.lv !== t.tl)) {
    drop()
    return { text: `${bName}님의 검이 바뀌어서 결투를 취소했어요.` }
  }
  if (a.g < bet) {
    drop()
    return { text: `${aName}님의 골드가 부족해서 결투를 취소했어요.` }
  }
  if (b.g < bet) return { text: `골드가 부족해요. 결투에 ${g(bet)}가 필요해요. (보유 ${g(b.g)})` }
  drop()
  const pa = duelChance(a.lv, b.lv)
  const aWin = ctx.rand() * 100 < pa
  const W = aWin ? a : b
  const L = aWin ? b : a
  const wName = aWin ? aName : bName
  W.g = Math.min(MAX_GOLD, W.g + bet)
  L.g = Math.max(0, L.g - bet)
  W.dw = (Number(W.dw) || 0) + 1
  L.dl = (Number(L.dl) || 0) + 1
  const upset = (aWin ? pa : 100 - pa) < 35
  const ws = swordName(W.lv)
  const ls = swordName(L.lv)
  const how = pick(ctx.rand, DUEL_WIN)
  const lines = [`[결투] ${aName}(+${a.lv}) vs ${bName}(+${b.lv})`]
  lines.push(`${upset ? '대역전이에요. ' : ''}${wName}님의 ${ws}${josa(ws, '이')} ${ls}${josa(ls, '을')} ${how}.`)
  lines.push(`승리 : ${wName}님${bet ? ` +${g(bet)}` : ''}`)
  lines.push(`전적 : ${aName} ${a.dw || 0}승 ${a.dl || 0}패 · ${bName} ${b.dw || 0}승 ${b.dl || 0}패`)
  return { text: lines.join('\n') }
}

// ── 방 보스 ────────────────────────────────────────────────────────────────
// bl = 난이도(s.bl). 보스는 bl 을 다섯으로 나눈 나머지, 체력은 바퀴(bl ÷ 5)마다 처음의 0.5배씩 는다
function bossHp(bl) {
  const b = BOSSES[bl % BOSSES.length]
  return Math.round(b.hp * (1 + 0.5 * Math.floor(bl / BOSSES.length)))
}

// 도망간 뒤의 난이도: 한 단계 쉬운 보스(같은 바퀴의 앞 보스, 바퀴 첫 보스면 한 바퀴 앞의 같은 보스 — 체력이 늘 줄어든다).
// 하루에 넣는 피해가 보스 체력보다 적은 방도 다음 보스는 쓰러뜨릴 수 있게
function easier(bl) {
  return bl % BOSSES.length ? bl - 1 : Math.max(0, bl - BOSSES.length)
}

/** 검 단계로 정하는 한 번의 피해(크게 오른다) */
export function hitBase(lv) {
  return 60 + lv * 40 + lv * lv * 8
}

function hpBar(hp, mx) {
  const n = Math.max(0, Math.min(10, Math.ceil((hp / mx) * 10)))
  return '■'.repeat(n) + '□'.repeat(10 - n)
}

function minLeft(ms) {
  return Math.max(1, Math.ceil(ms / 60000))
}

// 보스 상태를 맞춘다: 도망갔으면 지우고, 나올 때가 됐으면 새로 부른다. → { boss, fled, spawned }
function bossTick(s, now, spawn) {
  let fled = null
  if (s.r && now - (Number(s.r.at) || 0) >= BOSS_TTL_MS) {
    fled = BOSSES[s.r.i].name
    // 다음 보스는 도망간 때(나타난 지 하루)부터 30분 뒤 — 한참 뒤에 누가 보더라도 그때부터 또 기다리지 않는다
    s.rn = (Number(s.r.at) || 0) + BOSS_TTL_MS + BOSS_GAP_MS
    s.r = null
    s.bl = easier(s.bl)
  }
  let spawned = false
  if (!s.r && spawn && now >= s.rn) {
    const mx = bossHp(s.bl)
    s.r = { i: s.bl % BOSSES.length, hp: mx, mx, at: now, d: {} }
    spawned = true
  }
  return { boss: s.r, fled, spawned }
}

function bossAppear(r, p) {
  const nm = BOSSES[r.i].name
  return [`[보스 등장] ${nm}${josa(nm, '이')} 나타났어요.`, `체력 ${won(r.mx)}`, `「${p}공격」으로 함께 쓰러뜨리면 피해량만큼 골드를 나눠 받아요.`]
}

function bossInfo(ctx) {
  const { s, p } = ctx
  const t = bossTick(s, ctx.now, true)
  const lines = []
  if (t.fled) lines.push(`${t.fled}${josa(t.fled, '이')} 도망갔어요.`)
  if (!t.boss) {
    lines.push(`다음 보스는 ${minLeft(s.rn - ctx.now)}분 뒤에 나타나요.`)
    return { text: lines.join('\n') }
  }
  if (t.spawned) return { text: lines.concat(bossAppear(t.boss, p)).join('\n') }
  const r = t.boss
  const nm = BOSSES[r.i].name
  const ppl = Object.keys(r.d).length
  lines.push(`[보스] ${nm}`, `체력 ${won(r.hp)} (최대 ${won(r.mx)})`, hpBar(r.hp, r.mx))
  lines.push(`${ppl ? `참여 ${ppl}명 · ` : ''}「${p}공격」으로 함께 쓰러뜨려요.`)
  return { text: lines.join('\n') }
}

function attack(ctx) {
  const { s, u, p, key, rand } = ctx
  const t = bossTick(s, ctx.now, true)
  const head = []
  if (t.fled) head.push(`${t.fled}${josa(t.fled, '이')} 도망갔어요.`)
  if (!t.boss) return { text: head.concat(`다음 보스는 ${minLeft(s.rn - ctx.now)}분 뒤에 나타나요.`).join('\n') }
  if (t.spawned) head.push(...bossAppear(t.boss, p))
  const cd = cooling(ctx, 'r', ATTACK_CD_MS, '공격')
  if (cd) return head.length ? { text: head.join('\n') } : cd
  u.r = ctx.now
  const r = t.boss
  const nm = BOSSES[r.i].name
  const crit = rand() < 0.1
  let dmg = Math.round(hitBase(u.lv) * (0.8 + rand() * 0.4) * (crit ? 2 : 1))
  dmg = Math.max(1, Math.min(dmg, r.hp))
  r.hp -= dmg
  r.d[key] = (Number(r.d[key]) || 0) + dmg
  const lines = head.concat(`[공격] ${ctx.name}님이 ${nm}에게 ${crit ? '치명타로 ' : ''}${won(dmg)} 피해를 줬어요.`)
  if (r.hp > 0) {
    lines.push(`남은 체력 ${won(r.hp)} (최대 ${won(r.mx)})`, hpBar(r.hp, r.mx))
    return { text: lines.join('\n') }
  }
  // 쓰러뜨렸다: 피해량대로 골드를 나누고, 마지막 일격·가장 큰 피해에 아이템
  const pool = Math.round(r.mx * BOSS_REWARD)
  const rows = Object.keys(r.d)
    .filter((k) => has(s.u, k) && isObj(s.u[k]))
    .map((k) => ({ k, d: Number(r.d[k]) || 0 }))
    .sort((a, b) => b.d - a.d)
  const total = rows.reduce((n, x) => n + x.d, 0) || 1
  for (const x of rows) x.g = Math.max(100, Math.floor((pool * x.d) / total))
  // 1인 최소 100G 를 채우느라 합이 나눌 골드(pool)를 넘으면(조금 친 사람이 많을 때) 모두 같은 비율로 줄인다
  const sum = rows.reduce((n, x) => n + x.g, 0)
  if (sum > pool) for (const x of rows) x.g = Math.floor((x.g * pool) / sum)
  for (const x of rows) {
    const v = s.u[x.k]
    v.g = Math.min(MAX_GOLD, v.g + x.g)
  }
  const last = reward(u, [['scale', 1], ['guard', 1]])
  const mvp = rows[0]
  const mvpName = mvp ? s.u[mvp.k].n || '참가자' : ''
  const best = mvp ? reward(s.u[mvp.k], [['bless', 2]]) : null
  s.bk += 1
  s.bl += 1
  s.r = null
  s.rn = ctx.now + BOSS_GAP_MS
  lines.push(`[보스 처치] ${ctx.name}님의 마지막 일격으로 ${nm}${josa(nm, '을')} 쓰러뜨렸어요.`)
  lines.push(`마지막 일격 : ${ctx.name}님${last.got.length ? ` (${last.got.join(' · ')})` : ''}`)
  if (mvp) lines.push(`가장 큰 피해 : ${mvpName}님${best.got.length ? ` (${best.got.join(' · ')})` : ''}`)
  if (last.full.length) lines.push(fullLine(last.full, ctx.name))
  if (best && best.full.length) lines.push(fullLine(best.full, mvpName))
  rows.slice(0, 5).forEach((x, i) => lines.push(`${i + 1}. ${s.u[x.k].n || '참가자'} ${won(x.d)} 피해 +${g(x.g)}`))
  if (rows.length > 5) lines.push(`외 ${rows.length - 5}명도 골드를 받았어요.`)
  lines.push(`다음 보스는 ${minLeft(BOSS_GAP_MS)}분 뒤에 나타나요.`)
  return { text: lines.join('\n') }
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
