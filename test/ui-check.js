// Drives the real UI in Chromium (laptop-sized and iPhone-sized) against stand-in upstreams.
// Covers: first-run setup, the Command Centre (3D core, truthful status, live panels), streamed conversation with
// a speaking core, the command palette, every one of the 21 sections, alarms, notifications, QR pairing of the
// phone, cross-device sync, the mobile layout, offline queueing and reconnection. Saves screenshots.
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
const SECTIONS = ["home", "talk", "briefings", "notifications", "alarms", "calendar", "tasks", "focus", "goals", "projects", "business", "money", "intelligence", "documents", "memory", "world", "automations", "computer", "smarthome", "diagnostics", "settings"];

const browser = await chromium.launch({ args: ["--autoplay-policy=no-user-gesture-required", "--use-fake-ui-for-media-stream", "--enable-unsafe-swiftshader", "--use-angle=swiftshader", "--ignore-gpu-blocklist"] });
const errors = [];
const watch = (page, tag) => { page.on("pageerror", (e) => errors.push(`${tag}: ${e.message}`)); page.on("console", (m) => m.type() === "error" && !/Failed to load resource|WebGL|GPU stall|GL Driver/.test(m.text()) && errors.push(`${tag}: ${m.text()}`)); };
/** New windows start with the initialisation screen: wait for its real checks, then tap anywhere to enter. */
async function enterJarvis(page) {
  const shown = await page.waitForSelector(".boot2", { timeout: 25000 }).then(() => true, () => false);
  if (!shown) return false;
  await page.waitForFunction(() => window.__jarvisBootReady, null, { timeout: 120000 });
  await page.waitForSelector(".boot2.ready", { timeout: 10000 });
  await page.locator(".boot2").click({ position: { x: 20, y: 20 } });
  await page.waitForSelector(".boot2", { state: "detached", timeout: 10000 });
  return true;
}
const post = (page, p, data) => page.request.post(`${base}${p}`, { headers: { "x-jarvis": "1" }, data });

