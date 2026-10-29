'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { RUBRIC, DEFAULT_CONFIDENCE_THRESHOLD, buildEvaluationRequest, parseEvaluationResponse,
  evaluate, inspectConnection } = require('../services/jev.cjs');

const opinions = [
  { providerId: 'claude', name: 'Claude', model: 'claude-x', text: '일정과 자원을 확인한 뒤 진행할 수 있습니다.' },
  { providerId: 'codex', name: 'ChatGPT', model: 'gpt-x', text: '검증되지 않은 조건 때문에 보류를 권합니다.' },
  { providerId: 'gemini', name: 'Gemini', model: 'gemini-x', text: '실행 전 위험을 확인하고 대안을 마련하세요.' },
];
const input = { question: '팀의 도구를 변경해야 할까요?', opinions };
function payloadFor(request, { level = 3, choice = 'YES', confidence = 0.8 } = {}) {
  const answers = {};
  for (const [id, question] of Object.entries(request.questions)) {
    answers[id] = question.type === 'score' ? {
      type: 'score', score: level, confidence: 1,
      probabilities: Object.fromEntries(question.criteria.map((_, i) => [String(i), i === level ? 1 : 0])),
      legend: Object.fromEntries(question.criteria.map((description, i) => [String(i), description])),
    } : {
      type: 'choice', choice: id === 'verdict' ? choice : 'EVIDENCE', confidence,
      probabilities: Object.fromEntries(Object.keys(question.criteria).map(key => [key,
        key === (id === 'verdict' ? choice : 'EVIDENCE') ? .9 : .1 / (Object.keys(question.criteria).length - 1)])),
    };
  }
  return { model: 'jev-1.13.0', answers, usage: { input_tokens: 1234, output_tokens: 32 } };
}
const request = buildEvaluationRequest(input);
const clone = (value) => structuredClone(value);
const response = (payload, status = 200, retryAfter = null) => ({
  status, ok: status >= 200 && status < 300,
  headers: { get: () => retryAfter }, json: async () => payload,
});
const fakeKey = 'test-key-never-a-real-credential';

test('rubric has four five-level dimensions summing to 100 and an independent final Choice', () => {
  assert.equal(RUBRIC.length, 4);
  assert.equal(RUBRIC.reduce((sum, d) => sum + d.weight, 0), 100);
  assert.ok(RUBRIC.every((d) => d.levels.length === 5 && d.levels.every((v) => v.length > 10)));
  assert.equal(Object.keys(request.questions).length, 16);
  assert.deepEqual(Object.keys(request.questions.verdict.criteria), ['YES', 'NO', 'CONDITIONAL']);
  assert.equal(request.questions.verdict.type, 'choice');
  assert.match(request.questions.verdict.instructions, /품질 점수/);
  assert.match(request.questions.verdict.instructions, /모든 후보 의견의 근거를 종합/);
  assert.match(request.questions.verdict.instructions, /어느 후보나 모델을 선택하는 문제가 아닙니다/);
  assert.match(request.questions.verdict.instructions, /조건부 실행/);
  assert.match(request.questions.verdict.criteria.CONDITIONAL, /조건부 권고/);
});

test('provider metadata is excluded and every score instruction explicitly identifies its target', () => {
  const state = JSON.stringify(request.state);
  for (const name of ['claude', 'ChatGPT', 'Gemini', 'gpt-x', 'gemini-x']) assert.ok(!state.includes(name));
  assert.equal(request.state.candidates[0].id, 'candidate_1');
  for (const [key, question] of Object.entries(request.questions)) {
    if (question.type === 'score') assert.ok(question.instructions.includes(key.match(/^candidate_\d/)[0]));
  }
});

test('normalization uses score / 4 times weight; perfect quality can independently yield NO', () => {
  const result = parseEvaluationResponse(payloadFor(request, { level: 4, choice: 'NO' }), opinions);
  assert.equal(result.qualityAverage, 100);
  assert.deepEqual(result.opinions[0].dimensions.map((d) => d.points), [30, 30, 25, 15]);
  assert.equal(result.verdict.choice, 'NO');
  assert.equal(result.verdict.rawChoice, 'NO');
  assert.equal(result.verdict.gateApplied, false);
  assert.equal(result.rubricVersion, '2026-10-29.1');
  assert.ok(!Number.isNaN(Date.parse(result.evaluatedAt)));
});

test('a high-confidence low score is still low quality; score confidence is not a correctness percentage', () => {
  const result = parseEvaluationResponse(payloadFor(request, { level: 0 }), opinions);
  assert.equal(result.qualityAverage, 0);
  assert.equal(result.opinions[0].dimensions[0].confidence, 1);
  assert.equal(result.opinions[0].dimensions[0].points, 0);
  assert.equal(result.verdict.choice, 'YES');
});

