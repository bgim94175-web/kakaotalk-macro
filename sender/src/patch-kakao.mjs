// agent-messenger 2.38.0 에 안드로이드 엔진 빌드가 이미 넣는 보정만 적용한다.
// 로그인 프로토콜을 다시 짜지 않는다. 기기 이름은 호출할 때마다 넘기고,
// 카카오가 준 message 와 status 를 지우지 않으며, 큰 userId 는 BSON long 으로 보낸다.
import { createRequire } from 'node:module'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'

const require = createRequire(import.meta.url)

function root() {
  return join(dirname(require.resolve('agent-messenger/package.json')), 'dist/src/platforms/kakaotalk')
}

function replaceOnce(label, text, oldText, newText) {
  if (text.includes(newText)) return text
  if (!text.includes(oldText)) throw new Error('kakao patch site missing: ' + label)
  return text.replace(oldText, newText)
}

export function patchKakaoLibrary() {
  const base = root()
  const loginPath = join(base, 'auth/kakao-login.js')
  let login = readFileSync(loginPath, 'utf8')
  const helper = `function kakaoSentence(data) {
    const m = data && typeof data.message === 'string' ? data.message.trim() : '';
    return m;
}
`
  if (!login.includes('function kakaoSentence')) {
    const needle = 'const STATUS_DEVICE_NOT_REGISTERED = -100;\n'
    if (!login.includes(needle)) throw new Error('kakao patch site missing: status')
    login = login.replace(needle, needle + helper)
  }
  const pairs = [
    ['bad credentials',
      `            message: typeof data.message === 'string'
                ? \`Login failed: \${data.message}\`
                : 'Login failed: incorrect email or password.',
        };`,
      `            message: kakaoSentence(data) || 'Login failed: incorrect email or password.',
            status: data.status,
        };`],
    ['login status',
      `        message: \`Login failed with status \${data.status}\`,
    };`,
      `        message: kakaoSentence(data) || \`Login failed with status \${data.status}\`,
        status: data.status,
    };`],
    ['passcode status',
      `        message: \`Passcode request failed with status \${data.status ?? 'unknown'}\`,
    };`,
      `        message: kakaoSentence(data) || \`Passcode request failed with status \${data.status ?? 'unknown'}\`,
        status: data.status,
    };`],
    ['register status',
      `                message: \`Device registration failed with status \${data.status}\`,
            };`,
      `                message: kakaoSentence(data) || \`Device registration failed with status \${data.status}\`,
                status: data.status,
            };`],
    ['device constant',
      `const DEVICE_NAME = 'SM-T870';`,
      `const DEVICE_NAME = 'SM-X710';`],
    ['attempt signature',
      `export async function attemptLogin(email, password, deviceUuid, deviceType, forced, debugLog) {
    const body = new URLSearchParams({
        password,
        device_name: DEVICE_NAME,
        model_name: DEVICE_NAME,`,
      `export async function attemptLogin(email, password, deviceUuid, deviceType, forced, debugLog, deviceName, modelName) {
    const shownName = typeof deviceName === 'string' && deviceName ? deviceName : DEVICE_NAME;
    const shownModel = typeof modelName === 'string' && modelName ? modelName : shownName;
    const body = new URLSearchParams({
        password,
        device_name: shownName,
        model_name: shownModel,`],
    ['attempt log',
      `    debugLog?.(\`device_name=\${DEVICE_NAME} device_uuid=\${deviceUuid.substring(0, 8)}... forced=\${forced}\`);`,
      `    debugLog?.(\`device_name=\${shownName} device_uuid=\${deviceUuid.substring(0, 8)}... forced=\${forced}\`);`],
    ['passcode signature',
      `export async function requestPasscode(email, password, deviceUuid) {
    const headers = buildHeaders(email);`,
      `export async function requestPasscode(email, password, deviceUuid, deviceName, modelName) {
    const shownName = typeof deviceName === 'string' && deviceName ? deviceName : DEVICE_NAME;
    const shownModel = typeof modelName === 'string' && modelName ? modelName : shownName;
    const headers = buildHeaders(email);`],
    ['passcode device',
      `            device: {
                name: DEVICE_NAME,
                uuid: deviceUuid,
                model: DEVICE_NAME,`,
      `            device: {
                name: shownName,
                uuid: deviceUuid,
                model: shownModel,`],
    ['register signature',
      `export async function registerDevice(email, password, _passcode, deviceUuid) {
    const headers = buildHeaders(email);`,
      `export async function registerDevice(email, password, _passcode, deviceUuid, deviceName, modelName) {
    const shownName = typeof deviceName === 'string' && deviceName ? deviceName : DEVICE_NAME;
    const shownModel = typeof modelName === 'string' && modelName ? modelName : shownName;
    const headers = buildHeaders(email);`],
    ['register device',
      `        device: { uuid: deviceUuid },`,
      `        device: { uuid: deviceUuid, name: shownName, model: shownModel },`],
  ]
  for (const [label, oldText, newText] of pairs) login = replaceOnce(label, login, oldText, newText)
  if (login.includes('SM-T870')) throw new Error('SM-T870 is still hardcoded')
  writeFileSync(loginPath, login)

  const sessionPath = join(base, 'protocol/session.js')
  let session = readFileSync(sessionPath, 'utf8')
  session = replaceOnce('checkin userId', session, 'userId: Number(userId),', 'userId: Long.fromString(String(userId)),')
  writeFileSync(sessionPath, session)

  const mediaPath = join(base, 'protocol/media-uploader.js')
  let media = readFileSync(mediaPath, 'utf8')
  media = replaceOnce('post size', media, 's: totalSize,', 's: Long.fromNumber(totalSize),')
  writeFileSync(mediaPath, media)

  const clientPath = join(base, 'client.js')
  let client = readFileSync(clientPath, 'utf8')
  client = replaceOnce(
    'chat link id',
    client,
    `        title,
        active_members: chat.a,`,
    `        title,
        link_id: (() => {
            const link = getOpenLinkId(chat);
            return link ? longToString(link) : null;
        })(),
        active_members: chat.a,`,
  )
  writeFileSync(clientPath, client)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  patchKakaoLibrary()
  process.stdout.write('kakao library patch ok\n')
}
