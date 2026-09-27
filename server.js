// 카톡 매크로/봇 — 라이선스 서버 + 구매 웹사이트 (Neon Postgres)
// 이 파일은 부트스트랩만 한다. 실제 로직은 lib/ 와 routes/ 에 있다.
//   routes/license.js  : 사용자앱 API (/verify /heartbeat /entitlements /config /pubkey)
//   routes/admin.js    : 관리자 API (/admin/*)
//   routes/purchase.js : 구매 웹 API (/api/*)
'use strict';

const express = require('express');
const fs = require('fs');
const path = require('path');

const db = require('./lib/db');
const licenseRoutes = require('./routes/license');
const adminRoutes = require('./routes/admin');
const purchaseRoutes = require('./routes/purchase');

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');

const app = express();

// Render는 프록시 뒤에 있다 → req.ip / req.protocol 이 실제 값이 되게
app.set('trust proxy', true);
app.disable('x-powered-by');

// 본문 크기 제한 (설정 백업 blob 256KB + 여유)
app.use(express.json({ limit: '512kb' }));

// ── 아주 단순한 IP 기반 레이트리밋 (메모리). 분당 30회 초과 시 429.
// 무료 플랜이라 Redis 같은 건 안 쓴다. 인스턴스가 하나니까 메모리로 충분하다.
const RL_WINDOW = 60 * 1000;
const RL_MAX = Number(process.env.RATE_LIMIT_PER_MIN) || 30;
const rlBuckets = new Map();

function limitedPath(req) {
  const p = req.path;
  if (req.method === 'POST' && (p === '/verify' || p === '/api/order' || p === '/api/lookup')) return true;
  if (req.method === 'GET' && p.indexOf('/api/order/') === 0) return true;
  return false;
}

app.use((req, res, next) => {
  if (!limitedPath(req)) return next();
  const now = Date.now();
  const ip = String(req.ip || (req.socket && req.socket.remoteAddress) || 'unknown');
  let b = rlBuckets.get(ip);
  if (!b || now - b.at >= RL_WINDOW) { b = { at: now, n: 0 }; rlBuckets.set(ip, b); }
  b.n++;
  if (b.n > RL_MAX) {
    res.set('Retry-After', String(Math.ceil((b.at + RL_WINDOW - now) / 1000)));
    console.log('[rate] 과다요청 차단 ' + ip + ' ' + req.method + ' ' + req.path);
    return res.status(429).json({ ok: false, reason: 'rate_limited', error: '요청이 너무 많아. 잠깐 뒤에 다시 해줘' });
  }
  next();
});

// 오래된 버킷 정리 (5분마다)
setInterval(() => {
  const now = Date.now();
  for (const [ip, b] of rlBuckets) if (now - b.at > RL_WINDOW * 5) rlBuckets.delete(ip);
}, 5 * 60 * 1000).unref();

// ── 정적 파일 (구매 웹사이트). index 는 아래에서 직접 다룬다.
app.use(express.static(PUBLIC_DIR, { index: false, extensions: ['html'], maxAge: '1h' }));

function page(name) {
  return (req, res, next) => {
    const f = path.join(PUBLIC_DIR, name);
    if (!fs.existsSync(f)) return next();
    res.sendFile(f);
  };
}

// 구매 웹 페이지 라우팅 (SPEC 5장)
app.get('/buy', page('buy.html'));
app.get('/my', page('my.html'));
app.get('/order/:id', page('order.html'));

// ── API 라우터
app.use(licenseRoutes);
app.use(adminRoutes);
app.use(purchaseRoutes);

// 루트: 브라우저면 랜딩 페이지, 그 외(앱/curl 연결확인)는 기존 JSON 그대로
app.get('/', (req, res) => {
  const wantsHtml = String(req.headers.accept || '').indexOf('text/html') >= 0;
  const idx = path.join(PUBLIC_DIR, 'index.html');
  if (wantsHtml && fs.existsSync(idx)) return res.sendFile(idx);
  res.json({ ok: true, service: 'kakao-license', time: Date.now() });
});