test('fractional expected scores are accepted and normalized correctly', () => {
  const payload = payloadFor(request);
  const dimension = payload.answers.candidate_1_logic;
  dimension.score = 2.5;
  dimension.probabilities = { 0: 0, 1: 0, 2: 0.5, 3: 0.5, 4: 0 };
  const result = parseEvaluationResponse(payload, opinions);
  assert.equal(result.opinions[0].dimensions[0].points, 18.75);
  assert.equal(result.opinions[0].total, 71.25);
});

test('low concentration never suppresses a best current recommendation, even with a legacy threshold option', () => {
  assert.equal(DEFAULT_CONFIDENCE_THRESHOLD, 0);
  for (const choice of ['YES', 'NO', 'CONDITIONAL']) {
    const payload = payloadFor(request, { choice, confidence: 0.2 });
    for (const options of [{}, { confidenceThreshold: 0.9 }]) {
      const result = parseEvaluationResponse(payload, opinions, options);
      assert.equal(result.verdict.choice, choice);
      assert.equal(result.verdict.rawChoice, choice);
      assert.equal(result.verdict.gateApplied, false);
      assert.equal(result.verdict.reasonCode, null);
      assert.equal(result.verdict.thresholdProvisional, false);
      assert.equal(result.verdict.confidenceThreshold, 0);
      assert.deepEqual(result.verdict.probabilities, payload.answers.verdict.probabilities);
    }
  }
});

test('one or two valid opinions preserve independent YES and NO outcomes without a count gate', () => {
  for (const count of [1, 2]) {
    for (const choice of ['YES', 'NO']) {
      const partial = opinions.slice(0, count);
      const payload = payloadFor(buildEvaluationRequest({ ...input, opinions: partial }), { choice, level:choice==='YES'?0:4 });
      const result = parseEvaluationResponse(payload, partial);
      assert.equal(result.opinions.length, count);
      assert.equal(result.verdict.choice, choice);
      assert.equal(result.verdict.rawChoice, choice);
      assert.equal(result.verdict.reasonCode, null);
      assert.equal(result.verdict.gateApplied, false);
      assert.equal(result.qualityAverage, choice==='YES'?0:100);
    }
  }
});

test('a single successful opinion is not forced to HOLD by concentration or provider count', () => {
  const partial=opinions.slice(0,1);
  const payload=payloadFor(buildEvaluationRequest({...input,opinions:partial}),{choice:'NO',confidence:.2});
  const result=parseEvaluationResponse(payload,partial);
  assert.equal(result.verdict.choice,'NO');
  assert.equal(result.verdict.rawChoice,'NO');
  assert.equal(result.verdict.reasonCode,null);
  assert.equal(result.verdict.gateApplied,false);
});

test('missing, mismatched and out-of-range API fields are rejected without any score result', () => {
  const mutations = [
    (p) => { delete p.answers.candidate_1_logic; },
    (p) => { p.answers.extra = {}; },
    (p) => { p.model = null; },
    (p) => { p.usage.input_tokens = -1; },
    (p) => { p.usage.output_tokens = 1.5; },
    (p) => { delete p.usage; },
    (p) => { p.answers.candidate_1_logic.type = 'choice'; },
    (p) => { p.answers.candidate_1_logic.score = 5; },
    (p) => { p.answers.candidate_1_logic.score = -0.1; },
    (p) => { p.answers.candidate_1_logic.score = NaN; },
    (p) => { p.answers.candidate_1_logic.score = Infinity; },
    (p) => { p.answers.candidate_1_logic.score = '3'; },
    (p) => { p.answers.candidate_1_logic.confidence = 1.01; },
    (p) => { p.answers.candidate_1_logic.probabilities[0] = -1; },
    (p) => { p.answers.candidate_1_logic.probabilities[0] = 0.5; },
    (p) => { delete p.answers.candidate_1_logic.probabilities[0]; },
    (p) => { p.answers.candidate_1_logic.probabilities[0] = '0'; },
    (p) => { p.answers.candidate_1_logic.score = 1; },
    (p) => { delete p.answers.candidate_1_logic.legend[0]; },
    (p) => { p.answers.candidate_1_logic.legend[0] = 'changed description'; },
    (p) => { delete p.answers.candidate_1_focus; },
    (p) => { p.answers.candidate_1_focus.choice = 'UNKNOWN'; },
    (p) => { p.answers.candidate_1_focus.choice = 'LOGIC'; },
    (p) => { p.answers.candidate_1_focus.confidence = -1; },
    (p) => { delete p.answers.candidate_1_focus.probabilities.NONE; },
    (p) => { p.answers.verdict.choice = 'HOLD'; },
    (p) => { p.answers.verdict.choice = 'MAYBE'; },
    (p) => { p.answers.verdict.type = 'score'; },
    (p) => { p.answers.verdict.choice = 'NO'; },
    (p) => { p.answers.verdict.confidence = NaN; },
    (p) => { delete p.answers.verdict.probabilities.CONDITIONAL; },
  ];
  for (const mutate of mutations) {
    const payload = payloadFor(request);
    mutate(payload);
    assert.throws(() => parseEvaluationResponse(payload, opinions), { code: 'INVALID_RESPONSE' });
  }
});

