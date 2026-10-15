// 카드 글자의 대체 글꼴 고르기. 기본 글꼴(Pretendard)에 없는 글자(꾸민 닉네임의 특수문자·수학 문자·이모지·일본어 등)는
// 그 글자를 가진 대체 글꼴(assets/fonts 의 Noto · Unifont)로 그린다. 렌더러(resvg)는 글자가 없으면 빈 상자(.notdef)를 그리고,
// 어느 글꼴에도 없는 글자를 만나면 그 뒤의 대체도 멈춘다 — 그래서 그리기 전에 글자마다 글꼴을 정해 필요한 파일만 넘기고,
// 어느 글꼴에도 없는 글자와 혼자서는 모양이 없는 보조 문자(이모지 모양 지정 · 피부색 · 잇기 문자)는 뺀다.
// 글꼴 파일의 cmap 만 읽어 덮는 글자 범위를 처음 쓸 때 한 번 만든다(카드를 그릴 때마다 큰 글꼴을 다 읽지 않게).
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// 대체 글꼴 순서(앞이 먼저). 모두 SIL OFL 1.1(Unifont 는 OFL 1.1 / GPL2+ 글꼴 예외 이중 허가) — assets/fonts/FONTS.txt
export const FALLBACK = [
  'NotoSans.ttf', // 라틴 확장 · 그리스 · 키릴 · 작은 대문자(ᴋʙᴏᴛ)
  'NotoSansMath.ttf', // 수학 문자(𝓚𝐀𝕂)
  'NotoSansSymbols.ttf', // 원문자 · 기호
  'NotoSansSymbols2.ttf', // 딩뱃 · 도형 · 점자
  'NotoEmoji.ttf', // 이모지(흑백 선 그림)
  'NotoSansJP.ttf', // 일본어 · 한자
  'NotoSansJavanese.ttf', // ꧁ ꧂
  'NotoSansOriya.ttf', // ୨ ୧
  'NotoSansCanadianAboriginal.ttf', // ᐟ ᐛ
  'NotoSansEgyptianHieroglyphs.ttf', // 𓆩 𓆪
  'Unifont.otf', // 나머지 기본 다국어 평면 전부(점 글꼴)
  'UnifontUpper.otf', // 그 밖의 평면
]
const EMOJI_FONT = 'NotoEmoji.ttf'

/** 혼자서는 모양이 없어 빼는 글자: 이모지 모양 지정(FE00–FE0F) · 피부색(1F3FB–1F3FF) · 잇기·너비 없는 문자 · 태그 · 키캡 */
export function isDropped(c) {
  return (c >= 0xfe00 && c <= 0xfe0f) || (c >= 0x1f3fb && c <= 0x1f3ff) || (c >= 0x200b && c <= 0x200f) ||
    (c >= 0x2060 && c <= 0x2064) || c === 0x20e3 || c === 0xfeff || (c >= 0xe0000 && c <= 0xe007f) || (c >= 0xe0100 && c <= 0xe01ef)
}

/** 이모지 그림 글자(이 범위는 이모지 글꼴을 먼저 본다 — 기호 글꼴의 같은 글자보다 이모지답다) */
function isEmoji(c) {
  return c >= 0x1f000 && c <= 0x1faff
}

