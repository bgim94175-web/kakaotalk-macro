// 방 관리봇 기록 카드 — [입장 안내] · [퇴장 안내] · [프로필 변경 감지]를 그림 한 장으로(docs/ACCOUNTS_V1.md 7.2(a)(c)).
// 그리는 내용은 글 안내(roomfeat.visitNoticeText · profileChangeNotice 의 card)와 같다: 닉네임 · 옾링 · 기록(횟수 + 최근 시각).
// 모양: K bot 사이트와 같은 결 — 거의 검정 바탕 · 가는 선 · 흰 글 · 강조색 한 가지. 오른쪽 위에 낮은 대비의 궤도 그림 하나,
//   그 가운데에 K bot 로고(public/logo.svg 의 흰 K). 궤도는 K 를 둘러싸되 모두 K 뒤로 지나가(로고는 잘리지 않음) 강조색 점이 궤도를 돈다.
//   입장 = 바깥에서 감겨 들어와 궤도에 올라탄 점, 퇴장 = 궤도를 벗어나 멀어지는 점, 프로필 변경 = 궤도 위에서 자리를 옮긴 점.
//   강조색은 배지(옅게 물든 바탕 · 점 · 제목)와 궤도의 점(자취)에만 쓴다. 나머지는 흑백. 이름 칸 뒤에는 궤도를 지워 글이 늘 깨끗한 바탕 위에.
//   바닥의 K bot 서명도 같은 로고(회색) — 밝은 K 는 위 그림 하나뿐.
// 모서리는 각지게 둔다(카카오톡이 사진 모서리를 둥글게 깎는다. 투명한 모서리는 기기에 따라 검게 보인다).
// 순수 모듈: 같은 카드면 같은 SVG. PNG 는 card.mjs(resvg + Pretendard + 대체 글꼴)가 2배 해상도(1440px)로 만든다 — 휴대폰에서도 또렷하게.
// 만들지 못하면 null → 부르는 쪽이 글로 보낸다.
import { esc, svgToPng, textWidth, FONT } from './card.mjs'
import { isDropped } from './glyphs.mjs'

export const CARD_W = 720 // SVG 폭(논리 크기)
export const PNG_SCALE = 2 // PNG 는 이 배수로 그린다(1440px)
const PAD = 44

// 종류마다 강조색 한 가지(사이트의 live 초록 · 빨강 · 보라)
export const ACCENT = Object.freeze({
  join: '#5FB878', // 입장
  leave: '#EF6A60', // 퇴장
  profile: '#A78BFA', // 프로필 변경
})

// 사이트 색(바탕 · 면 · 선 · 글)
const BG = '#09090B'
const S1 = '#0E0E11'
const S3 = '#1B1B1F'
const L1 = '#1F1F23'
const L2 = '#2A2A2F'
const L3 = '#3A3A40'
const FG = '#EDEDEF'
const FG2 = '#A1A1AA'
const FG3 = '#8B8B94'
const FG4 = '#5C5C64' // 선 · 아이콘만(글에는 대비가 모자람)
const FG4T = '#71717A' // 흐린 글(바탕 대비 4:1 이상)
const VALUE_DIM = new Set(['없음', '확인 못 함'])

const VERB = { join: '입장', leave: '퇴장', profile: '변경' }

