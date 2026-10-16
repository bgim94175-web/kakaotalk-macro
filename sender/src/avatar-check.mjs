// avatar.mjs(기록 카드 동그라미의 프로필 사진) 검사: node src/avatar-check.mjs
// 진짜 네트워크는 쓰지 않는다 — 가짜 fetch 가 그림을 준다.
import assert from 'node:assert/strict'
import { crc32 } from 'node:zlib'

import { Avatars, AVATAR_PX, avatarUrl, imageSize, sniff } from './avatar.mjs'
import { available, photoPng, svgToPng } from './card.mjs'

// ── 주소: https · 카카오 사진 서버만(끝이 같은 이름), http 는 https 로
assert.equal(avatarUrl('https://p.kakaocdn.net/th/talkp/a/b/img_s.jpg'), 'https://p.kakaocdn.net/th/talkp/a/b/img_s.jpg')
assert.equal(avatarUrl('http://th-p.talk.kakao.co.kr/th/talkp/x.jpg'), 'https://th-p.talk.kakao.co.kr/th/talkp/x.jpg', 'http upgraded to https')
assert.equal(avatarUrl(' https://k.kakaocdn.net/dn/p/1.jpg?s=small#x '), 'https://k.kakaocdn.net/dn/p/1.jpg?s=small', 'trimmed, hash dropped')
assert.equal(avatarUrl('https://kakaocdn.net/a.jpg'), 'https://kakaocdn.net/a.jpg', 'bare allowed domain')
assert.equal(avatarUrl('https://img1.daumcdn.net/a.jpg'), 'https://img1.daumcdn.net/a.jpg')
assert.equal(avatarUrl('https://k.kakaocdn.net:443/a.jpg'), 'https://k.kakaocdn.net/a.jpg', 'default port ok')
for (const bad of [
  '', null, 'not a url', 'ftp://k.kakaocdn.net/a.jpg', 'data:image/png;base64,AAAA', 'javascript:alert(1)', 'file:///etc/passwd',
  'https://evil.com/a.jpg', 'https://kakaocdn.net.evil.com/a.jpg', 'https://evilkakaocdn.net/a.jpg', 'https://k.kakaocdn.net:8443/a.jpg',
  'https://user:pw@k.kakaocdn.net/a.jpg', 'https://127.0.0.1/a.jpg', 'https://[::1]/a.jpg', 'https://10.0.0.1/a.jpg',
]) assert.equal(avatarUrl(bad), '', 'refused: ' + bad)
assert.equal(avatarUrl('https://p.kakaocdn.net/a.jpg', []), '', 'empty host list = no photos')
assert.equal(avatarUrl('https://img.example.org/a.jpg', ['example.org']), 'https://img.example.org/a.jpg', 'custom host list')

