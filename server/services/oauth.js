// OAuth helpers shared by Monzo and Google: single-use, expiring, hashed `state` values and encrypted token storage.
import { db } from "../db.js";
import { randomToken, sha256, encrypt, decrypt } from "../security/crypto.js";

export function createState(provider, deviceId) {
  const state = randomToken(24);
  db.prepare("DELETE FROM oauth_states WHERE expires_at < ?").run(new Date().toISOString());
  db.prepare("INSERT INTO oauth_states (state_hash, provider, device_id, expires_at) VALUES (?, ?, ?, ?)")
    .run(sha256(state), provider, deviceId || null, new Date(Date.now() + 10 * 60_000).toISOString());
  return state;
}
/** Validates and burns a state value. Throws if missing, expired, reused or for another provider. */
export function consumeState(state, provider) {
  const row = state && db.prepare("SELECT * FROM oauth_states WHERE state_hash = ?").get(sha256(state));
  if (row) db.prepare("DELETE FROM oauth_states WHERE state_hash = ?").run(row.state_hash);
  if (!row || row.provider !== provider || Date.parse(row.expires_at) < Date.now()) {
    throw Object.assign(new Error("This sign-in link has expired or was not started by JARVIS. Please try connecting again."), { status: 400 });
  }
  return row;
}

export const connections = {
  get(provider) { return db.prepare("SELECT * FROM connections WHERE provider = ? AND status != 'disconnected' ORDER BY id DESC LIMIT 1").get(provider); },
  byId(id) { return db.prepare("SELECT * FROM connections WHERE id = ?").get(id); },
  all() { return db.prepare("SELECT * FROM connections WHERE status != 'disconnected' ORDER BY id").all(); },
  /** Public view: never includes tokens. */
  view(c) {
    if (!c) return null;
    return { id: c.id, provider: c.provider, status: c.status, created_at: c.created_at, last_sync_at: c.last_sync_at, last_error: c.last_error, expires_at: c.expires_at, scope: c.scope };
  },
  upsertTokens(provider, { accessToken, refreshToken, expiresAt, scope = null, userId = null, status }) {
    const existing = connections.get(provider);
    if (existing) {
      db.prepare(`UPDATE connections SET access_token_enc = ?, refresh_token_enc = COALESCE(?, refresh_token_enc), expires_at = ?, scope = COALESCE(?, scope),
        external_user_id = COALESCE(?, external_user_id), status = ?, last_error = NULL WHERE id = ?`)
        .run(encrypt(accessToken), refreshToken ? encrypt(refreshToken) : null, expiresAt, scope, userId, status, existing.id);
      return connections.byId(existing.id);
    }
    const r = db.prepare("INSERT INTO connections (provider, status, access_token_enc, refresh_token_enc, expires_at, scope, external_user_id) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(provider, status, encrypt(accessToken), refreshToken ? encrypt(refreshToken) : null, expiresAt, scope, userId);
    return connections.byId(r.lastInsertRowid);
  },
  tokens(c) { return { accessToken: decrypt(c.access_token_enc), refreshToken: decrypt(c.refresh_token_enc) }; },
  setStatus(id, status, error = null) { db.prepare("UPDATE connections SET status = ?, last_error = ? WHERE id = ?").run(status, error, id); },
  markSynced(id) { db.prepare("UPDATE connections SET last_sync_at = ?, last_error = NULL WHERE id = ?").run(new Date().toISOString(), id); },
  /** Remove tokens and mark disconnected. Linked financial data is deleted by the caller. */
  disconnect(id) { db.prepare("UPDATE connections SET status = 'disconnected', access_token_enc = NULL, refresh_token_enc = NULL WHERE id = ?").run(id); },
};
