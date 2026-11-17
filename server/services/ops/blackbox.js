// Operation Blackbox: research dossiers from legitimate public information.
//
// Pipeline (each step recorded in the dossier):
//   1 question     the subject, category and question as asked
//   2 sources      free reference lookups (Wikipedia/Wikimedia; for aircraft ADSB.lol public data, for airports the
//                  offline OurAirports table) plus the AI's web search
//   3–6 extract    the AI reads the sources, extracts facts, compares them and lists contradictions
//   7–8 timeline & places — places are geocoded by Open-Meteo, never given coordinates by the AI
//   9 dossier      structured output; every finding cites numbered sources that exist in the source list,
//                  anything without a valid citation is labelled as AI interpretation
//   10 save        stored in the shared operations table
// People: public figures in their public/professional role only. No private individuals, home addresses, personal
// whereabouts or identification of anonymous people. Aircraft: public civil aviation only; privacy-flagged and
// military-flagged aircraft are refused (the same rules as flight tracking).
import { z } from "zod";
import { records } from "./records.js";
import { geocode } from "../../integrations/weather.js";
import * as flights from "../flights.js";
import { findAirport } from "./wayfinder.js";

export const CATEGORIES = {
  company: "Company", organisation: "Organisation", country: "Country", city: "City", location: "Geographical location", person: "Public figure (public role only)",
  aircraft: "Aircraft / flight", airport: "Airport", space: "Space mission", history: "Historical event", conflict: "War / historical conflict",
  technology: "Technology", science: "Science", aerospace: "Aerospace", news: "News development", institution: "Public institution", general: "General subject",
};
const UA = "JARVIS-personal-assistant/6.6 (non-commercial; single user)";
const WIKI = () => (process.env.WIKIPEDIA_URL || "https://en.wikipedia.org").replace(/\/$/, "");
const COMMONS = () => (process.env.COMMONS_URL || "https://commons.wikimedia.org").replace(/\/$/, "");

async function getJson(url, timeoutMs = 15000) {
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), timeoutMs);
  try { const r = await fetch(url, { headers: { "user-agent": UA, accept: "application/json" }, signal: ctl.signal }); if (r.status === 404) return null; if (!r.ok) throw new Error(`HTTP ${r.status}`); return await r.json(); }
  catch (e) { throw new Error(e.name === "AbortError" ? "timed out" : e.message); } finally { clearTimeout(t); }
}

// ---------------------------------------------------------------- Reference lookups (free)
export async function wikipedia(subject) {
  const s = await getJson(`${WIKI()}/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(subject)}&srlimit=1&format=json&origin=*`);
  const title = s?.query?.search?.[0]?.title;
  if (!title) return null;
  const p = await getJson(`${WIKI()}/api/rest_v1/page/summary/${encodeURIComponent(title.replace(/ /g, "_"))}`);
  if (!p || p.type === "disambiguation") return null;
  const out = { title: p.title, description: p.description || null, extract: p.extract || "", url: p.content_urls?.desktop?.page || `https://en.wikipedia.org/wiki/${encodeURIComponent(title)}`,
    coordinates: p.coordinates ? { lat: p.coordinates.lat, lon: p.coordinates.lon } : null, wikidata: p.wikibase_item || null, lastEdited: p.timestamp || null, image: null };
  const img = p.originalimage?.source || p.thumbnail?.source;
  if (img) {
    const file = decodeURIComponent(img.split("/").filter((x) => /\.\w{3,4}$/.test(x)).at(-1)?.replace(/^\d+px-/, "") || "");
    try {
      const m = file && await getJson(`${COMMONS()}/w/api.php?action=query&titles=${encodeURIComponent(`File:${file}`)}&prop=imageinfo&iiprop=extmetadata|url&format=json&origin=*`);
      const info = m && Object.values(m.query?.pages || {})[0]?.imageinfo?.[0];
      const md = info?.extmetadata || {};
      const licence = md.LicenseShortName?.value || null;
      if (licence) out.image = { url: p.thumbnail?.source || img, filePage: info.descriptionurl, licence, artist: String(md.Artist?.value || "").replace(/<[^>]+>/g, "").trim().slice(0, 120) || null, credit: "Wikimedia Commons" };
    } catch {}
  }
  return out;
}
function aircraftQuery(text) {
  const s = String(text || "").toUpperCase().replace(/\s+/g, "");
  if (/^[0-9A-F]{6}$/.test(s) && /\d/.test(s)) return s;
  if (/^[A-Z0-9]{1,2}-[A-Z0-9]{2,5}$/.test(s) || /^N\d{1,5}[A-Z]{0,2}$/.test(s)) return s;
  if (/^[A-Z]{3}\d{1,4}[A-Z]?$/.test(s)) return s;
  return null;
}

