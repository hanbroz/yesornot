'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createSynthesizedEvaluation } = require('../services/synthesis.cjs');
const source = (providerId, text = providerId + ' 원래 의견') => ({ providerId, status: 'success', stance: 'YES', title: '출처', text, point: '원래 조건', debate: { agents: [{ text: '원래 토론' }] } });
const reply = (text = '검증 결과 실행 조건과 반론을 수정한 새로운 의견', stance = 'CONDITIONAL', overrides = {}) => ({ status: 'success', stance, title: '조건을 확인하고 작게 실행', text, point: '오늘 필요한 자원을 확인하세요.', model: 'fixture-model', ...overrides });
function finalReply(text = '검증 결과를 통합한 별도의 실행 권고입니다.', stance = 'CONDITIONAL', overrides = {}) {
  const decision = stance === 'CONDITIONAL'
    ? '현재 행동: 전체 도입은 실행하지 말고 시험 환경을 준비합니다.\n선행 조건: 원본을 복구할 수 있는지 시험 환경에서 확인합니다.\n충족 시: 격리된 환경에서 한 번 시험합니다.\n미충족 시: 원본을 유지하고 도입하지 않습니다.'
    : stance === 'NO' ? '지금 전체 도입은 하지 마세요. 원본을 유지하고 격리된 시험으로 대체합니다.'
      : '지금 격리된 환경의 시험을 실행하세요. 검증된 복구 절차를 먼저 준비합니다.';
  return reply([
    '[판단]', text, decision,
    '[선택 이유]', '검토에서 확인한 복구 가능성을 우선합니다. 원본을 보존하면 실패 시 피해 범위를 제한할 수 있습니다.',
    '[대안 비교]', '전체 도입은 복구 확인 전에 원본에 영향을 줍니다. 격리 시험은 같은 기능을 확인하면서 원본을 유지하므로 먼저 선택합니다.',
    '[실행 계획]', '먼저 원본 사본을 보관합니다. 이어 격리 환경에서 복구를 실행하고 원본과 일치하는지 확인한 뒤 시험 결과를 기록합니다.',
    '[위험과 대응]', '복구 결과가 원본과 다르면 시험을 중단하고 원본을 유지합니다. 일치 여부를 확인하기 전에는 전체 도입을 하지 않습니다.',
    '[결론 변경 조건]', '격리 시험에서 복구 결과가 원본과 일치하고 기능 검사가 통과하면 제한된 도입으로 권고를 바꿉니다. 실패하면 도입하지 않습니다.',
  ].join('\n\n'), stance, { point: '먼저 원본 사본을 보관하고 격리 환경에서 복구 결과를 확인하세요.', ...overrides });
}
const data = prompt => JSON.parse(prompt.slice(prompt.lastIndexOf('\n') + 1));
function evaluation(ids = ['codex', 'claude'], choice = 'YES', phase = 'initial') {
  return { model: 'fixture-jev-' + phase, evaluatedAt: '2026-10-23', verdict: { choice, rawChoice: choice, confidence: .3, gateApplied: false, probabilities: { YES: .4, NO: .3, CONDITIONAL: .3 } },
    opinions: ids.map((providerId, index) => ({ providerId, total: 70 + index * 20, dimensions: [{ id: 'logic', weight: 30, points: 20, rawScore: 2.67, maxScore: 4, legend: { 0: 'fixture' }, probabilities: { 0: 1 } }] })),
    qualityAverage: 80, rubricVersion: 'fixture', usage: { input_tokens: 100, output_tokens: 20 },
    feedback: ids.map(providerId => ({ providerId, focus: 'risk', label: '빠진 위험과 조건을 보완', confidence: .7, probabilities: { risk: .7, logic: .3 } })) };
}
function options(overrides = {}) { return { question: '작게 시험할까요?', opinions: [source('codex'), source('claude')], apiKey: 'never-forward-private-key', cwd: 'isolated-fixture', timeoutMs: 1000, ...overrides }; }
function defaultEvaluate(passed) { return evaluation(passed.opinions.map(o => o.providerId), passed.phase === 'initial' ? 'YES' : 'CONDITIONAL', passed.phase); }
function defaultOpinion(id, _, { prompt }) { return data(prompt).phase === 'verification' ? reply(id + ' 조언 검증·수정 의견') : finalReply('모든 검증 결과를 합친 새로운 최종 실행 권고'); }

