'use strict';
// The built-in recorder: records Showrunner's own windows to an MP4, with no OBS. It reads each window's picture with capturePage(),
// hands the frames to a hidden recorder window that lays them out and encodes (src/recorder/), and writes the chunks to disk as they
// arrive. Audio comes from a small copy of each page's own sound (src/recorder/tap-preload.js). See documentation/plans/plan-recording.md.
const { BrowserWindow, ipcMain, systemPreferences } = require('electron');
const { EventEmitter } = require('events');
const fs = require('fs');
const path = require('path');
const { uniquePath, defaultName } = require('./filename');

const SPACE_MIN = 1e9; // will not start with less than this free
const SPACE_WARN = 3e9; // warn below this
const SPACE_STOP = 3e8; // stop (and keep the file) below this

const pad = (n) => String(n).padStart(2, '0');

function defaultFileName(date = new Date()) {
  return `Showrunner ${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}.mp4`;
}

class BuiltInRecorder extends EventEmitter {
  // getSources(ids) returns the webContents to record, in order; folderFor() the folder to write to.
  constructor({ getSources, folderFor, nameFor, markerFile, windowName }) {
    super();
    this.getSources = getSources;
    this.folderFor = folderFor;
    this.nameFor = nameFor || (() => defaultName());
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
    this.warning = '';
    this.interrupted = null; // { file } when the app closed in the middle of a recording last time
    this.markerFile = markerFile || '';
    this.windowName = windowName || ((id) => id);
    this.heard = [false, false]; // whether any sound has arrived from each chosen window
    this.soundNote = '';
    this.runSeconds = 0;
    this.monitorIds = []; // windows whose loudness is being watched for the meters while not recording
    this.monitorWcs = [];
    this.idlePeaks = [0, 0];
    this.idleTimer = null;
    this.spaceChecks = 0;
    // The recorder page sends each piece of the MP4 with the position it belongs at; they are written straight to the file.
    ipcMain.on('recorder:write', (e, { data, position }) => {
      if (this.fd === null || !this.window || e.sender !== this.window.webContents) return;
      const buf = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
      this.pending += 1;
      fs.write(this.fd, buf, 0, buf.length, position, (err) => { this.pending -= 1; if (err && !this.error) this.error = `Could not write the recording: ${err.message}`; });
    });
    ipcMain.on('recorder:levels', (_e, levels) => { this.levels = levels; this.emit('levels', levels); });
    // What kind of sound each page plays, as found by its preload: written to the activity log, to see what a page does.
    ipcMain.on('recorder:tapinfo', (e, text) => this.emit('tapinfo', e.sender.id, String(text)));
    ipcMain.on('recorder:peak', (e, peak) => {
      const i = this.monitorWcs.findIndex((wc) => wc.id === e.sender.id);
      if (i >= 0 && Number.isFinite(peak)) this.idlePeaks[i] = Math.max(this.idlePeaks[i], peak);
    });
    ipcMain.on('recorder:failed', (_e, message) => { this.error = message; this.emit('status'); });
    ipcMain.on('recorder:audio', (e, msg) => {
      if (this.state !== 'recording' || !this.window || this.window.isDestroyed()) return;
      const win = (this.sourceContents || []).findIndex((wc) => wc.id === e.sender.id); // which chosen window this sound came from
      if (win >= 0) this.heard[win] = true;
      this.window.webContents.send('audio', { key: `${e.sender.id}:${msg.id}`, win: Math.max(0, win), l: msg.l, r: msg.r, rate: msg.rate });
    });
  }

  get active() { return this.state !== 'idle'; }

  seconds() {
    if (!this.startedAt) return 0;
    const end = this.state === 'paused' ? this.pausedAt : Date.now();
    return Math.max(0, Math.round((end - this.startedAt - this.pausedTotal) / 1000));
  }

  status() {
    return { state: this.state, seconds: this.seconds(), file: this.file, error: this.error, warning: [this.soundNote, this.warning].filter(Boolean).join('  '), interrupted: this.interrupted };
  }

