'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createResearchService } = require('../services/research.cjs');

const question = 'Should we relocate for a better home?';
const plan = (overrides = {}) => ({ summary: 'Find public market evidence before advising.', searches: [{ query: 'regional housing statistics 2026', purpose: 'Check recent primary data', kind: 'official' }], questions: [{ question: 'What is your private budget?', why: 'Determine safe financing', material: 'Personal budget sheet', required: true }], ...overrides });
const source = (overrides = {}) => ({ url: 'https://example.org/data?utm_source=test#table', title: 'Primary market statistics', publisher: 'Statistics agency', date: '2026-10-25', kind: 'official', excerpt: 'Observed prices and transactions.', ...overrides });
const report = (overrides = {}) => ({ summary: 'Public data is mixed; compare actual transaction prices.', queries: ['model-declared query'], sources: [source()], gaps: [], ...overrides });
const judged = candidates => ({ model: 'jev-fixture', items: candidates.map(candidate => ({ id: candidate.id, choice: 'ASK_REQUIRED', confidence: 0.9, probabilities: { ASK_REQUIRED: 0.9, ASK_OPTIONAL: 0.1 } })) });
function fixture(overrides = {}) {
  const adapter = overrides.getStructured || (async (_id, _prompt, _schema, options) => options.research ? { data: report(), model: 'research-fixture', provenance: { searched: true, queries: ['real tool query'], sources: [] } } : { data: plan(), model: 'planner-fixture' });
  return createResearchService({ providers: ['claude', 'codex'], judgePreparation: async ({ candidates }) => judged(candidates),
    verifySources: async sources => sources.map(item => ({ ...item, verification: 'retrieved', excerpt: 'Actually retrieved source text.' })), ...overrides,
    getStructured: async (id, prompt, schema, options) => {
      if (prompt.includes('INTAKE_CONSOLIDATION_DATA_JSON: ')) {
        const { candidates } = JSON.parse(prompt.split('INTAKE_CONSOLIDATION_DATA_JSON: ')[1]);
        const groups = new Map();
        for (const row of candidates) {
          if (groups.has(row.question)) groups.get(row.question).sourceIds.push(row.id);
          else groups.set(row.question, { sourceIds: [row.id], question: row.question, why: row.why, material: row.material });
        }
        return { data: { questions: [...groups.values()] }, model: 'consolidation-fixture' };
      }
      return adapter(id, prompt, schema, options);
    },
  });
}

test('preparation only gathers plans and mandatory JEV-selected intake, without an opinion call', async () => {
  const calls = [], progress = [];
  const service = fixture({ getStructured: async (id, prompt, schema, options) => { calls.push({ id, prompt, schema, options }); return { data: plan(), model: 'planner' }; }, judgePreparation: async ({ candidates, plans, apiKey }) => {
    assert.equal(apiKey, 'private-test-token'); assert.equal(plans.length, 2); assert.equal(candidates.length, 1);
    assert.deepEqual(candidates[0].providerIds, ['claude', 'codex']);
    return judged(candidates);
  } });
  const result = await service.prepare({ question, apiKey: 'private-test-token', attachments: [{ id: 'a1', name: 'budget.txt', text: 'PRIVATE_INPUT marker' }], onProgress: value => progress.push(value) });
  assert.equal(result.questions[0].required, true); assert.equal(result.questions[0].id, 'q1'); assert.equal(result.version, 1);
  assert.equal(calls.length, 2); assert.ok(calls.every(call => call.options.research === false));
  for (const call of calls) { assert.match(call.prompt, /Do not give any opinion/); assert.match(call.prompt, /PRIVATE_INPUT marker/); assert.match(call.prompt, /Never ask the user to research public facts/); assert.ok(!call.prompt.includes('private-test-token')); }
  assert.equal(result.opinion, undefined); assert.equal(result.attachments[0].text, undefined); assert.ok(progress.some(value => value.phase === 'judging-preparation'));
});

