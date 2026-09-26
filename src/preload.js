const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('anotherAPI', {
  selectEnvironment: (env) => ipcRenderer.send('select-environment', env),

  // Noise reduction state persisted via IPC to avoid localStorage tracking
  getNoiseReductionState: () => ipcRenderer.invoke('get-noise-reduction'),
  setNoiseReduction: (enabled) => ipcRenderer.invoke('set-noise-reduction', enabled)

  // Note: AudioWorklet processor is loaded via anr:// custom protocol,
  // not via exposed filesystem path (prevents path leakage to renderer)
});