// K bot 로고(public/logo.svg 의 흰 K, 480×480 칸). 네모 바탕은 빼고 글자 모양만 쓴다
const K_PATH = 'M97 379.9C98.4 377.6 102.8 370.8 104.3 368.8C107.9 363.7 113.9 356.9 119 351.9C129.6 341.7 141.9 333.3 155.2 327.5C162.6 324.3 173 321.1 180.1 320C181.1 319.8 182.1 319.6 182.4 319.4C182.8 319.1 183.4 317.7 184.6 313.8C185.6 311 187.3 305.5 188.6 301.6C189.9 297.8 192.6 289.6 194.6 283.4C196.6 277.2 199.1 269.6 200.1 266.6C201.1 263.6 203.5 256.2 205.5 250.2C210.3 235.6 211.7 231.3 212 230.4C212.3 229.9 212.9 229.4 215.4 228.3C220.6 225.7 224.3 224 226.7 222.8C228 222.2 230.4 221.1 232 220.3C233.6 219.6 235.9 218.4 237.2 217.8C238.5 217.2 240.9 216.1 242.5 215.3C244.1 214.6 246.4 213.4 247.7 212.8C249 212.2 251.4 211.1 253 210.3C254.6 209.6 256.9 208.4 258.2 207.8C259.5 207.2 261.9 206.1 263.5 205.3C265.1 204.6 267.4 203.5 268.6 202.9C272.7 200.9 275.8 199.5 280.5 197.2C283 196 285.1 195 285.1 195C285.2 195 287.5 193.9 290.4 192.5C293.2 191.1 295.6 190 295.6 190C295.7 190 297.6 189.1 300 187.9C303.7 186.1 304.6 185.6 305.6 184.5C307 183 307.4 182.6 322 166C327.1 160.2 333.9 152.5 337 149C343.3 141.9 365.8 116.4 375.3 105.6C378.7 101.8 382.6 97.3 384.1 95.6C386.6 92.8 387.1 92 386.5 92C386.3 92 384.7 92.7 382.9 93.6C381.1 94.5 378.3 95.8 376.8 96.6C375.2 97.3 372.4 98.6 370.6 99.5C368.8 100.4 366.2 101.6 364.9 102.3C363.5 102.9 360.6 104.3 358.4 105.4C356.2 106.4 353.5 107.7 352.5 108.2C351.5 108.7 348.9 109.9 346.8 110.9C344.6 112 341.7 113.4 340.2 114.1C338.8 114.7 336.2 116 334.5 116.8C332.8 117.6 330.1 118.9 328.6 119.6C326 120.9 323.1 122.3 316.3 125.5C314.6 126.4 312 127.6 310.6 128.3C309.2 128.9 306.4 130.3 304.4 131.3C302.3 132.2 299.6 133.6 298.2 134.2C296.9 134.8 294.4 136 292.5 136.9C290.6 137.8 288 139.1 286.6 139.8C285.2 140.4 282.7 141.6 280.9 142.5C277.4 144.2 273.4 146.1 268.3 148.5C266.6 149.4 263.9 150.7 262.4 151.4C260.9 152.1 258.1 153.4 256.1 154.4C254.2 155.3 251.4 156.7 249.9 157.4C248.4 158.1 245.7 159.4 244 160.2C233.2 165.4 233.4 165.3 233.2 164.8C233.1 164.7 233.7 162.6 234.5 160.2C235.3 157.8 236.9 152.8 238.1 149.1C239.3 145.4 240.7 141.2 241.1 139.9C241.6 138.5 242.9 134.3 244.1 130.6C245.3 126.9 246.9 122 247.7 119.8C249 115.7 249.2 114.9 248.8 114.6C248.6 114.6 247.7 114.7 246.7 115C245.7 115.3 243.9 115.8 242.6 116.2C241.4 116.5 239.9 116.9 239.2 117.1C238.6 117.3 237.5 117.6 236.8 117.8C235.1 118.3 226.1 120.8 223.7 121.5C220.8 122.4 218.7 122.9 216.8 123.5C214.2 124.2 204.5 126.9 202.4 127.5C198.8 128.6 197.3 129 195.4 129.5C194.3 129.8 192.7 130.3 191.9 130.5C191.1 130.7 187.9 131.6 184.9 132.5C181.8 133.3 178.6 134.2 177.8 134.5C176.9 134.8 174.5 135.4 172.5 136C170.5 136.5 168.1 137.2 167.1 137.5C166.2 137.8 163 138.7 160 139.5C157 140.4 153.9 141.2 153 141.5C152.1 141.7 150.5 142.2 149.5 142.5C148.5 142.8 146.8 143.2 145.9 143.5C142.8 144.4 134.7 146.7 133.1 147.1C132.3 147.3 130.9 147.7 130 148C128.5 148.4 122.6 150.1 119.8 150.9C117.1 151.6 108.5 154.1 107 154.5C106.1 154.8 104.2 155.3 102.9 155.6C98.7 156.8 99 157.1 104.2 157.3C106.2 157.4 113.2 157.7 119.8 158C126.3 158.3 134.5 158.6 138 158.7C141.5 158.9 148.2 159.2 152.9 159.4C163.1 159.8 173.1 160.2 176 160.3C178.6 160.3 179.1 160.5 178.9 161.5C178.8 161.8 175.2 172.7 170.9 185.6C166.6 198.6 156.5 228.9 148.5 253C140.5 277.1 133.8 297.2 133.6 297.6C133.5 298 132.1 299.7 130.6 301.2C129.1 302.8 126.3 305.8 124.4 307.9C122.5 309.9 119.7 312.9 118.2 314.4C115.2 317.5 114.7 318.1 114.8 318.5C114.9 318.8 115.9 318.3 120.7 315.7C123.3 314.2 124 314 124 314.6C124 314.8 122.9 317.4 120.5 322.9C120.4 323.1 119.5 325.2 118.5 327.5C117.5 329.8 116.6 331.9 116.5 332.1C116.4 332.4 115.5 334.5 114.5 336.8C113.5 339 112.6 341.1 112.5 341.4C112.4 341.6 111.5 343.7 110.5 346C109.5 348.3 108.6 350.4 108.5 350.6C108.3 351.1 105.1 358.5 104.5 359.9C101.1 367.7 96 379.5 95.4 380.9C94.9 381.9 94.9 382.3 95.3 382.2C95.5 382.2 96.2 381.2 97 379.9ZM357.5 348.6C357.5 348.5 357.1 348.1 356.7 347.9C356.3 347.6 355.5 347.1 355 346.8C354.5 346.5 353.7 346 353.1 345.7C351 344.6 345 340.4 341.9 337.9C336.4 333.5 330.8 327.7 326.6 322.1C323.9 318.6 321.6 315 318 308.8C314.7 303.2 308 291.6 307 289.9C306.8 289.5 304.7 286 302.5 282.2C300.3 278.4 296.7 272.1 294.5 268.3C292.2 264.5 288.9 258.7 286.9 255.4C285 252.1 283.2 249 283 248.6C282.8 248.2 281 245.1 279 241.8C277 238.4 275.2 235.3 275 234.9C274.8 234.5 273 231.4 271.1 228.1C266.8 220.7 266.6 220.4 265.9 220.6C265.7 220.7 262.5 222.2 259 223.8C255.5 225.4 252.1 227.1 251.4 227.4C250.7 227.7 247.3 229.3 243.8 230.9C240.2 232.6 236.8 234.2 236 234.6C235.2 234.9 233.7 235.6 232.6 236.1C231.5 236.6 228.6 238 226.1 239.2C223.7 240.3 221.3 241.4 221 241.6C220.2 242.1 220.1 242.8 220.7 243.7C221 244.1 224.4 250 228.4 256.9C232.3 263.8 235.8 269.7 236 270.1C236.2 270.5 240.5 278 245.5 286.6C250.5 295.3 254.8 302.7 255 303.1C255.2 303.5 259.1 310.3 263.6 318.1C268.1 326 272.1 332.9 272.6 333.6C273.4 334.9 273.2 334.9 276.9 334.3C279.3 333.8 285.9 333.3 288.4 333.3C290.9 333.2 299.2 333.9 302 334.3C303 334.4 304.9 334.7 306.2 334.9C310.6 335.5 319.7 337.3 324.5 338.6C325.3 338.8 327.2 339.3 328.8 339.8C332.5 340.8 334.4 341.3 337.1 342.1C339.4 342.8 351.6 346.8 355 348C357 348.8 357.5 348.9 357.5 348.6Z'
const K_BOX = { cx: 241, cy: 237.2, h: 290.3 } // K 모양의 가운데 · 높이(480 칸 기준)

// 봇은 Pretendard 로 그린다. 체험 화면(브라우저가 같은 SVG 를 그림)에는 그 글꼴이 없을 수 있어 비슷한 한글 글꼴을 뒤에 둔다.
const FAMILY = `${FONT}, 'Apple SD Gothic Neo', 'Malgun Gothic', 'Noto Sans KR', sans-serif`

const r1 = (n) => Math.round(n * 10) / 10
const r3 = (n) => Math.round(n * 1000) / 1000

