'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const config = require('../electron-builder.config.cjs');
const { privatePath, validatePayload } = require('../scripts/build-installer.cjs');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createPackage } = require('@electron/asar');

test('installer identity, per-user upgrade and public feed remain stable', () => {
  assert.equal(config.appId, 'ai.typesafe.yesornot');
  assert.equal(config.productName, 'YES or NO');
  assert.equal(config.nsis.perMachine, false);
  assert.equal(config.nsis.allowElevation, false);
  assert.equal(config.nsis.runAfterFinish, false);
  assert.equal(config.nsis.deleteAppDataOnUninstall, false);
  assert.deepEqual(config.publish.map(({ provider, owner, repo }) => ({ provider, owner, repo })), [{ provider: 'github', owner: 'hanbroz', repo: 'yesornot' }]);
});
test('installer runtime selection includes fonts and updater services while rejecting private paths', () => {
  assert.ok(config.files.includes('fonts/**/*'));
  assert.ok(config.files.includes('services/*.cjs'));
  for (const file of ['/app/.env', 'services/.ENV.local', 'jev-key.bin', 'user/decisions.json', '.omx/reviews/history.json']) assert.equal(privatePath(file), true, file);
  for (const file of ['services/evidence.cjs', 'node_modules/electron-updater/package.json', 'assets/app-icon.ico']) assert.equal(privatePath(file), false, file);
});

async function fixture(t, { extraFile, keyInBody, keyFile = 'main.cjs', missingUpdater = false, feed = 'provider: github\nowner: hanbroz\nrepo: yesornot\n' } = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'yesornot-installer-test-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const source = path.join(directory, 'source');
  const output = path.join(directory, 'output');
  const required = ['main.cjs', 'preload.cjs', 'index.html', 'app.js', 'styles.css', 'build-info.json', 'services/updates.cjs'];
  if (!missingUpdater) required.push('node_modules/electron-updater/package.json');
  if (extraFile) required.push(extraFile);
  for (const file of required) {
    const destination = path.join(source, file);
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.writeFile(destination, file === keyFile && keyInBody ? keyInBody : '{}');
  }
  await fs.mkdir(path.join(output, 'resources'), { recursive: true });
  await createPackage(source, path.join(output, 'resources', 'app.asar'));
  await fs.writeFile(path.join(output, 'resources', 'app-update.yml'), feed);
  return output;
}

test('archive validation accepts complete runtime across Windows path separators', async t => {
  await validatePayload(await fixture(t));
});
test('archive validation rejects secret paths and incomplete updater runtime', async t => {
  await assert.rejects(validatePayload(await fixture(t, { extraFile: '.env.local' })), /Private configuration/u);
  await assert.rejects(validatePayload(await fixture(t, { missingUpdater: true })), /missing runtime file/u);
  await assert.rejects(validatePayload(await fixture(t, { feed: 'owner: other\nrepo: other\n' })), /Unexpected automatic update repository/u);
});
test('archive validation rejects known key contents without including values in errors', async t => {
  const previous = process.env.JEV_API_KEY;
  const fake = 'fixture-secret-only-not-a-real-key';
  process.env.JEV_API_KEY = fake;
  try {
    for (const keyFile of ['main.cjs', 'services/updates.cjs', 'node_modules/electron-updater/package.json', 'assets/key-in-image.png']) {
      const output = await fixture(t, { keyFile, ...(keyFile.startsWith('assets/') ? { extraFile: keyFile } : {}), keyInBody: 'const key = "' + fake + '";' });
      await assert.rejects(validatePayload(output), error => error.message === 'A local API key was found in installer payload.' && !error.message.includes(fake));
    }
  } finally {
    if (previous === undefined) delete process.env.JEV_API_KEY;
    else process.env.JEV_API_KEY = previous;
  }
});