test('real jev-1.14.0 rounded score distributions retain raw scores without recomputing them', () => {
  const payload = payloadFor(request);
  Object.assign(payload.answers.candidate_1_logic, {
    score: 3.89, confidence: 0.92, probabilities: { 0: 0, 1: 0, 2: 0, 3: 0.1, 4: 0.9 },
  });
  Object.assign(payload.answers.candidate_1_risk, {
    score: 3.47, confidence: 0.54, probabilities: { 0: 0.01, 1: 0.01, 2: 0.01, 3: 0.46, 4: 0.51 },
  });
  const result = parseEvaluationResponse(payload, opinions);
  assert.equal(result.opinions[0].dimensions[0].rawScore, 3.89);
  assert.equal(result.opinions[0].dimensions[2].rawScore, 3.47);
  assert.equal(result.opinions[0].dimensions[2].points, 21.69);
  assert.deepEqual(result.opinions[0].dimensions[2].probabilities, payload.answers.candidate_1_risk.probabilities);
});

test('probability sums 0.99 and 1.01 caused by two-decimal rounding are accepted unchanged', () => {
  for (const p3 of [0.61, 0.63]) {
    const payload = payloadFor(request);
    Object.assign(payload.answers.candidate_1_relevance, {
      score: 3.34, confidence: 0.68, probabilities: { 0: 0, 1: 0, 2: 0.02, 3: p3, 4: 0.36 },
    });
    payload.answers.verdict.probabilities = { YES: p3 === 0.61 ? 0.89 : 0.91, NO: 0.05, CONDITIONAL: 0.05 };
    const result = parseEvaluationResponse(payload, opinions);
    assert.equal(result.opinions[0].dimensions[3].probabilities[3], p3);
    assert.deepEqual(result.verdict.probabilities, payload.answers.verdict.probabilities);
  }
});

test('rounding allowance still rejects impossible mass, gross score mismatch and out-of-range probabilities', () => {
  const invalid = [
    (p) => { p.answers.candidate_1_logic.probabilities = { 0: 0, 1: 0, 2: 0, 3: 0.1, 4: 0.93 }; },
    (p) => { p.answers.candidate_1_logic.probabilities = { 0: 0, 1: 0, 2: 0, 3: 0.1, 4: 0.9 }; p.answers.candidate_1_logic.score = 3.8; },
    (p) => { p.answers.candidate_1_logic.probabilities[0] = -0.001; },
    (p) => { p.answers.verdict.probabilities = { YES: 0.93, NO: 0.05, CONDITIONAL: 0.05 }; },
  ];
  for (const mutate of invalid) {
    const payload = payloadFor(request);
    mutate(payload);
    assert.throws(() => parseEvaluationResponse(payload, opinions), { code: 'INVALID_RESPONSE' });
  }
});

test('input validation rejects duplicate identities, empty text, malformed model and threshold', () => {
  const invalid = [
    { ...input, question: '' }, { ...input, opinions: [] },
    { ...input, opinions: [opinions[0], opinions[0]] },
    { ...input, opinions: [{ providerId: 'a', text: '' }] },
    { ...input, model: 'bad\nmodel' }, { ...input, confidenceThreshold: NaN },
  ];
  for (const value of invalid) assert.throws(() => buildEvaluationRequest(value), { code: 'INVALID_INPUT' });
});

test('evaluate posts all questions once with Bearer auth and reports completion', async () => {
  const progress = [];
  let calls = 0;
  const result = await evaluate({ ...input, apiKey: fakeKey, onProgress: (p) => progress.push(p), fetchImpl: async (url, options) => {
    calls += 1;
    assert.equal(url, 'https://api.typesafe.ai/v1/systemone');
    assert.equal(options.method, 'POST');
    assert.equal(options.headers.Authorization, `Bearer ${fakeKey}`);
    assert.ok(options.signal instanceof AbortSignal);
    return response(payloadFor(JSON.parse(options.body)));
  } });
  assert.equal(calls, 1);
  assert.equal(result.qualityAverage, 75);
  assert.deepEqual(progress.map((p) => p.stage), ['jev-evaluating', 'jev-complete']);
});