test('one bounded feedback loop supplies complete judge context to every independent reviewer and combines all reviewed sources', async () => {
  const events = [], calls = [], judgments = [], releases = {};
  const input = options({ opinions: [...options().opinions, { providerId: 'gemini', status: 'error', text: 'excluded failed content' }] });
  const before = structuredClone(input);
  const run = createSynthesizedEvaluation({
    evaluate: async passed => {
      judgments.push(passed.phase);
      if (passed.phase === 'refined') {
        assert.equal(calls.filter(c => c.phase === 'verification').length, 2);
        assert.deepEqual(passed.opinions.map(o => o.providerId), ['codex', 'claude']);
        assert.ok(passed.opinions.every(o => o.status === 'success' && o.stance === 'CONDITIONAL'));
        assert.deepEqual(passed.reviewContext.originalOpinions.map(o => o.text), before.opinions.slice(0, 2).map(o => o.text));
        assert.equal(passed.reviewContext.initialEvaluation.feedback.length, 2);
        assert.equal(passed.reviewContext.originalQuestion, input.question);
      }
      return defaultEvaluate(passed);
    },
    getOpinion: async (id, question, passed) => {
      const context = data(passed.prompt); calls.push({ id, phase: context.phase });
      assert.equal(question, input.question); assert.equal(passed.cwd, input.cwd);
      assert.equal(passed.apiKey, undefined); assert.ok(!JSON.stringify(passed).includes(input.apiKey));
      assert.ok(!passed.prompt.includes('excluded failed content'));
      if (context.phase === 'verification') {
        assert.equal(context.reviewerProviderId, id);
        assert.deepEqual(context.sources.map(o => o.providerId), ['codex', 'claude']);
        assert.deepEqual(context.initialEvaluation, evaluation());
        assert.ok(context.sources.every(o => !('debate' in o)));
        assert.match(passed.prompt, /정답으로 가정하지/); assert.match(passed.prompt, /초기 결론과 달라도/);
        await new Promise(resolve => { releases[id] = resolve; });
        return reply(id + ' 조언을 반박하고 위험을 보완한 수정 권고', 'CONDITIONAL', { debate: { ignored: true } });
      }
      assert.equal(id, 'claude'); // Stable drafting order, not highest score.
      assert.equal(context.originalSources.length, 2); assert.equal(context.reviews.length, 2);
      assert.equal(context.initialEvaluation.verdict.choice, 'YES');
      assert.equal(context.reviewedEvaluation.verdict.choice, 'CONDITIONAL');
      assert.ok(context.originalSources.every(o => o.verificationStatus === 'reviewed'));
      return finalReply('두 검증 의견에서 채택한 근거와 반론을 합쳐 선행 조건 충족 시에만 시행하세요.');
    },
  });
  const pending = run({ ...input, onProgress: event => events.push(event) });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(judgments, ['initial']); assert.ok(releases.claude && releases.codex);
  releases.claude(); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(judgments, ['initial']); // Barrier: one completed review is insufficient.
  releases.codex();
  const result = await pending;
  assert.deepEqual(judgments, ['initial', 'refined']);
  assert.equal(calls.length, 3); assert.deepEqual(input, before);
  assert.equal(result.verdict.choice, 'CONDITIONAL'); assert.equal(result.synthesis.stance, 'CONDITIONAL');
  assert.equal(result.synthesis.version, 2); assert.equal(result.synthesis.debate, undefined);
  assert.equal(result.refinement.reviews[0].debate, undefined);
  assert.deepEqual(result.opinions, evaluation().opinions); assert.equal(result.qualityAverage, 80);
  assert.equal(result.model, 'fixture-jev-refined'); assert.equal(result.refinement.initialEvaluation.verdict.choice, 'YES');
  assert.deepEqual(result.usage, { input_tokens: 200, output_tokens: 40 });
  assert.deepEqual([...new Set(events.map(e => e.stage))], ['jev-evaluating', 'model-reviewing', 'jev-refining', 'synthesizing', 'complete']);
  assert.equal(result.refinement.reviews.length, 2); assert.ok(result.refinement.reviews.every(row => row.status === 'complete'));
});

