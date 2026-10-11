'use strict';
// 운영 한도(lib/settings.js): 기본값·범위 검사·저장·다시 읽기. DB 는 메모리 표로 바꿔 끼운다.

const Module = require('module');
const path = require('path');

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

const rows = new Map();   // key → value(JSON 으로 저장한 값)
const db = {
  async q(sql, args) {
    if (/^SELECT key, value FROM app_settings/.test(sql)) {
      return { rows: [...rows.entries()].map(([key, value]) => ({ key, value: JSON.parse(value) })) };
    }
    if (/^INSERT INTO app_settings/.test(sql)) {
      rows.set(args[0], args[1]);
      return { rowCount: 1 };
    }
    throw new Error('db.q 시험 대상 아님: ' + sql);
  },
};
const origLoad = Module._load;
Module._load = function (request, parent) {
  if (request === './db' && parent && parent.filename === path.join(__dirname, 'settings.js')) return db;
  return origLoad.apply(this, arguments);
};
delete process.env.BOT_ROOM_CAP;
process.env.MEMBER_MAX_ACCOUNTS = '5';
delete process.env.MEMBER_MAX_SESSIONS;
const settings = require('./settings');
Module._load = origLoad;

(async () => {
  // 저장한 값이 없으면 환경 변수 → 코드 기본값
  assert(settings.get('bot_room_cap') === 20, 'bot_room_cap 기본 20');
  assert(settings.get('kakao_accounts') === 5, 'kakao_accounts 는 예전 환경 변수(5)를 기본값으로');
  assert(settings.get('sessions') === 3, 'sessions 기본 3');
  let threw = false;
  try { settings.get('nope'); } catch (e) { threw = true; }
  assert(threw, '모르는 설정은 읽을 수 없다');

  // 범위 검사
  assert(settings.problem('sessions', 0) === '동시 로그인 기기 수는 1~10대로 입력해 주세요.', 'sessions 0 거절 문구');
  assert(settings.problem('bot_room_cap', 201), 'bot_room_cap 201 거절');
  assert(settings.problem('kakao_accounts', 2.5), '소수 거절');
  assert(settings.problem('kakao_accounts', NaN), '빈 값 거절');
  assert(settings.problem('nope', 1), '모르는 설정 거절');
  assert(settings.problem('kakao_accounts', 20) === null && settings.problem('bot_room_cap', 1) === null, '경계값 허용');

  // 저장: 하나라도 틀리면 아무것도 저장하지 않는다
  let code = '';
  try { await settings.save({ kakao_accounts: 2, sessions: 99 }); } catch (e) { code = e.code; }
  assert(code === 'bad_setting' && rows.size === 0 && settings.get('kakao_accounts') === 5, '틀린 값이 있으면 저장하지 않는다');
  const changed = await settings.save({ kakao_accounts: 2, sessions: 3 });
  assert(settings.get('kakao_accounts') === 2 && settings.get('sessions') === 3, '저장하면 바로 읽힌다');
  assert(changed.length === 1 && changed[0].key === 'kakao_accounts' && changed[0].from === 5 && changed[0].to === 2,
    '바뀐 항목만 돌려준다 ' + JSON.stringify(changed));

  // 다시 읽기: DB 값을 쓰고, 범위 밖 값은 무시하고 기본값으로
  rows.set('bot_room_cap', JSON.stringify(30));
  rows.set('sessions', JSON.stringify(500));
  await settings.load();
  assert(settings.get('bot_room_cap') === 30, 'DB 값을 읽는다');
  assert(settings.get('sessions') === 3, '범위 밖 DB 값은 무시한다');
  const v = settings.view();
  assert(v.length === 3 && v.every((x) => x.label && x.min >= 1 && x.max > x.min && typeof x.value === 'number'), 'view 모양');
  const k = v.find((x) => x.key === 'kakao_accounts');
  assert(k.value === 2 && k.default === 5 && k.saved === true && k.unit === '개', 'view 값·기본값·저장 여부');

  process.stdout.write('settings check ok\n');
})().catch((e) => {
  process.stderr.write('settings check FAILED: ' + (e && e.stack ? e.stack : e) + '\n');
  process.exit(1);
});
