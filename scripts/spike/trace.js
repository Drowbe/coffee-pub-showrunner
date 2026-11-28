'use strict';
// Spike, follow-up to question 4: where does the recorded window sound get its holes? Follows an unbroken tone through each stage of
// the app's own sound path (nothing in src/ is changed; the counters are added from outside, in memory):
//   page   what the page's copy hands to the app (is any sound missing, or the wave broken?)
//   queue  how the recorder page lines the pieces up (how far ahead each is queued; holes it makes when one is late)
//   mix    the mixed sound as it reaches the part that writes to ffmpeg, and what that part pads or throws away
//   file   the finished recording
// Run: npx electron scripts/spike/trace.js <ffmpeg.exe> <work folder> <variant> ...   Variants are in trace-page.js; add "+idle" to
// stop the page drawing, "+nocopy-snapshots" to record with Screen recording instead of Built-in snapshots.
const { app, BrowserWindow, WebContentsView, ipcMain } = require('electron');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const [ffmpeg, work, ...variants] = process.argv.slice(2);
process.env.SHOWRUNNER_FFMPEG = ffmpeg;
for (const [k, v] of [['disable-renderer-backgrounding'], ['disable-background-timer-throttling'], ['disable-backgrounding-occluded-windows'], ['autoplay-policy', 'no-user-gesture-required'], ['disable-features', 'AudioServiceOutOfProcess']]) app.commandLine.appendSwitch(k, v);
const data = fs.mkdtempSync(path.join(os.tmpdir(), 'showrunner-spike-trace-'));
app.setPath('userData', data);
const { BuiltInRecorder } = require('../../src/recorder.js');
const SECONDS = Number(process.env.SPIKE_SECONDS || 40);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// How many times a 440 Hz wave breaks off, and holes (runs of silence), in a stream fed piece by piece.
function watcher() {
  const w = { samples: 0, breaks: 0, holes: [], p1: 0, p2: 0, run: 0 };
  w.feed = (x, rate) => {
    const k = 2 * Math.cos((2 * Math.PI * 440) / rate);
    for (let i = 0; i < x.length; i += 1) {
      if (Math.abs(x[i]) < 0.002) w.run += 1; else { if (w.run > rate / 500 && w.samples > rate) w.holes.push(Math.round((w.run / rate) * 1000)); w.run = 0; }
      if (w.samples > rate && Math.abs(x[i] - k * w.p1 + w.p2) > 0.05) w.breaks += 1;
      w.p2 = w.p1; w.p1 = x[i]; w.samples += 1;
    }
  };
  return w;
}

// Added to the recorder page once it is recording. It reads recorder.js's own variables.
const INSIDE = `(() => {
  const { ipcRenderer } = require('electron');
  const T = window.__trace = { from: [performance.now(), actx.currentTime], rate: actx.sampleRate, queue: [], dropped: 0, padded: [], clockGaps: 0 };
  const watch = (${watcher.toString()})(); T.mix = watch;
  let prevEnd = null;
  ipcRenderer.on('audio', (_e, m) => { const end = nextAt.get(m.key); if (end === undefined) return; const at = end - m.l.length / m.rate; T.queue.push([end - m.l.length / m.rate - actx.currentTime, prevEnd === null ? 0 : at - prevEnd]); prevEnd = end; });
  const inner = proc.port.onmessage; let lastT = null;
  proc.port.onmessage = (ev) => {
    const d = ev.data; watch.feed(d.l, RATE);
    if (lastT !== null && Math.abs(d.t - lastT - d.l.length / RATE) > 0.0005) T.clockGaps += 1; lastT = d.t;
    const before = audioWritten; inner(ev); const wrote = audioWritten - before;
    if (wrote === 0) T.dropped += 1; else if (wrote > d.l.length + 1) T.padded.push(Math.round(((wrote - d.l.length) / RATE) * 1000));
  };
})()`;
const READ = `(() => { const T = window.__trace; const secs = (performance.now() - T.from[0]) / 1000; return { recorderRate: T.rate, recorderClock: (actx.currentTime - T.from[1]) / secs, queue: T.queue, dropped: T.dropped, padded: T.padded, clockGaps: T.clockGaps, mix: { breaks: T.mix.breaks, holes: T.mix.holes } }; })()`;

function inFile(file) {
  const raw = execFileSync(ffmpeg, ['-v', 'error', '-i', file, '-vn', '-ac', '1', '-ar', '48000', '-f', 'f32le', '-'], { maxBuffer: 1 << 28 });
  const a = new Float32Array(raw.buffer, raw.byteOffset, Math.floor(raw.length / 4));
  const w = watcher(); w.feed(a.subarray(48000, a.length - 48000), 48000);
  return { seconds: Math.round(a.length / 48000), breaks: w.breaks, holes: w.holes };
}

