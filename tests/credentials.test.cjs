'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { loadSecret, saveSecret } = require('../services/credentials.cjs');

const vault = {
  isAsyncEncryptionAvailable: async () => true,
  encryptStringAsync: async key => Buffer.from('test-cipher:' + Buffer.from(key).toString('base64')),
  decryptStringAsync: async encrypted => ({ result: Buffer.from(encrypted.toString().slice(12), 'base64').toString(), shouldReEncrypt: false }),
};
test('Gemini and Jev keys persist separately as encrypted data and leave child environment', async () => {
  const userData = await fs.mkdtemp(path.join(os.tmpdir(), 'yesornot-keys-'));
  try {
    const env = { GEMINI_API_KEY: 'old-gemini', JEV_API_KEY: 'old-jev', PATH: 'keep' };
    for (const [keyName, fileName, key] of [['GEMINI_API_KEY', 'gemini-key.bin', 'test-gemini-secret'], ['JEV_API_KEY', 'jev-key.bin', 'test-jev-secret']]) {
      assert.deepEqual(await loadSecret({ config: { [keyName]: key }, env, keyName, fileName, userData, safeStorage: vault }), { key, message: '' });
      assert.ok(!(await fs.readFile(path.join(userData, fileName))).includes(Buffer.from(key)));
      assert.deepEqual(await loadSecret({ config: {}, env, keyName, fileName, userData, safeStorage: vault }), { key, message: '' });
    }
    assert.deepEqual(env, { PATH: 'keep' });
  } finally { await fs.rm(userData, { recursive: true, force: true }); }
});
test('unavailable encryption keeps a supplied key only in memory and never writes plaintext', async () => {
  const userData = await fs.mkdtemp(path.join(os.tmpdir(), 'yesornot-keys-'));
  try {
    const env = { GEMINI_API_KEY: 'test-runtime-secret' };
    const result = await loadSecret({ config: {}, env, keyName: 'GEMINI_API_KEY', fileName: 'gemini-key.bin', userData, safeStorage: { isAsyncEncryptionAvailable: async () => false } });
    assert.equal(result.key, 'test-runtime-secret');
    assert.match(result.message, /이번 실행/);
    assert.ok(!result.message.includes(result.key));
    assert.deepEqual(await fs.readdir(userData), []);
    assert.equal(env.GEMINI_API_KEY, undefined);
  } finally { await fs.rm(userData, { recursive: true, force: true }); }
});
test('missing or unreadable saved key is not treated as configured', async () => {
  const userData = await fs.mkdtemp(path.join(os.tmpdir(), 'yesornot-keys-'));
  try {
    const options = { config: {}, env: {}, keyName: 'GEMINI_API_KEY', fileName: 'gemini-key.bin', userData, safeStorage: vault };
    assert.deepEqual(await loadSecret(options), { key: '', message: '' });
    await fs.writeFile(path.join(userData, 'gemini-key.bin'), 'unreadable');
    assert.deepEqual(await loadSecret({ ...options, safeStorage: { decryptStringAsync: async () => { throw new Error('bad'); } } }), { key: '', message: '' });
  } finally { await fs.rm(userData, { recursive: true, force: true }); }
});

test('UI key replaces encrypted data atomically and takes precedence over stale environment config', async () => {
  const userData = await fs.mkdtemp(path.join(os.tmpdir(), 'yesornot-keys-'));
  try {
    const options = { userData, safeStorage: vault, fileName: 'jev-key.bin' };
    assert.deepEqual(await saveSecret({ ...options, key: 'first-ui-key' }), { configured: true });
    assert.deepEqual(await saveSecret({ ...options, key: 'replacement-ui-key' }), { configured: true });
    const env = { JEV_API_KEY: 'stale-environment-key', PATH: 'keep' };
    const loaded = await loadSecret({ ...options, config: { JEV_API_KEY: 'stale-env-file-key' }, env, keyName: 'JEV_API_KEY' });
    assert.equal(loaded.key, 'replacement-ui-key');
    assert.deepEqual(env, { PATH: 'keep' });
    const files = await fs.readdir(userData);
    assert.deepEqual(files, ['jev-key.bin']);
    const stored = await fs.readFile(path.join(userData, files[0]));
    assert.ok(!stored.includes(Buffer.from('replacement-ui-key')));
  } finally { await fs.rm(userData, { recursive: true, force: true }); }
});

