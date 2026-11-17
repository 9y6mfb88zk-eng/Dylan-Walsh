// GLOBAL SITUATION REPORT: one briefing compiled from all four operations and the existing services.
// Every item carries its source, its retrieval time and what kind of data it is:
//   live        observed now (aircraft positions, current conditions)
//   recent      published reports, as of their publication time
//   forecast    a forecast
//   calculated  computed from data (satellite positions from orbital elements)
//   scheduled   announced plans (launches)
//   historical  saved research
//   user        entered by you (trips)
import { getSettings } from "../../db.js";
import { getWeather } from "../../integrations/weather.js";
import * as events from "../events.js";
import * as flights from "../flights.js";
import * as orbit from "./orbit.js";
import { records } from "./records.js";

export async function compile({ withSummary = true } = {}) {
  const s = getSettings(), at = new Date().toISOString();
  const sections = [], problems = [];
  const safe = async (name, fn) => { try { return await fn(); } catch (e) { problems.push(`${name}: ${e.message}`); return null; } };

  const ev = await safe("Global events", () => events.list({ days: 2, limit: 400 }));
  if (ev) {
    const pick = (cats, n) => ev.items.filter((e) => cats.includes(e.category)).slice(0, n);
    const item = (e) => ({ text: e.title, place: e.placeName || e.country || null, when: e.publishedAt || e.eventDate, nature: "recent", verification: events.STATUS_LABEL[e.status] || e.status, source: e.sources?.[0]?.name || e.provider, url: e.sources?.[0]?.url || null, retrievedAt: e.retrievedAt });
    sections.push({ id: "conflict", title: "Conflict, attacks and unrest", items: pick(["conflict", "attack", "unrest", "ceasefire"], 8).map(item) });
    sections.push({ id: "disasters", title: "Disasters and severe weather", items: pick(["disaster", "weather", "humanitarian"], 8).map(item) });
    sections.push({ id: "infrastructure", title: "Airports and infrastructure", items: pick(["infrastructure"], 5).map(item) });
    sections.push({ id: "diplomacy", title: "Diplomacy", items: pick(["diplomacy"], 4).map(item) });
    const down = Object.values(ev.providers).filter((p) => p.configured && p.state !== "operational").map((p) => `${p.name}: ${p.state}${p.lastError ? ` (${p.lastError})` : ""}`);
    if (down.length) problems.push(...down.map((d) => `Events source ${d}`));
  }
  const watch = records.list({ op: "sentinel", kind: "watchlist" });
  if (watch.length) sections.push({ id: "watchlists", title: "Sentinel watchlists", items: watch.map((w) => ({ text: `${w.title}: ${(w.data.lastMatches || []).length} matching reports`, when: w.data.lastCheckAt, nature: "recent", source: "JARVIS watchlist (from the events above)", detail: (w.data.lastMatches || []).slice(0, 3).map((m) => m.title).join(" · ") })) });

  const home = await safe("Weather", () => getWeather({ lat: s.home.lat, lon: s.home.lon, place: s.home.place, units: s.units }));
  if (home) sections.push({ id: "weather", title: `Weather · ${s.home.place}`, items: [{ text: `Now ${home.current.temp}${home.unitTemp}, ${home.current.summary}; today ${home.today.low}–${home.today.high}${home.unitTemp}, rain ${home.today.rain ?? "?"}%`, nature: "live / forecast", source: "Open-Meteo", when: home.fetchedAt, retrievedAt: home.fetchedAt }] });

  const trips = records.list({ op: "wayfinder" }).filter((t) => !t.data.return || t.data.return >= at.slice(0, 10)).slice(0, 3);
  for (const t of trips) {
    const w = t.data.destination ? await safe(`Weather for ${t.title}`, () => getWeather({ lat: t.data.destination.lat, lon: t.data.destination.lon, place: t.data.destination.name, units: s.units })) : null;
    (sections.find((x) => x.id === "travel") || (sections.push({ id: "travel", title: "Travel plans", items: [] }), sections.at(-1))).items.push(
      { text: `${t.title}: ${t.data.depart || "dates not set"}${t.data.return ? ` → ${t.data.return}` : ""}`, nature: "user", source: "Your Wayfinder trip", when: t.updated_at },
      ...(w ? [{ text: `${t.data.destination.name.split(",")[0]} forecast: ${w.daily.slice(0, 3).map((d) => `${d.date.slice(5)} ${d.summary} ${d.low}–${d.high}${w.unitTemp}`).join("; ")}`, nature: "forecast", source: "Open-Meteo", when: w.fetchedAt, retrievedAt: w.fetchedAt }] : []),
      ...(t.data.research?.advice?.url ? [{ text: `FCDO travel advice (updated ${String(t.data.research.advice.updatedAt || "").slice(0, 10)})`, nature: "recent", source: "UK FCDO", url: t.data.research.advice.url, when: t.data.research.advice.updatedAt }] : []));
  }

  const fs_ = flights.status();
  sections.push({ id: "aviation", title: "Public aviation", items: [
    { text: `Flight data: ADSB.lol ${fs_.providers.adsb.state}${fs_.providers.adsb.remaining != null ? ` (${fs_.providers.adsb.remaining} requests left today)` : ""}; OpenSky ${fs_.providers.opensky.state}`, nature: "live", source: "JARVIS flight service", when: at },
    ...((ev?.items || []).filter((e) => e.provider === "faa").slice(0, 3).map((e) => ({ text: e.title, nature: "recent", source: "FAA", url: e.sources?.[0]?.url, when: e.publishedAt }))),
  ] });

  const sw = await safe("Space weather", () => orbit.spaceWeather());
  if (sw) sections.push({ id: "space", title: "Space weather", items: [
    ...(sw.kp ? [{ text: `Planetary K index ${sw.kp.latest} (${sw.kp.storm})`, nature: "recent", source: "NOAA SWPC", url: sw.kp.url, when: sw.kp.time, retrievedAt: sw.kp.fetchedAt }] : []),
    ...(sw.flare ? [{ text: `X-ray flux now ${sw.flare.currentClass}${sw.flare.latestFlare ? `; latest flare ${sw.flare.latestFlare.class} peaking ${sw.flare.latestFlare.peak}` : ""}`, nature: "recent", source: "NOAA SWPC (GOES)", url: sw.flare.url, when: sw.flare.latestFlare?.peak || sw.flare.fetchedAt, retrievedAt: sw.flare.fetchedAt }] : []),
    ...((sw.donki || []).slice(0, 3).map((d) => ({ text: `${d.type}: ${d.summary || "notification"}`.slice(0, 220), nature: "recent", source: "NASA DONKI", url: d.url, when: d.issued }))),
  ] });
  if (sw?.errors?.length) problems.push(...sw.errors);
  const iss = await safe("ISS", () => orbit.iss());
  const ln = await safe("Launches", () => orbit.launches(4));
  sections.push({ id: "orbit", title: "Satellites and launches", items: [
    ...(iss?.position ? [{ text: `ISS over ${iss.position.lat}°, ${iss.position.lon}° at ${iss.position.altKm} km (orbital elements ${iss.epochAgeHours} h old)`, nature: "calculated", source: "CelesTrak elements + SGP4", when: iss.position.at, retrievedAt: iss.fetchedAt }] : []),
    ...((ln?.items || []).map((l) => ({ text: `${l.name} — ${l.provider || "?"}, ${l.site || "?"}: ${l.net}${l.netPrecision && l.netPrecision !== "Second" && l.netPrecision !== "Minute" ? ` (precision: ${l.netPrecision})` : ""}, status ${l.statusName || l.status}`, nature: "scheduled", source: "Launch Library 2", when: l.net, retrievedAt: ln.fetchedAt }))),
  ] });

  const dossiers = records.list({ op: "blackbox", kind: "dossier", limit: 3 }).filter((d) => d.status === "ready");
  if (dossiers.length) sections.push({ id: "research", title: "Recent Blackbox research", items: dossiers.map((d) => ({ text: `${d.title}: ${String(d.data.executiveSummary || "").slice(0, 220)}`, nature: "historical", source: `Dossier (${(d.data.sources || []).length} sources)`, when: d.data.generatedAt || d.updated_at })) });

  let summary = null;
  if (withSummary) {
    try {
      const brain = await import("../../brain.js");
      if (brain.client) {
        const { z } = await import("zod");
        const r = await brain.structured("situation-report", z.object({ summary: z.string() }), `Write a 4–6 sentence executive summary of this situation report for ${s.profile?.title || "Sir"}. Use only the items below; don't add facts; say "reported" for unverified items.\n\n${sections.map((x) => `${x.title}:\n${x.items.map((i) => `- ${i.text} [${i.nature}; ${i.source}${i.verification ? `; ${i.verification}` : ""}]`).join("\n")}`).join("\n\n")}`, { effort: "low", maxTokens: 1500 });
        summary = r?.summary || null;
      }
    } catch (e) { problems.push(`Executive summary: ${e.message}`); }
  }
  const data = { compiledAt: at, summary, summaryNote: summary ? "Written by the JARVIS AI from the items in this report only." : null, sections: sections.filter((x) => x.items.length), problems };
  return records.create({ op: "report", kind: "situation_report", title: `Global Situation Report · ${new Date(at).toLocaleString("en-GB", { timeZone: s.timezone, day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}`, data });
}