test('JEV suppresses public/redundant questions and overrides planner optionality', async () => {
  const questions = ['private critical', 'public facts', 'optional private', 'already supplied'].map(question => ({ question, why: 'Purpose', material: '', required: false }));
  const service = fixture({ getStructured: async () => ({ data: plan({ questions }) }), judgePreparation: async ({ candidates }) => ({ items: candidates.map((candidate, index) => ({ id: candidate.id, choice: ['ASK_REQUIRED', 'RESEARCH_PUBLIC', 'ASK_OPTIONAL', 'ALREADY_SUPPLIED'][index], confidence: 0.8 })) }) });
  const result = await service.prepare({ question });
  assert.deepEqual(result.questions.map(item => [item.id, item.required]), [['q1', true]]);
  assert.equal(result.judgment.items.find(item => item.id === 'q3').choice, 'ASK_OPTIONAL');
  assert.equal(result.candidates.length, 4);
});

test('failed planners are excluded and unavailable providers are never invoked', async () => {
  const calls = [];
  const service = fixture({ providers: [{ id: 'claude', available: false }, { id: 'codex', authenticated: true }, 'gemini'], getStructured: async id => { calls.push(id); if (id === 'gemini') throw Object.assign(new Error('secret error detail'), { code: 'AUTH_REQUIRED' }); return { data: plan() }; } });
  const result = await service.prepare({ question });
  assert.deepEqual(calls.sort(), ['codex', 'gemini']); assert.equal(result.plans[1].errorCode, 'AUTH_REQUIRED'); assert.ok(!JSON.stringify(result).includes('secret error detail'));
  assert.deepEqual(result.questions[0].providerIds, ['codex']);
});

test('all failed planners and absent/invalid JEV judgments block the next stage', async () => {
  await assert.rejects(fixture({ getStructured: async () => { throw new Error('unavailable'); } }).prepare({ question }), { code: 'PREPARATION_FAILED' });
  await assert.rejects(fixture({ judgePreparation: async () => ({ items: [] }) }).prepare({ question }), { code: 'INVALID_RESPONSE' });
  await assert.rejects(fixture({ judgePreparation: async () => { throw Object.assign(new Error('JEV unavailable'), { code: 'NETWORK_ERROR' }); } }).prepare({ question }), { code: 'NETWORK_ERROR' });
});

test('required private intake is answered before any public research begins', async () => {
  const service = fixture(); const preparation = await service.prepare({ question });
  await assert.rejects(service.research({ question, preparation }), { code: 'ANSWERS_REQUIRED' });
  await assert.rejects(service.research({ question }), { code: 'PREPARATION_REQUIRED' });
});

test('actual search provenance gates research instead of trusting model claims', async () => {
  const service = fixture({ getStructured: async (_id, _prompt, _schema, options) => options.research ? { data: report(), provenance: { searched: false } } : { data: plan() } });
  const preparation = await service.prepare({ question });
  await assert.rejects(service.research({ question, preparation, answers: { q1: 'Private budget' } }), { code: 'RESEARCH_FAILED' });
});

