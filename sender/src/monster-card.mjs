// 몬스터 수집 게임의 그림(발견·포획 카드, 도감, 내 몬스터, 몬스터 정보, 배틀 결과).
// 순수 함수: 같은 입력이면 같은 SVG. PNG 는 card.mjs 의 svgToPng 로 만든다(못 만들면 null → 글로 대신 보낸다).
import { esc, ellipsis, wrap, svgToPng, FONT } from './card.mjs'
import { ELEMENTS, RARITIES, SPECIES, COMMON_PAL } from './monster-data.mjs'
import { josa } from './roomfeat.mjs'

const BYID = new Map(SPECIES.map((s) => [s.id, s]))
const ELS = new Map(ELEMENTS.map((e) => [e.id, e]))
const RAR = new Map(RARITIES.map((r) => [r.id, r]))
export const GRID = 18 // 16칸 그림 + 둘레 테두리 1칸씩

const INK = '#1F2430'
const SUB = '#6B7280'
const LINE = '#E5E7EB'
const PAPER = '#FFFFFF'

function hex(c) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(c || ''))
  const n = m ? parseInt(m[1], 16) : 0
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}
function toHex(rgb) {
  return '#' + rgb.map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('').toUpperCase()
}
function mix(a, b, t) {
  const x = hex(a)
  const y = hex(b)
  return toHex(x.map((v, i) => v + (y[i] - v) * t))
}

// 빛나는 몬스터(희귀 색): 몸 색의 색상(hue)을 돌리고 조금 더 선명하게. 눈(k)·반짝임(w)은 그대로 둔다.
export const SHINY_HUE = 150
const SHINY_GOLD = '#F5B400'
function rgbToHsl(rgb) {
  const [r, g, b] = rgb.map((v) => v / 255)
  const mx = Math.max(r, g, b)
  const mn = Math.min(r, g, b)
  const l = (mx + mn) / 2
  if (mx === mn) return [0, 0, l]
  const d = mx - mn
  const s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn)
  const h = mx === r ? (g - b) / d + (g < b ? 6 : 0) : mx === g ? (b - r) / d + 2 : (r - g) / d + 4
  return [h * 60, s, l]
}
function hslToRgb([h, s, l]) {
  const c = (1 - Math.abs(2 * l - 1)) * s
  const hh = (((h % 360) + 360) % 360) / 60
  const x = c * (1 - Math.abs((hh % 2) - 1))
  const [r, g, b] = hh < 1 ? [c, x, 0] : hh < 2 ? [x, c, 0] : hh < 3 ? [0, c, x] : hh < 4 ? [0, x, c] : hh < 5 ? [x, 0, c] : [c, 0, x]
  const m = l - c / 2
  return [(r + m) * 255, (g + m) * 255, (b + m) * 255]
}
export function shinyColor(c) {
  const [h, s, l] = rgbToHsl(hex(c))
  if (s < 0.08) return toHex(hex(c)) // 회색·흰색은 그대로
  return toHex(hslToRgb([h + SHINY_HUE, Math.min(1, s * 1.1 + 0.05), l]))
}

// 16×16 글자 그림 → 18×18 색 칸(가운데 맞춤 + 자동 테두리). 결과는 몬스터(·빛나는 색)마다 한 번만 만든다.
const cellCache = new Map()
export function cells(sp, shiny) {
  const ck = shiny ? 's' + sp.id : sp.id
  if (cellCache.has(ck)) return cellCache.get(ck)
  const pal = Object.assign({}, COMMON_PAL, sp.pal || {})
  if (shiny) for (const k of Object.keys(pal)) if (k !== 'k' && k !== 'w') pal[k] = shinyColor(pal[k])
  const rows = (sp.px || []).map((r) => String(r).padEnd(16, '.').slice(0, 16))
  while (rows.length < 16) rows.push('.'.repeat(16))
  let x0 = 16, x1 = -1, y0 = 16, y1 = -1
  rows.forEach((r, y) => {
    for (let x = 0; x < 16; x++) {
      if (r[x] === '.') continue
      if (x < x0) x0 = x
      if (x > x1) x1 = x
      if (y < y0) y0 = y
      if (y > y1) y1 = y
    }
  })
  const dx = x1 < 0 ? 0 : Math.floor((16 - (x1 - x0 + 1)) / 2) - x0
  const dy = y1 < 0 ? 0 : Math.floor((16 - (y1 - y0 + 1)) / 2) - y0
  const g = Array.from({ length: GRID }, () => new Array(GRID).fill(null))
  rows.forEach((r, y) => {
    for (let x = 0; x < 16; x++) {
      const ch = r[x]
      if (ch === '.') continue
      g[y + dy + 1][x + dx + 1] = pal[ch] || '#FF00FF'
    }
  })
  const outline = sp.ol || mix(pal.b || pal.a || '#888888', '#1B1530', 0.62)
  const out = g.map((row) => row.slice())
  for (let y = 0; y < GRID; y++) {
    for (let x = 0; x < GRID; x++) {
      if (g[y][x]) continue
      const near = (g[y - 1] && g[y - 1][x]) || (g[y + 1] && g[y + 1][x]) || g[y][x - 1] || g[y][x + 1]
      if (near) out[y][x] = outline
    }
  }
  cellCache.set(ck, out)
  return out
}

