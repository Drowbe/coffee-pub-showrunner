# Third-party software in Coffee Pub Showrunner

Showrunner is built on Electron (MIT) and Chromium (BSD-style, with its own bundled licences; see the licences shown by the app's
Chromium). Two further components are bundled for the Showrunner Recorder.

## FFmpeg and x264 (GNU General Public License)

The Showrunner Recorder saves video by running **ffmpeg** as its own, separate program. Showrunner does not link to it. The copy
shipped with Showrunner is built, unmodified, from the official sources by this project's own build scripts, with these components:

- **FFmpeg 7.1.5**, https://ffmpeg.org/releases/ffmpeg-7.1.5.tar.xz (sha256 `de668509caf9e35e3cd162473441fdb29538c6d96ed080292b3cf9e6fc5d558f`)
- **x264**, https://code.videolan.org/videolan/x264, commit `b35605ace3ddf7c1a5d67a2eb553f034aef41d55`
- The build scripts and settings (configure options): https://github.com/Drowbe/coffee-pub-showrunner/tree/main/scripts/ffmpeg

Because x264 is enabled, the ffmpeg program is licensed under the **GNU General Public License** (version 2 or later; the version 3 text
is shipped beside the program). You may obtain the complete corresponding source from the links above. The licence texts are in the
`ffmpeg` folder next to the program (`COPYING.GPLv3`, `FFMPEG-LICENSE.md`, `SOURCE.txt`).

## MediaPipe (Apache License 2.0)

The webcam background blur uses Google's **MediaPipe Tasks Vision** 1.2.3 and its selfie segmentation model, both under the Apache License,
Version 2.0. Files, sources and the model card's licence statement: `src/vendor/mediapipe/NOTICE.md`; licence text:
`src/vendor/mediapipe/LICENSE-Apache-2.0.txt`.
