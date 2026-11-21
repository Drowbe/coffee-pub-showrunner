'use strict';
// The recorder's page (a hidden window): draws the source windows into one picture, mixes their audio, encodes both with the
// computer's own H.264 and AAC encoders (WebCodecs) and writes a fragmented MP4 through mp4-muxer (vendor/). Every piece of the
// file goes to the main process as it is made, which writes it to disk: memory stays flat however long it runs, and a crash
// loses only the last second or two. (MediaRecorder was tried first: its MP4 output is held until the end. See plan-recording.md.)
const { ipcRenderer } = require('electron');
const { Muxer, StreamTarget } = require('./vendor/mp4-muxer.js');

const RATE = 48000;
const AUDIO_CUSHION = 0.04; // seconds of cushion so unevenly arriving audio chunks still play evenly
const VIDEO_DELAY_MS = 70; // the picture is held back this long so it lines up with the audio (measured; see plan-recording.md)

const sources = [null, null]; // the latest frame of each source, held in a canvas
const nextAt = new Map(); // per audio source: when its next chunk should play
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

ipcRenderer.on('audio', (_e, { key, l, r, rate }) => {
  if (!actx || actx.state === 'closed' || paused) return;
  const n = l.length;
  const buffer = actx.createBuffer(2, n, rate);
  buffer.copyToChannel(new Float32Array(l.buffer ? l.buffer : l), 0);
  buffer.copyToChannel(new Float32Array(r.buffer ? r.buffer : r), 1);
  const node = actx.createBufferSource();
  node.buffer = buffer; node.connect(bus);
  const now = actx.currentTime;
  let at = nextAt.get(key);
  if (!at || at < now) at = now + AUDIO_CUSHION;
  node.start(at);
  nextAt.set(key, at + n / rate);
});

function rects(W, H) {
  if (cfg.layout === 'side') return [{ x: 0, y: 0, w: W / 2, h: H }, { x: W / 2, y: 0, w: W / 2, h: H }];
  return [{ x: 0, y: 0, w: W, h: H }];
}

const clockUs = () => Math.round((performance.now() - t0 - pausedTotal) * 1000);

function draw() {
  if (failure || paused) return;
  const { width: W, height: H } = canvas;
  g.fillStyle = '#000'; g.fillRect(0, 0, W, H);
  rects(W, H).forEach((r, i) => {
    const s = sources[i];
    if (!s) return;
    const k = Math.min(r.w / s.width, r.h / s.height); // fit inside the slot, keeping the shape
    const w = s.width * k; const h = s.height * k;
    g.drawImage(s, r.x + (r.w - w) / 2, r.y + (r.h - h) / 2, w, h);
  });
  if (venc.encodeQueueSize > 8) return; // the encoder is behind: skip a picture rather than fall further back
  const frame = new VideoFrame(canvas, { timestamp: clockUs() });
  venc.encode(frame, { keyFrame: ticks % (cfg.fps * 2) === 0 }); // a fresh keyframe every two seconds
  frame.close();
  ticks += 1;
}

function fail(err) { if (!failure) { failure = err.message || String(err); ipcRenderer.send('recorder:failed', failure); } }

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
  venc = new VideoEncoder({ output: (chunk, meta) => muxer.addVideoChunk(chunk, meta), error: fail });
  venc.configure(videoConfig);
  aenc = new AudioEncoder({ output: (chunk, meta) => muxer.addAudioChunk(chunk, meta), error: fail });
  aenc.configure(audioConfig);
  // The mixing bus: every source's sound is scheduled onto it, and a processor reads it out in blocks for the encoder.
  actx = new AudioContext({ sampleRate: RATE });
  bus = actx.createGain();
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
    aenc.encode(new AudioData({ format: 'f32-planar', sampleRate: RATE, numberOfFrames: n, numberOfChannels: 2, timestamp: Math.round((audioSamples / RATE) * 1e6), data: planar }));
    audioSamples += n;
  };
  bus.connect(proc); proc.connect(actx.destination);
  t0 = performance.now();
  timer = setInterval(draw, 1000 / cfg.fps);
}

async function stop() {
  clearInterval(timer);
  if (proc) { proc.onaudioprocess = null; proc.disconnect(); }
  await venc.flush(); await aenc.flush();
  venc.close(); aenc.close();
  muxer.finalize();
  if (actx) { await actx.close(); actx = null; }
}

ipcRenderer.on('start', async (_e, config) => {
  try { await start(config); ipcRenderer.send('recorder:started', { ok: true }); } catch (err) { ipcRenderer.send('recorder:started', { ok: false, error: err.message }); }
});
ipcRenderer.on('stop', async () => { try { await stop(); } catch (err) { fail(err); } finally { ipcRenderer.send('recorder:stopped'); } });
ipcRenderer.on('pause', () => { if (!paused) { paused = true; pausedAt = performance.now(); } });
ipcRenderer.on('resume', () => {
  if (!paused) return;
  pausedTotal += performance.now() - pausedAt; paused = false;
  audioSamples = Math.round(((performance.now() - t0 - pausedTotal) / 1000) * RATE); // the sound's clock follows the picture's after a pause
  anchorUs = null;
});
