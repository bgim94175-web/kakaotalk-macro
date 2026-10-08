// 통합 받은함의 순수 병합 (docs/UI_V4.md 6.1). sender 응답을 계정별 상태와 한 목록으로 합친다.
// 라우트는 routes/panel.js, 단위 단언은 lib/panel-inbox-check.js.
'use strict';
const NEEDS_REGISTER_TEXT = '카카오 로그인이 끊겼습니다. 계정을 다시 등록해 주세요.';
const FETCH_FAIL_TEXT = '대화 목록을 가져오지 못했습니다.';

function cleanChat(deviceId, email, c) {
  return {
    device_id: deviceId, email: email,
    chat_id: String(c.chat_id), list_kind: 'open_dm',
    name: String(c.name || ''), preview: String(c.preview || ''),
    unread: Number(c.unread) || 0, last_at: Number(c.last_at) || 0,
  };
}

// rows: [{device_id,email}] (created_at 순), settled: Promise.allSettled 결과(같은 순서), senderUp: sender.up()
function mergeInbox(rows, settled, senderUp) {
  const accounts = [];
  const chats = [];
  rows.forEach((row, i) => {
    const out = { device_id: row.device_id, email: row.email, status: 'error', reason: '', connected: null, unread: 0, chats: 0, error: '' };
    const r = settled[i];
    const json = r && r.status === 'fulfilled' && r.value ? r.value.json : null;
    if (!senderUp) {
      out.status = 'sender_down'; out.reason = 'sender_down';
    } else if (json && json.ok) {
      const list = (Array.isArray(json.chats) ? json.chats : [])
        .filter((c) => c && c.list_kind === 'open_dm' && /^[1-9][0-9]*$/.test(String(c.chat_id)));
      out.status = 'live';
      out.connected = typeof json.connected === 'boolean' ? json.connected : null;
      list.forEach((c) => { const n = cleanChat(row.device_id, row.email, c); out.unread += n.unread; chats.push(n); });
      out.chats = list.length;
    } else if (json && json.needs_register) {
      out.status = 'needs_register'; out.reason = String(json.error || 'needs_register'); out.error = NEEDS_REGISTER_TEXT;
    } else {
      const e = r && r.status === 'rejected' ? r.reason : null;
      if (e && e.code === 'sender_down') { out.status = 'sender_down'; out.reason = 'sender_down'; }
      else {
        out.reason = e && e.message === 'timeout' ? 'timeout' : ((e && e.code) || (json ? 'bad_status' : 'failed'));
        out.error = FETCH_FAIL_TEXT;
      }
    }
    accounts.push(out);
  });
  chats.sort((a, b) => (b.last_at - a.last_at) || (b.unread - a.unread));
  return { accounts, chats };
}

module.exports = { mergeInbox, NEEDS_REGISTER_TEXT, FETCH_FAIL_TEXT };
