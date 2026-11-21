const { contextBridge, ipcRenderer } = require('electron');

// Selector de pantalla: recibe la lista de fuentes y devuelve el id elegido (o null).
contextBridge.exposeInMainWorld('displayPicker', {
  onSources: (cb) => ipcRenderer.on('display-picker:sources', (_e, list) => cb(list)),
  choose: (id) => ipcRenderer.send('display-picker:choose', String(id)),
  cancel: () => ipcRenderer.send('display-picker:choose', null)
});
