// 오픈채팅방에는 오픈 단체방만 넣는다. 목록의 숫자 타입만으로는 넣지 않는다.
// LCHATLIST 의 type 2 는 예전 코드가 오픈으로 보던 값이고, 제목이 없으면
// 표시 이름이 멤버 닉네임을 쉼표로 이은 문자열이다. 그 문자열은 방 이름이 아니다.
// 오픈 단체방은 OM / OpenMulti 이거나, 오픈링크(li)와 방 제목이 함께 있을 때다.
// OD 와 오픈프로필 1:1 은 open_dm 으로 두고 고르는 목록에는 올리지 않는다.

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

export function roomListKind(ch) {
  const raw = ch && ch.type
  const s = raw == null ? '' : String(raw)
  if (s === 'OD' || s === 'OpenDirect' || s === 'OpenDirectChat' || s === '14' || s === '16') {
    return 'open_dm'
  }
  if (s === 'OM' || s === 'OpenMulti' || s === 'OpenMultiChat') {
    return 'open_room'
  }
  const link = linkId(ch)
  if (!link) return 'normal'
  if ((s === '13' || s === '15') && roomTitle(ch)) return 'open_room'
  const members = Number(ch && ch.active_members)
  if (s === '2') {
    if (members > 2 && roomTitle(ch)) return 'open_room'
    if (members > 0 && members <= 2) return 'open_dm'
  }
  return 'normal'
}
