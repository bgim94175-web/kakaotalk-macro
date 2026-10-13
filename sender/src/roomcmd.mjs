// 방 관리봇의 방 안 명령어(docs/ACCOUNTS_V1.md 7.2 (g)) — 순수 함수만 둔다. 네트워크·DB·시각 없음.
// botpool.mjs(실제 방)와 lib/demo.js(체험)가 같은 함수로 명령어를 읽고, 사람을 찾고, 설정을 바꾸고, 답을 만든다.
//   !옾링 [@멘션 | 옾링 주소 | 닉네임]        그 사람의 옾링(권한: cfg.cmd.link — 방장·부방장만 / 모두 / 끄기)
//   !프로필조회 [@멘션 | 옾링 주소 | 닉네임]   프로필 기록(roomfeat.profileLookup, 예전 !프로필 도 같다)
//   !내보내기 [@멘션 | 옾링 주소]              방장·부방장만. 닉네임만으로는 고르지 않는다(다른 사람을 내보내지 않게)
//   !차단해제 [@멘션 | 옾링 주소 | 닉네임]     방장·부방장만. K bot이 내보내거나 적어 둔 재입장 차단을 푼다
//   !설정 · !입장기록 켜기|끄기 … · !금지어 추가|삭제 단어 · !금지어 목록   방장·부방장만. 패널과 같은 방 설정을 바꾼다
import { idText, josa, linkText, MAX_WORDS, MAX_WORD_LEN, profileUrl, sameNameReply } from './roomfeat.mjs'

function clean(s, max) {
  return String(s == null ? '' : s).replace(/[\r\n]+/g, ' ').trim().slice(0, max || 40)
}

// 켜고 끄는 기능: 명령어 이름(띄어 써도 된다) → 설정 절과 방에 부르는 이름(패널과 같은 이름)
export const TOGGLES = Object.freeze([
  { sec: 'visit', words: ['입장', '기록'], label: '입장·퇴장 기록' },
  { sec: 'churn', words: ['들낙', '감지'], label: '들낙 감지' },
  { sec: 'leaveKick', words: ['재입장', '차단'], label: '나간 사람 재입장 차단' },
  { sec: 'profile', words: ['프로필', '기록'], label: '프로필 기록' },
  { sec: 'promo', words: ['홍보', '금지'], label: '홍보 금지' },
  { sec: 'cover', words: ['금지어', '검열'], label: '금지어 검열' },
  { sec: 'guard', words: ['올킥', '감지'], label: '올킥 감지' },
])

// 켜고 끄기를 먼저 본다(「!프로필 기록 켜기」가 프로필 조회로, 「!금지어 검열 켜기」가 금지어 추가로 읽히지 않게)
const NAMED = [
  ...TOGGLES.map((t) => ({ cmd: 'toggle', sec: t.sec, words: t.words })),
  { cmd: 'link', words: ['옾링'] },
  { cmd: 'profile', words: ['프로필', '조회'] },
  { cmd: 'profile', words: ['프로필'] },
  { cmd: 'kick', words: ['내보내기'] },
  { cmd: 'unban', words: ['차단', '해제'] },
  { cmd: 'status', words: ['설정'] },
  { cmd: 'words', words: ['금지어'] },
]

const ON = new Set(['켜기', '켜', '켬', '켜줘', 'on'])
const OFF = new Set(['끄기', '꺼', '끔', '꺼줘', 'off'])

/**
 * 방 관리 명령어 하나를 읽는다. → null(방 관리 명령어 아님) |
 *   {cmd:'link'|'profile'|'kick'|'unban', arg} | {cmd:'status'} | {cmd:'toggle', sec, on:true|false|null} |
 *   {cmd:'words', op:'add'|'del'|'list'|'on'|'off'|'', words:[…]}
 * 이름 사이 띄어쓰기는 봐준다(「!입장 기록 켜기」). 이름 뒤에는 공백이나 글 끝이 와야 한다(「!설정값」은 아님).
 */