test('429, 503 and 529 are retried at most twice, then surfaced safely', async () => {
  for (const status of [429, 503, 529]) {
    let calls = 0;
    const options = { ...input, apiKey: fakeKey, fetchImpl: async () => {
      calls += 1;
      return response({ secret: fakeKey }, status, '0.001');
    } };
    await assert.rejects(evaluate(options), (error) => {
      assert.ok(['RATE_LIMIT', 'UNAVAILABLE'].includes(error.code));
      assert.ok(!error.message.includes(fakeKey));
      return true;
    });
    assert.equal(calls, 3);
  }
});

test('transient failure can recover without duplicating the evaluation result', async () => {
  let calls = 0;
  const result = await evaluate({ ...input, apiKey: fakeKey, fetchImpl: async () => {
    calls += 1;
    return calls === 1 ? response(null, 529, '0.001') : response(payloadFor(request));
  } });
  assert.equal(calls, 2);
  assert.equal(result.opinions.length, 3);
});

test('authentication failure is not retried and its body is never read', async () => {
  let calls = 0;
  await assert.rejects(evaluate({ ...input, apiKey: fakeKey, fetchImpl: async () => {
    calls += 1;
    return { status: 401, ok: false, json: () => { throw new Error(fakeKey); } };
  } }), { code: 'AUTH_ERROR' });
  assert.equal(calls, 1);
});

test('raw network and JSON errors are replaced with safe messages', async () => {
  for (const fetchImpl of [
    async () => { throw new Error(fakeKey); },
    async () => ({ status: 200, ok: true, json: () => { throw new Error(fakeKey); } }),
  ]) {
    await assert.rejects(evaluate({ ...input, apiKey: fakeKey, fetchImpl }), (error) => {
      assert.ok(!error.message.includes(fakeKey));
      assert.ok(['NETWORK_ERROR', 'INVALID_RESPONSE'].includes(error.code));
      return true;
    });
  }
});

test('pre-cancel avoids network calls and in-flight cancellation works even for an uncooperative fetch', async () => {
  const controller = new AbortController();
  controller.abort(new Error(fakeKey));
  let calls = 0;
  await assert.rejects(evaluate({ ...input, apiKey: fakeKey, signal: controller.signal, fetchImpl: () => { calls += 1; } }), { code: 'CANCELLED' });
  assert.equal(calls, 0);
  const active = new AbortController();
  const pending = evaluate({ ...input, apiKey: fakeKey, signal: active.signal, fetchImpl: () => { calls += 1; return new Promise(() => {}); } });
  active.abort(new Error(fakeKey));
  await assert.rejects(pending, { code: 'CANCELLED' });
  assert.equal(calls, 0);
  const started = new AbortController();
  const inFlight = evaluate({ ...input, apiKey: fakeKey, signal: started.signal, fetchImpl: () => { calls += 1; return new Promise(() => {}); } });
  await new Promise((resolve) => setImmediate(resolve));
  started.abort();
  await assert.rejects(inFlight, { code: 'CANCELLED' });
  assert.equal(calls, 1);
});

test('retry wait is abortable; timeout covers fetch and response decoding', async () => {
  const controller = new AbortController();
  let calls = 0;
  const pending = evaluate({ ...input, apiKey: fakeKey, signal: controller.signal,
    onProgress: (p) => { if (p.stage === 'jev-retrying') controller.abort(); },
    fetchImpl: async () => { calls += 1; return response(null, 429, '10'); },
  });
  await assert.rejects(pending, { code: 'CANCELLED' });
  assert.equal(calls, 1);
  for (const fetchImpl of [() => new Promise(() => {}), async () => ({ status: 200, ok: true, json: () => new Promise(() => {}) })]) {
    await assert.rejects(evaluate({ ...input, apiKey: fakeKey, timeoutMs: 15, fetchImpl }), { code: 'TIMEOUT' });
  }
});

test('inspectConnection handles missing key, official model shape and safe failures', async () => {
  assert.deepEqual(await inspectConnection({}), { configured: false, connected: false, models: [], message: 'JEV_API_KEY를 설정해 주세요.' });
  const result = await inspectConnection({ apiKey: fakeKey, fetchImpl: async (url, options) => {
    assert.equal(url, 'https://api.typesafe.ai/v1/models');
    assert.equal(options.method, 'GET');
    return response({ models: [{ name: 'jev-latest', description: 'General', release_date: '2026-09-15' }] });
  } });
  assert.equal(result.connected, true);
  assert.deepEqual(result.models, ['jev-latest']);
  const failure = await inspectConnection({ apiKey: fakeKey, fetchImpl: async () => { throw new Error(fakeKey); } });
  assert.equal(failure.connected, false);
  assert.ok(!failure.message.includes(fakeKey));
  const malformed = await inspectConnection({ apiKey: fakeKey, fetchImpl: async () => response({ models: ['jev-latest'] }) });
  assert.equal(malformed.connected, false);
});
