'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const jev = require('../services/jev.cjs');
const cli = require('../services/cli.cjs');
const { createSynthesizedEvaluation } = require('../services/synthesis.cjs');
const { createDecisionService } = require('../services/decision.cjs');

const originals = ['claude', 'codex'].map(providerId => ({ providerId, status: 'success', stance: 'YES', text: `${providerId}의 기존 근거`, title: '원래 의견', point: '먼저 조건 확인' }));
const question = '작게 시험할까요?';
function payload(body, choice) {
  return { model: 'jev-test', usage: { input_tokens: 100, output_tokens: 10 }, answers: Object.fromEntries(Object.entries(body.questions).map(([key, q]) => [key, q.type === 'score' ? {
    type: 'score', score: 3, confidence: 1,
    probabilities: { 0: 0, 1: 0, 2: 0, 3: 1, 4: 0 },
    legend: Object.fromEntries(q.criteria.map((label, index) => [String(index), label])),
  } : { type: 'choice', choice: key === 'verdict' ? choice : 'RISK', confidence: .4,
    probabilities: Object.fromEntries(Object.keys(q.criteria).map(k => [k, k === (key === 'verdict' ? choice : 'RISK') ? 1 : 0])),
  }])) };
}
function finalReport() {
  return [
    '[판단]',
    '현재 행동: 전체 도입은 실행하지 말고 격리된 시험 환경을 준비합니다.',
    '선행 조건: 원본 사본으로 복구를 실행하여 복구 결과가 원본과 일치하는지 확인합니다.',
    '충족 시: 격리된 환경에서 작은 시험을 실행합니다.',
    '미충족 시: 도입하지 않고 원본을 유지합니다.',
    '[선택 이유]', '두 검토가 보완한 핵심 위험은 복구 실패입니다. 복구를 먼저 확인하면 원본 손상을 피하면서 기능을 시험할 수 있습니다.',
    '[대안 비교]', '바로 전체 도입하면 복구 확인 전 원본에 영향을 줍니다. 격리된 시험은 실패 범위를 제한할 수 있어 먼저 선택합니다.',
    '[실행 계획]', '먼저 원본 사본을 보관합니다. 이어 격리 환경에서 복구를 실행하고 원본과 일치하는지 확인한 뒤 시험 결과를 기록합니다.',
    '[위험과 대응]', '복구 결과가 원본과 다르면 시험을 중단합니다. 원본은 유지하고 실패 원인을 확인하기 전에는 전체 도입하지 않습니다.',
    '[결론 변경 조건]', '복구 결과가 원본과 일치하고 기능 검사가 통과하면 제한된 도입으로 권고를 바꿉니다. 실패하면 도입하지 않습니다.',
  ].join('\n\n');
}
const initial = () => jev.parseEvaluationResponse(payload(jev.buildEvaluationRequest({ question, opinions: originals }), 'YES'), originals);

test('real structured feedback maps each candidate to a bounded actionable review focus', () => {
  const evaluation = initial();
  assert.deepEqual(evaluation.feedback.map(row => [row.providerId, row.focus, row.label]), [
    ['claude', 'RISK', '위험·대안 보완'], ['codex', 'RISK', '위험·대안 보완'],
  ]);
  assert.equal(evaluation.phase, 'initial');
});