/**
 * 몬스터 그림 SVG 조각. mode: 'color'(기본) · 'shiny'(빛나는 색) · 'shadow'(본 적만 있음, 검은 그림자)
 * size 는 그림 한 변(px). 칸 크기는 정수로 맞춰 점이 흐려지지 않게 한다.
 */
export function sprite(sp, x, y, size, mode) {
  const g = cells(sp, mode === 'shiny')
  const s = Math.max(1, Math.floor(size / GRID))
  const ox = Math.round(x + (size - s * GRID) / 2)
  const oy = Math.round(y + (size - s * GRID) / 2)
  const parts = []
  for (let r = 0; r < GRID; r++) {
    let c = 0
    while (c < GRID) {
      let col = g[r][c]
      if (!col) { c++; continue }
      if (mode === 'shadow') col = '#3B3F4E'
      let e = c + 1
      while (e < GRID && g[r][e] && (mode === 'shadow' || g[r][e] === g[r][c])) e++
      parts.push(`<rect x="${ox + c * s}" y="${oy + r * s}" width="${(e - c) * s}" height="${s}" fill="${col}"/>`)
      c = e
    }
  }
  return `<g shape-rendering="crispEdges">${parts.join('')}</g>`
}

export function speciesOf(id) {
  return BYID.get(Number(id)) || null
}
export function elementOf(id) {
  return ELS.get(id) || ELEMENTS[0]
}
export function rarityOf(id) {
  return RAR.get(Number(id)) || RARITIES[0]
}

// ── 공통 조각 ──────────────────────────────────────────────────────────────
function text(x, y, s, size, opt) {
  const o = opt || {}
  const w = o.bold ? 700 : 400
  const anchor = o.anchor ? ` text-anchor="${o.anchor}"` : ''
  const fill = o.fill || INK
  const body = o.max ? ellipsis(s, size, o.max, !!o.bold) : String(s == null ? '' : s)
  return `<text x="${x}" y="${y}" font-family="${FONT}" font-size="${size}" font-weight="${w}" fill="${fill}"${anchor}>${esc(body)}</text>`
}

function chip(x, y, label, color, opt) {
  const o = opt || {}
  const size = o.size || 15
  const padX = Math.round(size * 0.7)
  const h = Math.round(size * 1.75)
  const w = Math.round(labelWidth(label, size) + padX * 2)
  const fill = o.solid ? color : mix(color, '#FFFFFF', 0.86)
  const ink = o.solid ? '#FFFFFF' : mix(color, '#000000', 0.25)
  return {
    w,
    svg: `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${h / 2}" fill="${fill}"/>` +
      text(x + w / 2, y + h / 2 + size * 0.36, label, size, { bold: true, fill: ink, anchor: 'middle' }),
  }
}

function labelWidth(s, size) {
  let em = 0
  for (const ch of String(s)) {
    const c = ch.codePointAt(0)
    em += c >= 0xac00 && c <= 0xd7a3 ? 0.93 : ch === ' ' ? 0.26 : c < 0x80 ? 0.56 : 1
  }
  return em * size * 1.04
}

function chips(x, y, list, size) {
  let cx = x
  let out = ''
  for (const it of list) {
    const c = chip(cx, y, it.label, it.color, { size, solid: it.solid })
    out += c.svg
    cx += c.w + 8
  }
  return { svg: out, w: cx - x - 8 }
}

