// Monzo developer API client (https://docs.monzo.com/), confidential OAuth client.
// Tokens never leave the backend. Read-only use: accounts, balance, pots, transactions.
import { config } from "../config.js";

export class MonzoError extends Error {
  constructor(message, { status, code } = {}) { super(message); this.status = status; this.code = code; }
}
export const monzoConfigured = () => !!(config.monzoClientId && config.monzoClientSecret);

export function authorizeUrl({ state, redirectUri }) {
  const u = new URL(config.monzoAuthUrl + "/");
  u.search = new URLSearchParams({ client_id: config.monzoClientId, redirect_uri: redirectUri, response_type: "code", state }).toString();
  return u.toString();
}

async function tokenRequest(form) {
  const r = await fetch(`${config.monzoApiUrl}/oauth2/token`, {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: config.monzoClientId, client_secret: config.monzoClientSecret, ...form }), signal: AbortSignal.timeout(15000),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new MonzoError(j.message || `Monzo token request failed (${r.status})`, { status: r.status, code: j.code });
  return { accessToken: j.access_token, refreshToken: j.refresh_token || null, expiresAt: new Date(Date.now() + (j.expires_in || 21600) * 1000).toISOString(), userId: j.user_id };
}
export const exchangeCode = (code, redirectUri) => tokenRequest({ grant_type: "authorization_code", redirect_uri: redirectUri, code });
export const refreshTokens = (refreshToken) => tokenRequest({ grant_type: "refresh_token", refresh_token: refreshToken });

async function api(token, path, params) {
  const u = new URL(config.monzoApiUrl + path);
  if (params) for (const [k, v] of Object.entries(params)) (Array.isArray(v) ? v : [v]).forEach((x) => x !== undefined && u.searchParams.append(k, x));
  const r = await fetch(u, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(20000) });
  const j = await r.json().catch(() => ({}));
  if (r.status === 401) throw new MonzoError("Monzo access has expired. Reconnect your account.", { status: 401, code: j.code });
  if (r.status === 403) throw new MonzoError("Waiting for you to approve JARVIS in the Monzo app (Settings > Privacy & security, or the notification Monzo sent).", { status: 403, code: j.code || "forbidden.insufficient_permissions" });
  if (r.status === 429) throw new MonzoError("Monzo is rate-limiting requests. JARVIS will retry later.", { status: 429 });
  if (!r.ok) throw new MonzoError(j.message || `Monzo API error (${r.status})`, { status: r.status, code: j.code });
  return j;
}

export const whoami = (t) => api(t, "/ping/whoami");
export const listAccounts = (t) => api(t, "/accounts").then((j) => j.accounts || []);
export const getBalance = (t, accountId) => api(t, "/balance", { account_id: accountId });
export const listPots = (t, accountId) => api(t, "/pots", { current_account_id: accountId }).then((j) => j.pots || []);

/** All transactions since `since` (ISO or transaction id), following Monzo's 100-per-page pagination. */
export async function listTransactions(t, accountId, since) {
  const all = [];
  let cursor = since;
  for (let page = 0; page < 30; page++) {
    const j = await api(t, "/transactions", { account_id: accountId, since: cursor, limit: 100, "expand[]": "merchant" });
    const txs = j.transactions || [];
    all.push(...txs);
    if (txs.length < 100) break;
    cursor = txs.at(-1).id;
  }
  return all;
}

export async function logout(token) {
  try { await fetch(`${config.monzoApiUrl}/oauth2/logout`, { method: "POST", headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(8000) }); } catch {}
}

/** Map Monzo account types to JARVIS types. */
export function accountType(a) {
  if (/flex|credit/i.test(a.type || "")) return "credit";
  if (/saving|isa/i.test(a.type || "")) return "savings";
  return "current";
}
export function accountName(a) {
  const t = a.type || "";
  if (t === "uk_retail") return "Monzo Current Account";
  if (t === "uk_retail_joint") return "Monzo Joint Account";
  if (/flex/.test(t)) return "Monzo Flex";
  return a.description?.startsWith("user_") ? `Monzo ${t.replace(/_/g, " ")}` : a.description || "Monzo account";
}
