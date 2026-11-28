'use strict';
// Spike: other ways for the test page to hand its tone to the recorder (all through the app's own bridge, __srTap), to compare with
// the app's copy (src/recorder/tap-preload.js: a ScriptProcessor of 2048 samples). Injected into sync.html by trace.js.
// Each returns the page's audio context as window.ctx. None of the others connects to the speakers, so the app's copy stays out.
(() => {
  const make = (rate) => { const ctx = new AudioContext(rate ? { sampleRate: rate } : {}); window.ctx = ctx; const o = ctx.createOscillator(); const gain = ctx.createGain(); gain.gain.value = 0.3; o.frequency.value = 440; o.connect(gain); o.start(); return { ctx, gain }; };
  const give = (id, l, r, rate) => window.__srTap.send(id, l, r, rate);
  window.variants = {
    // as the app does it
    asis: () => { const { ctx, gain } = make(); gain.connect(ctx.destination); },
    // a real Foundry page: the tone goes through Foundry's own audio context when it has one (game.audio.context)
    foundry: () => { const fc = window.game && window.game.audio && window.game.audio.context; const ctx = fc || new AudioContext(); window.ctx = ctx; const o = ctx.createOscillator(); const gain = ctx.createGain(); gain.gain.value = 0.3; o.frequency.value = 440; o.connect(gain); gain.connect(ctx.destination); o.start(); return fc ? 'foundry context' : 'own context'; },
    // a tone played through a media element from a live stream (the route live streams and <audio> players take), not through Web Audio's output
    media: () => { const ctx = new AudioContext(); window.ctx = ctx; const dest = ctx.createMediaStreamDestination(); const o = ctx.createOscillator(); const gain = ctx.createGain(); gain.gain.value = 0.3; o.frequency.value = 440; o.connect(gain); gain.connect(dest); o.start(); const el = document.createElement('audio'); el.srcObject = dest.stream; document.body.appendChild(el); el.play(); },
    // the app's copy, with the page asking for 48 kHz instead of the output device's own rate
    asis48000: () => { const { ctx, gain } = make(48000); gain.connect(ctx.destination); },
    // the same kind of copy, with the largest block
    script16384: () => { const { ctx, gain } = make(); const tap = ctx.createScriptProcessor(16384, 2, 2); tap.onaudioprocess = (e) => give(1, new Float32Array(e.inputBuffer.getChannelData(0)), new Float32Array(e.inputBuffer.getChannelData(1)), ctx.sampleRate); gain.connect(tap); tap.connect(ctx.createMediaStreamDestination()); },
    // gathered on the audio thread (as the recorder's own tap-worklet.js does), posted in blocks of 2048
    worklet: async () => {
      const { ctx, gain } = make();
      const code = `registerProcessor('spike-tap', class extends AudioWorkletProcessor {
        constructor() { super(); this.l = new Float32Array(2048); this.r = new Float32Array(2048); this.n = 0; }
        process(inputs) { const i = inputs[0]; if (!i || !i[0]) return true; const a = i[0]; const b = i[1] || i[0];
          for (let k = 0; k < a.length; k += 1) { this.l[this.n] = a[k]; this.r[this.n] = b[k]; this.n += 1;
            if (this.n === 2048) { this.port.postMessage({ l: this.l, r: this.r }); this.l = new Float32Array(2048); this.r = new Float32Array(2048); this.n = 0; } }
          return true; } });`;
      await ctx.audioWorklet.addModule(URL.createObjectURL(new Blob([code], { type: 'text/javascript' })));
      const tap = new AudioWorkletNode(ctx, 'spike-tap', { numberOfInputs: 1, numberOfOutputs: 0 });
      tap.port.onmessage = (e) => give(1, e.data.l, e.data.r, ctx.sampleRate);
      gain.connect(tap);
    },
  };
})();
