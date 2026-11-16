// Google Calendar (OAuth 2.0, offline access). Tokens stay on the backend, encrypted.
import { config } from "../config.js";

export const SCOPE = "https://www.googleapis.com/auth/calendar.events";
export const googleConfigured = () => !!(config.googleClientId && config.googleClientSecret);

export class GoogleError extends Error { constructor(m, status) { super(m); this.status = status; } }

export function authorizeUrl({ state, redirectUri }) {
  const u = new URL(config.googleAuthUrl);
  u.search = new URLSearchParams({
    client_id: config.googleClientId, redirect_uri: redirectUri, response_type: "code", scope: SCOPE,
    access_type: "offline", prompt: "consent", include_granted_scopes: "true", state,
  }).toString();
  return u.toString();
}

async function token(form) {
  const r = await fetch(config.googleTokenUrl, {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: config.googleClientId, client_secret: config.googleClientSecret, ...form }), signal: AbortSignal.timeout(15000),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new GoogleError(j.error_description || j.error || `Google token error ${r.status}`, r.status);
  return { accessToken: j.access_token, refreshToken: j.refresh_token || null, expiresAt: new Date(Date.now() + (j.expires_in || 3600) * 1000).toISOString(), scope: j.scope };
}
export const exchangeCode = (code, redirectUri) => token({ grant_type: "authorization_code", code, redirect_uri: redirectUri });
export const refresh = (refreshToken) => token({ grant_type: "refresh_token", refresh_token: refreshToken });

async function api(accessToken, path, { method = "GET", params, body } = {}) {
  const u = new URL(`${config.googleApiUrl}/calendar/v3${path}`);
  if (params) for (const [k, v] of Object.entries(params)) if (v !== undefined) u.searchParams.set(k, v);
  const r = await fetch(u, {
    method, headers: { authorization: `Bearer ${accessToken}`, ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(15000),
  });
  if (r.status === 204) return null;
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new GoogleError(j.error?.message || `Google Calendar error ${r.status}`, r.status);
  return j;
}

export async function listEvents(accessToken, timeMin, timeMax) {
  const out = [];
  let pageToken;
  for (let i = 0; i < 10; i++) {
    const j = await api(accessToken, "/calendars/primary/events", { params: { timeMin, timeMax, singleEvents: "true", orderBy: "startTime", maxResults: "250", pageToken } });
    out.push(...(j.items || []));
    if (!j.nextPageToken) break;
    pageToken = j.nextPageToken;
  }
  return out.filter((e) => e.status !== "cancelled");
}
export const insertEvent = (t, body) => api(t, "/calendars/primary/events", { method: "POST", body });
export const patchEvent = (t, id, body) => api(t, `/calendars/primary/events/${encodeURIComponent(id)}`, { method: "PATCH", body });
export const deleteEvent = (t, id) => api(t, `/calendars/primary/events/${encodeURIComponent(id)}`, { method: "DELETE" });
export async function revoke(tokenValue) {
  try { await fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(tokenValue)}`, { method: "POST", signal: AbortSignal.timeout(8000) }); } catch {}
}

/** Convert between Google's event shape and ours. */
export function fromGoogle(e) {
  const allDay = !!e.start?.date;
  return {
    external_id: e.id, title: e.summary || "(no title)", all_day: allDay ? 1 : 0,
    start: allDay ? e.start.date : new Date(e.start.dateTime).toISOString(),
    end: allDay ? e.end.date : new Date(e.end.dateTime).toISOString(),
    location: e.location || "", notes: (e.description || "").slice(0, 2000),
  };
}
export function toGoogle(ev, tz) {
  return ev.all_day
    ? { summary: ev.title, location: ev.location || undefined, description: ev.notes || undefined, start: { date: ev.start.slice(0, 10) }, end: { date: ev.end.slice(0, 10) } }
    : { summary: ev.title, location: ev.location || undefined, description: ev.notes || undefined, start: { dateTime: ev.start, timeZone: tz }, end: { dateTime: ev.end, timeZone: tz } };
}
