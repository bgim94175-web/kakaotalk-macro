// lib/quick-replies.js 점검: 저장 형식 · 검사 문구 · 예시
'use strict';
const assert = require('assert');
const Q = require('./quick-replies');

assert.deepStrictEqual(Q.readStored(null).map((x) => x.label), ['인사', '확인 중', '감사'], 'never saved → examples');
assert.deepStrictEqual(Q.readStored([]), [], 'saved empty stays empty');
assert.deepStrictEqual(Q.readStored([{ label: ' 인사\n', text: '안녕\r\n하세요' }, { label: '', text: 'x' }, null, 'x', { label: 'a', text: '' }]), [{ label: '인사', text: '안녕\n하세요' }], 'stored rows are cleaned');
assert.strictEqual(Q.readStored(Array.from({ length: 20 }, (_, i) => ({ label: 'b' + i, text: 't' }))).length, Q.MAX_ITEMS, 'stored rows capped');

const ok = (v) => { const r = Q.validate(v); assert.ok(r.ok, JSON.stringify(r)); return r.items; };
const bad = (v, err) => { const r = Q.validate(v); assert.ok(!r.ok && r.error === err, JSON.stringify(r)); };
assert.deepStrictEqual(ok([{ label: '  가격 ', text: ' 1만원이에요\n감사합니다 ' }]), [{ label: '가격', text: '1만원이에요\n감사합니다' }], 'trim');
assert.deepStrictEqual(ok([]), [], 'empty list ok');
bad('x', Q.TEXT.bad);
bad([{ label: 1, text: 'a' }], Q.TEXT.bad);
bad([['a']], Q.TEXT.bad);
bad([{ label: ' ', text: 'a' }], Q.TEXT.no_label);
bad([{ label: 'a', text: ' \n ' }], Q.TEXT.no_text);
bad([{ label: '가'.repeat(17), text: 'a' }], Q.TEXT.long_label);
assert.ok(Q.validate([{ label: '가'.repeat(16), text: 'a' }]).ok, '16 chars ok');
bad([{ label: 'a', text: 'x'.repeat(1001) }], Q.TEXT.long_text);
bad([{ label: 'a', text: '1' }, { label: 'a', text: '2' }], Q.TEXT.dup);
bad(Array.from({ length: 13 }, (_, i) => ({ label: 'b' + i, text: 't' })), Q.TEXT.too_many);
for (const t of Object.values(Q.TEXT)) assert.ok(/(니다|주세요)\.$/.test(t), 'site copy is 합니다체 / ~해 주세요: ' + t);
console.log('quick replies check ok');
