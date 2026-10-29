'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const app = fs.readFileSync(path.join(__dirname, '../app.js'), 'utf8');
const source = app.slice(app.indexOf('function readableSourceExcerpt('), app.indexOf('function renderResearch('));
const readable = vm.runInNewContext(source + '\nreadableSourceExcerpt');
const content = value => vm.runInNewContext(source + '\nresearchSourceContent(input)', { input: value });

test('saved damaged original is replaced with an honest notice and readable model summary', () => {
  const excerpt = '[직접 수집한 원문 일부 · 주장 일치 여부는 토론에서 검토]\n' + '\uFFFD'.repeat(100) + '\n[조사 모델의 요약]\n목표가와 환율을 확인하세요.';
  const output = readable(excerpt);
  assert.match(output, /저장된 원문에 문자 인코딩 오류/);
  assert.match(output, /위 원문 링크/);
  assert.match(output, /\[조사 모델의 요약\]\n목표가와 환율을 확인하세요\./);
  assert.doesNotMatch(output, /\uFFFD|직접 수집한 원문 일부/);
  assert.ok(excerpt.includes('\uFFFD'), 'display formatting must leave stored evidence intact');
});
test('readable excerpts stay unchanged and damaged summaries are never presented as repaired text', () => {
  for (const text of ['', '공개 원문 기사', '[조사 모델의 요약]\n정상 요약', '대체 문자 예시: \uFFFD']) assert.equal(readable(text), text);
  for (const text of ['\uFFFD'.repeat(10), '\uFFFD'.repeat(10) + '\n[조사 모델의 요약]\n' + '\uFFFD'.repeat(10)]) {
    const output = readable(text);
    assert.match(output, /문자 인코딩 오류/);
    assert.doesNotMatch(output, /\uFFFD|\[조사 모델의 요약\]/);
  }
});

test('source details separate evidence from model summary and retain numbers and caution', () => {
  const summary = '목표가는 90만→65만원입니다. PER은 26.2→18.8배입니다. EPS는 34,307→34,662원입니다. 다만 환율과 밸류에이션 부담이 있습니다.';
  const excerpt = '[직접 수집한 원문 일부 · 주장 일치 여부는 토론에서 검토]\n2026.10.19 자료입니다. 원문 수치는 1,224조원입니다.\n[조사 모델의 요약]\n' + summary;
  const result = content({ verification: 'retrieved', excerpt });
  assert.equal(result.summary, summary);
  assert.equal(result.original, '2026.10.19 자료입니다. 원문 수치는 1,224조원입니다.');
  assert.equal(result.highlights.length, 3);
  assert.ok(result.highlights.some(line => line.includes('26.2→18.8배')));
  assert.ok(result.highlights.some(line => line.includes('다만 환율')));
  assert.equal(result.hasMoreSummary, true);
  assert.equal(result.warning, '');
  assert.ok(excerpt.includes(summary));
});

test('source presentation handles missing summaries and corruption without inventing a summary', () => {
  const empty = content({});
  assert.equal(empty.highlights.length, 0);
  const retrieved = content({ verification: 'retrieved', excerpt: '수집한 원문입니다. 조건은 2026.10.19 확인입니다.' });
  assert.equal(retrieved.summary, '');
  assert.match(retrieved.summaryOrigin, /원문/);
  assert.ok(retrieved.highlights.join(' ').includes('2026.10.19'));
  const damaged = content({ verification: 'retrieved', excerpt: '\uFFFD'.repeat(30) + '\n[조사 모델의 요약]\n읽을 수 있는 요약입니다.' });
  assert.equal(damaged.original, '');
  assert.match(damaged.warning, /인코딩 오류/);
  assert.equal(damaged.summary, '읽을 수 있는 요약입니다.');
  assert.doesNotMatch(JSON.stringify(damaged), /\uFFFD/);
});

test('display paragraphs retain every sentence and explicit line break without splitting decimals', () => {
  const value = '2026.10.19 기사입니다. PER은 26.2배입니다. EPS는 34,307원입니다. 다음 조건을 확인하세요.\n\n별도 문단입니다.';
  const paragraphs = vm.runInNewContext(source + '\nsourceParagraphs(input)', { input: value });
  assert.ok(paragraphs.length >= 3);
  assert.equal(paragraphs.join(' ').replace(/\s+/g, ' ').trim(), value.replace(/\s+/g, ' ').trim());
  assert.ok(paragraphs.some(line => line.includes('26.2배')));
  assert.equal(paragraphs.at(-1), '별도 문단입니다.');
});
