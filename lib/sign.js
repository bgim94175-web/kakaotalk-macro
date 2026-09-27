// 서명 / 시크릿 유도 — Ed25519 응답 서명 + config_key(HMAC) 생성
// 지연 초기화: 이 모듈을 require 하는 것만으로 키를 만들거나 로그를 뿜지 않는다.
'use strict';

const crypto = require('crypto');

let _privPem = null;     // PEM 문자열
let _privKey = null;     // KeyObject
let _pubB64 = null;      // SPKI base64
let _cfgSecret = null;   // Buffer

// SIGNING_PRIVATE_KEY 가 없으면 한 번 만들어서 콘솔에 뿌린다(기존 동작 유지).
// 이러면 재시작마다 키가 바뀌니 반드시 환경변수에 박아야 한다.
function load() {
  if (_privKey) return _privKey;
  _privPem = process.env.SIGNING_PRIVATE_KEY;
  if (!_privPem) {
    const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
    _privPem = privateKey.export({ type: 'pkcs8', format: 'pem' });
    const pubDer = publicKey.export({ type: 'spki', format: 'der' });
    console.log('\n===== 서명키 생성됨 (한 번만 뜸) =====');
    console.log('Render 환경변수 SIGNING_PRIVATE_KEY 에 저장:');
    console.log(_privPem);
    console.log('사용자 앱 Config.PUBLIC_KEY_B64 에 넣기:');
    console.log(Buffer.from(pubDer).toString('base64'));
    console.log('※ 환경변수에 안 박으면 재시작할 때마다 바뀌어서 기존 앱이 전부 bad_signature 로 막힌다.');
    console.log('=====================================\n');
  }
  _privKey = crypto.createPrivateKey(_privPem);
  return _privKey;
}

// 공개키 (base64 SPKI) — /pubkey 진단용
function pubkeyB64() {
  if (_pubB64) return _pubB64;
  const priv = load();
  const pub = crypto.createPublicKey(priv);
  _pubB64 = pub.export({ type: 'spki', format: 'der' }).toString('base64');
  return _pubB64;
}

// 객체를 JSON.stringify 한 바이트에 서명하고 sig 를 맨 뒤에 붙인다.
// ★ 키 삽입 순서가 서명 대상이다. 호출하는 쪽에서 순서를 지켜서 객체를 만들어야 한다.
function sign(obj) {
  const priv = load();
  const sig = crypto.sign(null, Buffer.from(JSON.stringify(obj)), priv).toString('base64');
  return Object.assign({}, obj, { sig: sig });
}

// 설정 암호화 키 유도용 HMAC 시크릿.
// CONFIG_SECRET 이 있으면 그걸 쓰고, 없으면 서명 개인키에서 sha256 으로 유도한다.
function cfgSecret() {
  if (_cfgSecret) return _cfgSecret;
  const env = process.env.CONFIG_SECRET;
  if (env && String(env).length > 0) {
    _cfgSecret = Buffer.from(String(env), 'utf8');
  } else {
    load(); // _privPem 채우기
    _cfgSecret = crypto.createHash('sha256').update(String(_privPem), 'utf8').digest();
    console.log('[sign] CONFIG_SECRET 없음 → SIGNING_PRIVATE_KEY 에서 유도해서 쓴다');
  }
  return _cfgSecret;
}

// config_key = base64( HMAC-SHA256(CONFIG_SECRET, key + "|" + device_id) )
// 앱은 이 값으로 HKDF 해서 설정 암호화 키를 만든다. 성공 응답에만 실어준다.
function configKey(licenseKey, deviceId) {
  if (!licenseKey || !deviceId) return null;
  return crypto.createHmac('sha256', cfgSecret())
    .update(String(licenseKey) + '|' + String(deviceId), 'utf8')
    .digest('base64');
}

// 랜덤 hex (bytes 바이트 → hex 2배 길이). session 은 24바이트 = 48hex
function randomHex(bytes) {
  return crypto.randomBytes(bytes).toString('hex');
}

function sha256Hex(s) {
  return crypto.createHash('sha256').update(String(s), 'utf8').digest('hex');
}

module.exports = { sign, pubkeyB64, configKey, randomHex, sha256Hex };