test('source aggregation deduplicates tracking URLs and retains real queries, provenance and verified excerpts', async () => {
  const prompts = [];
  const service = fixture({ getStructured: async (id, prompt, _schema, options) => {
    if (!options.research) return { data: plan() };
    prompts.push(prompt);
    return { data: report({ sources: [source({ url: id === 'claude' ? 'https://example.org/data?utm_source=a#x' : 'https://example.org/data?fbclid=abc' })] }), model: 'research-model', provenance: { searched: true, queries: [`actual ${id} query`], sources: [{ url: 'https://example.org/counter', title: 'Counterevidence', kind: 'counter' }] } };
  } });
  const preparation = await service.prepare({ question });
  const result = await service.research({ question, preparation, answers: { q1: 'private answer' }, attachments: [{ name: 'note.txt', text: 'private attachment' }] });
  assert.equal(result.status, 'complete'); assert.equal(result.sources.length, 2); assert.equal(result.sources[0].url, 'https://example.org/data');
  assert.deepEqual(result.sources[0].providerIds, ['claude', 'codex']); assert.equal(result.sources[0].excerpt, 'Actually retrieved source text.');
  assert.deepEqual(result.queries.map(item => item.query), ['actual claude query', 'actual codex query']);
  assert.ok(!result.queries.some(item => item.query === 'model-declared query')); assert.equal(result.reports[0].declaredQueries[0], 'model-declared query');
  assert.match(result.context, /\[S1\]/); assert.match(result.context, /private answer/); assert.match(result.context, /private attachment/);
  for (const prompt of prompts) {
    assert.ok(!prompt.includes(question)); assert.ok(!prompt.includes('private answer')); assert.ok(!prompt.includes('private attachment')); assert.ok(!prompt.includes('What is your private budget?'));
    assert.match(prompt, /No private case, intake answers or attachment content is supplied/);
    const publicData = JSON.parse(prompt.split('RESEARCH_DATA_JSON: ')[1]);
    assert.deepEqual(Object.keys(publicData).sort(), ['currentDate', 'researchPlan', 'searches']);
  }
});

test('tools-disabled refinement incorporates clarified public region without sending private context to web tools', async () => {
  const calls = [];
  const publicSearch = { query: 'Dongtan 2026 housing official transactions', purpose: 'Compare the clarified public region', kind: 'official' };
  const service = fixture({ getStructured: async (_id, prompt, _schema, options) => {
    calls.push({ prompt, research: options.research });
    if (prompt.includes('QUERY_REFINEMENT_DATA_JSON: ')) {
      assert.equal(options.research, false);
      assert.match(prompt, /PRIVATE_BALANCE_123/); assert.match(prompt, /PRIVATE_DOCUMENT_MARKER/);
      return { data: { searches: [publicSearch] } };
    }
    if (!options.research) return { data: plan() };
    const publicData = JSON.parse(prompt.split('RESEARCH_DATA_JSON: ')[1]);
    assert.deepEqual(publicData.searches, [publicSearch]);
    assert.ok(!prompt.includes('PRIVATE_BALANCE_123')); assert.ok(!prompt.includes('PRIVATE_DOCUMENT_MARKER')); assert.ok(!prompt.includes(question));
    return { data: report(), provenance: { searched: true, queries: [publicSearch.query], sources: [source()] } };
  } });
  const preparation = await service.prepare({ question });
  const result = await service.research({ question, preparation, answers: { q1: 'Dongtan; PRIVATE_BALANCE_123' }, attachments: [{ name: 'private.txt', text: 'PRIVATE_DOCUMENT_MARKER' }] });
  assert.deepEqual(result.reports[0].plannedSearches, [publicSearch]);
  assert.match(result.context, /PRIVATE_BALANCE_123/); assert.match(result.context, /PRIVATE_DOCUMENT_MARKER/);
  assert.equal(calls.filter(call => call.prompt.includes('QUERY_REFINEMENT_DATA_JSON: ')).length, 2);
});

test('only URLs proven in actual tool provenance enter verification as search results', async () => {
  const entryPoint = '<div>Exact provider search suggestions</div>';
  let received;
  const service = fixture({
    judgePreparation: async ({ candidates }) => ({ ...judged(candidates), researchPlan: { choice: 'COUNTER' } }),
    getStructured: async (_id, prompt, _schema, options) => {
      if (!options.research) return { data: plan() };
      assert.match(prompt, /"researchPlan":\{"choice":"COUNTER"\}/);
      assert.match(prompt, /never the truth of its claims/);
      return { data: report({ sources: [source(), source({ url: 'https://example.org/model-only' })] }), provenance: { searched: true, queries: ['real query'], engine: 'google-grounding', searchEntryPoint: entryPoint, sources: [source({ url: 'https://example.org/data#tool' })] } };
    },
    verifySources: async sources => { received = sources; return sources; },
  });
  const preparation = await service.prepare({ question });
  const result = await service.research({ question, preparation, answers: { q1: 'Provided' } });
  assert.equal(received.find(item => item.url === 'https://example.org/data').verification, 'search-result');
  assert.equal(received.find(item => item.url.endsWith('/model-only')).verification, 'unavailable');
  assert.equal(result.reports[0].provenance.engine, 'google-grounding');
  assert.equal(result.reports[0].provenance.searchEntryPoint, entryPoint);
  assert.equal(result.status, 'partial');
});

