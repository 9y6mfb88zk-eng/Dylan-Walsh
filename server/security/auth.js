// Authentication, sessions, devices and QR pairing.
// - One owner account (password, scrypt-hashed). First-run setup requires a one-time setup code.
// - Every browser/app is a "device" with its own revocable session.
// - Session tokens are random 256-bit values; only their SHA-256 is stored. Sliding idle expiry,
//   absolute expiry and periodic rotation (old token keeps a short grace window for in-flight requests).
import { db, kvGet, kvSet, tx } from "../db.js";
import { config } from "../config.js";
import { sha256, randomToken, randomId, hashPassword, verifyPassword, safeEqual } from "./crypto.js";
import { audit } from "./audit.js";
import { hit } from "./ratelimit.js";

export const COOKIE = "jarvis_session";
const DAY = 86400_000;
const ROTATION_GRACE_MS = 2 * 60_000;
const iso = (ms) => new Date(ms).toISOString();
/** Parse SQLite datetime("now") ("YYYY-MM-DD HH:MM:SS", UTC) or ISO strings. */
export const parseDb = (s) => (s ? Date.parse(String(s).replace(" ", "T") + (/[zZ]|[+-]\d\d:?\d\d$/.test(s) ? "" : "Z")) : NaN);

// ---------------- Setup
export const isSetupComplete = () => db.prepare("SELECT COUNT(*) AS n FROM users").get().n > 0;

/** The one-time code needed to claim a fresh install. From JARVIS_SETUP_TOKEN, else generated and printed to the log. */
export function setupCode() {
  if (config.setupToken) return config.setupToken;
  let c = kvGet("setupCode");
  if (!c) { c = shortCode() + shortCode().slice(0, 4); kvSet("setupCode", c); }
  return c;
}

export function deviceKindFromUA(ua = "") {
  if (/JARVIS-Desktop|Electron/i.test(ua)) return "desktop";
  if (/iPhone|iPad|iPod/i.test(ua)) return "iphone";
  if (/Android/i.test(ua)) return "android";
  return "browser";
}
function defaultDeviceName(kind, ua) {
  if (kind === "desktop") return /Windows/i.test(ua) ? "Windows laptop" : "Desktop app";
  if (kind === "iphone") return "iPhone";
  if (kind === "android") return "Android phone";
  const b = /Edg\//.test(ua) ? "Edge" : /Chrome\//.test(ua) ? "Chrome" : /Firefox\//.test(ua) ? "Firefox" : /Safari\//.test(ua) ? "Safari" : "Browser";
  return `${b} browser`;
}

function validatePassword(pw) {
  if (typeof pw !== "string" || pw.length < 10) throw Object.assign(new Error("Use a password of at least 10 characters."), { status: 400 });
  if (pw.length > 200) throw Object.assign(new Error("Password too long."), { status: 400 });
}

export function createOwner({ username = "owner", password, code, deviceName, ua = "", ip }) {
  if (isSetupComplete()) throw Object.assign(new Error("JARVIS is already set up. Sign in instead."), { status: 409 });
  if (!code || !safeEqual(String(code).trim().toUpperCase(), setupCode().toUpperCase())) {
    audit("setup.failed", { ip });
    throw Object.assign(new Error("That setup code is not right. Find it in the server log or your JARVIS_SETUP_TOKEN setting."), { status: 403 });
  }
  validatePassword(password);
  return tx(() => {
    const u = db.prepare("INSERT INTO users (username, password_hash) VALUES (?, ?)").run(String(username).trim() || "owner", hashPassword(password));
    kvSet("setupCode", null);
    const dev = createDevice(Number(u.lastInsertRowid), { name: deviceName, ua });
    const token = createSession(dev.id);
    audit("setup.completed", { deviceId: dev.id, ip });
    return { token, device: dev };
  });
}

// ---------------- Login
export function login({ username, password, deviceName, ua = "", ip }) {
  const lim = hit(`login:${ip}`, 8, 15 * 60_000);
  if (!lim.ok) throw Object.assign(new Error(`Too many attempts. Try again in ${Math.ceil(lim.retryAfter / 60)} minutes.`), { status: 429 });
  const user = db.prepare("SELECT * FROM users WHERE username = ?").get(String(username || "owner").trim())
    || db.prepare("SELECT * FROM users ORDER BY id LIMIT 1").get();   // single-owner install: username optional
  const ok = user && verifyPassword(password || "", user.password_hash);
  if (!ok) { audit("login.failed", { ip }); throw Object.assign(new Error("Incorrect password."), { status: 401 }); }
  const dev = createDevice(user.id, { name: deviceName, ua });
  const token = createSession(dev.id);
  audit("login.success", { deviceId: dev.id, ip });
  return { token, device: dev };
}

