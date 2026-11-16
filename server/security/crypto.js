import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { config } from "../config.js";

let KEY = null;
/** 32-byte key for encrypting OAuth tokens at rest. From JARVIS_ENCRYPTION_KEY, else generated once into the data dir. */
export function encryptionKey() {
  if (KEY) return KEY;
  if (config.encryptionKey) {
    const raw = /^[0-9a-f]{64}$/i.test(config.encryptionKey) ? Buffer.from(config.encryptionKey, "hex") : Buffer.from(config.encryptionKey, "base64");
    if (raw.length !== 32) throw new Error("JARVIS_ENCRYPTION_KEY must be 32 bytes (64 hex chars or base64)");
    return (KEY = raw);
  }
  const file = path.join(config.dataDir, "secret.key");
  if (!fs.existsSync(file)) {
    fs.writeFileSync(file, crypto.randomBytes(32).toString("base64"), { mode: 0o600 });
    console.warn("[security] Generated data/secret.key. Set JARVIS_ENCRYPTION_KEY in production so the key is not stored beside the database.");
  }
  return (KEY = Buffer.from(fs.readFileSync(file, "utf8").trim(), "base64"));
}

export function encrypt(plain) {
  if (plain == null) return null;
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const ct = Buffer.concat([c.update(String(plain), "utf8"), c.final()]);
  return ["v1", iv.toString("base64"), c.getAuthTag().toString("base64"), ct.toString("base64")].join(":");
}
export function decrypt(blob) {
  if (!blob) return null;
  const [v, iv, tag, ct] = blob.split(":");
  if (v !== "v1") throw new Error("Unknown ciphertext version");
  const d = crypto.createDecipheriv("aes-256-gcm", encryptionKey(), Buffer.from(iv, "base64"));
  d.setAuthTag(Buffer.from(tag, "base64"));
  return Buffer.concat([d.update(Buffer.from(ct, "base64")), d.final()]).toString("utf8");
}

export const sha256 = (s) => crypto.createHash("sha256").update(String(s)).digest("hex");
export const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString("base64url");
export const randomId = () => crypto.randomUUID();

const SCRYPT = { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
export function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(pw).normalize("NFKC"), salt, 32, SCRYPT);
  return `scrypt$${SCRYPT.N}$${salt.toString("base64")}$${hash.toString("base64")}`;
}
export function verifyPassword(pw, stored) {
  const [alg, n, salt, hash] = String(stored).split("$");
  if (alg !== "scrypt") return false;
  const h = crypto.scryptSync(String(pw).normalize("NFKC"), Buffer.from(salt, "base64"), 32, { ...SCRYPT, N: Number(n) });
  const expected = Buffer.from(hash, "base64");
  return expected.length === h.length && crypto.timingSafeEqual(h, expected);
}
export function safeEqual(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}
