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

// 오픈 단체방. 오픈프로필 1:1 과 일반 채팅은 이름을 붙이지 않는다.
// 오픈링크 id(li)가 있으면 type 값과 상관없이 오픈채팅이다. 2025-09 의 커뮤니티 타입 방처럼
// 카카오가 새 type 값을 보내도 방 이름(오픈링크 이름)을 읽어야 목록에서 빠지지 않는다.
export function openMultiCandidate(ch) {
  const s = ch && ch.type == null ? '' : String(ch.type)
  if (directType(s)) return false
  if (multiType(s)) return true
  if (!linkId(ch)) return false
  const members = Number(ch && ch.active_members)
  return !(members > 0 && members <= 2)
}

// 헤더의 1424, 1428 처럼 인원 수가 이름 뒤에 붙는 경우는 방 이름이 아니다.
export function withoutMemberCount(name, members) {
  const s = text(name)
  const n = Number(members)
  if (!s || !Number.isInteger(n) || n < 10) return s
  const suffix = ' ' + String(n)
  if (!s.endsWith(suffix)) return s
  const bare = s.slice(0, s.length - suffix.length).trim()
  return bare || s
}

// 오픈링크 이름(ln)을 단체방 제목으로 붙인다. 없는 이름은 만들지 않는다.
export function stampOpenLinkTitles(chats, nameByLinkId) {
  const list = Array.isArray(chats) ? chats : []
  return list.map((ch) => {
    if (!ch || !openMultiCandidate(ch) || !nameByLinkId) return ch
    const id = linkId(ch)
    const raw = typeof nameByLinkId.get === 'function' ? nameByLinkId.get(id) : nameByLinkId[id]
    const name = withoutMemberCount(raw, ch.active_members)
    if (!name) return ch
    return Object.assign({}, ch, { title: name })
  })
}
