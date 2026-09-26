const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('anotherAPI', {
  selectEnvironment: (env) => ipcRenderer.send('select-environment', env)
});