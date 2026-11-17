// Global Operations (JARVIS 6.5): flight tracking, Global Events and map tiles, against stand-in providers.
// Checks the honesty rules: real provenance on everything, privacy-flagged aircraft hidden, budgets respected,
// failures and missing credentials reported as such, nothing invented.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startMock } from "./mock-upstream.js";
import { startServer, Device } from "./helpers.js";

let mock, srv, d;
before(async () => {
  mock = await startMock(); srv = await startServer(mock);
  d = new Device(srv.base);
  assert.equal((await d.call("/api/setup", { method: "POST", body: { code: "SETUP-1234", password: "correct horse battery" } })).status, 201);
});
after(async () => { await srv?.stop(); mock?.server.close(); });

const rows = (r) => r.aircraft.map((x) => Object.fromEntries(r.fields.map((f, i) => [f, x[i]])));

test("a small map view uses ADSB.lol, hides military and privacy-listed aircraft, and reports provenance", async () => {
  const r = (await d.call("/api/flights?lamin=34&lomin=32&lamax=36&lomax=35")).data;
  assert.equal(r.ok, true); assert.equal(r.source, "adsb");
  assert.equal(r.attribution.licence, "ODbL 1.0");
  const list = rows(r);
  assert.ok(list.length >= 8, `aircraft shown: ${list.length}`);
  assert.ok(!list.some((a) => a.callsign === "MIL01" || a.hex === "7a0090"), "military-flagged aircraft is hidden");
  assert.ok(!list.some((a) => a.hex === "7a9999"), "PIA-listed aircraft is hidden");
  assert.ok(r.counts.hiddenPrivacy >= 1);
  assert.ok(list.every((a) => typeof a.posAge === "number"), "every position carries its age");
  assert.ok(r.counts.stale >= 1, "old positions are counted as stale, not shown as live");
  assert.match(r.fetchedAt, /^\d{4}-/); assert.ok(r.ttlSec >= 15);
});

test("the same view again is served from cache — no second provider request", async () => {
  const before = mock.log.adsb.filter((p) => p.includes("/point/")).length;
  const r = (await d.call("/api/flights?lamin=34.2&lomin=32.2&lamax=35.8&lomax=34.8")).data;
  assert.equal(r.ok, true);
  assert.equal(mock.log.adsb.filter((p) => p.includes("/point/")).length, before);
});

test("a continent-sized view uses one OpenSky bounding-box request; the world view one global request", async () => {
  const n0 = mock.log.opensky.length;
  const eu = (await d.call("/api/flights?lamin=35&lomin=-10&lamax=60&lomax=30")).data;
  assert.equal(eu.source, "opensky"); assert.equal(eu.attribution.name, "OpenSky Network");
  assert.equal(mock.log.opensky.length, n0 + 1);
  assert.match(mock.log.opensky.at(-1), /lamin=35&lomin=-10&lamax=60&lomax=30/);
  const w = (await d.call("/api/flights?lamin=-80&lomin=-180&lamax=80&lomax=180&limit=12000")).data;
  assert.equal(w.ok, true); assert.ok(w.aircraft.length > 1000);
  assert.doesNotMatch(mock.log.opensky.at(-1), /lamin/, "worldwide uses the single global query");
  assert.ok(!rows(w).some((a) => a.hex === "ae1234"), "aircraft on ADSB.lol's military list are hidden from OpenSky data too");
});

test("search by callsign, registration and ICAO24; an unknown flight is reported as not visible", async () => {
  for (const q of ["TST5", "5B-T05", "7A0005"]) {
    const r = (await d.call(`/api/flights/search?q=${encodeURIComponent(q)}`)).data;
    assert.equal(r.ok, true, q); assert.equal(r.results[0].hex, "7a0005", q);
  }
  const none = (await d.call("/api/flights/search?q=ZZZ999")).data;
  assert.equal(none.results.length, 0);
  assert.equal((await d.call("/api/flights/search?q=a")).status, 400);
});