test('unavailable sources remain visible gaps, while one traceable search result allows a partial dossier', async () => {
  const service = fixture({ getStructured: async (_id, _p, _s, options) => options.research ? { data: report({ sources: [source(), source({ url: 'https://example.org/blocked' })] }), provenance: { searched: true, queries: [] } } : { data: plan() }, verifySources: async sources => sources.map((item, index) => ({ ...item, verification: index ? 'unavailable' : 'search-result' })) });
  const preparation = await service.prepare({ question }); const result = await service.research({ question, preparation, answers: { q1: 'Provided' } });
  assert.equal(result.status, 'partial'); assert.equal(result.sources[0].verification, 'search-result'); assert.ok(result.gaps.some(gap => gap.includes('/blocked'))); assert.ok(result.gaps.some(gap => gap.includes('검색어')));
});

test('no reachable or traceable sources never produces an unresearched decision', async () => {
  const service = fixture({ verifySources: async sources => sources.map(item => ({ ...item, verification: 'unavailable' })) }); const preparation = await service.prepare({ question });
  await assert.rejects(service.research({ question, preparation, answers: { q1: 'Provided' } }), { code: 'RESEARCH_FAILED' });
});

test('unresponsive provider cancellation rejects promptly and does not invoke JEV', async () => {
  const controller = new AbortController(); let judged = false;
  const service = fixture({ getStructured: async () => new Promise(() => {}), judgePreparation: async () => { judged = true; } });
  const pending = service.prepare({ question, signal: controller.signal });
  setTimeout(() => controller.abort(), 10);
  await assert.rejects(pending, { code: 'ABORTED' }); assert.equal(judged, false);
});

test('verification cancellation and bounded timeouts cannot hang the research pipeline', async () => {
  const controller = new AbortController();
  const service = fixture({ verifySources: async () => { setTimeout(() => controller.abort(), 10); return new Promise(() => {}); } });
  const preparation = await service.prepare({ question });
  await assert.rejects(service.research({ question, preparation, answers: { q1: 'Provided' }, signal: controller.signal }), { code: 'ABORTED' });
  const timed = fixture({ getStructured: async () => new Promise(() => {}) });
  await assert.rejects(timed.prepare({ question, timeoutMs: 100 }), { code: 'PREPARATION_FAILED' });
});

test('context and attachments remain bounded with explicit truncation rather than silently claiming full coverage', async () => {
  const service = fixture({ getStructured: async (_id, _p, _s, options) => options.research ? { data: report({ sources: Array.from({ length: 20 }, (_, index) => source({ url: `https://example.org/${index}`, excerpt: 'x'.repeat(3000) })) }), provenance: { searched: true, queries: ['real query'] } } : { data: plan() } });
  const preparation = await service.prepare({ question });
  const result = await service.research({ question, preparation, answers: { q1: 'z'.repeat(4000) }, attachments: [{ name: 'long.txt', text: 'y'.repeat(100000) }] });
  assert.ok(result.context.length <= 24000); assert.match(result.context, /생략/); assert.match(result.context, /사용자의 사전 답변/); assert.match(result.context, /사용자 첨부 자료/); assert.match(result.context, /long.txt/); assert.equal(result.sources.length, 20); assert.ok(!JSON.stringify(result.attachments).includes('yyyy'));
});

