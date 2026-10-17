// VCS 패킷 코덱 — libVoxCore Ghidra+capstone 정적분석 모델(tools/frida/FINDINGS.md, STATIC RE UPDATE 2).
//
// ★★ 중요 정정: 와이어는 **빅엔디안(네트워크 바이트순서)** 이고, 바디는 **표준 BSON 이 아니라 VoxCore 자체
//    빅엔디안 TLV** 다. (값 역직렬화가 전부 ntohs/ntohl: FUN_4726b0=ntohs, FUN_4726c8=ntohl 로 확정.)
//    따라서 아래는 "LE/BSON" 이 아니라 BE 로 바꾼 **최선의 가설**이며, 실측 전까지 UNVALIDATED 다.
//
// 디컴파일로 확정한 사실:
//   - 송신 패킷 객체(FUN_0x4603b8, 0x40B): +8 packetId u32 · +0xc status u16 · +0xe code u16 ·
//       +0x18/+0x20 bodyPtr/Len · +0x38 type u8.  (패킷 vtable=소멸자뿐, 직렬화는 transport 간접호출 → 정적 복원 불가)
//   - 수신 메시지(FUN_0x479f28): 12B BE 헤더 = [msgId u16][status/flags u16][cnt1..cnt4 u16] + 바디.
//       응답은 code 가 아니라 **msgId** 로 요청과 매칭(FUN_0x47935c). status = flags & 0xf.
//   - 바디 = VoxCore BE-TLV(FINDINGS §C). ← 이 코덱은 아직 Node 로 미구현(캡처로 확정 후 작성).
//
// ☞ 확정 방법: arm64 후킹 환경에서 tools/frida/capture-vcs-arm64.js 로 SSL_write/SSL_read 평문 1회 캡처.
//    그 hex 가 송신 프레임 실제 바이트 순서 + 로그인 패킷을 한 번에 닫는다. (BlueStacks 는 Houdini 로 불가.)
import { serialize, deserialize } from 'bson' // ⚠ 임시: 바디는 실제론 VoxCore BE-TLV. 캡처 후 교체 예정.

// ── 와이어 헤더(BE 가설, UNVALIDATED) ───────────────────────────────────────
// [packetId u32 BE][status u16 BE][code u16 BE][type u8][bodyLen u32 BE]  = 13 bytes
// (수신 모델은 12B 6×u16 형태라 이 송신 가설과 다를 수 있음 — 캡처로 확정.)
export const HEADER_LEN = 13
export function writeHeader(h, bodyLen) {
  const b = Buffer.alloc(HEADER_LEN)
  b.writeUInt32BE((h.packetId >>> 0), 0)
  b.writeUInt16BE((h.status || 0) & 0xffff, 4)
  b.writeUInt16BE((h.code || 0) & 0xffff, 6)
  b.writeUInt8((h.type == null ? 1 : h.type) & 0xff, 8)
  b.writeUInt32BE(bodyLen >>> 0, 9)
  return b
}
export function readHeader(buf) {
  return {
    packetId: buf.readUInt32BE(0),
    status: buf.readUInt16BE(4),
    code: buf.readUInt16BE(6),
    type: buf.readUInt8(8),
    bsonLen: buf.readUInt32BE(9),
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
