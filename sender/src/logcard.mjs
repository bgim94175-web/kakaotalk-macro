// 방 관리봇 기록 카드 — [입장 안내] · [퇴장 안내] · [프로필 변경 감지]를 그림 한 장으로(docs/ACCOUNTS_V1.md 7.2(a)(c)).
// 그리는 내용은 글 안내(roomfeat.visitNoticeText · profileChangeNotice 의 card)와 같다: 닉네임 · 옾링 · 기록(횟수 + 최근 시각).
// 순수 모듈: 같은 카드면 같은 SVG. PNG 는 card.mjs(resvg + Pretendard)가 만든다. 만들지 못하면 null → 부르는 쪽이 글로 보낸다.
import { esc, svgToPng, textWidth, wrap, ellipsis, FONT } from './card.mjs'

export const CARD_W = 720
const M = 22            // 바깥 여백(배경이 보이는 테두리)
const PAD = 40          // 카드 안쪽 여백

// 종류마다 색 한 벌: 머리 띠 그라디언트(a→b) · 바탕(bg1→bg2) · 옅은 칸(soft) · 강조 글(ink)
export const ACCENT = Object.freeze({
  join: '#16A34A',      // 입장 — 초록
  leave: '#64748B',     // 퇴장 — 회색
  profile: '#6366F1',   // 프로필 변경 — 보라
})
const THEME = {
  join:    { a: '#22C55E', b: '#15803D', bg1: '#ECFDF5', bg2: '#BBF7D0', soft: '#F0FDF4', line: '#BBF7D0', ink: '#15803D', glow: '#4ADE80' },
  leave:   { a: '#94A3B8', b: '#334155', bg1: '#F8FAFC', bg2: '#CBD5E1', soft: '#F8FAFC', line: '#E2E8F0', ink: '#334155', glow: '#94A3B8' },
  profile: { a: '#818CF8', b: '#4338CA', bg1: '#EEF2FF', bg2: '#C7D2FE', soft: '#EEF2FF', line: '#C7D2FE', ink: '#4338CA', glow: '#A5B4FC' },
}
const INK = '#0F172A'
const MUTED = '#64748B'
const SOFT = '#94A3B8'
const VALUE_DIM = new Set(['없음', '확인 못 함'])

// 봇은 Pretendard 로 그린다. 체험 화면(브라우저가 같은 SVG 를 그림)에는 그 글꼴이 없을 수 있어 비슷한 한글 글꼴을 뒤에 둔다.
const FAMILY = `${FONT}, 'Apple SD Gothic Neo', 'Malgun Gothic', 'Noto Sans KR', sans-serif`

function t(x, y, size, weight, fill, s, anchor, extra) {
  return `<text x="${x}" y="${y}" font-family="${FAMILY}" font-size="${size}" font-weight="${weight}" fill="${fill}"${anchor ? ` text-anchor="${anchor}"` : ''}${extra || ''}>${esc(s)}</text>`
}

// 머리 아이콘(24 칸 기준, 흰 선): 입장 = 문으로 들어오는 화살표, 퇴장 = 나가는 화살표, 프로필 = 사람 + 바뀜 화살표
function headIcon(kind, x, y, s) {
  const k = s / 24
  const g = (d) => `<g transform="translate(${x} ${y}) scale(${k})" fill="none" stroke="#FFFFFF" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">${d}</g>`
  if (kind === 'leave') return g('<path d="M10 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h4"/><path d="M14 8l5 4-5 4"/><path d="M19 12H9"/>')
  if (kind === 'profile') return g('<circle cx="10" cy="8" r="3.5"/><path d="M3.5 20c.8-3.6 3.4-5.5 6.5-5.5 1.4 0 2.6.4 3.6 1"/><path d="M15.5 14.5a3.5 3.5 0 0 1 5.6.7"/><path d="M21.6 13v2.4h-2.4"/><path d="M21 19.5a3.5 3.5 0 0 1-5.6-.7"/><path d="M14.9 21v-2.4h2.4"/>')
  return g('<path d="M14 4h4a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-4"/><path d="M9 8l4 4-4 4"/><path d="M13 12H3"/>')
}

// 작은 사슬 아이콘(옾링 칸)
function linkIcon(x, y, s, color) {
  const k = s / 24
  return `<g transform="translate(${x} ${y}) scale(${k})" fill="none" stroke="${color}" stroke-width="2.4" stroke-linecap="round"><path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7"/><path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7"/></g>`
}

