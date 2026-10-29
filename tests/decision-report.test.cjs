'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { validateDecisionReport } = require('../services/decision-report.cjs');
const { createSynthesizedEvaluation } = require('../services/synthesis.cjs');
const { buildEvaluationRequest, RUBRIC } = require('../services/jev.cjs');

function report(stance = 'CONDITIONAL') {
  const judgment = stance === 'CONDITIONAL'
    ? '현재 행동: 원본을 유지하고 격리 환경을 준비하세요.\n선행 조건: 격리 환경에서 복구 결과가 원본과 일치하는지 확인합니다.\n충족 시: 격리 시험을 실행합니다.\n미충족 시: 도입하지 않고 원본을 유지합니다.'
    : stance === 'NO' ? '도입하지 마세요. 원본을 유지하고 격리 시험으로 대체하세요.' : '격리 시험을 실행하세요. 원본 사본부터 보관하세요.';
  return { status: 'success', stance, title: '복구 가능성을 확인한 뒤 격리 시험', point: '원본 사본을 보관하세요.', text: [
    '[판단]', judgment,
    '[선택 이유]', '원본 보존이 실패 피해를 제한하므로 복구 가능성을 먼저 확인합니다. 검토된 원본 보존 근거를 채택하고 즉시 전체 도입 주장은 기각합니다.',
    '[대안 비교]', '전체 도입은 복구 확인 전 원본에 영향을 주므로 격리 시험보다 불리합니다.',
    '[실행 계획]', '먼저 원본 사본을 보관하세요. 이어 격리 환경에서 복구하고 원본과 일치하는지 확인해 결과를 기록하세요.',
    '[위험과 대응]', '복구 결과가 다르면 시험을 중단하고 원본을 유지하세요.',
    '[결론 변경 조건]', '복구와 기능 검사가 통과하면 제한 도입으로 권고를 바꾸고 실패하면 도입하지 않습니다.',
  ].join('\n\n') };
}
function rejects(value, expected) {
  assert.throws(() => validateDecisionReport(value), error => error.code === 'INCOMPLETE_REPORT' && error.issues.some(issue => issue.includes(expected)));
}

test('YES, NO and explicit conditional branches produce six readable sections without changing text', () => {
  for (const stance of ['YES', 'NO', 'CONDITIONAL']) {
    const value = report(stance), before = structuredClone(value);
    const parsed = validateDecisionReport(value);
    assert.equal(parsed.version, 1); assert.equal(parsed.sections.length, 6);
    assert.deepEqual(parsed.sections.map(section => section.id), ['judgment', 'reasons', 'alternatives', 'plan', 'risks', 'changeConditions']);
    assert.deepEqual(value, before);
  }
});
test('missing, empty, duplicate and out-of-order sections fail instead of becoming a completed report', () => {
  for (const text of [report().text.replace('[대안 비교]', '[다른 항목]'), report().text.replace(/\[대안 비교\][\s\S]*?(?=\[실행 계획\])/u, '[대안 비교]\n\n')]) rejects({ ...report(), text }, '대안 비교');
  rejects({ ...report(), text: report().text + '\n[판단]\n추가 판단' }, '판단');
  const value = report();
  rejects({ ...value, text: value.text.replace('[판단]', '[선택 이유]').replace('[선택 이유]\n\n원본', '[판단]\n\n원본') }, '순서');
});
test('vacuous conclusions and explicit delegation fail in judgment, plan or first action', () => {
  for (const sentence of ['자료를 종합적으로 판단하여 최종 결정하세요.', '이후 최종 판단은 사용자 본인의 몫입니다.', '상황에 따라 신중히 결정하세요.', '장단점을 충분히 검토한 뒤 최종 판단하세요.', '최종 결정은 사용자에게 맡깁니다.', '제시한 정보를 참고하여 최종 결정하시기 바랍니다.']) {
    rejects({ ...report('NO'), point: sentence }, '위임');
    rejects({ ...report('NO'), text: report('NO').text.replace('도입하지 마세요.', sentence) }, '위임');
  }
  const vague = report('NO').text.replace(/(?<=\]\n\n)[\s\S]*?(?=\n\n\[|$)/gu, '상황에 따라 신중하게 검토해야 합니다.');
  rejects({ ...report('NO'), text: vague }, '실제 내용');
});
test('negative recommendations, missing personal facts and rejected quoted advice stay valid', () => {
  const value = report('NO');
  value.text = value.text.replace('도입하지 마세요.', '개인 부채는 미확인입니다. 확인 전 신규 대출은 실행하지 않는 것이 현재 권고입니다.');
  value.text += '\n“스스로 종합적으로 판단하라”는 기존 결론은 채택하지 않았습니다.';
  value.point = '원본과 사본이 일치하는지 직접 확인하고 시험 결과를 기록하세요.';
  assert.equal(validateDecisionReport(value).sections.length, 6);
  for (const judgment of ['근거를 종합적으로 판단하여 도입하지 않는 것으로 결정했습니다. 원본을 보관하세요.', '도입하지 마세요. 직접 결정하지 마세요라는 기존 조언은 기각합니다.', '최종 판단은 사용자 본인의 몫이 아닙니다. 원본을 유지하세요.']) {
    assert.equal(validateDecisionReport({ ...report('NO'), text: report('NO').text.replace('도입하지 마세요.', judgment) }).sections.length, 6);
  }
});
test('conditional report requires all four nonempty current and branch actions', () => {
  for (const label of ['현재 행동', '선행 조건', '충족 시', '미충족 시']) {
    rejects({ ...report(), text: report().text.replace(new RegExp(label + ': [^\n]+', 'u'), label + ':') }, label);
  }
  rejects({ ...report(), text: report().text.replace('미충족 시: 도입하지 않고 원본을 유지합니다.', '미충족 시: 종합적으로 판단하세요.') }, '미충족 시');
});
test('section parser accepts markdown headings and retains decimal numbers and separate paragraphs', () => {
  const value = report('YES');
  value.text = value.text.replace(/\[([^\]]+)\]/gu, '## $1').replace('원본 보존이', '예시 값 26.2는 검증용입니다.\n\n원본 보존이');
  const parsed = validateDecisionReport(value);
  assert.match(parsed.sections[1].text, /26\.2[^\n]+\n\n/u);
});

