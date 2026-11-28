'use strict';
// Spike, question 1. Run: node scripts/spike/encoders.js <ffmpeg.exe> <work folder>
// Encodes 60 s of 1920x1080 30 fps testsrc2 with each H.264 encoder, flat out (for speed) and at real time (for the processor use
// while recording). "generator only" is what making the test picture costs by itself.
const { spawn, execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const [ffmpeg, work] = process.argv.slice(2);
const g = ['-g', '60'];
const ENCODERS = [
  ['generator only', ['-c:v', 'wrapped_avframe']],
  ['h264_nvenc', ['-c:v', 'h264_nvenc', '-preset', 'p4', '-tune', 'll', '-rc', 'vbr', '-b:v', '8M', ...g]],
  ['h264_qsv', ['-c:v', 'h264_qsv', '-preset', 'veryfast', '-b:v', '8M', ...g]],
  ['h264_amf', ['-c:v', 'h264_amf', '-usage', 'lowlatency', '-quality', 'speed', '-b:v', '8M', ...g]],
  ['libx264 veryfast', ['-c:v', 'libx264', '-preset', 'veryfast', '-b:v', '8000k', '-maxrate', '10000k', '-bufsize', '16000k', ...g]],
];

function gpuSample() {
  return new Promise((resolve) => execFile('nvidia-smi', ['--query-gpu=utilization.encoder,utilization.gpu', '--format=csv,noheader,nounits'], (err, out) => resolve(err ? null : out.trim().split(',').map(Number))));
}

function run(name, codec, paced) {
  const nul = name === 'generator only';
  const out = path.join(work, `${name.replace(/\W+/g, '-')}${paced ? '-paced' : ''}.mp4`);
  const args = ['-hide_banner', '-benchmark', '-y', ...(paced ? ['-re'] : []), '-f', 'lavfi', '-i', 'testsrc2=size=1920x1080:rate=30:duration=60',
    ...codec, '-pix_fmt', 'yuv420p', ...(nul ? ['-f', 'null', '-'] : [out])];
  return new Promise((resolve) => {
    const child = spawn(ffmpeg, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let log = ''; const gpu = [];
    child.stderr.on('data', (d) => { log += d; });
    const timer = paced ? setInterval(async () => { const s = await gpuSample(); if (s) gpu.push(s); }, 2000) : null;
    child.on('close', (code) => {
      clearInterval(timer);
      const speeds = [...log.matchAll(/speed=\s*([0-9.]+)x/g)];
      const bench = log.match(/bench: utime=([0-9.]+)s stime=([0-9.]+)s rtime=([0-9.]+)s/);
      const avg = (i) => (gpu.length ? Math.round(gpu.reduce((a, s) => a + s[i], 0) / gpu.length) : null);
      const r = { name, paced, exit: code, speed: speeds.length ? Number(speeds[speeds.length - 1][1]) : null };
      if (bench && code === 0) {
        const cpu = Number(bench[1]) + Number(bench[2]); const wall = Number(bench[3]);
        Object.assign(r, { cpuSeconds: +cpu.toFixed(1), wallSeconds: +wall.toFixed(1), cores: +(cpu / wall).toFixed(2), percentOfMachine: +((cpu / wall / os.cpus().length) * 100).toFixed(1) });
      }
      if (paced) Object.assign(r, { gpuEncoderPercent: avg(0), gpuPercent: avg(1) });
      if (code !== 0) r.error = log.split('\n').filter((l) => /error|fail|cannot|could not|not /i.test(l)).slice(0, 6).join(' | ').slice(0, 900);
      else if (!nul) r.megabits = +((fs.statSync(out).size * 8) / 60 / 1e6).toFixed(1);
      console.log(JSON.stringify(r));
      resolve(r);
    });
  });
}

(async () => {
  const results = [];
  results.push({ name: 'idle graphics card before', gpu: await gpuSample() });
  for (const [name, codec] of ENCODERS) {
    const fast = await run(name, codec, false); results.push(fast);
    if (fast.exit === 0) results.push(await run(name, codec, true));
  }
  fs.writeFileSync(path.join(work, 'encoders.json'), JSON.stringify(results, null, 1));
})();
