// 미니게임봇 「몬스터 수집」 — 순수 모듈(네트워크·DB·타이머 없음). 시각(now)과 난수(rand)는 늘 인자로 받는다.
// 상태는 방 runtime.mon 하나에 둔다: { v, seq, u: {사람 열쇠: 사람}, p: {받는 사람 열쇠: 기다리는 신청} }
//   사람 = { n 이름, c 코인, nets [그물, 별그물, 황금그물], m [[번호, 도감번호, 레벨, 경험치]…], ld 대표 번호,
//            dx 도감('0' 못 봄 · '1' 봄 · '2' 잡음, 도감 번호 순), e 만난 몬스터 [도감번호, 레벨, 시각] | null,
//            x 마지막 탐험 시각, dd 출석 보상 받은 날, bd·bn 배틀 보상 받은 날·횟수, w·l 이긴·진 배틀, at 마지막 활동 }
//   신청 = { k 'battle'|'trade', f 보낸 사람 열쇠, at 시각, g 보내는 몬스터 번호, w 받고 싶은 몬스터 번호 }
// 답은 한 명령에 하나: { text, card? } — card 는 monster-card.mjs 가 그림으로 바꾸고, 그림을 못 보내면 text 를 보낸다.
import { ELEMENTS, RARITIES, SPECIES } from './monster-data.mjs'
import { josa } from './roomfeat.mjs'

export const MAX_USERS = 200
export const MAX_BOX = 30
export const MAX_LV = 30
export const EXPLORE_MS = 60 * 1000
export const ENCOUNTER_MS = 5 * 60 * 1000
export const PENDING_MS = 3 * 60 * 1000
export const START_COINS = 100
export const START_NETS = [5, 0, 0]
export const DAILY_NETS = 3
export const BATTLE_REWARDS_PER_DAY = 5
export const NETS = [
  { name: '그물', price: 20, mult: 1, alias: ['그물', '일반', '기본', '일반그물', '기본그물'] },
  { name: '별그물', price: 60, mult: 1.5, alias: ['별그물', '별'] },
  { name: '황금그물', price: 150, mult: 2.5, alias: ['황금그물', '황금'] },
]
const BUY_MAX = 20
const ITEM_CHANCE = 0.1
const BATTLE_ROUNDS = 10
const WIN_COINS = 30
const LOSE_COINS = 10

// 명령어(접두사 뒤). 수락·거절은 다른 게임과 같이 쓸 수 있어 기다리는 신청이 없으면 null 을 돌려준다.
export const COMMANDS = ['몬스터', '탐험', '포획', '도감', '내몬스터', '대표', '놓아주기', '배틀', '교환', '수락', '거절', '그물', '몬스터랭킹']
const CMDSET = new Set(COMMANDS)
export function isCommand(cmd) {
  return CMDSET.has(String(cmd || ''))
}
/**
 * 「수락」·「거절」이 이 게임에 갈 신청: 이 사람이 받은 살아 있는 신청 → {got:true, at}. 「거절」이면 받은 것이 없을 때
 * 이 사람이 보낸 신청(취소) → {got:false, at}. 없으면 null. 상태를 바꾸지 않는다(features 가 검 강화와 견줘 고른다).
 */
export function offerAt(rt, key, cmd, now) {
  const mon = rt && rt.mon
  if (!mon || typeof mon !== 'object' || !mon.u || !mon.p || typeof mon.p !== 'object') return null
  const k = String(key)
  const live = (to, p) => p && now - Number(p.at || 0) < PENDING_MS && mon.u[to] && mon.u[p.f]
  if (!mon.u[k]) return null
  const mine = mon.p[k]
  if (live(k, mine)) return { got: true, at: Number(mine.at) || 0 }
  if (cmd !== '거절') return null
  for (const [t, p] of Object.entries(mon.p)) if (p && p.f === k && live(t, p)) return { got: false, at: Number(p.at) || 0 }
  return null
}

/** 도움말 한 줄(roomfeat.helpLine · features 「!게임」 이 쓴다) */
export function helpCommands(p) {
  return ['탐험', '포획', '도감', '내몬스터', '배틀', '교환', '몬스터'].map((c) => p + c).join(' ')
}

const SP = new Map(SPECIES.map((s) => [s.id, s]))
const EL = new Map(ELEMENTS.map((e) => [e.id, e]))
const RAR = new Map(RARITIES.map((r) => [r.id, r]))
const DEX_N = SPECIES.length
// 상성: 앞이 뒤에 강하다(1.5배), 거꾸로는 0.7배
const BEATS = { sun: 'wave', wave: 'rock', rock: 'wind', wind: 'star', star: 'sun' }
export const CYCLE_TEXT = '햇살 → 물결 → 바위 → 바람 → 별빛 → 햇살'

export function species(id) {
  return SP.get(Number(id)) || null
}
export function elementName(id) {
  return (EL.get(id) || {}).name || ''
}
export function rarityName(r) {
  return (RAR.get(Number(r)) || {}).name || ''
}

// ── 숫자 ──────────────────────────────────────────────────────────────────
export function expNeed(lv) {
  return 5 + 3 * lv
}

