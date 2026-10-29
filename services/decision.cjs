'use strict';
const { randomUUID } = require('node:crypto');
const { createAttachmentService } = require('./attachments.cjs');

function createDecisionService({ providers, getOpinion, evaluate, store, getApiKey, cwd, researchService, onEvent = () => {} }) {
  let current = null;
  const emit = (run, type = 'update') => onEvent({ runId: run.record.id, type, record: structuredClone(run.record) });
  async function prepare(run, settings) {
    try {
      run.record.preparation = await researchService.prepare({
        question: run.record.question, attachments: run.documents, apiKey: getApiKey(), model: settings.model, cwd,
        signal: run.controller.signal, timeoutMs: settings.timeoutMs,
        onProgress: progress => { run.record.researchProgress = progress; emit(run); },
      });
      if (run.controller.signal.aborted) throw new Error('취소됨');
      if (!Array.isArray(run.record.preparation?.questions)) throw Object.assign(new Error('사전 검토 결과를 확인할 수 없습니다.'), { code: 'PREPARATION_FAILED' });
      if (!run.record.preparation.questions.length) {
        run.record.answers = {};
        run.record.status = 'researching';
        await execute(run, settings);
        return;
      }
      run.record.status = 'awaiting_input';
      await store.saveRecord(run.record);
      emit(run, 'awaiting_input');
    } catch (error) {
      run.record.status = run.controller.signal.aborted ? 'canceled' : 'failed';
      if (!run.controller.signal.aborted) { run.record.error = error.message || '사전 검토에 실패했습니다.'; run.record.errorCode = error.code || 'PREPARATION_FAILED'; }
      run.record.completedAt = new Date().toISOString();
      try { await store.saveRecord(run.record); } catch { run.record.saveError = '기록 저장에 실패했습니다.'; }
      if (current === run) current = null;
      emit(run, 'complete');
    }
  }
  async function execute(run, settings) {
    try {
      if (researchService) {
        // Persist the clarified case and extracted files before external research begins.
        await store.saveRecord(run.record);
        if (run.controller.signal.aborted) { run.record.status = 'canceled'; return; }
        run.record.status = 'researching'; emit(run);
        run.record.research = await researchService.research({
          question: run.record.question, preparation: run.record.preparation, answers: run.record.answers, attachments: run.documents,
          cwd, signal: run.controller.signal, timeoutMs: Math.min(600000, settings.timeoutMs * 2),
          onProgress: progress => { run.record.researchProgress = progress; emit(run); },
        });
        if (run.controller.signal.aborted) { run.record.status = 'canceled'; return; }
        if (!run.record.research?.sources?.length || typeof run.record.research.context !== 'string') throw Object.assign(new Error('조사 근거를 확인할 수 없어 토론을 시작하지 않았습니다.'), { code: 'RESEARCH_FAILED' });
        run.record.status = 'running'; emit(run);
      }
      await Promise.all(providers.map(async (provider, index) => {
        const target = run.record.opinions[index];
        if (run.controller.signal.aborted) { target.status = 'canceled'; return; }
        target.status = 'running'; emit(run);
        try {
          Object.assign(target, await getOpinion(provider.id, run.record.question, { cwd, signal: run.controller.signal, timeoutMs: settings.timeoutMs, researchContext: run.record.research?.context,
            onProgress: debate => {
              if (target.status !== 'running' || !['claude','codex'].includes(provider.id) || debate?.version !== 1 || !Array.isArray(debate.agents)) return;
              target.debate = structuredClone(debate);
              emit(run);
            }
          }));
        } catch (error) {
          Object.assign(target, {
            status: run.controller.signal.aborted ? 'canceled' : 'error',
            error: error?.message || 'AI 응답을 받지 못했습니다.',
            errorCode: typeof error?.code === 'string' && /^[A-Z0-9_]{1,64}$/.test(error.code) ? error.code : 'PROVIDER_ERROR',
          });
        }
        if (target.status !== 'success' && target.status !== 'canceled') {
          target.status = 'error';
          target.error ||= 'AI 응답을 받지 못했습니다.';
          target.errorCode ||= 'PROVIDER_ERROR';
          target.excluded = true;
        }
        emit(run);
      }));
      if (run.controller.signal.aborted) { run.record.status = 'canceled'; return; }
      const opinions = run.record.opinions.filter(o => o.status === 'success');
      if (!opinions.length) throw Object.assign(new Error('사용 가능한 AI 답변이 없어 판단을 중단했습니다. 각 AI의 제외 사유와 연결 설정을 확인하세요.'), { code: 'NO_SUCCESSFUL_OPINIONS' });
      if (!getApiKey()) throw new Error('JEV_API_KEY가 설정되지 않았습니다. .env 설정 후 앱을 다시 실행하세요.');
      run.record.status = 'evaluating'; emit(run);
      run.record.evaluation = await evaluate({ question: run.record.question, opinions, apiKey: getApiKey(), model: settings.model, signal: run.controller.signal,
        cwd, timeoutMs: settings.timeoutMs, researchContext: run.record.research?.context, researchSources: run.record.research?.sources,
        onProgress: progress => {
          if (run.controller.signal.aborted || typeof progress?.stage !== 'string') return;
          run.record.evaluationStage = progress.stage;
          if (Array.isArray(progress.reviews)) run.record.refinementProgress = structuredClone(progress.reviews);
          emit(run);
        }
      });
      if (run.controller.signal.aborted) { run.record.evaluation = null; run.record.status = 'canceled'; return; }
      run.record.status = opinions.length === providers.length && run.record.evaluation?.synthesis?.status !== 'error' &&
        !run.record.evaluation?.refinement?.reviews?.some(review => review.status === 'error') && (!run.record.research || run.record.research.status === 'complete') ? 'complete' : 'partial';
    } catch (error) {
      run.record.status = run.controller.signal.aborted ? 'canceled' : 'failed';
      if (!run.controller.signal.aborted) {
        run.record.error = error?.message || '판단 중 오류가 발생했습니다.';
        if (typeof error?.code === 'string' && /^[A-Z0-9_]{1,64}$/.test(error.code)) run.record.errorCode = error.code;
      }
    } finally {
      run.record.completedAt = new Date().toISOString();
      try { await store.saveRecord(run.record); } catch { run.record.saveError = '기록 저장에 실패했습니다. 앱을 닫기 전에 결과를 복사하세요.'; }
      if (current === run) current = null;
      emit(run, 'complete');
    }
  }
  return {
    start({ question, attachments = [] }, settings) {
      if (current) throw new Error('진행 중인 판단을 완료하거나 취소하세요.');
      if (typeof question !== 'string' || !question.trim() || question.trim().length > 4000) throw new Error('질문을 1~4,000자로 입력하세요.');
      const record = { id: randomUUID(), question: question.trim(), intakeDocuments: structuredClone(attachments), createdAt: new Date().toISOString(), status: researchService ? 'preparing' : 'running', attachments: attachments.map(({ id, name, size, truncated, warning }) => ({ id, name, size, truncated, warning })), opinions: providers.map(p => ({ providerId:p.id, name:p.name, status:'pending' })), evaluation: null };
      const run = { record, documents: structuredClone(attachments), settings: { ...settings }, controller:new AbortController(), done:null };
      current = run;
      // Yield so the renderer can receive the run ID before the first event.
      run.done = new Promise(resolve => setImmediate(resolve)).then(() => researchService ? prepare(run, run.settings) : execute(run, run.settings));
      return { runId:record.id };
    },
    restore(record, settings) {
      if (current) throw new Error('진행 중인 판단을 완료하거나 취소하세요.');
      const invalid = () => new Error('저장된 사전 검토를 복원할 수 없습니다. 새 질문으로 시작해 주세요.');
      const prepared = record?.preparation;
      if (!researchService || !record || record.status !== 'awaiting_input' ||
        typeof record.id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(record.id) ||
        typeof record.question !== 'string' || !record.question.trim() || record.question.length > 4000 ||
        !prepared || prepared.version !== 1 || !Array.isArray(prepared.plans) || !prepared.plans.some(plan => plan?.status === 'success') ||
        !Array.isArray(prepared.searches) || !Array.isArray(prepared.questions) || prepared.questions.length > 48 ||
        !prepared.judgment || !Array.isArray(prepared.judgment.items) ||
        prepared.questions.some(item => !item || typeof item.id !== 'string' || !item.id || item.id.length > 100 || typeof item.question !== 'string' || !item.question.trim() || item.question.length > 800 || typeof item.required !== 'boolean') ||
        new Set(prepared.questions.map(item => item.id)).size !== prepared.questions.length ||
        !Array.isArray(record.opinions) || record.opinions.length !== providers.length || record.opinions.some(item => !item || item.status !== 'pending' || !providers.some(provider => provider.id === item.providerId)) ||
        new Set(record.opinions.map(item => item.providerId)).size !== providers.length || record.evaluation != null ||
        !Array.isArray(record.attachments) || (!Array.isArray(record.intakeDocuments) && record.attachments.length) ||
        !settings || typeof settings.model !== 'string' || !Number.isFinite(settings.timeoutMs) || settings.timeoutMs <= 0 || settings.timeoutMs > 600000) throw invalid();
      const validator = createAttachmentService({ chooseFiles: async () => [] });
      const documents = structuredClone(record.intakeDocuments || []);
      validator.remember(documents);
      if (record.attachments.length !== documents.length || new Set(record.attachments.map(item => item?.id)).size !== documents.length || record.attachments.some(item => !item || !documents.some(doc => doc.id === item.id))) throw invalid();
      const restored = structuredClone(record);
      restored.intakeDocuments = structuredClone(documents);
      restored.attachments = documents.map(({ id, name, size, truncated, warning }) => ({ id, name, size, truncated, warning }));
      restored.opinions = providers.map(provider => ({ providerId: provider.id, name: provider.name, status: 'pending' }));
      current = { record: restored, documents, settings: structuredClone(settings), controller: new AbortController(), done: Promise.resolve() };
      return { runId: restored.id };
    },
    continue({ runId, answers = {}, attachments } = {}) {
      const run = current;
      if (!run || run.record.id !== runId || run.record.status !== 'awaiting_input') throw new Error('진행할 사전 검토를 찾지 못했습니다. 새 질문으로 시작해 주세요.');
      const questions = run.record.preparation.questions || [];
      if (!answers || typeof answers !== 'object' || Array.isArray(answers) || Object.entries(answers).some(([id, value]) =>
        !questions.some(question => question.id === id) || typeof value !== 'string' || value.length > 4000)) throw new Error('사전 답변 형식을 확인해 주세요. 항목당 4,000자까지 입력할 수 있습니다.');
      if (questions.some(question => question.required && !answers[question.id]?.trim())) throw new Error('필수 사전 질문에 답해 주세요. 알 수 없다면 모름이라고 적어 주세요.');
      run.record.answers = structuredClone(answers);
      if (attachments) run.documents = structuredClone(attachments);
      run.record.intakeDocuments = structuredClone(run.documents);
      run.record.attachments = run.documents.map(({ id, name, size, truncated, warning }) => ({ id, name, size, truncated, warning }));
      run.record.status = 'researching';
      run.done = new Promise(resolve => setImmediate(resolve)).then(() => execute(run, run.settings));
      return { runId: run.record.id };
    },
    async cancel() {
      const run = current;
      if (!run) return { canceled: false };
      run.controller.abort();
      if (run.record.status === 'awaiting_input') {
        run.record.status = 'canceled'; run.record.completedAt = new Date().toISOString();
        try { await store.saveRecord(run.record); } catch { run.record.saveError = '기록 저장에 실패했습니다.'; }
        if (current === run) current = null;
        emit(run, 'complete');
      } else await run.done;
      return { canceled: true };
    },
    active() { return current ? structuredClone(current.record) : null; },
    async wait() { await current?.done; }
  };
}
module.exports = { createDecisionService };
