'use strict';
// The recorder's page (a hidden window): draws the source windows into one picture and mixes their sound, then hands both, as raw
// pictures and raw sound, to ffmpeg running as its own program (src/ffmpeg.js), which encodes and writes the file as it goes. Encoding
// outside the app keeps it clear of the graphics process, which a busy Foundry scene can starve (see plan-recording.md).
const { ipcRenderer } = require('electron');
const { spawn } = require('child_process');
const fs = require('fs');
const { buildArgs } = require('../ffmpeg.js');
const Layout = require('./layout.js');
const Segment = require('./segment.js'); // finds the person in the webcam picture, for the background blur

const RATE = 48000;
const AUDIO_CUSHION = 0.12; // seconds of cushion so unevenly arriving audio chunks still play evenly (less than this left audible gaps)
const AUDIO_OFFSET_MS = 0; // delays the sound against the picture in the file (tuned by measurement; see plan-recording.md)
const VIDEO_DELAY_MS = 335;
const SCREEN_LATENCY_MS = 60; // a live screen capture is this late (a guess to be tuned by measurement); the sound is brought forward by the difference // the picture is held back this long so it lines up with the audio (measured; see plan-recording.md)

const sources = [null, null]; // the latest frame of each source, held in a canvas
const nextAt = new Map(); // per audio source: when its next chunk should play
const MIC_DELAY = AUDIO_CUSHION; // the microphone is played as it arrives, so it waits as long as the windows' sound does (AUDIO_CUSHION)
let camVideo = null; let camStream = null;
let winGain = []; let micGain = null; let micStream = null; let levelTimer = null; let audioCfg = null;
const analysers = []; // [window 1, window 2, microphone, everything]
let maskCanvas = null; let segTimer = null; let segMsTotal = 0; let segCount = 0; let micPeakSeen = 0; let drawMsMax = 0; let winFrames = 0; let camFrames = 0; let statsTimer = null;
let previewCanvas = null; let previewPen = null;
let cfg = null; let canvas; let g; let actx; let bus; let proc; let timer;
let enc = null; // { child, video, audio, stderr, codec, stopping }
let audioLead = 0; let audioSkip = 0; const offsetBuckets = new Map();
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
  Layout.compose(g, W, H, { layout: cfg.layout, camera: cfg.camera, sources, camVideo, fit: cfg.fit, camMask: maskCanvas });
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
// Devices opened ahead of Record (while the toolbar is open), kept by a key of what was asked for. A promise, so a Record pressed
// while they are still opening simply waits for them.
const warmDev = { mic: null, cam: null };
const micKey = (m) => `${m.device}|${m.deviceLabel}|${m.echoCancel}`;
const camKey = (c) => `${c.device}|${c.deviceLabel}`;
const openMic = (m) => openDevice('audio', m.device, m.deviceLabel, { echoCancellation: m.echoCancel, noiseSuppression: false, autoGainControl: false, channelCount: 1 });
async function openCam(c) {
  const stream = await openDevice('video', c.device, c.deviceLabel, { width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 30 } });
  const video = document.createElement('video'); video.muted = true; video.srcObject = stream;
  await video.play();
  return { stream, video };
}
function dropWarm(which) {
  const w = warmDev[which]; warmDev[which] = null;
  if (w) w.promise.then((r) => (which === 'mic' ? r : r.stream).getTracks().forEach((t) => t.stop())).catch(() => {});
}
// The person in a webcam picture, found in a small copy of it (so it stays cheap): { data, width, height } or null.
const segWork = { small: null, pen: null };
function maskFrom(video) {
  if (!segWork.small) { segWork.small = document.createElement('canvas'); segWork.pen = segWork.small.getContext('2d', { willReadFrequently: true }); }
  const { small, pen } = segWork;
  small.width = 384; small.height = Math.max(2, Math.round(384 * video.videoHeight / video.videoWidth));
  pen.drawImage(video, 0, 0, small.width, small.height);
  return Segment.segment(small, Math.round(performance.now()));
}

