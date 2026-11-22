'use strict';
// The recorder's page (a hidden window): draws the source windows into one picture and mixes their sound, then hands both, as raw
// pictures and raw sound, to ffmpeg running as its own program (src/ffmpeg.js), which encodes and writes the file as it goes. Encoding
// outside the app keeps it clear of the graphics process, which a busy Foundry scene can starve (see plan-recording.md).
const { ipcRenderer } = require('electron');
const { spawn } = require('child_process');
const fs = require('fs');
const { buildArgs } = require('../ffmpeg.js');
const Layout = require('./layout.js');

const RATE = 48000;
const AUDIO_CUSHION = 0.04; // seconds of cushion so unevenly arriving audio chunks still play evenly
const AUDIO_OFFSET_MS = 0; // delays the sound against the picture in the file (tuned by measurement; see plan-recording.md)
const VIDEO_DELAY_MS = 255; // the picture is held back this long so it lines up with the audio (measured; see plan-recording.md)

const sources = [null, null]; // the latest frame of each source, held in a canvas
const nextAt = new Map(); // per audio source: when its next chunk should play
const MIC_DELAY = 0.04; // the microphone is played as it arrives, so it waits as long as the windows' sound does (AUDIO_CUSHION)
let camVideo = null; let camStream = null;
let winGain = []; let micGain = null; let micStream = null; let levelTimer = null; let audioCfg = null;
const analysers = []; // [window 1, window 2, microphone, everything]
let drawMsMax = 0; let winFrames = 0; let camFrames = 0; let statsTimer = null;
let previewCanvas = null; let previewPen = null;
let cfg = null; let canvas; let g; let actx; let bus; let proc; let timer;
let enc = null; // { child, video, audio, stderr, codec, stopping }
let framesSent = 0; let framesDropped = 0; let lastFrame = null; let audioWritten = 0; let recording = false;
let t0 = 0; let paused = false; let pausedTotal = 0; let pausedAt = 0; let ticks = 0; let failure = '';

const swizzle = (u32) => { for (let i = 0; i < u32.length; i += 1) { const v = u32[i]; u32[i] = (v & 0xff00ff00) | ((v & 0xff) << 16) | ((v >> 16) & 0xff); } }; // BGRA to RGBA

function onFrame({ i, w, h, buf }) {
  winFrames += 1;
  const data = new Uint8ClampedArray(buf.buffer, buf.byteOffset, buf.byteLength);
  swizzle(new Uint32Array(data.buffer, data.byteOffset, data.byteLength / 4));
  let s = sources[i];
  if (!s || s.width !== w || s.height !== h) { s = document.createElement('canvas'); s.width = w; s.height = h; sources[i] = s; }
  s.getContext('2d').putImageData(new ImageData(data, w, h), 0, 0);
}
// The picture is acknowledged at once (so the app can send the next one) and shown after the delay that lines it up with the sound.
ipcRenderer.on('frame', (_e, msg) => { ipcRenderer.send('recorder:frameAck', msg.i); setTimeout(() => onFrame(msg), VIDEO_DELAY_MS); });

ipcRenderer.on('audio', (_e, { key, win, l, r, rate }) => {
  if (!actx || actx.state === 'closed' || paused) return;
  const n = l.length;
  const buffer = actx.createBuffer(2, n, rate);
  buffer.copyToChannel(new Float32Array(l.buffer ? l.buffer : l), 0);
  buffer.copyToChannel(new Float32Array(r.buffer ? r.buffer : r), 1);
  const node = actx.createBufferSource();
  node.buffer = buffer; node.connect(winGain[win] || bus);
  const now = actx.currentTime;
  let at = nextAt.get(key);
  if (!at || at < now) at = now + AUDIO_CUSHION;
  node.start(at);
  nextAt.set(key, at + n / rate);
});