export function stats(sid, lv) {
  const sp = species(sid)
  const st = sp ? sp.st : [40, 40, 40, 40]
  const pw = 1 + Math.max(1, Number(lv) || 1) / 10
  return { hp: Math.round(st[0] * 2 * pw), atk: Math.round(st[1] * pw), def: Math.round(st[2] * pw), spd: Math.round(st[3] * pw) }
}

export function advantage(att, def) {
  if (BEATS[att] === def) return 1.5
  if (BEATS[def] === att) return 0.7
  return 1
}

function kstDay(now) {
  return new Date(Number(now) + 9 * 3600 * 1000).toISOString().slice(0, 10)
}

function pick(list, rand) {
  return list[Math.min(list.length - 1, Math.floor(rand() * list.length))]
}

function between(lo, hi, rand) {
  return lo + Math.min(hi - lo, Math.floor(rand() * (hi - lo + 1)))
}

function nm(name) {
  const s = String(name == null ? '' : name).replace(/[\u0000-\u001f\u007f]/g, ' ').trim()
  return s ? s.slice(0, 40) : '참가자'
}

function lvText(lv) {
  return 'Lv.' + lv
}

// ── 상태 ──────────────────────────────────────────────────────────────────
export function monState(rt) {
  if (!rt.mon || typeof rt.mon !== 'object' || Array.isArray(rt.mon)) rt.mon = {}
  const m = rt.mon
  m.v = 1
  if (!Number.isSafeInteger(m.seq) || m.seq < 1) m.seq = 1
  if (!m.u || typeof m.u !== 'object' || Array.isArray(m.u)) m.u = {}
  if (!m.p || typeof m.p !== 'object' || Array.isArray(m.p)) m.p = {}
  return m
}

function fixUser(u) {
  if (!Array.isArray(u.m)) u.m = []
  u.m = u.m.filter((x) => Array.isArray(x) && x.length >= 4 && species(x[1]))
  if (!Array.isArray(u.nets)) u.nets = START_NETS.slice()
  while (u.nets.length < NETS.length) u.nets.push(0)
  u.nets = u.nets.slice(0, NETS.length).map((v) => Math.max(0, Math.floor(Number(v) || 0)))
  u.c = Math.max(0, Math.floor(Number(u.c) || 0))
  if (typeof u.dx !== 'string') u.dx = ''
  if (u.dx.length < DEX_N) u.dx = u.dx.padEnd(DEX_N, '0')
  if (!u.m.some((x) => x[0] === u.ld)) u.ld = u.m.length ? u.m[0][0] : 0
  return u
}

/** 사람 기록(없으면 만든다). 사람이 MAX_USERS 를 넘으면 오래 안 한 사람부터 지운다. */
export function userOf(mon, key, name, now) {
  let u = mon.u[key]
  if (!u) {
    u = { n: nm(name), c: START_COINS, nets: START_NETS.slice(), m: [], ld: 0, dx: '0'.repeat(DEX_N), e: null, x: 0, dd: '', bd: '', bn: 0, w: 0, l: 0, at: now }
    mon.u[key] = u
    prune(mon, now, key)
  }
  fixUser(u)
  if (name) u.n = nm(name)
  u.at = now
  return u
}

/** 오래된 신청을 지우고, 사람이 너무 많으면 마지막 활동이 오래된 사람부터 지운다(keep 은 남긴다). */
export function prune(mon, now, keep) {
  for (const [k, p] of Object.entries(mon.p)) {
    if (!p || !(now - Number(p.at || 0) < PENDING_MS) || !mon.u[k] || !mon.u[p.f]) delete mon.p[k]
  }
  const keys = Object.keys(mon.u)
  if (keys.length <= MAX_USERS) return
  keys.sort((a, b) => Number(mon.u[a].at || 0) - Number(mon.u[b].at || 0))
  let extra = keys.length - MAX_USERS
  for (const k of keys) {
    if (extra <= 0) break
    if (k === keep) continue
    delete mon.u[k]
    for (const [t, p] of Object.entries(mon.p)) if (t === k || p.f === k) delete mon.p[t]
    extra--
  }
}

function dexMark(u, sid, v) {
  const i = Number(sid) - 1
  if (i < 0 || i >= DEX_N) return false
  const cur = u.dx[i]
  if (cur >= v) return false
  u.dx = u.dx.slice(0, i) + v + u.dx.slice(i + 1)
  return true
}

export function dexCount(u, v) {
  let n = 0
  for (const ch of u.dx || '') if (ch >= v) n++
  return n
}

function monView(x) {
  const sp = species(x[1])
  return { id: x[0], sid: x[1], sp, lv: x[2], xp: x[3] }
}

function leaderOf(u) {
  const x = u.m.find((r) => r[0] === u.ld)
  return x || null
}

/** 경험치를 더하고 레벨·진화를 처리한다. → { gain, from, to, evolved: [옛 도감번호, 새 도감번호] | null } */
export function addExp(u, x, n) {
  const from = x[2]
  let evolved = null
  if (x[2] >= MAX_LV) return { gain: 0, from, to: from, evolved }
  x[3] += n
  while (x[2] < MAX_LV && x[3] >= expNeed(x[2])) {
    x[3] -= expNeed(x[2])
    x[2] += 1
    const sp = species(x[1])
    if (sp && sp.evo && x[2] >= sp.evo.lv && species(sp.evo.to)) {
      evolved = evolved ? [evolved[0], sp.evo.to] : [x[1], sp.evo.to]
      x[1] = sp.evo.to
      dexMark(u, x[1], '2')
    }
  }
  if (x[2] >= MAX_LV) x[3] = 0
  return { gain: n, from, to: x[2], evolved }
}

