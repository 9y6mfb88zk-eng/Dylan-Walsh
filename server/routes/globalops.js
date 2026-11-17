// Global Operations: public civil flight tracking, the Global Events tracker and map tiles.
import express from "express";
import { requireAuth } from "../security/auth.js";
import { rateLimit } from "../security/ratelimit.js";
import { auditFromReq } from "../security/audit.js";
import * as flights from "../services/flights.js";
import * as events from "../services/events.js";
import { tile, tileStatus, layerInfo, radarFrame } from "../services/tiles.js";
import { keyStatus, setKeys, KEY_NAMES } from "../services/globalops-keys.js";
import { runBootCheck } from "../services/boot.js";

export const router = express.Router();
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

router.get("/api/flights", rateLimit({ name: "flights", limit: 120, windowMs: 60_000 }), wrap(async (req, res) => {
  const { lamin, lomin, lamax, lomax } = req.query;
  res.json(await flights.aircraftInView({ lamin, lomin, lamax, lomax }, { limit: Math.min(Number(req.query.limit) || 6000, 12000) }));
}));
router.get("/api/flights/status", (req, res) => res.json(flights.status()));
router.get("/api/flights/search", rateLimit({ name: "flight-search", limit: 20, windowMs: 60_000 }), wrap(async (req, res) => res.json(await flights.search(req.query.q))));
router.get("/api/flights/aircraft/:hex", rateLimit({ name: "flight-detail", limit: 60, windowMs: 60_000 }), wrap(async (req, res) => res.json(await flights.aircraft(req.params.hex))));

router.get("/api/events", rateLimit({ name: "events", limit: 60, windowMs: 60_000 }), wrap(async (req, res) => res.json(await events.list(req.query))));
router.post("/api/events/refresh", rateLimit({ name: "events-refresh", limit: 3, windowMs: 10 * 60_000 }), wrap(async (req, res) => { await events.refresh({ force: true }); res.json(await events.list({ limit: 1 })); }));

router.get("/api/globalops/status", wrap(async (req, res) => {
  let radar = null; try { radar = (await radarFrame()).time; } catch {}
  let scheduler = null; try { scheduler = await runBootCheck("scheduler", {}); } catch (e) { scheduler = { status: "failed", detail: e.message }; }
  res.json({ flights: flights.status(), events: events.providerStatus(), tiles: tileStatus(), layers: layerInfo(), radarFrame: radar, keys: keyStatus(), scheduler: scheduler && { status: scheduler.status === "operational" ? "ok" : scheduler.status, detail: scheduler.detail } });
}));
router.patch("/api/globalops/keys", wrap(async (req, res) => {
  const patch = Object.fromEntries(Object.entries(req.body || {}).filter(([k]) => KEY_NAMES.includes(k)));
  auditFromReq(req, "globalops.keys", { changed: Object.keys(patch) });
  res.json(setKeys(patch));
}));

// Country names and centres for the map's label layer (offline gazetteer, with land area so the biggest are labelled first).
let COUNTRY_LABELS = null;
router.get("/api/globalops/countries", wrap(async (req, res) => {
  if (!COUNTRY_LABELS) {
    const fs = await import("node:fs"), path = await import("node:path"), { fileURLToPath } = await import("node:url");
    const file = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "data", "countries.json");
    COUNTRY_LABELS = JSON.parse(fs.readFileSync(file, "utf8")).map((c) => ({ name: c.name, lat: c.lat, lon: c.lon, area: c.area || 0 }));
  }
  res.setHeader("cache-control", "private, max-age=86400");
  res.json(COUNTRY_LABELS);
}));

// Tiles live outside /api so they don't share the API's request budget; they still need a signed-in session.
router.get("/tiles/:layer/:z/:x/:y", requireAuth, rateLimit({ name: "tiles", limit: 3000, windowMs: 60_000 }), wrap(async (req, res) => {
  try {
    const t = await tile(req.params.layer, req.params.z, req.params.x, req.params.y.replace(/\.\w+$/, ""));
    res.setHeader("content-type", t.type);
    res.setHeader("cache-control", t.stale ? "private, max-age=60" : "private, max-age=86400");
    res.sendFile(t.file);
  } catch (e) { res.status(e.status || 502).json({ error: e.message }); }
}));
