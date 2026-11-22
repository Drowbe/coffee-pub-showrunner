'use strict';
// The recorder's page (a hidden window): draws the source windows into one picture, mixes their audio, encodes both with the
// computer's own H.264 and AAC encoders (WebCodecs) and writes a fragmented MP4 through mp4-muxer (vendor/). Every piece of the
// file goes to the main process as it is made, which writes it to disk: memory stays flat however long it runs, and a crash
// loses only the last second or two. (MediaRecorder was tried first: its MP4 output is held until the end. See plan-recording.md.)
const { ipcRenderer } = require('electron');
const { Muxer, StreamTarget } = require('./vendor/mp4-muxer.js');
const Layout = require('./layout.js');

const RATE = 48000;
const AUDIO_CUSHION = 0.04; // seconds of cushion so unevenly arriving audio chunks still play evenly
const VIDEO_DELAY_MS = 70; // the picture is held back this long so it lines up with the audio (measured; see plan-recording.md)

const sources = [null, null]; // the latest frame of each source, held in a canvas
const nextAt = new Map(); // per audio source: when its next chunk should play
const MIC_DELAY = 0.04; // the microphone is played as it arrives, so it waits as long as the windows' sound does (AUDIO_CUSHION)
let camVideo = null; let camStream = null;
let winGain = []; let micGain = null; let micStream = null; let levelTimer = null; let audioCfg = null;
const analysers = []; // [window 1, window 2, microphone, everything]
let vcfg = null; let lastVideoOutAt = 0; let switchedEncoder = false; let needKey = false; let watchdog = null;
let cfg = null; let canvas; let g; let muxer; let venc; let aenc; let actx; let bus; let proc; let timer;
let anchorUs = null; let t0 = 0; let paused = false; let pausedTotal = 0; let pausedAt = 0; let ticks = 0; let audioSamples = 0; let failure = '';

const swizzle = (u32) => { for (let i = 0; i < u32.length; i += 1) { const v = u32[i]; u32[i] = (v & 0xff00ff00) | ((v & 0xff) << 16) | ((v >> 16) & 0xff); } }; // BGRA to RGBA

function onFrame({ i, w, h, buf }) {
  const data = new Uint8ClampedArray(buf.buffer, buf.byteOffset, buf.byteLength);
  swizzle(new Uint32Array(data.buffer, data.byteOffset, data.byteLength / 4));
  let s = sources[i];
  if (!s || s.width !== w || s.height !== h) { s = document.createElement('canvas'); s.width = w; s.height = h; sources[i] = s; }
  s.getContext('2d').putImageData(new ImageData(data, w, h), 0, 0);
}
ipcRenderer.on('frame', (_e, msg) => setTimeout(() => onFrame(msg), VIDEO_DELAY_MS));

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

const clockUs = () => Math.round((performance.now() - t0 - pausedTotal) * 1000);

