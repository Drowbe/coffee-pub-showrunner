'use strict';
// Where the video encoder program (ffmpeg) is. The Showrunner Recorder hands its finished pictures and sound to ffmpeg, which runs as
// its own program, so encoding never goes through the app's graphics process (a busy Foundry scene can starve that). Looked for, in
// order: the path in SHOWRUNNER_FFMPEG (testing), the copy shipped inside the app, and a copy the person put in the app's data folder.
const fs = require('fs');
const path = require('path');

function findFfmpeg(userDataDir) {
  const exe = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
  const list = [
    process.env.SHOWRUNNER_FFMPEG,
    process.resourcesPath && path.join(process.resourcesPath, 'ffmpeg', exe),
    userDataDir && path.join(userDataDir, 'ffmpeg', exe),
  ].filter(Boolean);
  return list.find((p) => { try { return fs.statSync(p).isFile(); } catch (err) { return false; } }) || '';
}

// The command line: raw pictures on the first pipe, raw sound on the fourth, one file out. `codec` is 'videotoolbox' (the Mac's own
// encoder, which runs in the system, not in the app) or 'x264' (software). `offsetMs` delays the sound against the picture.
function buildArgs({ width, height, fps, format, codec, out, offsetMs = 0 }) {
  const bitrate = width >= 1920 ? (fps > 30 ? 12000 : 8000) : 5000;
  const video = codec === 'videotoolbox'
    ? ['-c:v', 'h264_videotoolbox', '-b:v', `${bitrate}k`, '-profile:v', 'high', '-realtime', '1', '-g', String(fps * 2)]
    : ['-c:v', 'libx264', '-preset', 'veryfast', '-b:v', `${bitrate}k`, '-maxrate', `${Math.round(bitrate * 1.25)}k`, '-bufsize', `${bitrate * 2}k`, '-g', String(fps * 2)];
  const container = format === 'mkv'
    ? ['-f', 'matroska']
    : ['-movflags', '+frag_keyframe+empty_moov+default_base_moof', '-f', 'mp4']; // both play after a crash: they are written as they go
  return [
    '-hide_banner', '-loglevel', 'error', '-nostats', '-y',
    '-thread_queue_size', '1024', '-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${width}x${height}`, '-framerate', String(fps), '-i', 'pipe:0',
    '-thread_queue_size', '1024', '-f', 'f32le', '-ar', '48000', '-ac', '2', '-itsoffset', (offsetMs / 1000).toFixed(3), '-i', 'pipe:3',
    '-map', '0:v', '-map', '1:a',
    ...video, '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '160k',
    ...container, out,
  ];
}

module.exports = { findFfmpeg, buildArgs };