function expLine(label, x, r) {
  if (!r.gain) return `${label} ${species(x[1]).name}${josa(species(x[1]).name, '은')} 이미 최고 레벨이에요.`
  let s = `${label} ${species(r.evolved ? r.evolved[0] : x[1]).name} 경험치 +${r.gain}`
  if (r.to > r.from) s += ` (${lvText(r.to)})`
  if (r.evolved) {
    const a = species(r.evolved[0]).name
    const b = species(r.evolved[1]).name
    s += `\n${a}${josa(a, '이')} ${b}${josa(b, '으로')} 진화했어요.`
  }
  return s
}

function netsText(u) {
  return NETS.map((n, i) => `${n.name} ${u.nets[i]}`).join(' · ')
}

// ── 명령 처리 ──────────────────────────────────────────────────────────────
/**
 * 몬스터 수집 명령 하나를 처리한다.
 * rt: 방 runtime · req: { cmd, arg, key, name, mentions:[userId], prefix } · env: { now, rand }
 * → { text, card? } | null(이 게임의 명령이 아니거나 수락·거절할 신청이 없음)
 */
export function handle(rt, req, env) {
  const cmd = String(req.cmd || '')
  if (!isCommand(cmd)) return null
  const now = Number(env && env.now) || 0
  const rand = env && typeof env.rand === 'function' ? env.rand : Math.random
  const mon = monState(rt)
  prune(mon, now)
  const key = String(req.key || '')
  if (!key) return null
  const p = req.prefix || '!'
  const arg = String(req.arg || '').trim()
  const ctx = { mon, key, name: req.name, p, arg, now, rand, mentions: Array.isArray(req.mentions) ? req.mentions.map(String) : [] }
  if (cmd === '수락' || cmd === '거절') {
    if (!mon.u[key]) return null
    return cmd === '수락' ? accept(ctx) : reject(ctx)
  }
  // 도움말·랭킹은 보기만 한다(기록을 만들지 않는다)
  if (cmd === '몬스터') return help(ctx)
  if (cmd === '몬스터랭킹') return ranking(ctx)
  const u = userOf(mon, key, req.name, now)
  ctx.u = u
  ctx.who = u.n
  switch (cmd) {
    case '탐험': return explore(ctx)
    case '포획': return capture(ctx)
    case '도감': return dex(ctx)
    case '내몬스터': return box(ctx)
    case '대표': return setLeader(ctx)
    case '놓아주기': return release(ctx)
    case '그물': return shop(ctx)
    case '배틀': return askBattle(ctx)
    case '교환': return askTrade(ctx)
  }
  return null
}

function help(c) {
  const p = c.p
  return {
    text: '[명령어]\n몬스터 수집 : ' + ['탐험', '포획', '도감', '내몬스터', '대표', '놓아주기', '그물', '배틀', '교환', '수락', '거절', '몬스터랭킹'].map((x) => p + x).join(' ') +
      `\n상성 : ${CYCLE_TEXT} (왼쪽이 오른쪽에 강해요)`,
  }
}

// !탐험 — 1분에 한 번. 하루 첫 탐험에 그물 3개. 10% 는 코인·별그물을 줍고, 나머지는 야생 몬스터를 만난다.
function explore(c) {
  const u = c.u
  const wait = EXPLORE_MS - (c.now - Number(u.x || 0))
  if (u.x && wait > 0) return { text: `${c.who}님, 다음 탐험까지 ${Math.ceil(wait / 1000)}초 남았어요.` }
  u.x = c.now
  const lines = []
  const day = kstDay(c.now)
  let bonus = 0
  if (u.dd !== day) {
    u.dd = day
    u.nets[0] += DAILY_NETS
    bonus = DAILY_NETS
    lines.push(`오늘 첫 탐험 보상으로 그물 ${DAILY_NETS}개를 받았어요.`)
  }
  if (c.rand() < ITEM_CHANCE) {
    u.e = null
    if (c.rand() < 0.7) {
      const k = between(15, 40, c.rand)
      u.c += k
      lines.unshift(`[탐험] ${c.who}님이 풀숲에서 코인 ${k}개를 주웠어요. (코인 ${u.c}개)`)
    } else {
      u.nets[1] += 1
      lines.unshift(`[탐험] ${c.who}님이 풀숲에서 별그물 1개를 주웠어요. (별그물 ${u.nets[1]}개)`)
    }
    return { text: lines.join('\n') }
  }
  const sp = wildPick(c.rand)
  const rar = RAR.get(sp.r)
  const lv = between(rar.lv[0], rar.lv[1], c.rand)
  const before = u.dx[sp.id - 1]
  dexMark(u, sp.id, '1')
  u.e = [sp.id, lv, c.now]
  const seen = before === '2' ? '도감에 있는 몬스터예요.' : before === '1' ? '전에 본 적 있는 몬스터예요.' : '처음 보는 몬스터예요.'
  lines.unshift(`[탐험] ${c.who}님 앞에 야생 ${sp.name}${josa(sp.name, '이')} 나타났어요. (${lvText(lv)} · ${elementName(sp.el)} · ${rarityName(sp.r)})`, seen)
  lines.push(`「${c.p}포획」으로 잡아 보세요. (${netsText(u)})`)
  return {
    text: lines.join('\n'),
    card: { kind: 'encounter', owner: c.who, sid: sp.id, lv, dex: before, nets: u.nets.slice(), bonus, prefix: c.p },
  }
}

