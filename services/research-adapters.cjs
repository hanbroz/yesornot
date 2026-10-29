'use strict';
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const cli = require('./cli.cjs');
const gemini = require('./gemini.cjs');

function error(code, message) { return Object.assign(new Error(message), { code }); }
function json(text) {
  try { return JSON.parse(String(text).trim().replace(/^```(?:json)?\s*([\s\S]*?)\s*```$/i, '$1')); }
  catch { throw error('INVALID_RESPONSE', '자료 조사 응답의 JSON 형식을 확인할 수 없습니다.'); }
}
function buildStructuredArgs(id, directory, schema, research) {
  const args = cli.buildArgs(id, directory);
  if (id === 'claude') {
    args[args.indexOf('--json-schema') + 1] = JSON.stringify(schema);
    if (research) {
      args[args.indexOf('--output-format') + 1] = 'stream-json';
      args[args.indexOf('--tools') + 1] = 'WebSearch,WebFetch';
      args.push('--allowedTools', 'WebSearch,WebFetch', '--verbose', '--max-turns', '28');
    }
  } else {
    args.push('--output-schema', path.join(directory, 'response-schema.json'));
    if (research) {
      args[args.indexOf('web_search="disabled"')] = 'web_search="live"';
      const disabledSearch = args.indexOf('search_tool');
      if (disabledSearch > 0 && args[disabledSearch - 1] === '--disable') args.splice(disabledSearch - 1, 2);
    }
  }
  return args;
}
function parseStructured(id, output, research = false) {
  const events = id === 'codex' || research ? String(output).trim().split(/\r?\n/).filter(Boolean).map(json) : [json(output)];
  const terminal = id === 'claude' ? events.findLast(event => event.type === 'result') || events.at(-1) : null;
  if (terminal?.is_error || events.some(event => ['turn.failed', 'error'].includes(event.type))) throw error('PROVIDER_ERROR', 'AI가 사전 검토 또는 자료 조사를 완료하지 못했습니다.');
  const final = id === 'claude' ? terminal?.structured_output || json(terminal?.result) : json(events.filter(event => event.type === 'item.completed' && event.item?.type === 'agent_message').at(-1)?.item?.text);
  if (!final || typeof final !== 'object' || Array.isArray(final)) throw error('INVALID_RESPONSE', '자료 조사 응답 항목을 확인할 수 없습니다.');
  const queries = [], urls = new Set(), calls = new Map();
  let searched = false;
  for (const event of events) {
    if (id === 'codex' && event.type === 'item.completed' && event.item?.type === 'web_search' && event.item.status !== 'failed') {
      const action = event.item.action;
      if (action?.type === 'search') {
        searched = true;
        for (const query of action.queries || [action.query]) if (typeof query === 'string') queries.push(query.slice(0, 500));
      }
      if (typeof action?.url === 'string') urls.add(action.url);
    }
    for (const block of event.message?.content || []) {
      if (block.type === 'tool_use' && ['WebSearch', 'WebFetch'].includes(block.name)) calls.set(block.id, block);
      if (block.type === 'tool_result' && !block.is_error) {
        const call = calls.get(block.tool_use_id);
        if (!call) continue;
        const result = typeof block.content === 'string' ? block.content : JSON.stringify(block.content);
        const found = result.match(/https?:\/\/[^\s<>"\\]+/g) || [];
        for (const url of found) urls.add(url.replace(/[),.;]+$/, ''));
        if (call.name === 'WebSearch' && found.length) {
          searched = true;
          if (typeof call.input?.query === 'string') queries.push(call.input.query.slice(0, 500));
        }
        if (call.name === 'WebFetch' && typeof call.input?.url === 'string') urls.add(call.input.url);
      }
    }
  }
  if (id === 'codex' && research && !searched && events.some(event => event.type === 'item.completed' && event.item?.type === 'error' &&
    /Code Mode is unavailable because code-mode host is disabled/i.test(String(event.item.message || '')))) {
    throw error('RESEARCH_TOOLS_UNAVAILABLE', '현재 Codex CLI에서는 검색 도구를 사용할 수 없어 자체 조사에서 제외했습니다. 다른 AI가 수집한 근거로 토론합니다.');
  }
  return { data: final, model: terminal?.model || Object.keys(terminal?.modelUsage || {})[0] || events.find(event => event.model)?.model || '',
    provenance: { searched, queries: [...new Set(queries)].slice(0, 40), sources: [...urls].slice(0, 60).map(url => ({ url, title: url })), engine: id === 'claude' ? 'Claude WebSearch / WebFetch' : 'Codex live web search' } };
}
async function getCliStructured(id, prompt, schema, { cwd, signal, timeoutMs = 180000, research = false } = {}) {
  if (!['claude', 'codex'].includes(id) || typeof prompt !== 'string' || !prompt.trim() || prompt.length > 128000 || !schema || typeof schema !== 'object') throw error('INVALID_INPUT', '사전 검토 요청 형식이 올바르지 않습니다.');
  if (signal?.aborted) throw error('ABORTED', '요청이 취소되었습니다.');
  const binary = cli.resolveCli(id, { cwd });
  if (!binary) throw error('NOT_INSTALLED', '공식 AI CLI가 설치되어 있지 않습니다.');
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'yesornot-research-'));
  try {
    const env = cli.cleanEnvironment();
    if (!await cli.subscriptionAuthenticated(id, binary, { cwd: directory, env, signal, timeoutMs: Math.min(15000, timeoutMs) })) throw error('AUTH_REQUIRED', '구독 계정 로그인이 필요합니다.');
    if (id === 'codex') await fs.writeFile(path.join(directory, 'response-schema.json'), JSON.stringify(schema));
    const result = await cli.runProcess(binary.command, [...binary.args, ...buildStructuredArgs(id, directory, schema, research)], { cwd: directory, env, input: prompt, signal, timeoutMs, maxOutputBytes: 6 * 1024 * 1024 });
    if (result.exitCode !== 0) throw cli.providerFailure(id, result);
    return parseStructured(id, result.stdout, research);
  } finally { await fs.rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }).catch(() => {}); }
}
async function getGeminiStructured(prompt, schema, options = {}) {
  const { key, model } = gemini.validateOptions(options);
  const data = await gemini.requestJson(`${model}:generateContent`, { ...options, key, method: 'POST', body: {
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    ...(options.research ? { tools: [{ google_search: {} }] } : {}),
    generationConfig: { responseMimeType: 'application/json', responseJsonSchema: schema, maxOutputTokens: 12000, candidateCount: 1 },
  } });
  const candidate = data.candidates?.[0];
  if (!candidate || (candidate.finishReason && candidate.finishReason !== 'STOP') || !Array.isArray(candidate.content?.parts)) throw error('INVALID_RESPONSE', 'Gemini가 자료 조사 응답을 완료하지 못했습니다.');
  const parts = candidate.content.parts;
  if (parts.some(part => part.functionCall || part.executableCode)) throw error('INVALID_RESPONSE', '자료 조사 응답에 지원하지 않는 도구 요청이 있습니다.');
  const text = parts.filter(part => !part.thought && typeof part.text === 'string').map(part => part.text).join('');
  const grounding = candidate.groundingMetadata;
  const sources = (grounding?.groundingChunks || []).filter(chunk => typeof chunk.web?.uri === 'string').map(chunk => ({ url: chunk.web.uri, title: chunk.web.title || chunk.web.uri }));
  return { data: json(text), model: data.modelVersion || model, provenance: {
    searched: Boolean(grounding?.webSearchQueries?.length && sources.length), queries: grounding?.webSearchQueries || [], sources, engine: 'Google Search grounding',
    // Suggestions remain separate from model output and are rendered in an isolated, sandboxed frame.
    searchEntryPoint: grounding?.searchEntryPoint?.renderedContent || '',
  } };
}
module.exports = { buildStructuredArgs, parseStructured, getCliStructured, getGeminiStructured };
