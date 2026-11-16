#!/usr/bin/env node
// Stand-in for the Tailscale CLI used by the E2E test (status / serve).
const fs = require("node:fs");
const path = require("node:path");
const stateFile = path.join(require("node:os").tmpdir(), "jarvis-fake-tailscale.json");
const st = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, "utf8")) : { serving: null };
const a = process.argv.slice(2);
if (a[0] === "status") { console.log(JSON.stringify({ BackendState: "Running", Self: { DNSName: "dylans-laptop.tail1234.ts.net." } })); process.exit(0); }
if (a[0] === "serve" && a[1] === "status") { console.log(JSON.stringify(st.serving ? { TCP: { 443: { HTTPS: true } }, Web: { "dylans-laptop.tail1234.ts.net:443": { Handlers: { "/": { Proxy: st.serving } } } } } : {})); process.exit(0); }
if (a[0] === "serve" && a.includes("off")) { st.serving = null; fs.writeFileSync(stateFile, JSON.stringify(st)); console.log("Serve off"); process.exit(0); }
if (a[0] === "serve" && a.includes("--bg")) { st.serving = a.at(-1); fs.writeFileSync(stateFile, JSON.stringify(st)); console.log(`Available within your tailnet:\n\nhttps://dylans-laptop.tail1234.ts.net/\n|-- proxy ${a.at(-1)}\n\nServe started and running in the background.`); process.exit(0); }
process.exit(1);
