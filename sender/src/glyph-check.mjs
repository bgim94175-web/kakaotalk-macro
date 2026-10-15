// glyphs.mjs(카드 대체 글꼴) 검사: node src/glyph-check.mjs
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { FALLBACK, cmapRanges, covers, glyphPlanner, isDropped } from './glyphs.mjs'
import { available, svgToPng } from './card.mjs'
import { logCardPng } from './logcard.mjs'
import { profileChangeNotice, visitNoticeText } from './roomfeat.mjs'

const DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'assets', 'fonts')
const BASE = ['Pretendard-Regular.otf', 'Pretendard-Bold.otf']

// cmap 읽기: Pretendard 는 한글·영문을 갖고, 자바 문자·수학 문자·이모지는 없다(그래서 대체 글꼴이 필요하다)
const pre = cmapRanges(readFileSync(join(DIR, 'Pretendard-Bold.otf')))
assert.ok(pre.length > 10, 'Pretendard cmap read')
for (const ch of ['가', '힣', 'A', 'z', '0', '『', '★']) assert.ok(covers(pre, ch.codePointAt(0)), `Pretendard has ${ch}`)
for (const ch of ['꧁', '𝓚', '😀', 'ꕥ']) assert.ok(!covers(pre, ch.codePointAt(0)), `Pretendard lacks ${ch}`)
assert.deepEqual(cmapRanges(Buffer.from('not a font')), [], 'broken font -> no ranges')
for (const f of FALLBACK) assert.ok(cmapRanges(readFileSync(join(DIR, f))).length > 0, `fallback font readable: ${f}`)

// 글자마다 글꼴 고르기
const plan = glyphPlanner(DIR, BASE)
const files = (s) => plan(`<svg><text>${s}</text></svg>`).files.map((p) => p.split('/').pop())
assert.deepEqual(files('하늘 Kbot 123'), BASE, 'plain text -> Pretendard only (no extra font loading)')
assert.deepEqual(files('𝓚𝓐𝓚𝓐𝓞'), [...BASE, 'NotoSansMath.ttf'], 'math letters -> Noto Sans Math')
assert.deepEqual(files('꧁하늘꧂'), [...BASE, 'NotoSansJavanese.ttf'], 'Javanese ornaments')
assert.deepEqual(files('👍'), [...BASE, 'NotoEmoji.ttf'], 'emoji prefers the emoji font over Symbols2')
assert.deepEqual(files('漢字'), [...BASE, 'NotoSansJP.ttf'], 'Chinese characters')
assert.deepEqual(files('୨୧ ᐟ 𓆩♡𓆪'), [...BASE, 'NotoSansOriya.ttf', 'NotoSansCanadianAboriginal.ttf', 'NotoSansEgyptianHieroglyphs.ttf'], 'several scripts keep the fallback order')
assert.ok(files('ꕥ ᥫ᭡').includes('Unifont.otf'), 'rare scripts fall to Unifont')

// 혼자서는 모양이 없는 글자와 어느 글꼴에도 없는 글자는 뺀다(렌더러가 그 뒤 글자의 대체를 멈추지 않게)
for (const c of [0xfe0f, 0x1f3fb, 0x200d, 0x20e3, 0xfeff, 0xe0067]) assert.ok(isDropped(c), `dropped ${c.toString(16)}`)
assert.equal(plan('<text>❤️👍🏻</text>').svg, '<text>❤👍</text>', 'variation selector and skin tone removed')
assert.equal(plan('<text>👨‍👩‍👧</text>').svg, '<text>👨👩👧</text>', 'zero-width joiner removed')
const none = 0x10fffd
assert.ok(!FALLBACK.some((f) => covers(cmapRanges(readFileSync(join(DIR, f))), none)), 'test codepoint is in no font')
assert.equal(plan(`<text>가${String.fromCodePoint(none)}😀</text>`).svg, '<text>가😀</text>', 'glyph in no font removed, later glyphs kept')
const same = '<svg><text>하늘</text></svg>'
assert.equal(plan(same).svg, same, 'untouched svg returned as is')

// 실제 그림: 꾸민 닉네임 카드가 그려지고, 대체 글꼴 덕분에 빈 상자(.notdef)와 다른 그림이 나온다
if (available()) {
  const LINK = 'https://open.kakao.com/o/sAbc'
  const t = Date.UTC(2026, 9, 15, 12, 0)
  const join1 = visitNoticeText('join', { userId: '1', name: '꧁𝓚𝓐𝓚𝓐𝓞꧂ 백샤렌 ✿ 👍🏻❤️ ツ', link: LINK }, [t]).card
  const prof = profileChangeNotice({ userId: '2', name: '୨୧ ʚ하늘ɞ', link: LINK }, [{ kind: 'name', from: 'ꕥᥫ᭡ 하늘', to: '୨୧ ʚ하늘ɞ' }], [t]).card
  for (const c of [join1, prof]) {
    const png = logCardPng(c, { room: '『𝐊𝐀𝐊𝐀𝐎 ★ ꒰ 방 ꒱』' })
    assert.ok(png && png.length > 1000 && png.subarray(1, 4).toString() === 'PNG', 'decorated nickname card renders')
  }
  const svg = (s) => `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="60"><rect width="200" height="60" fill="#000"/><text x="10" y="45" font-size="40" fill="#fff">${s}</text></svg>`
  // 기본 글꼴만으로 그리면 빈 상자가 나오는 글자들 — 대체 글꼴로 그린 그림은 그것과 달라야 한다
  const { Resvg } = createRequire(import.meta.url)('@resvg/resvg-js')
  const baseOnly = (s) => new Resvg(svg(s), { font: { fontFiles: BASE.map((f) => join(DIR, f)), loadSystemFonts: false, defaultFontFamily: 'Pretendard' } }).render().asPng()
  for (const s of ['𝓚', '꧁', '😀', '漢']) assert.notDeepEqual(svgToPng(svg(s)), baseOnly(s), `${s} drawn with a fallback font, not an empty box`)
  assert.deepEqual(svgToPng(svg('가')), baseOnly('가'), 'plain Korean renders exactly as before')
}

console.log('glyph check ok')
