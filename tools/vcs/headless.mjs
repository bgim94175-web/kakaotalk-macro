// headless.mjs — 헤드리스 VCS 봇 뼈대 (DEX_FINDINGS.md 의미스펙 기반).
// "아는 것"은 채우고, 내일 voxcapture-log.txt 로 채울 "실값/와이어 바디"는 TODO 로 둔다.
//
// 흐름(DEX_FINDINGS §6):
//   1) fetchVoiceroomUser()  — GET /c/voiceroom/user (봇 계정 토큰) → vssHost·iceServers·sessionKey
//   2) setVConfig(...)        — 세션 자격 (oauthToken·skey·uuid + 기기정보)
//   3) makeVoiceRoomCall(...) — 개설 (csIP/port/chatId/userId/title/serviceType/userType/SDP)
//   4) 응답(callId) → SendMediaDescription/SendICEDescription → werift DTLS-SRTP 오디오(노래)
//   ※ 2~4 를 방마다 병렬 → 한 계정 여러 방 (서버가 계정당 세션 안 막으면)
//
// ⚠ 남은 TODO(내일 캡처로 확정): (a) /c/voiceroom/user 정확한 host/path/headers,
//    (b) 각 명령이 소켓에 나가는 와이어 바디 키·프레임 바이트, (c) SDP 생성(werift).
import { VcsClient } from './vcs.mjs'
import { CODE } from './loco.mjs'

// ── 1) 보이스룸 설정 받기 (HTTP, 헤드리스 가능) ──────────────────────────────
// VoiceroomUserResponse: vssHostV4/V6, csPort, iceServers, connectInfo, protocolVersion, (sessionKey)
// TODO(capture): 정확한 baseURL·path·필수 헤더(Authorization/A/C 등)를 voxcapture-log 의 [HTTP] 블록에서 확정.
export async function fetchVoiceroomUser({ baseUrl, headers, chatId, linkId }) {
  const url = `${baseUrl}/c/voiceroom/user` // TODO: 실제 host/path 확정(캡처)
  const res = await fetch(url, { headers: headers || {} })
  const j = await res.json().catch(() => null)
  if (!j) throw new Error('voiceroom/user 응답 파싱 실패 (status ' + res.status + ')')
  // TODO: 실제 키명으로 매핑 (vssHostV4/vssHostV6/csPort/iceServers/sessionKey/protocolVersion)
  return {
    csIP: j.vssHostV4 || (j.vssHost && j.vssHost.v4) || null,
    csIP6: j.vssHostV6 || (j.vssHost && j.vssHost.v6) || '',
    csPort: Number(j.csPort || j.port || 0) || 0,
    iceServers: j.iceServers || j.iceServer || [],
    sessionKey: j.sessionKey || j.sKey || j.skey || '',
    protocolVersion: j.protocolVersion || '',
    raw: j,
  }
}

// ── 2) 세션 자격 (SetVConfig 상당) ───────────────────────────────────────────
// DEX: SetVConfig(ver, country, dns, lang, skey, uuid, oauthToken, model, os, sdk, vmVersion, buildId)
export function buildVConfig({ version, country, dns, lang, sessionKey, uuid, oauthToken, device }) {
  const d = device || {}
  return [
    version || '', country || '', dns || '', lang || 'ko',
    sessionKey || '', uuid || '', oauthToken || '',
    d.model || 'SM-X710', d.os || 'android', d.sdk || '34', d.vmVersion || '', d.buildId || '',
  ] // 12개 문자열 — 와이어로 어떻게 나가는지는 TODO(capture/probe)
}

// ── 3) 개설 (MakeVoiceRoomCall 상당) ─────────────────────────────────────────
// DEX: MakeVoiceRoomCall(csIP,port,tls, csIP6,port6,tls6, chatId, userId, mediaType, title,
//                        serviceType, userType, sdp, b1, b2) -> callId
export function buildMakeVoiceRoomCall({ cs, chatId, userId, mediaType, title, serviceType, userType, sdp }) {
  return {
    csIP: cs.csIP, port: cs.csPort, tls: true,
    csIP6: cs.csIP6 || '', port6: cs.csPort, tls6: true,
    chatId: String(chatId), userId: String(userId),
    mediaType: mediaType == null ? 1 : mediaType,     // TODO: VCallMediaType 상수 확정(캡처)
    title: title || '보이스룸',
    serviceType: serviceType == null ? 11 : serviceType, // TODO: VServiceType(openlink) 값 확정
    userType: userType == null ? 3 : userType,            // TODO: VUserType(host) 값 확정
    sdp: sdp || '',                                       // TODO: werift 로 생성
  }
}

// ── 오케스트레이션 (방 하나 켜기) ────────────────────────────────────────────
export async function turnOnVoiceRoom(opts) {
  const { http, session, call } = opts
  const cs = await fetchVoiceroomUser(http)
  const client = new VcsClient({ host: cs.csIP, port: cs.csPort, sni: opts.sni || 'vcs.kakao.com', logHex: true })
  await client.connect()
  // TODO: 핸드셰이크 순서 — Init / SetVConfig / SetLocalNetwork / SendNetworkEvent (DEX_FINDINGS §2, [SEQ] 로그로 확정)
  //   const vcfg = buildVConfig({ ...session, sessionKey: cs.sessionKey })
  //   await client.send(CODE.SetVConfig?? , encodeVConfig(vcfg))    ← 와이어 코드·바디 TODO
  const body = buildMakeVoiceRoomCall({ cs, ...call })
  // TODO(capture/probe): body 를 VCS 와이어 바디(키·빅엔디안 TLV)로 인코딩하는 부분 확정.
  const res = await client.send(CODE.MakeVoiceRoomCall, body)
  client.close()
  return res
}

// 여러 방 동시: 방마다 turnOnVoiceRoom 을 병렬 호출 (서버가 계정당 세션 안 막으면 성립)
export async function turnOnMany(list) {
  return Promise.allSettled(list.map((o) => turnOnVoiceRoom(o)))
}
