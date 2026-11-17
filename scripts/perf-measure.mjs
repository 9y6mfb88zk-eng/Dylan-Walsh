// Measures the real cost of the command centre and the main API calls, so performance claims are backed by numbers.
// Runs the real server against the stand-in upstreams and drives Chromium (software WebGL — slower than a real GPU,
// so absolute numbers are pessimistic; compare before/after on the same machine).
// Usage: node scripts/perf-measure.mjs [out.json]
import { execSync } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import { startMock } from "../test/mock-upstream.js";
import { startServer, sleep } from "../test/helpers.js";

let pw;
try { pw = await import("playwright"); } catch { pw = createRequire(execSync("npm root -g").toString().trim() + "/")("playwright"); }
const out = process.argv[2] || "";
const mock = await startMock();
const t0 = performance.now();
const srv = await startServer(mock, { JARVIS_DEMO_FINANCE: "true" }, 3991);
const serverStartMs = Math.round(performance.now() - t0);
const base = srv.base.replace("127.0.0.1", "localhost");
const browser = await pw.chromium.launch({ args: ["--enable-unsafe-swiftshader", "--use-angle=swiftshader", "--ignore-gpu-blocklist"] });
const r = { at: new Date().toISOString(), serverStartMs };
// CPU seconds used by all of Chromium's processes (renderer + GPU process do the 3D work).
const chromeCpu = () => {
  let ticks = 0;
  for (const pid of fs.readdirSync("/proc").filter((p) => /^\d+$/.test(p))) {
    try { const cmd = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8"); if (!/chrom/i.test(cmd)) continue; const f = fs.readFileSync(`/proc/${pid}/stat`, "utf8").split(") ")[1].split(" "); ticks += +f[11] + +f[12]; } catch {}
  }
  return ticks / 100;
};
try {
  const ctx = await browser.newContext({ viewport: { width: +(process.env.PERF_W || 1600), height: +(process.env.PERF_H || 960) } });
  r.viewport = `${process.env.PERF_W || 1600}x${process.env.PERF_H || 960}`;
  const P = await ctx.newPage();
  await P.goto(base, { waitUntil: "networkidle" });
  await P.fill("#authCode", "SETUP-1234"); await P.fill("#authPw", "correct horse battery"); await P.fill("#authPw2", "correct horse battery");
  await P.click("#authSubmit");
  await P.waitForSelector("#core");
  await P.request.post(`${base}/api/finance/demo`, { headers: { "x-jarvis": "1" } });
  if (process.env.PERF_QUALITY) await P.request.patch(`${base}/api/settings`, { headers: { "x-jarvis": "1" }, data: { appearance: { quality: process.env.PERF_QUALITY } } });
  r.quality = process.env.PERF_QUALITY || "auto";
  // Cold load of the command centre (navigation start → 3D core drawn and the home data shown).
  const t1 = performance.now();
  await P.reload({ waitUntil: "load" });
  await P.waitForSelector(".wx-days", { timeout: 20000 });
  r.homeLoadMs = Math.round(performance.now() - t1);
  const frames = () => P.evaluate(() => new Promise((res) => { let n = 0; const end = performance.now() + 5000; const f = (t) => { n++; if (t < end) requestAnimationFrame(f); else res(n / 5); }; requestAnimationFrame(f); }));
  const cpuOver = async (sec) => { const c = chromeCpu(); await sleep(sec * 1000); return +((chromeCpu() - c) / sec * 100).toFixed(1); };
  const coreFps = () => P.evaluate(() => window.__jarvisCore?.fps ?? null);
  // Active: pointer moving (parallax) — full rate expected.
  const moving = (async () => { for (let i = 0; i < 80; i++) { await P.mouse.move(400 + (i % 10) * 50, 300 + (i % 7) * 30); await sleep(100); } })();
  await sleep(1500); r.active = { chromeCpuPct: await cpuOver(5), coreFps: await coreFps() }; await moving;
  // Idle: on screen, nothing happening for 17 s — the most common state for an always-open assistant.
  await sleep(17_000);
  r.idle = { chromeCpuPct: await cpuOver(10), coreFps: await coreFps(), idleClass: await P.evaluate(() => document.documentElement.classList.contains("idle")) };
  // Background: JARVIS visible but you're working in another window.
  await P.evaluate(() => dispatchEvent(new Event("blur")));
  await sleep(5000);
  r.background = { chromeCpuPct: await cpuOver(10), coreFps: await coreFps() };
  await P.evaluate(() => dispatchEvent(new Event("focus")));
  r.jsHeapMb = await P.evaluate(() => performance.memory ? +(performance.memory.usedJSHeapSize / 1e6).toFixed(1) : null);
  // Section switching 20× and back home: heap must not keep growing (WebGL contexts and listeners disposed).
  for (let i = 0; i < 10; i++) { await P.click('[data-tab="tasks"]'); await sleep(300); await P.click('[data-tab="home"]'); await P.waitForSelector("#core"); await sleep(500); }
  await P.evaluate(() => window.gc?.());
  r.jsHeapMbAfterNav = await P.evaluate(() => performance.memory ? +(performance.memory.usedJSHeapSize / 1e6).toFixed(1) : null);
  r.webglContextsAlive = await P.evaluate(() => window.__jarvisCore?.alive ?? null);
  r.coreTier = await P.evaluate(() => document.querySelector("#core")?.dataset.tier + " → " + (window.__jarvisCore?.tier ?? "?"));
  // Idle network traffic on the Command Centre: what the app requests on its own, per minute.
  await P.click('[data-tab="home"]').catch(() => {}); await P.waitForSelector("#core"); await sleep(3000);
  const reqs = [];
  const onReq = (q) => { const u = new URL(q.url()); if (u.origin === new URL(base).origin) reqs.push(u.pathname); };
  P.on("request", onReq);
  const idleSec = +(process.env.PERF_IDLE_SEC || 60);
  await sleep(idleSec * 1000);
  P.off("request", onReq);
  const byPath = {}; for (const x of reqs) byPath[x] = (byPath[x] || 0) + 1;
  r.idleRequests = { perMinute: +((reqs.length * 60) / idleSec).toFixed(1), seconds: idleSec, byPath };
  // Startup in a fresh window (new launch): sign-in state kept, time until the Command Centre is usable.
  const fresh = await browser.newContext({ viewport: { width: 1600, height: 960 }, storageState: await ctx.storageState() });
  const F = await fresh.newPage();
  const ts = performance.now();
  await F.goto(base);
  await F.waitForFunction(() => window.__jarvisBootReady || (document.querySelector(".wx-days") && !document.querySelector(".boot")), null, { timeout: 60000, polling: 50 }).catch(() => {});
  r.startup = { usableMs: Math.round(performance.now() - ts), checks: await F.evaluate(() => (window.__jarvisBoot || []).map((x) => `${x.label}:${x.ok === false ? "bad" : x.warn ? "warn" : "ok"}:${x.ms ?? "?"}ms`)) };
  await fresh.close();
  // API latency (median of 15).
  const lat = async (path) => { const a = []; for (let i = 0; i < 15; i++) { const s = performance.now(); await P.request.get(`${base}${path}`); a.push(performance.now() - s); } a.sort((x, y) => x - y); return Math.round(a[7]); };
  r.api = { home: await lat("/api/home"), diagnostics: await lat("/api/diagnostics"), tasks: await lat("/api/tasks"), memoriesProfile: await lat("/api/memories/profile"), performance: await lat("/api/performance") };
  const perf = await (await P.request.get(`${base}/api/performance`)).json();
  r.server = { eventLoopLagMs: perf.lagMs, dbMs: perf.dbMs, rssMb: perf.rssMb };
} finally { await browser.close(); await srv.stop(); mock.server.close(); }
console.log(JSON.stringify(r, null, 2));
if (out) fs.writeFileSync(out, JSON.stringify(r, null, 2));