function wildPick(rand) {
  const pool = RARITIES.filter((r) => SPECIES.some((s) => s.wild && s.r === r.id))
  const total = pool.reduce((a, r) => a + r.weight, 0)
  let roll = rand() * total
  let rar = pool[pool.length - 1]
  for (const r of pool) {
    if (roll < r.weight) { rar = r; break }
    roll -= r.weight
  }
  return pick(SPECIES.filter((s) => s.wild && s.r === rar.id), rand)
}

function netIndex(arg) {
  const a = String(arg || '').replace(/\s+/g, '')
  if (!a) return -1
  return NETS.findIndex((n) => n.alias.includes(a))
}

// !포획 [그물 종류] — 그물 하나를 쓴다. 실패하면 등급에 따라 도망갈 수 있다.
function capture(c) {
  const u = c.u
  const p = c.p
  if (!u.e || !(c.now - Number(u.e[2] || 0) < ENCOUNTER_MS) || !species(u.e[0])) {
    u.e = null
    return { text: `${c.who}님, 지금 만난 몬스터가 없어요. 「${p}탐험」으로 찾아 주세요.` }
  }
  let ni
  if (c.arg) {
    ni = netIndex(c.arg)
    if (ni < 0) return { text: '그물 종류는 그물 · 별그물 · 황금그물 중에서 골라 주세요.' }
  } else {
    ni = u.nets.findIndex((n) => n > 0)
    if (ni < 0) ni = 0
  }
  const net = NETS[ni]
  if (!(u.nets[ni] > 0)) return { text: `${c.who}님, ${net.name}${josa(net.name, '이')} 없어요. 「${p}그물」로 살 수 있어요. (코인 ${u.c}개)` }
  if (u.m.length >= MAX_BOX) return { text: `${c.who}님의 보관함이 가득 찼어요. (최대 ${MAX_BOX}마리) 「${p}놓아주기 번호」로 자리를 비워 주세요.` }
  const sp = species(u.e[0])
  const lv = u.e[1]
  const rar = RAR.get(sp.r)
  u.nets[ni] -= 1
  const chance = Math.min(0.95, rar.catch * net.mult)
  if (c.rand() >= chance) {
    const fled = c.rand() < rar.flee
    if (fled) u.e = null
    return {
      text: fled
        ? `${sp.name}${josa(sp.name, '이')} 그물을 빠져나와 도망갔어요. (${net.name} ${u.nets[ni]}개 남음)`
        : `${sp.name}${josa(sp.name, '이')} 그물을 빠져나왔어요. 다시 「${p}포획」해 보세요. (${net.name} ${u.nets[ni]}개 남음)`,
    }
  }
  u.e = null
  const id = c.mon.seq++
  const row = [id, sp.id, lv, 0]
  u.m.push(row)
  const fresh = dexMark(u, sp.id, '2')
  u.c += rar.coin
  const lines = [`[포획] ${c.who}님이 ${sp.name}${josa(sp.name, '을')} 잡았어요. (${lvText(lv)} · 보관함 ${u.m.length}번)`]
  lines.push((fresh ? `도감에 새로 올렸어요. (${dexCount(u, '2')}/${DEX_N}종) · ` : '') + `코인 +${rar.coin}`)
  let lead = null
  if (!u.ld || u.m.length === 1) {
    u.ld = id
    lines.push('첫 몬스터라서 대표로 정했어요.')
  } else {
    const lx = leaderOf(u)
    if (lx) {
      const r = addExp(u, lx, 6 + lv * 2)
      lines.push(expLine('대표', lx, r))
      lead = { sid: lx[1], lv: lx[2], gain: r.gain, up: r.to > r.from, evolved: r.evolved }
    }
  }
  return {
    text: lines.join('\n'),
    card: { kind: 'catch', owner: c.who, sid: sp.id, lv, no: u.m.length, fresh, coin: rar.coin, dex: dexCount(u, '2'), total: DEX_N, lead, first: !lead && u.ld === id },
  }
}

// !도감 [이름]
function dex(c) {
  const u = c.u
  if (c.arg) {
    const q = c.arg.replace(/\s+/g, '')
    const sp = SPECIES.find((s) => s.name === q || String(s.id) === q.replace(/^No\.?/i, ''))
    if (!sp) return { text: `「${c.arg}」${josa(c.arg, '은')} 도감에 없는 이름이에요.` }
    const st = u.dx[sp.id - 1]
    if (st === '0') return { text: `아직 만나지 못한 몬스터예요. 「${c.p}탐험」으로 찾아 보세요.` }
    return speciesInfo(c, sp, st)
  }
  const caught = SPECIES.filter((s) => u.dx[s.id - 1] === '2').map((s) => s.name)
  const seen = SPECIES.filter((s) => u.dx[s.id - 1] === '1').map((s) => s.name)
  const lines = [`[도감] ${c.who}님 ${caught.length}/${DEX_N}종`]
  lines.push('잡은 몬스터 : ' + (caught.length ? caught.join(', ') : '없음'))
  if (seen.length) lines.push('본 몬스터 : ' + seen.join(', '))
  return { text: lines.join('\n'), card: { kind: 'dex', owner: c.who, dx: u.dx } }
}

