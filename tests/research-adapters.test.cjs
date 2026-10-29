'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { buildStructuredArgs, parseStructured, getGeminiStructured } = require('../services/research-adapters.cjs');

const SCHEMA = { type: 'object', additionalProperties: false, required: ['answer'], properties: { answer: { type: 'string' } } };
const FINAL = { answer: '공개된 자료를 바탕으로 판단합니다.' };
const KEY = 'fake-test-research-key-only';
const lines = events => events.map(event => JSON.stringify(event)).join('\n');
const claudeFinal = (data = FINAL) => ({ type: 'result', subtype: 'success', structured_output: data, modelUsage: { 'fixture-claude-model': {} } });
const codexFinal = (data = FINAL) => ({ type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify(data) } });
const response = value => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
const geminiPayload = (overrides = {}) => ({ modelVersion: 'fixture-gemini-model', candidates: [{ finishReason: 'STOP', content: { parts: [{ text: JSON.stringify(FINAL) }] }, ...overrides }] });
const flagValue = (args, flag) => args[args.indexOf(flag) + 1];

test('Claude research opens only WebSearch and WebFetch while retaining strict isolation and final schema', () => {
  const args = buildStructuredArgs('claude', 'isolated-workspace', SCHEMA, true);
  assert.equal(flagValue(args, '--tools'), 'WebSearch,WebFetch');
  assert.equal(flagValue(args, '--allowedTools'), 'WebSearch,WebFetch');
  assert.equal(flagValue(args, '--output-format'), 'stream-json');
  assert.equal(flagValue(args, '--max-turns'), '28');
  assert.ok(args.includes('--verbose'));
  assert.ok(args.includes('--safe-mode'));
  assert.ok(args.includes('--disable-slash-commands'));
  assert.ok(args.includes('--strict-mcp-config'));
  assert.deepEqual(JSON.parse(flagValue(args, '--mcp-config')), { mcpServers: {} });
  assert.deepEqual(JSON.parse(flagValue(args, '--settings')), { disableAllHooks: true });
  assert.ok(args.includes('--no-session-persistence'));
  assert.deepEqual(JSON.parse(flagValue(args, '--json-schema')), SCHEMA);
  assert.doesNotMatch(flagValue(args, '--allowedTools'), /Bash|Read|Write|Edit|mcp/);
});

test('Claude preflight remains tool-free and uses its supplied schema', () => {
  const args = buildStructuredArgs('claude', 'isolated-workspace', SCHEMA, false);
  assert.equal(flagValue(args, '--tools'), '');
  assert.equal(flagValue(args, '--output-format'), 'json');
  assert.ok(!args.includes('--allowedTools'));
  assert.deepEqual(JSON.parse(flagValue(args, '--json-schema')), SCHEMA);
  assert.deepEqual(parseStructured('claude', JSON.stringify(claudeFinal())).data, FINAL);
});

test('Codex research enables only live search and retains shell, MCP and other feature restrictions', () => {
  const directory = path.resolve('isolated-research-workspace');
  const research = buildStructuredArgs('codex', directory, SCHEMA, true);
  const preflight = buildStructuredArgs('codex', directory, SCHEMA, false);
  assert.ok(research.includes('web_search="live"'));
  assert.ok(!research.includes('web_search="disabled"'));
  assert.ok(!research.includes('search_tool'));
  assert.ok(preflight.includes('web_search="disabled"'));
  assert.equal(preflight[preflight.indexOf('search_tool') - 1], '--disable');
  for (const feature of ['shell_tool', 'unified_exec', 'code_mode', 'code_mode_host', 'apps', 'plugins', 'hooks', 'browser_use', 'browser_use_external', 'computer_use', 'multi_agent', 'multi_agent_v2', 'image_generation', 'memories']) {
    assert.equal(research[research.indexOf(feature) - 1], '--disable', feature);
  }
  assert.ok(research.includes('mcp_servers={}'));
  assert.ok(research.includes('shell_environment_policy.inherit="none"'));
  assert.equal(flagValue(research, '--sandbox'), 'read-only');
  assert.ok(research.includes('--ignore-user-config'));
  assert.ok(research.includes('--ignore-rules'));
  assert.equal(flagValue(research, '--output-schema'), path.join(directory, 'response-schema.json'));
});

