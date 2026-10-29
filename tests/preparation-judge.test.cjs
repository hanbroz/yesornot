'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { judgePreparation, PREPARATION_CHOICES } = require('../services/jev.cjs');
const keys=Object.keys(PREPARATION_CHOICES);
const choices=(choice,all)=>({type:'choice',choice,confidence:.9,probabilities:Object.fromEntries(all.map(key=>[key,key===choice?1:0]))});

test('JEV classifies each intake candidate and public coverage separately without returning a decision', async()=>{
  let sent;
  const result=await judgePreparation({question:'이사할까요?',plans:[{providerId:'claude',summary:'공개 시세는 조사'}],attachments:[{name:'자금계획.txt',text:'이미 제공한 개인 자금 5000만원',truncated:false}],candidates:[{id:'q1',question:'동원할 수 있는 개인 자금은?',why:'자금 제약'}],apiKey:'fake-test-key',fetchImpl:async(url,options)=>{
    assert.equal(url,'https://api.typesafe.ai/v1/systemone');sent=JSON.parse(options.body);
    return {ok:true,status:200,json:async()=>({model:'jev-fixture',answers:{q1:choices('ASK_REQUIRED',keys),intake_integrity:choices('COMPLETE',['COMPLETE','REPAIR_REQUIRED']),research_plan:choices('OFFICIAL',['READY','OFFICIAL','NEWS','PAPERS','COUNTER'])}})};
  }});
  assert.equal(sent.questions.q1.type,'choice');
  assert.match(sent.state.attachments[0].text,/이미 제공한 개인 자금/);
  assert.equal(sent.state.attachments[0].name,'자금계획.txt');
  assert.match(sent.questions.q1.instructions,/공개 검색/);
  assert.equal(sent.questions.verdict,undefined);
  assert.equal(result.items[0].choice,'ASK_REQUIRED');
  assert.equal(result.researchPlan.choice,'OFFICIAL');
});
test('even no intake candidates obtains actual JEV plan review; invalid distributions fail closed',async()=>{
  let calls=0;
  const options={question:'명확한 질문',plans:[],candidates:[],apiKey:'fake-test-key',fetchImpl:async()=>{calls++;return {ok:true,status:200,json:async()=>({model:'jev-fixture',answers:{intake_integrity:choices('COMPLETE',['COMPLETE','REPAIR_REQUIRED']),research_plan:choices('READY',['READY','OFFICIAL','NEWS','PAPERS','COUNTER'])}})};}};
  assert.equal((await judgePreparation(options)).items.length,0);assert.equal(calls,1);
  await assert.rejects(judgePreparation({...options,fetchImpl:async()=>({ok:true,status:200,json:async()=>({model:'jev-fixture',answers:{intake_integrity:choices('COMPLETE',['COMPLETE','REPAIR_REQUIRED']),research_plan:{...choices('READY',['READY','OFFICIAL','NEWS','PAPERS','COUNTER']),probabilities:{READY:0,OFFICIAL:0,NEWS:0,PAPERS:0,COUNTER:0}}}})})}),{code:'INVALID_RESPONSE'});
});

const coverageKeys = ['READY','OFFICIAL','NEWS','PAPERS','COUNTER'];
function fixtureOptions(candidates, answerFor = () => 'ASK_REQUIRED', capture = () => {}) {
  return {
    question: '주거 이전을 검토해 주세요.', plans: [], candidates, apiKey: 'fake-test-key',
    fetchImpl: async (_url, options) => {
      const sent = JSON.parse(options.body);
      capture(sent);
      return { ok: true, status: 200, json: async () => ({
        model: 'jev-fixture',
        answers: {
          ...Object.fromEntries(candidates.map(item => [item.id, choices(answerFor(item), keys)])),
          intake_integrity:choices('COMPLETE',['COMPLETE','REPAIR_REQUIRED']),research_plan: choices('READY', coverageKeys),
        },
      }) };
    },
  };
}