export function parseRoomCommand(text, prefix) {
  const body = String(text || '').trim()
  if (!prefix || !body.startsWith(prefix)) return null
  const rest = body.slice(prefix.length)
  for (const n of NAMED) {
    const m = new RegExp('^' + n.words.join('\\s*') + '(?=\\s|$)').exec(rest)
    if (!m) continue
    const arg = rest.slice(m[0].length).trim()
    if (n.cmd === 'toggle') {
      const a = arg.toLowerCase()
      return { cmd: 'toggle', sec: n.sec, on: ON.has(a) ? true : OFF.has(a) ? false : null }
    }
    if (n.cmd === 'status') return arg ? null : { cmd: 'status' }
    if (n.cmd === 'words') {
      const mm = /^(\S+)\s*([\s\S]*)$/.exec(arg)
      const head = mm ? mm[1].toLowerCase() : ''
      const tail = mm ? mm[2] : ''
      const op = head === '추가' ? 'add' : head === '삭제' || head === '빼기' ? 'del' : head === '목록' ? 'list'
        : ON.has(head) ? 'on' : OFF.has(head) ? 'off' : ''
      const words = tail.split(/[,\n]+/).map((w) => w.replace(/[\u0000-\u001f\u007f]/g, ' ').trim()).filter(Boolean)
      return { cmd: 'words', op: (op === 'list' || op === 'on' || op === 'off') && tail.trim() ? '' : op, words }
    }
    return { cmd: n.cmd, arg }
  }
  return null
}

/** 방장(1)·부방장(4)인가. 봇(8)은 명령어를 쓰지 않는다. */
export function isStaff(perm) {
  const n = Number(perm)
  return perm != null && Number.isFinite(n) && ((n & 1) !== 0 || (n & 4) !== 0)
}

