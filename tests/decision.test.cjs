'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createDecisionService } = require('../services/decision.cjs');
const providers = [{id:'claude',name:'Claude'},{id:'codex',name:'ChatGPT'},{id:'gemini',name:'Gemini'}];
const defaults = { model:'jev-latest',timeoutMs:180000 };
function setup(overrides = {}) {
  const records = [], events = [];
  const service = createDecisionService({providers,
    getOpinion:async id=>({providerId:id,status:'success',stance:'YES',text:'검증 의견'}),
    evaluate:async()=>({verdict:{choice:'NO',confidence:.9},qualityAverage:95}),
    store:{saveRecord:async record=>records.push(structuredClone(record))},
    getApiKey:()=> 'test-private',onEvent:event=>events.push(event),...overrides});
  return {service,records,events};
}
test('debate progress persists and only successful final provider opinions reach Jev',async()=>{
  const snapshots=[];
  let evaluated;
  const {service,records,events}=setup({
    getOpinion:async(id,_question,{onProgress})=>{
      if(id==='gemini')return {providerId:id,status:'success',text:'API 의견'};
      const debate={version:1,status:'running',phase:'reviewing',agentCount:3,completedCalls:3,totalCalls:7,agents:[{id:'a',label:'검토자',draft:{text:'초안'}}]};
      onProgress(debate);
      snapshots.push(structuredClone(service.active().opinions.find(o=>o.providerId===id).debate));
      debate.agents[0].draft.text='외부 변경';
      if(id==='claude')throw Object.assign(new Error('3인 토론 중 인증 실패'),{code:'AUTH_REQUIRED'});
      return {providerId:id,status:'success',text:'상호 검토 후 최종 의견',debate:{...snapshots.at(-1),status:'complete',phase:'complete',completedCalls:7}};
    },
    evaluate:async({opinions})=>{evaluated=opinions;return {verdict:{choice:'NO',confidence:.9},qualityAverage:90};}
  });
  service.start({question:'작게 시험할까요?'},defaults);await service.wait();
  assert.ok(snapshots.every(d=>d.agents[0].draft.text==='초안'));
  assert.ok(events.some(e=>e.record.opinions.some(o=>o.status==='running' && o.debate?.phase==='reviewing')));
  assert.deepEqual(evaluated.map(o=>o.providerId),['codex','gemini']);
  assert.equal(evaluated[0].text,'상호 검토 후 최종 의견');
  assert.equal(records[0].opinions[0].excluded,true);
  assert.equal(records[0].opinions[0].debate.agents[0].draft.text,'초안');
  assert.equal(records[0].opinions[1].debate.completedCalls,7);
  assert.equal(records[0].evaluation.verdict.choice,'NO');
});

test('quality and final choice remain independent; completed run saves once',async()=>{
  const {service,records,events}=setup();
  const started = service.start({question:'선택할까요?'},defaults);
  assert.equal(service.active().id,started.runId);
  await service.wait();
  assert.equal(records.length,1);assert.equal(records[0].status,'complete');
  assert.equal(records[0].evaluation.verdict.choice,'NO');assert.equal(records[0].evaluation.qualityAverage,95);
  assert.equal(events.at(-1).type,'complete');assert.equal(service.active(),null);
});
test('one or two successful providers are evaluated without placeholders and retain YES or NO',async()=>{
  for (const scenario of [{ ids:['codex'], choice:'YES' }, { ids:['claude','gemini'], choice:'NO' }]) {
    const evaluated = [];
    const {service,records}=setup({
      getOpinion:async id=>{
        if (!scenario.ids.includes(id)) throw Object.assign(new Error(`${id} 사용 불가`),{code:id==='gemini'?'CLI_NOT_FOUND':'AUTH_REQUIRED'});
        return {providerId:id,status:'success',text:`${id} 실제 의견`,stance:scenario.choice};
      },
      evaluate:async ({opinions})=>{
        evaluated.push(structuredClone(opinions));
        return {verdict:{choice:scenario.choice,rawChoice:scenario.choice,confidence:.9,gateApplied:false,reasonCode:null},qualityAverage:95};
      }
    });
    service.start({question:'질문'},defaults);await service.wait();
    assert.equal(evaluated.length,1);
    assert.deepEqual(evaluated[0].map(o=>o.providerId),scenario.ids);
    assert.ok(evaluated[0].every(o=>o.status==='success' && o.text===`${o.providerId} 실제 의견`));
    const record=records[0];
    assert.equal(record.status,'partial');
    assert.equal(record.evaluation.verdict.choice,scenario.choice);
    assert.equal(record.evaluation.verdict.rawChoice,scenario.choice);
    assert.equal(record.evaluation.verdict.gateApplied,false);
    assert.equal(record.evaluation.qualityAverage,95);
    const failures=record.opinions.filter(o=>!scenario.ids.includes(o.providerId));
    assert.equal(failures.length,3-scenario.ids.length);
    assert.ok(failures.every(o=>o.status==='error' && o.error===`${o.providerId} 사용 불가` && o.errorCode && o.excluded===true));
  }
});

