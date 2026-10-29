'use strict';

const { createHash } = require('node:crypto');
const { TextDecoder } = require('node:util');

const MAX_FILE_BYTES = 256 * 1024;
const RESERVED = '<<<YESORNOT_';
const INVALID_CONTROLS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

function fail(message) {
  throw new Error(`질문지: ${message}`);
}

function normalizeText(value) {
  return value.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
}

function checkedText(value, label, limit) {
  if (typeof value !== 'string' || value.length > limit || !value.isWellFormed() || INVALID_CONTROLS.test(value) || /\r(?!\n)/.test(value)) {
    fail(`${label} 형식이나 길이가 올바르지 않습니다.`);
  }
  return value.replace(/\r\n/g, '\n');
}

function questionnaire(record) {
  if (!record || record.status !== 'awaiting_input' || typeof record.id !== 'string' || !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(record.id)) {
    fail('추가 답변을 기다리는 현재 판단의 질문지만 사용할 수 있습니다.');
  }
  const questions = record.preparation?.questions;
  if (!Array.isArray(questions) || questions.length > 48) fail('현재 질문 목록이 올바르지 않습니다.');
  const ids = new Set();
  const entries = questions.map(item => {
    if (!item || typeof item.id !== 'string' || !/^[a-z][a-z0-9_-]{0,63}$/i.test(item.id) || ids.has(item.id) || typeof item.required !== 'boolean') {
      fail('질문 번호 또는 필수 여부가 올바르지 않습니다.');
    }
    ids.add(item.id);
    return {
      id: item.id,
      question: checkedText(item.question, '질문', 4000),
      required: item.required,
      why: checkedText(item.why ?? '', '질문 이유', 4000),
      material: checkedText(item.material ?? '', '자료 안내', 4000),
    };
  });
  const original = checkedText(record.question, '원래 질문', 4000);
  const fingerprint = createHash('sha256').update(JSON.stringify({ question: original, questions: entries })).digest('hex');
  return { id: record.id, original, entries, ids, fingerprint };
}

function display(value) {
  return value.replaceAll(RESERVED, '＜＜＜YESORNOT_');
}

function staticParts(data) {
  const parts = [
    'YESORNOT 사전 질문지 · 형식 1\n' +
    '답변 시작과 끝 표시 사이만 작성하세요. 여러 줄로 입력할 수 있습니다.\n' +
    '나머지 문구와 질문 번호는 수정하지 마세요. 빈 답변은 기존 입력을 지우지 않습니다.\n' +
    '필수 질문의 답을 모르면 “모름”과 알고 있는 내용을 적어 주세요.\n' +
    '이 파일에는 개인 정보가 포함될 수 있으므로 보관과 공유에 유의해 주세요.\n\n' +
    `판단 ID: ${data.id}\n질문지 확인값: ${data.fingerprint}\n\n` +
    `원래 질문:\n${display(data.original)}\n`,
  ];
  data.entries.forEach((entry, index) => {
    parts[parts.length - 1] += `\n────────────────────────────────────────\n질문 ${index + 1} (${entry.id}) · ${entry.required ? '필수' : '선택'}\n` +
      `${display(entry.question)}\n질문 이유: ${display(entry.why) || '별도 안내 없음'}\n` +
      `자료 안내: ${display(entry.material) || '별도 안내 없음'}\n` +
      `<<<YESORNOT_ANSWER_BEGIN:${entry.id}>>>\n`;
    parts.push(`\n<<<YESORNOT_ANSWER_END:${entry.id}>>>\n`);
  });
  parts[parts.length - 1] += '\n질문지 끝\n';
  return parts;
}

function checkedAnswer(value) {
  const answer = checkedText(value, '답변 (질문당 최대 4,000자)', 4000);
  if (answer.includes(RESERVED)) fail('답변에 질문지 구분 표시를 넣을 수 없습니다.');
  return answer;
}

function checkSize(text) {
  if (Buffer.byteLength(text, 'utf8') > MAX_FILE_BYTES) fail('파일은 256 KiB 이하여야 합니다.');
}

function exportQuestionnaire(record, answers = {}) {
  const data = questionnaire(record);
  if (!answers || typeof answers !== 'object' || Array.isArray(answers) || ![Object.prototype, null].includes(Object.getPrototypeOf(answers))) {
    fail('답변 목록이 올바르지 않습니다.');
  }
  const values = Object.create(null);
  for (const [id, answer] of Object.entries(answers)) {
    if (!data.ids.has(id)) fail('현재 질문에 없는 답변이 포함되어 있습니다.');
    values[id] = checkedAnswer(answer);
  }
  const parts = staticParts(data);
  let result = parts[0];
  data.entries.forEach((entry, index) => { result += (values[entry.id] ?? '') + parts[index + 1]; });
  result = result.replace(/\n/g, '\r\n');
  checkSize(result);
  return result;
}

function parseQuestionnaire(record, text) {
  const data = questionnaire(record);
  if (typeof text !== 'string') fail('텍스트 질문지 파일을 선택해 주세요.');
  checkSize(text);
  const normalized = checkedText(normalizeText(text), '파일 내용', MAX_FILE_BYTES).replace(/\n+$/, '');
  const parts = staticParts(data);
  parts[parts.length - 1] = parts.at(-1).replace(/\n+$/, '');
  if (!normalized.startsWith(parts[0])) fail('다른 판단의 질문지이거나 질문·안내 문구가 변경되었습니다. 현재 질문지를 다시 내려받아 주세요.');
  let offset = parts[0].length;
  const answers = {};
  data.entries.forEach((entry, index) => {
    const end = normalized.indexOf(`\n<<<YESORNOT_ANSWER_END:${entry.id}>>>`, offset);
    if (end < 0) fail('답변 끝 표시가 없거나 변경되었습니다.');
    const answer = checkedAnswer(normalized.slice(offset, end));
    const next = parts[index + 1];
    if (!normalized.startsWith(next, end)) fail('질문 순서·구분 표시·안내 문구가 변경되었습니다.');
    if (answer.trim()) Object.defineProperty(answers, entry.id, { value: answer, enumerable: true, writable: true, configurable: true });
    offset = end + next.length;
  });
  if (offset !== normalized.length) fail('질문지 끝에 알 수 없는 내용이나 중복 질문이 있습니다.');
  return answers;
}

function decodeQuestionnaire(buffer) {
  if (!Buffer.isBuffer(buffer) || !buffer.length) fail('비어 있지 않은 텍스트 파일을 선택해 주세요.');
  if (buffer.length > MAX_FILE_BYTES) fail('파일은 256 KiB 이하여야 합니다.');
  let encoding = 'utf-8';
  let bytes = buffer;
  if (buffer[0] === 0xff && buffer[1] === 0xfe) { encoding = 'utf-16le'; bytes = buffer.subarray(2); }
  else if (buffer[0] === 0xfe && buffer[1] === 0xff) { encoding = 'utf-16be'; bytes = buffer.subarray(2); }
  let text;
  try { text = new TextDecoder(encoding, { fatal: true }).decode(bytes); }
  catch { fail('파일 인코딩을 읽을 수 없습니다. UTF-8 또는 BOM이 있는 UTF-16 텍스트로 저장해 주세요.'); }
  return checkedText(normalizeText(text), '파일 내용', MAX_FILE_BYTES);
}

module.exports = { exportQuestionnaire, parseQuestionnaire, decodeQuestionnaire, MAX_FILE_BYTES };
