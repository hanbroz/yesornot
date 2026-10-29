'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { build, Platform, Arch } = require('electron-builder');
const { listPackage, statFile, extractFile } = require('@electron/asar');
const { createBuildInfo } = require('../services/build-version.cjs');
const config = require('../electron-builder.config.cjs');
const root = path.resolve(__dirname, '..');

function privatePath(file) {
  return file.split(/[\\/]/u).some(part => /^\.env(?:\.|$)/iu.test(part) || /^(?:jev|gemini)-key\.bin$/iu.test(part) || /^(?:decisions\.json|\.omx|\.codex|\.git)$/iu.test(part));
}

async function validatePayload(appOutDir) {
  const archive = path.join(appOutDir, 'resources', 'app.asar');
  const files = listPackage(archive).map(file => file.replace(/\\/gu, '/'));
  if (files.some(privatePath)) throw new Error('Private configuration or user data found in installer payload.');
  const required = ['main.cjs', 'preload.cjs', 'index.html', 'app.js', 'styles.css', 'build-info.json', 'services/updates.cjs', 'node_modules/electron-updater/package.json'];
  for (const file of required) if (!files.includes('/' + file)) throw new Error('Installer payload is missing runtime file: ' + file);
  // Check known local key values without printing or copying them to artifacts.
  let localConfig = {};
  try { localConfig = require('node:util').parseEnv(await fs.readFile(path.join(root, '.env'), 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const secrets = [localConfig.JEV_API_KEY, localConfig.GEMINI_API_KEY, process.env.JEV_API_KEY, process.env.GEMINI_API_KEY].filter(value => typeof value === 'string' && value.trim()).map(value => Buffer.from(value.trim()));
  for (const file of files) {
    const entry = path.normalize(file.slice(1));
    if (statFile(archive, entry).files) continue;
    const bytes = extractFile(archive, entry);
    if (secrets.some(secret => bytes.includes(secret))) throw new Error('A local API key was found in installer payload.');
  }
  const feed = await fs.readFile(path.join(appOutDir, 'resources', 'app-update.yml'), 'utf8');
  if (!feed.includes('owner: hanbroz') || !feed.includes('repo: yesornot')) throw new Error('Unexpected automatic update repository.');
}

async function main() {
  const stampPath = path.join(root, 'build-info.json');
  let previous;
  try { previous = await fs.readFile(stampPath); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  await fs.writeFile(stampPath, JSON.stringify(createBuildInfo(), null, 2));
  try {
    await build({ projectDir: root, config: { ...config, afterPack: context => validatePayload(context.appOutDir) }, targets: Platform.WINDOWS.createTarget(['nsis'], Arch.x64), publish: 'never' });
    const pkg = require('../package.json');
    const names = [`YESORNOT-Setup-${pkg.version}.exe`, `YESORNOT-Setup-${pkg.version}.exe.blockmap`, 'latest.yml'];
    const sums = [];
    for (const name of names) {
      const bytes = await fs.readFile(path.join(root, 'dist', name));
      sums.push(createHash('sha256').update(bytes).digest('hex') + '  ' + name);
    }
    await fs.writeFile(path.join(root, 'dist', 'SHA256SUMS.txt'), sums.join('\n') + '\n');
    console.log('Locally built Windows installer and GitHub update metadata. No files were published.');
  } finally {
    if (previous) await fs.writeFile(stampPath, previous);
    else await fs.unlink(stampPath);
  }
}

if (require.main === module) main().catch(error => { console.error(error.message); process.exit(1); });
module.exports = { privatePath, validatePayload };
