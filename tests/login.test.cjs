'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const {openLoginTerminal} = require('../services/login.cjs');
const cwd=path.resolve('test workspace');
const scriptPath=path.resolve("test workspace/한글 user's scripts/login.ps1");
test('login opens a visible interactive terminal and preserves literal spaced Unicode paths',async()=>{
 const result=await openLoginTerminal('gemini',{cwd,scriptPath,env:{SystemRoot:'C:\\Windows',PATH:'safe',JEV_API_KEY:'private',GEMINI_API_KEY:'private',ELECTRON_RUN_AS_NODE:'1',NODE_OPTIONS:'bad'},execFileImpl:(file,args,options,callback)=>{
  const bootstrap=Buffer.from(args.at(-1),'base64').toString('utf16le');
  assert.match(bootstrap,/-WindowStyle Normal/);assert.match(bootstrap,/'-NoExit'/);
  const encoded=bootstrap.match(/'-EncodedCommand','([^']+)'/)[1];
  const command=Buffer.from(encoded,'base64').toString('utf16le');
  assert.ok(command.includes(scriptPath.replace(/'/g,"''")));assert.match(command,/-Provider 'gemini'/);
  assert.equal(options.windowsHide,true);assert.equal(options.env.PATH,'safe');
  for(const name of ['JEV_API_KEY','GEMINI_API_KEY','ELECTRON_RUN_AS_NODE','NODE_OPTIONS'])assert.equal(options.env[name],undefined);
  callback(null,'{"pid":1234}\r\n');
 }});
 assert.equal(result.terminalPid,1234);assert.equal(result.launched,true);
});
test('invalid providers never start a command; launch failures do not claim success',async()=>{
 let called=false;const execFileImpl=()=>{called=true;};
 await assert.rejects(openLoginTerminal('gemini;evil',{cwd,scriptPath,execFileImpl}));assert.equal(called,false);
 for(const stdout of ['','garbage','{"pid":0}'])await assert.rejects(openLoginTerminal('gemini',{cwd,scriptPath,execFileImpl:(_f,_a,_o,cb)=>cb(null,stdout)}),/확인/);
 await assert.rejects(openLoginTerminal('gemini',{cwd,scriptPath,execFileImpl:(_f,_a,_o,cb)=>cb(new Error('secret detail'))}),/열지 못/);
});
