// 방 관리봇 기록 카드 — [입장 안내] · [퇴장 안내] · [프로필 변경 감지]를 그림 한 장으로(docs/ACCOUNTS_V1.md 7.2(a)(c)).
// 그리는 내용은 글 안내(roomfeat.visitNoticeText · profileChangeNotice 의 card)와 같다: 닉네임 · 옾링 · 기록(횟수 + 최근 시각).
// 모서리는 각지게 둔다(카카오톡이 사진 모서리를 둥글게 깎는다. 투명한 모서리는 기기에 따라 검게 보인다).
// 순수 모듈: 같은 카드면 같은 SVG. PNG 는 card.mjs(resvg + Pretendard)가 2배 해상도(1440px)로 만든다 — 휴대폰에서도 또렷하게.
// 만들지 못하면 null → 부르는 쪽이 글로 보낸다.
import { esc, svgToPng, textWidth, wrap, ellipsis, FONT } from './card.mjs'

export const CARD_W = 720 // SVG 폭(논리 크기)
export const PNG_SCALE = 2 // PNG 는 이 배수로 그린다(1440px)
const PAD = 44

// 종류마다 색 한 벌(어두운 바탕 + 밝은 강조 두 가지)
export const ACCENT = Object.freeze({
  join: '#34D399', // 입장 — 에메랄드
  leave: '#FB7185', // 퇴장 — 로즈
  profile: '#A78BFA', // 프로필 변경 — 바이올렛
})
const THEME = {
  join: { bg0: '#03130E', bg1: '#08261D', a: ACCENT.join, b: '#22D3EE', ink: '#A7F3D0', mark: 'WELCOME', tag: 'ENTER LOG' },
  leave: { bg0: '#150A0E', bg1: '#2B1019', a: ACCENT.leave, b: '#FBBF24', ink: '#FECDD3', mark: 'GOODBYE', tag: 'EXIT LOG' },
  profile: { bg0: '#0A0820', bg1: '#1C1548', a: ACCENT.profile, b: '#60A5FA', ink: '#DDD6FE', mark: 'UPDATED', tag: 'PROFILE LOG' },
}
const WHITE = '#FFFFFF'
const TEXT2 = '#CBD5E1'
const TEXT3 = '#8B97AD'
const VALUE_DIM = new Set(['없음', '확인 못 함'])

// 봇은 Pretendard 로 그린다. 체험 화면(브라우저가 같은 SVG 를 그림)에는 그 글꼴이 없을 수 있어 비슷한 한글 글꼴을 뒤에 둔다.
const FAMILY = `${FONT}, 'Apple SD Gothic Neo', 'Malgun Gothic', 'Noto Sans KR', sans-serif`

function t(x, y, size, weight, fill, s, anchor, extra) {
  return `<text x="${x}" y="${y}" font-family="${FAMILY}" font-size="${size}" font-weight="${weight}" fill="${fill}"${anchor ? ` text-anchor="${anchor}"` : ''}${extra || ''}>${esc(s)}</text>`
}

const r1 = (n) => Math.round(n * 10) / 10

// 머리 아이콘(24 칸 기준, 선): 입장 = 들어오는 화살표, 퇴장 = 나가는 화살표, 프로필 = 사람 + 바뀜 화살표
function headIcon(kind, x, y, s, color) {
  const k = s / 24
  const g = (d) => `<g transform="translate(${x} ${y}) scale(${r1(k * 100) / 100})" fill="none" stroke="${color}" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round">${d}</g>`
  if (kind === 'leave') return g('<path d="M10 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h4"/><path d="M14 8l5 4-5 4"/><path d="M19 12H9"/>')
  if (kind === 'profile') return g('<circle cx="10" cy="8" r="3.5"/><path d="M3.5 20c.8-3.6 3.4-5.5 6.5-5.5 1.4 0 2.6.4 3.6 1"/><path d="M15.5 14.5a3.5 3.5 0 0 1 5.6.7"/><path d="M21.6 13v2.4h-2.4"/><path d="M21 19.5a3.5 3.5 0 0 1-5.6-.7"/><path d="M14.9 21v-2.4h2.4"/>')
  return g('<path d="M14 4h4a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-4"/><path d="M9 8l4 4-4 4"/><path d="M13 12H3"/>')
}

function linkIcon(x, y, s, color) {
  const k = s / 24
  return `<g transform="translate(${x} ${y}) scale(${r1(k * 100) / 100})" fill="none" stroke="${color}" stroke-width="2.4" stroke-linecap="round"><path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7"/><path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7"/></g>`
}

