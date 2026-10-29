'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const DEFAULT_SETTINGS = Object.freeze({ model: 'jev-latest', timeoutMs: 180000 });
function validateSettings(value) {
  if (!value || typeof value.model !== 'string' || !/^jev-[a-zA-Z0-9._-]{1,64}$/.test(value.model) || ![120000,180000,300000].includes(value.timeoutMs)) {
    throw new Error('모델 또는 제한 시간이 올바르지 않습니다.');
  }
  return { model: value.model, timeoutMs: value.timeoutMs };
}
const MAX_BYTES = 25 * 1024 * 1024;
const finite = n => typeof n === 'number' && Number.isFinite(n);
function validRecord(r) {
  if (!r || !/^[a-f0-9-]{36}$/.test(r.id) || typeof r.question !== 'string' || r.question.length > 4000 || !Array.isArray(r.opinions) || r.opinions.length > 3) return false;
  if (!['preparing','awaiting_input','researching','running','evaluating','complete','partial','failed','canceled'].includes(r.status)) return false;
  if (r.opinions.some(o => !o || !['claude','codex','gemini'].includes(o.providerId) || !['pending','running','success','error','canceled'].includes(o.status) || (o.status === 'success' && typeof o.text !== 'string'))) return false;
  const e = r.evaluation;
  if (e != null && (!Array.isArray(e.opinions) || !finite(e.qualityAverage) || !e.verdict || !['YES','NO','CONDITIONAL','HOLD'].includes(e.verdict.choice) || !finite(e.verdict.confidence) || !e.verdict.probabilities || typeof e.model !== 'string')) return false;
  if (e?.opinions.some(o => !o || typeof o.providerId !== 'string' || !finite(o.total) || !Array.isArray(o.dimensions) || o.dimensions.some(d => !d || typeof d.id !== 'string' || !finite(d.points) || !finite(d.rawScore) || !finite(d.weight) || !finite(d.maxScore) || !d.legend || !d.probabilities))) return false;
  return true;
}
function createStore(directory) {
  let state = { settings: { ...DEFAULT_SETTINGS }, history: [] };
  let queue = Promise.resolve();
  const file = path.join(directory, 'decisions.json');
  async function load() {
    await fs.mkdir(directory, { recursive: true });
    try {
      const stat = await fs.stat(file);
      if (stat.size > MAX_BYTES) throw new Error('저장 기록이 허용 크기를 초과했습니다.');
      const parsed = JSON.parse(await fs.readFile(file, 'utf8'));
      const settings = validateSettings(parsed.settings);
      if (!Array.isArray(parsed.history)) throw new Error('기록 형식 오류');
      if (!parsed.history.every(validRecord)) throw new Error('기록 구조 오류');
      state = { settings, history: parsed.history.slice(0,100) };
    } catch (error) {
      if (error.code !== 'ENOENT') {
        // Preserve the original for recovery instead of overwriting it silently.
        await fs.copyFile(file, path.join(directory, `decisions-recovery-${Date.now()}.json`)).catch(() => {});
        state.warning = '기록 파일을 읽지 못해 복구 사본을 보존했습니다.';
      }
    }
    return snapshot();
  }
  function snapshot() { return structuredClone(state); }
  function write(update) {
    const operation = queue.then(async () => {
      const next = structuredClone(state);
      update(next);
      let serialized = JSON.stringify(next, null, 2);
      while (Buffer.byteLength(serialized, 'utf8') > MAX_BYTES && next.history.length > 1) {
        next.history.pop();
        serialized = JSON.stringify(next, null, 2);
      }
      if (Buffer.byteLength(serialized, 'utf8') > MAX_BYTES) throw new Error('저장 기록이 허용 크기를 초과했습니다.');
      const temp = `${file}.${randomUUID()}.tmp`;
      try {
        await fs.writeFile(temp, serialized, { mode: 0o600 });
        await fs.rename(temp, file);
        state = next;
      } finally { await fs.unlink(temp).catch(() => {}); }
      return snapshot();
    });
    queue = operation.catch(() => {});
    return operation;
  }
  return {
    load, snapshot,
    saveSettings(value) { const settings = validateSettings(value); return write(s => { s.settings = settings; }); },
    saveRecord(record) {
      if (!validRecord(record)) throw new Error('기록 형식 오류');
      const copy = structuredClone(record);
      return write(s => { s.history = [copy, ...s.history.filter(r => r.id !== copy.id)].slice(0,100); });
    }
  };
}
module.exports = { createStore, validateSettings, DEFAULT_SETTINGS };
