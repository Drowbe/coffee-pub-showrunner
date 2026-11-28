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

// The copy runs on the audio thread (an AudioWorklet), in the page's own world. It gathers the sound into blocks of 2048 and posts each
// block to the page's hook, which hands it on. Plain strings, so it needs no file the page's security policy could refuse.
const WORKLET = [
  "registerProcessor('showrunner-tap', class extends AudioWorkletProcessor {",
  "  constructor() { super(); this.l = new Float32Array(2048); this.r = new Float32Array(2048); this.n = 0; }",
  "  process(inputs) {",
  "    const i = inputs[0]; if (!i || !i[0]) return true;",
  "    const a = i[0]; const b = i[1] || i[0];",
  "    for (let k = 0; k < a.length; k += 1) {",
  "      this.l[this.n] = a[k]; this.r[this.n] = b[k]; this.n += 1;",
  "      if (this.n === 2048) { this.port.postMessage({ l: this.l, r: this.r }, [this.l.buffer, this.r.buffer]); this.l = new Float32Array(2048); this.r = new Float32Array(2048); this.n = 0; }",
  "    }",
  "    return true;",
  "  }",
  "});",
].join('\n');

try {
  const { contextBridge } = require('electron');
  contextBridge.exposeInMainWorld('__srTap', { send, newId: () => nextId++, info: (text) => ipcRenderer.send('recorder:tapinfo', String(text).slice(0, 120)) });
  webFrame.executeJavaScript(`(() => {
    const bridge = window.__srTap;
    if (!bridge) return;
    const workletSource = ${JSON.stringify(WORKLET)};
    const orig = AudioNode.prototype.connect;
    const tapFor = new WeakMap();
    // Copies what reaches 'input' (a gain node made for the purpose) to the recorder. The copy is gathered on the audio thread by an
    // AudioWorklet, which misses no sound (the older ScriptProcessor lost about 1.5 percent of it, which the recorder heard as holes).
    // A page that does not allow a worklet (an insecure address, or a security policy that blocks blob: and data: addresses) gets the
    // ScriptProcessor instead, so the page is never left without a copy and never broken.
    const give = (id, ctx, l, r) => bridge.send(id, l, r, ctx.sampleRate);
    const viaScript = (ctx, input, id) => {
      const tap = ctx.createScriptProcessor(2048, 2, 2);
      tap.onaudioprocess = (e) => give(id, ctx, new Float32Array(e.inputBuffer.getChannelData(0)), new Float32Array(e.inputBuffer.getChannelData(1)));
      orig.call(input, tap);
      orig.call(tap, ctx.destination); // outputs silence, but must be connected for the page to run
    };
    const viaWorklet = async (ctx, input, id) => {
      if (!ctx.audioWorklet) throw new Error('no audio worklets on this page');
      let lastErr = null;
      for (const make of [(src) => URL.createObjectURL(new Blob([src], { type: 'text/javascript' })), (src) => 'data:text/javascript;base64,' + btoa(src)]) {
        let url = '';
        try {
          url = make(workletSource);
          await ctx.audioWorklet.addModule(url);
          lastErr = null;
          break;
        } catch (err) { lastErr = err; } finally { if (url.startsWith('blob:')) URL.revokeObjectURL(url); }
      }
      if (lastErr) throw lastErr;
      const tap = new AudioWorkletNode(ctx, 'showrunner-tap', { numberOfInputs: 1, numberOfOutputs: 0, channelCount: 2, channelCountMode: 'explicit' });
      tap.port.onmessage = (e) => give(id, ctx, e.data.l, e.data.r);
      orig.call(input, tap); // no output, so nothing to connect to the speakers
    };
    const attach = (ctx) => { // returns a node that whatever is to be copied is connected to
      const input = ctx.createGain();
      const id = bridge.newId();
      bridge.info('Web Audio sound found (' + ctx.state + ')');
      const fallBack = (why) => { try { bridge.info('Sound copy by the older method: ' + why); viaScript(ctx, input, id); } catch (err) { /* never break the page */ } };
      try { viaWorklet(ctx, input, id).catch((err) => fallBack(String(err && err.message || err).slice(0, 60))); } catch (err) { fallBack(String(err && err.message || err).slice(0, 60)); }
      return input;
    };
    // Web Audio: whatever is connected to the context's output is also connected to one tap per context.
    AudioNode.prototype.connect = function (target, ...rest) {
      const result = orig.call(this, target, ...rest);
      try {
        const ctx = this.context;
        if (typeof OfflineAudioContext !== 'undefined' && ctx instanceof OfflineAudioContext) return result; // not played, so not recorded
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
