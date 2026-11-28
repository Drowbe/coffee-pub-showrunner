'use strict';
// Spike, question 5. Run: npx electron scripts/spike/devices.js <work folder>
// Run it twice: the device ids are compared between launches (saved profiles look a device up by id first, then by name).
const { app, BrowserWindow, ipcMain, systemPreferences } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');

app.setPath('userData', path.join(os.tmpdir(), 'showrunner-spike-devices')); // the same folder both times, so ids can be compared
const [work] = process.argv.slice(2);
app.on('window-all-closed', () => {});
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 320, height: 180, webPreferences: { nodeIntegration: true, contextIsolation: false, backgroundThrottling: false } });
  const done = new Promise((resolve) => ipcMain.once('done', (_e, v) => resolve(v)));
  await win.loadFile(path.join(__dirname, 'devices.html'));
  const out = await done;
  out.windowsSays = { camera: systemPreferences.getMediaAccessStatus('camera'), microphone: systemPreferences.getMediaAccessStatus('microphone') };
  const file = path.join(work, 'devices.json');
  if (fs.existsSync(file)) {
    const before = JSON.parse(fs.readFileSync(file, 'utf8'));
    out.idsSameAsLastRun = out.devices.every((d) => before.devices.some((b) => b.label === d.label && b.kind === d.kind && b.id === d.id));
  }
  fs.writeFileSync(file, JSON.stringify(out, null, 1));
  console.log(JSON.stringify(out, null, 1));
  app.exit(0);
});