test('failed verification is excluded from second JEV and writer pool while original quality and unverified context remain', async () => {
  const run = createSynthesizedEvaluation({
    evaluate: async passed => {
      if (passed.phase === 'refined') assert.deepEqual(passed.opinions.map(o => o.providerId), ['codex']);
      return defaultEvaluate(passed);
    },
    getOpinion: async (id, _, { prompt }) => {
      const context = data(prompt);
      if (context.phase === 'verification') {
        if (id === 'claude') throw Object.assign(new Error('private raw failure'), { code: 'AUTH_REQUIRED' });
        return reply('Codex는 조언을 반박하고 수정한 조건부 실행안을 제시합니다.');
      }
      assert.equal(id, 'codex');
      assert.equal(context.originalSources.find(o => o.providerId === 'claude').verificationStatus, 'unverified-original');
      assert.equal(context.reviews.find(o => o.providerId === 'claude').errorCode, 'AUTH_REQUIRED');
      return finalReply('검증된 근거를 채택하되 다른 출처의 검증 실패 한계를 밝힌 통합 실행안입니다.');
    },
  });
  const result = await run(options());
  assert.equal(result.opinions.length, 2); assert.equal(result.synthesis.providerId, 'codex');
  assert.deepEqual(result.synthesis.sourceProviderIds, ['codex', 'claude']);
  assert.ok(!JSON.stringify(result).includes('private raw failure'));
});

test('all verification failures preserve initial evaluation and never call second JEV or final writer', async () => {
  let judgments = 0; let calls = 0;
  const result = await createSynthesizedEvaluation({ evaluate: async passed => { judgments++; return defaultEvaluate(passed); }, getOpinion: async () => { calls++; throw Object.assign(new Error('sk-private'), { code: 'sk-private' }); } })(options());
  assert.equal(judgments, 1); assert.equal(calls, 2);
  assert.equal(result.refinement.status, 'error'); assert.equal(result.synthesis.status, 'error');
  assert.equal(result.synthesis.text, undefined); assert.equal(result.verdict.choice, 'YES');
  assert.ok(result.refinement.reviews.every(row => row.status === 'error' && row.errorCode === 'SYNTHESIS_ERROR'));
  assert.ok(!JSON.stringify(result).includes('sk-private'));
});

test('failed or invalid refined JEV preserves initial scores and completed reviews without drafting', async () => {
  for (const invalid of [false, true]) {
    let calls = 0;
    const result = await createSynthesizedEvaluation({
      evaluate: async passed => { if (passed.phase === 'refined') { if (invalid) return evaluation(['codex'], 'HOLD'); throw new Error('secret error'); } return defaultEvaluate(passed); },
      getOpinion: async (...args) => { calls++; return defaultOpinion(...args); },
    })(options());
    assert.equal(calls, 2); assert.equal(result.synthesis.status, 'error');
    assert.equal(result.refinement.status, 'error'); assert.equal(result.refinement.reviews[0].status, 'complete');
    assert.equal(result.refinement.reviewedEvaluation, undefined); assert.deepEqual(result.opinions, evaluation().opinions);
    assert.ok(!JSON.stringify(result).includes('secret error'));
  }
});

test('review may reverse initial judgment and final answer follows only refined judgment', async () => {
  const result = await createSynthesizedEvaluation({
    evaluate: async passed => evaluation(passed.opinions.map(o => o.providerId), passed.phase === 'initial' ? 'YES' : 'NO', passed.phase),
    getOpinion: async (id, _, { prompt }) => data(prompt).phase === 'verification' ? reply(id + ' 조언을 검증하니 핵심 제약이 빠져 있어 반대로 수정합니다.', 'NO') : finalReply('원래 찬성 근거보다 수정된 핵심 제약이 크므로 실행하지 말고 대안을 택하세요.', 'NO'),
  })(options());
  assert.equal(result.refinement.initialEvaluation.verdict.choice, 'YES');
  assert.equal(result.refinement.reviewedEvaluation.verdict.choice, 'NO');
  assert.equal(result.verdict.choice, 'NO'); assert.equal(result.synthesis.stance, 'NO');
});

test('HOLD, original copying, malformed and oversized reviews are excluded as invalid', async () => {
  for (const bad of [reply('보류', 'HOLD'), source('claude'), null, reply(''), reply('x'.repeat(30001)), reply('내용', 'YES', { title: 'x'.repeat(501) }), reply('내용', 'YES', { point: 'x'.repeat(5001) })]) {
    const result = await createSynthesizedEvaluation({ evaluate: defaultEvaluate, getOpinion: async () => bad })(options({ opinions: [source('claude')] }));
    assert.equal(result.refinement.reviews[0].errorCode, 'INVALID_RESPONSE');
    assert.equal(result.synthesis.status, 'error'); assert.equal(result.synthesis.text, undefined);
  }
});