function clockIcon(x, y, s, color) {
  const k = s / 24
  return `<g transform="translate(${x} ${y}) scale(${r1(k * 100) / 100})" fill="none" stroke="${color}" stroke-width="2.4" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></g>`
}

// 반짝임(네 갈래 별)
function spark(x, y, s, color, op) {
  return `<path d="M${x} ${r1(y - s)} Q${x} ${y} ${r1(x + s)} ${y} Q${x} ${y} ${x} ${r1(y + s)} Q${x} ${y} ${r1(x - s)} ${y} Q${x} ${y} ${x} ${r1(y - s)} Z" fill="${color}" fill-opacity="${op}"/>`
}

// 이름의 첫 글자(동그라미). 꾸밈 기호(꧁ ୨ ✿ …)는 건너뛰고 첫 한글 → 영문·숫자 → 다른 글자, 없으면 첫 글자(그것도 없으면 ?)
function initialOf(name) {
  const chars = [...String(name || '').trim()]
  const ch = chars.find((x) => /[가-힣]/.test(x)) || chars.find((x) => /[A-Za-z0-9]/.test(x)) ||
    chars.find((x) => /[\p{L}\p{N}]/u.test(x) && !/[\u0b00-\u0b7f\ua980-\ua9df]/.test(x)) || chars[0] || '?'
  return /[a-z]/.test(ch) ? ch.toUpperCase() : ch
}

/**
 * card: {kind:'join'|'leave'|'profile', title, name, before?, fields:[{label, value}], record:{label, count, times:[글]}|null, at:'오후 7:31'}
 * opt: {room: 방 이름}
 * → SVG 글(폭 720)
 */
