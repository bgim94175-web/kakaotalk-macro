// 발송 루프는 이 프로세스 안에서 돌리지 않는다.
// 라이선스 서버가 sender/src/index.mjs 를 자식으로 띄우고, 죽으면 다시 띄운다.
// 부모의 /health, 라이선스, 구매 사이트, 셀프핑은 자식이 죽어도 유지된다.
// Render 인스턴스 전체가 OOM 으로 죽는 것은 여기서 막지 못한다.
'use strict';

const http = require('http');
const path = require('path');
const { spawn } = require('child_process');

const state = {
  port: 0,
  child: null,
  backoff: 1000,
  timer: null,
  stops: false,
  restarts: 0,
  started: false,
};

function configured() {
  return !!(process.env.SENDER_TOKEN && process.env.SENDER_KEY && process.env.DATABASE_URL);
}

function entry() {
  return process.env.SENDER_CHILD_ENTRY || path.join(__dirname, '..', 'sender', 'src', 'index.mjs');
}

function install(app) {
  app.use((req, res, next) => {
    const p = req.path || '';
    if (p !== '/v1' && !p.startsWith('/v1/')) return next();
    proxy(req, res);
  });
}

function proxy(req, res) {
  const port = state.port;
  if (!port) {
    res.status(503).json({ ok: false, error: 'sender_down' });
    return;
  }
  const headers = Object.assign({}, req.headers);
  headers.host = '127.0.0.1:' + port;
  delete headers.connection;
  delete headers['transfer-encoding'];
  const preq = http.request({
    hostname: '127.0.0.1',
    port: port,
    method: req.method,
    path: req.originalUrl || req.url,
    headers: headers,
  }, (pres) => {
    const out = Object.assign({}, pres.headers);
    delete out['transfer-encoding'];
    res.writeHead(pres.statusCode || 502, out);
    pres.pipe(res);
  });
  preq.on('error', () => {
    if (!res.headersSent) res.status(503).json({ ok: false, error: 'sender_down' });
    else res.destroy();
  });
  req.on('aborted', () => preq.destroy());
  req.pipe(preq);
}

function start() {
  if (state.started) return;
  state.started = true;
  if (!configured()) {
    console.log('[sender] SENDER_TOKEN, SENDER_KEY, DATABASE_URL 이 없어 발송 자식을 띄우지 않습니다. 라이선스와 구매 사이트는 그대로 둡니다.');
    return;
  }
  spawnChild();
}

function spawnChild() {
  state.timer = null;
  state.port = 0;
  const child = spawn(process.execPath, [entry()], {
    env: Object.assign({}, process.env, { PORT: '0', SENDER_BIND: '127.0.0.1' }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  state.child = child;
  let buf = '';
  let settled = false;
  let stableTimer = null;

  child.stdout.on('data', (chunk) => {
    buf += chunk.toString('utf8');
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      const m = /^SENDER_LISTENING\s+(\d+)$/.exec(line);
      if (m) {
        state.port = Number(m[1]);
        console.log('[sender] child listening on 127.0.0.1:' + state.port);
        if (stableTimer) clearTimeout(stableTimer);
        stableTimer = setTimeout(() => { state.backoff = 1000; }, 30000);
        if (stableTimer.unref) stableTimer.unref();
      } else if (line) {
        console.log('[sender:stdout] ' + line);
      }
    }
  });
  child.stderr.on('data', (chunk) => {
    process.stderr.write(chunk);
  });

  function gone(code, signal) {
    if (settled) return;
    settled = true;
    if (stableTimer) clearTimeout(stableTimer);
    if (state.child === child) {
      state.child = null;
      state.port = 0;
    }
    console.error('[sender] child exited code=' + code + ' signal=' + signal +
      '. 라이선스 서버는 유지하고 자식을 다시 띄웁니다.');
    if (state.stops) return;
    state.restarts += 1;
    const wait = state.backoff;
    state.backoff = Math.min(state.backoff * 2, 15000);
    state.timer = setTimeout(spawnChild, wait);
    if (state.timer.unref) state.timer.unref();
  }

  child.on('error', (err) => {
    console.error('[sender] spawn failed: ' + (err && err.message ? err.message : err));
    gone(null, 'error');
  });
  child.on('exit', (code, signal) => gone(code, signal));
}

function status() {
  return { port: state.port, restarts: state.restarts, running: !!state.child };
}

module.exports = { install, start, configured, status };
