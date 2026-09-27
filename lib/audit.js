// 감사 로그 — 누가 무슨 짓을 했는지 남긴다. 관리자앱 [기록] 탭이 이걸 본다.
'use strict';

const db = require('./db');
const rl = require('./ratelimit');

// activate|mismatch|takeover|bad_sig|expired|revoked|reset|order|tamper
// (+ 입금 웹훅 인증 실패: bad_deposit_token / 관리자 비밀번호 실패: bad_admin_pw)
const KINDS = ['activate', 'mismatch', 'takeover', 'bad_sig', 'expired', 'revoked', 'reset', 'order', 'tamper',
               'bad_deposit_token', 'bad_admin_pw'];

// 눈에 띄게 표시해야 하는 종류 (관리자앱에서 붉게)
const ALERT_KINDS = ['mismatch', 'takeover', 'bad_sig', 'tamper', 'bad_deposit_token', 'bad_admin_pw'];

function isKind(k) { return KINDS.indexOf(k) >= 0; }

function cut(s, n) {
  if (s === null || s === undefined) return null;
  const v = String(s);
  return v.length > n ? v.slice(0, n) : v;
}

// IP 판정은 레이트리밋과 **같은 함수**를 쓴다 (lib/ratelimit.js).
// XFF 맨 앞은 클라이언트가 위조할 수 있어서 맨 뒤(rightmost)를 쓴다 → 차단 기록과
// 감사 기록의 ip 가 항상 같은 값이 되어 서로 이어진다.
function ipOf(req) {
  if (!req) return null;
  const ip = rl.ipOf(req);
  if (!ip || ip === 'unknown') return null;
  return cut(ip, 64);
}

// 기록. 로그 쓰기가 실패해도 요청 자체를 죽이진 않지만, 절대 조용히 묻지 않는다.
async function log(kind, info) {
  const d = info || {};
  try {
    await db.q(
      'INSERT INTO audit_log (at, key, kind, device_id, device_name, detail, ip) VALUES ($1,$2,$3,$4,$5,$6,$7)',
      [Date.now(), cut(d.key, 64), cut(kind, 32), cut(d.device_id, 128), cut(d.device_name, 120),
       cut(d.detail, 2000), cut(d.ip, 64)]);
  } catch (e) {
    console.error('[audit] 기록 실패 kind=' + kind + ' key=' + (d.key || '-') + ' → ' + e.message);
  }
}

// 요청 객체에서 IP 뽑아서 기록하는 단축형. await 해도 되고 안 해도 된다.
function record(req, kind, info) {
  const d = Object.assign({}, info || {});
  d.ip = ipOf(req);
  return log(kind, d);
}

// 같은 사유가 계속 쌓여서 기록 탭의 위험 신호를 덮는 걸 막는 단축형.
// (만료된 키가 하트비트마다 expired 를 밀어넣으면 mismatch/takeover 가 LIMIT 밖으로 밀려난다)
// 스로틀 상태는 프로세스 메모리라 재시작하면 초기화된다 → 재시작 직후 같은 사유가 한 번 더
// 들어오는 건 정상이다. 전건이 필요하면 EXPIRED_AUDIT_MS=0 으로 스로틀을 꺼라.
const recent = new Map();   // "kind|key|device" → 마지막 기록 시각

const DEFAULT_THROTTLE_MS = 6 * 3600 * 1000;   // 기본 6시간
const RECENT_MAX = 5000;                       // 이 이상은 오래된 것부터 버린다
const SWEEP_EVERY_MS = 60 * 1000;              // 시간 기준 정리 주기

// EXPIRED_AUDIT_MS — expired 기록 스로틀 창(ms). 기본 6시간, 0 이면 스로틀을 끄고 전건 기록.
// (routes/license.js 가 넘겨주는 값보다 이 환경변수를 우선한다. 거기선 0 을 그대로 못 넘기니까)
function expiredThrottleMs() {
  const raw = process.env.EXPIRED_AUDIT_MS;
  if (raw === null || raw === undefined || String(raw).trim() === '') return DEFAULT_THROTTLE_MS;
  const n = Number(raw);
  if (!isFinite(n) || n < 0) return DEFAULT_THROTTLE_MS;
  return n;   // 0 = 스로틀 끔
}

// 종류별 스로틀 창 결정. expired 는 환경변수가 최종 결정권을 갖는다.
function throttleWindowMs(kind, windowMs) {
  if (kind === 'expired') return expiredThrottleMs();
  const n = Number(windowMs);
  if (windowMs !== null && windowMs !== undefined && isFinite(n) && n >= 0) return n;
  return DEFAULT_THROTTLE_MS;
}

// 메모리가 무한정 늘지 않게 정리한다. size 가 커질 때만 돌면 항목이 5000개에 못 미치는
// 동안은 영원히 안 돌아서 죽은 항목이 계속 남는다 → 시간 기준으로도 같이 돈다.
let lastSweepAt = 0;
function sweepRecent(now, windowMs) {
  const win = Number(windowMs) > 0 ? Number(windowMs) : DEFAULT_THROTTLE_MS;
  const tooMany = recent.size > RECENT_MAX;
  if (!tooMany && now - lastSweepAt < SWEEP_EVERY_MS) return;
  lastSweepAt = now;
  for (const [k, at] of recent) if (now - at > win) recent.delete(k);
  // 그래도 넘치면(창이 아주 긴 경우) 오래된 것부터 잘라낸다
  if (recent.size > RECENT_MAX) {
    const olds = Array.from(recent.entries()).sort((a, b) => a[1] - b[1]);
    for (let i = 0; i < olds.length - RECENT_MAX; i++) recent.delete(olds[i][0]);
  }
}

function recordThrottled(req, kind, info, windowMs) {
  const d = info || {};
  const w = throttleWindowMs(kind, windowMs);
  const now = Date.now();

  if (w <= 0) {              // 스로틀 끔 → 전건 기록
    sweepRecent(now, DEFAULT_THROTTLE_MS);
    return record(req, kind, d);
  }

  const id = kind + '|' + (d.key || '-') + '|' + (d.device_id || '-');
  const last = recent.get(id) || 0;
  sweepRecent(now, w);
  if (last && now - last < w) return Promise.resolve();   // 창 안이면 조용히 넘긴다
  recent.set(id, now);
  return record(req, kind, d);
}

module.exports = { KINDS, ALERT_KINDS, isKind, ipOf, log, record, recordThrottled,
                   expiredThrottleMs, throttleWindowMs, DEFAULT_THROTTLE_MS };