export function logCardSvg(card, opt) {
  const c = card || {}
  const o = opt || {}
  const kind = THEME[c.kind] ? c.kind : 'join'
  const th = THEME[kind]
  const W = CARD_W
  const X = PAD
  const R = W - PAD
  const inner = R - X
  const out = []

  // ── 머리: 아이콘 배지 · 영문 꼬리표 · 제목 · 시각
  out.push(`<rect x="${X}" y="40" width="52" height="52" rx="16" fill="url(#ac)"/>`)
  out.push(`<rect x="${X}" y="40" width="52" height="52" rx="16" fill="url(#gl)"/>`)
  out.push(headIcon(kind, X + 13, 53, 26, th.bg0))
  out.push(t(X + 70, 60, 14, 700, th.a, th.tag, '', ' letter-spacing="3"'))
  out.push(t(X + 70, 88, 28, 700, WHITE, c.title || ''))
  if (c.at) {
    const pw = textWidth(c.at, 20, true) + 58
    out.push(`<rect x="${R - pw}" y="46" width="${pw}" height="40" rx="20" fill="${WHITE}" fill-opacity="0.07" stroke="${WHITE}" stroke-opacity="0.14"/>`)
    out.push(clockIcon(R - pw + 16, 56, 20, th.a))
    out.push(t(R - 18, 73, 20, 700, WHITE, c.at, 'end'))
  }

  // ── 사람: 빛나는 고리 동그라미(첫 글자) + 이름 + 꼬리표
  let y = 132
  const AV = 128
  const acx = X + AV / 2
  const acy = y + AV / 2
  out.push(`<circle cx="${acx}" cy="${acy}" r="${AV / 2 + 18}" fill="${th.a}" fill-opacity="0.28" filter="url(#blur)"/>`)
  out.push(`<circle cx="${acx}" cy="${acy}" r="${AV / 2}" fill="url(#ring)"/>`)
  out.push(`<circle cx="${acx}" cy="${acy}" r="${AV / 2 - 6}" fill="url(#avbg)"/>`)
  out.push(t(acx, acy + 20, 56, 700, WHITE, initialOf(c.name), 'middle'))
  out.push(spark(acx + AV / 2 - 4, y + 10, 9, th.b, 0.95))
  out.push(spark(acx - AV / 2 + 6, y + AV - 6, 6, th.a, 0.8))
  const nx = X + AV + 30
  const nameW = R - nx
  const rec = c.record && c.record.times && c.record.times.length ? c.record : null
  const name = ellipsis(c.name || '이름 없음', 46, nameW, true)
  if (c.before) {
    out.push(t(nx, acy - 26, 16, 700, th.a, '변경전', '', ' letter-spacing="1"'))
    const bw = Math.min(nameW - 62, textWidth(c.before, 22) + 4)
    out.push(t(nx + 62, acy - 26, 22, 400, TEXT3, ellipsis(c.before, 22, nameW - 62)))
    out.push(`<line x1="${nx + 60}" y1="${acy - 33}" x2="${r1(nx + 62 + bw)}" y2="${acy - 33}" stroke="${TEXT3}" stroke-width="2"/>`)
    out.push(t(nx, acy + 26, 46, 700, WHITE, name))
    out.push(t(nx, acy + 60, 17, 700, th.ink, '새 프로필'))
  } else {
    out.push(t(nx, acy + 6, 46, 700, WHITE, name))
    if (rec) {
      const tag = `${rec.count}번째 ${kind === 'leave' ? '퇴장' : '입장'}`
      const tw = textWidth(tag, 18, true) + 30
      out.push(`<rect x="${nx}" y="${acy + 24}" width="${tw}" height="34" rx="17" fill="${th.a}" fill-opacity="0.16" stroke="${th.a}" stroke-opacity="0.55"/>`)
      out.push(t(nx + tw / 2, acy + 47, 18, 700, th.ink, tag, 'middle'))
      if (rec.count === 1 && kind === 'join') {
        const nw = textWidth('첫 방문', 18, true) + 30
        out.push(`<rect x="${nx + tw + 10}" y="${acy + 24}" width="${nw}" height="34" rx="17" fill="url(#ac)"/>`)
        out.push(t(nx + tw + 10 + nw / 2, acy + 47, 18, 700, th.bg0, '첫 방문', 'middle'))
      }
    }
  }
  y += AV + 36

  // ── 칸(옾링 · 옾링 변경전/후): 유리 상자 안에 아이콘 동그라미 + 라벨, 값(긴 주소는 두 줄까지)
  for (const f of c.fields || []) {
    const dim = VALUE_DIM.has(String(f.value))
    const lines = wrap(f.value, 23, inner - 96, 2, false)
    const boxH = 46 + lines.length * 32
    out.push(`<rect x="${X}" y="${y}" width="${inner}" height="${boxH}" rx="20" fill="${WHITE}" fill-opacity="0.06" stroke="${WHITE}" stroke-opacity="0.12"/>`)
    out.push(`<circle cx="${X + 38}" cy="${y + boxH / 2}" r="20" fill="${th.a}" fill-opacity="0.16"/>`)
    out.push(linkIcon(X + 27, y + boxH / 2 - 11, 22, th.a))
    out.push(t(X + 74, y + 34, 16, 700, TEXT3, f.label, '', ' letter-spacing="0.5"'))
    lines.forEach((line, i) => out.push(t(X + 74, y + 66 + i * 32, 23, dim ? 400 : 700, dim ? TEXT3 : WHITE, line)))
    y += boxH + 14
  }

  // ── 기록: 라벨 + 횟수, 최근 시각을 빛나는 점 타임라인으로. 마지막이 이번
  if (rec) {
    y += 16
    out.push(t(X, y + 8, 18, 700, TEXT2, rec.label))
    const cnt = `${rec.count}회`
    const cw = textWidth(cnt, 20, true) + 32
    out.push(`<rect x="${R - cw}" y="${y - 19}" width="${cw}" height="38" rx="19" fill="url(#ac)"/>`)
    out.push(t(R - cw / 2, y + 7, 20, 700, th.bg0, cnt, 'middle'))
    y += 28
    const n = rec.times.length
    const top = y + 24
    if (n > 1) out.push(`<rect x="${X + 10}" y="${top}" width="3" height="${(n - 1) * 46}" rx="1.5" fill="url(#vl)"/>`)
    rec.times.forEach((when, i) => {
      const cy = top + i * 46
      const last = i === n - 1
      if (last) out.push(`<circle cx="${X + 11.5}" cy="${cy}" r="14" fill="${th.a}" fill-opacity="0.35" filter="url(#blur)"/>`)
      out.push(`<circle cx="${X + 11.5}" cy="${cy}" r="${last ? 8 : 5.5}" fill="${last ? th.a : th.bg1}" stroke="${last ? WHITE : TEXT3}" stroke-width="2"/>`)
      out.push(t(X + 38, cy + 8, 23, last ? 700 : 400, last ? WHITE : TEXT3, when))
      if (last) {
        const lx = X + 38 + textWidth(when, 23, true) * 0.92 + 12
        out.push(`<rect x="${lx}" y="${cy - 15}" width="54" height="30" rx="15" fill="${th.a}" fill-opacity="0.18" stroke="${th.a}" stroke-opacity="0.6"/>`)
        out.push(t(lx + 27, cy + 6, 16, 700, th.ink, '이번', 'middle'))
      }
    })
    y = top + (n - 1) * 46 + 16
  }

  // ── 바닥: 그라디언트 선 · 방 이름 · K bot 표시
  y += 30
  out.push(`<rect x="${X}" y="${y}" width="${inner}" height="2" rx="1" fill="url(#hl)"/>`)
  y += 46
  const room = String(o.room || '').replace(/[\r\n]+/g, ' ').trim() || '오픈채팅방'
  out.push(`<path d="M${X + 4} ${y - 21}h20a5 5 0 0 1 5 5v10a5 5 0 0 1-5 5h-11l-6 5v-5h-3a5 5 0 0 1-5-5v-10a5 5 0 0 1 5-5z" fill="${TEXT3}"/>`)
  out.push(t(X + 40, y, 19, 500, TEXT2, ellipsis(room, 19, inner - 190)))
  const kw = textWidth('K bot', 19, true)
  out.push(`<rect x="${R - kw - 42}" y="${y - 24}" width="30" height="30" rx="9" fill="${WHITE}"/>`)
  out.push(t(R - kw - 27, y - 2, 18, 700, th.bg0, 'K', 'middle'))
  out.push(t(R, y, 19, 700, WHITE, 'K bot', 'end'))
  const H = y + 40

  const defs = `<defs>` +
    `<linearGradient id="bg" x1="0" y1="0" x2="0.4" y2="1"><stop offset="0" stop-color="${th.bg1}"/><stop offset="1" stop-color="${th.bg0}"/></linearGradient>` +
    `<radialGradient id="g1" cx="0.88" cy="0.06" r="0.62"><stop offset="0" stop-color="${th.a}" stop-opacity="0.42"/><stop offset="1" stop-color="${th.a}" stop-opacity="0"/></radialGradient>` +
    `<radialGradient id="g2" cx="0.04" cy="0.98" r="0.6"><stop offset="0" stop-color="${th.b}" stop-opacity="0.26"/><stop offset="1" stop-color="${th.b}" stop-opacity="0"/></radialGradient>` +
    `<linearGradient id="ac" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${th.a}"/><stop offset="1" stop-color="${th.b}"/></linearGradient>` +
    `<linearGradient id="gl" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${WHITE}" stop-opacity="0.35"/><stop offset="0.5" stop-color="${WHITE}" stop-opacity="0"/></linearGradient>` +
    `<linearGradient id="ring" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${th.a}"/><stop offset="0.55" stop-color="${th.b}"/><stop offset="1" stop-color="${th.a}"/></linearGradient>` +
    `<linearGradient id="avbg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${th.bg1}"/><stop offset="1" stop-color="${th.bg0}"/></linearGradient>` +
    `<linearGradient id="vl" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${TEXT3}" stop-opacity="0.3"/><stop offset="1" stop-color="${th.a}"/></linearGradient>` +
    `<linearGradient id="hl" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="${th.a}" stop-opacity="0"/><stop offset="0.5" stop-color="${th.a}" stop-opacity="0.7"/><stop offset="1" stop-color="${th.b}" stop-opacity="0"/></linearGradient>` +
    `<pattern id="dots" width="24" height="24" patternUnits="userSpaceOnUse"><circle cx="2" cy="2" r="1.2" fill="${WHITE}" fill-opacity="0.07"/></pattern>` +
    `<filter id="blur" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="14"/></filter>` +
    `<clipPath id="cc"><rect width="${W}" height="${H}"/></clipPath>` +
    `</defs>`
  const bgLayer = `<g clip-path="url(#cc)">` +
    `<rect width="${W}" height="${H}" fill="url(#bg)"/>` +
    `<rect width="${W}" height="${H}" fill="url(#g1)"/><rect width="${W}" height="${H}" fill="url(#g2)"/>` +
    `<rect width="${W}" height="${H}" fill="url(#dots)"/>` +
    t(W + 14, 214, 128, 700, WHITE, th.mark, 'end', ' fill-opacity="0.035" letter-spacing="-2"') +
    spark(W - 70, 128, 7, WHITE, 0.5) + spark(W - 132, 96, 4, WHITE, 0.35) + spark(W - 48, 196, 4, th.b, 0.6) +
    `</g>`
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${defs}${bgLayer}${out.join('')}</svg>`
}

/** 카드 → PNG Buffer(폭 1440 = 2배). 렌더러가 없거나 실패하면 null */
export function logCardPng(card, opt) {
  if (!card) return null
  return svgToPng(logCardSvg(card, opt), CARD_W * PNG_SCALE)
}
