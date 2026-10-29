'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs/promises');
const { getOpinion, runProcess, parseOpinion, cleanEnvironment, buildArgs, buildPrompt, resolveCli, safeMessage, prepareGemini, subscriptionAuthenticated, providerFailure } = require('../services/cli.cjs');

const opinion = { stance: 'HOLD', title: '조건 확인', body: '자료가 부족하므로 먼저 사용 목적을 확인해야 합니다.', point: '비용과 기대 효과를 확인하세요.' };

test('parses Claude validated structured output and preserves model metadata', () => {
  const parsed = parseOpinion('claude', JSON.stringify({ type: 'result', structured_output: opinion, modelUsage: { 'claude-opus-example': {} } }));
  assert.equal(parsed.stance, 'HOLD');
  assert.equal(parsed.text, opinion.body);
  assert.equal(parsed.model, 'claude-opus-example');
});

test('parses Codex JSONL final agent message, ignoring reasoning events', () => {
  const output = [
    { type: 'thread.started', thread_id: 'example' },
    { type: 'item.completed', item: { type: 'reasoning', text: 'internal' } },
    { type: 'item.completed', item: { type: 'agent_message', text: '```json\n' + JSON.stringify(opinion) + '\n```' } },
    { type: 'turn.completed', usage: {} },
  ].map(JSON.stringify).join('\n');
  assert.equal(parseOpinion('codex', output).text, opinion.body);
});

test('parses Gemini JSON response and actual selected model', () => {
  const parsed = parseOpinion('gemini', JSON.stringify({ response: JSON.stringify(opinion), stats: { models: { 'gemini-example': {} } } }));
  assert.equal(parsed.point, opinion.point);
  assert.equal(parsed.model, 'gemini-example');
});

test('rejects empty, incomplete and malformed output instead of returning fake success', () => {
  for (const output of ['', '{', '{"result":"no response"}', JSON.stringify({ result: JSON.stringify({ ...opinion, stance: 'MAYBE' }) }), JSON.stringify({ result: JSON.stringify({ ...opinion, body: '' }) })]) {
    assert.throws(() => parseOpinion('claude', output));
  }
  assert.throws(() => parseOpinion('codex', JSON.stringify({ type: 'turn.failed', error: { message: 'quota exhausted' } })), { code: 'PROVIDER_ERROR' });
  assert.throws(() => parseOpinion('gemini', JSON.stringify({ response: JSON.stringify(opinion), error: { message: 'failure' } })), { code: 'PROVIDER_ERROR' });
});

test('environment removes billing credentials and Electron injection while keeping subscription auth', () => {
  const source = { PATH: 'example', JEV_API_KEY: 'secret', typesafe_api_key: 'secret', OPENAI_API_KEY: 'secret', CODEX_API_KEY: 'secret', ANTHROPIC_API_KEY: 'secret', GEMINI_API_KEY: 'secret', GOOGLE_API_KEY: 'secret', ELECTRON_RUN_AS_NODE: '1', ELECTRON_NO_ASAR: '1', NODE_OPTIONS: '--inspect', CLAUDECODE: '1', CLAUDE_CODE_USE_BEDROCK: '1', CLAUDE_CODE_OAUTH_TOKEN: 'keep-oauth', CODEX_HOME: 'keep-home', USERPROFILE: 'keep-profile' };
  assert.deepEqual(cleanEnvironment(source), { PATH: 'example', CLAUDE_CODE_OAUTH_TOKEN: 'keep-oauth', CODEX_HOME: 'keep-home', USERPROFILE: 'keep-profile' });
  assert.equal(source.JEV_API_KEY, 'secret');
});

test('opinion configuration disables tools without bypass flags or Claude bare OAuth breakage', () => {
  const claude = buildArgs('claude', '/isolated');
  assert.equal(claude[claude.indexOf('--tools') + 1], '');
  assert.ok(claude.includes('--safe-mode'));
  assert.ok(claude.includes('--strict-mcp-config'));
  assert.ok(!claude.includes('--bare'));
  const codex = buildArgs('codex', '/isolated');
  assert.ok(codex.includes('--ignore-user-config'));
  assert.ok(codex.includes('shell_tool'));
  assert.ok(codex.includes('web_search="disabled"'));
  for (const args of [claude, codex, buildArgs('gemini', '/isolated')]) assert.ok(!args.some(arg => /bypass|yolo|dangerously/.test(arg)));
});

test('stdin preserves Korean and shell metacharacters literally without command execution', async () => {
  const input = '질문 "$(Write-Host secret)" & | < > `echo x`\n한글';
  const output = await runProcess(process.execPath, ['-e', 'process.stdin.pipe(process.stdout)'], { input });
  assert.equal(output.stdout, input);
  assert.equal(output.exitCode, 0);
  assert.equal(JSON.parse(buildPrompt(input).split('\n').at(-1)).question, input);
});

test('internal debate prompts reject malformed input before resolving any CLI',async()=>{
  for(const prompt of [42,'',' '.repeat(8),'x'.repeat(128001)]) await assert.rejects(getOpinion('claude','질문',{prompt}),{code:'INVALID_PROMPT'});
  const controller=new AbortController();controller.abort();
  await assert.rejects(getOpinion('codex','질문',{signal:controller.signal}),{code:'ABORTED'});
});

test('timeout terminates a hung process and reports TIMEOUT', async () => {
  await assert.rejects(runProcess(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { timeoutMs: 100 }), { code: 'TIMEOUT' });
});

