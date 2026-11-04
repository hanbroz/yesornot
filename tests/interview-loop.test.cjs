'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createDecisionService } = require('../services/decision.cjs');
const { createResearchService, READINESS_TARGET } = require('../services/research.cjs');

const settings = { model: 'jev-fixture', timeoutMs: 1000 };
const preparation = () => ({ version: 1, plans: [{ providerId: 'claude', status: 'success' }], questions: [{ id: 'q1', question: '예산은?', required: true }], searches: [], judgment: { items: [] },
  readiness: 40, interview: { version: 1, target: 90, maxRounds: 5, rounds: [{ round: 1, score: 40, questionCount: 1 }] } });

function setup(scores) {
  const reassessed = [], researched = [];
  const service = createDecisionService({
    providers: [{ id: 'claude', name: 'Claude' }], getApiKey: () => 'test-key',
    store: { saveRecord: async () => {} },
    researchService: {
      prepare: async () => preparation(),
      reassess: async input => {
        reassessed.push(structuredClone({ ...input, signal: undefined, onProgress: undefined }));
        const score = scores[input.round - 2];
        return { round: input.round, score, assessments: [], questions: score < 90 ? [{ id: `r${input.round}q1`, question: `추가 질문 ${input.round}`, required: true }] : [] };
      },
      research: async input => { researched.push(structuredClone({ ...input, signal: undefined, onProgress: undefined })); return { status: 'complete', sources: [{ id: 'S1' }], context: 'evidence [S1]' }; },
    },
    getOpinion: async id => ({ providerId: id, status: 'success', text: 'Opinion [S1]' }),
    evaluate: async () => ({ synthesis: { status: 'complete' } }),
  });
  return { service, reassessed, researched };
}

test('the interview repeats until readiness reaches the target and research sees every round', async () => {
  const { service, reassessed, researched } = setup([70, 92]);
  const { runId } = service.start({ question: '이직해도 될까요?' }, settings);
  await service.wait();
  assert.equal(service.active().status, 'awaiting_input');
  service.continue({ runId, answers: { q1: '5천만 원' } });
  await service.wait();
  const second = service.active();
  assert.equal(second.status, 'awaiting_input');
  assert.deepEqual(second.preparation.questions.map(item => item.id), ['r2q1']);
  assert.equal(second.preparation.readiness, 70);
  service.continue({ runId, answers: { r2q1: '1년 안' } });
  await service.wait();
  assert.equal(reassessed.length, 2);
  assert.deepEqual(reassessed[1].answers, { q1: '5천만 원', r2q1: '1년 안' });
  assert.equal(researched.length, 1);
  assert.deepEqual(researched[0].answers, { q1: '5천만 원', r2q1: '1년 안' });
  assert.deepEqual(researched[0].preparation.answeredQuestions.map(item => item.id), ['q1', 'r2q1']);
  assert.deepEqual(researched[0].preparation.interview.rounds.map(row => row.score), [40, 70, 92]);
});

test('the interview stops asking after the round limit even below the target', async () => {
  const { service, reassessed, researched } = setup([50, 55, 60, 65, 70]);
  const { runId } = service.start({ question: '이직해도 될까요?' }, settings);
  await service.wait();
  for (let round = 1; service.active()?.status === 'awaiting_input'; round++) {
    const id = service.active().preparation.questions[0].id;
    service.continue({ runId, answers: { [id]: '모름' } });
    await service.wait();
  }
  assert.equal(reassessed.length, 5);
  assert.equal(researched.length, 1);
});

test('a failed re-score keeps the answers and continues to research', async () => {
  const researched = [];
  const service = createDecisionService({
    providers: [{ id: 'claude', name: 'Claude' }], getApiKey: () => 'test-key', store: { saveRecord: async () => {} },
    researchService: { prepare: async () => preparation(), reassess: async () => { throw Object.assign(new Error('down'), { code: 'READINESS_FAILED' }); },
      research: async input => { researched.push(input); return { status: 'complete', sources: [{ id: 'S1' }], context: 'evidence [S1]' }; } },
    getOpinion: async id => ({ providerId: id, status: 'success', text: 'Opinion [S1]' }), evaluate: async () => ({ synthesis: { status: 'complete' } }),
  });
  const { runId } = service.start({ question: '이직해도 될까요?' }, settings);
  await service.wait();
  service.continue({ runId, answers: { q1: '5천만 원' } });
  await service.wait();
  assert.equal(researched.length, 1);
  assert.equal(researched[0].preparation.interview.error.code, 'READINESS_FAILED');
});

