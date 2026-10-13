// 방 관리봇 기록 카드 — [입장 안내] · [퇴장 안내] · [프로필 변경 감지]를 그림 한 장으로(docs/ACCOUNTS_V1.md 7.2(a)(c)).
// 그리는 내용은 글 안내(roomfeat.visitNoticeText · profileChangeNotice 의 card)와 같다: 닉네임 · 옾링 · 기록(횟수 + 최근 시각).
// 순수 모듈: 같은 카드면 같은 SVG. PNG 는 card.mjs(resvg + Pretendard)가 만든다. 만들지 못하면 null → 부르는 쪽이 글로 보낸다.
import { esc, svgToPng, textWidth, wrap, ellipsis, FONT } from './card.mjs'

export const CARD_W = 720
const PAD = 44

// 종류마다 머리 색. 글자는 흰색 위에서 읽기 쉬운 진한 색만 쓴다(카카오톡 밝은·어두운 화면 어디서나 흰 카드로 보인다).
export const ACCENT = Object.freeze({
  join: '#15803D',      // 입장 — 초록
  leave: '#475569',     // 퇴장 — 회색
  profile: '#4338CA',   // 프로필 변경 — 남색
})
const INK = '#111827'
const MUTED = '#6B7280'
const SOFT = '#9CA3AF'
const LINE = '#E5E7EB'
const BG = '#FFFFFF'
const VALUE_DIM = new Set(['없음', '확인 못 함'])

// 봇은 Pretendard 로 그린다. 체험 화면(브라우저가 같은 SVG 를 그림)에는 그 글꼴이 없을 수 있어 비슷한 한글 글꼴을 뒤에 둔다.
const FAMILY = `${FONT}, 'Apple SD Gothic Neo', 'Malgun Gothic', 'Noto Sans KR', sans-serif`

function t(x, y, size, weight, fill, s, anchor) {
  return `<text x="${x}" y="${y}" font-family="${FAMILY}" font-size="${size}" font-weight="${weight}" fill="${fill}"${anchor ? ` text-anchor="${anchor}"` : ''}>${esc(s)}</text>`
}

/**
 * card: {kind:'join'|'leave'|'profile', title, name, before?, fields:[{label, value}], record:{label, count, times:[글]}|null, at:'오후 7:31'}
 * opt: {room: 방 이름}
 * → SVG 글(폭 720)
 */
export function logCardSvg(card, opt) {
  const c = card || {}
  const o = opt || {}
  const accent = ACCENT[c.kind] || ACCENT.join
  const W = CARD_W
  const inner = W - PAD * 2
  const parts = []
  // 머리: 색 띠 + 제목 + 시각
  const headH = 88
  parts.push(`<rect x="0" y="0" width="${W}" height="${headH}" fill="${accent}"/>`)
  parts.push(t(PAD, 56, 32, 700, '#FFFFFF', c.title || ''))
  if (c.at) parts.push(t(W - PAD, 56, 26, 400, '#FFFFFF', c.at, 'end'))
  let y = headH + 30
  // 닉네임(크게). 프로필 변경은 위에 변경전 닉네임을 작게
  if (c.before) {
    y += 30
    parts.push(t(PAD, y, 24, 400, MUTED, '변경전'))
    parts.push(t(PAD + 92, y, 28, 400, MUTED, ellipsis(c.before, 28, inner - 92)))
    y += 22
    parts.push(t(PAD, y + 28, 24, 700, accent, '변경후'))
    y += 34
  }
  const nameLines = wrap(c.name || '이름 없음', 50, inner, 2, true)
  for (const line of nameLines) {
    y += 58
    parts.push(t(PAD, y, 50, 700, INK, line))
  }
  y += 22
  // 칸(옾링 · 옾링 변경전/후): 라벨은 작게, 값은 그 아래(긴 주소는 두 줄까지)
  for (const f of c.fields || []) {
    y += 30
    parts.push(t(PAD, y, 23, 700, MUTED, f.label))
    const dim = VALUE_DIM.has(String(f.value))
    for (const line of wrap(f.value, 28, inner, 2, false)) {
      y += 40
      parts.push(t(PAD, y, 28, 400, dim ? SOFT : INK, line))
    }
    y += 14
  }
  // 기록: `입장 기록` · `3회` · 최근 시각(옛 → 새, 마지막이 이번 — 굵게)
  const rec = c.record
  if (rec && rec.times && rec.times.length) {
    y += 20
    parts.push(`<rect x="${PAD}" y="${y}" width="${inner}" height="2" fill="${LINE}"/>`)
    y += 50
    parts.push(t(PAD, y, 24, 700, MUTED, rec.label))
    parts.push(t(W - PAD, y, 30, 700, accent, `${rec.count}회`, 'end'))
    const n = rec.times.length
    rec.times.forEach((when, i) => {
      y += 42
      const last = i === n - 1
      parts.push(`<circle cx="${PAD + 6}" cy="${y - 9}" r="5" fill="${last ? accent : LINE}"/>`)
      parts.push(t(PAD + 24, y, 27, last ? 700 : 400, last ? INK : MUTED, when))
    })
    y += 10
  }
  // 바닥: 방 이름(작게)
  y += 26
  parts.push(`<rect x="${PAD}" y="${y}" width="${inner}" height="2" fill="${LINE}"/>`)
  y += 44
  const room = String(o.room || '').replace(/[\r\n]+/g, ' ').trim()
  parts.push(t(PAD, y, 22, 400, SOFT, ellipsis(room || '오픈채팅방', 22, inner - textWidth('K bot', 22, true) - 24)))
  parts.push(t(W - PAD, y, 22, 700, SOFT, 'K bot', 'end'))
  const H = Math.ceil(y + 30)
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">` +
    `<rect x="0" y="0" width="${W}" height="${H}" fill="${BG}"/>${parts.join('')}</svg>`
}

/** 카드 → PNG Buffer(폭 720). 렌더러가 없거나 실패하면 null */
export function logCardPng(card, opt) {
  if (!card) return null
  return svgToPng(logCardSvg(card, opt), CARD_W)
}