function bar(x, y, w, h, ratio, color, track) {
  const r = Math.max(0, Math.min(1, Number(ratio) || 0))
  const fw = Math.max(r > 0 ? h : 0, Math.round(w * r))
  return `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${h / 2}" fill="${track || '#EEF0F4'}"/>` +
    (fw ? `<rect x="${x}" y="${y}" width="${fw}" height="${h}" rx="${h / 2}" fill="${color}"/>` : '')
}

function frame(w, h, bg, inner) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">` +
    `<rect width="${w}" height="${h}" fill="${bg}"/>${inner}</svg>`
}

// 별가루 무늬(배경 장식) — 자리는 고정(같은 그림)
function sparkles(w, h, color, n, seed) {
  let s = (seed || 7) >>> 0
  const rnd = () => {
    s = (s * 1103515245 + 12345) >>> 0
    return (s >>> 8) / 16777216
  }
  let out = ''
  for (let i = 0; i < n; i++) {
    const x = Math.round(rnd() * w)
    const y = Math.round(rnd() * h)
    const k = 2 + Math.round(rnd() * 3)
    out += `<rect x="${x}" y="${y}" width="${k}" height="${k}" fill="${color}" opacity="0.55"/>`
  }
  return out
}

// 네 갈래 반짝이 별(가운데 cx, cy · 반지름 r)
function star4(cx, cy, r, color, op) {
  const k = r * 0.28
  const pts = [[cx, cy - r], [cx + k, cy - k], [cx + r, cy], [cx + k, cy + k], [cx, cy + r], [cx - k, cy + k], [cx - r, cy], [cx - k, cy - k]]
  return `<polygon points="${pts.map((q) => q.map((v) => Math.round(v * 10) / 10).join(',')).join(' ')}" fill="${color}"${op != null ? ` opacity="${op}"` : ''}/>`
}

// 빛나는 몬스터 둘레: 금빛 후광(방사 그라데이션) + 반짝이 별. 자리는 고정(같은 그림)
function shineAura(cx, cy, r, id) {
  const gid = 'shine' + id
  let out = `<defs><radialGradient id="${gid}" cx="50%" cy="50%" r="50%">` +
    `<stop offset="0%" stop-color="#FFF8D6" stop-opacity="1"/><stop offset="62%" stop-color="#FFE38A" stop-opacity="0.9"/>` +
    `<stop offset="100%" stop-color="${SHINY_GOLD}" stop-opacity="0"/></radialGradient></defs>` +
    `<circle cx="${cx}" cy="${cy}" r="${Math.round(r * 1.22)}" fill="url(#${gid})"/>`
  const spots = [[-0.86, -0.62, 0.2], [0.9, -0.48, 0.15], [0.72, 0.78, 0.12], [-0.8, 0.66, 0.1], [0.12, -1.04, 0.1], [1.06, 0.14, 0.08]]
  for (const [dx, dy, k] of spots) out += star4(cx + dx * r, cy + dy * r, Math.max(5, r * k), '#FFFFFF') + star4(cx + dx * r, cy + dy * r, Math.max(3, r * k * 0.6), SHINY_GOLD)
  return out
}

/** 몬스터 그림 판(뒤 원 + 그림 + 바닥 그림자) */
// mode: 'color' · 'shadow'(못 잡은 몬스터) · 'faded'(배틀에서 진 몬스터, 흐리게). 영웅·전설은 등급 색 테두리를 두른다.
// shiny 면 빛나는 색 그림에 금빛 후광·반짝이 별·금색 테두리.
function stage(sp, cx, cy, size, mode, shiny) {
  const el = elementOf(sp.el)
  const r = Math.round(size * 0.6)
  const shown = mode !== 'shadow'
  const glow = shown && !!shiny
  const ringColor = glow ? SHINY_GOLD : sp.r >= 3 ? rarityOf(sp.r).color : ''
  const ring = shown && ringColor ? ` stroke="${ringColor}" stroke-width="${Math.max(3, Math.round(size / (glow ? 34 : 42)))}"` : ''
  const body = sprite(sp, cx - size / 2, cy - size / 2, size, mode === 'shadow' ? 'shadow' : glow ? 'shiny' : 'color')
  const disc = glow ? '#FFF6D8' : shown ? mix(el.color, '#FFFFFF', 0.8) : '#ECEEF3'
  return (glow ? shineAura(cx, cy, r, `${Math.round(cx)}_${Math.round(cy)}`) : '') +
    `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${disc}"${ring}/>` +
    `<ellipse cx="${cx}" cy="${cy + size * 0.44}" rx="${size * 0.32}" ry="${size * 0.06}" fill="#000000" opacity="0.10"/>` +
    (mode === 'faded' ? `<g opacity="0.45">${body}</g>` : body) +
    (glow && mode !== 'faded' ? star4(cx + r * 0.52, cy - r * 0.6, Math.max(6, r * 0.12), '#FFFFFF', 0.95) : '')
}