function t(x, y, size, weight, fill, s, anchor, extra) {
  return `<text x="${r1(x)}" y="${r1(y)}" font-family="${FAMILY}" font-size="${size}" font-weight="${weight}" fill="${fill}"${anchor ? ` text-anchor="${anchor}"` : ''}${extra || ''}>${esc(s)}</text>`
}

// K 로고: 가운데 (cx, cy), 높이 h. 칠은 fill(색 또는 url(#…))
function kMark(cx, cy, h, fill, extra) {
  const k = h / K_BOX.h
  return `<use href="#kmark" transform="translate(${r1(cx - K_BOX.cx * k)} ${r1(cy - K_BOX.cy * k)}) scale(${r3(k)})" fill="${fill}"${extra || ''}/>`
}

// ── 글자 폭: Pretendard 의 실제 글자 폭(1/1000 em, resvg 로 잼). 말줄임 · 줄바꿈 · 배지 폭을 딱 맞게
const ADV_R = [251, 257, 379, 600, 607, 862, 609, 201, 341, 341, 471, 627, 258, 433, 254, 334, 596, 438, 587, 617, 624, 597, 613, 552, 606, 613, 254, 254, 627, 627, 627, 479, 880, 646, 619, 693, 686, 567, 557, 709, 706, 244, 516, 621, 533, 853, 718, 727, 604, 727, 608, 607, 611, 707, 646, 915, 612, 634, 595, 341, 334, 341, 442, 458, 469, 535, 591, 529, 591, 553, 337, 579, 563, 218, 218, 517, 218, 834, 557, 567, 579, 579, 350, 496, 351, 553, 529, 777, 513, 529, 513, 341, 306, 341, 627]
const ADV_B = [230, 307, 376, 624, 630, 960, 648, 197, 390, 390, 539, 653, 287, 449, 282, 371, 660, 469, 610, 639, 657, 627, 643, 575, 644, 643, 282, 282, 653, 653, 653, 538, 874, 718, 637, 724, 701, 589, 563, 732, 720, 266, 547, 663, 546, 883, 709, 753, 623, 754, 632, 630, 643, 704, 718, 999, 686, 695, 641, 390, 371, 390, 467, 489, 478, 558, 611, 563, 611, 574, 367, 608, 600, 257, 257, 558, 257, 879, 598, 590, 608, 608, 390, 539, 381, 597, 563, 819, 551, 563, 549, 390, 355, 390, 653]
const ADV_X = { '·': [254, 282], '…': [762, 847], '—': [957, 966], '–': [471, 479], '“': [439, 485], '”': [439, 485], '‘': [221, 264], '’': [221, 264], '→': [913, 922], '×': [627, 653], '※': [603, 786], '★': [964, 965], '♡': [871, 894] }

// Pretendard 에 없는 글자는 glyphs.mjs 가 고른 대체 글꼴(Noto · Unifont)로 그려진다. 그 글꼴들의 실제 글자 폭(hmtx)을 구간마다 재어
// 가장 넓은 값을 둔다(1/1000 em, 앞 구간이 먼저). 표에 없는 글자는 1300 — 대체 글자의 99% 가 이보다 좁다(✿ 840 · ୨ 834).
// U+2000 아래(라틴 확장 · 그리스 · 키릴 · 인도 글자 등)는 거의 다 1000 이하라 1000.
const FB_WIDE = [
  [0xa9c1, 0xa9c2, 1570], // ꧁ ꧂ (꾸민 닉네임에 가장 흔하다)
  [0xa980, 0xa9df, 2050], // 그 밖의 자바 문자(꧃ ꧄ 는 더 넓다)
  [0x1d400, 0x1d7ff, 1170], // 수학 문자(𝓚 𝐀 𝕂)
  [0x2e3a, 0x2e3b, 2900], // ⸺ ⸻ (두 · 세 칸 줄표)
  [0x131a9, 0x131aa, 850], // 𓆩 𓆪 (꾸밈에 흔하다)
  [0x13000, 0x1345f, 2050], // 그 밖의 이집트 상형 문자
  [0x2a0b, 0x2a0c, 1900], // ⨌
  [0x20dd, 0x20e4, 1750], // 감싸는 결합 문자(⃝ ⃞)
  [0x27f0, 0x27ff, 1700], // 긴 화살표(⟶ ⟹)
  [0x2b30, 0x2b4f, 1700], // ⬳
  [0x222c, 0x2233, 1550], // ∭
  [0x1ee00, 0x1eeff, 1500], // 아랍 수학 문자
  [0x1f700, 0x1f77f, 1500], // 연금술 기호
  [0x1f800, 0x1f8ff, 2650], // 보충 화살표
  [0x1f650, 0x1f67f, 1400], // 장식 딩뱃
  [0x1f5b0, 0x1f5ef, 1350],
  [0x1f000, 0x1faff, 1280], // 이모지(👍 😀 1270)
  [0x3300, 0x33ff, 2900], // 네모 단위 문자(㎯ ㎏)
  [0x10100, 0x102ff, 1550], // 에게 · 고대 그리스 숫자
  [0x2030, 0x2031, 1700], // ‰ ‱
  [0x20a0, 0x20cf, 1400], // 통화 기호(₯)
  [0x2150, 0x218f, 1550], // 로마 숫자(Ⅷ)
  [0x25a0, 0x25ff, 1400], // 도형(◯)
  [0x2b00, 0x2b2f, 1400], // ⬜
  [0x2600, 0x26ff, 1390], // 기호(⛟)
  [0x2300, 0x23ff, 1370], // 기술 기호(⏥)
  [0x2900, 0x2aff, 1340], // 수학 화살표 · 연산자
  [0xa640, 0xa7ff, 1350], // 키릴 · 라틴 확장(ꚘꝎ)
  [0x1100, 0x11ff, 1000], // 옛 한글 자모 · 채움 문자(대체 글꼴)
  [0x3130, 0x318f, 1000], // 한글 호환 자모(ㅤ 채움 문자 등)
  [0x01c4, 0x01cc, 1350], // 두 글자 라틴(Ǆ ǈ ǋ)
  [0x01f1, 0x01f3, 1350], // Ǳ
  [0x01f6, 0x01f7, 1100], // Ƕ
  [0x02a3, 0x02ab, 1250], // 국제음성기호 합자(ʥ)
  [0x0400, 0x045f, 1100], // 키릴(Љ Њ)
  [0x0460, 0x04ff, 1350], // 옛 키릴(Ѹ)
  [0x0500, 0x06ff, 1450], // 키릴 보충 · 아랍(Ԫ ص)
  [0x0b00, 0x0b7f, 1300], // 오리야 문자(୨ ୧)
  [0x1400, 0x167f, 1450], // 캐나다 원주민 문자(ᐟ ᙱ)
  [0x18b0, 0x18ff, 1200],
  [0x1f00, 0x1fff, 1100], // 그리스 확장
]