// Levels and mutes can change while recording. A short ramp avoids clicks.
function applyAudio(a) {
  audioCfg = a;
  const set = (node, level, muted) => { if (node && actx) node.gain.setTargetAtTime(muted ? 0 : level, actx.currentTime, 0.02); };
  set(winGain[0], a.windows[0].level, a.windows[0].muted);
  set(winGain[1], a.windows[1].level, a.windows[1].muted);
  set(micGain, a.mic.level, a.mic.muted);
}
ipcRenderer.on('audio-settings', (_e, a) => applyAudio(a));

function peakOf(analyser, buf) {
  if (!analyser) return 0;
  analyser.getFloatTimeDomainData(buf);
  let peak = 0;
  for (let i = 0; i < buf.length; i += 1) { const v = Math.abs(buf[i]); if (v > peak) peak = v; }
  return peak;
}

const clockMs = () => (paused ? pausedAt : performance.now()) - t0 - pausedTotal;

// One tick of the picture: draw it, then write it to ffmpeg as many times as the clock says it is due (a late tick repeats the last
// picture, so the video keeps the right length even when this window is slow). A pause writes nothing, so the pause is cut out.
function draw() {
  if (failure || paused || !recording || !enc) return;
  const drawStart = performance.now();
  const { width: W, height: H } = canvas;
  Layout.compose(g, W, H, { layout: cfg.layout, camera: cfg.camera, sources, camVideo });
  const px = g.getImageData(0, 0, W, H);
  lastFrame = Buffer.from(px.data.buffer, px.data.byteOffset, px.data.byteLength);
  const due = Math.floor((clockMs() / 1000) * cfg.fps) + 1;
  while (framesSent < due) {
    // ffmpeg takes about a second to start taking pictures, so a few dozen may queue at first. Only if it is badly behind (about two
    // seconds of pictures waiting) are pictures dropped, which shortens the video against the sound, so it is reported.
    if (enc.video.writableLength > lastFrame.length * cfg.fps * 2) { framesDropped += due - framesSent; framesSent = due; break; }
    enc.video.write(lastFrame);
    framesSent += 1;
  }
  ticks += 1;
  drawMsMax = Math.max(drawMsMax, performance.now() - drawStart);
  // A small copy of what is being recorded, for the toolbar's preview (five times a second).
  if (ticks % Math.max(1, Math.round(cfg.fps / 5)) === 0) {
    previewPen.drawImage(canvas, 0, 0, 320, 180);
    const small = previewPen.getImageData(0, 0, 320, 180);
    ipcRenderer.send('recorder:composite', { w: 320, h: 180, buf: new Uint8Array(small.data.buffer) });
  }
}

function fail(err) { if (!failure) { failure = err.message || String(err); ipcRenderer.send('recorder:failed', failure); } }

// Opens a microphone or camera: the one chosen by its id; failing that, the one with the same name (ids can change); failing that, the
// system's own. Only if none can be opened does it fail, and then with the real reason.
async function openDevice(kind, id, label, base) {
  const tries = [];
  if (id) tries.push({ deviceId: { exact: id } });
  if (label) {
    const found = (await navigator.mediaDevices.enumerateDevices()).find((d) => d.kind === `${kind}input` && d.label === label);
    if (found) tries.push({ deviceId: { exact: found.deviceId } });
  }
  tries.push({});
  let last = null;
  for (const t of tries) {
    try { return await navigator.mediaDevices.getUserMedia({ [kind]: { ...base, ...t } }); } catch (err) { last = err; }
  }
  throw last;
}
const why = (err) => (err.name === 'NotAllowedError' ? 'macOS has not allowed it' : `${err.name}${err.message ? `: ${err.message}` : ''}`);