test('UI save refuses unavailable encryption and never falls back to plaintext or returns a key', async () => {
  const userData = await fs.mkdtemp(path.join(os.tmpdir(), 'yesornot-keys-'));
  try {
    const options = { userData, fileName: 'gemini-key.bin', key: 'not-a-real-secret' };
    await assert.rejects(saveSecret({ ...options, safeStorage: { isAsyncEncryptionAvailable: async () => false } }), /암호화/);
    assert.deepEqual(await fs.readdir(userData), []);
    const result = await saveSecret({ ...options, safeStorage: vault });
    assert.deepEqual(result, { configured: true });
    assert.ok(!JSON.stringify(result).includes(options.key));
  } finally { await fs.rm(userData, { recursive: true, force: true }); }
});

test('failed replacement preserves existing encrypted key and cleans temporary files', async () => {
  const userData = await fs.mkdtemp(path.join(os.tmpdir(), 'yesornot-keys-'));
  try {
    const options = { userData, fileName: 'jev-key.bin', safeStorage: vault };
    await saveSecret({ ...options, key: 'existing-ui-key' });
    const before = await fs.readFile(path.join(userData, 'jev-key.bin'));
    const failing = { ...vault, encryptStringAsync: async () => { throw new Error('new-key-never-echoed'); } };
    await assert.rejects(saveSecret({ ...options, key: 'new-key-never-echoed', safeStorage: failing }), error => !error.message.includes('new-key-never-echoed') && /기존 키/.test(error.message));
    assert.deepEqual(await fs.readFile(path.join(userData, 'jev-key.bin')), before);
    assert.deepEqual(await fs.readdir(userData), ['jev-key.bin']);
  } finally { await fs.rm(userData, { recursive: true, force: true }); }
});

test('invalid UI keys and unexpected filenames are rejected without any disk write', async () => {
  const userData = await fs.mkdtemp(path.join(os.tmpdir(), 'yesornot-keys-'));
  try {
    const options = { userData, fileName: 'jev-key.bin', safeStorage: vault };
    for (const key of ['', '   ', 'key\ninjection', 'key\rvalue', 'key\u0000value', 'contains space', '한글', 'x'.repeat(4097), null]) {
      await assert.rejects(saveSecret({ ...options, key }));
    }
    await assert.rejects(saveSecret({ ...options, key: 'valid-test-value', fileName: '../outside.bin' }), /경로/);
    assert.deepEqual(await fs.readdir(userData), []);
  } finally { await fs.rm(userData, { recursive: true, force: true }); }
});

test('saved keys can be re-encrypted without importing an older environment key', async () => {
  const userData = await fs.mkdtemp(path.join(os.tmpdir(), 'yesornot-keys-'));
  try {
    const options = { userData, fileName: 'gemini-key.bin', safeStorage: vault };
    await saveSecret({ ...options, key: 'saved-ui-key' });
    let encrypted;
    const renewingVault = { ...vault,
      decryptStringAsync: async bytes => ({ ...await vault.decryptStringAsync(bytes), shouldReEncrypt: true }),
      encryptStringAsync: async key => { encrypted = key; return vault.encryptStringAsync(key); },
    };
    const loaded = await loadSecret({ ...options, safeStorage: renewingVault, config: { GEMINI_API_KEY: 'stale-env-key' }, env: {}, keyName: 'GEMINI_API_KEY' });
    assert.equal(loaded.key, 'saved-ui-key');
    assert.equal(encrypted, 'saved-ui-key');
  } finally { await fs.rm(userData, { recursive: true, force: true }); }
});
