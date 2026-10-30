'use strict';

const bridge = window.decisionApp;
const $ = (id) => document.getElementById(id);
const PROVIDERS = [
  { id: 'claude', name: 'Claude', symbol: '✳', css: 'claude-avatar', color: 'claude-color' },
  { id: 'codex', name: 'ChatGPT', symbol: 'G', css: 'gpt-avatar', color: 'gpt-color' },
  { id: 'gemini', name: 'Gemini', symbol: '✦', css: 'gemini-avatar', color: 'gemini-color' }
];
const STATUS = { preparing: '사전 검토 중', awaiting_input: '추가 답변 대기', researching: '자료 조사 중', running: '의견 수집 중', evaluating: 'JEV 평가 중', complete: '평가 완료', partial: '평가 완료 · 일부 한계 있음', failed: '실행 실패', canceled: '취소됨' };
const SAMPLES = {
  launch: '새로운 서비스를 완성 전에 먼저 공개해도 될까요? 핵심 기능은 동작하며, 소규모 사용자에게 베타로 공개하려고 합니다.',
  desktop: '작은 팀의 첫 제품을 데스크톱 앱으로 출시해도 될까요? 로컬 CLI 연동이 핵심이며, 우선 Windows 사용자를 대상으로 합니다.',
  meeting: '우리 팀에 회의 없는 수요일을 도입해도 될까요? 긴급 대응은 유지하고, 일반 진행 상황은 문서로 공유하려고 합니다.'
};
let history = [];
let connections = { providers: [], jev: null };
const CONNECTIONS = [
  { id: 'claude', title: 'Claude CLI', kind: 'cli', icon: 'claude-avatar', symbol: '✳' },
  { id: 'codex', title: 'ChatGPT · Codex CLI', kind: 'cli', icon: 'gpt-avatar', symbol: 'G' },
  { id: 'gemini', title: 'Gemini · API', kind: 'api', icon: 'gemini-avatar', symbol: '✦' },
  { id: 'jev', title: 'JEV 평가 · API', kind: 'api', icon: 'jev-mark', symbol: 'j.' }
];
const connectionCards = {};
const checkingConnections = new Set();
const terminalOpened = new Set();
let geminiModel = '';
let settings = { model: 'jev-latest', timeoutMs: 180000 };
let activeId = null;
let viewed = null;
let pendingStart = false;
let pendingContinue = false;
let questionnairePending = false;
let attachmentPending = false;
let attachments = [];
let clarificationAnswers = {};
let clarificationRunId = null;
let ready = false;
let credentialsPending = false;
let updatePending = false;
let updateState = { status: 'disabled', message: '이 실행에서는 자동 업데이트를 사용할 수 없습니다.' };
let toastTimer;
let activityTimer = null;
let activityStartedAt = null;
const dialogOpeners = new WeakMap();

function element(tag, className, text) {
  const result = document.createElement(tag);
  if (className) result.className = className;
  if (text !== undefined) result.textContent = String(text);
  return result;
}
function icon(name) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', '#' + name);
  svg.setAttribute('aria-hidden', 'true');
  svg.append(use);
  return svg;
}
function message(error) { return error && typeof error.message === 'string' ? error.message : '요청을 처리하지 못했습니다. 다시 시도해 주세요.'; }
function finite(value) { return typeof value === 'number' && Number.isFinite(value); }
function score(value) { return finite(value) ? value.toFixed(1).replace(/\.0$/, '') : '—'; }
function percent(value) { return finite(value) ? (value * 100).toFixed(1) + '%' : '—'; }
function busy() { return pendingStart || activeId !== null; }
function terminal(status) { return !['preparing', 'awaiting_input', 'researching', 'running', 'evaluating'].includes(status); }
function choiceLabel(choice) { return choice === 'YES' ? 'YES' : choice === 'NO' ? 'NO' : choice === 'CONDITIONAL' ? '조건부 권고' : choice === 'HOLD' ? '판단 보류' : '—'; }
function timeLabel(date) {
  const parsed = new Date(date);
  return Number.isNaN(parsed.valueOf()) ? '' : parsed.toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}