// 이름의 첫 글자(프로필 동그라미). 한글·영문 첫 글자, 없으면 ?
function initialOf(name) {
  const ch = [...String(name || '').trim()][0] || '?'
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
  const CX = M                 // 카드 왼쪽
  const CW = W - M * 2         // 카드 폭
  const X = CX + PAD           // 글 왼쪽
  const R = CX + CW - PAD      // 글 오른쪽
  const inner = R - X
  const body = []
  // ── 머리 띠: 그라디언트 + 장식 동그라미 + 아이콘 + 제목 + 시각 알약
  const headH = 104
  const head = []
  head.push(`<rect x="${CX}" y="${M}" width="${CW}" height="${headH}" fill="url(#hd)"/>`)
  head.push(`<circle cx="${CX + CW - 40}" cy="${M - 10}" r="92" fill="#FFFFFF" fill-opacity="0.10"/>`)
  head.push(`<circle cx="${CX + CW - 150}" cy="${M + headH + 6}" r="54" fill="#FFFFFF" fill-opacity="0.07"/>`)
  head.push(`<circle cx="${X + 26}" cy="${M + headH / 2}" r="26" fill="#FFFFFF" fill-opacity="0.2"/>`)
  head.push(headIcon(kind, X + 13, M + headH / 2 - 13, 26))
  head.push(t(X + 68, M + headH / 2 + 12, 33, 700, '#FFFFFF', c.title || ''))
  if (c.at) {
    const pw = textWidth(c.at, 22, true) + 34
    head.push(`<rect x="${R - pw}" y="${M + headH / 2 - 21}" width="${pw}" height="42" rx="21" fill="#FFFFFF" fill-opacity="0.22"/>`)
    head.push(t(R - pw / 2, M + headH / 2 + 8, 22, 700, '#FFFFFF', c.at, 'middle'))
  }
  let y = M + headH + 40
  // ── 사람: 동그라미(첫 글자) + 이름 + 한 줄 설명(입장·퇴장 n번째 / 프로필 변경전 이름)
  const AV = 92
  const avX = X, avY = y
  body.push(`<circle cx="${avX + AV / 2}" cy="${avY + AV / 2}" r="${AV / 2 + 5}" fill="${th.soft}"/>`)
  body.push(`<circle cx="${avX + AV / 2}" cy="${avY + AV / 2}" r="${AV / 2}" fill="url(#av)"/>`)
  body.push(t(avX + AV / 2, avY + AV / 2 + 15, 40, 700, '#FFFFFF', initialOf(c.name), 'middle'))
  const nx = X + AV + 24
  const nameW = R - nx
  const name = ellipsis(c.name || '이름 없음', 42, nameW, true)
  const rec = c.record && c.record.times && c.record.times.length ? c.record : null
  if (c.before) {
    body.push(t(nx, avY + 30, 20, 700, SOFT, '변경전'))
    body.push(t(nx + 64, avY + 30, 22, 400, MUTED, ellipsis(c.before, 22, nameW - 64), '', ' text-decoration="line-through"'))
    body.push(t(nx, avY + 80, 42, 700, INK, name))
  } else {
    body.push(t(nx, avY + 50, 42, 700, INK, name))
    if (rec) {
      const tag = `${rec.count}번째 ${kind === 'leave' ? '퇴장' : '입장'}`
      const tw = textWidth(tag, 19, true) + 26
      body.push(`<rect x="${nx}" y="${avY + 64}" width="${tw}" height="32" rx="16" fill="${th.soft}" stroke="${th.line}" stroke-width="1.5"/>`)
      body.push(t(nx + tw / 2, avY + 86, 19, 700, th.ink, tag, 'middle'))
    }
  }
  y = avY + AV + 30
  // ── 칸(옾링 · 옾링 변경전/후): 옅은 상자 안에 사슬 아이콘 + 라벨, 값은 그 아래(긴 주소는 두 줄까지)
  for (const f of c.fields || []) {
    const dim = VALUE_DIM.has(String(f.value))
    const lines = wrap(f.value, 25, inner - 40, 2, false)
    const boxH = 58 + lines.length * 34
    body.push(`<rect x="${X}" y="${y}" width="${inner}" height="${boxH}" rx="18" fill="${th.soft}" stroke="${th.line}" stroke-width="1.5"/>`)
    body.push(linkIcon(X + 20, y + 16, 22, th.ink))
    body.push(t(X + 52, y + 34, 20, 700, th.ink, f.label))
    lines.forEach((line, i) => body.push(t(X + 20, y + 72 + i * 34, 25, dim ? 400 : 500, dim ? SOFT : INK, line)))
    y += boxH + 14
  }
  // ── 기록: 라벨 + 횟수 알약, 최근 시각을 세로 줄(타임라인)로. 마지막이 이번(굵게 + 「이번」)
  if (rec) {
    y += 18
    body.push(t(X, y + 8, 21, 700, MUTED, rec.label))
    const cnt = `${rec.count}회`
    const cw = textWidth(cnt, 22, true) + 30
    body.push(`<rect x="${R - cw}" y="${y - 20}" width="${cw}" height="38" rx="19" fill="url(#hd)"/>`)
    body.push(t(R - cw / 2, y + 7, 22, 700, '#FFFFFF', cnt, 'middle'))
    y += 30
    const n = rec.times.length
    const top = y + 22
    if (n > 1) body.push(`<rect x="${X + 9}" y="${top}" width="3" height="${(n - 1) * 44}" rx="1.5" fill="${th.line}"/>`)
    rec.times.forEach((when, i) => {
      const cy = top + i * 44
      const last = i === n - 1
      if (last) body.push(`<circle cx="${X + 10.5}" cy="${cy}" r="11" fill="${th.glow}" fill-opacity="0.35"/>`)
      body.push(`<circle cx="${X + 10.5}" cy="${cy}" r="${last ? 7 : 5.5}" fill="${last ? th.ink : '#FFFFFF'}" stroke="${last ? th.ink : SOFT}" stroke-width="2"/>`)
      body.push(t(X + 34, cy + 9, 25, last ? 700 : 400, last ? INK : MUTED, when))
      if (last) {
        const lx = X + 34 + textWidth(when, 25, true) * 0.92 + 10
        body.push(`<rect x="${lx}" y="${cy - 15}" width="52" height="30" rx="15" fill="${th.soft}" stroke="${th.line}" stroke-width="1.5"/>`)
        body.push(t(lx + 26, cy + 7, 17, 700, th.ink, '이번', 'middle'))
      }
    })
    y = top + (n - 1) * 44 + 18
  }
  // ── 바닥: 점선 · 방 이름(말풍선 아이콘) · K bot 표시
  y += 26
  body.push(`<line x1="${X}" y1="${y}" x2="${R}" y2="${y}" stroke="${th.line}" stroke-width="2" stroke-dasharray="6 7" stroke-linecap="round"/>`)
  y += 46
  const room = String(o.room || '').replace(/[\r\n]+/g, ' ').trim() || '오픈채팅방'
  body.push(`<path d="M${X} ${y - 22}h22a5 5 0 0 1 5 5v11a5 5 0 0 1-5 5h-12l-6 5v-5h-4a5 5 0 0 1-5-5v-11a5 5 0 0 1 5-5z" transform="translate(5 0)" fill="${SOFT}"/>`)
  body.push(t(X + 40, y, 20, 500, MUTED, ellipsis(room, 20, inner - 180)))
  const kw = textWidth('K bot', 20, true)
  body.push(`<rect x="${R - kw - 40}" y="${y - 25}" width="30" height="30" rx="9" fill="${INK}"/>`)
  body.push(t(R - kw - 25, y - 3, 19, 700, '#FFFFFF', 'K', 'middle'))
  body.push(t(R, y, 20, 700, INK, 'K bot', 'end'))
  const cardH = y + 30 - M
  const H = cardH + M * 2
  const defs = `<defs>` +
    `<linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${th.bg1}"/><stop offset="1" stop-color="${th.bg2}"/></linearGradient>` +
    `<linearGradient id="hd" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${th.a}"/><stop offset="1" stop-color="${th.b}"/></linearGradient>` +
    `<linearGradient id="av" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${th.a}"/><stop offset="1" stop-color="${th.b}"/></linearGradient>` +
    `<clipPath id="cc"><rect x="${CX}" y="${M}" width="${CW}" height="${cardH}" rx="30"/></clipPath>` +
    `<filter id="sh" x="-10%" y="-10%" width="120%" height="130%"><feDropShadow dx="0" dy="8" stdDeviation="10" flood-color="#0F172A" flood-opacity="0.16"/></filter>` +
    `<pattern id="dots" width="22" height="22" patternUnits="userSpaceOnUse"><circle cx="2" cy="2" r="1.6" fill="#FFFFFF" fill-opacity="0.55"/></pattern>` +
    `</defs>`
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${defs}` +
    `<rect width="${W}" height="${H}" fill="url(#bg)"/><rect width="${W}" height="${H}" fill="url(#dots)"/>` +
    `<rect x="${CX}" y="${M}" width="${CW}" height="${cardH}" rx="30" fill="#FFFFFF" filter="url(#sh)"/>` +
    `<g clip-path="url(#cc)">${head.join('')}</g>${body.join('')}</svg>`
}

/** 카드 → PNG Buffer(폭 720). 렌더러가 없거나 실패하면 null */
export function logCardPng(card, opt) {
  if (!card) return null
  return svgToPng(logCardSvg(card, opt), CARD_W)
}
