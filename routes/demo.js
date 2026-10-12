// 사이트 체험 API (/api/demo*) — docs/ACCOUNTS_V1.md 3.7. 화면은 public/demo.html · demo.js.
// 로그인·DB 없이 lib/demo.js 엔진만 부른다. 체험 상태는 손님 브라우저가 들고 다니며 단계마다 돌려보낸다.
// 카카오톡에는 아무것도 보내지 않는다. 레이트리밋은 server.js 의 'demo' 버킷(lib/ratelimit.js).
'use strict';

const express = require('express');
const demo = require('../lib/demo');

const router = express.Router();

const wrap = (fn) => (req, res) => Promise.resolve(fn(req, res)).catch((e) => {
  console.error('[' + req.method + ' ' + req.originalUrl + '] ' + (e && e.stack ? e.stack : e));
  if (!res.headersSent) res.status(500).json({ ok: false, reason: 'server_error', error: '요청을 처리하지 못했습니다. 잠시 뒤 다시 시도해 주세요.' });
});

function bad(res, status, reason, error) {
  return res.status(status).json({ ok: false, reason: reason, error: error });
}

function body(req) {
  return req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
}

// 엔진 결과 {ok:false, status, reason, error} → 그대로, 성공은 status 없이
function send(res, r) {
  if (!r.ok) return bad(res, r.status || 400, r.reason, r.error);
  res.set('Cache-Control', 'no-store');
  const out = Object.assign({}, r);
  delete out.status;
  return res.json(out);
}

// ─────────────────────────────────────────────────────────────
// GET /api/demo — 체험 목록(묶음 → 장면)
// ─────────────────────────────────────────────────────────────
router.get('/api/demo', wrap(async (req, res) => {
  res.json(Object.assign({ ok: true }, demo.catalog()));
}));

// ─────────────────────────────────────────────────────────────
// POST /api/demo/start {scene, opts?} — 장면 처음 화면
// ─────────────────────────────────────────────────────────────
router.post('/api/demo/start', wrap(async (req, res) => {
  const b = body(req);
  send(res, await demo.start(b.scene, b.opts));
}));

// ─────────────────────────────────────────────────────────────
// POST /api/demo/step {state, ev} — 손님이 쓴 글(say) · 누른 버튼(act) 1건
// 상태가 틀리거나(크기·버전·모양) 엔진이 처리하지 못하면 400 bad_state → 화면이 장면을 다시 시작한다.
// ─────────────────────────────────────────────────────────────
router.post('/api/demo/step', wrap(async (req, res) => {
  const b = body(req);
  send(res, await demo.step(b.state, b.ev));
}));

module.exports = router;
