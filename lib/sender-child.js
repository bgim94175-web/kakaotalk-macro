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
  ready: false,
  child: null,
  backoff: 1000,
  timer: null,
  stops: false,
  restarts: 0,
  started: false,
  bootError: '',
  lastExit: '',
  stderrTail: '',
};

function filled(name) {
  return !!String(process.env[name] || '').trim();
}

function missingEnv() {
  const names = [];
  if (!filled('SENDER_TOKEN')) names.push('SENDER_TOKEN');
  if (!filled('SENDER_KEY')) names.push('SENDER_KEY');
  if (!filled('DATABASE_URL')) names.push('DATABASE_URL');
  return names;
}

function configured() {
  return missingEnv().length === 0;
}

function redact(text) {
  return String(text || '')
    .replace(/postgres(?:ql)?:\/\/\S+/gi, 'postgresql://…')
    .replace(/\/\/[^/\s@]+@/g, '//…@');
}

function lastLine(text) {
  const lines = String(text || '').split('\n').map((s) => s.trim()).filter(Boolean);
  return lines.length ? lines[lines.length - 1].slice(0, 240) : '';
}

function noteStderr(chunk) {
  state.stderrTail = (state.stderrTail + redact(chunk.toString('utf8'))).slice(-1200);
}

function reason() {
  const missing = missingEnv();
  if (missing.length) return '발송 설정을 읽지 못했습니다. 서버에 없는 값: ' + missing.join(', ');
  if (state.ready && state.port) return '';
  if (state.bootError) return '발송 프로세스가 켜지지 않았습니다. ' + state.bootError;
  if (state.child && !state.ready) return '발송 프로세스를 켜는 중입니다.';
  const detail = lastLine(state.stderrTail);
  if (state.lastExit) {
    return '발송 프로세스가 종료되었습니다. ' + state.lastExit + (detail ? ' ' + detail : '');
  }
  if (detail) return '발송 프로세스가 지금 멈춰 있습니다. ' + detail;
  return '발송 프로세스가 지금 멈춰 있습니다. 키 확인은 그대로 됩니다. 프로세스가 다시 뜨면 저장된 계정으로 이어서 접속합니다.';
}

function entry() {
  return process.env.SENDER_CHILD_ENTRY || path.join(__dirname, '..', 'sender', 'src', 'boot.mjs');
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
  state.ready = false;
  state.bootError = '';
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
        state.ready = false;
        console.log('[sender] child listening on 127.0.0.1:' + state.port);
        if (stableTimer) clearTimeout(stableTimer);
        stableTimer = setTimeout(() => { state.backoff = 1000; }, 30000);
        if (stableTimer.unref) stableTimer.unref();
      } else if (line === 'SENDER_READY') {
        state.ready = true;
        state.bootError = '';
        console.log('[sender] child ready');
      } else if (line.indexOf('SENDER_BOOT_ERROR ') === 0) {
        state.ready = false;
        state.bootError = line.slice('SENDER_BOOT_ERROR '.length).slice(0, 300);
        console.error('[sender] boot error: ' + state.bootError);
      } else if (line) {
        console.log('[sender:stdout] ' + line);
      }
    }
  });
  child.stderr.on('data', (chunk) => {
    noteStderr(chunk);
    process.stderr.write(chunk);
  });

  function gone(code, signal) {
    if (settled) return;
    settled = true;
    if (stableTimer) clearTimeout(stableTimer);
    if (state.child === child) {
      state.child = null;
      state.port = 0;
      state.ready = false;
    }
    const detail = lastLine(state.stderrTail);
    state.lastExit = 'code=' + code + ' signal=' + signal + (detail ? ' ' + detail : '');
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

function up() {
  return configured() && !!state.port && state.ready;
}

function status() {
  return {
    port: state.port,
    ready: state.ready,
    restarts: state.restarts,
    running: !!state.child,
    reason: reason(),
  };
}

// 부모만 호출한다. 본문(비밀번호, 토큰)은 로그에 남기지 않는다.
function call(method, urlPath, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    const port = state.port;
    if (!port || !state.ready) {
      const err = new Error('sender_down');
      err.code = 'sender_down';
      reject(err);
      return;
    }
    const payload = body == null ? null : Buffer.from(JSON.stringify(body));
    const req = http.request({
      hostname: '127.0.0.1',
      port: port,
      method: method,
      path: urlPath,
      headers: {
        'x-sender-token': String(process.env.SENDER_TOKEN || '').trim(),
        'content-type': 'application/json',
        'content-length': payload ? payload.length : 0,
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = text ? JSON.parse(text) : null; } catch (e) { json = null; }
        resolve({ status: res.statusCode || 0, json: json });
      });
    });
    req.setTimeout(timeoutMs || 30000, () => {
      req.destroy(new Error('timeout'));
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

module.exports = { install, start, configured, up, reason, status, call };
