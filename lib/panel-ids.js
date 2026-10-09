// 관리 화면 계정의 발송 키. 앱 기기 번호와 겹치지 않게 w + 태그로 시작한다.
//   예전 키 계정: 'w' + sha256('panel:'  + 라이선스키)[0:12] + '.' + 16hex
//   회원 계정:    'w' + sha256('member:' + 회원번호)[0:12]   + '.' + 16hex  (docs/ACCOUNTS_V1.md 3.4.1)
//   K bot 계정:   'bot.' + 16hex                                        (5.2 — 고객 경로에서는 늘 404)
// 키를 이관한 회원은 예전 키 계정과 회원 계정을 함께 가진다. 그래서 소유 확인은 이 모양이 아니라
// panel_accounts.member_id 로 한다(routes/panel.js). 여기 함수는 모양 검사와 새 id 만 만든다.
'use strict';

const crypto = require('crypto');

function tagOf(licenseKey) {
  return crypto.createHash('sha256').update('panel:' + licenseKey).digest('hex').slice(0, 12);
}

function newDeviceId(licenseKey) {
  return 'w' + tagOf(licenseKey) + '.' + crypto.randomBytes(8).toString('hex');
}

function ownsDeviceId(licenseKey, deviceId) {
  if (typeof deviceId !== 'string') return false;
  return new RegExp('^w' + tagOf(licenseKey) + '\\.[0-9a-f]{16}$').test(deviceId);
}

function memberTagOf(memberId) {
  return crypto.createHash('sha256').update('member:' + String(memberId)).digest('hex').slice(0, 12);
}

function newMemberDeviceId(memberId) {
  return 'w' + memberTagOf(memberId) + '.' + crypto.randomBytes(8).toString('hex');
}

// 고객 콘솔 계정 id 모양('w' + 12hex + '.' + 16hex). 소유 여부는 따로 DB 로 본다.
function isPanelDeviceId(deviceId) {
  return typeof deviceId === 'string' && /^w[0-9a-f]{12}\.[0-9a-f]{16}$/.test(deviceId);
}

function isBotId(id) {
  return typeof id === 'string' && /^bot\.[0-9a-f]{16}$/.test(id);
}

module.exports = { tagOf, newDeviceId, ownsDeviceId, memberTagOf, newMemberDeviceId, isPanelDeviceId, isBotId };