export function png(svg) {
  return svgToPng(svg)
}

export { mix, text, chip, chips, bar, frame, sparkles, stage, star4 }

// ── 카드 ──────────────────────────────────────────────────────────────────
const W = 720
const NET_NAMES = ['그물', '별그물', '황금그물']

function shell(h, el, inner, label) {
  const e = elementOf(el)
  const bg = mix(e.color, '#FFFFFF', 0.72)
  return frame(W, h, bg,
    sparkles(W, h, '#FFFFFF', 46, h + W) +
    `<rect x="16" y="16" width="${W - 32}" height="${h - 32}" rx="28" fill="${PAPER}"/>` +
    text(44, 62, label, 19, { bold: true, fill: SUB, max: 420 }) +
    text(W - 44, 62, '몬스터 수집', 17, { bold: true, fill: e.color, anchor: 'end' }) +
    `<rect x="44" y="78" width="${W - 88}" height="2" rx="1" fill="${LINE}"/>` +
    inner)
}

function badges(sp, lv, shiny) {
  const e = elementOf(sp.el)
  const r = rarityOf(sp.r)
  const list = []
  if (lv) list.push({ label: 'Lv.' + lv, color: '#1F2430', solid: true })
  if (shiny) list.push({ label: '빛나는', color: '#D99A00', solid: true })
  list.push({ label: e.name, color: e.color })
  list.push({ label: r.name, color: r.color, solid: sp.r >= 3 })
  return list
}

function netsLine(nets) {
  return (nets || [0, 0, 0]).map((n, i) => `${NET_NAMES[i]} ${n}`).join(' · ')
}

function encounterSvg(c) {
  const sp = speciesOf(c.sid)
  const h = 440
  let s = stage(sp, 196, 252, 252, 'color', c.shiny)
  const x = 372
  s += text(x, 128, c.shiny ? '빛나는 몬스터가 나타났어요' : '야생 몬스터가 나타났어요', 19, { fill: c.shiny ? '#B7791F' : SUB, bold: !!c.shiny })
  s += text(x, 178, sp.name, 44, { bold: true, max: W - x - 48 })
  s += chips(x, 196, badges(sp, c.lv, c.shiny), 16).svg
  const status = c.dex === '2' ? '도감에 있는 몬스터예요' : c.dex === '1' ? '전에 본 적 있는 몬스터예요' : '처음 보는 몬스터예요'
  s += text(x, 266, status, 18, { bold: true, fill: c.dex === '2' ? SUB : elementOf(sp.el).color })
  wrap(sp.d, 17, W - x - 52, 2).forEach((ln, i) => { s += text(x, 298 + i * 25, ln, 17, { fill: '#4B5563' }) })
  s += `<rect x="${x - 8}" y="352" width="${W - x - 36}" height="58" rx="16" fill="#F4F5F8"/>`
  s += text(x + 10, 377, `「${c.prefix || '!'}포획」으로 잡아 보세요`, 18, { bold: true })
  s += text(x + 10, 400, netsLine(c.nets), 15, { fill: SUB, max: W - x - 56 })
  if (c.pity) s += text(W - 54, 377, `보정 +${c.pity}%`, 15, { bold: true, fill: '#3D8FD9', anchor: 'end' })
  if (c.bonus) {
    const label = (c.streak > 1 ? `${c.streak}일 연속 · ` : '출석 보상 ') + `그물 +${c.bonus}` + (c.gold ? ' · 황금그물 +1' : '')
    s += chip(44, 96, label, c.gold ? '#D99A00' : '#2FAE8A', { size: 14, solid: !!c.gold }).svg
  }
  return shell(h, sp.el, s, `탐험 · ${c.owner}님`)
}

