// 카카오 등록 실패 문장. 앱 AuthText 와 같은 규칙이다.
// 카카오가 문장을 주면 그 문장을 쓰고, 상태 번호는 문장 뒤 괄호 `(오류 번호 -111)` 로 항상 같이 보여 준다(docs/TONE.md).
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
      return '카카오 계정 또는 비밀번호가 일치하지 않습니다.';
    case 8:
    case 13:
      return '로그인 시도 횟수를 넘어 카카오가 로그인을 막았습니다. 잠시 뒤 다시 시도해 주세요.';
    case 31:
      return '이 카카오 계정에 연결할 수 있는 기기 수를 넘었습니다.';
    case 32:
    case -997:
      return '카카오가 이용을 제한한 계정입니다.';
    case -101:
      return '인증번호가 올바르지 않습니다.';
    case -102:
      return '인증번호 입력 시간이 지났습니다. 처음부터 다시 로그인해 주세요.';
    case -328:
      return '카카오 이용자 보호조치로 추가 기기 로그인이 막혀 있습니다. 카카오톡에서 보호조치를 해제한 뒤 다시 시도해 주세요.';
    case -444:
      return '카카오가 접속을 제한해 본인 확인이 필요합니다.';
    case -445:
      return '카카오가 추가 기기 로그인을 제한했습니다. 잠시 뒤 다시 시도해 주세요.';
    case -950:
      return '로그인이 만료되었습니다. 다시 로그인해 주세요.';
    case -998:
      return '추가 인증이 필요합니다.';
    case -999:
      return '카카오톡을 최신 버전으로 업데이트한 뒤 다시 시도해 주세요.';
    case 99:
      return '일시적인 오류입니다. 잠시 뒤 다시 시도해 주세요.';
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
  if (!sentence && src.state === 'bad_credentials') sentence = '카카오 계정 또는 비밀번호가 일치하지 않습니다.';
  const hasStatus = status != null && !Number.isNaN(status);
  // 오류 번호는 문장 뒤 괄호에만 붙인다. 카카오 문장이 없으면 무슨 일인지 한 문장으로 먼저 말한다.
  if (!sentence && hasStatus) sentence = '카카오 로그인에 실패했습니다.';
  const lines = [];
  if (sentence) lines.push(sentence + (hasStatus ? ' (오류 번호 ' + status + ')' : ''));
  const device = deviceLine(src.device_name, src.device_model);
  if (device) lines.push(device);
  if (!lines.length) return '카카오가 실패 이유를 알려 주지 않았습니다. 잠시 뒤 다시 시도해 주세요.';
  return lines.join('\n');
}

module.exports = { customerText, mapStatus, statusIn };
