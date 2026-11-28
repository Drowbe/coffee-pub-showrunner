'use strict';
// Spike, question 2 (and the screen-against-snapshot delay in question 4). Run: npx electron scripts/spike/window-capture.js <out.json>
// Starts Showrunner itself (with its own throwaway data folder, and its Game window showing target.html), then measures what two ways
// of capturing that window deliver while it is visible, covered, minimised and on another monitor. It takes over the screen for a
// few minutes. SPIKE_PROBE=1 only tries other ways of asking for 60 frames a second.
const { app, BrowserWindow, desktopCapturer, ipcMain, screen, session } = require('electron');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const PORT = 38911;
const data = fs.mkdtempSync(path.join(os.tmpdir(), 'showrunner-spike-capture-'));
app.setPath('userData', data); // never the real settings
fs.writeFileSync(path.join(data, 'config.json'), JSON.stringify({ version: 15, dock: { enabled: false }, obs: { autoConnect: false },
  views: [{ id: 'game', label: 'Game', url: `http://127.0.0.1:${PORT}/`, width: 1920, height: 1080, x: 40, y: 20, enabled: true, dockOnLaunch: false }] }));
http.createServer((_req, res) => { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(fs.readFileSync(path.join(__dirname, 'target.html'))); }).listen(PORT, '127.0.0.1');
require('../../src/main.js'); // the app as it is, with its command line switches

const out = process.argv.find((a) => a.endsWith('.json')) || path.join(os.tmpdir(), 'window-capture.json');
const BAR = 28; const SECONDS = Number(process.env.SPIKE_SECONDS || 8);
const TITLE = 'Coffee Pub Showrunner - Game';
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const once = (channel) => new Promise((resolve) => ipcMain.once(channel, (_e, v) => resolve(v)));
const results = { machine: {}, screen: [], snapshots: [], probe: [], notes: [] };
ipcMain.on('capture:note', (_e, t) => results.notes.push(t));

let target; let page; let cover; let capture;
const drawn = () => page.webContents.executeJavaScript('window.drawn'); // frames the page has drawn so far

function makeCover(bounds) {
  cover = new BrowserWindow({ ...bounds, frame: false, show: false, resizable: false, focusable: false, skipTaskbar: true, backgroundColor: '#444444', title: 'spike cover' });
  cover.setAlwaysOnTop(true, 'screen-saver'); cover.showInactive(); cover.setBounds(bounds);
}
function dropCover() { if (cover && !cover.isDestroyed()) cover.destroy(); cover = null; }

async function arrange(name) {
  dropCover();
  if (target.isMinimized()) target.restore();
  const [one, two] = [screen.getPrimaryDisplay(), screen.getAllDisplays().find((d) => d.id !== screen.getPrimaryDisplay().id)];
  const place = (d) => { target.setPosition(d.workArea.x + 40, d.workArea.y + 20); };
  target.setContentSize(1920, 1080 + BAR); page.setBounds({ x: 0, y: BAR, width: 1920, height: 1080 });
  place(one); target.setAlwaysOnTop(true); target.showInactive(); target.moveTop(); target.focus();
  const b = target.getBounds();
  if (name === 'partly covered') makeCover({ x: b.x + Math.round(b.width / 2), y: b.y, width: Math.round(b.width / 2) + 20, height: b.height });
  if (name === 'fully covered') makeCover({ x: b.x - 20, y: b.y - 10, width: b.width + 40, height: b.height + 20 });
  if (name === 'minimised') { target.setMinimizable(true); target.minimize(); }
  if (name === 'other monitor (window taller than it)' || name === 'other monitor (window fits)') {
    if (!two) return false;
    if (name.endsWith('(window fits)')) { target.setContentSize(1024, 576 + BAR); page.setBounds({ x: 0, y: BAR, width: 1024, height: 576 }); }
    place(two);
  }
  return true;
}

const CASES = ['visible', 'partly covered', 'fully covered', 'minimised', 'restored after minimise', 'other monitor (window taller than it)', 'other monitor (window fits)'];