test('fair context shares preserve later required answers and every document instead of a first-item monopoly', async () => {
  const questions = ['First private question', 'Later required question'].map(question => ({ question, why: 'Private context', material: '', required: true }));
  const documents = [{ id: 'first-doc', name: 'first.txt', text: 'a'.repeat(8000) }, { id: 'later-doc', name: 'later.txt', text: 'LATER_DOCUMENT_UNIQUE_MARKER' }];
  let judgedAttachments;
  const service = fixture({
    getStructured: async (_id, prompt, _schema, options) => {
      if (!options.research) {
        assert.match(prompt, /LATER_DOCUMENT_UNIQUE_MARKER/);
        return { data: plan({ questions }) };
      }
      return { data: report(), provenance: { searched: true, queries: ['actual query'], sources: [source()] } };
    },
    judgePreparation: async ({ candidates, attachments }) => { judgedAttachments = attachments; return judged(candidates); },
  });
  const preparation = await service.prepare({ question, attachments: documents });
  assert.equal(judgedAttachments.length, 2); assert.match(judgedAttachments[1].text, /LATER_DOCUMENT_UNIQUE_MARKER/);
  const result = await service.research({ question, preparation, answers: { q1: 'x'.repeat(4000), q2: 'LATER_REQUIRED_ANSWER_MARKER' }, attachments: documents });
  assert.ok(result.context.length <= 24000);
  for (const marker of ['q1', 'q2', 'first-doc', 'later-doc', 'LATER_REQUIRED_ANSWER_MARKER', 'LATER_DOCUMENT_UNIQUE_MARKER']) assert.ok(result.context.includes(marker), marker);
  assert.match(result.context, /생략/);
});

test('retrieved evidence enters source context before long model-declared excerpts', async () => {
  const service = fixture({
    getStructured: async (_id, _p, _s, options) => options.research ? { data: report({ sources: [source({ excerpt: 'MODEL_DECLARED_ONLY '.repeat(150) })] }), provenance: { searched: true, queries: ['actual query'], sources: [] } } : { data: plan() },
    verifySources: async sources => sources.map(item => ({ ...item, verification: 'retrieved', excerpt: 'ACTUALLY_RETRIEVED_FIRST_MARKER ' + 'actual text '.repeat(250) })),
  });
  const preparation = await service.prepare({ question });
  const result = await service.research({ question, preparation, answers: { q1: 'Provided' } });
  assert.match(result.sources[0].excerpt, /^ACTUALLY_RETRIEVED_FIRST_MARKER/);
  assert.match(result.context, /ACTUALLY_RETRIEVED_FIRST_MARKER/);
  assert.ok(!result.context.includes('MODEL_DECLARED_ONLY'));
});

