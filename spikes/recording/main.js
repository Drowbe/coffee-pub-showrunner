'use strict';
// Recording spike: can Showrunner record its own windows, without OBS? Run with: electron spikes/recording
// It runs a few short recordings, measures them, and writes results.json next to the MP4 files in ./out.
const { app, BrowserWindow, ipcMain, systemPreferences, session, desktopCapturer } = require('electron');
const fs = require('fs');
const path = require('path');
const { execFileSync, execFile } = require('child_process');

const OUT = path.join(__dirname, 'out');
fs.mkdirSync(OUT, { recursive: true });
const SECONDS = Number(process.env.SPIKE_SECONDS || 10);
const results = { electron: process.versions.electron, chromium: process.versions.chrome, platform: process.platform, arch: process.arch, tests: {} };
let recorder = null;
let currentName = '';

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function metadata(file) {
  try {
    const raw = execFileSync('mdls', ['-name', 'kMDItemDurationSeconds', '-name', 'kMDItemPixelWidth', '-name', 'kMDItemPixelHeight', '-name', 'kMDItemCodecs', '-name', 'kMDItemAudioBitRate', '-name', 'kMDItemVideoBitRate', file]).toString();
    return raw.trim().split('\n');
  } catch (err) { return [`mdls failed: ${err.message}`]; }
}

function cpuSampler() {
  const samples = [];
  const timer = setInterval(() => {
    const total = app.getAppMetrics().reduce((sum, m) => sum + m.cpu.percentCPUUsage, 0);
    samples.push(total);
  }, 1000);
  return () => { clearInterval(timer); const s = samples.slice(1); return { avgPercentOfOneCore: Math.round(s.reduce((a, b) => a + b, 0) / Math.max(1, s.length)), maxPercentOfOneCore: Math.round(Math.max(0, ...s)), samples: s.length }; };
}

// A second opinion on CPU, from the system's own `top` (the app's own numbers are per process and easy to misread): the sum for this
// app's processes in the last interval, as a percent of one core.
function topSample() {
  const pids = new Set(app.getAppMetrics().map((m) => String(m.pid)));
  return new Promise((resolve) => {
    execFile('top', ['-l', '3', '-s', '3', '-n', '40', '-o', 'cpu', '-stats', 'pid,cpu'], (err, out) => {
      if (err) return resolve({ error: err.message });
      const blocks = out.split(/\nPID\s+%CPU\n/);
      const last = blocks[blocks.length - 1].trim().split('\n');
      let sum = 0;
      for (const line of last) { const [pid, cpu] = line.trim().split(/\s+/); if (pids.has(pid)) sum += Number(cpu) || 0; }
      resolve({ topPercentOfOneCore: Math.round(sum) });
    });
  });
}

function openSource(index, { beep, heavy, fps, webgl, tapForward, mode }) {
  // mode: 'osr' (an offscreen window), 'visible' (a normal window on screen) or 'parked' (a normal window moved off every screen,
  // as the edge dock does). The last two are what Showrunner's real windows are: you log in to them and move them.
  const visible = mode !== 'osr';
  const parked = mode === 'capture-parked';
  const win = new BrowserWindow({
    show: visible, width: 1280, height: 720, useContentSize: true, ...(parked ? { x: -6000, y: 100 } : {}),
    webPreferences: { offscreen: !visible, backgroundThrottling: false, autoplayPolicy: 'no-user-gesture-required', preload: path.join(__dirname, 'tap-preload.js'), sandbox: false },
  });
  if (!visible) win.webContents.setFrameRate(30);
  const stats = { paints: 0, sent: 0, bytes: 0, toBitmapMs: 0, born: Date.now() };
  // Pages can paint faster than we record. Keep the newest image and send it at the recording's frame rate, so the recorder is
  // not handed frames it will never use.
  let latest = null;
  if (mode === 'subscribe-visible') win.webContents.beginFrameSubscription(false, (image) => { stats.paints += 1; latest = image; });
  else if (mode.startsWith('capture')) {
    let busy = false; // one capture at a time; ask again as soon as the last one lands
    const grab = setInterval(async () => {
      if (busy || win.isDestroyed()) return;
      busy = true;
      try { latest = await win.webContents.capturePage(); stats.paints += 1; } catch (err) { /* window closing */ } finally { busy = false; }
    }, 1000 / fps);
    win.on('closed', () => clearInterval(grab));
  } else win.webContents.on('paint', (_e, _dirty, image) => { stats.paints += 1; latest = image; });
  const pump = setInterval(() => {
    if (!latest) return;
    const t0 = performance.now();
    const image = latest; latest = null;
    const buf = image.toBitmap();
    const size = image.getSize();
    stats.toBitmapMs += performance.now() - t0;
    stats.sent += 1; stats.bytes += buf.length;
    recorder.webContents.send('frame', { i: index, w: size.width, h: size.height, buf });
  }, 1000 / fps);
  win.on('closed', () => clearInterval(pump));
  win.webContents.on('ipc-message', () => {});
  win.webContents.ipc.on('tap', (_e, data) => { if (beep && tapForward) recorder.webContents.send('tap', data); });
  win.loadFile(path.join(__dirname, 'page.html'), { query: { beep: beep ? '1' : '0', heavy: String(heavy), webgl: webgl ? '1' : '0' } });
  return { win, stats };
}