export function changePassword(userId, current, next, keepDeviceId) {
  const user = db.prepare("SELECT * FROM users WHERE id = ?").get(userId);
  if (!verifyPassword(current || "", user.password_hash)) throw Object.assign(new Error("Current password is incorrect."), { status: 401 });
  validatePassword(next);
  tx(() => {
    db.prepare("UPDATE users SET password_hash = ?, password_changed_at = datetime('now') WHERE id = ?").run(hashPassword(next), userId);
    // Sign out every other device.
    db.prepare("UPDATE sessions SET revoked_at = datetime('now') WHERE revoked_at IS NULL AND device_id != ?").run(keepDeviceId);
  });
}

// ---------------- Devices & sessions
export function createDevice(userId, { name, ua = "" }) {
  const kind = deviceKindFromUA(ua);
  const id = randomId();
  const n = (String(name || "").trim() || defaultDeviceName(kind, ua)).slice(0, 60);
  db.prepare("INSERT INTO devices (id, user_id, name, kind, user_agent, last_seen) VALUES (?, ?, ?, ?, ?, datetime('now'))").run(id, userId, n, kind, ua.slice(0, 300));
  return { id, name: n, kind };
}

export function createSession(deviceId) {
  const token = randomToken(32);
  const now = Date.now();
  db.prepare("INSERT INTO sessions (token_hash, device_id, expires_at, absolute_expires_at) VALUES (?, ?, ?, ?)")
    .run(sha256(token), deviceId, iso(now + config.sessionIdleDays * DAY), iso(now + config.sessionMaxDays * DAY));
  return token;
}

/** Validate a token. Returns {userId, deviceId, deviceName, kind, rotatedToken?} or null. */
export function resolveSession(token, { ip } = {}) {
  if (!token || token.length < 20) return null;
  const s = db.prepare(`SELECT s.*, d.user_id, d.name, d.kind, d.revoked_at AS dev_revoked
    FROM sessions s JOIN devices d ON d.id = s.device_id WHERE s.token_hash = ?`).get(sha256(token));
  if (!s || s.revoked_at || s.dev_revoked) return null;
  const now = Date.now();
  if (parseDb(s.expires_at) < now || parseDb(s.absolute_expires_at) < now) return null;
  if (s.rotated_at && now - parseDb(s.rotated_at) > ROTATION_GRACE_MS) return null;

  const auth = { userId: s.user_id, deviceId: s.device_id, deviceName: s.name, kind: s.kind };
  // Slide the idle expiry (at most once a minute) and record device activity.
  if (now - parseDb(s.last_seen) > 60_000) {
    db.prepare("UPDATE sessions SET last_seen = datetime('now'), expires_at = ? WHERE token_hash = ?").run(iso(Math.min(now + config.sessionIdleDays * DAY, Date.parse(s.absolute_expires_at))), s.token_hash);
    db.prepare("UPDATE devices SET last_seen = datetime('now'), last_ip = ? WHERE id = ?").run(ip || null, s.device_id);
  }
  // Rotate long-lived tokens.
  const created = parseDb(s.created_at);
  if (!s.rotated_at && now - created > config.sessionRotateHours * 3600_000) {
    const fresh = randomToken(32);
    tx(() => {
      db.prepare("UPDATE sessions SET rotated_at = ? WHERE token_hash = ?").run(iso(now), s.token_hash);
      db.prepare("INSERT INTO sessions (token_hash, device_id, expires_at, absolute_expires_at) VALUES (?, ?, ?, ?)")
        .run(sha256(fresh), s.device_id, iso(Math.min(now + config.sessionIdleDays * DAY, Date.parse(s.absolute_expires_at))), s.absolute_expires_at);
    });
    auth.rotatedToken = fresh;
  }
  return auth;
}

export function revokeToken(token) {
  db.prepare("UPDATE sessions SET revoked_at = datetime('now') WHERE token_hash = ?").run(sha256(token));
}
export function listDevices() {
  return db.prepare(`SELECT id, name, kind, created_at, last_seen, last_ip, revoked_at FROM devices ORDER BY revoked_at IS NOT NULL, last_seen DESC`).all();
}
export function revokeDevice(id) {
  return tx(() => {
    const r = db.prepare("UPDATE devices SET revoked_at = datetime('now') WHERE id = ? AND revoked_at IS NULL").run(id);
    db.prepare("UPDATE sessions SET revoked_at = datetime('now') WHERE device_id = ? AND revoked_at IS NULL").run(id);
    db.prepare("DELETE FROM push_subs WHERE device_id = ?").run(id);
    return r.changes > 0;
  });
}
export function renameDevice(id, name) {
  db.prepare("UPDATE devices SET name = ? WHERE id = ?").run(String(name).slice(0, 60), id);
}

