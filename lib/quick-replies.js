// 받은 갠톡의 빠른 답장 버튼(회원마다). 버튼을 누르면 정해 둔 글을 그 대화에 바로 보낸다.
// members.quick_replies(JSONB) 에 [{ label, text }] 로 저장한다. 순서 = 화면의 버튼 순서.
'use strict';

const MAX_ITEMS = 12;
const MAX_LABEL = 16;
const MAX_TEXT = 1000;

const TEXT = {
  bad: '빠른 답장 형식이 올바르지 않습니다.',
  too_many: '빠른 답장은 ' + MAX_ITEMS + '개까지 만들 수 있습니다.',
  no_label: '버튼 이름을 입력해 주세요.',
  long_label: '버튼 이름은 ' + MAX_LABEL + '자까지 입력할 수 있습니다.',
  no_text: '보낼 메시지를 입력해 주세요.',
  long_text: '보낼 메시지는 ' + MAX_TEXT + '자까지 입력할 수 있습니다.',
  dup: '같은 이름의 버튼이 있습니다. 이름을 다르게 입력해 주세요.',
};

// 처음 쓰는 사람에게 보여 주는 예시(저장 전까지는 이 목록)
const DEFAULTS = Object.freeze([
  Object.freeze({ label: '인사', text: '안녕하세요! 문의 주셔서 감사합니다.' }),
  Object.freeze({ label: '확인 중', text: '확인하고 바로 답변드릴게요. 잠시만 기다려 주세요.' }),
  Object.freeze({ label: '감사', text: '감사합니다. 좋은 하루 보내세요!' }),
]);

function oneLine(s) {
  return String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
}
function body(s) {
  return String(s == null ? '' : s).replace(/\r\n?/g, '\n').replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, '').trim();
}

/** 저장된 값 → 화면에 줄 목록(망가진 칸은 버린다). 저장한 적 없으면(null) 예시 */
function readStored(v) {
  if (v == null) return DEFAULTS.map((x) => ({ label: x.label, text: x.text }));
  const list = Array.isArray(v) ? v : [];
  const out = [];
  for (const it of list) {
    if (!it || typeof it !== 'object') continue;
    const label = oneLine(it.label).slice(0, MAX_LABEL);
    const text = body(it.text).slice(0, MAX_TEXT);
    if (label && text) out.push({ label, text });
    if (out.length >= MAX_ITEMS) break;
  }
  return out;
}

/** 저장 요청 검사 → { ok:true, items } | { ok:false, error } */
function validate(items) {
  if (!Array.isArray(items)) return { ok: false, error: TEXT.bad };
  if (items.length > MAX_ITEMS) return { ok: false, error: TEXT.too_many };
  const out = [];
  const seen = new Set();
  for (const it of items) {
    if (!it || typeof it !== 'object' || Array.isArray(it)) return { ok: false, error: TEXT.bad };
    if (typeof it.label !== 'string' || typeof it.text !== 'string') return { ok: false, error: TEXT.bad };
    const label = oneLine(it.label);
    const text = body(it.text);
    if (!label) return { ok: false, error: TEXT.no_label };
    if ([...label].length > MAX_LABEL) return { ok: false, error: TEXT.long_label };
    if (!text) return { ok: false, error: TEXT.no_text };
    if (text.length > MAX_TEXT) return { ok: false, error: TEXT.long_text };
    if (seen.has(label)) return { ok: false, error: TEXT.dup };
    seen.add(label);
    out.push({ label, text });
  }
  return { ok: true, items: out };
}

module.exports = { MAX_ITEMS, MAX_LABEL, MAX_TEXT, TEXT, DEFAULTS, readStored, validate };
