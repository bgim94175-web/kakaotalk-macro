// 「추억의 검 강화」 카드 그림(SVG → PNG). 검은 단계 묶음(tier)마다 그려 둔 그림(assets/swords/tier0~7.png)을 붙이고,
// 그림 파일이 없으면 이 파일에서 직접 그린 벡터 검으로 대신한다. 단계가 오를수록 빛(오라)과 반짝임이 늘어난다.
// 순수 모듈: 같은 카드 값이면 같은 SVG. PNG 는 card.mjs(resvg)가 만든다 — 못 만들면 null(부르는 쪽이 글로 보낸다).
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { svgToPng, esc, ellipsis, textWidth } from './card.mjs'
import { MAX_LV, tierOf, swordName, won, cost, chance } from './sword.mjs'

const F = "font-family=\"Pretendard\""

// 묶음별 색·모양. bl 날 길이, hw 날 반폭, gw 코등이 폭
const LOOK = [
  { shape: 'notched', guard: 'bar', bl: 226, hw: 17, gw: 50, gl: 64, blade: ['#c2b6a4', '#9a8b78', '#6c5f50', '#4a4036'], edge: '#d9cdb9', metal: ['#a08468', '#6e5642', '#463526'], grip: '#3a281b', wrap: '#6b4a32', gem: '', aura: '' },
  { shape: 'plain', guard: 'bar', bl: 250, hw: 18, gw: 58, gl: 66, blade: ['#ffffff', '#dfe5ec', '#9aa6b5', '#5f6b7b'], edge: '#ffffff', metal: ['#e3e8ef', '#9aa5b3', '#5b6573'], grip: '#2b3044', wrap: '#525a7a', gem: '#e0413a', aura: '#cfe0ff' },
  { shape: 'knight', guard: 'curve', bl: 262, hw: 19, gw: 70, gl: 68, blade: ['#ffffff', '#e6eefb', '#a9bbd8', '#61779e'], edge: '#ffffff', metal: ['#f3f6fb', '#b6c3d8', '#6d7d99'], grip: '#1e2b57', wrap: '#d6b25a', gem: '#3f86ff', aura: '#8db8ff' },
  { shape: 'crystal', guard: 'crystal', bl: 268, hw: 20, gw: 74, gl: 68, blade: ['#ffffff', '#c9f4ff', '#6fcdf0', '#2a86b8'], edge: '#f2fdff', metal: ['#e9fbff', '#8fdcf5', '#3b8fb8'], grip: '#16344f', wrap: '#8fdcf5', gem: '#68f4ff', aura: '#44d2ff' },
  { shape: 'wavy', guard: 'flame', bl: 270, hw: 21, gw: 76, gl: 68, blade: ['#fff6cf', '#ffc15a', '#f0612a', '#a8180f'], edge: '#ffe9a8', metal: ['#6b3a2c', '#3c201a', '#1e0f0c'], grip: '#2a1210', wrap: '#b8321c', gem: '#ff3a2a', aura: '#ff6a1f' },
  { shape: 'broad', guard: 'dragon', bl: 274, hw: 24, gw: 96, gl: 70, blade: ['#fffdf0', '#ffe48a', '#e3ad2c', '#9a6a0c'], edge: '#fffbe0', metal: ['#fff0b0', '#e6b23a', '#9a6a10'], grip: '#5a1717', wrap: '#e6b23a', gem: '#1fe08a', aura: '#ffcf3a' },
  { shape: 'jagged', guard: 'horn', bl: 278, hw: 22, gw: 88, gl: 70, blade: ['#c9b1ff', '#7f5bc4', '#43277a', '#170a2c'], edge: '#e9d9ff', metal: ['#6c5596', '#33234f', '#140b22'], grip: '#120818', wrap: '#7a52c0', gem: '#ff2f8f', aura: '#a24dff' },
  { shape: 'holy', guard: 'angel', bl: 284, hw: 22, gw: 112, gl: 70, blade: ['#ffffff', '#f2f9ff', '#bfe0ff', '#7fb2ee'], edge: '#ffffff', metal: ['#ffffff', '#ffe9a6', '#d2a23a'], grip: '#f4ecff', wrap: '#d9ae45', gem: '#ff7ad9', aura: '#fff2b8' },
]

export function lookOf(lv) {
  return LOOK[tierOf(lv)]
}

// 반복해도 같은 값이 나오는 작은 난수(반짝임 자리)
function lcg(seed) {
  let x = (Math.abs(Math.floor(Number(seed) || 1)) % 2147483646) + 1
  return () => {
    x = (x * 48271) % 2147483647
    return (x - 1) / 2147483646
  }
}

const r1 = (n) => Math.round(n * 10) / 10

// 묶음별 검 그림(세로, 끝이 위, 둘레는 투명). → { uri, w, h } 또는 null(파일이 없으면 벡터 검)
const ART_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'assets', 'swords')
const ART = Array.from({ length: 8 }, (_, i) => {
  try {
    const b = readFileSync(join(ART_DIR, `tier${i}.png`))
    if (b.length < 24 || b.toString('latin1', 12, 16) !== 'IHDR') return null
    return { uri: 'data:image/png;base64,' + b.toString('base64'), w: b.readUInt32BE(16), h: b.readUInt32BE(20) }
  } catch {
    return null
  }
})
const ART_MAX_H = Math.max(1, ...ART.map((a) => (a ? a.h : 0)))

/** 이 단계의 검 그림(없으면 null) */
export function artOf(lv) {
  return ART[tierOf(lv)] || null
}

/**
 * 그림 검을 (cx, cy) 가운데에 세운다. 높이는 묶음끼리 원래 비율대로(높은 단계가 더 크다), 가장 큰 검이 maxH.
 * opt.broken: 날 가운데가 갈라져 두 동강(빛을 뺀 잿빛)
 */
function artSword(A, cx, cy, maxH, id, opt) {
  const o = opt || {}
  const k = maxH / ART_MAX_H
  const w = r1(A.w * k)
  const h = r1(A.h * k)
  const x = r1(cx - w / 2)
  const y = r1(cy - h / 2)
  const img = `<image x="${x}" y="${y}" width="${w}" height="${h}" href="${A.uri}"/>`
  if (!o.broken) return { defs: '', body: img }
  // 날의 40% 높이에서 지그재그로 끊는다
  const cut = y + h * 0.4
  const zig = []
  for (let i = 0; i <= 8; i++) zig.push(`${r1(x - 4 + ((w + 8) * i) / 8)},${r1(cut + (i % 2 ? 7 : -7))}`)
  const top = `M${x - 4},${y - 4} L${r1(x + w + 4)},${y - 4} L${zig.slice().reverse().join(' L')} Z`
  const bot = `M${zig.join(' L')} L${r1(x + w + 4)},${r1(y + h + 4)} L${x - 4},${r1(y + h + 4)} Z`
  const defs = `<filter id="${id}g" x="-10%" y="-10%" width="120%" height="120%"><feColorMatrix type="saturate" values="0.1"/><feComponentTransfer><feFuncR type="linear" slope=".72"/><feFuncG type="linear" slope=".72"/><feFuncB type="linear" slope=".76"/></feComponentTransfer></filter>` +
    `<clipPath id="${id}t"><path d="${top}"/></clipPath><clipPath id="${id}b"><path d="${bot}"/></clipPath>`
  const body = `<g filter="url(#${id}g)">` +
    `<g transform="translate(-16,-6) rotate(-14 ${r1(cx)} ${r1(cut)})"><g clip-path="url(#${id}t)">${img}</g></g>` +
    `<g transform="translate(8,10) rotate(6 ${r1(cx)} ${r1(cut)})"><g clip-path="url(#${id}b)">${img}</g></g></g>`
  return { defs, body }
}
const pt = (p) => `${r1(p[0])},${r1(p[1])}`