// 겹쳐 그리는 결합 문자(̶ 취소선 꾸밈 · 악센트 · 가나 탁점 등): 앞 글자 위에 얹혀 폭이 없다(렌더러가 0 으로 민다)
const MARK = /^\p{Mn}$/u

function fallbackAdv(c) {
  if (isDropped(c)) return 0
  for (const [a, b, w] of FB_WIDE) if (c >= a && c <= b) return w
  if (MARK.test(String.fromCodePoint(c))) return 0
  return c < 0x2000 ? 1000 : 1300
}

function adv(ch, bold) {
  const c = ch.codePointAt(0)
  if (c >= 32 && c < 127) return (bold ? ADV_B : ADV_R)[c - 32]
  if (c >= 0xac00 && c <= 0xd7a3) return 864
  const x = ADV_X[ch]
  if (x) return x[bold ? 1 : 0]
  if (MARK.test(ch)) return fallbackAdv(c)
  if ((c >= 0x3000 && c <= 0x30ff && c !== 0x303d) || (c >= 0xff00 && c <= 0xffef)) return 1000 // 가나 · 전각(Pretendard 938, 대체 글꼴 1000)
  // 한자(통합 · 확장 A · 호환 · 보조 평면 확장): 대체 글꼴(NotoSansJP · Unifont)에서 모두 1000
  if ((c >= 0x4e00 && c <= 0x9fff) || (c >= 0x3400 && c <= 0x4dbf) || (c >= 0xf900 && c <= 0xfaff) || (c >= 0x20000 && c <= 0x3ffff)) return 1000
  // 나머지(꾸민 닉네임의 기호 · 이모지 · 다른 글자): card.mjs 의 어림(charEm)보다 좁게 잡지 않고, 넓은 대체 글자는 잰 값으로
  return Math.max(textWidth(ch, 1000, bold), fallbackAdv(c))
}

/** 글 한 줄의 폭(px). ls = letter-spacing(렌더러는 글자 묶음마다 한 번 — 폭 없는 결합 문자 · 빠지는 글자는 세지 않는다) */
function tw(s, size, bold, ls) {
  let em = 0
  let n = 0
  for (const ch of String(s == null ? '' : s)) {
    const a = adv(ch, bold)
    em += a
    if (a) n++
  }
  return (em / 1000) * size * 1.01 + (ls || 0) * n
}

/** maxW 를 넘으면 뒤를 잘라 … 를 붙인다(끝 공백은 지운다) */
function fit(s, size, maxW, bold, ls) {
  const str = String(s == null ? '' : s)
  if (tw(str, size, bold, ls) <= maxW) return str
  let out = ''
  for (const ch of str) {
    if (tw(out + ch + '…', size, bold, ls) > maxW) break
    out += ch
  }
  return out.trimEnd() + '…'
}

/** 줄바꿈: 낱말(공백) 단위, 낱말이 너무 길면 글자 단위. '·' 같은 홀로 선 기호는 앞 낱말에 붙인다(줄 첫머리에 오지 않게). 최대 maxLines 줄 */
function wrapText(s, size, maxW, maxLines, bold) {
  const words = []
  for (const w of String(s == null ? '' : s).replace(/\s+/g, ' ').trim().split(' ')) {
    if (words.length && /^[·•|:;,.!?)\]}…—–-]+$/.test(w)) words[words.length - 1] += ' ' + w
    else if (w) words.push(w)
  }
  const lines = []
  let cur = ''
  for (const w of words) {
    const next = cur ? cur + ' ' + w : w
    if (tw(next, size, bold) <= maxW) {
      cur = next
      continue
    }
    if (cur) lines.push(cur)
    cur = w
    while (tw(cur, size, bold) > maxW) {
      let cut = ''
      for (const ch of cur) {
        if (tw(cut + ch, size, bold) > maxW) break
        cut += ch
      }
      if (!cut) break
      lines.push(cut)
      cur = cur.slice(cut.length)
    }
  }
  if (cur || !lines.length) lines.push(cur)
  const max = Math.max(1, maxLines || lines.length)
  if (lines.length <= max) return lines
  const kept = lines.slice(0, max)
  kept[max - 1] = fit(kept[max - 1] + ' ' + lines[max] + '…', size, maxW, bold)
  if (!kept[max - 1].endsWith('…')) kept[max - 1] = fit(kept[max - 1], size, maxW - tw('…', size, bold), bold) + '…'
  return kept
}

// 두 색 섞기(#RRGGBB, k = 0 → a, 1 → b)
function mix(a, b, k) {
  const p = (h, i) => parseInt(h.slice(1 + i * 2, 3 + i * 2), 16)
  let out = '#'
  for (let i = 0; i < 3; i++) out += Math.round(p(a, i) + (p(b, i) - p(a, i)) * k).toString(16).padStart(2, '0')
  return out.toUpperCase()
}

// 이름의 첫 글자(동그라미). 꾸밈 기호(꧁ ୨ ✿ …)는 건너뛰고 첫 한글 → 영문·숫자 → 다른 글자, 없으면 첫 글자(그것도 없으면 ?)
function initialOf(name) {
  const chars = [...String(name || '').trim()]
  const ch = chars.find((x) => /[가-힣]/.test(x)) || chars.find((x) => /[A-Za-z0-9]/.test(x)) ||
    chars.find((x) => /[\p{L}\p{N}]/u.test(x) && !/[\u0b00-\u0b7f\ua980-\ua9df]/.test(x)) || chars[0] || '?'
  return /[a-z]/.test(ch) ? ch.toUpperCase() : ch
}

