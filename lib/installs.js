// 방 설치 수명 — 미리 보기 · 주문 예약 · 봇 배정 · 다시 시도 · 옮기기 · 해제 (docs/ACCOUNTS_V1.md 0.1·3.3·3.4·3.5·4.4·5.6)
//
// room_installs 행 1개 = 오픈채팅방 1개에 대한 설치 권리(상품 2종을 함께 가질 수 있음).
// 부모(이 모듈)가 쓰는 칸과 sender 가 쓰는 칸이 나뉘어 있다(2.2). 부모가 sender 칸(state·error_code…)을 쓰는
// 경우는 "다시 입장" 묶음 하나뿐이다: 배정·다시 시도·옮기기·링크 바꾸기 때 한 UPDATE 로
//   state='queued', error_code=NULL, error_detail=NULL, next_try_at=NULL, perm=NULL, perm_at=NULL, state_at=$now
// (+ assignBot 이 봇을 못 찾았을 때의 error_detail='no_bot').
//
// 충돌 규칙(D8·D9): 결제된(installed) 설치만 배타적이다. 미입금 예약(pending_payment)은 다른 회원을 막지 않고,
// 먼저 입금된 주문이 방을 갖는다. 봇이 내보내진 설치(error_code='kicked')는 배타권을 잃는다.
// 트랜잭션 안의 UNIQUE 위반은 트랜잭션 전체를 깨뜨리므로 INSERT·UPDATE 전에 SELECT 로 먼저 확인한다(conflictFor).
//
// 화면 문구(상태 라벨·보조 문구·오류 문구)는 이 파일의 ERRORS·displayOf 가 단일 소스다.
// 콘솔·사이트·관리 화면은 서버가 준 label·detail 을 그대로 쓴다.
'use strict';

const db = require('./db');
const openchat = require('./openchat');
const secretbox = require('./secretbox');
const senderChild = require('./sender-child');
const features = require('./features');
const pricing = require('./pricing');
const audit = require('./audit');

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const BOT_LOCK_KEY = 1262636884;        // 0x4B424F54 'KBOT' — 봇 배정 직렬화(4.4)
const PREVIEW_CACHE_MS = 10 * MINUTE;   // 같은 링크 조회 결과를 10분 메모리에 둔다(3.3)
const PREVIEW_CACHE_MAX = 500;
const STALE_JOIN_MS = 15 * MINUTE;      // 입장 중에 멈춘 행을 되돌리는 기준(4.4)
const RETRY_MAX_GAP_MS = 6 * HOUR;
const RETRY_ADMIN_AFTER = 10;           // 고객 연속 다시 시도 상한(D16)
const PASSCODE_MAX = 20;

function envNum(name, dflt) {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : dflt;
}

// ── 5.6 오류 코드 표 ────────────────────────────────────────────────────────
// short = 상태 라벨 뒤에 붙는 짧은 사유(`오류 · {short}`), long = 화면의 긴 문구, retry = 고객 다시 시도 대상.
// kicked 의 「{닉네임}」 은 displayOf 가 봇 닉네임으로 바꾼다(모르면 그 부분을 뺀다).
const ERRORS = Object.freeze({
  passcode_needed: Object.freeze({ short: '참여코드 필요', retry: true, passcode: true,
    long: '참여코드가 필요한 방입니다. 참여코드를 입력한 뒤 다시 시도하십시오.' }),
  passcode_wrong: Object.freeze({ short: '참여코드 불일치', retry: true, passcode: true,
    long: '참여코드가 맞지 않아 입장하지 못했습니다. 참여코드를 고친 뒤 다시 시도하십시오.' }),
  room_full: Object.freeze({ short: '인원 초과', retry: true,
    long: '방 인원이 가득 차 입장하지 못했습니다. 자리가 생긴 뒤 다시 시도하십시오.' }),
  kicked: Object.freeze({ short: '내보내짐', retry: true,
    long: 'K bot 계정 「{닉네임}」이 방에서 내보내졌습니다. 방장이 내보내기 목록에서 이 계정을 해제한 뒤 다시 시도하십시오.' }),
  left: Object.freeze({ short: '방 나감', retry: true,
    long: 'K bot 계정이 방에서 나갔습니다. 다시 시도하면 다시 입장합니다.' }),
  profile_blocked: Object.freeze({ short: '프로필 제한', retry: true,
    long: '이 방은 기본 프로필 참여를 허용하지 않아 입장하지 못했습니다. 방장이 오픈채팅방 설정에서 기본 프로필 참여를 허용한 뒤 다시 시도하십시오.' }),
  kakao_error: Object.freeze({ short: '입장 거부', retry: true,
    long: '카카오 서버가 입장을 거부했습니다. 잠시 뒤 다시 시도하십시오.' }),
  link_gone: Object.freeze({ short: '링크 만료', retry: false,
    long: '링크가 만료되었거나 삭제된 방입니다. 새 링크로 바꾸려면 문의하십시오.' }),
  room_deleted: Object.freeze({ short: '방 삭제됨', retry: false,
    long: '방장이 오픈채팅방을 삭제했습니다. 문의하십시오.' }),
  not_group: Object.freeze({ short: '설치 불가 링크', retry: false,
    long: '그룹 오픈채팅방 링크가 아닙니다. 새 링크로 바꾸려면 문의하십시오.' }),
  link_changed: Object.freeze({ short: '링크 불일치', retry: false,
    long: '링크가 처음 등록한 방과 다른 방을 가리킵니다. 문의하십시오.' }),
  duplicate_room: Object.freeze({ short: '중복 설치', retry: false,
    long: '이 방에는 이미 다른 설치가 있습니다. 문의하십시오.' }),
  room_taken: Object.freeze({ short: '다른 회원 설치', retry: false,
    long: 'K bot이 내보내진 동안 다른 회원이 이 방에 설치했습니다. 문의하십시오.' }),
  blocked: Object.freeze({ short: '설치 불가 방', retry: false,
    long: '이 방에는 K bot을 설치할 수 없습니다. 문의하십시오.' }),
  bot_down: Object.freeze({ short: 'K bot 계정 점검', retry: false,
    long: '이 방을 맡은 K bot 계정의 연결이 끊겼습니다. 운영자가 복구하면 자동으로 이어집니다.' }),
});
const UNKNOWN_ERROR = Object.freeze({ short: '확인 필요', retry: false,
  long: '방 상태를 확인하지 못했습니다. 문의하십시오.' });

// 0.1 표의 라벨
const LABELS = Object.freeze({
  pending: '입금 대기',
  joining: '입장 중',
  waiting: '부방장 대기',
  active: '사용 중',
  error: '오류',
  canceled: '취소됨',
  removed: '설치 해제',
});

// 미리 보기·주문 공통 문구(3.3)
const TEXT = Object.freeze({
  bad_link: '오픈채팅방 링크 형식이 아닙니다. https://open.kakao.com/o/ 로 시작하는 링크를 입력하십시오.',
  blocked_room: '이 방에는 K bot을 설치할 수 없습니다.',
  not_found: '링크가 만료되었거나 없는 방입니다.',
  not_group: '그룹 오픈채팅방 링크가 아닙니다. 1:1 오픈채팅과 오픈프로필 링크에는 설치할 수 없습니다.',
  taken: '이 방에는 다른 회원이 설치한 K bot이 있습니다. 방장이라면 K bot 계정을 방에서 내보낸 뒤 다시 확인하거나 문의하십시오.',
  pending_exists: '이 방은 입금 대기 중인 내 주문에 들어 있습니다. 내 계정의 구매 내역에서 확인하십시오',
  no_room: '없는 방입니다.',
  bad_passcode: '참여코드는 ' + PASSCODE_MAX + '자 이하로 입력하십시오',
});

// 방 관리 기능(on_count 가 세는 것, 3.4.2)
const ROOMBOT_SECTIONS = ['visit', 'churn', 'leaveKick', 'profile', 'promo', 'cover', 'guard'];

// ── 작은 도구 ───────────────────────────────────────────────────────────────
function num(v) { return v === null || v === undefined ? null : Number(v); }