app.on('window-all-closed', () => {});
app.whenReady().then(async () => {
  const results = [];
  for (const variant of variants) {
    const [name, ...flags] = variant.split('+');
    const win = new BrowserWindow({ title: 'Coffee Pub Showrunner - Game', x: 40, y: 20, width: 1920, height: 1108, useContentSize: true, frame: false, resizable: false, show: false });
    const page = new WebContentsView({ webPreferences: { preload: path.join(__dirname, '..', '..', 'src', 'recorder', 'tap-preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false } });
    win.contentView.addChildView(page); page.setBounds({ x: 0, y: 28, width: 1920, height: 1080 }); win.show();
    await page.webContents.loadFile(path.join(__dirname, 'sync.html'));
    page.webContents.setAudioMuted(true);
    if (flags.includes('idle')) await page.webContents.executeJavaScript('window.requestAnimationFrame = () => 0; true');
    const recorder = new BuiltInRecorder({
      getSources: (ids) => ids.map(() => page.webContents),
      getCaptureInfo: (ids) => ids.map((id) => { if (!id) return null; const b = win.getBounds(); const c = win.getContentBounds(); const p = page.getBounds(); return { sourceId: win.getMediaSourceId(), winW: b.width, winH: b.height, rect: { x: c.x - b.x + p.x, y: c.y - b.y + p.y, w: p.width, h: p.height } }; }),
      folderFor: () => work, dataDir: data,
    });
    const handed = { first: 0, last: 0, samples: 0, rate: 0, sizes: new Set(), gaps: [], wave: watcher() };
    const listen = (e, m) => {
      if (e.sender.id !== page.webContents.id || !recorder.active) return;
      const now = performance.now(); if (!handed.first) handed.first = now; else { handed.samples += m.l.length; handed.gaps.push(now - handed.last); }
      handed.last = now; handed.rate = m.rate; handed.sizes.add(m.l.length); handed.wave.feed(m.l, m.rate);
    };
    ipcMain.on('recorder:audio', listen);
    try {
      await page.webContents.executeJavaScript(`${fs.readFileSync(path.join(__dirname, 'trace-page.js'), 'utf8')}; window.variants[${JSON.stringify(name)}]()`, true);
      const audio = { windows: [{ level: 1, muted: false }, { level: 1, muted: false }], mic: { enabled: false, device: '', deviceLabel: '', level: 1, muted: false, echoCancel: false, delayMs: 0 } };
      await recorder.start({ sources: ['game'], layout: 'one', width: 1920, height: 1080, fps: 30, fit: 'fit', capture: flags.includes('nocopy-snapshots') ? 'screen' : 'pictures', encoder: 'auto', format: 'mp4', folder: work, audio, camera: { background: 'none' }, calibration: true });
      await wait(1000);
      await recorder.window.webContents.executeJavaScript(INSIDE);
      const clock = () => page.webContents.executeJavaScript('[performance.now(), window.ctx.currentTime, window.ctx.sampleRate, window.ctx.baseLatency]');
      const c0 = await clock();
      await wait(SECONDS * 1000);
      const c1 = await clock();
      const inside = await recorder.window.webContents.executeJavaScript(READ);
      const file = await recorder.stop();
      const kept = path.join(work, `trace-${variant}.mp4`); fs.renameSync(file, kept);
      const secs = (handed.last - handed.first) / 1000; const gaps = handed.gaps.sort((a, b) => a - b);
      const leads = inside.queue.map((q) => q[0]);
      const r = {
        variant,
        page: { rate: handed.rate, baseLatency: c1[3], clock: +((c1[1] - c0[1]) / ((c1[0] - c0[0]) / 1000)).toFixed(5), blockSizes: [...handed.sizes], deliveredShare: +(handed.samples / handed.rate / secs).toFixed(5), waveBreaks: handed.wave.breaks, holes: handed.wave.holes.length, arrivalGapMs: { median: Math.round(gaps[gaps.length >> 1]), max: Math.round(gaps[gaps.length - 1]) } },
        queue: { recorderRate: inside.recorderRate, recorderClock: +inside.recorderClock.toFixed(5), pieces: inside.queue.length, queuedAheadMs: { first: Math.round(leads[0] * 1000), min: Math.round(Math.min(...leads) * 1000), max: Math.round(Math.max(...leads) * 1000) }, everyTwoSecondsMs: leads.filter((_v, i) => i % Math.round((2 * handed.rate) / [...handed.sizes][0]) === 0).map((v) => Math.round(v * 1000)), holesMadeMs: inside.queue.filter((q) => q[1] > 0.001).map((q) => Math.round(q[1] * 1000)), overlaps: inside.queue.filter((q) => q[1] < -0.001).length },
        mix: { breaks: inside.mix.breaks, holes: inside.mix.holes, piecesThrownAway: inside.dropped, silencePaddedMs: inside.padded, audioThreadGaps: inside.clockGaps },
        file: inFile(kept),
      };
      results.push(r); console.log(JSON.stringify(r));
    } catch (err) { results.push({ variant, error: String(err.stack || err) }); console.log(`${variant}: ${err.stack || err}`); }
    ipcMain.removeListener('recorder:audio', listen);
    ipcMain.removeAllListeners('recorder:frameAck'); ipcMain.removeAllListeners('recorder:composite'); ipcMain.removeAllListeners('recorder:note'); ipcMain.removeAllListeners('recorder:stats'); ipcMain.removeAllListeners('recorder:levels'); ipcMain.removeAllListeners('recorder:mask'); ipcMain.removeAllListeners('recorder:tapinfo'); ipcMain.removeAllListeners('recorder:peak'); ipcMain.removeAllListeners('recorder:failed'); ipcMain.removeAllListeners('recorder:audio'); // each run has its own recorder
    win.destroy();
    fs.writeFileSync(path.join(work, `trace-${variants.join('_')}.json`), JSON.stringify(results, null, 1));
    await wait(1000);
  }
  app.exit(0);
});
