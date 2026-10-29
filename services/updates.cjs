'use strict';

// The installed NSIS build supplies resources/app-update.yml. Development and
// portable builds never load the updater or replace their executable in place.
function createUpdateService({ enabled, currentVersion, getUpdater, isBusy = () => false, onChange = () => {}, intervalMs = 6 * 60 * 60 * 1000, schedule = setInterval, unschedule = clearInterval }) {
  let state = { status: enabled ? 'idle' : 'disabled', currentVersion, message: enabled ? '새 릴리즈를 자동 확인합니다. 다운로드한 업데이트는 앱 종료 시 적용됩니다.' : '자동 업데이트는 Windows 설치형 앱에서 사용할 수 있습니다.' };
  let updater, pending, timer, disposed = false;
  const listeners = [];
  const snapshot = () => structuredClone(state);
  const publish = patch => { if (!disposed) { state = { ...state, ...patch }; onChange(snapshot()); } };
  const errorState = () => publish({ status: 'error', progress: undefined, message: '업데이트를 확인하거나 다운로드하지 못했습니다. 잠시 후 다시 확인하세요.' });
  function initialize() {
    if (updater) return updater;
    updater = getUpdater();
    updater.logger = null;
    updater.autoDownload = true;
    updater.autoInstallOnAppQuit = true;
    updater.autoRunAppAfterInstall = true;
    updater.allowPrerelease = false;
    updater.allowDowngrade = false;
    const on = (event, callback) => { updater.on(event, callback); listeners.push([event, callback]); };
    const version = info => typeof info?.version === 'string' && /^\d+\.\d+\.\d+(?:[-+][a-zA-Z0-9.-]+)?$/.test(info.version) ? info.version.slice(0, 100) : undefined;
    on('checking-for-update', () => publish({ status: 'checking', progress: undefined, message: 'GitHub에서 새 릴리즈를 확인하고 있습니다.' }));
    on('update-available', info => publish({ status: 'available', availableVersion: version(info), message: '새 버전을 찾았습니다. 자동으로 다운로드합니다.' }));
    on('update-not-available', () => publish({ status: 'current', availableVersion: undefined, progress: undefined, message: '최신 버전을 사용하고 있습니다.' }));
    on('download-progress', progress => publish({ status: 'downloading', progress: Number.isFinite(progress?.percent) ? Math.min(100, Math.max(0, progress.percent)) : 0, message: '업데이트를 다운로드하고 있습니다. 작업을 계속할 수 있습니다.' }));
    on('update-downloaded', info => publish({ status: 'downloaded', availableVersion: version(info), progress: 100, message: '다운로드 완료. 앱을 종료하면 업데이트가 적용됩니다. 지금 재시작할 수도 있습니다.' }));
    on('error', errorState);
    return updater;
  }
  async function check() {
    if (!enabled || disposed || ['available', 'downloading', 'downloaded'].includes(state.status)) return snapshot();
    if (pending) return pending;
    pending = Promise.resolve().then(async () => {
      try {
        const result = await initialize().checkForUpdates();
        // Downloads complete independently of the metadata check.
        result?.downloadPromise?.catch(errorState);
      } catch { errorState(); }
      return snapshot();
    }).finally(() => { pending = null; });
    return pending;
  }
  function install() {
    if (!enabled || state.status !== 'downloaded') throw new Error('설치할 업데이트 다운로드가 완료되지 않았습니다.');
    if (isBusy()) throw new Error('진행 중인 판단이 끝난 뒤 업데이트를 적용하세요.');
    initialize().quitAndInstall(true, true);
    return true;
  }
  function start() {
    if (!enabled || disposed || timer) return;
    void check();
    timer = schedule(() => { void check(); }, intervalMs);
    timer?.unref?.();
  }
  function dispose() {
    disposed = true;
    if (timer) unschedule(timer);
    timer = null;
    for (const [event, callback] of listeners) updater.removeListener(event, callback);
    listeners.length = 0;
  }
  return { snapshot, check, install, start, dispose };
}

module.exports = { createUpdateService };
