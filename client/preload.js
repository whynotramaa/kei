const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('cueline', {
  setStatus: live => ipcRenderer.send('status', live),
  setMode: mode => ipcRenderer.send('mode', mode),
  onMode: cb => ipcRenderer.on('mode', (_e, mode) => cb(mode)),
  onScale: cb => ipcRenderer.on('scale', (_e, size) => cb(size)),
  onToast: cb => ipcRenderer.on('toast', (_e, text) => cb(text))
})
