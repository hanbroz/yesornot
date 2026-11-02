'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { findSiteUrls, readSites, buildScript } = require('../services/site-reader.cjs');
const { createResearchService, RESEARCH_FOCUSES } = require('../services/research.cjs');

test('site addresses are found as full URLs and bare domains, never as files, e-mails or local hosts', () => {
  assert.deepEqual(findSiteUrls(['devcare.co.kr 서비스가 지속 가능할까요? https://lite.ego.app/ko, report.pdf, a@b.com, Node.js, 1.5, http://localhost:3000, 192.168.0.1']),
    ['https://lite.ego.app/ko', 'https://devcare.co.kr/']);
  assert.deepEqual(findSiteUrls(['주소 없음']), []);
});

test('the browser script embeds URLs as data and reads the result from stderr as well as stdout', async () => {
  const script = buildScript(['https://x.example/"); process.exit(1); ("'], { taskName: 'name"quote' });
  assert.ok(script.includes(JSON.stringify(['https://x.example/"); process.exit(1); ("'])));
  assert.ok(script.includes('taskSpace("name\\"quote")'));
  const run = async (_bin, args, options) => {
    assert.deepEqual(args, ['nodejs']);
    assert.match(options.input, /EGO_RESULT/);
    return { exitCode: 0, stdout: '', stderr: 'log\nEGO_RESULT ' + JSON.stringify([{ start: 'https://a.example/', pages: [{ url: 'https://a.example/', title: 'A', text: '월 990,000원' }], errors: [] }]) };
  };
  const sites = await readSites(['https://a.example/'], { egoPath: 'ego.exe', run });
  assert.equal(sites[0].pages[0].text, '월 990,000원');
  await assert.rejects(readSites(['https://a.example/'], { egoPath: null, run }), { code: 'EGO_REQUIRED' });
  await assert.rejects(readSites(['https://a.example/'], { egoPath: 'ego.exe', run: async () => ({ exitCode: 1, stdout: '', stderr: 'boom' }) }), { code: 'EGO_FAILED' });
});

const plan = { summary: '조사 계획', readiness: 95, searches: [{ query: 'IT 유지보수 구독 시장', purpose: '시장', kind: 'official' }], questions: [] };
function service(overrides = {}) {
  return createResearchService({ providers: ['claude'], focuses: [RESEARCH_FOCUSES[0]],
    judgePreparation: async () => ({ model: 'jev', items: [], intakeIntegrity: { choice: 'COMPLETE' }, researchPlan: { choice: 'READY' } }),
    verifySources: async sources => sources.map(item => ({ ...item, verification: 'retrieved', excerpt: '공개 자료 본문' })),
    getStructured: async (_id, _prompt, _schema, options) => {
      if (!options.research) return { data: plan };
      const found = [{ url: 'https://stats.example.org/a', title: '통계', publisher: '기관', date: '2026', kind: 'official', excerpt: '통계' }];
      return { data: { summary: '요약', queries: ['q'], sources: found, gaps: [] }, provenance: { searched: true, queries: ['q'], sources: found } };
    }, ...overrides });
}
const question = 'devcare.co.kr 서비스가 지속 가능할까요?';

test('a named site is read first, cited as S1 and placed in its own context section', async () => {
  const seen = [];
  const research = service({ readSites: async urls => { seen.push(urls); return [{ start: urls[0], pages: [{ url: 'https://devcare.co.kr/', title: 'DevCare', text: 'LITE 990,000 원 / 월 부가세 별도' }], errors: [] }]; } });
  const preparation = await research.prepare({ question });
  const result = await research.research({ question, preparation, answers: {} });
  assert.deepEqual(seen, [['https://devcare.co.kr/']]);
  assert.deepEqual([result.sources[0].id, result.sources[0].kind, result.sources[0].verification], ['S1', 'site', 'retrieved']);
  assert.equal(result.sources[1].id, 'S2');
  for (const context of [result.context, result.debateContext]) assert.match(context, /사용자가 질문에서 지정한 사이트 본문[^]*\[S1\][^]*990,000/);
});

test('without ego browser a question naming a site never proceeds, and an unreadable site is a visible gap', async () => {
  const research = service();
  const preparation = await research.prepare({ question });
  await assert.rejects(research.research({ question, preparation, answers: {} }), { code: 'EGO_REQUIRED' });
  const failing = service({ readSites: async () => { throw Object.assign(new Error('ego lite가 응답하지 않습니다.'), { code: 'EGO_FAILED' }); } });
  const result = await failing.research({ question, preparation: await failing.prepare({ question }), answers: {} });
  assert.ok(result.gaps.some(gap => gap.startsWith('사이트 본문 확인 실패') && gap.includes('devcare.co.kr')));
  assert.equal(result.status, 'partial');
});
