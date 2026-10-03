import { patchKakaoLibrary } from './patch-kakao.mjs'

patchKakaoLibrary()
await import('./index.mjs')
