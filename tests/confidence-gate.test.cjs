'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { verdictInterval, evaluateGate, GATE_LEVELS } = require('../services/confidence.cjs');
const { createSynthesizedEvaluation, MAX_QUALITY_ROUNDS } = require('../services/synthesis.cjs');
const { createDecisionService } = require('../services/decision.cjs');
const { buildReportHtml } = require('../services/report-pdf.cjs');
const { validateSettings } = require('../services/store.cjs');

test('the 95% interval uses the Student t distribution over independent judgments', () => {
  const tight = verdictInterval([0.8, 0.75, 0.82, 0.78, 0.79]);
  assert.deepEqual([tight.choice, tight.n, tight.lower, tight.upper], ['YES', 5, 0.756, 0.82]);
  const noisy = verdictInterval([0.6, 0.45, 0.7, 0.55, 0.4]);
  assert.ok(noisy.lower < 0.5);
  assert.equal(verdictInterval([0.2, 0.25, 0.3]).choice, 'NO');
  assert.equal(verdictInterval([]), null);
});

test('each gate level lists every check and passes only when all hold', () => {
  const interval = verdictInterval([0.8, 0.75, 0.82, 0.78, 0.79]);
  const strict = evaluateGate({ level: 'strict', interval, opinionScores: [{ total: 82 }, { total: 79 }], reviewScore: 92, readiness: 91 });
  assert.equal(strict.passed, true);
  const weak = evaluateGate({ level: 'strict', interval, opinionScores: [{ total: 82 }, { total: 70 }], reviewScore: 92, readiness: 91 });
  assert.deepEqual(weak.checks.filter(check => !check.passed).map(check => check.id), ['minQuality', 'avgQuality']);
  assert.equal(evaluateGate({ level: 'relaxed', interval, opinionScores: [{ total: 82 }, { total: 70 }], reviewScore: 92, readiness: 91 }).passed, true);
  assert.deepEqual(Object.keys(GATE_LEVELS), ['strict', 'recommended', 'relaxed']);
  assert.equal(validateSettings({ model: 'jev-latest', timeoutMs: 180000, gateLevel: 'relaxed' }).gateLevel, 'relaxed');
  assert.throws(() => validateSettings({ model: 'jev-latest', timeoutMs: 180000, gateLevel: 'lenient' }));
});

const data = prompt => JSON.parse(prompt.slice(prompt.lastIndexOf('\n') + 1));
const source = providerId => ({ providerId, status: 'success', stance: 'YES', title: '출처', text: providerId + ' 원래 의견', point: '원래 조건' });
function report(lead, stance = 'YES') {
  return { status: 'success', stance, title: '작게 실행', point: '먼저 원본 사본을 보관하고 격리 환경에서 복구 결과를 확인하세요.', text: [
    '[판단]', lead, '지금 격리된 환경의 시험을 실행하세요. 검증된 복구 절차를 먼저 준비합니다.',
    '[선택 이유]', '검토에서 확인한 복구 가능성을 우선합니다. 원본을 보존하면 실패 시 피해 범위를 제한할 수 있습니다.',
    '[대안 비교]', '전체 도입은 복구 확인 전에 원본에 영향을 줍니다. 격리 시험은 같은 기능을 확인하면서 원본을 유지하므로 먼저 선택합니다.',
    '[실행 계획]', '먼저 원본 사본을 보관합니다. 이어 격리 환경에서 복구를 실행하고 원본과 일치하는지 확인한 뒤 시험 결과를 기록합니다.',
    '[위험과 대응]', '복구 결과가 원본과 다르면 시험을 중단하고 원본을 유지합니다. 일치 여부를 확인하기 전에는 전체 도입을 하지 않습니다.',
    '[결론 변경 조건]', '격리 시험에서 복구 결과가 원본과 일치하고 기능 검사가 통과하면 제한된 도입으로 권고를 바꿉니다. 실패하면 도입하지 않습니다.',
  ].join('\n\n') };
}
function evaluation(opinions, phase, scores) {
  return { model: 'jev', phase, verdict: { choice: 'YES', rawChoice: 'YES', confidence: .5, probabilities: { YES: .75, NO: .25 } },
    opinions: opinions.map((opinion, index) => ({ providerId: opinion.providerId, total: scores(opinion, index), dimensions: [
      { id: 'logic', name: '논리성', weight: 30, points: 18, rawScore: 2.4, maxScore: 4, legend: { 0: 'L0', 1: 'L1', 2: '전제 검토 부족', 3: '주요 전제와 한계를 설명', 4: 'L4' } }] })),
    qualityAverage: 0, feedback: opinions.map(opinion => ({ providerId: opinion.providerId, focus: 'LOGIC', label: '논리 보완' })) };
}
function setup({ yesSamples, scoreFor }) {
  const revisions = [], gapCalls = [];
  let sample = 0;
  const run = createSynthesizedEvaluation({
    evaluate: async passed => evaluation(passed.opinions, passed.phase, scoreFor),
    getOpinion: async (id, _question, { prompt }) => {
      const context = data(prompt);
      if (context.phase === 'verification') return { ...report(id + ' 검증 의견'), title: id + ' 검증' };
      if (context.phase === 'quality-revision') { revisions.push({ id, comments: context.qualityComments }); return { ...report(id + ' 보완 ' + revisions.length), title: id + ' 보완' }; }
      return report('모든 의견을 종합한 최종 권고');
    },
    getStructured: async (id, prompt, schema) => {
      const context = data(prompt);
      if (context.phase === 'gap-analysis') { gapCalls.push(context); return { data: { summary: '수요 자료가 부족합니다.', userQuestions: [{ question: '현재 유료 고객이 있나요?', why: '수요 확인' }], researchQueries: [{ query: '중소기업 개발 구독 시장 규모', purpose: '수요', kind: 'official' }] } }; }
      assert.ok(schema.required.includes('suitable'));
      return { data: { score: 95, suitable: true, issues: [], strengths: [] } };
    },
    judgeVerdict: async ({ order }) => { assert.equal(order.length, 2); const yes = yesSamples[sample++ % yesSamples.length]; return { choice: yes >= 0.5 ? 'YES' : 'NO', probabilities: { YES: yes, NO: Math.round((1 - yes) * 100) / 100 } }; },
  });
  return { run, revisions, gapCalls };
}
const input = { question: '작게 시험할까요?', opinions: [source('codex'), source('claude')], apiKey: 'k', cwd: 'fixture', timeoutMs: 1000, gateLevel: 'strict', readiness: 92 };

