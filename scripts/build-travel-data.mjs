// Builds the offline travel data used by Operation Wayfinder and Blackbox (run once; outputs are committed):
//   server/data/airports.json  airports with scheduled service, plus large airports (OurAirports, public domain)
//   server/data/airlines.json  active airlines: IATA ↔ ICAO codes and names (OpenFlights data, ODbL)
//   server/data/countries.json gains capital, currencies, languages, calling code and driving side (world-countries, ODbL)
// Usage: node scripts/build-travel-data.mjs <airports.csv> <airlines.dat> <node_modules dir with world-countries>
import fs from "node:fs";
import path from "node:path";

const [airportsCsv, airlinesDat, nm] = process.argv.slice(2);
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
function csvRows(text) {
  const rows = []; let row = [], f = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c; }
    else if (c === '"') q = true;
    else if (c === ",") { row.push(f); f = ""; }
    else if (c === "\n") { row.push(f); rows.push(row); row = []; f = ""; }
    else if (c !== "\r") f += c;
  }
  if (f || row.length) { row.push(f); rows.push(row); }
  return rows;
}
const [head, ...rows] = csvRows(fs.readFileSync(airportsCsv, "utf8"));
const ix = Object.fromEntries(head.map((h, i) => [h, i]));
const airports = rows.filter((r) => r.length > 10 && (r[ix.type] === "large_airport" || (r[ix.type] === "medium_airport" && r[ix.scheduled_service] === "yes")))
  .map((r) => ({ icao: r[ix.icao_code] || r[ix.gps_code] || r[ix.ident], iata: r[ix.iata_code] || "", name: r[ix.name], city: r[ix.municipality] || "", country: r[ix.iso_country], type: r[ix.type] === "large_airport" ? "large" : "medium",
    lat: +(+r[ix.latitude_deg]).toFixed(4), lon: +(+r[ix.longitude_deg]).toFixed(4), elevFt: r[ix.elevation_ft] ? +r[ix.elevation_ft] : null, wiki: r[ix.wikipedia_link] || "" }));
fs.writeFileSync(path.join(root, "server/data/airports.json"), JSON.stringify(airports));

// airlines.dat: ID, Name, Alias, IATA, ICAO, Callsign, Country, Active
const airlines = csvRows(fs.readFileSync(airlinesDat, "utf8")).filter((r) => r[7] === "Y" && /^[A-Z0-9]{2}$/.test(r[3] || "") && /^[A-Z]{3}$/.test(r[4] || ""))
  .map((r) => ({ iata: r[3], icao: r[4], name: r[1], callsign: r[5] === "\\N" ? "" : r[5], country: r[6] }));
fs.writeFileSync(path.join(root, "server/data/airlines.json"), JSON.stringify(airlines));

// Country facts for destination research.
const wc = JSON.parse(fs.readFileSync(path.join(nm, "world-countries/countries.json"), "utf8"));
const byC3 = Object.fromEntries(wc.map((c) => [c.cca3, c]));
const countriesFile = path.join(root, "server/data/countries.json");
const countries = JSON.parse(fs.readFileSync(countriesFile, "utf8")).map((c) => {
  const w = byC3[c.c3] || {};
  return { ...c, c2: w.cca2 || "", capital: (w.capital || [])[0] || "", currencies: Object.entries(w.currencies || {}).map(([code, v]) => `${v.name} (${code})`),
    languages: Object.values(w.languages || {}), calling: w.idd?.root ? `${w.idd.root}${(w.idd.suffixes || []).length === 1 ? w.idd.suffixes[0] : ""}` : "", landlocked: !!w.landlocked };
});
fs.writeFileSync(countriesFile, JSON.stringify(countries));
console.log(`airports: ${airports.length} (${(fs.statSync(path.join(root, "server/data/airports.json")).size / 1024).toFixed(0)} KB) · airlines: ${airlines.length} · countries enriched: ${countries.length}`);
