// Background keyword spotter (Electron utility process): listens for "JARVIS" and "HEY JARVIS"
// in the 16 kHz audio stream from the wake-word window. Runs entirely on this laptop (sherpa-onnx, open-vocabulary KWS).
const path = require("node:path");

let sherpa, kws, stream, enabled = { jarvis: true }, frames = 0;
function post(m) { process.parentPort.postMessage(m); }

try {
  sherpa = require(process.env.JARVIS_SHERPA_PATH);
  const dir = process.env.JARVIS_KWS_DIR;
  kws = new sherpa.KeywordSpotter({
    featConfig: { sampleRate: 16000, featureDim: 80 },
    modelConfig: {
      transducer: { encoder: path.join(dir, "encoder.int8.onnx"), decoder: path.join(dir, "decoder.onnx"), joiner: path.join(dir, "joiner.int8.onnx") },
      tokens: path.join(dir, "tokens.txt"), numThreads: 1, provider: "cpu", debug: 0,
    },
    keywordsFile: path.join(dir, "keywords.txt"),
  });
  stream = kws.createStream();
  post({ type: "ready" });
} catch (e) {
  post({ type: "error", error: e.message });
}

process.parentPort.on("message", (e) => {
  const m = e.data;
  if (!kws) return;
  if (m.type === "config") { enabled = { ...enabled, ...m }; return; }
  if (m.type === "reset") { stream = kws.createStream(); return; }
  if (m.type !== "pcm") return;
  const i16 = new Int16Array(m.pcm.buffer || m.pcm, m.pcm.byteOffset || 0, (m.pcm.byteLength || m.pcm.length * 2) / 2);
  const f = new Float32Array(i16.length);
  for (let i = 0; i < i16.length; i++) f[i] = i16[i] / 32768;
  stream.acceptWaveform({ sampleRate: 16000, samples: f });
  while (kws.isReady(stream)) {
    kws.decode(stream);
    const r = kws.getResult(stream);
    if (r.keyword) {
      kws.reset(stream);
      if (r.keyword === "JARVIS" && !enabled.jarvis) continue;
      post({ type: "wake", keyword: r.keyword });
    }
  }
  if (++frames % 250 === 0) post({ type: "alive" });
});
