'use strict';
// Spike, question 3. Run: npx electron scripts/spike/pipes.js <ffmpeg.exe> <work folder> <route,codec,seconds> ...
// route is fd3 (what the app does today), pipe (a Windows named pipe) or tcp (a local socket). After each run the file is checked:
// (Commas, not colons: Electron on Windows quits silently when an argument looks like a URL.)
// how many pictures and how much sound are in it, and whether the unbroken test tone has any gap.
const { app, BrowserWindow, ipcMain } = require('electron');
const { execFileSync, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'showrunner-spike-pipes-')));
const [ffmpeg, work, ...runs] = process.argv.slice(2);
const ffprobe = path.join(path.dirname(ffmpeg), 'ffprobe.exe');

// Newer ffmpeg builds refuse -thread_queue_size on an input, which the app passes today: left out for those, and said in the result.
const noQueueSize = spawnSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-thread_queue_size', '1024', '-f', 'lavfi', '-i', 'testsrc2=duration=0.1', '-f', 'null', '-']).status !== 0;

function check(file) {
  try {
    const probe = JSON.parse(execFileSync(ffprobe, ['-v', 'error', '-count_packets', '-show_entries', 'stream=codec_type,duration,nb_read_packets', '-of', 'json', file], { maxBuffer: 1 << 24 }).toString());
    const v = probe.streams.find((s) => s.codec_type === 'video'); const a = probe.streams.find((s) => s.codec_type === 'audio');
    const quiet = spawnSync(ffmpeg, ['-hide_banner', '-i', file, '-vn', '-af', 'silencedetect=noise=-30dB:d=0.005', '-f', 'null', '-'], { maxBuffer: 1 << 26 }).stderr.toString();
    return { framesInFile: Number(v.nb_read_packets), videoSeconds: Number(v.duration), audioSeconds: Number(a.duration), silences: [...quiet.matchAll(/silence_start: ([0-9.-]+)[\s\S]*?silence_duration: ([0-9.]+)/g)].map((m) => `${m[1]}s for ${m[2]}s`).slice(0, 20), megabytes: +(fs.statSync(file).size / 1e6).toFixed(1) };
  } catch (err) { return { error: err.message.slice(0, 600) }; }
}

app.on('window-all-closed', () => {});
app.whenReady().then(async () => {
  const results = [];
  const log = path.join(work, 'pipes.log');
  ipcMain.on('progress', (_e, line) => { fs.appendFileSync(log, `${line}\n`); console.log(line); });
  for (const spec of runs) {
    const [route, codec, seconds] = spec.split(',');
    const win = new BrowserWindow({ show: false, width: 320, height: 180, webPreferences: { nodeIntegration: true, contextIsolation: false, backgroundThrottling: false } });
    await win.loadFile(path.join(__dirname, 'pipes.html'));
    const out = path.join(work, `${route}-${codec}-${seconds}.mp4`);
    const done = new Promise((resolve) => ipcMain.once('done', (_e, r) => resolve(r)));
    win.webContents.send('run', { ffmpeg, route, codec, seconds: Number(seconds), out, noQueueSize });
    const result = await done;
    result.file = check(out);
    results.push(result); console.log(JSON.stringify(result, null, 1));
    fs.writeFileSync(path.join(work, `pipes-${runs.join('_').replace(/,/g, '-')}.json`), JSON.stringify(results, null, 1));
    win.destroy();
  }
  app.exit(0);
});
