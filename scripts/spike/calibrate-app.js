'use strict';
// Spike, question 4: starts Showrunner as it is, with one thing changed in memory only, so that Calibrate can run on Windows.
// src/calibrate.js puts a file path such as C:\...\audio.txt inside an ffmpeg filter, where ':' and '\' mean something else, and
// ffmpeg refuses it. Here the path is escaped on its way to ffmpeg; the recording and the measuring are the app's own.
// A copy of each calibration recording is kept in SPIKE_KEEP, if set (the app deletes it).
// Run: npx electron scripts/spike/calibrate-app.js --user-data-dir=<throwaway folder>   (with SHOWRUNNER_FFMPEG set)
const cp = require('child_process');
const fs = require('fs');
const path = require('path');

const real = cp.execFile;
const kept = new Set();
cp.execFile = (file, args, ...rest) => {
  if (!Array.isArray(args)) return real(file, args, ...rest);
  const input = args[args.indexOf('-i') + 1];
  if (process.env.SPIKE_KEEP && /showrunner-calibrate-/.test(String(input)) && !kept.has(input)) {
    kept.add(input);
    try { fs.copyFileSync(input, path.join(process.env.SPIKE_KEEP, `calibrate-${kept.size}-${Date.now()}.mp4`)); } catch (err) { console.error(err.message); }
  }
  const fixed = args.map((a) => String(a).replace(/file=([A-Za-z]):(\\[^,]*)$/, (_m, drive, tail) => `file='${drive}\\:${tail.replace(/\\/g, '/')}'`));
  return real(file, fixed, ...rest);
};
module.exports = { fixed: cp.execFile };
if (!process.env.SPIKE_NO_APP) require('../../src/main.js');