test('returned unavailable and error results remain visible and are excluded from evaluator input',async()=>{
  let evaluatedIds;
  const {service,records}=setup({
    getOpinion:async id=>id==='gemini'
      ? {providerId:id,status:'success',text:'유효 의견'}
      : {providerId:id,status:id==='claude'?'unavailable':'error',error:'사용할 수 없습니다.',errorCode:id==='claude'?'CLI_NOT_FOUND':'AUTH_REQUIRED'},
    evaluate:async ({opinions})=>{evaluatedIds=opinions.map(o=>o.providerId);return {verdict:{choice:'YES',confidence:.9},qualityAverage:80};}
  });
  service.start({question:'질문'},defaults);await service.wait();
  assert.deepEqual(evaluatedIds,['gemini']);
  assert.equal(records[0].evaluation.verdict.choice,'YES');
  assert.deepEqual(records[0].opinions.slice(0,2).map(o=>({status:o.status,errorCode:o.errorCode,excluded:o.excluded})),[
    {status:'error',errorCode:'CLI_NOT_FOUND',excluded:true},
    {status:'error',errorCode:'AUTH_REQUIRED',excluded:true}
  ]);
});

test('partial collection preserves JEV low-confidence HOLD without rewriting its reason',async()=>{
  const {service,records}=setup({
    getOpinion:async id=>{if(id!=='gemini')throw new Error('연결 실패');return {providerId:id,status:'success',text:'의견'};},
    evaluate:async()=>({verdict:{choice:'HOLD',rawChoice:'YES',confidence:.4,gateApplied:true,reasonCode:'LOW_CONFIDENCE'},qualityAverage:90})
  });
  service.start({question:'질문'},defaults);await service.wait();
  assert.equal(records[0].status,'partial');
  assert.equal(records[0].evaluation.verdict.choice,'HOLD');
  assert.equal(records[0].evaluation.verdict.rawChoice,'YES');
  assert.equal(records[0].evaluation.verdict.reasonCode,'LOW_CONFIDENCE');
});
test('all failed opinions skip evaluation and save explicit failure',async()=>{
  let called=false;const {service,records}=setup({getOpinion:async()=>{throw new Error('오류');},evaluate:async()=>{called=true;}});
  service.start({question:'질문'},defaults);await service.wait();
  assert.equal(called,false);assert.equal(records[0].evaluation,null);assert.equal(records[0].status,'failed');
  assert.equal(records[0].errorCode,'NO_SUCCESSFUL_OPINIONS');
  assert.match(records[0].error,/사용 가능한 AI 답변이 없어 판단을 중단/);
  assert.equal(records[0].opinions.length,3);
  assert.ok(records[0].opinions.every(o=>o.status==='error' && o.excluded===true && o.error));
});
test('cancel waits for providers, skips Jev, saves canceled status and allows another run',async()=>{
  let called=false;const {service,records}=setup({getOpinion:async(_id,_q,{signal})=>new Promise((resolve,reject)=>{signal.addEventListener('abort',()=>reject(new Error('취소')),{once:true});}),evaluate:async()=>{called=true;}});
  service.start({question:'질문'},defaults);
  assert.throws(()=>service.start({question:'겹침'},defaults),/진행 중/);
  await new Promise(resolve=>setImmediate(resolve));await service.cancel();
  assert.equal(called,false);assert.equal(records[0].status,'canceled');assert.equal(service.active(),null);
  service.start({question:'새 질문'},defaults);await service.cancel();assert.equal(records.length,2);
});
test('synthesis progress receives timeout and cwd; cancellation clears the evaluation',async()=>{
  let ready;
  const started = new Promise(resolve=>{ready=resolve;});
  const {service,records,events}=setup({cwd:'draft-fixture',evaluate:async options=>{
    assert.equal(options.cwd,'draft-fixture');assert.equal(options.timeoutMs,defaults.timeoutMs);
    options.onProgress({stage:'synthesizing'});ready();
    await new Promise(resolve=>options.signal.addEventListener('abort',resolve,{once:true}));
    options.onProgress({stage:'complete'});
    return {verdict:{choice:'YES'},synthesis:{status:'complete',text:'late result'}};
  }});
  service.start({question:'질문'},defaults);await started;await service.cancel();
  assert.equal(records[0].status,'canceled');assert.equal(records[0].evaluation,null);
  assert.ok(events.some(event=>event.record.evaluationStage==='synthesizing'));
  assert.ok(!events.some(event=>event.record.evaluationStage==='complete'));
});

test('evaluation failure retains actual opinions without fake scores',async()=>{
  const {service,records}=setup({evaluate:async()=>{throw new Error('Jev 연결 실패');}});
  service.start({question:'질문'},defaults);await service.wait();
  assert.equal(records[0].evaluation,null);assert.equal(records[0].opinions.filter(o=>o.status==='success').length,3);assert.equal(records[0].error,'Jev 연결 실패');
});
test('invalid input rejected and store failure remains visible in final event',async()=>{
  const {service,events}=setup({store:{saveRecord:async()=>{throw new Error('disk');}}});
  for(const question of ['',null,'x'.repeat(4001)])assert.throws(()=>service.start({question},defaults),/질문/);
  service.start({question:'질문'},defaults);await service.wait();assert.match(events.at(-1).record.saveError,/저장/);
});
