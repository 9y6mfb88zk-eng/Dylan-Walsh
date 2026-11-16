// Smoke test of what the installer ships, run with the BUNDLED Node on the build machine (Windows in CI):
//  1. local Whisper transcribes a recorded command,
//  2. the keyword spotter hears "JARVIS" on its own,
//  3. the bundled JARVIS server starts and answers.
// Usage: <desktop>/bundle/node/node[.exe] scripts/bundle-smoke.js
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const desktop = path.join(here, "..");
const app = path.join(desktop, "bundle", "server-app");
const require = createRequire(path.join(app, "package.json"));
const sherpa = require("sherpa-onnx-node");
let failed = 0;
const check = (name, ok, detail = "") => { console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`); if (!ok) failed++; };

// 1. Whisper
const asr = path.join(desktop, "bundle", "asr");
const rec = await sherpa.OfflineRecognizer.createAsync({
  featConfig: { sampleRate: 16000, featureDim: 80 },
  modelConfig: { whisper: { encoder: path.join(asr, "base.en-encoder.int8.onnx"), decoder: path.join(asr, "base.en-decoder.int8.onnx"), language: "en", task: "transcribe" }, tokens: path.join(asr, "base.en-tokens.txt"), numThreads: 2, provider: "cpu", debug: 0 },
});
const w = sherpa.readWave(path.join(desktop, "..", "test", "fixtures", "command-48k.wav"));
const st = rec.createStream(); st.acceptWaveform({ sampleRate: w.sampleRate, samples: w.samples });
await rec.decodeAsync(st);
const text = rec.getResult(st).text;
check(`local Whisper on ${os.platform()}`, /call my mum/i.test(text), JSON.stringify(text));

// 2. Keyword spotter
const kd = path.join(desktop, "models", "kws");
const kws = new sherpa.KeywordSpotter({
  featConfig: { sampleRate: 16000, featureDim: 80 },
  modelConfig: { transducer: { encoder: path.join(kd, "encoder.int8.onnx"), decoder: path.join(kd, "decoder.onnx"), joiner: path.join(kd, "joiner.int8.onnx") }, tokens: path.join(kd, "tokens.txt"), numThreads: 1, provider: "cpu", debug: 0 },
  keywordsFile: path.join(kd, "keywords.txt"),
});
const mic = sherpa.readWave(path.join(desktop, "test", "fixtures", "mic-jarvis-alone.wav"));
const ks = kws.createStream(); const hits = [];
for (let i = 0; i < mic.samples.length; i += 1280) {
  ks.acceptWaveform({ sampleRate: mic.sampleRate, samples: mic.samples.subarray(i, i + 1280) });
  while (kws.isReady(ks)) { kws.decode(ks); const r = kws.getResult(ks); if (r.keyword) { hits.push(r.keyword); kws.reset(ks); } }
}
check(`keyword spotter hears "JARVIS" on ${os.platform()}`, hits.includes("JARVIS"), hits.join(","));

// 3. Bundled server
const data = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-smoke-"));
const port = 47900 + Math.floor(Math.random() * 50);
const srv = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", path.join(app, "server", "index.js")], {
  cwd: app, env: { ...process.env, PORT: String(port), HOST: "127.0.0.1", JARVIS_DATA_DIR: data, JARVIS_ASR_DIR: asr, JARVIS_HOSTING: "laptop", NODE_ENV: "production", IDEAS_ENABLED: "false" }, stdio: "ignore",
});
let up = false;
for (let i = 0; i < 60 && !up; i++) { try { up = (await fetch(`http://127.0.0.1:${port}/api/health/ping`)).ok; } catch {} if (!up) await new Promise((r) => setTimeout(r, 250)); }
check(`bundled JARVIS server runs on ${os.platform()} (Node ${process.version})`, up);
srv.kill();
process.exit(failed ? 1 : 0);
