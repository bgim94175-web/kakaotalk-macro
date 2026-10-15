// 무료 회원(members.comp) 점검: 매크로 판정 · sender 로 밀 만료 · 시드 · 패널·관리자 경로
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const E = require('./entitle');

const now = Date.now();
const v = E.macroView({ comp: true, macro_until: 0 }, now);
assert.ok(v.active && v.comp && v.until === E.COMP_UNTIL && v.days_left > 25000, 'comp member: macro active without payment');
assert.strictEqual(E.macroUntilOf({ comp: true, macro_until: now + 1000 }), E.COMP_UNTIL, 'comp wins over paid days');
assert.strictEqual(E.macroUntilOf({ comp: false, macro_until: 123 }), 123, 'comp off → paid days');
assert.strictEqual(E.macroUntilOf({ comp: null, macro_until: 0 }), 0, 'never set → not comp');
assert.ok(!E.macroView({ comp: 'true', macro_until: 0 }, now).active, 'only boolean true counts');
assert.strictEqual(E.macroUntilOf(null), 0, 'no member');

const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const db = read('lib/db.js');
assert.ok(/ADD COLUMN IF NOT EXISTS comp BOOLEAN/.test(db) && /SET comp=TRUE WHERE lower\(login_id\)='mjl870' AND comp IS NULL/.test(db), 'comp column + one-time seed for mjl870');
const panel = read('routes/panel.js');
assert.ok(/\/panel\/api\/bot-room\/free-add/.test(panel) && /m\.comp !== true/.test(panel) && /installs\.grantRoom\(/.test(panel), 'free-add only for comp members, via grantRoom');
assert.ok(/entitle\.macroUntilOf\(m\) > now/.test(panel), 'account registration honours comp');
const admin = read('routes/admin.js');
assert.ok(/\/admin\/member-comp/.test(admin) && /typeof b\.on !== 'boolean'/.test(admin), 'admin toggle');
const ent = read('lib/entitle.js');
assert.ok(/macro_until: macroUntilOf\(row\)/.test(ent) && /m\.comp, m\.blocked_reason AS m_blocked/.test(ent), 'grants pushed to sender honour comp (blocked still wins)');
console.log('comp check ok');
