'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { DEFAULT_MODEL, inspectConnection, getOpinion } = require('../services/gemini.cjs');

const KEY = 'FAKE_TEST_KEY_NOT_A_CREDENTIAL';
const opinion = { stance: 'HOLD', title: '조건을 확인하세요', body: '현재 자료가 충분하지 않으므로 비용과 제약 조건부터 확인해야 합니다.', point: '예산을 확인하세요.' };
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
const payload = (changes = {}) => ({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text: JSON.stringify(opinion) }] } }], modelVersion: `${DEFAULT_MODEL}-001`, ...changes });

test('missing API key produces configuration status without OAuth or network calls', async () => {
  let called = false;
  const result = await inspectConnection({ fetchImpl: () => { called = true; } });
  assert.equal(called, false);
  assert.equal(result.transport, 'api');
  assert.equal(result.installed, true);
  assert.equal(result.configured, false);
  assert.equal(result.authenticated, false);
  assert.equal(result.reason, 'NOT_CONFIGURED');
  assert.equal(result.action, 'configure_api_key');
  assert.doesNotMatch(result.message, /OAuth|로그인/);
});

test('connection inspection authenticates a metadata GET without generating content', async () => {
  const calls = [];
  const result = await inspectConnection({ apiKey: KEY, fetchImpl: async (url, options) => {
    calls.push({ url, options });
    return json({ name: `models/${DEFAULT_MODEL}`, supportedGenerationMethods: ['generateContent', 'countTokens'] });
  } });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `https://generativelanguage.googleapis.com/v1beta/models/${DEFAULT_MODEL}`);
  assert.equal(calls[0].options.method, 'GET');
  assert.equal(calls[0].options.body, undefined);
  assert.equal(calls[0].options.headers['x-goog-api-key'], KEY);
  assert.equal(calls[0].options.redirect, 'error');
  assert.equal(result.authenticated, true);
  assert.equal(result.version, DEFAULT_MODEL);
  assert.doesNotMatch(result.message, /무료.*확인했|무료.*인증|Free.?Tier.*verified/i);
});

test('opaque auth keys with a period and other header-safe characters reach Google unchanged', async () => {
  const key = 'AQ.FAKE_TEST_KEY_NOT_A_CREDENTIAL:+/=';
  let calls = 0;
  const result = await inspectConnection({ apiKey: key, fetchImpl: async (_url, options) => {
    calls++;
    assert.equal(options.headers['x-goog-api-key'], key);
    return json({ name: `models/${DEFAULT_MODEL}`, supportedGenerationMethods: ['generateContent'] });
  } });
  assert.equal(calls, 1);
  assert.equal(result.authenticated, true);
  assert.equal(result.reason, 'READY');
  const generated = await getOpinion('작게 시험해 볼까요?', { apiKey: key, fetchImpl: async (_url, options) => {
    assert.equal(options.headers['x-goog-api-key'], key);
    return json(payload());
  } });
  assert.equal(generated.status, 'success');
  for (const invalid of ['fake key', 'fake\tkey', 'fake\r\nkey', 'fake\u0000key', 'fake\u007fkey', 'fake키', 'x'.repeat(4097)]) {
    let invalidCalls = 0;
    const status = await inspectConnection({ apiKey: invalid, fetchImpl: () => { invalidCalls++; } });
    assert.equal(invalidCalls, 0);
    assert.equal(status.reason, 'INVALID_API_KEY');
    assert.ok(!status.message.includes(invalid));
  }
});

test('generation uses header authentication, a fixed host, compact structured schema and no tools', async () => {
  let request;
  const result = await getOpinion('새 장비를 구매할까요? $(whoami)', { apiKey: KEY, fetchImpl: async (url, options) => {
    request = { url, options, body: JSON.parse(options.body) };
    return json(payload());
  } });
  assert.equal(request.url, `https://generativelanguage.googleapis.com/v1beta/models/${DEFAULT_MODEL}:generateContent`);
  assert.ok(!request.url.includes(KEY));
  assert.equal(request.options.method, 'POST');
  assert.equal(request.options.headers['x-goog-api-key'], KEY);
  assert.equal(request.body.contents[0].role, 'user');
  assert.match(request.body.contents[0].parts[0].text, /새 장비/);
  assert.deepEqual(request.body.generationConfig.responseJsonSchema.properties.stance.enum, ['YES', 'NO', 'CONDITIONAL', 'HOLD']);
  assert.equal(request.body.generationConfig.responseMimeType, 'application/json');
  assert.equal(request.body.tools, undefined);
  assert.equal(request.body.toolConfig, undefined);
  assert.equal(result.providerId, 'gemini');
  assert.equal(result.transport, 'api');
  assert.equal(result.text, opinion.body);
  assert.equal(result.model, `${DEFAULT_MODEL}-001`);
  assert.ok(result.elapsedMs >= 0);
});

