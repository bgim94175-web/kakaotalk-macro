// K bot — 라이선스 서버 + 구매 웹사이트 + 웹 콘솔 (Neon Postgres)
// 이 파일은 부트스트랩만 한다. 실제 로직은 lib/ 와 routes/ 에 있다.
//   routes/admin.js    : 관리자 API (/admin/*) — 관리자 화면 /manage 가 부른다
//   routes/purchase.js : 구매 웹 API (/api/*) — 주문 · 키 조회 · 자동 입금확인 웹훅
//   routes/auth.js     : 회원·인증 API (/api/site /api/me /api/auth/* /auth/google/*) — 아이디·비밀번호 + Google
//   routes/panel.js    : 웹 콘솔 API (/panel/api/*) — 회원 세션으로 로그인
//   lib/sender-child.js: 서버 쪽 카카오 발송 자식 프로세스 (127.0.0.1 에서만 듣고, 공개 /v1 프록시는 없다)
// 안드로이드 앱(사용자앱·관리자앱)은 단종됐다. 앱 전용 API(/verify /heartbeat ...)도 같이 뺐다.
'use strict';

const express = require('express');
const fs = require('fs');
const path = require('path');

const db = require('./lib/db');
const settings = require('./lib/settings');
const rl = require('./lib/ratelimit');
const senderChild = require('./lib/sender-child');
const memberAuth = require('./lib/member-auth');
const oauth = require('./lib/google-oauth');
const adminRoutes = require('./routes/admin');
const authRoutes = require('./routes/auth');
const purchaseRoutes = require('./routes/purchase');
const panelRoutes = require('./routes/panel');

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');

const app = express();

// Render는 프록시 뒤에 있다 → req.protocol 이 실제 값이 되게.
// 다만 true(=전부 신뢰)로 두면 Express 가 XFF 맨 앞 토큰을 req.ip 로 쓴다 → 클라이언트가 위조 가능.
// 신뢰 홉 수만 준다(TRUST_PROXY_HOPS, 기본 1). 레이트리밋은 req.ip 를 쓰지 않고 rl.ipOf() 를 쓴다.
app.set('trust proxy', Number(process.env.TRUST_PROXY_HOPS) || 1);
app.disable('x-powered-by');

// 발송 자식의 /v1/* 는 공개하지 않는다(docs/ACCOUNTS_V1.md 8.5). 자식은 127.0.0.1 에서만 듣고
// 부모는 lib/sender-child.js call() 로만 부른다. 그래서 공개 /v1/* 는 아래 404 로 떨어진다.

// 본문 크기 제한. 콘솔의 이미지 저장만 더 받는다. 그 외 경로는 512kb 그대로다.
const jsonSmall = express.json({ limit: '512kb' });
const jsonSettings = express.json({ limit: '16mb' });
app.use((req, res, next) => {
  if (req.method === 'POST' && req.path === '/panel/api/settings') return jsonSettings(req, res, next);
  // 입금 웹훅은 본문을 routes/purchase.js 가 글자 그대로 받아 직접 푼다 — MacroDroid 처럼 줄바꿈이 그대로
  // 들어간 JSON 도 400 으로 버리지 않고 기록해야 한다. 경로는 rl.kindOf 로 본다(끝 슬래시·대소문자가 달라도 같은 라우트).
  if (rl.kindOf(req) === 'deposit') return next();
  return jsonSmall(req, res, next);
});

// ── IP 기반 레이트리밋 (실제 구현은 lib/ratelimit.js — 메모리 기반).
// 버킷은 종류별로 나뉘어 있다(order-read 180 / order-write 20 / deposit 60 / admin 120 /
// panel-login 8 / panel 180, 전부 분당·환경변수로 덮어쓰기 가능 — lib/ratelimit.js 의 KIND_LIMITS 참고).
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
        error: '비밀번호 입력 실패 횟수를 넘었습니다. ' + mins + '분 뒤 다시 시도해 주세요.' });
    }
  }

  const r = rl.hit(kind, ip, rl.maxFor(kind));
  if (!r.ok) {
    res.set('Retry-After', String(r.retryAfter));
    console.log('[rate] 과다요청 차단 ' + ip + ' ' + req.method + ' ' + req.path + ' (버킷=' + kind + ')');
    return res.status(429).json({ ok: false, reason: 'rate_limited', error: '요청이 너무 잦습니다. 잠시 뒤 다시 시도해 주세요.' });
  }
  next();
});

// CSRF (docs/ACCOUNTS_V1.md 8.3): /api/auth/·/api/order(POST)·/api/room-preview·/api/my/·/panel/api/ 의
// 쓰기 요청은 JSON 이어야 하고, Origin·Sec-Fetch-Site 가 이 사이트여야 한다. 레이트리밋 바로 뒤에 둔다.
app.use(memberAuth.sameOriginWrites);

