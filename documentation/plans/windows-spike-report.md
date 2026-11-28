# Windows spike: report

**Audience:** anyone building Phase 2 onwards of `plan-windows-recorder.md`.

Measured on 2026-11-27 from `windows-plan` at `c378f28` (Showrunner 0.5.0). Nothing in `src/` was changed. Test code is in `scripts/spike/`.

## Summary

The four spike questions mostly come out well: the encoders are fast, window capture works, and the app's pipe to ffmpeg works on Windows as it is. **The recorder is not ready on Windows**, because of these:

| # | Problem | Effect | How sure |
|---|---|---|---|
| 1 | Recorded window sound has silent holes of about 120 ms every 4 to 16 s, and many small breaks | Audible faults in recordings; timing constants cannot be set | Measured. Cause traced to the page's copy of its sound (`tap-preload.js`). One PC only. See the re-test at the end |
| 2 | Calibrate fails: `src/calibrate.js` puts a `C:\...` path inside an ffmpeg filter (lines 48, 49) | Calibrate always errors | Measured; goes away when the path is escaped |
| 3 | ffmpeg `master` refuses `-thread_queue_size` on an input (`src/ffmpeg.js`) | The app cannot record with that build | Measured. n8.1 accepts it |
| 4 | Webcam picture is 145 ms or more *ahead* of the voice; the delay setting cannot go below 0, and Calibrate drops readings beyond -150 ms | Cannot be corrected; Calibrate often matches too few claps | Measured |
| 5 | Calibrate applies the screen-recording sound shift on Mac only (`src/main.js:3750`); a recording applies it on Windows too | With Screen recording, voice would be 275 ms off from what was calibrated | Read in code, not measured |
| 6 | x264 MP4 output starts the picture 66.7 ms after the sound | Picture late by two frames in every software-encoded file | Measured |

## Machine and software

| Item | Value |
|---|---|
| Windows | 11 Pro, build 26300 |
| CPU | Intel i9-10850K, 10 cores / 20 threads; 64 GB RAM |
| GPU | NVIDIA RTX 3090, driver 621.14 (Windows: 32.0.16.2114) |
| Second GPU | Intel UHD 630, driver 31.0.101.2140 |
| Displays | 3840x1600 and 1920x720, both 60 Hz at 100% scaling |
| Node / npm / Electron / Chromium | 24.15.0 / 11.12.1 / 45.4.1 / 156.0.8078.100 |

**ffmpeg**, BtbN win64 GPL builds from the `latest` release (a moving tag):

| Build | Version | SHA-256 of the zip |
|---|---|---|
| `ffmpeg-master-latest-win64-gpl.zip` (questions 1 and 3) | `N-129333-g7fdb4c2341-20261127` | `677015947673cf434987466beb59e4cc2a2c089fe1782d8d3735006a099e28c6` |
| `ffmpeg-n8.1-latest-win64-gpl-8.1.zip` (question 4) | `n8.1.3-41-ga8029b6528-20261127` | `c1c6a7efa935bb73ede4a77aef8660e8485ebd8d32f9324e9c69f32bbcd1971e` |

The `latest` release had no n7.1 build.

**Running from source:** `npm install` and `npx electron .` work (Electron downloads on first run; `npm run check` passes; `npm install` lists 9 audit findings, 2 high). One deprecation warning: `safeStorage.isEncryptionAvailable`. The app's data folder is `Coffee Pub Studio`, which an older install on this PC also uses, so every run here used a throwaway `--user-data-dir`.

## 1. Encoders

60 s of 1920x1080, 30 fps `testsrc2`, 8 Mb/s, master build, graphics card otherwise idle. Speeds include making the test picture (33x on its own). CPU is measured while encoding at real time.

| Encoder | Speed | CPU cores (% of machine) | NVENC load | Result |
|---|---|---|---|---|
| `h264_nvenc` (`p4`, `ll`, `vbr`) | 11.8x | 0.07 (0.3%) | 8% | Pass |
| `h264_qsv` (`veryfast`) | 9.2x | 0.18 (0.9%) | - | Pass |
| `libx264` (`veryfast`) | 11.7x | 0.66 (3.3%); 10.7 cores flat out | - | Pass |
| `h264_amf` | - | - | - | Does not open: `amfrt64.dll failed to open` (no AMD card) |

