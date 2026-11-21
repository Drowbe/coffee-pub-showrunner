'use strict';
// Runs in each source window before the page's own scripts. It makes a copy of everything the page sends to its audio output and
// forwards it to the main process, which hands it to the recorder: the page keeps its own sound, and we get it as a separate track.
const { contextBridge, ipcRenderer, webFrame } = require('electron');

contextBridge.exposeInMainWorld('__srTap', (l, r, rate) => ipcRenderer.send('tap', { l, r, rate }));

webFrame.executeJavaScript(`(() => {
  const orig = AudioNode.prototype.connect;
  const taps = new WeakMap();
  // Media elements (<audio>, <video>, and WebRTC streams played in them): copy their stream, leaving the element playing as it was.
  const tapElement = (el) => {
    if (el.__srTapped || !el.captureStream) return;
    try {
      const stream = el.srcObject instanceof MediaStream ? el.srcObject : el.captureStream(); // a live stream (WebRTC) is tapped directly: capturing it back out of the element drops audio
      if (!stream.getAudioTracks().length) return;
      el.__srTapped = true;
      const ctx = new AudioContext();
      const src = ctx.createMediaStreamSource(new MediaStream(stream.getAudioTracks()));
      const tap = ctx.createScriptProcessor(2048, 2, 2);
      tap.onaudioprocess = (e) => window.__srTap(new Float32Array(e.inputBuffer.getChannelData(0)), new Float32Array(e.inputBuffer.getChannelData(1)), ctx.sampleRate);
      src.connect(tap); orig.call(tap, ctx.destination);
    } catch (err) { /* never break the page */ }
  };
  document.addEventListener('playing', (e) => { if (e.target instanceof HTMLMediaElement) tapElement(e.target); }, true);
  AudioNode.prototype.connect = function (target, ...rest) {
    const result = orig.call(this, target, ...rest);
    try {
      const ctx = this.context;
      if (target === ctx.destination && !taps.has(this)) {
        let tap = taps.get(ctx);
        if (!tap) {
          tap = ctx.createScriptProcessor(2048, 2, 2);
          tap.onaudioprocess = (e) => window.__srTap(new Float32Array(e.inputBuffer.getChannelData(0)), new Float32Array(e.inputBuffer.getChannelData(1)), ctx.sampleRate);
          orig.call(tap, ctx.destination); // outputs silence, but must be connected for the page to run
          taps.set(ctx, tap);
        }
        orig.call(this, tap);
        taps.set(this, true);
      }
    } catch (err) { /* never break the page */ }
    return result;
  };
})();`);
