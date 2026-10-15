// 봇이 방에 보내는 이미지(로그 카드 · 게임 그림). SVG 를 그려 PNG 로 바꾼다(@resvg/resvg-js, 글꼴은 assets/fonts 의 Pretendard).
// Pretendard 에 없는 글자(꾸민 닉네임의 특수문자·이모지 등)는 glyphs.mjs 가 고른 대체 글꼴로 그린다.
// 카카오톡·LOCO 와 상관없는 순수 모듈 — 같은 입력이면 같은 그림. 렌더러를 못 불러오면 available() 이 false 이고,
// 부르는 쪽은 글로 대신 보낸다(이미지가 안 돼도 안내는 빠지지 않는다).
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { glyphPlanner, isDropped } from './glyphs.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const FONT_DIR = join(HERE, '..', 'assets', 'fonts')
export const FONT = 'Pretendard'
const planGlyphs = glyphPlanner(FONT_DIR, ['Pretendard-Regular.otf', 'Pretendard-Bold.otf'])

let Resvg = null
let loadError = ''
try {
  Resvg = createRequire(import.meta.url)('@resvg/resvg-js').Resvg
} catch (e) {
  loadError = String((e && e.message) || e).slice(0, 200)
}

/** 이미지를 만들 수 있나(렌더러를 불러왔나) */
export function available() {
  return !!Resvg
}

export function unavailableReason() {
  return loadError
}

/** SVG 글 → PNG Buffer. 실패하면 null(부르는 쪽이 글로 대신 보낸다) */
export function svgToPng(svg, width) {
  if (!Resvg) return null
  try {
    const p = planGlyphs(svg)
    const opts = { font: { fontFiles: p.files, loadSystemFonts: false, defaultFontFamily: FONT } }
    if (width) opts.fitTo = { mode: 'width', value: width }
    return new Resvg(p.svg, opts).render().asPng()
  } catch {
    return null
  }
}

/** SVG 글자·속성 안에 넣을 값 */
export function esc(s) {
  return String(s == null ? '' : s)
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')
}

// 글자 폭 어림(Pretendard, em 단위). 렌더러가 재는 함수를 주지 않아 줄바꿈·말줄임에 쓴다(조금 넉넉하게)
function charEm(ch, bold) {
  const c = ch.codePointAt(0)
  let w
  if ((c >= 0xac00 && c <= 0xd7a3) || (c >= 0x3130 && c <= 0x318f) || (c >= 0x4e00 && c <= 0x9fff) || (c >= 0x3000 && c <= 0x30ff) || (c >= 0xff00 && c <= 0xffef)) w = 0.93
  else if (ch === ' ') w = 0.26
  else if (/[il.,:;'|!]/.test(ch)) w = 0.28
  else if (/[mwMW@]/.test(ch)) w = 0.86
  else if (/[A-Z0-9]/.test(ch)) w = 0.64
  else if (c < 0x80) w = 0.54
  else if (isDropped(c)) w = 0
  else if (c >= 0xa980 && c <= 0xa9df) w = 1.9 // 자바 문자(꧁ ꧂)는 넓다
  else if (c >= 0x1d400 && c <= 0x1d7ff) w = 0.8 // 수학 문자(𝓚 𝐀)
  else if ((c >= 0x1f000 && c <= 0x1faff) || (c >= 0x13000 && c <= 0x1342f)) w = 1.15 // 이모지 · 상형 문자
  else w = 1.0
  return bold ? w * 1.04 : w
}

/** 글 한 줄의 어림 폭(px) */
export function textWidth(s, size, bold) {
  let em = 0
  for (const ch of String(s == null ? '' : s)) em += charEm(ch, bold)
  return em * size
}

/** maxW 를 넘으면 뒤를 잘라 … 를 붙인다 */
export function ellipsis(s, size, maxW, bold) {
  const t = String(s == null ? '' : s)
  if (textWidth(t, size, bold) <= maxW) return t
  let out = ''
  for (const ch of t) {
    if (textWidth(out + ch + '…', size, bold) > maxW) break
    out += ch
  }
  return out + '…'
}

/** 줄바꿈: maxW 안에 들게 낱말(공백) 단위로, 낱말이 너무 길면 글자 단위로 자른다. 최대 maxLines 줄(넘으면 마지막 줄 …) */
export function wrap(s, size, maxW, maxLines, bold) {
  const lines = []
  for (const para of String(s == null ? '' : s).split('\n')) {
    let cur = ''
    for (const word of para.split(/(\s+)/)) {
      if (!word) continue
      if (textWidth(cur + word, size, bold) <= maxW) { cur += word; continue }
      if (cur.trim()) lines.push(cur.trimEnd())
      cur = word.trimStart()
      while (textWidth(cur, size, bold) > maxW) {
        let cut = ''
        for (const ch of cur) {
          if (textWidth(cut + ch, size, bold) > maxW) break
          cut += ch
        }
        if (!cut) break
        lines.push(cut)
        cur = cur.slice(cut.length)
      }
    }
    lines.push(cur.trimEnd())
  }
  const max = Math.max(1, Number(maxLines) || lines.length)
  if (lines.length > max) {
    const kept = lines.slice(0, max)
    kept[max - 1] = ellipsis(kept[max - 1] + ' ' + lines[max], size, maxW, bold)
    return kept
  }
  return lines
}
