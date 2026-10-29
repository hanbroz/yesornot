'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {randomUUID}=require('node:crypto');
const {createStore,validateSettings}=require('../services/store.cjs');
test('atomic concurrent history and settings writes persist Korean and literal markup',async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'yesorno-store-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 const store=createStore(dir);await store.load();
 const make=()=>({id:randomUUID(),question:'한글 <script> & " \\n',opinions:[],status:'complete'});
 const a=make(),b=make();await Promise.all([store.saveRecord(a),store.saveRecord(b),store.saveSettings({model:'jev-test',timeoutMs:300000})]);
 const fresh=createStore(dir);await fresh.load();assert.equal(fresh.snapshot().history.length,2);assert.equal(fresh.snapshot().history[0].question,b.question);assert.equal(fresh.snapshot().settings.model,'jev-test');
 const copy=fresh.snapshot();copy.history.length=0;assert.equal(fresh.snapshot().history.length,2);
});
test('debate transcripts round-trip alongside historical single-opinion records',async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'yesorno-store-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 const store=createStore(dir);await store.load();
 const legacy={id:randomUUID(),question:'이전 질문',status:'complete',opinions:[{providerId:'claude',status:'success',text:'이전 단일 의견'}]};
 const debate={version:1,status:'complete',phase:'complete',agentCount:3,completedCalls:7,totalCalls:7,agents:['a','b','c'].map(id=>({id,label:'검토자 '+id,status:'reviewed',draft:{text:'독립 의견 <img onerror=evil()>'},review:{text:'다른 검토자 의견에 대한 반론'}})),synthesis:{text:'최종 종합'}};
 const next={id:randomUUID(),question:'새 질문',status:'complete',opinions:[{providerId:'codex',status:'success',text:'최종 종합',debate}],evaluation:{model:'jev-test',opinions:[{providerId:'codex',total:90,dimensions:[]}],qualityAverage:90,verdict:{choice:'YES',confidence:.4,probabilities:{YES:.6,NO:.3,HOLD:.1},gateApplied:false},synthesis:{version:1,status:'complete',providerId:'claude',sourceProviderIds:['claude','codex'],title:'종합 권고',text:'양쪽의 근거를 합친 새 의견 <img onerror=evil()>',point:'작게 시작하기'}}};
 await store.saveRecord(legacy);await store.saveRecord(next);
 const fresh=createStore(dir);await fresh.load();
 assert.deepEqual(fresh.snapshot().history[0],next);assert.deepEqual(fresh.snapshot().history[1],legacy);
 next.opinions[0].debate.agents.length=0;
 assert.equal(fresh.snapshot().history[0].opinions[0].debate.agents.length,3);
});

test('corrupt history preserves original recovery copy and surfaces warning',async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'yesorno-store-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 await fs.writeFile(path.join(dir,'decisions.json'),'{broken');const store=createStore(dir);await store.load();
 assert.match(store.snapshot().warning,/복구/);assert.ok((await fs.readdir(dir)).some(f=>f.startsWith('decisions-recovery-')));
});
test('settings enforce fixed fields and timeout bounds',()=>{
 assert.throws(()=>validateSettings({model:'http://attacker',timeoutMs:180000}));assert.throws(()=>validateSettings({model:'jev-latest',timeoutMs:1}));
 assert.deepEqual(validateSettings({model:'jev-latest',timeoutMs:180000,apiKey:'do-not-store'}),{model:'jev-latest',timeoutMs:180000});
});
