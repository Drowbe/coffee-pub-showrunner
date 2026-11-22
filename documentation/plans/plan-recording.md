# Recording without OBS

**Audience:** anyone deciding how Showrunner should record on its own, and the developers building it.

Status: spikes 1 and 2 done (below); the backend interface is in PR #68; the recorder itself is not built. The code is in `spikes/recording/`.

## The idea

Showrunner records its own windows to an MP4, with a few layouts, and **OBS becomes an optional extra** for people who want scenes,
filters and plugins, not a requirement. The case for it: OBS setup is the biggest hurdle for a new user, and a small Windows recorder
(FastCast) sells itself on "3 steps instead of 9". Showrunner already owns the windows it would record, and it already has the cues,
rule sets and metadata that decide what happens when, so a "scene change" becomes a layout change.

Three steps were agreed, to follow the next release: (1) a spike, (2) a **recording backend** interface that OBS plugs into with a
list of what it can do, (3) a **built-in recorder** with a few layouts. Streamlabs Desktop and driving QuickTime or FastCast are
later and only if there is demand.

## Spike 1: what was measured

An Electron harness (45.4.1, Chromium 156) on an Apple Silicon Mac. A hidden recorder window draws the frames from one or two source
windows into a 1920x1080 canvas and records it with `MediaRecorder`. Ten-second recordings, played back to measure frames and sync.