// 옾링 주소를 비교할 때: 앞뒤 공백·끝 / · ? 뒤를 떼고 소문자 주소
function linkKey(s) {
  const t = String(s == null ? '' : s).trim().replace(/[?#].*$/, '').replace(/\/+$/, '')
  if (!/^(https?:\/\/)?open\.kakao\.com\/o\/[A-Za-z0-9_-]+$/i.test(t)) return ''
  const code = t.replace(/^(https?:\/\/)?open\.kakao\.com\/o\//i, '')
  return 'o/' + code
}

/** 글이 옾링 주소인가(사람을 옾링으로 고를 때) */
export function isLinkArg(arg) {
  return !!linkKey(arg)
}

/**
 * 사람 고르기. book = [{userId, name, link, here}] (here: 지난 명부 동기화 때 방에 있었음 — 모르면 true).
 * ask = {mentions:[id], arg, allowName}. 멘션 → 옾링 주소 → (allowName 이면) 닉네임 순.
 * → {userId, name, link} | {usage:true} | {none:'name'|'link', name?} | {many:n}
 * 같은 닉네임이 여럿이면 지금 방에 있는 사람이 하나일 때 그 사람, 아니면 many.
 */
export function findPerson(book, ask) {
  const rows = (Array.isArray(book) ? book : []).filter((r) => r && idText(r.userId))
  const a = ask || {}
  const byId = (id) => rows.find((r) => idText(r.userId) === id) || null
  const pick = (r, id) => ({ userId: id, name: clean(r && r.name, 40), link: r ? r.link : null })
  const mentioned = idText((a.mentions || [])[0])
  if (mentioned) return pick(byId(mentioned), mentioned)
  const arg = clean(a.arg, 200)
  if (!arg) return { usage: true }
  const key = linkKey(arg)
  if (key) {
    const hits = rows.filter((r) => linkKey(profileUrl(r.link)) === key)
    if (!hits.length) return { none: 'link' }
    if (hits.length > 1) {
      const here = hits.filter((r) => r.here !== false)
      if (here.length !== 1) return { many: hits.length }
      return pick(here[0], idText(here[0].userId))
    }
    return pick(hits[0], idText(hits[0].userId))
  }
  if (!a.allowName) return { usage: true }
  const want = clean(arg.replace(/^[@＠]/, ''), 40)
  if (!want) return { usage: true }
  const hits = rows.filter((r) => clean(r.name, 40) === want)
  if (!hits.length) return { none: 'name', name: want }
  if (hits.length > 1) {
    const here = hits.filter((r) => r.here !== false)
    if (here.length !== 1) return { many: hits.length }
    return pick(here[0], idText(here[0].userId))
  }
  return pick(hits[0], idText(hits[0].userId))
}

/** 사람을 못 골랐을 때의 답(usage 는 명령어마다 다르다 — 부르는 쪽이 usageOf 로) */
export function findFailReply(r) {
  if (r.many) return sameNameReply(r.many)
  if (r.none === 'link') return '그 옾링을 쓰는 사람을 이 방에서 찾지 못했어요.'
  if (r.none === 'name') return `「${r.name}」${josa(r.name, '을')} 이 방에서 찾지 못했어요.`
  return ''
}

export function usageOf(cmd, prefix) {
  const p = prefix
  if (cmd === 'link') return `「${p}옾링 @닉네임」처럼 입력해 주세요. 옾링 주소나 닉네임으로도 찾을 수 있어요.`
  if (cmd === 'kick') return `「${p}내보내기 @닉네임」처럼 멘션으로 입력해 주세요. 옾링 주소로도 고를 수 있어요.`
  if (cmd === 'unban') return `「${p}차단해제 닉네임」처럼 입력해 주세요. 옾링 주소로도 고를 수 있어요.`
  if (cmd === 'profile') return `「${p}프로필조회 @닉네임」처럼 입력해 주세요.`
  if (cmd === 'words') return `「${p}금지어 추가 단어」·「${p}금지어 삭제 단어」·「${p}금지어 목록」으로 입력해 주세요.`
  return ''
}

/** 방장·부방장만 쓰는 명령어를 다른 사람이 썼을 때 */
export function staffOnlyReply(cmd) {
  if (cmd === 'link') return '옾링 조회는 방장과 부방장만 할 수 있어요.'
  if (cmd === 'profile') return '프로필 조회는 방장과 부방장만 할 수 있어요.'
  if (cmd === 'kick') return '내보내기는 방장과 부방장만 할 수 있어요.'
  if (cmd === 'unban') return '차단 해제는 방장과 부방장만 할 수 있어요.'
  return '설정은 방장과 부방장만 바꿀 수 있어요.'
}

/** !옾링 답. person = {name, link}(link null = 읽지 못함, '' = 없음) */
export function linkReply(person) {
  const nm = clean(person && person.name, 40) || '이름 없음'
  return ['[옾링]', `이름 : ${nm}`, `옾링 : ${linkText(person ? person.link : null)}`].join('\n')
}

/** kick 결과 → 답. r: botpool.kick 의 결과 {ok, skipped, note, waitMin, status} */
export function kickReply(name, r) {
  const nm = clean(name, 40)
  const who = nm ? `${nm}님을` : '그 사람을'
  if (r && r.ok) return `${who} 내보냈어요.`
  const wait = r && Number(r.waitMin) > 0 ? `${Number(r.waitMin)}분쯤 뒤에` : '잠시 뒤'
  if (r && r.note === 'wave') return `올킥 감지로 K bot의 내보내기가 멈춰 있어요. ${wait} 다시 입력해 주세요.`
  if (r && r.note === 'paused') return `내보내기가 여러 번 실패해 잠시 멈춰 있어요. ${wait} 다시 입력해 주세요.`
  if (r && r.note === 'limit') return `K bot이 짧은 시간에 내보낼 수 있는 인원을 넘었어요. ${wait} 다시 입력해 주세요.`
  return `${who} 내보내지 못했어요. 잠시 뒤 다시 입력해 주세요.`
}

export const PROTECTED_REPLY = '방장·부방장·제외 대상은 내보낼 수 없어요.'
export const NOT_HERE_REPLY = '그 사람은 지금 이 방에 없어요.'

/** !차단해제 결과 → 답. r: botpool.unkickUser 의 결과 {ok, error} */
export function unbanReply(name, r) {
  const nm = clean(name, 40)
  if (r && r.ok) return `${nm ? nm + '님의' : '그 사람의'} 내보내기·재입장 차단을 풀었어요. 다시 들어올 수 있어요.`
  if (r && r.error === 'not_kicked') return 'K bot이 내보내거나 차단한 사람이 아니에요.'
  return '차단을 풀지 못했어요. 잠시 뒤 다시 입력해 주세요.'
}

// ── 설정 ─────────────────────────────────────────────────────────────────
function onOff(b) {
  return b ? '켜짐' : '꺼짐'
}

/** !설정 답: 방 관리 기능별 켜짐·꺼짐 */
export function statusReply(cfg) {
  const p = cfg.cmdPrefix
  const lines = ['[설정]']
  for (const t of TOGGLES) {
    let line = `${t.label} : ${onOff(cfg[t.sec].enabled)}`
    if (t.sec === 'cover' && cfg.cover.words.length) line += ` (금지어 ${cfg.cover.words.length}개)`
    lines.push(line)
  }
  lines.push(`「${p}입장기록 켜기」처럼 켜고 끌 수 있어요.`)
  return lines.join('\n')
}

function toggleLabel(sec) {
  const t = TOGGLES.find((x) => x.sec === sec)
  return t ? t.label : ''
}

function toggleName(sec) {
  const t = TOGGLES.find((x) => x.sec === sec)
  return t ? t.words.join('') : ''
}

/**
 * 설정을 바꾸는 명령어 → {patch, reply, log} | {reply}(바꿀 것이 없음 — 답만). patch 는 {절: {칸: 값}}.
 * 저장(botpool.changeConfig)이 된 뒤에 reply 를 보낸다. 저장이 안 되면 SAVE_FAIL_REPLY.
 */
export function configChange(cfg, c) {
  const p = cfg.cmdPrefix
  if (c.cmd === 'toggle') {
    const label = toggleLabel(c.sec)
    const now = !!cfg[c.sec].enabled
    if (c.on === null) {
      return { reply: `「${p}${toggleName(c.sec)} 켜기」·「${p}${toggleName(c.sec)} 끄기」로 입력해 주세요. 지금은 ${now ? '켜져' : '꺼져'} 있어요.` }
    }
    if (c.on === now) return { reply: `${label}${josa(label, '은')} 이미 ${now ? '켜져' : '꺼져'} 있어요.` }
    return {
      patch: { [c.sec]: { enabled: c.on } },
      reply: `${label}${josa(label, '을')} ${c.on ? '켰어요' : '껐어요'}.`,
      log: `${label} ${c.on ? '켜기' : '끄기'}`,
    }
  }
  if (c.cmd === 'words') {
    const words = cfg.cover.words.slice()
    if (c.op === 'on' || c.op === 'off') return configChange(cfg, { cmd: 'toggle', sec: 'cover', on: c.op === 'on' })
    if (c.op === 'list') {
      if (!words.length) return { reply: `등록된 금지어가 없어요. 「${p}금지어 추가 단어」로 추가할 수 있어요.` }
      const shown = words.slice(0, 50)
      return { reply: `[금지어]\n${shown.join(', ')}` + (words.length > shown.length ? `\n외 ${words.length - shown.length}개` : '') }
    }
    if ((c.op !== 'add' && c.op !== 'del') || !c.words.length) return { reply: usageOf('words', p) }
    const lower = new Set(words.map((w) => w.toLowerCase()))
    if (c.op === 'add') {
      if (c.words.some((w) => w.length > MAX_WORD_LEN)) return { reply: `금지어는 한 개에 ${MAX_WORD_LEN}자까지 입력할 수 있어요.` }
      const add = []
      for (const w of c.words) {
        if (lower.has(w.toLowerCase())) continue
        lower.add(w.toLowerCase())
        add.push(w)
      }
      if (!add.length) return { reply: '이미 등록된 금지어예요.' }
      if (words.length + add.length > MAX_WORDS) return { reply: `금지어는 ${MAX_WORDS}개까지 등록할 수 있어요.` }
      const next = words.concat(add)
      // 방에 금지어를 다시 올리지 않는다(docs/TONE.md) — 개수만 말한다
      let reply = `금지어 ${add.length}개를 추가했어요. 지금 ${next.length}개예요.`
      if (!cfg.cover.enabled) reply += `\n금지어 검열은 꺼져 있어요. 「${p}금지어 켜기」로 켤 수 있어요.`
      return { patch: { cover: { words: next } }, reply, log: `금지어 ${add.length}개 추가` }
    }
    const drop = new Set(c.words.map((w) => w.toLowerCase()))
    const next = words.filter((w) => !drop.has(w.toLowerCase()))
    const n = words.length - next.length
    if (!n) return { reply: '등록되지 않은 금지어예요.' }
    return { patch: { cover: { words: next } }, reply: `금지어 ${n}개를 삭제했어요. 지금 ${next.length}개예요.`, log: `금지어 ${n}개 삭제` }
  }
  return { reply: '' }
}

export const SAVE_FAIL_REPLY = '설정을 저장하지 못했어요. 잠시 뒤 다시 입력해 주세요.'

/**
 * patch 를 저장된 설정(JSON, 모르는 칸 포함)에 합친다. 절이 없으면 만든다. 원본은 바꾸지 않는다.
 * 패널이 저장한 다른 칸·이 버전이 모르는 칸은 그대로 둔다.
 */
export function applyPatch(raw, patch) {
  const base = raw && typeof raw === 'object' && !Array.isArray(raw) ? JSON.parse(JSON.stringify(raw)) : {}
  for (const [sec, vals] of Object.entries(patch || {})) {
    const cur = base[sec] && typeof base[sec] === 'object' && !Array.isArray(base[sec]) ? base[sec] : {}
    base[sec] = Object.assign({}, cur, vals)
  }
  return base
}

/** 방장·부방장이 방 관리 기능이 아직 동작하지 않는 방(부방장 지정 대기)에서 방 관리 명령어를 썼을 때 */
export function notLiveReply(nick) {
  const n = clean(nick, 40)
  return `방 관리 명령어는 K bot이 부방장이 된 뒤에 쓸 수 있어요. 방장님이 ${n ? `「${n}」${josa(n, '을')}` : 'K bot을'} 부방장으로 지정해 주세요.`
}
