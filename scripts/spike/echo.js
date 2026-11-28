'use strict';
// Spike, question 5. Run: npx electron scripts/spike/echo.js <part of speaker name> <part of microphone name>
// Makes sound out loud for about a minute.
const { app, BrowserWindow, ipcMain } = require('electron');
const os = require('os');
const path = require('path');

app.setPath('userData', path.join(os.tmpdir(), 'showrunner-spike-devices'));
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
app.commandLine.appendSwitch('disable-features', 'AudioServiceOutOfProcess'); // as src/main.js
const [speaker, mic] = process.argv.slice(2);
app.on('window-all-closed', () => {});
app.whenReady().then(async () => {
  ipcMain.handle('what', () => ({ speaker, mic }));
  const done = new Promise((resolve) => ipcMain.once('done', (_e, v) => resolve(v)));
  const win = new BrowserWindow({ show: false, width: 320, height: 180, webPreferences: { nodeIntegration: true, contextIsolation: false, backgroundThrottling: false } });
  await win.loadFile(path.join(__dirname, 'echo.html'));
  console.log(JSON.stringify(await done, null, 1));
  app.exit(0);
});