function evoText(sp) {
  if (!sp.evo) return ''
  const to = species(sp.evo.to)
  return `${lvText(sp.evo.lv)}에 ${to.name}${josa(to.name, '으로')} 진화해요.`
}

function speciesInfo(c, sp, st) {
  const lines = [`[도감] No.${sp.id} ${sp.name} · ${elementName(sp.el)} · ${rarityName(sp.r)}`, sp.d, `기술 : ${sp.mv}`]
  const e = evoText(sp)
  if (e) lines.push(e)
  lines.push(st === '2' ? '잡은 적 있는 몬스터예요.' : '본 적만 있는 몬스터예요.')
  return { text: lines.join('\n'), card: { kind: 'info', owner: c.who, sid: sp.id, caught: st === '2' } }
}

function numArg(s) {
  const t = String(s || '').trim()
  return /^\d{1,3}$/.test(t) ? Number(t) : NaN
}

// !내몬스터 [번호 | @상대]
function box(c) {
  const p = c.p
  let u = c.u
  let who = c.who
  let other = false
  if (c.arg && !/^\d+$/.test(c.arg)) {
    const t = target(c, c.arg)
    if (!t) return { text: `상대를 찾지 못했어요. 「${p}내몬스터 @상대」처럼 멘션해 주세요.` }
    if (t.key !== c.key) {
      const ou = c.mon.u[t.key]
      if (!ou || !ou.m || !ou.m.length) return { text: `${t.name}님은 아직 몬스터가 없어요.` }
      u = fixUser(ou)
      who = ou.n
      other = true
    }
  }
  if (!u.m.length) return { text: `${who}님은 아직 몬스터가 없어요. 「${p}탐험」으로 찾아 보세요.` }
  if (c.arg && /^\d+$/.test(c.arg)) {
    const n = numArg(c.arg)
    const x = u.m[n - 1]
    if (!x) return { text: `몬스터 번호는 1~${u.m.length} 사이로 입력해 주세요.` }
    return monInfo(c, u, x, n)
  }
  const lines = [`[내 몬스터] ${who}님 ${u.m.length}/${MAX_BOX}마리 · 코인 ${u.c}개`]
  u.m.forEach((x, i) => lines.push(`${i + 1}. ${species(x[1]).name} ${lvText(x[2])}${x[0] === u.ld ? ' (대표)' : ''}`))
  if (!other) lines.push(netsText(u))
  return {
    text: lines.join('\n'),
    card: { kind: 'box', owner: who, mons: u.m.map((x, i) => ({ no: i + 1, sid: x[1], lv: x[2], lead: x[0] === u.ld })), coins: u.c, nets: other ? null : u.nets.slice(), dex: dexCount(u, '2'), total: DEX_N },
  }
}

function monInfo(c, u, x, no) {
  const sp = species(x[1])
  const s = stats(x[1], x[2])
  const need = x[2] >= MAX_LV ? 0 : expNeed(x[2])
  const lines = [`[몬스터 정보] ${u.n}님의 ${no}번 ${sp.name} ${lvText(x[2])}${x[0] === u.ld ? ' (대표)' : ''}`,
    `${elementName(sp.el)} · ${rarityName(sp.r)} · 경험치 ${need ? `${x[3]}/${need}` : '최고 레벨'}`,
    `체력 ${s.hp} · 공격 ${s.atk} · 방어 ${s.def} · 속도 ${s.spd}`,
    `기술 : ${sp.mv}`]
  const e = evoText(sp)
  if (e) lines.push(e)
  return {
    text: lines.join('\n'),
    card: { kind: 'info', owner: u.n, sid: sp.id, caught: true, mon: { no, lv: x[2], xp: x[3], need, lead: x[0] === u.ld, stats: s } },
  }
}

function setLeader(c) {
  const u = c.u
  if (!u.m.length) return { text: `${c.who}님은 아직 몬스터가 없어요. 「${c.p}탐험」으로 찾아 보세요.` }
  const n = numArg(c.arg)
  if (!c.arg) return { text: `「${c.p}대표 번호」처럼 입력해 주세요. 번호는 「${c.p}내몬스터」에서 볼 수 있어요.` }
  const x = u.m[n - 1]
  if (!x) return { text: `몬스터 번호는 1~${u.m.length} 사이로 입력해 주세요.` }
  u.ld = x[0]
  const name = species(x[1]).name
  return { text: `${c.who}님의 대표 몬스터를 ${n}번 ${name}${josa(name, '으로')} 정했어요. (${lvText(x[2])})` }
}

