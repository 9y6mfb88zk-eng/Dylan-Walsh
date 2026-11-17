// Background thread for converting recorded audio to 16 kHz WAV, so the interface never pauses while it runs.
import { resampleTo16k } from "./resample.js";
self.onmessage = (e) => {
  const { id, samples, rate } = e.data;
  try { const out = resampleTo16k(samples, rate); self.postMessage({ id, out }, [out.buffer]); }
  catch (err) { self.postMessage({ id, error: err.message }); }
};
