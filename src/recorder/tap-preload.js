'use strict';
// Runs in each window's page (Foundry, Chameleon, ...) before the page's own scripts. When the built-in recorder is recording, it hands
// a copy of what the page plays to the recorder; the page keeps its own sound. Nothing is sent at any other time, and nothing here
// may ever break the page, so every step is guarded.
const { ipcRenderer, webFrame } = require('electron');

let on = false;
ipcRenderer.on('recorder:tap', (_e, enabled) => { on = Boolean(enabled); });

// The page calls this (it is exposed to the page's own world below, through a single global the copy hooks use).
let nextId = 1;
const send = (id, l, r, rate) => { if (on) ipcRenderer.send('recorder:audio', { id, l, r, rate }); };

try {
  const { contextBridge } = require('electron');
  contextBridge.exposeInMainWorld('__srTap', { send, newId: () => nextId++ });
  webFrame.executeJavaScript(`(() => {
    const bridge = window.__srTap;
    if (!bridge) return;
    const orig = AudioNode.prototype.connect;
    const tapFor = new WeakMap();
    const attach = (ctx, source) => { // copy 'source' (a node or stream source) of 'ctx' to the recorder through a silent processor
      const tap = ctx.createScriptProcessor(2048, 2, 2);
      const id = bridge.newId();
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
        if (!stream || !stream.getAudioTracks().length) return;
        el.__srTapped = true;
        const ctx = new AudioContext();
        const src = ctx.createMediaStreamSource(new MediaStream(stream.getAudioTracks()));
        orig.call(src, attach(ctx));
      } catch (err) { /* never break the page */ }
    }, true);
  })();`).catch(() => {});
} catch (err) { /* a page without the bridge simply has no copy */ }