| Question | Result |
| --- | --- |
| Can the browser itself write an MP4? | **Yes.** `video/mp4;codecs=avc1.640028` (H.264 High) with AAC audio. The files open as 1920x1080 H.264 in macOS and the audio is 48 kHz stereo AAC. No encoder has to be bundled, which keeps the "free for commercial use" rule easy. |
| Frame rate at 1080p30 | **30 fps held** in every case: 29.4 to 30.1 effective, longest gap 65 to 68 ms (two frames). One window, two windows, a WebGL page, and a page drawing thousands of shapes all held it. |
| 1080p60 | **55 fps** effective (longest gap 49 ms). Close, not exact. |
| CPU | **About 40% to 65% of one core** for the whole app (system `top`; the app's own figure reads far too low): 23% for the recorder drawing alone, 42 to 57% with one or two source windows, 64% with two real windows. Hardware H.264 encoding does the heavy part. |
| Getting frames from a real, visible window | **`webContents.capturePage()` works**: about 28 fps at 1280x720, about 1 ms to read each frame, ~100 MB/s of pixels per window passed to the recorder (fine). It also works for a window **parked off every screen** (the edge dock's position), which matters because docked windows must still record. |
| `beginFrameSubscription` on a real window | **Does not work** (zero frames, a black recording). Not an option. |
| Offscreen windows (`offscreen: true`) | Work and give frames, but they cannot be clicked or logged in to, so they only suit windows nobody touches. Real windows with `capturePage()` are the better fit. |
| A page's own audio, separate from everything else | **Works for Web Audio.** A small script injected before the page runs copies what the page sends to its output; the recorder mixes it. 10 of 10 beeps found. |
| Audio and video in step | Audio arrives **about 110 to 175 ms after** the picture it belongs to (median about 150 ms), steady enough to fix with a fixed delay, or better with timestamps. Cause: a 120 ms cushion plus the chunk size. |
| System audio ("loopback") | **Inconclusive.** The track was handed back but ended at once in this unpackaged dev build. Needs a test in a packaged app with the right permission. Note it would not hear Showrunner's own windows anyway (the per-page copy does that). |
| Microphone | **Not tested.** The permission is "not determined", so it would prompt. |
| Windows (the OS) | **Not tested.** The same code should run; the H.264 encoder there is a different one. |

The raw numbers are in `spikes/recording/results.json`.

## Spike 2: what was measured (run overnight, Mac only)

| Question | Result |
| --- | --- |
| Audio from `<audio>` / `<video>` elements | **Works.** Copying the element's stream (leaving it playing) found 20 of 20 beeps. |
| Audio from WebRTC (what Chameleon uses) | **Works for continuous audio**: tapping the remote stream directly got 100% of the chunks of a steady tone over 10 s. Short beeps through a same-page loopback were caught only about half the time, although the page itself heard them all. Likely a quirk of the loopback test, but **a real Chameleon room still has to confirm it**. Tap the stream itself, not the element's `captureStream()`. |
| Audio and video in step | **Fixed.** A 0.04 s audio cushion (was 0.12) plus holding the picture back 60 ms puts beep and flash within about 20 ms of each other (was about 150 ms late). The 60 ms is a measured constant for this pipeline, so re-measure on Windows. |
| 30-minute recording | **Held.** Exactly 1800.0 s, 1800 of 1800 beeps, 1800 flashes, longest frame gap 201 ms at 4x check speed (so not a real figure), and **no drift**: the audio-to-picture offset averaged -6 ms over the first 100 beeps and -5 ms over the last 100. About 48% of one core throughout. 1.82 GB file at 8 Mbps video. |
| Memory over 30 minutes | **Grew from 1.1 GB to 2.8 GB** (about 57 MB a minute) because this harness keeps the whole recording in memory until the end. The real recorder must write each chunk to disk as it arrives. (Writing straight from the recorder window's data event stalled in my first try, so that path needs its own small test.) |
| Microphone | Skipped on purpose (it prompts). Still to do with someone at the machine. |
| System audio in a packaged app | Not done (needs a packaged build). |
| Windows | Not done. |
| Streaming (RTMP) | Not covered. |

Decisions taken: **mixed audio only is acceptable for the first version, Mac first.** Per-window audio from the page is available anyway.

Raw numbers: `spikes/recording/results.json` and the soak run.

## The backend interface (PR #68)

`src/recording.js` defines what a backend can do (record, pause, stream, scenes, sources, levels), wraps OBS as the first backend, and
routes the six record and stream actions through the active backend. Choosing a backend in the profile and filtering the step menu by
capability come with the built-in recorder.

## Step 3: what building the recorder taught us (PR #68)

- **MediaRecorder's MP4 is not streamed.** Chrome holds the whole MP4 until you stop (no `dataavailable` data during recording, with or
  without `requestData()`), which is the 57 MB a minute seen in the soak: a three-hour session would be about 10 GB of memory and
  a crash would lose everything. The built-in recorder therefore uses **WebCodecs** (the computer's H.264 and AAC encoders) and the
  vendored MIT `mp4-muxer` to write a **fragmented MP4** to disk as it goes. Memory is flat and a crash loses about a second.
- **Still pictures need a nudge.** A page that does not change (an idle map) gave the encoder almost no new frames. One pixel in the
  corner changes every frame, so every frame counts.
- **The "none" audio output made the sound drift** (about 4 ms per second against the picture). A normal (silent) output context stays
  put; remaining slow drift is corrected by nudging the audio timestamps 1% of the way towards the wall clock each block.
- **Sync, re-measured on the final pipeline:** within about -20 to +15 ms for 60 seconds, no drift (picture delay 70 ms, 2048-sample blocks).
- **Reading a window inside the app:** `capturePage()` on the page view inside each window works (without the title bar), including
  two side by side. A still page records at full length.
- Not yet verified: Windows, microphone, a real Foundry/Chameleon page, a window that reloads mid-recording.

## What this means

The video side of a built-in recorder looks **feasible and cheap**: real windows (including docked ones) can be read with
`capturePage()`, drawn into a layout, and written as a normal MP4 by the browser, at 30 fps for the cost of roughly half a core. The
risk has moved to **audio**, which is also what makes Showrunner worth having over a plain screen recorder (each person leveled on their own).

## Still unproven after spike 2

(Items 1 and 5 are largely answered above; 2, 4, 6 and 7 remain.)

1. **Audio for the pages that matter.** Only Web Audio was tested. Foundry's sound may use media elements (`<audio>`, `<video>`), and
   Chameleon's people arrive as WebRTC streams in media elements, so the copy has to cover those (`createMediaElementSource`, element
   `captureStream`). Test each against a real Foundry page and a real Chameleon room.
2. **Microphone and system audio** in a packaged build, with the permission prompts and what macOS shows the user.
3. **A long recording**: 30 minutes for audio/video drift, memory growth and file size, and a recording that survives a window
   reloading or closing.
4. **Windows**: the same harness, with its own encoder and permissions.
5. **Audio sync** fixed properly (timestamps, or a measured delay), then measured again.
6. **Leveling**: Auto level works on OBS's meters today; a built-in recorder needs its own level measurement per source.
7. **Streaming (RTMP)** is not covered at all and needs something other than the browser (an encoder and a network sender).

## Proposed order

1. Spike 2, the unproven list above, starting with audio (1 to 2 days). If media elements and WebRTC cannot be copied, the plan
   becomes "mixed desktop audio only" for the simple recorder, and per-person audio stays an OBS feature.
2. The **recording backend** interface: OBS behind it, with a list of what each backend can do, and the step menu showing only what
   the chosen backend supports.
3. The **built-in recorder**: start, stop and pause from the same actions and cues, the session filename format, one window or two
   side by side or picture-in-picture, MP4 to a chosen folder.
4. Later, not committed: webcam, a mixer, RTMP, Streamlabs Desktop, driving FastCast on Windows through its command line.

## Release scope (agreed with the user)

The Showrunner Recorder ships in two releases. The test for Release A: does it replace OBS for the usual session.

**Release A** (all on PR #68):
1. Session fields that suit any recording (the campaign wording becomes optional) and the session filename template for the recorder's files, with date and number as the fallback.
2. Audio settings: windows' sound plus the **microphone**, each with a level and a mute, into one mixed track. Measure the microphone's delay as the windows' was measured. Echo note and an echo-cancel switch.
3. **Webcam**, recordable alone. Camera and microphone pickers per profile. Basic layouts: one window, two side by side, a window with the webcam in a corner (corner and size chosen), the webcam full screen.
4. A recording toolbar: Start, Pause, Stop, timer, level meters and sliders.
5. Disk space check, recovery message for an interrupted recording, Reveal in Finder, YouTube upload tested end to end.
6. Real-page tests (Foundry, Chameleon, a window reloading mid-recording, sync at 30 minutes) and the packaged-app permission check (camera and microphone usage descriptions and entitlements). Cut an early test build so the permission risk shows first.

**Release B:** named, saved layouts; automation steps that change layout; title and end cards with an image, a sound or a video (a title movie, credits), played into the file.

**To schedule (added by the user):** simple drawing on the source window, to circle or point at things while recording: pen, circle,
arrow and highlighter, a clear button, and optionally strokes that fade out after a few seconds. The recorder lays out captured
pictures of the windows, so an overlay window above a source would not be in the recording. The strokes have to be drawn by the
recorder on top of the picture (a transparent window over the source takes the mouse and sends the strokes to the recorder).
Open question: Release A or B. It fits the toolbar (a Draw button with the tool choices).

**Later:** Windows, streaming without OBS, sound from a packaged build on Mac if it needs more work, FastCast and Streamlabs.

**Build order for A:** session and filename, then microphone and audio settings, then webcam and layouts, then the toolbar, then packaging checks.

Rules for all UI built here: anything that can be too long truncates with an ellipsis and shows the full text as a tooltip; options the chosen recorder cannot do are not shown.

## Open decisions

- Decided: mixed audio only is fine for a first version; Mac first, Windows after.
- Decided: microphone and webcam are in Release A; webcam alone is allowed; one mixed track; title and end cards are Release B.
- Where recordings go, and whether the YouTube upload step can take the built-in recorder's file the way it takes OBS's.
