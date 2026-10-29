'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const {parseEnv} = require('node:util');
const {createHash} = require('node:crypto');
const {spawnSync} = require('node:child_process');
const root=path.resolve(__dirname,'..');
const output=path.join(root,'out','YESORNOT-win32-x64');
(async()=>{
 const config=parseEnv(await fs.readFile(path.join(root,'.env'),'utf8'));
 const keys=[config.JEV_API_KEY?.trim(),config.GEMINI_API_KEY?.trim()].filter(Boolean);
 if(!keys.length)throw new Error('No local key available for leakage check');
 const manifest=JSON.parse(await fs.readFile(path.join(root,'.omx/reviews/package-manifest.json'),'utf8'));
 const appDir=path.join(output,'resources','app');
 for(const [name,hash] of Object.entries(manifest.files)){
  const bytes=await fs.readFile(path.join(appDir,name));
  if(createHash('sha256').update(bytes).digest('hex')!==hash)throw new Error('Package hash mismatch');
  if(keys.some(key=>bytes.includes(Buffer.from(key))))throw new Error('Private key detected in application payload');
 }
 // Explicit repeat-build regression: an EXE-adjacent credential must fail before copying.
 const checks=[];
 for(const relative of ['.env.packaging-sentinel','resources/app.asar','resources/app/gemini-key.bin','resources/app/jev-key.bin','.ENV.packaging-sentinel','resources/APP.ASAR','resources/app/GEMINI-KEY.BIN']){
  const file=path.join(output,relative);
  try{
   await fs.writeFile(file,'non-secret verification sentinel',{flag:'wx'});
   const result=spawnSync(process.execPath,[path.join(root,'scripts/package.cjs')],{encoding:'utf8'});
   if(result.status!==1 || !result.stderr.includes('Remove private or stale payload'))throw new Error('Stale payload protection did not reject');
   checks.push(relative);
  }finally{await fs.unlink(file);}
 }
 await fs.writeFile(path.join(root,'.omx/reviews/package-verification.json'),JSON.stringify({verifiedAt:new Date().toISOString(),manifestFiles:Object.keys(manifest.files).length,matchingHashes:true,noKeyInPayload:true,rejectedStalePayloads:checks,executable:path.join(output,'YESORNOT.exe')},null,2));
 console.log('Package hashes, private-key exclusion and stale-payload rejection passed.');
})().catch(error=>{console.error(error.message);process.exitCode=1;});
