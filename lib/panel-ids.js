// 관리 화면 계정의 발송 키. 앱 기기 번호와 겹치지 않게 w + 키 태그로 시작한다.
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

module.exports = { tagOf, newDeviceId, ownsDeviceId };
