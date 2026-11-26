'use strict';
// Downloads the ffmpeg package that Showrunner ships (built by .github/workflows/ffmpeg.yml) into build/ffmpeg, checking its sha256
// against scripts/ffmpeg/SHA256SUMS first. Used by the app build. Usage: node scripts/fetch-ffmpeg.js mac
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const root = path.join(__dirname, '..');
const env = Object.fromEntries(fs.readFileSync(path.join(__dirname, 'ffmpeg', 'versions.env'), 'utf8').split('\n')
  .filter((l) => /^[A-Z0-9_]+=/.test(l)).map((l) => { const i = l.indexOf('='); return [l.slice(0, i), l.slice(i + 1)]; }));
const platform = process.argv[2] || 'mac';
const asset = `ffmpeg-${platform}-universal-${env.FFMPEG_VERSION}-r${env.BUILD_REVISION}.zip`;
const tag = `ffmpeg-${env.FFMPEG_VERSION}-r${env.BUILD_REVISION}`;
const sums = fs.existsSync(path.join(__dirname, 'ffmpeg', 'SHA256SUMS')) ? fs.readFileSync(path.join(__dirname, 'ffmpeg', 'SHA256SUMS'), 'utf8') : '';
const line = sums.split('\n').find((l) => l.trim().endsWith(asset));
if (!line) { console.error(`No checksum for ${asset} in scripts/ffmpeg/SHA256SUMS. Publish the ffmpeg build first (see scripts/ffmpeg).`); process.exit(1); }
const want = line.trim().split(/\s+/)[0];

(async () => {
  const out = path.join(root, 'build', 'ffmpeg');
  if (fs.existsSync(path.join(out, 'ffmpeg'))) { console.log('build/ffmpeg already present'); return; }
  const url = `https://github.com/Drowbe/coffee-pub-showrunner/releases/download/${tag}/${asset}`;
  console.log(`Downloading ${url}`);
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`Download failed: ${res.status} ${res.statusText}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const got = crypto.createHash('sha256').update(buf).digest('hex');
  if (got !== want) throw new Error(`Checksum mismatch for ${asset}: expected ${want}, got ${got}`);
  fs.mkdirSync(out, { recursive: true });
  const zip = path.join(out, asset);
  fs.writeFileSync(zip, buf);
  execFileSync('unzip', ['-q', '-o', zip, '-d', out]);
  fs.unlinkSync(zip);
  fs.chmodSync(path.join(out, 'ffmpeg'), 0o755);
  console.log(`ffmpeg ready in ${out}`);
})().catch((err) => { console.error(err.message); process.exit(1); });
