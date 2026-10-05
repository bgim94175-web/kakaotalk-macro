// 오픈채팅방에는 오픈 단체방만 넣는다.
// 링크 아이디(li)가 숫자여도 오픈링크 이름(ln)을 읽는다. 그 이름이 방 제목이다.
// 멤버 닉네임을 쉼표로 이은 문자열은 방 이름이 아니다.
// OD 와 오픈프로필 1:1 은 open_dm 으로 두고 고르는 목록에는 올리지 않는다.
// 일반 채팅은 normal 로 두고, 고르는 목록에도 올리지 않는다.

function text(v) {
  return v == null ? '' : String(v).trim()
}

function linkId(ch) {
  if (!ch) return ''
  return text(ch.link_id || ch.li)
}

// 방 제목. 멤버 닉네임을 그대로 이은 문자열은 제목이 아니다.
// 제목 안에 닉네임이 들어 있는 진짜 오픈채팅 이름은 그대로 둔다.
export function roomTitle(ch) {
  const title = text(ch && ch.title)
  if (!title) return ''
  const members = text(ch && ch.display_name)
  if (members && title === members) return ''
  return title
}

function multiType(s) {
  return s === 'OM' || s === 'OpenMulti' || s === 'OpenMultiChat' || s === '13' || s === '15'
}

function directType(s) {
  return s === 'OD' || s === 'OpenDirect' || s === 'OpenDirectChat' || s === '14' || s === '16'
}

export function roomListKind(ch) {
  const raw = ch && ch.type
  const s = raw == null ? '' : String(raw)
  if (directType(s)) return 'open_dm'
  if (multiType(s)) return 'open_room'
  const link = linkId(ch)
  if (!link) return 'normal'
  const members = Number(ch && ch.active_members)
  if (members > 0 && members <= 2) return 'open_dm'
  if (roomTitle(ch)) return 'open_room'
  return 'normal'
}
