import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const Q = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../data/quiz.json'), 'utf8'),
)

export function size() {
  return Q.length
}

export function valid(i) {
  return Number.isInteger(i) && i >= 0 && i < Q.length
}

export function question(i) {
  return valid(i) ? Q[i].q : ''
}
export function answer(i) {
  return valid(i) ? Q[i].a : ''
}
export function hint(i) {
  return valid(i) ? Q[i].h : ''
}

export function norm(s) {
  if (!s) return ''
  let out = ''
  for (const c of String(s)) {
    if (/\s/.test(c)) continue
    if ('.!,?\'"·~-_()'.includes(c)) continue
    out += c
  }
  return out.toLowerCase()
}

export function correct(i, given) {
  if (!valid(i)) return false
  const a = norm(answer(i))
  const g = norm(given)
  if (!a || !g) return false
  if (a === g) return true
  if (g.length >= 2 && a.length > g.length && a.includes(g)) return true
  if (a.length >= 2 && g.length > a.length && g.includes(a)) return true
  return false
}

export function randomIndex(asked) {
  const left = []
  for (let i = 0; i < Q.length; i++) if (!asked || !asked.has(i)) left.push(i)
  const pool = left.length ? left : Q.map((_, i) => i)
  return pool[Math.floor(Math.random() * pool.length)]
}
