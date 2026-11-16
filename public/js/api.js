// API client: same-origin cookie session, CSRF header, offline outbox with idempotent client ids.
const OUTBOX_KEY = "jarvis.outbox";
const listeners = new Set();

export class ApiError extends Error { constructor(msg, status, data) { super(msg); this.status = status; this.data = data; } }

export async function api(path, { method = "GET", body, raw, headers = {}, signal } = {}) {
  let res;
  try {
    res = await fetch(path, {
      method, signal, credentials: "same-origin",
      headers: { ...(method !== "GET" ? { "x-jarvis": "1" } : {}), ...(raw ? {} : body !== undefined ? { "content-type": "application/json" } : {}), ...headers },
      body: raw ?? (body !== undefined ? JSON.stringify(body) : undefined),
    });
  } catch (e) {
    throw new ApiError("You're offline. I'll sync when the connection returns.", 0);
  }
  if (res.status === 401 && !path.startsWith("/api/session")) listeners.forEach((fn) => fn("unauthorized"));
  const ct = res.headers.get("content-type") || "";
  const data = ct.includes("json") ? await res.json().catch(() => null) : res;
  if (!res.ok) throw new ApiError(data?.error || `Request failed (${res.status})`, res.status, data);
  return data;
}
export const onAuthEvent = (fn) => listeners.add(fn);
export const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));

// ---------------- Offline outbox: writes made without a connection are replayed later, exactly once.
function readOutbox() { try { return JSON.parse(localStorage.getItem(OUTBOX_KEY) || "[]"); } catch { return []; } }
function writeOutbox(items) { try { localStorage.setItem(OUTBOX_KEY, JSON.stringify(items)); } catch {} }
export const outboxSize = () => readOutbox().length;

/** POST with a client id; if offline, queue it. Server de-duplicates by clientId. */
export async function send(path, body) {
  const item = { path, body: { ...body, clientId: body.clientId || uid() }, at: Date.now() };
  try { return await api(path, { method: "POST", body: item.body }); }
  catch (e) {
    if (e.status === 0) { writeOutbox([...readOutbox(), item]); return { queued: true, clientId: item.body.clientId }; }
    throw e;
  }
}
let flushing = false;
export async function flushOutbox() {
  if (flushing) return 0;
  flushing = true;
  let sent = 0;
  try {
    for (const item of readOutbox()) {
      try { await api(item.path, { method: "POST", body: item.body }); sent++; }
      catch (e) { if (e.status === 0) break; /* drop permanently-failing items */ }
      writeOutbox(readOutbox().filter((x) => x.body.clientId !== item.body.clientId));
    }
  } finally { flushing = false; }
  return sent;
}
