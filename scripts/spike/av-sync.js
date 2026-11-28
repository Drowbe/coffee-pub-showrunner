'use strict';
// Spike, question 4 (the part that needs nobody). Run: npx electron scripts/spike/av-sync.js <ffmpeg.exe> <work folder>
// Records a window that flashes and beeps at the same instant with the app's own recorder (src/recorder.js, unchanged), once with
// Screen recording and once with Built-in snapshots, twice each, and measures how far apart the flash and the beep are in the file.
const { app, BrowserWindow, WebContentsView } = require('electron');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const [ffmpeg, work] = process.argv.slice(2);
process.env.SHOWRUNNER_FFMPEG = ffmpeg;
const ffprobe = path.join(path.dirname(ffmpeg), 'ffprobe.exe');
// The same switches as src/main.js.
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
// SPIKE_OWN_AUDIO_PROCESS=1 leaves this one out (src/main.js sets it for the Mac), to see whether it matters to the sound here.
if (!process.env.SPIKE_OWN_AUDIO_PROCESS) app.commandLine.appendSwitch('disable-features', 'AudioServiceOutOfProcess');
const data = fs.mkdtempSync(path.join(os.tmpdir(), 'showrunner-spike-sync-'));
app.setPath('userData', data);
const { BuiltInRecorder } = require('../../src/recorder.js');

const BAR = 28; const SECONDS = Number(process.env.SPIKE_SECONDS || 45);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// Holes (silence inside the tone) and jumps (the wave breaking off) in a recording of the unbroken tone.
function breaks(file, amp = Number(process.env.SPIKE_TONE)) {
  const raw = execFileSync(ffmpeg, ['-v', 'error', '-i', file, '-vn', '-ac', '1', '-ar', '48000', '-f', 'f32le', '-'], { maxBuffer: 1 << 28 });
  const a = new Float32Array(raw.buffer, raw.byteOffset, Math.floor(raw.length / 4));
  const from = 96000; const to = a.length - 48000; const holes = []; const jumps = []; let run = 0; let last = -48000;
  const k = 2 * Math.cos((2 * Math.PI * 440) / 48000);
  for (let i = from; i < to; i += 1) {
    if (Math.abs(a[i]) < amp / 150) run += 1; else { if (run > 96) holes.push({ at: +((i - run) / 48000).toFixed(2), ms: Math.round(run / 48) }); run = 0; }
    if (Math.abs(a[i] - k * a[i - 1] + a[i - 2]) > amp / 6 && i - last > 4800) { jumps.push(+(i / 48000).toFixed(2)); last = i; }
  }
  return { secondsChecked: Math.round((to - from) / 48000), holes, jumps: jumps.length, jumpTimes: jumps.slice(0, 20) };
}

// The moments the sound starts (sample accurate) and the first white pictures.
function onsets(file) {
  // Each stream can start a little after zero in the file (x264 reorders pictures), so the times are counted from each start.
  const probe = JSON.parse(execFileSync(ffprobe, ['-v', 'error', '-show_entries', 'stream=codec_type,start_time', '-of', 'json', file]).toString());
  const startOf = (type) => Number(probe.streams.find((s) => s.codec_type === type).start_time) || 0;
  const a0 = startOf('audio'); const v0 = startOf('video');
  const raw = execFileSync(ffmpeg, ['-v', 'error', '-i', file, '-vn', '-ac', '1', '-ar', '48000', '-f', 'f32le', '-'], { maxBuffer: 1 << 28 });
  const a = new Float32Array(raw.buffer, raw.byteOffset, Math.floor(raw.length / 4));
  const beeps = []; let quietSince = -48000;
  for (let i = 0; i < a.length; i += 1) if (Math.abs(a[i]) > 0.02) { if (i - quietSince > 24000) beeps.push(a0 + i / 48000); quietSince = i; }
  const pics = execFileSync(ffmpeg, ['-v', 'error', '-i', file, '-an', '-vf', 'scale=16:9,format=gray', '-fps_mode', 'passthrough', '-f', 'rawvideo', '-'], { maxBuffer: 1 << 28 });
  const flashes = []; let was = false;
  for (let n = 0; n * 144 < pics.length; n += 1) { let sum = 0; for (let i = 0; i < 144; i += 1) sum += pics[n * 144 + i]; const is = sum / 144 > 128; if (is && !was) flashes.push(v0 + n / 30); was = is; }
  return { beeps, flashes, starts: { audio: a0, video: v0 } };
}

