'use strict';
// The recorder: draws what the source windows send into one canvas (the layout), mixes their audio, and writes an MP4 with MediaRecorder.
const { ipcRenderer } = require('electron');

const sources = [null, null]; // latest frame per source window: a canvas holding it
let cfg = null;
let canvas, g, track, rec, chunks, tickTimer, actx, adest, nextAt;
let loopStream = null;
let drawn = 0;
const frameStats = [0, 0];

const swizzle = (u32) => { // BGRA to RGBA, in place
  for (let i = 0; i < u32.length; i += 1) { const v = u32[i]; u32[i] = (v & 0xff00ff00) | ((v & 0xff) << 16) | ((v >> 16) & 0xff); }
};

const VDELAY = Number(process.env.VDELAY) || 0; // ms to hold the picture back so it lines up with the audio
ipcRenderer.on('frame', (_e, msg) => { if (VDELAY) setTimeout(() => onFrame(msg), VDELAY); else onFrame(msg); });
function onFrame({ i, w, h, buf }) {
  const data = new Uint8ClampedArray(buf.buffer, buf.byteOffset, buf.byteLength);
  swizzle(new Uint32Array(data.buffer, data.byteOffset, data.byteLength / 4));
  let s = sources[i];
  if (!s || s.width !== w || s.height !== h) { s = document.createElement('canvas'); s.width = w; s.height = h; sources[i] = s; }
  s.getContext('2d').putImageData(new ImageData(data, w, h), 0, 0);
  frameStats[i] += 1;
}

let tapLoud = false; let tapBeeps = 0; let tapChunks = 0; let tapLoudChunks = 0;
ipcRenderer.on('tap', (_e, { l, r, rate }) => {
  if (!actx) return;
  { let s = 0; for (const x of l) s += x * x; const on = Math.sqrt(s / l.length) > 0.05; tapChunks += 1; if (on) tapLoudChunks += 1; if (on && !tapLoud) { tapBeeps += 1; ipcRenderer.send('log', 'tap beep at ' + Math.round(performance.now())); } tapLoud = on; } // how many beeps the copy itself saw, before mixing and encoding
  const n = l.length;
  const buffer = actx.createBuffer(2, n, rate);
  buffer.copyToChannel(new Float32Array(l.buffer ? l.buffer : l), 0);
  buffer.copyToChannel(new Float32Array(r.buffer ? r.buffer : r), 1);
  const node = actx.createBufferSource();
  node.buffer = buffer;
  node.connect(adest);
  const now = actx.currentTime;
  if (!nextAt || nextAt < now) nextAt = now + (Number(process.env.CUSHION) || 0.12); // a little cushion so chunks that arrive unevenly still play evenly
  node.start(nextAt);
  nextAt += n / rate;
});

function layoutRects(W, H) {
  if (cfg.layout === 'one') return [{ x: 0, y: 0, w: W, h: H }];
  const w = W / 2, h = (w * 720) / 1280;
  return [{ x: 0, y: (H - h) / 2, w, h }, { x: w, y: (H - h) / 2, w, h }];
}

function draw(now) {
  const { width: W, height: H } = canvas;
  g.fillStyle = '#000'; g.fillRect(0, 0, W, H);
  if (cfg.layout === 'synthetic') {
    for (let k = 0; k < 400; k += 1) { g.fillStyle = `hsl(${(k * 7 + now / 20) % 360} 70% 55%)`; g.fillRect((k * 53 + now / 3) % W, (k * 97) % H, 60, 60); }
    g.fillStyle = '#fff'; g.font = '48px system-ui'; g.fillText((now / 1000).toFixed(2), 40, 80);
  } else {
    layoutRects(W, H).forEach((r, i) => { if (sources[i]) g.drawImage(sources[i], r.x, r.y, r.w, r.h); });
  }
  track.requestFrame();
  drawn += 1;
}

function markerRect() { // where the source's white flash lands in the composite
  const W = cfg.width, H = cfg.height;
  const r = layoutRects(W, H)[0];
  const scale = r.w / 1280;
  return { x: r.x, y: r.y, w: 100 * scale, h: 100 * scale };
}

async function startTest(config) {
  cfg = config; tapBeeps = 0; drawn = 0; frameStats[0] = frameStats[1] = 0; chunks = []; nextAt = 0;
  canvas = document.createElement('canvas'); canvas.width = cfg.width; canvas.height = cfg.height; g = canvas.getContext('2d');
  const stream = canvas.captureStream(0);
  track = stream.getVideoTracks()[0];
  actx = null;
  if (cfg.audio === 'tap') { // each page's own audio, copied out of the page and mixed here
    actx = new AudioContext({ sampleRate: 48000 });
    adest = actx.createMediaStreamDestination();
    adest.stream.getAudioTracks().forEach((t) => stream.addTrack(t));
  } else if (cfg.audio === 'loopback') { // everything the computer plays (system audio), through the display-capture API
    const s = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
    ipcRenderer.send('log', `loopback tracks: video ${s.getVideoTracks().length}, audio ${s.getAudioTracks().length} ${s.getAudioTracks().map((t) => t.label + ' ' + t.readyState).join(',')}`);
    loopStream = s; // keep the screen part alive: stopping it ends the system audio too
    s.getAudioTracks().forEach((t) => stream.addTrack(t));
  }
  const candidates = cfg.audio
    ? ['video/mp4;codecs=avc1.640028,mp4a.40.2', 'video/mp4;codecs=avc1,mp4a.40.2', 'video/webm;codecs=vp9,opus']
    : ['video/mp4;codecs=avc1.640028', 'video/mp4;codecs=avc1', 'video/webm;codecs=vp9'];
  const mimeType = candidates.find((m) => MediaRecorder.isTypeSupported(m)) || '';
  rec = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 8_000_000, audioBitsPerSecond: 128_000 });
  rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); }; // Blobs are held by the browser, which can keep them off the JS heap
  const started = performance.now();
  rec.start(1000);
  tickTimer = setInterval(() => draw(performance.now() - started), 1000 / cfg.fps);
  return { mimeType };
}

