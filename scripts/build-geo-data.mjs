// Builds the offline geography data used by Global Operations from open datasets (run once; outputs are committed):
//   public/vendor/countries-110m.geojson  country boundaries (Natural Earth 1:110m via world-atlas, public domain)
//   server/data/countries.json            names, aliases, demonyms, regions and centres (world-countries, ODbL)
// Usage: node scripts/build-geo-data.mjs <node_modules dir containing world-atlas, topojson-client, world-countries>
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const nm = path.resolve(process.argv[2] || "node_modules");
const req = createRequire(path.join(nm, "noop.js"));
const topo = req("topojson-client");
const atlas = JSON.parse(fs.readFileSync(path.join(nm, "world-atlas/countries-110m.json"), "utf8"));
const wc = JSON.parse(fs.readFileSync(path.join(nm, "world-countries/countries.json"), "utf8"));
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");

// Boundaries: rounded to 0.01° (about 1 km) — plenty for a 1:110m map and a third of the size.
const fc = topo.feature(atlas, atlas.objects.countries);
const round = (c) => (typeof c[0] === "number" ? [Math.round(c[0] * 100) / 100, Math.round(c[1] * 100) / 100] : c.map(round));
const out = { type: "FeatureCollection", features: fc.features.map((f) => ({ type: "Feature", id: f.id, properties: { name: f.properties.name }, geometry: { type: f.geometry.type, coordinates: round(f.geometry.coordinates) } })) };
fs.mkdirSync(path.join(root, "public/vendor"), { recursive: true });
fs.writeFileSync(path.join(root, "public/vendor/countries-110m.geojson"), JSON.stringify(out));

// Country gazetteer for placing news reports on the map (country level only) and for region filters.
const extra = { USA: ["US", "U.S.", "America", "Washington"], GBR: ["UK", "U.K.", "Britain", "London"], RUS: ["Moscow", "Kremlin"], UKR: ["Kyiv", "Kiev"], PSE: ["Gaza", "West Bank"], ISR: ["Jerusalem", "Tel Aviv"],
  COD: ["DR Congo", "DRC", "Democratic Republic of the Congo"], COG: ["Republic of the Congo", "Congo-Brazzaville"], PRK: ["North Korea", "Pyongyang"], KOR: ["South Korea", "Seoul"], CHN: ["Beijing"], IRN: ["Tehran"], SYR: ["Damascus"],
  MMR: ["Burma", "Myanmar"], CIV: ["Ivory Coast", "Côte d'Ivoire"], TWN: ["Taipei"], SDN: ["Khartoum", "Darfur"], SSD: ["South Sudan"], YEM: ["Houthi", "Houthis", "Sanaa"], LBN: ["Beirut", "Hezbollah"], AFG: ["Kabul", "Taliban"], IRQ: ["Baghdad"], TUR: ["Turkey", "Türkiye", "Ankara"] };
const countries = wc.filter((c) => c.latlng?.length === 2).map((c) => {
  const names = new Set([c.name.common, c.name.official, ...(extra[c.cca3] || [])]);
  const dem = c.demonyms?.eng?.m;
  return { c3: c.cca3, n3: c.ccn3 || "", name: c.name.common, aliases: [...names].filter((x) => x && x.length > 2 || ["UK", "US"].includes(x)), demonym: dem && dem.length > 3 ? dem : "", region: c.region || "", subregion: c.subregion || "", lat: c.latlng[0], lon: c.latlng[1], area: Math.round(c.area || 0) };
});
fs.mkdirSync(path.join(root, "server/data"), { recursive: true });
fs.writeFileSync(path.join(root, "server/data/countries.json"), JSON.stringify(countries));
console.log(`boundaries: ${out.features.length} countries, ${(JSON.stringify(out).length / 1024).toFixed(0)} KB · gazetteer: ${countries.length} countries`);
