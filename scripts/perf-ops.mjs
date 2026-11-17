// Measures the Mission Control operations: satellite propagation + draw cost for a large group, memory while
// switching operations, and background requests while each operation is open. Stand-in providers (no load on the
// real services). Usage: node scripts/perf-ops.mjs [out.json]
import { execSync } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import { startMock } from "../test/mock-upstream.js";
import { startServer, sleep } from "../test/helpers.js";
let pw;
try { pw = await import("playwright"); } catch { pw = createRequire(execSync("npm root -g").toString().trim() + "/")("playwright"); }
const out = process.argv[2] || "";
const mock = await startMock(); mock.state.celestrakCount = 3000;
const srv = await startServer(mock, {}, 3993);
const base = srv.base.replace("127.0.0.1", "localhost");
const browser = await pw.chromium.launch({ args: ["--enable-unsafe-swiftshader", "--use-angle=swiftshader", "--ignore-gpu-blocklist", "--js-flags=--expose-gc"] });
const r = { at: new Date().toISOString() };
try {
  const P = await (await browser.newContext({ viewport: { width: 1600, height: 960 } })).newPage();
  const reqs = []; P.on("request", (q) => { const u = new URL(q.url()); if (u.pathname.startsWith("/api/")) reqs.push({ t: Date.now(), p: u.pathname }); });
  await P.goto(base, { waitUntil: "networkidle" });
  await P.fill("#authCode", "SETUP-1234"); await P.fill("#authPw", "correct horse battery"); await P.fill("#authPw2", "correct horse battery"); await P.click("#authSubmit");
  await P.waitForFunction(() => window.__jarvisBootReady, null, { timeout: 120000 }).catch(() => {});
  await P.locator(".boot2").click({ position: { x: 20, y: 20 } }).catch(() => {});
  await P.waitForSelector("#core"); await P.click("#mcBtn");
  await P.waitForFunction(() => document.documentElement.classList.contains("mc-active"), null, { timeout: 90000 });
  const heap = () => P.evaluate(() => { window.gc?.(); return +(performance.memory.usedJSHeapSize / 1e6).toFixed(1); });
  r.heapStartMb = await heap();
  // Orbit with 3,000 satellites (map shows up to 1,500): time one propagation + draw tick.
  await P.click('#mcNav [data-mc="op-orbit"]'); await P.waitForSelector("#orbGroup", { timeout: 30000 });
  await P.selectOption("#orbGroup", "starlink"); await P.waitForFunction(() => /3000 objects/.test(document.querySelector(".goc-op").textContent), null, { timeout: 60000 });
  await sleep(2500);
  r.orbit = await P.evaluate(async () => {
    const t = []; for (let i = 0; i < 10; i++) { const s = performance.now(); window.__jarvisGocRedraw(); t.push(performance.now() - s); await new Promise((x) => requestAnimationFrame(x)); }
    t.sort((a, b) => a - b); return { satellitesDrawn: window.__jarvisGoc.hits, medianDrawMs: +t[5].toFixed(1) };
  });
  // Propagation cost per 2-second tick: measured by timing the module's own tick through a long task observer.
  r.orbit.longTasks = await P.evaluate(() => new Promise((res) => { const l = []; const o = new PerformanceObserver((e) => e.getEntries().forEach((x) => l.push(Math.round(x.duration)))); o.observe({ type: "longtask" }); setTimeout(() => { o.disconnect(); res(l); }, 6500); }));
  // Idle requests per operation (60 s each).
  r.idlePerMinute = {};
  for (const op of ["op-orbit", "op-blackbox", "op-wayfinder", "op-sentinel"]) {
    await P.click(`#mcNav [data-mc="${op}"]`); await sleep(5000);
    const n0 = reqs.length; await sleep(60000);
    const by = {}; for (const x of reqs.slice(n0)) by[x.p] = (by[x.p] || 0) + 1;
    r.idlePerMinute[op] = { total: reqs.length - n0, byPath: by };
  }
  r.celestrakRequests = mock.log.celestrak || 0;
  // Switching operations 20 times: memory must not keep growing.
  const h0 = await heap();
  for (let i = 0; i < 5; i++) for (const op of ["op-orbit", "op-blackbox", "op-wayfinder", "op-sentinel"]) { await P.click(`#mcNav [data-mc="${op}"]`); await sleep(1200); }
  await P.click('#mcNav [data-mc="globalops"]'); await sleep(2000);
  r.heapAfterSwitchesMb = { before: h0, after: await heap() };
  r.leafletMaps = await P.evaluate(() => document.querySelectorAll(".leaflet-container").length);
  const perf = await (await P.request.get(`${base}/api/performance`)).json();
  r.serverRssMb = perf.rssMb;
} finally { await browser.close(); await srv.stop(); mock.server.close(); }
console.log(JSON.stringify(r, null, 2));
if (out) fs.writeFileSync(out, JSON.stringify(r, null, 2));