test('main-process synthesis prompt is transmitted verbatim with the structured schema', async () => {
  const prompt = '모든 의견과 JEV 평가를 합쳐 하나의 권고를 작성하세요.';
  let text;
  const result = await getOpinion('원래 질문', { apiKey:KEY, prompt, fetchImpl:async (_url,options) => {
    text=JSON.parse(options.body).contents[0].parts[0].text;
    return json(payload());
  } });
  assert.equal(text,prompt);
  assert.equal(result.text,opinion.body);
  for (const invalid of ['', ' ', 42, 'a'.repeat(128001)]) {
    let calls=0;
    await assert.rejects(getOpinion('질문',{apiKey:KEY,prompt:invalid,fetchImpl:()=>{calls++;}}),{code:'INVALID_PROMPT'});
    assert.equal(calls,0);
  }
});

test('model identifiers cannot inject paths, URLs, query secrets or headers', async () => {
  for (const model of ['../gemini-foo', 'models/gemini-foo', 'https://evil.test/x', 'gemini-foo?key=secret', 'gemini-foo\r\nx-test:y', 'gemini-foo:generateContent']) {
    let called = false;
    await assert.rejects(getOpinion('질문', { apiKey: KEY, model, fetchImpl: () => { called = true; } }), { code: 'INVALID_MODEL' });
    assert.equal(called, false);
  }
});

test('invalid API key and question are rejected locally', async () => {
  await assert.rejects(getOpinion('질문', { apiKey: 'secret\r\ninjection' }), { code: 'INVALID_API_KEY' });
  await assert.rejects(getOpinion('', { apiKey: KEY }), { code: 'INVALID_QUESTION' });
  await assert.rejects(getOpinion('a'.repeat(12001), { apiKey: KEY }), { code: 'INVALID_QUESTION' });
});

test('authentication, quota and model failures have safe messages and never retry', async () => {
  for (const [status, code] of [[401, 'AUTH_REQUIRED'], [403, 'AUTH_REQUIRED'], [429, 'RATE_LIMIT'], [404, 'MODEL_UNAVAILABLE']]) {
    let calls = 0;
    const result = await inspectConnection({ apiKey: KEY, fetchImpl: async () => { calls++; return json({ error: { message: `Sensitive ${KEY}` } }, status); } });
    assert.equal(calls, 1);
    assert.equal(result.reason, code);
    assert.ok(!JSON.stringify(result).includes(KEY));
  }
  await assert.rejects(getOpinion('질문', { apiKey: KEY, fetchImpl: async () => json({ error: { details: [{ reason: 'API_KEY_INVALID' }], message: KEY } }, 400) }), { code: 'AUTH_REQUIRED' });
});

test('provider failures never expose provider body content', async () => {
  await assert.rejects(getOpinion('질문', { apiKey: KEY, fetchImpl: async () => json({ error: { message: `bad key ${KEY}` } }, 500) }), error => error.code === 'API_ERROR' && !error.message.includes(KEY));
});

test('network errors never expose raw URLs or credentials', async () => {
  const result = await inspectConnection({ apiKey: KEY, fetchImpl: async () => { throw new Error(`request failed at ?key=${KEY}`); } });
  assert.equal(result.reason, 'NETWORK_ERROR');
  assert.ok(!JSON.stringify(result).includes(KEY));
  assert.equal(result.authenticated, null);
});

test('timeout covers fetch even when it ignores the supplied AbortSignal', async () => {
  await assert.rejects(getOpinion('질문', { apiKey: KEY, timeoutMs: 20, fetchImpl: () => new Promise(() => {}) }), { code: 'TIMEOUT' });
});

test('timeout covers response body consumption after fetch resolves', async () => {
  await assert.rejects(getOpinion('질문', { apiKey: KEY, timeoutMs: 20, fetchImpl: async () => ({ status: 200, ok: true, text: () => new Promise(() => {}) }) }), { code: 'TIMEOUT' });
});

test('abort cancels in-flight fetch independently of fetch implementation', async () => {
  const controller = new AbortController();
  const running = getOpinion('질문', { apiKey: KEY, signal: controller.signal, fetchImpl: () => new Promise(() => {}) });
  controller.abort();
  await assert.rejects(running, { code: 'ABORTED' });
  let called = false;
  await assert.rejects(getOpinion('질문', { apiKey: KEY, signal: controller.signal, fetchImpl: () => { called = true; } }), { code: 'ABORTED' });
  assert.equal(called, false);
});