test('preparation criteria preserve all six classifications with strict necessity and atomicity contracts', async () => {
  assert.deepEqual(keys, ['ASK_REQUIRED','ASK_OPTIONAL','RESEARCH_PUBLIC','ALREADY_SUPPLIED','NOT_NEEDED','SPLIT_REQUIRED']);
  assert.ok(Object.isFrozen(PREPARATION_CHOICES));
  assert.match(PREPARATION_CHOICES.ASK_REQUIRED, /단일 정보/);
  assert.match(PREPARATION_CHOICES.ASK_REQUIRED, /실질적으로 달라/);
  assert.match(PREPARATION_CHOICES.ASK_REQUIRED, /대체할 수 없어/);
  assert.match(PREPARATION_CHOICES.ASK_OPTIONAL, /선택 정보/);
  assert.match(PREPARATION_CHOICES.NOT_NEEDED, /가정이나 시나리오 비교/);
  assert.match(PREPARATION_CHOICES.SPLIT_REQUIRED, /독립적으로 답할 정보가 둘 이상/);

  let sent;
  const candidate = {id:'q1',question:'이사 예산은 얼마인가요?',why:'월 상환 한도도 알려 주세요.',material:'희망 기한이 적힌 자료도 첨부해 주세요.'};
  const result = await judgePreparation(fixtureOptions([candidate], () => 'SPLIT_REQUIRED', value => {sent = value;}));
  const instructions = sent.questions.q1.instructions;
  assert.deepEqual(sent.state.candidates, [candidate]);
  assert.match(instructions, /질문\(question\).*이유\(why\).*요청 자료\(material\)/);
  assert.match(instructions, /반사실적으로 비교/);
  assert.match(instructions, /정확도가 높아진다.*이유로 필수 질문을 만들지/);
  assert.match(instructions, /예산·월 상환 한도·희망 기한/);
  assert.match(instructions, /why나 material.*추가 요청하여 숨기지/);
  assert.match(instructions, /제외 분류를 SPLIT_REQUIRED보다 우선/);
  assert.match(instructions, /대체 자료나 같은 값의 단위 설명은 추가 질문이 아닙니다/);
  assert.equal(result.items[0].choice, 'SPLIT_REQUIRED');
  assert.deepEqual(Object.keys(result.items[0].probabilities), keys);
});

test('classifier retains required, optional, public, supplied, unnecessary, and split results independently', async () => {
  const candidates = [
    {id:'q1',question:'어느 후보 주택을 비교할까요?'},
    {id:'q2',question:'선호하는 인테리어 색상은 무엇인가요?'},
    {id:'q3',question:'공식 금리와 최근 시세는 어떻게 되나요?'},
    {id:'q4',question:'이미 첨부한 현금 잔액은 얼마인가요?'},
    {id:'q5',question:'이사 결정과 관계없는 취미는 무엇인가요?'},
    {id:'q6',question:'자금 여력과 상환 한도, 희망 기한을 알려 주세요.'},
  ];
  const result = await judgePreparation(fixtureOptions(candidates, item => keys[Number(item.id.slice(1)) - 1]));
  assert.deepEqual(result.items.map(item => item.choice), keys);
  assert.equal(result.researchPlan.choice, 'READY');
  assert.equal(result.verdict, undefined);
});

test('up to 48 atomic candidates are supported without raising the 24 raw source limit', async () => {
  const candidates = Array.from({length:48}, (_, i) => ({id:'q' + (i + 1),question:'단일 정보 ' + (i + 1)}));
  let sent;
  const options = fixtureOptions(candidates, () => 'NOT_NEEDED', value => {sent = value;});
  options.sourceCandidates = Array.from({length:24}, (_, i) => ({id:'raw_' + (i + 1),question:'원본 ' + (i + 1)}));
  const result = await judgePreparation(options);
  assert.equal(result.items.length, 48);
  assert.equal(result.items.at(-1).id, 'q48');
  assert.equal(Object.keys(sent.questions).length, 50);
  assert.equal(sent.state.sourceCandidates.length, 24);

  let calls = 0;
  const failIfCalled = async () => {calls++; throw new Error('must not call API');};
  await assert.rejects(judgePreparation({...options,candidates:[...candidates,{id:'q49',question:'초과'}],fetchImpl:failIfCalled}), {code:'INVALID_INPUT'});
  await assert.rejects(judgePreparation({...options,sourceCandidates:[...options.sourceCandidates,{id:'raw_25',question:'초과'}],fetchImpl:failIfCalled}), {code:'INVALID_INPUT'});
  assert.equal(calls, 0);
});

test('invalid and duplicate candidate identifiers fail before calling JEV', async () => {
  let calls = 0;
  const options = {...fixtureOptions([]),fetchImpl:async () => {calls++; throw new Error('must not call API');}};
  for (const candidates of [
    [null],
    [{id:'q123',question:'잘못된 ID'}],
    [{id:'q1',question:'첫 질문'},{id:'q1',question:'두 번째 질문'}],
  ]) {
    await assert.rejects(judgePreparation({...options,candidates}), {code:'INVALID_INPUT'});
  }
  assert.equal(calls, 0);
});

