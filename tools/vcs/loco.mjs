// VCS 패킷 프레이밍 — libVoxCore 정적분석 결과(tools/frida/FINDINGS.md) 기반.
// VCS 신호 바디는 BSON(VBsonEnc/VBsonDec)이고, 전송은 pjsip TLS 소켓(CallServer:5242) 위에 평문.
// 헤더는 LOCO(node-kakao) 계열로 추정한다. 아래가 "시작 추정값"이며, 실제 서버 바이트를 보면
// encodeFrame/createFrameReader 의 오프셋만 고치면 된다(← 미확정 TODO-1).
//
// 추정 헤더(22바이트, little-endian):
//   off 0  u32  packetId      요청마다 증가, 응답이 같은 값으로 돌아온다
//   off 4  i16  statusCode    요청은 0, 응답은 결과 코드
//   off 6  11B  method        ASCII, null 패딩.  ★ VCS method 이름(MakeVoiceRoomCall=17자)은 11B를 넘는다.
//                             → 진짜 method 는 BSON 바디의 {method:"..."} 에도 들어 있다(실측). 헤더 method 는
//                               짧은 태그이거나 쓰이지 않을 수 있다. TODO: 서버 바이트로 확정.
//   off 17 u8   dataType      0 = BSON
//   off 18 u32  bodyLength    뒤따르는 BSON 길이
//   off 22 ...  body          BSON 문서(bodyLength 바이트)
import { serialize, deserialize } from 'bson'

export const HEADER_LEN = 22

export function encodeFrame({ packetId = 0, method = '', statusCode = 0, body = {} }) {
  const bson = serialize(body)
  const h = Buffer.alloc(HEADER_LEN)
  h.writeUInt32LE(packetId >>> 0, 0)
  h.writeInt16LE(statusCode | 0, 4)
  Buffer.from(String(method).slice(0, 11), 'ascii').copy(h, 6) // 11B, 나머지는 0
  h.writeUInt8(0, 17) // BSON
  h.writeUInt32LE(bson.length, 18)
  return Buffer.concat([h, bson])
}

// 스트리밍 디코더: 소켓 청크를 feed 하면 완성된 프레임마다 onFrame(header, body, rawBuffer) 호출.
export function createFrameReader(onFrame) {
  let buf = Buffer.alloc(0)
  return (chunk) => {
    buf = Buffer.concat([buf, chunk])
    while (buf.length >= HEADER_LEN) {
      const bodyLen = buf.readUInt32LE(18)
      // 방어: 말도 안 되는 길이면 헤더 추정이 틀린 것 — 멈추고 원시 바이트를 그대로 넘긴다
      if (bodyLen > 8 * 1024 * 1024) { onFrame(null, null, buf); buf = Buffer.alloc(0); break }
      if (buf.length < HEADER_LEN + bodyLen) break
      const frame = buf.subarray(0, HEADER_LEN + bodyLen)
      const header = {
        packetId: frame.readUInt32LE(0),
        statusCode: frame.readInt16LE(4),
        method: frame.subarray(6, 17).toString('ascii').replace(/\0+$/g, ''),
        dataType: frame.readUInt8(17),
        bodyLength: bodyLen,
      }
      let body = null
      if (header.dataType === 0 && bodyLen > 0) {
        try { body = deserialize(frame.subarray(HEADER_LEN), { promoteLongs: false }) } catch (e) { body = { _bsonError: String(e) } }
      }
      onFrame(header, body, frame)
      buf = buf.subarray(HEADER_LEN + bodyLen)
    }
  }
}