test('thirty source contexts retain late primary/paper evidence and separately labelled summaries and final cautions', async () => {
  const types = ['news', 'counter', 'official', 'paper'];
  const service = fixture({
    providers: ['claude', 'codex', 'gemini'],
    getStructured: async (id, _prompt, _schema, options) => {
      if (!options.research) return { data: plan() };
      const sources = Array.from({ length: 10 }, (_, index) => source({
        url: `https://${id}.example.org/${index}`, title: `Public evidence ${id} ${index}`,
        kind: types[index < 4 ? 0 : index < 5 ? 1 : index < 9 ? 2 : 3],
        excerpt: `SUMMARY_${id}_${index} ` + 'model explanation '.repeat(100) + ` CAUTION_${id}_${index}`,
      }));
      return { data: report({ sources }), provenance: { searched: true, queries: ['actual query'], sources } };
    },
    verifySources: async sources => sources.map(item => ({
      ...item, verification: 'retrieved',
      excerpt: '[직접 수집한 원문 일부 · 주장 일치 여부는 토론에서 검토]\nORIGINAL_' + new URL(item.url).hostname.split('.')[0] + '_' + new URL(item.url).pathname.slice(1) + ' ' + 'observed evidence '.repeat(95) + '\n[조사 모델의 요약]\n' + item.excerpt,
    })),
  });
  const preparation = await service.prepare({ question });
  const result = await service.research({ question, preparation, answers: { q1: 'Private answer' } });
  assert.equal(result.sources.length, 30);
  const publicContext = result.context.split('조사 한계(')[0];
  const blocks = [...publicContext.matchAll(/\[(S\d+)\] ([\s\S]*?)(?=\n\n\[S\d+\]|$)/g)];
  assert.deepEqual(blocks.map(match => match[1]), result.sources.map(item => item.id));
  assert.equal(blocks.length, 30); assert.ok(result.context.length <= 24000);
  assert.ok(publicContext.slice(publicContext.indexOf('[인용 가능 출처')).trim().length <= 10000);
  for (const item of result.sources) {
    const name = new URL(item.url).hostname.split('.')[0] + '_' + new URL(item.url).pathname.slice(1);
    const block = blocks.find(match => match[1] === item.id)[2];
    for (const marker of ['ORIGINAL_' + name, 'SUMMARY_' + name, 'CAUTION_' + name, item.kind, '[수집 원문 일부]', '[모델 요약·주장 미검증]']) assert.ok(block.includes(marker), item.id + ': ' + marker);
    assert.ok(item.excerpt.length <= 3000); assert.ok(item.excerpt.includes('CAUTION_' + name));
  }
  assert.equal(result.sources.at(-1).kind, 'paper'); assert.match(publicContext, /\[S30\]/);
  assert.match(publicContext, /중간 생략/); assert.match(result.context, /Private answer/);
});

test('maximum bibliographic fields cannot crowd out later sources and search summaries stay unverified', async () => {
  const service = fixture({
    providers: ['claude', 'codex', 'gemini'],
    getStructured: async (id, _prompt, _schema, options) => {
      if (!options.research) return { data: plan() };
      const sources = Array.from({ length: 10 }, (_, index) => source({
        url: `https://${id}.example.org/${index}?q=` + 'u'.repeat(1800),
        title: 'T'.repeat(400), publisher: 'P'.repeat(200), date: 'D'.repeat(100),
        kind: index === 9 ? 'paper' : 'official', excerpt: 'MODEL_SEARCH_CLAIM ' + 'x'.repeat(2500) + ' FINAL_RISK',
      }));
      return { data: report({ sources }), provenance: { searched: true, queries: ['actual query'], sources } };
    },
    verifySources: async sources => sources,
  });
  const preparation = await service.prepare({ question });
  const result = await service.research({ question, preparation, answers: { q1: 'Provided' } });
  assert.equal(result.sources.length, 30);
  assert.equal([...result.context.matchAll(/\[S\d+\] /g)].length, 30);
  assert.match(result.context, /\[S30\]/); assert.ok(result.context.length <= 24000);
  const evidence = result.context.split('조사 한계(')[0].split('[인용 가능 출처')[1];
  assert.ok(('[인용 가능 출처' + evidence).trim().length <= 10000);
  assert.equal([...evidence.matchAll(/검색 출처 확인·모델 요약, 원문 미확인/g)].length, 30);
  assert.ok(!evidence.includes('[수집 원문 일부]'));
  assert.equal([...evidence.matchAll(/FINAL_RISK/g)].length, 30);
});

const broadSearches = ['official', 'news', 'counter'].map(kind => ({ query: 'public housing ' + kind, purpose: 'Relevant ' + kind + ' evidence', kind }));
function broadResult(kinds = ['official', 'news', 'counter'], queries = broadSearches.map(item => item.query)) {
  const sources = kinds.map(kind => source({ url: 'https://' + kind + '-evidence.org/evidence', kind }));
  return { data: report({ sources }), provenance: { searched: true, queries, sources } };
}