// ---------------- Pairing (QR / short code)
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
function shortCode() {
  const b = randomToken(16);
  let s = "";
  for (let i = 0; s.length < 8; i++) s += ALPHABET[b.charCodeAt(i % b.length) % ALPHABET.length];
  return s;
}
export function createPairing(byDeviceId) {
  const code = randomToken(24);
  const sc = shortCode();
  const expiresAt = iso(Date.now() + 5 * 60_000);
  db.prepare("DELETE FROM pairing_codes WHERE expires_at < ? OR used_at IS NOT NULL").run(iso(Date.now()));
  db.prepare("INSERT INTO pairing_codes (code_hash, short_code, created_by, expires_at) VALUES (?, ?, ?, ?)").run(sha256(code), sha256(sc), byDeviceId, expiresAt);
  audit("pairing.created", { deviceId: byDeviceId });
  return { code, shortCode: `${sc.slice(0, 4)}-${sc.slice(4)}`, expiresAt };
}
export function redeemPairing({ code, shortCode: sc, deviceName, ua = "", ip }) {
  const lim = hit(`pair:${ip}`, 10, 10 * 60_000);
  if (!lim.ok) throw Object.assign(new Error("Too many pairing attempts. Wait a few minutes."), { status: 429 });
  const row = code
    ? db.prepare("SELECT * FROM pairing_codes WHERE code_hash = ?").get(sha256(code))
    : db.prepare("SELECT * FROM pairing_codes WHERE short_code = ?").get(sha256(String(sc || "").replace(/[^A-Z0-9]/gi, "").toUpperCase()));
  if (!row || row.used_at || parseDb(row.expires_at) < Date.now()) {
    audit("pairing.failed", { ip });
    throw Object.assign(new Error("That pairing code has expired or was already used. Make a new one on your paired device."), { status: 403 });
  }
  const owner = db.prepare("SELECT d.user_id FROM devices d WHERE d.id = ? AND d.revoked_at IS NULL").get(row.created_by);
  if (!owner) throw Object.assign(new Error("The device that created this code was signed out."), { status: 403 });
  return tx(() => {
    const dev = createDevice(owner.user_id, { name: deviceName, ua });
    db.prepare("UPDATE pairing_codes SET used_at = datetime('now'), used_by = ? WHERE code_hash = ?").run(dev.id, row.code_hash);
    const token = createSession(dev.id);
    audit("pairing.redeemed", { deviceId: dev.id, ip, pairedBy: row.created_by });
    return { token, device: dev };
  });
}

// ---------------- Express helpers
export function readToken(req) {
  const h = req.headers.authorization || "";
  if (h.startsWith("Bearer ")) return { token: h.slice(7), via: "bearer" };
  const m = (req.headers.cookie || "").match(new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]+)`));
  return m ? { token: decodeURIComponent(m[1]), via: "cookie" } : { token: null, via: null };
}
export function setSessionCookie(req, res, token) {
  // Secure when the request arrived over HTTPS (directly or via a proxy such as Tailscale Serve or Render).
  let secure = req.secure;
  try { if (!secure && config.publicUrl.startsWith("https://") && new URL(config.publicUrl).host === req.get("host")) secure = true; } catch {}
  res.append("set-cookie", `${COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${config.sessionIdleDays * 86400}${secure ? "; Secure" : ""}`);
}
export function clearSessionCookie(res) {
  res.append("set-cookie", `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

/** Attach req.auth when a valid session is presented; rotate the cookie when due. */
export function authenticate(req, res, next) {
  const { token, via } = readToken(req);
  const auth = token ? resolveSession(token, { ip: req.ip }) : null;
  if (auth) {
    req.auth = { ...auth, via, token };
    if (auth.rotatedToken) {
      req.auth.token = auth.rotatedToken;
      if (via === "cookie") setSessionCookie(req, res, auth.rotatedToken);
      else res.setHeader("x-jarvis-rotated-token", auth.rotatedToken);
    }
  }
  next();
}
export function requireAuth(req, res, next) {
  if (!req.auth) return res.status(401).json({ error: "Please sign in.", setup: !isSetupComplete() });
  next();
}
/**
 * CSRF defence for cookie sessions: state-changing requests must carry the custom
 * `x-jarvis` header (browsers can't send custom headers cross-site without CORS, which we never grant)
 * and, when an Origin is sent, it must match this host.
 */
export function csrf(req, res, next) {
  if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return next();
  if (req.auth?.via === "bearer") return next();
  const origin = req.headers.origin;
  if (origin && new URL(origin).host !== req.headers.host) return res.status(403).json({ error: "Cross-site request refused." });
  if (req.headers["x-jarvis"] !== "1") return res.status(403).json({ error: "Missing request header." });
  next();
}
