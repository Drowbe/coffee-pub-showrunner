'use strict';
// Spike, question 4: every clap's reading from kept calibration recordings. The app's measuring code (src/calibrate.js) drops
// readings where the picture is more than 150 ms ahead of the sound; this runs the same code with that limit widened to 500 ms,
// to see what was dropped. Run: node scripts/spike/calibrate-readings.js <ffmpeg.exe> <recording.mp4> ...
const fs = require('fs');
const path = require('path');
const Module = require('module');

process.env.SPIKE_NO_APP = '1';
require('./calibrate-app.js'); // the escaped file path
const source = path.join(__dirname, '..', '..', 'src', 'calibrate.js');
const load = (text) => { const m = new Module(source); m.filename = source; m.paths = Module._nodeModulePaths(path.dirname(source)); m._compile(text, source); return m.exports; };
const asShipped = load(fs.readFileSync(source, 'utf8'));
const wide = load(fs.readFileSync(source, 'utf8').replace('o > -0.15 && o < 0.6', 'o > -0.5 && o < 0.6'));

const [ffmpeg, ...files] = process.argv.slice(2);
(async () => {
  for (const file of files) {
    const a = await asShipped.measure(ffmpeg, file); const b = await wide.measure(ffmpeg, file);
    console.log(JSON.stringify({ file: path.basename(file), claps: a.claps, asShipped: { used: a.offsetsMs, medianMs: a.medianMs }, allReadings: b.offsetsMs, medianOfAllMs: b.medianMs }));
  }
})();