test('Claude streamed public final data and real search tool results produce provenance without reasoning', () => {
  const output = lines([
    { type: 'assistant', message: { content: [{ type: 'thinking', thinking: 'private-reasoning-never-retain' }, { type: 'tool_use', id: 'search-1', name: 'WebSearch', input: { query: 'official decision evidence 2026' } }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'search-1', content: 'Evidence https://example.org/official-report and https://example.edu/paper.' }] } },
    { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'fetch-1', name: 'WebFetch', input: { url: 'https://example.org/fetched-report' } }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'fetch-1', content: 'Document text from publisher.' }] } },
    claudeFinal({ ...FINAL, queries: ['model-declared-fake-query'], sources: [{ url: 'https://fabricated.example/not-tool-evidence' }] }),
  ]);
  const result = parseStructured('claude', output, true);
  assert.equal(result.data.answer, FINAL.answer);
  assert.equal(result.model, 'fixture-claude-model');
  assert.equal(result.provenance.searched, true);
  assert.deepEqual(result.provenance.queries, ['official decision evidence 2026']);
  assert.deepEqual(result.provenance.sources.map(source => source.url).sort(), ['https://example.org/official-report', 'https://example.edu/paper', 'https://example.org/fetched-report'].sort());
  assert.doesNotMatch(JSON.stringify(result), /private-reasoning-never-retain/);
  assert.ok(!result.provenance.sources.some(source => source.url.includes('fabricated')));
});

test('Claude failed searches, URL-free search replies and unpaired results do not claim a completed search', () => {
  for (const content of [
    [{ type: 'tool_result', tool_use_id: 'search-1', is_error: true, content: 'https://example.org/error-output' }],
    [{ type: 'tool_result', tool_use_id: 'search-1', content: 'No search results available.' }],
    [{ type: 'tool_result', tool_use_id: 'unknown-id', content: 'https://example.org/unpaired-result' }],
  ]) {
    const result = parseStructured('claude', lines([
      { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'search-1', name: 'WebSearch', input: { query: 'attempted search' } }] } },
      { type: 'user', message: { content } }, claudeFinal(),
    ]), true);
    assert.equal(result.provenance.searched, false);
    assert.deepEqual(result.provenance.queries, []);
    assert.deepEqual(result.provenance.sources, []);
  }
});

test('Codex completed live search actions prove search, while model declarations and reasoning do not', () => {
  const final = { ...FINAL, queries: ['fabricated model query'] };
  const result = parseStructured('codex', lines([
    { type: 'item.completed', item: { type: 'reasoning', text: 'private-codex-reasoning' } },
    { type: 'item.completed', item: { type: 'web_search', status: 'completed', action: { type: 'search', queries: ['official statistics 2026', 'peer reviewed evidence'] } } },
    { type: 'item.completed', item: { type: 'web_search', status: 'completed', action: { type: 'open_page', url: 'https://example.org/opened-source' } } },
    codexFinal(final),
  ]), true);
  assert.equal(result.provenance.searched, true);
  assert.deepEqual(result.provenance.queries, ['official statistics 2026', 'peer reviewed evidence']);
  assert.deepEqual(result.provenance.sources.map(source => source.url), ['https://example.org/opened-source']);
  assert.doesNotMatch(JSON.stringify(result), /private-codex-reasoning/);
  const declaredOnly = parseStructured('codex', lines([codexFinal(final)]), true);
  assert.equal(declaredOnly.provenance.searched, false);
  assert.deepEqual(declaredOnly.provenance.queries, []);
  const failed = parseStructured('codex', lines([
    { type: 'item.started', item: { type: 'web_search', action: { type: 'search', query: 'not completed' } } },
    { type: 'item.completed', item: { type: 'web_search', status: 'failed', action: { type: 'search', query: 'failed query' } } }, codexFinal(),
  ]), true);
  assert.equal(failed.provenance.searched, false);
});

test('Codex runtime search unavailability cannot become proof from an exit-zero structured final', () => {
  const output = lines([
    { type: 'item.completed', item: { id: 'item_0', type: 'error', message: 'Code Mode is unavailable because code-mode host is disabled. Code mode will fail closed; enable `features.code_mode_host` and install `codex-code-mode-host`.' } },
    codexFinal({ ...FINAL, searched: true, queries: ['model-declared-search'] }),
  ]);
  assert.throws(() => parseStructured('codex', output, true), error => {
    assert.equal(error.code, 'RESEARCH_TOOLS_UNAVAILABLE');
    assert.match(error.message, /현재 Codex CLI에서는 검색 도구를 사용할 수 없어/);
    assert.doesNotMatch(error.message, /code-mode|features\.|model-declared-search/);
    return true;
  });
  assert.deepEqual(parseStructured('codex', output, false).data.answer, FINAL.answer);
  const ordinaryWarning = parseStructured('codex', lines([
    { type: 'item.completed', item: { type: 'error', message: 'Under-development features enabled: standalone_web_search.' } }, codexFinal(),
  ]), true);
  assert.equal(ordinaryWarning.provenance.searched, false);
});

