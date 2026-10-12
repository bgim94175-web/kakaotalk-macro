// 보이스룸 실험실(SENDER_VOICE_LAB=1). 보이스룸을 여는 명령이 무엇인지 아직 모르므로, 찾는 동안 쓰는 도구만 둔다.
//   1) 모으기: 남이 보이스룸을 열고 닫을 때 오는 신호(MSG 52, CHGMETA 16·17)를 자르지 않고 그대로 담아 둔다.
//   2) 두드리기: 후보 명령을 방에 하나씩 보내고 응답 코드를 적는다. 첫 후보는 일부러 없는 명령(대조군)이라,
//      "없는 명령의 응답 코드"를 먼저 알고 나머지를 읽는다. 코드가 대조군과 다르면 그 명령은 서버에 있다는 뜻이다.
// 방을 저절로 열지 않는다. 명령을 찾은 뒤에 유지 기능을 이 위에 올린다.

const SEEN_MAX = 40

// 대조군(없는 명령) → 읽기처럼 보이는 것 → 열기 후보. 열기 후보는 방에 실제로 보이스룸이 열릴 수 있다.
export const VOICE_CANDIDATES = [
  { m: 'XXNOPE', kind: 'control' },
  { m: 'VRINFO', kind: 'read' },
  { m: 'GETVR', kind: 'read' },
  { m: 'LIVEINFO', kind: 'read' },
  { m: 'GETLIVE', kind: 'read' },
  { m: 'VROOMINFO', kind: 'read' },
  { m: 'LIVEON', kind: 'open' },
  { m: 'VRON', kind: 'open' },
  { m: 'VROPEN', kind: 'open' },
  { m: 'VRCREATE', kind: 'open' },
  { m: 'CREATEVR', kind: 'open' },
  { m: 'MAKEVR', kind: 'open' },
  { m: 'VOICEON', kind: 'open' },
  { m: 'VOICEROOM', kind: 'open' },
  { m: 'OPENVOICE', kind: 'open' },
  { m: 'LIVETALK', kind: 'open' },
  { m: 'LTON', kind: 'open' },
  { m: 'VCREATE', kind: 'open' },
  { m: 'MVOIPCREATE', kind: 'open' },
]

const KINDS = new Set(['control', 'read', 'open'])

// 보이스룸 신호인가 — botpool 의 추적과 같은 기준(MSG 52, CHGMETA 16·17)
export function isVoiceSignal(packet) {
  const b = (packet && packet.body) || {}
  if (packet.method === 'MSG') return !!b.chatLog && Number(b.chatLog.type) === 52
  if (packet.method === 'CHGMETA') return !!b.meta && (Number(b.meta.type) === 16 || Number(b.meta.type) === 17)
  return false
}

// 모은 신호는 패널·관리자가 그대로 읽는다. content 는 자르지 않는다(보이스룸 주소가 200자를 넘는다).
export function recordVoiceSignal(seen, botId, packet, idText) {
  const b = packet.body || {}
  const row = { at: new Date().toISOString(), bot: botId, method: packet.method, chat_id: idText(b.chatId) || idText(b.c), link_id: idText(b.li) }
  if (b.meta) {
    row.meta_type = Number(b.meta.type)
    row.author_id = idText(b.meta.authorId)
    row.revision = b.meta.revision == null ? null : String(b.meta.revision)
    row.content = String(b.meta.content == null ? '' : b.meta.content)
  } else {
    const l = b.chatLog || {}
    row.log_type = Number(l.type)
    row.author_id = idText(l.authorId)
    row.message = String(l.message == null ? '' : l.message)
    row.attachment = String(l.attachment == null ? '' : l.attachment)
  }
  seen.push(row)
  while (seen.length > SEEN_MAX) seen.shift()
  return row
}

function planOf(opts) {
  const o = opts || {}
  if (typeof o.method === 'string' && o.method.trim()) {
    return [{ m: o.method.trim().toUpperCase(), kind: 'ask', body: o.body && typeof o.body === 'object' ? o.body : null }]
  }
  const kinds = Array.isArray(o.kinds) && o.kinds.length ? o.kinds.filter((k) => KINDS.has(k)) : ['control', 'read']
  return VOICE_CANDIDATES.filter((c) => kinds.includes(c.kind))
}

// slot.raw 로 후보를 하나씩 보낸다. 같은 세션에 연달아 보내므로 사이를 띄우고, 성공(0)이 나오면 거기서 멈춘다.
export async function voiceLabRun(slot, view, opts, deps) {
  const d = deps || {}
  const L = d.long
  const gapMs = d.gapMs == null ? 1500 : d.gapMs
  const wait = d.wait || ((ms) => new Promise((r) => setTimeout(r, ms)))
  const plan = planOf(opts)
  if (!plan.length) return { ok: false, error: 'bad_plan' }
  const chatId = view.chat_id
  const linkId = view.link_id
  if (!chatId) return { ok: false, error: 'not_joined' }

  const tried = []
  for (let i = 0; i < plan.length; i++) {
    const c = plan[i]
    const body = c.body || { chatId: L(chatId), li: linkId ? L(linkId) : undefined }
    const res = await slot.raw(c.m, body)
    const got = {
      method: c.m,
      kind: c.kind,
      status: res && res.statusCode == null ? null : Number(res.statusCode),
      body: res && res.body ? JSON.stringify(res.body).slice(0, 600) : '',
      error: (res && res.error) || '',
    }
    tried.push(got)
    if (got.status === 0) break
    if (i + 1 < plan.length) await wait(gapMs)
  }
  const control = tried.find((t) => t.kind === 'control')
  const unknown = control ? control.status : null
  return {
    ok: true,
    chat_id: chatId,
    unknown_status: unknown,
    // 서버에 있는 명령: 대조군과 응답 코드가 다른 것
    exists: tried.filter((t) => t.kind !== 'control' && t.status !== unknown).map((t) => t.method),
    tried,
  }
}