function toId(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(String(v).trim());
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

function fail(status, reason, error, extra) {
  return Object.assign({ ok: false, status: status, reason: reason, error: error }, extra || {});
}

// 한국 시각 HH:MM (서버는 UTC 에서 돈다)
const HHMM_FMT = new Intl.DateTimeFormat('ko-KR', {
  timeZone: 'Asia/Seoul', hour: '2-digit', minute: '2-digit', hour12: false,
});
function hhmm(ms) {
  const parts = HHMM_FMT.formatToParts(new Date(Number(ms) || 0));
  const h = (parts.find((p) => p.type === 'hour') || {}).value || '00';
  const m = (parts.find((p) => p.type === 'minute') || {}).value || '00';
  return String(h).padStart(2, '0').replace(/^24$/, '00') + ':' + String(m).padStart(2, '0');
}

// 받침 판정 — 을/를, 이/가 고르기. 닉네임은 영문·숫자가 섞이므로 읽는 소리로 대강 고른다.
function hasBatchim(word) {
  const s = String(word || '').replace(/[^0-9A-Za-z가-힣]+$/, '');
  if (!s) return false;
  const ch = s.charAt(s.length - 1);
  const code = ch.charCodeAt(0);
  if (code >= 0xAC00 && code <= 0xD7A3) return (code - 0xAC00) % 28 !== 0;
  if (/[0-9]/.test(ch)) return '013678'.indexOf(ch) >= 0;          // 영 일 삼 육 칠 팔
  return 'bcdgklmnpqt'.indexOf(ch.toLowerCase()) >= 0;              // bot → 봇, kim → 킴 …
}
function josa(word, withB, withoutB) { return hasBatchim(word) ? withB : withoutB; }

function jsonObj(v) {
  const o = db.jsonOf(v);
  return o && typeof o === 'object' && !Array.isArray(o) ? o : {};
}

function linkShort(url) { return openchat.shortLink(url); }

// ── 다시 시도 간격(3.4.3) ──────────────────────────────────────────────────
function retryBaseMs() { return envNum('ROOM_RETRY_BASE_MS', 2 * MINUTE); }

function retryGapMs(n) {
  if (n <= 0) return 0;
  const gap = retryBaseMs() * Math.pow(2, Math.min(n - 1, 30));
  return Math.min(gap, RETRY_MAX_GAP_MS);
}

// 직전 다시 시도 뒤 입장에 성공했으면(joined_at > retry_at, 또는 retry_at 없음) 새 사건이라 횟수를 0 으로 본다.
function retryInfo(row, now) {
  const t = now == null ? Date.now() : Number(now);
  const retryAt = num(row.retry_at);
  const joinedAt = num(row.joined_at);
  const fresh = !retryAt || (joinedAt !== null && joinedAt > retryAt);
  const n = fresh ? 0 : (Number(row.retry_n) || 0);
  const nextAt = n > 0 ? retryAt + retryGapMs(n) : 0;
  return { n: n, next_at: nextAt > t ? nextAt : 0 };
}

// ── 확인 대기 낱말(D28) ────────────────────────────────────────────────────
function holdWords() {
  return String(process.env.ROOM_HOLD_WORDS || '')
    .split(',').map((w) => w.trim()).filter(Boolean);
}

// 방 이름에 걸린 낱말 하나(대소문자 무시) 또는 null
function holdWordFor(name) {
  const n = String(name || '').toLowerCase();
  if (!n) return null;
  for (const w of holdWords()) if (n.indexOf(w.toLowerCase()) >= 0) return w;
  return null;
}

// ── 화면 상태(0.1) ──────────────────────────────────────────────────────────
function onCountOf(row) {
  if (!row || !row.roombot) return 0;
  const cfg = jsonObj(row.config);
  let n = 0;
  for (const k of ROOMBOT_SECTIONS) if (cfg[k] && cfg[k].enabled === true) n += 1;
  return n;
}

function errorEntry(code) { return ERRORS[code] || UNKNOWN_ERROR; }

function errorLong(code, nickname) {
  const e = errorEntry(code);
  if (e.long.indexOf('{닉네임}') < 0) return e.long;
  const nick = String(nickname || '').trim();
  if (!nick) return e.long.replace(' 「{닉네임}」이', '이');
  return e.long.replace('「{닉네임}」이', '「' + nick + '」' + josa(nick, '이', '가'));
}

function waitingDetail(nickname) {
  const nick = String(nickname || '').trim();
  const who = nick ? 'K bot 계정 「' + nick + '」' + josa(nick, '을', '를') : 'K bot 계정을';
  return '방장이 오픈채팅방의 부방장 관리에서 ' + who + ' 부방장으로 지정하십시오. 지정되면 1~2분 안에 자동으로 감지합니다.';
}

// row(room_installs, bot_nickname 이 붙어 있으면 그 값을 씀) → {display, label, detail, can_retry, retry_after, retry_admin_only}
// opts.nickname 으로 봇 닉네임을 따로 줄 수 있다.
function displayOf(row, now, opts) {
  const t = now == null ? Date.now() : Number(now);
  const o = opts || {};
  const r = row || {};
  const nick = o.nickname !== undefined ? o.nickname : (r.bot_nickname || null);
  const out = { display: 'joining', label: LABELS.joining, detail: '', can_retry: false, retry_after: 0, retry_admin_only: false };

  if (r.phase === 'pending_payment') {
    out.display = 'pending'; out.label = LABELS.pending;
    out.detail = '입금이 확인되면 K bot 계정이 입장합니다.';
    return out;
  }
  if (r.phase === 'canceled') {
    out.display = 'canceled'; out.label = LABELS.canceled; out.detail = '';
    return out;
  }
  if (r.phase === 'removed') {
    out.display = 'removed'; out.label = LABELS.removed; out.detail = '';
    return out;
  }

  // installed
  if (r.hold_reason) {
    out.display = 'joining'; out.label = LABELS.joining;
    out.detail = '운영자 확인 뒤 입장합니다.';
    return out;
  }
  const state = r.state || 'queued';
  if (state === 'waiting_host') {
    out.display = 'waiting'; out.label = LABELS.waiting;
    out.detail = waitingDetail(nick);
    return out;
  }
  if (state === 'active') {
    out.display = 'active'; out.label = LABELS.active; out.detail = '';
    if (r.roombot && onCountOf(r) === 0) {
      out.label = LABELS.active + ' · 켜진 기능 없음';
      out.detail = '방 관리 기능이 모두 꺼져 있습니다. 입장·퇴장 로그부터 켜십시오.';
    }
    return out;
  }
  if (state === 'error') {
    const code = r.error_code || '';
    const e = errorEntry(code);
    out.display = 'error';
    out.label = LABELS.error + ' · ' + e.short;
    out.detail = errorLong(code, nick);
    if (e.retry) {
      const ri = retryInfo(r, t);
      if (ri.n >= RETRY_ADMIN_AFTER) {
        out.retry_admin_only = true;
        out.detail += ' 다시 시도 횟수를 넘었습니다. 문의하십시오.';
      } else {
        out.can_retry = true;
        out.retry_after = ri.next_at;
      }
    }
    return out;
  }
  // queued · joining
  out.display = 'joining';
  if (!r.bot_device_id && r.error_detail === 'no_bot') {
    out.label = LABELS.joining + ' · 순서 대기';
    out.detail = '입장 순서를 기다리고 있습니다. 순서가 되면 자동으로 입장합니다.';
  } else if (r.error_detail === 'rate_limited' && num(r.next_try_at) && num(r.next_try_at) > t) {
    out.detail = '카카오 입장 제한으로 ' + hhmm(r.next_try_at) + '에 다시 입장합니다.';
  } else {
    out.detail = 'K bot 계정이 이 방에 입장하고 있습니다.';
  }
  return out;
}

function productsOf(v) {
  if (Array.isArray(v)) {
    return { roombot: v.indexOf('roombot') >= 0, minigame: v.indexOf('minigame') >= 0 };
  }
  const o = v || {};
  return { roombot: !!o.roombot, minigame: !!o.minigame };
}

function orderUrl(orderId, token) {
  if (!orderId || !token) return null;
  return features.purchaseBase(null) + '/order/' + orderId + '?t=' + token;
}

// RoomView (3.4.2). botRow = bot_accounts 행(닉네임) 또는 생략(row.bot_nickname 사용),
// pending = 처리 대기 주문 줄의 상품({roombot,minigame} 또는 배열), order = {id, url} 또는 {id, token}.
function publicView(row, botRow, pending, order, now) {
  const r = row || {};
  const nickRaw = botRow && botRow.nickname !== undefined ? botRow.nickname : r.bot_nickname;
  const nick = nickRaw ? String(nickRaw) : '';
  const d = displayOf(r, now, { nickname: nick || null });
  const state = r.state || 'queued';
  const code = r.phase === 'installed' && state === 'error' ? (r.error_code || null) : null;
  let ord = null;
  if (r.phase === 'pending_payment' && order && order.id) {
    ord = { id: order.id, url: order.url || orderUrl(order.id, order.token) };
  }
  return {
    id: Number(r.id),
    link_url: r.link_url || null,
    link_name: r.link_name || null,
    products: { roombot: !!r.roombot, minigame: !!r.minigame },
    pending_products: productsOf(pending),
    display: d.display,
    label: d.label,
    detail: d.detail,
    error_code: code,
    can_retry: d.can_retry,
    retry_after: d.retry_after,
    retry_admin_only: d.retry_admin_only,
    needs_passcode: !!(code && errorEntry(code).passcode),
    bot: r.bot_device_id ? { nickname: nick || 'K bot 계정' } : null,
    on_count: onCountOf(r),
    order: ord,
    perm: r.perm === null || r.perm === undefined ? 0 : Number(r.perm),
    joined_at: num(r.joined_at) || 0,
    state_at: num(r.state_at) || 0,
    config_rev: Number(r.config_rev) || 0,
  };
}

// ── DB 조회 도구 ────────────────────────────────────────────────────────────
const VIEW_SELECT = `
  SELECT r.*, b.nickname AS bot_nickname, o.token AS order_token
    FROM room_installs r
    LEFT JOIN bot_accounts b ON b.device_id = r.bot_device_id
    LEFT JOIN orders o ON o.id = r.order_id`;

// 설치 id → {roombot, minigame} : 처리 대기 주문(pending·paid)의 줄 가운데 그 설치를 가리키는 것.
// memberId 를 주면 그 회원의 주문만, installIds 를 주면 그 설치만 본다.
async function pendingProducts(opts, client) {
  const o = opts || {};
  const params = [];
  const where = ["status IN ('pending','paid')", 'items IS NOT NULL'];
  if (o.memberId != null) { params.push(o.memberId); where.push('member_id=$' + params.length); }
  const r = await db.q('SELECT id, items FROM orders WHERE ' + where.join(' AND '), params, client);
  const want = o.installIds ? new Set(o.installIds.map(Number)) : null;
  const out = new Map();
  for (const row of r.rows) {
    const items = db.jsonOf(row.items);
    if (!Array.isArray(items)) continue;
    for (const it of items) {
      const iid = toId(it && it.install_id);
      if (!iid || (want && !want.has(iid))) continue;
      if (it.product !== 'roombot' && it.product !== 'minigame') continue;
      const cur = out.get(iid) || { roombot: false, minigame: false };
      cur[it.product] = true;
      out.set(iid, cur);
    }
  }
  return out;
}

// 그 설치·상품이 처리 대기 주문에 들어 있나 (주문 줄 JSON 검사, 3.3 처리 2)
async function pendingHas(client, installId, product) {
  const r = await db.q(
    `SELECT o.id
       FROM orders o,
            jsonb_array_elements(CASE WHEN jsonb_typeof(o.items) = 'array' THEN o.items ELSE '[]'::jsonb END) it
      WHERE o.status IN ('pending','paid')
        AND it->>'install_id' = $1 AND it->>'product' = $2
      LIMIT 1`,
    [String(installId), product], client);
  return r.rows[0] ? r.rows[0].id : null;
}

function viewOf(row, pendingMap, now) {
  const order = row.order_id && row.order_token ? { id: row.order_id, token: row.order_token } : null;
  return publicView(row, null, pendingMap ? pendingMap.get(Number(row.id)) : null, order, now);
}

// 회원의 내 방 목록(phase installed·pending_payment, 최근순)
async function listForMember(memberId) {
  const mid = toId(memberId);
  if (!mid) return [];
  const r = await db.q(VIEW_SELECT +
    ` WHERE r.member_id=$1 AND r.phase IN ('installed','pending_payment')
      ORDER BY r.created_at DESC, r.id DESC LIMIT 200`, [mid]);
  const pend = await pendingProducts({ memberId: mid });
  const now = Date.now();
  return r.rows.map((row) => viewOf(row, pend, now));
}

// 회원 소유이고 phase installed·pending_payment 인 설치 1개 → {row, view} | null
async function getForMember(memberId, installId) {
  const mid = toId(memberId);
  const id = toId(installId);
  if (!mid || !id) return null;
  const row = await db.one(VIEW_SELECT +
    ` WHERE r.id=$1 AND r.member_id=$2 AND r.phase IN ('installed','pending_payment')`, [id, mid]);
  if (!row) return null;
  const pend = await pendingProducts({ memberId: mid, installIds: [id] });
  return { row: row, view: viewOf(row, pend, Date.now()) };
}

// 설치 여러 개를 RoomView 로 (주문 화면·관리 화면용). 순서는 ids 순서.
async function viewsByIds(ids) {
  const list = (ids || []).map(toId).filter(Boolean);
  if (!list.length) return [];
  const r = await db.q(VIEW_SELECT + ' WHERE r.id = ANY($1::bigint[])', [list]);
  const pend = await pendingProducts({ installIds: list });
  const byId = new Map(r.rows.map((row) => [Number(row.id), row]));
  const now = Date.now();
  const out = [];
  for (const id of list) {
    const row = byId.get(id);
    if (row) out.push({ row: row, view: viewOf(row, pend, now) });
  }
  return out;
}

// ── 충돌·금지 검사(3.3 처리 3) ───────────────────────────────────────────
// taken = 다른(=selfId 가 아닌) 결제된 설치, mine = 이 회원의 같은 방 예약(pending_payment)
async function conflictFor(client, opts) {
  const o = opts || {};
  const self = toId(o.selfId) || -1;
  const linkId = o.linkId === null || o.linkId === undefined || o.linkId === '' ? null : String(o.linkId);
  const linkUrl = o.linkUrl ? String(o.linkUrl) : null;
  if (!linkId && !linkUrl) return { taken: null, mine: null };
  const taken = await db.one(
    `SELECT id, member_id, link_id, link_url, link_name, phase FROM room_installs
      WHERE phase='installed' AND error_code IS DISTINCT FROM 'kicked' AND id <> $1
        AND (link_url = $3 OR ($2::text IS NOT NULL AND link_id = $2))
      ORDER BY id LIMIT 1`,
    [self, linkId, linkUrl], client);
  let mine = null;
  const mid = toId(o.memberId);
  if (mid) {
    mine = await db.one(
      `SELECT id, member_id, link_id, link_url, link_name, phase, order_id FROM room_installs
        WHERE member_id=$4 AND phase='pending_payment' AND id <> $1
          AND (link_url = $3 OR ($2::text IS NOT NULL AND link_id = $2))
        ORDER BY id LIMIT 1`,
      [self, linkId, linkUrl, mid], client);
  }
  return { taken: taken, mine: mine };
}

async function isBlocked(client, opts) {
  const o = opts || {};
  const linkId = o.linkId === null || o.linkId === undefined || o.linkId === '' ? null : String(o.linkId);
  const linkUrl = o.linkUrl ? String(o.linkUrl) : null;
  if (!linkId && !linkUrl) return false;
  const r = await db.q(
    `SELECT 1 FROM room_blocklist
      WHERE ($1::text IS NOT NULL AND link_id = $1) OR ($2::text IS NOT NULL AND link_url = $2)
      LIMIT 1`, [linkId, linkUrl], client);
  return r.rowCount > 0;
}

// ── 링크 조회(sender /v1/bot/resolve) ──────────────────────────────────────
const resolveCache = new Map();   // url → {at, res}

function cacheSet(url, res) {
  resolveCache.set(url, { at: Date.now(), res: res });
  while (resolveCache.size > PREVIEW_CACHE_MAX) {
    const first = resolveCache.keys().next().value;
    resolveCache.delete(first);
  }
}

// → {ok:true, link_id, name, needs_passcode, profile_only, max_users}
// | {ok:false, error:'not_found'|'not_group'|'no_bot'|'budget'|'kakao_error'|'sender_down'|…}
// 확인된 결과와 확정 실패(not_found·not_group)만 10분 둔다. 조회하지 못한 경우는 두지 않는다(곧 다시 시도할 수 있게).
async function resolveLink(url) {
  const hit = resolveCache.get(url);
  if (hit && Date.now() - hit.at < PREVIEW_CACHE_MS) return hit.res;
  if (hit) resolveCache.delete(url);
  let res;
  if (!senderChild.up()) {
    res = { ok: false, error: 'sender_down' };
  } else {
    try {
      const r = await senderChild.call('POST', '/v1/bot/resolve', { url: url }, 20000);
      const j = r && r.json ? r.json : {};
      const li = j.link_id === null || j.link_id === undefined ? '' : String(j.link_id).trim();
      if (r.status === 200 && j.ok === true && /^-?\d{1,30}$/.test(li)) {
        res = {
          ok: true,
          link_id: li,
          name: j.name ? String(j.name).slice(0, 200) : null,
          needs_passcode: !!j.needs_passcode,
          profile_only: !!j.profile_only,
          max_users: j.max_users === null || j.max_users === undefined || j.max_users === '' ? null : Number(j.max_users),
        };
      } else if (j.ok === false && (j.error === 'not_found' || j.error === 'not_group')) {
        res = { ok: false, error: j.error };
      } else {
        res = { ok: false, error: (j && j.error) ? String(j.error) : 'http_' + (r ? r.status : 0) };
      }
    } catch (e) {
      res = { ok: false, error: 'sender_down' };
    }
  }
  if (res.ok || res.error === 'not_found' || res.error === 'not_group') cacheSet(url, res);
  return res;
}

function clearPreviewCache() { resolveCache.clear(); }

// ── 미리 보기(POST /api/room-preview, 3.3) ─────────────────────────────────
async function preview(memberId, text) {
  const mid = toId(memberId);
  const url = openchat.normLink(text);
  if (!url) return fail(400, 'bad_link', TEXT.bad_link);
  if (await isBlocked(null, { linkUrl: url })) return fail(403, 'blocked_room', TEXT.blocked_room);

  const res = await resolveLink(url);
  if (!res.ok && res.error === 'not_found') return fail(404, 'not_found', TEXT.not_found);
  if (!res.ok && res.error === 'not_group') return fail(422, 'not_group', TEXT.not_group);
  const verified = !!res.ok;
  const linkId = verified ? res.link_id : null;
  if (linkId && await isBlocked(null, { linkId: linkId })) return fail(403, 'blocked_room', TEXT.blocked_room);

  // 다른 회원의 결제된 설치(내보내진 설치 제외)만 막는다. 다른 회원의 미입금 주문은 막지 않는다(D9).
  const taken = await db.one(
    `SELECT id FROM room_installs
      WHERE phase='installed' AND error_code IS DISTINCT FROM 'kicked' AND member_id <> $1
        AND (link_url = $2 OR ($3::text IS NOT NULL AND link_id = $3))
      LIMIT 1`, [mid || -1, url, linkId]);
  if (taken) return fail(409, 'taken', TEXT.taken);

  let mine = null;
  const available = { roombot: true, minigame: true };
  if (mid) {
    const row = await db.one(VIEW_SELECT +
      ` WHERE r.member_id=$1 AND r.phase IN ('installed','pending_payment')
          AND (r.link_url = $2 OR ($3::text IS NOT NULL AND r.link_id = $3))
        ORDER BY (r.phase = 'installed') DESC, r.id DESC LIMIT 1`, [mid, url, linkId]);
    if (row) {
      const pend = await pendingProducts({ memberId: mid, installIds: [Number(row.id)] });
      const p = pend.get(Number(row.id)) || { roombot: false, minigame: false };
      const d = displayOf(row, Date.now());
      mine = {
        install_id: Number(row.id),
        products: { roombot: !!row.roombot, minigame: !!row.minigame },
        display: d.display,
        label: d.label,
      };
      if (row.phase === 'pending_payment') {
        // 입금 대기 예약이 있는 방은 그 주문이 끝날 때까지 새로 담지 않는다(pending_exists)
        available.roombot = false;
        available.minigame = false;
      } else {
        available.roombot = !row.roombot && !p.roombot;
        available.minigame = !row.minigame && !p.minigame;
      }
    }
  }

  if (!verified) {
    return {
      ok: true, verified: false,
      room: { link_url: url, link_id: null, name: null, needs_passcode: null, profile_only: null },
      mine: mine, available: available,
    };
  }
  return {
    ok: true, verified: true,
    room: {
      link_url: url, link_id: linkId, name: res.name, needs_passcode: res.needs_passcode,
      profile_only: res.profile_only, max_users: res.max_users,
    },
    mine: mine, available: available,
  };
}

// ── 봇 배정(4.4) ───────────────────────────────────────────────────────────
async function pickBot(client, exclude) {
  await db.q('SELECT pg_advisory_xact_lock($1::bigint)', [BOT_LOCK_KEY], client);
  const r = await db.q(
    `SELECT b.device_id
       FROM bot_accounts b
       LEFT JOIN room_installs r ON r.bot_device_id = b.device_id AND r.phase = 'installed'
      WHERE b.enabled AND b.removed_at IS NULL AND b.state <> 'needs_register'
        AND NOT (b.device_id = ANY($1::text[]))
      GROUP BY b.device_id, b.room_cap, b.created_at
     HAVING count(r.id) < b.room_cap
      ORDER BY count(r.id) ASC, b.created_at ASC
      LIMIT 1`, [(exclude || []).filter(Boolean).map(String)], client);
  return r.rows[0] ? r.rows[0].device_id : null;
}

const REENTER_SQL = `state='queued', error_code=NULL, error_detail=NULL, next_try_at=NULL, perm=NULL, perm_at=NULL`;

async function assignBotTx(client, installId, opts) {
  const id = toId(installId);
  if (!id) return null;
  const now = Date.now();
  const bot = await pickBot(client, opts && opts.exclude);
  if (bot) {
    await db.q('UPDATE room_installs SET bot_device_id=$2, ' + REENTER_SQL + ', state_at=$3 WHERE id=$1',
      [id, bot, now], client);
    return bot;
  }
  // REENTER_SQL 의 error_detail=NULL 과 겹치지 않게 칸을 직접 쓴다(같은 칸 두 번 → PG 오류).
  await db.q(
    `UPDATE room_installs SET bot_device_id=NULL, state='queued', error_code=NULL, error_detail='no_bot',
            next_try_at=NULL, perm=NULL, perm_at=NULL, state_at=$2
      WHERE id=$1 AND (bot_device_id IS NOT NULL OR error_detail IS DISTINCT FROM 'no_bot' OR state <> 'queued')`,
    [id, now], client);
  return null;
}

// 트랜잭션 client 안에서 부른다(advisory lock 이 트랜잭션 단위). client 가 없으면 스스로 트랜잭션을 연다.
function assignBot(client, installId, opts) {
  if (client) return assignBotTx(client, installId, opts);
  return db.tx((c) => assignBotTx(c, installId, opts));
}

// ── 주문 예약·취소 ─────────────────────────────────────────────────────────
// room = {link_url, link_id?, link_name?, passcode?|passcode_ct?}
async function reserveForOrder(client, memberId, orderId, room) {
  const mid = toId(memberId);
  const rm = room || {};
  const url = openchat.normLink(rm.link_url || rm.link);
  if (!mid || !url) return { error: TEXT.bad_link, reason: 'bad_link', status: 400 };
  const linkId = rm.link_id === null || rm.link_id === undefined || rm.link_id === '' ? null : String(rm.link_id);
  const c = await conflictFor(client, { memberId: mid, linkId: linkId, linkUrl: url });
  if (c.taken) return { error: TEXT.taken, reason: 'room_taken', status: 409 };
  if (c.mine) return { error: TEXT.pending_exists, reason: 'pending_exists', status: 409 };
  if (await isBlocked(client, { linkId: linkId, linkUrl: url })) {
    return { error: TEXT.blocked_room, reason: 'blocked_room', status: 403 };
  }
  let ct = rm.passcode_ct || null;
  const pc = rm.passcode === null || rm.passcode === undefined ? '' : String(rm.passcode).trim();
  if (!ct && pc) ct = secretbox.seal(pc);
  const r = await db.q(
    `INSERT INTO room_installs (member_id, link_url, link_id, link_name, passcode_ct, phase, order_id, state, created_at)
     VALUES ($1,$2,$3,$4,$5,'pending_payment',$6,'queued',$7) RETURNING id`,
    [mid, url, linkId, rm.link_name ? String(rm.link_name).slice(0, 200) : null, ct, orderId || null, Date.now()],
    client);
  return { install_id: Number(r.rows[0].id) };
}

// 주문이 예약한 입금 대기 설치를 취소. → 취소한 행 수
async function cancelForOrder(client, orderId) {
  if (!orderId) return 0;
  const r = await db.q(
    "UPDATE room_installs SET phase='canceled' WHERE phase='pending_payment' AND order_id=$1",
    [String(orderId)], client);
  return r.rowCount || 0;
}

// POST /api/my/orders/cancel — 이 회원의 pending 주문만. opts.req 가 있으면 감사 기록에 IP 를 남긴다.
async function cancelMemberOrder(memberId, orderId, opts) {
  const mid = toId(memberId);
  const id = String(orderId || '').trim().toUpperCase().replace(/[^A-Z0-9-]/g, '').slice(0, 32);
  if (!mid || !id) return fail(404, 'not_found', '없는 주문입니다.');
  const req = opts && opts.req;
  return db.tx(async (client) => {
    const o = await db.one('SELECT id, status, member_id FROM orders WHERE id=$1 FOR UPDATE', [id], client);
    if (!o || toId(o.member_id) !== mid) return fail(404, 'not_found', '없는 주문입니다.');
    if (o.status !== 'pending') {
      return fail(409, 'not_pending', '입금이 확인된 주문은 취소할 수 없습니다. 문의하십시오.');
    }
    const now = Date.now();
    await db.q(
      `UPDATE orders SET status='canceled', auto_canceled=FALSE, handled_at=$2::bigint,
              memo = COALESCE(memo || ' · 회원 취소', '회원 취소')
        WHERE id=$1`, [id, now], client);
    const n = await cancelForOrder(client, id);
    const info = { member_id: mid, detail: 'member_cancel 주문 ' + id + (n ? ' / 입금 대기 방 ' + n + '개 취소' : '') };
    if (req) await audit.record(req, 'order', info, client);
    else await audit.log('order', info, client);
    return { ok: true, canceled_rooms: n };
  });
}

// ── 고객 경로: 설정 저장·다시 시도 ─────────────────────────────────────────
// config 는 room-config.sanitizeRoomConfig 를 거친 값이다(작업 1 의 콘솔 경로가 검증한다).
async function saveConfig(memberId, installId, config, rev) {
  const mid = toId(memberId);
  const id = toId(installId);
  if (!mid || !id) return fail(404, 'not_found', TEXT.no_room);
  const revN = rev === null || rev === undefined || rev === '' ? null : Number(rev);
  const revOk = Number.isSafeInteger(revN) ? revN : null;
  const r = await db.q(
    `UPDATE room_installs SET config=$3::jsonb, config_rev=config_rev+1, config_at=$4::bigint
      WHERE id=$1 AND member_id=$2 AND phase='installed' AND ($5::int IS NULL OR config_rev=$5::int)
      RETURNING *`,
    [id, mid, JSON.stringify(config && typeof config === 'object' ? config : {}), Date.now(), revOk]);
  if (!r.rowCount) {
    const cur = await db.one('SELECT id, phase FROM room_installs WHERE id=$1 AND member_id=$2', [id, mid]);
    if (!cur || (cur.phase !== 'installed' && cur.phase !== 'pending_payment')) return fail(404, 'not_found', TEXT.no_room);
    if (cur.phase !== 'installed') return fail(409, 'not_installed', '입금이 확인된 뒤에 설정할 수 있습니다.');
    return fail(409, 'stale', '다른 화면에서 설정이 바뀌었습니다. 새로 불러온 뒤 다시 저장하십시오.');
  }
  nudge(id);
  return { ok: true, row: r.rows[0] };
}

function passcodeProblem(passcode) {
  if (passcode === null || passcode === undefined) return null;
  if (String(passcode).trim().length > PASSCODE_MAX) return fail(400, 'bad_passcode', TEXT.bad_passcode);
  return null;
}

// 다시 시도(3.4.3). opts = {memberId?, admin?, passcode?, req?}
async function retry(installId, opts) {
  const o = opts || {};
  const id = toId(installId);
  if (!id) return fail(404, 'not_found', TEXT.no_room);
  const pp = passcodeProblem(o.passcode);
  if (pp) return pp;
  const pc = o.passcode === null || o.passcode === undefined ? '' : String(o.passcode).trim();
  const sealed = pc ? secretbox.seal(pc) : null;
  const mid = o.memberId === null || o.memberId === undefined ? null : toId(o.memberId);
  if (!o.admin && !mid) return fail(404, 'not_found', TEXT.no_room);

  let out;
  try {
    out = await db.tx(async (client) => {
      const row = await db.one('SELECT * FROM room_installs WHERE id=$1 FOR UPDATE', [id], client);
      if (!row || (mid && toId(row.member_id) !== mid)) return fail(404, 'not_found', TEXT.no_room);
      if (row.phase !== 'installed') {
        if (!o.admin && row.phase === 'pending_payment') return fail(409, 'not_retryable', '지금은 다시 시도할 수 없습니다.');
        if (!o.admin) return fail(404, 'not_found', TEXT.no_room);
        return fail(409, 'not_installed', '설치된 방이 아닙니다.');
      }
      const now = Date.now();
      let nextN = 0;
      if (!o.admin) {
        const d = displayOf(row, now);
        if (d.retry_admin_only) return fail(403, 'admin_only', '다시 시도 횟수를 넘었습니다. 문의하십시오.');
        if (!d.can_retry) return fail(409, 'not_retryable', '지금은 다시 시도할 수 없습니다.');
        if (d.retry_after > now) {
          return fail(429, 'too_soon', hhmm(d.retry_after) + ' 이후에 다시 시도하십시오.', { retry_after: d.retry_after });
        }
        nextN = retryInfo(row, now).n + 1;
      }
      // 내보내진 동안 다른 회원이 그 방을 설치했으면 되살리지 않는다(UNIQUE 위반 전에 확인)
      if (row.error_code === 'kicked') {
        const c = await conflictFor(client, { selfId: id, linkId: row.link_id, linkUrl: row.link_url });
        if (c.taken) return fail(409, 'room_taken', ERRORS.room_taken.long);
      }
      const upd = await db.q(
        `UPDATE room_installs SET retry_n=$2, retry_at=CASE WHEN $5::boolean THEN retry_at ELSE $3::bigint END,
                passcode_ct=COALESCE($4, passcode_ct), ` + REENTER_SQL + `, state_at=$3::bigint
          WHERE id=$1 RETURNING *`,
        [id, nextN, now, sealed, !!o.admin], client);
      let updated = upd.rows[0];
      if (!updated.bot_device_id && !updated.hold_reason) {
        await assignBotTx(client, id);
        updated = await db.one('SELECT * FROM room_installs WHERE id=$1', [id], client);
      }
      const info = { member_id: toId(row.member_id),
        detail: 'retry 설치 #' + id + (o.admin ? ' (관리자)' : ' (고객 ' + nextN + '회)') +
                ' / 이전 ' + (row.state || '') + (row.error_code ? ':' + row.error_code : '') + (sealed ? ' / 참여코드 변경' : '') };
      if (o.req) await audit.record(o.req, 'install', info, client);
      else await audit.log('install', info, client);
      return { ok: true, row: updated };
    });
  } catch (e) {
    if (e && e.code === '23505') return fail(409, 'room_taken', ERRORS.room_taken.long);
    throw e;
  }
  if (out && out.ok) nudge(id);
  return out;
}

// ── 관리자 경로(3.5) ───────────────────────────────────────────────────────
function auditInstall(client, opts, info) {
  const o = opts || {};
  if (o.req) return audit.record(o.req, 'install', info, client);
  return audit.log('install', Object.assign({ ip: o.ip || null }, info), client);
}

function gamesDefaults() {
  // room-config.js(작업 1)의 7.1 기본값. 늦게 읽어 모듈 순환·적재 순서에 묶이지 않게 한다.
  try {
    const rc = require('./room-config');
    if (rc && rc.DEFAULTS && rc.DEFAULTS.games) return JSON.parse(JSON.stringify(rc.DEFAULTS.games));
  } catch (e) { /* 아래 기본값 */ }
  return { enabled: true, word: true, baseball: true, dice: true, rps: true, quiz: true, cooldownSec: 3, dailyLimit: 0 };
}

// 처음으로 minigame 이 켜지는 설치는 config.games 를 7.1 기본값(켜짐)으로 채운다(4.2).
// → {config, changed}
function withGamesDefault(row, minigameOn) {
  const cfg = jsonObj(row && row.config);
  if (!minigameOn || (row && row.minigame) || (cfg.games && typeof cfg.games === 'object')) {
    return { config: cfg, changed: false };
  }
  return { config: Object.assign({}, cfg, { games: gamesDefaults() }), changed: true };
}

// 결제 없이 설치(order_id NULL). preview 검사·충돌 SQL·금지 목록은 주문과 같다.
// opts = {req?, ip?}
async function grantRoom(memberId, text, passcode, products, opts) {
  const mid = toId(memberId);
  if (!mid) return fail(404, 'no_member', '회원이 없습니다.');
  const prods = pricing.roomProducts(products);
  if (!prods.length) return fail(400, 'no_products', '설치할 상품을 1개 이상 선택하십시오.');
  const pp = passcodeProblem(passcode);
  if (pp) return pp;
  const m = await db.one('SELECT id FROM members WHERE id=$1', [mid]);
  if (!m) return fail(404, 'no_member', '회원이 없습니다.');
  const pv = await preview(mid, text);
  if (!pv.ok) return pv;
  const want = productsOf(prods);
  const pc = passcode === null || passcode === undefined ? '' : String(passcode).trim();
  const sealed = pc ? secretbox.seal(pc) : null;
  const url = pv.room.link_url;
  const linkId = pv.room.link_id || null;

  let out;
  try {
    out = await db.tx(async (client) => {
      const now = Date.now();
      // 이 회원의 같은 방 설치가 이미 있으면 상품만 켠다
      const own = await db.one(
        `SELECT * FROM room_installs WHERE member_id=$1 AND phase IN ('installed','pending_payment')
           AND (link_url=$2 OR ($3::text IS NOT NULL AND link_id=$3))
         ORDER BY (phase='installed') DESC, id DESC LIMIT 1 FOR UPDATE`, [mid, url, linkId], client);
      if (own && own.phase === 'pending_payment') return fail(409, 'pending_exists', TEXT.pending_exists);
      if (own) {
        const g = withGamesDefault(own, want.minigame);
        const r = await db.q(
          `UPDATE room_installs SET roombot=roombot OR $2, minigame=minigame OR $3, config=$4::jsonb,
                  config_rev=config_rev + $5::int, config_at=CASE WHEN $5::int > 0 THEN $6::bigint ELSE config_at END,
                  passcode_ct=COALESCE($7, passcode_ct)
            WHERE id=$1 RETURNING *`,
          [own.id, want.roombot, want.minigame, JSON.stringify(g.config), g.changed ? 1 : 0, now, sealed], client);
        await auditInstall(client, opts, { member_id: mid,
          detail: 'grant 설치 #' + own.id + ' 상품 추가 ' + prods.join(',') + ' / ' + url });
        return { ok: true, install_id: Number(own.id), row: r.rows[0], added: false };
      }
      const c = await conflictFor(client, { memberId: mid, linkId: linkId, linkUrl: url });
      if (c.taken) return fail(409, 'room_taken', TEXT.taken);
      if (await isBlocked(client, { linkId: linkId, linkUrl: url })) return fail(403, 'blocked_room', TEXT.blocked_room);
      const g = withGamesDefault({ config: {}, minigame: false }, want.minigame);
      const ins = await db.q(
        `INSERT INTO room_installs (member_id, link_url, link_id, link_name, passcode_ct, roombot, minigame, phase,
                                    order_id, state, config, config_rev, config_at, created_at, installed_at, state_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'installed',NULL,'queued',$8::jsonb,$9,$10,$10,$10,$10) RETURNING id`,
        [mid, url, linkId, pv.room.name || null, sealed, want.roombot, want.minigame, JSON.stringify(g.config),
         g.changed ? 1 : 0, now], client);
      const id = Number(ins.rows[0].id);
      await assignBotTx(client, id);
      const row = await db.one('SELECT * FROM room_installs WHERE id=$1', [id], client);
      await auditInstall(client, opts, { member_id: mid,
        detail: 'grant 설치 #' + id + ' ' + prods.join(',') + ' / ' + url + (pv.verified ? '' : ' (미확인)') });
      return { ok: true, install_id: id, row: row, added: true, verified: pv.verified };
    });
  } catch (e) {
    if (e && e.code === '23505') return fail(409, 'room_taken', TEXT.taken);
    throw e;
  }
  if (out && out.ok) nudge(out.install_id);
  return out;
}

async function lockInstalled(client, id) {
  const row = await db.one('SELECT * FROM room_installs WHERE id=$1 FOR UPDATE', [id], client);
  if (!row) return { err: fail(404, 'not_found', TEXT.no_room) };
  if (row.phase !== 'installed') return { err: fail(409, 'not_installed', '설치된 방이 아닙니다.') };
  return { row: row };
}

async function queueLeave(client, row, why) {
  if (!row.bot_device_id) return null;
  const r = await db.q(
    `INSERT INTO room_leaves (install_id, bot_device_id, chat_id, link_id, why, created_at)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
    [row.id, row.bot_device_id, row.chat_id || null, row.link_id || null, why, Date.now()], client);
  return Number(r.rows[0].id);
}

// 다른 봇으로 옮기기. botId=null 이면 자동 배정이되 지금 봇은 후보에서 뺀다.
async function move(installId, botId, opts) {
  const id = toId(installId);
  if (!id) return fail(404, 'not_found', TEXT.no_room);
  const out = await db.tx(async (client) => {
    const l = await lockInstalled(client, id);
    if (l.err) return l.err;
    const row = l.row;
    const cur = row.bot_device_id || null;
    let target = null;
    if (botId) {
      target = String(botId);
      if (target === cur) return fail(400, 'same_bot', '지금 맡은 K bot 계정과 같습니다.');
      const b = await db.one('SELECT device_id FROM bot_accounts WHERE device_id=$1 AND removed_at IS NULL', [target], client);
      if (!b) return fail(404, 'no_bot', 'K bot 계정을 찾을 수 없습니다.');
    } else {
      target = await pickBot(client, cur ? [cur] : []);
      if (!target) return fail(409, 'no_bot', '옮길 K bot 계정이 없습니다');
    }
    const leaveId = await queueLeave(client, row, 'move');
    const now = Date.now();
    await db.q('UPDATE room_installs SET bot_device_id=$2, ' + REENTER_SQL + ', state_at=$3 WHERE id=$1', [id, target, now], client);
    await auditInstall(client, opts, { member_id: toId(row.member_id),
      detail: 'move 설치 #' + id + ' ' + (cur || '없음') + ' → ' + target });
    return { ok: true, from: cur, to: target, leave_id: leaveId };
  });
  if (out && out.ok) nudge(id);
  return out;
}

async function removeTx(client, id, why, opts) {
  const row = await db.one('SELECT * FROM room_installs WHERE id=$1 FOR UPDATE', [id], client);
  if (!row) return fail(404, 'not_found', TEXT.no_room);
  if (row.phase === 'removed') return fail(409, 'already_removed', '이미 해제된 설치입니다.');
  if (row.phase === 'canceled') return fail(409, 'not_installed', '취소된 설치입니다.');
  const leaveId = await queueLeave(client, row, why);
  await db.q(
    "UPDATE room_installs SET phase='removed', removed_at=$2, bot_device_id=NULL WHERE id=$1",
    [id, Date.now()], client);
  await auditInstall(client, opts, { member_id: toId(row.member_id),
    detail: why + ' 설치 #' + id + ' 해제 / ' + row.link_url + (row.bot_device_id ? ' / 나갈 봇 ' + row.bot_device_id : '') });
  return { ok: true, leave_id: leaveId, row: row };
}

// 설치 해제(관리자). 봇은 방에서 나간다(room_leaves).
async function remove(installId, opts) {
  const id = toId(installId);
  if (!id) return fail(404, 'not_found', TEXT.no_room);
  const out = await db.tx((client) => removeTx(client, id, 'remove', opts));
  if (out && out.ok) nudge(id);
  return out;
}

// 링크 바꾸기(관리자). 새 링크 preview → 충돌 → 옛 방 나가기 + 새 링크로 다시 입장.
async function rebind(installId, text, opts) {
  const id = toId(installId);
  if (!id) return fail(404, 'not_found', TEXT.no_room);
  const url = openchat.normLink(text);
  if (!url) return fail(400, 'bad_link', TEXT.bad_link);
  const res = await resolveLink(url);
  if (!res.ok && res.error === 'not_found') return fail(404, 'not_found', TEXT.not_found);
  if (!res.ok && res.error === 'not_group') return fail(422, 'not_group', TEXT.not_group);
  const linkId = res.ok ? res.link_id : null;
  const name = res.ok ? res.name : null;
  let out;
  try {
    out = await db.tx(async (client) => {
      const l = await lockInstalled(client, id);
      if (l.err) return l.err;
      const row = l.row;
      if (await isBlocked(client, { linkId: linkId, linkUrl: url })) return fail(403, 'blocked_room', TEXT.blocked_room);
      const c = await conflictFor(client, { selfId: id, memberId: row.member_id, linkId: linkId, linkUrl: url });
      if (c.taken) return fail(409, 'room_taken', '같은 방에 다른 설치가 있습니다: 설치 #' + c.taken.id);
      if (c.mine) return fail(409, 'pending_exists', '이 회원의 입금 대기 예약이 같은 방에 있습니다: 설치 #' + c.mine.id);
      const leaveId = await queueLeave(client, row, 'rebind');
      const now = Date.now();
      await db.q(
        `UPDATE room_installs SET link_url=$2, link_id=$3, link_name=$4, chat_id=NULL, ` + REENTER_SQL + `, state_at=$5
          WHERE id=$1`, [id, url, linkId, name, now], client);
      if (!row.bot_device_id && !row.hold_reason) await assignBotTx(client, id);
      await auditInstall(client, opts, { member_id: toId(row.member_id),
        detail: 'rebind 설치 #' + id + ' ' + row.link_url + ' → ' + url + (res.ok ? '' : ' (미확인)') });
      return { ok: true, leave_id: leaveId, verified: !!res.ok, link_url: url, link_id: linkId, link_name: name };
    });
  } catch (e) {
    if (e && e.code === '23505') return fail(409, 'room_taken', '같은 방에 다른 설치가 있습니다.');
    throw e;
  }
  if (out && out.ok) nudge(id);
  return out;
}

// 상품 켜고 끄기(관리자 지급·회수). products = {roombot, minigame} 또는 배열.
async function setProducts(installId, products, opts) {
  const id = toId(installId);
  if (!id) return fail(404, 'not_found', TEXT.no_room);
  const want = productsOf(Array.isArray(products) ? pricing.roomProducts(products) : products);
  if (!want.roombot && !want.minigame) {
    return fail(400, 'no_products', '상품을 1개 이상 선택하십시오. 모두 빼려면 설치를 해제하십시오.');
  }
  const out = await db.tx(async (client) => {
    const l = await lockInstalled(client, id);
    if (l.err) return l.err;
    const row = l.row;
    const g = withGamesDefault(row, want.minigame);
    const r = await db.q(
      `UPDATE room_installs SET roombot=$2, minigame=$3, config=$4::jsonb, config_rev=config_rev + $5::int,
              config_at=CASE WHEN $5::int > 0 THEN $6::bigint ELSE config_at END
        WHERE id=$1 RETURNING *`,
      [id, want.roombot, want.minigame, JSON.stringify(g.config), g.changed ? 1 : 0, Date.now()], client);
    await auditInstall(client, opts, { member_id: toId(row.member_id),
      detail: 'products 설치 #' + id + ' roombot ' + !!row.roombot + '→' + want.roombot +
              ' / minigame ' + !!row.minigame + '→' + want.minigame });
    return { ok: true, row: r.rows[0] };
  });
  if (out && out.ok) nudge(id);
  return out;
}

// 다른 회원에게 넘기기(D18). 상품·설정·봇은 그대로, member_id 만 바꾼다.
async function transfer(installId, memberId, opts) {
  const id = toId(installId);
  const to = toId(memberId);
  if (!id) return fail(404, 'not_found', TEXT.no_room);
  if (!to) return fail(404, 'no_member', '회원이 없습니다.');
  const out = await db.tx(async (client) => {
    const l = await lockInstalled(client, id);
    if (l.err) return l.err;
    const row = l.row;
    const from = toId(row.member_id);
    if (from === to) return fail(400, 'same_member', '지금 설치한 회원과 같습니다.');
    const m = await db.one('SELECT id FROM members WHERE id=$1', [to], client);
    if (!m) return fail(404, 'no_member', '회원이 없습니다.');
    const c = await conflictFor(client, { selfId: id, memberId: to, linkId: row.link_id, linkUrl: row.link_url });
    if (c.mine) return fail(409, 'pending_exists', '받는 회원에게 같은 방 예약이 있습니다: 설치 #' + c.mine.id);
    await db.q('UPDATE room_installs SET member_id=$2 WHERE id=$1', [id, to], client);
    await auditInstall(client, opts, { member_id: to, detail: 'transfer 설치 #' + id + ' 회원 ' + from + ' → ' + to });
    return { ok: true, from: from, to: to };
  });
  if (out && out.ok) nudge(id);
  return out;
}

// 설치 금지 방(D28). {installId?, link?, reason}. installId 가 오면 그 설치를 해제(why:'block')한다.
async function block(args, opts) {
  const a = args || {};
  const reason = a.reason === null || a.reason === undefined ? '' : String(a.reason).trim();
  if (!reason || reason.length > 200) return fail(400, 'bad_reason', '금지 사유를 1~200자로 입력하십시오.');
  const id = toId(a.installId);
  let url = null;
  let linkId = null;
  if (id) {
    const row = await db.one('SELECT link_url, link_id FROM room_installs WHERE id=$1', [id]);
    if (!row) return fail(404, 'not_found', TEXT.no_room);
    url = row.link_url;
    linkId = row.link_id || null;
  } else {
    url = openchat.normLink(a.link);
    if (!url) return fail(400, 'bad_link', TEXT.bad_link);
    const res = await resolveLink(url);        // 확인되면 link_id 도 막는다(실패해도 주소로 막는다)
    if (res.ok) linkId = res.link_id;
  }
  const out = await db.tx(async (client) => {
    const now = Date.now();
    await db.q(
      `INSERT INTO room_blocklist (link_id, link_url, reason, created_at) VALUES ($1,$2,$3,$4)
       ON CONFLICT DO NOTHING`, [linkId, url, reason, now], client);
    // 두 부분 UNIQUE 중 하나만 겹쳐 행이 안 들어간 경우에도 주소·link_id 가 모두 막히게 한다
    if (url && !(await db.one('SELECT id FROM room_blocklist WHERE link_url=$1', [url], client))) {
      await db.q('INSERT INTO room_blocklist (link_id, link_url, reason, created_at) VALUES (NULL,$1,$2,$3) ON CONFLICT DO NOTHING',
        [url, reason, now], client);
    }
    if (linkId && !(await db.one('SELECT id FROM room_blocklist WHERE link_id=$1', [linkId], client))) {
      await db.q('INSERT INTO room_blocklist (link_id, link_url, reason, created_at) VALUES ($1,NULL,$2,$3) ON CONFLICT DO NOTHING',
        [linkId, reason, now], client);
    }
    const blk = await db.one(
      `SELECT id FROM room_blocklist WHERE link_url=$1 OR ($2::text IS NOT NULL AND link_id=$2) ORDER BY id LIMIT 1`,
      [url, linkId], client);
    let removed = null;
    if (id) {
      const rr = await removeTx(client, id, 'block', opts);
      if (!rr.ok && rr.reason !== 'already_removed' && rr.reason !== 'not_installed') return rr;
      removed = rr.ok ? id : null;
    }
    await auditInstall(client, opts, { detail: 'block ' + url + (linkId ? ' (li ' + linkId + ')' : '') + ' / 사유 ' + reason +
      (removed ? ' / 설치 #' + removed + ' 해제' : '') });
    return { ok: true, block_id: blk ? Number(blk.id) : null, link_url: url, link_id: linkId, removed: removed };
  });
  if (out && out.ok && out.removed) nudge(out.removed);
  return out;
}

async function unblock(blockId, opts) {
  const id = toId(blockId);
  if (!id) return fail(404, 'not_found', '금지 목록에 없는 항목입니다.');
  return db.tx(async (client) => {
    const r = await db.q('DELETE FROM room_blocklist WHERE id=$1 RETURNING link_url, link_id', [id], client);
    if (!r.rowCount) return fail(404, 'not_found', '금지 목록에 없는 항목입니다.');
    await auditInstall(client, opts, { detail: 'unblock ' + (r.rows[0].link_url || '') + (r.rows[0].link_id ? ' (li ' + r.rows[0].link_id + ')' : '') });
    return { ok: true };
  });
}

// 확인 대기(hold_reason) 풀기 → 봇 배정 → 입장(D28)
async function release(installId, opts) {
  const id = toId(installId);
  if (!id) return fail(404, 'not_found', TEXT.no_room);
  const out = await db.tx(async (client) => {
    const l = await lockInstalled(client, id);
    if (l.err) return l.err;
    const row = l.row;
    if (!row.hold_reason) return fail(409, 'not_held', '확인 대기 중인 방이 아닙니다.');
    await db.q('UPDATE room_installs SET hold_reason=NULL WHERE id=$1', [id], client);
    const bot = row.bot_device_id || await assignBotTx(client, id);
    if (row.bot_device_id) {
      await db.q('UPDATE room_installs SET ' + REENTER_SQL + ', state_at=$2 WHERE id=$1', [id, Date.now()], client);
    }
    await auditInstall(client, opts, { member_id: toId(row.member_id),
      detail: 'release 설치 #' + id + ' (' + row.hold_reason + ')' + (bot ? ' → ' + bot : ' / 배정할 봇 없음') });
    return { ok: true, bot: bot || null };
  });
  if (out && out.ok) nudge(id);
  return out;
}

// ── sender 알림 ────────────────────────────────────────────────────────────
// sender /v1/bot/sync. 실패는 삼키고 로그만 남긴다(다음 재조정 때 sender 가 스스로 읽는다).
async function nudge(installId) {
  if (!senderChild.up()) return;
  const id = installId === null || installId === undefined ? null : toId(installId);
  try {
    const r = await senderChild.call('POST', '/v1/bot/sync', id ? { install_id: id } : {}, 15000);
    if (!r || r.status !== 200) console.error('[installs] /v1/bot/sync 응답 ' + (r ? r.status : '-') + ' install=' + (id || '전체'));
  } catch (e) {
    console.error('[installs] /v1/bot/sync 실패 install=' + (id || '전체') + ' → ' + (e && e.message ? e.message : e));
  }
}

async function nudgeMember(memberId) {
  const mid = toId(memberId);
  if (!mid || !senderChild.up()) return;
  try {
    const r = await db.q("SELECT id FROM room_installs WHERE member_id=$1 AND phase='installed' ORDER BY id", [mid]);
    if (r.rows.length > 20) return nudge(null);
    for (const row of r.rows) await nudge(row.id);
  } catch (e) {
    console.error('[installs] nudgeMember 실패 member=' + mid + ' → ' + (e && e.message ? e.message : e));
  }
}

// ── 1분 주기(4.4) ──────────────────────────────────────────────────────────
let loopTimer = null;
let looping = false;

async function loopOnce(nowArg) {
  if (looping) return { skipped: true };
  looping = true;
  const out = { assigned: [], requeued: [] };
  try {
    const now = nowArg == null ? Date.now() : Number(nowArg);
    // 1. 봇 없는 설치를 다시 배정
    const r = await db.q(
      `SELECT id FROM room_installs
        WHERE phase='installed' AND bot_device_id IS NULL AND hold_reason IS NULL
        ORDER BY id LIMIT 200`);
    for (const row of r.rows) {
      const bot = await db.tx(async (client) => {
        const cur = await db.one(
          `SELECT id FROM room_installs WHERE id=$1 AND phase='installed' AND bot_device_id IS NULL AND hold_reason IS NULL
             FOR UPDATE`, [row.id], client);
        if (!cur) return null;
        const b = await pickBot(client, []);
        if (!b) return null;
        await db.q('UPDATE room_installs SET bot_device_id=$2, ' + REENTER_SQL + ', state_at=$3 WHERE id=$1',
          [row.id, b, now], client);
        return b;
      });
      if (!bot) break;                 // 배정할 봇이 없으면 나머지도 없다
      out.assigned.push(Number(row.id));
      nudge(row.id);
    }
    // 2. 멈춘 입장 되돌리기(sender 가 입장 중에 죽은 경우의 보조 장치)
    const s = await db.q(
      `UPDATE room_installs SET ` + REENTER_SQL + `, state_at=$1
        WHERE phase='installed' AND state='joining' AND state_at < $2
          AND (next_try_at IS NULL OR next_try_at < $1)
        RETURNING id`, [now, now - STALE_JOIN_MS]);
    for (const row of s.rows) {
      out.requeued.push(Number(row.id));
      nudge(row.id);
    }
  } catch (e) {
    console.error('[installs] 1분 주기 실패 → ' + (e && e.message ? e.message : e));
    out.error = e && e.message ? e.message : String(e);
  } finally {
    looping = false;
  }
  return out;
}

function startLoop() {
  if (loopTimer) return;
  loopTimer = setInterval(() => { loopOnce(); }, MINUTE);
  if (loopTimer.unref) loopTimer.unref();
}

module.exports = {
  ERRORS, LABELS, TEXT,
  displayOf, publicView,
  preview, reserveForOrder, cancelForOrder, cancelMemberOrder,
  conflictFor, assignBot, isBlocked,
  listForMember, getForMember, viewsByIds,
  saveConfig, retry,
  grantRoom, move, remove, rebind, setProducts, transfer, block, unblock, release,
  nudge, nudgeMember, startLoop,
  // 내부 도구(같은 패키지의 entitle·purchase 와 시험이 쓴다)
  loopOnce, resolveLink, clearPreviewCache, pendingProducts, pendingHas, holdWordFor,
  withGamesDefault, hhmm, retryInfo, retryGapMs, onCountOf, linkShort,
};