// ── HTML 보안 헤더 (6.1·8.14): 모든 HTML 은 다른 사이트의 틀 안에 열리지 않는다.
// /panel·/manage 는 제3자 스크립트를 싣지 않으므로 script-src 'self' 까지 건다(D25).
// 사이트 화면은 채널톡 SDK 가 여러 호스트를 쓰므로 script-src 를 걸지 않는다.
const CSP_FRAME = "frame-ancestors 'none'";
const CSP_CONSOLE = CSP_FRAME + "; script-src 'self'; object-src 'none'; base-uri 'self'";
function htmlHeaders(res, fileName) {
  const base = path.basename(String(fileName || ''));
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Content-Security-Policy', base === 'panel.html' || base === 'manage.html' ? CSP_CONSOLE : CSP_FRAME);
  // HTML 은 늘 새로 받는다(?v= 로 바뀌는 css·js 를 가리키는 쪽이라 오래 두면 배포가 늦게 보인다)
  res.setHeader('Cache-Control', 'no-cache');
}

// /my(예전 키 조회 화면)는 내 계정의 키 등록 카드로 보낸다. 정적 파일(my.html)보다 먼저 둔다.
app.get('/my', (q, r) => r.redirect(302, '/account#claim'));

// ── 정적 파일 (구매 웹사이트). index 는 아래에서 직접 다룬다.
app.use(express.static(PUBLIC_DIR, {
  index: false,
  extensions: ['html'],
  maxAge: '1h',
  setHeaders: (res, filePath) => {
    if (/\.html$/.test(filePath)) return htmlHeaders(res, filePath);
    if (/(panel|manage)\.(js|css)$/.test(filePath)) res.setHeader('Cache-Control', 'no-cache');
  },
}));

function page(name) {
  return (req, res, next) => {
    const f = path.join(PUBLIC_DIR, name);
    if (!fs.existsSync(f)) return next();
    htmlHeaders(res, name);
    res.sendFile(f);
  };
}

// 웹 페이지 라우팅 (docs/ACCOUNTS_V1.md 6.1). 확장자 없는 주소는 위 정적 처리기가 먼저 받는다
// (extensions: ['html']) — 여기 줄은 경로를 문서로 남기고, 파라미터가 있는 /order/:id 를 받는다.
app.get('/buy', page('buy.html'));
app.get('/order/:id', page('order.html'));
app.get('/login', page('login.html'));
app.get('/signup', page('signup.html'));
app.get('/account', page('account.html'));
app.get('/support', page('support.html'));
app.get('/panel', page('panel.html'));
// 관리자 화면. /admin 은 비밀번호로 막힌 API 접두사라 페이지는 /manage 에 둔다.
app.get('/manage', page('manage.html'));

// ── API 라우터 (회원·인증은 구매 라우터보다 먼저)
app.use(adminRoutes);
app.use(authRoutes);
app.use(purchaseRoutes);
app.use(panelRoutes);

// 링크 미리보기 봇(카카오톡·디스코드 등). Accept 에 text/html 이 없어도 og 태그가 있는 페이지를 받아야 한다.
const PREVIEW_BOT = /kakaotalk-scrap|facebookexternalhit|Discordbot|Twitterbot|Slackbot|TelegramBot|WhatsApp|LinkedInBot|Applebot|Googlebot|bingbot|Yeti|Daum/i;

// 루트: 소개 페이지는 없앴다. 브라우저는 로그인했으면 패널, 아니면 구매로 바로 보낸다.
// 미리보기 봇은 구매 페이지(og 태그)를 그대로 받고, 그 외(curl 연결확인)는 기존 JSON 그대로.
app.get('/', (req, res) => {
  if (PREVIEW_BOT.test(String(req.headers['user-agent'] || ''))) {
    htmlHeaders(res, 'buy.html');
    return res.sendFile(path.join(PUBLIC_DIR, 'buy.html'));
  }
  if (String(req.headers.accept || '').indexOf('text/html') >= 0) {
    res.setHeader('Cache-Control', 'no-store');
    return res.redirect(302, memberAuth.cookieValue(req, memberAuth.COOKIE) ? '/panel' : '/buy');
  }
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
    return res.status(413).json({ ok: false, reason: 'too_large', error: '보낸 내용이 너무 큽니다. 내용을 줄인 뒤 다시 시도해 주세요.' });
  }
  if (err && err.type === 'entity.parse.failed') {
    return res.status(400).json({ ok: false, reason: 'bad_request', error: '요청을 처리하지 못했습니다. 페이지를 새로고침한 뒤 다시 시도해 주세요.' });
  }
  res.status(500).json({ ok: false, reason: 'server_error', error: '요청을 처리하지 못했습니다. 페이지를 새로고침한 뒤 다시 시도해 주세요.' });
});