function release(c) {
  const u = c.u
  if (!u.m.length) return { text: `${c.who}님은 아직 몬스터가 없어요.` }
  if (!c.arg) return { text: `「${c.p}놓아주기 번호」처럼 입력해 주세요. 번호는 「${c.p}내몬스터」에서 볼 수 있어요.` }
  const n = numArg(c.arg)
  const x = u.m[n - 1]
  if (!x) return { text: `몬스터 번호는 1~${u.m.length} 사이로 입력해 주세요.` }
  const sp = species(x[1])
  const k = RAR.get(sp.r).free + x[2]
  u.m.splice(n - 1, 1)
  u.c += k
  let s = `${c.who}님이 ${sp.name}${josa(sp.name, '을')} 놓아줬어요. 코인 +${k} (코인 ${u.c}개)`
  if (u.ld === x[0]) {
    u.ld = u.m.length ? u.m[0][0] : 0
    if (u.m.length) {
      const nn = species(u.m[0][1]).name
      s += `\n대표는 1번 ${nn}${josa(nn, '으로')} 바꿨어요.`
    }
  }
  return { text: s }
}

// !그물 → 상점 목록 · !그물 [종류] [개수] → 사기
function shop(c) {
  const u = c.u
  const p = c.p
  if (!c.arg) {
    const lines = [`[그물 상점] ${c.who}님 코인 ${u.c}개`]
    NETS.forEach((n, i) => lines.push(`${n.name} ${n.price}코인 · 잡을 확률 ${n.mult}배 (${u.nets[i]}개 있음)`))
    lines.push(`사는 법 : 「${p}그물 별그물 2」`)
    return { text: lines.join('\n') }
  }
  const parts = c.arg.split(/\s+/)
  let ni = 0
  let cnt = 1
  if (/^\d+$/.test(parts[0])) {
    cnt = Number(parts[0])
    if (parts.length > 1) return { text: `「${p}그물 별그물 2」처럼 입력해 주세요.` }
  } else {
    ni = netIndex(parts[0])
    if (ni < 0) return { text: '그물 종류는 그물 · 별그물 · 황금그물 중에서 골라 주세요.' }
    if (parts.length > 2) return { text: `「${p}그물 별그물 2」처럼 입력해 주세요.` }
    if (parts.length === 2) cnt = /^\d+$/.test(parts[1]) ? Number(parts[1]) : NaN
  }
  if (!(cnt >= 1 && cnt <= BUY_MAX)) return { text: `개수는 1~${BUY_MAX}개로 입력해 주세요.` }
  const net = NETS[ni]
  const cost = net.price * cnt
  if (u.c < cost) return { text: `코인이 모자라요. (필요 ${cost}개 · 있는 코인 ${u.c}개)` }
  u.c -= cost
  u.nets[ni] += cnt
  return { text: `${c.who}님이 ${net.name} ${cnt}개를 샀어요. (코인 ${u.c}개 남음 · ${net.name} ${u.nets[ni]}개)` }
}

// ── 상대 찾기 ──────────────────────────────────────────────────────────────
// 멘션(사람 번호)이 있으면 그것을, 없으면 '@이름' 글자를 이 방 몬스터 수집 참가자의 이름과 맞춘다.
function target(c, text) {
  const raw = String(text || '').trim()
  const label = raw.replace(/^[@＠]/, '').trim()
  if (c.mentions.length) {
    const id = c.mentions[0]
    const u = c.mon.u[id]
    return { key: id, name: u ? u.n : nm(label) }
  }
  if (!label) return null
  let best = null
  for (const [k, u] of Object.entries(c.mon.u)) {
    if (u.n !== label) continue
    if (!best || Number(u.at || 0) > Number(c.mon.u[best].at || 0)) best = k
  }
  return best ? { key: best, name: c.mon.u[best].n } : null
}

function outgoing(mon, key) {
  for (const [t, p] of Object.entries(mon.p)) if (p.f === key) return t
  return ''
}

function canAsk(c, t, what) {
  const p = c.p
  if (t.key === c.key) return `자기 자신과는 ${what}할 수 없어요.`
  const ou = c.mon.u[t.key]
  if (!ou || !ou.m || !ou.m.length) return `${t.name}님은 아직 몬스터가 없어요.`
  if (!c.u.m.length) return `${c.who}님은 아직 몬스터가 없어요. 「${p}탐험」으로 먼저 잡아 주세요.`
  if (c.mon.p[t.key]) return `${t.name}님에게 이미 기다리는 신청이 있어요. 잠시 뒤 다시 해 주세요.`
  if (outgoing(c.mon, c.key)) return `${c.who}님이 보낸 신청이 아직 기다리는 중이에요. 「${p}거절」로 취소할 수 있어요.`
  if (c.mon.p[c.key]) return `${c.who}님이 받은 신청이 있어요. 먼저 「${p}수락」 또는 「${p}거절」을 입력해 주세요.`
  return ''
}

function monLabel(x) {
  return `${species(x[1]).name} ${lvText(x[2])}`
}

// !배틀 @상대
function askBattle(c) {
  const p = c.p
  if (!c.arg && !c.mentions.length) return { text: `「${p}배틀 @상대」처럼 입력해 주세요.` }
  const t = target(c, c.arg)
  if (!t) return { text: `배틀할 상대를 찾지 못했어요. 「${p}배틀 @상대」처럼 멘션해 주세요.` }
  const why = canAsk(c, t, '배틀')
  if (why) return { text: why }
  const ou = fixUser(c.mon.u[t.key])
  c.mon.p[t.key] = { k: 'battle', f: c.key, at: c.now }
  return {
    text: `[배틀 신청] ${c.who}님 → ${ou.n}님\n${c.who}님 ${monLabel(leaderOf(c.u))} vs ${ou.n}님 ${monLabel(leaderOf(ou))}\n` +
      `${ou.n}님, 「${p}수락」 또는 「${p}거절」을 입력해 주세요. (3분 안)`,
  }
}

