import express from "express";
import { oauthBase } from "../config.js";
import * as calendar from "../services/calendar.js";
import { auditFromReq } from "../security/audit.js";
import { oauthResultPage } from "../services/oauth-page.js";
import { notify } from "../services/notify.js";

export const router = express.Router();
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const redirectUri = (req) => `${oauthBase(req)}/oauth/google/callback`;

router.get("/api/calendar", (req, res) => {
  const from = req.query.from ? new Date(req.query.from).toISOString() : new Date(Date.now() - 86400_000).toISOString();
  const to = req.query.to ? new Date(req.query.to).toISOString() : new Date(Date.now() + 31 * 86400_000).toISOString();
  res.json({ events: calendar.list(from, to), google: calendar.googleStatus() });
});
router.get("/api/calendar/conflicts", (req, res) => res.json(calendar.conflicts(new Date(req.query.start).toISOString(), new Date(req.query.end).toISOString(), req.query.ignore ? Number(req.query.ignore) : null)));
// Direct edits from the calendar screen are explicit user actions (the user is the confirmation).
router.post("/api/calendar", wrap(async (req, res) => { const e = await calendar.create(req.body || {}); auditFromReq(req, "calendar.created", { id: e.id }); res.status(201).json(e); }));
router.patch("/api/calendar/:id", wrap(async (req, res) => { const e = await calendar.update(Number(req.params.id), req.body || {}); auditFromReq(req, "calendar.updated", { id: e.id }); res.json(e); }));
router.delete("/api/calendar/:id", wrap(async (req, res) => { const ok = await calendar.remove(Number(req.params.id)); auditFromReq(req, "calendar.deleted", { id: Number(req.params.id) }); res.json({ ok }); }));
router.post("/api/calendar/google/connect", (req, res) => res.json({ url: calendar.startGoogle({ redirectUri: redirectUri(req), deviceId: req.auth.deviceId }) }));
router.post("/api/calendar/google/sync", wrap(async (req, res) => res.json(await calendar.syncGoogle())));
router.post("/api/calendar/google/disconnect", wrap(async (req, res) => { auditFromReq(req, "calendar.disconnected"); res.json({ ok: await calendar.disconnectGoogle() }); }));

export const callback = express.Router();
callback.get("/oauth/google/callback", wrap(async (req, res) => {
  const inApp = !!req.auth;
  if (req.query.error) return inApp ? res.redirect(`/?tab=calendar&error=${encodeURIComponent(String(req.query.error))}`) : oauthResultPage(res, { ok: false, title: "Google Calendar wasn't connected", lines: [String(req.query.error)] });
  try {
    await calendar.finishGoogle({ state: req.query.state, code: req.query.code, redirectUri: redirectUri(req) });
    notify({ kind: "system", title: "Google Calendar connected", body: "Your events are syncing to JARVIS.", url: "/?tab=calendar" }).catch(() => {});
    inApp ? res.redirect("/?tab=calendar&connected=google") : oauthResultPage(res, { ok: true, title: "Google Calendar is connected", lines: ["Your events are syncing to JARVIS. JARVIS asks before changing or deleting anything in your Google Calendar."] });
  } catch (e) { inApp ? res.redirect(`/?tab=calendar&error=${encodeURIComponent(e.message)}`) : oauthResultPage(res, { ok: false, title: "Google Calendar wasn't connected", lines: [e.message] }); }
}));
