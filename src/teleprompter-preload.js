'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// The teleprompter page's whole connection to the app: the script and settings in, cues and
// settings changes out.
contextBridge.exposeInMainWorld('prompter', {
  init: () => ipcRenderer.invoke('prompter:init'),
  onContent: (callback) => ipcRenderer.on('prompter:content', (_event, content) => callback(content)),
  onSettings: (callback) => ipcRenderer.on('prompter:settings', (_event, settings) => callback(settings)),
  cue: (cue) => ipcRenderer.send('prompter:cue', cue),
  save: (patch) => ipcRenderer.send('prompter:save', patch),
  readSource: () => ipcRenderer.invoke('prompter:readScript'),
  writeSource: (text) => ipcRenderer.invoke('prompter:writeScript', text),
});
