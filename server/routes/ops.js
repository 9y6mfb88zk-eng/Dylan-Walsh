// Mission Control operations: Blackbox, Wayfinder, Sentinel, Orbit and the Global Situation Report.
import express from "express";
import { rateLimit } from "../security/ratelimit.js";
import { auditFromReq } from "../security/audit.js";
import { records, OPS } from "../services/ops/records.js";
import * as blackbox from "../services/ops/blackbox.js";
import * as wayfinder from "../services/ops/wayfinder.js";
import * as sentinel from "../services/ops/sentinel.js";
import * as orbit from "../services/ops/orbit.js";
import * as report from "../services/ops/report.js";
import { notify } from "../services/notify.js";
import { reminders } from "../services/work.js";

export const router = express.Router();
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const bad = (m) => Object.assign(new Error(m), { status: 400, expose: true });

// ---------------------------------------------------------------- Shared records (one model for every operation)
router.get("/api/ops/records", (req, res) => res.json(records.list({ op: req.query.op, kind: req.query.kind, q: req.query.q, tag: req.query.tag, limit: req.query.limit })));
router.get("/api/ops/records/:id", (req, res) => { const r = records.get(req.params.id); r ? res.json(r) : res.status(404).json({ error: "Not found" }); });
router.post("/api/ops/records", (req, res) => {
  const b = req.body || {};
  if (b.op === "sentinel" && b.kind === "watchlist") b.data = sentinel.normaliseWatchlist(b.data);
  res.status(201).json(records.create(b));
});
router.patch("/api/ops/records/:id", (req, res) => {
  const cur = records.get(req.params.id); if (!cur) return res.status(404).json({ error: "Not found" });
  const b = { ...(req.body || {}) };
  if (cur.op === "sentinel" && b.data) b.data = sentinel.normaliseWatchlist({ ...cur.data, ...b.data });
  res.json(records.update(cur.id, b));
});
router.delete("/api/ops/records/:id", (req, res) => { auditFromReq(req, "ops.delete", { id: Number(req.params.id) }); res.json({ ok: records.remove(req.params.id) }); });
router.get("/api/ops/meta", (req, res) => res.json({ ops: OPS, blackboxCategories: blackbox.CATEGORIES, tripKinds: wayfinder.KINDS, checklists: wayfinder.CHECKLISTS, watchLevels: sentinel.MIN_LEVELS, satelliteGroups: orbit.GROUPS, orbit: orbit.orbitStatus() }));

// ---------------------------------------------------------------- Blackbox
router.post("/api/blackbox/dossiers", rateLimit({ name: "dossier", limit: 6, windowMs: 10 * 60_000 }), (req, res) => {
  const b = req.body || {};
  res.status(202).json(blackbox.createDossier({ subject: b.subject, question: b.question, category: b.category }, { notify }));
});
router.post("/api/blackbox/dossiers/:id/rerun", rateLimit({ name: "dossier", limit: 6, windowMs: 10 * 60_000 }), (req, res) => {
  const r = records.get(req.params.id); if (!r || r.kind !== "dossier") return res.status(404).json({ error: "Not found" });
  records.update(r.id, { status: "working", data: { steps: [{ step: "Research question defined (re-run)", at: new Date().toISOString() }], error: null } });
  blackbox.research(r.id, { notify }).catch((e) => records.update(r.id, { status: "failed", data: { error: e.message } }));
  res.status(202).json(records.get(r.id));
});

