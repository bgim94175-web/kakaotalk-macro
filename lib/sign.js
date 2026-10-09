// 랜덤 토큰 / 해시 유틸 — 구매 웹(routes/purchase.js)이 주문 토큰과 입금 알림 중복 판정에 쓴다.
// 예전 사용자앱용 Ed25519 응답 서명과 config_key 유도는 앱 단종과 함께 뺐다
// (SIGNING_PRIVATE_KEY 는 더 이상 읽지 않는다. CONFIG_SECRET 은 lib/panel-auth.js 가 쿠키 서명에 쓴다).
'use strict';

const crypto = require('crypto');

// 랜덤 hex (bytes 바이트 → hex 2배 길이). 주문 토큰은 12바이트 = 24hex
function randomHex(bytes) {
  return crypto.randomBytes(bytes).toString('hex');
}

function sha256Hex(s) {
  return crypto.createHash('sha256').update(String(s), 'utf8').digest('hex');
}

module.exports = { randomHex, sha256Hex };