  // A note is left while a recording runs and removed when it ends cleanly. If it is still there at the next launch, the app closed in
  // the middle of a recording; the file is still playable (it is written as it records) and the person is told where it is.
  takeInterrupted() {
    if (!this.markerFile) return null;
    try {
      const { file } = JSON.parse(fs.readFileSync(this.markerFile, 'utf8'));
      fs.unlinkSync(this.markerFile);
      if (file && fs.existsSync(file) && fs.statSync(file).size > 0) { this.interrupted = { file }; return this.interrupted; }
    } catch (err) { /* no note: nothing was interrupted */ }
    return null;
  }

  writeMarker() { if (this.markerFile) try { fs.writeFileSync(this.markerFile, JSON.stringify({ file: this.file, at: Date.now() })); } catch (err) { /* not fatal */ } }
  clearMarker() { if (this.markerFile) try { fs.unlinkSync(this.markerFile); } catch (err) { /* already gone */ } }

  freeBytes(folder) {
    try { const st = fs.statfsSync(folder); return Number(st.bavail) * Number(st.bsize); } catch (err) { return Infinity; }
  }

  // Checked every few seconds while recording: warns when space is getting short, and stops cleanly before the disk is full.
  checkSpace() {
    const free = this.freeBytes(path.dirname(this.file));
    const gb = free / 1e9;
    if (free < SPACE_STOP) {
      this.error = 'Stopped: the disk is nearly full. The recording so far is saved.';
      this.warning = '';
      this.stop().catch(() => {});
      return;
    }
    if (free < SPACE_WARN) {
      let left = '';
      const secs = this.seconds();
      try {
        const rate = fs.statSync(this.file).size / Math.max(1, secs); // bytes a second so far
        if (secs > 20 && rate > 0) left = `, about ${Math.max(1, Math.round(free / rate / 60))} min of recording`;
      } catch (err) { /* no estimate */ }
      this.warning = `Disk space is low: ${gb.toFixed(1)} GB left${left}.`;
    } else this.warning = '';
  }

  // Eight seconds in (and from then on), name any chosen window that has sent no sound at all, so a recording with a silent window is
  // noticed while it can still be fixed. It cannot tell "nothing is playing" from "plays in a way that cannot be copied", so it says both.
  checkSound() {
    if (this.state !== 'recording') return;
    this.runSeconds += 1;
    if (this.runSeconds < 8) return;
    const silent = (this.settingsSources || []).map((id, i) => ({ id, i })).filter(({ id, i }) => id && !this.heard[i] && !(this.audioSettings && this.audioSettings.windows[i].muted)).map(({ id }) => this.windowName(id));
    this.soundNote = silent.length ? `No sound from ${silent.join(' or ')} yet. Nothing may be playing there, or it plays in a way Showrunner cannot copy.` : '';
  }

  // Watches how loud each chosen window is, so the meters on the recorder page move before any recording. Pass the window ids, or
  // nothing to stop. It does nothing while recording (the recorder reports its own levels then) and picks up again afterwards.
  monitor(ids) {
    this.monitorIds = ids || [];
    if (this.active) return;
    const next = this.monitorIds.length ? this.getSources(this.monitorIds) : [];
    for (const wc of this.monitorWcs) if (!next.includes(wc) && !wc.isDestroyed()) wc.send('recorder:tap', false);
    for (const wc of next) if (!wc.isDestroyed()) wc.send('recorder:tap', 'meter');
    this.monitorWcs = next;
    if (next.length && !this.idleTimer) {
      this.idleTimer = setInterval(() => {
        if (this.active) return;
        this.emit('idle', this.idlePeaks.slice());
        this.idlePeaks = [0, 0];
      }, 100);
    } else if (!next.length && this.idleTimer) { clearInterval(this.idleTimer); this.idleTimer = null; this.emit('idle', [0, 0]); }
  }

  setSourcesAudio(enabled) {
    for (const wc of this.sourceContents || []) if (!wc.isDestroyed()) wc.send('recorder:tap', enabled);
  }