// ---------------------------------------------------------------- Wayfinder
router.get("/api/wayfinder/destination", rateLimit({ name: "wayfinder", limit: 30, windowMs: 60_000 }), wrap(async (req, res) => { if (!req.query.q) throw bad("Destination required"); res.json(await wayfinder.destination(String(req.query.q).slice(0, 120))); }));
router.get("/api/wayfinder/airports", (req, res) => {
  if (req.query.q) return res.json(wayfinder.findAirport(String(req.query.q).slice(0, 60)));
  const lat = +req.query.lat, lon = +req.query.lon;
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return res.status(400).json({ error: "q or lat/lon required" });
  res.json(wayfinder.nearestAirports(lat, lon, Math.min(20, +req.query.n || 5)));
});
router.post("/api/wayfinder/route", rateLimit({ name: "route", limit: 30, windowMs: 60_000 }), wrap(async (req, res) => res.json(await wayfinder.route(req.body?.points, req.body?.profile))));
router.get("/api/wayfinder/flight", rateLimit({ name: "wayfinder", limit: 30, windowMs: 60_000 }), wrap(async (req, res) => res.json(await wayfinder.flightStatus(String(req.query.no || "").slice(0, 12)))));
router.post("/api/wayfinder/plan", rateLimit({ name: "plan", limit: 6, windowMs: 10 * 60_000 }), wrap(async (req, res) => res.status(201).json(await wayfinder.planTrip(req.body || {}))));
router.get("/api/wayfinder/advice", wrap(async (req, res) => res.json(await wayfinder.travelAdvice(String(req.query.country || "").slice(0, 80)))));
// Check-in reminders for an expedition use the existing reminder system (they reach every device).
router.post("/api/wayfinder/:id/checkins", (req, res) => {
  const t = records.get(req.params.id); if (!t || t.op !== "wayfinder") return res.status(404).json({ error: "Not found" });
  const at = new Date(req.body?.at); if (Number.isNaN(at.getTime())) throw bad("A check-in needs a time");
  const r = reminders.add({ text: `Check-in: ${t.title}${req.body?.note ? ` — ${String(req.body.note).slice(0, 120)}` : ""}`, due_at: at.toISOString() });
  const checkins = [...(t.data.checkins || []), { at: at.toISOString(), note: String(req.body?.note || "").slice(0, 120), reminderId: r.id }];
  res.status(201).json(records.update(t.id, { data: { checkins } }));
});

// ---------------------------------------------------------------- Sentinel
router.post("/api/sentinel/check", rateLimit({ name: "sentinel", limit: 10, windowMs: 10 * 60_000 }), wrap(async (req, res) => res.json(await sentinel.checkWatchlists({ tz: (await import("../db.js")).getSettings().timezone, notify }))));
router.get("/api/sentinel/webcams", rateLimit({ name: "webcams", limit: 60, windowMs: 60_000 }), wrap(async (req, res) => {
  const q = req.query;
  res.json(await sentinel.webcams({ lat: q.lat != null ? +q.lat : undefined, lon: q.lon != null ? +q.lon : undefined, radiusKm: q.radiusKm, country: q.country, q: q.q, category: q.category }));
}));
router.post("/api/sentinel/webcams/verify", rateLimit({ name: "webcam-verify", limit: 4, windowMs: 10 * 60_000 }), wrap(async (req, res) => res.json(await sentinel.verifyYoutube({ force: !!req.body?.force, ids: req.body?.ids || null }))));

// ---------------------------------------------------------------- Orbit
router.get("/api/orbit/group/:g", rateLimit({ name: "orbit", limit: 60, windowMs: 60_000 }), wrap(async (req, res) => res.json(await orbit.group(req.params.g))));
router.get("/api/orbit/search", rateLimit({ name: "orbit", limit: 60, windowMs: 60_000 }), wrap(async (req, res) => res.json(await orbit.search(req.query.q))));
router.get("/api/orbit/iss", wrap(async (req, res) => res.json(await orbit.iss())));
router.get("/api/orbit/spaceweather", wrap(async (req, res) => res.json(await orbit.spaceWeather())));
router.get("/api/orbit/launches", wrap(async (req, res) => res.json(await orbit.launches(Math.min(15, +req.query.limit || 10)))));

// ---------------------------------------------------------------- Global Situation Report
router.post("/api/report/situation", rateLimit({ name: "sitrep", limit: 6, windowMs: 10 * 60_000 }), wrap(async (req, res) => res.status(201).json(await report.compile({ withSummary: req.body?.summary !== false }))));