function catchSvg(c) {
  const sp = speciesOf(c.sid)
  const h = c.lead && c.lead.evolved ? 500 : 450
  let s = stage(sp, 196, 256, 252, 'color', c.shiny)
  const x = 372
  const ok = chip(x, 104, '포획 성공', '#22A06B', { size: 16, solid: true })
  s += ok.svg
  if (c.pity) s += chip(x + ok.w + 8, 106, `실패 보정 +${c.pity}%`, '#3D8FD9', { size: 14 }).svg
  if (c.roomFirst) s += chip(44, 96, '방 최초 발견', '#E5484D', { size: 15, solid: true }).svg
  s += text(x, 186, sp.name, 44, { bold: true, max: W - x - 48 })
  s += chips(x, 204, badges(sp, c.lv, c.shiny), 16).svg
  let y = 274
  s += text(x, y, `보관함 ${c.no}번에 넣었어요`, 18, { bold: true })
  y += 30
  s += text(x, y, c.fresh ? `도감에 새로 올렸어요 · ${c.dex}/${c.total}종` : `도감 ${c.dex}/${c.total}종`, 17, { bold: !!c.fresh, fill: c.fresh ? elementOf(sp.el).color : SUB })
  y += 28
  s += text(x, y, `코인 +${c.coin}`, 17, { fill: '#B7791F', bold: true })
  y += 24
  if (c.first) {
    s += `<rect x="${x - 8}" y="${y}" width="${W - x - 36}" height="50" rx="16" fill="#F4F5F8"/>`
    s += text(x + 10, y + 32, '첫 몬스터라서 대표로 정했어요', 17, { bold: true })
  } else if (c.lead) {
    const ls = speciesOf(c.lead.evolved ? c.lead.evolved[0] : c.lead.sid)
    const boxH = c.lead.evolved ? 104 : 54
    s += `<rect x="${x - 8}" y="${y}" width="${W - x - 36}" height="${boxH}" rx="16" fill="#F4F5F8"/>`
    s += sprite(ls, x, y + 7, 40, 'color')
    s += text(x + 50, y + 25, `대표 ${ls.name}`, 16, { bold: true, max: 200 })
    s += text(x + 50, y + 45, c.lead.gain ? `경험치 +${c.lead.gain}` + (c.lead.up ? ` · Lv.${c.lead.lv}` : '') : '이미 최고 레벨이에요', 15, { fill: SUB })
    if (c.lead.evolved) {
      const ns = speciesOf(c.lead.evolved[1])
      s += sprite(ns, x, y + 56, 40, 'color')
      s += text(x + 50, y + 82, `${ns.name}${josa(ns.name, '으로')} 진화했어요`, 16, { bold: true, fill: elementOf(ns.el).color, max: 240 })
    }
  }
  return shell(h, sp.el, s, `포획 · ${c.owner}님`)
}

function dexSvg(c) {
  const cols = 7
  const cw = 92
  const ch = 112
  const ox = 34
  const oy = 152
  const n = SPECIES.length
  const rows = Math.ceil(n / cols)
  const h = oy + rows * ch + 34
  const dx = String(c.dx || '')
  const caught = SPECIES.filter((s) => dx[s.id - 1] === '2').length
  let s = text(44, 122, `${caught}/${n}종`, 30, { bold: true })
  s += bar(170, 106, W - 214, 14, caught / n, '#7B61E0')
  SPECIES.forEach((sp, i) => {
    const x = ox + (i % cols) * cw + 6
    const y = oy + Math.floor(i / cols) * ch
    const st = dx[sp.id - 1] || '0'
    const e = elementOf(sp.el)
    s += `<rect x="${x}" y="${y}" width="${cw - 8}" height="${ch - 10}" rx="14" fill="${st === '2' ? mix(e.color, '#FFFFFF', 0.85) : '#F3F4F6'}"/>`
    s += text(x + 8, y + 18, 'No.' + sp.id, 11, { bold: true, fill: st === '2' ? e.color : '#9CA3AF' })
    if (st === '0') s += text(x + (cw - 8) / 2, y + 64, '?', 30, { bold: true, fill: '#C4C8D0', anchor: 'middle' })
    else s += sprite(sp, x + (cw - 8 - 54) / 2, y + 20, 54, st === '2' ? 'color' : 'shadow')
    s += text(x + (cw - 8) / 2, y + 92, st === '0' ? '???' : sp.name, 13, { bold: st === '2', fill: st === '2' ? INK : '#9CA3AF', anchor: 'middle', max: cw - 14 })
  })
  return shell(h, 'star', s, `도감 · ${c.owner}님`)
}

