'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { secretIssues } = require('../scripts/check-secrets.cjs');

test('publication blocks environment, encrypted keys, history, signing secrets and generated artifacts', () => {
  for (const file of ['.env','.ENV','.env.local','backup/.env','gemini-key.bin','keys/jev-key.bin','decisions.json','decisions-recovery-123.json','.omx/reviews/trace.txt','dist/setup.exe','out/resources/app.js','cert.pfx','key.pem','node_modules/module.js']) assert.ok(secretIssues(file, Buffer.from('fixture')).length, file);
  assert.equal(secretIssues('.env.example', Buffer.from('JEV_API_KEY=\nGEMINI_API_KEY=\nGEMINI_MODEL=gemini-example')).length, 0);
  assert.ok(secretIssues('.env.example', Buffer.from('JEV_API_KEY=example-filled-key')).length);
});
test('local actual credential bytes and common token formats block even in innocent source paths', () => {
  const secret = 'fixture-local-secret-12345';
  assert.ok(secretIssues('README.md', Buffer.from('accidental: '+secret), [secret]).length);
  assert.ok(secretIssues('app.js', Buffer.from('gh'+'p_'+'x'.repeat(36))).length);
  assert.ok(secretIssues('app.js', Buffer.from('AI'+'za'+'x'.repeat(35))).length);
  assert.equal(secretIssues('services/jev.cjs', Buffer.from('process.env.JEV_API_KEY')).length, 0);
});
