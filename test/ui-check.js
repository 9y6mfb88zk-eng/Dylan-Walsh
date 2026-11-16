// Drives the real UI in Chromium against the mocked upstreams and saves screenshots.
// Usage: node test/ui-check.js [outDir]
import { spawn, execSync } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startMock } from "./mock-upstream.js";

let chromium;
try { ({ chromium } = await import("playwright")); }
catch { ({ chromium } = createRequire(execSync("npm root -g").toString().trim() + "/")("playwright")); }

const out = path.resolve(process.argv[2] || "docs/screenshots");
fs.mkdirSync(out, { recursive: true });
const mock = await startMock();
const PORT = 3998;
const proc = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", "server/index.js"], {
  env: { PATH: process.env.PATH, PORT: String(PORT), JARVIS_DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-ui-")),
    ANTHROPIC_API_KEY: "k", ANTHROPIC_BASE_URL: mock.url, ELEVENLABS_API_KEY: "k", ELEVENLABS_BASE_URL: mock.url,
    OPENAI_API_KEY: "k", OPENAI_BASE_URL: mock.url, OPEN_METEO_URL: `${mock.url}/v1/forecast`, IDEAS_ENABLED: "false" },
  stdio: "inherit",
});
const base = `http://127.0.0.1:${PORT}`;
for (let i = 0; i < 50; i++) { try { if ((await fetch(base + "/api/health")).ok) break; } catch {} await new Promise((r) => setTimeout(r, 100)); }
// Seed some content
await fetch(base + "/api/ideas/generate", { method: "POST" });
await fetch(base + "/api/tasks", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: "Call the accountant about VAT" }) });
await fetch(base + "/api/reminders", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "Pick up dry cleaning", due_at: new Date(Date.now() + 3 * 3600e3).toISOString() }) });

const browser = await chromium.launch({ args: ["--autoplay-policy=no-user-gesture-required"] });
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true,
  geolocation: { latitude: 34.9786, longitude: 33.7253 }, permissions: ["geolocation"] });
const page = await ctx.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
await page.goto(base, { waitUntil: "networkidle" });
await page.waitForSelector("#wTemp:not(:has-text('--'))");
await page.screenshot({ path: path.join(out, "home.png") });

await page.fill("#textInput", "Hello JARVIS");
await page.press("#textInput", "Enter");
await page.waitForFunction(() => document.querySelector("#orb").dataset.state === "speaking", null, { timeout: 8000 });
await page.waitForTimeout(450);
const lvl = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--level"));
await page.screenshot({ path: path.join(out, "speaking.png") });
const caption = await page.textContent("#caption");
await page.waitForFunction(() => document.querySelector("#orb").dataset.state === "idle", null, { timeout: 10000 });

for (const tab of ["tasks", "reminders", "ideas", "settings"]) {
  await page.click(`.dock button[data-tab="${tab}"]`);
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(out, `${tab}.png`) });
}
const swOk = await page.evaluate(async () => !!(await navigator.serviceWorker.getRegistration()));
console.log(JSON.stringify({ caption, speakingLevel: Number(lvl), serviceWorker: swOk, ttsCalls: mock.log.tts.length, errors }, null, 2));
await browser.close(); proc.kill(); mock.server.close();
if (errors.length || !(Number(lvl) > 0.05) || !swOk) process.exit(1);
