'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { formatBuildVersion, createBuildInfo, readBuildInfo } = require('../services/build-version.cjs');

test('build version uses Seoul time with zero padding and midnight date/year rollover', () => {
  assert.equal(formatBuildVersion(new Date('2026-10-26T00:02:03.456Z')), '2026.10.26.09.02.03');
  assert.equal(formatBuildVersion(new Date('2025-12-31T15:00:00.000Z')), '2026.01.01.00.00.00');
  assert.equal(formatBuildVersion(new Date('2026-02-28T14:59:59.999Z')), '2026.02.28.23.59.59');
  assert.equal(formatBuildVersion(new Date('2026-02-28T15:00:00.000Z')), '2026.03.01.00.00.00');
});

test('invalid build dates are rejected instead of becoming version strings', () => {
  assert.throws(() => formatBuildVersion(new Date('invalid')), TypeError);
  assert.throws(() => formatBuildVersion('2026-10-26'), TypeError);
  assert.throws(() => formatBuildVersion(new Date('0999-01-01T00:00:00.000Z')), RangeError);
});

test('metadata remains the original packaged timestamp and exposes immutable validated fields', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'yesornot-build-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const info = createBuildInfo(new Date('2026-10-26T00:02:03.456Z'));
  fs.writeFileSync(path.join(directory, 'build-info.json'), JSON.stringify({ ...info, ignored: 'extra field' }));
  const restored = readBuildInfo(directory);
  assert.deepEqual(restored, info);
  assert.equal(restored.buildVersion, '2026.10.26.09.02.03');
  assert.equal(Object.isFrozen(info), true);
  assert.equal(Object.isFrozen(restored), true);
  assert.equal(restored.ignored, undefined);
});

test('missing, malformed, mismatching, or unsupported metadata is unavailable without inventing a version', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'yesornot-build-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  assert.equal(readBuildInfo(directory), null);
  const info = createBuildInfo(new Date('2026-10-26T00:02:03.456Z'));
  for (const candidate of [
    '{', 'null', '[]',
    JSON.stringify({ ...info, schemaVersion: 2 }),
    JSON.stringify({ ...info, timeZone: 'UTC' }),
    JSON.stringify({ ...info, builtAt: 'invalid' }),
    JSON.stringify({ ...info, builtAt: '2026-10-26T00:02:03Z' }),
    JSON.stringify({ ...info, buildVersion: '2026.10.26.00.02.03' }),
    JSON.stringify({ ...info, buildVersion: '<script>' }),
  ]) {
    fs.writeFileSync(path.join(directory, 'build-info.json'), candidate);
    assert.equal(readBuildInfo(directory), null);
  }
});
