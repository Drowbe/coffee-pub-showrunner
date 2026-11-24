'use strict';
// The built-in recorder: records Showrunner's own windows to an MP4, with no OBS. It reads each window's picture with capturePage(),
// hands the frames to a hidden recorder window that lays them out and encodes (src/recorder/), and writes the chunks to disk as they
// arrive. Audio comes from a small copy of each page's own sound (src/recorder/tap-preload.js). See documentation/plans/plan-recording.md.
const { BrowserWindow, desktopCapturer, ipcMain, systemPreferences } = require('electron');
const { EventEmitter } = require('events');
const fs = require('fs');
const path = require('path');
const { uniquePath, defaultName } = require('./filename');
const { findFfmpeg } = require('./ffmpeg');

const SPACE_MIN = 1e9; // will not start with less than this free
const SPACE_WARN = 3e9; // warn below this
const SPACE_STOP = 3e8; // stop (and keep the file) below this

const pad = (n) => String(n).padStart(2, '0');

function defaultFileName(date = new Date()) {
  return `Showrunner ${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}.mp4`;
}

class BuiltInRecorder extends EventEmitter {
  // getSources(ids) returns the webContents to record, in order; folderFor() the folder to write to.
  constructor({ mediaAccess, getSources, getCaptureInfo, folderFor, nameFor, markerFile, windowName, dataDir }) {
    super();
    this.getSources = getSources;
    this.mediaAccess = mediaAccess || null; // the app's one shared question to macOS about the camera or microphone
    this.getCaptureInfo = getCaptureInfo || (() => []);
    this.folderFor = folderFor;
    this.nameFor = nameFor || (() => defaultName());
    this.state = 'idle'; // idle | starting | recording | paused | stopping
    this.window = null;
        this.file = '';
    this.startedAt = 0;
    this.pausedAt = 0;
    this.pausedTotal = 0;
    this.grabbers = [];
    this.error = '';
    this.warning = '';
    this.interrupted = null; // { file } when the app closed in the middle of a recording last time
    this.markerFile = markerFile || '';
    this.dataDir = dataDir || '';
    this.windowName = windowName || ((id) => id);
    this.heard = [false, false]; // whether any sound has arrived from each chosen window
    this.soundNote = ''; this.micNote = '';
    this.runSeconds = 0;
    this.inFlight = [0, 0]; // pictures sent to the recorder page and not yet used
    this.bytesWritten = 0;
    this.lastLevelsAt = 0;
    this.saveNote = '';
    this.monitorIds = []; // windows whose loudness is being watched for the meters while not recording
    this.monitorWcs = [];
    this.idlePeaks = [0, 0];
    this.idleTimer = null;
    this.spaceChecks = 0;
    ipcMain.on('recorder:frameAck', (_e, i) => { if (this.inFlight[i] > 0) this.inFlight[i] -= 1; });
    ipcMain.on('recorder:composite', (_e, picture) => this.emit('composite', picture));
    ipcMain.on('recorder:note', (_e, text) => {
      this.emit('diag', String(text));
      // A microphone that stops is said out loud, since the recording would carry on with no voice in it.
      if (/microphone: .*(state ended|device stopped|system muted)/.test(String(text)) && this.state !== 'idle') { this.micNote = 'The microphone stopped working, so your voice is not being recorded.'; this.emit('status'); }
      if (/microphone: sound is flowing again/.test(String(text))) { this.micNote = ''; this.emit('status'); }
    });
    ipcMain.on('recorder:stats', (_e, stats) => this.emit('diag', `Recorder state: ${JSON.stringify(stats)}`));
    ipcMain.on('recorder:levels', (_e, levels) => {
      this.lastLevelsAt = Date.now(); this.levels = levels; this.emit('levels', levels);
      if (Array.isArray(levels)) [0, 1].forEach((i) => { if (levels[i] > 0.002) this.heard[i] = true; }); // the mixer hears it, so it is not silent
    });
    // What kind of sound each page plays, as found by its preload: written to the activity log, to see what a page does.
    ipcMain.on('recorder:mask', (_e, mask) => this.emit('mask', mask)); // the person's outline, for the toolbar's preview
    ipcMain.on('recorder:tapinfo', (e, text) => this.emit('tapinfo', e.sender.id, String(text)));
    ipcMain.on('recorder:peak', (e, peak) => {
      const i = this.monitorWcs.findIndex((wc) => wc && wc.id === e.sender.id);
      if (i >= 0 && Number.isFinite(peak)) this.idlePeaks[i] = Math.max(this.idlePeaks[i], peak);
    });
    ipcMain.on('recorder:failed', (_e, message) => {
      this.error = message; this.emit('status');
      if (this.state === 'recording' || this.state === 'paused') this.stop().catch(() => {}); // a broken recorder is stopped, keeping what it saved
    });
    ipcMain.on('recorder:audio', (e, msg) => {
      if (this.state !== 'recording' || !this.window || this.window.isDestroyed()) return;
      const win = (this.sourceContents || []).findIndex((wc) => wc && wc.id === e.sender.id); // which chosen window this sound came from
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
    return { state: this.state, seconds: this.seconds(), file: this.file, error: this.error, warning: [this.captureNote, this.saveNote, this.micNote, this.soundNote, this.warning].filter(Boolean).join('  '), interrupted: this.interrupted };
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
    // Is anything reaching the file? And is the recorder still alive? Either failing is said out loud, with the recorder's own state.
    if (this.runSeconds === 10) { try { this.bytesWritten = fs.statSync(this.file).size; } catch (err) { this.bytesWritten = 0; } }
    // The file stays tiny for a long time even when all is well (fragments are written as it goes), so its size is only noted, not judged:
    // a stuck encoder is caught by the recorder itself (pictures piling up, or ffmpeg stopping).
    if (this.runSeconds === 10) this.emit('diag', `File size at 10 s: ${this.bytesWritten} bytes.`);
    // The warning is only true while nothing is reaching the file: once the file starts to grow, it goes away by itself.
    if (this.saveNote.startsWith('Nothing has been saved') && this.runSeconds > 10) {
      let size = 0; try { size = fs.statSync(this.file).size; } catch (err) { size = 0; }
      if (size > 4096) { this.saveNote = ''; this.emit('diag', `The file is being written after all (${size} bytes at ${this.runSeconds} s).`); }
    }
    if (this.saveNote.includes('responding') && Date.now() - this.lastLevelsAt < 2000) this.saveNote = this.saveNote.replace(' The recorder has stopped responding.', ''); // it is back
    if (this.state === 'recording' && this.lastLevelsAt && Date.now() - this.lastLevelsAt > 5000 && !this.saveNote.includes('responding')) {
      this.saveNote += ' The recorder has stopped responding.';
      this.emit('diag', 'The recorder window stopped sending its level readings for 5 s.');
      if (this.window && !this.window.isDestroyed()) this.window.webContents.send('stats');
    }
    if (this.runSeconds < 8) return;
    const silent = (this.settingsSources || []).map((id, i) => ({ id, i })).filter(({ id, i }) => id && !String(id).startsWith('image:') && !this.heard[i] && !(this.audioSettings && this.audioSettings.windows[i].muted)).map(({ id }) => this.windowName(id));
    this.soundNote = silent.length ? `No sound from ${silent.join(' or ')} yet. Nothing may be playing there, or it plays in a way Showrunner cannot copy.` : '';
  }

  // Watches how loud each chosen window is, so the meters on the recorder page move before any recording. Pass the window ids, or
  // nothing to stop. It does nothing while recording (the recorder reports its own levels then) and picks up again afterwards.
  // The window behind each place in the picture (null where the place is empty or holds a picture), in the same order as `ids`.
  windowsAt(ids) {
    return (ids || []).map((id) => (id && !String(id).startsWith('image:') ? (this.getSources([id])[0] || null) : null));
  }

  monitor(ids) {
    this.monitorIds = ids || [];
    if (this.active) return;
    const next = this.windowsAt(this.monitorIds);
    for (const wc of this.monitorWcs) if (wc && !next.includes(wc) && !wc.isDestroyed()) wc.send('recorder:tap', false);
    for (const wc of next) if (wc && !wc.isDestroyed()) wc.send('recorder:tap', 'meter');
    this.monitorWcs = next;
    if (next.some(Boolean) && !this.idleTimer) {
      this.idleTimer = setInterval(() => {
        if (this.active) return;
        this.emit('idle', this.idlePeaks.slice());
        this.idlePeaks = [0, 0];
      }, 100);
    } else if (!next.some(Boolean) && this.idleTimer) { clearInterval(this.idleTimer); this.idleTimer = null; this.emit('idle', [0, 0]); }
  }

  setSourcesAudio(enabled) {
    for (const wc of this.sourceContents || []) if (wc && !wc.isDestroyed()) wc.send('recorder:tap', enabled);
  }

  // macOS asks the person once, then remembers. Returns quietly when it is allowed; throws a plain message when it is not.
  async allowMicrophone() { return this.allowAccess('microphone', 'the microphone', 'Microphone'); }
  async allowCamera() { return this.allowAccess('camera', 'the webcam', 'Camera'); }
  async allowAccess(kind, what, pane) {
    if (process.platform !== 'darwin') return;
    const status = this.mediaAccess ? await this.mediaAccess(kind) : systemPreferences.getMediaAccessStatus(kind);
    if (status === 'granted') return;
    if (!this.mediaAccess && status === 'not-determined' && (await systemPreferences.askForMediaAccess(kind))) return;
    throw new Error(`macOS has not allowed Showrunner to use ${what}. Allow it in System Settings, Privacy & Security, ${pane}.`);
  }

  // Levels and mutes that change while recording.
  setAudio(audio) {
    if (this.window && !this.window.isDestroyed() && audio) this.window.webContents.send('audio-settings', audio);
  }

  // The recorder's hidden window is made ahead of time (while the toolbar is open) with the microphone and webcam already open, so
  // pressing Record does not wait for them. Anything that changes the devices opens them again.
  async ensureWindow() {
    if (!this.window || this.window.isDestroyed()) {
      this.window = new BrowserWindow({ show: false, width: 320, height: 180, webPreferences: { nodeIntegration: true, contextIsolation: false, backgroundThrottling: false, autoplayPolicy: 'no-user-gesture-required' } });
      this.windowReady = this.window.loadFile(path.join(__dirname, 'recorder', 'index.html'));
    }
    await this.windowReady;
  }

  async warm(settings) {
    if (this.active) return;
    try {
      if (settings.audio && settings.audio.mic.enabled) await this.allowMicrophone();
      if (['corner', 'center', 'cam'].includes(settings.layout)) await this.allowCamera();
      await this.ensureWindow();
      if (!this.active && this.window && !this.window.isDestroyed()) this.window.webContents.send('warm', { layout: settings.layout, camera: settings.camera, audio: settings.audio });
    } catch (err) { /* warming is only a head start; Record will open everything itself */ }
  }

  unwarm() {
    if (this.active) return;
    if (this.window && !this.window.isDestroyed()) this.window.destroy();
    this.window = null;
  }

  async start(settings) {
    if (this.state !== 'idle') throw new Error('The built-in recorder is already recording.');
    this.error = ''; this.warning = ''; this.interrupted = null;
    const sources = this.windowsAt(settings.sources); // one for each place in the picture, null where it holds a picture or nothing
    const images = (settings.sources || []).map((id) => (id && String(id).startsWith('image:') ? path.join(this.dataDir, 'recording-images', String(id).slice(6)) : null));
    for (const file of images) if (file && !fs.existsSync(file)) throw new Error(`A picture chosen for the recording is missing (${path.basename(file)}). Choose it again on the recorder page.`);
    if (!sources.some(Boolean) && !images.some(Boolean) && settings.layout !== 'cam') throw new Error('Choose a window or a picture to record first (Showrunner Recorder page), and open the window.');
    const folder = this.folderFor(settings.folder);
    fs.mkdirSync(folder, { recursive: true });
    const free = this.freeBytes(folder);
    if (free < SPACE_MIN) throw new Error(`There is not enough disk space to record: ${(free / 1e9).toFixed(1)} GB free in ${folder}. Free some space or choose another folder.`);
    const ffmpeg = findFfmpeg(this.dataDir);
    if (!ffmpeg) throw new Error('The video encoder (ffmpeg) is missing, so the Showrunner Recorder cannot record. Reinstall Showrunner, or put an ffmpeg program in the "ffmpeg" folder inside its data folder.');
    const format = settings.format === 'mkv' ? 'mkv' : 'mp4';
    this.file = uniquePath(folder, this.nameFor(), undefined, format);
    let screenMode = settings.capture === 'screen' && settings.layout !== 'cam' && sources.some(Boolean);
    this.captureNote = '';
    if (screenMode && process.platform === 'darwin' && systemPreferences.getMediaAccessStatus('screen') !== 'granted') {
      // Asking for the list of windows is what makes macOS show its Screen Recording prompt (and list Showrunner under that setting).
      // This recording carries on the other way, so the first one is never lost to a permission question.
      try { await desktopCapturer.getSources({ types: ['window'], thumbnailSize: { width: 0, height: 0 } }); } catch (err) { /* only to raise the prompt */ }
      screenMode = false;
      this.captureNote = 'Recorded by copying the window, because macOS has not allowed Showrunner to capture windows (it calls this Screen Recording; only the window you chose is recorded, never your whole screen). Allow it in System Settings, Privacy & Security, Screen & System Audio Recording, then quit and reopen Showrunner for smoother recording.';
      this.emit('diag', this.captureNote);
    }
    if (settings.audio && settings.audio.mic.enabled) await this.allowMicrophone();
    if (['corner', 'center', 'cam'].includes(settings.layout)) await this.allowCamera();
    this.state = 'starting';
    this.emit('status');
    try {
      this.writeMarker();
      await this.ensureWindow();
      const started = new Promise((resolve) => ipcMain.once('recorder:started', (_e, v) => resolve(v)));
      this.window.webContents.send('start', { layout: settings.layout, width: settings.width, height: settings.height, fps: settings.fps, audio: settings.audio, camera: settings.camera, ffmpeg, file: this.file, format, encoder: settings.encoder, fit: settings.fit, images, capture: screenMode ? 'screen' : 'pictures', screens: screenMode ? this.getCaptureInfo(settings.sources) : [] });
      const result = await started;
      if (!result.ok) throw new Error(result.error || 'The recorder could not start.');
    } catch (err) {
      const failedFile = this.file;
      await this.cleanup();
      try { fs.unlinkSync(failedFile); } catch (e) { /* nothing was written */ } // a start that failed leaves no empty file behind
      this.file = '';
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
    this.screenMode = screenMode;
    clearInterval(this.rectTimer);
    if (screenMode) {
      // Windows can be moved or resized while recording: where each page sits in its window is sent again every half second.
      this.rectTimer = setInterval(() => { if (this.window && !this.window.isDestroyed()) this.window.webContents.send('screen-rects', this.getCaptureInfo(settings.sources)); }, 500);
    }
    (screenMode ? [] : sources).forEach((wc, index) => {
      if (!wc) return;
      let busy = false;
      const timer = setInterval(async () => {
        if (busy || this.inFlight[index] >= 2 || this.state !== 'recording' || wc.isDestroyed() || !this.window || this.window.isDestroyed()) return;
        busy = true;
        try {
          const t1 = Date.now();
          const image = await wc.capturePage();
          const t2 = Date.now();
          const size = image.getSize();
          if (size.width && size.height && this.state === 'recording' && this.window && !this.window.isDestroyed()) {
            this.inFlight[index] += 1;
            const bitmap = image.toBitmap();
            const t3 = Date.now();
            this.window.webContents.send('frame', { i: index, w: size.width, h: size.height, buf: bitmap });
            const m = this.capStats[index] || (this.capStats[index] = { n: 0, grab: 0, grabMax: 0, copy: 0, send: 0, w: 0, h: 0 });
            m.n += 1; m.grab += t2 - t1; m.grabMax = Math.max(m.grabMax, t2 - t1); m.copy += t3 - t2; m.send += Date.now() - t3; m.w = size.width; m.h = size.height;
          }
        } catch (err) { /* the window is closing or reloading: the next picture will do */ } finally { busy = false; }
      }, 1000 / settings.fps);
      this.grabbers.push(timer);
    });
    this.spaceChecks = 0;
    this.checkSpace();
    this.inFlight = [0, 0];
    this.heard = [false, false]; this.soundNote = ''; this.saveNote = ''; this.bytesWritten = 0; this.lastLevelsAt = Date.now(); this.runSeconds = 0; this.settingsSources = settings.sources; this.audioSettings = settings.audio;
    this.capStats = [];
    this.ticker = setInterval(() => {
      this.spaceChecks += 1; this.checkSound();
      if (this.spaceChecks % 5 === 0 && this.spaceChecks <= 60) {
        const text = this.capStats.map((m, i) => (m && m.n ? `window ${i + 1}: ${m.w}x${m.h}, ${m.n} pictures, grab avg ${Math.round(m.grab / m.n)} ms (worst ${m.grabMax}), copy avg ${Math.round(m.copy / m.n)} ms, send avg ${Math.round(m.send / m.n)} ms` : '')).filter(Boolean).join('; ');
        if (text) this.emit('diag', `capture: ${text}`);
        this.capStats = [];
      }
       if (this.spaceChecks % 10 === 0) this.checkSpace(); this.emit('status'); }, 1000);
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
    clearInterval(this.rectTimer);
    this.grabbers.forEach(clearInterval); this.grabbers = [];
    clearInterval(this.ticker);
    if (this.window && !this.window.isDestroyed()) this.window.destroy();
    this.window = null;
    this.clearMarker();
    this.state = 'idle';
    this.soundNote = ''; this.micNote = ''; this.captureNote = ''; // these notes belong to a running recording only
    this.startedAt = 0;
    this.warning = '';
    this.saveNote = '';
  }
}

module.exports = { BuiltInRecorder, defaultFileName };