test('reassess averages AI readiness, skips asked questions and asks optional facts below the target', async () => {
  const judgedQuestions = [];
  const service = createResearchService({ providers: ['claude', 'codex'], verifySources: async () => [],
    judgePreparation: async ({ question, candidates }) => {
      judgedQuestions.push(question);
      return { model: 'jev', items: candidates.map((candidate, index) => ({ id: candidate.id, choice: index ? 'ASK_OPTIONAL' : 'ASK_REQUIRED', confidence: 0.8 })), intakeIntegrity: { choice: 'COMPLETE' } };
    },
    getStructured: async (id, prompt) => {
      if (prompt.includes('INTAKE_CONSOLIDATION_DATA_JSON: ')) {
        const { candidates } = JSON.parse(prompt.split('INTAKE_CONSOLIDATION_DATA_JSON: ')[1]);
        const groups = new Map();
        for (const row of candidates) (groups.get(row.question) || groups.set(row.question, { sourceIds: [], question: row.question, why: row.why, material: row.material }).get(row.question)).sourceIds.push(row.id);
        return { data: { questions: [...groups.values()] } };
      }
      assert.match(prompt, /INTERVIEW READINESS REVIEW ONLY/);
      const data = JSON.parse(prompt.split('INTERVIEW_DATA_JSON: ')[1]);
      assert.deepEqual(data.interview, [{ id: 'q1', question: '예산은?', answer: '5천만 원' }]);
      return { data: { readiness: id === 'claude' ? 60 : 80, summary: '기간 정보가 부족합니다.', questions: [
        { question: '예산은?', why: '중복', material: '', required: true },
        { question: '언제까지 결정해야 하나요?', why: '조사 기간이 달라집니다.', material: '', required: true },
        { question: '가족 동의가 있나요?', why: '실행 조건이 달라집니다.', material: '', required: false },
      ] } };
    } });
  const prep = { plans: [{ providerId: 'claude', status: 'success' }, { providerId: 'codex', status: 'success' }], answeredQuestions: [{ id: 'q1', question: '예산은?' }], questions: [] };
  const result = await service.reassess({ question: '이직해도 될까요?', preparation: prep, answers: { q1: '5천만 원' }, round: 2 });
  assert.equal(result.score, 70);
  assert.ok(result.score < READINESS_TARGET);
  assert.deepEqual(result.questions.map(item => [item.id, item.question, item.required]), [['r2q1', '언제까지 결정해야 하나요?', true], ['r2q2', '가족 동의가 있나요?', false]]);
  assert.match(judgedQuestions[0], /Q: 예산은\?\nA: 5천만 원/);
});

test('reassess at or above the target asks nothing more', async () => {
  const service = createResearchService({ providers: ['claude'], verifySources: async () => [], judgePreparation: async () => { throw new Error('must not judge'); },
    getStructured: async () => ({ data: { readiness: 93, summary: '충분합니다.', questions: [] } }) });
  const result = await service.reassess({ question: '이직해도 될까요?', preparation: { plans: [{ providerId: 'claude', status: 'success' }], questions: [] }, answers: {}, round: 2 });
  assert.deepEqual([result.score, result.questions.length], [93, 0]);
});

test('cancelling while readiness is re-scored ends the run once as canceled', async () => {
  const events = [];
  let release;
  const service = createDecisionService({
    providers: [{ id: 'claude', name: 'Claude' }], getApiKey: () => 'test-key', store: { saveRecord: async () => {} }, onEvent: event => events.push(event.type + ':' + event.record.status),
    researchService: { prepare: async () => preparation(), research: async () => { throw new Error('must not research'); },
      reassess: input => new Promise((_resolve, reject) => { release = () => reject(Object.assign(new Error('aborted'), { code: 'ABORTED' })); input.signal.addEventListener('abort', release); }) },
    getOpinion: async () => { throw new Error('must not debate'); }, evaluate: async () => ({}),
  });
  const { runId } = service.start({ question: '이직해도 될까요?' }, settings);
  await service.wait();
  service.continue({ runId, answers: { q1: '5천만 원' } });
  await new Promise(resolve => setImmediate(resolve));
  await service.cancel();
  assert.equal(service.active(), null);
  assert.equal(events.filter(event => event.startsWith('complete:')).length, 1);
  assert.equal(events.at(-1), 'complete:canceled');
});