test("aircraft details include freshness, source and the observed trail", async () => {
  const r = (await d.call("/api/flights/aircraft/7a0001")).data;
  assert.equal(r.ok, true);
  assert.equal(r.aircraft.hex, "7a0001"); assert.equal(r.aircraft.reg, "5B-T01"); assert.equal(r.aircraft.type, "A320");
  assert.ok(["live", "recent", "stale"].includes(r.aircraft.freshness));
  assert.ok(Array.isArray(r.trail) && r.trail.length >= 1);
  assert.equal((await d.call("/api/flights/aircraft/7a0090")).data.ok, false, "a military-flagged aircraft can't be looked up");
  assert.equal((await d.call("/api/flights/aircraft/not-hex")).status, 400);
});

test("when ADSB.lol's daily allowance runs out, JARVIS says so and falls back to fresh OpenSky data it already holds", async () => {
  mock.state.adsbRemaining = 0;
  try {
    const r = (await d.call("/api/flights?lamin=40&lomin=20&lamax=41&lomax=21")).data;   // new area: no ADSB.lol data for it
    if (r.ok) assert.equal(r.source, "opensky", "served from the worldwide OpenSky result, not presented as ADSB.lol");
    else assert.match(r.error, /allowance|unavailable|used up/i);
    const st = (await d.call("/api/flights/status")).data.providers.adsb;
    assert.equal(st.remaining, 0); assert.ok(["exhausted", "backoff"].includes(st.state), st.state);
  } finally { mock.state.adsbRemaining = 500; }
});

test("Global Events: real items from each keyless source, with sources, dates and verification labels", async () => {
  const r = (await d.call("/api/events?wait=1")).data;
  const by = (p) => r.items.filter((e) => e.provider === p);
  assert.equal(by("gdacs").length, 2); assert.equal(by("usgs").length, 1);
  const cyclone = by("gdacs").find((e) => /Cyclone/.test(e.title));
  assert.equal(cyclone.alertLevel, "Red"); assert.equal(cyclone.country, "India"); assert.equal(cyclone.status, "official");
  const quake = by("usgs")[0];
  assert.equal(quake.locAccuracy, "epicentre"); assert.equal(quake.status, "reviewed"); assert.equal(quake.country, "Japan");
  for (const e of r.items) {
    assert.ok(e.sources.length && e.sources[0].url, `${e.id} links to its source`);
    assert.ok(e.retrievedAt && (e.publishedAt || e.eventDate), `${e.id} has dates`);
    assert.ok(r.statusLabels[e.status], `${e.id} has a verification label`);
  }
  // GDELT: two outlets reporting the same Sudan ceasefire become one corroborated story; a lone report stays "single".
  const g = by("gdelt");
  const sudan = g.find((e) => /Sudan/.test(e.title));
  assert.equal(sudan.status, "corroborated"); assert.equal(sudan.sourceCount, 2); assert.equal(sudan.country, "Sudan");
  assert.equal(sudan.locAccuracy, "country (from headline)");
  const lone = g.find((e) => /Truce holds/.test(e.title));
  assert.equal(lone.status, "single"); assert.equal(lone.lat, null, "no location is invented when the headline names no country");
  assert.equal(r.providers.reliefweb.state, "not_configured"); assert.equal(r.providers.ucdp.state, "not_configured");
});

test("filters: category, country, region, provider and verification", async () => {
  const q = async (s) => (await d.call(`/api/events?${s}`)).data.items;
  assert.ok((await q("category=disaster")).every((e) => e.category === "disaster"));
  assert.ok((await q("country=japan")).every((e) => e.country === "Japan"));
  assert.ok((await q("region=Asia")).length >= 2);
  assert.ok((await q("provider=usgs")).every((e) => e.provider === "usgs"));
  assert.ok((await q("status=corroborated")).every((e) => e.status === "corroborated"));
});

