'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require('node:path').join(__dirname, '../main.cjs'), 'utf8');
const handler = source.slice(source.indexOf('async function saveApiKeys('), source.indexOf('async function checkConnections('));
function fixture(busy = false) {
  const writes = [];
  const scope = { service:{active:()=>busy}, connectionPromise:null, apiKey:'',geminiKey:'',keyMessage:'',geminiKeyMessage:'',userData:'fixture-private-dir',safeStorage:{},saveSecret:async options=>{writes.push(options);return {configured:true}} };
  const save = vm.runInNewContext(handler+'\nsaveApiKeys',scope);
  return {save,writes,scope};
}
test('actual main IPC handler accepts both printable keys but returns only configuration flags', async () => {
  const f=fixture();const result=await f.save({jev:'fixture-jev-123',gemini:'fixture-gemini-456'});
  assert.equal(f.writes.length,2);assert.equal(result.configured.jev,true);assert.equal(result.configured.gemini,true);
  assert.equal(f.scope.apiKey,'fixture-jev-123');assert.equal(f.scope.geminiKey,'fixture-gemini-456');
  assert.ok(!JSON.stringify(result).includes('fixture-'));
  assert.equal(f.writes[0].fileName,'jev-key.bin');assert.equal(f.writes[1].fileName,'gemini-key.bin');
});
test('actual main IPC handler validates the whole batch before writing and blocks changes during runs', async () => {
  for (const payload of [[],{},null,{unknown:'key'},{jev:'valid-fixture',gemini:'bad key'},{jev:'valid-fixture',gemini:'bad\nkey'},{jev:'bad-key\n'},{jev:'한글키'},{jev:'x'.repeat(4097)}]) {
    const f=fixture();await assert.rejects(f.save(payload));assert.equal(f.writes.length,0);
  }
  const f=fixture(true);await assert.rejects(f.save({jev:'valid-fixture'}),/진행 중인 판단/);assert.equal(f.writes.length,0);
});