app.on('window-all-closed', () => {});
app.whenReady().then(async () => {
  const results = [];
  try {
    const win = new BrowserWindow({ title: 'Coffee Pub Showrunner - Game', x: 40, y: 20, width: 1920, height: 1080 + BAR, useContentSize: true, frame: false, roundedCorners: false, hasShadow: false, resizable: false, minimizable: false, maximizable: false, fullscreenable: false, backgroundColor: '#0E1A2B', show: false });
    const page = new WebContentsView({ webPreferences: { preload: path.join(__dirname, '..', '..', 'src', 'recorder', 'tap-preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false } });
    win.contentView.addChildView(page); page.setBounds({ x: 0, y: BAR, width: 1920, height: 1080 });
    win.show();
    await page.webContents.loadFile(path.join(__dirname, 'sync.html'));
    // Muted, nothing comes out of the speakers (the recorder's copy of the sound is taken before that). SPIKE_AUDIBLE=1 leaves it
    // unmuted, as a game window would be, with quiet beeps.
    page.webContents.setAudioMuted(!process.env.SPIKE_AUDIBLE);
    const recorder = new BuiltInRecorder({
      getSources: (ids) => ids.map(() => page.webContents),
      getCaptureInfo: (ids) => ids.map((id) => { if (!id) return null; const b = win.getBounds(); const c = win.getContentBounds(); const p = page.getBounds(); return { sourceId: win.getMediaSourceId(), winW: b.width, winH: b.height, rect: { x: c.x - b.x + p.x, y: c.y - b.y + p.y, w: p.width, h: p.height } }; }),
      folderFor: () => work, dataDir: data,
    });
    const notes = [];
    recorder.on('diag', (t) => notes.push(t));
    await page.webContents.executeJavaScript(process.env.SPIKE_TONE ? `tone(${Number(process.env.SPIKE_TONE)})` : 'begin()', true);
    const audio = { windows: [{ level: 1, muted: false }, { level: 1, muted: false }], mic: { enabled: false, device: '', deviceLabel: '', level: 1, muted: false, echoCancel: false, delayMs: 0 } };
    for (const [capture, run] of process.env.SPIKE_TONE ? [['screen', 1], ['pictures', 1]] : [['screen', 1], ['pictures', 1], ['screen', 2], ['pictures', 2]]) {
      notes.length = 0;
      try {
        await recorder.start({ sources: ['game'], layout: 'one', width: 1920, height: 1080, fps: 30, fit: 'fit', capture, encoder: 'auto', format: 'mp4', folder: work, audio, camera: { background: 'none' }, calibration: true });
        await wait(SECONDS * 1000);
        const file = await recorder.stop();
        const kept = path.join(work, `sync-${capture}-${run}.mp4`); fs.renameSync(file, kept);
        if (process.env.SPIKE_TONE) { const r = { capture, ...breaks(kept), error: recorder.error || undefined }; results.push(r); console.log(JSON.stringify(r)); continue; }
        const { beeps, flashes, starts } = onsets(kept);
        const d = flashes.map((f) => { const b = beeps.reduce((best, x) => (Math.abs(x - f) < Math.abs(best - f) ? x : best), Infinity); return Math.abs(f - b) < 0.7 ? Math.round((f - b) * 1000) : null; }).filter((x) => x !== null);
        const s = [...d].sort((a, b) => a - b);
        const avg = (l) => Math.round(l.reduce((a, b) => a + b, 0) / l.length);
        const r = { capture, run, streamStarts: starts, flashes: flashes.length, beeps: beeps.length, matched: d.length, pictureLateByMsMedian: s[Math.floor(s.length / 2)], mean: Math.round(d.reduce((a, b) => a + b, 0) / d.length), min: s[0], max: s[s.length - 1], firstThirdMean: avg(d.slice(0, Math.floor(d.length / 3))), lastThirdMean: avg(d.slice(-Math.floor(d.length / 3))), muted: !process.env.SPIKE_AUDIBLE, each: d, error: recorder.error || undefined, notes: notes.filter((t) => /startup|t=|capture|error|fail/i.test(t)) };
        results.push(r); console.log(JSON.stringify({ ...r, each: undefined, notes: undefined }));
      } catch (err) { results.push({ capture, run, error: err.message, notes: [...notes] }); console.log(`${capture} ${run}: ${err.message}`); }
      await wait(1500);
    }
  } catch (err) { console.error(err); results.push({ error: String(err.stack || err) }); }
  fs.writeFileSync(path.join(work, 'av-sync.json'), JSON.stringify(results, null, 1));
  app.exit(0);
});
