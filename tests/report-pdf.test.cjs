'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildReportHtml, reportFileName } = require('../services/report-pdf.cjs');

function record(overrides = {}) {
  return {
    id: 'a', question: '<script>alert(1)</script> 이직해도 될까요?', createdAt: '2026-11-02T01:00:00.000Z', completedAt: '2026-11-02T02:00:00.000Z',
    preparation: { readiness: 92, answeredQuestions: [{ id: 'q1', question: '예산은?' }], questions: [] }, answers: { q1: '5천만 원 & 대출 없음' },
    opinions: [{ providerId: 'claude', status: 'success', stance: 'YES', title: '실행', point: '확인' }, { providerId: 'codex', status: 'error' }],
    research: { sources: [{ id: 'S1', title: '공식 통계', publisher: '통계청', date: '2026-10-01', url: 'https://kostat.go.kr/a?b=1&c=2', verification: 'retrieved' }, { id: 'S2', title: '숨김', url: 'https://x', verification: 'unavailable' }] },
    evaluation: { qualityAverage: 84.5, verdict: { choice: 'CONDITIONAL' }, opinions: [{ providerId: 'claude', total: 88 }],
      synthesis: { status: 'complete', title: '조건부로 실행', point: '먼저 예산을 확인하세요.', text: '본문',
        report: { version: 1, sections: [{ title: '판단', text: '첫 문단\n\n둘째 문단 <b>굵게</b>' }] }, finalReview: { status: 'passed', score: 94 } } },
    ...overrides,
  };
}

test('report page escapes every user and model value and contains no script', () => {
  const html = buildReportHtml(record());
  assert.ok(!html.includes('<script>'));
  assert.ok(!html.includes('<b>굵게</b>'));
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(html, /5천만 원 &amp; 대출 없음/);
  assert.match(html, /default-src 'none'/);
});

test('report page carries the final report, verdict, interview, opinions and only usable sources', () => {
  const html = buildReportHtml(record());
  for (const text of ['조건부로 실행', '조건부 권고', '먼저 예산을 확인하세요.', '<h3>판단</h3>', '<p>첫 문단</p>', '인터뷰 준비도', '92%', '94점 · 통과', '예산은?', 'Claude', '88.0', '[S1]', '통계청']) assert.ok(html.includes(text), text);
  assert.ok(!html.includes('숨김'));
  assert.ok(!html.includes('ChatGPT'));
});

test('a run without a completed final report cannot be exported', () => {
  assert.throws(() => buildReportHtml(record({ evaluation: { synthesis: { status: 'error' } } })), { code: 'NO_FINAL_REPORT' });
  assert.equal(reportFileName(record()), 'YES-or-NO-최종보고서-2026-11-02.pdf');
});

test('a binary verdict shows the estimated YES/NO probabilities next to the decision', () => {
  const base = record();
  base.evaluation.verdict = { choice: 'YES', probabilities: { YES: 0.62, NO: 0.38 } };
  assert.match(buildReportHtml(base), /YES \(YES 62% · NO 38%\)/);
});
