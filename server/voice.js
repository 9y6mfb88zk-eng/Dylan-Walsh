import { Readable } from "node:stream";
import { recordApiCall } from "./services/diagnostics.js";
import { config, ttsProvider } from "./config.js";
import { localAsrAvailable, transcribeLocal } from "./local-asr.js";
import { localTtsAvailable, synthesizeLocal } from "./local-tts.js";
import { getSettings } from "./db.js";
import { speakable } from "../public/js/speech-text.js";   // shared with the browser voice

/**
 * Which voice speaks (Settings → Voice): "auto" uses a premium voice you've added a key for (ElevenLabs, then OpenAI),
 * otherwise the free local Piper voice, otherwise the browser's own voice (null). A provider is only ever used when
 * it's actually available; nothing switches to a paid service on its own.
 */
export function speechProvider() {
  const want = getSettings().voice?.provider || "auto";
  const piper = localTtsAvailable();
  if (want === "browser") return null;
  if (want === "piper") return piper ? "piper" : null;
  if (want === "elevenlabs") return config.elevenKey ? "elevenlabs" : null;
  if (want === "openai") return config.openaiKey ? "openai" : null;
  const env = ttsProvider();          // TTS_PROVIDER / keys, as before
  if (config.ttsProvider === "browser") return null;          // TTS_PROVIDER=browser: the device's own voice
  return env || (piper ? "piper" : null);
}
/** The speech providers that can actually be used here (for Settings: nothing is offered that wouldn't work). */
export function speechProviders() {
  return [["auto", true], ["elevenlabs", !!config.elevenKey], ["openai", !!config.openaiKey], ["piper", localTtsAvailable()], ["browser", true]].filter(([, ok]) => ok).map(([k]) => k);
}

/**
 * Streams synthesized speech (audio/mpeg) to an Express response.
 * The response begins as soon as the provider sends the first bytes, so the
 * browser can start playback while the rest is still being generated.
 */
export async function streamTTS(rawText, res, signal, { speedFactor = 1, provider: forced = null } = {}) {
  const v = getSettings().voice || {};
  const provider = forced || speechProvider();
  if (!provider) { res.status(501).json({ error: "No neural TTS configured" }); return; }
  const text = speakable(rawText, { pronunciations: v.pronunciations });
  if (!text) { res.status(204).end(); return; }
  // Speaking speed: the setting times any "speak more slowly" request in this conversation, kept within what voices allow.
  const speed = Math.max(0.7, Math.min(1.25, (Number(v.speed) || 1) * (Number(speedFactor) || 1)));
  if (provider === "piper") {
    const t0 = performance.now();
    try {
      const wav = await synthesizeLocal(text, { speed });
      recordApiCall({ provider: "tts-local", model: "piper", purpose: "speak", latencyMs: performance.now() - t0, ok: true });
      if (signal?.aborted) return;
      res.setHeader("content-type", "audio/wav"); res.setHeader("cache-control", "no-store"); res.setHeader("x-tts-provider", "piper");
      res.end(wav);
    } catch (e) {
      recordApiCall({ provider: "tts-local", model: "piper", purpose: "speak", latencyMs: performance.now() - t0, ok: false, error: e.message });
      res.status(502).json({ error: `Local voice failed: ${e.message}` });
    }
    return;
  }

  let upstream;
  if (provider === "elevenlabs") {
    const url = `${config.elevenBaseUrl}/v1/text-to-speech/${encodeURIComponent(config.elevenVoiceId)}/stream?output_format=mp3_44100_128&optimize_streaming_latency=3`;
    upstream = await fetch(url, {
      method: "POST", signal,
      headers: { "xi-api-key": config.elevenKey, "content-type": "application/json", accept: "audio/mpeg" },
      body: JSON.stringify({
        text, model_id: config.elevenModel,
        voice_settings: { stability: 0.5, similarity_boost: 0.8, style: 0.2, use_speaker_boost: true, speed: Math.max(0.7, Math.min(1.2, speed)) },
      }),
    });
  } else {
    upstream = await fetch(`${config.openaiBaseUrl}/v1/audio/speech`, {
      method: "POST", signal,
      headers: { authorization: `Bearer ${config.openaiKey}`, "content-type": "application/json" },
      body: JSON.stringify({
        model: config.openaiTtsModel, voice: config.openaiTtsVoice, input: text, response_format: "mp3",
        ...(config.openaiTtsModel.includes("gpt-4o") ? {
          // gpt-4o-mini-tts takes delivery instructions rather than a speed number.
          instructions: `Speak as a composed, dry-witted English butler with a refined Received Pronunciation accent. Conversational, natural pauses at commas and full stops, quietly confident.${speed < 0.95 ? " Speak a little more slowly than usual." : speed > 1.05 ? " Speak a little faster than usual." : ""}`,
        } : { speed }),
      }),
    });
  }

  if (!upstream.ok || !upstream.body) {
    const detail = await upstream.text().catch(() => "");
    console.warn(`[tts] ${provider} failed ${upstream.status}: ${detail.slice(0, 200)}`);
    res.status(502).json({ error: `TTS provider error ${upstream.status}` });
    return;
  }
  res.setHeader("content-type", "audio/mpeg");
  res.setHeader("cache-control", "no-store");
  res.setHeader("x-tts-provider", provider);
  Readable.fromWeb(upstream.body).on("error", () => res.end()).pipe(res);
}

