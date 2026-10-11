// 오픈채팅방에는 오픈 단체방만 넣는다.
// 링크 아이디(li)가 숫자여도 오픈링크 이름(ln)을 읽는다. 그 이름이 방 제목이다.
// 멤버 닉네임을 쉼표로 이은 문자열은 방 이름이 아니다.
// OD 와 오픈프로필 1:1 은 open_dm 으로 두고 고르는 목록에는 올리지 않는다.
// 일반 채팅은 normal 로 두고, 고르는 목록에도 올리지 않는다.
// 방 종류는 이름이 아니라 사실(type·링크·인원)로 정한다. 이름을 못 읽은 방도 종류는 그대로다.

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
  // 카카오가 준 오픈링크 이름은 닉네임과 같아도 방 이름이다.
  const linkName = text(ch && ch.link_name)
  if (linkName) return linkName
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

// 확실한 사실부터 본다.
// 1. OD 문자열은 1:1.
// 2. 오픈링크가 있고 3명 이상이면 단체방이다. 1:1 에는 2명보다 많이 있을 수 없다(type 14·16 이어도).
// 3. 14·16 은 1:1, OM·13·15 는 단체방.
// 4. 링크가 없으면 일반 채팅.
// 5. 링크가 있고 1~2명이면 1:1(오픈프로필 1:1 은 type 2 로도 온다). 인원을 모르면 단체방으로 본다.
// 2025-09 의 커뮤니티 타입 방처럼 카카오가 새 type 값을 보내도 오픈링크가 있으면 오픈채팅이다.
export function roomListKind(ch) {
  const raw = ch && ch.type
  const s = raw == null ? '' : String(raw)
  if (s === 'OD' || s === 'OpenDirect' || s === 'OpenDirectChat') return 'open_dm'
  const link = linkId(ch)
  const members = Number(ch && ch.active_members)
  if (link && members > 2) return 'open_room'
  if (directType(s)) return 'open_dm'
  if (multiType(s)) return 'open_room'
  if (!link) return 'normal'
  if (members > 0 && members <= 2) return 'open_dm'
  return 'open_room'
}

// 오픈 단체방. 오픈프로필 1:1 과 일반 채팅은 이름을 붙이지 않는다.
// 오픈링크 이름(ln)을 읽을 링크가 있어야 한다.
export function openMultiCandidate(ch) {
  return !!linkId(ch) && roomListKind(ch) === 'open_room'
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
    return Object.assign({}, ch, { title: name, link_name: name })
  })
}