// Starts ffmpeg with the Mac's own encoder, or software if that cannot start. Resolves once it has stayed up for a moment.
function launchEncoder(codec) {
  const args = buildArgs({ width: cfg.width, height: cfg.height, fps: cfg.fps, format: cfg.format, codec, out: cfg.file, offsetMs: AUDIO_OFFSET_MS });
  const child = spawn(cfg.ffmpeg, args, { stdio: ['pipe', 'ignore', 'pipe', 'pipe'] });
  const e = { child, video: child.stdin, audio: child.stdio[3], stderr: '', codec, stopping: false, exited: null };
  child.stderr.on('data', (d) => { e.stderr = (e.stderr + d.toString()).slice(-1500); });
  for (const pipe of [e.video, e.audio]) pipe.on('error', () => { /* ffmpeg went away: its exit is reported below */ });
  e.closed = new Promise((resolve) => child.on('close', (code) => { e.exited = code; resolve(code); }));
  child.on('error', (err) => { e.exited = -1; e.stderr += err.message; });
  return new Promise((resolve, reject) => {
    const timerId = setTimeout(() => resolve(e), 1200);
    e.closed.then((code) => { clearTimeout(timerId); if (!e.stopping) reject(new Error(e.stderr.trim().split('\n').pop() || `ffmpeg stopped (${code})`)); });
  });
}

const frameBytes = () => cfg.width * cfg.height * 4;
let switching = false; let healthTimer = null;

// Replaces a stalled hardware encoder with x264 and starts the file again. The first few seconds are lost; the person is told.
async function switchToSoftware() {
  switching = true;
  ipcRenderer.send('recorder:note', 'The hardware video encoder is not writing anything (the graphics chip is probably fully busy), so the recording restarted with the software encoder. The first few seconds are not in the file.');
  recording = false;
  const old = enc; old.stopping = true;
  try { old.child.kill('SIGKILL'); } catch (err) { /* gone */ }
  await old.closed;
  try { fs.unlinkSync(cfg.file); } catch (err) { /* nothing written */ }
  try {
    enc = await launchEncoder('x264');
    enc.closed.then(() => { if (!enc || enc.stopping || failure) return; fail(new Error(`The video encoder (ffmpeg) stopped on its own${enc.stderr.trim() ? `: ${enc.stderr.trim().split('\n').pop()}` : ''}.`)); });
  } catch (err) { fail(new Error(`The software video encoder could not start: ${err.message}`)); switching = false; return; }
  framesSent = 0; framesDropped = 0; audioWritten = 0; lastFrame = null; pausedTotal = 0; t0 = performance.now(); paused = false;
  recording = true; switching = false;
}

