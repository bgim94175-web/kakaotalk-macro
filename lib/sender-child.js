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

// 운영자용(판매 관리) 사유: 환경변수 이름·마지막 오류 줄까지 보인다.
function reason() {
  const missing = missingEnv();
  if (missing.length) return '발송 서버 설정을 읽지 못했습니다. 서버 환경변수가 없습니다: ' + missing.join(', ');
  if (state.ready && state.port) return '';
  if (state.bootError) return '발송 서버가 켜지지 않았습니다. ' + state.bootError;
  if (state.child && !state.ready) return '발송 서버를 켜는 중입니다.';
  const detail = lastLine(state.stderrTail);
  if (state.lastExit) {
    return '발송 서버가 멈췄습니다. ' + state.lastExit + (detail ? ' ' + detail : '');
  }
  if (detail) return '발송 서버가 멈춰 있습니다. ' + detail;
  return '발송 서버가 멈춰 있습니다. 다시 켜지면 등록된 계정으로 자동으로 다시 접속합니다.';
}

// 손님용(패널) 사유: 설정 이름·오류 원문 같은 내부 정보를 내보내지 않는다(docs/TONE.md).
function customerReason() {
  if (state.ready && state.port && configured()) return '';
  if (configured() && state.child && !state.ready && !state.bootError) return '발송 서버를 켜는 중입니다. 잠시 뒤 다시 시도해 주세요.';
  return '발송 서버가 잠시 멈춰 있습니다. 복구되면 등록한 카카오 계정으로 자동으로 다시 접속합니다.';
}

function entry() {
  return process.env.SENDER_CHILD_ENTRY || path.join(__dirname, '..', 'sender', 'src', 'boot.mjs');
}

// 부모의 공개 /v1/* 프록시는 없앴다(docs/ACCOUNTS_V1.md 3.6·8.5). 자식은 127.0.0.1 에서만 듣고
// 부모는 call() 로만 부른다. /v1/grants · /v1/bot/* · /v1/fake/* 가 인터넷에 노출되면 안 된다.
// 아직 install(app) 을 부르는 server.js 가 있어도 아무것도 걸지 않는다(호환용 빈 함수).
function install(app) {}

// SENDER_READY 를 받을 때마다(자식이 처음 뜰 때·다시 뜰 때) 부를 함수들. entitle.startLoop 가
// 여기에 전체 권리 밀기 + /v1/bot/sync 를 건다(4.5). 등록 시점에 이미 준비돼 있으면 곧바로 한 번 부른다.
const readyFns = [];
function onReady(fn) {
  if (typeof fn !== 'function') return;
  readyFns.push(fn);
  if (up()) fireOne(fn);
}

function fireOne(fn) {
  setImmediate(() => {
    try {
      const r = fn();
      if (r && typeof r.catch === 'function') {
        r.catch((e) => console.error('[sender] onReady 처리 실패: ' + (e && e.message ? e.message : e)));
      }
    } catch (e) {
      console.error('[sender] onReady 처리 실패: ' + (e && e.message ? e.message : e));
    }
  });
}

function fireReady() {
  for (const fn of readyFns) fireOne(fn);
}

// 부모가 끝날 때 자식도 끝낸다. 그러지 않으면 부모 없는 sender 가 남아 같은 카카오 계정으로
// 계속 접속하고, 다음 부모가 띄운 자식과 서로 밀어낸다.
function stopChild() {
  state.stops = true;
  if (state.timer) { clearTimeout(state.timer); state.timer = null; }
  const c = state.child;
  if (c && c.exitCode === null && c.signalCode === null) {
    try { c.kill('SIGTERM'); } catch (e) { /* 이미 끝남 */ }
  }
}

// 멈출 때(SIGTERM·SIGINT) 자식에게 SIGTERM 을 보내고, 자식이 방 상태를 마지막으로 저장하고(index.mjs, 최대 5초) 끝날 때까지
// 기다린 뒤 나간다. 부모가 먼저 나가면 컨테이너(Render)가 내려가면서 저장 중인 자식도 함께 죽는다. 자식이 멈춰 있어도 이만큼 뒤에는 나간다.
const STOP_WAIT_MS = 7000;

function stopAndWait(done) {
  const c = state.child;
  stopChild();
  if (!c || c.exitCode !== null || c.signalCode !== null) return done();
  const t = setTimeout(done, STOP_WAIT_MS);
  c.once('exit', () => { clearTimeout(t); done(); });
}

function start() {
  if (state.started) return;
  state.started = true;
  if (!configured()) {
    console.log('[sender] SENDER_TOKEN, SENDER_KEY, DATABASE_URL 이 없어 발송 자식을 띄우지 않습니다. 라이선스와 구매 사이트는 그대로 둡니다.');
    return;
  }
  process.once('exit', stopChild);
  ['SIGTERM', 'SIGINT'].forEach((sig) => {
    process.once(sig, () => {
      stopAndWait(() => process.exit(sig === 'SIGINT' ? 130 : 143));
    });
  });
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
        // 시험(9.5)이 이 줄에서 포트를 읽어 자식의 /v1/fake/* 를 직접 부른다. 모양을 바꾸지 않는다.
        console.log('[sender] listening 127.0.0.1:' + state.port);
        if (stableTimer) clearTimeout(stableTimer);
        stableTimer = setTimeout(() => { state.backoff = 1000; }, 30000);
        if (stableTimer.unref) stableTimer.unref();
      } else if (line === 'SENDER_READY') {
        state.ready = true;
        state.bootError = '';
        console.log('[sender] child ready');
        fireReady();
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

module.exports = { install, onReady, start, configured, up, reason, customerReason, status, call };