async function stopTest() {
  clearInterval(tickTimer);
  const done = new Promise((resolve) => { rec.onstop = resolve; });
  rec.stop();
  await done;
  if (actx) { await actx.close(); actx = null; }
  if (loopStream) { loopStream.getTracks().forEach((t) => t.stop()); loopStream = null; }
  const blob = new Blob(chunks, { type: rec.mimeType });
  const written = blob.size;
  for (let at = 0; at < blob.size; at += 16 * 1024 * 1024) ipcRenderer.send('chunk', await blob.slice(at, at + 16 * 1024 * 1024).arrayBuffer()); // to disk in slices, never one giant buffer
  const file = await ipcRenderer.invoke('finish', rec.mimeType);
  const analysis = await analyze(file);
  return { file, bytes: written, mimeType: rec.mimeType, drawn, sourceFrames: [...frameStats], tapBeeps, tapChunks, tapLoudChunks, analysis };
}

// Play the recording back and measure it: how many frames really made it, the longest gap, and (when the source flashes and beeps
// together) how far apart the flash and the beep are in the file.
async function analyze(file) {
  const v = document.createElement('video');
  v.src = 'file://' + file;
  v.muted = false;
  await new Promise((resolve, reject) => { v.onloadedmetadata = resolve; v.onerror = () => reject(new Error('cannot decode the recording')); });
  const out = { width: v.videoWidth, height: v.videoHeight, duration: v.duration };
  const mr = cfg.layout === 'synthetic' ? null : markerRect();
  const probe = document.createElement('canvas'); probe.width = 16; probe.height = 16; const pg = probe.getContext('2d', { willReadFrequently: true });
  const frames = []; const flashes = []; const beeps = [];
  let bright = false; let loud = false;
  let analyser = null; let samples = null; let ac = null;
  if (cfg.audio) {
    ac = new AudioContext();
    const src = ac.createMediaElementSource(v);
    analyser = ac.createAnalyser(); analyser.fftSize = 1024; src.connect(analyser);
    samples = new Float32Array(analyser.fftSize);
  }
  v.playbackRate = out.duration > 120 ? 4 : 1; // a long recording is checked at 4x speed
  const onFrame = (_now, meta) => {
    frames.push(meta.mediaTime);
    if (mr) {
      pg.drawImage(v, mr.x, mr.y, mr.w, mr.h, 0, 0, 16, 16);
      const px = pg.getImageData(0, 0, 16, 16).data;
      let sum = 0; for (let k = 0; k < px.length; k += 4) sum += px[k];
      const on = sum / (px.length / 4) > 160;
      if (on && !bright) flashes.push(meta.mediaTime);
      bright = on;
    }
    if (!v.ended) v.requestVideoFrameCallback(onFrame);
  };
  v.requestVideoFrameCallback(onFrame);
  const poll = setInterval(() => {
    if (!analyser) return;
    analyser.getFloatTimeDomainData(samples);
    let s = 0; for (const x of samples) s += x * x;
    const on = Math.sqrt(s / samples.length) > 0.05;
    if (on && !loud) beeps.push(v.currentTime);
    loud = on;
  }, 5);
  await v.play();
  await new Promise((resolve) => { v.onended = resolve; });
  clearInterval(poll);
  if (ac) await ac.close();
  let maxGap = 0; for (let k = 1; k < frames.length; k += 1) maxGap = Math.max(maxGap, frames[k] - frames[k - 1]);
  out.framesPlayed = frames.length;
  out.effectiveFps = Math.round((frames.length / out.duration) * 10) / 10;
  out.maxFrameGapMs = Math.round(maxGap * 1000);
  if (mr && cfg.audio) {
    const offsets = flashes.slice(1).map((f) => { const b = beeps.reduce((best, x) => (Math.abs(x - f) < Math.abs(best - f) ? x : best), Infinity); return Math.round((b - f) * 1000); });
    out.flashes = flashes.length; out.beeps = beeps.length; out.beepMinusFlashMs = offsets;
  }
  return out;
}

ipcRenderer.on('start', async (_e, config) => ipcRenderer.send('started', await startTest(config)));
ipcRenderer.on('stop', async () => ipcRenderer.send('stopped', await stopTest()));