  // macOS asks the person once, then remembers. Returns quietly when it is allowed; throws a plain message when it is not.
  async allowMicrophone() { return this.allowAccess('microphone', 'the microphone', 'Microphone'); }
  async allowCamera() { return this.allowAccess('camera', 'the webcam', 'Camera'); }
  async allowAccess(kind, what, pane) {
    if (process.platform !== 'darwin') return;
    const status = systemPreferences.getMediaAccessStatus(kind);
    if (status === 'granted') return;
    if (status === 'not-determined' && (await systemPreferences.askForMediaAccess(kind))) return;
    throw new Error(`macOS has not allowed Showrunner to use ${what}. Allow it in System Settings, Privacy & Security, ${pane}.`);
  }

  // Levels and mutes that change while recording.
  setAudio(audio) {
    if (this.window && !this.window.isDestroyed() && audio) this.window.webContents.send('audio-settings', audio);
  }

  async start(settings) {
    if (this.state !== 'idle') throw new Error('The built-in recorder is already recording.');
    this.error = ''; this.warning = ''; this.interrupted = null;
    const sources = this.getSources(settings.sources);
    if (!sources.length && settings.layout !== 'cam') throw new Error('Choose a window to record first (Showrunner Recorder page), and open it.');
    const folder = this.folderFor(settings.folder);
    fs.mkdirSync(folder, { recursive: true });
    const free = this.freeBytes(folder);
    if (free < SPACE_MIN) throw new Error(`There is not enough disk space to record: ${(free / 1e9).toFixed(1)} GB free in ${folder}. Free some space or choose another folder.`);
    this.file = uniquePath(folder, this.nameFor());
    if (settings.audio && settings.audio.mic.enabled) await this.allowMicrophone();
    if (settings.layout === 'corner' || settings.layout === 'cam') await this.allowCamera();
    this.state = 'starting';
    this.emit('status');
    try {
      this.fd = fs.openSync(this.file, 'w');
      this.writeMarker();
      this.window = new BrowserWindow({ show: false, width: 320, height: 180, webPreferences: { nodeIntegration: true, contextIsolation: false, backgroundThrottling: false, autoplayPolicy: 'no-user-gesture-required' } });
      await this.window.loadFile(path.join(__dirname, 'recorder', 'index.html'));
      const started = new Promise((resolve) => ipcMain.once('recorder:started', (_e, v) => resolve(v)));
      this.window.webContents.send('start', { layout: settings.layout, width: settings.width, height: settings.height, fps: settings.fps, audio: settings.audio, camera: settings.camera });
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
    this.monitorWcs = [];
    this.setSourcesAudio(true);
    // One picture at a time per window: ask again as soon as the last one lands, no faster than the frame rate.
    sources.forEach((wc, index) => {
      let busy = false;
      const timer = setInterval(async () => {
        if (busy || this.state !== 'recording' || wc.isDestroyed() || !this.window || this.window.isDestroyed()) return;
        busy = true;
        try {
          const image = await wc.capturePage();
          this.emit('frame', index, image); // the preview on the recorder page borrows these
          const size = image.getSize();
          if (size.width && size.height && this.state === 'recording' && this.window && !this.window.isDestroyed()) {
            this.window.webContents.send('frame', { i: index, w: size.width, h: size.height, buf: image.toBitmap() });
          }
        } catch (err) { /* the window is closing or reloading: the next picture will do */ } finally { busy = false; }
      }, 1000 / settings.fps);
      this.grabbers.push(timer);
    });
    this.spaceChecks = 0;
    this.checkSpace();
    this.heard = [false, false]; this.soundNote = ''; this.runSeconds = 0; this.settingsSources = settings.sources; this.audioSettings = settings.audio;
    this.ticker = setInterval(() => { this.spaceChecks += 1; this.checkSound(); if (this.spaceChecks % 10 === 0) this.checkSpace(); this.emit('status'); }, 1000);
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
    this.levels = []; this.emit('levels', []);
    if (this.monitorIds.length) this.monitor(this.monitorIds); // the meters carry on after the recording
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
    this.clearMarker();
    this.state = 'idle';
    this.startedAt = 0;
    this.warning = '';
  }
}

module.exports = { BuiltInRecorder, defaultFileName };