// ---------------------------------------------------------------- The dossier
const Num = z.array(z.number().int());
const DossierSchema = z.object({
  privateIndividual: z.boolean().describe("true if the subject is a private person (not a public figure in a public or professional role)"),
  title: z.string(),
  executiveSummary: z.string(),
  overview: z.string(),
  keyFindings: z.array(z.object({ text: z.string(), sources: Num, confidence: z.enum(["high", "medium", "low"]), interpretation: z.boolean().describe("true when this is your analysis rather than a fact stated in the cited sources") })),
  timeline: z.array(z.object({ date: z.string(), event: z.string(), sources: Num })),
  locations: z.array(z.object({ name: z.string().describe("a place name that can be looked up, e.g. 'Toulouse, France'"), why: z.string() })),
  historicalContext: z.string(),
  contradictions: z.array(z.object({ topic: z.string(), positions: z.array(z.object({ claim: z.string(), sources: Num })) })),
  documents: z.array(z.object({ title: z.string(), source: z.number().int() })).describe("notable documents among the numbered sources (reports, filings, official pages)"),
  limitations: z.array(z.string()),
});

/** Start a dossier: saves it immediately as "working" and researches in the background. */
export function createDossier({ subject, question = "", category = "general" }, { notify } = {}) {
  subject = String(subject || "").trim().slice(0, 200);
  if (!subject) throw Object.assign(new Error("A dossier needs a subject"), { status: 400 });
  if (!CATEGORIES[category]) category = "general";
  const rec = records.create({ op: "blackbox", kind: "dossier", title: subject, status: "working", data: { subject, question: String(question || "").slice(0, 600), category, steps: [{ step: "Research question defined", at: new Date().toISOString() }] } });
  research(rec.id, { notify }).catch((e) => records.update(rec.id, { status: "failed", data: { error: e.message } }));
  return rec;
}
export async function research(id, { notify } = {}) {
  const rec = records.get(id); if (!rec) return;
  const { subject, question, category } = rec.data;
  const steps = [...(rec.data.steps || [])];
  const step = (s, extra = {}) => { steps.push({ step: s, at: new Date().toISOString(), ...extra }); records.update(id, { data: { steps } }); };
  const sources = []; const addSrc = (s) => { const i = sources.findIndex((x) => x.url && x.url === s.url); if (i >= 0) return i + 1; sources.push({ ...s, accessedAt: new Date().toISOString() }); return sources.length; };
  const notes = [];

  // 2 · free reference sources
  let wiki = null, aircraft = null, airport = null;
  try { wiki = await wikipedia(subject); } catch (e) { notes.push(`Wikipedia lookup failed: ${e.message}`); }
  if (wiki) { const n = addSrc({ title: `${wiki.title} — Wikipedia`, url: wiki.url, publisher: "Wikipedia", kind: "reference" }); notes.push(`[${n}] Wikipedia summary: ${wiki.extract}`); }
  const aq = category === "aircraft" || aircraftQuery(subject) ? aircraftQuery(subject) : null;
  if (aq) {
    const r = await flights.search(aq).catch((e) => ({ ok: false, error: e.message }));
    if (r.ok && r.results?.length) {
      const a = r.results[0];
      aircraft = { hex: a.hex, callsign: a.callsign, reg: a.reg, type: a.type, seen: a.lastSeen, airborne: !a.ground, alt: a.alt, gs: a.gs, lat: a.lat, lon: a.lon, source: "ADSB.lol (public ADS-B)" };
      const n = addSrc({ title: `Live public ADS-B record for ${a.callsign || a.reg || a.hex}`, url: `https://globe.adsb.lol/?icao=${a.hex}`, publisher: "ADSB.lol", kind: "data" });
      notes.push(`[${n}] ADS-B: ICAO24 ${a.hex}, registration ${a.reg || "n/a"}, type code ${a.type || "n/a"}, callsign ${a.callsign || "n/a"}, observed ${a.lastSeen}.`);
    } else notes.push(`Aircraft ${aq}: ${r.error || "not visible in public ADS-B data right now (or withheld for privacy)"}.`);
  }
  if (category === "airport" || /^[A-Z]{3,4}$/.test(subject.toUpperCase().trim())) {
    const ap = findAirport(subject)[0];
    if (ap) { airport = ap; const n = addSrc({ title: `${ap.name} — OurAirports`, url: `https://ourairports.com/airports/${ap.icao}/`, publisher: "OurAirports", kind: "data" }); notes.push(`[${n}] Airport ${ap.name} (${ap.iata || "—"}/${ap.icao}), ${ap.city}, ${ap.country}; ${ap.lat}, ${ap.lon}; elevation ${ap.elevFt ?? "?"} ft; type ${ap.type}.`); }
  }
  step("Public sources identified", { count: sources.length });

  // 3–6 · web research (Claude with web search), then structured synthesis
  const brain = await import("../../brain.js");
  if (!brain.client) {
    records.update(id, { status: wiki || aircraft || airport ? "ready" : "failed", data: { steps, sources, wiki, aircraft, airport, error: "The AI is offline (no Anthropic key), so only reference lookups were made.", referenceOnly: true } });
    return;
  }
  const guard = `Rules: public information only. If the subject is a person, cover only their public or professional role; never include home addresses, family members who are not public figures, health, personal whereabouts or contact details. If the subject is a private individual (not a public figure), say so and stop. For aircraft, only public civil aviation information; do not track or predict movements of military, government or private owners. Never invent sources; if something isn't in a source, say it's unknown.`;
  let found = { text: "", sources: [] };
  try {
    found = await brain.webResearch(`Research this subject for a dossier.\nSubject: ${subject}\nCategory: ${CATEGORIES[category]}\nQuestion: ${question || "(general overview)"}\n${guard}\nFind authoritative and independent sources, note the date of each, compare them, and record any disagreements. Report concrete facts with citations.`);
  } catch (e) { notes.push(`Web research failed: ${e.message}`); }
  for (const s of found.sources) addSrc({ title: s.title, url: s.url, publisher: (() => { try { return new URL(s.url).hostname.replace(/^www\./, ""); } catch { return ""; } })(), kind: "web" });
  step("Information retrieved and facts extracted", { sources: sources.length });
  if (!sources.length) { records.update(id, { status: "failed", data: { steps, error: "No sources could be retrieved, so no dossier was written." } }); return; }

  const list = sources.map((s, i) => `[${i + 1}] ${s.title} — ${s.url}`).join("\n");
  const synth = await brain.structured("dossier", DossierSchema, `Write a research dossier using ONLY the material below. Cite sources by their number in square brackets lists ("sources": [1, 3]). A finding that is your own analysis must have interpretation=true. Do not cite numbers that aren't in the list. Dates in timeline as YYYY or YYYY-MM-DD.
${guard}
Subject: ${subject}
Category: ${CATEGORIES[category]}
Question: ${question || "(general overview)"}

Numbered sources:
${list}

Reference notes:
${notes.join("\n") || "(none)"}

Research notes from web search:
${found.text.slice(0, 24000) || "(none)"}`);
  if (!synth) throw new Error("The AI didn't return a dossier");
  if (synth.privateIndividual) {
    records.update(id, { status: "refused", data: { steps, error: "This looks like a private individual. Blackbox only researches public figures in their public or professional role.", sources: [] } });
    return;
  }
  const valid = (arr) => [...new Set((arr || []).filter((n) => Number.isInteger(n) && n >= 1 && n <= sources.length))];
  const findings = synth.keyFindings.map((f) => { const v = valid(f.sources); return { text: f.text, sources: v, confidence: v.length ? f.confidence : "low", kind: f.interpretation || !v.length ? "interpretation" : "sourced", droppedCitations: (f.sources || []).length - v.length }; });
  const timeline = synth.timeline.map((t) => ({ ...t, sources: valid(t.sources) })).sort((a, b) => String(a.date).localeCompare(String(b.date)));
  step("Sources compared; timeline established");

  // 8 · geography: geocode the named places (coordinates never come from the AI)
  const locations = [];
  for (const l of synth.locations.slice(0, 8)) {
    try { const g = (await geocode(l.name))[0]; locations.push(g ? { name: g.name, why: l.why, lat: g.lat, lon: g.lon, geocoder: "Open-Meteo" } : { name: l.name, why: l.why, lat: null, lon: null, geocoder: "not found" }); }
    catch { locations.push({ name: l.name, why: l.why, lat: null, lon: null, geocoder: "lookup failed" }); }
  }
  if (wiki?.coordinates && !locations.some((l) => l.lat != null)) locations.unshift({ name: wiki.title, why: "Coordinates from the Wikipedia article", lat: wiki.coordinates.lat, lon: wiki.coordinates.lon, geocoder: "Wikipedia" });
  if (airport) locations.unshift({ name: airport.name, why: "Airport location (OurAirports)", lat: airport.lat, lon: airport.lon, geocoder: "OurAirports" });
  step("Geographical context built", { places: locations.filter((l) => l.lat != null).length });

  const first = locations.find((l) => l.lat != null);
  const data = {
    steps, sources, wiki: wiki && { title: wiki.title, description: wiki.description, url: wiki.url, lastEdited: wiki.lastEdited }, aircraft, airport,
    executiveSummary: synth.executiveSummary, overview: synth.overview, findings, timeline, locations, historicalContext: synth.historicalContext,
    contradictions: synth.contradictions.map((c) => ({ topic: c.topic, positions: c.positions.map((p) => ({ claim: p.claim, sources: valid(p.sources) })) })),
    documents: synth.documents.filter((d) => d.source >= 1 && d.source <= sources.length), images: wiki?.image ? [wiki.image] : [], limitations: [...synth.limitations, ...(found.sources.length ? [] : ["Web search returned no sources; the dossier rests on reference lookups only."])],
    aiNote: "Summaries, comparisons and interpretations are written by the JARVIS AI from the numbered sources. Findings marked 'interpretation' are analysis, not facts stated by a source.",
    generatedAt: new Date().toISOString(),
  };
  step("Dossier generated and saved");
  records.update(id, { title: synth.title || subject, status: "ready", lat: first?.lat ?? null, lon: first?.lon ?? null, data: { ...data, steps } });
  notify?.({ kind: "research", title: "Blackbox dossier ready", body: synth.title || subject, url: `/?tab=home&mission=op-blackbox&dossier=${id}` }).catch?.(() => {});
}
