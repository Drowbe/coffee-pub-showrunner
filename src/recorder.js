'use strict';
// The built-in recorder: records Showrunner's own windows to an MP4, with no OBS. It reads each window's picture with capturePage(),
// hands the frames to a hidden recorder window that lays them out and encodes (src/recorder/), and writes the chunks to disk as they
// arrive. Audio comes from a small copy of each page's own sound (src/recorder/tap-preload.js). See documentation/plans/plan-recording.md.
const { BrowserWindow, ipcMain } = require('electron');
const { EventEmitter } = require('events');
const fs = require('fs');
const path = require('path');

const pad = (n) => String(n).padStart(2, '0');

function defaultFileName(date = new Date()) {
  return `Showrunner ${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}.mp4`;
}

class BuiltInRecorder extends EventEmitter {
  // getSources(ids) returns the webContents to record, in order; folderFor() the folder to write to.
  constructor({ getSources, folderFor }) {
    super();
    this.getSources = getSources;
    this.folderFor = folderFor;
    this.state = 'idle'; // idle | starting | recording | paused | stopping
    this.window = null;
    this.fd = null;
    this.pending = 0;
    this.file = '';
    this.startedAt = 0;
    this.pausedAt = 0;
    this.pausedTotal = 0;
    this.grabbers = [];
    this.error = '';
    // The recorder page sends each piece of the MP4 with the position it belongs at; they are written straight to the file.
    ipcMain.on('recorder:write', (e, { data, position }) => {
      if (this.fd === null || !this.window || e.sender !== this.window.webContents) return;
      const buf = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
      this.pending += 1;
      fs.write(this.fd, buf, 0, buf.length, position, (err) => { this.pending -= 1; if (err && !this.error) this.error = `Could not write the recording: ${err.message}`; });
    });
    ipcMain.on('recorder:failed', (_e, message) => { this.error = message; this.emit('status'); });
    ipcMain.on('recorder:audio', (e, msg) => {
      if (this.state !== 'recording' || !this.window || this.window.isDestroyed()) return;
      this.window.webContents.send('audio', { key: `${e.sender.id}:${msg.id}`, l: msg.l, r: msg.r, rate: msg.rate });
    });
  }

  get active() { return this.state !== 'idle'; }

  seconds() {
    if (!this.startedAt) return 0;
    const end = this.state === 'paused' ? this.pausedAt : Date.now();
    return Math.max(0, Math.round((end - this.startedAt - this.pausedTotal) / 1000));
  }

  status() {
    return { state: this.state, seconds: this.seconds(), file: this.file, error: this.error };
  }

  setSourcesAudio(enabled) {
    for (const wc of this.sourceContents || []) if (!wc.isDestroyed()) wc.send('recorder:tap', enabled);
  }

  async start(settings) {
    if (this.state !== 'idle') throw new Error('The built-in recorder is already recording.');
    this.error = '';
    const sources = this.getSources(settings.sources);
    if (!sources.length) throw new Error('Choose a window to record first (Recording page), and open it.');
    const folder = this.folderFor(settings.folder);
    fs.mkdirSync(folder, { recursive: true });
    this.file = path.join(folder, defaultFileName());
    this.state = 'starting';
    this.emit('status');
    try {
      this.fd = fs.openSync(this.file, 'w');
      this.window = new BrowserWindow({ show: false, width: 320, height: 180, webPreferences: { nodeIntegration: true, contextIsolation: false, backgroundThrottling: false, autoplayPolicy: 'no-user-gesture-required' } });
      await this.window.loadFile(path.join(__dirname, 'recorder', 'index.html'));
      const started = new Promise((resolve) => ipcMain.once('recorder:started', (_e, v) => resolve(v)));
      this.window.webContents.send('start', { layout: settings.layout, width: settings.width, height: settings.height, fps: settings.fps });
      const result = await started;
      if (!result.ok) throw new Error(result.error || 'The recorder could not start.');
    } catch (err) {
      await this.cleanup();
      this.error = err.message;
      this.emit('status');
      throw err;
    }
    this.sourceContents = sources;
    this.startedAt = Date.now(); this.pausedTotal = 0; this.pausedAt = 0;
    this.state = 'recording';
    this.setSourcesAudio(true);
    // One picture at a time per window: ask again as soon as the last one lands, no faster than the frame rate.
    sources.forEach((wc, index) => {
      let busy = false;
      const timer = setInterval(async () => {
        if (busy || this.state !== 'recording' || wc.isDestroyed() || !this.window || this.window.isDestroyed()) return;
        busy = true;
        try {
          const image = await wc.capturePage();
          const size = image.getSize();
          if (size.width && size.height && this.state === 'recording' && this.window && !this.window.isDestroyed()) {
            this.window.webContents.send('frame', { i: index, w: size.width, h: size.height, buf: image.toBitmap() });
          }
        } catch (err) { /* the window is closing or reloading: the next picture will do */ } finally { busy = false; }
      }, 1000 / settings.fps);
      this.grabbers.push(timer);
    });
    this.ticker = setInterval(() => this.emit('status'), 1000);
    this.emit('status');
  }

  pause() {
    if (this.state !== 'recording') throw new Error('Nothing is recording.');
    this.window.webContents.send('pause');
    this.state = 'paused'; this.pausedAt = Date.now();
    this.emit('status');
  }

  resume() {
    if (this.state !== 'paused') throw new Error('The recording is not paused.');
    this.window.webContents.send('resume');
    this.pausedTotal += Date.now() - this.pausedAt;
    this.state = 'recording';
    this.emit('status');
  }

  async stop() {
    if (this.state !== 'recording' && this.state !== 'paused') throw new Error('Nothing is recording.');
    const file = this.file;
    this.state = 'stopping';
    this.emit('status');
    this.grabbers.forEach(clearInterval); this.grabbers = [];
    clearInterval(this.ticker);
    this.setSourcesAudio(false);
    try {
      const stopped = new Promise((resolve) => ipcMain.once('recorder:stopped', resolve));
      this.window.webContents.send('stop');
      await Promise.race([stopped, new Promise((_r, reject) => setTimeout(() => reject(new Error('The recorder did not finish.')), 30000))]);
    } finally {
      await this.cleanup();
    }
    this.emit('recording', file); // the same event OBS raises, so "upload the recording" finds this file
    this.emit('status');
    return file;
  }

  async cleanup() {
    this.grabbers.forEach(clearInterval); this.grabbers = [];
    clearInterval(this.ticker);
    if (this.fd !== null) {
      for (let waited = 0; this.pending > 0 && waited < 100; waited += 1) await new Promise((resolve) => setTimeout(resolve, 50)); // let the last writes land
      fs.closeSync(this.fd); this.fd = null;
    }
    if (this.window && !this.window.isDestroyed()) this.window.destroy();
    this.window = null;
    this.state = 'idle';
    this.startedAt = 0;
  }
}

module.exports = { BuiltInRecorder, defaultFileName };
