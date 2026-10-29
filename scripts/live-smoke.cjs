'use strict';
// Explicit development smoke: official subscription CLIs plus one real Jev evaluation.
// Never print credentials or raw service error bodies.
const fs = require('node:fs/promises');
const path = require('node:path');
const { parseEnv } = require('node:util');
const cli = require('../services/cli.cjs');
const { createDebateOpinion } = require('../services/debate.cjs');
const getDebatedOpinion = createDebateOpinion({ getOpinion:cli.getOpinion });
const jev = require('../services/jev.cjs');
const gemini = require('../services/gemini.cjs');
const { createSynthesizedEvaluation } = require('../services/synthesis.cjs');
const root = path.resolve(__dirname,'..');
(async () => {
  const config = parseEnv(await fs.readFile(path.join(root,'.env'),'utf8'));
  const key = config.JEV_API_KEY?.trim();
  if (!key) throw new Error('JEV_API_KEY missing');
  const connections = { providers:[...await cli.inspectAll({ cwd:root, providerIds:['claude','codex'] }), await gemini.inspectConnection({ apiKey:config.GEMINI_API_KEY, model:config.GEMINI_MODEL || gemini.DEFAULT_MODEL })], jev:await jev.inspectConnection({ apiKey:key }) };
  console.log(JSON.stringify(connections,null,2));
  if (!connections.jev.connected) throw new Error('Jev connection unavailable');
  const question = '개인 일정 관리를 위해 매일 아침 10분 동안 오늘 할 일 세 가지를 먼저 정해 보는 것이 좋을까요?';
  const opinions = await Promise.all(cli.PROVIDERS.map(async p => {
    try { return p.id === 'gemini' ? await gemini.getOpinion(question,{ apiKey:config.GEMINI_API_KEY,model:config.GEMINI_MODEL || gemini.DEFAULT_MODEL,timeoutMs:180000 }) : await getDebatedOpinion(p.id,question,{ cwd:root,timeoutMs:180000 }); }
    catch (error) { return { providerId:p.id,name:p.name,status:'error',error:error.message,code:error.code }; }
  }));
  console.log(JSON.stringify(opinions.map(o=>({ providerId:o.providerId,status:o.status,model:o.model,code:o.code,error:o.error })),null,2));
  const successful = opinions.filter(o=>o.status === 'success');
  if (!successful.length) throw new Error('No real opinions collected');
  await fs.writeFile(path.join(root,'.omx','reviews','live-opinions.json'),JSON.stringify({question,opinions,connections},null,2));
  const evaluateAndSynthesize = createSynthesizedEvaluation({ evaluate:jev.evaluate, getOpinion:(id, q, options) => id === 'gemini' ? gemini.getOpinion(q, { ...options, apiKey:config.GEMINI_API_KEY, model:config.GEMINI_MODEL || gemini.DEFAULT_MODEL }) : cli.getOpinion(id,q,options) });
  const evaluation = await evaluateAndSynthesize({ question,opinions:successful,apiKey:key,cwd:root,timeoutMs:180000,model:config.JEV_MODEL || 'jev-latest',fetchImpl:async (url,options) => {
    const response = await fetch(url,options);
    if (response.ok) await fs.writeFile(path.join(root,'.omx','reviews','jev-live-response.json'),JSON.stringify(await response.clone().json(),null,2));
    return response;
  } });
  const result = { source:'live',createdAt:new Date().toISOString(),question,connections,opinions,evaluation };
  await fs.mkdir(path.join(root,'.omx','reviews'),{recursive:true});
  await fs.writeFile(path.join(root,'.omx','reviews','live-smoke.json'),JSON.stringify(result,null,2));
  console.log(JSON.stringify({ providerSuccess:successful.length,model:evaluation.model,qualityAverage:evaluation.qualityAverage,verdict:evaluation.verdict,synthesis:evaluation.synthesis },null,2));
})().catch(error=>{console.error(error.code || 'SMOKE_FAILED',error.message);process.exitCode=1;});