test("ReliefWeb and UCDP stay off until their free credentials are added; then their data appears", async () => {
  const ks = (await d.call("/api/globalops/keys", { method: "PATCH", body: { reliefwebAppname: "approved-test-app", ucdpToken: "ucdp-test-token", bogus: "x" } })).data;
  assert.equal(ks.reliefwebAppname, true); assert.equal(ks.ucdpToken, true); assert.equal(ks.bogus, undefined);
  const st = (await d.call("/api/globalops/status")).data;
  assert.equal(JSON.stringify(st).includes("ucdp-test-token"), false, "credentials are never sent back");
  await d.call("/api/events/refresh", { method: "POST" });
  const r = (await d.call("/api/events?wait=1")).data;
  const rw = r.items.find((e) => e.provider === "reliefweb"), uc = r.items.find((e) => e.provider === "ucdp");
  assert.equal(rw.category, "humanitarian"); assert.equal(rw.country, "Yemen");
  assert.equal(uc.status, "coded"); assert.equal(uc.lat, 15.6, "UCDP coordinates are rounded to 0.1°"); assert.match(uc.locAccuracy, /rounded/);
  assert.equal(r.providers.ucdp.state, "operational");
  // A wrong appname is reported as a failure, not hidden.
  await d.call("/api/globalops/keys", { method: "PATCH", body: { reliefwebAppname: "not-approved" } });
  await d.call("/api/events/refresh", { method: "POST" });
  const r2 = (await d.call("/api/events?wait=1")).data;
  assert.match(r2.providers.reliefweb.lastError, /403|approved/);
  await d.call("/api/globalops/keys", { method: "PATCH", body: { reliefwebAppname: "", ucdpToken: "" } });
});

test("GDELT rate limiting stops the refresh at the first refusal and is reported honestly", async () => {
  mock.state.gdelt429 = true;
  try {
    const before = mock.state.gdeltCalls;
    await d.call("/api/events/refresh", { method: "POST" });
    const r = (await d.call("/api/events?wait=1")).data;
    assert.equal(mock.state.gdeltCalls - before, 1, "no further searches after a 429");
    assert.match(r.providers.gdelt.lastError, /rate-limiting/);
    assert.ok(["degraded", "stale", "failed"].includes(r.providers.gdelt.state));
  } finally { mock.state.gdelt429 = false; }
});

test("map tiles are served through JARVIS with a signed-in session only, and cached", async () => {
  const anon = await fetch(`${srv.base}/tiles/dark/2/1/1`);
  assert.equal(anon.status, 401);
  const n0 = mock.log.tiles;
  const t1 = await d.call("/tiles/satellite/3/4/2");
  assert.equal(t1.status, 200); assert.equal(t1.headers.get("content-type"), "image/jpeg");
  await d.call("/tiles/satellite/3/4/2");
  assert.equal(mock.log.tiles - n0, 1, "second request comes from the disk cache");
  assert.equal((await d.call("/tiles/radar/3/4/2")).status, 200);
  assert.equal((await d.call("/tiles/today/12/1/1")).status, 404, "zoom beyond the provider's maximum is refused");
  assert.equal((await d.call("/tiles/nope/1/1/1")).status, 404);
  const layers = (await d.call("/api/globalops/status")).data.layers;
  for (const [k, l] of Object.entries(layers)) assert.ok(l.attribution && l.terms, `${k} has attribution and terms`);
});

test("headlines are placed at country level by the location they name, never guessed", async () => {
  const brain = await import("../server/services/events.js");
  assert.equal(typeof brain.countryFromText, "function");
  assert.equal(brain.countryFromText("Israeli strikes kill 12 in Gaza")?.name, "Palestine");
  assert.equal(brain.countryFromText("Cold turkey for markets"), null);
  assert.equal(brain.countryFromText("Floods in Jordan")?.name, "Jordan");
  assert.equal(brain.countryFromText("Michael Jordan retires"), null);
});

test("asking JARVIS about aircraft around a place answers with the real count; an unknown flight is 'not visible'", async () => {
  const r = await d.call("/api/chat", { method: "POST", body: { text: "Show me aircraft around Cyprus", clientId: "goc-1" } });
  assert.equal(r.status, 200);
  // Earlier tests used up the stand-in ADSB.lol allowance, so this may honestly come from OpenSky instead.
  assert.match(r.data.reply, /^\d+ aircraft visible around Larnaca.*(ADSB\.lol|OpenSky Network)\.$/);
  const n = Number(r.data.reply.match(/^(\d+)/)[1]);
  assert.ok(n >= 1 && n <= 12, `count comes from the data (${n}); hidden aircraft not counted`);
  const f = await d.call("/api/chat", { method: "POST", body: { text: "Find flight ZZZ999", clientId: "goc-2" } });
  assert.match(f.data.reply, /isn't visible in the available data/);
});
