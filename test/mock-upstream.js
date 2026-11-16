// A single fake upstream standing in for Anthropic, Open-Meteo, ElevenLabs, OpenAI and a push service.
import http from "node:http";
import https from "node:https";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

// Push services are always HTTPS, so the fake push endpoint gets a throwaway self-signed cert.
function selfSigned() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-cert-"));
  const key = path.join(dir, "key.pem"), cert = path.join(dir, "cert.pem");
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", cert, "-days", "1",
    "-subj", "/CN=127.0.0.1", "-addext", "subjectAltName=IP:127.0.0.1"], { stdio: "ignore" });
  return { key: fs.readFileSync(key), cert: fs.readFileSync(cert), certPath: cert };
}

// ~1.6s of syllable-like modulated tone, so the browser has real audio to analyse.
function speechLikeWav(seconds = 1.6, rate = 22050) {
  const n = Math.floor(seconds * rate), buf = Buffer.alloc(44 + n * 2);
  buf.write("RIFF", 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write("WAVE", 8); buf.write("fmt ", 12);
  buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22); buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34); buf.write("data", 36); buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) {
    const t = i / rate, env = Math.max(0, Math.sin(t * Math.PI * 5)) ** 1.5;
    const v = env * (0.5 * Math.sin(2 * Math.PI * 140 * t) + 0.3 * Math.sin(2 * Math.PI * 420 * t) + 0.15 * Math.sin(2 * Math.PI * 900 * t));
    buf.writeInt16LE(Math.round(v * 20000), 44 + i * 2);
  }
  return buf;
}

export function startMock() {
  const log = { anthropic: [], tts: [], stt: 0, push: [], meteo: 0 };
  let ideaN = 0;
  const msg = (content, stop_reason = "end_turn") => ({
    id: `msg_${Math.random().toString(36).slice(2)}`, type: "message", role: "assistant", model: "claude-opus-5-5",
    content, stop_reason, stop_sequence: null, stop_details: null, usage: { input_tokens: 10, output_tokens: 10 },
  });
  const server = http.createServer(async (req, res) => {
    const chunks = []; for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks);
    const url = new URL(req.url, "http://x");
    const json = (code, obj) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(obj)); };

    if (url.pathname === "/v1/messages") {
      const body = JSON.parse(raw.toString());
      log.anthropic.push(body);
      if (body.output_config?.format) {
        ideaN++;
        return json(200, msg([{ type: "text", text: JSON.stringify({
          title: `Idea number ${ideaN} ${["Villa cleaning scheduler", "Ship crew visa assistant", "Greek menu translator"][ideaN % 3]}`,
          pitch: "A clear problem. Someone pays.", why_now: "Cyprus is ready.", budget: "under €300",
          mvp: ["Step one", "Step two", "Step three"], first_move: `Call five prospects for idea ${ideaN}`,
        }) }]));
      }
      const last = body.messages.at(-1);
      if (Array.isArray(last.content) && last.content[0]?.type === "tool_result") {
        return json(200, msg([{ type: "text", text: "Very good, sir. Consider it done." }]));
      }
      const text = typeof last.content === "string" ? last.content : "";
      if (body.tools && /remind/i.test(text)) {
        const due = new Date(Date.now() + 2000).toISOString();
        return json(200, msg([{ type: "tool_use", id: "toolu_1", name: "add_reminder", input: { text: "stretch your legs", due_at: due } }], "tool_use"));
      }
      if (body.tools && /add .*task/i.test(text)) {
        return json(200, msg([{ type: "tool_use", id: "toolu_2", name: "add_task", input: { title: "Buy halloumi" } }], "tool_use"));
      }
      if (/briefing|brief me/i.test(text)) return json(200, msg([{ type: "text", text: "Good morning, sir. It is twenty-one degrees and sunny in Dhekelia. You have one task." }]));
      return json(200, msg([{ type: "text", text: "Splendid question, sir. I'm entirely at your disposal." }]));
    }
    if (url.pathname === "/v1/forecast") {
      log.meteo++;
      const hours = Array.from({ length: 48 }, (_, i) => new Date(Date.UTC(2026, 10, 16, i)).toISOString().slice(0, 16));
      return json(200, {
        timezone: "Asia/Nicosia",
        current: { time: hours[9], temperature_2m: 21.4, apparent_temperature: 20.9, relative_humidity_2m: 60, weather_code: 1, wind_speed_10m: 12, is_day: 1 },
        hourly: { time: hours, temperature_2m: hours.map((_, i) => 15 + (i % 10)), weather_code: hours.map(() => 1), precipitation_probability: hours.map(() => 5) },
        daily: { weather_code: [1, 61], temperature_2m_max: [23, 20], temperature_2m_min: [14, 13], precipitation_probability_max: [5, 70], uv_index_max: [4.2, 3], sunrise: ["2026-11-16T06:20"], sunset: ["2026-11-16T16:45"] },
      });
    }
    if (url.pathname.startsWith("/v1/text-to-speech/")) {
      log.tts.push(JSON.parse(raw.toString()));
      res.writeHead(200, { "content-type": "audio/mpeg" });
      return res.end(speechLikeWav());
    }
    if (url.pathname === "/v1/audio/transcriptions") { log.stt++; return json(200, { text: "What's the weather like?" }); }
    if (url.pathname.startsWith("/push/")) { log.push.push({ path: url.pathname, bytes: raw.length }); res.writeHead(201); return res.end(); }
    json(404, { error: "mock: not found " + url.pathname });
  });
  const tls = selfSigned();
  const pushServer = https.createServer({ key: tls.key, cert: tls.cert }, (req, res) => server.emit("request", req, res));
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => pushServer.listen(0, "127.0.0.1", () => resolve({
    server: { close() { server.close(); pushServer.close(); } }, log,
    url: `http://127.0.0.1:${server.address().port}`, pushUrl: `https://127.0.0.1:${pushServer.address().port}`, caPath: tls.certPath,
  }))));
}
