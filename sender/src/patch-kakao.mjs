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

// oldTexts are earlier revisions of the same site, oldest first. The last one is current.
function replaceLatest(label, text, oldTexts, newText) {
  if (text.includes(newText)) return text
  for (let i = oldTexts.length - 1; i >= 0; i--) {
    if (text.includes(oldTexts[i])) return text.replace(oldTexts[i], newText)
  }
  throw new Error('kakao patch site missing: ' + label)
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
  // 사진 올리기에 끝을 둔다(멈춘 업로드가 그 방의 답을 오래 붙잡지 않게, botpool sendPhoto): COMPLETE 기다림 60초 → 20초,
  // 업로드 서버 연결 10초. 파일을 보내다 멈춰도(쓰기가 끝나지 않음) COMPLETE 기다림이 끝나면 함께 끝낸다.
  media = replaceOnce('complete timeout', media, 'const DEFAULT_COMPLETE_TIMEOUT_MS = 60_000;', 'const DEFAULT_COMPLETE_TIMEOUT_MS = 20_000;')
  media = replaceOnce(
    'media connect timeout',
    media,
    `    await conn.connectSecure(opts.shipHost, opts.shipPort);
`,
    `    const connectTimer = setTimeout(() => conn.socket?.destroy(new Error('media connect timeout (10000ms)')), 10_000);
    try {
        await conn.connectSecure(opts.shipHost, opts.shipPort);
    }
    finally {
        clearTimeout(connectTimer);
    }
`,
  )
  media = replaceOnce(
    'media stream bound',
    media,
    '            await conn.writeRaw(Buffer.from(bytesToSend));',
    '            await Promise.race([conn.writeRaw(Buffer.from(bytesToSend)), completePromise]);',
  )
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
  if (!client.includes('function textTitle(content)')) {
    client = client.replace(
      'function extractTitle(body) {',
      `function textTitle(content) {
    if (typeof content === 'string') {
        const s = content.trim();
        if (!s)
            return null;
        if (s.charAt(0) === '{') {
            try {
                const obj = JSON.parse(s);
                const inner = obj && (obj.name || obj.title || obj.ln || obj.ti);
                if (typeof inner === 'string' && inner.trim())
                    return inner.trim();
            }
            catch {
                /* 방 제목 문자열이다 */
            }
        }
        return s;
    }
    if (content && typeof content === 'object') {
        const inner = content.name || content.title || content.ln || content.ti;
        if (typeof inner === 'string' && inner.trim())
            return inner.trim();
    }
    return null;
}
function extractTitle(body) {`,
    )
  }
  client = replaceLatest(
    'chat title meta',
    client,
    [`function extractTitle(body) {
    const info = body.chatInfo;
    const metas = info?.chatMetas;
    if (!Array.isArray(metas))
        return null;
    const titleMeta = metas.find((m) => m?.type === META_TYPE_TITLE);
    const content = titleMeta?.content;
    return typeof content === 'string' && content.length > 0 ? content : null;
}`,
    `function extractTitle(body) {
    const info = body.chatInfo;
    const metas = info?.chatMetas;
    if (!Array.isArray(metas))
        return null;
    const titleMeta = metas.find((m) => m?.type === META_TYPE_TITLE);
    return textTitle(titleMeta?.content);
}`],
    `function metaTypeNum(v) {
    if (typeof v === 'number' && Number.isFinite(v))
        return v;
    if (v && typeof v === 'object' && 'low' in v)
        return v.low;
    const n = Number(v);
    return Number.isFinite(n) ? n : NaN;
}
function extractTitle(body) {
    const info = body.chatInfo;
    const metas = info?.chatMetas;
    if (!Array.isArray(metas))
        return null;
    const titleMeta = metas.find((m) => metaTypeNum(m?.type) === META_TYPE_TITLE);
    return textTitle(titleMeta?.content);
}`,
  )
  client = replaceOnce(
    'numeric open link id',
    client,
    `function getOpenLinkId(chat) {
    return bsonToLong(chat.li) ?? null;
}`,
    `function getOpenLinkId(chat) {
    const v = chat && chat.li;
    if (typeof v === 'number' && Number.isSafeInteger(v) && v > 0)
        return Long.fromNumber(v);
    if (typeof v === 'bigint' && v > 0n)
        return Long.fromString(v.toString());
    if (typeof v === 'string' && /^[1-9][0-9]*$/.test(v))
        return Long.fromString(v);
    const asLong = bsonToLong(v);
    if (!asLong || asLong.isZero())
        return null;
    return asLong;
}`,
  )
  client = replaceOnce(
    'open link name',
    client,
    `function extractOpenLinkName(body) {
    const ols = body.ols;
    if (!Array.isArray(ols) || ols.length === 0)
        return null;
    const ln = ols[0]?.ln;
    return typeof ln === 'string' && ln.length > 0 ? ln : null;
}`,
    `function extractOpenLinkName(body) {
    const ols = body.ols;
    if (!Array.isArray(ols) || ols.length === 0)
        return null;
    for (let i = 0; i < ols.length; i++) {
        const ol = ols[i];
        if (!ol || typeof ol !== 'object')
            continue;
        if (typeof ol.ln === 'string' && ol.ln.trim())
            return ol.ln.trim();
        const moim = ol.omt || ol.moim;
        const named = textTitle(moim);
        if (named)
            return named;
    }
    return null;
}`,
  )
  client = replaceLatest(
    'open title from chatinfo link',
    client,
    [`    async fetchChatTitle(session, chatId, chat) {
        let title = null;
        try {
            const response = await session.getChannelInfo(chatId);
            title = extractTitle(response.body);
        }
        catch {
            title = null;
        }
        if (title)
            return title;
        if (!chat || !isOpenChat(chat))
            return null;
        const linkId = getOpenLinkId(chat);
        if (!linkId)
            return null;
        try {
            const response = await session.getOpenLinkInfo([linkId]);
            return extractOpenLinkName(response.body);
        }
        catch {
            return null;
        }
    }`,
    `    async fetchChatTitle(session, chatId, chat) {
        let title = null;
        let infoChat = null;
        try {
            const response = await session.getChannelInfo(chatId);
            title = extractTitle(response.body);
            try {
                infoChat = channelInfoToChatData(response.body, longToString(chatId));
            }
            catch {
                infoChat = null;
            }
        }
        catch {
            title = null;
        }
        if (title)
            return title;
        const openChat = infoChat && isOpenChat(infoChat) ? infoChat : (chat && isOpenChat(chat) ? chat : null);
        if (!openChat)
            return null;
        const linkId = getOpenLinkId(openChat) || (chat ? getOpenLinkId(chat) : null);
        if (!linkId)
            return null;
        try {
            const response = await session.getOpenLinkInfo([linkId]);
            return extractOpenLinkName(response.body);
        }
        catch {
            return null;
        }
    }`],
    `    async fetchChatTitle(session, chatId, chat) {
        let title = null;
        let info = null;
        try {
            const response = await session.getChannelInfo(chatId);
            const body = response && response.body;
            info = body && body.chatInfo;
            title = extractTitle(body);
            if (chat && info && info.li != null && !getOpenLinkId(chat))
                chat.li = info.li;
        }
        catch {
            title = null;
        }
        if (title)
            return title;
        const linkId = getOpenLinkId(info ? { li: info.li } : null) || (chat ? getOpenLinkId(chat) : null);
        if (!linkId)
            return null;
        try {
            const response = await session.getOpenLinkInfo([linkId]);
            return extractOpenLinkName(response.body);
        }
        catch {
            return null;
        }
    }`,
  )
  // KICKOUT 본문의 reason 을 세션 이벤트에 싣는다(docs/ACCOUNTS_V1.md 5.2). runner·botpool 은 reason 이
  // 0(LOGIN_ANOTHER)·1(ACCOUNT_DELETED)·없음일 때만 세션을 끝내고, -2(CHANGE_SERVER) 와 그 밖은 다시 붙는다.
  // reason 이 숫자가 아니면 예전 문장을 그대로 둔다(없음 = 종료).
  client = replaceOnce(
    'kickout reason',
    client,
    `        if (packet.method === 'KICKOUT') {
            this.emitSessionEvent({ type: 'kicked', reason: 'Session kicked — another device logged in' });`,
    `        if (packet.method === 'KICKOUT') {
            const kickReason = packet.body && typeof packet.body.reason === 'number' ? packet.body.reason : null;
            this.emitSessionEvent({ type: 'kicked', reason: kickReason === null ? 'Session kicked — another device logged in' : kickReason, message: 'Session kicked' });`,
  )
  writeFileSync(clientPath, client)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  patchKakaoLibrary()
  process.stdout.write('kakao library patch ok\n')
}
