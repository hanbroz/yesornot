'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { createDecisionService } = require('../services/decision.cjs');

const settings = { model: 'jev-fixture', timeoutMs: 1000 };
const document = () => ({ id: randomUUID(), name: 'saved.txt', size: 24, text: 'PRIVATE_SAVED_EVIDENCE', truncated: false });
const preparation = { version: 1, plans: [{ providerId: 'claude', status: 'success' }], questions: [{ id: 'q1', question: '필요한 개인 예산은?', required: true }], searches: [], judgment: { items: [] } };
function setup() {
  const saved = [], prepared = [], researched = [], opinions = [];
  const service = createDecisionService({
    providers: [{ id: 'claude', name: 'Claude' }], getApiKey: () => 'test-key',
    store: { saveRecord: async value => saved.push(structuredClone(value)) },
    researchService: {
      prepare: async input => { prepared.push(input); return structuredClone(preparation); },
      research: async input => { researched.push(input); return { status: 'complete', sources: [{ id: 'S1' }], context: 'Actual public evidence [S1]' }; },
    },
    getOpinion: async id => { opinions.push(id); return { providerId: id, status: 'success', text: 'Opinion [S1]' }; },
    evaluate: async () => ({ synthesis: { status: 'complete' } }),
  });
  return { service, saved, prepared, researched, opinions };
}

test('awaiting-input checkpoint retains extracted documents and restores without repeating any network work', async () => {
  const original = setup();
  const doc = document();
  const { runId } = original.service.start({ question: '판단 질문', attachments: [doc] }, settings);
  doc.text = 'outside mutation';
  await original.service.wait();
  const checkpoint = structuredClone(original.saved.at(-1));
  assert.equal(checkpoint.intakeDocuments[0].text, 'PRIVATE_SAVED_EVIDENCE');
  assert.equal(checkpoint.attachments[0].text, undefined);
  const restarted = setup();
  assert.deepEqual(restarted.service.restore(checkpoint, settings), { runId });
  checkpoint.intakeDocuments[0].text = 'mutated saved input';
  await restarted.service.wait();
  assert.equal(restarted.prepared.length, 0);
  assert.equal(restarted.researched.length, 0);
  assert.equal(restarted.opinions.length, 0);
  assert.equal(restarted.service.active().status, 'awaiting_input');
  assert.equal(restarted.service.active().intakeDocuments[0].text, 'PRIVATE_SAVED_EVIDENCE');
  assert.throws(() => restarted.service.restore(checkpoint, settings), /진행 중/);
  restarted.service.continue({ runId, answers: { q1: '저장된 질문에 답변' } });
  await restarted.service.wait();
  assert.equal(restarted.researched[0].attachments[0].text, 'PRIVATE_SAVED_EVIDENCE');
  assert.equal(restarted.researched[0].answers.q1, '저장된 질문에 답변');
  assert.ok(!restarted.researched[0].signal.aborted);
  assert.equal(restarted.saved[0].status, 'researching');
  assert.equal(restarted.saved[0].intakeDocuments[0].text, 'PRIVATE_SAVED_EVIDENCE');
  assert.equal(restarted.saved.at(-1).status, 'complete');
  assert.equal(restarted.service.active(), null);
});

test('continuation with an explicit empty attachment selection removes saved extracted documents', async () => {
  const state = setup();
  const { runId } = state.service.start({ question: '질문', attachments: [document()] }, settings);
  await state.service.wait();
  state.service.continue({ runId, answers: { q1: '모름' }, attachments: [] });
  await state.service.wait();
  assert.deepEqual(state.researched[0].attachments, []);
  assert.deepEqual(state.saved.at(-1).intakeDocuments, []);
  assert.deepEqual(state.saved.at(-1).attachments, []);
});