test('weak answers are revised with JEV comments, the verdict is sampled five times and a passing gate confirms the report', async () => {
  let rounds = 0;
  const { run, revisions } = setup({ yesSamples: [0.8, 0.78, 0.82, 0.79, 0.81], scoreFor: (opinion, index) => /보완/.test(opinion.text) ? 85 : (index === 0 ? 60 : 84) });
  const result = await run({ ...input, onProgress: progress => { if (progress.stage === 'quality-revising') rounds++; } });
  assert.equal(rounds, 1);
  assert.equal(revisions.length, 1);
  assert.ok(revisions[0].comments.some(comment => comment.includes('다음 수준에 필요한 것: 주요 전제와 한계를 설명')));
  assert.equal(result.verdict.interval.n, 5);
  assert.equal(result.gate.passed, true);
  assert.equal(result.synthesis.status, 'complete');
  assert.equal(result.synthesis.confirmed, true);
  assert.ok(result.qualityAverage >= 80);
});

test('an unstable verdict withholds the report, skips final writing and names what is missing', async () => {
  const { run, gapCalls } = setup({ yesSamples: [0.6, 0.45, 0.7, 0.55, 0.62], scoreFor: () => 90 });
  const result = await run(input);
  assert.equal(result.gate.passed, false);
  assert.equal(result.gate.checks.find(check => check.id === 'interval').passed, false);
  assert.equal(result.synthesis.status, 'withheld');
  assert.equal(result.synthesis.confirmed, false);
  assert.equal(result.synthesis.missing.userQuestions[0].question, '현재 유료 고객이 있나요?');
  assert.equal(gapCalls.length, 1);
  const html = buildReportHtml({ question: 'q', createdAt: '2026-11-04T00:00:00Z', opinions: [], evaluation: result });
  assert.match(html, /판단 불가/);
  assert.match(html, /이 문서는 최종 보고서가 아닙니다/);
  assert.ok(!html.includes('최종 권고</h2>'));
});

test('quality revision stops after the round limit', async () => {
  const { run, revisions } = setup({ yesSamples: [0.9], scoreFor: () => 50 });
  const result = await run(input);
  assert.equal(revisions.length, MAX_QUALITY_ROUNDS * 2);
  assert.equal(result.gate.passed, false);
  assert.equal(result.qualityRounds.length, MAX_QUALITY_ROUNDS);
});