// ── 그림 바이트(PIL 로 만든 작은 그림들)
const b64 = (s) => Buffer.from(s, 'base64')
const JPEG = b64('/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAYEBQYFBAYGBQYHBwYIChAKCgkJChQODwwQFxQYGBcUFhYaHSUfGhsjHBYWICwgIyYnKSopGR8tMC0oMCUoKSj/2wBDAQcHBwoIChMKChMoGhYaKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCj/wAARCAAQABgDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDTooor7I/CgooooA//2Q==') // 24×16
const PJPEG = b64('/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAYEBQYFBAYGBQYHBwYIChAKCgkJChQODwwQFxQYGBcUFhYaHSUfGhsjHBYWICwgIyYnKSopGR8tMC0oMCUoKSj/2wBDAQcHBwoIChMKChMoGhYaKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCj/wgARCAAQABADASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAT/xAAVAQEBAAAAAAAAAAAAAAAAAAAFBv/aAAwDAQACEAMQAAABpDMJ/8QAFBABAAAAAAAAAAAAAAAAAAAAIP/aAAgBAQABBQIf/8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAwEBPwF//8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAgEBPwF//8QAFBABAAAAAAAAAAAAAAAAAAAAIP/aAAgBAQAGPwIf/8QAFBABAAAAAAAAAAAAAAAAAAAAIP/aAAgBAQABPyEf/9oADAMBAAIAAwAAABD3/8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAwEBPxB//8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAgEBPxB//8QAFBABAAAAAAAAAAAAAAAAAAAAIP/aAAgBAQABPxAf/9k=') // 16×16 progressive
const CMYK = b64('/9j/7gAOQWRvYmUAZAAAAAAA/9sAQwAGBAUGBQQGBgUGBwcGCAoQCgoJCQoUDg8MEBcUGBgXFBYWGh0lHxobIxwWFiAsICMmJykqKRkfLTAtKDAlKCko/8AAFAgAEAAQBEMRAE0RAFkRAEsRAP/EAB8AAAEFAQEBAQEBAAAAAAAAAAABAgMEBQYHCAkKC//EALUQAAIBAwMCBAMFBQQEAAABfQECAwAEEQUSITFBBhNRYQcicRQygZGhCCNCscEVUtHwJDNicoIJChYXGBkaJSYnKCkqNDU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6g4SFhoeIiYqSk5SVlpeYmZqio6Slpqeoqaqys7S1tre4ubrCw8TFxsfIycrS09TV1tfY2drh4uPk5ebn6Onq8fLz9PX29/j5+v/aAA4EQwBNAFkASwAAPwD6prx6vHq+qaKKKKKKKKKKKK//2Q==')
const WEBP = b64('UklGRjwAAABXRUJQVlA4IDAAAADQAQCdASoQABAAAUAmJaACdLoB+AADsAD+3tY/8zRhKSPID/8Vv+ObfHNv+JxAAAA=')
const GIF = b64('R0lGODdhEAAQAIEAAACZzADMzACZ/wDM/ywAAAAAEAAQAEAIUwADCBxIsKDAAQEAIAwwAMBBhQMRQhQgkGIAigslLmR4kGNHjhk/fkS4EWREkSE3hmTokKNFkyRheiy5kibBlQVretypUiTPih5fzjy58+fQngEBADs=')
const rect = (fill, w, h) => `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect width="${w}" height="${h}" fill="${fill}"/></svg>`
const PNG = available() ? svgToPng(rect('#FF00FF', 120, 90)) : null

