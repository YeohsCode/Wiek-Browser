const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('vek', {
  state: () => ipcRenderer.invoke('vek:state'),
  action: (name, value) => ipcRenderer.invoke('vek:action', name, value),
  onState: callback => ipcRenderer.on('vek:state', (_, state) => callback(state)),
  onFocusAddress: callback => ipcRenderer.on('vek:focus-address', callback),
  onFindOpen: callback => ipcRenderer.on('vek:find-open', callback),
  onFindNext: callback => ipcRenderer.on('vek:find-next', (_, forward) => callback(forward)),
  onFindResult: callback => ipcRenderer.on('vek:find-result', (_, data) => callback(data)),
  onDialog: callback => ipcRenderer.on('vek:dialog', (_, data) => callback(data)),
  onHighlight: callback => ipcRenderer.on('vek:highlight', (_, point) => callback(point)),
  onOpenPanel: callback => ipcRenderer.on('vek:open-panel', (_, data) => callback(data)),
  onDraft: callback => ipcRenderer.on('vek:draft', (_, text) => callback(text)),
  onError: callback => ipcRenderer.on('vek:error', (_, text) => callback(text)),
  onSecretRequest: callback => ipcRenderer.on('vek:secret-request', (_, data) => callback(data)),
});
