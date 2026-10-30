'use strict';
const { app, BrowserWindow, ipcMain, Menu, clipboard, safeStorage, session, shell, dialog } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { parseEnv } = require('node:util');
const { openLoginTerminal } = require('./services/login.cjs');
const { createStore } = require('./services/store.cjs');
const { createDecisionService } = require('./services/decision.cjs');
const cli = require('./services/cli.cjs');
const { createDebateOpinion } = require('./services/debate.cjs');
const getDebatedOpinion = createDebateOpinion({ getOpinion:cli.getOpinion });
const jev = require('./services/jev.cjs');
const gemini = require('./services/gemini.cjs');
const { createSynthesizedEvaluation } = require('./services/synthesis.cjs');
const evaluateAndSynthesize = createSynthesizedEvaluation({ evaluate:jev.evaluate, getOpinion:(id, question, options) => id === 'gemini' ? gemini.getOpinion(question, { ...options, apiKey:geminiKey, model:geminiModel }) : cli.getOpinion(id, question, options) });
const { loadSecret, saveSecret } = require('./services/credentials.cjs');
const { createUpdateService } = require('./services/updates.cjs');
const { existsSync } = require('node:fs');
const { createAttachmentService } = require('./services/attachments.cjs');
const { createQuestionnaireFiles } = require('./services/questionnaire-files.cjs');
const { readBuildInfo } = require('./services/build-version.cjs');
const buildInfo = readBuildInfo(__dirname);
const appTitle = 'YES or NO — JEV Decision Room · ' + (buildInfo ? 'ver. ' + buildInfo.buildVersion : '개발 모드');
const { createResearchService } = require('./services/research.cjs');
const researchAdapters = require('./services/research-adapters.cjs');
const { verifySources, publicUrl } = require('./services/evidence.cjs');
const attachments = createAttachmentService({ chooseFiles: async () => {
  const result = await dialog.showOpenDialog(window, { title: '판단에 참고할 자료 선택', properties: ['openFile','multiSelections'],
    filters: [{ name: '분석할 문서', extensions: ['txt','md','csv','json','html','htm','xml','tsv','log','pdf','docx','xlsx'] }] });
  return result.canceled ? [] : result.filePaths;
} });
const researchService = createResearchService({
  providers: () => cli.PROVIDERS.filter(provider => provider.id !== 'gemini' || !!geminiKey),
  getStructured: (id, prompt, schema, options) => id === 'gemini'
    ? researchAdapters.getGeminiStructured(prompt, schema, { ...options, apiKey: geminiKey, model: geminiModel })
    : researchAdapters.getCliStructured(id, prompt, schema, options),
  judgePreparation: jev.judgePreparation, verifySources,
});
async function openSource(url) {
  if (typeof url !== 'string' || url.length > 4096) throw new Error('출처 주소를 확인해 주세요.');
  const checked = publicUrl(url);
  await shell.openExternal(checked.href);
  return true;
}

app.setName('YES or NO');
if (process.platform === 'win32') app.setAppUserModelId('ai.typesafe.yesornot');
app.setPath('userData', path.join(app.getPath('appData'), 'YESorNOT'));
const userData = app.getPath('userData');
const store = createStore(userData);
let lastCompletedRecord = null;
let window, service, apiKey = '', keyMessage = '', geminiKey = '', geminiKeyMessage = '', geminiModel = gemini.DEFAULT_MODEL, connections = { providers:[], jev:{ configured:false, connected:false, models:[], message:'연결 확인 전' } }, connectionPromise;
const updates = createUpdateService({
  enabled: process.platform === 'win32' && app.isPackaged && existsSync(path.join(process.resourcesPath, 'app-update.yml')),
  currentVersion: app.getVersion(),
  getUpdater: () => require('electron-updater').autoUpdater,
  isBusy: () => !!service?.active(),
  onChange: state => { if (window && !window.isDestroyed()) window.webContents.send('decision:update', state); },
});
const questionnaireFiles = createQuestionnaireFiles({
  getActive: () => service?.active(),
  chooseSaveFile: async name => {
    const result = await dialog.showSaveDialog(window, { title: '사전 질문지 다운로드', defaultPath: path.join(app.getPath('downloads'), name),
      filters: [{ name: '답변 작성용 질문지', extensions: ['txt'] }], properties: ['showOverwriteConfirmation', 'createDirectory'] });
    return result.canceled ? null : result.filePath;
  },
  chooseOpenFile: async () => {
    const result = await dialog.showOpenDialog(window, { title: '작성한 사전 질문지 업로드', properties: ['openFile'],
      filters: [{ name: '작성한 질문지', extensions: ['txt'] }] });
    return result.canceled ? null : result.filePaths[0];
  },
});
const indexURL = pathToFileURL(path.join(__dirname, 'index.html')).href;
const startup = app.requestSingleInstanceLock();
if (!startup) app.quit();
app.on('second-instance', () => { if (window) { if (window.isMinimized()) window.restore(); window.focus(); } });

