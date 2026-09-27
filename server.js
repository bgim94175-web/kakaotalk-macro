// 카톡 자동발송 - 라이선스 서버 (Neon Postgres)
// 키 검증 / 기기 고정 / 만료 관리 + 관리자 API. 모든 사용자 응답은 Ed25519 서명으로 위조 방지.
const express = require('express');
const crypto = require('crypto');
const { Pool } = require('pg');

const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'change-me-now';
let PRIV_PEM = process.env.SIGNING_PRIVATE_KEY;

if (!process.env.DATABASE_URL) { console.error('DATABASE_URL(=Neon 연결문자열) 환경변수가 필요해'); }
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }, // Neon 필수
  max: 3,
});

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS licenses (
      key          TEXT PRIMARY KEY,
      plan         TEXT NOT NULL,
      duration_ms  BIGINT NOT NULL,
      device_id    TEXT,
      device_name  TEXT,
      activated_at BIGINT,
      expires_at   BIGINT,
      revoked      BOOLEAN DEFAULT FALSE,
      note         TEXT,
      created_at   BIGINT NOT NULL,
      last_seen    BIGINT
    );`);
}

// ── 서명키
function loadKey() {
  if (!PRIV_PEM) {
    const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
    PRIV_PEM = privateKey.export({ type: 'pkcs8', format: 'pem' });
    const pubDer = publicKey.export({ type: 'spki', format: 'der' });
    console.log('\n===== 서명키 생성됨 (한 번만 뜸) =====');
    console.log('Render 환경변수 SIGNING_PRIVATE_KEY 에 저장:');
    console.log(PRIV_PEM);
    console.log('사용자 앱 Config.PUBLIC_KEY_B64 에 넣기:');
    console.log(Buffer.from(pubDer).toString('base64'));
    console.log('=====================================\n');
  }
  return crypto.createPrivateKey(PRIV_PEM);
}
const PRIVATE_KEY = loadKey();
function sign(obj) {
  const sig = crypto.sign(null, Buffer.from(JSON.stringify(obj)), PRIVATE_KEY).toString('base64');
  return { ...obj, sig };
}

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function genKey() {
  const rnd = crypto.randomBytes(12);
  let out = 'KAKA';
  for (let i = 0; i < 12; i++) { if (i % 4 === 0) out += '-'; out += ALPHABET[rnd[i] % ALPHABET.length]; }
  return out;
}

const DAY = 86400000;
const PLANS = { month: 30 * DAY, year: 365 * DAY };

const app = express();
app.use(express.json());

function admin(req, res, next) {
  const pw = req.header('x-admin-password');
  if (!pw || pw !== ADMIN_PASSWORD) return res.status(401).json({ ok: false, error: 'unauthorized' });
  next();
}
const wrap = (fn) => (req, res) => fn(req, res).catch(e => { console.error(e); res.status(500).json({ ok: false, error: 'server_error' }); });

app.post('/admin/create', admin, wrap(async (req, res) => {
  const { plan = 'month', count = 1, days, note } = req.body || {};
  const duration = plan === 'custom' ? Number(days) * DAY : PLANS[plan];
  if (!duration || duration < DAY) return res.json({ ok: false, error: 'invalid plan/days' });
  const now = Date.now();
  const n = Math.min(Math.max(1, Number(count) || 1), 200);
  const keys = [];
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (let i = 0; i < n; i++) {
      let k, dup = true;
      while (dup) { k = genKey(); dup = (await client.query('SELECT 1 FROM licenses WHERE key=$1', [k])).rowCount > 0; }
      await client.query('INSERT INTO licenses (key,plan,duration_ms,note,created_at) VALUES ($1,$2,$3,$4,$5)',
        [k, plan, duration, note || null, now]);
      keys.push(k);
    }
    await client.query('COMMIT');
  } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
  res.json({ ok: true, keys, plan, duration_days: duration / DAY });
}));

app.get('/admin/list', admin, wrap(async (req, res) => {
  const r = await pool.query('SELECT * FROM licenses ORDER BY created_at DESC LIMIT 500');
  res.json({ ok: true, now: Date.now(), licenses: r.rows });
}));

app.post('/admin/revoke', admin, wrap(async (req, res) => {
  const { key, revoked = true } = req.body || {};
  const r = await pool.query('UPDATE licenses SET revoked=$1 WHERE key=$2', [!!revoked, key]);
  res.json({ ok: r.rowCount > 0 });
}));

app.post('/admin/reset-device', admin, wrap(async (req, res) => {
  const r = await pool.query('UPDATE licenses SET device_id=NULL,device_name=NULL,activated_at=NULL,expires_at=NULL WHERE key=$1', [(req.body || {}).key]);
  res.json({ ok: r.rowCount > 0 });
}));

app.post('/admin/delete', admin, wrap(async (req, res) => {
  const r = await pool.query('DELETE FROM licenses WHERE key=$1', [(req.body || {}).key]);
  res.json({ ok: r.rowCount > 0 });
}));

// ── 사용자 앱: 활성화 + 검증
app.post('/verify', wrap(async (req, res) => {
  const { key, device_id, device_name, nonce } = req.body || {};
  const now = Date.now();
  const fail = (reason) => res.json(sign({ ok: false, reason, nonce: nonce || null, ts: now }));
  if (!key || !device_id) return fail('bad_request');

  const lic = (await pool.query('SELECT * FROM licenses WHERE key=$1', [key])).rows[0];
  if (!lic) return fail('invalid_key');
  if (lic.revoked) return fail('revoked');

  if (!lic.device_id) {
    const expires = now + Number(lic.duration_ms);
    await pool.query('UPDATE licenses SET device_id=$1,device_name=$2,activated_at=$3,expires_at=$4,last_seen=$5 WHERE key=$6',
      [device_id, device_name || null, now, expires, now, key]);
    return res.json(sign({ ok: true, key, plan: lic.plan, expires_at: expires, device_id, nonce: nonce || null, ts: now }));
  }
  if (lic.device_id !== device_id) return fail('device_mismatch');
  if (lic.expires_at && now > Number(lic.expires_at)) return fail('expired');

  await pool.query('UPDATE licenses SET last_seen=$1, device_name=COALESCE($2,device_name) WHERE key=$3', [now, device_name || null, key]);
  res.json(sign({ ok: true, key, plan: lic.plan, expires_at: Number(lic.expires_at), device_id, nonce: nonce || null, ts: now }));
}));

app.get('/', (req, res) => res.json({ ok: true, service: 'kakao-license', time: Date.now() }));
app.get('/health', (req, res) => res.type('text').send('ok')); // 셀프핑용 (DB 안 건드림 → Neon 사용량 0)

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
      const t = setTimeout(() => ctrl.abort(), 30_000);
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
  setTimeout(ping, 60_000);
  console.log('셀프핑 켜짐 → ' + base + '/health, 약 ' + Math.round(every / 60000) + '분마다');
}

initDb().then(() => app.listen(PORT, () => { console.log('license server on :' + PORT); startSelfPing(); }))
  .catch(e => { console.error('DB init 실패:', e); process.exit(1); });
