# Recording spike

A throwaway harness, not part of the app (it is outside `src/`, so it is not packaged). It asks: can Showrunner record its own windows
to an MP4 without OBS? Findings are in `documentation/plans/plan-recording.md`.

Run it from the repository root, with the repo's Electron:

```bash
node_modules/.bin/electron spikes/recording/main.js
```

Environment: `SPIKE_SECONDS` (length of each recording, default 10) and `SPIKE_ONLY` (comma-separated test number prefixes, e.g. `2,3`).
It writes the MP4s to `spikes/recording/out/` (ignored by git) and `results.json`; the saved `results.json` here merges several batches.

- `main.js` runs the tests, opens the source windows, forwards their frames, and measures CPU with the system `top`.
- `recorder.js` is a hidden window that draws the frames into one canvas (the layout), mixes audio, records with `MediaRecorder`, then
  plays the file back to count frames and measure how far apart a flash and a beep are.
- `page.html` is the stand-in source page (moving shapes, optional WebGL, a flash and a beep together once a second).
- `tap-preload.js` copies a page's audio out of the page.
