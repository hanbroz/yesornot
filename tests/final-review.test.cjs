'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createSynthesizedEvaluation, REVIEW_TARGET, MAX_REPORT_REPAIRS } = require('../services/synthesis.cjs');

const data = prompt => JSON.parse(prompt.slice(prompt.lastIndexOf('\n') + 1));
const source = providerId => ({ providerId, status: 'success', stance: 'YES', title: '출처', text: providerId + ' 원래 의견', point: '원래 조건' });
function report(lead) {
  return { status: 'success', stance: 'CONDITIONAL', title: '조건을 확인하고 작게 실행', point: '먼저 원본 사본을 보관하고 격리 환경에서 복구 결과를 확인하세요.', text: [
    '[판단]', lead, '현재 행동: 전체 도입은 실행하지 말고 시험 환경을 준비합니다.\n선행 조건: 원본을 복구할 수 있는지 시험 환경에서 확인합니다.\n충족 시: 격리된 환경에서 한 번 시험합니다.\n미충족 시: 원본을 유지하고 도입하지 않습니다.',
    '[선택 이유]', '검토에서 확인한 복구 가능성을 우선합니다. 원본을 보존하면 실패 시 피해 범위를 제한할 수 있습니다.',
    '[대안 비교]', '전체 도입은 복구 확인 전에 원본에 영향을 줍니다. 격리 시험은 같은 기능을 확인하면서 원본을 유지하므로 먼저 선택합니다.',
    '[실행 계획]', '먼저 원본 사본을 보관합니다. 이어 격리 환경에서 복구를 실행하고 원본과 일치하는지 확인한 뒤 시험 결과를 기록합니다.',
    '[위험과 대응]', '복구 결과가 원본과 다르면 시험을 중단하고 원본을 유지합니다. 일치 여부를 확인하기 전에는 전체 도입을 하지 않습니다.',
    '[결론 변경 조건]', '격리 시험에서 복구 결과가 원본과 일치하고 기능 검사가 통과하면 제한된 도입으로 권고를 바꿉니다. 실패하면 도입하지 않습니다.',
  ].join('\n\n') };
}
function evaluation(ids, choice, phase) {
  return { model: 'jev-' + phase, verdict: { choice, rawChoice: choice, confidence: .3, probabilities: { YES: .4, NO: .3, CONDITIONAL: .3 } },
    opinions: ids.map(providerId => ({ providerId, total: 80, dimensions: [] })), qualityAverage: 80, feedback: [] };
}
function setup(scores) {
  const reviewed = [], written = [];
  const run = createSynthesizedEvaluation({
    evaluate: async passed => evaluation(passed.opinions.map(o => o.providerId), passed.phase === 'initial' ? 'YES' : 'CONDITIONAL', passed.phase),
    getOpinion: async (id, _question, { prompt }) => {
      const context = data(prompt);
      if (context.phase === 'verification') return { ...report(id + ' 검증 의견'), title: id + ' 검증' };
      written.push(context.reportRepair?.issues || null);
      return report('모든 의견을 종합한 최종 권고 ' + written.length + '판');
    },
    getStructured: async (id, prompt, schema) => {
      assert.ok(schema.required.includes('suitable'));
      const context = data(prompt);
      assert.equal(context.phase, 'final-report-review');
      assert.deepEqual(context.originalOpinions.map(o => o.providerId), ['codex', 'claude']);
      reviewed.push({ id, draft: context.finalReport.text.match(/최종 권고 (\d)판/)[1] });
      const score = scores[Math.min(reviewed.filter(row => row.id === id).length - 1, scores.length - 1)];
      return { data: { score, suitable: score >= REVIEW_TARGET, issues: score >= REVIEW_TARGET ? [] : ['반대 의견이 빠졌습니다.'], strengths: ['결론이 명확합니다.'] } };
    },
  });
  return { run, reviewed, written };
}
const input = { question: '작게 시험할까요?', opinions: [source('codex'), source('claude')], apiKey: 'k', cwd: 'fixture', timeoutMs: 1000 };

test('a report that scores below the target is revised with reviewer issues until it passes', async () => {
  const { run, reviewed, written } = setup([70, 95]);
  const result = await run(input);
  assert.equal(result.synthesis.status, 'complete');
  assert.equal(result.synthesis.finalReview.status, 'passed');
  assert.deepEqual(result.synthesis.finalReview.rounds.map(row => row.score), [70, 95]);
  assert.equal(written.length, 2);
  assert.ok(written[1].some(issue => issue.includes('반대 의견이 빠졌습니다.')));
  // The writer never reviews its own report.
  assert.ok(reviewed.every(row => row.id !== result.synthesis.providerId));
  assert.match(result.synthesis.text, /최종 권고 2판/);
});

test('repairs are bounded and an unfit report is marked not passed', async () => {
  const { run, written } = setup([60]);
  const result = await run(input);
  assert.equal(result.synthesis.finalReview.status, 'not-passed');
  assert.equal(result.synthesis.finalReview.rounds.length, MAX_REPORT_REPAIRS + 1);
  assert.equal(written.length, MAX_REPORT_REPAIRS + 1);
});

test('without a structured adapter the report is returned unreviewed', async () => {
  const run = createSynthesizedEvaluation({
    evaluate: async passed => evaluation(passed.opinions.map(o => o.providerId), passed.phase === 'initial' ? 'YES' : 'CONDITIONAL', passed.phase),
    getOpinion: async (id, _q, { prompt }) => data(prompt).phase === 'verification' ? { ...report(id), title: id } : report('최종 권고 1판'),
  });
  const result = await run(input);
  assert.equal(result.synthesis.status, 'complete');
  assert.equal(result.synthesis.finalReview, undefined);
});
