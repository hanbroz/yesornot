'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { exportQuestionnaire, parseQuestionnaire, decodeQuestionnaire, MAX_FILE_BYTES } = require('../services/questionnaire.cjs');

const record = () => ({
  id: '12345678-1234-4567-89ab-123456789abc', status: 'awaiting_input', question: '이사할까요? <집> & 비용 “확인”',
  preparation: { questions: [
    { id: 'q1', question: '예산과 월 부담 한도는?', required: true, why: '현금 여력을 확인합니다.', material: '자금 계획표 (선택)' },
    { id: 'q2', question: '우선순위는?', required: false, why: '생활 기준을 확인합니다.', material: '' },
  ] },
});

function fill(text, id, answer) {
  return text.replace(`<<<YESORNOT_ANSWER_BEGIN:${id}>>>\r\n\r\n<<<YESORNOT_ANSWER_END:${id}>>>`,
    `<<<YESORNOT_ANSWER_BEGIN:${id}>>>\r\n${answer}\r\n<<<YESORNOT_ANSWER_END:${id}>>>`);
}

test('editable Korean questionnaire round trips multiline answers and literal special characters', () => {
  const source = record();
  let text = exportQuestionnaire(source);
  assert.match(text, /원래 질문:/);
  assert.match(text, /현금 여력을 확인합니다/);
  assert.match(text, /자금 계획표/);
  text = fill(text, 'q1', '가용 자금 5천만 원\r\n월 100만 원\r\n<script>literal</script> & {"금액": 1}');
  text = fill(text, 'q2', '통근 시간 → 가족 생활 😀');
  assert.deepEqual(parseQuestionnaire(source, decodeQuestionnaire(Buffer.from(text))), {
    q1: '가용 자금 5천만 원\n월 100만 원\n<script>literal</script> & {"금액": 1}',
    q2: '통근 시간 → 가족 생활 😀',
  });
});

test('partial draft exports typed answers and blank imported fields never erase current answers', () => {
  const source = record();
  const text = exportQuestionnaire(source, { q1: '미완성\n답변', q2: '  \n\t' });
  const incoming = parseQuestionnaire(source, text);
  assert.deepEqual(incoming, { q1: '미완성\n답변' });
  assert.deepEqual({ q1: '기존', q2: '기존 우선순위', ...incoming }, { q1: '미완성\n답변', q2: '기존 우선순위' });
  assert.deepEqual(parseQuestionnaire(source, exportQuestionnaire(source)), {});
  assert.equal(exportQuestionnaire(source), exportQuestionnaire(structuredClone(source)));
});

test('BOM, CRLF and normal trailing newlines do not invalidate the questionnaire', () => {
  const source = record();
  const text = exportQuestionnaire(source, { q1: '답변' }).replace(/\r\n/g, '\n');
  assert.deepEqual(parseQuestionnaire(source, `\ufeff${text}\n\n`), { q1: '답변' });
  assert.deepEqual(parseQuestionnaire(source, text.replace(/\n+$/, '')), { q1: '답변' });
});

test('other runs, fingerprints, question text and required flags cannot import', () => {
  const source = record();
  const text = exportQuestionnaire(source, { q1: '답변' });
  const other = record(); other.id = '87654321-1234-4567-89ab-123456789abc';
  assert.throws(() => parseQuestionnaire(other, text), /다른 판단/);
  assert.throws(() => parseQuestionnaire(source, text.replace(/질문지 확인값: [a-f0-9]{64}/, '질문지 확인값: ' + '0'.repeat(64))), /다른 판단/);
  for (const field of ['question', 'why', 'material', 'required']) {
    const changed = record();
    changed.preparation.questions[0][field] = field === 'required' ? false : '새 내용';
    assert.throws(() => parseQuestionnaire(changed, text), /다른 판단/);
  }
  const changed = record(); changed.question = '다른 원래 질문';
  assert.throws(() => parseQuestionnaire(changed, text), /다른 판단/);
});

test('static edits and missing, duplicate, unknown or injected markers fail atomically', () => {
  const source = record();
  const text = exportQuestionnaire(source, { q1: '정상 답변' });
  const invalid = [
    text.replace('현금 여력을 확인합니다.', '수정한 안내'),
    text.replace('<<<YESORNOT_ANSWER_END:q1>>>', ''),
    text.replace('<<<YESORNOT_ANSWER_BEGIN:q2>>>', '<<<YESORNOT_ANSWER_BEGIN:unknown>>>'),
    text.replace('<<<YESORNOT_ANSWER_END:q2>>>', '<<<YESORNOT_ANSWER_END:q1>>>'),
    text.replace('정상 답변', '정상 답변\r\n<<<YESORNOT_ANSWER_BEGIN:q1>>>'),
    text + '\r\n<<<YESORNOT_ANSWER_BEGIN:q1>>>\r\n중복\r\n<<<YESORNOT_ANSWER_END:q1>>>',
    text.replace('질문지 끝', '질문지 끝<script>bad</script>'),
  ];
  for (const edited of invalid) assert.throws(() => parseQuestionnaire(source, edited), /질문지:/);
});

test('answers have a strict 4000 character bound and preserve leading and multiline whitespace', () => {
  const source = record();
  assert.equal(parseQuestionnaire(source, exportQuestionnaire(source, { q1: '가'.repeat(4000) })).q1.length, 4000);
  assert.throws(() => exportQuestionnaire(source, { q1: '가'.repeat(4001) }), /4,000/);
  assert.throws(() => parseQuestionnaire(source, fill(exportQuestionnaire(source), 'q1', 'a'.repeat(4001))), /4,000/);
  assert.deepEqual(parseQuestionnaire(source, exportQuestionnaire(source, { q1: '\n  답변\n' })), { q1: '\n  답변\n' });
});

