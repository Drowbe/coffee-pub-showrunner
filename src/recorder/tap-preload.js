'use strict';
// Runs in each window's page (Foundry, Chameleon, ...) before the page's own scripts. When the built-in recorder is recording, it hands
// a copy of what the page plays to the recorder; the page keeps its own sound. Nothing is sent at any other time, and nothing here
// may ever break the page, so every step is guarded.
const { ipcRenderer, webFrame } = require('electron');

// 0 = off, 1 = only the loudness is reported (for the meters on the recorder page), 2 = the sound itself is sent (recording).
let mode = 0;
ipcRenderer.on('recorder:tap', (_e, value) => { mode = value === 'meter' ? 1 : value ? 2 : 0; });

// The page calls this (it is exposed to the page's own world below, through a single global the copy hooks use).
let nextId = 1;
const send = (id, l, r, rate) => {
  if (mode === 2) { ipcRenderer.send('recorder:audio', { id, l, r, rate }); return; }
  if (mode !== 1) return;
  let peak = 0;
  for (let i = 0; i < l.length; i += 1) { const a = Math.abs(l[i]); const b = Math.abs(r[i]); if (a > peak) peak = a; if (b > peak) peak = b; }
  if (peak > 0.0005) ipcRenderer.send('recorder:peak', peak);
};

try {
  const { contextBridge } = require('electron');
  contextBridge.exposeInMainWorld('__srTap', { send, newId: () => nextId++, info: (text) => ipcRenderer.send('recorder:tapinfo', String(text).slice(0, 120)) });
  webFrame.executeJavaScript(`(() => {
    const bridge = window.__srTap;
    if (!bridge) return;
    const orig = AudioNode.prototype.connect;
    const tapFor = new WeakMap();
    const attach = (ctx, source) => { // copy 'source' (a node or stream source) of 'ctx' to the recorder through a silent processor
      const tap = ctx.createScriptProcessor(2048, 2, 2);
      const id = bridge.newId();
      bridge.info('Web Audio sound found (' + ctx.state + ')');
      tap.onaudioprocess = (e) => bridge.send(id, new Float32Array(e.inputBuffer.getChannelData(0)), new Float32Array(e.inputBuffer.getChannelData(1)), ctx.sampleRate);
      orig.call(tap, ctx.destination); // outputs silence, but must be connected for the page to run
      return tap;
    };
    // Web Audio: whatever is connected to the context's output is also connected to one tap per context.
    AudioNode.prototype.connect = function (target, ...rest) {
      const result = orig.call(this, target, ...rest);
      try {
        const ctx = this.context;
        if (target === ctx.destination && !tapFor.has(this)) {
          let tap = tapFor.get(ctx);
          if (!tap) { tap = attach(ctx); tapFor.set(ctx, tap); }
          orig.call(this, tap);
          tapFor.set(this, true);
        }
      } catch (err) { /* never break the page */ }
      return result;
    };
    // Media elements (<audio>, <video>) and live streams (WebRTC) played in them.
    document.addEventListener('playing', (e) => {
      const el = e.target;
      if (!(el instanceof HTMLMediaElement) || el.__srTapped) return;
      try {
        const stream = el.srcObject instanceof MediaStream ? el.srcObject : (el.captureStream ? el.captureStream() : null);
        if (!stream || !stream.getAudioTracks().length) { bridge.info('A video or audio player has no sound Showrunner can copy'); return; }
        bridge.info(el.srcObject instanceof MediaStream ? 'Live stream (WebRTC) sound found' : 'Audio or video player sound found');
        el.__srTapped = true;
        const ctx = new AudioContext();
        const src = ctx.createMediaStreamSource(new MediaStream(stream.getAudioTracks()));
        orig.call(src, attach(ctx));
      } catch (err) { bridge.info('Could not copy the sound of a player: ' + err.message); }
    }, true);
  })();`).catch(() => {});
} catch (err) { /* a page without the bridge simply has no copy */ }