test('one bounded follow-up closes relevant coverage gaps and preserves actual follow-up search provenance', async () => {
  let webCalls = 0;
  const service = fixture({ providers: ['claude'], getStructured: async (_id, prompt, _schema, options) => {
    if (!options.research) return { data: plan({ searches: broadSearches }) };
    webCalls++;
    if (webCalls === 1) return broadResult(['official'], [broadSearches[0].query]);
    assert.match(prompt, /ONE BOUNDED PUBLIC RESEARCH FOLLOW-UP/);
    assert.ok(!prompt.includes('PRIVATE_FOLLOWUP_MARKER'));
    return broadResult(['news', 'counter'], broadSearches.slice(1).map(item => item.query));
  } });
  const preparation = await service.prepare({ question });
  const result = await service.research({ question, preparation, answers: { q1: 'PRIVATE_FOLLOWUP_MARKER' } });
  assert.equal(webCalls, 2); assert.equal(result.status, 'complete');
  assert.deepEqual(result.coverage.missingKinds, []); assert.equal(result.coverage.actualQueries, 3); assert.equal(result.coverage.independentDomains, 3);
  assert.equal(result.reports[0].followup.status, 'success');
  assert.deepEqual(result.reports[0].followup.provenance.queries, broadSearches.slice(1).map(item => item.query));
});

test('covered research triggers no follow-up and irrelevant paper/news quotas are never invented', async () => {
  for (const searches of [broadSearches, [broadSearches[0]]]) {
    let webCalls = 0;
    const service = fixture({ providers: ['claude'], getStructured: async (_id, _prompt, _schema, options) => {
      if (!options.research) return { data: plan({ searches }) };
      webCalls++; return broadResult(searches.map(item => item.kind), searches.map(item => item.query));
    } });
    const preparation = await service.prepare({ question }); const result = await service.research({ question, preparation, answers: { q1: 'Provided' } });
    assert.equal(webCalls, 1); assert.equal(result.status, 'complete'); assert.ok(!result.coverage.plannedKinds.includes('paper'));
  }
});

test('broad plans with only one real query or usable source after the follow-up block opinions', async () => {
  for (const inadequate of ['query', 'source']) {
    let webCalls = 0;
    const service = fixture({ providers: ['claude'], getStructured: async (_id, _prompt, _schema, options) => {
      if (!options.research) return { data: plan({ searches: broadSearches }) };
      webCalls++;
      return inadequate === 'query' ? broadResult(['official', 'news', 'counter'], ['only actual query']) : broadResult(['official'], broadSearches.map(item => item.query));
    } });
    const preparation = await service.prepare({ question });
    await assert.rejects(service.research({ question, preparation, answers: { q1: 'Provided' } }), { code: 'RESEARCH_INCOMPLETE' });
    assert.equal(webCalls, 2);
  }
});

test('uncovered relevant evidence kinds remain explicit partial coverage after one follow-up', async () => {
  let webCalls = 0;
  const service = fixture({ providers: ['claude'], getStructured: async (_id, _prompt, _schema, options) => {
    if (!options.research) return { data: plan({ searches: broadSearches }) };
    webCalls++; return broadResult(['official', 'news']);
  } });
  const preparation = await service.prepare({ question }); const result = await service.research({ question, preparation, answers: { q1: 'Provided' } });
  assert.equal(webCalls, 2); assert.equal(result.status, 'partial'); assert.deepEqual(result.coverage.missingKinds, ['counter']);
  assert.ok(result.gaps.some(gap => gap.includes('counter')));
});