test('abort covers a hanging body parser', async () => {
  const controller = new AbortController();
  let bodyStarted;
  const started = new Promise(resolve => { bodyStarted = resolve; });
  const running = getOpinion('질문', { apiKey: KEY, signal: controller.signal, fetchImpl: async () => ({ status: 200, ok: true, text: () => { bodyStarted(); return new Promise(() => {}); } }) });
  await started;
  controller.abort();
  await assert.rejects(running, { code: 'ABORTED' });
});

test('malformed JSON, missing candidates and malformed structured opinions are rejected', async () => {
  await assert.rejects(getOpinion('질문', { apiKey: KEY, fetchImpl: async () => new Response('{not json') }), { code: 'INVALID_RESPONSE' });
  await assert.rejects(getOpinion('질문', { apiKey: KEY, fetchImpl: async () => json({}) }), { code: 'EMPTY_RESPONSE' });
  for (const text of ['', 'not json', JSON.stringify({ ...opinion, stance: 'MAYBE' }), JSON.stringify({ ...opinion, point: '' })]) {
    await assert.rejects(getOpinion('질문', { apiKey: KEY, fetchImpl: async () => json(payload({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text }] } }] })) }));
  }
});

test('safety filtering and truncated outputs cannot become successful opinions', async () => {
  await assert.rejects(getOpinion('질문', { apiKey: KEY, fetchImpl: async () => json(payload({ promptFeedback: { blockReason: 'SAFETY' } })) }), { code: 'SAFETY_BLOCKED' });
  for (const [finishReason, code] of [['SAFETY', 'SAFETY_BLOCKED'], ['MAX_TOKENS', 'INCOMPLETE_RESPONSE']]) {
    await assert.rejects(getOpinion('질문', { apiKey: KEY, fetchImpl: async () => json(payload({ candidates: [{ finishReason, content: { parts: [{ text: JSON.stringify(opinion) }] } }] })) }), { code });
  }
});

test('hidden thought parts are not parsed or displayed as the final opinion', async () => {
  const result = await getOpinion('질문', { apiKey: KEY, fetchImpl: async () => json(payload({ candidates: [{ finishReason: 'STOP', content: { parts: [{ thought: true, text: 'private thought' }, { text: JSON.stringify(opinion) }] } }] })) });
  assert.equal(result.text, opinion.body);
  assert.ok(!JSON.stringify(result).includes('private thought'));
});

test('unexpected function calls are rejected and never executed', async () => {
  await assert.rejects(getOpinion('질문', { apiKey: KEY, fetchImpl: async () => json(payload({ candidates: [{ content: { parts: [{ functionCall: { name: 'shell', args: {} } }] } }] })) }), { code: 'INVALID_RESPONSE' });
});

test('malformed content parts produce a controlled validation error', async () => {
  await assert.rejects(getOpinion('질문', { apiKey: KEY, fetchImpl: async () => json(payload({ candidates: [{ content: { parts: [null] } }] })) }), { code: 'INVALID_RESPONSE' });
});

test('metadata must advertise generateContent support', async () => {
  const malformed = await inspectConnection({ apiKey: KEY, fetchImpl: async () => json({}) });
  assert.equal(malformed.reason, 'INVALID_RESPONSE');
  const unsupported = await inspectConnection({ apiKey: KEY, fetchImpl: async () => json({ name: `models/${DEFAULT_MODEL}`, supportedGenerationMethods: ['embedContent'] }) });
  assert.equal(unsupported.reason, 'MODEL_UNAVAILABLE');
});

test('streaming response is bounded even without content-length', async () => {
  await assert.rejects(getOpinion('질문', { apiKey: KEY, maxResponseBytes: 100, fetchImpl: async () => new Response('x'.repeat(1000)) }), { code: 'OUTPUT_LIMIT' });
});

test('advertised oversized body is rejected before consumption', async () => {
  await assert.rejects(getOpinion('질문', { apiKey: KEY, maxResponseBytes: 100, fetchImpl: async () => new Response('{}', { headers: { 'content-length': '1000' } }) }), { code: 'OUTPUT_LIMIT' });
});

test('response body network failure is sanitized like an initial fetch failure', async () => {
  const result = await inspectConnection({ apiKey: KEY, fetchImpl: async () => ({ status: 200, ok: true, text: async () => { throw new Error(`response failed ${KEY}`); } }) });
  assert.equal(result.reason, 'NETWORK_ERROR');
  assert.ok(!JSON.stringify(result).includes(KEY));
});