// ── 셀프핑: Render 무료는 15분 동안 외부 요청이 없으면 잠듦 → 10분마다 자기 공개 주소를 호출해서 막음
// 이 호출이 무료 인스턴스를 하루 종일 켜 두지는 못한다. 프로세스가 죽거나, 호출이 실패하거나,
// 무료 한도로 인스턴스가 멈추면 그 사이 발송은 멈춘다.
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
  // 참여코드 봉인(lib/secretbox.js)·Google 상태 쿠키 서명·채널톡 회원 식별이 이 값에서 키를 만든다.
  if (String(process.env.CONFIG_SECRET || '').trim().length < 16) {
    console.error('CONFIG_SECRET 이 비었거나 16자 미만이야 → 참여코드 저장·Google 연결·채널톡 회원 식별이 동작하지 않는다. 긴 무작위 값을 넣어라');
  }
  warnAccountsEnv();
  if (!String(process.env.DEPOSIT_TOKEN || '').trim()) console.log('DEPOSIT_TOKEN 비어있음 → 자동 입금확인 웹훅 비활성');
  if (!fs.existsSync(PUBLIC_DIR)) console.log('public/ 폴더가 없어 → 구매 웹사이트는 아직 안 올라간 상태야 (API는 정상)');
  // 레이트리밋 설정을 부팅 로그에 남긴다 (429 신고가 들어왔을 때 이 줄부터 본다)
  const lim = rl.limits();
  console.log('[rate] 신뢰 프록시 홉=' + rl.trustProxyHops() + ' (TRUST_PROXY_HOPS) / 분당 한도 ' +
              Object.keys(lim).map((k) => k + '=' + lim[k]).join(' '));
}

// 회원·Google·채널톡·시험 모드 관련 경고 (docs/ACCOUNTS_V1.md 9.6)
function warnAccountsEnv() {
  const env = (n) => String(process.env[n] || '').trim();
  if (oauth.halfConfigured()) {
    console.error('GOOGLE_CLIENT_ID 와 GOOGLE_CLIENT_SECRET 중 하나만 있어 → Google 로그인·연결이 꺼진다. 둘 다 넣거나 둘 다 지워라');
  }
  if (env('GOOGLE_CLIENT_ID') && env('GOOGLE_CLIENT_SECRET')) {
    if (!env('CONFIG_SECRET')) console.error('CONFIG_SECRET 이 없어 Google 로그인·연결이 꺼진다(상태 쿠키 서명 키)');
    if (!env('PURCHASE_BASE') && !env('GOOGLE_REDIRECT_URI')) {
      console.error('Google 을 켰는데 PURCHASE_BASE 가 비었어 → 운영은 PURCHASE_BASE=https://kmacro.cloud 가 필수다');
    }
    const base = memberAuth.purchaseBase(null);
    console.log('[google] redirect URI = ' + (env('GOOGLE_REDIRECT_URI') || (base ? oauth.redirectUri(base) : '(요청 주소)/auth/google/callback')) +
                ' — Google Cloud 콘솔의 승인된 리디렉션 URI 와 같아야 한다');
  }
  oauth.overrides().forEach((o) => {
    if (o.used) console.error('[google] ' + o.name + ' 덮어쓰기 활성 → ' + o.value + ' (시험 전용. 운영에서는 지워라)');
    else console.error('[google] ' + o.name + ' 값을 무시함(https 또는 localhost 만 받는다): ' + o.value);
  });
  const secretProblem = memberAuth.memberSecretProblem();
  if (secretProblem) console.error('[channel] ' + secretProblem + ' → 회원 식별 없이 이름만 넘긴다');
  else if (env('CHANNEL_MEMBER_SECRET')) {
    console.log('[channel] CHANNEL_MEMBER_SECRET 설정됨 → 채널 데스크에서 회원 해시(Member Hash) 검증을 켰는지 확인하라.' +
                ' 꺼져 있으면 아무 브라우저나 남의 memberId 로 지난 상담을 볼 수 있다');
  }
  if (!env('CHANNEL_PLUGIN_KEY') && !env('CONTACT_INFO')) {
    console.error('CHANNEL_PLUGIN_KEY 와 CONTACT_INFO 가 둘 다 없어 → 상담·문의 버튼이 모두 숨는다');
  }
  if (env('SENDER_FAKE')) {
    console.error('');
    console.error('################################################################');
    console.error('#  SENDER_FAKE 가 켜져 있어 — 카카오에 붙지 않는 시험 모드다.');
    console.error('#  운영에서 절대 쓰지 마라. 고객 발송과 방 입장이 전부 가짜가 된다.');
    console.error('################################################################');
    console.error('');
  }
}

// 다른 작업의 배경 작업(installs·entitle). 아직 틀이어도 부팅은 계속한다.
function startLoops() {
  ['./lib/installs', './lib/entitle'].forEach((mod) => {
    try {
      require(mod).startLoop();
    } catch (e) {
      console.error('[boot] ' + mod + '.startLoop 실패: ' + (e && e.stack ? e.stack : e));
    }
  });
}

warnEnv();
db.migrate()
  // 운영 한도(/manage [설정])를 먼저 읽는다. 못 읽어도 기본값으로 뜬다.
  .then(() => settings.load().catch((e) => console.error('[boot] 운영 한도를 읽지 못해 기본값으로 시작합니다: ' + (e && e.message ? e.message : e))))
  .then(() => app.listen(PORT, () => {
    console.log('license server on :' + PORT);
    startSelfPing();
    startLoops();            // entitle.startLoop 이 senderChild.onReady 를 먼저 걸어 두게 자식보다 앞에
    senderChild.start();
  }))
  .catch((e) => { console.error('DB init 실패:', e && e.stack ? e.stack : e); process.exit(1); });