/** Server-side transcription via OpenAI Whisper (for iPhone / browsers without Web Speech). */
/**
 * Speech to text. Prefers free local Whisper on this machine (WAV input); falls back to OpenAI Whisper.
 * Errors carry a plain-English reason the user can act on.
 */
/** Transcribe with details: { text, confidence, stats, latencyMs, engine }. */
export async function transcribeDetailed(buffer, mimeType = "audio/webm", { localOnly = false } = {}) {
  const isWav = /wav/.test(mimeType) || buffer.toString("ascii", 0, 4) === "RIFF";
  const t0 = performance.now();
  if (isWav && localAsrAvailable()) {
    try {
      const r = await transcribeLocal(buffer, { details: true });
      if (!localOnly) recordApiCall({ provider: "stt-local", model: r.model, purpose: "transcribe", latencyMs: performance.now() - t0, ok: true });
      return { ...r, latencyMs: Math.round(performance.now() - t0), engine: r.model };
    } catch (e) {
      if (!localOnly) recordApiCall({ provider: "stt-local", purpose: "transcribe", latencyMs: performance.now() - t0, ok: false, error: e.message });
      if (localOnly) return { text: "" };
      if (!config.openaiKey) throw Object.assign(new Error(`Local speech recognition failed: ${e.message}`), { status: 500, expose: true });
    }
  }
  if (localOnly) return { text: "" };
  const text = await transcribe(buffer, mimeType, { skipLocal: true });
  recordApiCall({ provider: "stt-openai", model: config.openaiSttModel, purpose: "transcribe", latencyMs: performance.now() - t0, ok: true });
  return { text, latencyMs: Math.round(performance.now() - t0), engine: "openai", confidence: { level: text ? "high" : "none", reasons: [] } };
}

export async function transcribe(buffer, mimeType = "audio/webm", { localOnly = false, skipLocal = false } = {}) {
  const isWav = /wav/.test(mimeType) || buffer.toString("ascii", 0, 4) === "RIFF";
  // Live (partial) transcription runs only on the laptop's own model: free, private, and never billed.
  if (localOnly) return isWav && localAsrAvailable() ? transcribeLocal(buffer).catch(() => "") : "";
  if (isWav && localAsrAvailable() && !skipLocal) {
    try { return await transcribeLocal(buffer); }
    catch (e) { if (!config.openaiKey) throw Object.assign(new Error(`Local speech recognition failed: ${e.message}`), { status: 500, expose: true }); }
  }
  if (!config.openaiKey) {
    throw Object.assign(new Error(localAsrAvailable()
      ? "This device sent audio JARVIS can't read locally. Update the app, or add an OpenAI key."
      : "Voice input needs either JARVIS's built-in speech recognition (Windows app) or an OpenAI API key. Add one via the tray icon → API keys."), { status: 503, expose: true, code: "no_stt" });
  }
  const ext = mimeType.includes("mp4") || mimeType.includes("m4a") || mimeType.includes("aac") ? "m4a"
    : mimeType.includes("ogg") ? "ogg" : isWav ? "wav" : "webm";
  const form = new FormData();
  form.append("file", new Blob([buffer], { type: isWav ? "audio/wav" : mimeType }), `speech.${ext}`);
  form.append("model", config.openaiSttModel);
  form.append("language", "en");
  let r;
  try {
    r = await fetch(`${config.openaiBaseUrl}/v1/audio/transcriptions`, { method: "POST", headers: { authorization: `Bearer ${config.openaiKey}` }, body: form, signal: AbortSignal.timeout(30000) });
  } catch (e) {
    throw Object.assign(new Error("Couldn't reach OpenAI to transcribe your voice. Check the internet connection."), { status: 502, expose: true });
  }
  if (!r.ok) {
    const j = await r.json().catch(() => ({}));
    const code = j.error?.code || j.error?.type || "";
    const msg = r.status === 401 ? "Your OpenAI API key was rejected. Check it in the tray icon → API keys."
      : r.status === 429 && /quota|billing|insufficient/i.test(code + (j.error?.message || "")) ? "Your OpenAI account has no credit left. Add credit at platform.openai.com → Settings → Billing."
      : r.status === 429 ? "OpenAI is rate-limiting voice requests. Try again in a moment."
      : `OpenAI couldn't transcribe the audio (${r.status}${j.error?.message ? `: ${j.error.message}` : ""}).`;
    throw Object.assign(new Error(msg), { status: 502, expose: true });
  }
  const j = await r.json();
  return (j.text || "").trim();
}
