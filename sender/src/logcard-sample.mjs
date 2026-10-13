// 패널 미리 보기 그림(public/img/logcard-join.png · logcard-profile.png)을 지금 카드 모양으로 다시 만든다.
// 카드 모양(logcard.mjs)이나 안내 내용(roomfeat.visitNoticeText · profileChangeNotice)을 바꾸면 한 번 돌려 함께 올린다:
//   node sender/src/logcard-sample.mjs
// 패널의 글 미리 보기(public/panel.html #row-r-visit-notice · #row-r-profile-notice)와 같은 값이다.
import { mkdirSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import { available, unavailableReason } from './card.mjs'
import { logCardPng } from './logcard.mjs'
import { profileChangeNotice, visitNoticeText } from './roomfeat.mjs'

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'public', 'img')
const kst = (mo, d, h, mi) => Date.UTC(2026, mo - 1, d, h - 9, mi)
const LINK = 'https://open.kakao.com/o/sH7k2Lb'
const ROOM = 'K bot 체험방'

export const SAMPLES = {
  'logcard-join.png': visitNoticeText('join', { userId: '2001', name: '하늘', link: LINK }, [kst(10, 8, 20, 2), kst(10, 9, 21, 14)]).card,
  'logcard-profile.png': profileChangeNotice({ userId: '2001', name: '하늘_판매', link: LINK }, [{ kind: 'name', from: '하늘', to: '하늘_판매' }], [kst(10, 9, 21, 14)]).card,
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  if (!available()) {
    process.stderr.write('그림을 만들 수 없습니다: ' + unavailableReason() + '\n')
    process.exit(1)
  }
  mkdirSync(OUT, { recursive: true })
  for (const [name, card] of Object.entries(SAMPLES)) {
    const png = logCardPng(card, { room: ROOM })
    writeFileSync(join(OUT, name), png)
    process.stdout.write(`${name} ${png.length} bytes\n`)
  }
}