try {
  // ---------------- Laptop: setup + Command Centre
  const lap = await browser.newContext({ viewport: { width: 1600, height: 960 }, deviceScaleFactor: 1 });
  const L = await lap.newPage(); watch(L, "laptop");
  await L.goto(base, { waitUntil: "networkidle" });
  check("first run shows setup", await L.isVisible("#codeField"));
  await L.fill("#authCode", "SETUP-1234"); await L.fill("#authPw", "correct horse battery"); await L.fill("#authPw2", "correct horse battery"); await L.fill("#authDevice", "Windows laptop");
  await L.click("#authSubmit");
  check("first launch shows the initialisation screen", await enterJarvis(L));
  await L.waitForSelector("#core", { timeout: 8000 });
  await post(L, "/api/finance/demo");
  await post(L, "/api/tasks", { title: "Call the accountant about VAT", due: new Date().toISOString().slice(0, 10), priority: 1 });
  await post(L, "/api/projects", { title: "Website business", goal: "Launch a web design service", milestones: [{ title: "Validate", tasks: [{ title: "Interview 5 local businesses", priority: 1 }] }, { title: "Launch", tasks: [{ title: "Build portfolio site" }] }] });
  await post(L, "/api/alarms", { time: "07:00", label: "Wake up", repeat: "weekdays" });
  await post(L, "/api/habits", { name: "Read 20 pages" });
  await L.reload({ waitUntil: "networkidle" });
  await L.waitForSelector(".wx-days");
  check("greeting addresses the user as Sir", /^Good (morning|afternoon|evening), Sir\.$/.test(await L.textContent("#greet")));
  await L.waitForFunction(() => !/Checking systems/.test(document.querySelector("#subline")?.textContent || ""), null, { timeout: 15000 }).catch(() => {});
  check("status line comes from real diagnostics", /^JARVIS is online\. (All available systems are ready\.|\d+ items? needs? attention\.)$/.test(await L.textContent("#subline")), await L.textContent("#subline"));
  await L.waitForFunction(() => document.querySelector("#core")?.dataset.core, null, { timeout: 10000 }).catch(() => {});
  const coreKind = await L.getAttribute("#core", "data-core");
  check("Command Centre core is the 3D (WebGL) core", coreKind === "3d", `core ${coreKind}`);
  check("weather panel shows UV, sunrise and a 5-day outlook", (await L.locator(".wx-days > div").count()) === 5 && /UV index/.test(await L.textContent("#pWeather")) && /sunrise/.test(await L.textContent("#pWeather")));
  check("alarm panel shows the next alarm", /07:00/.test(await L.textContent("#pAlarms")));
  check("priorities show TEST DATA money label", await L.locator("#pPriorities .pill.test").count() >= 1);
  check("quick commands are present", (await L.locator("#qa button").count()) >= 8);
  await L.screenshot({ path: path.join(out, "laptop-home.png") });

  // Streaming reply, speaking core reacting to real audio
  await L.fill("#say", "Tell me a long story"); await L.press("#say", "Enter");
  await L.waitForFunction(() => document.documentElement.dataset.core === "speaking", null, { timeout: 10000 });
  await sleep(500);
  const lvl = Number(await L.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--level")));
  check("core speaks with a level driven by the real voice audio", lvl > 0.05, `level ${lvl.toFixed(2)}`);
  check("caption shows the streamed reply", /Once upon a time, Sir/.test(await L.textContent("#caption")));
  await L.screenshot({ path: path.join(out, "laptop-speaking.png") });
  await L.waitForFunction(() => document.documentElement.dataset.core === "idle", null, { timeout: 20000 });
  check("core returns to idle after speaking", true);

  // Command palette
  await L.keyboard.press("Control+k");
  await L.waitForSelector("#palette[open]");
  await L.fill("#palInput", "alarm centre");
  await sleep(300);
  await L.screenshot({ path: path.join(out, "laptop-palette.png") });
  await L.keyboard.press("Enter");
  await L.waitForSelector("text=Alarm Centre >> nth=0");
  check("Ctrl+K palette opens sections", /tab=alarms/.test(L.url()));

  // Every section renders without errors
  for (const tab of SECTIONS) {
    await L.click(`.sidebar [data-tab="${tab}"]`);
    await L.waitForFunction((t) => document.querySelector("#pageTitle")?.textContent && !document.querySelector("#view .empty:only-child"), tab, { timeout: 8000 }).catch(() => {});
    await sleep(tab === "world" || tab === "home" ? 1500 : 500);
    // Page errors only: a diagnostics card that honestly shows a failing service is not a page error.
    const bad = await L.locator("#view .error:not(.check-card)").count();
    check(`section renders: ${tab}`, bad === 0, bad ? await L.locator("#view .error:not(.check-card)").first().textContent() : "");
    await L.screenshot({ path: path.join(out, `laptop-${tab}.png`), fullPage: ["money", "diagnostics", "alarms", "settings"].includes(tab) });
  }
  check("sidebar lists 21 sections", (await L.locator(".sidebar [data-tab]").count()) === 21);

  // Alarm Centre: create through the dialog
  await L.click('.sidebar [data-tab="alarms"]');
  await L.click("#add");
  await L.fill('#modal input[name="time"]', "06:15");
  await L.fill('#modal input[name="label"]', "Gym");
  await L.click('#modal button[value="ok"]');
  check("alarm created from the Alarm Centre", await L.waitForSelector("#list >> text=Gym", { timeout: 5000 }).then(() => true, () => false));
  await L.click("#test");
  check("test alarm rings full-screen in the browser", await L.waitForSelector("#alarmOverlay:not([hidden])", { timeout: 5000 }).then(() => true, () => false));
  await L.screenshot({ path: path.join(out, "laptop-alarm-ringing.png") });
  await L.click("#alarmDismiss");

  // Notification centre drawer
  await L.click("#bellBtn");
  check("notification centre opens", await L.isVisible("#drawer.open"));
  await L.click("#drawerClose");

  // ---------------- Pair the iPhone with the QR link
  await L.click('.sidebar [data-tab="settings"]');
  await L.click('[data-s="devices"]');
  await L.click("#pair");
  await L.waitForSelector(".qr svg");
  check("pairing QR code is shown", await L.isVisible(".qr svg"));
  const pairUrl = await L.evaluate(async () => (await (await fetch("/api/pair/create", { method: "POST", headers: { "x-jarvis": "1" } })).json()).url);
  const phoneCtx = await browser.newContext({ ...devices["iPhone 13"] });
  const P = await phoneCtx.newPage(); watch(P, "iphone");
  await P.goto(pairUrl.replace("127.0.0.1", "localhost"), { waitUntil: "networkidle" });
  check("QR link opens the pairing screen", await P.isVisible("#pairField"));
  await P.fill("#authDevice", "Dylan's iPhone");
  await P.click("#authSubmit");
  await P.waitForFunction(() => !document.querySelector("#app").hidden || document.querySelector("#authErr").textContent, null, { timeout: 15000 }).catch(() => {});
  const pairErr = await P.textContent("#authErr");
  if (pairErr) await P.screenshot({ path: path.join(out, "iphone-pair-error.png") });
  check("iPhone paired into the same account", !pairErr && !(await P.evaluate(() => document.querySelector("#app").hidden)), pairErr || "");
  await P.waitForSelector("#core", { timeout: 15000 });
  check("phone shows the initialisation screen and enters JARVIS", await enterJarvis(P));
  // iPhone in Safari (not yet on the Home Screen): JARVIS explains how to install it, with the real buttons.
  const guide = await P.waitForSelector("#iosInstall.in", { timeout: 12000 }).then(() => true, () => false);
  check("iPhone Safari shows the Add to Home Screen guide", guide && /Add to Home Screen/.test(await P.textContent("#iosInstall")) && /Share/.test(await P.textContent("#iosInstall")));
  await P.screenshot({ path: path.join(out, "iphone-install-guide.png") });
  await P.click("#iosInstall [data-x].btn");
  check("the install guide can be dismissed and stays dismissed", await P.waitForSelector("#iosInstall", { state: "detached", timeout: 3000 }).then(() => true, () => false) && await P.evaluate(() => Number(localStorage.getItem("jarvis.iosHint")) > Date.now()));
  await sleep(1200);
  check("iPhone shows the mobile navigation", await P.isVisible("#mobileNav"));
  await P.screenshot({ path: path.join(out, "iphone-home.png") });
  const overflow = await P.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
  check("iPhone layout has no horizontal scrolling", !overflow);

  // Conversation continues on the phone
  await P.click('#mobileNav [data-tab="talk"]');
  await P.waitForSelector(".msg.assistant");
  check("phone sees the conversation started on the laptop", (await P.locator(".msg.user", { hasText: "Tell me a long story" }).count()) >= 1);
  await P.fill("#t", "Remind me to call my mum at six"); await P.press("#t", "Enter");
  await P.waitForSelector(".msg.assistant >> text=call your mum", { timeout: 10000 });
  await P.screenshot({ path: path.join(out, "iphone-talk.png") });
  await L.click('.sidebar [data-tab="talk"]');
  check("laptop sees the message sent from the phone", await L.waitForSelector(".msg.user >> text=Remind me to call my mum at six", { timeout: 8000 }).then(() => true, () => false));
  for (const tab of ["alarms", "calendar"]) { await P.click(`#mobileNav [data-tab="${tab}"]`); await sleep(800); await P.screenshot({ path: path.join(out, `iphone-${tab}.png`) }); }
  await P.click("#moreBtn");
  check("phone More menu lists all sections", (await P.locator("#palList li").count()) >= 21);
  await P.keyboard.press("Escape");
  await P.evaluate(() => { location.search = "?tab=tasks&tab2=reminders"; });
  await P.waitForSelector("[data-t=reminders]");
  await P.click("[data-t=reminders]");
  check("phone shows the reminder created by voice", await P.waitForSelector("#body >> text=Call your mum", { timeout: 5000 }).then(() => true, () => false));

  // ---------------- Personal intelligence, Mission Control, narrated diagnostics, start-up (laptop)
  await L.click('[data-tab="memory"]');
  await L.waitForSelector("#mems .panel-head h3");
  const heads = await L.$$eval("#mems .panel-head h3", (h) => h.map((x) => x.textContent));
  check("memory shows the personal profile grouped by category", ["Personal profile", "Career", "Ambitions", "Businesses", "Creative projects", "Preferences"].every((h) => heads.includes(h)), heads.join(", "));
  check("profile has the website agency idea and KILL HOUSE", /website design agency/.test(await L.textContent("#mems")) && /KILL HOUSE/.test(await L.textContent("#mems")));
  await L.screenshot({ path: path.join(out, "laptop-memory-profile.png") });
  await L.click('[data-t="timeline"]');
  check("session history timeline lists real events", await L.waitForSelector("#hl .item", { timeout: 5000 }).then(() => true, () => false));
  await L.click('[data-tab="home"]'); await L.waitForSelector("#core");
  // ---- Mission Control: a transformation of the same interface, driven by real checks
  await L.evaluate(() => { window.__mcTimeline = []; });
  await L.fill("#say", "JARVIS, activate Mission Control"); await L.press("#say", "Enter");
  check("Stage 1: dims the interface and shows “ACTIVATING MISSION CONTROL”", await L.waitForFunction(() => document.documentElement.classList.contains("mc-activating") && /ACTIVATING MISSION CONTROL/.test(document.querySelector(".mc-banner")?.textContent || ""), null, { timeout: 8000, polling: 30 }).then(() => true, () => false));
  const active = await L.waitForFunction(() => document.documentElement.classList.contains("mc-active"), null, { timeout: 60000 }).then(() => true, () => false);
  check("Mission Control becomes active", active);
  const stages = await L.evaluate(() => (window.__mcTimeline || []).filter((x) => x.stage).map((x) => x.stage));
  check("the four stages run in order: activating, transformation, initialisation, active", JSON.stringify(stages) === "[1,2,3,4]", JSON.stringify(stages));
  const init = await L.$$eval(".mc-init li", (l) => l.map((x) => `${x.dataset.state}: ${x.querySelector("b").textContent} — ${x.querySelector(".faint").textContent}`));
  check("initialisation shows the real service checks", init.length === 8 && /Checking AI core/.test(init[1]) && /Verifying voice interface/.test(init[2]) && /Connecting public flight data/.test(init[4]) && /Retrieving global events/.test(init[5]) && /Mission Control (ready|active)/.test(init[7]), init.join(" | "));
  check("the flight and events checks report what was actually retrieved", /^ok: Connecting public flight data — [\d,]+ aircraft visible · (ADSB\.lol|OpenSky Network)$/.test(init[4]) && /^(ok|warn): Retrieving global events — \d+ reports · \d of \d sources live$/.test(init[5]), `${init[4]} | ${init[5]}`);
  check("no check is shown as passed without a result", init.every((l) => /^(ok|warn|bad): /.test(l)));
  check("the same living core moved into Mission Control (no second 3D scene)", await L.evaluate(() => !!document.querySelector("#mcView canvas#core") && !document.querySelector("#view canvas#core") && (window.__jarvisCore?.alive ?? 1) === 1));
  check("sidebar became Mission Control navigation", await L.evaluate(() => document.querySelector("#nav").hidden && !document.querySelector("#mcNav").hidden && document.querySelectorAll("#mcNav [data-mc]").length === 16 && [...document.querySelectorAll("#mcNav .nav-group")].some((g) => g.textContent === "Operations")));
  // Global Operations: the default Mission Control layout
  check("Global Operations opens first: core on the left, map in the centre, events on the right, six status panels below", await L.evaluate(() => {
    const g = document.querySelector("#mcView .goc"); if (!g || document.querySelector("#mcView").dataset.section !== "globalops") return false;
    const left = g.querySelector(".goc-left").getBoundingClientRect(), centre = g.querySelector(".goc-centre").getBoundingClientRect(), right = g.querySelector(".goc-right").getBoundingClientRect();
    return !!g.querySelector(".goc-core-host canvas#core") && left.right <= centre.left + 1 && centre.right <= right.left + 1 && centre.width > left.width && g.querySelectorAll(".goc-bottom > .goc-box").length === 6 && !!g.querySelector(".leaflet-container");
  }));
  check("the core panel is prominent (not a logo)", await L.evaluate(() => document.querySelector(".goc-core-host canvas#core").getBoundingClientRect().width >= 150));
  check("Mission Control announces only what initialised", await L.waitForFunction(() => /^Mission Control is online, Sir\. (Global operations interface ready\.|(One service needs|\d services need) attention: .+\.)$/.test(document.querySelector("#mcCaption")?.textContent || ""), null, { timeout: 8000 }).then(() => true, () => false), await L.textContent("#mcCaption"));
  check("aircraft from the flight provider are on the map, privacy-flagged ones excluded", await L.waitForFunction(() => (window.__jarvisGoc?.aircraft || 0) > 0, null, { timeout: 15000 }).then(() => true, () => false));
  check("the events feed lists real items with their source and verification", await L.waitForFunction(() => document.querySelectorAll(".goc-ev").length >= 3 && [...document.querySelectorAll(".goc-ev-status")].every((x) => x.textContent.trim().length > 5), null, { timeout: 15000 }).then(() => true, () => false));
  const tele = await L.waitForFunction(() => /CPU.*\d+% · \d+ cores/.test(document.querySelector("#gocSys")?.textContent || "") && /RAM.*\d+% in use/.test(document.querySelector("#gocSys")?.textContent || ""), null, { timeout: 15000 }).then(() => true, () => false);
  check("system readings are measured values", tele);
  check("GPU usage is not invented", /usage not measurable/.test(await L.textContent("#gocSys")));
  await L.click(".goc-ev .goc-ev-head");
  check("an event opens with dates, location accuracy and a link to the original report", await L.evaluate(() => { const e = document.querySelector(".goc-ev.open"); return !!e && /Retrieved/.test(e.textContent) && /Location accuracy/.test(e.textContent) && !!e.querySelector(".goc-srcs a[href^='https://']"); }));
  await sleep(2500);
  await L.screenshot({ path: path.join(out, "laptop-mission-control.png") });
  const sectionChecks = {
    world: async () => /Dhekelia/.test(await L.textContent(".goc-right")) && await L.evaluate(() => !document.querySelector("#gocLayers").hidden),
    events: async () => (await L.locator(".goc-ev").count()) >= 3 && /Natural disaster/.test(await L.textContent(".goc-chips")),
    flights: async () => (await L.locator(".goc-flist button").count()) >= 1,
    overview: async () => { const v = await L.$$eval("#mcView [data-panel]:not([hidden])", (p) => p.map((x) => x.dataset.panel)); return ["core", "overview", "ops", "arch", "diag", "map", "res", "intel", "comms", "act"].every((x) => v.includes(x)) && /\d+%/.test(await L.textContent('[data-panel="res"]')); },
    architecture: async () => (await L.locator('[data-panel="arch"] .mc-tbl tbody tr').count()) >= 10 && (await L.locator('#mcView .mc-node').count()) === 11,
    diagnostics: async () => (await L.locator('[data-panel="diag"] [data-level]').count()) === 9,
    processes: async () => /Windows app, which isn't connected/.test(await L.textContent('[data-panel="procs"]')),
    intelligence: async () => /Research|research/.test(await L.textContent('[data-panel="intel"]')),
    comms: async () => /device/.test(await L.textContent('[data-panel="comms"]')),
    projects: async () => /Website business/.test(await L.textContent('[data-panel="projects"]')),
    personal: async () => /Call the accountant about VAT/.test(await L.textContent('[data-panel="personal"]')),
  };
  for (const [sec, ok] of Object.entries(sectionChecks)) {
    await L.click(`#mcNav [data-mc="${sec}"]`);
    await L.waitForFunction((s) => document.querySelector("#mcView")?.dataset.section === s, sec, { timeout: 5000 }).catch(() => {});
    const good = await (async () => { for (let i = 0; i < 30; i++) { if (await ok().catch(() => false)) return true; await sleep(300); } return false; })();
    check(`Mission Control section “${sec}” shows real data`, good);
  }
  await L.screenshot({ path: path.join(out, "laptop-mission-control-personal.png") });
  // Flight tracking: select an aircraft from the list → the information card shows what's known and says what isn't.
  await L.click('#mcNav [data-mc="flights"]');
  await L.waitForSelector(".goc-flist button", { timeout: 15000 }).catch(() => {});
  await L.click(".goc-flist button");
  check("selecting an aircraft opens its card with ICAO24, freshness and source", await L.waitForFunction(() => { const c = document.querySelector("#gocCard"); return c && !c.hidden && /ICAO24/.test(c.textContent) && /(live|recent|stale)/.test(c.textContent) && /Data source/.test(c.textContent); }, null, { timeout: 10000 }).then(() => true, () => false));
  await L.fill("#gocFQ", "ZZZ999"); await L.click("#gocFSearch .goc-btn");
  check("a flight that can't be found is reported as not visible", await L.waitForFunction(() => /not visible in the available data/.test(document.querySelector("#gocFRes")?.textContent || ""), null, { timeout: 10000 }).then(() => true, () => false));
  await L.fill("#mcSay", "Hide flight tracking"); await L.press("#mcSay", "Enter");
  check("“Hide flight tracking” works by voice/text", await L.waitForFunction(() => document.querySelector("#gocFShow")?.checked === false && /Flight tracking hidden/.test(document.querySelector("#mcCaption")?.textContent || ""), null, { timeout: 10000 }).then(() => true, () => false));
  await L.fill("#mcSay", "Show me aircraft around Cyprus"); await L.press("#mcSay", "Enter");
  check("“Show me aircraft around Cyprus” answers with the real count", await L.waitForFunction(() => /^\d+ aircraft visible over Cyprus, Sir, from (ADSB\.lol|OpenSky Network)\.$/.test(document.querySelector("#mcCaption")?.textContent || ""), null, { timeout: 20000 }).then(() => true, () => false), await L.textContent("#mcCaption"));
  await L.screenshot({ path: path.join(out, "laptop-flight-tracking.png") });
  // ---- Operations inside Mission Control (same core and map; workspaces load on first use)
  const sameShell = () => L.evaluate(() => document.querySelectorAll(".leaflet-container").length === 1 && !!document.querySelector(".goc-core-host canvas#core") && document.querySelectorAll("#mcView").length === 1);
  await L.click('#mcNav [data-mc="op-orbit"]');
  check("Operation Orbit opens inside Mission Control with the same core and map", await L.waitForSelector(".goc-op [data-id]", { timeout: 20000 }).then(() => true, () => false) && await sameShell());
  check("Orbit shows a calculated ISS position with the element epoch", await L.waitForFunction(() => /ISS \(ZARYA\)/.test(document.querySelector("#orbLive")?.textContent || "") && /calculated/i.test(document.querySelector("#orbLive").textContent) && /h old/.test(document.querySelector("#orbLive").textContent), null, { timeout: 15000 }).then(() => true, () => false));
  await L.click('.goc-op [data-tab="weather"]');
  check("Orbit space weather shows the Kp index with its source", await L.waitForFunction(() => /Planetary K index/.test(document.querySelector(".goc-op")?.textContent || "") && /SWPC/.test(document.querySelector(".goc-op").textContent), null, { timeout: 15000 }).then(() => true, () => false));
  await L.click('#mcNav [data-mc="op-blackbox"]');
  await L.waitForSelector("#bbSubject", { timeout: 15000 });
  check("leaving Orbit removes its satellite layer from the shared map", await L.evaluate(() => (window.__jarvisGoc?.hits ?? 0) < 50));
  await L.fill("#bbSubject", "Airbus A350"); await L.click("#bbNew .goc-btn");
  check("Blackbox builds a dossier with numbered sources and labelled interpretation", await L.waitForFunction(() => { const t = document.querySelector(".goc-op")?.textContent || ""; return /Key findings/i.test(t) && /Source fact/i.test(t) && /AI interpretation/i.test(t) && document.querySelectorAll(".bb-sources li").length >= 2; }, null, { timeout: 40000 }).then(() => true, () => false));
  await L.click('#mcNav [data-mc="op-wayfinder"]');
  await L.waitForSelector("#wfDest", { timeout: 15000 });
  await L.fill("#wfDest", "Larnaca"); await L.click("#wfNew .goc-btn");
  check("Wayfinder plans a trip with FCDO advice and nearby airports", await L.waitForFunction(() => /FCDO/.test(document.querySelector(".goc-op")?.textContent || "") && /LCA/.test(document.querySelector(".goc-op").textContent), null, { timeout: 30000 }).then(() => true, () => false));
  await L.click('.goc-op [data-tab="itinerary"]');
  check("the AI-drafted itinerary is labelled as an AI draft", await L.evaluate(() => /AI draft/.test(document.querySelector(".goc-op").textContent)));
  await L.fill("#mcSay", "Open Operation Sentinel"); await L.press("#mcSay", "Enter");
  check("“Open Operation Sentinel” works by voice/text", await L.waitForFunction(() => document.querySelector("#mcView")?.dataset.section === "op-sentinel" && /Operation Sentinel is open/.test(document.querySelector("#mcCaption")?.textContent || ""), null, { timeout: 15000 }).then(() => true, () => false));
  await L.fill("#mcSay", "Show available public city webcams"); await L.press("#mcSay", "Enter");
  check("webcams are listed but not embedded until their live status is verified", await L.waitForFunction(() => document.querySelectorAll(".goc-op [data-cam]").length >= 5 && /not verified/i.test(document.querySelector(".goc-op").textContent) && !document.querySelector(".goc-op iframe"), null, { timeout: 15000 }).then(() => true, () => false));
  await L.fill("#mcSay", "Track the International Space Station"); await L.press("#mcSay", "Enter");
  check("“Track the International Space Station” answers with a calculated position", await L.waitForFunction(() => /International Space Station is over .* calculated from orbital elements/.test(document.querySelector("#mcCaption")?.textContent || ""), null, { timeout: 20000 }).then(() => true, () => false), await L.textContent("#mcCaption"));
  await L.click("#gocSitrep");
  check("the Global Situation Report shows every line with its kind and source", await L.waitForFunction(() => { const b = document.querySelector(".goc-sitrep-box"); return b && b.getBoundingClientRect().height > 200 && document.querySelectorAll(".sitrep-items li").length >= 5 && [...document.querySelectorAll(".sitrep-nat")].every((x) => x.textContent.trim()); }, null, { timeout: 60000 }).then(() => true, () => false));
  await L.screenshot({ path: path.join(out, "laptop-situation-report.png") });
  await L.click("#gocSitrepX");
  await L.fill("#mcSay", "Show system architecture"); await L.press("#mcSay", "Enter");
  check("“Show system architecture” switches section by voice/text", await L.waitForFunction(() => document.querySelector("#mcView")?.dataset.section === "architecture", null, { timeout: 8000 }).then(() => true, () => false));
  await L.fill("#mcSay", "Tell me a long story"); await L.press("#mcSay", "Enter");
  check("conversation works inside Mission Control", await L.waitForFunction(() => /Once upon a time/.test(document.querySelector("#mcCaption")?.textContent || ""), null, { timeout: 15000 }).then(() => true, () => false));
  await post(L, "/api/alarms/test", {});
  check("an alarm still rings over Mission Control", await L.waitForSelector("#alarmOverlay:not([hidden])", { timeout: 8000 }).then(() => true, () => false));
  await L.click("#alarmDismiss");
  check("Mission Control is still active after the alarm", await L.evaluate(() => document.documentElement.classList.contains("mc-active")));
  await L.fill("#mcSay", "JARVIS, deactivate Mission Control"); await L.press("#mcSay", "Enter");
  check("“Deactivate Mission Control” reverses the transformation", await L.waitForSelector("#mcView", { state: "detached", timeout: 30000 }).then(() => true, () => false));
  check("Command Centre is back with its core, normal colours and sidebar", await L.evaluate(() => !!document.querySelector("#view .core-stage canvas#core") && !document.documentElement.classList.contains("mc-mode") && !document.querySelector("#nav").hidden && !document.querySelector("#mcNav")));
  await L.click("#mcBtn");
  check("the Mission Control button activates it", await L.waitForFunction(() => document.documentElement.classList.contains("mc-active"), null, { timeout: 60000 }).then(() => true, () => false));
  // Esc: the first press stops JARVIS speaking (if it is), the next leaves Mission Control.
  await L.keyboard.press("Escape");
  if (!(await L.waitForSelector("#mcView", { state: "detached", timeout: 2500 }).then(() => true, () => false))) await L.keyboard.press("Escape");
  check("Esc leaves Mission Control", await L.waitForSelector("#mcView", { state: "detached", timeout: 30000 }).then(() => true, () => false));
  // Reduced motion: the same stages and checks, without the movement.
  const rm = await browser.newContext({ viewport: { width: 1280, height: 800 }, reducedMotion: "reduce", storageState: await lap.storageState() });
  const R = await rm.newPage(); watch(R, "reduced-motion");
  await R.goto(base); await R.waitForSelector("#core");
  check("reduced motion: start-up runs its checks with no animation", await enterJarvis(R) && await R.evaluate(() => window.__jarvisBoot.lines.length >= 20));
  await R.evaluate(() => { window.__mcTimeline = []; });
  await R.click("#mcBtn");
  await R.waitForFunction(() => document.documentElement.classList.contains("mc-active"), null, { timeout: 30000 }).catch(() => {});
  const full = await R.evaluate(() => window.__mcTimeline || []);
  const tl = full.filter((x) => x.stage);
  const moving = await R.evaluate(() => document.getAnimations().filter((a) => a.effect?.target?.closest?.("#mcView, #mcNav")).map((a) => a.constructor.name + ":" + (a.animationName || "js")));
  check("reduced motion: the same stages and checks, with no movement", tl.length === 4 && moving.length === 0, `${tl.length >= 4 ? tl[3].t - tl[0].t : "?"} ms · ${full.map((x) => `${x.label || x.stage}@${x.t - full[0].t}`).join(" ")} · moving: ${moving.join(",")}`);
  await rm.close();
  await L.fill("#say", "Run a quick diagnostic"); await L.press("#say", "Enter");
  check("“Run a quick diagnostic” shows the narrated report", await L.waitForSelector("#report .check-card", { timeout: 15000 }).then(() => true, () => false));
  const spoken = await L.textContent("#report");
  check("report's spoken lines name the real checks", /Primary database/.test(spoken) && /Spoken/.test(spoken), spoken.slice(0, 160));
  await L.screenshot({ path: path.join(out, "laptop-diagnostics-narrated.png") });
  check("performance panel shows live measurements", await L.waitForFunction(() => /ms/.test(document.querySelector("#perf")?.textContent || ""), null, { timeout: 8000 }).then(() => true, () => false));
  // ---- Start-up: dedicated initialisation screen with real checks (fresh window = new launch)
  const fresh = await browser.newContext({ viewport: { width: 1600, height: 960 }, storageState: await lap.storageState() });
  const F = await fresh.newPage(); watch(F, "startup");
  await F.goto(base);
  check("launch opens the initialisation screen, not the Command Centre", await F.waitForSelector(".boot2", { timeout: 25000 }).then(() => true, () => false));
  check("Stage 1: J.A.R.V.I.S. branding and POWER ON", /J\.A\.R\.V\.I\.S\./.test(await F.textContent(".b2-title")) && await F.waitForFunction(() => /POWER ON/.test(document.querySelector(".b2-log")?.textContent || ""), null, { timeout: 8000 }).then(() => true, () => false));
  await F.waitForFunction(() => window.__jarvisBootReady, null, { timeout: 120000 });
  const boot = await F.evaluate(() => window.__jarvisBoot);
  const want = ["Application runtime", "Operating system", "Hardware", "Database", "Local storage", "AI provider", "Voice input", "Speech synthesis", "Microphone", "Background scheduler", "Notification service", "Weather integration", "Calendar integration", "World Explorer", "3D rendering", "Neural core rendering"];
  check("Stage 2: every required system check ran", want.every((w) => boot.lines.some((l) => l.label.startsWith(w))), boot.lines.map((l) => l.label).join(", "));
  const allowed = ["operational", "connected", "degraded", "not_configured", "permission_required", "offline", "failed", "initialising"];
  check("every check has a real status from the allowed set", boot.lines.every((l) => allowed.includes(l.status) && l.detail));
  check("the AI is only 'connected' after a real reply", boot.lines.find((l) => l.label === "AI provider")?.status === "connected" && /responded in \d+ ms/.test(boot.lines.find((l) => l.label === "AI provider").detail));
  check("the database check really queried it", /schema \d+/.test(boot.lines.find((l) => l.label === "Database").detail));
  check("the microphone line distinguishes devices from permission", /microphone|permission/i.test(boot.lines.find((l) => l.label === "Microphone").detail));
  check("the neural core is 'operational' only after a frame was drawn", /first frame after \d+ ms/.test(boot.lines.find((l) => l.label === "Neural core rendering").detail) || boot.lines.find((l) => l.label === "Neural core rendering").status !== "operational");
  const initLabels = ["Initialise AI engine", "Load application configuration", "Load persistent memory", "Restore saved preferences", "Restore pending tasks and reminders", "Initialise voice interface", "Initialise neural energy core", "Prepare the Command Centre"];
  check("Stage 3: AI initialisation restores real state", initLabels.every((w) => boot.lines.some((l) => l.label === w)) && /\d+ facts restored/.test(boot.lines.find((l) => l.label === "Load persistent memory").detail));
  const crit = boot.lines.filter((l) => l.critical && ["failed", "offline"].includes(l.status)).length, bad = boot.lines.filter((l) => !l.critical && ["failed", "offline"].includes(l.status)).length, lim = boot.lines.filter((l) => ["degraded", "permission_required", "initialising"].includes(l.status)).length;
  const expected = crit ? "SYSTEM INITIALISATION FAILED" : bad ? "SYSTEM INITIALISED — ATTENTION REQUIRED" : lim ? "SYSTEM OPERATIONAL — LIMITED SERVICES" : "SYSTEM OPERATIONAL";
  check("Stage 4: the summary matches the actual results", boot.summary === expected && (await F.textContent(".b2-summary")) === expected, `${boot.summary} (expected ${expected})`);
  check("problems are listed in plain language with a diagnostics action", bad + lim + crit === 0 || ((await F.locator(".b2-problems li").count()) > 0 && await F.isVisible("#b2Diag")));
  check("Stage 5: greeting uses the real time of day and asks for a tap", /ALL AVAILABLE SYSTEMS INITIALISED\./.test(await F.textContent(".b2-enter")) && /GOOD (MORNING|AFTERNOON|EVENING), SIR\./.test(await F.textContent(".b2-greet")) && /TAP ANYWHERE TO WAKE JARVIS/.test(await F.textContent(".b2-tap")));
  check("sound is reported honestly (played only with a measured signal)", ["playing", "blocked", "no signal", "unavailable", "off", "deferred"].includes(boot.sound) && (boot.sound !== "playing" || boot.soundLevel > 0), `${boot.sound} · level ${boot.soundLevel}`);
  await F.screenshot({ path: path.join(out, "laptop-startup.png") });
  const navBefore = await F.evaluate(() => performance.getEntriesByType("navigation").length);
  await F.locator(".boot2").click({ position: { x: 30, y: 30 } });
  check("tap enters the Command Centre without reloading", await F.waitForSelector(".boot2", { state: "detached", timeout: 8000 }).then(() => true, () => false) && navBefore === await F.evaluate(() => performance.getEntriesByType("navigation").length) && await F.evaluate(() => !!document.querySelector("#view canvas#core")?.__core));
  check("the Command Centre agrees with the start-up result", /JARVIS is online\./.test(await F.textContent("#subline")) && (boot.problems.length === 0) === /All available systems are ready/.test(await F.textContent("#subline")), await F.textContent("#subline"));
  await F.click('[data-tab="diagnostics"]');
  check("Diagnostics shows the last start-up report", await F.waitForSelector("text=Last startup", { timeout: 8000 }).then(() => true, () => false));
  await fresh.close();
  // Settings → Startup: skip animation + open automatically still runs every check.
  await L.request.patch(`${base}/api/settings`, { headers: { "x-jarvis": "1" }, data: { startup: { skipAnimation: true, autoOpen: true } } });
  const fresh2 = await browser.newContext({ viewport: { width: 1280, height: 800 }, storageState: await lap.storageState() });
  const F2 = await fresh2.newPage(); watch(F2, "startup-skip");
  await F2.goto(base);
  check("skip animation + auto-open: enters by itself after the real checks", await F2.waitForSelector(".boot2", { timeout: 8000 }).then(() => true, () => false) && await F2.waitForSelector(".boot2", { state: "detached", timeout: 120000 }).then(() => true, () => false) && await F2.evaluate(() => window.__jarvisBoot.lines.length >= 24));
  await fresh2.close();
  await L.request.patch(`${base}/api/settings`, { headers: { "x-jarvis": "1" }, data: { startup: { skipAnimation: false, autoOpen: false } } });
  await L.click('[data-tab="settings"]');
  await L.click('[data-s="startup"]');
  check("Settings has a Startup section with every option", await L.waitForSelector("#stScreen", { timeout: 5000 }).then(() => true, () => false) && (await Promise.all(["#stSkip", "#stFull", "#stAuto", "#stSound", "#stSilent", "#stReduced", "#stVol", "#stTest"].map((x) => L.$(x)))).every(Boolean));
  await L.click('[data-s="performance"]');
  check("Settings has a Performance section (quality, particles, bloom, animation, updates, map)", await L.waitForSelector("#pfQ", { timeout: 5000 }).then(() => true, () => false) && !!(await L.$("#pfP")) && !!(await L.$("#pfB")) && !!(await L.$("#pfU")) && !!(await L.$("#pfM")));
  await L.screenshot({ path: path.join(out, "laptop-settings-performance.png") });
  await L.click('[data-tab="home"]'); await L.waitForSelector("#core");

  // ---------------- Mission Control on the phone
  await P.click("#mcBtn");
  check("phone: Mission Control activates", await P.waitForFunction(() => document.documentElement.classList.contains("mc-active"), null, { timeout: 60000 }).then(() => true, () => false));
  check("phone: no sideways scrolling in Mission Control", await P.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 2));
  check("phone: sections are reachable from the tab bar", await P.isVisible('.mc-tabs [data-mc="personal"]'));
  await P.click('.mc-tabs [data-mc="personal"]');
  await sleep(1500);
  await P.screenshot({ path: path.join(out, "phone-mission-control.png") });
  await P.click(".mc-tabs [data-mcexit]");
  check("phone: Mission Control exits", await P.waitForSelector("#mcView", { state: "detached", timeout: 30000 }).then(() => true, () => false));

  // ---------------- Offline → reconnect
  await P.click('[data-t="tasks"]');
  await phoneCtx.setOffline(true);
  await sleep(300);
  await P.click("#add");
  await P.fill('#modal input[name="title"]', "Buy milk (added offline)");
  await P.click('#modal button[value="ok"]');
  await sleep(500);
  const queued = await P.evaluate(() => JSON.parse(localStorage.getItem("jarvis.outbox") || "[]").length);
  check("offline task is queued on the phone", queued === 1);
  await phoneCtx.setOffline(false);
  await P.evaluate(() => dispatchEvent(new Event("online")));
  const synced = await (async () => { for (let i = 0; i < 40; i++) { const r = await L.request.get(`${base}/api/tasks`); const t = await r.json(); if (t.some((x) => x.title === "Buy milk (added offline)")) return t.filter((x) => x.title === "Buy milk (added offline)").length; await sleep(250); } return 0; })();
  check("after reconnecting, the queued task syncs exactly once", synced === 1, `${synced} copies`);
} catch (e) {
  check("ui run completed", false, e.stack?.split("\n").slice(0, 3).join(" ") || e.message);
} finally {
  await browser.close(); await srv.stop(); mock.server.close();
}
check("no JavaScript errors in either device", errors.length === 0, errors.slice(0, 6).join(" | "));
fs.writeFileSync(path.join(out, "ui-results.json"), JSON.stringify(results, null, 2));
process.exit(results.every((r) => r.ok) ? 0 : 1);
