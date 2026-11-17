// Measures Global Operations: map draw cost with many aircraft, memory over a long session, background polling,
// and Chromium CPU. Uses the deterministic stand-in providers (no load on the real services); the aircraft count is
// set with GOC_AIRCRAFT. Software WebGL/canvas in this container — compare runs, don't read as laptop numbers.
// Usage: GOC_AIRCRAFT=12000 GOC_MINUTES=4 node scripts/perf-goc.mjs [out.json]
import { execSync } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import { startMock } from "../test/mock-upstream.js";
import { startServer, sleep } from "../test/helpers.js";

let pw;
try { pw = await import("playwright"); } catch { pw = createRequire(execSync("npm root -g").toString().trim() + "/")("playwright"); }
const out = process.argv[2] || "";
const mock = await startMock();
mock.state.openskyCount = +(process.env.GOC_AIRCRAFT || 12000);
mock.state.adsbRemaining = 100000;
const srv = await startServer(mock, {}, 3994);
const base = srv.base.replace("127.0.0.1", "localhost");
const browser = await pw.chromium.launch({ args: ["--enable-unsafe-swiftshader", "--use-angle=swiftshader", "--ignore-gpu-blocklist", "--js-flags=--expose-gc"] });
const chromeCpu = () => { let t = 0; for (const pid of fs.readdirSync("/proc").filter((p) => /^\d+$/.test(p))) { try { if (!/chrom/i.test(fs.readFileSync(`/proc/${pid}/cmdline`, "utf8"))) continue; const f = fs.readFileSync(`/proc/${pid}/stat`, "utf8").split(") ")[1].split(" "); t += +f[11] + +f[12]; } catch {} } return t / 100; };
const r = { at: new Date().toISOString(), aircraftInStandIn: mock.state.openskyCount };
try {
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 960 } });
  const P = await ctx.newPage();
  const reqs = [];
  P.on("request", (q) => { const u = new URL(q.url()); if (u.origin === new URL(base).origin && u.pathname.startsWith("/api/")) reqs.push({ t: Date.now(), p: u.pathname }); });
  await P.goto(base, { waitUntil: "networkidle" });
  await P.fill("#authCode", "SETUP-1234"); await P.fill("#authPw", "correct horse battery"); await P.fill("#authPw2", "correct horse battery");
  await P.click("#authSubmit");
  await P.waitForSelector(".boot2", { timeout: 25000 }).catch(() => {});
  await P.waitForFunction(() => window.__jarvisBootReady, null, { timeout: 120000 }).catch(() => {});
  await P.locator(".boot2").click({ position: { x: 20, y: 20 } }).catch(() => {});
  await P.waitForSelector("#core", { timeout: 20000 });
  await sleep(1500);
  const heap = () => P.evaluate(() => { window.gc?.(); return +(performance.memory.usedJSHeapSize / 1e6).toFixed(1); });
  r.heapBeforeMb = await heap();
  const t0 = Date.now();
  await P.click("#mcBtn");
  await P.waitForFunction(() => document.documentElement.classList.contains("mc-active"), null, { timeout: 90000 });
  r.activationMs = Date.now() - t0;
  await P.waitForFunction(() => (window.__jarvisGoc?.aircraft || 0) > 0, null, { timeout: 30000 });
  // Draw cost: average of 20 redraws at each view.
  const drawCost = (label) => P.evaluate(async (label) => {
    const times = [];
    for (let i = 0; i < 20; i++) { const t = performance.now(); window.__jarvisGocRedraw(); times.push(+(performance.now() - t).toFixed(2)); await new Promise((r) => requestAnimationFrame(r)); }
    times.sort((a, b) => a - b);
    return { label, aircraftLoaded: window.__jarvisGoc.aircraft, drawn: window.__jarvisGoc.hits, zoom: window.__jarvisGoc.zoom, medianDrawMs: times[10], maxDrawMs: times[19] };
  }, label);
  const view = async (region, label) => { await P.selectOption("#gocRegion", region); await sleep(2500); await P.waitForFunction(() => !!window.__jarvisGoc, null); return drawCost(label); };
  r.draw = [await view("world", "worldwide (clustered)"), await view("europe", "Europe (individual aircraft)"), await view("northamerica", "North America"), await view("cyprus", "Cyprus")];
  // Pan smoothness: frames during a 3-second drag across Europe.
  await P.selectOption("#gocRegion", "europe"); await sleep(2500);
  const box = await P.locator(".goc-map").boundingBox();
  const fpsP = P.evaluate(() => new Promise((res) => { let n = 0; const end = performance.now() + 3000; const f = (t) => { n++; if (t < end) requestAnimationFrame(f); else res(n / 3); }; requestAnimationFrame(f); }));
  await P.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await P.mouse.down();
  for (let i = 0; i < 30; i++) { await P.mouse.move(box.x + box.width / 2 - i * 8, box.y + box.height / 2 - i * 3); await sleep(90); }
  await P.mouse.up();
  r.panFps = +(await fpsP).toFixed(1);
  // Long-running session: N minutes on the worldwide view with flights polling; heap, requests and CPU.
  await P.selectOption("#gocRegion", "world"); await sleep(2000);
  const minutes = +(process.env.GOC_MINUTES || 4);
  const c0 = chromeCpu(), q0 = reqs.length, h = [];
  for (let m = 0; m < minutes * 2; m++) { await sleep(30_000); h.push(await heap()); }
  r.longRun = { minutes, heapMbEvery30s: h, chromeCpuPct: +(((chromeCpu() - c0) / (minutes * 60)) * 100).toFixed(1), apiRequestsPerMinute: +((reqs.length - q0) / minutes).toFixed(1),
    byPath: Object.entries(reqs.slice(q0).reduce((a, x) => ((a[x.p] = (a[x.p] || 0) + 1), a), {})).sort((a, b) => b[1] - a[1]) };
  r.providerRequests = { opensky: mock.log.opensky.length, adsb: mock.log.adsb.length, gdelt: mock.log.gdelt.length };
  // Hidden window: polling should pause.
  const o0 = mock.log.opensky.length + mock.log.adsb.length, q1 = reqs.length;
  await P.evaluate(() => { Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true }); document.dispatchEvent(new Event("visibilitychange")); });
  await sleep(90_000);
  r.hidden90s = { apiRequests: reqs.length - q1, providerRequests: mock.log.opensky.length + mock.log.adsb.length - o0 };
  // Flights off: what remains.
  await P.evaluate(() => { Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true }); });
  await P.uncheck('[data-ov="flights"]').catch(async () => { await P.click("#gocLayersBtn"); await P.uncheck('[data-ov="flights"]'); });
  const q2 = reqs.length, c2 = chromeCpu();
  await sleep(60_000);
  r.flightsOff60s = { apiRequests: reqs.length - q2, chromeCpuPct: +(((chromeCpu() - c2) / 60) * 100).toFixed(1) };
  const perf = await (await P.request.get(`${base}/api/performance`)).json();
  r.server = { rssMb: perf.rssMb, eventLoopLagMs: perf.lagMs };
  await P.click("#mcBtn"); await P.waitForSelector("#mcView", { state: "detached", timeout: 30000 });
  await sleep(2000);
  r.heapAfterExitMb = await heap();
  r.leafletMapsAlive = await P.evaluate(() => document.querySelectorAll(".leaflet-container").length);
} finally { await browser.close(); await srv.stop(); mock.server.close(); }
console.log(JSON.stringify(r, null, 2));
if (out) fs.writeFileSync(out, JSON.stringify(r, null, 2));