test('the last allowed round only scores, and a failed questionnaire save never blocks research', async () => {
  const finals = [], researched = [];
  let saves = 0;
  const service = createDecisionService({
    providers: [{ id: 'claude', name: 'Claude' }], getApiKey: () => 'test-key',
    store: { saveRecord: async record => { if (record.status === 'awaiting_input' && record.preparation.questions[0]?.id === 'r2q1' && saves++ === 0) throw new Error('EBUSY'); } },
    researchService: { prepare: async () => preparation(),
      reassess: async input => { finals.push(input.final); return { round: input.round, score: 50, assessments: [], questions: [{ id: `r${input.round}q1`, question: '추가', required: true }] }; },
      research: async input => { researched.push(input.preparation.questions.length); return { status: 'complete', sources: [{ id: 'S1' }], context: 'evidence [S1]' }; } },
    getOpinion: async id => ({ providerId: id, status: 'success', text: 'Opinion [S1]' }), evaluate: async () => ({ synthesis: { status: 'complete' } }),
  });
  const { runId } = service.start({ question: '이직해도 될까요?' }, settings);
  await service.wait();
  service.continue({ runId, answers: { q1: '5천만 원' } });
  await service.wait();
  assert.deepEqual(finals, [false]);
  assert.deepEqual(researched, [0]);
});

test('a saved checkpoint from before multi-round interviews resumes at round 2', async () => {
  const rounds = [];
  const service = createDecisionService({
    providers: [{ id: 'claude', name: 'Claude' }], getApiKey: () => 'test-key', store: { saveRecord: async () => {} },
    researchService: { prepare: async () => { throw new Error('must not prepare'); },
      reassess: async input => { rounds.push(input.round); return { round: input.round, score: 95, assessments: [], questions: [] }; },
      research: async () => ({ status: 'complete', sources: [{ id: 'S1' }], context: 'evidence [S1]' }) },
    getOpinion: async id => ({ providerId: id, status: 'success', text: 'Opinion [S1]' }), evaluate: async () => ({ synthesis: { status: 'complete' } }),
  });
  const legacy = { ...preparation(), interview: undefined, readiness: undefined };
  const record = { id: '0b8f6a2e-1c3d-4e5f-8a9b-0c1d2e3f4a5b', question: '이직해도 될까요?', status: 'awaiting_input', preparation: legacy, attachments: [], intakeDocuments: [],
    opinions: [{ providerId: 'claude', name: 'Claude', status: 'pending' }], evaluation: null };
  const { runId } = service.restore(record, settings);
  service.continue({ runId, answers: { q1: '5천만 원' } });
  await service.wait();
  assert.deepEqual(rounds, [2]);
});

test('reassess hides already-asked questions from JEV plans and skips judging on the final round', async () => {
  const seen = [];
  const make = () => createResearchService({ providers: ['claude'], verifySources: async () => [],
    judgePreparation: async ({ plans, candidates }) => { seen.push(plans[0].questions.map(item => item.question)); return { model: 'jev', items: candidates.map(candidate => ({ id: candidate.id, choice: 'ASK_REQUIRED', confidence: 0.9 })), intakeIntegrity: { choice: 'COMPLETE' } }; },
    getStructured: async () => ({ data: { readiness: 50, summary: '부족', questions: [{ question: '예산은?', why: '중복', material: '', required: true }, { question: '기한은?', why: '새 정보', material: '', required: true }] } }) });
  const prep = { plans: [{ providerId: 'claude', status: 'success' }], answeredQuestions: [{ id: 'q1', question: '예산은?' }], questions: [] };
  await make().reassess({ question: '이직해도 될까요?', preparation: prep, answers: { q1: '많음' }, round: 2 });
  assert.deepEqual(seen, [['기한은?']]);
  const last = await make().reassess({ question: '이직해도 될까요?', preparation: prep, answers: { q1: '많음' }, round: 6, final: true });
  assert.deepEqual([last.score, last.questions.length, seen.length], [50, 0, 1]);
});

