// Operation Wayfinder: travel and expedition planning from free, real sources.
//
//   Places & weather   Open-Meteo geocoding and forecast (existing integration; forecasts reach 7 days ahead)
//   Travel advice      UK FCDO advice via the GOV.UK Content API (Open Government Licence v3.0)
//   Country facts      world-countries (ODbL): capital, currencies, languages, calling code
//   Airports           OurAirports (public domain), offline; airlines from OpenFlights (ODbL), offline
//   Routes             OSRM: car on router.project-osrm.org, foot and bike on routing.openstreetmap.de (FOSSGIS),
//                      both free for light personal use. Distances and times are the router's, never invented.
//   Live flight status ADSB.lol (existing flight tracking) by ICAO callsign: position only. Origin, destination and
//                      schedules aren't available from any free source and are not shown.
// Not available for free, and therefore not offered: live airline schedules, fares or booking inventory.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getWeather, geocode } from "../../integrations/weather.js";
import { getSettings } from "../../db.js";
import * as flights from "../flights.js";
import { z } from "zod";
import { records } from "./records.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const load = (f) => JSON.parse(fs.readFileSync(path.join(here, "..", "..", "data", f), "utf8"));
const AIRPORTS = load("airports.json"), AIRLINES = load("airlines.json"), COUNTRIES = load("countries.json");
const C2 = Object.fromEntries(COUNTRIES.filter((c) => c.c2).map((c) => [c.c2, c]));
const UA = "JARVIS-personal-assistant/6.6 (non-commercial; single user)";
const URL_ = {
  govuk: () => (process.env.GOVUK_URL || "https://www.gov.uk").replace(/\/$/, ""),
  osrmCar: () => process.env.OSRM_CAR_URL || "https://router.project-osrm.org/route/v1/driving",
  osrmFoot: () => process.env.OSRM_FOOT_URL || "https://routing.openstreetmap.de/routed-foot/route/v1/foot",
  osrmBike: () => process.env.OSRM_BIKE_URL || "https://routing.openstreetmap.de/routed-bike/route/v1/bike",
};
export const SOURCES = {
  meteo: { name: "Open-Meteo", url: "https://open-meteo.com/", terms: "Free for non-commercial use, CC BY 4.0" },
  fcdo: { name: "UK FCDO travel advice (GOV.UK)", url: "https://www.gov.uk/foreign-travel-advice", terms: "Open Government Licence v3.0" },
  ourairports: { name: "OurAirports", url: "https://ourairports.com/data/", terms: "Public domain" },
  openflights: { name: "OpenFlights airline data", url: "https://openflights.org/data.php", terms: "Open Database License (ODbL)" },
  osrm: { name: "OSRM (OpenStreetMap routing)", url: "https://project-osrm.org/", terms: "Free demo servers for light use; map data © OpenStreetMap contributors (ODbL)" },
  countries: { name: "world-countries", url: "https://github.com/mledoze/countries", terms: "ODbL" },
};
const toRad = (d) => (d * Math.PI) / 180;
export function distanceKm(a, b) { const h = Math.sin(toRad(b.lat - a.lat) / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(toRad(b.lon - a.lon) / 2) ** 2; return 2 * 6371 * Math.asin(Math.sqrt(h)); }

async function getJson(url, opts = {}, timeoutMs = 20000) {
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { ...opts, headers: { "user-agent": UA, accept: "application/json", ...(opts.headers || {}) }, signal: ctl.signal });
    if (r.status === 404) return null;
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.json();
  } catch (e) { throw new Error(e.name === "AbortError" ? "timed out" : e.message); }
  finally { clearTimeout(t); }
}

// ---------------------------------------------------------------- Airports and airlines
export function nearestAirports(lat, lon, n = 5, { largeOnly = false } = {}) {
  return AIRPORTS.filter((a) => !largeOnly || a.type === "large").map((a) => ({ ...a, km: Math.round(distanceKm({ lat, lon }, a)) })).sort((a, b) => a.km - b.km).slice(0, n);
}
export function findAirport(q) {
  const s = String(q || "").trim(); if (!s) return [];
  const up = s.toUpperCase();
  const exact = AIRPORTS.filter((a) => a.iata === up || a.icao === up);
  if (exact.length) return exact;
  const lo = s.toLowerCase();
  return AIRPORTS.filter((a) => a.name.toLowerCase().includes(lo) || a.city.toLowerCase() === lo).sort((a, b) => (a.type === "large" ? -1 : 1) - (b.type === "large" ? -1 : 1)).slice(0, 10);
}
export function airline(code) { const c = String(code || "").toUpperCase(); return AIRLINES.find((a) => a.iata === c || a.icao === c) || null; }
/** BA123 → BAW123 (ICAO callsign used by ADS-B), when the airline is in the offline table. */
export function callsignFor(flightNo) {
  const m = String(flightNo || "").toUpperCase().replace(/\s+/g, "").match(/^([A-Z0-9]{2,3}?)(\d{1,4}[A-Z]?)$/);
  if (!m) return null;
  if (m[1].length === 3 && airline(m[1])) return { callsign: m[1] + m[2], airline: airline(m[1]) };
  const al = airline(m[1]);
  return al ? { callsign: al.icao + m[2], airline: al } : null;
}