// 매끈한 모서리(차이킨 2번). 처음·끝 점은 그대로
function smooth(points, times) {
  let pts = points
  for (let t = 0; t < (times || 2); t++) {
    const out = [pts[0]]
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i]
      const b = pts[i + 1]
      if (i > 0) out.push([a[0] * 0.75 + b[0] * 0.25, a[1] * 0.75 + b[1] * 0.25])
      if (i < pts.length - 2) out.push([a[0] * 0.25 + b[0] * 0.75, a[1] * 0.25 + b[1] * 0.75])
    }
    out.push(pts[pts.length - 1])
    pts = out
  }
  return pts
}

// 날의 오른쪽 모서리(끝 → 밑동). 왼쪽은 따로(비대칭인 날이 있다)
function edges(L) {
  const { bl, hw } = L
  const tip = hw * 2.1
  let R
  let Lft
  if (L.shape === 'notched') {
    R = [[0, 2], [hw * 0.82, tip * 0.9], [hw, tip * 1.2], [hw, bl * 0.4], [hw - 6, bl * 0.43], [hw - 1, bl * 0.47], [hw, bl]]
    Lft = [[0, 2], [-hw * 0.82, tip * 0.9], [-hw, tip * 1.2], [-hw, bl * 0.66], [-hw + 5, bl * 0.69], [-hw, bl * 0.71], [-hw, bl]]
    return { R, L: Lft }
  }
  if (L.shape === 'plain') R = [[0, 0], [hw, tip], [hw, bl]]
  else if (L.shape === 'knight') R = smooth([[0, 0], [hw * 1.02, tip * 1.05], [hw * 0.9, bl * 0.55], [hw * 1.02, bl]], 1)
  else if (L.shape === 'crystal') {
    R = [[0, 0], [hw * 0.8, tip * 0.7], [hw * 1.22, tip * 1.25], [hw * 0.88, bl * 0.3], [hw * 1.18, bl * 0.37], [hw * 0.9, bl * 0.57], [hw * 1.16, bl * 0.64], [hw * 0.92, bl * 0.86], [hw * 1.05, bl]]
    Lft = [[0, 0], [-hw * 0.8, tip * 0.7], [-hw * 1.15, tip * 1.4], [-hw * 0.9, bl * 0.24], [-hw * 1.2, bl * 0.46], [-hw * 0.9, bl * 0.52], [-hw * 1.14, bl * 0.75], [-hw * 0.92, bl * 0.82], [-hw * 1.05, bl]]
    return { R, L: Lft }
  } else if (L.shape === 'wavy') {
    R = [[0, 0], [hw * 0.95, tip]]
    for (let y = tip + 6; y < bl; y += 5) R.push([hw + 5 * Math.sin(((y - tip) / (bl - tip)) * Math.PI * 7), y])
    R.push([hw, bl])
  } else if (L.shape === 'broad') R = smooth([[0, 0], [hw * 0.72, tip * 0.7], [hw * 1.14, bl * 0.42], [hw * 0.9, bl * 0.86], [hw * 0.98, bl]], 2)
  else if (L.shape === 'jagged') {
    R = [[0, 0], [hw * 0.7, tip * 0.8], [hw, tip * 1.25]]
    for (let y = tip * 1.25 + 10; y < bl - 26; y += 30) R.push([hw, y], [hw + 11, y + 18], [hw - 1, y + 21])
    R.push([hw, bl])
  } else {
    // holy: 잎 모양 + 끝 쪽이 넓다
    R = smooth([[0, 0], [hw * 0.95, tip * 0.8], [hw * 1.32, bl * 0.26], [hw * 1.05, bl * 0.62], [hw * 0.74, bl * 0.92], [hw * 0.8, bl]], 2)
  }
  return { R, L: R.map((p) => [-p[0], p[1]]) }
}

function bladePath(L) {
  const e = edges(L)
  const left = e.L.slice(1).reverse()
  return 'M' + [e.R.map(pt).join(' L'), left.map(pt).join(' L')].join(' L') + ' Z'
}

// 바깥 모서리를 안쪽으로 줄인 모양(빗면 안쪽)
function corePath(L, k) {
  const e = edges(L)
  const R = e.R.map((p) => [p[0] * k, p[1] + (1 - k) * 18])
  const Lf = e.L.map((p) => [p[0] * k, p[1] + (1 - k) * 18]).slice(1).reverse()
  return 'M' + [R.map(pt).join(' L'), Lf.map(pt).join(' L')].join(' L') + ' Z'
}

function star(x, y, s, fill, op) {
  const k = s * 0.22
  return `<path d="M${r1(x)},${r1(y - s)} L${r1(x + k)},${r1(y - k)} L${r1(x + s)},${r1(y)} L${r1(x + k)},${r1(y + k)} L${r1(x)},${r1(y + s)} L${r1(x - k)},${r1(y + k)} L${r1(x - s)},${r1(y)} L${r1(x - k)},${r1(y - k)} Z" fill="${fill}" opacity="${op}"/>`
}

function gemSvg(id, x, y, r, color, kind) {
  if (!color) return ''
  const shape = kind === 'round'
    ? `<circle cx="${r1(x)}" cy="${r1(y)}" r="${r1(r)}" fill="url(#${id})" stroke="#1a1020" stroke-opacity=".55" stroke-width="1.2"/>`
    : `<path d="M${r1(x)},${r1(y - r * 1.25)} L${r1(x + r)},${r1(y)} L${r1(x)},${r1(y + r * 1.25)} L${r1(x - r)},${r1(y)} Z" fill="url(#${id})" stroke="#1a1020" stroke-opacity=".55" stroke-width="1.2"/>`
  return shape + `<circle cx="${r1(x - r * 0.35)}" cy="${r1(y - r * 0.4)}" r="${r1(Math.max(1.2, r * 0.28))}" fill="#fff" opacity=".9"/>`
}

function gemDef(id, color) {
  return `<radialGradient id="${id}" cx=".35" cy=".3" r=".8"><stop offset="0" stop-color="#ffffff"/><stop offset=".35" stop-color="${color}"/><stop offset="1" stop-color="${color}" stop-opacity=".75"/></radialGradient>`
}