test('wrong final stance and verbatim original or reviewed source copy trigger safe writer fallback', async () => {
  for (const bad of [reply('잘못된 최종 결론', 'YES'), reply(' c o d e x 원래 의견 '.replaceAll(' ', '')), reply('claude 조언 검증·수정 의견')]) {
    const attempts = [];
    const result = await createSynthesizedEvaluation({ evaluate: defaultEvaluate, getOpinion: async (id, question, passed) => {
      if (data(passed.prompt).phase === 'verification') return defaultOpinion(id, question, passed);
      attempts.push(id); return id === 'claude' ? bad : finalReply('모든 검토의 타당한 이유를 통합한 별도의 최종 조건부 실행안입니다.');
    } })(options());
    assert.deepEqual(attempts, ['claude', 'codex']); assert.equal(result.synthesis.providerId, 'codex');
    assert.deepEqual(result.synthesis.attempts, [{ providerId: 'claude', status: 'error', errorCode: 'INVALID_RESPONSE' }, { providerId: 'codex', status: 'complete' }]);
  }
});

test('single provider still performs independent feedback verification and two actual JEV calls', async () => {
  const calls = [];
  const result = await createSynthesizedEvaluation({ evaluate: async passed => { calls.push(passed.phase); return defaultEvaluate(passed); }, getOpinion: async (id, question, passed) => {
    assert.equal(id, 'gemini'); return defaultOpinion(id, question, passed);
  } })(options({ opinions: [source('gemini')] }));
  assert.deepEqual(calls, ['initial', 'refined']); assert.equal(result.synthesis.status, 'complete');
  assert.equal(result.refinement.reviews.length, 1);
});

test('pre-abort and cancellation during either JEV, parallel reviews, or final writing reject uncooperative mocks promptly', async () => {
  for (const phase of ['pre', 'initial', 'verification', 'refined', 'final-synthesis']) {
    const controller = new AbortController(); let entered;
    const ready = new Promise(resolve => { entered = resolve; });
    let count = 0; const signals = [];
    if (phase === 'pre') controller.abort();
    const run = createSynthesizedEvaluation({
      evaluate: async passed => { count++; if (passed.phase === phase) { entered(); return new Promise(() => {}); } return defaultEvaluate(passed); },
      getOpinion: async (id, question, passed) => { count++; signals.push(passed.signal); if (data(passed.prompt).phase === phase) { entered(); return new Promise(() => {}); } return defaultOpinion(id, question, passed); },
    });
    const pending = run(options({ signal: controller.signal }));
    if (phase !== 'pre') { await ready; controller.abort(); }
    await assert.rejects(pending, { code: 'ABORTED' });
    assert.ok(signals.every(signal => signal.aborted || phase === 'refined' || phase === 'final-synthesis'));
    if (phase === 'pre') assert.equal(count, 0);
  }
});

test('review deadlines exclude timed out sources and writer deadline falls back without hanging', async () => {
  for (const phase of ['verification', 'final-synthesis']) {
    let timedSignal;
    const result = await createSynthesizedEvaluation({ evaluate: defaultEvaluate, getOpinion: async (id, question, passed) => {
      if (id === 'claude' && data(passed.prompt).phase === phase) { timedSignal = passed.signal; return new Promise(() => {}); }
      return defaultOpinion(id, question, passed);
    } })(options({ timeoutMs: 5 }));
    assert.equal(timedSignal.aborted, true); assert.equal(result.synthesis.providerId, 'codex');
    const failureRow = phase === 'verification' ? result.refinement.reviews.find(row => row.providerId === 'claude') : result.synthesis.attempts[0];
    assert.equal(failureRow.errorCode, 'TIMEOUT');
  }
});

test('all writers failing keeps valid refinement but never substitutes an existing answer', async () => {
  const result = await createSynthesizedEvaluation({ evaluate: defaultEvaluate, getOpinion: async (id, question, passed) => {
    if (data(passed.prompt).phase === 'final-synthesis') throw new Error('raw private content');
    return defaultOpinion(id, question, passed);
  } })(options());
  assert.equal(result.refinement.status, 'complete'); assert.equal(result.synthesis.status, 'error');
  assert.equal(result.synthesis.text, undefined); assert.equal(result.synthesis.attempts.length, 2);
  assert.ok(!JSON.stringify(result).includes('raw private content'));
});