function boxSvg(c) {
  const mons = c.mons || []
  const cols = 5
  const cw = 128
  const ch = 132
  const ox = 40
  const oy = 132
  const rows = Math.max(1, Math.ceil(mons.length / cols))
  const h = oy + rows * ch + 30
  let s = text(44, 114, `${mons.length}/30마리 · 도감 ${c.dex}/${c.total}종 · 코인 ${c.coins}개`, 18, { bold: true })
  if (c.nets) s += text(W - 44, 114, netsLine(c.nets), 14, { fill: SUB, anchor: 'end' })
  mons.forEach((m, i) => {
    const sp = speciesOf(m.sid)
    const e = elementOf(sp.el)
    const x = ox + (i % cols) * cw
    const y = oy + Math.floor(i / cols) * ch
    s += `<rect x="${x}" y="${y}" width="${cw - 10}" height="${ch - 12}" rx="16" fill="${mix(e.color, '#FFFFFF', 0.86)}"${m.lead ? ` stroke="${e.color}" stroke-width="3"` : ''}/>`
    s += `<circle cx="${x + 18}" cy="${y + 18}" r="12" fill="${m.lead ? e.color : '#FFFFFF'}"/>`
    s += text(x + 18, y + 23, String(m.no), 13, { bold: true, fill: m.lead ? '#FFFFFF' : INK, anchor: 'middle' })
    if (m.lead) s += text(x + cw - 20, y + 23, '대표', 12, { bold: true, fill: e.color, anchor: 'end' })
    if (m.shiny) s += `<circle cx="${x + (cw - 10) / 2}" cy="${y + 50}" r="36" fill="#FFF3C4"/>`
    s += sprite(sp, x + (cw - 10 - 64) / 2, y + 18, 64, m.shiny ? 'shiny' : 'color')
    if (m.shiny) s += star4(x + cw - 26, y + 42, 8, SHINY_GOLD)
    s += text(x + (cw - 10) / 2, y + 98, sp.name, 14, { bold: true, anchor: 'middle', max: cw - 20, fill: m.shiny ? '#B7791F' : INK })
    s += text(x + (cw - 10) / 2, y + 114, 'Lv.' + m.lv, 12, { fill: SUB, anchor: 'middle' })
  })
  return shell(h, mons[0] ? speciesOf(mons[0].sid).el : 'sun', s, `내 몬스터 · ${c.owner}님`)
}

const STAT_LABELS = [['hp', '체력'], ['atk', '공격'], ['def', '방어'], ['spd', '속도']]
const STAT_TOP = { hp: 600, atk: 300, def: 300, spd: 300 }

function infoSvg(c) {
  const sp = speciesOf(c.sid)
  const e = elementOf(sp.el)
  const m = c.mon
  const h = m ? 520 : 470
  const shiny = !!(m && m.shiny)
  let s = stage(sp, 196, 262, 252, c.caught ? 'color' : 'shadow', shiny)
  const x = 372
  s += text(x, 128, m ? `${m.no}번 몬스터${m.lead ? ' · 대표' : ''}` : `No.${sp.id}`, 18, { fill: SUB, bold: true })
  s += text(x, 176, sp.name, 42, { bold: true, max: W - x - 48 })
  s += chips(x, 194, badges(sp, m ? m.lv : 0, shiny), 16).svg
  let y = 262
  if (m) {
    for (const [k, label] of STAT_LABELS) {
      s += text(x, y + 6, label, 15, { bold: true, fill: SUB })
      s += bar(x + 46, y - 6, 206, 12, m.stats[k] / STAT_TOP[k], e.color)
      s += text(W - 48, y + 6, String(m.stats[k]), 15, { bold: true, anchor: 'end' })
      y += 28
    }
    s += text(x, y + 6, '경험치', 15, { bold: true, fill: SUB })
    s += bar(x + 58, y - 6, 194, 12, m.need ? m.xp / m.need : 1, '#F5A623')
    s += text(W - 48, y + 6, m.need ? `${m.xp}/${m.need}` : '최고', 15, { bold: true, anchor: 'end' })
    y += 40
  } else {
    wrap(sp.d, 17, W - x - 52, 3).forEach((ln, i) => { s += text(x, y + i * 25, ln, 17, { fill: '#4B5563' }) })
    y += 90
  }
  s += text(x, y, `기술 : ${sp.mv}`, 16, { bold: true, max: W - x - 48 })
  y += 26
  if (sp.evo) {
    const to = speciesOf(sp.evo.to)
    s += text(x, y, `Lv.${sp.evo.lv}에 ${to.name}${josa(to.name, '으로')} 진화해요`, 15, { fill: SUB, max: W - x - 48 })
  } else {
    s += text(x, y, '더 진화하지 않아요', 15, { fill: SUB })
  }
  if (m) s += text(W / 2, h - 42, sp.d, 16, { fill: '#4B5563', anchor: 'middle', max: W - 100 })
  return shell(h, sp.el, s, m ? `몬스터 정보 · ${c.owner}님` : `도감 · ${c.owner}님`)
}

