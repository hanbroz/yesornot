'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createResearchService } = require('../services/research.cjs');
const source = { question: '자기 자금, 월 상환 한도와 기한을 알려 주세요.', why: '각 조건에 따라 실행 여부가 달라집니다.', material: '', required: true };
const atomic = data => ({ questions: ['투입할 자기 자금은 얼마인가요?', '월 상환 한도는 얼마인가요?', '언제까지 결정해야 하나요?'].map(question => ({ sourceIds: [data.candidates[0].id], question, why: '이 값에 따라 실행 가능 여부가 달라집니다.', material: '' })) });
function setup({ judge, rewrite = atomic, integrity = () => 'COMPLETE' } = {}) {
  const calls = [], judgments = [];
  const service = createResearchService({ providers: ['claude'],
    getStructured: async (_id, prompt, _schema, options) => {
      calls.push({ prompt, options });
      if (prompt.includes('INTAKE_CONSOLIDATION_DATA_JSON: ')) return { data: await rewrite(JSON.parse(prompt.split('INTAKE_CONSOLIDATION_DATA_JSON: ')[1]), options) };
      return { data: { summary: '사전 계획', searches: [], questions: [source] } };
    },
    judgePreparation: async input => {
      judgments.push(structuredClone(input));
      return { intakeIntegrity: { choice: integrity(input, judgments.length), confidence: .9 }, items: input.candidates.map((row, index) => ({ id: row.id, choice: judge ? judge(row, index, judgments.length) : judgments.length === 1 ? 'SPLIT_REQUIRED' : 'ASK_REQUIRED', confidence: .9 })) };
    }, verifySources: async () => { throw Error('No external research during intake'); },
  });
  return { service, calls, judgments };
}

test('a single compound request is split after independent JEV review, then every atomic question is rejudged', async () => {
  const state = setup();
  const result = await state.service.prepare({ question: '가상 이전 계획을 실행할까요?' });
  assert.equal(state.judgments.length, 2);
  assert.equal(state.judgments[0].candidates.length, 1);
  assert.equal(state.judgments[1].candidates.length, 3);
  assert.deepEqual(result.questions.map(row => row.id), ['q1','q2','q3']);
  assert.ok(result.questions.every(row => row.required && row.sourceIds[0] === 'r1'));
  const rewrite = state.calls.find(row => row.prompt.includes('INTAKE_CONSOLIDATION_DATA_JSON: '));
  const data = JSON.parse(rewrite.prompt.split('INTAKE_CONSOLIDATION_DATA_JSON: ')[1]);
  assert.equal(data.review[0].choice, 'SPLIT_REQUIRED');
  assert.equal(data.previousCandidates[0].question, source.question);
  assert.equal(rewrite.options.research, false);
  assert.match(rewrite.prompt, /Do not hide extra questions/);
  assert.equal(result.intakeReview.rounds.length, 2);
  assert.equal(result.consolidation.repaired, true);
});

test('optional, low-impact, supplied and public facts never interrupt the user with a questionnaire', async () => {
  const state = setup({ rewrite: data => ({ questions: Array.from({ length: 5 }, (_, index) => ({ sourceIds:[data.candidates[0].id], question:`분리된 정보 ${index + 1}은 무엇인가요?`, why:'판단 영향 평가', material:'' })) }),
    judge: (_row, index, round) => round === 1 ? 'SPLIT_REQUIRED' : ['ASK_OPTIONAL','NOT_NEEDED','ALREADY_SUPPLIED','RESEARCH_PUBLIC','ASK_REQUIRED'][index] });
  const result = await state.service.prepare({ question: '가상 선택의 실질적인 제약만 확인해 주세요.' });
  assert.equal(result.candidates.length, 5);
  assert.deepEqual(result.questions.map(row => row.id), ['q5']);
  assert.equal(result.questions[0].required, true);
  assert.deepEqual(result.judgment.items.map(row => row.choice), ['ASK_OPTIONAL','NOT_NEEDED','ALREADY_SUPPLIED','RESEARCH_PUBLIC','ASK_REQUIRED']);
});

test('a questionnaire is not published if compound items remain after the bounded repair', async () => {
  const state = setup({ judge: () => 'SPLIT_REQUIRED', rewrite: data => ({ questions: [{ sourceIds:[data.candidates[0].id], question:source.question, why:source.why, material:'' }] }) });
  await assert.rejects(state.service.prepare({ question:'가상 질문' }), { code:'INTAKE_ATOMICITY_FAILED' });
  assert.equal(state.judgments.length, 2);
  assert.equal(state.calls.filter(row => row.prompt.includes('INTAKE_CONSOLIDATION_DATA_JSON: ')).length, 1);
});

test('cancellation during atomic repair stops before a second JEV evaluation', async () => {
  const controller = new AbortController();
  const state = setup({ rewrite: async (_data, options) => { assert.ok(options.signal); controller.abort(); return new Promise(() => {}); } });
  await assert.rejects(state.service.prepare({ question:'가상 질문', signal:controller.signal }), { code:'ABORTED' });
  assert.equal(state.judgments.length, 1);
});

test('all nonessential facts proceed without any user questions and retain the JEV review record', async () => {
  const state = setup({ judge: () => 'NOT_NEEDED' });
  const result = await state.service.prepare({ question:'조건을 가정해 비교할 수 있는 가상 질문' });
  assert.deepEqual(result.questions, []);
  assert.equal(result.intakeReview.rounds.length, 1);
  assert.equal(result.intakeReview.rounds[0].judgment.items[0].choice, 'NOT_NEEDED');
  assert.equal(state.calls.filter(row => row.prompt.includes('INTAKE_CONSOLIDATION_DATA_JSON: ')).length, 0);
});

test('partial loss of facts from a compound source cannot pass by merely reusing its source ID', async () => {
  const state = setup({
    rewrite: data => ({ questions: [atomic(data).questions[0]] }),
    integrity: (_input, round) => round === 1 ? 'COMPLETE' : 'REPAIR_REQUIRED',
  });
  await assert.rejects(state.service.prepare({ question:'가상 질문' }), { code:'INTAKE_ATOMICITY_FAILED' });
  assert.equal(state.judgments.length, 2);
  assert.equal(state.judgments[1].candidates.length, 1);
  assert.deepEqual(state.judgments[1].candidates[0].sourceIds, ['r1']);
});

test('the independent integrity review triggers repair even if every remaining item is individually essential', async () => {
  const state = setup({ judge: () => 'ASK_REQUIRED', integrity: (_input, round) => round === 1 ? 'REPAIR_REQUIRED' : 'COMPLETE' });
  const result = await state.service.prepare({ question:'가상 질문' });
  assert.equal(result.questions.length, 3);
  assert.equal(state.judgments.length, 2);
  const call = state.calls.find(row => row.prompt.includes('INTAKE_CONSOLIDATION_DATA_JSON: '));
  assert.equal(JSON.parse(call.prompt.split('INTAKE_CONSOLIDATION_DATA_JSON: ')[1]).integrity.choice, 'REPAIR_REQUIRED');
  assert.equal(result.judgment.intakeIntegrity.choice, 'COMPLETE');
});
