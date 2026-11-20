const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('reader', {
  getVersion: () => ipcRenderer.invoke('app:version'),
  readSubscriptions: () => ipcRenderer.invoke('subscriptions:read'),
  fetchFeed: (address, validators) => ipcRenderer.invoke('feed:fetch', address, validators),
  readFeedCache: address => ipcRenderer.invoke('feed:cache-read', address),
  writeFeedCache: (address, data) => ipcRenderer.invoke('feed:cache-write', address, data),
  openArticle: address => ipcRenderer.invoke('article:open', address),
  windowCommand: command => ipcRenderer.send('window:command', command),
  onWindowState: callback => ipcRenderer.on('window:state', (_event, maximized, focused) => callback(maximized, focused))
});