test('unknown choices and obsolete or inconsistent probability distributions are rejected', async () => {
  const candidate = {id:'q1',question:'비교할 후보는 무엇인가요?'};
  const options = fixtureOptions([candidate]);
  const obsoleteKeys = ['ASK_REQUIRED','ASK_OPTIONAL','RESEARCH_PUBLIC','ALREADY_SUPPLIED'];
  const invalidAnswers = [
    choices('UNKNOWN', [...keys, 'UNKNOWN']),
    choices('ASK_REQUIRED', obsoleteKeys),
    {...choices('ASK_REQUIRED', keys),probabilities:{...choices('NOT_NEEDED', keys).probabilities}},
    {...choices('SPLIT_REQUIRED', keys),confidence:2},
    {...choices('NOT_NEEDED', keys),type:'score'},
  ];
  for (const answer of invalidAnswers) {
    await assert.rejects(judgePreparation({...options,fetchImpl:async () => ({
      ok:true,status:200,json:async () => ({
        model:'jev-fixture',answers:{q1:answer,intake_integrity:choices('COMPLETE',['COMPLETE','REPAIR_REQUIRED']),research_plan:choices('READY',coverageKeys)},
      }),
    })}), {code:'INVALID_RESPONSE'});
  }
});

test('intake integrity independently compares every source fact and requests repair even for an atomic surviving item', async () => {
  const candidate = {id:'q1',question:'투입할 자기 자금은 얼마인가요?',why:'실행 가능한 거래 범위가 달라집니다.',material:'',sourceIds:['r1']};
  let sent;
  const options = fixtureOptions([candidate], () => 'ASK_REQUIRED', value => {sent = value;});
  options.sourceCandidates = [{id:'r1',question:'자기 자금과 월 상환 한도, 기한을 알려 주세요.',providerIds:['claude']}];
  options.plans = [{providerId:'claude',questions:[{question:options.sourceCandidates[0].question,why:'세 조건 각각 실행 여부를 바꿉니다.',material:'',required:true}]}];
  const fetchFixture = options.fetchImpl;
  options.fetchImpl = async (...args) => {
    const response = await fetchFixture(...args);
    const payload = await response.json();
    payload.answers.intake_integrity = choices('REPAIR_REQUIRED', ['COMPLETE','REPAIR_REQUIRED']);
    return {...response,json:async () => payload};
  };
  const result = await judgePreparation(options);
  assert.equal(result.items[0].choice, 'ASK_REQUIRED');
  assert.equal(result.intakeIntegrity.choice, 'REPAIR_REQUIRED');
  assert.deepEqual(result.intakeIntegrity.probabilities, {COMPLETE:0,REPAIR_REQUIRED:1});
  assert.deepEqual(sent.state.sourceCandidates, options.sourceCandidates);
  assert.deepEqual(sent.state.plans[0].data.questions, options.plans[0].questions);
  assert.equal(sent.questions.intake_integrity.type, 'choice');
  assert.deepEqual(Object.keys(sent.questions.intake_integrity.criteria), ['COMPLETE','REPAIR_REQUIRED']);
  const instructions = sent.questions.intake_integrity.instructions;
  assert.match(instructions, /sourceCandidates.*plans.*questions.*why.*material/);
  assert.match(instructions, /summary·searches.*질문이 아니며/);
  assert.match(instructions, /sourceIds.*등장한다는 사실만으로/);
  assert.match(instructions, /세 정보 각각에 대응하는 단일 후보/);
  assert.match(instructions, /개별 필요성 choice로 제외/);
  assert.match(instructions, /무관한 새 질문/);
  assert.match(instructions, /단위·조건 설명.*오인하지/);
});

test('empty intake still requires a valid independent completeness result', async () => {
  const result = await judgePreparation(fixtureOptions([]));
  assert.equal(result.items.length, 0);
  assert.equal(result.intakeIntegrity.choice, 'COMPLETE');
});

test('missing, unknown, or malformed intake integrity cannot bypass real JEV parsing', async () => {
  const options = fixtureOptions([{id:'q1',question:'대상 후보는 무엇인가요?'}]);
  const invalidResults = [
    undefined,
    choices('UNKNOWN', ['COMPLETE','REPAIR_REQUIRED','UNKNOWN']),
    {...choices('COMPLETE',['COMPLETE','REPAIR_REQUIRED']),probabilities:{COMPLETE:0,REPAIR_REQUIRED:0}},
    {...choices('COMPLETE',['COMPLETE','REPAIR_REQUIRED']),probabilities:{COMPLETE:0,REPAIR_REQUIRED:1}},
    {...choices('COMPLETE',['COMPLETE','REPAIR_REQUIRED']),confidence:-1},
    {...choices('COMPLETE',['COMPLETE','REPAIR_REQUIRED']),type:'score'},
  ];
  for (const integrity of invalidResults) {
    await assert.rejects(judgePreparation({...options,fetchImpl:async () => {
      const answers = {q1:choices('ASK_REQUIRED',keys),research_plan:choices('READY',coverageKeys)};
      if (integrity !== undefined) answers.intake_integrity = integrity;
      return {ok:true,status:200,json:async () => ({model:'jev-fixture',answers})};
    }}), {code:'INVALID_RESPONSE'});
  }
});
