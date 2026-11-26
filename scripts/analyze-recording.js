'use strict';
// Plays a recording back and measures it (frames, longest gap, and how far the beep is from the flash when the source flashes and
// beeps together, as spikes/recording/page.html does): electron scripts/analyze-recording.js <file.mp4> [flashSize]
const { app, BrowserWindow } = require('electron');

const file = process.argv.find((a) => a.endsWith('.mp4'));
const flash = Number(process.argv.find((a) => /^\d+$/.test(a)) || 150); // pixels of the flash square in the recording
if (!file) { console.error('usage: electron scripts/analyze-recording.js <file.mp4> [flashSize]'); process.exit(1); }

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, webPreferences: { nodeIntegration: true, contextIsolation: false, backgroundThrottling: false, autoplayPolicy: 'no-user-gesture-required' } });
  await win.loadFile(__filename); // any local file will do: the page needs a file:// origin to play a local recording
  const result = await win.webContents.executeJavaScript(`(async () => {
    const v = document.createElement('video'); v.src = ${JSON.stringify('file://' + file)};
    await new Promise((res, rej) => { v.onloadedmetadata = res; v.onerror = () => rej(new Error('cannot decode')); });
    const out = { width: v.videoWidth, height: v.videoHeight, duration: v.duration };
    const probe = document.createElement('canvas'); probe.width = 16; probe.height = 16; const pg = probe.getContext('2d', { willReadFrequently: true });
    const ac = new AudioContext(); const an = ac.createAnalyser(); an.fftSize = 1024; ac.createMediaElementSource(v).connect(an);
    const buf = new Float32Array(1024); const frames = []; const flashes = []; const beeps = []; let bright = false, loud = false;
    const onFrame = (_n, meta) => {
      frames.push(meta.mediaTime);
      pg.drawImage(v, 0, 0, ${flash}, ${flash}, 0, 0, 16, 16);
      const px = pg.getImageData(0, 0, 16, 16).data; let s = 0; for (let k = 0; k < px.length; k += 4) s += px[k];
      const on = s / (px.length / 4) > 160; if (on && !bright) flashes.push(meta.mediaTime); bright = on;
      if (!v.ended) v.requestVideoFrameCallback(onFrame);
    };
    v.requestVideoFrameCallback(onFrame);
    const poll = setInterval(() => { an.getFloatTimeDomainData(buf); let s = 0; for (const x of buf) s += x * x; const on = Math.sqrt(s / buf.length) > 0.05; if (on && !loud) beeps.push(v.currentTime); loud = on; }, 5);
    await v.play(); await new Promise((res) => { v.onended = res; }); clearInterval(poll);
    let gap = 0; for (let k = 1; k < frames.length; k += 1) gap = Math.max(gap, frames[k] - frames[k - 1]);
    out.effectiveFps = Math.round((frames.length / out.duration) * 10) / 10; out.maxFrameGapMs = Math.round(gap * 1000);
    out.flashes = flashes.length; out.beeps = beeps.length;
    out.beepMinusFlashMs = flashes.slice(1).map((f) => { const b = beeps.reduce((best, x) => (Math.abs(x - f) < Math.abs(best - f) ? x : best), Infinity); return Math.round((b - f) * 1000); });
    return out;
  })()`);
  console.log(JSON.stringify(result));
  app.quit();
}).catch((err) => { console.error(err.message); app.exit(1); });