// 코등이(가드). y0 = 날 밑동
function guardSvg(L, id, y0, lv) {
  const gw = L.gw
  const half = gw / 2
  const m = `url(#${id}m)`
  const st = 'stroke="#0d0a12" stroke-opacity=".55" stroke-width="1.5"'
  let s = ''
  if (L.guard === 'bar') {
    s += `<rect x="${r1(-half)}" y="${r1(y0)}" width="${r1(gw)}" height="14" rx="4" fill="${m}" ${st}/>`
    s += `<circle cx="${r1(-half)}" cy="${r1(y0 + 7)}" r="8" fill="${m}" ${st}/><circle cx="${r1(half)}" cy="${r1(y0 + 7)}" r="8" fill="${m}" ${st}/>`
    s += `<rect x="-11" y="${r1(y0 - 3)}" width="22" height="20" rx="4" fill="${m}" ${st}/>`
  } else if (L.guard === 'curve') {
    const d = `M${r1(-half)},${r1(y0 - 16)} Q${r1(-half * 0.55)},${r1(y0 + 16)} 0,${r1(y0 + 8)} Q${r1(half * 0.55)},${r1(y0 + 16)} ${r1(half)},${r1(y0 - 16)}`
    s += `<path d="${d}" fill="none" stroke="#0d0a12" stroke-opacity=".55" stroke-width="15" stroke-linecap="round"/>`
    s += `<path d="${d}" fill="none" stroke="${m}" stroke-width="12" stroke-linecap="round"/>`
    s += `<path d="${d}" fill="none" stroke="#ffffff" stroke-opacity=".45" stroke-width="3" stroke-linecap="round" transform="translate(0,-3)"/>`
    s += `<path d="M-15,${r1(y0 - 2)} L0,${r1(y0 - 12)} L15,${r1(y0 - 2)} L0,${r1(y0 + 20)} Z" fill="${m}" ${st}/>`
  } else if (L.guard === 'crystal') {
    for (const sg of [-1, 1]) {
      s += `<path d="M${sg * 10},${r1(y0 - 2)} L${r1(sg * half)},${r1(y0 - 22)} L${r1(sg * (half - 8))},${r1(y0 + 2)} L${sg * 12},${r1(y0 + 14)} Z" fill="${m}" ${st}/>`
      s += `<path d="M${sg * 10},${r1(y0 - 2)} L${r1(sg * half)},${r1(y0 - 22)} L${r1(sg * (half - 14))},${r1(y0 - 4)} Z" fill="#ffffff" opacity=".5"/>`
      s += `<path d="M${sg * 14},${r1(y0 + 6)} L${r1(sg * (half * 0.62))},${r1(y0 + 24)} L${sg * 10},${r1(y0 + 16)} Z" fill="${m}" ${st}/>`
    }
    s += `<path d="M-16,${r1(y0 + 2)} L0,${r1(y0 - 16)} L16,${r1(y0 + 2)} L0,${r1(y0 + 22)} Z" fill="${m}" ${st}/>`
  } else if (L.guard === 'flame') {
    for (const sg of [-1, 1]) {
      const d = `M0,${r1(y0 + 6)} C${sg * 18},${r1(y0 + 14)} ${r1(sg * half * 0.8)},${r1(y0 + 10)} ${r1(sg * half)},${r1(y0 - 14)} C${r1(sg * half * 0.82)},${r1(y0 - 4)} ${r1(sg * half * 0.5)},${r1(y0 - 2)} ${sg * 8},${r1(y0 - 4)} Z`
      s += `<path d="${d}" fill="${m}" ${st}/>`
      s += `<path d="M${r1(sg * half)},${r1(y0 - 14)} C${r1(sg * (half + 6))},${r1(y0 - 26)} ${r1(sg * (half - 4))},${r1(y0 - 30)} ${r1(sg * (half - 2))},${r1(y0 - 38)} C${r1(sg * (half - 14))},${r1(y0 - 26)} ${r1(sg * (half - 10))},${r1(y0 - 18)} ${r1(sg * (half - 6))},${r1(y0 - 12)} Z" fill="#ff8a2a"/>`
      s += `<path d="M${r1(sg * (half - 3))},${r1(y0 - 16)} C${r1(sg * (half + 1))},${r1(y0 - 22)} ${r1(sg * (half - 4))},${r1(y0 - 26)} ${r1(sg * (half - 4))},${r1(y0 - 30)} C${r1(sg * (half - 10))},${r1(y0 - 22)} ${r1(sg * (half - 9))},${r1(y0 - 18)} ${r1(sg * (half - 6))},${r1(y0 - 14)} Z" fill="#ffe27a"/>`
    }
    s += `<path d="M-14,${r1(y0 - 2)} L0,${r1(y0 - 14)} L14,${r1(y0 - 2)} L0,${r1(y0 + 22)} Z" fill="${m}" ${st}/>`
  } else if (L.guard === 'dragon') {
    for (const sg of [-1, 1]) {
      // 날개 깃 세 갈래
      for (let i = 0; i < 3; i++) {
        const ex = sg * (half + 6 - i * 16)
        const ey = y0 - 44 + i * 20
        s += `<path d="M${sg * 8},${r1(y0 + 8)} Q${r1(sg * (half * 0.55))},${r1(y0 + 20 - i * 3)} ${r1(ex)},${r1(ey)} Q${r1(sg * (half * 0.42 - i * 3))},${r1(y0 - 4 - i * 4)} ${sg * 6},${r1(y0 - 8)} Z" fill="${m}" ${st}/>`
      }
      s += `<path d="M${sg * 12},${r1(y0 + 4)} Q${r1(sg * half * 0.55)},${r1(y0 + 12)} ${r1(sg * (half + 4))},${r1(y0 - 42)}" fill="none" stroke="#fff6cf" stroke-opacity=".7" stroke-width="2"/>`
    }
    s += `<circle cx="0" cy="${r1(y0 + 6)}" r="17" fill="${m}" ${st}/>`
    s += `<circle cx="0" cy="${r1(y0 + 6)}" r="13" fill="none" stroke="#7a4f08" stroke-opacity=".6" stroke-width="2"/>`
  } else if (L.guard === 'horn') {
    for (const sg of [-1, 1]) {
      s += `<path d="M${sg * 6},${r1(y0 + 10)} C${r1(sg * half * 0.6)},${r1(y0 + 22)} ${r1(sg * half)},${r1(y0 + 6)} ${r1(sg * half)},${r1(y0 - 30)} C${r1(sg * half * 0.82)},${r1(y0 - 6)} ${r1(sg * half * 0.5)},${r1(y0 + 2)} ${sg * 6},${r1(y0 - 4)} Z" fill="${m}" ${st}/>`
      s += `<path d="M${r1(sg * half * 0.45)},${r1(y0 + 10)} L${r1(sg * half * 0.55)},${r1(y0 + 30)} L${r1(sg * half * 0.32)},${r1(y0 + 12)} Z" fill="${m}" ${st}/>`
      s += `<path d="M${r1(sg * half * 0.92)},${r1(y0 - 2)} C${r1(sg * half * 0.97)},${r1(y0 - 14)} ${r1(sg * half * 0.97)},${r1(y0 - 20)} ${r1(sg * half * 0.99)},${r1(y0 - 26)}" fill="none" stroke="#c9a6ff" stroke-opacity=".6" stroke-width="1.6"/>`
    }
    s += `<path d="M-16,${r1(y0 + 2)} L0,${r1(y0 - 18)} L16,${r1(y0 + 2)} L0,${r1(y0 + 24)} Z" fill="${m}" ${st}/>`
  } else {
    // angel: 깃털 날개
    for (const sg of [-1, 1]) {
      for (let i = 0; i < 5; i++) {
        const ang = (sg < 0 ? 180 : 0) + sg * (-12 - i * 13)
        const len = half - 4 - i * 5
        const cx = sg * 12
        const cy = y0 + 4
        s += `<g transform="translate(${cx},${r1(cy)}) rotate(${r1(ang)})"><path d="M0,0 C${r1(len * 0.3)},-9 ${r1(len * 0.8)},-8 ${r1(len)},0 C${r1(len * 0.8)},6 ${r1(len * 0.3)},7 0,0 Z" fill="${i % 2 ? '#fffaf0' : '#ffffff'}" stroke="#d2a23a" stroke-width="1.4"/></g>`
      }
    }
    s += `<circle cx="0" cy="${r1(y0 + 6)}" r="16" fill="${m}" stroke="#a87a1c" stroke-width="1.6"/>`
  }
  // 보석: 가운데 하나 + 단계가 오를수록 작은 보석
  if (L.gem) {
    const big = L.guard === 'dragon' || L.guard === 'angel' ? 9 : 7
    s += gemSvg(`${id}g`, 0, y0 + 5, big, L.gem, L.guard === 'dragon' || L.guard === 'angel' ? 'round' : 'diamond')
    const extra = Math.max(0, lv - LOOK_FROM(lv))
    for (let i = 0; i < extra; i++) {
      const x = (i % 2 ? 1 : -1) * (gw * (0.22 + Math.floor(i / 2) * 0.12))
      s += gemSvg(`${id}g`, x, y0 + 6, 3.4, L.gem, 'round')
    }
  }
  return s
}

