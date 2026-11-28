# Windows spike: brief for the Claude Code session on the PC

**Audience:** the Claude Code session running on the Windows machine. Read `plan-windows-recorder.md` first (same folder); this is Phase 1 of it.

**Goal:** measure, don't build. Answer the four spike questions with numbers, write them down, and commit the report. Do not change
Mac behaviour. Do not edit files outside `scripts/spike/` and `documentation/plans/windows-spike-report.md`.

## Setup (once)

1. Install Git, Node 20+ and the GitHub CLI; run `gh auth login`.
2. Clone `Drowbe/coffee-pub-showrunner`, then `git checkout windows-plan && git checkout -b windows-spike`.
3. `npm install`, then `npx electron .` to confirm the app starts from source. Note anything that fails on Windows (paths, native modules).
4. Get a candidate ffmpeg: the latest BtbN `ffmpeg-master-latest-win64-gpl.zip` (or a pinned `n7.1` build) into a scratch folder
   outside the repo. Record the exact build name and SHA-256 in the report.
5. Run `ffmpeg -hide_banner -encoders | findstr /i "nvenc qsv amf x264"` and record which encoders exist. Run `nvidia-smi` and record the card and driver.

## Questions to answer, in order

1. **Encoders.** For each of `h264_nvenc`, `h264_qsv`, `h264_amf` (if the hardware exists) and `libx264 -preset veryfast`: encode
   60 s of 1920x1080 30 fps raw video from `testsrc2` (`-f lavfi`), report speed (`speed=` at the end) and CPU use. NVENC options to try:
   `-preset p4 -tune ll -rc vbr -b:v 8M`. Anything below 1.5x realtime is a fail.
2. **Window capture.** In a tiny Electron script under `scripts/spike/`, use `desktopCapturer.getSources({types:['window']})`, pick a
   Showrunner window, and `getUserMedia` with `chromeMediaSource: 'desktop'`. Record the frame rate delivered at 30 and 60 fps in these
   cases: window visible, partly covered by another window, fully covered, minimised, on another monitor. Say which of those still produce frames.
3. **Pipes.** Does the recorder's pipeline work on Windows: raw RGBA on ffmpeg's stdin plus raw f32le sound on a second pipe?
   Node's `stdio: ['pipe','pipe','pipe','pipe']` gives fd 3 on Mac; on Windows ffmpeg cannot read fd 3. Try, in this order, and keep
   the first that holds for 5 minutes with no drops: (a) a named pipe (`\\.\pipe\showrunner-audio-<pid>`) as a second `-i`;
   (b) a local TCP socket as `-i tcp://127.0.0.1:<port>`; (c) write the sound to a temporary WAV and mux afterwards. Report the
   latency and any stalls. Look at `buildArgs` and the spawn in `src/recorder.js` to see exactly what is used today.
4. **Timing.** Run Calibrate (Preferences > Recorder) with the real webcam and microphone, six claps, three times. Report the
   three delay values. Then repeat with Window picture = Screen recording and = Built-in snapshots and report the difference between them.
   That gives the Windows values for `SCREEN_LATENCY_MS` and the webcam delay default.
5. **Leftovers.** Does "Echo cancel" work on the Windows microphone? Does the webcam name or the microphone label differ in a way
   that breaks matching saved profiles? Any permission switch (Settings > Privacy) the user must turn on?

## Report

Write `documentation/plans/windows-spike-report.md` with: machine (CPU, GPU, driver, Windows build), ffmpeg build and SHA-256, one
table per question with the numbers, what failed and how, and a recommendation for each open question in the plan. Keep it short
and plain; no marketing language.

Commit to `windows-spike` and push (`git push -u origin windows-spike`). Open a draft PR into `windows-plan`, not into `main`.

## Rules

- Do not merge anything or open a PR to `main`. The user merges.
- Use `scripts/spike/` for throwaway code; delete nothing of ours.
- If something needs a decision (an encoder that is flaky, a pipe that needs a design change), stop and ask the user in this session.
- Long text in the UI is truncated with "..." and the full text shows on hover; keep that rule for any UI you touch (you should touch none).
