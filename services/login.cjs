'use strict';
const path = require('node:path');
const {execFile} = require('node:child_process');

const quote = text => "'" + text.replace(/'/g,"''") + "'";
function openLoginTerminal(provider, {cwd,scriptPath,env=process.env,execFileImpl=execFile} = {}) {
  if (!['claude','codex','gemini'].includes(provider)) return Promise.reject(new Error('지원하지 않는 CLI입니다.'));
  if (!path.isAbsolute(cwd || '') || !path.isAbsolute(scriptPath || '')) return Promise.reject(new Error('로그인 실행 경로가 올바르지 않습니다.'));
  const environment = {...env};
  for (const key of Object.keys(environment)) if (/(?:API_KEY$|^ELECTRON_|^NODE_OPTIONS$|^CLAUDECODE$)/i.test(key)) delete environment[key];
  const powershell = path.join(environment.SystemRoot || environment.SYSTEMROOT || 'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe');
  // The short hidden bootstrap creates a real interactive terminal with its own
  // console handles. -NoExit preserves the terminal if the CLI reports an error.
  const interactiveCommand = `& ${quote(scriptPath)} -Provider ${quote(provider)}`;
  const encoded = Buffer.from(interactiveCommand,'utf16le').toString('base64');
  const bootstrap = `$ErrorActionPreference='Stop'; $terminal = Start-Process -FilePath ${quote(powershell)} -WorkingDirectory ${quote(cwd)} -ArgumentList @('-NoProfile','-NoExit','-ExecutionPolicy','Bypass','-EncodedCommand','${encoded}') -WindowStyle Normal -PassThru; @{pid=$terminal.Id} | ConvertTo-Json -Compress`;
  return new Promise((resolve,reject) => {
    execFileImpl(powershell,['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(bootstrap,'utf16le').toString('base64')],{cwd,env:environment,windowsHide:true,timeout:15000,maxBuffer:65536},(error,stdout) => {
      if (error) return reject(new Error('로그인 터미널을 열지 못했습니다. Windows PowerShell 실행 상태를 확인하세요.'));
      try {
        const {pid} = JSON.parse(stdout.replace(/^\uFEFF/, '').trim());
        if (!Number.isSafeInteger(pid) || pid < 1) throw new Error('Missing terminal');
        resolve({launched:true,terminalPid:pid,message:`${provider === 'gemini' ? 'Gemini' : provider === 'codex' ? 'Codex' : 'Claude'} 로그인 터미널을 열었습니다. 터미널에서 로그인을 마친 후 연결을 다시 확인하세요.`});
      } catch { reject(new Error('로그인 터미널의 실행을 확인하지 못했습니다.')); }
    });
  });
}
module.exports = {openLoginTerminal};