test('provider stream failures and malformed public final JSON fail explicitly', () => {
  assert.throws(() => parseStructured('claude', lines([{ type: 'result', is_error: true, result: 'private failure text' }]), true), { code: 'PROVIDER_ERROR' });
  assert.throws(() => parseStructured('codex', lines([{ type: 'turn.failed', error: { message: 'private failure text' } }]), true), { code: 'PROVIDER_ERROR' });
  assert.throws(() => parseStructured('codex', lines([{ type: 'item.completed', item: { type: 'agent_message', text: 'not JSON' } }]), true), { code: 'INVALID_RESPONSE' });
});

test('Gemini uses Google grounding only for research and always requests the supplied structured schema', async () => {
  for (const research of [false, true]) {
    let body;
    const result = await getGeminiStructured('공개 자료를 검토해 주세요.', SCHEMA, { apiKey: KEY, research, fetchImpl: async (_url, options) => {
      body = JSON.parse(options.body);
      return response(geminiPayload());
    } });
    assert.deepEqual(result.data, FINAL);
    assert.deepEqual(body.generationConfig.responseJsonSchema, SCHEMA);
    assert.equal(body.generationConfig.responseMimeType, 'application/json');
    assert.equal(body.generationConfig.candidateCount, 1);
    if (research) assert.deepEqual(body.tools, [{ google_search: {} }]);
    else assert.equal(body.tools, undefined);
    assert.equal(body.contents[0].parts[0].text, '공개 자료를 검토해 주세요.');
  }
});

test('Gemini actual grounding metadata supplies citations and preserves search suggestions separately', async () => {
  const searchEntryPoint = '<div>Google Search suggestions</div>';
  const result = await getGeminiStructured('research', SCHEMA, { apiKey: KEY, research: true, fetchImpl: async () => response(geminiPayload({
    content: { parts: [{ thought: true, text: 'private-gemini-thought' }, { text: JSON.stringify(FINAL) }] },
    groundingMetadata: {
      webSearchQueries: ['official source query'],
      groundingChunks: [{ web: { uri: 'https://example.edu/actual-paper', title: 'Actual paper' } }, { retrievedContext: { uri: 'https://not-web.example/context' } }],
      searchEntryPoint: { renderedContent: searchEntryPoint },
    },
  })) });
  assert.deepEqual(result.data, FINAL);
  assert.equal(result.model, 'fixture-gemini-model');
  assert.equal(result.provenance.searched, true);
  assert.deepEqual(result.provenance.queries, ['official source query']);
  assert.deepEqual(result.provenance.sources, [{ url: 'https://example.edu/actual-paper', title: 'Actual paper' }]);
  assert.equal(result.provenance.searchEntryPoint, searchEntryPoint);
  assert.doesNotMatch(JSON.stringify(result), /private-gemini-thought/);
});

test('Gemini missing, incomplete or model-declared grounding does not claim research', async () => {
  for (const groundingMetadata of [undefined, { webSearchQueries: ['query without results'] }, { groundingChunks: [{ web: { uri: 'https://example.org/no-query' } }] }]) {
    const result = await getGeminiStructured('research', SCHEMA, { apiKey: KEY, research: true, fetchImpl: async () => response(geminiPayload({
      content: { parts: [{ text: JSON.stringify({ ...FINAL, queries: ['pretended query'], searched: true }) }] }, groundingMetadata,
    })) });
    assert.equal(result.provenance.searched, false);
    assert.ok(!result.provenance.queries.includes('pretended query'));
  }
});

test('Gemini incomplete generations and non-search tool requests cannot become usable research', async () => {
  for (const finishReason of ['MAX_TOKENS', 'SAFETY', 'RECITATION', 'OTHER']) {
    await assert.rejects(getGeminiStructured('research', SCHEMA, { apiKey: KEY, fetchImpl: async () => response(geminiPayload({ finishReason })) }), { code: 'INVALID_RESPONSE' });
  }
  for (const part of [{ functionCall: { name: 'shell', args: {} } }, { executableCode: { language: 'PYTHON', code: 'print(1)' } }]) {
    await assert.rejects(getGeminiStructured('research', SCHEMA, { apiKey: KEY, fetchImpl: async () => response(geminiPayload({ content: { parts: [part] } })) }), { code: 'INVALID_RESPONSE' });
  }
});