async function loadKey() {
  // run.bat supplies this explicit source .env location; portable use keeps EXE-adjacent config.
  const configFile = process.env.YESORNOT_ENV_FILE;
  delete process.env.YESORNOT_ENV_FILE;
  const candidates = [configFile && path.isAbsolute(configFile) ? configFile : null, app.isPackaged ? path.join(path.dirname(process.execPath), '.env') : path.join(__dirname, '.env')].filter(Boolean);
  let config = {};
  for (const candidate of candidates) {
    try { config = parseEnv(await fs.readFile(candidate, 'utf8')); break; } catch (error) { if (error.code !== 'ENOENT') keyMessage = '.env 파일을 읽지 못했습니다.'; }
  }
  const evaluatorSecret = await loadSecret({ config, keyName:'JEV_API_KEY', fileName:'jev-key.bin', userData, safeStorage });
  apiKey = evaluatorSecret.key;
  keyMessage = [keyMessage, evaluatorSecret.message].filter(Boolean).join(' ');
  const geminiSecret = await loadSecret({ config, keyName:'GEMINI_API_KEY', fileName:'gemini-key.bin', userData, safeStorage });
  geminiKey = geminiSecret.key;
  geminiKeyMessage = geminiSecret.message;
  geminiModel = store.snapshot().settings.geminiModel || config.GEMINI_MODEL?.trim() || process.env.GEMINI_MODEL?.trim() || gemini.DEFAULT_MODEL;
  delete process.env.GEMINI_MODEL;
  if (config.JEV_MODEL && store.snapshot().settings.model === 'jev-latest' && /^jev-[a-zA-Z0-9._-]{1,64}$/.test(config.JEV_MODEL)) {
    await store.saveSettings({ ...store.snapshot().settings, model:config.JEV_MODEL });
  }
}
async function saveApiKeys(payload) {
  if (service?.active()) throw new Error('진행 중인 판단이 끝난 뒤 API 키를 변경하세요.');
  if (!payload || typeof payload !== 'object' || Array.isArray(payload) || Object.keys(payload).some(name => !['jev','gemini'].includes(name))) throw new Error('API 키 입력을 확인하세요.');
  const entries = Object.entries(payload);
  if (!entries.length || entries.some(([, value]) => typeof value !== 'string' || !value.trim() || value.trim().length > 4096 || /[^\x21-\x7e]/u.test(value.trim()) || /[\r\n]/u.test(value))) throw new Error('API 키에 공백이나 잘못된 문자가 포함되어 있습니다.');
  if (connectionPromise) await connectionPromise.catch(() => {});
  for (const [id, value] of entries) {
    await saveSecret({ key:value.trim(), fileName:id === 'jev' ? 'jev-key.bin' : 'gemini-key.bin', userData, safeStorage });
    if (id === 'jev') { apiKey = value.trim(); keyMessage = ''; }
    else { geminiKey = value.trim(); geminiKeyMessage = ''; }
  }
  return { configured: { jev:!!apiKey, gemini:!!geminiKey } };
}
const CONNECTION_IDS = ['claude','codex','gemini','jev'];
const pendingChecks = new Set();
async function inspectConnection(id) {
  if (id === 'gemini') {
    const state = await gemini.inspectConnection({ apiKey:geminiKey, model:geminiModel });
    return { ...state, message:[state.message,geminiKeyMessage].filter(Boolean).join(' ') };
  }
  if (id === 'jev') {
    const state = await jev.inspectConnection({ apiKey });
    return { ...state, message:[state.message,keyMessage].filter(Boolean).join(' ') };
  }
  const [state] = await cli.inspectAll({ cwd:path.join(userData, 'cli-workspace'), providerIds:[id] });
  return state;
}
// Each card is checked on its own; the result replaces only that card's entry.
async function checkConnections(id) {
  if (id !== undefined && !CONNECTION_IDS.includes(id)) throw new Error('지원하지 않는 연결입니다.');
  const check = Promise.all((id === undefined ? CONNECTION_IDS : [id]).map(async name => {
    const state = await inspectConnection(name);
    connections = name === 'jev' ? { ...connections, jev:state } : { ...connections, providers:[...connections.providers.filter(entry => entry.id !== name), state] };
  }));
  pendingChecks.add(check);
  connectionPromise = Promise.all([...pendingChecks]);
  try { await check; return connections; }
  finally { pendingChecks.delete(check); connectionPromise = pendingChecks.size ? Promise.all([...pendingChecks]) : null; }
}
function safeError(error) {
  let message = typeof error?.message === 'string' ? error.message.slice(0,800) : '요청 처리에 실패했습니다.';
  for (const key of [apiKey, geminiKey]) if (key) message = message.split(key).join('[비공개]');
  return message.replace(/Bearer\s+\S+/gi, 'Bearer [비공개]');
}
function handle(channel, handler) {
  ipcMain.handle(channel, async (event, payload) => {
    if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame || event.senderFrame.url !== indexURL) return { ok:false,error:'허용되지 않은 요청입니다.' };
    try { return { ok:true,value:await handler(payload) }; } catch (error) { return { ok:false,error:safeError(error) }; }
  });
}
async function login(id) {
  if (!['claude','codex'].includes(id)) throw new Error('Claude·ChatGPT만 CLI 로그인을 사용합니다. Gemini는 연결 설정에서 API 키를 입력해 연결합니다.');
  if (service.active()) throw new Error('진행 중인 판단이 끝난 후 로그인하세요.');
  return openLoginTerminal(id, { cwd:path.join(userData,'cli-workspace'), scriptPath:path.join(__dirname,'scripts','login.ps1') });
}
function formatResult(record) {
  const lines = [record.question, '', `실행: ${record.createdAt}`, `상태: ${record.status}`];
  if (record.preparation) {
    lines.push('', '사전 검토와 사용자 답변');
    for (const item of record.preparation.questions || []) lines.push(`${item.required ? '[필수]' : '[선택]'} ${item.question}`, record.answers?.[item.id] || '(답변 없음)');
  }
  if (record.attachments?.length) {
    lines.push('', '첨부 자료');
    for (const file of record.attachments) lines.push(`${file.name}${file.truncated ? ' (일부 추출)' : ''}${file.warning ? ': ' + file.warning : ''}`);
  }
  if (record.research) {
    lines.push('', `공개 자료 조사: ${record.research.status}`, '검색 결과 확인과 원문 수집은 사실의 진실성·전문 전체 검토를 보장하지 않습니다.');
    for (const item of record.research.queries || []) lines.push(`검색: ${typeof item === 'string' ? item : item.query}`);
    for (const source of record.research.sources || []) lines.push(`[${source.id}] ${source.title} | ${source.publisher || ''} | ${source.date || '발행일 미확인'} | ${source.verification}`, source.url, source.excerpt || '');
    for (const gap of record.research.gaps || []) lines.push(`조사 한계: ${gap}`);
  }
  for (const opinion of record.opinions) {
    const score = record.evaluation?.opinions.find(o => o.providerId === opinion.providerId);
    lines.push('', `${opinion.name} | ${opinion.model || ''} | ${opinion.stance || opinion.status} | 답변 품질 ${score ? score.total.toFixed(1) : '미평가'}/100`, opinion.title || '', opinion.text || opinion.error || '', opinion.point || '');
    if (opinion.debate) {
      lines.push(`  내부 토론: ${opinion.debate.agentCount}개 에이전트 · ${opinion.debate.completedCalls}/${opinion.debate.totalCalls}회 완료 · ${opinion.debate.status}`);
      for (const agent of opinion.debate.agents || []) {
        lines.push(`  [${agent.label}]`);
        for (const [label, entry] of [['독립 의견',agent.draft],['상호 검토',agent.review]]) {
          if (!entry) continue;
          const readable = text => (opinion.debate.agents || []).reduce((value,item) => value.split(item.id).join(item.label), String(text || ''));
          lines.push(`  ${label}: ${entry.stance} · ${entry.title}`, readable(entry.text), readable(entry.point));
        }
        if (agent.error) lines.push(`  토론 중단: ${agent.error}`);
      }
    }
    for (const dimension of score?.dimensions || []) lines.push(`  ${dimension.name}: ${dimension.points.toFixed(2)}/${dimension.weight} (원점수 ${dimension.rawScore}/${dimension.maxScore})`);
  }
  if (record.evaluation) {
    const { verdict, synthesis, refinement } = record.evaluation;
    const providerName = id => cli.PROVIDERS.find(provider => provider.id === id)?.name || id;
    if (refinement) {
      lines.push('', '판정 · 재검증 과정', `JEV 중간 판정: ${refinement.initialEvaluation?.verdict?.choice || '없음'}`);
      for (const feedback of refinement.initialEvaluation?.feedback || []) {
        lines.push(`  ${providerName(feedback.providerId)} 보완 영역: ${feedback.label}`);
      }
      for (const review of refinement.reviews || []) {
        lines.push('', `${providerName(review.providerId)} 재검증: ${review.status} · ${review.stance || ''}`,
          review.title, review.text || review.error, review.point);
      }
      lines.push('', `JEV 재평가: ${refinement.reviewedEvaluation?.verdict?.choice || '완료되지 않음'}`,
        '재검증은 모델의 공개 근거 검토이며 외부 사실 확인을 보장하지 않습니다.');
    }
    if (synthesis?.status === 'complete') {
      const writer = cli.PROVIDERS.find(provider => provider.id === synthesis.providerId)?.name || synthesis.providerId;
      lines.push('', 'JEV 평가를 반영한 종합 의견', synthesis.title, synthesis.text, synthesis.point,
        `문장 작성: ${writer} | ${synthesis.model || '기본 모델'} | 반영한 의견: ${synthesis.sourceProviderIds.length}개`);
    } else if (synthesis?.status === 'error') lines.push('', `종합 의견 생성 실패: ${synthesis.error}`);
    lines.push('', `JEV 최종 판정: ${verdict.choice}`, `원 판정: ${verdict.rawChoice || verdict.choice}`, `보류 사유: ${verdict.reasonCode || '없음'}`, `분포 집중도: ${verdict.confidence}`, `판정 분포: ${JSON.stringify(verdict.probabilities)}`, `평가 모델: ${record.evaluation.model}`, `답변 품질 평균: ${record.evaluation.qualityAverage}/100`, '품질 점수와 분포 집중도는 정답 확률이 아닙니다.');
  }
  if (record.error) lines.push('', record.error);
  return lines.filter(line => line !== undefined).join('\n');
}
function createWindow() {
  window = new BrowserWindow({ width:1440,height:1040,minWidth:760,minHeight:640,backgroundColor:'#fafbf7', title:appTitle, icon:path.join(__dirname,'assets','app-icon.ico'), webPreferences:{ preload:path.join(__dirname,'preload.cjs'), nodeIntegration:false, contextIsolation:true, sandbox:true, webSecurity:true, spellcheck:false } });
  window.on('page-title-updated', event => { event.preventDefault(); window.setTitle(appTitle); });
  window.webContents.setWindowOpenHandler(({ url }) => {
    // Grounding suggestion links are user-clicked links inside a scriptless sandbox.
    openSource(url).catch(() => {});
    return { action: 'deny' };
  });
  window.webContents.on('will-navigate', event => event.preventDefault());
  window.webContents.on('will-attach-webview', event => event.preventDefault());
  window.loadFile(path.join(__dirname,'index.html'));
  window.on('closed', () => { window = null; });
  Menu.setApplicationMenu(Menu.buildFromTemplate([{ label:'파일',submenu:[{ role:'quit',label:'종료' }] },{ label:'편집',submenu:[{ role:'undo' },{ role:'redo' },{ type:'separator' },{ role:'cut' },{ role:'copy' },{ role:'paste' },{ role:'selectAll' }] },{ label:'보기',submenu:[{ role:'resetZoom' },{ role:'zoomIn' },{ role:'zoomOut' },{ role:'togglefullscreen' }] }]));
}
if (startup) app.whenReady().then(async () => {
  await store.load();
  await fs.mkdir(path.join(userData,'cli-workspace'), { recursive:true });
  await loadKey();
  if (process.platform === 'win32' && app.isPackaged) {
    const programs = path.join(app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs');
    await fs.mkdir(programs, { recursive:true });
    await fs.rm(path.join(programs, 'YESORNOT.lnk'), { force:true });
    shell.writeShortcutLink(path.join(programs, 'YES or NO.lnk'), 'create', {
      target:process.execPath, cwd:path.dirname(process.execPath), description:'YES or NO - AI 의견과 JEV 판단',
      icon:process.execPath, iconIndex:0, appUserModelId:'ai.typesafe.yesornot'
    });
  }
  session.defaultSession.setPermissionRequestHandler((_contents,_permission,callback) => callback(false));
  session.defaultSession.setPermissionCheckHandler(() => false);
  session.defaultSession.webRequest.onBeforeRequest((details,callback) => callback({ cancel:!details.url.startsWith(pathToFileURL(__dirname + path.sep).href) && !details.url.startsWith('devtools:') }));
  service = createDecisionService({ providers:cli.PROVIDERS, getOpinion:(id, question, options) => id === 'gemini' ? gemini.getOpinion(question, { ...options, apiKey:geminiKey, model:geminiModel }) : getDebatedOpinion(id, question, options), evaluate:evaluateAndSynthesize, researchService, store, getApiKey:() => apiKey, cwd:path.join(userData,'cli-workspace'), onEvent:event => {
    if (event.type === 'complete') lastCompletedRecord = structuredClone(event.record);
    if (window && !window.isDestroyed()) window.webContents.send('decision:event', event);
  } });
  const savedIntake = store.snapshot().history.find(record => record.status === 'awaiting_input' && record.preparation);
  if (savedIntake) {
    try {
      attachments.remember(savedIntake.intakeDocuments || []);
      service.restore(savedIntake, store.snapshot().settings);
    } catch { /* Keep an invalid historical checkpoint readable without resuming it. */ }
  }
  handle('decision:state', () => ({ ...store.snapshot(), connections, geminiModel, needsSetup:!apiKey, activeRun:service.active(), buildInfo, appTitle, update:updates.snapshot() }));
  handle('decision:connections', checkConnections);
  handle('decision:api-keys', saveApiKeys);
  handle('decision:update-state', () => updates.snapshot());
  handle('decision:update-check', () => updates.check());
  handle('decision:update-install', () => updates.install());
  handle('decision:start', payload => {
    if (!payload || typeof payload !== 'object') throw new Error('질문을 입력하세요.');
    if (!apiKey) throw new Error('JEV API 키가 없습니다. 연결 설정에서 키를 입력하세요.');
    return service.start({ question:payload.question, attachments:attachments.resolve(payload.attachmentIds || []) }, store.snapshot().settings);
  });
  handle('decision:continue', payload => {
    if (!payload || typeof payload !== 'object') throw new Error('사전 답변을 입력해 주세요.');
    return service.continue({ runId: payload.runId, answers: payload.answers, attachments: attachments.resolve(payload.attachmentIds || []) });
  });
  handle('decision:attachments', () => {
    const active = service.active();
    if (active && active.status !== 'awaiting_input') throw new Error('사전 질문에 답변할 때 자료를 추가할 수 있습니다.');
    return attachments.pick();
  });
  handle('decision:questionnaire-download', payload => questionnaireFiles.download(payload));
  handle('decision:questionnaire-upload', payload => questionnaireFiles.upload(payload));
  handle('decision:source', openSource);
  handle('decision:cancel', () => service.cancel());
  handle('decision:settings', async payload => {
    await store.saveSettings(payload);
    geminiModel = store.snapshot().settings.geminiModel || geminiModel;
    return store.snapshot().settings;
  });
  handle('decision:login', login);
  handle('decision:copy', id => {
    const record = store.snapshot().history.find(r => r.id === id) || (lastCompletedRecord?.id === id ? lastCompletedRecord : null);
    if (!record) throw new Error('복사할 기록을 찾지 못했습니다.');
    clipboard.writeText(formatResult(record)); return true;
  });
  createWindow();
  updates.start();
}).catch(() => { process.stderr.write('앱 초기화에 실패했습니다. 설치 파일과 사용자 데이터 경로를 확인하세요.\n'); app.quit(); });
let quitAllowed = false;
let quitting = null;
app.on('before-quit', event => {
  if (quitAllowed || !service?.active() || service.active().status === 'awaiting_input') return;
  event.preventDefault();
  if (!quitting) quitting = service.cancel().finally(() => { quitAllowed = true; app.quit(); });
});
app.on('will-quit', () => updates.dispose());
app.on('window-all-closed', () => app.quit());
app.on('activate', () => { if (!BrowserWindow.getAllWindows().length && service) createWindow(); });
