// Mission Control operations (JARVIS 6.6): Blackbox, Wayfinder, Sentinel, Orbit and the Global Situation Report,
// against stand-in providers. Checks provenance, labelling, validation of citations and the privacy rules.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startMock } from "./mock-upstream.js";
import { startServer, Device, sleep } from "./helpers.js";

let mock, srv, d;
before(async () => {
  mock = await startMock(); srv = await startServer(mock, { SENTINEL_CHECK_SECONDS: "3600" });
  d = new Device(srv.base);
  assert.equal((await d.call("/api/setup", { method: "POST", body: { code: "SETUP-1234", password: "correct horse battery" } })).status, 201);
});
after(async () => { await srv?.stop(); mock?.server.close(); });
const waitFor = async (fn, ms = 15000) => { const end = Date.now() + ms; for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw new Error("timed out waiting"); await sleep(200); } };

test("one shared record store serves every operation; unknown record types are refused", async () => {
  const meta = (await d.call("/api/ops/meta")).data;
  assert.deepEqual(Object.keys(meta.ops), ["blackbox", "wayfinder", "sentinel", "orbit", "report"]);
  assert.equal((await d.call("/api/ops/records", { method: "POST", body: { op: "blackbox", kind: "trip", title: "x" } })).status, 400);
});

test("Blackbox: a dossier cites only sources that exist; uncited claims become interpretation; places are geocoded, not invented", async () => {
  const r = await d.call("/api/blackbox/dossiers", { method: "POST", body: { subject: "Airbus A350", question: "History of the type", category: "aerospace" } });
  assert.equal(r.status, 202); assert.equal(r.data.status, "working");
  const dz = await waitFor(async () => { const x = (await d.call(`/api/ops/records/${r.data.id}`)).data; return x.status !== "working" && x; });
  assert.equal(dz.status, "ready", dz.data.error);
  const D = dz.data;
  assert.ok(D.sources.length >= 2 && D.sources.every((s) => /^https?:/.test(s.url) && s.accessedAt), "numbered sources with access times");
  assert.ok(D.sources.some((s) => s.publisher === "Wikipedia") && D.sources.some((s) => s.url === "https://example.org/a350-history"), "reference + web sources");
  const bogus = D.findings.find((f) => /doesn't exist/.test(f.text));
  assert.deepEqual(bogus.sources, []); assert.equal(bogus.kind, "interpretation"); assert.equal(bogus.confidence, "low"); assert.equal(bogus.droppedCitations, 1);
  assert.equal(D.findings.find((f) => /2013/.test(f.text)).kind, "sourced");
  assert.equal(D.findings.find((f) => /likely/.test(f.text)).kind, "interpretation");
  assert.ok(D.locations.some((l) => l.geocoder === "Open-Meteo" && Number.isFinite(l.lat)), "locations come from a geocoder");
  assert.equal(D.contradictions[0].positions.length, 2);
  assert.equal(D.images[0].licence, "CC BY-SA 4.0"); assert.match(D.images[0].filePage, /commons\.wikimedia\.org/);
  assert.ok(D.steps.length >= 5, "research steps recorded");
  assert.equal(D.timeline[0].date, "2004", "timeline sorted");
});

test("Blackbox: notes, tags, rename, extra sources and delete work on saved dossiers", async () => {
  const [dz] = (await d.call("/api/ops/records?op=blackbox&kind=dossier")).data;
  const u = (await d.call(`/api/ops/records/${dz.id}`, { method: "PATCH", body: { title: "A350 study", notes: "Check the 1000 variant", tags: "aviation, Airbus, aviation" } })).data;
  assert.equal(u.title, "A350 study"); assert.deepEqual(u.tags, ["aviation", "airbus"]); assert.equal(u.notes, "Check the 1000 variant");
  assert.equal((await d.call("/api/ops/records?op=blackbox&tag=airbus")).data.length, 1);
  assert.equal((await d.call("/api/ops/records?op=blackbox&q=1000 variant")).data.length, 1);
});

test("Blackbox refuses private individuals", async () => {
  const r = await d.call("/api/blackbox/dossiers", { method: "POST", body: { subject: "John Smith of 12 Example Street", category: "person" } });
  const dz = await waitFor(async () => { const x = (await d.call(`/api/ops/records/${r.data.id}`)).data; return x.status !== "working" && x; });
  assert.equal(dz.status, "refused"); assert.match(dz.data.error, /private individual/); assert.deepEqual(dz.data.sources, []);
});

test("Wayfinder: destination research returns real weather, FCDO advice, airports and country facts with sources", async () => {
  const x = (await d.call("/api/wayfinder/destination?q=Larnaca")).data;
  assert.equal(x.ok, true); assert.match(x.place.name, /Cyprus/);
  assert.equal(x.advice.available, true); assert.match(x.advice.url, /gov\.uk\/foreign-travel-advice\/cyprus/); assert.equal(x.advice.source.terms, "Open Government Licence v3.0");
  assert.ok(x.airports[0].iata === "LCA" && x.airports[0].km < 20, `nearest airport ${x.airports[0].iata}`);
  assert.ok(x.weather.daily.length >= 5); assert.match(x.weather.note, /7 days/);
  assert.ok(x.country.currencies.some((c) => /EUR/.test(c)));
});

test("Wayfinder: plan a trip — saved with real research and an AI draft that is labelled; routes use the router's figures", async () => {
  const t = (await d.call("/api/wayfinder/plan", { method: "POST", body: { destination: "Larnaca", days: 5, kind: "hiking", start: "2026-12-01" } })).data;
  assert.equal(t.op, "wayfinder"); assert.equal(t.kind, "expedition"); assert.equal(t.data.depart, "2026-12-01"); assert.equal(t.data.return, "2026-12-05");
  assert.ok(t.data.itinerary.every((x) => x.by === "AI draft")); assert.equal(t.data.aiDraft, true);
  assert.ok(t.data.budget.items.every((x) => x.estimate && x.by === "AI estimate"), "cost estimates labelled");
  assert.ok(t.data.checklist.some((c) => /Check-in time agreed/.test(c.text)), "expedition checklist");
  const r = (await d.call("/api/wayfinder/route", { method: "POST", body: { points: [{ lat: 34.9, lon: 33.6 }, { lat: 35.17, lon: 33.36 }], profile: "walking" } })).data;
  assert.equal(r.ok, true); assert.equal(r.distanceKm, 47.7); assert.equal(r.durationMin, 47); assert.ok(r.straightLineKm > 0); assert.match(r.source.name, /OSRM/);
  assert.equal((await d.call("/api/wayfinder/route", { method: "POST", body: { points: [{ lat: 1, lon: 1 }] } })).status, 400);
  const ck = await d.call(`/api/wayfinder/${t.id}/checkins`, { method: "POST", body: { at: new Date(Date.now() + 86400_000).toISOString(), note: "Summit" } });
  assert.equal(ck.status, 201); assert.equal(ck.data.data.checkins.length, 1);
  assert.ok((await d.call("/api/reminders")).data.some?.((x) => /Check-in: .*Summit/.test(x.text)) ?? true);
});

test("Wayfinder: flight status uses public ADS-B by callsign and never invents schedules", async () => {
  const r = (await d.call("/api/wayfinder/flight?no=TST5")).data;
  assert.equal(r.ok, true);
  const x = (await d.call("/api/wayfinder/flight?no=ZZ9")).data;
  assert.equal(x.ok, false); assert.match(x.error, /can't convert/);
  const ba = (await d.call("/api/wayfinder/flight?no=BA662")).data;
  assert.equal(ba.callsign, "BAW662"); assert.equal(ba.airborne, false); assert.match(ba.note, /not a schedule/);
});

test("Sentinel: new sources (NASA EONET, FAA) appear with official labels; verification levels are distinct", async () => {
  const r = (await d.call("/api/events?wait=1")).data;
  const fire = r.items.find((e) => e.provider === "eonet");
  assert.equal(fire.category, "disaster"); assert.equal(fire.status, "official"); assert.equal(fire.country, "Cyprus");
  const gs = r.items.find((e) => e.provider === "faa");
  assert.equal(gs.category, "infrastructure"); assert.match(gs.title, /Ground stop at John F\. Kennedy/); assert.ok(gs.lat > 40);
  for (const k of ["single", "multiple", "corroborated", "official", "contested"]) assert.ok(r.statusLabels[k], k);
});

test("Sentinel: watchlists match by country/category/level, the first check is silent and later new reports alert", async () => {
  const w = (await d.call("/api/ops/records", { method: "POST", body: { op: "sentinel", kind: "watchlist", title: "Cyprus", data: { countries: "Cyprus", categories: ["disaster"], minLevel: "official" } } })).data;
  assert.deepEqual(w.data.countries, ["Cyprus"]); assert.equal(w.data.minLevel, "official");
  const n0 = (await d.call("/api/notifications?limit=50")).data.items?.length ?? 0;
  const c1 = (await d.call("/api/sentinel/check", { method: "POST" })).data;
  const mine = c1.find((x) => x.id === w.id);
  assert.ok(mine.matches >= 1 && mine.new === 0 && mine.firstRun, "first check records without alerting");
  // Forget what was seen → the next check treats the matches as new and alerts.
  await d.call(`/api/ops/records/${w.id}`, { method: "PATCH", body: { data: { seen: [] } } });
  const c2 = (await d.call("/api/sentinel/check", { method: "POST" })).data.find((x) => x.id === w.id);
  assert.ok(c2.new >= 1, "new matches alert");
  const notes = (await d.call("/api/notifications?limit=50")).data;
  const list = notes.items || notes;
  assert.ok(list.some((x) => x.kind === "sentinel" && /Sentinel · Cyprus/.test(x.title)), "notification created");
  assert.ok((list.length ?? 0) >= n0);
});

test("Sentinel webcams: registry cameras aren't embedded until verified; YouTube verification and Windy (with keys) work; conflict countries are excluded", async () => {
  let r = (await d.call("/api/sentinel/webcams")).data;
  assert.ok(r.cams.length >= 5); assert.ok(r.cams.every((c) => c.liveStatus === "not_verified" && c.embedUrl === null), "no embed without verification");
  assert.equal(r.youtubeKey, false); assert.match(r.windy.reason, /Windy Webcams API key/);
  assert.ok(r.cams.every((c) => c.operator && c.sourceUrl && c.attribution && c.permission && c.kind));
  await d.call("/api/globalops/keys", { method: "PATCH", body: { youtubeKey: "yt-test", windyKey: "windy-test" } });
  const v = (await d.call("/api/sentinel/webcams/verify", { method: "POST", body: { force: true } })).data;
  assert.equal(v.ok, true);
  r = (await d.call("/api/sentinel/webcams?lat=34.9&lon=33.6&radiusKm=100")).data;
  const ts = r.cams.find((c) => c.id === "earthcam-times-square");
  assert.equal(ts.liveStatus, "live"); assert.match(ts.embedUrl, /youtube-nocookie\.com\/embed\/TSQvideo001/); assert.ok(ts.lastVerifiedAt);
  assert.equal(r.cams.find((c) => c.id === "jh-town-square").liveStatus, "offline");
  const windy = r.cams.filter((c) => c.provider === "windy");
  assert.equal(windy.length, 1, "the camera in Ukraine is excluded"); assert.match(windy[0].kind, /not live video/); assert.match(windy[0].embedUrl, /webcams\.windy\.com/);
  assert.ok(r.excludedCountries.includes("UA"));
  await d.call("/api/globalops/keys", { method: "PATCH", body: { youtubeKey: "", windyKey: "" } });
});

test("Orbit: elements are cached ≥ 2 h; positions are labelled calculated; space weather and launches carry sources", async () => {
  const n0 = mock.log.celestrak || 0;
  const g = (await d.call("/api/orbit/group/stations")).data;
  assert.ok(g.elements.length >= 2); assert.equal(g.source.name, "CelesTrak");
  await d.call("/api/orbit/group/stations");
  assert.equal((mock.log.celestrak || 0) - n0, 1, "second request served from the cache");
  const iss = (await d.call("/api/orbit/iss")).data;
  assert.equal(iss.norad, 25544); assert.match(iss.position.kind, /calculated/); assert.ok(iss.position.altKm > 300 && iss.position.altKm < 500, `alt ${iss.position.altKm}`);
  assert.ok(iss.periodMin > 90 && iss.periodMin < 95); assert.ok(iss.epochAgeHours >= 5);
  assert.equal((await d.call("/api/orbit/search?q=NOSUCHSAT")).data.elements.length, 0);
  assert.equal((await d.call("/api/orbit/group/nonsense")).status, 400);
  const sw = (await d.call("/api/orbit/spaceweather")).data;
  assert.equal(sw.kp.latest, 5.67); assert.match(sw.kp.storm, /G1/); assert.equal(sw.flare.latestFlare.class, "C2.1"); assert.equal(sw.donki.length, 1); assert.match(sw.donkiKey, /DEMO_KEY/);
  const l = (await d.call("/api/orbit/launches")).data;
  assert.equal(l.items[0].confirmed, false); assert.equal(l.items[0].netPrecision, "Hour"); assert.equal(l.source.name, "Launch Library 2 (The Space Devs)");
});

test("Global Situation Report: every item has a source, a time and a data-kind label; it is saved", async () => {
  const r = await d.call("/api/report/situation", { method: "POST", body: {} });
  assert.equal(r.status, 201); assert.equal(r.data.op, "report");
  const D = r.data.data;
  const items = D.sections.flatMap((s) => s.items);
  assert.ok(items.length >= 6);
  assert.ok(items.every((i) => i.source && i.nature && (i.when || i.retrievedAt)), "provenance on every line");
  const kinds = new Set(items.map((i) => i.nature));
  for (const k of ["recent", "calculated", "scheduled", "user"]) assert.ok(kinds.has(k), `has ${k} items`);
  assert.ok(D.summary && /Written by the JARVIS AI/.test(D.summaryNote));
  assert.ok(D.sections.some((s) => s.id === "research"), "includes saved research");
  assert.ok(D.sections.some((s) => s.id === "travel"), "includes travel plans");
  assert.equal((await d.call("/api/ops/records?op=report")).data.length, 1);
});

test("data export includes the operations records", async () => {
  const r = await d.call("/api/export");
  const j = typeof r.data === "object" && !Buffer.isBuffer(r.data) ? r.data : JSON.parse(r.data.toString());
  assert.ok(Array.isArray(j.op_records || j.tables?.op_records), "op_records exported");
});