function draw() {
  if (failure || paused) return;
  const { width: W, height: H } = canvas;
  Layout.compose(g, W, H, { layout: cfg.layout, camera: cfg.camera, sources, camVideo });
  if (venc.encodeQueueSize > 8) return; // the encoder is behind: skip a picture rather than fall further back
  const frame = new VideoFrame(canvas, { timestamp: clockUs() });
  venc.encode(frame, { keyFrame: needKey || ticks % (cfg.fps * 2) === 0 }); needKey = false; // a fresh keyframe every two seconds
  frame.close();
  ticks += 1;
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

// The video encoder. The computer's own (hardware) encoder is tried first; if it takes frames in and never gives any back, the watchdog
// below replaces it with the software encoder, so a stuck encoder cannot leave a recording that saves nothing.
function makeVideoEncoder(acceleration) {
  lastVideoOutAt = performance.now();
  const e = new VideoEncoder({ output: (chunk, meta) => { lastVideoOutAt = performance.now(); muxer.addVideoChunk(chunk, meta); }, error: fail });
  e.configure({ ...vcfg, hardwareAcceleration: acceleration });
  return e;
}

async function start(config) {
  cfg = config;
  sources[0] = sources[1] = null; nextAt.clear(); failure = ''; ticks = 0; audioSamples = 0; pausedTotal = 0; paused = false; anchorUs = null;
  canvas = document.createElement('canvas'); canvas.width = cfg.width; canvas.height = cfg.height; g = canvas.getContext('2d', { alpha: false });
  const videoConfig = {
    codec: cfg.fps > 30 ? 'avc1.64002a' : 'avc1.640028', width: cfg.width, height: cfg.height, framerate: cfg.fps,
    bitrate: cfg.width >= 1920 ? (cfg.fps > 30 ? 12_000_000 : 8_000_000) : 5_000_000, latencyMode: 'realtime', hardwareAcceleration: 'prefer-hardware',
  };
  const audioConfig = { codec: 'mp4a.40.2', sampleRate: RATE, numberOfChannels: 2, bitrate: 128_000 };
  if (!(await VideoEncoder.isConfigSupported(videoConfig)).supported) throw new Error('This computer cannot encode H.264 video.');
  if (!(await AudioEncoder.isConfigSupported(audioConfig)).supported) throw new Error('This computer cannot encode AAC audio.');
  muxer = new Muxer({
    target: new StreamTarget({ onData: (data, position) => ipcRenderer.send('recorder:write', { data, position }) }),
    video: { codec: 'avc', width: cfg.width, height: cfg.height, frameRate: cfg.fps },
    audio: { codec: 'aac', numberOfChannels: 2, sampleRate: RATE },
    fastStart: 'fragmented', firstTimestampBehavior: 'offset',
  });
  vcfg = videoConfig; switchedEncoder = false; needKey = false;
  venc = makeVideoEncoder('prefer-hardware');
  aenc = new AudioEncoder({ output: (chunk, meta) => muxer.addAudioChunk(chunk, meta), error: fail });
  aenc.configure(audioConfig);
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
    } catch (err) { throw new Error(`The webcam could not be opened (${why(err)}).`); }
  }
  if (config.audio) applyAudio(config.audio);
  const levelBuf = new Float32Array(1024);
  levelTimer = setInterval(() => ipcRenderer.send('recorder:levels', analysers.map((a, i) => (paused || (i === 2 && !micGain) ? 0 : peakOf(a, levelBuf)))), 100);
  proc = actx.createScriptProcessor(2048, 2, 2);
  proc.onaudioprocess = (e) => {
    if (paused || failure) return;
    const n = e.inputBuffer.length;
    // The sound's timestamps count samples, which keeps them smooth, but the audio clock and the wall clock part ways slowly (about half
    // a second an hour here). Each block nudges the count 1% of the way towards the wall clock, which holds them together all session.
    const nowUs = clockUs();
    if (anchorUs === null) anchorUs = nowUs - (audioSamples / RATE) * 1e6;
    else audioSamples += Math.round(((nowUs - anchorUs) - (audioSamples / RATE) * 1e6) * 0.01 * (RATE / 1e6));
    const planar = new Float32Array(n * 2);
    planar.set(e.inputBuffer.getChannelData(0), 0); planar.set(e.inputBuffer.getChannelData(1), n);
    for (let i = 0; i < planar.length; i += 1) { const v = planar[i]; if (v > 1) planar[i] = 1; else if (v < -1) planar[i] = -1; } // mixed sources can add up past full scale: stop at the top rather than wrap
    aenc.encode(new AudioData({ format: 'f32-planar', sampleRate: RATE, numberOfFrames: n, numberOfChannels: 2, timestamp: Math.round((audioSamples / RATE) * 1e6), data: planar }));
    audioSamples += n;
  };
  bus.connect(proc); proc.connect(actx.destination);
  t0 = performance.now();
  timer = setInterval(draw, 1000 / cfg.fps);
  watchdog = setInterval(() => {
    if (failure || paused || switchedEncoder || !venc) return;
    if (venc.encodeQueueSize >= 3 && performance.now() - lastVideoOutAt > 3000) {
      switchedEncoder = true;
      const stuck = venc;
      venc = makeVideoEncoder('prefer-software');
      needKey = true;
      try { stuck.close(); } catch (err) { /* already closed */ }
      ipcRenderer.send('recorder:note', 'The hardware video encoder stalled (it took frames and gave none back), so the software encoder took over.');
    }
  }, 1000);
}

async function stop() {
  clearInterval(timer); clearInterval(levelTimer); clearInterval(watchdog);
  if (micStream) { micStream.getTracks().forEach((t) => t.stop()); micStream = null; }
  if (camStream) { camStream.getTracks().forEach((t) => t.stop()); camStream = null; camVideo = null; }
  if (proc) { proc.onaudioprocess = null; proc.disconnect(); }
  await venc.flush(); await aenc.flush();
  venc.close(); aenc.close();
  muxer.finalize();
  if (actx) { await actx.close(); actx = null; }
}

ipcRenderer.on('start', async (_e, config) => {
  try { await start(config); ipcRenderer.send('recorder:started', { ok: true }); } catch (err) { ipcRenderer.send('recorder:started', { ok: false, error: err.message }); }
});
// A snapshot of the recorder's insides, asked for when nothing seems to be getting saved.
ipcRenderer.on('stats', () => {
  ipcRenderer.send('recorder:stats', {
    video: venc ? { state: venc.state, queue: venc.encodeQueueSize } : null,
    audio: aenc ? { state: aenc.state, queue: aenc.encodeQueueSize } : null,
    frames: ticks, audioSeconds: Math.round(audioSamples / RATE), failure,
    audioContext: actx ? actx.state : null, mic: Boolean(micStream), camera: camVideo ? `${camVideo.videoWidth}x${camVideo.videoHeight} ready=${camVideo.readyState}` : null,
    paused, sourcesSeen: sources.map((s2) => Boolean(s2)),
  });
});
ipcRenderer.on('stop', async () => { try { await stop(); } catch (err) { fail(err); } finally { ipcRenderer.send('recorder:stopped'); } });
ipcRenderer.on('pause', () => { if (!paused) { paused = true; pausedAt = performance.now(); } });
ipcRenderer.on('resume', () => {
  if (!paused) return;
  pausedTotal += performance.now() - pausedAt; paused = false;
  audioSamples = Math.round(((performance.now() - t0 - pausedTotal) / 1000) * RATE); // the sound's clock follows the picture's after a pause
  anchorUs = null;
});