// 셀프핑용. DB를 안 건드려서 Neon 사용량이 0이다.
app.get('/health', (req, res) => res.type('text').send('ok'));

app.use((req, res) => res.status(404).json({ ok: false, error: 'not_found', path: req.path }));

// 마지막 안전망 — 여기까지 온 에러도 삼키지 않고 로그를 남긴다
app.use((err, req, res, next) => {
  console.error('[unhandled ' + req.method + ' ' + req.originalUrl + '] ' + (err && err.stack ? err.stack : err));
  if (res.headersSent) return;
  if (err && (err.type === 'entity.too.large' || err.status === 413)) {
    return res.status(413).json({ ok: false, error: '본문이 너무 커' });
  }
  if (err && err.type === 'entity.parse.failed') {
    return res.status(400).json({ ok: false, error: 'JSON 이 깨졌어' });
  }
  res.status(500).json({ ok: false, error: 'server_error' });
});

// ── 셀프핑: Render 무료는 15분 동안 외부 요청이 없으면 잠듦 → 10분마다 자기 공개 주소를 호출해서 막음
// Render가 RENDER_EXTERNAL_URL을 자동으로 넣어줌 (로컬에선 SELF_URL로 테스트)
function startSelfPing() {
  const base = process.env.RENDER_EXTERNAL_URL || process.env.SELF_URL;
  if (!base) return console.log('셀프핑 꺼짐 (RENDER_EXTERNAL_URL 없음)');
  const every = Number(process.env.PING_INTERVAL_MS) || 10 * 60 * 1000;
  let fails = 0;
  const ping = async () => {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 30000);
      const r = await fetch(base.replace(/\/$/, '') + '/health', { signal: ctrl.signal });
      clearTimeout(t);
      if (!r.ok) throw new Error('HTTP ' + r.status);
      if (fails) console.log('셀프핑 복구됨');
      fails = 0;
    } catch (e) {
      fails++;
      console.log('셀프핑 실패 (' + fails + '회):', e.message);
    }
    // 간격을 ±10% 흔들어서 매번 똑같지 않게 (10분이면 9~11분 → 15분 절대 안 넘김)
    setTimeout(ping, Math.round(every * (0.9 + Math.random() * 0.2)));
  };
  setTimeout(ping, 60000);
  console.log('셀프핑 켜짐 → ' + base + '/health, 약 ' + Math.round(every / 60000) + '분마다');
}

// 예상 못 한 에러로 프로세스가 조용히 죽는 걸 막는다
process.on('unhandledRejection', (e) => console.error('[unhandledRejection]', e && e.stack ? e.stack : e));
process.on('uncaughtException', (e) => console.error('[uncaughtException]', e && e.stack ? e.stack : e));

function warnEnv() {
  if (!process.env.DATABASE_URL) console.error('DATABASE_URL(=Neon 연결문자열) 환경변수가 필요해');
  if (!process.env.ADMIN_PASSWORD) console.error('ADMIN_PASSWORD 가 없어 → 기본값(change-me-now)으로 돌아. 당장 설정해라');
  if (!process.env.SIGNING_PRIVATE_KEY) console.error('SIGNING_PRIVATE_KEY 가 없어 → 재시작마다 서명키가 바뀐다. 로그의 키를 환경변수에 박아라');
  if (!String(process.env.ALLOWED_APP_SIGS || '').trim()) console.log('ALLOWED_APP_SIGS 비어있음 → 앱 서명 검사 건너뜀 (리패키징 방어 꺼짐)');
  if (!String(process.env.DEPOSIT_TOKEN || '').trim()) console.log('DEPOSIT_TOKEN 비어있음 → 자동 입금확인 웹훅 비활성');
  if (!fs.existsSync(PUBLIC_DIR)) console.log('public/ 폴더가 없어 → 구매 웹사이트는 아직 안 올라간 상태야 (API는 정상)');
}

warnEnv();
db.migrate()
  .then(() => app.listen(PORT, () => {
    console.log('license server on :' + PORT);
    startSelfPing();
  }))
  .catch((e) => { console.error('DB init 실패:', e && e.stack ? e.stack : e); process.exit(1); });
