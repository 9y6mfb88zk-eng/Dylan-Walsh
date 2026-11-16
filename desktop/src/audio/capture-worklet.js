// Collects microphone samples on the audio thread and hands them to the page in ~80 ms batches.
class Capture extends AudioWorkletProcessor {
  constructor() { super(); this.buf = new Float32Array(4096); this.n = 0; this.target = Math.round(sampleRate * 0.08); }
  process(inputs) {
    const ch = inputs[0]?.[0];
    if (ch) {
      if (this.n + ch.length > this.buf.length) { const b = new Float32Array(this.buf.length * 2); b.set(this.buf.subarray(0, this.n)); this.buf = b; }
      this.buf.set(ch, this.n); this.n += ch.length;
      if (this.n >= this.target) { this.port.postMessage(this.buf.slice(0, this.n)); this.n = 0; }
    }
    return true;
  }
}
registerProcessor("jarvis-capture", Capture);
