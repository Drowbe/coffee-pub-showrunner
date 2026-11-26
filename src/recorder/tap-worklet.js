'use strict';
// Runs on the audio thread, so a busy recorder page cannot make it miss any sound. It gathers the mixed sound into chunks and posts
// them (with the audio clock's time for the start of each chunk) to the page, which writes them out whenever it is free.
class RecorderTap extends AudioWorkletProcessor {
  constructor() {
    super();
    this.size = 1024; this.l = new Float32Array(this.size); this.r = new Float32Array(this.size); this.n = 0; this.t = 0;
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || !input[0]) return true;
    const left = input[0]; const right = input[1] || input[0];
    for (let i = 0; i < left.length; i += 1) {
      if (this.n === 0) this.t = currentTime + i / sampleRate;
      this.l[this.n] = left[i]; this.r[this.n] = right[i]; this.n += 1;
      if (this.n === this.size) {
        this.port.postMessage({ t: this.t, l: this.l, r: this.r }, [this.l.buffer, this.r.buffer]);
        this.l = new Float32Array(this.size); this.r = new Float32Array(this.size); this.n = 0;
      }
    }
    return true;
  }
}
registerProcessor('recorder-tap', RecorderTap);
