'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createQuestionnaireFiles } = require('../services/questionnaire-files.cjs');
const { exportQuestionnaire, MAX_FILE_BYTES } = require('../services/questionnaire.cjs');
const record = () => ({ id: 'cb615eb2-7d1a-4dad-8009-6d54f8e8d84b', question: '가상 결정을 검토해 주세요.', status: 'awaiting_input', preparation: { questions: [
  { id: 'q1', question: '예산은 얼마인가요?', why: '개인 조건', material: '예산표', required: true },
  { id: 'q2', question: '기한은 언제인가요?', why: '의사결정 범위', material: '', required: false },
] } });

async function fixture(t, options = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'yesornot-questionnaire-test-'));
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('yesornot-questionnaire-test-'));
    await fs.rm(directory, { recursive: true, force: true });
  });
  const file = path.join(directory, '질문지.txt');
  let current = record();
  const api = createQuestionnaireFiles({ getActive: () => structuredClone(current), chooseSaveFile: async () => file, chooseOpenFile: async () => file, ...options });
  return { api, file, current: () => current, setCurrent: value => { current = value; } };
}

test('native file bridge saves current partial answers and imports only filled blocks without executing research', async t => {
  const state = await fixture(t);
  assert.deepEqual(await state.api.download({ runId: state.current().id, answers: { q1: '가상 예산 1억원\n다음 달 확인' } }), { canceled: false, questionCount: 2 });
  const imported = await state.api.upload({ runId: state.current().id });
  assert.deepEqual(imported.answers, { q1: '가상 예산 1억원\n다음 달 확인' });
  assert.equal(imported.answerCount, 1); assert.equal(imported.canceled, false);
  assert.equal(state.current().status, 'awaiting_input');
});

test('canceling either file dialog is reversible and makes no file changes', async t => {
  const state = await fixture(t, { chooseSaveFile: async () => null, chooseOpenFile: async () => null });
  assert.deepEqual(await state.api.download({ runId: state.current().id }), { canceled: true });
  assert.deepEqual(await state.api.upload({ runId: state.current().id }), { canceled: true });
  await assert.rejects(fs.stat(state.file), { code: 'ENOENT' });
});

test('file IO failures hide OS paths and release the file operation lock', async t => {
  const state = await fixture(t);
  await assert.rejects(state.api.upload({ runId: state.current().id }), error => {
    assert.match(error.message, /파일을 읽거나 저장하지 못했습니다/);
    assert.ok(!error.message.includes(state.file));
    return true;
  });
  await state.api.download({ runId: state.current().id, answers: { q1: '다시 저장' } });
  assert.equal((await state.api.upload({ runId: state.current().id })).answers.q1, '다시 저장');
});

test('wrong active run or canceled intake cannot export or import answers', async t => {
  const state = await fixture(t);
  await assert.rejects(state.api.download({ runId: 'wrong' }), /답변 대기/);
  state.current().status = 'canceled';
  await assert.rejects(state.api.upload({ runId: state.current().id }), /답변 대기/);
});

test('a native file dialog cannot apply to a run that ended or changed while open', async t => {
  let release;
  const state = await fixture(t, { chooseSaveFile: () => new Promise(resolve => { release = resolve; }) });
  const downloading = state.api.download({ runId: state.current().id });
  state.current().status = 'canceled'; release(state.file);
  await assert.rejects(downloading, /답변 대기/);
  await assert.rejects(fs.stat(state.file), { code: 'ENOENT' });
  let releaseUpload;
  const other = await fixture(t, { chooseOpenFile: () => new Promise(resolve => { releaseUpload = resolve; }) });
  await fs.writeFile(other.file, exportQuestionnaire(other.current(), { q1: '가상 답변' }));
  const uploading = other.api.upload({ runId: other.current().id });
  other.current().preparation.questions[0].question = '질문 변경'; releaseUpload(other.file);
  await assert.rejects(uploading, /변경/);
});

test('concurrent dialogs are refused and the file lock clears after cancellation', async t => {
  let release;
  const state = await fixture(t, { chooseSaveFile: () => new Promise(resolve => { release = resolve; }) });
  const first = state.api.download({ runId: state.current().id });
  await assert.rejects(state.api.upload({ runId: state.current().id }), /먼저 완료/);
  release(null); await first;
  const next = state.api.download({ runId: state.current().id }); release(null);
  assert.deepEqual(await next, { canceled: true });
});

test('oversized, wrong-format and foreign-run imports fail without changing current answers', async t => {
  const state = await fixture(t);
  await fs.writeFile(state.file, Buffer.alloc(MAX_FILE_BYTES + 1, 65));
  await assert.rejects(state.api.upload({ runId: state.current().id }), /256/);
  await fs.writeFile(state.file, '<script>doNotExecute()</script>');
  await assert.rejects(state.api.upload({ runId: state.current().id }));
  const other = record(); other.id = '538368b0-8d53-4fcd-af8e-c52991a036bf';
  await fs.writeFile(state.file, exportQuestionnaire(other, { q1: '다른 판단의 답변' }));
  await assert.rejects(state.api.upload({ runId: state.current().id }));
  assert.equal(state.current().answers, undefined);
});
