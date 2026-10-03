// 카카오 등록 실패 문장. 앱 AuthText 와 같은 규칙이다.
// 카카오가 문장을 주면 그 문장을 쓰고, 상태 번호는 항상 같이 보여 준다.
// -111 은 이용자 보호조치 문장으로 바꾸지 않는다. -328 만 그 문장을 쓴다.
'use strict';

function hasHangul(s) {
  for (let i = 0; i < s.length; i++) {
    const ch = s.charCodeAt(i);
    if (ch >= 0xAC00 && ch <= 0xD7A3) return true;
  }
  return false;
}

function statusIn(message) {
  const hit = String(message || '').match(/status (-?\d+)/);
  return hit ? Number(hit[1]) : null;
}

function kakaoSentence(message) {
  if (!message) return '';
  let s = String(message).trim();
  if (s.startsWith('Login failed:')) s = s.slice('Login failed:'.length).trim();
  if (!hasHangul(s)) return '';
  if (s.startsWith('Login failed') || s.startsWith('Passcode request failed') ||
      s.startsWith('Device registration failed') || s.startsWith('HTTP ')) return '';
  return s;
}

function mapStatus(status) {
  switch (status) {
    case 12:
    case 30:
      return '카카오계정 또는 비밀번호가 일치하지 않습니다.';
    case 8:
    case 13:
      return '로그인 시도 횟수를 초과하여 제한되었습니다.';
    case 31:
      return '등록할 수 있는 기기 수를 초과했습니다.';
    case 32:
    case -997:
      return '이용이 제한된 계정입니다.';
    case -101:
      return '인증번호가 올바르지 않습니다.';
    case -102:
      return '인증번호 입력 시간이 지났습니다. 처음부터 다시 로그인해 주세요.';
    case -328:
      return '이용자 보호조치로 인해 서브디바이스 로그인이 제한되었습니다.';
    case -444:
      return '접속이 제한되어 본인 확인이 필요합니다.';
    case -445:
      return '백그라운드 로그인이 제한되었습니다.';
    case -950:
      return '로그인이 만료되었습니다. 다시 로그인해 주세요.';
    case -998:
      return '추가 인증이 필요합니다.';
    case -999:
      return '카카오톡을 최신 버전으로 맞춘 뒤 다시 시도해 주세요.';
    case 99:
      return '일시적인 오류입니다. 잠시 후 다시 시도해 주세요.';
    default:
      return '';
  }
}

function sentenceFor(message, status) {
  const sentence = kakaoSentence(message);
  if (status === -111) {
    if (sentence && sentence.indexOf('이용자 보호조치') >= 0) return '';
    return sentence;
  }
  if (sentence) return sentence;
  return mapStatus(status);
}

function deviceLine(name, model) {
  const n = name == null ? '' : String(name).trim();
  const m = model == null ? '' : String(model).trim();
  if (!n && !m) return '';
  if (!m || m === n) return '기기 ' + n;
  if (!n) return '기기 ' + m;
  return '기기 ' + n + ' (' + m + ')';
}

function customerText(input) {
  const src = input || {};
  let status = typeof src.status === 'number' ? src.status : null;
  if (status == null && typeof src.server_status === 'number') status = src.server_status;
  if (status == null) status = statusIn(src.message);
  let sentence = sentenceFor(src.message, status);
  if (!sentence && src.state === 'expired') sentence = '인증번호 입력 시간이 지났습니다. 처음부터 다시 로그인해 주세요.';
  if (!sentence && src.state === 'bad_credentials') sentence = '카카오계정 또는 비밀번호가 일치하지 않습니다.';
  const lines = [];
  if (sentence) lines.push(sentence);
  if (status != null && !Number.isNaN(status)) lines.push('카카오 상태 ' + status);
  const device = deviceLine(src.device_name, src.device_model);
  if (device) lines.push(device);
  if (!lines.length) return '카카오 서버가 실패 원인을 주지 않았습니다.';
  return lines.join('\n');
}

module.exports = { customerText, mapStatus, statusIn };
