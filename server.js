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
const rl = require('./lib/ratelimit');
const licenseRoutes = require('./routes/license');
const adminRoutes = require('./routes/admin');
const purchaseRoutes = require('./routes/purchase');

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');

const app = express();

// Render는 프록시 뒤에 있다 → req.protocol 이 실제 값이 되게.
// 다만 true(=전부 신뢰)로 두면 Express 가 XFF 맨 앞 토큰을 req.ip 로 쓴다 → 클라이언트가 위조 가능.
// 신뢰 홉 수만 준다(TRUST_PROXY_HOPS, 기본 1). 레이트리밋은 req.ip 를 쓰지 않고 rl.ipOf() 를 쓴다.
app.set('trust proxy', Number(process.env.TRUST_PROXY_HOPS) || 1);
app.disable('x-powered-by');

// 본문 크기 제한 (설정 백업 blob 256KB + 여유)
app.use(express.json({ limit: '512kb' }));

// ── IP 기반 레이트리밋 (실제 구현은 lib/ratelimit.js — 메모리 기반).
// 버킷은 종류별로 나뉘어 있다(verify 30 / order-read 180 / order-write 20 / deposit 60 / admin 120,
// 전부 분당·환경변수로 덮어쓰기 가능 — lib/ratelimit.js 의 KIND_LIMITS 참고).
// NAT(사무실) 뒤에서 여러 명이 같이 써도 폴링이 결제 대기자끼리 서로를 막지 않게 하려는 분리다.
// IP 는 rl.ipOf() 로만 뽑는다 — req.ip 는 Express 의 해석이라 우리 의도(XFF 맨 뒤)와 달라질 수 있다.
// 관리자 비밀번호 연속 실패 차단은 routes/admin.js 의 guard 가 기록하고, 여기서 막는다(기본 15분).
// 경로 판정은 rl.kindOf() 가 대소문자·끝슬래시를 정규화해서 본다 (/ADMIN/list/ 로 우회 못 하게).
function limitKind(req) {
  return rl.kindOf(req);
}

app.use((req, res, next) => {
  const kind = limitKind(req);
  if (!kind) return next();
  const ip = rl.ipOf(req);

  // 비밀번호를 연달아 틀려서 차단된 IP 는 관리자 라우터에 닿기도 전에 돌려보낸다
  if (kind === 'admin') {
    const left = rl.adminBlockedMs(ip);
    if (left > 0) {
      const mins = Math.ceil(left / 60000);
      res.set('Retry-After', String(Math.ceil(left / 1000)));
      console.log('[rate] 관리자 인증 실패로 차단중 ' + ip + ' ' + req.method + ' ' + req.path +
                  ' (' + mins + '분 남음)');
      return res.status(429).json({ ok: false, reason: 'rate_limited',
        error: '비밀번호 입력 실패 횟수를 초과했습니다. ' + mins + '분 후 다시 시도하십시오' });
    }
  }

  const r = rl.hit(kind, ip, rl.maxFor(kind));
  if (!r.ok) {
    res.set('Retry-After', String(r.retryAfter));
    console.log('[rate] 과다요청 차단 ' + ip + ' ' + req.method + ' ' + req.path + ' (버킷=' + kind + ')');
    return res.status(429).json({ ok: false, reason: 'rate_limited', error: '요청이 너무 빈번합니다. 잠시 후 다시 시도하십시오' });
  }
  next();
});

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
    return res.status(413).json({ ok: false, error: '본문 크기가 허용 범위를 초과했습니다' });
  }
  if (err && err.type === 'entity.parse.failed') {
    return res.status(400).json({ ok: false, error: '요청 본문(JSON) 형식이 올바르지 않습니다' });
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
  const pwProblem = adminRoutes.passwordProblem ? adminRoutes.passwordProblem() : null;
  if (pwProblem) {
    console.error('');
    console.error('################################################################');
    console.error('#  관리자 API 전체를 503 으로 닫아뒀어 — ' + pwProblem);
    console.error('#  Render 대시보드 > Environment 에서 ADMIN_PASSWORD 를 길고 무작위한');
    console.error('#  값으로 채우고 다시 배포해라. 기본 비밀번호로 실서비스를 열면');
    console.error('#  /admin/list 로 전 고객 정보가 새고 /admin/create 로 키가 무한 발급된다.');
    console.error('################################################################');
    console.error('');
  } else if (String(process.env.ADMIN_PASSWORD).length < 12) {
    console.error('ADMIN_PASSWORD 가 짧아 (' + String(process.env.ADMIN_PASSWORD).length +
                  '자) → 20자 이상 무작위 값으로 바꿔라');
  }
  if (!process.env.SIGNING_PRIVATE_KEY) console.error('SIGNING_PRIVATE_KEY 가 없어 → 재시작마다 서명키가 바뀐다. 로그의 키를 환경변수에 박아라');
  if (!String(process.env.ALLOWED_APP_SIGS || '').trim()) console.log('ALLOWED_APP_SIGS 비어있음 → 앱 서명 검사 건너뜀 (리패키징 방어 꺼짐)');
  if (!String(process.env.DEPOSIT_TOKEN || '').trim()) console.log('DEPOSIT_TOKEN 비어있음 → 자동 입금확인 웹훅 비활성');
  if (!fs.existsSync(PUBLIC_DIR)) console.log('public/ 폴더가 없어 → 구매 웹사이트는 아직 안 올라간 상태야 (API는 정상)');
  // 레이트리밋 설정을 부팅 로그에 남긴다 (429 신고가 들어왔을 때 이 줄부터 본다)
  const lim = rl.limits();
  console.log('[rate] 신뢰 프록시 홉=' + rl.trustProxyHops() + ' (TRUST_PROXY_HOPS) / 분당 한도 ' +
              Object.keys(lim).map((k) => k + '=' + lim[k]).join(' '));
}

warnEnv();
db.migrate()
  .then(() => app.listen(PORT, () => {
    console.log('license server on :' + PORT);
    startSelfPing();
  }))
  .catch((e) => { console.error('DB init 실패:', e && e.stack ? e.stack : e); process.exit(1); });