// ── 궤도 그림 ───────────────────────────────────────────────────────────────
// 기울어진 타원(궤도) 위의 점. a 는 라디안(0 = 오른쪽 끝, π/2 = 앞, π = 왼쪽 끝, 3π/2 = 뒤)
// K 는 배지와 윗선을 맞춘다(K 위 = 배지 위 = 42).
const K_H = 82 // 가운데 K 로고 높이
export const FRAME = 2.5 // 겉 테두리(흰 선) 굵기
export const FRAME_R = 24 // 겉 테두리 모서리 둥글기
const SYS = { cx: 604, cy: 42 + K_H / 2, rot: -15, flat: 0.27 }
const RINGS = [84, 132, 190, 258, 336]

function ept(rx, a) {
  const ry = rx * SYS.flat
  const r = (SYS.rot * Math.PI) / 180
  const x = rx * Math.cos(a)
  const y = ry * Math.sin(a)
  return [SYS.cx + x * Math.cos(r) - y * Math.sin(r), SYS.cy + x * Math.sin(r) + y * Math.cos(r)]
}

function arcPath(rx, a0, a1, n) {
  const k = n || 48
  let d = ''
  for (let i = 0; i <= k; i++) {
    const [x, y] = ept(rx, a0 + ((a1 - a0) * i) / k)
    d += (i ? 'L' : 'M') + r1(x) + ' ' + r1(y)
  }
  return d
}

// 궤도의 점: 배지의 점과 같은 모양(납작한 강조색 점 + 가는 고리)
function dot(x, y, r, ring, accent) {
  return `<circle cx="${r1(x)}" cy="${r1(y)}" r="${ring}" fill="none" stroke="${accent}" stroke-opacity="0.35" stroke-width="1"/>` +
    `<circle cx="${r1(x)}" cy="${r1(y)}" r="${r}" fill="${accent}"/>`
}

/**
 * 오른쪽 위 궤도 그림. 궤도는 모두 K 뒤에 그린다(로고는 잘리지 않는다). K 앞을 지나는 것은 없다.
 * hide = 이름 칸({x1, y0}): 그 왼쪽 아래는 궤도를 부드럽게 지워 이름 · 설명 줄이 늘 깨끗한 바탕 위에 놓인다.
 */
function orbitArt(kind, accent, H, hide) {
  const back = [] // K 뒤
  const top = [] // K 위(궤도의 점 · 자취)
  const ringOp = (i) => r3(0.13 - i * 0.022)
  // 별(아주 흐리게)
  for (const [x, y, r, op] of [[436, 30, 1.1, 0.3], [700, 168, 1.1, 0.24], [522, 196, 1, 0.16], [688, 22, 1.3, 0.32], [560, 14, 0.9, 0.2], [372, 92, 0.9, 0.16], [650, 230, 0.9, 0.14]]) {
    back.push(`<circle cx="${x}" cy="${y}" r="${r}" fill="${FG}" fill-opacity="${op}"/>`)
  }
  RINGS.forEach((rx, i) => back.push(`<path d="${arcPath(rx, 0, 2 * Math.PI, 96)}Z" fill="none" stroke="${FG}" stroke-opacity="${ringOp(i)}" stroke-width="1.25"/>`))

  const ghost = (x, y, r) => `<circle cx="${r1(x)}" cy="${r1(y)}" r="${r}" fill="${BG}" stroke="${FG3}" stroke-opacity="0.8" stroke-width="1.25" stroke-dasharray="2.2 2.4"/>`
  // 점선 자취: 점마다 점점 진하게(o0 → o1)
  const dotted = (pts, o0, o1) => pts.map(([x, y], i) => `<circle cx="${r1(x)}" cy="${r1(y)}" r="1.4" fill="${accent}" fill-opacity="${r1((o0 + ((o1 - o0) * i) / Math.max(1, pts.length - 1)) * 100) / 100}"/>`).join('')
  // 궤도를 따라 빛나는 자취(a0 → a1, 점점 진하게)
  const glowArc = (rx, a0, a1, o0, o1, n) => {
    const k = n || 28
    for (let i = 0; i < k; i++) {
      const s0 = a0 + ((a1 - a0) * i) / k
      const s1 = a0 + ((a1 - a0) * (i + 1)) / k
      top.push(`<path d="${arcPath(rx, s0, s1, 3)}" fill="none" stroke="${accent}" stroke-opacity="${r3(o0 + ((o1 - o0) * (i + 1)) / k)}" stroke-width="1.8" stroke-linecap="round"/>`)
    }
  }

  if (kind === 'join') {
    // 넷째와 다섯째 궤도 사이에서 점선으로 감겨 들어와(어느 궤도도 가로지르지 않음) 넷째 궤도에 접선으로 올라탄다 → 짧게 빛나는 자취 → 점
    const rx = RINGS[3]
    const aIn = Math.PI * 1.29
    const aMoon = Math.PI * 1.37
    const p0 = ept(rx, aIn)
    const p1 = ept(rx, aIn + 0.01)
    const k = 1 / Math.hypot(p1[0] - p0[0], p1[1] - p0[1])
    const tg = [(p1[0] - p0[0]) * k, (p1[1] - p0[1]) * k]
    const S = ept(300, Math.PI * 1.15)
    const Cp = [p0[0] - tg[0] * 70, p0[1] - tg[1] * 70]
    const bez = (u) => [(1 - u) * (1 - u) * S[0] + 2 * (1 - u) * u * Cp[0] + u * u * p0[0], (1 - u) * (1 - u) * S[1] + 2 * (1 - u) * u * Cp[1] + u * u * p0[1]]
    top.push(dotted(Array.from({ length: 9 }, (_, i) => bez(i / 9)), 0.1, 0.62))
    glowArc(rx, aIn, aMoon, 0.4, 0.95, 10)
    const pm = ept(rx, aMoon)
    top.push(dot(pm[0], pm[1], 5, 8, accent))
  } else if (kind === 'leave') {
    // 넷째 궤도의 빈자리에서 접선을 따라 왼쪽으로 멀어진다(점선 자취, 작아지는 점)
    const rx = RINGS[3]
    const aGhost = Math.PI * 1.36
    const pg = ept(rx, aGhost)
    const pb = ept(rx, aGhost - 0.02)
    const dx = pb[0] - pg[0]
    const dy = pb[1] - pg[1]
    const k = 1 / Math.hypot(dx, dy)
    const dir = [dx * k, dy * k - 0.18]
    const end = [pg[0] + dir[0] * 150, pg[1] + dir[1] * 150]
    top.push(ghost(pg[0], pg[1], 5.5))
    const pts = Array.from({ length: 8 }, (_, i) => [pg[0] + dir[0] * (16 + (i * 122) / 7), pg[1] + dir[1] * (16 + (i * 122) / 7)])
    top.push(dotted(pts, 0.6, 0.12))
    top.push(dot(end[0], end[1], 4, 7, accent))
  } else {
    // 셋째 궤도에서 K 를 돌아 자리를 옮겼다(빈자리 → K 아래를 지나는 빛나는 자취 → 점) — K 와는 떨어져 지나간다
    const rx = RINGS[2]
    const aGhost = Math.PI * 1.12
    const aMoon = Math.PI * 0.4
    const pg = ept(rx, aGhost)
    const pm = ept(rx, aMoon)
    top.push(ghost(pg[0], pg[1], 5))
    glowArc(rx, aGhost - 0.06, aMoon, 0.04, 0.95, 36)
    top.push(dot(pm[0], pm[1], 5, 8, accent))
  }

  // 가운데 K: 뒤 궤도를 흐리게 덮는 어둠 → 위에서 아래로 조금 옅어지는 흰 K(발끝까지 또렷하게)
  const logo =
    `<circle cx="${SYS.cx}" cy="${SYS.cy}" r="${r1(K_H * 0.95)}" fill="url(#kvig)"/>` +
    kMark(SYS.cx, SYS.cy, K_H, 'url(#kfill)')
  const defs = [
    `<radialGradient id="kvig"><stop offset="0.35" stop-color="${BG}" stop-opacity="0.92"/><stop offset="1" stop-color="${BG}" stop-opacity="0"/></radialGradient>`,
    `<linearGradient id="kfill" x1="0.15" y1="0" x2="0.55" y2="1"><stop offset="0" stop-color="${FG}" stop-opacity="0.95"/><stop offset="0.6" stop-color="${FG}" stop-opacity="0.85"/><stop offset="1" stop-color="${FG}" stop-opacity="0.7"/></linearGradient>`,
    `<clipPath id="art"><rect width="${CARD_W}" height="${H}"/></clipPath>`,
    // 이름 칸 지우개: 흰 바탕에 검은 네모(가장자리를 흐리게) → 그 자리의 궤도 · 별 · 자취가 사라진다
    `<filter id="soft" x="-0.5" y="-1" width="2" height="3"><feGaussianBlur stdDeviation="14"/></filter>`,
    `<mask id="clear" maskUnits="userSpaceOnUse" x="0" y="0" width="${CARD_W}" height="${H}"><rect width="${CARD_W}" height="${H}" fill="#FFFFFF"/>` +
      `<rect x="-60" y="${r1(hide.y0)}" width="${r1(hide.x1 + 60)}" height="${r1(H - hide.y0 + 60)}" fill="#000000" filter="url(#soft)"/></mask>`,
  ]
  return { defs: defs.join(''), body: `<g clip-path="url(#art)"><g mask="url(#clear)">${back.join('')}${logo}${top.join('')}</g></g>` }
}

