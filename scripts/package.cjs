'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { createBuildInfo } = require('../services/build-version.cjs');
const root = path.resolve(__dirname,'..');
const output = path.join(root,'out','YESORNOT-win32-x64');
const allowlist = ['index.html','styles.css','fonts','app.js','main.cjs','preload.cjs','services','scripts/login.ps1','assets/app-icon.png','assets/app-icon.ico'];
(async () => {
  // Fixed target beneath this workspace; never recursively remove a computed external path.
  if (path.dirname(output) !== path.join(root,'out')) throw new Error('Invalid output path');
  async function rejectStaleSecrets(dir) {
    let entries; try { entries = await fs.readdir(dir,{ withFileTypes:true }); } catch(error) { if(error.code==='ENOENT')return;throw error; }
    for (const entry of entries) {
      const item = path.join(dir,entry.name);
      const lowerName = entry.name.toLowerCase();
      if (lowerName.startsWith('.env') || /^(jev|gemini)-key\.bin$/.test(lowerName) || lowerName === 'app.asar') throw new Error(`Remove private or stale payload before packaging: ${path.relative(root,item)}`);
      if (entry.isDirectory()) await rejectStaleSecrets(item);
    }
  }
  await rejectStaleSecrets(output);
  await fs.mkdir(output,{ recursive:true });
  await fs.cp(path.join(root,'node_modules','electron','dist'),output,{ recursive:true,force:true });
  // Windows may briefly retain image/antivirus handles after the old app exits.
  for (let attempt = 0; ; attempt++) {
    try {
      await fs.rename(path.join(output,'electron.exe'),path.join(output,'YESORNOT.exe'));
      break;
    } catch (error) {
      if (!['EPERM','EACCES','EBUSY'].includes(error.code) || attempt >= 30) throw error;
      await new Promise(resolve => setTimeout(resolve,200));
    }
  }
  const iconResult = spawnSync('powershell.exe', ['-NoProfile','-ExecutionPolicy','Bypass','-File',path.join(root,'scripts','set-icon.ps1'),'-ExecutablePath',path.join(output,'YESORNOT.exe'),'-IconPath',path.join(root,'assets','app-icon.ico')], { encoding:'utf8', windowsHide:true });
  if (iconResult.error || iconResult.status !== 0) throw new Error(`Could not embed app icon: ${iconResult.error?.message || iconResult.stderr || iconResult.stdout}`);
  const appDir = path.join(output,'resources','app');
  // Clear only our known app payload to prevent stale or secret files in repeated builds.
  await fs.rm(appDir,{ recursive:true,force:true });
  await fs.mkdir(appDir,{ recursive:true });
  const hashes = {};
  for (const entry of allowlist) {
    await fs.mkdir(path.dirname(path.join(appDir,entry)),{ recursive:true });
    await fs.cp(path.join(root,entry),path.join(appDir,entry),{ recursive:true });
  }
  const pkg = JSON.parse(await fs.readFile(path.join(root,'package.json'),'utf8'));
  await fs.writeFile(path.join(appDir,'package.json'),JSON.stringify({ name:pkg.name,productName:pkg.productName,version:pkg.version,main:pkg.main },null,2));
  const buildInfo = createBuildInfo();
  await fs.writeFile(path.join(appDir,'build-info.json'),JSON.stringify(buildInfo,null,2));
  async function inventory(dir) {
    for (const entry of await fs.readdir(dir,{ withFileTypes:true })) {
      const file = path.join(dir,entry.name);
      if (entry.isDirectory()) await inventory(file);
      else {
        if (entry.name.toLowerCase().startsWith('.env')) throw new Error('Secret file in package');
        hashes[path.relative(appDir,file)] = createHash('sha256').update(await fs.readFile(file)).digest('hex');
      }
    }
  }
  await inventory(appDir);
  await rejectStaleSecrets(output);
  await fs.writeFile(path.join(root,'.omx','reviews','package-manifest.json'),JSON.stringify({ version:pkg.version,buildVersion:buildInfo.buildVersion,electron:pkg.devDependencies.electron,createdAt:buildInfo.builtAt,files:hashes },null,2));
  console.log(`Packaged: ${path.join(output,'YESORNOT.exe')} (${Object.keys(hashes).length} app files; no .env)`);
})().catch(error=>{ console.error(error.message);process.exitCode=1; });
