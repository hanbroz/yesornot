'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname,'..');
const files = ['main.cjs','preload.cjs','app.js',...['services','scripts','tests'].flatMap(dir => fs.existsSync(path.join(root,dir)) ? fs.readdirSync(path.join(root,dir)).filter(f=>/\.(c?js)$/.test(f)).map(f=>`${dir}/${f}`) : [])];
for (const file of files) {
  const result = spawnSync(process.execPath,['--check',path.join(root,file)],{ encoding:'utf8' });
  if (result.status) { process.stderr.write(result.stderr); process.exit(1); }
}
console.log(`Syntax checked ${files.length} files.`);
