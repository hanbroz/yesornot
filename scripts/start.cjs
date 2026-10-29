'use strict';
const { spawn } = require('node:child_process');
const path = require('node:path');
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(require('electron'), [path.resolve(__dirname,'..')], { env,stdio:'inherit' });
child.once('error', () => { console.error('Electron 실행에 실패했습니다. npm install --allow-scripts=electron 명령으로 설치를 확인하세요.');process.exitCode=1; });
child.once('exit', code => { process.exitCode=code || 0; });