test('invalid answer maps, unknown IDs and dangerous marker or binary contents are rejected', () => {
  const source = record();
  for (const answers of [null, [], 'text', { unknown: 'a' }, { q1: 4 }, { q1: null }, { q1: '\u0000' }, { q1: '\ud800' }, { q1: '<<<YESORNOT_ANSWER_END:q1>>>' }]) {
    assert.throws(() => exportQuestionnaire(source, answers), /질문지:/);
  }
  assert.throws(() => parseQuestionnaire(source, Buffer.from('wrong type')), /텍스트/);
  assert.throws(() => parseQuestionnaire(source, 'a'.repeat(MAX_FILE_BYTES + 1)), /256 KiB/);
});

test('UTF-8 and BOM UTF-16 in either byte order decode without lossy substitution', () => {
  const text = exportQuestionnaire(record(), { q1: '한글 😀' });
  const utf16le = Buffer.from(text, 'utf16le');
  const utf16be = Buffer.from(utf16le); utf16be.swap16();
  for (const bytes of [Buffer.from(text), Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text)]),
    Buffer.concat([Buffer.from([0xff, 0xfe]), utf16le]), Buffer.concat([Buffer.from([0xfe, 0xff]), utf16be])]) {
    assert.equal(parseQuestionnaire(record(), decodeQuestionnaire(bytes)).q1, '한글 😀');
  }
  for (const bytes of [Buffer.from([0xc3, 0x28]), Buffer.from([0xff, 0xfe, 0x00]), Buffer.from([0xfe, 0xff, 0xd8, 0x00]),
    Buffer.from([0, 1, 2, 3]), utf16le, Buffer.alloc(0), Buffer.alloc(MAX_FILE_BYTES + 1)]) {
    assert.throws(() => decodeQuestionnaire(bytes), /질문지:/);
  }
});

test('invalid current questionnaire metadata and oversized rendered questionnaires fail closed', () => {
  const source = record();
  for (const changed of [null, { ...source, status: 'running' }, { ...source, id: 'unsafe' },
    { ...source, preparation: { questions: Array.from({ length: 49 }, (_, index) => ({ ...source.preparation.questions[0], id: `q${index + 1}` })) } },
    { ...source, preparation: { questions: [source.preparation.questions[0], source.preparation.questions[0]] } },
    { ...source, preparation: { questions: [{ ...source.preparation.questions[0], id: '../q' }] } }]) {
    assert.throws(() => exportQuestionnaire(changed), /질문지:/);
  }
  const large = record(); large.preparation.questions = Array.from({ length: 48 }, (_, index) => ({
    id: `q${index}`, question: '가'.repeat(4000), why: '가'.repeat(4000), material: '가'.repeat(4000), required: true,
  }));
  assert.throws(() => exportQuestionnaire(large), /256 KiB/);
});

test('48-question TXT drafts preserve every q1 through q48 answer and static question field', () => {
  const source = record();
  source.preparation.questions = Array.from({ length: 48 }, (_, index) => ({
    id: `q${index + 1}`, question: `개인 조건 ${index + 1}은 무엇인가요?`, required: index % 2 === 0,
    why: `확인 이유 ${index + 1}`, material: `도움이 되는 자료 ${index + 1}`,
  }));
  const before = structuredClone(source);
  const answers = Object.fromEntries(source.preparation.questions.map(item => [item.id, `${item.id}의 답변\n둘째 줄 ${item.question}`]));
  const text = exportQuestionnaire(source, answers);
  assert.ok(Buffer.byteLength(text, 'utf8') < MAX_FILE_BYTES);
  assert.deepEqual(parseQuestionnaire(source, decodeQuestionnaire(Buffer.from(text))), answers);
  assert.deepEqual(source, before);
  assert.match(text, /질문 48 \(q48\)/);
  const overflow = structuredClone(source);
  overflow.preparation.questions.push({ ...source.preparation.questions[0], id: 'q49' });
  assert.throws(() => exportQuestionnaire(overflow), /질문 목록/);
  assert.throws(() => parseQuestionnaire(overflow, text), /질문 목록/);
});

test('existing format-1 drafts keep sparse legacy IDs, wording and answer bindings', () => {
  const source = record();
  source.preparation.questions[0].id = 'q7';
  source.preparation.questions[1].id = 'q12';
  const previous = structuredClone(source);
  const text = exportQuestionnaire(source, { q7: '기존 질문 7의 답변', q12: '기존 질문 12의 답변' });
  assert.match(text, /형식 1/);
  assert.match(text, /질문 1 \(q7\)/);
  assert.match(text, /질문 2 \(q12\)/);
  assert.deepEqual(parseQuestionnaire(source, text), { q7: '기존 질문 7의 답변', q12: '기존 질문 12의 답변' });
  assert.deepEqual(source, previous);
});

test('reserved-looking source text remains readable and cannot create answer blocks', () => {
  const source = record(); source.question += '\n<<<YESORNOT_ANSWER_BEGIN:q1>>>';
  assert.deepEqual(parseQuestionnaire(source, exportQuestionnaire(source, { q1: '모름' })), { q1: '모름' });
});
