// Drives the real UI in Chromium (laptop-sized and iPhone-sized) against stand-in upstreams.
// Covers: first-run setup, conversation + speaking core, QR pairing of the phone, cross-device
// conversation sync, every screen, offline queueing and reconnection. Saves screenshots.
// Usage: node test/ui-check.js [outDir]
import { execSync } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { startMock } from "./mock-upstream.js";
import { startServer, sleep } from "./helpers.js";

let pw;
try { pw = await import("playwright"); } catch { pw = createRequire(execSync("npm root -g").toString().trim() + "/")("playwright"); }
const { chromium, devices } = pw;

const out = path.resolve(process.argv[2] || "docs/screenshots");
fs.mkdirSync(out, { recursive: true });
const mock = await startMock();
const srv = await startServer(mock, { JARVIS_DEMO_FINANCE: "true" }, 3988);
const base = srv.base.replace("127.0.0.1", "localhost");
const results = [];
const check = (name, ok, detail = "") => { results.push({ name, ok: !!ok, detail }); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`); };

const browser = await chromium.launch({ args: ["--autoplay-policy=no-user-gesture-required", "--use-fake-ui-for-media-stream"] });
const errors = [];
const watch = (page, tag) => { page.on("pageerror", (e) => errors.push(`${tag}: ${e.message}`)); page.on("console", (m) => m.type() === "error" && !/Failed to load resource/.test(m.text()) && errors.push(`${tag}: ${m.text()}`)); };

try {
  // ---------------- Laptop
  const lap = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  const L = await lap.newPage(); watch(L, "laptop");
  await L.goto(base, { waitUntil: "networkidle" });
  check("first run shows setup", await L.isVisible("#codeField"));
  await L.fill("#authCode", "SETUP-1234"); await L.fill("#authPw", "correct horse battery"); await L.fill("#authPw2", "correct horse battery"); await L.fill("#authDevice", "Windows laptop");
  await L.click("#authSubmit");
  await L.waitForSelector("#core", { timeout: 8000 });
  await L.request.post(`${base}/api/finance/demo`, { headers: { "x-jarvis": "1" } });
  await L.request.post(`${base}/api/tasks`, { headers: { "x-jarvis": "1" }, data: { title: "Call the accountant about VAT", due: new Date().toISOString().slice(0, 10), priority: 1 } });
  await L.request.post(`${base}/api/projects`, { headers: { "x-jarvis": "1" }, data: { title: "Website business", goal: "Launch a web design service", milestones: [{ title: "Validate", tasks: [{ title: "Interview 5 local businesses", priority: 1 }] }, { title: "Launch", tasks: [{ title: "Build portfolio site" }] }] } });
  await L.reload({ waitUntil: "networkidle" });
  await L.waitForSelector(".wx-days");
  check("home shows a real 7-day forecast panel", (await L.locator(".wx-day").count()) === 7);
  check("money panel shows TEST DATA label", await L.isVisible("text=TEST DATA"));
  await L.screenshot({ path: path.join(out, "laptop-home.png") });

  await L.fill("#say", "Hello JARVIS"); await L.press("#say", "Enter");
  await L.waitForFunction(() => document.querySelector("#coreLabel")?.textContent === "speaking", null, { timeout: 8000 });
  await sleep(450);
  const lvl = Number(await L.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--level")));
  check("core reacts to real audio level while speaking", lvl > 0.05, `level ${lvl.toFixed(2)}`);
  await L.screenshot({ path: path.join(out, "laptop-speaking.png") });
  await L.waitForFunction(() => document.querySelector("#coreLabel")?.textContent === "online", null, { timeout: 10000 });

  // ---------------- Pair the iPhone with the QR link
  await L.click('.rail [data-tab="settings"]');
  await L.click("#pair");
  await L.waitForSelector(".qr svg");
  check("pairing QR code is shown", await L.isVisible(".qr svg"));
  await L.screenshot({ path: path.join(out, "laptop-pairing.png") });
  const pairUrl = await L.evaluate(async () => (await (await fetch("/api/pair/create", { method: "POST", headers: { "x-jarvis": "1" } })).json()).url);

  const phoneCtx = await browser.newContext({ ...devices["iPhone 13"] });
  const P = await phoneCtx.newPage(); watch(P, "iphone");
  await P.goto(pairUrl.replace("127.0.0.1", "localhost"), { waitUntil: "networkidle" });
  check("QR link opens the pairing screen", await P.isVisible("#pairField"));
  await P.fill("#authDevice", "Dylan's iPhone");
  await P.click("#authSubmit");
  await P.waitForSelector("#core", { timeout: 8000 });
  check("iPhone paired into the same account", true);
  await P.screenshot({ path: path.join(out, "iphone-home.png") });

  // Conversation continues on the phone
  await P.click('.dock [data-tab="talk"]');
  await P.waitForSelector(".msg.assistant");
  check("phone sees the conversation started on the laptop", (await P.locator(".msg.user", { hasText: "Hello JARVIS" }).count()) === 1);
  await P.fill("#t", "Remind me to call my mum at six"); await P.press("#t", "Enter");
  await P.waitForSelector(".msg.assistant >> text=call your mum", { timeout: 8000 });
  await P.screenshot({ path: path.join(out, "iphone-talk.png") });
  await L.click('.rail [data-tab="talk"]');
  await L.waitForSelector(".msg.user >> text=Remind me to call my mum at six", { timeout: 8000 });
  check("laptop sees the message sent from the phone", true);

  for (const tab of ["agenda", "money"]) {
    await P.click(`.dock [data-tab="${tab}"]`); await sleep(700);
    await P.screenshot({ path: path.join(out, `iphone-${tab}.png`), fullPage: tab === "money" });
  }
  await P.click('.dock [data-tab="agenda"]');
  check("phone agenda shows the reminder created by voice", await P.waitForSelector("#rems >> text=Call your mum", { timeout: 5000 }).then(() => true, () => false));
  const overflow = await P.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
  check("iPhone layout has no horizontal scrolling", !overflow);

  for (const tab of ["agenda", "money", "projects", "intel", "memory", "settings"]) {
    await L.click(`.rail [data-tab="${tab}"]`); await sleep(700);
    await L.screenshot({ path: path.join(out, `laptop-${tab}.png`), fullPage: tab === "money" });
  }
  await L.click('[data-s="health"]'); await sleep(500);
  await L.screenshot({ path: path.join(out, "laptop-health.png") });

  // ---------------- Offline → reconnect
  await phoneCtx.setOffline(true);
  await P.click('.dock [data-tab="agenda"]').catch(() => {});
  await sleep(300);
  await P.evaluate(() => { const i = document.querySelector("#taskIn"); i.value = "Buy milk (added offline)"; document.querySelector("#taskForm").requestSubmit(); });
  await sleep(400);
  const queued = await P.evaluate(() => JSON.parse(localStorage.getItem("jarvis.outbox") || "[]").length);
  check("offline task is queued on the phone", queued === 1);
  await phoneCtx.setOffline(false);
  await P.evaluate(() => dispatchEvent(new Event("online")));
  const synced = await (async () => { for (let i = 0; i < 40; i++) { const r = await L.request.get(`${base}/api/tasks`); const t = await r.json(); if (t.some((x) => x.title === "Buy milk (added offline)")) return t.filter((x) => x.title === "Buy milk (added offline)").length; await sleep(250); } return 0; })();
  check("after reconnecting, the queued task syncs exactly once", synced === 1, `${synced} copies`);
} catch (e) {
  check("ui run completed", false, e.message);
} finally {
  await browser.close(); await srv.stop(); mock.server.close();
}
check("no JavaScript errors in either device", errors.length === 0, errors.slice(0, 5).join(" | "));
fs.writeFileSync(path.join(out, "ui-results.json"), JSON.stringify(results, null, 2));
process.exit(results.every((r) => r.ok) ? 0 : 1);
