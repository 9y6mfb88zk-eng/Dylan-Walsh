// Free on-device speech recognition (Parakeet TDT 0.6B v2, or Whisper base.en, via sherpa-onnx) and clear voice errors.
// The model is downloaded by desktop/scripts/prepare-server.js into desktop/bundle/asr;
// set JARVIS_TEST_ASR_DIR to use another copy. The model test is skipped when the model isn't present.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startMock } from "./mock-upstream.js";
import { startServer, Device } from "./helpers.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const asrDir = process.env.JARVIS_TEST_ASR_DIR || path.join(here, "..", "desktop", "bundle", "asr");
const haveModel = fs.existsSync(path.join(asrDir, "encoder.int8.onnx")) || fs.existsSync(path.join(asrDir, "base.en-encoder.int8.onnx"));
const mock = await startMock();
const servers = [];
after(async () => { for (const s of servers) await s.stop(); mock.server.close(); });

async function signedIn(extraEnv) {
  const { OPENAI_API_KEY, ...env } = mock.env;
  const srv = await startServer({ env }, { NODE_ENV: "production", ...extraEnv });
  servers.push(srv);
  const d = new Device(srv.base);
  await d.call("/api/setup", { method: "POST", body: { code: "SETUP-1234", password: "correct horse battery" } });
  return d;
}

test("transcribes speech on this machine with no OpenAI key", { skip: !haveModel && "Speech model not downloaded (run desktop: npm run prepare-server)" }, async () => {
  const d = await signedIn({ JARVIS_ASR_DIR: asrDir });
  const s = await d.call("/api/session");
  assert.equal(s.data.stt, true);
  assert.equal(s.data.sttLocal, true);
  const wav = fs.readFileSync(path.join(here, "fixtures", "command-48k.wav"));
  const t0 = Date.now();
  const r = await d.call("/api/transcribe", { method: "POST", raw: wav, headers: { "content-type": "audio/wav" } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.match(r.data.text.toLowerCase(), /remind me to call my mum at (6|six)/);
  assert.equal(mock.log.stt, 0, "nothing was sent to OpenAI");
  assert.ok(["high", "medium"].includes(r.data.confidence?.level), JSON.stringify(r.data.confidence));
  assert.ok(r.data.audio?.speechSec > 0.5 && r.data.latencyMs > 0, "audio stats and timing are reported");
  assert.ok(Date.now() - t0 < 15000);
});

test("without any speech engine the error says exactly what to do (not a generic server error)", async () => {
  const d = await signedIn({});
  const r = await d.call("/api/transcribe", { method: "POST", raw: Buffer.alloc(3000, 1), headers: { "content-type": "audio/wav" } });
  assert.equal(r.status, 503);
  assert.match(r.data.error, /speech recognition|OpenAI API key/);
  assert.doesNotMatch(r.data.error, /Something (went wrong|unexpected)/);
});

test("Anthropic failures are explained, e.g. a rejected key", async () => {
  const d = await signedIn({ ANTHROPIC_BASE_URL: `${mock.url}/anthropic-401` });
  const r = await d.call("/api/chat", { method: "POST", body: { text: "hello" } });
  assert.equal(r.status, 502);
  assert.match(r.data.error, /Anthropic API key was rejected/);
});
