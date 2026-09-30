import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const BASE = 0xac00
const LAST = 0xd7a3
const CHO_N = 2
const CHO_R = 5
const CHO_O = 11
const YI = new Set([2, 3, 6, 7, 12, 17, 20])

const LIST = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../data/words.json'), 'utf8'),
)
const SET = new Set(LIST)

function syllable(c) {
  const n = c.codePointAt(0)
  return n >= BASE && n <= LAST
}

function cho(c) {
  return Math.floor((c.codePointAt(0) - BASE) / 588)
}
function jung(c) {
  return Math.floor(((c.codePointAt(0) - BASE) % 588) / 28)
}
function jong(c) {
  return (c.codePointAt(0) - BASE) % 28
}
function make(ch, ju, jo) {
  return String.fromCodePoint(BASE + (ch * 21 + ju) * 28 + jo)
}
function isYi(ju) {
  return YI.has(ju)
}

export function hangul(w) {
  if (!w) return false
  for (const ch of w) if (!syllable(ch)) return false
  return true
}

export function has(w) {
  return SET.has(String(w || '').trim())
}

export function size() {
  return LIST.length
}

export function tail(w) {
  const s = String(w || '').trim()
  return s.length ? s[s.length - 1] : ''
}

export function variants(c) {
  if (!c || !syllable(c)) return [c]
  const ch = cho(c)
  const ju = jung(c)
  const jo = jong(c)
  const yi = isYi(ju)
  if (ch === CHO_R || ch === CHO_N) {
    if (yi) return [make(CHO_R, ju, jo), make(CHO_N, ju, jo), make(CHO_O, ju, jo)]
    return [make(CHO_R, ju, jo), make(CHO_N, ju, jo)]
  }
  if (ch === CHO_O && yi) return [make(CHO_O, ju, jo), make(CHO_R, ju, jo), make(CHO_N, ju, jo)]
  return [c]
}

export function variantsText(c) {
  return variants(c).join(' / ')
}

export function linkable(prev, next) {
  const t = tail(prev)
  const h = String(next || '').trim()[0]
  if (!t || !h) return false
  return variants(t).includes(h)
}

function candidates(first, used) {
  const vs = new Set(variants(first))
  const out = []
  for (const w of LIST) {
    if (used && used.has(w)) continue
    if (vs.has(w[0])) out.push(w)
  }
  return out
}

function anyStarting(first, used) {
  return candidates(first, used).length > 0
}

export function startWord(used) {
  if (!LIST.length) return null
  for (let i = 0; i < 60; i++) {
    const w = LIST[Math.floor(Math.random() * LIST.length)]
    if (used && used.has(w)) continue
    if (anyStarting(tail(w), used)) return w
  }
  return LIST[Math.floor(Math.random() * LIST.length)]
}

export function nextStarting(first, used) {
  const cand = candidates(first, used)
  if (!cand.length) return null
  for (let i = cand.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    const t = cand[i]
    cand[i] = cand[j]
    cand[j] = t
  }
  for (const w of cand) {
    const after = new Set(used || [])
    after.add(w)
    if (anyStarting(tail(w), after)) return w
  }
  return cand[0]
}