All four are listed by `-encoders` in both builds. Not measured under a game's GPU load.

## 2. Window capture

A real Showrunner Game window (1920x1108) showing a page that changes every frame, captured the way `openScreen()` and the snapshot loop do. 10 s per case. "fps" counts new pictures; delay is from the page drawing to the picture arriving (median / 95th percentile, ms).

| Case | Screen 30: fps, delay | Screen 60: fps, delay | Snapshots at 30: fps, delay | Snapshots at 60: fps, delay |
|---|---|---|---|---|
| Visible | 29.9, 28/35 | 60.1, 10/18 | 22.4, 17/22 | 26.4, 16/22 |
| Partly covered | 30.0, 28/35 | 60.1, 10/18 | 22.3, 18/22 | 27.1, 15/21 |
| Fully covered | 29.9, 28/35 | 60.0, 10/18 | 22.5, 17/22 | 27.3, 15/21 |
| **Minimised** | **0** | **0** | 22.7, 18/22 | 27.2, 15/22 |
| Restored | 30.0, 28/35 | 60.0, 10/18 | 22.5, 17/22 | 26.5, 16/22 |
| Other monitor, window taller than it | 30.0, 28/35 | 60.1, 10/18 | 22.8, 17/22 | 27.0, 15/22 |
| Other monitor, window fits (1024x604) | 30.1, 11/17 | 60.0, 10/17 | 22.0, 12/18 | 27.8, 11/18 |

- **Screen recording produces frames in every case except minimised.** A minimised window also leaves `getSources` and its page nearly stops drawing (1 fps). The picture resumes on restore. Showrunner windows have no minimise button, but Windows can still minimise them.
- Asking for at least 60 (`minFrameRate`) on a minimised window repeats a stale picture instead (40.7 a second, none new).
- Screen delay was 10 to 12 ms in some runs and 28 ms in others; a first capture in a fresh process at 60 fps read 43 ms. The cause of the difference is unknown.
- A second capture of a window inherits the rate of one already open: while a 30 fps track was still alive, a 60 fps request got 30.
- Snapshots never reach the requested rate at 1920x1080 (about 22 of 30, 27 of 60).
- The recorder's crop is right at 100% scaling (page starts at row 28, first row slightly blurred). Other scalings were not tested.
- Read in code, not measured: while minimised, `getContentBounds()` reports about -32000, so the recorder's crop would fall outside the picture and that place would likely go blank.
- Not checked: whether Windows draws a border around a captured window.

## 3. Pipes

**The route used today (`stdio[3]`, `pipe:3`) works on Windows.** The brief expected it to fail. Fed from a hidden Electron page using `buildArgs`, 1920x1080 RGBA at 30 fps plus f32le sound, 5 minutes each. Master build, so `-thread_queue_size` was removed for these runs.