// ---------------------------------------------------------------- Destination research
const slug = (name) => String(name).toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/&/g, "and").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const FCDO_SLUG = { "United States": "usa", "United Kingdom": null, "Czechia": "czech-republic", "Türkiye": "turkey", "Ivory Coast": "cote-d-ivoire", "DR Congo": "democratic-republic-of-the-congo", "Republic of the Congo": "congo", "South Korea": "south-korea", "North Korea": "north-korea", "Myanmar": "myanmar", "Palestine": "the-occupied-palestinian-territories", "Vatican City": "italy", "Macau": "macao" };
export async function travelAdvice(countryName) {
  if (FCDO_SLUG[countryName] === null) return { available: false, reason: "FCDO publishes advice for travel abroad from the UK; there is none for the UK itself." };
  const s = FCDO_SLUG[countryName] || slug(countryName);
  const j = await getJson(`${URL_.govuk()}/api/content/foreign-travel-advice/${s}`);
  if (!j) return { available: false, reason: `No FCDO advice page found for ${countryName}.` };
  const parts = (j.details?.parts || []).map((p) => ({ title: p.title.trim(), slug: p.slug, text: String(p.body || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 1200), url: `https://www.gov.uk/foreign-travel-advice/${s}/${p.slug}` }));
  const warn = parts.find((p) => p.slug === "warnings-and-insurance") || parts[0];
  return { available: true, country: countryName, url: `https://www.gov.uk/foreign-travel-advice/${s}`, updatedAt: j.details?.updated_at || j.public_updated_at, reviewedAt: j.details?.reviewed_at || null,
    alertStatus: j.details?.alert_status || [], summary: warn?.text.slice(0, 700) || "", parts: parts.map(({ title, url, text }) => ({ title, url, excerpt: text.slice(0, 400) })), source: SOURCES.fcdo, retrievedAt: new Date().toISOString() };
}
export async function destination(q) {
  const places = await geocode(q);
  if (!places.length) return { ok: false, error: `No place called "${q}" was found.` };
  const p = places[0];
  const countryName = p.name.split(", ").at(-1);
  const country = COUNTRIES.find((c) => c.name === countryName || c.aliases.includes(countryName)) || null;
  const [weather, advice] = await Promise.allSettled([getWeather({ lat: p.lat, lon: p.lon, place: p.name, units: getSettings().units }), country ? travelAdvice(country.name) : Promise.resolve(null)]);
  return {
    ok: true, place: { ...p, alternatives: places.slice(1, 5).map((x) => x.name) },
    country: country && { name: country.name, capital: country.capital, currencies: country.currencies, languages: country.languages, calling: country.calling, region: country.subregion || country.region, source: SOURCES.countries },
    weather: weather.status === "fulfilled" ? { place: weather.value.place, current: weather.value.current, daily: weather.value.daily, unit: weather.value.unitTemp, fetchedAt: weather.value.fetchedAt, source: SOURCES.meteo, note: "Forecasts cover the next 7 days; beyond that, check closer to departure." } : { error: weather.reason?.message },
    advice: advice.status === "fulfilled" ? advice.value : { available: false, reason: advice.reason?.message },
    airports: nearestAirports(p.lat, p.lon, 5).map((a) => ({ ...a, source: "OurAirports" })),
    localTime: (() => { try { return new Date().toLocaleString("en-GB", { timeZone: p.timezone, weekday: "short", hour: "2-digit", minute: "2-digit" }); } catch { return null; } })(),
    retrievedAt: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------- Routes
export async function route(points, profile = "driving") {
  const pts = (points || []).filter((p) => Number.isFinite(+p.lat) && Number.isFinite(+p.lon)).slice(0, 25);
  if (pts.length < 2) throw Object.assign(new Error("A route needs at least two points"), { status: 400 });
  const base = profile === "walking" ? URL_.osrmFoot() : profile === "cycling" ? URL_.osrmBike() : URL_.osrmCar();
  const coords = pts.map((p) => `${(+p.lon).toFixed(5)},${(+p.lat).toFixed(5)}`).join(";");
  const straightKm = pts.slice(1).reduce((s, p, i) => s + distanceKm(pts[i], p), 0);
  let j;
  try { j = await getJson(`${base}/${coords}?overview=simplified&geometries=geojson&steps=false`); }
  catch (e) { return { ok: false, error: `Routing service unavailable: ${e.message}`, straightLineKm: Math.round(straightKm * 10) / 10, note: "Straight-line (great-circle) distance only — not a travel distance." }; }
  if (!j || j.code !== "Ok" || !j.routes?.length) return { ok: false, error: j?.message || "No route found between those points", straightLineKm: Math.round(straightKm * 10) / 10 };
  const r = j.routes[0];
  return { ok: true, profile, distanceKm: Math.round(r.distance / 100) / 10, durationMin: Math.round(r.duration / 60), legs: r.legs.map((l) => ({ km: Math.round(l.distance / 100) / 10, min: Math.round(l.duration / 60) })),
    geometry: r.geometry.coordinates.map(([lon, lat]) => [+lat.toFixed(5), +lon.toFixed(5)]), straightLineKm: Math.round(straightKm * 10) / 10,
    source: SOURCES.osrm, retrievedAt: new Date().toISOString(), note: "Durations are the router's estimate for normal conditions; no live traffic." };
}

// ---------------------------------------------------------------- Live flight status (public civil ADS-B)
export async function flightStatus(flightNo) {
  const cs = /^[A-Z]{3}\d/.test(String(flightNo).toUpperCase().replace(/\s+/g, "")) ? { callsign: String(flightNo).toUpperCase().replace(/\s+/g, ""), airline: airline(String(flightNo).slice(0, 3)) } : callsignFor(flightNo);
  if (!cs) return { ok: false, error: `I can't convert ${flightNo} to an ADS-B callsign (airline not in the offline table). Try the ICAO form, e.g. BAW123.` };
  const r = await flights.search(cs.callsign);
  const a = r.results?.[0];
  const out = { ok: true, flight: String(flightNo).toUpperCase(), callsign: cs.callsign, airline: cs.airline?.name || null, airborne: !!a, retrievedAt: new Date().toISOString() };
  if (!a) return { ...out, note: r.error || `${cs.callsign} isn't visible to ADS-B receivers right now (not flying, outside coverage, or not broadcasting). This is not a schedule.` };
  out.aircraft = a;
  out.note = "Live position from public ADS-B. Origin and destination aren't available from a free source; scheduled times need the airline's own site.";
  return out;
}

// ---------------------------------------------------------------- Checklists (static guidance, not data)
export const CHECKLISTS = {
  trip: ["Passport valid for the whole stay (check entry rules)", "Visa or travel authorisation if required", "Travel insurance", "Bookings: flights, accommodation, transfers", "Payment cards and some local currency", "Phone roaming or local SIM", "Chargers and plug adapter", "Medication and prescriptions", "Emergency contacts shared"],
  hiking: ["Route planned and shared with someone", "Map and offline map on phone", "Waterproofs and warm layer", "Footwear broken in", "Water and food for the full day plus spare", "First-aid kit", "Head torch and spare batteries", "Weather checked the evening before and morning of", "Check-in time agreed"],
  roadtrip: ["Driving licence (and international permit if needed)", "Vehicle insurance valid abroad", "Breakdown cover", "Route and fuel/charging stops", "Spare tyre, warning triangle, hi-vis (country rules)", "Toll payment method", "Offline maps"],
  camping: ["Campsite booked or wild-camping rules checked", "Tent, sleeping bag rated for the overnight low", "Stove, fuel, lighter", "Water treatment", "Food storage", "Torch", "Weather review", "Check-in time agreed"],
  city: ["Transport card or app", "Opening times of key sights", "Bookings for timed entries", "Neighbourhoods to stay in", "Comfortable shoes"],
  multicountry: ["Entry rules for every country on the route", "Border crossing documents", "Currencies for each country", "Roaming coverage across countries", "Insurance covers all countries"],
  photography: ["Batteries charged + spares", "Memory cards formatted", "Sunrise/sunset times", "Permits for drones or restricted sites", "Rain cover", "Location scouting saved on the map"],
  research: ["Research questions written down", "Permissions or access arranged", "Notebook and backup storage", "Contacts at the site", "Data handling plan"],
};

// ---------------------------------------------------------------- AI-drafted plans (clearly labelled)
const PlanSchema = z.object({
  title: z.string(),
  itinerary: z.array(z.object({ day: z.number().int(), title: z.string(), items: z.array(z.string()) })),
  places: z.array(z.object({ name: z.string().describe("a place that can be looked up, e.g. 'Þingvellir National Park, Iceland'"), why: z.string() })),
  estimatedCosts: z.array(z.object({ item: z.string(), amount: z.number(), currency: z.string() })).describe("rough estimates only"),
  equipment: z.array(z.string()),
  notes: z.array(z.string()),
});
export const KINDS = ["trip", "hiking", "roadtrip", "camping", "city", "multicountry", "photography", "research"];
/** Create a trip (or expedition) from a destination: real place, weather, advice and airports, plus an AI-drafted plan. */
export async function planTrip({ destination: dest, days = 5, kind = "trip", start = null, travellers = [] } = {}) {
  if (!dest) throw Object.assign(new Error("Where to?"), { status: 400 });
  days = Math.max(1, Math.min(30, Math.round(+days || 5)));
  if (!KINDS.includes(kind)) kind = "trip";
  const d = await destination(dest);
  if (!d.ok) throw Object.assign(new Error(d.error), { status: 404 });
  const startDate = start && !Number.isNaN(Date.parse(start)) ? new Date(start).toISOString().slice(0, 10) : null;
  const endDate = startDate ? new Date(Date.parse(startDate) + (days - 1) * 86400_000).toISOString().slice(0, 10) : null;
  let plan = null, aiError = null;
  try {
    const brain = await import("../../brain.js");
    if (brain.client) plan = await brain.structured("wayfinder-plan", PlanSchema, `Draft a ${days}-day ${kind === "trip" ? "trip" : `${kind} expedition`} to ${d.place.name} for ${travellers.length || 1} traveller(s)${startDate ? ` starting ${startDate}` : ""}.
Real data you may use (don't contradict it): weather ${d.weather?.daily ? d.weather.daily.map((x) => `${x.date} ${x.summary} ${x.low}–${x.high}${d.weather.unit}`).join("; ") : "unavailable"}; FCDO advice summary: ${d.advice?.summary || "unavailable"}; nearest airports: ${d.airports.map((a) => `${a.name} (${a.iata || a.icao}) ${a.km} km`).join(", ")}.
Be practical; don't invent opening hours, prices of specific bookings or availability. Costs are rough estimates in the local currency or GBP. Places must be real and look-up-able.`, { effort: "low", maxTokens: 6000 });
    else aiError = "AI offline (no Anthropic key) — fill in the itinerary yourself.";
  } catch (e) { aiError = e.message; }
  const places = [];
  for (const p of (plan?.places || []).slice(0, 10)) {
    try { const g = (await geocode(p.name))[0]; if (g) places.push({ name: g.name, why: p.why, lat: g.lat, lon: g.lon, geocoder: "Open-Meteo" }); } catch {}
  }
  const expedition = kind !== "trip";
  return records.create({
    op: "wayfinder", kind: expedition ? "expedition" : "trip", title: plan?.title || `${d.place.name.split(",")[0]} — ${days} days`, lat: d.place.lat, lon: d.place.lon, tags: [kind],
    data: {
      kind, destination: { name: d.place.name, lat: d.place.lat, lon: d.place.lon, timezone: d.place.timezone }, depart: startDate, return: endDate, days, participants: travellers,
      transport: [], flights: [], accommodation: [], budget: { currency: d.country?.currencies?.[0]?.match(/\((\w+)\)/)?.[1] || "GBP", items: (plan?.estimatedCosts || []).map((c) => ({ ...c, estimate: true, by: "AI estimate" })) },
      itinerary: (plan?.itinerary || Array.from({ length: days }, (_, i) => ({ day: i + 1, title: "", items: [] }))).map((x) => ({ ...x, by: plan ? "AI draft" : "you" })),
      places, checklist: [...(CHECKLISTS[kind] || CHECKLISTS.trip), ...(plan?.equipment || []).map((e) => `Pack: ${e}`)].map((text) => ({ text, done: false })),
      documents: [], emergency: { contacts: [], notes: "" }, checkins: [], routes: [],
      research: { country: d.country, advice: d.advice?.available ? { url: d.advice.url, updatedAt: d.advice.updatedAt, summary: d.advice.summary, parts: d.advice.parts } : { unavailable: d.advice?.reason }, airports: d.airports, weatherAtCreation: d.weather?.daily ? { fetchedAt: d.weather.fetchedAt, daily: d.weather.daily, unit: d.weather.unit } : null, retrievedAt: d.retrievedAt },
      aiNotes: plan?.notes || [], aiDraft: !!plan, aiError,
    },
  });
}
