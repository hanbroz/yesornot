'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { parseEnv } = require('node:util');

const FORBIDDEN = /(?:^|\/)(?:\.env(?:\..*)?|(?:jev|gemini)-key\.bin|decisions(?:[^/]*)\.json|[^/]+\.(?:pfx|p12|pem|key)|\.omx|\.serena|node_modules|out|dist)(?:\/|$)/iu;
function secretIssues(name, bytes, knownSecrets = []) {
  const normalized = name.replace(/\\/gu, '/');
  const issues = [];
  if (FORBIDDEN.test(normalized) && normalized !== '.env.example') issues.push('private or generated path');
  if (knownSecrets.some(secret => secret.length >= 8 && bytes.includes(Buffer.from(secret)))) issues.push('local credential bytes');
  const text = bytes.toString('utf8');
  if (/(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,}|AIza[0-9A-Za-z_-]{35}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----)/u.test(text)) issues.push('credential pattern');
  if (normalized === '.env.example') {
    const config = parseEnv(text);
    if (Object.entries(config).some(([key, value]) => /(?:KEY|TOKEN|SECRET|PASSWORD)$/u.test(key) && value.trim())) issues.push('nonempty example credential');
  }
  return issues;
}
function git(args) {
  const result = spawnSync('git', args, { encoding: null, maxBuffer: 64 * 1024 * 1024, windowsHide: true });
  if (result.status !== 0) throw new Error('Git index could not be inspected.');
  return result.stdout;
}
function checkStaged() {
  let local = {};
  try { local = parseEnv(fs.readFileSync(path.resolve(__dirname, '../.env'), 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw new Error('Local credential scan could not initialize.'); }
  const known = Object.entries(local).filter(([key]) => /(?:KEY|TOKEN|SECRET|PASSWORD)$/u.test(key)).map(([, value]) => value.trim()).filter(Boolean);
  const files = git(['diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z']).toString('utf8').split('\0').filter(Boolean);
  const failures = [];
  for (const name of files) {
    if (secretIssues(name, git(['show', ':' + name]), known).length) failures.push(name);
  }
  if (failures.length) throw new Error(`Secret check rejected ${failures.length} staged file(s). No credential values were printed.`);
  console.log(`Secret check passed: ${files.length} staged files, forbidden paths and credential bytes excluded.`);
}
if (require.main === module) {
  try { checkStaged(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = { secretIssues };
