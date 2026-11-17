// Phone/browser audio is converted to 16 kHz for speech recognition without letting high-frequency noise alias
// into the speech band (the previous linear interpolation passed a 12 kHz tone through at full strength).
import { test } from "node:test";
import assert from "node:assert/strict";
import { resampleTo16k } from "../public/js/resample.js";

const rate = 48000;
const tone = (f, secs = 1) => Float32Array.from({ length: rate * secs }, (_, i) => 0.5 * Math.sin((2 * Math.PI * f * i) / rate));
const rms = (a) => Math.sqrt(a.slice(200, -200).reduce((s, v) => s + v * v, 0) / (a.length - 400));

test("speech frequencies pass unchanged, noise above 8 kHz is removed (no aliasing)", () => {
  for (const f of [300, 1000, 3000, 4000]) assert.ok(Math.abs(rms(resampleTo16k(tone(f), rate)) - 0.3536) < 0.01, `${f} Hz kept`);
  assert.ok(rms(resampleTo16k(tone(6000), rate)) > 0.3536 * 0.89, "6 kHz within 1 dB");
  for (const f of [9000, 12000, 20000]) assert.ok(rms(resampleTo16k(tone(f), rate)) < 0.005, `${f} Hz removed`);
});
test("length and common rates are handled", () => {
  assert.equal(resampleTo16k(tone(1000), 48000).length, 16000);
  assert.equal(resampleTo16k(Float32Array.from({ length: 44100 }), 44100).length, 16000);
  assert.equal(resampleTo16k(new Float32Array(0), 48000).length, 0);
  const same = Float32Array.from([0.1, -0.2, 0.3]);
  assert.deepEqual([...resampleTo16k(same, 16000)].map((v) => +v.toFixed(3)), [0.1, -0.2, 0.3]);
});
