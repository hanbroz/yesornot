'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createResearchService } = require('../services/research.cjs');
const item = (question, required = true) => ({ question, why: '결정에 필요한 개인 조건', material: '관련 자료가 있으면 첨부', required });
const plans = {
  claude: [item('동원 가능한 현금은 얼마인가요?'), item('매달 감당할 수 있는 상환액은 얼마인가요?')],
  codex: [item('이번 결정에 쓸 수 있는 가용 자금 규모는?'), item('월 원리금 상환 한도를 알려 주세요.')],
  gemini: [item('투입 가능한 자기 자금은 얼마입니까?'), item('결정을 마쳐야 하는 기한은 언제인가요?', false)],
};
const dataFor = prompt => JSON.parse(prompt.split('INTAKE_CONSOLIDATION_DATA_JSON: ')[1]);
const group = (sourceIds, question) => ({ sourceIds, question, why: '관련된 개인 조건을 한 번만 확인합니다.', material: '기존 자료에 없는 값만 알려 주세요.' });
const grouped = data => ({ questions: [
  group(data.candidates.filter(row => /현금|가용 자금|자기 자금/.test(row.question)).map(row => row.id), '이번 결정에 투입할 수 있는 자기 자금은 얼마인가요?'),
  group(data.candidates.filter(row => /상환/.test(row.question)).map(row => row.id), '무리 없이 감당할 수 있는 월 상환액의 한도는 얼마인가요?'),
  group(data.candidates.filter(row => /기한/.test(row.question)).map(row => row.id), '언제까지 결정해야 하나요?'),
] });
function setup({ consolidate = (_id, data) => grouped(data), sourcePlans = plans, judge } = {}) {
  const calls = [], judges = [];
  const service = createResearchService({ providers: Object.keys(sourcePlans),
    getStructured: async (id, prompt, schema, options) => {
      calls.push({ id, prompt, schema, options });
      if (prompt.includes('INTAKE_CONSOLIDATION_DATA_JSON: ')) return { data: await consolidate(id, dataFor(prompt), options), model: 'consolidator-fixture' };
      return { data: { summary: '사전 계획', searches: [], questions: sourcePlans[id] } };
    },
    judgePreparation: async input => {
      judges.push(input);
      return judge ? judge(input) : { items: input.candidates.map(row => ({ id: row.id, choice: row.required ? 'ASK_REQUIRED' : 'ASK_OPTIONAL', confidence: 0.9 })) };
    }, verifySources: async () => { throw new Error('No research during intake'); },
  });
  return { service, calls, judges };
}

test('Korean paraphrases are consolidated before JEV with complete provenance and separate critical facts', async () => {
  const state = setup(), progress = [];
  const result = await state.service.prepare({ question: '이사할까요?', attachments: [{ name: '가상자료.txt', text: 'SYNTHETIC_PRIVATE_CONTEXT' }], onProgress: row => progress.push(row) });
  assert.equal(result.questions.length, 2);
  assert.match(result.questions[0].question, /자기 자금/); assert.match(result.questions[1].question, /월 상환액/);
  assert.deepEqual(result.questions[0].providerIds, ['claude', 'codex', 'gemini']);
  assert.equal(result.candidates[2].required, false);
  assert.ok(result.questions.every(row => row.required));
  assert.equal(state.judges[0].candidates.length, 3);
  assert.equal(result.sourceCandidates.length, 6);
  assert.deepEqual(result.candidates.flatMap(row => row.sourceIds).sort(), result.sourceCandidates.map(row => row.id).sort());
  assert.equal(result.consolidation.inputCount, 6); assert.equal(result.consolidation.outputCount, 3);
  const call = state.calls.find(row => row.prompt.includes('INTAKE_CONSOLIDATION_DATA_JSON: '));
  assert.equal(call.options.research, false); assert.match(call.prompt, /SYNTHETIC_PRIVATE_CONTEXT/);
  assert.match(call.prompt, /Do not merge distinct decision-critical facts/);
  assert.ok(progress.some(row => row.phase === 'consolidating-intake'));
});

test('surface variants normalize without another model call and retain every proposing provider', async () => {
  const state = setup({ sourcePlans: { claude: [item('가용 자금은 얼마인가요?')], codex: [item('  가용   자금은 얼마인가요 ？ ')] }, consolidate: () => { throw new Error('Should not be called'); } });
  const result = await state.service.prepare({ question: '검토해 주세요.' });
  assert.equal(result.questions.length, 1); assert.equal(state.calls.length, 2);
  assert.equal(result.questions[0].id, 'q1'); assert.deepEqual(result.questions[0].providerIds, ['claude', 'codex']);
});

test('identical question wording with complementary reasons and materials still requires semantic consolidation', async () => {
  let consolidated = false;
  const state = setup({ sourcePlans: {
    claude: [{ ...item('자금 계획을 알려 주세요.'), why: '자기 자금 확인', material: '보유 현금액' }],
    codex: [{ ...item('자금 계획을 알려 주세요.'), why: '대출 부담 확인', material: '대출 금리와 월 상환 한도' }],
  }, consolidate: (_id, data) => {
    consolidated = true;
    return { questions: [
      group(data.candidates.map(row => row.id), '투입할 자기 자금은 얼마인가요?'),
      group([data.candidates[1].id], '대출 금리는 몇 퍼센트인가요?'),
      group([data.candidates[1].id], '월 상환 한도는 얼마인가요?'),
    ] };
  } });
  const result = await state.service.prepare({ question: '검토해 주세요.' });
  assert.equal(consolidated, true); assert.equal(result.questions.length, 3);
  assert.match(result.questions[0].question, /자기 자금/);
  assert.match(result.questions[1].question, /대출 금리/);
  assert.match(result.questions[2].question, /월 상환 한도/);
  assert.ok(result.questions[1].sourceIds.includes(result.questions[2].sourceIds[0]));
  assert.deepEqual(result.questions[0].providerIds, ['claude', 'codex']);
});