test('global source cap is shared round robin across independent researchers', async () => {
  const service = fixture({ providers: ['claude', 'codex', 'gemini'], getStructured: async (id, _prompt, _schema, options) => {
    if (!options.research) return { data: plan() };
    const sources = Array.from({ length: 20 }, (_, index) => source({ url: 'https://' + id + '.example.org/' + index }));
    return { data: report({ sources }), provenance: { searched: true, queries: ['actual query'], sources } };
  } });
  const preparation = await service.prepare({ question }); const result = await service.research({ question, preparation, answers: { q1: 'Provided' } });
  assert.equal(result.sources.length, 30);
  for (const providerId of ['claude', 'codex', 'gemini']) assert.equal(result.sources.filter(item => item.providerIds.includes(providerId)).length, 10);
});

test('subdomains of one publisher do not satisfy independent domain breadth', async () => {
  let webCalls = 0;
  const searches = [0, 1].map(index => ({ query: 'relevant public query ' + index, purpose: 'Independent corroboration', kind: 'official' }));
  const sources = ['a', 'b'].map(subdomain => source({ url: 'https://' + subdomain + '.publisher.co.kr/evidence' }));
  const service = fixture({ providers: ['claude'], getStructured: async (_id, _prompt, _schema, options) => {
    if (!options.research) return { data: plan({ searches }) };
    webCalls++; return { data: report({ sources }), provenance: { searched: true, queries: searches.map(item => item.query), sources } };
  } });
  const preparation = await service.prepare({ question }); const result = await service.research({ question, preparation, answers: { q1: 'Provided' } });
  assert.equal(webCalls, 2); assert.equal(result.status, 'partial');
  assert.equal(result.coverage.independentDomains, 1); assert.equal(result.coverage.minimumDomains, 2);
});

test('unavailable source claims and unverified model summaries never enter reasoning evidence or citation headers', async () => {
  const unavailableUrl = 'https://unavailable-evidence.org/unsupported';
  const unsupported = 'UNAVAILABLE_CLAIM_MARKER 20–25% d=0.67';
  const rawSummary = 'UNVERIFIED_REPORT_SUMMARY_MARKER ' + unsupported;
  const service = fixture({
    providers: ['claude'],
    getStructured: async (_id, _prompt, _schema, options) => options.research ? {
      data: report({ summary: rawSummary, sources: [source({ excerpt: 'Usable evidence without unsupported numbers.' }), source({ url: unavailableUrl, excerpt: unsupported })] }),
      provenance: { searched: true, queries: ['actual query'], sources: [] },
    } : { data: plan() },
    verifySources: async sources => sources.map(item => ({ ...item, verification: item.url === unavailableUrl ? 'unavailable' : 'retrieved', excerpt: item.url === unavailableUrl ? item.excerpt : 'ACTUALLY_RETRIEVED_USABLE_MARKER ' + 'accessible text '.repeat(12) })),
  });
  const preparation = await service.prepare({ question });
  const result = await service.research({ question, preparation, answers: { q1: 'PRIVATE_ANSWER_STILL_PRESENT' }, attachments: [{ name: 'private.txt', text: 'PRIVATE_DOCUMENT_STILL_PRESENT' }] });
  const excluded = result.sources.find(item => item.url === unavailableUrl);
  assert.equal(excluded.verification, 'unavailable'); assert.equal(excluded.excerpt, unsupported);
  assert.equal(result.reports[0].summary, rawSummary); assert.ok(result.gaps.some(gap => gap.includes(unavailableUrl)));
  assert.ok(!result.context.includes('[' + excluded.id + ']'));
  for (const forbidden of [unavailableUrl, 'UNAVAILABLE_CLAIM_MARKER', 'UNVERIFIED_REPORT_SUMMARY_MARKER', '20–25%', 'd=0.67']) assert.ok(!result.context.includes(forbidden), forbidden);
  for (const retained of ['[S1]', 'ACTUALLY_RETRIEVED_USABLE_MARKER', 'PRIVATE_ANSWER_STILL_PRESENT', 'PRIVATE_DOCUMENT_STILL_PRESENT']) assert.ok(result.context.includes(retained), retained);
  assert.match(result.context, /실제로 표시된 \[S번호\]만 인용/);
  assert.equal(result.status, 'partial');
});