async function listed() {
  const list = await desktopCapturer.getSources({ types: ['window'], thumbnailSize: { width: 0, height: 0 } });
  return list.find((s) => s.id === target.getMediaSourceId() || s.name === TITLE) || null;
}

// `min` also asks for at least that rate, which recorder.js does not do today.
async function screenRun(fps, min = false) {
  await arrange('visible'); await wait(1500);
  const source = await listed();
  if (!source) { results.notes.push('the target window is not in desktopCapturer.getSources'); return; }
  results.machine.sourceIdFromList = source.id; results.machine.sourceIdFromWindow = target.getMediaSourceId();
  const scale = screen.getDisplayMatching(target.getBounds()).scaleFactor;
  const opened = once('capture:opened');
  capture.webContents.send('open', { sourceId: source.id, fps, scale, min });
  const o = await opened;
  if (!o.ok) { results.notes.push(`open at ${fps} fps failed: ${o.error}`); return; }
  for (const name of CASES) {
    if (!(await arrange(name))) continue;
    await wait(2000);
    const inList = Boolean(await listed());
    const from = await drawn(); capture.webContents.send('reset'); await wait(SECONDS * 1000);
    const pageFps = +(((await drawn()) - from) / SECONDS).toFixed(1);
    const rep = once('capture:report'); capture.webContents.send('report', SECONDS);
    const r = await rep;
    const b = target.getBounds(); const c = target.getContentBounds(); const p = page.getBounds(); const s = screen.getDisplayMatching(b).scaleFactor;
    // Where recorder.js ScreenSource would look for the page, against where it really is in the captured picture.
    const [vw] = String(r.videoSize).split('x').map(Number); const k = vw && b.width ? vw / b.width : 1;
    results.screen.push({ fps, minFrameRate: min, case: name, ...r, targetPageFps: pageFps, listedInGetSources: inList, minimised: target.isMinimized(), winBounds: b, contentBounds: c, scaleFactor: s,
      recorderWouldCropAt: { x: Math.round((c.x - b.x + p.x) * k), y: Math.round((c.y - b.y + p.y) * k) } });
    console.log(`screen ${fps}${min ? ' min' : ''} | ${name} | delivered ${r.deliveredFps} fresh ${r.freshFps} lat ${r.latencyMedianMs}/${r.latencyP95Ms} ms | page ${pageFps} | ${r.videoSize}`);
  }
  // Can a new capture be started while the window is minimised?
  await arrange('minimised'); await wait(1000);
  results.notes.push(`${fps} fps: minimised window listed by getSources: ${Boolean(await listed())}`);
  const closed = once('capture:closed'); capture.webContents.send('close'); await closed;
  await arrange('visible');
}

// Extra: at 60 fps, does any other way of asking deliver more than 30? Visible window only. (SPIKE_PROBE=1)
async function probe60() {
  await arrange('visible'); await wait(1500);
  const source = await listed(); const scale = screen.getDisplayMatching(target.getBounds()).scaleFactor;
  session.defaultSession.setDisplayMediaRequestHandler((_request, callback) => callback({ video: source }));
  const variants = [['getUserMedia max 60 (as the recorder)', {}], ['getUserMedia max 60, no size limit', { noSize: true }], ['getUserMedia max 120', { fps: 120 }], ['getDisplayMedia 60', { display: true }]];
  for (const [name, extra] of variants) {
    const opened = once('capture:opened');
    await capture.webContents.executeJavaScript(`openCapture(${JSON.stringify({ sourceId: source.id, fps: 60, scale, ...extra })}); true`, true);
    const o = await opened;
    if (!o.ok) { results.probe.push({ name, error: o.error }); console.log(`probe | ${name} | ${o.error}`); continue; }
    await wait(1500); capture.webContents.send('reset'); await wait(SECONDS * 1000);
    const rep = once('capture:report'); capture.webContents.send('report', SECONDS); const r = await rep;
    results.probe.push({ name, ...r, trackSettings: o.settings });
    console.log(`probe | ${name} | delivered ${r.deliveredFps} fresh ${r.freshFps} lat ${r.latencyMedianMs}/${r.latencyP95Ms} ms | track says ${o.settings.frameRate}`);
    const closed = once('capture:closed'); capture.webContents.send('close'); await closed;
  }
}

