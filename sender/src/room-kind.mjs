// Room-picker buckets from the chat `type` already on the LOCO list.
// Keep this in step with android/engine/src/main.mjs roomListKind and
// android RoomKind.java. String tags OM / OD are the protocol names.
// Numeric 2, 13, 15 vs 14, 16 splits the open family the library already
// treats as open. That numeric split is not confirmed on a live session.

export function roomListKind(ch) {
  const raw = ch && ch.type
  const s = raw == null ? '' : String(raw)
  if (s === 'OD' || s === 'OpenDirect' || s === 'OpenDirectChat' || s === '14' || s === '16') {
    return 'open_dm'
  }
  if (s === 'OM' || s === 'OpenMulti' || s === 'OpenMultiChat' || s === '2' || s === '13' || s === '15') {
    return 'open_room'
  }
  return 'normal'
}
