'use strict';
const { contextBridge, ipcRenderer } = require('electron');
async function invoke(channel, value) {
  const response = await ipcRenderer.invoke(channel, value);
  if (!response?.ok) throw new Error(response?.error || '요청을 처리하지 못했습니다.');
  return response.value;
}
contextBridge.exposeInMainWorld('decisionApp', {
  getState: () => invoke('decision:state'),
  checkConnections: () => invoke('decision:connections'),
  saveApiKeys: payload => invoke('decision:api-keys', payload),
  getUpdateState: () => invoke('decision:update-state'),
  checkForUpdates: () => invoke('decision:update-check'),
  installUpdate: () => invoke('decision:update-install'),
  onUpdateEvent: callback => {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on('decision:update', listener);
    return () => ipcRenderer.removeListener('decision:update', listener);
  },
  startRun: payload => invoke('decision:start', payload),
  continueRun: payload => invoke('decision:continue', payload),
  pickFiles: () => invoke('decision:attachments'),
  downloadQuestionnaire: payload => invoke('decision:questionnaire-download', payload),
  uploadQuestionnaire: payload => invoke('decision:questionnaire-upload', payload),
  openSource: url => invoke('decision:source', url),
  cancelRun: () => invoke('decision:cancel'),
  saveSettings: payload => invoke('decision:settings', payload),
  login: id => invoke('decision:login', id),
  copyResult: id => invoke('decision:copy', id),
  onRunEvent: callback => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('decision:event', listener);
    return () => ipcRenderer.removeListener('decision:event', listener);
  }
});
