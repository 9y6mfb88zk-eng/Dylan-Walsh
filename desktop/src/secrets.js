// API keys and server secrets for the laptop-hosted JARVIS, encrypted with Windows DPAPI via Electron safeStorage.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

export const KEY_FIELDS = ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "ELEVENLABS_API_KEY", "MONZO_CLIENT_ID", "MONZO_CLIENT_SECRET", "GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"];
export const MODELS = {
  "claude-haiku-5-5": "Claude Haiku 5.5 — cheapest (pennies a month)",
  "claude-sonnet-5-5": "Claude Sonnet 5.5 — balanced",
  "claude-opus-5-5": "Claude Opus 5.5 — smartest",
};

export function createSecrets(file, safeStorage) {
  const enc = () => safeStorage?.isEncryptionAvailable?.();
  let data = {};
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    data = raw.encrypted ? JSON.parse(safeStorage.decryptString(Buffer.from(raw.data, "base64"))) : raw.data || {};
  } catch {}
  function save() {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const json = JSON.stringify(data);
    const out = enc() ? { encrypted: true, data: safeStorage.encryptString(json).toString("base64") } : { encrypted: false, data };
    fs.writeFileSync(file, JSON.stringify(out), { mode: 0o600 });
  }
  // Generated once: the code to claim the account, and the key that encrypts bank/calendar tokens.
  if (!data.JARVIS_SETUP_TOKEN) data.JARVIS_SETUP_TOKEN = crypto.randomBytes(12).toString("base64url");
  if (!data.JARVIS_ENCRYPTION_KEY) data.JARVIS_ENCRYPTION_KEY = crypto.randomBytes(32).toString("base64");
  if (!data.JARVIS_MODEL) data.JARVIS_MODEL = "claude-haiku-5-5";
  save();

  return {
    encrypted: () => !!enc(),
    get: (k) => data[k],
    /** Public view for the keys screen: which keys are set, never their values. */
    view: () => ({ set: Object.fromEntries(KEY_FIELDS.map((k) => [k, !!data[k]])), model: data.JARVIS_MODEL, models: MODELS, encrypted: !!enc() }),
    update(patch) {
      for (const [k, v] of Object.entries(patch || {})) {
        if (KEY_FIELDS.includes(k)) { const t = String(v ?? "").trim(); if (t === "__clear__") delete data[k]; else if (t) data[k] = t.slice(0, 500); }
        if (k === "JARVIS_MODEL" && Object.hasOwn(MODELS, v)) data.JARVIS_MODEL = v;
      }
      save();
    },
    /** Environment for the server process. */
    env() {
      return {
        ...Object.fromEntries(KEY_FIELDS.filter((k) => data[k]).map((k) => [k, data[k]])),
        JARVIS_SETUP_TOKEN: data.JARVIS_SETUP_TOKEN, JARVIS_ENCRYPTION_KEY: data.JARVIS_ENCRYPTION_KEY,
        JARVIS_MODEL: data.JARVIS_MODEL, JARVIS_RESEARCH_MODEL: data.JARVIS_MODEL,
      };
    },
  };
}
