// Before/after measurements for the 6.7 refinement. Usage: node scripts/perf-transitions.mjs <repo root> <port> <label>
// DOM-only probes (no app-internal marks) so the same script measures 6.6 and 6.7.
import { execSync } from "node:child_process";
import { createRequire } from "node:module";
const [ROOT, PORT, LABEL] = process.argv.slice(2);
const { startMock } = await import(`${ROOT}/test/mock-upstream.js`);
const { startServer, sleep } = await import(`${ROOT}/test/helpers.js`);
const pw = createRequire(execSync("npm root -g").toString().trim() + "/")("playwright");
const mock = await startMock(); const srv = await startServer(mock, {}, +PORT);
const browser = await pw.chromium.launch({ args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist", "--js-flags=--expose-gc", "--enable-precise-memory-info"] });
const R = { label: LABEL, viewport: "1536x864", enter: [], exits: {}, home: [], memory: [] };
const med = (a) => { const s = a.filter((x) => x != null).sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : null; };
try {
  const ctx = await browser.newContext({ viewport: { width: 1536, height: 864 } });
  await ctx.addInitScript(() => { window.__gl = 0; const g = HTMLCanvasElement.prototype.getContext; HTMLCanvasElement.prototype.getContext = function (t, o) { if (/webgl/.test(t)) window.__gl++; return g.call(this, t, o); }; });
  const P = await ctx.newPage(); const errs = []; P.on("pageerror", (e) => errs.push(e.message));
  await P.goto(srv.base.replace("127.0.0.1", "localhost"), { waitUntil: "networkidle" });
  await P.fill("#authCode", "SETUP-1234"); await P.fill("#authPw", "correct horse battery"); await P.fill("#authPw2", "correct horse battery"); await P.click("#authSubmit");
  await P.waitForFunction(() => window.__jarvisBootReady, null, { timeout: 120000 }).catch(() => {});
  await P.locator(".boot2").click({ position: { x: 20, y: 20 } }).catch(() => {});
  await P.waitForSelector("#view canvas#core"); await sleep(2500);
  // In-page watcher: ms from t0 until the core is in the Command Centre, visible and has drawn a new frame.
  const watchHome = () => P.evaluate(() => { const w = window.__w = { t0: performance.now(), home: null }; const f0 = () => window.__jarvisCore?.frames ?? window.__jarvisCore?.fps ?? 0;
    const tick = () => { const c = document.querySelector("#view .core-stage canvas#core, #view canvas#core"); const v = document.querySelector("#view"); if (c && v && !v.hidden && c.getBoundingClientRect().width > 50 && !document.documentElement.classList.contains("mc-mode")) { w.home = performance.now() - w.t0; return; } if (performance.now() - w.t0 < 20000) requestAnimationFrame(tick); }; requestAnimationFrame(tick); });
  const enter = async () => {
    await P.evaluate(() => { window.__e = { t0: performance.now(), active: null }; const mo = new MutationObserver(() => { if (document.documentElement.classList.contains("mc-active") && window.__e.active == null) { window.__e.active = performance.now() - window.__e.t0; mo.disconnect(); } }); mo.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] }); document.querySelector("#mcBtn").click(); });
    const okE = await P.waitForFunction(() => window.__e.active != null, null, { timeout: 90000 }).then(() => true, () => false);
    if (!okE) { R.enterFailures = (R.enterFailures || 0) + 1; R.enterFailureState = await P.evaluate(() => ({ cls: document.documentElement.className, url: location.href, btn: !!document.querySelector("#mcBtn") })); return null; }
    const ms = await P.evaluate(() => Math.round(window.__e.active)); R.enter.push(ms); await sleep(5000); return ms;
  };
  const routes = {
    exitButton: () => P.evaluate(() => { window.__w.t0 = performance.now(); document.querySelector("#mcNav [data-mcexit]").click(); }),
    palette: async () => { await P.keyboard.press("Control+k"); await P.fill("#palInput", "Command Centre"); await sleep(200); await P.evaluate(() => { window.__w.t0 = performance.now(); }); await P.keyboard.press("Enter"); },
    browserBack: async () => { await P.evaluate(() => history.pushState({ tab: "tasks" }, "", "/?tab=tasks")); await P.evaluate(() => { window.__w.t0 = performance.now(); }); await P.goBack(); },
  };
  for (let round = 0; round < 2; round++) for (const [name, fn] of Object.entries(routes)) {
    if ((await enter()) == null) continue;
    await watchHome(); await fn();
    await P.waitForFunction(() => window.__w.home != null, null, { timeout: 30000 }).catch(() => {});
    (R.exits[name] ||= []).push(await P.evaluate(() => (window.__w.home == null ? null : Math.round(window.__w.home)))); await sleep(1500);
    if (!(await P.$("#view .core-stage"))) { await P.goto(srv.base.replace("127.0.0.1", "localhost") + "/?tab=home"); await P.waitForSelector("#view canvas#core"); await sleep(2000); }
  }
  // Command Centre: leave the home page and come back five times
  const gl0 = await P.evaluate(() => window.__gl);
  for (let i = 0; i < 5; i++) {
    await P.click('.sidebar [data-tab="tasks"]'); await sleep(800);
    await watchHome(); await P.evaluate(() => { window.__w.t0 = performance.now(); document.querySelector('.sidebar [data-tab="home"]').click(); });
    await P.waitForFunction(() => window.__w.home != null, null, { timeout: 30000 }).catch(() => {});
    R.home.push(await P.evaluate(() => (window.__w.home == null ? null : Math.round(window.__w.home)))); await sleep(800);
  }
  R.webglContextsFor5HomeVisits = (await P.evaluate(() => window.__gl)) - gl0;
  // Memory across Mission Control cycles (after GC)
  for (let i = 0; i < 6; i++) {
    if ((await enter()) == null) break;
    await P.evaluate(() => document.querySelector("#mcNav [data-mcexit]").click());
    await P.waitForFunction(() => !document.documentElement.classList.contains("mc-mode"), null, { timeout: 30000 }); await sleep(1500);
    R.memory.push(await P.evaluate(async () => { window.gc?.(); await new Promise((r) => setTimeout(r, 300)); window.gc?.(); return { heapMB: +(performance.memory.usedJSHeapSize / 1048576).toFixed(1), nodes: document.getElementsByTagName("*").length, cores: document.querySelectorAll("canvas#core").length, maps: document.querySelectorAll(".leaflet-container").length }; }));
  }
  R.totalWebglContexts = await P.evaluate(() => window.__gl);
  R.summary = { enterMedianMs: med(R.enter), exitMedianMs: Object.fromEntries(Object.entries(R.exits).map(([k, v]) => [k, med(v)])), homeReturnMedianMs: med(R.home), webglContextsFor5HomeVisits: R.webglContextsFor5HomeVisits, heapFirstLastMB: [R.memory[0]?.heapMB, R.memory.at(-1)?.heapMB], domNodesFirstLast: [R.memory[0]?.nodes, R.memory.at(-1)?.nodes] };
  R.errors = errs;
} finally { await browser.close(); await srv.stop(); mock.server?.close?.(); mock.close?.(); }
console.log(JSON.stringify(R));
process.exit(0);