function toast(text) {
  clearTimeout(toastTimer);
  $('toast').textContent = text;
  $('toast').hidden = false;
  toastTimer = setTimeout(() => { $('toast').hidden = true; }, 4500);
}
function errorText(text) {
  $('question-error').textContent = text || '';
  $('question-error').hidden = !text;
}
function openDialog(id, opener = document.activeElement) {
  const dialog = $(id);
  if (!dialog || dialog.open) return;
  dialogOpeners.set(dialog, opener);
  dialog.showModal();
}
function updateRunActivity() {
  const starting = pendingStart && !activeId;
  const status = starting ? 'starting' : activeId ? viewed?.status : null;
  const running = ['starting', 'preparing', 'researching', 'running', 'evaluating'].includes(status);
  $('run-activity').hidden = !running;
  $('run-button').setAttribute('aria-busy', String(running));
  $('preparation-panel').setAttribute('aria-busy', String(status === 'preparing'));
  const label = running ? status === 'starting' ? '사전 검토 준비 중' : status === 'preparing' ? '사전 검토 중' : '판단 진행 중' : '사전 검토 시작';
  $('run-button').replaceChildren(element('span', '', label), icon('i-arrow'));
  if (!running) {
    clearInterval(activityTimer);
    activityTimer = null;
    activityStartedAt = null;
    return;
  }
  if (activityStartedAt === null) activityStartedAt = Date.now();
  const updateElapsed = () => {
    const seconds = Math.max(0, Math.floor((Date.now() - activityStartedAt) / 1000));
    $('activity-elapsed').textContent = '경과 ' + (seconds < 60 ? seconds + '초' : Math.floor(seconds / 60) + '분 ' + seconds % 60 + '초');
  };
  updateElapsed();
  if (activityTimer === null) activityTimer = setInterval(updateElapsed, 1000);
  const progress = starting ? null : viewed?.researchProgress;
  const count = Number.isInteger(progress?.completed) && Number.isInteger(progress?.total) && progress.total > 0
    ? progress.completed + '/' + progress.total : '';
  let title = '사전 검토를 준비하고 있습니다.';
  let detail = '사용 가능한 AI 연결을 확인하고 있습니다.';
  if (status === 'preparing') {
    const phase = progress?.phase;
    title = phase === 'consolidating-intake' ? '유사한 질문을 합치고 있습니다.'
      : phase === 'judging-preparation' ? 'JEV가 추가 질문과 자료 요청을 평가하고 있습니다.'
      : 'AI가 질문과 자료를 검토하고 있습니다.';
    detail = phase === 'planning' ? (count ? 'AI 사전 검토 응답 ' + count + ' 완료 · ' : '') + '남은 AI의 응답을 기다리고 있습니다.'
      : phase === 'consolidating-intake' ? (Number.isInteger(progress?.candidates) ? '추가 질문 후보 ' + progress.candidates + '개 · ' : '') + '중복을 정리하고 질문을 명확하게 다듬고 있습니다.'
      : phase === 'judging-preparation' ? '확인이 필요한 개인 조건과 공개 조사로 찾을 자료를 구분하고 있습니다.'
      : 'AI 응답을 기다리고 있습니다. 잠시 시간이 걸릴 수 있습니다.';
  } else if (status === 'researching') {
    title = { 'refining-queries': '답변을 반영해 검색 범위를 보완하고 있습니다.', researching: '뉴스·논문·공식 자료를 검색하고 있습니다.', 'verifying-sources': '원문과 출처를 확인하고 있습니다.' }[progress?.phase] || '판단에 필요한 자료를 조사하고 있습니다.';
    detail = (count ? '현재 단계 ' + count + ' 완료 · ' : '') + '확인한 근거를 모아 AI 토론에 전달합니다.';
  } else if (status === 'running') {
    title = 'AI가 수집한 근거를 바탕으로 토론하고 있습니다.';
    detail = (viewed?.opinions || []).filter(item => ['success', 'error', 'canceled'].includes(item.status)).length + '/3개 AI 처리 완료 · 상세 진행은 아래 토론 카드에서 확인할 수 있습니다.';
  } else if (status === 'evaluating') {
    title = { 'model-reviewing': '각 AI가 JEV 판정을 재검증하고 있습니다.', 'jev-refining': 'JEV가 보완된 의견을 재평가하고 있습니다.', synthesizing: '최종 실행안을 작성하고 있습니다.' }[viewed?.evaluationStage] || 'JEV가 AI 의견을 평가하고 있습니다.';
    detail = '검토가 완료되면 다음 단계로 진행합니다.';
  }
  // Keep elapsed ticks outside the live region so screen readers announce only real stage changes.
  if ($('activity-label').textContent !== title) $('activity-label').textContent = title;
  if ($('activity-detail').textContent !== detail) $('activity-detail').textContent = detail;
}
function setControls() {
  updateRunActivity();
  const isBusy = busy();
  $('run-button').disabled = !ready || isBusy || credentialsPending;
  $('cancel-run').hidden = !isBusy;
  $('cancel-run').disabled = pendingStart;
  $('question').readOnly = isBusy;
  $('new-question').disabled = isBusy;
  $('attach-files').disabled = !ready || isBusy || attachmentPending;
  if ($('continue-run')) $('continue-run').disabled = pendingContinue || attachmentPending || questionnairePending;
  document.querySelectorAll('.questionnaire-actions button').forEach((button) => { button.disabled = pendingContinue || attachmentPending || questionnairePending; });
  document.querySelectorAll('.preparation-files button').forEach((button) => { button.disabled = pendingContinue || attachmentPending || questionnairePending; });
  document.querySelectorAll('#attachment-list button').forEach((button) => { button.disabled = isBusy || attachmentPending; });
  document.querySelectorAll('[data-sample]').forEach((button) => { button.disabled = isBusy; });
  $('save-settings').disabled = !ready || isBusy;
  renderConnections();
  renderUpdateState();
}
function storeRecord(record) {
  const index = history.findIndex((entry) => entry.id === record.id);
  if (index >= 0) history[index] = record;
  else history.unshift(record);
  history = history.slice(0, 100);
  renderHistory();
}
function selectRecord(record) {
  if (busy()) { toast('현재 실행이 끝나거나 취소된 후 기록을 열 수 있습니다.'); return; }
  viewed = record;
  $('question').value = record.question;
  errorText('');
  renderRecord(record);
  $('history-dialog').close();
  $('decision-heading').scrollIntoView({ behavior: 'smooth', block: 'start' });
}
function renderHistory() {
  $('history-count').textContent = String(history.length);
  $('history-list').replaceChildren();
  $('archive-list').replaceChildren();
  if (!history.length) {
    $('history-list').append(element('p', 'empty-history', '아직 저장된 판단이 없어요.'));
    $('archive-list').append(element('p', 'dialog-intro', '첫 질문의 실행 결과가 여기에 저장됩니다.'));
    return;
  }
  for (const [index, record] of history.entries()) {
    if (index < 5) {
      const recent = element('button');
      recent.append(icon('i-file'), element('span', '', record.question));
      recent.title = record.question;
      recent.addEventListener('click', () => selectRecord(record));
      $('history-list').append(recent);
    }
    const archived = element('button', 'archive-item');
    const verdict = record.evaluation?.verdict;
    archived.append(element('strong', '', record.question), element('small', '', [timeLabel(record.createdAt), STATUS[record.status] || record.status, verdict ? choiceLabel(verdict.choice) : '평가 없음'].filter(Boolean).join(' · ')));
    archived.addEventListener('click', () => selectRecord(record));
    $('archive-list').append(archived);
  }
}
function renderEmpty() {
  viewed = null;
  $('results-content').hidden = true;
  $('preparation-panel').hidden = true;
  $('research-panel').hidden = true;
  $('record-attachments').hidden = true;
  $('empty-result').hidden = false;
  $('result-badge').textContent = '준비';
  $('run-status').textContent = bridge ? '질문을 입력해 주세요.' : '브라우저 미리보기';
  ['step-prepare', 'step-research', 'step-question', 'step-opinions', 'step-jev', 'step-refine', 'step-final'].forEach((id) => { $(id).className = 'process-step'; });
}
function debateProgress(debate) {
  const phase = { drafting: '초안 작성', reviewing: '상호 검토', synthesizing: '최종 종합', complete: '토론 완료', failed: '토론 중단', canceled: '토론 취소' }[debate.phase] || '토론 준비';
  const completed = Number.isInteger(debate.completedCalls) ? Math.max(0, Math.min(7, debate.completedCalls)) : 0;
  return '3인 토론 · ' + phase + ' · ' + completed + '/7 요청 완료';
}
function appendDebate(content, debate) {
  if (!debate || !Array.isArray(debate.agents)) return;
  const roleLabels = { opportunity: '기회 검토', risks: '위험 검토', feasibility: '실행 가능성 검토' };
  const agentLabel = (agent, index) => agent.label || roleLabels[agent.role] || '에이전트 ' + (index + 1);
  const transcriptText = (value) => {
    let text = String(value ?? '');
    for (const [index, agent] of debate.agents.entries()) {
      if (agent && typeof agent.id === 'string' && agent.id) text = text.split(agent.id).join(agentLabel(agent, index));
    }
    return text;
  };
  const section = element('section', 'debate-transcript');
  section.append(element('h3', '', '3개 에이전트의 토론 기록'), element('p', 'dialog-footnote', '각 에이전트가 작성한 초안과 서로의 의견을 검토한 답변입니다. JEV는 토론 후 종합한 최종 의견을 평가합니다.'), element('p', 'debate-progress', debateProgress(debate)));
  const appendResponse = (container, response, emptyText) => {
    if (!response) { container.append(element('p', 'debate-missing', emptyText)); return; }
    container.append(element('p', 'detail-meta', [response.stance ? choiceLabel(response.stance) : '', response.model].filter(Boolean).join(' · ')));
    if (response.title) container.append(element('p', 'debate-response-title', transcriptText(response.title)));
    container.append(element('p', 'debate-response-text', transcriptText(response.text || '응답 내용이 없습니다.')));
    if (response.point) container.append(element('p', 'detail-note', '핵심: ' + transcriptText(response.point)));
  };
  const statusLabels = { pending: '대기', running: '진행 중', drafting: '초안 작성', drafted: '초안 완료', reviewing: '상호 검토', reviewed: '상호 검토 완료', complete: '완료', success: '완료', failed: '실패', error: '실패', canceled: '취소' };
  for (const [index, agent] of debate.agents.entries()) {
    if (!agent || typeof agent !== 'object') continue;
    const detail = element('details', 'debate-agent');
    detail.append(element('summary', '', agentLabel(agent, index) + ' · ' + (statusLabels[agent.status] || '기록')));
    const draft = element('div', 'debate-round');
    draft.append(element('h4', '', '1차 초안'));
    appendResponse(draft, agent.draft, '완료된 초안이 없습니다.');
    const review = element('div', 'debate-round');
    review.append(element('h4', '', '2차 상호 검토'));
    appendResponse(review, agent.review, '완료된 상호 검토가 없습니다.');
    detail.append(draft, review);
    if (agent.error) detail.append(element('p', 'detail-note', '중단 사유: ' + transcriptText(agent.error)));
    section.append(detail);
  }
  const synthesis = element('details', 'debate-synthesis');
  synthesis.append(element('summary', '', '최종 종합 의견'));
  appendResponse(synthesis, debate.synthesis, '최종 종합이 완료되지 않아 이 AI는 평가에 사용되지 않습니다.');
  section.append(synthesis);
  content.append(section);
}
function renderOpinion(record, provider) {
  const opinion = record.opinions?.find((entry) => entry.providerId === provider.id) || { status: 'pending' };
  const evaluation = record.evaluation?.opinions?.find((entry) => entry.providerId === provider.id);
  const card = element('article', 'opinion-card');
  const head = element('div', 'model-header');
  const title = element('div', 'model-title');
  title.append(element('strong', '', provider.name), element('small', '', opinion.model || (opinion.status === 'success' ? '기본 모델 · 모델명 미반환' : provider.id === 'gemini' ? 'GEMINI API' : 'LOCAL CLI')));
  const states = { pending: '대기', running: '응답 중', success: choiceLabel(opinion.stance), error: '판단 제외', canceled: '취소' };
  const badge = element('span', 'opinion-badge' + (opinion.stance === 'HOLD' || opinion.stance === 'CONDITIONAL' || opinion.status === 'error' ? ' cautious' : ''), states[opinion.status] || '대기');
  head.append(element('span', 'model-icon ' + provider.css, provider.symbol), title, badge);
  const body = element('div', 'opinion-body');
  let bodyText = opinion.text || '';
  let heading = opinion.title || (opinion.status === 'running' ? '독립적으로 의견을 작성하고 있어요.' : '응답을 기다리고 있어요.');
  if (opinion.status === 'error') { heading = '이번 판단에서 제외되었습니다.'; bodyText = opinion.error || '응답을 사용할 수 없어 평가에서 제외했습니다.'; }
  if (opinion.status === 'canceled') { heading = '실행이 취소되었어요.'; bodyText = '완료되지 않은 응답은 평가하지 않습니다.'; }
  if (opinion.status === 'running' && opinion.debate) {
    heading = { drafting: '3개 에이전트가 각자의 초안을 작성하고 있어요.', reviewing: '서로의 초안을 읽고 의견을 검토하고 있어요.', synthesizing: '토론 결과를 하나의 최종 의견으로 종합하고 있어요.' }[opinion.debate.phase] || '3개 에이전트의 토론을 준비하고 있어요.';
  }
  body.append(element('h3', '', heading), element('p', 'opinion-preview', bodyText));
  if (opinion.debate) body.append(element('p', 'debate-progress', debateProgress(opinion.debate)));
  if (opinion.point) {
    const keypoint = element('div', 'opinion-keypoint');
    keypoint.append(icon('i-check'), element('span', '', opinion.point));
    body.append(keypoint);
  }
  const footer = element('div', 'model-footer');
  const quality = element('div', 'model-score');
  quality.append(element('span', '', '답변 품질'), element('strong', '', score(evaluation?.total)), element('small', '', '/ 100'));
  const details = element('button', 'detail-button', opinion.debate ? '토론 · 평가' : '원문 · 평가');
  details.append(icon('i-chevron'));
  details.disabled = opinion.status !== 'success' && opinion.status !== 'error' && !(opinion.status === 'canceled' && opinion.debate?.agents?.length);
  details.addEventListener('click', () => showDetail(record, provider, details));
  footer.append(quality, details);
  card.append(head, body, footer);
  return card;
}
function probabilityEntries(probabilities) {
  if (Array.isArray(probabilities)) return probabilities.map((value, index) => Array.isArray(value) ? value : [value?.choice || value?.label || String(index), typeof value === 'number' ? value : value?.probability]);
  return probabilities && typeof probabilities === 'object' ? Object.entries(probabilities) : [];
}
function renderSynthesis(record) {
  const synthesis = record.evaluation?.synthesis;
  const pending = record.status === 'evaluating' && record.evaluationStage === 'synthesizing';
  const complete = synthesis?.status === 'complete';
  const failed = synthesis?.status === 'error';
  $('synthesis-panel').hidden = !pending && !complete && !failed;
  $('synthesis-panel').classList.toggle('synthesis-error', failed);
  $('synthesis-title').textContent = complete ? synthesis.title : pending ? '최종 의견을 종합하고 있어요.' : failed ? '최종 의견을 종합하지 못했습니다.' : '';
  const reportBody = $('synthesis-text');
  reportBody.replaceChildren();
  const reportSections = complete && synthesis.report?.version === 1 && synthesis.report.sections;
  if (Array.isArray(reportSections) && reportSections.length === 6 && reportSections.every(section => typeof section.title === 'string' && typeof section.text === 'string')) {
    for (const section of reportSections) {
      const block = element('section', 'decision-report-section');
      block.append(element('h6', '', section.title));
      for (const paragraph of section.text.split(/\n\s*\n/u).filter(Boolean)) block.append(element('p', '', paragraph));
      reportBody.append(block);
    }
  } else reportBody.textContent = complete ? synthesis.text : pending ? 'JEV 평가를 반영해 최종 의견을 종합하고 있어요.' : failed ? (synthesis.error || '최종 종합 요청에 실패했습니다. 수집된 의견과 JEV 평가는 개별 AI 카드에서 확인할 수 있습니다.') : '';
  $('synthesis-point').textContent = complete && synthesis.point ? '지금 할 일: ' + synthesis.point : '';
  $('synthesis-point').hidden = !complete || !synthesis.point;
  const writer = PROVIDERS.find((provider) => provider.id === synthesis?.providerId);
  const sourceCount = Array.isArray(synthesis?.sourceProviderIds) ? new Set(synthesis.sourceProviderIds).size : 0;
  $('synthesis-meta').textContent = complete ? ['JEV 재평가에 근거한 종합 보고서', '작성 ' + (writer?.name || 'AI'), synthesis.model, sourceCount ? sourceCount + '개 AI 의견 반영' : ''].filter(Boolean).join(' · ') : pending ? '각 AI가 보완한 의견과 JEV 재평가를 바탕으로 실행 조건과 대안을 정리합니다.' : failed ? 'JEV 평가와 수집한 의견은 유지됩니다. 종합 답변을 대신 만들어 표시하지 않습니다.' : '';
}
function renderRefinement(record) {
  const refinement = record.evaluation?.refinement;
  const progress = Array.isArray(record.refinementProgress) ? record.refinementProgress : [];
  const reviews = refinement?.reviews || progress;
  const container = $('refinement-content');
  $('refinement-panel').hidden = !refinement && !reviews.length;
  container.replaceChildren();
  if (!refinement && !reviews.length) return;
  const providerName = (id) => PROVIDERS.find((provider) => provider.id === id)?.name || 'AI';
  const appendJudgment = (evaluation, heading) => {
    if (!evaluation) return;
    const section = element('section', 'refinement-judgment');
    section.append(element('h4', '', heading), element('p', 'detail-meta', ['판정 ' + choiceLabel(evaluation.verdict?.choice), evaluation.model ? '평가 모델 ' + evaluation.model : '', finite(evaluation.verdict?.confidence) ? 'confidence ' + percent(evaluation.verdict.confidence) : ''].filter(Boolean).join(' · ')));
    for (const opinion of evaluation.opinions || []) {
      const detail = element('div', 'refinement-score');
      detail.append(element('strong', '', providerName(opinion.providerId) + ' · 품질 ' + score(opinion.total) + ' / 100'));
      const dimensions = (opinion.dimensions || []).map((dimension) => dimension.name + ' ' + score(dimension.points) + ' / ' + dimension.weight);
      if (dimensions.length) detail.append(element('p', '', dimensions.join(' · ')));
      const feedback = evaluation.feedback?.find((item) => item.providerId === opinion.providerId);
      if (feedback) detail.append(element('p', 'refinement-focus', 'JEV 재검증 초점: ' + (feedback.label || feedback.focus)));
      section.append(detail);
    }
    section.append(element('p', 'dialog-footnote', '점수와 재검증 초점은 JEV의 Score·Choice 평가입니다. 초점 라벨은 선택된 평가 기준이며 JEV가 작성한 서술형 근거가 아닙니다.'));
    container.append(section);
  };
  appendJudgment(refinement?.initialEvaluation, '1. JEV 중간 판정');
  const section = element('section', 'refinement-reviews');
  section.append(element('h4', '', '2. 각 AI의 독립 재검증'));
  for (const review of reviews) {
    const detail = element('details', 'refinement-review');
    const state = { pending: '대기', running: '재검증 중', complete: '재검증 완료', error: '재검증 실패 · 제외', canceled: '취소' }[review.status] || '재검증 기록';
    detail.append(element('summary', '', providerName(review.providerId) + ' · ' + state));
    if (review.status === 'complete') {
      detail.append(element('p', 'detail-meta', [choiceLabel(review.stance), review.model].filter(Boolean).join(' · ')));
      if (review.title) detail.append(element('h5', 'refinement-review-title', review.title));
      detail.append(element('p', 'refinement-review-text', review.text || '재검증 본문이 없습니다.'));
      if (review.point) detail.append(element('p', 'detail-note', '보완 핵심: ' + review.point));
    } else if (review.error) detail.append(element('p', 'refinement-review-text', review.error));
    else detail.append(element('p', 'refinement-review-text', review.status === 'running' ? 'JEV의 중간 판정과 다른 AI의 의견을 검토하고 있습니다.' : '아직 완료된 재검증 답변이 없습니다.'));
    section.append(detail);
  }
  container.append(section);
  appendJudgment(refinement?.reviewedEvaluation, '3. JEV 재평가');
  if (refinement?.status === 'error') container.append(element('p', 'detail-note', '재검증을 완료하지 못해 최종 의견을 작성하지 않았습니다. 완료된 답변과 오류만 표시합니다.'));
}
function publicText(value) {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(publicText).filter(Boolean).join(' · ');
  return value && typeof value === 'object' ? value.description || value.summary || value.name || value.title || '' : '';
}
function fileLabel(file) {
  const size = Number.isFinite(file.size) ? (file.size < 1024 ? file.size + ' B' : Math.ceil(file.size / 1024) + ' KB') : '';
  return [file.name || '첨부 자료', size, Number.isFinite(file.chars) ? file.chars.toLocaleString('ko-KR') + '자 추출' : '', file.truncated ? '일부 내용만 반영' : ''].filter(Boolean).join(' · ');
}
function appendFileList(container, files, removable) {
  const list = element('ul', 'attachment-list');
  for (const file of files || []) {
    const item = element('li', 'attachment-item');
    const text = element('div');
    text.append(element('span', '', fileLabel(file)));
    if (file.warning) text.append(element('small', 'attachment-warning', file.warning));
    item.append(icon('i-file'), text);
    if (removable) {
      const remove = element('button', 'text-button attachment-remove', '×');
      remove.type = 'button';
      remove.setAttribute('aria-label', (file.name || '첨부 자료') + ' 제거');
      remove.disabled = attachmentPending || pendingContinue || questionnairePending;
      remove.addEventListener('click', () => {
        attachments = attachments.filter((entry) => entry.id !== file.id);
        renderAttachments();
        if (viewed?.status === 'awaiting_input') renderPreparation(viewed);
      });
      item.append(remove);
    }
    list.append(item);
  }
  container.append(list);
}
function renderAttachments() {
  $('attachment-list').replaceChildren();
  appendFileList($('attachment-list'), attachments, !busy());
  $('attachment-list').hidden = !attachments.length;
}
async function pickAttachments(forPreparation) {
  if (!bridge?.pickFiles || attachmentPending || pendingContinue || questionnairePending || (busy() && viewed?.status !== 'awaiting_input')) return;
  attachmentPending = true;
  setControls();
  try {
    const selected = await bridge.pickFiles();
    const files = Array.isArray(selected) ? selected : Array.isArray(selected?.files) ? selected.files : [];
    for (const file of files) if (file && typeof file.id === 'string' && !attachments.some((entry) => entry.id === file.id)) attachments.push(file);
    renderAttachments();
  } catch (error) { toast(message(error)); }
  finally {
    attachmentPending = false;
    setControls();
    if (forPreparation && viewed?.status === 'awaiting_input') renderPreparation(viewed);
  }
}
async function transferQuestionnaire(action) {
  if (!bridge || !activeId || viewed?.status !== 'awaiting_input' || pendingContinue || attachmentPending || questionnairePending) return;
  const runId = activeId;
  const operation = action === 'download' ? bridge.downloadQuestionnaire : bridge.uploadQuestionnaire;
  if (typeof operation !== 'function') { toast('최신 앱에서 질문지 파일을 사용할 수 있습니다.'); return; }
  questionnairePending = true;
  setControls();
  const status = $('questionnaire-status');
  if (status) status.textContent = '';
  try {
    const result = await operation({ runId, ...(action === 'download' ? { answers: { ...clarificationAnswers } } : {}) });
    if (result?.canceled) return;
    if (activeId !== runId || viewed?.id !== runId || viewed?.status !== 'awaiting_input') return;
    if (action === 'upload') {
      const values = result?.answers;
      const known = new Set((viewed.preparation?.questions || []).map(item => item.id));
      if (!values || typeof values !== 'object' || Array.isArray(values) || Object.entries(values).some(([id, answer]) => !known.has(id) || typeof answer !== 'string' || answer.length > 4000)) throw new Error('질문지 답변을 확인할 수 없습니다.');
      const filled = Object.fromEntries(Object.entries(values).filter(([, answer]) => answer.trim()));
      clarificationAnswers = { ...clarificationAnswers, ...filled };
      renderPreparation(viewed);
      const notice = $('questionnaire-status');
      if (notice) notice.textContent = Object.keys(filled).length ? Object.keys(filled).length + '개 답변을 반영했습니다. 내용을 확인한 뒤 자료 조사를 시작하세요.' : '새로 작성한 답변이 없습니다. 현재 입력은 유지했습니다.';
    } else {
      if (status?.isConnected) status.textContent = '질문지를 저장했습니다. 메모장에서 답변 구간을 작성한 뒤 업로드하세요.';
      toast('현재 입력한 답변을 포함해 질문지를 저장했습니다.');
    }
  } catch (error) {
    const notice = $('questionnaire-status');
    if (notice && viewed?.id === runId) notice.textContent = message(error);
    else toast(message(error));
  } finally {
    questionnairePending = false;
    setControls();
    if (action === 'upload' && viewed?.id === runId && viewed?.status === 'awaiting_input') $('upload-questionnaire')?.focus();
  }
}
async function continueRun() {
  if (!bridge?.continueRun || !activeId || viewed?.status !== 'awaiting_input' || pendingContinue || attachmentPending || questionnairePending) return;
  const questions = viewed.preparation?.questions || [];
  for (const item of questions) {
    if (item.required && !String(clarificationAnswers[item.id] || '').trim()) {
      const input = document.getElementById('clarification-' + item.id);
      $('clarification-error').textContent = '필수 질문에 답변해 주세요. 확인이 어렵다면 “모름”으로 적어 주세요.';
      $('clarification-error').hidden = false;
      input?.focus();
      return;
    }
  }
  pendingContinue = true;
  setControls();
  try {
    await bridge.continueRun({ runId: activeId, answers: { ...clarificationAnswers }, attachmentIds: attachments.map((file) => file.id) });
  } catch (error) {
    const notice = $('clarification-error');
    if (notice) { notice.textContent = message(error); notice.hidden = false; }
    else toast(message(error));
  } finally { pendingContinue = false; setControls(); }
}
function renderPreparation(record) {
  const panel = $('preparation-panel');
  const prep = record.preparation;
  panel.hidden = !prep && record.status !== 'preparing';
  panel.replaceChildren();
  if (panel.hidden) return;
  if (record.error) panel.append(element('p', 'form-error', record.error));
  const waiting = record.status === 'awaiting_input';
  if (waiting && clarificationRunId !== record.id) {
    clarificationRunId = record.id;
    clarificationAnswers = { ...(record.answers || {}) };
    attachments = Array.isArray(record.attachments) ? [...record.attachments] : [];
    renderAttachments();
  }
  panel.append(element('p', 'eyebrow', 'DECISION BRIEF'), element('h3', '', waiting ? '먼저 판단의 전제를 확인해 주세요.' : record.status === 'preparing' ? record.researchProgress?.phase === 'consolidating-intake' ? 'AI별 질문에서 중복을 합치고 문장을 정리하고 있어요.' : 'AI와 JEV가 질문의 명확성과 자료의 충분성을 검토하고 있어요.' : '사전 확인과 조사 계획'));
  panel.append(element('p', 'research-intro', waiting ? prep?.intakeReview?.policy === 'single-fact-essential-only' ? '판단 방향을 바꾸는 필수 정보만 한 항목에 하나씩 확인합니다. 공개 자료는 직접 조사하며, 가정을 명시해 진행할 수 있는 질문은 생략했습니다. 모르는 값은 “모름”으로 적어도 됩니다.' : '공개 자료는 이어지는 조사에서 찾습니다. 개인 상황이나 내부 자료처럼 외부에서 확인하기 어려운 내용에 답변해 주세요. 모르는 값은 “모름”으로 적어도 됩니다.' : '각 AI와 JEV가 질문과 자료를 먼저 검토합니다. 필요한 경우에만 추가 질문이나 자료를 요청하며, 추가 확인이 필요 없으면 공개 자료 조사를 바로 진행합니다.'));
  if (prep?.consolidation?.version === 1) {
    panel.append(element('p', 'detail-meta', '질문 정리 · AI 제안 ' + prep.consolidation.inputCount + (prep?.intakeReview?.policy === 'single-fact-essential-only' ? '개 → 단일 질문 ' : '개 → 통합 ') + prep.consolidation.outputCount + '개 · JEV가 선택한 추가 확인 ' + (prep.questions?.length || 0) + '개'));
  }
  if (Array.isArray(prep?.plans) && prep.plans.length) {
    const plans = element('details', 'research-details');
    plans.open = record.status === 'preparing';
    plans.append(element('summary', '', 'AI별 사전 검토와 JEV 평가'));
    for (const plan of prep.plans) {
      const row = element('div', 'preparation-plan');
      const name = PROVIDERS.find((provider) => provider.id === plan.providerId)?.name || plan.providerId || 'AI';
      row.append(element('strong', '', name + ' · ' + ({ pending: '대기', running: '검토 중', success: '검토 완료', complete: '검토 완료', error: '검토 실패 · 제외' }[plan.status] || plan.status || '검토 기록')));
      if (plan.summary || plan.error) row.append(element('p', '', publicText(plan.summary || plan.error)));
      plans.append(row);
    }
    if (prep.judgment) {
      const focus = { READY: '조사 계획 진행', OFFICIAL: '공식 원자료 보완', NEWS: '최근 뉴스 보완', PAPERS: '논문 근거 보완', COUNTER: '반대 근거 보완' }[prep.judgment.researchPlan?.choice];
      plans.append(element('p', 'detail-meta', ['JEV 사전 평가', prep.judgment.model, focus, prep.judgment.summary].filter(Boolean).join(' · ')));
    }
    panel.append(plans);
  }
  const questions = Array.isArray(prep?.questions) ? prep.questions : [];
  if (waiting) {
    const form = element('form', 'clarification-form');
    form.addEventListener('submit', (event) => { event.preventDefault(); continueRun(); });
    if (questions.length) {
      const actions = element('div', 'questionnaire-actions');
      for (const [action, id, label] of [['download', 'download-questionnaire', '질문지 다운로드'], ['upload', 'upload-questionnaire', '작성한 질문지 업로드']]) {
        const button = element('button', 'light-button', label);
        button.id = id;
        button.type = 'button';
        button.disabled = pendingContinue || attachmentPending || questionnairePending;
        button.prepend(icon('i-file'));
        button.addEventListener('click', () => transferQuestionnaire(action));
        actions.append(button);
      }
      const help = element('p', 'clarification-help', 'TXT 파일의 답변 구간을 메모장에서 작성한 뒤 업로드하세요. 일부만 작성해도 반영되며, 빈 답변은 현재 입력을 지우지 않습니다.');
      const status = element('p', 'clarification-help');
      status.id = 'questionnaire-status';
      status.setAttribute('role', 'status');
      status.setAttribute('aria-live', 'polite');
      form.append(actions, help, status);
    }
    if (!questions.length) form.append(element('p', 'preparation-ready', '추가 질문이 없습니다. 저장된 조사 계획을 이어서 진행할 수 있습니다.'));
    for (const [index, item] of questions.entries()) {
      const field = element('div', 'clarification-field');
      const label = element('label', '', (index + 1) + '. ' + item.question + (item.required ? ' (필수)' : ' (선택)'));
      const inputId = 'clarification-' + item.id;
      label.htmlFor = inputId;
      const input = element('textarea');
      input.id = inputId;
      input.rows = 2;
      input.maxLength = 4000;
      input.placeholder = '답변을 입력하세요. 확인하기 어렵다면 “모름”';
      input.value = clarificationAnswers[item.id] || '';
      input.addEventListener('input', () => { clarificationAnswers[item.id] = input.value; });
      input.setAttribute('aria-required', item.required ? 'true' : 'false');
      const help = element('p', 'clarification-help', [item.why ? '필요한 이유: ' + publicText(item.why) : '', item.material ? '도움이 되는 자료: ' + publicText(item.material) : ''].filter(Boolean).join('\n'));
      help.id = inputId + '-help';
      input.setAttribute('aria-describedby', help.id);
      field.append(label, help, input);
      form.append(field);
    }
    const files = element('div', 'preparation-files');
    const add = element('button', 'light-button', '자료 첨부');
    add.type = 'button';
    add.disabled = attachmentPending || pendingContinue || questionnairePending;
    add.prepend(icon('i-file'));
    add.addEventListener('click', () => pickAttachments(true));
    files.append(add, element('p', 'dialog-footnote', '첨부한 파일에서 추출한 내용은 참여 AI 서비스와 JEV로 전송됩니다. 긴 문서는 추출·문맥 제한에 따라 일부만 반영됩니다. 필요한 자료만 선택해 주세요.'));
    appendFileList(files, attachments, true);
    form.append(files);
    const error = element('p', 'form-error');
    error.id = 'clarification-error';
    error.hidden = true;
    error.setAttribute('role', 'alert');
    const submit = element('button', 'primary-button', '답변 반영 · 자료 조사 시작');
    submit.id = 'continue-run';
    submit.type = 'submit';
    submit.disabled = pendingContinue || attachmentPending || questionnairePending;
    submit.append(icon('i-arrow'));
    form.append(error, submit);
    panel.append(form);
  } else if (questions.length) {
    const details = element('details', 'research-details');
    details.append(element('summary', '', '확인한 사전 질문 ' + questions.length + '개'));
    for (const item of questions) {
      details.append(element('h4', '', item.question));
      const answer = record.answers?.[item.id] || record.clarificationAnswers?.[item.id];
      if (answer) details.append(element('p', '', answer));
      if (item.material) details.append(element('p', 'clarification-help', '도움이 되는 자료: ' + publicText(item.material)));
    }
    panel.append(details);
  }
  const searches = Array.isArray(prep?.searches) ? prep.searches : [];
  if (searches.length) {
    const details = element('details', 'research-details');
    details.open = waiting;
    details.append(element('summary', '', '예정된 공개 자료 조사 · ' + searches.length + '개 검색'));
    const list = element('ul', 'research-query-list');
    for (const search of searches) list.append(element('li', '', [search.query, search.purpose].filter(Boolean).join(' — ')));
    details.append(list);
    panel.append(details);
  }
}
function readableSourceExcerpt(excerpt) {
  const text = String(excerpt || '');
  if ((text.match(/\uFFFD/g) || []).length < 3) return text;
  const marker = '[조사 모델의 요약]';
  const position = text.lastIndexOf(marker);
  const summary = position >= 0 ? text.slice(position + marker.length).trim() : '';
  const readableSummary = summary && (summary.match(/\uFFFD/g) || []).length < 3;
  return '저장된 원문에 문자 인코딩 오류가 있어 본문을 표시하지 않습니다. 위 원문 링크에서 내용을 확인하세요.' +
    (readableSummary ? '\n' + marker + '\n' + summary : '');
}
function sourceSentences(value) {
  return [...new Intl.Segmenter('ko', { granularity: 'sentence' }).segment(value)]
    .map(part => part.segment.trim()).filter(Boolean);
}
function sourceParagraphs(value) {
  return String(value || '').trim().split(/\n+/).filter(Boolean).flatMap(block => {
    const paragraphs = [];
    let group = [];
    for (const sentence of sourceSentences(block)) {
      if (group.length >= 2 || (group.join(' ').length + sentence.length > 360 && group.length)) {
        paragraphs.push(group.join(' '));
        group = [];
      }
      group.push(sentence);
    }
    if (group.length) paragraphs.push(group.join(' '));
    return paragraphs;
  });
}
function researchSourceContent(source) {
  const raw = String(source.excerpt || '');
  const text = readableSourceExcerpt(raw).replace(/\r\n?/g, '\n');
  const encodingError = text !== raw.replace(/\r\n?/g, '\n');
  const marker = /(?:^|\n)\[조사 모델의 요약\](?:\n|$)/.exec(text);
  const before = marker ? text.slice(0, marker.index).trim() : text.trim();
  const summary = marker ? text.slice(marker.index + marker[0].length).trim() : '';
  const original = encodingError ? '' : before.replace(/^\[직접 수집한 원문 일부[^\]\n]*\]\s*/, '');
  const sentences = (summary || original).split(/\n+/).flatMap(sourceSentences);
  const highlights = sentences.slice(0, 3);
  // Keep a later caution visible rather than selecting only the opening benefits.
  const caution = sentences.slice(2).find(line => /다만|하지만|그러나|반면|위험|부담|주의|조건|한계|불확실/.test(line));
  if (caution && highlights.length === 3) highlights[2] = caution;
  const verification = typeof source.verification === 'string' ? source.verification : source.verification?.status;
  return {
    original, summary, highlights,
    warning: encodingError ? before : '',
    summaryOrigin: summary ? '저장된 조사 모델 요약에서 발췌' : ['retrieved', 'fetched', 'verified'].includes(verification) ? '수집한 원문에서 문장 발췌' : '저장된 검색 발췌',
    hasMoreSummary: Boolean(summary) && sentences.length > highlights.length,
  };
}
function renderResearch(record) {
  const panel = $('research-panel');
  const research = record.research;
  const openSources = new Set([...panel.querySelectorAll('.research-source-details[open]')].map(item => item.dataset.sourceKey));
  const openSummaries = new Set([...panel.querySelectorAll('.source-full-summary[open]')].map(item => item.closest('.research-source-details').dataset.sourceKey));
  const focused = document.activeElement;
  const focusedSource = panel.contains(focused) ? focused.closest('.research-source-details') : null;
  const focusKey = focusedSource?.dataset.sourceKey;
  const focusSelector = focused?.matches('.source-link') ? '.source-link' : focused?.closest('.source-full-summary') ? '.source-full-summary>summary' : '.source-row';
  panel.hidden = !research && record.status !== 'researching';
  panel.replaceChildren();
  if (panel.hidden) return;
  const sources = Array.isArray(research?.sources) ? research.sources : [];
  panel.append(element('p', 'eyebrow', 'REFERENCES'), element('h3', '', record.status === 'researching' ? '공개 자료를 검색하고 근거를 확인하고 있어요.' : '이번 판단에 사용한 조사 자료'));
  const progress = record.researchProgress;
  if (record.status === 'researching') {
    const stage = { planning: '검색 범위 정리', 'judging-preparation': 'JEV 사전 검토 평가', 'refining-queries': '답변을 반영한 검색 보완', researching: '뉴스·논문·공식 자료 검색', 'verifying-sources': '원문과 출처 확인', 'research-complete': '조사 완료', searching: '자료 검색', fetching: '원문 확인', reviewing: '근거 교차 검토', complete: '조사 완료' }[progress?.phase || progress?.stage] || '자료 검색과 원문 확인';
    const count = Number.isInteger(progress?.completed) && Number.isInteger(progress?.total) ? progress.completed + '/' + progress.total : '';
    panel.append(element('p', 'research-progress', [stage, count, progress?.message, progress?.query].filter((value) => typeof value === 'string' && value).join(' · ')));
  }
  if (research?.error) panel.append(element('p', 'form-error', research.error));
  const intro = element('div', 'research-list-intro');
  intro.append(element('p', 'research-intro', sources.length ? '자료 ' + sources.length + '개 · 목록을 누르면 핵심 요약과 원문 발췌를 볼 수 있습니다.' : record.status === 'researching' ? '아직 수집을 완료한 출처가 없습니다. 조사 결과를 받은 뒤 토론을 시작합니다.' : '수집된 출처가 없습니다.'));
  if (record.evaluation) {
    const jump = element('button', 'text-button research-jump', '결론으로 돌아가기 ↑');
    jump.type = 'button';
    jump.addEventListener('click', () => {
      const target = !$('synthesis-panel').hidden ? $('synthesis-title') : $('verdict-heading');
      target.setAttribute('tabindex', '-1');
      target.scrollIntoView({ block: 'start' });
      target.focus({ preventScroll: true });
    });
    intro.append(jump);
  }
  panel.append(intro);
  if (sources.length) {
    const header = element('div', 'source-table-header');
    header.setAttribute('aria-hidden', 'true');
    for (const label of ['제목', '일자', '출처', '']) header.append(element('span', '', label));
    panel.append(header);
  }
  const list = element('ol', 'research-source-list');
  for (const [index, source] of sources.entries()) {
    const item = element('li', 'research-source');
    const details = element('details', 'research-source-details');
    const key = String(record.id || '') + ':' + (source.id || source.url || index);
    details.dataset.sourceKey = key;
    details.name = 'research-source';
    details.open = openSources.has(key);
    const row = element('summary', 'source-row');
    const title = '[' + (source.id || 'S' + (index + 1)) + '] ' + (source.title || source.url || '제목 미기록');
    const titleCell = element('span', 'source-row-title', title);
    titleCell.title = title;
    const date = element('span', 'source-row-date', source.date || '일자 미기록');
    let publisher = source.publisher;
    if (!publisher) { try { publisher = new URL(source.url).hostname; } catch { publisher = '출처 미기록'; } }
    const publisherCell = element('span', 'source-row-publisher', publisher);
    publisherCell.title = publisher;
    const chevron = icon('i-chevron');
    chevron.classList.add('source-row-chevron');
    chevron.setAttribute('aria-hidden', 'true');
    row.append(titleCell, date, publisherCell, chevron);
    details.append(row);
    const body = element('div', 'source-detail');
    const content = researchSourceContent(source);
    const verification = typeof source.verification === 'string' ? source.verification : source.verification?.status;
    const verified = content.warning ? '저장 원문 문자 오류' : { retrieved: '원문 수집', fetched: '원문 수집', verified: '원문 수집', 'search-result': '검색 결과', search_result: '검색 결과', search: '검색 결과', unavailable: '원문 확인 불가', failed: '원문 확인 불가' }[verification] || '확인 상태 미기록';
    const meta = element('div', 'source-detail-meta');
    meta.append(element('span', 'source-status', verified), element('span', 'source-meta', [source.kind, source.date, publisher].filter(Boolean).join(' · ')));
    const link = element('button', 'source-link', '원문 보기 ↗');
    link.type = 'button';
    link.disabled = !bridge?.openSource || typeof source.url !== 'string' || !/^https?:\/\//i.test(source.url);
    link.addEventListener('click', async () => { try { await bridge.openSource(source.url); } catch (error) { toast(message(error)); } });
    meta.append(link);
    body.append(meta);
    if (content.warning) body.append(element('p', 'source-warning', content.warning));
    if (content.highlights.length) {
      body.append(element('h4', 'source-section-title', content.summary ? '핵심 요약' : '핵심 발췌'), element('p', 'source-summary-origin', content.summaryOrigin));
      const highlights = element('ul', 'source-highlights');
      for (const line of content.highlights) highlights.append(element('li', '', line));
      body.append(highlights);
    } else body.append(element('p', 'source-meta', '저장된 요약과 원문 발췌가 없습니다. 원문 링크에서 내용을 확인하세요.'));
    if (content.hasMoreSummary) {
      const full = element('details', 'source-full-summary');
      full.open = openSummaries.has(key);
      full.append(element('summary', '', '조사 요약 전체 보기'));
      for (const paragraph of sourceParagraphs(content.summary)) full.append(element('p', 'source-excerpt', paragraph));
      body.append(full);
    }
    if (content.original) {
      body.append(element('h4', 'source-section-title', ['retrieved', 'fetched', 'verified'].includes(verification) ? '수집한 원문 발췌' : '저장된 검색 발췌'));
      const original = element('div', 'source-original');
      for (const paragraph of sourceParagraphs(content.original)) original.append(element('p', 'source-excerpt', paragraph));
      body.append(original);
      body.append(element('p', 'source-summary-origin', '발췌문을 읽기 쉽게 문장 단위로 나눴습니다. 기사 전체와 문맥은 원문에서 확인하세요.'));
    }
    details.append(body);
    item.append(details);
    list.append(item);
  }
  panel.append(list);
  if (focusKey) [...list.querySelectorAll('.research-source-details')].find(item => item.dataset.sourceKey === focusKey)?.querySelector(focusSelector)?.focus({ preventScroll: true });
  if (research?.coverage) {
    const coverage = research.coverage;
    panel.append(element('p', 'source-meta', ['실제 검색어 ' + coverage.actualQueries + '개', '독립 출처 도메인 ' + coverage.independentDomains + '개', coverage.missingKinds?.length ? '보완이 필요한 근거: ' + coverage.missingKinds.join(', ') : '계획한 근거 종류 확인'].join(' · ')));
  }
  if (Array.isArray(research?.gaps) && research.gaps.length) {
    const gaps = element('details', 'research-details');
    gaps.append(element('summary', '', '조사에서 확인하지 못한 항목 ' + research.gaps.length + '개'));
    const items = element('ul');
    for (const gap of research.gaps) items.append(element('li', '', publicText(gap)));
    gaps.append(items);
    panel.append(gaps);
  }
  const queries = Array.isArray(research?.queries) ? research.queries : [];
  if (queries.length) {
    const details = element('details', 'research-details');
    details.append(element('summary', '', '실제 검색 기록 ' + queries.length + '개'));
    const items = element('ul', 'research-query-list');
    for (const query of queries) items.append(element('li', '', typeof query === 'string' ? query : [query.query, query.status, query.error].filter(Boolean).join(' · ')));
    details.append(items);
    panel.append(details);
  }
  if (Array.isArray(research?.reports) && research.reports.length) {
    const details = element('details', 'research-details');
    details.append(element('summary', '', '조사 보고서와 교차 검토'));
    for (const report of research.reports) {
      details.append(element('h4', '', report.title || report.providerId || '조사 보고서'), element('p', 'research-report', report.text || report.summary || report.error || ''));
      for (const markup of [report.provenance?.searchEntryPoint, report.followup?.provenance?.searchEntryPoint].filter(value => typeof value === 'string' && value)) {
        const suggestions = element('iframe', 'google-search-suggestions');
        suggestions.title = 'Google Search 검색 제안';
        suggestions.setAttribute('sandbox', 'allow-popups allow-popups-to-escape-sandbox');
        suggestions.setAttribute('referrerpolicy', 'no-referrer');
        suggestions.srcdoc = '<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'; img-src https://www.google.com https://www.gstatic.com data:; base-uri \'none\'; form-action \'none\'"><base target="_blank"></head><body>' + markup + '</body></html>';
        details.append(suggestions);
      }
    }
    panel.append(details);
  }
}



