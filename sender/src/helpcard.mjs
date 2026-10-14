// 명령어 목록·도움말 글 꾸미기(「!도움」·「!게임」·「!도움 관리」·「!강화도움」·「!몬스터」가 같은 모양).
// 이모지는 쓰지 않고(docs/TONE.md) 기호만 쓴다: 《 제목 》, ━ 줄, ◆ 묶음, ▸ 항목.
// 명령어 묶음은 휴대폰 말풍선 폭에 맞게 「 · 」로 이어 붙이다가 넘치면 다음 줄로 넘긴다.
// 패널 미리 보기(public/panel.js helpCard)도 같은 규칙으로 그린다.

export const RULE = '━━━━━━━━━━━━'
const WIDTH = 16 // 한 줄에 들어갈 어림 폭(한글 1, 그 밖은 0.6)

function width(s) {
  let w = 0
  for (const ch of String(s)) w += /[ㄱ-ㆎ가-힣]/.test(ch) ? 1 : 0.6
  return w
}

/** 명령어들을 「 · 」로 이어 줄마다 나눈다 */
export function packCommands(cmds) {
  const out = []
  let cur = ''
  for (const c of cmds) {
    const next = cur ? cur + ' · ' + c : c
    if (cur && width(next) > WIDTH) {
      out.push(cur)
      cur = c
    } else cur = next
  }
  if (cur) out.push(cur)
  return out
}

/**
 * title: 머리 제목. blocks: [{ name?, cmds?: [명령어], lines?: [글] }] — 빈 묶음은 뺀다. foot: 맨 아래 안내(없으면 생략).
 * 묶음 이름이 있으면 「◆ 이름」 아래 「 ▸ 」, 없으면 「▸ 」로 적는다. 묶음 사이는 빈 줄.
 */
export function helpCard(title, blocks, foot) {
  const lines = [`《 ${title} 》`, RULE]
  let first = true
  for (const b of blocks || []) {
    const items = packCommands((b && b.cmds) || []).concat((b && b.lines) || [])
    if (!items.length) continue
    if (!first && b.name) lines.push('')
    first = false
    if (b.name) lines.push(`◆ ${b.name}`)
    for (const it of items) lines.push((b.name ? ' ▸ ' : '▸ ') + it)
  }
  if (foot) lines.push(RULE, foot)
  return lines.join('\n')
}