const context = prompt => JSON.parse(prompt.slice(prompt.lastIndexOf('\n') + 1));
const source = id => ({ providerId: id, status: 'success', stance: 'YES', title: id, text: id + ' original', point: 'original point' });
const review = id => ({ ...report(), text: id + ' verified revised opinion' });
const evaluation = passed => ({ verdict: { choice: 'CONDITIONAL' }, opinions: passed.opinions.map(opinion => ({ providerId: opinion.providerId })), feedback: [], qualityAverage: 70 });
const options = (extra = {}) => ({ question: '도입할까요?', opinions: [source('claude'), source('codex')], timeoutMs: 1000, ...extra });
test('incomplete final report is repaired once with actionable feedback and original evidence context', async () => {
  const phases = [], events = [];
  const run = createSynthesizedEvaluation({ evaluate: async passed => evaluation(passed), getOpinion: async (id, _, passed) => {
    const data = context(passed.prompt); phases.push(data.phase);
    if (data.phase === 'verification') return review(id);
    assert.match(passed.prompt, /사용자에게 떠넘기지/u);
    if (!data.reportRepair) return { ...report(), text: '자료를 종합하여 직접 판단하세요.' };
    assert.ok(data.reportRepair.issues.length > 0);
    assert.match(data.reportRepair.previousDraft.text, /직접 판단/u);
    assert.equal(data.researchContext, 'verified public context');
    assert.equal(data.reviewedEvaluation.verdict.choice, 'CONDITIONAL');
    return report();
  } });
  const result = await run(options({ researchContext: 'verified public context', onProgress: event => events.push(event) }));
  assert.equal(result.synthesis.status, 'complete'); assert.equal(result.synthesis.report.sections.length, 6);
  assert.equal(result.synthesis.attempts[0].repairCount, 1);
  assert.deepEqual(phases, ['verification', 'verification', 'final-synthesis', 'final-synthesis']);
  assert.ok(events.some(event => event.repairing));
});
test('repeated incomplete reports fall back to next verified writer and never publish a short answer', async () => {
  const writers = [];
  const result = await createSynthesizedEvaluation({ evaluate: async passed => evaluation(passed), getOpinion: async (id, _, { prompt }) => {
    if (context(prompt).phase === 'verification') return review(id);
    writers.push(id); return id === 'claude' ? { ...report(), text: '종합적으로 판단하세요.' } : report();
  } })(options());
  assert.deepEqual(writers, ['claude', 'claude', 'codex']);
  assert.equal(result.synthesis.providerId, 'codex');
  assert.deepEqual(result.synthesis.attempts[0], { providerId: 'claude', status: 'error', errorCode: 'INCOMPLETE_REPORT', repairCount: 1 });
});
test('all incomplete writers fail honestly without text, report or substituted initial opinion', async () => {
  let writes = 0;
  const result = await createSynthesizedEvaluation({ evaluate: async passed => evaluation(passed), getOpinion: async (id, _, { prompt }) => {
    if (context(prompt).phase === 'verification') return review(id);
    writes++; return { ...report(), point: '스스로 결정하세요.' };
  } })(options());
  assert.equal(writes, 4); assert.equal(result.synthesis.status, 'error');
  assert.equal(result.synthesis.text, undefined); assert.equal(result.synthesis.report, undefined);
  assert.equal(result.refinement.status, 'complete');
});
test('cancellation during repair remains abortable and does not publish draft', async () => {
  const controller = new AbortController();
  const run = createSynthesizedEvaluation({ evaluate: async passed => evaluation(passed), getOpinion: async (id, _, { prompt }) => {
    const data = context(prompt);
    if (data.phase === 'verification') return review(id);
    if (!data.reportRepair) return { ...report(), text: 'incomplete report' };
    controller.abort(); return new Promise(() => {});
  } });
  await assert.rejects(run(options({ signal: controller.signal })), { code: 'ABORTED' });
});
test('JEV evaluates delegated decisions as low feasibility while retaining independent quality and choice', () => {
  const request = buildEvaluationRequest({ question: '도입할까요?', opinions: [source('claude')] });
  assert.match(RUBRIC.find(dimension => dimension.id === 'feasibility').levels[0], /떠넘긴다/u);
  assert.match(request.questions.candidate_1_feasibility.instructions, /현재 행동과 조건별 대안/u);
  assert.match(request.questions.verdict.instructions, /최종 선택을 떠넘기는/u);
});