async function start(config) {
  cfg = config;
  sources[0] = sources[1] = null; nextAt.clear(); failure = ''; ticks = 0; pausedTotal = 0; paused = false; recording = false;
  framesSent = 0; framesDropped = 0; audioWritten = 0; lastFrame = null; drawMsMax = 0; winFrames = 0; camFrames = 0;
  canvas = document.createElement('canvas'); canvas.width = cfg.width; canvas.height = cfg.height; g = canvas.getContext('2d', { alpha: false, willReadFrequently: true });
  previewCanvas = document.createElement('canvas'); previewCanvas.width = 320; previewCanvas.height = 180; previewPen = previewCanvas.getContext('2d', { willReadFrequently: true });
  // The Mac's own encoder is the default; 'software' always uses x264. In 'auto', a hardware encoder that stalls is replaced (below).
  const wantHardware = process.platform === 'darwin' && cfg.encoder !== 'software';
  try { enc = await launchEncoder(wantHardware ? 'videotoolbox' : 'x264'); } catch (first) {
    try { enc = await launchEncoder('x264'); } catch (second) { throw new Error(`The video encoder (ffmpeg) could not start: ${second.message}`); }
  }
  enc.closed.then((code) => {
    if (!enc || enc.stopping || failure) return;
    fail(new Error(`The video encoder (ffmpeg) stopped on its own${enc.stderr.trim() ? `: ${enc.stderr.trim().split('\n').pop()}` : ''}. The recording was stopped; what was saved is kept.`));
  });
  // The mixing bus: every source's sound is scheduled onto it, and a processor reads it out in blocks for the encoder.
  actx = new AudioContext({ sampleRate: RATE });
  bus = actx.createGain();
  // Each window's sound goes through its own level and mute, then a meter, then the bus. The microphone does the same.
  const meter = () => { const a = actx.createAnalyser(); a.fftSize = 1024; return a; };
  analysers.length = 0;
  winGain = [actx.createGain(), actx.createGain()];
  winGain.forEach((gain, i) => { const a = meter(); analysers[i] = a; gain.connect(a); a.connect(bus); });
  analysers[2] = meter(); analysers[3] = meter();
  bus.connect(analysers[3]);
  micGain = null; micStream = null;
  if (config.audio && config.audio.mic.enabled) {
    const m = config.audio.mic;
    try {
      micStream = await openDevice('audio', m.device, m.deviceLabel, { echoCancellation: m.echoCancel, noiseSuppression: false, autoGainControl: false, channelCount: 1 });
    } catch (err) { throw new Error(`The microphone could not be opened (${why(err)}).`); }
    const delay = actx.createDelay(1); delay.delayTime.value = MIC_DELAY + (m.delayMs || 0) / 1000;
    micGain = actx.createGain();
    actx.createMediaStreamSource(micStream).connect(delay); delay.connect(micGain); micGain.connect(analysers[2]); analysers[2].connect(bus);
  }
  camVideo = null; camStream = null;
  if (cfg.layout === 'corner' || cfg.layout === 'cam') {
    try {
      camStream = await openDevice('video', cfg.camera.device, cfg.camera.deviceLabel, { width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 30 } });
      camVideo = document.createElement('video'); camVideo.muted = true; camVideo.srcObject = camStream;
      await camVideo.play();
      if (camVideo.requestVideoFrameCallback) { const tick = () => { camFrames += 1; camVideo.requestVideoFrameCallback(tick); }; camVideo.requestVideoFrameCallback(tick); }
    } catch (err) { throw new Error(`The webcam could not be opened (${why(err)}).`); }
  }
  if (config.audio) applyAudio(config.audio);
  const levelBuf = new Float32Array(1024);
  levelTimer = setInterval(() => ipcRenderer.send('recorder:levels', analysers.map((a, i) => (paused || (i === 2 && !micGain) ? 0 : peakOf(a, levelBuf)))), 100);
  proc = actx.createScriptProcessor(1024, 2, 2);
  proc.onaudioprocess = (e) => {
    if (paused || failure || !recording || !enc) return;
    const n = e.inputBuffer.length;
    // The sound is written as it is made (interleaved, 32-bit). Its own clock and the wall clock part ways slowly, so now and then it
    // is brought back in step: silence is added if it has fallen behind, a block is skipped if it has run ahead.
    const expected = Math.round((clockMs() / 1000) * RATE);
    const behind = expected - audioWritten;
    if (behind > RATE * 0.05) { enc.audio.write(Buffer.alloc(behind * 8)); audioWritten += behind; }
    else if (behind < -RATE * 0.05) return;
    const left = e.inputBuffer.getChannelData(0); const right = e.inputBuffer.getChannelData(1);
    const out = new Float32Array(n * 2);
    for (let i = 0; i < n; i += 1) {
      const l = left[i]; const r = right[i];
      out[i * 2] = l > 1 ? 1 : l < -1 ? -1 : l; // mixed sources can add up past full scale: stop at the top rather than wrap
      out[i * 2 + 1] = r > 1 ? 1 : r < -1 ? -1 : r;
    }
    enc.audio.write(Buffer.from(out.buffer));
    audioWritten += n;
  };
  bus.connect(proc); proc.connect(actx.destination);
  t0 = performance.now();
  recording = true;
  timer = setInterval(draw, 1000 / cfg.fps);
  // A hardware encoder that is starved (a busy graphics chip) takes pictures in and writes nothing. In 'auto', the first seconds are
  // watched, and if nothing is being written (or the pictures are piling up) the recording restarts with the software encoder.
  let healthSeconds = 0;
  healthTimer = setInterval(() => {
    healthSeconds += 1;
    if (healthSeconds > 10 || failure || !enc || enc.codec !== 'videotoolbox' || cfg.encoder !== 'auto' || switching || paused) return;
    if (healthSeconds < 4) return;
    let size = 0; try { size = fs.statSync(cfg.file).size; } catch (err) { size = 0; }
    if (size < 4096 || enc.video.writableLength > frameBytes() * 10) switchToSoftware();
  }, 1000);
  let statSeconds = 0;
  statsTimer = setInterval(() => {
    statSeconds += 5;
    if (statSeconds > 60 || failure) return;
    ipcRenderer.send('recorder:note', `t=${statSeconds}s pictures sent ${framesSent} (dropped ${framesDropped}), slowest picture ${Math.round(drawMsMax)} ms, window pictures ${winFrames}, webcam pictures ${camFrames}, encoder ${enc ? enc.codec : '-'}`);
    drawMsMax = 0;
  }, 5000);
}