// !교환 @상대 내번호 상대번호
function askTrade(c) {
  const p = c.p
  const usage = `「${p}교환 @상대 내번호 상대번호」처럼 입력해 주세요. 상대 번호는 「${p}내몬스터 @상대」로 볼 수 있어요.`
  const parts = c.arg.split(/\s+/).filter(Boolean)
  if (parts.length < 2 || !/^\d+$/.test(parts[parts.length - 1]) || !/^\d+$/.test(parts[parts.length - 2])) return { text: usage }
  const want = Number(parts.pop())
  const give = Number(parts.pop())
  const t = target(c, parts.join(' '))
  if (!t) return { text: c.mentions.length || parts.length ? `교환할 상대를 찾지 못했어요. 「${p}교환 @상대 내번호 상대번호」처럼 멘션해 주세요.` : usage }
  const why = canAsk(c, t, '교환')
  if (why) return { text: why }
  const ou = fixUser(c.mon.u[t.key])
  const gx = c.u.m[give - 1]
  if (!gx) return { text: `내 몬스터 번호는 1~${c.u.m.length} 사이로 입력해 주세요.` }
  const wx = ou.m[want - 1]
  if (!wx) return { text: `${ou.n}님의 몬스터 번호는 1~${ou.m.length} 사이로 입력해 주세요.` }
  c.mon.p[t.key] = { k: 'trade', f: c.key, at: c.now, g: gx[0], w: wx[0] }
  return {
    text: `[교환 신청] ${c.who}님 → ${ou.n}님\n${c.who}님의 ${monLabel(gx)} ↔ ${ou.n}님의 ${monLabel(wx)}\n` +
      `${ou.n}님, 「${p}수락」 또는 「${p}거절」을 입력해 주세요. (3분 안)`,
  }
}

function reject(c) {
  const mon = c.mon
  const mine = mon.p[c.key]
  const me = mon.u[c.key]
  if (mine) {
    delete mon.p[c.key]
    const from = mon.u[mine.f]
    return { text: `${me.n}님이 ${from.n}님의 ${mine.k === 'battle' ? '배틀' : '교환'} 신청을 거절했어요.` }
  }
  const t = outgoing(mon, c.key)
  if (t) {
    const pend = mon.p[t]
    delete mon.p[t]
    return { text: `${me.n}님이 ${mon.u[t].n}님에게 보낸 ${pend.k === 'battle' ? '배틀' : '교환'} 신청을 취소했어요.` }
  }
  return null
}

function accept(c) {
  const mon = c.mon
  const pend = mon.p[c.key]
  if (!pend) return null
  delete mon.p[c.key]
  const me = userOf(mon, c.key, c.name, c.now)
  const from = mon.u[pend.f]
  if (!from) return { text: '신청한 사람을 찾지 못했어요.' }
  fixUser(from)
  return pend.k === 'trade' ? doTrade(c, from, pend.f, me, c.key, pend) : doBattle(c, from, me)
}

// 교환: 두 몬스터가 지금도 각자 보관함에 있을 때만, 한 번에 맞바꾼다(번호는 그대로 — 복제되지 않는다).
function doTrade(c, a, aKey, b, bKey, pend) {
  const ai = a.m.findIndex((x) => x[0] === pend.g)
  const bi = b.m.findIndex((x) => x[0] === pend.w)
  if (ai < 0 || bi < 0 || aKey === bKey) return { text: '교환할 몬스터가 바뀌어서 교환을 취소했어요. 다시 신청해 주세요.' }
  const ax = a.m[ai]
  const bx = b.m[bi]
  a.m.splice(ai, 1, bx)
  b.m.splice(bi, 1, ax)
  if (a.ld === ax[0]) a.ld = bx[0]
  if (b.ld === bx[0]) b.ld = ax[0]
  dexMark(a, bx[1], '2')
  dexMark(b, ax[1], '2')
  const al = monLabel(bx)
  const bl = monLabel(ax)
  return { text: `[교환 완료] ${a.n}님 ↔ ${b.n}님\n${a.n}님이 ${al}${josa(al, '을')}, ${b.n}님이 ${bl}${josa(bl, '을')} 받았어요.` }
}

/**
 * 두 몬스터의 배틀(결정적: 같은 rand 순서면 같은 결과). 빠른 쪽이 먼저, 최대 10번씩 주고받는다.
 * → { log:[{t, who, dmg, eff, crit, hp:[a,b]}], hp:[a,b], max:[a,b], win: 0|1, rounds }
 */