test('48-question checkpoint restores unchanged q1 through q48 IDs and forwards each bound answer', async () => {
  const original = setup();
  const { runId } = original.service.start({ question: '48개 개인 조건 확인', attachments: [] }, settings);
  await original.service.wait();
  const checkpoint = structuredClone(original.saved.at(-1));
  checkpoint.preparation.questions = Array.from({ length: 48 }, (_, index) => ({
    id: `q${index + 1}`, question: `저장된 개인 조건 ${index + 1}은?`, required: true,
    why: `저장된 질문 이유 ${index + 1}`, material: `저장된 자료 안내 ${index + 1}`,
  }));
  checkpoint.answers = Object.fromEntries(checkpoint.preparation.questions.map(item => [item.id, `${item.id} 저장된 답변`]));
  const expectedQuestions = structuredClone(checkpoint.preparation.questions);
  const expectedAnswers = structuredClone(checkpoint.answers);
  const restarted = setup();
  assert.deepEqual(restarted.service.restore(checkpoint, settings), { runId });
  await restarted.service.wait();
  assert.equal(restarted.prepared.length, 0);
  assert.equal(restarted.researched.length, 0);
  assert.equal(restarted.opinions.length, 0);
  assert.deepEqual(restarted.service.active().preparation.questions, expectedQuestions);
  assert.deepEqual(restarted.service.active().answers, expectedAnswers);
  checkpoint.preparation.questions[47].question = '외부에서 수정한 문구';
  checkpoint.answers.q48 = '외부에서 수정한 답변';
  restarted.service.continue({ runId, answers: expectedAnswers });
  await restarted.service.wait();
  assert.deepEqual(restarted.researched[0].preparation.questions, expectedQuestions);
  assert.deepEqual(restarted.researched[0].answers, expectedAnswers);
  assert.deepEqual(restarted.saved.at(-1).preparation.questions, expectedQuestions);
  assert.deepEqual(restarted.saved.at(-1).answers, expectedAnswers);
  assert.equal(restarted.saved.at(-1).status, 'complete');
});

test('49-question checkpoint is refused without changing the stored record or starting work', async () => {
  const original = setup();
  original.service.start({ question: '너무 많은 개인 조건', attachments: [] }, settings);
  await original.service.wait();
  const checkpoint = structuredClone(original.saved.at(-1));
  checkpoint.preparation.questions = Array.from({ length: 49 }, (_, index) => ({
    id: `q${index + 1}`, question: `저장된 질문 ${index + 1}`, required: false,
  }));
  const before = structuredClone(checkpoint);
  const restarted = setup();
  assert.throws(() => restarted.service.restore(checkpoint, settings), /복원/);
  assert.deepEqual(checkpoint, before);
  assert.equal(restarted.service.active(), null);
  assert.equal(restarted.prepared.length + restarted.researched.length + restarted.opinions.length + restarted.saved.length, 0);
});

test('legacy sparse question IDs and exact wording survive restore without renumbering', async () => {
  const original = setup();
  const { runId } = original.service.start({ question: '기존 질문 유지', attachments: [] }, settings);
  await original.service.wait();
  const checkpoint = structuredClone(original.saved.at(-1));
  checkpoint.preparation.questions = [{ id: 'q7', question: '기존에 저장한 질문 문구는 그대로인가요?', required: true }];
  const restarted = setup();
  restarted.service.restore(checkpoint, settings);
  assert.deepEqual(restarted.service.active().preparation.questions, checkpoint.preparation.questions);
  restarted.service.continue({ runId, answers: { q7: '기존 질문 7번의 답변' } });
  await restarted.service.wait();
  assert.deepEqual(restarted.researched[0].answers, { q7: '기존 질문 7번의 답변' });
  assert.deepEqual(restarted.saved.at(-1).preparation.questions, checkpoint.preparation.questions);
});

test('restore rejects non-checkpoints, malformed preparations and missing or forged saved attachments', async () => {
  const state = setup();
  state.service.start({ question: '복원 대상 질문', attachments: [document()] }, settings);
  await state.service.wait();
  const checkpoint = structuredClone(state.saved.at(-1));
  for (const overrides of [
    { status: 'complete' }, { status: 'researching' }, { question: '' }, { id: 'forged-id' },
    { preparation: null }, { preparation: { version: 1, questions: [] } },
    { preparation: { ...preparation, questions: [{ id: 'q1', question: 'invalid required', required: 'yes' }] } },
    { intakeDocuments: undefined }, { intakeDocuments: [{ ...document(), path: 'C:/private.txt' }] },
    { intakeDocuments: [{ ...document(), text: 'x'.repeat(12001) }] },
  ]) {
    const restarted = setup();
    assert.throws(() => restarted.service.restore({ ...checkpoint, ...overrides }, settings), /복원|첨부/);
    assert.equal(restarted.service.active(), null);
    assert.equal(restarted.researched.length, 0);
  }
});
