'use strict';
const { contextBridge, ipcRenderer } = require('electron');

// The recording toolbar's whole connection to the app: the recorder's state and levels in, button presses and level changes out.
contextBridge.exposeInMainWorld('recbar', {
  init: () => ipcRenderer.invoke('toolbar:init'),
  onState: (callback) => ipcRenderer.on('toolbar:state', (_event, state) => callback(state)),
  onLevels: (callback) => ipcRenderer.on('toolbar:levels', (_event, levels) => callback(levels)),
  onFrame: (callback) => ipcRenderer.on('toolbar:frame', (_event, frame) => callback(frame)),
  onIdle: (callback) => ipcRenderer.on('toolbar:idle', (_event, peaks) => callback(peaks)),
  setPreview: (on) => ipcRenderer.send('toolbar:setPreview', Boolean(on)),
  action: (name) => ipcRenderer.invoke('toolbar:action', name),
  setAudio: (audio) => ipcRenderer.send('toolbar:setAudio', audio),
  size: (height) => ipcRenderer.send('toolbar:size', height),
  reveal: () => ipcRenderer.invoke('toolbar:reveal'),
  close: () => ipcRenderer.send('toolbar:close'),
});