test('progress snapshots and caller inputs cannot mutate stored review or evaluation context', async () => {
  const input = options(); const before = structuredClone(input); const initial = evaluation();
  const result = await createSynthesizedEvaluation({ evaluate: async passed => passed.phase === 'initial' ? initial : defaultEvaluate(passed), getOpinion: defaultOpinion })({
    ...input, onProgress: event => { if (event.reviews?.[0]) event.reviews[0].status = 'poison'; event.sourceProviderIds?.push('poison'); },
  });
  assert.deepEqual(input, before); assert.equal(initial.refinement, undefined);
  assert.ok(result.refinement.reviews.every(row => row.status === 'complete'));
  assert.deepEqual(result.synthesis.sourceProviderIds, ['codex', 'claude']);
});

test('paragraph escaping remains readable while preserving a single literal escape example', async () => {
  const text = String.raw`첫 근거입니다.\n\n둘째 근거입니다. 단일 예시: \n`;
  const result = await createSynthesizedEvaluation({ evaluate: defaultEvaluate, getOpinion: async (id, question, passed) => data(passed.prompt).phase === 'verification' ? defaultOpinion(id, question, passed) : finalReply(text) })(options());
  assert.ok(result.synthesis.text.includes('첫 근거입니다.\n\n둘째 근거입니다. 단일 예시: ' + String.raw`\n`));
});

test('normal prompts preserve complete public content and full judge metadata without compaction', async () => {
  const seen = [];
  await createSynthesizedEvaluation({ evaluate: defaultEvaluate, getOpinion: async (id, question, passed) => {
    const context = data(passed.prompt); seen.push(context);
    assert.equal(context.contextBudget, undefined);
    assert.deepEqual(context.initialEvaluation, evaluation());
    if (context.phase === 'verification') assert.deepEqual(context.sources.map(row => row.text), options().opinions.map(row => row.text));
    else assert.deepEqual(context.reviewedEvaluation, evaluation(['codex', 'claude'], 'CONDITIONAL', 'refined'));
    return defaultOpinion(id, question, passed);
  } })(options());
  assert.equal(seen.length, 3);
});

test('maximum three-source text and escaped JSON fit every review and writer prompt without losing provenance or scores', async () => {
  for (const character of ['한', '\u0000']) {
    const ids = ['claude', 'codex', 'gemini'], prompts = [];
    const sources = ids.map(id => ({ ...source(id, id + character.repeat(30000 - id.length)), title: character.repeat(500), point: character.repeat(5000), model: character.repeat(200) }));
    const result = await createSynthesizedEvaluation({
      evaluate: async passed => {
        const result = defaultEvaluate(passed);
        result.opinions = result.opinions.map(row => ({ ...row, dimensions: ['logic', 'risk', 'relevance', 'feasibility'].map(id => ({
          id, name: '평가 항목', weight: 25, rawScore: 3, maxScore: 4, points: 18.75, confidence: .7,
          legend: Object.fromEntries([0, 1, 2, 3, 4].map(index => [index, '반복 평가 범례'.repeat(300)])), probabilities: { 0: 0, 1: 0, 2: 0, 3: 1, 4: 0 },
        })) }));
        return result;
      },
      getOpinion: async (id, question, passed) => {
        assert.ok(passed.prompt.length <= 128000, 'prompt respects actual CLI/Gemini input cap');
        const context = data(passed.prompt); prompts.push(context);
        assert.equal(context.contextBudget.truncated, true);
        assert.deepEqual(context.initialEvaluation.opinions.map(row => row.providerId), ids);
        assert.ok(context.initialEvaluation.opinions.every(row => row.dimensions.every(dimension => dimension.weight === 25 && dimension.rawScore === 3 && dimension.points === 18.75 && dimension.confidence === .7 && !dimension.legend)));
        assert.equal(context.initialEvaluation.feedback.length, 3);
        const rows = context.sources || context.originalSources;
        assert.deepEqual(rows.map(row => row.providerId), ids);
        assert.ok(rows.every(row => row.text.includes('[길이 제한으로 이후 내용 생략됨]')));
        if (context.phase === 'verification') return reply(id + ' 보완 ' + character.repeat(29990 - id.length), 'CONDITIONAL', { title: character.repeat(500), point: character.repeat(5000), model: character.repeat(200) });
        assert.equal(context.reviews.length, 3);
        assert.ok(context.originalSources.every(row => row.verificationStatus === 'reviewed'));
        assert.ok(context.reviews.every(row => row.status === 'complete' && row.text.includes('[길이 제한으로 이후 내용 생략됨]')));
        assert.equal(context.reviewedEvaluation.verdict.choice, 'CONDITIONAL');
        return finalReply('축약된 자료의 한계를 밝히고 세 출처의 검증된 근거와 조건을 통합한 별도의 실행 권고입니다.');
      },
    })(options({ opinions: sources, question: character.repeat(4000) }));
    assert.equal(result.synthesis.status, 'complete');
    assert.equal(prompts.length, 4);
    assert.equal(result.refinement.reviews[0].text.length, 29994);
    assert.equal(result.opinions[0].dimensions[0].legend[0].length, 2400); // Stored originals remain complete.
    assert.ok(!result.refinement.reviews[0].text.includes('[길이 제한으로 이후 내용 생략됨]'));
  }
});

