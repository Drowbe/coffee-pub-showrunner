# Recording without OBS

**Audience:** anyone deciding how Showrunner should record on its own, and the developers building it.

Status: spike 1 done (below); nothing is built. The code is in `spikes/recording/`.

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

## What this means

The video side of a built-in recorder looks **feasible and cheap**: real windows (including docked ones) can be read with
`capturePage()`, drawn into a layout, and written as a normal MP4 by the browser, at 30 fps for the cost of roughly half a core. The
risk has moved to **audio**, which is also what makes Showrunner worth having over a plain screen recorder (each person leveled on their own).

## Still unproven (spike 2)

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

## Open decisions

- Is a first version allowed to be **mixed audio only**?
- Does it need to work on **Windows** in the first release?
- Where recordings go, and whether the YouTube upload step can take the built-in recorder's file the way it takes OBS's.