async function stop() {
  // The picture runs to the very end: the last picture is repeated up to the moment of stopping.
  if (recording && enc && lastFrame) {
    const due = Math.floor((clockMs() / 1000) * cfg.fps);
    while (framesSent < due) { enc.video.write(lastFrame); framesSent += 1; }
  }
  recording = false;
  clearInterval(timer); clearInterval(levelTimer); clearInterval(statsTimer); clearInterval(healthTimer);
  if (micStream) { micStream.getTracks().forEach((t) => t.stop()); micStream = null; }
  if (camStream) { camStream.getTracks().forEach((t) => t.stop()); camStream = null; camVideo = null; }
  if (proc) { proc.onaudioprocess = null; proc.disconnect(); }
  if (enc) {
    // Closing both pipes tells ffmpeg the recording is over; it finishes the file and exits. Not waited for forever.
    enc.stopping = true;
    try { enc.video.end(); enc.audio.end(); } catch (err) { /* already closed */ }
    const code = await Promise.race([enc.closed, new Promise((resolve) => setTimeout(() => resolve('timeout'), 20000))]);
    if (code === 'timeout') { try { enc.child.kill('SIGKILL'); } catch (err) { /* gone */ } fail(new Error('The video encoder did not finish in time; the file may be incomplete.')); }
    else if (code !== 0 && !failure) fail(new Error(`The video encoder (ffmpeg) finished with an error${enc.stderr.trim() ? `: ${enc.stderr.trim().split('\n').pop()}` : ''}.`));
    enc = null;
  }
  if (actx) { await actx.close(); actx = null; }
}

ipcRenderer.on('start', async (_e, config) => {
  try { await start(config); ipcRenderer.send('recorder:started', { ok: true }); } catch (err) { ipcRenderer.send('recorder:started', { ok: false, error: err.message }); }
});
// A snapshot of the recorder's insides, asked for when nothing seems to be getting saved.
ipcRenderer.on('stats', () => {
  ipcRenderer.send('recorder:stats', {
    encoder: enc ? { codec: enc.codec, exited: enc.exited, pipeBacklogMB: Math.round(enc.video.writableLength / 1e6), stderr: enc.stderr.slice(-300) } : null,
    pictures: framesSent, dropped: framesDropped, audioSeconds: Math.round(audioWritten / RATE), failure,
    audioContext: actx ? actx.state : null, mic: Boolean(micStream), camera: camVideo ? `${camVideo.videoWidth}x${camVideo.videoHeight} ready=${camVideo.readyState}` : null,
    paused, sourcesSeen: sources.map((s2) => Boolean(s2)),
  });
});
ipcRenderer.on('stop', async () => { try { await stop(); } catch (err) { fail(err); } finally { ipcRenderer.send('recorder:stopped'); } });
ipcRenderer.on('pause', () => { if (!paused) { paused = true; pausedAt = performance.now(); } });
ipcRenderer.on('resume', () => {
  if (!paused) return;
  pausedTotal += performance.now() - pausedAt; paused = false;
});