export function simulate(A, B, rand) {
  const side = [A, B].map((s) => {
    const st = stats(s.sid, s.lv)
    return { sp: species(s.sid), lv: s.lv, hp: st.hp, max: st.hp, atk: st.atk, def: st.def, spd: st.spd }
  })
  let first = side[0].spd > side[1].spd ? 0 : side[1].spd > side[0].spd ? 1 : (rand() < 0.5 ? 0 : 1)
  const log = []
  let rounds = 0
  for (let r = 1; r <= BATTLE_ROUNDS; r++) {
    rounds = r
    for (const who of [first, 1 - first]) {
      const a = side[who]
      const d = side[1 - who]
      if (a.hp <= 0 || d.hp <= 0) break
      const eff = advantage(a.sp.el, d.sp.el)
      const crit = rand() < 1 / 12
      const roll = 0.85 + rand() * 0.15
      const dmg = Math.max(1, Math.round(a.atk * (50 / (50 + d.def)) * 0.9 * eff * roll * (crit ? 1.5 : 1)))
      d.hp = Math.max(0, d.hp - dmg)
      log.push({ t: r, who, dmg, eff, crit, hp: [side[0].hp, side[1].hp] })
    }
    if (side[0].hp <= 0 || side[1].hp <= 0) break
  }
  let win
  if (side[0].hp <= 0) win = 1
  else if (side[1].hp <= 0) win = 0
  else {
    const ra = side[0].hp / side[0].max
    const rb = side[1].hp / side[1].max
    win = ra > rb ? 0 : rb > ra ? 1 : (rand() < 0.5 ? 0 : 1)
  }
  return { log, hp: [side[0].hp, side[1].hp], max: [side[0].max, side[1].max], win, rounds }
}

export function logLine(res, A, B, e) {
  const sides = [A, B]
  const a = species(sides[e.who].sid).name
  const d = species(sides[1 - e.who].sid).name
  const mv = species(sides[e.who].sid).mv
  let s = `${a}의 ${mv} → ${d} -${e.dmg}`
  const notes = []
  if (e.crit) notes.push('급소')
  if (e.eff > 1) notes.push('효과가 좋아요')
  else if (e.eff < 1) notes.push('효과가 약해요')
  if (notes.length) s += ` (${notes.join(' · ')})`
  return s
}

function rewardDay(u, now) {
  const day = kstDay(now)
  if (u.bd !== day) {
    u.bd = day
    u.bn = 0
  }
  if (u.bn >= BATTLE_REWARDS_PER_DAY) return false
  u.bn += 1
  return true
}

function doBattle(c, a, b) {
  const ax = leaderOf(a)
  const bx = leaderOf(b)
  if (!ax || !bx) return { text: '대표 몬스터가 없어서 배틀을 취소했어요.' }
  const A = { sid: ax[1], lv: ax[2] }
  const B = { sid: bx[1], lv: bx[2] }
  const res = simulate(A, B, c.rand)
  const names = [a.n, b.n]
  const users = [a, b]
  const rows = [ax, bx]
  const wi = res.win
  const li = 1 - wi
  users[wi].w = (Number(users[wi].w) || 0) + 1
  users[li].l = (Number(users[li].l) || 0) + 1
  const lines = res.log.map((e) => logLine(res, A, B, e))
  const shown = lines.length > 8 ? lines.slice(0, 3).concat(['…'], lines.slice(-4)) : lines
  const wName = species(rows[wi][1]).name
  const out = [`[배틀] ${names[0]}님 ${monLabel(ax)} vs ${names[1]}님 ${monLabel(bx)}`]
  out.push(...shown)
  out.push(`${names[wi]}님의 ${wName}${josa(wName, '이')} 이겼어요.${res.hp[0] > 0 && res.hp[1] > 0 ? ' (남은 체력이 더 많아요)' : ''}`)
  const reward = []
  const card = { kind: 'battle', a: { owner: names[0], sid: A.sid, lv: A.lv, hp: res.hp[0], max: res.max[0] }, b: { owner: names[1], sid: B.sid, lv: B.lv, hp: res.hp[1], max: res.max[1] }, win: wi, lines: shown, rewards: [] }
  for (const i of [wi, li]) {
    const won = i === wi
    if (!rewardDay(users[i], c.now)) {
      reward.push(`${names[i]}님은 오늘 배틀 보상을 모두 받았어요. (하루 ${BATTLE_REWARDS_PER_DAY}번)`)
      card.rewards.push({ who: i, coins: 0, exp: 0, done: true })
      continue
    }
    const coins = won ? WIN_COINS : LOSE_COINS
    users[i].c += coins
    const r = addExp(users[i], rows[i], won ? 12 + rows[1 - i][2] : 5)
    reward.push(`${names[i]}님 코인 +${coins} · ` + expLine('', rows[i], r).trim())
    card.rewards.push({ who: i, coins, exp: r.gain, lv: rows[i][2], up: r.to > r.from, evolved: r.evolved })
  }
  out.push(...reward)
  return { text: out.join('\n'), card }
}

// !몬스터랭킹 — 잡은 종류 수, 같으면 가장 높은 레벨
function ranking(c) {
  const rows = Object.values(c.mon.u)
    .map((u) => ({ n: u.n, dex: dexCount(fixUser(u), '2'), top: u.m.reduce((a, x) => Math.max(a, x[2]), 0) }))
    .filter((r) => r.dex > 0)
    .sort((a, b) => b.dex - a.dex || b.top - a.top || (a.n < b.n ? -1 : a.n > b.n ? 1 : 0))
    .slice(0, 10)
  if (!rows.length) return { text: '아직 몬스터를 잡은 사람이 없어요.' }
  return { text: '[몬스터 랭킹]\n' + rows.map((r, i) => `${i + 1}. ${r.n} 도감 ${r.dex}종 · 최고 ${lvText(r.top)}`).join('\n') }
}