// The "Built-in snapshots" way: the same loop as recorder.js start() (capturePage, one at a time, on a timer).
async function snapshotRun(fps) {
  for (const name of CASES) {
    if (!(await arrange(name))) continue;
    await wait(2000);
    const lat = []; const seen = new Set(); let n = 0; let busy = false; let errors = 0; let empty = 0; const from = await drawn();
    const scale = screen.getDisplayMatching(target.getBounds()).scaleFactor;
    const timer = setInterval(async () => {
      if (busy) return; busy = true;
      try {
        const image = await page.webContents.capturePage();
        const now = Date.now(); const { width, height } = image.getSize();
        if (!width || !height) { empty += 1; return; }
        const bmp = image.toBitmap(); n += 1;
        const row = (r) => { let v = 0; for (let i = 0; i < 32; i += 1) { const x = Math.floor((100 + (i + 0.5) * 24) * scale); const y = Math.floor((100 + (r + 0.5) * 24) * scale); v = v * 2 + (bmp[(y * width + x) * 4 + 1] > 127 ? 1 : 0); } return v; };
        const t = row(0); const count = row(1);
        if (((~t) >>> 0) === row(2) && count > 0) { seen.add(count); lat.push((now % 4294967296) - t); }
      } catch (err) { errors += 1; } finally { busy = false; }
    }, 1000 / fps);
    await wait(SECONDS * 1000); clearInterval(timer);
    const s = [...lat].sort((a, b) => a - b); const q = (p) => (s.length ? s[Math.min(s.length - 1, Math.floor(s.length * p))] : null);
    const r = { fps, case: name, deliveredFps: +(n / SECONDS).toFixed(1), freshFps: +(seen.size / SECONDS).toFixed(1), latencyMedianMs: q(0.5), latencyP95Ms: q(0.95), targetPageFps: +(((await drawn()) - from) / SECONDS).toFixed(1), errors, empty };
    results.snapshots.push(r);
    console.log(`snapshots ${fps} | ${name} | delivered ${r.deliveredFps} fresh ${r.freshFps} lat ${r.latencyMedianMs}/${r.latencyP95Ms} ms | page ${r.targetPageFps}`);
  }
  await arrange('visible');
}

app.whenReady().then(async () => {
  try {
    results.machine.displays = screen.getAllDisplays().map((d) => ({ bounds: d.bounds, scaleFactor: d.scaleFactor, hz: d.displayFrequency, primary: d.id === screen.getPrimaryDisplay().id }));
    results.machine.electron = process.versions.electron; results.machine.chrome = process.versions.chrome;
    for (let i = 0; i < 100 && !target; i += 1) { await wait(200); target = BrowserWindow.getAllWindows().find((w) => w.getTitle() === TITLE && w.isVisible()); }
    if (!target) throw new Error('the Game window did not open');
    page = target.contentView.children[0];
    for (let i = 0; i < 50 && !(await drawn()); i += 1) await wait(200);
    capture = new BrowserWindow({ show: false, width: 320, height: 180, webPreferences: { nodeIntegration: true, contextIsolation: false, backgroundThrottling: false, autoplayPolicy: 'no-user-gesture-required' } });
    await capture.loadFile(path.join(__dirname, 'capture.html'));
    if (process.env.SPIKE_PROBE) await probe60();
    else {
      for (const fps of [30, 60]) await screenRun(fps);
      await screenRun(60, true);
      for (const fps of [30, 60]) await snapshotRun(fps);
    }
  } catch (err) { results.notes.push(`failed: ${err.stack || err}`); console.error(err); }
  fs.writeFileSync(out, JSON.stringify(results, null, 1));
  console.log(`written ${out}`);
  app.exit(0);
});