function LOOK_FROM(lv) {
  return [0, 3, 6, 9, 12, 15, 18, 20][tierOf(lv)]
}

/**
 * 검 하나(세로, 끝이 위). 원점 = 검 한가운데. → { defs, body, len }
 * opt.broken: 가운데가 부러진 검(회색)
 */
export function swordSvg(lv, id, opt) {
  const o = opt || {}
  const L = lookOf(lv)
  const t = tierOf(lv)
  const gh = 14
  const pr = t >= 5 ? 13 : 11
  const len = L.bl + gh + L.gl + pr * 2
  const top = -len / 2
  const y0 = L.bl
  const blade = bladePath(L)
  const core = corePath(L, 0.46)
  const [c0, c1, c2, c3] = L.blade
  let defs = ''
  defs += `<linearGradient id="${id}b" gradientUnits="userSpaceOnUse" x1="${-L.hw * 1.3}" y1="0" x2="${L.hw * 1.3}" y2="0"><stop offset="0" stop-color="${c1}"/><stop offset=".46" stop-color="${c0}"/><stop offset=".5" stop-color="${c2}"/><stop offset="1" stop-color="${c3}"/></linearGradient>`
  defs += `<linearGradient id="${id}c" gradientUnits="userSpaceOnUse" x1="${-L.hw}" y1="0" x2="${L.hw}" y2="0"><stop offset="0" stop-color="#ffffff" stop-opacity=".9"/><stop offset=".5" stop-color="${c1}" stop-opacity=".55"/><stop offset=".52" stop-color="${c3}" stop-opacity=".35"/><stop offset="1" stop-color="${c3}" stop-opacity=".6"/></linearGradient>`
  defs += `<linearGradient id="${id}m" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${L.metal[0]}"/><stop offset=".55" stop-color="${L.metal[1]}"/><stop offset="1" stop-color="${L.metal[2]}"/></linearGradient>`
  defs += `<linearGradient id="${id}v" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="0" y2="${L.bl}"><stop offset="0" stop-color="#ffffff" stop-opacity=".0"/><stop offset="1" stop-color="#000000" stop-opacity=".22"/></linearGradient>`
  defs += `<clipPath id="${id}k"><path d="${blade}"/></clipPath>`
  defs += `<filter id="${id}f" x="-1" y="-1" width="3" height="3"><feGaussianBlur stdDeviation="7"/></filter>`
  if (L.gem) defs += gemDef(`${id}g`, L.gem)
  if (L.shape === 'wavy') {
    defs += `<linearGradient id="${id}w" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="0" y2="${L.bl}"><stop offset="0" stop-color="#fff7d6" stop-opacity=".95"/><stop offset=".45" stop-color="#ffb347" stop-opacity=".55"/><stop offset="1" stop-color="#c0150c" stop-opacity=".75"/></linearGradient>`
  }
  if (L.shape === 'holy') {
    defs += `<linearGradient id="${id}h" gradientUnits="userSpaceOnUse" x1="${-L.hw * 1.3}" y1="0" x2="${L.hw * 1.3}" y2="${L.bl}"><stop offset="0" stop-color="#ff9be3"/><stop offset=".3" stop-color="#ffe680"/><stop offset=".6" stop-color="#8ef0ff"/><stop offset="1" stop-color="#b59bff"/></linearGradient>`
  }

  let b = ''
  // 빛번짐(날 뒤)
  const glowA = L.aura ? Math.min(0.95, 0.25 + t * 0.09 + (lv - LOOK_FROM(lv)) * 0.05) : 0
  if (glowA && !o.broken) b += `<path d="${blade}" fill="${L.aura}" stroke="${L.aura}" stroke-width="${10 + t * 2}" stroke-linejoin="round" opacity="${r1(glowA * 100) / 100}" filter="url(#${id}f)"/>`

  // 날
  let bladeBody = `<path d="${blade}" fill="url(#${id}b)"/>`
  bladeBody += `<g clip-path="url(#${id}k)">`
  bladeBody += `<path d="${core}" fill="url(#${id}c)"/>`
  if (L.shape === 'wavy') bladeBody += `<rect x="${-L.hw * 2}" y="0" width="${L.hw * 4}" height="${L.bl}" fill="url(#${id}w)" style="mix-blend-mode:screen"/>`
  if (L.shape === 'notched') {
    // 녹
    const rust = [[-6, 0.3, 7, 4], [7, 0.52, 6, 9], [-4, 0.74, 9, 5], [5, 0.86, 5, 4], [-9, 0.6, 4, 6]]
    for (const [x, fy, rx, ry] of rust) bladeBody += `<ellipse cx="${x}" cy="${r1(L.bl * fy)}" rx="${rx}" ry="${ry}" fill="#8a4a1e" opacity=".5"/>`
    bladeBody += `<ellipse cx="2" cy="${r1(L.bl * 0.62)}" rx="3" ry="2" fill="#5a2a0e" opacity=".6"/>`
  }
  // 홈(풀러)
  if (['plain', 'knight', 'broad', 'holy'].includes(L.shape)) {
    const fw = L.hw * 0.32
    bladeBody += `<rect x="${r1(-fw / 2)}" y="${r1(L.bl * 0.3)}" width="${r1(fw)}" height="${r1(L.bl * 0.66)}" rx="${r1(fw / 2)}" fill="${c3}" opacity=".32"/>`
    bladeBody += `<rect x="${r1(-fw / 2 + 1)}" y="${r1(L.bl * 0.3 + 2)}" width="1.6" height="${r1(L.bl * 0.66 - 4)}" fill="#ffffff" opacity=".55"/>`
  }
  if (L.shape === 'crystal') {
    for (let i = 0; i < 6; i++) {
      const y = L.bl * (0.18 + i * 0.13)
      bladeBody += `<path d="M${-L.hw},${r1(y)} L0,${r1(y + 14)} L${L.hw},${r1(y - 2)}" fill="none" stroke="#ffffff" stroke-opacity=".45" stroke-width="1.2"/>`
    }
  }
  if (L.shape === 'broad') {
    // 금빛 무늬
    for (let i = 0; i < 4; i++) {
      const y = L.bl * (0.4 + i * 0.13)
      bladeBody += `<circle cx="0" cy="${r1(y)}" r="3.2" fill="none" stroke="#7a4f08" stroke-opacity=".7" stroke-width="1.4"/>`
    }
  }
  if (L.shape === 'jagged') {
    // 빛나는 룬
    for (let i = 0; i < 5; i++) {
      const y = L.bl * (0.3 + i * 0.13)
      bladeBody += `<path d="M-4,${r1(y)} L4,${r1(y + 5)} L-3,${r1(y + 10)}" fill="none" stroke="#ff7ad0" stroke-width="2" stroke-linecap="round" opacity=".9"/>`
    }
  }
  if (L.shape === 'holy') bladeBody += `<path d="${corePath(L, 0.2)}" fill="#ffffff" opacity=".85"/>`
  bladeBody += `<rect x="${-L.hw * 2}" y="0" width="${L.hw * 4}" height="${L.bl}" fill="url(#${id}v)"/>`
  bladeBody += '</g>'
  // 가운데 등줄·모서리
  bladeBody += `<path d="M0,${r1(L.hw * 1.3)} L0,${r1(L.bl - 2)}" stroke="#ffffff" stroke-opacity=".5" stroke-width="1"/>`
  bladeBody += `<path d="${blade}" fill="none" stroke="${L.shape === 'holy' ? `url(#${id}h)` : L.edge}" stroke-width="${L.shape === 'holy' ? 3 : 1.6}" stroke-linejoin="round" opacity=".95"/>`
  bladeBody += `<path d="${blade}" fill="none" stroke="#0c0a14" stroke-opacity=".35" stroke-width="0.8" stroke-linejoin="round"/>`

  // 손잡이 · 끝 장식
  const gy = y0 + gh
  const gw2 = t >= 5 ? 15 : 13
  let hilt = `<rect x="${-gw2 / 2}" y="${r1(gy - 2)}" width="${gw2}" height="${L.gl + 4}" rx="4" fill="${L.grip}" stroke="#0c0a12" stroke-opacity=".6" stroke-width="1.4"/>`
  defs += `<clipPath id="${id}q"><rect x="${-gw2 / 2}" y="${r1(gy - 2)}" width="${gw2}" height="${L.gl + 4}" rx="4"/></clipPath>`
  hilt += `<g clip-path="url(#${id}q)">`
  for (let y = gy - 4; y < gy + L.gl + 4; y += 8) hilt += `<path d="M${-gw2},${r1(y)} L${gw2},${r1(y + 9)}" stroke="${L.wrap}" stroke-width="3.4"/>`
  hilt += `<rect x="${-gw2 / 2 + 2}" y="${r1(gy)}" width="2.4" height="${L.gl}" fill="#ffffff" opacity=".18"/>`
  hilt += '</g>'
  const py = gy + L.gl + pr
  hilt += `<rect x="${-gw2 / 2 - 2}" y="${r1(gy + L.gl - 2)}" width="${gw2 + 4}" height="6" rx="2" fill="url(#${id}m)" stroke="#0c0a12" stroke-opacity=".5" stroke-width="1"/>`
  hilt += `<circle cx="0" cy="${r1(py)}" r="${pr}" fill="url(#${id}m)" stroke="#0c0a12" stroke-opacity=".55" stroke-width="1.4"/>`
  if (L.gem) hilt += gemSvg(`${id}g`, 0, py, pr * 0.5, L.gem, 'round')
  else hilt += `<circle cx="-3" cy="${r1(py - 3)}" r="2.5" fill="#ffffff" opacity=".35"/>`

  const guard = guardSvg(L, id, y0, lv)
  if (o.broken) {
    // 가운데쯤이 부러져 위 조각이 떨어져 나간 검. 색을 빼고 금 간 자리를 붉게
    const by = L.bl * 0.5
    const zig = []
    for (let i = 0; i <= 6; i++) zig.push([-L.hw * 1.6 + (L.hw * 3.2 * i) / 6, by + (i % 2 ? -7 : 6)])
    const lower = `M${-L.hw * 2},${L.bl + 200} L${-L.hw * 2},${r1(by)} ` + zig.map((p) => 'L' + pt(p)).join(' ') + ` L${L.hw * 2},${r1(by)} L${L.hw * 2},${L.bl + 200} Z`
    const upper = `M${-L.hw * 2},-20 L${-L.hw * 2},${r1(by)} ` + zig.map((p) => 'L' + pt(p)).join(' ') + ` L${L.hw * 2},${r1(by)} L${L.hw * 2},-20 Z`
    defs += `<clipPath id="${id}lo"><path d="${lower}"/></clipPath><clipPath id="${id}up"><path d="${upper}"/></clipPath>`
    defs += `<filter id="${id}gr"><feColorMatrix type="saturate" values="0.12"/></filter>`
    const whole = bladeBody
    b += `<g filter="url(#${id}gr)">`
    b += `<g clip-path="url(#${id}lo)">${whole}</g>`
    b += `<g transform="translate(16,-22) rotate(12 0 ${r1(by)})"><g clip-path="url(#${id}up)">${whole}</g></g>`
    b += hilt + guard
    b += '</g>'
    b += `<path d="M${zig.map(pt).join(' L')}" fill="none" stroke="#ff5a4a" stroke-width="2.4" opacity=".85"/>`
    const shards = [[-30, by - 14, 7, 20], [34, by + 10, 6, -30], [-16, by + 26, 5, 50], [20, by - 40, 5, 10]]
    for (const [x, y, s, rot] of shards) b += `<path d="M${x},${r1(y - s)} L${x + s * 0.7},${r1(y + s * 0.6)} L${x - s * 0.8},${r1(y + s * 0.4)} Z" fill="#b9bcc4" stroke="#3a3d46" stroke-width="1" transform="rotate(${rot} ${x} ${r1(y)})"/>`
  } else {
    b += bladeBody + hilt + guard
  }
  return { defs, body: `<g transform="translate(0,${r1(top)})">${b}</g>`, len }
}

// ── 카드 ──────────────────────────────────────────────────────────────────
const RESULT = {
  up: { title: '강화 성공', color: '#ffd84a', glow: '#ffcf3a', bg: ['#141a3d', '#1d2a63'] },
  fail: { title: '강화 실패', color: '#c7cfe6', glow: '#8b95b8', bg: ['#141827', '#232a44'] },
  guarded: { title: '파괴 방어', color: '#7ef0c8', glow: '#3fd6a0', bg: ['#0f1f2a', '#153a45'] },
  broke: { title: '검 파괴', color: '#ff6a5a', glow: '#ff3b2f', bg: ['#220d14', '#3f1420'] },
}

function frame(w, h, bg, accent) {
  return `<defs>
<linearGradient id="bg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${bg[1]}"/><stop offset="1" stop-color="${bg[0]}"/></linearGradient>
<pattern id="scan" width="4" height="4" patternUnits="userSpaceOnUse"><rect width="4" height="1" fill="#ffffff" opacity=".035"/></pattern>
</defs>
<rect width="${w}" height="${h}" fill="#070914"/>
<rect x="6" y="6" width="${w - 12}" height="${h - 12}" rx="20" fill="url(#bg)"/>
<rect x="6" y="6" width="${w - 12}" height="${h - 12}" rx="20" fill="url(#scan)"/>
<rect x="14" y="14" width="${w - 28}" height="${h - 28}" rx="14" fill="none" stroke="#eef1ff" stroke-width="3"/>
<rect x="20" y="20" width="${w - 40}" height="${h - 40}" rx="10" fill="none" stroke="${accent}" stroke-opacity=".55" stroke-width="1.5"/>
${[[22, 22], [w - 30, 22], [22, h - 30], [w - 30, h - 30]].map(([x, y]) => `<rect x="${x}" y="${y}" width="8" height="8" fill="${accent}"/>`).join('')}`
}

function sparkles(seed, lv, cx, cy, spread, color) {
  if (lv < 3) return ''
  const rnd = lcg(seed)
  const n = Math.min(14, lv)
  let s = ''
  for (let i = 0; i < n; i++) {
    const a = rnd() * Math.PI * 2
    const d = spread * (0.35 + rnd() * 0.65)
    const size = 4 + rnd() * (lv >= 15 ? 11 : 8)
    s += star(cx + Math.cos(a) * d, cy + Math.sin(a) * d * 1.1, size, i % 3 ? '#ffffff' : color || '#ffffff', r1(0.55 + rnd() * 0.45))
  }
  return s
}

// 왼쪽 진열장: 오라 + 기울인 검 + 반짝임
function showcase(lv, x, y, w, h, opt) {
  const o = opt || {}
  const L = lookOf(lv)
  const t = tierOf(lv)
  const cx = x + w / 2
  const cy = y + h / 2 + 4
  const aura = o.broken ? '#ff3b2f' : L.aura || '#9aa6c0'
  const auraA = o.broken ? 0.35 : L.aura ? Math.min(0.85, 0.3 + t * 0.08) : 0.18
  let defs = `<radialGradient id="sh" cx=".5" cy=".5" r=".55"><stop offset="0" stop-color="${aura}" stop-opacity="${auraA}"/><stop offset=".6" stop-color="${aura}" stop-opacity="${r1(auraA * 25) / 100}"/><stop offset="1" stop-color="${aura}" stop-opacity="0"/></radialGradient>`
  defs += `<clipPath id="shc"><rect x="${x}" y="${y}" width="${w}" height="${h}" rx="12"/></clipPath>`
  let s = `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="12" fill="#05060d" opacity=".55"/>`
  s += `<g clip-path="url(#shc)">`
  s += `<ellipse cx="${cx}" cy="${cy}" rx="${w * 0.62}" ry="${h * 0.56}" fill="url(#sh)"/>`
  if (!o.broken && t >= 5) {
    // 빛줄기
    for (let i = 0; i < 12; i++) {
      s += `<path d="M${cx},${cy} L${r1(cx + Math.cos((i * 30 * Math.PI) / 180 - 0.06) * 420)},${r1(cy + Math.sin((i * 30 * Math.PI) / 180 - 0.06) * 420)} L${r1(cx + Math.cos((i * 30 * Math.PI) / 180 + 0.06) * 420)},${r1(cy + Math.sin((i * 30 * Math.PI) / 180 + 0.06) * 420)} Z" fill="${aura}" opacity="${t >= 7 ? 0.16 : 0.1}"/>`
    }
  }
  // 바닥 격자(옛 게임 느낌)
  for (let i = 1; i < 6; i++) s += `<path d="M${x},${r1(y + h - i * 16)} L${x + w},${r1(y + h - i * 16)}" stroke="${aura}" stroke-opacity="${r1(0.12 - i * 0.015) > 0 ? r1((0.12 - i * 0.018) * 100) / 100 : 0.02}" stroke-width="1"/>`
  s += `<ellipse cx="${cx}" cy="${y + h - 34}" rx="${w * 0.32}" ry="10" fill="#000" opacity=".35"/>`
  const A = artOf(lv)
  if (A) {
    const sw = artSword(A, cx, cy - 22, h - 92, 'sw', { broken: o.broken })
    defs += sw.defs
    s += sw.body
  } else {
    const sw = swordSvg(lv, 'sw', { broken: o.broken })
    defs += sw.defs
    const scale = Math.min(1, (h - 40) / (sw.len * 0.74)) * (o.broken ? 0.9 : 1)
    const ox = o.broken ? cx - 22 : cx
    const oy = o.broken ? cy + 26 : cy
    s += `<g transform="translate(${ox},${oy}) rotate(45) scale(${r1(scale * 100) / 100})">${sw.body}</g>`
  }
  if (!o.broken) s += sparkles(lv * 7919 + 17, lv, cx, cy, Math.min(w, h) * 0.46, L.aura || '#ffffff')
  s += '</g>'
  s += `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="12" fill="none" stroke="#ffffff" stroke-opacity=".12" stroke-width="1.5"/>`
  return { defs, body: s }
}

// 진열장은 단계(와 부러짐)마다 늘 같은 그림이라 PNG 로 한 번 그려 두고 카드에 붙인다(빛번짐 필터가 비싸다).
// 단계 21개 × 부러짐 = 많아야 42장. 렌더러가 없으면 null(카드는 벡터로 그린다).
const SHOWCASE_PNG = new Map()
function showcaseImage(lv, x, y, w, h, broken) {
  const k = `${lv}|${broken ? 1 : 0}|${w}x${h}`
  let uri = SHOWCASE_PNG.get(k)
  if (uri === undefined) {
    const sc = showcase(lv, 0, 0, w, h, { broken })
    const png = svgToPng(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><defs>${sc.defs}</defs>${sc.body}</svg>`)
    uri = png ? 'data:image/png;base64,' + png.toString('base64') : null
    if (SHOWCASE_PNG.size < 64) SHOWCASE_PNG.set(k, uri)
  }
  return uri ? `<image x="${x}" y="${y}" width="${w}" height="${h}" href="${uri}"/>` : ''
}

function showcaseAt(lv, x, y, w, h, broken, embed) {
  const img = embed ? showcaseImage(lv, x, y, w, h, broken) : ''
  if (img) return img
  const sc = showcase(lv, x, y, w, h, { broken })
  return `<defs>${sc.defs}</defs>` + sc.body
}

function lvBadge(lv, x, y, color) {
  const txt = `+${lv}`
  return `<text x="${x}" y="${y}" ${F} font-weight="700" font-size="58" fill="none" stroke="#05060d" stroke-width="10" stroke-linejoin="round">${txt}</text>` +
    `<text x="${x}" y="${y}" ${F} font-weight="700" font-size="58" fill="${color}">${txt}</text>`
}

function text(x, y, s, size, color, opt) {
  const o = opt || {}
  return `<text x="${x}" y="${y}" ${F} font-weight="${o.bold ? 700 : 400}" font-size="${size}" fill="${color}"${o.anchor ? ` text-anchor="${o.anchor}"` : ''}${o.op ? ` opacity="${o.op}"` : ''}>${esc(s)}</text>`
}

function probBar(x, y, w, up, broke) {
  const fail = 100 - up - broke
  const wu = (w * up) / 100
  const wf = (w * fail) / 100
  const wb = w - wu - wf
  let s = `<defs><clipPath id="pb"><rect x="${x}" y="${y}" width="${w}" height="14" rx="7"/></clipPath></defs>`
  s += `<g clip-path="url(#pb)"><rect x="${x}" y="${y}" width="${w}" height="14" fill="#3a4160"/>`
  s += `<rect x="${x}" y="${y}" width="${r1(wu)}" height="14" fill="#4ad98a"/>`
  if (wb > 0) s += `<rect x="${r1(x + wu + wf)}" y="${y}" width="${r1(wb)}" height="14" fill="#ff5a4a"/>`
  s += `<rect x="${x}" y="${y}" width="${w}" height="5" fill="#ffffff" opacity=".18"/></g>`
  return s
}

function chip(x, y, label, color) {
  const w = Math.round(textWidth(label, 15, true) + 28)
  return { w, svg: `<rect x="${x}" y="${y}" width="${w}" height="30" rx="15" fill="${color}" fill-opacity=".16" stroke="${color}" stroke-opacity=".6"/>` + text(x + w / 2, y + 21, label, 15, color, { bold: true, anchor: 'middle' }) }
}

function footer(w, h, right) {
  return text(38, h - 29, 'K bot · 추억의 검 강화', 15, '#8a94c0', { op: 0.85 }) + (right ? text(w - 38, h - 29, right, 15, '#8a94c0', { anchor: 'end', op: 0.85 }) : '')
}

/** 강화 결과 카드 SVG */
export function enhanceSvg(c, opt) {
  const W = 720
  const H = 540
  const R = RESULT[c.result] || RESULT.fail
  const broken = c.result === 'broke'
  const shownLv = broken ? c.from : c.lv
  const L = lookOf(shownLv)
  let s = frame(W, H, R.bg, R.color)
  s += showcaseAt(shownLv, 34, 34, 312, 446, broken, opt && opt.embed)
  s += lvBadge(shownLv, 52, 462, broken ? '#9a9fb0' : L.aura || '#e8e2d4')
  s += ribbons(c.notes, 48, 48)
  const X = 374
  const RX = 686
  // 머리 글(결과)
  s += `<text x="${X}" y="86" ${F} font-weight="700" font-size="46" fill="none" stroke="${R.glow}" stroke-opacity=".35" stroke-width="8" stroke-linejoin="round">${esc(R.title)}</text>`
  s += text(X, 86, R.title, 46, R.color, { bold: true })
  s += text(X, 122, ellipsis(`${c.owner}님의 검`, 20, RX - X), 20, '#aab3d6')
  if (broken) {
    const nm = swordName(c.from)
    s += text(X, 172, nm, 34, '#9a8f96', { bold: true })
    s += `<path d="M${X - 4},160 L${r1(X + textWidth(nm, 34, true) * 0.9 + 4)},160" stroke="#ff6a5a" stroke-width="4" stroke-linecap="round"/>`
  } else s += text(X, 172, swordName(c.lv), 34, '#ffffff', { bold: true })
  // +6 → +7
  const arrowColor = c.result === 'up' ? '#4ad98a' : broken ? '#ff6a5a' : '#8a94c0'
  s += text(X, 214, `+${c.from}`, 28, '#c7cfe6', { bold: true })
  const fx = X + 18 + String(c.from).length * 18 + 18
  s += `<path d="M${fx},205 L${fx + 30},205 M${fx + 22},197 L${fx + 31},205 L${fx + 22},213" fill="none" stroke="${arrowColor}" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"/>`
  s += text(fx + 44, 214, `+${c.lv}`, 28, arrowColor === '#8a94c0' ? '#ffffff' : arrowColor, { bold: true })
  s += `<path d="M${X},240 L${RX},240" stroke="#ffffff" stroke-opacity=".14" stroke-width="1.5"/>`
  // 다음 강화
  const rows = []
  if (c.lv >= MAX_LV) rows.push(['다음 강화', '최고 단계'])
  else {
    const need = cost(c.lv)
    rows.push(['다음 강화 비용', won(need.gold) + 'G' + (need.mana ? ' + 마력석' : '') + (need.scale ? ' + 비늘' : '')])
  }
  rows.push(['보유 골드', won(c.gold) + 'G'])
  rows.push(['사용한 골드', won(c.spent) + 'G'])
  let y = 280
  for (const [k, v] of rows) {
    s += text(X, y, k, 19, '#8f9bc7')
    s += text(RX, y, v, 22, '#ffffff', { bold: true, anchor: 'end' })
    y += 38
  }
  if (c.lv < MAX_LV) {
    const ch = nextChance(c.lv, c.pity)
    s += text(X, y + 4, `다음 성공 ${ch.up}%${c.pity ? ` (보정 +${c.pity}%)` : ''}`, 16, '#4ad98a', { bold: true })
    if (ch.broke) s += text(RX, y + 4, `파괴 ${ch.broke}%`, 16, '#ff7a6a', { bold: true, anchor: 'end' })
    s += probBar(X, y + 14, RX - X, ch.up, ch.broke)
    y += 44
  }
  const chips = (c.used || []).slice()
  if (c.result === 'up' && c.lv >= MAX_LV) chips.push('최고 단계 달성')
  if (broken) chips.push(`새 +0 ${swordName(0)}`)
  if (chips.length) {
    let cx = X
    for (const u of chips) {
      const ch = chip(cx, y + 6, u, u.startsWith('보호') ? '#7ef0c8' : u.startsWith('새') ? '#c7cfe6' : '#ffd84a')
      s += ch.svg
      cx += ch.w + 8
    }
  }
  s += footer(W, H, `최고 기록 +${c.best}`)
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${s}</svg>`
}

// 다음 강화 확률(연속 실패 보정 pity % 를 더한다)
function nextChance(lv, pity) {
  const ch = chance(lv)
  const up = Math.min(100, ch.up + (Number(pity) || 0))
  return { up, broke: Math.min(ch.broke, 100 - up) }
}

// 진열장 왼쪽 위 리본(방 최고 기록 · 위로금)
function ribbons(notes, x, y) {
  let s = ''
  let yy = y
  for (const n of (notes || []).slice(0, 2)) {
    const gold = n === '방 최고 기록'
    const w = Math.round(textWidth(n, 17, true) + 30)
    s += `<rect x="${x}" y="${yy}" width="${w}" height="34" rx="17" fill="${gold ? '#3a2a05' : '#0b1a2e'}" fill-opacity=".88" stroke="${gold ? '#ffd84a' : '#7ec8ff'}" stroke-width="2"/>`
    s += text(x + w / 2, yy + 23, n, 17, gold ? '#ffe17a' : '#bfe4ff', { bold: true, anchor: 'middle' })
    yy += 42
  }
  return s
}

/** 내 검 카드 SVG */
export function infoSvg(c, opt) {
  const W = 720
  const H = 540
  const L = lookOf(c.lv)
  const accent = L.aura || '#d9cdb9'
  let s = frame(W, H, ['#111633', '#1c2550'], accent)
  s += showcaseAt(c.lv, 34, 34, 312, 446, false, opt && opt.embed)
  s += lvBadge(c.lv, 52, 462, L.aura || '#e8e2d4')
  const X = 374
  const RX = 686
  s += text(X, 74, ellipsis(`${c.owner}님의 검`, 22, RX - X), 22, '#aab3d6', { bold: true })
  s += text(X, 124, swordName(c.lv), 40, '#ffffff', { bold: true })
  s += text(X, 160, `+${c.lv} · 최고 기록 +${c.best}`, 20, accent, { bold: true })
  s += `<path d="M${X},184 L${RX},184" stroke="#ffffff" stroke-opacity=".14" stroke-width="1.5"/>`
  const rows = [['보유 골드', won(c.gold) + 'G'], ['판매가', won(c.price) + 'G']]
  if (c.next) {
    const need = [won(c.next.gold) + 'G']
    if (c.next.mana) need.push('마력석')
    if (c.next.scale) need.push('비늘')
    rows.push(['다음 강화', need.join(' + ')])
  } else rows.push(['다음 강화', '최고 단계'])
  let y = 222
  for (const [k, v] of rows) {
    s += text(X, y, k, 19, '#8f9bc7')
    s += text(RX, y, ellipsis(v, 22, 190, true), 22, '#ffffff', { bold: true, anchor: 'end' })
    y += 38
  }
  if (c.next) {
    s += text(X, y + 2, `성공 ${c.next.up}%${c.next.pity ? ` (보정 +${c.next.pity}%)` : ''}`, 16, '#4ad98a', { bold: true })
    if (c.next.broke) s += text(RX, y + 2, `파괴 ${c.next.broke}%`, 16, '#ff7a6a', { bold: true, anchor: 'end' })
    s += probBar(X, y + 12, RX - X, c.next.up, c.next.broke)
    y += 40
  }
  // 아이템 2×2
  const iw = (RX - X - 10) / 2
  ;(c.items || []).slice(0, 4).forEach((it, i) => {
    const ix = X + (i % 2) * (iw + 10)
    const iy = y + 6 + Math.floor(i / 2) * 50
    s += `<rect x="${r1(ix)}" y="${iy}" width="${r1(iw)}" height="42" rx="10" fill="#ffffff" fill-opacity="${it.n ? 0.08 : 0.03}" stroke="#ffffff" stroke-opacity=".12"/>`
    s += text(ix + 12, iy + 27, it.name, 16, it.n ? '#dfe4fb' : '#6d769c')
    s += text(ix + iw - 12, iy + 28, String(it.n), 19, it.n ? '#ffffff' : '#6d769c', { bold: true, anchor: 'end' })
  })
  s += footer(W, H, c.broken ? `부서진 검 ${c.broken}자루` : '')
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${s}</svg>`
}

/** 강화 랭킹 카드 SVG */
export function rankSvg(c) {
  const rows = (c.rows || []).slice(0, 10)
  const W = 720
  const RH = 58
  const H = 150 + rows.length * RH + 40
  let s = frame(W, H, ['#111633', '#1d2a63'], '#ffd84a')
  s += `<text x="40" y="84" ${F} font-weight="700" font-size="42" fill="none" stroke="#ffcf3a" stroke-opacity=".3" stroke-width="8" stroke-linejoin="round">강화 랭킹</text>`
  s += text(40, 84, '강화 랭킹', 42, '#ffd84a', { bold: true })
  s += text(W - 40, 84, '지금 검 단계 순', 18, '#8f9bc7', { anchor: 'end' })
  let defs = ''
  rows.forEach((r, i) => {
    const y = 118 + i * RH
    const medal = ['#ffd84a', '#d7dde8', '#e09a5a'][i] || ''
    s += `<rect x="34" y="${y}" width="${W - 68}" height="${RH - 8}" rx="12" fill="#ffffff" fill-opacity="${i < 3 ? 0.08 : 0.04}" stroke="#ffffff" stroke-opacity="${i < 3 ? 0.16 : 0.08}"/>`
    if (medal) s += `<circle cx="66" cy="${y + 25}" r="16" fill="${medal}"/>` + text(66, y + 32, String(i + 1), 18, '#1a1a2e', { bold: true, anchor: 'middle' })
    else s += text(66, y + 32, String(i + 1), 20, '#aab3d6', { bold: true, anchor: 'middle' })
    const A = artOf(r.lv)
    if (A) {
      s += `<g transform="translate(116,${y + 25}) rotate(45)">${artSword(A, 0, 0, 60, 'r' + i).body}</g>`
    } else {
      const sw = swordSvg(r.lv, 'r' + i)
      defs += sw.defs
      const sc = 40 / (sw.len * 0.72)
      s += `<g transform="translate(116,${y + 25}) rotate(45) scale(${r1(sc * 1000) / 1000})">${sw.body}</g>`
    }
    s += text(150, y + 33, ellipsis(r.name, 22, 250, true), 22, '#ffffff', { bold: true })
    const L = lookOf(r.lv)
    s += text(W - 160, y + 33, `+${r.lv} ${swordName(r.lv)}`, 20, L.aura || '#d9cdb9', { bold: true, anchor: 'end' })
    s += text(W - 50, y + 33, `최고 +${r.best}`, 16, '#8f9bc7', { anchor: 'end' })
  })
  s += footer(W, H, '')
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}"><defs>${defs}</defs>${s}</svg>`
}

/** 카드 값(sword.mjs run 의 card) → SVG */
export function cardSvg(card, opt) {
  if (!card) return ''
  if (card.kind === 'enhance') return enhanceSvg(card, opt)
  if (card.kind === 'info') return infoSvg(card, opt)
  if (card.kind === 'rank') return rankSvg(card)
  return ''
}

/** 카드 값 → PNG Buffer(못 만들면 null) */
export function cardPng(card) {
  const svg = cardSvg(card, { embed: true })
  return svg ? svgToPng(svg) : null
}
