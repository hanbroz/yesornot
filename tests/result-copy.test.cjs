'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

test('copied result retains original judgment, every public review, changed judgment and final author', () => {
  const main = fs.readFileSync(path.join(__dirname, '../main.cjs'), 'utf8');
  const source = main.slice(main.indexOf('function formatResult('), main.indexOf('function createWindow('));
  const format = vm.runInNewContext(source + '\nformatResult', { cli: { PROVIDERS: [{ id: 'claude', name: 'Claude' }, { id: 'codex', name: 'ChatGPT' }] } });
  const result = format({ question: '계약할까요?', createdAt: '2026-10-23', status: 'partial', opinions: [], preparation: { questions: [{ id: 'q1', question: '개인 자금은?', required: true }] }, answers: { q1: '검증용 자금 답변' }, attachments: [{ name: '자금계획.txt', truncated: true }], research: { status: 'partial', queries: [{ query: '공식 실거래 통계' }], sources: [{ id: 'S1', title: '실거래 원자료', url: 'https://example.org/official', verification: 'retrieved', excerpt: '직접 수집한 공개 근거' }], gaps: ['후보 단지 미확정'] }, evaluation: {
    model: 'jev-test', qualityAverage: 82, opinions: [], verdict: { choice: 'CONDITIONAL', confidence: .4, probabilities: { YES: .2, NO: .3, CONDITIONAL: .5 } },
    refinement: { initialEvaluation: { verdict: { choice: 'YES' }, feedback: [{ providerId: 'claude', label: '위험·대안 보완' }] },
      reviews: [{ providerId: 'claude', status: 'complete', stance: 'CONDITIONAL', title: '조건 수정', text: '중간 판정의 가정을 반박했습니다.', point: '중단 조건 확인' }, { providerId: 'codex', status: 'error', error: '인증 실패' }],
      reviewedEvaluation: { verdict: { choice: 'CONDITIONAL' } } },
    synthesis: { status: 'complete', providerId: 'claude', model: 'writer-test', sourceProviderIds: ['claude'], title: '먼저 확인하세요', text: '안전 조건 충족 후 진행하세요.', point: '원문 확인' },
  } });
  for (const expected of ['검증용 자금 답변', '자금계획.txt (일부 추출)', '공식 실거래 통계', '[S1] 실거래 원자료', 'https://example.org/official', '직접 수집한 공개 근거', '조사 한계: 후보 단지 미확정', 'JEV 중간 판정: YES', '위험·대안 보완', '중간 판정의 가정을 반박했습니다.', '인증 실패', 'JEV 재평가: CONDITIONAL', '안전 조건 충족 후 진행하세요.', '문장 작성: Claude', '정답 확률이 아닙니다']) assert.ok(result.includes(expected), expected);
});