// 방 이름 앞 말풍선(선)
function roomIcon(x, y, color) {
  return `<path d="M${x + 3} ${y + 1}h10a3 3 0 0 1 3 3v6a3 3 0 0 1-3 3h-6l-3.5 3v-3h-0.5a3 3 0 0 1-3-3v-6a3 3 0 0 1 3-3z" fill="none" stroke="${color}" stroke-width="1.5" stroke-linejoin="round"/>`
}

// 이름 아래 설명 줄: 첫 방문 · N번째 입장/퇴장 · 바뀐 칸들
function subLine(kind, c, rec) {
  if (kind === 'profile') {
    const changed = (c.fields || []).map((f) => String((f && f.label) || '')).filter((l) => /변경후$/.test(l)).map((l) => l.replace(/\s*변경후$/, ''))
    if (changed.length) return changed.join(' · ') + ' 변경'
  }
  if (!rec) return ''
  if (rec.count === 1) return kind === 'join' ? '첫 방문' : `첫 ${VERB[kind]}`
  return `${rec.count}번째 ${VERB[kind]}`
}

// 글자 크기(논리 단위). 카톡 말풍선(폭 약 250pt)에서 0.35배쯤으로 보이므로 작은 글도 7pt 안팎이 되게 잡는다
const FS = { chip: 22, sub: 22, was: 19, label: 21, stat: 30, value: 22, time: 22, now: 17, foot: 20 }
const IN = 26 // 상자 안 왼쪽 여백(숫자 줄 · 옾링 표 · 최근 기록 글이 같은 선에서 시작)
// 이름 · 설명 줄 뒤에 바탕색 테두리 — 지우개 밖으로 나온 글자(체험 화면의 다른 글꼴 등)도 궤도 선이 글자 가장자리에서 멈춘다
const HALO = ` paint-order="stroke" stroke="${BG}" stroke-width="6" stroke-linejoin="round"`

/**
 * card: {kind:'join'|'leave'|'profile', title, name, before?, fields:[{label, value}], record:{label, count, times:[글]}|null, at:'오후 7:31'}
 * opt: {room: 방 이름}
 * → SVG 글(폭 720)
 */
