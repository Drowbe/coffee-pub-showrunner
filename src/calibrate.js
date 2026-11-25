'use strict';
// Measures how late the webcam's picture is against the microphone's sound, from a short recording of someone clapping their hands.
// ffmpeg reads the file twice: once for the loudness of the sound every 10 ms, once for how much the picture moves from frame to frame.
// Each clap is a loud peak in the sound; the matching hand movement is the strongest movement within half a second of it.
const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const run = (ffmpeg, args) => new Promise((resolve, reject) => execFile(ffmpeg, args, { maxBuffer: 1 << 26 }, (err) => (err ? reject(err) : resolve())));

function readSeries(file, key) {
  const out = []; let t = null;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    let m = line.match(/pts_time:([0-9.]+)/); if (m) t = Number(m[1]);
    m = line.match(new RegExp(`${key}=(-?[0-9.]+|-?inf)`));
    if (m && t !== null) out.push([t, /inf/.test(m[1]) ? -120 : Number(m[1])]);
  }
  return out;
}

// Pure part, so it can be tested without a recording: audio is [[seconds, peak dB]], video is [[seconds, movement]].
function offsetsFrom(audio, video) {
  if (!audio.length || !video.length) return { claps: [], offsets: [] };
  const loudest = Math.max(...audio.map((a) => a[1]));
  const floor = Math.max(-20, loudest - 12); // a clap is within 12 dB of the loudest sound (and loud in itself)
  const claps = [];
  for (const [t, p] of audio) if (p > floor && (!claps.length || t - claps[claps.length - 1] > 0.6)) claps.push(t);
  const sorted = video.map((v) => v[1]).sort((a, b) => a - b);
  const quiet = sorted[Math.floor(sorted.length / 2)];
  const offsets = [];
  for (const tc of claps) {
    const near = video.filter(([t]) => Math.abs(t - tc) < 0.5);
    if (!near.length) continue;
    const peak = near.reduce((best, v) => (v[1] > best[1] ? v : best));
    if (peak[1] > quiet * 3 + 1) offsets.push(peak[0] - tc); // a real hand movement, not noise
  }
  return { claps, offsets };
}

const median = (list) => { const s = [...list].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };

// Returns { medianMs, offsetsMs, claps }: how many milliseconds the picture is late against the sound (negative: early).
async function measure(ffmpeg, file, { crop } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'showrunner-measure-'));
  const audioFile = path.join(dir, 'audio.txt'); const videoFile = path.join(dir, 'video.txt');
  try {
    await run(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-i', file, '-vn', '-af', `asetnsamples=480,astats=metadata=1:reset=1,ametadata=print:key=lavfi.astats.Overall.Peak_level:file=${audioFile}`, '-f', 'null', '-']);
    const vf = `${crop ? `crop=${crop},` : ''}scale=160:90,format=gray,tblend=all_mode=difference,signalstats,metadata=print:key=lavfi.signalstats.YAVG:file=${videoFile}`;
    await run(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-i', file, '-an', '-vf', vf, '-f', 'null', '-']);
    const { claps, offsets } = offsetsFrom(readSeries(audioFile, 'Peak_level'), readSeries(videoFile, 'YAVG'));
    // A webcam is between a little early and about half a second late; anything else is a match with the wrong movement.
    const valid = offsets.filter((o) => o > -0.15 && o < 0.6);
    return { claps: claps.length, offsetsMs: valid.map((o) => Math.round(o * 1000)), medianMs: valid.length >= 3 ? Math.round(median(valid) * 1000) : null };
  } finally { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (err) { /* temporary files */ } }
}

module.exports = { measure, offsetsFrom };