function renderRecord(record) {
  viewed = record;
  const evaluation = record.evaluation;
  const verdict = evaluation?.verdict;
  const opinions = record.opinions || [];
  const successful = opinions.filter((entry) => entry.status === 'success').length;
  const isTerminal = terminal(record.status);
  const beforeDebate = ['preparing', 'awaiting_input', 'researching'].includes(record.status) || (!opinions.length && Boolean(record.preparation));
  renderPreparation(record);
  renderResearch(record);
  $('record-attachments').replaceChildren();
  $('record-attachments').hidden = !record.attachments?.length;
  if (record.attachments?.length) {
    $('record-attachments').append(element('summary', '', '이 판단에 첨부한 자료 · ' + record.attachments.length + '개'));
    appendFileList($('record-attachments'), record.attachments, false);
  }
  $('results-content').hidden = beforeDebate;
  $('empty-result').hidden = true;
  $('result-badge').textContent = STATUS[record.status] || record.status;
  const stageLabels = { 'model-reviewing': '각 AI가 JEV 판정을 재검증하고 있어요.', 'jev-refining': 'JEV가 보완된 의견을 재평가하고 있어요.', synthesizing: '최종 실행안을 작성하고 있어요.' };
  $('run-status').textContent = [record.status === 'evaluating' ? stageLabels[record.evaluationStage] || 'JEV 중간 판정 중' : STATUS[record.status] || record.status, beforeDebate ? '' : successful + '/3개 응답', timeLabel(record.createdAt)].filter(Boolean).join(' · ');
  const currentStep = record.status === 'running' ? 0 : record.evaluationStage === 'model-reviewing' ? 2 : record.evaluationStage === 'jev-refining' ? 3 : record.evaluationStage === 'synthesizing' ? 4 : 1;
  const completedSteps = [successful > 0 && record.status !== 'running', Boolean(evaluation || (!isTerminal && currentStep > 1)), Boolean(evaluation?.refinement?.reviews?.some((review) => review.status === 'complete') || (!isTerminal && currentStep > 2)), Boolean(evaluation?.refinement?.reviewedEvaluation || (!isTerminal && currentStep > 3)), evaluation?.synthesis?.status === 'complete'];
  ['step-question', 'step-opinions', 'step-jev', 'step-refine', 'step-final'].forEach((id, index) => {
    $(id).className = 'process-step' + (!isTerminal && index === currentStep ? ' running' : completedSteps[index] ? ' complete' : '');
  });
  $('step-prepare').className = 'process-step' + (['preparing', 'awaiting_input'].includes(record.status) ? ' running' : record.preparation ? ' complete' : '');
  $('step-research').className = 'process-step' + (record.status === 'researching' ? ' running' : record.research ? ' complete' : '');
  if (beforeDebate) ['step-question', 'step-opinions', 'step-jev', 'step-refine', 'step-final'].forEach((id) => { $(id).className = 'process-step'; });
  $('opinion-grid').replaceChildren(...(beforeDebate ? [] : PROVIDERS.map((provider) => renderOpinion(record, provider))));
  $('verdict-heading').textContent = evaluation?.refinement?.reviewedEvaluation ? 'JEV 재평가와 최종 실행안' : record.status === 'evaluating' ? 'JEV 판정과 AI 재검증' : 'JEV 평가와 최종 의견';
  $('verdict-label').textContent = verdict ? choiceLabel(verdict.choice) : '—';
  $('verdict-label').className = 'verdict-word' + (verdict?.choice === 'NO' ? ' verdict-no' : verdict?.choice === 'HOLD' || verdict?.choice === 'CONDITIONAL' ? ' verdict-hold' : '');
  $('verdict-title').textContent = verdict ? verdict.choice === 'YES' ? '질문의 실행을 권고합니다.' : verdict.choice === 'NO' ? '질문의 실행을 권고하지 않습니다.' : verdict.choice === 'CONDITIONAL' ? '조건을 충족하는 실행안을 권고합니다.' : '추가 확인 후 결정하세요.' : record.status === 'evaluating' ? '답변 품질과 판단을 평가하고 있어요.' : isTerminal ? '최종 판단이 없습니다.' : '세 AI의 답변을 기다리고 있어요.';
  let description = '';
  if (verdict) {
    const reasons = [];
    if (verdict.reasonCode === 'INCOMPLETE_OPINIONS') reasons.push('이전 정책으로 저장된 결과입니다. 당시 응답 누락으로 판단이 보류되었습니다.');
    else if (successful < PROVIDERS.length) reasons.push('사용할 수 없는 AI를 제외하고 ' + successful + '개 답변으로 평가했습니다.');
    if (verdict.gateApplied && finite(verdict.confidenceThreshold) && finite(verdict.confidence) && verdict.confidence < verdict.confidenceThreshold) reasons.push('이전 정책으로 저장된 결과입니다. 당시 confidence 기준 ' + verdict.confidenceThreshold + '에 미달하여 판단을 보류했습니다.');
    if (verdict.gateApplied && !reasons.length) reasons.push('앱의 보류 기준이 적용되었습니다.');
    if (verdict.gateApplied && verdict.rawChoice) reasons.push('JEV 원래 판정: ' + choiceLabel(verdict.rawChoice) + '.');
    if (!reasons.length) reasons.push('원래 질문과 수집한 의견에 대한 JEV의 별도 Choice 평가입니다.');
    reasons.push('판정 confidence ' + percent(verdict.confidence) + ' · 정확도나 성공 확률을 의미하지 않습니다.');
    description = reasons.join(' ');
  } else if (record.error) description = record.error;
  else if (record.status === 'canceled') description = '실행을 취소했습니다. 수집된 답변이 있으면 원문을 확인할 수 있습니다.';
  else description = record.status === 'evaluating' && stageLabels[record.evaluationStage] ? stageLabels[record.evaluationStage] : '각 AI의 의견을 JEV가 중간 판정한 뒤, 모든 응답 AI가 재검증합니다.';
  $('verdict-description').textContent = description;
  $('verdict-probabilities').replaceChildren();
  if (verdict) {
    $('verdict-probabilities').append(element('span', 'distribution-label', 'JEV 판정 분포'));
    for (const [name, value] of probabilityEntries(verdict.probabilities)) {
      if (finite(value)) $('verdict-probabilities').append(element('span', 'distribution-item', choiceLabel(name) + ' ' + percent(value)));
    }
  }
  $('overall-score').textContent = score(evaluation?.qualityAverage);
  $('score-bar').value = finite(evaluation?.qualityAverage) ? evaluation.qualityAverage : 0;
  $('copy-result').disabled = !bridge || !isTerminal;
  $('save-state').textContent = record.saveError ? '기록 저장 실패 · 현재 화면에서 확인하세요' : isTerminal ? '이 기기에 저장된 실행 기록' : '진행 중';
  $('save-state').classList.toggle('save-error', Boolean(record.saveError));
  $('common-ground').textContent = successful + '개 의견 수집 · ' + (evaluation?.opinions?.length || 0) + '개 답변 품질 평가' + (evaluation ? ' · 평가 모델 ' + evaluation.model : '') + (record.error ? ' · ' + record.error : '') + (record.saveError ? ' · 기록 저장 실패: ' + record.saveError : '');
  $('next-check').textContent = evaluation?.refinement ? '품질은 최초 수집 답변의 점수입니다. 최종 의견은 각 AI의 재검증과 JEV 재평가를 반영한 실행안입니다. 공개 근거의 출처와 수집 상태는 조사 자료에서 확인하세요. 조건부 권고는 필요한 가정과 조건을 명시합니다. confidence는 판정 분포의 집중도입니다.' : evaluation ? '이 기록은 저장 당시의 평가와 종합 의견입니다. 재검증 과정이 저장되지 않은 과거 기록에 새 과정을 만들어 붙이지 않습니다. confidence는 판정 분포의 집중도이며 정답 확률이 아닙니다.' : '응답 오류는 연결 설정에서 확인하세요. 평가가 완료되지 않은 점수와 판단은 표시하지 않습니다.';
  renderSynthesis(record);
  renderRefinement(record);
}
function showDetail(record, provider, opener) {
  const opinion = record.opinions?.find((entry) => entry.providerId === provider.id);
  const evaluation = record.evaluation?.opinions?.find((entry) => entry.providerId === provider.id);
  $('detail-title').textContent = provider.name + '의 의견과 품질 평가';
  const content = $('detail-content');
  content.replaceChildren();
  if (!opinion) return;
  content.append(element('p', 'detail-meta', [opinion.model, finite(opinion.elapsedMs) ? (opinion.elapsedMs / 1000).toFixed(1) + '초' : '', opinion.stance ? choiceLabel(opinion.stance) : ''].filter(Boolean).join(' · ')));
  content.append(element('h3', 'detail-opinion-title', opinion.title || '응답 상태'));
  content.append(element('p', 'detail-summary opinion-full', opinion.text || opinion.error || '응답이 없습니다.'));
  if (opinion.point) content.append(element('p', 'detail-note', 'AI가 제시한 핵심: ' + opinion.point));
  appendDebate(content, opinion.debate);
  if (!evaluation) {
    content.append(element('p', 'dialog-footnote', '이 답변에 대한 JEV 품질 평가가 없습니다.'));
  } else {
    const total = element('div', 'detail-total', 'JEV 답변 품질');
    total.append(element('strong', '', score(evaluation.total) + ' / 100'));
    content.append(total);
    content.append(element('p', 'dialog-footnote', '평가 모델 ' + record.evaluation.model + ' · 각 항목: 원점수 ÷ 최대 원점수 × 배점. 아래 단계 설명은 평가 기준이며 JEV가 생성한 서술형 판단 근거가 아닙니다.'));
    for (const dimension of evaluation.dimensions || []) {
      const detail = element('details', 'dimension-detail');
      const summary = element('summary', '', dimension.name + '  ' + score(dimension.points) + ' / ' + dimension.weight + '점');
      detail.append(summary, element('p', '', '원점수 ' + score(dimension.rawScore) + ' / ' + dimension.maxScore + ' · confidence ' + percent(dimension.confidence)));
      const legend = dimension.legend;
      if (Array.isArray(legend)) {
        const list = element('ol', 'legend-list');
        list.start = 0;
        for (const level of legend) list.append(element('li', '', typeof level === 'string' ? level : level.description || level.label || JSON.stringify(level)));
        detail.append(list);
      } else if (legend && typeof legend === 'object') {
        const list = element('ul', 'legend-list');
        for (const [level, text] of Object.entries(legend)) list.append(element('li', '', level + ' — ' + String(text)));
        detail.append(list);
      } else if (typeof legend === 'string') detail.append(element('p', '', legend));
      content.append(detail);
    }
  }
  openDialog('detail-dialog', opener);
}
function connectionState(id) { return id === 'jev' ? connections.jev : connections.providers?.find((entry) => entry.id === id); }
function connectionUsable(id, state = connectionState(id)) {
  if (!state) return false;
  return id === 'jev' ? state.connected === true : state.installed !== false && state.authenticated === true;
}
function connectionLabel(id) {
  const state = connectionState(id);
  if (checkingConnections.has(id)) return '확인 중…';
  if (!state) return '확인 전';
  if (connectionUsable(id, state)) return '사용 가능';
  if (id === 'gemini' || id === 'jev') return state.configured === false ? 'API 키 필요' : '연결 실패';
  return !state.installed ? '설치 필요' : '로그인 필요';
}
function connectionSteps(item, state) {
  if (item.kind === 'cli') return [['CLI 설치', !!state?.installed], ['터미널에서 로그인', state?.authenticated === true], ['사용 가능', connectionUsable(item.id, state)]];
  return [['API 키 입력', state?.configured === true], ['모델 선택', !!(item.id === 'jev' ? settings.model : geminiModel)], ['사용 가능 확인', connectionUsable(item.id, state)]];
}
function buildConnectionCards() {
  for (const item of CONNECTIONS) {
    const card = element('article', 'connection-card');
    const row = element('div', 'connection-row');
    const info = element('div', 'connection-info');
    const ref = { status: element('span', 'connection-state'), message: element('p', ''), steps: element('ol', 'connection-steps'), check: element('button', 'light-button', '다시 확인') };
    info.append(element('strong', '', item.title), ref.message);
    row.append(element('span', 'model-icon ' + item.icon, item.symbol), info, ref.status);
    card.append(row, ref.steps);
    const actions = element('div', 'connection-actions');
    if (item.kind === 'cli') {
      ref.setup = element('button', 'primary-button', 'CLI 설치하기');
      ref.setup.type = 'button';
      ref.setup.addEventListener('click', () => setupCli(item.id));
      actions.append(ref.setup);
    } else {
      const fields = element('div', 'connection-fields');
      const keyField = element('div', 'settings-field');
      const keyLabel = element('label', '', 'API 키');
      ref.key = element('input');
      Object.assign(ref.key, { id: item.id + '-api-key', type: 'password', maxLength: 4096, autocomplete: 'new-password', spellcheck: false, placeholder: '새 키 입력 (비우면 유지)' });
      ref.key.setAttribute('autocapitalize', 'off');
      keyLabel.htmlFor = ref.key.id;
      keyField.append(keyLabel, ref.key);
      const modelField = element('div', 'settings-field');
      const modelLabel = element('label', '', '모델');
      ref.model = element('select');
      ref.model.id = item.id + '-model';
      modelLabel.htmlFor = ref.model.id;
      ref.model.addEventListener('change', () => selectModel(item.id, ref.model.value));
      modelField.append(modelLabel, ref.model);
      fields.append(keyField, modelField);
      card.append(fields);
      ref.save = element('button', 'primary-button', '저장하고 확인');
      ref.save.type = 'button';
      ref.save.addEventListener('click', () => saveAndCheck(item.id));
      actions.append(ref.save);
    }
    ref.check.type = 'button';
    ref.check.addEventListener('click', () => checkConnection(item.id));
    actions.append(ref.check);
    card.append(actions);
    connectionCards[item.id] = ref;
    $('connection-cards').append(card);
  }
}
function renderConnections() {
  $('cli-list').replaceChildren();
  for (const provider of PROVIDERS) {
    const sidebar = element('div');
    sidebar.append(element('span', 'tiny-logo ' + provider.color, provider.symbol), document.createTextNode(provider.name), element('span', 'connection-state' + (connectionUsable(provider.id) ? ' is-ok' : connectionState(provider.id) ? ' is-warn' : ''), connectionLabel(provider.id)));
    $('cli-list').append(sidebar);
  }
  const locked = !ready || busy() || credentialsPending;
  for (const item of CONNECTIONS) {
    const ref = connectionCards[item.id];
    if (!ref) continue;
    const state = connectionState(item.id);
    const checking = checkingConnections.has(item.id);
    const usable = connectionUsable(item.id, state);
    ref.status.textContent = connectionLabel(item.id);
    ref.status.className = 'connection-state' + (usable ? ' is-ok' : state ? ' is-warn' : '');
    ref.message.textContent = [state?.version, state?.message].filter(Boolean).join(' · ') || '상태를 확인하고 있습니다.';
    ref.steps.replaceChildren(...connectionSteps(item, state).map(([label, done]) => element('li', done ? 'is-done' : '', label)));
    ref.check.disabled = locked || checking;
    if (item.kind === 'cli') {
      ref.setup.hidden = !state || usable;
      ref.setup.textContent = state && !state.installed ? 'CLI 설치하기' : '터미널에서 로그인';
      ref.setup.disabled = locked || checking;
    } else {
      const current = item.id === 'jev' ? settings.model : geminiModel;
      const models = [...new Set([current, ...(state?.models || [])].filter((entry) => typeof entry === 'string' && entry))];
      if (ref.model.dataset.options !== models.join('\n')) {
        ref.model.replaceChildren(...models.map((model) => { const option = element('option', '', model); option.value = model; return option; }));
        ref.model.dataset.options = models.join('\n');
      }
      ref.model.value = current;
      ref.key.disabled = locked;
      ref.model.disabled = locked || checking;
      ref.save.disabled = locked || checking;
    }
  }
}
async function checkConnection(id) {
  if (!bridge || checkingConnections.has(id)) return;
  checkingConnections.add(id);
  renderConnections();
  try {
    const result = await bridge.checkConnections(id);
    connections = id === 'jev' ? { ...connections, jev: result.jev } : { ...connections, providers: [...(connections.providers || []).filter((entry) => entry.id !== id), ...result.providers.filter((entry) => entry.id === id)] };
    if (connectionUsable(id)) terminalOpened.delete(id);
  } catch (error) { $('connection-message').textContent = message(error); }
  finally { checkingConnections.delete(id); renderConnections(); }
}
function checkAllConnections() { return Promise.all(CONNECTIONS.map((item) => checkConnection(item.id))); }
async function setupCli(id) {
  if (!bridge || busy()) return;
  const installed = !!connectionState(id)?.installed;
  const ref = connectionCards[id];
  ref.setup.disabled = true;
  try {
    await bridge.login(id);
    terminalOpened.add(id);
    const notice = installed
      ? '터미널을 열었습니다. 로그인을 마치고 이 창으로 돌아오면 자동으로 다시 확인합니다.'
      : '터미널에서 CLI 설치와 로그인을 차례로 진행합니다. 끝나고 이 창으로 돌아오면 자동으로 다시 확인합니다.';
    $('connection-message').textContent = notice;
    toast(notice);
  } catch (error) {
    $('connection-message').textContent = message(error);
    toast(message(error));
  } finally { renderConnections(); }
}
function clearApiKeyInputs() {
  for (const item of CONNECTIONS) if (connectionCards[item.id]?.key) connectionCards[item.id].key.value = '';
}
async function saveAndCheck(id) {
  if (!bridge || busy() || credentialsPending) return;
  const ref = connectionCards[id];
  if (ref.key.value.trim()) {
    credentialsPending = true;
    $('connection-message').textContent = 'API 키를 암호화하여 저장하고 있습니다.';
    setControls();
    try {
      await bridge.saveApiKeys({ [id]: ref.key.value });
      ref.key.value = '';
      $('connection-message').textContent = 'API 키를 이 PC에 암호화하여 저장했습니다. 사용 가능한지 확인합니다.';
    } catch {
      // Do not echo an IPC/provider error that could contain a just-entered key.
      $('connection-message').textContent = 'API 키를 저장하지 못했습니다. 입력 형식과 Windows 암호화 저장 상태를 확인해 주세요.';
      return;
    } finally {
      credentialsPending = false;
      setControls();
    }
  }
  await checkConnection(id);
}
function settingsPayload(patch = {}) {
  const next = { model: settings.model, timeoutMs: settings.timeoutMs, ...(geminiModel ? { geminiModel } : {}), ...patch };
  return next;
}
async function selectModel(id, value) {
  if (!bridge || busy()) return;
  try {
    settings = await bridge.saveSettings(settingsPayload(id === 'jev' ? { model: value } : { geminiModel: value }));
    if (id === 'gemini') geminiModel = value;
  } catch (error) {
    $('connection-message').textContent = message(error);
    renderConnections();
    return;
  }
  await checkConnection(id);
}
function renderUpdateState() {
  const state = updateState;
  const versions = [state.currentVersion ? '현재 ' + state.currentVersion : '', state.availableVersion ? '새 버전 ' + state.availableVersion : ''].filter(Boolean).join(' · ');
  const fallback = { disabled: '이 실행에서는 자동 업데이트를 사용할 수 없습니다.', checking: '새 릴리즈를 확인하고 있습니다.', available: '새 버전을 확인했습니다. 다운로드를 준비합니다.', downloading: '새 버전을 다운로드하고 있습니다.', downloaded: '다운로드가 완료되었습니다. 판단 진행 중에는 설치하지 않습니다.', current: '최신 버전을 사용하고 있습니다.', error: '업데이트를 확인하지 못했습니다. 잠시 후 다시 시도해 주세요.' };
  $('update-status').textContent = [versions, typeof state.message === 'string' && state.message ? state.message : fallback[state.status] || fallback.disabled].filter(Boolean).join('\n');
  const progress = $('update-progress');
  progress.hidden = state.status !== 'downloading';
  progress.value = finite(state.progress) ? Math.max(0, Math.min(100, state.progress)) : 0;
  $('check-updates').disabled = !ready || updatePending || ['disabled', 'checking', 'downloading'].includes(state.status) || typeof bridge?.checkForUpdates !== 'function';
  $('install-update').hidden = state.status !== 'downloaded';
  $('install-update').disabled = !ready || busy() || credentialsPending || updatePending || typeof bridge?.installUpdate !== 'function';
}
async function checkForUpdates() {
  if (updatePending || typeof bridge?.checkForUpdates !== 'function') return;
  updatePending = true;
  renderUpdateState();
  try { updateState = await bridge.checkForUpdates(); }
  catch { updateState = { ...updateState, status: 'error', message: '업데이트를 확인하지 못했습니다. 잠시 후 다시 시도해 주세요.' }; }
  finally { updatePending = false; renderUpdateState(); }
}
async function installUpdate() {
  if (busy() || updatePending || credentialsPending || typeof bridge?.installUpdate !== 'function') return;
  updatePending = true;
  renderUpdateState();
  try { await bridge.installUpdate(); }
  catch { updateState = { ...updateState, message: '업데이트 설치를 시작하지 못했습니다. 진행 중인 판단이 끝난 뒤 다시 시도해 주세요.' }; }
  finally { updatePending = false; renderUpdateState(); }
}
async function startRun() {
  if (!bridge || !ready || busy()) return;
  const question = $('question').value.trim();
  if (!question) { errorText('판단할 질문을 입력해 주세요.'); $('question').focus(); return; }
  if (question.length > 4000) { errorText('질문은 4,000자 이내로 입력해 주세요.'); return; }
  errorText('');
  pendingStart = true;
  setControls();
  try {
    const result = await bridge.startRun({ question, attachmentIds: attachments.map((file) => file.id) });
    // An initial event may arrive before the invocation resolves.
    if (pendingStart) {
      activeId = result.runId;
      if (viewed?.id !== activeId) renderRecord({ id: activeId, question, createdAt: new Date().toISOString(), status: 'preparing', attachments: [...attachments], opinions: [] });
    }
  } catch (error) { errorText(message(error)); activeId = null; }
  finally { pendingStart = false; setControls(); }
}
async function cancelRun() {
  if (!bridge || !activeId) return;
  $('cancel-run').disabled = true;
  try {
    const result = await bridge.cancelRun();
    if (result.canceled) toast('취소 요청을 전달했습니다. 실행 종료를 기다리고 있어요.');
    else toast('이미 실행이 끝났습니다.');
  } catch (error) { errorText(message(error)); }
  finally { $('cancel-run').disabled = false; }
}
function newQuestion() {
  if (busy()) return;
  $('question').value = '';
  attachments = [];
  clarificationAnswers = {};
  clarificationRunId = null;
  renderAttachments();
  errorText('');
  renderEmpty();
  $('question').focus();
}
document.querySelectorAll('[data-open]').forEach((button) => button.addEventListener('click', () => openDialog(button.dataset.open, button)));
document.querySelectorAll('[data-close]').forEach((button) => button.addEventListener('click', () => button.closest('dialog').close()));
document.querySelectorAll('dialog').forEach((dialog) => {
  dialog.addEventListener('close', () => { if (dialog.id === 'connection-dialog') clearApiKeyInputs(); const opener = dialogOpeners.get(dialog); if (opener?.isConnected) opener.focus(); });
  dialog.addEventListener('click', (event) => { if (event.target === dialog) { const box = dialog.getBoundingClientRect(); if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) dialog.close(); } });
});
$('nav-history').addEventListener('click', (event) => openDialog('history-dialog', event.currentTarget));
$('nav-room').addEventListener('click', () => $('question').focus());
$('new-question').addEventListener('click', newQuestion);
$('run-button').addEventListener('click', startRun);
$('attach-files').addEventListener('click', () => pickAttachments(false));
$('cancel-run').addEventListener('click', cancelRun);
window.addEventListener('focus', () => { for (const id of terminalOpened) checkConnection(id); });
$('check-updates').addEventListener('click', checkForUpdates);
$('install-update').addEventListener('click', installUpdate);
document.querySelectorAll('[data-sample]').forEach((button) => button.addEventListener('click', () => { if (!busy()) { $('question').value = SAMPLES[button.dataset.sample]; errorText(''); $('question').focus(); } }));
document.addEventListener('keydown', (event) => {
  if (document.querySelector('dialog[open]')) return;
  if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') { event.preventDefault(); if (viewed?.status === 'awaiting_input') continueRun(); else startRun(); }
  if (event.altKey && event.key.toLowerCase() === 'n') { event.preventDefault(); newQuestion(); }
});
$('settings-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!bridge || busy()) return;
  $('save-settings').disabled = true;
  try {
    settings = await bridge.saveSettings(settingsPayload({ timeoutMs: Number($('cli-timeout').value) }));
    $('connection-message').textContent = '설정을 이 기기에 저장했습니다.';
    toast('평가 설정을 저장했습니다.');
  } catch (error) { $('connection-message').textContent = message(error); }
  finally { setControls(); }
});
$('copy-result').addEventListener('click', async () => {
  if (!bridge || !viewed || !terminal(viewed.status)) return;
  try { await bridge.copyResult(viewed.id); toast('질문, 답변, 품질 점수와 최종 판단을 복사했습니다.'); }
  catch (error) { toast(message(error)); }
});
async function initialize() {
  buildConnectionCards();
  renderHistory();
  renderConnections();
  renderEmpty();
  renderAttachments();
  if (!bridge) {
    $('environment-label').textContent = '브라우저 미리보기';
    $('environment-notice').hidden = false;
    $('environment-notice').textContent = 'HTML 미리보기입니다. 실제 CLI 실행과 평가는 Electron 앱에서 사용할 수 있습니다. 예시 답변이나 점수는 표시하지 않습니다.';
    $('connection-message').textContent = 'Electron 앱에서 연결을 확인할 수 있습니다.';
    setControls();
    return;
  }
  bridge.onRunEvent((event) => {
    if (!event?.record || !event.runId) return;
    if (activeId && activeId !== event.runId) return;
    const record = event.record;
    activeId = terminal(record.status) ? null : event.runId;
    if (terminal(record.status)) pendingStart = false;
    renderRecord(record);
    if (terminal(record.status) && !record.saveError) storeRecord(record);
    setControls();
  });
  try {
    const state = await bridge.getState();
    if (typeof state.appTitle === 'string') document.title = state.appTitle;
    if (state.buildInfo?.buildVersion && /^\d{4}(?:\.\d{2}){5}$/.test(state.buildInfo.buildVersion)) {
      $('build-version').textContent = 'ver. ' + state.buildInfo.buildVersion;
      $('build-version').hidden = false;
    }
    history = Array.isArray(state.history) ? state.history : [];
    connections = state.connections || connections;
    settings = state.settings || settings;
    geminiModel = typeof state.geminiModel === 'string' ? state.geminiModel : geminiModel;
    $('cli-timeout').value = String(settings.timeoutMs);
    if (state.warning) {
      $('environment-notice').hidden = false;
      $('environment-notice').textContent = state.warning;
    }
    ready = true;
    $('environment-label').textContent = 'LOCAL CLI + JEV';
    renderHistory();
    renderConnections();
    if (state.activeRun) {
      activeId = terminal(state.activeRun.status) ? null : state.activeRun.id;
      $('question').value = state.activeRun.question;
      renderRecord(state.activeRun);
    }
    if (typeof bridge.onUpdateEvent === 'function') bridge.onUpdateEvent((state) => { if (state && typeof state.status === 'string') { updateState = state; renderUpdateState(); } });
    if (typeof bridge.getUpdateState === 'function') {
      try { updateState = await bridge.getUpdateState(); } catch { updateState = { status: 'error', message: '업데이트 상태를 확인하지 못했습니다.' }; }
    }
    setControls();
    checkAllConnections();
    // JEV is required to run a judgment, so a missing key means first-run setup.
    if (state.needsSetup) openDialog('connection-dialog', $('question'));
  } catch (error) {
    $('environment-label').textContent = '앱 초기화 오류';
    $('environment-notice').hidden = false;
    $('environment-notice').textContent = message(error);
    setControls();
  }
}
initialize();
