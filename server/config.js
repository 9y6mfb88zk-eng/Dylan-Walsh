// Central configuration, read once from the environment. Secrets stay server-side.
const env = process.env;
const bool = (v, d) => (v === undefined || v === "" ? d : !["0", "false", "no", "off"].includes(String(v).toLowerCase()));

export const config = {
  env: env.NODE_ENV || "development",
  port: Number(env.PORT || 3000),
  // 127.0.0.1 when JARVIS runs on your laptop (only the laptop itself and Tailscale's local proxy can reach it).
  host: env.HOST || "0.0.0.0",
  // Base for OAuth redirect URLs. On the laptop this is http://localhost:<port>; in the cloud it's PUBLIC_URL.
  oauthBaseUrl: (env.OAUTH_BASE_URL || "").replace(/\/$/, ""),
  // "laptop" when started by the Windows app.
  hosting: env.JARVIS_HOSTING || "server",
  // Public HTTPS address of this backend (used for OAuth redirects and pairing QR codes).
  publicUrl: (env.PUBLIC_URL || env.RENDER_EXTERNAL_URL || "").replace(/\/$/, ""),
  dataDir: env.JARVIS_DATA_DIR || "./data",
  setupToken: env.JARVIS_SETUP_TOKEN || env.JARVIS_PASSCODE || "",
  encryptionKey: env.JARVIS_ENCRYPTION_KEY || "",
  userName: env.JARVIS_USER_NAME || "sir",

  // AI
  anthropicKey: env.ANTHROPIC_API_KEY || "",
  model: env.JARVIS_MODEL || "claude-opus-5-5",
  researchModel: env.JARVIS_RESEARCH_MODEL || env.JARVIS_MODEL || "claude-opus-5-5",
  webSearch: bool(env.JARVIS_WEB_SEARCH, true),

  // Voice
  ttsProvider: (env.TTS_PROVIDER || "").toLowerCase(),
  elevenKey: env.ELEVENLABS_API_KEY || "",
  elevenVoiceId: env.ELEVENLABS_VOICE_ID || "JBFqnCBsd6RMkjVDRZzb",
  elevenModel: env.ELEVENLABS_MODEL || "eleven_flash_v2_5",
  openaiKey: env.OPENAI_API_KEY || "",
  openaiTtsVoice: env.OPENAI_TTS_VOICE || "fable",
  openaiTtsModel: env.OPENAI_TTS_MODEL || "gpt-4o-mini-tts",
  openaiSttModel: env.OPENAI_STT_MODEL || "whisper-1",
  openaiEmbedModel: env.OPENAI_EMBED_MODEL || "text-embedding-3-small",

  // Location defaults (overridable in Settings)
  defaultLat: Number(env.DEFAULT_LAT || 34.9786),
  defaultLon: Number(env.DEFAULT_LON || 33.7253),
  defaultPlace: env.DEFAULT_PLACE || "Dhekelia, Cyprus",
  timezone: env.JARVIS_TZ || "Europe/Nicosia",

  // Integrations
  monzoClientId: env.MONZO_CLIENT_ID || "",
  monzoClientSecret: env.MONZO_CLIENT_SECRET || "",
  googleClientId: env.GOOGLE_CLIENT_ID || "",
  googleClientSecret: env.GOOGLE_CLIENT_SECRET || "",
  // Development-only, clearly labelled TEST DATA finance provider. Refused in production.
  demoFinance: bool(env.JARVIS_DEMO_FINANCE, false),

  // Scheduler
  ideasEveryMinutes: Number(env.IDEAS_EVERY_MINUTES || 30),
  ideasEnabled: bool(env.IDEAS_ENABLED, true),
  briefingTime: env.BRIEFING_TIME || "07:30",
  reminderPollSeconds: Number(env.REMINDER_POLL_SECONDS || 20),
  financeSyncMinutes: Number(env.FINANCE_SYNC_MINUTES || 15),
  calendarSyncMinutes: Number(env.CALENDAR_SYNC_MINUTES || 10),

  // Sessions
  sessionIdleDays: Number(env.SESSION_IDLE_DAYS || 30),
  sessionMaxDays: Number(env.SESSION_MAX_DAYS || 180),
  sessionRotateHours: Number(env.SESSION_ROTATE_HOURS || 24),

  // Push (VAPID). Generated and persisted on first run if not given.
  vapidPublic: env.VAPID_PUBLIC_KEY || "",
  vapidPrivate: env.VAPID_PRIVATE_KEY || "",
  vapidSubject: env.VAPID_SUBJECT || "mailto:jarvis@example.com",

  // Overridable upstreams (used by tests)
  openMeteoUrl: env.OPEN_METEO_URL || "https://api.open-meteo.com/v1/forecast",
  geocodeUrl: env.GEOCODE_URL || "https://geocoding-api.open-meteo.com/v1/search",
  elevenBaseUrl: env.ELEVENLABS_BASE_URL || "https://api.elevenlabs.io",
  openaiBaseUrl: env.OPENAI_BASE_URL || "https://api.openai.com",
  monzoAuthUrl: env.MONZO_AUTH_URL || "https://auth.monzo.com",
  monzoApiUrl: env.MONZO_API_URL || "https://api.monzo.com",
  googleAuthUrl: env.GOOGLE_AUTH_URL || "https://accounts.google.com/o/oauth2/v2/auth",
  googleTokenUrl: env.GOOGLE_TOKEN_URL || "https://oauth2.googleapis.com/token",
  googleApiUrl: env.GOOGLE_API_URL || "https://www.googleapis.com",
};
export const isProd = config.env === "production";

export function ttsProvider() {
  if (config.ttsProvider === "browser") return null;
  if (config.ttsProvider === "elevenlabs" && config.elevenKey) return "elevenlabs";
  if (config.ttsProvider === "openai" && config.openaiKey) return "openai";
  if (config.elevenKey) return "elevenlabs";
  if (config.openaiKey) return "openai";
  return null;
}

/** Public URL for links other devices open (pairing QR); falls back to the request's own origin. */
export function publicBase(req) {
  if (config.publicUrl) return config.publicUrl;
  return `${req.protocol}://${req.get("host")}`;
}
/** Base for OAuth redirects (must exactly match what you registered with Monzo/Google). */
export function oauthBase(req) {
  return config.oauthBaseUrl || publicBase(req);
}

/** Per-model request options: features differ between model families. */
export function modelOptions(model) {
  const haiku = /haiku/.test(model);
  return {
    // Server-side refusal fallback exists for Opus/Sonnet/Fable, not Haiku.
    fallback: haiku ? {} : { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" },
    // Haiku uses the basic web search tool; newer large models get dynamic filtering.
    webSearch: (max) => ({ type: haiku ? "web_search_20250305" : "web_search_20260209", name: "web_search", max_uses: max }),
  };
}
