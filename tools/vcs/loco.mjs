// VCS 패킷 코덱 — libVoxCore Ghidra 디컴파일로 확정한 모델(tools/frida/FINDINGS.md).
// 프레임 = [헤더(숫자 명령코드)] + [BSON 바디].  ★ LOCO 처럼 method 문자열이 아니라 숫자 code 다.
//
// 디컴파일로 확정한 패킷 필드(생성자 FUN_0x4603b8):
//   packetId  u32  (요청마다 rand()%0x7ffffffe)
//   status    u16  (요청=0)
//   code      u16  (숫자 명령코드: MakeVoiceRoomCall=0x272c, QueryCallable=0x7530, GetConf=0x7531 …)
//   type      u8   (=1)
//   bson           (표준 BSON, method 필드 없음)
//
// ★ 유일한 미확정: 위 필드들이 와이어에 나가는 정확한 바이트 순서·엔디안(transport 직렬화 = 간접호출이라
//   정적으로 못 떴다). 아래 HEADER 는 가장 유력한 추정(LE, 13바이트). 실서버 응답으로 확정하면
//   writeHeader/readHeader 두 곳만 고치면 된다.
import { serialize, deserialize } from 'bson'

// ── 와이어 헤더(추정) ──────────────────────────────────────────────────────
// [packetId u32 LE][status u16 LE][code u16 LE][type u8][bsonLen u32 LE]  = 13 bytes
export const HEADER_LEN = 13
export function writeHeader(h, bsonLen) {
  const b = Buffer.alloc(HEADER_LEN)
  b.writeUInt32LE((h.packetId >>> 0), 0)
  b.writeUInt16LE((h.status || 0) & 0xffff, 4)
  b.writeUInt16LE((h.code || 0) & 0xffff, 6)
  b.writeUInt8((h.type == null ? 1 : h.type) & 0xff, 8)
  b.writeUInt32LE(bsonLen >>> 0, 9)
  return b
}
export function readHeader(buf) {
  return {
    packetId: buf.readUInt32LE(0),
    status: buf.readUInt16LE(4),
    code: buf.readUInt16LE(6),
    type: buf.readUInt8(8),
    bsonLen: buf.readUInt32LE(9),
  }
}

export function randomPacketId() {
  let v = Math.floor(Math.random() * 0x7ffffffe)
  return v < 1 ? 1 : v
}

export function encodeFrame({ packetId, code, status = 0, type = 1, body = {} }) {
  const bson = serialize(body)
  return Buffer.concat([writeHeader({ packetId, status, code, type }, bson.length), bson])
}

// 스트리밍 디코더: onFrame(header, body, rawBuffer)
export function createFrameReader(onFrame) {
  let buf = Buffer.alloc(0)
  return (chunk) => {
    buf = Buffer.concat([buf, chunk])
    while (buf.length >= HEADER_LEN) {
      const h = readHeader(buf)
      if (h.bsonLen > 8 * 1024 * 1024) { onFrame(null, null, buf); buf = Buffer.alloc(0); break } // 헤더 추정 틀림 신호
      if (buf.length < HEADER_LEN + h.bsonLen) break
      const frame = buf.subarray(0, HEADER_LEN + h.bsonLen)
      let body = null
      if (h.bsonLen > 0) { try { body = deserialize(frame.subarray(HEADER_LEN), { promoteLongs: false }) } catch (e) { body = { _bsonError: String(e) } } }
      onFrame(h, body, frame)
      buf = buf.subarray(HEADER_LEN + h.bsonLen)
    }
  }
}

// 와이어 명령코드 (SendRequest 호출부 45개에서 추출)
export const CODE = Object.freeze({
  MakeVoiceRoomCall: 0x272c,
  MakeGroupCall: 0x2722,
  AddMember: 0x272a,
  SendMediaDescription: 0x2730,
  SendICEDescription: 0x2724,
  UpdateMedia: 0x2731,
  QueryCallable: 0x7530,
  SendGetConfRequest: 0x7531,
})
