import { Readable } from "node:stream";
import { config, ttsProvider } from "./config.js";

/**
 * Streams synthesized speech (audio/mpeg) to an Express response.
 * The response begins as soon as the provider sends the first bytes, so the
 * browser can start playback while the rest is still being generated.
 */
export async function streamTTS(text, res, signal) {
  const provider = ttsProvider();
  if (!provider) { res.status(501).json({ error: "No neural TTS configured" }); return; }

  let upstream;
  if (provider === "elevenlabs") {
    const url = `${config.elevenBaseUrl}/v1/text-to-speech/${encodeURIComponent(config.elevenVoiceId)}/stream?output_format=mp3_44100_128&optimize_streaming_latency=3`;
    upstream = await fetch(url, {
      method: "POST", signal,
      headers: { "xi-api-key": config.elevenKey, "content-type": "application/json", accept: "audio/mpeg" },
      body: JSON.stringify({
        text, model_id: config.elevenModel,
        voice_settings: { stability: 0.55, similarity_boost: 0.8, style: 0.25, use_speaker_boost: true },
      }),
    });
  } else {
    upstream = await fetch(`${config.openaiBaseUrl}/v1/audio/speech`, {
      method: "POST", signal,
      headers: { authorization: `Bearer ${config.openaiKey}`, "content-type": "application/json" },
      body: JSON.stringify({
        model: config.openaiTtsModel, voice: config.openaiTtsVoice, input: text, response_format: "mp3",
        ...(config.openaiTtsModel.includes("gpt-4o") ? {
          instructions: "Speak as a composed, dry-witted English butler with a refined Received Pronunciation accent. Warm, unhurried, quietly confident.",
        } : {}),
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
export async function transcribe(buffer, mimeType = "audio/webm") {
  if (!config.openaiKey) throw Object.assign(new Error("Transcription needs OPENAI_API_KEY"), { status: 501 });
  const ext = mimeType.includes("mp4") || mimeType.includes("m4a") || mimeType.includes("aac") ? "m4a"
    : mimeType.includes("ogg") ? "ogg" : mimeType.includes("wav") ? "wav" : "webm";
  const form = new FormData();
  form.append("file", new Blob([buffer], { type: mimeType }), `speech.${ext}`);
  form.append("model", config.openaiSttModel);
  form.append("language", "en");
  const r = await fetch(`${config.openaiBaseUrl}/v1/audio/transcriptions`, {
    method: "POST", headers: { authorization: `Bearer ${config.openaiKey}` }, body: form,
    signal: AbortSignal.timeout(30000),
  });
  if (!r.ok) throw Object.assign(new Error(`Transcription failed (${r.status})`), { status: 502 });
  const j = await r.json();
  return (j.text || "").trim();
}