test('abort cancels an in-flight process and pre-abort never starts it', async () => {
  const controller = new AbortController();
  const running = runProcess(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { signal: controller.signal });
  controller.abort();
  await assert.rejects(running, { code: 'ABORTED' });
  await assert.rejects(runProcess('does-not-exist', [], { signal: controller.signal }), { code: 'ABORTED' });
});

test('oversized output is bounded and fails explicitly', async () => {
  await assert.rejects(runProcess(process.execPath, ['-e', 'process.stdout.write("x".repeat(100000))'], { maxOutputBytes: 100 }), { code: 'OUTPUT_LIMIT' });
});

test('missing process produces an actionable spawn error', async () => {
  await assert.rejects(runProcess(path.join(os.tmpdir(), 'jevision-nonexistent-executable'), []), { code: 'ENOENT' });
});

test('resolves optional local official Gemini package through real node without npm shell shims', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'jevision-resolve-test-'));
  try {
    const entry = path.join(root, 'tools', 'gemini', 'node_modules', '@google', 'gemini-cli', 'dist', 'index.js');
    await fs.mkdir(path.dirname(entry), { recursive: true });
    await fs.writeFile(entry, '// fixture');
    const binary = resolveCli('gemini', { cwd: root, env: { PATH: path.dirname(process.execPath) } });
    assert.equal(binary.command, process.execPath);
    assert.deepEqual(binary.args, [entry]);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('Gemini isolation disables automatic hooks, tools, MCP and context discovery', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'jevision-gemini-test-'));
  try {
    const env = await prepareGemini(directory, { PATH: 'keep', CLAUDE_CODE_OAUTH_TOKEN: 'auth' });
    const config = JSON.parse(await fs.readFile(path.join(directory, '.gemini', 'settings.json'), 'utf8'));
    assert.equal(env.GEMINI_CLI_SYSTEM_SETTINGS_PATH, undefined);
    assert.equal(env.GEMINI_CLI_TRUST_WORKSPACE, 'true');
    assert.equal(await fs.readFile(path.join(directory, '.gemini', '.env'), 'utf8'), '');
    assert.deepEqual(config.tools.core, []);
    assert.equal(config.hooksConfig.enabled, false);
    assert.deepEqual(config.mcp.allowed, []);
    assert.deepEqual(config.context.fileName, []);
    assert.equal(config.advanced.ignoreLocalEnv, false);
    assert.equal(config.security.auth.selectedType, 'oauth-personal');
    assert.equal(await fs.readFile(path.join(directory, '.env'), 'utf8'), '');
    assert.match(await fs.readFile(config.policyPaths[0], 'utf8'), /toolName = "\*"[\s\S]*decision = "deny"/);
    assert.equal(env.PATH, 'keep');
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test('subscription preflight accepts OAuth and rejects API-key authentication', async () => {
  const fixture = output => ({ command: process.execPath, args: ['-e', `console.log(${JSON.stringify(output)});`, '--'] });
  assert.equal(await subscriptionAuthenticated('codex', fixture('Logged in using ChatGPT'), {}), true);
  assert.equal(await subscriptionAuthenticated('codex', fixture('Logged in using an API key'), {}), false);
  assert.equal(await subscriptionAuthenticated('claude', fixture(JSON.stringify({ loggedIn: true, authMethod: 'oauth_token' })), {}), true);
  assert.equal(await subscriptionAuthenticated('claude', fixture(JSON.stringify({ loggedIn: true, authMethod: 'api_key' })), {}), false);
});

test('Gemini service rejection after successful OAuth does not request another login', () => {
  const error = providerFailure('gemini', { exitCode: 41, stdout: 'Authentication succeeded', stderr: 'Failed to sign in. Message: This client is no longer supported for Gemini Code Assist for individuals. To continue using Gemini, please migrate to the Antigravity suite of products: https://antigravity.google' });
  assert.equal(error.code, 'UNSUPPORTED_CLIENT');
  assert.match(error.message, /다시 로그인해도 해결되지 않습니다/);
  assert.match(error.message, /Antigravity/);
  assert.equal(providerFailure('gemini', { exitCode: 1, stdout: '', stderr: 'UNSUPPORTED_CLIENT: OAuth completed' }).code, 'UNSUPPORTED_CLIENT');
});

test('Gemini entitlement failure remains distinct from expired credentials', () => {
  assert.equal(providerFailure('gemini', { exitCode: 41, stdout: '', stderr: 'Authentication: account not eligible for Gemini Code Assist' }).code, 'SERVICE_NOT_ENTITLED');
  assert.equal(providerFailure('gemini', { exitCode: 41, stdout: '', stderr: 'invalid_grant: OAuth token expired' }).code, 'AUTH_REQUIRED');
  assert.equal(providerFailure('codex', { exitCode: 1, stdout: '', stderr: 'not logged in' }).code, 'AUTH_REQUIRED');
  assert.equal(providerFailure('gemini', { exitCode: 1, stdout: '', stderr: 'RESOURCE_EXHAUSTED 429' }).code, 'RATE_LIMIT');
});

test('known API secrets are redacted from provider failure messages', () => {
  const original = process.env.JEV_API_KEY;
  process.env.JEV_API_KEY = 'private-test-secret-value';
  try { assert.equal(safeMessage('bad private-test-secret-value'), 'bad [REDACTED]'); }
  finally { if (original === undefined) delete process.env.JEV_API_KEY; else process.env.JEV_API_KEY = original; }
});