async function runTest(name, { layout, sources = 0, audio = false, heavy = 400, webgl = false, mode = 'osr', width = 1920, height = 1080, fps = 30 }) {
  currentName = name;
  const wins = [];
  for (let i = 0; i < sources; i += 1) wins.push(openSource(i, { beep: Boolean(audio) && i === 0, tapForward: audio === 'tap', heavy, fps, webgl, mode }));
  await wait(2000); // let the pages load and start painting
  const started = new Promise((resolve) => ipcMain.once('started', (_e, v) => resolve(v)));
  recorder.webContents.send('start', { layout, audio, width, height, fps });
  const info = await started;
  const stopCpu = cpuSampler();
  const topP = topSample();
  await wait(SECONDS * 1000);
  const cpu = { ...stopCpu(), ...(await topP) };
  const stopped = new Promise((resolve) => ipcMain.once('stopped', (_e, v) => resolve(v)));
  recorder.webContents.send('stop');
  const r = await stopped;
  const sourceStats = wins.map((w) => { const life = (Date.now() - w.stats.born) / 1000; return ({ paintsPerSecond: Math.round(w.stats.paints / life), mbPerSecondToRecorder: Math.round(w.stats.bytes / life / 1e6), sentPerSecond: Math.round(w.stats.sent / life), avgToBitmapMs: Math.round((w.stats.toBitmapMs / Math.max(1, w.stats.sent)) * 10) / 10 }); });
  wins.forEach((w) => w.win.destroy());
  results.tests[name] = { config: { layout, sources, audio, heavy, webgl, mode, width, height, fps, seconds: SECONDS }, encoder: info, cpu, sourceStats, recorder: r, mdls: metadata(r.file) };
  console.log(`${name}:`, JSON.stringify(results.tests[name], null, 1));
  await wait(500);
}

ipcMain.on('log', (_e, m) => console.log('[recorder]', m));
ipcMain.handle('save', (_e, buf, mime) => {
  const file = path.join(OUT, `${currentName}.${mime.includes('mp4') ? 'mp4' : 'webm'}`);
  fs.writeFileSync(file, Buffer.from(buf));
  return file;
});

app.whenReady().then(async () => {
  results.permissions = { microphone: systemPreferences.getMediaAccessStatus('microphone'), screen: systemPreferences.getMediaAccessStatus('screen') };
  session.defaultSession.setDisplayMediaRequestHandler(async (_request, callback) => {
    const sources = await desktopCapturer.getSources({ types: ['screen'] });
    callback({ video: sources[0], audio: 'loopback' });
  });
  recorder = new BrowserWindow({ show: false, width: 640, height: 360, webPreferences: { nodeIntegration: true, contextIsolation: false, backgroundThrottling: false, autoplayPolicy: 'no-user-gesture-required' } });
  await recorder.loadFile(path.join(__dirname, 'recorder.html'));
  const only = (process.env.SPIKE_ONLY || '').split(',').filter(Boolean);
  const all = {
    '1-synthetic-1080p30': { layout: 'synthetic' },
    '2-one-window-1080p30': { layout: 'one', sources: 1 },
    '3-two-windows-1080p30': { layout: 'two', sources: 2 },
    '4-one-window-with-audio': { layout: 'one', sources: 1, audio: 'tap' },
    '10-subscribe-visible-window': { layout: 'one', sources: 1, mode: 'subscribe-visible', webgl: true },
    '11-capturepage-visible-window': { layout: 'one', sources: 1, mode: 'capture-visible', webgl: true },
    '12-capturepage-parked-window': { layout: 'one', sources: 1, mode: 'capture-parked', webgl: true },
    '13-capturepage-visible-audio-tap': { layout: 'one', sources: 1, mode: 'capture-visible', audio: 'tap' },
    '14-capturepage-two-visible': { layout: 'two', sources: 2, mode: 'capture-visible', webgl: true },
    '9-one-window-system-audio': { layout: 'one', sources: 1, audio: 'loopback' },
    '5-one-window-1080p60': { layout: 'one', sources: 1, fps: 60 },
    '6-two-windows-heavy': { layout: 'two', sources: 2, heavy: 3000 },
    '7-one-window-webgl': { layout: 'one', sources: 1, webgl: true },
    '8-two-windows-webgl-audio': { layout: 'two', sources: 2, webgl: true, audio: 'tap' },
  };
  for (const [name, cfg] of Object.entries(all)) if (!only.length || only.some((o) => name.startsWith(o))) await runTest(name, cfg);
  fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify(results, null, 2));
  app.quit();
});
