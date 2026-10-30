'use strict';

const { buildPrompt, parseOpinion } = require('./cli.cjs');

const DEFAULT_MODEL = 'gemini-3.5-flash-lite';
const API_ROOT = 'https://generativelanguage.googleapis.com/v1beta/models/';
const DEFAULT_TIMEOUT_MS = 180000;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const RESPONSE_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    stance: { type: 'string', enum: ['YES', 'NO', 'CONDITIONAL', 'HOLD'] },
    title: { type: 'string' }, body: { type: 'string' }, point: { type: 'string' },
  },
  required: ['stance', 'title', 'body', 'point'],
};

class GeminiApiError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function failure(code, message) {
  return new GeminiApiError(code, message);
}

function validateOptions({ apiKey, model = DEFAULT_MODEL } = {}) {
  if (typeof apiKey !== 'string' || !apiKey.trim()) throw failure('NOT_CONFIGURED', 'Gemini API 키를 입력하고 저장해 주세요.');
  const key = apiKey.trim();
  // Google-issued keys are opaque: newer auth keys can contain a period.
  // Reject unsafe header values locally; let Google validate the credential itself.
  if (key.length > 4096 || /[^\x21-\x7E]/.test(key)) throw failure('INVALID_API_KEY', 'Gemini API 키에 공백이나 잘못된 문자가 포함되어 있는지 확인해 주세요.');
  if (typeof model !== 'string' || !/^gemini-[a-z0-9][a-z0-9._-]{0,119}$/.test(model)) {
    throw failure('INVALID_MODEL', 'Gemini 모델 이름이 올바르지 않습니다. 연결 설정에서 모델을 다시 선택해 주세요.');
  }
  return { key, model };
}

async function readJsonBounded(response, limit, signal) {
  const advertised = Number(response.headers?.get?.('content-length'));
  if (Number.isFinite(advertised) && advertised > limit) {
    response.body?.cancel?.().catch(() => {});
    throw failure('OUTPUT_LIMIT', 'Gemini 응답이 허용 크기를 초과했습니다.');
  }
  let text;
  if (response.body?.getReader) {
    const reader = response.body.getReader();
    const chunks = [];
    let bytes = 0;
    try {
      while (true) {
        if (signal.aborted) throw failure('ABORTED', '요청이 취소되었습니다.');
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > limit) {
          reader.cancel().catch(() => {});
          throw failure('OUTPUT_LIMIT', 'Gemini 응답이 허용 크기를 초과했습니다.');
        }
        chunks.push(Buffer.from(value));
      }
      text = Buffer.concat(chunks).toString('utf8');
    } finally { reader.releaseLock(); }
  } else {
    text = await response.text();
    if (Buffer.byteLength(text, 'utf8') > limit) throw failure('OUTPUT_LIMIT', 'Gemini 응답이 허용 크기를 초과했습니다.');
  }
  try { return JSON.parse(text); }
  catch { throw failure('INVALID_RESPONSE', 'Gemini API가 올바른 JSON 응답을 반환하지 않았습니다.'); }
}