assert.equal(sniff(JPEG), 'image/jpeg')
assert.equal(sniff(PJPEG), 'image/jpeg')
assert.equal(sniff(GIF), 'image/gif')
assert.equal(sniff(WEBP), '', 'WebP is not drawn by resvg 2.6')
assert.equal(sniff(Buffer.from('BM\0\0\0\0')), '', 'BMP')
assert.equal(sniff(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>')), '', 'SVG is never accepted')
assert.equal(sniff(Buffer.alloc(0)), '')
assert.equal(sniff('not a buffer'), '')
assert.deepEqual(imageSize(JPEG, 'image/jpeg'), { w: 24, h: 16, cmyk: false })
assert.deepEqual(imageSize(PJPEG, 'image/jpeg'), { w: 16, h: 16, cmyk: false }, 'progressive SOF2')
assert.deepEqual(imageSize(CMYK, 'image/jpeg'), { w: 16, h: 16, cmyk: true }, 'CMYK (4 components)')
assert.deepEqual(imageSize(GIF, 'image/gif'), { w: 16, h: 16, cmyk: false })
assert.equal(imageSize(JPEG.subarray(0, 40), 'image/jpeg'), null, 'cut header')
if (PNG) {
  assert.equal(sniff(PNG), 'image/png')
  assert.deepEqual(imageSize(PNG, 'image/png'), { w: 120, h: 90, cmyk: false })
}

// ── JPEG 크기는 해독기(jpeg-decoder)와 같은 곳에서: 표시를 길이대로 엄격하게 건넌다
const SOI = JPEG.subarray(0, 2)
const BODY = JPEG.subarray(2) // FF E0 … (APP0 부터)
const GIANT_SOF = Buffer.from([0xff, 0xc0, 0x00, 0x0b, 0x08, 0x3e, 0x80, 0x3e, 0x80, 0x01, 0x01, 0x11, 0x00]) // 16000×16000
// FF 00 을 길이 있는 덩어리로 읽으면 그 안의 큰 SOF 를 건너뛰고 뒤의 작은 SOF(24×16)를 읽는다 — 해독기는 FF 00 을 건너 큰 SOF 를 읽는다
const SMUGGLE = Buffer.concat([SOI, Buffer.from([0xff, 0x00, 0x00, 0x0f]), GIANT_SOF, BODY])
assert.equal(imageSize(SMUGGLE, 'image/jpeg'), null, 'FF 00 before the SOF is not skipped as a segment')
const sofAt = JPEG.indexOf(Buffer.from([0xff, 0xc0]))
const GIANT = Buffer.from(JPEG)
GIANT.writeUInt16BE(16000, sofAt + 5)
GIANT.writeUInt16BE(16000, sofAt + 7)
assert.deepEqual(imageSize(GIANT, 'image/jpeg'), { w: 16000, h: 16000, cmyk: false }, 'honest giant SOF is read (and refused by the size guard)')
assert.deepEqual(imageSize(Buffer.concat([SOI, Buffer.from([0xff, 0xff]), BODY]), 'image/jpeg'), { w: 24, h: 16, cmyk: false }, 'fill bytes before a marker are fine')
for (const [what, bad] of [
  ['garbage between segments', Buffer.concat([SOI, Buffer.from([0x00]), BODY])],
  ['FF 00', Buffer.concat([SOI, Buffer.from([0xff, 0x00]), BODY])],
  ['RST before SOF', Buffer.concat([SOI, Buffer.from([0xff, 0xd0]), BODY])],
  ['second SOI', Buffer.concat([SOI, SOI, BODY])],
  ['unknown marker (JPG)', Buffer.concat([SOI, Buffer.from([0xff, 0xc8, 0x00, 0x02]), BODY])],
  ['length < 2', Buffer.concat([SOI, Buffer.from([0xff, 0xe1, 0x00, 0x01]), BODY])],
  ['SOS before SOF', Buffer.concat([SOI, Buffer.from([0xff, 0xda, 0x00, 0x02]), BODY])],
  ['no SOI', JPEG.subarray(2)],
]) assert.equal(imageSize(bad, 'image/jpeg'), null, 'strict JPEG walk: ' + what)

// ── GIF 크기는 첫 장면(0x2C)의 크기(resvg 는 그 크기로 그린다). 확장 블록을 건너고, 화면보다 큰 장면은 받지 않는다
function gif(sw, sh, fw, fh, gct) {
  const u16 = (n) => [n & 0xff, n >> 8]
  return Buffer.from([
    ...Buffer.from('GIF89a'), ...u16(sw), ...u16(sh), gct ? 0x81 : 0x00, 0, 0, ...(gct ? [0, 0, 0, 255, 0, 255, 0, 0, 0, 0, 0, 0] : []),
    0x21, 0xf9, 0x04, 0x00, 0x00, 0x00, 0x00, 0x00, // 그래픽 제어
    0x21, 0xfe, 0x03, 0x61, 0x62, 0x63, 0x00, // 주석
    0x21, 0xff, 0x0b, ...Buffer.from('NETSCAPE2.0'), 0x03, 0x01, 0x00, 0x00, 0x00, // 되풀이
    0x2c, 0, 0, 0, 0, ...u16(fw), ...u16(fh), 0x00, 0x02, 0x02, 0x44, 0x01, 0x00, 0x3b,
  ])
}
assert.deepEqual(imageSize(gif(16, 16, 16, 16), 'image/gif'), { w: 16, h: 16, cmyk: false }, 'GIF frame after extension blocks')
assert.deepEqual(imageSize(gif(40, 30, 20, 10, true), 'image/gif'), { w: 20, h: 10, cmyk: false }, 'GIF frame after a global color table')
assert.equal(imageSize(gif(16, 16, 3500, 3500), 'image/gif'), null, 'GIF frame larger than the screen')
assert.equal(imageSize(gif(16, 16, 16, 17), 'image/gif'), null, 'GIF frame taller than the screen')
assert.deepEqual(imageSize(gif(5000, 5000, 5000, 5000), 'image/gif'), { w: 5000, h: 5000, cmyk: false }, 'honest giant GIF is read (and refused by the size guard)')
assert.equal(imageSize(Buffer.concat([gif(16, 16, 16, 16).subarray(0, 13), Buffer.from([0x3b])]), 'image/gif'), null, 'GIF without a frame')
assert.equal(imageSize(gif(16, 16, 16, 16).subarray(0, 50), 'image/gif'), null, 'cut GIF')

// ── 가짜 사진 서버
function server() {
  const files = new Map()
  const calls = []
  const fetch = async (url, init) => {
    calls.push({ url, redirect: init && init.redirect })
    const f = files.get(url)
    if (f && (f.hang || f.delayMs)) {
      await new Promise((ok, no) => {
        const t = f.hang ? null : setTimeout(ok, f.delayMs)
        init.signal.addEventListener('abort', () => { clearTimeout(t); no(new Error('aborted')) }, { once: true })
      })
    }
    if (!f) return new Response('no', { status: 404 })
    const headers = {}
    if (f.location) headers.location = f.location
    if (f.body && !f.noLength) headers['content-length'] = String(f.body.length)
    if (f.type) headers['content-type'] = f.type
    return new Response(f.body || null, { status: f.status || 200, headers })
  }
  return { files, calls, fetch }
}
const keep = setInterval(() => {}, 1000) // 받기 시간 제한(setTimeout)이 도는 동안 프로세스가 끝나지 않게
const isPng = (d) => typeof d === 'string' && d.startsWith('data:image/png;base64,')
const pngOf = (d) => Buffer.from(d.slice('data:image/png;base64,'.length), 'base64')

if (available()) {
  const S = server()
  const logs = []
  let now = 1_000_000
  const av = new Avatars({ fetch: S.fetch, timeoutMs: 300, maxBytes: 4000, max: 3, now: () => now, log: (l) => logs.push(l) })
  const U = (p) => 'https://p.kakaocdn.net/' + p
  S.files.set(U('a.jpg'), { body: JPEG, type: 'image/png' }) // content-type 이 틀려도 바이트로 판단
  S.files.set(U('p.png'), { body: PNG, type: 'image/png' })
  S.files.set(U('g.gif'), { body: GIF })
  S.files.set(U('pj.jpg'), { body: PJPEG })
  S.files.set(U('w.webp'), { body: WEBP, type: 'image/jpeg' })
  S.files.set(U('cmyk.jpg'), { body: CMYK })
  S.files.set(U('svg'), { body: Buffer.from(rect('#FF00FF', 10, 10)), type: 'image/svg+xml' })
  S.files.set(U('big'), { body: Buffer.concat([JPEG, Buffer.alloc(5000)]) })
  S.files.set(U('big-nolen'), { body: Buffer.concat([JPEG, Buffer.alloc(5000)]), noLength: true })
  S.files.set(U('err'), { status: 500, body: JPEG })
  S.files.set(U('hang'), { hang: true })
  S.files.set(U('slow'), { delayMs: 30, body: JPEG })
  S.files.set(U('to-ok'), { status: 302, location: '/p.png' })
  S.files.set(U('to-http'), { status: 301, location: 'http://k.kakaocdn.net/x.jpg' })
  S.files.set('https://k.kakaocdn.net/x.jpg', { body: JPEG })
  S.files.set(U('to-evil'), { status: 302, location: 'https://evil.example.com/x.jpg' })
  S.files.set(U('loop'), { status: 302, location: U('loop') })
  // 바이트 머리에 엄청난 크기를 적은 PNG(해독 폭탄): 받지 않는다. IHDR 의 CRC 도 고쳐 resvg 가 '깨진 파일'로 먼저 버리지 않게 한다
  const bomb = Buffer.from(PNG)
  bomb.writeUInt32BE(30000, 16)
  bomb.writeUInt32BE(30000, 20)
  bomb.writeUInt32BE(crc32(bomb.subarray(12, 29)), 29)
  S.files.set(U('bomb.png'), { body: bomb })
  S.files.set(U('smuggle.jpg'), { body: SMUGGLE })
  S.files.set(U('giant.jpg'), { body: GIANT })
  S.files.set(U('bomb.gif'), { body: gif(16, 16, 3500, 3500) })
  S.files.set(U('giant.gif'), { body: gif(5000, 5000, 5000, 5000) })

  const a = await av.get(U('a.jpg'))
  assert.ok(isPng(a), 'JPEG → PNG data URI')
  const ap = pngOf(a)
  assert.equal(ap.readUInt32BE(16), AVATAR_PX, 'normalized to 168 wide')
  assert.equal(ap.readUInt32BE(20), AVATAR_PX, 'normalized to 168 high (cover crop)')
  assert.equal(S.calls[0].redirect, 'manual', 'redirects are never followed by fetch itself')
  for (const p of ['p.png', 'g.gif', 'pj.jpg', 'slow', 'to-ok', 'to-http']) assert.ok(isPng(await av.get(U(p))), 'drawn: ' + p)
  assert.ok(S.calls.some((c) => c.url === 'https://k.kakaocdn.net/x.jpg'), 'http redirect inside the list is upgraded and followed')
  for (const p of ['w.webp', 'cmyk.jpg', 'svg', 'big', 'big-nolen', 'err', 'missing', 'to-evil', 'loop', 'bomb.png']) assert.equal(await av.get(U(p)), null, 'refused: ' + p)
  assert.ok(!S.calls.some((c) => c.url.startsWith('https://evil.')), 'redirect to another host is not fetched')
  assert.equal(S.calls.filter((c) => c.url === U('loop')).length, 3, 'at most 2 redirect hops')
  assert.ok(logs.some((l) => l === 'avatar host not allowed: evil.example.com (BOT_AVATAR_HOSTS)'), 'refused redirect host logged ' + JSON.stringify(logs))
  // 해독 폭탄 · CMYK 는 크기 검사가 막는다: 그리기(photoPng)를 부르지도 않는다(시간 제한이 아니라 검사로 null 인지 — 넉넉한 시간 + 가짜 그리기)
  {
    const drawn = []
    const avB = new Avatars({ fetch: S.fetch, timeoutMs: 20000, render: async (buf, mime) => { drawn.push(mime); return null } })
    for (const p of ['bomb.png', 'smuggle.jpg', 'giant.jpg', 'bomb.gif', 'giant.gif', 'cmyk.jpg']) assert.equal(await avB.get(U(p)), null, 'guarded: ' + p)
    assert.deepEqual(drawn, [], 'the size guard refuses before drawing ' + JSON.stringify(drawn))
    assert.equal(avB.stats.rejected, 6)
    assert.equal(await avB.get(U('a.jpg')), null) // 가짜 그리기는 null
    assert.deepEqual(drawn, ['image/jpeg'], 'a normal photo does reach the drawing (the spy is wired)')
    // 폭탄 PNG 는 CRC 까지 맞는 그림이다(photoPng 에 바로 넣으면 resvg 가 오래 붙잡는다 — 그래서 넣지 않고 크기만 확인)
    assert.deepEqual(imageSize(bomb, 'image/png'), { w: 30000, h: 30000, cmyk: false })
    assert.equal(bomb.readUInt32BE(29), crc32(bomb.subarray(12, 29)))
    assert.ok((await photoPng(PNG, 'image/png', 32)) !== null, 'the real drawing works on a normal photo')
  }
  // 멈춘 서버: timeoutMs 안에 null(받기는 끊는다)
  const t0 = Date.now()
  assert.equal(await av.get(U('hang')), null, 'hang → null')
  const took = Date.now() - t0
  assert.ok(took >= 250 && took < 1500, 'hang bounded by the timeout ' + took)

  // 다른 서버 · 이상한 주소는 부르지도 않는다. 서버 이름은 한 번만 로그에(주소 전체는 남기지 않음)
  const n0 = S.calls.length
  for (const raw of ['https://evil.example.com/a.jpg?token=secret', 'https://evil.example.com/b.jpg', 'https://127.0.0.1/a.jpg', 'javascript:x']) assert.equal(await av.get(raw), null)
  assert.equal(S.calls.length, n0, 'refused urls are never fetched')
  assert.equal(logs.filter((l) => l.includes('evil.example.com')).length, 1, 'one log line per refused host')
  assert.ok(!logs.some((l) => l.includes('secret')), 'the url itself is never logged')

  // 기억: 같은 주소는 다시 받지 않는다(1시간). 실패는 10분. 가장 오래 안 쓴 것부터 버린다(max 3)
  const av2 = new Avatars({ fetch: S.fetch, timeoutMs: 300, max: 3, now: () => now })
  const calls = () => S.calls.length
  let c0 = calls()
  const x1 = await av2.get(U('a.jpg'))
  const x2 = await av2.get('http://p.kakaocdn.net/a.jpg') // 같은 주소(https 로 고친 것)
  assert.equal(calls(), c0 + 1, 'cache hit makes no fetch')
  assert.equal(x1, x2)
  assert.equal(av2.stats.hits, 1)
  c0 = calls()
  assert.equal(await av2.get(U('err')), null)
  assert.equal(await av2.get(U('err')), null)
  assert.equal(calls(), c0 + 1, 'a failure is remembered too')
  now += 11 * 60 * 1000
  await av2.get(U('err'))
  assert.equal(calls(), c0 + 2, 'a failure is retried after 10 minutes')
  c0 = calls()
  await av2.get(U('a.jpg'))
  assert.equal(calls(), c0, 'a photo is kept for an hour')
  now += 50 * 60 * 1000
  await av2.get(U('a.jpg'))
  assert.equal(calls(), c0 + 1, 'a photo is fetched again after an hour')
  // LRU(max 3): A · B · C 를 넣고 A 를 다시 쓴 뒤 D 를 넣으면 가장 오래 안 쓴 B 가 빠진다(넣은 순서대로 버리면 A 가 빠진다)
  const avL = new Avatars({ fetch: S.fetch, timeoutMs: 300, max: 3, now: () => now })
  for (const p of ['a.jpg', 'p.png', 'g.gif']) assert.ok(isPng(await avL.get(U(p))))
  c0 = calls()
  assert.ok(isPng(await avL.get(U('a.jpg'))))
  assert.equal(calls(), c0, 'hit')
  assert.ok(isPng(await avL.get(U('pj.jpg'))))
  assert.deepEqual([...avL.cache.keys()], [U('g.gif'), U('a.jpg'), U('pj.jpg')], 'least recently used entry evicted ' + [...avL.cache.keys()])
  // 동시에 같은 주소: 한 번만 받는다
  const av3 = new Avatars({ fetch: S.fetch, timeoutMs: 300 })
  c0 = calls()
  const p1 = av3.get(U('slow'))
  const p2 = av3.get(U('slow'))
  assert.equal(p1, p2, 'concurrent gets share one promise')
  assert.ok(isPng(await p1))
  assert.equal(calls(), c0 + 1, 'one fetch for concurrent gets')
  // 동시에 받기 + 그리기는 limit 개까지: 꽉 차면 기다리지 않고 null, 실패로 기억하지 않는다(나중에 다시 받는다). 같은 주소는 함께 기다린다
  {
    S.files.set(U('slow2'), { delayMs: 60, body: JPEG })
    S.files.set(U('slow3'), { delayMs: 60, body: JPEG })
    const avC = new Avatars({ fetch: S.fetch, timeoutMs: 1000, limit: 2 })
    c0 = calls()
    const q1 = avC.get(U('slow'))
    const q2 = avC.get(U('slow2'))
    assert.equal(avC.active, 2)
    assert.equal(avC.get(U('slow')), q1, 'same url still shares the running fetch')
    assert.equal(await avC.get(U('slow3')), null, 'full: no wait')
    assert.equal(calls(), c0 + 2, 'full: not fetched')
    assert.ok(!avC.cache.has(U('slow3')) && avC.stats.busy === 1, 'full: not remembered as a failure')
    assert.ok(isPng(await q1) && isPng(await q2))
    assert.equal(avC.active, 0, 'slots released')
    assert.ok(isPng(await avC.get(U('slow3'))), 'fetched once a slot is free')
    // 시간이 지나 포기한 받기도 끊기면 자리를 돌려준다
    const avH = new Avatars({ fetch: S.fetch, timeoutMs: 100, limit: 1 })
    assert.equal(await avH.get(U('hang')), null)
    await new Promise((ok) => setTimeout(ok, 20))
    assert.equal(avH.active, 0, 'aborted fetch frees its slot')
    assert.ok(isPng(await avH.get(U('a.jpg'))))
  }
  // fetch 가 던져도 거절하지 않는다
  const av4 = new Avatars({ fetch: async () => { throw new Error('network down') }, timeoutMs: 300 })
  assert.equal(await av4.get(U('a.jpg')), null, 'network error → null')
  // 목록이 비면(BOT_AVATAR_HOSTS=none) 아무것도 받지 않는다
  const av5 = new Avatars({ fetch: S.fetch, hosts: [] })
  c0 = calls()
  assert.equal(await av5.get(U('a.jpg')), null)
  assert.equal(calls(), c0, 'no hosts = no fetch')
}
clearInterval(keep)
console.log('avatar check ok')
