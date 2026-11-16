// Central configuration, read once from the environment.
const env = process.env;

export const config = {
  port: Number(env.PORT || 3000),
  dataDir: env.JARVIS_DATA_DIR || "./data",
  passcode: env.JARVIS_PASSCODE || "",
  userName: env.JARVIS_USER_NAME || "sir",

  anthropicKey: env.ANTHROPIC_API_KEY || "",
  model: env.JARVIS_MODEL || "claude-opus-5-5",

  // Voice
  ttsProvider: (env.TTS_PROVIDER || "").toLowerCase(), // "elevenlabs" | "openai" | "" (auto)
  elevenKey: env.ELEVENLABS_API_KEY || "",
  // "George" — a warm, mature British male voice from the ElevenLabs default library.
  elevenVoiceId: env.ELEVENLABS_VOICE_ID || "JBFqnCBsd6RMkjVDRZzb",
  elevenModel: env.ELEVENLABS_MODEL || "eleven_flash_v2_5",
  openaiKey: env.OPENAI_API_KEY || "",
  openaiTtsVoice: env.OPENAI_TTS_VOICE || "fable",
  openaiTtsModel: env.OPENAI_TTS_MODEL || "gpt-4o-mini-tts",
  openaiSttModel: env.OPENAI_STT_MODEL || "whisper-1",

  // Location defaults: Dhekelia, Cyprus
  defaultLat: Number(env.DEFAULT_LAT || 34.9786),
  defaultLon: Number(env.DEFAULT_LON || 33.7253),
  defaultPlace: env.DEFAULT_PLACE || "Dhekelia, Cyprus",
  timezone: env.JARVIS_TZ || "Europe/Nicosia",

  // Scheduler
  ideasEveryMinutes: Number(env.IDEAS_EVERY_MINUTES || 30),
  ideasEnabled: (env.IDEAS_ENABLED || "true") !== "false",
  briefingTime: env.BRIEFING_TIME || "07:30", // local time in JARVIS_TZ
  reminderPollSeconds: Number(env.REMINDER_POLL_SECONDS || 20),

  // Push (VAPID). Generated and persisted on first run if not given.
  vapidPublic: env.VAPID_PUBLIC_KEY || "",
  vapidPrivate: env.VAPID_PRIVATE_KEY || "",
  vapidSubject: env.VAPID_SUBJECT || "mailto:jarvis@example.com",

  // Overridable upstreams (used by tests)
  openMeteoUrl: env.OPEN_METEO_URL || "https://api.open-meteo.com/v1/forecast",
  elevenBaseUrl: env.ELEVENLABS_BASE_URL || "https://api.elevenlabs.io",
  openaiBaseUrl: env.OPENAI_BASE_URL || "https://api.openai.com",
};

export function ttsProvider() {
  if (config.ttsProvider === "elevenlabs" && config.elevenKey) return "elevenlabs";
  if (config.ttsProvider === "openai" && config.openaiKey) return "openai";
  if (config.ttsProvider === "browser") return null;
  if (config.elevenKey) return "elevenlabs";
  if (config.openaiKey) return "openai";
  return null;
}