test('nested refinement and synthesis survive real store reload with snapshot isolation', async t => {
  const fs = require('node:fs/promises'), path = require('node:path'), os = require('node:os');
  const { randomUUID } = require('node:crypto'), { createStore } = require('../services/store.cjs');
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'yesornot-refinement-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const result = await createSynthesizedEvaluation({ evaluate: defaultEvaluate, getOpinion: defaultOpinion })(options());
  const store = createStore(directory); await store.load();
  await store.saveRecord({ id: randomUUID(), question: '시험할까요?', createdAt: new Date().toISOString(), status: 'complete', opinions: options().opinions, evaluation: result });
  const fresh = createStore(directory); await fresh.load();
  const snapshot = fresh.snapshot();
  assert.deepEqual(snapshot.history[0].evaluation.refinement, result.refinement);
  snapshot.history[0].evaluation.refinement.reviews[0].text = 'poison';
  assert.notEqual(fresh.snapshot().history[0].evaluation.refinement.reviews[0].text, 'poison');
});

test('final evidence citations reject unavailable, unknown and missing references before a different writer can complete', async () => {
  for (const invalid of ['미확인 수치를 채택합니다 [S2]', '한 묶음 인용 [S1, S2]', '접근 불가를 검색 확인으로 오인 [S2, 검색 스니펫]', '없는 번호 [S999]', '정상 인용 뒤 잘못된 긴 번호 [S1, S99999]', '출처 없는 최종 권고']) {
    const writers = [];
    const result = await createSynthesizedEvaluation({
      evaluate: defaultEvaluate,
      getOpinion: async (id, _, { prompt }) => {
        const context = data(prompt);
        if (context.phase === 'verification') return reply(id + '의 보완 검토 [S1]');
        writers.push(id);
        assert.deepEqual(context.researchCitations, { allowedIds: ['S1'], excludedIds: ['S2'] });
        return finalReply(id === 'claude' ? invalid : '확인된 근거로 다시 작성한 통합 실행 권고 [S1, 원문 일부 수집]');
      },
    })(options({ researchSources: [{ id:'S1',verification:'retrieved' },{ id:'S2',verification:'unavailable' }], researchContext:'[S1] 실제 근거' }));
    assert.equal(result.synthesis.status, 'complete');
    assert.equal(result.synthesis.providerId, 'codex');
    assert.deepEqual(writers, ['claude','codex']);
    assert.equal(result.synthesis.attempts[0].errorCode, 'INVALID_CITATIONS');
  }
});

test('all final writers with invalid evidence references retain reviews and fail without publishing unsupported synthesis', async () => {
  const result = await createSynthesizedEvaluation({
    evaluate: defaultEvaluate,
    getOpinion: async (id, _, { prompt }) => data(prompt).phase === 'verification' ? reply(id + '의 검토 [S1]') : finalReply('존재하지 않는 문헌 수치를 믿고 실행하세요 [S999]'),
  })(options({researchSources:[{id:'S1',verification:'search-result'}]}));
  assert.equal(result.synthesis.status,'error');
  assert.equal(result.synthesis.text,undefined);
  assert.ok(result.synthesis.attempts.every(attempt => attempt.errorCode === 'INVALID_CITATIONS'));
  assert.equal(result.refinement.status,'complete');
});