test('a withheld run asks the missing questions, then ends inconclusive after the cycle limit', async () => {
  const researched = [], completed = [];
  const preparation = () => ({ version: 1, plans: [{ providerId: 'claude', status: 'success' }], questions: [], searches: [], judgment: { items: [] }, readiness: 95,
    interview: { version: 1, target: 90, maxRounds: 5, rounds: [{ round: 1, score: 95, questionCount: 0 }] } });
  const withheld = { verdict: { choice: 'YES' }, qualityAverage: 70, gate: { passed: false, checks: [] },
    synthesis: { status: 'withheld', missing: { summary: '부족', userQuestions: [{ question: '고객이 있나요?', why: '수요' }], researchQueries: [{ query: '시장 규모', purpose: '수요', kind: 'official' }] } } };
  const service = createDecisionService({
    providers: [{ id: 'claude', name: 'Claude' }], getApiKey: () => 'k', store: { saveRecord: async () => {} }, onEvent: event => { if (event.type === 'complete') completed.push(event.record.status); },
    researchService: { prepare: async () => preparation(), reassess: async input => ({ round: input.round, score: 95, assessments: [], questions: [] }),
      research: async input => { researched.push(structuredClone(input.preparation.gapSearches || [])); return { status: 'complete', sources: [{ id: 'S1' }], context: 'e [S1]' }; } },
    getOpinion: async id => ({ providerId: id, status: 'success', text: 'O [S1]' }),
    evaluate: async () => structuredClone(withheld),
  });
  const { runId } = service.start({ question: '사업을 해도 될까요?' }, { model: 'jev-x', timeoutMs: 1000, gateLevel: 'strict' });
  await service.wait();
  assert.equal(service.active().status, 'awaiting_input');
  assert.deepEqual(service.active().preparation.questions.map(item => item.id), ['c1q1']);
  service.continue({ runId, answers: { c1q1: '없음' } });
  await service.wait();
  assert.deepEqual(service.active().preparation.questions.map(item => item.id), ['c2q1']);
  service.continue({ runId, answers: { c2q1: '없음' } });
  await service.wait();
  assert.equal(service.active(), null);
  assert.deepEqual(completed, ['inconclusive']);
  assert.equal(researched.length, 3);
  assert.equal(researched[1][0].query, '시장 규모');
});

test('two opinions alternate order across samples and the writer sees the quality-revised answers', async () => {
  const orders = [];
  let finalContext;
  const run = createSynthesizedEvaluation({
    evaluate: async passed => evaluation(passed.opinions, passed.phase, opinion => /보완/.test(opinion.text) ? 90 : 60),
    getOpinion: async (id, _q, { prompt }) => {
      const context = data(prompt);
      if (context.phase === 'verification') return { ...report(id + ' 검증 의견'), title: id + ' 검증' };
      if (context.phase === 'quality-revision') return { ...report(id + ' 보완된 답변'), title: id + ' 보완' };
      finalContext = context;
      return report('모든 의견을 종합한 최종 권고');
    },
    getStructured: async () => ({ data: { score: 95, suitable: true, issues: [], strengths: [] } }),
    judgeVerdict: async ({ order }) => { orders.push(order.join('')); return { choice: 'YES', probabilities: { YES: 0.85, NO: 0.15 } }; },
  });
  const result = await run(input);
  assert.deepEqual(orders, ['01', '10', '10', '01', '01']);
  assert.ok(finalContext.reviews.every(row => /보완된 답변/.test(row.text)));
  assert.ok(result.revisedOpinions.every(row => /보완된 답변/.test(row.text)));
  assert.equal(result.gate.passed, true);
});

test('a gated run whose writers all fail is never shown as a conclusion', async () => {
  const run = createSynthesizedEvaluation({
    evaluate: async passed => evaluation(passed.opinions, passed.phase, () => 90),
    getOpinion: async (id, _q, { prompt }) => data(prompt).phase === 'verification' ? { ...report(id + ' 검증'), title: id } : { status: 'success', stance: 'NO', title: 'x', text: 'x', point: 'x' },
    getStructured: async () => ({ data: { score: 95, suitable: true, issues: [], strengths: [] } }),
    judgeVerdict: async () => ({ choice: 'YES', probabilities: { YES: 0.9, NO: 0.1 } }),
  });
  const result = await run(input);
  assert.equal(result.synthesis.status, 'error');
  assert.equal(result.gate.passed, false);
});

test('borderline bounds, unscored readiness and an unsuitable review all fail the gate', () => {
  const interval = { choice: 'YES', n: 5, lower: 0.7, rawLower: 0.6996 };
  const base = { level: 'strict', opinionScores: [{ total: 90 }], reviewScore: 95, reviewPassed: true, readiness: 95 };
  assert.equal(evaluateGate({ ...base, interval }).checks[0].passed, false);
  assert.equal(evaluateGate({ ...base, interval: { ...interval, rawLower: 0.71 }, readiness: null }).checks.find(check => check.id === 'readiness').passed, false);
  assert.equal(evaluateGate({ ...base, interval: { ...interval, rawLower: 0.71 }, readiness: undefined }).passed, true);
  assert.equal(evaluateGate({ ...base, interval: { ...interval, rawLower: 0.71 }, reviewPassed: false }).checks.find(check => check.id === 'review').passed, false);
});
