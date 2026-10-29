'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createUpdateService } = require('../services/updates.cjs');
function fixture(options = {}) {
  const updater = new EventEmitter();
  let checks = 0, installs = [];
  updater.checkForUpdates = async () => { checks++; updater.emit('checking-for-update'); updater.emit('update-not-available', { version:'0.1.0' }); return { updateInfo:{version:'0.1.0'} }; };
  updater.quitAndInstall = (...args) => installs.push(args);
  const events=[];
  const service = createUpdateService({enabled:true,currentVersion:'0.1.0',getUpdater:()=>updater,onChange:event=>events.push(event),...options});
  return {updater,service,events,checks:()=>checks,installs};
}
test('portable or development build never loads updater or checks network', async () => {
  const service=createUpdateService({enabled:false,currentVersion:'0.1.0',getUpdater:()=>{throw new Error('must not load')}});
  service.start(); assert.equal((await service.check()).status,'disabled');
  assert.throws(()=>service.install(),/완료되지/);service.dispose();
});
test('startup checks and periodic checks use stable releases with automatic download and install-on-quit', async () => {
  let tick, cleared=false;
  const f=fixture({schedule:callback=>{tick=callback;return 1},unschedule:()=>{cleared=true}});
  f.service.start();await f.service.check();
  assert.equal(f.checks(),1);assert.equal(f.service.snapshot().status,'current');
  for (const key of ['autoDownload','autoInstallOnAppQuit','autoRunAppAfterInstall']) assert.equal(f.updater[key],true);
  for (const key of ['allowPrerelease','allowDowngrade']) assert.equal(f.updater[key],false);
  tick();await f.service.check();assert.equal(f.checks(),2);
  f.service.dispose();assert.ok(cleared);assert.equal(f.updater.listenerCount('error'),0);
});
test('concurrent checks coalesce and transient or synchronous failures remain retryable without raw secret errors', async () => {
  const f=fixture();let release;
  f.updater.checkForUpdates=()=>{ f.updater.emit('checking-for-update'); return new Promise(resolve=>{release=resolve}); };
  const first=f.service.check(),second=f.service.check();await new Promise(resolve=>setImmediate(resolve));
  release({});await Promise.all([first,second]);
  f.updater.checkForUpdates=()=>{throw new Error('token-private-failure')};
  assert.equal((await f.service.check()).status,'error');
  assert.ok(!JSON.stringify(f.service.snapshot()).includes('token-private'));
  f.updater.checkForUpdates=async()=>{f.updater.emit('update-not-available',{});return {}};
  assert.equal((await f.service.check()).status,'current');
  f.service.dispose();
});
test('download events expose bounded safe metadata and busy judgment blocks restart until complete', async () => {
  let busy=true;
  const f=fixture({isBusy:()=>busy});await f.service.check();
  f.updater.emit('update-available',{version:'0.2.0',releaseNotes:'<script>bad</script>'});
  f.updater.emit('download-progress',{percent:150});assert.equal(f.service.snapshot().progress,100);
  f.updater.emit('update-downloaded',{version:'0.2.0'});
  assert.equal(f.service.snapshot().status,'downloaded');assert.equal(f.installs.length,0);
  assert.ok(!JSON.stringify(f.service.snapshot()).includes('<script>'));
  assert.throws(()=>f.service.install(),/진행 중인 판단/);busy=false;
  assert.equal(f.service.install(),true);assert.deepEqual(f.installs,[[true,true]]);
  const before=f.checks();await f.service.check();assert.equal(f.checks(),before);
  const state=f.service.snapshot();state.status='changed';assert.equal(f.service.snapshot().status,'downloaded');
  f.service.dispose();
});
test('rejected background download is handled and becomes a retryable safe error', async () => {
  const f=fixture();f.updater.checkForUpdates=async()=>({downloadPromise:Promise.reject(new Error('private url'))});
  await f.service.check();await new Promise(resolve=>setImmediate(resolve));
  assert.equal(f.service.snapshot().status,'error');assert.ok(!JSON.stringify(f.events).includes('private url'));
  f.service.dispose();
});