// While the toolbar is open and no recording is running, the person is still found ten times a second and the outline sent to the
// toolbar, so its preview shows the blur before recording starts.
let idleSegTimer = null; let idleVideo = null;
function stopIdleBlur() { clearInterval(idleSegTimer); idleSegTimer = null; idleVideo = null; }
function idleBlur(c, wantCam) {
  const want = wantCam && c.camera && c.camera.background === 'blur' && warmDev.cam;
  if (!want) { stopIdleBlur(); return; }
  warmDev.cam.promise.then((r) => { idleVideo = r.video; }).catch(() => {});
  if (idleSegTimer) return;
  Segment.load().then(() => {
    if (idleSegTimer || recording || enc) return;
    idleSegTimer = setInterval(() => {
      if (recording || enc || !idleVideo || !idleVideo.videoWidth) return;
      try {
        const m = maskFrom(idleVideo);
        if (!m) return;
        const alpha = new Uint8Array(m.data.length);
        for (let i = 0; i < alpha.length; i += 1) alpha[i] = Math.round(m.data[i] * 255);
        ipcRenderer.send('recorder:mask', { w: m.width, h: m.height, buf: alpha });
      } catch (err) { /* one picture missed */ }
    }, 100);
  }).catch(() => {});
}

ipcRenderer.on('warm', (_e, c) => {
  if (recording || enc) return;
  const wantMic = c.audio && c.audio.mic.enabled; const wantCam = c.layout === 'corner' || c.layout === 'cam';
  if (!wantMic || (warmDev.mic && warmDev.mic.key !== micKey(c.audio.mic))) dropWarm('mic');
  if (!wantCam || (warmDev.cam && warmDev.cam.key !== camKey(c.camera))) dropWarm('cam');
  if (c.camera && c.camera.background === 'blur' && wantCam) Segment.load().catch(() => {}); // the person finder is made ready too
  if (wantMic && !warmDev.mic) { const p = openMic(c.audio.mic); p.catch(() => { warmDev.mic = null; }); warmDev.mic = { key: micKey(c.audio.mic), promise: p }; }
  if (wantCam && !warmDev.cam) { const p = openCam(c.camera); p.catch(() => { warmDev.cam = null; }); warmDev.cam = { key: camKey(c.camera), promise: p }; }
  idleBlur(c, wantCam);
});
async function takeDevice(which, key, open) {
  const w = warmDev[which];
  if (w && w.key === key) { warmDev[which] = null; try { return await w.promise; } catch (err) { /* fall through to a fresh open */ } }
  dropWarm(which);
  return open();
}