test('all 24 distinct atomic facts survive without merging to satisfy an arbitrary question quota', async () => {
  const sourcePlans = Object.fromEntries(['claude', 'codex', 'gemini'].map((id, provider) => [id, Array.from({ length: 8 }, (_, n) => item(`${id} 고유 조건 ${provider * 8 + n + 1}은 무엇인가요?`))]));
  const state = setup({ sourcePlans, consolidate: (_id, data) => {
    assert.equal(data.candidates.length, 24);
    return { questions: data.candidates.map(row => group([row.id], row.question)) };
  } });
  const result = await state.service.prepare({ question: '가상 다중 조건 결정' });
  assert.equal(result.sourceCandidates.length, 24); assert.equal(result.candidates.length, 24);
  assert.equal(result.questions.length, 24);
  const call = state.calls.find(row => row.prompt.includes('INTAKE_CONSOLIDATION_DATA_JSON: '));
  assert.equal(call.schema.properties.questions.maxItems, 48);
  assert.match(call.prompt, /ONE QUESTION = ONE INDEPENDENT ANSWER/);
  assert.match(call.prompt, /No target question count/);
  assert.ok(result.candidates.some(row => row.sourceIds.includes(result.sourceCandidates.at(-1).id)));
});

test('invalid partitions retry another planner rather than publishing duplicated raw candidates', async () => {
  const malformed = [
    data => ({ questions: grouped(data).questions.slice(1) }),
    data => { const value = grouped(data); value.questions[1].sourceIds.push(value.questions[1].sourceIds[0]); return value; },
    data => { const value = grouped(data); value.questions[0].sourceIds.push('invented'); return value; },
    data => { const value = grouped(data); value.questions[0].sourceIds = []; return value; },
    data => { const value = grouped(data); value.questions[1].question = value.questions[0].question + ' ？'; return value; },
    data => ({ questions: Array.from({ length: 49 }, () => group([data.candidates[0].id], '잘못된 질문')) }),
  ];
  for (const invalid of malformed) {
    const state = setup({ consolidate: (id, data) => id === 'claude' ? invalid(data) : grouped(data) });
    const result = await state.service.prepare({ question: '검토해 주세요.' });
    assert.equal(result.consolidation.providerId, 'codex'); assert.equal(result.questions.length, 2);
    assert.equal(state.judges.length, 1);
  }
});

test('all failed consolidators stop before JEV and never return the raw duplicate list', async () => {
  const state = setup({ consolidate: () => { throw Object.assign(new Error('PRIVATE_ERROR_DETAIL'), { code: 'AUTH_REQUIRED' }); } });
  await assert.rejects(state.service.prepare({ question: '검토해 주세요.' }), error => error.code === 'INTAKE_CONSOLIDATION_FAILED' && !error.message.includes('PRIVATE_ERROR_DETAIL'));
  assert.equal(state.judges.length, 0);
});

test('JEV can suppress supplied context after consolidation without asking it again', async () => {
  const state = setup({ judge: ({ candidates, attachments }) => {
    assert.match(attachments[0].text, /자기 자금은 1억원/);
    return { items: candidates.map((row, index) => ({ id: row.id, choice: index === 0 ? 'ALREADY_SUPPLIED' : 'ASK_REQUIRED', confidence: 0.9 })) };
  } });
  const result = await state.service.prepare({ question: '이사할까요?', attachments: [{ name: '가상자금계획.txt', text: '자기 자금은 1억원입니다. 가상 사례입니다.' }] });
  assert.equal(result.questions.length, 2); assert.ok(result.questions.every(row => !/자기 자금/.test(row.question)));
});

test('timed out consolidation tries the next available planner with a bounded deadline', async () => {
  const state = setup({ consolidate: (id, data) => id === 'claude' ? new Promise(() => {}) : grouped(data) });
  const result = await state.service.prepare({ question: '검토해 주세요.', timeoutMs: 10 });
  assert.equal(result.consolidation.providerId, 'codex');
  assert.equal(result.consolidation.attempts[0].errorCode, 'TIMEOUT');
  assert.equal(state.judges.length, 1);
});

test('cancellation during consolidation never invokes JEV or another consolidator', async () => {
  const controller = new AbortController();
  const state = setup({ consolidate: (_id, _data, options) => { controller.abort(); assert.ok(options.signal); return new Promise(() => {}); } });
  await assert.rejects(state.service.prepare({ question: '검토해 주세요.', signal: controller.signal }), { code: 'ABORTED' });
  assert.equal(state.judges.length, 0);
  assert.equal(state.calls.filter(row => row.prompt.includes('INTAKE_CONSOLIDATION_DATA_JSON: ')).length, 1);
});