| | `pipe:3` + NVENC | Named pipe + NVENC | Named pipe + x264 |
|---|---|---|---|
| Frames sent / in file | 9000 / 9000 | 9000 / 9000 | 9000 / 9000 |
| Sound in file (s) | 300.01 | 300.01 | 300.06 |
| Dropped / duplicated | 0 / 0 | 0 / 0 | 0 / 0 |
| Gaps in the test tone (after the encoder's lead-in) | none | none | none |
| Audio connects after | at spawn | 57 ms | 58 ms |
| Picture write, median / p99 / max (ms) | 1.5 / 5.7 / 193 | 1.1 / 5.1 / 178 | 1.3 / 5.2 / 9 |
| Sound write, median / p99 / max (ms) | 0.1 / 4.1 / 9 | 0.1 / 2.9 / 7 | 1144 / 1564 / 1926 |
| Encoder behind, median / max (ms) | 66 / 110 | 67 / 212 | 1253 / 1452 |
| Most pictures waiting | 5 | 4 | 0 |
| ffmpeg exit, time to finish | 0, 105 ms | 0, 116 ms | 0, 177 ms |

- With x264, ffmpeg holds the sound back about 1.3 s while the encoder catches up. It stayed steady and nothing was lost.
- A local TCP socket (`tcp://127.0.0.1`) also worked in a 12 s run. The temporary-WAV route was not tried, as the earlier routes held.
- The app's own recorder (`pipe:3`, x264, n8.1) ran to the end in every question 4 run, with no dropped pictures in the logs read.

## 4. Timing

### Calibrate (BRIO webcam, Yeti microphone)

Calibrate errors on Windows (problem 2). These runs used `scripts/spike/calibrate-app.js`, which escapes the path in memory; recording and measuring are the app's own. Negative means the picture is ahead of the sound.

| Run | App's result | Readings it kept (ms) | All readings (ms) | Median of all |
|---|---|---|---|---|
| 1 | Failed: 2 of 7 matched | -145, 415 | -145, 415, -495, -182, -165, -209, -235 | -182 |
| 2 | Failed: 3 of 6 matched | -132, -149, -142 | -132, -202, -155, -149, -195, -142 | -149 |
| 3 | -145, delay set to 0 | -149, -149, -132, -145, -145 | -149, -149, -132, -145, -145, -152 | -145 |

- Run 1 has two outliers (415, -495).
- "All readings" re-measures the same recordings with the limit widened from -150 to -500 ms (`calibrate-readings.js`).
- These include the +67 ms x264 shift. With an encoder that has no such shift, expect the picture about 210 ms or more ahead.
- Calibrate was not repeated per Window picture setting: on Windows it ignores the setting (problem 5), so both would measure the same thing. This was agreed during the spike.

### Screen recording against Built-in snapshots

Instead, a window flashed white and beeped at the same moment while the app's recorder ran (`av-sync.js`; n8.1, x264, no microphone). Positive means the picture is late. About 30 or 50 flashes per run.

| Run | Screen: median (range) | Snapshots: median (range) |
|---|---|---|
| 45 s, window muted, 1 | 190 (96 to 328) | 323 (260 to 404) |
| 45 s, window muted, 2 | 260 (200 to 342) | 329 (255 to 417) |
| 75 s, audible, 1 | 280 (215 to 355) | 340 (273 to 420) |
| 75 s, audible, 2 | 272 (145 to 347) | 359 (268 to 419) |
| **Average of medians** | **250** | **338** |

Snapshots is about 90 ms later than Screen recording. Readings climb and then jump back by about 100 ms within a run, which fits problem 1.

### What this means for the constants

**Do not set Windows values yet.** With the sound breaking up, any value is only good to about ±60 ms or worse. Rough starting points, after removing the 67 ms x264 shift and assuming the holes do not bias the average:

| Constant | Mac | Rough Windows figure |
|---|---|---|
| `VIDEO_DELAY_MS` | 335 | about 65 |
| Sound lead in screen mode (`VIDEO_DELAY_MS - SCREEN_LATENCY_MS`) | 275 | about 90 |
| `SCREEN_LATENCY_MS` measured directly (question 2) | 60 (a guess) | 10 to 45 |
| Webcam delay default | 0 | 0; the webcam needs holding back instead |

The first two and the third do not agree with each other, which is another reason to re-measure.

### The sound holes (problem 1)

An unbroken 440 Hz tone from a window, recorded by the app's recorder. The same detector finds nothing in the question 3 files, where the tone went straight to ffmpeg.

| Condition | Length checked | Holes (Screen / Snapshots) | Hole length | Small breaks (Screen / Snapshots) |
|---|---|---|---|---|
| Window muted | 87 s | 8 / 10 | 116 to 129 ms | not counted |
| Window audible | 87 s | 12 / 12 | 109 to 132 ms | 544 / 571 |
| Without `disable-features=AudioServiceOutOfProcess` | 57 s | 5 / 5 | 118 to 136 ms | 285 / 277 |


#### Cause

The tone was followed through each stage of the app's sound path (`trace.js`, 40 s a run unless said; counters added in memory).

**The copy the page makes with `ScriptProcessor` (`src/recorder/tap-preload.js:30`) delivers less sound than the page plays.** The recorder queues each piece after the one before (`src/recorder/recorder.js:52-57`), so the shortfall uses up the head start (about 0.1 s). When it is gone, line 55 starts the next piece `AUDIO_CUSHION` (0.12 s) ahead: that is the hole. The lost pieces are the small breaks.

| How the page copies its sound | Page rate (Hz) | Share of the sound delivered | Holes the recorder made |
|---|---|---|---|
| As the app does (`ScriptProcessor`, 2048) | 96000 | 98.42%, 98.83% | 5, 4 |
| As the app, page not drawing | 96000 | 98.42% | 5 |
| As the app, page asking for 48 kHz | 48000 | 99.69% | 1 |
| The same, page not drawing | 48000 | 99.87% | 0 |
| `ScriptProcessor`, 16384 | 96000 | 99.61% | 1 |
| **`AudioWorklet`**, 2048 | 96000 | **100.00%** | **0** |
| `AudioWorklet`, Screen recording | 96000 | 100.00% | 0 |
| `AudioWorklet`, 180 s | 96000 | 100.00% | 0 |

- The sound is already broken when it leaves the page. The later stages add only the holes: the writer to ffmpeg padded and threw away nothing in any run, and ffmpeg is clean (question 3).
- With the `AudioWorklet` copy, the finished files had no holes and no breaks, and the head start stayed between 75 and 136 ms.
- This PC's default output (a SteelSeries Sonar virtual device) runs pages at 96 kHz, which loses the most. At 48 kHz sound is still lost, only more slowly: at the measured rates a hole about every 40 to 90 s, so other PCs are likely affected too.
- Page drawing is not the reason. Why Chromium's `ScriptProcessor` loses sound here was not established.
- The `AudioWorklet` copy tested is spike code (`trace-page.js`), not a change to the app. A real fix must also cover media elements and live streams (they use the same copy), and a page whose security policy blocks loading a worklet from a `blob:` address.
- Not checked: a real Foundry page, another output device, the microphone (it does not go through this copy), or the Mac.

## 5. Leftovers

| Question | Answer |
|---|---|
| Echo cancel, setting | Accepted on the Yeti, the BRIO microphone and the default device (it reports on; the input becomes mono) |
| Echo cancel, effect | Hiss from speakers (Arena 7) heard by the Yeti: -42 dB off, -92 dB on, twice. The quiet-room reading was digital silence, so there is no real noise floor to compare with. Voice while the speakers play was not tested |
| Webcam label | `Logitech BRIO (046d:085e)` |
| BRIO microphone label | `Microphone (2- Logitech BRIO) (046d:085e)` |
| Device ids across launches | Unchanged over two launches |
| Saved profiles | `openDevice()` tries id, then exact label, then the system default without saying so. A profile from another machine, or a changed `2- ` prefix, could silently record the default microphone (here a virtual one). Mac labels and replugging were not tested |
| Webcam | 1920x1080 at 30 fps delivered |
| Permissions | Camera and microphone, including desktop apps, were already Allow; the app saw both as granted. Nothing to switch on here. Behaviour with them off was not tested |
| Wording | Errors say "macOS" on Windows (`src/recorder/recorder.js:235`, `:304`) |

## Recommendations

| Open question | Recommendation |
|---|---|
| Fix first | The sound holes: replace the `ScriptProcessor` copy in `tap-preload.js` with an `AudioWorklet`, and test it on a real Foundry page. Run `trace.js` with `asis worklet` on the Mac too, as the code is shared |
| Then | Escape the Calibrate path; let Calibrate use the screen-mode shift on Windows; allow holding the webcam back, and widen the -150 ms limit |
| ffmpeg build | Pin an n8.1 (or 7.1, matching the Mac) build by a dated release tag and SHA-256, not `latest` or `master` |
| Sound route | Keep `pipe:3`. A named pipe is a proven spare |
| Encoder | NVENC first, then QuickSync, then x264. The health check that switches to software only watches `videotoolbox` (`recorder.js:415`) and must cover them. Stop x264's 67 ms shift (for example `-bf 0`, untested) |
| Window picture default | Screen recording, once timing is fixed. It works covered and on another monitor and reaches 60 fps. Warn about, or prevent, minimising |
| Capture behind other windows | Works; the window need not be on top |
| Timing constants | Measure again after the sound fix: the head start swinging between 0 and 0.16 s likely moved the readings |
| AMF | Untested until an AMD machine is available |

## Running the tests again

Each script's first lines say how. `window-capture.js`, `av-sync.js` and `trace.js` open windows on screen, `echo.js` plays sound, and `devices.js` opens the microphones and webcam briefly.

## Re-test on `audio-worklet` (`6c03892`)

Run on 2026-11-27 on this PC, with the n8.1 build. That branch changes the sound copy in `tap-preload.js`; it is not merged here. Its extra test variants and `serve.js` are on that branch.

### Sound

| Case | Page rate (Hz) | Length | Delivered | Holes | Head start (ms) |
|---|---|---|---|---|---|
| Local page, as the app does | 96000 | 180 s | 100.00% | 0 | 13 to 131 |
| Local page at 48 kHz | 48000 | 90 s | 100.01% | 0 | 67 to 117 |
| Media element playing a live stream | 96000 | 90 s | 100.01% | 0 | 93 to 131 |
| Foundry login page (`game.coffeepub.live/join`) | 96000 | 60 s | 100.01% | 0 | 80 to 117 |
| **Insecure address** (`http://` on the PC's network address) | 96000 | 180 s | **98.97%** | **15** (about 120 ms; one 232 ms) | 0 to 304 |

- **The holes are gone wherever the worklet loads.** The files had no breaks either.
- **An insecure address still has them,** about one every 12 s. It reports "Sound copy by the older method: no audio worklets on this page". A Foundry server opened over plain `http://` on a local network would be in this case. A larger fallback block loses less but not nothing (16384: 99.61% and one hole in 40 s, in the earlier trace).
- On the Foundry login page, Foundry had not made an audio context yet, so the tone used one made by the test. Sound from a logged-in game was not tested.

### Timing

`av-sync.js`, window sound copied by the worklet, x264. Median ms the picture is late against the beep.

| Run | Screen recording | Built-in snapshots |
|---|---|---|
| Muted, 75 s, 1 | 238 | 300 |
| Muted, 75 s, 2 | 227 | 293 |
| Audible, 45 s, 1 | 230 | 317 |
| Audible, 45 s, 2 | 231 | 305 |
| **Average** | **232** | **304** |

Readings no longer climb and jump back. These replace the "rough Windows figures" above:

| Windows value | With x264 as it is (picture 66.7 ms late) | With that shift removed |
|---|---|---|
| `VIDEO_DELAY_MS` (Mac 335) | about 35 | about 100 |
| Sound lead in screen mode, `VIDEO_DELAY_MS - SCREEN_LATENCY_MS` (Mac 275) | about 43 | about 110 |
| `SCREEN_LATENCY_MS` that follows | about 0 | about 0 |
| Webcam picture ahead of the voice, Built-in snapshots | about 145 | about 210 |
| Webcam picture ahead of the voice, Screen recording | about 100 | about 100 |

- Worked out as 335 (or 275) minus the measured lateness, taking about 300 ms for snapshots and 232 ms for screen. The values have not been tried in the app. Expect about ±20 ms.
- "With that shift removed" is arithmetic; no encoder setting without it was measured. NVENC as tested wrote no shift (question 3 files).
- The webcam rows use the earlier Calibrate readings, adjusted by the sound lead; only the first x264 snapshot figure (145) was measured directly.
- **Calibrate was not run again.** It records no window sound, and this branch changes nothing it uses.