test('when JEV cannot structure the next questions, the AIs\' questions are still asked', async () => {
  const service = createResearchService({ providers: ['claude', 'codex'], verifySources: async () => [],
    judgePreparation: async () => { throw Object.assign(new Error('구조 판정 실패'), { code: 'INTAKE_ATOMICITY_FAILED' }); },
    getStructured: async (id, prompt) => {
      if (prompt.includes('INTAKE_CONSOLIDATION_DATA_JSON: ')) throw new Error('consolidation down');
      return { data: { readiness: 57, summary: '부족', questions: [{ question: '런웨이는 몇 개월인가요?', why: '버틸 기간', material: '', required: true }] } };
    } });
  const prep = { plans: [{ providerId: 'claude', status: 'success' }, { providerId: 'codex', status: 'success' }], answeredQuestions: [{ id: 'q1', question: '예산은?' }], questions: [] };
  const result = await service.reassess({ question: '사업을 해도 될까요?', preparation: prep, answers: { q1: '1억' }, round: 2 });
  assert.equal(result.score, 57);
  assert.deepEqual(result.questions.map(item => [item.id, item.question, item.choice]), [['r2q1', '런웨이는 몇 개월인가요?', 'AI_PROPOSED']]);
  assert.equal(result.judgeError.code, 'INTAKE_ATOMICITY_FAILED');
});

test('moving on below the target records why', async () => {
  const { service, researched } = setup([60]);
  const scores = [];
  const { runId } = service.start({ question: '이직해도 될까요?' }, settings);
  await service.wait();
  service.continue({ runId, answers: { q1: '5천만 원' } });
  await service.wait();
  // setup() returns a question below 90, so this run is still interviewing.
  assert.equal(service.active().status, 'awaiting_input');
  const noQuestions = createDecisionService({
    providers: [{ id: 'claude', name: 'Claude' }], getApiKey: () => 'k', store: { saveRecord: async () => {} },
    researchService: { prepare: async () => preparation(), reassess: async input => ({ round: input.round, score: 60, assessments: [], questions: [] }),
      research: async input => { scores.push(input.preparation.interview.belowTarget); return { status: 'complete', sources: [{ id: 'S1' }], context: 'e [S1]' }; } },
    getOpinion: async id => ({ providerId: id, status: 'success', text: 'O [S1]' }), evaluate: async () => ({ synthesis: { status: 'complete' } }),
  });
  const second = noQuestions.start({ question: '이직해도 될까요?' }, settings);
  await noQuestions.wait();
  noQuestions.continue({ runId: second.runId, answers: { q1: '5천만 원' } });
  await noQuestions.wait();
  assert.deepEqual(scores, [{ score: 60, reason: 'NO_QUESTIONS' }]);
  assert.equal(researched.length, 0);
});

test('a long attachment is read once; answering the next round does not read it again', async () => {
  const digested = [];
  const document = { id: 'a', name: '전략서.md', size: 1, truncated: false, text: '본문\n'.repeat(20000) };
  const withDigest = createDecisionService({
    providers: [{ id: 'claude', name: 'Claude' }], getApiKey: () => 'test-key', store: { saveRecord: async () => {} },
    researchService: {
      digestDocuments: async documents => { digested.push(documents.filter(item => !item.digest).length); return documents.map(item => item.digest ? item : { ...item, digest: '요약' }); },
      prepare: async () => preparation(),
      reassess: async input => ({ round: input.round, score: 70, assessments: [], questions: [{ id: `r${input.round}q1`, question: '추가', required: true }] }),
      research: async () => ({ status: 'complete', sources: [], context: '' }),
    },
    getOpinion: async id => ({ providerId: id, status: 'success', text: 'x' }), evaluate: async () => ({}),
  });
  const { runId } = withDigest.start({ question: '이직해도 될까요?', attachments: [document] }, settings);
  await withDigest.wait();
  withDigest.continue({ runId, answers: { q1: '모름' }, attachments: [structuredClone(document)] });
  await withDigest.wait();
  assert.deepEqual(digested, [1, 0]);
});