async function requestJson(suffix, { key, signal, timeoutMs = DEFAULT_TIMEOUT_MS, fetchImpl = globalThis.fetch, method = 'GET', body, maxResponseBytes = MAX_RESPONSE_BYTES } = {}) {
  if (typeof fetchImpl !== 'function') throw failure('NETWORK_ERROR', '이 실행 환경에서 Gemini API 요청을 지원하지 않습니다.');
  if (signal?.aborted) throw failure('ABORTED', '요청이 취소되었습니다.');
  const controller = new AbortController();
  const deadline = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_TIMEOUT_MS;
  const limit = Number.isSafeInteger(maxResponseBytes) && maxResponseBytes > 0 ? Math.min(maxResponseBytes, MAX_RESPONSE_BYTES) : MAX_RESPONSE_BYTES;
  let timer;
  let onAbort;
  const stopped = new Promise((_, reject) => {
    onAbort = () => {
      reject(failure('ABORTED', '요청이 취소되었습니다.'));
      controller.abort();
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
    timer = setTimeout(() => {
      reject(failure('TIMEOUT', 'Gemini API 응답 시간이 초과되었습니다. 잠시 후 다시 시도해 주세요.'));
      controller.abort();
    }, deadline);
  });
  const operation = async () => {
    let response;
    try {
      response = await fetchImpl((suffix.startsWith('?') ? API_ROOT.slice(0, -1) : API_ROOT) + suffix, {
        method, redirect: 'error', signal: controller.signal,
        headers: { 'x-goog-api-key': key, ...(body ? { 'Content-Type': 'application/json' } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
    } catch { throw failure('NETWORK_ERROR', 'Gemini API에 연결하지 못했습니다. 인터넷 연결을 확인해 주세요.'); }
    if (!response || !Number.isInteger(response.status)) throw failure('INVALID_RESPONSE', 'Gemini API 응답을 확인하지 못했습니다.');
    if ([401, 403, 404, 429].includes(response.status)) {
      response.body?.cancel?.().catch(() => {});
      if (response.status === 401 || response.status === 403) throw failure('AUTH_REQUIRED', 'Gemini API 키 또는 API 접근 권한을 확인해 주세요.');
      if (response.status === 404) throw failure('MODEL_UNAVAILABLE', '설정한 Gemini 모델을 사용할 수 없습니다. GEMINI_MODEL을 확인해 주세요.');
      throw failure('RATE_LIMIT', 'Gemini API 사용 한도에 도달했습니다. Google AI Studio에서 한도와 프로젝트 설정을 확인해 주세요.');
    }
    const data = await readJsonBounded(response, limit, controller.signal);
    if (!response.ok || data?.error) {
      const invalidKey = data?.error?.details?.some?.(item => item.reason === 'API_KEY_INVALID') || /api.?key.*(?:not valid|invalid|expired)/i.test(String(data?.error?.message || ''));
      if (invalidKey) throw failure('AUTH_REQUIRED', 'Gemini API 키가 유효하지 않습니다. 연결 설정에서 키를 다시 입력해 주세요.');
      throw failure('API_ERROR', `Gemini API 요청을 완료하지 못했습니다 (HTTP ${response.status}). 모델과 프로젝트 설정을 확인해 주세요.`);
    }
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw failure('INVALID_RESPONSE', 'Gemini API 응답 형식이 올바르지 않습니다.');
    return data;
  };
  try { return await Promise.race([operation(), stopped]); }
  catch (error) {
    if (error instanceof GeminiApiError) throw error;
    throw failure('NETWORK_ERROR', 'Gemini API 응답을 읽지 못했습니다. 인터넷 연결을 확인해 주세요.');
  }
  finally { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); }
}

async function inspectConnection(options = {}) {
  const base = {
    id: 'gemini', name: 'Gemini', transport: 'api', installed: true,
    configured: typeof options.apiKey === 'string' && Boolean(options.apiKey.trim()), authenticated: null,
    version: typeof options.model === 'string' && /^gemini-[a-z0-9][a-z0-9._-]{0,119}$/.test(options.model) ? options.model : DEFAULT_MODEL,
  };
  try {
    const { key, model } = validateOptions(options);
    const data = await requestJson(model, { ...options, key, timeoutMs: options.timeoutMs ?? 15000 });
    if (typeof data.name !== 'string' || !/^models\/gemini-[a-z0-9._-]+$/.test(data.name) || !Array.isArray(data.supportedGenerationMethods)) {
      throw failure('INVALID_RESPONSE', 'Gemini 모델 정보를 확인하지 못했습니다.');
    }
    if (!data.supportedGenerationMethods.includes('generateContent')) throw failure('MODEL_UNAVAILABLE', '설정한 Gemini 모델은 텍스트 의견 생성을 지원하지 않습니다.');
    let models = [model];
    try {
      const list = await requestJson('?pageSize=1000', { ...options, key, timeoutMs: options.timeoutMs ?? 15000 });
      const names = (Array.isArray(list.models) ? list.models : [])
        .filter(entry => Array.isArray(entry?.supportedGenerationMethods) && entry.supportedGenerationMethods.includes('generateContent'))
        .map(entry => String(entry.name).replace(/^models\//, '')).filter(name => /^gemini-[a-z0-9][a-z0-9._-]{0,119}$/.test(name));
      models = [...new Set([model, ...names])];
    } catch { /* The selected model was already verified; the list is optional. */ }
    return { ...base, authenticated: true, version: model, models, message: 'Gemini API 키와 모델 접근을 확인했습니다. 요금제와 무료 한도는 Google AI Studio에서 확인해 주세요.', reason: 'READY', action: 'none' };
  } catch (error) {
    return { ...base,
      authenticated: ['NOT_CONFIGURED', 'INVALID_API_KEY', 'AUTH_REQUIRED'].includes(error.code) ? false : null,
      message: error.message, reason: error.code || 'API_ERROR',
      action: ['NOT_CONFIGURED', 'INVALID_API_KEY', 'AUTH_REQUIRED'].includes(error.code) ? 'configure_api_key' : 'check_api_settings',
    };
  }
}

async function getOpinion(question, options = {}) {
  const { key, model } = validateOptions(options);
  if (typeof question !== 'string' || !question.trim() || question.length > 12000) throw failure('INVALID_QUESTION', '질문은 1~12,000자로 입력해 주세요.');
  if (options.prompt !== undefined && (typeof options.prompt !== 'string' || !options.prompt.trim() || options.prompt.length > 128000)) throw failure('INVALID_PROMPT', '종합 의견 요청 형식을 확인해 주세요.');
  const started = Date.now();
  const data = await requestJson(`${model}:generateContent`, {
    ...options, key, method: 'POST',
    body: {
      contents: [{ role: 'user', parts: [{ text: options.prompt ?? buildPrompt(question.trim(), options.researchContext) }] }],
      generationConfig: { responseMimeType: 'application/json', responseJsonSchema: RESPONSE_SCHEMA, maxOutputTokens: 4096, candidateCount: 1 },
    },
  });
  if (data.promptFeedback?.blockReason && data.promptFeedback.blockReason !== 'BLOCK_REASON_UNSPECIFIED') {
    throw failure('SAFETY_BLOCKED', 'Gemini 안전 필터가 이 질문의 응답을 차단했습니다. 질문을 수정해 주세요.');
  }
  const candidate = data.candidates?.[0];
  if (!candidate) throw failure('EMPTY_RESPONSE', 'Gemini가 의견을 반환하지 않았습니다.');
  if (candidate.finishReason && candidate.finishReason !== 'STOP') {
    if (['SAFETY', 'BLOCKLIST', 'PROHIBITED_CONTENT', 'RECITATION', 'SPII', 'IMAGE_SAFETY'].includes(candidate.finishReason)) throw failure('SAFETY_BLOCKED', 'Gemini 안전 필터가 응답을 차단했습니다. 질문을 수정해 주세요.');
    throw failure('INCOMPLETE_RESPONSE', 'Gemini 응답이 끝까지 생성되지 않았습니다. 질문을 줄여 다시 시도해 주세요.');
  }
  const parts = candidate.content?.parts;
  if (!Array.isArray(parts) || parts.some(part => !part || typeof part !== 'object' || part.functionCall || part.executableCode)) throw failure('INVALID_RESPONSE', 'Gemini가 텍스트 의견 형식으로 응답하지 않았습니다.');
  const text = parts.filter(part => !part.thought && typeof part.text === 'string').map(part => part.text).join('');
  if (!text.trim()) throw failure('EMPTY_RESPONSE', 'Gemini가 텍스트 의견을 반환하지 않았습니다.');
  const actualModel = typeof data.modelVersion === 'string' && /^gemini-[a-z0-9._-]{1,120}$/.test(data.modelVersion) ? data.modelVersion : model;
  let opinion;
  try { opinion = parseOpinion('gemini', JSON.stringify({ response: text, model: actualModel })); }
  catch { throw failure('INVALID_RESPONSE', 'Gemini 의견의 JSON 형식 또는 필수 항목이 올바르지 않습니다. 다시 시도해 주세요.'); }
  return { providerId: 'gemini', name: 'Gemini', transport: 'api', status: 'success', ...opinion, elapsedMs: Date.now() - started };
}

module.exports = { DEFAULT_MODEL, inspectConnection, getOpinion, validateOptions, requestJson };