function battleSvg(c) {
  const lines = c.lines || []
  const rw = c.rewards || []
  const logH = lines.length * 26 + 22
  const h = 424 + logH + 24 + rw.length * 26 + 30
  const sides = [c.a, c.b]
  let s = ''
  sides.forEach((p, i) => {
    const sp = speciesOf(p.sid)
    const cx = i === 0 ? 180 : W - 180
    const won = c.win === i
    s += stage(sp, cx, 206, 162, won ? 'color' : 'faded', p.shiny)
    if (won) s += chip(cx - 30, 98, '승리', '#E8A317', { size: 16, solid: true }).svg
    s += text(cx, 328, `${p.owner}님`, 15, { fill: SUB, anchor: 'middle', max: 260 })
    s += text(cx, 352, `${p.shiny ? '빛나는 ' : ''}${sp.name} Lv.${p.lv}`, 19, { bold: true, anchor: 'middle', max: 260 })
    const ratio = p.max ? p.hp / p.max : 0
    s += bar(cx - 100, 366, 200, 12, ratio, ratio > 0.5 ? '#22A06B' : ratio > 0.2 ? '#F5A623' : '#E5484D')
    s += text(cx, 398, `체력 ${p.hp}/${p.max}`, 13, { fill: SUB, anchor: 'middle' })
  })
  s += text(W / 2, 218, 'VS', 34, { bold: true, fill: '#C4C8D0', anchor: 'middle' })
  let y = 424
  s += `<rect x="44" y="${y}" width="${W - 88}" height="${logH}" rx="16" fill="#F4F5F8"/>`
  lines.forEach((ln, i) => { s += text(64, y + 30 + i * 26, ln, 15, { fill: '#374151', max: W - 128 }) })
  y += logH + 30
  rw.forEach((r, i) => {
    const who = sides[r.who]
    const t = r.done ? `${who.owner}님 오늘 배틀 보상은 모두 받았어요`
      : `${who.owner}님 코인 +${r.coins} · 경험치 +${r.exp}${r.up ? ` · Lv.${r.lv}` : ''}` +
        (r.evolved ? ` · ${speciesOf(r.evolved[1]).name}${josa(speciesOf(r.evolved[1]).name, '으로')} 진화` : '')
    s += text(44, y + i * 26, t, 15, { bold: i === 0, fill: i === 0 ? INK : SUB, max: W - 88 })
  })
  return shell(h, speciesOf(sides[c.win].sid).el, s, `배틀 · ${c.a.owner}님 vs ${c.b.owner}님`)
}

/** 카드 → SVG(알 수 없는 카드는 '') */
export function cardSvg(card) {
  if (!card || typeof card !== 'object') return ''
  if (card.kind === 'encounter') return encounterSvg(card)
  if (card.kind === 'catch') return catchSvg(card)
  if (card.kind === 'dex') return dexSvg(card)
  if (card.kind === 'box') return boxSvg(card)
  if (card.kind === 'info') return infoSvg(card)
  if (card.kind === 'battle') return battleSvg(card)
  return ''
}

/** 카드 → PNG Buffer | null(그릴 수 없으면 글로 대신 보낸다) */
export function cardPng(card) {
  try {
    const svg = cardSvg(card)
    return svg ? svgToPng(svg) : null
  } catch {
    return null
  }
}