// A window taken live from the system's screen capture. Only the page is wanted (the bar and frame are cropped away), so it knows where
// the page sits inside the window, in the window's own units; the video's pixels per unit tell it how big that is on the video.
class ScreenSource {
  constructor(video, stream, info) { this.video = video; this.stream = stream; this.info = info; }
  get scale() { return this.video.videoWidth && this.info.winW ? this.video.videoWidth / this.info.winW : 1; }
  get width() { return this.video.videoWidth ? Math.max(1, Math.round(this.info.rect.w * this.scale)) : 0; }
  get height() { return this.video.videoWidth ? Math.max(1, Math.round(this.info.rect.h * this.scale)) : 0; }
  drawTo(g, dx, dy, dw, dh, sx = 0, sy = 0, sw = this.width, sh = this.height) {
    const k = this.scale; const r = this.info.rect;
    g.drawImage(this.video, r.x * k + sx, r.y * k + sy, sw, sh, dx, dy, dw, dh);
  }
}
async function openScreen(info, fps) {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { mandatory: { chromeMediaSource: 'desktop', chromeMediaSourceId: info.sourceId, maxFrameRate: fps, maxWidth: 3840, maxHeight: 2160 } } });
  const video = document.createElement('video'); video.muted = true; video.srcObject = stream;
  await video.play();
  if (video.requestVideoFrameCallback) { const tick = () => { winFrames += 1; video.requestVideoFrameCallback(tick); }; video.requestVideoFrameCallback(tick); }
  stream.getVideoTracks()[0].onended = () => fail(new Error('The screen capture of a window stopped (the window was closed?). The recording was stopped; what was saved is kept.'));
  return new ScreenSource(video, stream, info);
}
let screenSources = [];
ipcRenderer.on('screen-rects', (_e, list) => { (list || []).forEach((info, i) => { if (screenSources[i] && info) screenSources[i].info = info; }); });

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
  audioLead = cfg.capture === 'screen' ? Math.round(((VIDEO_DELAY_MS - SCREEN_LATENCY_MS) / 1000) * RATE) : 0; audioSkip = audioLead;
  framesSent = 0; framesDropped = 0; audioWritten = 0; lastFrame = null; drawMsMax = 0; winFrames = 0; camFrames = 0;
  canvas = document.createElement('canvas'); canvas.width = cfg.width; canvas.height = cfg.height; g = canvas.getContext('2d', { alpha: false, willReadFrequently: true });
  previewCanvas = document.createElement('canvas'); previewCanvas.width = 320; previewCanvas.height = 180; previewPen = previewCanvas.getContext('2d', { willReadFrequently: true });
  // The Mac's own encoder is the default; 'software' always uses x264. In 'auto', a hardware encoder that stalls is replaced (below).
  const wantHardware = process.platform === 'darwin' && cfg.encoder !== 'software';
  // The encoder, the microphone and the webcam open at the same time (the last two are usually already open, from the toolbar).
  const s0 = performance.now(); const steps = [];
  const timed = (name, p) => p.then((v) => { steps.push(`${name} ${Math.round(performance.now() - s0)} ms`); return v; });
  const encP = timed('encoder', (async () => {
    try { return await launchEncoder(wantHardware ? 'videotoolbox' : 'x264'); } catch (first) {
      try { return await launchEncoder('x264'); } catch (second) { throw new Error(`The video encoder (ffmpeg) could not start: ${second.message}`); }
    }
  })());
  const wantMic = Boolean(config.audio && config.audio.mic.enabled);
  const wantCam = cfg.layout === 'corner' || cfg.layout === 'cam';
  const micP = wantMic ? timed('microphone', takeDevice('mic', micKey(config.audio.mic), () => openMic(config.audio.mic))) : Promise.resolve(null);
  const camP = wantCam ? timed('webcam', takeDevice('cam', camKey(cfg.camera), () => openCam(cfg.camera))) : Promise.resolve(null);
  stopIdleBlur(); // recording finds the person itself from here
  screenSources = [];
  const screenP = cfg.capture === 'screen' ? timed('screen capture', Promise.all((cfg.screens || []).map((info) => openScreen(info, cfg.fps)))) : Promise.resolve([]);
  const [encR, micR, camR, screenR] = await Promise.allSettled([encP, micP, camP, screenP]);
  if (encR.status === 'fulfilled') enc = encR.value;
  const closeOpened = () => {
    for (const r of [micR, camR]) if (r.status === 'fulfilled' && r.value) (r.value.stream || r.value).getTracks().forEach((t) => t.stop());
    if (screenR.status === 'fulfilled') screenR.value.forEach((src) => src.stream.getTracks().forEach((t) => t.stop()));
  };
  if (encR.status === 'rejected') { closeOpened(); throw encR.reason; }
  if (micR.status === 'rejected') { closeOpened(); throw new Error(`The microphone could not be opened (${why(micR.reason)}).`); }
  if (screenR.status === 'rejected') { closeOpened(); throw new Error(`A window could not be captured (${why(screenR.reason)}). Check that Showrunner is allowed to capture windows (macOS Screen Recording), and that the window is open and on screen.`); }
  screenSources = screenR.value || [];
  if (cfg.capture === 'screen' && cfg.layout !== 'cam' && !screenSources.length) { closeOpened(); throw new Error('The window to record could not be found. Open it, and make sure it is on screen.'); }
  screenSources.forEach((src, i) => { sources[i] = src; });
  if (camR.status === 'rejected') { closeOpened(); throw new Error(`The webcam could not be opened (${why(camR.reason)}).`); }
  micStream = micR.value;
  if (micStream) {
    const track = micStream.getAudioTracks()[0]; const st = track ? track.getSettings() : {};
    ipcRenderer.send('recorder:note', `microphone: ${track ? track.label : 'no track'}, echo cancel ${st.echoCancellation}, state ${track ? track.readyState : '-'}`);
    if (track) { track.onended = () => ipcRenderer.send('recorder:note', 'microphone: the device stopped (unplugged or taken by another program)'); track.onmute = () => ipcRenderer.send('recorder:note', 'microphone: the system muted it'); track.onunmute = () => ipcRenderer.send('recorder:note', 'microphone: sound is flowing again'); }
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
  micGain = null;
  if (micStream) {
    const m = config.audio.mic;
    const delay = actx.createDelay(1); delay.delayTime.value = MIC_DELAY + (m.delayMs || 0) / 1000;
    micGain = actx.createGain();
    actx.createMediaStreamSource(micStream).connect(delay); delay.connect(micGain); micGain.connect(analysers[2]); analysers[2].connect(bus);
  }
  camVideo = null; camStream = null;
  if (camR.value) {
    camStream = camR.value.stream; camVideo = camR.value.video;
    if (camVideo.requestVideoFrameCallback) { const tick = () => { camFrames += 1; camVideo.requestVideoFrameCallback(tick); }; camVideo.requestVideoFrameCallback(tick); }
  }
  // Background blur: the person is found in a small copy of the webcam picture about fifteen times a second, on the processor.
  maskCanvas = null; clearInterval(segTimer); segMsTotal = 0; segCount = 0;
  if (cfg.camera && cfg.camera.background === 'blur' && camVideo) {
    try {
      await Segment.load();
      let mask = null; let image = null;
      segTimer = setInterval(() => {
        if (!recording || paused || !camVideo.videoWidth) return;
        try {
          const t = performance.now();
          const m = maskFrom(camVideo);
          if (!m) return;
          if (!mask) { mask = document.createElement('canvas'); }
          if (mask.width !== m.width || mask.height !== m.height) { mask.width = m.width; mask.height = m.height; image = new ImageData(m.width, m.height); }
          for (let i = 0; i < m.data.length; i += 1) image.data[i * 4 + 3] = Math.round(m.data[i] * 255);
          mask.getContext('2d').putImageData(image, 0, 0);
          maskCanvas = mask;
          segMsTotal += performance.now() - t; segCount += 1;
        } catch (err) { /* one picture missed; the next will do */ }
      }, 66);
    } catch (err) { ipcRenderer.send('recorder:note', `background blur is not available (${err.message}); recording without it`); }
  }
  if (config.audio) applyAudio(config.audio);
  const levelBuf = new Float32Array(1024);
  levelTimer = setInterval(() => { const levels = analysers.map((a, i) => (paused || (i === 2 && !micGain) ? 0 : peakOf(a, levelBuf))); if (levels[2] > micPeakSeen) micPeakSeen = levels[2]; ipcRenderer.send('recorder:levels', levels); }, 100);
  await actx.audioWorklet.addModule('tap-worklet.js');
  proc = new AudioWorkletNode(actx, 'recorder-tap', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2] });
  offsetBuckets.clear();
  // Sound chunks can reach this page late (it is busy for a moment when the game is) but never lost; each carries the audio clock's time
  // for its start. The audio clock is tied to the wall clock by the least-delayed chunk in the last few seconds (a late chunk is only
  // ever late), so a stall here never looks like missing sound. Real drift between the two clocks is still corrected, slowly.
  proc.port.onmessage = ({ data }) => {
    if (paused || failure || !recording || !enc) return;
    const left = data.l; const right = data.r; const n = left.length;
    const late = performance.now() - data.t * 1000; // arbitrary base; only its smallest recent value is used
    const sec = Math.floor(data.t);
    const had = offsetBuckets.get(sec);
    if (had === undefined || late < had) offsetBuckets.set(sec, late);
    for (const k of offsetBuckets.keys()) if (k < sec - 8) offsetBuckets.delete(k);
    const offset = Math.min(...offsetBuckets.values());
    // Where this chunk belongs in the file: the wall time it was made, as the recording clock sees it.
    const expected = Math.round((((data.t * 1000 + offset) - t0 - pausedTotal) / 1000) * RATE) - audioLead;
    // A live screen capture shows the picture sooner than the sound arrives, so the sound is moved earlier by the difference: the first
    // part of it is dropped, and the clock it is held to is that much behind the wall clock.
    let from = 0;
    if (audioSkip > 0) { if (n <= audioSkip) { audioSkip -= n; return; } from = audioSkip; audioSkip = 0; audioWritten = Math.max(audioWritten, expected + from); }
    const behind = expected + from - audioWritten;
    if (behind > RATE * 0.05) { enc.audio.write(Buffer.alloc(behind * 8)); audioWritten += behind; }
    else if (behind < -RATE * 0.05) return;
    const m = n - from;
    const out = new Float32Array(m * 2);
    for (let i = 0; i < m; i += 1) {
      const l = left[from + i]; const r = right[from + i];
      out[i * 2] = l > 1 ? 1 : l < -1 ? -1 : l; // mixed sources can add up past full scale: stop at the top rather than wrap
      out[i * 2 + 1] = r > 1 ? 1 : r < -1 ? -1 : r;
    }
    enc.audio.write(Buffer.from(out.buffer));
    audioWritten += m;
  };
  bus.connect(proc); proc.connect(actx.destination);
  t0 = performance.now();
  recording = true;
  ipcRenderer.send('recorder:note', `startup: ${steps.join(', ')}, ready ${Math.round(performance.now() - s0)} ms`);
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
    ipcRenderer.send('recorder:note', `t=${statSeconds}s pictures sent ${framesSent} (dropped ${framesDropped}), slowest picture ${Math.round(drawMsMax)} ms, window pictures ${winFrames}, webcam pictures ${camFrames}, encoder ${enc ? enc.codec : '-'}${micGain ? `, microphone loudest ${micPeakSeen.toFixed(3)}` : ''}${segCount ? `, blur ${(segMsTotal / segCount).toFixed(1)} ms each (${segCount})` : ''}`);
    segMsTotal = 0; segCount = 0;
    drawMsMax = 0; micPeakSeen = 0;
  }, 5000);
}

async function stop() {
  // The picture runs to the very end: the last picture is repeated up to the moment of stopping.
  if (recording && enc && lastFrame) {
    const due = Math.floor((clockMs() / 1000) * cfg.fps);
    while (framesSent < due) { enc.video.write(lastFrame); framesSent += 1; }
  }
  recording = false;
  clearInterval(timer); clearInterval(levelTimer); clearInterval(statsTimer); clearInterval(healthTimer); clearInterval(segTimer);
  if (micStream) { micStream.getTracks().forEach((t) => t.stop()); micStream = null; }
  if (camStream) { camStream.getTracks().forEach((t) => t.stop()); camStream = null; camVideo = null; }
  screenSources.forEach((src) => { try { src.stream.getTracks().forEach((t) => t.stop()); } catch (err) { /* gone */ } }); screenSources = [];
  if (proc) { proc.port.onmessage = null; proc.disconnect(); proc = null; }
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