export function logCardSvg(card, opt) {
  const c = card || {}
  const o = opt || {}
  const kind = VERB[c.kind] ? c.kind : 'join'
  const accent = ACCENT[kind]
  const W = CARD_W
  const X = PAD
  const R = W - PAD
  const inner = R - X
  const out = []
  const rec = c.record && c.record.times && c.record.times.length ? c.record : null

  // ── 머리: 강조색으로 옅게 물든 배지(점 + 제목) — 말풍선 크기에서도 입장 · 퇴장 · 변경이 한눈에 갈린다
  const title = fit(c.title || '', FS.chip, 330, true)
  const CH = 46
  const bw = 43 + tw(title, FS.chip, true) + 21
  out.push(`<rect x="${X + 0.75}" y="42.75" width="${r1(bw - 1.5)}" height="${CH - 1.5}" rx="${(CH - 1.5) / 2}" fill="${mix(BG, accent, 0.12)}" stroke="${mix(BG, accent, 0.45)}" stroke-width="1.5"/>`)
  out.push(dot(X + 24, 42 + CH / 2, 4.5, 8, accent))
  out.push(t(X + 43, 42 + CH / 2 + 7.6, FS.chip, 700, mix(accent, FG, 0.55), title))

  // ── 사람: 동그라미(첫 글자) + 큰 이름 + 작은 설명 줄(이름 묶음의 가운데 = 동그라미 가운데)
  const AV = 84
  const acx = X + AV / 2
  const acy = 174
  const nameless = !c.name || c.name === '이름 없음'
  const leave = kind === 'leave'
  out.push(`<circle cx="${acx}" cy="${acy}" r="${AV / 2}" fill="url(#av)"/>`)
  out.push(`<circle cx="${acx}" cy="${acy}" r="${AV / 2 - 0.75}" fill="none" stroke="${leave ? L3 : L2}" stroke-width="1.5"${leave ? ' stroke-dasharray="3.5 4.5"' : ''}/>`)
  if (nameless) {
    out.push(`<g fill="none" stroke="${FG4}" stroke-width="2" stroke-linecap="round"><circle cx="${acx}" cy="${acy - 8}" r="8.5"/><path d="M${acx - 16} ${acy + 18}c2.2-8.5 8.4-12.5 16-12.5s13.8 4 16 12.5"/></g>`)
  } else {
    out.push(t(acx, acy + 11, 31, 700, leave ? FG2 : FG, initialOf(c.name), 'middle'))
  }
  const nx = X + AV + 26
  const nameW = R - nx
  // 긴 이름은 글자를 조금 줄여 더 보여 주고, 그래도 길면 … 로 자른다
  const rawName = c.name || '이름 없음'
  let ns = 42
  while (ns > 32 && tw(rawName, ns, true, -0.02 * ns) > nameW) ns -= 2
  const nls = r1(-0.02 * ns)
  const name = fit(rawName, ns, nameW, true, nls)
  const sub = c.before ? '' : subLine(kind, c, rec)
  const ny = c.before || sub ? acy - 2 : acy + ns * 0.36
  out.push(t(nx, ny, ns, 700, nameless ? FG3 : leave ? '#D4D4D8' : FG, name, '', ` letter-spacing="${nls}"${HALO}`))
  let textEnd = nx + tw(name, ns, true, nls)
  const sy = acy + 33
  if (c.before) {
    // 변경전 이름: 줄을 긋지 않는다(꾸민 닉네임의 대체 글꼴 글자가 뭉개진다). 앞의 '변경전' 이 옛 이름임을 말해 준다
    const lab = '변경전'
    const lw = tw(lab, FS.was, true) + 12
    out.push(t(nx, sy, FS.was, 700, FG4T, lab, '', HALO))
    const before = fit(c.before, FS.sub, nameW - lw - 4, false)
    out.push(t(nx + lw, sy, FS.sub, 400, FG2, before, '', HALO))
    textEnd = Math.max(textEnd, nx + lw + tw(before, FS.sub, false))
  } else if (sub) {
    const s = fit(sub, FS.sub, nameW)
    out.push(t(nx, sy, FS.sub, 400, FG2, s, '', HALO))
    textEnd = Math.max(textEnd, nx + tw(s, FS.sub, false))
  }
  let y = acy + AV / 2 + 38
  const artH = y
  const nameTop = ny - ns * 0.8

  // ── 숫자 줄: 날짜 · 시각 · 기록 횟수(가는 세로선으로 나눔)
  if (rec) {
    const last = String(rec.times[rec.times.length - 1] || '')
    const sp = last.search(/ 오[전후] /)
    const date = sp > 0 ? last.slice(0, sp) : ''
    const cols = [
      ['날짜', date || '—'],
      [`${VERB[kind]} 시각`, c.at || (sp > 0 ? last.slice(sp + 1) : last) || '—'],
      [rec.label || '기록', `${rec.count}회`],
    ]
    const BH = 112
    out.push(`<rect x="${X + 0.75}" y="${y + 0.75}" width="${inner - 1.5}" height="${BH - 1.5}" rx="12" fill="${S1}" stroke="url(#edge)" stroke-width="1.5"/>`)
    const cw = inner / 3
    cols.forEach(([lab, val], i) => {
      const cx = X + cw * i + IN
      if (i) out.push(`<line x1="${r1(X + cw * i)}" y1="${y + 26}" x2="${r1(X + cw * i)}" y2="${y + BH - 26}" stroke="${L2}" stroke-width="1.5"/>`)
      out.push(t(cx, y + 42, FS.label, 400, FG3, fit(lab, FS.label, cw - IN - 16)))
      out.push(t(cx, y + 85, FS.stat, 700, FG, fit(val, FS.stat, cw - IN - 16, true, -0.3), '', ' letter-spacing="-0.3"'))
    })
    y += BH + 14
  }

  // ── 칸(옾링 · 옾링 변경전/후 · 상태 메시지): 표 한 장, 줄 사이 가는 선. 변경전 값은 흐리게
  const fields = (c.fields || []).filter((f) => f && f.label)
  if (fields.length) {
    const lw = Math.min(196, Math.max(...fields.map((f) => tw(f.label, FS.label, false)))) + 28
    const vx = X + IN + lw
    const vw = R - IN - vx
    const rows = fields.map((f) => {
      const v = String(f.value == null ? '' : f.value)
      const dim = VALUE_DIM.has(v)
      const was = /변경전$/.test(f.label)
      const bold = !dim && !was
      // 띄어쓰기 없는 값(옾링 주소)은 줄을 나누지 않고 조금 줄여 한 줄로(끝 한두 글자만 아랫줄로 떨어지지 않게)
      let size = FS.value
      if (!/\s/.test(v)) while (size > 18 && tw(v, size, bold) > vw) size -= 0.5
      return { f, v, dim, was, bold, size, lines: wrapText(v, size, vw, 2, bold) }
    })
    const LH = 31
    const rowH = (r) => 38 + r.lines.length * LH
    const BH = rows.reduce((s, r) => s + rowH(r), 0)
    out.push(`<rect x="${X + 0.75}" y="${y + 0.75}" width="${inner - 1.5}" height="${BH - 1.5}" rx="12" fill="${S1}" stroke="url(#edge)" stroke-width="1.5"/>`)
    let ry = y
    rows.forEach((r, i) => {
      if (i) out.push(`<line x1="${X + 1.5}" y1="${ry}" x2="${R - 1.5}" y2="${ry}" stroke="${L1}" stroke-width="1.5"/>`)
      out.push(t(X + IN, ry + 43, FS.label, 400, FG3, fit(r.f.label, FS.label, lw - 12)))
      r.lines.forEach((line, j) => out.push(t(vx, ry + 43.5 + j * LH, r.size, r.bold ? 700 : 400, r.dim ? FG4T : r.was ? FG3 : FG, line)))
      ry += rowH(r)
    })
    y += BH + 14
  }

  // ── 최근 기록: 세로선 위 시각들, 마지막이 이번(두 번 이상일 때)
  if (rec && rec.times.length > 1) {
    const n = rec.times.length
    y += 28
    out.push(t(X, y, FS.label, 400, FG3, '최근 기록'))
    if (rec.count > n) out.push(t(R, y, FS.label, 400, FG4T, `${rec.count}회 중 최근 ${n}회`, 'end'))
    const STEP = 42
    const top = y + 36
    out.push(`<line x1="${X + 6}" y1="${top}" x2="${X + 6}" y2="${top + (n - 1) * STEP}" stroke="${L2}" stroke-width="1.5"/>`)
    rec.times.forEach((when, i) => {
      const cy = top + i * STEP
      const last = i === n - 1
      if (last) out.push(`<circle cx="${X + 6}" cy="${cy}" r="5" fill="${FG}"/>`)
      else out.push(`<circle cx="${X + 6}" cy="${cy}" r="3.5" fill="${BG}" stroke="${L3}" stroke-width="1.5"/>`)
      const s = fit(when, FS.time, inner - 130, last)
      out.push(t(X + IN, cy + 7.8, FS.time, last ? 700 : 400, last ? FG : FG3, s))
      if (last) {
        const lx = X + IN + tw(s, FS.time, true) + 12
        out.push(`<rect x="${r1(lx + 0.75)}" y="${cy - 14.25}" width="52.5" height="28.5" rx="7" fill="none" stroke="${L3}" stroke-width="1.5"/>`)
        out.push(t(lx + 27, cy + 6, FS.now, 700, FG2, '이번', 'middle'))
      }
    })
    y = top + (n - 1) * STEP + 6
  }

  // ── 바닥: 가는 선 · 방 이름 · 조용한 서명(K 로고 + K bot, 회색). 밝은 K 는 위 그림 하나뿐
  y += rec && rec.times.length > 1 ? 32 : 20
  out.push(`<line x1="0" y1="${y}" x2="${W}" y2="${y}" stroke="${L1}" stroke-width="1.5"/>`)
  y += 46
  const room = String(o.room || '').replace(/[\r\n]+/g, ' ').trim() || '오픈채팅방'
  const cap = FS.foot * 0.707 // Pretendard 대문자 높이
  out.push(roomIcon(X, y - cap / 2 - 8, FG4T))
  // 'K bot' 의 실제 폭(오른쪽 맞춤) → K 글자의 왼쪽 끝. 로고는 대문자 높이의 1.5배, 대문자 가운데 높이에, K 와 8 띄워
  let kAdv = 0
  for (const ch of 'K bot') kAdv += adv(ch, true)
  const kLeft = R - (kAdv / 1000) * FS.foot + FS.foot * 0.06
  const mh = r1(cap * 1.5)
  const mw = (mh * 292) / K_BOX.h
  out.push(kMark(kLeft - 8 - mw / 2, y - cap / 2, mh, FG2))
  out.push(t(R, y, FS.foot, 700, FG2, 'K bot', 'end'))
  out.push(t(X + 28, y, FS.foot, 400, FG3, fit(room, FS.foot, kLeft - 8 - mw - 36 - (X + 28))))
  const H = y + 34

  // 이름 칸(이름 · 설명 줄의 실제 폭 + 24, 위는 이름 윗선 조금 위부터)은 궤도를 지운다
  const art = orbitArt(kind, accent, artH, { x1: Math.min(W, textEnd + 24), y0: nameTop - 8 })
  const defs = `<defs>` +
    `<path id="kmark" d="${K_PATH}"/>` +
    `<radialGradient id="av" cx="0.34" cy="0.28" r="0.9"><stop offset="0" stop-color="${S3}"/><stop offset="1" stop-color="${S1}"/></radialGradient>` +
    `<linearGradient id="edge" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${L3}"/><stop offset="0.5" stop-color="${L2}"/><stop offset="1" stop-color="${L1}"/></linearGradient>` +
    art.defs + `</defs>`
  // 겉 테두리: 둥근 카드에 흰 선. 둥근 모서리 밖은 투명이고, 그림·글은 카드 안으로 자른다
  const frame = `<clipPath id="frame"><rect width="${W}" height="${H}" rx="${FRAME_R}"/></clipPath>`
  const edge = `<rect x="${FRAME / 2}" y="${FRAME / 2}" width="${W - FRAME}" height="${r1(H - FRAME)}" rx="${FRAME_R - FRAME / 2}" fill="none" stroke="#FFFFFF" stroke-width="${FRAME}"/>`
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${defs.replace('</defs>', frame + '</defs>')}` +
    `<g clip-path="url(#frame)"><rect width="${W}" height="${H}" fill="${BG}"/>${art.body}${out.join('')}</g>${edge}</svg>`
}

/** 카드 → PNG Buffer(폭 1440 = 2배). 렌더러가 없거나 실패하면 null */
export function logCardPng(card, opt) {
  if (!card) return null
  return svgToPng(logCardSvg(card, opt), CARD_W * PNG_SCALE)
}