test('refined JEV sees anonymous originals, actual initial scores and reviewed-to-original mapping without metadata leakage', () => {
  const evaluation = initial();
  evaluation.privateSecret = 'do-not-send';
  evaluation.opinions[0].privateSecret = 'do-not-send';
  const body = jev.buildEvaluationRequest({ question, opinions: [{ ...originals[1], text: '수정된 공개 근거' }], phase: 'refined',
    reviewContext: { originalOpinions: originals.map(o => ({ ...o, apiKey: 'do-not-send', debate: { secret: 'do-not-send' } })), initialEvaluation: evaluation },
  });
  assert.equal(body.state.phase, 'refined');
  const context = body.state.reviewContext;
  assert.deepEqual(context.candidate_origins, { candidate_1: 'source_2' });
  assert.equal(context.original_candidates[0].text, originals[0].text);
  assert.equal(context.initial_assessment.verdict, 'YES');
  assert.equal(context.initial_assessment.opinions[0].total, 75);
  assert.equal(context.initial_assessment.feedback[0].focus, 'RISK');
  // Names embedded in source text remain data, but no identifying metadata fields are transmitted.
  const clean = { ...body.state, candidates: [], reviewContext: { ...context, original_candidates: [] } };
  assert.ok(!JSON.stringify(clean).includes('claude'));
  assert.ok(!JSON.stringify(body).includes('do-not-send'));
  assert.match(body.questions.verdict.instructions, /필요하면 방향을 바꾸세요/);
  assert.throws(() => jev.buildEvaluationRequest({ question, opinions: originals, phase: 'refined' }), { code: 'INVALID_INPUT' });
  assert.throws(() => jev.buildEvaluationRequest({ question, opinions: [{ providerId: 'unknown', text: '근거' }], phase: 'refined', reviewContext: { originalOpinions: originals, initialEvaluation: evaluation } }), { code: 'INVALID_INPUT' });
});

test('the real JEV parser and CLI parser integrate through two judging calls and permit a changed conditional final recommendation', async () => {
  const bodies = [], inferencePrompts = [];
  const evaluate = options => jev.evaluate({ ...options, fetchImpl: async (_url, request) => {
    const body = JSON.parse(request.body); bodies.push(body);
    return { ok: true, status: 200, json: async () => payload(body, body.state.phase === 'initial' ? 'YES' : 'CONDITIONAL') };
  } });
  const run = createSynthesizedEvaluation({ evaluate, getOpinion: async (providerId, _q, { prompt }) => {
    inferencePrompts.push(prompt);
    const final = prompt.includes('"phase":"final-synthesis"');
    return { status: 'success', ...cli.parseOpinion(providerId, JSON.stringify({ stance: 'CONDITIONAL', title: final ? '조건을 확인한 뒤 시작' : '판정을 검증했습니다', body: final ? finalReport() : `${providerId} 검증: 최초 판정의 위험 보완을 수용하되 불명확한 가정을 조건으로 바꾸었습니다.`, point: '작은 시험의 중단 기준을 정하세요.' })) };
  } });
  const result = await run({ question, opinions: originals, apiKey: 'fake-local-test-key', timeoutMs: 1000 });
  assert.equal(bodies.length, 2);
  assert.equal(inferencePrompts.length, 3);
  assert.equal(result.refinement.initialEvaluation.verdict.choice, 'YES');
  assert.equal(result.refinement.reviewedEvaluation.phase, 'refined');
  assert.equal(result.verdict.choice, 'CONDITIONAL');
  assert.equal(result.synthesis.stance, 'CONDITIONAL');
  assert.equal(result.synthesis.status, 'complete');
  assert.equal(result.usage.input_tokens, 200);
  assert.equal(bodies[1].state.candidates.length, 2);
});

test('review progress snapshots survive run storage and a failed reviewer makes the run partial', async () => {
  const rows = [{ providerId: 'claude', status: 'complete', text: '보완 근거' }, { providerId: 'codex', status: 'error', error: '인증 실패' }];
  const records = [], events = [];
  const service = createDecisionService({ providers: originals.map(o => ({ id: o.providerId, name: o.providerId })),
    getOpinion: async id => originals.find(o => o.providerId === id),
    evaluate: async ({ onProgress }) => {
      onProgress({ stage: 'model-reviewing', reviews: rows });
      rows[0].text = '외부 변경';
      return { verdict: { choice: 'CONDITIONAL' }, refinement: { reviews: rows }, synthesis: { status: 'complete' } };
    }, store: { saveRecord: async r => records.push(structuredClone(r)) }, getApiKey: () => 'fake-key', onEvent: e => events.push(e),
  });
  service.start({ question }, { model: 'jev-latest', timeoutMs: 1000 }); await service.wait();
  assert.equal(records[0].status, 'partial');
  assert.equal(records[0].refinementProgress[0].text, '보완 근거');
  assert.equal(events.find(e => e.record.evaluationStage === 'model-reviewing').record.refinementProgress[0].text, '보완 근거');
});