/** 글꼴 파일(Buffer)의 cmap → 덮는 글자 범위 [[처음, 끝], …](정렬·병합). 읽지 못하면 [] */
export function cmapRanges(buf) {
  try {
    const numTables = buf.readUInt16BE(4)
    let cmap = -1
    for (let i = 0; i < numTables; i++) {
      const r = 12 + i * 16
      if (buf.toString('latin1', r, r + 4) === 'cmap') cmap = buf.readUInt32BE(r + 8)
    }
    if (cmap < 0) return []
    let best = -1
    let rank = 0
    for (let i = 0, n = buf.readUInt16BE(cmap + 2); i < n; i++) {
      const r = cmap + 4 + i * 8
      const pid = buf.readUInt16BE(r)
      const eid = buf.readUInt16BE(r + 2)
      const off = cmap + buf.readUInt32BE(r + 4)
      const fmt = buf.readUInt16BE(off)
      const unicode = pid === 0 || (pid === 3 && (eid === 1 || eid === 10))
      const k = !unicode ? 0 : fmt === 12 ? 2 : fmt === 4 ? 1 : 0
      if (k > rank) { rank = k; best = off }
    }
    const out = []
    if (rank === 2) {
      for (let g = 0, n = buf.readUInt32BE(best + 12); g < n; g++) {
        const r = best + 16 + g * 12
        const start = buf.readUInt32BE(r)
        const end = buf.readUInt32BE(r + 4)
        const gid = buf.readUInt32BE(r + 8)
        if (gid === 0 && start === end) continue
        out.push([gid === 0 ? start + 1 : start, end])
      }
    } else if (rank === 1) {
      const seg = buf.readUInt16BE(best + 6) / 2
      const ends = best + 14
      const starts = ends + seg * 2 + 2
      const deltas = starts + seg * 2
      const offs = deltas + seg * 2
      for (let s = 0; s < seg; s++) {
        const end = buf.readUInt16BE(ends + s * 2)
        const start = buf.readUInt16BE(starts + s * 2)
        if (start === 0xffff) continue
        const delta = buf.readInt16BE(deltas + s * 2)
        const ro = buf.readUInt16BE(offs + s * 2)
        if (ro === 0) { out.push([start, end]); continue }
        // 글리프 번호 표를 거치는 구간은 글자마다 0(없음)인지 본다
        let runStart = -1
        for (let c = start; c <= end; c++) {
          let gid = buf.readUInt16BE(offs + s * 2 + ro + (c - start) * 2)
          if (gid) gid = (gid + delta) & 0xffff
          if (gid && runStart < 0) runStart = c
          if (!gid && runStart >= 0) { out.push([runStart, c - 1]); runStart = -1 }
        }
        if (runStart >= 0) out.push([runStart, end])
      }
    }
    out.sort((a, b) => a[0] - b[0])
    const merged = []
    for (const r of out) {
      const last = merged[merged.length - 1]
      if (last && r[0] <= last[1] + 1) last[1] = Math.max(last[1], r[1])
      else merged.push([r[0], r[1]])
    }
    return merged
  } catch {
    return []
  }
}

export function covers(ranges, c) {
  let lo = 0
  let hi = ranges.length - 1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (c < ranges[mid][0]) hi = mid - 1
    else if (c > ranges[mid][1]) lo = mid + 1
    else return true
  }
  return false
}

/**
 * dir(글꼴 폴더) · base(기본 글꼴 파일들) → plan(svg) = {svg, files}.
 * svg 에서 뺄 글자를 빼고, 기본 글꼴에 없는 글자를 가진 대체 글꼴 파일을 순서대로 files 에 더한다(없으면 기본 글꼴만).
 */
export function glyphPlanner(dir, base, fallback = FALLBACK) {
  let baseCover = null
  let fb = null // [{file, path, ranges}]
  const pick = new Map() // 글자 → 대체 글꼴 경로 | '' (어느 글꼴에도 없음)

  function load(file) {
    try {
      return cmapRanges(readFileSync(join(dir, file)))
    } catch {
      return []
    }
  }

  function fontFor(c) {
    if (pick.has(c)) return pick.get(c)
    if (!fb) fb = fallback.map((file) => ({ file, path: join(dir, file), ranges: load(file) }))
    let hit = ''
    if (isEmoji(c)) {
      const e = fb.find((f) => f.file === EMOJI_FONT && covers(f.ranges, c))
      if (e) hit = e.path
    }
    if (!hit) {
      const f = fb.find((x) => covers(x.ranges, c))
      if (f) hit = f.path
    }
    pick.set(c, hit)
    return hit
  }

  return function plan(svg) {
    svg = String(svg)
    if (!baseCover) {
      baseCover = []
      for (const file of base) baseCover = baseCover.concat(load(file))
      baseCover.sort((a, b) => a[0] - b[0])
    }
    const extra = new Set()
    let changed = false
    let out = ''
    for (const ch of svg) {
      const c = ch.codePointAt(0)
      if (c < 0x80) { out += ch; continue }
      if (isDropped(c)) { changed = true; continue }
      if (covers(baseCover, c)) { out += ch; continue }
      const f = fontFor(c)
      if (!f) { changed = true; continue }
      extra.add(f)
      out += ch
    }
    const order = fallback.map((file) => join(dir, file)).filter((p) => extra.has(p))
    return { svg: changed ? out : svg, files: base.map((file) => join(dir, file)).concat(order) }
  }
}
